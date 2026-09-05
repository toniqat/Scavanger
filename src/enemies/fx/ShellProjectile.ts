import * as THREE from 'three';
import { GRAVITY, Layers, SHELL_RADIUS, type GameContext, type InterceptableRef } from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { raySphere } from '../RayTests';

const POOL = 10;
const VISUAL_RADIUS = 0.34;
const TRAIL_GAP = 0.05;

/** What the shells need from EnemySystem. Damage / events / wire happen in the host callbacks. */
export interface ShellHost {
  readonly ctx: GameContext;
  /** Shell reached the ground (or an obstacle). Authority applies the blast; everyone plays FX. */
  onShellLanded(sid: number, position: THREE.Vector3): void;
  /** Shell was shot down. `local` = this client's bullet did it (authority → broadcast, replica → `intq`). */
  onShellIntercepted(sid: number, position: THREE.Vector3, local: boolean): void;
}

const _d = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

class Shell implements InterceptableRef {
  id = 0;
  active = false;
  readonly mesh: THREE.Mesh;
  readonly vel = new THREE.Vector3();
  readonly prev = new THREE.Vector3();
  life = 0;
  flight = 0;
  trail = 0;
  readonly radius = SHELL_RADIUS;

  constructor(mesh: THREE.Mesh, private readonly owner: ShellProjectiles) { this.mesh = mesh; }

  get position(): THREE.Vector3 { return this.mesh.position; }

  /** Weapons call this when `raycastInterceptable` returned this shell. */
  intercept(point?: THREE.Vector3): void {
    this.owner.interceptShell(this, point ?? this.mesh.position, true);
  }
}

/**
 * Pooled artillery shells (Phase 4): dark spheres on a ballistic arc with a smoke trail, interceptable mid-air.
 * The same class renders host shells (with damage through `ShellHost`) and replica shells (visual, from `ee shell`).
 */
export class ShellProjectiles {
  private readonly shells: Shell[] = [];
  private readonly geo = new THREE.SphereGeometry(VISUAL_RADIUS, 12, 9);
  private readonly mat = new THREE.MeshStandardMaterial({ color: 0x1c1a18, emissive: 0x6a1a08, emissiveIntensity: 0.9, roughness: 0.55, metalness: 0.35 });

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(this.geo, this.mat);
      mesh.visible = false;
      mesh.layers.enable(Layers.NO_RAYCAST);
      scene.add(mesh);
      this.shells.push(new Shell(mesh, this));
    }
  }

  /** Launch shell `sid` from `from` so it reaches `target` after `flightTime` seconds. Returns false when the pool is full. */
  fire(sid: number, from: THREE.Vector3, target: THREE.Vector3, flightTime: number): boolean {
    let s: Shell | null = null;
    for (const c of this.shells) if (!c.active) { s = c; break; }
    if (!s) return false;
    const T = Math.max(0.5, flightTime);
    _d.subVectors(target, from);
    s.vel.set(_d.x / T, _d.y / T + 0.5 * GRAVITY * T, _d.z / T);
    s.mesh.position.copy(from);
    s.prev.copy(from);
    s.id = sid;
    s.life = 0;
    s.flight = T;
    s.trail = 0;
    s.active = true;
    s.mesh.visible = true;
    return true;
  }

  find(sid: number): Shell | null {
    for (const s of this.shells) if (s.active && s.id === sid) return s;
    return null;
  }

  /** Live shells (for HUD / debugging). */
  count(): number { let n = 0; for (const s of this.shells) if (s.active) n++; return n; }

  update(dt: number, host: ShellHost): void {
    const world = host.ctx.world;
    const fx = FxManager.get();
    for (const s of this.shells) {
      if (!s.active) continue;
      s.life += dt;
      s.prev.copy(s.mesh.position);
      s.vel.y -= GRAVITY * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += dt * 4; s.mesh.rotation.z += dt * 2.5;
      // smoke trail
      s.trail -= dt;
      if (fx && s.trail <= 0) {
        s.trail = TRAIL_GAP;
        ParticleBurst.smoke(fx.alpha, s.mesh.position, 1, 0.35, 0x3a3532);
      }
      let landed = false;
      if (world) {
        _d.subVectors(s.mesh.position, s.prev);
        const len = _d.length();
        if (len > 1e-4) {
          _d.multiplyScalar(1 / len);
          const hit = world.raycast(s.prev, _d, len + VISUAL_RADIUS);
          if (hit) { s.mesh.position.copy(hit.point); landed = true; }
        }
        if (!landed && s.life > 0.3 && s.mesh.position.y <= world.getHeightAt(s.mesh.position.x, s.mesh.position.z) + VISUAL_RADIUS * 0.5) landed = true;
        if (!landed && !world.isInsideBounds(s.mesh.position.x, s.mesh.position.z)) landed = true;
      }
      if (!landed && s.life > s.flight + 2.5) landed = true;
      if (landed) {
        s.active = false; s.mesh.visible = false;
        this.landFx(s.mesh.position);
        host.onShellLanded(s.id, s.mesh.position);
      }
    }
  }

  /** Nearest shell along the ray (sphere test with SHELL_RADIUS). */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { target: InterceptableRef; point: THREE.Vector3; distance: number } | null {
    let best: Shell | null = null;
    let bestT = maxDist;
    for (const s of this.shells) {
      if (!s.active) continue;
      const t = raySphere(origin, dir, s.mesh.position, SHELL_RADIUS);
      if (t >= 0 && t < bestT) { best = s; bestT = t; }
    }
    if (!best) return null;
    return { target: best, point: new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT), distance: bestT };
  }

  /** Pop a shell mid-air. `local` = our own bullet (host: broadcast; replica: ask the host). */
  interceptShell(s: Shell, point: THREE.Vector3, local: boolean, host?: ShellHost): void {
    if (!s.active) return;
    s.active = false; s.mesh.visible = false;
    this.popFx(s.mesh.position);
    (host ?? this.host)?.onShellIntercepted(s.id, point, local);
  }

  /** Intercept by host id (replica `ee intercept` / host `intq`). */
  interceptById(sid: number, point: THREE.Vector3, local: boolean): boolean {
    const s = this.find(sid);
    if (!s) return false;
    this.interceptShell(s, point, local);
    return true;
  }

  /** Remove a shell without FX/callbacks (replica received `shellHit` for it). */
  landById(sid: number, at: THREE.Vector3): void {
    const s = this.find(sid);
    if (s) { s.active = false; s.mesh.visible = false; }
    this.landFx(at);
  }

  private host: ShellHost | null = null;
  bind(host: ShellHost): void { this.host = host; }

  private popFx(p: THREE.Vector3): void {
    const fx = FxManager.get();
    if (!fx) return;
    ParticleBurst.sparks(fx.additive, p, _up, 18, 9, 0xffa040);
    ParticleBurst.smoke(fx.alpha, p, 14, 1.2, 0x2c2826);
    ParticleBurst.fireball(fx.additive, p, 16, 5, 0.8);
    fx.flashes.flash(p, 0xffb060, 0, 2.4, 0.08);
  }

  private landFx(p: THREE.Vector3): void {
    const fx = FxManager.get();
    if (!fx) return;
    ParticleBurst.groundBlast(fx.alpha, p, 70, 14, 0x6e6252, 0.5);
    ParticleBurst.fireball(fx.additive, p, 50, 8, 1.4);
    ParticleBurst.smoke(fx.alpha, p, 30, 2.2, 0x2a2622);
    fx.flashes.flash(p, 0xffc070, 0, 5, 0.12);
  }

  clear(): void {
    for (const s of this.shells) { s.active = false; s.mesh.visible = false; }
  }

  dispose(): void {
    for (const s of this.shells) this.scene.remove(s.mesh);
    this.shells.length = 0;
    this.geo.dispose();
    this.mat.dispose();
  }
}
