import type * as THREE from 'three';
import type { PeerId, Vec3Tuple } from './net';
import type { GadgetId } from './gadgets';

/* ────────────────────────────────────────────────────────────────────────────
 * 드론 (2026-09-11). Owner: `gadgets/drones/DroneSystem` publishes `ctx.drones`.
 *
 * 드론은 가젯 아이템(`droneGround` / `droneAir`)으로 꺼내지만 **배치물(`DeployableRef`)이 아니다** — 배치물은
 * 호스트 권한이고, 드론은 조종하는 손이 곧 권위여야 입력 지연이 없다. 그래서 규칙이 반대다:
 *
 *  - **소유자 권한.** 위치 · 체력 · 조종 여부는 소유자 클라이언트가 시뮬레이션하고 `drone state` 로 방송한다.
 *    남(호스트 포함)은 복제본을 보간해 그린다. 호스트의 적이 드론을 때리면 `droneq damage` 가 소유자에게 간다.
 *  - **아이템은 소모되지 않는다.** 꺼내도 퀵슬롯의 드론 아이템은 그대로 남아 **조종기** 노릇을 한다
 *    (손에 들고 `R` 꾹 = 조종). 드론이 **파괴되면** 그때 소유자 가방에서 그 아이템 하나가 사라진다.
 *    E 홀드로 회수하면 아무것도 사라지지 않는다.
 *  - **종류당 하나.** 한 플레이어는 지상 드론 하나 · 공중 드론 하나까지 동시에 둔다.
 *  - **조종 중 PC 는 앉은 채로 멈춰 있다** (`PlayerRef.setDroneControl`). PC 가 피해를 입으면 조종이 끊긴다
 *    (`releaseControl('damage')`). 사거리를 넘어가도 끊긴다(`'range'`) — 드론은 그 자리에 남고
 *    (공중 드론은 제자리 비행), PC 가 다시 범위 안으로 들어오면 `R` 꾹으로 다시 붙는다.
 * ──────────────────────────────────────────────────────────────────────────── */

export type DroneKind = 'ground' | 'air';

export const DRONE_KINDS: readonly DroneKind[] = ['ground', 'air'];

/** 드론 종류 ↔ 그것을 꺼내는 가젯. */
export const DRONE_GADGET_OF: Readonly<Record<DroneKind, GadgetId>> = { ground: 'droneGround', air: 'droneAir' };

export function droneKindOfGadget(id: GadgetId | null | undefined): DroneKind | null {
  if (id === 'droneGround') return 'ground';
  if (id === 'droneAir') return 'air';
  return null;
}

/** 조종이 끝난 이유 — HUD 문구 · 오디오가 갈린다. */
export type DroneReleaseReason = 'manual' | 'damage' | 'range' | 'destroyed' | 'reset';

export interface DroneRef {
  /** `${peerId | 'sp'}-d${n}` — 소유자가 만든다. */
  readonly id: string;
  readonly kind: DroneKind;
  readonly owner: PeerId | 'local';
  /** 지상 드론 = 바퀴가 닿는 바닥점, 공중 드론 = 몸체 중심. */
  readonly position: THREE.Vector3;
  readonly yaw: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly radius: number;
  readonly height: number;
  readonly object: THREE.Object3D;
  /** 지금 누군가(= 소유자)가 이 드론의 시점으로 보고 있다. */
  readonly controlled: boolean;
  /** 지상 드론이 질주 중이다 (소리 · 어그로). */
  readonly sprinting: boolean;
  /**
   * 적이 지금 이 드론을 알아채고 공격해도 되는가. 지상 드론 = 최근 `DRONE_NOISE_MEMORY_S` 안에 질주했다
   * (걷는 지상 드론은 **무시된다** — 소리도 어그로도 없다), 공중 드론 = 늘 true.
   */
  readonly aggroable: boolean;
  /** 소유자 PC 와의 거리 ÷ 사거리 (0 = 붙어 있음, ≥ 1 = 연결 끊김). */
  readonly linkRatio: number;
  /** 소유자 PC 가 사거리 밖이라 조종할 수 없다. */
  readonly linkLost: boolean;
  /** 이 드론 위에 올라탄 소형 설치물(지뢰 · 원격 지뢰)의 id, 없으면 null. gadgets 가 설정한다. */
  readonly mountedDeployableId: string | null;
  /** 소형 설치물이 올라앉는 윗면 중심 (월드 좌표, 드론을 따라 움직인다). */
  getMountPoint(out: THREE.Vector3): THREE.Vector3;
}

export interface DroneRayHit {
  drone: DroneRef;
  point: THREE.Vector3;
  distance: number;
}

export interface DronesRef {
  getDrones(): readonly DroneRef[];
  getDrone(id: string): DroneRef | null;
  /** 로컬 플레이어가 둔 `kind` 드론, 없으면 null. */
  getOwnDrone(kind: DroneKind): DroneRef | null;
  /** 로컬 플레이어가 지금 시점을 빌려 쓰는 드론, 없으면 null. */
  readonly controlled: DroneRef | null;
  /** 조종을 잡는 `R` 홀드 진행도 0..1 (누르고 있지 않으면 0). HUD 의 홀드 링이 읽는다. */
  readonly controlHold: number;

  /**
   * 드론을 꺼낸다 (`gadgets.use('droneGround' | 'droneAir')` 가 여기로 넘긴다). **인벤토리를 건드리지 않는다.**
   * 이미 그 종류를 꺼내 뒀거나 놓을 자리가 없으면 거부 토스트와 함께 false.
   */
  deploy(kind: DroneKind): boolean;
  /** 조종을 끝내고 PC 시점으로 돌아간다. 조종 중이 아니면 아무것도 안 한다. */
  releaseControl(reason: DroneReleaseReason): void;
  /** 드론 몸체와의 광선 교차 (갈고리 · 설치 미리보기). `kind` 로 거를 수 있다. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, kind?: DroneKind): DroneRayHit | null;
  /** 적 공격 · 폭발이 드론에 준 피해. 소유자가 아니면 `droneq damage` 로 소유자에게 넘긴다. */
  damageDrone(id: string, amount: number, from?: THREE.Vector3): void;
  /** 반경 안의 모든 드론에 선형 감쇠 피해 (지뢰 · 원격 지뢰 · 수류탄). */
  applyExplosion(center: THREE.Vector3, radius: number, damage: number): void;
  clear(): void;
}

/* ── wire (owner: gadgets/drones) ─────────────────────────────────────────── */

/** `DroneWire.fl` / `drone state.fl` 비트. */
export const DroneFlags = {
  CONTROLLED: 1,
  SPRINTING: 2,
  AIRBORNE: 4,
  /** 소유자 사거리 밖. */
  LINK_LOST: 8,
  /** 최근 질주 소음 (`aggroable`). */
  NOISY: 16,
} as const;

export interface DroneWire {
  id: string;
  kind: DroneKind;
  owner: PeerId;
  p: Vec3Tuple;
  yaw: number;
  hp: number;
  maxHp: number;
  fl: number;
}

/** Owner → others. `state` 는 `DRONE_NET_HZ` 로 흐른다. 늦게 합류한 피어에게는 각 소유자가 `sync` 로 답한다. */
export type DroneMessage =
  | { t: 'drone'; ev: 'spawn'; d: DroneWire }
  | { t: 'drone'; ev: 'state'; id: string; p: Vec3Tuple; yaw: number; hp: number; fl: number }
  | { t: 'drone'; ev: 'remove'; id: string; reason: 'destroyed' | 'recovered' | 'expired' }
  | { t: 'drone'; ev: 'sync'; items: DroneWire[] };

/** Any → drone owner (`damage`) / any → others (`sync` = 내 드론 목록을 보내 달라). */
export type DroneRequest =
  | { t: 'droneq'; ev: 'damage'; id: string; dmg: number }
  | { t: 'droneq'; ev: 'sync' };
