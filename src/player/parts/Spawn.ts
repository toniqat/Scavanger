/**
 * src/player/parts/Spawn.ts — **월드에 들어가고 나오는 모든 방법**.
 *
 * 헬포드 강하(`startDrop`), 함선에서 그냥 서서 시작(`spawnStanding`), 부활(`respawnAt`),
 * 그리고 레이드 재접속 복귀(`restoreState` / `holdForRestore` — 강하 없이 마지막 위치 · 상태로).
 * 미션 리셋에서 전투 상태를 전부 지우는 `resetAll` / `resetTactical` 도 여기 있다.
 */
import * as THREE from 'three';
import type { PlayerRestoreState } from '@/shared';
import {
  GameContext, Keys, MouseButtons, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_RADIUS, PLAYER_WALK_SPEED,
  PLAYER_DOWN_HP, PLAYER_DOWN_BLEED_PER_SEC, PLAYER_DOWN_SPEED_MUL, PLAYER_REVIVE_HP, PLAYER_GIVE_UP_HOLD,
  ARMOR_DURABILITY_PER_DAMAGE, CLOAK_BREAK_TIME, CLOAK_DETECT_MUL, CLOAK_REVEAL_DISTANCE, MELEE_COOLDOWN, MELEE_STAMINA_COST,
  ROLL_COOLDOWN, ROLL_DAMAGE_MUL, ROLL_DURATION, ROLL_STAMINA_COST, SLASH_DURATION,
  /* appended (2026-09-09): 구조선 부활 */
  RESCUE_REVIVE_HP,
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
 * Rejoin: resume the body exactly as the host's ghost left it — standing at `position` facing `yaw`, no hellpod,
 * `hp`; `state` 1 = downed with `downHp` (prone crawl, bleeding, revivable — `player:downed` so the HUD shows the
 * vitals); `state` 2 = dead (death pose, controls off) WITHOUT `player:died` — game/ runs the respawn flow itself.
 * Emits `player:spawned` for 0 / 1. Clears any interior / ship box / pod state like `respawnAt`.
 */
export function restoreState(sys: PlayerSystem, state: PlayerRestoreState): void {
  const bus = sys.ctx.bus;
  const yaw = Number.isFinite(state.yaw) ? state.yaw : sys.bodyYaw;
  _v.copy(state.position);
  if (sys.ctx.world?.ready && !sys.ctx.world.isInsideBounds(_v.x, _v.z)) {
    // off the map (bad wire data): fall back to the mission spawn
    _v.copy(sys.resolveSpawn(sys.ctx.world.getPlayerSpawn()));
  }
  if (sys.ctx.world?.ready) _v.y = Math.max(_v.y, sys.ctx.world.getHeightAt(_v.x, _v.z));
  sys.releaseDroneControl();   // 2026-09-11
  sys.clearClimbState();
  sys.hellpod.hide();
  sys.attachTo(null);
  sys.setInterior(null);
  sys._inPod = false;
  sys.shipBounds = null; sys.controller.shipBounds = null;
  sys.controller.reset(_v);
  sys.slowTimer = 0; sys.slowFactor = 1; sys.controller.speedMultiplier = 1;
  sys.isDead = false; sys.deadTimer = 0; sys.invuln = 0.5; sys.flinch = 0;
  sys.healPool = 0;
  sys.clearDowned();
  sys.stamina = sys.maxStamina; sys.regenDelay = 0; sys.exhausted = false; sys.exhaustedSlow = 0;
  sys.setStance('stand'); sys.standUpTimer = 0;
  sys.resetTactical();
  sys.setAiming(false); sys.aimBlend = 0; sys.crouchBlend = 0; sys.proneBlend = 0; sys.sprintBlend = 0; sys.downedBlend = 0;
  sys.bodyYaw = yaw;
  sys.spawned = true;
  sys.controlsEnabled = true;
  sys.model.resetPose();
  sys.model.setFade(1);
  sys.scopeHidden = false;
  sys.model.setVisible(true);
  sys.model.root.position.copy(sys.controller.position);
  sys.model.root.quaternion.setFromAxisAngle(_up, yaw);
  sys.eyePos.set(0, EYE_STAND, 0);
  _v.copy(sys.controller.position); _v.y += EYE_STAND;
  sys.rig.snapTo(_v, yaw);
  sys.rig.setOverride(null);
  sys.interactTarget = null; sys.holdProgress = 0;

  /*
   * 2026-09-10: 실드도 돌려준다. 생략된 값(옛 세이브 · 실드를 모르는 옛 호스트)은 **0 이 아니라 최대치**다 —
   * 모르는 것을 0 으로 읽으면 재접속한 사람만 방탄복을 입은 채 실드를 잃는다. 전투불능 · 사망은 실드가 0.
   */
  sys._shield = 0;
  sys.pendingShield = state.state === 0 ? (Number.isFinite(state.shield) ? (state.shield as number) : Infinity) : null;

  const st = state.state;
  if (st === 2) {
    // dead: lie where the ghost fell; the death anim is already over. No `player:died` — game/ owns the flow.
    sys.hp = 0;
    sys.isDead = true;
    sys.deadTimer = DEATH_ANIM;
    sys.controlsEnabled = false;
    sys.invuln = 0;
    bus.emit('player:healthChanged', { hp: 0, maxHp: sys.maxHp, delta: 0 });
    return;
  }
  if (st === 1) {
    sys.hp = 0;
    sys._downed = true;
    sys._downHp = THREE.MathUtils.clamp(Math.round(Number.isFinite(state.downHp) ? state.downHp : PLAYER_DOWN_HP), 1, PLAYER_DOWN_HP);
    sys.bleedAcc = 0; sys.giveUpHold = 0;
    sys.setStance('prone'); sys.standUpTimer = 0;
    sys.proneBlend = 1;
    sys.downedBlend = 1;
    sys.eyePos.set(0, EYE_PRONE, 0);
    _v.copy(sys.controller.position); _v.y += EYE_PRONE;
    sys.rig.snapTo(_v, yaw);
    bus.emit('player:spawned', { position: sys.controller.position.clone() });
    bus.emit('player:downed', { position: sys.controller.position.clone() });
    bus.emit('player:downHpChanged', { downHp: sys._downHp, max: PLAYER_DOWN_HP });
    bus.emit('player:healthChanged', { hp: 0, maxHp: sys.maxHp, delta: 0 });
    return;
  }
  sys.hp = THREE.MathUtils.clamp(Number.isFinite(state.hp) ? state.hp : sys.maxHp, 1, sys.maxHp);
  bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: 0 });
  bus.emit('player:spawned', { position: sys.controller.position.clone() });
  }

/**
 * Re-drop at `position` like at mission start (hellpod, full hp, alive, not downed). `player:respawn` → here.
 * 2026-09-08: **훈련장에서는 헬포드가 없다** — 시뮬레이션 방에 하늘이 없는 것은 진입이나 재시작이나 같다.
 */
export function respawn(sys: PlayerSystem, position: THREE.Vector3): void {
  sys.respawnAt(sys.resolveSpawn(position));
  if (sys.ctx.missionMode !== 'training') sys.startDrop();
  }

/**
 * Place the player standing at `position` facing `yaw`: alive, full hp / stamina, stance stand, no hellpod,
 * controls enabled, detached from any parent, camera snapped behind the player, not in a pod. Emits
 * `player:spawned`. Does NOT touch `interior` (call `setInterior` before or after) and does not release an
 * active camera override (the hub owns that via `setCameraOverride(null)`).
 */
export function spawnStanding(sys: PlayerSystem, position: THREE.Vector3, yaw: number): void {
  sys.releaseDroneControl();   // 2026-09-11
  sys.clearClimbState();
  sys.hellpod.hide();
  sys.attachTo(null);
  sys.shipBounds = null; sys.controller.shipBounds = null;
  sys._inPod = false;
  sys.controller.reset(position);
  if (sys._interior) {
    const floor = sys._interior.getFloorAt(position.x, position.z);
    if (Math.abs(position.y - floor) < 1.5) sys.controller.position.y = floor;
  }
  sys.hp = sys.maxHp;
  sys.slowTimer = 0; sys.slowFactor = 1; sys.controller.speedMultiplier = 1;
  sys.isDead = false; sys.deadTimer = 0; sys.invuln = 0; sys.flinch = 0;
  sys.healPool = 0;
  sys.clearDowned();
  sys.stamina = sys.maxStamina; sys.regenDelay = 0; sys.exhausted = false; sys.exhaustedSlow = 0;
  sys.setStance('stand'); sys.standUpTimer = 0;
  sys.resetTactical();
  sys.setAiming(false); sys.aimBlend = 0; sys.crouchBlend = 0; sys.proneBlend = 0; sys.sprintBlend = 0; sys.downedBlend = 0;
  sys.bodyYaw = yaw;
  sys.spawned = true;
  sys.controlsEnabled = true;
  sys.model.resetPose();
  sys.model.setFade(1);
  sys.scopeHidden = false;
  sys.model.setVisible(true);
  sys.model.root.position.copy(sys.controller.position);
  sys.model.root.quaternion.setFromAxisAngle(_up, yaw);
  sys.eyePos.set(0, EYE_STAND, 0);
  _v.copy(sys.controller.position); _v.y += EYE_STAND;
  sys.rig.snapTo(_v, yaw);
  sys.interactTarget = null; sys.holdProgress = 0;
  sys.ctx.bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: 0 });
  sys.ctx.bus.emit('player:spawned', { position: sys.controller.position.clone() });
  }

/* ── dev console / unique weapons (2026-09-06) ─────────────────────────── */
/**
 * Instant move without a hellpod (console `/move`, Home move cheat): feet to `position`, velocity / roll / grapple
 * cleared, stance / hp / items / interior untouched, no `player:spawned`. Unless `snap === false` the feet are put
 * on the ground under the target: the interior deck (`interior.getFloorAt`) in the hub, else the terrain
 * (`world.getHeightAt`). Optional `yaw` turns both the camera and the body; the camera follows immediately.
 * Works in the hub and on a mission; ignored while dead, in a pod, or inside the hellpod drop.
 */
export function teleport(sys: PlayerSystem, position: THREE.Vector3, yaw?: number, snap?: boolean): void {
  if (!sys.spawned || sys.isDead || sys._inPod) return;
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return;
  sys.clearClimbState();
  _v.copy(position);
  if (snap !== false) {
    if (sys._interior) _v.y = sys._interior.getFloorAt(_v.x, _v.z);
    else if (sys.ctx.world?.ready) _v.y = sys.ctx.world.getHeightAt(_v.x, _v.z);
  }
  const c = sys.controller;
  const stance = c.stance;
  const wasGrounded = c.grounded;
  c.reset(_v);
  c.stance = stance;                       // reset() forces stand; keep crouch / prone (downed stays prone)
  if (snap === false) c.grounded = wasGrounded;
  sys.controller.speedMultiplier = 1;
  sys.standUpTimer = 0;
  sys.rollBlend = 0; sys.rollPhase = 0;
  sys._grappling = false;
  if (yaw !== undefined) sys.bodyYaw = yaw;
  const root = sys.model.root;
  if (!sys.attachedParent) { root.position.copy(_v); root.quaternion.setFromAxisAngle(_up, sys.bodyYaw); }
  _v.y += sys.eyePos.y;
  sys.rig.jumpTo(_v, yaw);   // keeps pitch (and yaw unless given) — the move cheat calls this every frame
  }

export function respawnAt(sys: PlayerSystem, position: THREE.Vector3, yaw?: number): void {
  const y = yaw ?? Math.atan2(position.x, position.z); // face the map centre by default
  sys.releaseDroneControl();   // 2026-09-11
  sys.clearClimbState();
  sys.attachTo(null);
  sys.setInterior(null);
  sys._inPod = false;
  sys.shipBounds = null;
  sys.controller.shipBounds = null;
  sys.controller.reset(position);
  sys.hp = sys.maxHp;
  sys.slowTimer = 0; sys.slowFactor = 1; sys.controller.speedMultiplier = 1;
  sys.isDead = false; sys.deadTimer = 0; sys.invuln = 0; sys.flinch = 0;
  sys.healPool = 0;
  sys.clearDowned();
  sys.stamina = sys.maxStamina; sys.regenDelay = 0; sys.exhausted = false; sys.exhaustedSlow = 0;
  sys.setStance('stand'); sys.standUpTimer = 0;
  sys.resetTactical();
  sys.isAiming = false; sys.aimBlend = 0; sys.crouchBlend = 0; sys.proneBlend = 0; sys.sprintBlend = 0; sys.downedBlend = 0;
  sys.bodyYaw = y;
  sys.spawned = true;
  sys.controlsEnabled = true;
  sys.model.resetPose();
  sys.model.setFade(1);
  sys.scopeHidden = false;
  sys.model.setVisible(true);
  sys.model.root.position.copy(position);
  sys.model.root.quaternion.setFromAxisAngle(_up, y);
  sys.eyePos.set(0, EYE_STAND, 0);
  _v.copy(position); _v.y += EYE_STAND;
  sys.rig.snapTo(_v, y);
  sys.rig.setOverride(null);
  sys.ctx.bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: 0 });
  sys.ctx.bus.emit('player:spawned', { position: position.clone() });
  }

/* ─────────────────────── tactical kit internals ─────────────────────── */
/**
 * Clear every tactical-kit state (roll, melee, cloak, burning, grapple, hover, buffs).
 * Called from `respawnAt`, `spawnStanding` and the `game:abort` reset. The gear cache is only marked dirty —
 * armor survives a respawn.
 */
export function resetTactical(sys: PlayerSystem): void {
  sys.clearCarry('reset');
  sys.controller.cancelRoll();
  sys.controller.grappleTarget = null; sys._grappling = false;
  sys.controller.hovering = false;
  sys.rollBlend = 0; sys.rollPhase = 0; sys.rollCooldown = 0;
  sys.meleeTimer = 0; sys.meleeCooldown = 0; sys.meleeKind = 'light'; sys.meleeDuration = MELEE_SWING_TIME;
  sys.chargeBlend = 0; sys.sprayBlend = 0; sys.heavyBlend = 0;
  sys.weaponState.charging = false; sys.weaponState.spraying = false; sys.weaponState.heavy = false;
  if (sys.rig) sys.rig.viewWiden = false;
  sys.cloakTimer = 0; sys.cloakBreak = 0; sys.cloakProbe = 0; sys.cloakNearEnemy = false;
  sys.cloakSource = null;
  if (sys._cloaked) { sys._cloaked = false; sys.ctx?.bus.emit('player:cloakChanged', { cloaked: false, source: null }); }
  sys.speedMods.clear();
  sys._overchargedUntil = 0;
  sys._hovering = false; sys.hoverBlend = 0; sys.autoHoverUsed = false;
  if (sys._burning) { sys._burning = false; sys.ctx?.bus.emit('player:burning', { active: false, dps: 0 }); }
  sys.burnDps = 0; sys.burnTimer = 0; sys.burnTick = 0;
  sys.regenAccum = 0;
  sys.gear.markDirty();
  }

/**
 * Multiplayer: every client drops on its own pad around the shared spawn — a ring of radius
 * SPAWN_RING_RADIUS, one slot per quadrant (slot × 90° + 45°), snapped to the terrain and pushed
 * out of obstacles. Single-player uses the world spawn untouched.
 */
export function resolveSpawn(sys: PlayerSystem, playerSpawn: THREE.Vector3): THREE.Vector3 {
  const ctx = sys.ctx;
  if (!ctx.isMultiplayer || !ctx.net) return playerSpawn;
  const slot = ctx.net.localSlot;
  const angle = slot * (Math.PI / 2) + Math.PI / 4;
  const out = _spawn;
  out.set(playerSpawn.x + Math.cos(angle) * SPAWN_RING_RADIUS, playerSpawn.y, playerSpawn.z + Math.sin(angle) * SPAWN_RING_RADIUS);
  const world = ctx.world;
  if (world && world.ready) {
    out.y = world.getHeightAt(out.x, out.z);
    world.resolveCollision(out, PLAYER_RADIUS);
    out.y = world.getHeightAt(out.x, out.z);
  }
  return out;
  }

/** Rejoin wait: everything reset like `game:abort`, feet + camera parked at `position`, model hidden, no controls. */
export function holdForRestore(sys: PlayerSystem, position: THREE.Vector3): void {
  sys.resetAll();
  sys.setInterior(null);
  sys.controller.reset(position);
  sys.bodyYaw = Math.atan2(position.x, position.z);
  sys.model.root.position.copy(position);
  sys.model.root.quaternion.setFromAxisAngle(_up, sys.bodyYaw);
  sys.eyePos.set(0, EYE_STAND, 0);
  _v.copy(position); _v.y += EYE_STAND;
  sys.rig.snapTo(_v, sys.bodyYaw);
  }

/**
 * 헬포드 강하 시작. `kind` 0 = 미션 시작, 1 = 구조선 (2026-09-09).
 *
 * 2026-09-09: **분대원에게도 포드가 보인다.** 지금까지 원격 분대원은 자리에 그냥 나타났다 — 이제 강하를
 * 시작한 사람이 `pod drop` 을 `'others'` 로 보내고, 받은 쪽(`RemotePlayerSystem`)이 원격 포드를 떨어뜨린다.
 * 카메라 연출은 로컬만의 것이라 와이어에 없다.
 */
export function startDrop(sys: PlayerSystem, kind: 0 | 1 = 0): void {
  const pos = sys.controller.position;
  sys.controlsEnabled = false;
  sys.model.setVisible(false);
  sys.hellpod.start(pos, sys.bodyYaw);
  if (sys.hellpod.getCameraPose(_camPos, _camLook)) sys.rig.setOverride(_camPos, _camLook, true);
  sys.ctx.bus.emit('audio:play', { id: 'hellpod_fall', position: pos, volume: 1 });
  const ctx = sys.ctx;
  const me = ctx.net?.localId;
  if (ctx.isMultiplayer && me) {
    ctx.net?.send({ t: 'pod', ev: 'drop', who: me, p: [pos.x, pos.y, pos.z], yaw: sys.bodyYaw, kind }, 'others');
  }
  }

/**
 * 구조 포드 착륙 (`rescue:landed`, 2026-09-09). 내가 대상일 때만 반응한다 — 헬포드 강하로 다시 서고,
 * 체력은 `RESCUE_REVIVE_HP`, **인벤토리는 빈 채로**다 (들고 있던 것은 전부 시체에 남았다).
 * 흐름(페이즈 · 분대장 표시)은 `game/parts/Death.onRescueLanded` 이 맡는다.
 */
export function rescueRevive(sys: PlayerSystem, position: THREE.Vector3): void {
  // 착륙 지점은 호스트가 `world.scatterPoints` 로 이미 정해 보낸 값이다 — 분대 스폰 링을 다시 씌우지 않는다.
  _v.copy(position);
  if (sys.ctx.world?.ready) _v.y = sys.ctx.world.getHeightAt(_v.x, _v.z);
  sys.respawnAt(_v.clone());
  sys.hp = THREE.MathUtils.clamp(Math.round(RESCUE_REVIVE_HP), 1, sys.maxHp);
  sys.ctx.bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: 0 });
  if (sys.ctx.missionMode !== 'training') sys.startDrop(1);
  }

export function updateDrop(sys: PlayerSystem, dt: number): void {
  const ev = sys.podEvents;
  sys.hellpod.update(dt, ev);
  if (ev.impact) {
    sys.model.setVisible(!sys._inPod);
    sys.rig.addShake(1.0, 0.7);
    sys.ctx.bus.emit('player:landed', { impactSpeed: sys.hellpod.impactSpeed });
    sys.ctx.bus.emit('camera:shake', { intensity: 0.4, duration: 0.5 });
    sys.ctx.bus.emit('audio:play', { id: 'hellpod_impact', position: sys.controller.position, volume: 1 });
  }
  if (ev.opened) {
    sys.controlsEnabled = true;
    sys.rig.setOverride(null);
    sys.ctx.bus.emit('audio:play', { id: 'hellpod_open', position: sys.controller.position, volume: 0.9 });
  }
  if (sys.hellpod.state === 'opening' && sys.hellpod.exitProgress === 0) {
    // release the cutscene camera as soon as the doors start moving
    sys.rig.setOverride(null);
  }
  }

export function resetAll(sys: PlayerSystem): void {
  sys.releaseDroneControl();   // 2026-09-11: game:abort · 재접속 대기
  sys.clearClimbState();
  sys.hellpod.hide();
  sys.attachTo(null);
  sys.shipBounds = null; sys.controller.shipBounds = null;
  // `interior` is deliberately kept: the hub may have set it before aborting the mission; respawnAt / hub:left clear it
  sys._inPod = false;
  sys.model.setSilhouette(false);
  sys.model.setFade(1);
  sys.scopeHidden = false;
  sys.model.setVisible(false);
  sys.model.resetPose();
  sys.spawned = false;
  sys.controlsEnabled = false;
  sys.isDead = false; sys.deadTimer = 0;
  sys.healPool = 0;
  sys.clearDowned();
  sys.lookLocked = false;
  sys.weaponState.throwing = false; sys.weaponState.holdingItem = false; sys.weaponState.cooking = false;
  sys.throwBlend = 0; sys.holdItemBlend = 0; sys.cookBlend = 0;
  sys.setAiming(false);
  sys.setStance('stand'); sys.standUpTimer = 0;
  sys.stamina = sys.maxStamina; sys.regenDelay = 0; sys.exhausted = false; sys.exhaustedSlow = 0;
  sys.resetTactical();
  sys.crouchBlend = 0; sys.proneBlend = 0; sys.downedBlend = 0;
  sys.cancelHold(); sys.interactTarget = null;
  if (sys.lastPromptText !== null) { sys.lastPromptText = null; sys.lastHoldProgress = 0; sys.ctx.bus.emit('interact:promptChanged', { text: null, holdProgress: 0 }); }
  sys.rig.setOverride(null);
  }
