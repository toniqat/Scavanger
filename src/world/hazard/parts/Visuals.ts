/**
 * src/world/hazard/parts/Visuals.ts — 재해의 **표현**: 휘몰아치는 입자와 경계에 선 벽.
 *
 * 두 부분이다.
 *  - **입자**: 카메라를 따라다니며 감기는 포인트 구름 (`Ambience.ts` 의 포자 구름이 본보기다). 구역 안에
 *    들어갈수록 짙어진다 — 밖에서는 아예 그리지 않는다 (`uOpacity` 0 이면 매 프레임 위치 갱신도 건너뛴다).
 *  - **벽**: 경계가 어디인지 3D 로 보여 주는 커튼. `front` 는 전선을 따라 `frontBandM` 두께로 겹쳐 세운
 *    평면 3장, `circle` 은 열린 원통 하나씩 (폭풍의 눈은 안에서, 포자는 밖에서 본다 — 둘 다 `DoubleSide`).
 *
 * 색 · 밀도 · 두께 · 높이는 전부 `data/hazards.csv` 다 (`hazard/model.ts` 가 읽는다).
 * 외부 에셋은 없다 — 커튼 텍스처는 `CanvasTexture` 로 그린 세로 줄무늬이고 시간에 따라 흐른다.
 */
import * as THREE from 'three';
import { MAP_SIZE, type HazardZone } from '@/shared';
import { HEIGHT_MIN } from '../../Terrain';
import type { HazardPlan, HazardRow } from '../model';
import { isFrontKind } from '../model';

/** `front` 커튼을 몇 장 겹쳐 세우나 (앞뒤 두께를 만든다). */
const CURTAIN_LAYERS = 3;

/** 세로로 흐르는 줄무늬 — 커튼이 "휘몰아친다" 로 읽히게 하는 유일한 텍스처다. */
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

/** 부드러운 원형 스프라이트 (입자용). `build.makeSoftParticleTexture` 와 같은 그림이지만 여기서 소유한다. */
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
 * 재해 하나의 표현 전부. `WorldSystem` 이 아니라 `Hazard` 가 소유하고, 미션이 끝나면 `dispose` 로
 * 지오메트리 · 머티리얼 · 텍스처를 전부 버린다.
 */
export class HazardVisuals {
  readonly group = new THREE.Group();
  private row: HazardRow | null = null;

  private points: THREE.Points | null = null;
  private pointMat: THREE.ShaderMaterial | null = null;
  private offsets: Float32Array | null = null;
  private phases: Float32Array | null = null;
  private box = 50;

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

  constructor() { this.group.name = 'Hazard'; }

  build(root: THREE.Group, row: HazardRow, plan: HazardPlan, maxRings: number): void {
    this.row = row;
    this.box = row.particleBox;
    if (isFrontKind(plan.kind)) { this.windX = plan.dirX; this.windZ = plan.dirZ; }
    else { this.windX = Math.SQRT1_2; this.windZ = Math.SQRT1_2; }

    // ── 입자 ────────────────────────────────────────────────────────────
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
      this.group.add(this.points);
    }

    // ── 벽 ──────────────────────────────────────────────────────────────
    this.curtainTex = makeCurtainTexture(256);
    this.curtainMat = new THREE.MeshBasicMaterial({
      map: this.curtainTex, color: new THREE.Color(row.wallColor),
      transparent: true, opacity: row.wallOpacity, depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
    if (isFrontKind(plan.kind)) {
      // 전선은 맵을 가로지르는 무한 벽이다 — 대각선으로 잘리지 않게 맵 대각선 길이만큼 넓게
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
      // 열린 원통 (반지름 1 · 높이 1 을 매 프레임 스케일한다)
      this.ringGeo = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true);
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
   * `blend` 0..1 = 지금 카메라가 위험 구역에 얼마나 잠겨 있나 (경계에서 `HAZARD_EDGE_M` 에 걸쳐 오른다).
   * 입자는 이 값에만 반응하고, 벽은 재해가 진행 중이면 언제나 보인다 (멀리서 다가오는 것이 보여야 한다).
   */
  update(dt: number, time: number, camera: THREE.Camera, zones: readonly HazardZone[], blend: number, active: boolean): void {
    const row = this.row;
    if (!row) return;
    if (this.curtainTex) {
      this.curtainTex.offset.x = (this.curtainTex.offset.x + dt * 0.22) % 1;
      this.curtainTex.offset.y = (this.curtainTex.offset.y - dt * 0.05) % 1;
    }
    this.updateParticles(dt, time, camera, blend);
    this.updateWalls(zones, active, row);
  }

  private updateParticles(dt: number, time: number, camera: THREE.Camera, blend: number): void {
    const pts = this.points;
    const mat = this.pointMat;
    const off = this.offsets;
    const ph = this.phases;
    if (!pts || !mat || !off || !ph) return;
    const target = blend;
    const cur = mat.uniforms.uOpacity.value as number;
    // 경계를 넘나들 때 깜빡이지 않도록 부드럽게 따라간다
    const next = cur + (target - cur) * Math.min(1, dt * 3.5);
    mat.uniforms.uOpacity.value = next;
    if (next < 0.004) { pts.visible = false; return; }
    pts.visible = true;
    mat.uniforms.uTime.value = time;

    camera.getWorldPosition(this.camPos);
    const cx = this.camPos.x, cy = this.camPos.y, cz = this.camPos.z;
    const attr = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const B = this.box, span = B * 2;
    const drift = this.row!.driftMps, rise = this.row!.riseMps;
    const n = ph.length;
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
        // 전선 뒤쪽(이미 지나온 = 위험한 쪽)으로 `frontBandM` 만큼 겹쳐 세운다
        const back = (i / Math.max(1, CURTAIN_LAYERS - 1)) * row.frontBandM;
        m.position.set(z0.center.x - z0.dirX * back, baseY + row.wallHeight * 0.5, z0.center.z - z0.dirZ * back);
        // 평면의 법선은 +Z 라 전선 법선 `(dirX, dirZ)` 을 향하도록 Y 로 돌린다
        m.rotation.set(0, Math.atan2(z0.dirX, z0.dirZ), 0);
      }
      return;
    }
    for (let i = 0; i < this.rings.length; i++) {
      const m = this.rings[i];
      const z = active ? zones[i] : undefined;
      if (!z || z.shape !== 'circle' || z.radius <= 0.5) { m.visible = false; continue; }
      m.visible = true;
      m.position.set(z.center.x, baseY + row.wallHeight * 0.5, z.center.z);
      m.scale.set(z.radius, row.wallHeight, z.radius);
    }
  }

  /** 도형 개수가 늘어날 수 있는 재해(포자)에서 필요한 원통 수. */
  static ringsFor(plan: HazardPlan): number {
    if (isFrontKind(plan.kind)) return 0;
    return plan.kind === 'spores' ? Math.max(1, plan.sources.length) : 1;
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
  }
}
