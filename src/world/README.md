# src/world — Procedural planet surface

Owner system: `WorldSystem` (publishes `ctx.world`, implements `WorldRef`).
Generates the whole map **synchronously** on `game:newMission {seed, mode?}` and emits `world:ready {seed, playerSpawn}`
(`mode: 'training'` → the 시뮬레이션 훈련장 of `TrainingArena.ts` instead of the planet, see the Phase 7 section);
tears everything down on `game:abort` and emits `world:cleared`. No asset files — all geometry, vertex colors and
textures are procedural.

| File | Responsibility |
|---|---|
| `WorldSystem.ts` | `GameSystem` + `WorldRef` implementation. Orchestrates generation order (terrain → nests → pads → outposts → **structures → rails → hazard** → props → crates → **gather** → ambience), owns the `SpatialHash`, and answers queries: `getHeightAt` (heightfield + extraction platform top), `getNormalAt`, `resolveCollision` (circle push-out + soft wall at ±(MAP_SIZE/2−4)), `raycast` (heightfield ray-march + analytic ray/cylinder vs obstacles — **2026-09-08** it shoots at `Obstacle.shotRadius / shotHeight` when a prop declares them, and the slab clip is complete: the old code tested only the entry point of the infinite cylinder plus the top cap, so a ray entering the footprint below the base and crossing the body further along reported a miss), `getEnemySpawnPoints`, `getExtractionPoints`, `getCrates`, `getNestPositions`, `getPlayerSpawn`, `getGatherNodes` (appended). Extra: `getBiome()`. **2026-09-09 (사각 콜라이더)**: `resolveCollision` · `raycast` · `getSurfaceY` · `getStandingObstacle` 가 `Obstacle.box` 를 만나면 `obb.ts` 로 갈라진다 — 원기둥 소품의 코드 경로는 한 줄도 바뀌지 않았다. `getStructures / structureAt / getRailLines / getTrams` 는 `Structures` / `Rails` 로 위임한다 (훈련장은 빈 배열). **2026-09-09 (환경 재해)**: `get hazard()` 가 `Hazard.ref` 를 돌려준다 — 후보 없는 행성 · 자리를 못 잡은 시드 · 훈련장이면 null. **2026-09-10 (올라설 수 있는 단은 벽이 아니다)**: `resolveCollision` 의 `o.box` 가지가 **윗면이 발 높이에서 `PROP_STEP_UP_MAX` 안인 상자를 밀어내지 않는다** — `getSurfaceY(x, z, feetY)` 의 천장과 같은 식이다. 움직이는 쪽의 규약이 "표면 먼저, 밀어내기 나중" 이라 그런 상자는 어차피 발밑으로 들어오는데, 밀어내면 **올라설 자리에 닿기 전에 밀려나** 영영 못 올라간다 (지하실 계단 · 플랫폼 계단이 그래서 막혔다). 원기둥 소품의 경로는 그대로다. **Phase 11**: `generate(seed, mode, planet)` — the 목표 행성 (from `game:newMission.planet`, else `ctx.missionPlanet`) is stored on `WorldRef.planet`, picks the biome by id and is echoed in `world:ready.planet`; an unknown id is reported as null. **2026-09-11**: `getSurfaceY` · `getStandingObstacle` · `resolveCollision` · `raycast` 에 `o.hull`(볼록 윤곽 · 층) · `o.ramp`(경사면 높이) 가지. `resolveCollision` 은 **작은 몸(`SMALL_BODY_R` 미만)** 에게 머리 위 여유를 제 크기(`2r`)만 주고 "올라설 수 있는 단" 예외를 주지 않는다 — 실내 수류탄이 천장판에 밀려 건물 밖으로 나가거나 난간을 뚫지 않게. `obstacleCoverage` 는 볼록 윤곽을 같은 넓이의 원으로 센다. `getLadders()`, 구조물 조명 풀에 플레이어 눈(없으면 카메라)을 넘기고, **상자 · 컨테이너 열린 모습 동기화**(`crate opened` 누구나 → 전원, 호스트가 `crate sync {ids}` 로 늦게 합류한 사람에게, `crate syncq` 요청)를 한다. **2026-09-11 (C 배치)**: ① `getStandingObstacle` 은 `PROP_TOP_MARGIN` 창 안에서 **`velocity` 를 든 발판이 높이보다 먼저**다(C-38 — 선로 발판과 전차 바닥이 같은 높이일 때 삽입 순서로 고정 발판이 이기던 동점, 코드는 리드). ② `getSurfaceMaterial(x, z, feetY?)`(C-22) — `feetY` 가 있으면 밟은 장애물(해시 질의 1회) → 탈출 착륙장 · 폐허 바닥판 concrete → 지형 띠, 훈련장 concrete, 표는 `surface.ts`. ③ `genTimings`(C-40) — 단계별 생성 ms. ④ `Fog.setOutposts`(C-11). |
| `noise.ts` | Seeded 2D simplex (`noise2`), 3D gradient noise (`noise3`), `fbm`, `ridged`, `billow`; `lerp/clamp/smoothstep` helpers. **2026-09-09 — `noise3` 의 `lerp` 인자 순서가 뒤집혀 있었다.** `lerp` 는 `(a, b, t)` 인데 `(t, a, b)` 로 넣어 세 겹의 보간이 `w + (a − w)·b` 로 쌓였고, 값이 `[-1, 1]` 이 아니라 **측정 `[-31.2, +52.6]`** 이었다. 쓰는 곳이 `build.displace` 하나뿐이라 지형(`noise2` 계열)은 멀쩡했지만 소품 정점 몇 개가 원점에서 10 units 씩 튕겨 나갔고, `Props.hullOf` 가 바운딩 박스로 콜라이더를 만들면서 그 정점 하나가 소품 전체를 감싸는 거대 원기둥이 됐다 (아래 `Props.ts`). 고친 뒤 범위 `[-0.91, +0.99]`. **2026-09-11 (C-66)** — `noise2` 를 V8 이 인라인할 수 있는 크기로 줄이고(`corner()` 분리) `fbm` · `ridged` 는 그 커널을 루프 안에 펴서 들고 있다, 기울기는 생성자에서 `gx` · `gy` 로 펴 뒀다. **값은 비트 단위로 그대로** — 연산 순서 · 피연산자를 바꾸지 않았다 (아래 `변경 이력` 의 C-66: 커널 사본 셋은 함께 고치고, 고친 뒤 옛 구현과 비트 비교를 돌린다). |
| `biomes.ts` | Five biome palettes (amber desert, frozen tundra, mossy swamp, ashen volcanic, crimson alien): terrain bands, prop colors, scatter density multipliers. `pickBiome(seed)` reproduces core's `new Random(seed).fork('atmosphere').pick(SKY_PALETTES)` draw so `BIOMES[i]` is always shown under `SKY_PALETTES[i]` (amber-dusk, cold-blue, toxic-green, rust-storm, pale-noon) and each palette is tuned to contrast with its fog color (`pairedSky`, `fogHint`). If core changes the palette count or fork label, the pairing silently degrades to "random but valid". **Phase 11**: `biomeById(id)` looks a palette up by `PlanetDef.biome`, so with a 목표 행성 the pairing is data instead of two matching draws; `pickBiome` stays the no-planet fallback. |
| `layout.ts` | Macro layout from the seed: spawn pad near an edge, 3 extraction pads (≥180 m apart, ≥150 m from spawn), 4–6 nest pads, 5–8 POI pads, craters, basins. `padClearance`, `nearestPad`. **2026-09-10 — 선로를 제일 먼저 잡고 나머지가 전부 피한다** (`railDistance` · `railClearance` · 내부 `railFree`): 선로의 자유도가 `line` = 방향 하나, `loop` = 반지름 하나뿐이라 패드를 다 뽑아 놓고 그 사이를 지나는 값을 찾는 것은 불가능하다. 그래서 2026-09-09 의 "크레이터 다음에 굴린다" 를 뒤집었다 — 그 대가로 **같은 시드의 매크로 레이아웃이 예전과 다르다** (멀티 결정성은 그대로). **2026-09-09**: `structures: StructureSite[]` (버려진 구조물 부지 + 지하실 구덩이 치수) 와 `rail: RailPlan | null` (`RAIL_CHANCE`, `loop`/`line`, 위상, 플랫폼 패드)이 붙었다 — 둘 다 **지형이 평탄화해야** 하는 자리라 매크로 단계에서 먼저 잡는다. 크레이터 · 분지를 다 뽑은 **뒤에** 굴리므로 그 앞의 추첨은 밀리지 않지만, 새 패드가 `pads` 에 들어가 `padClearance` 를 바꾸므로 **소품 · 상자 · 적 스폰의 자리는 달라진다** (건물 안에 바위가 서지 않게 하려면 그게 맞다). **2026-09-11**: `StructureSite.floors`(1 · 2, `upperChance`) — 루프 **맨 끝**에서 굴려 앞의 추첨을 밀지 않는다. |
| `Terrain.ts` | **2026-09-09**: pad 평탄화 **다음에** `layout.structures` 의 지하실 **구덩이**를 판다 — 회전한 사각형을 `PIT_BLEND`(1.6 m, `structures/model`) 폭에 걸쳐 `pad.height − depth` 까지 내린다. 그 폭만큼 흙이 비스듬해지므로 천장 슬래브는 구덩이보다 `PIT_BLEND` 넓게 덮어야 한다 (안 그러면 구덩이 둘레에 도랑이 남는다). Heightfield (417×417 verts, 2 m spacing, covers ±416 m incl. border mountains) from warped fBm + ridged noise + craters/basins + flattened pads + edge cliffs. 8×8 chunk meshes with vertex colors (biome bands by height/slope, AO, crater scorch, nest goo), procedural tiled detail albedo + normal `CanvasTexture`s. Fast bilinear `getHeightAt`, `getNormalAt`, `getSlopeAt`, adaptive ray-march `raycast`. **2026-09-11 (C-40, 결과 비트 동일)**: 높이장 루프가 줄마다 닿는 패드 · 구덩이만 훑고(`rowPads` · `rowPits`), 능선 가림막이 0 인 곳은 `ridged` 를 굴리지 않으며(0 × x = 0), 크레이터 · 분지는 제곱 거리로 먼저 거른다. 디테일 텍스처 두 장은 토러스 cos/sin 표(`torusTrig`)를 쓴다. `timings`(height · normals · colors · textures · chunks) 를 남긴다. |
| `SpatialHash.ts` | 16 m XZ grid of `ObstacleEntry` cylinders: `add/query/overlaps/walkSegment`. **2026-09-08**: `add(…, shot?)` also takes the **shot** cylinder (`Obstacle.shotRadius / shotHeight`) and bucketing / `maxRadius` use the larger of the two, so `walkSegment` never misses a prop whose shot cylinder reaches into a cell its collider does not. `query` still filters on `o.radius`, so movement collision is untouched. **2026-09-09**: `addBox(position, halfX, halfZ, yaw, height, kind)` 가 **사각(OBB) 콜라이더**를 넣는다 — `radius` 는 계약대로 외접원(`hypot`)으로 채우므로 버킷팅 · `overlaps` · `query` 는 예전 그대로이고 정확한 판정만 `WorldSystem` 에서 갈린다. `move(o, x, y, z, yaw?)` 는 움직이는 장애물(전차)을 옮기고 **덮는 셀이 바뀔 때만** 다시 버킷팅한다 (`TrainingArena.setTargetX` 와 같은 수법). **2026-09-11**: `addHull(position, hull, height, kind)` (외접원을 `radius` 로) · `addRamp(…, rise, kind)` · world 내부 플래그 `passRays` / `passSmall`(깨진 창틀). |
| `build.ts` | `BuildCtx` shared by sub-builders and geometry helpers: `isSpotFree`, `paint`, `paintGradient`, `displace`, `merge` (BufferGeometryUtils), `xform`, `composeMatrix`, soft particle texture. **2026-09-10**: `isSpotFree` 가 `railClearance` 도 본다 — 소품 · 상자 · 채집물 · 버섯 군락이 선로 회랑에 들어가지 않는다. **`ignorePads` 로도 못 끈다** (상자는 폐허 · 구조물 둘레 고리를 `ignorePads: true` 로 뿌리는데 그 고리가 선로를 가로지른다). |
| `Props.ts` | Jittered-grid + noise-cluster scatter into `InstancedMesh` variants (named `prop_<kind>`): boulders (also on border slopes), rock spires, fungal/dead trees, emissive crystal clusters (pulse), wind-swaying grass tufts (shader injection), pebbles, debris (crates/pod shells/panels). Collidable kinds (boulder, spire, tree, crystal, crate/pod debris) register obstacles; grass, pebbles and panels do not. **2026-09-09 — the movement collider is the drawn silhouette too.** `hullOf` used to size only the *shot* cylinder; the mover's cylinder was still a guess (`s*0.82 / s*1.3` for a boulder, `s*0.8 / s*4.2` for a spire that draws up to `1.5·s·4.2`, a flat `5*s` for every tree, `0.8s / 2.5s` for a crystal), which is why a rock you could see the top of was an invisible wall half a metre above itself and could never be stood on. Now **boulder / spire / crystal / debris pass the measured hull to both cylinders** and the height carries the instance's own `sy`. Two deliberate exceptions: a **tree** keeps the trunk radius (`0.5*s`) for both — a fungal cap is 2 m wide 3.5 m up, so a hull-wide cylinder would be an invisible wall at ground level and would stop bullets in open air — and only its *height* is measured; a **debris crate** is randomly yawed, so its XZ radius is the corner sweep (`√2 × half-width`) rather than the mean half-width. ⚠ **A seed's prop layout is no longer byte-identical to before this change**: `isSpotFree` tests `SpatialHash.overlaps`, which filters on `o.radius`, and a rejected spot skips the rest of that scatter callback's rng draws — so wider rock colliders shift the stream for everything scattered after them (and for crates / outposts, whose `isSpotFree` reads the same hash). Multiplayer determinism is untouched (every client runs the same code from the same seed); what is gone is only "seed 21 looks exactly like it did yesterday". **2026-09-09 (같은 날, 뒤늦게) — 그 실측 실루엣이 거짓말이었다.** `hullOf` 는 정직하게 바운딩 박스를 쟀지만 지오메트리에 `noise3` 버그로 튕겨 나간 정점이 섞여 있어서, 시드 21 에서 **첨탑 콜라이더가 반지름 최대 18.2 m · 높이 22.2 m** 로 부풀었다 (그려진 원뿔은 반지름 4 m). 걸어서 못 지나가는 보이지 않는 벽이자 총알이 허공에서 멈추는 원기둥이다. `noise.ts` 를 고치자 같은 시드에서 **최대 반지름 18.15 → 3.87 m**, `shotRadius − 실측 최대 반지름` 이 전부 ≤ 0 (콜라이더가 그려진 것을 넘지 않는다), 소품 위 여유 높이 최대 4.64 → 0.51 m 로 내려왔다. `hullOf` 자체는 그대로다 — 잰 값이 옳아졌을 뿐이다. **2026-09-10 — 바위 · 첨탑은 `hullOf` 가 아니라 `footprintOf` 로 잰다 (땅 위로 보이는 부분).** `hullOf` 는 메시 **전체**라 땅에 묻힌 적도(바위 `s×0.28` · 첨탑 `s×0.4` — 가장 넓은 둘레가 지하다), 경사지에서 묻힌 오르막 옆구리, `displace` 로 튀어나온 정점 하나까지 반지름에 넣었고, 실측하니 행성마다 바위의 **절반쯤이 보이는 바위보다 0.5 m 이상 앞에서 막았다**(한 방위 최대 3.9 m) — 폭풍 안개 속에서는 그대로 보이지 않는 벽이다. `footprintOf(ctx, geo, instanceMatrix, y)` 는 인스턴스 행렬로 정점을 월드에 옮겨 **지형 위 정점 + 삼각형 변이 지형을 뚫고 나오는 점**만 모으고(큰 바위는 변이 ~2 m 라 정점만 세면 가장자리보다 한참 안쪽이 된다), ① 그 윤곽의 XZ 바운딩 박스 중앙을 **중심**으로(경사지 바위는 보이는 부분이 내리막으로 몇 m 치우친다 — 원점 중심이면 오르막에서 ~3 m 앞에서 막았다), ② 그 중심에서 `FOOT_BINS`(32) 방위마다 가장 먼 점의 **평균**을 반지름으로, ③ 그려진 윗면을 높이로 삼는다. **이동 · 총알 원기둥 둘 다** 이 값이다(사용자 결정). 땅 위에 아무것도 없으면 콜라이더를 만들지 않는다. ⚠ 그래서 **바위 · 첨탑 `Obstacle.position` 의 XZ 는 인스턴스 원점이 아니다** — 경사지에서는 몇 m 옮겨져 있다 (`position.y` 는 여전히 인스턴스 원점 높이). 크리스탈 · 잔해는 `hullOf`, 나무는 줄기 반경 그대로다. **2026-09-11 — 원 하나가 아니라 볼록 윤곽이다** (`propHull.ts`, 사용자 결정): 바위 · 첨탑 · 크리스탈 · 잔해(상자 · 포드 껍질)가 `ctx.hash.addHull` 로 `Obstacle.hull` 을 건다. `footprintOf` 는 지웠다 — 방위 평균 반지름 원은 길쭉한 바위의 긴 쪽으로 파고들고 짧은 쪽에서 앞서 막았다. `position` XZ 는 이동 윤곽의 바운딩 박스 중앙, y 는 여전히 인스턴스 원점이다. 나무는 줄기 원기둥 그대로. |
| `Nests.ts` | Bug nests on nest pads: displaced organic mounds, glowing rim/holes (pulsing emissive), spikes, egg sacs, goo discs. Mounds are obstacles; `getHolePositions()` feeds `getNestPositions()`. |
| `Pads.ts` | Extraction platforms (concrete disc, seams, yellow/black hazard ring, H marker, 20 blinking edge lights, 4 light poles just outside the 14 m clear zone, one warm PointLight) and the spawn marker (scorch ring + green beacons). `PLATFORM_HEIGHT/RADIUS`. **2026-09-09**: 조명 기둥의 콜라이더가 `0.45 × 5.4` 한 덩어리였다 — 그려진 기둥은 반지름 0.2→0.12 뿐이라 기둥 옆이 보이지 않는 벽이고 총알도 먹었다. 이제 받침(`0.7 × 0.35`)과 기둥(`0.22 × 5.05`) 두 실린더다. |
| `Outposts.ts` | POI ruins: slab, broken wall segments, pillars, antenna mast with dish + blinking red beacon, rubble, barrels. Walls/pillars/mast are obstacles. **2026-09-09**: 안테나 마스트가 `0.8 × mastH`(8~11 m) 한 덩어리였다 — 그려진 기둥(반지름 0.1~0.22)의 네 배라, 마스트 옆을 못 지나가고 그 앞의 약탈자에게 쏜 총알이 허공에서 멈췄다. 이제 밑동 받침(`0.7 × 0.8`)과 기둥(`0.24 × mastH−0.8`) 두 실린더다. **2026-09-11 (C-11 · C-22)**: `getSites()` — 폐허 전초 목록(`OutpostSite {id: 'outpost_<i>', position, yaw, radius, slabHalfX/Z}`, 이미 뽑은 값만 적어 rng 를 더 쓰지 않는다). `Fog` 의 발견 판정과 발소리 재질(바닥판 = concrete)에만 쓴다 — **`getStructures()` 에 섞지 않는다** (들어가는 전진기지 `StructureKind 'outpost'` 와 다른 것이다). |
| `Crates.ts` | 20–40 loot crates: tiered body/lid geometry (beveled frame, stripes), blinking light, tier-4 beacon beam. Registers an `Interactable` per crate (radius 2.8, Korean prompts), lid tween (0.6 s), dust puff, `crate:open`, `audio:play crate_open`, `stats.cratesOpened`. **Placement (2026-09-10): 랜드마크 둘레에만** — 폐허 전초(POI)에 2티어 1 + 1티어 2, 버려진 구조물 벽 바깥에 3티어 1 + 2티어 1–2, 둥지 바깥 고리에 3티어 1. **허허벌판에는 하나도 없고 4티어는 이 파일이 놓지 않는다** (지하실 · 불시착 함선 안에만). Crates are obstacles (r 0.9). **2026-09-11**: 4티어 빛기둥(빔) 제거 (빛기둥은 시체에만), `def.opened` = **누가 열었든 열린 모습**이고 로컬 첫 개봉(통계 · 소리 · 먼지)은 `rolled` 로 가른다 — `setOpenListener` / `markOpened(id)` 로 월드가 `crate opened` 를 주고받는다. |
| `Gather.ts` | **채집물 (harvestable nodes)** — 약초 plants **and (2026-09-08) 고철 더미**, `GatherNodeDef.kind` telling them apart. `GATHER_NODES_PER_MISSION` (34) procedural herbs in 3 variants, placed in small clusters on gentle, unoccupied ground (`isSpotFree`, ≥ 7 m between clusters, 1.6 m inside one). Two `InstancedMesh` per variant (body + emissive glow part) → 6 draw calls total; the glow material pulses in `update`. Each node registers an `Interactable` (radius 2.2, `holdTime = GATHER_INTERACT_TIME / derived.interactSpeedMul` via a live getter, Korean prompt from the item def name). Harvest → node marked `harvested`, 0.42 s shrink-and-sink instance animation, `gather:collected {nodeId, defId, qty}` (qty × `derived.gatherYieldMul`), `audio:play gather`, then `ctx.inventory.tryAddItem`. Herb def ids are discovered from `ctx.loot.getAllItemDefs()` (`category === 'herb'`); a `FALLBACK_HERB_IDS` list keeps the plants in the world while `items/` has none. **Phase 11**: `build(ctx, game, eco)` takes the planet's ecosystem — the plant **shape** (`variant`) and the **herb it drops** (`defId`) are separate draws now (they used to be bound by `herbIds[variant % len]`), the herb is a weighted draw over `eco.herbs` per cluster (an id `items/` never registered is ignored) and the node count is `GATHER_NODES_PER_MISSION × eco.gatherDensity`; with no planet the old shape-bound pairing is used verbatim and no extra rng is consumed, so the layout is unchanged. **Multiplayer is host-authoritative** (same shape as pickups): clients send `harvq take` / `harvq sync`, the host answers `harv taken {id, by}` / `harv sync {nodes}` and also pushes a sync on `flow rejoined`. Only harvested ids travel — positions are seed-deterministic. A client's pending take expires after 3 s so a lost message never bricks a node. **Phase 9**: a non-host also re-requests the taken set on `net:hostChanged {isLocalHost:false}` (a promoted host never saw the old host's `harv taken` broadcasts as authority). **2026-09-08 — 고철 더미**: `SALVAGE_NODES_PER_MISSION` (7) more nodes of `kind: 'salvage'` in a 4th variant (`SALVAGE_VARIANT`, a crushed drum + bent plates + pipes in metal / rust with amber cut markers — biome colours are deliberately **not** used so a pile reads as metal on any planet). They are drawn **after** the plants from the same `gather` rng fork, so the herb layout for a seed is byte-identical to before; one is tried near each `ctx.layout.pois` (ring 5–14 m) and the rest go in the open, ≥ 12 m apart and ≥ 5 m from any plant. Each yields `mat_scrap` (qty 1, 30 % 2 — ≈ 9 per mission if every pile is stripped), holds for `SALVAGE_INTERACT_TIME` (3 s) inside radius 2.6, prompts `폐금속 해체 (E)`, **ignores `derived.gatherYieldMul`** (that is a 원예 stat) and carries `kind` in `gather:collected` so `progression/` grants 제작 XP instead of 원예. Placement, interaction, the shrink animation and the whole `harv` / `harvq` host authority are the plants' code unchanged. **2026-09-09 — 거대 버섯 군락의 채집 버섯**: `build(ctx, game, eco, groves)` 의 네 번째 인자가 `Hazard.getGroveSpots()` 다. 군락마다 `GROVE_PICKS_MIN`~`MAX` 개의 포자균 갓(변종 1)을 `GROVE_PICK_RING_MIN`~`MAX` 고리에 심는다 — 종류는 약초 무리와 같은 규칙으로 군락당 하나이고, **약초 · 고철 배치가 전부 끝난 뒤에** 뽑으므로 앞의 rng 스트림이 밀리지 않는다 (고철 더미가 쓴 수법 그대로). 변종 1 의 `InstancedMesh` 용량만 `groves.length × GROVE_PICKS_MAX` 만큼 늘어난다. **2026-09-11 (C-20) — 고철 더미 부가 코어**: 수량 확률이 csv 로 옮겨졌고(`GATHER_SALVAGE_QTY2_CHANCE` 0.3 · `GATHER_HERB_QTY2_CHANCE` 0.25 — 같은 값이라 배치 · 수량이 그대로), 고철 더미마다 `GATHER_SALVAGE_CORE_CHANCE`(0.15)로 구동 코어(`mat_core` × `GATHER_SALVAGE_CORE_QTY`)를 **생성 때** 정해 world 내부 `Node.bonus` 에 둔다. 굴림은 **자기 fork `gather_core`** 라 `gather` 스트림(yaw · scale · 수량)을 밀지 않는다. 수확하면 `tryAddItem` 을 한 번 더 할 뿐 `gather:collected` · 소리 · 제작 XP 는 1회다. 와이어 없음 (시드 결정적). 스모크용 `debugBonusOf(id)`. **2026-09-11 (온실 개편) — 토양 더미**: `SOIL_NODES` 가 아니라 **행성**이 개수를 정한다 (`data/planets.csv` 의 `soilNodes`), 종류는 `soils` 가중치 추첨(`world/soil.ts`). 변종 `SOIL_VARIANT`(4) = 파 놓은 흙 무더기 + 흙덩이 + 발광 띠 · 표식 막대이고, 정점 색은 **명암 램프뿐**이라 진짜 흙색은 속성별 `instanceColor`(`SOIL_TAG_COLOR` — 재배 화면과 같은 표)가 곱해져 나온다. 그래서 본체 재질만 `soilMat` 으로 갈라 뒀다 (인스턴스 색이 붙은 메시는 셰이더 프로그램이 다르다 — 약초 · 고철까지 갈리면 선컴파일이 헛돈다). 배치는 **저지대 우선**(`layout.basins` 안을 24번 먼저, 못 잡으면 개활지 120번), 흙더미끼리 `SOIL_SPACING` 14 m · 다른 노드에서 5 m · 최대 경사 0.24 · `isSpotFree` 라 선로 회랑(`RAIL_CLEARANCE_M`)에는 서지 않는다. **지오메트리 · 배치 · yaw · scale · 종류를 전부 자기 fork `gather_soil` 에서 굴린다** — 행성마다 다른 흙더미 개수가 `gather` 스트림을 밀면 같은 시드의 약초 · 고철 배치가 통째로 달라진다 (`gather_core` 와 같은 수법). 프롬프트는 `<이름> 채취 (E)`(약초 채집 · 고철 해체와 한 단어로 갈린다), 집는 시간은 고철과 같은 `SALVAGE_INTERACT_TIME`(전용 상수 없음 — 아래 `변경 이력`), 수량은 한 더미에 1 포대 고정이고 **채집 수율(원예)은 곱해진다**(XP 도 원예 — `progression/` 은 한 줄도 안 바뀌었다). 노드 id 는 `soil_<n>`, 와이어 없음(수확만 기존 `harv`/`harvq`). 행성이 없으면(훈련장 · 모르는 id) 한 더미도 서지 않는다. |
| `TrainingArena.ts` | **시뮬레이션 훈련장** (Phase 7): the world built for `game:newMission {mode:'training'}` instead of the planet. Flat `TRAINING_ARENA_SIZE` (64 m) deck with a procedural CanvasTexture grid, four walls with ribs + corner pillars, a ceiling at `ARENA_CEILING` 7 m with 15 emissive light panels, cyan wall bands / lane edges, an amber firing line at z +20 and amber distance marks, spawn ring at (0, 0, 26) ("south", the player faces −Z). 3 lanes (x −10 / 0 / +10) × `TRAINING_TARGET_COUNT` / 3 rows of **pop-up targets**: post + hinged board (silhouette + rings CanvasTexture, resting emissive so they read at 40 m), each an `ObstacleEntry {kind:'target', radius 0.42, height 2.1}` in the world hash with a `DestructibleRef` (`training_target_<i>`, hp `TRAINING_TARGET_HP`) — weapons hit them through the ordinary `raycast → obstacle.destructible.onDamage` path (Phase 3 cover). A hit flashes the board + a small additive ring; at 0 hp the board hinges to the floor (0.28 s, the entry leaves the hash so shots pass), `hit_metal` low, and it rises again `TRAINING_TARGET_RESPAWN_S` later (hp reset, entry re-inserted). Counters `hits` / `knockdowns` → `ui:objective {text:'시뮬레이션 훈련장 · 출구 콘솔로 종료', subText:'명중 n · 격추 m'}` on every change. **Three consoles** along the south wall, one pedestal each (`buildConsole(name, x, lines, accent)`: pedestal + tilted emissive screen + floor halo, obstacle r 0.6): **출구** at x −8 (`Interactable 'training_exit'`, prompt `훈련 종료`, one `training:exitRequested` per second), **모드 콘솔** at x +8 (`'training_mode'`, prompt `표적 모드: <라벨>` → cycles 고정 → 이동 → 타임 코스; in 타임 코스 the next E reads `타임 코스 시작` and starts a run, `타임 코스 진행 중 · n초` while one runs; its screen is repainted in place with `redrawScreen`) and the **무기 거치대** at x +14 (`'training_rack'`, prompt `무기 거치대` → `ctx.inventory.openCatalog({category:'primary'})` — the 무한 상자 on its 주무기 tab; game/'s training exit restores the old loadout afterwards) with a merged wall rack of four silhouetted guns behind it as dressing. **Target modes (Phase 9, `TrainingRef`)**: `mode / setMode / score / hits / remaining / bestTime / startCourse / resetScore`, published as `ctx.world.training`. `static` 고정 = the Phase 7 behaviour; `moving` 이동 sweeps each target **±`TRAINING_MOVING_SPAN`** (a **half**-width, 3.2 m either side of the lane centre — 3.2 + the 0.42 m target radius stays inside `LANE_HALF_W` 4) at `TRAINING_MOVING_SPEED` with a `TRAINING_MOVING_PAUSE_S` pause at each end (`setTargetX` moves the mesh **and** the hash entry, re-bucketing only when the entry's cells change, so shots keep hitting the board where it is drawn); `timed` 타임 코스 = knock `TRAINING_COURSE_TARGETS` targets down inside `TRAINING_COURSE_TIME_S` (every knock-down emits `training:scored {score, hits, index}`; finishing or timing out emits `training:courseFinished {time, score, completed, best}`, arms a `TRAINING_COURSE_COOLDOWN_S` cooldown and, on a completion, saves a new best to localStorage `TRAINING_BEST_STORAGE_KEY`). `setMode` is refused while a course runs, emits `training:modeChanged`, resets the score and parks the targets back on their `baseX`. The objective sub-text now reads `<모드> [· n/m · 남은 n초 | · 최고 n.n초] · 명중 n · 격추 m`. Everything here is **client-local** — no wire messages. Queries: `raycastShell` (floor / ceiling / 4 wall planes, writes the normal), `clampInside` (hard wall clamp), `isInside`. No lights: the arena is shown in the atmosphere's **space mode** (black background, no fog, cool key light) plus a little emissive on the deck / hull. `dispose()` unregisters the console, empties the hash entries and disposes every geometry / material / texture. |
| `Ambience.ts` | 900 additive spore points drifting in a box around the camera (wrapping) with a custom `ShaderMaterial` (perspective size clamped to 1–6 px, fade-in 1.5–6 m from camera, far fade, fog-aware, twinkle); 14 slow dust sprites. |
| `Fog.ts` | **전장의 안개** (2026-09-09, `FogRef`, published as `ctx.world.fog`; **null in a training**). One `MAP_SIZE / FOG_CELL_M` square `Uint8Array` (80² at cell 8 m) is the single source of truth and **a cell once lit stays lit for the whole raid**. Every `FOG_UPDATE_HZ` (5 Hz) it paints `FOG_REVEAL_RADIUS` (55 m) around the local player **and every live remote squadmate** (`ctx.net.getRemotePlayers()`, skipping `!inMission` / dead / gone refs) — the squad's sight is shared, and because everyone already reads the same 20 Hz `ps` snapshots **there is no new wire in normal play**. Only a late joiner asks (`fogq sync` → the host's `fog sync {mask}` = `serialize()`, the mask bit-packed to 800 B and base64'd); `flow rejoined` pushes the same, and a client re-requests on `net:hostChanged {isLocalHost:false}`. `fog:revealed {revision, explored}` fires **only on a tick where the mask actually grew**, never per frame, so the map can cache its layer. The same tick runs the **발견 게이트**: extraction consoles, nest holes, crates, gather nodes and (2026-09-09) **버려진 구조물 · 선로 플랫폼** that fall into a lit cell emit `fog:discovered {kind, id, position}` once, and the two landmark kinds (신호소 · 둥지) also raise a short `ui:notify` — **`structure` · `rail` 은 일부러 토스트를 띄우지 않는다**, 그 둘은 `ui/hud/RaidAlerts` 가 소유하므로 여기서도 띄우면 두 번 뜬다. `WorldSystem` pre-lights `FOG_REVEAL_RADIUS` around the player spawn (the drop point is not a discovery) and disposes the whole thing in `clear()`. **2026-09-11 (C-11)**: **폐허 전초**도 발견한다 — `setOutposts(Outposts.getSites())` 로 받은 목록이 밝혀지면 `fog:discovered {kind:'outpost', id:'outpost_<i>'}` + 토스트 `폐허 전초 발견`(예전 문구 `전초기지 발견` 은 들어가는 전진기지와 헷갈렸다). 지도(`ui/map/MapScreen`)가 그 이벤트를 쌓아 아이콘을 그린다. 늦게 합류한 사람은 `fog sync` 뒤 다음 판정에서 다시 받는다 — 와이어 없음. |
| `Hazard.ts` | **환경 재해** (`HazardRef`, 게시: `ctx.world.hazard`; **훈련장 · 후보 없는 행성에서는 null**). 종류 · 시작 시각 · 도형이 전부 **미션 시드 + `missionTime` 의 함수**라 평상시 와이어가 없다 — 늦게 합류한 사람만 `hzq sync` → 호스트의 `hz sync {data}`(= `serialize()` = 계획 JSON). 예고(`hazard:announced`) · 시작(`hazard:started`) · 진행도(`hazard:progress`, `PROGRESS_EMIT_S` 0.4초마다) · 출입(`hazard:insideChanged`, **바뀔 때만**) · 피해(`HAZARD_TICK_S` 마다 `HAZARD_DPS × HAZARD_TICK_S`) · 시야(`atmo:override` **하나로만**) · 군락 발견(`fog:discovered {kind:'grove'}`, 토스트 없음)을 여기서 낸다. `getGroveSpots()` 로 `Gather` 에게 군락 자리를 넘긴다. **2026-09-11 (C-14 · X-7)**: 권위(싱글 · 호스트)가 **로컬과 따로 도는** `HAZARD_TICK_S` 틱마다 `net.getRemotePlayers()` 중 `suspended` · `inMission` · 살아 있는(고스트 상태 ≠ 2) 분대원이 구역 안이면 `ghost:damage {id, amount}` 를 낸다 (`tickGhosts`) — 끊긴 사람의 몸이 폭풍 속에서 멀쩡하던 것. 적의 조용한 DoT 는 `enemies/` 가 `ctx.world.hazard.isInside` 로 스스로 한다. |
| `hazard/model.ts` | 재해가 공유하는 어휘. **`data/hazards.csv` 를 읽는 유일한 자리** (색 · 입자 밀도/크기/속도 · 벽 색/높이/두께) + `HazardPlan` · `SporeSource` 타입 + 거대 버섯 군락 치수 + `pickStartSeconds` (30초 단위 절단) + `isFrontKind`. THREE 를 **값으로 쓰지 않는다** — `scripts/data-check.mjs` 의 `DATA_OWNERS` 가 이 모듈을 아주 이르게 읽는다. |
| `hazard/parts/Plan.ts` | **추첨**. 후보(`PlanetDef.hazards`)에서 종류 하나, 시작 시각(포자만 `SPORE_START_S` 고정), 전선 방향 · 폭풍의 눈 중심 · 포자 발생지. `planGroveSpots` 는 **전용 fork** 라 종류 추첨이 군락 자리를 밀지 않는다. `coverRadius` 가 33² 격자로 **맵의 어느 점이든 가장 가까운 발생지까지의 거리**를 실제로 재서 `sourceRadius` 를 잡고, 늦게 피어오르는 발생지는 `growthMps` 를 올려 `HAZARD_FULL_S` 안에 다 자라게 한다. |
| `hazard/parts/Zones.ts` | 계획 + `missionTime` → **도형**. `front` 는 −span → +span (span = 맵을 법선에 투영한 반폭 + `FRONT_MARGIN`), `storm_eye` 는 `STORM_EYE_RADIUS_START→END` 선형 축소, `spores` 는 피어오른 발생지마다 원. 배열도 도형 객체도 재사용하므로 프레임당 할당이 0이다. `zoneDepth` / `maxDepth` 가 `isInside` 와 경계 페더 둘 다를 답한다. |
| `hazard/parts/Grove.ts` | **거대 버섯 군락** — 줄기 · 갓 · 발광하는 갓 밑면 · 밑동 통풍구를 절차로 세워 두 메시(본체 · 발광)로 병합한다. **콜라이더는 줄기뿐이다** (갓은 4~9 m 상공에 있다 — `Props` 의 나무와 같은 이유). 발광 세기만 `update` 에서 맥동한다. |
| `hazard/parts/Visuals.ts` | **표현**: 카메라를 따라다니며 감기는 입자 구름(`Ambience` 가 본보기, 구역 밖에서는 그리지 않는다) + 경계에 서는 벽 (`front` = 전선을 따라 `frontBandM` 두께로 겹친 커튼 3장, `circle` = 열린 원통). 커튼 텍스처는 절차 `CanvasTexture` 이고 시간에 따라 흐른다. |
| `obb.ts` | **사각(OBB) 콜라이더** 수학 (2026-09-09, `Obstacle.box`). `boxRadius` (버킷팅용 외접원) · `boxContainsXZ` (윗면 판정) · `boxPushOut` (원 vs 상자 밀어내기, 중심이 안이면 가장 얕은 면으로) · `rayBox` (슬래브 셋 + `boxHitNormal`) · `BOX_HEADROOM`. **`o.box` 가 있을 때만 불린다** — 원기둥 경로는 그대로다. 회전 규약: `box.yaw` 는 수학 규약(로컬 +X → 월드 `(cos, sin)`)이고 같은 상자를 그리는 메시의 Euler 는 `-yaw` 다 (three 의 Y 회전이 반대 손). **2026-09-11**: `rampTopAt` · `rayRamp`(쐐기 = 반공간 6 장) 추가, `BOX_HEADROOM` 값은 `data/constants.csv` (player 의 천장 클램프와 같은 값). |
| `Structures.ts` | **버려진 구조물** — 전진기지 · 연구실 · 불시착 함선. 건물 세우기, 컴퓨터(행성 스캔) · 지하실 해치 상호작용, 컨테이너 배치, `struct`/`structq` 호스트 권위, `getDefs` / `structureAt`. 지하실 해치는 **잠긴 동안 계단 구멍을 막는 상자 콜라이더**이고 열리면 hash 에서 빠지며 옆으로 미끄러진다. 로그 강하의 "구역당 1회" 기록(`roguedZones`)도 여기 있다. **2026-09-11**: 해치 → **지하 계단 복도 끝의 서 있는 문**(`buildDoor`, 문짝 콜라이더 `door`, 옆으로 밀려 열린다), 콘솔은 **옥상 맵 스캐너**(불시착 함선은 없음, 누르면 모두의 화면에 `ScanWave`), **사다리** `Interactable` 발치 · 꼭대기 → `ladder:grab`(`getLadders`), **창문**(`GlassSet`, 깬 클라이언트가 `struct glass` 를 보내고 `sync.glass` 에 실린다), **구조물 광원 풀**(`LightPool` `STRUCTURE_POINT_LIGHTS` 4개, 구조물이 없어도 만든다 — 레이드의 점광원 개수를 맵마다 같게), 열린 모습 동기화 위임(`setOpenListener` · `markContainerOpened`). |
| `structures/model.ts` | 구조물 · 선로가 공유하는 어휘. **`data/structures.csv` 를 읽는 유일한 자리** (개수 · 크기 · 컨테이너 수 · 지하실 확률/깊이 · 상자 티어 가중치) + 건물 치수 상수(`WALL_T` · `DOOR_W` · `STAIR_HALF` · **`STAIR_RISE_MAX` · `STAIR_TREAD_MIN`** · `SLAB_T` · `PIT_BLEND` · **`FLOOR_OVERHANG` · `FLOOR_LIP`** · `CONTAINER_RADIUS`) + `pickTier`. **2026-09-10**: `data/constants.csv` 의 **`RAIL_CLEARANCE_M`** 도 여기서 읽는다 — 정식 주인은 `shared/constants.ts` 지만 그 배치가 `src/shared` 를 건드리지 않기로 돼 있었고, 이 모듈이 이미 `DATA_OWNERS` 라 `data:check` 의 "아무도 읽지 않는 키" 에 걸리지 않는다 (나중에 한 줄 옮기면 된다). THREE 를 **값으로 쓰지 않는다** — `layout.ts` 와 `scripts/data-check.mjs` 가 아주 이르게 읽는다. |
| `structures/parts/Build.ts` | 건물 지오메트리 + 콜라이더. `buildBuilding` (벽 · 문틀 · 격벽 · **무너진 지붕** · **계단 구멍을 도려낸 지상층 바닥판 네 조각** · 구덩이 라이닝 · 계단 · 해치 자리 · 컨테이너/콘솔 자리), `buildWreck` (동체 데크 · 옆판 · 후미 램프 · 기수 · 날개 · 나셀). 벽 하나 = 상자 하나이고 그린 `BoxGeometry` 와 **같은 수**를 콜라이더에 쓴다. **2026-09-10 — 바닥판(`floorPlate`)이 그리는 판이자 서는 판이다**: 발자국 + `FLOOR_OVERHANG` 까지 덮고 콜라이더 윗면이 정확히 `y0`, 밑면이 `y0 − SLAB_T` 라 그대로 지하실 천장이다. 예전의 "그린 바닥(콜라이더 없음) + 좁은 천장 슬래브(콜라이더만)" 두 겹은 사라졌다 — 넓이가 달라 그 사이 띠에서 꺼진 지형을 밟던 것이 문턱 버그였다. 계단 치수(`stairSteps`/`stairTread`)도 구멍 길이보다 **먼저** 푼다. **2026-09-11 전면 개편** — 아래 `## 2026-09-11` 절: 층마다 천장 · 무작위 2층 · 실내 계단 · 옥상(난간벽 · 해치 · 사다리) · 창문 · 컨테이너 있는 방마다 조명 자리 · 지하실 방(바닥판 · 계단 복도 · 층계참 · 서 있는 문) · 옥상 스캐너 자리. 격벽 자리를 여러 번 굴려 계단 방 길이 · 지하 계단 구멍 · 구덩이 제약을 한꺼번에 만족시킨다. |
| `structures/parts/Containers.ts` | 구조물 · 플랫폼 · 전차 안의 **상호작용 컨테이너** (`ContainerSet`). 새 루팅 경로를 만들지 않는다 — 열면 `crate:open {crateId, tier, position}` 을 쏘고 `inventory/` 의 상자 코드가 티어 롤 · 캐시 · 동기화 · 감정 XP · 계약 카운터를 전부 한다. 더하는 것은 실루엣 3종과 두 규칙뿐: 구역에서 **처음** 열면 `structure:investigated`, `bonusDefId`(지하실 키카드)가 있으면 `openContainerItems` 로 먼저 채우고 그 다음 `crate:open`. `dynamic` 스펙은 콜라이더 없이 매 프레임 따라 움직인다 (전차 객실). **2026-09-11**: 열린 모습(`opened`)과 로컬 첫 개봉(`rolled` — 키카드 채우기 · `structure:investigated`)을 갈랐다. 남이 먼저 열어도 내 캐시에는 키카드가 없으므로 내 첫 개봉에서 채워야 한다. `markOpened` · `isOpened` · `setOpenListener`, 열리면 램프가 꺼진다. |
| `Rails.ts` | **선로 · 플랫폼 · 전차의 수명 · 상태 기계 · 멀티**. 중심선(지형 높이 평활화 + `RAIL_DECK_Y` + **지형 최고점 실측 부양**) 계산, `rails/parts/*` 호출, 전차 상태 기계(`idle` ↔ `moving` ↔ `docked`, **2026-09-10: 정차 뒤 자동 재출발 없음 — `idle` 로 내려앉아 운전실 콘솔을 기다린다**), **운전실 콘솔 · 플랫폼 호출 콘솔 `Interactable` 등록**(**2026-09-10: 호출 = 목적지를 정한 시동 — `applyStart` 로 합류하고 목적지는 요청자 위치에서 읽는다 `targetSFor`, 운행 중 중복 호출은 홀드 0 + 거부**), 발광 콘솔 메시 병합, `tram`/`tramq` 호스트 권위, `getLines` / `getTrams`. **선로는 지형을 평탄화하지 않는다** — 교각이 높이를 맞춘다. 지오메트리는 한 줄도 없다. **2026-09-11 (C-39)**: 호출이 수락되면 **부른 콘솔 자리에서 이 클라이언트에만** `tram_call` 차임(클라이언트는 낙관적), 부를 수 없으면 `tram_deny` (예전에는 `keycard_deny` 를 빌려 썼다). 소리 정의는 `audio/`. |
| `rails/model.ts` | 선로 · 전차가 공유하는 **어휘**. `RailPath` (`makePath` · `wrapS` · `sampleAt` · `nearestS` · `deltaS`) + `RAIL_DECK_Y`(0.75) · `TIE_STEP`(1.8) · `PIER_STEP`(9) · `GAUGE_HALF` · `RAIL_DECK_STEP`(**2026-09-10: 5 → 3**) · `RAIL_DECK_T` · `RAIL_DECK_HALF_W` · `RAIL_MAX_GRADE` · `DOCK_WINDOW` · `TRAM_NET_INTERVAL` · `TRAM_SNAP_M` · `PLATFORM_OFFSET`, **차체 치수(`TRAM_FLOOR_UP` · `TRAM_DOOR_HALF` · `TRAM_WALL_*` · `TRAM_NOSE_T` · `TRAM_CAB_LEN` · `TRAM_DESK_*`) · 색(**2026-09-10: 호출 콘솔 발광 `CONSOLE_GLOW` · `CONSOLE_GLOW_BASE`**) · `RailBuild`(**`glow` 채널 = 발광 조각을 모아 한 메시로 합친다**) · `MovingPart` · `TramInst`**(2026-09-11: `hitCooldown` 숫자 → 대상별 `hitUntil` 맵). **축 규약이 여기 적혀 있다: 로컬 +X = 진행 방향(길이), 로컬 +Z = 좌우(폭).** |
| `rails/parts/Track.ts` | 침목 · 레일 토막 · 교각 지오메트리 + 교각 콜라이더 + **걸어 다니는 선로 발판 상자**(`RAIL_DECK_STEP` 마다). |
| `rails/parts/Platform.ts` | 플랫폼 데크(땅에서 올라오는 OBB) · **계단**(2026-09-10 개편 — 단수를 `RAIL_STAIR_MAX_RISE` 에서 뽑는다) · 난간 · 컨테이너 · **「전차 호출」 콘솔**(2026-09-10 — 예전 안내판 자리, 받침 · 몸통 · 기울어진 화면 · 버튼 · 발광 띠. 발광 조각은 `RailBuild.glow` 로 넘기고 **콘솔 자리를 돌려준다** — `Interactable` 등록은 `Rails`). **2026-09-11**: 계단 콜라이더는 단마다 상자가 아니라 `Stairs.buildStairFlight` 의 경사면 하나(데크 안으로 0.08 m 겹친다)다. |
| `rails/parts/Tram.ts` | 전차 차체(**진행 방향으로 길쭉**) · 앞 격벽 + 걸어 들어가는 **운전실** · **운전 콘솔 데스크** · 콜라이더(`Obstacle.box` + 공유 `velocity`) · 객실 컨테이너 · `placeTram`(매 프레임 배치) · **`updateTramHit`(고속 충돌 피해 + 넉백)**. **2026-09-11 (C-18)**: 로컬 플레이어(각자) + **권위에서 적 · 끊긴 분대원**. 적은 `ctx.enemies.queryNear` → 같은 OBB · 높이 창 → `EnemyManagerRef.pushBack`(그 적 하나에 방향) + `takeDamage(…, 'ai')`, 고스트는 `ghost:damage {kb}`. ~~데크 윗면 − `RIDE_FOOT_DROP` 위의 적은 탑승자라 치지 않는다~~ → **2026-09-11 (C-63)**: 셋 다 위 경계가 `바닥 − TRAM_HIT_FLOOR_CLEAR` 로 같고, 그 밑 `RIDE_FOOT_DROP` 띠는 새 `riderExempt`(차체 단면 + `RIDE_EDGE_MARGIN` 안 + 발밑 발판이 이 전차이거나 비어 있음)만 빼 준다 — **선로 발판 위의 적이 치인다**. 적 탑승 상태를 묻지 않는 것은 그대로(발밑은 월드가 본다). 쿨다운은 대상별(`hitUntil`), 소리는 `tram_hit`. |
| `hull.ts` | **볼록 다각형 기둥 수학** (2026-09-11, `Obstacle.hull`). `convexHull2D`(monotone chain, 반시계, `HULL_MAX_VERTS` 14 로 넓이를 가장 적게 잃는 꼭짓점부터 뺀다 — 밖으로 부풀리지 않는다) · `hullRadiusFrom`(외접원) · `hullAreaCentroid` · `hullContainsXZ` · `hullPushOut`(가장 얕은 변으로 · 바깥이면 정확한 최근접점) · `rayHull`(Cyrus–Beck + Y 슬래브, 원점이 안이면 −1) · `hullHitNormal`. **`o.hull` 이 있을 때만** 불린다. **2026-09-11 (C-40)**: 정렬이 `Array.prototype.sort(비교 함수)` 에서 재사용 `Int32Array` 위의 퀵 · 삽입 정렬(`sortIdx`)로 — (x, z) 사전순만 같으면 껍질 좌표가 같다(같은 좌표끼리의 순서는 외적 0 으로 빠진다). |
| `propHull.ts` | 소품 인스턴스 하나의 **볼록 콜라이더**를 그려진 메시에서 잰다 (2026-09-11). 땅 위 정점 + 삼각형 변의 지형 교차점으로 ① **이동 윤곽**(지면 ~`PLAYER_HEIGHT + 0.4` 까지 — 머리 위로 기운 크리스탈 조각이 바닥에 벽을 세우지 않는다) ② **총알 층**(보이는 높이를 1.4 m 안팎으로 최대 4 층, 층마다 윤곽 — 위로 좁아지는 첨탑 옆 허공에서 총알이 멈추지 않는다, 낮은 소품은 층 없음)을 만든다. 전부 묻혔으면 null. **2026-09-11 (C-40)**: `getX` · `index.getX` 대신 배열 직접 읽기, 층 루프의 변마다 만들던 `[lo, hi]` 배열 제거 (값 동일). |
| `surface.ts` | **발밑 재질** (2026-09-11, C-22 — `WorldRef.getSurfaceMaterial` 의 표와 지형 규칙). `KIND_MATERIALS`(장애물 kind → 재질: 바위 rock · 크리스탈 crystal · 선로/전차/상자/컨테이너/문/잔해 metal · 구조물 바닥/벽/계단 · 폐허 벽 concrete · 둥지/나무/군락 organic, 구조물 바닥이라도 불시착 함선이면 metal) · `BAND_MATERIALS`(바이옴 지형 띠 → 재질: amber sand/dirt · tundra snow/dirt · mossy moss/mud · ashen ash · crimson organic) · `terrainMaterial`(`Terrain.computeColors` 를 뒤에서부터: 둥지 점액 15 m → 크레이터 그을림 ash → 경계 절벽 · 경사 > 0.3 rock → 고지 → 저지 → 얼룩 `ground2` → 바닥, 같은 잡음 `n1`) · `onOutpostSlab`. 할당 없음, THREE 는 타입만. |
| `structures/parts/Stairs.ts` | **계단 한 줄** (2026-09-11): 단은 그림(밑면에서 올라오는 덩어리), 밟는 것은 **경사 콜라이더 하나**(`SpatialHash.addRamp`). 경사면은 디딤판 한가운데를 잇고 위 · 아래 끝이 두 층 바닥과 정확히 만난다. 지하실 · 1→2층 · 선로 플랫폼이 같이 쓴다. |
| `structures/parts/Glass.ts` | **창문 유리** (2026-09-11). 맵의 유리 전부가 `InstancedMesh` 하나, 한 장 = 얇은 상자 콜라이더(`fragile` + `destructible`). 깨지면 인스턴스를 접고 콜라이더는 hash 에 **남긴 채** `passRays`(레이 무시) + `passSmall`(반지름 `SMALL_BODY_R` 0.25 미만 = 투척물은 밀지 않음)로 바꾼다 — 사용자 결정 "깨져도 사람은 못 드나든다". |
| `structures/parts/ScanWave.ts` | **옥상 맵 스캐너 파동** (2026-09-11). 스캐너 자리에서 맵의 가장 먼 모서리까지 `STRUCTURE_SCAN_WAVE_S` 동안 퍼지는 구 껍질(가장자리 프레넬 + 스캐너 높이 띠, 가산, 광원 없음). 풀 3개를 `build` 때 미리 만들어 선컴파일에 실린다. |
| `soil.ts` | **행성별 토양** (온실 개편, 2026-09-11). `data/planets.csv` 의 `soils`(`"토양아이템id:가중치"` 를 `\|` 로 — `herbs` 와 같은 형식) · `soilNodes`(미션당 토양 더미 개수)를 읽는 **유일한 자리**이고 `planetSoil(id)` 하나를 낸다 (행성이 없거나 개수가 0 이면 null). ⚠ 두 열의 정식 주인은 `shared/planetDefs` 의 `PlanetEcosystem` 인데 그 배치가 `src/shared` 를 건드리지 않기로 돼 있어 world/ 가 직접 읽는다 — `structures/model.ts` 가 `RAIL_CLEARANCE_M` 을 읽는 것과 같은 임시 조치다 (나중에 `eco.soils` · `eco.soilNodes` 두 줄로 옮기면 이 파일은 그것만 읽으면 된다). THREE 를 쓰지 않는다. |
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
**2026-09-11 (C-40) 재계측** — 행성 8개 × 3회(첫 회 제외 평균, 다른 에이전트 스모크와 CPU 공유): **319 → 230 ms**.
단계별 전 → 후: 높이장 134 → 97 · 소품 59 → 34(바위 41 → 23) · 텍스처 32 → 23 · 색 27 → 23 · 둥지+패드+폐허 30 → 21.
월드 서명(장애물 · 지형 버텍스 · 소품 인스턴스 · 상자 · 채집물)이 8개 전부 **바이트 동일**, 난수 소비 순서 불변, `world:ready` 는 그대로 동기.
남은 대부분은 `noise2`(생성당 ~100 ms, 정점마다 20번 안팎)다. 단계별 값은 `WorldSystem.genTimings`.

**2026-09-11 (C-66) `noise2` 재계측** — 같은 페이지에서 옛 구현과 번갈아 돌린 A/B(행성 6곳 × 8라운드 = 40회, 다른
에이전트 스모크와 CPU 공유라 최저값 · p25 가 신뢰할 만하다): 생성 전체 **min 203 → 180 · p25 217 → 194 · 중앙값 222 → 197 ms**,
높이장 **min 95 → 72 · 중앙값 97 → 78**, 색 21 → 19, 텍스처 22 → 21 (소품은 그대로). 잡음만 따로 재면(Chrome, 같은 코드)
지형 잡음 한 판 96 → 79 ms, `noise2` 400만 번 66 → 42 ms. **수학은 한 줄도 바뀌지 않았다** — 아래 `변경 이력` 의 C-66 항목.

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
> **2026-09-11 에 걷어냈다** — 이제 층마다 천장이 있고 맨 위는 옥상이다 (아래 `## 2026-09-11` 절). 이 절은 기록으로 남긴다.

3인칭 카메라가 실내에서 천장에 갇히면 안 된다. 지붕 페이드 · 카메라 레이캐스트 특례 · 부분 지붕을 견주다
**무너진 지붕**을 골랐다: 남은 것은 서까래 몇 개 · 처마 두 조각 · 벽 위 난간뿐이고 **전부 콜라이더가 없다**.
카메라도 총알도 통과하고 실내는 하늘이 보이는 폐허가 된다 — 특례 코드가 0줄이고 설정에도 맞는다.
불시착 함선도 같은 이유로 **위가 찢겨 열린** 동체이고, 전차도 지붕 없는 무개차다.

### 지하실 · 키카드
> **2026-09-11**: 바닥 해치 → 계단 복도 끝의 **서 있는 문**. 키카드 규칙(지상 컨테이너 하나 · 호스트 확정 · 연 사람의 것만 소비)은 그대로다.

`layout` 이 건물 밑에 회전한 사각 **구덩이**(벽에서 2.2 m 안쪽, 깊이 `basementDepth`)를 예약하고
`Terrain` 이 pad 평탄화 다음에 그것을 판다. 그 위를 덮는 것이 **지상층 바닥판**(`floorPlate`) — 밑면
`y0 − SLAB_T`, 윗면이 정확히 지상층 바닥인 뜬 상자 콜라이더들이고 계단 구멍만 빼고 깐다. **2026-09-10 부터
그리는 판과 서는 판이 같은 하나**이고 발자국 + `FLOOR_OVERHANG` 까지 덮는다 (그 전에는 그린 바닥이 발자국
전체, 콜라이더는 구덩이 + `PIT_BLEND` 만큼이라 넓이가 달랐다 — 아래 `## 2026-09-10` 절).
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
시드로 뽑는다. **선로는 지형을 평탄화하지 않는다** — 지형 높이를 4번 평활화한 뒤 `RAIL_DECK_Y`(0.75 m) 만큼
띄우고 `PIER_STEP`(9 m) 마다 교각으로 받친다 (평탄화하면 맵 한복판에 1 km 짜리 활주로가 생긴다).
2026-09-10 부터 그 뒤에 **부양 패스**가 하나 더 온다: 점마다 좌우 구간의 **지형 최고점을 실측해** 그보다
`RAIL_DECK_Y` 위로 끌어올리고(내리지 않는다), 이어 **올리기만 하는** 평활화가 `RAIL_MAX_GRADE` 로 경사를
제한한다 — 표본 간격이 20 m 를 넘어 언덕을 가로지르는 구간에서 침목이 흙에 잠기던 문제였다. 그리고
`RAIL_DECK_STEP`(5 m) 마다 얇은 **발판 상자 콜라이더**가 이어져 있어 선로 위를 걸어 다닌다. 평탄화하는 것은
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
- ~~구조물 컨테이너의 **문 애니메이션은 동기화하지 않는다.**~~ → 2026-09-11 `crate opened` 로 동기화한다 (빛기둥이 사라진 대신 열린 모습이 조사 여부를 말한다).
- 키카드가 든 컨테이너는 첫 개봉에 `inventory:containerOpened` 를 **두 번** 낸다 (`openContainerItems` +
  `crate:open`). 두 번째는 `first: false` 라 `meta/` 의 계약 카운터는 안전하지만, 이 이벤트를 새로 듣는
  쪽은 그 사실을 알아야 한다.
- 지하실 문이 열린 뒤에는 **적이 계단 구멍으로 떨어질 수 있다**. 나쁜 그림은 아니라 그대로 뒀다.
- 훈련장에는 구조물도 선로도 만들지 않는다 (`mode === 'training'` 에서 전부 빈 배열).


## 2026-09-10: 실내 문턱 · 지하실 계단 · 선로 회랑

세 가지 다 "보이는 것과 걷는 것이 다르다" 는 같은 병이었다. 계약은 하나도 건드리지 않았다
(`src/shared` 무변경, `data/constants.csv` 에 `RAIL_CLEARANCE_M` 한 줄만 추가).

### ① 실내 입구 문턱 — 바닥판이 지형보다 좁았다
**증상**: 전진기지 · 연구실에 걸어 들어갈 수 없고 문 앞에서 **점프해야** 들어가졌다.

**원인**: 지상층은 두 겹이었다 — *그린* 바닥 조각(발자국 전체, 콜라이더 없음)과 *천장 슬래브*
(구덩이 + `PIT_BLEND` 만큼만, 콜라이더 있음). 그 사이 띠에서는 **지형을 밟았는데**, 지형 격자는 2 m 간격인데
구덩이 페더는 `PIT_BLEND`(1.6 m) 뿐이라 구덩이 벽이 **한 칸 안에서** 내려간다. 그래서 벽 안쪽 띠의 지형이
바닥보다 크게 꺼져 있었다 (실측: 전진기지 · 연구실에서 벽 안쪽 0–3 m 띠의 지형이 바닥보다 최대
**3.4–3.6 m** 아래, 슬래브 가장자리 바로 밖에서도 1 m 넘게). 문으로 들어서면 그 도랑에 빠지고, 바닥까지의
턱이 `PROP_STEP_UP_MAX`(0.9)를 넘어 점프 말고는 길이 없었다. 지하실 없는 건물 · 불시착 함선은 지형이 평평해
우연히 멀쩡했다.

**고친 것**: 두 겹을 **하나**로 합쳤다 (`Build.floorPlate`). 판 하나가 발자국 + `FLOOR_OVERHANG`(0.9 m)까지
덮고, **콜라이더 윗면이 정확히 `y0`** · 그린 윗면은 `y0 + FLOOR_LIP`(2 cm, 평탄한 패드에서 지형과 z-fighting
나지 않게) · 밑면은 `y0 − SLAB_T` 라 그대로 지하실 천장이다. 불시착 함선의 동체 데크도 같은 판이 됐다
(예전에는 콜라이더가 아예 없었다). 문 · 무너진 틈 · 찢긴 옆구리 어디로 들어와도 문턱이 없다.

**검증**: 시드 5개 × 구조물 전부에서 ① 실내 `getSurfaceY` 가 바닥 높이와 **최대 0.03 m** 차이
(고치기 전 같은 자리의 지형은 3.6 m 아래), ② 남쪽 벽선을 0.2 m 씩 훑으며 밖 → 안으로 걸어 본
"연속 통과 폭" 이 **2.6 m = `DOOR_W` 전체**.

### ② 지하실 계단 — 윗단이 늘 벽이었다
**증상**: 계단이 계단으로 걸리지 않고 그대로 미끄러져 떨어지고, 다시 올라올 수 없었다.

**원인 (두 겹)**:
- **`resolveCollision` 이 올라설 수 있는 단까지 밀어냈다.** 상자 가지는 발이 윗면 `PROP_TOP_MARGIN`(0.15)
  안에 있을 때만 통과시켰다. 그런데 한 단의 디딤폭이 `PLAYER_RADIUS`(0.45)보다 좁으면 **어느 단에 서 있든
  바로 윗단이 늘 몸에 겹친다** — 매 프레임 아래로 밀려 계단을 미끄러져 내려가고, 올라갈 때는 다음 단에
  중심이 들어가기 전에 밀려나 `getSurfaceY` 가 발을 올려 줄 기회 자체가 없다 (움직이는 쪽의 규약은
  "표면 먼저, 밀어내기 나중" 인데 밀어내기가 표면 질의를 굶긴다).
- **디딤폭이 실제로 몸통보다 좁았다.** `steps = max(6, round(depth/0.28))` · `run = max(3, depth×1.25)` 라
  깊이 3.6 m 짜리 지하실에서 13단 × **0.35 m** 였다 (몸통 반지름 0.45).

**고친 것**:
- `WorldSystem.resolveCollision` 의 `o.box` 가지에 한 줄 — **윗면이 `position.y + PROP_STEP_UP_MAX` 이하인
  상자는 밀어내지 않는다.** `getSurfaceY(x, z, feetY)` 의 천장과 **같은 식**이라 두 판정이 어긋나지 않고,
  원기둥 소품의 경로는 2026-09-09 규약대로 한 줄도 바뀌지 않았다. 선로 플랫폼 계단도 같은 이유로 낫는다.
- 계단 치수를 `structures/model` 의 `STAIR_RISE_MAX`(0.45 = `PROP_STEP_UP_MAX` 의 절반) ·
  `STAIR_TREAD_MIN`(0.62 > `PLAYER_RADIUS`)으로 잡고, **구멍 길이(`run` = 해치 크기)를 계단에서 역산한다**
  (예전에는 `run` 을 먼저 정하고 단을 쪼개서 디딤폭이 따라왔다). 깊이 3.6 m → 8단 × 0.45 m, 디딤폭 0.62 m.
  "통과되는 단" 이 두 단(1.24 m)이라 몸통 반지름보다 넉넉하다.

**검증**: 해치를 연 뒤 계단 방향으로 걸어 내려갔다 되돌아 올라오는 시뮬레이션(플레이어와 같은
표면→밀어내기→접지 순서). 고치기 전에는 내려가기는 **떨어지는** 모양이고 올라올 때 높이가
0.31–0.44 m 에서 **제자리 진동**했다. 고친 뒤 내려가기 3.6 → 0, 되올라오기 0 → 3.6 (바닥 높이 복귀).

### ③ 선로 회랑 — 선로가 마지막에 뽑히면 비켜 갈 수가 없다
**증상**: 선로 위에 구조물 · 바위 · 상자 · 채집물이 겹쳤다.

**원인**: `RailPlan` 의 자유도는 사실상 하나씩뿐이다 — `line` 은 **원점을 지나는** 선분이라 방향 하나,
`loop` 은 **원점 중심** 원이라 반지름 하나(`angle` 은 위상일 뿐 도형이 같다). `Rails.build` 가 `extent` ·
`angle` 을 그대로 쓰므로 여기에 오프셋을 더할 수도 없다. 그런데 2026-09-09 배치는 패드를 **전부 뽑은 뒤**
선로를 굴리고, 그것도 **플랫폼 정차점 2곳**의 거리만으로 8번 중 하나를 골랐다 — 궤도 전체는 아무도 보지
않았다. 반지름 20 m 원반 하나가 막는 방향 폭이 0.4 rad 쯤이라 스무 개면 π 를 넘는다: 사후에 빈틈을 찾는
것은 원리적으로 불가능하다.

**고친 것**: 순서를 뒤집었다. `generateLayout` 이 **선로를 제일 먼저** 잡고, 그 뒤의 모든 추첨이
`railFree(x, z, 반지름)` 로 회랑을 피한다 — 스폰(가장자리를 따라 다시 뽑는다) · 탈출 패드 · 둥지 · 폐허
전초 · **크레이터** · 버려진 구조물. 소품 · 상자 · 채집물 · 버섯 군락은 `build.isSpotFree` 가
`railClearance` 를 보게 해서 막는다 (**`ignorePads` 로도 못 끈다** — 상자의 랜드마크 둘레 고리가 선로를
가로지른다). 회랑 반폭은 `data/constants.csv` 의 **`RAIL_CLEARANCE_M`(9 m)** 이고 검사는
`clearance + 그 물건의 반지름` 이다. `line` 은 점–선분 거리, `loop` 은 점–원 거리로 푼다 (`railDistance`).
플랫폼은 선로 시설이라 회랑에서 예외이고, 그 자리는 `layout.pads` 의 `platform` 패드가 막는다.

**대가**: 2026-09-09 이 지키던 "선로 추첨이 앞의 rng 를 밀지 않는다" 가 끝났다 — **같은 시드의 매크로
레이아웃(크레이터 · 둥지 · 폐허 · 구조물 자리)이 이 변경 전과 다르다.** 멀티 결정성은 그대로다
(모두가 같은 코드를 같은 시드로 돌린다).

**검증**: 시드 5개에서 구조물 · 상자 · 채집물 · 둥지 · 모든 소품 콜라이더를 중심선까지의 거리로 재
"가장 가까운 가장자리" 가 **8.0–9.5 m** (플랫폼 반경 16 m 안은 제외). 4 m 안으로 들어온 것은 0건.
9 m 를 살짝 밑도는 표본은 `isSpotFree` 에 넘긴 산포 반경보다 `Props.hullOf` 실측 콜라이더가 큰 경우이고,
궤도(반폭 1.15 m)에서 8 m 넘게 떨어져 있어 그대로 뒀다.

### 알려진 한계 (2026-09-10)
- **낮은 원기둥 소품은 여전히 못 올라간다.** 위의 "올라설 수 있는 단" 예외를 `o.box` 에만 걸었다
  (2026-09-09 의 "원기둥 경로는 한 줄도 바꾸지 않는다" 를 지켰다). 원기둥까지 풀면 낮은 바위 옆구리에
  몸이 반지름만큼 파고들어 보이고, 수류탄 · 아이템이 낮은 바위를 그냥 넘어간다.
- **분지(`basins`)는 선로 회랑을 피하지 않는다.** 반지름 55–90 m 라 회랑을 피하게 하면 자리가 거의 없고,
  깊이 3–6 m 의 완만한 저지대는 교각이 흡수한다.
- **선로가 놓일 자리를 못 찾는 일은 없다** — 선로가 먼저이므로 실패할 추첨 자체가 없다. 대신 회랑이
  넓은 맵에서는 둥지 · 폐허가 몇 개 덜 놓일 수 있다 (각 루프의 시도 상한에 걸리면).

## 2026-09-10: 전차 탑승 · 차체 방향 · 운전실 콘솔 · 충돌 · 플랫폼 계단

사용자 피드백 6건. 새 계약은 없다 — `data/constants.csv` 에 `RIDE_*` · `TRAM_HIT_*` · `TRAM_CONSOLE_RANGE` ·
`RAIL_STAIR_*` 를 **추가**하고 `src/shared/constants.ts` 가 그 이름만 갖는다. 지오메트리 · 배치 · 충돌은
`rails/parts/Track` · `Platform` · `Tram` 으로 내렸고 `Rails.ts` 에는 수명 · 상태 기계 · 멀티만 남았다.

### ① 차체가 선로와 **수직**이었다
`data/structures.csv` 의 `tram` 행은 `halfW`(1.9) = 반**폭**, `halfD`(6) = 반**길이**인데
(그 증거가 `PLATFORM_OFFSET = rail_platform.halfD + tram.halfW + 0.05` 다 — `halfW` 를 옆으로 물러나는
거리로 쓴다), 차체 지오메트리와 콜라이더만 그 둘을 **바꿔서** 로컬 X(= 선로 접선)에 1.9, 로컬 Z(= 좌우)에
6 을 넣고 있었다. 결과가 **선로를 가로지르는 12 m 짜리 판때기**다. 치수는 그대로 두고 축만 바로잡았고,
규약을 `rails/model` 머리에 못 박았다: **로컬 +X = 진행 방향, 로컬 +Z = 좌우.**
곡선에서는 `placeTram` 이 이미 접선 yaw 를 매 프레임 넣으므로 그대로 따라 돈다 (12 m 현의 처짐은 반지름
200 m 곡선에서 9 cm).

차체는 여전히 **무개차**(지붕 없음, 3인칭 카메라 규약)이고, 앞 끝은 **격벽 한 장**이라 그 뒤 `TRAM_CAB_LEN`
이 **걸어 들어가는 운전실**이다 — 통짜 운전실 상자로 막으면 콘솔 앞에 설 수가 없다.

### ② 출발 콘솔이 플랫폼이 아니라 **전차 안**에 있다
`rail:tram_rail_0:console` 하나뿐이고 `Interactable.position` 은 `TramInst.consolePos` **그 객체**다 —
`placeTram` 이 매 프레임 제자리에서 고치므로 달리는 중에도 조준이 따라붙는다 (객실 컨테이너와 같은 수법).
홀드 시간 · 프롬프트 규약은 그대로라 키캡의 `kc-hold` chevron도 그대로 붙는다. 플랫폼에 남은 기둥은
**안내판**(실루엣 + 콜라이더)일 뿐 상호작용하지 않는다.

### ③ 도착하면 **선다** (자동 재출발 제거)
`docked` 에서 `TRAM_DOCK_S` 가 끝나면 예전에는 곧바로 `moving` 으로 돌아갔다 — 콘솔을 만지지 않았는데
저절로 떠나던 그것이다. 이제 `idle` 로 내려앉고 **운전실 콘솔이 다시 눌릴 때까지 서 있는다**
(`idle` · `docked` 둘 다 `state !== 'moving'` 이라 콘솔은 어느 쪽에서든 눌린다). `TRAM_DOCK_S` 는
"정차" 표시가 떠 있는 시간으로 남았다.

### ④ 달리는 전차에 치이면 피해 + 넉백 (`updateTramHit`)
- **빠를 때만 위험하다**: `TRAM_HIT_SPEED_MIN`(7 m/s) 밑에서는 아무 일도 없고, 그 위에서는 피해도 넉백도
  `speed / TRAM_SPEED` 에 비례한다 (출발 직후의 저속 구간 · 정차는 안전).
- **탑승자를 빼는 한 줄**: 발이 전차 바닥보다 `TRAM_HIT_FLOOR_CLEAR`(0.18 m) 넘게 아래일 때만 판정한다.
  데크 위(바닥 높이)와 플랫폼 위(**같은 높이**)가 그 한 줄로 빠지고, 선로 발판 위(바닥 −`TRAM_FLOOR_UP` 0.35)와
  맨땅(−1.1)만 남는다. 아래로는 `TRAM_HIT_REACH`(2.4 m)까지가 범위다.
  **2026-09-11 (C-63)**: 이 한 줄을 플레이어 · 적 · 끊긴 분대원이 **똑같이** 쓴다 (예전에는 적만 `RIDE_FOOT_DROP` 0.7 까지
  면제라 **선로 발판 위의 적이 안 치였다**). 그 밑 0.18–0.7 띠는 `riderExempt` 가 본다 — 차체 단면 + `RIDE_EDGE_MARGIN`
  안이고 **발밑 발판(`getStandingObstacle`)이 이 전차의 부품이거나 비어 있을 때만** 탑승자로 빼고, 선로 발판을 밟은
  몸은 치인다. 적의 탑승 상태를 `EnemyRef` 로 묻지 않는 규약은 그대로다 (월드가 발밑을 스스로 본다).
- 넉백은 **진행 방향 + 선로 밖**의 합이라 그대로 앞으로만 밀려 계속 치이지 않는다. `applyKnockback` 이
  `KNOCKBACK_MIN_LIFT` 로 살짝 띄우므로 별도 수직 상수는 없다.
- **호스트/리플리카**: 전차 상태(`s` · `dir` · state)는 호스트 권위이고 이미 동기화돼 있으므로 판정은
  각자 **자기 플레이어만** 한다 (`Hazard` 와 같은 철학 — 새 와이어가 0개다).
- 소리는 `tram_dock` 을 낮은 피치로 재생한다 (`audio/` 는 이 배치의 소관이 아니라 새 id 를 만들지 않았다).
  → 2026-09-11 (C-18): 전용 `tram_hit`, 치이는 몸의 자리에서.

### ⑤ 플랫폼 계단 — 단수가 **4로 못 박혀** 있었다
데크 높이는 선로 부양 패스 때문에 자리마다 다른데(언덕을 가로지르면 3 m 를 넘는다) 단수가 고정이면
한 단이 `PROP_STEP_UP_MAX`(0.9)를 넘어 **계단이 벽이 된다**. 이제 한 단의 높이를
`RAIL_STAIR_MAX_RISE`(0.6) 이하로 고정하고 **단수를 거기서 뽑는다**. 기준면도 패드 높이가 아니라
**계단이 실제로 닿는 바깥쪽 지형**과 견줘 잡고(3회 반복으로 단수 ↔ 기준면을 함께 푼다), 각 단의 상자는
그 자리 지형에서 올라온다 — 떠 있지 않고 마지막 한 단이 데크 상판으로 이어진다.

### ⑥ `RAIL_DECK_STEP` 5 → 3 (탑승이 시작되지 않던 진짜 원인)
발판 상자는 평평한데 선로는 기울어 있으므로 상자 윗면은 자기 중점의 높이이고 양 끝에서 최대
`RAIL_DECK_STEP/2 × RAIL_MAX_GRADE` 만큼 어긋난다. 5 m · 0.14 이면 **0.35 m 이고 그것이 정확히
`TRAM_FLOOR_UP`** 이다 — 최대 경사 구간에서 **전차 옆 선로 발판의 윗면이 전차 바닥과 같은 높이가 되고**,
`getStandingObstacle` 이 동점을 아무거나 고른다. 선로 발판이 뽑히면 `velocity` 가 없어 **탑승이 아예
시작되지 않는다** (시드 1234 에서 실측 확인). 3 m 면 0.21 이라 여유가 생긴다.
**이 관계(`step/2 × grade < TRAM_FLOOR_UP`)를 깨는 값으로 바꾸지 않는다.**

### 알려진 한계 (2026-09-10, 전차)
- ~~**플랫폼에서 전차를 부를 수 없다.**~~ → 같은 날 다음 배치에서 안내판이 **호출 콘솔**이 됐다
  (아래 [`## 2026-09-10: 전차 호출 콘솔` 절](#2026-09-10-전차-호출-콘솔-플랫폼)).
- ~~**적 · 시체는 전차에 치이지 않고 실려 가지도 않는다.**~~ → 2026-09-11 (C-18): 적 · 끊긴 분대원은 **치인다**
  (`updateTramHit`, 권위). 적 탑승 · 적 시체 · 플레이어 시체를 실어 나르는 것은 `enemies/` · `game/` 몫이다.
- **전차 밑은 여전히 지나갈 수 없다** (2026-09-09 의 한계 그대로). 이제 그 자리는 고속에서 피해 범위이기도 하다.
- **플랫폼 ↔ 전차 사이 0.05 m 틈**은 그대로다 (`PLATFORM_OFFSET`). 발판 질의가 점 하나만 보므로 아주
  드물게 그 틈에서 한 프레임 떨어질 수 있다.

## 2026-09-10: 전차 호출 콘솔 (플랫폼)

시동을 운전실로 옮긴 **직접적인 대가**를 갚는 배치다 — 전차가 반대편에 서 있으면 부를 방법이 없었다.
사용자 결정: **플랫폼 안내판을 「전차 호출」 콘솔로 만든다. 호출은 전차를 내 플랫폼으로 부르기만 하고,
실제 출발은 여전히 타서 운전실 콘솔을 눌러야 한다.** 새 계약은 없다 (`src/shared` 무변경, 와이어 0개 추가);
`data/constants.csv` 에 `TRAM_CALL_HOLD_S` · `TRAM_CALL_RANGE` 두 줄이 늘었다.

### 상태 기계 — 호출은 「방향을 정한 시동」이다
호출은 **새 경로를 만들지 않는다.** `requestCall` 이 목적지 쪽으로 방향만 정하고 그대로 `applyStart` 로
들어가므로, 알림 → `TRAM_START_DELAY_S`(1초) 대기 → `TRAM_ACCEL_S`(3초) cubic 가속 → `checkDock` →
`docked` → `idle` 까지가 시동 콘솔과 **완전히 같은 절차**다. 그래서 **호출로 온 전차도 도착하면 그 자리에
선다** — 2026-09-10 의 "자동 재출발 없음" 이 깨지지 않는다.

| 전차 상태 | 그 플랫폼의 호출 콘솔 | 눌렀을 때 |
|---|---|---|
| `idle` · `docked`, 다른 곳 | `전차 호출 (E)` · 홀드 `TRAM_CALL_HOLD_S`(2초) | 그 플랫폼을 향해 출발 |
| `idle` · `docked`, **이 플랫폼**(`DOCK_WINDOW` 안) | `전차 대기 중 — 타서 운전실 콘솔로 출발` · **홀드 0** | 거부음 + `전차가 이미 이 승강장에 있다` |
| `moving` | `전차 운행 중 — 정차하면 부를 수 있다` · **홀드 0** | 거부음 + `전차가 운행 중이다 — 정차한 뒤에 다시 부른다` |

- **`canInteract` 는 내리지 않는다.** false 면 `findBest` 가 통째로 걸러 **프롬프트조차 안 뜬다** — 왜 안
  오는지 알 길이 없어진다. 대신 부를 수 없는 상태에서 **홀드를 0** 으로 돌려 누르는 즉시 거부음 + 이유
  토스트를 낸다. 지하실 해치가 키카드 없이 눌렸을 때와 **같은 규약**이다 (`Structures.registerHatch`).
  홀드가 0 이면 키캡의 `kc-hold` chevron 도 저절로 사라진다 (`interact:promptChanged.hold`).
- **"이 플랫폼에 있다" 의 기준은 `DOCK_WINDOW`** — 정차 판정과 같은 창이다. 눈에 보이게 서 있는데
  "부를 수 있다" 고 말하지 않는다.
- **중복 호출은 거부다** (무시 · 덮어쓰기 · 예약이 아니다). 예약해 두면 누른 사람은 왜 안 오는지 모른 채
  기다리고, 도착한 전차가 아무도 안 만졌는데 다시 떠나는 그 버그가 되살아난다. 방향을 뒤집어 덮어쓰면
  알림 · 가속 곡선이 주행 중에 다시 시작돼 타고 있는 사람에게는 사고다. 달리는 중에는 어차피
  `applyStart` 가 거절하므로 **눌리는 순간** 그렇게 말하는 편이 정직하고, 정차하면 곧바로 다시 부를 수 있다
  (`TRAM_DOCK_S` 뒤 `idle`, 그 사이 `docked` 에서도 부를 수 있다).
- 홀드가 시동(1.5초)보다 **긴 2초**인 이유: 시동은 내가 탄 차를 움직이지만 호출은 **남이 있을 수도 있는
  차를 통째로 불러오고**, 잘못 부르면 분대가 반대편까지 걸어야 한다. 콘솔이 승강장에서 기다리는 자리 바로
  옆이라 스치듯 눌릴 여지도 있다.

### 목적지는 와이어가 아니라 **요청자의 자리**에서 읽는다
`TramRequest` 는 `{ ev:'start', id }` 뿐이고 목적지 칸이 없다 — 계약(`src/shared/net.ts`)이라 이 배치가
고칠 수 없다. 그래서 호스트가 `tramq start` 를 받으면 **요청자에게 가장 가까운 플랫폼**을 목적지로 삼는다
(`Rails.targetSFor`, `ctx.net.getRemotePlayers()` 의 좌표). 이 규칙 하나가 두 콘솔을 모두 설명한다:

- 플랫폼에서 부른 사람 → 그가 선 플랫폼이 목적지다.
- 운전실에서 시동을 건 사람 → 정차한 전차 안에 있으므로 **전차가 선 플랫폼**이 뽑히고, 목적지 = 지금
  자리라 **방향이 그대로 유지된다** (= 2026-09-10 이전 동작 그대로).

방향은 `line` 에서만 정한다. `loop` 은 `TramDef.dir` 이 **언제나 +1** 이라고 계약에 적혀 있고, 플랫폼이
둘뿐이라 그대로 돌아도 부른 쪽에 닿는다. 플랫폼이 3개 이상이 되면 호출한 곳보다 앞선 정거장에 먼저
서는데, 그것은 전차로서 맞는 동작이라 그대로 둔다.

### 모델 — 조작하는 물건으로 보여야 한다
받침 · 몸통 · **기울어진 화면 틀**(0.5 rad) · 발광 화면 · 몸통 띠 · 버튼 두 개. 선로 본체는 버텍스 컬러
머티리얼 한 장뿐이라 화면이 스스로 빛나지 않으므로, **발광 조각만 따로 모아**(`RailBuild.glow`) 플랫폼을
다 세운 뒤 `Rails.build` 가 **한 덩어리 emissive 메시**(`rail_console_glow`)로 합친다 — 드로우콜은 플랫폼
수와 무관하게 +1 이다. 움직이는 물건(전차)의 발광은 여기 넣지 않는다: 합친 메시는 제자리에 남는다.
콜라이더는 예전 안내판과 같은 원기둥 하나이고 **가장 넓은 받침의 모서리 스윕**(hypot(0.45, 0.28) = 0.53 m,
높이 1.5 m)이다 — 보이는 실루엣을 넘지 않는다.

`Interactable` 은 `Rails` 가 등록한다 (`rail:<platformId>:call`). `parts/Platform` 은 물건을 세우고
**콘솔 자리(가슴 높이)를 돌려줄** 뿐이다 — 상태 기계를 아는 곳은 `Rails` 하나다.

### 소리
새 id 를 만들지 않았다 (`audio/` 는 이 배치의 소관이 아니다). 거부는 **`keycard_deny`**(거부 버저),
출발은 `applyStart` 가 이미 내는 `tram_start` 다. **전용 소리가 있으면 좋겠다**: 호출 접수를 알리는
짧은 승강장 차임(`tram_call` 같은 것) — 지금은 부른 사람이 멀면 `tram_start` 가 거리 감쇠로 들리지 않아
토스트에만 의존한다. → **2026-09-11 (C-39)**: `tram_call`(수락, 부른 콘솔 자리) · `tram_deny`(거부)가 생겼다.

### 알려진 한계 (호출 콘솔)
- **호출한 사람이 누구인지 다른 사람에게 보이지 않는다.** `rail:tramStarted.by` 에는 실려 있지만
  토스트는 전차 곁(`TRAM_DEPART_NOTICE_RANGE`)에 있는 사람에게 `전차가 곧 출발합니다` 한 줄이고, 부른
  사람에게는 `전차를 호출했다` 한 줄이다 (2026-09-10 — 그 전에는 모두에게 「곧 출발」이 떴다).
- **멀티에서 호출한 클라이언트는 낙관적 표시가 없다** — 요청을 보내고 `전차를 호출했다` 토스트만 띄운 뒤
  호스트의 `tram state` 를 기다린다 (한 왕복). 전차를 미리 움직이면 호스트가 거절했을 때 되감아야 한다.
  같은 이유로, 요청이 날아가는 사이 다른 사람이 먼저 출발시켰다면 그 요청은 **조용히 버려진다**
  (`applyStart` 가 `moving` 을 거절한다) — 부른 사람에게는 "전차가 출발했다" 로만 보인다.
- **목적지를 위치로 읽으므로**, 호출을 보낸 직후 요청자가 다른 플랫폼으로 순간이동하면(디버그 · 치트)
  방향이 그 자리 기준으로 정해진다. 정상 플레이에서는 일어나지 않는다.

## 2026-09-11: 볼록 콜라이더 · 경사 계단 · 2층 건물 · 창문 · 사다리 · 옥상 스캐너 · 열린 모습

사용자 요청 9건 중 world 몫. 계약(`src/shared`)은 **추가만** 했다: `Obstacle.hull / ramp / fragile`, `ObstacleHull(Band)`,
`LadderDef`, `WorldRef.getLadders`, `PlayerRef.climbingLadder?`, `ladder:grab` · `player:climbChanged` ·
`structure:glassBroken`, `PlayerFlags.CLIMBING`, `struct glass` + `sync.glass`, `crate sync / syncq` + `ids`,
`shared/lightPool.ts`(함선에서 옮김) · `shared/fragile.ts`. 수치는 `data/constants.csv`(`STRUCTURE_POINT_LIGHTS` ·
`STRUCTURE_SCAN_WAVE_S` · `LADDER_*` · `STEP_SMOOTH_*` · `THROW_ARC_PREVIEW_FRACTION` · `BOX_HEADROOM`,
`SCENE_POINT_LIGHT_BUDGET` 23 → 25)와 `data/structures.csv`(`upperChance` 열, 전진기지 · 연구실 `wallH` 3.6 · `basementDepth` 4.4).

### ① 지형지물 콜리전 — 원 하나 → 볼록 윤곽 (사용자 결정: 볼록 다각형 기둥)
2026-09-10 의 `footprintOf` 는 방위별 거리의 **평균**으로 원 하나를 만들었다. 길쭉한 바위는 긴 쪽으로 몸이 메시에
파고들고 짧은 쪽에서는 앞서 막혔다. 이제 같은 점들(땅 위 정점 + 변의 지형 교차점)의 **2D 볼록 껍질**이 콜라이더다
(`propHull.ts` → `hull.ts`). 이동 · 발판은 한 장의 윤곽(몸 높이까지), 총알 · 시야는 높이별 층 윤곽을 본다.
**올라설 수 있는 단 예외는 원기둥과 같이 없다** (낮은 바위 옆구리에 파고들지 않게). 실측(시드 21/7/1234, 바위
328–513개): 보이는 가장자리보다 앞서 막는 거리 p90 **0.14 m**, 보이는 바위 안으로 파고드는 거리 p90 **0.00 m**,
1 m 넘게 앞서 막는 바위 0개.

### ② 계단 — 보이는 것은 계단, 밟는 것은 경사면 (사용자 결정: 경사 콜라이더 + 시각 보간)
`Obstacle.ramp` (상자 + 로컬 +X 로 오르는 윗면). 지하실 · 1→2층 · 선로 플랫폼 계단이 전부 `Stairs.buildStairFlight`
하나다. 경사면을 0.1 m 씩 훑은 한 걸음의 최대 상승 0.07 m. 위 끝은 바닥판과 **0.08 m 겹친다** — 정확히 같은 선이면
부동소수 오차로 두 콜라이더가 그 점을 모두 놓쳐 이음매에서 4.1 m 아래(지하실 바닥)를 돌려줬다(시드 1234 실측).
바위 · 상자 모서리 같은 나머지 단차는 `player/` 가 모델 · 카메라만 부드럽게 따라가게 한다 (`bodyOffset`).

### ③ 천장 · 2층 · 옥상 · 사다리 · 스캐너
- 천장 높이 = PC 두 명 = `wallH` 3.6. 층 사이 바닥판 두께 `SLAB_T` 0.5 → 층 간격 4.1.
- `upperChance` 0.5 로 2층. 1→2층은 바깥벽에 붙은 **실내 계단**(방 쪽은 벽, 2층 구멍 둘레 난간)이고, **맨 위층 →
  옥상은 격벽에 붙은 사다리**다 (1층 건물도 옥상이 있다). 옥상 바닥의 해치 구멍 세 변에 난간, 올라서는 쪽은 격벽 위.
- **맵 스캐너는 언제나 옥상**, 불시착 함선에는 없다 (사용자 결정). 누르면 안개를 걷고(`STRUCTURE_SCAN_RADIUS`,
  종전 그대로) 맵 끝까지 퍼지는 `ScanWave` 를 모두의 화면에 쏜다.
- 3인칭 카메라는 기존 `world.raycast` 당김으로 천장에 갇히지 않는다 (특례 0줄).

### ④ 지하실 — 방
구덩이 벽 라이닝 + **바닥판**(윗면 `yB` = y0 − 4.1) + 천장(= 1층 바닥판). 1층 바닥의 구멍 → 구덩이 한쪽 벽을 따라
내려가는 **계단 복도**(방 쪽 벽, 1층에서는 구멍 둘레 난간 세 변) → 층계참 → **서 있는 문**(문짝 콜라이더, 옆으로
밀려 열림, 복도 벽의 카드 리더기). 방 조명 자리 둘 + 복도 천장 발광 띠.

### ⑤ 창문
층마다 바깥벽에 무작위 1~3 장(문 · 무너진 틈 · 격벽 이음 · 실내 계단 옆은 피한다). 총알은 `weapons/` 의 기존
`destructible.onDamage`, 로그의 총알은 `enemies/parts/Attacks`, 수류탄 · 투척 가젯 · 로그 수류탄은 걸음마다
`shared/fragile.breakFragileAlong` 으로 깬다. **깨져도 사람 · 적은 못 지나간다** (사용자 결정) — 콜라이더가 남아 레이와
작은 몸만 통과시킨다.

### ⑥ 빛기둥 → 열린 모습
빛기둥은 시체에만 선다 (`ui/hud/pillar.pillarAllowed`). 상자 · 컨테이너는 대신 **열린 모습**을 분대 전원이 본다.
연 사람이 `crate opened` 를 보내고(확정 불필요), 호스트가 목록을 들고 있다가 늦게 합류한 사람에게 `crate sync`.

### ⑦ 방 조명 — 가까운 방에만 진짜 광원 (사용자 결정: 풀 4개, 예산 23 → 25)
컨테이너가 놓인 방마다 천장 발광 판 + 광원 자리. `LightPool`(이제 `shared`)이 플레이어 눈에서 가까운 자리 4곳에만
불을 걸고, **층이 다르면**(눈높이와 2.2 m 넘게 차이) 25 m 뒤로 민다. 레이드 점광원 = 상주 15 + 패드 3 + 콘솔 3 +
구조물 4 = 25. `smoke-lights` 통과(세션 내내 개수 불변).

### ⑧ 투척물 · 아이템의 바닥 = 그 자리의 표면
수류탄 · 투척 가젯 · 투척 궤적 미리보기 · 떨어진 아이템이 `getHeightAt`(지형) 대신 `getSurfaceY(x, z, 몸 윗면 −
PROP_STEP_UP_MAX)` 를 바닥으로 쓴다 — 2층 바닥 · 옥상 · 계단에 떨어진다. 몸 윗면 조금 위까지의 윗면만 잡으므로
천장판으로 튀어 오르지 않는다.

### 알려진 한계 (2026-09-11)
- **같은 시드의 구조물 · 소품 배치가 종전과 다르다.** 볼록 윤곽의 외접원이 `isSpotFree` 해시를 바꾸고, 구조물이
  rng 를 더 쓴다 (멀티 결정성은 그대로).
- **적은 사다리를 못 탄다** — 옥상은 사람만 가는 자리다. 계단은 경사면이라 적도 오른다.
- 창문 유리는 **시야도 막는다** (깨지기 전). 적이 유리 너머를 못 보는 대신 총알로 깨면 보인다.
- 가젯 설치물(포탑 · 바리케이드)의 **배치 높이**는 `gadgets/` 가 여전히 지형으로 잡는다 — 2층에서 설치하면 1층에 선다
  (투척된 몸체의 착지만 고쳤다).
- 투척 궤적 미리보기는 유리를 깨지 못하므로 창에서 튕기는 궤적을 그린다 (실제 투척물은 깨고 지나간다).
- 지하 계단 구멍 · 옥상 해치로 **떨어질 수 있다** (난간은 세 변뿐 — 들어가는 쪽은 비어 있다).

## 2026-09-09: 환경 재해 (제한시간 행성)

Contract (pre-written, read-only, `git show 9ea3fc0`): `HazardKind` · `HAZARD_KINDS` · `HAZARD_LABEL_KO` ·
`HazardZone` · `HazardSource` · `HazardRef` · `WorldRef.hazard`, `hazard:planned / announced / started /
progress / insideChanged`, **`atmo:override`**, `fog:discovered.kind += grove`, `HazardMessage`(`hz`) /
`HazardRequest`(`hzq`), `HAZARD_*` · `STORM_EYE_*` · `SPORE_*`, `PlanetDef.hazards` (`data/planets.csv` 의
`hazards` 열). 그림 수치는 **`data/hazards.csv` (신규)**.

레이드 시작 뒤 `HAZARD_START_MIN_S`~`HAZARD_START_MAX_S` 사이 **30초 단위**의 한 시각에 시작해
`HAZARD_FULL_S` 에 걸쳐 맵을 덮는 행성 현상이다. 함선이 궤도에서 관측하는 것이라 **전장의 안개에 가리지
않는다** — 지도는 안개 레이어 위에 그린다 (그 층은 ui/ 소관).

### 종류 · 도형 · 진행 곡선
| 종류 | 도형 (`getZones()`) | 진행 |
|---|---|---|
| 모래 폭풍 `sandstorm` · 눈보라 `blizzard` | `front` **하나**. 전선은 `center` 를 지나고 법선이 진행 방향 `(dirX,dirZ)` 이며 **법선의 반대편(이미 지나온 쪽)이 위험**이다 | 맵을 법선에 투영한 반폭 `span`(+`FRONT_MARGIN`) 을 −span → +span 으로 **선형** 통과. 방향은 시드로 완전 무작위 |
| 폭풍의 눈 `storm_eye` | `circle` + `safeInside:true` **하나**. 중심은 시드로 뽑은 **레이드 내내 고정**된 한 점 (맵 안쪽 60 % 안) | 반경 `STORM_EYE_RADIUS_START`(300) → `STORM_EYE_RADIUS_END`(**0**, 2026-09-11 C-15 — 예전 60) **선형** 축소 — 페이즈가 없어 어디로 좁아질지 처음부터 안다 |
| 독성 포자 `spores` | `circle` + `safeInside:false` **여럿**. 각 원의 중심 = 지형의 **거대 버섯 군락** | 시작 시각은 `SPORE_START_S`(6분) **고정**. 발생지가 `SPORE_SOURCE_INTERVAL_S` 마다 하나씩 더 피어오르고, 각자 `growthMps` 로 `sourceRadius` 까지 자란다 |

### "끝까지 가면 맵 전체" 를 어떻게 보장했나
- **front** — `span` 에 `FRONT_MARGIN`(= `HAZARD_EDGE_M`) 을 얹었다. 이 여유가 없으면 progress 0 · 1 에서
  전선이 정확히 모서리에 걸쳐 부호가 0 이 되고, 축에 나란한 방향에서는 **변 전체**가 그 줄에 걸린다
  ("아직 아무 데도 위험하지 않다" 와 "이제 안전지대가 없다" 가 그 한 줄에서만 어긋난다). 16방향 ×
  17×17 표본에서 양끝 실패 0 을 확인하고 넣은 값이다.
- **spores** — `SPORE_RADIUS_MAX`(110) 만으로는 640 m 맵을 6개로 덮을 수 없다 (6 × π·110² ≈ 228k m² <
  409k m²). 그래서 `Plan.coverRadius` 가 뽑힌 배치에서 **맵의 어느 점이든 가장 가까운 발생지까지의
  거리**를 33² 격자로 실제로 재고, `sourceRadius = max(SPORE_RADIUS_MAX, 그 거리 + 20 m)` 로 잡는다.
  여기에 늦게 피어오르는 발생지는 `growthMps = max(SPORE_GROWTH_MPS, sourceRadius / 남은 시간)` 으로
  올려 `HAZARD_FULL_S` 안에 반드시 다 자란다. 배치도 한쪽에 몰리지 않게 best-of-260 · 최소 간격 130 m
  로 흩는다. 검증: 17×17 표본에서 `HAZARD_FULL_S` 시점 안전 표본 **0**.
- **storm_eye** — ~~계약 상수가 `STORM_EYE_RADIUS_END`(60 m) 이므로 눈은 60 m 로 남는다.~~ 2026-09-11 (C-15):
  `STORM_EYE_RADIUS_END` 가 0 이라 눈도 **완전히 닫힌다** — 네 재해 모두 `HAZARD_FULL_S` 에 안전 표본 0 이다.
  벽 비주얼은 반경 0.5 m 이하에서 숨고(`Visuals`), 지도도 같은 문턱 아래는 캔버스 전체를 위험으로 칠한다
  (예전 `Math.max(1, r·s)` 가 1 px 짜리 안전 구멍과 테두리를 남겼다).

### 피해 · 시야
`HAZARD_TICK_S` 마다 `HAZARD_DPS × HAZARD_TICK_S` 를 `ctx.player.takeDamage` 로 준다 — 프레임이 튀어도
누적 타이머를 `while` 로 소진하므로 정확히 초당 1회다. 죽었거나(`isDead`) 함선 안(`isInShip`) · 강하 중
(`isDropping`) · 게임플레이 페이즈가 아니면 세지 않는다 (전투불능은 그대로 맞는다 — `takeDamage` 가
`downHp` 를 깎는다).

시야는 **`atmo:override` 하나로만** 좁힌다: 경계에서 `HAZARD_EDGE_M` 에 걸쳐 `blend` 를 0→1 로 올리고
`fogMul = 1 + (HAZARD_FOG_MUL − 1) × blend`, `color` 는 `data/hazards.csv` 의 `fogColor`. `ATMO_EPS`(0.02)
보다 작게 흔들리면 보내지 않고, 구역을 나가거나 미션이 끝나면 `{fogMul:1, color:null, blend:0}` 으로
반드시 되돌린다 (`dispose` 포함). **`src/core/` 는 한 줄도 건드리지 않았다.**

### 거대 버섯 군락 — 배치가 기존 rng 를 밀지 않는 이유
군락은 **`spores` 가 후보에 있는 행성이면 이번 레이드의 재해가 무엇이든** 선다 (그 행성의 생태이지
재해의 부속이 아니다). 그래서 자리는 `rng.fork('hazardGroves')`, 메시는 `rng.fork('hazardGroveMesh')`,
재해 추첨은 `rng.fork('hazard')` 로 **서로 다른 fork** 다 — `Random.fork` 는 부모를 전진시키지 않으므로
`props` · `crates` · `gather` 가 보는 rng 스트림은 이 배치 전과 **같다**.

채집 버섯은 `Gather.build(ctx, game, eco, groves)` 의 네 번째 인자로 들어가 **약초 · 고철 배치가 전부 끝난
뒤에** 뽑는다 (2026-09-08 고철 더미가 쓴 수법 그대로) — 그래서 같은 시드의 약초 · 고철 레이아웃은
바이트 단위로 종전과 같다. 변종 1(포자균 갓)의 `InstancedMesh` 용량만 `군락 수 × GROVE_PICKS_MAX` 늘어난다.

**다만 콜라이더는 다르다.** 군락 줄기가 `SpatialHash` 에 들어가므로 `isSpotFree` 가 그 자리를 피한다 —
`Structures` 배치가 이미 적어 둔 것과 같은 대가로, **같은 시드의 소품 · 상자 · 채집물 자리가 이 배치 전과
바이트 단위로 같지는 않다** (멀티 결정성은 그대로 — 모두가 같은 코드를 같은 시드로 돌린다).
군락을 **소품 · 상자 앞**에 세우는 것도 그래서다: 순서를 뒤집으면 군락 한가운데 바위가 선다.

### 동기화
**평상시 와이어가 0 이다.** 종류 · 시작 시각 · 전선 방향 · 눈 중심 · 발생지 자리 · 피어오르는 순서가 전부
미션 시드의 함수이고, 진행은 `ctx.missionTime` 의 함수다 — 모두가 같은 월드를 같은 시드로 만들면 같은
답이 나온다 (안개와 같은 철학). 늦게 합류한 클라이언트만 `hzq sync` 를 보내고 호스트가
`hz sync {data}`(= `serialize()` = 계획 JSON)로 답한다. `flow rejoined` 에도 호스트가 밀어 주고,
`net:hostChanged {isLocalHost:false}` 에는 클라이언트가 다시 요청한다 (`Fog` · `Gather` 와 같은 모양).

### 알려진 한계 (환경 재해)
- ~~**폭풍의 눈만 마지막에 `STORM_EYE_RADIUS_END`(60 m) 짜리 안전지대가 남는다.**~~ → 2026-09-11 (C-15) 0 m.
- **포그가 없는 행성(카민 I, `planets.csv` 의 `fog false`)에서는 시야가 좁아지지 않는다.**
  `core/Atmosphere.applyOverride` 가 `baseDensity × (1 + …)` 를 쓰는데 그 행성은 `baseDensity` 가 0 이라
  무엇을 곱해도 0 이고, 배경색도 `baseDensity > 0` 일 때만 따라간다. `src/core/` 는 이 배치의 소관이
  아니라 그대로 뒀다 — 그 행성에서 시야를 가리는 것은 입자뿐이다.
- **`getSources()` 는 `spores` 일 때만 채워진다** (계약: "다른 재해는 빈 배열"). 그래서 베르단트 III 에서
  폭풍의 눈이 걸린 레이드에서는 군락이 월드에는 서 있지만 **지도에는 뜨지 않는다** — 지도 아이콘이
  `getSources()` 를 읽기 때문이다. `fog:discovered {kind:'grove'}` 는 그때도 나간다.
- **`applySerialized` 는 군락을 옮기지 않는다.** 같은 시드 · 같은 행성이면 계획이 이미 같으므로 이 경로는
  시드가 어긋난 피어를 위한 안전망이고, 그 드문 경우에는 지도의 발생지 원과 지형의 군락이 어긋난다.
- ~~**적 · 시체는 재해에 피해를 입지 않는다.**~~ → 2026-09-11 (C-14): 끊긴 분대원(고스트)은 `Hazard.tickGhosts`
  가, 적은 `enemies/` 의 조용한 DoT(`HAZARD_ENEMY_DPS`)가 맞힌다. 시체는 여전히 맞지 않는다(맞을 몸이 없다).
- **재해 벽은 지형을 따라가지 않는다.** 커튼 · 원통 모두 `HEIGHT_MIN` 에서 `wallHeight` 만큼 서는 평평한
  판이라 높은 능선에서는 발밑이 비어 보일 수 있다. 판정(`isInside`)은 높이와 무관한 2D 라 어긋나지 않는다.
- **기운 거대 버섯의 줄기 꼭대기는 콜라이더 밖이다.** 줄기를 밑동 기준으로 최대 0.12 rad 기울이는데
  콜라이더는 밑동에 선 수직 원기둥이라, 9 m 짜리 줄기의 꼭대기가 최대 1 m 벗어난다. 방향은 **안전한 쪽**
  (콜라이더가 그려진 것보다 작다 = 보이지 않는 벽이 없다)이라 그대로 뒀다 — 나무와 같은 판단이다.
- **훈련장에는 재해가 없다** (`WorldRef.hazard` 가 null).

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

- **2026-09-11 (온실 개편 — 행성별 토양 채집, 에이전트 world)** — 온실의 재배 스테이션이 **흙을 붓고 그 위에 씨앗을
  심는** 방식으로 바뀌면서, 그 흙을 **레이드 채집으로만** 얻게 하는 쪽이 world/ 몫이었다. 새 파일은 `soil.ts`
  하나(행성 표 읽기)이고 나머지는 **고철 더미(2026-09-08)의 선례 그대로** `Gather.ts` 안에서 끝난다 —
  `GatherNodeKind === 'soil'` 변종 하나가 늘었을 뿐 배치 · `Interactable` · 수확 애니메이션 · 호스트 권위
  (`harv`/`harvq`) · 안개 발견은 한 줄도 새로 쓰지 않았다.
  - **수치는 전부 `data/planets.csv` 의 새 두 열**이다: `soils`(토양아이템id:가중치, `herbs` 와 같은 형식) ·
    `soilNodes`(미션당 개수). 행성 성격 — 아켈론 II `부엽토 2 \| 화산재토 1` 5개 · 보레아스 IX `동토 이탄 4 \|
    부엽토 1` 6개 · 베르단트 III `부엽토` 8개 · 피로스 VII `화산재토 4 \| 광물토 1` 5개 · 카민 I `광물토 3 \|
    화산재토 1` 4개. **희귀한 광물토는 위협 3 행성(피로스 · 카민)에만** 나오고, 동토 이탄은 보레아스에만 있다
    ("필요한 흙이 곧 갈 행성" 이라는 결정을 표 하나로 지킨다).
  - **`data/constants.csv` 에는 아무것도 넣지 않았다** (그 파일은 이 배치의 소유가 아니다). 그래서 집는 시간은
    고철과 같은 `SALVAGE_INTERACT_TIME` 을 **의도적으로 공유**한다 (`SOIL_INTERACT_TIME` 은 그 별칭) — 흙만 다른
    시간이 필요해지면 constants.csv 에 한 줄이면 된다. 반지름 · 간격 · 최대 경사처럼 world/ 안에서만 뜻이 있는
    값은 예전 `SALVAGE_*` 와 같은 자리(파일 머리 상수)에 있다.
  - **시드 결정성**: 지오메트리 · 배치 · 종류 · yaw · scale 이 전부 `ctx.rng.fork('gather_soil')` 이다. 행성마다
    흙더미 개수가 다른데 `gather` 스트림에서 굴리면 **같은 시드의 약초 · 고철 레이아웃이 행성을 바꿀 때마다
    달라진다** (`gather_core` 가 쓴 수법 그대로). 실측으로 확인했다 — 이 변경 전후로 약초 노드 수 · 무리 구성 ·
    `nodeSig` 가 그대로다.
  - **광원 0 · 빛기둥 0** (「빛기둥은 시체에만」 2026-09-11). 흙더미가 채집물로 읽히는 것은 가장자리를 두른
    발광 띠와 표식 막대(기존 glow 메시 경로)뿐이다. 그리기 비용은 변종 하나 = 2 draw call, 생성 비용은
    `genTimings.gather` 기준 1.0 → 1.4~2.2 ms (총 생성 200 ms 대의 1 % 미만).
  - 검증: `npm run typecheck`(world 0건) · `npm run data:check` ok · `scripts/smoke-ecology.mjs` **109/109**
    (행성별 개수 · `soils` 밖 아이템 없음 · 같은 시드 `soilSig` 동일 · 행성 없음/훈련장/모르는 id 는 0개).
  - **리드에게**: ① `scripts/data-owners.mjs` 의 `DATA_OWNERS` 에 `'/src/world/soil.ts'` 한 줄을 더하면
    `data:check` 가 `soils` · `soilNodes` 열의 오타까지 잡는다 (이 배치에서는 다른 에이전트와 겹칠까 봐
    건드리지 않았다). ② 두 열이 `PlanetEcosystem` 으로 옮겨 가면 `soil.ts` 는 csv 대신 `eco` 를 읽는 3 줄이 된다.

- **2026-09-11 (C-66 — `noise2` 최적화, 값은 비트 단위로 그대로, 에이전트 c66)** — `noise.ts` 만 고쳤다. 뿌리는 **V8 의
  인라인 한도**였다: 옛 `noise2` 는 바이트코드 약 540 바이트라 460 한도를 넘어 (`--trace-turbo-inlining`: "reason 5 = too big")
  `fbm` · `ridged` 의 **옥타브마다 진짜 함수 호출**을 했다. ① 모서리 하나의 기여를 `corner()` 로 떼어 `noise2` 를 358
  바이트로 줄이고(이제 호출부에 인라인된다), ② `fbm` · `ridged` 는 `noise2` 를 부르지 않고 **같은 커널을 루프 안에 펴서**
  들고 있으며(그 둘을 품은 큰 함수 — `Terrain` 의 높이 함수 — 에서 인라인 예산이 바닥나 옥타브마다 호출로 되돌아가는 것을
  막는다), ③ 기울기는 생성자에서 `gx` · `gy`(Float64Array)로 펴 뒀다(`GRAD2[permMod12[k] * 2]` 두 번 건너뛰기 제거,
  Float32 값을 double 로 옮겨 적은 것이라 읽히는 값이 같다), `2 * G2` 는 모듈 상수. **부동소수 연산의 순서 · 피연산자는
  한 줄도 바꾸지 않았다** (`Math.floor` 도 그대로 — `xs | 0` 정수 트릭이 4 ms 더 빨랐지만 |입력| ≥ 2³¹ 에서 값이 달라져
  버렸고, 범위 가드를 붙이면 그 이득이 사라진다). `noise3` 은 손대지 않았다.
  **동일성 검사**(전부 옛 구현과 나란히 돌려 비교): ① 시드 7개 × (`noise2` 40만 + `noise3` 10만 + `fbm`/`ridged`/`billow`
  60만) 표본의 SHA-256 이 전부 같고 총합 해시도 같다, ② 특수값(NaN · ±∞ · ±0 · 5e-324 · 1e300 · 2³¹ 경계) 조합 + 난수
  270만 건이 `Object.is` 로 전부 일치, ③ 지형 높이 식을 그대로 옮긴 417² 격자 미러의 해시 일치, ④ **실제 월드 생성**
  (행성 5곳 + 시드 추첨 3개 = 8세계)의 서명 134 조각 — 지형 높이장 · 지형 색/법선 · 장애물 전부(상자 · hull · ramp 포함) ·
  `root` 자식별 지오메트리와 인스턴스 행렬 · 상자 · 채집물 — 이 **전부 바이트 동일**. (검산 근거: `x0 - 1 + G2` 를
  `x0 + G2 - 1` 로 바꾼 사본은 같은 검사에서 600만 표본 중 1.6만 개가 1 ulp 어긋난다 — 검사가 실제로 잡는다.)
  전 → 후는 위 `Typical generation time` 절. 검증: `smoke-props-collision` 53/53 · `smoke-planets` 86/86 ·
  `smoke-ecology` 95/95 · `smoke-structures` 144/144.

- **2026-09-11 (C-63 — 선로 발판 위의 적도 치인다, 에이전트 c63)** — `rails/parts/Tram.updateTramHit` 의 발 높이 창을
  플레이어 · 적 · 끊긴 분대원이 하나로 쓴다: 위 경계가 전부 `바닥 − TRAM_HIT_FLOOR_CLEAR` 이고(적만 `RIDE_FOOT_DROP`
  까지 면제받던 것을 없앴다 — 선로 발판(바닥 −`TRAM_FLOOR_UP` 0.35)에 선 적이 "탑승 창 안" 으로 읽혀 치이지 않던 틈),
  그 밑 0.18–0.7 띠는 새 `riderExempt` 하나가 본다 — 차체 단면 + `RIDE_EDGE_MARGIN` 안 + 발밑 발판이 이 전차의
  부품(`velocity === inst.vel`)이거나 비어 있을 때만 탑승자. 발밑 질의는 `game.world.getStandingObstacle` 이라
  `updateTramHit` 의 시그니처 · `Rails.ts` 는 그대로다. 새 수치 없음(기존 `RIDE_*` · `TRAM_HIT_*` 재사용).
  검사: `scripts/smoke-tram-ride.mjs` 6번 (선로 발판 위 적 hp 640 → 580, 탄 적 · 탄 플레이어는 그대로 면제) 26/26.

- **2026-09-11 (C-57 — `crate opened` 받는 쪽 검증, 에이전트 ⑤)** — `WorldSystem.ensureOpenNet`: 분대원의 `crate opened` 는 ① id 가 이
  월드에 있고(`openablePositionOf` = `Crates.positionOf` → `Structures.containerPositionOf` → `Rails.containerPositionOf`) ② 보낸 사람 스냅샷이
  그 자리에서 max(`PLAYER_INTERACT_RANGE`, `STRUCTURE_INTERACT_RANGE`) + `CRATE_OPEN_RANGE_SLACK` 안(3-D)일 때만 받는다 — 거절은
  `openRefused` 로 센다. `applyOpened` 는 없는 id 를 `openedIds` 에 넣지 않으므로 **호스트의 `crate sync` 는 검증된 id 만 되돌려 준다**.
  `crate sync` 는 로비 호스트에게서만. 새 메서드(읽기 전용): `Crates.positionOf` · `ContainerSet.positionOf` · `Structures.containerPositionOf`
  · `Rails.containerPositionOf`. 검사: `scripts/smoke-trust.mjs`.

- **2026-09-11 (C 항목 배치 — 에이전트 3 · 월드, `docs/plans/c-batch.md` §7)** — 새 계약 없음 (리드 커밋 `36e15e3`:
  `SurfaceMaterial` · `WorldRef.getSurfaceMaterial?` · `EnemyManagerRef.pushBack` · `shared/ride` · `GATHER_*`).
  ① **C-38** `getStandingObstacle` 동점 = 움직이는 발판 먼저 (코드 리드) — `smoke-structures` 0번 단언 3건(두 삽입 순서 ·
  창 안 높이차 · 창 밖 제외). ② **C-11** 폐허 전초 발견 → `fog:discovered {kind:'outpost'}` + `폐허 전초 발견` 토스트,
  지도 아이콘(ㄷ자, `ui/map/MapScreen`). ③ **C-14 · X-7** 끊긴 분대원 몸도 재해 피해(`Hazard.tickGhosts`).
  ④ **C-15** `STORM_EYE_RADIUS_END` 60 → 0 + 지도의 1 px 안전 구멍 제거. ⑤ **C-18** 전차가 적 · 고스트를 친다(권위,
  대상별 쿨다운, 탑승자 제외, `tram_hit`). ⑥ **C-20** 고철 더미 부가 코어(자기 fork `gather_core`, 이벤트 · XP 1회) +
  수량 확률 csv 이관. ⑦ **C-22** `getSurfaceMaterial` + `surface.ts`. ⑧ **C-39** `tram_call` · `tram_deny`.
  ⑨ **C-40** 생성 319 → 230 ms, 월드 서명 바이트 동일 (위 `Typical generation time` 절).
  검증: `smoke-structures` · `smoke-props-collision` · `smoke-hazard` · `smoke-ecology` 에 새 단언 (아래 VERIFICATION 줄).

- **2026-09-11 (볼록 콜라이더 · 경사 계단 · 2층 건물 · 창문 · 사다리 · 옥상 스캐너 · 열린 모습 · 방 조명)** — 사용자 요청
  9건 중 world 몫 (위 `## 2026-09-11` 절). 새 파일 `hull.ts` · `propHull.ts` · `structures/parts/Stairs.ts` ·
  `Glass.ts` · `ScanWave.ts`, `Build.ts` · `Structures.ts` 전면 개편, `Props` 가 볼록 윤곽으로, `Crates` 빛기둥 제거 +
  열린 모습 동기화, 플랫폼 계단 경사면, `resolveCollision` 작은 몸 규칙. 검증: `smoke-structures` 115/115 ·
  `smoke-props-collision` 35/35 · `smoke-lights` 8/8 · `smoke-ladder` 38/38 · `smoke-weapons` 136/136.
- **2026-09-10 (보이지 않는 벽 = 바위 콜라이더)** — 보고는 "폭풍의 눈 안개 경계쯤에서 길이 막힌다" 였다. 재해 코드는
  콜라이더를 하나도 만들지 않고, 행성 4곳 × 진행도 30/60/90 % × 16 방위 × 안팎으로 경계를 달려 본 결과 막힌 곳은
  54° 경사(정상 미끄러짐) · 그리고 **바위**뿐이었다. 바위를 전수 조사하니 `hullOf`(메시 전체 바운딩 박스)가 땅에
  묻힌 적도 · 경사지 오르막 옆구리 · 튀어나온 정점까지 반지름에 넣어, 행성마다 바위 절반(98–215개)이 보이는 바위보다
  평균 0.5 m 이상 앞에서 막고 있었다(중앙값 0.47 m, 한 방위 최대 3.9 m). 폭풍 안개(fogMul 24) 속에서는 그 바위가
  거의 안 보여 그대로 벽이다. `Props.footprintOf` 로 바위 · 첨탑의 **이동 · 총알 원기둥 둘 다**를 땅 위 윤곽에서
  잰다(윤곽 중심 · 32 방위 최대 거리 평균 · 그려진 윗면, 사용자 결정). 같은 조사를 다시 돌리면 **중앙값 0.09 m ·
  p90 0.19 m · 0.5 m 넘는 바위 0개**(4 행성 전부). 거친 단계: 16 방위 원점 중심 → 0.18 m / 32 방위 → 0.125 m
  (시드 21 경사지 바위가 여전히 오르막에서 ~3 m 앞 — 원점 중심의 한계) → 윤곽 중심 → 0.09 m. 월드 생성
  284–338 ms 로 체감 비용 없음. `smoke-props-collision` 에 4번 검사(내려 쏘는 레이로 보이는 가장자리와 비교)를
  더했고, 옮겨진 바위 중심 때문에 2번 검사의 인스턴스 매칭에 "4 m 안의 짝 없는 가장 가까운 바위" 대체 경로를 붙였다.
  ⚠ 바위가 좁아진 만큼 `isSpotFree` 가 보는 해시가 달라져 **같은 시드의 소품 배치가 예전과 조금 다르다**
  (멀티 결정성은 그대로).

- **2026-09-10 (출발 알림 · 콘솔 빛기둥)** — ① `Rails.beginRun` 의 「전차가 곧 출발합니다」가 **떠나는 전차 곁에만**
  뜬다 (`nearDeparture`: 차체 OBB 바깥 거리 ≤ `TRAM_DEPART_NOTICE_RANGE` 12 m — 탑승자 · 옆 승강장 데크 · 계단
  발치). 각 클라이언트가 자기 플레이어로 판단하므로 와이어는 그대로다. ② 호출한 사람은 싱글 · 호스트 ·
  클라이언트 모두 **「전차를 호출했다」** 한 줄이고(예전에는 클라이언트만), 부른 뒤 `CALL_NOTICE_MUTE_S`(3초,
  클라이언트의 왕복 지연 여유) 안에 시작된 출발에는 곁에 있어도 「곧 출발」을 겹치지 않는다. ③ 운전실 콘솔 ·
  플랫폼 호출 콘솔 · 구조물 행성 스캔 콘솔의 `Interactable` 에 `hidePillar: true` — `ui/hud/Detection` 의 감지
  빛기둥이 콘솔 위에 서지 않는다 (탈출 콘솔 · 이륙 스위치는 `extraction/` 에서 같은 처리). 전차 객실
  컨테이너가 달리는 중에 곧바로 닫히던 것은 `inventory/Container.anchor` 쪽 수정이다.

- **2026-09-10 (전차 호출 콘솔)** — 자세히는 위의
  [`## 2026-09-10: 전차 호출 콘솔` 절](#2026-09-10-전차-호출-콘솔-플랫폼). 플랫폼 안내판이
  **「전차 호출」 콘솔**(`rail:<platformId>:call`)이 됐다 — 시동을 운전실로 옮긴 대가로 반대편 전차를
  부를 수단이 없던 것을 갚는다. 호출은 **부르기만** 하고 출발은 여전히 운전실 콘솔이다.
  ① 호출 = **목적지를 정한 시동**이라 `applyStart` 로 합류한다 (알림 → 1초 → 3초 가속 → 정차 → `idle`).
  ② 목적지 칸이 와이어에 없으므로(`TramRequest` 는 계약) 호스트가 **요청자 위치**에서 읽는다
  (`targetSFor`) — 운전실에서 건 시동은 "지금 자리" 가 뽑혀 방향이 유지된다.
  ③ 부를 수 없는 상태에서는 **홀드 0 + 이유가 적힌 프롬프트**(해치 규약)이고 `canInteract` 는 유지한다 —
  내리면 프롬프트조차 안 뜬다. **중복 호출은 거부**(예약 · 덮어쓰기 아님).
  ④ 콘솔이 조작하는 물건으로 보이게 화면 · 버튼 · 발광 띠를 세우고, 발광 조각은 `RailBuild.glow` 로 모아
  **한 덩어리 emissive 메시**(`rail_console_glow`)로 합친다 (드로우콜 +1).
  ⑤ `data/constants.csv` 에 `TRAM_CALL_HOLD_S`(2) · `TRAM_CALL_RANGE`(2.4). **이름을 읽는 자리는 임시로
  `structures/model`** 이다 — `src/shared` 를 건드리지 않기로 한 배치라 `data:check` 의 `DATA_OWNERS` 에
  이미 있는 모듈이 대신 읽는다 (`RAIL_CLEARANCE_M` 이 밟은 길, 나중에 `shared/constants.ts` 로 옮긴다).
  검증: `scripts/smoke-structures.mjs` 에 호출 콘솔 검사 7건 추가.
- **2026-09-10 (전차 탑승 · 차체 방향 · 운전실 콘솔 · 충돌 · 플랫폼 계단)** — 자세히는 위의
  [`## 2026-09-10: 전차 …` 절](#2026-09-10-전차-탑승--차체-방향--운전실-콘솔--충돌--플랫폼-계단).
  ① `Rails.ts`(33 KB)를 **`rails/parts/Track` · `Platform` · `Tram`** 으로 갈랐다 — 남은 것은 수명 · 상태
  기계 · 멀티뿐이고 폴더 공용 어휘(차체 치수 · 색 · `TramInst` · `MovingPart` · `RailBuild`)는 `rails/model`.
  ② **차체가 진행 방향으로 길쭉해졌다** — `structures.csv` 의 `halfW`/`halfD` 를 로컬 X/Z 에 뒤바꿔 넣어
  선로와 수직인 12 m 판때기가 달려 있었다. 축 규약을 `rails/model` 머리에 못 박았다.
  ③ **시동 콘솔이 운전실 안으로** 옮겨 갔다 (`rail:tram_rail_0:console`, 위치는 살아 있는 벡터라 달리는
  중에도 따라붙는다). 플랫폼 기둥은 상호작용 없는 안내판으로 남았다.
  ④ **정차 뒤 자동 재출발을 없앴다** — `docked` → `idle` 이고 다음 출발은 반드시 콘솔이다.
  ⑤ **고속 충돌 피해 + 넉백**(`updateTramHit`) — `TRAM_HIT_*`, 탑승자는 발 높이 한 줄로 뺀다, 와이어 0개.
  ⑥ **플랫폼 계단의 단수를 `RAIL_STAIR_MAX_RISE` 에서 뽑는다** (예전에는 4단 고정이라 데크가 높으면 벽).
  ⑦ **`RAIL_DECK_STEP` 5 → 3** — 5 m 에서 발판 상자의 높이 오차가 정확히 `TRAM_FLOOR_UP` 이라 최대 경사
  구간에서 `getStandingObstacle` 이 전차 바닥 대신 선로 발판을 골라 **탑승이 시작되지 않았다**.
  ⑧ 차체 메시에 이름(`rail_tram_body`)이 생겼다 — 무명이라 `smoke-structures` 의 실루엣 검사에서 통째로
  빠져 있었다.
- **2026-09-10 (실내 문턱 · 지하실 계단 · 선로 회랑)** — 자세히는 위의 [`## 2026-09-10` 절](#2026-09-10-실내-문턱--지하실-계단--선로-회랑).
  ① **지상층 바닥이 판 하나가 됐다** (`Build.floorPlate`). 그린 바닥(발자국 전체, 콜라이더 없음)과 천장
  슬래브(구덩이 + `PIT_BLEND`, 콜라이더만)의 **넓이 차이**가 문턱 버그였다 — 그 사이 띠에서 지형을 밟는데
  2 m 격자가 1.6 m 페더를 못 그려 지형이 바닥보다 3 m 넘게 꺼져 있었다. 이제 발자국 + `FLOOR_OVERHANG`(0.9)
  까지 한 판이고 콜라이더 윗면이 정확히 `y0` 다. 불시착 함선 데크에도 처음으로 콜라이더가 생겼다.
  ② **`resolveCollision` 이 올라설 수 있는 단을 벽으로 보지 않는다** — `o.box` 윗면이
  `position.y + PROP_STEP_UP_MAX` 이하면 밀어내지 않는다 (`getSurfaceY` 의 천장과 같은 식). 지하실 계단이
  미끄러져 떨어지고 되올라올 수 없던 원인이고, 선로 플랫폼 계단도 같이 낫는다. **원기둥 경로는 무변경.**
  계단 치수도 `STAIR_RISE_MAX`(0.45) · `STAIR_TREAD_MIN`(0.62)으로 바꾸고 **구멍 길이를 계단에서 역산**한다
  (깊이 3.6 m → 13단 × 0.35 m → **8단 × 0.45 m, 디딤폭 0.62 m**).
  ③ **선로를 제일 먼저 잡고 나머지가 피한다** (`layout.railDistance` · `railClearance` ·
  `build.isSpotFree`). 회랑 반폭은 `data/constants.csv` 의 **`RAIL_CLEARANCE_M`(9 m, 신규)**.
  2026-09-09 의 "선로 추첨이 앞의 rng 를 밀지 않는다" 는 여기서 끝난다 — **같은 시드의 매크로 레이아웃이
  예전과 다르다** (멀티 결정성은 그대로).
- **2026-09-10 (지하실 바닥 · 상자 배치 · 선로 · 전차 · 재해)** —
  ① **지하실 입구가 눈에 보인다.** `structures/parts/Build` 의 지상층 바닥은 발자국 전체를 덮는 판 하나였다 —
  콜라이더가 없어 걸어 내려갈 수는 있었지만 **해치를 열어도 바닥이 그대로 깔려 있어 막힌 것처럼 보였다**.
  이제 천장 슬래브(`slab`)와 똑같이 **계단 구멍을 도려낸 네 조각**이고, 그래서 이 블록이 `openX/openZ` 가
  정해진 뒤로 내려왔다 (rng 소비 순서가 바뀌므로 같은 시드의 건물 잡음이 예전과 다르다).
  ② **허허벌판에는 상자가 없다** (사용자 결정). `Crates` 의 "1티어 30~40개 흩뿌리기" 와 "아무 데나 4티어 은닉처
  1~2개" 가 사라졌다. 상자는 **폐허 전초(POI) 둘레 · 버려진 구조물 벽 바깥 · 둥지 바깥 고리**에만 선다
  (총 20~40개). **4티어는 이 파일이 더 이상 놓지 않는다** — 지하실 · 불시착 함선 안에만 있다.
  ③ **선로 위를 걸어 다닌다.** `RAIL_DECK_Y` 1.7 → **0.75** (`PROP_STEP_UP_MAX` 0.9 안 = 땅에서 그냥 올라선다;
  더 높으면 올라설 수도 밑으로 지날 수도 없는 담이 된다), 침목 간격 3.2 → 1.8, 교각 간격 13 → 9,
  그리고 `RAIL_DECK_STEP`(5 m)마다 얇은 **발판 상자 콜라이더**를 이어 붙였다 (예전에는 교각만 콜라이더라
  선로가 그림이었다). 중심선은 평활화 뒤 **자기 좌우 구간의 지형 최고점**을 실측해 그보다 `RAIL_DECK_Y` 위로
  끌어올린다 (내리지 않는다) — 언덕을 가로지르며 침목이 묻히던 문제. 이어 **올리기만 하는** 평활화가
  `RAIL_MAX_GRADE` 로 경사를 제한한다.
  ④ **전차 출발이 부드럽다.** 시동 → `ui:notify` 한 줄 + `TRAM_START_DELAY_S`(1초) 정지 → `TRAM_ACCEL_S`(3초)
  동안 **cubic ease-in**(t³)으로 `TRAM_SPEED`(14 → 11.2, 예전의 0.8배)까지. 상태는 `TramInst.runT` 하나이고
  호스트 · 클라이언트가 같은 곡선을 굴린다 (`vel` 이 맞아야 데크가 사람을 실어 간다). 계약 · 와이어는 그대로다.
  ⑤ **폭풍의 눈이 눈에 띈다.** 시야 제한의 세기가 재해마다 다르다 — `data/hazards.csv` 에 `fogMul` 칸이 생겼고
  폭풍의 눈만 24 다 (나머지는 예전 `HAZARD_FOG_MUL` 그대로 7). 그 안에서는 15 m 남짓밖에 안 보이므로 눈의 벽은
  **포그를 받지 않고**(`fog: false`) 원통 **3겹**으로 서고, csv 의 높이 · 불투명도 · 입자 수도 올렸다.
  ⑥ **눈 지형에는 모래 폭풍이 오지 않는다.** `hazard/parts/Plan` 이 추첨 **뒤에** `sandstorm` → `blizzard` 로
  갈아 끼운다 (`SNOWY_BIOMES`, 지금은 `tundra`). 추첨 자체는 그대로라 같은 시드는 여전히 같은 계획이다.

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-09 (환경 재해)** — `Hazard.ts` (+ `hazard/model.ts` · `parts/Plan.ts` · `parts/Zones.ts` ·
  `parts/Grove.ts` · `parts/Visuals.ts`) 로 **제한시간 행성**: 행성 후보 중 하나를 미션 시드로 뽑아
  6~8분(30초 단위, 독성 포자만 6분 고정)에 시작해 `HAZARD_FULL_S` 에 걸쳐 맵을 덮는다. 모래 폭풍 ·
  눈보라는 직선으로 잠식하는 `front`, 폭풍의 눈은 고정된 한 점으로 좁아지는 안전 원, 독성 포자는
  **거대 버섯 군락**에서 하나씩 피어올라 커지는 원 여럿이다. 구역 안에서 `HAZARD_TICK_S` 마다
  `HAZARD_DPS` 피해 + `atmo:override` 로 시야 제한 + 절차 입자/커튼. 군락 둘레에는 채집 버섯이 심어지고
  (`Gather` 의 네 번째 인자), 다 발견하면 6분 뒤 어디서 시작될지 미리 안다. 종류 · 시각 · 도형이 전부
  시드의 함수라 **평상시 와이어가 없다** (늦은 합류만 `hzq`/`hz`). 수치는 `data/hazards.csv` (신규) 와
  `data/constants.csv`. 검증: `scripts/smoke-hazard.mjs` (신규).

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
