# SCAVANGER — Performance record

What the perf phases (2026-09-19 … 20, Phase 0 · 1 · 2 · A · A2 · B · C · D and the last measurement) settled. Every phase is
built or struck and **there is no next one**; new perf work goes to [TODO.md](TODO.md). Only a **measurement** may be added here.
Harness: `node scripts/perf-measure.mjs` (method in [scripts/README.md](../scripts/README.md)). How each fix was found is in `git log`.

## What the machine taught

1. **`ms` is not evidence.** The same committed build measured `x:rendererRender` **6.842 and 5.112 ms** back to back (js/frame p50
   9.6 vs 7.6); two runs of one build gave 5 and 22 frames over 33 ms. The ±1.7 ms spread is larger than every change ever credited.
   **Judge by counters that repeat** — draw calls, scene nodes, triangles, casters, bytes, call counts. Take a fresh `before`, run
   **twice per side**.
2. **Count it, don't time it.** Three times the named suspect was not the owner, and a counter found the real one: forced layouts
   counted inside `Engine.frame` (7 in 637 frames, all `hud/ChatLog`, not `allies`); a census bounding the AI LOD before building it;
   byte counts striking all three multiplayer suspects. **Never write a fix against a mark name.**
3. **The render block is moved by triangles — not draw calls, not pixels.** −31 % draw calls / −36 % scene nodes (1 890 → 1 300,
   5 940 → 3 800) left `x:rendererRender` at 7.34 → 7.23. A −44 % resolution cut (1280×720 → 960×540) came out 0.12 ms *higher*:
   S2 is not fill-limited on an RTX 4080 SUPER at vsync. What reproduced: the **shadow pass ≈ 1.07 ms** (triangles + a second camera).
4. **A squadmate costs one more body drawn.** Two humans through the relay, with and without two androids: 16.7 / 16.8 ms, zero frames
   over 33 ms on both clients (S5a · S5c). A remote body = 73 visible + 32 shadow draws; the wire is 23–29 KB/s and 0.08 ms a frame
   outside the frame. Not the network, not the simulation.
5. **Spike frames have no owner.** Of 14 spikes, 13 led by `x:rendererRender`, one by `u:enemies` with no spawn on it — whatever mark
   runs when the machine stalls (GC at 63 MB/s with no owner, or the driver). Garbage by owner: `x:rendererRender` 15 MB/s (three.js),
   `u:world` 7.9, `u:enemies` 6.5, `l:hud` 4.2, `x:audioPlay` 2.8. The V8 sampling profiler and construct traps both undercount; only
   `performance.memory` around each mark sees it.

## Built, and what was rejected

- **Measurement**: headful Chrome on the real GPU, `--mute-audio`, `update` wrapped on the live page. Rejected: the headless smoke
  setup (no swap chain — its cadence means nothing); lowering in-game volume (removes the audio graphs). Two clients: host headful,
  peer headless d3d11. Rejected: both headful (shared vsync); a swiftshader peer (under-measures replica cost). One harness,
  `--only s5*`. Rejected: a separate `perf-measure-mp.mjs`.
- **Body shadows / silhouette** — see `src/player/README.md` · `src/enemies/README.md` Decisions. Bug spheres budgeted by
  `BUG_MESH_SEGMENTS` for every type. Rejected: only the small types.
- **Enemy animation LOD** (`ENEMY_ANIM_LOD_*`, scaled by `viewZoomK`; hit / burning / dead bodies always animate). Rejected: 25 / 50 m;
  leaving it unscaled under a scope.
- **Enemy AI LOD** by distance to the nearest anchor, `dt` carried in `aiDebt`, a tick capped at `ENEMY_AI_LOD_MAX_STEP_S`, near band
  wider than artillery's 98 m reach, named sniper exempt. Rejected: time slicing (reduces near bodies, untraceable lag); both together;
  freezing the far band.
- **World shadows** — props split near / far at `PROP_SHADOW_DIST_M`, small objects never cast, pebbles lowered; both halves sized to
  the instance count and `DynamicDrawUsage`. Triangles 930k → 730k, prop casters 754 → 51.
- **No layout read in a frame**, enforced by `smoke-layout-reads` (bar 0). The `remove → void offsetWidth → add` restart idiom is
  accepted (ratchet `KNOWN_IDIOM`): a rewind helper cannot work (a finished unfilled animation leaves `getAnimations()`, and the
  animation often sits on a descendant), and a style flush is not cheaper than a layout flush here.
- **Bloom** stays on by default; it measured free on vsync.

## Measurements after the phases

- **Enemy pathfinding (TODO A-18 phase 2, 2026-09-21) — S6 against S2.** `--only s2,s6`, headful, seed 7001, two runs a side,
  with another agent's swiftshader jobs on the machine (so read the counters, not the `ms`). S6 is S2's 60-bug ring spawned
  **already chasing** a player standing inside a building. Counters: 21 bodies in flow mode at once, 38–42 on private paths,
  6–7 waiting at gates, 9 on a special link; gate tokens never above `NAV_GATE_CAPACITY` (2); private plans 31–34/s (cap 60/s);
  15–16 flow builds in the window, 5.5–5.7 ms CPU each spread over 4 frames (worst `x:navUpdate` frame 1.6 ms). `u:enemies`
  reads 0.9–1.05 (S2) vs 1.75–1.79 ms (S6), but **that gap is the scene, not the pathfinding**: toggling the enemies' graph off in
  the same S6 scene measured `EnemySystem.update` 0.76 / 0.77 ms on vs 0.62 / 1.00 ms off — nav's net cost is ≤ ~0.14 ms a frame,
  inside the ±1.7 ms spread. Frame p50 16.7 ms on every run. No change was made from it.

## Open — needs different hardware, not work

The flat DOM cut (`hud/ShipManage`'s hidden boxes + four faded `.menu` screens, ~120 of 1 085 laid-out boxes) and the AI LOD's near band
need a **weaker** machine to show anything; a replica's own frame time needs a **second** machine; terrain's 346k visible triangles
(37 % of the scene) stay because collision, `getSurfaceY` and the silhouette hang off that mesh.
