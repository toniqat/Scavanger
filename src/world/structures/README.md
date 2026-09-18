# world/structures/ — Abandoned-structure and rail parts

Sub-folder of `world/`. No system, no `ctx` publication: the owning classes are `../Structures.ts` and `../Rails.ts`;
this folder holds their shared vocabulary (`model.ts`) and extracted method bundles (`parts/`). Folder rules and the
public API are in [`../README.md`](../README.md) (sections `Structures` and `Rails and trams`).

## Files

| File | Responsibility |
|---|---|
| `model.ts` | Only reader of `data/structures.csv` (`STRUCTURE_ROWS`, `structureRow`, `pickTier`) + building dimensions (`WALL_T`, `DOOR_W`, `STAIR_*`, `OPENING_APPROACH`, `SLAB_T`, `WINDOW_*`, `BASEMENT_*`, `PIT_BLEND`, `LOCKED_ROOM_*`, `VENT_*`, `CONTAINER_RADIUS`, `FLOOR_OVERHANG`, `FLOOR_LIP`); re-exports `RAIL_CLEARANCE_M`. No THREE value imports. |
| `parts/Build.ts` | One building's geometry + colliders: `buildBuilding` (outpost, lab), `buildWreck`. Placement order (front door → partition → stairs / basement hole → passages → breaches, windows, props, containers, light spots, locked room, drone vents), `StructureNav` for reach smokes. Tilted meshes measure colliders from drawn vertices (`fitBox`, `propHullOf`). |
| `parts/Stairs.ts` | `buildStairFlight` — drawn steps + one ramp collider (structures and rail platforms). |
| `parts/Containers.ts` | `ContainerSet` — interactable containers for structures, platforms, trams; `CONTAINER_REACH`; `rollCrateContents` (same roll as the inventory crate code, used by previews); `ContainerSpec.lockedRoom` → `lootOpts(id)` (`CrateLootOpts`, epic+ gate exemption). |
| `parts/Glass.ts` | `GlassSet` — all window panes in one `InstancedMesh`, thin box colliders; `SMALL_BODY_R`. |
| `parts/ScanWave.ts` | Roof map-scanner wave (pooled additive shell, no light). |

## Rules

- **Colliders are the drawn silhouette.** A new mesh gets a matching collider, or a code comment saying why it is
  drawing-only (e.g. above body height).
- **Keep doorway approaches clear.** Anything that blocks (railings, props) must not overlap an `OPENING_APPROACH`
  rectangle; `scripts/smoke-structure-reach.mjs` flood-fills with the player radius to check.
- **Protect exclusion zones by bulk, not centre point.** Objects placed outside an exclusion zone back off by
  `clearFor(reach) = reach + PLAYER_RADIUS * 2`; containers use `CONTAINER_REACH`. Otherwise the push-out band of the
  object and a wall inside the zone (e.g. a stair-hole railing) close the only lane. — `parts/Build.ts` (`clearFor`)
- **Filter candidate spots after shuffling**, never before: the shuffle's draw count equals the list length, so
  pre-filtering shifts every later draw for the seed.
- A preview must roll exactly what opening rolls: `rollCrateContents` and `inventory/Container.ContainerStore.getOrCreate`
  both use `crateLootRandom` (`src/shared/lootRolls.ts`) + `loot.rollCrateOn(tier, rng, planet, opts)` — change both together.
  `opts` is `ContainerSet.lootOpts(id)` on both sides (inventory reads it through `WorldRef.crateLootOpts`).
- `parts/` imports only types from `Structures.ts` / `Rails.ts`; values go in `model.ts`. `Rails` using
  `parts/Containers` is intentional (platform/tram containers are the same object); structures never import rails.

## Recent changes

Last 5 only — older: `git log -- src/world/structures`.
- 2026-09-18 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels kept verbatim in backticks, no string literal touched.
- 2026-09-16 — `ContainerSpec.lockedRoom` + `ContainerSet.lootOpts`; `rollCrateContents(…, opts)` (locked rooms skip the epic+ gate).
- 2026-09-14 — Exclusion zones guarded by object bulk: `clearFor` in `parts/Build`, `CONTAINER_REACH` in `parts/Containers`.
- 2026-09-12 — README created.
