/**
 * src/world/hazard/parts/Visuals.ts — 재해의 **표현**: 휘몰아치는 입자와 경계에 선 벽.
 *
 * 두 부분이다.
 *  - **입자**: 카메라를 따라다니며 감기는 포인트 구름 (`Ambience.ts` 의 포자 구름이 본보기다). 구역 안에
 *    들어갈수록 짙어진다 — 밖에서는 아예 그리지 않는다 (`uOpacity` 0 이면 매 프레임 위치 갱신도 건너뛴다).
 *    2026-09-13: 그리는 개수가 **진행도에 따라** `HAZARD_PARTICLE_RAMP_START` → `END` 비율로 는다 (`setDrawRange`).
 *  - **벽**: 경계가 어디인지 3D 로 보여 주는 커튼. `front` 는 전선을 따라 `frontBandM` 두께로 겹쳐 세운
 *    평면 3장, `circle` 은 열린 원통 하나씩 (폭풍의 눈은 안에서, 포자는 밖에서 본다 — 둘 다 `DoubleSide`).
 *
 * 2026-09-13 — 벽 머티리얼에 조각 셰이더 두 줄을 얹었다 (`onBeforeCompile`, 광원 · 새 텍스처 없음):
 *  ① **맵 밖은 버린다** — 폭풍의 눈이 맵 꼭짓점을 품는 원(반경 450–650 m)으로 시작하고 전선 커튼은 원래 맵 대각선보다
 *     넓어서, 지형이 끝나는 `EXTENT`(±416 m) 밖 허공에 벽이 떠 있지 않게 한다.
 *  ② **독성 포자 원이 겹치면 한 도형이다** — 다른 포자 원 안에 들어간 벽 조각을 버린다. 원 배열은 uniform 하나이고
 *     모든 원통이 머티리얼을 같이 쓰므로 "자기 원" 을 알 필요가 없다: 자기 원통 위의 조각은 제 원까지의 거리가 반경과
 *     같아(다각형 현의 처짐 `cos(π/분할)` 만큼만 안쪽) 「다른 원 안」 판정에 걸리지 않는다.
 *
 * 색 · 밀도 · 두께 · 높이는 전부 `data/hazards.csv` 다 (`hazard/model.ts` 가 읽는다).
 * 외부 에셋은 없다 — 커튼 텍스처는 `CanvasTexture` 로 그린 세로 줄무늬이고 시간에 따라 흐른다.
 */
import * as THREE from 'three';
import {
  HAZARD_PARTICLE_RAMP_END, HAZARD_PARTICLE_RAMP_START, MAP_SIZE, SPORE_SOURCES_MAX,
  type HazardZone, type ShaderWarmupRef,
} from '@/shared';
import { EXTENT, HEIGHT_MIN } from '../../Terrain';
import type { HazardPlan, HazardRow } from '../model';
import { isFrontKind } from '../model';

/** `front` 커튼을 몇 장 겹쳐 세우나 (앞뒤 두께를 만든다). */
const CURTAIN_LAYERS = 3;

/**
 * 2026-09-10 — 폭풍의 눈 벽만 **원통 3겹**이다. 안쪽 벽 하나로는 짙은 안개(fogMul 24) 속에서 실루엣이
 * 뭉개져 "안전지대가 저기" 로 읽히지 않았다. 반지름을 조금씩 키워 겹치면 두꺼운 커튼이 되고, 안에서
 * 보면 벽이 확실히 서 있는 것이 보인다.
 */
const EYE_WALL_LAYERS = 3;
/** 겹 사이의 반지름 간격 = 반지름의 이 비율. */
const EYE_WALL_STEP = 0.015;
/** 원통 둘레 분할 수. 합집합 판정의 여유(`cos(π/분할)`)가 이 값에서 나온다. */
const RING_SEGMENTS = 64;
/** 셰이더의 원 배열 크기 — 포자 발생지 최대 수 (csv). 계획에 이보다 많은 원이 오면 넘친 원은 합집합에서 빠질 뿐이다. */
const MAX_CIRCLES = Math.max(1, Math.min(16, Math.round(SPORE_SOURCES_MAX)));
/** 다른 원 안이라고 판정하는 추가 여유(m) — 자기 원통 위 조각이 부동소수 오차로 자기를 지우지 않게. */
const UNION_SLACK_M = 0.35;

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
  /** 지금 그리는 입자 수 (`setDrawRange`). */
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
  /** 폭풍의 눈인가 — 벽이 `EYE_WALL_LAYERS` 겹으로 선다 (2026-09-10). */
  private eye = false;
  /** 독성 포자인가 — 벽이 합집합으로 그려진다 (2026-09-13). */
  private spores = false;

  /** 벽 셰이더 uniform (2026-09-13). 머티리얼을 다시 만들어도 같은 객체를 넘기므로 값만 고치면 된다. */
  private readonly clipUniform = { value: EXTENT };
  private readonly circleUniform = { value: Array.from({ length: MAX_CIRCLES }, () => new THREE.Vector4(0, 0, 0, 0)) };

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
      this.drawn = particleCountAt(n, 0);
      geo.setDrawRange(0, this.drawn);
      this.group.add(this.points);
    }

    // ── 벽 ──────────────────────────────────────────────────────────────
    this.curtainTex = makeCurtainTexture(256);
    this.eye = plan.kind === 'storm_eye';
    this.spores = plan.kind === 'spores';
    for (const v of this.circleUniform.value) v.set(0, 0, 0, 0);
    /* 2026-09-10: 폭풍의 눈 벽은 **포그를 받지 않는다** (구역 안 시야가 15 m 남짓이라 포그를 먹이면 벽이 통째로 사라진다).
     * 2026-09-13: 모래 폭풍 · 눈보라 전선도 같다 — 포그를 받으면 멀리서 다가오는 벽이 안 보여 "폭풍을 본 적이 없다" 였다.
     * 독성 포자 기둥만 거리감을 위해 포그를 받는다. */
    this.curtainMat = new THREE.MeshBasicMaterial({
      map: this.curtainTex, color: new THREE.Color(row.wallColor),
      transparent: true, opacity: row.wallOpacity, depthWrite: false, side: THREE.DoubleSide, fog: this.spores,
    });
    this.installWallShader(this.curtainMat);
    if (isFrontKind(plan.kind)) {
      // 전선은 맵을 가로지르는 무한 벽이다 — 대각선으로 잘리지 않게 맵 대각선 길이만큼 넓게 (맵 밖은 셰이더가 버린다)
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
   * 2026-09-13 — 벽과 입자는 재해가 시작할 때까지 숨어 있어서 월드 준비 때의 장면 선컴파일(`traverseVisible`)에
   * 들어가지 않았다 — 6분 뒤 처음 보이는 프레임이 컴파일을 떠안았다. 잠깐 보이게 한 채 `ctx.shaders.warm` 에 넘기고
   * 곧바로 되돌린다 (`warm` 의 컴파일은 동기라 그 사이에 그려지는 프레임이 없다).
   */
  warm(shaders: ShaderWarmupRef | null | undefined): void {
    if (!shaders || !this.group.parent) return;
    const hidden: THREE.Object3D[] = [];
    this.group.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    void shaders.warm(this.group);
    for (const o of hidden) o.visible = false;
  }

  /** 벽 머티리얼에 맵 밖 버리기 + 포자 합집합 조각 셰이더를 얹는다 (위 파일 머리말). */
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
   * `blend` 0..1 = 지금 카메라가 위험 구역에 얼마나 잠겨 있나 (경계에서 `HAZARD_EDGE_M` 에 걸쳐 오른다).
   * 입자는 이 값에만 반응하고, 벽은 재해가 진행 중이면 언제나 보인다 (멀리서 다가오는 것이 보여야 한다).
   * `progress` (2026-09-13) = 재해 진행도 0..1 — 그리는 입자 수가 따라 는다.
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
    // 경계를 넘나들 때 깜빡이지 않도록 부드럽게 따라간다
    const next = cur + (target - cur) * Math.min(1, dt * 3.5);
    mat.uniforms.uOpacity.value = next;
    if (next < 0.004) { pts.visible = false; return; }
    pts.visible = true;
    mat.uniforms.uTime.value = time;

    // 2026-09-13: 재해가 진행될수록 입자가 많아진다. 오프셋이 고르게 흩어져 있어 앞의 k 개가 곧 고른 부분집합이다.
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
        // 전선 뒤쪽(이미 지나온 = 위험한 쪽)으로 `frontBandM` 만큼 겹쳐 세운다
        const back = (i / Math.max(1, CURTAIN_LAYERS - 1)) * row.frontBandM;
        m.position.set(z0.center.x - z0.dirX * back, baseY + row.wallHeight * 0.5, z0.center.z - z0.dirZ * back);
        // 평면의 법선은 +Z 라 전선 법선 `(dirX, dirZ)` 을 향하도록 Y 로 돌린다
        m.rotation.set(0, Math.atan2(z0.dirX, z0.dirZ), 0);
      }
      return;
    }
    // 폭풍의 눈: 도형은 하나뿐이고 원통 `EYE_WALL_LAYERS` 겹이 그 하나를 조금씩 다른 반지름으로 두른다
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
    // 독성 포자: 원마다 원통 하나 + 합집합 uniform (다른 원 안의 벽 조각을 버린다)
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

  /** 도형 개수가 늘어날 수 있는 재해(포자)에서 필요한 원통 수. 폭풍의 눈은 도형 하나를 겹으로 두른다. */
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

/** 진행도 `progress` 에서 그릴 입자 수 — `particleCount × lerp(RAMP_START, RAMP_END, progress)`, 최소 1. */
function particleCountAt(total: number, progress: number): number {
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  const k = HAZARD_PARTICLE_RAMP_START + (HAZARD_PARTICLE_RAMP_END - HAZARD_PARTICLE_RAMP_START) * p;
  return Math.max(1, Math.min(total, Math.round(total * k)));
}
