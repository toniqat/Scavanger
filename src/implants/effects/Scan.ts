import * as THREE from 'three';
import type { EnemyRef, GameContext, ScanTarget } from '@/shared';

/** Hard cap so a huge pulse never floods the reveal list / the HUD outline pool. */
const MAX_TARGETS = 120;

/**
 * Interactable id prefix → `ScanTarget.kind` (Phase 12). Every world thing a player can walk up to is registered in
 * `ctx.interactables` under a prefixed id (crates `crate_`, gather nodes `gather:` / `gather_`, dropped items
 * `pickup:`, corpses `corpse:`, deployables `gadget:`, extraction consoles `extract_`, downed squadmates `revive:`),
 * so the registry is the single source for "things to reveal". Anything unlisted (arena consoles, ship stations) is
 * an `'objective'`.
 */
const PREFIX_KINDS: ReadonlyArray<readonly [string, ScanTarget['kind'], string]> = [
  ['crate', 'crate', '보급 상자'],
  ['corpse', 'crate', '시체'],
  ['gather', 'gather', '채집물'],
  ['pickup', 'pickup', '아이템'],
  ['gadget', 'deployable', '설치물'],
  ['extract', 'objective', '탈출 지점'],
  ['revive', 'objective', '아군'],
];

function kindOf(id: string): readonly [ScanTarget['kind'], string] {
  for (const [prefix, kind, label] of PREFIX_KINDS) {
    if (id.startsWith(prefix)) return [kind, label];
  }
  return ['objective', '목표'];
}

/**
 * Gather everything a 정찰 pulse of `radius` around `center` reveals: every registered interactable inside the radius
 * (kind by id prefix) plus every alive enemy (`queryNear`, else the full list). Each source is probed defensively —
 * enemies are owned by another folder and may not implement the newest contract members.
 *
 * The returned `position` fields are the owners' live Vector3 instances, so the UI can track a moving enemy for the
 * whole reveal window. Enemies come first so the cap never drops them in favour of crates.
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

  // ── interactables (crates, corpses, gather nodes, pickups, deployables, consoles …)
  for (const it of ctx.interactables.all()) {
    if (!near(it.position)) continue;
    let usable = true;
    try { usable = it.canInteract(); } catch { usable = false; }
    if (!usable) continue;
    const [kind, label] = kindOf(it.id);
    out.push({ kind, id: it.id, position: it.position, label });
    if (out.length >= MAX_TARGETS) return out;
  }

  return out;
}

/** Enemy ids (numbers) of a target list, for `EnemyManagerRef.setXray`. */
export function enemyIdsOf(targets: readonly ScanTarget[], out: number[]): number[] {
  out.length = 0;
  for (const t of targets) {
    if (t.kind !== 'enemy') continue;
    const n = Number(t.id);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const _ids: number[] = [];

/**
 * Phase 12: the one-shot 정찰 reveal on **this** client — used both for the local cast and for a peer's `imp scanCast`
 * (every receiver reveals from its own world, so nothing but `p / radius / dur` travels). Collects the targets, emits
 * `detect:reveal` (ScanReveal draws the through-wall pillars) and `scan:cast` (compass marks / indicators), and asks
 * enemies/ for the red silhouettes (`setXray`, probed — the enemies folder may predate it). Returns the targets.
 */
export function revealScan(ctx: GameContext, center: THREE.Vector3, radius: number, duration: number, byLocal: boolean): ScanTarget[] {
  const targets = collectScanTargets(ctx, center, radius);
  ctx.bus.emit('detect:reveal', { targets, duration });
  ctx.bus.emit('scan:cast', { position: center.clone(), radius, duration, targets, byLocal });
  const enemies = ctx.enemies;
  if (enemies && typeof (enemies as { setXray?: unknown }).setXray === 'function') {
    enemyIdsOf(targets, _ids);
    if (_ids.length) { try { enemies.setXray(_ids, duration); } catch { /* enemies without xray */ } }
  }
  return targets;
}
