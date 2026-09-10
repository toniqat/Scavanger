/**
 * src/world/obb.ts — **사각(OBB) 콜라이더** 수학 (2026-09-09).
 *
 * 왜 있나: 건물 벽 · 전차 차체는 원기둥으로 흉내낼 수 없다. 벽 하나를 원기둥 열 개로 쪼개면(예전 `Outposts`)
 * 그려진 판보다 두툼한 톱니가 되고, 하나로 감싸면 방 전체가 막힌다. 그래서 `Obstacle.box`(계약, 2026-09-09)를
 * 두고 **밀어내기 · 레이 · 윗면 판정** 세 곳에서만 다르게 푼다. `SpatialHash` 버킷팅과 광역 질의는 그대로
 * `radius`(외접원)를 쓰므로 상자는 절대 버킷에서 새지 않는다 — `boxRadius()` 가 그 외접원이다.
 *
 * ⚠ 여기의 함수는 **`o.box` 가 있을 때만** 불린다. 원기둥 소품의 경로는 `WorldSystem` 안에 그대로 남아 있어
 * 2026-09-09 이전과 한 줄도 다르지 않다.
 */
import type * as THREE from 'three';
import { BOX_HEADROOM as SHARED_BOX_HEADROOM, type Obstacle } from '@/shared';

/**
 * 상자 콜라이더는 **떠 있을 수 있다** (지하실 천장 슬래브 · 전차 데크 · 플랫폼 데크). 머리 위로 이만큼(m)
 * 넘게 떠 있는 판은 밀어내지 않는다 — 지하실 안에서 천장에 밀려 벽으로 빨려 나가지 않게 하는 판정이다.
 * 원기둥에는 이 판정이 없다 (전부 땅에서 올라오므로 켜질 일이 없고, 켜면 기존 동작이 바뀐다).
 */
export const BOX_HEADROOM = SHARED_BOX_HEADROOM;   // 2026-09-11: 값은 `data/constants.csv` — player 의 천장 클램프와 같은 값

/** 상자를 감싸는 외접원 반경 — `Obstacle.radius` 에 넣어야 하는 값이다. */
export function boxRadius(halfX: number, halfZ: number): number {
  return Math.hypot(halfX, halfZ);
}

/** 월드 XZ → 상자 로컬 XZ (yaw 만큼 역회전). 결과는 `outLocal` 에 쓴다. */
function toLocal(o: Obstacle, x: number, z: number, outLocal: { x: number; z: number }): void {
  const b = o.box!;
  const dx = x - o.position.x, dz = z - o.position.z;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  outLocal.x = dx * c + dz * s;
  outLocal.z = -dx * s + dz * c;
}

/* 핫 패스에서 프레임당 할당을 하지 않으려는 스크래치 (월드 생성/질의는 단일 스레드다). */
const L = { x: 0, z: 0 };

/**
 * `(x, z)` 가 상자 단면 안인가 (`margin` 만큼 넉넉히). `getSurfaceY` · `getStandingObstacle` 이
 * 외접원 대신 이걸 봐야 벽 모서리 바깥의 허공에 올라서지 않는다.
 */
export function boxContainsXZ(o: Obstacle, x: number, z: number, margin = 0): boolean {
  const b = o.box!;
  toLocal(o, x, z, L);
  return Math.abs(L.x) <= b.halfX + margin && Math.abs(L.z) <= b.halfZ + margin;
}

/**
 * 반지름 `radius` 원을 상자 밖으로 밀어낸다 (`position` 을 제자리에서 고친다). 겹치지 않으면 false.
 * 원 중심이 상자 **안**이면 가장 얕은 면으로 빼낸다 — 문틀을 스치며 지나갈 때 옆으로 튕기지 않게.
 */
export function boxPushOut(o: Obstacle, position: THREE.Vector3, radius: number): boolean {
  const b = o.box!;
  toLocal(o, position.x, position.z, L);
  const lx = L.x, lz = L.z;
  const qx = lx < -b.halfX ? -b.halfX : lx > b.halfX ? b.halfX : lx;
  const qz = lz < -b.halfZ ? -b.halfZ : lz > b.halfZ ? b.halfZ : lz;
  let ux = lx - qx, uz = lz - qz;
  const d2 = ux * ux + uz * uz;
  if (d2 > radius * radius) return false;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    const push = radius - d;
    ux = (ux / d) * push;
    uz = (uz / d) * push;
  } else {
    // 중심이 상자 안 — 가장 가까운 면으로
    const penX = b.halfX - Math.abs(lx);
    const penZ = b.halfZ - Math.abs(lz);
    if (penX <= penZ) { ux = (lx >= 0 ? 1 : -1) * (penX + radius); uz = 0; }
    else { ux = 0; uz = (lz >= 0 ? 1 : -1) * (penZ + radius); }
  }
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  position.x += ux * c - uz * s;
  position.z += ux * s + uz * c;
  return true;
}

/** `rayBox` 가 채우는 법선 (호출자가 바로 읽고 쓴다 — 보관 금지). */
export const boxHitNormal = { x: 0, y: 1, z: 0 };

/**
 * 레이 vs 상자 (y 는 `[position.y, position.y + height]` 슬래브). 맞으면 `t`, 아니면 −1.
 * 법선은 `boxHitNormal` 에 쓴다. 원기둥과 같은 규약: **원점이 이미 안이면 맞지 않은 것**으로 친다
 * (벽에 파묻힌 총구가 자기 벽을 때리지 않게).
 */
export function rayBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  o: Obstacle, maxT: number,
): number {
  const b = o.box!;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const rx = ox - o.position.x, rz = oz - o.position.z;
  const lox = rx * c + rz * s, loz = -rx * s + rz * c;
  const ldx = dx * c + dz * s, ldz = -dx * s + dz * c;
  const base = o.position.y, top = o.position.y + o.height;
  if (top <= base) return -1;

  let tmin = -Infinity, tmax = Infinity;
  let axis = 0, sign = 1;                       // 0 = X, 1 = Y, 2 = Z (로컬 축)

  // X 슬래브
  if (Math.abs(ldx) < 1e-8) { if (lox < -b.halfX || lox > b.halfX) return -1; }
  else {
    let t0 = (-b.halfX - lox) / ldx, t1 = (b.halfX - lox) / ldx;
    let sg = -1;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; sg = 1; }
    if (t0 > tmin) { tmin = t0; axis = 0; sign = sg; }
    if (t1 < tmax) tmax = t1;
  }
  // Z 슬래브
  if (Math.abs(ldz) < 1e-8) { if (loz < -b.halfZ || loz > b.halfZ) return -1; }
  else {
    let t0 = (-b.halfZ - loz) / ldz, t1 = (b.halfZ - loz) / ldz;
    let sg = -1;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; sg = 1; }
    if (t0 > tmin) { tmin = t0; axis = 2; sign = sg; }
    if (t1 < tmax) tmax = t1;
  }
  // Y 슬래브 (회전하지 않는다)
  if (Math.abs(dy) < 1e-8) { if (oy < base || oy > top) return -1; }
  else {
    let t0 = (base - oy) / dy, t1 = (top - oy) / dy;
    let sg = -1;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; sg = 1; }
    if (t0 > tmin) { tmin = t0; axis = 1; sign = sg; }
    if (t1 < tmax) tmax = t1;
  }

  if (tmin > tmax || tmin < 0 || tmin > maxT) return -1;
  if (axis === 1) { boxHitNormal.x = 0; boxHitNormal.y = sign; boxHitNormal.z = 0; }
  else {
    const nx = axis === 0 ? sign : 0, nz = axis === 2 ? sign : 0;
    boxHitNormal.x = nx * c - nz * s;
    boxHitNormal.y = 0;
    boxHitNormal.z = nx * s + nz * c;
  }
  return tmin;
}

/* ── 경사 발판 (2026-09-11, `Obstacle.ramp`) ─────────────────────────────────────────────────────────────
 * 계단의 콜라이더. **보이는 것은 계단, 밟는 것은 경사면**이라 한 단마다 발이 튀어 오르지 않는다 (사용자 요청
 * "계단을 뚝뚝 끊기지 않고 스르륵"). 상자(`o.box`)와 같은 OBB 이고 윗면만 로컬 +X 로 기울어 있다:
 * `x = -halfX` 에서 `position.y + height - rise`, `x = +halfX` 에서 `position.y + height`.
 * ⚠ `o.ramp` 가 있을 때만 불린다 — 평평한 상자의 경로(`rayBox` · `boxPushOut`)는 한 줄도 바뀌지 않았다. */

/** `(x, z)` 에서의 경사면 높이. 상자 단면 밖이면 가장 가까운 가장자리(로컬 X 로 자른 자리)의 높이다. */
export function rampTopAt(o: Obstacle, x: number, z: number): number {
  const b = o.box!, r = o.ramp!;
  toLocal(o, x, z, L);
  const lx = L.x < -b.halfX ? -b.halfX : L.x > b.halfX ? b.halfX : L.x;
  const t = b.halfX > 1e-6 ? (lx + b.halfX) / (2 * b.halfX) : 1;
  return o.position.y + o.height - r.rise + r.rise * t;
}

/* 로컬 반공간 6 장: ±X · ±Z · 밑면 · 기운 윗면. `n·p <= d` 가 안쪽이다. */
const RP_N = new Float32Array(18);
const RP_D = new Float32Array(6);

/**
 * 레이 vs 경사 발판 (쐐기). 맞으면 `t`, 아니면 −1. 법선은 `boxHitNormal` 에 쓴다 (`rayBox` 와 같은 자리).
 * 원점이 이미 안이면 −1 — 다른 콜라이더와 같은 규약.
 */
export function rayRamp(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  o: Obstacle, maxT: number,
): number {
  const b = o.box!, r = o.ramp!;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const rx = ox - o.position.x, rz = oz - o.position.z;
  const lox = rx * c + rz * s, loz = -rx * s + rz * c;
  const ldx = dx * c + dz * s, ldz = -dx * s + dz * c;
  const base = o.position.y;
  const k = b.halfX > 1e-6 ? r.rise / (2 * b.halfX) : 0;
  const cTop = base + o.height - r.rise / 2;
  RP_N[0] = 1; RP_N[1] = 0; RP_N[2] = 0;
  RP_N[3] = -1; RP_N[4] = 0; RP_N[5] = 0;
  RP_N[6] = 0; RP_N[7] = 0; RP_N[8] = 1;
  RP_N[9] = 0; RP_N[10] = 0; RP_N[11] = -1;
  RP_N[12] = 0; RP_N[13] = -1; RP_N[14] = 0;
  RP_N[15] = -k; RP_N[16] = 1; RP_N[17] = 0;
  RP_D[0] = b.halfX; RP_D[1] = b.halfX; RP_D[2] = b.halfZ; RP_D[3] = b.halfZ; RP_D[4] = -base; RP_D[5] = cTop;
  let tE = -Infinity, tL = Infinity, hit = -1;
  for (let i = 0; i < 6; i++) {
    const nx = RP_N[i * 3], ny = RP_N[i * 3 + 1], nz = RP_N[i * 3 + 2];
    const num = RP_D[i] - (nx * lox + ny * oy + nz * loz);
    const den = nx * ldx + ny * dy + nz * ldz;
    if (Math.abs(den) < 1e-9) { if (num < 0) return -1; continue; }
    const t = num / den;
    if (den < 0) { if (t > tE) { tE = t; hit = i; } }
    else if (t < tL) tL = t;
    if (tE > tL) return -1;
  }
  if (hit < 0 || tE < 0 || tE > maxT) return -1;
  const nx = RP_N[hit * 3], ny = RP_N[hit * 3 + 1], nz = RP_N[hit * 3 + 2];
  const len = Math.hypot(nx, ny, nz) || 1;
  boxHitNormal.x = (nx * c - nz * s) / len;
  boxHitNormal.y = ny / len;
  boxHitNormal.z = (nx * s + nz * c) / len;
  return tE;
}
