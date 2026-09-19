/**
 * src/gadgets/drones/parts/Lifecycle.ts — **a drone coming out, moving, taking hits and going away.**
 *
 * Deploy (`deploy` — it does not touch the inventory) · owner-side simulation · the sprint sound · enemy noise
 * (`world:noise`, the authority only) · damage (`droneq damage` when not the owner) · destruction (which spends
 * one of that item from the owner's bag / quick slots) · E-hold recovery (spends nothing) · the ray query · reset.
 */
import * as THREE from 'three';
import {
  DRONE_GADGET_OF, DRONE_NOISE_EMIT_HZ, DRONE_NOISE_MEMORY_S, DRONE_NOISE_RADIUS, DRONE_RECOVER_HOLD_S,
  DroneFlags, blastReachesBody, explosionDamage, type DroneKind, type DroneRayHit, type Interactable, type PeerId,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { RECOVER_RADIUS } from '../../model';
import {
  _l0, _l1, _l2, Drone, DRONE_DEPLOY_DIST_AIR, DRONE_DEPLOY_DIST_GROUND, DRONE_DEPLOY_LIFT_AIR, DRONE_RECOVER_AIR_BONUS,
  DRONE_SPRINT_SFX_S, UP, droneMaxHp, droneName, droneYawFromPlayer, type DroneBody,
} from '../model';
import { GroundDrone } from '../GroundDrone';
import { AirDrone } from '../AirDrone';
import type { DroneSystem } from '../DroneSystem';
import { buildInput } from './Control';
import { sendRemove, sendSpawn } from './Wire';

export function deny(sys: DroneSystem, text: string | null): false {
  if (text) {
    sys.ctx.bus.emit('ui:notify', { text, kind: 'warning', duration: 1.4 });
    sys.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
  }
  return false;
}

export function ownDrone(sys: DroneSystem, kind: DroneKind): Drone | null {
  for (let i = 0; i < sys.drones.length; i++) {
    const d = sys.drones[i];
    if (d.isLocal && d.kind === kind && !d.removing) return d;
  }
  return null;
}

export function createBody(kind: DroneKind): DroneBody {
  return kind === 'air' ? new AirDrone() : new GroundDrone();
}

/* ═══════════════════════════ Deploy ═══════════════════════════ */
export function deploy(sys: DroneSystem, kind: DroneKind): boolean {
  const ctx = sys.ctx;
  const p = ctx.player;
  const world = ctx.world;
  // It cannot be deployed in the ship (the hub) · in a menu · before the drop
  if (!ctx.isGameplayPhase() || !ctx.isRaidActive() || !world || !world.ready) return deny(sys, null);
  if (!p || p.isDead || p.isDowned || p.climbingLadder || p.droneControl || p.roverRide) return deny(sys, null);   // 2026-09-13: + the rover
  if (ownDrone(sys, kind)) return deny(sys, `이미 ${droneName(kind)}을 꺼내 뒀다`);

  const body = createBody(kind);
  const pos = _l0;
  const fwd = p.getForward(_l1);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); else fwd.normalize();

  if (kind === 'ground') {
    // The surface straight in front of the PC. With a wall close by, in front of that.
    _l2.copy(p.position); _l2.y += 0.5;
    let dist = DRONE_DEPLOY_DIST_GROUND;
    const hit = world.raycast(_l2, fwd, dist + body.radius);
    if (hit) dist = Math.max(0.3, hit.distance - body.radius - 0.05);
    pos.set(p.position.x + fwd.x * dist, p.position.y, p.position.z + fwd.z * dist);
    if (!world.isInsideBounds(pos.x, pos.z)) { body.dispose(); return deny(sys, '드론을 놓을 자리가 없다'); }
    const feet = p.position.y + 0.3;
    pos.y = world.getSurfaceY(pos.x, pos.z, feet);
    world.resolveCollision(pos, body.radius);
    pos.y = world.getSurfaceY(pos.x, pos.z, feet);
  } else {
    // In the air above and in front of the PC's eyes. With a ceiling · wall close by, inside that.
    p.getEyePosition(_l2);
    let dist = DRONE_DEPLOY_DIST_AIR;
    const hit = world.raycast(_l2, fwd, dist + body.radius);
    if (hit) dist = Math.max(0.3, hit.distance - body.radius - 0.05);
    pos.set(_l2.x + fwd.x * dist, _l2.y, _l2.z + fwd.z * dist);
    if (!world.isInsideBounds(pos.x, pos.z)) { body.dispose(); return deny(sys, '드론을 놓을 자리가 없다'); }
    let lift = DRONE_DEPLOY_LIFT_AIR;
    const ceil = world.raycast(pos, UP, lift + body.height);
    if (ceil) lift = Math.max(0, ceil.distance - body.height);
    pos.y += lift;
    world.resolveCollision(pos, body.radius);
    const floor = world.getSurfaceY(pos.x, pos.z, p.position.y + 0.3);
    if (pos.y < floor + body.height) pos.y = floor + body.height;
  }

  const yaw = droneYawFromPlayer(p.yaw);
  body.reset(pos, yaw, ctx);
  ctx.scene.add(body.root);
  const hp = droneMaxHp(kind);
  const d = new Drone(ctx, `${ctx.net?.localId ?? 'sp'}-d${++sys.seq}`, kind, 'local', body, hp, hp);
  d.lookYaw = yaw;
  addDrone(sys, d);
  registerRecover(sys, d);
  d.fxPos.copy(d.position);
  ctx.bus.emit('audio:play', { id: 'drone_deploy', position: d.fxPos, volume: 0.8 });
  ctx.bus.emit('drone:deployed', { id: d.id, kind, owner: 'local', position: d.position });
  sendSpawn(sys, d);
  return true;
}

export function addDrone(sys: DroneSystem, d: Drone): void {
  sys.drones.push(d);
  sys.byId.set(d.id, d);
}

/* ═══════════════════════════ Every frame ═══════════════════════════ */
export function simulateOwn(sys: DroneSystem, d: Drone, dt: number): void {
  const ctx = sys.ctx;
  const input = sys.controlled === d ? buildInput(sys, d) : null;
  if (dt > 0) d.body.simulate(dt, ctx, input);
  if (d.kind === 'ground' && d.body.sprinting) d.noiseUntil = ctx.time + DRONE_NOISE_MEMORY_S;
}

/**
 * The sprint sound (positional audio — the owner and a replica alike) · a replica's jump / landing sound (on the
 * owner side the body emits them).
 */
export function updateSounds(sys: DroneSystem, d: Drone, dt: number): void {
  const bus = sys.ctx.bus;
  if (d.kind === 'air') {
    // 2026-09-11 (the lead): rotor sound for a replica air drone — on the owner side `AirDrone.simulate` emits it.
    if (d.isLocal) return;
    const moving = (d.flags & DroneFlags.CONTROLLED) !== 0 || d.toPos.distanceToSquared(d.fromPos) > 0.0004;
    if (!moving) { d.sprintSfxT = 0; return; }
    d.sprintSfxT -= dt;
    if (d.sprintSfxT <= 0) {
      d.sprintSfxT = 0.45;   // audio beat (the middle of AirDrone's ROTOR_SFX range)
      bus.emit('audio:play', { id: 'drone_rotor', position: d.position, volume: 0.45 });
    }
    return;
  }
  if (d.kind !== 'ground') return;
  if (d.sprinting) {
    d.sprintSfxT -= dt;
    if (d.sprintSfxT <= 0) {
      d.sprintSfxT = DRONE_SPRINT_SFX_S;
      bus.emit('audio:play', { id: 'drone_sprint', position: d.position, volume: 0.55 });
    }
  } else d.sprintSfxT = 0;
  if (d.isLocal) return;
  const air = (d.flags & DroneFlags.AIRBORNE) !== 0;
  if (air !== d.airborneSeen) {
    d.airborneSeen = air;
    if (air && d.toPos.y > d.fromPos.y + 0.02) bus.emit('audio:play', { id: 'drone_jump', position: d.position, volume: 0.45 });
    else if (!air) bus.emit('audio:play', { id: 'drone_land', position: d.position, volume: 0.4 });
  }
}

/**
 * **The authority client only**: `world:noise` at up to `DRONE_NOISE_EMIT_HZ` for every noisy ground drone (mine =
 * sprinted recently, a replica = `DroneFlags.NOISY`). The position is copied into a vector the drone owns before
 * it is passed on (so a receiver that keeps it does not follow the drone).
 *
 * 2026-09-19: the authority test is **in here**, not at the call site. Enemy aggro is host-owned, so a second
 * caller that forgot the guard would have every client shouting `world:noise` for the same drone.
 */
export function emitNoise(sys: DroneSystem, d: Drone): void {
  const ctx = sys.ctx;
  if (!ctx.isAuthority || d.kind !== 'ground' || !ctx.isGameplayPhase()) return;
  const noisy = d.isLocal ? ctx.time < d.noiseUntil : (d.flags & DroneFlags.NOISY) !== 0;
  if (!noisy || ctx.time < d.noiseNextAt) return;
  d.noiseNextAt = ctx.time + 1 / Math.max(0.1, DRONE_NOISE_EMIT_HZ);
  d.noisePos.copy(d.position);
  ctx.bus.emit('world:noise', { position: d.noisePos, radius: DRONE_NOISE_RADIUS, source: 'drone', sourceId: d.id });
}

/* ═══════════════════════════ Damage · destruction ═══════════════════════════ */
export function damageDrone(sys: DroneSystem, id: string, amount: number, _from?: THREE.Vector3): void {
  const ctx = sys.ctx;
  const d = sys.byId.get(id);
  if (!d || d.removing || !(amount > 0)) return;
  if (!d.isLocal) {
    if (ctx.isMultiplayer) ctx.net?.send({ t: 'droneq', ev: 'damage', id, dmg: Math.round(amount * 100) / 100 }, d.owner as PeerId);
    return;
  }
  applyOwnDamage(sys, d, amount);
}

/** Applies damage on the owner side (shared by a local call and an incoming `droneq damage`). */
export function applyOwnDamage(sys: DroneSystem, d: Drone, amount: number): void {
  const ctx = sys.ctx;
  if (d.removing || !(amount > 0)) return;
  d.hp = Math.max(0, d.hp - Math.min(amount, d.maxHp));
  d.netDirty = true;
  d.fxPos.copy(d.position);
  ctx.bus.emit('audio:play', { id: 'drone_hit', position: d.fxPos, volume: 0.6 });
  ctx.bus.emit('drone:damaged', { id: d.id, hp: d.hp, maxHp: d.maxHp, own: true });
  if (d.hp <= 0) destroyOwn(sys, d);
}

function destroyOwn(sys: DroneSystem, d: Drone): void {
  const ctx = sys.ctx;
  destroyFx(sys, d);
  // One item is spent **on destruction** — bag + quick slots (`consumeWhere` looks at the wheel too,
  // CLAUDE.md's quick-slot section)
  const gid = DRONE_GADGET_OF[d.kind];
  ctx.inventory?.consumeWhere((def) => def.gadgetId === gid, 1);
  removeDrone(sys, d, 'destroyed', true);
}

/** A small explosion — pooled particles only (no lights). */
export function destroyFx(sys: DroneSystem, d: Drone): void {
  const ctx = sys.ctx;
  d.fxPos.copy(d.position);
  if (d.kind === 'ground') d.fxPos.y += d.height * 0.5;
  const fx = FxManager.get();
  if (fx) {
    ParticleBurst.sparks(fx.additive, d.fxPos, UP, 18, 6);
    ParticleBurst.fireball(fx.additive, d.fxPos, 12, 3.5, 0.45);
    ParticleBurst.smoke(fx.alpha, d.fxPos, 6, 0.5);
  }
  ctx.bus.emit('audio:play', { id: 'drone_destroyed', position: d.fxPos, volume: 0.85 });
  const p = ctx.player;
  if (p) {
    const k = 1 - p.position.distanceTo(d.fxPos) / 14;
    if (k > 0) ctx.bus.emit('camera:shake', { intensity: 0.1 + k * 0.25, duration: 0.25 });
  }
}

/** 2026-09-15 (user's decision): drones take the **same** two-step falloff as anything else (`shared/explosion`). */
export function applyExplosion(sys: DroneSystem, center: THREE.Vector3, radius: number, damage: number): void {
  if (!(radius > 0) || !(damage > 0)) return;
  for (let i = sys.drones.length - 1; i >= 0; i--) {
    const d = sys.drones[i];
    if (d.removing) continue;
    _l2.copy(d.position);
    if (d.kind === 'ground') _l2.y += d.height * 0.5;
    const dist = _l2.distanceTo(center);
    if (dist >= radius) continue;
    // 2026-09-18 (user's decision): wall · roof · floor occlusion — a ground drone uses 3 body points,
    // an air drone the single body centre
    if (d.kind === 'ground' ? !blastReachesBody(sys.ctx.world, center, d.position.x, d.position.y, d.position.z, d.height)
      : !blastReachesBody(sys.ctx.world, center, _l2.x, _l2.y, _l2.z, 0)) continue;
    damageDrone(sys, d.id, explosionDamage(damage, dist, radius), center);
  }
}

/* ═══════════════════════════ Recover · remove ═══════════════════════════ */
function registerRecover(sys: DroneSystem, d: Drone): void {
  const ctx = sys.ctx;
  const prompt = `${droneName(d.kind)} 회수`;
  const it: Interactable = {
    id: `drone:${d.id}`,
    position: d.position,
    radius: RECOVER_RADIUS + (d.kind === 'air' ? DRONE_RECOVER_AIR_BONUS : 0),
    getPrompt: () => prompt,
    canInteract: () => ctx.isGameplayActive() && !d.removing && !d.localControlled,
    interact: () => recover(sys, d),
    holdTime: DRONE_RECOVER_HOLD_S,
  };
  d.interactable = it;
  ctx.interactables.register(it);
}

function recover(sys: DroneSystem, d: Drone): void {
  if (d.removing || !d.isLocal || d.localControlled) return;
  d.fxPos.copy(d.position);
  sys.ctx.bus.emit('audio:play', { id: 'drone_recover', position: d.fxPos, volume: 0.7 });
  removeDrone(sys, d, 'recovered', true);
}

/** Removes it locally and, when `broadcast` and it is one of mine, tells the others as well. */
export function removeDrone(sys: DroneSystem, d: Drone, reason: 'destroyed' | 'recovered' | 'expired', broadcast: boolean): void {
  if (d.removing) return;
  const ctx = sys.ctx;
  if (sys.controlled === d) sys.releaseControl(reason === 'destroyed' ? 'destroyed' : 'reset');
  d.removing = true;
  if (d.interactable) { ctx.interactables.unregister(d.interactable.id); d.interactable = null; }
  const i = sys.drones.indexOf(d);
  if (i >= 0) sys.drones.splice(i, 1);
  sys.byId.delete(d.id);
  d.body.dispose();
  ctx.bus.emit('drone:removed', { id: d.id, kind: d.kind, reason });
  if (broadcast && d.isLocal) sendRemove(sys, d.id, reason);
}

export function removeOwnedBy(sys: DroneSystem, owner: PeerId): void {
  for (let i = sys.drones.length - 1; i >= 0; i--) {
    const d = sys.drones[i];
    if (d.owner === owner) removeDrone(sys, d, 'expired', false);
  }
  sys.syncAskedAt.delete(owner);
}

/**
 * Removes and disposes every drone (items are left alone). My own drones tell the squadmates still in the raid to
 * remove them.
 */
export function clear(sys: DroneSystem): void {
  sys.releaseControl('reset');
  for (let i = sys.drones.length - 1; i >= 0; i--) {
    const d = sys.drones[i];
    removeDrone(sys, d, 'expired', d.isLocal);
  }
  sys.holding = false;
  sys.holdT = 0;
  sys.syncAskedAt.clear();
}

/* ═══════════════════════════ Queries ═══════════════════════════ */
export function raycast(sys: DroneSystem, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, kind?: DroneKind): DroneRayHit | null {
  let best = maxDist;
  let hit: Drone | null = null;
  for (let i = 0; i < sys.drones.length; i++) {
    const d = sys.drones[i];
    if (d.removing || (kind && d.kind !== kind)) continue;
    const t = d.body.raycast(origin, dir, best);
    if (t >= 0 && t <= best) { best = t; hit = d; }
  }
  if (!hit) return null;
  const out = sys.rayHit ?? (sys.rayHit = { drone: hit, point: new THREE.Vector3(), distance: 0 });
  out.drone = hit;
  out.point.copy(origin).addScaledVector(dir, best);
  out.distance = best;
  return out;
}
