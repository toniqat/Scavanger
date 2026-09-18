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
 * 2026-09-19: the no-op husks kept for the old import lines (`placeRogueGuards` · `guardCap` · `MAX_GUARDS` ·
 * `ECO_BOSS_CHANCE` · `GuardPlacement`) are gone with those import lines — nothing called them.
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
