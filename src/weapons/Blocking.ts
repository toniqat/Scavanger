import * as THREE from 'three';
import type { GameContext } from '@/shared';

const _to = new THREE.Vector3();

/**
 * Nearest shield / solid deployable stopping a bullet on the segment `origin → origin + dir*maxDist`.
 *
 * Two contracts are consulted, both optional (the implant / gadget systems are registered separately and may
 * not exist yet):
 *  - `ctx.implants.raycastBarrier(origin, dir, maxDist, fromEnemy)` — implant barriers. Allied barriers only
 *    stop **hostile** projectiles, so a local player shot (`fromEnemy = false`) passes straight through them.
 *  - `ctx.gadgets.blocksProjectile(from, to, fromEnemy)` — solid deployables (dome shield hull, barricade).
 *    These are physical walls and do stop friendly fire.
 *
 * Returns the distance from `origin` to the blocking point (written into `out`), or -1 when nothing blocks.
 * Allocation-free apart from whatever the callee returns.
 */
export function raycastBlockers(
  ctx: GameContext,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  out: THREE.Vector3,
  fromEnemy = false,
): number {
  let best = -1;
  const imp = ctx.implants;
  if (imp && typeof imp.raycastBarrier === 'function') {
    try {
      const r = imp.raycastBarrier(origin, dir, maxDist, fromEnemy);
      if (r && r.point) {
        const d = origin.distanceTo(r.point);
        if (d <= maxDist && (best < 0 || d < best)) { best = d; out.copy(r.point); }
      }
    } catch { /* a half-built implant system must never break firing */ }
  }
  const gad = ctx.gadgets;
  if (gad && typeof gad.blocksProjectile === 'function') {
    try {
      _to.copy(origin).addScaledVector(dir, maxDist);
      const p = gad.blocksProjectile(origin, _to, fromEnemy);
      if (p) {
        const d = origin.distanceTo(p);
        if (d <= maxDist && (best < 0 || d < best)) { best = d; out.copy(p); }
      }
    } catch { /* ditto for gadgets */ }
  }
  return best;
}
