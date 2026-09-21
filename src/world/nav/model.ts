/**
 * src/world/nav/model.ts — **the nav graph's vocabulary** (TODO A-18). No state; `NavGraph` owns it.
 *
 * Two kinds of grid make one graph:
 *  - the **outdoor** grid: world-aligned `NAV_CELL_M` cells, exactly one node per cell (`oh` · `of`), node id = the
 *    cell index `j * W + i`;
 *  - a **region** per structure · rail platform: a grid aligned to its own axes at `NAV_STRUCT_CELL_M`, holding as many
 *    nodes per column as there are standable levels there (basement · floors · roof). Node ids follow the outdoor ones.
 * Neighbouring cells link on the fly (`parts/Graph`); everything else — a ladder, the seam between a region and the
 * outdoor grid — is an explicit link (`NavGraph.links`).
 */
import type * as THREE from 'three';
import type { LadderDef, NavLinkKind } from '@/shared';
import type { SpatialHash } from '../SpatialHash';

/** Node flag: a body of `NAV_BODY_R` can stand here right now (re-measured when colliders change). */
export const F_WALK = 1;
/** Node flag: the surface is the terrain itself — links between two of these follow the slope rule, not the step rule. */
export const F_TERRAIN = 2;
/** Outdoor flag: this cell lies inside a region, which owns its nodes (the outdoor node is never used). */
export const F_OWNED = 4;
/**
 * Region flag: the floor here is a **ramp** top (a stair flight, a wreck wing). A link that involves one keeps to
 * `RAMP_STEP_M` instead of the full step — see `parts/Graph.linkOk`.
 */
export const F_RAMP = 8;

/** Link kinds as numbers (the `kind` column of a link). Same order as `LINK_KINDS`. */
export const L_WALK = 0;
export const L_LADDER = 1;
export const L_CLIMB = 2;
export const L_WINDOW = 3;
export const LINK_KINDS: readonly NavLinkKind[] = ['walk', 'ladder', 'climb', 'window'];

/**
 * An explicit link out of one node. `can` = the `NAV_CAN` bit a body needs to take it (0 = anyone). `ladder` = an
 * index into `NavGraph.ladders` (-1 for any other link).
 */
export interface NavLink {
  to: number;
  cost: number;
  kind: number;
  can: number;
  ladder: number;
}

/** Where a region stands — the input `WorldSystem` hands over (a structure or a rail platform, margin included). */
export interface RegionSpec {
  key: string;
  cx: number;
  cz: number;
  /** Math convention: local +X → world `(cos, sin)` (the same frame as `structures/parts/Build.rot`). */
  yaw: number;
  /** Half extents along local X · Z, margin included. */
  halfU: number;
  halfV: number;
}

/** A baked region. Column `(a, b)` = local cell `a` along X, `b` along Z; its nodes are `colStart[c] .. colStart[c+1]-1`. */
export interface Region {
  readonly spec: RegionSpec;
  readonly cos: number;
  readonly sin: number;
  /** Local coordinates of the grid's min corner. */
  readonly u0: number;
  readonly v0: number;
  readonly nu: number;
  readonly nv: number;
  /** Global id of this region's first node. */
  base: number;
  colStart: Int32Array;
  /** Per node: surface height · flags · column index. */
  h: Float32Array;
  f: Uint8Array;
  col: Int32Array;
}

/** What the graph needs from `WorldSystem` — the same queries every mover uses, so the graph cannot disagree with them. */
export interface NavWorld {
  heightAt(x: number, z: number): number;
  /** `WorldRef.getSurfaceY`. */
  surfaceY(x: number, z: number, feetY: number): number;
  /** `WorldRef.resolveCollision` (mutates `p`). */
  resolve(p: THREE.Vector3, radius: number): THREE.Vector3;
  readonly hash: SpatialHash;
  readonly regions: readonly RegionSpec[];
  readonly ladders: readonly LadderDef[];
  /** |x|, |z| a body can reach (the soft map wall minus the body). */
  readonly limit: number;
}

/** World XZ of a region's local point. */
export function regionToWorld(r: Region, u: number, v: number, out: { x: number; z: number }): void {
  out.x = r.spec.cx + u * r.cos - v * r.sin;
  out.z = r.spec.cz + u * r.sin + v * r.cos;
}

/** Local UV of a world point (the inverse of `regionToWorld`). */
export function worldToRegion(r: Region, x: number, z: number, out: { x: number; z: number }): void {
  const dx = x - r.spec.cx, dz = z - r.spec.cz;
  out.x = dx * r.cos + dz * r.sin;
  out.z = -dx * r.sin + dz * r.cos;
}
