/**
 * src/world/nav/parts/Remeasure.ts — **the cells under a collider that changed** (TODO A-18).
 *
 * `SpatialHash.onChange` reports the circle of every collider inserted, removed or really moved: a locked door opening
 * (its panel leaves the hash), a barricade · dome · turret going up or down (`WorldRef.addObstacle`), a mineral vein
 * mined out, the tram and the rover driving. The cells and region columns under that circle are queued once each and
 * measured again at `NAV_REMEASURE_HZ` within `NAV_REMEASURE_BUDGET_MS`; what does not fit waits for the next pass.
 *
 * An outdoor cell is measured from scratch (a deck that drove in is a new floor); a region node keeps its floor and
 * only re-checks whether a body still fits on it — the floors of a building never move, what stands on them does.
 * Any changed answer bumps `NavGraph.revision`.
 */
import { NAV_STRUCT_CELL_M } from '@/shared';
import type { NavGraph } from '../NavGraph';
import { F_OWNED, worldToRegion } from '../model';
import { NAV_BODY_R, probeOutdoor, probeRegionNode } from './Bake';

/** Region columns are keyed `regionIndex * COL_KEY + column`. */
const COL_KEY = 1 << 20;
/** How many probes run between two looks at the clock. */
const CLOCK_EVERY = 16;

const _l = { x: 0, z: 0 };

export function mark(g: NavGraph, x: number, z: number, r: number): void {
  if (!g.world) return;
  const pad = r + NAV_BODY_R + g.cell;
  const W = g.W;
  const i0 = Math.max(0, Math.floor((x - pad - g.origin) / g.cell)), i1 = Math.min(W - 1, Math.floor((x + pad - g.origin) / g.cell));
  const j0 = Math.max(0, Math.floor((z - pad - g.origin) / g.cell)), j1 = Math.min(W - 1, Math.floor((z + pad - g.origin) / g.cell));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const id = j * W + i;
      if (g.dirtyCell[id] !== 0) continue;
      g.dirtyCell[id] = 1;
      g.dirtyCells.push(id);
    }
  }
  // Region columns exist only once the bake measured them — a change before that is in the bake's own answers.
  if (!g.ready) return;
  const cs = NAV_STRUCT_CELL_M;
  for (let ri = 0; ri < g.regions.length; ri++) {
    const reg = g.regions[ri];
    const R = Math.hypot(reg.spec.halfU, reg.spec.halfV) + pad;
    const dx = x - reg.spec.cx, dz = z - reg.spec.cz;
    if (dx * dx + dz * dz > R * R) continue;
    worldToRegion(reg, x, z, _l);
    const a0 = Math.max(0, Math.floor((_l.x - pad - reg.u0) / cs)), a1 = Math.min(reg.nu - 1, Math.floor((_l.x + pad - reg.u0) / cs));
    const b0 = Math.max(0, Math.floor((_l.z - pad - reg.v0) / cs)), b1 = Math.min(reg.nv - 1, Math.floor((_l.z + pad - reg.v0) / cs));
    for (let b = b0; b <= b1; b++) {
      for (let a = a0; a <= a1; a++) {
        const key = ri * COL_KEY + b * reg.nu + a;
        if (g.dirtyColSet.has(key)) continue;
        g.dirtyColSet.add(key);
        g.dirtyCols.push(key);
      }
    }
  }
}

export function run(g: NavGraph, budgetMs: number): void {
  const w = g.world;
  if (!w) return;
  const t0 = performance.now();
  let changed = false;
  let n = 0;
  while (g.dirtyCells.length > 0) {
    const id = g.dirtyCells.pop()!;
    g.dirtyCell[id] = 0;
    if ((g.of[id] & F_OWNED) !== 0) continue;
    // A re-measure always probes: the collider that caused it is near by definition.
    if (probeOutdoor(g, w, id, true)) changed = true;
    if (++n % CLOCK_EVERY === 0 && performance.now() - t0 >= budgetMs) break;
  }
  while (g.dirtyCols.length > 0 && performance.now() - t0 < budgetMs) {
    const key = g.dirtyCols.pop()!;
    g.dirtyColSet.delete(key);
    const ri = Math.floor(key / COL_KEY), c = key - ri * COL_KEY;
    const r = g.regions[ri];
    if (!r) continue;
    for (let k = r.colStart[c], e = r.colStart[c + 1]; k < e; k++) {
      if (probeRegionNode(w, r, k)) changed = true;
    }
  }
  if (changed) g.revision++;
}
