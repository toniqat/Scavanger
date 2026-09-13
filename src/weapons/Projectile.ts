import * as THREE from 'three';
import { GRAVITY, type GameContext, type EnemyRef, type Obstacle, type WeaponDef, type PeerId, type InterceptableRef } from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import type { HitInfo } from './model';

export interface ProjectileHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  enemy: EnemyRef | null;
  part?: 'head' | 'body' | 'rear' | 'front';
  obstacle: boolean;
  /** The obstacle that was hit (Phase 3: destructible cover), if any. */
  obstacleRef?: Obstacle | null;
  /** Phase 4: the enemy hitbox is armour plate (behemoth front) — non-heavy rounds ricochet. */
  armored?: boolean;
  dir: THREE.Vector3;
  /** Distance travelled from the launch point to the hit point (meters, along the flight) — for damage falloff. */
  distance: number;
  /** Caller tag handed to `fire(..., { tag })` (unique weapons: 0 = LMB rocket, 1 = RMB air-burst). */
  tag: number;
  /** true when the projectile went off on its own fuse (no surface / enemy under it). */
  fused: boolean;
  /** Phase 9: the projectile stopped at an implant barrier of this owner (`WeaponSystem` bills the barrier once; the raycast is pure). */
  barrierOwner?: PeerId | 'local' | null;
  /* ── 2026-09-14 모든 총알을 발사체로 ── */
  /** An interceptable enemy shell was hit (the hitscan path could always shoot them down). */
  intercept?: InterceptableRef | null;
  /** The damage handed to `onHit` already carries the distance falloff (`ProjectileOptions.falloff*`). */
  falloffApplied?: boolean;
  /** Pellet of a multi-pellet shot (quieter impact). */
  light?: boolean;
  /** Calibre of the round (armour-plate ricochet rule). */
  ammoType?: string;
  /** The pool reported this launch to `ctx.enemies.reportShot` (so the impact completes the report). */
  reported?: boolean;
}

/**
 * Visual style of a projectile: `bullet` / `slug` = a glowing tracer streak (one shared instanced mesh — `slug` is the
 * legacy name callers without options still get), or one of the unique-weapon bodies.
 */
export type ProjectileStyle = 'slug' | 'bullet' | 'shuriken' | 'arrow' | 'rocket';

export interface ProjectileOptions {
  style?: ProjectileStyle;
  /** Gravity multiplier on `GRAVITY` (default 0.15 = the old slight drop; 0 = dead straight — bow / rocket). */
  gravityMul?: number;
  /** 2026-09-14: downward acceleration in m/s² (`EffectiveWeaponStats.bulletGravity`); wins over `gravityMul`. */
  gravity?: number;
  /** Seconds after launch when the projectile detonates by itself (bazooka RMB); undefined = never. */
  fuse?: number;
  /** Opaque number handed back in `ProjectileHit.tag`. */
  tag?: number;
  /**
   * 2026-09-14: false = the caller reports the shot to `ctx.enemies.reportShot` itself (gun fire reports **once per
   * trigger pull** — eight pellets are one report). Default true: launch + impact reports (uniques, direct calls).
   */
  report?: boolean;
  /** 2026-09-14: effective falloff (`EffectiveWeaponStats.falloffStart/End/Min`) applied at the impact by distance travelled. */
  falloffStart?: number;
  falloffEnd?: number;
  falloffMin?: number;
  /** Pellet of a multi-pellet shot. */
  light?: boolean;
  /** Calibre (armour ricochet). */
  ammoType?: string;
  /**
   * Visual-only offset (muzzle − launch point). The shot is judged on the crosshair line (`parts/AimLine`), which starts
   * beside the gun; the streak is drawn from the muzzle and slides onto the real flight line over `VIS_CONVERGE_M`.
   * Nothing but the drawing reads it.
   */
  visualOffset?: THREE.Vector3 | null;
  /** Streak width (m) at close range. */
  width?: number;
}

/**
 * Projectile body / flight for a weapon def: bow arrows fly dead straight, shuriken stars barely drop, bazooka
 * rockets keep a tiny drop (fuse / tag are set by the caller per mode). Regular slugs get undefined (defaults).
 */
export function projectileOptsFor(def: WeaponDef): ProjectileOptions | undefined {
  switch (def.unique) {
    case 'bow': return { style: 'arrow', gravityMul: 0 };
    case 'shuriken': return { style: 'shuriken', gravityMul: 0.08 };
    case 'bazooka': return { style: 'rocket', gravityMul: 0.02 };
    default: return undefined;
  }
}

/** Styled body kinds (everything but the streak). */
type BodyStyle = 'shuriken' | 'arrow' | 'rocket';

interface StyledBody {
  group: THREE.Group;
  styled: Record<BodyStyle, THREE.Object3D>;
  inUse: boolean;
}

interface Slug {
  /** Index in `live` while active, −1 when free. */
  slot: number;
  /** Launch order (eviction picks the oldest visual-only replica). */
  seq: number;
  pos: THREE.Vector3; vel: THREE.Vector3; prev: THREE.Vector3;
  life: number; range: number; damage: number; color: number; weaponId: string;
  travelled: number;
  /** Replica of a remote player's shot: impact FX only, never damage (routed to `onVisualHit`). */
  visualOnly: boolean;
  style: ProjectileStyle;
  /** m/s² downward. */
  gravity: number;
  fuse: number;
  tag: number;
  spin: number;
  report: boolean;
  /** NaN = no falloff carried by the slug (legacy callers — the system looks the weapon up). */
  fStart: number; fEnd: number; fMin: number;
  light: boolean;
  ammoType: string | undefined;
  visOff: THREE.Vector3;
  hasVisOff: boolean;
  width: number;
  body: StyledBody | null;
}

const DEFAULT_GRAVITY_MUL = 0.15;
/** Live slugs above this evict the oldest visual-only replica first; local shots are never dropped (the pool grows). */
const SOFT_CAP = 384;
/** Runaway guard only (unreachable in play: a gun empties its magazine long before). */
const HARD_CAP = 4096;
/** Streak instances drawn per frame (simulation is never capped — only the drawing). */
const STREAK_CAP = 256;
/** Pre-built unique bodies (the pool builds more on demand from shared geometry / materials). */
const BODY_PREALLOC = 12;
/** The streak slides from the muzzle onto the judged flight line over this many metres. */
const VIS_CONVERGE_M = 14;
/** Streak length (m) = speed × this, clamped. Tracer brightness factor (additive, not tone-mapped). */
const STREAK_TIME = 0.018, STREAK_MIN = 0.8, STREAK_MAX = 9, STREAK_GLOW = 1.8;
/** Far streaks widen with camera distance so a bullet stays readable (× up to `STREAK_WIDEN_MAX`). */
const STREAK_WIDEN_FROM = 18, STREAK_WIDEN_MAX = 6;
/** A breakable pane is skipped by this much (thicker than `GLASS_T`) before the sweep continues. */
const PANE_SKIP = 0.08;
const MAX_PANES_PER_STEP = 3;

const _dir = new THREE.Vector3(), _from = new THREE.Vector3(), _look = new THREE.Vector3();
const _head = new THREE.Vector3(), _tail = new THREE.Vector3(), _mid = new THREE.Vector3(), _sdir = new THREE.Vector3();
const _scale = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _col = new THREE.Color();
const _zAxis = new THREE.Vector3(0, 0, 1);

/** Nearest of every bullet stopper along a segment (the owner passes `WeaponSystem.raycastAll`). */
export type ProjectileSweep = (origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: HitInfo) => void;

function makeScratchHit(): HitInfo {
  return { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, enemy: null, obstacle: false, valid: false, headshot: false, obstacleRef: null, armored: false, intercept: null, barrierOwner: null };
}

/** Linear falloff: ×1 up to `start`, down to `min` at `end` (same rule as `@/items damageFalloff`, from effective stats). */
export function falloffAt(start: number, end: number, min: number, distance: number): number {
  if (!(end > start)) return 1;
  if (distance <= start) return 1;
  if (distance >= end) return min;
  return 1 - ((distance - start) / (end - start)) * (1 - min);
}

/**
 * Pooled travelling projectiles. **2026-09-14: every ordinary gun bullet flies through here** (`parts/Firing.fire`),
 * next to the unique bodies (shuriken / arrow / rocket).
 *
 * - **Swept**: each integration step is one segment `prev → pos` tested with the owner's `raycastAll` (enemies, world,
 *   interceptable shells, barriers / deployables), so a 650 m/s round with the 50 ms dt clamp (32 m per step) cannot
 *   tunnel through an enemy or a thin wall. Gravity is integrated exactly for a constant acceleration.
 * - **Window glass**: a breakable pane on the segment is broken (local shots) and the round flies on through it —
 *   visual-only replicas just pass (the breaker's client syncs the pane).
 * - **Never drops a local shot**: a free list, grown on demand. Above `SOFT_CAP` the oldest visual-only replica is
 *   evicted first; `HARD_CAP` is only a runaway guard.
 * - **Cheap tracers, no lights**: every `bullet` / `slug` is a stretched box in **one** `InstancedMesh` (additive, not
 *   tone-mapped, instance colours), in the scene from the start so the core shader warm-up compiles it. No per-frame
 *   allocation.
 */
export class ProjectilePool {
  readonly group = new THREE.Group();
  /** Active slugs (unordered — swap-remove). Read-only outside (smokes / debug). */
  readonly live: Slug[] = [];
  private readonly free: Slug[] = [];
  private readonly bodies: StyledBody[] = [];
  private seq = 0;
  private readonly streaks: THREE.InstancedMesh;
  private readonly streakGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly streakMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  private streaksDrawn = 0;
  /* shared unique-body resources (one geometry / material set for the whole pool) */
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly bodyRes: {
    mSteel: THREE.Material; mDark: THREE.Material; mShaft: THREE.Material; mFletch: THREE.Material; mRocket: THREE.Material; mWarhead: THREE.Material; mGlow: THREE.Material;
    gStarBlade: THREE.BufferGeometry; gStarHub: THREE.BufferGeometry; gShaft: THREE.BufferGeometry; gHead: THREE.BufferGeometry; gFletch: THREE.BufferGeometry;
    gTube: THREE.BufferGeometry; gNose: THREE.BufferGeometry; gFin: THREE.BufferGeometry; gExhaust: THREE.BufferGeometry;
  };
  private readonly hit: ProjectileHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), enemy: null, part: undefined, obstacle: false, dir: new THREE.Vector3(), distance: 0, tag: 0, fused: false };
  private readonly sweepHit = makeScratchHit();

  /**
   * @param onHit       damage-dealing hit (local shots)
   * @param onVisualHit impact FX only, for `visualOnly` replicas of remote shots (optional)
   * @param sweep       segment query (`WeaponSystem.raycastAll`)
   */
  constructor(
    private readonly ctx: GameContext,
    private readonly onHit: (h: ProjectileHit, damage: number, weaponId: string) => void,
    private readonly onVisualHit: ((h: ProjectileHit, weaponId: string) => void) | undefined,
    private readonly sweep: ProjectileSweep,
  ) {
    this.group.name = 'Projectiles';
    const mSteel = this.sharedMat(0xc9d2dc, 0.9, 0.35);
    const mDark = this.sharedMat(0x1c2026, 0.6, 0.6);
    const mShaft = this.sharedMat(0x8a6a3c, 0.1, 0.8);
    const mFletch = this.sharedMat(0xe8e2d0, 0.0, 0.9);
    const mRocket = this.sharedMat(0x5a6470, 0.8, 0.45);
    const mWarhead = this.sharedMat(0xc44a2a, 0.5, 0.5);
    const mGlow = new THREE.MeshBasicMaterial({ color: 0xffa040, toneMapped: false }); this.mats.push(mGlow);
    this.bodyRes = {
      mSteel, mDark, mShaft, mFletch, mRocket, mWarhead, mGlow,
      gStarBlade: this.sharedGeo(new THREE.BoxGeometry(0.26, 0.012, 0.05)),
      gStarHub: this.sharedGeo(new THREE.CylinderGeometry(0.045, 0.045, 0.014, 8)),
      gShaft: this.sharedGeo(new THREE.CylinderGeometry(0.008, 0.008, 0.72, 6)),
      gHead: this.sharedGeo(new THREE.ConeGeometry(0.02, 0.09, 6)),
      gFletch: this.sharedGeo(new THREE.BoxGeometry(0.004, 0.05, 0.09)),
      gTube: this.sharedGeo(new THREE.CylinderGeometry(0.055, 0.055, 0.46, 10)),
      gNose: this.sharedGeo(new THREE.ConeGeometry(0.055, 0.14, 10)),
      gFin: this.sharedGeo(new THREE.BoxGeometry(0.006, 0.09, 0.1)),
      gExhaust: this.sharedGeo(new THREE.CylinderGeometry(0.035, 0.02, 0.08, 8)),
    };
    for (let i = 0; i < BODY_PREALLOC; i++) this.bodies.push(this.buildBody());
    // one streak batch: instance colours exist from the first frame so the warm-up compiles the variant the game draws
    this.streaks = new THREE.InstancedMesh(this.streakGeo, this.streakMat, STREAK_CAP);
    this.streaks.name = 'BulletStreaks';
    this.streaks.frustumCulled = false;
    this.streaks.castShadow = false; this.streaks.receiveShadow = false;
    this.streaks.renderOrder = 25;
    this.streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < STREAK_CAP; i++) { this.streaks.setMatrixAt(i, _m.identity()); this.streaks.setColorAt(i, _col.setRGB(0, 0, 0)); }
    this.streaks.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.streaks.count = 0;
    this.group.add(this.streaks);
    for (let i = 0; i < 64; i++) this.free.push(this.makeSlug());
    ctx.scene.add(this.group);
  }

  private sharedMat(color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    this.mats.push(m);
    return m;
  }
  private sharedGeo<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g; }

  private makeSlug(): Slug {
    return {
      slot: -1, seq: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), prev: new THREE.Vector3(), life: 0, range: 0, damage: 0, color: 0xffffff,
      weaponId: '', travelled: 0, visualOnly: false, style: 'slug', gravity: 0, fuse: -1, tag: 0, spin: 0, report: true,
      fStart: NaN, fEnd: NaN, fMin: NaN, light: false, ammoType: undefined, visOff: new THREE.Vector3(), hasVisOff: false, width: 0.035, body: null,
    };
  }

  /** A hidden shuriken / arrow / rocket body (shared geometry + materials — no new programs). */
  private buildBody(): StyledBody {
    const r = this.bodyRes;
    const group = new THREE.Group();
    group.visible = false;
    // shuriken: four-point star lying in the local XZ plane (spins about local Y)
    const star = new THREE.Group();
    const b1 = new THREE.Mesh(r.gStarBlade, r.mSteel);
    const b2 = new THREE.Mesh(r.gStarBlade, r.mSteel); b2.rotation.y = Math.PI / 2;
    const hub = new THREE.Mesh(r.gStarHub, r.mDark);
    star.add(b1, b2, hub);
    // arrow: shaft along +Z (the group looks down its velocity), head in front, fletching behind
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(r.gShaft, r.mShaft); shaft.rotation.x = Math.PI / 2;
    const head = new THREE.Mesh(r.gHead, r.mSteel); head.rotation.x = Math.PI / 2; head.position.z = 0.4;
    const f1 = new THREE.Mesh(r.gFletch, r.mFletch); f1.position.z = -0.3;
    const f2 = new THREE.Mesh(r.gFletch, r.mFletch); f2.position.z = -0.3; f2.rotation.z = Math.PI / 2;
    arrow.add(shaft, head, f1, f2);
    // rocket: tube + warhead nose + four fins + glowing exhaust cup
    const rocket = new THREE.Group();
    const tube = new THREE.Mesh(r.gTube, r.mRocket); tube.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(r.gNose, r.mWarhead); nose.rotation.x = Math.PI / 2; nose.position.z = 0.3;
    const exhaust = new THREE.Mesh(r.gExhaust, r.mGlow); exhaust.rotation.x = -Math.PI / 2; exhaust.position.z = -0.26;
    rocket.add(tube, nose, exhaust);
    for (let k = 0; k < 4; k++) {
      const fin = new THREE.Mesh(r.gFin, r.mDark);
      fin.position.set(0, 0.075, -0.18);
      fin.rotation.z = (Math.PI / 2) * k;
      fin.position.applyAxisAngle(_zAxis, (Math.PI / 2) * k);
      rocket.add(fin);
    }
    star.visible = arrow.visible = rocket.visible = false;
    group.add(star, arrow, rocket);
    this.group.add(group);
    return { group, styled: { shuriken: star, arrow, rocket }, inUse: false };
  }

  private acquireBody(style: BodyStyle): StyledBody {
    let b: StyledBody | undefined;
    for (let i = 0; i < this.bodies.length; i++) if (!this.bodies[i].inUse) { b = this.bodies[i]; break; }
    if (!b) { b = this.buildBody(); this.bodies.push(b); }
    b.inUse = true;
    b.styled.shuriken.visible = style === 'shuriken';
    b.styled.arrow.visible = style === 'arrow';
    b.styled.rocket.visible = style === 'rocket';
    b.group.visible = true;
    return b;
  }

  /** A slug for a new launch: free list → grow; past the soft cap the oldest visual replica is recycled first. */
  private acquire(): Slug {
    if (this.live.length >= SOFT_CAP) {
      let oldest = -1;
      for (let i = 0; i < this.live.length; i++) {
        const s = this.live[i];
        if (s.visualOnly && (oldest < 0 || s.seq < this.live[oldest].seq)) oldest = i;
      }
      if (oldest < 0 && this.live.length >= HARD_CAP) {
        for (let i = 0; i < this.live.length; i++) if (oldest < 0 || this.live[i].seq < this.live[oldest].seq) oldest = i;
      }
      if (oldest >= 0) this.kill(this.live[oldest]);
    }
    const s = this.free.pop() ?? this.makeSlug();
    s.slot = this.live.length;
    this.live.push(s);
    return s;
  }

  get liveCount(): number { return this.live.length; }

  fire(origin: THREE.Vector3, dir: THREE.Vector3, speed: number, damage: number, range: number, color: number, weaponId: string, visualOnly = false, opts?: ProjectileOptions): void {
    const s = this.acquire();
    s.report = !visualOnly && (opts?.report ?? true);
    // Phase 12 총알 추적: a reporting launch goes out along its initial line with no impact yet (the impact follows from
    // `WeaponSystem.onProjectileHit`); gun fire reports once per trigger pull itself (`report: false`); visual-only
    // replicas of other players' shots are the shooter's to report.
    if (s.report) this.ctx.enemies?.reportShot(origin, dir, range, null);
    const v = Math.max(0.01, speed);
    s.seq = ++this.seq;
    s.pos.copy(origin); s.prev.copy(origin);
    s.vel.copy(dir).multiplyScalar(v);
    s.range = Math.max(0.1, range);
    s.life = s.range / v + 0.25;
    s.damage = damage; s.color = color; s.weaponId = weaponId; s.travelled = 0; s.visualOnly = visualOnly;
    s.style = opts?.style ?? 'slug';
    s.gravity = opts?.gravity !== undefined ? Math.max(0, opts.gravity) : GRAVITY * (opts?.gravityMul ?? DEFAULT_GRAVITY_MUL);
    s.fuse = opts?.fuse ?? -1;
    s.tag = opts?.tag ?? 0;
    s.spin = 0;
    s.fStart = opts?.falloffStart ?? NaN; s.fEnd = opts?.falloffEnd ?? NaN; s.fMin = opts?.falloffMin ?? NaN;
    s.light = !!opts?.light;
    s.ammoType = opts?.ammoType;
    s.width = opts?.width ?? 0.035;
    const off = opts?.visualOffset;
    s.hasVisOff = !!off && off.lengthSq() > 1e-6;
    if (s.hasVisOff) s.visOff.copy(off!); else s.visOff.set(0, 0, 0);
    s.body = null;
    if (s.style === 'shuriken' || s.style === 'arrow' || s.style === 'rocket') {
      s.body = this.acquireBody(s.style);
      this.orient(s);
    }
  }

  /** Point the styled body down its velocity (+Z of the group = flight direction). */
  private orient(s: Slug): void {
    const b = s.body;
    if (!b) return;
    b.group.position.copy(s.pos);
    if (s.vel.lengthSq() > 1e-6) { _look.copy(s.pos).add(s.vel); b.group.lookAt(_look); }
  }

  update(dt: number): void {
    if (dt <= 0) { this.drawStreaks(); return; }
    const ctx = this.ctx;
    const world = ctx.world && ctx.world.ready ? ctx.world : null;
    const fx = FxManager.get();
    // descending + swap-remove: a slug moved into `i` by a kill has already been stepped this frame
    for (let i = this.live.length - 1; i >= 0; i--) {
      const s = this.live[i];
      if (!s) continue;
      s.life -= dt;
      if (s.life <= 0 || s.travelled >= s.range) { this.kill(s); continue; }
      s.prev.copy(s.pos);
      // exact step under constant gravity
      s.pos.x += s.vel.x * dt;
      s.pos.z += s.vel.z * dt;
      s.pos.y += s.vel.y * dt - 0.5 * s.gravity * dt * dt;
      s.vel.y -= s.gravity * dt;
      _dir.subVectors(s.pos, s.prev);
      const segLen = _dir.length();
      if (segLen <= 1e-5) { this.place(s, dt); continue; }
      _dir.divideScalar(segLen);
      const h = this.hit;
      let hitAny = this.sweepStep(s, segLen);
      if (!hitAny && world && s.pos.y < world.getHeightAt(s.pos.x, s.pos.z)) {
        // the segment ends under the ground although the terrain ray missed a bump between its samples: land the round
        // where the segment crosses the surface (bisection — not up to a whole 32 m step past the crest)
        let lo = 0, hi = segLen;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) * 0.5;
          _from.copy(s.prev).addScaledVector(_dir, mid);
          if (_from.y < world.getHeightAt(_from.x, _from.z)) hi = mid; else lo = mid;
        }
        h.point.copy(s.prev).addScaledVector(_dir, hi);
        world.getNormalAt(h.point.x, h.point.z, h.normal); h.enemy = null; h.part = undefined; h.armored = false;
        h.obstacle = false; h.obstacleRef = null; h.barrierOwner = null; h.intercept = null; h.fused = false;
        h.distance = s.travelled + hi;
        hitAny = true;
      }
      // self-detonating rockets (bazooka RMB): pop where they are
      if (!hitAny && s.fuse >= 0) {
        s.fuse -= dt;
        if (s.fuse <= 0) {
          h.point.copy(s.pos); h.normal.set(0, 1, 0); h.enemy = null; h.part = undefined; h.armored = false; h.obstacle = false; h.obstacleRef = null;
          h.barrierOwner = null; h.intercept = null; h.fused = true; h.distance = s.travelled + segLen;
          hitAny = true;
        }
      }
      if (hitAny) {
        h.dir.copy(_dir);
        h.tag = s.tag;
        h.light = s.light; h.ammoType = s.ammoType; h.reported = s.report;
        let dmg = s.damage;
        h.falloffApplied = !Number.isNaN(s.fStart);
        if (h.falloffApplied) dmg *= falloffAt(s.fStart, s.fEnd, s.fMin, h.distance);
        // the last stretch of the streak reaches the impact (a short fading tracer — one per hit)
        if (fx && (s.style === 'slug' || s.style === 'bullet')) {
          this.visualAt(s, Math.max(0, s.travelled + segLen - this.streakLen(s)), s.prev, _tail);
          _head.copy(h.point);
          fx.tracers.add(_tail, _head, s.color, this.widthFor(s, _head), 0.05, 0);
        }
        const id = s.weaponId, visual = s.visualOnly;
        this.kill(s);
        if (visual) this.onVisualHit?.(h, id);
        else this.onHit(h, dmg, id);
        continue;
      }
      s.travelled += segLen;
      if (s.style === 'rocket') {
        if (fx) { ParticleBurst.thruster(fx.additive, s.prev, s.vel, 2, 1.0); ParticleBurst.smoke(fx.alpha, s.prev, 1, 0.25, 0x6a6a6a); }
      } else if (s.style === 'shuriken') {
        if (fx) fx.tracers.add(s.prev, s.pos, s.color, 0.03, 0.05, 0);
      }
      this.place(s, dt);
    }
    this.drawStreaks();
  }

  /**
   * Sweep this step's segment (`prev` along `_dir`, `segLen`). Breakable panes are broken (local) / skipped (visual) and
   * the sweep continues behind them. Fills `this.hit` (incl. `distance` from the launch) and returns true on a stop.
   */
  private sweepStep(s: Slug, segLen: number): boolean {
    const out = this.sweepHit, h = this.hit;
    _from.copy(s.prev);
    let advanced = 0;
    for (let pane = 0; pane <= MAX_PANES_PER_STEP; pane++) {
      const remaining = segLen - advanced;
      if (remaining <= 1e-4) return false;
      this.sweep(_from, _dir, remaining, out);
      if (!out.valid) return false;
      const o = out.obstacleRef;
      if (o && o.fragile && !out.enemy && !out.intercept && !out.barrierOwner && pane < MAX_PANES_PER_STEP) {
        // 2026-09-11 창문 규칙: 총알은 유리를 깨고 지나간다 (world makes the pane ray-transparent at once)
        if (!s.visualOnly) o.destructible?.onDamage(s.damage, out.point);
        const skip = out.distance + PANE_SKIP;
        _from.addScaledVector(_dir, skip);
        advanced += skip;
        continue;
      }
      h.point.copy(out.point); h.normal.copy(out.normal);
      h.enemy = out.enemy; h.part = out.enemy ? (out.headshot ? 'head' : 'body') : undefined; h.armored = out.armored;
      h.obstacle = out.obstacle; h.obstacleRef = out.obstacleRef; h.barrierOwner = out.barrierOwner; h.intercept = out.intercept;
      h.fused = false;
      h.distance = s.travelled + advanced + out.distance;
      return true;
    }
    return false;
  }

  /** Move a styled body / spin a star after a step (streaks are drawn in one batch afterwards). */
  private place(s: Slug, dt: number): void {
    if (!s.body) return;
    this.orient(s);
    if (s.style === 'shuriken') { s.spin += dt * 40; s.body.styled.shuriken.rotation.y = s.spin; }
  }

  private streakLen(s: Slug): number {
    return Math.min(STREAK_MAX, Math.max(STREAK_MIN, s.vel.length() * STREAK_TIME));
  }

  /** Visual position `along` metres into the flight, approximated from `base` (a point on the path) + the muzzle offset fade. */
  private visualAt(s: Slug, along: number, base: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.copy(base);
    if (s.hasVisOff) {
      const f = 1 - along / VIS_CONVERGE_M;
      if (f > 0) out.addScaledVector(s.visOff, f);
    }
    return out;
  }

  private widthFor(s: Slug, at: THREE.Vector3): number {
    const cam = this.ctx.camera;
    const d = cam ? cam.position.distanceTo(at) : 0;
    return s.width * Math.min(STREAK_WIDEN_MAX, Math.max(1, d / STREAK_WIDEN_FROM));
  }

  /** Write every live bullet streak into the instanced batch (≤ `STREAK_CAP`). */
  private drawStreaks(): void {
    const mesh = this.streaks;
    let n = 0;
    for (let i = 0; i < this.live.length && n < STREAK_CAP; i++) {
      const s = this.live[i];
      if (s.style !== 'slug' && s.style !== 'bullet') continue;
      if (s.travelled <= 1e-3) continue;
      const len = Math.min(this.streakLen(s), s.travelled);
      _sdir.copy(s.vel);
      const sp = _sdir.length();
      if (sp < 1e-4) continue;
      _sdir.divideScalar(sp);
      this.visualAt(s, s.travelled, s.pos, _head);
      _tail.copy(s.pos).addScaledVector(_sdir, -len);
      this.visualAt(s, s.travelled - len, _tail, _tail);
      _mid.addVectors(_head, _tail).multiplyScalar(0.5);
      _sdir.subVectors(_head, _tail);
      const l = _sdir.length();
      if (l < 1e-4) continue;
      _sdir.divideScalar(l);
      _q.setFromUnitVectors(_zAxis, _sdir);
      const w = this.widthFor(s, _head);
      _scale.set(w, w, l);
      _m.compose(_mid, _q, _scale);
      mesh.setMatrixAt(n, _m);
      _col.setHex(s.color).multiplyScalar(STREAK_GLOW);
      mesh.setColorAt(n, _col);
      n++;
    }
    mesh.count = n;
    if (n > 0 || this.streaksDrawn > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.streaksDrawn = n;
  }

  private kill(s: Slug): void {
    const i = s.slot;
    if (i < 0) return;
    const last = this.live.length - 1;
    if (i !== last) { const moved = this.live[last]; this.live[i] = moved; moved.slot = i; }
    this.live.pop();
    s.slot = -1;
    if (s.body) {
      s.body.inUse = false;
      s.body.group.visible = false;
      s.body = null;
    }
    this.free.push(s);
  }

  clear(): void {
    while (this.live.length > 0) this.kill(this.live[this.live.length - 1]);
    this.drawStreaks();
  }

  dispose(): void {
    this.clear();
    this.streakGeo.dispose(); this.streakMat.dispose(); this.streaks.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.group.removeFromParent();
  }
}
