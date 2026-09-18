import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext, ItemInstance } from '@/shared';
/* appended (2026-09-16): empty corpse removal — the same numbers as a main-game corpse */
import { CORPSE_EMPTY_REMOVE_DELAY_S, CORPSE_EMPTY_SINK_DEPTH_M, CORPSE_EMPTY_SINK_S } from '@/shared';
/* appended (2026-09-16, 2nd pass): an empty corpse is counted after the loot window closes (local only — the tutorial is solo) */
import { CorpseViewTracker } from '@/shared';
import { CORPSES, box, placed, type CorpseSpec } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * Three hand-placed corpses (2026-09-14, tutorial).
 *
 * **No container rolls** — what the tutorial hands out has to be fixed. So the contents are made directly with
 * `ctx.loot.createItem` and passed to `ctx.inventory.openContainerItems(id, items, position, title)`
 * (the same 「container whose contents the caller supplies」 path enemy corpses and squadmate corpses already use — inventory caches
 * what is left per `containerId`, so reopening it is missing what was taken, and when it empties `crate:looted` arrives).
 *
 * The id prefix is `corpse:`, so `ui/hud/pillar.pillarAllowed` raises a light pillar — exactly the main game's rule that only
 * corpses get a pillar, and the same path as someone who lost their weapon walking back to their own corpse.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Entry {
  spec: CorpseSpec;
  items: ItemInstance[];
  position: THREE.Vector3;
  emptied: boolean;
  /* appended (2026-09-16): empty corpse removal */
  /** The `ctx.missionTime` when it emptied (-1 = not yet). */
  emptiedAt: number;
  /** Fully sunk and cleared away (interaction unregistered · mesh removed). */
  removed: boolean;
  mesh: THREE.Mesh | null;
  geo: THREE.BufferGeometry | null;
}

/** The geometry of one prone soldier (head toward +Z, turned by `yaw`). */
function corpseGeometry(yaw: number): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [
    box(0.62, 0.34, 1.0, 0, 0.17, 0.15),                       // torso
    box(0.5, 0.3, 0.66, 0, 0.15, -0.62),                       // pelvis · thighs
    box(0.2, 0.24, 0.7, -0.14, 0.12, -1.2, 0.12),              // left leg
    box(0.2, 0.24, 0.78, 0.16, 0.12, -1.24, -0.18),            // right leg
    box(0.18, 0.18, 0.62, -0.38, 0.1, 0.24, 0.5),              // left arm (splayed)
    box(0.18, 0.18, 0.6, 0.38, 0.1, 0.1, -0.35),               // right arm
    box(0.66, 0.3, 0.42, 0, 0.2, 0.5),                         // backpack · shoulders
  ];
  const head = new THREE.SphereGeometry(0.17, 10, 8);
  parts.push(placed(head, 0, 0.17, 0.82));
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged) merged.rotateY(yaw);
  return merged;
}

export class TutorialCorpses {
  readonly group = new THREE.Group();
  private ctx: GameContext | null = null;
  private entries: Entry[] = [];
  private disposables: Array<{ dispose(): void }> = [];
  private unsub: (() => void) | null = null;
  /** 2026-09-16 (2nd pass): which hand-placed corpse my own window is showing — while it is open the sinking clock is held (no wire). */
  private viewers: CorpseViewTracker | null = null;

  constructor() { this.group.name = 'TutorialCorpses'; }

  build(ctx: GameContext, root: THREE.Group): void {
    this.ctx = ctx;
    this.viewers?.dispose();
    this.viewers = new CorpseViewTracker(ctx, {
      matches: (id) => this.entries.some((x) => x.spec.id === id),
      positionOf: (id) => this.entries.find((x) => x.spec.id === id)?.position ?? null,
      net: false,
    });
    root.add(this.group);
    const cloth = new THREE.MeshStandardMaterial({ color: 0x4b5240, roughness: 0.92, metalness: 0.08, emissive: 0x0d0f0b, emissiveIntensity: 0.7 });
    this.disposables.push(cloth);

    for (const spec of CORPSES) {
      const geo = corpseGeometry(spec.yaw);
      let mesh: THREE.Mesh | null = null;
      if (geo) {
        mesh = new THREE.Mesh(geo, cloth);
        mesh.name = spec.id;
        mesh.position.set(spec.x, spec.y, spec.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
      const entry: Entry = {
        spec,
        items: this.makeItems(ctx, spec),
        position: new THREE.Vector3(spec.x, spec.y + 0.3, spec.z),
        emptied: false,
        emptiedAt: -1, removed: false, mesh, geo,
      };
      this.entries.push(entry);
      ctx.interactables.register({
        id: spec.id,
        kind: 'corpse',
        position: entry.position,
        radius: 2.4,
        getPrompt: () => (entry.emptied ? '비어 있음' : `${spec.name} 뒤지기`),
        canInteract: () => !entry.emptied && ctx.isGameplayActive(),
        interact: () => {
          ctx.inventory?.openContainerItems(spec.id, entry.items, entry.position, spec.name);
          ctx.bus.emit('audio:play', { id: 'crate_open', position: entry.position.clone(), volume: 0.6 });
        },
      });
    }

    // An emptied corpse's prompt becomes `비어 있음`, and from 2026-09-16 it sinks and disappears like a main-game corpse (`update`)
    this.unsub = ctx.bus.on('crate:looted', ({ crateId }) => {
      const e = this.entries.find((x) => x.spec.id === crateId);
      if (e && !e.emptied) { e.emptied = true; e.emptiedAt = ctx.missionTime; }
    });
  }

  /**
   * 2026-09-16 (empty corpse removal, `TutorialWorld.update` every frame): an empty corpse sinks `CORPSE_EMPTY_SINK_DEPTH_M` over
   * `CORPSE_EMPTY_SINK_S` after `CORPSE_EMPTY_REMOVE_DELAY_S`; when it ends the interaction (= the light pillar) is released and the mesh and geometry disposed.
   * The same curve and the same clock (`ctx.missionTime`) as the main game's player corpse (`game/Corpses.PlayerCorpseObject.stepSink`).
   * 2026-09-16 (2nd pass, user's decision): while a window is showing that corpse the clock is held — sinking starts after the window closes plus the delay.
   */
  update(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.missionTime;
    const mine = this.viewers?.localViewing ?? null;
    for (const e of this.entries) {
      if (!e.emptied || e.removed || e.emptiedAt < 0) continue;
      if (mine === e.spec.id) { e.emptiedAt = now; continue; }
      const elapsed = now - e.emptiedAt - CORPSE_EMPTY_REMOVE_DELAY_S;
      if (elapsed < 0) continue;
      const k = CORPSE_EMPTY_SINK_S > 0 ? Math.min(1, elapsed / CORPSE_EMPTY_SINK_S) : 1;
      if (e.mesh) e.mesh.position.y = e.spec.y - CORPSE_EMPTY_SINK_DEPTH_M * k * k;
      if (k < 1) continue;
      e.removed = true;
      ctx.interactables.unregister(e.spec.id);
      if (e.mesh) { e.mesh.removeFromParent(); e.mesh = null; }
      if (e.geo) { e.geo.dispose(); e.geo = null; }
    }
  }

  /** The fixed list → real items. `'stack'` means one cell full of that def's `stackMax` (ammo). */
  private makeItems(ctx: GameContext, spec: CorpseSpec): ItemInstance[] {
    const loot = ctx.loot;
    const out: ItemInstance[] = [];
    if (!loot) return out;
    for (const want of spec.items) {
      const def = loot.getItemDef(want.id);
      if (!def) continue;
      const qty = want.qty === 'stack' ? Math.max(1, def.stackMax) : want.qty;
      out.push(loot.createItem(want.id, qty));
    }
    return out;
  }

  dispose(): void {
    const ctx = this.ctx;
    this.unsub?.();
    this.unsub = null;
    this.viewers?.dispose();   // 2026-09-16 (2nd pass)
    this.viewers = null;
    for (const e of this.entries) {
      ctx?.interactables.unregister(e.spec.id);
      e.geo?.dispose();   // 2026-09-16: each corpse holds its own geometry (one already cleared by sinking is null)
      e.geo = null; e.mesh = null;
    }
    this.entries.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.group.removeFromParent();
    this.ctx = null;
  }
}
