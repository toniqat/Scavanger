# src/core — Engine, atmosphere, shared FX pools

Owner: `Engine`. Publishes `ctx.scene / ctx.camera / ctx.renderer` (via `GameContext`) and, since 2026-09-10, `ctx.shaders` (`ShaderWarmup`, set in the constructor — before any system `init`), and runs the main loop.

| File | Purpose |
|---|---|
| `Engine.ts` | `Engine(canvas, uiRoot)`: WebGLRenderer (sRGB, ACES, PCFSoft shadows, pixelRatio ≤ 1.5), Scene, PerspectiveCamera(70), `GameContext`, input binding. `addSystem()`, `start()` (calls `init` on all systems, then rAF loop). Frame: dt clamp ≤ 0.05 → `ctx.time`, `ctx.missionTime` (gameplay phase & not paused) → `update` → `lateUpdate` → FX pools → atmosphere → `shaders.update()` → `shaders.beforeRender()` (light budget + a queued whole-scene warm-up) → render (**skipped while `shaders.holding`**, and sim dt is 0 exactly like a freeze pause) → `input.endFrame()`. While `game:paused` systems still run but with **dt = 0** — unless the event carries `freeze: false` (multiplayer pause menu), in which case dt keeps flowing. Post chain: RenderPass → UnrealBloomPass(0.35 / 0.45 / 0.85, half-res) → OutputPass; `setPostProcessing(false)` falls back to plain render, and a perf guard disables bloom automatically after sustained slow frames in the first 90 s (**2026-09-11**: alive again — see below; `setPostProcessing` / `setShadows` act only on a changed value and hold the frame for the recompile). Listens `world:ready` → picks a palette from the seed + `shaders.holdForScene()` (2026-09-10), `game:abort` → clears FX. |
| `LightBudget.ts` | **점광원 개수 고정** (2026-09-10). `SCENE_POINT_LIGHT_BUDGET` 개의 intensity 0 · 검정 · 도달거리 1 mm 여분 광원(`LightBudget` 그룹)을 들고, 매 프레임 그리기 직전에 진짜 점광원을 세서(`traverseVisible` − 켜진 여분) 모자란 만큼만 여분의 `visible` 을 켠다 — 셰이더 프로그램 키의 `numPointLights` 가 세션 내내 같다. 진짜 광원이 예산을 넘으면 그 값마다 한 번 경고. `contentCount()` · `padsShown` · `countVisiblePointLights(root)`. 디버그: `__game.lights`. **2026-09-11**: 예산 23 → **25** (레이드 = 상주 15 + 패드 3 + 콘솔 3 + 구조물 풀 4). |
| `ShaderWarmup.ts` | **`ctx.shaders`** (계약 `shared/render`, 2026-09-10). `warm(root, replaces?)` = 컴포저의 렌더 타깃을 잠깐 바인딩하고, `root` 가 들어오고 `replaces` 가 빠진 뒤의 점광원 개수로 여분을 맞춘 채 `renderer.compile` (씬 밖 오브젝트는 `compile(root, cam, scene)`, 씬 안이면 씬 전체) → 모은 머티리얼의 `currentProgram.isReady()` 를 **Engine 프레임마다** 확인해 resolve (폐기된 머티리얼 = 준비됨 — `compileAsync` 의 `setTimeout` 폴링이 거기서 던졌다, `SHADER_WARMUP_TIMEOUT_S` 넘으면 false). `holdForScene()` = 호출한 순간부터 `holding`, 이번 프레임 끝(`beforeRender`)에 씬 전체를 컴파일하고 끝날 때까지 hold. `hold(promise)`. 디버그: `__game.shaders` (`pendingJobs`). |
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
  renderer flag would also need a `needsUpdate` sweep of the whole scene; the sun is the only shadow caster, so turning
  *it* off skips the shadow-map pass. (2026-09-11 정정: 이것도 **재컴파일한다** — 아래 C-44 절.) `hasShadows` getter.
- **`setResolutionScale(scale)`** multiplies the constructor's `min(devicePixelRatio, 1.5)` cap by 0.5…2 and resizes.
- ~~`setPostProcessing(true)` now also sets `perfChecked`~~ — 2026-09-11 에 바뀌었다 (아래). 부팅 때의 설정 발행까지
  `perfChecked` 를 세워 guard 가 한 번도 돌지 않았다.

## 2026-09-11 — 화면 설정 토글은 값이 바뀔 때만 · hold 한다 · perf guard 되살림 (C-44)

`main.ts` 는 **모든** `ui:displayChanged` 마다 `setPostProcessing` · `setShadows` · `setResolutionScale` 을 부른다 —
부팅 때 저장된 설정 발행(`SettingsMenu.bind`), 전체화면 토글, 해상도 변경도 전부다. 그래서 둘 다 **실제로 바뀐 값만**
처리한다.

- **그림자**: `sun.castShadow` 를 바꾸면 three.js 가 lit 머티리얼의 프로그램 키 `shadowMapEnabled`
  (`WebGLPrograms` — "그림자를 드리우는 광원이 하나라도 있나") 를 바꿔 **전부 다시 컴파일**한다. 예전 주석의
  "recompiles nothing" 은 틀렸다. 바뀔 때 `shaders.holdForScene()` — 컴파일은 그 프레임 끝에 몰아서, 그리는 것은 끝난 뒤.
- **블룸**: 켜고 끄면 씬이 그려지는 타깃이 컴포저 버퍼 ↔ 캔버스로 바뀌고 프로그램 키의 색공간 · 톤매핑이 그
  타깃을 따르므로 역시 전부 다시 컴파일한다. 실제 그리기 경로(`isPostProcessing`)가 바뀔 때만 hold 한다.
  `requestedPost` = 설정이 마지막으로 요청한 값 — 같은 값이 다시 오면 아무것도 안 한다. 그래서 perf guard 가 끈
  블룸을 뒤이은 전체화면 토글이 **다시 켜지 않는다**.
- **perf guard**: `perfChecked` 는 이제 **플레이어가 블룸을 실제로 바꿨을 때만** 선다. 부팅 발행은 같은 값이라 세우지
  않으므로 guard 가 되살아났다(첫 90 초, dt ≥ 0.05 프레임이 240 넘게 쌓이면 끈다). hold 중인 프레임은 세지 않고,
  끌 때도 `applyPost` 를 거쳐 hold 한다. 끈 사실을 설정 화면에 되돌려 쓰지는 않는다 — `ui:displayChanged` 는 ui → core
  한 방향뿐이라 설정 행은 `켬` 으로 남고, 플레이어가 블룸을 한 번 바꾸면 그 선택이 이긴다.
- 검사: `scripts/smoke-lights.mjs` — 부팅 뒤 `perfChecked false`, 레이드에서 같은 값 재발행 → hold 없음, 그림자 · 블룸 ·
  되돌리기 각각 → 그 순간 `shaders.holding` true → 풀린 뒤 몇 프레임 `renderer.info.programs.length` 불변, 그리고
  `perfChecked true`.

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

- **2026-09-09 (오버라이드가 맑은 행성에서도 걸린다)** — `applyOverride` 의 농도 계산이 곱셈에서 **보간**으로
  바뀌었다: `density = base + (target − base) × t`, `target = (base > 0 ? base : palette.fogDensity) × fogMul`.
  포그가 있는 행성에서는 `lerp(base, base × mul, t)` 라 **예전 곱셈식과 값이 같다**. 바뀐 것은 `PlanetDef.fog:false`
  인 **맑은 행성**(카민 I)뿐인데, 거기는 `baseDensity` 가 0 이라 무엇을 곱해도 0 이었고 그 행성의 모래 폭풍 안에서
  시야가 전혀 좁아지지 않았다. 배경색도 같은 `t` 로 `baseBg → fog.color` 를 넘어가므로 맑은 행성의 horizon 배경이
  `t=0` 에서 그대로 지켜진다 (포그 있는 행성은 `baseBg === baseColor` 라 예전과 동일).

- **2026-09-10 (점광원 예산 · 셰이더 선컴파일)** — `LightBudget` · `ShaderWarmup` 신규. `Engine` 이 `ctx.shaders` 를
  게시하고, 프레임마다 `shaders.update()` → `shaders.beforeRender()` 뒤 `holding` 이면 그리지 않는다(시뮬레이션 dt 0,
  `ctx.time` 은 흐른다). `world:ready` 에 `holdForScene()`. 멀티 도킹 · 강하에서 3초씩 멈추던 렉이 셰이더
  컴파일이었고, 그 절반은 장면마다 점광원 개수가 달라(함선 27 · 컷씬 15 · 공유 함선 29 · 행성 20) 이미 컴파일한
  프로그램을 못 쓴 탓이었다. 이제 개수는 세션 내내 23 이고 새 장면은 컴파일이 끝난 뒤에 그린다.
  ⚠ 위 `setShadows` 절의 "recompiles nothing" 은 **틀렸다** — 프로그램 키의 `shadowMapEnabled` 가 그림자를
  드리우는 광원 수를 보므로 해의 `castShadow` 를 끄면 lit 머티리얼이 한 번 전부 다시 컴파일된다. 자동 블룸 끄기
  (`perfGuard`)도 렌더 타깃이 캔버스로 바뀌어 같은 일이 난다 (TODO C-44 → 2026-09-11 에 처리).

- **2026-09-11 (C-44)** — `setPostProcessing` · `setShadows` 가 값이 실제로 바뀔 때만 동작하고 `holdForScene()` 으로
  hold, `requestedPost` 로 같은 값 재발행 무시, perf guard 되살림(사용자 조작만 `perfChecked`, hold 프레임 제외, 끌 때도
  hold). 위 C-44 절 · `smoke-lights` 단언 7개.
