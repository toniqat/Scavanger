/**
 * src/player/parts/Shoulder.ts — **부상자 들쳐메기** (Phase 10).
 *
 * 전투불능 아군 근처에서 F 를 짧게 누르면 어깨에 메고(비무장 · 걷기/달리기만), 다른 행동을 하면
 * 먼저 내려놓는다. 메인 쪽이 권한이고 업힌 쪽은 캐리어의 어깨 소켓을 따라간다 — 캐리어가 사라지면
 * 몸은 마지막 위치에 그대로 내려진다.
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

/* ══ Phase 10 — 부상자 들쳐메기 + 준비 패널 초상화 ══════════════════════════════════════════════════════ */
/**
 * `RemotePlayerSystem` installs itself here in its own `init` (it owns the avatars / refs a carry needs).
 * Without a host `carry()` always fails, so single-player and the headless tests are unaffected.
 */
export function setCarryHost(sys: PlayerSystem, host: CarryHost | null): void { sys.carryHost = host; }

/**
 * Shoulder a downed squadmate (the contextual F tap). Requires: a carry host, the target inside
 * `PLAYER_CARRY_RANGE`, the target downed and alive and not already carried, and ourselves upright and free
 * (not downed / dead / in a pod / mid-hellpod / already carrying / being carried). Locks movement for
 * `PLAYER_CARRY_PICKUP_S`, cancels aim / sprint / roll / grapple / melee and drops us back to `stand`.
 */
export function carry(sys: PlayerSystem, id: string): boolean {
  if (!id || sys._carrying || sys.carriedSocket) return false;
  if (!sys.canAct()) return false;
  const host = sys.carryHost;
  if (!host) return false;
  const target = host.targetOf(id);
  if (!target) return false;
  if (target.position.distanceTo(sys.controller.position) > PLAYER_CARRY_RANGE) return false;
  if (!host.attachCarried(id, sys.model.shoulderSocket)) return false;
  sys._carrying = id;
  sys.carryLock = PLAYER_CARRY_PICKUP_S;
  sys.setAiming(false);
  sys.setHovering(false);
  sys.controller.cancelRoll();
  sys.setGrappleTarget(null);
  sys.meleeTimer = 0;
  sys.controller.sprinting = false;
  if (sys._stance !== 'stand') sys.setStance('stand');
  sys.standUpTimer = 0;
  sys.cancelHold(); sys.interactTarget = null;
  const bus = sys.ctx.bus;
  bus.emit('player:carryStarted', { id, name: target.name || null });
  bus.emit('audio:play', { id: 'interact', position: sys.controller.position, volume: 0.8, pitch: 0.8 });
  sys.ctx.net?.send({ t: 'carry', ev: 'pick', target: id });
  return true;
  }

/**
 * Put the carried squadmate down at our feet. Returns true when someone was actually dropped. A deliberate
 * put-down (`'manual'`) plays the `PLAYER_CARRY_DROP_S` animation (movement locked for it); every other reason
 * releases immediately so the action that caused it can retry on the next frame.
 */
export function dropCarried(sys: PlayerSystem, reason: CarryEndReason = 'manual'): boolean {
  const id = sys._carrying;
  if (!id) return false;
  sys._carrying = null;
  if (reason === 'manual') sys.carryLock = Math.max(sys.carryLock, PLAYER_CARRY_DROP_S);
  const pos = sys.controller.position;
  sys.carryHost?.detachCarried(id, pos);
  sys.ctx.net?.send({ t: 'carry', ev: 'drop', target: id, p: [pos.x, pos.y, pos.z] });
  sys.ctx.bus.emit('player:carryEnded', { id, reason });
  return true;
  }

/**
 * Ride along on another player's shoulder socket (`null` detaches). Called on the **carried** side by
 * `RemotePlayerSystem` once the wire says a peer is carrying us; the transform is then pinned to
 * `PLAYER_CARRY_OFFSET` inside that socket and the controller position follows it (the `attachTo` pattern the
 * extraction ship uses). Detaching lands the body on the ground under wherever the socket left it.
 */
export function setCarriedBy(sys: PlayerSystem, socket: THREE.Object3D | null): void {
  if (socket === sys.carriedSocket) return;
  const root = sys.model.root;
  if (socket) {
    if (sys._carrying) sys.dropCarried('action');   // cannot carry and be carried at once
    if (sys.attachedParent) sys.attachTo(null);
    sys.carriedSocket = socket;
    socket.add(root);
    root.position.set(PLAYER_CARRY_OFFSET[0], PLAYER_CARRY_OFFSET[1], PLAYER_CARRY_OFFSET[2]);
    root.quaternion.identity();
    sys.setAiming(false);
    sys.setHovering(false);
    sys.controller.velocity.set(0, 0, 0);
    sys.controller.sprinting = false;
    return;
  }
  sys.carriedSocket = null;
  root.updateWorldMatrix(true, false);
  _v.setFromMatrixPosition(root.matrixWorld);
  sys.ctx.scene.attach(root);
  if (sys._interior) _v.y = sys._interior.getFloorAt(_v.x, _v.z);
  else if (sys.ctx.world?.ready) _v.y = sys.ctx.world.getHeightAt(_v.x, _v.z);
  const stance = sys._stance;
  sys.controller.reset(_v);
  sys.controller.stance = stance;
  root.position.copy(_v);
  root.quaternion.setFromAxisAngle(_up, sys.bodyYaw);
  _v.y += sys.eyePos.y;
  sys.rig.jumpTo(_v);
  }

/* ── carry internals ── */
/**
 * F tap (`Keys.MELEE`, aliased as `Keys.CARRY`): put the body down while carrying, otherwise shoulder the
 * nearest carriable squadmate. The key is **consumed** in both cases so `WeaponSystem` (which updates later)
 * never reads the same tap as a melee swing; with nobody in range the tap falls through to the melee as usual.
 */
export function updateCarryInput(sys: PlayerSystem, active: boolean): void {
  const input = sys.ctx.input;
  if (sys._carrying) {
    if (active && sys.carryLock <= 0 && input.wasPressed(Keys.MELEE)) {
      input.consume(Keys.MELEE);
      sys.dropCarried('manual');
    }
    return;
  }
  if (!active || sys.carriedSocket || sys._downed || sys.isDead) return;
  const host = sys.carryHost;
  if (!host || !input.wasPressed(Keys.MELEE)) return;
  const target = host.findCarriable(sys.controller.position, PLAYER_CARRY_RANGE);
  if (!target) return;
  input.consume(Keys.MELEE);
  sys.carry(target.id);
  }

/** The body on our shoulder may have been revived, bled out or left the session while we walked. */
export function validateCarry(sys: PlayerSystem): void {
  const id = sys._carrying;
  if (!id) return;
  const status = sys.carryHost?.carryStatus(id) ?? 'gone';
  if (status === 'ok') return;
  sys.dropCarried(status === 'revived' ? 'revived' : status === 'died' ? 'died' : 'reset');
  }

/** Release both sides of a carry without moving anybody (used by every reset path). */
export function clearCarry(sys: PlayerSystem, reason: CarryEndReason): void {
  if (sys._carrying) sys.dropCarried(reason);
  if (sys.carriedSocket) {
    sys.carriedSocket = null;
    sys.model.root.removeFromParent();
    sys.ctx.scene.add(sys.model.root);
  }
  sys.carryLock = 0;
  sys.carryBlend = 0;
  }
