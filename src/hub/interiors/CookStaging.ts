import * as THREE from 'three';
import type { CookBeatAction, CookGame, CookLiquid, FurniturePose, GameContext } from '@/shared';
import { yawFromForward } from './GeoBatch';
import { roomBox } from './RoomLayout';
import { CAMERA_WALL_MARGIN, segmentHits, type FootBox, type StagedPiece } from './GymStaging';
import { BEAKER_IDLE_LEVEL, COOK_TOOLS, cookToolTarget, liquidMat, poseCookKnife, restCookRig, type CookRig, type CookTool } from './FurnitureKitchen';

/* ────────────────────────────────────────────────────────────────────────────
 * The cooking staging (2026-09-13, the cooking minigame — docs/DECISIONS.md 「2026-09-13 — 요리 미니게임」). Modelled on `GymStaging`.
 *
 *   housing:cookSession {active:true}  → the floor anchor in front of that cook bench · a yaw facing the bench · a fixed over-the-shoulder camera
 *                                         → setFurniturePose({kind:'cook'})
 *
 * **2026-09-14 (user's decision): the minigame runs even when the staging cannot be raised.** A cook-bench piece with no `model.cook`, or a
 * `setFurniturePose` that came back false, used to call `cancelCook()` in the same call stack and **the session died right there** — `startCook`
 * never reached `beginSteps()`, which is what 「the screen comes up but the steps never start」 was. Now only the staging is given up (`held` false)
 * and housing is left alone. The session is taken down **only when a pose we really raised is released by someone else**.
 *   housing:cookStep                   → the current step's game tool (board · grill pan · wok · pot · beaker) comes out to the work spot (`CookRig`)
 *   housing:cookBeat                   → the accumulated hand phase: chopping · mincing · stir-frying = **one cycle** per input, fast (knife up →
 *                                         board → up, the wok tosses), stirring = keeps turning while `stir` arrives, grilling · pouring · between
 *                                         steps = a slow sway; grilling's flip · remove · burn hop the pan, and pouring raises the beaker's liquid.
 *   housing:cookSession {active:false} → the pose is released and the tools slide back to their rest spots
 *   player:furniturePoseEnded (cook, when we did not release it) → cancelCook (so no minigame is left with no pose)
 *
 * The phase follows player's `FURN_COOK` contract (one cycle = 1, φ 0 = knife up · 0.5 = touching the board) and `setFurniturePoseDrive` gets the
 * fractional part — player counts the cycles from the wrap. Knife · ladle · wok read **the same phase**. The piece is always looked up by uid again
 * (the group changes when a room is rebuilt) — this object holds the tool spots, writes them into the new group every frame, and `BuildExtra.cookGame` rebuilds the model at the same spots.
 * ──────────────────────────────────────────────────────────────────────────── */

const TAU = Math.PI * 2;
const frac = (x: number): number => x - Math.floor(x);

/** The damping factor of a tool moving between its rest spot ↔ the work spot · the cap on how high it lifts on the way (m) · the distance counted as arrived (m). */
const TOOL_RATE = 9;
const TOOL_ARC = 0.08;
const TOOL_SETTLED = 0.004;
/** How long one input takes to turn one cycle (s) — a knife stroke · mincing (shorter) · a wok toss. */
const STROKE_S: Readonly<Partial<Record<CookBeatAction, number>>> = { cut: 0.24, mince_h: 0.15, mince_v: 0.15, toss: 0.34 };
/** How long it takes to carry a half-turned hand to the end of its cycle (knife up) when a beat game starts (s). */
const FINISH_STROKE_S = 0.4;
/** Stirring: it keeps turning for this long (s) after the last `stir` (housing sends one periodically while the button is held) · the turn rate (cycles / s). */
const STIR_HOLD_S = 0.45;
const STIR_REV_PER_S = 1.25;
/** The slow sway of grilling · pouring · between steps (cycles / s). */
const SWAY_PER_S = 0.3;
/** The most the phase may advance in one frame (player's wrap check has to stay inside half a cycle) · the most backlog kept when inputs pile up. */
const MAX_CYCLE_STEP = 0.45;
const MAX_CYCLE_LAG = 2;
const WOK_TOSS_LIFT = 0.06;
const WOK_TOSS_TILT = 0.28;
const GRILL_HOP_S = 0.3;
const GRILL_HOP_LIFT = 0.025;
/** Pouring: the liquid height a step starts at · the rate it rises while pouring (/s) · the cap · the height of a step an auto appliance handled. */
const POUR_START_LEVEL = 0.08;
const POUR_FILL_PER_S = 0.22;
const POUR_MAX_LEVEL = 0.95;
const POUR_AUTO_LEVEL = 0.7;

/**
 * The over-the-shoulder camera candidates (cook-bench local, m from the anchor): side (−1 = the **right shoulder**, since the right of a body facing the
 * bench is local −X) × lateral distance × back distance × height. It likes the right shoulder · low · close, and scores down hard when the room wall · another
 * piece in the room · the bench's hood · the body (head and shoulders) blocks the line. Height ≥ 2.25 m so the line to the knife hand (right 0.1 m, forward 0.52 m) clears the shoulder.
 */
const CAM_SIDES = [-1, 1] as const;
const CAM_LATERAL = [0.95, 0.7] as const;
const CAM_BACK = [0.55, 0.85] as const;
const CAM_HEIGHT = [2.25, 2.5] as const;
/** The body used for the occlusion check (a local box from the anchor — the bowed head · shoulders) · the head height (`FURN_EYE.cook` 1.42 and a little). */
const BODY = { halfX: 0.28, minY: 1.25, maxY: 1.85, back: 0.15, front: 0.18 } as const;
const HEAD_Y = 1.5;

const _c = new THREE.Vector3();
const _f = new THREE.Vector3();
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();
const _target = new THREE.Vector3();

/** A local box (min, max) into the piece group's world AABB (furniture yaw is quarter turns only, so the 8 corners are enough). */
function worldBox(g: THREE.Object3D, min: THREE.Vector3, max: THREE.Vector3): FootBox {
  const out: FootBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < 8; i++) {
    _c.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
    g.localToWorld(_c);
    out.minX = Math.min(out.minX, _c.x); out.maxX = Math.max(out.maxX, _c.x);
    out.minY = Math.min(out.minY, _c.y); out.maxY = Math.max(out.maxY, _c.y);
    out.minZ = Math.min(out.minZ, _c.z); out.maxZ = Math.max(out.maxZ, _c.z);
  }
  return out;
}
const inside = (p: THREE.Vector3, b: FootBox): boolean => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ;

/** The cook bench's fixed over-the-shoulder camera (candidate scoring — the `CAM_*` comment above). It runs once at session start, so allocation does not matter. */
export function cookCameraOf(piece: StagedPiece, rig: CookRig, blockers: readonly FootBox[] = []): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  const g = piece.model.group;
  g.updateWorldMatrix(true, false);
  const a = rig.anchor;
  const lookAt = g.localToWorld(rig.focus.clone());
  const head = g.localToWorld(new THREE.Vector3(a.x, a.y + HEAD_Y, a.z));
  const body = worldBox(g, _min.set(a.x - BODY.halfX, a.y + BODY.minY, a.z - BODY.back), _max.set(a.x + BODY.halfX, a.y + BODY.maxY, a.z + BODY.front));
  const hood = worldBox(g, rig.hood.min, rig.hood.max);
  const box = roomBox(piece.item.room);
  const p = new THREE.Vector3();
  let best: THREE.Vector3 | null = null, bestCost = Infinity;
  for (const side of CAM_SIDES) for (const lat of CAM_LATERAL) for (const back of CAM_BACK) for (const y of CAM_HEIGHT) {
    p.set(a.x + side * lat, a.y + y, a.z - back);
    g.localToWorld(p);
    let cost = (side > 0 ? 0.5 : 0) + (y - CAM_HEIGHT[0]) * 0.8 + (CAM_LATERAL[0] - lat) * 0.3 + (back - CAM_BACK[0]) * 0.2;
    if (box) {
      const minX = box.minX + CAMERA_WALL_MARGIN, maxX = box.maxX - CAMERA_WALL_MARGIN;
      const minZ = box.minZ + CAMERA_WALL_MARGIN, maxZ = box.maxZ - CAMERA_WALL_MARGIN;
      const over = Math.max(0, minX - p.x, p.x - maxX) + Math.max(0, minZ - p.z, p.z - maxZ);
      if (over > 0) {
        cost += 4 + over * 4;
        p.x = THREE.MathUtils.clamp(p.x, minX, maxX);
        p.z = THREE.MathUtils.clamp(p.z, minZ, maxZ);
      }
    }
    if (segmentHits(p, lookAt, body)) cost += 2;
    if (segmentHits(p, lookAt, hood)) cost += 3;
    for (const b of blockers) {
      if (inside(p, b)) cost += 6;
      if (segmentHits(p, lookAt, b)) cost += 3;
      if (segmentHits(p, head, b)) cost += 1.5;
    }
    if (cost < bestCost) { bestCost = cost; best = (best ?? new THREE.Vector3()).copy(p); }
  }
  return { position: best ?? lookAt.clone().add(_f.set(0, 1.2, 0)), lookAt };
}

/** One pose in front of the cook bench (anchor = the floor in front of it · a yaw facing it · the over-the-shoulder camera). null when it is not a cook bench. */
export function cookPoseOf(piece: StagedPiece, blockers: readonly FootBox[] = []): FurniturePose | null {
  const rig = piece.model.cook;
  if (!rig) return null;
  const g = piece.model.group;
  g.updateWorldMatrix(true, false);
  const anchor = g.localToWorld(rig.anchor.clone());
  _f.set(rig.forward.x, 0, rig.forward.z).transformDirection(g.matrixWorld);
  return {
    kind: 'cook', anchor, yaw: yawFromForward(_f.x, _f.z), camera: cookCameraOf(piece, rig, blockers),
    releaseOnInteract: false, furnitureUid: piece.item.uid,
  };
}

const isStrikeGame = (g: CookGame | null): boolean => g === 'chop' || g === 'mince' || g === 'stirfry';

/** The staging of a cook session. `FurnitureLayer` builds it only for our own ship (not while visiting one). */
export class CookStaging {
  /** The uid of the cook bench being staged, null when there is none. */
  uid: string | null = null;
  /** The current step's game (null when not cooking). */
  game: CookGame | null = null;
  /** The cook bench whose tools are sliding back to their rest spots now that cooking has ended. */
  private settleUid: string | null = null;
  /** The cook pose we raised is held right now (2026-09-14 — the minigame runs even when it could not be raised). */
  private held = false;
  private releasing = false;
  private readonly unsubs: Array<() => void> = [];
  private clock = 0;
  /** The accumulated hand phase · the target the inputs have piled up · the rate it chases that target (cycles / s). */
  private cycle = 0;
  private target = 0;
  private rate = 1 / FINISH_STROKE_S;
  private stirUntil = -1;
  private pouring = false;
  private level = BEAKER_IDLE_LEVEL;
  private liquid: CookLiquid | null = null;
  private stepIndex = -1;
  private hop = 1;
  private readonly pos: Record<CookTool, THREE.Vector3> = {
    board: new THREE.Vector3(), pot: new THREE.Vector3(), wok: new THREE.Vector3(), grill: new THREE.Vector3(), beaker: new THREE.Vector3(),
  };

  /** `find` = the current piece by uid, `blockers` = the boxes of the other furniture in the same room as that piece (camera occlusion). */
  constructor(private readonly ctx: GameContext, private readonly find: (uid: string) => StagedPiece | null, private readonly blockers: (uid: string) => readonly FootBox[] = () => []) {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:cookSession', (e) => this.onSession(e.uid, e.active)),
      b.on('housing:cookStep', (e) => this.onStep(e.uid, e.index, e.game, e.phase, e.auto)),
      b.on('housing:cookBeat', (e) => this.onBeat(e.uid, e.action)),
      b.on('player:furniturePoseEnded', (e) => {
        // the cook pose **we raised** was released without passing through us (a phase change · a spawn · the reset on hub:left) → take the minigame down too
        if (!this.uid || !this.held || this.releasing || e.kind !== 'cook') return;
        this.stop(false);
        this.cancelHousing();
      }),
    );
  }

  /** The current step's game (`BuildExtra.cookGame`) when this cook bench is the one cooking, else null. */
  gameFor(uid: string): CookGame | null {
    return uid === this.uid ? this.game : null;
  }

  /** Debug · smoke test: the cook bench being staged · the game · the accumulated phase · the tool out at the work spot. null when not cooking. */
  get stage(): { uid: string; game: CookGame | null; phase: number; atWork: CookTool | null } | null {
    if (!this.uid) return null;
    const rig = this.find(this.uid)?.model.cook;
    let atWork: CookTool | null = null;
    if (rig) for (const t of COOK_TOOLS) { const p = this.pos[t]; if (Math.hypot(p.x - rig.work.x, p.z - rig.work.z) < 0.02) atWork = t; }
    return { uid: this.uid, game: this.game, phase: this.cycle, atWork };
  }

  private onSession(uid: string, active: boolean): void {
    if (!active) { if (this.uid === uid) this.stop(true); return; }
    if (this.uid && this.uid !== uid) this.stop(true);
    const piece = this.find(uid);
    const rig = piece?.model.cook;
    // no cook-bench piece or no cook rig — the minigame runs on **without the staging only** (2026-09-14, user's decision)
    if (!piece || !rig) { this.held = false; return; }
    const fresh = this.uid !== uid;
    if (fresh) {
      // another cook bench still sliding back is snapped into place; the same cook bench carries on from where it was sliding
      if (this.settleUid && this.settleUid !== uid) { const other = this.find(this.settleUid)?.model.cook; if (other) restCookRig(other); }
      if (this.settleUid !== uid) for (const t of COOK_TOOLS) this.pos[t].copy(rig.tools[t].position);
      this.settleUid = null;
      this.uid = uid;
      this.stepIndex = -1; this.stirUntil = -1; this.pouring = false; this.hop = 1; this.liquid = null; this.level = BEAKER_IDLE_LEVEL;
      this.target = this.cycle;
      const s = this.ctx.housing?.cookSession;
      this.game = s && s.uid === uid ? (s.steps[0]?.game ?? null) : null;
    }
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function') return;   // player does not know poses yet — the minigame is left alone
    if (!fresh && this.held && p.furniturePose === 'cook') return; // the same session was announced again — raising it again would make the release return in front of the bench
    const pose = cookPoseOf(piece, this.blockers(uid));
    let ok = false;
    // a pose-ended notice that comes out of our own call (a rocking chair we were sitting in · the previous pose) is ours
    this.releasing = true;
    try { ok = pose !== null && p.setFurniturePose(pose); } catch (err) { console.warn('[hub] setFurniturePose(cook) failed', err); } finally { this.releasing = false; }
    // even when the pose is refused **the minigame runs** (2026-09-14, user's decision) — only the tool staging keeps running and the body stays standing
    this.held = ok;
    if (!ok) console.warn('[hub] 조리 자세를 걸지 못했다 — 연출 없이 미니게임만 진행한다');
  }

  private onStep(uid: string, index: number, game: CookGame, phase: 'choose' | 'play' | 'done', auto: boolean): void {
    if (uid !== this.uid) return;
    if (game !== this.game) {
      // moving into a beat game carries a half-turned hand to the end of its cycle, so the knife starts from up
      if (isStrikeGame(game)) { this.target = Math.max(this.target, Math.ceil(this.cycle - 1e-6)); this.rate = 1 / FINISH_STROKE_S; }
      this.game = game;
    }
    if (index !== this.stepIndex) {
      this.stepIndex = index;
      this.stirUntil = -1; this.pouring = false; this.hop = 1;
      const step = this.ctx.housing?.cookSession?.steps[index];
      this.liquid = step?.liquid ?? null;
      this.level = game === 'pour' ? POUR_START_LEVEL : BEAKER_IDLE_LEVEL;
    }
    if (phase === 'done') {
      this.stirUntil = -1; this.pouring = false;
      if (game === 'pour' && auto) this.level = POUR_AUTO_LEVEL;
    }
  }

  private onBeat(uid: string, action: CookBeatAction): void {
    if (uid !== this.uid) return;
    const s = STROKE_S[action];
    if (s !== undefined) {
      this.target = Math.max(this.target, Math.ceil(this.cycle - 1e-6)) + 1;
      this.rate = 1 / s;
      return;
    }
    if (action === 'stir') this.stirUntil = this.clock + STIR_HOLD_S;
    else if (action === 'pour_start') this.pouring = true;
    else if (action === 'pour_stop') this.pouring = false;
    else this.hop = 0;   // flip · remove · burn — the grill pan hops
  }

  /** Pushes the hand phase along — piled-up inputs → stirring → the slow sway, in that order. A beat game stops between inputs with the knife up. */
  private advance(dt: number): void {
    const game = this.game;
    let step = 0;
    if (this.cycle < this.target - 1e-6) {
      if (this.target - this.cycle > MAX_CYCLE_LAG) this.cycle = this.target - MAX_CYCLE_LAG;
      step = Math.min(this.target - this.cycle, dt * this.rate);
    } else if (game === 'stir') {
      if (this.clock < this.stirUntil) step = dt * STIR_REV_PER_S;
    } else if (!isStrikeGame(game)) {
      step = dt * SWAY_PER_S;
    }
    this.cycle += Math.min(step, MAX_CYCLE_STEP);
    if (this.target < this.cycle) this.target = this.cycle;
  }

  /** Every frame (`FurnitureLayer.update`). */
  update(dt: number): void {
    this.clock += dt;
    const uid = this.uid ?? this.settleUid;
    if (!uid) return;
    const rig = this.find(uid)?.model.cook;
    if (!rig) {
      if (this.uid) { this.stop(true); this.cancelHousing(); }   // the cook bench vanished mid-session
      else this.settleUid = null;
      return;
    }
    const game = this.uid ? this.game : null;
    if (this.uid) this.advance(dt);
    const k = 1 - Math.exp(-TOOL_RATE * dt);
    let settled = true;
    for (const t of COOK_TOOLS) {
      const tg = cookToolTarget(rig, t, game, _target);
      const p = this.pos[t];
      p.x += (tg.x - p.x) * k; p.y += (tg.y - p.y) * k; p.z += (tg.z - p.z) * k;
      const dist = Math.hypot(tg.x - p.x, tg.z - p.z);
      if (dist < TOOL_SETTLED) p.copy(tg); else settled = false;
      const grp = rig.tools[t];
      grp.position.set(p.x, p.y + Math.min(TOOL_ARC, dist * 0.6), p.z);
      grp.rotation.set(0, 0, 0);
    }
    const ph = frac(this.cycle);
    poseCookKnife(rig, game === 'chop' || game === 'mince', this.cycle);
    rig.ladle.rotation.y = game === 'stir' ? -TAU * ph : 0;
    if (game === 'stirfry') {
      const s = Math.sin(Math.PI * ph);
      rig.tools.wok.position.y += WOK_TOSS_LIFT * s;
      rig.tools.wok.rotation.z = -WOK_TOSS_TILT * s;
    }
    if (this.hop < 1) {
      this.hop = Math.min(1, this.hop + dt / GRILL_HOP_S);
      if (game === 'grill') rig.tools.grill.position.y += GRILL_HOP_LIFT * Math.sin(Math.PI * this.hop);
    }
    if (game === 'pour' && this.pouring) this.level = Math.min(POUR_MAX_LEVEL, this.level + dt * POUR_FILL_PER_S);
    rig.liquid.scale.y = Math.max(0.04, this.level);
    if (rig.liquidMesh && this.liquid) {
      const m = liquidMat(this.liquid);
      if (rig.liquidMesh.material !== m) rig.liquidMesh.material = m;
    }
    if (!this.uid) {
      if (settled) { restCookRig(rig); this.settleUid = null; }
      return;
    }
    const pl = this.ctx.player;
    if (pl && typeof pl.setFurniturePoseDrive === 'function' && pl.furniturePose === 'cook') {
      try { pl.setFurniturePoseDrive(ph); } catch { /* player mid-build */ }
    }
  }

  /** Takes the staging down (`update` slides the tools back to their rest spots). `release` = release the player pose too. */
  private stop(release: boolean): void {
    const uid = this.uid;
    this.uid = null;
    this.game = null;
    this.stepIndex = -1; this.stirUntil = -1; this.pouring = false; this.hop = 1;
    this.liquid = null; this.level = BEAKER_IDLE_LEVEL;
    this.settleUid = uid;
    const wasHeld = this.held;
    this.held = false;
    if (!release || !wasHeld) return;
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function' || p.furniturePose !== 'cook') return;
    this.releasing = true;
    try { p.setFurniturePose(null); } catch { /* player mid-build */ } finally { this.releasing = false; }
  }

  private cancelHousing(): void {
    const h = this.ctx.housing;
    if (h && typeof h.cancelCook === 'function') {
      try { h.cancelCook(); } catch (err) { console.warn('[hub] cancelCook failed', err); }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.uid) { this.stop(true); this.cancelHousing(); }
    const settle = this.settleUid;
    this.settleUid = null;
    const rig = settle ? this.find(settle)?.model.cook : undefined;
    if (rig) restCookRig(rig);
  }
}
