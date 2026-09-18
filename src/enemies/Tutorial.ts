/**
 * src/enemies/Tutorial.ts — **tutorial-only enemies** (2026-09-14, section `D` of `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」).
 *
 * A tutorial raid (`ctx.missionMode === 'tutorial'`) places only enemies of a **fixed spot · fixed type**:
 * no rolls · no waves · no patrols · no spawner · no sandworm · no named · no raider drops.
 * The same trick the training range (`sys.training`) uses to turn everything off, differing in one thing — **there are enemies**.
 *
 * **The world owns the spots, this file owns the bodies** — split that way so the folders do not import each other.
 * `EnemySystem` reads `ctx.world.tutorial?.enemySpawns()` **once** at `world:ready` and hands it to this file.
 * An enemy killed once is not brought back by a checkpoint revive, so the list is never read again.
 * (`ctx.world.tutorial` is a stub that is null while the tutorial world is built — an empty list simply ends with 0 enemies.)
 *
 * Two values that apply to one body only (`Enemy.senseRadius` · `Enemy.homeLeash`, defaults from csv
 * `TUTORIAL_ENEMY_SENSE_M` · `TUTORIAL_ENEMY_LEASH_M`):
 *   - `sense` — a player outside this radius is **never noticed at all** (sight · sound · lures · pack propagation, all of it).
 *     The places it applies are `ai/Perception.senseRadiusOf` and the four radius calculations of `parts/Alerts`.
 *   - `leash` — this far from its own spot (`guardPos`) it folds the chase and goes back (the `homeLeash` branch of `ai/EnemyAI`).
 * Both **default to 0**, so an enemy this file did not fill in — every enemy of the main game's raids · the training range — is unchanged.
 *
 * The android's shell and sparks instead of blood are **the main game's, verbatim**.
 *
 * ── 2026-09-14 3rd pass (`docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」) ──────────────────────────────
 * 1. **Four dedicated enemy types.** The world list uses `tut_bug_loot` · `tut_bug` · `tut_android_loot` · `tut_android`.
 *    The numbers are their own rows in `data/enemies.csv` (the android has half the hp), the rig · AI · sounds are the base
 *    type's (`EnemyTypes.baseTypeOf`), and the only other difference is the **fixed drop** — only the two `_loot` types drop
 *    a decided item at 100 % and the other two are empty corpses (`data/loot_corpses.csv` · `loot_corpse_rolls.csv` ·
 *    `CORPSE_LOOT_CHANCE`). The tutorial has no rolls, so exactly the thing it means to teach comes out.
 * 2. **Bugs come up out of the ground.** Bug rows are not placed at `world:ready` but held in `TutorialPlacement.ambush` and
 *    pulled out with a burrow spawn when the player enters that body's detection radius (`updateTutorialAmbush`).
 *
 * ── 2026-09-15 3rd pass (user's decision — the last two past the wire fence) ────────────────────────────
 * 3. **Per-spot gun · detection radius.** A row of the world list can override `weapon` (the gun family — shotgun · marksman
 *    rifle) and `sense` (22 m, the radius that takes in the ship ramp · the cargo bay) (`weaponFor` · `applyTutorialTether`).
 *    Both are `tut_android_loot`, so that gun drops on the corpse as it is. The second waking after the switch is pressed is
 *    the liftoff fire window that already existed (`onTutorialLiftoff`) — the tutorial ship's switch *is* `extraction:liftoff`, so no separate hook is needed.
 * 4. **A fallen enemy goes back to its spot.** Abyss cuts opened past the wire fence (`ABYSS_CUTS` in `world/tutorial/model.ts`), so a
 *    chasing android can cross the edge, and an enemy's walk only catches the ground with `getSurfaceY` and has no fall, so it **teleports**
 *    to the terrain (−100). `tutorialHold` puts an enemy that dropped `FALL_RESET_M` below its spot back (a main-game enemy has `homeLeash` 0 and returns on the first line).
 */
import type * as THREE from 'three';
import { BURROW_EMERGE_S, TUTORIAL_ENEMY_LEASH_M, TUTORIAL_ENEMY_SENSE_M, type EnemyType, type TutorialEnemySpawn } from '@/shared';
/* appended (2026-09-16): blocking the drop-off edge */
import { PROP_STEP_UP_MAX, TUTORIAL_ENEMY_EDGE_MARGIN_M, type WorldRef } from '@/shared';
/* appended (2026-09-15): bug chain spawn · per-stretch aggro release · the liftoff fire window */
import {
  TUTORIAL_AGGRO_DROP_M, TUTORIAL_BUG_CHAIN_SPAWN_S, TUTORIAL_CHECKPOINTS, TUTORIAL_LIFTOFF_FIRE_RANGE_M, TUTORIAL_LIFTOFF_FIRE_S,
  type TutorialCheckpointId, type TutorialFallRule,
} from '@/shared';
import type { Enemy } from './Enemy';
import { ALL_ENEMY_TYPES, ENEMY_STATS, HUMANOID_WEAPONS, isWormType } from './EnemyTypes';
import type { RogueSpawnHost } from './RogueGuards';

/** The tutorial enemies placed this raid (debug · smokes — `EnemySystem.debugTutorial()`). */
export interface TutorialPlacement {
  /** How many actually stood up (a bug that came out of the ground counts here once it is out). */
  spawned: number;
  /** The ids of the placed enemies (placement order = list order; bugs that emerge later are appended). */
  ids: number[];
  /** Rows that were in the list but could not be placed (an unknown type · the sandworm · a saturated pool). */
  skipped: number;
  /** Bugs still underground (2026-09-14 3rd pass — `updateTutorialAmbush` pulls them out one at a time). */
  ambush: TutorialAmbush[];
  /* ── 2026-09-15 (user's decision) ── */
  /** Bug chain spawn: seconds left until the next bug. **-1 = no chain** (set to `TUTORIAL_BUG_CHAIN_SPAWN_S` the moment the first bug emerges). */
  chainTimer: number;
  /** The chain's reference point — the spot of the last bug that emerged (the next bug = the ambush nearest it). */
  chainX: number;
  chainZ: number;
  /** Seconds left in the liftoff fire window (-1 = none, `onTutorialLiftoff`). */
  liftoffFireT: number;
  /** Enemy id → its original radius, for those widened during the liftoff fire window (restored when the window ends). */
  liftoffSense: Map<number, number>;
}

/** The host `updateTutorialScript` · the checkpoint · liftoff hooks use — it walks the enemy list, so `active` is added to `RogueSpawnHost`. */
export interface TutorialScriptHost extends RogueSpawnHost {
  readonly active: readonly Enemy[];
}

/**
 * 2026-09-14 3rd pass — **one bug waiting underground**.
 *
 * A tutorial bug does not stand there from the start; it comes up out of its hole when the player approaches (`docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」).
 * No new concept was made — it calls the **bug burrow spawn** that already exists (2026-09-13: `Pool.spawn(…, emerge)` →
 * `Enemy.startEmerge` + `parts/Burrow.emergeFx` + `ee spawn.em`). That it can be hit but does not attack · move during the 1 s it emerges is that rule too.
 *
 * **No coordinates live here.** A bug emerges at **its own spot** as written in the list, and the trigger is that body's
 * **own detection radius** (`TutorialEnemySpawn.sense`, default `TUTORIAL_ENEMY_SENSE_M`) — the world may move the bug ·
 * lengthen the stretch and this file does not change by one character. The world's convention that a checkpoint lies
 * **outside** that radius is also what means "nothing has emerged yet at the revive spot".
 */
export interface TutorialAmbush {
  readonly spawn: TutorialEnemySpawn;
  readonly type: EnemyType;
  /** Where it emerges (the list's value verbatim — the ground under it is caught the moment it emerges). */
  readonly at: THREE.Vector3;
  readonly yaw: number;
  /** A player within this distance makes it emerge (that body's detection radius). */
  readonly sense: number;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>(ALL_ENEMY_TYPES);

/** The type when `data/enemies.csv` has it, else null. The sandworm is an event boss its own director places, so it is refused here. */
function toEnemyType(type: string): EnemyType | null {
  if (!KNOWN_TYPES.has(type)) return null;
  const t = type as EnemyType;
  return isWormType(t) ? null : t;
}

/**
 * The gun a humanoid carries — the family the world list wrote at that spot when it has one (2026-09-15 3rd pass: the shotgun ·
 * marksman rifle of the two past the wire fence), else fixed to the first entry of the faction table (the tutorial has no rolls).
 * On a `*_loot` type this family drops on the corpse as it is (`rogueWeaponId` in `items/Loot.rollCorpseOn` — a grade-I def id, so it is that gun with no grade roll).
 */
function weaponFor(type: EnemyType, s: TutorialEnemySpawn): string {
  const faction = ENEMY_STATS[type].faction;
  if (faction === 'bug') return '';
  return spawnWeapon(s) ?? HUMANOID_WEAPONS[faction][0] ?? '';
}

/**
 * The gun family the world wrote (`TutorialSpawnSpec.weapon` in `world/tutorial/model.ts`). An optional field the shared contract
 * `TutorialEnemySpawn` does not carry yet, so it is read structurally — raising it to the contract is a `docs/TODO.md` reference item. An empty string · a non-string value is 「none」.
 */
function spawnWeapon(s: TutorialEnemySpawn): string | null {
  const w = (s as { weapon?: unknown }).weapon;
  return typeof w === 'string' && w.length > 0 ? w : null;
}

/** Reads a positive number that falls back to the csv default (0 · a negative · NaN from the world still lives as the default). */
function positive(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Places the world's list verbatim — **once at `world:ready` on the authority client**. There is not one roll
 * (spot · type · yaw are all the list's values, and this function never uses a random number).
 *
 * Bugs go through `spawn` and humanoids through `spawnRogue` (their own spot as `guardPos`), so they use **the same body ·
 * the same AI as the main game**. Laying this one body's `senseRadius` · `homeLeash` on top is all the tutorial does.
 */
export function placeTutorialEnemies(host: RogueSpawnHost, spawns: readonly TutorialEnemySpawn[]): TutorialPlacement {
  const out: TutorialPlacement = {
    spawned: 0, ids: [], skipped: 0, ambush: [],
    chainTimer: -1, chainX: 0, chainZ: 0, liftoffFireT: -1, liftoffSense: new Map(),
  };
  const world = host.ctx.world;
  if (!world?.ready || spawns.length === 0) {
    out.skipped = spawns.length;
    return out;
  }
  for (const s of spawns) {
    const type = toEnemyType(s.type);
    if (!type || !s.position) { out.skipped++; continue; }
    const yaw = Number.isFinite(s.yaw) ? s.yaw : 0;
    const at = s.position.clone();
    // catch the ground under it once (the spot the world gave is not moved — only the height goes to that spot's surface)
    at.y = world.getSurfaceY(at.x, at.z, at.y);
    /* 2026-09-14 3rd pass: **bugs are not placed yet.** They wait underground and emerge when the player enters the detection
       radius (`updateTutorialAmbush`). Humanoids stand at their spot as before — cover · crouched fire is half the picture, so there is no reason to hide them. */
    if (ENEMY_STATS[type].faction === 'bug') {
      out.ambush.push({ spawn: s, type, at, yaw, sense: positive(s.sense, TUTORIAL_ENEMY_SENSE_M) });
      continue;
    }
    const e = host.spawnRogue(type, at, yaw, at, weaponFor(type, s), null, { site: null, squadId: host.allocSquadId(), role: 'member' });
    if (!e) { out.skipped++; continue; }
    applyTutorialTether(e, s);
    out.spawned++;
    out.ids.push(e.id);
  }
  return out;
}

/**
 * 2026-09-14 3rd pass — **pulls a bug out of the ground.** The authority client calls it every gameplay frame
 * (`EnemySystem.update`; outside the tutorial, or with nothing left, it returns on the first line).
 *
 * When the player (the local body) comes inside that body's detection radius it emerges **at its own spot** over `BURROW_EMERGE_S`
 * and starts chasing at once (`chase`) — no attack · move while emerging is `ai/Burrow`'s rule, so "bursts out → charges" happens
 * on its own. The burrow FX · shake · sound · `ee spawn.em` all come from the same code as the main game inside `Pool.spawn`.
 *
 * Vertical distance is not looked at — the tutorial corridor is one floor, and where the decks split the stretch itself is far.
 *
 * ── 2026-09-15 (user's decision — 「the second bug **exactly 1 s after** the first one emerges」) ──
 * Approach is the trigger for **the first body only**. The moment it emerges the chain clock stands up (`chainTimer` =
 * `TUTORIAL_BUG_CHAIN_SPAWN_S`) and the remaining ambushes emerge one at a time **on the clock alone** (the next = the ambush nearest
 * the spot that just emerged). Approach is ignored while the chain runs — if not, running up beside the second bug would beat the 1 s.
 * A player who walks past that stretch (the `crawl` checkpoint) drops the remaining ambushes and the clock together (`onTutorialCheckpoint`).
 * `dt` is the gameplay frame's simulation time (omitted = 0 — the clock does not start; compatibility with old call sites).
 */
export function updateTutorialAmbush(host: RogueSpawnHost, placement: TutorialPlacement | null, dt = 0): void {
  const list = placement?.ambush;
  if (!placement || !list) return;
  if (list.length === 0) { placement.chainTimer = -1; return; }
  const ctx = host.ctx;
  if (!ctx.world?.ready) return;
  if (placement.chainTimer >= 0) {
    placement.chainTimer -= Math.max(0, dt);
    if (placement.chainTimer > 0) return;
    const next = list.splice(nearestAmbush(list, placement.chainX, placement.chainZ), 1)[0];
    emergeAmbush(host, placement, next);
    placement.chainTimer = list.length > 0 ? chainDelay() : -1;
    return;
  }
  const p = ctx.player?.position;
  if (!p) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    const dx = p.x - a.at.x, dz = p.z - a.at.z;
    if (dx * dx + dz * dz > a.sense * a.sense) continue;
    list.splice(i, 1);
    emergeAmbush(host, placement, a);
    // the chain clock pulls out the rest — never several in one frame
    if (list.length > 0) placement.chainTimer = chainDelay();
    return;
  }
}

/** Pulls one ambush out at its spot with a burrow spawn (the chain's reference point moves here too). */
function emergeAmbush(host: RogueSpawnHost, placement: TutorialPlacement, a: TutorialAmbush): void {
  placement.chainX = a.at.x;
  placement.chainZ = a.at.z;
  const e = host.spawn(a.type, a.at, a.yaw, true, false, BURROW_EMERGE_S);
  if (!e) { placement.skipped++; return; }
  applyTutorialTether(e, a.spawn);
  placement.spawned++;
  placement.ids.push(e.id);
}

/** The chain gap (csv). 0 is accepted too (= the next frame); a negative · NaN gives 1 s. */
function chainDelay(): number {
  return Number.isFinite(TUTORIAL_BUG_CHAIN_SPAWN_S) && TUTORIAL_BUG_CHAIN_SPAWN_S >= 0 ? TUTORIAL_BUG_CHAIN_SPAWN_S : 1;
}

function nearestAmbush(list: readonly TutorialAmbush[], x: number, z: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const dx = list[i].at.x - x, dz = list[i].at.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * 2026-09-15 — **every frame tick** of the tutorial enemies (called by the authority · gameplay branch of `EnemySystem.update`):
 * the ambush · chain spawn (`updateTutorialAmbush`) and the liftoff fire window (`onTutorialLiftoff`).
 */
export function updateTutorialScript(host: TutorialScriptHost, placement: TutorialPlacement | null, dt: number): void {
  if (!placement) return;
  updateTutorialAmbush(host, placement, dt);
  updateLiftoffFire(host, placement, dt);
}

/* ═══════════════ Per-stretch aggro release (2026-09-15, user's decision) ══════════════════════════════════
 * Every stretch of the tutorial must be **skippable** — an enemy of a later stretch must not chase someone who walked past without fighting.
 *   ① The bug stretch: when the player reaches the `crawl` checkpoint (the low-ceiling structure's entrance) **every bug** folds its chase.
 *      Ambushes still underground · the chain clock are dropped where they are (nothing emerges behind the player afterwards).
 *   ② The first two androids: when the player **falls off a cliff** (`player:fell` — a landing, not the instant-death rule, after the `drop`
 *      checkpoint) or reaches the `supply` checkpoint, a humanoid whose spot sits more than `TUTORIAL_AGGRO_DROP_M` **above** the player's
 *      feet folds chase · fire — no coordinates, 「the enemies left on the cliff」 are picked (those behind the collapsed wall · beside the ship share the deck and stay).
 * Checkpoints only move forward (`TutorialWorld.setIndex`), so the test is 「that index or later」 — resume's `gotoCheckpoint` takes the same path.
 * A released enemy gets `Enemy.tutorialReleased`, and `tutorialHold` sends it home every frame (it never charges again).
 * ═════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** A released enemy's detection radius (m) — 0 cannot be used, it means 「the usual table」. A geometric tolerance (it notices practically nothing), so it lives in code. */
const RELEASED_SENSE_M = 0.01;

/** `tutorial:checkpoint` (authority). */
export function onTutorialCheckpoint(host: TutorialScriptHost, placement: TutorialPlacement | null, id: TutorialCheckpointId): void {
  if (!placement) return;
  const idx = TUTORIAL_CHECKPOINTS.indexOf(id);
  if (idx < 0) return;
  if (idx >= TUTORIAL_CHECKPOINTS.indexOf('crawl')) releaseBugs(host, placement);
  if (idx >= TUTORIAL_CHECKPOINTS.indexOf('supply')) releaseAbovePlayer(host);
}

/** `player:fell` (authority) — a cliff-2 fall. The instant-death rule (the cliff-1 chasm · the bottomless abyss) is no reason to release: the player revives and comes back up. */
export function onTutorialFell(host: TutorialScriptHost, placement: TutorialPlacement | null, rule: TutorialFallRule): void {
  if (!placement || rule === 'kill') return;
  const player = host.ctx.player;
  if (!player || player.isDead) return;
  const cp = host.ctx.world?.tutorial?.checkpoint;
  if (!cp || TUTORIAL_CHECKPOINTS.indexOf(cp) < TUTORIAL_CHECKPOINTS.indexOf('drop')) return;
  releaseAbovePlayer(host);
}

function releaseBugs(host: TutorialScriptHost, placement: TutorialPlacement): void {
  const left = placement.ambush.filter((a) => ENEMY_STATS[a.type].faction !== 'bug');
  if (left.length !== placement.ambush.length) {
    placement.ambush = left;
    placement.chainTimer = -1;
  }
  for (const e of host.active) if (e.homeLeash > 0 && e.isCombatant && !e.isHumanoid) releaseEnemy(e);
}

function releaseAbovePlayer(host: TutorialScriptHost): void {
  const p = host.ctx.player?.position;
  if (!p) return;
  const margin = Number.isFinite(TUTORIAL_AGGRO_DROP_M) ? Math.max(0, TUTORIAL_AGGRO_DROP_M) : 3;
  for (const e of host.active) {
    if (e.homeLeash <= 0 || !e.isCombatant || !e.isHumanoid) continue;
    if (e.guardPos.y > p.y + margin) releaseEnemy(e);
  }
}

function releaseEnemy(e: Enemy): void {
  if (e.tutorialReleased) return;
  e.tutorialReleased = true;
  e.senseRadius = RELEASED_SENSE_M;
  if (!e.airborne && e.chargePhase === 0 && e.state !== 'stagger') leashHome(e);
}

/* ═══════════════ The liftoff fire window (2026-09-15, user's decision — 「real damage · no death」) ═════════
 * Humanoid enemies that were not killed **actually** shoot the rider of the tutorial ship that lifted the moment the switch was
 * pressed (damage lands and hp stops at 1 — `PlayerRef.setSceneLock(true, {allowDamage})`, raised by extraction). But a tutorial
 * enemy's detection radius is 12 m, so it loses the climbing ship at once and never notices a body that was right in the middle at
 * liftoff. So for `TUTORIAL_LIFTOFF_FIRE_S` only, the (unreleased) humanoids within `TUTORIAL_LIFTOFF_FIRE_RANGE_M` take the rider
 * as their target and widen their detection radius to that distance. The firing itself is the ordinary AI (`ai/RogueAI` →
 * `ai/FireLine` → `parts/Attacks.fireGun`) — no gun is fired here. When the window ends or the rider is gone (skip · reset) the widened radius is restored.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** `extraction:liftoff` (authority, tutorial). */
export function onTutorialLiftoff(placement: TutorialPlacement | null): void {
  if (!placement) return;
  placement.liftoffFireT = Number.isFinite(TUTORIAL_LIFTOFF_FIRE_S) ? Math.max(0, TUTORIAL_LIFTOFF_FIRE_S) : 0;
}

function updateLiftoffFire(host: TutorialScriptHost, placement: TutorialPlacement, dt: number): void {
  if (placement.liftoffFireT < 0) return;
  placement.liftoffFireT -= Math.max(0, dt);
  const ctx = host.ctx;
  const target = host.targets.local();
  const riding = ctx.extraction?.riding === true;
  if (placement.liftoffFireT <= 0 || !riding || !target || target.isDeadOrDowned) {
    endLiftoffFire(host, placement);
    return;
  }
  const range = Number.isFinite(TUTORIAL_LIFTOFF_FIRE_RANGE_M) ? Math.max(0, TUTORIAL_LIFTOFF_FIRE_RANGE_M) : 0;
  const r2 = range * range;
  for (const e of host.active) {
    if (e.homeLeash <= 0 || e.tutorialReleased || !e.isHumanoid || !e.isCombatant) continue;
    if (e.position.distanceToSquared(target.position) > r2) continue;
    if (!placement.liftoffSense.has(e.id)) {
      placement.liftoffSense.set(e.id, e.senseRadius);
      e.senseRadius = Math.max(e.senseRadius, range);
    }
    if (e.target !== target) { e.target = target; e.hasLOS = false; e.perceptionTimer = 0; }
    if (!e.aware) {
      e.aware = true;
      e.lostTimer = 0;
      e.investigating = false;
      if (e.state === 'idle' || e.state === 'wander') { e.state = 'alert'; e.stateTime = 0; e.hasMoveTarget = false; }
    }
  }
}

function endLiftoffFire(host: TutorialScriptHost, placement: TutorialPlacement): void {
  placement.liftoffFireT = -1;
  if (placement.liftoffSense.size === 0) return;
  for (const e of host.active) {
    const prev = placement.liftoffSense.get(e.id);
    if (prev !== undefined && e.homeLeash > 0) e.senseRadius = e.tutorialReleased ? RELEASED_SENSE_M : prev;
  }
  placement.liftoffSense.clear();
}

/**
 * The detection radius · leave distance that apply to that one body. `guardPos` is **the spot it stands at** and `spawnPos` is
 * matched to it (so an enemy that left the leash and came back wanders around its own spot). For a humanoid `leash` already means
 * the same, so both are filled — where `ai/RogueAI`'s soft leash (it follows a little further while it can see) and `ai/EnemyAI`'s
 * hard leash (it goes back no matter what) overlap, the hard one wins.
 */
function applyTutorialTether(e: Enemy, s: TutorialEnemySpawn): void {
  e.senseRadius = positive(s.sense, TUTORIAL_ENEMY_SENSE_M);
  e.homeLeash = positive(s.leash, TUTORIAL_ENEMY_LEASH_M);
  e.guardPos.copy(e.position);
  e.spawnPos.copy(e.position);
  e.leash = e.homeLeash;
}

/**
 * The distance (m) that counts as 「standing at its own spot」. It is looser than what the ordinary `wander` state counts as
 * arrival (bugs 0.71 · humanoids 0.78), so the arrival test and this one never undo each other. Not balance but a **geometric
 * tolerance**, so it lives in code (the same nature as `WANDER_LEASH_MARGIN` in `ai/RogueAI` · `LURE_ARRIVE` in `ai/EnemyAI`).
 */
const HOME_EPS = 1;
/**
 * 2026-09-15 3rd pass — an enemy this many m **below** its own spot fell through an abyss cut (`getSurfaceY` returned the terrain's
 * −100 and the body teleported). Set above cliff 2's drop (10 m) to tell it from a pit (0.9 m) · a walk down below cliff 2 — a geometric tolerance, so it lives in code.
 */
const FALL_RESET_M = 20;

/**
 * A tutorial enemy **holding its own spot** — `ai/EnemyAI.updateEnemyAI` calls it every frame after the perception update.
 * With `homeLeash === 0` (every enemy of the main game · the training range) it **returns on the first line** — one line is all the call site sees.
 *
 *   0. It fell through an abyss cut (`FALL_RESET_M` below its spot) — put back at the spot and the chase folded (file header note 4).
 *   1. Outside the leash — it folds the chase no matter what and walks to its own spot (`leashHome`).
 *   2. Fighting inside the leash — the ordinary AI (this is where the combat the tutorial teaches happens).
 *   3. The fight is over but it is away from its spot — it walks back.
 *   4. Standing at its spot — **it does not patrol.** `wanderTimer` is refilled by as much as `idle` takes off, so it never expires.
 *      That pins the danger zone **exactly** to `sense` around the spot the list wrote, and lets the world put a checkpoint outside it.
 */
export function tutorialHold(e: Enemy, dt: number): void {
  if (e.homeLeash <= 0) return;
  if (e.airborne || e.chargePhase !== 0 || e.state === 'stagger') return;   // already airborne · a charge · a stagger end only when they end
  if (e.position.y < e.guardPos.y - FALL_RESET_M) { e.position.copy(e.guardPos); leashHome(e); return; }
  const hx = e.position.x - e.guardPos.x, hz = e.position.z - e.guardPos.z;
  const home = hx * hx + hz * hz;
  /*
   * 2026-09-15 — **an enemy that laid its aggro down** (`onTutorialCheckpoint` · `onTutorialFell`). It does not fight inside or
   * outside the leash: aware (shot · sound) or investigating · chasing · attacking, it folds there and walks back, and standing at
   * its spot it does not patrol. Its radius is `RELEASED_SENSE_M`, so noticing anything anew is practically impossible — this is the insurance for a shot waking it.
   */
  if (e.tutorialReleased) {
    if (e.aware || e.investigating || e.target !== null || (e.state !== 'idle' && e.state !== 'wander')) { leashHome(e); return; }
    if (e.state === 'idle') {
      if (home > HOME_EPS * HOME_EPS) leashHome(e);
      else e.wanderTimer += dt;
    }
    return;
  }
  if (home > e.homeLeash * e.homeLeash) { leashHome(e); return; }
  if (e.aware) return;
  if (e.state !== 'idle') return;                     // `wander` = it is walking back, so it is left alone
  if (home > HOME_EPS * HOME_EPS) leashHome(e);
  else e.wanderTimer += dt;
}

/* ═══════════════ Blocking the drop-off edge (2026-09-16, user's decision) ═══════════════════════════════════
 * 「When a tutorial android sees the player and sets out to fight, it walks toward the cliff **not at all**.」 Before, a chasing
 * android walked out through the abyss cut past the wire fence (`ABYSS_CUTS` in `world/tutorial/model.ts`) and teleported back to its spot by `FALL_RESET_M`.
 *
 * No coordinates — **it is measured with world queries**: it looks at the ground `TUTORIAL_ENEMY_EDGE_MARGIN_M` out from the body's centre in eight directions, and
 *   - when that spot's highest top face is more than `PROP_STEP_UP_MAX` above the feet it is a **wall** → not an edge (a pit wall · a cliff wall has no deck under it),
 *   - else, when the surface stepped on from the current feet height (`getSurfaceY(x, z, feetY)`) is more than `PROP_STEP_UP_MAX` below the feet, it is a **drop-off**.
 * A pit sill (exactly 0.9 = `PROP_STEP_UP_MAX`) is a step walked up and down, not a drop-off (the `>` test). Cliff 2 (10 m) is one too —
 * an android on the upper deck does not come to the edge after a player who jumped down.
 * When the new spot is inside the edge band and the old one outside, the step is cut **per axis** (x only → z only → stay) — it slides along
 * the band and does not enter it. An old spot already inside the band (a body pushed in) is not blocked — trapping it means it never gets out; a fall is caught by `FALL_RESET_M`.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════════ */

/* Sampling geometry (not balance but query resolution · float tolerance, so it lives in code): eight directions × three steps each
   (a 3 m band is a 1 m spacing — if a sample skips a 0.6 m wall that direction reads as a drop-off and is blocked **conservatively**; it never errs toward falling). */
const EDGE_DIRS = 8;
const EDGE_RAY_SAMPLES = 3;
/** The slack (m) that keeps a drop of exactly `PROP_STEP_UP_MAX` — the pit sill — from reading as a drop-off. */
const EDGE_STEP_EPS = 1e-3;
const _edgeDirX: number[] = [], _edgeDirZ: number[] = [];
for (let i = 0; i < EDGE_DIRS; i++) { const a = (i / EDGE_DIRS) * Math.PI * 2; _edgeDirX.push(Math.cos(a)); _edgeDirZ.push(Math.sin(a)); }

/** Whether a body standing at `(x, z)` with feet at `feetY` is within `margin` of a drop-off edge. */
function nearDrop(world: WorldRef, x: number, z: number, feetY: number, margin: number): boolean {
  for (let i = 0; i < EDGE_DIRS; i++) {
    // walk one direction out in `EDGE_RAY_SAMPLES` steps — meeting a wall first means the drop-off beyond it is blocked, so this direction is safe
    // (so the abyss cut `cut_s` behind the pit's south wall does not block the whole inner 3 m of the pit).
    for (let k = 1; k <= EDGE_RAY_SAMPLES; k++) {
      const d = (margin * k) / EDGE_RAY_SAMPLES;
      const px = x + _edgeDirX[i] * d, pz = z + _edgeDirZ[i] * d;
      if (world.getSurfaceY(px, pz) > feetY + PROP_STEP_UP_MAX) break;   // wall
      if (world.getSurfaceY(px, pz, feetY) < feetY - PROP_STEP_UP_MAX - EDGE_STEP_EPS) return true;
    }
  }
  return false;
}

/**
 * Called **after** `ai/EnemyAI.integrate` moved the step and pushed out, and **before** it catches the final surface again. With `homeLeash === 0` (the main game · the training range) it returns on the first line.
 * `prevX · prevZ · prevY` = the spot before this step. `pos` is fixed in place (y is caught again by the call site).
 */
export function tutorialEdgeGuard(e: Enemy, world: WorldRef, pos: THREE.Vector3, prevX: number, prevZ: number, prevY: number): void {
  if (e.homeLeash <= 0 || e.airborne) return;
  const margin = Number.isFinite(TUTORIAL_ENEMY_EDGE_MARGIN_M) ? Math.max(0, TUTORIAL_ENEMY_EDGE_MARGIN_M) : 0;
  if (margin <= 0) return;
  if (pos.x === prevX && pos.z === prevZ) return;
  if (!nearDrop(world, pos.x, pos.z, prevY, margin)) return;
  if (nearDrop(world, prevX, prevZ, prevY, margin)) return;
  const nx = pos.x, nz = pos.z;
  if (!nearDrop(world, nx, prevZ, prevY, margin)) { pos.z = prevZ; e.velocity.z = 0; return; }
  if (!nearDrop(world, prevX, nz, prevY, margin)) { pos.x = prevX; e.velocity.x = 0; return; }
  pos.x = prevX; pos.z = prevZ;
  e.velocity.x = 0; e.velocity.z = 0;
}

/**
 * Folds the chase and sends it home to its own spot. Target · perception · lure · investigation · any ability in progress are all
 * folded and it is pointed at `guardPos` in `wander` — walking · animation · collision stay with the ordinary state machine (bugs
 * `ai/EnemyAI` · humanoids `ai/RogueAI`). `aware` is cleared every frame while it is outside the leash, so **outside the leash nothing whatsoever makes it charge again.**
 */
function leashHome(e: Enemy): void {
  e.aware = false;
  e.lostTimer = 0;
  e.target = null;
  e.hasLOS = false;
  e.investigating = false;
  e.hasLure = false;
  e.lureWeight = 0;
  e.suspicionTimer = 0;
  e.spitPhase = 0;
  e.spitAtPoint = false;
  e.toxicPhase = 0;
  e.roguePhase = 0;
  e.burstLeft = 0;
  e.throwTimer = 0;
  e.leaping = false;            // the call site already filtered `airborne` — a leap still only crouching is folded here
  e.structAttack = false;
  e.structBlocking = false;
  e.structTarget = null;
  e.spawnPos.copy(e.guardPos);
  e.state = 'wander';
  e.stateTime = 0;
  e.wanderTimer = 0;
  e.moveTarget.copy(e.guardPos);
  e.hasMoveTarget = true;
  e.hasFacePoint = false;
}
