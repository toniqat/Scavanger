/**
 * src/enemies/fx/BurrowFx.ts — **땅을 파고 나오는 연출** (2026-09-13).
 *
 * 이 파일이 답하는 질문: *버그가 땅에서 올라올 때 · 지하벌레가 올라오기 전에 땅이 어떻게 보이나.*
 *
 * - **분진 · 흙덩이**는 새 드로우콜을 만들지 않는다 — `core/fx` 의 알파 입자 풀(`FxManager.alpha`, `THREE.Points` 한 장,
 *   엔진이 처음부터 씬에 둔다 = 이미 컴파일돼 있다)에 넣는다. 흙덩이 = 빠르게 튀어 올랐다 떨어져 땅에 멈추는 작고 짙은 입자,
 *   분진 = 느리게 퍼지는 큰 입자. 색은 밟은 재질(`WorldRef.getSurfaceMaterial`)에서 고른다.
 * - **방출기**는 고정 풀(`EMITTERS`)이다. 굴착 하나 = 작은 방출기(올라오는 시간 동안), 지하벌레 전조 = 큰 방출기(점점 세진다).
 *   꽉 차면 가장 오래된 것을 덮어쓴다. 프레임당 할당 없음 (입자 스폰 인자도 스크래치 하나를 다시 쓴다).
 * - **전조 링**은 피해 반경을 그리는 가산 혼합 띠(`ScanPulseFx` 의 바닥 띠와 같은 기법 — 짧은 열린 원기둥이 지형을 가로질러
 *   **바닥을 스치는 붉은 선**으로 읽힌다). 메시 · 머티리얼은 생성자에서 한 번 만들어 숨긴 채 씬에 두므로 `world:ready` 의
 *   셰이더 선컴파일에 들어간다. **광원은 없다.**
 * 화면 흔들림 · 소리는 이 파일이 아니다 (`parts/Burrow` · `sandworm/Director` — 흔들림 중복 제거는 거기서 한다).
 */
import * as THREE from 'three';
import { Layers, type SurfaceMaterial, type WorldRef } from '@/shared';
import { FxManager, type ParticleSpawn } from '@/core/fx';

/** 동시에 살아 있는 방출기 수. */
const EMITTERS = 24;
/** 전조 링 수 (동시 전조는 사실상 하나). */
const RINGS = 2;
/** 전조 링 띠의 세로 폭(m). */
const RING_BAND_H = 4;
const RING_COLOR = new THREE.Color(1.0, 0.34, 0.08);

/* 재질 → 분진 색 (그림 수치). 모르면 흙. */
const DUST_COLOR: Readonly<Record<SurfaceMaterial, number>> = {
  dirt: 0x8a7560, sand: 0xc2a878, snow: 0xdfe4e8, mud: 0x5c4a38, moss: 0x66704a, ash: 0x5f5b58,
  rock: 0x7b766f, crystal: 0x93a6b8, organic: 0x6e5448, metal: 0x86857f, concrete: 0x8c8a84,
};
const DEFAULT_DUST = 0x8a7560;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

/** 세로 가운데만 밝은 띠 + 둘레를 도는 줄무늬 (진행도가 오를수록 빨라진다). */
const RING_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float c = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float stripe = 0.55 + 0.45 * sin(vUv.x * 96.0 - uTime * 4.0);
  float a = (pow(c, 14.0) * 0.95 * stripe + pow(c, 3.0) * 0.1) * uAlpha;
  gl_FragColor = vec4(uColor, a);
}`;

interface Emitter {
  active: boolean;
  /** 0 굴착 · 1 전조. */
  kind: 0 | 1;
  readonly p: THREE.Vector3;
  scale: number;
  radius: number;
  start: number;
  dur: number;
  clodAcc: number;
  dustAcc: number;
  r: number; g: number; b: number;
}

interface Ring {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.ShaderMaterial;
  active: boolean;
  start: number;
  dur: number;
  radius: number;
}

/** 입자 스폰 인자 스크래치 — `ParticlePool.spawn` 은 값을 복사하므로 하나를 계속 다시 쓴다. */
const S: Required<ParticleSpawn> = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 0.2, sizeEnd: 1,
  r: 1, g: 1, b: 1, rEnd: 1, gEnd: 1, bEnd: 1, gravity: 0, drag: 0, alpha: 1, groundY: 0,
};
const _rgb = new THREE.Color();

/** 밟은 재질의 분진 색 → `_rgb`. 월드가 없거나 재질을 모르면 흙. */
function surfaceColor(world: WorldRef | null, p: THREE.Vector3): void {
  const m = world && world.ready ? world.getSurfaceMaterial?.(p.x, p.z, p.y) : undefined;
  _rgb.setHex((m && DUST_COLOR[m]) ?? DEFAULT_DUST);
}

export class BurrowFx {
  private readonly emitters: Emitter[] = [];
  private readonly rings: Ring[] = [];
  private readonly ringGeo = new THREE.CylinderGeometry(1, 1, 1, 72, 1, true);
  private readonly group = new THREE.Group();
  private live = 0;
  /** 디버그 · 스모크: 지금까지 시작한 굴착 연출 수. */
  emergeCount = 0;

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < EMITTERS; i++) {
      this.emitters.push({ active: false, kind: 0, p: new THREE.Vector3(), scale: 1, radius: 1, start: 0, dur: 1, clodAcc: 0, dustAcc: 0, r: 0.5, g: 0.45, b: 0.38 });
    }
    this.group.name = 'burrowFx';
    for (let i = 0; i < RINGS; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: RING_FRAG,
        uniforms: { uColor: { value: RING_COLOR.clone() }, uAlpha: { value: 0 }, uTime: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 18;
      mesh.layers.enable(Layers.NO_RAYCAST);
      this.group.add(mesh);
      this.rings.push({ mesh, mat, active: false, start: 0, dur: 1, radius: 1 });
    }
    scene.add(this.group);
  }

  /** 살아 있는 방출기 수 (디버그). */
  get activeEmitters(): number { return this.live; }
  /** 전조 링이 보이는가 (디버그). */
  get ringVisible(): boolean { for (const r of this.rings) if (r.active) return true; return false; }

  /**
   * 버그 한 마리가 파고 나온다: 즉시 발밑 분진 고리 + `dur` 동안 흙덩이 · 분진이 솟는다. `scale` ≈ 몸집 (0.7 … 3).
   */
  emerge(p: THREE.Vector3, scale: number, dur: number, world: WorldRef | null, now: number): void {
    const em = this.claim();
    em.kind = 0; em.p.copy(p); em.scale = scale; em.radius = 0.5 * scale; em.start = now; em.dur = Math.max(0.2, dur);
    em.clodAcc = 0; em.dustAcc = 0;
    this.colorAt(em, world);
    this.emergeCount++;
    const fx = FxManager.get();
    if (!fx) return;
    // 첫 순간: 발밑에서 고리로 번지는 분진 (몸집만큼)
    const n = Math.round(8 + 6 * scale);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const s = (1.2 + Math.random() * 1.6) * Math.sqrt(scale);
      this.dust(fx, em, p.x + Math.cos(a) * 0.3 * scale, p.y + 0.1, p.z + Math.sin(a) * 0.3 * scale, Math.cos(a) * s, 0.6 + Math.random() * 0.8, Math.sin(a) * s, (0.35 + Math.random() * 0.3) * scale);
    }
  }

  /** 지하벌레 전조: 반경 `radius` 를 그리는 링 + 가운데서 점점 거세지는 흙 파임 · 분진 (`dur` 초). */
  warn(p: THREE.Vector3, radius: number, dur: number, world: WorldRef | null, now: number, elapsed = 0): void {
    const em = this.claim();
    em.kind = 1; em.p.copy(p); em.scale = 1; em.radius = radius; em.start = now - elapsed; em.dur = Math.max(0.5, dur + elapsed);
    em.clodAcc = 0; em.dustAcc = 0;
    this.colorAt(em, world);
    let ring: Ring | null = null;
    for (const r of this.rings) { if (!r.active) { ring = r; break; } if (!ring || r.start < ring.start) ring = r; }
    if (!ring) return;
    ring.active = true; ring.start = em.start; ring.dur = em.dur; ring.radius = radius;
    ring.mesh.position.copy(p);
    ring.mesh.scale.set(radius, RING_BAND_H, radius);
    ring.mat.uniforms.uAlpha.value = 0;
    ring.mesh.visible = true;
  }

  /** 전조를 끝낸다 (분출 · 취소). 링과 전조 방출기를 끈다. */
  endWarn(): void {
    for (const r of this.rings) if (r.active) { r.active = false; r.mesh.visible = false; }
    for (const em of this.emitters) if (em.active && em.kind === 1) this.release(em);
  }

  /** 분출: 반경만큼 번지는 흙 폭발 + 연기 + 사방으로 튀는 흙덩이 (한 번). */
  erupt(p: THREE.Vector3, radius: number, world: WorldRef | null): void {
    const fx = FxManager.get();
    if (!fx) return;
    surfaceColor(world, p);
    const cr = _rgb.r, cg = _rgb.g, cb = _rgb.b;
    const ring = Math.round(70 + radius * 4);
    for (let i = 0; i < ring; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = radius * (0.9 + Math.random() * 0.9);
      this.spawnRaw(fx, p.x + Math.cos(a) * 1.5, p.y + Math.random() * 1.2, p.z + Math.sin(a) * 1.5,
        Math.cos(a) * s, 2 + Math.random() * 6, Math.sin(a) * s,
        1.4 + Math.random() * 1.2, 0.9 + Math.random() * 0.9, 3, cr, cg, cb, 0.8, 2.5, 2.2, 0.65, p.y);
    }
    for (let i = 0; i < 26; i++) {
      this.spawnRaw(fx, p.x + (Math.random() - 0.5) * 3, p.y + 1 + Math.random() * 4, p.z + (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 5, 5 + Math.random() * 8, (Math.random() - 0.5) * 5,
        2 + Math.random() * 1.6, 1.8 + Math.random() * 1.4, 2.6, cr * 0.7, cg * 0.7, cb * 0.7, 1.1, -0.6, 1.4, 0.5, -1e9);
    }
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 6 + Math.random() * 12;
      this.spawnRaw(fx, p.x + Math.cos(a) * 0.8, p.y + 0.5 + Math.random() * 2, p.z + Math.sin(a) * 0.8,
        Math.cos(a) * s * 0.6, 9 + Math.random() * 12, Math.sin(a) * s * 0.6,
        1.1 + Math.random() * 0.6, 0.22 + Math.random() * 0.22, 1, cr * 0.45, cg * 0.42, cb * 0.4, 1, 20, 0.2, 1, p.y);
    }
  }

  /** 뱉어진 버그가 착지했다: 발밑 분진 한 줌. */
  puff(p: THREE.Vector3, scale: number, world: WorldRef | null): void {
    const fx = FxManager.get();
    if (!fx) return;
    surfaceColor(world, p);
    const cr = _rgb.r, cg = _rgb.g, cb = _rgb.b;
    const n = Math.round(8 + 4 * scale);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 1.5 + Math.random() * 2.5;
      this.spawnRaw(fx, p.x, p.y + 0.15, p.z, Math.cos(a) * s, 0.5 + Math.random(), Math.sin(a) * s,
        0.6 + Math.random() * 0.5, (0.3 + Math.random() * 0.3) * scale, 2.4, cr, cg, cb, 0.7, 1.2, 3.5, 0.55, p.y);
    }
  }

  update(now: number, dt: number): void {
    const ringsOn = this.ringVisible;
    if (ringsOn) {
      for (const r of this.rings) {
        if (!r.active) continue;
        const t = (now - r.start) / r.dur;
        if (t >= 1.05) { r.active = false; r.mesh.visible = false; continue; }
        const k = THREE.MathUtils.clamp(t, 0, 1);
        r.mat.uniforms.uTime.value = now * (1 + 2.5 * k);
        r.mat.uniforms.uAlpha.value = Math.min(1, t / 0.15) * (0.35 + 0.65 * k) * (0.8 + 0.2 * Math.sin(now * (6 + 14 * k)));
      }
    }
    if (this.live === 0 || dt <= 0) return;
    const fx = FxManager.get();
    for (let i = 0; i < this.emitters.length; i++) {
      const em = this.emitters[i];
      if (!em.active) continue;
      const t = (now - em.start) / em.dur;
      if (t >= 1) { this.release(em); continue; }
      if (!fx) continue;
      if (em.kind === 0) {
        // 굴착: 처음에 거세고 몸이 다 나올수록 잦아든다
        const k = 1 - t;
        em.clodAcc += dt * (10 + 16 * em.scale) * k;
        em.dustAcc += dt * (4 + 5 * em.scale) * k;
        while (em.clodAcc >= 1) { em.clodAcc -= 1; this.clod(fx, em, em.radius, 1); }
        while (em.dustAcc >= 1) { em.dustAcc -= 1; this.dustAt(fx, em, em.radius * 1.4, 0.5 * em.scale); }
      } else {
        // 전조: 진행도² 로 거세지고, 파이는 자리가 가운데서 반경 쪽으로 번진다. 링 둘레에도 흙먼지가 인다.
        const k = THREE.MathUtils.clamp(t, 0, 1);
        const spread = em.radius * (0.15 + 0.45 * k);
        em.clodAcc += dt * (8 + 110 * k * k);
        em.dustAcc += dt * (4 + 36 * k * k);
        while (em.clodAcc >= 1) { em.clodAcc -= 1; this.clod(fx, em, spread, 1 + 0.8 * k); }
        while (em.dustAcc >= 1) {
          em.dustAcc -= 1;
          if (Math.random() < 0.35) this.rimDust(fx, em);
          else this.dustAt(fx, em, spread, 0.9 + 0.9 * k);
        }
      }
    }
  }

  /** 미션 리셋: 전부 끈다 (메시 · 머티리얼은 풀에 남는다). */
  clear(): void {
    for (const em of this.emitters) em.active = false;
    for (const r of this.rings) { r.active = false; r.mesh.visible = false; }
    this.live = 0;
    this.emergeCount = 0;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    for (const r of this.rings) r.mat.dispose();
    this.rings.length = 0;
    this.ringGeo.dispose();
  }

  /* ── 내부 ─────────────────────────────────────────────────────────────── */
  private claim(): Emitter {
    let pick: Emitter | null = null;
    for (const em of this.emitters) {
      if (!em.active) { pick = em; break; }
      if (em.kind === 0 && (!pick || em.start < pick.start)) pick = em;   // 전조 방출기는 덮어쓰지 않는다
    }
    const em = pick ?? this.emitters[0];
    if (!em.active) this.live++;
    em.active = true;
    return em;
  }

  private release(em: Emitter): void {
    em.active = false;
    if (this.live > 0) this.live--;
  }

  private colorAt(em: Emitter, world: WorldRef | null): void {
    surfaceColor(world, em.p);
    em.r = _rgb.r; em.g = _rgb.g; em.b = _rgb.b;
  }

  /** 흙덩이: 작고 짙고, 튀어 올랐다 떨어져 땅에 멈춘다. */
  private clod(fx: FxManager, em: Emitter, spread: number, power: number): void {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * spread;
    const out = 0.8 + Math.random() * 2.2;
    this.spawnRaw(fx, em.p.x + Math.cos(a) * d, em.p.y + 0.1, em.p.z + Math.sin(a) * d,
      Math.cos(a) * out * power, (3 + Math.random() * 4) * power, Math.sin(a) * out * power,
      0.7 + Math.random() * 0.5, 0.1 + Math.random() * 0.14 * Math.min(2, em.scale), 1,
      em.r * 0.55, em.g * 0.5, em.b * 0.45, 1, 18, 0.3, 1, em.p.y);
  }

  private dustAt(fx: FxManager, em: Emitter, spread: number, size: number): void {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * spread;
    this.dust(fx, em, em.p.x + Math.cos(a) * d, em.p.y + 0.2, em.p.z + Math.sin(a) * d,
      Math.cos(a) * (0.6 + Math.random()), 0.8 + Math.random() * 1.2, Math.sin(a) * (0.6 + Math.random()), size * (0.6 + Math.random() * 0.6));
  }

  /** 전조 링 둘레의 흙먼지 — 어디까지가 위험한지 땅에서도 읽힌다. */
  private rimDust(fx: FxManager, em: Emitter): void {
    const a = Math.random() * Math.PI * 2;
    const r = em.radius * (0.92 + Math.random() * 0.12);
    this.dust(fx, em, em.p.x + Math.cos(a) * r, em.p.y + 0.15, em.p.z + Math.sin(a) * r,
      (Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.9, (Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.5);
  }

  private dust(fx: FxManager, em: Emitter, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number): void {
    this.spawnRaw(fx, x, y, z, vx, vy, vz, 0.7 + Math.random() * 0.7, size, 2.6, em.r, em.g, em.b, 0.75, 1.0, 3.2, 0.5, -1e9);
  }

  private spawnRaw(fx: FxManager, x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, size: number, sizeEnd: number, r: number, g: number, b: number, endMul: number,
    gravity: number, drag: number, alpha: number, groundY: number): void {
    S.x = x; S.y = y; S.z = z; S.vx = vx; S.vy = vy; S.vz = vz;
    S.life = life; S.size = size; S.sizeEnd = sizeEnd;
    S.r = r; S.g = g; S.b = b; S.rEnd = r * endMul; S.gEnd = g * endMul; S.bEnd = b * endMul;
    S.gravity = gravity; S.drag = drag; S.alpha = alpha; S.groundY = groundY;
    fx.alpha.spawn(S);
  }
}
