# src/game — Mission flow (`GameFlowSystem`)

Phase state machine, pause, difficulty ramp and mission result. Publishes `ctx.phase` via `ctx.setPhase()`
(which emits `game:phaseChanged`). Registered last in `main.ts`.

Import via `@/game` → `GameFlowSystem`.

| File | Purpose |
|---|---|
| `GameFlowSystem.ts` | `GameSystem` (`name: 'gameflow'`). Phases: `menu → deploying → playing → extracting → shipLanded → liftoff → complete` or `dead`. |
| `index.ts` | Barrel. |

## Transitions
| Trigger | Action |
|---|---|
| `init()` | re-emits `game:phaseChanged {menu}` so menus show |
| `game:newMission {seed}` | `ctx.stats = freshStats(seed)`, `missionTime = 0`, then `deploying` once `world:ready` has fired (WorldSystem generates synchronously *inside* the same emit, so the handler also checks `ctx.world.ready && seed` directly) |
| `player:landed` (in `deploying`) | `playing` |
| `extraction:activated` | `extracting` |
| `extraction:shipLanded` | `shipLanded` |
| `extraction:liftoff` | `liftoff`; after 6.5 s → `stats.extracted = true`, `lootValue = inventory.getTotalValue()`, `complete`, `game:complete {stats}` |
| `player:died` | after 2.5 s → `dead`, `game:over {stats}` |
| `game:abort` | closes inventory, `menu` |
| Escape (gameplay phase, no `ctx.uiBlockers`) | toggles `game:paused {paused}`; Engine zeroes `dt` while paused; `PauseMenu` may emit `game:paused false`. Inventory / map consume Escape in a capture-phase listener, so it never reaches here while they are open |
| `pointerlockchange` (lock lost) / `window` `blur` | if gameplay phase, no blocker, player alive, not paused and > 300 ms since `ctx.input.lastLockRequest` (a denied request) → emits `input:pointerLockLost` and pauses. Intended exits (inventory, map, menus, pause) add their blocker / set `paused` **before** `exitPointerLock()`, so they do not trigger this |
| unpause (Esc or 계속) | after emitting `game:paused false`, re-requests pointer lock in a microtask when still in a gameplay phase with no blockers (a following synchronous abort → `menu` cancels it) |

## Notes
- `missionTime` / `stats.timeSeconds` advance in `Engine.frame()`; `kills`, `cratesOpened`, `damageTaken` are
  incremented by Enemy / World / Player systems. GameFlow only resets and finalizes stats.
- Difficulty: `ctx.enemies.setThreatLevel()` ramps 0.3 → 0.7 over the first 8 minutes of mission time.
