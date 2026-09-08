/**
 * src/enemies/parts/Damage.ts — **적이 피해를 입는 모든 경로**.
 *
 * 히트스캔 · 폭발 · 광역 · 리플리카의 `hit` 요청이 전부 여기로 모여 `applyDamage` 하나로 수렴하고,
 * 죽으면 시체 등록(`registerCorpse`, `CORPSE_LOOT_CHANCE` 추첨)까지 이어진다.
 * 배리어 판정(`resolveBarrier` / `absorbedByShield`)도 여기 있다 — 방패는 **적을 막는 벽**이자
 * 정면 근접을 대신 받는 면이라 피해 경로의 일부다.
 */
import * as THREE from 'three';
import {
  BEHEMOTH_KNOCKBACK, BURNOUT_DURATION, CORPSE_LAND_TIMEOUT, CORPSE_LIFETIME, ENEMY_DEATH_DIRS, ENEMY_SHOT_ALERT_DIST, ENEMY_SHOT_IMPACT_DIST, ENEMY_STATUS_BITS, FLAME_AFTERBURN_DPS, FLAME_AFTERBURN_DURATION, GADGET_LURE_RADIUS, MAP_SIZE,
  NET_ENEMY_SNAPSHOT_HZ, PLAYER_HEIGHT, PLAYER_RADIUS, ROGUE_DAMAGE, ROGUE_GRENADE_DAMAGE, ROGUE_GRENADE_FUSE, ROGUE_GRENADE_RADIUS, ROGUE_MAG_ROUNDS, ROGUE_RANGE,
  SHELL_BLAST_RADIUS, SHELL_DAMAGE, SHELL_FLIGHT_TIME, SHOCK_SLOW_DURATION, SHOCK_SLOW_FACTOR, TOXIC_DAMAGE, TOXIC_RADIUS, getPlanet,
  type DamageMessage, type EnemyDeathDir, type EnemyEvent, type EnemyFaction, type EnemyHit, type EnemyManagerRef, type EnemyRef, type EnemySnapshot, type EnemyStatusKind, type EnemyType, type GameContext, type GameSystem,
  type HitRequest, type InterceptableRef, type PeerId, type PlanetEcosystem, type ShotReport, type Vec3Tuple, type WorldRef,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { Enemy, type EnemyHost, type HitPart } from '../Enemy';
import { ROGUE_AI, SPEWER_SPIT } from '../EnemyTypes';
import { SpatialGrid } from '../SpatialGrid';
import { CombatTarget, TargetList, type TargetId } from '../Targets';
import { SUSPICION_TIME, updateEnemyAI } from '../ai/EnemyAI';
import { LureField } from '../ai/Lures';
import { becomeAlert, canPerceive } from '../ai/Perception';
import { beginInvestigation, endInvestigation } from '../ai/Investigate';
import { BloodFX } from '../fx/BloodFX';
import { EnemyXray } from '../fx/Xray';
import { AcidProjectiles, type AcidHost, type AcidSlow } from '../fx/AcidProjectile';
import { ShellProjectiles, type ShellHost } from '../fx/ShellProjectile';
import { RogueGrenades, type GrenadeHost } from '../fx/RogueGrenade';
import { AmbientSpawner, ambientGroup, waveGroup, type SpawnHost } from '../Spawner';
import { WaveDirector } from '../WaveDirector';
import { disposeBugAssets } from '../models/BugModel';
import { disposeRogueAssets } from '../models/RogueModel';
import { EnemyReplica, type ReplicaHost } from '../net/Replica';
import { animHint, encodeSnapshot, round, SnapshotCache, tuple } from '../net/HostSync';
import { CorpseManager, rollCorpseLootable, type CorpseWireOpts } from '../Corpses';
import { placeRogueGuards, type RogueSpawnHost } from '../RogueGuards';
import { raySphere, rayCapsule, rayStandingCapsule } from '../RayTests';
import { BARRIER_BUMP_INTERVAL, BARRIER_RETARGET_S, BURN_TICK, CLASH_RADIUS, CLASH_THROTTLE, CORPSE_SLACK, EMBER_INTERVAL, FLEE_DURATION, GRENADE_KNOCKBACK, GRENADE_LOB_SPEED, GRENADE_NOISE, GUNFIRE_LURE_DURATION, GUNFIRE_LURE_WEIGHT, INCAP_EMBER_INTERVAL, MAX_REQUEST_DAMAGE, MAX_REQUEST_RADIUS, MAX_SHOT_RANGE, MAX_STATUS_DURATION, PROMOTE_ID_GAP, PROMOTE_SEQ_GAP, RECYCLE_DISTANCE, SHIELD_CONTACT_Y, SHOCK_SPARK_TIME, SHOT_CHECK_INTERVAL, SPARK_INTERVAL, STATUS_REQUEST_INTERVAL, SUSPICION_RADIUS, SUSPICION_REFRESH, _aim, _c, _dir, _eye, _hc, _hd, _hp, _kb, _m, _sd, _sh, _so, _to, _v, _v2, _zero, deathDirIndex, isVec3Tuple, killedBuf, queryBuf } from '../model';
import type { EnemySystem } from '../EnemySystem';

/** Radial damage. On a replica this only plays local FX and forwards an `ExplodeRequest` to the host (returns 0). */
export function applyExplosion(sys: EnemySystem, center: THREE.Vector3, radius: number, damage: number): number {
  if (sys.replica) {
    for (let i = 0; i < sys.active.length; i++) {
      const e = sys.active[i];
      if (!e.active || e.state === 'dead') continue;
      _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
      if (_v.distanceToSquared(center) < radius * radius) {
        _v2.subVectors(_v, center);
        if (_v2.lengthSq() < 1e-4) _v2.set(0, 1, 0); else _v2.normalize();
        sys.fx?.burst(_v, 6, 'blood', 5, _v2, 0.6);
        e.anim.hitFlash = 1;
      }
    }
    sys.ctx.net?.send({ t: 'explode', p: tuple(center, 2), r: round(radius, 2), dmg: round(damage, 1) }, 'host');
    return 0;
  }
  return sys.explode(center, radius, damage, 'local', null, null);
  }

/** `skipFaction` (Phase 7): enemies of that faction are spared (a rogue grenade hurts bugs, not the rogues). */
export function explode(sys: EnemySystem, center: THREE.Vector3, radius: number, damage: number, attacker: TargetId, killedOut: Enemy[] | null, exclude: Enemy | null, skipFaction: EnemyFaction | null = null): number {
  let kills = 0;
  const r2 = radius * radius;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (e === exclude || !e.active || e.state === 'dead') continue;
    if (skipFaction !== null && e.faction === skipFaction) continue;
    _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
    const d2 = _v.distanceToSquared(center);
    const reach = radius + e.stats.radius;
    if (d2 > reach * reach) continue;
    const d = Math.sqrt(d2);
    const falloff = 1 - Math.max(0, d - e.stats.radius) / radius;
    const dmg = damage * THREE.MathUtils.clamp(falloff, 0.15, 1);
    _v2.subVectors(_v, center);
    if (_v2.lengthSq() < 1e-4) _v2.set(0, 1, 0); else _v2.normalize();
    // explosions are omnidirectional: no head/rear multipliers (hitPoint at capsule center, dir ignored for part)
    e.takeDamage(dmg, undefined, undefined, attacker);
    const killed = e.hp <= 0;
    if (killed) { kills++; killedOut?.push(e); }
    else if (dmg > e.maxHp * 0.1 && e.chargePhase !== 2) {
      // knock-back nudge
      e.velocity.addScaledVector(_v2, 6 * (1 - d / reach));
    }
    if (d2 < r2) sys.fx?.burst(_v, 6, 'blood', 5, _v2, 0.6);
  }
  return kills;
  }

export function applyAreaDamage(sys: EnemySystem, center: THREE.Vector3, radius: number, damage: number, by?: string): number {
  if (sys.replica) return sys.applyExplosion(center, radius, damage);
  return sys.explode(center, radius, damage, by === undefined ? 'local' : sys.normalizeAttacker(by), null, null);
  }

/**
 * Phase 12 (실드 배쉬 knockback, requested by implants/): shove enemies away from `center`. Every alive enemy within
 * `radius` gets a horizontal impulse of `speed` m/s (falling off linearly to 40 % at the rim) away from the centre —
 * the same `velocity` nudge an explosion applies, so the existing steering / stumble rules absorb it (a charging
 * behemoth is **not** shoved, exactly like an explosion). Returns how many were pushed.
 *
 * **Not** on `EnemyManagerRef` — that interface is frozen for Phase 12, so callers reach it as
 * `(ctx.enemies as unknown as { pushBack?: … }).pushBack?.(…)`. Authority only: a replica's velocity is overwritten
 * by the next snapshot, and the host already shoves its own copy, so this returns 0 there.
 */
export function pushBack(sys: EnemySystem, center: THREE.Vector3, radius: number, speed: number, dir?: THREE.Vector3): number {
  if (!sys.authority || !(radius > 0) || !(speed > 0)) return 0;
  let n = 0;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.isCombatant || e.chargePhase === 2) continue;
    _v.set(e.position.x - center.x, 0, e.position.z - center.z);
    const d = _v.length();
    const reach = radius + e.stats.radius;
    if (d > reach) continue;
    if (dir) _v.copy(dir).setY(0);
    if (_v.lengthSq() < 1e-4) e.facing(_v).negate();
    _v.normalize();
    e.velocity.addScaledVector(_v, speed * THREE.MathUtils.clamp(1 - d / reach, 0.4, 1));
    n++;
  }
  return n;
  }

/**
 * Phase 9: other folders name the local player by its peer id (`ctx.net.localId ?? 'local'`); the kill-credit rules
 * key on `'local'`, so fold our own id back before it lands in `lastDamager` / `burnAttacker`.
 */
export function normalizeAttacker(sys: EnemySystem, by: string): TargetId {
  if (by === 'local' || by === 'ai') return by;
  const me = sys.ctx.net?.localId;
  return me !== undefined && me !== null && by === me ? 'local' : (by as PeerId);
  }

/* ── client → host requests (authority only) ───────────────────────────── */
/** `hit` from a client: damage (as before) and / or the status bits (`st` + `dur`, 2026-09-06; `dmg` may be 0 for a status-only request). */
export function onHitRequest(sys: EnemySystem, msg: HitRequest, from: string): void {
  if (!sys.hosting) return;
  const { id, dmg, p, d } = msg;
  const st = msg.st ?? 0;
  if (!(dmg >= 0) || dmg > MAX_REQUEST_DAMAGE) return;
  if (dmg <= 0 && st === 0) return;
  const e = sys.byId.get(id);
  if (!e || !e.active || e.state === 'dead') return;
  if (dmg > 0) {
    _hp.set(p[0], p[1], p[2]);
    _hd.set(d[0], d[1], d[2]);
    const dir = _hd.lengthSq() > 0.5 ? _hd : undefined;
    const part = e.classifyHit(_hp, dir);
    const before = e.hp;
    e.takeDamage(dmg, _hp, dir, from);
    sys.ctx.net!.send({ t: 'hitc', id: e.id, dmg: round(before - e.hp, 1), killed: e.isDead, part }, from);
  }
  if (st !== 0 && !e.isDead) sys.applyStatusBits(e, st, msg.dur, from);
  }

export function onExplodeRequest(sys: EnemySystem, p: readonly number[], r: number, dmg: number, from: string): void {
  if (!sys.hosting) return;
  if (!(dmg > 0) || dmg > MAX_REQUEST_DAMAGE || !(r > 0) || r > MAX_REQUEST_RADIUS) return;
  _c.set(p[0], p[1], p[2]);
  killedBuf.length = 0;
  sys.explode(_c, r, dmg, from, killedBuf, null);
  const net = sys.ctx.net!;
  for (let i = 0; i < killedBuf.length; i++) {
    const e = killedBuf[i];
    net.send({ t: 'hitc', id: e.id, dmg: round(e.maxHp, 1), killed: true, part: 'body' }, from);
  }
  killedBuf.length = 0;
  }

export function hitTarget(sys: EnemySystem, e: Enemy, damage: number, shake = 0, target: CombatTarget | null = e.target): void {
  if (!target || target.isDeadOrDowned) return;
  sys.applyDamage(target, damage, e.position, e.id, e.type, null, shake, true, null, 0, true);
  sys.playAudio('bug_attack', e.position, 1, sys.bitePitch(e.type));
  }

/* ── behemoth ──────────────────────────────────────────────────────────── */
export function chargeHit(sys: EnemySystem, e: Enemy, target: CombatTarget, damage: number, knockDir: THREE.Vector3): void {
  if (target.isDeadOrDowned) return;
  // local: applyKnockback; remote: `dmg.kb` (Phase 7); suspended: `ghost:damage.kb`
  sys.applyDamage(target, damage, e.position, e.id, e.type, null, 1.0, true, knockDir, BEHEMOTH_KNOCKBACK, true);
  sys.playAudio('bug_attack', e.position, 1, 0.4);
  }

/* ── AcidHost ──────────────────────────────────────────────────────────── */
export function damageTargetAcid(sys: EnemySystem, target: CombatTarget, amount: number, from: THREE.Vector3, shooterId: number, slow: AcidSlow): void {
  if (!sys.authority || target.isDeadOrDowned) return;
  // Phase 9: acid that crossed a 배리어 on its way in is stopped by it (checked once at the hit, from the spewer's mouth
  // for a direct glob and from the splash point for the splash — the glob itself keeps flying visually)
  const shooter = sys.byId.get(shooterId);
  if (shooter && slow.factor <= 0.6) _v.set(shooter.position.x, shooter.position.y + shooter.stats.height * 0.7, shooter.position.z);
  else _v.copy(from);
  if (sys.barrierBlocks(_v, target)) return;
  sys.applyDamage(target, amount, from, shooterId, 'spewer', slow, 0, false);
  }

/**
 * Phase 9: does a 배리어 stand between `from` and the target's chest? If so the barrier takes the block damage
 * (`ImplantsRef.damageBarrier`) and the caller deals none. One pure raycast per call — call it per hit, never per tick.
 */
export function barrierBlocks(sys: EnemySystem, from: THREE.Vector3, target: CombatTarget): boolean {
  const imp = sys.ctx.implants;
  if (!imp) return false;
  target.getChest(_aim);
  _dir.subVectors(_aim, from);
  const d = _dir.length();
  if (d < 1e-3) return false;
  _dir.multiplyScalar(1 / d);
  const bh = imp.raycastBarrier(from, _dir, d, true);
  if (!bh) return false;
  imp.damageBarrier(bh.owner, bh.point);
  return true;
  }

/**
 * Route damage to a target. Local player → `ctx.player.takeDamage` + `enemy:attacked` (+ slow / shake).
 * Remote player → `dmg` message to that peer (net applies it there) and, when `announce`, an `ee attack` to everyone
 * else so they hear the bite (the victim mirrors `enemy:attacked` from it).
 * Phase 4: an enemy target (`target.enemy`) takes `takeDamage(…, 'ai')` — no kill credit, faction clash toast.
 * Phase 7: `kbDir` / `kbSpeed` = knockback (behemoth charge, grenade blast): local → `applyKnockback`, remote →
 * `dmg.kb`; a **suspended** member (host-simulated ghost) gets `ghost:damage {id, amount, from, kb}` on the bus
 * instead of a `dmg` message.
 * Phase 12: `melee` = a bite / leap / charge contact. Before it lands on a player the raised 배리어 of that player
 * gets to absorb it (`ImplantsRef.absorbFrontalAttack`): the local carrier's shield is deducted by implants right
 * there, a peer's carrier gets `ee barrierHit` (its own shield takes it) and no `dmg`. Ranged attacks (rifle,
 * shell, acid, grenade) keep the `raycastBarrier` path of their callers.
 */
export function applyDamage(sys: EnemySystem, target: CombatTarget, amount: number, from: THREE.Vector3, id: number, type: EnemyType, slow: AcidSlow | null, shake: number, announce: boolean, kbDir: THREE.Vector3 | null = null, kbSpeed = 0, melee = false): void {
  if (target.isDeadOrDowned) return; // downed players are never AI victims (Phase 2)
  const ctx = sys.ctx;
  if (target.enemy) {
    const victim = target.enemy;
    if (!victim.isCombatant) return;
    _hd.subVectors(victim.position, from); _hd.y = 0;
    const dir = _hd.lengthSq() > 1e-4 ? _hd.normalize() : undefined;
    victim.takeDamage(amount, undefined, dir, 'ai');
    sys.noteClash(victim.position);
    return;
  }
  if (melee && sys.absorbedByShield(target, from, amount, id)) return;
  if (target.isLocal) {
    const player = ctx.player;
    if (!player || player.isDead || player.isDowned) return;
    player.takeDamage(amount, from);
    ctx.bus.emit('enemy:attacked', { id, type, damage: amount, position: from });
    if (slow) ctx.bus.emit('player:applySlow', slow);
    if (shake >= 0.4) ctx.bus.emit('camera:shake', { intensity: shake, duration: 0.3 });
    if (kbDir && kbSpeed > 0 && !player.isDead && typeof player.applyKnockback === 'function') player.applyKnockback(kbDir, kbSpeed);
    return;
  }
  if (target.suspended) {
    // Phase 7: the member's socket is down — the host's RemotePlayerSystem simulates the body from this event
    ctx.bus.emit('ghost:damage', {
      id: target.id as PeerId, amount, from: from.clone(),
      kb: kbDir && kbSpeed > 0 ? { direction: kbDir.clone(), speed: kbSpeed } : undefined,
    });
    if (announce && sys.hosting) ctx.net!.send({ t: 'ee', ev: 'attack', id, ty: type, target: target.id, damage: round(amount, 1), p: tuple(from, 2) }, 'others');
    return;
  }
  const net = ctx.net;
  if (!net) return;
  const msg: DamageMessage = { t: 'dmg', amount: round(amount, 1), from: tuple(from, 2) };
  if (slow) msg.slow = slow;
  if (kbDir && kbSpeed > 0) msg.kb = { d: tuple(kbDir, 2), s: round(kbSpeed, 1) };
  net.send(msg, target.id);
  if (announce) net.send({ t: 'ee', ev: 'attack', id, ty: type, target: target.id, damage: round(amount, 1), p: tuple(from, 2) }, 'others');
  }

/**
 * Phase 12: does the player target's raised shield face the attacker at `from` and take this melee hit? True = the
 * caller applies nothing more. Local owner: implants deducted its shield inside `absorbFrontalAttack`. Peer owner:
 * `ee barrierHit` to that peer alone (no `dmg`, no `ee attack` — the peer plays the bite on its shield itself).
 * A suspended member's shield state is whatever the host last mirrored; if implants says it absorbed, it absorbed.
 */
export function absorbedByShield(sys: EnemySystem, target: CombatTarget, from: THREE.Vector3, amount: number, id: number): boolean {
  const imp = sys.ctx.implants;
  if (!imp || typeof imp.absorbFrontalAttack !== 'function') return false;
  const owner: PeerId | 'local' = target.isLocal ? 'local' : (target.id as PeerId);
  if (!imp.absorbFrontalAttack(owner, from, amount)) return false;
  if (!target.isLocal && !target.suspended && sys.hosting) {
    // contact point: just in front of the carrier's chest, toward the attacker
    _c.set(from.x - target.position.x, 0, from.z - target.position.z);
    if (_c.lengthSq() > 1e-4) _c.normalize(); else _c.set(0, 0, 1);
    _c.multiplyScalar(0.7).add(target.position); _c.y = target.position.y + SHIELD_CONTACT_Y;
    sys.ctx.net!.send({ t: 'ee', ev: 'barrierHit', id, amount: round(amount, 1), p: tuple(_c, 2) }, target.id as PeerId);
  }
  return true;
  }

/** Phase 12 (ReplicaHost): the host says enemy `id` bit **my** raised shield — the local shield takes it, bite FX at `p`. */
export function barrierHitRemote(sys: EnemySystem, id: number, p: THREE.Vector3, amount: number): void {
  const imp = sys.ctx.implants;
  if (imp && typeof imp.damageBarrier === 'function') imp.damageBarrier('local', p, amount);
  const e = sys.byId.get(id);
  sys.playAudio('bug_attack', e ? e.position : p, 1, sys.bitePitch(e?.type ?? 'scavenger'));
  }

/* ── Phase 12: 배리어 충돌 (EnemyHost) ─────────────────────────────────── */
/**
 * Called from `ai/EnemyAI.integrate` after every grounded enemy moved: `ImplantsRef.resolveBarrierCollision` pushes
 * the body out of any raised shield and names the carrier. On contact the enemy hunts the carrier for
 * BARRIER_RETARGET_S (`pickTarget` honours `barrierOwner`), wakes up if it was idle, and `implant:barrierBumped`
 * fires at most every BARRIER_BUMP_INTERVAL per enemy (implants sparks / audio thuds from it).
 */
export function resolveBarrier(sys: EnemySystem, e: Enemy): void {
  const imp = sys.ctx.implants;
  if (!imp || typeof imp.resolveBarrierCollision !== 'function') return;
  const owner = imp.resolveBarrierCollision(e.position, e.stats.radius);
  if (!owner) return;
  const now = sys.ctx.time;
  e.barrierOwner = owner;
  e.barrierUntil = now + BARRIER_RETARGET_S;
  const carrier = sys.targets.get(owner);
  if (carrier && carrier.present && !carrier.isDeadOrDowned) {
    if (e.target !== carrier) { e.target = carrier; e.hasLOS = false; e.perceptionTimer = 0; e.distToTarget = carrier.dist2D(e.position); }
    if (!e.aware) becomeAlert(e, sys, false);
    if (e.investigating) endInvestigation(e);
  }
  if (now - e.barrierBumpAt >= BARRIER_BUMP_INTERVAL) {
    e.barrierBumpAt = now;
    // contact point: the body's front at mid height, toward the carrier
    _v.set(e.position.x, e.position.y + Math.min(e.stats.height * 0.5, SHIELD_CONTACT_Y), e.position.z);
    if (carrier) {
      _v2.set(carrier.position.x - e.position.x, 0, carrier.position.z - e.position.z);
      if (_v2.lengthSq() > 1e-4) _v.addScaledVector(_v2.normalize(), e.stats.radius);
    }
    sys.ctx.bus.emit('implant:barrierBumped', { owner, enemyId: e.id, point: _v.clone() });
  }
  }

/** Replica: optimistic gore/audio for a local shot, then ask the host to apply it. */
export function requestHit(sys: EnemySystem, e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void {
  const ctx = sys.ctx;
  e.lastLocalHit = ctx.time;
  if (hitPoint) _v.copy(hitPoint); else _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
  if (sys.fx) {
    const count = part === 'head' ? 14 : 8;
    if (hitDir) { _v2.copy(hitDir); sys.fx.burst(_v, count, 'blood', 4.5, _v2, 0.9); }
    else sys.fx.burst(_v, count, 'blood', 4);
  }
  sys.playAudio(e.isRogue ? 'hit_flesh' : 'bug_hit', e.position, 0.6, 0.9 + Math.random() * 0.2);
  ctx.net?.send({ t: 'hit', id: e.id, dmg: round(amount, 2), p: tuple(_v, 2), d: tuple(hitDir ?? _zero, 3) }, 'host');
  }

export function onEnemyDamaged(sys: EnemySystem, e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void {
  const ctx = sys.ctx;
  ctx.bus.emit('enemy:damaged', { id: e.id, type: e.type, amount, position: e.position, hp: e.hp });
  if (hitPoint) _v.copy(hitPoint); else _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
  if (sys.fx) {
    const count = part === 'head' ? 14 : 8;
    if (hitDir) { _v2.copy(hitDir); sys.fx.burst(_v, count, 'blood', 4.5, _v2, 0.9); }
    else sys.fx.burst(_v, count, 'blood', 4);
  }
  sys.playAudio(e.isRogue ? 'hit_flesh' : 'bug_hit', e.position, 0.6, 0.9 + Math.random() * 0.2);
  if (sys.hosting) {
    const msg: Extract<EnemyEvent, { ev: 'damaged' }> = { t: 'ee', ev: 'damaged', id: e.id, amount: round(amount, 1), p: tuple(_v, 2) };
    if (hitDir) msg.d = tuple(hitDir, 2);
    ctx.net!.send(msg, 'others');
  }
  }

export function onEnemyKilled(sys: EnemySystem, e: Enemy, countKill: boolean): void {
  const ctx = sys.ctx;
  const localKill = e.lastDamager === 'local';
  // Phase 9: `by` names the credit - 'local' for us (our own peer id is folded back by `normalizeAttacker`, so the
  // payload reads the same online and offline), the peer id for a remote killer, null for an AI (faction) kill.
  const by: string | null = localKill ? 'local' : e.lastDamager === 'ai' ? null : e.lastDamager;
  // only our own kills bump the local counters: a remote killer counts it on its own client (from the `kill` event /
  // a `hitc`), an AI kill is credited to nobody and never reaches the bus.
  if (countKill && localKill) ctx.stats.kills++;
  if (countKill && by !== null) ctx.bus.emit('enemy:killed', { id: e.id, type: e.type, position: e.position, by, deathDir: e.deathDir });
  if (e.isRogue) sys.playAudio('player_death', e.position, 0.8, e.type === 'rogue_boss' ? 0.7 : 1);
  else sys.playAudio('bug_death', e.position, 1, e.type === 'behemoth' ? 0.35 : e.type === 'charger' ? 0.5 : e.type === 'scavenger' || e.type === 'toxic' ? 1.2 : 0.85);
  if (sys.fx) {
    _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
    sys.fx.burst(_v, 18 + Math.round(Math.min(2, e.stats.radius) * 22), 'blood', 3 + Math.min(2, e.stats.radius) * 2);
    sys.fx.splat(e.position, Math.min(3.5, e.stats.radius * 1.6), 'blood', ctx.world);
  }
  if (e.type === 'spewer') sys.acidBurst(e);
  if (e.type === 'toxic' && sys.authority) sys.toxicBurst(e);
  // lootable corpse (authority registers; replicas mirror the `corpse` event).
  // Phase 10: a body that died in the air registers **after it lands** — `GameContext.findBest` measures a 3-D
  // distance, so a corpse pinned at the mid-air kill position was both floating and unreachable.
  if (sys.authority && ctx.world) {
    if (e.deathLanded) sys.registerCorpse(e);
    else e.corpsePending = true;
  }
  if (sys.hosting) {
    const net = ctx.net!;
    const killer = localKill ? net.localId : e.lastDamager === 'ai' ? null : e.lastDamager;
    const msg: Extract<EnemyEvent, { ev: 'kill' }> = { t: 'ee', ev: 'kill', id: e.id, ty: e.type, p: tuple(e.position, 2), killer };
    const dd = deathDirIndex(e.deathDir);
    if (dd > 0) msg.dd = dd;
    net.send(msg, 'others');
  }
  }

/**
 * Authority: register the `corpse:<id>` interactable at the body's **resting** position and mirror it to the
 * clients. Called from `onEnemyKilled` for a ground kill (same frame, as before) and from the update loop once a
 * mid-air body lands or `CORPSE_LAND_TIMEOUT` runs out.
 * Phase 10: the lootable roll (`CORPSE_LOOT_CHANCE`) happens here, on its own seeded stream — `rollCorpse` is only
 * ever called afterwards, by `Corpse.interact()`, so its stream is untouched.
 */
export function registerCorpse(sys: EnemySystem, e: Enemy): void {
  const ctx = sys.ctx;
  e.corpsePending = false;
  if (!ctx.world) return;
  const lootable = rollCorpseLootable(ctx.world.seed, e.id, e.type);
  e.lootable = lootable;
  const opts: CorpseWireOpts = { lootable, deathDir: e.deathDir };
  sys.corpses.add(e.id, e.type, e.position, e.weaponId || undefined, ctx.world.seed, opts);
  if (sys.hosting) {
    const msg: Extract<EnemyEvent, { ev: 'corpse' }> = { t: 'ee', ev: 'corpse', id: e.id, ty: e.type, p: tuple(e.position, 2) };
    if (e.weaponId) msg.w = e.weaponId;
    const dd = deathDirIndex(e.deathDir);
    if (dd > 0) msg.dd = dd;
    if (!lootable) msg.lt = 0;
    ctx.net!.send(msg, 'others');
  }
  }
