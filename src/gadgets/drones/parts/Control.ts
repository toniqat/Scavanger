/**
 * src/gadgets/drones/parts/Control.ts — **who enters and leaves a drone view, and when.**
 *
 * An R hold (`DRONE_CONTROL_HOLD_S`) takes control and the same hold returns to the PC. While controlled, keys ·
 * mouse move into `DroneInput` and the drone lens is handed over every frame with
 * `player.setCameraOverride(pos, look, true)` — `DroneSystem.update` runs after `PlayerSystem.update` and before
 * `PlayerSystem.lateUpdate` (the camera rig), so it is never a frame late.
 * Link range (`linkRatio`) · the forced release · the static live here too.
 */
import {
  DRONE_CONTROL_HOLD_S, DRONE_LINK_WARN_RATIO, DroneFlags, Keys, droneKindOfGadget,
  type DroneKind, type DroneReleaseReason, type GadgetId,
} from '@/shared';
import {
  _camLook, _camPos, DRONE_LOOK_PITCH_MAX, DRONE_LOOK_SENSITIVITY, DRONE_STATIC_SFX_S, droneRange, wrapAngle,
  type Drone, type DroneInput,
} from '../model';
import type { DroneSystem } from '../DroneSystem';
import { deny, ownDrone } from './Lifecycle';

let staticT = 0;

/** The kind, when the item in hand is a drone controller. */
export function heldDroneKind(sys: DroneSystem): DroneKind | null {
  const id = sys.ctx.weapons?.remoteState?.heldItemId;
  if (!id) return null;
  const def = sys.ctx.loot?.getItemDef(id);
  return droneKindOfGadget((def?.gadgetId ?? null) as GadgetId | null);
}

export function controlHold(sys: DroneSystem): number {
  return sys.holding ? Math.min(1, sys.holdT / Math.max(0.01, DRONE_CONTROL_HOLD_S)) : 0;
}

/**
 * The R hold. A hold starts only on **this press** (`wasPressed`) — so an R already held down for a reload does not
 * turn into control the moment a drone reaches the hand. Once filled it switches once and does not count again until
 * the key is released.
 */
export function updateControl(sys: DroneSystem, dt: number): void {
  const ctx = sys.ctx;
  const input = ctx.input;
  const p = ctx.player;
  const rDown = input.isDown(Keys.RELOAD);
  if (!rDown) { sys.holding = false; sys.holdT = 0; }

  const cur = sys.controlled;
  if (cur) {
    // `setDroneControl` can be refused silently or release itself (ladder · drop pod · shouldering · ship
    // interior …) — there is no event, so it is checked every frame
    if (!p || p.isDead || p.isDowned || !ctx.isGameplayPhase() || cur.removing || p.droneControl === false) { releaseControl(sys, 'reset'); return; }
    if (!ctx.isGameplayActive()) { sys.holding = false; sys.holdT = 0; return; }
    if (input.wasPressed(Keys.RELOAD)) { input.consume(Keys.RELOAD); sys.holding = true; sys.holdT = 0; }
    if (!sys.holding) return;
    sys.holdT += dt;
    if (sys.holdT >= DRONE_CONTROL_HOLD_S) releaseControl(sys, 'manual');
    return;
  }

  // 2026-09-13: being inside the rover is excluded
  const able = !!p && !p.isDead && !p.isDowned && !p.droneControl && !p.roverRide && ctx.isGameplayActive();
  const kind = able ? heldDroneKind(sys) : null;
  const d = kind ? ownDrone(sys, kind) : null;
  if (!d) { sys.holding = false; sys.holdT = 0; return; }
  if (input.wasPressed(Keys.RELOAD)) {
    input.consume(Keys.RELOAD);
    if (d.linkRatio >= 1) { sys.holding = false; deny(sys, '신호 범위 밖'); return; }
    sys.holding = true;
    sys.holdT = 0;
  }
  if (!sys.holding) return;
  sys.holdT += dt;
  if (sys.holdT < DRONE_CONTROL_HOLD_S) return;
  sys.holding = false;
  sys.holdT = 0;
  if (d.linkRatio >= 1) { deny(sys, '신호 범위 밖'); return; }
  startControl(sys, d);
}

export function startControl(sys: DroneSystem, d: Drone): void {
  const ctx = sys.ctx;
  if (sys.controlled === d) return;
  if (sys.controlled) releaseControl(sys, 'manual');
  const p = ctx.player;
  if (!p) return;
  if (typeof p.setDroneControl === 'function') {
    p.setDroneControl(true);
    // The player refused (ladder · drop pod · shouldering · ship interior …) — the view is not handed over
    if (!p.droneControl) { deny(sys, '지금은 드론을 조종할 수 없다'); return; }
  }
  sys.controlled = d;
  d.localControlled = true;
  d.lookYaw = d.body.yaw;
  d.lookPitch = 0;
  d.netDirty = true;
  staticT = 0;
  d.body.setOwnerView(true);
  applyCamera(sys);
  ctx.bus.emit('audio:play', { id: 'drone_link_on', volume: 0.7 });
  ctx.bus.emit('drone:controlChanged', { id: d.id, kind: d.kind, reason: null });
}

export function releaseControl(sys: DroneSystem, reason: DroneReleaseReason): void {
  const d = sys.controlled;
  if (!d) return;
  const ctx = sys.ctx;
  sys.controlled = null;
  sys.holding = false;
  sys.holdT = 0;
  d.localControlled = false;
  d.netDirty = true;
  d.body.setOwnerView(false);
  const p = ctx.player;
  if (p && (p.droneControl ?? true)) p.setDroneControl?.(false);
  // snap + null = a hard cut. A plain null blends back over about a second, and from a distant drone that sweeps
  // the camera across the terrain all the way to the PC.
  p?.setCameraOverride(null, undefined, true);
  ctx.bus.emit('audio:play', { id: 'drone_link_off', volume: 0.7 });
  ctx.bus.emit('drone:controlChanged', { id: null, kind: null, reason });
}

/** This frame's input for the controlled drone. null while UI is open (ground stops, air hovers in place). */
export function buildInput(sys: DroneSystem, d: Drone): DroneInput | null {
  const ctx = sys.ctx;
  if (!ctx.isGameplayActive()) return null;
  const input = ctx.input;
  if (input.isPointerLocked) {
    d.lookYaw = wrapAngle(d.lookYaw - input.mouseDX * DRONE_LOOK_SENSITIVITY);
    d.lookPitch = Math.max(-DRONE_LOOK_PITCH_MAX, Math.min(DRONE_LOOK_PITCH_MAX, d.lookPitch - input.mouseDY * DRONE_LOOK_SENSITIVITY));
  }
  const inp = sys.input;
  inp.forward = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
  inp.right = (input.isDown(Keys.RIGHT) ? 1 : 0) - (input.isDown(Keys.LEFT) ? 1 : 0);
  inp.vertical = (input.isDown(Keys.JUMP) ? 1 : 0) - (input.isDown(Keys.CROUCH) ? 1 : 0);
  inp.sprint = input.isDown(Keys.SPRINT);
  inp.jump = input.wasPressed(Keys.JUMP);
  inp.yaw = d.lookYaw;
  inp.pitch = d.lookPitch;
  return inp;
}

/**
 * Owner PC ↔ drone 3D distance ÷ link range. A replica measures it from that owner's remote position (with no remote
 * player, the wire's LINK_LOST decides).
 */
export function updateLink(sys: DroneSystem, d: Drone): void {
  const ctx = sys.ctx;
  const range = droneRange(d.kind);
  if (d.isLocal) {
    const p = ctx.player;
    d.linkRatio = p ? p.position.distanceTo(d.position) / range : 0;
    return;
  }
  const owner = ctx.net?.getRemotePlayer(d.owner as string);
  const lost = (d.flags & DroneFlags.LINK_LOST) !== 0;
  if (owner) {
    const r = owner.position.distanceTo(d.position) / range;
    d.linkRatio = lost ? Math.max(1, r) : r;
  } else d.linkRatio = lost ? 1 : 0;
}

/** After the loop: the forced release · the camera · the static. */
export function updateControlled(sys: DroneSystem, dt: number): void {
  const d = sys.controlled;
  if (!d) return;
  if (d.linkRatio >= 1) { releaseControl(sys, 'range'); return; }
  applyCamera(sys);
  if (d.linkRatio >= DRONE_LINK_WARN_RATIO) {
    staticT -= dt;
    if (staticT <= 0) {
      staticT = DRONE_STATIC_SFX_S;
      const k = (d.linkRatio - DRONE_LINK_WARN_RATIO) / Math.max(0.01, 1 - DRONE_LINK_WARN_RATIO);
      sys.ctx.bus.emit('audio:play', { id: 'drone_static', volume: 0.25 + 0.55 * Math.max(0, Math.min(1, k)) });
    }
  } else staticT = 0;
}

export function applyCamera(sys: DroneSystem): void {
  const d = sys.controlled;
  const p = sys.ctx.player;
  if (!d || !p) return;
  d.body.getCameraPose(d.lookPitch, _camPos, _camLook);
  p.setCameraOverride(_camPos, _camLook, true);
}
