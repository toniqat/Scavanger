/**
 * src/world/rover/parts/Wreck.ts — the **supply crates a destroyed rover drops** (2026-09-21, user's decision).
 *
 * 「A rover raid pays what entering the basement pays」: `ROVER_WRECK_CRATE_MIN`…`MAX` cube crates (container style 3)
 * appear around the wreck, rolling on the **outpost-basement tier for the planet's threat** (`ROVER_WRECK_TIER_T1/2/3`
 * → `data/loot_tiers.csv`) and, like the lab's locked room, **exempt from the epic+ gate** (`CrateLootOpts.lockedRoom`
 * — `items/Loot.ts`).
 *
 * No new loot path and no new wire: the crates are an ordinary `ContainerSet` (`structures/parts/Containers`), so
 * opening them is the same `crate:open` → `inventory/Container` roll every crate on the map takes, the opened door
 * syncs through `crate opened` / `crate sync`, and the preview equals the opening because both go through
 * `shared/lootRolls.crateLootRandom`. The set is built `adopted`, which is how `WorldSystem`'s by-id chains reach a
 * set that did not exist at world-build time (see the index comment in `Containers.ts`).
 *
 * **Every client builds them**, not just the host: the count, the ring and the contents are all functions of the map
 * seed, and destruction itself is host-decided and already on the wire (`RoverWire.st` · `hp`). A late joiner that
 * receives an already-destroyed vehicle lays the same crates in the same places.
 */
import * as THREE from 'three';
import {
  PLAYER_RADIUS, Random,
  ROVER_HALF_LENGTH, ROVER_WRECK_CRATE_GAP_M, ROVER_WRECK_CRATE_MAX, ROVER_WRECK_CRATE_MIN,
  ROVER_WRECK_TIER_T1, ROVER_WRECK_TIER_T2, ROVER_WRECK_TIER_T3, planetThreat,
  type GameContext, type RoverVehicleDef,
} from '@/shared';
import type { BuildCtx } from '../../build';
import { ContainerSet, type ContainerSpec } from '../../structures/parts/Containers';

/** The id every wreck crate's zone shares — one `structure:investigated` for the whole drop. */
const WRECK_ZONE_ID = 'rover_wreck';
/** How far out from the body's centre the ring of crates sits (m) — clear of the hull, still obviously "from the car". */
const RING_M = ROVER_HALF_LENGTH + 1.6;
/** Candidate angles swept round the ring, and the extra radii tried when the first ring is blocked. */
const ANGLE_STEPS = 16;
const RADIUS_STEPS = [0, 1.4, 2.8];
/** When `resolveCollision` pushes further than this (m), the spot is inside something (the wreck included). */
const MAX_PUSH_M = 0.2;
/** The crate's own footprint radius (m) — style 3's half-diagonal, used for the push test. */
const CRATE_R = 0.45 * Math.SQRT2;

const _p = new THREE.Vector3();

/** The `loot_tiers.csv` tier a wreck crate rolls on, by the mission planet's threat. */
export function roverWreckTier(game: GameContext): number {
  const threat = planetThreat(game.missionPlanet);
  return threat >= 3 ? ROVER_WRECK_TIER_T3 : threat === 2 ? ROVER_WRECK_TIER_T2 : ROVER_WRECK_TIER_T1;
}

/**
 * Builds the wreck's crates into `set` (an `adopted` `ContainerSet`). Safe to call once per raid — `Rover` calls it
 * the moment the vehicle enters `destroyed`, on every client.
 */
export function buildRoverWreckCrates(game: GameContext, bctx: BuildCtx, set: ContainerSet, def: RoverVehicleDef): void {
  const world = game.world;
  const seed = (world?.seed ?? 0) >>> 0;
  const rng = new Random((seed ^ Random.hash('roverWreck')) >>> 0);
  const count = rng.int(ROVER_WRECK_CRATE_MIN, ROVER_WRECK_CRATE_MAX);
  if (count <= 0) return;
  const tier = roverWreckTier(game);
  const start = rng.next() * Math.PI * 2;

  const specs: ContainerSpec[] = [];
  const apart = (x: number, z: number): boolean =>
    specs.every((s) => Math.hypot(s.position.x - x, s.position.z - z) >= ROVER_WRECK_CRATE_GAP_M);

  for (const extra of RADIUS_STEPS) {
    for (let i = 0; i < ANGLE_STEPS && specs.length < count; i++) {
      const a = start + (i / ANGLE_STEPS) * Math.PI * 2;
      const x = def.position.x + Math.cos(a) * (RING_M + extra);
      const z = def.position.z + Math.sin(a) * (RING_M + extra);
      if (!apart(x, z)) continue;
      let y = def.position.y;
      if (world) {
        y = world.getSurfaceY(x, z, def.position.y + 1);
        // Clear ground only — the push test refuses a spot inside the wreck's own collider, a prop or a wall.
        const r = world.resolveCollision(_p.set(x, y, z), Math.max(CRATE_R, PLAYER_RADIUS));
        if (Math.hypot(r.x - x, r.z - z) > MAX_PUSH_M) continue;
      }
      specs.push({
        id: `${WRECK_ZONE_ID}_${specs.length}`,
        position: new THREE.Vector3(x, y, z),
        // Facing the wreck, so the door and its lamp read from where the player is standing when it blew up
        yaw: a + Math.PI,
        tier,
        style: 3,
        zoneId: WRECK_ZONE_ID,
        // `wreck` is the closest `StructureKind` there is, and the one `structure:investigated` it raises on the
        // first crate opened is exactly right here: searching a burning vehicle is noticed.
        zoneKind: 'wreck',
        lockedRoom: true,
      });
    }
    if (specs.length >= count) break;
  }
  if (specs.length === 0) return;
  set.build(bctx, game, specs);
}
