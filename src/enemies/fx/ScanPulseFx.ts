import * as THREE from 'three';
import { Layers } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-11: the **scan pulse** FX of Roden's scan drone (`ai/named/ScanDrone` calls it on host and replica alike).
 *
 * One pulse = two pooled meshes spreading out to `radius` over `PULSE_S`.
 *  - **Cone shell** — an open cone from the drone (apex) to the ground (base). Stripes running down it draw "the sound spreads".
 *  - **Ground band** — a short open cylinder standing at ground height right below the drone. Only its vertical middle is
 *    bright, so where it meets the terrain it reads as **a red line grazing the ground** (a flat ring sinks into a slope or floats above it).
 * Both are additively blended · `depthWrite: false` · `NO_RAYCAST`, and there are **no lights** (the root CLAUDE.md — the light-count rule).
 * The meshes · materials are created once, pool-sized, and only `visible` and the uniforms change — no per-frame allocation.
 * ──────────────────────────────────────────────────────────────────────────── */

const POOL = 4;
/** How long one pulse takes to spread (s). */
const PULSE_S = 1.15;
/** Vertical width of the ground band (m) — generous, so it still crosses the ground on a slope. */
const BAND_H = 6;
/** Cone apex radius ratio (base = 1). */
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

/** Cone: vUv.y 1 = the drone, 0 = the ground. The stripes flow downward. */
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

/** Ground band: only the one line down the vertical middle is bright. */
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
