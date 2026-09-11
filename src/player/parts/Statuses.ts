/**
 * src/player/parts/Statuses.ts — **플레이어에게 붙는 상태**: 은폐 · 화상 · 방어구 재생.
 *
 * 은폐는 적 인지(`getStealthFactor`)에 직접 곱해지고, 광학 방어구는 영구 은폐다.
 * 화상은 초당 피해를 주는 DoT 이고, 방어구는 전투가 끊기면 조금씩 회복된다.
 */
import * as THREE from 'three';
import type { PlayerRestoreState } from '@/shared';
import {
  GameContext, Keys, MouseButtons, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_RADIUS, PLAYER_WALK_SPEED,
  PLAYER_DOWN_HP, PLAYER_DOWN_BLEED_PER_SEC, PLAYER_DOWN_SPEED_MUL, PLAYER_REVIVE_HP, PLAYER_GIVE_UP_HOLD,
  ARMOR_DURABILITY_PER_DAMAGE, CLOAK_BREAK_TIME, CLOAK_DETECT_MUL, CLOAK_REVEAL_DISTANCE, MELEE_COOLDOWN, MELEE_STAMINA_COST,
  ROLL_COOLDOWN, ROLL_DAMAGE_MUL, ROLL_DURATION, ROLL_STAMINA_COST, SLASH_DURATION,
  PLANET_ENV_DPS, PLANET_ENV_TICK_S,
  type GameSystem, type PlayerRef, type PlayerWeaponHost, type Interactable, type Stance, type InteriorCollider,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { damp, dampAngle, smoothstep, wrapAngle } from '@/core/util/MathUtil';
import { SoldierModel, type SoldierPose } from '../SoldierModel';
import { CameraRig, type RigInput } from '../CameraRig';
import { PlayerController, type MoveInput, type MoveResult, type ShipBounds } from '../PlayerController';
import { Hellpod, type HellpodEvents } from '../Hellpod';
import { PlayerGear } from '../PlayerGear';
import type { CarryEndReason, PortraitRef } from '@/shared';
import { PLAYER_CARRY_DROP_S, PLAYER_CARRY_OFFSET, PLAYER_CARRY_PICKUP_S, PLAYER_CARRY_RANGE, PLAYER_CARRY_SPEED_MUL } from '@/shared';
import type { CarryHost } from '../Carry';
import { createPortraits } from '../Portraits';
import { AUTO_REVIVE_DELAY_S, BURN_TICK, CLOAK_FADE, CLOAK_PROBE_INTERVAL, DEATH_ANIM, EXHAUSTED_SLOW, EXHAUSTED_SLOW_TIME, EYE_CROUCH, EYE_PRONE, EYE_ROLL, EYE_STAND, FADE_FAR, FADE_NEAR, GIVE_UP_PROGRESS_HZ, HOVER_AUTO_FALL, HOVER_STAMINA_DRAIN, INVULN_TIME, KNOCKBACK_MIN_LIFT, MELEE_SWING_TIME, type MeleeKind, SPAWN_RING_RADIUS, SPEEDMOD_ARMOR, SPEEDMOD_WEIGHT, STAMINA_JUMP_COST, STAMINA_REGEN_DELAY, STAMINA_REGEN_IDLE, STAMINA_REGEN_MOVING, STAMINA_SPRINT_DRAIN, STAMINA_SPRINT_RECOVER, STAND_UP_TIME, STIM_DURATION, type SpeedMod, type WeaponState, _camLook, _camPos, _dir, _q, _spawn, _up, _v } from '../model';
import type { PlayerSystem } from '../PlayerSystem';

/** Apply / refresh a cloak. Optical-camo armor passes `Infinity`; the strongest remaining duration wins. */
export function setCloak(sys: PlayerSystem, duration: number, source: 'gadget' | 'armor'): void {
  if (!(duration > 0)) {
    if (sys.cloakSource === source) { sys.cloakTimer = 0; sys.cloakSource = null; }
    return;
  }
  if (duration >= sys.cloakTimer || sys.cloakSource === null) sys.cloakSource = source;
  sys.cloakTimer = Math.max(sys.cloakTimer, duration);
  }

/** 0..1 factor an enemy multiplies its detection range by (1 = fully visible). */
export function getStealthFactor(sys: PlayerSystem): number {
  return sys._cloaked ? CLOAK_DETECT_MUL : 1;
  }

/** Fire zone / incendiary: DoT that also suppresses the 인내 save while it kills. */
export function setBurning(sys: PlayerSystem, dps: number, duration: number): void {
  if (!(dps > 0) || !(duration > 0)) {
    if (sys._burning) { sys._burning = false; sys.burnDps = 0; sys.burnTimer = 0; sys.ctx.bus.emit('player:burning', { active: false, dps: 0 }); }
    return;
  }
  const wasBurning = sys._burning;
  sys.burnDps = Math.max(sys.burnDps, dps);
  sys.burnTimer = Math.max(sys.burnTimer, duration);
  sys._burning = true;
  if (!wasBurning) {
    sys.burnTick = BURN_TICK;
    sys.ctx.bus.emit('player:burning', { active: true, dps: sys.burnDps });
  }
  }

/**
 * Cloak upkeep: firing, sprinting, rolling, meleeing or an enemy inside CLOAK_REVEAL_DISTANCE reveal the player
 * for CLOAK_BREAK_TIME; once the cause is gone (and the distance opened again) the cloak comes back.
 */
export function updateCloak(sys: PlayerSystem, dt: number, ctx: GameContext): void {
  if (sys.cloakTimer > 0 && sys.cloakTimer !== Infinity) sys.cloakTimer = Math.max(0, sys.cloakTimer - dt);
  if (sys.cloakTimer <= 0) {
    sys.cloakBreak = 0;
    sys.cloakNearEnemy = false;
    if (sys.cloakSource !== null) sys.cloakSource = null;
  } else {
    sys.cloakProbe -= dt;
    if (sys.cloakProbe <= 0) {
      sys.cloakProbe = CLOAK_PROBE_INTERVAL;
      sys.cloakNearEnemy = sys.enemyWithin(ctx, CLOAK_REVEAL_DISTANCE);
    }
    const reveal = sys.weaponState.firing || sys.controller.sprinting || sys.controller.rolling
      || sys.meleeTimer > 0 || sys.cloakNearEnemy;
    if (reveal) sys.cloakBreak = CLOAK_BREAK_TIME;
    else if (sys.cloakBreak > 0) sys.cloakBreak = Math.max(0, sys.cloakBreak - dt);
  }
  const cloaked = sys.cloakTimer > 0 && sys.cloakBreak <= 0 && !sys.isDead;
  if (cloaked !== sys._cloaked) {
    sys._cloaked = cloaked;
    ctx.bus.emit('player:cloakChanged', { cloaked, source: cloaked ? sys.cloakSource : null });
  }
  }

/** Any alive enemy within `radius`. */
export function enemyWithin(sys: PlayerSystem, ctx: GameContext, radius: number): boolean {
  const em = ctx.enemies;
  if (!em) return false;
  return em.queryNear(sys.controller.position, radius).length > 0;
  }

/** Burning DoT (incendiary / fire zone). Applied in BURN_TICK chunks; never triggers the 인내 save. */
export function updateBurning(sys: PlayerSystem, dt: number): void {
  if (!sys._burning) return;
  sys.burnTimer -= dt;
  sys.burnTick -= dt;
  if (sys.burnTick <= 0) {
    sys.burnTick = BURN_TICK;
    sys.applyDamage(sys.burnDps * BURN_TICK, undefined, true);
  }
  if (sys.burnTimer <= 0) {
    sys._burning = false; sys.burnDps = 0; sys.burnTimer = 0;
    sys.ctx.bus.emit('player:burning', { active: false, dps: 0 });
  }
  }

/* ══ 행성 상시 환경 (A-13, 2026-09-11 — 사용자 결정) ═══════════════════════════════════════════════════════
 * 피로스 VII(`heat`) · 카민 I(`toxin`) 에 **맞는 준비물 없이** 서 있으면 `PLANET_ENV_TICK_S` 마다
 * `PLANET_ENV_DPS × tick` 만큼 깎인다. 두 가지가 규약이다 —
 *   ① **체력만 깎는다.** 대기는 방탄복이 막지 못하므로 `applyDamage` 를 타지 않는다 (그 길은 실드를 먼저 비운다).
 *   ② 준비물이 있으면 **100 % 상쇄**다. 감소가 아니라 0 이다.
 * 소프트 게이트라 들어가는 것 자체는 막지 않는다 — 막는 곳은 어디에도 없다.
 * `player:envChanged` 는 **노출 상태가 바뀔 때만** 나간다 (매 틱 발행 금지 — ui/ 의 배지 하나가 유일한 소비자다).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
export function updateEnv(sys: PlayerSystem, dt: number, ctx: GameContext): void {
  const exposed = ctx.isGameplayPhase() && !ctx.isTraining();
  const env = exposed ? (ctx.world?.env ?? null) : null;
  const guarded = env !== null && (ctx.progression?.hasEnvPrep(env) ?? false);
  if (env !== sys.envKind || guarded !== sys.envProtected) {
    sys.envKind = env;
    sys.envProtected = guarded;
    sys.envTick = 0;
    ctx.bus.emit('player:envChanged', { env, protected: guarded });
  }
  if (env === null || guarded) return;
  // 전투불능 · 사망 · 강하 포드 안 · 아직 안 내린 몸은 대기를 마시지 않는다.
  if (!sys.spawned || sys.isDead || sys._downed) return;
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return;
  sys.envTick += dt;
  if (sys.envTick < PLANET_ENV_TICK_S) return;
  sys.envTick -= PLANET_ENV_TICK_S;
  const dealt = Math.min(sys.hp, PLANET_ENV_DPS * PLANET_ENV_TICK_S);
  if (dealt <= 0) return;
  sys.hp -= dealt;
  ctx.stats.damageTaken += dealt;
  const bus = ctx.bus;
  bus.emit('player:damaged', { amount: dealt, hp: sys.hp, from: undefined });
  bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: -dealt });
  // DoT 이므로 인내(grit)는 걸리지 않는다 — 화상과 같은 규약.
  if (sys.hp <= 0) sys.onLethal(true);
  }

/** 재생 방탄복: 1 hp/s (perkValue) while stamina is full. Healed in whole points to avoid event spam. */
export function updateArmorRegen(sys: PlayerSystem, dt: number): void {
  const rate = sys.gear.regenPerSecond;
  if (rate <= 0 || sys.isDead || sys._downed || sys.hp >= sys.maxHp) { sys.regenAccum = 0; return; }
  if (sys.stamina < sys.maxStamina - 0.5) { sys.regenAccum = 0; return; }
  sys.regenAccum += rate * dt;
  if (sys.regenAccum >= 1) {
    const whole = Math.floor(sys.regenAccum);
    sys.regenAccum -= whole;
    sys.heal(whole);
  }
  }
