# src/game — Mission flow (`GameFlowSystem`)

Phase state machine, pause, difficulty ramp and mission result. Publishes `ctx.phase` via `ctx.setPhase()`
(which emits `game:phaseChanged`). Registered last in `main.ts`.

Import via `@/game` → `GameFlowSystem`.

| File | Purpose |
|---|---|
| `GameFlowSystem.ts` | `GameSystem` (`name: 'gameflow'`). Phases: `menu → deploying → playing → extracting → shipLanded → liftoff → complete` or `dead`. The ship hub phases `hub` / `docking` are owned by `hub/HubSystem` (see below). |
| `model.ts` | 폴더 공용 어휘 — `GameFlowSystem` 에서 떼어낸 상수 · 타입 · 스크래치. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. `GameFlowSystem.ts` 가 재수출하므로 기존 import 경로는 그대로다 |
| `parts/Death.ts` | **사망 · 구조 · 분대 전멸**. **2026-09-09: 자동 부활은 없다** — 완전히 죽으면 시체가 서고(`Corpses.ts`) 되살아나는 길은 분대원의 구조선(`rescue:landed`)뿐이다. **분대 전원이 나가떨어지면 레이드가 실패**한다 (솔로는 죽는 즉시). 끊긴 대원의 고스트도 살아 있는 것으로 세므로 판정이 단순하지 않다. |
| `Corpses.ts` | **사망한 플레이어의 시체** (`ctx.corpses` = `PlayerCorpseManager`). `PlayerCorpseObject` 는 `Interactable` 이자 `PlayerCorpse` 다 — id `pcorpse:<owner>:<n>`, 프롬프트 `<이름>의 유해 뒤지기`(비면 `비어 있음`), 상호작용 → `inventory.openContainerItemsSized(...)`. 메시는 `SoldierModel` 을 죽은 자세로 **한 번** 굳혀 둔 것이고 (`setGreyed`), **레이드가 끝날 때까지 사라지지 않는다** — 수명도 거리 컬링도 없다 (사용자 결정). **2026-09-11**: `kind: 'playerCorpse'`(C-4 — 빛기둥 · 정찰 분류가 id 접두어 대신 이것을 먼저 본다), 그리고 **전차에 실린다**(C-18) — 생성 직후 `boardCarrier(world)` 가 발밑의 움직이는 발판(`getStandingObstacle(...).velocity`)을 찾아 `@/shared` 의 `recordRideLocal` 로 적어 두고, `PlayerCorpseManager.update()`(`GameFlowSystem.update` 가 매 프레임 부른다)가 `restoreRideLocal` 로 자리(= 상호작용 위치, 같은 벡터) · 메시 · 방향(곡선 구간의 `box.yaw` 변화)을 다시 푼다. 시체는 스스로 움직이지 않으므로 유지 판정 · 하차 관성은 없다. 호스트 · 리플리카 · 늦은 합류자 모두 **자기 월드의 전차**로 푼다. **2026-09-11 (C-63)**: 와이어가 탑승을 나른다 — `rideWire()`/`toWire()` 가 `PlayerCorpseWire.ride {tram, local, yaw}` 를 싣고(지금 탄 전차 · 차량 로컬 좌표), 받는 쪽 `boardFromWire()` 가 지연된 `p` 대신 **내 전차의 지금 변환**으로 그 로컬 좌표를 풀어 자리를 잡는다(모르는 id → 예전 `boardCarrier`). `ride` 는 매니저가 `pcorpse` 를 따로 구독해(`hookNet` · `noteWireRide` · `pendingRide`) `add` 앞뒤 어느 순서에도 붙는다. |
| `parts/CorpseNet.ts` | **시체의 생성과 동기화** (`pcorpse` / `pcorpseq`). `spawn` 은 죽은 본인이 `'all'` 로 (자기 인벤토리만이 진실), 호스트는 남의 시체도 `items` 채로 들고 있다가 `pcorpseq sync` / `flow rejoined` 에 `pcorpse sync` 로 답한다. 시체 **안의 아이템을 가져가는** 것은 상자와 똑같이 기존 `cont` / `contq` 경로다. `crate:looted` → `pcorpse emptied`. **2026-09-11**: 시체 높이는 지형(`getHeightAt`)이 아니라 **`getSurfaceY(x, z, 발 높이)`** — 전차 데크 · 2층 바닥에서 죽은 시체가 그 밑 땅으로 떨어지지 않게 (로컬 사망 · 받은 와이어 둘 다). `stripForCorpse()` 결과에는 이제 **장착 임플란트의 망가진 짝**이 들어 있다 (C-12 — 합치기는 inventory/, 해제는 progression/). |
| `parts/Leader.ts` | **분대장 기기**. 멀티에서 호스트가 완전히 사망하면 시체 옆에 절차 생성 오브젝트(아이템 아님)가 떨어지고 죽은 호스트가 `ctx.net.reportHostDown(true)` 를 남긴다. `Interactable` `leader_device` (`LEADER_DEVICE_RANGE`, **`LEADER_DEVICE_HOLD_S` 홀드**, `분대장 기기 회수`) → `transferHost(me, true)` + `lead taken`. **`net:hostChanged` 토스트의 유일한 주인**이다 — 기기 회수든 커뮤니티 우클릭 이관이든 전부 여기로 모인다. **기기의 점광원은 기기 안에 없다** (2026-09-10): 모듈 하나가 `installLeaderLight` 로 `init` 때 씬에 심고(`LeaderDeviceLight`, intensity 0) 기기는 자리와 밝기만 준다 — 광원을 든 오브젝트를 씬에 넣고 빼면 씬의 모든 머티리얼이 셰이더를 다시 컴파일한다. |
| `parts/Session.ts` | **레이드 세션 저장과 복귀**. 솔로 레이드는 localStorage 에 5분짜리 스냅샷을 남기고(`SoloRaid.ts`), 멀티는 릴레이의 레이드 저장소를 쓴다. 복귀는 `world:ready` 뒤에 인벤토리 · 스탯 · 시계를 되돌리고, 호스트가 보관하던 몸이 있으면 그 자리에서 일어난다(없으면 헬포드로 떨어진다). **2026-09-11 (C-70)**: `saveRaid` 의 **솔로 경로에는 「죽은 뒤에는 저장하지 않는다」 가드**가 있다 (`isDead && !isDowned` → 아무것도 쓰지 않고 돌아간다). 멀티에는 걸지 않는다 — 거기서는 사망 직후 저장이 바로 복제를 막는 장치다. |
| `parts/Phases.ts` | **페이즈 전환과 일시정지**. menu → hub → deploying → playing → extracting → complete / dead → hub. 일시정지는 **월드를 멈추지 않고**(2026-09-07) 창 포커스를 잃었을 때만 뜬다. 일시정지 메뉴는 항상 단 하나의 화면이라 다른 창이 열려 있으면 즉시 양보한다(Phase 12 — 겹쳐서 둘 다 못 끄던 상태의 수정). |
| `parts/Wire.ts` | **`flow` 메시지**와 호스트 이관 · 로비 이탈의 흐름 처리. |
| `ResumeGate.ts` | **Phase 12**: the browser-only `좌측 클릭으로 게임 재개` overlay (`ResumeGate`), the desktop-shell cursor rule (`syncDesktopCursor`) and the shell's Escape re-lock hook (`installDesktopRelockHook` → `window.__scavShellRelock`). Owns `resume-gate.css`. |
| `resume-gate.css` | The gate's own styles + `body.desktop-nocursor` (the Electron cursor-hiding class). Imported from `ResumeGate.ts`. |
| `SoloRaid.ts` | 솔로 레이드 세션 저장 (2026-09-07): localStorage `scav.soloraid` (`SOLO_RAID_STORAGE_KEY`), `SoloRaidSave` / `SoloRaidPose`, `loadSoloRaid` / `saveSoloRaid` / `clearSoloRaid` / `soloRaidStatus`, `SOLO_RAID_GRACE_MS` (5 min). Pure storage — no context, no listeners. **2026-09-11 (E-5)**: `soloRaidBootStatus` (loadout `raidSeed` marker) · `readClockHigh` / `bumpClockHigh` (`SOLO_CLOCK_HIGH_KEY`), `soloRaidStatus` refuses a far-future save and a clock set back. **2026-09-10**: `SoloRaidPose.shield` (선택) — v1 세이브에는 없고, 없으면 `restoreState` 가 방탄복 최대치로 복구한다. |
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
| `player:died` | training: immediate `player:respawn` at the arena spawn (no failure). Solo raid: `raidSaveTimer = -1` + **`clearSoloRaid()` 즉시** (2026-09-11 C-70 — 죽는 순간 레이드는 끝났다), 그 뒤 2.5 s → `gameOver()` (레이드 실패). Multiplayer (**2026-09-09**): phase unchanged, **no countdown** — `stripForCorpse()` → 시체(`parts/CorpseNet.spawnLocalCorpse`) → **`Session.saveRaid(sys)` 1회 강제 저장**(2026-09-11 C-70 — 순서가 곧 근거다: 빈 가방을 찍어야 한다), 호스트였다면 분대장 기기(`parts/Leader.onHostDied`), 토스트 `전사 — 분대원의 구조선을 기다립니다 (남은 구조선 n)`, host runs the all-dead check |
| `rescue:landed` | `target` 이 나면(싱글은 `'sp'`) 죽음 타이머 · 전멸 체크를 내리고 `deploying` 이면 `playing` 으로. 몸을 세우는 것은 `player/` 가 한다 (`rescueRevive` — 헬포드 · `RESCUE_REVIVE_HP` · 빈손) |
| `crate:looted` (`pcorpse:…`) | 그 시체를 `비어 있음` 으로 바꾸고 `corpse:playerEmptied` + `pcorpse emptied` 를 방송 (메시는 남는다) |
| `world:cleared` / `game:abort` / `game:newMission` | 시체 · 분대장 기기 전부 정리 + 지오메트리 dispose (`clearCorpses()`) |
| `player:downed` | **not a death**: phase unchanged, `ui:notify "쓰러짐 — 아군의 제세동기를 기다립니다"`, the all-dead check is re-armed (a squadmate may already be dead) |
| `player:revived` | stops the all-dead check when the local player is no longer dead |
| `game:abort` | multiplayer host **during a live raid** (gameplay / `deploying`, never a training): `flow abort` to others first (leaving a result screen is local — the mission is already over); closes inventory, `menu`. If the abort ended a *lobby* mission / result screen, emits `hub:enter {ship:'shared'}` one microtask later (no-op when HubSystem's own `hub:enter` already built the ship) |
| Escape (gameplay phase **or `hub`**) | **2026-09-09: `escapeKey()`** — `ctx.escape.closeTop()` 이 열려 있는 화면 중 맨 위 하나를 닫고, 스택이 비어 있을 때만 `escapePause()` 가 일시정지 메뉴를 연다 (see the 2026-09-09 section at the end). 메뉴는 여전히 Escape 로 닫히지 않는다 — 데스크톱 셸만 예외다. Two entry points reach that method because the browser splits the key: a real `Keys.MENU` press when a screen already freed the cursor, and `input:pointerLockLost` when the pointer was locked and the browser ate the keydown to free it. Blockers are **not** checked — the menu stacks over an open screen. `PauseMenu` emits `game:paused false` from its button. `freeze` is always false (2026-09-07): a raid is an extraction run, and stopping the clock with a keypress made Escape a save-scum button; the field stays on the wire because Engine and the HUD read it |
| `window` `blur` / `visibilitychange` → hidden | if gameplay phase, no blocker, player alive and not paused → emits `input:pointerLockLost` and pauses. **2026-09-07 (커서 rework): losing the pointer lock is no longer one of these triggers.** Releasing the lock is how every screen shows the mouse now, and Chrome drops it on any Escape, so treating a missing lock as "the player left" is exactly what made the game freeze whenever the Windows cursor appeared. Only losing the *window* means someone actually walked away |
| ~~lost-lock watchdog~~ (`checkLockLost`) | **deleted 2026-09-07.** It existed because Phase 10 screens kept the lock and a lock that went missing meant the software cursor had silently fallen back to mirroring the real OS one. With the rework there is no hybrid state to detect: no lock simply means the mouse is a cursor |
| ~~`Keys.CURSOR` (Alt) · Alt 커서~~ | **2026-09-10 제거 (사용자 결정).** 화면 없이 마우스만 풀던 기능(`toggleFreeCursor` · `onFreeCursorClick` · Escape 스택 항목 · `escapePause` 의 강제 해제)을 통째로 걷어냈다 — 커서는 이제 화면이 열릴 때만 나온다. `Keys.CURSOR` · `FREE_CURSOR_BLOCKER` · `ui:freeCursorToggled` 는 `src/shared` 계약이라 남았고 아무도 쓰지 않는다 |
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
  **2026-09-11 (C-70)**: 그리고 **사망 직후 한 번 더** — `parts/Death.onLocalDied` 의 멀티 가지가 `spawnLocalCorpse` **뒤에** `Session.saveRaid(sys)` 를 부른다.
  타이머 · 루팅만으로는 사망 순간이 blob 에 들어가지 않아, 죽고 나서 새로고침하면 **사망 전 가방**으로 복귀했다 — 장비가 시체에도 서 있고 가방에도 있는 **복제 경로**다.
  사망해도 페이즈는 그대로라 `isGameplayPhase()` 게이트를 통과하고 `rejoinPending` 가드는 그대로 존중한다.
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
- **2026-09-11 (C-70 — 죽는 순간 레이드는 끝났다, 사용자 결정)**: 세이브를 지우는 것이 `gameOver()` 뿐이면 그 앞의
  `DEATH_TO_SCREEN`(2.5초)이 그대로 **새로고침 부활 창**이었다 — 솔로 사망은 시체가 없으므로 그 안에 새로고침하면
  손실 0 으로 되살아났다. 이제 `parts/Death.onLocalDied` 의 솔로 가지가 `raidSaveTimer = -1` 로 주기 저장을 끄고
  `clearSoloRaid()` 를 **즉시** 부른다 (`gameOver()` 의 같은 호출은 멱등이라 그대로 둔다). 지운 파일이 그 창 안에
  되살아나지 않도록 저장 경로 둘에도 가드를 걸었다 — `parts/Session.saveRaid` 의 솔로 가지(`isDead && !isDowned` →
  저장하지 않는다; `inventory:itemAdded` · `crate:looted` 가 주로 온다)와 `GameFlowSystem.onPageHide`(`!isLocalOut()`,
  이 경로는 `saveRaid` 를 지나지 않는다). 부팅 결과는 **세이브 없음 + 로드아웃 `raidSeed` 표식 있음** →
  `soloRaidBootStatus` 가 `stale` → `game:abort` + `복귀가 너무 늦었습니다 — 레이드 실패` 다. **그게 맞는 결과다**(죽었으니까).
- **2026-09-11 (E-5 — 오프라인 방어 1–3, 사용자 결정)**: the grace no longer trusts the local clock blindly and the save key
  is no longer the only record of a running solo raid. At `init()` the file is judged by `soloRaidBootStatus(save,
  ctx.inventory.soloRaidSeed, now, readClockHigh())`:
  ① **clock record** `slotKey(SOLO_CLOCK_HIGH_KEY)` = the latest `Date.now()` seen (every solo save · every boot · `hub:entered`
  · every in-ship `inventory:loadoutSaved`); booting more than `SOLO_CLOCK_BACK_TOLERANCE_MS` (2 min, csv) before it → `stale`.
  A **new** solo raid (`onNewMission`, not a resume) resets it to now, so a clock that once ran far ahead cannot fail later runs.
  ② a save more than the tolerance **in the future** → `stale` (a few seconds of NTP step-back still resume).
  ③ the loadout's **`raidSeed` marker** (inventory writes it at a solo raid's `world:ready`, clears it at complete / over / abort):
  a marker without a save — the key was deleted — or with another seed → `stale`, i.e. 레이드 실패 and the carried kit is lost.
  To keep ③ from punishing a crash, the first snapshot is written at `world:ready` standing at the spawn (`Session.saveSoloAt`),
  `player:landed` overwrites it with the real pose, and a consumed resume writes the save straight back (original `savedAt`).
  Accepted hole (design §6-4): close → set the clock back → reopen inside 5 min without booting in between. Also still open
  offline: editing the loadout document itself (removing `raidSeed`) — measured in `smoke-raidflow`.
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
- **커서 숨김**: 셸에서 게임플레이 / 함선 페이즈이고 커서 소유자가 없으면 `<body>` 에
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
| 검증 | `scripts/smoke-resume-gate.mjs` §8 (닫기 · LIFO · 게이트) · §9 (셸에서 메뉴 닫기), `scripts/smoke-controls-hub.mjs` (가방 · Alt 가 커서를 풀지 않는다 — 2026-09-10), `scripts/smoke-raidflow.mjs`, `scripts/smoke-ui-p6.mjs` (키 가이드) |

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

## 준비물의 레이드 경계 (A-13, 2026-09-11)

준비물의 규칙 · 저장은 progression 이 갖고, 이 폴더는 **레이드의 시작과 끝 두 지점**만 맡는다.

| 시점 | 호출 | 자리 |
|---|---|---|
| 출격 | `ctx.progression?.armPreps()` | `parts/Phases.onNewMission` (훈련장 제외) |
| 탈출 | `clearActivePreps()` | `parts/Death.complete` |
| 전멸 · 실패 | `clearActivePreps()` | `parts/Death.gameOver` |
| 포기 · `game:abort` | `clearActivePreps()` | `parts/Phases.onAbort` |

- **사망만으로는 비우지 않는다** — 「이미 마신 약」이다 (사용자 결정). 장비와 달리 시체로 가지 않고, 구조선으로
  되살아나도 그대로 남는다.
- 재접속 · 솔로 이어하기도 `game:newMission` 을 지나가지만 그때 대기분(`PlayerProfile.prep`)은 비어 있으므로
  `armPreps()` 가 **아무것도 하지 않고** 이미 실린 `prepActive` 를 그대로 둔다 — 돌아온 사람이 준비물을 조용히
  잃지 않는 자리다 (2026-09-10 규약). 레이드 blob 은 인벤토리만 담으므로 이 값을 건드리지 않는다.
- 훈련장에서는 아예 싣지 않는다 (환경이 없고, 나갈 때 `game:abort` 가 어차피 비운다).

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-12 (아이템 회수 계약 — 시체 와이어의 표식)** — `Corpses.itemsToWire` 가 `ItemInstance.raidFound` 를 `CorpseItemWire.rf` 로 싣고
  `parts/CorpseNet.itemsFromWire` 가 되살린다(생략 = 표식 없음). 사망자가 레이드에서 주운 계약 아이템은 시체에서 꺼낸 분대원에게도 세어지고,
  함선에서 가져간 장비는 표식이 없으니 세어지지 않는다. 정산 순서(`Death.complete` / `gameOver` 의 `awardMissionXp` → `game:complete` /
  `game:over`)는 그대로 — inventory 가 그 이벤트에서 표식을 지운다.

- **2026-09-11 (A-13 준비물 레이드 경계, 에이전트 prep)** — 계약은 읽기만 했다 (`ProgressionRef.armPreps` ·
  `clearActivePreps`). `parts/Phases.onNewMission` · `onAbort`, `parts/Death.complete` · `gameOver` 에 한 줄씩.
  위 *준비물의 레이드 경계* 절이 전부다.

- **2026-09-11 (C-70 — 사망 직후 새로고침이 사망 전 blob 으로 복귀하던 틈, 에이전트 c70)** — 레이드 세션 저장이
  `RAID_SAVE_INTERVAL_S` 타이머와 루팅에서만 올라가서 **사망의 순간이 세이브에 없었다.** 멀티는 `stripForCorpse()` 로
  비워진 가방이 blob 에 반영되지 않아 시체 ↔ 가방 **복제**가 열려 있었고, 솔로는 세이브를 지우는 `gameOver()` 가
  `DEATH_TO_SCREEN`(2.5초) 뒤라 그 창 안에 새로고침하면 **손실 0 으로 되살아났다**. 세 곳을 고쳤다:
  - `parts/Death.onLocalDied` **멀티 가지** — `Corpse.spawnLocalCorpse(sys)` **직후** `Session.saveRaid(sys)` 1회.
    순서가 곧 근거다 — `captureRaidState()` 가 **이미 빈 가방**을 찍어야 한다. `GameFlowSystem.saveRaid` 는 `private`
    이라 같은 `parts/` 인 `Session` 을 직접 부른다(`Session` 은 `Death` 를 모르므로 순환 import 는 없다).
    사망해도 페이즈는 유지되므로 `saveRaid` 의 `isGameplayPhase()` 를 통과하고 `rejoinPending` 가드는 그대로다.
  - `parts/Death.onLocalDied` **솔로 가지** — `raidSaveTimer = -1` + `clearSoloRaid()` **즉시**(죽는 순간 레이드는
    끝났다, 사용자 결정). `gameOver()` 의 `clearSoloRaid()` 는 멱등이라 그대로 뒀다.
  - `parts/Session.saveRaid` **솔로 경로 가드** — `isDead && !isDowned` 면 아무것도 쓰지 않는다. 2.5초 창 안에 오는
    `inventory:itemAdded` · `crate:looted` 가 방금 지운 파일을 되살리는 것을 막는다. **멀티에는 걸지 않는다.**
    같은 이유로 `GameFlowSystem.onPageHide`(`saveRaid` 를 지나지 않는 유일한 솔로 저장 경로)에도 `!isLocalOut()` 을 걸었다.
  검증: `npm run typecheck` 통과. 스모크는 리드가 `smoke-raidflow` 로 한 번에 돌린다.

- **2026-09-11 (C-63 — 원격 시체가 전차 후미에서 전차를 놓치던 틈, 에이전트 c63)** — 계약 `PlayerCorpseWire.ride?`
  (리드 커밋 `ef6b825`)를 `Corpses.ts` 가 채운다. **보내는 쪽**: `PlayerCorpseObject.rideWire()` 가 지금 탄 발판이 어느
  전차인지 찾아(`tramOfCarrier` — 부품의 `box.yaw` 가 `TramDef.yaw` 와 같은 값이다) `{tram, local, yaw}` 를 만들고
  `toWire()` 가 붙인다 — 죽은 본인의 `spawn` 과 호스트의 `sync` 둘 다 **그 순간의 탑승 상태**다(타지 않았으면 생략).
  **받는 쪽**: `boardFromWire()` 가 `p` 대신 **내 전차의 지금 변환**으로 로컬 좌표를 풀어 자리 · yaw 를 잡고 그대로 탑승
  상태로 시작한다(모르는 전차 id · 그 자리에 발판이 없으면 false → 예전 `boardCarrier` 경로). 보간 지연(≈1 m)만큼 뒤진
  `p` 로는 후미 끝의 시체가 전차 밖으로 판정되던 것이 그것이다. `PlayerCorpseManager` 는 같은 `pcorpse` 메시지를 **따로
  구독해**(`hookNet`, `inventory/parts/CorpseLoot` 와 같은 모양) `ride` 만 받아 둔다 — `add` 를 부르는 `parts/CorpseNet`
  은 위치 · yaw 만 넘기기 때문이고, 핸들러 순서와 무관하게 맞는다(먼저 들으면 `pendingRide` 에 적어 `add` 가 쓰고,
  시체가 먼저 섰으면 그 자리에서 다시 태운다 — 같은 전차 · 같은 로컬 좌표면 결과가 `followCarrier` 와 같아 재적용이
  안전하다). `clear()` 가 `pendingRide` 도 비운다. 검사: `scripts/smoke-tram-ride.mjs` 6번(와이어에 ride 가 실린다 ·
  두 순서 모두 후미 로컬 −5.60 에 탄다 · 달리는 전차를 따라간다) 26/26, `smoke-raidflow` 81/81.
  ↳ 더 단순한 대안은 `parts/CorpseNet.applyCorpseWire` 가 `w.ride` 를 `add` 에 넘기는 두 줄이다 — 이번에는 그 파일이
  다른 세션의 작업 구역이라 건드리지 않았다.

- **2026-09-11 (E-5 솔로 레이드 시계, 에이전트 ③)** — 위 `2026-09-07: 레이드 접속 끊김 처리` 절의 E-5 항목. `SoloRaid.ts`:
  `soloRaidStatus(save, now, clockHigh)` (미래 · 역행 → stale) · 새 `soloRaidBootStatus` (로드아웃 `raidSeed` 표식) · `readClockHigh` ·
  `bumpClockHigh(now, reset)` · `saveSoloRaid` 가 시계를 올린다. `GameFlowSystem.init` 이 새 판정 + 부팅 기록, `player:landed` 에서
  솔로 스냅샷 즉시 저장, `hub:entered` · 함선 `inventory:loadoutSaved` 시계 기록. `parts/Phases`: 새 솔로 레이드면 시계 리셋 +
  `world:ready` 에 스폰 자세로 첫 스냅샷. `parts/Session`: `saveSoloAt`, 복귀 소비 때 저장 되쓰기. 검증 `smoke-raidflow` E-5 7 단언 (81/81).

- **2026-09-11 (C-61 — 가방 레이드 소모 표시의 영속화, 에이전트 c6061)** — 코드 변경은 `inventory/` 에 있고 여기는 **주석 한 곳**
  (`SoloRaid.ts` 의 `SoloRaidSave.inventory`)뿐이다. `InventoryRef.captureRaidState()` 가 돌려주는 blob 에 그 레이드에서 가방이
  이미 닳았다는 표시(`bagWorn` = 미션 시드)가 실리므로, 멀티 복귀(`RaidSessionBlob.inventory`)와 솔로 복귀(`scav.soloraid` 의
  `inventory` — 이 파일은 blob 을 그대로 통과시킨다)가 **둘 다** 그것을 되살린다. 사망으로 깎인 뒤 새로고침 → 복귀 → 자기 가방을
  되찾아 탈출해도 한 번이다. 복원 순서는 `world:ready`(인벤토리가 표시를 내린다) → `parts/Phases.onWorldReady` 의
  `applyRaidState`(표시를 되살린다)이고, 등록 순서(inventory → game)가 그것을 보장한다. 검증 `smoke-raidflow` 84/84 (C-61 3).

- **2026-09-11 (C-59 — 레이드 중 추방 문구, 에이전트 ④)** — `parts/Wire.onLobbyLeft` 의 `kicked` 가 "분대에서 분리되었습니다" 하나였다.
  C-29 뒤로 `kicked` 는 서버 콘솔 추방과 같은 캐릭터의 다른 창(`duplicate`) 두 갈래라, net 이 `net:lobbyLeft` **전에** 세우는
  `ctx.net.link.refused`(B-1)로 가른다: `서버에서 추방되었습니다 — 함선으로 복귀` / `다른 창에서 같은 캐릭터로 접속했습니다 — 함선으로 복귀`.
  `server_full` 로 끊긴 재접속(`'disconnected'`)은 `서버 접속 인원이 가득 찼습니다 — 함선으로 복귀`. 흐름(토스트 → `DISCONNECT_ABORT_DELAY`
  뒤 abort)은 그대로.

- **2026-09-11 (C-12 후속 — 솔로 사망도 임플란트를 잃는다, 사용자 결정 · 리드)** — `parts/Death.onLocalDied` 의 솔로 가지가
  `ctx.progression.stripImplantsForCorpse()` 를 부르고 돌려받은 망가진 짝을 **버린다**. 분대 사망은 짝이 시체로 가지만 솔로에는
  되찾으러 갈 시체가 없으므로 장비 · 가방과 똑같이 완전히 잃는다(즉시 저장 — 사망 직후 새로고침으로 되돌릴 수 없다). 훈련장은
  그 앞 가지에서 끝나므로 해당 없다. 검증: `smoke-raidflow` 가 솔로 레이드에서 `player:died` → 장착 0 · 시체 없음 · 창고에 짝 없음 ·
  저장된 프로필 `implants: []` (74 checks).

- **2026-09-11 (C 항목 배치 — 시체 kind · 전차 위 시체 · 사망 임플란트 흐름)** — 계약은 읽기만 했다
  (`Interactable.kind`, `@/shared` 의 `ride.ts`, `WorldRef.getSurfaceY` · `getStandingObstacle`).
  - **C-4** `PlayerCorpseObject.kind = 'playerCorpse'`.
  - **C-18** 달리는 전차 위에서 죽은 시체가 허공에 남던 것 → 전차에 실려 간다 (`Corpses.ts` 행). 시체 높이는 발 높이에서 올라설 수
    있는 표면(`getSurfaceY`)이다 — 지형만 보면 데크 · 2층 바닥 밑으로 떨어졌다.
  - **C-12 흐름 확인** `spawnLocalCorpse` → `inventory.stripForCorpse()` 한 번이 장비 · 가방 · 퀵슬롯 + 임플란트 망가진 짝을 모두 준다.
    game/ 은 바뀐 것이 없다. 솔로 레이드 사망은 여전히 시체가 없다(즉시 레이드 실패) — 그 경로에서는 임플란트가 몸에 남는다.
  - 검증: `smoke-raidflow` **71** (+12 — 사망 임플란트 7 · C-4 정찰 kind 1 · 전차 위 시체 · 플레이어 탑승 회귀 등).

- **2026-09-10 (Alt 커서 제거, 사용자 결정)** — `Keys.CURSOR`(Alt) 폴링 · `toggleFreeCursor` · `onFreeCursorClick`
  (캔버스 좌클릭 복귀) · ESC 스택 항목 · `escapePause` 의 강제 해제 · 사망/페이즈 전환 시 해제를 전부 걷어냈다.
  커서는 화면이 열릴 때만 나온다. `Keys.CURSOR` · `FREE_CURSOR_BLOCKER` · `ui:freeCursorToggled` 는 `src/shared`
  계약이라 남았고 아무도 쓰지 않는다 (`KEY_ACTION_DEFS` 에서 줄이 빠져 설정 화면에도 없다). 위 2026-09-08 ·
  2026-09-09 절의 Alt 커서 서술은 그 당시 기록이다

- **2026-09-09 (사망 · 시체 · 분대장)** — **자동 부활 제거**(30초 카운트다운 · `game:respawnAvailable` 발행/구독을
  끊었다 — 계약은 남는다), 새 `Corpses.ts` 가 `ctx.corpses` 를 게시하고 완전히 사망한 플레이어의 **시체**를
  레이드가 끝날 때까지 세워 둔다(절차 생성 `SoldierModel`, `Interactable` `pcorpse:<owner>:<n>`,
  루팅은 `openContainerItemsSized` + 기존 `cont` 경로), 새 `parts/CorpseNet.ts` 가 `pcorpse` / `pcorpseq` 와
  호스트 late-join sync 를, 새 `parts/Leader.ts` 가 **분대장 기기**(3초 홀드 회수 · `reportHostDown` ·
  `transferHost(me, true)`)와 `net:hostChanged` 토스트를 맡는다. `rescue:landed` 로 부활 흐름을 정리한다.

### 알려진 한계 (2026-09-09)
- `Corpses.ts` 가 `@/player` 의 `SoldierModel` 을 import 한다 — **폴더 간 import 금지 규약의 의도적 예외**다
  (병사 모델을 두 번 만들지 않기 위해서). 역방향 의존은 없으므로 순환은 생기지 않는다.
- ~~**임플란트 아이템은 시체로 가지 않는다.**~~ → **2026-09-11 (C-12) 해소**: `ProgressionRef.stripImplantsForCorpse()` 가
  함선 게이트 없이 전부 해제하고, `InventoryRef.stripForCorpse` 가 그 **망가진 짝**을 시체 목록에 합친다 (작동하는 인스턴스는 사라진다).

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
