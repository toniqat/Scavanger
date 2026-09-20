# Performance plan — frame hitches with many bodies

**Status:** **Phase 0 measured (2026-09-19) · Phases 1 · 2 · A · A2 · B built (2026-09-20).**

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
found was not the one this file predicted. **Phase C or D is next.** The 2026-09-20
A/B (same machine state, back to back, `--only s2` twice per side) **refutes the central finding of Phase 0**: the
work removed 31 % of the draw calls and 36 % of the scene nodes and `x:rendererRender` did not move. The render
block is not paid per draw call on this machine — it is the GPU. The ranking below is rewritten around that.

**Symptom (user report):** the frame rate drops or stutters badly (a) with several other bodies present — remote
human players, or the 3 android squadmates — and (b) when many bugs are alive, worst of all at the moment a new
group spawns.

**One-line diagnosis, after three rounds of measuring:** **a raid is GPU-bound on this machine, `x:rendererRender`
is mostly the CPU waiting for it, and that wait is too noisy to attribute** (±1.7 ms on one build). What repeats is
that the render block does **not** track draw calls or scene nodes, so the work is triangles and pixels. Nothing in
S1–S4 sustains a drop on an RTX 4080 SUPER — every scenario sits on the 60 Hz vsync — so what the user feels is
individual frames. Phase B took those and **S4's no longer overruns**; the ones left in S2 · S3a are led by the
render block, i.e. the same GPU question, not by any one-off.

---

## Next session starts here

1. **Read the banner above, then [What the 2026-09-20 A/B says](#what-the-2026-09-20-ab-says)** before planning
   anything — between them they strike 「draw calls」 as a cost and strike every `ms` figure in this file as a
   verdict.
2. **Phase B is done** ([what it found](#phase-b--the-one-off--10-ms-calls--done-2026-09-20--ui)). Its lesson for
   whoever picks this up: **the autopsy names a mark, and the mark was not the owner.** The 10 ms `u:allies` was
   `ui/hud/ChatLog` forcing a layout from inside `AllySystem.update`, not `pickCoverSpot`. Do not write a fix against
   a mark name — instrument until a **counter** names the line.
3. **Counters beat traces here.** What cracked Phase B was patching the layout-forcing accessors on their prototypes
   and counting them per frame: 7 reads in a 637-frame window, all of them in one file, on one frame. That technique
   is now a smoke (`scripts/smoke-layout-reads.mjs`) and the same shape — *count the thing, don't time it* — is what
   the banner above is asking for everywhere else.
4. **Take a fresh `before`** — the logs are git-ignored and the tree moves:
   `npm run dev`, then `node scripts/perf-measure.mjs --only s2 --label before-phaseC`. **Run it twice.** One run
   is not a measurement: on 2026-09-20 two runs of one build gave 5 and 22 frames over 33 ms.
5. Use `--display bloom=0`, `--display bloom=0,shadows=0` to split the render block whenever a change is supposed to
   touch it. That split is what turned the ranking over — and in Phase A it is what showed the 6.0 ms target to be
   arithmetically impossible.
6. **If the render block is picked up again**, fix the measurement first (see the banner), then look at the terrain's
   346k triangles and at resolution scale — [Still open after Phase A2](#still-open-after-phase-a2).

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
*(Phase A took the body-side vertex work and A2 the world's; the pixel work is still untouched and needs a decision.
Phase B took the one-off spikes. **What is left is C and D.**)*

---

## Findings inventory — measured verdicts

**A. Spawn-frame spikes**

| # | Finding | Measured | Verdict |
|---|---|---|---|
| A1 | Pools never pre-warmed (`parts/Pool.ts`, `Enemy.ts`, `models/BugModel.ts`) | cold 4.9 ms vs warm 3.9 ms for 8 bodies → **0.12 ms/body** | **struck** |
| A2 | Shared geometry baked lazily on a type's first appearance | Phase B could not reproduce it on demand (burrows · five fresh types · corpses: nothing over 2.4 ms), but **one S2 run of five** still gave a single 18.8 ms `u:enemies` | **still open, still unreproduced** → Phase C |
| A3 | Placement search raycasts per living player per candidate | patrol tick 0.0–0.1 ms total | **struck** |
| A4 | `ensureCapacity` rescans; `despawn` uses `indexOf` | never above the noise floor | **struck** |
| A5 | `burrow_emerge` synthesises ~15 sources per bug | 0.27 ms/frame over 5 600 calls; the 16.3 ms call **never came back** — worst 0.90–1.30 ms across five 2026-09-20 runs | **struck** (Phase B) |
| A6 | One `ee spawn` JSON send per body | solo only, not measured | **open, needs S5** → Phase D |
| A7 | First-draw material init per cloned material | no compile spike seen | **struck** |

**B. Sustained per-body cost**

| # | Finding | Measured | Verdict |
|---|---|---|---|
| B1 | **Draw calls** — bug 17–18 meshes, soldier ≈ 130, no batching / instancing / LOD | **cut 31 % on 2026-09-20 with no change in the render block** | **refuted as a cost driver; the cut is done and kept** |
| **NEW-1** | **GPU frame, not CPU submission**: the render block scales with triangles (1.0 M in S2) and pixels | the `--display` split above; then Phase A bought **0.6 ms for 6.7 % of the triangles** | **confirmed and acted on — Phase A.** Refinement: bloom is free here, the shadow pass is 1.07 ms, and what is left belongs to the **world** |
| **NEW-2** | **Layout flush** 1.04–1.07 ms/frame is one layout of a HUD dirtied by **per-body text and per-body nodes** | Phase B counted both: **14 text writes in 836 frames**, and the rendered box count goes 1 085 → 1 116 (+3 %) when 60 bugs arrive | **the 「per-body」 half is refuted.** What was real, and is fixed, is `ChatLog` forcing a layout **per chat line** (8.3 ms in one frame) — Phase B |
| B2 | Android combat AI per ally per frame | 0.055 ms/frame for 3; the 10.0–11.7 ms first-contact call was **`ui/hud/ChatLog`, not `allies`** — world queries were 0.4 ms of it and `getObstaclesNear` ran zero times | **struck entirely; the one-off is fixed in `ui`** (Phase B) |
| B3 | `LightBudget.update` walks the whole visible scene every frame | 0.10 idle → 0.27–0.30 at 160 bodies (worst 1.7) | **small, real** → Phase C |
| B4 | Enemy AI has no distance LOD or time slicing | 0.19 at 44 bodies → 0.41 at 99 → **1.0–1.3 at 160**; worst call 4.9 ms | **confirmed, #2 of the CPU costs** |
| B5 | Bug footsteps scan all active enemies before the range gate | inside `u:enemies`; `x:audioPlay` 0.27 ms/frame | **small** → Phase C |
| B6 | Recurring garbage | 18–65 MB/s, ~3 GC drops/s. S2 allocates 63–65 MB/s against 40–45 in S3a · S4, and S2 is the scenario whose spike frames have **everything** slow at once | **raised: the best remaining suspect for the S2 spikes** → Phase C |

**C. Multiplayer / squadmate-specific** — C1 (`SoldierPool.acquire`), C3 (`ally state` encoding) were never reached
without S5; C2 (a `SoldierModel` per corpse) never fired; C4 (`snapshotFace`) is ship-only and out of scope.
**All four stay open; S5 (Phase D) is what would close them.**

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

### Phase C — the sustained CPU costs · `enemies`, `ui`, `core`, `audio`

**Next, with D.** A · A2 · B are done; take these only as far as the numbers justify, and read the banner first —
two of the four bullets below are here *because* a counter, not a timer, put them there.

- **B4, the biggest of them: enemy AI is 1.0–1.3 ms at 160 bodies and scales super-linearly.** Distance LOD or time
  slicing, the same shape the animation LOD just got (`EnemySystem.poseSkip` is the template, and the constants
  belong next to `ENEMY_ANIM_LOD_*` in `data/constants.csv`).
- **NEW-2 is mostly closed and partly refuted** (Phase B): nothing writes text per body, the rendered box count does
  not follow the crowd, and the one real offender (`ChatLog`, a forced layout per chat line) is fixed and guarded.
  What is left is a **flat** cut, not a per-body one: 1 085 of `#ui-root`'s 4 346 elements are in layout during a
  raid, including `hud/ShipManage` (116, ship-only, `visibility: hidden`) and four faded-out `.menu` screens (~120).
  Take them out of layout if the counter is worth it — no `ms` effect is demonstrable at this machine's noise floor.
- **B6, the S2 spikes**: on those frames `x:rendererRender` *and* `x:layoutFlush` are both ~3× their own average at
  the same time, which is a whole-frame stall rather than any one owner. S2 also allocates the most (63–65 MB/s).
  Measure allocation by owner before writing anything.
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

The old Phase 1 (pre-warm pools and geometry, A1 · C1), the old Phase 3 (throttle android AI per frame, B2), the
old Phase 4's search and capacity work (A3 · A4) — and **B1 itself as a cost driver**. The draw-call cut is built and
kept for weaker machines; **do not spend more of this plan on draw calls.**

Struck by Phase B on top of those: **A5** (the `burrow_emerge` audio graph — the 16.3 ms call never came back in five
runs), **`h:detection`** (the corpse pillars — 0.20 ms worst, and the pool is pre-built now anyway), and the
**per-body half of NEW-2**. **B6 moved the other way** — it was rated 「low」 on one run and is now the best remaining
explanation for the S2 spikes. **A2 alone survives unreproduced**, which is why it is still listed.

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
