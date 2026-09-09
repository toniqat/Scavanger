# src/game — Mission flow (`GameFlowSystem`)

Phase state machine, pause, difficulty ramp and mission result. Publishes `ctx.phase` via `ctx.setPhase()`
(which emits `game:phaseChanged`). Registered last in `main.ts`.

Import via `@/game` → `GameFlowSystem`.

| File | Purpose |
|---|---|
| `GameFlowSystem.ts` | `GameSystem` (`name: 'gameflow'`). Phases: `menu → deploying → playing → extracting → shipLanded → liftoff → complete` or `dead`. The ship hub phases `hub` / `docking` are owned by `hub/HubSystem` (see below). |
| `model.ts` | 폴더 공용 어휘 — `GameFlowSystem` 에서 떼어낸 상수 · 타입 · 스크래치. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. `GameFlowSystem.ts` 가 재수출하므로 기존 import 경로는 그대로다 |
| `parts/Death.ts` | **사망 · 구조 · 분대 전멸**. **2026-09-09: 자동 부활은 없다** — 완전히 죽으면 시체가 서고(`Corpses.ts`) 되살아나는 길은 분대원의 구조선(`rescue:landed`)뿐이다. **분대 전원이 나가떨어지면 레이드가 실패**한다 (솔로는 죽는 즉시). 끊긴 대원의 고스트도 살아 있는 것으로 세므로 판정이 단순하지 않다. |
| `Corpses.ts` | **사망한 플레이어의 시체** (`ctx.corpses` = `PlayerCorpseManager`). `PlayerCorpseObject` 는 `Interactable` 이자 `PlayerCorpse` 다 — id `pcorpse:<owner>:<n>`, 프롬프트 `<이름>의 유해 뒤지기`(비면 `비어 있음`), 상호작용 → `inventory.openContainerItemsSized(...)`. 메시는 `SoldierModel` 을 죽은 자세로 **한 번** 굳혀 둔 것이고 (`setGreyed`), **레이드가 끝날 때까지 사라지지 않는다** — 수명도 거리 컬링도 없다 (사용자 결정). |
| `parts/CorpseNet.ts` | **시체의 생성과 동기화** (`pcorpse` / `pcorpseq`). `spawn` 은 죽은 본인이 `'all'` 로 (자기 인벤토리만이 진실), 호스트는 남의 시체도 `items` 채로 들고 있다가 `pcorpseq sync` / `flow rejoined` 에 `pcorpse sync` 로 답한다. 시체 **안의 아이템을 가져가는** 것은 상자와 똑같이 기존 `cont` / `contq` 경로다. `crate:looted` → `pcorpse emptied`. |
| `parts/Leader.ts` | **분대장 기기**. 멀티에서 호스트가 완전히 사망하면 시체 옆에 절차 생성 오브젝트(아이템 아님)가 떨어지고 죽은 호스트가 `ctx.net.reportHostDown(true)` 를 남긴다. `Interactable` `leader_device` (`LEADER_DEVICE_RANGE`, **`LEADER_DEVICE_HOLD_S` 홀드**, `분대장 기기 회수`) → `transferHost(me, true)` + `lead taken`. **`net:hostChanged` 토스트의 유일한 주인**이다 — 기기 회수든 커뮤니티 우클릭 이관이든 전부 여기로 모인다. |
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
| `player:died` | training: immediate `player:respawn` at the arena spawn (no failure). Solo raid: after 2.5 s → `gameOver()` (레이드 실패). Multiplayer (**2026-09-09**): phase unchanged, **no countdown** — `stripForCorpse()` → 시체(`parts/CorpseNet.spawnLocalCorpse`), 호스트였다면 분대장 기기(`parts/Leader.onHostDied`), 토스트 `전사 — 분대원의 구조선을 기다립니다 (남은 구조선 n)`, host runs the all-dead check |
| `rescue:landed` | `target` 이 나면(싱글은 `'sp'`) 죽음 타이머 · 전멸 체크를 내리고 `deploying` 이면 `playing` 으로. 몸을 세우는 것은 `player/` 가 한다 (`rescueRevive` — 헬포드 · `RESCUE_REVIVE_HP` · 빈손) |
| `crate:looted` (`pcorpse:…`) | 그 시체를 `비어 있음` 으로 바꾸고 `corpse:playerEmptied` + `pcorpse emptied` 를 방송 (메시는 남는다) |
| `world:cleared` / `game:abort` / `game:newMission` | 시체 · 분대장 기기 전부 정리 + 지오메트리 dispose (`clearCorpses()`) |
| `player:downed` | **not a death**: phase unchanged, `ui:notify "쓰러짐 — 아군의 제세동기를 기다립니다"`, the all-dead check is re-armed (a squadmate may already be dead) |
| `player:revived` | stops the all-dead check when the local player is no longer dead |
| `game:abort` | multiplayer host **during a live raid** (gameplay / `deploying`, never a training): `flow abort` to others first (leaving a result screen is local — the mission is already over); closes inventory, `menu`. If the abort ended a *lobby* mission / result screen, emits `hub:enter {ship:'shared'}` one microtask later (no-op when HubSystem's own `hub:enter` already built the ship) |
| Escape (gameplay phase **or `hub`**) | **2026-09-09: `escapeKey()`** — `ctx.escape.closeTop()` 이 열려 있는 화면 중 맨 위 하나를 닫고, 스택이 비어 있을 때만 `escapePause()` 가 일시정지 메뉴를 연다 (see the 2026-09-09 section at the end). 메뉴는 여전히 Escape 로 닫히지 않는다 — 데스크톱 셸만 예외다. Two entry points reach that method because the browser splits the key: a real `Keys.MENU` press when a screen already freed the cursor, and `input:pointerLockLost` when the pointer was locked and the browser ate the keydown to free it. Blockers are **not** checked — the menu stacks over an open screen. `PauseMenu` emits `game:paused false` from its button. `freeze` is always false (2026-09-07): a raid is an extraction run, and stopping the clock with a keypress made Escape a save-scum button; the field stays on the wire because Engine and the HUD read it |
| `window` `blur` / `visibilitychange` → hidden | if gameplay phase, no blocker, player alive and not paused → emits `input:pointerLockLost` and pauses. **2026-09-07 (커서 rework): losing the pointer lock is no longer one of these triggers.** Releasing the lock is how every screen shows the mouse now, and Chrome drops it on any Escape, so treating a missing lock as "the player left" is exactly what made the game freeze whenever the Windows cursor appeared. Only losing the *window* means someone actually walked away |
| ~~lost-lock watchdog~~ (`checkLockLost`) | **deleted 2026-09-07.** It existed because Phase 10 screens kept the lock and a lock that went missing meant the software cursor had silently fallen back to mirroring the real OS one. With the rework there is no hybrid state to detect: no lock simply means the mouse is a cursor |
| Escape while the Alt 커서 is up | **2026-09-09**: the Alt 커서 is an entry on `ctx.escape`, so Escape **gives the camera back and stops there** — no menu. (2026-09-08 dropped the cursor *and* opened the menu in the same press.) `escapePause` still force-drops it if the menu is opened some other way, since it is the one cursor owner with no window behind it |
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

## ~~Phase 2 (2026-09-05): death → respawn~~ → **2026-09-09: 자동 부활은 없다**

30초 부활 카운트다운은 **걷어냈다**. `PLAYER_RESPAWN_DELAY` · `game:respawn` · `game:respawnAvailable` 은
**계약이라 남아 있지만 아무도 발행하지도 구독하지도 않는다** (`tickRespawn` / `onRespawnRequest` 는 빈 함수다).

멀티에서 완전히 사망하면:
1. `inventory.stripForCorpse()` 로 장비 · 가방 · 퀵슬롯이 통째로 빠지고 (완전 빈손),
2. 그 자리에 시체가 서고 (`pcorpse spawn` 을 `'all'` 로 — 되돌아온 자기 메시지는 id 로 중복 제거),
3. 호스트였다면 시체 옆에 분대장 기기가 떨어지고 `reportHostDown(true)` 가 서버에 남고,
4. `ui/hud/SpectateOverlay` 가 `분대원의 구조선을 기다립니다` + `남은 구조선 n` 을 띄운다.

되살아나는 길은 분대원의 `rescue_drop` 뿐이다 — `stratagems/parts/Rescue` 가 `rescue:landed` 를 발행하고
`player/` 가 몸을(`RESCUE_REVIVE_HP`, 빈손, 헬포드 `kind` 1) `game/parts/Death` 가 흐름을 맡는다.
**전멸 판정은 그대로다**: 죽은 사람은 계속 out 이고 전원 out 이면 레이드 실패.

솔로 레이드는 예전처럼 죽는 즉시 레이드 실패라 시체도 구조선 화면도 없다 (전리품 가치가 결과창에 그대로 뜬다).

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
2026-09-10: `Input.relockScheduled` 가 켜져 있는 동안 — 타이밍 때문에 거부된 요청을 `Input` 이 스스로 다시
보내기로 예약해 둔 동안 — 도 뜨지 않는다. 그때 띄우면 1초쯤 떴다가 저절로 사라진다. 게이트가 받는 것은
클릭이 정말 필요한 거부(`"A user gesture is required"`)뿐이다.

### 데스크톱 셸 (`syncDesktopCursor` / `installDesktopRelockHook`)
- **커서 숨김**: 셸에서 게임플레이 / 함선 페이즈이고 커서 소유자가 없으면(Alt 커서도 소유자다) `<body>` 에
  `desktop-nocursor` 를 걸어 `cursor: none !important` — 락이 있든 없든. `ui/hud/GameCursor` 가 런타임
  `<style>` 로 같은 명시도의 규칙을 넣으므로 클래스를 하나 더 얹어 순서를 이긴다.
- **Escape 재잠금 훅**: `electron/main.ts` 가 Escape **key-up** 에서
  `webContents.executeJavaScript(SHELL_RELOCK, true)` 를 실행하고, 여기 있는 `window.__scavShellRelock` 이 두 프레임
  뒤(닫힌 화면이 커서 모드를 놓을 시간) 커서 소유자가 없을 때만 락을 다시 요청한다. 키 자체는 건드리지 않는다
  (합성 전달을 넣었다가 페이지가 Escape 를 두 번 받는 것을 측정하고 걷어냈다 — `electron/README.md` 의 실측 절).
  **2026-09-10 정정**: 두 번째 인자(user activation)는 이 문제의 답이 아니었다. Chromium 이 거부한 이유는
  activation 이 없어서가 아니라 *플레이어가 Escape 로 락을 푼 직후 ~1.25초* 라는 시간 규칙이고, 그 쿨다운은 어떤
  제스처로도 앞당겨지지 않는다 (실측은 `src/shared/README.md` 의 2026-09-10 절). 실제 해결은 `Input` 이 그
  시간대에 요청을 **미루는** 것이고(`deferredRelock`), 이 훅은 같은 게이트를 함께 통과하는 여벌로 남았다.


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

## 2026-09-09 — ESC 닫기 (위 절의 후속: 화면 닫기만 되돌렸다)

**Escape 한 번은 열려 있는 화면 중 맨 위 하나를 닫는다. 닫을 화면이 없을 때만 일시정지 메뉴가 열린다.**
사용자 보고: 커서가 보이면 사람은 그 창을 ESC 로 닫으려 한다.

위 2026-09-08 절의 세 가지 이유 가운데 **(1) 락이 걸린 동안 Escape 는 keydown 이 되지 않는다** 와
**(3) 메뉴 위에서 Escape 를 연타해도 아무 일이 없다** 는 그대로다. 무너진 것은 (2)뿐이다 — 닫은 뒤 카메라를
되찾는 방법이 이제 두 환경 모두 있다:

- **데스크톱 셸**: `electron/main.ts` 가 ESC **key-up** 마다 `executeJavaScript(code, true)` 로 페이지에
  activation 을 건네 `window.__scavShellRelock` 을 부른다 → 닫히는 즉시 카메라가 돌아온다.
- **브라우저**: `좌측 클릭으로 게임 재개` 게이트(`ResumeGate`)가 그 한 클릭을 받는다. 원래 이 상황을 위해
  만든 UI 이므로 새 문제가 아니다 (사용자 결정 2026-09-09: 조작을 환경마다 갈라 놓지 않는다).

| 무엇 | 어디 |
|---|---|
| 열린 순서 | `shared/escape.ts` 의 `EscapeStack`, `ctx.escape` 로 게시. 화면은 `uiBlockers.add` 옆에서 `push(token, () => this.close())`, `delete` 옆에서 `remove(token)`. 닫기 함수가 **`false`** 를 돌려주면 항목이 남는다 (한 걸음만 되돌린 화면 — 하우징 모드) |
| 정책 (한 곳) | `parts/Phases.escapeKey` — `ctx.escape.closeTop()` 이 false 면 `escapePause()`. `GameFlowSystem.update` 의 `Keys.MENU` 폴링이 유일한 호출자 |
| 락이 걸린 채로 누른 Escape | 그대로 `input:pointerLockLost` → `escapePause()`. 그때는 커서를 쓰는 화면이 없으므로 닫을 것도 없다 |
| 가장 안쪽 팝업 | 바뀐 것 없음 — 수량 지정 · 우클릭 메뉴 · 경고 팝업 · 설정 · 키 바꾸기 · 콘솔 · 채팅은 자기 window capture 핸들러에서 Escape 를 삼켜 `Input` 이 기록조차 못 하게 한다. 스택은 그 아래층인 **화면** 만 다룬다 |
| Alt 커서 | `escapePause` 가 강제로 내려놓던 것에서 **스택의 한 항목**으로 바뀌었다 (`toggleFreeCursor`). ESC 는 카메라를 돌려주고 끝난다 — 메뉴는 열리지 않는다 |
| 하우징 / 함선 관리 모드 | `hub/HousingMode` 가 `Keys.MENU` 를 직접 폴링하던 것을 걷어내고 스택에 올렸다. 폴링은 `HubSystem`(등록 89) 이 `GameFlowSystem`(105) 보다 먼저 돌아 **위에 떠 있는 패널보다 모드가 먼저 닫혔다**. C 는 그대로 |
| 일시정지 메뉴 자신 | **데스크톱 셸에서만** ESC 로 닫힌다 (`isDesktopShell()`, `ui/menus/PauseMenu` 의 capture 핸들러가 Tab 과 똑같이 처리). 브라우저는 `게임으로 돌아가기` 클릭 그대로 — 그 클릭이 재락에 필요한 제스처이기도 하다 |
| 키 가이드 | 우측 하단 `닫기` 항목의 keycap 이 **둘**(`Tab` · `Esc`)이 됐다 (`ui/hud/KeyGuide`) |
| 검증 | `scripts/smoke-resume-gate.mjs` §8 (닫기 · LIFO · 게이트) · §9 (셸에서 메뉴 닫기), `scripts/smoke-controls-hub.mjs` (가방 · Alt 커서), `scripts/smoke-raidflow.mjs`, `scripts/smoke-ui-p6.mjs` (키 가이드) |

### Known follow-ups (2026-09-09)
- 스택은 push/remove 규율에 의존한다 (블로커 토큰과 같은 규율). 화면이 `remove` 를 빼먹고 닫히면 그 ESC 한 번이
  이미 닫힌 화면의 `close()` 를 부르고(무해) 메뉴는 열리지 않는다.
- 튜토리얼 안내 팝업(`tutorial/ui/Popup`)은 스택에 없다 — 버튼(확인 · 1초 홀드 건너뛰기)이 그 팝업의 유일한
  출구여서다. 그 위에서 ESC 는 여전히 일시정지 메뉴를 연다.
- 브라우저에서 ESC 로 화면을 닫으면 재개 게이트가 한 번 뜬다. 조작을 통일하기로 한 대가이고, 셸에는 없다.

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

- **2026-09-09 (사망 · 시체 · 분대장)** — **자동 부활 제거**(30초 카운트다운 · `game:respawnAvailable` 발행/구독을
  끊었다 — 계약은 남는다), 새 `Corpses.ts` 가 `ctx.corpses` 를 게시하고 완전히 사망한 플레이어의 **시체**를
  레이드가 끝날 때까지 세워 둔다(절차 생성 `SoldierModel`, `Interactable` `pcorpse:<owner>:<n>`,
  루팅은 `openContainerItemsSized` + 기존 `cont` 경로), 새 `parts/CorpseNet.ts` 가 `pcorpse` / `pcorpseq` 와
  호스트 late-join sync 를, 새 `parts/Leader.ts` 가 **분대장 기기**(3초 홀드 회수 · `reportHostDown` ·
  `transferHost(me, true)`)와 `net:hostChanged` 토스트를 맡는다. `rescue:landed` 로 부활 흐름을 정리한다.

### 알려진 한계 (2026-09-09)
- `Corpses.ts` 가 `@/player` 의 `SoldierModel` 을 import 한다 — **폴더 간 import 금지 규약의 의도적 예외**다
  (병사 모델을 두 번 만들지 않기 위해서). 역방향 의존은 없으므로 순환은 생기지 않는다.
- **임플란트 아이템은 시체로 가지 않는다.** 그 인스턴스는 `ctx.progression` 이 들고 있고
  `ProgressionRef.unequipImplant` 는 함선 전용이라 레이드 중에 뺄 방법이 계약에 없다
  (`ProgressionRef.stripImplants()` 같은 추가가 필요하다).

- **2026-09-08 (훈련장은 강하하지 않는다)** — `onWorldReady` 가 훈련이면 `'deploying'` 을 건너뛰고 바로
  `'playing'` 이다. 훈련장은 함선 안의 방이지 행성이 아니라 `player/` 도 헬포드를 띄우지 않으므로,
  `'deploying'` 에 들어가면 그 페이즈를 끝내는 `player:landed` 가 영영 오지 않는다.

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
