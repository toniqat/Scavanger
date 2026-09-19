# Performance plan — frame hitches with many bodies

**Status:** **Phase 0 measured (2026-09-19) · Phase 1 and 2 built and re-measured (2026-09-20).** The 2026-09-20
A/B (same machine state, back to back, `--only s2` twice per side) **refutes the central finding of Phase 0**: the
work removed 31 % of the draw calls and 36 % of the scene nodes and `x:rendererRender` did not move. The render
block is not paid per draw call on this machine — it is the GPU. The ranking below is rewritten around that.

**Symptom (user report):** the frame rate drops or stutters badly (a) with several other bodies present — remote
human players, or the 3 android squadmates — and (b) when many bugs are alive, worst of all at the moment a new
group spawns.

**One-line diagnosis, after two rounds of measuring:** **a raid is GPU-bound on this machine, and
`x:rendererRender` is mostly the CPU waiting for it.** Of its ~7.2 ms, bloom is ~0.6 ms and the shadow pass ~0.75 ms;
the rest tracks **triangles and pixels**, not draw calls or scene nodes. Nothing in S1–S4 sustains a drop on an
RTX 4080 SUPER — every scenario sits on the 60 Hz vsync — so what the user feels is individual frames, and the
spike counts move more between two identical runs than between two builds.

---

## Next session starts here

1. **Read [What the 2026-09-20 A/B says](#what-the-2026-09-20-ab-says)** before planning anything — four of the
   phases below were re-ranked by it and one was struck.
2. **Ask the user the two questions** in [Decisions needed](#decisions-needed). Both are look trade-offs (geometry
   detail, shadow quality) and Phase A cannot be scoped without them.
3. **Take a fresh `before`** — the logs are git-ignored and the tree moves:
   `npm run dev`, then `node scripts/perf-measure.mjs --only s2 --label before-phaseA`. **Run it twice.** One run
   is not a measurement: two identical builds differed by 1.6× in spike count on 2026-09-20.
4. Use `--display bloom=0`, `--display bloom=0,shadows=0` to split the render block whenever a change is supposed to
   touch it. That split is what turned the ranking over.

---

## How to work this plan

1. **Read first:** `CLAUDE.md` §4.1 (no numbers in code → csv), §4.5 (never change the point-light count at runtime;
   every scene compiles through `ctx.shaders`), §6 (verify). Then the README of every folder you touch.
2. **Re-measure around every phase**, twice per side, with the same options. The harness changes no game code — it
   wraps the live page — so a `before` can always be retaken at the current HEAD, or from a `git stash push -- src data`.
3. **Judge by what is deterministic.** Draw calls, scene nodes and triangles repeat to within 2 %; `ms` numbers do
   not. A phase that only moves the ms numbers by less than the run-to-run spread has not been shown to do anything.
4. **One phase = one verify cycle** (`npm run verify`; `verify:all` at the end of the session). Record results as
   `CLAUDE.md` §6 says; once every phase is done or retired this file is **deleted**.

---

## Phase 0 — measured (2026-09-19) · done

### How

`node scripts/perf-measure.mjs` (options in `scripts/README.md`; the reasoning is in the script's header). It wraps,
on the live page, every system's `update` / `lateUpdate`, `renderer.render` / `compile`, `ShaderWarmup.beforeRender`
(the light budget), `Outline.prepare`, `AudioSystem.play`, `EnemySystem.spawn` / `ensureCapacity`,
`AmbientSpawner.update`, each HUD widget's `lateUpdate`, and `Engine.frame` itself. Frame cadence is the rAF
timestamps; JS cost is a timer around the frame body. A frame whose JS runs past one 60 Hz interval gets a per-mark
**autopsy**. Scenario actions are queued to run *inside* a frame. `--only`, `--seconds`, `--spike`, `--label` and
(2026-09-20) `--display` are the knobs worth touching.

**Headful, deliberately**: a headless Chrome does not present on a real swap chain, so its cadence is meaningless.
Audio is silenced with `--mute-audio`, which mutes the output stream while the page still builds every WebAudio node.

**Machine**: Windows 11 · Ryzen 7800X3D · RTX 4080 SUPER (ANGLE D3D11) · Chrome 1280×720, dpr 1, resolution scale 1,
bloom **on**, shadows **on** (`Engine.perfGuard` never fired). Planet `tundra` (threat 2), seed 7001, 20 s windows.

**Logs are local only** (`scripts/logs/perf/`, git-ignored). Everything worth keeping is transcribed here.

**S5 (relay, two humans) was not run.** Nothing here measures a replica, which is why symptom (a) is still
unreproduced and A6 · C1 · C3 are still open.

### Results (2026-09-19, before any change)

| Scenario | Host p50 / p95 / max ms | Frames > 50 ms | Draw calls | Dominant cost (from the autopsy) |
|---|---|---|---|---|
| S1 idle (99 bodies, 56 of them eggs) | 16.7 / 16.8 / 16.9 | 0 | 1 142–1 198 | render block 4.2 ms of 4.9 ms js; all systems together 0.83 ms |
| S2 + 60 bugs (158 bodies) | 16.7 / 16.8 / 66.8 | 0–2 | 1 703–1 932 | `renderer.render` **6.6–7.7 ms/frame** · layout flush **1.14** · `EnemySystem.update` 1.1–1.3 |
| S3a burrow ×8 in one frame | 16.7 / 16.8 / 33.5 | 0 | 1 338 | the 8 spawns are **4.9 ms** cold / 3.9 warm; the one dropped frame was a 16.9 ms `EnemySystem.update` **unrelated to them** |
| S3b natural patrol tick ×6 | 16.7 / 16.8 / 16.9 | 0 | 733 | nothing — the tick costs **0.0–0.1 ms** |
| S4 3 androids + a pulled group | 16.7 / 16.8 / 16.9 | 0 | 1 555–1 566 | one **10.0 ms** `AllySystem.update` at first contact, then 0.055 ms/frame |

Heap: 18–55 MB/s allocated, ~2.4 GC drops/s, peak 150–213 MB. **No dropped frame was attributable to GC.**

### Who owned the draw calls (S2, before the change)

| Owner | Groups | Visible | + shadow | Per body | Share of visible |
|---|---|---|---|---|---|
| **bugs** (`bug_scavenger` 17 · `bug_warrior` 17 · `bug_hunter` 18) | 75 | 1 285 | 75 | **17–18 + 1 shadow** | **60 %** |
| world (terrain · props · structures) | 1 | 375 | 178 | — | 17 % |
| humanoid enemies (`rogue_raider` · `rogue_rogue` · boss) | 31 | 298 | 279 | 9–10 + 9 shadow | 14 % |
| player soldier | 1 | 86 | 43 | **86 + 43 shadow = 129** | 4 % |
| bug eggs | 56 | 56 | 56 | 1 + 1 | 3 % |
| hellpod · FX · projectiles · sky | 8 | 52 | 45 | — | 2 % |
| **androids** (S4, `AllySoldier:android:local:*`) | 3 | 351 | 195 | **117 + 65 shadow = 182** | — |

That table is what Phase 1 was built against: one bug was 18 draws and one android 182.

---

## Phase 1 — fewer things drawn · done 2026-09-20 · `enemies/models`, `player`, `ui`

Built, from the user's answers (recorded in `docs/DECISIONS.md`):

1. **A bug's 6 legs are two `InstancedMesh`** (femur · tibia, 6 instances each) instead of 12 meshes inside 18
   nested groups. `animateBug` composes the matrices itself — the same `T(hip) · Ry · Rz` chain, one multiply
   cheaper — and the rig keeps its per-instance `chitin`, so the hit flash, the incinerate glow and the shock spark
   still reach the legs. A bug is **17–18 draws → 7–8**, and 30 scene nodes lighter. `fx/Xray.ts` clones an
   instanced source as an `InstancedMesh` sharing its live `instanceMatrix`. — `enemies/models/BugModel.ts`
2. **A soldier casts shadows from the torso, head and limb segments only** (13–17 meshes, was 43–65), and its
   occlusion silhouette is the **torso + head** (3 meshes, was a clone of all 43). Armour plates and held items
   (`GearLook`) cast nothing. An android goes from **182 draws to ~70**. — `player/SoldierModel.ts`, `player/GearLook.ts`
3. **Animation LOD**: past `ENEMY_ANIM_LOD_HALF_M` (40 m) a living body re-solves its pose every other frame, past
   `ENEMY_ANIM_LOD_FREEZE_M` (80 m) not at all; a body that is dead, flashing, burning, shocked or flipped is never
   skipped, at any distance. — `enemies/EnemySystem.poseSkip`, `enemies/Enemy.animate`
4. **Bloom already had its off switch** — `설정 › 화면 설정 › 화면 효과`, plus the perf guard's automatic off. The
   fourth decision needed no code.

**Result: the target was met and it bought almost nothing.** See below.

## Phase 2 — the HUD's screen size has one owner · done 2026-09-20 · `ui`

Twelve per-frame `ctx.uiRoot.clientWidth` / `clientHeight` reads across eleven widgets became one `hudViewport`
measured on `resize` (`ui/hud/viewport.ts`). **The premise was wrong**: `x:layoutFlush` is unchanged at
1.04–1.07 ms/frame, and so is `l:hud` (1.13 → 1.15). That mark is the harness's *own* probe read at the top of
`HudSystem.lateUpdate`, and what it measures is **one unavoidable layout** of a HUD that `HudSystem.update` has
already dirtied — not eleven reads thrashing against each other. The change is kept because it is the right shape
and costs nothing, but it is not a win, and **the real target is what dirties the layout**: per-body text writes and
per-body DOM nodes (see Phase C).

---

## What the 2026-09-20 A/B says

Same machine state, back to back, `--only s2`, two runs per side (`git stash push -- src data` between them).

| Run | Draw calls | Scene nodes | Triangles | `x:rendererRender` | js/frame p50 | frames > 33 ms |
|---|---|---|---|---|---|---|
| before 1 | 1 896 | 5 941 | 1 001k | 7.363 | 10.5 | 13 |
| before 2 | 1 885 | 5 940 | 1 000k | 7.314 | 10.4 | 14 |
| **after 1** | **1 290** | **3 779** | 988k | 7.120 | 10.1 | 22 |
| **after 2** | **1 313** | **3 817** | 997k | 7.349 | 10.2 | 24 |
| after, `--display bloom=0` | 1 282 | 3 791 | 991k | **6.670** | 9.4 | 14 |
| after, `--display bloom=0,shadows=0` | 1 166 | 3 804 | **778k** | **5.927** | 8.8 | **4** |

- **Draw calls −31 %, scene nodes −36 %, `x:rendererRender` unchanged** (7.34 → 7.23, inside the spread).
  **Finding B1 is refuted.** The "≈ 4 µs per draw call" of Phase 0 was a correlation with scene size, not a cost
  per call: removing 590 calls and 2 130 nodes bought nothing measurable.
- **The render block is GPU time.** With bloom on, `renderer.render` is entered ~15× per frame (composer passes);
  with bloom off, once — and one call still costs 6.7 ms for 1 282 draws at 1280×720 on an RTX 4080 SUPER. That is
  not CPU submission cost. It is the CPU blocking on a full driver queue, i.e. the GPU frame.
- **What does move it: pixels and triangles.** Bloom ≈ **0.6 ms**. The shadow pass ≈ **0.75 ms** (and −188 draws,
  −213k triangles). With both off, the spike count fell from 22–24 to **4** — the clearest signal in the table.
- **Total honest gain of Phase 1 + 2: ~0.3 ms of js/frame** (10.45 → 10.15, consistent across both pairs) and a
  third of the scene gone. Worth keeping, and worth much more on a weaker CPU — but it is not what the user feels.
- **Two identical builds differ by more than two different builds do.** before: 13 · 14 frames > 33 ms;
  after: 22 · 24; after with bloom off: 14. Never conclude from one run.

**So the honest ranking is now: pixel and vertex work first, then the one-off spikes, then the multiplayer path.**

---

## Findings inventory — measured verdicts

**A. Spawn-frame spikes**

| # | Finding | Measured | Verdict |
|---|---|---|---|
| A1 | Pools never pre-warmed (`parts/Pool.ts`, `Enemy.ts`, `models/BugModel.ts`) | cold 4.9 ms vs warm 3.9 ms for 8 bodies → **0.12 ms/body** | **struck** |
| A2 | Shared geometry baked lazily on a type's first appearance | not isolated; a 16.9 ms `EnemySystem.update` fires once per raid | **open** → Phase B |
| A3 | Placement search raycasts per living player per candidate | patrol tick 0.0–0.1 ms total | **struck** |
| A4 | `ensureCapacity` rescans; `despawn` uses `indexOf` | never above the noise floor | **struck** |
| A5 | `burrow_emerge` synthesises ~15 sources per bug | 0.27 ms/frame over 5 600 calls; **one 16.3 ms call** | **one-off only** → Phase B |
| A6 | One `ee spawn` JSON send per body | solo only, not measured | **open, needs S5** → Phase D |
| A7 | First-draw material init per cloned material | no compile spike seen | **struck** |

**B. Sustained per-body cost**

| # | Finding | Measured | Verdict |
|---|---|---|---|
| B1 | **Draw calls** — bug 17–18 meshes, soldier ≈ 130, no batching / instancing / LOD | **cut 31 % on 2026-09-20 with no change in the render block** | **refuted as a cost driver; the cut is done and kept** |
| **NEW-1** | **GPU frame, not CPU submission**: bloom 0.6 ms · shadow pass 0.75 ms · the rest scales with triangles (1.0 M in S2) and pixels | the `--display` split above | **confirmed — #1** |
| **NEW-2** | **Layout flush** 1.04–1.07 ms/frame is **one** layout of a HUD dirtied by per-body text and per-body nodes — not read/write thrash | unchanged by removing all twelve per-frame reads | **confirmed — #3** |
| B2 | Android combat AI per ally per frame | 0.055 ms/frame for 3; **one 10.0–11.7 ms first-contact call** | **struck** except the one-off → Phase B |
| B3 | `LightBudget.update` walks the whole visible scene every frame | 0.10 idle → 0.27–0.30 at 160 bodies (worst 1.7) | **small, real** → Phase C |
| B4 | Enemy AI has no distance LOD or time slicing | 0.19 at 44 bodies → 0.41 at 99 → **1.0–1.3 at 160**; worst call 4.9 ms | **confirmed, #2 of the CPU costs** |
| B5 | Bug footsteps scan all active enemies before the range gate | inside `u:enemies`; `x:audioPlay` 0.27 ms/frame | **small** → Phase C |
| B6 | Recurring garbage | 18–55 MB/s, 2.4 GC drops/s, **no spike attributable** | **low** |

**C. Multiplayer / squadmate-specific** — C1 (`SoldierPool.acquire`), C3 (`ally state` encoding) were never reached
without S5; C2 (a `SoldierModel` per corpse) never fired; C4 (`snapshotFace`) is ship-only and out of scope.
**All four stay open; S5 (Phase D) is what would close them.**

---

## Phases (re-ranked by the 2026-09-20 A/B)

### Phase A — the GPU frame · `core`, `enemies/models`, `world`

The only thing measured to move `x:rendererRender`. In order of measured size:

1. **The shadow pass ≈ 0.75 ms and 188 draws.** Phase 1 already cut the casters on soldiers; the remaining casters
   are the world (178 in S2) and humanoid enemies (**9 each**, `models/RogueModel.ts` — the same treatment
   `SoldierModel` just got, and the user's decision covers the same body shape). Then the map itself: shadow map
   size, cascade range and `shadow.bias` live in `core/` and are worth one experiment each with
   `--display shadows=0` as the floor.
2. **Triangles: 1.0 M in S2, 778k with the shadow pass off.** A bug body is merged ellipsoids at 16–18 segments
   (`models/BugModel.buildBodyGeometry`); the sphere segment counts were never tuned and halving them on the small
   types is invisible at 10 m. This is a look change → **ask the user** (Decisions).
3. **Bloom ≈ 0.6 ms.** Already optional (`설정 › 화면 설정`). Worth deciding whether the **default** stays on;
   the perf guard already turns it off under load.
4. Re-measure with `--display` on both sides of every step, twice.
- **Done when** S2 `x:rendererRender` is **below 6.0 ms with bloom and shadows on**, measured twice.

### Phase B — the one-off ≥ 10 ms calls · `enemies`, `audio`, `allies`, `ui`

Four calls, each losing 1–3 frames, each firing once or twice per raid. **Find the cause before writing a fix** —
the autopsy names the mark, not the line, so this starts with a DevTools trace of that one frame.

- `EnemySystem.update` 16.9 ms, once per raid, not on a spawn frame — suspect **A2**, a type's geometry baked on
  first appearance, or a nest refill. Reproduce by killing a type off and letting a patrol bring it back.
- `AudioSystem.play` 16.3 ms once — suspect the first build of a procedural buffer. If so, pre-build on
  `world:ready`, which is behind the load hold and therefore free.
- `AllySystem.update` 10.0–11.7 ms on the frame androids first make contact — suspect `pickCoverSpot` /
  `getObstaclesNear` on the transition (0.055 ms/frame at rest, so only the transition is worth touching).
- **NEW (2026-09-20): `h:detection` 18.4 ms**, seen twice in S2 — the light pillars on corpses
  (`ui/hud/Detection.ts`) are built on the frame the first corpses come into range.
- **Done when** `perf-measure --only s2,s3a,s4` reports no spike frame over one vsync, twice per scenario.

### Phase C — the sustained CPU costs · `enemies`, `ui`, `core`, `audio`

Only worth doing after Phase A, and only as far as the numbers justify.

- **B4, the biggest of them: enemy AI is 1.0–1.3 ms at 160 bodies and scales super-linearly.** Distance LOD or time
  slicing, the same shape the animation LOD just got (`EnemySystem.poseSkip` is the template, and the constants
  belong next to `ENEMY_ANIM_LOD_*` in `data/constants.csv`).
- **NEW-2, the layout**: cut what dirties it — a per-body nameplate / marker that writes text every frame, and the
  DOM node count itself. Measure with the harness's `x:layoutFlush`, which is exactly this cost.
- `LightBudget` (B3): recount on a flag from the light-pool owners or at a csv interval. The invariant "the shader
  always sees `SCENE_POINT_LIGHT_BUDGET`" must hold on the frame a light appears — read `core/LightBudget.ts`'s
  header first. `smoke-lights` **must stay green**.
- Footsteps (B5): move the range gate before `getWorldPosition` and `bugStepCrowd`; the camera position is already
  cached once per frame in `EnemySystem.update` (`camPos`, added 2026-09-20).

### Phase D — S5 and the multiplayer findings (A6, C1, C3) · `net`, `player`, `allies`

Everything the user reported about *other players* is still unmeasured. A remote body costs what an android does —
which Phase 1 has now cut to ~70 draws, but the wire and the pool are untouched. Extend the harness to two clients
through the relay (`scripts/e2e-multiplayer.mjs` is the launch template; the probe is page-local, so it installs on
both), measure the **replica** as well as the host, then decide on `SoldierPool` pre-fill (C1), the `ally state`
encoding (C3) and the `ee spawn` burst (A6).

- **Done when** the Results table has a `Replica p95 ms` column for S3 and S5 and C1 · C3 · A6 each have a verdict.

### Struck by measurement

The old Phase 1 (pre-warm pools and geometry, A1 · A2 · C1), the old Phase 3 (throttle android AI per frame, B2),
the old Phase 4's search and capacity work (A3 · A4), the old Phase 6 (garbage, B6) — and now **B1 itself as a cost
driver**. The draw-call cut is built and kept for weaker machines; **do not spend more of this plan on draw calls.**

---

## Decisions needed

1. **Bug geometry detail.** A bug body is merged ellipsoids at 16–18 sphere segments and S2 carries 1.0 M triangles.
   May the small types (scavenger · hunter) drop to 10–12 segments — invisible past ~10 m, slightly faceted in a
   close-up — or must the silhouette stay exactly as it is?
2. **Shadows.** The shadow pass is ~0.75 ms and the clearest spike reducer in the table. Options: leave it; give
   humanoid enemies the same torso · head · limbs rule the soldier just got (~5 draws each back, no visible change);
   or shrink the shadow map / cascade range, which softens every shadow in the raid.

Answers go in `docs/DECISIONS.md` under a 2026-09-xx heading, in Korean titles as the file does.

---

## What this plan does not cover
- The ship (hub) frame rate and `snapshotFace` (C4) — separate scene, separate light pool; only if the user reports it.
- `verify:all` run time (`docs/TODO.md` E-12) — related (page frame cost) but a different goal.
- WebGPU / worker offloading — out of scope until the cheap fixes above are measured.
- Slower machines: every number here is from an RTX 4080 SUPER, where **nothing sustained a drop at all**. A
  CPU-bound machine would have gained from the Phase 1 draw-call cut that this one did not; a re-measure there is the
  honest way to know.
