/**
 * src/world/rover/parts/Body.ts — 탐사 차량 **차체 메시 · 바퀴 · 포탑 · 콜라이더 · 배치 · 잔해 모습** (R2, 2026-09-13).
 *
 * 축 규약은 전차(`rails/model`)와 같다: 로컬 +X = 전방(길이), 로컬 +Z = 폭, 루트의 Euler.y = −yaw 라 전방이
 * 월드 `(cos yaw, sin yaw)` 다 (`RoverVehicleDef.yaw`). 루트 → `tilt`(지형 피치 · 롤) → 차체 · 발광 · 포탑 · 바퀴.
 *
 * **점광원이 없다** (레이드 예산 여분 0 — CLAUDE.md 광원 규칙). 전조등 · 표시등 · 지붕 비콘은 조명을 받지 않는
 * `MeshBasicMaterial` 의 버텍스 색이라 스스로 빛나 보인다. 포구 화염도 같다.
 *
 * 콜라이더는 차체 사각 상자 하나(`Obstacle.box`, kind `rover`)이고 **`velocity` 가 없다** — 타는 발판이 아니다
 * (탑승은 차 안이고 player 가 몸을 좌석에 둔다). 매 프레임 `hash.move` 로 옮긴다.
 */
import * as THREE from 'three';
import { Layers, ROVER_HALF_LENGTH, ROVER_HALF_WIDTH, ROVER_HULL_H, type Random } from '@/shared';
import { merge, paint, paintGradient, xform } from '../../build';
import type { ObstacleEntry, SpatialHash } from '../../SpatialHash';

const KHAKI = new THREE.Color(0x7a735a);
const KHAKI_DARK = new THREE.Color(0x48452f);
const PANEL = new THREE.Color(0x5d594a);
const RUBBER = new THREE.Color(0x1d1d1c);
const RIM = new THREE.Color(0x55544c);
const GLASS = new THREE.Color(0x1c2a31);
const HEADLIGHT = new THREE.Color(0xfff0c4);
const MARKER = new THREE.Color(0xff8a2a);
const BEACON = new THREE.Color(0x5fe0ff);
/** 파괴된 차체에 곱하는 색 (버텍스 색 × 머티리얼 색). */
const WRECK_TINT = new THREE.Color(0x3b3531);

/** 바퀴 반지름(m) — 바퀴 회전각 = 주행 거리 / 이 값. */
export const ROVER_WHEEL_R = 0.55;
const WHEEL_X = [-2.55, -0.85, 0.85, 2.55];
/** 포탑 받침의 로컬 자리 (차체 윗면 위). */
const TURRET_X = 0.55;

export interface RoverBody {
  /** 위치 + yaw. */
  root: THREE.Group;
  /** 지형 피치(로컬 Z 축) · 롤(로컬 X 축). */
  tilt: THREE.Group;
  turret: THREE.Group;
  /** 포구 끝 (월드 좌표를 읽는다). */
  barrelTip: THREE.Object3D;
  muzzleFlash: THREE.Mesh;
  wheels: THREE.Mesh[];
  hullEntry: ObstacleEntry;
  hullMat: THREE.MeshStandardMaterial;
  wheelMat: THREE.MeshStandardMaterial;
  glowMat: THREE.MeshBasicMaterial;
  wheelAngle: number;
}

/** 차체를 짓는다. 만든 지오메트리 · 머티리얼은 `geos` · `mats` 에 담아 돌려준다 (`Rover.dispose` 가 버린다). */
export function buildRoverBody(hash: SpatialHash, rng: Random, geos: THREE.BufferGeometry[], mats: THREE.Material[]): RoverBody {
  const L = ROVER_HALF_LENGTH, W = ROVER_HALF_WIDTH;

  /* ── 차체 (버텍스 색 한 장) ─────────────────────────────────────────── */
  const hull: THREE.BufferGeometry[] = [];
  const box = (
    into: THREE.BufferGeometry[], sx: number, sy: number, sz: number, x: number, y: number, z: number,
    color: THREE.Color, rot?: THREE.Euler, bottom?: THREE.Color,
  ): void => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    xform(g, { x, y, z }, rot);
    if (bottom) paintGradient(g, bottom, color); else paint(g, color, 0.04, rng);
    into.push(g);
  };
  box(hull, L * 2 * 0.96, 0.9, W * 2 * 0.86, 0, 1.0, 0, KHAKI, undefined, KHAKI_DARK);        // 아래 차체
  box(hull, L * 2 * 0.84, 0.72, W * 2, -0.25, 1.81, 0, KHAKI);                                // 위 차체 (펜더 위로 넓다)
  box(hull, 1.55, 0.14, W * 2 * 0.98, L - 0.55, 1.62, 0, PANEL, new THREE.Euler(0, 0, -0.62)); // 경사 전면 장갑
  box(hull, 0.95, 0.14, W * 2 * 0.86, L - 0.22, 0.9, 0, KHAKI_DARK, new THREE.Euler(0, 0, 0.7)); // 아래 기수판
  box(hull, 0.14, 1.5, W * 2 * 0.9, -L + 0.1, 1.3, 0, KHAKI_DARK);                            // 후면판
  box(hull, 0.06, 0.95, 1.05, -L + 0.02, 1.25, 0, PANEL);                                     // 뒷문 윤곽
  for (const side of [-1, 1]) {
    box(hull, L * 2 * 0.9, 0.1, 0.34, 0, 1.2, side * (W - 0.12), KHAKI_DARK);                  // 펜더
    box(hull, L * 2 * 0.86, 0.36, 0.08, 0, 1.0, side * (W + 0.02), PANEL);                     // 옆 장갑 치마
    box(hull, 0.12, 0.12, 0.3, L - 1.25, 2.22, side * 0.55, GLASS);                            // 조종수 잠망경
    box(hull, 0.7, 0.08, 0.7, -1.4, 2.21, side * 0.6, PANEL);                                  // 지붕 해치
  }
  box(hull, 0.9, 0.35, 0.5, -1.95, 2.35, -0.85, KHAKI_DARK);                                   // 적재함
  box(hull, 0.6, 0.25, 0.12, -2.4, 1.7, W + 0.06, RUBBER);                                     // 배기구
  {
    const antenna = new THREE.CylinderGeometry(0.02, 0.025, 1.6, 5);
    xform(antenna, { x: -L + 0.7, y: 2.17 + 0.8, z: W - 0.3 });
    paint(antenna, RIM);
    hull.push(antenna);
  }
  const hullGeo = merge(hull);
  geos.push(hullGeo);
  const hullMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.32 });
  mats.push(hullMat);

  const root = new THREE.Group();
  root.name = 'rover';
  const tilt = new THREE.Group();
  root.add(tilt);
  const hullMesh = new THREE.Mesh(hullGeo, hullMat);
  hullMesh.name = 'rover_body';
  hullMesh.castShadow = true; hullMesh.receiveShadow = true;
  hullMesh.layers.enable(Layers.PROP);
  tilt.add(hullMesh);

  /* ── 발광 (전조등 · 표시등 · 비콘) — 조명을 받지 않는 버텍스 색 ─────────────── */
  const glow: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    box(glow, 0.06, 0.16, 0.3, L * 0.96 + 0.02, 1.3, side * 0.95, HEADLIGHT);
    box(glow, 0.05, 0.1, 0.14, -L + 0.02, 1.95, side * (W - 0.25), MARKER);
    box(glow, 0.14, 0.06, 0.05, L * 0.84 - 0.2, 1.72, side * (W + 0.03), MARKER);
  }
  box(glow, 0.08, 0.06, 0.5, -2.95, 2.2, 0, BEACON);
  const glowGeo = merge(glow);
  geos.push(glowGeo);
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  mats.push(glowMat);
  const glowMesh = new THREE.Mesh(glowGeo, glowMat);
  glowMesh.name = 'rover_glow';
  tilt.add(glowMesh);

  /* ── 포탑 ─────────────────────────────────────────────────────────── */
  const tur: THREE.BufferGeometry[] = [];
  {
    const ring = new THREE.CylinderGeometry(0.78, 0.86, 0.28, 14);
    xform(ring, { x: 0, y: 0.14, z: 0 });
    paint(ring, KHAKI_DARK, 0.03, rng);
    tur.push(ring);
  }
  box(tur, 1.1, 0.46, 1.0, -0.05, 0.5, 0, KHAKI, undefined, KHAKI_DARK);
  box(tur, 0.3, 0.36, 0.5, 0.55, 0.52, 0, PANEL);
  box(tur, 0.26, 0.2, 0.26, -0.1, 0.83, 0.3, GLASS);
  {
    const barrel = new THREE.CylinderGeometry(0.065, 0.078, 1.7, 8);
    xform(barrel, { x: 1.5, y: 0.52, z: 0.08 }, new THREE.Euler(0, 0, -Math.PI / 2));
    paint(barrel, RIM);
    tur.push(barrel);
    const coax = new THREE.CylinderGeometry(0.035, 0.035, 0.7, 6);
    xform(coax, { x: 1.0, y: 0.42, z: -0.17 }, new THREE.Euler(0, 0, -Math.PI / 2));
    paint(coax, RUBBER);
    tur.push(coax);
  }
  const turGeo = merge(tur);
  geos.push(turGeo);
  const turret = new THREE.Group();
  turret.name = 'rover_turret';
  turret.position.set(TURRET_X, 2.17, 0);
  const turMesh = new THREE.Mesh(turGeo, hullMat);
  turMesh.castShadow = true;
  turMesh.layers.enable(Layers.PROP);
  turret.add(turMesh);
  const barrelTip = new THREE.Object3D();
  barrelTip.position.set(2.36, 0.52, 0.08);
  turret.add(barrelTip);
  const flashGeo = new THREE.ConeGeometry(0.17, 0.6, 7);
  xform(flashGeo, { x: 0, y: 0, z: 0 }, new THREE.Euler(0, 0, -Math.PI / 2));
  geos.push(flashGeo);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffc36a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  mats.push(flashMat);
  const muzzleFlash = new THREE.Mesh(flashGeo, flashMat);
  muzzleFlash.position.set(2.66, 0.52, 0.08);
  muzzleFlash.scale.setScalar(1e-4);   // 숨김 = 크기 0 (visible 을 끄면 셰이더 선컴파일에서 빠진다)
  muzzleFlash.frustumCulled = false;
  turret.add(muzzleFlash);
  tilt.add(turret);

  /* ── 바퀴 8개 (같은 지오메트리) ──────────────────────────────────────── */
  const wheelParts: THREE.BufferGeometry[] = [];
  {
    const tire = new THREE.CylinderGeometry(ROVER_WHEEL_R, ROVER_WHEEL_R, 0.42, 16);
    xform(tire, { x: 0, y: 0, z: 0 }, new THREE.Euler(Math.PI / 2, 0, 0));
    paint(tire, RUBBER, 0.03, rng);
    wheelParts.push(tire);
    const hub = new THREE.CylinderGeometry(0.27, 0.27, 0.44, 8);
    xform(hub, { x: 0, y: 0, z: 0 }, new THREE.Euler(Math.PI / 2, 0, 0));
    paint(hub, RIM);
    wheelParts.push(hub);
    const spoke = new THREE.BoxGeometry(0.09, 0.42, 0.46);   // 도는 것이 보이게 하는 한 줄
    paint(spoke, KHAKI_DARK);
    wheelParts.push(spoke);
  }
  const wheelGeo = merge(wheelParts);
  geos.push(wheelGeo);
  const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.1 });
  mats.push(wheelMat);
  const wheels: THREE.Mesh[] = [];
  for (const wx of WHEEL_X) {
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(wheelGeo, wheelMat);
      m.position.set(wx, ROVER_WHEEL_R, side * (W - 0.2));
      m.castShadow = true;
      tilt.add(m);
      wheels.push(m);
    }
  }

  const hullEntry = hash.addBox(new THREE.Vector3(0, -9999, 0), L, W, 0, ROVER_HULL_H, 'rover');

  return { root, tilt, turret, barrelTip, muzzleFlash, wheels, hullEntry, hullMat, wheelMat, glowMat, wheelAngle: 0 };
}

/** 차체 · 콜라이더를 `(x, y, z)`(y = 노면) · `yaw` 에 놓는다. */
export function placeRoverBody(body: RoverBody, hash: SpatialHash | null, x: number, y: number, z: number, yaw: number): void {
  body.root.position.set(x, y, z);
  body.root.rotation.y = -yaw;
  hash?.move(body.hullEntry, x, y, z, yaw);
}

/** 지형 기울기 (라디안). `pitch` > 0 = 기수가 든다, `roll` > 0 = 로컬 +Z 쪽이 든다. */
export function tiltRoverBody(body: RoverBody, pitch: number, roll: number): void {
  body.tilt.rotation.set(-roll, 0, pitch);
}

/** 바퀴를 `distance` m 굴린다 (+ = 전진). */
export function spinRoverWheels(body: RoverBody, distance: number): void {
  body.wheelAngle = (body.wheelAngle + distance / ROVER_WHEEL_R) % (Math.PI * 2);
  for (const w of body.wheels) w.rotation.z = -body.wheelAngle;
}

/** 파괴된 모습 — 그을린 색 · 꺼진 등 · 비틀린 포탑. 머티리얼 색만 바꾸므로 셰이더를 다시 컴파일하지 않는다. */
export function applyRoverWreckLook(body: RoverBody): void {
  body.hullMat.color.copy(WRECK_TINT);
  body.wheelMat.color.set(0x2e2c2a);
  body.glowMat.color.set(0x1a1a1a);
  body.turret.rotation.set(0.12, body.turret.rotation.y + 0.7, -0.08);
  body.muzzleFlash.scale.setScalar(1e-4);
}
