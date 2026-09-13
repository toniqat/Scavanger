/**
 * src/world/rover/parts/Turret.ts — 탐사 차량 **포탑** (R2, 2026-09-13).
 *
 * - `updateTurretVisual` — 모든 클라이언트: 조준점(없으면 차체 정면)으로 포탑을 돌리고 포구 화염을 켜고 끈다.
 *   리플리카는 표적을 모르므로 호스트의 `rover fire {p}` 탄착점을 조준점으로 삼는다.
 * - `updateTurretLogic` — **권위(싱글 · 호스트)만**, 달리는 중(`patrol` · `trip`)에만: 사거리 `ROVER_TURRET_RANGE` 안의
 *   가장 가까운 살아 있는 적 중 시야가 트인 것을 골라 돌고, 조준 원추 안이면 쏜다. 피해는 `EnemyRef.takeDamage(…,
 *   ROVER_DAMAGE_SOURCE)` — enemies 가 킬 크레딧 없이 차량에 어그로를 건다. **플레이어는 절대 맞지 않는다.**
 */
import * as THREE from 'three';
import {
  ROVER_DAMAGE_SOURCE, ROVER_TURRET_AIM_CONE, ROVER_TURRET_DAMAGE, ROVER_TURRET_INTERVAL_S, ROVER_TURRET_RANGE,
  ROVER_TURRET_RETARGET_S, ROVER_TURRET_TURN_RATE,
  type EnemyRef, type GameContext, type WorldRef,
} from '@/shared';
import { angleDelta } from '../model';
import type { RoverBody } from './Body';

/** 조준점이 이만큼(초) 지나면 포탑이 정면으로 돌아간다. */
const AIM_HOLD_S = 0.8;
/** 포구 화염이 켜져 있는 시간(초). */
const FLASH_S = 0.05;
/** 시야 레이는 포탑에서 이만큼(m) 앞에서 시작한다 — 차체 자기 콜라이더를 치지 않게. */
const LOS_SKIP_M = 4.4;

export interface TurretState {
  /** 포탑의 월드 yaw (차체 yaw 규약). */
  worldYaw: number;
  targetId: number | null;
  retarget: number;
  fireTimer: number;
  readonly aim: THREE.Vector3;
  /** 이 시각(`ctx.time`)까지 `aim` 을 겨눈다. */
  aimUntil: number;
  flashUntil: number;
}

export function makeTurretState(): TurretState {
  return { worldYaw: 0, targetId: null, retarget: 0, fireTimer: 0, aim: new THREE.Vector3(), aimUntil: -Infinity, flashUntil: -Infinity };
}

const _pivot = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

/** 모든 클라이언트: 포탑 회전 · 포구 화염. */
export function updateTurretVisual(ts: TurretState, body: RoverBody, hullYaw: number, now: number, dt: number): void {
  body.turret.getWorldPosition(_pivot);
  const want = now < ts.aimUntil ? Math.atan2(ts.aim.z - _pivot.z, ts.aim.x - _pivot.x) : hullYaw;
  const d = angleDelta(ts.worldYaw, want);
  const step = ROVER_TURRET_TURN_RATE * dt;
  ts.worldYaw += Math.max(-step, Math.min(step, d));
  body.turret.rotation.y = -(ts.worldYaw - hullYaw);
  body.muzzleFlash.scale.setScalar(now < ts.flashUntil ? 1 : 1e-4);
}

/** 리플리카가 호스트의 사격 한 발을 받았다 — 조준점 · 포구 화염만. 포구 월드 좌표를 `outMuzzle` 에 쓴다. */
export function applyRemoteShot(ts: TurretState, body: RoverBody, p: THREE.Vector3, now: number, outMuzzle: THREE.Vector3): void {
  ts.aim.copy(p);
  ts.aimUntil = now + AIM_HOLD_S;
  ts.flashUntil = now + FLASH_S;
  body.barrelTip.getWorldPosition(outMuzzle);
}

/**
 * 권위: 표적 고르기 · 조준 · 사격. `fire(from, to)` 는 한 발마다 불린다 (연출 · 방송 · 이벤트는 `Rover` 가 한다).
 * `from` · `to` 는 스크래치다 — 보관하지 않는다.
 */
export function updateTurretLogic(
  game: GameContext, ts: TurretState, body: RoverBody, dt: number, now: number,
  fire: (from: THREE.Vector3, to: THREE.Vector3) => void,
): void {
  ts.fireTimer -= dt;
  ts.retarget -= dt;
  const enemies = game.enemies, world = game.world;
  if (!enemies || !world) return;
  body.turret.getWorldPosition(_pivot);
  _pivot.y += 0.5;

  let target: EnemyRef | null = null;
  if (ts.retarget <= 0 || ts.targetId === null) {
    ts.retarget = ROVER_TURRET_RETARGET_S;
    let best = Infinity;
    const near = enemies.queryNear(_pivot, ROVER_TURRET_RANGE);
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      if (e.isDead) continue;
      const d2 = e.position.distanceToSquared(_pivot);
      if (d2 >= best) continue;
      if (!lineOfSight(world, _pivot, e)) continue;
      best = d2;
      target = e;
    }
    ts.targetId = target ? target.id : null;
  } else {
    const near = enemies.queryNear(_pivot, ROVER_TURRET_RANGE + 2);
    for (let i = 0; i < near.length; i++) if (near[i].id === ts.targetId) { target = near[i]; break; }
    if (!target || target.isDead) { ts.targetId = null; target = null; }
  }
  if (!target) return;

  _tgt.copy(target.position);
  _tgt.y += target.height * 0.55;
  ts.aim.copy(_tgt);
  ts.aimUntil = now + AIM_HOLD_S;
  const want = Math.atan2(_tgt.z - _pivot.z, _tgt.x - _pivot.x);
  if (Math.abs(angleDelta(ts.worldYaw, want)) > ROVER_TURRET_AIM_CONE || ts.fireTimer > 0) return;
  if (!lineOfSight(world, _pivot, target)) { ts.targetId = null; return; }

  ts.fireTimer = ROVER_TURRET_INTERVAL_S;
  ts.flashUntil = now + FLASH_S;
  body.barrelTip.getWorldPosition(_muzzle);
  _dir.subVectors(_tgt, _muzzle).normalize();
  target.takeDamage(ROVER_TURRET_DAMAGE, _tgt.clone(), _dir.clone(), ROVER_DAMAGE_SOURCE);
  fire(_muzzle, _tgt);
}

/** 포탑 → 적 몸 가운데까지 지형 · 장애물이 막지 않는가. 차체를 벗어난 곳에서 레이를 시작한다. */
function lineOfSight(world: WorldRef, from: THREE.Vector3, e: EnemyRef): boolean {
  _tgt.copy(e.position);
  _tgt.y += e.height * 0.55;
  _dir.subVectors(_tgt, from);
  const dist = _dir.length();
  if (dist <= LOS_SKIP_M) return true;
  _dir.divideScalar(dist);
  _origin.copy(from).addScaledVector(_dir, LOS_SKIP_M);
  const hit = world.raycast(_origin, _dir, dist - LOS_SKIP_M);
  return !hit || hit.distance >= dist - LOS_SKIP_M - e.radius - 0.4;
}
