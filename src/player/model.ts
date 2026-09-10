/**
 * src/player/model.ts — 플레이어 폴더의 공용 어휘.
 *
 * `PlayerSystem` 에서 떼어낸 상수 · 타입 · 스크래치 벡터만 있다. 클래스를 참조하지 않으므로
 * `parts/*` 모듈이 클래스를 되돌아 import 하지 않고 쓸 수 있다(순환 import 방지).
 * `PlayerSystem.ts` 가 그대로 재수출하므로 기존 import 경로는 전부 유지된다.
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
import { SoldierModel, type SoldierPose } from './SoldierModel';
import { CameraRig, type RigInput } from './CameraRig';
import { PlayerController, type MoveInput, type MoveResult, type ShipBounds } from './PlayerController';
import { Hellpod, type HellpodEvents } from './Hellpod';
import { PlayerGear } from './PlayerGear';
import type { CarryEndReason, PortraitRef } from '@/shared';
import { PLAYER_CARRY_DROP_S, PLAYER_CARRY_OFFSET, PLAYER_CARRY_PICKUP_S, PLAYER_CARRY_RANGE, PLAYER_CARRY_SPEED_MUL } from '@/shared';
import type { CarryHost } from './Carry';
import { createPortraits } from './Portraits';
/* appended (Phase 10): 부상자 들쳐메기 + 준비 패널 초상화 */

/** Phase 12 perk `auto_revive`: seconds between going down and the automatic stand-up. */
export const AUTO_REVIVE_DELAY_S = 1;

export const EYE_STAND = 1.55;
export const EYE_CROUCH = 1.15;
export const EYE_PRONE = 0.45;
/** Eye height at the top of the tumble (the rig keeps following the pivot). */
export const EYE_ROLL = 0.95;

/* ── tactical kit tuning (local; the shared numbers live in shared/constants) ── */
/** Melee swing animation length; must stay below MELEE_COOLDOWN. */
export const MELEE_SWING_TIME = 0.45;
/** Cloaked players are drawn semi-transparent for themselves too (remotes use the same value). */
export const CLOAK_FADE = 0.4;
/** How often the cloak checks for enemies inside CLOAK_REVEAL_DISTANCE (seconds). */
export const CLOAK_PROBE_INTERVAL = 0.25;
/** Burning DoT is applied in ticks so the HUD is not spammed 60×/s. */
export const BURN_TICK = 0.5;
/** Stamina drained per second while the tactical bag hovers. */
export const HOVER_STAMINA_DRAIN = 10;
/** Fall speed (m/s, negative) that auto-triggers the tactical bag's one free hover (낙사 방지). */
export const HOVER_AUTO_FALL = -18;
/** Speed-modifier keys the player owns itself (external callers must not reuse them). */
export const SPEEDMOD_WEIGHT = 'weight';
export const SPEEDMOD_ARMOR = 'armor';
export const INVULN_TIME = 0.15;
export const STIM_DURATION = 1.5;
export const DEATH_ANIM = 0.9;
/** Phase 9: max rate of `player:giveUpProgress` while the Space give-up hold runs. */
export const GIVE_UP_PROGRESS_HZ = 20;
/** Minimum upward speed (m/s) a knockback carries so the feet leave the ground and the shove is not eaten by friction. */
export const KNOCKBACK_MIN_LIFT = 1.5;

// stamina tuning
export const STAMINA_SPRINT_DRAIN = 14;     // per second
export const STAMINA_JUMP_COST = 12;
export const STAMINA_REGEN_DELAY = 0.8;
export const STAMINA_REGEN_MOVING = 16;     // per second
export const STAMINA_REGEN_IDLE = 22;
export const STAMINA_SPRINT_RECOVER = 20;   // sprint unavailable after depletion until this much
export const EXHAUSTED_SLOW_TIME = 1.0;
export const EXHAUSTED_SLOW = 0.9;
export const STAND_UP_TIME = 0.35;          // prone → stand/crouch transition (no jump/sprint/roll)
export const SPAWN_RING_RADIUS = 4;         // multiplayer: per-slot drop offset around the shared spawn (m)
// near-clip body fade: fully visible beyond FADE_FAR m camera->pivot, hidden inside FADE_NEAR
export const FADE_FAR = 0.9;
export const FADE_NEAR = 0.45;

/* ── 단차 보간 · 사다리 (2026-09-11) — 수치 원본은 `STEP_SMOOTH_RATE` · `STEP_SMOOTH_MAX` (data/constants.csv) ── */
/** 한 프레임 높이 변화가 이보다 작으면(m) 보간하지 않는다 — 지형 굴곡은 그대로 따라간다. */
export const STEP_SMOOTH_MIN = 0.04;
/**
 * 높이 변화 / 수평 이동이 이 비율을 넘을 때만 "단차" 다. 경사면(최대 50° ≈ 1.19)은 연속이므로 보간하면 모델이
 * 발밑에서 뜨거나 가라앉는다 — 낮은 바위 · 상자 모서리 · `SNAP_DOWN` 은 한 프레임에 수 배로 튄다.
 */
export const STEP_SLOPE_RATIO = 1.5;
/** 사다리를 잡을 때 몸이 옮겨 붙는 시각 보간의 최대 길이(m). */
export const CLIMB_GRAB_OFFSET_MAX = 2;
/** 가로대 소리 크기: 보통 / 빠르게. */
export const LADDER_STEP_VOLUME = 0.45;
export const LADDER_STEP_VOLUME_FAST = 0.6;

export const _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _spawn = new THREE.Vector3();
export const _q = new THREE.Quaternion(), _camPos = new THREE.Vector3(), _camLook = new THREE.Vector3();
export const _dir = new THREE.Vector3();

export interface WeaponState {
  hasWeapon: boolean; reloading: boolean; firing: boolean; twoHanded: boolean; throwing: boolean; holdingItem: boolean;
  /* unique weapons (2026-09-06): braced charge stance, continuous hip spray, heavy hip carry */
  charging: boolean; spraying: boolean; heavy: boolean;
  /* Phase 7: pin pulled (grenade cooking) — optional hint, remotes get it from the COOKING flag */
  cooking: boolean;
}
/** Melee swing kinds: `light` = the F chop (MELEE_SWING_TIME), `heavy` = the 용검 two-handed slash (SLASH_DURATION). */
export type MeleeKind = 'light' | 'heavy';

/** One entry of the multiplicative speed-modifier stack (`setSpeedModifier`). */
export interface SpeedMod { mul: number; until: number }

/**
 * Third-person player: controller + camera rig + procedural soldier + health/stims + stamina +
 * stances (C crouch / Z prone / Alt dive) + interaction + hellpod drop + downed / revive / respawn (Phase 2).
 * Publishes itself as `ctx.player` (PlayerRef & PlayerWeaponHost).
 */
