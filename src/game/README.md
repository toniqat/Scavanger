# src/game — Mission flow (`GameFlowSystem`)

Owns the mission phase state machine, pause and Escape policy, the threat ramp, death / corpses / squad wipe, the
squad-leader device, raid session save and resume (relay blob for squads, localStorage for solo raids and the
tutorial), the mission-end payout and the result-screen data. Publishes `ctx.phase` (through `ctx.setPhase()`, which
emits `game:phaseChanged`) and `ctx.corpses`. Registered last in `main.ts`. The ship phases `hub` / `docking` belong
to `hub/HubSystem`. Import via `@/game` → `GameFlowSystem`.

## Files

| File | Responsibility |
|---|---|
| `GameFlowSystem.ts` | `GameSystem` (`name: 'gameflow'`): event subscriptions, timers, per-frame `update`, one-line delegates into `parts/`. Re-exports `model.ts`. |
| `model.ts` | Folder vocabulary: `LIFTOFF_TO_COMPLETE` (= `EXTRACTION_LIFTOFF_TO_COMPLETE_S`), `DEATH_TO_SCREEN`, `MISSION_FAILS_WHEN_ALL_DEAD`, threat ramp constants, mission XP terms (`XP_PER_KILL`, `XP_EXTRACT_BONUS`, …). No state, no class references. |
| `parts/Phases.ts` | Phase transitions, pause, Escape (`escapeKey` / `escapePause`), focus loss, `onNewMission` / `onWorldReady` / `onGameStarting`, training exit, `onAbort`, mode predicates (`isTraining`, `isTutorial`, `inShip`, `inMission`, `inLiveMission`). |
| `parts/Death.ts` | Local death / downed / revived, rescue landing, all-dead check, `complete()` / `gameOver()`, voluntary return to ship, tutorial respawn and tutorial skip-extraction, `awardMissionXp`. |
| `parts/Session.ts` | Raid session save and resume: relay blob (`isRaidSession`), solo localStorage (`isSoloRaid`, `saveSolo`, `saveSoloAt`, `consumeStoredSoloRaid`, `resumeSoloRaid`), ghost restore + timeout fallback, tutorial step / checkpoint saves. |
| `parts/Wire.ts` | `flow` message handling, host change, lobby left (disconnect / kick / host left → abort after `DISCONNECT_ABORT_DELAY`). |
| `parts/CorpseNet.ts` | Player corpse creation and sync (`pcorpse` / `pcorpseq`), `spawnLocalCorpse`, `crate:looted` → `emptied`. |
| `parts/Leader.ts` | Squad-leader device (`leader_device` interactable, `lead` / `leadq` wire), its scene-resident point light, the single host-changed toast. |
| `parts/RaidReport.ts` | Result-screen data (`GameFlowSystem.report`): peak carried value, damage tallies per source, killing blow → `stats.peakLootValue` / `stats.death`. |
| `parts/LoadGate.ts` | Raid-entry loading gate (`GameFlowSystem.loadGate`): render hold from `game:newMission` to squad-wide readiness, `load` wire, `raid:loadProgress` / `raid:loadReleased`, fade-in. Debug hooks `debugAddMember` / `debugClearMembers` / `debugSetTimeout`. |
| `Corpses.ts` | `PlayerCorpseManager` (= `ctx.corpses`, implements `CorpsesRef`) and `PlayerCorpseObject` (interactable container + frozen `SoldierModel` mesh, tram riding). |
| `SoloRaid.ts` | Pure localStorage store for solo sessions: `SoloRaidSave` / `SoloRaidPose`, `load/save/clearSoloRaid`, `soloRaidStatus`, `soloRaidBootStatus`, clock record `readClockHigh` / `bumpClockHigh`. No context, no listeners. |
| `ResumeGate.ts` | Browser-only `좌측 클릭으로 게임 재개` overlay (`ResumeGate`), desktop-shell cursor hiding (`syncDesktopCursor`), shell Escape re-lock hook (`installDesktopRelockHook` → `window.__scavShellRelock`). |
| `resume-gate.css` | Gate styles + `body.desktop-nocursor`. Imported by `ResumeGate.ts`. |
| `index.ts` | Barrel. |

## Public API

- **ctx**: `ctx.phase` (via `setPhase`), `ctx.corpses: CorpsesRef` (`src/shared/types.ts`, incl. `spawnAllyCorpse`). Also writes `ctx.stats`,
  `ctx.missionTime` (reset only — `Engine.frame()` advances it), `ctx.missionMode`, `ctx.missionPlanet`,
  `ctx.missionIntel` (cleared for training), `ctx.rejoinPending`.
- **Emits**: `game:phaseChanged`, `game:paused {paused, freeze:false}`, `game:complete {stats}`,
  `game:raidFailed {stats}`, `game:over {stats}`, `game:abort`, `game:newMission` (solo resume), `hub:enter`,
  `player:respawn` (training / tutorial), `input:pointerLockLost` (focus loss), `corpse:playerSpawned`,
  `corpse:playerEmptied`, `leader:deviceDropped`, `leader:deviceTaken`, `ui:resumeGate {shown}`, `ui:notify`,
  `raid:loadProgress` / `raid:loadReleased`, `ui:screenFade` (loading gate only).
- **Consumes**: `game:newMission`, `world:ready`, `world:cleared`, `player:landed`, `player:died`, `player:downed`,
  `player:revived`, `player:spawned`, `extraction:activated` / `shipLanded` / `boarded` / `liftoff {aboard, squadDone}` /
  `reset`, `rescue:landed`, `crate:looted`, `game:returnToShip`, `game:abort`, `game:paused`, `training:exitRequested`,
  `inventory:itemAdded`, `inventory:loadoutSaved`, `hub:entered`, `tutorial:changed`, `tutorial:checkpoint`,
  `input:pointerLockLost`, `net:remoteDied` / `peerLeft` / `peerSuspended` / `lobbyLeft` / `reconnecting` / `resumed` /
  `raidLoaded` / `gameStarting` / `ghostRestore` / `hostChanged`, `raid:loadBegin`. `RaidReport` also listens to
  `player:damaged`, `inventory:changed`, `inventory:quickSlotsChanged`, `inventory:pouchChanged`, `loadout:changed`.
- **Wire** (`src/shared/net.ts`): `flow` (`over` · `complete` · `abort` from the host; `rejoined` from a rejoiner),
  `pcorpse` (`spawn` · `sync` · `emptied`) / `pcorpseq sync`, `lead` (`drop` · `taken`) / `leadq sync`,
  `load` (`p` from everyone, `go` from the host). Clients drop `flow` / `load go` not sent by `lobby.hostId`.
- **Calls out**: `InventoryRef.stripForCorpse` / `captureRaidState` / `applyRaidState`, `PlayerRef.die` /
  `restoreState` / `teleport` / `playIntroWake`, `ProgressionRef.addXp` / `armPreps` / `clearActivePreps` /
  `stripImplantsForCorpse`, `MetaRef.settleMission`, `NetRef.saveRaid` / `leaveMission` / `transferHost` /
  `reportHostDown`, `ctx.world.tutorial.respawnPose` / `gotoCheckpoint`, `ctx.escape.closeTop`.

## Phases and transitions

`menu → deploying → playing → extracting → shipLanded → liftoff → complete`, or `dead`. Training and tutorial skip
`deploying` (no hellpod, so `player:landed` never arrives).

| Trigger | Action |
|---|---|
| `game:newMission {seed, mode?, planet?}` | Reset timers and stats (`freshStats`), confirm `missionMode` / `missionPlanet`, `armPreps()` (not training), training inventory snapshot, then `onWorldReady` once `world:ready` has fired (also checked synchronously — `WorldSystem` generates inside the same emit). |
| `game:newMission` (raid, not a rejoin) | `parts/LoadGate` takes a render hold (see **Raid-entry loading**): the phase flow below still runs, but with sim dt 0 behind a black screen. |
| `world:ready` | Phase `deploying` (or `playing` for training / tutorial). Rejoin: apply blob with matching seed, then host `ghost restore` (timeout `NET_GHOST_RESTORE_TIMEOUT_S` → hellpod fallback) or the solo pose + tutorial checkpoint directly. |
| `player:landed` | `deploying` → `playing`; solo raid saves the real pose. |
| `extraction:activated` / `shipLanded` | `playing` → `extracting` → `shipLanded`. |
| `extraction:liftoff {aboard, squadDone}` | Aboard or squad done → `liftoff`, `complete()` after `LIFTOFF_TO_COMPLETE`. Neither → left behind, the raid goes on. Tutorial skip-extraction completes immediately. |
| `extraction:reset` | Ship left without this player → back to `playing` (unless a result timer runs). |
| `player:died` | See Death. |
| `player:downed` | Not a death: phase unchanged, all-dead check re-armed. |
| `game:returnToShip` | Voluntary return (see Death). Outside a live raid → `hub:enter` directly. |
| `game:abort` | `onAbort`: host in a live, non-training mission sends `flow abort` (not on voluntary return); clears timers, solo save, active preps; closes inventory; phase `menu`; docked-lobby mission (`isDockedLobby`) → `hub:enter shared` one microtask later. |
| `net:resumed {seamless:false}` / `net:lobbyLeft` | Abort and regroup (`shared`), or toast + abort after `DISCONNECT_ABORT_DELAY` → personal ship. `net:reconnecting` never aborts. |

## Raid-entry loading (`parts/LoadGate`)

The gate is a **render hold** (`ctx.shaders.holdFor`): sim dt is 0 and nothing is drawn, so the mission clock, enemy
spawning, the hellpod drop and the phase flow all wait without any per-system gate. Every timer inside the gate
therefore uses `ctx.time`, never `dt`.

1. `hub/` ends the launch countdown with `ui:screenFade {1, RAID_LOAD_FADE_OUT_S, hold:true}` + `raid:loadBegin`, and the
   authority launches `RAID_LOAD_FADE_OUT_S` later. Without that `raid:loadBegin` the gate blacks the screen itself
   (`{1, 0, hold:true}`), so a cheat / legacy launch never starts bright.
2. `begin()` on `game:newMission` for `missionMode === 'raid'` only, and never for a rejoin (`ctx.rejoinPending` /
   `rejoining`). Hold cap = `RAID_LOAD_TIMEOUT_S + RAID_LOAD_HOLD_MARGIN_S`.
3. Local progress = `RAID_LOAD_WORLD_SHARE` (world generated) + the rest × `ctx.shaders.compileProgress`; local **done**
   = the scene warm-up resolved (the gate's `holdForScene()` coalesces with the one `core/Engine` already queued) and
   `RAID_LOAD_MIN_BLACK_S` of black has passed.
4. Multiplayer: `load {ev:'p', seed, v}` to `others` every `RAID_LOAD_REPORT_S` and once at 1. The host counts the
   lobby's **humans** only (`humanPlayersOf`, connected, `inMission !== false`) and sends `load {ev:'go', seed, to?}`
   when everyone reported 1 or at `RAID_LOAD_TIMEOUT_S`. A client releases on `go` **and** its own done (a late one the
   moment it finishes); `go` is accepted only from `lobby.hostId`, and a client whose `go` never arrives releases itself
   at timeout + `RAID_LOAD_HOLD_MARGIN_S`. A promoted host continues the same timeout (host is read per frame).
5. `raid:loadProgress {local, squad, waiting, remainingS}` a few times per second (`ui/` draws the radial gauge).
   Release: resolve the hold → `ui:screenFade {0, RAID_LOAD_FADE_IN_S}` → `raid:loadReleased {timedOut}`.
   `game:abort` or a new `game:newMission` during the gate releases it quietly (no fade, no event).

## Death, rescue, wipe

- **Solo raid**: implants stripped with no broken pair, periodic save off, `clearSoloRaid()` immediately, `gameOver()`
  after `DEATH_TO_SCREEN`.
- **Squad**: phase unchanged, `spawnLocalCorpse` (whole inventory into the corpse), then one forced `Session.saveRaid`,
  squad-leader device if host, toast with remaining rescues. The only way back is a squadmate's rescue drop
  (`rescue:landed` → `onRescueLanded`; `player/` rebuilds the body).
- **All-dead check** (host only, never training): local player out (`isDead && !isDowned`) and no remote alive per
  `isRemoteAlive` (ignores androids by `isAndroidId`, `!connected`, `!inMission`, `IN_HUB`; suspended ghosts count by
  `ghostState !== 2`; downed counts alive). Runs on death / downed / peer events, every `ALL_DEAD_CHECK_INTERVAL` while
  out, and on becoming host. True → `flow over` + `gameOver()`.
- **Androids** (2026-09-15): bot members are never humans — a leader who dies with only androids left is still a squad
  wipe. A dead android leaves its own corpse through `CorpsesRef.spawnAllyCorpse` (authority only): container
  `pcorpse:<allyId>:<n>` with the items `allies/` hands over (raid-found only — the base kit is bound), broadcast as a
  normal `pcorpse spawn`. The body's android look and the `잔해` prompt are decided by the owner id, so receivers build
  the same thing with no extra wire field.
- **Training**: death → immediate `player:respawn` at the arena spawn; no XP, settlement, threat or result screens.
  `training:exitRequested` → abort, restore inventory snapshot, `leaveMission`, back to the ship.
- **Tutorial** (`missionMode === 'tutorial'`): corpse still spawns, implants untouched, no forced save, save kept,
  respawn after `TUTORIAL_RESPAWN_DELAY_S` at `ctx.world.tutorial.respawnPose()` with a respawn wake animation
  (`TUTORIAL_RESPAWN_WAKE_S`). No raid failure.
- **Voluntary return** (`함선으로 귀환`): `returnPending` → `PlayerRef.die()` → normal death cleanup → after
  `DEATH_TO_SCREEN` `finishReturnToShip`: solo `gameOver()`, squad settles this player + `leaveMission()`; then `hub:enter`.
- `gameOver()` = raid failure: `game:raidFailed` → phase `dead` → `game:over`, auto `hub:enter` after
  `RAID_FAILED_AUTO_RETURN_S`. `complete()` and `gameOver()` are idempotent.

## Payout

`awardMissionXp()` runs once per mission (`rewarded`) inside `complete()` / `gameOver()` before the phase change, wrapped
in try/catch. Normal raid: kills × `XP_PER_KILL` (× `XP_DEATH_MUL` if not extracted) + minutes × `XP_PER_MINUTE`
(cap `XP_TIME_CAP`) + on extraction `XP_EXTRACT_BONUS` + loot × `XP_PER_LOOT_VALUE`, times the library `raidXp`
multiplier; then contract settlement (`settleMission`) adds its XP. Tutorial: `TUTORIAL_RAID_XP` if extracted, else 0,
never a contract settlement. Training: nothing. Bumps `profile.raids` / `extractions` and saves. Result screens read
`stats.rewards`.

`RaidReport.fill()` runs before settlement in both wrappers: `stats.peakLootValue` = highest carried value (bag, quick
slots, pouch + equipped loadout and attachments) during the raid; `stats.death` = killing blow from `player:died.source`
(else the last damage source; none on voluntary return) with the damage that source dealt.

## Raid sessions

- **Squad** (`isRaidSession`: multiplayer + `raid`): `RaidSessionBlob` via `ctx.net.saveRaid` every
  `RAID_SAVE_INTERVAL_S` and on `inventory:itemAdded` / `crate:looted`; skipped while `rejoinPending`. Rejoin sets
  `ctx.rejoinPending` on `net:gameStarting {rejoin}` so the player skips the hellpod.
- **Solo** (`isSoloRaid`: single-player `raid` or `tutorial`; training excluded): localStorage `scav.soloraid`
  (`SOLO_RAID_STORAGE_KEY`), same cadence + `pagehide` flush. Stores seed, planet, intel picks, `mode`, tutorial
  `checkpoint`, clock, stats, inventory blob, pose (on a rover: `roverSafePosition`). Boot reads it in `init`, the first
  `update` resumes (`resumeSoloRaid`) or fails it (`game:abort` + `복귀가 너무 늦었습니다 — 레이드 실패`).
- **Solo clock defence** (`soloRaidBootStatus`): stale when older than `SOLO_RAID_GRACE_MS`, from the future or before
  the clock record by more than `SOLO_CLOCK_BACK_TOLERANCE_MS`, or when the loadout `raidSeed` marker has no matching
  save. First snapshot is written at `world:ready` (`saveSoloAt` at the spawn) so a reload during the drop resumes.
- **Tutorial saves** are always `fresh` (no grace, no clock defence; the `raidSeed` check still applies). Forced saves
  on every real step change (`saveTutorialStep`, deduped by `lastTutorialStep`) and every checkpoint.
  Resume always stands alive and calls `gotoCheckpoint`.

## Escape, pause, cursor

- `escapeKey()` (only caller: the `Keys.MENU` poll in `update`): `ctx.escape.closeTop()`; if nothing closed →
  `escapePause()`. A locked-pointer Escape arrives as `input:pointerLockLost` → `escapePause()` directly.
- `escapePause()` opens the pause menu only (gameplay phase or `hub`, alive, not already paused). `freeze` is always
  false — the world keeps running. Closing is `게임으로 돌아가기`, or Escape in the desktop shell (`ui/menus/PauseMenu`).
- Window `blur` / hidden tab in a gameplay phase with no screen open pauses; a lost pointer lock alone does not.
- `ResumeGate` shows in the browser only, once the session had a lock, when no cursor owner, no lock,
  `input.awaitingLockGesture` and not `input.relockScheduled`; hides as soon as the lock returns. Its blocker
  (`RESUME_GATE_BLOCKER`) is transparent to `noScreenOpen`.

## Rules

- Force the squad death save **after** `spawnLocalCorpse` — the blob must capture the emptied bag, or reload duplicates
  gear. — `parts/Death.ts` (`onLocalDied`)
- Solo saves never run after death: `Session.saveRaid` and `GameFlowSystem.onPageHide` both check local death, or a
  reload revives the player. New solo save paths need the same guard. — `parts/Session.ts` (`saveRaid`)
- Tutorial death does not force a save: the solo save holds no corpse, so saving the empty bag would lose the gear. —
  `parts/Death.ts` (`onTutorialDied`)
- Voluntary return must not send `flow abort` or `hub:enter` directly from a live raid — `hub:enter` triggers
  `game:abort`, which ends the squad's mission when sent by the host. Use `game:returnToShip`. — `parts/Phases.ts` (`onAbort`)
- Leaving aboard while squadmates remain calls `leaveMission()` after `game:complete` and sends no `flow complete`. —
  `parts/Death.ts` (`complete`)
- `RaidReport.bind()` must subscribe before `player:died` → `onLocalDied`, to measure value before the corpse strip. —
  `GameFlowSystem.ts` (`init`)
- The leader-device light lives in the scene from `init` with intensity 0; never add/remove a light with the device. —
  `parts/Leader.ts` (`installLeaderLight`)
- `net:hostChanged` toast is shown only by `parts/Leader.ts` (`onHostChangedToast`).
- Corpse height uses `getSurfaceY` (tram decks, upper floors), and corpses stay until the raid ends (no lifetime or
  culling). — `parts/CorpseNet.ts`, `Corpses.ts`
- The loading gate must never read `dt`: the hold it takes makes sim dt 0, so its own timers would stop. Use `ctx.time`.
  For the same reason `LoadGate.bind()` subscribes before `onNewMission` — the hold has to exist before the phase moves.
  — `parts/LoadGate.ts`
- `parts/` import only types from `GameFlowSystem.ts`; values go to `model.ts`.
- `PLAYER_RESPAWN_DELAY`, `game:respawn`, `game:respawnAvailable`, `tickRespawn`, `onRespawnRequest` are kept contract
  stubs; nothing emits or handles automatic respawn.

## Notes

- `Corpses.ts` imports `SoldierModel` from `@/player` — a deliberate exception to the no-cross-folder-import rule, so the
  soldier model is not built twice. There is no reverse dependency, so no cycle.
- `kills`, `cratesOpened`, `damageTaken` are incremented by other systems; GameFlow only resets and finalizes stats.
- Threat ramp: `ctx.enemies.setThreatLevel()` goes `THREAT_MIN` → `THREAT_MAX` over `THREAT_RAMP_SECONDS` (not in training).
- Preparation items: armed at `onNewMission`, cleared at `complete` / `gameOver` / `onAbort`; death alone keeps them.

## Recent changes

Last 5 only — older: `git log -- src/game`.
- 2026-09-15 — `parts/LoadGate.ts`: raid-entry loading gate (`load` wire, `raid:load*`); androids excluded from the wipe check; `CorpsesRef.spawnAllyCorpse`.
- 2026-09-15 — Squads vs shared ship: training exit and `onAbort` regroup in the shared ship only for a **docked** lobby (`isDockedLobby`).
- 2026-09-15 — Tutorial resume: tutorial saves ignore grace / clock defence; forced save per step and per checkpoint.
- 2026-09-15 — Tutorial respawn plays a wake animation; tutorial skip-extraction completes immediately.
- 2026-09-15 — Tutorial payout: `TUTORIAL_RAID_XP` on extraction, otherwise 0; no contract settlement.
- 2026-09-15 — `parts/RaidReport.ts`: peak carried value and cause of death for result screens.
