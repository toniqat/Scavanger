import type * as THREE from 'three';
import type { PeerId } from './net';
import type { ItemInstance } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Special gadget consumables (특수 가젯형 소모아이템).
 * Owner: gadgets/GadgetSystem publishes `ctx.gadgets`; item definitions live in items/.
 * World-persistent gadgets (dome shield, barricade, mine, turret, jump pad, zones) are
 * host-authoritative and replicated with the `gad` / `gadq` messages.
 * ──────────────────────────────────────────────────────────────────────────── */

export type GadgetId =
  | 'cloakVeil'      // 은폐 장막 — cloaks the user and nearby squadmates
  | 'domeShield'     // 돔 실드 — thrown sphere that unfolds into a dome (hp 1000)
  | 'barricade'      // 바리케이드 — big wall placed ahead, recoverable by anyone (3 s)
  | 'lureGrenade'    // 유인 수류탄 — noisy grenade that pulls bug aggro / draws fire
  | 'smokeGrenade'   // 연막탄 — blinds enemies; shooting from inside draws inaccurate return fire
  | 'mine'           // 지뢰 — arms after 3 s, friendly fire, defusable
  | 'turret'         // 포탑 — auto turret, friendly fire, recoverable
  | 'incendiary'     // 화염수류탄 — 10 s fire zone, friendly fire
  | 'defib'          // 제세동기 — instantly revives a downed squadmate at full hp
  | 'jumpPad'        // 점프대 — launches whoever steps on it, recoverable
  /* appended (2026-09-11) */
  | 'remoteMine'     // 원격 지뢰 — C4. 설치 후 손에 들고 우클릭으로 내 것 전부 기폭
  | 'droneGround'    // 지상 드론 — `ctx.drones` (shared/drones.ts). 아이템은 조종기로 남는다
  | 'droneAir';      // 공중 드론 — 같은 규칙, 제자리 비행

export const GADGET_IDS: readonly GadgetId[] = [
  'cloakVeil', 'domeShield', 'barricade', 'lureGrenade', 'smokeGrenade',
  'mine', 'turret', 'incendiary', 'defib', 'jumpPad',
  /* appended (2026-09-11) */
  'remoteMine', 'droneGround', 'droneAir',
];

/** How the gadget leaves the hand. */
export type GadgetUseKind =
  | 'throw'      // arc throw like a grenade (over/under toggle)
  | 'place'      // placed on the ground in front of the player
  | 'self'       // instant, affects the user / nearby allies
  | 'target'     // aimed at another player (defibrillator)
  /* appended (2026-09-11) */
  | 'drone';     // `ctx.drones.deploy(kind)` — the item is NOT consumed (it stays as the controller)

/** Things that persist in the world after use. */
export type DeployableKind =
  | 'domeShield' | 'barricade' | 'mine' | 'turret' | 'jumpPad'
  | 'smoke'      // smoke cloud (vision blocker)
  | 'fire'       // burning ground (damage over time)
  | 'lure'       // noise beacon
  /* appended (2026-09-11) */
  | 'remoteMine'; // 원격 지뢰 (C4) — detonated by its owner

/**
 * 2026-09-11 (설치 미리보기): **대형 설치물**은 적당히 평평하고 공간이 있는 바닥에만 선다 — 드론 위에 못 올린다.
 * 나머지 `place` 설치물(지뢰 · 원격 지뢰)은 **소형**이라 경사가 좀 있어도 되고 드론 윗면에 올릴 수 있다.
 */
export const LARGE_DEPLOYABLE_KINDS: readonly DeployableKind[] = ['barricade', 'jumpPad', 'turret'];
/** 드론 윗면(`DroneRef.getMountPoint`)에 올릴 수 있는 설치물. 드론 하나에 하나. */
export const MOUNTABLE_DEPLOYABLE_KINDS: readonly DeployableKind[] = ['mine', 'remoteMine'];
export function isLargeDeployable(kind: DeployableKind | null | undefined): boolean {
  return kind != null && LARGE_DEPLOYABLE_KINDS.includes(kind);
}
export function isMountableDeployable(kind: DeployableKind | null | undefined): boolean {
  return kind != null && MOUNTABLE_DEPLOYABLE_KINDS.includes(kind);
}

/**
 * 2026-09-11: 손에 든 `place` 가젯의 설치 미리보기 (owner: gadgets). 좌클릭이 실제로 놓는 자리와 **같은** 판정이다 —
 * 미리보기가 초록이면 설치되고, 빨강이면 `reason` 으로 거부된다.
 */
export interface PlacementPreview {
  gadget: GadgetId;
  kind: DeployableKind;
  valid: boolean;
  /** 거부 사유 (한국어 한 줄), valid 면 null. */
  reason: string | null;
  position: THREE.Vector3;
  yaw: number;
  /** 드론 위에 올리는 중이면 그 드론 id. */
  mount: string | null;
}

export interface GadgetDef {
  id: GadgetId;
  name: string;
  description: string;
  use: GadgetUseKind;
  /** Deployable spawned on use, or null for pure effects (cloak veil, defib). */
  deployable: DeployableKind | null;
  /** Seconds the effect / deployable lives (0 = until destroyed or recovered). */
  duration: number;
  /** Deployable hit points (0 = indestructible / not damageable). */
  hp: number;
  /** Effect radius in meters (blast, cloud, cloak share, jump pad trigger …). */
  radius: number;
  /** Seconds of hold-to-interact needed to recover / defuse it (0 = not recoverable). */
  recoverTime: number;
  icon: string;
  color: string;
}

export interface DeployableRef {
  readonly id: string;
  readonly kind: DeployableKind;
  /** Peer that placed it; 'local' in single-player. */
  readonly owner: PeerId | 'local';
  readonly position: THREE.Vector3;
  readonly yaw: number;
  readonly radius: number;
  readonly hp: number;
  readonly maxHp: number;
  /** false while a mine is still arming (3 s) / a shield is unfolding. */
  readonly armed: boolean;
  /** ctx.time when it expires, or 0 for "no expiry". */
  readonly expires: number;
  readonly object: THREE.Object3D;
  /** Enemies (and friendly fire) chew through deployables with this. */
  takeDamage(amount: number, from?: THREE.Vector3): void;
}

export interface GadgetsRef {
  getDefs(): readonly GadgetDef[];
  getDef(id: GadgetId): GadgetDef | undefined;
  getDeployables(): readonly DeployableRef[];

  /**
   * Use one gadget from the bag (quick-use bar or inventory). Consumes the item through `ctx.inventory`
   * and, for host-authoritative deployables, sends a `gadq` request. false when the item is missing
   * or placement failed.
   */
  use(id: GadgetId, underhand?: boolean): boolean;

  /** Enemy AI: nearest deployable an enemy should shoot / chew (barricade, turret, lure beacon), or null. */
  findEnemyTarget(pos: THREE.Vector3, radius: number): DeployableRef | null;
  /** Enemy AI: strongest active distraction (lure grenade) within `radius`, or null. */
  findDistraction(pos: THREE.Vector3, radius: number): DeployableRef | null;
  /**
   * Segment test against solid deployables (dome shield, barricade).
   * `fromEnemy` = the projectile was fired by an enemy. Returns the blocked point or null.
   */
  blocksProjectile(from: THREE.Vector3, to: THREE.Vector3, fromEnemy: boolean): THREE.Vector3 | null;
  /** 0 = fully obscured by smoke, 1 = clear. Enemy perception multiplies its detection range by this. */
  visionFactor(from: THREE.Vector3, to: THREE.Vector3): number;
  /** Damage-per-second a position takes from fire zones (0 when not standing in one). */
  fireDamageAt(pos: THREE.Vector3): number;
  /** Jump pad under `pos` that should launch a mover, or null. */
  jumpPadAt(pos: THREE.Vector3): DeployableRef | null;
  /** Item returned when a deployable is recovered (barricade / turret / jump pad), or null. */
  recover(id: string): ItemInstance | null;

  clear(): void;
}

/* ── appended (2026-09-11): 설치 미리보기 · 원격 지뢰 · 드론 탑재 (owner: gadgets) ── */
export interface DeployableRef {
  /** 드론 위에 올라탄 설치물이면 그 드론 id (`DroneRef.id`) — 위치가 매 프레임 드론을 따라간다. */
  readonly mount?: string | null;
}

export interface GadgetsRef {
  /** 손에 든 `place` 가젯의 현재 설치 미리보기, 들고 있지 않으면 null. */
  readonly placement?: PlacementPreview | null;
  /**
   * 로컬 플레이어가 설치한 원격 지뢰를 **전부** 기폭한다 (무장된 것만). 비호스트는 `gadq detonate` 요청을 보낸다.
   * 같은 기폭에서 한 대상이 여러 발에 맞으면 가장 센 한 발만 온전히, 나머지는 `GADGET_REMOTE_MINE_STACK_MUL` 배.
   * 반환 = 기폭(요청)한 개수.
   */
  detonateRemoteMines?(): number;
  /** 로컬 플레이어 소유로 월드에 남아 있는 원격 지뢰 수 (기폭기 손 상태 · HUD). */
  liveRemoteMineCount?(): number;
}
