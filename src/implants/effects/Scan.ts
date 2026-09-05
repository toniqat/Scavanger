import * as THREE from 'three';
import type { EnemyRef, GameContext, ScanTarget } from '@/shared';

/** Hard cap so a huge pulse never floods the reveal list / the HUD outline pool. */
const MAX_TARGETS = 80;

/**
 * Gather everything a 정찰 pulse of `radius` around `center` reveals. Every source is optional and
 * probed defensively — enemies / pickups / gadgets / gather nodes are owned by other folders and may not
 * exist yet (or may not implement the newest contract members).
 *
 * The returned `position` fields are the owners' live Vector3 instances where possible, so the UI can
 * track a moving enemy for the whole reveal window.
 */
export function collectScanTargets(ctx: GameContext, center: THREE.Vector3, radius: number): ScanTarget[] {
  const out: ScanTarget[] = [];
  const r2 = radius * radius;
  const near = (p: THREE.Vector3): boolean => p.distanceToSquared(center) <= r2;

  // ── enemies
  const enemies = ctx.enemies;
  if (enemies) {
    let list: readonly EnemyRef[] = [];
    const q = (enemies as { queryNear?: unknown }).queryNear;
    if (typeof q === 'function') {
      try { list = enemies.queryNear(center, radius); } catch { list = enemies.getEnemies(); }
    } else {
      list = enemies.getEnemies();
    }
    for (const e of list) {
      if (e.isDead || !near(e.position)) continue;
      out.push({ kind: 'enemy', id: String(e.id), position: e.position, object: e.object, label: '적' });
      if (out.length >= MAX_TARGETS) return out;
    }
  }

  // ── crates
  const world = ctx.world;
  if (world && world.ready) {
    for (const c of world.getCrates()) {
      if (c.opened || !near(c.position)) continue;
      out.push({ kind: 'crate', id: c.id, position: c.position, label: '보급 상자' });
      if (out.length >= MAX_TARGETS) return out;
    }
    // ── gather nodes (world may predate the tactical-kit contract)
    const gn = (world as { getGatherNodes?: unknown }).getGatherNodes;
    if (typeof gn === 'function') {
      try {
        for (const n of world.getGatherNodes()) {
          if (n.harvested || !near(n.position)) continue;
          out.push({ kind: 'gather', id: n.id, position: n.position, label: '채집물' });
          if (out.length >= MAX_TARGETS) return out;
        }
      } catch { /* world without gather nodes */ }
    }
    // ── objectives
    for (const p of world.getExtractionPoints()) {
      if (!near(p.position)) continue;
      out.push({ kind: 'objective', id: p.id, position: p.position, label: '탈출 지점' });
      if (out.length >= MAX_TARGETS) return out;
    }
  }

  // ── dropped items
  const pickups = ctx.pickups;
  if (pickups) {
    for (const p of pickups.getPickups()) {
      if (!near(p.position)) continue;
      const name = ctx.loot?.getItemDef(p.item.defId)?.name;
      out.push({ kind: 'pickup', id: p.id, position: p.position, object: p.object, label: name ?? '아이템' });
      if (out.length >= MAX_TARGETS) return out;
    }
  }

  // ── deployables (gadgets)
  const gadgets = ctx.gadgets;
  if (gadgets) {
    try {
      for (const d of gadgets.getDeployables()) {
        if (!near(d.position)) continue;
        out.push({ kind: 'deployable', id: d.id, position: d.position, object: d.object, label: '설치물' });
        if (out.length >= MAX_TARGETS) return out;
      }
    } catch { /* gadgets not ready */ }
  }

  return out;
}
