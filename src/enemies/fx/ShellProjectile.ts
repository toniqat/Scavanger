import * as THREE from 'three';
import { GRAVITY, Layers, SHELL_RADIUS, type GameContext, type InterceptableRef } from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { raySphere } from '../RayTests';

const POOL = 10;
const VISUAL_RADIUS = 0.34;
/** Additive halo around the shell body (× VISUAL_RADIUS). */
const HALO_SCALE = 2.4;
const TRAIL_GAP = 0.05;

/* ── ribbon trail (2026-09-09) ────────────────────────────────────────────
 * The user wants the arc readable *while the shell flies*. Each shell drags a camera-facing ribbon through its last
 * `TRAIL_SAMPLES` positions (one sample every `TRAIL_SAMPLE_S` → ~`TRAIL_SAMPLES × TRAIL_SAMPLE_S` s of arc), additive
 * warm orange → black so the tail dissolves. Buffers are allocated once per pooled shell and rewritten in place. */
const TRAIL_SAMPLES = 44;
const TRAIL_SAMPLE_S = 0.09;
/** Half-width of the ribbon at the head / tail (m). */
const TRAIL_HALF_HEAD = 0.42;
const TRAIL_HALF_TAIL = 0.06;
const TRAIL_COLOR_HEAD = new THREE.Color(1.0, 0.72, 0.30);
const TRAIL_COLOR_MID = new THREE.Color(1.0, 0.36, 0.08);
/** Vertices / indices per ribbon: every sample plus the live head position, two verts each. */
const RIBBON_POINTS = TRAIL_SAMPLES + 1;

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
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _col = new THREE.Color();

/**
 * Closed form of the arc every shell flies (also replicated by `ui/hud/ShellMarkers` so the HUD marker sits on the
 * visible shell): `p(t) = from + vel0·t − ½·G·t²·ŷ` with `vel0 = (Δ/T) + ½·G·T·ŷ`, so `p(T) = target` exactly.
 * 2026-09-09: replaced the per-frame Euler step (which drifted from this by ~G·dt·t/2 — half a metre by the end of a
 * 6.3 s flight) so host, replica and HUD all agree to the millimetre.
 */
export function shellPositionAt(from: THREE.Vector3, vel0: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(
    from.x + vel0.x * t,
    from.y + vel0.y * t - 0.5 * GRAVITY * t * t,
    from.z + vel0.z * t,
  );
}

/** Launch velocity that reaches `target` from `from` after `T` seconds (`T` already clamped ≥ 0.5). */
export function shellLaunchVelocity(from: THREE.Vector3, target: THREE.Vector3, T: number, out: THREE.Vector3): THREE.Vector3 {
  _d.subVectors(target, from);
  return out.set(_d.x / T, _d.y / T + 0.5 * GRAVITY * T, _d.z / T);
}

class Shell implements InterceptableRef {
  id = 0;
  active = false;
  readonly mesh: THREE.Mesh;
  /** Launch point and velocity — the arc is closed-form from these (`shellPositionAt`). */
  readonly from = new THREE.Vector3();
  readonly vel0 = new THREE.Vector3();
  /** Instantaneous velocity (for callers that read it; the arc itself is analytic). */
  readonly vel = new THREE.Vector3();
  readonly prev = new THREE.Vector3();
  life = 0;
  flight = 0;
  trail = 0;
  readonly radius = SHELL_RADIUS;

  /* ribbon */
  readonly ribbon: THREE.Mesh;
  readonly ribbonGeo: THREE.BufferGeometry;
  readonly ribbonPos: THREE.BufferAttribute;
  readonly ribbonCol: THREE.BufferAttribute;
  /** Ring of the last positions (xyz), oldest → newest through `histStart`. */
  readonly hist = new Float32Array(TRAIL_SAMPLES * 3);
  histStart = 0;
  histCount = 0;
  sampleTimer = 0;

  constructor(mesh: THREE.Mesh, ribbonMat: THREE.Material, private readonly owner: ShellProjectiles) {
    this.mesh = mesh;
    this.ribbonGeo = new THREE.BufferGeometry();
    this.ribbonPos = new THREE.BufferAttribute(new Float32Array(RIBBON_POINTS * 2 * 3), 3);
    this.ribbonPos.setUsage(THREE.DynamicDrawUsage);
    this.ribbonCol = new THREE.BufferAttribute(new Float32Array(RIBBON_POINTS * 2 * 3), 3);
    this.ribbonCol.setUsage(THREE.DynamicDrawUsage);
    const idx = new Uint16Array((RIBBON_POINTS - 1) * 6);
    for (let i = 0, k = 0; i < RIBBON_POINTS - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
      idx[k++] = b; idx[k++] = d; idx[k++] = c;
    }
    this.ribbonGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.ribbonGeo.setAttribute('position', this.ribbonPos);
    this.ribbonGeo.setAttribute('color', this.ribbonCol);
    this.ribbonGeo.setDrawRange(0, 0);
    this.ribbon = new THREE.Mesh(this.ribbonGeo, ribbonMat);
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 19;
    this.ribbon.visible = false;
    this.ribbon.layers.enable(Layers.NO_RAYCAST);
  }

  get position(): THREE.Vector3 { return this.mesh.position; }

  /** Weapons call this when `raycastInterceptable` returned this shell. */
  intercept(point?: THREE.Vector3): void {
    this.owner.interceptShell(this, point ?? this.mesh.position, true);
  }

  resetTrail(): void {
    this.histStart = 0; this.histCount = 0; this.sampleTimer = 0;
    this.ribbonGeo.setDrawRange(0, 0);
    this.ribbon.visible = false;
  }

  pushSample(p: THREE.Vector3): void {
    const i = ((this.histStart + this.histCount) % TRAIL_SAMPLES) * 3;
    this.hist[i] = p.x; this.hist[i + 1] = p.y; this.hist[i + 2] = p.z;
    if (this.histCount < TRAIL_SAMPLES) this.histCount++;
    else this.histStart = (this.histStart + 1) % TRAIL_SAMPLES;
  }

  /** Sample `k` of the trail, 0 = oldest. */
  sample(k: number, out: THREE.Vector3): THREE.Vector3 {
    const i = ((this.histStart + k) % TRAIL_SAMPLES) * 3;
    return out.set(this.hist[i], this.hist[i + 1], this.hist[i + 2]);
  }

  /** Rewrite the ribbon strip from the history + live head, camera-facing. No allocation. */
  buildRibbon(cam: THREE.Camera): void {
    const n = this.histCount + 1;         // samples + live head
    if (n < 2) { this.ribbonGeo.setDrawRange(0, 0); this.ribbon.visible = false; return; }
    const pos = this.ribbonPos.array as Float32Array;
    const col = this.ribbonCol.array as Float32Array;
    for (let k = 0; k < n; k++) {
      // point k (oldest → head)
      if (k < this.histCount) this.sample(k, _p); else _p.copy(this.mesh.position);
      // tangent along the trail
      if (k + 1 < n) { if (k + 1 < this.histCount) this.sample(k + 1, _q); else _q.copy(this.mesh.position); _dir.subVectors(_q, _p); }
      else { this.sample(this.histCount - 1, _q); _dir.subVectors(_p, _q); }
      if (_dir.lengthSq() < 1e-8) _dir.copy(this.vel);
      _toCam.subVectors(cam.position, _p);
      _side.crossVectors(_dir, _toCam);
      const sl = _side.length();
      if (sl > 1e-6) _side.multiplyScalar(1 / sl); else _side.copy(_up);
      const f = k / (n - 1);                                   // 0 tail → 1 head
      const half = TRAIL_HALF_TAIL + (TRAIL_HALF_HEAD - TRAIL_HALF_TAIL) * f;
      const o = k * 6;
      pos[o] = _p.x + _side.x * half; pos[o + 1] = _p.y + _side.y * half; pos[o + 2] = _p.z + _side.z * half;
      pos[o + 3] = _p.x - _side.x * half; pos[o + 4] = _p.y - _side.y * half; pos[o + 5] = _p.z - _side.z * half;
      // colour: black tail → ember mid → bright head (additive, so black = transparent)
      const glow = f * f;
      if (f < 0.6) _col.copy(TRAIL_COLOR_MID).multiplyScalar(glow * 1.6);
      else _col.lerpColors(TRAIL_COLOR_MID, TRAIL_COLOR_HEAD, (f - 0.6) / 0.4).multiplyScalar(0.58 + glow * 0.6);
      col[o] = _col.r; col[o + 1] = _col.g; col[o + 2] = _col.b;
      col[o + 3] = _col.r; col[o + 4] = _col.g; col[o + 5] = _col.b;
    }
    this.ribbonPos.needsUpdate = true;
    this.ribbonCol.needsUpdate = true;
    this.ribbonGeo.setDrawRange(0, (n - 1) * 6);
    if (!this.ribbon.visible) this.ribbon.visible = true;
  }
}

/**
 * Pooled artillery shells (Phase 4): glowing spheres on a ballistic arc with a smoke trail, interceptable mid-air.
 * The same class renders host shells (with damage through `ShellHost`) and replica shells (visual, from `ee shell`).
 * 2026-09-09: the arc is closed-form (`shellPositionAt`), the body got a hot emissive + additive halo, and every shell
 * drags an additive **ribbon trail** through its last ~4 s of flight so the arc is readable from the ground.
 */
export class ShellProjectiles {
  private readonly shells: Shell[] = [];
  private readonly geo = new THREE.SphereGeometry(VISUAL_RADIUS, 12, 9);
  private readonly mat = new THREE.MeshStandardMaterial({ color: 0x2a1c14, emissive: 0xff5a14, emissiveIntensity: 2.2, roughness: 0.55, metalness: 0.35 });
  private readonly haloGeo = new THREE.SphereGeometry(VISUAL_RADIUS * HALO_SCALE, 10, 7);
  private readonly haloMat = new THREE.MeshBasicMaterial({ color: 0xff7a30, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
  private readonly ribbonMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(this.geo, this.mat);
      mesh.visible = false;
      mesh.layers.enable(Layers.NO_RAYCAST);
      const halo = new THREE.Mesh(this.haloGeo, this.haloMat);
      halo.layers.enable(Layers.NO_RAYCAST);
      halo.renderOrder = 20;
      mesh.add(halo);
      scene.add(mesh);
      const s = new Shell(mesh, this.ribbonMat, this);
      scene.add(s.ribbon);
      this.shells.push(s);
    }
  }

  /** Launch shell `sid` from `from` so it reaches `target` after `flightTime` seconds. Returns false when the pool is full. */
  fire(sid: number, from: THREE.Vector3, target: THREE.Vector3, flightTime: number): boolean {
    let s: Shell | null = null;
    for (const c of this.shells) if (!c.active) { s = c; break; }
    if (!s) return false;
    const T = Math.max(0.5, flightTime);
    s.from.copy(from);
    shellLaunchVelocity(from, target, T, s.vel0);
    s.vel.copy(s.vel0);
    s.mesh.position.copy(from);
    s.prev.copy(from);
    s.id = sid;
    s.life = 0;
    s.flight = T;
    s.trail = 0;
    s.resetTrail();
    s.pushSample(from);
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
    const cam = host.ctx.camera;
    const fx = FxManager.get();
    for (const s of this.shells) {
      if (!s.active) continue;
      s.life += dt;
      s.prev.copy(s.mesh.position);
      shellPositionAt(s.from, s.vel0, s.life, s.mesh.position);
      s.vel.set(s.vel0.x, s.vel0.y - GRAVITY * s.life, s.vel0.z);
      s.mesh.rotation.x += dt * 4; s.mesh.rotation.z += dt * 2.5;
      // smoke trail
      s.trail -= dt;
      if (fx && s.trail <= 0) {
        s.trail = TRAIL_GAP;
        ParticleBurst.smoke(fx.alpha, s.mesh.position, 1, 0.35, 0x3a3532);
      }
      // ribbon history
      s.sampleTimer -= dt;
      if (s.sampleTimer <= 0) { s.sampleTimer = TRAIL_SAMPLE_S; s.pushSample(s.mesh.position); }
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
        this.retire(s);
        this.landFx(s.mesh.position);
        host.onShellLanded(s.id, s.mesh.position);
        continue;
      }
      s.buildRibbon(cam);
    }
  }

  private retire(s: Shell): void {
    s.active = false; s.mesh.visible = false;
    s.resetTrail();
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
    this.retire(s);
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
    if (s) this.retire(s);
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
    for (const s of this.shells) this.retire(s);
  }

  dispose(): void {
    for (const s of this.shells) {
      this.scene.remove(s.mesh);
      this.scene.remove(s.ribbon);
      s.ribbonGeo.dispose();
    }
    this.shells.length = 0;
    this.geo.dispose();
    this.mat.dispose();
    this.haloGeo.dispose();
    this.haloMat.dispose();
    this.ribbonMat.dispose();
  }
}
