# Performance plan — frame hitches with many bodies

**Status:** **Phase 0 done (measured 2026-09-19).** Nothing in `src/` has been changed. The 2026-09-18 static analysis
ranked by reasoning; the numbers below replace that ranking and strike six of its findings. Line numbers are from the
2026-09-19 working tree.

**Symptom (user report):** the frame rate drops or stutters badly (a) with several other bodies present — remote human
players, or the 3 android squadmates — and (b) when many bugs are alive, worst of all at the moment a new group spawns.

**One-line diagnosis, after measuring:** **the render block is the frame.** Submitting the scene costs ≈ 4 µs per draw
call on the CPU, so a raid with 60 extra bugs spends **7.6 ms of its 16.7 ms budget inside `renderer.render`** — and
every frame that actually dropped was render-dominated (11–30 ms). Second, and cheap, is **layout thrash**: eleven HUD
widgets read `ctx.uiRoot.clientWidth` and write styles in turn, every frame (1.14 ms/frame with 160 bodies, 7.3 ms at
worst). The spawn spike the analysis expected is **not** what the user sees: 60 bodies built in one frame cost 5.8 ms
and the natural patrol tick costs 0.1 ms.

---

## Next session starts here

1. **Ask the user the four questions** in [Decisions needed](#decisions-needed) (`AskUserQuestion`) — Phase 1 cannot be
   scoped without them, and they are visual trade-offs, not engineering ones.
2. **Take a fresh `before`**, because the baseline logs are git-ignored and the tree has moved on:
   `npm run dev` in one terminal, then `node scripts/perf-measure.mjs --label before-phase1`.
   A headful Chrome window opens and plays S1–S4 by itself; ~7 minutes. Compare its table against
   [Results](#results) below — if it disagrees by more than ~15 %, something changed since 2026-09-19 and the
   ranking must be re-derived before any code is written.
3. **Do Phase 1** ([cut draw calls](#phase-1--cut-draw-calls-and-the-render-block-b1--enemiesmodels-player-core)), then
   `node scripts/perf-measure.mjs --label after-phase1` with the same options and put the delta in the commit message.
4. Phases 2 → 5 in order. Each has a numeric **Done when**; a phase that does not reach it is reported, not padded.

Phase 2 (layout thrash) is independent of the decisions and is the cheapest win in the file — do it first if the user
is not available to answer.

---

## How to work this plan

1. **Read first:** `CLAUDE.md` §4.1 (no numbers in code → csv), §4.5 (never change the point-light count at runtime;
   every scene compiles through `ctx.shaders`), §6 (verify). Then the README of every folder you touch.
2. **Re-measure around every phase** with the same options both times. The harness changes no game code — it wraps the
   live page — so a `before` can always be retaken at the current HEAD.
3. **One phase = one verify cycle** (`npm run verify`; `verify:all` at the end of the session). Record results as
   `CLAUDE.md` §6 says: numbers and what changed → commit message; new invariants → comment above the code; the user's
   choices → `docs/DECISIONS.md`; and once every phase is done or retired this file is **deleted** (plans do not live
   on — `docs/plans` was retired in `dd1fd69`).
4. Parallel agents: follow the memory rule — lead owns vite/relay; agents run smokes with `--only --keep-relay
   --log-dir`; nobody but the lead runs `e2e:mp`.

---

## Phase 0 — measured (2026-09-19) · done

### How

`node scripts/perf-measure.mjs` (options in `scripts/README.md`; the reasoning is in the script's header). It wraps, on
the live page, every system's `update` / `lateUpdate`, `renderer.render` / `compile`, `ShaderWarmup.beforeRender` (the
light budget), `Outline.prepare`, `AudioSystem.play`, `EnemySystem.spawn` / `ensureCapacity`, `AmbientSpawner.update`,
each HUD widget's `lateUpdate`, and `Engine.frame` itself. Frame cadence is the rAF timestamps; JS cost is a timer
around the frame body. A frame whose JS runs past one 60 Hz interval gets a per-mark **autopsy**. Scenario actions are
queued to run *inside* a frame, so a spawn's cost lands in that frame's number. `--only`, `--seconds`, `--spike` and
`--label` are the knobs worth touching.

**Headful, deliberately**: a headless Chrome does not present on a real swap chain (the smokes even drive
`__game.frame` from a `setInterval` when its rAF stalls), so its cadence is meaningless. Audio is silenced with
Chrome's `--mute-audio`, which mutes the output stream while the page still builds every WebAudio node — turning the
in-game volume down would have taken those graphs out of the measurement.

**Machine**: Windows 11 · Ryzen 7800X3D · RTX 4080 SUPER (ANGLE D3D11) · Chrome 1280×720, dpr 1, resolution scale 1,
bloom **on**, shadows **on** (`Engine.perfGuard` never fired — no window was long enough). Planet `tundra` (threat 2),
seed 7001, 20 s windows.

**Logs are local only.** `scripts/logs/` is git-ignored, so `phase0-2026-09-19.json`, `phase0-s2-render.json`,
`phase0-s2-layout.json` and `phase0-census.json` exist on the machine that ran them and nowhere else. Everything worth
keeping from them is transcribed below — a later session re-takes its own `before` rather than looking for those files.

**S5 (relay, two humans) was not run** — the session was scoped to S1–S4. Nothing here measures a replica, which is why
symptom (a) is still unreproduced and A6 · C1 · C3 are still open.

### Results

| Scenario | Host p50 / p95 / max ms | Frames > 50 ms | Draw calls | Replica p95 ms | Dominant cost (from the autopsy) |
|---|---|---|---|---|---|
| S1 idle (99 bodies, 56 of them eggs) | 16.7 / 16.8 / 16.9 | 0 | 1 142–1 198 | not measured | render block 4.2 ms of 4.9 ms js; all systems together 0.83 ms |
| S2 + 60 bugs (158 bodies) | 16.7 / 16.8 / 66.8 | 0–2 | 1 703–1 932 | not measured | `renderer.render` **6.6–7.7 ms/frame** (worst 32.3) · layout thrash **1.14** · `EnemySystem.update` 1.1–1.3 |
| S3a burrow ×8 in one frame | 16.7 / 16.8 / 33.5 | 0 | 1 338 | not measured | the 8 spawns are **4.9 ms** cold / 3.9 warm; the one dropped frame was a 16.9 ms `EnemySystem.update` **unrelated to them** |
| S3b natural patrol tick ×6 | 16.7 / 16.8 / 16.9 | 0 | 733 | not measured | nothing — the tick costs **0.0–0.1 ms** |
| S4 3 androids + a pulled group | 16.7 / 16.8 / 16.9 | 0 | 1 555–1 566 | not measured | one **10.0 ms** `AllySystem.update` at first contact, then 0.055 ms/frame |

Heap: 18–55 MB/s allocated, ~2.4 GC drops/s, peak 150–213 MB. **No dropped frame in any scenario was attributable to
GC** — every one of them is explained by its marks.

### Who owns the draw calls (S2, `--label phase0-census`)

Counted per top-level `scene.children` group: visible drawables + the `castShadow` ones the shadow pass draws again.
The sum (2 828) is above the reported 1 703 draw calls because frustum culling drops what is off-screen — the **shares**
are the usable part, not the absolute total.

| Owner | Groups | Visible | + shadow | Per body | Share of visible |
|---|---|---|---|---|---|
| **bugs** (`bug_scavenger` 17 · `bug_warrior` 17 · `bug_hunter` 18) | 75 | 1 285 | 75 | **17–18 + 1 shadow** | **60 %** |
| world (terrain · props · structures) | 1 | 375 | 178 | — | 17 % |
| humanoid enemies (`rogue_raider` · `rogue_rogue` · boss) | 31 | 298 | 279 | 9–10 + 9 shadow | 14 % |
| player soldier | 1 | 86 | 43 | **86 + 43 shadow = 129** | 4 % |
| bug eggs | 56 | 56 | 56 | 1 + 1 | 3 % |
| hellpod · FX · projectiles · sky | 8 | 52 | 45 | — | 2 % |
| **androids** (S4, `AllySoldier:android:local:*`) | 3 | 351 | 195 | **117 + 65 shadow = 182** | — |

Read that twice: **one bug is 18 draws and one android is 182.** The player's 86 visible = 43 body meshes + 43
silhouette clones (`SoldierModel.ts:459-470`); an android adds its gun and armour on top. Bugs cast one shadow each
(only `bodyMesh.castShadow` — `BugModel.ts:388`), humanoid enemies cast nine, soldiers cast 43–65.

### What the numbers say

- **On this machine nothing sustains a drop.** p50 and p95 are pinned to the 60 Hz vsync in every scenario. What the
  user feels is **individual frames**, not a lower frame rate.
- **The render block is the frame.** `renderer.render` (the scene draw plus the composer / outline passes) is
  4.2 ms/frame at ~1 150 draw calls and 7.6 ms/frame at ~1 900 — **≈ 4 µs per draw call, on the CPU**, not the GPU.
  Every frame that actually dropped had 11–30 ms of it. This is finding **B1**, and it is the whole story.
- **Layout thrash, once per frame.** `WorldMarkers.lateUpdate` draws 2–3 extraction diamonds, yet its cost moved 25×
  with the body count (0.044 ms at S1 → 1.0 ms at S2). Reading `ctx.uiRoot.clientWidth` one line earlier moved the
  whole cost into that read (`x:layoutFlush` 1.14 ms/frame, worst 7.3 ms) and `WorldMarkers` fell off the list: it is
  the first layout read after a frame of HUD style writes, so it pays for laying out the whole UI. **Eleven widgets do
  the same read** (list in Phase 2), each after the previous one has written styles. **New finding — nowhere in the
  2026-09-18 inventory.**
- **The spawn spike is not the problem.** 60 bodies built in one frame = 5.8 ms; 8 burrowing bodies = 4.9 ms with a
  cold pool and 3.9 ms with a warm one (**≈ 0.12 ms per body** for the whole rig, so pre-warming buys ~1 ms on a group
  of 8); the ambient patrol tick, placement search included, is 0.0–0.1 ms. **A1 · A2 · A3 · A4 are struck.**
- **What does spike is a handful of one-off calls**: `EnemySystem.update` 16.9 ms once per raid (S3a and S3b both saw
  one, neither on a spawn job frame), `AudioSystem.play` 16.3 ms once (a first synth build — `x:audioPlay` averages
  0.27 ms over 5 600 calls), `AllySystem.update` 10.0 ms on the frame androids first make contact. Each loses 1–3
  frames. Their cause is not yet known; finding them is Phase 3.
- **Android AI is cheap, android *bodies* are not.** 3 androids cost 0.055 ms/frame of AI and **546 draws**. Symptom
  (a) — "it stutters when other bodies are present" — points at the body, not the brain.
- **Bug footsteps are cheap.** `AudioSystem.play` is 0.27 ms/frame across 5 600 calls in S2.
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
| A6 | One `ee spawn` JSON send per body (`Pool.ts:154-158`, `net/HostSync.ts:158-171`) | solo only, not measured | **open, needs S5** → Phase 5 |
| A7 | First-draw material init per cloned material (`core/ShaderWarmup.ts:129-157`) | no compile spike seen (`x:rendererCompile` never fired) | **struck** |

**B. Sustained per-body cost**

| # | Finding | Measured | Verdict |
|---|---|---|---|
| B1 | Draw calls: bug = 17–18 meshes; soldier ≈ 130 calls; no batching / instancing / LOD (`BugModel.ts:387-471`, `player/SoldierModel.ts:450-470`, `AllyAvatars.ts:191`, `RemoteAvatar.ts:285`) | census above: bugs 60 % of visible drawables, android 182 draws each; ≈ 4 µs/call; every dropped frame render-dominated | **confirmed — #1** |
| **NEW** | **Layout thrash**: eleven HUD widgets read `ctx.uiRoot.clientWidth` and write styles in turn every frame; `ui/hud/WorldMarkers.ts:90` is the first | 1.14 ms/frame at 160 bodies, worst **7.3 ms**; 0.044 ms when idle | **confirmed — #2** |
| B2 | Android combat AI per ally per frame (`allies/parts/Combat.ts:58-69, 106-116, 155-161, 190-197`) | 0.055 ms/frame for 3 androids; **one 10.0 ms first-contact call** | **struck** except the one-off → Phase 3 |
| B3 | `LightBudget.update` walks the whole visible scene every frame (`core/LightBudget.ts:7, 55, 75`) | 0.10 ms idle → 0.30 ms at 160 bodies (worst 1.7) | **small, real** → Phase 4 |
| B4 | Enemy AI has no distance LOD or time slicing (`EnemySystem.ts:451-528`, `ai/EnemyAI.ts:614-662`, `parts/Alerts.ts:80-159`) | 0.19 ms at 44 bodies → 0.41 at 99 → **1.29 at 160**; worst call 4.9 ms | **confirmed, #3 sustained** — scales super-linearly, second-biggest system cost |
| B5 | Bug footsteps scan all active enemies before the range gate (`enemies/model.ts:311-341`) | inside `u:enemies`; `x:audioPlay` 0.27 ms/frame | **small** → Phase 4 |
| B6 | Recurring garbage (`HostSync.ts:140-197`, `net/parts/Messages.ts:401`, `ui/hud/Nameplates.ts:117-152`) | 18–55 MB/s, 2.4 GC drops/s, **no spike attributable** | **low** |

**C. Multiplayer / squadmate-specific** — C1 (`SoldierPool.acquire`) and C3 (`ally state` encoding) were never reached
without S5; C2 (a `SoldierModel` per corpse) never fired in these windows; C4 (`snapshotFace`) is ship-only and out of
scope. **All four stay open; S5 (Phase 5) is what would close them.**

---

## Phases (re-ranked by the measurement)

### Phase 1 — cut draw calls and the render block (B1) · `enemies/models`, `player`, `core`

The only finding that is both sustained and present in every dropped frame. ≈ 4 µs per draw call means **every 250
calls removed gives back ~1 ms** of a 16.7 ms budget. Needs the user's answers (see Decisions). In order of measured
gain:

1. **Bug legs → `InstancedMesh` per type.** 6 legs × (femur + tibia) = **12 of the 17 meshes** (`BugModel.ts:442-461`),
   all sharing one `chitin` material and two geometries. One `InstancedMesh` per type per rig pool, matrices written by
   `animateBug`. At 75 bugs that is ~900 of the 1 285 bug drawables. **Biggest single win in the file.**
2. **Bug: one shared `chitin` material per type** instead of a clone per rig (`BugModel.ts:378-380`). The status flash
   then needs a per-instance path — a vertex-colour attribute or an `InstancedMesh` colour — because `statusEmissive`
   writes the material today. Cuts material switches, not call count; do it with (1).
3. **Soldier / android bodies: 182 draws each.** `castShadow` on 43–65 parts (`SoldierModel.ts:452`) and a silhouette
   clone of every part (`:459-470`). Shadows from torso / head / limbs only, and either a merged silhouette geometry or
   a torso-only silhouette, takes an android from ~182 to well under 100. Three androids = ~250 calls back. **This is
   the lever for symptom (a).**
4. **Distance LOD for animation** (helps B4 too): beyond a csv distance skip `animateRig` every other frame; beyond
   another, freeze. Legs are ~10 cm on screen at 60 m.

- Rules: `core/LightBudget` untouched; `Layers.ENEMY` on every new mesh (raycast); `Xray` overlays are children of the
  pooled rigs (`fx/Xray.ts`) — check they survive instancing; hit capsules do not depend on meshes; new numbers go in
  `data/*.csv`, never in code (§4.1).
- Verify: `smoke-enemy-alert`, `smoke-blast-occlusion`, `smoke-ally-avatars`, `smoke-lights`, `shots-factions.mjs` for
  the look.
- **Done when** `perf-measure --only s1,s2,s4` shows S2 draw calls **below 1 200** (from ~1 800) and
  `x:rendererRender` **below 5 ms/frame** (from 7.6), with no new spike frame.

### Phase 2 — stop the layout thrash (NEW) · `ui`

Eleven HUD widgets read `ctx.uiRoot.clientWidth` / `clientHeight` each frame, interleaved with the style writes that
position their elements, so the browser re-lays-out the UI repeatedly: 1.14 ms/frame with 160 bodies, 7.3 ms at worst.
Give them one owner — the viewport size read once and refreshed on `resize` only — and hand it to every widget.

Sites: `WorldMarkers.ts:90` (the first, and the one that showed the cost), `Pings.ts:264` and `:440`,
`Nameplates.ts:90`, `OffscreenIndicators.ts:132`, `DangerIndicators.ts:365`, `StatusMarkers.ts:84`,
`NamedScanWarning.ts:203`, `Detection.ts:247`, `Deployables.ts:152`, `DroneScanLabels.ts:67`, `TypingBubbles.ts:68`.
`ChatLog.ts:374`, `Notifications.ts:560` and `ItemFavoriteMenu.ts:109` use `getBoundingClientRect` on their own
elements — those are event-driven, not per-frame, and are out of scope.

- Independent of the user's decisions; safe to do first.
- Verify: `smoke-ui-p6`, `smoke-tactical`, `smoke-extraction` (the pad diamonds), plus a window resize by hand.
- **Done when** `perf-measure --only s2` reports `x:layoutFlush` under 0.1 ms/frame and `l:hud` under 0.2 ms/frame.

### Phase 3 — the one-off ≥ 10 ms calls · `enemies`, `audio`, `allies`

Three calls, each losing 1–3 frames, each firing once or twice per raid. **Find the cause before writing a fix** — the
harness's autopsy names the mark, not the line, so this phase starts with a DevTools trace (or `performance.mark`) of
that one frame.

- `EnemySystem.update` 16.9 ms, once per raid, not on a spawn job frame — suspect **A2**, a type's geometry baked on
  its first appearance, or a nest refill. Reproduce by killing a type off and letting a patrol bring it back.
- `AudioSystem.play` 16.3 ms once — suspect the first build of a procedural buffer. If so, pre-build on `world:ready`,
  which is behind the load hold and therefore free.
- `AllySystem.update` 10.0 ms on the frame androids first make contact — suspect B2's `pickCoverSpot` /
  `getObstaclesNear` on the transition (it is 0.055 ms/frame at rest, so only the transition is worth touching).
- Verify: `smoke-burrow`, `smoke-allies-core`, `smoke-enemy-allies`.
- **Done when** `perf-measure --only s3a,s4` reports no spike frame over one vsync in either window.

### Phase 4 — the small per-frame scans (B3, B5) · `core`, `enemies`, `audio`

Together ~0.4 ms/frame at 160 bodies — worth doing only after Phase 1 has freed the budget.

- `LightBudget`: recount on a flag from the light-pool owners (`hub/interiors/LightPool`, `world/structures`,
  `extraction`) or at a csv interval instead of every frame. The invariant "the shader always sees
  `SCENE_POINT_LIGHT_BUDGET`" must hold on the frame a light appears — read `core/LightBudget.ts`'s header first.
- Footsteps: move the range gate before `getWorldPosition` and `bugStepCrowd`; cache the camera position once per frame
  in `EnemySystem.update`.
- Verify: `smoke-lights` (**must stay green — it enforces the light count**), `smoke-enemy-alert`.
- **Done when** `x:lightBudget` is under 0.05 ms/frame in S2 and nothing else regressed.

### Phase 5 — S5 and the multiplayer findings (A6, C1, C3) · `net`, `player`, `allies`

Everything the user reported about *other players* is still unmeasured, and a remote body costs the same ~182 draws an
android does. Extend the harness to two clients through the relay (the `scripts/e2e-multiplayer.mjs` launch pattern is
the template; the probe itself is already page-local, so it installs on both), measure the **replica** as well as the
host, and only then decide on `SoldierPool` pre-fill (C1), the `ally state` encoding (C3) and the `ee spawn` burst (A6).

- **Done when** the Results table's `Replica p95 ms` column is filled for S3 and S5 and C1 · C3 · A6 each have a
  measured verdict.

### Struck by the measurement

The old Phase 1 (pre-warm pools and geometry, A1 · A2 · C1), the old Phase 3 (throttle android AI per frame, B2), the
old Phase 4's search and capacity work (A3 · A4) and the old Phase 6 (garbage, B6). **Do not implement them** — their
cause was measured and is not in the stutter.

---

## Decisions needed (ask the user at the start of Phase 1)

1. **Soldier / android shadows:** shadow from every armour plate (today: 43–65 per body) vs. from torso, head and limbs
   only. Visible difference: small plates lose their own shadow. Worth ~40 draws per body.
2. **Silhouette (occlusion outline) for allies / remotes:** keep on every part (today: a clone of all 43), or torso +
   head only, or off beyond a distance. Worth ~40 draws per body.
3. **Enemy animation LOD distances:** at what distance may legs stop animating (they are ~10 cm at 60 m)? Proposal:
   half rate beyond 40 m, frozen beyond 80 m, both csv.
4. **Bloom:** the composer's passes are part of the render block. Is bloom-off an acceptable option to offer in
   `설정 › 화면`, or must it stay on?

Struck from this list by the measurement: burrow sound density (one voice per bug costs 0.27 ms/frame) and spreading a
group's spawns over frames (a whole group is 4.9 ms).

Record the answers in `docs/DECISIONS.md` under a 2026-09-xx heading, in Korean titles as the file does.

---

## What this plan does not cover
- The ship (hub) frame rate and `snapshotFace` (C4) — separate scene, separate light pool; only if the user reports it.
- `verify:all` run time (`docs/TODO.md` E-12) — related (page frame cost) but a different goal.
- WebGPU / worker offloading — out of scope until the cheap fixes above are measured.
- Slower machines: every number here is from an RTX 4080 SUPER, where **nothing sustained a drop at all**. The ranking
  would only get more render-bound on weaker hardware, but a re-measure there is the honest way to know.
