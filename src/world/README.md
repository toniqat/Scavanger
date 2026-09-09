# src/world — Procedural planet surface

Owner system: `WorldSystem` (publishes `ctx.world`, implements `WorldRef`).
Generates the whole map **synchronously** on `game:newMission {seed, mode?}` and emits `world:ready {seed, playerSpawn}`
(`mode: 'training'` → the 시뮬레이션 훈련장 of `TrainingArena.ts` instead of the planet, see the Phase 7 section);
tears everything down on `game:abort` and emits `world:cleared`. No asset files — all geometry, vertex colors and
textures are procedural.

| File | Responsibility |
|---|---|
| `WorldSystem.ts` | `GameSystem` + `WorldRef` implementation. Orchestrates generation order (terrain → nests → pads → outposts → props → crates → **gather** → ambience), owns the `SpatialHash`, and answers queries: `getHeightAt` (heightfield + extraction platform top), `getNormalAt`, `resolveCollision` (circle push-out + soft wall at ±(MAP_SIZE/2−4)), `raycast` (heightfield ray-march + analytic ray/cylinder vs obstacles — **2026-09-08** it shoots at `Obstacle.shotRadius / shotHeight` when a prop declares them, and the slab clip is complete: the old code tested only the entry point of the infinite cylinder plus the top cap, so a ray entering the footprint below the base and crossing the body further along reported a miss), `getEnemySpawnPoints`, `getExtractionPoints`, `getCrates`, `getNestPositions`, `getPlayerSpawn`, `getGatherNodes` (appended). Extra: `getBiome()`. **Phase 11**: `generate(seed, mode, planet)` — the 목표 행성 (from `game:newMission.planet`, else `ctx.missionPlanet`) is stored on `WorldRef.planet`, picks the biome by id and is echoed in `world:ready.planet`; an unknown id is reported as null. |
| `noise.ts` | Seeded 2D simplex (`noise2`), 3D gradient noise (`noise3`), `fbm`, `ridged`, `billow`; `lerp/clamp/smoothstep` helpers. **2026-09-09 — `noise3` 의 `lerp` 인자 순서가 뒤집혀 있었다.** `lerp` 는 `(a, b, t)` 인데 `(t, a, b)` 로 넣어 세 겹의 보간이 `w + (a − w)·b` 로 쌓였고, 값이 `[-1, 1]` 이 아니라 **측정 `[-31.2, +52.6]`** 이었다. 쓰는 곳이 `build.displace` 하나뿐이라 지형(`noise2` 계열)은 멀쩡했지만 소품 정점 몇 개가 원점에서 10 units 씩 튕겨 나갔고, `Props.hullOf` 가 바운딩 박스로 콜라이더를 만들면서 그 정점 하나가 소품 전체를 감싸는 거대 원기둥이 됐다 (아래 `Props.ts`). 고친 뒤 범위 `[-0.91, +0.99]`. |
| `biomes.ts` | Five biome palettes (amber desert, frozen tundra, mossy swamp, ashen volcanic, crimson alien): terrain bands, prop colors, scatter density multipliers. `pickBiome(seed)` reproduces core's `new Random(seed).fork('atmosphere').pick(SKY_PALETTES)` draw so `BIOMES[i]` is always shown under `SKY_PALETTES[i]` (amber-dusk, cold-blue, toxic-green, rust-storm, pale-noon) and each palette is tuned to contrast with its fog color (`pairedSky`, `fogHint`). If core changes the palette count or fork label, the pairing silently degrades to "random but valid". **Phase 11**: `biomeById(id)` looks a palette up by `PlanetDef.biome`, so with a 목표 행성 the pairing is data instead of two matching draws; `pickBiome` stays the no-planet fallback. |
| `layout.ts` | Macro layout from the seed: spawn pad near an edge, 3 extraction pads (≥180 m apart, ≥150 m from spawn), 4–6 nest pads, 5–8 POI pads, craters, basins. `padClearance`, `nearestPad`. |
| `Terrain.ts` | Heightfield (417×417 verts, 2 m spacing, covers ±416 m incl. border mountains) from warped fBm + ridged noise + craters/basins + flattened pads + edge cliffs. 8×8 chunk meshes with vertex colors (biome bands by height/slope, AO, crater scorch, nest goo), procedural tiled detail albedo + normal `CanvasTexture`s. Fast bilinear `getHeightAt`, `getNormalAt`, `getSlopeAt`, adaptive ray-march `raycast`. |
| `SpatialHash.ts` | 16 m XZ grid of `ObstacleEntry` cylinders: `add/query/overlaps/walkSegment`. **2026-09-08**: `add(…, shot?)` also takes the **shot** cylinder (`Obstacle.shotRadius / shotHeight`) and bucketing / `maxRadius` use the larger of the two, so `walkSegment` never misses a prop whose shot cylinder reaches into a cell its collider does not. `query` still filters on `o.radius`, so movement collision is untouched. |
| `build.ts` | `BuildCtx` shared by sub-builders and geometry helpers: `isSpotFree`, `paint`, `paintGradient`, `displace`, `merge` (BufferGeometryUtils), `xform`, `composeMatrix`, soft particle texture. |
| `Props.ts` | Jittered-grid + noise-cluster scatter into `InstancedMesh` variants (named `prop_<kind>`): boulders (also on border slopes), rock spires, fungal/dead trees, emissive crystal clusters (pulse), wind-swaying grass tufts (shader injection), pebbles, debris (crates/pod shells/panels). Collidable kinds (boulder, spire, tree, crystal, crate/pod debris) register obstacles; grass, pebbles and panels do not. **2026-09-09 — the movement collider is the drawn silhouette too.** `hullOf` used to size only the *shot* cylinder; the mover's cylinder was still a guess (`s*0.82 / s*1.3` for a boulder, `s*0.8 / s*4.2` for a spire that draws up to `1.5·s·4.2`, a flat `5*s` for every tree, `0.8s / 2.5s` for a crystal), which is why a rock you could see the top of was an invisible wall half a metre above itself and could never be stood on. Now **boulder / spire / crystal / debris pass the measured hull to both cylinders** and the height carries the instance's own `sy`. Two deliberate exceptions: a **tree** keeps the trunk radius (`0.5*s`) for both — a fungal cap is 2 m wide 3.5 m up, so a hull-wide cylinder would be an invisible wall at ground level and would stop bullets in open air — and only its *height* is measured; a **debris crate** is randomly yawed, so its XZ radius is the corner sweep (`√2 × half-width`) rather than the mean half-width. ⚠ **A seed's prop layout is no longer byte-identical to before this change**: `isSpotFree` tests `SpatialHash.overlaps`, which filters on `o.radius`, and a rejected spot skips the rest of that scatter callback's rng draws — so wider rock colliders shift the stream for everything scattered after them (and for crates / outposts, whose `isSpotFree` reads the same hash). Multiplayer determinism is untouched (every client runs the same code from the same seed); what is gone is only "seed 21 looks exactly like it did yesterday". **2026-09-09 (같은 날, 뒤늦게) — 그 실측 실루엣이 거짓말이었다.** `hullOf` 는 정직하게 바운딩 박스를 쟀지만 지오메트리에 `noise3` 버그로 튕겨 나간 정점이 섞여 있어서, 시드 21 에서 **첨탑 콜라이더가 반지름 최대 18.2 m · 높이 22.2 m** 로 부풀었다 (그려진 원뿔은 반지름 4 m). 걸어서 못 지나가는 보이지 않는 벽이자 총알이 허공에서 멈추는 원기둥이다. `noise.ts` 를 고치자 같은 시드에서 **최대 반지름 18.15 → 3.87 m**, `shotRadius − 실측 최대 반지름` 이 전부 ≤ 0 (콜라이더가 그려진 것을 넘지 않는다), 소품 위 여유 높이 최대 4.64 → 0.51 m 로 내려왔다. `hullOf` 자체는 그대로다 — 잰 값이 옳아졌을 뿐이다. |
| `Nests.ts` | Bug nests on nest pads: displaced organic mounds, glowing rim/holes (pulsing emissive), spikes, egg sacs, goo discs. Mounds are obstacles; `getHolePositions()` feeds `getNestPositions()`. |
| `Pads.ts` | Extraction platforms (concrete disc, seams, yellow/black hazard ring, H marker, 20 blinking edge lights, 4 light poles just outside the 14 m clear zone, one warm PointLight) and the spawn marker (scorch ring + green beacons). `PLATFORM_HEIGHT/RADIUS`. **2026-09-09**: 조명 기둥의 콜라이더가 `0.45 × 5.4` 한 덩어리였다 — 그려진 기둥은 반지름 0.2→0.12 뿐이라 기둥 옆이 보이지 않는 벽이고 총알도 먹었다. 이제 받침(`0.7 × 0.35`)과 기둥(`0.22 × 5.05`) 두 실린더다. |
| `Outposts.ts` | POI ruins: slab, broken wall segments, pillars, antenna mast with dish + blinking red beacon, rubble, barrels. Walls/pillars/mast are obstacles. **2026-09-09**: 안테나 마스트가 `0.8 × mastH`(8~11 m) 한 덩어리였다 — 그려진 기둥(반지름 0.1~0.22)의 네 배라, 마스트 옆을 못 지나가고 그 앞의 약탈자에게 쏜 총알이 허공에서 멈췄다. 이제 밑동 받침(`0.7 × 0.8`)과 기둥(`0.24 × mastH−0.8`) 두 실린더다. |
| `Crates.ts` | 30–40 loot crates: tiered body/lid geometry (beveled frame, stripes), blinking light, tier-4 beacon beam. Registers an `Interactable` per crate (radius 2.8, Korean prompts), lid tween (0.6 s), dust puff, `crate:open`, `audio:play crate_open`, `stats.cratesOpened`. Placement: tier 2 near POIs, tier 3 outside nest rings, tier 4 caches far from spawn, tier 1 in the open. Crates are obstacles (r 0.9). |
| `Gather.ts` | **채집물 (harvestable nodes)** — 약초 plants **and (2026-09-08) 고철 더미**, `GatherNodeDef.kind` telling them apart. `GATHER_NODES_PER_MISSION` (34) procedural herbs in 3 variants, placed in small clusters on gentle, unoccupied ground (`isSpotFree`, ≥ 7 m between clusters, 1.6 m inside one). Two `InstancedMesh` per variant (body + emissive glow part) → 6 draw calls total; the glow material pulses in `update`. Each node registers an `Interactable` (radius 2.2, `holdTime = GATHER_INTERACT_TIME / derived.interactSpeedMul` via a live getter, Korean prompt from the item def name). Harvest → node marked `harvested`, 0.42 s shrink-and-sink instance animation, `gather:collected {nodeId, defId, qty}` (qty × `derived.gatherYieldMul`), `audio:play gather`, then `ctx.inventory.tryAddItem`. Herb def ids are discovered from `ctx.loot.getAllItemDefs()` (`category === 'herb'`); a `FALLBACK_HERB_IDS` list keeps the plants in the world while `items/` has none. **Phase 11**: `build(ctx, game, eco)` takes the planet's ecosystem — the plant **shape** (`variant`) and the **herb it drops** (`defId`) are separate draws now (they used to be bound by `herbIds[variant % len]`), the herb is a weighted draw over `eco.herbs` per cluster (an id `items/` never registered is ignored) and the node count is `GATHER_NODES_PER_MISSION × eco.gatherDensity`; with no planet the old shape-bound pairing is used verbatim and no extra rng is consumed, so the layout is unchanged. **Multiplayer is host-authoritative** (same shape as pickups): clients send `harvq take` / `harvq sync`, the host answers `harv taken {id, by}` / `harv sync {nodes}` and also pushes a sync on `flow rejoined`. Only harvested ids travel — positions are seed-deterministic. A client's pending take expires after 3 s so a lost message never bricks a node. **Phase 9**: a non-host also re-requests the taken set on `net:hostChanged {isLocalHost:false}` (a promoted host never saw the old host's `harv taken` broadcasts as authority). **2026-09-08 — 고철 더미**: `SALVAGE_NODES_PER_MISSION` (7) more nodes of `kind: 'salvage'` in a 4th variant (`SALVAGE_VARIANT`, a crushed drum + bent plates + pipes in metal / rust with amber cut markers — biome colours are deliberately **not** used so a pile reads as metal on any planet). They are drawn **after** the plants from the same `gather` rng fork, so the herb layout for a seed is byte-identical to before; one is tried near each `ctx.layout.pois` (ring 5–14 m) and the rest go in the open, ≥ 12 m apart and ≥ 5 m from any plant. Each yields `mat_scrap` (qty 1, 30 % 2 — ≈ 9 per mission if every pile is stripped), holds for `SALVAGE_INTERACT_TIME` (3 s) inside radius 2.6, prompts `폐금속 해체 (E)`, **ignores `derived.gatherYieldMul`** (that is a 원예 stat) and carries `kind` in `gather:collected` so `progression/` grants 제작 XP instead of 원예. Placement, interaction, the shrink animation and the whole `harv` / `harvq` host authority are the plants' code unchanged. |
| `TrainingArena.ts` | **시뮬레이션 훈련장** (Phase 7): the world built for `game:newMission {mode:'training'}` instead of the planet. Flat `TRAINING_ARENA_SIZE` (64 m) deck with a procedural CanvasTexture grid, four walls with ribs + corner pillars, a ceiling at `ARENA_CEILING` 7 m with 15 emissive light panels, cyan wall bands / lane edges, an amber firing line at z +20 and amber distance marks, spawn ring at (0, 0, 26) ("south", the player faces −Z). 3 lanes (x −10 / 0 / +10) × `TRAINING_TARGET_COUNT` / 3 rows of **pop-up targets**: post + hinged board (silhouette + rings CanvasTexture, resting emissive so they read at 40 m), each an `ObstacleEntry {kind:'target', radius 0.42, height 2.1}` in the world hash with a `DestructibleRef` (`training_target_<i>`, hp `TRAINING_TARGET_HP`) — weapons hit them through the ordinary `raycast → obstacle.destructible.onDamage` path (Phase 3 cover). A hit flashes the board + a small additive ring; at 0 hp the board hinges to the floor (0.28 s, the entry leaves the hash so shots pass), `hit_metal` low, and it rises again `TRAINING_TARGET_RESPAWN_S` later (hp reset, entry re-inserted). Counters `hits` / `knockdowns` → `ui:objective {text:'시뮬레이션 훈련장 · 출구 콘솔로 종료', subText:'명중 n · 격추 m'}` on every change. **Three consoles** along the south wall, one pedestal each (`buildConsole(name, x, lines, accent)`: pedestal + tilted emissive screen + floor halo, obstacle r 0.6): **출구** at x −8 (`Interactable 'training_exit'`, prompt `훈련 종료`, one `training:exitRequested` per second), **모드 콘솔** at x +8 (`'training_mode'`, prompt `표적 모드: <라벨>` → cycles 고정 → 이동 → 타임 코스; in 타임 코스 the next E reads `타임 코스 시작` and starts a run, `타임 코스 진행 중 · n초` while one runs; its screen is repainted in place with `redrawScreen`) and the **무기 거치대** at x +14 (`'training_rack'`, prompt `무기 거치대` → `ctx.inventory.openCatalog({category:'primary'})` — the 무한 상자 on its 주무기 tab; game/'s training exit restores the old loadout afterwards) with a merged wall rack of four silhouetted guns behind it as dressing. **Target modes (Phase 9, `TrainingRef`)**: `mode / setMode / score / hits / remaining / bestTime / startCourse / resetScore`, published as `ctx.world.training`. `static` 고정 = the Phase 7 behaviour; `moving` 이동 sweeps each target **±`TRAINING_MOVING_SPAN`** (a **half**-width, 3.2 m either side of the lane centre — 3.2 + the 0.42 m target radius stays inside `LANE_HALF_W` 4) at `TRAINING_MOVING_SPEED` with a `TRAINING_MOVING_PAUSE_S` pause at each end (`setTargetX` moves the mesh **and** the hash entry, re-bucketing only when the entry's cells change, so shots keep hitting the board where it is drawn); `timed` 타임 코스 = knock `TRAINING_COURSE_TARGETS` targets down inside `TRAINING_COURSE_TIME_S` (every knock-down emits `training:scored {score, hits, index}`; finishing or timing out emits `training:courseFinished {time, score, completed, best}`, arms a `TRAINING_COURSE_COOLDOWN_S` cooldown and, on a completion, saves a new best to localStorage `TRAINING_BEST_STORAGE_KEY`). `setMode` is refused while a course runs, emits `training:modeChanged`, resets the score and parks the targets back on their `baseX`. The objective sub-text now reads `<모드> [· n/m · 남은 n초 | · 최고 n.n초] · 명중 n · 격추 m`. Everything here is **client-local** — no wire messages. Queries: `raycastShell` (floor / ceiling / 4 wall planes, writes the normal), `clampInside` (hard wall clamp), `isInside`. No lights: the arena is shown in the atmosphere's **space mode** (black background, no fog, cool key light) plus a little emissive on the deck / hull. `dispose()` unregisters the console, empties the hash entries and disposes every geometry / material / texture. |
| `Ambience.ts` | 900 additive spore points drifting in a box around the camera (wrapping) with a custom `ShaderMaterial` (perspective size clamped to 1–6 px, fade-in 1.5–6 m from camera, far fade, fog-aware, twinkle); 14 slow dust sprites. |
| `Fog.ts` | **전장의 안개** (2026-09-09, `FogRef`, published as `ctx.world.fog`; **null in a training**). One `MAP_SIZE / FOG_CELL_M` square `Uint8Array` (80² at cell 8 m) is the single source of truth and **a cell once lit stays lit for the whole raid**. Every `FOG_UPDATE_HZ` (5 Hz) it paints `FOG_REVEAL_RADIUS` (55 m) around the local player **and every live remote squadmate** (`ctx.net.getRemotePlayers()`, skipping `!inMission` / dead / gone refs) — the squad's sight is shared, and because everyone already reads the same 20 Hz `ps` snapshots **there is no new wire in normal play**. Only a late joiner asks (`fogq sync` → the host's `fog sync {mask}` = `serialize()`, the mask bit-packed to 800 B and base64'd); `flow rejoined` pushes the same, and a client re-requests on `net:hostChanged {isLocalHost:false}`. `fog:revealed {revision, explored}` fires **only on a tick where the mask actually grew**, never per frame, so the map can cache its layer. The same tick runs the **발견 게이트**: extraction consoles, nest holes, crates and gather nodes that fall into a lit cell emit `fog:discovered {kind, id, position}` once, and the two landmark kinds (신호소 · 둥지) also raise a short `ui:notify`. `WorldSystem` pre-lights `FOG_REVEAL_RADIUS` around the player spawn (the drop point is not a discovery) and disposes the whole thing in `clear()`. |
| `index.ts` | Barrel. |

## 2026-09-09: 지형지물 위 걷기 · 안개 · 스폰 여유 (`WorldRef` 추가분)

Contract (pre-written, read-only): `FogRef`, `WorldRef.fog / getSurfaceY / getStandingObstacle / obstacleCoverage /
scatterPoints`, `fog:revealed` · `fog:discovered`, `FogMessage` (`fog`) · `FogRequest` (`fogq`),
`PROP_STEP_UP_MAX` (0.9) · `PROP_TOP_MARGIN` (0.15) · `FOG_*` · `ENEMY_SPAWN_*`.

- **`getSurfaceY(x, z, feetY?)`** — terrain height, or the top of a prop at that spot when it is one you could be
  standing on. With `feetY` only tops **≤ `feetY + PROP_STEP_UP_MAX`** count (anything higher must stay a wall);
  without it the highest top wins (bullets / falling bodies). Backed by `SpatialHash.query(x, z, 0, out)` — radius 0
  already means "cylinders that cover this point", so no new hash path was needed.
- **`getStandingObstacle(x, z, feetY)`** and `resolveCollision` now use the **same** `PROP_TOP_MARGIN`. The push-out
  skip used to be a hard-coded `> top − 0.05`, which is tighter than any caller could reproduce, so a body seated on
  a rock could be shoved off its own edge. The order a mover must use is **surface first, push-out second**:
  `pos.y = getSurfaceY(x, z, pos.y)` raises the feet onto a low rock, and only then does `resolveCollision` run and
  correctly leave that rock alone. Reversed, the body is pushed out before it can ever step up.
- **`obstacleCoverage(x, z, radius)`** — Σ of the exact circle∩circle areas over `π r²`. Overlaps are not corrected
  (it can exceed 1); it exists to answer "is this spot too cluttered for a big body", which `enemies/Spawner` asks.
- **`scatterPoints(center, radius, count, minGap, seed?)`** — Poisson-ish rejection sampling in a disc, two passes
  (pass 1 also refuses spots inside a prop, pass 2 keeps only the gap) over one `Random`, so a `seed` makes it
  deterministic. Terrain height is filled in; short answers are returned as-is. Used by `stratagems/` for 구조 포드.
- **Grounding is a caller's job.** world/ only answers `getSurfaceY`; `enemies/` was moved onto it in the same batch
  (walk, leap landing, death fall, replica clamp). `player/PlayerController` still calls `getHeightAt` — until it
  moves, a player is blocked by a low rock instead of climbing it (no regression, just the feature missing).

Generation order matters: obstacles registered earlier are avoided by later placement (`isSpotFree`).
Typical generation time: ~400–900 ms on a desktop (heightfield ~150 ms, mesh+colors ~150 ms, props ~200 ms).

Layers: terrain meshes have `Layers.TERRAIN` enabled (in addition to 0), props `Layers.PROP`, crate bodies and gather plants `Layers.INTERACTABLE`.

## Phase 3 (2026-09-06): dynamic obstacles
- `WorldRef.addObstacle(obstacle) → remover`: inserts a `kind: 'dynamic'` entry (with its `destructible`) into the same `SpatialHash` as the props, so collision,
  raycasts and enemy avoidance see dropped cover structures / supply crates immediately; `SpatialHash.remove()` takes it out again. `clear()` drops them with the world.

## Tactical kit (merged 2026-09-06): gather nodes
Shared contract used:
- `types.ts`: `WorldRef.getGatherNodes()`, `GatherNodeDef`.
- `constants.ts`: `GATHER_NODES_PER_MISSION`, `GATHER_INTERACT_TIME`.
- `events.ts`: `gather:collected`.
- `net.ts`: `GatherWire`, `HarvestMessage` (`harv`), `HarvestRequest` (`harvq`); `FlowMessage 'rejoined'` is observed for the late-join sync.
- Optional refs, always read defensively: `ctx.progression?.derived.interactSpeedMul` / `.gatherYieldMul` (default 1), `ctx.loot`, `ctx.inventory`, `ctx.net`.

Known gaps (gathering):
- Herb def ids fall back to `FALLBACK_HERB_IDS` until `items/` ships `category: 'herb'` defs; with no real def the plant is still consumed but no item is granted (`Gather.makeItem` returns null rather than fabricating an instance the UI cannot render).
- Gather nodes do not register obstacles (you walk through the plants) and are not culled per chunk — 34 instances over 6 draw calls is cheap enough.
- Regrowth is not implemented: a harvested node stays consumed for the whole mission.

## Phase 7 (2026-09-06): 시뮬레이션 훈련장 (`WorldRef.mode`)
- `game:newMission {seed, mode}` → `generate(seed, mode)`; a missing `mode` falls back to `ctx.missionMode` (the emitter sets it beforehand per the
  contract, so a rejoin without the field still builds the right world). `mode === 'training'` → `generateTraining(seed)`: `TrainingArena.build`
  into the same `root` / `SpatialHash`, `layout` / `biome` null, `extractionPoints = []`, spawn = the arena's south spawn, then `world:ready`
  exactly like the planet, **then** `atmosphere.setSpaceMode(true)` (Engine's `world:ready` handler re-applied the planet palette inside the emit)
  and the first `ui:objective`. `clear()` (on `game:abort` or the next mission) disposes the arena, empties the hash and switches space mode
  off again (the hub switches it back on when it builds a ship).
- `WorldRef.mode` = mode of the last generated world (`'raid'` until a training was built; **kept through `clear()`** so late abort handlers can
  still read it). `size` is a getter: `TRAINING_ARENA_SIZE` in a training, `MAP_SIZE` otherwise (map screen / ping clamps).
- Every query branches on the mode: `getHeightAt` 0, `getNormalAt` up, `isInsideBounds` = arena box, `resolveCollision` = hash push-out + hard
  wall clamp (no soft wall), `raycast` = `arena.raycastShell` (floor / ceiling / walls) + the usual obstacle cylinders (targets, console),
  `getExtractionPoints / getCrates / getNestPositions / getGatherNodes / getEnemySpawnPoints` → `[]` (extraction builds no consoles, enemies never
  spawn, `Gather` is not built so `harvq` has nothing to answer). `update` only ticks the arena.
- `WorldSystem.trainingArena` (debug / smoke) exposes the arena while a training is up: `targetCount`, `hits`, `knockdowns`, `getTargetState(i)`.
- `WorldRef.training` (Phase 9) is that same arena typed as `TrainingRef` (null outside a training world) — the HUD's `TrainingPanel` and the smokes read it. `getTargetState(i).position` is the live obstacle entry, so it follows a 이동 표적.
- Not mine: the training flow around it (game/ snapshots the inventory and handles `training:exitRequested` → `game:abort` + `hub:enter`;
  hub/ and net/ emit `game:newMission {mode:'training'}`; enemies/ skip spawning on `ctx.isTraining()`).
- Verified: `node scripts/smoke-training.mjs http://localhost:5308/` **61/61**, 0 console errors (see `scripts/README.md`); `smoke-stratagems`
  51/51 still passes. Screenshots checked: lit deck with lane / firing-line strips, ceiling panels, readable target boards at every row, a
  fallen board, the exit console with its screen.

## Phase 11 (2026-09-07): 행성 지형 · 채집 생태계
Brief: `docs/DECISIONS.md` Phase 11. Contract (read-only): `src/shared/planets.ts` (`PlanetId`, `PLANET_DEFS`,
`getPlanet` / `isPlanetId`, `PlanetEcosystem.herbs` / `.gatherDensity`), `WorldRef.planet`, `game:newMission.planet?`,
`world:ready.planet?`, `GameContext.missionPlanet`.

- **The planet, not the seed, decides the palette.** `generate(seed, mode, planet)` takes the 목표 행성 from
  `game:newMission.planet` (falling back to `ctx.missionPlanet`, which the emitter sets **before** it emits because
  generation runs inside that emit), stores it on `WorldRef.planet` and picks `biomeById(PlanetDef.biome)`. The seed
  still decides everything else — layout, crates, nests, props, guards, loot. With **no** planet (an older peer,
  `MissionComplete`'s 다시 배치 without one, a training) `pickBiome(seed)` runs exactly as before, so the pre-Phase-11
  world for a seed is bit-for-bit the world you get today; an **unknown** id is normalised to null so world/ and core/
  fall back together. `world:ready` echoes `planet` (null in a training), and the `[World]` log line names it.
- **Herbs come from the ecosystem.** `Gather.build(ctx, game, eco)`: the plant **shape** (`variant`, 3 procedural
  geometries) and the **herb it drops** (`defId`) are independent draws now — they used to be welded together by
  `herbIds[variant % len]`, which capped a mission at one herb per shape. The herb is a weighted draw over
  `eco.herbs` (**by def id**; an id `items/` never registered is ignored, a planet whose whole mix is unknown falls
  back to the old pairing) taken once per **cluster**, so a patch is still one herb. The node count — and the
  `InstancedMesh` capacity — is `GATHER_NODES_PER_MISSION × eco.gatherDensity` (20 on 피로스 VII, 51 on 베르단트 III).
  No planet consumes **no extra rng**, so the plant layout for a seed is unchanged.
- **Training is untouched**: `planet` is forced to null, no biome, no ecosystem, no gather nodes.
- Not mine: the sky / fog half of a planet (`core/Atmosphere.applyPlanet`, lead), the terminal that picks one (hub/),
  and the enemy side of `eco` (enemies/, same lane — see `src/enemies/README.md`).

### Known follow-ups (Phase 11)
- `PlanetDef.biome` is a plain string: a typo there silently degrades to the seeded draw instead of failing loudly
  (deliberate — `biomeById` never throws), and there is still no compile-time link between `PLANET_DEFS` and `BIOMES`.
- Terrain / props / crates / nests are **not** re-tuned per planet: only the palette and the herbs change, so two
  planets on the same seed have identical rock placement. `Biome.pairedSky` / `fogHint` are now redundant with
  `PlanetDef.sky` / `fog` whenever a planet is set (they still drive the no-planet path).
- `gatherDensity > 1` keeps the same 5000 placement attempts and the same `MIN_SPACING`, so a very dense planet on a
  cluttered seed can come up a few nodes short of its target (베르단트 III asks for 51).
- `eco.herbs` weights are per **cluster**, not per node, so the realised mix over one mission is coarser than the
  weights suggest (a 3-plant patch counts once). Sampling across seeds converges.
- `WorldRef.planet` is kept through `clear()` (like `mode`), so a late abort handler reads the planet of the mission
  that just ended, not null.

## Verified (Phase 11, 2026-09-07)
`npm run typecheck` — 0 errors in `src/world` / `src/enemies`. New `scripts/smoke-ecology.mjs` (single-player, private
`npx vite --port 5297`, sim-time waits, HMR + relay sockets parked) — **83/83**, 0 console errors: the no-planet
baseline (null planet on the ref and on `world:ready`, seeded biome, 34 nodes, cap `12 + 24 × threat`, old gates), all
five planets (planet echoed, biome named by `PlanetDef`, node count from `gatherDensity`, only the planet's herb ids
placed, ecosystem intact in enemies/, `pressure` cap, no forbidden type composed, gates held, guard density, boss
rule), the herb weights over 3 seeds (72 nodes: ashleaf 49 / bloodroot 17 / glowcap 6 on 아켈론 II), shape ≠ herb,
determinism (same seed + planet → identical biome, node ids / positions and guard placement; another planet differs),
an unknown id falling back, and a training staying planet-free. Regressions on the same build: `smoke-training`
101/109 (**8 pre-existing failures from the hub lane's new launch-pod planet gate** — the smoke boards `hub_pod_0`
without a 목표 행성; the arena / target-mode half is green), `smoke-rogue-v2` 52/52, `smoke-enemy-delta` 52/52,
`smoke-tactical` 63/64 (the miss is the relay socket, gather nodes 34 + all three herbs green), `smoke-phase4` 49/49.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-09 (보이지 않는 거대 콜리전)** — 뿌리는 `noise.ts` 의 `noise3` 였다: `lerp(a, b, t)` 에
  인자를 `(t, a, b)` 로 넣어 결과가 `[-1, 1]` 이 아니라 **`[-31, +52]`** 였고, `build.displace` 가 그
  값만큼 정점을 밖으로 밀어 소품마다 정점 몇 개가 멀리 튀겨 나갔다. 눈에는 가는 가시 하나라 오래
  지나쳤는데, 바로 전날 `Props.hullOf` 가 바운딩 박스로 **콜라이더를** 만들기 시작하면서 그 정점
  하나가 소품 전체를 감싸는 반지름 10~18 m · 높이 20 m 짜리 원기둥이 됐다. 시드 21 기준
  바위 콜라이더 최대 반지름 **18.15 → 3.87 m**, 소품 위 여유 높이 **4.64 → 0.51 m**.
  같이: 안테나 마스트(`Outposts`)와 탈출 패드 조명 기둥(`Pads`)을 받침 + 기둥 두 실린더로 쪼개서
  그려진 굵기에 맞췄다. 로그(약탈자) 16명에게 3거리 × 8방향으로 쌀 384발 기준,
  소품에 막힌 탄이 **rock 23 → 1**, wall · pole 은 0 발로 사라졌다.
  둔덕(`nest`)은 그대로 둔다 — 원기둥이 가슴 높이에서는 그려진 돔보다 오히려 좁다.

- **2026-09-09 (전장의 안개 · 지형지물 위 걷기)** — `Fog.ts` 신규 (`ctx.world.fog`, 분대 공용 마스크 ·
  `fog:revealed` / `fog:discovered` · `fog`/`fogq` 늦은 합류 동기화), `WorldRef` 에 `getSurfaceY` ·
  `getStandingObstacle` · `obstacleCoverage` · `scatterPoints` 구현, `Props.ts` 의 **이동 콜라이더를 실측
  실루엣으로** (바위 · 첨탑 · 크리스탈 · 잔해는 `hullOf`, 나무는 줄기 반경 + 실측 높이),
  `resolveCollision` 의 윗면 판정을 `PROP_TOP_MARGIN` 으로 통일.

- **2026-09-08 (상자 빛기둥)** — 열린 상자는 `Interactable.hidePillar` 를 `true` 로 돌린다 (`Crates.ts`, 게터).
  상자는 연 뒤에도 `상자 살펴보기 (E)` 로 계속 상호작용 가능이라 `canInteract` 이 절대 false 가 되지 않았고,
  그래서 `ui/hud/Detection` 의 감지 빛기둥이 — 특히 4티어 귀중품 상자 위에서 — 영원히 켜져 있었다.

- **2026-09-08 (폐금속 공급 · 고철 더미)** — 폐금속이 상자의 `material` 롤에서만 나오던 병목을 푸는 세 갈래 중
  월드 몫. `Gather.ts` 에 **`kind: 'salvage'` 노드**(`SALVAGE_NODES_PER_MISSION` 7개, 변종 3번 = 난파 고철 더미)를
  얹었다 — 새 시스템을 만들지 않았다. 배치 · 상호작용 · 축소 애니메이션 · 호스트 권한 동기화가 전부 약초의 코드
  그대로고, 다른 것은 메시 · `해체` 프롬프트 · 3초 홀드 · 채집 수율 미적용 · 제작 XP 뿐이다.
  약초 배치가 끝난 **뒤에** 뽑으므로 같은 시드의 약초 레이아웃은 바이트 단위로 종전과 같다.

- **tactical kit** — **gather nodes** (`Gather.ts`: 34 instanced herbs per mission, `getGatherNodes()`, hold-interact → `gather:collected` + herb item, host-authoritative `harv`/`harvq`)

- **Phase 7** — `TrainingArena.ts` — the 시뮬레이션 훈련장 for `game:newMission {mode:'training'}` (64 m walled deck, 12 pop-up targets as destructible obstacles with respawn, hit / knock-down counter via `ui:objective`, exit console `training_exit` → `training:exitRequested`, no crates / nests / gather / extraction, arena queries), `WorldRef.mode`

- **Phase 9** — **표적 모드** (`ctx.world.training` = `TrainingRef`: 고정 / 이동 (lane sweep, the hash entry is re-bucketed) / 타임 코스 (`TRAINING_COURSE_TARGETS` in `TRAINING_COURSE_TIME_S`, best time in `TRAINING_BEST_STORAGE_KEY`), `training:modeChanged / scored / courseFinished`), arena consoles `training_mode` (cycle / start) and `training_rack` (→ `inventory.openCatalog({category:'primary'})`, undone by the exit restore), `harvq sync` re-requested on `net:hostChanged`

- **Phase 11** — `biomes.biomeById(id)` 로 행성이 바이옴을 **직접** 고르고(`pickBiome(seed)` 는 무행성 폴백), `WorldRef.planet` + `world:ready.planet`, `Gather` 는 모양(`variant`)과 아이템(`defId`)을 분리해 `eco.herbs` 가중 추첨을 쓰고 노드 수는 `× eco.gatherDensity` (무행성이면 rng 소비까지 예전과 동일)
