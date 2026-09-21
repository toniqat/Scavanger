/**
 * src/game/parts/Phases.ts — **phase transitions and pause**.
 *
 * menu → hub → deploying → playing → extracting → shipLanded → liftoff → complete / dead → hub — the same
 * list as `model.ts`'s header and the folder README's. The pause **never freezes the
 * world** (2026-09-07) and comes up only when the window loses focus. The pause menu is always the one and only
 * screen, so it yields at once while another screen is open (Phase 12 — the fix for the two overlapping and
 * neither being closable).
 */
import type { GamePhase, MissionMode, PlanetId } from '@/shared';
import { GameContext as Ctx, RAID_SAVE_INTERVAL_S, NET_GHOST_RESTORE_TIMEOUT_S } from '@/shared';
import { RESUME_GATE_BLOCKER } from '@/shared';
/* 2026-09-15: squads · dock matching — only a docked squad has a shared ship */
import { isDockedLobby } from '@/shared';
import { clearSoloRaid } from '../SoloRaid';
import { bumpClockHigh } from '../SoloRaid';
import { saveSoloAt } from './Session';
import type { GameFlowSystem } from '../GameFlowSystem';

/** Mission running or its result screen showing (anything the hub / a disconnect has to abort first). */
export function inMission(sys: GameFlowSystem): boolean {
  const p = sys.ctx.phase;
  return sys.ctx.isGameplayPhase() || p === 'deploying' || p === 'complete' || p === 'dead';
  }

/** Live mission (not a result screen). */
export function inLiveMission(sys: GameFlowSystem): boolean {
  return sys.ctx.isGameplayPhase() || sys.ctx.phase === 'deploying';
  }

export function isTraining(sys: GameFlowSystem): boolean {
  return sys.ctx.missionMode === 'training';
  }

/**
 * 2026-09-14 (tutorial rework): is the hand-built tutorial planet the one being played. **Do not widen
 * `isTraining()`** — the training range has no rewards, no results screen and no contract settlement at all,
 * while the tutorial ends and settles like a normal raid. The one thing that splits here is 「사망이 실패가
 * 아니다」 (the checkpoint branch in `parts/Death`).
 */
export function isTutorial(sys: GameFlowSystem): boolean {
  return sys.ctx.missionMode === 'tutorial';
  }

/**
 * Phase 8: standing in the personal / shared ship. Esc pauses here too (the terminal is opened from the console,
 * not from Escape any more), but the pause is menu-only — `freeze` stays false so the ship keeps animating and
 * nothing mission-related (abort, stats, timers) happens.
 */
export function inShip(sys: GameFlowSystem): boolean {
  return sys.ctx.phase === 'hub';
  }

/**
 * Phase 12: no UI blocker besides the resume gate's own token. The gate is an overlay over a running game, not
 * a screen — Escape on it must open the pause menu and a window blur behind it must still pause.
 */
export function noScreenOpen(sys: GameFlowSystem): boolean {
  for (const t of sys.ctx.uiBlockers) if (t !== RESUME_GATE_BLOCKER) return false;
  return true;
  }

/* ── Pause / focus ───────────────────────────────────────────────────── */
/**
 * The player left the window (alt-tab, another app, a hidden tab). This is the **only** pause trigger besides
 * Escape since the 2026-09-07 cursor rework: a missing pointer lock means the mouse is being used as a cursor,
 * which is a normal in-game state now, while a missing window really is someone walking away.
 */
export function onFocusLost(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (sys.paused || !ctx.isGameplayPhase() || !sys.noScreenOpen()) return;
  if (ctx.player?.isDead ?? false) return;
  ctx.bus.emit('input:pointerLockLost', {});   // → escapePause() does the pausing
  }

/* ── Escape (2026-09-08 → 2026-09-09) ─────────────────
 *
 * **One Escape closes the topmost open screen. The pause menu opens only when there is no screen to close.**
 *
 * There are two ways in. While the pointer is locked, Escape never becomes a keydown — it only frees the
 * cursor — so `Input.onUserUnlock` reports it as `input:pointerLockLost`; once a screen is already using the
 * cursor, a real `Keys.MENU` keydown arrives instead. The first case is by definition one with no screen to
 * close, so it goes straight to `escapePause`; only the second passes through `escapeKey`.
 *
 * 2026-09-08 removed every screen's Escape-to-close and left Escape as the single key that opens the menu. The
 * reason was that Escape carries no user activation, so closing a screen with it got the re-lock refused and
 * left the cursor on screen. 2026-09-09 reverted it — a person who sees a cursor tries to close that window
 * with ESC, and what happens after the close now has an answer in both environments. The desktop shell has the
 * main process make an activation on every ESC key-up and takes the lock back by itself (`electron/main.ts` →
 * `__scavShellRelock`), and in the browser the `좌측 클릭으로 게임 재개` gate (`game/ResumeGate`) takes that one
 * click — the UI that was built for exactly this situation.
 *
 * The closing order is **the reverse of the opening order** (`ctx.escape`, `shared/escape`), not the system
 * registration order. The universal Tab close has each screen read the key in its own `update()`, so its order
 * is decided by the registration order in `main.ts`; ESC must close only the topmost one, which needs somewhere
 * that knows the opening order.
 *
 * The innermost popups (the amount picker · the right-click menu · the warning popup · settings · rebinding)
 * still swallow Escape in their own window capture handler, so `Input` never even records it. What this stack
 * handles is therefore only the layer below them, the **screens**.
 *
 * Closing the pause menu itself with ESC is desktop-shell only (`isDesktopShell()`). The menu does not use the
 * stack: its own window capture handler treats Escape exactly like Tab (`ui/menus/PauseMenu`) — it is always
 * the topmost one anyway, and that handler already carries the warning popup's Escape exception. In the browser
 * the `게임으로 돌아가기` click stays as it is; that click is also the gesture the browser demands before a
 * re-lock.
 */
/** One Escape: close the topmost screen, or open the pause menu when the stack is empty. */
export function escapeKey(sys: GameFlowSystem): void {
  if (sys.ctx.escape.closeTop()) return;
  escapePause(sys);
  }

/** Escape with no screen to close — it **only opens** the pause menu (closing is `게임으로 돌아가기`). */
export function escapePause(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (sys.paused) return;
  if (!(ctx.isGameplayPhase() || inShip(sys))) return;
  if (ctx.player?.isDead ?? false) return;
  sys.setPaused(true);
  }

/* ── Mission start / rejoin ──────────────────────────────────────────── */
/** NetSystem announces a session start right before its `game:newMission`; `rejoin` = re-entering a running mission. */
export function onGameStarting(sys: GameFlowSystem, rejoin: boolean, mode: MissionMode | undefined): void {
  const ctx = sys.ctx;
  sys.rejoining = rejoin && mode !== 'training';
  // The player must not hellpod-drop on `world:ready`: the host hands our body back with `ghost restore`.
  ctx.rejoinPending = sys.rejoining;
  if (sys.rejoining && !sys.raidBlob && ctx.net?.raidBlob) sys.raidBlob = ctx.net.raidBlob;
  }

export function onNewMission(sys: GameFlowSystem, seed: number, mode: MissionMode | undefined, planet?: PlanetId | null): void {
  const ctx = sys.ctx;
  // The emitter (hub / net) sets `ctx.missionMode` before emitting; re-confirm from the event, else from the generated world.
  ctx.missionMode = mode ?? ctx.world?.mode ?? 'raid';
  /*
   * Phase 11: same contract for the target planet — the emitter sets `ctx.missionPlanet` first, this only
   * re-confirms it.
   * A training has no planet; an emit without the field (an older path) keeps whatever the ship last flew to rather
   * than silently rerolling. (2026-09-15: `MissionComplete`'s `다시 배치` — the one emitter that re-used a seed
   * — is gone.)
   */
  ctx.missionPlanet = sys.isTraining() ? null : (planet ?? ctx.missionPlanet);
  // 2026-09-14 (the intel broker): same contract — the training range has no fixed gimmicks. A raid's value was
  // already set by the emitter (it is not overwritten here).
  if (sys.isTraining()) ctx.missionIntel = null;
  sys.setPaused(false);
  sys.completeTimer = -1;
  sys.deathTimer = -1; sys.respawnTimer = -1; sys.respawnLastSec = -1;
  sys.tutorialRespawnTimer = -1;   // 2026-09-14
  sys.lastTutorialStep = null;     // 2026-09-15: new mission — clear the dedupe key of the per-step autosave
  sys.lastThreat = -1;
  sys.boarded = false;
  sys.aboardAtLiftoff = false; sys.squadExtraction = false;   // 2026-09-13 extraction rework
  sys.allDeadCheckTimer = -1;
  sys.disconnectAbortTimer = -1;
  sys.autoReturnTimer = -1;
  sys.restoreTimer = -1;
  sys.rewarded = false;
  ctx.stats = Ctx.freshStats(seed);
  ctx.stats.mode = ctx.missionMode;
  ctx.missionTime = 0;
  ctx.uiBlockers.delete('menu');
  if (!sys.rejoining) ctx.rejoinPending = false;
  // Training range: remember the inventory so ammo / durability spent on the range are refunded on exit.
  sys.trainingSnapshot = sys.isTraining() ? (ctx.inventory?.captureRaidState() ?? null) : null;
  sys.raidSaveTimer = (sys.isRaidSession() || sys.isSoloRaid()) ? RAID_SAVE_INTERVAL_S : -1;
  // 2026-09-11 (E-5 ①): a **new** solo raid restarts the clock record at "now" — a clock that once ran far ahead must not
  // fail every later resume. A stored run was already judged at boot, so nothing pending can slip through here.
  if (sys.isSoloRaid() && !sys.rejoining) bumpClockHigh(Date.now(), true);
  /*
   * A-13 (2026-09-11): launch — move the preparations bought in the ship (`PlayerProfile.prep`) into this
   * raid's (`prepActive`). The training range is excluded (it has no environment, and `game:abort` calls
   * `clearActivePreps` on the way out, so they would simply burn). A reconnect and a solo resume pass through
   * here too, but the pending ones are empty by then, so `armPreps` does nothing and leaves the `prepActive`
   * already loaded alone — this is the spot where someone who came back does not silently lose their preps.
   */
  if (!sys.isTraining()) ctx.progression?.armPreps();
  sys.awaitingWorld = true;
  sys.ensureNetHooks();
  // WorldSystem generates synchronously inside its own handler; if it already ran (registered earlier),
  // ctx.world.ready is true and world:ready has been emitted before we got here → handle immediately.
  // (world:ready listeners above would have been skipped because awaitingWorld was false at that time.)
  if (ctx.world?.ready && ctx.world.seed === seed && ctx.phase !== 'deploying') {
    sys.awaitingWorld = false;
    sys.onWorldReady();
  }
  }

/** World generated: deploy — or, on a rejoin, restore the raid blob and wait for the host's ghost. */
export function onWorldReady(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  /*
   * 2026-09-08: the `시뮬레이션 훈련장` has no drop (`player/` skips the hellpod too) — going through
   * 'deploying' means `player:landed` never arrives and the screen stays stuck on the drop overlay.
   * 2026-09-14: the tutorial is the same — someone with no ship wakes up on that planet
   * (`player/parts/Spawn.usesHellpod`).
   */
  sys.setPhase(sys.isTraining() || sys.isTutorial() ? 'playing' : 'deploying');
  if (!sys.rejoining) {
    /*
     * 2026-09-11 (E-5 ③): inventory has just marked the kit as out on this solo raid (`raidSeed`). Write the resumable
     * snapshot now — standing at the spawn — so a reload during the hellpod drop resumes the run instead of reading as
     * "marker without a save" (= raid failure). `player:landed` overwrites it with the real pose.
     */
    if (sys.isSoloRaid()) {
      const spawn = ctx.world?.getPlayerSpawn();
      if (spawn) saveSoloAt(sys, spawn);
    }
    return;
  }
  sys.rejoining = false;
  const blob = sys.raidBlob;
  sys.raidBlob = null;
  if (blob && blob.seed === ctx.stats.seed) {
    try {
      const applied = ctx.inventory?.applyRaidState(blob.inventory) ?? false;
      ctx.stats = { ...blob.stats, seed: ctx.stats.seed, mode: ctx.missionMode };
      ctx.missionTime = Math.max(0, blob.missionTime);
      ctx.stats.timeSeconds = ctx.missionTime;
      sys.rewarded = false;
      ctx.bus.emit('ui:notify', { text: applied ? '레이드 세션 복원됨' : '레이드 진행 상황 복원됨', kind: 'info', duration: 3 });
    } catch (e) {
      console.error('[gameflow] raid blob restore failed', e);
    }
  }
  // Solo resume: there is no host to answer `flow rejoined` — we already hold the body state ourselves.
  const solo = sys.soloRestore;
  if (solo) {
    sys.soloRestore = null;
    sys.onGhostRestore(solo);
    /*
     * 2026-09-14 (tutorial): a freshly built world's checkpoint is `'wake'` — put it back to the saved one.
     * `gotoCheckpoint` also moves the body to that spot, so whoever resumed starts again **from the last
     * checkpoint** (「새로고침하면 체크포인트부터 이어 한다」). An unknown id, or a world that is not the
     * tutorial's, does nothing.
     */
    const cp = sys.soloCheckpoint;
    sys.soloCheckpoint = null;
    if (cp) { try { ctx.world?.tutorial?.gotoCheckpoint(cp); } catch (e) { console.error('[gameflow] gotoCheckpoint failed', e); } }
    return;
  }
  // The host answers our `flow rejoined` with `ghost restore`; if it never comes, drop in normally.
  sys.restoreTimer = NET_GHOST_RESTORE_TIMEOUT_S;
  }

/* ── Training range ─────────────────────────────────────────────── */
/** The arena's exit console: leave the training, refund the inventory snapshot, back to the ship. */
export function exitTraining(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (!sys.isTraining() || !sys.inMission()) return;
  const snapshot = sys.trainingSnapshot;
  sys.trainingSnapshot = null;
  const lobby = isDockedLobby(ctx.net?.lobby);   // 2026-09-15: the shared ship is the docked squad's (hub coerces anyway)
  const inSession = ctx.isMultiplayer;
  ctx.bus.emit('game:abort', {});
  if (snapshot != null) {
    try { ctx.inventory?.applyRaidState(snapshot); } catch (e) { console.error('[gameflow] training snapshot restore failed', e); }
  }
  if (inSession && typeof ctx.net?.leaveMission === 'function') ctx.net.leaveMission();
  ctx.bus.emit('ui:notify', { text: '시뮬레이션 훈련장 종료', kind: 'info', duration: 2.5 });
  if (ctx.phase === 'menu') ctx.bus.emit('hub:enter', { ship: lobby ? 'shared' : 'personal' });
  }

export function onAbort(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  const fromMission = sys.inMission();
  // Host abort *during* the mission → the whole squad returns to the ship together. A client aborting only leaves for
  // itself; leaving a result screen (complete / dead) is always local — the mission is already over for everyone.
  // A training is personal: leaving it never aborts the others.
  const live = sys.inLiveMission();
  // 2026-09-13: the voluntary return (`parts/Death.finishReturnToShip`) takes only this player out — even as
  // host it never drags the squad with it (`leaveMission` has already sent `lobby:mission false`, and the
  // server hands the squad leader to a living member).
  if (ctx.net && live && !sys.isTraining() && !sys.returnPending && (sys.wasMultiplayerHost || (ctx.isMultiplayer && ctx.net.isHost))) {
    ctx.net.send({ t: 'flow', ev: 'abort' }, 'others');
  }
  sys.returnPending = false;
  sys.returnTimer = -1;
  sys.wasMultiplayerHost = false;
  // Lobby mission ended by an abort → regroup in the shared ship. Deferred one microtask: if the abort came from
  // HubSystem's own `hub:enter` the ship is already being built (phase 'hub') and this is a no-op.
  // 2026-09-15 (squads · dock matching): only a **docked** squad has a shared ship to regroup in (an
  // undocked one never starts a mission).
  if (fromMission && isDockedLobby(ctx.net?.lobby)) {
    queueMicrotask(() => { if (ctx.phase === 'menu' && isDockedLobby(ctx.net?.lobby)) ctx.bus.emit('hub:enter', { ship: 'shared' }); });
  }
  sys.setPaused(false);
  sys.completeTimer = -1;
  sys.deathTimer = -1; sys.respawnTimer = -1; sys.respawnLastSec = -1;
  sys.tutorialRespawnTimer = -1;   // 2026-09-14
  sys.boarded = false;
  sys.aboardAtLiftoff = false; sys.squadExtraction = false;   // 2026-09-13 extraction rework
  sys.allDeadCheckTimer = -1;
  sys.disconnectAbortTimer = -1;
  sys.autoReturnTimer = -1;
  sys.raidSaveTimer = -1;
  sys.restoreTimer = -1;
  sys.rejoining = false;
  sys.raidBlob = null;
  sys.soloRestore = null;
  sys.soloCheckpoint = null;   // 2026-09-14
  clearSoloRaid();          // quitting to the ship / title ends the solo session (the kit resets below)
  ctx.progression?.clearActivePreps();   // A-13: the raid is over — this raid's preps count as consumed
  ctx.rejoinPending = false;
  sys.rewarded = false;
  sys.awaitingWorld = false;
  ctx.uiBlockers.delete('inventory');
  ctx.inventory?.closeAll();
  sys.setPhase('menu');
  }

export function setPhase(sys: GameFlowSystem, phase: GamePhase): void {
  sys.ctx.setPhase(phase);
  }

export function setPaused(sys: GameFlowSystem, paused: boolean, emit = true): void {
  if (sys.paused === paused) return;
  if (paused && !sys.ctx.isGameplayPhase() && !sys.inShip()) return;
  sys.paused = paused;
  /*
   * 2026-09-07: the pause **never freezes the world any more**, solo raids included. A raid is an extraction run —
   * stopping the clock, the enemies and the extraction countdown with a keypress made it a save-scum button, and it
   * also fought the new rule below (a lost pointer lock puts this menu up, which must not stall the mission).
   * `freeze` stays on the wire because `Engine` and the HUD still read it; it is simply always false now.
   * 2026-09-07 (cursor rework): the pointer lock is not touched here any more — `ui/menus/MenuBase` takes the
   * `'menu'` cursor-mode token when the pause menu shows and drops it when it hides, and `main.ts` does the single
   * re-lock once the last cursor owner is gone. One owner of the lock, no per-system relock races.
   */
  const freeze = false;
  if (emit) sys.ctx.bus.emit('game:paused', { paused, freeze });
  }
