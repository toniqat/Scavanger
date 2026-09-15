import * as THREE from 'three';
import {
  BAZOOKA_DAMAGE, BAZOOKA_RADIUS, BAZOOKA_SPEED, BAZOOKA_ALT_FUSE, BAZOOKA_ALT_DAMAGE, BAZOOKA_ALT_RADIUS,
  BAZOOKA_KNOCKBACK, BAZOOKA_SUPER_JUMP, BAZOOKA_JUMP_FORWARD, BAZOOKA_FIRE_RATE, PLAYER_WALK_SPEED,
  BAZOOKA_KNOCKBACK_DIST_MUL, BAZOOKA_GROUNDED_DIST_MUL,
  explosionFalloff,
} from '@/shared';
import type { ProjectileHit } from '../Projectile';
import type { UniqueHandler, UniqueInput, UniquePose, UniqueServices, UniqueWeapon } from './UniqueHandler';

const _muzzle = new THREE.Vector3(), _launch = new THREE.Vector3(), _d = new THREE.Vector3(), _centre = new THREE.Vector3();
const _away = new THREE.Vector3(), _imp = new THREE.Vector3(), _blast = new THREE.Vector3(), _hvel = new THREE.Vector3();
/** Blast damage falloff floor for destructible cover at the edge of the radius (얹히는 하한 — 감쇠 자체는 `shared/explosion`). */
const COVER_MIN = 0.3;

/**
 * 「해머헤드」 바주카. LMB = impact rocket (`Projectile` style `rocket`, tag 0): `applyExplosion(BAZOOKA_RADIUS,
 * BAZOOKA_DAMAGE)` + destructible cover in the radius. RMB = air-burst rocket (tag 1, fuse `BAZOOKA_ALT_FUSE`,
 * `BAZOOKA_ALT_RADIUS` / `BAZOOKA_ALT_DAMAGE`). **No self damage** (2026-09-14, user decision): inside the blast the
 * player only gets `applyKnockback` away from it; **airborne** (read before the knockback) with the blast below the feet
 * → rocket jump `applyImpulse(horizontal boost, BAZOOKA_SUPER_JUMP)` + `player:blastJump` (impulse = that vector). The
 * horizontal boost is `BAZOOKA_JUMP_FORWARD × min(1, speed / PLAYER_WALK_SPEED)` along the horizontal velocity **before**
 * the knockback (standing still = straight up); the player controller keeps that momentum until landing (`airCarry`).
 * 2026-09-15 (user decision): throw distance × `BAZOOKA_KNOCKBACK_DIST_MUL` for the knockback and the whole rocket-jump
 * impulse, × `BAZOOKA_GROUNDED_DIST_MUL` again on the knockback when the shooter stood on the ground — applied as square
 * roots on the speeds (flight distance ∝ speed²). A grounded blast never rocket-jumps. Only the shooter is thrown.
 * Magazine 3 (`magSize`) at `BAZOOKA_FIRE_RATE` (≈ 0.35 s apart); an empty tube reloads itself after the last shot.
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
    // 2026-09-12: launch on the crosshair line unless the barrel is blocked (`aimShot`, hybrid judgement)
    s.aimShot(w, w.def.range, _launch, _d);
    const dmg = alt ? (w.def.altDamage ?? BAZOOKA_ALT_DAMAGE) : (w.stats.damage || BAZOOKA_DAMAGE);
    s.projectiles.fire(_launch, _d, w.def.projectileSpeed ?? BAZOOKA_SPEED, dmg, w.def.range, w.def.tracerColor, w.def.id, false,
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
        // 2026-09-15 (사용자 결정): 공용 2단 계단 위에 기존 하한을 그대로 얹는다
        o.destructible.onDamage(damage * Math.max(COVER_MIN, explosionFalloff(d, radius)), o.position);
      }
    }
    // knockback / rocket jump (no self damage)
    const host = s.host();
    if (host && !host.isDead) {
      _centre.copy(host.position); _centre.y += 0.9;
      const d = _centre.distanceTo(pos);
      if (d < radius) {
        /*
         * 2026-09-14 (사용자 결정): **자해 피해가 없다** — `takeDamage(BAZOOKA_SELF_DAMAGE)` 를 걷어냈다(상수는 계약이라
         * 남는다). 넉백 · 로켓 점프는 그대로다. 수평 이동 방향은 넉백 **전에** 읽는다: 발밑보다 앞에서 터진 로켓의
         * 넉백은 몸을 뒤로 밀어, 그 뒤에 읽으면 달리던 방향이 줄거나 뒤집힌다.
         */
        _hvel.set(host.velocity.x, 0, host.velocity.z);
        /*
         * 2026-09-15 (사용자 결정): 땅에 서 있었나를 넉백 **전에** 읽는다. `applyKnockback` 은 늘 `KNOCKBACK_MIN_LIFT`
         * 이상 띄워 `grounded` 를 먼저 꺼 버리므로, 뒤에서 `isGrounded` 를 읽으면 발밑에 쏜 지상 사격도 로켓 점프가 됐다.
         */
        const wasGrounded = host.isGrounded;
        _away.subVectors(_centre, pos);
        if (_away.lengthSq() < 1e-4) _away.set(0, 1, 0); else _away.normalize();
        /*
         * 2026-09-15 (사용자 결정): 날아가는 거리 ×`BAZOOKA_KNOCKBACK_DIST_MUL`, 지상이면 ×`BAZOOKA_GROUNDED_DIST_MUL` 한 번 더.
         * 비행 거리는 속도의 제곱에 비례하므로 속도에는 제곱근을 곱한다 (`docs/DECISIONS.md`).
         */
        const distSpeed = Math.sqrt(BAZOOKA_KNOCKBACK_DIST_MUL);
        const knock = BAZOOKA_KNOCKBACK * distSpeed * (wasGrounded ? Math.sqrt(BAZOOKA_GROUNDED_DIST_MUL) : 1);
        if (typeof host.applyKnockback === 'function') host.applyKnockback(_away, knock);
        if (!wasGrounded && pos.y < host.position.y + 0.4 && typeof host.applyImpulse === 'function') {
          _imp.set(0, BAZOOKA_SUPER_JUMP * distSpeed, 0);
          const hs = _hvel.length();
          if (hs > 1e-3) {
            const k = BAZOOKA_JUMP_FORWARD * distSpeed * Math.min(1, hs / PLAYER_WALK_SPEED) / hs;
            _imp.x = _hvel.x * k; _imp.z = _hvel.z * k;
          }
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
