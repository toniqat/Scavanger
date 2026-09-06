import * as THREE from 'three';
import type { GameContext, PeerId } from '@/shared';

const _to = new THREE.Vector3();

/** Which blocker stopped the segment (Phase 9): filled by `raycastBlockers` when the caller passes an `info` object. */
export interface BlockInfo {
  /** `'barrier'` = an implant barrier (`owner` set), `'gadget'` = a solid deployable, null = nothing blocked. */
  kind: 'barrier' | 'gadget' | null;
  owner: PeerId | 'local' | null;
}

export function makeBlockInfo(): BlockInfo { return { kind: null, owner: null }; }

/**
 * Nearest shield / solid deployable stopping a bullet on the segment `origin → origin + dir*maxDist`.
 *
 * Two contracts are consulted, both optional (the implant / gadget systems are registered separately and may
 * not exist yet):
 *  - `ctx.implants.raycastBarrier(origin, dir, maxDist, fromEnemy)` — implant barriers. Allied barriers only
 *    stop **hostile** projectiles, so a local player shot (`fromEnemy = false`) passes straight through them.
 *    **Pure query** since Phase 9: it never damages the barrier. A caller whose shot really stopped there calls
 *    `damageBlocker()` (→ `ctx.implants.damageBarrier`) exactly once — line-of-sight tests must not.
 *  - `ctx.gadgets.blocksProjectile(from, to, fromEnemy)` — solid deployables (dome shield hull, barricade).
 *    These are physical walls and do stop friendly fire.
 *
 * Returns the distance from `origin` to the blocking point (written into `out`), or -1 when nothing blocks.
 * `info` (optional) receives which blocker won. Allocation-free apart from whatever the callee returns.
 */
export function raycastBlockers(
  ctx: GameContext,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  out: THREE.Vector3,
  fromEnemy = false,
  info?: BlockInfo,
): number {
  let best = -1;
  if (info) { info.kind = null; info.owner = null; }
  const imp = ctx.implants;
  if (imp && typeof imp.raycastBarrier === 'function') {
    try {
      const r = imp.raycastBarrier(origin, dir, maxDist, fromEnemy);
      if (r && r.point) {
        const d = origin.distanceTo(r.point);
        if (d <= maxDist && (best < 0 || d < best)) {
          best = d; out.copy(r.point);
          if (info) { info.kind = 'barrier'; info.owner = r.owner ?? 'local'; }
        }
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
        if (d <= maxDist && (best < 0 || d < best)) {
          best = d; out.copy(p);
          if (info) { info.kind = 'gadget'; info.owner = null; }
        }
      }
    } catch { /* ditto for gadgets */ }
  }
  return best;
}

/**
 * Phase 9: apply the block damage of a shot that really ended on an implant barrier (`owner` from `BlockInfo` /
 * `HitInfo.barrierOwner`). Call it once per resolved hit — never from speculative queries (aim probes, LOS tests).
 * Solid deployables (gadgets) take no damage from bullets here (unchanged).
 */
export function damageBarrierAt(ctx: GameContext, owner: PeerId | 'local' | null | undefined, point: THREE.Vector3): void {
  if (!owner) return;
  const imp = ctx.implants;
  if (!imp || typeof imp.damageBarrier !== 'function') return;
  try { imp.damageBarrier(owner, point); } catch { /* never break the shot */ }
}
