import * as THREE from 'three';
import { DETECT_ENEMY_COLOR, Layers } from '@/shared';
import type { Enemy } from '../Enemy';

/* ────────────────────────────────────────────────────────────────────────────
 * Phase 12: 정찰 x-ray — a red silhouette of an enemy drawn **through** geometry (`EnemyManagerRef.setXray`).
 *
 * Same trick as the player's occlusion silhouette (`player/SoldierModel`): one overlay `THREE.Mesh` per body mesh,
 * sharing that mesh's geometry and parented **under it** (so it inherits the animated part transform for free — no
 * per-frame matrix copy), drawn with ONE shared `MeshBasicMaterial` whose `depthFunc` is `GreaterDepth`: a fragment
 * only lands where something already in the depth buffer is *closer*, i.e. where the world hides the body.
 *
 * Why opaque and render-ordered instead of a translucent material: a transparent overlay sorts after every opaque
 * mesh, so by the time it draws the enemy's own body is in the depth buffer and the far legs / abdomen (which lie
 * behind the torso) would pass the Greater test and tint the *visible* body red in patches. So the overlay is
 * opaque, drawn at `XRAY_ORDER` — after the world (order 0), **before** the enemy body (`BODY_ORDER`) — and the body
 * paints over it wherever the enemy is actually visible. Body meshes are lifted to `BODY_ORDER` the first time an
 * enemy gets its overlays (correctness is unaffected: the opaque pass depth-tests regardless of order).
 *
 * Overlays are built lazily once per pooled `Enemy` (rigs persist across pool cycles) and only toggled afterwards;
 * `tick` expires them, `remove` drops one (death / despawn), `clear` hides all (mission reset), `dispose` detaches
 * and frees everything (pool disposal). No per-frame allocation.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Overlay render order: after the world (0), before the enemy body. Matches the player's `SIL_ORDER`. */
export const XRAY_ORDER = 1;
/** Enemy body meshes are lifted here once they own overlays (the player's `BODY_ORDER`). */
export const BODY_ORDER = 2;

interface XrayEntry {
  enemy: Enemy;
  /** ctx.time at which the silhouette goes away. */
  until: number;
}

export class EnemyXray {
  private readonly mat = new THREE.MeshBasicMaterial({
    color: DETECT_ENEMY_COLOR, depthTest: true, depthFunc: THREE.GreaterDepth, depthWrite: false,
    transparent: false, fog: false, toneMapped: false, side: THREE.DoubleSide,
  });
  /** Overlay meshes per pooled enemy (built once, reused across pool cycles). */
  private readonly overlays = new Map<Enemy, THREE.Mesh[]>();
  /** Enemies currently shown, by id. */
  private readonly active = new Map<number, XrayEntry>();

  /** Number of enemies currently drawn (debug / smoke). */
  get count(): number { return this.active.size; }

  /** Overlay meshes of `e` (debug / smoke): built count + whether they are visible right now. */
  debugState(e: Enemy): { overlays: number; visible: boolean; until: number } {
    const list = this.overlays.get(e);
    const entry = this.active.get(e.id);
    return { overlays: list ? list.length : 0, visible: !!list && list.length > 0 && list[0].visible, until: entry && entry.enemy === e ? entry.until : -Infinity };
  }

  /** Show `e` through walls until `until` (ctx.time). A second call extends (never shortens). */
  show(e: Enemy, until: number): void {
    const cur = this.active.get(e.id);
    if (cur && cur.enemy === e) { if (until > cur.until) cur.until = until; return; }
    const list = this.ensure(e);
    for (let i = 0; i < list.length; i++) list[i].visible = true;
    this.active.set(e.id, { enemy: e, until });
  }

  /** Hide `e` (death / despawn / cleared). */
  remove(e: Enemy): void {
    const cur = this.active.get(e.id);
    if (!cur || cur.enemy !== e) return;
    this.active.delete(e.id);
    this.setVisible(e, false);
  }

  /** Expire finished entries; a body that died / left the pool loses its silhouette at once. */
  tick(now: number): void {
    if (this.active.size === 0) return;
    for (const [id, entry] of this.active) {
      const e = entry.enemy;
      if (now >= entry.until || !e.active || e.state === 'dead' || e.id !== id) {
        this.active.delete(id);
        this.setVisible(e, false);
      }
    }
  }

  /** Hide everything (mission reset); overlays stay built for the pooled rigs. */
  clear(): void {
    for (const entry of this.active.values()) this.setVisible(entry.enemy, false);
    this.active.clear();
  }

  /** Detach every overlay (pool disposal) and free the material. */
  dispose(): void {
    this.clear();
    for (const list of this.overlays.values()) {
      for (let i = 0; i < list.length; i++) list[i].removeFromParent();
    }
    this.overlays.clear();
    this.mat.dispose();
  }

  private setVisible(e: Enemy, on: boolean): void {
    const list = this.overlays.get(e);
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i].visible = on;
  }

  /** Build the overlays of `e` on first use: one child per body mesh under `e.object`. */
  private ensure(e: Enemy): THREE.Mesh[] {
    let list = this.overlays.get(e);
    if (list) return list;
    list = [];
    const bodies: THREE.Mesh[] = [];
    e.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.name !== 'xray') bodies.push(m);
    });
    for (let i = 0; i < bodies.length; i++) {
      const m = bodies[i];
      m.renderOrder = BODY_ORDER;
      const sil = new THREE.Mesh(m.geometry, this.mat);
      sil.name = 'xray';
      sil.castShadow = false; sil.receiveShadow = false;
      sil.renderOrder = XRAY_ORDER;
      sil.layers.enable(Layers.NO_RAYCAST);
      sil.visible = false;
      m.add(sil);
      list.push(sil);
    }
    this.overlays.set(e, list);
    return list;
  }
}
