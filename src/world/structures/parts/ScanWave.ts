/**
 * src/world/structures/parts/ScanWave.ts — **옥상 맵 스캐너의 파동** (2026-09-11).
 *
 * 사용자 요청: "옥상에서 맵 스캐너 상호작용 시, 정찰 임플란트처럼 넓은 범위로 퍼지는 파동을 발사하는 이펙트
 * (맵 범위만큼 퍼져야함)". 정찰 임플란트의 펄스(`implants/fx/ImplantFx.pulse` — 넓어지는 구 껍질)와 같은 말투로,
 * 스캐너 자리에서 **맵의 가장 먼 모서리까지** `STRUCTURE_SCAN_WAVE_S` 동안 퍼지는 구 껍질이다. 지형과 교차하는
 * 둥근 벽이 맵을 훑고 지나가며, 가장자리(프레넬)와 스캐너 높이 부근의 띠가 밝다.
 *
 * 광원은 만들지 않는다 (씬 광원 개수 규칙). 메시는 `build` 때 미리 만들어 둔다 — 셰이더 선컴파일(`world:ready` 의
 * `holdForScene`)이 숨은 메시까지 컴파일하므로 첫 스캔에서 멎지 않는다. 멀티에서는 모두의 화면에 퍼진다
 * (`Structures.applyScan` 이 누가 눌렀든 부른다).
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

  /** 지금 퍼지고 있는 파동 수 (디버그 · 스모크). */
  get activeCount(): number { let n = 0; for (const w of this.waves) if (w.active) n++; return n; }

  /** `center` 에서 맵의 가장 먼 모서리까지 퍼지는 파동 하나. 풀이 차 있으면 가장 오래된 것을 다시 쓴다. */
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
      // 처음에 빠르게 튀어나가고 맵 끝으로 갈수록 느려진다 — 그래도 끝까지 간다
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
