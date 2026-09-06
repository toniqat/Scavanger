import type { UniqueHandler, UniqueInput, UniquePose, UniqueServices, UniqueWeapon } from './UniqueHandler';

/**
 * 「롱혼」 컴포짓 보우. The only unique that aims (ADS with `stats.adsZoom`, no RMB alt fire): LMB (semi) shoots one
 * arrow through the regular `fire()` path, which flies dead straight (`Projectile` style `arrow`, gravity 0 — see
 * `WeaponSystem.projectileOptsFor`). DMR cadence from the def; ammo / durability / recoil / net are the standard ones.
 */
export class Bow implements UniqueHandler {
  readonly kind = 'bow' as const;
  readonly handlesMelee = false;
  readonly allowsAim = true;
  readonly pose: UniquePose = { charging: false, spraying: false, heavy: false, firing: false };

  constructor(private readonly s: UniqueServices) {}

  onEquip(): void { /* standard draw */ }
  onUnequip(): void { /* nothing in flight to stop */ }

  update(_dt: number, w: UniqueWeapon, input: UniqueInput | null): void {
    const s = this.s;
    this.pose.firing = false;
    if (!input || !s.host()) return;
    if (!input.firePressed || s.cooldown() > 0) return;
    if (s.brokenCheck(w)) return;
    if (s.mag(w) <= 0) { s.dryFire(w); return; }
    s.fireStandard(w);
    this.pose.firing = true;
  }

  reset(): void { this.pose.firing = false; }
  dispose(): void { /* nothing owned */ }
}
