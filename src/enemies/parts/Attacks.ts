/**
 * src/enemies/parts/Attacks.ts — **적이 하는 공격**.
 *
 * 산성 침 · 로그의 총 · 포병 포탄(요격 가능) · 로그 수류탄 · 독성 자폭. 전부 **호스트에서만** 결정되고
 * 결과가 `ee` 이벤트로 나가며, 각 클라이언트는 `parts/RemoteFx.ts` 에서 연출만 재생한다.
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

/** Spit at an explicit point (smoke return fire / deployables) — the glob still hurts whoever it lands on. */
export function fireAcidAt(sys: EnemySystem, from: THREE.Vector3, aimFeet: THREE.Vector3, shooter: Enemy): void {
  sys.acid?.fireAt(from, aimFeet, shooter.id);
  }

export function emberBurst(sys: EnemySystem, position: THREE.Vector3, count: number): void {
  sys.fx?.burst(position, count, 'ember', 1.6);
  }

/* ── Phase 7: rogue grenades ───────────────────────────────────────────── */
/** Authority: lob a grenade from the rogue's off hand onto `target` (feet), `ee grenade` to the others. */
export function throwGrenade(sys: EnemySystem, e: Enemy, target: THREE.Vector3): boolean {
  const ctx = sys.ctx;
  const world = ctx.world;
  if (!world || !sys.grenades || !sys.authority) return false;
  // launch point: off-hand height, a little ahead of the body
  e.facing(_m).multiplyScalar(e.stats.radius * 0.8);
  _m.add(e.position); _m.y += e.stats.height * 0.78;
  _aim.copy(target);
  _aim.x += (Math.random() - 0.5) * 2; _aim.z += (Math.random() - 0.5) * 2;
  if (!world.isInsideBounds(_aim.x, _aim.z)) _aim.copy(target);
  _aim.y = world.getHeightAt(_aim.x, _aim.z);
  const dist = Math.hypot(_aim.x - _m.x, _aim.z - _m.z);
  const flight = THREE.MathUtils.clamp(dist / GRENADE_LOB_SPEED, 0.8, 1.8);
  RogueGrenades.launchVelocity(_m, _aim, flight, _dir);
  // a rock right in front of the hand would bounce the grenade back onto the thrower: refuse (the AI retries elsewhere)
  _v.copy(_dir).normalize();
  if (world.raycast(_m, _v, 2.5) !== null) return false;
  if (!sys.grenades.throw(e.id, _m, _dir, ROGUE_GRENADE_FUSE, true)) return false;
  sys.grenadesThrown++;
  sys.playAudio('grenade_throw', e.position, 0.7, 0.95);
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'grenade', id: e.id, p: tuple(_m, 2), v: tuple(_dir, 2), fuse: ROGUE_GRENADE_FUSE }, 'others');
  return true;
  }

/* ── GrenadeHost ───────────────────────────────────────────────────────── */
/**
 * Fuse ran out. Authority: ROGUE_GRENADE_DAMAGE with linear falloff over ROGUE_GRENADE_RADIUS to every alive player
 * (local directly, remote via `dmg {kb}`, suspended via `ghost:damage`) and to enemies of the other faction, blast
 * noise, `ee grenadeHit`. Everyone: audio, shake near the local player.
 */
export function onGrenadeExploded(sys: EnemySystem, p: THREE.Vector3, authority: boolean, owner: number): void {
  const ctx = sys.ctx;
  sys.grenadesExploded++;
  sys.lastGrenadeBlast.copy(p);
  if (authority && sys.authority) {
    const thrower = sys.byId.get(owner);
    const type: EnemyType = thrower?.type ?? 'rogue';
    const players = sys.targets.alive;
    const reach = ROGUE_GRENADE_RADIUS + PLAYER_RADIUS;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      _c.set(t.position.x, t.position.y + PLAYER_HEIGHT * 0.5, t.position.z);
      const d = _c.distanceTo(p);
      if (d >= reach) continue;
      const falloff = THREE.MathUtils.clamp(1 - Math.max(0, d - PLAYER_RADIUS) / ROGUE_GRENADE_RADIUS, 0.1, 1);
      _kb.subVectors(_c, p); _kb.y = Math.max(_kb.y, 0) + 0.35;
      if (_kb.lengthSq() < 1e-4) _kb.set(0, 1, 0); else _kb.normalize();
      sys.applyDamage(t, ROGUE_GRENADE_DAMAGE * falloff, p, owner, type, null, 0.9 * falloff, false, _kb, GRENADE_KNOCKBACK * falloff);
    }
    sys.explode(p, ROGUE_GRENADE_RADIUS, ROGUE_GRENADE_DAMAGE, 'ai', null, null, 'rogue');
    sys.alertHearing(p, GRENADE_NOISE);
    if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'grenadeHit', p: tuple(p, 2) }, 'others');
  }
  sys.playAudio('explosion', p, 0.9, 1.15);
  const dl = sys.targets.distToLocal(p);
  if (dl < 30) ctx.bus.emit('camera:shake', { intensity: 0.7 * (1 - dl / 30), duration: 0.35 });
  }

export function fireAcid(sys: EnemySystem, from: THREE.Vector3, shooter: Enemy, target: CombatTarget): void {
  if (target.enemy) {
    // bug vs rogue: spit straight at the enemy position (no player target on the wire)
    sys.acid?.fireAt(from, target.position, shooter.id);
    return;
  }
  sys.acid?.fire(from, target, shooter.id);
  if (sys.hosting) {
    const net = sys.ctx.net!;
    const tid = target.isLocal ? net.localId : target.id;
    if (tid) net.send({ t: 'ee', ev: 'acid', id: shooter.id, from: tuple(from, 2), target: tid }, 'others');
  }
  }

export function bitePitch(sys: EnemySystem, type: EnemyType): number {
  return type === 'behemoth' ? 0.4 : type === 'charger' ? 0.6 : type === 'warrior' ? 0.8 : 1.05;
  }

/** Rogue hitscan shot (authority): occlusion, player capsules, enemy hitboxes, damage, FX, audio, events, wire. */
export function fireGun(sys: EnemySystem, e: Enemy, target: CombatTarget, aimError: number, damageMul: number): void {
  const ctx = sys.ctx;
  const world = ctx.world;
  if (!world) return;
  e.muzzle(_m);
  target.getChest(_aim);
  _aim.addScaledVector(target.velocity, 0.06);
  _dir.subVectors(_aim, _m);
  if (_dir.lengthSq() < 1e-4) e.facing(_dir); else _dir.normalize();
  // aim error: rotate around the right / up axes (triangular distribution)
  const ey = (Math.random() + Math.random() - 1) * aimError;
  const ep = (Math.random() + Math.random() - 1) * aimError * 0.7;
  _v.set(-_dir.z, 0, _dir.x).normalize();
  _dir.addScaledVector(_v, ey);
  _dir.y += ep;
  _dir.normalize();

  let hitT = ROGUE_AI.range;
  const wh = world.raycast(_m, _dir, hitT);
  if (wh) hitT = wh.distance;
  let victim: CombatTarget | null = null;
  const players = sys.targets.alive;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    const tt = rayStandingCapsule(_m, _dir, t.position, PLAYER_RADIUS, PLAYER_HEIGHT);
    if (tt >= 0 && tt < hitT) { hitT = tt; victim = t; }
  }
  let foe: Enemy | null = null;
  const eh = sys.raycastEx(_m, _dir, hitT, e);
  if (eh && eh.distance < hitT) { hitT = eh.distance; victim = null; foe = eh.enemy as Enemy; }
  // Phase 9: a 배리어 in the line stops the round (one pure raycast per shot; the barrier takes the block damage)
  let barrier = false;
  const imp = ctx.implants;
  if (imp) {
    const bh = imp.raycastBarrier(_m, _dir, hitT, true);
    if (bh) {
      const bd = bh.point.distanceTo(_m);
      if (bd < hitT) { hitT = bd; victim = null; foe = null; barrier = true; imp.damageBarrier(bh.owner, bh.point); }
    }
  }
  _to.copy(_m).addScaledVector(_dir, hitT);

  const dmg = ROGUE_DAMAGE * damageMul;
  if (victim) sys.applyDamage(victim, dmg, e.position, e.id, e.type, null, 0.2, false);
  else if (foe && foe.faction !== e.faction) {
    foe.takeDamage(dmg, _to, _dir, 'ai');
    sys.noteClash(_to);
  }
  if (wh && !victim && !foe && !barrier) {
    const fx = FxManager.get();
    if (fx) ParticleBurst.dust(fx.alpha, wh.point, wh.normal, 4, 0.5);
  }
  sys.shotFx(_m, _to, victim ? 1 : 0);
  ctx.bus.emit('enemy:shot', { id: e.id, type: e.type, from: _m.clone(), to: _to.clone(), hit: !!victim });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'shoot', id: e.id, from: tuple(_m, 2), to: tuple(_to, 2), hit: !!victim }, 'others');
  }

/** Tracer + muzzle flash sprite (no lights) + rifle report at the muzzle. */
export function shotFx(sys: EnemySystem, from: THREE.Vector3, to: THREE.Vector3, hit: number): void {
  const fx = FxManager.get();
  if (fx) {
    fx.tracers.add(from, to, 0xffc890, 0.03, 0.09, 0);
    fx.flashes.flash(from, 0xffc070, 0, 0.55, 0.05);
  }
  sys.playAudio('shot_rifle', from, 0.75, 0.9);
  if (hit) sys.playAudio('hit_flesh', to, 0.6, 0.9);
  }

/** Artillery: shell `sid` toward the target's predicted position, landing after SHELL_FLIGHT_TIME. */
export function fireShell(sys: EnemySystem, e: Enemy, target: CombatTarget): void {
  const ctx = sys.ctx;
  const world = ctx.world;
  if (!world || !sys.shells) return;
  const sid = sys.nextShellId++;
  _aim.copy(target.position).addScaledVector(target.velocity, SHELL_FLIGHT_TIME * 0.5);
  _aim.x += (Math.random() - 0.5) * 3; _aim.z += (Math.random() - 0.5) * 3;
  _aim.y = world.getHeightAt(_aim.x, _aim.z);
  _m.set(e.position.x, e.position.y + e.stats.height * 0.95, e.position.z);
  if (!sys.shells.fire(sid, _m, _aim, SHELL_FLIGHT_TIME)) return;
  sys.playAudio('bug_attack', e.position, 1, 0.45);
  const fx = FxManager.get();
  if (fx) { ParticleBurst.smoke(fx.alpha, _m, 10, 1.0, 0x3a3532); fx.flashes.flash(_m, 0xffa060, 0, 1.4, 0.08); }
  ctx.bus.emit('enemy:shellFired', { sid, from: _m.clone(), target: _aim.clone(), flightTime: SHELL_FLIGHT_TIME });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'shell', sid, from: tuple(_m, 2), target: tuple(_aim, 2), flight: SHELL_FLIGHT_TIME }, 'others');
  }

/* ── ShellHost ─────────────────────────────────────────────────────────── */
export function onShellLanded(sys: EnemySystem, sid: number, p: THREE.Vector3): void {
  const ctx = sys.ctx;
  if (sys.authority) {
    const players = sys.targets.alive;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      const d = t.position.distanceTo(p);
      if (d < SHELL_BLAST_RADIUS + PLAYER_RADIUS) {
        _v.set(p.x, p.y + 0.6, p.z);
        if (sys.barrierBlocks(_v, t)) continue;   // Phase 9: the blast stops at a 배리어 between the crater and the player
        const dmg = SHELL_DAMAGE * THREE.MathUtils.clamp(1 - Math.max(0, d - PLAYER_RADIUS) / SHELL_BLAST_RADIUS * 0.75, 0.25, 1);
        sys.applyDamage(t, dmg, p, 0, 'artillery', null, 0.9, false);
      }
    }
    sys.explode(p, SHELL_BLAST_RADIUS, SHELL_DAMAGE, 'ai', null, null);   // friendly fire on bugs and rogues alike
  }
  sys.playAudio('explosion', p, 1, 0.85);
  const dl = sys.targets.distToLocal(p);
  if (dl < 45) ctx.bus.emit('camera:shake', { intensity: 0.9 * (1 - dl / 45), duration: 0.4 });
  ctx.bus.emit('enemy:shellLanded', { sid, position: p.clone(), radius: SHELL_BLAST_RADIUS });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'shellHit', sid, p: tuple(p, 2) }, 'others');
  }

export function onShellIntercepted(sys: EnemySystem, sid: number, p: THREE.Vector3, local: boolean): void {
  const ctx = sys.ctx;
  sys.playAudio('explosion', p, 0.6, 1.4);
  ctx.bus.emit('enemy:shellIntercepted', { sid, position: p.clone() });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'intercept', sid, p: tuple(p, 2) }, 'others');
  else if (sys.replica && local) ctx.net?.send({ t: 'intq', sid, p: tuple(p, 2) }, 'host');
  }

export function acidBurst(sys: EnemySystem, e: Enemy): void {
  const ctx = sys.ctx;
  _v.set(e.position.x, e.position.y + 0.9, e.position.z);
  sys.fx?.burst(_v, 90, 'acid', 7);
  sys.fx?.splat(e.position, SPEWER_SPIT.deathBurstRadius * 0.6, 'acid', ctx.world);
  sys.playAudio('acid_splash', e.position, 1, 0.7);
  if (sys.authority) {
    const players = sys.targets.alive;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      const d = t.position.distanceTo(e.position);
      if (d < SPEWER_SPIT.deathBurstRadius) {
        const dmg = SPEWER_SPIT.deathBurstDamage * (1 - d / SPEWER_SPIT.deathBurstRadius * 0.6);
        sys.applyDamage(t, dmg, e.position, e.id, e.type, { duration: 1.2, factor: 0.7 }, 0, false);
      }
    }
  }
  const local = sys.targets.local();
  if (local && !local.isDead) {
    const d = local.position.distanceTo(e.position);
    if (d < 12) ctx.bus.emit('camera:shake', { intensity: 0.3 * (1 - d / 12), duration: 0.25 });
  }
  }

/** Toxic burst (authority): TOXIC_DAMAGE with falloff to players and enemies of both factions, green FX, event, wire. */
export function toxicBurst(sys: EnemySystem, e: Enemy): void {
  const ctx = sys.ctx;
  _c.copy(e.position);
  sys.toxicFx(_c);
  const players = sys.targets.alive;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    const d = t.position.distanceTo(_c);
    if (d < TOXIC_RADIUS + PLAYER_RADIUS) {
      const dmg = TOXIC_DAMAGE * THREE.MathUtils.clamp(1 - Math.max(0, d - PLAYER_RADIUS) / TOXIC_RADIUS * 0.8, 0.2, 1);
      sys.applyDamage(t, dmg, _c, e.id, e.type, { duration: 1.5, factor: 0.65 }, 0.5, false);
    }
  }
  sys.explode(_c, TOXIC_RADIUS, TOXIC_DAMAGE, 'ai', null, e);
  ctx.bus.emit('enemy:toxicBurst', { id: e.id, position: _c.clone(), radius: TOXIC_RADIUS });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'toxic', id: e.id, p: tuple(_c, 2) }, 'others');
  }

export function toxicFx(sys: EnemySystem, p: THREE.Vector3): void {
  const ctx = sys.ctx;
  _v.set(p.x, p.y + 0.6, p.z);
  sys.fx?.burst(_v, 110, 'acid', 8);
  sys.fx?.splat(p, TOXIC_RADIUS * 0.55, 'acid', ctx.world);
  const fx = FxManager.get();
  if (fx) { ParticleBurst.ichor(fx.additive, _v, _zero, 30, 0x9fe64a); ParticleBurst.smoke(fx.alpha, _v, 26, 2.4, 0x3d6a1a); }
  sys.playAudio('acid_splash', p, 1, 0.55);
  const dl = sys.targets.distToLocal(p);
  if (dl < 16) ctx.bus.emit('camera:shake', { intensity: 0.45 * (1 - dl / 16), duration: 0.3 });
  }
