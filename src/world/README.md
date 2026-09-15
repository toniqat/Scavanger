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
| `WorldSystem.ts` | `GameSystem` + `WorldRef`. Generation order, `SpatialHash` owner, all queries, mode branches (`raid` / `training` / `tutorial`), open-state sync of crates and containers, `genTimings`. |
| `index.ts` | Barrel (only a few exports are used; outside code goes through `ctx.world`). |
| `layout.ts` | Macro layout from the seed: rail plan, spawn, rover road plan, extraction pads (`extractionPadCount`), nests, POIs, craters, basins, `StructureSite`s. `railDistance` / `railClearance` / `roverClearance`, `padClearance`, `nearestPad`, `LayoutOptions` (spore layout, intel). |
| `preview.ts` | `planLayoutFor` (biome + hazard kind + layout — used by `generate`) and `previewLayoutFor` (flat `MapPreviewLayout` for `WorldRef.previewLayout`). |
| `noise.ts` | Seeded `noise2` / `noise3`, `fbm`, `ridged`, `billow`, `lerp` / `clamp` / `smoothstep`. |
| `biomes.ts` | Five biome palettes; `biomeById(PlanetDef.biome)`; `pickBiome(seed)` fallback mirrors core's sky-palette draw. |
| `Terrain.ts` | Heightfield (`EXTENT`, `CELL`, 8×8 chunk meshes, vertex colours, procedural detail textures); flattens pads, digs basement pits; `getHeightAt`, `getNormalAt`, `getSlopeAt`, ray-march. |
| `SpatialHash.ts` | 16 m XZ grid of `ObstacleEntry`: `add` (cylinder + optional shot cylinder), `addBox`, `addHull`, `addRamp`, `move`, `remove`, `query`, `overlaps`, `walkSegment`; internal flags `passRays` / `passSmall`. |
| `obb.ts` | Box collider math: `boxContainsXZ`, `boxPushOut`, `rayBox`, `boxHitNormal`, `rampTopAt`, `rayRamp`, `BOX_HEADROOM`. |
| `hull.ts` | Convex prism math: `convexHull2D` (≤ `HULL_MAX_VERTS`), `hullContainsXZ`, `hullPushOut`, `rayHull`, `hullHitNormal`, `hullAreaCentroid`. |
| `propHull.ts` | `propHullOf` — measures a prop instance's movement hull + shot bands from the drawn mesh above ground. |
| `build.ts` | `BuildCtx` for sub-builders; `isSpotFree` (pads, hash, rail + rover clearance), paint / displace / merge helpers, `PLAY_LIMIT`. |
| `Props.ts` | Scattered instanced props (boulders, spires, trees, crystals, grass, pebbles, debris); hull colliders for rock / crystal / debris, trunk cylinder for trees. |
| `Nests.ts` | Bug nest mounds (obstacles) and hole positions (`getNestPositions`). |
| `BurrowGround.ts` | `burrowGroundOk` — the one judgement "can a sandworm erupt here": flat terrain samples, no pad / rail / rover corridor, no structure footprint, no hash collider, nest / gather / crate / spore-grove clearance, not inside the active hazard. Shared by the enemies director and the thumper placement preview. |
| `Pads.ts` | Extraction platforms (`PLATFORM_HEIGHT` / `PLATFORM_RADIUS`, one point light each) and the spawn marker. |
| `Outposts.ts` | POI ruins (walls, pillars, mast); `getSites()` → ruin sites for fog discovery, footstep material, `getRuinSites`. |
| `Crates.ts` | Loot crates around landmarks only (POIs, structure rings, nest rings — none in open field, no tier 4); `Interactable`, lid tween, `crate:open`; open state via `setOpenListener` / `markOpened`. |
| `Gather.ts` | Harvest nodes: herbs, salvage piles (bonus core / mineral), soil, wild seeds, specimens, grove mushrooms. Host-authoritative `harv` / `harvq`. `resolveNodeWeights` drops retired defs. Debug `debugBonusOf` / `debugBonusesOf`. |
| `soil.ts`, `flora.ts`, `specimen.ts` | Per-planet soil / seed / specimen tables from `data/planets.csv` (`planetSoil`, `planetSeeds`, `planetSamples`). |
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
| `Structures.ts` | Abandoned structures: build, doors / keys, roof scanner, ladders, windows, containers, light pool, `struct` / `structq`, rogue-drop zone record, `previewContainerItems`, `debugNav`. |
| `structures/` | Vocabulary + parts for buildings — see [`structures/README.md`](structures/README.md). |
| `Rails.ts` | Rail centreline, tram state machine, cab + platform call consoles, `tram` / `tramq`. No geometry. |
| `rails/model.ts` | `RailPath` math, rail / tram dimensions and colours, `RailBuild`, `TramInst`. Axis convention lives here. |
| `rails/parts/Track.ts` | Ties, rails, piers, walkable deck boxes every `RAIL_DECK_STEP`. |
| `rails/parts/Platform.ts` | Platform deck, stairs (`buildStairFlight`), railings, containers, call console (returns its spot). |
| `rails/parts/Tram.ts` | Tram body (length along travel), walk-in cab, console desk, colliders sharing one `velocity`, `placeTram`, `updateTramHit`. |
| `rover/model.ts` | `RoverPlan`, closed-loop path math, `shortestTrip`, `roverFareFor` (the only fare formula). |
| `rover/RoadPlan.ts` | `planRoverRoute` (polar loop, 4–5 stations, avoids rail corridor), `roverRouteDistance`, `minTurnRadius`. No THREE. |
| `rover/RoverRoad.ts` | Resamples the plan into `RoverRouteDef`, builds road + station poles and their colliders. |
| `rover/RoadMesh.ts`, `rover/StationMesh.ts` | Road ribbon on terrain; station poles / beacons / signs (no lights). |
| `rover/Rover.ts` | Vehicle lifecycle, state machine, boarding, fares, hazard damage, `RoverRef`, `rover` / `roverq`, `cheat:rover`. |
| `rover/parts/Body.ts`, `Turret.ts`, `Impact.ts`, `Exits.ts`, `Fx.ts` | Hull model + one box collider (no `velocity`); turret targeting / fire; ram impacts; exit spots; tracers / wreck FX. |
| `TrainingArena.ts` | Simulation training range (`TrainingRef`): deck, invisible walls, pop-up targets, target modes, consoles. |
| `tutorial/model.ts` | Tutorial planet shape: levels, corridor profile, deck pieces, chasm, checkpoints, fall rules, enemy spots (per-spot `sense` / `weapon`), corpse spots, ship pose, crawl slab, barrier, pit + walls, abyss cuts beyond the fence. |
| `tutorial/TutorialWorld.ts` | `TutorialWorldRef` + tutorial queries (`heightAt`, `raycastGround`, `isInside`, `clampInside`, `surfaceMaterial`), checkpoint tracking, safe-ground respawn, ship placement. |
| `tutorial/parts/Ground.ts` | Deck pieces with cliff faces, chasm edges, corridor walls and funnels, abyss, pit + ramp + walls. |
| `tutorial/parts/Dressing.ts` | Start ruins (incl. the fallen mast with its collider), crawl tunnel, diagonal barrier + blind fence, rubble (fixed `DRESSING_SEED`). |
| `tutorial/parts/Corpses.ts` | Three hand-placed corpses with fixed item lists via `ctx.inventory.openContainerItems`. |

## Public API

`WorldRef` is declared in `src/shared/types.ts` (several merged blocks); `TutorialWorldRef` in `src/shared/tutorialWorld.ts`.

- **Geometry queries**: `getHeightAt`, `getNormalAt`, `getSurfaceY(x, z, feetY?)`, `getStandingObstacle`, `resolveCollision(position, radius, height?)`,
  `raycast`, `isInsideBounds`, `obstacleCoverage`, `scatterPoints`, `getObstaclesNear`, `addObstacle` (dynamic cover; returns remover),
  `getSurfaceMaterial(x, z, feetY?)`, `size`, `mode`, `planet`, `seed`, `getBiome()`.
- **Objects**: `getPlayerSpawn`, `getExtractionPoints`, `getEnemySpawnPoints`, `getCrates`, `getNestPositions`, `getGatherNodes`,
  `getStructures`, `structureAt`, `getLadders`, `getRailLines`, `getTrams`, `getRuinSites`, `getSiteSpawnPoints`, `previewContainerItems`,
  `getLootContainers()` (2026-09-15: crates + structure / platform / tram containers as `LootContainerInfo` — id, live
  position, tier, opened, kind; **reused array and reused entries**), `markContainerOpened(id)` (2026-09-15: open the
  lid / door for an android take and tell the squad with `crate opened`; no event, no stats, no 감정 XP),
  `burrowGroundOk(x, z, radius)` (2026-09-15, optional on `WorldRef`: true only on flat bare ground with nothing in the
  circle — rules in `BurrowGround.ts`; training / tutorial worlds return false; thresholds `BURROW_GROUND_*` in csv).
- **Sub-refs**: `fog` (`FogRef`), `hazard` (`HazardRef`), `rover` (`RoverRef`), `env` (planet `env` column), `training` (`TrainingRef`),
  `tutorial` (`TutorialWorldRef`). Each is null when the mode / planet does not have it.
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
structures → rails → rover road + vehicle → hazard (groves) → props → crates → gather → ambience → fog. `world:ready` is
emitted at the end, inside the `game:newMission` emit.

- Layout order inside `generateLayout`: **rail first, then spawn, then the rover road**, then everything else avoids them
  (`railFree` / `roverFree`). Rail is a line through the origin or a loop around it — one degree of freedom — so it cannot
  be fitted between already-placed pads. Corridor half-width is `RAIL_CLEARANCE_M`; the rover corridor is `roverClearance`.
- Obstacles registered earlier are avoided by later placement (`isSpotFree` reads the hash): structures, rails, rover and
  groves are built before props / crates so no rock stands inside a room.
- Every subsystem draws from its own `rng.fork(label)`; `Random.fork` never advances the parent, so adding a fork does not
  shift other streams. Late-added features (salvage bonuses `gather_core` / `gather_mineral`, `gather_soil`, `gather_seed`,
  `gather_sample`, `hazardGroves`, `structureLocks`, `roverVehicle`) use their own forks for that reason.
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
| Flags | internal | `passRays` (rays ignore) + `passSmall` (bodies under `SMALL_BODY_R` pass): broken windows, tutorial fence ghost band. |
| `velocity` | tram colliders | Presence marks a moving platform (also when stopped). |

Box math is used only when `o.box` is set; cylinder code paths are separate.

## Rules

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
  loaded very early by `data:check`: no THREE value imports there.
- Point lights: structures use a `LightPool` of `STRUCTURE_POINT_LIGHTS` real lights moved between room spots, built even
  on maps without structures, so the raid light count is constant (`SCENE_POINT_LIGHT_BUDGET` has zero spare in raids).
  Everything else in world (beacons, consoles, arena, tutorial, rover, scan wave) is emissive only.
- A preview must roll exactly what opening rolls (`previewContainerItems` → `ContainerSet.preview` → same `contents()`).
- Rover and rail corridors must stay empty: any new placement code checks both `railClearance` and `roverClearance`
  (`isSpotFree` enforces them even with `ignorePads`).

## Structures

Kinds: outpost (`버려진 전진기지`), lab, wreck (`data/structures.csv`). Outposts and labs have walls of `wallH`, a ceiling
per floor, a random second floor (`upperChance`), a roof reached by a ladder on the top floor's partition
(`getLadders`, `ladder:grab`; enemies cannot climb), an interior stair to floor 2, windows, and the **map scanner on the
roof** (hold → `fog.reveal(STRUCTURE_SCAN_RADIUS)` + `ScanWave` for everyone; once per structure, host-confirmed). Wrecks
are open-topped, no scanner.

- Ground floor is one `floorPlate` covering footprint + `FLOOR_OVERHANG`; its collider top is exactly floor height and
  its underside is the basement ceiling (two layers of different width create a trench at the door).
- Locked doors take consumable master keys; one locked door per building at most:

| Door | Key (`structures.csv` `key`) | Where |
|---|---|---|
| Outpost basement (stair corridor → standing sliding door) | `key_basement` | pit under the building |
| Lab 2nd-floor locked room | `keycard_lab` | corner room on 2-floor labs only (`basementChance` 0) |

  Any key of the right kind opens any building's door; the opener's key is consumed after host confirm (`struct unlocked.by`).
  Without a key the hold time is 0 and the press gives `keycard_deny` + a toast (`DOOR_TEXT`). Keys are never guaranteed:
  ground containers roll `keyChance` as a separate bonus roll. Locked-room containers use the `structureLocks` fork.
  Basement containers can carry a second per-kind bonus (`structures.csv` `basementBonus` / `basementBonusChance` /
  `basementBonusPlanets`, e.g. the outpost's `gad_thumper` 5 % on `amber`): `Structures.ts` sets `bonusDefId` / `bonusChance`
  on the basement spec only when `missionPlanet` is listed, and `ContainerSet` rolls it with its own seeded rng (preview ≡ open).
- Drone vents: a `VENT_W` × `VENT_H` gap beside each locked door; people are stopped by the lintel box (head clearance),
  not by width. Rays pass.
- Windows: `GlassSet`; broken by bullets (`destructible`), grenades / thrown gadgets (`shared/fragile.breakFragileAlong`);
  broken panes keep colliders with `passRays` + `passSmall` (people cannot climb through). Unbroken glass blocks sight.
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
- Damage only from enemies (`RoverRef.damage`, host) and hazards (`HAZARD_DPS × damageMul × ROVER_HAZARD_DAMAGE_MUL`,
  even empty). Player weapons never call it. Riders are immune (enforced by `player/`).
- Turret fires only while moving, authority only, damage source `ROVER_DAMAGE_SOURCE` (no kill credit). Ramming: enemies
  take damage + knockback, players only knockback, riders excluded.
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
gather, nests, rails or rover. Decision: `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」. Step table and objectives: `src/tutorial/README.md`.

- **Forward is −Z**; z decreases in play order. Shapes are geometry, not balance, so they stay in `tutorial/model.ts`
  (only `TUTORIAL_ENEMY_SENSE_M` / `TUTORIAL_ENEMY_LEASH_M` come from csv).
- Terrain is the constant `VOID_Y`; all walkable ground is box decks (a heightfield cannot make vertical cliffs — steep
  slopes slide instead of falling).
- Route: ruins (`wake`) → run-up (`cliff`) → **chasm 1** (diagonal `CHASM_TILT`, gap `CHASM_GAP_Z` — clearable only when
  sprinting; floor at `CHASM_FLOOR_Y`, rule `kill`) → corpse ① (`corpse`) → narrow bug corridor `CORRIDOR_BUG_HALF_X`
  (`bugs`) → crawl tunnel with sloped slab (`crawl`) → androids (`android`) → **cliff 2** at `CLIFF2_EDGE_Z` (10 m drop,
  rule `clamp` keeps HP ≥ 1; `drop`) → corpse ② (`supply`) → `wall` → diagonal barrier with blind fence → two androids in
  the pit → abandoned ship (`ship`) → **abyss** at `ABYSS_EDGE_Z` (rule `kill`).
- Corridor width: `CORRIDOR_PROFILE` + `corridorHalfXAt(z)`; transitions are funnels (one rotated OBB), never steps. Decks,
  checkpoint / fall volumes and `isInside` / `clampInside` always use the widest half-width, and wall outer faces sit at
  `CORRIDOR_OUTER_X`, so narrowing never opens a hole. Anything placed near the corridor derives x from `corridorHalfXAt`.
- Chasm 1 edges are two rotated OBBs, **not stepped tiles** (steps would create a narrower walkable gap at inner corners).
- Crawl slab: every collider segment's underside (`crawlClearanceAt`) must stay between `PLAYER_CROUCH_CLEARANCE_M` and
  `BOX_HEADROOM`, or the tunnel stops meaning "crouch".
- Barrier fence: drawn at `BARRIER.fenceHeight`, solid collider to that height plus a `passRays` + `passSmall` ghost band
  up to `blockHeight` (bullets, sight and grenades pass; people cannot jump over).
- Pit (`PIT`, 9.5 × 8.5 m): depth `PIT_DEPTH` = exactly `PROP_STEP_UP_MAX`, so people and enemies walk out over the open edges
  but grenades (small bodies) cannot roll out; ramp on the ship side (−X). Walled 2.5 m (`PIT_WALLS`) on the east (cliff edge)
  and south (the grenade backstop, abyss behind); open toward the fence and the ramp. The android spots sit ≤ 7.2 m from every
  corner (`GRENADE_RADIUS`), which caps the pit size (`PIT` comment). The last two androids face the ship, carry `sg` / `dmr`
  (`EnemySpot.weapon`) and sense 22 m (`FINAL_ANDROID_SENSE_M`) so the ramp and bay are inside.
- Beyond the fence everything that is not the pit, its walls, the fence strip or the ship strip is abyss (`ABYSS_CUTS`, rule
  `kill`): the lower deck is seven `DECKS` pieces and the holes are the gaps between them — `DECKS` ∪ `PIT` ∪ `PIT_WALLS` ∪
  `ABYSS_CUTS` must tile the old lower rect exactly. Lower pieces, pit walls and the side walls past `ABYSS_CUT_Z0` draw a cliff
  face (rock from `ABYSS_FADE_TOP_Y`, dark fade below — `Ground.pushCliff`); lower-piece colliders are grown by `TILE_OVERLAP`
  at their seams (`growRect`). `pollSafeGround` keeps `ABYSS_SAFE_MARGIN_M` from every cut edge (`inAbyssCut`).
- Checkpoints (`CHECKPOINTS`, order verified against `TUTORIAL_CHECKPOINTS` at build) never go back; each is outside the
  sense radius of its section's enemies — recompute the distance table in `model.ts` if coordinates move.
- Respawn after a fall uses **the last safe ground** (`pollSafeGround` → `respawnPose`): outside `kill` volumes, near a walkable
  level (`SAFE_LEVELS`), outside the asymmetric chasm-1 band (`CHASM_RUNUP_M` on the approach side, so the player keeps a
  run-up) and not within `ABYSS_SAFE_MARGIN_M` of the abyss. `clamp` areas are safe. Without a record, the checkpoint answers.
- The ship is the real extraction ship: `ctx.extraction.beginPreLanded(SHIP_POS, SHIP_YAW, {autoDepart:false})` is called
  on the **first `update()`**, not in `generate()`, because extraction resets on the same `game:newMission` emit after world
  (retries up to `SHIP_PLACE_TIMEOUT_S`).
- Corpses use fixed lists (`corpse:tut_gear`, `corpse:tut_supply`, `corpse:tut_relic`) through `openContainerItems`, not loot rolls.

## Recent changes

Last 5 only — older: `git log -- src/world`.
- 2026-09-15 — Outpost basement bonus (`basementBonus*` columns): per-kind + per-planet extra roll on basement containers (the 진동 장치).
- 2026-09-15 — `WorldRef.burrowGroundOk` (`BurrowGround.ts`): flat bare-ground test for the sandworm director and the thumper preview.
- 2026-09-15 — Tutorial: pit ×1.55 with 2.5 m walls (backstop removed), abyss cuts beyond the fence (seven lower deck pieces,
  cliff faces everywhere), last androids face the ship with `sg` / `dmr` + 22 m sense, `ship` band moved to z −150…−158, mast collider.
- 2026-09-15 — Android hooks: `getLootContainers`, `markContainerOpened`, `HazardRef.nearestSafePoint`; a `crate opened`
  from the lobby host is trusted without the distance check (the host opens for an android).
- 2026-09-15 — Spore hazard damage bypasses the player shield (`hazardDamageOpts`, `HAZARD_SPORES_BYPASS_SHIELD`).
