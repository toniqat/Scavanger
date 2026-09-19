/**
 * src/player/parts/Spawn.ts — **every way into and out of the world**.
 *
 * The hellpod drop (`startDrop`), simply standing up in the ship (`spawnStanding`), the respawn (`respawnAt`), and
 * the rejoin return to a raid (`restoreState` / `holdForRestore` — to the last position · state, with no drop).
 * `resetAll` / `resetTactical`, which wipe every combat state on a mission reset, live here too.
 */
import * as THREE from 'three';
import type { PlayerRestoreState } from '@/shared';
import {
  GameContext, PLAYER_RADIUS, PLAYER_DOWN_HP,
  /* appended (2026-09-09): the rescue drop revive */
  RESCUE_REVIVE_HP,
} from '@/shared';
import {
  DEATH_ANIM, EYE_PRONE, EYE_STAND, MELEE_SWING_TIME, SPAWN_RING_RADIUS, _camLook, _camPos, _spawn, _up, _v,
} from '../model';
import * as IntroWake from './IntroWake';
import type { PlayerSystem } from '../PlayerSystem';

/**
 * Rejoin: resume the body exactly as the host's ghost left it — standing at `position` facing `yaw`, no hellpod,
 * `hp`; `state` 1 = downed with `downHp` (prone crawl, bleeding, revivable — `player:downed` so the HUD shows the
 * vitals); `state` 2 = dead (death pose, controls off) WITHOUT `player:died` — game/ runs the respawn flow itself.
 * Emits `player:spawned` for 0 / 1. Clears any interior / ship box / pod state like `respawnAt`.
 */
export function restoreState(sys: PlayerSystem, state: PlayerRestoreState): void {
  const bus = sys.ctx.bus;
  const yaw = Number.isFinite(state.yaw) ? state.yaw : sys.bodyYaw;
  _v.copy(state.position);
  if (sys.ctx.world?.ready && !sys.ctx.world.isInsideBounds(_v.x, _v.z)) {
    // off the map (bad wire data): fall back to the mission spawn
    _v.copy(sys.resolveSpawn(sys.ctx.world.getPlayerSpawn()));
  }
  if (sys.ctx.world?.ready) _v.y = Math.max(_v.y, sys.ctx.world.getHeightAt(_v.x, _v.z));
  sys.releaseDroneControl();   // 2026-09-11
  sys.releaseFurniturePose('reset');   // 2026-09-12
  IntroWake.cancelIntroWake(sys);      // 2026-09-14
  sys.setSceneLock(false);             // 2026-09-14 3rd pass: the scene lock (respawn · ship return release it)
  sys.clearClimbState();
  sys.hellpod.hide();
  sys.attachTo(null);
  sys.setInterior(null);
  sys._inPod = false;
  sys.shipBounds = null; sys.controller.shipBounds = null;
  sys.controller.reset(_v);
  // 2026-09-14: if the saved pose was airborne (cut off mid-jump), the returning player alone would take fall
  // damage — the first fall of a return is exempt
  sys.controller.exemptFall();
  sys.slowTimer = 0; sys.slowFactor = 1; sys.controller.speedMultiplier = 1;
  sys.isDead = false; sys.deadTimer = 0; sys.invuln = 0.5; sys.flinch = 0;
  sys.healPool = 0;
  sys.clearDowned();
  sys.stamina = sys.maxStamina; sys.regenDelay = 0; sys.exhausted = false; sys.exhaustedSlow = 0;
  sys.setStance('stand'); sys.standUpTimer = 0;
  sys.resetTactical();
  sys.setAiming(false); sys.aimBlend = 0; sys.crouchBlend = 0; sys.proneBlend = 0; sys.sprintBlend = 0; sys.downedBlend = 0;
  sys.bodyYaw = yaw;
  sys.spawned = true;
  sys.controlsEnabled = true;
  sys.model.resetPose();
  sys.model.setFade(1);
  sys.scopeHidden = false;
  sys.model.setVisible(true);
  sys.model.root.position.copy(sys.controller.position);
  sys.model.root.quaternion.setFromAxisAngle(_up, yaw);
  sys.eyePos.set(0, EYE_STAND, 0);
  _v.copy(sys.controller.position); _v.y += EYE_STAND;
  sys.rig.snapTo(_v, yaw);
  sys.rig.setOverride(null);
  sys.interactTarget = null; sys.holdProgress = 0;

  /*
   * 2026-09-10: the shield comes back too. An omitted value (an old save · an older host that does not know the
   * shield) means **the maximum, not 0** — reading the unknown as 0 would make the rejoining player alone lose the
   * shield while wearing armor. Downed · dead means a shield of 0.
   */
  sys._shield = 0;
  sys.pendingShield = state.state === 0 ? (Number.isFinite(state.shield) ? (state.shield as number) : Infinity) : null;

  const st = state.state;
  if (st === 2) {
    // dead: lie where the ghost fell; the death anim is already over. No `player:died` — game/ owns the flow.
    sys.hp = 0;
    sys.isDead = true;
    sys.deadTimer = DEATH_ANIM;
    sys.controlsEnabled = false;
    sys.invuln = 0;
    bus.emit('player:healthChanged', { hp: 0, maxHp: sys.maxHp, delta: 0 });
    return;
  }
  if (st === 1) {
    sys.hp = 0;
    sys._downed = true;
    sys._downHp = THREE.MathUtils.clamp(Math.round(Number.isFinite(state.downHp) ? state.downHp : PLAYER_DOWN_HP), 1, PLAYER_DOWN_HP);
    sys.bleedAcc = 0; sys.giveUpHold = 0;
    sys.setStance('prone'); sys.standUpTimer = 0;
    sys.proneBlend = 1;
    sys.downedBlend = 1;
    sys.eyePos.set(0, EYE_PRONE, 0);
    _v.copy(sys.controller.position); _v.y += EYE_PRONE;
    sys.rig.snapTo(_v, yaw);
    bus.emit('player:spawned', { position: sys.controller.position.clone() });
    bus.emit('player:downed', { position: sys.controller.position.clone() });
    bus.emit('player:downHpChanged', { downHp: sys._downHp, max: PLAYER_DOWN_HP });
    bus.emit('player:healthChanged', { hp: 0, maxHp: sys.maxHp, delta: 0 });
    return;
  }
  sys.hp = THREE.MathUtils.clamp(Number.isFinite(state.hp) ? state.hp : sys.maxHp, 1, sys.maxHp);
  bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: 0 });
  bus.emit('player:spawned', { position: sys.controller.position.clone() });
}

/**
 * Does this mission **drop by hellpod.** The training range is a simulation room with no sky (2026-09-08), and the
 * tutorial is the story of someone who has no ship yet **waking up on that planet** (2026-09-14) — neither has a pod.
 * There are three drop paths (`world:ready` · `respawn` · the rescue drop), so the judgement lives in one place.
 */
export function usesHellpod(ctx: GameContext): boolean {
  return ctx.missionMode !== 'training' && ctx.missionMode !== 'tutorial';
}

/**
 * Re-drop at `position` like at mission start (hellpod, full hp, alive, not downed). `player:respawn` → here.
 * 2026-09-08: **no hellpod on the training range** — the simulation room has no sky, on entry as on a restart.
 * 2026-09-14: a tutorial checkpoint respawn has no pod for the same reason (`usesHellpod`).
 */
export function respawn(sys: PlayerSystem, position: THREE.Vector3): void {
  sys.respawnAt(sys.resolveSpawn(position));
  if (usesHellpod(sys.ctx)) sys.startDrop();
}

/**
 * Place the player standing at `position` facing `yaw`: alive, full hp / stamina, stance stand, no hellpod,
 * controls enabled, detached from any parent, camera snapped behind the player, not in a pod. Emits
 * `player:spawned`. Does NOT touch `interior` (call `setInterior` before or after) and does not release an
 * active camera override (the hub owns that via `setCameraOverride(null)`).
 */
export function spawnStanding(sys: PlayerSystem, position: THREE.Vector3, yaw: number): void {
  sys.releaseRoverRide();   // 2026-09-13
  sys.releaseDroneControl();   // 2026-09-11
  sys.releaseFurniturePose('reset');   // 2026-09-12
  IntroWake.cancelIntroWake(sys);      // 2026-09-14
  sys.setSceneLock(false);             // 2026-09-14 3rd pass: the scene lock (respawn · ship return release it)
  sys.clearClimbState();
  sys.hellpod.hide();
  sys.attachTo(null);
  sys.shipBounds = null; sys.controller.shipBounds = null;
  sys._inPod = false;
  sys.controller.reset(position);
  if (sys._interior) {
    const floor = sys._interior.getFloorAt(position.x, position.z);
    if (Math.abs(position.y - floor) < 1.5) sys.controller.position.y = floor;
  }
  sys.hp = sys.maxHp;
  sys.slowTimer = 0; sys.slowFactor = 1; sys.controller.speedMultiplier = 1;
  sys.isDead = false; sys.deadTimer = 0; sys.invuln = 0; sys.flinch = 0;
  sys.healPool = 0;
  sys.clearDowned();
  sys.stamina = sys.maxStamina; sys.regenDelay = 0; sys.exhausted = false; sys.exhaustedSlow = 0;
  sys.setStance('stand'); sys.standUpTimer = 0;
  sys.resetTactical();
  sys.setAiming(false); sys.aimBlend = 0; sys.crouchBlend = 0; sys.proneBlend = 0; sys.sprintBlend = 0; sys.downedBlend = 0;
  sys.bodyYaw = yaw;
  sys.spawned = true;
  sys.controlsEnabled = true;
  sys.model.resetPose();
  sys.model.setFade(1);
  sys.scopeHidden = false;
  sys.model.setVisible(true);
  sys.model.root.position.copy(sys.controller.position);
  sys.model.root.quaternion.setFromAxisAngle(_up, yaw);
  sys.eyePos.set(0, EYE_STAND, 0);
  _v.copy(sys.controller.position); _v.y += EYE_STAND;
  sys.rig.snapTo(_v, yaw);
  sys.interactTarget = null; sys.holdProgress = 0;
  sys.ctx.bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: 0 });
  sys.ctx.bus.emit('player:spawned', { position: sys.controller.position.clone() });
}

/* ── dev console / unique weapons (2026-09-06) ─────────────────────────── */
/**
 * Instant move without a hellpod (console `/move`, Home move cheat): feet to `position`, velocity / roll / grapple
 * cleared, stance / hp / items / interior untouched, no `player:spawned`. Unless `snap === false` the feet are put
 * on the ground under the target: the interior deck (`interior.getFloorAt`) in the hub, else the terrain
 * (`world.getHeightAt`). Optional `yaw` turns both the camera and the body; the camera follows immediately.
 * Works in the hub and on a mission; ignored while dead, in a pod, or inside the hellpod drop.
 */
export function teleport(sys: PlayerSystem, position: THREE.Vector3, yaw?: number, snap?: boolean): void {
  if (!sys.spawned || sys.isDead || sys._inPod) return;
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return;
  sys.releaseRoverRide();   // 2026-09-13: a move cheat takes the body out of the rover first
  sys.releaseFurniturePose('reset');   // 2026-09-12: a move cheat stands the body up first
  sys.clearClimbState();
  _v.copy(position);
  if (snap !== false) {
    if (sys._interior) _v.y = sys._interior.getFloorAt(_v.x, _v.z);
    else if (sys.ctx.world?.ready) _v.y = sys.ctx.world.getHeightAt(_v.x, _v.z);
  }
  const c = sys.controller;
  const stance = c.stance;
  const wasGrounded = c.grounded;
  c.reset(_v);
  c.stance = stance;                       // reset() forces stand; keep crouch / prone (downed stays prone)
  if (snap === false) c.grounded = wasGrounded;
  sys.controller.speedMultiplier = 1;
  sys.standUpTimer = 0;
  sys.rollBlend = 0; sys.rollPhase = 0;
  sys._grappling = false;
  if (yaw !== undefined) sys.bodyYaw = yaw;
  const root = sys.model.root;
  if (!sys.attachedParent) { root.position.copy(_v); root.quaternion.setFromAxisAngle(_up, sys.bodyYaw); }
  _v.y += sys.eyePos.y;
  sys.rig.jumpTo(_v, yaw);   // keeps pitch (and yaw unless given) — the move cheat calls this every frame
}

export function respawnAt(sys: PlayerSystem, position: THREE.Vector3, yaw?: number): void {
  const y = yaw ?? Math.atan2(position.x, position.z); // face the map centre by default
  sys.releaseRoverRide();   // 2026-09-13
  sys.releaseDroneControl();   // 2026-09-11
  sys.releaseFurniturePose('reset');   // 2026-09-12
  IntroWake.cancelIntroWake(sys);      // 2026-09-14
  sys.setSceneLock(false);             // 2026-09-14 3rd pass: the scene lock (respawn · ship return release it)
  sys.clearClimbState();
  sys.attachTo(null);
  sys.setInterior(null);
  sys._inPod = false;
  sys.shipBounds = null;
  sys.controller.shipBounds = null;
  sys.controller.reset(position);
  sys.hp = sys.maxHp;
  sys.slowTimer = 0; sys.slowFactor = 1; sys.controller.speedMultiplier = 1;
  sys.isDead = false; sys.deadTimer = 0; sys.invuln = 0; sys.flinch = 0;
  sys.healPool = 0;
  sys.clearDowned();
  sys.stamina = sys.maxStamina; sys.regenDelay = 0; sys.exhausted = false; sys.exhaustedSlow = 0;
  sys.setStance('stand'); sys.standUpTimer = 0;
  sys.resetTactical();
  sys.isAiming = false; sys.aimBlend = 0; sys.crouchBlend = 0; sys.proneBlend = 0; sys.sprintBlend = 0; sys.downedBlend = 0;
  sys.bodyYaw = y;
  sys.spawned = true;
  sys.controlsEnabled = true;
  sys.model.resetPose();
  sys.model.setFade(1);
  sys.scopeHidden = false;
  sys.model.setVisible(true);
  sys.model.root.position.copy(position);
  sys.model.root.quaternion.setFromAxisAngle(_up, y);
  sys.eyePos.set(0, EYE_STAND, 0);
  _v.copy(position); _v.y += EYE_STAND;
  sys.rig.snapTo(_v, y);
  sys.rig.setOverride(null);
  sys.ctx.bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: 0 });
  sys.ctx.bus.emit('player:spawned', { position: position.clone() });
}

/* ─────────────────────── tactical kit internals ─────────────────────── */
/**
 * Clear every tactical-kit state (roll, melee, cloak, burning, grapple, hover, buffs).
 * Called from `respawnAt`, `spawnStanding` and the `game:abort` reset. The gear cache is only marked dirty —
 * armor survives a respawn.
 */
export function resetTactical(sys: PlayerSystem): void {
  sys.clearCarry('reset');
  sys.controller.cancelRoll();
  sys.controller.grappleTarget = null; sys._grappling = false;
  sys.controller.hovering = false;
  sys.rollBlend = 0; sys.rollPhase = 0; sys.rollCooldown = 0;
  sys.meleeTimer = 0; sys.meleeCooldown = 0; sys.meleeKind = 'light'; sys.meleeDuration = MELEE_SWING_TIME;
  sys.chargeBlend = 0; sys.sprayBlend = 0; sys.heavyBlend = 0;
  sys.weaponState.charging = false; sys.weaponState.spraying = false; sys.weaponState.heavy = false;
  if (sys.rig) sys.rig.viewWiden = false;
  sys.cloakTimer = 0; sys.cloakBreak = 0; sys.cloakProbe = 0; sys.cloakNearEnemy = false;
  sys.cloakSource = null;
  if (sys._cloaked) { sys._cloaked = false; sys.ctx?.bus.emit('player:cloakChanged', { cloaked: false, source: null }); }
  sys.speedMods.clear();
  sys._overchargedUntil = 0;
  sys._hovering = false; sys.hoverBlend = 0; sys.autoHoverUsed = false;
  if (sys._burning) { sys._burning = false; sys.ctx?.bus.emit('player:burning', { active: false, dps: 0 }); }
  sys.burnDps = 0; sys.burnTimer = 0; sys.burnTick = 0;
  sys.regenAccum = 0;
  sys.gear.markDirty();
}

/**
 * Multiplayer: every client drops on its own pad around the shared spawn — a ring of radius
 * SPAWN_RING_RADIUS, one slot per quadrant (slot × 90° + 45°), snapped to the terrain and pushed
 * out of obstacles. Single-player uses the world spawn untouched.
 */
export function resolveSpawn(sys: PlayerSystem, playerSpawn: THREE.Vector3): THREE.Vector3 {
  const ctx = sys.ctx;
  if (!ctx.isMultiplayer || !ctx.net) return playerSpawn;
  const slot = ctx.net.localSlot;
  const angle = slot * (Math.PI / 2) + Math.PI / 4;
  const out = _spawn;
  out.set(playerSpawn.x + Math.cos(angle) * SPAWN_RING_RADIUS, playerSpawn.y, playerSpawn.z + Math.sin(angle) * SPAWN_RING_RADIUS);
  const world = ctx.world;
  if (world && world.ready) {
    out.y = world.getHeightAt(out.x, out.z);
    world.resolveCollision(out, PLAYER_RADIUS);
    out.y = world.getHeightAt(out.x, out.z);
  }
  return out;
}

/** Rejoin wait: everything reset like `game:abort`, feet + camera parked at `position`, model hidden, no controls. */
export function holdForRestore(sys: PlayerSystem, position: THREE.Vector3): void {
  sys.resetAll();
  sys.setInterior(null);
  sys.controller.reset(position);
  sys.bodyYaw = Math.atan2(position.x, position.z);
  sys.model.root.position.copy(position);
  sys.model.root.quaternion.setFromAxisAngle(_up, sys.bodyYaw);
  sys.eyePos.set(0, EYE_STAND, 0);
  _v.copy(position); _v.y += EYE_STAND;
  sys.rig.snapTo(_v, sys.bodyYaw);
}

/**
 * Starts the hellpod drop. `kind` 0 = mission start, 1 = the rescue drop (2026-09-09).
 *
 * 2026-09-09: **squadmates see the pod too.** A remote squadmate used to simply appear in place — now whoever starts
 * the drop sends `pod drop` to `'others'` and the receiving side (`RemotePlayerSystem`) drops a remote pod.
 * The camera cutscene is the local one's alone, so it is not on the wire.
 */
export function startDrop(sys: PlayerSystem, kind: 0 | 1 = 0): void {
  const pos = sys.controller.position;
  sys.controlsEnabled = false;
  sys.model.setVisible(false);
  sys.hellpod.start(pos, sys.bodyYaw);
  if (sys.hellpod.getCameraPose(_camPos, _camLook)) sys.rig.setOverride(_camPos, _camLook, true);
  sys.ctx.bus.emit('audio:play', { id: 'hellpod_fall', position: pos, volume: 1 });
  const ctx = sys.ctx;
  const me = ctx.net?.localId;
  if (ctx.isMultiplayer && me) {
    ctx.net?.send({ t: 'pod', ev: 'drop', who: me, p: [pos.x, pos.y, pos.z], yaw: sys.bodyYaw, kind }, 'others');
  }
}

/**
 * The rescue pod lands (`rescue:landed`, 2026-09-09). Answered only when the target is me — the body stands again
 * through a hellpod drop, hp is `RESCUE_REVIVE_HP`, and **the inventory stays empty** (everything carried was left
 * on the corpse). The flow (phase · the squad-leader marker) is owned by `game/parts/Death.onRescueLanded`.
 *
 * 2026-09-19 (B-47): the pod is gated by `usesHellpod` like the other two drop paths. It used to test
 * `missionMode !== 'training'` on its own, which would have dropped a pod in the tutorial — the one mode whose
 * whole point is that the player has no ship (`usesHellpod`, `README.md` 「Hellpods are skipped in training and
 * tutorial」). No tutorial rescue drop exists today, so nothing on screen changes.
 */
export function rescueRevive(sys: PlayerSystem, position: THREE.Vector3): void {
  // The landing point is already decided and sent by the host (`world.scatterPoints`) — no squad spawn ring on top.
  _v.copy(position);
  if (sys.ctx.world?.ready) _v.y = sys.ctx.world.getHeightAt(_v.x, _v.z);
  sys.respawnAt(_v.clone());
  sys.hp = THREE.MathUtils.clamp(Math.round(RESCUE_REVIVE_HP), 1, sys.maxHp);
  sys.ctx.bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: 0 });
  if (usesHellpod(sys.ctx)) sys.startDrop(1);
}

export function updateDrop(sys: PlayerSystem, dt: number): void {
  const ev = sys.podEvents;
  sys.hellpod.update(dt, ev);
  if (ev.impact) {
    sys.model.setVisible(!sys._inPod);
    sys.rig.addShake(1.0, 0.7);
    sys.ctx.bus.emit('player:landed', { impactSpeed: sys.hellpod.impactSpeed });
    sys.ctx.bus.emit('camera:shake', { intensity: 0.4, duration: 0.5 });
    sys.ctx.bus.emit('audio:play', { id: 'hellpod_impact', position: sys.controller.position, volume: 1 });
  }
  if (ev.opened) {
    sys.controlsEnabled = true;
    sys.rig.setOverride(null);
    sys.ctx.bus.emit('audio:play', { id: 'hellpod_open', position: sys.controller.position, volume: 0.9 });
  }
  if (sys.hellpod.state === 'opening' && sys.hellpod.exitProgress === 0) {
    // release the cutscene camera as soon as the doors start moving
    sys.rig.setOverride(null);
  }
}

export function resetAll(sys: PlayerSystem): void {
  sys.releaseRoverRide();   // 2026-09-13: game:abort · the rejoin wait
  sys.releaseDroneControl();   // 2026-09-11: game:abort · the rejoin wait
  sys.releaseFurniturePose('reset');   // 2026-09-12
  IntroWake.cancelIntroWake(sys);      // 2026-09-14: `game:abort` · the rejoin wait — ends without announcing
  sys.setSceneLock(false);             // 2026-09-14 3rd pass: `game:abort` releases the scene lock too (contract)
  sys.clearClimbState();
  sys.hellpod.hide();
  sys.attachTo(null);
  sys.shipBounds = null; sys.controller.shipBounds = null;
  // `interior` is deliberately kept: the hub may have set it before aborting the mission; respawnAt / hub:left clear it
  sys._inPod = false;
  sys.model.setSilhouette(false);
  sys.model.setFade(1);
  sys.scopeHidden = false;
  sys.model.setVisible(false);
  sys.model.resetPose();
  sys.spawned = false;
  sys.controlsEnabled = false;
  sys.isDead = false; sys.deadTimer = 0;
  sys.healPool = 0;
  sys.clearDowned();
  sys.lookLocked = false;
  sys.weaponState.throwing = false; sys.weaponState.holdingItem = false; sys.weaponState.cooking = false;
  sys.throwBlend = 0; sys.holdItemBlend = 0; sys.cookBlend = 0;
  sys.setAiming(false);
  sys.setStance('stand'); sys.standUpTimer = 0;
  sys.stamina = sys.maxStamina; sys.regenDelay = 0; sys.exhausted = false; sys.exhaustedSlow = 0;
  sys.resetTactical();
  sys.crouchBlend = 0; sys.proneBlend = 0; sys.downedBlend = 0;
  sys.cancelHold(); sys.interactTarget = null;
  if (sys.lastPromptText !== null) { sys.lastPromptText = null; sys.lastHoldProgress = 0; sys.ctx.bus.emit('interact:promptChanged', { text: null, holdProgress: 0 }); }
  sys.rig.setOverride(null);
}
