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
| `parts/Containers.ts` | `ContainerSet` — interactable containers for structures, platforms, trams and the rover wreck; `CONTAINER_REACH`; `rollCrateContents` (same roll as the inventory crate code, used by previews); `ContainerSpec.lockedRoom` → `lootOpts(id)` (`CrateLootOpts`, epic+ gate exemption); `style: 3` (the cube supply crate) and the map-wide set index. |
| `parts/Glass.ts` | `GlassSet` — all window panes in one `InstancedMesh`, thin box colliders; `SMALL_BODY_R`. |
| `parts/ScanWave.ts` | Roof map-scanner wave (pooled additive shell, no light). |
| `parts/Turret.ts` | `CeilingTurretSet` — the indestructible ceiling turret of a locked space: model (merged mount plates + one head and LED per turret, no point light, no shadow), acquire → turn → warm-up → fire loop, `disableFor(structureId)` (the door's unlock is its only off switch), `isArmed`. Damage on the authority only. |

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
- **The ceiling turret is a device, not an enemy** (2026-09-21, user's decision 「무적 방어장치」): no hp, no
  collider, no entry in any enemy list — nothing can shoot it, and the only way past it is the room's door with
  the matching planet's key. Its damage runs on `ctx.isAuthority` only; the turn · laser · alarm · tracer run on
  every client from state everyone already has, so the intruder gets the warm-up warning on their own screen.
  Authority split and budgets: [`../README.md`](../README.md) Rules. — `parts/Turret.ts`
- `parts/` imports only types from `Structures.ts` / `Rails.ts`; values go in `model.ts`. `Rails` using
  `parts/Containers` is intentional (platform/tram containers are the same object); structures never import rails.

## Rules (appended 2026-09-21)

- **A container style is one table.** `style` 0–2 are the structure crates and `3` is the cube supply crate the
  rover wreck drops; the drawn size, the collider and `CONTAINER_REACH` all come from the one `STYLE_HX` / `STYLE_HZ`
  pair, so a new style is a row there and nothing else.
- **Id lookup spans every live set, `collect` does not.** `WorldSystem` resolves a container id by asking its own
  sets by name (`structures … ?? rails …`), and a set created **mid-raid** (the rover wreck) is in neither. So every
  live `ContainerSet` registers in a module-level index and `positionOf` · `lootOpts` · `markOpened` · `preview` ·
  `isOpened` fall through it. `collect` must **not** fall through — it is called once per set, so a set marked
  `adopted` (the rover's) is instead handed over by the first ordinary set, which keeps `getLootContainers`
  (the androids' looting) complete with no duplicate rows.

## Recent changes

Last 5 only — older: `git log -- src/world/structures`.
- 2026-09-21 — A-18 phase 2: `GlassSet.isWhole(key)` · `refOf(key)` (the nav graph's `windowWhole` · `breakWindow` go through
  `Structures`), `parts/Build.BREACH_W` exported (no wall-climb spot in front of the breach).
- 2026-09-21 — `ContainerSet` gained `style: 3` (cube supply crate) and a map-wide set index so the rover wreck's
  containers, created mid-raid, resolve by id and are adopted into `collect` exactly once.
- 2026-09-21 — `parts/Turret.ts` (`CeilingTurretSet`): the indestructible ceiling turret of the basement · lab locked room, plus `BuildingOut.turrets` (`TurretSpot` — a ceiling mount and the world OBB it watches) emitted by `parts/Build`.
- 2026-09-18 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels kept verbatim in backticks, no string literal touched.
- 2026-09-16 — `ContainerSpec.lockedRoom` + `ContainerSet.lootOpts`; `rollCrateContents(…, opts)` (locked rooms skip the epic+ gate).
