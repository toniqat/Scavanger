/**
 * src/player/parts/Locomotion.ts — **이동 · 자세 · 스태미나**.
 *
 * 무엇이 얼마나 빠르게 움직이는가: 자세(서기 / 앉기 / 엎드리기), 구르기, 스태미나 소모와 회복,
 * 그리고 여러 출처가 곱해지는 **속도 배율 스택**(`setSpeedModifier` — 무게 · 소모품 · 들쳐메기 ·
 * 미니건 · 오버차지가 전부 여기로 들어온다). 갈고리 견인과 가방 부양도 이동의 일부다.
 */
import * as THREE from 'three';
import type { PlayerRestoreState } from '@/shared';
import {
  GameContext, Keys, MouseButtons, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_RADIUS, PLAYER_WALK_SPEED,
  PLAYER_DOWN_HP, PLAYER_DOWN_BLEED_PER_SEC, PLAYER_DOWN_SPEED_MUL, PLAYER_REVIVE_HP, PLAYER_GIVE_UP_HOLD,
  ARMOR_DURABILITY_PER_DAMAGE, BOX_HEADROOM, CLOAK_BREAK_TIME, CLOAK_DETECT_MUL, CLOAK_REVEAL_DISTANCE, MELEE_COOLDOWN, MELEE_STAMINA_COST,
  ROLL_COOLDOWN, ROLL_DAMAGE_MUL, ROLL_DURATION, ROLL_STAMINA_COST, SLASH_DURATION, LADDER_SPRINT_DRAIN,
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

/**
 * Roll (Alt) in `direction` — defaults to the current movement input, else camera forward. Costs
 * ROLL_STAMINA_COST, has a ROLL_COOLDOWN, is denied while airborne / rolling / downed / in a pod / in the hub,
 * inside the extraction ship box and from '무거움' (90 %) upward. Emits `player:dived` (wire compatibility).
 */
export function roll(sys: PlayerSystem, direction?: THREE.Vector3): boolean {
  const c = sys.controller;
  if (!sys.canAct() || !c.grounded || c.rolling || sys.ctx.isHubPhase()) return false;
  // Phase 10: a squadmate on the shoulder is put down first; the caller retries next frame
  if (sys._carrying) { sys.dropCarried('action'); return false; }
  if (sys.rollCooldown > 0) return false;
  if (sys.shipBounds || sys._interior) return false;
  if (sys.gear.rollBlocked) {
    sys.ctx.bus.emit('ui:notify', { text: '너무 무거워 구를 수 없다', kind: 'warning', duration: 1.2 });
    sys.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
    return false;
  }
  if (sys.stamina < ROLL_STAMINA_COST * sys.staminaCostMul) {
    sys.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
    return false;
  }
  if (direction && direction.lengthSq() > 1e-6) _dir.copy(direction).setY(0);
  else sys.wishDirection(_dir);
  if (_dir.lengthSq() < 1e-6) sys.rig.getForward(_dir);
  _dir.y = 0;
  if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
  _dir.normalize();

  if (sys._stance !== 'stand') sys.setStance('stand');
  sys.setAiming(false);
  sys.setHovering(false);
  sys.spendStamina(ROLL_STAMINA_COST);
  sys.rollCooldown = ROLL_DURATION + ROLL_COOLDOWN;
  sys.rollPhase = 0;
  c.startRoll(_dir);
  sys.rig.addShake(0.08, 0.18);
  sys.ctx.bus.emit('player:dived', { position: c.position.clone(), direction: _dir.clone() });
  sys.ctx.bus.emit('audio:play', { id: 'player_jump', position: c.position, volume: 0.7, pitch: 0.85 });
  const fx = FxManager.get();
  if (fx) ParticleBurst.dust(fx.alpha, c.position, _up, 4, 0.6);
  return true;
  }

/**
 * Multiplicative speed stack so overcharge / ultralight armor / weight / slows never overwrite each other.
 * `mul === 1` with no duration removes the entry. Keys 'weight' and 'armor' are owned by the player.
 */
export function setSpeedModifier(sys: PlayerSystem, key: string, mul: number, duration?: number): void {
  if (!key) return;
  if (!(mul > 0)) mul = 0;
  if (mul === 1 && duration === undefined) { sys.speedMods.delete(key); return; }
  const until = duration !== undefined && duration > 0 ? (sys.ctx?.time ?? 0) + duration : Infinity;
  sys.speedMods.set(key, { mul, until });
  }

/** Add to the velocity (jump pad, rocket blast, grapple release). Emits `player:launched`. */
export function applyImpulse(sys: PlayerSystem, impulse: THREE.Vector3): void {
  if (!sys.spawned || sys.isDead) return;
  if (sys._roverRide) return;   // 2026-09-13: 탐사 차량 안 — 점프대 · 폭발 충격이 몸을 선체 밖으로 날리지 않는다
  sys.controller.applyImpulse(impulse);
  if (impulse.y > 0.01) sys.autoHoverUsed = false;
  sys.ctx.bus.emit('player:launched', { position: sys.controller.position.clone(), impulse: impulse.clone() });
  }

/** Grapple: reel the player toward `point` until the implant releases it (null). */
export function setGrappleTarget(sys: PlayerSystem, point: THREE.Vector3 | null): void {
  if (point) {
    sys.grappleVec.copy(point);
    sys.controller.grappleTarget = sys.grappleVec;
    sys._grappling = true;
    sys.setHovering(false);
    if (sys.controller.rolling) sys.controller.cancelRoll();
  } else if (sys._grappling) {
    sys.controller.grappleTarget = null;
    sys._grappling = false;
  }
  }

/** Tactical bag hover: slows the fall while held (also auto-engaged once to prevent a fatal fall). */
export function setHovering(sys: PlayerSystem, hovering: boolean): void {
  const want = hovering && !sys.isDead && !sys._downed && !sys.controller.grounded;
  sys.controller.hovering = want;
  if (want === sys._hovering) return;
  sys._hovering = want;
  }

/**
 * Spend stamina (the big slash costs `maxStamina × SLASH_STAMINA_RATIO`). False — and nothing spent — when short
 * or while exhausted (stamina hit 0 and has not recovered to STAMINA_SPRINT_RECOVER yet, same as sprint / roll).
 * Spending goes through the regular path (regen delay, `player:staminaDepleted` at 0).
 */
export function consumeStamina(sys: PlayerSystem, amount: number): boolean {
  if (!(amount > 0)) return true;
  if (!sys.spawned || sys.isDead || sys._downed) return false;
  if (sys.exhausted || sys.stamina < amount * sys.staminaCostMul) return false;
  sys.spendStamina(amount);
  return true;
  }

/**
 * 지금 자리에서 **일어설 수 있나** (2026-09-14, 낮은 통로를 앉아서 지나기).
 *
 * 앉은 몸은 `PLAYER_CROUCH_CLEARANCE_M` 만큼의 머리 위 공간만 요구하므로(`PlayerController.bodyClearance`)
 * 낮은 슬래브 밑을 지날 수 있는데, 그 밑에서 그냥 일어서면 몸이 슬래브 안에 들어가고 다음 프레임의
 * `resolveCollision` 이 옆으로 밀어낸다. 그래서 **일어서기를 막는다** — 사람이 누르는 경로(C · Z · 달리기 ·
 * 점프로 자동 기립)에서만 묻고, 사다리 · 가구 자세 · 드론 조종 해제 같은 **각본된 기립은 묻지 않는다**
 * (그 자리는 원래 설 수 있던 곳이고, 못 서면 영영 못 빠져나온다).
 *
 * 월드에서만 검사한다 — 함선 실내 · 탈출선 안은 천장이 사람 키보다 높다.
 */
export function canStandHere(sys: PlayerSystem): boolean {
  const c = sys.controller;
  if (c.interior || c.shipBounds) return true;
  const world = sys.ctx?.world;
  if (!world?.ready) return true;
  const feet = c.position;
  _standProbe.set(feet.x, feet.y + STAND_PROBE_START, feet.z);
  const reach = BOX_HEADROOM - STAND_PROBE_START;
  return reach <= 0 || !world.raycast(_standProbe, _standUp, reach);
}

/** 기립 검사용 스크래치 — 엉덩이에서 곧장 위로 (컨트롤러의 천장 프로브와 같은 시작 높이). */
const _standProbe = new THREE.Vector3();
const _standUp = new THREE.Vector3(0, 1, 0);
const STAND_PROBE_START = 0.6;

export function setStance(sys: PlayerSystem, stance: Stance): void {
  const prev = sys._stance;
  if (stance === prev) return;
  sys._stance = stance;
  if (prev === 'prone') sys.standUpTimer = STAND_UP_TIME;
  if (sys.ctx) sys.ctx.bus.emit('player:stanceChanged', { stance, prev });
  }

/**
 * C toggles stand↔crouch (prone → crouch). Z toggles prone (prone → stand).
 * Sprint (with forward input) or jump while crouched stands up; from prone they only stand up
 * (0.35 s transition, the jump itself is denied by the caller). Nothing changes while airborne,
 * diving or mid-transition.
 */
export function updateStanceInput(sys: PlayerSystem, wantsJump: boolean, wantsSprint: boolean, allowProne: boolean): void {
  const c = sys.controller, input = sys.ctx.input;
  if (!c.grounded || c.rolling || sys.standUpTimer > 0) return;
  // 2026-09-14: 머리 위가 막힌 자리에서는 일어서지 않는다 (`canStandHere`) — 낮은 통로 한가운데의 C · Z ·
  //   달리기 · 점프가 전부 여기로 모이므로 한 곳만 막으면 된다. 앉기 · 엎드리기는 언제나 된다.
  if (input.wasPressed(Keys.CROUCH)) {
    if (sys._stance !== 'crouch') sys.setStance('crouch');
    else if (canStandHere(sys)) sys.setStance('stand');
  } else if (input.wasPressed(Keys.PRONE) && (allowProne || sys._stance === 'prone')) {
    if (sys._stance !== 'prone') sys.setStance('prone');
    else if (canStandHere(sys)) sys.setStance('stand');
  } else if (sys._stance !== 'stand' && (wantsJump || wantsSprint) && canStandHere(sys)) {
    sys.setStance('stand');
  }
  }

/**
 * A one-off stamina cost (jump · roll · melee · shield bash · big slash). 2026-09-12: × `staminaCostMul` (각성제 +50 %) —
 * every one-off path lands here, so callers pass the base cost; the "enough stamina?" checks scale the same way.
 */
export function spendStamina(sys: PlayerSystem, cost: number): void {
  sys.stamina = Math.max(0, sys.stamina - cost * sys.staminaCostMul);
  sys.regenDelay = STAMINA_REGEN_DELAY;
  if (sys.stamina <= 0) sys.onStaminaDepleted();
  }

export function onStaminaDepleted(sys: PlayerSystem): void {
  if (sys.exhausted) return;
  sys.exhausted = true;
  sys.exhaustedSlow = EXHAUSTED_SLOW_TIME;
  sys.ctx.bus.emit('player:staminaDepleted', {});
  }

/**
 * Regen is scaled by 지구력 (`derived.staminaRegenMul`), the carry weight (`WeightInfo.staminaRegenMul`,
 * softened by the 운반 skill inside inventory) and the ultralight-armor perk. Hovering burns stamina.
 */
export function updateStamina(sys: PlayerSystem, dt: number): void {
  const c = sys.controller;
  const max = sys.maxStamina;
  if (sys.stamina > max) sys.stamina = max;
  // 2026-09-12 전투 소모품: 지속 소모 배수 — 아드레날린 0 (소모도 회복 차단도 없다) · 각성제 1.5 (`parts/Boosts`)
  const drainMul = sys.staminaDrainMul;
  if (sys._hovering && !c.grounded && !sys.isDead && drainMul > 0) {
    sys.stamina = Math.max(0, sys.stamina - HOVER_STAMINA_DRAIN * drainMul * dt);
    sys.regenDelay = STAMINA_REGEN_DELAY;
    if (sys.stamina <= 0) { sys.onStaminaDepleted(); sys.setHovering(false); }
    return;
  }
  // 2026-09-11: 사다리를 빠르게 오르내리는 동안은 달리기와 같은 자리에서 `LADDER_SPRINT_DRAIN` 을 쓴다 (회복도 막는다)
  const drain = (c.climbFast ? LADDER_SPRINT_DRAIN : c.sprinting ? STAMINA_SPRINT_DRAIN : 0) * drainMul;
  if (drain > 0 && !sys.isDead) {
    sys.stamina -= drain * dt;
    sys.regenDelay = STAMINA_REGEN_DELAY;
    if (sys.stamina <= 0) { sys.stamina = 0; sys.onStaminaDepleted(); }
  } else if (sys.regenDelay > 0) {
    sys.regenDelay -= dt;
  } else if (sys.stamina < max) {
    let rate = c.speed < 0.3 && !c.rolling && c.climbSpeed < 0.3 ? STAMINA_REGEN_IDLE : STAMINA_REGEN_MOVING;
    rate *= sys.ctx.progression?.derived.staminaRegenMul ?? 1;
    rate *= sys.gear.weight.staminaRegenMul;
    rate *= 1 + sys.gear.ultralightBonus;
    sys.stamina = Math.min(max, sys.stamina + Math.max(0, rate) * dt);
  }
  if (sys.exhausted && sys.stamina >= STAMINA_SPRINT_RECOVER) sys.exhausted = false;
  }

/** Common precondition for roll / melee. */
export function canAct(sys: PlayerSystem): boolean {
  return sys.spawned && sys.controlsEnabled && !sys.isDead && !sys._downed && !sys._inPod
    && sys.carriedSocket === null
    && !sys.controller.climbing   // 2026-09-11: 사다리에 매달린 손으로는 구르기 · 근접 · 들쳐메기가 없다
    && !sys._droneControl         // 2026-09-11: 드론 조종 중에도 없다 (`parts/DroneControl`)
    && sys.furn.kind === null     // 2026-09-12: 가구 자세 중에도 없다 (`parts/FurniturePose`)
    && sys._roverRide === null    // 2026-09-13: 탐사 차량 안에서도 없다 (`parts/RoverRide`)
    && sys.ctx.isControlActive()
    && !(sys.hellpod.isActive && sys.hellpod.state !== 'exiting');
  }

/** Camera-relative horizontal direction of the current movement input (zero vector when idle). */
export function wishDirection(sys: PlayerSystem, out: THREE.Vector3): THREE.Vector3 {
  const yaw = sys.rig ? sys.rig.yaw : 0;
  const mi = sys.moveInput;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  out.set(fx * mi.z + rx * mi.x, 0, fz * mi.z + rz * mi.x);
  if (out.lengthSq() > 1e-6) out.normalize();
  return out;
  }

/**
 * Product of the live speed-modifier stack (drops expired entries). 2026-09-11 (C-3): `isOvercharged` is no longer
 * inferred here from an `overcharge*` key — implants sets it explicitly with `setOvercharged`.
 */
export function speedModifierProduct(sys: PlayerSystem): number {
  const now = sys.ctx.time;
  let mul = 1;
  for (const [key, mod] of sys.speedMods) {
    if (mod.until <= now) { sys.speedMods.delete(key); continue; }
    mul *= mod.mul;
  }
  return mul;
  }

/** Weight state and the ultralight-armor perk feed the same stack as external buffs. */
export function applyGearModifiers(sys: PlayerSystem): void {
  const w = sys.gear.weight;
  if (w.moveMul >= 0.999) sys.speedMods.delete(SPEEDMOD_WEIGHT);
  else sys.speedMods.set(SPEEDMOD_WEIGHT, { mul: Math.max(0, w.moveMul), until: Infinity });
  const bonus = sys.gear.ultralightBonus;
  if (bonus <= 0) sys.speedMods.delete(SPEEDMOD_ARMOR);
  else sys.speedMods.set(SPEEDMOD_ARMOR, { mul: 1 + bonus, until: Infinity });
  // 광학미채 방탄복: permanent cloak while it is worn and intact
  if (sys.gear.opticalCamo) sys.setCloak(Infinity, 'armor');
  else if (sys.cloakSource === 'armor' && sys.cloakTimer === Infinity) { sys.cloakTimer = 0; sys.cloakSource = null; }
  }

/** Tactical bag: hold Space in the air to hover, plus one automatic hover before a fatal fall (낙사 방지). */
export function updateBagFlight(sys: PlayerSystem): void {
  const c = sys.controller;
  if (c.grounded || !sys.gear.tacticalBag) return;
  const hold = sys.ctx.input.isDown(Keys.JUMP) && sys.stamina > 0;
  if (!sys.autoHoverUsed && c.velocity.y < HOVER_AUTO_FALL && sys.stamina > 0) {
    sys.autoHoverUsed = true;
    sys.setHovering(true);
  } else if (hold !== sys._hovering) {
    sys.setHovering(hold);
  }
  }
