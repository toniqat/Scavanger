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
 * 락온 연출 (2026-09-14, 정보상 — `docs/DECISIONS.md` 「2026-09-14 — 정보상」): 홀로그램이 돌다가 **한 좌표에 물린다.**
 * 전부 절차 지오메트리이고 **광원을 하나도 더하지 않는다** (CLAUDE.md 「씬의 광원 개수를 플레이 중에 바꾸지
 * 않는다」 — 여기는 자체 씬이지만 규칙을 같이 지킨다: 켜고 끄는 것은 opacity 뿐이다).
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
  /** 표면 위 목표 방향 (단위 벡터, 기울기 프레임 로컬). */
  dir: THREE.Vector3;
  u: number;
  v: number;
  t: number;
  dur: number;
  fired: boolean;
  onDone: (() => void) | null;
}

/** 락온 링이 바깥에서 출발하는 거리 (구 반지름 R 배수). */
const LOCK_RING_START = 3.2;
const LOCK_RING_END = 1.06;

/**
 * 행성 홀로그램 (Phase 11): the spinning planet at the centre of the full-screen ship terminal.
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
  /** 락온 (2026-09-14, 정보상). null = 평소대로 돈다. */
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

  /* ── 락온 (2026-09-14, 정보상) ────────────────────────────────────────────── */

  /**
   * 캔버스를 다른 패널로 옮긴다. 정보상 화면이 터미널의 홀로그램을 **빌려** 쓰기 위한 것 — 두 번째
   * `WebGLRenderer` 를 만들면 컨텍스트가 하나 더 늘고 `createPlanetHologram` 이 null 을 돌려줄 위험이 커진다.
   * 다음 `render` 가 새 부모 크기로 다시 잰다.
   */
  attachTo(host: HTMLElement): void {
    if (this.disposed || !host || this.canvas.parentElement === host) return;
    host.appendChild(this.canvas);
    this.lastW = 0; this.lastH = 0;
  }

  /** 락온 진행도 0..1 (1 = 물렸다). 락온 중이 아니면 0. */
  get lockProgress(): number { return this.lock ? this.lock.t : 0; }
  /** 지금 물고 있는 좌표 (0..1 경도 · 위도), 없으면 null. */
  get lockTarget(): { u: number; v: number } | null { return this.lock ? { u: this.lock.u, v: this.lock.v } : null; }

  /**
   * `(u, v)`(경도 · 위도, 둘 다 0..1)에 `seconds` 동안 락온한다. 링 둘이 바깥에서 수렴하고 표면에 표식과
   * 조준 십자가 남는다. 끝나면 `onDone` 을 **한 번** 부르고 표식은 그대로 남는다 (`clearLockOn` 이 지운다).
   */
  startLockOn(u: number, v: number, seconds: number, onDone?: () => void): void {
    if (this.disposed) return;
    this.clearLockOn();
    const phi = (0.5 - Math.min(1, Math.max(0, v))) * Math.PI;   // +위도 = 위쪽
    const theta = Math.min(1, Math.max(0, u)) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(phi) * Math.sin(theta), Math.sin(phi), Math.cos(phi) * Math.cos(theta));

    const group = new THREE.Group();
    group.rotation.x = -PLANET_HOLOGRAM_TILT;      // 슬롯과 같은 기울기 프레임
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

    // 표면 십자선: dir 에 수직인 두 축으로 네 토막
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

  /** 락온 표식을 지우고 평소 회전으로 돌아간다. */
  clearLockOn(): void {
    const l = this.lock;
    if (!l) return;
    this.lock = null;
    l.group.removeFromParent();
    for (const j of l.junk) j.dispose();
  }

  /** 한 프레임의 락온 진행. `render` 안에서만 불린다. */
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
    this.clearLockOn();            // 다른 행성으로 넘어가면 물고 있던 좌표는 뜻이 없다
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
    // 락온 중에는 케이지 회전이 서서히 멎는다 (「돌다가 물린다」)
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
