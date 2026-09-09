# src/world — Procedural planet surface

Owner system: `WorldSystem` (publishes `ctx.world`, implements `WorldRef`).
Generates the whole map **synchronously** on `game:newMission {seed, mode?}` and emits `world:ready {seed, playerSpawn}`
(`mode: 'training'` → the 시뮬레이션 훈련장 of `TrainingArena.ts` instead of the planet, see the Phase 7 section);
tears everything down on `game:abort` and emits `world:cleared`. No asset files — all geometry, vertex colors and
textures are procedural.

| File | Responsibility |
|---|---|
| `WorldSystem.ts` | `GameSystem` + `WorldRef` implementation. Orchestrates generation order (terrain → nests → pads → outposts → **structures → rails** → props → crates → **gather** → ambience), owns the `SpatialHash`, and answers queries: `getHeightAt` (heightfield + extraction platform top), `getNormalAt`, `resolveCollision` (circle push-out + soft wall at ±(MAP_SIZE/2−4)), `raycast` (heightfield ray-march + analytic ray/cylinder vs obstacles — **2026-09-08** it shoots at `Obstacle.shotRadius / shotHeight` when a prop declares them, and the slab clip is complete: the old code tested only the entry point of the infinite cylinder plus the top cap, so a ray entering the footprint below the base and crossing the body further along reported a miss), `getEnemySpawnPoints`, `getExtractionPoints`, `getCrates`, `getNestPositions`, `getPlayerSpawn`, `getGatherNodes` (appended). Extra: `getBiome()`. **2026-09-09 (사각 콜라이더)**: `resolveCollision` · `raycast` · `getSurfaceY` · `getStandingObstacle` 가 `Obstacle.box` 를 만나면 `obb.ts` 로 갈라진다 — 원기둥 소품의 코드 경로는 한 줄도 바뀌지 않았다. `getStructures / structureAt / getRailLines / getTrams` 는 `Structures` / `Rails` 로 위임한다 (훈련장은 빈 배열). **Phase 11**: `generate(seed, mode, planet)` — the 목표 행성 (from `game:newMission.planet`, else `ctx.missionPlanet`) is stored on `WorldRef.planet`, picks the biome by id and is echoed in `world:ready.planet`; an unknown id is reported as null. |
| `noise.ts` | Seeded 2D simplex (`noise2`), 3D gradient noise (`noise3`), `fbm`, `ridged`, `billow`; `lerp/clamp/smoothstep` helpers. **2026-09-09 — `noise3` 의 `lerp` 인자 순서가 뒤집혀 있었다.** `lerp` 는 `(a, b, t)` 인데 `(t, a, b)` 로 넣어 세 겹의 보간이 `w + (a − w)·b` 로 쌓였고, 값이 `[-1, 1]` 이 아니라 **측정 `[-31.2, +52.6]`** 이었다. 쓰는 곳이 `build.displace` 하나뿐이라 지형(`noise2` 계열)은 멀쩡했지만 소품 정점 몇 개가 원점에서 10 units 씩 튕겨 나갔고, `Props.hullOf` 가 바운딩 박스로 콜라이더를 만들면서 그 정점 하나가 소품 전체를 감싸는 거대 원기둥이 됐다 (아래 `Props.ts`). 고친 뒤 범위 `[-0.91, +0.99]`. |
| `biomes.ts` | Five biome palettes (amber desert, frozen tundra, mossy swamp, ashen volcanic, crimson alien): terrain bands, prop colors, scatter density multipliers. `pickBiome(seed)` reproduces core's `new Random(seed).fork('atmosphere').pick(SKY_PALETTES)` draw so `BIOMES[i]` is always shown under `SKY_PALETTES[i]` (amber-dusk, cold-blue, toxic-green, rust-storm, pale-noon) and each palette is tuned to contrast with its fog color (`pairedSky`, `fogHint`). If core changes the palette count or fork label, the pairing silently degrades to "random but valid". **Phase 11**: `biomeById(id)` looks a palette up by `PlanetDef.biome`, so with a 목표 행성 the pairing is data instead of two matching draws; `pickBiome` stays the no-planet fallback. |
| `layout.ts` | Macro layout from the seed: spawn pad near an edge, 3 extraction pads (≥180 m apart, ≥150 m from spawn), 4–6 nest pads, 5–8 POI pads, craters, basins. `padClearance`, `nearestPad`. **2026-09-09**: `structures: StructureSite[]` (버려진 구조물 부지 + 지하실 구덩이 치수) 와 `rail: RailPlan | null` (`RAIL_CHANCE`, `loop`/`line`, 위상, 플랫폼 패드)이 붙었다 — 둘 다 **지형이 평탄화해야** 하는 자리라 매크로 단계에서 먼저 잡는다. 크레이터 · 분지를 다 뽑은 **뒤에** 굴리므로 그 앞의 추첨은 밀리지 않지만, 새 패드가 `pads` 에 들어가 `padClearance` 를 바꾸므로 **소품 · 상자 · 적 스폰의 자리는 달라진다** (건물 안에 바위가 서지 않게 하려면 그게 맞다). |
| `Terrain.ts` | **2026-09-09**: pad 평탄화 **다음에** `layout.structures` 의 지하실 **구덩이**를 판다 — 회전한 사각형을 `PIT_BLEND`(1.6 m, `structures/model`) 폭에 걸쳐 `pad.height − depth` 까지 내린다. 그 폭만큼 흙이 비스듬해지므로 천장 슬래브는 구덩이보다 `PIT_BLEND` 넓게 덮어야 한다 (안 그러면 구덩이 둘레에 도랑이 남는다). Heightfield (417×417 verts, 2 m spacing, covers ±416 m incl. border mountains) from warped fBm + ridged noise + craters/basins + flattened pads + edge cliffs. 8×8 chunk meshes with vertex colors (biome bands by height/slope, AO, crater scorch, nest goo), procedural tiled detail albedo + normal `CanvasTexture`s. Fast bilinear `getHeightAt`, `getNormalAt`, `getSlopeAt`, adaptive ray-march `raycast`. |
| `SpatialHash.ts` | 16 m XZ grid of `ObstacleEntry` cylinders: `add/query/overlaps/walkSegment`. **2026-09-08**: `add(…, shot?)` also takes the **shot** cylinder (`Obstacle.shotRadius / shotHeight`) and bucketing / `maxRadius` use the larger of the two, so `walkSegment` never misses a prop whose shot cylinder reaches into a cell its collider does not. `query` still filters on `o.radius`, so movement collision is untouched. **2026-09-09**: `addBox(position, halfX, halfZ, yaw, height, kind)` 가 **사각(OBB) 콜라이더**를 넣는다 — `radius` 는 계약대로 외접원(`hypot`)으로 채우므로 버킷팅 · `overlaps` · `query` 는 예전 그대로이고 정확한 판정만 `WorldSystem` 에서 갈린다. `move(o, x, y, z, yaw?)` 는 움직이는 장애물(전차)을 옮기고 **덮는 셀이 바뀔 때만** 다시 버킷팅한다 (`TrainingArena.setTargetX` 와 같은 수법). |
| `build.ts` | `BuildCtx` shared by sub-builders and geometry helpers: `isSpotFree`, `paint`, `paintGradient`, `displace`, `merge` (BufferGeometryUtils), `xform`, `composeMatrix`, soft particle texture. |
| `Props.ts` | Jittered-grid + noise-cluster scatter into `InstancedMesh` variants (named `prop_<kind>`): boulders (also on border slopes), rock spires, fungal/dead trees, emissive crystal clusters (pulse), wind-swaying grass tufts (shader injection), pebbles, debris (crates/pod shells/panels). Collidable kinds (boulder, spire, tree, crystal, crate/pod debris) register obstacles; grass, pebbles and panels do not. **2026-09-09 — the movement collider is the drawn silhouette too.** `hullOf` used to size only the *shot* cylinder; the mover's cylinder was still a guess (`s*0.82 / s*1.3` for a boulder, `s*0.8 / s*4.2` for a spire that draws up to `1.5·s·4.2`, a flat `5*s` for every tree, `0.8s / 2.5s` for a crystal), which is why a rock you could see the top of was an invisible wall half a metre above itself and could never be stood on. Now **boulder / spire / crystal / debris pass the measured hull to both cylinders** and the height carries the instance's own `sy`. Two deliberate exceptions: a **tree** keeps the trunk radius (`0.5*s`) for both — a fungal cap is 2 m wide 3.5 m up, so a hull-wide cylinder would be an invisible wall at ground level and would stop bullets in open air — and only its *height* is measured; a **debris crate** is randomly yawed, so its XZ radius is the corner sweep (`√2 × half-width`) rather than the mean half-width. ⚠ **A seed's prop layout is no longer byte-identical to before this change**: `isSpotFree` tests `SpatialHash.overlaps`, which filters on `o.radius`, and a rejected spot skips the rest of that scatter callback's rng draws — so wider rock colliders shift the stream for everything scattered after them (and for crates / outposts, whose `isSpotFree` reads the same hash). Multiplayer determinism is untouched (every client runs the same code from the same seed); what is gone is only "seed 21 looks exactly like it did yesterday". **2026-09-09 (같은 날, 뒤늦게) — 그 실측 실루엣이 거짓말이었다.** `hullOf` 는 정직하게 바운딩 박스를 쟀지만 지오메트리에 `noise3` 버그로 튕겨 나간 정점이 섞여 있어서, 시드 21 에서 **첨탑 콜라이더가 반지름 최대 18.2 m · 높이 22.2 m** 로 부풀었다 (그려진 원뿔은 반지름 4 m). 걸어서 못 지나가는 보이지 않는 벽이자 총알이 허공에서 멈추는 원기둥이다. `noise.ts` 를 고치자 같은 시드에서 **최대 반지름 18.15 → 3.87 m**, `shotRadius − 실측 최대 반지름` 이 전부 ≤ 0 (콜라이더가 그려진 것을 넘지 않는다), 소품 위 여유 높이 최대 4.64 → 0.51 m 로 내려왔다. `hullOf` 자체는 그대로다 — 잰 값이 옳아졌을 뿐이다. |
| `Nests.ts` | Bug nests on nest pads: displaced organic mounds, glowing rim/holes (pulsing emissive), spikes, egg sacs, goo discs. Mounds are obstacles; `getHolePositions()` feeds `getNestPositions()`. |
| `Pads.ts` | Extraction platforms (concrete disc, seams, yellow/black hazard ring, H marker, 20 blinking edge lights, 4 light poles just outside the 14 m clear zone, one warm PointLight) and the spawn marker (scorch ring + green beacons). `PLATFORM_HEIGHT/RADIUS`. **2026-09-09**: 조명 기둥의 콜라이더가 `0.45 × 5.4` 한 덩어리였다 — 그려진 기둥은 반지름 0.2→0.12 뿐이라 기둥 옆이 보이지 않는 벽이고 총알도 먹었다. 이제 받침(`0.7 × 0.35`)과 기둥(`0.22 × 5.05`) 두 실린더다. |
| `Outposts.ts` | POI ruins: slab, broken wall segments, pillars, antenna mast with dish + blinking red beacon, rubble, barrels. Walls/pillars/mast are obstacles. **2026-09-09**: 안테나 마스트가 `0.8 × mastH`(8~11 m) 한 덩어리였다 — 그려진 기둥(반지름 0.1~0.22)의 네 배라, 마스트 옆을 못 지나가고 그 앞의 약탈자에게 쏜 총알이 허공에서 멈췄다. 이제 밑동 받침(`0.7 × 0.8`)과 기둥(`0.24 × mastH−0.8`) 두 실린더다. |
| `Crates.ts` | 30–40 loot crates: tiered body/lid geometry (beveled frame, stripes), blinking light, tier-4 beacon beam. Registers an `Interactable` per crate (radius 2.8, Korean prompts), lid tween (0.6 s), dust puff, `crate:open`, `audio:play crate_open`, `stats.cratesOpened`. Placement: tier 2 near POIs, tier 3 outside nest rings, tier 4 caches far from spawn, tier 1 in the open. Crates are obstacles (r 0.9). |
| `Gather.ts` | **채집물 (harvestable nodes)** — 약초 plants **and (2026-09-08) 고철 더미**, `GatherNodeDef.kind` telling them apart. `GATHER_NODES_PER_MISSION` (34) procedural herbs in 3 variants, placed in small clusters on gentle, unoccupied ground (`isSpotFree`, ≥ 7 m between clusters, 1.6 m inside one). Two `InstancedMesh` per variant (body + emissive glow part) → 6 draw calls total; the glow material pulses in `update`. Each node registers an `Interactable` (radius 2.2, `holdTime = GATHER_INTERACT_TIME / derived.interactSpeedMul` via a live getter, Korean prompt from the item def name). Harvest → node marked `harvested`, 0.42 s shrink-and-sink instance animation, `gather:collected {nodeId, defId, qty}` (qty × `derived.gatherYieldMul`), `audio:play gather`, then `ctx.inventory.tryAddItem`. Herb def ids are discovered from `ctx.loot.getAllItemDefs()` (`category === 'herb'`); a `FALLBACK_HERB_IDS` list keeps the plants in the world while `items/` has none. **Phase 11**: `build(ctx, game, eco)` takes the planet's ecosystem — the plant **shape** (`variant`) and the **herb it drops** (`defId`) are separate draws now (they used to be bound by `herbIds[variant % len]`), the herb is a weighted draw over `eco.herbs` per cluster (an id `items/` never registered is ignored) and the node count is `GATHER_NODES_PER_MISSION × eco.gatherDensity`; with no planet the old shape-bound pairing is used verbatim and no extra rng is consumed, so the layout is unchanged. **Multiplayer is host-authoritative** (same shape as pickups): clients send `harvq take` / `harvq sync`, the host answers `harv taken {id, by}` / `harv sync {nodes}` and also pushes a sync on `flow rejoined`. Only harvested ids travel — positions are seed-deterministic. A client's pending take expires after 3 s so a lost message never bricks a node. **Phase 9**: a non-host also re-requests the taken set on `net:hostChanged {isLocalHost:false}` (a promoted host never saw the old host's `harv taken` broadcasts as authority). **2026-09-08 — 고철 더미**: `SALVAGE_NODES_PER_MISSION` (7) more nodes of `kind: 'salvage'` in a 4th variant (`SALVAGE_VARIANT`, a crushed drum + bent plates + pipes in metal / rust with amber cut markers — biome colours are deliberately **not** used so a pile reads as metal on any planet). They are drawn **after** the plants from the same `gather` rng fork, so the herb layout for a seed is byte-identical to before; one is tried near each `ctx.layout.pois` (ring 5–14 m) and the rest go in the open, ≥ 12 m apart and ≥ 5 m from any plant. Each yields `mat_scrap` (qty 1, 30 % 2 — ≈ 9 per mission if every pile is stripped), holds for `SALVAGE_INTERACT_TIME` (3 s) inside radius 2.6, prompts `폐금속 해체 (E)`, **ignores `derived.gatherYieldMul`** (that is a 원예 stat) and carries `kind` in `gather:collected` so `progression/` grants 제작 XP instead of 원예. Placement, interaction, the shrink animation and the whole `harv` / `harvq` host authority are the plants' code unchanged. |
| `TrainingArena.ts` | **시뮬레이션 훈련장** (Phase 7): the world built for `game:newMission {mode:'training'}` instead of the planet. Flat `TRAINING_ARENA_SIZE` (64 m) deck with a procedural CanvasTexture grid, four walls with ribs + corner pillars, a ceiling at `ARENA_CEILING` 7 m with 15 emissive light panels, cyan wall bands / lane edges, an amber firing line at z +20 and amber distance marks, spawn ring at (0, 0, 26) ("south", the player faces −Z). 3 lanes (x −10 / 0 / +10) × `TRAINING_TARGET_COUNT` / 3 rows of **pop-up targets**: post + hinged board (silhouette + rings CanvasTexture, resting emissive so they read at 40 m), each an `ObstacleEntry {kind:'target', radius 0.42, height 2.1}` in the world hash with a `DestructibleRef` (`training_target_<i>`, hp `TRAINING_TARGET_HP`) — weapons hit them through the ordinary `raycast → obstacle.destructible.onDamage` path (Phase 3 cover). A hit flashes the board + a small additive ring; at 0 hp the board hinges to the floor (0.28 s, the entry leaves the hash so shots pass), `hit_metal` low, and it rises again `TRAINING_TARGET_RESPAWN_S` later (hp reset, entry re-inserted). Counters `hits` / `knockdowns` → `ui:objective {text:'시뮬레이션 훈련장 · 출구 콘솔로 종료', subText:'명중 n · 격추 m'}` on every change. **Three consoles** along the south wall, one pedestal each (`buildConsole(name, x, lines, accent)`: pedestal + tilted emissive screen + floor halo, obstacle r 0.6): **출구** at x −8 (`Interactable 'training_exit'`, prompt `훈련 종료`, one `training:exitRequested` per second), **모드 콘솔** at x +8 (`'training_mode'`, prompt `표적 모드: <라벨>` → cycles 고정 → 이동 → 타임 코스; in 타임 코스 the next E reads `타임 코스 시작` and starts a run, `타임 코스 진행 중 · n초` while one runs; its screen is repainted in place with `redrawScreen`) and the **무기 거치대** at x +14 (`'training_rack'`, prompt `무기 거치대` → `ctx.inventory.openCatalog({category:'primary'})` — the 무한 상자 on its 주무기 tab; game/'s training exit restores the old loadout afterwards) with a merged wall rack of four silhouetted guns behind it as dressing. **Target modes (Phase 9, `TrainingRef`)**: `mode / setMode / score / hits / remaining / bestTime / startCourse / resetScore`, published as `ctx.world.training`. `static` 고정 = the Phase 7 behaviour; `moving` 이동 sweeps each target **±`TRAINING_MOVING_SPAN`** (a **half**-width, 3.2 m either side of the lane centre — 3.2 + the 0.42 m target radius stays inside `LANE_HALF_W` 4) at `TRAINING_MOVING_SPEED` with a `TRAINING_MOVING_PAUSE_S` pause at each end (`setTargetX` moves the mesh **and** the hash entry, re-bucketing only when the entry's cells change, so shots keep hitting the board where it is drawn); `timed` 타임 코스 = knock `TRAINING_COURSE_TARGETS` targets down inside `TRAINING_COURSE_TIME_S` (every knock-down emits `training:scored {score, hits, index}`; finishing or timing out emits `training:courseFinished {time, score, completed, best}`, arms a `TRAINING_COURSE_COOLDOWN_S` cooldown and, on a completion, saves a new best to localStorage `TRAINING_BEST_STORAGE_KEY`). `setMode` is refused while a course runs, emits `training:modeChanged`, resets the score and parks the targets back on their `baseX`. The objective sub-text now reads `<모드> [· n/m · 남은 n초 | · 최고 n.n초] · 명중 n · 격추 m`. Everything here is **client-local** — no wire messages. Queries: `raycastShell` (floor / ceiling / 4 wall planes, writes the normal), `clampInside` (hard wall clamp), `isInside`. No lights: the arena is shown in the atmosphere's **space mode** (black background, no fog, cool key light) plus a little emissive on the deck / hull. `dispose()` unregisters the console, empties the hash entries and disposes every geometry / material / texture. |
| `Ambience.ts` | 900 additive spore points drifting in a box around the camera (wrapping) with a custom `ShaderMaterial` (perspective size clamped to 1–6 px, fade-in 1.5–6 m from camera, far fade, fog-aware, twinkle); 14 slow dust sprites. |
| `Fog.ts` | **전장의 안개** (2026-09-09, `FogRef`, published as `ctx.world.fog`; **null in a training**). One `MAP_SIZE / FOG_CELL_M` square `Uint8Array` (80² at cell 8 m) is the single source of truth and **a cell once lit stays lit for the whole raid**. Every `FOG_UPDATE_HZ` (5 Hz) it paints `FOG_REVEAL_RADIUS` (55 m) around the local player **and every live remote squadmate** (`ctx.net.getRemotePlayers()`, skipping `!inMission` / dead / gone refs) — the squad's sight is shared, and because everyone already reads the same 20 Hz `ps` snapshots **there is no new wire in normal play**. Only a late joiner asks (`fogq sync` → the host's `fog sync {mask}` = `serialize()`, the mask bit-packed to 800 B and base64'd); `flow rejoined` pushes the same, and a client re-requests on `net:hostChanged {isLocalHost:false}`. `fog:revealed {revision, explored}` fires **only on a tick where the mask actually grew**, never per frame, so the map can cache its layer. The same tick runs the **발견 게이트**: extraction consoles, nest holes, crates, gather nodes and (2026-09-09) **버려진 구조물 · 선로 플랫폼** that fall into a lit cell emit `fog:discovered {kind, id, position}` once, and the two landmark kinds (신호소 · 둥지) also raise a short `ui:notify` — **`structure` · `rail` 은 일부러 토스트를 띄우지 않는다**, 그 둘은 `ui/hud/RaidAlerts` 가 소유하므로 여기서도 띄우면 두 번 뜬다. `WorldSystem` pre-lights `FOG_REVEAL_RADIUS` around the player spawn (the drop point is not a discovery) and disposes the whole thing in `clear()`. |
| `obb.ts` | **사각(OBB) 콜라이더** 수학 (2026-09-09, `Obstacle.box`). `boxRadius` (버킷팅용 외접원) · `boxContainsXZ` (윗면 판정) · `boxPushOut` (원 vs 상자 밀어내기, 중심이 안이면 가장 얕은 면으로) · `rayBox` (슬래브 셋 + `boxHitNormal`) · `BOX_HEADROOM`. **`o.box` 가 있을 때만 불린다** — 원기둥 경로는 그대로다. 회전 규약: `box.yaw` 는 수학 규약(로컬 +X → 월드 `(cos, sin)`)이고 같은 상자를 그리는 메시의 Euler 는 `-yaw` 다 (three 의 Y 회전이 반대 손). |
| `Structures.ts` | **버려진 구조물** — 전진기지 · 연구실 · 불시착 함선. 건물 세우기, 컴퓨터(행성 스캔) · 지하실 해치 상호작용, 컨테이너 배치, `struct`/`structq` 호스트 권위, `getDefs` / `structureAt`. 지하실 해치는 **잠긴 동안 계단 구멍을 막는 상자 콜라이더**이고 열리면 hash 에서 빠지며 옆으로 미끄러진다. 로그 강하의 "구역당 1회" 기록(`roguedZones`)도 여기 있다. |
| `structures/model.ts` | 구조물 · 선로가 공유하는 어휘. **`data/structures.csv` 를 읽는 유일한 자리** (개수 · 크기 · 컨테이너 수 · 지하실 확률/깊이 · 상자 티어 가중치) + 건물 치수 상수(`WALL_T` · `DOOR_W` · `STAIR_HALF` · `SLAB_T` · `PIT_BLEND` · `CONTAINER_RADIUS`) + `pickTier`. THREE 를 **값으로 쓰지 않는다** — `layout.ts` 와 `scripts/data-check.mjs` 가 아주 이르게 읽는다. |
| `structures/parts/Build.ts` | 건물 지오메트리 + 콜라이더. `buildBuilding` (벽 · 문틀 · 격벽 · **무너진 지붕** · 구덩이 라이닝 · 천장 슬래브 · 계단 · 해치 자리 · 컨테이너/콘솔 자리), `buildWreck` (동체 옆판 · 후미 램프 · 기수 · 날개 · 나셀). 벽 하나 = 상자 하나이고 그린 `BoxGeometry` 와 **같은 수**를 콜라이더에 쓴다. |
| `structures/parts/Containers.ts` | 구조물 · 플랫폼 · 전차 안의 **상호작용 컨테이너** (`ContainerSet`). 새 루팅 경로를 만들지 않는다 — 열면 `crate:open {crateId, tier, position}` 을 쏘고 `inventory/` 의 상자 코드가 티어 롤 · 캐시 · 동기화 · 감정 XP · 계약 카운터를 전부 한다. 더하는 것은 실루엣 3종과 두 규칙뿐: 구역에서 **처음** 열면 `structure:investigated`, `bonusDefId`(지하실 키카드)가 있으면 `openContainerItems` 로 먼저 채우고 그 다음 `crate:open`. `dynamic` 스펙은 콜라이더 없이 매 프레임 따라 움직인다 (전차 객실). |
| `Rails.ts` | **선로 · 플랫폼 · 전차**. 중심선(지형 높이 평활화 + `RAIL_DECK_Y`) · 침목/레일/교각 · 플랫폼(데크 · 계단 · 난간 · 컨테이너 · 콘솔) · 전차(차체 OBB + `velocity` 발판 + 객실 컨테이너) · 도킹 · `tram`/`tramq` 호스트 권위 · `getLines` / `getTrams`. **선로는 지형을 평탄화하지 않는다** — 교각이 높이를 맞춘다. |
| `rails/model.ts` | 선로 경로 수학과 상수. `RailPath` (`makePath` · `wrapS` · `sampleAt` · `nearestS` · `deltaS`) + `RAIL_DECK_Y` · `TIE_STEP` · `PIER_STEP` · `GAUGE_HALF` · `DOCK_WINDOW` · `TRAM_NET_INTERVAL` · `TRAM_SNAP_M` · `PLATFORM_OFFSET`. |
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

## 2026-09-09: 버려진 구조물 · 선로 · 전차 (사각 콜라이더)

Contract (pre-written, read-only, `git show 9ea3fc0`): `Obstacle.box` · `Obstacle.velocity`, `StructureDef` ·
`StructureKind` · `STRUCTURE_LABEL_KO`, `RailLineDef` · `RailPlatformDef` · `TramDef` · `TramState` · `TRAM_STATES`,
`WorldRef.getStructures / structureAt / getRailLines / getTrams`, `structure:unlocked / scanned / investigated`,
`rail:tramStarted / tramDocked`, `fog:discovered.kind += structure | rail`, `struct`/`structq` · `tram`/`tramq`,
`STRUCTURE_*` · `RAIL_CHANCE` · `TRAM_*`. 수치는 `data/structures.csv` (신규) 와 `data/constants.csv`.

### 생성 순서 — 왜 여기인가
부지는 **`layout.ts` 가 제일 먼저** 잡는다. 지형이 그 자리를 평탄화하고 지하실 구덩이를 파야 하는데
`Terrain.build` 는 `layout.pads` 만 보기 때문이다. 다만 구조물 · 선로 추첨은 **크레이터 · 분지 다음**에
굴린다 — 그 앞의 rng 를 밀지 않으려는 것이고, 그래서 같은 시드의 지형 매크로 형태(언덕 · 능선 · 크레이터)는
이 변경 전과 같다.

건물은 **지형 · 아웃포스트 다음, 소품 · 상자 앞**에 세운다 (`terrain → nests → pads → outposts →
structures → rails → props → crates → gather`). 벽 · 데크 · 컨테이너가 먼저 `SpatialHash` 에 들어가야
`isSpotFree` 가 그 자리를 피한다 — 순서를 뒤집으면 **방 한가운데 바위가 선다**. 대가는 이 README 가
2026-09-09 에 이미 적어 둔 것과 같다: `padClearance` 와 `hash.overlaps` 가 달라졌으므로 **같은 시드의 소품 ·
상자 · 채집물 배치가 종전과 바이트 단위로 같지는 않다** (멀티 결정성은 그대로 — 모두가 같은 코드를 같은
시드로 돌린다).

### `Obstacle.box` 를 world/ 에 들이는 법
벽을 원기둥으로 흉내내면 두 가지가 다 틀어진다 — 하나로 감싸면 방 전체가 막히고, 여럿으로 쪼개면
그려진 판보다 두꺼운 톱니가 된다 (예전 `Outposts` 의 벽이 그렇다). 그래서 상자를 넣되 **기존 원기둥 코드
경로를 한 줄도 건드리지 않았다**:

- `SpatialHash` — `addBox` 가 `radius` 를 **외접원**으로 채운다. 버킷팅 · `overlaps` · `query` 는 그 원만
  보므로 코드가 그대로이고, 상자가 버킷에서 새지 않는다 (질의는 보수적으로 조금 더 잡는다).
- `resolveCollision` — `o.box` 면 `obb.boxPushOut`. 상자에만 있는 판정이 하나 더 있다: **머리 위로
  `BOX_HEADROOM`(2.1 m) 넘게 떠 있는 판은 밀어내지 않는다.** 상자는 뜬 바닥일 수 있어서다 (지하실 천장
  슬래브 · 전차 데크 · 플랫폼 데크). 원기둥은 전부 땅에서 올라오므로 이 가지에 오지 않는다.
- `raycast` — `o.box` 면 `obb.rayBox` (X · Z · Y 슬래브 셋, 법선은 `boxHitNormal`). 원기둥과 같은 규약으로
  **원점이 이미 안이면 −1** 이다. `base` 는 상자 밑면 그대로다 (원기둥은 `position.y − 0.5` 를 쓴다).
- `getSurfaceY` / `getStandingObstacle` — 외접원이 아니라 `obb.boxContainsXZ` 로 **상자 단면**을 본다.
  안 그러면 벽 모서리 바깥 허공에 올라선다.
- `obstacleCoverage` — 일부러 **외접원 그대로**다. "이 자리가 대형 적에게 너무 어수선한가" 를 답하는 용도라
  과대평가가 안전한 쪽이다.

회전 규약은 하나뿐이다: `box.yaw` 는 수학 규약(로컬 +X → 월드 `(cos yaw, sin yaw)`)이고, 같은 상자를 그리는
메시의 Euler 는 **`-yaw`** 다 (three 의 Y 회전이 반대 손). 두 값이 어긋나면 보이는 벽과 막는 벽이 갈라진다.

### 지붕 — 무너뜨렸다
3인칭 카메라가 실내에서 천장에 갇히면 안 된다. 지붕 페이드 · 카메라 레이캐스트 특례 · 부분 지붕을 견주다
**무너진 지붕**을 골랐다: 남은 것은 서까래 몇 개 · 처마 두 조각 · 벽 위 난간뿐이고 **전부 콜라이더가 없다**.
카메라도 총알도 통과하고 실내는 하늘이 보이는 폐허가 된다 — 특례 코드가 0줄이고 설정에도 맞는다.
불시착 함선도 같은 이유로 **위가 찢겨 열린** 동체이고, 전차도 지붕 없는 무개차다.

### 지하실 · 키카드
`layout` 이 건물 밑에 회전한 사각 **구덩이**(벽에서 2.2 m 안쪽, 깊이 `basementDepth`)를 예약하고
`Terrain` 이 pad 평탄화 다음에 그것을 판다. 그 위를 덮는 것이 **천장 슬래브** — 밑면 `y0 − SLAB_T`,
윗면이 정확히 지상층 바닥인 뜬 상자 콜라이더들이고 계단 구멍만 빼고 깐다. 구덩이보다 `PIT_BLEND` 넓게
덮는다 (지형이 그 폭에 걸쳐 내려가므로 딱 맞게 덮으면 둘레에 도랑이 남아 실내를 걷다 빠진다).
구덩이 옆벽은 **콘크리트 라이닝 + OBB 콜라이더**다 — 지형만 믿으면 지하실 안에서 흙 경사를 타고 올라가
천장에 끼인다.

문은 **해치**다. 잠긴 동안 계단 구멍을 막는 얇은 상자 콜라이더(윗면 = 바닥 높이)라 그 위를 그냥 걸어
지나가고, 열리면 hash 에서 빠지면서 옆으로 미끄러진다. 흐름:

1. 지하실이 있는 구조물마다 지상층 컨테이너 중 **정확히 하나**가 `bonusDefId: 'key_basement'` 를 갖는다
   (시드 결정적). 지하실 안에는 절대 넣지 않는다 — 영영 못 여는 방이 된다.
2. 그 컨테이너를 열면 `ContainerSet` 이 `<맵 시드> ^ hash(id)` 로 굴린 상자 내용물 **앞에** 키카드를 얹어
   `inventory.openContainerItems` 로 채우고, **그 다음** `crate:open` 을 쏜다 — 캐시가 이미 있으므로
   상자 코드는 그것을 그대로 보여 주고 통계 · XP · 계약은 다른 상자와 똑같이 오른다.
   `items/` 에 `key_basement` def 가 없으면 조용히 빼고 나머지만 채운다 (문은 그대로 잠긴다).
3. 해치는 키카드가 없으면 **홀드 0** 이라 눌러 보면 바로 `keycard_deny` + `키카드가 필요하다` 토스트다.
   있으면 `STRUCTURE_UNLOCK_HOLD_S` 홀드 → 호스트 확정 → `structure:unlocked` + `keycard_use`,
   **연 사람의 키카드만** `consumeWhere` 로 사라진다. 호스트가 이미 열려 있다고 거절하면 요청자의 키카드는
   살아남는다.

### 컴퓨터 (행성 스캔)
구조물마다 콘솔 하나. `STRUCTURE_SCAN_HOLD_S` 홀드 → `ctx.world.fog.reveal(x, z, STRUCTURE_SCAN_RADIUS)` +
`structure:scanned` + `scan_pulse`. 구조물당 1회이고 호스트 권위(`structq scan` → `struct scanned`)다.

### 로그 강하의 "구역당 1회"
구역(구조물 · 플랫폼 · 전차)에서 **처음** 컨테이너를 열면 `structure:investigated {zoneId, kind, position}` 가
나간다. 그 순간 world/ 가 `zoneId` 를 `roguedZones` 에 넣고(구조물이면 `StructureDef.rogueDropUsed` 도)
**성공 · 실패와 무관하게** 소진으로 표시한다 — enemies/ 는 굴려서 실패한 구역을 와이어에 아무 것도 내보내지
않으므로, 그 기록이 없으면 호스트가 바뀐 뒤 새 호스트가 같은 구역을 다시 굴린다. 플랫폼은 `StructureDef` 가
아니므로 문자열 집합으로만 남고, `struct sync.rogued` 가 구조물 id 와 함께 통째로 실어 나른다.

### 선로 · 전차
`RAIL_CHANCE` 로 이번 맵에 선로가 있는지 정하고 `loop`(구역 외곽 순환) / `line`(가로 · 세로 왕복) 중 하나를
시드로 뽑는다. **선로는 지형을 평탄화하지 않는다** — 지형 높이를 4번 평활화한 뒤 `RAIL_DECK_Y` 만큼 띄우고
`PIER_STEP` 마다 교각으로 받친다 (평탄화하면 맵 한복판에 1 km 짜리 활주로가 생긴다). 평탄화하는 것은
플랫폼 패드뿐이고 그것은 `layout` 이 잡는다.

플랫폼은 데크(땅에서 올라오는 OBB) + 4단 계단 + 난간 + 컨테이너 4개 + 콘솔이다. 데크 윗면은 **전차 바닥과
같은 높이**이고 `PLATFORM_OFFSET` 은 `rail_platform.halfD + tram.halfW + 0.05` 다 — 틈을 넓히면 그 사이로
떨어진다 (발판 질의는 점 하나만 본다). 전차 옆판은 가운데 `TRAM_DOOR_HALF` 만큼 **양쪽 다** 비어 있다
(왕복 선로에서 전차가 뒤집혀 달리므로 플랫폼이 반대편에 온다).

전차의 진짜 상태는 **선로 위 진행거리 `s` 하나**다. 경로가 시드 결정적이므로 와이어에는 `s` · `dir` · 상태만
흐른다: 콘솔에서 `TRAM_START_HOLD_S` 홀드 → (클라이언트면 `tramq start`) → 호스트가 확정하고
`rail:tramStarted` + `tram_start`, 이후 `TRAM_NET_INTERVAL`(0.25 s) 마다 `tram state` 방송. 클라이언트는
자기도 `TRAM_SPEED` 로 굴리면서 받은 `s` 로 끌어당기고 `TRAM_SNAP_M` 넘게 벌어지면 그냥 맞춘다.
플랫폼 `DOCK_WINDOW` 안에 들어오면 `TRAM_DOCK_S` 정차(`rail:tramDocked` + `tram_dock`) 후 자동 재출발,
`line` 은 끝에서 방향을 뒤집는다 (**끝으로 달려들 때만** 뒤집는다 — 조건을 `s <= 0` 로만 두면 매 프레임
뒤집혀 제자리에서 떤다).

**플레이어는 실제로 실려 간다.** 전차의 바닥 · 옆판 · 운전실 콜라이더가 **같은 `THREE.Vector3` 하나**를
`Obstacle.velocity` 로 공유하고 `placeTram` 이 매 프레임 그 하나만 고친다. `player/PlayerController` 가
적분 직전에 `world.getStandingObstacle(x, z, feetY)?.velocity` 를 읽어 위치에 더하므로(2026-09-09, `c8f57a4`)
데크 위에 서 있으면 함께 간다. world/ 가 책임지는 것은 ① 데크 윗면을 정확히 돌려주는 `getSurfaceY` /
`getStandingObstacle`(= 상자 단면 판정), ② `velocity` 를 채우는 것, ③ `hash.move` 로 매 프레임 다시
버킷팅하는 것이다. 객실 컨테이너는 `ContainerSpec.dynamic` 이라 콜라이더 없이 같은 `Vector3` 를 따라간다
— `Interactable.position` 이 바로 그 객체라 달리는 중에도 조준이 따라붙는다.

### 파일 분할 규약
`Structures.ts` · `Rails.ts` 는 클래스이고, 폴더 공용 어휘는 `structures/model.ts` · `rails/model.ts` 에,
클래스에서 떼어낸 지오메트리 · 컨테이너 묶음은 `structures/parts/*.ts` 에 있다. `parts/` 는 시스템 파일에서
**타입만** 가져온다 (값은 `model.ts` 로 옮겼다). `Rails` 가 `structures/parts/Containers` 를 쓰는 것은
의도한 공유다 — 플랫폼 · 전차 컨테이너가 구조물 컨테이너와 **같은 물건**이어야 하기 때문이고, 반대 방향
(구조물이 rails 를 참조)은 없다.

### 알려진 한계 (구조물 · 선로)
- **같은 시드의 소품 · 상자 · 채집물 배치가 종전과 다르다.** 구조물 · 플랫폼 패드가 `padClearance` 에
  들어가고 벽 · 데크가 `hash.overlaps` 에 들어가기 때문이다. 멀티 결정성은 그대로다.
- `obstacleCoverage` 는 상자도 **외접원**으로 센다 (일부러). 벽 옆은 실제보다 어수선하게 계산되므로
  대형 적이 건물 바로 옆에 덜 스폰된다.
- 전차 **밑을 걸어서 지나갈 수 없다**. 바닥 콜라이더(밑면 = 바닥 − 0.3 m)와 `BOX_HEADROOM`(2.1 m)의 차가
  데크 높이(≈2.05 m)와 거의 같아 지상에 선 사람은 전차 바닥에 밀린다. 달리는 전차 밑은 어차피 설 자리가
  아니라 그대로 뒀다.
- 선로는 **맵에 하나**다 (`getRailLines()` 는 0 또는 1개). 전차도 선로당 한 대다.
- 전차 위에서 **적은** 아직 실려 가지 않는다 — `enemies/` 가 `getStandingObstacle(...).velocity` 를 읽어야
  하고 그 폴더는 이 배치의 소관이 아니다. 시체(`ctx.corpses`)도 마찬가지다.
- 구조물 컨테이너의 **문 애니메이션은 동기화하지 않는다.** 내용물은 `inventory/` 가 이미 동기화하므로
  아이템이 두 번 나오지는 않지만, 남이 이미 연 캐비닛의 문은 내 화면에서 닫혀 있다.
- 키카드가 든 컨테이너는 첫 개봉에 `inventory:containerOpened` 를 **두 번** 낸다 (`openContainerItems` +
  `crate:open`). 두 번째는 `first: false` 라 `meta/` 의 계약 카운터는 안전하지만, 이 이벤트를 새로 듣는
  쪽은 그 사실을 알아야 한다.
- 지하실 문이 열린 뒤에는 **적이 계단 구멍으로 떨어질 수 있다**. 나쁜 그림은 아니라 그대로 뒀다.
- 훈련장에는 구조물도 선로도 만들지 않는다 (`mode === 'training'` 에서 전부 빈 배열).


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

- **2026-09-09 (버려진 구조물 · 선로 · 전차)** — `Obstacle.box`(OBB) 를 world/ 에 들였다: `obb.ts` 신규,
  `SpatialHash.addBox` / `move`, `resolveCollision` · `raycast` · `getSurfaceY` · `getStandingObstacle` 의 상자 가지
  (원기둥 경로는 무변경). `Structures.ts` (+ `structures/model.ts` · `parts/Build.ts` · `parts/Containers.ts`) 로
  **버려진 전진기지 · 연구실 · 불시착 함선** — 들어갈 수 있는 폐건물, 무너진 지붕(카메라가 갇히지 않는다),
  지형을 파낸 **지하실**과 지상층 슬래브 천장, **항상 잠긴 해치 + 구조물마다 정확히 한 장인 키카드**,
  행성 스캔 콘솔(`fog.reveal`), 티어 루팅을 그대로 쓰는 컨테이너, `struct` / `structq` 호스트 권위.
  `Rails.ts` (+ `rails/model.ts`) 로 **순환 · 왕복 선로 · 플랫폼 · 전차** — 교각으로 높이를 맞춘 선로,
  걸어 올라가는 데크, 콘솔 시동 → 자동 주행 · 정차, `s` 하나만 흐르는 `tram` / `tramq` 동기화,
  `Obstacle.velocity` 로 **함께 실려 가는 데크**. `layout.ts` 가 부지 · 선로 계획을 먼저 잡고 `Terrain` 이
  구덩이를 판다. 수치는 `data/structures.csv` (신규). 검증: `scripts/smoke-structures.mjs` (신규).

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
