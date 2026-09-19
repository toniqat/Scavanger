/**
 * src/player/parts/Locomotion.ts — **movement · stance · stamina**.
 *
 * What moves how fast: stances (stand / crouch / prone), the roll, stamina drain and regen, and the multiplicative
 * **speed-modifier stack** (`setSpeedModifier` — weight · consumables · shouldering · the minigun · overcharge all
 * arrive here). The grapple pull and the bag hover are part of movement too.
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
 * inside the extraction ship box, while prone or standing up from prone, and from '무거움' (90 %) upward. A crouched
 * roll (2026-09-16 「낮은 구르기」) ends still crouched. Emits `player:dived` (wire compatibility).
 */
export function roll(sys: PlayerSystem, direction?: THREE.Vector3): boolean {
  const c = sys.controller;
  if (!sys.canAct() || !c.grounded || c.rolling || sys.ctx.isHubPhase()) return false;
  /*
   * 2026-09-16 (user's decision — no rolling while prone): the input site (the V gate in `PlayerSystem.update`)
   * already filters prone · standing up (`standUpTimer`, the prone → crouch / stand transition), but paths that
   * call `PlayerRef.roll` directly (smoke tests · the console · other folders) have to pass the same rule, so it
   * is refused once more here. There is no refusal feedback — the input gate used to filter this case silently, so
   * no toast · deny sound is invented for it.
   */
  if (sys._stance === 'prone' || sys.standUpTimer > 0) return false;
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

  /*
   * 2026-09-16 (user's decision — 「낮은 구르기」): a crouched roll **is still crouched when it ends.** The
   * motion · speed · distance · stamina · cooldown · damage test (`ROLL_DAMAGE_MUL`) are not one character
   * different from a standing roll; only the stance is left untouched. The old line
   * (`if (stance !== 'stand') setStance('stand')`) never asked `canStandHere`, so rolling under a low slab stood the
   * body up into the slab — now the controller pushes with the crouched headroom (`bodyClearance`) during the roll
   * too. The crouch blend is held through the roll (`crouchBlend` in `PlayerSystem` · `RemoteAvatar`), so when the
   * roll blend drops the body is back in the crouch at once — no flicker of standing up and crouching again in
   * between. Prone was already refused above.
   */
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
  if (sys._roverRide) return;   // 2026-09-13: in the rover — no jump pad · blast throws the body out of the hull
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
 * **Can the body stand up** where it is (2026-09-14, crouching through a low passage)?
 *
 * A crouched body only asks for `PLAYER_CROUCH_CLEARANCE_M` of headroom (`PlayerController.bodyClearance`), so it
 * can pass under a low slab; standing up there would put the body inside the slab and the next frame's
 * `resolveCollision` would push it out sideways. So **standing up is refused** — asked only on the paths a person
 * presses (C · Z · sprint · the automatic stand-up on jump), and **a scripted stand-up is not asked** — the ladder,
 * a furniture pose, leaving drone control (that spot could be stood on to begin with, and a body that cannot stand
 * there would never get out).
 *
 * Only checked in the world — the ship interior and the extraction ship have ceilings higher than a person.
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

/** Stand-up check scratch — straight up from the hips (the same start height as the controller's ceiling probe). */
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
  // 2026-09-14: no standing up where the headroom is blocked (`canStandHere`) — C · Z · sprint · jump in the middle
  //   of a low passage all arrive here, so blocking one place is enough. Crouching · going prone always work.
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
  // 2026-09-12 combat consumables: the drain multiplier — adrenaline 0 (no drain, no regen block) · the stimulant
  //   1.5 (`parts/Boosts`)
  const drainMul = sys.staminaDrainMul;
  if (sys._hovering && !c.grounded && !sys.isDead && drainMul > 0) {
    sys.stamina = Math.max(0, sys.stamina - HOVER_STAMINA_DRAIN * drainMul * dt);
    sys.regenDelay = STAMINA_REGEN_DELAY;
    if (sys.stamina <= 0) { sys.onStaminaDepleted(); sys.setHovering(false); }
    return;
  }
  // 2026-09-11: climbing a ladder fast spends `LADDER_SPRINT_DRAIN` where sprinting does (regen is blocked too)
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
    && !sys.controller.climbing   // 2026-09-11: hands hanging on a ladder do no roll · melee · shouldering
    && !sys._droneControl         // 2026-09-11: none during drone control either (`parts/DroneControl`)
    && sys.furn.kind === null     // 2026-09-12: none during a furniture pose either (`parts/FurniturePose`)
    && sys._roverRide === null    // 2026-09-13: none inside the rover either (`parts/RoverRide`)
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

/** Tactical bag: hold Space in the air to hover, plus one automatic hover that prevents a fatal fall. */
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
