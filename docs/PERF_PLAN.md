# Performance plan — frame hitches with many bodies

**Status:** **Every phase is done.** Phase 0 measured 2026-09-19; Phases 1 · 2 · A · A2 · B · C built and Phase D
measured 2026-09-20. **Nothing in this plan is outstanding** — what is left is written up below as 「what this
machine cannot answer」, not as work.

> ### ⚠ Read this before any number below: `ms` in this plan is not evidence
> On 2026-09-20 the **same committed build** measured `x:rendererRender` **6.842 ms and 5.112 ms** back to back
> (js/frame p50 9.6 vs 7.6). A 1.7 ms spread on identical code is **larger than every difference this plan has
> credited to a change**, including 「bloom ≈ 0.6 ms」, 「the shadow pass ≈ 0.75 ms」 and Phase A's 「0.6 ms gained」.
> Two runs agreeing closely is not evidence either — Phase A's after-pair agreed to 0.012 ms by luck.
> **Judge a change by the counters that repeat: draw calls, scene nodes, triangles, caster counts.** A `ms` figure
> here is a hint about where to look, never a verdict, and a single `--display` split is one sample of a noisy
> quantity. If the render block has to be judged, it needs many runs (or a different method) first.

Phases A and A2 cut what is drawn; neither has a demonstrated `ms` effect on this machine, and Phase A's own
「below 6.0 ms」 target was dropped as unreachable with shadows on. **Phase B is done** — and it is the first phase
with a result that repeats: S4's android first-contact frame stopped overrunning a vsync, twice, and the owner it
found was not the one this file predicted. **Phase C is done too** — `u:enemies` −15 %, and its own census explains
why that is the ceiling: S2 is 60 bodies inside the full-rate band and 100 beyond 140 m. **Phase D is done and
built nothing**: S5 finally measured a squad, and all three multiplayer findings (A6 · C1 · C3) were struck by
counters — a remote player costs **a body to draw**, not a network. The 2026-09-20
A/B (same machine state, back to back, `--only s2` twice per side) **refutes the central finding of Phase 0**: the
work removed 31 % of the draw calls and 36 % of the scene nodes and `x:rendererRender` did not move. The render
block is not paid per draw call on this machine — it is the GPU. The ranking below is rewritten around that.

**Symptom (user report):** the frame rate drops or stutters badly (a) with several other bodies present — remote
human players, or the 3 android squadmates — and (b) when many bugs are alive, worst of all at the moment a new
group spawns.

**One-line diagnosis, after four rounds of measuring:** **a raid is GPU-bound on this machine, `x:rendererRender`
is mostly the CPU waiting for it, and that wait is too noisy to attribute** (±1.7 ms on one build). What repeats is
that the render block does **not** track draw calls or scene nodes, so the work is triangles and pixels. Nothing in
S1–S5 sustains a drop on an RTX 4080 SUPER — every scenario sits on the 60 Hz vsync — so what the user feels is
individual frames. Phase B took those and **S4's no longer overruns**; the ones left in S2 · S3a are led by the
render block, i.e. the same GPU question, not by any one-off.

**Symptom (a) is now measured and did not reproduce.** A two-human raid through the relay, with and without two
androids, runs at 16.7 / 16.8 ms with **zero** frames over 33 ms on both clients (Phase D, S5a · S5c, two runs each).
A squadmate adds one `SoldierModel` to the scene — 73 visible + 32 shadow draws, the same as the local soldier — and
23–29 KB/s of wire that costs a replica 0.08 ms a frame, outside the frame at that. **Whatever the user feels with
other bodies present, it is not the wire and it is not the squadmate's simulation; it is one more body drawn**, which
is the same GPU question as (b). If it is still felt after Phases 1 · A · A2, the next thing to measure is the
**pixel** cost (resolution scale), not the network.

---

## Next session starts here

**There is no next phase.** Every phase in this file is built or struck, and Phase D (the last one) built nothing
because nothing in the counters justified it. What a later session needs from this file is the method and the four
things this machine could not answer:

1. **Read the banner above, then [What the 2026-09-20 A/B says](#what-the-2026-09-20-ab-says)** before planning
   anything — between them they strike 「draw calls」 as a cost and strike every `ms` figure in this file as a
   verdict.
2. **The method that worked, three phases running: count the thing, do not time it.** Phase B found its owner by
   patching the layout-forcing accessors and counting calls per frame (7 in 637 frames, all in one file). Phase C
   bounded its own fix with a census (60 bodies inside the full-rate band). Phase D struck three findings with
   byte counts and a build counter, and never needed a `ms` at all. **Do not write a fix against a mark name** —
   instrument until a **counter** names the line.
3. **What is still open, and why it is not work:**
   - **Pixels.** Resolution scale is untouched; `--display scale=0.75` has never been run.
   - **Terrain: 346k visible triangles**, 37 % of the scene, untouched because collision, `getSurfaceY` and the
     silhouette all hang off that mesh.
   - **The flat DOM cut** (`hud/ShipManage`'s 116 boxes + four faded `.menu` screens, ~120, of `#ui-root`'s 1 085
     laid-out boxes) — a real cut of a deterministic counter with no demonstrable frame effect here.
   - **The `ms` methodology itself.** Until `x:rendererRender` can be measured with a spread below what a change
     moves, no phase can claim a frame-time result on this machine.
   - **A2 alone survives unreproduced** — one 18.8 ms `u:enemies` in one run of five, never seen again.
4. **Re-measuring** — the logs are git-ignored and the tree moves, so always take a fresh `before`:
   `npm run dev` (or `npm run dev:all` for S5), then `node scripts/perf-measure.mjs --only s2 --label before-x`.
   **Run it twice.** One run is not a measurement: on 2026-09-20 two runs of one build gave 5 and 22 frames over
   33 ms. Judge by the rows that repeat: a **mark average** over ~1 300 frames does (`x:lightBudget` 0.156 vs 0.157
   on one build), a `js/frame p50` or a spike count does not.
5. **Garbage has been counted and has no owner** — see [B6](#b6--allocation-by-owner-three-counters-two-of-which-lie-the-same-way).
   If allocation comes up again, start from the `--alloc` mark table, not from a profiler.
6. **A squad has been measured and is not the problem** — see [Phase D](#phase-d--s5-and-the-multiplayer-findings--done-2026-09-20--scripts-harness-only).
   The one thing S5 could **not** answer is a replica's frame time, because both clients shared one GPU; that needs
   a second machine.

## How to work this plan — and why it is still here

**This file was written to be deleted when its last phase ended, and the user decided on 2026-09-20 to keep it
instead** (`docs/DECISIONS.md`). What it holds is no longer a to-do list; it is the **measurement record** — the `ms`
noise floor of this machine, the A/B that refuted 「draw calls are the frame」, three separate occasions on which the
named suspect was not the owner, and the method that found the real one each time. `CLAUDE.md` §1 and §4.5 point
here for exactly that. **Do not add work to it**: a new to-do goes in `docs/TODO.md`, an intended limit in the owning
folder's `README.md`. Add to this file only a **measurement** — and only with the counters that back it.

1. **Read first:** `CLAUDE.md` §4.1 (no numbers in code → csv), §4.5 (never change the point-light count at runtime;
   every scene compiles through `ctx.shaders`), §6 (verify). Then the README of every folder you touch.
2. **Re-measure around every phase**, twice per side, with the same options. The harness changes no game code — it
   wraps the live page — so a `before` can always be retaken at the current HEAD, or from a `git stash push -- src data`.
3. **Judge by what is deterministic.** Draw calls, scene nodes and triangles repeat to within 2 %; `ms` numbers do
   not. A phase that only moves the ms numbers by less than the run-to-run spread has not been shown to do anything.
4. **One phase = one verify cycle** (`npm run verify`; `verify:all` at the end of the session). Record results as
   `CLAUDE.md` §6 says. The harness itself (`scripts/perf-measure.mjs`) asserts nothing, so `verify` never selects
   it — a change to it is checked by `npm run typecheck` and by running it.

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

**S5 (relay, two humans) was not run in Phase 0** — nothing in the table above measures a replica, which is why
symptom (a) stayed unreproduced and A6 · C1 · C3 stayed open until **Phase D** ran S5 on 2026-09-20.

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
   *(2026-09-20, after the fact: a **named rogue is exempt too**, and the two distances are scaled by the camera's
   zoom — a named look file integrates `dt` and carries a gameplay telegraph, and the bands are screen size, not
   metres. Not a measurement, so it is only noted here; the reasons live above the code.)*
4. **Bloom already had its off switch** — `설정 › 화면 설정 › 화면 효과`, plus the perf guard's automatic off. The
   fourth decision needed no code.

**Result: the target was met and it bought almost nothing.** See below.

## Phase 2 — the HUD's screen size has one owner · done 2026-09-20 · `ui`

Twelve per-frame `ctx.uiRoot.clientWidth` / `clientHeight` reads across eleven widgets became one `hudViewport`
measured on `resize` (`ui/hud/viewport.ts`). **The premise was wrong**: `x:layoutFlush` is unchanged at
1.04–1.07 ms/frame, and so is `l:hud` (1.13 → 1.15). That mark is the harness's *own* probe read at the top of
`HudSystem.lateUpdate`, and what it measures is **one unavoidable layout** of a HUD that `HudSystem.update` has
already dirtied — not eleven reads thrashing against each other. The change is kept because it is the right shape
and costs nothing, but it is not a win.

**What it guessed next was also wrong** (Phase B, below): 「the real target is what dirties the layout — per-body text
writes and per-body DOM nodes」. Counted, there are **14 text writes in 836 frames** and the rendered box count moves
1 085 → 1 116 when 60 bugs arrive. The layout that *was* worth removing belonged to one widget reading its own
geometry (`hud/ChatLog`), which is the opposite of a per-body cost.

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
  *(Re-split after Phase A: the shadow pass measured **1.07 ms** and **bloom measured free** — 6.83 ms with it off vs
  6.75–6.77 with it on. Of these two numbers only the shadow pass reproduced. The spike-count signal did **not**
  reproduce either — see [Phase A's result](#result--what-repeats-and-the-ms-claim-that-was-retracted).)*
- **Total honest gain of Phase 1 + 2: ~0.3 ms of js/frame** (10.45 → 10.15, consistent across both pairs) and a
  third of the scene gone. Worth keeping, and worth much more on a weaker CPU — but it is not what the user feels.
- **Two identical builds differ by more than two different builds do.** before: 13 · 14 frames > 33 ms;
  after: 22 · 24; after with bloom off: 14. Never conclude from one run.

**So the honest ranking is now: pixel and vertex work first, then the one-off spikes, then the multiplayer path.**
*(Phase A took the body-side vertex work and A2 the world's; Phase B took the one-off spikes, C the sustained CPU
costs and D the multiplayer path — which turned out not to be one. **The pixel question is the only thing left
untouched**, and it needs the measurement fixed first.)*

---

## Findings inventory — measured verdicts

**A. Spawn-frame spikes**

| # | Finding | Measured | Verdict |
|---|---|---|---|
| A1 | Pools never pre-warmed (`parts/Pool.ts`, `Enemy.ts`, `models/BugModel.ts`) | cold 4.9 ms vs warm 3.9 ms for 8 bodies → **0.12 ms/body** | **struck** |
| A2 | Shared geometry baked lazily on a type's first appearance | Phase B could not reproduce it on demand (burrows · five fresh types · corpses: nothing over 2.4 ms), but **one S2 run of five** still gave a single 18.8 ms `u:enemies` | **still open, still unreproduced** — Phase C did not take it either; it is [Next session starts here](#next-session-starts-here) item 3 |
| A3 | Placement search raycasts per living player per candidate | patrol tick 0.0–0.1 ms total | **struck** |
| A4 | `ensureCapacity` rescans; `despawn` uses `indexOf` | never above the noise floor | **struck** |
| A5 | `burrow_emerge` synthesises ~15 sources per bug | 0.27 ms/frame over 5 600 calls; the 16.3 ms call **never came back** — worst 0.90–1.30 ms across five 2026-09-20 runs | **struck** (Phase B) |
| A6 | One `ee spawn` JSON send per body | 60 spawns in one frame = 60 messages × **121 B = 7.3 KB**; on the replica that is never the worst inbound frame (an `es` **keyframe** is, 8.6-14.3 KB, every 2 s) and the burst never cost a frame — `worst rAF delta after` is 16.7-16.8 ms in all four runs, solo and squad | **struck** (Phase D) |
| A7 | First-draw material init per cloned material | no compile spike seen | **struck** |

**B. Sustained per-body cost**

| # | Finding | Measured | Verdict |
|---|---|---|---|
| B1 | **Draw calls** — bug 17–18 meshes, soldier ≈ 130, no batching / instancing / LOD | **cut 31 % on 2026-09-20 with no change in the render block** | **refuted as a cost driver; the cut is done and kept** |
| **NEW-1** | **GPU frame, not CPU submission**: the render block scales with triangles (1.0 M in S2) and pixels | the `--display` split above; then Phase A bought **0.6 ms for 6.7 % of the triangles** | **confirmed and acted on — Phase A.** Refinement: bloom is free here, the shadow pass is 1.07 ms, and what is left belongs to the **world** |
| **NEW-2** | **Layout flush** 1.04–1.07 ms/frame is one layout of a HUD dirtied by **per-body text and per-body nodes** | Phase B counted both: **14 text writes in 836 frames**, and the rendered box count goes 1 085 → 1 116 (+3 %) when 60 bugs arrive | **the 「per-body」 half is refuted.** What was real, and is fixed, is `ChatLog` forcing a layout **per chat line** (8.3 ms in one frame) — Phase B |
| B2 | Android combat AI per ally per frame | 0.055 ms/frame for 3; the 10.0–11.7 ms first-contact call was **`ui/hud/ChatLog`, not `allies`** — world queries were 0.4 ms of it and `getObstaclesNear` ran zero times | **struck entirely; the one-off is fixed in `ui`** (Phase B) |
| B3 | `LightBudget.update` walks the whole visible scene every frame | 0.156 · 0.157 ms/frame at 160 bodies → **0.132 · 0.142** with an explicit stack walk | **done (Phase C), small.** The recount stays exact and per-frame — a flag or an interval would cost two recompiles the first time it missed a frame |
| B4 | Enemy AI has no distance LOD or time slicing | 0.99–1.02 → **0.85–0.86** ms/frame at 160 bodies, twice per side | **done (Phase C), and the census bounds it**: S2 is 60 bodies at full rate and 100 beyond 140 m, so a distance LOD can only ever reach the far third. The near band is untouched — see [What Phase C leaves](#what-phase-c-leaves) |
| B5 | Bug footsteps scan all active enemies before the range gate | the crowd scan was already behind the gate; what was in front of it was a `getWorldPosition` per call | **done (Phase C)**, folded into `EnemyHost.camPos`. Too small to separate from B4 in the same window |
| B6 | Recurring garbage | counted three ways (Phase C): 63 MB/s is real, but **no owner owns it** — `x:rendererRender` 15.1 · `u:world` 7.9 · `u:enemies` 6.5 · `l:hud` 4.2 MB/s, the largest being three.js's own render path | **struck as a lead.** There is no hot spot to remove; and a CDP sampling heap profile cannot see churn at all (it keeps only surviving samples) |

**C. Multiplayer / squadmate-specific** — measured by S5 (Phase D), two runs per side:

| # | Finding | Measured | Verdict |
|---|---|---|---|
| C1 | `SoldierPool.acquire` builds a body on first appearance | one raid entry acquires **8** bodies and builds **4** (6 with androids); worst single build **0.30-0.50 ms**, and it happens inside the raid-entry hold. Zero builds in any window | **struck** |
| C3 | `ally state` encoding | **one message for the whole android roster** at 10 Hz — 507-519 B for two androids (~255 B each), **4.9-5.0 KB/s**: a quarter of the `es` stream beside it, a tenth of the host's S5b upload. `u:allies` 0.027-0.028 ms/frame | **struck** |
| C2 | a `SoldierModel` per corpse | never fired in any scenario (nobody died in a measured window) | **still unfired, not measured** |
| C4 | `snapshotFace` | ship-only | **out of scope** |

---

## Phases (re-ranked by the 2026-09-20 A/B)

### Phase A — the GPU frame · done 2026-09-20 · `enemies/models`, `data`

Built, from the user's answers (recorded in `docs/DECISIONS.md`):

1. **Every bug sphere goes through one segment budget** — `BUG_MESH_SEGMENTS` = 12 in `data/constants.csv`,
   applied inside `BugModel.ellipsoid` (and the spewer's own sac mesh), so the per-part `seg` arguments keep saying
   what a part wants and one csv row says what it gets. A thorax goes 18×13 → 12×8, 432 triangles → 168.
   **S2: 997–998k triangles → 930–932k.**
2. **Humanoid enemies cast shadows the way a soldier does** — trunk · head · legs; the visor, the thrown grenade and
   the merged `gunArms` (the rifle is a held item, and the arm segments merged into it sit against the chest) do not.
   `mesh(geo, mat, shadow)` in `createRogueRig` is the switch. **9 shadow draws each → 7.**
3. **Bloom's default stays on** (user's decision). No code — `설정 › 화면 설정 › 화면 효과` and the perf guard
   already cover it.

#### Result — what repeats, and the `ms` claim that was retracted

| Run | Draw calls | Triangles | Scene nodes | `x:rendererRender` | js/frame p50 | frames > 33 ms |
|---|---|---|---|---|---|---|
| before 1 | 1 318 | 997k | 3 816 | 7.751 | 10.9 | 47 |
| before 2 | 1 312 | 998k | 3 816 | 7.294 | 10.2 | 22 |
| **after 1** | 1 286 | **932k** | 3 767 | **6.753** | 9.7 | 5 |
| **after 2** | 1 285 | **930k** | 3 767 | **6.765** | 9.9 | 22 |
| after, `--display bloom=0` | 1 301 | 940k | 3 806 | 6.828 | 9.6 | 15 |
| after, `--display bloom=0,shadows=0` | 1 164 | **747k** | 3 817 | **5.758** | 8.7 | 5 |

**⚠ The `ms` column of this table was read as a result and it was not one.** What was written here first —
「`x:rendererRender` 7.29–7.75 → 6.75–6.77, a real ~0.6 ms, and the after-pair agrees to 0.012 ms」 — is
**retracted**: the same build later measured 6.842 and 5.112 (see the banner at the top). Phase A's honest result is
the deterministic half of the table.

- **Triangles 997–998k → 930–932k (−6.7 %)**, draw calls −27, humanoid shadow draws 9 → 7 each. Those repeat.
- **No demonstrated `ms` effect**, in either direction. The bug bodies of S2 are ~180k of its ~1.0 M triangles, so a
  6.7 % cut was never going to clear this machine's noise floor.
- **The `> 33 ms` count proves nothing either.** after 1 = 5, after 2 = 22 on the same build.
- **「Bloom ≈ 0.6 ms」 and 「the shadow pass ≈ 0.75 ms」 are one sample each.** The re-split put bloom at ~0 and the
  shadow pass at 1.07 — the two disagree by more than either figure, which is the noise floor talking. What the
  shadow split *does* establish, because it is a count, is that turning the pass off removes 137 draws and 193k
  triangles.
- **The 「below 6.0 ms」 target is dropped, not missed.** It was set from a `ms` reading and is meaningless against a
  ±1.7 ms spread. The question it stood for — what is left of the render block — is a **world** question
  (375 visible drawables, 178 casters, 678k of the scene's triangles), which is what Phase A2 went after.

### Phase A2 — the world's share · done 2026-09-20 · `world`, `core`, `data`

Measured first, per top-level world group in S2 (the census is in the commit; re-take it with a scene walk):
the world is **678k of the scene's 930k visible triangles**, and its shadow casters are 158 meshes / **158k
triangles** — of which the **four boulder `InstancedMesh` are 92k (58 %)**, because one variant spans the map with
`frustumCulled = false`, so three.js never dropped a single instance from the shadow pass. Terrain (346k) and
pebbles (137k) already cast nothing.

Built, from the user's answers (`docs/DECISIONS.md`):

1. **A scattered prop casts only within `PROP_SHADOW_DIST_M` (120 m).** Each casting variant becomes a **near** mesh
   (`castShadow`) and a **far** one, re-split when the eye moves `PROP_SHADOW_REPACK_M` (8 m) —
   `Props.repackShadowLod`. Both halves are sized to the real instance count and `DynamicDrawUsage`.
   `SUN_SHADOW_HALF_M` moved to csv so `core/Atmosphere` and `world/Props` read one number.
2. **Waist-high things stop casting**: crates, structure containers, rail containers, debris props (they still
   receive — that is what sits them on the ground).
3. **Pebbles drop to `PROP_PEBBLE_DETAIL` = 0** (`IcosahedronGeometry` 80 → 20 triangles each).

#### Result — the counters, because the `ms` cannot judge it (see the banner)

| | before (Phase A) | after (Phase A2) |
|---|---|---|
| Scene triangles (S2) | 930–932k | **727–739k (−22 %)** |
| Prop instances casting a shadow | **754** (509 boulder · 111 tree · 69 crystal · 37 spire · 28 debris) | **51** (35 · 7 · 4 · 5 · 0) |
| Prop instances **drawn** (colour pass) | 509 · 111 · 69 · 37 · 28 · 2 871 grass · 1 712 pebble | **identical, every kind** |
| Draw calls | 1 285–1 286 | 1 328–1 336 |
| `x:rendererRender` | 6.75–6.77 | 6.92–7.59 |

- **The colour pass is provably unchanged**: the per-kind instance totals are identical before and after, which is
  what the near/far split is designed to guarantee, and a side-by-side screenshot of the same seed and spawn is
  indistinguishable.
- **The `ms` column is not a regression.** It was read as one, chased to the instance buffers, and only then tested
  properly: the same committed build measured 6.842 and 5.112. See the banner at the top of this file — this is the
  episode that produced it.
- **What is knowingly lost:** on a low-sun planet (`sunElevation` 0.25) a big boulder past 120 m loses a long shadow
  that could have reached into view, and a crate no longer casts its own smudge. Both were the user's call.

#### Still open after Phase A2

- **Terrain is the single biggest owner: 346k visible triangles**, 37 % of the scene. Untouched because collision,
  `getSurfaceY` and the silhouette all hang off that mesh — not a small change.
- **Boulders are still 92k visible triangles** (the user kept their silhouette: they are cover, and their colliders
  are convex hulls of the drawn mesh).
- **Pixels.** Resolution scale is untouched and `--display scale=0.75` has never been run.
- **The `ms` methodology itself.** Until `x:rendererRender` can be measured with a spread below what a phase
  changes, no phase after this one can claim a frame-time result. That is the first thing to fix if the render
  block is picked up again.

### Phase B — the one-off ≥ 10 ms calls · done 2026-09-20 · `ui`

Four calls were listed here, each losing 1–3 frames, each firing once or twice per raid. **Three of them did not
reproduce**, and the one that did had a different owner than this file predicted.

#### What reproduced, and what it actually was

`--only s2,s3a,s4`, two runs per side. The only mark over one vsync that repeated was S4's **`u:allies` 9.10 ms and
9.30 ms, both on frame 37** — the frame twelve bugs are pulled and the androids first see them.

This file suspected `pickCoverSpot` / `getObstaclesNear`. **It is not.** Wrapping the world and enemy query surface
on the live page accounted for **0.4 ms of the 10.0**, and `getObstaclesNear` was called **zero times** on that frame.
Wrapping `EventBus.emit` instead named it at once:

| inside that one `AllySystem.update` | calls | ms |
|---|---|---|
| `bus:ally:ping` (contains the line below) | 3 | 9.30 |
| `bus:ally:chat` → `ChatLog.add` | 3 | 7.70 |
| …→ `ChatLog.measure` → `getBoundingClientRect` | 3 | **6.90** |
| world queries (`raycast` · `getSurfaceY` · `resolveCollision` · `queryNear` · 658 × `getHeightAt`) | 862 | 0.40 |

Then the deterministic version of the same question — every layout-forcing accessor patched on its prototype and
counted while `Engine.frame` is on the stack: **in the whole 637-frame S4 window there were 7 forced layouts, all of
them in `ChatLog`, all on one frame**, costing 8.3 ms of that frame's js. p50 and p95 per frame were **0**.

So the HUD's per-frame path was already clean (Phase 2 did that) and the entire one-off was one widget breaking
CLAUDE.md §4.2 「no layout read inside a frame」, once per chat line, for a year.

#### The second half: a first layout costs several times a later one

Removing the forced reads was **not enough on its own**, and the first after-run said so: the cost moved from
`u:allies` to `l:hud` and frame 37 still overran. Measured with one forced layout at the end of a frame that had
fired one kind of event (4 repeats per case, same build):

| fired inside one frame | 1st | 2nd | 3rd | 4th |
|---|---|---|---|---|
| nothing (control) | 0.1 | 0.1 | 0.1 | 0.0 |
| 3 × `ally:chat` | **5.3** | 0.5 | 0.5 | 0.5 |
| 3 × `ally:ping` | 1.8 | 0.9 | 0.9 | 0.9 |
| 3 × `ui:notify` | 0.7 | 0.5 | 0.7 | 0.6 |

The first row of the page costs ~10× the rest — selectors never matched, Korean glyphs never shaped. That is the
same shape as the other three Phase B suspects (a pool built on first use), and the same cure: **pay it before
anyone is watching.**

#### Built (and one thing un-built)

1. **`ui/hud/ChatLog` reads no layout at all.** The closed height was measured from a real row (`--chat-closed-h`);
   it is `3.5 × font-size × line-height + 3 gaps`, so `base.css` computes it with `calc()` — and the measurement was
   wrong anyway on a **wrapped** row (it made the closed box 3.5 × *that*). The bottom was pinned by
   `scrollTop = scrollHeight`; `.chat-lines` is now `column-reverse` around one `.chat-lines-inner`, so its scroll
   origin **is** the bottom edge and it re-pins itself through open / close, a font swap and a resize — the three
   cases the old `stick()` + `ResizeObserver` + `document.fonts.ready` existed for. Rows keep their oldest→newest
   document order (`history()`, the smokes and `querySelectorAll('.chat-line')` read it).
2. ~~**The remove → `void offsetWidth` → add animation idiom is gone**, at 14 sites, replaced by
   `ui/dom.restartAnim`.~~ **Built and retracted the same day — see [The sweep that was
   retracted](#the-sweep-that-was-retracted).** The idiom is still there, listed as an exception the smoke ratchets.
3. **First layouts are paid early.** `ChatLog` draws and drops one throwaway row on a timer at `bind` (the title
   screen is up, and it is off the frame so the guard stays at 0) — 3 × `ally:chat` went **5.3 → 1.4 ms**.
   `hud/Detection` and `hud/ScanReveal` build their pillar pools on **`world:ready`** instead of on the first corpse:
   that is inside the raid-entry hold, and it has to be `world:ready` rather than `game:newMission` because `world/`
   generates inside its own handler and `ui` is registered after it (docs/ARCHITECTURE.md gotcha).
4. **The rule is now counted, not commented**: `scripts/smoke-layout-reads.mjs` patches every layout-forcing accessor
   and fails if one is touched while `Engine.frame` is on the stack, outside the one listed idiom. It caught
   `hud/DamageOverlay` the first time it ran.

#### The sweep that was retracted

The smoke's first run failed on `hud/DamageOverlay`, which fires the CSS animation restart
`classList.remove(c); void el.offsetWidth; classList.add(c)` from a `player:damaged` handler — inside a frame. That
turned into a 14-site sweep behind a helper, `ui/dom.restartAnim`, which rewound the running animation
(`getAnimations()` → `currentTime = 0`) instead of forcing a layout. **It was wrong, and it was reverted the same
day.** Two ways, both found by testing the helper rather than trusting it:

- **A finished animation is not in `getAnimations()`.** With `animation-fill-mode: none` — `ammoFlash` (the magazine
  tick), `stamPulse`, `contractPulse` — the animation leaves the timeline when it ends, so with the class still on
  the element there is nothing to rewind and the *second* flash never plays. Measured directly: `first: added` ·
  `while running: rewound 1` · **`after it finished: rewound 0`**.
- **The animation often lives on a descendant.** `.imp-hud.rdy-major .imp-ring`, `.scall.rdy-major .sc-ring`,
  `.stamina.depleted .stam-bar .fill` — the class goes on the root, the animation on a child, so
  `root.getAnimations()` is empty from the start. Widening to `{subtree: true}` is not a fix either: it would rewind
  unrelated animations running on the same subtree.

And the read-free replacements do not exist. A same-task `remove` + `add` coalesces into no change, with or without
one `requestAnimationFrame` (the callback runs before the frame's style recalc, so both edits land in one update).
What *does* work is committing the removal with a flush — and a **style** flush is not cheaper than a **layout** one
on this HUD:

| 10 reads inside a dirtied raid frame | 1st | 2nd | 3rd | 4th |
|---|---|---|---|---|
| `uiRoot.clientWidth` (layout) | 0.9 | 1.2 | 1.1 | 1.9 |
| `getComputedStyle(el).animationName` (style) | 1.9 | 1.5 | 1.5 | 2.1 |
| remove → style flush → add, ×10 | 2.2 | 3.0 | 3.9 | 4.4 |

So the honest cost of the idiom is **one extra flush, ~1–2 ms, on a frame where a flash fires**, and the only
read-free cure left is a twin `@keyframes` per animation with two classes alternating — CSS duplication at 13 sites,
which is a decision, not a cleanup. It is **`docs/TODO.md` B-68** (and B-69 for the ten more outside `src/ui`, which
cannot import `ui/dom` under §4.1 anyway). The smoke keeps them visible: `KNOWN_IDIOM` is a 13-file ratchet that may
shrink and never grow, and the run asserts the flashes really fired so the ratchet is never green on an empty test.

**The lesson is the plan's own**: a 14-file sweep went in on the strength of 「this reads style, not layout」 with no
measurement behind either half of it. Both halves were false.

#### Result

Two runs per side, same machine state, `--only s2,s3a,s4`.

| | before 1 | before 2 | after 1 | after 2 |
|---|---|---|---|---|
| **S4 spike frames** (js over one vsync) | 1 | 1 | **0** | **0** |
| S4 js/frame max | 17.9 | 17.2 | **15.5** | **14.1** |
| S4 `u:allies` worst call | 9.10 | 9.30 | **2.80** | **3.10** |
| S4 `l:hud` worst call | 1.10 | 0.90 | 4.50 | 3.60 |
| S3a spike frames | 0 | 0 | 1 | 0 |
| S2 spike frames | 15 | 2 | 3 | 3 |

- **S4 is the honest win**: the first-contact frame no longer overruns a vsync, in both runs, and `u:allies`' worst
  call fell by a factor of three. `l:hud`'s worst rose because the one layout the chat used to force three times is
  now paid once by the HUD's own flush — the frame total still fell.
- **S2 and S3a are not Phase B's to close.** Every remaining spike there is led by `x:rendererRender` (10–26 ms on
  those frames), which is the GPU block, not a one-off js call. Note the before pair again: 15 and 2 on the same
  build — the banner's warning, in this table.
- **The retracted sweep cost nothing to give back**, which is the cleanest evidence that it was never the win. S4
  re-measured twice *after* the revert — with `hud/DamageOverlay` forcing a layout on every bite again — is
  **0 spike frames, js/frame max 15.3 · 13.5, `u:allies` worst 2.90 · 3.00**: the same numbers as the table above.
  All of the S4 result belongs to `ChatLog` and the warm-up.
- **Phase B's original 「done when」 (no spike frame over one vsync in s2 · s3a · s4, twice) is met for S4 and is not
  reachable for the other two from this folder.** It was written before the A/B showed the render block to be GPU
  time; it is restated here as **no one-off ≥ 10 ms js call**, which is met.

#### The three that did not reproduce

Driven through one raid with four burrow spawns, five bug types appearing for the first time, and ten corpses killed
7 m from the player — the exact conditions each was suspected under. **Nothing anywhere went over 2.4 ms**
(`u:enemies` 2.40 · `x:enemySpawn` 1.60 · `x:audioPlay` 0.90 · `h:detection` 0.20).

| # | Was | Now |
|---|---|---|
| A2 | `EnemySystem.update` 16.9 ms once per raid | **not reproduced** — but see below |
| A5 | `AudioSystem.play` 16.3 ms once (the `burrow_emerge` graph) | **struck**: worst 0.90–1.30 ms across five runs |
| — | `h:detection` 18.4 ms (the corpse light pillars) | **struck** as a spike; the pool is pre-built anyway (Built §3) |
| B2 | `AllySystem.update` 10.0–11.7 ms at first contact | **fixed — and it was `ui`, not `allies`** |

**A2 stays open.** One S2 run out of five today produced a single **`u:enemies` 18.80 ms** call (`after-phaseB-1`,
frame 742, a 29.9 ms frame). It fired once, in one run, and no targeted scenario brought it back. Whoever picks it
up: it is not a spawn frame, so the lead is still 「a type's shared geometry baked on first appearance」 — reproduce by
killing a type off and letting a patrol bring it back, and **count something** (geometry builds, material creations)
rather than timing `u:enemies`.

#### What the S2 spike frames are not

The user asked for S2's `l:hud` 3.6–4.2 ms spike frames as part of this phase, on the standing hypothesis **NEW-2**
(「per-body text writes and per-body DOM nodes dirty the layout」). **Counters refute it**, the same way they refuted
B1:

- **Per-body text writes: 14 in 836 frames.** Patching `textContent` · `innerHTML` · `className` · `hidden` ·
  `setAttribute` · `classList.*` · `appendChild` by call site, the only per-frame writer is
  `Detection.placeArrows`' `classList.toggle('scanned', …)` (~10/frame) — and `toggle` with an unchanged value
  mutates nothing, so it invalidates nothing. Nothing writes text per body.
- **The DOM does not grow with the crowd**: `#ui-root` holds 4 346 elements of which **1 085 are in layout** while a
  raid is idle and **1 116** with 60 bugs alive (+3 %). A layout is O(rendered boxes), and that number barely moves.
- **A normal frame's layout is 0.1 ms**, measured at the end of the frame body. The 1.0 ms `x:layoutFlush` in the
  harness is a *different* point (top of `HudSystem.lateUpdate`, after `HudSystem.update` dirtied the HUD).
- On the S2 spike frames `x:rendererRender` **and** `x:layoutFlush` are both ~3× their own average **at the same
  time**. Everything on the frame is slow at once, which is the signature of a whole-frame stall, not of a HUD owner.
  S2 also allocates the most of any scenario (63–65 MB/s vs 40–45 in S3a · S4, ~3 GC drops/s) — **B6 (garbage) is
  the honest next suspect there, and it was rated 「low」 on one run's evidence.**

What is left that is countable, and was not taken because no `ms` effect could be demonstrated for it: **1 085
rendered boxes for a screen that is showing the raid HUD.** `.hud.housing` (116 boxes — `hud/ShipManage`, a
ship-only screen) is laid out during every raid frame because it hides with `visibility: hidden`, and four `.menu`
screens (death · complete · title · pause, ~120 boxes) are in layout too because `.hidden` fades with opacity.
Taking them out of layout is a real cut of a deterministic counter; proving it moves a frame is not possible on this
machine at this noise floor.

### Phase C — the sustained CPU costs · done 2026-09-20 · `enemies`, `core`, `data`, `scripts`

Built, from the user's answers (recorded in `docs/DECISIONS.md`):

1. **B4 — enemy AI distance LOD**, the same shape the animation LOD got in Phase 1. Beyond `ENEMY_AI_LOD_HALF_M`
   (110 m) a body's whole AI + movement tick runs every other frame, beyond `ENEMY_AI_LOD_QUARTER_M` (140 m) every
   fourth. The distance is to the nearest **anchor** — camera, present players, androids, aggroable drones, the rover
   (`EnemySystem.collectAiAnchors`) — never to the camera alone, because a host simulates bugs fighting a squadmate
   200 m from its own screen. The near band is wider than the longest reach of anything the LOD applies to
   (`ARTILLERY_AI maxRange` 98 m), so a body that can fight anyone is never reduced; skipped frames' `dt` is carried in
   `Enemy.aiDebt`, so speed, cadence and every timer are unchanged; `Enemy.aiPhase` (0..3, per spawn) spreads the far
   half over the cycle so the LOD does not trade a steady cost for a spike every other frame. Never reduced: the
   tutorial, a falling corpse, a body in the air, a named rogue. And **a tick has a ceiling**
   (`ENEMY_AI_LOD_MAX_STEP_S` 0.08 s, tested against the tick a skip would *build* — `aiDebt + 2 × dt`): carrying the
   `dt` keeps every timer right but cannot keep what happens once per tick (one shot, one steering decision, one
   gravity step), so the LOD fades out by itself as frames get long — the quarter band survives at 60 fps, only the
   half band at 30, and nothing at the engine's own `MAX_DT` of 50 ms, which is where a headless smoke sits. The
   ceiling is under the shortest per-tick thing an enemy does, a rogue's `shotGap` (0.12 s).
2. **B3 — the light-budget recount stays exact and per-frame; only the walk got cheaper.** `countVisiblePointLights`
   is an explicit stack walk instead of `traverseVisible` (a recursive method call plus a closure call per node,
   ≈3 978 nodes a frame) and skips the padding group it already knows the size of. The flag and the interval the
   plan suggested were **rejected**, with a reason worth keeping: point lights really do enter and leave the scene
   mid-raid (`extraction/Ship`, `player/Hellpod`, `game/parts/Leader`), and one frame with the count wrong is two
   recompiles of every lit material.
3. **B5 — one camera read per frame.** `EnemyHost.camPos` is stamped at the top of `EnemySystem.update` and serves
   the AI LOD, the animation LOD and the footstep range gate alike; `model.emitEnemyStep` no longer calls
   `getWorldPosition` per footstep (`model.StepHost` so the replica's narrower host satisfies it too).
4. **B6 — counted, not fixed** (the user's scope). `perf-measure.mjs --alloc`.

#### Result — two runs per side, same machine state, `--only s2`, measured twice over

The phase was measured once before the tick ceiling existed and once after, hours apart. **The machine state moved
between them by more than the change did** — and the ratio did not move at all, which is the cleanest demonstration
of this file's banner anyone has produced here:

| | before 1 | before 2 | after 1 | after 2 | |
|---|---|---|---|---|---|
| `u:enemies` ms/frame | 1.018 | 0.986 | **0.860** | **0.845** | −15 % (morning state) |
| `u:enemies` ms/frame | 0.769 | 0.769 | **0.658** | **0.667** | −14 % (evening state, final build) |
| `x:lightBudget` ms/frame | 0.156 | 0.157 | **0.142** | **0.132** | −12 % |
| `x:lightBudget` ms/frame | 0.119 | 0.112 | **0.090** | **0.095** | −20 % |
| systems total ms/frame | 1.95 | 1.97 | 1.86 | 1.86 | evening pair |
| js/frame p50 | 6.8 | 7.0 | 6.9 | 6.9 | evening pair — flat, as 0.13 ms in 6.9 must be |
| AI LOD census | 60 full · 0 half · 96 quarter | 60 · 0 · 101 | 60 · 0 · 101 | 60 · 0 · 99 | |

(The evening 「after」 was measured twice more as the build changed under it — with the tick ceiling at
`ENEMY_AI_LOD_HALF_M` 70 it read 0.657 · 0.648, at 110 it reads 0.658 · 0.667. Widening the full-rate band from
70 m to 110 m costs nothing, exactly as the census predicts: at either value the half band holds **zero** bodies.)

The same build's `u:enemies` reads 0.85–0.86 in one state and 0.65–0.66 in another, six hours apart on an idle
machine. **An absolute `ms` from this harness means nothing across sessions; a ratio measured inside one state means
something**, and both pairs give the same one.

- **`u:enemies` −15 %, and it repeats — in two different machine states.** Within a pair the two sides never
  overlap (0.986–1.018 against 0.845–0.860; 0.769–0.769 against 0.648–0.657). A **mark average over ~1 300
  frames** is the one `ms` figure in this plan that repeats inside a session — `x:lightBudget` gave 0.156 and 0.157
  on two runs of one build, and `u:enemies` 0.769 twice — which is why these rows are quoted as results and
  `js/frame p50` is not.
- **`x:lightBudget` −12 % and −20 %** in the two pairs. Small, real, and not worth a third digit.
- **The AI LOD's ceiling is set by the scenario, and the new census says so out loud**: S2 is **60 bodies at full
  rate, 0 in the half band and 100 beyond 140 m**. The far hundred are the 56 nest eggs and the site humanoids, which
  were only ~0.2 ms of `u:enemies` to begin with; three quarters of that is what the phase removed. **The 60 bugs at
  25–40 m are the cost, and a distance LOD is not allowed to touch them by design.** Anything that wants the near
  band has to make one bug's tick cheaper, not rarer.
- **Nothing else moved.** Spike frames are 4 · 5 → 3 · 4 with every one of them still led by `x:rendererRender`
  (10–28 ms), which is the GPU block. `js/frame p50` is flat inside its spread, as a 0.17 ms change in a 9.6 ms frame
  must be.

#### Two things the smokes caught that the measurement never would have

Neither shows up in a frame-time number, and both are the sort of thing a perf change quietly breaks.

- **A carried `dt` keeps timers, not per-tick events.** `smoke-humanoid-ai` printed 「a rogue in the same spot fires
  more (0 vs android 15)」. Firing is `burstTimer -= dt; if (burstTimer <= 0) { fire(); burstTimer = shotGap }` — one
  shot per **tick**, whatever the tick's length — so a tick longer than `shotGap` (0.12 s) loses shots, and a
  headless smoke runs at the engine's `MAX_DT` of 50 ms where the quarter band would build a 200 ms tick. The cure
  is `ENEMY_AI_LOD_MAX_STEP_S`: **the LOD may never build a tick longer than 0.08 s**, tested against the tick a
  skip would produce (`aiDebt + 2 × dt`), so it fades out on its own as frames lengthen and is inert at 50 ms.
  Every per-tick action in the folder is now bounded by one csv number.
- **The threshold was read off the wrong constant.** 「70 m is past every engagement range (`ARTILLERY_RANGE` 63)」
  was wrong: 63 m is where an artillery bug *stands*, and `ARTILLERY_AI maxRange` is **98** with an approach out to
  88, which is why `smoke-phase4` kept finding the piece in `chase` at 76–87 m. `ENEMY_AI_LOD_HALF_M` is **110**.
  It costs nothing measurable — the census says the half band is empty at either value, because S2's far bodies are
  all past 140 m — and it makes the invariant true rather than nearly true.

#### B6 — allocation by owner: three counters, two of which lie the same way

The plan raised B6 to 「best remaining suspect」 on the strength of S2 allocating 63–65 MB/s. Counting it took three
independent instruments, and **the first two both say the raid barely allocates at all**:

| instrument | what it reported for one S2 window |
|---|---|
| `performance.memory` delta-sum per frame (what the 63 MB/s figure is) | **62.8–64.3 MB/s**, 63–66 GC drops / 20 s |
| V8 sampling heap profiler over CDP (`HeapProfiler.startSampling`) | **0.085 MB/s**, top owner three.js `cloneUniforms` 42 % |
| construct trap on typed arrays · `ArrayBuffer` · `AudioContext.createBuffer` | **~0 MB/s** |

Two calibrations settle which one to believe. A known allocation of 1 000 000 live objects came back as **47.3 MB**
from the sampling profiler — it is accurate on what survives. An idle headful rAF page reported **0.0 MB/s on both**
counters — `performance.memory` is not manufacturing the number. The gap is therefore the profiler's own rule: it
keeps only the samples whose object is **still alive** when the profile is taken, so pure churn is invisible to it.
**A CDP sampling profile cannot answer 「who makes the garbage」**, and that is worth knowing before anyone reaches
for it again.

What can answer it is the same signal the probe already had, read around **each wrapped mark** instead of once per
frame (`--alloc`, upper bound per mark):

| mark | MB/s |
|---|---|
| `x:rendererRender` | **15.1** |
| `u:world` | 7.9 |
| `u:enemies` | 6.5 |
| `l:hud` | 4.2 |
| `x:audioPlay` | 2.8 |
| `u:net` · `u:housing` · `u:player` · `u:weapons` · `u:hud` · rest | ≤ 1.1 each |

**No owner owns it.** The largest single line is three.js's own render path — render lists, sort arrays, uniform
clones — which this repo does not write, and the game-side total (`world` + `enemies` + `hud` ≈ 19 MB/s) is spread
over everything a frame does. **B6 is struck as a lead**: there is no allocation hot spot to remove, which is
consistent with Phase 0's 「no dropped frame was attributable to GC」 and with the S2 spikes being led by the render
block. The instrument stays (`--alloc`) because the next person to suspect garbage should start from these rows.

#### What Phase C leaves

- **The near band is untouched and is where the cost is.** 60 bugs at 25–40 m are ~0.65 ms of `u:enemies`; making one
  tick cheaper (perception cadence, obstacle refresh, steering) is a different phase from making ticks rarer, and it
  was not in this one's scope.
- **The flat DOM cut** (`hud/ShipManage` 116 boxes + four faded `.menu` screens ≈ 120, of `#ui-root`'s 1 085 laid-out
  boxes) — still recorded, still unbuilt, still not demonstrable at this machine's noise floor.
- **Phase D took the rest** — S5 and the multiplayer findings A6 · C1 · C3 — and struck all three.

### Phase D — S5 and the multiplayer findings · done 2026-09-20 · `scripts` (harness only)

**The one phase that changed no game code, because none of its three findings survived being counted.** Everything
the user reported about *other players* was unmeasured until here.

#### What was built — the harness, not the game

`scripts/perf-measure.mjs` gained `--only s5a` (two humans idle) · `s5b` (+ the same 60-bug ring S2 uses) · `s5c`
(two humans + androids, idle), and three counters. Nothing in `src/` was touched.

- **Two clients, one machine.** The host is the same headful 1280×720 page S1–S4 run in, so its rows stay comparable
  with theirs; the peer is a second browser, headless 960×540 on the same GPU (`--peer-headful` to watch it). The
  probe is page-local, so it installs on both, and one `record` call starts and stops them together — hence the
  **`Replica p95 ms`** column.
- **The squad is made by code**: `createLobby` (docked) + `joinLobby(code)` + `setReady` on both + `startGame`. The
  relay's rule is host + everyone ready + a 목표 행성; the pod is only the hub's way of setting `ready`, and driving
  its hold gauge would measure the harness. A join **by code** also cannot be hijacked by a stale public lobby, which
  quick match can. S5c recruits the cockpit bays first (`setAndroidBay`) and so needs a raid of its own — the relay
  caps the squad at `NET_MAX_PLAYERS` 4, humans first, so two humans leave room for two of the three bays.
- **The wire census**: every message that crossed the socket, keyed by `t` + `ev`, with bytes/s, bytes per message,
  and the single **worst inbound frame** with its own breakdown. Outbound is `WebSocket.prototype.send`; inbound is
  the prototype's `onmessage` accessor, because `net/NetClient.ts` assigns the property rather than adding a listener.
- **`o:wireIn`** — time spent inside `onmessage`. It is the one mark in this harness that is **not** inside
  `Engine.frame`: inbound handling is a task of its own, so its cost can never appear in `js/frame`, only as a late
  rAF. That is exactly the shape a spawn burst would have on a replica, which is why it needed its own prefix.
- **The `SoldierPool` counter** (C1): acquires, **builds** (a pop shrinks the pool, a build does not) and releases,
  counted for the page's whole life as well as per window — a remote body is built at **raid entry**, which is on the
  far side of the settle and outside every window. That is why the first S5 run reported `0 acquired` and told us
  nothing.

#### How to read these rows

The peer is a second Chrome **on the same GPU**, in a different window size. So the render block is contaminated on
both sides, the replica's frame time is not comparable with the host's, and every `ms` below is a hint (the banner at
the top applies twice over). **The three verdicts rest on counts only** — bytes, messages, builds.

#### Results — two runs per side, same machine state

| | S5a host | S5a replica | S5b host | S5b replica | S5c host | S5c replica |
|---|---|---|---|---|---|---|
| bodies | 98 · 102 | — | 158 · 162 | — | 101 · 102 + 2 androids | — |
| frame p50 / p95 | 16.7 / 16.8 | 16.7 / 16.8 | 16.7 / **33.3 · 33.2** | 16.7 / 33.4 | 16.7 / 16.8 | 16.7 / 16.8 |
| frames > 33 ms | **0 · 0** | **0 · 0** | 32 · 12 | 80 · 63 | **0 · 0** | **0 · 0** |
| js/frame p50 | 6.1 · 6.5 | 6.6 · 7.1 | 12.1 · 11.7 | 13.8 · 13.9 | 6.3 · 6.7 | 7.1 · 7.5 |
| draw calls | 984 · 1 014 | 1 099 · 1 125 | 1 270 · 1 305 | 1 455 · 1 487 | 1 062 · 1 093 | 1 271 · 1 325 |
| **wire out** | **22.9 · 25.4 KB/s** | 5.0 · 4.9 | **53.5 · 56.1** | 4.6 · 4.7 | **29.5 · 29.3** | 4.9 · 4.9 |
| **wire in** | 5.0 · 5.0 | **23.0 · 25.5** | 4.6 · 4.7 | **53.7 · 56.3** | 5.0 · 5.0 | **29.7 · 29.5** |
| worst inbound frame | 0.3 KB | **8.6 · 8.9 KB** (`es` keyframe) | 0.3 KB | **13.7 · 14.3 KB** (`es` keyframe) | 0.3 KB | **9.1 · 8.9 KB** (`es` keyframe) |
| `o:wireIn` | — | — | — | **0.083 · 0.080 ms/frame** (worst call 1.30 · 1.30) | — | — |

Solo `S2` on the same machine state, for the subtraction: js/frame p50 **9.2 · 9.3**, 1 294 · 1 326 draws,
727 · 739k triangles, `x:rendererRender` 6.615, `ring60` job **3.50 · 4.50 ms**, 2 · 2 spike frames.

#### The three verdicts, each from a count

- **A6 — one `ee spawn` JSON send per body: struck.** `enemies/parts/Pool.spawn` does one `net.send` per body, inside
  the spawning frame, so `ring60` is 60 messages. Measured: **121 B each, 7.3 KB in one frame.** On the replica that
  burst **never became the worst inbound frame** — that is always an `es` **keyframe** (8.6–14.3 KB), which arrives
  every `NET_ENEMY_KEYFRAME_S` = 2 s regardless. And it never cost a frame: `worst rAF delta after` the `ring60` job
  is **16.7–16.8 ms in all four runs**, solo and squad alike. The host's `ring60` frame is 6.9 · 8.6 ms against
  solo's 3.5 · 4.5 — a second Chrome on the same machine is inside that difference — and both stay under one vsync.
  Batching the spawns would remove a burst smaller than what the same link carries routinely.
- **C1 — `SoldierPool` pre-fill: struck.** One raid entry acquires **8** bodies and **builds 4** (6 when two androids
  come along — they use the same pool); the worst single build is **0.30–0.50 ms**, and every one of them happens at
  raid entry, inside the load gate. Zero builds occurred in any measured window. A pre-fill would move ~1.5 ms once,
  off-frame.
- **C3 — the `ally state` encoding: struck.** `allies/parts/Sync.update` sends **one message for the whole roster**
  every `ALLY_NET_INTERVAL_S` (10 Hz), to `'others'`. Measured: **507–519 B for two androids** (~255 B each),
  **4.9–5.0 KB/s** — a quarter of the `es` stream beside it in the same window (19.0–19.2 KB/s) and a tenth of what
  the host uploads in S5b. Host-side `u:allies` is **0.027–0.028 ms/frame**. There is nothing to encode away.

#### NEW-3 — what a squadmate actually costs: a body to draw, not a network

- **The body is the cost, and it is the cost Phase 1 already cut.** The draw-call census shows
  `RemoteSoldier:<id>` at **73 visible + 32 shadow** draws — the same numbers as the local `Soldier` group, because
  the remote avatar is a `SoldierModel` like any other. An android in S5c is the same body from the same pool.
- **The wire is small and does not scale with the squad.** The host uploads 23–25 KB/s idle and 54–56 KB/s with 158
  bodies, **85 % of it `es`** (10 Hz, ~30 B per body per snapshot). Every one of those is a single
  `net.send(msg, 'others')` that the **relay** fans out, so a four-player squad costs the host the same upload as a
  two-player one. `ps` is a flat 4.6–5.0 KB/s each way per person.
- **A replica's inbound handling is 0.08 ms/frame**, worst single `onmessage` 1.3 ms, and it is outside the frame
  entirely. Nothing about being a replica showed up as a frame cost.
- **Every S5b spike frame, on both sides, is led by `x:rendererRender`** (10–34 ms) — the same GPU block that leads
  solo S2's. There is no multiplayer-specific spike in this data.
- **An idle two-person raid is free**: S5a and S5c are 16.7 / 16.8 with **zero** frames over 33 ms on both sides, in
  every run. What moves when a squadmate arrives is one more body in the scene.

#### What Phase D leaves

- **A replica's frame time is still unmeasured**, and cannot be measured this way: both clients shared one GPU, and
  the peer drew *more* than the host (1 455–1 487 against 1 270–1 305 — a different camera, not a replica cost). A
  second machine is the only clean answer.
- **A full squad was not run.** `NET_MAX_PLAYERS` is 4, so S5c is two humans + two androids; four humans, and three
  androids with one human, were not measured.
- **Nothing here touched a real link.** Every byte crossed 127.0.0.1 at 0–1 ms rtt. The number that would matter on a
  WAN is `es`: 47 KB/s with 162 bodies, and it is the host's upload alone that carries it.

### Struck by measurement

The old Phase 1 (pre-warm pools and geometry, A1 · C1), the old Phase 3 (throttle android AI per frame, B2), the
old Phase 4's search and capacity work (A3 · A4) — and **B1 itself as a cost driver**. The draw-call cut is built and
kept for weaker machines; **do not spend more of this plan on draw calls.**

Struck by Phase C on top of those: **B6** — raised to 「best remaining suspect」 on one run's evidence and now counted
three ways: the 63 MB/s is real and **nothing owns it**, the biggest single line being three.js's own render path.
**B3** and **B5** are done and were always small. **B4 is done and bounded**: the LOD works, and the scenario census
says a distance LOD could never have been large here.

Struck by Phase B on top of those: **A5** (the `burrow_emerge` audio graph — the 16.3 ms call never came back in five
runs), **`h:detection`** (the corpse pillars — 0.20 ms worst, and the pool is pre-built now anyway), and the
**per-body half of NEW-2**. ~~**B6 moved the other way** — it was rated 「low」 on one run and is now the best remaining
explanation for the S2 spikes.~~ *(Superseded by the Phase C paragraph above: B6 was then counted three ways and
struck — the 63 MB/s is real and nothing owns it. The sentence is kept because the plan keeps its history.)*
**A2 alone survives unreproduced**, which is why it is still listed.

Struck by Phase D, last of all: **A6** (the `ee spawn` burst is 7.3 KB, smaller than the `es` keyframe that arrives
every 2 s anyway, and it never dropped a frame), **C1** (4 body builds per raid entry at 0.3–0.5 ms each, inside the
load gate) and **C3** (`ally state` is one 511 B message at 10 Hz for the whole roster). Phase D **built nothing** —
by the user's own scope, 「measure first, fix only what a counter justifies」, and no counter justified anything.

---

## Decisions — answered 2026-09-20 (full text in `docs/DECISIONS.md`)

1. **Bug geometry detail** → **every type to 12–14 segments** (not just the small ones). Built as
   `BUG_MESH_SEGMENTS` = 12.
2. **Shadows** → **the soldier's rule for humanoid enemies**; the shadow map and cascade range stay as they are
   (shrinking them softens every shadow in the raid).
3. **Bloom's default** → **stays on**; the perf guard already turns it off under load. It then measured free anyway.

Asked and answered the same day, for Phase A2: **the world's shadow casters** → distance LOD **and** small objects;
**pebble geometry** → lowered; **boulder geometry and the terrain** → left alone. See
[Still open after Phase A2](#still-open-after-phase-a2) for what that leaves.

And for Phase C, the same day: **scope** → measure first, then B4 · B3 · B5 (the flat DOM cut stays unbuilt);
**the AI LOD's shape** → a distance LOD like the animation LOD's, *not* time slicing and not both; **B6** → counted
by owner only, no fix. Full text in `docs/DECISIONS.md` 「2026-09-20 — 지속 CPU 비용」.

And for Phase B, the same day:

4. **Scope** → the widest of three: fix what reproduced, close the lazy-build shape as well, **and** take S2's
   `l:hud` spikes. The third of those turned into a refutation rather than a fix — see
   [What the S2 spike frames are not](#what-the-s2-spike-frames-are-not).
5. **`hud/ChatLog`** → **remove the measurement, do not make it cheaper** (rejected: deferring the read to the next
   frame; batching to one read per frame — both leave one forced layout standing).
6. **The rule gets a smoke**, not a note in `scripts/README.md`. It failed on `hud/DamageOverlay` the first time it
   ran.

---

## What this plan does not cover
- The ship (hub) frame rate and `snapshotFace` (C4) — separate scene, separate light pool; only if the user reports it.
- `verify:all` run time (`docs/TODO.md` E-12) — related (page frame cost) but a different goal.
- WebGPU / worker offloading — out of scope until the cheap fixes above are measured.
- Slower machines: every number here is from an RTX 4080 SUPER, where **nothing sustained a drop at all**. A
  CPU-bound machine would have gained from the Phase 1 draw-call cut that this one did not; a re-measure there is the
  honest way to know.
