# src/core — Engine, atmosphere, shared FX pools

Owner: `Engine`. Publishes `ctx.scene / ctx.camera / ctx.renderer` (via `GameContext`) and runs the main loop.

| File | Purpose |
|---|---|
| `Engine.ts` | `Engine(canvas, uiRoot)`: WebGLRenderer (sRGB, ACES, PCFSoft shadows, pixelRatio ≤ 1.5), Scene, PerspectiveCamera(70), `GameContext`, input binding. `addSystem()`, `start()` (calls `init` on all systems, then rAF loop). Frame: dt clamp ≤ 0.05 → `ctx.time`, `ctx.missionTime` (gameplay phase & not paused) → `update` → `lateUpdate` → FX pools → atmosphere → render → `input.endFrame()`. While `game:paused` systems still run but with **dt = 0** — unless the event carries `freeze: false` (multiplayer pause menu), in which case dt keeps flowing. Post chain: RenderPass → UnrealBloomPass(0.35 / 0.45 / 0.85, half-res) → OutputPass; `setPostProcessing(false)` falls back to plain render, and a perf guard disables bloom automatically after sustained slow frames in the first 90 s. Listens `world:ready` → picks a palette from the seed, `game:abort` → clears FX. |
| `Atmosphere.ts` | Directional sun with 2048 shadow map, ±60 m ortho frustum that follows `ctx.player.position` (snapped to a 2 m grid to avoid shimmer), hemisphere fill (intensity 1.35 so shadowed ground/characters stay readable), `FogExp2` (~250 m visibility), sky dome. `applySeed(seed)` picks one of `SKY_PALETTES`. `setSpaceMode(on)` (ship hub): hides the sky dome, black background, fog 0, cool dim key/hemi; `applySeed` restores. Exposed as `scene.userData.atmosphere` so `hub/` can call it without importing `core/`. |
| `Sky.ts` | Gradient sky dome ShaderMaterial (zenith/horizon/ground, horizon haze, sun disc + glow, faint stars where dark). Follows the camera. `SKY_PALETTES`: amber-dusk, cold-blue, toxic-green, rust-storm, pale-noon (colours, fog density, sun direction, exposure). |
| `util/MathUtil.ts` | `damp/dampVec3/dampAngle`, `smoothDamp` (critically damped spring), easings, `noise1`, `randomInCone`. |
| `fx/ParticlePool.ts` | Fixed-capacity CPU-simulated `THREE.Points` pool (per-particle velocity, gravity, drag, size/colour/alpha over life, optional ground plane). Additive or alpha blending. Packed swap-remove, draws only the alive range. On-screen point size is capped (`uMaxSize` ≈ 8.5 % of viewport height) so close-range dust never becomes giant blobs. |
| `fx/ParticleBurst.ts` | Recipes: `sparks`, `dust`, `groundBlast`, `fireball`, `smoke`, `ichor`, `thruster`, `casing`. |
| `fx/TracerPool.ts` | Pooled camera-facing additive quads for bullet streaks (moving head/tail or full segment), fading over life. |
| `fx/FlashPool.ts` | Pool of 6 point lights + additive glow billboards (muzzle flashes, explosions, pod impact). |
| `fx/FxManager.ts` | Singleton owning the pools (`additive`, `alpha`, `tracers`, `flashes`). Installed by Engine; `FxManager.get()` used by player/weapons (same owner). Updated after `lateUpdate`. |
| `index.ts` | Barrel. |

Notes
- `three/addons/postprocessing/*` is used for bloom. Everything else is procedural.
- Only `src/player` and `src/weapons` import `@/core/fx` and `@/core/util` (same author); other folders should stay on `@/shared`.
