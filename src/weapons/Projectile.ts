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
  /* ── 2026-09-14 every bullet a projectile ── */
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
  /**
   * 2026-09-14: leave a short white fading trail along the actual (curved) flight path. Default: on for `shuriken` and
   * `arrow`, off for everything else (bullets already draw a streak, rockets a smoke trail).
   */
  trail?: boolean;
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
  /** Width (m, close range) of the white flight trail; 0 = no trail. */
  trailWidth: number;
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
/**
 * 2026-09-14 flight trail (shuriken stars · arrows): one segment per integration step (`prev → pos`), so the trail bends
 * with the drop. Ring buffer of `TRAIL_CAP` segments in its own batch — never competes with the core tracer pool (96).
 * 3 stars × 60 fps × `TRAIL_LIFE` ≈ 45 live segments; the cap only overwrites the oldest (already faint) segment.
 */
const TRAIL_CAP = 1024;
/** Seconds a trail point stays visible (fades to 0 toward the tail). */
const TRAIL_LIFE = 0.25;
/** Head brightness of the white trail (additive, not tone-mapped — < 1 reads as slightly transparent white). */
const TRAIL_GLOW = 0.85;
/** Close-range trail width per style (m). Tail tapers to `TRAIL_TAPER` × width. */
const TRAIL_WIDTH_SHURIKEN = 0.07, TRAIL_WIDTH_ARROW = 0.05, TRAIL_TAPER = 0.4;
/**
 * Trails widen with camera distance from `TRAIL_WIDEN_FROM` m (× up to `TRAIL_WIDEN_MAX`) — earlier than the streaks: a
 * 0.07 m ribbon is ~2 px at 20 m (720p) and aliases into dashes; this keeps it ≈ 3–4 px out to ~80 m.
 */
const TRAIL_WIDEN_FROM = 10, TRAIL_WIDEN_MAX = 8;
/** Stride of one segment record in `trailSeg`: ax ay az bx by bz tA tB width. */
const TRAIL_STRIDE = 9;

const _dir = new THREE.Vector3(), _from = new THREE.Vector3(), _look = new THREE.Vector3();
const _head = new THREE.Vector3(), _tail = new THREE.Vector3(), _mid = new THREE.Vector3(), _sdir = new THREE.Vector3();
const _scale = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _col = new THREE.Color();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _tdir = new THREE.Vector3(), _tcam = new THREE.Vector3(), _tside = new THREE.Vector3();

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
  /* 2026-09-14 flight trails: ring buffer of segments + one camera-facing quad batch (same material setup as the core
     tracer pool → same shader program; in the scene from the start so the warm-up compiles it; no lights) */
  private readonly trails: THREE.Mesh;
  private readonly trailGeo = new THREE.BufferGeometry();
  private readonly trailMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  private readonly trailSeg = new Float64Array(TRAIL_CAP * TRAIL_STRIDE);
  private readonly trailPos = new Float32Array(TRAIL_CAP * 4 * 3);
  private readonly trailCol = new Float32Array(TRAIL_CAP * 4 * 3);
  /** Next ring slot to write. */
  private trailWrite = 0;
  /** Trail clock (s of simulated time since the last `clear`) — segment ages are measured against it. */
  private trailClock = 0;
  /** Birth time of the newest segment (−∞ = none): nothing to draw once it is older than `TRAIL_LIFE`. */
  private trailNewest = -Infinity;
  private trailsDrawn = 0;
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
    const idx = new Uint16Array(TRAIL_CAP * 6);
    for (let i = 0; i < TRAIL_CAP; i++) {
      const v = i * 4, o = i * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.trailGeo.setAttribute('color', new THREE.BufferAttribute(this.trailCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.trailGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.trailGeo.setDrawRange(0, 0);
    this.trails = new THREE.Mesh(this.trailGeo, this.trailMat);
    this.trails.name = 'ProjectileTrails';
    this.trails.frustumCulled = false;
    this.trails.castShadow = false; this.trails.receiveShadow = false;
    this.trails.renderOrder = 24;
    this.trails.matrixAutoUpdate = false;
    this.group.add(this.trails);
    for (let i = 0; i < TRAIL_CAP; i++) this.trailSeg[i * TRAIL_STRIDE + 7] = -Infinity;
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
      trailWidth: 0,
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
    // Phase 12 shot tracking: a reporting launch goes out along its initial line with no impact yet (the impact
    // follows from `WeaponSystem.onProjectileHit`); gun fire reports once per trigger pull itself
    // (`report: false`); visual-only replicas of other players' shots are the shooter's to report.
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
    const trailStyle = s.style === 'shuriken' || s.style === 'arrow';
    s.trailWidth = (opts?.trail ?? trailStyle) ? (s.style === 'arrow' ? TRAIL_WIDTH_ARROW : TRAIL_WIDTH_SHURIKEN) : 0;
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
    if (dt <= 0) { this.drawStreaks(); this.drawTrails(); return; }
    this.trailClock += dt;
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
        // the trail reaches the impact and keeps fading after the body is gone (segments outlive the slug)
        if (s.trailWidth > 0) this.pushTrail(s.prev, h.point, dt, s.trailWidth);
        const id = s.weaponId, visual = s.visualOnly;
        this.kill(s);
        if (visual) this.onVisualHit?.(h, id);
        else this.onHit(h, dmg, id);
        continue;
      }
      s.travelled += segLen;
      if (s.style === 'rocket') {
        if (fx) { ParticleBurst.thruster(fx.additive, s.prev, s.vel, 2, 1.0); ParticleBurst.smoke(fx.alpha, s.prev, 1, 0.25, 0x6a6a6a); }
      }
      if (s.trailWidth > 0) this.pushTrail(s.prev, s.pos, dt, s.trailWidth);
      this.place(s, dt);
    }
    this.drawStreaks();
    this.drawTrails();
  }

  /** Live (still visible) trail segments — smokes / debug. */
  get trailSegments(): number {
    let n = 0;
    const seg = this.trailSeg, now = this.trailClock;
    for (let i = 0; i < TRAIL_CAP; i++) if (now - seg[i * TRAIL_STRIDE + 7] < TRAIL_LIFE) n++;
    return n;
  }

  /** Record one trail segment `a → b` of this step (`a` was reached `dt` ago, `b` now). Overwrites the oldest slot. */
  private pushTrail(a: THREE.Vector3, b: THREE.Vector3, dt: number, width: number): void {
    const o = this.trailWrite * TRAIL_STRIDE, seg = this.trailSeg;
    seg[o] = a.x; seg[o + 1] = a.y; seg[o + 2] = a.z;
    seg[o + 3] = b.x; seg[o + 4] = b.y; seg[o + 5] = b.z;
    seg[o + 6] = this.trailClock - dt; seg[o + 7] = this.trailClock; seg[o + 8] = width;
    this.trailWrite = (this.trailWrite + 1) % TRAIL_CAP;
    this.trailNewest = this.trailClock;
  }

  /**
   * Rebuild the trail quads: each live segment is a camera-facing ribbon whose ends fade (brightness ∝ (1 − age/LIFE)²)
   * and taper by their own age, so consecutive steps blend into one smooth tail. Widened with camera distance.
   */
  private drawTrails(): void {
    const cam = this.ctx.camera;
    const now = this.trailClock;
    let write = 0;
    if (cam && now - this.trailNewest < TRAIL_LIFE) {
      const seg = this.trailSeg, p = this.trailPos, c = this.trailCol, cp = cam.position;
      for (let i = 0; i < TRAIL_CAP; i++) {
        const o = i * TRAIL_STRIDE;
        const fb = 1 - (now - seg[o + 7]) / TRAIL_LIFE;
        if (fb <= 0) continue;
        const fa = Math.max(0, 1 - (now - seg[o + 6]) / TRAIL_LIFE);
        _ta.set(seg[o], seg[o + 1], seg[o + 2]);
        _tb.set(seg[o + 3], seg[o + 4], seg[o + 5]);
        _tdir.subVectors(_tb, _ta);
        if (_tdir.lengthSq() < 1e-8) continue;
        _tcam.addVectors(_ta, _tb).multiplyScalar(0.5).sub(cp).negate();
        _tside.crossVectors(_tdir, _tcam);
        const sl = _tside.length();
        if (sl < 1e-6) continue;
        _tside.divideScalar(sl);
        const w = seg[o + 8];
        const wa = 0.5 * w * Math.min(TRAIL_WIDEN_MAX, Math.max(1, cp.distanceTo(_ta) / TRAIL_WIDEN_FROM)) * (TRAIL_TAPER + (1 - TRAIL_TAPER) * fa);
        const wb = 0.5 * w * Math.min(TRAIL_WIDEN_MAX, Math.max(1, cp.distanceTo(_tb) / TRAIL_WIDEN_FROM)) * (TRAIL_TAPER + (1 - TRAIL_TAPER) * fb);
        const q = write * 12;
        p[q] = _ta.x - _tside.x * wa; p[q + 1] = _ta.y - _tside.y * wa; p[q + 2] = _ta.z - _tside.z * wa;
        p[q + 3] = _ta.x + _tside.x * wa; p[q + 4] = _ta.y + _tside.y * wa; p[q + 5] = _ta.z + _tside.z * wa;
        p[q + 6] = _tb.x + _tside.x * wb; p[q + 7] = _tb.y + _tside.y * wb; p[q + 8] = _tb.z + _tside.z * wb;
        p[q + 9] = _tb.x - _tside.x * wb; p[q + 10] = _tb.y - _tside.y * wb; p[q + 11] = _tb.z - _tside.z * wb;
        const ia = TRAIL_GLOW * fa * fa, ib = TRAIL_GLOW * fb * fb;
        c[q] = c[q + 1] = c[q + 2] = ia;
        c[q + 3] = c[q + 4] = c[q + 5] = ia;
        c[q + 6] = c[q + 7] = c[q + 8] = ib;
        c[q + 9] = c[q + 10] = c[q + 11] = ib;
        write++;
      }
    }
    this.trailGeo.setDrawRange(0, write * 6);
    if (write > 0 || this.trailsDrawn > 0) {
      (this.trailGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.trailGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }
    this.trailsDrawn = write;
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
        // 2026-09-11 the window rule: a bullet breaks the glass and passes through (world makes the pane
        //   ray-transparent at once)
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
    for (let i = 0; i < TRAIL_CAP; i++) this.trailSeg[i * TRAIL_STRIDE + 7] = -Infinity;
    this.trailClock = 0; this.trailNewest = -Infinity; this.trailWrite = 0;
    this.drawTrails();
  }

  dispose(): void {
    this.clear();
    this.streakGeo.dispose(); this.streakMat.dispose(); this.streaks.dispose();
    this.trailGeo.dispose(); this.trailMat.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.group.removeFromParent();
  }
}
