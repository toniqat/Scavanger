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
  | 'jumpPad';       // 점프대 — launches whoever steps on it, recoverable

export const GADGET_IDS: readonly GadgetId[] = [
  'cloakVeil', 'domeShield', 'barricade', 'lureGrenade', 'smokeGrenade',
  'mine', 'turret', 'incendiary', 'defib', 'jumpPad',
];

/** How the gadget leaves the hand. */
export type GadgetUseKind =
  | 'throw'      // arc throw like a grenade (over/under toggle)
  | 'place'      // placed on the ground in front of the player
  | 'self'       // instant, affects the user / nearby allies
  | 'target';    // aimed at another player (defibrillator)

/** Things that persist in the world after use. */
export type DeployableKind =
  | 'domeShield' | 'barricade' | 'mine' | 'turret' | 'jumpPad'
  | 'smoke'      // smoke cloud (vision blocker)
  | 'fire'       // burning ground (damage over time)
  | 'lure';      // noise beacon

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
