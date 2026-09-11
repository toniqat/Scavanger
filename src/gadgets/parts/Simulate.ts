/**
 * src/gadgets/parts/Simulate.ts — **배치물이 매 프레임 하는 일**.
 *
 * 지뢰 · 포탑 · 화염지대 · 유인탄 · 점프대의 동작. 화염지대는 **피아를 구분하지 않고**(설계대로)
 * 자기 주인에게 킬 크레딧을 준다. 점프대는 같은 사람을 `JUMP_PAD_RETRIGGER_S` 안에 다시 쏘지 않는다.
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
/* 2026-09-11: 원격 지뢰 · 드론 위 지뢰 */
import { GADGET_MOUNTED_MINE_TRIGGER_RADIUS, GADGET_REMOTE_MINE_ARM_TIME } from '@/shared';
import * as Remote from './Remote';

/* ═══════════════════════════ simulation (authority) ═══════════════════════════ */
export function updateArming(sys: GadgetSystem, d: Deployable): void {
  // 2026-09-11: 원격 지뢰의 첫 프레임 — 설치음 · 소유자당 상한 (Remote.initRemoteMine)
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
  const p = ctx.player;
  if (p && !p.isDead) {
    const dist = p.position.distanceTo(d.position);
    if (dist < radius) p.takeDamage(dmg * (1 - dist / radius) * 0.85, d.position.clone());
  }
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (r.isDead || r.stale) continue;
    const dist = r.position.distanceTo(d.position);
    if (dist < radius) sys.hurtRemote(r.id, dmg * (1 - dist / radius) * 0.85, d.position);
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
  if (victim) sys.hurtPlayer(victim, dmg, _b);
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
  for (const e of sys.enemiesNear(d.position, d.radius)) {
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
    sys.hurtRemote(r.id, GADGET_INCENDIARY_DPS * ZONE_TICK, d.position);
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
  if (dps > 0 && typeof p.setBurning === 'function') p.setBurning(dps, 1.2);

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
  const def = gadgetForKind(d.kind);
  const life = d.expires > 0 && def && def.duration > 0 ? THREE.MathUtils.clamp((d.expires - t) / def.duration, 0, 1) : 1;
  sys.visuals.animate(v, t, dt, d.armed, d.hpRatio, life);
  if (d.kind === 'remoteMine') Remote.updateBeep(sys, d, dt);
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

export function hurtPlayer(sys: GadgetSystem, victim: Victim, amount: number, from: THREE.Vector3): void {
  if (victim === 'local') sys.ctx.player?.takeDamage(amount, from.clone());
  else sys.hurtRemote(victim, amount, from);
  }

export function hurtRemote(sys: GadgetSystem, peer: PeerId, amount: number, from: THREE.Vector3): void {
  const net = sys.ctx.net;
  if (!net || !sys.ctx.isMultiplayer) return;
  net.send({ t: 'dmg', amount, from: toTuple(from) }, peer);
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
