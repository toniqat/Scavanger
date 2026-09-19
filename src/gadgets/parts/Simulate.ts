/**
 * src/gadgets/parts/Simulate.ts — **what a deployable does every frame**.
 *
 * The behaviour of the mine · turret · fire zone · lure · jump pad. The fire zone has **no friend-or-foe
 * check** (by design) and gives its kill credit to its own owner. A jump pad never launches the same person
 * twice inside `JUMP_PAD_RETRIGGER_S`.
 */
import * as THREE from 'three';
import {
  GADGET_DEFUSE_TIME, GADGET_INCENDIARY_DPS, GADGET_JUMPPAD_FORWARD, GADGET_JUMPPAD_IMPULSE,
  GADGET_CLOAK_SHARE_RADIUS, GADGET_LURE_RADIUS, GADGET_MINE_ARM_TIME, GADGET_MINE_DAMAGE, GADGET_TURRET_DPS, JUMP_PAD_RETRIGGER_S, Keys, PLAYER_RADIUS,
  type BuffMessage, type DeployableKind, type DeployableRef, type EnemyRef, type FlowMessage, type GadgetDef,
  type GadgetId, type GadgetMessage, type GadgetRequest, type GameContext, type GameSystem, type GadgetsRef,
  type Interactable, type ItemInstance, type DeployableWire, type PeerId, type PlayerWeaponHost, type Vec3Tuple,
} from '@/shared';
import { GADGET_DEFS, gadgetDef, gadgetForKind, isRecoverable } from '../GadgetDefs';
import { Deployable, BARRICADE_HALF, DOME_UNFOLD_TIME, JUMPPAD_TRIGGER_RADIUS, MINE_TRIGGER_RADIUS } from '../Deployable';
import { GadgetVisualPool } from '../GadgetVisuals';
import { ThrownGadgetManager } from '../ThrownGadget';
import { EMPTY_ENEMIES, MAX_DEPLOYABLES, PLACE_CLEARANCE, PLACE_DISTANCE, PLAYER_HALF_H, RECOVER_RADIUS, TURRET_AIM_CONE, TURRET_RETARGET, TURRET_ROF, TURRET_TURN_RATE, USE_COOLDOWN, type Victim, ZONE_TICK, _a, _b, _c, _d, _e, _fwd, _g0, _g1, _g2, _r0, _r1, _r2, _r3, _r4, angleDelta, toTuple } from '../model';
import type { GadgetSystem } from '../GadgetSystem';
/* 2026-09-11: the remote mine · a mine mounted on a drone */
import { GADGET_MOUNTED_MINE_TRIGGER_RADIUS, GADGET_REMOTE_MINE_ARM_TIME } from '@/shared';
/* 2026-09-15 (B-16): the fire zone — the crackle sound · drones */
import { FIRE_ZONE_CRACKLE_S, FIRE_ZONE_DRONE_HEIGHT } from '@/shared';
/* 2026-09-15 (user's decision): the two-step blast falloff — shared by every explosive */
import { PLAYER_HEIGHT, blastReachesBody, explosionDamage } from '@/shared';
import * as Remote from './Remote';
import * as Thumper from './Thumper';
import type { DamageSourceWire, PlayerDamageSource } from '@/shared';

/* ═══════════════════════════ simulation (authority) ═══════════════════════════ */
export function updateArming(sys: GadgetSystem, d: Deployable): void {
  // 2026-09-11: a remote mine's first frame — the place sound · the per-owner cap (Remote.initRemoteMine)
  if (d.kind === 'remoteMine' && !d.remoteInit) Remote.initRemoteMine(sys, d);
  if (d.armed || d.removing) return;
  const need = d.kind === 'mine' ? GADGET_MINE_ARM_TIME : d.kind === 'remoteMine' ? GADGET_REMOTE_MINE_ARM_TIME : DOME_UNFOLD_TIME;
  if (d.age < need) return;
  d.armed = true;
  if (d.kind === 'mine') sys.ctx.bus.emit('audio:play', { id: 'mine_arm', position: d.position, volume: 0.7 });
  else if (d.kind === 'remoteMine') sys.ctx.bus.emit('audio:play', { id: 'c4_arm', position: d.position, volume: 0.6 });
  if (sys.ctx.isAuthority) sys.broadcast({ t: 'gad', ev: 'update', id: d.id, hp: d.hp, armed: true }, 'others');
  }

export function simulate(sys: GadgetSystem, d: Deployable, dt: number, ctx: GameContext): void {
  switch (d.kind) {
    case 'mine': if (d.armed) sys.updateMine(d, ctx); break;
    case 'turret': sys.updateTurret(d, dt, ctx); break;
    case 'fire': sys.updateFireZone(d, dt, ctx); break;
    case 'lure': sys.updateLure(d, dt, ctx); break;
    default: break;
  }
  }

export function updateMine(sys: GadgetSystem, d: Deployable, ctx: GameContext): void {
  // 2026-09-11: a mine riding a drone reacts to **enemies only** (3D, around the drone's mount point) — squadmates,
  // players and the carrying drone itself never set it off. The ground mine rule below is unchanged.
  const mount = (d as DeployableRef).mount;
  if (mount) {
    const drone = ctx.drones?.getDrone(mount);
    const at = drone ? drone.getMountPoint(_d) : d.position;
    for (const e of sys.enemiesNear(at, GADGET_MOUNTED_MINE_TRIGGER_RADIUS)) {
      if (e.isDead) continue;
      sys.explodeMine(d, ctx);
      return;
    }
    return;
  }
  // friend or foe: anything that walks close enough sets it off
  for (const e of sys.enemiesNear(d.position, MINE_TRIGGER_RADIUS)) {
    if (e.isDead) continue;
    sys.explodeMine(d, ctx);
    return;
  }
  const p = ctx.player;
  if (p && !p.isDead && p.position.distanceTo(d.position) <= MINE_TRIGGER_RADIUS + PLAYER_RADIUS) { sys.explodeMine(d, ctx); return; }
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (r.isDead || r.stale) continue;
    if (r.position.distanceTo(d.position) <= MINE_TRIGGER_RADIUS + PLAYER_RADIUS) { sys.explodeMine(d, ctx); return; }
  }
  }

export function explodeMine(sys: GadgetSystem, d: Deployable, ctx: GameContext): void {
  const radius = d.radius;
  const dmg = GADGET_MINE_DAMAGE;
  // 2026-09-11: credit the placer by id like the fire zone does (`applyAreaDamage.by` is a PeerId | 'local' — it used
  // to get the lobby display name, which `normalizeAttacker` cannot resolve)
  sys.damageEnemies(d.position, radius, dmg, String(d.owner));
  // 2026-09-11: drones in the blast (a mine riding a drone sits at the centre, so its carrier is destroyed)
  ctx.drones?.applyExplosion(d.position, radius, dmg);
  // players (no friend-or-foe check, the owner included)
  // 2026-09-15 (user's decision): the falloff is the shared two-step one (`shared/explosion`); the mine's
  // 0.85 anti-personnel share is unchanged
  const p = ctx.player;
  if (p && !p.isDead) {
    const dist = p.position.distanceTo(d.position);
    // 2026-09-18 (user's decision): nothing behind a wall · roof · floor is hit (three points on the body)
    if (dist < radius && blastReachesBody(ctx.world, d.position, p.position.x, p.position.y, p.position.z, PLAYER_HEIGHT)) p.takeDamage(explosionDamage(dmg, dist, radius) * 0.85, d.position.clone(), Remote.localVictimSource(sys, d.owner));
  }
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (r.isDead || r.stale) continue;
    const dist = r.position.distanceTo(d.position);
    if (dist < radius && blastReachesBody(ctx.world, d.position, r.position.x, r.position.y, r.position.z, PLAYER_HEIGHT)) sys.hurtRemote(r.id, explosionDamage(dmg, dist, radius) * 0.85, d.position, Remote.remoteVictimWire(d.owner, r.id));
  }
  sys.blastFx(d.position, radius);
  sys.remove(d, 'destroyed');
  }

export function updateTurret(sys: GadgetSystem, d: Deployable, dt: number, ctx: GameContext): void {
  d.fireTimer -= dt;
  d.tickTimer -= dt;
  let target: EnemyRef | null = null;
  if (d.tickTimer <= 0 || d.targetId === null) {
    d.tickTimer = TURRET_RETARGET;
    let bestD = Infinity;
    for (const e of sys.enemiesNear(d.position, d.radius)) {
      if (e.isDead) continue;
      const dist = e.position.distanceToSquared(d.position);
      if (dist < bestD) { bestD = dist; target = e; }
    }
    d.targetId = target?.id ?? null;
  } else {
    target = sys.enemyById(d.targetId);
    if (!target || target.isDead || target.position.distanceTo(d.position) > d.radius) { d.targetId = null; target = null; }
  }
  if (!target) return;

  _a.copy(target.position); _a.y += target.height * 0.5;
  _b.copy(d.position); _b.y += 0.75;
  _c.subVectors(_a, _b);
  const want = Math.atan2(-_c.x, -_c.z);
  const delta = angleDelta(d.headYaw, want);
  const step = TURRET_TURN_RATE * dt;
  d.headYaw += THREE.MathUtils.clamp(delta, -step, step);
  if (Math.abs(delta) > TURRET_AIM_CONE || d.fireTimer > 0) return;

  d.fireTimer = 1 / TURRET_ROF;
  const dmg = GADGET_TURRET_DPS / TURRET_ROF;
  // friendly fire: whoever stands in the firing line eats the burst instead
  const victim = sys.playerAlongRay(_b, _a);
  if (victim) sys.hurtPlayer(victim, dmg, _b, d.owner);
  else target.takeDamage(dmg, _a.clone(), _c.clone().normalize());
  sys.visuals.flash(d.visual);
  sys.broadcast({ t: 'gad', ev: 'fire', id: d.id, target: toTuple(_a) }, 'others');
  ctx.bus.emit('audio:play', { id: 'turret_fire', position: d.position, volume: 0.55 });
  }

export function updateFireZone(sys: GadgetSystem, d: Deployable, dt: number, ctx: GameContext): void {
  d.tickTimer -= dt;
  if (d.tickTimer > 0) return;
  d.tickTimer = ZONE_TICK;
  const enemies = ctx.enemies;
  /* 2026-09-18: this is a place that **deals damage**, so nest eggs count too (`includeProps` true).
   * `enemiesNear` leaves eggs out by default because its callers ask "pick a target" or "is something
   * dangerous here" — burning is not that question. A mine blast (`applyAreaDamage`) already breaks eggs, so
   * leaving them out here would let the same egg break to an explosion but not to fire. */
  for (const e of sys.enemiesNear(d.position, d.radius, true)) {
    if (e.isDead) continue;
    // Phase 9: the fire's owner gets the burn kill credit (`enemy:killed.by`)
    if (enemies && typeof enemies.applyStatus === 'function') enemies.applyStatus(e.id, 'burning', GADGET_INCENDIARY_DPS, ZONE_TICK * 2.4, d.owner);
    else e.takeDamage(GADGET_INCENDIARY_DPS * ZONE_TICK);
  }
  // remote players burn too (no friend-or-foe check); the local player is handled by updateLocalEffects on every client
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (r.isDead || r.stale) continue;
    const dx = r.position.x - d.position.x, dz = r.position.z - d.position.z;
    if (dx * dx + dz * dz > d.radius * d.radius) continue;
    sys.hurtRemote(r.id, GADGET_INCENDIARY_DPS * ZONE_TICK, d.position, Remote.remoteVictimWire(d.owner, r.id));
  }
  // 2026-09-15 (B-16): drones burn too — horizontally inside the zone and within FIRE_ZONE_DRONE_HEIGHT of its floor (a ground drone
  // always, an air drone only while it hovers low). `damageDrone` routes a squadmate's drone to its owner (`droneq damage`).
  const drones = ctx.drones;
  if (drones) {
    const r2 = d.radius * d.radius;
    for (const dr of drones.getDrones()) {
      if (dr.hp <= 0) continue;
      const dx = dr.position.x - d.position.x, dz = dr.position.z - d.position.z;
      if (dx * dx + dz * dz > r2) continue;
      if (Math.abs(dr.position.y - d.position.y) >= FIRE_ZONE_DRONE_HEIGHT) continue;
      drones.damageDrone(dr.id, GADGET_INCENDIARY_DPS * ZONE_TICK, d.position);
    }
  }
  }

export function updateLure(sys: GadgetSystem, d: Deployable, dt: number, ctx: GameContext): void {
  d.tickTimer -= dt;
  if (d.tickTimer > 0) return;
  d.tickTimer = ZONE_TICK;
  const enemies = ctx.enemies;
  if (enemies && typeof enemies.addDistraction === 'function') {
    enemies.addDistraction(d.position, Math.max(d.radius, GADGET_LURE_RADIUS), ZONE_TICK * 2.2, 0.85);
  }
  ctx.bus.emit('audio:play', { id: 'lure_beep', position: d.position, volume: 0.4 });
  }

/* ═══════════════════════════ local (every client) ═══════════════════════════ */
export function updateLocalEffects(sys: GadgetSystem, dt: number, ctx: GameContext): void {
  const p = ctx.player;
  if (!p || p.isDead || !ctx.isGameplayPhase()) return;
  // fire zones burn whoever stands in them, friend or foe. Each client applies it to its own player so the
  // effect stays responsive and does not depend on a `dmg` round trip.
  const dps = sys.fireDamageAt(p.position);
  if (dps > 0 && typeof p.setBurning === 'function') p.setBurning(dps, 1.2, fireZoneSourceAt(sys, p.position));

  const pad = sys.jumpPadAt(p.position) as Deployable | null;
  // per-player re-trigger gate (Phase 9): the same pad launches this player again only after JUMP_PAD_RETRIGGER_S
  if (pad && pad.padCooldown <= 0 && (pad.padNext.get('local') ?? 0) <= ctx.time && typeof p.applyImpulse === 'function') {
    pad.padNext.set('local', ctx.time + JUMP_PAD_RETRIGGER_S);
    pad.padCooldown = Math.max(dt, 1e-3);   // same-frame guard only
    _d.set(0, GADGET_JUMPPAD_IMPULSE, 0);
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    if (p.isSprinting || speed > 3.5) {
      _e.set(p.velocity.x, 0, p.velocity.z);
      if (_e.lengthSq() < 0.01) p.getForward(_e);
      _e.normalize().multiplyScalar(GADGET_JUMPPAD_FORWARD);
      _d.add(_e);
    }
    p.applyImpulse(_d);
    sys.visuals.pulse(pad.position, gadgetDef('jumpPad')?.color ?? '#5fd7ff', 0.6, 3, 0.4);
    ctx.bus.emit('audio:play', { id: 'jumppad', position: pad.position, volume: 0.9 });
  }
  }

/* ═══════════════════════════ animation ═══════════════════════════ */
export function animate(sys: GadgetSystem, d: Deployable, t: number, dt: number): void {
  const v = d.visual;
  v.root.position.copy(d.position);
  v.root.rotation.y = d.yaw;
  if (v.head) v.head.rotation.y = d.headYaw - d.yaw;
  // 2026-09-15: the deployable's own gadget first — `fire` is produced by two defs (`화염수류탄` 10 s ·
  // the G-10 fire zone 6 s)
  const def = gadgetDef(d.gadgetId) ?? gadgetForKind(d.kind);
  const life = d.expires > 0 && def && def.duration > 0 ? THREE.MathUtils.clamp((d.expires - t) / def.duration, 0, 1) : 1;
  // 2026-09-15 (the thumper, parts/Thumper): every client counts the strikes from `age` — the hammer phase
  // goes to visual.phase, and the FX · summon happen at the moment of a strike
  if (d.kind === 'thumper') Thumper.tick(sys, d, dt);
  sys.visuals.animate(v, t, dt, d.armed, d.hpRatio, life);
  if (d.kind === 'remoteMine') Remote.updateBeep(sys, d, dt);
  // 2026-09-15 (B-16): a burning zone crackles every FIRE_ZONE_CRACKLE_S on every client (local sound, no wire). The first one is
  // FIRE_ZONE_CRACKLE_S after `fire_ignite` (spawnDeployable seeds the timer).
  if (d.kind === 'fire' && dt > 0) {
    d.crackleTimer -= dt;
    if (d.crackleTimer <= 0) {
      d.crackleTimer = FIRE_ZONE_CRACKLE_S;
      sys.ctx.bus.emit('audio:play', { id: 'fire_crackle', position: d.position, volume: 0.55 });
    }
  }
  }

/* ═══════════════════════════ damage ═══════════════════════════ */
export function onDeployableDamage(sys: GadgetSystem, d: Deployable, amount: number, from?: THREE.Vector3): void {
  const ctx = sys.ctx;
  if (!ctx.isAuthority) {
    if (ctx.isMultiplayer && ctx.net) ctx.net.send({ t: 'gadq', ev: 'damage', id: d.id, dmg: amount }, 'host');
    return;
  }
  d.hp = Math.max(0, d.hp - amount);
  ctx.bus.emit('gadget:damaged', { id: d.id, hp: d.hp, maxHp: d.maxHp });
  if (d.kind === 'domeShield' || d.kind === 'barricade') {
    ctx.bus.emit('audio:play', { id: 'shield_hit', position: from ?? d.position, volume: 0.5 });
  }
  if (d.hp <= 0) {
    if (d.kind === 'mine') { sys.explodeMine(d, ctx); return; }
    // 2026-09-11: a broken remote mine never detonates. Replicas tell a fizzle from a detonation by hp, so hp 0 goes out
    // (unthrottled) right before the removal — see Wire `gad remove`.
    if (d.kind === 'remoteMine') sys.broadcast({ t: 'gad', ev: 'update', id: d.id, hp: 0, armed: d.armed }, 'others');
    sys.blastFx(d.position, Math.min(d.radius, 3), 0.4);
    ctx.bus.emit('audio:play', { id: 'gadget_break', position: d.position, volume: 0.8 });
    sys.remove(d, 'destroyed');
    return;
  }
  if (d.netCooldown <= 0) {
    d.netCooldown = 0.2;
    sys.broadcast({ t: 'gad', ev: 'update', id: d.id, hp: d.hp, armed: d.armed }, 'others');
  }
  }

export function damageEnemies(sys: GadgetSystem, center: THREE.Vector3, radius: number, damage: number, by?: string): void {
  const enemies = sys.ctx.enemies;
  if (!enemies) return;
  if (typeof enemies.applyAreaDamage === 'function') enemies.applyAreaDamage(center, radius, damage, by);
  else enemies.applyExplosion(center, radius, damage);
  }

/**
 * 2026-09-15 (the results screen rework): `owner` = the owner of the deployable that fired → a `self` /
 * `ally` source judged from the victim's side (omitted = unknown).
 */
export function hurtPlayer(sys: GadgetSystem, victim: Victim, amount: number, from: THREE.Vector3, owner?: PeerId | 'local'): void {
  if (victim === 'local') sys.ctx.player?.takeDamage(amount, from.clone(), owner !== undefined ? Remote.localVictimSource(sys, owner) : undefined);
  else sys.hurtRemote(victim, amount, from, owner !== undefined ? Remote.remoteVictimWire(owner, victim) : undefined);
  }

/**
 * 2026-09-15 (the results screen rework): `src` = `dmg.src` (the source judged from the victim's side — an
 * older client ignores it).
 */
export function hurtRemote(sys: GadgetSystem, peer: PeerId, amount: number, from: THREE.Vector3, src?: DamageSourceWire): void {
  const net = sys.ctx.net;
  if (!net || !sys.ctx.isMultiplayer) return;
  net.send(src ? { t: 'dmg', amount, from: toTuple(from), src } : { t: 'dmg', amount, from: toTuple(from) }, peer);
  }

/**
 * 2026-09-15 (the results screen rework): the source of the fire zone the local player stands in — it sweeps
 * with the same conditions as `Queries.fireDamageAt` and answers `ally` if even one of the fires was lit by a
 * squadmate, `self` when they are all mine. It is called only inside a fire zone (`dps > 0`) and allocates
 * nothing.
 */
function fireZoneSourceAt(sys: GadgetSystem, pos: THREE.Vector3): PlayerDamageSource {
  for (const d of sys.deployables) {
    if (d.removing || d.kind !== 'fire') continue;
    const dx = pos.x - d.position.x, dz = pos.z - d.position.z;
    if (dx * dx + dz * dz > d.radius * d.radius) continue;
    if (Math.abs(pos.y - d.position.y) > 3.5) continue;
    if (!Remote.isLocalOwner(sys, d.owner)) return Remote.ALLY_DAMAGE_SOURCE;
  }
  return Remote.SELF_DAMAGE_SOURCE;
  }

export function blastFx(sys: GadgetSystem, position: THREE.Vector3, radius: number, shake = 1): void {
  const ctx = sys.ctx;
  sys.visuals.pulse(position, '#ffb14a', 0.5, radius * 1.2, 0.55);
  sys.visuals.pulse(position, '#ff5a3c', 0.3, radius * 0.7, 0.35);
  ctx.bus.emit('audio:play', { id: 'explosion', position, volume: 0.9 });
  const p = ctx.player;
  if (p) {
    const dist = p.position.distanceTo(position);
    const k = THREE.MathUtils.clamp(1 - dist / 26, 0, 1) * shake;
    if (k > 0) ctx.bus.emit('camera:shake', { intensity: 0.2 + k * 0.7, duration: 0.4 });
  }
  }
