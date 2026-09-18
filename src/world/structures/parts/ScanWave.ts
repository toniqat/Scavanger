/**
 * src/world/structures/parts/ScanWave.ts — **the roof map scanner's wave** (2026-09-11).
 *
 * User's request: "interacting with the map scanner on the roof fires an effect that spreads out over a wide area
 * like the recon implant (it has to reach as far as the map)". In the same voice as the recon implant's pulse
 * (`implants/fx/ImplantFx.pulse` — a widening sphere shell): a sphere shell that spreads from the scanner's spot
 * **to the map's farthest corner** over `STRUCTURE_SCAN_WAVE_S`. A round wall intersecting the terrain sweeps across
 * the map, bright at the edge (fresnel) and in a band near the scanner's height.
 *
 * It creates no light (the scene point-light count rule). The mesh is built ahead of time in `build` — shader
 * pre-compile (`holdForScene` on `world:ready`) compiles hidden meshes too, so the first scan does not stall. In
 * multiplayer it spreads on everyone's screen (`Structures.applyScan` calls it whoever pressed).
 */
import * as THREE from 'three';
import { Layers, MAP_SIZE, STRUCTURE_SCAN_WAVE_S } from '@/shared';

const POOL = 3;
const COLOR = new THREE.Color(0x66ccff);

const VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
varying float vY;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vY = wp.y;
  vec4 mv = viewMatrix * wp;
  vV = -mv.xyz;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform float uCenterY;
varying vec3 vN;
varying vec3 vV;
varying float vY;
void main() {
  float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float edge = pow(rim, 3.0);
  float band = exp(-abs(vY - uCenterY) / 22.0);
  float a = (edge * 0.9 + band * 0.35 + 0.04) * uAlpha;
  gl_FragColor = vec4(uColor * a, a);
}`;

interface Wave { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; t: number; rMax: number; active: boolean }

export class ScanWave {
  readonly group = new THREE.Group();
  private readonly geo = new THREE.SphereGeometry(1, 64, 32);
  private readonly waves: Wave[] = [];

  constructor() {
    this.group.name = 'ScanWaves';
    for (let i = 0; i < POOL; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG,
        uniforms: { uColor: { value: COLOR.clone() }, uAlpha: { value: 0 }, uCenterY: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.name = 'scan_wave';
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 5;
      mesh.layers.enable(Layers.NO_RAYCAST);
      this.group.add(mesh);
      this.waves.push({ mesh, mat, t: 0, rMax: 1, active: false });
    }
  }

  /** How many waves are spreading right now (debug · smoke). */
  get activeCount(): number { let n = 0; for (const w of this.waves) if (w.active) n++; return n; }

  /** One wave spreading from `center` to the map's farthest corner. With the pool full the oldest one is reused. */
  fire(center: THREE.Vector3): void {
    let w = this.waves.find((x) => !x.active);
    if (!w) w = this.waves.reduce((a, b) => (a.t >= b.t ? a : b));
    const h = MAP_SIZE / 2;
    let rMax = 0;
    for (const sx of [-h, h]) for (const sz of [-h, h]) rMax = Math.max(rMax, Math.hypot(sx - center.x, sz - center.z));
    w.rMax = rMax + 20;
    w.t = 0;
    w.active = true;
    w.mesh.position.copy(center);
    w.mesh.scale.setScalar(0.5);
    w.mat.uniforms.uCenterY.value = center.y;
    w.mat.uniforms.uAlpha.value = 1;
    w.mesh.visible = true;
  }

  update(dt: number): void {
    const dur = Math.max(0.5, STRUCTURE_SCAN_WAVE_S);
    for (const w of this.waves) {
      if (!w.active) continue;
      w.t += dt;
      const p = Math.min(1, w.t / dur);
      // Shoots out fast at first and slows toward the map edge — it still reaches the end
      const e = 1 - Math.pow(1 - p, 2.2);
      w.mesh.scale.setScalar(Math.max(0.5, w.rMax * e));
      w.mat.uniforms.uAlpha.value = Math.pow(1 - p, 0.8);
      if (p >= 1) { w.active = false; w.mesh.visible = false; }
    }
  }

  dispose(): void {
    for (const w of this.waves) w.mat.dispose();
    this.waves.length = 0;
    this.geo.dispose();
    this.group.clear();
    this.group.removeFromParent();
  }
}
