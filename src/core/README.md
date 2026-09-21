# core/ — Engine, main loop, atmosphere, render budget, shared FX pools

`Engine` owns the WebGL renderer, scene, camera, post-processing and the frame loop, and holds the system registry.
Its constructor publishes `ctx.scene` / `ctx.camera` / `ctx.renderer` (via `GameContext`), `ctx.shaders`
(`ShaderWarmup`) and `ctx.outline` (`Outline`) before any system `init` runs. Gameplay folders must not import
`core/` except the FX pools and math helpers (`@/core/fx`, `@/core/util/MathUtil`); `ui/` never imports it — display
settings reach the engine through `main.ts` (`ui:displayChanged`).

## Files

| File | Responsibility |
|---|---|
| `Engine.ts` | `Engine(canvas, uiRoot)`: renderer (sRGB, ACES, PCFSoft shadows, pixel ratio capped), scene, camera, `GameContext`, input binding, `addSystem()` / `start()`. Post chain RenderPass → UnrealBloomPass → outline passes → OutputPass. Display knobs `setPostProcessing` · `setShadows` · `setResolutionScale`, bloom perf guard, `debugForcePerfGuard()`. Palette on `world:ready`; clears FX + atmosphere override on `game:abort`. Owns the indoor probe (`stepIndoorLight` · `indoorApplies` · `probeIndoor`). |
| `LightBudget.ts` | Keeps the visible point-light count constant: `SCENE_POINT_LIGHT_BUDGET` padding lights (intensity 0) switched on to fill the gap each frame. `countVisiblePointLights(root)`, `contentCount()`, `padsShown`. Engine field `lights`. |
| `ShaderWarmup.ts` | `ctx.shaders` (`ShaderWarmupRef`, `src/shared/render.ts`): `warm(root, replaces?)`, `holdForScene()`, `hold(promise)`, `holdFor(promise, timeoutS)`, `holding`, `pendingJobs`, `compileProgress`; `update()` / `beforeRender()` called by Engine. Times out after `SHADER_WARMUP_TIMEOUT_S` (or the caller's own cap). |
| `Outline.ts` | `ctx.outline` (`OutlineRef`, `src/shared/render.ts`): screen-space outline channels `hover` (white) and `selected` (green) via one `OutlinePass` per channel. Empty channel = pass disabled = zero cost. `renderDirect` draws on the canvas path when bloom is off; `warm()` pre-links its programs. |
| `Atmosphere.ts` | Sun (shadow frustum follows the player on a snapped grid), hemisphere fill, `FogExp2`, sky dome. `applySeed(seed)`, `setSpaceMode(on)` (hub look), `setOverride(fogMul, color, blend)` (hazard visibility), `stepIndoor(dt, target)` / `resetIndoor()` (the indoor view correction). Exposed as `scene.userData.atmosphere` so `hub/` can call it without importing `core/`. |
| `Sky.ts` | Gradient sky dome shader (horizon haze, sun disc, stars); `SKY_PALETTES`, `SkyPalette`. |
| `util/MathUtil.ts` | `damp` / `dampVec3` / `dampAngle`, `smoothDamp`, easings, `noise1`, `randomInCone`. |
| `fx/ParticlePool.ts` | Fixed-capacity CPU-simulated `THREE.Points` pool (additive or alpha); on-screen point size capped. |
| `fx/ParticleBurst.ts` | Burst recipes: `sparks`, `dust`, `groundBlast`, `fireball`, `smoke`, `ichor`, `thruster`, `casing`. |
| `fx/TracerPool.ts` | Pooled camera-facing additive quads for streaks. |
| `fx/FlashPool.ts` | Fixed pool of point lights + glow billboards (muzzle flash, explosions, impacts). |
| `fx/FxManager.ts` | Singleton owning the pools (`additive`, `alpha`, `tracers`, `flashes`); `FxManager.get()`. Updated after `lateUpdate`. |
| `fx/index.ts`, `index.ts` | Barrels. |

## Public API

- `ctx.shaders`, `ctx.outline` — see `src/shared/render.ts`.
- Events consumed: `world:ready` (palette + `holdForScene()`), `game:abort`, `game:paused {paused, freeze}`,
  `atmo:override {fogMul, color, blend}` (the only path that narrows sky/fog visibility — hazards emit it; `world/` never touches `scene.fog`),
  `ui:cinematic {active}` (suspends the indoor correction).
- Events emitted: `render:autoAdjusted {bloom:false, reason:'perf'}` — at most once per boot, when the perf guard turns bloom off.
- Called from `main.ts`: `setPostProcessing`, `setShadows`, `setResolutionScale` (on every `ui:displayChanged`).
- Debug: `window.__game` is the Engine (`__game.lights`, `__game.shaders`, `__game.debugForcePerfGuard()`).

Frame order (`Engine.frame`): dt clamp (smoke clock: ≤ 4 sub-steps) → per step `ctx.time` / `ctx.missionTime` → systems `update` → `lateUpdate` → FX pools →
indoor step → atmosphere → `shaders.update()` → `shaders.beforeRender()` → `outline.warm` → render (skipped while
`shaders.holding`) → `input.endFrame()`.

## Rules

- **The visible point-light count must never change during play.** three.js keys shader programs on `numPointLights`,
  so a change recompiles every material in the scene (multi-second stalls). Keep lights in the scene and set
  `intensity` to 0; toggle visibility on a sibling group, not on a parent of the light. Real lights above the budget
  log a warning and fail `smoke-lights`. — `LightBudget.ts`, `fx/FlashPool.ts`, `SCENE_POINT_LIGHT_BUDGET` in `data/constants.csv`
- **The recount stays exact, and stays every frame.** `countVisiblePointLights` is an explicit stack walk rather
  than `traverseVisible` because it crosses the whole scene (≈3 978 nodes in a raid) on every frame and the
  recursive version pays a method call plus a closure call per node. Recounting on a dirty flag or on an interval
  was considered and **rejected**: point lights really do enter and leave the scene mid-raid (`extraction/Ship`,
  `player/Hellpod`, `game/parts/Leader`), and one frame with the count wrong is two recompiles — up and back. A
  cheaper exact recount would need a registry every light is created through, which is 11 call sites across seven
  folders and a check script; it has never been worth 0.14 ms. (2026-09-20 — `docs/PERF.md` perf Phase C · B3.)
- **The smoke clock never runs for a player.** Under browser automation (`navigator.webdriver`, not the Electron UA, read
  once at construction) a frame longer than `MAX_DT` is simulated as up to `SMOKE_MAX_SUBSTEPS` sub-steps of ≤ `MAX_DT`
  and drawn once, so a smoke's game clock keeps pace with the wall clock below 20 fps (E-12 — that floor is what capped
  the verify runner's lanes). No system ever sees a dt above `MAX_DT`; input edges are held for the **last**
  sub-step (`Input.holdEdges`), so a press lands in exactly one — the one that is drawn; the perf guard judges the real frame. `__game.simWarp` (smoke
  clock only) runs game time faster than wall time through the same sub-steps. In play one step, cut to `MAX_DT`, as
  always. — `Engine.frame` / `simulate`
- **Compile through `ctx.shaders`, never `renderer.compile` mid-update.** The program key's colour space / tone mapping
  comes from the bound render target; compiling while the canvas is bound builds variants that are never used. — `ShaderWarmup.warm`
- A shader hold freezes simulation exactly like `game:paused {freeze}` (systems run with dt 0, `ctx.time` still flows);
  `freeze: false` (multiplayer pause) keeps dt flowing. — `Engine.frame`
- A hold that is not a shader compile brings its own cap: `hold()` uses `SHADER_WARMUP_TIMEOUT_S`, which is shorter than
  the raid-entry loading wait, so `game/parts/LoadGate` takes `holdFor(ready, RAID_LOAD_TIMEOUT_S + RAID_LOAD_HOLD_MARGIN_S)`.
  Anything that holds the frame on something other than the driver must pass its own timeout. — `ShaderWarmup.holdFor`
- `compileProgress` is 0 while a scene compile is only **queued** (`holdForScene` before the frame's `beforeRender`), then
  ready/initial materials, then 1. Returning 1 for the queued frame makes a loading gauge start full and fall back. — `ShaderWarmup.compileProgress`
- Display toggles act only on a changed value, and a change holds the frame: both shadows (`shadowMapEnabled` program
  key) and bloom (render target switch) recompile every lit material. `requestedPost` is the last requested bloom value;
  a repeat is a no-op, so a guard-disabled bloom is not re-enabled by an unrelated fullscreen/resolution publish. — `Engine.setPostProcessing` / `setShadows`
- Perf guard: only a player's real bloom change sets `perfChecked`; the guard sets `requestedPost = false` when it fires
  so the settings menu's effective-value publish is a no-op and the player's re-enable counts as a change. — `Engine.perfDisableBloom`
- `outline.warm` runs outside the draw branch so new outline programs link during a hold, not right after it. Outline
  renders disable `shadowMap.autoUpdate` and restore every `visible` flag they touch. — `Outline.ts`
- **Indoors is brighter without a light** (2026-09-21, user's request 「레이드 실내가 어둡다」). The lift is a factor on the
  **hemisphere fill that already exists** (`INDOOR_LIGHT_AMBIENT_MUL`) plus a thinner fog (`INDOOR_FOG_MUL`), crossed
  over linearly across `INDOOR_LIGHT_FADE_S` so a doorway cannot flicker. Adding a light instead is forbidden — the
  raid budget has zero spare and the count is a program key (rule above). It is **local and silent**: nothing on the
  wire, other clients unaffected. — `Atmosphere.stepIndoor` / `applyOverride`, `Engine.stepIndoorLight`
- The indoor factor is laid on **after** the `atmo:override` result, not folded into it: a roof must soften a
  sandstorm, never cancel it. Fog **colour** and the background are left alone — they are the sky. `captureBase`
  takes `baseHemi` and drops the indoor state, so a new palette / `setSpaceMode` never inherits the last roof. — `Atmosphere.applyOverride`
- The probe is one upward ray from the eye (`world.raycast`, `INDOOR_PROBE_UP_M`) at `INDOOR_LIGHT_FADE_S / 4` — the
  rate is **derived from the fade**, so the state is at worst a quarter of a crossfade late (invisible) for a handful
  of rays per second instead of one per frame. It is skipped outside a gameplay phase, in the hub / `spaceMode`,
  during `liftoff` or any `ui:cinematic`, and before `world.ready`. — `Engine.indoorApplies` / `probeIndoor`
- Only the FX/util barrels are shared; `hub/` reaches the atmosphere via `scene.userData.atmosphere`, not an import.

## Decisions

Choices made against an alternative that may be proposed again — the choice, then what was rejected and why. Overturned → edit
the line; a choice with nothing left to reject → delete it. Everything else about a change lives in `git log`.

- **Indoors is lit by lifting hemisphere / ambient and thinning fog, local only, on top of `atmo:override`** (2026-09-21). Rejected:
  a new light (zero spare budget, recompiles every material).
- **Bloom stays on by default** (the guard turns it off under load; it measured free on vsync).
- **`LightBudget` recounts every frame; only the walk got cheaper.** Rejected: a dirty flag from pool owners; a recount interval.

## Recent changes

Last 5 only — older: `git log -- src/core`.
- 2026-09-21 — E-12 smoke clock: under `navigator.webdriver` a long frame is simulated in ≤ `MAX_DT` sub-steps (cap 4) and drawn once; `Engine.simulate` split out of `frame`, `simWarp` hook. Play is unchanged.
- 2026-09-21 — Indoors is lifted locally: `Atmosphere.stepIndoor` scales the existing hemisphere fill and thins the fog over `INDOOR_LIGHT_FADE_S`, driven by `Engine`'s upward eye probe at a quarter of that fade. No light added, nothing on the wire.
- 2026-09-20 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels and decision headings kept verbatim in backticks / 「」, no string literal touched.
- 2026-09-20 — `countVisiblePointLights` walks an explicit stack instead of `traverseVisible` and skips the padding group it already counts; `x:lightBudget` 0.156–0.157 → 0.132–0.142 ms/frame in S2. The count stays exact and per-frame — see the rule above for why a flag or an interval was rejected (`docs/PERF.md` perf Phase C · B3).
- 2026-09-15 — `ShaderWarmup.holdFor(ready, timeoutS)` and `compileProgress` for the raid-entry loading gate.
