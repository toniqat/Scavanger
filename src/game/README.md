# src/game — Mission flow (`GameFlowSystem`)

Phase state machine, pause, difficulty ramp and mission result. Publishes `ctx.phase` via `ctx.setPhase()`
(which emits `game:phaseChanged`). Registered last in `main.ts`.

Import via `@/game` → `GameFlowSystem`.

| File | Purpose |
|---|---|
| `GameFlowSystem.ts` | `GameSystem` (`name: 'gameflow'`). Phases: `menu → deploying → playing → extracting → shipLanded → liftoff → complete` or `dead`. The ship hub phases `hub` / `docking` are owned by `hub/HubSystem` (see below). |
| `index.ts` | Barrel. |

## Transitions
| Trigger | Action |
|---|---|
| `init()` | re-emits `game:phaseChanged {menu}` so menus show |
| `game:newMission {seed, mode?}` | `ctx.missionMode = mode ?? world.mode ?? 'raid'`, `ctx.stats = freshStats(seed)` (+ `stats.mode`), `missionTime = 0`, then `deploying` once `world:ready` has fired (WorldSystem generates synchronously *inside* the same emit, so the handler also checks `ctx.world.ready && seed` directly). Training: `trainingSnapshot = inventory.captureRaidState()` |
| `player:landed` (in `deploying`) | `playing` |
| `extraction:activated` | `extracting` |
| `extraction:shipLanded` | `shipLanded` |
| `extraction:boarded` | remembers that the local player boarded (for `stats.extracted` in multiplayer) |
| `extraction:liftoff` | `liftoff`; after 6.5 s → `complete()`: `stats.extracted = true` (multiplayer: `boarded && !isDead && !isDowned`), `lootValue = inventory.getTotalValue()`, `awardMissionXp()`, `complete`, `game:complete {stats}` |
| `player:died` | training: immediate `player:respawn` at the arena spawn (no failure). Solo raid: after 2.5 s → `gameOver()` (레이드 실패). Multiplayer: phase unchanged, 30 s respawn countdown (`game:respawnAvailable`), host runs the all-dead check |
| `player:downed` | **not a death**: phase unchanged, `ui:notify "쓰러짐 — 아군의 제세동기를 기다립니다"`, the all-dead check is re-armed (a squadmate may already be dead) |
| `player:revived` | stops the all-dead check when the local player is no longer dead |
| `game:abort` | multiplayer host **during a live raid** (gameplay / `deploying`, never a training): `flow abort` to others first (leaving a result screen is local — the mission is already over); closes inventory, `menu`. If the abort ended a *lobby* mission / result screen, emits `hub:enter {ship:'shared'}` one microtask later (no-op when HubSystem's own `hub:enter` already built the ship) |
| Escape (gameplay phase **or `hub`**, no `ctx.uiBlockers`) | toggles `game:paused {paused, freeze}`; `freeze = !ctx.isMultiplayer && phase !== 'hub'`, and Engine zeroes `dt` only while `freeze` (single-player mission) — in multiplayer *and in the ship* the menu shows while the world / ship keeps running; `PauseMenu` may emit `game:paused false`. Inventory / map / terminal consume Escape in a capture-phase listener or hold a blocker, so it never reaches here while they are open; **housing / 함선 관리 mode** (`ctx.housing.housingMode`) also keeps Escape (it cancels the placement) |
| `pointerlockchange` (lock lost) / `window` `blur` | if gameplay phase, no blocker, player alive, not paused and > 300 ms since `ctx.input.lastLockRequest` (a denied request) → emits `input:pointerLockLost` and pauses. Intended exits (inventory, map, menus, pause) add their blocker / set `paused` **before** `exitPointerLock()`, so they do not trigger this |
| unpause (Esc or 게임으로 돌아가기) | after emitting `game:paused false`, re-requests pointer lock in a microtask when still in a gameplay phase **or the ship** with no blockers (a following synchronous abort → `menu` cancels it) |

## Notes
- `missionTime` / `stats.timeSeconds` advance in `Engine.frame()`; `kills`, `cratesOpened`, `damageTaken` are
  incremented by Enemy / World / Player systems. GameFlow only resets and finalizes stats.
- Difficulty: `ctx.enemies.setThreatLevel()` ramps 0.3 → 0.7 over the first 8 minutes of mission time.

## Multiplayer (all gated on `ctx.isMultiplayer`; single-player is unchanged)
- Subscribes lazily to `ctx.net.onMessage('flow')` (`ensureNetHooks()` in `update` / `onNewMission`). Clients only:
  `over` → `gameOver()`, `complete` → `complete()`, `abort` → emits `game:abort`, `phase` → ignored. Messages not from `lobby.hostId` are dropped.
- **All-dead check (host only)**: local player is *out* (`isDead && !isDowned`) && every remote ref with `connected && !stale`
  is out too. A **downed** peer (`RemotePlayerRef.isDowned` or `PlayerFlags.DOWNED`) still counts as alive — a defibrillator
  can bring them back — so it blocks the wipe until they bleed out into a real `player:died`.
  Runs on `player:died`, `player:downed`, `net:remoteDied`, `net:peerLeft`, and every 0.5 s while the local player is dead or downed.
  When true → `flow over` to others + `gameOver()` locally.
- `complete()` on the host also sends `flow complete` so a client that missed `ex liftoff` still reaches the result screen;
  `complete()` / `gameOver()` are idempotent (no-op in `complete` / `dead` / `menu`).
- The all-dead check ignores remote refs with `PlayerFlags.IN_HUB` (a squadmate who aborted back to the ship) — they are not alive *in the mission*.
- Host abort: `wasMultiplayerHost` is cached every frame because NetSystem (registered earlier) may have ended the session
  before this handler runs; the `flow abort` send is still attempted (no-op if `ctx.net.send` already refuses).

## Progression payout (tactical kit)
`awardMissionXp()` runs **once per mission**, inside `complete()` / `gameOver()` before the phase change, so
`game:complete` / `game:over` listeners already see the new level. Guarded by `rewarded` (reset in `onNewMission` / `onAbort`)
and wrapped in `try/catch` — a progression failure never blocks the result screen.

| Term | Value |
|---|---|
| kills | `stats.kills × 12`, ×0.4 when the run ended in death |
| survival | `min(300, minutes × 20)` |
| extraction | `+300` flat and `stats.lootValue × 0.08` — loot only pays out when the player got out with it |

It also bumps `ctx.progression.profile.raids` (always) and `.extractions` (on `stats.extracted`) and calls
`ctx.progression.save()`. `ProgressionRef` has no counter setters, so the fields are mutated directly and
`save()` forces the write. Everything is behind `ctx.progression?` — single-player without the system registered is unaffected.

## Ship hub & reconnection (2026-09-05, pause added in Phase 8)
- `hub` / `docking` are **not** gameplay phases. Pointer-lock loss / window blur in the ship is still ignored here
  (`onFocusLost` gates on `isGameplayPhase()`); only Escape pauses.
- Order for `hub:enter` during a mission or result screen: HubSystem emits `game:abort` (→ `onAbort` → `menu`, World cleared, Player reset),
  then builds the ship and sets `hub`. A mission may start **from `hub`**: `game:newMission` from the solo launch pod, from `ctx.net.startGame`
  (host countdown) or from `ctx.net.rejoinMission()` (late joiner; spawns via the normal hellpod). `onNewMission` does not care about the previous phase.
- `inMission()` = gameplay ∪ `deploying` ∪ `complete` ∪ `dead` — everything the hub / a disconnect must abort first.
- Mirrored host `flow abort` → `game:abort` only while `inMission()`; `onAbort` then regroups the client in the shared ship (`hub:enter shared`).
- `net:reconnecting {attempt}` → `ui:notify "서버 재연결 중… (n)"`, **never aborts** (the socket is auto-reconnecting; the party is not gone).
- `net:resumed {seamless:true}` → `"재연결됨"`. `{seamless:false}` (the party moved on / a different mission) → `game:abort` + `hub:enter shared`.
- `net:lobbyLeft` (`disconnected` = server gave up / `hostLeft` / `kicked`) during gameplay → toast, `game:abort` after 2 s, then
  `hub:enter {ship: lobby ? 'shared' : 'personal'}` (normally personal — the lobby is gone). Reason `left` (we chose to leave) is ignored.
- Single-player is untouched: solo aborts still land on the title menu (the title's `함선 탑승` re-enters the personal ship).

## Phase 2 (2026-09-05): death → respawn (squad only since Phase 7)
- Multiplayer `player:died` → `respawnTimer = PLAYER_RESPAWN_DELAY` (30 s) and `game:respawnAvailable {seconds}` once per second (0 = allowed); phase unchanged (spectate overlay).
- `game:respawn` (UI, Space / 부활 button) → `onRespawnRequest()`: only while dead, the timer is exactly 0 and the raid is still live → `player:respawn {position: world.getPlayerSpawn()}`
  (player re-drops in the hellpod, inventory reapplies the starter kit). `player:landed` → `playing` as usual. Never honoured on the 레이드 실패 screen.

## Phase 7 (2026-09-06): squad wipe · raid session · rejoin · 훈련장 · host takeover
- **Wipe = failure** (`MISSION_FAILS_WHEN_ALL_DEAD = true`). `checkAllDead()` (host only, never in a training): the local player is out (`isDead && !isDowned`) and no
  remote ref is alive per `isRemoteAlive()` — refs with `!connected`, `!inMission` or `IN_HUB` are ignored; a `suspended` ref (socket down, host ghost) counts alive
  unless its last `net:ghostState` is 2 (fallback: the ref's own `isDead && !isDowned`); anyone else is alive while `!isDead || downed` (a downed peer can be revived;
  a dead peer waiting on the 30 s respawn is dead). Runs on `player:died / downed`, `net:remoteDied / peerLeft / ghostState / peerSuspended`, every 0.5 s while out,
  and on `net:hostChanged {isLocalHost:true}` (the new host takes the check + `flow` sending over; the old host stops). True → `flow over` to others + `gameOver()`.
- **`gameOver()`** = 레이드 실패 for solo death (after `DEATH_TO_SCREEN`) and for every client on `flow over`: stats finalised (`extracted=false`, `mode`), XP banked once,
  `game:raidFailed {stats}` → phase `dead` → `game:over {stats}` (ui shows 레이드 실패, inventory resets to the starter kit), then `hub:enter {shared | personal}`
  by itself after `RAID_FAILED_AUTO_RETURN_S` while still in phase `dead`. No respawn countdown in a solo raid.
- **Raid session**: in a multiplayer raid (`isMultiplayer && missionMode === 'raid'`) `saveRaid()` uploads `RaidSessionBlob {seed, missionTime, stats, inventory: captureRaidState(), savedAt}`
  through `ctx.net.saveRaid` every `RAID_SAVE_INTERVAL_S` of gameplay and right after `inventory:itemAdded` / `crate:looted` (each save re-arms the timer; skipped while `rejoinPending`).
- **Rejoin**: `net:raidLoaded {blob}` is kept (also read from `ctx.net.raidBlob`). `net:gameStarting {rejoin:true}` (not for a training) → `ctx.rejoinPending = true`
  *before* the rejoin's `game:newMission`, so the player skips the hellpod on `world:ready`. `onWorldReady()` then applies a blob with the same seed
  (`inventory.applyRaidState`, `ctx.stats` (seed / mode kept), `missionTime`) and arms `NET_GHOST_RESTORE_TIMEOUT_S`. `net:ghostRestore {state}` → `player.restoreState`,
  `rejoinPending=false`, phase `playing`; state 2 (our body bled out) → the squad death flow (30 s countdown + wipe check). Timeout → `player.respawn(world.getPlayerSpawn())` fallback.
- **훈련장** (`ctx.missionMode === 'training'`, `ctx.isTraining()`): no threat ramp, no `awardMissionXp` / `settleMission` / result screens (`gameOver()` is a no-op),
  death → immediate `player:respawn` at the arena spawn, `MissionStats.mode = 'training'`. `training:exitRequested` → `game:abort` (never `flow abort` — a training is personal)
  → `inventory.applyRaidState(trainingSnapshot)` (ammo / durability refunded) → `ctx.net.leaveMission()` when in a session → `hub:enter {shared if a lobby exists, else personal}`.
- Smoke: `scripts/smoke-raidflow.mjs` (solo death → 레이드 실패 → auto return, training enter / death / exit, synthetic rejoin blob + ghost restore alive / dead + timeout fallback).

## Phase 8 (2026-09-06): 함선에서 ESC = 일시정지
Escape in the ship used to open the hub terminal; it now opens the **pause menu** instead (the terminal is reached from
its console). Three surgical changes in `GameFlowSystem`, nothing else:
- `inShip()` = `ctx.phase === 'hub'` (never `docking` — the cutscene has no controls to pause).
- `setPaused()` accepts a pause while `inShip()`, and computes `freeze = !ctx.isMultiplayer && !inShip()` so the ship
  pause is **menu-only**: `Engine` keeps stepping (`freeze:false`), the ship keeps animating, and nothing
  mission-related happens — no `game:abort`, no stats, no timers (GameFlow's own timers are all mission timers and are
  already −1 in the hub).
- The Escape poll pauses in `hub` as well, unless `ctx.housing?.housingMode` is true — housing / 함선 관리 mode owns
  Escape (it cancels the placement / leaves the mode). `relock()` re-requests the pointer lock in the ship too, since
  the hub is walked with a pointer lock.
`PauseMenu` (ui/) renders the ship variant: 게임으로 돌아가기 / 설정 / 타이틀로 and **no** 함선으로 귀환. Its 타이틀로
leaves the lobby first and then emits `game:abort`, which lands on `menu` (HubSystem tears the ship down on the same
event) — without the `leaveLobby()` first, `onAbort` would regroup us in the shared ship.
