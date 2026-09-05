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
| `extraction:boarded` | remembers that the local player boarded (for `stats.extracted` in multiplayer) |
| `extraction:liftoff` | `liftoff`; after 6.5 s → `complete()`: `stats.extracted = true` (multiplayer: `boarded && !isDead`), `lootValue = inventory.getTotalValue()`, `complete`, `game:complete {stats}` |
| `player:died` | single-player: after 2.5 s → `dead`, `game:over {stats}`. Multiplayer: phase unchanged, `ui:notify "전사 — 팀원이 임무를 계속합니다"`, host starts the all-dead check |
| `game:abort` | multiplayer host: `flow abort` to others first; closes inventory, `menu` |
| Escape (gameplay phase, no `ctx.uiBlockers`) | toggles `game:paused {paused, freeze: !ctx.isMultiplayer}`; Engine zeroes `dt` while paused (single-player only — in multiplayer the menu shows but the world and GameFlow timers keep running); `PauseMenu` may emit `game:paused false`. Inventory / map consume Escape in a capture-phase listener, so it never reaches here while they are open |
| `pointerlockchange` (lock lost) / `window` `blur` | if gameplay phase, no blocker, player alive, not paused and > 300 ms since `ctx.input.lastLockRequest` (a denied request) → emits `input:pointerLockLost` and pauses. Intended exits (inventory, map, menus, pause) add their blocker / set `paused` **before** `exitPointerLock()`, so they do not trigger this |
| unpause (Esc or 계속) | after emitting `game:paused false`, re-requests pointer lock in a microtask when still in a gameplay phase with no blockers (a following synchronous abort → `menu` cancels it) |

## Notes
- `missionTime` / `stats.timeSeconds` advance in `Engine.frame()`; `kills`, `cratesOpened`, `damageTaken` are
  incremented by Enemy / World / Player systems. GameFlow only resets and finalizes stats.
- Difficulty: `ctx.enemies.setThreatLevel()` ramps 0.3 → 0.7 over the first 8 minutes of mission time.

## Multiplayer (all gated on `ctx.isMultiplayer`; single-player is unchanged)
- Subscribes lazily to `ctx.net.onMessage('flow')` (`ensureNetHooks()` in `update` / `onNewMission`). Clients only:
  `over` → `gameOver()`, `complete` → `complete()`, `abort` → emits `game:abort`, `phase` → ignored. Messages not from `lobby.hostId` are dropped.
- **All-dead check (host only)**: local `ctx.player.isDead` && every remote ref with `connected && !stale` is `isDead`.
  Runs on `player:died`, `net:remoteDied`, `net:peerLeft`, and every 0.5 s while the local player is dead.
  When true → `flow over` to others + `gameOver()` locally.
- `complete()` on the host also sends `flow complete` so a client that missed `ex liftoff` still reaches the result screen;
  `complete()` / `gameOver()` are idempotent (no-op in `complete` / `dead` / `menu`).
- `net:lobbyLeft` with a reason other than `left` during gameplay → `ui:notify "연결이 끊어졌습니다"` then `game:abort` after 2 s.
- Host abort: `wasMultiplayerHost` is cached every frame because NetSystem (registered earlier) may have ended the session
  before this handler runs; the `flow abort` send is still attempted (no-op if `ctx.net.send` already refuses).
