/**
 * src/allies/parts/Nav.ts — **걷기**. 길찾기는 이 게임에 없다 — 적 AI 와 같은 조향 + 장애물 회피다
 * (`enemies/ai/Steering` 과 같은 얼개를 **다시 구현한다**: 다른 폴더의 내부는 import 하지 않는다 — CLAUDE.md §4.1).
 *
 * 월드 규약 (CLAUDE.md §4.4) 을 지킨다:
 *  - 바닥은 `WorldRef.getSurfaceY(x, z, feetY)`, **`resolveCollision` 보다 먼저** 부른다 (뒤집으면 낮은 턱에 못 올라선다).
 *  - 함선 안에서는 `InteriorCollider.getFloorAt` · `resolveCollision` 을 쓴다.
 *  - 막히면 옆으로 비켜 간다 (`sideT`) — 길찾기가 없으니 이것이 유일한 탈출구다.
 */
import * as THREE from 'three';
import { ALLY_TURN_RATE, PLAYER_RADIUS } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import { turnToward, yawToward } from '../model';

/** Nav 전용 스크래치 — 부르는 쪽이 `model` 의 공용 스크래치에 목적지를 담아 넘기므로 여기서 그것을 쓰면 덮어쓴다. */
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _n3 = new THREE.Vector3();

/** 근처 장애물을 다시 받는 주기 (s) — 매 프레임 `getObstaclesNear` 를 부르면 배열이 계속 생긴다. */
const OBS_REFRESH_S = 0.35;
/** 회피에 쓰는 질의 반경 (m) — 몸 반지름 + 한 걸음. 균형 수치가 아니라 질의 창이다. */
const OBS_QUERY_M = 6;
/** 같은 자리에 이만큼(s) 머물면 막힌 것으로 보고 옆으로 비킨다. */
const STUCK_S = 0.8;
/** 비켜 가는 시간 (s). */
const SIDE_S = 1.2;

/** 몸을 `target` 쪽으로 돌린다. */
export function face(a: Ally, target: THREE.Vector3, dt: number): void {
  a.yaw = turnToward(a.yaw, yawToward(a.position, target), ALLY_TURN_RATE, dt);
}

/**
 * `target` 을 향해 한 프레임 걷는다. 남은 XZ 거리를 돌려준다.
 * `avoid` 가 있으면 그 지점 반경 `avoidR` 안으로는 들어가지 않는다 (주의 핑).
 */
export function step(
  sys: AllySystem, a: Ally, target: THREE.Vector3, speed: number, dt: number,
  avoid?: THREE.Vector3 | null, avoidR = 0,
): number {
  const ctx = sys.ctx;
  const pos = a.position;
  const dx = target.x - pos.x, dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dt <= 0) return dist;
  if (dist < 1e-4) { a.velocity.set(0, 0, 0); a.moveBlend = 0; return dist; }

  // 원하는 방향
  _n1.set(dx / dist, 0, dz / dist);

  // 주의 핑: 그 자리 주변을 크게 돈다
  if (avoid && avoidR > 0) {
    const ax = pos.x - avoid.x, az = pos.z - avoid.z;
    const ad = Math.hypot(ax, az);
    if (ad < avoidR && ad > 1e-4) {
      const push = (avoidR - ad) / avoidR;
      _n1.x += (ax / ad) * push * 2;
      _n1.z += (az / ad) * push * 2;
    }
  }

  avoidObstacles(sys, a, _n1, dt);

  if (a.sideT > 0) {
    a.sideT -= dt;
    // 비켜 가기: 진행 방향의 오른쪽/왼쪽 (앞 = (x, z) 의 수직은 (z, −x)). 두 성분을 같이 읽어야 한다 —
    // x 를 먼저 덮어쓰고 z 를 계산하면 방향이 회전이 아니라 찌그러진다.
    const fx = _n1.x, fz = _n1.z;
    _n1.x = fx + fz * a.sideSign;
    _n1.z = fz - fx * a.sideSign;
  }
  if (_n1.lengthSq() < 1e-8) _n1.set(dx / dist, 0, dz / dist);
  _n1.y = 0;
  _n1.normalize();

  const s = Math.min(speed, dist / dt);
  const nx = pos.x + _n1.x * s * dt;
  const nz = pos.z + _n1.z * s * dt;

  // 지면 → 충돌 순서 (뒤집으면 낮은 턱을 못 넘는다)
  const interior = ctx.player?.interior ?? null;
  if (interior) {
    _n2.set(nx, interior.getFloorAt(nx, nz), nz);
    interior.resolveCollision(_n2, PLAYER_RADIUS);
    _n2.y = interior.getFloorAt(_n2.x, _n2.z);
  } else if (ctx.world) {
    _n2.set(nx, ctx.world.getSurfaceY(nx, nz, pos.y), nz);
    ctx.world.resolveCollision(_n2, PLAYER_RADIUS);
    _n2.y = ctx.world.getSurfaceY(_n2.x, _n2.z, pos.y);
  } else {
    _n2.set(nx, pos.y, nz);
  }

  const moved = Math.hypot(_n2.x - pos.x, _n2.z - pos.z);
  a.velocity.set((_n2.x - pos.x) / dt, 0, (_n2.z - pos.z) / dt);
  pos.copy(_n2);

  // 막힘 감지
  if (moved < s * dt * 0.25) {
    a.stuckT += dt;
    if (a.stuckT > STUCK_S && a.sideT <= 0) {
      a.sideT = SIDE_S;
      a.sideSign = a.rand.next() < 0.5 ? -1 : 1;
      a.stuckT = 0;
    }
  } else a.stuckT = 0;

  face(a, target, dt);
  const v = a.velocity.length();
  a.moveBlend = Math.min(1, v / Math.max(0.1, speed));
  a.stridePhase = (a.stridePhase + v * dt) % 1;
  return Math.hypot(target.x - pos.x, target.z - pos.z);
}

/** 제자리 — 속도 · 걸음을 0 으로 (그 자리에 선 프레임마다 부른다). */
export function halt(a: Ally): void {
  a.velocity.set(0, 0, 0);
  a.moveBlend = 0;
}

/** 지면에 다시 붙인다 (강하 착지 · 텔레포트 뒤). */
export function snapToGround(sys: AllySystem, a: Ally): void {
  const ctx = sys.ctx;
  const interior = ctx.player?.interior ?? null;
  if (interior) a.position.y = interior.getFloorAt(a.position.x, a.position.z);
  else if (ctx.world) a.position.y = ctx.world.getSurfaceY(a.position.x, a.position.z, a.position.y + 1);
}

function avoidObstacles(sys: AllySystem, a: Ally, dir: THREE.Vector3, dt: number): void {
  const world = sys.ctx.world;
  if (!world) return;
  a.obsT -= dt;
  if (a.obsT <= 0) {
    a.obsT = OBS_REFRESH_S;
    a.nearObs = world.getObstaclesNear(a.position.x, a.position.z, OBS_QUERY_M);
  }
  const pos = a.position;
  for (const o of a.nearObs) {
    _n3.set(o.position.x - pos.x, 0, o.position.z - pos.z);
    const d = _n3.length();
    const clearance = o.radius + PLAYER_RADIUS + 0.4;
    if (d < 1e-4 || d > clearance + 2.5) continue;
    const ahead = (_n3.x * dir.x + _n3.z * dir.z) / d;
    if (ahead < 0.2) continue;
    const side = dir.z * _n3.x - dir.x * _n3.z;
    if (Math.abs(side) > clearance) continue;
    const strength = (1 - d / (clearance + 2.5)) * ahead;
    const sgn = side >= 0 ? -1 : 1;
    const fx = dir.x, fz = dir.z;
    dir.x = fx + fz * sgn * strength;
    dir.z = fz - fx * sgn * strength;
  }
}

/** 하네스 안의 한 점 — `center` 주변 `radius` 안에서 `want` 에 가장 가까운 지점을 `out` 에 쓴다. */
export function clampToHarness(center: THREE.Vector3, radius: number, want: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const dx = want.x - center.x, dz = want.z - center.z;
  const d = Math.hypot(dx, dz);
  if (d <= radius || d < 1e-4) return out.copy(want);
  return out.set(center.x + (dx / d) * radius, want.y, center.z + (dz / d) * radius);
}
