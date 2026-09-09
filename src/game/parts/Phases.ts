/**
 * src/game/parts/Phases.ts — **페이즈 전환과 일시정지**.
 *
 * menu → hub → deploying → playing → extracting → complete / dead → hub. 일시정지는 **월드를 멈추지
 * 않고**(2026-09-07) 창 포커스를 잃었을 때만 뜬다. 일시정지 메뉴는 항상 단 하나의 화면이라
 * 다른 창이 열려 있으면 즉시 양보한다(Phase 12 — 겹쳐서 둘 다 못 끄던 상태의 수정).
 */
import * as THREE from 'three';
import type {
  GameContext, GameSystem, GamePhase, FlowMessage, PeerId, MissionMode, RaidSessionBlob, PlayerRestoreState, RemotePlayerRef,
} from '@/shared';
import type { PlanetId } from '@/shared';
import {
  GameContext as Ctx, Keys, PlayerFlags, PLAYER_RESPAWN_DELAY, RAID_FAILED_AUTO_RETURN_S, RAID_SAVE_INTERVAL_S,
  NET_GHOST_RESTORE_TIMEOUT_S,
} from '@/shared';
import { FREE_CURSOR_BLOCKER } from '@/shared';
import { RESUME_GATE_BLOCKER } from '@/shared';
import { ResumeGate, installDesktopRelockHook, syncDesktopCursor } from '../ResumeGate';
import { clearSoloRaid, loadSoloRaid, saveSoloRaid, soloRaidStatus, type SoloRaidSave } from '../SoloRaid';
import { ALL_DEAD_CHECK_INTERVAL, DEATH_TO_SCREEN, DISCONNECT_ABORT_DELAY, LIFTOFF_TO_COMPLETE, MISSION_FAILS_WHEN_ALL_DEAD, THREAT_MAX, THREAT_MIN, THREAT_RAMP_SECONDS, XP_DEATH_MUL, XP_EXTRACT_BONUS, XP_PER_KILL, XP_PER_LOOT_VALUE, XP_PER_MINUTE, XP_TIME_CAP } from '../model';
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
 * Phase 8: standing in the personal / shared ship. Esc pauses here too (the terminal is opened from the console,
 * not from Escape any more), but the pause is menu-only — `freeze` stays false so the ship keeps animating and
 * nothing mission-related (abort, stats, timers) happens.
 */
export function inShip(sys: GameFlowSystem): boolean {
  return sys.ctx.phase === 'hub';
  }

/**
 * Phase 12: no UI blocker besides the 재개 게이트's own token. The gate is an overlay over a running game, not a
 * screen — Escape on it must open the 일시정지 메뉴 and a window blur behind it must still pause.
 */
export function noScreenOpen(sys: GameFlowSystem): boolean {
  for (const t of sys.ctx.uiBlockers) if (t !== RESUME_GATE_BLOCKER) return false;
  return true;
  }

/* ── Pause / focus ───────────────────────────────────────────────────── */
/**
 * The player left the window (alt-tab, another app, a hidden tab). This is the **only** pause trigger besides
 * Escape since the 2026-09-07 커서 rework: a missing pointer lock means the mouse is being used as a cursor, which
 * is a normal in-game state now, while a missing window really is someone walking away.
 */
export function onFocusLost(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (sys.paused || !ctx.isGameplayPhase() || !sys.noScreenOpen()) return;
  if (ctx.player?.isDead ?? false) return;
  ctx.bus.emit('input:pointerLockLost', {});   // → escapePause() does the pausing
  }

/* ── Escape (2026-09-08 → 2026-09-09) ─────────────────
 *
 * **Escape 한 번은 열려 있는 화면 중 맨 위 하나를 닫는다. 닫을 화면이 없을 때만 일시정지 메뉴가 열린다.**
 *
 * 들어오는 길은 둘이다. 포인터 락이 걸려 있는 동안 Escape 는 keydown 이 되지 않고 커서만 풀리므로
 * `Input.onUserUnlock` 이 `input:pointerLockLost` 로 알려 주고, 화면이 이미 커서를 쓰고 있으면 진짜
 * `Keys.MENU` keydown 이 들어온다. 앞의 경우는 닫을 화면이 없는 상황이므로 곧장 `escapePause` 로 가고,
 * 뒤의 경우만 `escapeKey` 를 지난다.
 *
 * 2026-09-08 에는 화면의 ESC 닫기를 모두 없애고 Escape 를 메뉴를 여는 키 하나로 두었다. Escape 에는
 * user activation 이 없어서 그 키로 화면을 닫으면 재락이 거부되고 커서가 남는다는 이유였다. 2026-09-09 에
 * 되돌렸다 — 사람은 커서가 보이면 그 창을 ESC 로 닫으려 하고, 닫은 뒤의 처리는 이제 두 환경 모두 답이 있다.
 * 데스크톱 셸은 ESC key-up 마다 메인 프로세스가 activation 을 만들어 자동으로 락을 되찾고
 * (`electron/main.ts` → `__scavShellRelock`), 브라우저는 `좌측 클릭으로 게임 재개` 게이트
 * (`game/ResumeGate`)가 그 한 클릭을 받는다 — 원래 이 상황을 위해 만든 UI 다.
 *
 * 닫히는 순서는 **열린 순서의 역순**(`ctx.escape`, `shared/escape`)이고 시스템 등록 순서가 아니다. Tab 공용
 * 닫기는 각 화면이 자기 `update()` 에서 키를 읽는 방식이라 순서가 `main.ts` 의 등록 순서로 정해지는데,
 * ESC 는 맨 위 하나만 닫아야 하므로 열린 순서를 아는 곳이 필요하다.
 *
 * 가장 안쪽 팝업(수량 지정 · 우클릭 메뉴 · 경고 팝업 · 설정 · 키 바꾸기)은 지금도 자기가 window capture
 * 핸들러에서 Escape 를 삼켜 `Input` 이 기록조차 못 하게 한다. 그래서 이 스택이 다루는 것은 그 아래층인
 * **화면** 뿐이다.
 *
 * 일시정지 메뉴 자신을 ESC 로 닫는 것은 데스크톱 셸 전용이다 (`isDesktopShell()`). 메뉴는 스택을 쓰지 않고
 * 자기 window capture 핸들러에서 Escape 를 Tab 과 똑같이 처리한다 (`ui/menus/PauseMenu`) — 어차피 늘 맨 위이고,
 * 그 핸들러는 이미 경고 팝업의 Escape 예외를 들고 있다. 브라우저에서는 `게임으로 돌아가기` 클릭이 그대로
 * 남는다. 그 클릭이 브라우저가 재락 전에 요구하는 제스처이기도 하다.
 */
/** Escape 한 번: 맨 위 화면 하나를 닫고, 스택이 비어 있으면 일시정지 메뉴를 연다. */
export function escapeKey(sys: GameFlowSystem): void {
  if (sys.ctx.escape.closeTop()) return;
  escapePause(sys);
  }

/** 닫을 화면이 없을 때의 Escape — 일시정지 메뉴를 **열기만** 한다 (닫는 것은 `게임으로 돌아가기`). */
export function escapePause(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (sys.paused) return;
  if (!(ctx.isGameplayPhase() || inShip(sys))) return;
  if (ctx.player?.isDead ?? false) return;
  // The Alt 커서 has no window behind it, so leaving it up under the menu would strand the player without a camera.
  if (ctx.uiBlockers.has(FREE_CURSOR_BLOCKER)) toggleFreeCursor(sys, false);
  sys.setPaused(true);
  }

/**
 * Alt (`Keys.CURSOR`): hand the mouse over without opening anything, and take it back on the next press.
 *
 * It is a plain cursor-mode owner with its own blocker token, so gameplay input is gated exactly the way an open
 * panel gates it (no firing, no camera) and `main.ts` re-locks when it is released. Escape closes it too.
 *
 * 2026-09-07: **좌클릭도 닫는다.** This is the one cursor owner with no window behind it, so a click on the 3D
 * canvas can only mean "give me the camera back" — and a click is the real user gesture Chrome wants before it
 * grants the pointer lock, so the camera comes back at once instead of at the next keypress. A click that lands
 * on a HUD element (its own event target) is left alone.
 */
export function toggleFreeCursor(sys: GameFlowSystem, on?: boolean): void {
  const ctx = sys.ctx;
  const want = on ?? !ctx.uiBlockers.has(FREE_CURSOR_BLOCKER);
  if (want === ctx.uiBlockers.has(FREE_CURSOR_BLOCKER)) return;
  if (want) {
    // Only where the pointer is actually captured — never over another screen, a menu or a result phase.
    if (ctx.uiBlockers.size > 0 || !(ctx.isGameplayPhase() || sys.inShip())) return;
    if (ctx.player?.isDead ?? false) return;
    ctx.uiBlockers.add(FREE_CURSOR_BLOCKER);
    // 2026-09-09: Escape 는 이제 **카메라를 돌려준다** (일시정지 메뉴가 아니라). 뒤에 창이 없는 유일한 커서
    // 소유자이므로 닫을 것이 이것뿐이면 그게 곧 "커서 그만" 이고, 스택이 비어 있을 때만 메뉴가 열린다.
    ctx.escape.push(FREE_CURSOR_BLOCKER, () => toggleFreeCursor(sys, false));
    ctx.input.setCursorMode(true, FREE_CURSOR_BLOCKER);
    window.addEventListener('mousedown', sys.onFreeCursorClick);
  } else {
    window.removeEventListener('mousedown', sys.onFreeCursorClick);
    ctx.uiBlockers.delete(FREE_CURSOR_BLOCKER);
    ctx.escape.remove(FREE_CURSOR_BLOCKER);
    ctx.input.setCursorMode(false, FREE_CURSOR_BLOCKER);
  }
  ctx.bus.emit('ui:freeCursorToggled', { active: want });
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
   * Phase 11: same contract for the 목표 행성 — the emitter sets `ctx.missionPlanet` first, this only re-confirms it.
   * A training has no planet; `MissionComplete`'s 다시 배치 re-emits with the planet it was launched with, and an
   * emit without the field (an older path) keeps whatever the ship last flew to rather than silently rerolling.
   */
  ctx.missionPlanet = sys.isTraining() ? null : (planet ?? ctx.missionPlanet);
  sys.setPaused(false);
  sys.completeTimer = -1;
  sys.deathTimer = -1; sys.respawnTimer = -1; sys.respawnLastSec = -1;
  sys.lastThreat = -1;
  sys.boarded = false;
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
  // 훈련장: remember the inventory so ammo / durability spent on the range are refunded on exit.
  sys.trainingSnapshot = sys.isTraining() ? (ctx.inventory?.captureRaidState() ?? null) : null;
  sys.raidSaveTimer = (sys.isRaidSession() || sys.isSoloRaid()) ? RAID_SAVE_INTERVAL_S : -1;
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
  // 2026-09-08: 시뮬레이션 훈련장은 강하가 없다 (`player/`도 헬포드를 건너뛴다) — 'deploying' 을 거치면
  //   `player:landed` 가 영영 오지 않아 화면이 강하 오버레이에 갇힌다. 바로 'playing' 으로 간다.
  sys.setPhase(sys.isTraining() ? 'playing' : 'deploying');
  if (!sys.rejoining) return;
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
    return;
  }
  // The host answers our `flow rejoined` with `ghost restore`; if it never comes, drop in normally.
  sys.restoreTimer = NET_GHOST_RESTORE_TIMEOUT_S;
  }

/* ── 훈련장 ─────────────────────────────────────────────────────────── */
/** The arena's exit console: leave the training, refund the inventory snapshot, back to the ship. */
export function exitTraining(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (!sys.isTraining() || !sys.inMission()) return;
  const snapshot = sys.trainingSnapshot;
  sys.trainingSnapshot = null;
  const lobby = !!ctx.net?.lobby;
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
  if (ctx.net && live && !sys.isTraining() && (sys.wasMultiplayerHost || (ctx.isMultiplayer && ctx.net.isHost))) {
    ctx.net.send({ t: 'flow', ev: 'abort' }, 'others');
  }
  sys.wasMultiplayerHost = false;
  // Lobby mission ended by an abort → regroup in the shared ship. Deferred one microtask: if the abort came from
  // HubSystem's own `hub:enter` the ship is already being built (phase 'hub') and this is a no-op.
  if (fromMission && ctx.net?.lobby) {
    queueMicrotask(() => { if (ctx.phase === 'menu' && ctx.net?.lobby) ctx.bus.emit('hub:enter', { ship: 'shared' }); });
  }
  sys.setPaused(false);
  sys.completeTimer = -1;
  sys.deathTimer = -1; sys.respawnTimer = -1; sys.respawnLastSec = -1;
  sys.boarded = false;
  sys.allDeadCheckTimer = -1;
  sys.disconnectAbortTimer = -1;
  sys.autoReturnTimer = -1;
  sys.raidSaveTimer = -1;
  sys.restoreTimer = -1;
  sys.rejoining = false;
  sys.raidBlob = null;
  sys.soloRestore = null;
  clearSoloRaid();          // quitting to the ship / title ends the solo session (the kit resets below)
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
   * 2026-09-07 (커서 rework): the pointer lock is not touched here any more — `ui/menus/MenuBase` takes the
   * `'menu'` cursor-mode token when the pause menu shows and drops it when it hides, and `main.ts` does the single
   * re-lock once the last cursor owner is gone. One owner of the lock, no per-system relock races.
   */
  const freeze = false;
  if (emit) sys.ctx.bus.emit('game:paused', { paused, freeze });
  }
