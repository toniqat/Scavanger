import * as THREE from 'three';
import type { EnemyRef, GameContext, Interactable, InteractableKind, ScanTarget } from '@/shared';

/** Hard cap so a huge pulse never floods the reveal list / the HUD outline pool. */
const MAX_TARGETS = 120;

/**
 * `Interactable.kind` → `ScanTarget.kind` + label (2026-09-11, C-4). `ScanTarget.kind` itself did not change, so both
 * corpse kinds reveal as a `'crate'` (a lootable container) — the squadmate's with its own label.
 */
const KIND_MAP: Readonly<Record<InteractableKind, readonly [ScanTarget['kind'], string]>> = {
  corpse: ['crate', '시체'],
  playerCorpse: ['crate', '아군 시체'],
  crate: ['crate', '보급 상자'],
  container: ['crate', '컨테이너'],
  gather: ['gather', '채집물'],
  pickup: ['pickup', '아이템'],
  deployable: ['deployable', '설치물'],
  drone: ['deployable', '드론'],
  extract: ['objective', '탈출 지점'],
  revive: ['objective', '아군'],
  console: ['objective', '목표'],
  objective: ['objective', '목표'],
};

/**
 * Interactable id prefix → `ScanTarget.kind` (Phase 12) — the **fallback** for registrations without `kind`. Every
 * world thing a player can walk up to is registered in `ctx.interactables` under a prefixed id (crates `crate_`, gather
 * nodes `gather:` / `gather_`, dropped items `pickup:`, corpses `corpse:`, squadmate corpses `pcorpse:`, deployables
 * `gadget:`, extraction consoles `extract_`, downed squadmates `revive:`), so the registry is the single source for
 * "things to reveal". Anything unlisted (arena consoles, ship stations) is an `'objective'`.
 * 2026-09-11 (C-4): `pcorpse` was missing — `'corpse'` does not prefix-match `pcorpse:`, so a squadmate's corpse
 * revealed as an `objective` (the tall 1.4 pillar).
 */
const PREFIX_KINDS: ReadonlyArray<readonly [string, ScanTarget['kind'], string]> = [
  ['crate', 'crate', '보급 상자'],
  ['corpse', 'crate', '시체'],
  ['pcorpse', 'crate', '아군 시체'],
  ['gather', 'gather', '채집물'],
  ['pickup', 'pickup', '아이템'],
  ['gadget', 'deployable', '설치물'],
  ['extract', 'objective', '탈출 지점'],
  ['revive', 'objective', '아군'],
];

/** `kind` first, the id prefix only when the registration has none. */
export function kindOf(it: Pick<Interactable, 'id' | 'kind'>): readonly [ScanTarget['kind'], string] {
  if (it.kind !== undefined) { const k = KIND_MAP[it.kind]; if (k) return k; }
  for (const [prefix, kind, label] of PREFIX_KINDS) {
    if (it.id.startsWith(prefix)) return [kind, label];
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
    const list: readonly EnemyRef[] = enemies.queryNear(center, radius);
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
    const [kind, label] = kindOf(it);
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
  if (enemies) {
    enemyIdsOf(targets, _ids);
    if (_ids.length) enemies.setXray(_ids, duration);
  }
  return targets;
}
