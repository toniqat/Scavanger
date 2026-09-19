# Performance plan — frame hitches with many bodies

**Status:** analysis done 2026-09-18 by static code reading (three parallel audits + spot checks). **Nothing has been
measured yet and nothing has been changed.** The next session starts at [Phase 0](#phase-0--measure-first) and must not
touch code before the numbers exist. Line numbers below are from the 2026-09-18 working tree and may drift by a few lines.

**Symptom (user report):** the frame rate drops or stutters badly (a) with several other bodies present — remote human
players, or the 3 android squadmates — and (b) when many bugs are alive, worst of all at the moment a new group spawns.

**One-line diagnosis:** two separate problems overlap. A **spawn spike** (bodies are built on the spawning frame because no
pool is pre-warmed, placement raycasts once per player per candidate, one WebAudio graph per emerging bug) and a **sustained
per-body cost** (17–18 meshes per bug, ~130 draw calls per soldier body, no batching / instancing / distance LOD, plus
host-only android AI that allocates and searches cover every frame).

---

## How to work this plan

1. **Read first:** `CLAUDE.md` §4.1 (no numbers in code → csv), §4.5 (never change the point-light count at runtime; every
   scene compiles through `ctx.shaders`), §6 (verify). Then the README of every folder you touch.
2. **Phase 0 before anything else.** The analysis ranks by reasoning; only a profile decides. If a measured item turns out
   cheap, drop it — do not implement fixes whose cause was not observed.
3. **Ask the user before Phase 2** (`AskUserQuestion`): the visual trade-offs listed in [Decisions needed](#decisions-needed)
   are theirs, not ours.
4. **One phase = one verify cycle** (`npm run verify`; `verify:all` at the end of the session). Record results as
   `CLAUDE.md` §6 says: numbers and what changed → commit message; new invariants → comment above the code; the user's
   choices → `docs/DECISIONS.md`; this file is updated with the measured table and then, once every phase is done or
   retired, **deleted** (plans do not live on — `docs/plans` was retired in `dd1fd69`).
5. Parallel agents: follow the memory rule — lead owns vite/relay; agents run smokes with `--only --keep-relay --log-dir`;
   nobody but the lead runs `e2e:mp`.

---

## Phase 0 — measure first

Goal: a table with **frame time, script time, draw calls and GC** for five scenarios, on the host and on a replica, so
every later phase has a before/after number.

### Tools already in the repo
- `window.__game` is the `Engine` (`src/main.ts:122`). `__game.ctx.renderer.info.render.calls` / `.triangles`,
  `__game.getSystem('enemies')`, `__game.getSystem('allies')`, `__game.ctx.timeScale`.
- Enemy debug hooks on `getSystem('enemies')` (`src/enemies/EnemySystem.ts`): `debugSpawn(type, {x,z}, chase)`,
  `debugSpawnBurrow(type, {x,z}, seconds)`, `debugAmbientGroup(threat)`, `debugSpawnNamed`, `debugSnapshot`.
- Android squadmates without a relay: dev console `/android 1` up to three times (`src/allies/parts/Console.ts`).
- Two real clients through the relay: `scripts/e2e-multiplayer.mjs` (puppeteer, `--use-angle=d3d11`) is the template for a
  measurement script; `scripts/smoke-burrow.mjs` shows how to trigger burrow spawns headlessly.
- Chrome DevTools Performance panel (or puppeteer `page.tracing`) for the spike frames; `performance.mark` around
  `Pool.spawn` / `Spawner.update` / `NestDirector` refill gives the spawn cost without a trace.

### Scenarios (record each on the host and, where marked, on a replica)
| # | Scenario | How to reach it | Replica too |
|---|---|---|---|
| S1 | Solo raid, idle, ambient population only | start a threat-2 raid, stand still 30 s | — |
| S2 | Solo + 60 bugs alive around the player | `debugSpawn('scavenger', …)` ×40, `'warrior'` ×10, `'hunter'` ×10 in a ring at 25–40 m, `chase=false` | — |
| S3 | Burrow group spawn spike | `debugSpawnBurrow` ×8 in one frame (patrol-sized group), also the natural patrol tick (`Spawner.update` timer 12–25 s) | yes |
| S4 | 3 androids in combat | `/android 1` ×3 in the ship, launch, pull a group | host only (AI) — body cost on replica too |
| S5 | 2 humans + 2 androids, 60 bugs | e2e-style two clients + `/android`, then S2 spawn | yes |

### Metrics per scenario
- Frame time p50 / p95 / max over 20 s (`requestAnimationFrame` deltas); count of frames > 50 ms (`Engine.MAX_DT`).
- `renderer.info.render.calls` at rest.
- Script time split from a 10 s trace: `EnemySystem.update`, `AllySystem.update`, `LightBudget.update`
  (via `ShaderWarmup.beforeRender`), `AudioSystem` node creation, `JSON.parse/stringify`, GC (minor + major count, longest pause).
- For S3: wall time of the frame that contains the spawn calls, split into rig construction (`new Enemy`), placement search
  (`findSpawnCenter` + `placeMember`), `ensureCapacity`, audio (`burrow_emerge`), net sends.
- Machine, GPU, browser, resolution scale and bloom/shadow settings — record them; the perf guard turns bloom off after 240 slow
  frames (`Engine.perfGuard`), which would silently change the baseline mid-run.

### Results table (fill in)
| Scenario | Host p50 / p95 / max ms | Frames > 50 ms | Draw calls | Replica p95 ms | Dominant cost (from trace) |
|---|---|---|---|---|---|
| S1 | | | | | |
| S2 | | | | | |
| S3 | | | | | |
| S4 | | | | | |
| S5 | | | | | |

**Exit criterion for Phase 0:** the table is full and each later phase below has been re-ranked (or struck) by the trace.

---

## Findings inventory (ranked by expected impact, from the analysis)

**A. Spawn-frame spikes** (visible mid-raid: patrol tick, nest refill, artillery + escorts, raider drop, sandworm spit; the
`world:ready` mass spawn is hidden behind the load hold and is *not* what the user sees)

| # | Finding | Where | Who pays | Scales with |
|---|---|---|---|---|
| A1 | Pools are never pre-warmed: `acquire` builds `new Enemy` (full rig: 17–18 meshes + ~23 groups, 3 cloned materials) on the spawning frame when the type's pool is empty | `src/enemies/parts/Pool.ts:184-211`, `Enemy.ts:507-519`, `models/BugModel.ts:375-473` (clones `:378-380`) | host + replica (`net/Replica.ts:311` takes the same path) | bodies spawned per frame with a cold pool |
| A2 | Shared geometry of a type is baked lazily on its first appearance (10–25 primitive geometries merged, per-vertex colour loops); only the sandworm pre-warms | `BugModel.ts:77-133, 219-241`; `RogueModel.ts:85-142`; `FactionLooks.ts`; `EggModel.ts:166-173`; sandworm exception `sandworm/Director.ts:259-271` | host + replica | first hunter / toxic / behemoth / raider / named of the raid |
| A3 | Placement search raycasts once **per living player** per candidate (`isVisibleToAnyPlayer`), over the whole nest list + 6 candidates + fallback; big types retry `ENEMY_SPAWN_RETRIES` (12) times each with `obstacleCoverage`; artillery repeats the whole search up to 13 times | `src/enemies/Spawner.ts:236-253, 273-324, 351-364, 532-540` | host | players (androids count) × candidates × retries |
| A4 | `ensureCapacity` rescans all active enemies once per recycled corpse (do/while) and `despawn` uses `indexOf` | `Pool.ts:115-143, 219` | host | O(n²) when the cap is full |
| A5 | `burrow_emerge` synthesises ~15 sources per bug, each BufferSource + BiquadFilter + Gain (~45 nodes), plus a `setTimeout` teardown per voice; capped at 4 voices by `BURROW_EMERGE_VOICE_CAP` | `src/audio/Synth.ts:1678-1690, 79-96`, `AudioSystem.ts:1076-1104`, `enemies/parts/Burrow.ts:53-58` | host + replica | up to 4 × ~45 nodes in one frame |
| A6 | One `ee spawn` JSON send per body; the next 10 Hz snapshot carries every new id with all fields | `Pool.ts:154-158`, `net/HostSync.ts:158-171` | host | bodies per frame |
| A7 | No shader compile on spawn (cloned materials share the program key) — **not a cause**, except first-draw material init (parameters, uniform clone, attribute bind) per clone | `core/ShaderWarmup.ts:129-157` compiles pooled invisible rigs too | — | — |

**B. Sustained per-body cost**

| # | Finding | Where | Who pays | Scales with |
|---|---|---|---|---|
| B1 | Draw calls: bug = 17–18 meshes (+1 shadow draw, body only); soldier body = 43 meshes × (main + shadow + silhouette) ≈ 130 draw calls; no batching, instancing or LOD anywhere | `BugModel.ts:387-471`; `src/player/SoldierModel.ts:450-470` (`castShadow`/`receiveShadow` on every mesh `:452`, silhouette clones `:459-470`); `AllyAvatars.ts:191`, `RemoteAvatar.ts:285` silhouette on by default | everyone | 60 bugs ≈ 1 000+ calls; each soldier +130 |
| B2 | Android combat AI per ally **per frame**: `queryNear` allocates a new array twice, `pickCoverSpot` runs every frame while not in contact (allocating `getObstaclesNear` + up to 3 rays per improving candidate), LOS ray per improving sense candidate | `src/allies/parts/Combat.ts:58-69, 106-116, 155-161, 190-197`; `EnemySystem.ts:648-673`; `shared/cover.ts:125-167`; `world/WorldSystem.ts:1019-1021` | host | androids × frame |
| B3 | `LightBudget.update` walks the whole visible scene every frame to count point lights | `src/core/LightBudget.ts:7, 55, 75` ← `ShaderWarmup.beforeRender` ← `Engine.ts:253` | everyone | scene nodes (60 bugs ≈ +2 400) |
| B4 | Enemy AI has no distance LOD or time slicing; per bug per frame 2× `getSurfaceY`, `resolveCollision`, slope (`getNormalAt` = 4× `getHeightAt`), full animation; `pickTarget` scans all active enemies every 0.5–0.9 s per enemy (amortised O(n²)); shot/noise alerts scan all enemies per bullet | `EnemySystem.ts:451-528` (AI loop `:474`), `ai/EnemyAI.ts:614-662`, `parts/Alerts.ts:80-159, 273-295`, `world/WorldSystem.ts:766-773` | host (replica does interp + surface + slope per body) | n, n², bullets × n |
| B5 | Bug footsteps: every type steps, min gap 0.12 s, and each emit does `camera.getWorldPosition` + a scan of all active enemies (`bugStepCrowd`) **before** the range gate; surviving voices build a Gain + Panner + source graph each (cap 6) | `src/enemies/model.ts:311-341` (`ENEMY_STEP_MIN_GAP :298`), `AudioSystem.ts:1076-1104` | host + replica | steps/s × n |
| B6 | Recurring garbage: `queryNear` / `getObstaclesNear` arrays, one object + tuple per moving enemy per 10 Hz delta (~1 200/s at 60), 5.4 kB keyframe JSON every `NET_ENEMY_KEYFRAME_S` (2 s), `Array.from(set)` per inbound relay message, nameplate key strings | `HostSync.ts:140-197`, `net/parts/Messages.ts:401`, `ui/hud/Nameplates.ts:117-152` | host / everyone | periodic GC pauses |

**C. Multiplayer / squadmate-specific**

| # | Finding | Where | Who pays |
|---|---|---|---|
| C1 | `SoldierPool.acquire` builds `new SoldierModel` (86 meshes) inside the frame loop when nothing is parked; nothing pre-fills it at load | `src/player/SoldierPool.ts:31`, `AllyAvatars.ts:333-354`, `RemotePlayerSystem.ts:433-444` | everyone |
| C2 | Corpses build a fresh `SoldierModel` per death + 6 settle updates | `src/game/Corpses.ts:60, 110, 121` | everyone |
| C3 | `ally state` at `ALLY_NET_INTERVAL_S` (0.1 s) allocates per body; `allyq sync` re-encodes everything + one bag message per ally | `src/allies/parts/Sync.ts:51-90, 220-224` | host |
| C4 | `snapshotFace` creates a second GL context, builds a soldier, renders and does a synchronous `toDataURL`; context disposed after 4 s idle so the next tile pays again. **Ship-only** (matching tab, resume card) — not a raid hitch | `src/player/FaceSnapshot.ts:101-176` | ship only |

---

## Phases (re-rank after Phase 0)

Each phase names its owning folder(s), the approach, the rules that constrain it, and how it is verified. Expected gain is
the analysis' guess — replace with the measured delta.

### Phase 1 — pre-warm pools and geometry (A1, A2, C1) · `enemies`, `player`
- At `world:ready` (authority and replica alike), after `initialPopulate`: bake `getAssets` for every type the planet's
  ecosystem / threat can produce (`threatEcosystem`, site faction tables, `RAIDER_DROP_*`, named types) and park N bodies
  per type in `sys.pools` (N from a new `data/constants.csv` row, e.g. `ENEMY_POOL_PREWARM_<class>`; **no numbers in code**).
  Parked rigs stay `visible=false` in the scene, so the existing `holdForScene` compile covers them (A7).
- `SoldierPool`: park `NET_MAX_PLAYERS − 1` bodies (or the lobby's member count) during the raid load hold; corpses (C2) take
  a body from the same pool and return it when the corpse is removed.
- Risk: memory + scene node count rises even when unused; the load hold gets a little longer (measure with
  `LoadGate` progress). Rig construction must stay off the `world:ready` frame if it is not under the hold (training / tutorial
  never wait — check `LoadGate` rules).
- Verify: `smoke-burrow`, `smoke-enemy-delta`, `smoke-ally-avatars`, `smoke-lights` (light count unchanged), S3 delta.

### Phase 2 — cut draw calls (B1) · `enemies/models`, `player`
Needs the user's answers (see Decisions). Options in order of gain:
1. Bug: one shared `chitin` material per type instead of a clone per rig (status flash / emissive then needs a per-instance
   path — vertex colour attribute or an `InstancedMesh` colour — because `statusEmissive` writes the material today).
2. Bug legs: `InstancedMesh` per type for femur + tibia (12 of the 17 meshes), instance matrices written by `animateBug`.
3. Soldier: `castShadow` only on torso / head / legs (not 43 parts); silhouette clones only for the parts that matter, or one
   merged silhouette geometry per body.
4. Distance LOD for animation (B4 too): beyond a csv distance skip `animateRig` every other frame; beyond another, freeze.
- Rules: `core/LightBudget` untouched; `Layers.ENEMY` on every new mesh (raycast); `Xray` overlays are children of the pooled
  rigs (`fx/Xray.ts`) — check they survive instancing; hit capsules do not depend on meshes.
- Verify: `smoke-enemy-alert`, `smoke-blast-occlusion`, `smoke-ally-avatars`, `shots-factions.mjs` for the look, S2/S4 draw calls.

### Phase 3 — throttle android AI (B2, C3) · `allies`
- `Combat.findTarget`: keep the target by id (`ctx.enemies` lookup) instead of `queryNear` per frame; `sense()` at most every
  `ALLY_SENSE_INTERVAL_S` (new csv row) with a reused buffer (`queryNear` gets an optional `out` array — add-only change in
  `src/shared/types.ts`).
- `pickCoverSpot` at most every `ALLY_COVER_REFRESH_S` (csv) or when the target / threat moved more than a threshold;
  `Nav.ts` already does 0.35 s for obstacles (`OBS_REFRESH_S :25`) — same pattern.
- `Sync.ts`: reuse the wire objects across ticks.
- Verify: `smoke-allies-core`, `smoke-allies-orders`, `smoke-enemy-allies` (uses `pickCoverSpot`), S4 script time.

### Phase 4 — spawn tick cost (A3, A4, A5, A6) · `enemies`, `audio`
- `isVisibleToAnyPlayer`: test the nearest player first and stop at the first hit (it already returns early on a hit; the cost
  is the misses) — cheaper: a cone test before the ray already exists, add a distance cap from csv; consider sharing one
  candidate list across the group instead of per member.
- `ensureCapacity`: collect dead bodies once, sort by `deathTimer`, despawn the oldest k; `active` swap-remove by index
  (already) but find via `byId` position map instead of `indexOf`.
- Spread a group's spawns over consecutive frames (one body per frame, `BURROW_EMERGE_S` hides it) — **only if** S3 shows the
  spike is rig/audio bound rather than search bound.
- Audio: pool `GainNode`/`PannerNode` pairs or reduce `burrow_emerge` source count when `emergeBatchN > 1` (the 1/√k gain
  already exists in `parts/Burrow.emergeSound`).
- Verify: `smoke-burrow`, `smoke-faction-sites`, `smoke-named`, S3 spawn-frame time.

### Phase 5 — per-frame scans (B3, B5, B4 partial) · `core`, `enemies`, `audio`
- `LightBudget`: count on add/remove (`scene.add` hooks are not available — instead cache the count and recount only when
  a `light:changed`-style flag is set by the light pool owners `hub/interiors/LightPool`, `world/structures`, `extraction`) or
  recount at a csv interval instead of every frame. The invariant "the shader always sees `SCENE_POINT_LIGHT_BUDGET`" must
  hold on the frame a light appears — read `core/LightBudget.ts` header before changing.
- Footsteps: move the range gate before `getWorldPosition` and `bugStepCrowd`; cache the camera position once per frame in
  `EnemySystem.update`.
- `pickTarget` / alert scans through `host.grid.query` with the sight radius instead of `sys.active`.
- Verify: `smoke-lights` (**must stay green — it enforces the light count**), `smoke-enemy-alert`, S2 script time.

### Phase 6 — garbage (B6) · `enemies/net`, `net`
Only if the trace shows GC pauses in the stutter frames. Reuse delta objects in `HostSync`, iterate the handler set
directly in `Messages.ts:401`, key nameplates by rounded integers instead of `toFixed` strings.

---

## Decisions needed (ask the user at the start of Phase 2)

1. **Soldier shadows:** shadow from every armour plate (today) vs. from body, head and limbs only. Visible difference: small
   plates lose their own shadow.
2. **Silhouette (occlusion outline) for allies / remotes:** keep on every part, or only the torso / head; or off beyond a
   distance.
3. **Enemy animation LOD distances:** at what distance may legs stop animating (they are ~10 cm at 60 m)? Proposal: half rate
   beyond 40 m, frozen beyond 80 m, both csv.
4. **Burrow sound density:** keep one voice per bug (cap 4), or one rich voice + cheaper layers for the rest of the group.
5. **Spread group spawns over frames** (1 body/frame) — changes nothing visible during `BURROW_EMERGE_S` but the `ee spawn`
   burst becomes a trickle; acceptable for the replica's view?

Record the answers in `docs/DECISIONS.md` under a 2026-09-xx heading, in Korean titles as the file does.

---

## What this plan does not cover
- The ship (hub) frame rate and `snapshotFace` (C4) — separate scene, separate light pool; only if the user reports it.
- `verify:all` run time (`docs/TODO.md` E-12) — related (page frame cost) but a different goal.
- WebGPU / worker offloading — out of scope until the cheap fixes above are measured.
