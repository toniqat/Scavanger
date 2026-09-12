import * as THREE from 'three';
import {
  SHURIKEN_DAMAGE, SHURIKEN_SPEED, SHURIKEN_TRIPLE_SPREAD_DEG, SHURIKEN_TRIPLE_COOLDOWN,
  SLASH_HOLD_TIME, SLASH_STAMINA_RATIO, SLASH_DAMAGE, SLASH_RANGE, SLASH_ARC_DEG, SLASH_DURATION,
  type EnemyRef, type Vec3Tuple,
} from '@/shared';
import { enemyCentre, type UniqueHandler, type UniqueInput, type UniquePose, type UniqueServices, type UniqueWeapon } from './UniqueHandler';

const DEG = Math.PI / 180;
/** Seconds from the slash starting to the hit being resolved (the blade reaches the front of the arc). */
const SLASH_WINDUP = 0.18;
const SLASH_MAX_TARGETS = 12;
const _up = new THREE.Vector3(0, 1, 0);
const _muzzle = new THREE.Vector3(), _launch = new THREE.Vector3(), _d = new THREE.Vector3(), _fan = new THREE.Vector3();
const _origin = new THREE.Vector3(), _fwd = new THREE.Vector3(), _to = new THREE.Vector3(), _c = new THREE.Vector3(), _swing = new THREE.Vector3();

function toTuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
}

/**
 * 「카게」 표창. LMB = one spinning star (`Projectile` style `shuriken`), RMB = a horizontal fan of three
 * (`±SHURIKEN_TRIPLE_SPREAD_DEG`, `SHURIKEN_TRIPLE_COOLDOWN`). Owns the melee key while equipped: a tap is the normal
 * F swing, a hold of `SLASH_HOLD_TIME` then release is the 용검 big slash — `consumeStamina(maxStamina ×
 * SLASH_STAMINA_RATIO)` (refused with `ui_deny` + a toast), `setViewWiden(true)`, `startMelee('heavy')`, every enemy
 * within `SLASH_RANGE` inside `SLASH_ARC_DEG` takes `SLASH_DAMAGE`, `player:slashed`, `setViewWiden(false)` after
 * `SLASH_DURATION`. `weapon:chargeChanged {kind:'slash'}` while the key is held.
 */
export class Shuriken implements UniqueHandler {
  readonly kind = 'shuriken' as const;
  readonly handlesMelee = true;
  readonly allowsAim = false;
  readonly pose: UniquePose = { charging: false, spraying: false, heavy: false, firing: false };

  private tripleCd = 0;
  private holding = false;
  private holdT = 0;
  /** > 0 while the big slash animation runs; `hitT` counts down to the hit resolution. */
  private slashT = 0;
  private hitT = -1;
  /** `setViewWiden(true)` is outstanding. */
  private widened = false;
  private cur: UniqueWeapon | null = null;
  private readonly targets: EnemyRef[] = [];

  constructor(private readonly s: UniqueServices) {}

  onEquip(): void { /* nothing to prime */ }
  onUnequip(w: UniqueWeapon): void { this.cancelHold(w); this.endSlash(); }

  update(dt: number, w: UniqueWeapon, input: UniqueInput | null): void {
    const s = this.s;
    this.cur = w;
    const host = s.host();
    if (this.tripleCd > 0) this.tripleCd -= dt;
    const p = this.pose;
    p.firing = false;

    // ── big slash in flight
    if (this.slashT > 0) {
      this.slashT -= dt;
      if (this.hitT >= 0) { this.hitT -= dt; if (this.hitT <= 0) { this.hitT = -1; this.resolveSlash(host); } }
      if (this.slashT <= 0) this.endSlash();
    }

    // ── melee key: tap = light swing, hold ≥ SLASH_HOLD_TIME then release = big slash
    if (this.holding) {
      if (!input || !host) this.cancelHold(w);
      else if (input.meleeDown) {
        this.holdT += dt;
        s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'slash', t: Math.min(1, this.holdT / SLASH_HOLD_TIME) });
      } else {
        const big = this.holdT >= SLASH_HOLD_TIME;
        this.holding = false; this.holdT = 0;
        s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'slash', t: -1 });
        if (big) this.bigSlash(host, w); else s.lightMelee();
      }
    } else if (input && host && input.meleePressed && this.slashT <= 0 && !host.isMeleeing) {
      this.holding = true; this.holdT = 0;
      s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'slash', t: 0 });
    }
    p.charging = this.holding && this.holdT >= SLASH_HOLD_TIME * 0.5;
    if (this.holding || this.slashT > 0 || !input || !host) return;

    // ── throws
    if (s.cooldown() > 0) return;
    if (input.firePressed) {
      if (s.brokenCheck(w)) return;
      if (!s.spend(w, 1)) { s.dryFire(w); return; }
      this.throwStars(w, 1);
      s.setCooldown(1 / Math.max(0.1, w.stats.fireRate));
    } else if (input.altPressed) {
      if (s.brokenCheck(w)) return;
      if (this.tripleCd > 0) return;
      const n = Math.min(3, s.mag(w));
      if (n <= 0 || !s.spend(w, n)) { s.dryFire(w); return; }
      this.throwStars(w, n);
      this.tripleCd = SHURIKEN_TRIPLE_COOLDOWN;
      s.setCooldown(Math.min(SHURIKEN_TRIPLE_COOLDOWN, 1 / Math.max(0.1, w.stats.fireRate)));
      s.ctx.bus.emit('weapon:altFired', { weaponId: w.def.id, origin: _muzzle.clone(), direction: _d.clone() });
    }
  }

  /** `n` stars along the shot line (`aimShot` — crosshair line unless the hand is blocked): 1 straight, 3 fanned horizontally. */
  private throwStars(w: UniqueWeapon, n: number): void {
    const s = this.s;
    s.muzzle(w, _muzzle);
    s.aimShot(w, w.def.range, _launch, _d);
    const dmg = w.stats.damage || SHURIKEN_DAMAGE;
    const speed = w.def.projectileSpeed ?? SHURIKEN_SPEED;
    for (let i = 0; i < n; i++) {
      const ang = n === 1 ? 0 : (i - (n - 1) / 2) * SHURIKEN_TRIPLE_SPREAD_DEG * DEG;
      _fan.copy(_d).applyAxisAngle(_up, ang);
      s.projectiles.fire(_launch, _fan, speed, dmg, w.def.range, w.def.tracerColor, w.def.id, false, { style: 'shuriken', gravityMul: 0.08 });
    }
    w.model.kick(0.6);
    s.recoil(w.stats.recoilV, (Math.random() - 0.5) * w.stats.recoilH);
    s.announceFire(w, _muzzle, _d, n > 1 ? 1 : 0, 0);
    s.ctx.bus.emit('audio:play', { id: 'melee_swing', position: _muzzle, volume: 0.6, pitch: 1.5 });
    this.pose.firing = true;
  }

  /* ── 용검 ── */
  private bigSlash(host: NonNullable<ReturnType<UniqueServices['host']>>, w: UniqueWeapon): void {
    const s = this.s;
    const cost = host.maxStamina * SLASH_STAMINA_RATIO;
    if (typeof host.consumeStamina !== 'function' || !host.consumeStamina(cost)) {
      s.deny();
      s.notify('스태미나 부족 — 용검 베기에는 절반이 필요합니다');
      return;
    }
    if (typeof host.setViewWiden === 'function') { host.setViewWiden(true); this.widened = true; }
    let ok = false;
    try { ok = host.startMelee('heavy'); } catch { ok = false; }
    if (!ok) { this.endSlash(); return; }
    this.slashT = SLASH_DURATION;
    this.hitT = SLASH_WINDUP;
    host.getEyePosition(_swing); host.getForward(_fwd);
    _swing.y -= 0.15; _swing.addScaledVector(_fwd, 0.6);
    s.fx.meleeArc(_swing, host.yaw, SLASH_RANGE * 0.75);
    s.ctx.bus.emit('audio:play', { id: 'melee_swing', volume: 1, pitch: 0.7 });
    s.ctx.bus.emit('camera:shake', { intensity: 0.15, duration: 0.2 });
    void w;
  }

  private resolveSlash(host: ReturnType<UniqueServices['host']>): void {
    const s = this.s;
    if (!host) return;
    host.getEyePosition(_origin);
    host.getForward(_fwd);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.y = 0; _fwd.normalize();
    const cosHalf = Math.cos(SLASH_ARC_DEG * 0.5 * DEG);
    const mgr = s.ctx.enemies;
    let hits = 0;
    if (mgr && typeof mgr.queryNear === 'function') {
      const near = mgr.queryNear(host.position, SLASH_RANGE + 2.5);
      const list = this.targets;
      list.length = 0;
      for (let i = 0; i < near.length; i++) list.push(near[i]);
      for (let i = 0; i < list.length && hits < SLASH_MAX_TARGETS; i++) {
        const e = list[i];
        if (!e || e.isDead) continue;
        enemyCentre(e, _c);
        _to.subVectors(_c, _origin);
        _to.y = 0;
        const dist = _to.length();
        if (dist > SLASH_RANGE + e.radius) continue;
        if (dist > 1e-4) { _to.divideScalar(dist); if (_to.dot(_fwd) < cosHalf) continue; }
        const wasDead = e.isDead;
        _c.addScaledVector(_fwd, -Math.min(e.radius, dist * 0.9));
        e.takeDamage(SLASH_DAMAGE, _c, _fwd);
        const killed = !wasDead && e.isDead;
        hits++;
        s.fx.meleeImpact(_c, _fwd, true);
        s.ctx.bus.emit('melee:hit', { point: _c.clone(), enemyId: e.id, damage: SLASH_DAMAGE, killed });
        s.ctx.bus.emit('ui:hitmarker', { kill: killed });
      }
    }
    if (hits > 0) {
      s.ctx.bus.emit('audio:play', { id: 'melee_hit', position: _origin, volume: 0.9, pitch: 0.8 });
      s.ctx.bus.emit('camera:shake', { intensity: 0.3, duration: 0.18 });
    }
    s.ctx.bus.emit('player:slashed', { position: host.position.clone(), direction: _fwd.clone(), hits });
    if (s.ctx.isMultiplayer && s.ctx.net) s.ctx.net.send({ t: 'melee', p: toTuple(_origin), d: toTuple(_fwd), hit: hits > 0 });
  }

  private endSlash(): void {
    this.slashT = 0; this.hitT = -1;
    if (!this.widened) return;
    this.widened = false;
    const host = this.s.host();
    if (host && typeof host.setViewWiden === 'function') host.setViewWiden(false);
  }

  private cancelHold(w: UniqueWeapon): void {
    if (!this.holding) return;
    this.holding = false; this.holdT = 0;
    this.s.ctx.bus.emit('weapon:chargeChanged', { weaponId: w.def.id, kind: 'slash', t: -1 });
  }

  reset(): void {
    if (this.cur) this.cancelHold(this.cur);
    this.endSlash();
    this.tripleCd = 0;
    this.pose.charging = this.pose.firing = false;
  }

  dispose(): void { this.reset(); }
}
