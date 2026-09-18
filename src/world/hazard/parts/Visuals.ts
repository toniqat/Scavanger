/**
 * src/world/hazard/parts/Visuals.ts — the hazard's **presentation**: swirling particles and the wall on its edge.
 *
 * Two parts.
 *  - **Particles**: a point cloud following the camera that wraps around it (`Ambience.ts`'s spore cloud is the model).
 *    It thickens the deeper into a zone the camera is — outside, nothing is drawn (at `uOpacity` 0 the per-frame
 *    position update is skipped too). 2026-09-13: the count drawn rises **with progress**, `HAZARD_PARTICLE_RAMP_START` → `END`.
 *  - **Walls**: a curtain showing in 3D where the edge is. A `front` stands 3 planes along the front overlapped to
 *    `frontBandM` thickness; a `circle` one open cylinder each (the eye seen from inside, spores from outside — both `DoubleSide`).
 *
 * 2026-09-13 — two fragment-shader lines were laid on the wall material (`onBeforeCompile`, no light, no new texture):
 *  ① **Outside the map is discarded** — the storm eye starts as a circle enclosing the map corners (radius 450–650 m) and
 *     the front curtain is wider than the map diagonal, so no wall floats in the air past `EXTENT` (±416 m), where terrain ends.
 *  ② **Overlapping spore circles are one shape** — a wall fragment inside another spore circle is discarded. The circle array
 *     is one uniform and every cylinder shares the material, so a fragment need not know "its own circle": a fragment on its own
 *     cylinder is its radius away (inward only by the chord sag `cos(π/segments)`), so it never trips the 「inside another circle」 test.
 *
 * Colour · density · thickness · height are all `data/hazards.csv` (read by `hazard/model.ts`).
 * There are no external assets — the curtain texture is a vertical stripe drawn with `CanvasTexture` that flows over time.
 */
import * as THREE from 'three';
import {
  HAZARD_PARTICLE_RAMP_END, HAZARD_PARTICLE_RAMP_START, MAP_SIZE, SPORE_SOURCES_MAX,
  type HazardZone, type ShaderWarmupRef,
} from '@/shared';
import { EXTENT, HEIGHT_MIN } from '../../Terrain';
import type { HazardPlan, HazardRow } from '../model';
import { isFrontKind } from '../model';

/** How many `front` curtains are stood overlapping (this makes the front-to-back thickness). */
const CURTAIN_LAYERS = 3;

/**
 * 2026-09-10 — only the storm eye wall is **3 cylinders deep**. With a single inner wall the silhouette smeared
 * out in the thick fog (fogMul 24) and did not read as "the safe area is over there". Stacked at slightly larger
 * radii it becomes a thick curtain, and from inside the wall is plainly standing there.
 */
const EYE_WALL_LAYERS = 3;
/** Radius spacing between layers = this fraction of the radius. */
const EYE_WALL_STEP = 0.015;
/** Segments around a cylinder. The union test's clearance (`cos(π/segments)`) comes from this value. */
const RING_SEGMENTS = 64;
/** Size of the shader's circle array — the maximum spore source count (csv). Circles past it merely drop out of the union. */
const MAX_CIRCLES = Math.max(1, Math.min(16, Math.round(SPORE_SOURCES_MAX)));
/** Extra clearance (m) on the "inside another circle" test — so float error never lets a fragment erase its own cylinder. */
const UNION_SLACK_M = 0.35;

/** A vertical flowing stripe — the only texture that makes a curtain read as "swirling". */
function makeCurtainTexture(size = 256): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const c = canvas.getContext('2d')!;
  c.fillStyle = 'rgba(255,255,255,0)';
  c.fillRect(0, 0, size, size);
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * size;
    const w = 1 + Math.random() * 5;
    const h = size * (0.25 + Math.random() * 0.75);
    const y = Math.random() * size;
    const a = 0.05 + Math.random() * 0.35;
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${a.toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x, y, w, h);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** A soft round sprite (for the particles). The same picture as `build.makeSoftParticleTexture`, but owned here. */
function makeDotTexture(size = 64): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const c = canvas.getContext('2d')!;
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function makeParticleMaterial(tex: THREE.Texture, color: THREE.Color, size: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uColor: { value: color.clone() },
      uTime: { value: 0 },
      uSize: { value: size },
      uOpacity: { value: 0 },
    },
    vertexShader: /* glsl */`
      uniform float uSize;
      uniform float uTime;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = -mv.z;
        gl_PointSize = clamp(uSize * 900.0 / max(dist, 0.01), 1.0, 26.0);
        float near = smoothstep(0.6, 3.0, dist);
        float far = 1.0 - smoothstep(40.0, 75.0, dist);
        float tw = 0.65 + 0.35 * sin(uTime * 3.1 + position.x * 0.9 + position.z * 0.7);
        vAlpha = near * far * tw;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vAlpha * uOpacity;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    fog: false,
  });
}

/**
 * One hazard's whole presentation. Owned by `Hazard`, not `WorldSystem`, and at mission end `dispose` drops every
 * geometry · material · texture.
 */
export class HazardVisuals {
  readonly group = new THREE.Group();
  private row: HazardRow | null = null;

  private points: THREE.Points | null = null;
  private pointMat: THREE.ShaderMaterial | null = null;
  private offsets: Float32Array | null = null;
  private phases: Float32Array | null = null;
  private box = 50;
  /** The particle count drawn right now (`setDrawRange`). */
  private drawn = 0;

  private curtainMat: THREE.MeshBasicMaterial | null = null;
  private curtainGeo: THREE.PlaneGeometry | null = null;
  private ringGeo: THREE.CylinderGeometry | null = null;
  private readonly curtains: THREE.Mesh[] = [];
  private readonly rings: THREE.Mesh[] = [];
  private dotTex: THREE.Texture | null = null;
  private curtainTex: THREE.Texture | null = null;

  private readonly camPos = new THREE.Vector3();
  private windX = 1;
  private windZ = 0;
  /** Is this the storm eye — the wall stands `EYE_WALL_LAYERS` deep (2026-09-10). */
  private eye = false;
  /** Is this spores — the walls are drawn as a union (2026-09-13). */
  private spores = false;

  /** The wall shader uniforms (2026-09-13). A rebuilt material is handed the same objects, so only values change. */
  private readonly clipUniform = { value: EXTENT };
  private readonly circleUniform = { value: Array.from({ length: MAX_CIRCLES }, () => new THREE.Vector4(0, 0, 0, 0)) };

  constructor() { this.group.name = 'Hazard'; }

  build(root: THREE.Group, row: HazardRow, plan: HazardPlan, maxRings: number): void {
    this.row = row;
    this.box = row.particleBox;
    if (isFrontKind(plan.kind)) { this.windX = plan.dirX; this.windZ = plan.dirZ; }
    else { this.windX = Math.SQRT1_2; this.windZ = Math.SQRT1_2; }

    // ── particles ───────────────────────────────────────────────────────
    const n = row.particleCount;
    if (n > 0) {
      this.dotTex = makeDotTexture(64);
      this.offsets = new Float32Array(n * 3);
      this.phases = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        this.offsets[i * 3] = (Math.random() * 2 - 1) * this.box;
        this.offsets[i * 3 + 1] = Math.random() * 22 - 2;
        this.offsets[i * 3 + 2] = (Math.random() * 2 - 1) * this.box;
        this.phases[i] = Math.random() * Math.PI * 2;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
      this.pointMat = makeParticleMaterial(this.dotTex, new THREE.Color(row.particleColor), row.particleSize);
      this.points = new THREE.Points(geo, this.pointMat);
      this.points.frustumCulled = false;
      this.points.renderOrder = 6;
      this.points.name = 'hazard_particles';
      this.points.visible = false;
      this.drawn = particleCountAt(n, 0);
      geo.setDrawRange(0, this.drawn);
      this.group.add(this.points);
    }

    // ── walls ───────────────────────────────────────────────────────────
    this.curtainTex = makeCurtainTexture(256);
    this.eye = plan.kind === 'storm_eye';
    this.spores = plan.kind === 'spores';
    for (const v of this.circleUniform.value) v.set(0, 0, 0, 0);
    /* 2026-09-10: the storm eye wall **takes no fog** (sight inside a zone is about 15 m, so with fog the wall vanishes entirely).
     * 2026-09-13: the sandstorm · blizzard front is the same — with fog the approaching wall was invisible, which was "never having seen a storm".
     * Only the spore columns take fog, for the sense of distance. */
    this.curtainMat = new THREE.MeshBasicMaterial({
      map: this.curtainTex, color: new THREE.Color(row.wallColor),
      transparent: true, opacity: row.wallOpacity, depthWrite: false, side: THREE.DoubleSide, fog: this.spores,
    });
    this.installWallShader(this.curtainMat);
    if (isFrontKind(plan.kind)) {
      // The front is an infinite wall across the map — map-diagonal wide so a diagonal never cuts it (outside the map the shader discards)
      const width = MAP_SIZE * 1.6;
      this.curtainGeo = new THREE.PlaneGeometry(width, row.wallHeight, 1, 1);
      const tex = this.curtainTex;
      tex.repeat.set(width / 26, row.wallHeight / 26);
      for (let i = 0; i < CURTAIN_LAYERS; i++) {
        const m = new THREE.Mesh(this.curtainGeo, this.curtainMat);
        m.frustumCulled = false;
        m.renderOrder = 5;
        m.name = `hazard_curtain_${i}`;
        m.visible = false;
        this.curtains.push(m);
        this.group.add(m);
      }
    } else {
      // An open cylinder (radius 1 · height 1, scaled every frame)
      this.ringGeo = new THREE.CylinderGeometry(1, 1, 1, RING_SEGMENTS, 1, true);
      this.curtainTex.repeat.set(10, 3);
      for (let i = 0; i < Math.max(1, maxRings); i++) {
        const m = new THREE.Mesh(this.ringGeo, this.curtainMat);
        m.frustumCulled = false;
        m.renderOrder = 5;
        m.name = `hazard_ring_${i}`;
        m.visible = false;
        this.rings.push(m);
        this.group.add(m);
      }
    }
    root.add(this.group);
  }

  /**
   * 2026-09-13 — the walls and particles stay hidden until the hazard starts, so they missed the scene pre-compile at
   * world setup (`traverseVisible`) — the first visible frame 6 minutes later carried the compile. They are made visible
   * briefly, handed to `ctx.shaders.warm` and put back (its compile is synchronous, so no frame is drawn in between).
   */
  warm(shaders: ShaderWarmupRef | null | undefined): void {
    if (!shaders || !this.group.parent) return;
    const hidden: THREE.Object3D[] = [];
    this.group.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    void shaders.warm(this.group);
    for (const o of hidden) o.visible = false;
  }

  /** Lays the outside-the-map discard + the spore union fragment shader on the wall material (see the file header). */
  private installWallShader(mat: THREE.MeshBasicMaterial): void {
    const clip = this.clipUniform;
    const circles = this.circleUniform;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uHzClip = clip;
      shader.uniforms.uHzCircles = circles;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vHzWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n\tvHzWorld = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec2 vHzWorld;\nuniform float uHzClip;\nuniform vec4 uHzCircles[${MAX_CIRCLES}];`)
        .replace('#include <clipping_planes_fragment>', [
          '#include <clipping_planes_fragment>',
          '\tif (abs(vHzWorld.x) > uHzClip || abs(vHzWorld.y) > uHzClip) discard;',
          `\tfor (int hzI = 0; hzI < ${MAX_CIRCLES}; hzI++) {`,
          '\t\tvec4 hzC = uHzCircles[hzI];',
          '\t\tif (hzC.w > 0.5 && distance(vHzWorld, hzC.xy) < hzC.z) discard;',
          '\t}',
        ].join('\n'));
    };
    mat.customProgramCacheKey = () => `hazard-wall-${MAX_CIRCLES}`;
  }

  /**
   * `blend` 0..1 = how deep the camera is in the danger zone right now (rises over `HAZARD_EDGE_M` from the edge).
   * The particles react to this value alone; the walls are visible whenever the hazard is running (it has to be
   * seen approaching from afar). `progress` (2026-09-13) = hazard progress 0..1 — the particle count follows it.
   */
  update(dt: number, time: number, camera: THREE.Camera, zones: readonly HazardZone[], blend: number, active: boolean, progress = 1): void {
    const row = this.row;
    if (!row) return;
    if (this.curtainTex) {
      this.curtainTex.offset.x = (this.curtainTex.offset.x + dt * 0.22) % 1;
      this.curtainTex.offset.y = (this.curtainTex.offset.y - dt * 0.05) % 1;
    }
    this.updateParticles(dt, time, camera, blend, progress);
    this.updateWalls(zones, active, row);
  }

  private updateParticles(dt: number, time: number, camera: THREE.Camera, blend: number, progress: number): void {
    const pts = this.points;
    const mat = this.pointMat;
    const off = this.offsets;
    const ph = this.phases;
    if (!pts || !mat || !off || !ph) return;
    const target = blend;
    const cur = mat.uniforms.uOpacity.value as number;
    // Follows smoothly so it never flickers when crossing the edge
    const next = cur + (target - cur) * Math.min(1, dt * 3.5);
    mat.uniforms.uOpacity.value = next;
    if (next < 0.004) { pts.visible = false; return; }
    pts.visible = true;
    mat.uniforms.uTime.value = time;

    // 2026-09-13: more particles as the hazard runs on. The offsets are evenly scattered, so the first k are an even subset.
    const want = particleCountAt(ph.length, progress);
    if (want !== this.drawn) { this.drawn = want; pts.geometry.setDrawRange(0, want); }

    camera.getWorldPosition(this.camPos);
    const cx = this.camPos.x, cy = this.camPos.y, cz = this.camPos.z;
    const attr = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const B = this.box, span = B * 2;
    const drift = this.row!.driftMps, rise = this.row!.riseMps;
    const n = this.drawn;
    for (let i = 0; i < n; i++) {
      const p = ph[i];
      let lx = off[i * 3] + time * drift * this.windX + Math.sin(time * 0.8 + p) * 2.2;
      let lz = off[i * 3 + 2] + time * drift * this.windZ + Math.cos(time * 0.7 + p * 1.3) * 2.2;
      let ly = off[i * 3 + 1] + time * rise + Math.sin(time * 1.1 + p * 2.1) * 0.9;
      lx = ((lx - cx + B) % span + span) % span - B + cx;
      lz = ((lz - cz + B) % span + span) % span - B + cz;
      ly = ((ly - cy + 12) % 26 + 26) % 26 - 12 + cy;
      arr[i * 3] = lx;
      arr[i * 3 + 1] = ly;
      arr[i * 3 + 2] = lz;
    }
    attr.needsUpdate = true;
  }

  private updateWalls(zones: readonly HazardZone[], active: boolean, row: HazardRow): void {
    const baseY = HEIGHT_MIN;
    if (this.curtains.length > 0) {
      const z0 = active ? zones.find((z) => z.shape === 'front') : undefined;
      for (let i = 0; i < this.curtains.length; i++) {
        const m = this.curtains[i];
        if (!z0) { m.visible = false; continue; }
        m.visible = true;
        // Stood overlapping by `frontBandM` toward the back of the front (already passed = the dangerous side)
        const back = (i / Math.max(1, CURTAIN_LAYERS - 1)) * row.frontBandM;
        m.position.set(z0.center.x - z0.dirX * back, baseY + row.wallHeight * 0.5, z0.center.z - z0.dirZ * back);
        // A plane's normal is +Z, so it is turned about Y to face the front normal `(dirX, dirZ)`
        m.rotation.set(0, Math.atan2(z0.dirX, z0.dirZ), 0);
      }
      return;
    }
    // Storm eye: there is one zone only, and `EYE_WALL_LAYERS` cylinders ring that one at slightly different radii
    if (this.eye) {
      const z = active ? zones[0] : undefined;
      for (let i = 0; i < this.rings.length; i++) {
        const m = this.rings[i];
        if (!z || z.shape !== 'circle' || z.radius <= 0.5) { m.visible = false; continue; }
        m.visible = true;
        const r = z.radius * (1 + i * EYE_WALL_STEP);
        m.position.set(z.center.x, baseY + row.wallHeight * 0.5, z.center.z);
        m.scale.set(r, row.wallHeight, r);
      }
      return;
    }
    // Spores: one cylinder per circle + the union uniform (wall fragments inside another circle are discarded)
    const cosSeg = Math.cos(Math.PI / RING_SEGMENTS);
    const circles = this.circleUniform.value;
    let used = 0;
    for (let i = 0; i < this.rings.length; i++) {
      const m = this.rings[i];
      const z = active ? zones[i] : undefined;
      if (!z || z.shape !== 'circle' || z.radius <= 0.5) { m.visible = false; continue; }
      m.visible = true;
      m.position.set(z.center.x, baseY + row.wallHeight * 0.5, z.center.z);
      m.scale.set(z.radius, row.wallHeight, z.radius);
      if (this.spores && !z.safeInside && used < circles.length) {
        circles[used++].set(z.center.x, z.center.z, Math.max(0, z.radius * cosSeg - UNION_SLACK_M), 1);
      }
    }
    for (let i = used; i < circles.length; i++) circles[i].w = 0;
  }

  /** Cylinders needed for a hazard whose zone count can grow (spores). The storm eye rings its one zone in layers. */
  static ringsFor(plan: HazardPlan): number {
    if (isFrontKind(plan.kind)) return 0;
    if (plan.kind === 'storm_eye') return EYE_WALL_LAYERS;
    return Math.max(1, plan.sources.length);
  }

  dispose(): void {
    this.group.clear();
    this.group.removeFromParent();
    this.points?.geometry.dispose();
    this.points = null;
    this.pointMat?.dispose(); this.pointMat = null;
    this.curtainGeo?.dispose(); this.curtainGeo = null;
    this.ringGeo?.dispose(); this.ringGeo = null;
    this.curtainMat?.dispose(); this.curtainMat = null;
    this.dotTex?.dispose(); this.dotTex = null;
    this.curtainTex?.dispose(); this.curtainTex = null;
    this.curtains.length = 0;
    this.rings.length = 0;
    this.offsets = null;
    this.phases = null;
    this.row = null;
    this.eye = false;
    this.spores = false;
    this.drawn = 0;
    for (const v of this.circleUniform.value) v.set(0, 0, 0, 0);
  }
}

/** Particles to draw at `progress` — `particleCount × lerp(RAMP_START, RAMP_END, progress)`, minimum 1. */
function particleCountAt(total: number, progress: number): number {
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  const k = HAZARD_PARTICLE_RAMP_START + (HAZARD_PARTICLE_RAMP_END - HAZARD_PARTICLE_RAMP_START) * p;
  return Math.max(1, Math.min(total, Math.round(total * k)));
}
