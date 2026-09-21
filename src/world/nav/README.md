# world/nav/ — The raid's walkable graph (`WorldRef.nav`, TODO A-18)

Sub-folder of `world/`. No system of its own: `WorldSystem` owns one `NavGraph`, starts it at the end of a planet raid's
generation (`WorldSystem.startNav`), ticks it every frame and publishes it as `WorldRef.nav` (null in the training
range, the tutorial and before the first raid). The contract is `src/shared/nav.ts`.

## Files

| File | Responsibility |
|---|---|
| `NavGraph.ts` | The class behind `NavRef`: outdoor arrays (`oh` · `of`), regions, explicit links, the re-measure queue, the search scratch; `start` · `clear` · `update` · `onHashChange` · `findPath` · `walkable` · `debugInfo`. |
| `model.ts` | Vocabulary, no state: node flags (`F_WALK` · `F_TERRAIN` · `F_OWNED` · `F_RAMP`), link kinds (`L_*`, `LINK_KINDS`), `NavLink`, `RegionSpec` · `Region`, `NavWorld` (what the graph asks the world), `regionToWorld` · `worldToRegion`. |
| `parts/Bake.ts` | The bake as a generator spread over frames (`NAV_BAKE_BUDGET_MS`): regions + owned outdoor cells → near-a-collider mask → outdoor rows → region columns (candidate floors from box / ramp / hull tops) → region seams and ladder links → search arrays. `probeOutdoor` · `probeRegionNode` · `fits` are shared with the re-measure. |
| `parts/Graph.ts` | Reading the graph: `linkOk` (the link rules), `nodePos` · `nodeH` · `nodeF` · `regionOf`, `neighbours` (8-way on the fly + explicit links, filtered by the `NAV_CAN` mask), `snap`, `walkLine`. |
| `parts/Search.ts` | A\* with generation stamps and a node budget (`NAV_SEARCH_MAX_NODES` → `partial`), path reconstruction, smoothing that never skips a special link. |
| `parts/Remeasure.ts` | `mark` (from `SpatialHash.onChange`) queues the outdoor cells and region columns under a changed collider once each; `run` re-measures them at `NAV_REMEASURE_HZ` within `NAV_REMEASURE_BUDGET_MS` and bumps `revision`. |

## Shape

- **Outdoors**: a world-aligned `NAV_CELL_M` grid over the whole map, one node per cell (id = `j * W + i`).
- **Regions**: one per structure (its `StructureNav` rectangle) and per rail platform, grown by `NAV_STRUCT_MARGIN_M`,
  on a `NAV_STRUCT_CELL_M` grid aligned to the building's own axes, with one node per standable floor in each column.
  Outdoor cells inside a region (less `OWN_INSET`) are marked `F_OWNED` and never used; the band where both exist is
  joined by explicit seam links.
- **Ladders**: one link each way between the walkable node at the ladder's foot and the one at its exit (`NAV_CAN.LADDER`,
  cost `height × NAV_LADDER_COST_MUL`).

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
- `walkLine` with a start on no walkable node looks for one within `START_R`; with none at all it answers true (no
  opinion — the mover steers as before). `snap` copies its candidates before validating them, because `walkLine` may
  call `gather` again.

## Known limits

- Two regions whose rectangles overlap get no seam between each other — layout keeps structures apart, so none do today.
- A region node's floor is fixed at bake time: a barricade dropped indoors blocks cells but never becomes a floor.
- `L_CLIMB` · `L_WINDOW` exist in the vocabulary but no link of either kind is built yet (A-18 phase 2 — small bugs).
- An unreachable goal inside the big outdoor component costs the whole search budget and answers `partial` (the path
  to the nearest node found), not `none`; `none` is only proven for a closed island around the start.

## Recent changes

Last 5 only — older: `git log -- src/world/nav`.
- 2026-09-21 — Created (TODO A-18 phase 1): outdoor grid + per-structure / platform region grids, ladder and seam links,
  time-sliced bake, re-measure from `SpatialHash.onChange`, A\* with a node budget and smoothing, `walkable` with the
  goal's floor check.
