/**
 * src/shared/raidFound.ts — the **「found in this raid」 item mark** (2026-09-12, recovery contracts — user's decision).
 *
 * An `extract_with_items` contract counts only items that **a loot roll created inside that raid**. What was
 * brought from the ship · crafted · bought · handed out as the base kit · the tutorial · the console is not
 * counted. `ItemInstance.raidFound` (= that raid's map seed) on the instance carries the distinction, and the
 * mark **travels with the item** (dropped for a squadmate to pick up · into a corpse · in the reconnect blob).
 *
 * The rule is known in this file alone — meta (count · settlement) and inventory (stack split · diagonal band)
 * call the same functions.
 *   - Stamped at: crates · structure / platform / tram containers (the key-opened extras included) · supply
 *     crates · enemy corpses (named ones included) · gather nodes. All of them only while `raidFoundSeed(ctx)`
 *     is not null (a real raid, not the training range) — the roll's rng is never touched.
 *   - Merging: **only an active recovery contract's items** merge stack-wise when the mark is equal
 *     (`raidFoundStackKey`). Every other item merges as before, but merging two different marks leaves the
 *     result without a mark (`mergeRaidFoundMark` — no laundering by mixing).
 *   - At raid end inventory wipes it off the body and the stash — in the ship they merge plainly again.
 */
import type { GameContext } from './GameContext';
import type { ItemInstance } from './types';

/** Only the instance fields needed to read and write the mark. */
export type RaidFoundItem = Pick<ItemInstance, 'defId' | 'raidFound'>;

/** Scope of the active recovery contract — this raid's seed and the contract item's def id. */
export interface RaidFoundScope {
  readonly seed: number;
  readonly defId: string;
}

/**
 * The seed a loot roll must stamp right now — that map's seed (`WorldRef.seed`) while this is a real raid (out
 * on a mission, not the training range) and a world exists, else null (the ship · the training range · menus ·
 * before the world is built).
 */
export function raidFoundSeed(ctx: Pick<GameContext, 'isRaidActive' | 'isTraining' | 'world'>): number | null {
  if (!ctx.isRaidActive() || ctx.isTraining()) return null;
  const seed = ctx.world?.seed;
  return typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : null;
}

/** Was `item` found in raid `seed` (the seeds are lined up with `>>> 0` before comparing). Always false with no seed. */
export function isRaidFound(item: Pick<ItemInstance, 'raidFound'> | null | undefined, seed: number | null | undefined): boolean {
  if (!item || typeof seed !== 'number' || !Number.isFinite(seed)) return false;
  const rf = item.raidFound;
  return typeof rf === 'number' && Number.isFinite(rf) && (rf >>> 0) === (seed >>> 0);
}

/**
 * Stamps the mark on a roll's result (top-level instances only — a socketed attachment is one body with its
 * weapon). Does nothing when `seed` is null.
 */
export function markRaidFound(items: ItemInstance | readonly (ItemInstance | null | undefined)[] | null | undefined, seed: number | null): void {
  if (seed === null || !items) return;
  const s = seed >>> 0;
  if (Array.isArray(items)) { for (const it of items) if (it) it.raidFound = s; }
  else (items as ItemInstance).raidFound = s;
}

/** Removes the mark. true when there was one. */
export function stripRaidFound(item: ItemInstance | null | undefined): boolean {
  if (!item || item.raidFound === undefined) return false;
  delete item.raidFound;
  return true;
}

/** A split-off stack (`created`) inherits the mark of the stack it came from (`from`). */
export function copyRaidFoundMark(created: ItemInstance, from: Pick<ItemInstance, 'raidFound'>): void {
  if (typeof from.raidFound === 'number') created.raidFound = from.raidFound;
  else delete created.raidFound;
}

/**
 * Called **after** `source`'s quantity has been merged into `target`: the result keeps the mark only when both
 * marks are equal. For an active contract's item `raidFoundStackKey` never merges two different marks in the
 * first place, so what is cleared here is only other items (and marks from a past raid).
 */
export function mergeRaidFoundMark(target: ItemInstance, source: Pick<ItemInstance, 'raidFound'>): void {
  if (target.raidFound !== source.raidFound) delete target.raidFound;
}

/**
 * The active recovery-contract scope of `ctx` — only while this is a real raid and the active contract is
 * `extract_with_items`, else null.
 */
export function raidFoundScopeOf(ctx: Pick<GameContext, 'isRaidActive' | 'isTraining' | 'world' | 'meta'>): RaidFoundScope | null {
  const seed = raidFoundSeed(ctx);
  if (seed === null) return null;
  const def = ctx.meta?.activeContract?.def;
  const defId = def && def.goal === 'extract_with_items' ? def.itemDefId : undefined;
  return typeof defId === 'string' && defId ? { seed, defId } : null;
}

/** Does this stack count toward the active recovery contract (diagonal band · count). */
export function countsForRecovery(item: RaidFoundItem | null | undefined, scope: RaidFoundScope | null): boolean {
  return !!item && !!scope && item.defId === scope.defId && isRaidFound(item, scope.seed);
}

/**
 * Stack classification key — two stacks of the same def merge only when this value is equal. Only an active
 * recovery contract's item splits into `'rf'` (this raid) / `''`; everything else is `''` and merges exactly as
 * before.
 */
export function raidFoundStackKey(item: RaidFoundItem, scope: RaidFoundScope | null): string {
  return scope && item.defId === scope.defId && isRaidFound(item, scope.seed) ? 'rf' : '';
}

/** Are the two scopes equal (decides whether the display copy is refreshed). */
export function sameRaidFoundScope(a: RaidFoundScope | null, b: RaidFoundScope | null): boolean {
  return a === b || (!!a && !!b && a.seed === b.seed && a.defId === b.defId);
}
