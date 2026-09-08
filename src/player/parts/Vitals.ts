/**
 * src/player/parts/Vitals.ts — **체력 · 전투불능 · 사망 · 회복**.
 *
 * 피해가 들어와서(`applyDamage` — 방어구 감쇄 · 인내 grit · 넉백) 체력이 0 이 되면 죽는 대신
 * **전투불능**이 되고(기어다니기, `downHp` 출혈, Space 홀드 포기), 아군의 소생이나 퍽 `auto_revive` 로
 * 일어난다. 회복은 즉시가 아니라 아이템이 정한 시간에 걸쳐 들어온다(`applyHeal`).
 */
import * as THREE from 'three';
import type { PlayerRestoreState } from '@/shared';
import {
  GameContext, Keys, MouseButtons, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_RADIUS, PLAYER_WALK_SPEED,
  PLAYER_DOWN_HP, PLAYER_DOWN_BLEED_PER_SEC, PLAYER_DOWN_SPEED_MUL, PLAYER_REVIVE_HP, PLAYER_GIVE_UP_HOLD,
  ARMOR_DURABILITY_PER_DAMAGE, CLOAK_BREAK_TIME, CLOAK_DETECT_MUL, CLOAK_REVEAL_DISTANCE, MELEE_COOLDOWN, MELEE_STAMINA_COST,
  ROLL_COOLDOWN, ROLL_DAMAGE_MUL, ROLL_DURATION, ROLL_STAMINA_COST, SLASH_DURATION,
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

/** Teammate finished the revive hold (net → `ctx.player.revive()`): back up with PLAYER_REVIVE_HP, still prone. */
export function revive(sys: PlayerSystem): void {
  if (!sys._downed || sys.isDead) return;
  sys.autoReviveTimer = -1;
  sys._downed = false;
  sys._downHp = 0;
  sys.bleedAcc = 0; sys.giveUpHold = 0;
  sys.hp = PLAYER_REVIVE_HP;
  sys.invuln = Math.max(sys.invuln, 0.5);
  sys.controlsEnabled = true;
  const bus = sys.ctx.bus;
  bus.emit('player:revived', { hp: sys.hp });
  bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: sys.hp });
  bus.emit('audio:play', { id: 'stim', volume: 0.8 });
  }

/**
 * Shove (behemoth charge, blasts, `dmg.kb`): `direction × speed` through the controller's `applyImpulse` path —
 * an in-flight roll is cancelled first and the impulse always carries at least a small lift so the feet leave the
 * ground (grounded cleared) and the shove is not eaten by ground friction. Ignored while dead / downed / not
 * spawned / inside the hellpod. No `player:launched` (that is the jump-pad / rocket-jump event).
 */
export function applyKnockback(sys: PlayerSystem, direction: THREE.Vector3, speed: number): void {
  if (sys.isDead || sys._downed || !sys.spawned) return;
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return;
  const len = direction.length();
  if (len < 1e-5 || !(speed > 0)) return;
  const c = sys.controller;
  if (c.rolling) c.cancelRoll();
  sys.setHovering(false);
  _dir.copy(direction).multiplyScalar(speed / len);
  if (_dir.y < KNOCKBACK_MIN_LIFT) _dir.y = KNOCKBACK_MIN_LIFT;
  c.applyImpulse(_dir);
  c.sprinting = false;
  sys.rig.addShake(Math.min(0.6, speed * 0.04), 0.4);
  }

/** Stim heal-over-time (1.5 s). The caller (weapons quick-use) has already consumed the item. */
export function applyStim(sys: PlayerSystem, healAmount: number): boolean {
  return sys.applyHeal(healAmount, STIM_DURATION);
  }

/**
 * appended (2026-09-07): the consumable's own heal-over-time. `seconds` ≤ 0 lands the whole `amount` on the next
 * frame; `quiet` skips the SFX (the 회복 스프레이 ticks 10×/s). A pool already running is **topped up** rather than
 * refused for a spray tick — a fresh use still refuses while one is running, which is what `applyStim` always did.
 */
export function applyHeal(sys: PlayerSystem, amount: number, seconds: number, quiet = false): boolean {
  if (!sys.spawned || sys.isDead || sys._downed || sys.hp >= sys.maxHp || amount <= 0) return false;
  if (sys.healPool > 0 && !quiet) return false; // already healing
  const dur = Math.max(0.05, seconds);
  const rate = amount / dur;
  sys.healRate = sys.healPool > 0 ? Math.max(sys.healRate, rate) : rate;
  sys.healPool += amount;
  sys.ctx.bus.emit('player:stimUsed', { hp: sys.hp });
  if (!quiet) sys.ctx.bus.emit('audio:play', { id: 'stim', volume: 0.8 });
  return true;
  }

export function takeDamage(sys: PlayerSystem, amount: number, from?: THREE.Vector3): void {
  sys.applyDamage(amount, from, false);
  }

/**
 * Single damage path. `dot` (burning) skips the invulnerability window, the shake / audio and the 인내 (grit)
 * save. Armor reduces the amount and wears down (tactical kit); a roll counts as a partial i-frame.
 */
export function applyDamage(sys: PlayerSystem, amount: number, from: THREE.Vector3 | undefined, dot: boolean): void {
  if (sys.isDead || !(amount > 0) || !sys.spawned) return;
  if (!dot && sys.invuln > 0) return;
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return; // safe inside the pod
  if (!dot) sys.invuln = INVULN_TIME;
  const bus = sys.ctx.bus;
  if (sys._downed) {
    // already down: damage eats the bleed-out pool instead
    const dealt = Math.min(sys._downHp, amount);
    sys._downHp -= dealt;
    sys.ctx.stats.damageTaken += dealt;
    sys.flinch = 1;
    bus.emit('player:damaged', { amount: dealt, hp: sys.hp, from });
    bus.emit('player:downHpChanged', { downHp: Math.max(0, sys._downHp), max: PLAYER_DOWN_HP });
    bus.emit('ui:damageIndicator', { from: from ?? sys.controller.position.clone() });
    sys.rig.addShake(Math.min(0.5, 0.1 + dealt / 80), 0.2);
    bus.emit('audio:play', { id: 'player_hurt', volume: Math.min(1, 0.4 + dealt / 50), pitch: 0.85 });
    if (sys._downHp <= 0) sys.die();
    return;
  }
  let raw = amount;
  if (sys.controller.rolling) raw *= ROLL_DAMAGE_MUL;
  const after = raw * (1 - sys.gear.damageReduction);
  const absorbed = raw - after;
  const dealt = Math.min(sys.hp, after);
  sys.wearGear(absorbed);
  sys.hp -= dealt;
  sys.ctx.stats.damageTaken += dealt;
  bus.emit('player:damaged', { amount: dealt, hp: sys.hp, from });
  bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: -dealt });
  if (!dot) {
    sys.flinch = 1;
    bus.emit('ui:damageIndicator', { from: from ?? sys.controller.position.clone() });
    const shake = Math.min(0.7, 0.15 + dealt / 60);
    sys.rig.addShake(shake, 0.25);
    bus.emit('audio:play', { id: 'player_hurt', volume: Math.min(1, 0.4 + dealt / 50) });
  }
  if (sys.hp <= 0) sys.onLethal(dot);
  }

/**
 * hp hit 0: the 인내 skill may leave 1 hp (never on a DoT tick), otherwise the player goes 전투불능.
 *
 * **2026-09-08 — 혼자면 바로 사망.** 전투불능 is a window for a squadmate to pick you up; alone (no lobby, or a
 * one-player 분대) there is nobody to come, so the bleed-out was just `PLAYER_DOWN_HP / PLAYER_DOWN_BLEED_PER_SEC`
 * seconds of crawling before the same death screen. Solo therefore skips straight to `die()`. The one exception is
 * the Phase 12 perk **재기동 회로** (`auto_revive`), which revives *you* from downed: while it is still unspent the
 * downed state is what makes it fire, so a solo player who bought it still goes down first.
 */
export function onLethal(sys: PlayerSystem, dot: boolean): void {
  if (!dot) {
    const chance = sys.ctx.progression?.derived.gritChance ?? 0;
    if (chance > 0 && Math.random() < chance) {
      sys.hp = 1;
      sys.ctx.bus.emit('player:gritSaved', { hp: sys.hp });
      sys.ctx.bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: 1 });
      sys.ctx.bus.emit('ui:notify', { text: '인내! 버텨냈다', kind: 'warning', duration: 1.6 });
      return;
    }
  }
  if (isAloneInSquad(sys) && !canSelfRevive(sys)) { sys.hp = 0; sys.die(); return; }
  sys.enterDowned();
  }

/** No squad, or a 분대 of one: nobody can run over and revive us. */
function isAloneInSquad(sys: PlayerSystem): boolean {
  const ctx = sys.ctx;
  if (!ctx.isMultiplayer) return true;
  const players = ctx.net?.lobby?.players;
  return !players || players.length <= 1;
  }

/** The 재기동 회로 perk is bought and still unspent this life — it only fires out of the downed state. */
function canSelfRevive(sys: PlayerSystem): boolean {
  return !sys.autoReviveUsed && !!sys.ctx.progression?.derived.perks?.auto_revive;
  }

export function heal(sys: PlayerSystem, amount: number): void {
  if (sys.isDead || sys._downed || amount <= 0) return;
  const before = sys.hp;
  sys.hp = Math.min(sys.maxHp, sys.hp + amount);
  const delta = sys.hp - before;
  if (delta > 0) sys.ctx.bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta });
  }

/** hp reached 0: 전투불능 instead of death — prone crawl, weapons off, `downHp` starts bleeding. */
export function enterDowned(sys: PlayerSystem): void {
  if (sys._downed || sys.isDead) return;
  sys.clearCarry('action');   // a downed carrier cannot hold anybody up
  sys._downed = true;
  sys._downHp = PLAYER_DOWN_HP;
  sys.bleedAcc = 0; sys.giveUpHold = 0;
  sys.hp = 0;
  sys.healPool = 0;
  sys.setAiming(false);
  sys.setHovering(false);
  sys.controller.cancelRoll();
  sys.setGrappleTarget(null);
  sys.meleeTimer = 0;
  sys.controller.sprinting = false;
  sys.setStance('prone'); sys.standUpTimer = 0;
  sys.rig.addShake(0.7, 0.5);
  // Phase 12 perk `auto_revive`: arm the one-shot self-revive (fires from `updateDowned`)
  sys.autoReviveTimer = !sys.autoReviveUsed && sys.ctx.progression?.derived.perks?.auto_revive ? AUTO_REVIVE_DELAY_S : -1;
  const bus = sys.ctx.bus;
  bus.emit('player:downed', { position: sys.controller.position.clone() });
  bus.emit('player:downHpChanged', { downHp: sys._downHp, max: PLAYER_DOWN_HP });
  bus.emit('player:healthChanged', { hp: 0, maxHp: sys.maxHp, delta: 0 });
  bus.emit('audio:play', { id: 'player_hurt', volume: 1, pitch: 0.6 });
  }

/** Bleed PLAYER_DOWN_BLEED_PER_SEC (whole points → `player:downHpChanged`), Space held PLAYER_GIVE_UP_HOLD → die. */
export function updateDowned(sys: PlayerSystem, dt: number, active: boolean): void {
  if (sys.autoReviveTimer >= 0) {
    sys.autoReviveTimer -= dt;
    if (sys.autoReviveTimer <= 0) {
      sys.autoReviveTimer = -1;
      sys.autoReviveUsed = true;
      sys.revive();
      sys.ctx.bus.emit('ui:notify', { text: '재기동 회로 작동', kind: 'success', duration: 1.8 });
      return;
    }
  }
  sys.bleedAcc += PLAYER_DOWN_BLEED_PER_SEC * dt;
  const whole = Math.floor(sys.bleedAcc);
  if (whole >= 1) {
    sys.bleedAcc -= whole;
    sys._downHp = Math.max(0, sys._downHp - whole);
    sys.ctx.bus.emit('player:downHpChanged', { downHp: sys._downHp, max: PLAYER_DOWN_HP });
    if (sys._downHp <= 0) { sys.die(); return; }
  }
  if (active && sys.ctx.input.isDown(Keys.GIVE_UP)) {
    sys.giveUpHold += dt;
    if (sys.giveUpHold >= PLAYER_GIVE_UP_HOLD) { sys.giveUpHold = 0; sys.die(); return; }   // die() → clearDowned → t -1
    sys.emitGiveUpProgress(Math.min(1, sys.giveUpHold / PLAYER_GIVE_UP_HOLD));
  } else {
    sys.giveUpHold = 0;
    sys.emitGiveUpProgress(-1);
  }
  }

/**
 * Phase 9: `player:giveUpProgress {t}` for the HUD bar — 0..1 while Space is held (≤ GIVE_UP_PROGRESS_HZ, only on
 * change), a single `-1` when the hold is released / the downed state ends. Nothing is sent while idle.
 */
export function emitGiveUpProgress(sys: PlayerSystem, t: number): void {
  if (t < 0) {
    if (sys.giveUpSent < 0) return;
    sys.giveUpSent = -1;
    sys.ctx.bus.emit('player:giveUpProgress', { t: -1 });
    return;
  }
  if (t === sys.giveUpSent) return;
  if (sys.giveUpSent >= 0 && t < 1 && sys.ctx.time - sys.giveUpSentAt < 1 / GIVE_UP_PROGRESS_HZ) return;
  sys.giveUpSent = t;
  sys.giveUpSentAt = sys.ctx.time;
  sys.ctx.bus.emit('player:giveUpProgress', { t });
  }

export function clearDowned(sys: PlayerSystem): void {
  sys.autoReviveTimer = -1;
  sys._downed = false;
  sys._downHp = 0;
  sys.bleedAcc = 0;
  sys.giveUpHold = 0;
  sys.emitGiveUpProgress(-1);
  }

export function die(sys: PlayerSystem): void {
  if (sys.isDead) return;
  sys.isDead = true;
  sys.deadTimer = 0;
  sys.healPool = 0;
  sys.clearCarry('died');
  sys.clearDowned();
  sys.setAiming(false);
  sys.setHovering(false);
  sys.controller.cancelRoll();
  sys.setGrappleTarget(null);
  sys.meleeTimer = 0;
  sys.controlsEnabled = false;
  sys.cancelHold();
  sys.rig.addShake(0.8, 0.5);
  sys.ctx.bus.emit('audio:play', { id: 'player_death', volume: 1 });
  sys.ctx.bus.emit('player:died', { position: sys.controller.position.clone() });
  }
