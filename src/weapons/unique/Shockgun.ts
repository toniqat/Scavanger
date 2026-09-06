import * as THREE from 'three';
import {
  SHOCK_RANGE, SHOCK_CONE_DEG, SHOCK_MAX_TARGETS, SHOCK_DPS, SHOCK_CHARGE_TIME, SHOCK_CHARGE_DAMAGE, SHOCK_CHARGE_MIN_RATIO,
  SHOCK_CHARGE_RANGE, SHOCK_CHARGE_CELLS, SHOCK_SLOW_FACTOR, SHOCK_SLOW_DURATION,
  type EnemyRef,
} from '@/shared';
import { coneTargets, enemyCentre, type UniqueHandler, type UniqueInput, type UniquePose, type UniqueServices, type UniqueShot, type UniqueWeapon } from './UniqueHandler';

const DEG = Math.PI / 180;
const TICK_RATE = 10;
const NET_INTERVAL = 0.1;

const _muzzle = new THREE.Vector3(), _o = new THREE.Vector3(), _d = new THREE.Vector3(), _c = new THREE.Vector3();

/**
 * 「테슬라 코일」 전격총. LMB = arc to the `SHOCK_MAX_TARGETS` nearest enemies inside the view cone
 * (`SHOCK_RANGE` / `SHOCK_CONE_DEG`): `SHOCK_DPS` in 10 Hz ticks + `applyStatus('shocked', SHOCK_SLOW_FACTOR,
 * SHOCK_SLOW_DURATION)` every tick, cells drain `ammoPerSec × dt`. RMB hold = charge (`weapon:chargeChanged
 * kind:'charge'`), release = hitscan bolt `altDamage × lerp(SHOCK_CHARGE_MIN_RATIO, 1, t)` over `SHOCK_CHARGE_RANGE`
 * for `SHOCK_CHARGE_CELLS`; the cooldown after a bolt equals the charge time.
 */
export class Shockgun implements UniqueHandler {
  readonly kind = 'shockgun' as const;
  readonly handlesMelee = false;
  readonly allowsAim = false;
  readonly pose: UniquePose = { charging: false, spraying: false, heavy: false, firing: false };

  private arcing = false;
  private charging = false;
  private charge = 0;
  private tickT = 0;
  private netT = 0;
  private cur: UniqueWeapon | null = null;
  private readonly targets: EnemyRef[] = [];
  private readonly ends: THREE.Vector3[] = [];
  private readonly shot: UniqueShot = { hit: false, enemy: false, killed: false, end: new THREE.Vector3() };

  constructor(private readonly s: UniqueServices) {
    for (let i = 0; i < SHOCK_MAX_TARGETS; i++) this.ends.push(new THREE.Vector3());
  }

  onEquip(w: UniqueWeapon): void { w.model.setHeat(0); }
  onUnequip(w: UniqueWeapon): void { this.stopArc(w); this.cancelCharge(w); }

  update(dt: number, w: UniqueWeapon, input: UniqueInput | null): void {
    const s = this.s;
    this.cur = w;
    const host = s.host();
    const p = this.pose;

    // ── RMB charge (takes priority over the arc; the arc stops while charging)
    if (this.charging) {
      if (!input || !host) { this.cancelCharge(w); }
      else {
        this.charge = Math.min(1, this.charge + dt / (w.def.chargeTime ?? SHOCK_CHARGE_TIME));
        s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'charge', t: this.charge });
        w.model.setHeat(this.charge);
        if (!input.altDown) this.fireBolt(w);
      }
    } else if (input && host && input.altPressed && s.cooldown() <= 0 && !s.brokenCheck(w)) {
      if (s.mag(w) < SHOCK_CHARGE_CELLS) s.dryFire(w);
      else {
        this.stopArc(w);
        this.charging = true; this.charge = 0;
        s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'charge', t: 0 });
        s.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.35, pitch: 1.4 });
      }
    }
    p.charging = this.charging;
    if (this.charging) { p.spraying = false; p.firing = false; return; }

    // ── LMB arc
    let want = !!input && !!host && input.fireDown;
    if (want && s.brokenCheck(w)) want = false;
    if (want && !s.drain(w, dt)) { s.dryFire(w); want = false; }
    if (want !== this.arcing) {
      if (this.arcing) this.stopArc(w);
      else {
        this.arcing = true; this.tickT = 0; this.netT = 0;
        w.model.setHeat(1);
        s.ctx.bus.emit('weapon:beamChanged', { weaponId: w.def.id, active: true, mode: 'primary' });
      }
    }
    if (!this.arcing || !host) { p.spraying = false; p.firing = false; return; }
    p.spraying = true; p.firing = true;

    const half = SHOCK_CONE_DEG * 0.5 * DEG;
    s.muzzle(w, _muzzle);
    s.aimRay(_o, _d);
    const n = coneTargets(s, _muzzle, _d, SHOCK_RANGE, half, SHOCK_MAX_TARGETS, this.targets);
    for (let i = 0; i < n; i++) enemyCentre(this.targets[i], this.ends[i]);
    if (n > 0) s.ufx.setArc('local', _muzzle, this.ends, n);
    else s.ufx.release('local');
    if (Math.random() < 0.4) s.recoil((Math.random() - 0.5) * 0.002, (Math.random() - 0.5) * 0.002);

    this.tickT += dt;
    if (this.tickT >= 1 / TICK_RATE) {
      const dtTick = this.tickT;
      this.tickT = 0;
      const mgr = s.ctx.enemies;
      const dps = w.stats.damage || SHOCK_DPS;
      const attacker = s.ctx.net?.localId ?? 'local'; // Phase 9: status kills credit the shooter
      let anyKill = false;
      for (let i = 0; i < n; i++) {
        const e = this.targets[i];
        const wasDead = e.isDead;
        enemyCentre(e, _c);
        e.takeDamage(dps * dtTick, _c, _d);
        if (!wasDead && e.isDead) { anyKill = true; continue; }
        if (mgr && typeof mgr.applyStatus === 'function') mgr.applyStatus(e.id, 'shocked', SHOCK_SLOW_FACTOR, SHOCK_SLOW_DURATION, attacker);
      }
      if (n > 0) s.ctx.bus.emit('ui:hitmarker', { kill: anyKill });
    }
    this.netT -= dt;
    if (this.netT <= 0) { this.netT = NET_INTERVAL; s.announceFire(w, _muzzle, _d, 0, 1); }
  }

  private fireBolt(w: UniqueWeapon): void {
    const s = this.s;
    const t = this.charge;
    this.charging = false;
    s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'charge', t: -1 });
    w.model.setHeat(0);
    if (!s.spend(w, SHOCK_CHARGE_CELLS)) { s.dryFire(w); return; }
    const dmg = (w.def.altDamage ?? SHOCK_CHARGE_DAMAGE) * THREE.MathUtils.lerp(SHOCK_CHARGE_MIN_RATIO, 1, t);
    s.hitscan(w, 0, dmg, SHOCK_CHARGE_RANGE, 0.09, this.shot);
    s.muzzle(w, _muzzle);
    _d.subVectors(this.shot.end, _muzzle).normalize();
    s.fx.muzzleFlash(_muzzle, _d, w.def.tracerColor, 1.6);
    w.model.kick(2.2);
    s.recoil(w.stats.recoilV * (2 + t * 2), (Math.random() - 0.5) * w.stats.recoilH);
    s.setCooldown(w.def.chargeTime ?? SHOCK_CHARGE_TIME);
    s.announceFire(w, _muzzle, _d, 1, t);
    s.ctx.bus.emit('weapon:altFired', { weaponId: w.def.id, origin: _muzzle.clone(), direction: _d.clone() });
    s.ctx.bus.emit('audio:play', { id: 'shot_energy', position: _muzzle, volume: 1, pitch: 0.7 + t * 0.2 });
    s.ctx.bus.emit('camera:shake', { intensity: 0.2 + t * 0.2, duration: 0.15 });
    this.pose.firing = true;
  }

  private cancelCharge(w: UniqueWeapon): void {
    if (!this.charging) return;
    this.charging = false; this.charge = 0;
    w.model.setHeat(0);
    this.s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'charge', t: -1 });
  }

  private stopArc(w: UniqueWeapon): void {
    if (!this.arcing) return;
    this.arcing = false;
    w.model.setHeat(0);
    this.s.ufx.release('local');
    this.s.ctx.bus.emit('weapon:beamChanged', { weaponId: w.def.id, active: false, mode: 'primary' });
    this.s.announceBeamEnd(w, 0);
    this.pose.spraying = false; this.pose.firing = false;
  }

  reset(): void {
    if (this.cur) { this.stopArc(this.cur); this.cancelCharge(this.cur); }
    this.arcing = false; this.charging = false; this.charge = 0;
    this.s.ufx.release('local');
    this.pose.charging = this.pose.spraying = this.pose.firing = false;
  }

  dispose(): void { this.reset(); }
}
