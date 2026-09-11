import * as THREE from 'three';
import {
  MELEE_DAMAGE, MELEE_RANGE, MELEE_STOCK_MUL_DEFAULT,
  type DeployableRef, type EnemyRef, type GameContext, type PlayerRef, type PlayerWeaponHost,
  type Vec3Tuple, type WeaponDef,
} from '@/shared';
import type { WeaponFx } from './fx/WeaponFx';

type Host = PlayerRef & PlayerWeaponHost;

/** Seconds between the swing starting (player animation) and the hit being resolved. */
export const MELEE_WINDUP = 0.16;
/** cos of the half-angle of the damage cone (~70°). */
const MELEE_COS = 0.34;
/** Never damage more than this many things with one swing (bug swarms). */
const MELEE_MAX_TARGETS = 4;

const _origin = new THREE.Vector3(), _dir = new THREE.Vector3(), _to = new THREE.Vector3();
const _point = new THREE.Vector3(), _swing = new THREE.Vector3(), _fwd = new THREE.Vector3();

/** Vector3 → wire tuple rounded to 3 dp. */
function toTuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
}

/**
 * Melee attack (F / `Keys.MELEE`). Owned by `WeaponSystem`.
 *
 * Division of labour: **player** owns the gate (stamina `MELEE_STAMINA_COST`, `MELEE_COOLDOWN`, the swing
 * pose) through `PlayerRef.startMelee()`; **weapons** owns the hit resolution. A swing therefore only ever
 * starts when `startMelee()` returns true, or when someone else emits `melee:swing` (the player system may
 * read F itself — the bus path keeps exactly one resolution either way).
 *
 * Damage = `MELEE_DAMAGE × (WeaponDef.meleeMul ?? MELEE_STOCK_MUL_DEFAULT) × derived.meleeDamageMul`
 * — every weapon hits equally hard except the ones whose stock (개머리판) carries a multiplier.
 *
 * Multiplayer: the swing is replicated with a `melee` message (FX/audio only); enemy damage travels the
 * normal client → host `hit` request path inside `EnemyRef.takeDamage`.
 */
export class MeleeController {
  /** Seconds until the pending swing resolves; < 0 = idle. */
  private windup = -1;
  private damage = 0;
  private weaponId: string | null = null;
  private yaw = 0;
  /** Set while we emit `melee:swing` ourselves so our own listener does not double-resolve. */
  private selfEmit = false;
  private readonly targets: EnemyRef[] = [];

  constructor(private readonly ctx: GameContext, private readonly fx: WeaponFx) {}

  /** true while a swing is queued (input is ignored until it resolves). */
  get busy(): boolean { return this.windup >= 0; }

  /**
   * F pressed. Asks the player for a swing (stamina / cooldown / controls live there) and starts the
   * resolution timer when it is granted. Returns true when the swing started.
   */
  tryStart(host: Host, def: WeaponDef | null): boolean {
    if (this.windup >= 0) return false;
    if (typeof host.startMelee !== 'function') return false;
    let ok = false;
    try { ok = host.startMelee(); } catch { ok = false; }
    if (!ok) return false;
    this.begin(host, def, true);
    return true;
  }

  /** `melee:swing` emitted by somebody else (player system read F first) — resolve without re-emitting. */
  onBusSwing(host: Host | null, def: WeaponDef | null): void {
    if (this.selfEmit || this.windup >= 0 || !host) return;
    this.begin(host, def, false);
  }

  private begin(host: Host, def: WeaponDef | null, emit: boolean): void {
    const ctx = this.ctx;
    this.weaponId = def?.id ?? null;
    const stockMul = def?.meleeMul ?? MELEE_STOCK_MUL_DEFAULT;
    const skillMul = ctx.progression?.derived?.meleeDamageMul ?? 1;
    this.damage = MELEE_DAMAGE * stockMul * (skillMul > 0 ? skillMul : 1);
    this.windup = MELEE_WINDUP;
    this.yaw = host.yaw;

    // swoosh where the arms are, not at the camera
    host.getEyePosition(_swing);
    host.getForward(_fwd);
    _swing.y -= 0.2;
    _swing.addScaledVector(_fwd, 0.45);
    this.fx.meleeArc(_swing, this.yaw, MELEE_RANGE * 0.55);
    ctx.bus.emit('audio:play', { id: 'melee_swing', volume: 0.7 });

    if (emit) {
      this.selfEmit = true;
      try { ctx.bus.emit('melee:swing', { weaponId: this.weaponId, damage: this.damage }); }
      finally { this.selfEmit = false; }
    }
  }

  update(dt: number, host: Host | null): void {
    if (this.windup < 0) return;
    this.windup -= dt;
    if (this.windup > 0) return;
    this.windup = -1;
    this.resolve(host);
  }

  /** Cancel a queued swing (mission reset / hub / death). */
  cancel(): void { this.windup = -1; }

  /* ─────────────────────────── hit resolution ─────────────────────────── */
  private resolve(host: Host | null): void {
    const ctx = this.ctx;
    if (!host) return;
    // aim at the moment of impact; the cone starts at the shoulders (the camera sits behind the player)
    host.getAimRay(_to, _dir);
    if (_dir.lengthSq() < 1e-6) host.getForward(_dir);
    _dir.normalize();
    host.getEyePosition(_origin);

    const dmg = this.damage;
    let anyHit = false;
    let hits = 0;

    // ── enemies
    const mgr = ctx.enemies;
    if (mgr) {
      const list = this.collectEnemies(mgr, _origin);
      for (let i = 0; i < list.length && hits < MELEE_MAX_TARGETS; i++) {
        const e = list[i];
        if (!e || e.isDead) continue;
        if (!this.inConeEnemy(e, _origin, _dir, _point)) continue;
        const wasDead = e.isDead;
        try { e.takeDamage(dmg, _point, _dir); } catch { continue; }
        const killed = !wasDead && e.isDead;
        hits++; anyHit = true;
        this.fx.meleeImpact(_point, _dir, true);
        ctx.bus.emit('melee:hit', { point: _point.clone(), enemyId: e.id, damage: dmg, killed });
        ctx.bus.emit('ui:hitmarker', { kill: killed });
        ctx.bus.emit('audio:play', { id: 'melee_hit', position: _point, volume: 0.8 });
      }
    }

    // ── deployables (barricades, turrets, mines, dome shields …)
    const gad = ctx.gadgets;
    if (gad && typeof gad.getDeployables === 'function' && hits < MELEE_MAX_TARGETS) {
      let list: readonly DeployableRef[] = [];
      try { list = gad.getDeployables(); } catch { list = []; }
      for (let i = 0; i < list.length && hits < MELEE_MAX_TARGETS; i++) {
        const d = list[i];
        if (!d || d.maxHp <= 0 || d.hp <= 0) continue;
        if (!this.inCone(d.position, d.radius, d.radius * 2, _origin, _dir, _point)) continue;
        try { d.takeDamage(dmg, _origin); } catch { continue; }
        hits++; anyHit = true;
        this.fx.meleeImpact(_point, _dir, false);
        ctx.bus.emit('melee:hit', { point: _point.clone(), enemyId: null, damage: dmg, killed: false });
        ctx.bus.emit('audio:play', { id: 'melee_hit', position: _point, volume: 0.55 });
      }
    }

    if (anyHit) ctx.bus.emit('camera:shake', { intensity: 0.18, duration: 0.12 });
    if (ctx.isMultiplayer && ctx.net) {
      ctx.net.send({ t: 'melee', p: toTuple(_origin), d: toTuple(_dir), hit: anyHit });
    }
  }

  /** Alive enemies that could possibly be in range. Uses `queryNear` when the enemies module has it. */
  private collectEnemies(mgr: NonNullable<GameContext['enemies']>, origin: THREE.Vector3): readonly EnemyRef[] {
    const radius = MELEE_RANGE + 2.5;
    if (typeof mgr.queryNear === 'function') {
      try {
        const near = mgr.queryNear(origin, radius);
        if (near) return near;
      } catch { /* fall through to the full list */ }
    }
    const all = mgr.getEnemies();
    const out = this.targets;
    out.length = 0;
    const r2 = radius * radius;
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (e.isDead) continue;
      if (e.position.distanceToSquared(origin) <= r2) out.push(e);
    }
    return out;
  }

  /**
   * C-62 (2026-09-11): cone test against the enemy's own body hitbox — `EnemyRef.nearestBodyPoint` (the lying capsule of a
   * prone sniper, the standing capsule / sphere the raycast uses otherwise) gives the contact point; reach is `MELEE_RANGE`
   * from that surface and the cone looks at it. For a sphere-shaped body this is exactly the old `MELEE_RANGE + radius` from
   * the centre. Works on replicas too (a pure geometry query on the interpolated body). Without the method: the old test.
   */
  private inConeEnemy(e: EnemyRef, origin: THREE.Vector3, dir: THREE.Vector3, point: THREE.Vector3): boolean {
    if (typeof e.nearestBodyPoint !== 'function') return this.inCone(e.position, e.radius, e.height, origin, dir, point);
    try { e.nearestBodyPoint(origin, point); } catch { return this.inCone(e.position, e.radius, e.height, origin, dir, point); }
    _to.subVectors(point, origin);
    const dist = _to.length();
    if (dist > MELEE_RANGE) return false;
    if (dist < 1e-4) return true;   // swinging from inside the body
    return _to.dot(dir) >= MELEE_COS * dist;
  }

  /**
   * Sphere-ish cone test against a target centred on `pos` (feet) with `radius` / `height`.
   * Writes the contact point (surface of the target facing the swinger) into `point`.
   */
  private inCone(pos: THREE.Vector3, radius: number, height: number, origin: THREE.Vector3, dir: THREE.Vector3, point: THREE.Vector3): boolean {
    point.copy(pos);
    point.y += Math.min(height * 0.5, 1.4);
    _to.subVectors(point, origin);
    const dist = _to.length();
    if (dist > MELEE_RANGE + radius) return false;
    if (dist < 1e-4) return true;
    _to.divideScalar(dist);
    if (_to.dot(dir) < MELEE_COS) return false;
    // contact point on the near surface
    point.addScaledVector(_to, -Math.min(radius, dist * 0.9));
    return true;
  }
}
