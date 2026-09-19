# Performance plan — frame hitches with many bodies

**Status:** **Phase 0 measured on 2026-09-19** (`scripts/perf-measure.mjs`, headful Chrome on the real GPU). The static
analysis of 2026-09-18 ranked by reasoning; the numbers below replace that ranking, and several of its findings are
**struck**. Nothing has been changed in `src/` yet. Line numbers are from the 2026-09-18 working tree and may drift.

**Symptom (user report):** the frame rate drops or stutters badly (a) with several other bodies present — remote human
players, or the 3 android squadmates — and (b) when many bugs are alive, worst of all at the moment a new group spawns.

**One-line diagnosis, after measuring:** **the render block is the frame.** Submitting the scene costs ~4 µs per draw
call on the CPU, so a raid with 60 bugs alive spends **7.6 ms of its 16.7 ms budget inside `renderer.render`** — and
every frame that actually dropped was render-dominated (11–30 ms). Second, and cheap to fix, is a **forced layout** the
HUD triggers once per frame (1.1 ms/frame with 160 bodies, 7.3 ms at worst). The spawn spike the analysis expected is
**not** what the user sees: building 60 bodies in one frame costs 5.8 ms and the natural patrol tick costs 0.1 ms.

---

## How to work this plan

1. **Read first:** `CLAUDE.md` §4.1 (no numbers in code → csv), §4.5 (never change the point-light count at runtime;
   every scene compiles through `ctx.shaders`), §6 (verify). Then the README of every folder you touch.
2. **Re-measure around every phase**: `node scripts/perf-measure.mjs --label <before|after-phaseN>`, same options both
   times, and put the delta in the commit message. The harness changes no game code — it wraps the live page.
3. **Ask the user before Phase 1** (`AskUserQuestion`): the visual trade-offs in [Decisions needed](#decisions-needed)
   are theirs, not ours.
4. **One phase = one verify cycle** (`npm run verify`; `verify:all` at the end of the session). Record results as
   `CLAUDE.md` §6 says: numbers and what changed → commit message; new invariants → comment above the code; the user's
   choices → `docs/DECISIONS.md`; and once every phase is done or retired this file is **deleted** (plans do not live
   on — `docs/plans` was retired in `dd1fd69`).
5. Parallel agents: follow the memory rule — lead owns vite/relay; agents run smokes with `--only --keep-relay
   --log-dir`; nobody but the lead runs `e2e:mp`.

---

## Phase 0 — measured (2026-09-19)

### How

`node scripts/perf-measure.mjs` (see `scripts/README.md`). It wraps, on the live page, every system's `update` /
`lateUpdate`, `renderer.render` / `compile`, `ShaderWarmup.beforeRender` (the light budget), `Outline.prepare`,
`AudioSystem.play`, `EnemySystem.spawn` / `ensureCapacity`, `AmbientSpawner.update`, each HUD widget's `lateUpdate`,
and `Engine.frame` itself. Frame cadence is the rAF timestamps; JS cost is a timer around the frame body. A frame whose
JS runs past one 60 Hz interval gets a per-mark **autopsy**. Scenario actions are queued to run *inside* a frame, so a
spawn's cost lands in that frame's number.

**Headful, deliberately**: a headless Chrome does not present on a real swap chain (the smokes even drive
`__game.frame` from a `setInterval` when its rAF stalls), so its cadence is meaningless. Audio is silenced with
Chrome's `--mute-audio`, which mutes the output stream while the page still builds every WebAudio node — the in-game
volume would have removed those graphs from the measurement.

**Machine**: Windows 11 · Ryzen 7800X3D · RTX 4080 SUPER (ANGLE D3D11) · Chrome 1280×720, dpr 1, resolution scale 1,
bloom **on**, shadows **on** (`Engine.perfGuard` never fired — no window was long enough). Planet `tundra` (threat 2),
seed 7001, 20 s windows. Logs: `scripts/logs/perf/phase0-2026-09-19.json`, plus the two targeted runs
`phase0-s2-render.json` (render block split) and `phase0-s2-layout.json` (forced layout confirmed).

**S5 (relay, two humans) was not run** — the user scoped this session to S1–S4. Nothing here measures a replica.

### Results

| Scenario | Host p50 / p95 / max ms | Frames > 50 ms | Draw calls | Replica p95 ms | Dominant cost (from the autopsy) |
|---|---|---|---|---|---|
| S1 idle (99 bodies, 56 of them eggs) | 16.7 / 16.8 / 16.9 | 0 | 1 142 | not measured | render block 4.2 ms of 4.9 ms js; all systems together 0.83 ms |
| S2 + 60 bugs (158 bodies) | 16.7 / 16.8 / 66.8 | 0–2 | 1 790–1 932 | not measured | `renderer.render` **7.6 ms/frame** (worst 32.3) · forced layout **1.14** · `EnemySystem.update` 1.1–1.3 |
| S3a burrow ×8 in one frame | 16.7 / 16.8 / 33.5 | 0 | 1 338 | not measured | the 8 spawns are **4.9 ms** cold / 3.9 warm; the one dropped frame was a 16.9 ms `EnemySystem.update` **unrelated to them** |
| S3b natural patrol tick ×6 | 16.7 / 16.8 / 16.9 | 0 | 733 | not measured | nothing — the tick costs **0.0–0.1 ms** |
| S4 3 androids + a pulled group | 16.7 / 16.8 / 16.9 | 0 | 1 555 | not measured | one **10.0 ms** `AllySystem.update` at first contact, then 0.055 ms/frame |

Heap: 18–55 MB/s allocated, ~2.4 GC drops/s, peak 150–213 MB. **No dropped frame in any scenario was attributable to
GC** — every one of them is explained by its marks.

### What the numbers say

- **On this machine nothing sustains a drop.** p50 and p95 are pinned to the 60 Hz vsync in every scenario. What the
  user feels is **individual frames**, not a lower frame rate.
- **The render block is the frame.** `renderer.render` (the scene draw plus the composer / outline passes) is
  4.2 ms/frame at 1 142 draw calls and 7.6 ms/frame at ~1 900 — **≈ 4 µs per draw call, on the CPU**, not the GPU.
  Every frame that actually dropped had 11–30 ms of it. This is finding **B1**, and it is the whole story.
- **A forced synchronous layout, once per frame.** `WorldMarkers.lateUpdate` draws 2–3 extraction diamonds, yet its
  cost moved 25× with the body count (0.044 ms at S1 → 1.0 ms at S2). Reading `ctx.uiRoot.clientWidth` one line earlier
  moved the whole cost into that read (`x:layoutFlush` 1.14 ms/frame, worst 7.3 ms) and `WorldMarkers` fell off the
  list: it is the first layout read after a frame of HUD style writes, so it pays for laying out the whole UI. **New
  finding — nowhere in the 2026-09-18 inventory.**
- **The spawn spike is not the problem.** 60 bodies built in one frame = 5.8 ms; 8 burrowing bodies = 4.9 ms with a
  cold pool and 3.9 ms with a warm one (**≈ 0.12 ms per body** for the whole rig, so pre-warming buys ~1 ms on a group
  of 8); the ambient patrol tick, placement search included, is 0.0–0.1 ms. **A1 · A2 · A3 · A4 are struck.**
- **What does spike is a handful of one-off calls**: `EnemySystem.update` 16.9 ms once per raid (S3a and S3b both saw
  one, neither on a spawn job frame), `AudioSystem.play` 16.3 ms once (a first synth build — `x:audioPlay` averages
  0.27 ms over 5 600 calls), `AllySystem.update` 10.0 ms on the frame androids first make contact. Each loses 1–3
  frames. Their cause is not yet known; finding them is Phase 3.
- **Android AI is cheap.** 3 androids cost 0.055 ms/frame — B2's per-frame `queryNear` / `pickCoverSpot` is not worth
  a phase. The old Phase 3 is struck down to its one-off.
- **Bug footsteps are cheap.** `AudioSystem.play` is 0.27 ms/frame across 5 600 calls in S2. B5's scan-before-range-gate
  is real but small.
- **Garbage is not the stutter.** B6 stays on the list only as tidiness.

**Exit criterion for Phase 0: met.** The table is full and the phases below are re-ranked.

---

## Findings inventory — measured verdicts

**A. Spawn-frame spikes**

| # | Finding | Measured | Verdict |
|---|---|---|---|
| A1 | Pools are never pre-warmed: `acquire` builds `new Enemy` on the spawning frame (`src/enemies/parts/Pool.ts:184-211`, `Enemy.ts:507-519`, `models/BugModel.ts:375-473`) | cold 4.9 ms vs warm 3.9 ms for 8 bodies → **0.12 ms/body** | **struck** — a group of 8 would gain ~1 ms, and the frame never dropped |
| A2 | Shared geometry baked lazily on a type's first appearance (`BugModel.ts:77-133`, `RogueModel.ts:85-142`, `EggModel.ts:166-173`) | not isolated; a 16.9 ms `EnemySystem.update` did fire once per raid | **open, folded into Phase 3** — the prime suspect for that one-off |
| A3 | Placement search raycasts per living player per candidate (`Spawner.ts:236-253, 273-324, 351-364, 532-540`) | patrol tick 0.0–0.1 ms total | **struck** |
| A4 | `ensureCapacity` rescans all active enemies per recycled corpse; `despawn` uses `indexOf` (`Pool.ts:115-143, 219`) | never above the noise floor | **struck** |
| A5 | `burrow_emerge` synthesises ~15 sources per bug (`audio/Synth.ts:1678-1690`, `AudioSystem.ts:1076-1104`) | 0.27 ms/frame over 5 600 calls; **one 16.3 ms call** | **one-off only** → Phase 3 |
| A6 | One `ee spawn` JSON send per body (`Pool.ts:154-158`, `net/HostSync.ts:158-171`) | solo only, not measured | **open, needs S5** |
| A7 | First-draw material init per cloned material (`core/ShaderWarmup.ts:129-157`) | no compile spike seen (`x:rendererCompile` never appeared) | **struck** |

**B. Sustained per-body cost**

| # | Finding | Measured | Verdict |
|---|---|---|---|
| B1 | Draw calls: bug = 17–18 meshes; soldier body ≈ 130 calls; no batching / instancing / LOD (`BugModel.ts:387-471`, `player/SoldierModel.ts:450-470`, `AllyAvatars.ts:191`, `RemoteAvatar.ts:285`) | 1 142 calls → 4.2 ms/frame; 1 932 → 7.6 ms; **≈ 4 µs/call**; every dropped frame render-dominated | **confirmed — #1** |
| **NEW** | **Forced synchronous layout once per frame**: `ctx.uiRoot.clientWidth` in `ui/hud/WorldMarkers.ts:88` is the first layout read after the HUD's style writes | 1.14 ms/frame at 160 bodies, worst **7.3 ms**; 0.044 ms when idle | **confirmed — #2** |
| B2 | Android combat AI per ally per frame (`allies/parts/Combat.ts:58-69, 106-116, 155-161, 190-197`) | 0.055 ms/frame for 3 androids; **one 10.0 ms first-contact call** | **struck** except the one-off → Phase 3 |
| B3 | `LightBudget.update` walks the whole visible scene every frame (`core/LightBudget.ts:7, 55, 75`) | 0.10 ms idle → 0.30 ms at 160 bodies (worst 1.7) | **small, real** → Phase 4 |
| B4 | Enemy AI has no distance LOD or time slicing (`EnemySystem.ts:451-528`, `ai/EnemyAI.ts:614-662`, `parts/Alerts.ts:80-159`) | 0.19 ms at 44 bodies → 0.41 at 99 → **1.29 at 160**; worst call 4.9 ms | **confirmed, #3 sustained** — scales super-linearly, second-biggest system cost |
| B5 | Bug footsteps scan all active enemies before the range gate (`enemies/model.ts:311-341`) | inside `u:enemies` and `x:audioPlay` 0.27 ms/frame | **small** → Phase 4 |
| B6 | Recurring garbage (`HostSync.ts:140-197`, `net/parts/Messages.ts:401`, `ui/hud/Nameplates.ts:117-152`) | 18–55 MB/s, 2.4 GC drops/s, **no spike attributable** | **low** |

**C. Multiplayer / squadmate-specific** — C1 (`SoldierPool.acquire`) and C3 (`ally state` encoding) were not reached
without S5; C2 (a `SoldierModel` per corpse) never fired in these windows; C4 (`snapshotFace`) is ship-only and out of
scope. **All four stay open, and S5 is what would close them.**

---

## Phases (re-ranked by the measurement)

### Phase 1 — cut draw calls and the render block (B1) · `enemies/models`, `player`, `core`
The only finding that is both sustained and present in every dropped frame. ~4 µs per draw call means each 250 calls
removed gives back ~1 ms of a 16.7 ms budget. Needs the user's answers (see Decisions). In order of expected gain:
1. Bug legs: `InstancedMesh` per type for femur + tibia (12 of the 17 meshes), instance matrices written by `animateBug`.
2. Bug: one shared `chitin` material per type instead of a clone per rig (status flash / emissive then needs a
   per-instance path — a vertex-colour attribute or an `InstancedMesh` colour — because `statusEmissive` writes the
   material today).
3. Soldier: `castShadow` only on torso / head / legs (not 43 parts); silhouette clones only for the parts that matter,
   or one merged silhouette geometry per body.
4. Distance LOD for animation (B4 too): beyond a csv distance skip `animateRig` every other frame; beyond another,
   freeze.
- Rules: `core/LightBudget` untouched; `Layers.ENEMY` on every new mesh (raycast); `Xray` overlays are children of the
  pooled rigs (`fx/Xray.ts`) — check they survive instancing; hit capsules do not depend on meshes.
- Verify: `smoke-enemy-alert`, `smoke-blast-occlusion`, `smoke-ally-avatars`, `shots-factions.mjs` for the look, and
  `perf-measure --only s1,s2,s4` for the draw-call and `x:rendererRender` delta.

### Phase 2 — stop the per-frame forced layout (NEW) · `ui`
`WorldMarkers.lateUpdate` reads `ctx.uiRoot.clientWidth` / `clientHeight` every frame, and it is the first layout read
after the HUD has written styles all over the DOM, so it pays for the whole UI's layout: 1.14 ms/frame with 160 bodies
and 7.3 ms at worst. Cache the viewport size and refresh it on `resize` only (every projecting widget wants the same
two numbers — one owner, read once per resize, handed to the widgets). Then re-measure: any remaining cost belongs to
whichever widget reads layout next.
- Verify: `smoke-ui-p6`, `smoke-tactical`, `smoke-extraction` (the pad diamonds), `perf-measure --only s2`
  (`x:layoutFlush` should fall to ~0).

### Phase 3 — the one-off ≥ 10 ms calls · `enemies`, `audio`, `allies`
Three calls, each losing 1–3 frames, each firing once or twice per raid. Find the cause before writing a fix — the
harness's `--spike` autopsy names the mark, not the line, so this phase starts with a DevTools trace of that one frame.
- `EnemySystem.update` 16.9 ms, once per raid, not on a spawn job frame (suspect A2: a type's geometry baked on its
  first appearance, or a nest refill).
- `AudioSystem.play` 16.3 ms once (suspect: the first build of a procedural buffer — pre-build on `world:ready`, which
  is behind the load hold).
- `AllySystem.update` 10.0 ms on first contact (suspect B2's `pickCoverSpot` / `getObstaclesNear` on the transition).
- Verify: `smoke-burrow`, `smoke-allies-core`, `smoke-enemy-allies`, `perf-measure --only s3a,s4` (no spike frame left).

### Phase 4 — the small per-frame scans (B3, B5) · `core`, `enemies`, `audio`
Only worth doing once Phase 1 has freed the budget; together they are ~0.4 ms/frame at 160 bodies.
- `LightBudget`: recount on a flag from the light-pool owners (`hub/interiors/LightPool`, `world/structures`,
  `extraction`) or at a csv interval instead of every frame. The invariant "the shader always sees
  `SCENE_POINT_LIGHT_BUDGET`" must hold on the frame a light appears — read `core/LightBudget.ts`'s header first.
- Footsteps: move the range gate before `getWorldPosition` and `bugStepCrowd`; cache the camera position once per frame
  in `EnemySystem.update`.
- Verify: `smoke-lights` (**must stay green — it enforces the light count**), `smoke-enemy-alert`, `perf-measure --only s2`.

### Phase 5 — S5 and the multiplayer findings (A6, C1, C3) · `net`, `player`, `allies`
Everything the user reported about *other players* is still unmeasured. Extend the harness to two clients through the
relay (the `scripts/e2e-multiplayer.mjs` launch pattern) and measure a replica as well as the host, then decide on
`SoldierPool` pre-fill (C1), the `ally state` encoding (C3) and the `ee spawn` burst (A6).

### Struck by the measurement
The old Phase 1 (pre-warm pools and geometry, A1 · A2 · C1), the old Phase 3 (throttle android AI per frame, B2), the
old Phase 4's search and capacity work (A3 · A4) and the old Phase 6 (garbage, B6). Do not implement them: their cause
was measured and is not in the stutter.

---

## Decisions needed (ask the user at the start of Phase 1)

1. **Soldier shadows:** shadow from every armour plate (today) vs. from body, head and limbs only. Visible difference:
   small plates lose their own shadow.
2. **Silhouette (occlusion outline) for allies / remotes:** keep on every part, or only the torso / head; or off beyond
   a distance.
3. **Enemy animation LOD distances:** at what distance may legs stop animating (they are ~10 cm at 60 m)? Proposal:
   half rate beyond 40 m, frozen beyond 80 m, both csv.
4. **Bloom:** the composer's passes are part of the render block. Is bloom-off an acceptable option to offer, or must
   it stay on?

Struck from this list by the measurement: burrow sound density (one voice per bug costs 0.27 ms/frame) and spreading a
group's spawns over frames (a whole group is 4.9 ms).

Record the answers in `docs/DECISIONS.md` under a 2026-09-xx heading, in Korean titles as the file does.

---

## What this plan does not cover
- The ship (hub) frame rate and `snapshotFace` (C4) — separate scene, separate light pool; only if the user reports it.
- `verify:all` run time (`docs/TODO.md` E-12) — related (page frame cost) but a different goal.
- WebGPU / worker offloading — out of scope until the cheap fixes above are measured.
- Slower machines: every number here is from an RTX 4080 SUPER. The ranking would only get *more* render-bound on
  weaker hardware, but a re-measure there is the honest way to know.
