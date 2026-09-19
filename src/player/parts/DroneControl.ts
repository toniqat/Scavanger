/**
 * src/player/parts/DroneControl.ts — **what the body does while looking through a drone** (2026-09-11).
 *
 * The implementation of `PlayerRef.setDroneControl` (caller: `gadgets/drones/DroneSystem`, contract:
 * `shared/types.ts` · `shared/drones.ts`). While it is on the body crouches on the spot and stops — movement · jump ·
 * stance · roll · sprint · aim · E interaction · shouldering · ladders · weapons (`canUseWeapons`) are gone, and
 * mouse look is not fed into the camera rig (the input belongs to the drone). The camera is handed over by the drone
 * every frame with `setCameraOverride(pos, look, true)`; while `setDroneView` is on the rig does not mix the body's
 * shake · FOV additions into the drone view. Damage still lands — cutting the control off is done by the drone side
 * watching `player:damaged`.
 *
 * **Stance**: standing goes down to crouch and is put back to standing on release. **Prone is left prone** — prone is
 * lower than crouch (the eye height in the enemies' `Targets`), so it already meets the purpose of staying hidden,
 * and forcing a crouch would make the body rise once and then go prone again on release, riding the `STAND_UP_TIME`
 * transition twice.
 */
import type { PlayerSystem } from '../PlayerSystem';

/** May the control **start** now. A refusal is silent — `droneControl` stays false for the drone side to see. */
export function canEnterDroneControl(sys: PlayerSystem): boolean {
  // 2026-09-12: refused while a furniture pose is held
  return canHoldDroneControl(sys) && sys.carryLock <= 0 && sys.furn.kind === null;
}

/** May the control still be **held**. The top-of-`update` backstop releases it once the body is no longer free. */
export function canHoldDroneControl(sys: PlayerSystem): boolean {
  const c = sys.controller;
  if (!sys.spawned || sys.isDead || sys._downed || !sys.controlsEnabled) return false;
  if (sys._inPod || sys.carriedSocket !== null || c.climbing) return false;
  if (sys._roverRide !== null) return false;   // 2026-09-13: no drone control from inside the rover
  if (sys.attachedParent !== null || sys.shipBounds !== null || sys._interior !== null) return false;
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return false;
  return !sys.ctx.isHubPhase();
}

export function setDroneControl(sys: PlayerSystem, active: boolean): void {
  if (!active) { releaseDroneControl(sys, true, false); return; }
  if (sys._droneControl || !canEnterDroneControl(sys)) return;
  // A squadmate on the shoulder is put down first (the same rule as any other action — 'action' releases at once,
  // with no animation)
  if (sys._carrying) sys.dropCarried('action');
  const c = sys.controller;
  sys._droneControl = true;
  sys.droneStancePrev = sys._stance;
  sys.setAiming(false);
  if (c.rolling) c.cancelRoll();
  sys.setGrappleTarget(null);
  sys.setHovering(false);
  // Horizontal velocity 0 (gravity · grounding stay). The next `c.update` drops the sprint flag on zero input and
  // emits `player:sprintChanged`
  c.velocity.x = 0; c.velocity.z = 0;
  // A running E hold is cancelled; the target · prompt are cleared by the next `updateInteraction(active=false)`
  sys.cancelHold();
  if (sys._stance === 'stand') sys.setStance('crouch');
  sys.rig.setDroneView(true);
}

/**
 * Ends the control. Nothing to do when it is not running.
 * - `restoreStance` — standing before it was turned on and still in the forced crouch goes back to standing (the
 *   death · downed · reset paths pass false — those paths decide the stance themselves).
 * - `cutCamera` — takes the drone camera override down **at once**. A release called by the drone side
 *   (`setDroneControl(false)`) does not touch the camera (the drone takes it down itself with
 *   `setCameraOverride(null[, , snap])`); only the body-side auto release cuts the camera — so the view is not
 *   trapped on the drone when the drone side misses the release.
 */
export function releaseDroneControl(sys: PlayerSystem, restoreStance: boolean, cutCamera: boolean): void {
  if (!sys._droneControl) return;
  sys._droneControl = false;
  const prev = sys.droneStancePrev;
  sys.droneStancePrev = null;
  sys.rig.setDroneView(false);
  if (cutCamera) sys.rig.setOverride(null, undefined, true);
  if (restoreStance && prev === 'stand' && sys._stance === 'crouch' && !sys.isDead && !sys._downed) sys.setStance('stand');
}
