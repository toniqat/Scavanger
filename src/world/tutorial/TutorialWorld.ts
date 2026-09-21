import * as THREE from 'three';
import {
  PLAYER_RADIUS, TUTORIAL_CHECKPOINTS,
  type GameContext, type SurfaceMaterial, type TutorialCheckpointId, type TutorialEnemySpawn,
  type TutorialFallRule, type TutorialWorldRef,
} from '@/shared';
import type { SpatialHash } from '../SpatialHash';
import { Ground } from './parts/Ground';
import { Dressing } from './parts/Dressing';
import { TutorialCorpses } from './parts/Corpses';
import {
  ABYSS_EDGE_Z, ABYSS_SAFE_MARGIN_M, CHASM_RUNUP_M, CHECKPOINTS, CRAWL, CORRIDOR_OUTER_X, DECK_LOWER_Y, DECK_UPPER_Y, ENEMIES,
  ENEMY_LEASH, ENEMY_SENSE, FALL_RULES, PIT_FLOOR_Y, RUINS, SHIP_HILL_Y, SHIP_POS, SHIP_YAW, TUTORIAL_MAP_SIZE, VOID_Y, Z_END,
  Z_START, chasmFarZAt, chasmNearZAt, inAbyssCut, lowerTilingErrors, type TutorialSpawnSpec, type Volume,
} from './model';

/* ────────────────────────────────────────────────────────────────────────────
 * The hand-built tutorial planet (2026-09-14).
 *
 * On `game:newMission {mode:'tutorial'}` `WorldSystem` builds this instead of the procedural generator —
 * **exactly the same wiring** as `TrainingArena`, and there is no fog · hazard · crate · gather · nest · rail · tram ·
 * rover at all (`ctx.world.fog === null` as in the training range too).
 *
 * This class holds three things:
 *   1. **The world** — chasm floor · decks · cliff walls · the abyss in front of the ship (`parts/Ground`), the ruins · the collapsed
 *      corridor · the diagonal barrier with its blind wire fence (`parts/Dressing`),
 *      three corpses (`parts/Corpses`). All procedural geometry, and it **creates no lights at all**.
 *   2. **`TutorialWorldRef`** — checkpoints · fall rules · enemy spots (`ctx.world.tutorial`).
 *   3. **The abandoned ship** — no new mesh: `ctx.extraction.beginPreLanded` stands the real extraction ship there already
 *      landed. The switch → 10 s grace → liftoff → settlement after it all follow the usual path.
 *
 * ⚠ The ship is placed **on the first `update()`**. `generate()` runs **inside** the `game:newMission` emit, while
 * `ExtractionSystem` has `resetMission()` on the same event and the system registration order is world(90) →
 * extraction(106), so placing it during generation is reset right away inside that same emit. One frame later that order is done.
 * ──────────────────────────────────────────────────────────────────────────── */

const OBJECTIVE_TEXT = '버려진 함선을 찾아 이 행성을 벗어난다';
/** How long placing the ship is retried (s). If `ctx.extraction` is not ready within it, it gives up and leaves only a warning. */
const SHIP_PLACE_TIMEOUT_S = 5;
/**
 * The feet-height tolerance for counting as 「standing on a walkable surface」. Kept narrow — widened, a spot **on top of** a ruin wall
 * or a wreckage pile would be recorded as a safe spot too.
 */
const SAFE_DECK_EPS = 0.4;
/**
 * The walkable surface heights — four of them (the 2026-09-15 2nd pass added the android pit floor, 2026-09-16 the ship hill `SHIP_HILL_Y`).
 * A ramp (`PIT_RAMP_*` · `SHIP_SLOPE`) is not listed on its own: it bridges 0.9 m and is always somewhere a player passes through, and most of
 * it lies within `SAFE_DECK_EPS` of the level above or below, so only 10 cm in the middle falls out — the flat ground before and after it is recorded.
 */
const SAFE_LEVELS: readonly number[] = [DECK_UPPER_Y, DECK_LOWER_Y, PIT_FLOOR_Y, SHIP_HILL_Y];
/**
 * The clearance **after** clearing chasm 1 (past the far edge in −Z) before a spot is recorded as safe. Kept narrow —
 * if whoever cleared it had to walk much further for the record to revive, a death in between would send them back in front of the cliff for no reason.
 */
const SAFE_CHASM_MARGIN = 1.5;

function volumeContains(v: Volume, p: THREE.Vector3): boolean {
  return p.x >= v.x0 && p.x <= v.x1 && p.z <= v.z0 && p.z >= v.z1 && p.y >= v.y0 && p.y <= v.y1;
}

export class TutorialWorld implements TutorialWorldRef {
  readonly group = new THREE.Group();
  /** The waking-up spot (the `wake` checkpoint) — `WorldRef.getPlayerSpawn`. */
  readonly spawn = CHECKPOINTS[0].at.clone();
  /** The side length the map and pings use. */
  readonly size = TUTORIAL_MAP_SIZE;

  private ctx: GameContext | null = null;
  private hash: SpatialHash | null = null;
  private built = false;
  private readonly ground = new Ground();
  private readonly dressing = new Dressing();
  private readonly corpses = new TutorialCorpses();
  private index = 0;
  private readonly spawns: TutorialEnemySpawn[] = [];
  /**
   * **The last spot the player stood on the ground** (2026-09-14 4th pass, user's decision — for the whole tutorial). A death by falling
   * returns here, not to a checkpoint: sending someone back to the start of the stretch for failing one cliff makes them walk past the
   * bugs and androids again. The checkpoint stays as **the insurance for when there is no such record** (raid start · right after a
   * resume · chasm 1's run-up area — `pollSafeGround`'s ② keeps that whole area clear, so `cliff` catches it).
   */
  private readonly lastSafe = new THREE.Vector3();
  private hasLastSafe = false;
  /** Whether the abandoned ship has been placed (once, on the first `update()`). */
  private shipPlaced = false;
  private shipTry = 0;

  constructor() { this.group.name = 'TutorialWorld'; }

  /* ── Build ──────────────────────────────────────────────────────────── */

  build(ctx: GameContext, root: THREE.Group, hash: SpatialHash): void {
    this.ctx = ctx;
    this.hash = hash;
    this.index = 0;
    this.hasLastSafe = false;
    this.shipPlaced = false;
    this.shipTry = 0;
    root.add(this.group);
    this.ground.build(this.group, hash);
    this.dressing.build(this.group, hash);
    this.corpses.build(ctx, this.group);

    this.spawns.length = 0;
    for (const e of ENEMIES) {
      // 2026-09-15 3rd pass: a spot can override the sense radius (`sense`) and the weapon class (`weapon`) — the last two androids (`model.ts`'s `ENEMIES` comment).
      // `weapon` is a field outside the shared contract, so it goes in through the extension type `TutorialSpawnSpec` (`enemies/Tutorial` reads it as an optional field).
      const spawn: TutorialSpawnSpec = {
        type: e.type,
        position: new THREE.Vector3(e.x, e.y, e.z),
        yaw: e.yaw,
        sense: e.sense ?? ENEMY_SENSE,
        leash: ENEMY_LEASH,
      };
      if (e.weapon) spawn.weapon = e.weapon;
      this.spawns.push(spawn);
    }

    // If the contract's order (`shared/tutorialWorld`) and the map's order differ, respawn spots get tangled — checked once at build.
    for (let i = 0; i < TUTORIAL_CHECKPOINTS.length; i++) {
      if (CHECKPOINTS[i]?.id !== TUTORIAL_CHECKPOINTS[i]) {
        console.warn(`[TutorialWorld] 체크포인트 순서가 계약과 다르다: ${i} — ${CHECKPOINTS[i]?.id} ≠ ${TUTORIAL_CHECKPOINTS[i]}`);
      }
    }
    // 2026-09-16: do the lower deck pieces · hill ramp · pit · walls · abyss cuts cover the old lower deck rect **exactly once** (`model.ts`'s `DECKS` comment).
    // A gap makes the ground under the feet vanish (a hole with no kill volume either); an overlap stands a kill volume where there is floor — the fence steps are built in code, so it is checked at build.
    for (const err of lowerTilingErrors()) console.warn(`[TutorialWorld] 아래 데크 타일링: ${err}`);

    this.built = true;
    ctx.bus.emit('ui:objective', { text: OBJECTIVE_TEXT });
  }

  /* ── Frame ──────────────────────────────────────────────────────────── */

  update(dt: number): void {
    if (!this.built) return;
    this.placeShip(dt);
    this.pollCheckpoints();
    this.pollSafeGround();
    this.corpses.update();   // 2026-09-16: an emptied corpse sinks and is removed
  }

  /**
   * The abandoned ship = **an extraction ship that has already landed**. It stands there with no console and no call, and pressing the
   * switch inside runs the usual 10 s grace → liftoff → result and settlement unchanged. With `autoDepart: false` the 60 s no-response
   * automatic departure never arms — the tutorial needs time to look around.
   */
  private placeShip(dt: number): void {
    if (this.shipPlaced) return;
    const ctx = this.ctx;
    const ex = ctx?.extraction;
    this.shipTry += dt;
    if (ex && typeof ex.beginPreLanded === 'function' && ex.beginPreLanded(SHIP_POS, SHIP_YAW, { autoDepart: false })) {
      this.shipPlaced = true;
      return;
    }
    if (this.shipTry > SHIP_PLACE_TIMEOUT_S) {
      this.shipPlaced = true;
      console.warn('[TutorialWorld] 버려진 함선을 세우지 못했다 (ctx.extraction.beginPreLanded)');
    }
  }

  /** Checkpoint volumes — **the index never goes down, even walking back**. */
  private pollCheckpoints(): void {
    const ctx = this.ctx;
    const player = ctx?.player;
    if (!ctx || !player || player.isDead) return;
    const p = player.position;
    for (let i = CHECKPOINTS.length - 1; i > this.index; i--) {
      if (!volumeContains(CHECKPOINTS[i].trigger, p)) continue;
      this.setIndex(i, true);
      return;
    }
  }

  /**
   * 「may the player start again from the spot they are standing on now」 — four things are checked every frame.
   *   ① **Outside a `kill` volume** — chasm 1's floor is 「where they fell」, not a respawn spot. **`clamp` (chasm 2's landing area) is
   *      not blocked**: it is the landing spot of a fall that is always survived and safe ground standing on the lower deck with both
   *      feet, so blocking the record there would make someone who died in that stretch climb the cliff and jump off again for no reason.
   *   ② **Outside chasm 1's band — this test alone is asymmetric.** The approach side (+Z of the near edge) is blocked as wide as
   *      `CHASM_RUNUP_M` (12 m), the far side (−Z of the far edge) only by `SAFE_CHASM_MARGIN` (1.5 m). Why a symmetric margin
   *      (`inChasm`) will not do is this cliff's own rule — **it is cleared only by running.** Respawning right at the edge leaves no
   *      run-up and turns 「returned to the spot before the fall」 into 「fall again」. The other way round, blocking 12 m on the far side
   *      too means whoever cleared it must walk that much further for the record to revive, and a death in between returns to the cliff.
   *   ③ **Near a walkable surface** — filters out spots on top of a ruin wall or a wreckage pile (`SAFE_LEVELS` · `SAFE_DECK_EPS`).
   *      The 2026-09-15 2nd pass added the **android pit floor** (`PIT_FLOOR_Y`) as a third height — without it someone who died in the
   *      pit returns to the last flat ground before it (not wrong, but it is not 「the spot they were standing on」).
   *   ④ **Outside the abyss edge band** (2026-09-15) — nothing within `ABYSS_SAFE_MARGIN_M` (3 m) of the edge (`ABYSS_EDGE_Z`) is recorded.
   *      Respawning on a spot with the toes over the edge (the body's centre still on the deck) falls again in one step. Whoever fell from
   *      that band comes back just behind it, to the last spot 3 m or more from the edge.
   *      2026-09-15 3rd pass — the edges of the **abyss cuts** beyond the fence (`ABYSS_CUTS`) are the same band (`inAbyssCut(x, z, 3)`): the cuts
   *      open to the right and to the south as well, so a single z cannot measure them.
   * Being grounded (`isGrounded`) is itself the fifth condition, so coordinates while jumping or falling are never recorded in the first place
   * (which makes ① a double safety overlapping ③ — the only ground one can stand on inside a `kill` volume is the chasm floor and the terrain below the cliffs).
   */
  private pollSafeGround(): void {
    const player = this.ctx?.player;
    if (!player || player.isDead || !player.isGrounded) return;
    const p = player.position;
    if (!SAFE_LEVELS.some((level) => Math.abs(p.y - level) <= SAFE_DECK_EPS)) return;
    if (p.z <= chasmNearZAt(p.x) + CHASM_RUNUP_M && p.z >= chasmFarZAt(p.x) - SAFE_CHASM_MARGIN) return;
    if (p.z < ABYSS_EDGE_Z + ABYSS_SAFE_MARGIN_M) return;
    if (inAbyssCut(p.x, p.z, ABYSS_SAFE_MARGIN_M)) return;
    for (const v of FALL_RULES) if (v.rule === 'kill' && volumeContains(v, p)) return;
    this.lastSafe.copy(p);
    this.hasLastSafe = true;
  }

  private setIndex(i: number, announce: boolean): void {
    this.index = i;
    const spec = CHECKPOINTS[i];
    if (!announce || !this.ctx) return;
    this.ctx.bus.emit('tutorial:checkpoint', { id: spec.id, index: i });
  }

  /* ── TutorialWorldRef ───────────────────────────────────────────────── */

  get checkpoint(): TutorialCheckpointId { return CHECKPOINTS[this.index].id; }

  /**
   * 2026-09-14 4th pass — to **the last spot the player stood on the ground** when there is one, otherwise to the last checkpoint as before.
   * A pushed-out body may have been recorded stuck in a wall, so it is passed through `resolveCollision` once before being handed back.
   * yaw is 0 (forward) — inheriting the direction of death respawns the player with their back to the cliff.
   */
  respawnPose(): { position: THREE.Vector3; yaw: number } {
    if (this.hasLastSafe) {
      const position = this.lastSafe.clone();
      this.ctx?.world?.resolveCollision(position, PLAYER_RADIUS);
      return { position, yaw: 0 };
    }
    const spec = CHECKPOINTS[this.index];
    return { position: spec.at.clone(), yaw: spec.yaw };
  }

  /** 2026-09-16: progress through the crawl stretch — entrance `CRAWL.z0` 0 · exit `CRAWL.z1` 1 (read by the tutorial control guide). */
  crawlProgress(position: THREE.Vector3): number {
    return (CRAWL.z0 - position.z) / (CRAWL.z0 - CRAWL.z1);
  }

  fallRule(position: THREE.Vector3): TutorialFallRule {
    for (const v of FALL_RULES) if (volumeContains(v, position)) return v.rule;
    return 'normal';
  }

  gotoCheckpoint(id: TutorialCheckpointId): boolean {
    const i = CHECKPOINTS.findIndex((c) => c.id === id);
    if (i < 0 || !this.built) return false;
    // It is a teleport, so 「the last spot stood on」 is void — left in place, a death right after a resume returns the player
    // to where they stood before the reload (breaking the rule that a resume goes to a **checkpoint**).
    this.hasLastSafe = false;
    this.setIndex(i, true);
    const spec = CHECKPOINTS[i];
    this.ctx?.player?.teleport(spec.at.clone(), spec.yaw, false);
    return true;
  }

  enemySpawns(): readonly TutorialEnemySpawn[] { return this.spawns; }

  /* ── World queries (called by `WorldSystem` in its `mode === 'tutorial'` branch) ── */

  /**
   * Terrain height = the single value `VOID_Y`. The walkable decks and chasm 1's chasm floor (`CHASM_FLOOR_Y`) are all box colliders, so
   * `getSurfaceY` answers them. 2026-09-15 −34 → −100: it is a constant with no arguments, so the abyss alone could not be deepened and the whole thing went down (`model.ts`'s `VOID_Y`).
   */
  heightAt(): number { return VOID_Y; }

  /** Ray vs. the chasm floor plane. Returns `t` (−1 with no hit) and writes the normal into `n` — the same place as the training range's `raycastShell`. */
  raycastGround(oy: number, dy: number, maxDist: number, n: THREE.Vector3): number {
    if (dy >= -1e-6) return -1;
    const t = (VOID_Y - oy) / dy;
    if (t < 0 || t > maxDist) return -1;
    n.set(0, 1, 0);
    return t;
  }

  isInside(x: number, z: number): boolean {
    return Math.abs(x) <= CORRIDOR_OUTER_X && z <= Z_START && z >= Z_END;
  }

  /**
   * The last line of defence — the wall colliders already block, but a body pushed out must not leave the map.
   * It measures against the **widest stretch** (`CORRIDOR_OUTER_X`): narrowing it per stretch would put a body pushed into a narrow
   * stretch's wall back somewhere inside the wall rather than in the corridor — the real pushing back is `resolveCollision`'s job.
   */
  clampInside(position: THREE.Vector3, radius: number): void {
    const lim = CORRIDOR_OUTER_X - radius;
    if (position.x > lim) position.x = lim; else if (position.x < -lim) position.x = -lim;
    const z0 = Z_START - radius, z1 = Z_END + radius;
    if (position.z > z0) position.z = z0; else if (position.z < z1) position.z = z1;
  }

  /** The surface material underfoot — concrete only around the start ruins, rock everywhere else. */
  surfaceMaterial(x: number, z: number): SurfaceMaterial {
    if (z <= RUINS.z0 && z >= RUINS.z1) return 'concrete';
    return 'rock';
  }

  /** Debug · smokes: the two deck heights and the ship's spot (so a script does not copy the coordinates). */
  get debugLevels(): { upper: number; lower: number; ship: THREE.Vector3 } {
    return { upper: DECK_UPPER_Y, lower: DECK_LOWER_Y, ship: SHIP_POS.clone() };
  }

  dispose(): void {
    if (!this.built) return;
    this.built = false;
    const hash = this.hash;
    this.corpses.dispose();
    if (hash) { this.dressing.dispose(hash); this.ground.dispose(hash); }
    this.spawns.length = 0;
    this.index = 0;
    this.hasLastSafe = false;
    this.shipPlaced = false;
    this.group.clear();
    this.group.removeFromParent();
    this.hash = null;
    this.ctx = null;
  }
}
