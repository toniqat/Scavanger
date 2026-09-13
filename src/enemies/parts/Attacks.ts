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
  SHELL_BLAST_RADIUS, SHELL_DAMAGE, SHELL_FLIGHT_TIME, SHELL_LEAD_MAX, SHOCK_SLOW_DURATION, SHOCK_SLOW_FACTOR, TOXIC_DAMAGE, TOXIC_RADIUS, getPlanet,
  shellLaunchVelocity, shellPositionAt,
  type DamageMessage, type EnemyDeathDir, type EnemyEvent, type EnemyFaction, type EnemyHit, type EnemyManagerRef, type EnemyRef, type EnemySnapshot, type EnemyStatusKind, type EnemyType, type GameContext, type GameSystem,
  type HitRequest, type InterceptableRef, type PeerId, type PlanetEcosystem, type ShotReport, type Vec3Tuple, type WorldRef,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { Enemy, type EnemyHost, type HitPart, type RogueShotOpts } from '../Enemy';
import { ENEMY_INCENDIARY, ROGUE_AI, SPEWER_SPIT } from '../EnemyTypes';
import { ENEMY_GRENADE_KINDS, type EnemyGrenadeKind } from '@/shared';
import { humanoidProfile } from '../ai/HumanoidProfile';
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
import { BARRIER_BUMP_INTERVAL, BARRIER_RETARGET_S, BURN_TICK, CLASH_RADIUS, CLASH_THROTTLE, CORPSE_SLACK, EMBER_INTERVAL, FLEE_DURATION, GRENADE_KNOCKBACK, GRENADE_LOB_SPEED, GRENADE_NOISE, GUNFIRE_LURE_DURATION, GUNFIRE_LURE_WEIGHT, INCAP_EMBER_INTERVAL, MAX_REQUEST_DAMAGE, MAX_REQUEST_RADIUS, MAX_SHOT_RANGE, MAX_STATUS_DURATION, PROMOTE_ID_GAP, PROMOTE_SEQ_GAP, RECYCLE_DISTANCE, SHELL_ARC_CHECK_FRAC, SHELL_ARC_SAMPLES, SHIELD_CONTACT_Y, SHOCK_SPARK_TIME, SHOT_CHECK_INTERVAL, SPARK_INTERVAL, STATUS_REQUEST_INTERVAL, SUSPICION_RADIUS, SUSPICION_REFRESH, _aim, _arcA, _arcD, _arcP, _arcV, _c, _dir, _eye, _hc, _hd, _hp, _kb, _lead, _m, _sd, _sh, _so, _to, _v, _v2, _zero, deathDirIndex, isVec3Tuple, killedBuf, queryBuf } from '../model';
import { meleeHitSound } from '../model';
import type { EnemySystem } from '../EnemySystem';

/**
 * Spit at an explicit point (smoke return fire / deployables) — the glob still hurts whoever it lands on.
 * 2026-09-11 (C-48): the host mirrors it as `ee acidAt {id, from, to}` — before, replicas never saw these globs.
 */
export function fireAcidAt(sys: EnemySystem, from: THREE.Vector3, aimFeet: THREE.Vector3, shooter: Enemy): void {
  if (sys.acid?.fireAt(from, aimFeet, shooter.id, shooter.faction)) sendAcidAt(sys, shooter.id, from, aimFeet);
  }

/** 2026-09-11 (C-48): host → others, a glob `ee acid` cannot describe (drone · enemy · point target). Replicas fly it visually. */
function sendAcidAt(sys: EnemySystem, id: number, from: THREE.Vector3, to: THREE.Vector3): void {
  if (sys.hosting) sys.ctx.net!.send({ t: 'ee', ev: 'acidAt', id, from: tuple(from, 2), to: tuple(to, 2) }, 'others');
  }

export function emberBurst(sys: EnemySystem, position: THREE.Vector3, count: number): void {
  sys.fx?.burst(position, count, 'ember', 1.6);
  }

const _acidTo = new THREE.Vector3();

/* ── Phase 7: rogue grenades ───────────────────────────────────────────── */
/**
 * Authority: lob a grenade from the rogue's off hand onto `target` (feet), `ee grenade` to the others.
 * 2026-09-13: the grenade is **real inventory** — refused while `e.grenadeCount` is 0, and a successful toss spends one
 * (what is left goes to the corpse, `ee corpse.gc`). The kind is `e.grenadeKind` (`ee grenade.k`, omitted = frag) and the
 * landing scatter is the faction's `grenadeScatter` (±m; raiders throw tighter than rogues).
 */
export function throwGrenade(sys: EnemySystem, e: Enemy, target: THREE.Vector3): boolean {
  const ctx = sys.ctx;
  const world = ctx.world;
  if (!world || !sys.grenades || !sys.authority || e.grenadeCount <= 0) return false;
  // launch point: off-hand height, a little ahead of the body
  e.facing(_m).multiplyScalar(e.stats.radius * 0.8);
  _m.add(e.position); _m.y += e.stats.height * 0.78;
  const scatter = humanoidProfile(e).grenadeScatter;
  _aim.copy(target);
  _aim.x += (Math.random() - 0.5) * 2 * scatter; _aim.z += (Math.random() - 0.5) * 2 * scatter;
  if (!world.isInsideBounds(_aim.x, _aim.z)) _aim.copy(target);
  _aim.y = world.getHeightAt(_aim.x, _aim.z);
  const dist = Math.hypot(_aim.x - _m.x, _aim.z - _m.z);
  const flight = THREE.MathUtils.clamp(dist / GRENADE_LOB_SPEED, 0.8, 1.8);
  RogueGrenades.launchVelocity(_m, _aim, flight, _dir);
  // a rock right in front of the hand would bounce the grenade back onto the thrower: refuse (the AI retries elsewhere)
  _v.copy(_dir).normalize();
  if (world.raycast(_m, _v, 2.5) !== null) return false;
  const kind = e.grenadeKind;
  if (!sys.grenades.throw(e.id, _m, _dir, ROGUE_GRENADE_FUSE, true, kind, e.faction)) return false;
  e.grenadeCount = Math.max(0, e.grenadeCount - 1);
  sys.grenadesThrown++;
  sys.playAudio('grenade_throw', e.position, 0.7, 0.95);
  if (sys.hosting) {
    const k = Math.max(0, ENEMY_GRENADE_KINDS.indexOf(kind));
    const msg: EnemyEvent = k > 0
      ? { t: 'ee', ev: 'grenade', id: e.id, p: tuple(_m, 2), v: tuple(_dir, 2), fuse: ROGUE_GRENADE_FUSE, k }
      : { t: 'ee', ev: 'grenade', id: e.id, p: tuple(_m, 2), v: tuple(_dir, 2), fuse: ROGUE_GRENADE_FUSE };
    ctx.net!.send(msg, 'others');
  }
  return true;
  }

/* ── GrenadeHost ───────────────────────────────────────────────────────── */
/**
 * Fuse ran out. Authority: ROGUE_GRENADE_DAMAGE with linear falloff over ROGUE_GRENADE_RADIUS to every alive player
 * (local directly, remote via `dmg {kb}`, suspended via `ghost:damage`) and to enemies of the other faction, blast
 * noise, `ee grenadeHit`. Everyone: audio, shake near the local player.
 * 2026-09-13: `kind` — an incendiary is a small blast (`ENEMY_INCENDIARY.blastDamage` / `blastRadius`, no knockback);
 * its fire zone was lit by `RogueGrenades` and burns through `onFireZoneTick`. The spared faction is the **thrower's**
 * (was hard-coded `'rogue'`, so a raider's grenade would have hurt raiders). `ee grenadeHit.k` carries the kind.
 */
export function onGrenadeExploded(sys: EnemySystem, p: THREE.Vector3, authority: boolean, owner: number, kind: EnemyGrenadeKind = 'frag'): void {
  const ctx = sys.ctx;
  sys.grenadesExploded++;
  sys.lastGrenadeBlast.copy(p);
  const fire = kind === 'incendiary';
  const radius = fire ? ENEMY_INCENDIARY.blastRadius : ROGUE_GRENADE_RADIUS;
  const damage = fire ? ENEMY_INCENDIARY.blastDamage : ROGUE_GRENADE_DAMAGE;
  if (authority && sys.authority) {
    const thrower = sys.byId.get(owner);
    const type: EnemyType = thrower?.type ?? 'rogue';
    const players = sys.targets.alive;
    const reach = radius + PLAYER_RADIUS;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      _c.set(t.position.x, t.position.y + PLAYER_HEIGHT * 0.5, t.position.z);
      const d = _c.distanceTo(p);
      if (d >= reach) continue;
      const falloff = THREE.MathUtils.clamp(1 - Math.max(0, d - PLAYER_RADIUS) / radius, 0.1, 1);
      if (fire) { sys.applyDamage(t, damage * falloff, p, owner, type, null, 0.5 * falloff, false); continue; }
      _kb.subVectors(_c, p); _kb.y = Math.max(_kb.y, 0) + 0.35;
      if (_kb.lengthSq() < 1e-4) _kb.set(0, 1, 0); else _kb.normalize();
      sys.applyDamage(t, damage * falloff, p, owner, type, null, 0.9 * falloff, false, _kb, GRENADE_KNOCKBACK * falloff);
    }
    sys.explode(p, radius, damage, 'ai', null, null, thrower?.faction ?? 'rogue');
    ctx.drones?.applyExplosion(p, radius, damage);   // 2026-09-11: 권한에서만 (소유자에게는 damageDrone 이 넘긴다)
    sys.alertHearing(p, GRENADE_NOISE);
    if (sys.hosting) {
      const k = Math.max(0, ENEMY_GRENADE_KINDS.indexOf(kind));
      ctx.net!.send(k > 0 ? { t: 'ee', ev: 'grenadeHit', p: tuple(p, 2), k } : { t: 'ee', ev: 'grenadeHit', p: tuple(p, 2) }, 'others');
    }
  }
  sys.playAudio('explosion', p, fire ? 0.7 : 0.9, fire ? 1.35 : 1.15);
  const dl = sys.targets.distToLocal(p);
  const shake = fire ? 0.4 : 0.7;
  if (dl < 30) ctx.bus.emit('camera:shake', { intensity: shake * (1 - dl / 30), duration: 0.35 });
  }

/** A body this far above / below a fire zone's centre is on another floor and does not burn (m, geometry — not balance). */
const FIRE_ZONE_HEIGHT = 2.5;

/**
 * 2026-09-13 (`GrenadeHost.onFireZoneTick`, authority only): an enemy incendiary's fire zone burns for `tick` seconds.
 * - **players** inside `radius` (+ body): the local one gets `PlayerRef.setBurning(ENEMY_INCENDIARY.dps, afterburn)` —
 *   the same DoT a player-made fire zone uses (grit save suppressed, `player:burning`); a remote one a quiet `dmg` tick
 *   through `applyDamage` (no `ee attack`), a suspended one `ghost:damage` — the same routing as every other enemy hit.
 * - **enemies not of `faction`**: the burning status (`burnDps` / `burnTimer`), credited to `'ai'` unless a player
 *   already lit it — so an enemy's fire never hands a player a kill.
 * Drones are not touched (a fire on the ground does not reach a flying body; a ground drone is not aggroable anyway).
 */
export function onFireZoneTick(sys: EnemySystem, p: THREE.Vector3, radius: number, owner: number, faction: EnemyFaction, tick: number): void {
  if (!sys.authority) return;
  const dps = ENEMY_INCENDIARY.dps;
  if (!(dps > 0) || !(tick > 0)) return;
  const ctx = sys.ctx;
  const type: EnemyType = sys.byId.get(owner)?.type ?? 'rogue';
  const players = sys.targets.alive;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    const dx = t.position.x - p.x, dz = t.position.z - p.z;
    const reach = radius + PLAYER_RADIUS;
    if (dx * dx + dz * dz > reach * reach || Math.abs(t.position.y - p.y) > FIRE_ZONE_HEIGHT) continue;
    if (t.isLocal) {
      const pl = ctx.player;
      if (pl && !pl.isDead && typeof pl.setBurning === 'function') pl.setBurning(dps, ENEMY_INCENDIARY.afterburn);
    } else sys.applyDamage(t, dps * tick, p, owner, type, null, 0, false);
  }
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.isCombatant || e.faction === faction) continue;
    const dx = e.position.x - p.x, dz = e.position.z - p.z;
    const reach = radius + e.stats.radius;
    if (dx * dx + dz * dz > reach * reach || Math.abs(e.position.y - p.y) > FIRE_ZONE_HEIGHT) continue;
    e.burnDps = Math.max(e.burnDps, dps);
    e.burnTimer = Math.max(e.burnTimer, ENEMY_INCENDIARY.afterburn);
    if (e.burnTick <= 0) e.burnTick = BURN_TICK;
    if (e.burnAttacker === null) e.burnAttacker = 'ai';
  }
  }

export function fireAcid(sys: EnemySystem, from: THREE.Vector3, shooter: Enemy, target: CombatTarget): void {
  if (target.drone) {
    // 2026-09-11: 드론 표적 — 예측 조준(`fire`)은 그대로. 직격은 `AcidProjectiles` 가 드론 몸체로 판정한다.
    // C-48: `ee acid` 는 플레이어만 이름 붙일 수 있으므로 조준점 그대로 `ee acidAt` 으로 보낸다 (예전엔 와이어가 없었다).
    if (sys.acid?.fire(from, target, shooter.id, _acidTo, shooter.faction)) sendAcidAt(sys, shooter.id, from, _acidTo);
    return;
  }
  if (target.enemy) {
    // bug vs rogue: spit straight at the enemy position (C-48: mirrored as `ee acidAt`; X-5: the glob now hurts the rogue)
    _acidTo.copy(target.position);
    if (sys.acid?.fireAt(from, _acidTo, shooter.id, shooter.faction)) sendAcidAt(sys, shooter.id, from, _acidTo);
    return;
  }
  sys.acid?.fire(from, target, shooter.id, undefined, shooter.faction);
  if (sys.hosting) {
    const net = sys.ctx.net!;
    const tid = target.isLocal ? net.localId : target.id;
    if (tid) net.send({ t: 'ee', ev: 'acid', id: shooter.id, from: tuple(from, 2), target: tid }, 'others');
  }
  }

/** 2026-09-11 (C-51): the pitch now lives in `model.meleeHitSound` (one table for host · replica · barrier paths). */
export function bitePitch(sys: EnemySystem, type: EnemyType): number {
  return meleeHitSound(type)?.pitch ?? 1.05;
  }

/** Rogue hitscan shot (authority): occlusion, player capsules, enemy hitboxes, damage, FX, audio, events, wire. */
/** Returns true when a player / squad target was hit. `opts` (2026-09-11) — see `RogueShotOpts`; omitted = the classic rogue shot. */
export function fireGun(sys: EnemySystem, e: Enemy, target: CombatTarget, aimError: number, damageMul: number, opts?: RogueShotOpts): boolean {
  const ctx = sys.ctx;
  const world = ctx.world;
  if (!world) return false;
  e.muzzle(_m);
  if (opts?.aimAt) _aim.copy(opts.aimAt); else target.getChest(_aim);
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

  let hitT = opts?.range ?? ROGUE_AI.range;
  const wh = world.raycast(_m, _dir, hitT);
  if (wh) hitT = wh.distance;
  let victim: CombatTarget | null = null;
  const players = sys.targets.alive;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    const tt = rayStandingCapsule(_m, _dir, t.position, PLAYER_RADIUS, PLAYER_HEIGHT);
    if (tt >= 0 && tt < hitT) { hitT = tt; victim = t; }
  }
  // 2026-09-11 (적 ↔ 드론): 노려도 되는(aggroable) 드론의 몸체도 막는다. 프록시 `position` 은 몸체 **밑면**이라 공중
  // 드론도 같은 식이고, 납작한 몸체(높이 < 지름)는 몸체 중심의 구가 된다. 걷는 지상 드론은 목록에 없어 총알이 지나간다.
  let droneHit: CombatTarget | null = null;
  const drones = sys.targets.drones;
  for (let i = 0; i < drones.length; i++) {
    const t = drones[i];
    if (t.isDeadOrDowned) continue;
    const r = t.bodyRadius, h = t.bodyHeight, cy = t.position.y + h * 0.5;
    const tt = rayCapsule(_m, _dir, t.position.x, t.position.z, Math.min(cy, t.position.y + r), Math.max(cy, t.position.y + h - r), r).t;
    if (tt >= 0 && tt < hitT) { hitT = tt; victim = null; droneHit = t; }
  }
  let foe: Enemy | null = null;
  const eh = sys.raycastEx(_m, _dir, hitT, e);
  if (eh && eh.distance < hitT) { hitT = eh.distance; victim = null; droneHit = null; foe = eh.enemy as Enemy; }
  // Phase 9: a 배리어 in the line stops the round (one pure raycast per shot; the barrier takes the block damage)
  let barrier = false;
  const imp = ctx.implants;
  if (imp) {
    const bh = imp.raycastBarrier(_m, _dir, hitT, true);
    if (bh) {
      const bd = bh.point.distanceTo(_m);
      if (bd < hitT) { hitT = bd; victim = null; droneHit = null; foe = null; barrier = true; imp.damageBarrier(bh.owner, bh.point); }
    }
  }
  _to.copy(_m).addScaledVector(_dir, hitT);

  const dmg = opts?.damage ?? ROGUE_DAMAGE * damageMul;
  if (victim) sys.applyDamage(victim, dmg, e.position, e.id, e.type, null, 0.2, false);
  else if (droneHit) {
    sys.applyDamage(droneHit, dmg, e.position, e.id, e.type, null, 0, false);   // → ctx.drones.damageDrone
    const fx = FxManager.get();
    if (fx) { _v2.copy(_dir).negate(); ParticleBurst.sparks(fx.additive, _to, _v2, 6, 5); }
  }
  else if (foe && foe.faction !== e.faction) {
    foe.takeDamage(dmg, _to, _dir, 'ai');
    sys.noteClash(_to);
  }
  // 2026-09-11: 로그의 총알도 창문 유리를 깬다 (몸 · 배리어에 막히지 않고 유리가 첫 표면일 때)
  if (wh && !victim && !droneHit && !foe && !barrier && wh.obstacle?.fragile) wh.obstacle.destructible?.onDamage(dmg, wh.point);
  if (wh && !victim && !droneHit && !foe && !barrier) {
    const fx = FxManager.get();
    if (fx) ParticleBurst.dust(fx.alpha, wh.point, wh.normal, 4, 0.5);
  }
  if (opts?.fx !== false) sys.shotFx(_m, _to, victim ? 1 : 0);
  if (opts?.event !== false) ctx.bus.emit('enemy:shot', { id: e.id, type: e.type, from: _m.clone(), to: _to.clone(), hit: !!victim });
  if (opts?.wire !== false && sys.hosting) ctx.net!.send({ t: 'ee', ev: 'shoot', id: e.id, from: tuple(_m, 2), to: tuple(_to, 2), hit: !!victim }, 'others');
  if (opts?.out) { opts.out.from.copy(_m); opts.out.to.copy(_to); }
  return !!victim;
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

/**
 * 발사 전 궤적 검사 (2026-09-10). `SHELL_ARC_GRAVITY` 를 낮춰 정점이 48.7 m → 9.9 m 가 된 뒤로 포탄이 언덕 ·
 * 나무 · 폐허 벽에 걸린다. 걸리면 그 자리에서 터지는 것 자체는 맞는 동작이지만(`fx/ShellProjectile.update`),
 * 그게 **제 발치**면 포병은 6~9초마다 자살하는 셈이라 발사가 무의미해진다. 그래서 쏘기 전에 궤적의 앞쪽
 * `SHELL_ARC_CHECK_FRAC` 를 `SHELL_ARC_SAMPLES` 개의 현으로 훑는다.
 *
 * - 현은 포물선 **아래**를 지나므로 검사는 보수적이다 — "뚫렸는데 막혔다고 본다" 는 있어도 그 반대는 없다.
 * - 마지막 하강 구간은 일부러 보지 않는다: 조준점이 땅이라 무조건 걸리고, 표적 앞 벽에 맞는 것은 막을 이유가 없다.
 * - 발사 시점(포 하나가 6~9초에 한 번)에만 도는 4회 레이캐스트라 핫 패스가 아니다.
 */
export function shellArcBlocked(world: WorldRef, from: THREE.Vector3, target: THREE.Vector3, flight: number): boolean {
  shellLaunchVelocity(from, target, flight, _arcV);
  _arcA.copy(from);
  for (let i = 1; i <= SHELL_ARC_SAMPLES; i++) {
    shellPositionAt(from, _arcV, (i / SHELL_ARC_SAMPLES) * SHELL_ARC_CHECK_FRAC * flight, _arcP);
    _arcD.subVectors(_arcP, _arcA);
    const len = _arcD.length();
    if (len > 1e-4) {
      _arcD.multiplyScalar(1 / len);
      if (world.raycast(_arcA, _arcD, len) !== null) return true;
    }
    _arcA.copy(_arcP);
  }
  return false;
}

/**
 * Artillery: shell `sid` toward the target's predicted position, landing after SHELL_FLIGHT_TIME.
 * The lead is half the flight time of the target's current velocity, **clamped to `SHELL_LEAD_MAX`** (2026-09-09): with a
 * 6.3 s flight a sprinting player would otherwise be led by ~19 m — a shell that lands where you are *going* is not
 * dodgeable, one that lands a few metres ahead of where you *are* is.
 *
 * Returns false when nothing was fired (pool full, or `shellArcBlocked`) — the AI relocates instead.
 */
export function fireShell(sys: EnemySystem, e: Enemy, target: CombatTarget): boolean {
  const ctx = sys.ctx;
  const world = ctx.world;
  if (!world || !sys.shells) return false;
  _lead.copy(target.velocity).multiplyScalar(SHELL_FLIGHT_TIME * 0.5);
  _lead.y = 0;
  const leadLen = _lead.length();
  if (leadLen > SHELL_LEAD_MAX) _lead.multiplyScalar(SHELL_LEAD_MAX / leadLen);
  _aim.copy(target.position).add(_lead);
  _aim.x += (Math.random() - 0.5) * 3; _aim.z += (Math.random() - 0.5) * 3;
  _aim.y = world.getHeightAt(_aim.x, _aim.z);
  _m.set(e.position.x, e.position.y + e.stats.height * 0.95, e.position.z);
  if (shellArcBlocked(world, _m, _aim, SHELL_FLIGHT_TIME)) return false;
  const sid = sys.nextShellId++;
  if (!sys.shells.fire(sid, _m, _aim, SHELL_FLIGHT_TIME)) return false;
  sys.playAudio('bug_attack', e.position, 1, 0.45);
  const fx = FxManager.get();
  if (fx) { ParticleBurst.smoke(fx.alpha, _m, 10, 1.0, 0x3a3532); fx.flashes.flash(_m, 0xffa060, 0, 1.4, 0.08); }
  ctx.bus.emit('enemy:shellFired', { sid, from: _m.clone(), target: _aim.clone(), flightTime: SHELL_FLIGHT_TIME });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'shell', sid, from: tuple(_m, 2), target: tuple(_aim, 2), flight: SHELL_FLIGHT_TIME }, 'others');
  return true;
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
    ctx.drones?.applyExplosion(p, SHELL_BLAST_RADIUS, SHELL_DAMAGE);      // 2026-09-11: 드론도 (권한에서 한 번)
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
    ctx.drones?.applyExplosion(e.position, SPEWER_SPIT.deathBurstRadius, SPEWER_SPIT.deathBurstDamage);   // 2026-09-11
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
  ctx.drones?.applyExplosion(_c, TOXIC_RADIUS, TOXIC_DAMAGE);   // 2026-09-11: 자폭은 권한에서만 불린다
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
