/**
 * src/world/rover/parts/Exits.ts — **하차 자리 고르기** (R2, 2026-09-13).
 *
 * 차체 옆 · 뒤 · 앞의 후보 자리를 순서대로 보고, 발밑 높이(`getSurfaceY`)에 세웠을 때 `resolveCollision` 이 거의 밀지 않고
 * (다른 콜라이더 안이 아니다) 이미 고른 자리와 겹치지 않는 것을 `count` 개 고른다. 모자라면 차 옆으로 조금씩 멀리
 * 물러난 자리로 채운다 (충돌 검사 없이 — 누구도 차 안에 남지 않는 것이 먼저다).
 * 호스트가 고르고 `rover reply.exit` · `rover eject.exits` 로 보낸다.
 */
import * as THREE from 'three';
import { PLAYER_RADIUS, ROVER_EXIT_GAP_M, ROVER_HALF_LENGTH, ROVER_HALF_WIDTH, type RoverVehicleDef, type WorldRef } from '@/shared';

/** `resolveCollision` 이 이만큼(m) 넘게 밀면 그 후보는 다른 물체 안이다. */
const MAX_PUSH_M = 0.15;
/** 두 하차 자리 사이 최소 거리(m). */
const MIN_APART_M = 0.95;

const _p = new THREE.Vector3();

export function pickExitSpots(world: WorldRef | null, def: RoverVehicleDef, count: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  if (count <= 0) return out;
  const c = Math.cos(def.yaw), s = Math.sin(def.yaw);
  const side = ROVER_HALF_WIDTH + ROVER_EXIT_GAP_M + PLAYER_RADIUS;
  const end = ROVER_HALF_LENGTH + ROVER_EXIT_GAP_M + PLAYER_RADIUS;
  const cands: Array<[number, number]> = [
    [0, side], [0, -side], [-1.9, side], [-1.9, -side], [1.9, side], [1.9, -side],
    [-end, 0], [-end, 1.2], [-end, -1.2], [end, 0],
    [0, side + 1.4], [0, -side - 1.4], [-1.9, side + 1.4], [-1.9, -side - 1.4],
  ];
  const at = (lx: number, lz: number): [number, number] => [def.position.x + lx * c - lz * s, def.position.z + lx * s + lz * c];
  const apart = (x: number, z: number): boolean => out.every((o) => Math.hypot(o.x - x, o.z - z) >= MIN_APART_M);

  for (const [lx, lz] of cands) {
    if (out.length >= count) break;
    const [x, z] = at(lx, lz);
    if (!apart(x, z)) continue;
    if (!world) { out.push(new THREE.Vector3(x, def.position.y, z)); continue; }
    const y = world.getSurfaceY(x, z, def.position.y + 0.6);
    const r = world.resolveCollision(_p.set(x, y, z), PLAYER_RADIUS);
    if (Math.hypot(r.x - x, r.z - z) > MAX_PUSH_M) continue;
    out.push(new THREE.Vector3(x, y, z));
  }
  for (let k = 0; out.length < count; k++) {
    const sign = k % 2 === 0 ? 1 : -1;
    const [x, z] = at(-1.9 + (k % 3) * 1.9, sign * (side + 2.5 + k * 0.6));
    const y = world ? world.getSurfaceY(x, z, def.position.y + 0.6) : def.position.y;
    out.push(new THREE.Vector3(x, y, z));
  }
  return out;
}
