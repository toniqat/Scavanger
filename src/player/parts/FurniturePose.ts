/**
 * src/player/parts/FurniturePose.ts — **what the body does while furniture holds it** (2026-09-12, A-3a · A-3e).
 *
 * The implementation of `PlayerRef.setFurniturePose` / `furniturePose` / `setFurniturePoseDrive` (caller: hub — the
 * rocking chair · gym machines, contract: end of `shared/types.ts` · `player:furniturePoseEnded`). Decision:
 * `docs/DECISIONS.md` 「2026-09-12 — 헬스장 · 서재 매체」.
 *
 * - **In the ship only.** It is refused, changing nothing, while `ctx.phase !== 'hub'` · before spawn · dead ·
 *   downed · in drone control · on a ladder · in a pod · in the hellpod · being carried · shouldering · attached to
 *   a parent · in the extraction-ship box. The UI blocker (the gym screen) and `controlsEnabled` are not read — a
 *   gym session takes the pose with its screen open.
 * - **While posed**: movement · jump · the stance keys · roll · aim · weapons · shouldering · E interaction are gone.
 *   The controller does not run (no collision resolve) and the feet are pinned at `(anchor.x, the last foot height,
 *   anchor.z)` — so `position` is over the furniture while its height is the floor. The model root slides to `anchor`
 *   (a blend) and the body offsets are decided by `SoldierModel.poseFurniture` relative to the anchor.
 * - With `releaseOnInteract` E is the release (`interact`) — it `consume`s the key and raises the interaction
 *   cooldown so the same press does not hit the furniture prompt again. While seated the caption is only `일어나기`.
 * - With a `camera` it **blends** through `rig.setOverride(pos, look)` and mouse look is not fed into the rig. On
 *   release the override is taken down **only while it is still ours** (`CameraRig.overrideMatches` — left alone when
 *   the docking cutscene has taken it since).
 * - **On release** the feet and the stance return to their previous values at once while the body yaw · the model
 *   blend back. `reset` is immediate down to the model.
 * - 2026-09-12 (character buffs): it keeps the `furnitureUid` and publishes `furniturePoseState` (the wire shape, the
 *   **accumulated phase**). Standing up or a release makes the buff list gather again (`buffsDirty`). The formulas of
 *   the blend · the root · the body yaw · writing the `SoldierPose` are shared functions in `model.ts` —
 *   `RemoteAvatar` draws a remote pose with the same ones.
 */
import { Keys, type FurniturePose, type FurniturePoseKind, type FurniturePoseState as FurniturePoseWire } from '@/shared';
import { dampAngle } from '@/core/util/MathUtil';
import type { SoldierPose } from '../SoldierModel';
import {
  FURN_BENCH_REP_S, FURN_COOK_CYCLE_PER_S, FURN_CYCLE_REV_PER_S, FURN_EYE, FURN_RUN_STEPS_PER_S, FURN_STAND_PROMPT, FURN_YAW_RATE, _up,
  furnitureBodyYaw, lerpFurnitureRoot, stepFurnitureBlend, writeFurniturePose,
} from '../model';
import type { PlayerSystem } from '../PlayerSystem';

export type FurniturePoseEndReason = 'interact' | 'caller' | 'reset';

/** 2026-09-13: `cook` = standing at the cook bench working the hands (anchor = the floor, the body geometry is in
 * `SoldierModel.FURN_COOK`). */
const KINDS: readonly FurniturePoseKind[] = ['sit', 'bench', 'run', 'cycle', 'cook'];
/** The poses whose phase wraps and counts cycles — the accumulated phase on the wire is `steps + phase`. */
const isCountingKind = (k: FurniturePoseKind | null): boolean => k === 'run' || k === 'cycle' || k === 'cook';
const TAU = Math.PI * 2;
/** The shape a furniture uid is kept in — the same character set as the buff · wire check (`sanitizeCharBuffs`). */
const UID_RE = /^[A-Za-z0-9_:\-.]{1,64}$/;

const finite3 = (v: { x: number; y: number; z: number } | null | undefined): boolean =>
  !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** May the pose still be **held**. Once it goes false the top-of-`update` backstop releases it with `reset`. */
export function canHoldFurniturePose(sys: PlayerSystem): boolean {
  if (!sys.spawned || sys.isDead || sys._downed) return false;
  if (!sys.ctx || sys.ctx.phase !== 'hub') return false;
  if (sys._droneControl || sys.controller.climbing || sys._inPod) return false;
  if (sys.carriedSocket !== null || sys.attachedParent !== null || sys.shipBounds !== null) return false;
  return !(sys.hellpod.isActive && sys.hellpod.state !== 'exiting');
}

export function setFurniturePose(sys: PlayerSystem, pose: FurniturePose | null): boolean {
  if (!pose) { releaseFurniturePose(sys, 'caller'); return true; }
  if (!KINDS.includes(pose.kind) || !finite3(pose.anchor) || !Number.isFinite(pose.yaw)) return false;
  if (pose.camera && (!finite3(pose.camera.position) || !finite3(pose.camera.lookAt))) return false;
  if (!canHoldFurniturePose(sys) || sys._carrying || sys.carryLock > 0) return false;

  const f = sys.furn, c = sys.controller;
  if (f.kind === null) {
    // First time in: note the spot to return to and cut off every action in progress
    f.restorePos.copy(c.position);
    f.restoreYaw = sys.bodyYaw;
    f.restoreStance = sys._stance;
    sys.setAiming(false);
    sys.cancelHold();
    if (c.rolling) c.cancelRoll();
    sys.setGrappleTarget(null);
    sys.setHovering(false);
    sys.meleeTimer = 0;
    if (c.sprinting) { c.sprinting = false; sys.ctx.bus.emit('player:sprintChanged', { sprinting: false }); }
    if (sys._stance !== 'stand') sys.setStance('stand');
    sys.standUpTimer = 0;
    f.driven = false; f.phase = 0; f.steps = 0; f.clock = 0;
  } else if (f.kind !== pose.kind) {
    // Moved straight onto another machine: the spot to return to stays the first one, only the phase is new
    f.driven = false; f.phase = 0; f.steps = 0; f.clock = 0;
  }
  f.kind = pose.kind;
  f.visKind = pose.kind;
  f.releaseOnInteract = !!pose.releaseOnInteract;
  f.anchor.copy(pose.anchor);
  f.yaw = pose.yaw;
  f.furnitureUid = typeof pose.furnitureUid === 'string' && UID_RE.test(pose.furnitureUid) ? pose.furnitureUid : null;
  if (pose.camera) {
    f.hasCamera = true;
    f.camPos.copy(pose.camera.position);
    f.camLook.copy(pose.camera.lookAt);
    sys.rig.setOverride(f.camPos, f.camLook);   // blend in (damp 12) — consumed in this system's lateUpdate
  } else {
    releaseCamera(sys);
  }
  pinBody(sys);
  sys.buffsDirty = true;   // 2026-09-12: the `rest` / `exercise` buffs
  return true;
}

/**
 * Releases the pose (nothing to do without one). The feet · the stance return to their previous values at once; the
 * body yaw · the model blend back on `interact` · `caller` and are immediate on `reset` (so an old pose does not leak
 * out after a spawn · a phase change). `player:furniturePoseEnded {kind, reason}` goes out from this one place only.
 */
export function releaseFurniturePose(sys: PlayerSystem, reason: FurniturePoseEndReason): void {
  const f = sys.furn;
  const kind = f.kind;
  if (kind === null) return;
  f.kind = null;
  f.furnitureUid = null;
  sys.buffsDirty = true;
  const c = sys.controller;
  c.position.copy(f.restorePos);
  c.velocity.set(0, 0, 0);
  c.grounded = true;
  c.speed = 0;
  releaseCamera(sys);
  if (sys._stance !== f.restoreStance && !sys.isDead && !sys._downed) sys.setStance(f.restoreStance);
  sys.standUpTimer = 0;
  // So the same frame's E does not hit the furniture just stood up from (or another one beside it) again
  sys.interactCooldown = Math.max(sys.interactCooldown, 0.35);
  if (reason === 'reset') {
    f.visKind = null;
    f.blend = 0;
    sys.bodyYaw = f.restoreYaw;
    sys.model.resetPose();
    sys.model.root.position.copy(c.position);
    sys.model.root.quaternion.setFromAxisAngle(_up, sys.bodyYaw);
  }
  sys.ctx.bus.emit('player:furniturePoseEnded', { kind, reason });
}

/** Phase 0 … 1 (`bench` is clamped, `run` · `cycle` · `cook` wrap). Ignored when there is no pose. */
export function setFurniturePoseDrive(sys: PlayerSystem, phase: number): void {
  const f = sys.furn;
  if (f.kind === null || !Number.isFinite(phase)) return;
  f.driven = true;
  writePhase(f, phase);
}

function writePhase(f: PlayerSystem['furn'], phase: number): void {
  if (f.kind === 'bench' || f.kind === 'sit') { f.phase = Math.min(1, Math.max(0, phase)); return; }
  const p = phase - Math.floor(phase);
  // A wrap from 1 → 0 means a stride / a turn has passed (the other way goes back). The left / right foot of `run`
  // is decided by the parity of the stride count; since 2026-09-12 `cycle` counts its turns too — the accumulated
  // phase on the wire (`steps + phase`) must not wrap, so that the receiving side can interpolate.
  if (p < f.phase - 0.5) f.steps++;
  else if (p > f.phase + 0.5) f.steps--;
  f.phase = p;
}

/** The accumulated phase (the wire contract): bench 0 … 1 · run the stride count · cycle the number of crank turns ·
 * cook the number of hand cycles · sit 0. 0 when there is no pose. */
export function cumulativePhase(sys: PlayerSystem): number {
  const f = sys.furn;
  if (f.kind === 'bench') return f.phase;
  if (isCountingKind(f.kind)) return f.steps + f.phase;
  return 0;
}

/** `PlayerRef.furniturePoseState` — fills and returns a reused object (net reads it at 20 Hz). Null with no pose. */
export function poseWireState(sys: PlayerSystem): FurniturePoseWire | null {
  const f = sys.furn;
  if (f.kind === null) return null;
  const w = f.wire;
  w.kind = f.kind;
  w.yaw = f.yaw;
  w.phase = cumulativePhase(sys);
  w.furnitureUid = f.furnitureUid;
  return w;
}

/** Takes the camera override down with a blend, but only while it is still ours. */
function releaseCamera(sys: PlayerSystem): void {
  const f = sys.furn;
  if (!f.hasCamera) return;
  f.hasCamera = false;
  if (sys.rig && sys.rig.overrideMatches(f.camPos)) sys.rig.setOverride(null);
}

/** Pins the feet over the furniture (at the previous floor height) — the controller does not run while posed. */
function pinBody(sys: PlayerSystem): void {
  const f = sys.furn, c = sys.controller;
  c.position.set(f.anchor.x, f.restorePos.y, f.anchor.z);
  c.velocity.set(0, 0, 0);
  c.grounded = true;
  c.speed = 0;
  c.sprinting = false;
}

/**
 * The pose branch of `update` (input is already 0): the self-running phase · pinning the feet · standing up with E.
 * `active` = able to act (no blocker · alive). It is false while the gym screen is open, so E is not read either.
 */
export function updateFurniturePose(sys: PlayerSystem, dt: number, active: boolean): void {
  const f = sys.furn;
  if (f.kind === null) return;
  f.clock += dt;
  if (!f.driven) {
    if (f.kind === 'bench') f.phase = 0.5 - 0.5 * Math.cos(TAU * f.clock / FURN_BENCH_REP_S);
    else if (f.kind === 'run') writePhase(f, f.phase + dt * FURN_RUN_STEPS_PER_S);
    else if (f.kind === 'cycle') writePhase(f, f.phase + dt * FURN_CYCLE_REV_PER_S);
    else if (f.kind === 'cook') writePhase(f, f.phase + dt * FURN_COOK_CYCLE_PER_S);   // 2026-09-13: slow knife work
  }
  pinBody(sys);
  const input = sys.ctx.input;
  if (f.releaseOnInteract && active && input.wasPressed(Keys.INTERACT)) {
    input.consume(Keys.INTERACT);
    releaseFurniturePose(sys, 'interact');
  }
}

/**
 * The interaction caption while posed: the target held and the hold are dropped, and with `releaseOnInteract` only
 * `일어나기` is shown (called instead of `parts/Interact.updateInteraction`).
 */
export function updatePosePrompt(sys: PlayerSystem, active: boolean): void {
  if (sys.interactTarget) { sys.cancelHold(); sys.interactTarget = null; }
  sys.holdProgress = 0;
  const f = sys.furn;
  const text = f.kind !== null && f.releaseOnInteract && active ? FURN_STAND_PROMPT : null;
  if (text !== sys.lastPromptText || sys.lastHoldProgress !== 0) {
    sys.lastPromptText = text; sys.lastHoldProgress = 0;
    sys.ctx.bus.emit('interact:promptChanged', { text, holdProgress: 0, hold: false });
  }
}

/** The pose blend damping. Once the blend has run out after a release, the model side forgets the pose too. */
export function updatePoseBlend(sys: PlayerSystem, dt: number): void {
  const f = sys.furn;
  if (f.visKind === null) return;
  f.blend = stepFurnitureBlend(f.blend, f.kind !== null, dt);
  if (f.kind === null && f.blend < 0.005) { f.blend = 0; f.visKind = null; }
}

/** The eye (camera pivot) height while posed — measured from the feet (the floor). Null when there is no pose. */
export function poseEyeHeight(sys: PlayerSystem): number | null {
  const f = sys.furn;
  if (f.kind === null) return null;
  return f.anchor.y - f.restorePos.y + FURN_EYE[f.kind];
}

/**
 * The body yaw. While posed it turns to the target (`bench` lies head → rack, so the feet point the other way =
 * `yaw + π`) and returns true. While blending out after a release it turns to the previous yaw but returns false, so
 * that the usual rules (movement direction · aim) go on to overwrite it.
 */
export function updatePoseYaw(sys: PlayerSystem, dt: number): boolean {
  const f = sys.furn;
  if (f.kind !== null) {
    sys.bodyYaw = dampAngle(sys.bodyYaw, furnitureBodyYaw(f.kind, f.yaw), FURN_YAW_RATE, dt);
    return true;
  }
  if (f.visKind !== null) sys.bodyYaw = dampAngle(sys.bodyYaw, f.restoreYaw, FURN_YAW_RATE, dt);
  return false;
}

/** The model pose parameters. `run` feeds the stride phase into the walk cycle; `SoldierModel.poseFurniture` takes
 * the skeleton for the other three. */
export function applyPoseToSoldier(sys: PlayerSystem, p: SoldierPose): void {
  const f = sys.furn;
  const kind = f.visKind;
  // The last phase is still drawn after a release (blending out) — with a null kind it is computed from visKind
  const cum = isCountingKind(kind) ? f.steps + f.phase : kind === 'bench' ? f.phase : 0;
  writeFurniturePose(p, kind, kind !== null ? f.blend : 0, cum);
}

/**
 * Writes the model root: a blend from the previous spot (the current feet after a release) to `anchor`. False when no
 * pose is being drawn — the caller then writes it as usual.
 */
export function placeRoot(sys: PlayerSystem): boolean {
  const f = sys.furn;
  if (f.visKind === null) return false;
  const root = sys.model.root;
  root.position.copy(f.kind !== null ? f.restorePos : sys.controller.position).add(sys.bodyOffset);
  lerpFurnitureRoot(root.position, f.anchor, f.blend);
  root.quaternion.setFromAxisAngle(_up, sys.bodyYaw);
  return true;
}
