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


## 2026-09-08 — 화면 설정 hooks

`Engine` gained two shallow display knobs for the new 설정 > 화면 설정 section (driven from `main.ts` off
`ui:displayChanged`; ui/ must not import core/):

- **`setShadows(enabled)`** toggles `atmosphere.sun.castShadow`, **not** `renderer.shadowMap.enabled`. Flipping the
  renderer flag invalidates every material's shader and would need a `needsUpdate` sweep of the whole scene; the sun
  is the only shadow caster, so turning *it* off costs one boolean, skips the shadow-map pass, and recompiles nothing.
  `hasShadows` getter.
- **`setResolutionScale(scale)`** multiplies the constructor's `min(devicePixelRatio, 1.5)` cap by 0.5…2 and resizes.
- `setPostProcessing(true)` now also sets `perfChecked`, so an explicit 화면 효과 choice is not undone by the
  sustained-slow-frames guard that disables bloom on its own.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **Phase 11** — `Atmosphere.applyPlanet(def)` — 행성이 `SkyPalette` 를 **이름으로** 고르고(시드 추첨과의 암묵적 인덱스 짝짓기 폐기) `fogDensity × fogMul` 을 적용하며, `fog:false` 행성은 포그 0 + 배경을 하늘 `horizon` 색으로. `Engine` 은 `world:ready.planet` 이 있으면 `applyPlanet`, 없으면 기존 `applySeed`

- **2026-09-09 (대기 오버라이드)** — `Atmosphere.setOverride(fogMul, color, blend)` 와 `Engine` 의
  `atmo:override` 구독. 환경 재해(`world/Hazard`)가 시야를 좁히는 **유일한 통로**다. 팔레트가 정한 포그
  농도 · 색을 `captureBase()` 로 떠 두고 오버라이드를 그 **위에** 얹으므로, `applyPalette` /
  `applyPlanet` / `setSpaceMode` 로 하늘이 갈려도 오버라이드가 어긋나지 않는다 (세 곳 모두 끝에서
  `captureBase()` 를 부른다). `game:abort` 는 `{1, null, 0}` 으로 되돌린다. 포그가 없는 맑은 행성
  (`fog:false`, 배경이 `horizon` 색)에서는 배경을 건드리지 않는다 — 포그 농도만 0 에서 출발해 오른다.
