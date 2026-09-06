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
