import * as THREE from 'three';
import { GRAVITY, Layers, ROGUE_GRENADE_RADIUS, breakFragileAlong, type GameContext, type GrenadeView } from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';

/* ────────────────────────────────────────────────────────────────────────────
 * Rogue grenades (Phase 7, rogue AI v2): pooled small spheres on a ballistic arc with one bounce and a fuse.
 * The same class renders the host's grenades (the blast is resolved by `GrenadeHost.onGrenadeExploded(p, true)`) and
 * the replicas' visual copies from `ee grenade` (`onGrenadeExploded(p, false)` = FX only). A host `grenadeHit` that
 * arrives while the local copy still flies pops it in place (`explodeNear`), so the explosion is never shown twice.
 * ──────────────────────────────────────────────────────────────────────────── */

const POOL = 8;
const VISUAL_RADIUS = 0.11;
/** Velocity kept after the bounce (along the normal) / on the tangent part — a grenade should stay near where it lands. */
const RESTITUTION = 0.3;
const FRICTION = 0.3;
/** Tangent velocity kept per later contact (rolling), and the speed below which the grenade rests. */
const ROLL_DAMP = 0.5;
const REST_SPEED = 0.8;
/** Distance inside which a host `grenadeHit` claims a still-flying local copy. */
const MATCH_RADIUS = 4;

/** What the grenades need from EnemySystem. */
export interface GrenadeHost {
  readonly ctx: GameContext;
  /** Fuse ran out at `position`. `authority` = this client resolves the damage; everyone plays FX / shake / audio. `owner` = throwing rogue's id (0 = unknown). */
  onGrenadeExploded(position: THREE.Vector3, authority: boolean, owner: number): void;
}

interface Grenade {
  active: boolean;
  /** Throwing rogue's id (matching / debug). */
  owner: number;
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  prev: THREE.Vector3;
  fuse: number;
  life: number;
  bounced: boolean;
  resting: boolean;
  /** true for a host grenade (damage), false for a replica visual. */
  authority: boolean;
  spin: number;
}

const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class RogueGrenades {
  private readonly items: Grenade[] = [];
  /* HUD 위험 인디케이터용 view (풀 몸체당 하나 재사용) — `getViews()` 참고. */
  private readonly views: ({ position: THREE.Vector3; fuse: number; remote: boolean } | undefined)[] = [];
  private readonly viewList: GrenadeView[] = [];
  private readonly geo = new THREE.SphereGeometry(VISUAL_RADIUS, 10, 8);
  private readonly mat = new THREE.MeshStandardMaterial({ color: 0x2a2e26, emissive: 0xc83a1a, emissiveIntensity: 0.9, roughness: 0.5, metalness: 0.4 });
  private host: GrenadeHost | null = null;

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(this.geo, this.mat);
      mesh.visible = false;
      mesh.castShadow = true;
      mesh.layers.enable(Layers.NO_RAYCAST);
      scene.add(mesh);
      this.items.push({ active: false, owner: 0, mesh, vel: new THREE.Vector3(), prev: new THREE.Vector3(), fuse: 0, life: 0, bounced: false, resting: false, authority: false, spin: 0 });
    }
  }

  bind(host: GrenadeHost): void { this.host = host; }

  /** Launch from `from` with velocity `vel`; explodes after `fuse` s. Returns false when the pool is full. */
  throw(owner: number, from: THREE.Vector3, vel: THREE.Vector3, fuse: number, authority: boolean): boolean {
    let g: Grenade | null = null;
    for (const c of this.items) if (!c.active) { g = c; break; }
    if (!g) return false;
    g.active = true; g.owner = owner; g.authority = authority;
    g.mesh.position.copy(from); g.prev.copy(from);
    g.vel.copy(vel);
    g.fuse = Math.max(0.2, fuse);
    g.life = 0; g.bounced = false; g.resting = false; g.spin = 1;
    g.mesh.visible = true;
    return true;
  }

  /** Live grenades. */
  count(): number { let n = 0; for (const g of this.items) if (g.active) n++; return n; }

  /**
   * 2026-09-10: HUD 위험 인디케이터가 읽는 목록 (`EnemyManagerRef.getEnemyGrenades()`). 아군 수류탄의
   * `weapons/Grenade.getViews()` 와 **같은 모양 · 같은 규약**이다 — 풀 몸체 하나당 view 객체 하나를 재사용하고
   * `position` 은 살아 있는 동안 같은 `Vector3` 인스턴스(`mesh.position`)다. `remote` 는 이 클라이언트에
   * 권한이 없는 복제본이라는 뜻으로 쓴다 (`!authority`).
   */
  getViews(): readonly GrenadeView[] {
    this.viewList.length = 0;
    for (let i = 0; i < this.items.length; i++) {
      const g = this.items[i];
      if (!g.active) continue;
      let v = this.views[i];
      if (!v) { v = { position: g.mesh.position, fuse: 0, remote: false }; this.views[i] = v; }
      v.fuse = g.fuse; v.remote = !g.authority;
      this.viewList.push(v);
    }
    return this.viewList;
  }

  /** Host migration: grenades in flight switch sides (demoted → visual only, promoted → they now hurt). */
  setAuthorityAll(authority: boolean): void { for (const g of this.items) g.authority = authority; }

  /** Position of the first live grenade thrown by `owner` (debug / smoke), or null. */
  findByOwner(owner: number): THREE.Vector3 | null {
    for (const g of this.items) if (g.active && g.owner === owner) return g.mesh.position;
    return null;
  }

  /**
   * Velocity that carries a grenade from `from` to `target` in `flight` seconds (gravity `GRAVITY`).
   * Writes into `out`.
   */
  static launchVelocity(from: THREE.Vector3, target: THREE.Vector3, flight: number, out: THREE.Vector3): THREE.Vector3 {
    const T = Math.max(0.4, flight);
    return out.set((target.x - from.x) / T, (target.y - from.y) / T + 0.5 * GRAVITY * T, (target.z - from.z) / T);
  }

  update(dt: number): void {
    const host = this.host;
    const world = host?.ctx.world ?? null;
    for (const g of this.items) {
      if (!g.active) continue;
      g.life += dt;
      g.fuse -= dt;
      if (g.fuse <= 0) { this.explode(g); continue; }
      if (g.resting) continue;
      g.prev.copy(g.mesh.position);
      g.vel.y -= GRAVITY * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      g.mesh.rotation.x += dt * 9 * g.spin; g.mesh.rotation.z += dt * 5 * g.spin;
      if (!world) continue;
      const p = g.mesh.position;
      // contact: obstacles / terrain along the step, then the height field under the sphere
      let hit = false;
      _d.subVectors(p, g.prev);
      const len = _d.length();
      if (len > 1e-4) {
        _d.multiplyScalar(1 / len);
        // 2026-09-11: 창문 유리는 튕기지 않고 깨고 지나간다 (깨진 창틀은 레이가 무시한다)
        breakFragileAlong(world, g.prev, p);
        const wh = world.raycast(g.prev, _d, len + VISUAL_RADIUS);
        if (wh) { p.copy(wh.point).addScaledVector(wh.normal, VISUAL_RADIUS); _n.copy(wh.normal); hit = true; }
      }
      if (!hit) {
        const ground = world.getHeightAt(p.x, p.z);
        if (p.y <= ground + VISUAL_RADIUS) { p.y = ground + VISUAL_RADIUS; world.getNormalAt(p.x, p.z, _n); hit = true; }
      }
      if (!world.isInsideBounds(p.x, p.z)) { g.vel.set(0, 0, 0); g.resting = true; continue; }
      if (!hit) continue;
      if (_n.lengthSq() < 0.5) _n.copy(_up);
      if (!g.bounced) {
        // one bounce: reflect around the surface normal, damp
        g.bounced = true;
        const vn = g.vel.dot(_n);
        g.vel.addScaledVector(_n, -vn);               // tangent part
        g.vel.multiplyScalar(FRICTION);
        g.vel.addScaledVector(_n, Math.abs(vn) * RESTITUTION);
        g.spin = 0.5;
      } else {
        // second contact: slide / roll, then rest
        const vn = g.vel.dot(_n);
        if (vn < 0) g.vel.addScaledVector(_n, -vn);
        g.vel.multiplyScalar(ROLL_DAMP);
        if (g.vel.lengthSq() < REST_SPEED * REST_SPEED) { g.vel.set(0, 0, 0); g.resting = true; }
      }
    }
  }

  /** A host `grenadeHit` at `p`: pop the nearest still-flying local copy (no damage), else just the FX. */
  explodeNear(p: THREE.Vector3): void {
    let best: Grenade | null = null;
    let bestD = MATCH_RADIUS * MATCH_RADIUS;
    for (const g of this.items) {
      if (!g.active) continue;
      const d = g.mesh.position.distanceToSquared(p);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best) { best.mesh.position.copy(p); this.explode(best); }
    else { this.blastFx(p); this.host?.onGrenadeExploded(p, false, 0); }
  }

  private explode(g: Grenade): void {
    g.active = false; g.mesh.visible = false;
    const p = g.mesh.position;
    this.blastFx(p);
    this.host?.onGrenadeExploded(p, g.authority, g.owner);
  }

  private blastFx(p: THREE.Vector3): void {
    const fx = FxManager.get();
    if (!fx) return;
    ParticleBurst.fireball(fx.additive, p, 34, 6, 1.1);
    ParticleBurst.sparks(fx.additive, p, _up, 26, 8, 0xffb060);
    ParticleBurst.groundBlast(fx.alpha, p, 40, ROGUE_GRENADE_RADIUS * 1.6, 0x5c5248, 0.45);
    ParticleBurst.smoke(fx.alpha, p, 22, 1.8, 0x2a2622);
    fx.flashes.flash(p, 0xffc070, 0, 4, 0.1);
  }

  clear(): void {
    for (const g of this.items) { g.active = false; g.mesh.visible = false; }
  }

  dispose(): void {
    for (const g of this.items) this.scene.remove(g.mesh);
    this.items.length = 0;
    this.geo.dispose();
    this.mat.dispose();
  }
}
