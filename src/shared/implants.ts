import type * as THREE from 'three';
import type { PeerId } from './net';

/* ────────────────────────────────────────────────────────────────────────────
 * Tactical implants (전술 임플란트). Owner: implants/ImplantSystem publishes `ctx.implants`.
 * Everyone owns all six from the start; exactly one may be equipped, and only in the ship
 * (`setEquipped` refuses while a mission is running). Q activates it in game.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ImplantId = 'grapple' | 'dash' | 'barrier' | 'overcharge' | 'scan' | 'atlauncher';

export const IMPLANT_IDS: readonly ImplantId[] = ['grapple', 'dash', 'barrier', 'overcharge', 'scan', 'atlauncher'];

/**
 * 'instant'  → Q fires the effect immediately (grapple, dash, barrier toggle).
 * 'hold'     → the effect runs while Q is held (scan pulses, overcharge channel); the gun stays in hand.
 * 'wielded'  → Q takes the device into the hands (weapon holstered); LMB / RMB drive it, Q or a weapon key puts it away.
 */
export type ImplantMode = 'instant' | 'wielded' | 'hold';

export interface ImplantDef {
  id: ImplantId;
  name: string;
  description: string;
  mode: ImplantMode;
  /** Seconds before the implant may be used again (per charge for charge-based implants). */
  cooldown: number;
  /** Charges held at once (dash = 3). 1 for everything else. */
  charges: number;
  /** Short glyph for the HUD. */
  icon: string;
  /** CSS colour for HUD / world FX. */
  color: string;
}

/** One thing revealed by the 정찰 scan pulse. */
export interface ScanTarget {
  kind: 'enemy' | 'crate' | 'pickup' | 'gather' | 'objective' | 'deployable';
  /** Enemy id / crate id / pickup id … as a string. */
  id: string;
  position: THREE.Vector3;
  /** Object to outline through walls, when the owner could supply one. */
  object?: THREE.Object3D;
  label?: string;
}

export interface ImplantsRef {
  /** Implant chosen on the ship. null = none equipped. */
  readonly equipped: ImplantId | null;
  /** true while a 'wielded' implant is in the hands (weapons are holstered). */
  readonly wielded: boolean;
  /** Weapons must not fire while this is true. */
  readonly blocksWeapons: boolean;
  /** Seconds left on the cooldown of the next charge (0 = ready). */
  readonly cooldownRemaining: number;
  readonly cooldownTotal: number;
  readonly charges: number;
  readonly maxCharges: number;
  /** Barrier implant only: current / max shield hit points (0 / 0 otherwise). */
  readonly barrierHp: number;
  readonly barrierMaxHp: number;
  /** true while the barrier is deployed. */
  readonly barrierActive: boolean;
  /* ── appended (implant rework 2026-09-06) ── */
  /** true while a 'hold' implant is channelling (Q held). */
  readonly holding: boolean;
  /** Resource of a channelled implant (overcharge energy, seconds); 0 / 0 for the others. */
  readonly energy: number;
  readonly energyMax: number;
  /** Barrier only: seconds left of the post-collapse lockout (0 otherwise). */
  readonly barrierLockout: number;

  getDef(id: ImplantId): ImplantDef | undefined;
  getAllDefs(): readonly ImplantDef[];
  /** Ship only (phase 'hub'). Returns false — and changes nothing — during a mission. */
  setEquipped(id: ImplantId | null): boolean;
  /** Q pressed: cast an instant implant, or toggle a wielded one in/out of the hands. */
  activate(): void;
  /** Force the wielded implant away (weapon swap, death, phase change). */
  stow(): void;

  /**
   * Barrier / dome-shield style blocking for hostile projectiles. Returns the impact point when the
   * segment origin→origin+dir*maxDist is stopped by a shield hostile to the shooter, else null.
   * `fromEnemy` = the projectile came from an enemy (player shields only block those).
   */
  raycastBarrier(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, fromEnemy: boolean): { point: THREE.Vector3; owner: PeerId | 'local' } | null;
  /**
   * appended (Phase 9): `raycastBarrier` is a **pure** query now (safe for per-tick line-of-sight tests). A caller whose
   * projectile / shot really stopped at the barrier calls this once: the local barrier takes `amount` (default the
   * block damage) + `implant:barrierHit`, a peer's barrier only sparks (its owner is authoritative over its hp).
   */
  damageBarrier(owner: PeerId | 'local', point: THREE.Vector3, amount?: number): void;

  reset(): void;
}

/* ══ appended: Phase 10 — 배리어 = 들고 다니는 방패 (2026-09-07) ═══════════════════════════════════════════════
 * The 배리어 def's `mode` becomes `'wielded'`, so Q takes the shield into the hands, the gun is holstered
 * (`blocksWeapons`), and a weapon key or Q again puts it away — exactly the 대전차포 flow. Remote replication comes
 * for free: `RemoteImplants` already builds a hand device for any implant whose `mode === 'wielded'` from
 * `PlayerSnapshot.imp`. `raycastBarrier` / `damageBarrier` keep their signatures — they were always transform-agnostic;
 * only the panel now follows the carrier's position + yaw instead of a fixed world spot, and it blocks a shot only
 * inside `IMPLANT_BARRIER_CARRY_ARC` of the carrier's forward.
 * `barrierHp / barrierMaxHp / barrierLockout` are unchanged; `barrierActive` now means "raised in hand".
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export interface ImplantsRef {
  /** true while the shield is in the hands. Mirrors `wielded` when `equipped === 'barrier'`, false otherwise. */
  readonly barrierCarried: boolean;
  /**
   * Local shield pose for renderers / tests: writes the panel-bottom centre into `outPosition` and returns its facing.
   * null when the shield is down.
   */
  getBarrierPose(outPosition: THREE.Vector3): { yaw: number } | null;
}

/* ══ appended: 2026-09-08 — 배리어 rework (넓은 방패 · 충돌 · 정면 흡수 · 실드 배쉬) · 정찰 rework ═══════════════════
 * 배리어: the carried shield is wider (`IMPLANT_BARRIER_CARRY_WIDTH` raised), and it is now a **physical wall for
 * bugs**: enemies/ resolves their movement against it and cannot walk through, and a bug that bumps it retargets the
 * carrier. A melee attack that reaches the carrier from inside the shield arc is **absorbed by the shield** instead of
 * the player (`absorbFrontalAttack`). LMB or the melee key while the shield is raised = **실드 배쉬** (`bashing`): a
 * melee strike over the shield's own width in front of the carrier, costing `IMPLANT_SHIELD_BASH_STAMINA`, dealing
 * `IMPLANT_SHIELD_BASH_DAMAGE` (no 개머리판 / melee-weapon bonus — only `derived.meleeDamageMul` applies) and knocking
 * enemies back. 정찰: `mode` becomes 'instant' — one press, usable while moving, one wide pulse
 * (`IMPLANT_SCAN_RADIUS`) that reveals every interactable + enemy for `IMPLANT_SCAN_REVEAL_TIME` (15 s) to the caster
 * **and the squad** (`imp scanCast` → each receiver reveals from its own world), on the compass and as red silhouettes
 * through walls (`EnemyManagerRef.setXray`). Owner: implants.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export interface ImplantsRef {
  /**
   * Movement collision for enemies (owner: implants; called by enemies/ per simulated bug per tick). If a raised shield
   * (local or a peer's, from `imp shield` + their snapshot) overlaps the mover at `pos` (radius honoured), `pos` is
   * pushed out to the shield's front face and the carrier is returned so the AI can retarget; null when nothing was
   * touched. Pure apart from writing `pos`.
   */
  resolveBarrierCollision(pos: THREE.Vector3, radius: number): PeerId | 'local' | null;
  /**
   * A melee attack of `amount` from `fromPos` is about to land on `owner` (owner: implants; called by enemies/ on the
   * host **before** applying enemy melee damage). Returns true when the carrier's raised shield faces the attacker
   * (inside `IMPLANT_BARRIER_CARRY_ARC`) and took it instead — for the local owner the shield hp is deducted here;
   * for a peer owner nothing is deducted (the caller sends `ee barrierHit` to that peer, whose own shield takes it).
   */
  absorbFrontalAttack(owner: PeerId | 'local', fromPos: THREE.Vector3, amount: number): boolean;
  /** 실드 배쉬 swing in progress (pose + FX); enemies inside the arc were already hit when this went true. */
  readonly bashing: boolean;
}

/* ══ appended: 2026-09-12 — 안정제 · 준비 연출 (docs/plans/consumables-keys-favorites.md §1 · §2) ═══════════════════════
 * 안정제(consumable, owner: weapons/Healing · A1)가 부른다. 장착 임플란트를 **전부** 채운다: 충전 가득 · 쿨타임 0 · 배리어
 * 붕괴 잠금 해제 + 내구도 가득 · 오버차지 에너지 가득 → `implant:cooldownChanged` · `barrierChanged` · `energyChanged` 를
 * 다시 내고 `implant:ready {refill: true}` 로 준비 연출 · 소리가 난다 (이미 가득이어도 — 아이템을 쓴 피드백). 미장착이면
 * 아무것도 하지 않는다. 날아가는 · 붙은 갈고리, 들고 있는 방패, 오버차지 채널을 끊지 않는다. Owner: implants.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export interface ImplantsRef {
  refillAll?(): void;
}
