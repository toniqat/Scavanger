/**
 * src/world/rover/parts/Exits.ts — **picking the exit spots** (R2, 2026-09-13).
 *
 * It walks the candidate spots beside · behind · in front of the body in order and takes `count` of them: those where, standing at
 * the underfoot height (`getSurfaceY`), `resolveCollision` barely pushes (not inside another collider) and which do not overlap one
 * already picked. Too few, and it fills up with spots stepped further out beside the car (no collision check — nobody being left inside the car comes first).
 * The host picks them and sends them in `rover reply.exit` · `rover eject.exits`.
 */
import * as THREE from 'three';
import { PLAYER_RADIUS, ROVER_EXIT_GAP_M, ROVER_HALF_LENGTH, ROVER_HALF_WIDTH, type RoverVehicleDef, type WorldRef } from '@/shared';

/** When `resolveCollision` pushes further than this (m), that candidate is inside another object. */
const MAX_PUSH_M = 0.15;
/** The minimum distance between two exit spots (m). */
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
