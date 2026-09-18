/**
 * src/world/structures/parts/Glass.ts — **structure window glass** (2026-09-11).
 *
 * User's request: "windows at random positions on the floor-1 and floor-2 walls. Windows are pierced by bullets and
 * throwables" + the decision: **people still cannot pass through a broken one — only bullets · throwables do**.
 *
 * - Every pane on the map is **one** `InstancedMesh` (+1 draw call). Breaking one folds that instance to size 0.
 * - One pane = one thin box collider (`Obstacle.fragile` + `destructible`). Bullets go through `weapons/`'s existing
 *   `obstacle.destructible.onDamage` path; a throwable sweeps its own flight segment with `world.raycast` and calls
 *   the same function.
 * - **The collider stays in the hash even when broken.** It turns `passRays` (rays ignore it) + `passSmall` (a body
 *   under radius `SMALL_BODY_R` — grenades · thrown gadgets — is not pushed out) instead. People's and enemies'
 *   bodies are still blocked. Both flags are world-internal (`ObstacleEntry`), so the contract does not grow.
 * - **Blast · melee occlusion is the exception** (2026-09-18, user's decision 「a window blocks blasts even when
 *   broken」): `WorldSystem.raycastBlast` blocks a collider whose `kind === GLASS_OBSTACLE_KIND` regardless of
 *   `passRays`. Bullets · enemy sight · throwables pass as before — the one thing that changed is
 *   `shared/explosion.lineClear`.
 * - Who broke it does not matter (the result is the same) — the breaking client sends `struct glass` and the
 *   receiving side calls the same function silently (`byLocal: false`). Already broken = nothing happens.
 */
import * as THREE from 'three';
import { Layers } from '@/shared';
import type { BuildCtx } from '../../build';
import type { ObstacleEntry } from '../../SpatialHash';
import { GLASS_T } from '../model';

/** A body under this radius (m) passes a broken window frame (`resolveCollision`). Grenade 0.08 · thrown gadget 0.08 · person 0.45. */
export const SMALL_BODY_R = 0.25;

/**
 * 2026-09-18: the `ObstacleEntry.kind` of one pane's collider. **This file is the only place that stands glass up**,
 * so this label is the identity of 「this is a window」 — `WorldSystem.raycastBlast` uses it to tell a window from
 * the tutorial wire fence's ghost band (`tut_fence_ghost`, which is `passRays` just the same). It uses the existing
 * `kind` so as not to add a new flag to `SpatialHash.ObstacleEntry`.
 */
export const GLASS_OBSTACLE_KIND = 'glass';

/** One window's spot (world). `yaw` is the direction the pane extends along (math convention, local +X = its width). */
export interface WindowSpec {
  x: number;
  /** Height of the pane's **bottom edge**. */
  y: number;
  z: number;
  halfW: number;
  height: number;
  yaw: number;
}

interface Pane { structureId: string; index: number; spec: WindowSpec; entry: ObstacleEntry; broken: boolean }

export class GlassSet {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private mat: THREE.MeshStandardMaterial | null = null;
  private geo: THREE.BoxGeometry | null = null;
  private readonly panes: Pane[] = [];
  private readonly byKey = new Map<string, Pane>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor() { this.group.name = 'StructureGlass'; }

  static key(structureId: string, index: number): string { return `${structureId}:${index}`; }

  get count(): number { return this.panes.length; }
  get brokenCount(): number { let n = 0; for (const p of this.panes) if (p.broken) n++; return n; }
  /** Every broken window as `<structureId>:<index>` (`struct sync.glass`). */
  brokenKeys(): string[] { return this.panes.filter((p) => p.broken).map((p) => GlassSet.key(p.structureId, p.index)); }

  /**
   * Stands every pane up. `onHit(structureId, index, point)` is called when a bullet · throwable hit glass **on this
   * client** — the caller does the actual breaking with `breakPane` (so sound · wire · event leave from one place).
   */
  build(ctx: BuildCtx, specs: readonly { structureId: string; index: number; spec: WindowSpec }[],
    onHit: (structureId: string, index: number, point: THREE.Vector3 | undefined) => void): void {
    if (specs.length === 0) return;
    this.geo = new THREE.BoxGeometry(1, 1, 1);
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x9cc6d6, roughness: 0.06, metalness: 0.2, transparent: true, opacity: 0.26, depthWrite: false,
      emissive: new THREE.Color(0x0d1e26), emissiveIntensity: 0.6,
    });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, specs.length);
    this.mesh.name = 'structure_glass';
    this.mesh.frustumCulled = false;
    this.mesh.layers.enable(Layers.PROP);
    this.mesh.renderOrder = 2;
    specs.forEach(({ structureId, index, spec }, i) => {
      this.writeInstance(i, spec, false);
      const entry = ctx.hash.addBox(
        new THREE.Vector3(spec.x, spec.y, spec.z), spec.halfW, GLASS_T / 2 + 0.02, spec.yaw, spec.height, GLASS_OBSTACLE_KIND,
      ) as ObstacleEntry;
      entry.fragile = true;
      const pane: Pane = { structureId, index, spec, entry, broken: false };
      entry.destructible = {
        id: `glass:${structureId}:${index}`,
        get hp(): number { return pane.broken ? 0 : 1; },
        maxHp: 1,
        onDamage: (_amount: number, point?: THREE.Vector3) => { if (!pane.broken) onHit(structureId, index, point); },
      };
      this.panes.push(pane);
      this.byKey.set(GlassSet.key(structureId, index), pane);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.mesh);
  }

  /** The middle of one pane (sound · shard spot). null with none. */
  centerOf(structureId: string, index: number, out: THREE.Vector3): THREE.Vector3 | null {
    const p = this.byKey.get(GlassSet.key(structureId, index));
    if (!p) return null;
    return out.set(p.spec.x, p.spec.y + p.spec.height / 2, p.spec.z);
  }

  /** The pane's normal (the horizontal unit vector perpendicular to the pane). */
  normalOf(structureId: string, index: number, out: THREE.Vector3): THREE.Vector3 | null {
    const p = this.byKey.get(GlassSet.key(structureId, index));
    if (!p) return null;
    return out.set(-Math.sin(p.spec.yaw), 0, Math.cos(p.spec.yaw));
  }

  /** Breaks it. false when the pane is already broken or does not exist. */
  breakPane(structureId: string, index: number): boolean {
    const pane = this.byKey.get(GlassSet.key(structureId, index));
    if (!pane || pane.broken) return false;
    pane.broken = true;
    const e = pane.entry;
    e.fragile = false;
    e.destructible = undefined;
    e.passRays = true;
    e.passSmall = true;
    const i = this.panes.indexOf(pane);
    if (this.mesh && i >= 0) { this.writeInstance(i, pane.spec, true); this.mesh.instanceMatrix.needsUpdate = true; }
    return true;
  }

  private writeInstance(i: number, spec: WindowSpec, hidden: boolean): void {
    if (!this.mesh) return;
    this.p.set(spec.x, spec.y + spec.height / 2, spec.z);
    this.q.setFromAxisAngle(this.up, -spec.yaw);
    if (hidden) this.s.set(0, 0, 0); else this.s.set(spec.halfW * 2, spec.height, GLASS_T);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
  }

  dispose(): void {
    this.panes.length = 0;
    this.byKey.clear();
    this.mesh?.dispose();
    this.mesh = null;
    this.geo?.dispose(); this.geo = null;
    this.mat?.dispose(); this.mat = null;
    this.group.clear();
    this.group.removeFromParent();
  }
}
