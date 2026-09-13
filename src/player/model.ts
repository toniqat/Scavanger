/**
 * src/player/model.ts — 플레이어 폴더의 공용 어휘.
 *
 * `PlayerSystem` 에서 떼어낸 상수 · 타입 · 스크래치 벡터만 있다. 클래스를 참조하지 않으므로
 * `parts/*` 모듈이 클래스를 되돌아 import 하지 않고 쓸 수 있다(순환 import 방지).
 * `PlayerSystem.ts` 가 그대로 재수출하므로 기존 import 경로는 전부 유지된다.
 */
import * as THREE from 'three';
import type { FurniturePoseKind, PlayerRestoreState } from '@/shared';
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

/* ── 가구 자세 (2026-09-12, `parts/FurniturePose`) — 몸의 오프셋은 `SoldierModel` 의 `FURN_*` 가 원본이다 ── */
/** 자세 블렌드(0 ↔ 1)의 감쇠 계수 — 앉기 · 눕기 · 일어서기가 약 0.6 초에 끝난다. */
export const FURN_BLEND_RATE = 5;
/** 자세 중 몸이 향하는 방향으로 도는 감쇠 계수. */
export const FURN_YAW_RATE = 10;
/** 카메라 피벗(눈) 높이 — **anchor 위**로 잰다. 흔들의자는 자유 시점이라 이 값이 곧 궤도 중심이다. */
export const FURN_EYE: Readonly<Record<FurniturePoseKind, number>> = {
  sit: 0.85, bench: 0.45, run: EYE_STAND, cycle: 0.8,
  /* 2026-09-13 요리: anchor = 바닥이고 조리대 쪽으로 약 0.3 rad 숙여 서 있다 — 선 눈높이보다 조금 낮다 (`SoldierModel.FURN_COOK`). */
  cook: 1.42,
};
/** 부른 쪽이 위상을 한 번도 안 주면 스스로 도는 속도: 벤치 한 회 (초) · 달리기 걸음 / 초 · 페달 바퀴 / 초. */
export const FURN_BENCH_REP_S = 2.6;
export const FURN_RUN_STEPS_PER_S = 2.8;
export const FURN_CYCLE_REV_PER_S = 1.2;
/** 2026-09-13 요리: `cook` 을 부른 쪽이 위상을 한 번도 안 주면 손 동작이 스스로 도는 속도 (주기 / 초) — 느린 칼질 · 젓기. */
export const FURN_COOK_CYCLE_PER_S = 0.9;
/** `run` 은 보행 주기를 그대로 쓴다 — 그때 넣는 moveBlend · sprint 블렌드. */
export const FURN_RUN_MOVE = 1.15;
export const FURN_RUN_SPRINT = 0.7;
/** `releaseOnInteract` 자세에서 E 캡션. */
export const FURN_STAND_PROMPT = '일어나기';
/** 원격 명판: 자세 중 머리 높이 = anchor + `FURN_EYE[kind]` + 이만큼 (서 있을 때 머리 1.7 − 눈 1.55). */
export const FURN_HEAD_ABOVE_EYE = 0.15;

/* ── 가구 자세 공용 수학 (2026-09-12 캐릭터 버프 — 로컬 `parts/FurniturePose` 와 원격 `RemoteAvatar` 가 같은 식을 쓴다) ── */
/** 몸(루트) 방향 — `bench` 는 머리 → 거치대라 발끝이 반대 = `yaw + π`. */
export function furnitureBodyYaw(kind: FurniturePoseKind, yaw: number): number {
  return kind === 'bench' ? yaw + Math.PI : yaw;
}
/** 자세 블렌드 한 걸음 (`FURN_BLEND_RATE`). */
export function stepFurnitureBlend(blend: number, on: boolean, dt: number): number {
  return damp(blend, on ? 1 : 0, FURN_BLEND_RATE, dt);
}
/** 루트를 anchor 쪽으로: `out` 에는 서 있던 자리가 이미 들어 있다 — smoothstep(blend) 만큼 `anchor` 로 끌어간다. */
export function lerpFurnitureRoot(out: THREE.Vector3, anchor: THREE.Vector3, blend: number): THREE.Vector3 {
  const e = blend * blend * (3 - 2 * blend);
  return out.lerp(anchor, e);
}
/**
 * `SoldierPose` 의 가구 자세 필드. `cumPhase` 는 **누적 위상**(`FurniturePoseState.phase` 와이어 규약 — bench 0…1 · run 걸음 수 ·
 * cycle 바퀴 수 · cook 손 동작 주기 수 · sit 0). `run` 은 보행 주기(`stridePhase = π × 걸음`)를 타고, 나머지는 `SoldierModel.poseFurniture` 가
 * 뼈대를 맡는다 (`cook` 은 소수부 = 한 주기 안의 위치).
 * 호출 전에 평소 자세 값(moveBlend · sprint …)이 이미 쓰여 있어야 한다 — `run` 은 그 위에 블렌드한다.
 */
export function writeFurniturePose(p: SoldierPose, kind: FurniturePoseKind | null, blend: number, cumPhase: number): void {
  if (kind === null) { p.furniture = 0; p.furnitureKind = null; p.furniturePhase = 0; return; }
  const ph = Number.isFinite(cumPhase) ? cumPhase : 0;
  p.furniture = blend;
  p.furnitureKind = kind;
  p.furniturePhase = kind === 'bench' || kind === 'sit' ? Math.min(1, Math.max(0, ph)) : ph - Math.floor(ph);
  if (kind !== 'run') return;
  const e = blend;
  p.moveBlend += (FURN_RUN_MOVE - p.moveBlend) * e;
  p.sprint += (FURN_RUN_SPRINT - p.sprint) * e;
  p.stridePhase = Math.PI * ph;
  p.airborne *= 1 - e;
  p.torsoTwist *= 1 - e;
  p.crouch *= 1 - e;
}
/** 캐릭터 버프 목록을 다시 모으는 주기(초) — 운동 디버프 만료처럼 이벤트가 없는 변화를 잡는다 (`parts/Buffs`). */
export const BUFF_TICK_S = 1;

/** `PlayerSystem.furn` — 가구 자세 하나의 상태 (`parts/FurniturePose` 만 쓴다). */
export interface FurniturePoseState {
  /** 논리 상태 (`PlayerRef.furniturePose`). null = 자세 없음. */
  kind: FurniturePoseKind | null;
  /** 모델이 그리는 자세 — 풀린 뒤에도 블렌드가 0 이 될 때까지 남는다. */
  visKind: FurniturePoseKind | null;
  /** 0..1, `FURN_BLEND_RATE` 로 감쇠. */
  blend: number;
  releaseOnInteract: boolean;
  readonly anchor: THREE.Vector3;
  yaw: number;
  /** 고정 카메라를 걸었는가 (`camPos` · `camLook` 이 그 값). */
  hasCamera: boolean;
  readonly camPos: THREE.Vector3;
  readonly camLook: THREE.Vector3;
  /** 자세 직전의 발 위치 · 몸 방향 · 자세 — 풀면 여기로 돌아간다. */
  readonly restorePos: THREE.Vector3;
  restoreYaw: number;
  restoreStance: Stance;
  /** `setFurniturePoseDrive` 가 한 번이라도 불렸는가 (아니면 스스로 돈다). */
  driven: boolean;
  /** 위상 0..1 — `bench` 바벨 · `cycle` 크랭크 · `run` 걸음 안의 위치. */
  phase: number;
  /**
   * `run`: 지나간 걸음 수 · `cycle`: 지나간 바퀴 수 (위상이 1 → 0 으로 감길 때마다 +1 — 좌우 발이 번갈아야 한다).
   * 2026-09-12: 와이어의 **누적 위상**이 `steps + phase` 다 (`furniturePoseState`).
   */
  steps: number;
  /** 자기 구동용 시계 (초). */
  clock: number;
  /** 2026-09-12: `FurniturePose.furnitureUid` (모르면 null) — 버프 · 와이어가 가구 조각을 가리킨다. */
  furnitureUid: string | null;
  /** 2026-09-12: `PlayerRef.furniturePoseState` 가 돌려주는 재사용 객체 (`anchor` 는 위 `anchor` 와 같은 Vector3). */
  readonly wire: { kind: FurniturePoseKind; anchor: THREE.Vector3; yaw: number; phase: number; furnitureUid: string | null };
}

export function createFurniturePoseState(): FurniturePoseState {
  const anchor = new THREE.Vector3();
  return {
    kind: null, visKind: null, blend: 0, releaseOnInteract: false,
    anchor, yaw: 0,
    hasCamera: false, camPos: new THREE.Vector3(), camLook: new THREE.Vector3(),
    restorePos: new THREE.Vector3(), restoreYaw: 0, restoreStance: 'stand',
    driven: false, phase: 0, steps: 0, clock: 0,
    furnitureUid: null,
    wire: { kind: 'sit', anchor, yaw: 0, phase: 0, furnitureUid: null },
  };
}

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
