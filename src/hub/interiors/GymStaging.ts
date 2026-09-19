import * as THREE from 'three';
import type { FurniturePose, FurniturePoseKind, GameContext, PlacedFurniture } from '@/shared';
import { GYM_CYCLE_BEAT_S } from '@/shared';
import { yawFromForward } from './GeoBatch';
import { roomBox } from './RoomLayout';
import type { FurnitureModel } from './Furniture';
import type { FurnitureRig } from './FurnitureLeisure';

/* ────────────────────────────────────────────────────────────────────────────
 * Furniture pose staging (A-3e the rocking chair · A-3a the gym, 2026-09-12).
 *
 * Resolves `FurnitureRig` (furniture-local coordinates) into world space for `PlayerRef.setFurniturePose`, and during a gym
 * session runs the machine's moving parts and the body's motion phase (`setFurniturePoseDrive`) off the **same value** — so barbell height · belt · crank never drift from arms · stride · knees.
 *
 *   housing:gymSession {active:true}  → plates shown · pose anchor/yaw · side fixed camera → setFurniturePose (false → cancelGymSession)
 *   housing:gymBeat                   → bench: perfect/good = one rep (down and back up), miss = pushed halfway, held, then up
 *                                        treadmill: a miss drops the pace for a moment · cycle: half a crank turn per beat
 *   housing:gymSession {active:false} → plates hidden · bar back on the rack · setFurniturePose(null)
 *   player:furniturePoseEnded (reset) → the session is cancelled too (so no minigame is left without a pose)
 *
 * A piece is always re-found with `find(uid)` — a room rebuild (`housing:changed` and friends) swaps the model group.
 * Whether the plates show is carried onto the new model by `BuildExtra.gymActive`.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface StagedPiece { item: PlacedFurniture; model: FurnitureModel }

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();

/**
 * Treadmill stride rate (strides / s — player's `run` phase 0 → 1 is **one stride**, the next foot every cycle) · the belt's
 * flow speed (m/s). 2.8 strides/s × a 0.86 m stride ≈ 2.4 m/s, so the feet never look like they slide. Presentation numbers, not csv numbers.
 */
const RUN_STRIDE_HZ = 2.8;
const RUN_BELT_SPEED = 2.4;
/**
 * How far the belt flows in one stride (m) — `RUN_BELT_SPEED / RUN_STRIDE_HZ`. The remote staging (`RemoteFurnitureStaging`)
 * moves the belt by the difference in cumulative strides rather than by time, so it needs this value to keep the local ratio.
 */
export const RUN_STRIDE_LENGTH = RUN_BELT_SPEED / RUN_STRIDE_HZ;
/** Bench · smith: how long the bar takes to travel from the rack to over the chest (s). */
export const UNRACK_S = 0.6;
/** The rocking chair: the rock while someone sits in it (rad · rad/s). */
const ROCK_AMPLITUDE = 0.04;
const ROCK_RATE = 1.6;
/** How far the side camera must stay off a room wall (m). 2026-09-13: the cook-bench camera (`CookStaging`) uses the same value. */
export const CAMERA_WALL_MARGIN = 0.45;

/** A piece's pose reference point in world space: the anchor, and the yaw in the player's convention (forward = (−sin, −cos)). */
export function worldPoseOf(piece: StagedPiece, rig: FurnitureRig): { anchor: THREE.Vector3; yaw: number } {
  const g = piece.model.group;
  g.updateWorldMatrix(true, false);
  const anchor = g.localToWorld(rig.anchor.clone());
  _f.set(rig.forward.x, 0, rig.forward.z).transformDirection(g.matrixWorld);
  return { anchor, yaw: yawFromForward(_f.x, _f.z) };
}

/**
 * The sitting pose (no camera · E stands up again) — the rocking chair · chair · sofa. null when the piece is not a sitting one.
 * 2026-09-13: with several `rig.seats` (the sofa's cushions) the seat closest to `near` (world — the player's feet, or the TV screen in a game session) is taken.
 */
export function sitPoseOf(piece: StagedPiece, near?: THREE.Vector3 | null): FurniturePose | null {
  const rig = piece.model.rig;
  if (!rig || rig.pose !== 'sit') return null;
  const { anchor, yaw } = worldPoseOf(piece, rig);
  if (near && rig.seats && rig.seats.length > 1) {
    const g = piece.model.group;   // worldPoseOf already updated the matrix
    let best = Infinity;
    for (const s of rig.seats) {
      g.localToWorld(_v.copy(s));
      const dd = (_v.x - near.x) ** 2 + (_v.z - near.z) ** 2;
      if (dd < best) { best = dd; anchor.copy(_v); }
    }
  }
  // furnitureUid (2026-09-12, character buffs · furniture pose sync): the visitor's hub rocks the same chair by this uid
  return { kind: 'sit', anchor, yaw, camera: null, releaseOnInteract: true, furnitureUid: piece.item.uid };
}

/** The world box one other piece of furniture in the room occupies (the dimensions of its collider blocker). Used for the camera occlusion test. */
export interface FootBox { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

/** Does the segment p → q pass through the box (a slab test). Run once at session start, so allocation does not matter. 2026-09-13: the cook-bench camera uses it too. */
export function segmentHits(p: THREE.Vector3, q: THREE.Vector3, b: FootBox): boolean {
  let t0 = 0, t1 = 1;
  const axes: ReadonlyArray<readonly [number, number, number, number]> = [
    [p.x, q.x - p.x, b.minX, b.maxX], [p.y, q.y - p.y, b.minY, b.maxY], [p.z, q.z - p.z, b.minZ, b.maxZ],
  ];
  for (const [o, dd, lo, hi] of axes) {
    if (Math.abs(dd) < 1e-9) { if (o < lo || o > hi) return false; continue; }
    let ta = (lo - o) / dd, tb = (hi - o) / dd;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * The gym machine's fixed camera. Candidates — 12 bearings around the machine × two distances (D · 0.8 D) × two heights (base ·
 * +0.8 m) — are picked by score: **the more side-on**, the lower and the further, the better; leaving the room box (inside
 * `CAMERA_WALL_MARGIN` of a wall), or a line to the body · focus crossing another piece's box in the room (`blockers`), costs a
 * lot. Auto placement lines gym machines along a wall 1.5 – 2 m apart, so "side-on" is often inside the neighbour (the first version took the first of side · diagonal that fell inside the room, and the camera shot from inside the next smith machine's frame).
 */
export function gymCameraOf(piece: StagedPiece, rig: FurnitureRig, blockers: readonly FootBox[] = []): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  const g = piece.model.group;
  g.updateWorldMatrix(true, false);
  const focusLocal = rig.focus ?? rig.anchor;
  const lookAt = g.localToWorld(focusLocal.clone());
  const body = g.localToWorld(rig.anchor.clone());
  body.y += 0.35;
  const D = rig.camDist ?? 2.8, up = rig.camUp ?? 0.5;
  const box = roomBox(piece.item.room);
  const p = new THREE.Vector3();
  let best: THREE.Vector3 | null = null, bestCost = Infinity;
  for (const lift of [0, 0.8]) {
    for (const dist of [D, D * 0.8]) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;                                   // 0 = the local −X side, π = the +X side, ±π/2 = front · back
        p.set(focusLocal.x - Math.cos(a) * dist, focusLocal.y + up + lift, focusLocal.z + Math.sin(a) * dist);
        g.localToWorld(p);
        let cost = (1 - Math.abs(Math.cos(a))) * 0.8 + lift * 0.4 + (dist < D ? 0.15 : 0);
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
        for (const b of blockers) {
          if (segmentHits(p, lookAt, b)) cost += 3;
          if (segmentHits(p, body, b)) cost += 3;
        }
        if (cost < bestCost) { bestCost = cost; best = (best ?? new THREE.Vector3()).copy(p); }
      }
    }
  }
  return { position: best ?? lookAt.clone().add(_v.set(0, up, D)), lookAt };
}

/** One gym pose (anchor · yaw · fixed camera). `blockers` = the boxes of the other furniture in the room (camera occlusion test). */
export function gymPoseOf(piece: StagedPiece, blockers: readonly FootBox[] = []): FurniturePose | null {
  const rig = piece.model.rig;
  if (!rig || rig.pose === 'sit') return null;
  const { anchor, yaw } = worldPoseOf(piece, rig);
  return { kind: rig.pose, anchor, yaw, camera: gymCameraOf(piece, rig, blockers), releaseOnInteract: false, furnitureUid: piece.item.uid };
}

/* ── One machine pose — local `GymStaging` and remote `RemoteFurnitureStaging` use the same formulas (2026-09-12) ──── */

/**
 * The bench · smith bar. `unrack` = progress along the rack → press path (0 … 1, smoothstepped here), `phase` = the press phase
 * (0 = chest · 1 = arms fully extended, the same **linear** interpolation as player's fist path). A rig with no bar · path is left alone.
 */
export function poseBenchBar(rig: FurnitureRig, unrack: number, phase: number): void {
  if (!rig.bar || !rig.barRest || !rig.barPress) return;
  const u = smooth(unrack);
  const lo = rig.barPress.low, hi = rig.barPress.high;
  const pressY = lo.y + (hi.y - lo.y) * phase, pressZ = lo.z + (hi.z - lo.z) * phase;
  rig.bar.position.set(0, rig.barRest.y + (pressY - rig.barRest.y) * u, rig.barRest.z + (pressZ - rig.barRest.z) * u);
}

/** Moves the treadmill belt stripes by `offset` (m, wrapped at the stripe spacing). Negative values wrap too. */
export function poseBelt(rig: FurnitureRig, offset: number): number {
  const s = rig.beltSpacing;
  if (!rig.belt || !s) return offset;
  const wrapped = ((offset % s) + s) % s;
  rig.belt.position.z = wrapped;
  return wrapped;
}

/**
 * Puts the cycle's crank · pedals · flywheel at `revolutions` turns. The crank repeats every turn and the flywheel (×2.4) every
 * five, so both are wrapped at that period — the rotation keeps its precision however large the cumulative count grows (the visible position is the unwrapped one).
 */
export function poseCrank(rig: FurnitureRig, revolutions: number): void {
  const ang = -Math.PI * 2 * frac(revolutions);
  if (rig.crank) rig.crank.rotation.x = ang;
  if (rig.pedals) for (const pd of rig.pedals) pd.rotation.x = -ang;
  if (rig.flywheel) rig.flywheel.rotation.x = -Math.PI * 2 * (((revolutions % 5) + 5) % 5) * 2.4;
}

/** The rocking chair's rock (`time` = `ctx.time`). */
export function poseRock(rig: FurnitureRig, time: number): void {
  if (rig.rock) rig.rock.rotation.x = Math.sin(time * ROCK_RATE) * ROCK_AMPLITUDE;
}

/** Back to rest: plates hidden · bar on the rack · rocking chair stopped (the belt · crank stay where they are — as at the end of a local session). */
export function restRig(rig: FurnitureRig): void {
  if (rig.plates) rig.plates.visible = false;
  if (rig.bar && rig.barRest) rig.bar.position.set(0, rig.barRest.y, rig.barRest.z);
  if (rig.rock) rig.rock.rotation.x = 0;
}

/** Joins keyframes (time, value) with a smoothstep. */
function sampleKeys(keys: ReadonlyArray<readonly [number, number]>, t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t <= t1) {
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      return v0 + (v1 - v0) * u * u * (3 - 2 * u);
    }
  }
  return keys[keys.length - 1][1];
}
const smooth = (u: number): number => { const c = THREE.MathUtils.clamp(u, 0, 1); return c * c * (3 - 2 * c); };
const frac = (x: number): number => x - Math.floor(x);

/** Gym-session staging. `FurnitureLayer` creates it only for the own ship (never while visiting). */
export class GymStaging {
  /** The uid of the gym machine being staged, null with none. */
  uid: string | null = null;
  private kind: FurniturePoseKind | null = null;
  private releasing = false;
  private unsubs: Array<() => void> = [];
  // bench
  private unrack = 0;
  private barPhase = 1;
  private rep: { t: number; keys: Array<[number, number]>; miss: boolean } | null = null;
  // treadmill
  private running = false;
  private pace = 0;
  private dipLeft = 0;
  private stride = 0;
  private beltOffset = 0;
  // cycle
  private crank = 0;
  private beatIndex = -1;
  private sinceBeat = 0;
  private lastHit = true;

  /**
   * `find` = the piece for a uid right now (it changes when the room is rebuilt), `blockers` = the boxes of the other furniture in its room (camera occlusion).
   */
  constructor(private readonly ctx: GameContext, private readonly find: (uid: string) => StagedPiece | null, private readonly blockers: (uid: string) => readonly FootBox[] = () => []) {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:gymSession', (e) => this.onSession(e.uid, e.active)),
      b.on('housing:gymBeat', (e) => this.onBeat(e.uid, e.quality, e.index)),
      b.on('player:furniturePoseEnded', (e) => {
        // the pose was released mid-session without going through this class (phase change · spawn · hub:left) → drop the minigame too
        if (!this.uid || this.releasing || e.kind === 'sit') return;
        this.stop(false);
        this.cancelHousing();
      }),
    );
  }

  /** The motion phase (0 … 1) — null outside a session. For debug · smokes. */
  get drivePhase(): number | null {
    if (!this.uid) return null;
    return this.kind === 'bench' ? this.barPhase : this.kind === 'run' ? this.stride : frac(this.crank);
  }

  private onSession(uid: string, active: boolean): void {
    if (!active) { if (this.uid === uid) this.stop(true); return; }
    if (this.uid && this.uid !== uid) this.stop(true);
    const piece = this.find(uid);
    const rig = piece?.model.rig;
    if (!piece || !rig || rig.pose === 'sit') { this.cancelHousing(); return; }
    this.uid = uid;
    this.kind = rig.pose;
    this.unrack = 0; this.barPhase = 1; this.rep = null;
    this.running = false; this.pace = 0; this.dipLeft = 0; this.stride = 0;
    this.beatIndex = -1; this.sinceBeat = 0; this.lastHit = true;
    if (rig.plates) rig.plates.visible = true;
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function') return;   // player does not know poses yet — the minigame is left alone
    const pose = gymPoseOf(piece, this.blockers(uid));
    let ok = false;
    try { ok = pose !== null && p.setFurniturePose(pose); } catch (err) { console.warn('[hub] setFurniturePose failed', err); }
    if (!ok) { this.stop(false); this.cancelHousing(); }
  }

  private onBeat(uid: string, quality: 'perfect' | 'good' | 'miss', index: number): void {
    if (uid !== this.uid) return;
    const miss = quality === 'miss';
    if (this.kind === 'bench') {
      const cur = this.barPhase;
      this.rep = miss
        ? { t: 0, miss, keys: [[0, cur], [0.4, 0], [0.9, 0.42], [1.25, 0.3], [1.95, 1]] }
        : { t: 0, miss, keys: [[0, cur], [0.45, 0], [1.0, 1]] };
    } else if (this.kind === 'run') {
      this.running = true;
      this.dipLeft = miss ? 1.2 : 0;
    } else if (this.kind === 'cycle') {
      if (index > this.beatIndex) this.beatIndex = index;
      this.sinceBeat = 0;
      this.lastHit = !miss;
    }
  }

  /** Every frame (`FurnitureLayer.update`). */
  update(dt: number): void {
    if (!this.uid) return;
    const piece = this.find(this.uid);
    const rig = piece?.model.rig;
    if (!piece || !rig) { this.stop(true); this.cancelHousing(); return; }   // the machine disappeared mid-session
    let drive = 0;
    if (this.kind === 'bench' && rig.bar && rig.barRest && rig.barPress) {
      this.unrack = Math.min(1, this.unrack + dt / UNRACK_S);
      if (this.rep) {
        this.rep.t += dt;
        const keys = this.rep.keys;
        let v = sampleKeys(keys, this.rep.t);
        if (this.rep.miss && this.rep.t > 0.9 && this.rep.t < 1.25) v += Math.sin(this.rep.t * 60) * 0.02;   // the strain shake
        this.barPhase = THREE.MathUtils.clamp(v, 0, 1);
        if (this.rep.t >= keys[keys.length - 1][0]) { this.rep = null; this.barPhase = 1; }
      }
      // the same linear interpolation as player's fist path (phase 0 = chest · 1 = arms fully extended) — the same function as the remote staging
      poseBenchBar(rig, this.unrack, this.barPhase);
      drive = this.barPhase;
    } else if (this.kind === 'run') {
      if (this.dipLeft > 0) this.dipLeft = Math.max(0, this.dipLeft - dt);
      const target = !this.running ? 0 : this.dipLeft > 0 ? 0.5 : 1;
      this.pace += (target - this.pace) * Math.min(1, dt * 2.5);
      this.stride = frac(this.stride + dt * RUN_STRIDE_HZ * this.pace);
      this.beltOffset = poseBelt(rig, this.beltOffset + dt * RUN_BELT_SPEED * this.pace);
      drive = this.stride;
    } else if (this.kind === 'cycle') {
      this.sinceBeat += dt;
      if (this.beatIndex >= 0) {
        // at beat i the crank starts at i/2 turns and covers half a turn by the next beat — pedalling on time keeps it seamless
        const push = Math.min(this.sinceBeat / GYM_CYCLE_BEAT_S, 1) * 0.5 * (this.lastHit ? 1 : 0.35);
        const desired = Math.max(this.crank, this.beatIndex * 0.5 + push);
        this.crank += (desired - this.crank) * Math.min(1, dt * 12);
      }
      poseCrank(rig, this.crank);
      drive = frac(this.crank);
    }
    const p = this.ctx.player;
    if (p && typeof p.setFurniturePoseDrive === 'function' && p.furniturePose === this.kind) {
      try { p.setFurniturePoseDrive(drive); } catch { /* player mid-build */ }
    }
  }

  /** Take the staging down: hide the plates and put the bar back on the rack. `release` = release the player pose too. */
  private stop(release: boolean): void {
    const uid = this.uid;
    this.uid = null;
    this.kind = null;
    this.rep = null;
    const rig = uid ? this.find(uid)?.model.rig : undefined;
    if (rig) restRig(rig);
    if (!release) return;
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function' || p.furniturePose === 'sit') return;
    this.releasing = true;
    try { p.setFurniturePose(null); } catch { /* player mid-build */ } finally { this.releasing = false; }
  }

  private cancelHousing(): void {
    const h = this.ctx.housing;
    if (h && typeof h.cancelGymSession === 'function') {
      try { h.cancelGymSession(); } catch (err) { console.warn('[hub] cancelGymSession failed', err); }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.uid) { this.stop(true); this.cancelHousing(); }
  }
}
