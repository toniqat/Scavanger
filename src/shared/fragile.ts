/**
 * src/shared/fragile.ts — the one line that lets a throwable **break a fragile pane (window glass) and pass through** (2026-09-11).
 *
 * A bullet breaks glass down the existing `hit.obstacle.destructible.onDamage` path in `weapons/`. A grenade, a thrown
 * gadget and a rogue's grenade, though, collide through `world.resolveCollision` (pushing a circle out) rather than a
 * ray, so all they do on glass is **bounce**. Those three sweep their own flight segment through this function once per
 * step — three folders (weapons · gadgets · enemies) have to use the same rule, so it lives in `shared`
 * (CLAUDE.md: the same thing in two folders moves to shared).
 *
 * A broken pane is turned by world into a frame that rays and small bodies pass through right away
 * (`world/structures/parts/Glass`), so the `resolveCollision` of that same step no longer pushes it out — the throwable
 * goes through the window without losing speed.
 */
import * as THREE from 'three';
import type { WorldRef } from './types';

const _d = new THREE.Vector3();

/** Breaks every fragile pane on the segment `from → to` (at most 3). True when at least one broke. */
export function breakFragileAlong(world: WorldRef, from: THREE.Vector3, to: THREE.Vector3): boolean {
  _d.subVectors(to, from);
  const len = _d.length();
  if (len < 1e-4) return false;
  _d.divideScalar(len);
  let broke = false;
  for (let i = 0; i < 3; i++) {
    const hit = world.raycast(from, _d, len + 0.05);
    const o = hit?.obstacle;
    if (!hit || !o || !o.fragile || !o.destructible) break;
    o.destructible.onDamage(1, hit.point);
    broke = true;
  }
  return broke;
}
