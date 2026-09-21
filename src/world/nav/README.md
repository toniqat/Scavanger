# world/nav/ — The raid's walkable graph (`WorldRef.nav`, TODO A-18)

Sub-folder of `world/`. No system of its own: `WorldSystem` owns one `NavGraph`, starts it at the end of a planet raid's
generation (`WorldSystem.startNav`), ticks it every frame and publishes it as `WorldRef.nav` (null in the training
range, the tutorial and before the first raid). The contract is `src/shared/nav.ts`.

## Files

| File | Responsibility |
|---|---|
| `NavGraph.ts` | The class behind `NavRef`: outdoor arrays (`oh` · `of`), regions, explicit links, the special-link table (`specials`), window flags, gates + gate loads, the flow state, the re-measure queue, the search scratch; `start` · `clear` · `update` · `onHashChange` · `findPath` · `walkable` · `flowTo` · `createFlowStep` · `setGateLoad` · `windowWhole` · `breakWindow` · `noteWindowBroken` · `debugInfo` · `debugGateAt` · `debugWalkableAt` · `debugSpecials`. |
| `model.ts` | Vocabulary, no state: node flags (`F_WALK` · `F_TERRAIN` · `F_OWNED` · `F_RAMP`), link kinds (`L_*`, `LINK_KINDS`), `NavLink`, `SpecialLink`, `RegionSpec` · `Region`, `NavWindow` · `NavBuilding`, `NavWorld` (what the graph asks the world), `regionToWorld` · `worldToRegion`. |
| `parts/Bake.ts` | The bake as a generator spread over frames (`NAV_BAKE_BUDGET_MS`): regions + owned outdoor cells → near-a-collider mask → outdoor rows → region columns (candidate floors from box / ramp / hull tops) → region seams → `Links` → `Gates` → search arrays. `probeOutdoor` · `probeRegionNode` · `fits` are shared with the re-measure. |
| `parts/Graph.ts` | Reading the graph: `linkOk` (the link rules), `nodePos` · `nodeH` · `nodeF` · `regionOf` · `regionOfHint`, `neighbours` (8-way on the fly + explicit links, filtered by the `NAV_CAN` mask; a whole pane's cost is added here), `snap`, `walkLine`, debug `gateAt` · `walkableAt`. |
| `parts/Search.ts` | A\* with generation stamps and a node budget (`NAV_SEARCH_MAX_NODES` → `partial`), path reconstruction (a special link's waypoint carries its `via` · `windowId` · `ladderId`), smoothing that never skips a special link. |
| `parts/Links.ts` | The special links and their table: ladders, wall climbs every `NAV_CLIMB_SPACING_M` along a roofed building's four walls, one window link per pane. Both ends snap to walkable region nodes **on the asked side of the wall**; a missing end drops the link. |
| `parts/Gates.ts` | The chokepoints (`NavRef.gates`): narrow (`NAV_GATE_MAX_SPAN_M`) connected patches inside a structure's footprint that are passages (wider floor on two sides), tagged per region node (`Region.gate`). |
| `parts/Flow.ts` | Flow fields (`flowTo` · `NavFlow.sample`): a pool of `NAV_FLOW_MAX_FIELDS`, one time-sliced Dijkstra from the goal at a time (`NAV_FLOW_BUDGET_MS`), double-buffered with one shared spare, windowed storage, gate tolls, and the per-body sample (locate → look-ahead aim → special link · gate ahead). |
| `parts/Remeasure.ts` | `mark` (from `SpatialHash.onChange`) queues the outdoor cells and region columns under a changed collider once each; `run` re-measures them at `NAV_REMEASURE_HZ` within `NAV_REMEASURE_BUDGET_MS` and bumps `revision`. |

## Shape

- **Outdoors**: a world-aligned `NAV_CELL_M` grid over the whole map, one node per cell (id = `j * W + i`).
- **Regions**: one per structure (its `StructureNav` rectangle) and per rail platform, grown by `NAV_STRUCT_MARGIN_M`,
  on a `NAV_STRUCT_CELL_M` grid aligned to the building's own axes, with one node per standable floor in each column.
  Outdoor cells inside a region (less `OWN_INSET`) are marked `F_OWNED` and never used; the band where both exist is
  joined by explicit seam links.
- **Special links** (`NavGraph.specials`, two rows per link — one each way, sharing one `via`): a body *performs* them
  (`from → via → to`, colliders ignored) instead of walking.
  - **Ladder** (`NAV_CAN.LADDER`): the floor at the foot ↔ the floor at the exit, cost `height × NAV_LADDER_COST_MUL`.
  - **Climb** (`NAV_CAN.CLIMB`): the ground just outside a roofed building's wall ↔ the roof just inside the parapet, cost
    `horizontal + height × NAV_CLIMB_COST_MUL`. `via` = the ground end pulled onto the wall's outer face (`CLIMB_STANDOFF_M`
    off it), `CLIMB_TOP_CLEAR_M` over the parapet's top — **the same point both ways**. Up: `from` (ground) → straight up
    the face to `via` → over onto `to` (roof). Down: `from` (roof) → up over the parapet to `via` → straight down to `to`
    (ground). The parapet stands `PARAPET_H` (1 m) above the roof floor, so a descent that crosses at roof height —
    e.g. through `(to.x, from.y, to.z)` — passes through it; use `via` in both directions. No spot in front of the door,
    the breach or a window of any floor. A wreck is open-topped and gets none.
  - **Window** (`NAV_CAN.WINDOW`): the floor inside ↔ the **ground** outside (an upper-floor window is a wall climb to its
    sill), cost `NAV_WINDOW_COST_M + horizontal + climbed height × NAV_CLIMB_COST_MUL`, plus `NAV_WINDOW_WHOLE_COST_M`
    while the pane is whole — added when the link is **read** (`Graph.neighbours`, `windowWholeFlag`), never baked.
- **Gates**: region nodes only, fixed at bake time. `gateLoad[id]` (from `setGateLoad`) is a toll of
  `load × NAV_GATE_LOAD_COST_M` a field build charges for *entering* that gate.
- **Flow fields**: a buffer = a `(2·⌈R/cell⌉+1)²` window of outdoor cells around the goal + a block per region whose circle
  meets the disc; per slot `next` node · the `specials` row of that hop (-1 = walk) · metres left. About 250 KiB a buffer,
  `fields + 1` buffers alive at most.

## Rules

- **The graph asks the world what a mover asks.** A floor is `getSurfaceY`, "a body fits here" is `resolveCollision`
  not pushing a `PLAYER_RADIUS` probe (`Bake.fits`). No private collision math — if movement changes, the graph follows.
  A smaller body fits wherever this one does.
- **Link rules live in `parts/Graph.linkOk` only**: terrain ↔ terrain by slope (`NAV_MAX_SLOPE_DEG`), anything else by
  `PROP_STEP_UP_MAX`, and **any link that touches a ramp top by `RAMP_STEP_M`** — a body stepping onto a stair flight's
  side at an angle meets the higher edge first (seed 2026 stuck a walker there at 0.87 m). Diagonals need both orthogonal
  cells.
- **Why regions are their own grid**: a doorway is 2.6 m, a stair 1.7 m, a locked door 1.8 m; minus the body that
  leaves 0.8 m for a stair, and a 1 m world grid on a rotated building cuts it.
- **Nothing a changed collider covers is trusted until re-measured.** Every insert · remove · real move in the hash
  reaches `Remeasure.mark` (`SpatialHash.onChange`; a parked tram moved to where it already is does not count). Region
  nodes keep their floor and only re-check the fit — building floors never move; outdoor cells are measured from
  scratch, so a deck that drove in is a floor.
- **Cylinders are never a floor candidate** in a region — a pole or a trunk top is nothing a body stands on.
- **Every client bakes, only the authority queries.** Same seed, same graph, so host migration finds it ready; no wire.
- **A climb or a window needs `NAV_CAN.INDOOR` too**: both ends are region nodes (the margin owns the cells beside a wall),
  and a body without `INDOOR` never enters a region.
- **Every pane that breaks reaches the graph** — bullet, throwable, bug, the wire, a late joiner's sync all end in
  `Structures.onGlassBroken` → `noteWindowBroken`, which clears the flag (the link is cheaper at once) and bumps `revision`
  (fields rebuild). `breakWindow` goes through `Structures.breakGlass(…, byLocal = true)`, the path a local bullet takes.
- **A gate is a passage, not just a narrow place**: inside the structure's footprint, a span of `NAV_GATE_MAX_SPAN_M` or
  less along the region's U or V axis (a run that reaches the grid's edge is open), at least `NAV_GATE_MIN_CELLS` cells,
  and wider floor linked to it on two sides. `F_TERRAIN` cannot be used to tell inside from outside — a ground floor's plate
  top *is* the flattened terrain height. Rail platforms get none (`RegionSpec.gates`).
- **One field build at a time, with its own heap and closed set** — a `findPath` between two slices cannot disturb it, and
  the neighbour scratch is never held across a slice. The goal is snapped once per build (`Graph.snap`); `sample` never
  snaps: it reads the column · cell under the body and, with no entry there, the **nearest** neighbour cell with one
  (by cell centre, so a thin wall cannot leak the body to the room behind it).
- **`sample`'s aim cuts a corner only where `walkLine` allows it**; otherwise it falls back hop by hop to the next node.
  A special link is answered only within `NAV_LINK_START_M` of its start node and on that node's floor; farther away the
  aim is that start node and the kind is `walk`. The gate scan stops at a special link.
- **Never hand the graph to something that serializes it.** A `FlowField` holds its graph (`FlowField.graph`), so once a
  field exists the graph is a cycle; a smoke predicate that *returns* `WorldRef.nav` from `page.evaluate` makes the
  inspector serialize it by value down to its depth limit, re-walking the 640 × 640 arrays every lap — minutes of a
  blocked page (the 2026-09-21 「second-mission hang」 in `smoke-nav`). Return `!!nav` or a plain field.
- `walkLine` with a start on no walkable node looks for one within `START_R`; with none at all it answers true (no
  opinion — the mover steers as before). `snap` copies its candidates before validating them, because `walkLine` may
  call `gather` again.

## Known limits

- Two regions whose rectangles overlap get no seam between each other — layout keeps structures apart, so none do today.
- A region node's floor is fixed at bake time: a barricade dropped indoors blocks cells but never becomes a floor.
- Gates are fixed at bake time: the cells a locked door frees when it opens are walkable but belong to no gate.
- A field is as old as its last build: up to `NAV_FLOW_MAX_FIELDS` fields share `NAV_FLOW_BUDGET_MS` a frame, one build
  at a time (~10 ms cpu each, so ~7 frames), oldest first — with all eight live a goal is re-aimed about once a second.
- A field's distances include gate tolls, so `NavFlowStep.dist` is metres **plus** tolls when a loaded gate is on the way
  (`gateDist` is geometric).
- Climb spots are not checked against props above the ground end — a climb may pass through a roof-edge prop (the body
  ignores colliders while performing it).
- **Window and climb mouths carry no load.** Only gates (region nodes, tagged at bake time) take `setGateLoad`; a crowd
  held at one window (`linkBusy` on the enemies side) never makes the next field prefer another window or the door.
  Closing it needs both sides: the graph would publish one `NavGate` per link mouth, report it as `NavFlowStep.gate` on
  a link step and charge its load on the link's edge in `Flow.step`; the movers would count the bodies they hold at a
  link mouth (`navWaitGate`). Not built: the world half alone is inert, and a half built for later is not kept (root `CLAUDE.md` §4.1).
- An unreachable goal inside the big outdoor component costs the whole search budget and answers `partial` (the path
  to the nearest node found), not `none`; `none` is only proven for a closed island around the start.

## Recent changes

Last 5 only — older: `git log -- src/world/nav`.
- 2026-09-21 — `Flow.reset` also drops the region hint (`lastRegion`) of the cleared graph; the climb's descending `via`
  documented; the special-link load limit recorded. (The `smoke-nav` second-seed hang was the harness serializing the
  graph — see Rules.)
- 2026-09-21 — A-18 phase 2: special-link table (`parts/Links` — ladder · climb · window, `via` · `windowId` on waypoints),
  gates (`parts/Gates`, `setGateLoad`), flow fields (`parts/Flow`, `flowTo` · `sample`), `windowWhole` · `breakWindow` and
  the glass → `revision` feed; `NavWorld` grew `windows` · `buildings` · the two window callbacks.
- 2026-09-21 — Created (TODO A-18 phase 1): outdoor grid + per-structure / platform region grids, ladder and seam links,
  time-sliced bake, re-measure from `SpatialHash.onChange`, A\* with a node budget and smoothing, `walkable` with the
  goal's floor check.
