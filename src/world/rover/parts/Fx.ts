/**
 * src/world/rover/parts/Fx.ts — 탐사 차량 **예광탄 · 폭발 파편 · 잔해 연기** (R2, 2026-09-13).
 *
 * 전부 조명을 받지 않는 `MeshBasicMaterial` 이고 **점광원이 없다**. 풀은 `build` 때 한 번 만들어 씬에 늘 둔다 —
 * 숨김은 `visible` 이 아니라 크기 0 이다 (보이지 않는 가지는 셰이더 선컴파일에서 빠지고, 첫 사격 프레임이 컴파일을 떠안는다).
 * 프레임당 할당이 없다 (스크래치 행렬 · 벡터).
 */
import * as THREE from 'three';

const TRACER_POOL = 6;
const TRACER_LIFE_S = 0.07;
const DEBRIS_COUNT = 30;
const DEBRIS_LIFE_S = 1.6;
const DEBRIS_GRAVITY = 14;
const FLASH_LIFE_S = 0.45;
const FLASH_MAX_SCALE = 7;
const SMOKE_COUNT = 12;
const SMOKE_LIFE_S = 3.2;
const SMOKE_RISE_M = 3.4;
const HIDDEN = 1e-4;

export class RoverFx {
  private readonly group = new THREE.Group();
  private readonly tracers: { mesh: THREE.Mesh; until: number }[] = [];
  private readonly debris: THREE.InstancedMesh;
  private readonly debrisPos = new Float32Array(DEBRIS_COUNT * 3);
  private readonly debrisVel = new Float32Array(DEBRIS_COUNT * 3);
  private debrisAge = -1;
  private readonly flash: THREE.Mesh;
  private flashAge = -1;
  private readonly smoke: THREE.InstancedMesh;
  private smokeOn = false;
  private readonly smokeAt = new THREE.Vector3();
  private t = 0;

  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();

  constructor(parent: THREE.Object3D, geos: THREE.BufferGeometry[], mats: THREE.Material[]) {
    this.group.name = 'rover_fx';
    parent.add(this.group);

    const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    geos.push(tracerGeo);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffd98a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    mats.push(tracerMat);
    for (let i = 0; i < TRACER_POOL; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.scale.setScalar(HIDDEN);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, until: -1 });
    }

    const debrisGeo = new THREE.BoxGeometry(0.32, 0.22, 0.26);
    geos.push(debrisGeo);
    const debrisMat = new THREE.MeshBasicMaterial({ color: 0xff8a33 });
    mats.push(debrisMat);
    this.debris = new THREE.InstancedMesh(debrisGeo, debrisMat, DEBRIS_COUNT);
    this.debris.frustumCulled = false;
    this.hideAll(this.debris, DEBRIS_COUNT);
    this.group.add(this.debris);

    const flashGeo = new THREE.IcosahedronGeometry(1, 1);
    geos.push(flashGeo);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffb25a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    mats.push(flashMat);
    this.flash = new THREE.Mesh(flashGeo, flashMat);
    this.flash.scale.setScalar(HIDDEN);
    this.flash.frustumCulled = false;
    this.group.add(this.flash);

    const smokeGeo = new THREE.IcosahedronGeometry(0.6, 0);
    geos.push(smokeGeo);
    const smokeMat = new THREE.MeshBasicMaterial({ color: 0x2b2825, transparent: true, opacity: 0.45, depthWrite: false });
    mats.push(smokeMat);
    this.smoke = new THREE.InstancedMesh(smokeGeo, smokeMat, SMOKE_COUNT);
    this.smoke.frustumCulled = false;
    this.hideAll(this.smoke, SMOKE_COUNT);
    this.group.add(this.smoke);
  }

  /** 포구 → 탄착점 예광탄 한 줄. */
  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    let slot = this.tracers[0];
    for (const tr of this.tracers) if (tr.until < slot.until) slot = tr;
    const len = from.distanceTo(to);
    if (len < 0.05) return;
    slot.mesh.position.copy(from).lerp(to, 0.5);
    slot.mesh.lookAt(to);
    slot.mesh.scale.set(0.06, 0.06, len);
    slot.until = this.t + TRACER_LIFE_S;
  }

  /** 파괴 폭발 — 파편 + 화구. */
  explode(at: THREE.Vector3): void {
    this.debrisAge = 0;
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      const a = (i / DEBRIS_COUNT) * Math.PI * 2 + Math.sin(i * 12.9898) * 0.6;
      const up = 4 + ((i * 7) % 5) * 1.6;
      const out = 3 + ((i * 3) % 4) * 1.5;
      this.debrisPos[i * 3] = at.x; this.debrisPos[i * 3 + 1] = at.y + 1.2; this.debrisPos[i * 3 + 2] = at.z;
      this.debrisVel[i * 3] = Math.cos(a) * out; this.debrisVel[i * 3 + 1] = up; this.debrisVel[i * 3 + 2] = Math.sin(a) * out;
    }
    this.flashAge = 0;
    this.flash.position.set(at.x, at.y + 1.4, at.z);
  }

  /** 잔해 연기를 켠다 (레이드 내내). */
  setWreckSmoke(at: THREE.Vector3): void {
    this.smokeOn = true;
    this.smokeAt.set(at.x, at.y + 1.8, at.z);
  }

  update(dt: number): void {
    this.t += dt;
    for (const tr of this.tracers) {
      if (tr.until >= 0 && this.t >= tr.until) { tr.mesh.scale.setScalar(HIDDEN); tr.until = -1; }
    }

    if (this.debrisAge >= 0) {
      this.debrisAge += dt;
      const life = this.debrisAge / DEBRIS_LIFE_S;
      if (life >= 1) { this.debrisAge = -1; this.hideAll(this.debris, DEBRIS_COUNT); }
      else {
        const s = 1 - life;
        for (let i = 0; i < DEBRIS_COUNT; i++) {
          const k = i * 3;
          this.debrisVel[k + 1] -= DEBRIS_GRAVITY * dt;
          this.debrisPos[k] += this.debrisVel[k] * dt;
          this.debrisPos[k + 1] += this.debrisVel[k + 1] * dt;
          this.debrisPos[k + 2] += this.debrisVel[k + 2] * dt;
          this.v.set(this.debrisPos[k], this.debrisPos[k + 1], this.debrisPos[k + 2]);
          this.q.setFromEuler(this.e.set(this.debrisAge * 7 + i, this.debrisAge * 5 + i * 0.7, 0));
          this.sc.setScalar(s);
          this.debris.setMatrixAt(i, this.m4.compose(this.v, this.q, this.sc));
        }
        this.debris.instanceMatrix.needsUpdate = true;
      }
    }

    if (this.flashAge >= 0) {
      this.flashAge += dt;
      const k = this.flashAge / FLASH_LIFE_S;
      if (k >= 1) { this.flashAge = -1; this.flash.scale.setScalar(HIDDEN); }
      else this.flash.scale.setScalar(Math.max(HIDDEN, FLASH_MAX_SCALE * Math.sqrt(k) * (1 - k * 0.6)));
    }

    if (this.smokeOn) {
      this.q.identity();
      for (let i = 0; i < SMOKE_COUNT; i++) {
        const phase = ((this.t / SMOKE_LIFE_S) + i / SMOKE_COUNT) % 1;
        this.v.set(
          this.smokeAt.x + Math.sin(i * 2.3) * 0.6 + phase * 0.8,
          this.smokeAt.y + phase * SMOKE_RISE_M,
          this.smokeAt.z + Math.cos(i * 1.7) * 0.6,
        );
        const fade = phase > 0.85 ? (1 - phase) / 0.15 : 1;
        this.sc.setScalar(Math.max(HIDDEN, (0.5 + phase * 1.9) * fade));
        this.smoke.setMatrixAt(i, this.m4.compose(this.v, this.q, this.sc));
      }
      this.smoke.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.clear();
  }

  private hideAll(mesh: THREE.InstancedMesh, count: number): void {
    this.m4.makeScale(HIDDEN, HIDDEN, HIDDEN);
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, this.m4);
    mesh.instanceMatrix.needsUpdate = true;
  }
}
