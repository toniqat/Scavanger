/**
 * src/player/parts/Climb.ts — **how the body moves vertically: ladders · step smoothing** (2026-09-11).
 *
 * Ladders: takes `ladder:grab` and hangs on (`grabLadder`), fills the input rules for while hanging on
 * (`readClimbInput` — W/S · sprint · jump · E), and emits `player:climbChanged {ladderId: null}` **exactly once**
 * whenever the ladder is released for any reason (`syncClimb` — it compares the controller's `climbLadder` with the
 * last value sent). The maths that moves the body is in `PlayerController.updateClimb`.
 *
 * Step smoothing: a **height that jumps within one frame** — a low rock · a crate edge · the ground snap — is
 * smoothed in the model only (`updateStepSmoothing` → `bodyOffset`). The physics position (collision · snapshots ·
 * enemy perception) moves at once, as before.
 */
import * as THREE from 'three';
import { Keys, STEP_SMOOTH_MAX, STEP_SMOOTH_RATE, type LadderDef } from '@/shared';
import { CLIMB_GRAB_OFFSET_MAX, STAMINA_JUMP_COST, STEP_SLOPE_RATIO, STEP_SMOOTH_MIN } from '../model';
import type { PlayerSystem } from '../PlayerSystem';

const _from = new THREE.Vector3();

/**
 * `ladder:grab` (world's ladder `Interactable` emits it on E). Ignored on death · downed · shouldering (either
 * side) · in a pod · the drop · controls off · the ship interior · the extraction ship · already hanging on. On a
 * grab the roll and aiming are released and the stance becomes stand.
 */
export function grabLadder(sys: PlayerSystem, ladder: LadderDef, from: 'bottom' | 'top'): boolean {
  const c = sys.controller;
  if (!ladder || c.climbing) return false;
  if (!sys.spawned || sys.isDead || sys._downed || !sys.controlsEnabled) return false;
  // 2026-09-11: `ladder:grab` is ignored during drone control
  if (sys._droneControl || sys._roverRide) return false;   // 2026-09-13: the rover too
  if (sys.furn.kind !== null) return false;   // 2026-09-12: during a furniture pose too (`parts/FurniturePose`)
  if (sys._carrying || sys.carriedSocket || sys.carryLock > 0 || sys._inPod) return false;
  if (sys._interior || sys.shipBounds || sys.attachedParent) return false;
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return false;
  _from.copy(c.position);
  c.startClimb(ladder, from === 'top' ? 'top' : 'bottom');
  // The physics position snaps onto the ladder; the model slides in from where it stood (the step-smoothing offset)
  sys.bodyOffset.add(_from.sub(c.position));
  if (sys.bodyOffset.length() > CLIMB_GRAB_OFFSET_MAX) sys.bodyOffset.setLength(CLIMB_GRAB_OFFSET_MAX);
  sys.setAiming(false);
  if (sys._stance !== 'stand') sys.setStance('stand');
  sys.standUpTimer = 0;
  sys._grappling = false;
  sys.setHovering(false);
  sys.cancelHold();
  syncClimb(sys);
  return true;
}

/** Releases the ladder for any reason (velocity untouched — it drops on the spot). A no-op when not hanging on. */
export function releaseLadder(sys: PlayerSystem): void {
  if (sys.controller.climbing) sys.controller.releaseClimb();
  syncClimb(sys);
}

/** Reset paths (revive · teleport · the ship · abort): releases the ladder and clears the offset · pose blend. */
export function clearClimbState(sys: PlayerSystem): void {
  releaseLadder(sys);
  sys.bodyOffset.set(0, 0, 0);
  sys.climbBlend = 0;
}

/** The one place `player:climbChanged` is emitted — only when the controller's state differs from the last sent. */
export function syncClimb(sys: PlayerSystem): void {
  const id = sys.controller.climbLadder ? sys.controller.climbLadder.id : null;
  if (id === sys.climbSent) return;
  sys.climbSent = id;
  sys.ctx?.bus.emit('player:climbChanged', { ladderId: id });
}

/**
 * Input while hanging on. All zero when not `active` (UI · controls off) or while mounting — the body just hangs
 * there. Sprinting **only with stamina left and not exhausted** (the drain is `Locomotion.updateStamina`'s, through
 * `climbFast`); a jump follows the same stamina · weight rules as a normal jump. E arrives only here, because
 * interaction is switched off (PlayerSystem).
 */
export function readClimbInput(sys: PlayerSystem, active: boolean): void {
  const inp = sys.climbInput, input = sys.ctx.input, c = sys.controller;
  inp.z = 0; inp.fast = false; inp.jump = false; inp.drop = false;
  if (!active || c.climbMount >= 0) return;
  inp.z = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
  inp.fast = inp.z !== 0 && input.isDown(Keys.SPRINT) && !sys.exhausted && sys.stamina > 0;
  if (input.wasPressed(Keys.JUMP)) {
    // 2026-09-12: the stimulant = ×1.5 on a one-off cost — the check too measures the amount `spendStamina`
    //   actually subtracts (the same as a normal jump · roll)
    if (sys.stamina >= STAMINA_JUMP_COST * sys.staminaCostMul && !sys.gear.overloaded) inp.jump = true;
    else sys.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
  }
  inp.drop = !inp.jump && input.wasPressed(Keys.INTERACT) && sys.interactCooldown <= 0;
}

/**
 * Step smoothing. Takes the spot · grounded flag from just before `c.update`; if the height changed **in a way that
 * looks like a step** between one grounded frame and the next, that much is stacked into `bodyOffset.y` the other
 * way. The whole offset (the XZ of a ladder grab included) then decays to 0 at `STEP_SMOOTH_RATE`. Riding · the
 * ladder · attached to a parent · being carried are skipped (that movement is continuous, or somebody else's).
 */
export function updateStepSmoothing(sys: PlayerSystem, dt: number, prevX: number, prevY: number, prevZ: number, wasGrounded: boolean): void {
  const c = sys.controller, o = sys.bodyOffset;
  if (wasGrounded && c.grounded && !c.riding && !c.climbing && !sys.attachedParent && !sys.carriedSocket) {
    const dy = c.position.y - prevY;
    const ady = Math.abs(dy);
    if (ady > STEP_SMOOTH_MIN && ady <= STEP_SMOOTH_MAX) {
      const run = Math.hypot(c.position.x - prevX, c.position.z - prevZ);
      if (ady > run * STEP_SLOPE_RATIO) o.y -= dy;
    }
  }
  if (o.x === 0 && o.y === 0 && o.z === 0) return;
  if (dt > 0) o.multiplyScalar(Math.exp(-STEP_SMOOTH_RATE * dt));
  if (Math.abs(o.y) > STEP_SMOOTH_MAX) o.y = Math.sign(o.y) * STEP_SMOOTH_MAX;
  if (o.lengthSq() < 1e-6) o.set(0, 0, 0);
}
