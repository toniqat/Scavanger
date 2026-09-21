import * as THREE from 'three';
import type { PlanetDef } from '@/shared';
import { PLANET_HOLOGRAM_PX, PLANET_HOLOGRAM_SPIN, PLANET_HOLOGRAM_TILT, PLANET_SWAP_TIME } from '@/shared';
import { Planet } from '../interiors/Starfield';

/** Device pixel ratio cap (the canvas is small; anti-aliasing does the rest). Same rule as `player/Portraits`. */
const MAX_DPR = 1.5;
/** Sphere radius in the hologram scene and the camera distance that frames it with a little air. */
const R = 1;
const CAM_FOV = 30;
const CAM_DIST = 5;
/** How far a swapping sphere slides sideways (scene units) — the new one comes in, the old one leaves. */
const SLIDE = 2.6;
/** Wire cage / ring look. */
const CAGE_SCALE = 1.14;
const RING_R = 1.62;
const RING_TILT = 1.18;

interface Slot {
  planet: Planet;
  cage: THREE.LineSegments;
  cageMat: THREE.LineBasicMaterial;
  group: THREE.Group;
  def: PlanetDef;
}

/**
 * The lock-on cutscene (2026-09-14, the intel broker): the hologram
 * spins and then **locks on to one coordinate**. All of it is procedural geometry and **it adds not one light**
 * (CLAUDE.md 「Never change the point-light count at runtime」 — this is its own scene, but it keeps the rule all the
 * same: the only thing turned on and off is opacity).
 */
interface LockOn {
  group: THREE.Group;
  rings: THREE.Mesh[];
  ringMats: THREE.MeshBasicMaterial[];
  marker: THREE.Mesh;
  markerMat: THREE.MeshBasicMaterial;
  cross: THREE.LineSegments;
  crossMat: THREE.LineBasicMaterial;
  junk: Array<THREE.BufferGeometry | THREE.Material>;
  /** Target direction on the surface (a unit vector, local to the tilt frame). */
  dir: THREE.Vector3;
  u: number;
  v: number;
  t: number;
  dur: number;
  fired: boolean;
  onDone: (() => void) | null;
}

/** Distance the lock-on rings start out at (multiples of the sphere radius R). */
const LOCK_RING_START = 3.2;
const LOCK_RING_END = 1.06;

/**
 * The planet hologram (Phase 11): the spinning planet at the centre of the full-screen ship terminal.
 *
 * Like `player/Portraits` it owns its **own** `THREE.WebGLRenderer` + `Scene` + camera + lights, because
 * `core/Engine` renders the world through an `EffectComposer` at the end of the frame and offers no post-render
 * hook — a widget can never share the main canvas. Everything is procedural geometry: the sphere + atmosphere shell
 * are the hub's own `Planet` class (in the def's `hologram` / `hologramAtmo` colours), wrapped in an icosahedron
 * **wire cage**, two thin **rings** and a **scanline** grid, all additive so it reads as a projection.
 *
 * `setPlanet(def, dir)` cross-slides over `PLANET_SWAP_TIME`; `render` returns immediately while the terminal is
 * closed (`setVisible(false)`), so a closed terminal costs nothing.
 */
class Hologram {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  /** The planet on screen, and the one sliding out during a swap. */
  private cur: Slot | null = null;
  private out: Slot | null = null;
  /** 0..1 progress of the running swap (1 = settled) and which way the new sphere came from (+1 = from the right). */
  private swapT = 1;
  private swapDir = 1;
  private readonly rings: THREE.Group;
  /** Ring / scanline geometries + materials, disposed together. */
  private readonly ringMats: Array<THREE.BufferGeometry | THREE.Material> = [];
  private readonly scan: THREE.LineSegments;
  private readonly scanMat: THREE.LineBasicMaterial;
  private visible = false;
  private disposed = false;
  private lastW = 0;
  private lastH = 0;
  private spin = 0;
  /** Lock-on (2026-09-14, the intel broker). null = it spins as usual. */
  private lock: LockOn | null = null;

  constructor(host: HTMLElement, renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    host.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.1, 40);
    this.camera.position.set(0, 0.35, CAM_DIST);
    this.camera.lookAt(0, 0, 0);

    // key + rim + ambient: the planet must have a terminator, or it reads as a flat disc
    const key = new THREE.DirectionalLight(0xfff3dd, 2.4);
    key.position.set(3.2, 2.0, 3.4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.9);
    rim.position.set(-3.4, 0.6, -1.8);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0x9fd4ff, 0x101820, 0.55));

    // two thin rings around the projection (procedural torus, additive)
    this.rings = new THREE.Group();
    this.rings.rotation.x = RING_TILT;
    for (let i = 0; i < 2; i++) {
      const g = new THREE.TorusGeometry(RING_R + i * 0.22, 0.006 + i * 0.002, 6, 96);
      const m = new THREE.MeshBasicMaterial({ color: 0x5fd7ff, transparent: true, opacity: i === 0 ? 0.5 : 0.24, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(g, m);
      mesh.rotation.z = i * 0.5;
      this.rings.add(mesh);
      this.ringMats.push(g, m);
    }
    this.scene.add(this.rings);

    // scanlines: horizontal segments across the projection volume, drawn in front of the sphere
    const rows = 26, half = 2.0;
    const sp = new Float32Array(rows * 6);
    for (let i = 0; i < rows; i++) {
      const y = -half + (i / (rows - 1)) * half * 2;
      const o = i * 6;
      sp[o] = -half; sp[o + 1] = y; sp[o + 2] = 2.1;
      sp[o + 3] = half; sp[o + 4] = y; sp[o + 5] = 2.1;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.scanMat = new THREE.LineBasicMaterial({ color: 0x5fd7ff, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false });
    this.scan = new THREE.LineSegments(sg, this.scanMat);
    this.scan.frustumCulled = false;
    this.scene.add(this.scan);
    this.ringMats.push(sg);
  }

  /** Build one planet + its wire cage. */
  private makeSlot(def: PlanetDef): Slot {
    const group = new THREE.Group();
    const planet = new Planet(R, def.hologram, def.hologramAtmo, PLANET_HOLOGRAM_SPIN, 0.3);
    group.add(planet.group);
    const cg = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(R * CAGE_SCALE, 2));
    const cageMat = new THREE.LineBasicMaterial({ color: def.hologramAtmo, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false });
    const cage = new THREE.LineSegments(cg, cageMat);
    group.add(cage);
    group.rotation.x = -PLANET_HOLOGRAM_TILT;
    this.scene.add(group);
    return { planet, cage, cageMat, group, def };
  }

  private freeSlot(s: Slot | null): void {
    if (!s) return;
    s.planet.dispose();
    s.cage.geometry.dispose();
    s.cageMat.dispose();
    s.cage.removeFromParent();
    s.group.removeFromParent();
  }

  /** Currently displayed planet id (the one the label reads), or null before the first `setPlanet`. */
  get planetId(): string | null { return this.cur?.def.id ?? null; }

  /* ── lock-on (2026-09-14, the intel broker) ───────────────────────────────── */

  /**
   * Moves the canvas into another panel, so the intel broker's screen can **borrow** the terminal's hologram —
   * making a second `WebGLRenderer` costs one more context and makes it likelier that `createPlanetHologram`
   * returns null. The next `render` measures again against the new parent's size.
   */
  attachTo(host: HTMLElement): void {
    if (this.disposed || !host || this.canvas.parentElement === host) return;
    host.appendChild(this.canvas);
    this.lastW = 0; this.lastH = 0;
  }

  /** Lock-on progress 0..1 (1 = locked). 0 when no lock-on is running. */
  get lockProgress(): number { return this.lock ? this.lock.t : 0; }
  /** The coordinate locked on right now (0..1 longitude · latitude), null when there is none. */
  get lockTarget(): { u: number; v: number } | null { return this.lock ? { u: this.lock.u, v: this.lock.v } : null; }

  /**
   * Locks on to `(u, v)` (longitude · latitude, both 0..1) over `seconds`. Two rings converge from outside and
   * leave a marker and an aiming cross on the surface. At the end `onDone` is called **once** and the marker stays
   * as it is (`clearLockOn` removes it).
   */
  startLockOn(u: number, v: number, seconds: number, onDone?: () => void): void {
    if (this.disposed) return;
    this.clearLockOn();
    const phi = (0.5 - Math.min(1, Math.max(0, v))) * Math.PI;   // +latitude = up
    const theta = Math.min(1, Math.max(0, u)) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(phi) * Math.sin(theta), Math.sin(phi), Math.cos(phi) * Math.cos(theta));

    const group = new THREE.Group();
    group.rotation.x = -PLANET_HOLOGRAM_TILT;      // the same tilt frame as a slot
    const junk: Array<THREE.BufferGeometry | THREE.Material> = [];
    const rings: THREE.Mesh[] = [];
    const ringMats: THREE.MeshBasicMaterial[] = [];
    for (let i = 0; i < 2; i++) {
      const g = new THREE.TorusGeometry(0.34 + i * 0.16, 0.012, 6, 64);
      const m = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
      const mesh = new THREE.Mesh(g, m);
      mesh.renderOrder = 6;
      group.add(mesh);
      rings.push(mesh); ringMats.push(m);
      junk.push(g, m);
    }
    const mg = new THREE.OctahedronGeometry(0.075, 0);
    const mm = new THREE.MeshBasicMaterial({ color: 0xffd18a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    const marker = new THREE.Mesh(mg, mm);
    marker.renderOrder = 7;
    group.add(marker);
    junk.push(mg, mm);

    // surface cross: four pieces along the two axes perpendicular to dir
    const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const ax = new THREE.Vector3().crossVectors(up, dir).normalize();
    const az = new THREE.Vector3().crossVectors(dir, ax).normalize();
    const pos = new Float32Array(8 * 3);
    const base = dir.clone().multiplyScalar(R * 1.03);
    const put = (i: number, p: THREE.Vector3): void => { pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z; };
    const seg = (i: number, axis: THREE.Vector3, from: number, to: number): void => {
      put(i, base.clone().addScaledVector(axis, from));
      put(i + 1, base.clone().addScaledVector(axis, to));
    };
    seg(0, ax, 0.1, 0.34); seg(2, ax, -0.1, -0.34);
    seg(4, az, 0.1, 0.34); seg(6, az, -0.1, -0.34);
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const cm = new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    const cross = new THREE.LineSegments(cg, cm);
    cross.renderOrder = 7;
    cross.frustumCulled = false;
    group.add(cross);
    junk.push(cg, cm);

    this.scene.add(group);
    this.lock = { group, rings, ringMats, marker, markerMat: mm, cross, crossMat: cm, junk, dir, u, v, t: 0, dur: Math.max(0.2, seconds), fired: false, onDone: onDone ?? null };
    this.tickLock(0);
  }

  /** Removes the lock-on marker and goes back to the usual spin. */
  clearLockOn(): void {
    const l = this.lock;
    if (!l) return;
    this.lock = null;
    l.group.removeFromParent();
    for (const j of l.junk) j.dispose();
  }

  /** One frame of lock-on progress. Called only from inside `render`. */
  private tickLock(dt: number): void {
    const l = this.lock;
    if (!l) return;
    l.t = Math.min(1, l.t + dt / l.dur);
    const e = l.t * l.t * (3 - 2 * l.t);
    const d = Math.max(0, R * (LOCK_RING_START + (LOCK_RING_END - LOCK_RING_START) * e));
    for (let i = 0; i < l.rings.length; i++) {
      const m = l.rings[i];
      m.position.copy(l.dir).multiplyScalar(d + i * 0.12 * (1 - e));
      m.lookAt(m.position.clone().add(l.dir));
      const s = 1 + (1 - e) * 2.4;
      m.scale.setScalar(s);
      m.rotation.z += dt * (1.8 - 1.5 * e) * (i === 0 ? 1 : -1);
      l.ringMats[i].opacity = (i === 0 ? 0.85 : 0.5) * Math.min(1, l.t * 4) * (0.55 + 0.45 * e);
    }
    l.marker.position.copy(l.dir).multiplyScalar(R * 1.04);
    l.marker.rotation.y += dt * 1.4;
    l.marker.rotation.x += dt * 0.9;
    const late = Math.max(0, (l.t - 0.55) / 0.45);
    l.markerMat.opacity = late;
    l.crossMat.opacity = late * 0.9;
    if (l.t >= 1 && !l.fired) { l.fired = true; const cb = l.onDone; l.onDone = null; cb?.(); }
  }

  /**
   * Show `def`. `dir` is the direction the player stepped (+1 = ▶ / right, −1 = ◀): the new sphere slides in from
   * that side while the old one leaves the other way. Re-showing the same planet is a no-op.
   */
  setPlanet(def: PlanetDef, dir = 1): void {
    if (this.disposed || this.cur?.def.id === def.id) return;
    this.clearLockOn();            // stepping to another planet makes the coordinate held meaningless
    this.freeSlot(this.out);
    this.out = this.cur;
    this.cur = this.makeSlot(def);
    this.swapDir = dir >= 0 ? 1 : -1;
    this.swapT = this.out ? 0 : 1;
  }

  /** Draw one frame. No-op while the terminal is closed (that is what stops the render loop). */
  render(dt: number): void {
    if (!this.visible || this.disposed) return;
    const host = this.canvas.parentElement;
    const w = Math.max(1, Math.round(host?.clientWidth || PLANET_HOLOGRAM_PX));
    const h = Math.max(1, Math.round(host?.clientHeight || PLANET_HOLOGRAM_PX));
    if (w !== this.lastW || h !== this.lastH) {
      this.lastW = w; this.lastH = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.spin += dt;
    if (this.swapT < 1) {
      this.swapT = Math.min(1, this.swapT + dt / Math.max(0.05, PLANET_SWAP_TIME));
      if (this.swapT >= 1) { this.freeSlot(this.out); this.out = null; }
    }
    const e = this.swapT * this.swapT * (3 - 2 * this.swapT);
    // during a lock-on the cage's spin gradually stops (「it spins, then locks」)
    const cageSpin = this.lock ? 0.4 * (1 - 0.88 * (this.lock.t * this.lock.t * (3 - 2 * this.lock.t))) : 0.4;
    if (this.cur) {
      this.cur.planet.update(dt);
      this.cur.group.position.x = this.swapDir * SLIDE * (1 - e);
      this.cur.planet.setOpacity(e);
      this.cur.cageMat.opacity = 0.16 * e;
      this.cur.cage.rotation.y += dt * PLANET_HOLOGRAM_SPIN * cageSpin;
    }
    this.tickLock(dt);
    if (this.out) {
      this.out.planet.update(dt);
      this.out.group.position.x = -this.swapDir * SLIDE * e;
      this.out.planet.setOpacity(1 - e);
      this.out.cageMat.opacity = 0.16 * (1 - e);
    }
    this.rings.rotation.z += dt * 0.22;
    this.scanMat.opacity = 0.05 + 0.035 * (0.5 + 0.5 * Math.sin(this.spin * 2.4));
    this.scan.position.y = ((this.spin * 0.35) % 0.16) - 0.08;
    this.renderer.render(this.scene, this.camera);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.canvas.style.visibility = visible ? '' : 'hidden';
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearLockOn();
    this.disposed = true;
    this.freeSlot(this.cur); this.cur = null;
    this.freeSlot(this.out); this.out = null;
    for (const m of this.ringMats) m.dispose();
    this.ringMats.length = 0;
    this.scanMat.dispose();
    this.scan.removeFromParent();
    this.rings.removeFromParent();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}

export type PlanetHologram = Hologram;

/**
 * Build the terminal's planet hologram into `host` (one square WebGL canvas of `PLANET_HOLOGRAM_PX`). Returns null
 * when a second WebGL context is unavailable — the terminal then falls back to the text-only planet card.
 */
export function createPlanetHologram(host: HTMLElement): PlanetHologram | null {
  let canvas: HTMLCanvasElement;
  let renderer: THREE.WebGLRenderer;
  try {
    canvas = document.createElement('canvas');
    canvas.className = 'planet-canvas';
    canvas.width = PLANET_HOLOGRAM_PX;
    canvas.height = PLANET_HOLOGRAM_PX;
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
  } catch (e) {
    console.warn('[PlanetHologram] no second WebGL context', e);
    return null;
  }
  try {
    return new Hologram(host, renderer, canvas);
  } catch (e) {
    console.warn('[PlanetHologram] build failed', e);
    try { renderer.dispose(); } catch { /* ignore */ }
    canvas.remove();
    return null;
  }
}
