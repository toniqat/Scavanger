/**
 * src/enemies/parts/Status.ts — **상태이상**: 화상 · 전소 · 감전 · 둔화, 그리고 정찰 스캔의 **x-ray 실루엣**.
 *
 * 호스트가 상태를 소유하고 `EnemyWire.sb` 비트로 리플리카에 미러링한다. 리플리카는 직접 걸 수 없으므로
 * `hit {dmg:0, st, dur}` 로 **요청**한다(`requestStatus`). DoT 처치의 킬 크레딧은 불을 놓은 사람에게 간다.
 */
import * as THREE from 'three';
import {
  BEHEMOTH_KNOCKBACK, BURNOUT_DURATION, CORPSE_LAND_TIMEOUT, CORPSE_LIFETIME, ENEMY_DEATH_DIRS, ENEMY_SHOT_ALERT_DIST, ENEMY_SHOT_IMPACT_DIST, ENEMY_STATUS_BITS, FLAME_AFTERBURN_DPS, FLAME_AFTERBURN_DURATION, GADGET_LURE_RADIUS, MAP_SIZE,
  NET_ENEMY_SNAPSHOT_HZ, PLAYER_HEIGHT, PLAYER_RADIUS, ROGUE_DAMAGE, ROGUE_GRENADE_DAMAGE, ROGUE_GRENADE_FUSE, ROGUE_GRENADE_RADIUS, ROGUE_MAG_ROUNDS, ROGUE_RANGE,
  SHELL_BLAST_RADIUS, SHELL_DAMAGE, SHELL_FLIGHT_TIME, SHOCK_SLOW_DURATION, SHOCK_SLOW_FACTOR, TOXIC_DAMAGE, TOXIC_RADIUS, getPlanet,
  HAZARD_ENEMY_DPS, HAZARD_TICK_S,
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
import { hurtSound } from '../model';
import type { EnemySystem } from '../EnemySystem';

/**
 * 정찰 x-ray: red through-wall silhouette for these enemies (simulated or replica) for `seconds`; a second call
 * extends. Unknown ids are ignored; `seconds <= 0` hides the listed ones (`[]` + 0 is a no-op).
 */
export function setXray(sys: EnemySystem, ids: readonly number[], seconds: number): void {
  const until = sys.ctx.time + seconds;
  for (let i = 0; i < ids.length; i++) {
    const e = sys.byId.get(ids[i]);
    if (!e || !e.active) continue;
    if (!(seconds > 0)) { sys.xray.remove(e); continue; }
    if (e.state === 'dead') continue;
    sys.xray.show(e, until);
  }
  }

/**
 * Apply a status effect. `burning` deals `dps` damage (in 0.5 s ticks) for `duration` seconds and
 * spits embers; `slowed` reads `dps` as the fraction of speed removed (0.4 → 60 % speed), clamped to 0.2…1.
 * `incinerated` (전소, 2026-09-06): `duration` s of writhing on the spot — no movement / attacks, still damageable —
 * `isIncapacitated`, faster embers, `enemy:incinerated`; `dps` is ignored. `shocked`: `dps` is the **speed
 * multiplier** (0..1, `SHOCK_SLOW_FACTOR` = 55 % speed) for `duration` s, plus a cyan spark strobe and
 * `enemy:shocked` (emitted once per shock, not per tick — the arc calls this every frame).
 * `dps` 0 (or `duration` 0 for 전소) clears the effect. Visuals run everywhere; gameplay only on the authority:
 * a replica keeps the optimistic visual and forwards the request to the host as `hit {dmg: 0, st, dur}`
 * (`ENEMY_STATUS_BITS`), throttled per enemy for the continuous callers.
 */
export function applyStatus(sys: EnemySystem, id: number, status: EnemyStatusKind, dps: number, duration: number, attacker?: string): void {
  const e = sys.byId.get(id);
  if (!e || !e.active || e.state === 'dead') return;
  // Phase 9: the fire's owner gets the burn-kill credit (host side only; a replica's request carries it as the relay `from`)
  if (attacker !== undefined && !sys.replica && (status === 'burning' || status === 'incinerated') && (status === 'incinerated' ? duration > 0 : dps > 0)) {
    e.burnAttacker = sys.normalizeAttacker(attacker);
  }
  switch (status) {
    case 'incinerated': {
      if (!(duration > 0)) { e.incapTimer = 0; return; }
      if (sys.replica) {
        sys.requestStatus(e, ENEMY_STATUS_BITS.INCINERATED, duration);
        if (e.incapTimer <= 0) sys.ctx.bus.emit('enemy:incinerated', { id: e.id, position: e.position, duration });
        e.incapTimer = Math.max(e.incapTimer, duration);
        return;
      }
      sys.incinerate(e, duration);
      return;
    }
    case 'shocked': {
      if (!(duration > 0) || !(dps > 0)) { e.shockTimer = 0; e.slowFactor = 1; e.slowTimer = 0; return; }
      if (sys.replica) sys.requestStatus(e, ENEMY_STATUS_BITS.SHOCKED, duration);
      const factor = THREE.MathUtils.clamp(dps, 0.2, 1);
      e.slowFactor = Math.min(e.slowFactor, factor);
      e.slowTimer = Math.max(e.slowTimer, duration);
      if (e.shockTimer <= 0) {
        sys.ctx.bus.emit('enemy:shocked', { id: e.id, position: e.position });
        sys.playAudio(hurtSound(e.type), e.position, 0.35, 1.6);   // 2026-09-11 (C-51): 로그는 hit_flesh
        e.sparkTimer = 0;
      }
      e.shockTimer = Math.max(e.shockTimer, Math.min(duration, SHOCK_SPARK_TIME));
      return;
    }
    case 'burning': {
      if (dps <= 0) { e.burnDps = 0; e.burnTimer = 0; return; }
      if (sys.replica) sys.requestStatus(e, ENEMY_STATUS_BITS.BURNING, duration);
      e.burnDps = Math.max(e.burnDps, dps);
      e.burnTimer = Math.max(e.burnTimer, duration);
      if (e.burnTick <= 0) e.burnTick = BURN_TICK;
      return;
    }
    default: {
      if (dps <= 0) { e.slowFactor = 1; e.slowTimer = 0; return; }
      if (sys.replica) sys.requestStatus(e, ENEMY_STATUS_BITS.SLOWED, duration);
      const factor = THREE.MathUtils.clamp(dps <= 1 ? 1 - dps : 1 / dps, 0.2, 1);
      e.slowFactor = Math.min(e.slowFactor, factor);
      e.slowTimer = Math.max(e.slowTimer, duration);
    }
  }
  }

/** Authority: put `e` into 전소 for `duration` s (event, scream, ember burst). */
export function incinerate(sys: EnemySystem, e: Enemy, duration: number): void {
  const fresh = e.incapTimer <= 0;
  e.incinerate(duration);
  if (!e.isIncapacitated) return;
  if (fresh) {
    sys.ctx.bus.emit('enemy:incinerated', { id: e.id, position: e.position, duration });
    if (e.isRogue) sys.playAudio('player_hurt', e.position, 0.8, 0.9);
    else sys.playAudio('bug_screech', e.position, 0.9, e.type === 'behemoth' ? 0.5 : e.type === 'charger' ? 0.7 : 1.35);
    _v.set(e.position.x, e.position.y + e.stats.height * 0.6, e.position.z);
    sys.emberBurst(_v, 14);
    e.sparkTimer = 0;
  }
  }

/**
 * Replica: forward a status to the host as a damage-less `HitRequest` (`st` bits + `dur`). Repeats of the same
 * bits inside STATUS_REQUEST_INTERVAL are dropped (the flamethrower / arc call `applyStatus` every tick).
 */
export function requestStatus(sys: EnemySystem, e: Enemy, bits: number, duration: number): void {
  const now = sys.ctx.time;
  if ((e.statusReqBits & bits) === bits && now - e.statusReqAt < STATUS_REQUEST_INTERVAL) return;
  e.statusReqBits = now - e.statusReqAt < STATUS_REQUEST_INTERVAL ? e.statusReqBits | bits : bits;
  e.statusReqAt = now;
  _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
  const msg: HitRequest = { t: 'hit', id: e.id, dmg: 0, p: tuple(_v, 2), d: tuple(_zero, 3), st: bits, dur: round(Math.min(MAX_STATUS_DURATION, duration), 2) };
  sys.ctx.net?.send(msg, 'host');
  }

/**
 * Host: apply the status bits a client attached to its hit (`HitRequest.st` / `dur`); the wire carries no dps, so the
 * defaults are the constants.
 *
 * 2026-09-11 (E-8): by the time this runs the caller (`parts/Damage.onHitRequest`) has already masked `bits` to
 * `ENEMY_STATUS_BITS_ALL`, checked that the sender's snapshot stands within `STATUS_SOURCE_REACH` of `e`, and spent one
 * token of that sender's status budget. What is left here is the duration clamp, unchanged — so **anything else that
 * ever calls this must do those three first**; it is not self-guarding.
 */
export function applyStatusBits(sys: EnemySystem, e: Enemy, bits: number, dur: number | undefined, from?: string): void {
  const d = dur !== undefined && dur > 0 ? Math.min(MAX_STATUS_DURATION, dur) : 0;
  if (bits & ENEMY_STATUS_BITS.INCINERATED) sys.applyStatus(e.id, 'incinerated', 0, d || BURNOUT_DURATION, from);
  if (bits & ENEMY_STATUS_BITS.SHOCKED) sys.applyStatus(e.id, 'shocked', SHOCK_SLOW_FACTOR, d || SHOCK_SLOW_DURATION, from);
  if (bits & ENEMY_STATUS_BITS.BURNING) sys.applyStatus(e.id, 'burning', FLAME_AFTERBURN_DPS, d || FLAME_AFTERBURN_DURATION, from);
  if (bits & ENEMY_STATUS_BITS.SLOWED) sys.applyStatus(e.id, 'slowed', 0.4, d || 2, from);
  }

/** Phase 12 (debug / smoke): x-ray overlay state of enemy `id` (built overlay count, visible now, expiry). */
export function debugXray(sys: EnemySystem, id: number): { overlays: number; visible: boolean; until: number } | null {
  const e = sys.byId.get(id);
  return e ? sys.xray.debugState(e) : null;
  }

/**
 * 2026-09-11 (C-14): 환경 재해가 적에게도 닿는다 — **권위에서만**, `HAZARD_TICK_S` 마다 살아 있는 적 중 재해 피해
 * 구역(`ctx.world.hazard.isInside`) 안의 몸에 `HAZARD_ENEMY_DPS × HAZARD_TICK_S`. **조용한** 피해다: `Enemy.applyDot(…,
 * 'ai', quiet)` 라 피 FX · `bug_hit` · `ee damaged` · 경직 · 어그로(`aware` / `alertNear`)가 없고, 킬 크레딧은 아무에게도
 * 가지 않는다 (`'ai'` → `enemy:killed` 없음). 떨어지는 hp 는 평소 스냅샷이 리플리카에 싣는다. 재해는 `missionTime` 의
 * 함수라 호스트가 바뀌어도 새 호스트가 같은 구역으로 이어 간다. `Enemy.takeDamage` 를 쓰지 않는 이유가 이것이다 —
 * 리플리카면 `requestHit` 이 되고 권위에서도 틱마다 FX · 방송 · 경직이 난다.
 */
export function updateHazardDot(sys: EnemySystem, dt: number): void {
  const hz = sys.ctx.world?.hazard ?? null;
  if (!hz || !hz.active) { sys.hazardTick = 0; return; }
  sys.hazardTick += dt;
  if (sys.hazardTick < HAZARD_TICK_S) return;
  sys.hazardTick = Math.min(sys.hazardTick - HAZARD_TICK_S, HAZARD_TICK_S);   // a long frame never stacks ticks
  // 2026-09-13: 재해는 시간에 따라 강해진다 — 플레이어와 같은 비율(`HazardRef.damageMul`, 1 → HAZARD_DPS_MAX / HAZARD_DPS)
  const dmg = HAZARD_ENEMY_DPS * HAZARD_TICK_S * hz.damageMul;
  if (!(dmg > 0)) return;
  for (let i = sys.active.length - 1; i >= 0; i--) {
    const e = sys.active[i];
    if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
    if (!hz.isInside(e.position.x, e.position.z)) continue;
    e.applyDot(dmg, 'ai', true);
  }
  }

/* ── status effects (burning / slow / 전소 / shocked) ──────────────────── */
export function updateStatuses(sys: EnemySystem, dt: number): void {
  const authority = sys.authority;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.active || e.state === 'dead') continue;
    const incap = e.incapTimer > 0;
    // replicas hold `incapTimer` / `slowTimer` from the wire bits (the AI ticks them on the authority)
    if (!authority) {
      if (incap) e.incapTimer = Math.max(0, e.incapTimer - dt);
      if (e.slowTimer > 0) { e.slowTimer -= dt; if (e.slowTimer <= 0) e.slowFactor = 1; }
    }
    if (e.burnTimer > 0 || incap) {
      if (e.burnTimer > 0) e.burnTimer -= dt;
      e.emberTimer -= dt;
      if (e.emberTimer <= 0) {
        e.emberTimer = incap ? INCAP_EMBER_INTERVAL : EMBER_INTERVAL;
        _v.set(e.position.x + (Math.random() - 0.5) * e.stats.radius, e.position.y + e.stats.height * (incap ? 0.35 + Math.random() * 0.4 : 0.55), e.position.z + (Math.random() - 0.5) * e.stats.radius);
        sys.emberBurst(_v, incap ? 5 : 4);
      }
      if (authority && e.burnTimer > 0) {
        e.burnTick -= dt;
        if (e.burnTick <= 0) {
          e.burnTick += BURN_TICK;
          // Phase 9: the fire's owner (applyStatus attacker) takes the credit; a remote owner also gets the kill hitmarker
          const by = e.burnAttacker ?? e.lastDamager;
          e.applyDot(e.burnDps * BURN_TICK, by);
          if (e.isDead && sys.hosting && by !== 'local' && by !== 'ai') {
            sys.ctx.net!.send({ t: 'hitc', id: e.id, dmg: round(e.burnDps * BURN_TICK, 1), killed: true, part: 'body' }, by);
          }
        }
      }
      if (e.burnTimer <= 0) { e.burnDps = 0; e.burnTick = 0; e.burnAttacker = null; }
    }
    if (e.shockTimer > 0) {
      e.shockTimer -= dt;
      e.sparkTimer -= dt;
      if (e.sparkTimer <= 0) {
        e.sparkTimer = SPARK_INTERVAL;
        _v.set(e.position.x + (Math.random() - 0.5) * e.stats.radius * 1.4, e.position.y + e.stats.height * (0.3 + Math.random() * 0.6), e.position.z + (Math.random() - 0.5) * e.stats.radius * 1.4);
        sys.fx?.burst(_v, 3, 'spark', 2.2);
      }
    }
  }
  }
