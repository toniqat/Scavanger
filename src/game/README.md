# src/game — Mission flow (`GameFlowSystem`)

Phase state machine, pause, difficulty ramp and mission result. Publishes `ctx.phase` via `ctx.setPhase()`
(which emits `game:phaseChanged`). Registered last in `main.ts`.

Import via `@/game` → `GameFlowSystem`.

| File | Purpose |
|---|---|
| `GameFlowSystem.ts` | `GameSystem` (`name: 'gameflow'`). Phases: `menu → deploying → playing → extracting → shipLanded → liftoff → complete` or `dead`. The ship hub phases `hub` / `docking` are owned by `hub/HubSystem` (see below). |
| `model.ts` | 폴더 공용 어휘 — `GameFlowSystem` 에서 떼어낸 상수 · 타입 · 스크래치. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. `GameFlowSystem.ts` 가 재수출하므로 기존 import 경로는 그대로다 |
| `parts/Death.ts` | **사망 · 부활 · 분대 전멸**. 죽으면 30초 뒤 부활할 수 있지만, **분대 전원이 나가떨어지면 레이드가 실패**한다 (솔로는 죽는 즉시). 끊긴 대원의 고스트도 살아 있는 것으로 세므로 판정이 단순하지 않다. |
| `parts/Session.ts` | **레이드 세션 저장과 복귀**. 솔로 레이드는 localStorage 에 5분짜리 스냅샷을 남기고(`SoloRaid.ts`), 멀티는 릴레이의 레이드 저장소를 쓴다. 복귀는 `world:ready` 뒤에 인벤토리 · 스탯 · 시계를 되돌리고, 호스트가 보관하던 몸이 있으면 그 자리에서 일어난다(없으면 헬포드로 떨어진다). |
| `parts/Phases.ts` | **페이즈 전환과 일시정지**. menu → hub → deploying → playing → extracting → complete / dead → hub. 일시정지는 **월드를 멈추지 않고**(2026-09-07) 창 포커스를 잃었을 때만 뜬다. 일시정지 메뉴는 항상 단 하나의 화면이라 다른 창이 열려 있으면 즉시 양보한다(Phase 12 — 겹쳐서 둘 다 못 끄던 상태의 수정). |
| `parts/Wire.ts` | **`flow` 메시지**와 호스트 이관 · 로비 이탈의 흐름 처리. |
| `ResumeGate.ts` | **Phase 12**: the browser-only `좌측 클릭으로 게임 재개` overlay (`ResumeGate`), the desktop-shell cursor rule (`syncDesktopCursor`) and the shell's Escape re-lock hook (`installDesktopRelockHook` → `window.__scavShellRelock`). Owns `resume-gate.css`. |
| `resume-gate.css` | The gate's own styles + `body.desktop-nocursor` (the Electron cursor-hiding class). Imported from `ResumeGate.ts`. |
| `SoloRaid.ts` | 솔로 레이드 세션 저장 (2026-09-07): localStorage `scav.soloraid` (`SOLO_RAID_STORAGE_KEY`), `SoloRaidSave` / `SoloRaidPose`, `loadSoloRaid` / `saveSoloRaid` / `clearSoloRaid` / `soloRaidStatus`, `SOLO_RAID_GRACE_MS` (5 min). Pure storage — no context, no listeners. |
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
| Escape (gameplay phase **or `hub`**) | **2026-09-08: always `escapePause()`** — the 일시정지 메뉴 opens no matter what is on screen, and Escape never closes it or anything else (see the section at the end). Two entry points reach that method because the browser splits the key: a real `Keys.MENU` press when a screen already freed the cursor, and `input:pointerLockLost` when the pointer was locked and the browser ate the keydown to free it. Blockers are **not** checked — the menu stacks over an open screen. `PauseMenu` emits `game:paused false` from its button. `freeze` is always false (2026-09-07): a raid is an extraction run, and stopping the clock with a keypress made Escape a save-scum button; the field stays on the wire because Engine and the HUD read it |
| `window` `blur` / `visibilitychange` → hidden | if gameplay phase, no blocker, player alive and not paused → emits `input:pointerLockLost` and pauses. **2026-09-07 (커서 rework): losing the pointer lock is no longer one of these triggers.** Releasing the lock is how every screen shows the mouse now, and Chrome drops it on any Escape, so treating a missing lock as "the player left" is exactly what made the game freeze whenever the Windows cursor appeared. Only losing the *window* means someone actually walked away |
| ~~lost-lock watchdog~~ (`checkLockLost`) | **deleted 2026-09-07.** It existed because Phase 10 screens kept the lock and a lock that went missing meant the software cursor had silently fallen back to mirroring the real OS one. With the rework there is no hybrid state to detect: no lock simply means the mouse is a cursor |
| Escape while the Alt 커서 is up | **2026-09-08**: `escapePause()` drops the free cursor **and** opens the menu in the same press — the Alt 커서 is the one cursor owner with no window behind it, so leaving it up under the menu would strand the player with no camera |
| left click on the canvas while the Alt 커서 is up | **2026-09-07:** closes it (`onFreeCursorClick` → `toggleFreeCursor(false)`) — it is the one cursor owner with no window behind it, so a click on the world can only mean 카메라 복귀, and a click is the user gesture Chrome wants before it grants the lock back. A click whose target is a HUD element is left alone |
| `Keys.CURSOR` (Alt) | **2026-09-07:** frees the mouse in place with no screen behind it — `ctx.uiBlockers` token `FREE_CURSOR_BLOCKER` (`'cursor'`) + `input.setCursorMode(true, 'cursor')`, so gameplay input is gated exactly as an open panel gates it and `main.ts` re-locks on release. Emits `ui:freeCursorToggled {active}`. Only from a gameplay phase or the ship, alive, with no other blocker; a phase change or a death releases it in `update()` |
| unpause (**게임으로 돌아가기 only** — 2026-09-08: Escape is inert on the menu, and that click is the engagement gesture the browser requires before it will re-lock) | emits `game:paused false` and nothing else — **2026-09-07 (커서 rework)**: `ui/menus/MenuBase` owns the `'menu'` cursor token (taken on `show()`, dropped on `hide()`) and `main.ts` is the single place that re-requests the lock once the last cursor owner is gone. `GameFlowSystem` no longer touches the pointer lock at all. Outside fullscreen Chrome still grants no activation for Escape, so that request may be denied and `Input` retries it from the next click or key; in fullscreen `navigator.keyboard.lock(['Escape'])` means it never had to |

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
  unless `r.ghostState` is 2 (Phase 9: the ghost state lives on the ref — net's `applyGhost` / the host's own `applyToRef` write it, `clearGhost` / a parked ghost
  clear it; the old `ghostStates` map and the `net:ghostState` subscription are gone; fallback: the ref's own `isDead && !isDowned`); a parked member is already
  `!inMission`. Anyone else is alive while `!isDead || downed` (a downed peer can be revived; a dead peer waiting on the 30 s respawn is dead). Runs on
  `player:died / downed`, `net:remoteDied / peerLeft / peerSuspended`, every 0.5 s while out (this timer also catches a ghost that bleeds out),
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

## 2026-09-07: 레이드 접속 끊김 처리
- **`SoloRaid.ts`** (new) — the single-player counterpart of the relay's raid store, in localStorage `scav.soloraid`
  (`SoloRaidSave` = seed / 목표 행성 / `missionTime` / `MissionStats` / `captureRaidState()` / the body pose).
  `saveRaid()` routes to `saveSolo()` while `!ctx.isMultiplayer && missionMode === 'raid'` (same cadence: every
  `RAID_SAVE_INTERVAL_S` and on loot), plus a `pagehide` flush so a closed tab keeps the last seconds.
- **Resume**: `init()` reads the file and the first `update()` acts on it (`consumeStoredSoloRaid`, phase `menu` only —
  a lobby resume that beat us to it wins). Inside `SOLO_RAID_GRACE_MS` (5 min) → `resumeSoloRaid()`: `rejoining` +
  `ctx.rejoinPending` are set, the save becomes `this.raidBlob`, the pose becomes `soloRestore`, and `game:newMission`
  is emitted with the stored seed / planet. `onWorldReady()` applies the blob exactly as a multiplayer rejoin does and
  then calls `onGhostRestore(soloRestore)` directly — there is no host to answer `flow rejoined`, so no
  `NET_GHOST_RESTORE_TIMEOUT_S` wait. Past the window → `game:abort` (which resets the kit to the starter, the same
  loss any failed raid takes) + a `복귀가 너무 늦었습니다 — 레이드 실패` toast. The file is cleared on `complete()`,
  `gameOver()`, `onAbort()` and on being read, so no reload can resurrect a finished run.
- **Multiplayer** is unchanged here but reaches further: the relay keeps a dropped raider's lobby slot for the whole
  mission (`server/RelayServer.armGrace`) and the host parks their body for `NET_GHOST_PARK_S` (now an hour), and
  `hub/HubSystem.onResumed` **auto-calls `rejoinMission()`** instead of parking the player next to a pod, so a
  reconnect drops straight back into the raid. `net:resumed {inProgress:false}` still lands in the shared ship.

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

## Phase 9 UI/UX 개선 pass (2026-09-07)

- `net:resumed` reads `lobby.mode`: a non-seamless resume while a **훈련장** runs reports
  `훈련장 연결이 끊겼습니다 — 함선으로 복귀` instead of `분대가 다른 임무를 진행 중입니다`. The abort → shared-ship
  path is unchanged (our arena session is gone either way).


## Phase 12 (2026-09-08): 브라우저 재개 게이트 · 데스크톱 커서

### 브라우저 재개 게이트 (`ResumeGate`)
커서 화면을 **Escape 로** 닫으면 Chrome 이 재잠금을 거부한다(Escape 에는 사용자 활성화가 없다). 그때까지는
"게임은 도는데 윈도우 커서만 떠 있는" 무언의 상태였다. 이제 `GameFlowSystem.update()` 가 매 프레임
`ResumeGate.update()` 를 돌려, **브라우저에서** (게임플레이 또는 함선 · 생존 · 워프 중 아님) 커서 소유자가 없고
락도 없는데 `ctx.input.awaitingLockGesture` 가 서 있으면 전체화면 오버레이를 띄운다 — 블러 배경(닫힌 창이 자기
블러를 가져갔으므로), 가운데 `좌측 클릭으로 게임 재개`, `RESUME_GATE_BLOCKER` 를 `ctx.uiBlockers` 에
(게임플레이 입력만 꺼지고 월드는 일시정지처럼 계속 돈다), `ui:resumeGate {shown:true}`.
좌클릭 → `ctx.input.requestPointerLock()`(클릭이 바로 그 제스처) → 락이 오면 숨기고 blocker 해제 +
`{shown:false}`. **다른 제스처**(WASD 재시도, 캔버스 클릭)로 락이 돌아와도 같은 프레임에 사라지므로 절대 남지
않는다. 자기 키(Tab)로 닫은 화면은 진짜 키 입력이라 즉시 재잠금되고 게이트는 뜨지 않는다.
`isDesktopShell()` 이면 **절대** 뜨지 않는다.

### 데스크톱 셸 (`syncDesktopCursor` / `installDesktopRelockHook`)
- **커서 숨김**: 셸에서 게임플레이 / 함선 페이즈이고 커서 소유자가 없으면(Alt 커서도 소유자다) `<body>` 에
  `desktop-nocursor` 를 걸어 `cursor: none !important` — 락이 있든 없든. `ui/hud/GameCursor` 가 런타임
  `<style>` 로 같은 명시도의 규칙을 넣으므로 클래스를 하나 더 얹어 순서를 이긴다.
- **Escape 재잠금 훅**: `electron/main.ts` 가 Escape **key-up** 에서
  `webContents.executeJavaScript(SHELL_RELOCK, true)` 를 실행한다 — 두 번째 인자가 "사용자 제스처로 실행"이라
  여기 있는 `window.__scavShellRelock` 이 두 프레임 뒤(닫힌 화면이 커서 모드를 놓을 시간) 커서 소유자가 없을 때만
  락을 다시 요청할 수 있다. 키 자체는 건드리지 않는다(합성 전달을 넣었다가 페이지가 Escape 를 두 번 받는 것을
  측정하고 걷어냈다 — `electron/README.md` 의 실측 절).


## 2026-09-08 — ESC = 항상 일시정지

**Escape opens the 일시정지 메뉴, from anywhere, and never closes it.** The menu closes on 게임으로 돌아가기 only.

Why the shape is forced by the browser, not by taste:

1. While the pointer is locked the browser **eats the Escape keydown** — it uses the key to free the cursor and the
   page is never told. That is why the menu used to need two presses. Every browser FPS solves it the same way, by
   treating the *unlock itself* as the key: `Input.onUserUnlock` → `main.ts` → `input:pointerLockLost` → `escapePause()`.
2. After that default unlock gesture the spec requires a fresh **engagement gesture** before `requestPointerLock`
   succeeds, and it lets the UA demand more still if Escape is repeated. So the camera can only come back on a click —
   and `게임으로 돌아가기` **is** that click. An Escape-to-close would ask for the lock at the one instant the browser
   refuses it, which is exactly the bug the old build had.
3. Because Escape is inert on the menu, mashing it does nothing at all instead of walking into the UA's
   repeated-Escape throttle.

`update()` therefore reduces to `if (wasPressed(Keys.MENU)) { consume; escapePause(); }` — reached only when a screen
already freed the cursor and the key really arrives — and `escapePause()` is the single entry point for both paths:
it refuses while already paused, requires a gameplay or hub phase and a living player, drops the Alt 커서 (it has no
window behind it and would strand the player under the menu), and pauses. Screens are **not** closed: the menu stacks
over them and 게임으로 돌아가기 returns to what was open. `onFocusLost` now only emits the event; the handler pauses.

### Known follow-ups
- `input:pointerLockLost` is emitted by both `main.ts` (a user unlock) and `onFocusLost` (a window blur). The handler
  is idempotent, but the event no longer means only one thing.
- With Escape inert on the menu, a player whose mouse stops working has no keyboard way out of the pause screen.
- The pause stacking is one level deep by design: Escape over the menu does nothing, so there is no "close the menu
  and the screen under it" gesture.

## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`GameFlowSystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체, 상태 없는 보조 클래스).
   `GameFlowSystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function foo(sys: GameFlowSystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 호출부는 하나도 바뀌지 않았다.
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

새 `parts/` 파일은 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고 위 표에 행을 추가한다.
순환 import 를 만들지 않으려면 `parts/` 는 `GameFlowSystem.ts` 에서 **타입만** 가져와야 한다 — 값은 `model.ts` 로.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **tactical kit** — mission-end XP (`awardMissionXp` → `ctx.progression.addXp`, raids / extractions counters), downed players never count as dead for the wipe check

- **Phase 7** — **squad wipe = 레이드 실패** (`MISSION_FAILS_WHEN_ALL_DEAD` true; ghost-aware rule; solo death fails at once; `game:raidFailed` + `game:over`, auto `hub:enter` after `RAID_FAILED_AUTO_RETURN_S`; 30 s respawn kept until the wipe), raid session `saveRaid` every `RAID_SAVE_INTERVAL_S` + on loot, rejoin restore (`net:raidLoaded` blob → inventory / stats / time after `world:ready`, `net:ghostRestore` → `player.restoreState`, hellpod fallback after `NET_GHOST_RESTORE_TIMEOUT_S`), training flow (`ctx.missionMode`, loadout snapshot restored on `training:exitRequested`, no XP / settlement / threat, death = instant respawn), a promoted host takes over `flow` messages

- **Phase 8** — the **ship pauses on Esc** as well (`freeze` stays false there, no `game:abort` / stats side effects), skipped while housing / 함선 관리 owns the key

- **Phase 9** — the wipe check reads `RemotePlayerRef.ghostState` instead of its own `net:ghostState` map

- **Phase 9 UI/UX 개선** — `net:resumed` 는 훈련장을 `분대가 다른 임무` 로 보고하지 않는다

- **Phase 11** — `game:newMission.planet` 으로 `ctx.missionPlanet` 을 확정한다(훈련장은 null, 필드 없는 emit 은 마지막 목적지 유지 — 같은 시드 재배치가 행성을 몰래 바꾸지 않게)

- **2026-09-07 (안정화)** — 일시정지가 **더는 월드를 멈추지 않는다**(`freeze` 는 항상 false — 싱글 레이드 포함), `checkLockLost` 워치독이 포인터 락이 `LOCK_LOST_GRACE_S` 넘게 없으면 **블로커와 무관하게** ESC 화면을 띄우고(락을 한 번이라도 잡은 세션에서만 — **2026-09-07 커서 rework 로 삭제**), 새 `SoloRaid.ts` 가 솔로 레이드를 localStorage `scav.soloraid` 에 저장해 5분 안에 다시 열면 이어서 진행(그 뒤면 레이드 실패)

- **2026-09-07 (커서 편의성)** — `relock()` 의 조건이 `uiBlockers.size > 0` → **`uiBlockers.has('menu')`** (Phase 10 이후 락을 놓는 화면은 일시정지 메뉴뿐인데, 예전 조건 때문에 인벤토리 · 터미널 위에 뜬 메뉴를 닫으면 재잠금이 통째로 생략됐다), 워치독은 `ctx.input.awaitingLockGesture` 동안 대기한다(거부된 요청은 잃어버린 락이 아니다)

- **2026-09-07 (마우스 커서 rework)** — **락 상실은 더 이상 일시정지가 아니다** — `checkLockLost` 워치독과 `pointerlockchange` → pause 를 걷어내고 일시정지는 **창 포커스 상실(`blur` / `visibilitychange`)** 에서만 뜬다, `setPaused` 는 포인터 락을 아예 건드리지 않으며(메뉴는 `MenuBase` 의 `'menu'` 커서 토큰, 재잠금은 `main.ts` 하나), 새 **Alt 커서**(`Keys.CURSOR` → `toggleFreeCursor`, `FREE_CURSOR_BLOCKER` + 커서 모드, Escape 로도 닫힘, `ui:freeCursorToggled`)가 화면 없이 마우스만 풀어 준다

- **2026-09-07 (좌클릭 카메라 복귀)** — Alt 커서는 **캔버스 좌클릭으로도 닫힌다**(`onFreeCursorClick`) — 뒤에 창이 없는 유일한 커서 소유자라 월드 클릭은 카메라 복귀로만 읽히고, 클릭은 Chrome 이 락을 돌려주기 전에 요구하는 진짜 제스처다(HUD 요소가 대상인 클릭은 건드리지 않는다)

- **Phase 12 (2026-09-08)** — 새 `ResumeGate.ts` — 브라우저에서 커서 화면을 Escape 로 닫아 재잠금이 거부되면(`awaitingLockGesture`) 블러 오버레이 `좌측 클릭으로 게임 재개` + `RESUME_GATE_BLOCKER` + `ui:resumeGate`, 좌클릭 한 번에 복귀하고 다른 제스처(WASD)로 락이 와도 사라진다(Tab 으로 닫으면 애초에 안 뜬다); `syncDesktopCursor` 가 셸에서 커서 소유자가 없을 때 `body.desktop-nocursor` 로 OS 커서를 숨기고 `installDesktopRelockHook` 이 `window.__scavShellRelock` 을 건다

- **2026-09-08 (ESC = 항상 일시정지)** — Escape 는 어디서나 `escapePause()` 로 모여 일시정지 메뉴를 **열기만** 한다 (닫는 것은 `게임으로 돌아가기` 뿐). 화면은 각자 연 키(Tab · M · P · E)로 닫고 메뉴는 그 위에 쌓이므로, Phase 12 의 `otherScreenOpen()` 양보 규칙은 사라졌다. 재개 게이트는 그 아래 최후 수단으로 남아 있다
