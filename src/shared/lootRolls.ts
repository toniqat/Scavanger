/**
 * src/shared/lootRolls.ts — **the seed formula of a loot roll** (2026-09-12).
 *
 * A container's or a corpse's contents are left unrolled and then rolled deterministically **the first time they are
 * opened** — the same map seed and the same id give the same things on whichever client opens them. On 2026-09-12 two
 * places appeared that **preview that roll without opening it** (world's `previewContainerItems` · the ground-drone
 * scan). With the formula copied per folder, fixing one side alone would give 「the scan said epic but there is nothing
 * inside」, so it was pulled into `shared` (CLAUDE.md: the same formula in two folders moves to shared — the same
 * treatment as `ballistics`).
 *
 *   crateLootRandom   crates · structure/platform/tram containers · supply boxes — inventory `ContainerStore.getOrCreate` · `parts/Peek` ·
 *                     world `structures/parts/Containers.rollCrateContents`
 *   corpseLootRandom  enemy corpses — enemies `Corpses.Corpse.interact` · gadgets `drones/parts/Scan`
 *
 * The formula itself is **bit-for-bit the same** as before 2026-09-12 (the fixed output of `inventory/__selftest__` is unchanged).
 */
import { Random } from './Random';

/** The contents-roll rng of container `containerId` — `(map seed >>> 0) ^ hash(id)`. With this rng, `LootRef.rollCrateOn(tier, rng, planet)`. */
export function crateLootRandom(seed: number, containerId: string): Random {
  return new Random(((seed >>> 0) ^ Random.hash(containerId)) >>> 0);
}

/** The contents-roll rng of enemy `enemyId`'s corpse — `map seed ^ (enemyId × 2654435761)`, or 1 when that is 0. With this rng, `LootRef.rollCorpseOn`. */
export function corpseLootRandom(seed: number, enemyId: number): Random {
  return new Random(((seed ^ (enemyId * 2654435761)) >>> 0) || 1);
}
