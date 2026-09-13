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
  ENEMY_GRENADE_KINDS, type CorpseLootOpts,
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
import { namedBodyCenterY } from '../models/named';
import { BARRIER_BUMP_INTERVAL, BARRIER_RETARGET_S, BURN_TICK, CLASH_RADIUS, CLASH_THROTTLE, CORPSE_SLACK, EMBER_INTERVAL, FLEE_DURATION, GRENADE_KNOCKBACK, GRENADE_LOB_SPEED, GRENADE_NOISE, GUNFIRE_LURE_DURATION, GUNFIRE_LURE_WEIGHT, INCAP_EMBER_INTERVAL, MAX_REQUEST_DAMAGE, MAX_REQUEST_KNOCKBACK, MAX_REQUEST_RADIUS, MAX_SHOT_RANGE, MAX_STATUS_DURATION, PROMOTE_ID_GAP, PROMOTE_SEQ_GAP, RECYCLE_DISTANCE, SHIELD_CONTACT_Y, SHOCK_SPARK_TIME, SHOT_CHECK_INTERVAL, SPARK_INTERVAL, STATUS_REQUEST_INTERVAL, SUSPICION_RADIUS, SUSPICION_REFRESH, _aim, _c, _dir, _eye, _hc, _hd, _hp, _kb, _m, _sd, _sh, _so, _to, _v, _v2, _zero, deathDirIndex, isVec3Tuple, killedBuf, queryBuf } from '../model';
// 2026-09-11 (E-8): 요청 가드의 상한 — 전부 `data/constants.csv` 에서 온다 (`../model` 이 읽는 자리)
import { ENEMY_STATUS_BITS_ALL, EXPLODE_SOURCE_REACH, STATUS_REQUEST_BURST_S, STATUS_REQUEST_RATE_MAX, STATUS_SOURCE_REACH } from '../model';
import { goreKindOf, humanoidDeathSound, hurtSound, meleeHitSound } from '../model';
import type { EnemySystem } from '../EnemySystem';
import {
  HIT_KNOCKBACK_RANGE_SLACK, HIT_REQUEST_BURST_S, HIT_REQUEST_DPS_MAX, IMPLANT_BARRIER_CARRY_OFFSET, IMPLANT_BARRIER_CARRY_WIDTH,
  IMPLANT_SHIELD_BASH_RANGE,
} from '@/shared';

/** Radial damage. On a replica this only plays local FX and forwards an `ExplodeRequest` to the host (returns 0). */
export function applyExplosion(sys: EnemySystem, center: THREE.Vector3, radius: number, damage: number): number {
  if (sys.replica) {
    for (let i = 0; i < sys.active.length; i++) {
      const e = sys.active[i];
      if (!e.active || e.state === 'dead') continue;
      _v.set(e.position.x, e.position.y + namedBodyCenterY(e), e.position.z);   // C-55: 엎드린 로든은 ≈ 0.25 m
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
    _v.set(e.position.x, e.position.y + namedBodyCenterY(e), e.position.z);   // C-55: 엎드린 로든은 ≈ 0.25 m
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

/**
 * 2026-09-11 (E-8): the replica branch drops `by` because `ExplodeRequest` has no owner field — and it may, because the
 * host credits the relay `from`, which **is** the owner on every path that reaches this branch. Measured: the two
 * `applyAreaDamage` callers that can run outside the authority are the AT 런처 (`implants/parts/Devices.ts` — passes
 * `ctx.net?.localId`, i.e. this client) and `gadgets.damageEnemies`; the gadget callers (지뢰 `explodeMine`, 원격 지뢰
 * `detonateWhere`, 포탑, 화염지대) are all reached only from `GadgetSystem.update`'s `if (authority)` branch, so on a
 * replica they never fire at all. `by` and the wire's `from` therefore name the same peer wherever it matters; when a
 * caller one day passes **someone else's** id from a replica, this comment is the reason it would be mis-credited.
 */
export function applyAreaDamage(sys: EnemySystem, center: THREE.Vector3, radius: number, damage: number, by?: string): number {
  if (sys.replica) return sys.applyExplosion(center, radius, damage);
  return sys.explode(center, radius, damage, by === undefined ? 'local' : sys.normalizeAttacker(by), null, null);
  }

/**
 * `EnemyManagerRef.pushBack` (실드 배쉬 knockback — 2026-09-08 캐스트 전용, 2026-09-11 C-1 계약). Shove enemies away from
 * `center`: every alive combatant within `radius` gets a horizontal impulse of `speed` m/s (falling off linearly to 40 %
 * at the rim) away from the centre, or along `dir` — the same `velocity` nudge an explosion applies, so the existing
 * steering / stumble rules absorb it (a charging behemoth / charger is **not** shoved, exactly like an explosion).
 *
 * **Authority** applies it to its own copies and returns how many were pushed. **A replica** cannot move its enemies
 * (the next snapshot overwrites them), so it sends one `HitRequest { dmg: 0, kb }` per enemy in range — the falloff is
 * already applied, `d` is the push direction — and returns how many requests went out (X-6: 비호스트 배쉬 넉백이 0
 * 이던 문제). The host's `onHitRequest` applies it. Callers never branch on role.
 */
export function pushBack(sys: EnemySystem, center: THREE.Vector3, radius: number, speed: number, dir?: THREE.Vector3): number {
  if (!(radius > 0) || !(speed > 0)) return 0;
  const net = sys.replica ? sys.ctx.net : null;
  if (sys.replica && !net) return 0;
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
    const k = speed * THREE.MathUtils.clamp(1 - d / reach, 0.4, 1);
    if (net) {
      _c.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
      net.send({ t: 'hit', id: e.id, dmg: 0, p: tuple(_c, 2), d: tuple(_v, 3), kb: round(k, 2) }, 'host');
    } else e.velocity.addScaledVector(_v, k);
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
/**
 * `hit` from a client: damage (as before) and / or the status bits (`st` + `dur`, 2026-09-06; `dmg` may be 0 for a
 * status-only request) and / or the knockback `kb` (2026-09-11 C-1 · X-6 — a replica's `pushBack`: horizontal impulse
 * of `kb` m/s along `d`, falloff already applied by the sender). Knockback skips a charging behemoth / charger exactly
 * like the host's own `pushBack` and is clamped to `MAX_REQUEST_KNOCKBACK`.
 * 2026-09-11 (E-4 · X-6): `dmg` passes the sender's DPS budget (`spendHitBudget`) and `kb` is only applied when the sender's
 * snapshot stands within the bash's reach of the enemy (`knockbackInReach`).
 * 2026-09-11 (E-8): `st` is no longer trusted either — it is masked to `ENEMY_STATUS_BITS_ALL`, refused unless the
 * sender's snapshot stands within `STATUS_SOURCE_REACH` of the enemy, and rate-limited per sender
 * (`spendStatusBudget`). Each check only skips the **status** half; the damage half is unaffected.
 */
export function onHitRequest(sys: EnemySystem, msg: HitRequest, from: string): void {
  if (!sys.hosting) return;
  const { id, p, d } = msg;
  let dmg = msg.dmg;
  // ① 비트 마스크 — 모르는 비트는 여기서 사라진다 (전부 모르는 비트였으면 상태이상 부분은 통째로 건너뛴다)
  const rawSt = msg.st ?? 0;
  const st = Number.isFinite(rawSt) ? rawSt & ENEMY_STATUS_BITS_ALL : 0;
  if (rawSt !== 0 && st === 0) sys.hitGuardStats.statusBits++;
  const kb = typeof msg.kb === 'number' && Number.isFinite(msg.kb) && msg.kb > 0 ? Math.min(msg.kb, MAX_REQUEST_KNOCKBACK) : 0;
  if (!(dmg >= 0) || dmg > MAX_REQUEST_DAMAGE) return;
  if (dmg <= 0 && st === 0 && kb === 0) return;
  if (!isVec3Tuple(p) || !isVec3Tuple(d)) return;
  const e = sys.byId.get(id);
  if (!e || !e.active || e.state === 'dead') return;
  // 2026-09-11 (E-4): the sender's damage per second is capped (`HIT_REQUEST_DPS_MAX`) — an over-budget hit is trimmed
  if (dmg > 0) dmg = spendHitBudget(sys, from, dmg);
  if (dmg > 0) {
    _hp.set(p[0], p[1], p[2]);
    _hd.set(d[0], d[1], d[2]);
    const dir = _hd.lengthSq() > 0.5 ? _hd : undefined;
    const part = e.classifyHit(_hp, dir);
    const before = e.hp;
    e.takeDamage(dmg, _hp, dir, from);
    sys.ctx.net!.send({ t: 'hitc', id: e.id, dmg: round(before - e.hp, 1), killed: e.isDead, part }, from);
  }
  // ②③ 거리 · 요율 — 둘 다 상태이상 부분만 버린다 (위의 피해 · 아래의 넉백은 그대로다)
  if (st !== 0 && !e.isDead && statusInReach(sys, e, from) && spendStatusBudget(sys, from)) sys.applyStatusBits(e, st, msg.dur, from);
  if (kb > 0 && e.isCombatant && e.chargePhase !== 2 && Number.isFinite(d[0]) && Number.isFinite(d[2]) && knockbackInReach(sys, e, from)) {
    _kb.set(d[0], 0, d[2]);
    if (_kb.lengthSq() > 1e-4) e.velocity.addScaledVector(_kb.normalize(), kb);
  }
  }

/* ── 2026-09-11 (E-4 · X-6): 호스트가 요청을 믿기 전에 보는 것 ─────────────── */
/** Per-host, per-sender damage buckets (a WeakMap so a new `EnemySystem` in tests starts clean). */
const HIT_BUDGET = new WeakMap<EnemySystem, Map<string, { tokens: number; at: number }>>();

/**
 * Take up to `dmg` from `from`'s bucket (`HIT_REQUEST_DPS_MAX` hp/s, capacity × `HIT_REQUEST_BURST_S`, wall clock so a
 * shader hold on the host never shrinks a legit budget). Returns the damage to apply (0 = dropped).
 */
function spendHitBudget(sys: EnemySystem, from: string, dmg: number): number {
  let map = HIT_BUDGET.get(sys);
  if (!map) { map = new Map(); HIT_BUDGET.set(sys, map); }
  const now = performance.now() / 1000;
  const cap = HIT_REQUEST_DPS_MAX * HIT_REQUEST_BURST_S;
  let b = map.get(from);
  if (!b) { b = { tokens: cap, at: now }; map.set(from, b); }
  b.tokens = Math.min(cap, b.tokens + Math.max(0, now - b.at) * HIT_REQUEST_DPS_MAX);
  b.at = now;
  const give = Math.min(dmg, b.tokens);
  if (give < dmg) { if (give < 0.5) { sys.hitGuardStats.dropped++; return 0; } sys.hitGuardStats.trimmed++; }
  b.tokens -= give;
  return give;
}

/**
 * X-6: a replica's knockback request (실드 배쉬) is only honoured when the sender's snapshot stands within the bash's reach
 * of the enemy on this host — shield offset + 1.5 × bash range (the push centre sits half a range in front, its radius
 * is range + half the shield width) + the enemy's radius + `HIT_KNOCKBACK_RANGE_SLACK` for both snapshots' lag.
 */
function knockbackInReach(sys: EnemySystem, e: Enemy, from: string): boolean {
  const ref = sys.ctx.net?.getRemotePlayer(from as PeerId);
  if (!ref || ref.isDead) { sys.hitGuardStats.kbRefused++; return false; }
  const reach = IMPLANT_BARRIER_CARRY_OFFSET + IMPLANT_SHIELD_BASH_RANGE * 1.5 + IMPLANT_BARRIER_CARRY_WIDTH / 2 + e.stats.radius + HIT_KNOCKBACK_RANGE_SLACK;
  const dx = e.position.x - ref.position.x, dz = e.position.z - ref.position.z;
  if (dx * dx + dz * dz <= reach * reach) return true;
  sys.hitGuardStats.kbRefused++;
  return false;
}

/* ── 2026-09-11 (E-8): 상태이상 요청 (`HitRequest.st`) ────────────────────── */
/**
 * ② The sender's last snapshot must stand within `STATUS_SOURCE_REACH` (horizontal) of the enemy, **plus the enemy's
 * radius** — both cones measure to the body surface, not the centre (`weapons/unique/UniqueHandler.coneTargets`:
 * `dist > range + e.radius`), so without it a legitimate flame on a behemoth would be refused.
 *
 * The only things that put a status on an enemy are the 화염방사기 (`FLAME_RANGE`) and the 쇼크건 (`SHOCK_RANGE`), both
 * short-ranged. 소이 구역(`gadgets`) also calls `applyStatus`, but it is simulated by the **authority alone**
 * (`GadgetSystem.update` → `if (authority) simulate(…)` → `updateFireZone`), so on a replica it never runs and never
 * becomes a wire request — measured before this check went in, because an owner standing far from his own fire zone
 * would otherwise have been refused.
 */
function statusInReach(sys: EnemySystem, e: Enemy, from: string): boolean {
  const ref = sys.ctx.net?.getRemotePlayer(from as PeerId);
  if (!ref || ref.isDead) { sys.hitGuardStats.statusRange++; return false; }
  const reach = STATUS_SOURCE_REACH + e.stats.radius;
  const dx = e.position.x - ref.position.x, dz = e.position.z - ref.position.z;
  if (dx * dx + dz * dz <= reach * reach) return true;
  sys.hitGuardStats.statusRange++;
  return false;
}

/** Per-host, per-sender **count** buckets for status requests — a separate bucket from `HIT_BUDGET` (different unit). */
const STATUS_BUDGET = new WeakMap<EnemySystem, Map<string, { tokens: number; at: number }>>();

/**
 * ③ One token per status request, refilled at `STATUS_REQUEST_RATE_MAX`/s with a `STATUS_REQUEST_BURST_S` bucket (wall
 * clock, like `spendHitBudget`). The legitimate senders are already throttled per enemy (`STATUS_REQUEST_INTERVAL`
 * 0.25 s), so a flamethrower sweeping 12 targets costs 48/s. Over budget = the status is dropped (the hit's damage is
 * not — that has its own budget). Deliberately **not** charging the burn DoT's damage to the DPS bucket: the reach
 * check already bounds it and pre-charging would trim legitimate multi-target flame play (사용자 결정, 설계안 §2).
 */
function spendStatusBudget(sys: EnemySystem, from: string): boolean {
  let map = STATUS_BUDGET.get(sys);
  if (!map) { map = new Map(); STATUS_BUDGET.set(sys, map); }
  const now = performance.now() / 1000;
  const cap = STATUS_REQUEST_RATE_MAX * STATUS_REQUEST_BURST_S;
  let b = map.get(from);
  if (!b) { b = { tokens: cap, at: now }; map.set(from, b); }
  b.tokens = Math.min(cap, b.tokens + Math.max(0, now - b.at) * STATUS_REQUEST_RATE_MAX);
  b.at = now;
  if (b.tokens < 1) { sys.hitGuardStats.statusRate++; return false; }
  b.tokens -= 1;
  return true;
}

/* ── 2026-09-11 (E-8): 폭발 요청 (`ExplodeRequest`) ──────────────────────── */
/**
 * ②③ The sender must be a live peer whose last snapshot stands within `EXPLODE_SOURCE_REACH` (horizontal) of the
 * blast centre — `STRAT_MAX_CALL_RANGE` because the farthest legitimate explosion is a ship call's impact, plus
 * `EXPLODE_REQUEST_RANGE_SLACK` for how far the caller can run while it falls. Grenades, the bazooka and the AT
 * launcher are all far shorter, so the one cap covers them (`knockbackInReach` is the same adapter for `kb`).
 *
 * ⚠ A **dead** sender is accepted here, unlike `knockbackInReach` (리드 통합, 2026-09-11): explosions travel, so the
 * thrower routinely dies inside a grenade's 1.5–3 s fuse or a ship call's `eta`, and refusing those would quietly
 * delete a common, entirely legitimate kill. A shield bash from a corpse is nonsense; a grenade from one is not.
 * The corpse's frozen snapshot is still a sound anchor — you die near where you threw — and the distance check plus
 * the shared DPS budget below already bound what a forged request can do.
 */
function explodeInReach(sys: EnemySystem, x: number, z: number, from: string): boolean {
  const ref = sys.ctx.net?.getRemotePlayer(from as PeerId);
  if (!ref) { sys.hitGuardStats.explodeSender++; return false; }
  const dx = x - ref.position.x, dz = z - ref.position.z;
  if (dx * dx + dz * dz <= EXPLODE_SOURCE_REACH * EXPLODE_SOURCE_REACH) return true;
  sys.hitGuardStats.explodeRange++;
  return false;
}

/**
 * Host: a replica's `applyExplosion` (수류탄 · 바주카 · AT 런처 · 가젯 · 함선 호출 낙하). Until 2026-09-11 (E-8) this
 * took **any** `p` from **anyone** at **any** rate; now, in order (`shared/buffRules.createBuffGuard` 와 같은 순서):
 *
 *   ① 모양      `isVec3Tuple(p)` · `r` · `dmg` 유한 · `0 < dmg ≤ MAX_REQUEST_DAMAGE` · `0 < r ≤ MAX_REQUEST_RADIUS`
 *   ② 보낸 사람  `getRemotePlayer(from)` 스냅샷이 있다 (죽어 있어도 받는다 — 위 `explodeInReach` 주석)
 *   ③ 거리      보낸 사람 스냅샷과 폭심의 수평 거리 ≤ `EXPLODE_SOURCE_REACH`
 *   ④ 요율      `spendHitBudget` — `hit` 과 **같은** 버킷이다 (따로 두면 두 경로를 번갈아 써서 합계가 두 배가 된다).
 *                깎이면 깎인 값으로 터뜨리고, 0 이면 버린다.
 *
 * 반경 · `kind` 는 여전히 뭉뚱그린 상한뿐이다 — 와이어에 종류 칸이 없다(계약 그대로).
 */
export function onExplodeRequest(sys: EnemySystem, p: readonly number[], r: number, dmg: number, from: string): void {
  if (!sys.hosting) return;
  if (!isVec3Tuple(p) || !Number.isFinite(r) || !Number.isFinite(dmg)) { sys.hitGuardStats.explodeShape++; return; }
  if (!(dmg > 0) || dmg > MAX_REQUEST_DAMAGE || !(r > 0) || r > MAX_REQUEST_RADIUS) { sys.hitGuardStats.explodeShape++; return; }
  if (!explodeInReach(sys, p[0], p[2], from)) return;
  const use = spendHitBudget(sys, from, dmg);
  if (!(use > 0)) return;
  _c.set(p[0], p[1], p[2]);
  killedBuf.length = 0;
  sys.explode(_c, r, use, from, killedBuf, null);
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
  // 2026-09-11 (C-51): 타입별 타격음 — 타길라는 null (자기 `hammer_impact` 만 난다)
  const bite = meleeHitSound(e.type);
  if (bite) sys.playAudio(bite.id, e.position, 1, bite.pitch);
  }

/* ── behemoth ──────────────────────────────────────────────────────────── */
export function chargeHit(sys: EnemySystem, e: Enemy, target: CombatTarget, damage: number, knockDir: THREE.Vector3): void {
  if (target.isDeadOrDowned) return;
  // local: applyKnockback; remote: `dmg.kb` (Phase 7); suspended: `ghost:damage.kb`
  sys.applyDamage(target, damage, e.position, e.id, e.type, null, 1.0, true, knockDir, BEHEMOTH_KNOCKBACK, true);
  const bite = meleeHitSound(e.type);
  if (bite) sys.playAudio(bite.id, e.position, 1, bite.pitch);
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
  // 2026-09-11 (적 ↔ 드론): 드론은 소유자 권한 — `damageDrone` 이 소유자가 아니면 `droneq damage` 로 넘긴다.
  // 플레이어 피해 이벤트(`enemy:attacked`) · `dmg` · `ee attack` · 배리어 흡수 · 넉백 · 둔화는 전부 없다.
  if (target.drone) {
    if (target.droneId !== null) ctx.drones?.damageDrone(target.droneId, amount, from);
    return;
  }
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
  const bite = meleeHitSound(e?.type ?? 'scavenger');   // 2026-09-11 (C-51)
  if (bite) sys.playAudio(bite.id, e ? e.position : p, 1, bite.pitch);
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

/** 2026-09-13: 피격 · 사망 파편의 종류 — 안드로이드는 기계라 피 대신 불꽃이 튄다 (스캔 드론은 사망 경로가 따로 불꽃을 낸다). */
export function goreKind(e: Enemy): 'blood' | 'spark' {
  return goreKindOf(e.type);
}

/** Replica: optimistic gore/audio for a local shot, then ask the host to apply it. */
export function requestHit(sys: EnemySystem, e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void {
  const ctx = sys.ctx;
  e.lastLocalHit = ctx.time;
  if (hitPoint) _v.copy(hitPoint); else _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
  if (sys.fx) {
    const count = part === 'head' ? 14 : 8;
    const kind = goreKind(e);
    if (hitDir) { _v2.copy(hitDir); sys.fx.burst(_v, count, kind, 4.5, _v2, 0.9); }
    else sys.fx.burst(_v, count, kind, 4);
  }
  sys.playAudio(hurtSound(e.type), e.position, 0.6, 0.9 + Math.random() * 0.2);
  ctx.net?.send({ t: 'hit', id: e.id, dmg: round(amount, 2), p: tuple(_v, 2), d: tuple(hitDir ?? _zero, 3) }, 'host');
  }

export function onEnemyDamaged(sys: EnemySystem, e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void {
  const ctx = sys.ctx;
  ctx.bus.emit('enemy:damaged', { id: e.id, type: e.type, amount, position: e.position, hp: e.hp });
  if (hitPoint) _v.copy(hitPoint); else _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
  if (sys.fx) {
    const count = part === 'head' ? 14 : 8;
    const kind = goreKind(e);
    if (hitDir) { _v2.copy(hitDir); sys.fx.burst(_v, count, kind, 4.5, _v2, 0.9); }
    else sys.fx.burst(_v, count, kind, 4);
  }
  sys.playAudio(hurtSound(e.type), e.position, 0.6, 0.9 + Math.random() * 0.2);
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
  // 2026-09-11: 로든의 스캔 드론은 기계다 — 비명 · 피 대신 파괴음 · 불꽃
  if (e.type === 'rogue_scan_drone') {
    sys.playAudio('drone_destroyed', e.position, 1, 1);
    if (sys.fx) {
      _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
      sys.fx.burst(_v, 26, 'spark', 4);
    }
  } else if (e.isHumanoid) { const dv = humanoidDeathSound(e.type); sys.playAudio(dv.id, e.position, 0.8, dv.pitch); }   // 2026-09-13: 안드로이드 = 전원 차단음
  else if (e.type !== 'sandworm') sys.playAudio('bug_death', e.position, 1, e.type === 'behemoth' ? 0.35 : e.type === 'charger' ? 0.5 : e.type === 'scavenger' || e.type === 'toxic' ? 1.2 : 0.85);
  if (sys.fx && e.type !== 'rogue_scan_drone') {
    _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
    const kind = goreKind(e);
    sys.fx.burst(_v, 18 + Math.round(Math.min(2, e.stats.radius) * 22), kind, 3 + Math.min(2, e.stats.radius) * 2);
    if (kind === 'blood') sys.fx.splat(e.position, Math.min(3.5, e.stats.radius * 1.6), 'blood', ctx.world);   // 2026-09-13: 안드로이드는 핏자국이 없다
  }
  if (e.type === 'spewer') sys.acidBurst(e);
  if (e.type === 'toxic' && sys.authority) sys.toxicBurst(e);
  if (e.type === 'sandworm') sys.sandworm.onWormKilled(e);   // 2026-09-13: 굴로 가라앉는 굉음 · 분진 · 토스트 (모든 클라이언트)
  // lootable corpse (authority registers; replicas mirror the `corpse` event).
  // Phase 10: a body that died in the air registers **after it lands** — `GameContext.findBest` measures a 3-D
  // distance, so a corpse pinned at the mid-air kill position was both floating and unreachable.
  if (sys.authority && ctx.world) {
    if (e.deathLanded) sys.registerCorpse(e);
    else e.corpsePending = true;
  }
  if (sys.hosting) {
    const net = ctx.net!;
    /* 2026-09-11 (E-4): an uncounted death (`kill(false)` — the toxic bug's own burst, `killAll`) credits nobody on the wire
     * either. `lastDamager` defaults to `'local'`, so such a body used to go out as "killed by the host" — harmless while
     * only the killer counted it, but now every replica derives `enemy:squadKill` from this field. */
    const killer = !countKill ? null : localKill ? net.localId : e.lastDamager === 'ai' ? null : e.lastDamager;
    const msg: Extract<EnemyEvent, { ev: 'kill' }> = { t: 'ee', ev: 'kill', id: e.id, ty: e.type, p: tuple(e.position, 2), killer };
    const dd = deathDirIndex(e.deathDir);
    if (dd > 0) msg.dd = dd;
    net.send(msg, 'others');
    /*
     * 2026-09-11 (E-4): the host's own view of a squad-mate's kill — the same `killer` the wire carries, so every client
     * (host here, replicas in `Replica case 'kill'`) counts exactly the same squad kills. `enemy:killed` keeps meaning "mine".
     */
    if (typeof killer === 'string' && killer !== net.localId) {
      ctx.bus.emit('enemy:squadKill', { id: e.id, type: e.type, position: e.position, by: killer });
    }
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
  // 2026-09-13: 시체 전리품의 입력 — 스폰 거점 + 던지지 못한 수류탄 (벌레는 둘 다 없다 = 옛 굴림 그대로)
  const loot: CorpseLootOpts | undefined = e.site || e.grenadeCount > 0
    ? { site: e.site, grenades: e.grenadeCount > 0 ? { kind: e.grenadeKind, count: e.grenadeCount } : null }
    : undefined;
  const opts: CorpseWireOpts = { lootable, deathDir: e.deathDir, loot };
  sys.corpses.add(e.id, e.type, e.position, e.weaponId || undefined, ctx.world.seed, opts);
  if (sys.hosting) {
    const msg: Extract<EnemyEvent, { ev: 'corpse' }> = { t: 'ee', ev: 'corpse', id: e.id, ty: e.type, p: tuple(e.position, 2) };
    if (e.weaponId) msg.w = e.weaponId;
    const dd = deathDirIndex(e.deathDir);
    if (dd > 0) msg.dd = dd;
    if (!lootable) msg.lt = 0;
    if (e.site) msg.si = e.site;
    if (e.grenadeCount > 0) {
      msg.gc = e.grenadeCount;
      const gk = ENEMY_GRENADE_KINDS.indexOf(e.grenadeKind);
      if (gk > 0) msg.gk = gk;
    }
    ctx.net!.send(msg, 'others');
  }
  }
