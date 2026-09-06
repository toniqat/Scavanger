import { MINIGUN_SPINUP_TIME, MINIGUN_SPINDOWN_TIME, MINIGUN_MOVE_MUL } from '@/shared';
import type { UniqueHandler, UniqueInput, UniquePose, UniqueServices, UniqueWeapon } from './UniqueHandler';

const SPEED_KEY = 'minigun';

/**
 * 「사이클론」 미니건. Holding LMB spins the barrels up over `chargeTime` (`MINIGUN_SPINUP_TIME`,
 * `weapon:chargeChanged kind:'spinup'` every frame the spin changes); once spun the regular `fire()` runs at
 * `MINIGUN_FIRE_RATE` (hitscan, `MINIGUN_SPREAD_DEG`). Releasing spins down over `MINIGUN_SPINDOWN_TIME`. RMB hold =
 * keep the barrels spun without firing (no ammo, still slowed) so LMB then fires instantly. While the barrels move
 * the player carries `setSpeedModifier('minigun', MINIGUN_MOVE_MUL)`.
 */
export class Minigun implements UniqueHandler {
  readonly kind = 'minigun' as const;
  readonly handlesMelee = false;
  readonly allowsAim = false;
  readonly pose: UniquePose = { charging: false, spraying: false, heavy: true, firing: false };

  private spin = 0;
  private slowed = false;
  private cur: UniqueWeapon | null = null;

  constructor(private readonly s: UniqueServices) {}

  onEquip(w: UniqueWeapon): void { this.spin = 0; w.model.setSpin(0); }
  onUnequip(w: UniqueWeapon): void { this.stopNow(w); }

  update(dt: number, w: UniqueWeapon, input: UniqueInput | null): void {
    const s = this.s;
    this.cur = w;
    const host = s.host();
    const p = this.pose;
    p.firing = false;
    const want = !!input && !!host && (input.fireDown || input.altDown);
    const prev = this.spin;
    const up = w.def.chargeTime ?? MINIGUN_SPINUP_TIME;
    if (want) this.spin = Math.min(1, this.spin + dt / Math.max(0.05, up));
    else this.spin = Math.max(0, this.spin - dt / Math.max(0.05, MINIGUN_SPINDOWN_TIME));
    if (this.spin !== prev) {
      w.model.setSpin(this.spin);
      s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'spinup', t: this.spin > 0 ? this.spin : -1 });
      if (prev === 0) s.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.3, pitch: 0.6 });
    }
    this.applySlow(host, this.spin > 0);
    p.charging = this.spin > 0 && this.spin < 1;
    p.spraying = false;
    if (!input || !host) return;
    if (this.spin >= 1 && input.fireDown && s.cooldown() <= 0) {
      if (s.brokenCheck(w)) return;
      if (s.mag(w) <= 0) { s.dryFire(w); return; }
      s.fireStandard(w);
      p.firing = true;
    }
  }

  private applySlow(host: ReturnType<UniqueServices['host']>, on: boolean): void {
    if (on === this.slowed) return;
    this.slowed = on;
    if (host && typeof host.setSpeedModifier === 'function') host.setSpeedModifier(SPEED_KEY, on ? MINIGUN_MOVE_MUL : 1);
  }

  private stopNow(w: UniqueWeapon): void {
    const was = this.spin;
    this.spin = 0;
    w.model.setSpin(0);
    this.applySlow(this.s.host(), false);
    if (was > 0) this.s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'spinup', t: -1 });
    this.pose.charging = this.pose.firing = false;
  }

  reset(): void {
    if (this.cur) this.stopNow(this.cur);
    this.spin = 0;
    this.applySlow(this.s.host(), false);
    this.pose.charging = this.pose.firing = false;
  }

  dispose(): void { this.reset(); }
}
