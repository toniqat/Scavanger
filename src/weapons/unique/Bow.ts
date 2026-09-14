import * as THREE from 'three';
import {
  BOW_DAMAGE, BOW_DRAW_TIME, BOW_FIRE_RATE, BOW_FULL_GRAVITY, BOW_PROJECTILE_SPEED, BOW_TAP_GRAVITY, BOW_TAP_POWER, BOW_TAP_SPEED,
} from '@/shared';
import type { ProjectileOptions } from '../Projectile';
import type { UniqueHandler, UniqueInput, UniquePose, UniqueServices, UniqueWeapon } from './UniqueHandler';

/** Flight of one arrow for a draw 0..1: launch speed (m/s), drop (m/s²) and the damage fraction of `BOW_DAMAGE`. */
export interface BowBallistics { speed: number; gravity: number; power: number }

/**
 * 2026-09-14 활 시위 — **the one mapping** from draw (0 = tap … 1 = full draw) to the arrow's flight. The shooter
 * (`Bow.release`) and every remote replica (`RemoteWeapons.onFireMessage`, draw = `fire.c`) call this, so a replica
 * arrow flies with exactly the speed and drop the shooter's had. Linear between the tap row (`BOW_TAP_SPEED` /
 * `BOW_TAP_GRAVITY` / `BOW_TAP_POWER`) and the full-draw row (`BOW_PROJECTILE_SPEED` / `BOW_FULL_GRAVITY` / 1).
 */
export function bowBallistics(draw: number, out: BowBallistics): BowBallistics {
  const t = !Number.isFinite(draw) || draw < 0 ? 0 : draw > 1 ? 1 : draw;
  out.speed = BOW_TAP_SPEED + (BOW_PROJECTILE_SPEED - BOW_TAP_SPEED) * t;
  out.gravity = Math.max(0, BOW_TAP_GRAVITY + (BOW_FULL_GRAVITY - BOW_TAP_GRAVITY) * t);
  out.power = BOW_TAP_POWER + (1 - BOW_TAP_POWER) * t;
  return out;
}

const _muzzle = new THREE.Vector3(), _launch = new THREE.Vector3(), _d = new THREE.Vector3(), _visOff = new THREE.Vector3();
const _bal: BowBallistics = { speed: 0, gravity: 0, power: 1 };
/** Launch options (the pool copies every field at launch). */
const _opts: ProjectileOptions = { style: 'arrow', gravity: 0 };

/**
 * 「롱혼」 컴포짓 보우 (2026-09-14 활 시위, 사용자 결정). **LMB hold draws, release shoots**: the draw fills over
 * `def.chargeTime` (`BOW_DRAW_TIME`) and `bowBallistics(draw)` turns it into speed / drop / damage — a tap is a weak,
 * slow, dropping arrow that can follow the last one after `1 / fireRate` s; a full draw flies nearly straight to the
 * crosshair (launched on the hybrid shot line, `aimShot`, no drop compensation). **RMB cancels** the draw (no arrow, no
 * ammo) — the bow no longer aims (`allowsAim` false → RMB never enters ADS, zoom 1).
 * While drawing: `weapon:chargeChanged {kind:'draw', t}` every frame (t = 0 on the press), `pose.charging`,
 * `WeaponModel.setBowDraw(t)`; `t: -1` on release / cancel / input loss / unequip / reset. One arrow + one durability
 * per release (`spend`), a dry press starts a reload (`dryFire`). The arrow is our own `ProjectilePool` launch (style
 * `arrow`, falloff from the effective stats → `Firing.onProjectileHit` → `applyHit`); `announceFire(…, c = draw)` lets
 * replicas rebuild the same flight.
 */
export class Bow implements UniqueHandler {
  readonly kind = 'bow' as const;
  readonly handlesMelee = false;
  readonly allowsAim = false;
  readonly pose: UniquePose = { charging: false, spraying: false, heavy: false, firing: false };

  private drawing = false;
  /** Seconds held since the draw started. */
  private held = 0;
  /** A fresh LMB press is needed before the next draw (after a cancel / dry press / input loss). */
  private needPress = false;
  private cur: UniqueWeapon | null = null;

  constructor(private readonly s: UniqueServices) {}

  onEquip(): void { this.needPress = true; }
  onUnequip(w: UniqueWeapon): void { this.cancelDraw(w); }

  update(dt: number, w: UniqueWeapon, input: UniqueInput | null): void {
    const s = this.s;
    this.cur = w;
    const p = this.pose;
    p.firing = false;
    if (!input || !s.host()) {
      this.cancelDraw(w);
      this.needPress = true;
      p.charging = false;
      return;
    }
    if (this.needPress && (!input.fireDown || input.firePressed)) this.needPress = false;

    if (this.drawing) {
      if (input.altPressed) {
        this.cancelDraw(w);
        this.needPress = true;
        s.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.3, pitch: 0.6 });
      } else {
        this.held += dt;
        if (input.fireDown) this.emitDraw(w);
        else this.release(w);
      }
    } else if (!this.needPress && (input.fireDown || input.firePressed) && s.cooldown() <= 0) {
      if (s.brokenCheck(w)) this.needPress = true;
      else if (s.mag(w) <= 0) { s.dryFire(w); this.needPress = true; }
      else {
        this.drawing = true; this.held = 0;
        this.emitDraw(w);
        s.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.25, pitch: 0.7 });
        // pressed and released inside one frame: a tap shoots at once
        if (!input.fireDown) this.release(w);
      }
    }
    p.charging = this.drawing;
  }

  private drawOf(w: UniqueWeapon): number {
    const t = this.held / Math.max(0.05, w.def.chargeTime ?? BOW_DRAW_TIME);
    return t > 1 ? 1 : t;
  }

  private emitDraw(w: UniqueWeapon): void {
    const t = this.drawOf(w);
    w.model.setBowDraw(t);
    this.s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'draw', t });
  }

  private release(w: UniqueWeapon): void {
    const s = this.s;
    const t = this.drawOf(w);
    this.drawing = false; this.held = 0;
    w.model.setBowDraw(0);
    s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'draw', t: -1 });
    if (!s.spend(w, 1)) { s.dryFire(w); this.needPress = true; return; }
    const bal = bowBallistics(t, _bal);
    const st = w.stats;
    s.muzzle(w, _muzzle);
    s.aimShot(w, w.def.range, _launch, _d);
    _opts.gravity = bal.gravity;
    _opts.falloffStart = st.falloffStart; _opts.falloffEnd = st.falloffEnd; _opts.falloffMin = st.falloffMin;
    _opts.ammoType = st.ammoType;
    // the arrow is drawn leaving the bow and slides onto the judged line (`fire()` does the same for bullets)
    _opts.visualOffset = _visOff.subVectors(_muzzle, _launch);
    s.projectiles.fire(_launch, _d, bal.speed, (st.damage || BOW_DAMAGE) * bal.power, w.def.range, w.def.tracerColor, w.def.id, false, _opts);
    const k = 0.35 + 0.65 * t;
    w.model.kick(0.5 + 0.7 * t);
    s.recoil(st.recoilV * k, (Math.random() - 0.5) * st.recoilH * k);
    s.setCooldown(1 / Math.max(0.1, st.fireRate || BOW_FIRE_RATE));
    s.announceFire(w, _muzzle, _d, 0, t);
    s.ctx.bus.emit('audio:play', { id: 'melee_swing', position: _muzzle, volume: 0.6 + 0.4 * t, pitch: 1.35 - 0.4 * t });
    this.pose.firing = true;
  }

  private cancelDraw(w: UniqueWeapon): void {
    if (!this.drawing) return;
    this.drawing = false; this.held = 0;
    w.model.setBowDraw(0);
    this.s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'draw', t: -1 });
  }

  reset(): void {
    if (this.cur) this.cancelDraw(this.cur);
    this.drawing = false; this.held = 0;
    this.pose.charging = this.pose.firing = false;
  }

  dispose(): void { this.reset(); }
}
