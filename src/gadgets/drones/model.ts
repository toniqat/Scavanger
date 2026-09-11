/**
 * src/gadgets/drones/model.ts — **드론 폴더 공용 어휘.**
 *
 * `DroneSystem`(코어: 꺼내기 · 조종 전환 · 카메라 · 사거리 · 소유자 권한 동기화 · 회수)은 몸체 종류를 모른다.
 * 지상 드론(`GroundDrone`)과 공중 드론(`AirDrone`)이 이 `DroneBody` 를 각자 구현해 물리 · 모델 · 카메라 자세를 채운다.
 * 공개 계약은 `@/shared` 의 `drones.ts` 이고, 이 파일은 폴더 안에서만 쓴다.
 */
import * as THREE from 'three';
import type { DroneKind, GameContext } from '@/shared';
import {
  DRONE_AIR_HP, DRONE_AIR_RANGE, DRONE_GROUND_HP, DRONE_GROUND_RANGE, DroneFlags,
  type DroneRef, type Interactable, type PeerId,
} from '@/shared';

/** 조종 입력 한 프레임. `DroneSystem` 이 키 · 마우스에서 만든다 (몸체는 `ctx.input` 을 직접 읽지 않는다). */
export interface DroneInput {
  /** −1..1 — 드론 시점 기준 앞(+) / 뒤. */
  forward: number;
  /** −1..1 — 오른쪽(+) / 왼쪽. */
  right: number;
  /** 공중 드론: Space = +1, C = −1. 지상 드론은 무시한다. */
  vertical: number;
  /** 지상 드론: Shift 질주. */
  sprint: boolean;
  /** 지상 드론: 이 프레임에 Space 가 **눌렸다** (홀드가 아니다). */
  jump: boolean;
  /** 드론 시점의 yaw / pitch (rad). */
  yaw: number;
  pitch: number;
}

export interface DroneBody {
  readonly kind: DroneKind;
  /** 씬에 붙는 루트. **광원 금지** — 씬 광원 개수 규칙(CLAUDE.md). 발광은 emissive / additive 로만. */
  readonly root: THREE.Group;
  readonly radius: number;
  readonly height: number;
  /** 지상 = 바닥점, 공중 = 몸체 중심. `DroneRef.position` 이 이 벡터를 그대로 내보낸다. */
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly yaw: number;
  readonly sprinting: boolean;
  readonly airborne: boolean;
  /** 꺼낸 자리 · 방향으로 초기화한다. */
  reset(position: THREE.Vector3, yaw: number, ctx: GameContext): void;
  /** 소유자 쪽 물리 한 프레임. `input` null = 아무도 조종하지 않는다 (지상은 멈추고, 공중은 제자리 비행). */
  simulate(dt: number, ctx: GameContext, input: DroneInput | null): void;
  /** 복제본: 보간된 와이어 자세(`DroneFlags` 포함)를 그대로 입힌다. */
  applyRemote(position: THREE.Vector3, yaw: number, flags: number): void;
  /** 바퀴 · 로터 · LED 같은 시각 연출 (소유자 · 복제본 둘 다). */
  animate(dt: number, time: number): void;
  /** 1인칭 렌즈 위치와 바라볼 점. */
  getCameraPose(pitch: number, outPos: THREE.Vector3, outLook: THREE.Vector3): void;
  /** 소형 설치물이 올라앉는 윗면 중심. */
  getMountPoint(out: THREE.Vector3): THREE.Vector3;
  /** 몸체와의 광선 교차 거리, 없으면 −1. 할당하지 않는다. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number;
  /** 소유자가 이 드론 시점으로 볼 때 렌즈를 가리는 부분을 숨긴다. */
  setOwnerView(looking: boolean): void;
  dispose(): void;
}

/* ═══════════════════════ appended (2026-09-11, 드론 코어) ═══════════════════════ */

/*
 * ── yaw 규약 (두 몸체가 반드시 같아야 한다) ─────────────────────────────────────────
 * 드론의 yaw 는 **모델의 +Z 가 코** 인 규약이다 — `root.rotation.y = yaw` 이면 코가 향하는 방향은
 *   forward = ( sin yaw, 0, cos yaw ),   right = ( −cos yaw, 0, sin yaw )
 * 이고 pitch 는 + 가 위다 (`look.y = sin pitch`). 마우스는 플레이어 카메라 리그와 똑같이 `yaw −= dx × 감도`
 * `pitch −= dy × 감도` 로 돈다 — 그러면 마우스를 오른쪽으로 밀 때 코가 오른쪽으로 돈다.
 * 플레이어의 yaw 는 반대 규약(forward = −sin, −cos)이라 PC 가 보는 방향으로 꺼내려면 `+π` 한다 (`droneYawFromPlayer`).
 */
export function droneYawFromPlayer(playerYaw: number): number { return wrapAngle(playerYaw + Math.PI); }

export function wrapAngle(a: number): number {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2; else if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** `from` → `to` 로 가는 가장 짧은 각. */
export function angleDelta(from: number, to: number): number { return wrapAngle(to - from); }

/** 드론 종류별 사거리(m, 3D) · 최대 체력 · 한국어 이름. */
export function droneRange(kind: DroneKind): number { return kind === 'air' ? DRONE_AIR_RANGE : DRONE_GROUND_RANGE; }
export function droneMaxHp(kind: DroneKind): number { return kind === 'air' ? DRONE_AIR_HP : DRONE_GROUND_HP; }
export function droneName(kind: DroneKind): string { return kind === 'air' ? '공중 드론' : '지상 드론'; }

/* ── 조작감 · 시각 · 네트워크 보조값 (게임플레이 수치 아님) ── */
/** `player/CameraRig.sensitivity` 와 같은 값 (설정으로 바뀌지 않는 고정값이다). */
export const DRONE_LOOK_SENSITIVITY = 0.0022;
/** 드론 시점 pitch 한계 (rad). 몸체가 더 좁게 자를 수 있다. */
export const DRONE_LOOK_PITCH_MAX = 1.4;
/** 복제본 보간: 샘플 사이가 이보다 멀면 끌어오지 않고 순간이동한다 (m). */
export const DRONE_REPLICA_SNAP_DIST = 8;
/** 질주음 · 지지직 · 조종 중 걷기음의 반복 간격 (초, 오디오 박자). */
export const DRONE_SPRINT_SFX_S = 0.32;
export const DRONE_STATIC_SFX_S = 0.45;
export const DRONE_MOVE_SFX_S = 0.42;
/** 모르는 드론의 `state` 를 받았을 때 그 소유자에게 `droneq sync` 를 다시 묻기까지의 최소 간격 (초). */
export const DRONE_SYNC_RETRY_S = 2;

/* ── 조작감 수치 — 2026-09-11 리드가 `data/constants.csv` 로 옮겼다. 옛 이름은 호출부를 위해 재수출만 한다. ── */
export {
  DRONE_DEPLOY_DIST_GROUND, DRONE_DEPLOY_DIST_AIR, DRONE_DEPLOY_LIFT_AIR,
  DRONE_GROUND_ACCEL, DRONE_GROUND_BRAKE, DRONE_GROUND_AIR_ACCEL, DRONE_RECOVER_AIR_BONUS,
} from '@/shared';

/* ── 스크래치 (용도별로 나눴다 — 한 함수가 인자로 받은 스크래치를 다른 함수가 덮어쓰지 않게) ── */
export const UP = new THREE.Vector3(0, 1, 0);
/** Control: 카메라 자세. */
export const _camPos = new THREE.Vector3();
export const _camLook = new THREE.Vector3();
/** Lifecycle: 꺼낼 자리 · 광선. */
export const _l0 = new THREE.Vector3();
export const _l1 = new THREE.Vector3();
export const _l2 = new THREE.Vector3();
/** Wire: 수신한 샘플. */
export const _w0 = new THREE.Vector3();

/**
 * `DroneRef` 구현 — 몸체(`DroneBody`) 하나와 그 드론의 코어 상태. 소유자 쪽(`owner === 'local'`)은 몸체를 직접
 * 시뮬레이션하고, 복제본은 와이어 샘플을 보간해 `applyRemote` 로 입힌다.
 *
 * `owner` 는 **내 드론이면 늘 `'local'`** (싱글 · 멀티 모두), 복제본이면 소유자 PeerId 다 — 와이어에는 내 PeerId 가 실린다.
 */
export class Drone implements DroneRef {
  readonly id: string;
  readonly kind: DroneKind;
  readonly owner: PeerId | 'local';
  readonly body: DroneBody;
  private readonly ctx: GameContext;
  hp: number;
  maxHp: number;
  removing = false;
  /** 소유자 쪽: 이 클라이언트가 지금 이 드론 시점으로 본다. */
  localControlled = false;
  /** 복제본: 마지막 와이어 플래그. 소유자: 마지막으로 보낸 플래그. */
  flags = 0;
  linkRatio = 0;
  /** 소유자 쪽: 이 시각(`ctx.time`)까지 질주 소음이 남는다 → `aggroable`. */
  noiseUntil = -Infinity;
  /** 권한 클라이언트: 다음 `world:noise` 를 낼 수 있는 시각. */
  noiseNextAt = 0;
  /** `world:noise.position` · 폭발/회수 오디오의 위치 — 이 드론이 가진 벡터라 받는 쪽이 들고 있어도 안전하다. */
  readonly noisePos = new THREE.Vector3();
  readonly fxPos = new THREE.Vector3();
  /** 조종 시점 (드론 yaw 규약). */
  lookYaw = 0;
  lookPitch = 0;
  /* 네트워크 (소유자) */
  netNextAt = 0;
  netDirty = true;
  /* 오디오 박자 */
  sprintSfxT = 0;
  /** 복제본: 지난 프레임에 공중이었나 (점프 · 착지음). */
  airborneSeen = false;
  interactable: Interactable | null = null;
  /* 복제본 보간 — 지금 그려진 자세 → 마지막 샘플을 샘플 간격 동안 */
  readonly fromPos = new THREE.Vector3();
  fromYaw = 0;
  readonly toPos = new THREE.Vector3();
  toYaw = 0;
  lerpT0 = 0;
  lerpDur = 0;
  lastSampleAt = -1;
  readonly renderPos = new THREE.Vector3();

  constructor(ctx: GameContext, id: string, kind: DroneKind, owner: PeerId | 'local', body: DroneBody, hp: number, maxHp: number) {
    this.ctx = ctx;
    this.id = id;
    this.kind = kind;
    this.owner = owner;
    this.body = body;
    this.hp = hp;
    this.maxHp = maxHp;
  }

  get isLocal(): boolean { return this.owner === 'local'; }
  get position(): THREE.Vector3 { return this.body.position; }
  get yaw(): number { return this.body.yaw; }
  get radius(): number { return this.body.radius; }
  get height(): number { return this.body.height; }
  get object(): THREE.Object3D { return this.body.root; }
  get controlled(): boolean { return this.isLocal ? this.localControlled : (this.flags & DroneFlags.CONTROLLED) !== 0; }
  get sprinting(): boolean { return this.isLocal ? this.body.sprinting : (this.flags & DroneFlags.SPRINTING) !== 0; }
  get aggroable(): boolean {
    if (this.kind === 'air') return true;
    return this.isLocal ? this.ctx.time < this.noiseUntil : (this.flags & DroneFlags.NOISY) !== 0;
  }
  get linkLost(): boolean { return this.linkRatio >= 1; }
  get mountedDeployableId(): string | null {
    const list = this.ctx.gadgets?.getDeployables();
    if (!list) return null;
    for (let i = 0; i < list.length; i++) if (list[i].mount === this.id) return list[i].id;
    return null;
  }
  getMountPoint(out: THREE.Vector3): THREE.Vector3 { return this.body.getMountPoint(out); }

  /** 소유자 쪽에서 와이어에 실을 플래그. */
  ownFlags(): number {
    let fl = 0;
    if (this.localControlled) fl |= DroneFlags.CONTROLLED;
    if (this.body.sprinting) fl |= DroneFlags.SPRINTING;
    if (this.body.airborne) fl |= DroneFlags.AIRBORNE;
    if (this.linkRatio >= 1) fl |= DroneFlags.LINK_LOST;
    if (this.kind === 'ground' && this.ctx.time < this.noiseUntil) fl |= DroneFlags.NOISY;
    return fl;
  }
}
