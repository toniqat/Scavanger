/* ────────────────────────────────────────────────────────────────────────────
 * Tutorial world queries (2026-09-14, `src/tutorial/README.md` Decisions).
 * Owner: `world/tutorial/` — published as `ctx.world.tutorial` (the same place and contract as `ctx.world.training`).
 *
 * The question this file answers: *what is different on the tutorial planet alone.*
 *
 *   1. **Checkpoints** — the tutorial has no raid failure. On death the corpse stands as usual (the gear stays
 *      in it) and the player stands up again at the last checkpoint passed. The only place that knows where
 *      those are is `world/tutorial/`, which built the map, so `game/parts/Death` asks here.
 *   2. **Fall rules** — cliff 1 kills outright (`kill`); cliff 2 must be survived, so hp is clamped to 1
 *      (`clamp`). Everywhere else the global fall damage applies (`normal`). The rule differs per place, so
 *      `player/` asks on landing.
 *
 * Outside a tutorial world `ctx.world.tutorial` is null and the caller carries on with `?? 'normal'` — the main
 * game does not change by one character.
 * ──────────────────────────────────────────────────────────────────────────── */
import type * as THREE from 'three';

/**
 * Checkpoints — in the order they are passed. On death the player stands up again at the **last one passed**.
 * The name is what that stretch teaches: `wake` (waking up) · `cliff` (sprint jump) · `corpse` (corpse looting) ·
 * `bugs` (shooting) · `crawl` (moving crouched) · `android` (aiming crouched) · `drop` (falling) ·
 * `supply` (healing · grenades) · `wall` (past the collapsed wall) · `ship` (the abandoned ship).
 *
 * Placement rule: **every checkpoint sits outside the detection range of that stretch's enemies** — someone who
 * stood up again without a weapon has to be able to go and pick up their own corpse.
 */
export type TutorialCheckpointId =
  | 'wake' | 'cliff' | 'corpse' | 'bugs' | 'crawl' | 'android' | 'drop' | 'supply' | 'wall' | 'ship';

export const TUTORIAL_CHECKPOINTS: readonly TutorialCheckpointId[] = [
  'wake', 'cliff', 'corpse', 'bugs', 'crawl', 'android', 'drop', 'supply', 'wall', 'ship',
];

/**
 * The rule for falling.
 *   `normal` = the global fall damage as it is (shield → hp, death is possible)
 *   `kill`   = instant death (cliff 1 — failing to clear it means falling and going back to the checkpoint)
 *   `clamp`  = the damage lands but hp never drops below 1 (cliff 2 — the landing must be survived)
 */
export type TutorialFallRule = 'normal' | 'kill' | 'clamp';

/**
 * One tutorial enemy's spot — **the world decides it and enemies builds the body**. No rolls, no waves, no
 * patrols. `type` is an enemy type id from `data/enemies.csv`, and `sense` · `leash` are narrow values that
 * apply to that one body alone (the defaults are `TUTORIAL_ENEMY_SENSE_M` · `TUTORIAL_ENEMY_LEASH_M`).
 */
export interface TutorialEnemySpawn {
  type: string;
  position: THREE.Vector3;
  yaw: number;
  /** Detection radius (m). It must be shorter than the reach of this stretch's checkpoint. */
  sense: number;
  /** It goes back once it is this far from its own spot (m). */
  leash: number;
}

export interface TutorialWorldRef {
  /** The last checkpoint passed (`'wake'` at the start). */
  readonly checkpoint: TutorialCheckpointId;
  /** The respawn pose — feet position and the yaw to face. Returns a fresh vector per call (the caller keeps it). */
  respawnPose(): { position: THREE.Vector3; yaw: number };
  /** The fall rule of the place fallen to (the landing point). `'normal'` outside every rule volume. */
  fallRule(position: THREE.Vector3): TutorialFallRule;
  /** dev console · smokes only: teleports to that checkpoint. false for an unknown id. */
  gotoCheckpoint(id: TutorialCheckpointId): boolean;
  /**
   * Every enemy this world has to build (fixed spots · fixed types). `enemies/` reads it once on `world:ready`
   * and builds them — the world owns the spots and enemies owns the bodies **so that the folders never import
   * each other**. A killed enemy does not come back with a checkpoint respawn, so this list is never read again.
   */
  enemySpawns(): readonly TutorialEnemySpawn[];
  /**
   * appended (2026-09-16, owner: world/tutorial — read by `tutorial/TutorialSystem`): how far through the
   * collapsed passage (the crawl stretch) the position is. 0 = entrance · 1 = exit; before the entrance it is
   * negative and past the exit it is greater than 1 (never clamped). Only the world has the passage's coordinates.
   */
  crawlProgress?(position: THREE.Vector3): number;
}
