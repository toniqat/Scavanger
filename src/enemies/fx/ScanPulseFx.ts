import * as THREE from 'three';
import { Layers } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-11: 로든 스캔 드론의 **음파** 연출 (`ai/named/ScanDrone` 가 호스트 · 리플리카 모두에서 부른다).
 *
 * 음파 한 번 = 풀링된 메시 두 장이 `PULSE_S` 동안 `radius` 까지 퍼진다.
 *  - **원뿔 셸** — 드론(꼭짓점)에서 땅(밑면)까지 열린 원뿔. 아래로 흘러내리는 줄무늬가 "소리가 퍼진다" 를 그린다.
 *  - **바닥 띠** — 드론 바로 아래 지면 높이에 선 짧은 열린 원기둥. 세로 가운데만 밝아서 지형과 만나는 곳이
 *    **바닥을 스치는 붉은 선**으로 읽힌다 (평평한 링은 경사에서 묻히거나 뜬다).
 * 둘 다 가산 혼합 · `depthWrite: false` · `NO_RAYCAST` 이고 **광원은 없다** (루트 CLAUDE.md — 광원 개수 규칙).
 * 메시 · 머티리얼은 풀 크기만큼 한 번 만들고 `visible` 과 uniform 만 바꾼다 — 프레임당 할당 없음.
 * ──────────────────────────────────────────────────────────────────────────── */

const POOL = 4;
/** 한 번의 음파가 퍼지는 시간 (s). */
const PULSE_S = 1.15;
/** 바닥 띠의 세로 폭 (m) — 경사에서도 지면을 가로지르도록 넉넉하게. */
const BAND_H = 6;
/** 원뿔 꼭짓점 반지름 비율 (밑면 1 기준). */
const CONE_TOP = 0.03;
const PULSE_COLOR = new THREE.Color(1.0, 0.16, 0.12);

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

/** 원뿔: vUv.y 1 = 드론, 0 = 땅. 줄무늬가 아래로 흐른다. */
const CONE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uProg;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float v = vUv.y;
  float wave = pow(0.5 + 0.5 * sin(v * 22.0 + uProg * 26.0), 8.0);
  float body = smoothstep(1.0, 0.72, v) * smoothstep(0.0, 0.12, v);
  float a = (0.03 + 0.28 * wave) * body * uAlpha;
  gl_FragColor = vec4(uColor, a);
}`;

/** 바닥 띠: 세로 가운데 한 줄만 밝다. */
const BAND_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float c = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float a = (pow(c, 12.0) * 0.95 + pow(c, 2.0) * 0.12) * uAlpha;
  gl_FragColor = vec4(uColor, a);
}`;

interface Pulse {
  readonly cone: THREE.Mesh;
  readonly band: THREE.Mesh;
  readonly coneMat: THREE.ShaderMaterial;
  readonly bandMat: THREE.ShaderMaterial;
  active: boolean;
  /** ctx.time at spawn. */
  start: number;
  radius: number;
  /** Drone height above the ground at spawn (cone length). */
  height: number;
}

function makeMat(frag: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: frag,
    uniforms: { uColor: { value: PULSE_COLOR.clone() }, uProg: { value: 0 }, uAlpha: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t) * (1 - t);

export class ScanPulseFx {
  private readonly group = new THREE.Group();
  private readonly coneGeo = new THREE.CylinderGeometry(CONE_TOP, 1, 1, 48, 1, true);
  private readonly bandGeo = new THREE.CylinderGeometry(1, 1, 1, 64, 1, true);
  private readonly pulses: Pulse[] = [];
  private live = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.group.name = 'scanPulseFx';
    for (let i = 0; i < POOL; i++) {
      const coneMat = makeMat(CONE_FRAG);
      const bandMat = makeMat(BAND_FRAG);
      const cone = new THREE.Mesh(this.coneGeo, coneMat);
      const band = new THREE.Mesh(this.bandGeo, bandMat);
      for (const m of [cone, band]) {
        m.visible = false;
        m.castShadow = false;
        m.receiveShadow = false;
        m.renderOrder = 18;
        m.layers.enable(Layers.NO_RAYCAST);
        this.group.add(m);
      }
      this.pulses.push({ cone, band, coneMat, bandMat, active: false, start: 0, radius: 1, height: 1 });
    }
    scene.add(this.group);
  }

  /** Pulses currently expanding (the caller keeps ticking while > 0). */
  get activeCount(): number { return this.live; }

  /**
   * One pulse from the drone at `(x, y, z)` down to `groundY`, spreading to `radius` (m, horizontal).
   * A full pool recycles the oldest pulse.
   */
  spawn(x: number, y: number, z: number, groundY: number, radius: number, now: number): void {
    let p: Pulse | null = null;
    for (let i = 0; i < this.pulses.length; i++) {
      const q = this.pulses[i];
      if (!q.active) { p = q; break; }
      if (!p || q.start < p.start) p = q;
    }
    if (!p) return;
    if (!p.active) this.live++;
    p.active = true;
    p.start = now;
    p.radius = Math.max(1, radius);
    p.height = Math.max(1, y - groundY);
    p.cone.position.set(x, groundY + p.height * 0.5, z);
    p.band.position.set(x, groundY, z);
    p.cone.scale.set(0.01, p.height, 0.01);
    p.band.scale.set(0.01, BAND_H, 0.01);
    p.coneMat.uniforms.uAlpha.value = 0;
    p.bandMat.uniforms.uAlpha.value = 0;
    p.cone.visible = true;
    p.band.visible = true;
  }

  /** Advance every live pulse to `now` (ctx.time). Idempotent within a frame. */
  update(now: number): void {
    if (this.live === 0) return;
    for (let i = 0; i < this.pulses.length; i++) {
      const p = this.pulses[i];
      if (!p.active) continue;
      const t = (now - p.start) / PULSE_S;
      if (t >= 1 || t < 0) { this.hide(p); continue; }
      const r = Math.max(0.01, p.radius * easeOut(t));
      p.cone.scale.set(r, p.height, r);
      p.band.scale.set(r, BAND_H, r);
      const fadeIn = Math.min(1, t / 0.08);
      const fadeOut = Math.pow(1 - t, 1.3);
      p.coneMat.uniforms.uProg.value = t;
      p.coneMat.uniforms.uAlpha.value = fadeIn * fadeOut;
      p.bandMat.uniforms.uAlpha.value = fadeIn * Math.pow(1 - t, 0.8);
    }
  }

  /** Mission reset: hide everything (meshes stay pooled). */
  clear(): void {
    for (let i = 0; i < this.pulses.length; i++) if (this.pulses[i].active) this.hide(this.pulses[i]);
    this.live = 0;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    for (const p of this.pulses) { p.coneMat.dispose(); p.bandMat.dispose(); }
    this.pulses.length = 0;
    this.coneGeo.dispose();
    this.bandGeo.dispose();
  }

  private hide(p: Pulse): void {
    p.active = false;
    p.cone.visible = false;
    p.band.visible = false;
    if (this.live > 0) this.live--;
  }
}
