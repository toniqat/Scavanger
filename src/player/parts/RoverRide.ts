/**
 * src/player/parts/RoverRide.ts — **what the body does while aboard the rover** (2026-09-13, R3).
 *
 * The implementation of `PlayerRef.roverRide` · `roverBoardBlock` · `setRoverRide` · `roverSafePosition` (caller:
 * `world/rover`, rules: the rover section of `shared/types.ts`). While it is on:
 *   - The body **hides inside the hull** — no model · held weapon · shadow · silhouette, `PlayerFlags.IN_ROVER` for
 *     remotes.
 *   - The feet are pinned to `binding.seat` every frame (no gravity · collision · footsteps). The fog · the map · the
 *     squad list · snapshots follow the vehicle.
 *   - Movement · jump · stance · roll · aim · weapons · the interaction scan · shouldering · ladders are gone, and
 *     the other folders (quick slots · implants · ship calls · pings · the comms wheel · gadgets · drones) read
 *     `roverRide` next to `droneControl` on the gates that watched it.
 *   - **No damage of any kind lands** — `applyDamage` · knockback · impulses (jump pad · rockets) · burning · the
 *     planet environment · hazards (only the vehicle is hit).
 *   - The camera is `CameraRig`'s **orbit mode** (the mouse turns around `binding.focus`, the wheel = the distance).
 *   - An E hold = the exit hold (`ROVER_EXIT_HOLD_S`) when `binding.canExit` → `binding.requestExit()`; otherwise
 *     only `lockedPrompt` is shown.
 * The exit (`setRoverRide(null, exitAt)`) stands the body on the ground at `exitAt`, makes it visible again and then
 * hard-cuts the camera back behind the PC. Death · a reset (`game:abort` · a new mission · `respawnAt` ·
 * `spawnStanding` · leaving the phase) steps it down **beside the vehicle** through `releaseRoverRide`.
 */
import * as THREE from 'three';
import { Keys, PLAYER_RADIUS, ROVER_EXIT_HOLD_S, ROVER_SAFE_SIDE_M, type RoverRideBinding } from '@/shared';
import { _up } from '../model';
import type { PlayerSystem } from '../PlayerSystem';

const _exit = new THREE.Vector3();
const _pivot = new THREE.Vector3();

/** The Korean reason boarding is **not** possible right now, or null when it is. */
export function roverBoardBlock(sys: PlayerSystem): string | null {
  if (sys._roverRide) return '이미 탐사 차량에 타 있다';
  if (!sys.spawned || sys.isDead) return '사망한 상태에서는 탈 수 없다';
  if (sys._downed) return '전투불능 상태에서는 탈 수 없다';
  if (sys._carrying) return '분대원을 멘 채로는 탈 수 없다';
  if (sys.carriedSocket !== null) return '업혀 있는 동안은 탈 수 없다';
  if (sys.controller.climbing) return '사다리에 매달린 채로는 탈 수 없다';
  if (sys._droneControl) return '드론 조종 중에는 탈 수 없다';
  if (sys.furn.kind !== null || sys._inPod || sys.isDropping || sys.isInShip) return '지금은 탈 수 없다';
  if (sys.attachedParent !== null || sys._interior !== null || !sys.ctx.isGameplayPhase()) return '지금은 탈 수 없다';
  return null;
}

/** May the ride still be **held** — otherwise the top-of-`update` backstop steps it down beside the vehicle. */
export function canHoldRoverRide(sys: PlayerSystem): boolean {
  if (!sys.spawned || sys.isDead || sys._downed || !sys.ctx.isGameplayPhase()) return false;
  return !sys._inPod && sys.carriedSocket === null && sys.attachedParent === null && sys._interior === null && sys.shipBounds === null;
}

/** Body yaw (forward `(cos, sin)`) → camera rig yaw (forward `(-sin, -cos)`). They look the same way. */
function rigYawOf(vehicleYaw: number): number {
  return Math.atan2(-Math.cos(vehicleYaw), -Math.sin(vehicleYaw));
}

export function setRoverRide(sys: PlayerSystem, binding: RoverRideBinding | null, exitAt?: THREE.Vector3): void {
  if (!binding) { exitRide(sys, exitAt ?? null); return; }
  if (sys._roverRide === binding) return;
  if (sys._roverRide) {
    // A new binding for the same vehicle (world rebuilt it) — the body stays, only the camera takes the new focus
    sys._roverRide = binding;
    sys.rig.enterRoverOrbit(binding.focus, binding.cameraDistance, binding.yaw);
    return;
  }
  const block = roverBoardBlock(sys);
  if (block) { console.warn(`[Player] setRoverRide refused: ${block}`); return; }
  enterRide(sys, binding);
}

function enterRide(sys: PlayerSystem, b: RoverRideBinding): void {
  const c = sys.controller;
  // Everything the hands · the body were doing is put down (the weapon side's reload · throw · quick wheel stop
  // themselves — weapons watches `roverRide`)
  sys.setAiming(false);
  if (c.rolling) c.cancelRoll();
  sys.setGrappleTarget(null);
  sys.setHovering(false);
  sys.setBurning(0, 0);                      // Clears a running burn (DoT) — passes since `_roverRide` is not set yet
  sys.slowTimer = 0; sys.slowFactor = 1;
  sys.meleeTimer = 0;
  sys.cancelHold(); sys.interactTarget = null; sys.holdProgress = 0;
  if (sys._stance !== 'stand') sys.setStance('stand');
  sys.standUpTimer = 0;
  c.reset(b.seat);                           // velocity 0 · grounded · tram ride · ladder state all cleared
  sys.bodyOffset.set(0, 0, 0);
  sys._roverRide = b;
  sys.roverHold = 0;
  // So an E still held from the boarding hold does not turn straight into the exit hold — it must be released once
  sys.roverHoldArmed = !sys.ctx.input.isDown(Keys.INTERACT);
  sys.model.setVisible(false);
  sys.model.setSilhouette(false);
  sys.rig.enterRoverOrbit(b.focus, b.cameraDistance, b.yaw);
  clearPrompt(sys);
}

function exitRide(sys: PlayerSystem, exitAt: THREE.Vector3 | null): void {
  const b = sys._roverRide;
  if (!b) return;
  const yaw = rigYawOf(b.yaw);
  const c = sys.controller;
  _exit.copy(exitAt ?? c.position);
  groundSpot(sys, _exit);
  sys._roverRide = null;
  sys.roverHold = 0;
  sys.rig.exitRoverOrbit();
  c.reset(_exit);
  sys.bodyYaw = yaw;
  sys.bodyOffset.set(0, 0, 0);
  sys.model.root.position.copy(c.position);
  sys.model.root.quaternion.setFromAxisAngle(_up, yaw);
  if (sys.spawned && !sys.scopeHidden && !sys._inPod) sys.model.setVisible(true);
  _pivot.copy(c.position); _pivot.y += sys.eyePos.y;
  sys.rig.snapTo(_pivot, yaw);               // hard cut — no sweep from the orbit spot round behind the PC
  // So the exit hold's E does not hit an interactable (a crate · a console) at the spot it steps down on
  sys.holdArmed = false;
  sys.interactCooldown = Math.max(sys.interactCooldown, 0.35);
  clearPrompt(sys);
}

/** Puts the foot spot on the ground (the top of a low terrain feature included) and pushes it out of colliders. */
function groundSpot(sys: PlayerSystem, p: THREE.Vector3): void {
  const w = sys.ctx.world;
  if (!w || !w.ready) return;
  const feet = Math.max(p.y, w.getHeightAt(p.x, p.z));
  p.y = w.getSurfaceY(p.x, p.z, feet);
  p.copy(w.resolveCollision(p, PLAYER_RADIUS));
}

/** Death · reset · the backstop: steps down on the safe spot to the vehicle's right. Does nothing when not aboard. */
export function releaseRoverRide(sys: PlayerSystem): void {
  if (!sys._roverRide) return;
  exitRide(sys, roverSafePosition(sys, _pivot));
}

/** While aboard, the ground `ROVER_SAFE_SIDE_M` to the vehicle's right of the seat; otherwise null. */
export function roverSafePosition(sys: PlayerSystem, out: THREE.Vector3): THREE.Vector3 | null {
  const b = sys._roverRide;
  if (!b) return null;
  // The right of forward (cos, sin) = (-sin, cos)
  out.set(b.seat.x - Math.sin(b.yaw) * ROVER_SAFE_SIDE_M, b.seat.y, b.seat.z + Math.cos(b.yaw) * ROVER_SAFE_SIDE_M);
  groundSpot(sys, out);
  return out;
}

/** Every frame (top of `update`): pins the feet to the seat. */
export function pinToSeat(sys: PlayerSystem): void {
  const b = sys._roverRide;
  if (!b) return;
  const c = sys.controller;
  c.position.copy(b.seat);
  c.velocity.set(0, 0, 0);
  c.grounded = true;
  c.sprinting = false;
}

/** E while aboard: the exit hold or the locked prompt. `active` = able to act (no screen is open). */
export function updateRoverPrompt(sys: PlayerSystem, dt: number, active: boolean): void {
  const b = sys._roverRide;
  if (!b) return;
  const input = sys.ctx.input;
  if (!input.isDown(Keys.INTERACT)) sys.roverHoldArmed = true;
  let text: string | null = null;
  let hold = false;
  if (active && b.canExit) {
    text = '하차';
    hold = true;
    if (input.isDown(Keys.INTERACT) && sys.roverHoldArmed) {
      sys.roverHold += dt / Math.max(0.05, ROVER_EXIT_HOLD_S);
      if (sys.roverHold >= 1) {
        sys.roverHold = 0;
        sys.roverHoldArmed = false;
        b.requestExit();
        // Solo · the host may have stepped down on the spot — the exit path has then already cleared the prompt
        if (sys._roverRide !== b) return;
      }
    } else {
      sys.roverHold = 0;
    }
  } else {
    sys.roverHold = 0;
    if (active) text = b.lockedPrompt || null;
  }
  if (text !== sys.lastPromptText || sys.roverHold !== sys.lastHoldProgress) {
    sys.lastPromptText = text; sys.lastHoldProgress = sys.roverHold;
    sys.ctx.bus.emit('interact:promptChanged', { text, holdProgress: sys.roverHold, hold });
  }
}

function clearPrompt(sys: PlayerSystem): void {
  if (sys.lastPromptText === null && sys.lastHoldProgress <= 0) return;
  sys.lastPromptText = null; sys.lastHoldProgress = 0;
  sys.ctx.bus.emit('interact:promptChanged', { text: null, holdProgress: 0 });
}
