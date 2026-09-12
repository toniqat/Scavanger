import type * as THREE from 'three';
import type { PeerId, Vec3Tuple } from './net';
import type { GadgetId } from './gadgets';
import type { Rarity } from './types';

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

/* ══ appended (2026-09-12): 지상 드론 스캔 — docs/plans/consumables-keys-favorites.md §4 ══════════════════════════
 * 지상 드론 조종 중 렌즈 중심 광선을 상자 · 컨테이너 · 시체 · 보급 상자에 맞추고 좌클릭을 `DRONE_SCAN_HOLD_S` 누르고
 * 있으면 그 안의 **최고 등급**이 대상 위 월드 라벨로 레이드 내내 남는다 (분대 공유 + 채팅 한 줄). 공중 드론은 못 한다.
 * 미리보기는 **여는 것과 같은 굴림**이다 (`InventoryRef.peekContainerItems` · `peekSuppliedItems` ·
 * `WorldRef.previewContainerItems`) — 스캔은 아무것도 열거나 굴려 두거나 옮기지 않는다. 소리 · 소음 · 어그로도 없다. */

/** 스캔할 수 있는 대상 종류 — `Interactable.id` 접두어로 가른다. */
export type DroneScanTargetKind = 'crate' | 'container' | 'corpse' | 'playerCorpse' | 'supply';

/**
 * 상호작용 id → 스캔 대상 종류, 스캔할 수 없으면 null. 맵 상자 `crate_<n>` · 구조물/플랫폼/전차 컨테이너 `container:<spec>` ·
 * 적 시체 `corpse:<enemyId>` · 분대원 시체 `pcorpse:<owner>:<n>` · 보급 상자 `supply:<callId>`.
 */
export function droneScanKindOf(id: string): DroneScanTargetKind | null {
  if (typeof id !== 'string') return null;
  if (id.startsWith('crate_')) return 'crate';
  if (id.startsWith('container:')) return 'container';
  if (id.startsWith('corpse:')) return 'corpse';
  if (id.startsWith('pcorpse:')) return 'playerCorpse';
  if (id.startsWith('supply:')) return 'supply';
  return null;
}

/** 채팅 · 안내 · 라벨에 쓰는 대상 이름. */
export const DRONE_SCAN_TARGET_NAME: Readonly<Record<DroneScanTargetKind, string>> = {
  crate: '상자', container: '컨테이너', corpse: '시체', playerCorpse: '유해', supply: '보급 상자',
};

/** 지금 드론 조준선에 걸린 스캔 대상 (HUD 안내). */
export interface DroneScanAim {
  readonly id: string;
  readonly kind: DroneScanTargetKind;
  readonly name: string;
  /** 렌즈 → 대상 중심 3-D 거리(m). */
  readonly distance: number;
  /** `DRONE_SCAN_RANGE` 안이라 지금 누르면 게이지가 찬다. */
  readonly inRange: boolean;
}

/** 레이드에 남는 스캔 결과 하나 (대상마다 최신 한 개 — 다시 스캔하면 갈아 끼운다). */
export interface DroneScanResult {
  readonly id: string;
  readonly kind: DroneScanTargetKind;
  readonly name: string;
  /** 안에 든 것 중 최고 등급, null = 비어 있음. */
  readonly rarity: Rarity | null;
  /** 대상의 살아 있는 자리 (알면 대상 `Interactable.position` 그 벡터 — 전차 위에서도 따라간다). */
  readonly position: THREE.Vector3;
  /** 내가 스캔했다 (false = 분대원). */
  readonly local: boolean;
  readonly byName: string;
  /** `ctx.time` 기준 스캔 시각. */
  readonly at: number;
}

export interface DronesRef {
  /* ── appended (2026-09-12, 드론 스캔) — 옵셔널: 스텁 · 옛 구현은 없어도 된다 ── */
  /** 스캔 홀드 진행도 0..1 (누르고 있지 않거나 조준이 없으면 0). */
  readonly scanHold?: number;
  /** 조종 중인 지상 드론의 조준선에 걸린 스캔 대상 (`DRONE_SCAN_HINT_RANGE` 안), 없으면 null. */
  readonly scanAim?: DroneScanAim | null;
  /** 이번 레이드의 스캔 결과 전부 (내 것 + 분대원). 레이드 리셋(`game:newMission/abort` · `hub:entered` · `world:ready`)에 비워진다. */
  getScanResults?(): readonly DroneScanResult[];
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
  | { t: 'drone'; ev: 'sync'; items: DroneWire[] }
  /**
   * appended (2026-09-12, 드론 스캔): 스캔한 사람 → others. `id` = 대상 `Interactable.id`, `r` = 최고 등급(null = 비어 있음),
   * `p` = 스캔한 순간의 대상 자리. **표시 전용**이라 확정이 없다 — 받는 쪽은 로비 멤버 · 모양 · 보낸 사람의 지상 드론 거리를
   * 보고 라벨만 세운다 (`gadgets/drones/parts/Scan.onRemoteScan`). 늦게 합류한 사람에게는 가지 않는다 (설계안 §7).
   */
  | { t: 'drone'; ev: 'scan'; id: string; r: Rarity | null; p: Vec3Tuple };

/** Any → drone owner (`damage`) / any → others (`sync` = 내 드론 목록을 보내 달라). */
export type DroneRequest =
  | { t: 'droneq'; ev: 'damage'; id: string; dmg: number }
  | { t: 'droneq'; ev: 'sync' };
