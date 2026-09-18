import type * as THREE from 'three';
import type { EnemyType, HumanoidSpawnOpts } from '@/shared';
import type { Enemy } from './Enemy';
import type { SpawnHost } from './Spawner';

/* ────────────────────────────────────────────────────────────────────────────
 * The humanoid spawn service contract (the file has had this name since Phase 4).
 *
 * 2026-09-13: **crate guards (`placeRogueGuards`) are retired.** A raid's starting placement is the **site groups** by
 * planet threat and `SiteGroups.ts` owns it (labs · outposts · rail platforms · ruins). Only the `RogueSpawnHost` shared
 * by site groups · raider drops (`RogueDrop.ts`) · named (`named/Director.ts`) is left — the name is a contract and stays.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Extra spawn service for humanoids (implemented by EnemySystem). */
export interface RogueSpawnHost extends SpawnHost {
  /**
   * Spawn a humanoid (rogue · android · raider · named) guarding `guardPos` (leash centre) with weapon family `weaponId`;
   * `escortOf` makes it follow that leader. `opts` = site · squad · role (omitted = no site · no squad · member).
   */
  spawnRogue(type: EnemyType, position: THREE.Vector3, yaw: number, guardPos: THREE.Vector3, weaponId: string, escortOf: Enemy | null, opts?: HumanoidSpawnOpts): Enemy | null;
  /** 2026-09-13: a squad id unique within this raid (from 1, restored by `Pool.reset`). Site groups · drop waves · the Heavy's squad use it. */
  allocSquadId(): number;
}

/* ── Retired names (2026-09-13) ───────────────────────────────────────────────────────────────────────────
 * Several files in the folder (`model.ts` · the shared import lines of `parts/*`) and `index.ts` import the old names,
 * so only the names are kept — **nobody calls them, and a call builds nothing.** Placement is `SiteGroups.placeSiteGroups`.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────── */
/** @deprecated 2026-09-13 — crate guards retired. 0. */
export const MAX_GUARDS = 0;
/** @deprecated 2026-09-13 — crate guards retired. 0. */
export const ECO_BOSS_CHANCE = 0;
/** @deprecated 2026-09-13 — crate guards retired. */
export interface GuardPlacement { squads: number; rogues: number; boss: Enemy | null }
/** @deprecated 2026-09-13 — crate guards retired. Always 0. */
export function guardCap(_eco?: unknown): number { return 0; }
/** @deprecated 2026-09-13 — crate guards retired. Builds nothing (use `SiteGroups.placeSiteGroups`). */
export function placeRogueGuards(_host?: RogueSpawnHost, _seed?: number, _eco?: unknown): GuardPlacement {
  return { squads: 0, rogues: 0, boss: null };
}
