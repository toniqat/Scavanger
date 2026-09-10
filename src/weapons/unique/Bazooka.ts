import * as THREE from 'three';
import {
  BAZOOKA_DAMAGE, BAZOOKA_RADIUS, BAZOOKA_SPEED, BAZOOKA_ALT_FUSE, BAZOOKA_ALT_DAMAGE, BAZOOKA_ALT_RADIUS,
  BAZOOKA_SELF_DAMAGE, BAZOOKA_KNOCKBACK, BAZOOKA_SUPER_JUMP, BAZOOKA_FIRE_RATE,
} from '@/shared';
import type { ProjectileHit } from '../Projectile';
import type { UniqueHandler, UniqueInput, UniquePose, UniqueServices, UniqueWeapon } from './UniqueHandler';

const _muzzle = new THREE.Vector3(), _target = new THREE.Vector3(), _d = new THREE.Vector3(), _centre = new THREE.Vector3();
const _away = new THREE.Vector3(), _imp = new THREE.Vector3(), _blast = new THREE.Vector3();
/** Blast damage falloff floor for destructible cover at the edge of the radius. */
const COVER_MIN = 0.3;

/**
 * 「해머헤드」 바주카. LMB = impact rocket (`Projectile` style `rocket`, tag 0): `applyExplosion(BAZOOKA_RADIUS,
 * BAZOOKA_DAMAGE)` + destructible cover in the radius. RMB = air-burst rocket (tag 1, fuse `BAZOOKA_ALT_FUSE`,
 * `BAZOOKA_ALT_RADIUS` / `BAZOOKA_ALT_DAMAGE`). **Self damage**: inside the blast the player takes the flat
 * `BAZOOKA_SELF_DAMAGE` (armor ignored — it is passed straight to `takeDamage`) and `applyKnockback` away from the
 * blast; airborne with the blast below the feet → `applyImpulse(0, BAZOOKA_SUPER_JUMP, 0)` + `player:blastJump`.
 * One rocket per tube: an empty tube reloads itself after the shot.
 */
export class Bazooka implements UniqueHandler {
  readonly kind = 'bazooka' as const;
  readonly handlesMelee = false;
  readonly allowsAim = false;
  readonly pose: UniquePose = { charging: false, spraying: false, heavy: true, firing: false };

  private reloadAsked = false;

  constructor(private readonly s: UniqueServices) {}

  onEquip(): void { this.reloadAsked = false; }
  onUnequip(): void { /* rockets in flight keep going */ }

  update(_dt: number, w: UniqueWeapon, input: UniqueInput | null): void {
    const s = this.s;
    this.pose.firing = false;
    const host = s.host();
    if (!host) return;
    const mag = s.mag(w);
    if (mag > 0) this.reloadAsked = false;
    if (!input) return;
    if (s.cooldown() > 0) return;
    // auto reload the empty tube once the shot has settled
    if (mag <= 0 && !this.reloadAsked && s.reserve(w) > 0) { this.reloadAsked = true; s.tryReload(w); return; }
    const alt = input.altPressed;
    if (!input.firePressed && !alt) return;
    if (s.brokenCheck(w)) return;
    if (!s.spend(w, 1)) { s.dryFire(w); return; }
    this.launch(w, alt);
  }

  private launch(w: UniqueWeapon, alt: boolean): void {
    const s = this.s;
    s.muzzle(w, _muzzle);
    s.aimTarget(w.def.range, _target);
    _d.subVectors(_target, _muzzle);
    if (_d.lengthSq() < 1e-6) s.aimRay(_target, _d); else _d.normalize();
    const dmg = alt ? (w.def.altDamage ?? BAZOOKA_ALT_DAMAGE) : (w.stats.damage || BAZOOKA_DAMAGE);
    s.projectiles.fire(_muzzle, _d, w.def.projectileSpeed ?? BAZOOKA_SPEED, dmg, w.def.range, w.def.tracerColor, w.def.id, false,
      { style: 'rocket', gravityMul: 0.02, tag: alt ? 1 : 0, fuse: alt ? BAZOOKA_ALT_FUSE : undefined });
    s.fx.muzzleFlash(_muzzle, _d, 0xffb060, 2.2);
    w.model.kick(3);
    s.recoil(w.stats.recoilV * 1.5, (Math.random() - 0.5) * w.stats.recoilH);
    s.setCooldown(1 / Math.max(0.1, w.stats.fireRate || BAZOOKA_FIRE_RATE));
    s.announceFire(w, _muzzle, _d, alt ? 1 : 0, 0);
    if (alt) s.ctx.bus.emit('weapon:altFired', { weaponId: w.def.id, origin: _muzzle.clone(), direction: _d.clone() });
    s.ctx.bus.emit('audio:play', { id: 'shot_shotgun', position: _muzzle, volume: 1, pitch: 0.6 });
    s.ctx.bus.emit('camera:shake', { intensity: 0.45, duration: 0.25 });
    this.pose.firing = true;
  }

  /** A rocket landed (surface / enemy) or its fuse ran out. */
  onProjectileHit(h: ProjectileHit, damage: number, w: UniqueWeapon): void {
    const alt = h.tag === 1;
    const radius = alt ? BAZOOKA_ALT_RADIUS : BAZOOKA_RADIUS;
    _blast.copy(h.point);
    // lift a ground impact slightly so the sphere clears the terrain
    if (!h.enemy && !h.fused) _blast.addScaledVector(h.normal, 0.25);
    this.explode(_blast, radius, damage, w);
  }

  private explode(pos: THREE.Vector3, radius: number, damage: number, w: UniqueWeapon): void {
    const s = this.s;
    const ctx = s.ctx;
    const kills = ctx.enemies ? ctx.enemies.applyExplosion(pos, radius, damage) : 0;
    // destructible cover (dropped structures) inside the blast
    const world = ctx.world;
    if (world && world.ready && typeof world.getObstaclesNear === 'function') {
      const near = world.getObstaclesNear(pos.x, pos.z, radius + 1.5);
      for (let i = 0; i < near.length; i++) {
        const o = near[i];
        if (!o.destructible) continue;
        const d = Math.max(0, o.position.distanceTo(pos) - o.radius);
        if (d > radius) continue;
        o.destructible.onDamage(damage * Math.max(COVER_MIN, 1 - d / radius), o.position);
      }
    }
    // self damage / knockback / rocket jump
    const host = s.host();
    if (host && !host.isDead) {
      _centre.copy(host.position); _centre.y += 0.9;
      const d = _centre.distanceTo(pos);
      if (d < radius) {
        /*
         * 2026-09-10: 방탄복이 피해를 깎지 않게 되어(`damageReduction` 은 늘 0) 되돌릴 감쇄가 없다 —
         * `BAZOOKA_SELF_DAMAGE` 를 그대로 넣는다. 방탄복은 이제 실드로 이 피해를 **대신 맞아 준다**.
         */
        host.takeDamage(BAZOOKA_SELF_DAMAGE, pos.clone());
        _away.subVectors(_centre, pos);
        if (_away.lengthSq() < 1e-4) _away.set(0, 1, 0); else _away.normalize();
        if (typeof host.applyKnockback === 'function') host.applyKnockback(_away, BAZOOKA_KNOCKBACK);
        if (!host.isGrounded && pos.y < host.position.y + 0.4 && typeof host.applyImpulse === 'function') {
          _imp.set(0, BAZOOKA_SUPER_JUMP, 0);
          host.applyImpulse(_imp);
          ctx.bus.emit('player:blastJump', { position: host.position.clone(), impulse: _imp.clone() });
        }
      }
      const shake = THREE.MathUtils.clamp(1 - d / 30, 0, 1);
      if (shake > 0) ctx.bus.emit('camera:shake', { intensity: 0.3 + shake * 0.7, duration: 0.4 });
    }
    s.fx.explosion(pos, radius);
    ctx.bus.emit('weapon:hit', { point: pos.clone(), normal: new THREE.Vector3(0, 1, 0), enemyId: null, damage, killed: kills > 0 });
    ctx.bus.emit('audio:play', { id: 'explosion', position: pos, volume: 1 });
    if (kills > 0) ctx.bus.emit('ui:hitmarker', { kill: true });
    void w;
  }

  reset(): void { this.reloadAsked = false; this.pose.firing = false; }
  dispose(): void { /* nothing owned */ }
}
