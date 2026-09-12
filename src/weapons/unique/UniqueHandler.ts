import * as THREE from 'three';
import type {
  GameContext, WeaponDef, EffectiveWeaponStats, ItemInstance, PlayerRef, PlayerWeaponHost, EnemyRef, UniqueWeaponKind,
} from '@/shared';
import type { WeaponModel } from '../WeaponModel';
import type { WeaponFx } from '../fx/WeaponFx';
import type { ProjectilePool, ProjectileHit } from '../Projectile';
import type { UniqueFx } from './UniqueFx';

export type Host = PlayerRef & PlayerWeaponHost;

/** The slot entry a handler works on (structurally the WeaponSystem's `WeaponInstance`). */
export interface UniqueWeapon {
  uid: string;
  def: WeaponDef;
  stats: EffectiveWeaponStats;
  inst: ItemInstance;
  model: WeaponModel;
}

/** Per-frame trigger state handed to a handler. `null` when input is not free (menu, wheel, reload, swap …). */
export interface UniqueInput {
  fireDown: boolean; firePressed: boolean; fireReleased: boolean;
  altDown: boolean; altPressed: boolean; altReleased: boolean;
  meleeDown: boolean; meleePressed: boolean; meleeReleased: boolean;
}

/** Pose hints the handler wants `host.setWeaponState` to carry this frame. */
export interface UniquePose { charging: boolean; spraying: boolean; heavy: boolean; firing: boolean }

/** Result of a `hitscan` call. `end` = where the tracer ended. */
export interface UniqueShot { hit: boolean; enemy: boolean; killed: boolean; end: THREE.Vector3 }

/**
 * What the WeaponSystem lends a unique handler: ammo / durability accounting on the shared item instance,
 * the muzzle / aim ray, the standard hitscan + `fire()` paths, event / net announcements and small UI helpers.
 * Everything a handler touches outside its own state goes through here so the system stays the single owner of
 * the slot bookkeeping.
 */
export interface UniqueServices {
  readonly ctx: GameContext;
  readonly fx: WeaponFx;
  readonly ufx: UniqueFx;
  readonly projectiles: ProjectilePool;
  host(): Host | null;
  mag(w: UniqueWeapon): number;
  reserve(w: UniqueWeapon): number;
  /**
   * Continuous drain for one frame: `def.ammoPerSec × dt` fuel / cells (fractional, persisted per whole unit)
   * and one durability per second of fire. Returns false — nothing consumed — when the magazine is empty.
   */
  drain(w: UniqueWeapon, dt: number): boolean;
  /** Per-shot spend: `rounds` from the mag and one durability. Returns false (nothing consumed) when short. */
  spend(w: UniqueWeapon, rounds: number): boolean;
  /** Durability 0 → click / `weapon:broken` / throttled toast (once per trigger press). True when broken. */
  brokenCheck(w: UniqueWeapon): boolean;
  /** Empty magazine on a trigger press: click, `weapon:dryFire`, reload attempt (once per press). */
  dryFire(w: UniqueWeapon): void;
  tryReload(w: UniqueWeapon): void;
  /** World-space muzzle of the model in hand (matrices refreshed). */
  muzzle(w: UniqueWeapon, out: THREE.Vector3): THREE.Vector3;
  /** Camera aim ray (reticle). */
  aimRay(origin: THREE.Vector3, dir: THREE.Vector3): void;
  /**
   * The point the reticle is on (nearest enemy / world hit along the crosshair line up to `range`, starting at the
   * muzzle's depth), else the far point.
   */
  aimTarget(range: number, out: THREE.Vector3): void;
  /**
   * 2026-09-12 (하이브리드 판정, `parts/AimLine`): where a projectile of the weapon in hand leaves and which way it
   * flies — on the crosshair line from the muzzle's depth, or from the muzzle toward what blocks the barrel in its
   * first `WEAPON_MUZZLE_BLOCK_RANGE` m. Projectile uniques launch with exactly this (muzzle flash stays on `muzzle`).
   */
  aimShot(w: UniqueWeapon, range: number, origin: THREE.Vector3, dir: THREE.Vector3): void;
  /**
   * One standard hitscan shot: crosshair ray + `spread`, judged by the hybrid resolver like `fire()`, tracer from the
   * muzzle, impact FX, `applyHit` (damage × falloff of the def, armour / interception rules), hitmarker. No ammo, no recoil, no net.
   */
  hitscan(w: UniqueWeapon, spread: number, damage: number, range: number, tracerWidth: number, out: UniqueShot): void;
  /** The whole regular `fire()` path (ammo, durability, stance spread, recoil, FX, `weapon:fired`, net). */
  fireStandard(w: UniqueWeapon): void;
  /** `weapon:fired` + multiplayer `fire {m, c}`. `c` = charge / spin 0..1 (continuous beams send at ≤ 10 Hz). */
  announceFire(w: UniqueWeapon, origin: THREE.Vector3, dir: THREE.Vector3, m: 0 | 1, c: number): void;
  /** Multiplayer only: a continuous beam stopped (`fire {m, c: -1}`). */
  announceBeamEnd(w: UniqueWeapon, m: 0 | 1): void;
  recoil(pitch: number, yaw: number): void;
  setCooldown(seconds: number): void;
  cooldown(): number;
  deny(): void;
  notify(text: string): void;
  /** The normal F swing through the player gate + `MeleeController`. */
  lightMelee(): boolean;
  /** No terrain / obstacle / shield between the two points. */
  lineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean;
  /** Re-announce the magazine to the HUD (continuous weapons after a whole unit was spent). */
  emitAmmo(w: UniqueWeapon): void;
}

export interface UniqueHandler {
  readonly kind: UniqueWeaponKind;
  /** true → the handler reads the melee key itself (shuriken slash); the generic F swing is skipped. */
  readonly handlesMelee: boolean;
  /** true → the weapon aims like a normal gun (bow). Every `altFire` unique returns false (RMB = alt fire, zoom 1). */
  readonly allowsAim: boolean;
  readonly pose: UniquePose;
  onEquip(w: UniqueWeapon): void;
  onUnequip(w: UniqueWeapon): void;
  /** Every frame while the weapon is the active slot. `input` is null whenever the trigger must be treated as released. */
  update(dt: number, w: UniqueWeapon, input: UniqueInput | null): void;
  /** A projectile fired by this weapon landed (bazooka rockets). */
  onProjectileHit?(h: ProjectileHit, damage: number, w: UniqueWeapon): void;
  /** Mission reset / abort / holster: stop everything, clear per-enemy state. */
  reset(): void;
  dispose(): void;
}

/* ─────────────────────────── shared helpers ─────────────────────────── */
const _to = new THREE.Vector3(), _c = new THREE.Vector3();

/** Aim-relative target height (enemy centre), as the melee code does. */
export function enemyCentre(e: EnemyRef, out: THREE.Vector3): THREE.Vector3 {
  out.copy(e.position);
  out.y += Math.min(e.height * 0.5, 1.4);
  return out;
}

/**
 * Alive enemies inside the cone (`origin`, `dir`, `halfAngle`, `range`) with line of sight, nearest first,
 * at most `max`. Angle tolerance grows with the target's radius so a big bug at the edge still counts.
 * Writes into `out` (cleared first) and returns the count. Allocation-free.
 */
export function coneTargets(s: UniqueServices, origin: THREE.Vector3, dir: THREE.Vector3, range: number, halfAngle: number, max: number, out: EnemyRef[]): number {
  out.length = 0;
  const mgr = s.ctx.enemies;
  if (!mgr || typeof mgr.queryNear !== 'function') return 0;
  const near = mgr.queryNear(origin, range + 1.5);
  for (let i = 0; i < near.length; i++) {
    const e = near[i];
    if (!e || e.isDead) continue;
    enemyCentre(e, _c);
    _to.subVectors(_c, origin);
    const dist = _to.length();
    if (dist > range + e.radius || dist < 1e-4) continue;
    _to.divideScalar(dist);
    const tol = Math.atan2(e.radius, dist);
    if (Math.acos(THREE.MathUtils.clamp(_to.dot(dir), -1, 1)) > halfAngle + tol) continue;
    if (!s.lineOfSight(origin, _c)) continue;
    // insertion by distance (lists are tiny)
    let k = out.length;
    out.push(e);
    while (k > 0 && out[k - 1].position.distanceToSquared(origin) > dist * dist) { out[k] = out[k - 1]; k--; }
    out[k] = e;
    if (out.length > max) out.length = max;
  }
  return out.length;
}
