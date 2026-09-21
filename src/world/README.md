# world/ — Procedural planet surface, world objects and collision queries

`WorldSystem` owns everything the player walks on and bumps into during a mission: terrain, biomes, props, crates,
gather nodes, abandoned structures, rails and trams, the rover, environmental hazards, fog of war, the training arena
and the hand-built tutorial planet. It publishes `ctx.world` (`WorldRef`) and answers every height / surface /
collision / raycast query. The whole map is generated **synchronously** inside `game:newMission` and torn down on
`game:abort`. No asset files — all geometry, colours and textures are procedural. Other folders reach world only
through `ctx.world` (only `main.ts` imports `WorldSystem`).

## Files

| File | Responsibility |
|---|---|
| `WorldSystem.ts` | `GameSystem` + `WorldRef`. Generation order, `SpatialHash` owner, all queries (`raycast` / `raycastBlast` share one `rayQuery` body), mode branches (`raid` / `training` / `tutorial`), open-state sync of crates and containers, `genTimings`. |
| `index.ts` | Barrel (only a few exports are used; outside code goes through `ctx.world`). |
| `layout.ts` | Macro layout from the seed: rail plan, spawn, rover road plan, extraction pads (`extractionPadCount`), nests, POIs, craters, basins, `StructureSite`s. `railDistance` / `railClearance` / `roverClearance`, `padClearance`, `nearestPad`, `LayoutOptions` (spore layout, intel). |
| `preview.ts` | `planLayoutFor` (biome + hazard kind + layout — used by `generate`) and `previewLayoutFor` (flat `MapPreviewLayout` for `WorldRef.previewLayout`). |
| `noise.ts` | Seeded `noise2` / `noise3`, `fbm`, `ridged`, `billow`, `lerp` / `clamp` / `smoothstep`. |
| `biomes.ts` | Five biome palettes; `biomeById(PlanetDef.biome)`; `pickBiome(seed)` fallback mirrors core's sky-palette draw. |
| `Terrain.ts` | Heightfield (`EXTENT`, `CELL`, 8×8 chunk meshes, vertex colours, procedural detail textures); flattens pads, digs basement pits; `getHeightAt`, `getNormalAt`, `getSlopeAt`, ray-march. |
| `SpatialHash.ts` | 16 m XZ grid of `ObstacleEntry`: `add` (cylinder + optional shot cylinder), `addBox`, `addHull`, `addRamp`, `move`, `remove`, `query`, `overlaps`, `walkSegment`; internal flags `passRays` / `passSmall`; `onChange` (the nav graph's re-measure hook, null outside a baked raid). |
| `obb.ts` | Box collider math: `boxContainsXZ`, `boxPushOut`, `rayBox`, `boxHitNormal`, `rampTopAt`, `rayRamp`, `BOX_HEADROOM`. |
| `hull.ts` | Convex prism math: `convexHull2D` (≤ `HULL_MAX_VERTS`), `hullContainsXZ`, `hullPushOut`, `rayHull`, `hullHitNormal`, `hullAreaCentroid`. |
| `propHull.ts` | `propHullOf` — measures a prop instance's movement hull + shot bands from the drawn mesh above ground. |
| `build.ts` | `BuildCtx` for sub-builders; `isSpotFree` (pads, hash, rail + rover clearance), paint / displace / merge helpers, `PLAY_LIMIT`. |
| `Props.ts` | Scattered instanced props (boulders, spires, trees, crystals, grass, pebbles, debris); hull colliders for rock / crystal / debris, trunk cylinder for trees. |
| `Nests.ts` | Bug nest mounds (obstacles), hole positions (`getNestPositions`) and **egg spots** (`getEggSpots`, per nest pad — the eggs themselves are enemies drawn by `enemies/`). |
| `BurrowGround.ts` | `burrowGroundOk` — the one judgement "can a sandworm erupt here": flat terrain samples, no pad / rail / rover corridor, no structure footprint, no hash collider, nest / gather / crate / spore-grove clearance, not inside the active hazard. Shared by the enemies director and the thumper placement preview. |
| `Pads.ts` | Extraction platforms (`PLATFORM_HEIGHT` / `PLATFORM_RADIUS`, one point light each) and the spawn marker. |
| `Outposts.ts` | POI ruins (walls, pillars, mast); `getSites()` → ruin sites for fog discovery, footstep material, `getRuinSites`. |
| `Crates.ts` | Loot crates around landmarks only (POIs, structure rings — none in open field, none near a nest, no tier 4); `Interactable`, lid tween, `crate:open`; open state via `setOpenListener` / `markOpened`. |
| `Gather.ts` | Harvest nodes: herbs, salvage piles (bonus core / mineral), soil, wild seeds, specimens, grove mushrooms, **mineral veins** (`vein_*`, the only node with a collider). Host-authoritative `harv` / `harvq`. `resolveNodeWeights` drops retired defs. Debug `debugBonusOf` / `debugBonusesOf`. |
| `soil.ts`, `flora.ts`, `specimen.ts` | Per-planet soil / seed / specimen tables from `data/planets.csv` (`planetSoil`, `planetSeeds`, `planetSamples`). |
| `mineral.ts` | 광맥 numbers: `planetMineralNodes` (`planets.csv` `mineralNodes`), `mineralRarityWeights` (`loot_tiers.csv` row `tier = planet threat`, **including the `mythic` column**), `rollMineralRarity` (채광 bonus applied as a multiplier). No THREE. |
| `surface.ts` | Footstep material: `obstacleMaterial` (kind → material), `terrainMaterial` (biome band rules), `onOutpostSlab`. |
| `SiteSpawns.ts` | `getSiteSpawnPoints` implementation: indoor spots by body-radius flood fill from the door (per-site cache), outdoor ring spots, grouped picks with a site-seeded RNG. |
| `Ambience.ts` | Camera-following spore points and dust sprites. |
| `Fog.ts` | `FogRef` fog-of-war mask, discovery gate, `fog` / `fogq` sync. |
| `Hazard.ts` | `HazardRef`: plan, zones, player / ghost / rover damage ticks, `atmo:override`, hazard events, `hz` / `hzq`. |
| `hazard/model.ts` | Only reader of `data/hazards.csv`; `HazardPlan`, grove dimensions, `pickStartSeconds`, `isFrontKind`. |
| `hazard/parts/Plan.ts` | Draws: `drawHazardKind` (first draw of `HAZARD_FORK`), `planGroveSpots`, `planHazard` (start, front direction, eye centre, spore sources, `delayS`). |
| `hazard/parts/Zones.ts` | Plan + `missionTime` → zone shapes (`buildZones`, `progressAt`, `stormEyeStartRadius`, `zoneDepth`); allocation-free. |
| `hazard/parts/Grove.ts` | Giant mushroom groves (stems are the only colliders). |
| `hazard/parts/Visuals.ts` | Walls (shader clip + spore union), particles ramped by progress, `warm(shaders)`. |
| `Structures.ts` | Abandoned structures: build, doors / planet-bound keys, roof scanner, ladders, windows, containers, ceiling turrets, light pool, `struct` / `structq`, rogue-drop zone record, `previewContainerItems`, `debugNav`, `isTurretArmed`. |
| `structures/` | Vocabulary + parts for buildings — see [`structures/README.md`](structures/README.md). |
| `nav/` | The raid's walkable graph (`WorldRef.nav`, TODO A-18): outdoor grid + per-structure grids, ladders, A\*, re-measure — see [`nav/README.md`](nav/README.md). |
| `Rails.ts` | Rail centreline, tram state machine, cab + platform call consoles, `tram` / `tramq`. No geometry. |
| `rails/model.ts` | `RailPath` math, rail / tram dimensions and colours, `RailBuild`, `TramInst`. Axis convention lives here. |
| `rails/parts/Track.ts` | Ties, rails, piers, walkable deck boxes every `RAIL_DECK_STEP`. |
| `rails/parts/Platform.ts` | Platform deck, stairs (`buildStairFlight`), railings, containers, call console (returns its spot). |
| `rails/parts/Tram.ts` | Tram body (length along travel), walk-in cab, console desk, colliders sharing one `velocity`, `placeTram`, `updateTramHit`. |
| `rover/model.ts` | `RoverPlan`, closed-loop path math, `shortestTrip`, `roverFareFor` (the only fare formula), the hit-zone vocabulary (`ROVER_PART_ORDER`, `roverWheelZoneOf`, `roverSpeedMulFor`) and the `RoverHitRequest` wire shape. |
| `rover/RoadPlan.ts` | `planRoverRoute` (polar loop, 4–5 stations, avoids rail corridor), `roverRouteDistance`, `minTurnRadius`. No THREE. |
| `rover/RoverRoad.ts` | Resamples the plan into `RoverRouteDef`, builds road + station poles and their colliders. |
| `rover/RoadMesh.ts`, `rover/StationMesh.ts` | Road ribbon on terrain; station poles / beacons / signs (no lights). |
| `rover/Rover.ts` | Vehicle lifecycle, state machine, boarding, fares, hazard damage, player-side hits (hull `destructible` → hit zones · `roverq hit`), hostility, wreck crates, `RoverRef`, `rover` / `roverq`, `cheat:rover`. |
| `rover/parts/Body.ts`, `Turret.ts`, `Impact.ts`, `Exits.ts`, `Fx.ts` | Hull model + one box collider (no `velocity`) + **two** gun mounts and the blown-wheel / dead-gun looks; turret targeting / fire (two profiles, people when hostile); ram impacts; exit spots; tracers / wreck FX. |
| `rover/parts/Parts.ts` | Hit-zone state: part hp, `resolveRoverPart(body, worldPoint)`, the hull share (`ROVER_PART_HULL_MUL`), the wheel speed rule, the aggro counter, `RoverWire.pt` / `.ho` pack / apply, part looks. |
| `rover/parts/Wreck.ts` | The cube supply crates a destroyed rover drops — the ring around the wreck and the basement-level tier (`lockedRoom` exempt), built into an `adopted` `ContainerSet`. |
| `TrainingArena.ts` | Simulation training range (`TrainingRef`): deck, invisible walls, pop-up targets, target modes, consoles. |
| `tutorial/model.ts` | Tutorial planet shape: levels, corridor profile, deck pieces, chasm, checkpoints, fall rules, enemy spots (per-spot `sense` / `weapon`), corpse spots, ship pose, crawl slab, barrier, pit + walls + north rim, fence stair cuts (`fenceColumns`), ship hill + slope, wall descent, `lowerTilingErrors`. |
| `tutorial/TutorialWorld.ts` | `TutorialWorldRef` + tutorial queries (`heightAt`, `raycastGround`, `isInside`, `clampInside`, `surfaceMaterial`), checkpoint tracking, safe-ground respawn, ship placement. |
| `tutorial/parts/Ground.ts` | Deck pieces with cliff faces, chasm edges, corridor walls and funnels, abyss, pit + ramp + walls. |
| `tutorial/parts/Dressing.ts` | Start ruins (incl. the fallen mast with its collider), crawl tunnel, diagonal barrier + blind fence, rubble (fixed `DRESSING_SEED`). |
| `tutorial/parts/Corpses.ts` | Three hand-placed corpses with fixed item lists via `ctx.inventory.openContainerItems`; an emptied one sinks and is removed (`update`, ticked by `TutorialWorld.update`). |

## Public API

`WorldRef` is declared in `src/shared/types.ts` (several merged blocks); `TutorialWorldRef` in `src/shared/tutorialWorld.ts`.

- **Geometry queries**: `getHeightAt`, `getNormalAt`, `getSurfaceY(x, z, feetY?)`, `getStandingObstacle`, `resolveCollision(position, radius, height?)`,
  `raycast`, `raycastBlast` (2026-09-18: the same ray with glass blocking whether broken or not — `shared/explosion.lineClear` only),
  `isInsideBounds`, `obstacleCoverage`, `scatterPoints`, `getObstaclesNear`, `addObstacle` (dynamic cover; returns remover),
  `getSurfaceMaterial(x, z, feetY?)`, `size`, `mode`, `planet`, `seed`, `getBiome()`.
- **Objects**: `getPlayerSpawn`, `getExtractionPoints`, `getEnemySpawnPoints`, `getCrates`, `getNestPositions`,
  `getNestEggSpots()` (2026-09-18: `NestEggSpot[]` — where a `bug_egg` enemy stands; `nest` is the **pad** index, not a
  `getNestPositions()` index), `getGatherNodes`,
  `getStructures`, `structureAt`, `getLadders`, `getRailLines`, `getTrams`, `getRuinSites`, `getSiteSpawnPoints`, `previewContainerItems`,
  `crateLootOpts(id)` (2026-09-16: `{ lockedRoom: true }` for lab locked-room containers, else undefined — the `CrateLootOpts` every
  crate roll path passes to `LootRef.rollCrateOn`),
  `getLootContainers()` (2026-09-15: crates + structure / platform / tram containers as `LootContainerInfo` — id, live
  position, tier, opened, kind; **reused array and reused entries**), `markContainerOpened(id)` (2026-09-15: open the
  lid / door for an android take and tell the squad with `crate opened`; no event, no stats, no 감정 XP),
  `burrowGroundOk(x, z, radius)` (2026-09-15, optional on `WorldRef`: true only on flat bare ground with nothing in the
  circle — rules in `BurrowGround.ts`; training / tutorial worlds return false; thresholds `BURROW_GROUND_*` in csv).
- **Sub-refs**: `fog` (`FogRef`), `hazard` (`HazardRef`), `rover` (`RoverRef`), `env` (planet `env` column), `training` (`TrainingRef`),
  `tutorial` (`TutorialWorldRef`), `nav` (`NavRef`, 2026-09-21 — planet raids only, `ready` once the bake finished). Each is null when the
  mode / planet does not have it. Debug: `debugNav` (the `NavGraph`, counts · bake time).
- **`previewLayout(seed, planet, intel?)`** — pure; callable from the hub (no meshes, no state touched).
- **Events emitted**: `world:ready {seed, playerSpawn, planet}`, `world:cleared`, `fog:revealed`, `fog:discovered`, `hazard:planned / announced /
  started / progress / insideChanged`, `atmo:override`, `ghost:damage`, `crate:open` (structure containers add `zoneId` / `zoneKind`),
  `gather:collected`, `structure:unlocked / scanned / investigated / glassBroken`, `ladder:grab`, `rail:tramStarted / tramDocked`,
  `rover:*` (state, departed, arrived, boarded, fired, damaged, destroyed, refused, tripStarted, stationsRevealed, destinationSelect),
  `world:interacted` (scanner, tram, basement / lab door, rover — only for this client's own action), `tutorial:checkpoint`,
  `training:*`, `ui:objective`, `ui:notify`, `audio:play`.
- **Events consumed**: `game:newMission {seed, mode?, planet?}`, `game:abort`, `net:hostChanged`, `crate:looted`, `structure:investigated`, `cheat:rover`.
- **Wire** (`src/shared/net.ts`; replies accepted only from the lobby host):

| Message | Use |
|---|---|
| `fog` / `fogq` | late-join fog mask (`sync`) |
| `harv` / `harvq` | host-authoritative harvest (`take`, `sync`) |
| `hz` / `hzq` | late-join hazard plan (`sync`) |
| `crate` (`opened`, `sync`, `syncq`) | open look of crates / containers; anyone sends `opened`, host answers `sync {ids}` |
| `struct` / `structq` | scanner, door unlock (`by`), broken glass, full `sync` (incl. `rogued`, `glass`) |
| `tram` / `tramq` | tram `state` broadcast; `start` request |
| `rover` / `roverq` | rover `state`, `trip`, `eject`, `fire`, `reply`; `board` / `exit` / `trip` / `sync` requests |

Every host sync above is also pushed on `flow rejoined`; clients re-request on `net:hostChanged {isLocalHost:false}`.

## Generation

Order in `WorldSystem.generate`: `planLayoutFor` (hazard kind → biome → layout) → terrain → nests → pads → outposts →
structures → rails → rover road + vehicle → hazard (groves) → props → crates → gather → ambience → fog → **nav start**.
`world:ready` is emitted at the end, inside the `game:newMission` emit. The nav graph is only *started* there — it bakes
over the next frames (`NAV_BAKE_BUDGET_MS`, ~50–150 ms of CPU in total), so generation time is unchanged.

- Layout order inside `generateLayout`: **rail first, then spawn, then the rover road**, then everything else avoids them
  (`railFree` / `roverFree`). Rail is a line through the origin or a loop around it — one degree of freedom — so it cannot
  be fitted between already-placed pads. Corridor half-width is `RAIL_CLEARANCE_M`; the rover corridor is `roverClearance`.
- Obstacles registered earlier are avoided by later placement (`isSpotFree` reads the hash): structures, rails, rover and
  groves are built before props / crates so no rock stands inside a room.
- Every subsystem draws from its own `rng.fork(label)`; `Random.fork` never advances the parent, so adding a fork does not
  shift other streams. Late-added features (salvage bonuses `gather_core` / `gather_mineral`, `gather_soil`, `gather_seed`,
  `gather_sample`, `gather_vein` / `gather_vein_roll`, `hazardGroves`, `structureLocks`, `roverVehicle`) use their own
  forks for that reason.
- Probabilistic features (`RAIL_CHANCE`, `ROVER_CHANCE`) always consume their roll; intel only overrides the result.
- Intel (`ctx.missionIntel` → `LayoutOptions.intel`, set before `game:newMission` is emitted): extraction pads +N (added
  to `extractionPadCount`), nests +N (after `NEST_COUNT_MIN/MAX` roll), rail forced + platforms +N, basement facilities +N
  (extra outposts with basements / two-floor labs, may exceed `maxCount`), rover forced (`ROVER_PLAN_ATTEMPTS_INTEL`),
  hazard delay +N s (added after the roll). Named-rogue pick is applied by `enemies/`.
- Spore raids (`sporeLayout`): central spawn, central grove, outer extraction pads (`EXTRACTION_PADS_SPORES_*`); other
  raids use `EXTRACTION_PADS_MIN/MAX_BY_THREAT`.

## Collision model

| Collider | Created by | Notes |
|---|---|---|
| Cylinder | `SpatialHash.add` | Trees (trunk), pads' poles, dynamic cover, consoles. Optional larger shot cylinder (`shotRadius` / `shotHeight`). |
| Box (`Obstacle.box`) | `addBox` | Walls, floors, decks, doors; may float (slabs, tram deck). `radius` = circumscribed circle. |
| Hull (`Obstacle.hull`) | `addHull` | Rocks, spires, crystals, debris, wreck nose: 2D convex hull up to body height + per-height shot bands. |
| Ramp (`Obstacle.ramp`) | `addRamp` | Every staircase (`buildStairFlight`), wreck wings / ramp, tutorial pit ramp. Steps are drawing only. |
| Flags | internal | `passRays` (rays ignore) + `passSmall` (bodies under `SMALL_BODY_R` pass): broken windows, tutorial fence ghost band. `raycastBlast` re-blocks `kind === GLASS_OBSTACLE_KIND` only — the fence ghost keeps letting blasts through. |
| `velocity` | tram colliders | Presence marks a moving platform (also when stopped). |

Box math is used only when `o.box` is set; cylinder code paths are separate.

## Rules

- **The nav graph measures with the movers' own queries and follows every collider change (2026-09-21, TODO A-18).**
  `getSurfaceY` is its floor and `resolveCollision` its "does a body fit", so a new collider shape needs nothing there; a
  collider added · removed · moved after generation must go through the hash (`insert` · `remove` · `move`), whose
  `onChange` queues the cells under it for a re-measure — a collider changed behind the hash's back (a mutated
  `position` with no `move`) leaves the graph believing the old shape. Every client bakes, only the authority queries;
  nothing is on the wire. — `nav/`, `SpatialHash.onChange`
- **A scattered prop casts a shadow only within `PROP_SHADOW_DIST_M` of the eye.** One variant is one
  `InstancedMesh` spanning the map with `frustumCulled = false`, so three.js could never drop a single instance
  from the shadow pass — the four boulder meshes alone were 92k of S2's 158k world shadow triangles.
  `Props.repackShadowLod` splits each casting variant into a **near** mesh (`castShadow`) and a **far** one and
  re-splits when the eye moves `PROP_SHADOW_REPACK_M`. Every instance is in exactly one of them, so the colour
  pass is unchanged; what changes is that a big boulder past that distance loses a long shadow on a low-sun
  planet. A new scattered prop needs nothing — `finalize` gives it the pair if any of its parts casts.
  (2026-09-20 — `docs/PERF.md` perf Phase A2.) — `Props.ts`
- **Waist-high loot boxes do not cast**: crates, structure containers, rail containers and debris props
  (`castShadow = false`, `receiveShadow` kept — that is what sits them on the ground). 138 casters for 12k
  triangles, and their own shadow read as a smudge underneath. — `Crates.ts`, `structures/parts/Containers.ts`, `Props.ts`
- **Surface first, push-out second.** Movers set `pos.y = getSurfaceY(x, z, pos.y)` and only then call `resolveCollision`;
  reversed, a body is pushed away before it can step up. Players, enemies, replicas and corpses all follow this. — `WorldSystem.getSurfaceY`
- **A box whose top is within `PROP_STEP_UP_MAX` of the feet is not pushed** (same ceiling as `getSurfaceY`), so stairs
  and low crates are climbable. Cylinders and hulls have no such exception. Standing on top uses `PROP_TOP_MARGIN` in both
  `resolveCollision` and `getStandingObstacle`. — `WorldSystem.resolveCollision`
- **Head clearance under a floating box/hull** is `BOX_HEADROOM` for people, `2r` for small bodies (`radius < SMALL_BODY_R`,
  which also lose the step-up exception), or the explicit `height` when a body passes one (ground drones through door
  vents). Enemies / remotes / corpses must not pass `height`. — `WorldSystem.resolveCollision`
- **Falling and thrown objects land on `getSurfaceY(x, z, bodyTop − PROP_STEP_UP_MAX)`**, not `getHeightAt` — otherwise
  they fall through upper floors. Effects left on the ground (fire zones, deployables) use the same rule.
- **Terrain slope applies only while the feet are on terrain** (`getHeightAt(x, z) >= feet − 0.02`); `getNormalAt` is the
  terrain normal even under a floor slab.
- **`box.yaw` is the math convention (local +X → world `(cos, sin)`); the mesh Euler Y is `-yaw`.** Mismatched signs
  mirror the collider. — `obb.ts`, `tutorial/parts/Ground.addObb`
- **Colliders are measured from what is drawn.** Buried parts of rocks/spires do not count (`propHullOf` uses vertices
  above terrain plus edge–terrain crossings); a stray vertex inflates a collider, so changes to prop geometry or
  `noise3` must re-check colliders (`smoke-props-collision`).
- **`radius >= hypot(halfX, halfZ)`** for any box, or broad-phase queries miss it. Very large surfaces are tiled
  (tutorial `DECK_TILE_M`) so `SpatialHash.maxRadius` stays small; tiles overlap by `TILE_OVERLAP` so seam points never
  fall through.
- Moving platforms beat static ones inside the `PROP_TOP_MARGIN` window in `getStandingObstacle` (tram deck vs. rail
  deck tie). Riding logic lives in `src/shared/ride.ts`; world only fills `velocity` and re-buckets with `hash.move`.
- `obstacleCoverage` deliberately counts boxes by circumscribed circle and hulls by equal-area circle (over-estimate is safe for large-enemy spawns).
- **Noise kernels are bit-exact (C-66).** `noise2`, `fbm` and `ridged` inline the same kernel; change all three together
  and bit-compare against the old implementation — layouts, colliders and multiplayer determinism depend on it. — `noise.ts`
- `structures/model.ts`, `hazard/model.ts`, `flora.ts`, `specimen.ts` are `DATA_OWNERS` in `scripts/data-owners.mjs`,
  loaded very early by `data:check`: no THREE value imports there. `soil.ts` and `mineral.ts` follow the same shape
  (csv → types, no THREE) and should join that list.
- **광맥 (mineral veins, 2026-09-16)** — the sixth gather kind, four things apart from the other five:
  1. **Slope only.** A vein stands where `Terrain.getSlopeAt >= MINING_HILL_MIN_SLOPE` (user decision 「주로 언덕 사면 위주」),
     capped at the steepest ground a player can walk (`tan(IMPLANT_DASH_MAX_SLOPE_DEG)`) so every visible vein is reachable.
     The same `isSpotFree` call keeps it out of pads, the rail corridor, the rover corridor and every existing collider
     (doorway approaches included — `Structures` cleared and occupied them first).
  2. **It is the only gather node with a collider** (a cylinder matching the drawn outcrop above ground); harvesting removes it.
  3. **The rarity is rolled at harvest, not at generation** — it depends on the harvester's `derived.miningRarityBonus`.
     Weights come from `loot_tiers.csv` `tier = planet threat` (the weapon-drop table; no second table) read through
     `mineral.ts`, **not** through `@/items` `getTierTable`, whose `RARITY_ORDER_LOOT` deliberately cuts at 5 rarities —
     the vein is the one path allowed to roll `mythic`. The skill is a **multiplier** on the weights above the lowest
     allowed rarity, so a rarity the threat row zeroes stays impossible at any 채광 level.
  4. **The skill is 채광, and it is reached the ordinary way.** The vein has its own `GatherNodeKind` value `'mineral'`,
     so it emits `gather:collected {kind:'mineral'}` exactly like the other five and `ProgressionSystem`'s one handler
     picks 채광 from the kind — `Gather` never calls `ProgressionRef.addSkillXp` itself. The only difference from the
     others is **when `defId` is decided** (at harvest, so the event carries the id just rolled).
- **Glass blocks blasts, broken or not (2026-09-18, user decision 「창은 깨졌어도 폭발을 막고, 낮은 엄폐물은 기존대로」).**
  A broken pane keeps its collider but turns `passRays`, so `raycast` walks straight through a window frame — which let
  artillery hurt a player standing in the **middle of a room** that happened to have one window. `raycastBlast` is the same
  ray with one difference: a collider whose `kind` is `GLASS_OBSTACLE_KIND` blocks it regardless of `passRays`. Only
  `shared/explosion.lineClear` (blast + melee occlusion) uses it; bullets, enemy sight and thrown gadgets are unchanged.
  The test is the **kind**, not the flag, because the tutorial's ghost fence band (`tut_fence_ghost`) is `passRays` too and
  must keep letting blasts through — blocking it would turn the tutorial's low barrier into a shield. Low cover is not
  special-cased at all: it was never `passRays`, so it blocks both rays exactly as before and a head peeking over it still
  gets hit through `blastReachesBody`'s 3-point rule. — `WorldSystem.raycastBlast`, `structures/parts/Glass.ts`
- **Nests hand out egg spots, not eggs (2026-09-18).** The egg sacs at a nest mound's base used to be one merged decorative
  mesh; they are now destructible immobile enemies (`bug_egg`, owner `enemies/`). World still decides **where** an egg
  stands and hands the spots over (`Nests.getEggSpots` → `WorldRef.getNestEggSpots`) with the old look's numbers left in a
  comment for the new owner; it builds no mesh, no material and no collider for them. `NestEggSpot.nest` is the **nest pad**
  index (`layout.nests`) because 「a nest」 is the pad a player sees — `getNestPositions()` is indexed per **hole** (a pad has
  4–6 mounds), so the two orderings are deliberately different and must not be crossed. The rng draw order inside the egg
  loop is unchanged, so the same seed still yields the same map. — `Nests.ts`
- **No crates near a nest (2026-09-18, user decision).** The nest's reward is the eggs, so the nest crate ring (one tier-3
  crate per nest) is gone and every other ring refuses a spot within `NEST_CRATE_CLEAR_M` (`data/tuning.csv`, 24 m — mounds
  reach 18.1 m from the pad) of a nest pad. A raid therefore has ~4–6 fewer crates, all tier 3; nothing was raised to
  compensate. — `Crates.ts`
- **The ceiling turret rides the locked door's wire, and only the authority hurts anyone (2026-09-21).** Its
  「powered down」 state **is** `StructureDef.unlocked` — host-decided, spread by `struct unlocked` and replayed to a
  late joiner in `struct sync.unlocked`, so `Structures.applyUnlock` calling `CeilingTurretSet.disableFor` covers
  every path and the turret needs no message of its own. **Damage is applied on `ctx.isAuthority` only** — the
  local player through `PlayerRef.takeDamage` with source `explosion` (「physical damage that is nobody's body」,
  the same cause a tram collision carries), a squadmate through the existing `dmg` message, an android through
  `AlliesRef.damage`. The **look** (turning, laser, alarm, tracer) is stepped on every client from state everyone
  already has — the unlocked flag plus the 20 Hz positions — so the victim sees the warning on their own screen;
  a disagreement can only paint the beam at the wrong body for a frame, never hurt anyone. Its line of fire is one
  `WorldRef.raycast` from the muzzle, which is also 「it must not shoot through the closed door」 (the panel is a
  `door` collider until it opens), and a body outside the room's OBB is never a target, which is 「it does not
  follow anyone out」. — `structures/parts/Turret.ts`
- **The turret adds no light and almost no draw.** A point light would recompile every material and the raid budget
  has zero spare slots, so the warning is the laser · the alarm · an emissive LED. Every mount plate merges into one
  static mesh; a turret owns one head (~24 triangles, no shadow) and one LED quad, the heads share the structure
  material and the LEDs one emissive material; the laser and the shot go through the shared `TracerPool`. — `parts/Turret.ts`
- Point lights: structures use a `LightPool` of `STRUCTURE_POINT_LIGHTS` real lights moved between room spots, built even
  on maps without structures, so the raid light count is constant (`SCENE_POINT_LIGHT_BUDGET` has zero spare in raids).
  Everything else in world (beacons, consoles, arena, tutorial, rover, scan wave) is emissive only.
- A preview must roll exactly what opening rolls (`previewContainerItems` → `ContainerSet.preview` → same `contents()`), with the same
  `CrateLootOpts` (`ContainerSpec.lockedRoom` → `ContainerSet.lootOpts` → `crateLootOpts`).
- Rover and rail corridors must stay empty: any new placement code checks both `railClearance` and `roverClearance`
  (`isSpotFree` enforces them even with `ignorePads`).
- **Intended**: the five planets are recombinations of the five biomes — no new enemies or items, and a kind missing from
  `eco.bugs` never appears however high its cap. Ambience and wave composition use `Math.random()`, so they are **not**
  seed-reproducible (the seed guarantees terrain, gather nodes and log-guard placement).
- **Intended**: generation is synchronous, ~197 ms (2026-09-11: 230 → 197, heightmap 97 → 78). The kernel is ~14 ns per
  call — close to the scalar-JS floor — so what is left is the **number of calls**; sparse sampling, async/worker
  generation or SIMD/WASM are all decisions first. Same seed must stay byte-identical (`noise.ts` head comment holds the
  identity-check procedure).
- **Intended**: a mineral vein is the only gather node with a collider, so standing on a slope it can block a path; its
  rarity is rolled at harvest, so two players see different grades from the same vein (each has their own 채광 skill).
  Mythic ore has to pass difficulty 3 → 미확인 광물 VI → analysis level 4, so its felt frequency is unmeasured.
- **Intended**: training target modes are client-local. — `TrainingArena.ts`
- **Intended (2026-09-18 user decision)**: there are **no specimen gather nodes** on any planet — `data/planets.csv` has
  `sampleNodes` 0 and an empty `samples` on all five rows. 미확인 광물 comes from 광맥 (`mineralNodes`) and salvage
  piles, 미확인 세포 from killing bugs (and bug eggs), 미확인 유전자 from lab containers. `specimen.ts` and both
  columns stay: the file is data-driven and `nodes = 0` already means 「this planet has no specimen site」, so putting
  a number back is the whole of re-enabling them. The empty column is not a missing value.

## Structures

Kinds: outpost (`버려진 전진기지`), lab, wreck (`data/structures.csv`). Outposts and labs have walls of `wallH`, a ceiling
per floor, a random second floor (`upperChance`), a roof reached by a ladder on the top floor's partition
(`getLadders`, `ladder:grab`; enemies cannot climb yet; androids take it when their path does), an interior stair to floor 2, windows, and the **map scanner on the
roof** (hold → `fog.reveal(STRUCTURE_SCAN_RADIUS)` + `ScanWave` for everyone; once per structure, host-confirmed). Wrecks
are open-topped, no scanner.

- Ground floor is one `floorPlate` covering footprint + `FLOOR_OVERHANG`; its collider top is exactly floor height and
  its underside is the basement ceiling (two layers of different width create a trench at the door).
- Locked doors take consumable keys; one locked door per building at most:

| Door | Key kind (`structures.csv` `key`) | Where |
|---|---|---|
| Outpost basement (stair corridor → standing sliding door) | `key_basement` | pit under the building |
| Lab 2nd-floor locked room | `keycard_lab` | corner room on 2-floor labs only (`basementChance` 0) |

  **The csv cell is the kind, not the id (2026-09-21, user's decision).** `StructureDef.unlockDefId` is
  `<kind>_<this raid's planet>` (`key_basement_amber` …, `data/items.csv` has the ten), so a door opens only with
  **this planet's** key — any building on that planet, no building on another. The prompt and the deny toast name
  the planet the door wants (`DOOR_TEXT`, `planetLabel`), because the whole point is to send the player there.
  The opener's key is consumed after host confirm (`struct unlocked.by`).
  Without the right key the hold time is 0 and the press gives `keycard_deny` + a toast. Keys are never guaranteed:
  ground containers roll `keyChance` as a separate bonus roll whose **kind** comes from the building and whose
  **planet is drawn uniformly per container** (a fork of the `structureLocks` stream, baked into the `ContainerSpec`
  so preview ≡ open). Locked-room containers use the `structureLocks` fork and carry
  `lockedRoom: true`, which exempts their contents from the epic+ gate (`planet_loot.csv` `epicPlusMul`; user decision 2026-09-16).
  Basement containers can carry a second per-kind bonus (`structures.csv` `basementBonus` / `basementBonusChance` /
  `basementBonusPlanets`, e.g. the outpost's `gad_thumper` 5 % on `amber`): `Structures.ts` sets `bonusDefId` / `bonusChance`
  on the basement spec only when `missionPlanet` is listed, and `ContainerSet` rolls it with its own seeded rng (preview ≡ open).
- Drone vents: a `VENT_W` × `VENT_H` gap beside each locked door; people are stopped by the lintel box (head clearance),
  not by width. Rays pass.
- **Ceiling turret (2026-09-21, user's decision 「무적 방어장치」)** — `structures/parts/Turret.ts`, one per locked
  space (basement · lab locked room), built only where the building really has a locked door. It is
  **indestructible**: no hp, no collider, not an enemy, so nothing can target it. Its loop is acquire a player or
  android inside the room's world OBB within `CEIL_TURRET_RANGE_M` with a clear line → turn at
  `CEIL_TURRET_TURN_RATE` while an alarm and an aiming laser run for `CEIL_TURRET_WARMUP_S` → `CEIL_TURRET_DAMAGE`
  every `CEIL_TURRET_INTERVAL_S`. **The only off switch is opening that room's door with the matching planet's
  key**, and it is permanent. See Rules for the authority split and the budgets it keeps.
- Windows: `GlassSet`; broken by bullets (`destructible`), grenades / thrown gadgets (`shared/fragile.breakFragileAlong`);
  broken panes keep colliders with `passRays` + `passSmall` (people cannot climb through). Unbroken glass blocks sight.
  **Blast / melee occlusion ignores `passRays` for glass** (2026-09-18) — `WorldSystem.raycastBlast`, see Rules.
  Break sync: `struct glass`.
- Containers (`ContainerSet`) emit `crate:open` and let `inventory/` do the loot. The *open look* (`opened`, synced to
  all) is separate from this client's first open (`rolled` → bonus key fill, `structure:investigated`).
- `structure:investigated` marks a zone as used for rogue/raider drops in `roguedZones` whether or not the drop fired, so
  a new host never re-rolls it (`struct sync.rogued`).
- Reach: doorway approaches are cleared first; see `structures/README.md` and `scripts/smoke-structure-reach.mjs`.

## Rails and trams

At most one rail line per map (`RAIL_CHANCE`, `loop` or `line`) and one tram per line. The rail does not flatten terrain:
the centreline is smoothed terrain + `RAIL_DECK_Y`, lifted over local maxima and grade-limited (`RAIL_MAX_GRADE`), on
piers. `RAIL_DECK_Y` must stay within `PROP_STEP_UP_MAX` so people can step onto the track.

- **Axis convention: tram local +X = travel direction (length), local +Z = sideways (width).** — `rails/model.ts`
- **The tram never turns around (2026-09-18 user decision).** `placeTram` takes the body yaw from the track tangent
  **only** — `TramDef.dir` no longer adds 180°. It drives forwards one way and backwards the other and always stops
  facing the same way. The old flip mirrored every rider across the car the moment it departed, because riding re-solves
  vehicle-local coordinates every frame (`shared/ride.ts`). `dir` still flips: it drives `s`, `vel`, the hit knockback
  direction (`knockDir` multiplies by it) and `TramWire`.
- **Two driver consoles, one at each end** (`TRAM_CONSOLE_IDS`, `TramInst.consolePos[0|1]`) — with a fixed orientation
  one cab would be the tail for half of every round trip. Both call the same `requestStart` → `applyStart`: no new wire,
  no new authority path, no "which console" state. The body is drawn double-ended to match (bulkhead + glass + desk at
  both ends; the old rear railing is gone).
- **The tram has no cabin containers** (2026-09-18 user decision) — the tram is transport, the platform deck is the
  farming spot. `data/structures.csv` `tram.containers` is kept but unread (`rail_platform` still reads the column);
  `Rails`' `ContainerSet` now holds platform containers only, so `setOpenListener` / `markContainerOpened` /
  `containerPositionOf` / `collectContainers` / `previewContainerItems` all keep working unchanged.
- The tram's truth is its arc position `s` + `dir` + state (`TRAM_STATES`: `idle` ↔ `moving` ↔ `docked`). After docking
  (`TRAM_DOCK_S`) it settles to `idle`; **no automatic restart** — only the cab console (`TRAM_START_HOLD_S`) or a platform
  call console starts it.
- Call console (`rail:<platformId>:call`): `ready` → hold `TRAM_CALL_HOLD_S`, tram is `here` (within `DOCK_WINDOW`) or
  `busy` (`moving`) → hold 0 + deny sound + reason toast. Duplicate calls are refused, not queued. A call reuses
  `applyStart`; the host reads the destination from the **requester's position** (`Rails.targetSFor`) because
  `TramRequest` has no destination field.
- **`RAIL_DECK_STEP / 2 × RAIL_MAX_GRADE < TRAM_FLOOR_UP` must hold**, or a rail deck box can tie with the tram floor.
- `updateTramHit`: above `TRAM_HIT_SPEED_MIN`, damage + knockback scale with speed. Local player per client; enemies and
  disconnected squadmates on the authority. Bodies below `floor − TRAM_HIT_FLOOR_CLEAR` are hit unless `riderExempt`
  (inside the car section and standing on this tram or nothing). Player damage source `explosion`.
- You cannot walk under a tram (floor collider vs. `BOX_HEADROOM`).

## Rover

One per raid when `layout.rover` exists (`ROVER_CHANCE`); rules source is the rover section of `src/shared/types.ts`.
Road: closed polar loop around the map centre with 4–5 stations at spread angles, never crossing the rail; station pads
are flattened; road mesh sits on terrain while the vehicle follows the smoothed route. Stations are discovered through
`Fog.setRoverStations` even if the vehicle is destroyed.

- States (`ROVER_STATES`, host-authoritative): `stopped` (`ROVER_DWELL_S`, paused while riders are aboard) → `patrol` to the
  next station; a rider's paid trip → `departing` (`ROVER_DEPART_GRACE_S`) → `trip` (shorter way round, skips stops) → all
  riders ejected at arrival (`parts/Exits`); HP 0 → `destroyed` (wreck collider stays, no refund).
- Damage comes in by **three separate doors**, and which door it used is the whole point: enemies call `RoverRef.damage`
  (host), hazards are ticked by world itself (`HAZARD_DPS × damageMul × ROVER_HAZARD_DAMAGE_MUL`, even empty), and the
  **player side** arrives as `Obstacle.destructible.onDamage(amount, point)` on the hull collider — the path
  `weapons/parts/Firing` · `weapons/Projectile` already take for destructible cover. Only the third one counts toward
  hostility. Riders are immune (enforced by `player/`).
- Hit zones (2026-09-21, `parts/Parts.ts`): 4 wheel zones · front turret · rear turret · hull. Still **one** box
  collider — the zones are a damage-resolution layer resolved from the impact point, because the box is what walking,
  `shared/ride.ts` and the enemy hit test all stand on. A part takes its own hp **and** passes
  `ROVER_PART_HULL_MUL` (1 = all) of the same damage to the hull, so shooting only the parts still kills the car.
  One wheel zone gone = `ROVER_WHEEL_SPEED_MUL_1`; two = it cannot move (still a rideable platform, and then it counts
  as standing for boarding and getting off, or a stranded car would lock its riders in). A dead turret stops firing.
- Hostility (2026-09-21): player-side damage past `ROVER_AGGRO_DAMAGE` turns the vehicle hostile **for the rest of the
  raid** — no timeout. It keeps running its route (no chase, never leaves the road), refuses boarding
  (`적대 상태 — 탑승 거부`) and adds people to the turrets' target list. One flag on the wire, not a list of attackers:
  hostility covers the attacker and their squad, and a raid's squad is the lobby.
- Two turrets, both authority-only and both firing only while moving. Front = a common-grade **SMG**
  (`ROVER_TURRET_FRONT_*`), rear = a common-grade **assault rifle** (`ROVER_TURRET_REAR_*`); the falloff is the gun's
  own, read from `weapons.csv` through `LootRef.getEffectiveStats('smg' | 'ar')` (the multiplier itself is
  `@/items damageFalloffStats` — one formula, the same import `allies/parts/Combat` makes). Enemies take
  `ROVER_DAMAGE_SOURCE` (no kill credit); a person (player · squadmate · android) takes `explosion`, the tram's
  convention for a vehicle, and only with probability `ROVER_TURRET_PC_ACCURACY` — a miss is **still fired**, wide, so
  the tracer visibly goes past. Ramming: enemies take damage + knockback, players only knockback, riders excluded.
- Destroyed, it drops `ROVER_WRECK_CRATE_MIN`…`MAX` cube supply crates (container style 3) around the wreck, at least
  `ROVER_WRECK_CRATE_GAP_M` apart on clear ground. They roll the **outpost-basement tier for the planet's threat**
  (`ROVER_WRECK_TIER_T1/2/3`) and are **exempt from the epic+ gate** like the lab's locked room — user's decision
  「a rover raid pays what entering the basement pays」. Every client lays them (seed-deterministic, and destruction is
  already on the wire), and they are an ordinary `ContainerSet`, so `crate:open` · the preview · `crate opened` all work
  unchanged. The first one opened raises one `structure:investigated` with kind `wreck`.
- Fare: `roverFareFor`; only the payer sends `credits:tx` with reason `rover:<from>:<to>`; the host recomputes the fare.
  Stations swallowed by a hazard refuse boarding / destination.

## Hazards

One hazard per raid from `PlanetDef.hazards`, drawn before the layout; start time `HAZARD_START_MIN_S`…`MAX_S` in 30 s
steps (spores fixed at `SPORE_START_S`, intel may delay). Covers the whole map by `HAZARD_FULL_S`. Visible on the map
over fog (orbital observation).

| Kind | Zone | Progress |
|---|---|---|
| `sandstorm` / `blizzard` (snow biomes) | one `front`; the side already passed is dangerous | linear sweep across the map + `FRONT_MARGIN`, entering from the spawn edge (± `HAZARD_FRONT_SPAWN_JITTER_RAD`) |
| `storm_eye` | one `circle`, `safeInside` | radius from farthest map corner (whole map safe at start) to `STORM_EYE_RADIUS_END` |
| `spores` | several `circle`s at groves | sources bloom every `SPORE_SOURCE_INTERVAL_S`; `sourceRadius` / `growthMps` computed so the map is fully covered |

- **No wire in normal play**: everything is a function of seed + `ctx.missionTime`; late joiners `hzq sync`.
- Player damage every `HAZARD_TICK_S`, ramping `HAZARD_DPS` → `HAZARD_DPS_MAX` (`damageMul` published for enemies); not
  while dead, in ship or dropping. Source `{kind:'hazard'}`. **Spores bypass the shield** (`HAZARD_SPORES_BYPASS_SHIELD`,
  `hazardDamageOpts`). Authority also ticks disconnected squadmates (`ghost:damage`) and the rover.
- **Visibility changes only through `atmo:override`** (world never touches `scene.fog`); always reset on exit / dispose.
  Fogless planets narrow sight by particles only.
- Groves stand on any planet whose candidates include `spores`, whatever the drawn kind; grove mushrooms are harvestable
  (`Gather`). `applySerialized` does not move groves (safety net for mismatched seeds only).
- `nearestSafePoint(x, z, margin, out)` (2026-09-15, androids carrying a downed PC out): exact for a single zone — the
  half-plane is pushed along `+dir`, a danger-inside circle outward, the storm eye inward — then an expanding ring scan
  (`SAFE_RING_STEP_M`) for overlapping spore blooms. Already-safe answers itself; `null` when the map is fully covered
  or the eye is smaller than `margin`. `out.y` is the terrain height.

## Fog of war

`FogRef` (`ctx.world.fog`, null outside raids): one `FOG_CELL_M` byte grid; cells once lit stay lit. Every
`FOG_UPDATE_HZ` it paints `FOG_REVEAL_RADIUS` around the local player and every live in-mission squadmate (from the
existing snapshots — no wire). `fog:revealed` fires only when the mask grew. The discovery gate emits
`fog:discovered {kind, id, position}` once for extraction consoles, nests, crates, gather nodes, structures, rail
platforms, groves, ruins (`outpost`) and rover stations; only extraction / nest / ruin raise a toast here (structure and
rail toasts belong to `ui/hud/RaidAlerts`). Undiscovered objects must not appear on the map, markers or compass. Spawn
area is pre-revealed.

## Training arena

`game:newMission {mode:'training'}` builds `TrainingArena` into the same root / hash instead of a planet; atmosphere in
space mode. Flat deck of `TRAINING_ARENA_SIZE`, **no walls or ceiling**: `clampInside` is a hard X/Z clamp at any height
(invisible walls), `raycastShell` hits only the floor plane out to `FLOOR_REACH` (so rocket jumps are unbounded and the
grapple has no wall anchors). Pop-up targets are hash obstacles with a `DestructibleRef` (weapons hit them via the normal
raycast path; enemies-only weapons will not find them). Consoles: exit (`training:exitRequested`), mode (`static` /
`moving` / `timed`, `training:modeChanged`, `training:scored`, `training:courseFinished`; best time in
`slotKey(TRAINING_BEST_STORAGE_KEY)`), weapon rack (`ctx.inventory.openCatalog`). Client-local, no wire, no lights.
Every planet query (crates, nests, gather, spawns, extraction) returns empty.

## Tutorial planet (`tutorial/`)

`game:newMission {mode:'tutorial'}` builds `TutorialWorld` with the same wiring as the arena: no fog, hazards, crates,
gather, nests, rails or rover. Decisions and step table and objectives: `src/tutorial/README.md`.

- **Forward is −Z**; z decreases in play order. Shapes are geometry, not balance, so they stay in `tutorial/model.ts`
  (only `TUTORIAL_ENEMY_SENSE_M` / `TUTORIAL_ENEMY_LEASH_M` come from csv).
- Terrain is the constant `VOID_Y`; all walkable ground is box decks (a heightfield cannot make vertical cliffs — steep
  slopes slide instead of falling).
- Route: ruins (`wake`) → run-up (`cliff`) → **chasm 1** (diagonal `CHASM_TILT`, gap `CHASM_GAP_Z` — clearable only when
  sprinting; floor at `CHASM_FLOOR_Y`, rule `kill`) → corpse ① (`corpse`) → narrow bug corridor `CORRIDOR_BUG_HALF_X`
  (`bugs`) → crawl tunnel with sloped slab (`crawl`) → androids (`android`) → **cliff 2** at `CLIFF2_EDGE_Z` (10 m drop,
  rule `clamp` keeps HP ≥ 1; `drop`) → corpse ② (`supply`) → `wall` → diagonal barrier with blind fence → two androids in
  the pit → abandoned ship on its hill (`ship`) → **abyss** at `ABYSS_EDGE_Z` (rule `kill`).
- Corridor width: `CORRIDOR_PROFILE` + `corridorHalfXAt(z)`; transitions are funnels (one rotated OBB), never steps. Decks,
  checkpoint / fall volumes and `isInside` / `clampInside` always use the widest half-width, and wall outer faces sit at
  `CORRIDOR_OUTER_X`, so narrowing never opens a hole. Anything placed near the corridor derives x from `corridorHalfXAt`.
- Chasm 1 edges are two rotated OBBs, **not stepped tiles** (steps would create a narrower walkable gap at inner corners).
- Crawl slab: every collider segment's underside (`crawlClearanceAt`) must stay between `PLAYER_CROUCH_CLEARANCE_M` and
  `BOX_HEADROOM`, or the tunnel stops meaning "crouch".
- Barrier fence: drawn at `BARRIER.fenceHeight`, solid collider to that height plus a `passRays` + `passSmall` ghost band
  up to `blockHeight` (bullets, sight and grenades pass; people cannot jump over).
- Pit (`PIT`, 9.5 × 8.5 m): depth `PIT_DEPTH` = exactly `PROP_STEP_UP_MAX`, so people and enemies step over its ledges
  but grenades (small bodies) cannot roll out; ramp on the ship side (−X) is the only way in from the path (an island). Walled
  2.5 m (`PIT_WALLS`) on the east (cliff edge) and south (the grenade backstop, abyss behind); the north side (toward the fence)
  is a deck-level rim `pit_rim_n` (`PIT_NORTH_RIM_H` = 0) with abyss behind — a wall there would hide the androids through the
  fence and stop the over-the-fence grenade. The android spots sit ≤ 7.2 m from every corner (`GRENADE_RADIUS`), which caps the
  pit size (`PIT` comment). The last two androids face the ship (`yawToShip` uses the enemy convention: facing
  `(sin yaw, cos yaw)`), carry `sg` / `dmr` (`EnemySpot.weapon`) and sense 22 m (`FINAL_ANDROID_SENSE_M`).
- Beyond the fence only the path (`lower_pit_w`), the ship hill and the pit island have ground; the rest is abyss (`ABYSS_CUTS`,
  rule `kill`). The approach floor ends behind the fence's far face in 1 m columns (`fenceColumns`: ledge ≥ `FENCE_LEDGE_MIN_M`
  at every x, so no hole opens on the player's side; clamped to `ABYSS_CUT_Z0`). The lower deck is many `DECKS` pieces and
  the holes are the gaps — lower pieces ∪ `SHIP_SLOPE` ∪ `PIT` ∪ `PIT_WALLS` ∪ `ABYSS_CUTS` must tile the old lower rect exactly
  once; `lowerTilingErrors()` samples it at build and `TutorialWorld` warns. Lower pieces, pit walls and the side walls past
  `ABYSS_CUT_Z0` draw a cliff face (rock from `ABYSS_FADE_TOP_Y`, dark fade below — `Ground.pushCliff`); lower-piece colliders
  are grown by `TILE_OVERLAP` at their seams (`growRect`); deck top planes use world-aligned UVs so column seams do not show.
  `pollSafeGround` keeps `ABYSS_SAFE_MARGIN_M` from every cut edge (`inAbyssCut`).
- Ship hill: the ship stands `SHIP_HILL_RISE` (= `PLAYER_HEIGHT / 2`) above the lower deck (`SHIP_HILL_Y`, also `SHIP_POS.y`,
  the `ship` respawn and a `SAFE_LEVELS` entry). It is reached by `SHIP_SLOPE` (z −149 … −153.5, `Obstacle.ramp` overlapping the
  hill plate by `PIT_RAMP_OVERLAP`; drawn as a vertical-sided wedge so nothing pokes into the pit); the rear ramp opens flat on the
  hill top 1 m past the slope. The hill must equal the ship deck height (flat ramp, `Hull` ground = `getGroundY()`).
- Side walls lower from `WALL_DESCENT_FROM_Z` (the fence's far end) in `WALL_DESCENT_STEP_M` pieces: left fast
  (`WALL_DESCENT_RATE_L`, never below `SHIP_HILL_Y + WALL_MIN_ABOVE_WALK_M` so it cannot be climbed), right gently
  (`WALL_DESCENT_RATE_R`); past the edge `buildAbyss` continues from those heights (`ABYSS_WALL_DROP_L` / `_R`).
- Checkpoints (`CHECKPOINTS`, order verified against `TUTORIAL_CHECKPOINTS` at build) never go back; each is outside the
  sense radius of its section's enemies — recompute the distance table in `model.ts` if coordinates move.
- Respawn after a fall uses **the last safe ground** (`pollSafeGround` → `respawnPose`): outside `kill` volumes, near a walkable
  level (`SAFE_LEVELS`), outside the asymmetric chasm-1 band (`CHASM_RUNUP_M` on the approach side, so the player keeps a
  run-up) and not within `ABYSS_SAFE_MARGIN_M` of the abyss. `clamp` areas are safe. Without a record, the checkpoint answers.
- The ship is the real extraction ship: `ctx.extraction.beginPreLanded(SHIP_POS, SHIP_YAW, {autoDepart:false})` is called
  on the **first `update()`**, not in `generate()`, because extraction resets on the same `game:newMission` emit after world
  (retries up to `SHIP_PLACE_TIMEOUT_S`).
- Corpses use fixed lists (`corpse:tut_gear`, `corpse:tut_supply`, `corpse:tut_relic`) through `openContainerItems`, not loot rolls.
  An emptied one (`crate:looted`) sinks like a raid corpse (`CORPSE_EMPTY_REMOVE_DELAY_S` · `_SINK_S` · `_SINK_DEPTH_M`, mission
  clock) and is then unregistered and disposed.
- **Intended tutorial limits**: the `ship` checkpoint sits inside the last two androids' sense radius (22 m) — the only
  exception to 「a checkpoint is outside the sense radius」, because no spot next to the ship is outside it
  (2026-09-15 user decision; the distance table is in the `CHECKPOINTS` comment). The pit is ×1.55, not ×2 — 「one grenade
  anywhere in the pit kills both」 (`GRENADE_RADIUS` 7.2) and 「about twice the area」 cannot both hold; growing it means
  re-deciding the grenade radius, the android hp or 「both」 (`PIT` comment). Between the fence and the pit is a cliff, so a
  short grenade throw falls off it (two are handed out); the pit's fence side is a deck-height rim (`PIT_NORTH_RIM_H`), not
  a wall, because the androids must be visible and the grenade must fly over. The four front enemies' `yaw: Math.PI` faces
  −Z, not the +Z the comment claims (kept — they turn around when they notice).
- `TutorialEnemySpawn.weapon` is **not in the shared contract yet** (2026-09-15): the last androids' shotgun / marksman rifle
  travel in the local extension type `TutorialSpawnSpec` (`tutorial/model.ts`) and `enemies/Tutorial.spawnWeapon` reads it as
  an optional field. Adding `weapon?: string` to `shared/tutorialWorld.ts` removes both structural reads.

## Decisions

Choices made against an alternative that may be proposed again — the choice, then what was rejected and why. Overturned → edit
the line; a choice with nothing left to reject → delete it. Everything else about a change lives in `git log`.

- **Fog of war gates the map and world markers only.** Rejected: world-render fog (cost, relighting).
- **Structures = an enterable ground building + one basement.** Rejected: open ruins, multi-storey.
- **Trams: console start → auto drive.** Rejected: manual driving (controls, HUD and sync cost). **The tram never turns around**
  (flipping mirrored riders).
- **Hazards end by covering the whole map.** Rejected: a safe zone.
- **Planet 표본 채집지 retired** (columns and code kept). Rejected: leaving mineral-only nodes.
- **Mineral veins are gather nodes.** Rejected: a destructible with HP, a tool-gated interaction.
- **Tutorial pit ×1.55, not 2×**, so one grenade still kills both androids (`GRENADE_RADIUS` vs the half-diagonal).
- **Rover: damage by hit zone, part damage also off the hull; hostile past a cumulative threshold, for the rest of the raid; it keeps
  its route and does not chase; its wreck pays an outpost basement** (2026-09-21). Rejected: parts on their own pool; parts instead of
  hull hp; hostility on the first bullet; a timeout. A non-host sums hits **per zone per frame**. Rejected: one summed message a frame;
  a fixed 0.1 s window.
- **Ceiling turret: indestructible, off only with the matching key; the host sends its target** (`struct turret`). Rejected: a
  destructible or respawning turret; sending only the state change. The shot cadence is deliberately not sent.
- **Distant props stop casting; crates and debris never cast; pebbles lowered** (perf, `docs/PERF.md`). Rejected: lowering boulder
  geometry (cover silhouette, hull colliders); shrinking the shadow map; spatial buckets.

## Recent changes

Last 5 only — older: `git log -- src/world`.
- 2026-09-21 — The raid's walkable graph (TODO A-18 phase 1): `nav/` (`NavGraph` + parts) is started at the end of a planet raid's generation, bakes an outdoor 1 m grid and a 0.5 m multi-floor grid per structure / rail platform over the next frames, links ladders and region seams, answers `WorldRef.nav.findPath` · `walkable`, and re-measures the cells under any collider the hash reports changed (`SpatialHash.onChange` — a door opening, a barricade, the tram, the rover). `Structures.navOf` now also feeds the region rectangles.
- 2026-09-21 — The ceiling turret's target goes on the wire, and explosives reach the rover (B-100 · B-98 · B-99, 사용자 결정): `struct turret {id, tg, st}` carries the **authority's** chosen body, so `CeilingTurretSet` splits into `hostUpdate` · `replicaUpdate` (`applyWire` · `activeWire` for a late joiner) and a replica no longer warns the wrong person; `rover/parts/Parts.roverBlastPoint` pulls a blast centre onto the hull box so 「a grenade takes a wheel」 resolves like a bullet does; and a non-host client sums a frame's player-side damage **per hit zone** before sending `roverq hit` (one message a frame per zone, not one per bullet).
- 2026-09-21 — The rover gets hit zones · two guns · hostility · wreck crates (사용자 결정): 4 wheel zones + a front SMG and a rear AR turret resolved from the impact point (`rover/parts/Parts.ts`, hull collider `destructible`), part damage also coming off the hull; `ROVER_AGGRO_DAMAGE` of player-side damage turns the car hostile for the raid (refuses boarding, shoots people at `ROVER_TURRET_PC_ACCURACY`, keeps its route); destruction drops basement-tier cube crates (`rover/parts/Wreck.ts`). `ContainerSet` gained style 3 and a map-wide by-id index so a set built mid-raid is reachable.
- 2026-09-21 — Planet-bound keys · the ceiling turret (사용자 결정): `structures.csv` `key` is now the **kind** and `StructureDef.unlockDefId` is `<kind>_<raid planet>`, the prompt · deny toast name that planet, a container's bonus key draws its planet uniformly, and an **indestructible** `CeilingTurretSet` (`structures/parts/Turret.ts`) guards the basement and the lab's locked room until that door is opened.
- 2026-09-21 — The rover turret hands its target to the shot (B-73): `updateTurretLogic`'s `fire` callback takes `targetId` and both `rover:fired` emits carry it (`null` on a replica, which only receives the impact point). `smoke-rover`'s turret check stands on the event instead of reaching into the turret's `private` state.
