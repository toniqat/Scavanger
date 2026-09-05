# src/world — Procedural planet surface

Owner system: `WorldSystem` (publishes `ctx.world`, implements `WorldRef`).
Generates the whole map **synchronously** on `game:newMission {seed}` and emits `world:ready {seed, playerSpawn}`;
tears everything down on `game:abort` and emits `world:cleared`. No asset files — all geometry, vertex colors and
textures are procedural.

| File | Responsibility |
|---|---|
| `WorldSystem.ts` | `GameSystem` + `WorldRef` implementation. Orchestrates generation order (terrain → nests → pads → outposts → props → crates → ambience), owns the `SpatialHash`, and answers queries: `getHeightAt` (heightfield + extraction platform top), `getNormalAt`, `resolveCollision` (circle push-out + soft wall at ±(MAP_SIZE/2−4)), `raycast` (heightfield ray-march + analytic ray/cylinder vs obstacles), `getEnemySpawnPoints`, `getExtractionPoints`, `getCrates`, `getNestPositions`, `getPlayerSpawn`. Extra: `getBiome()`. |
| `noise.ts` | Seeded 2D simplex (`noise2`), 3D gradient noise (`noise3`), `fbm`, `ridged`, `billow`; `lerp/clamp/smoothstep` helpers. |
| `biomes.ts` | Five biome palettes (amber desert, frozen tundra, mossy swamp, ashen volcanic, crimson alien): terrain bands, prop colors, scatter density multipliers. `pickBiome(seed)` reproduces core's `new Random(seed).fork('atmosphere').pick(SKY_PALETTES)` draw so `BIOMES[i]` is always shown under `SKY_PALETTES[i]` (amber-dusk, cold-blue, toxic-green, rust-storm, pale-noon) and each palette is tuned to contrast with its fog color (`pairedSky`, `fogHint`). If core changes the palette count or fork label, the pairing silently degrades to "random but valid". |
| `layout.ts` | Macro layout from the seed: spawn pad near an edge, 3 extraction pads (≥180 m apart, ≥150 m from spawn), 4–6 nest pads, 5–8 POI pads, craters, basins. `padClearance`, `nearestPad`. |
| `Terrain.ts` | Heightfield (417×417 verts, 2 m spacing, covers ±416 m incl. border mountains) from warped fBm + ridged noise + craters/basins + flattened pads + edge cliffs. 8×8 chunk meshes with vertex colors (biome bands by height/slope, AO, crater scorch, nest goo), procedural tiled detail albedo + normal `CanvasTexture`s. Fast bilinear `getHeightAt`, `getNormalAt`, `getSlopeAt`, adaptive ray-march `raycast`. |
| `SpatialHash.ts` | 16 m XZ grid of `ObstacleEntry` cylinders: `add/query/overlaps/walkSegment`. |
| `build.ts` | `BuildCtx` shared by sub-builders and geometry helpers: `isSpotFree`, `paint`, `paintGradient`, `displace`, `merge` (BufferGeometryUtils), `xform`, `composeMatrix`, soft particle texture. |
| `Props.ts` | Jittered-grid + noise-cluster scatter into `InstancedMesh` variants (named `prop_<kind>`): boulders (also on border slopes), rock spires, fungal/dead trees, emissive crystal clusters (pulse), wind-swaying grass tufts (shader injection), pebbles, debris (crates/pod shells/panels). Collidable kinds (boulder, spire, tree, crystal, crate/pod debris) register obstacles; grass, pebbles and panels do not. |
| `Nests.ts` | Bug nests on nest pads: displaced organic mounds, glowing rim/holes (pulsing emissive), spikes, egg sacs, goo discs. Mounds are obstacles; `getHolePositions()` feeds `getNestPositions()`. |
| `Pads.ts` | Extraction platforms (concrete disc, seams, yellow/black hazard ring, H marker, 20 blinking edge lights, 4 light poles just outside the 14 m clear zone, one warm PointLight) and the spawn marker (scorch ring + green beacons). `PLATFORM_HEIGHT/RADIUS`. |
| `Outposts.ts` | POI ruins: slab, broken wall segments, pillars, antenna mast with dish + blinking red beacon, rubble, barrels. Walls/pillars/mast are obstacles. |
| `Crates.ts` | 30–40 loot crates: tiered body/lid geometry (beveled frame, stripes), blinking light, tier-4 beacon beam. Registers an `Interactable` per crate (radius 2.8, Korean prompts), lid tween (0.6 s), dust puff, `crate:open`, `audio:play crate_open`, `stats.cratesOpened`. Placement: tier 2 near POIs, tier 3 outside nest rings, tier 4 caches far from spawn, tier 1 in the open. Crates are obstacles (r 0.9). |
| `Ambience.ts` | 900 additive spore points drifting in a box around the camera (wrapping) with a custom `ShaderMaterial` (perspective size clamped to 1–6 px, fade-in 1.5–6 m from camera, far fade, fog-aware, twinkle); 14 slow dust sprites. |
| `index.ts` | Barrel. |

Generation order matters: obstacles registered earlier are avoided by later placement (`isSpotFree`).
Typical generation time: ~400–900 ms on a desktop (heightfield ~150 ms, mesh+colors ~150 ms, props ~200 ms).

Layers: terrain meshes have `Layers.TERRAIN` enabled (in addition to 0), props `Layers.PROP`, crate bodies `Layers.INTERACTABLE`.

## Phase 3 (2026-09-06): dynamic obstacles
- `WorldRef.addObstacle(obstacle) → remover`: inserts a `kind: 'dynamic'` entry (with its `destructible`) into the same `SpatialHash` as the props, so collision,
  raycasts and enemy avoidance see dropped cover structures / supply crates immediately; `SpatialHash.remove()` takes it out again. `clear()` drops them with the world.
