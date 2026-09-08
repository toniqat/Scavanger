import * as THREE from 'three';
import { GRAVITY, type GameContext, type EnemyRef, type Obstacle, type WeaponDef, type PeerId } from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { raycastBlockers, makeBlockInfo } from './Blocking';

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
  /** Distance travelled from the muzzle to the hit point (meters) — for damage falloff. */
  distance: number;
  /** Caller tag handed to `fire(..., { tag })` (unique weapons: 0 = LMB rocket, 1 = RMB air-burst). */
  tag: number;
  /** true when the projectile went off on its own fuse (no surface / enemy under it). */
  fused: boolean;
  /** Phase 9: the projectile stopped at an implant barrier of this owner (`WeaponSystem` bills the barrier once; the raycast is pure). */
  barrierOwner?: PeerId | 'local' | null;
}

/** Visual style of a projectile: the default glowing slug, or one of the unique-weapon bodies. */
export type ProjectileStyle = 'slug' | 'shuriken' | 'arrow' | 'rocket';

export interface ProjectileOptions {
  style?: ProjectileStyle;
  /** Gravity multiplier (default 0.15 = the slight drop of a bullet; 0 = dead straight — bow / rocket). */
  gravityMul?: number;
  /** Seconds after launch when the projectile detonates by itself (bazooka RMB); undefined = never. */
  fuse?: number;
  /** Opaque number handed back in `ProjectileHit.tag`. */
  tag?: number;
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

interface Slug {
  active: boolean;
  pos: THREE.Vector3; vel: THREE.Vector3; prev: THREE.Vector3;
  life: number; damage: number; color: number; weaponId: string;
  travelled: number;
  /** Replica of a remote player's shot: impact FX only, never damage (routed to `onVisualHit`). */
  visualOnly: boolean;
  style: ProjectileStyle;
  gravityMul: number;
  fuse: number;
  tag: number;
  spin: number;
  mesh: THREE.Mesh;
  /** Unique-weapon bodies (shuriken star / arrow / rocket), oriented along the velocity. */
  body: THREE.Group;
  styled: Record<Exclude<ProjectileStyle, 'slug'>, THREE.Object3D>;
}

const MAX = 48;
const DEFAULT_GRAVITY_MUL = 0.15;
const _dir = new THREE.Vector3(), _block = new THREE.Vector3(), _look = new THREE.Vector3();
const _blockInfo = makeBlockInfo();

/**
 * Pooled travelling projectiles for weapons with `projectileSpeed`. Each step is swept with
 * world + enemy raycasts so fast projectiles never tunnel. Unique weapons pick a body style (spinning
 * shuriken star, straight arrow, rocket with an exhaust trail) and may fly without drop or with a fuse.
 */
export class ProjectilePool {
  readonly group = new THREE.Group();
  private readonly pool: Slug[] = [];
  private readonly geo = new THREE.SphereGeometry(0.06, 8, 6);
  private readonly mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  /* shared unique-body resources (one geometry / material set for the whole pool) */
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly hit: ProjectileHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), enemy: null, part: undefined, obstacle: false, dir: new THREE.Vector3(), distance: 0, tag: 0, fused: false };

  /**
   * @param onHit       damage-dealing hit (local shots)
   * @param onVisualHit impact FX only, for `visualOnly` replicas of remote shots (optional)
   */
  constructor(
    private readonly ctx: GameContext,
    private readonly onHit: (h: ProjectileHit, damage: number, weaponId: string) => void,
    private readonly onVisualHit?: (h: ProjectileHit, weaponId: string) => void,
  ) {
    this.group.name = 'Projectiles';
    const mSteel = this.sharedMat(0xc9d2dc, 0.9, 0.35);
    const mDark = this.sharedMat(0x1c2026, 0.6, 0.6);
    const mShaft = this.sharedMat(0x8a6a3c, 0.1, 0.8);
    const mFletch = this.sharedMat(0xe8e2d0, 0.0, 0.9);
    const mRocket = this.sharedMat(0x5a6470, 0.8, 0.45);
    const mWarhead = this.sharedMat(0xc44a2a, 0.5, 0.5);
    const mGlow = new THREE.MeshBasicMaterial({ color: 0xffa040, toneMapped: false }); this.mats.push(mGlow);
    const gStarBlade = this.sharedGeo(new THREE.BoxGeometry(0.26, 0.012, 0.05));
    const gStarHub = this.sharedGeo(new THREE.CylinderGeometry(0.045, 0.045, 0.014, 8));
    const gShaft = this.sharedGeo(new THREE.CylinderGeometry(0.008, 0.008, 0.72, 6));
    const gHead = this.sharedGeo(new THREE.ConeGeometry(0.02, 0.09, 6));
    const gFletch = this.sharedGeo(new THREE.BoxGeometry(0.004, 0.05, 0.09));
    const gTube = this.sharedGeo(new THREE.CylinderGeometry(0.055, 0.055, 0.46, 10));
    const gNose = this.sharedGeo(new THREE.ConeGeometry(0.055, 0.14, 10));
    const gFin = this.sharedGeo(new THREE.BoxGeometry(0.006, 0.09, 0.1));
    const gExhaust = this.sharedGeo(new THREE.CylinderGeometry(0.035, 0.02, 0.08, 8));

    for (let i = 0; i < MAX; i++) {
      const mesh = new THREE.Mesh(this.geo, this.mat.clone());
      mesh.visible = false;
      this.group.add(mesh);
      const body = new THREE.Group();
      body.visible = false;
      this.group.add(body);
      // shuriken: four-point star lying in the local XZ plane (spins about local Y)
      const star = new THREE.Group();
      const b1 = new THREE.Mesh(gStarBlade, mSteel);
      const b2 = new THREE.Mesh(gStarBlade, mSteel); b2.rotation.y = Math.PI / 2;
      const hub = new THREE.Mesh(gStarHub, mDark);
      star.add(b1, b2, hub);
      // arrow: shaft along +Z (the group looks down its velocity), head in front, fletching behind
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(gShaft, mShaft); shaft.rotation.x = Math.PI / 2;
      const head = new THREE.Mesh(gHead, mSteel); head.rotation.x = Math.PI / 2; head.position.z = 0.4;
      const f1 = new THREE.Mesh(gFletch, mFletch); f1.position.z = -0.3;
      const f2 = new THREE.Mesh(gFletch, mFletch); f2.position.z = -0.3; f2.rotation.z = Math.PI / 2;
      arrow.add(shaft, head, f1, f2);
      // rocket: tube + warhead nose + four fins + glowing exhaust cup
      const rocket = new THREE.Group();
      const tube = new THREE.Mesh(gTube, mRocket); tube.rotation.x = Math.PI / 2;
      const nose = new THREE.Mesh(gNose, mWarhead); nose.rotation.x = Math.PI / 2; nose.position.z = 0.3;
      const exhaust = new THREE.Mesh(gExhaust, mGlow); exhaust.rotation.x = -Math.PI / 2; exhaust.position.z = -0.26;
      rocket.add(tube, nose, exhaust);
      for (let k = 0; k < 4; k++) {
        const fin = new THREE.Mesh(gFin, mDark);
        fin.position.set(0, 0.075, -0.18);
        fin.rotation.z = (Math.PI / 2) * k;
        fin.position.applyAxisAngle(new THREE.Vector3(0, 0, 1), (Math.PI / 2) * k);
        rocket.add(fin);
      }
      star.visible = arrow.visible = rocket.visible = false;
      body.add(star, arrow, rocket);
      this.pool.push({
        active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), prev: new THREE.Vector3(), life: 0, damage: 0, color: 0xffffff,
        weaponId: '', travelled: 0, visualOnly: false, style: 'slug', gravityMul: DEFAULT_GRAVITY_MUL, fuse: -1, tag: 0, spin: 0,
        mesh, body, styled: { shuriken: star, arrow, rocket },
      });
    }
    ctx.scene.add(this.group);
  }

  private sharedMat(color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    this.mats.push(m);
    return m;
  }
  private sharedGeo<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g; }

  fire(origin: THREE.Vector3, dir: THREE.Vector3, speed: number, damage: number, range: number, color: number, weaponId: string, visualOnly = false, opts?: ProjectileOptions): void {
    let s = this.pool.find((x) => !x.active);
    if (!s) s = this.pool[0];
    // Phase 12 총알 추적: a local launch is reported along its initial line with no impact yet (the impact follows
    // from `WeaponSystem.onProjectileHit`); visual-only replicas of other players' shots are the shooter's to report.
    if (!visualOnly) this.ctx.enemies?.reportShot(origin, dir, range, null);
    s.active = true;
    s.pos.copy(origin); s.prev.copy(origin);
    s.vel.copy(dir).multiplyScalar(speed);
    s.life = range / speed + 0.2;
    s.damage = damage; s.color = color; s.weaponId = weaponId; s.travelled = 0; s.visualOnly = visualOnly;
    s.style = opts?.style ?? 'slug';
    s.gravityMul = opts?.gravityMul ?? DEFAULT_GRAVITY_MUL;
    s.fuse = opts?.fuse ?? -1;
    s.tag = opts?.tag ?? 0;
    s.spin = 0;
    if (s.style === 'slug') {
      (s.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      s.mesh.visible = true;
      s.mesh.position.copy(origin);
      s.body.visible = false;
    } else {
      s.mesh.visible = false;
      for (const k of Object.keys(s.styled) as Array<keyof Slug['styled']>) s.styled[k].visible = k === s.style;
      s.body.visible = true;
      this.orient(s);
    }
  }

  /** Point the styled body down its velocity (+Z of the group = flight direction). */
  private orient(s: Slug): void {
    s.body.position.copy(s.pos);
    if (s.vel.lengthSq() > 1e-6) { _look.copy(s.pos).add(s.vel); s.body.lookAt(_look); }
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const ctx = this.ctx;
    const fx = FxManager.get();
    for (const s of this.pool) {
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) { this.kill(s); continue; }
      s.prev.copy(s.pos);
      s.vel.y -= GRAVITY * s.gravityMul * dt;
      s.pos.addScaledVector(s.vel, dt);
      _dir.subVectors(s.pos, s.prev);
      const segLen = _dir.length();
      if (segLen > 1e-5) {
        _dir.divideScalar(segLen);
        const eh = ctx.enemies ? ctx.enemies.raycast(s.prev, _dir, segLen) : null;
        const wh = ctx.world && ctx.world.ready ? ctx.world.raycast(s.prev, _dir, segLen) : null;
        let hitAny = false;
        const h = this.hit;
        h.fused = false; h.barrierOwner = null;
        // shields / solid deployables on the way (allied barriers ignore allied slugs — see Blocking.ts; pure query since Phase 9)
        const bd = raycastBlockers(ctx, s.prev, _dir, segLen, _block, false, _blockInfo);
        if (bd >= 0 && bd <= (eh ? eh.distance : Infinity) && bd <= (wh ? wh.distance : Infinity)) {
          h.point.copy(_block); h.normal.copy(_dir).negate(); h.enemy = null; h.part = undefined; h.armored = false; h.obstacle = true; h.obstacleRef = null; hitAny = true;
          h.barrierOwner = _blockInfo.kind === 'barrier' ? _blockInfo.owner : null;
        } else if (eh && (!wh || eh.distance <= wh.distance)) {
          h.point.copy(eh.point); h.normal.copy(eh.normal); h.enemy = eh.enemy; h.part = eh.part; h.armored = !!eh.armored; h.obstacle = false; h.obstacleRef = null; hitAny = true;
        } else if (wh) {
          h.point.copy(wh.point); h.normal.copy(wh.normal); h.enemy = null; h.part = undefined; h.obstacle = !!wh.obstacle; h.obstacleRef = wh.obstacle ?? null; hitAny = true;
        } else if (ctx.world && ctx.world.ready && s.pos.y < ctx.world.getHeightAt(s.pos.x, s.pos.z)) {
          h.point.copy(s.pos); ctx.world.getNormalAt(s.pos.x, s.pos.z, h.normal); h.enemy = null; h.part = undefined; h.obstacle = false; h.obstacleRef = null; hitAny = true;
        }
        // self-detonating rockets (bazooka RMB): pop where they are
        if (!hitAny && s.fuse >= 0) {
          s.fuse -= dt;
          if (s.fuse <= 0) {
            h.point.copy(s.pos); h.normal.set(0, 1, 0); h.enemy = null; h.part = undefined; h.armored = false; h.obstacle = false; h.obstacleRef = null; h.fused = true; hitAny = true;
          }
        }
        if (hitAny) {
          h.dir.copy(_dir);
          h.distance = s.travelled + h.point.distanceTo(s.prev);
          h.tag = s.tag;
          if (s.visualOnly) this.onVisualHit?.(h, s.weaponId);
          else this.onHit(h, s.damage, s.weaponId);
          this.kill(s);
          continue;
        }
        s.travelled += segLen;
        if (s.style === 'slug') {
          if (fx) fx.tracers.add(s.prev, s.pos, s.color, 0.06, 0.08, 0);
        } else if (s.style === 'rocket') {
          if (fx) { ParticleBurst.thruster(fx.additive, s.prev, s.vel, 2, 1.0); ParticleBurst.smoke(fx.alpha, s.prev, 1, 0.25, 0x6a6a6a); }
        } else if (s.style === 'shuriken') {
          if (fx) fx.tracers.add(s.prev, s.pos, s.color, 0.03, 0.05, 0);
        }
      }
      if (s.style === 'slug') s.mesh.position.copy(s.pos);
      else {
        this.orient(s);
        if (s.style === 'shuriken') { s.spin += dt * 40; s.styled.shuriken.rotation.y = s.spin; }
      }
    }
  }

  private kill(s: Slug): void { s.active = false; s.mesh.visible = false; s.body.visible = false; }

  clear(): void { for (const s of this.pool) this.kill(s); }

  dispose(): void {
    this.geo.dispose(); this.mat.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const s of this.pool) (s.mesh.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}
