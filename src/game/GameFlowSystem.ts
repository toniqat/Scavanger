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
import { ResumeGate, installDesktopRelockHook, syncDesktopCursor } from './ResumeGate';
import { clearSoloRaid, loadSoloRaid, saveSoloRaid, soloRaidStatus, type SoloRaidSave } from './SoloRaid';

import { ALL_DEAD_CHECK_INTERVAL, DEATH_TO_SCREEN, DISCONNECT_ABORT_DELAY, LIFTOFF_TO_COMPLETE, MISSION_FAILS_WHEN_ALL_DEAD, THREAT_MAX, THREAT_MIN, THREAT_RAMP_SECONDS, XP_DEATH_MUL, XP_EXTRACT_BONUS, XP_PER_KILL, XP_PER_LOOT_VALUE, XP_PER_MINUTE, XP_TIME_CAP } from './model';
/** 폴더 공용 어휘(상수 · 타입 · 스크래치)는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 재수출한다. */
export * from './model';
import * as Death from './parts/Death';
import * as Session from './parts/Session';
import * as Phases from './parts/Phases';
import * as Wire from './parts/Wire';

export class GameFlowSystem implements GameSystem {
  readonly name = 'gameflow';
  ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  netUnsub: (() => void) | null = null;

  awaitingWorld = false;
  completeTimer = -1;
  deathTimer = -1;
  /** Phase 2: seconds until a respawn is allowed (−1 = not dead / not running). */
  respawnTimer = -1;
  respawnLastSec = -1;
  paused = false;
  lastThreat = -1;

  /* ── multiplayer ── */
  /** Local player entered the dropship bay (cleared on death / new mission). */
  boarded = false;
  /** Host: > 0 while the local player is dead → periodic all-dead check. */
  allDeadCheckTimer = -1;
  /** > 0 after the lobby/server vanished mid-mission → abort when it expires. */
  disconnectAbortTimer = -1;
  /** Cached each frame so `game:abort` can still reach the squad after NetSystem tore the session down. */
  wasMultiplayerHost = false;
  /** Mission-end XP is banked exactly once per mission (complete() and gameOver() are both idempotent). */
  rewarded = false;

  /* ── Phase 7 ── */
  /** > 0 on the 레이드 실패 screen → automatic `hub:enter` when it expires. */
  autoReturnTimer = -1;
  /** Raid session upload cadence (multiplayer raid only). */
  raidSaveTimer = -1;
  /** Blob the server handed back with `welcome` (resume into a running raid); applied after the rejoin's `world:ready`. */
  raidBlob: RaidSessionBlob | null = null;
  /** true between `net:gameStarting {rejoin:true}` and the restore / fallback. */
  rejoining = false;
  /** 솔로 레이드 found in localStorage at boot and not consumed yet (`resumeSoloRaid` / `failSoloRaid`). */
  soloPending: SoloRaidSave | null = null;
  /** true when the stored solo raid was already past `SOLO_RAID_GRACE_MS` at boot → 레이드 실패 on the first frame. */
  soloExpired = false;
  /** Pose to hand `restoreState` once the resumed world is ready (solo counterpart of the host's `ghost restore`). */
  soloRestore: PlayerRestoreState | null = null;
  /** > 0 while waiting for the host's `ghost restore` after a rejoin. */
  restoreTimer = -1;
  /** Inventory as it was when the 훈련장 was entered (ammo / durability are refunded on exit). */
  trainingSnapshot: unknown = null;
  /**
   * 2026-09-07 (커서 rework): **a lost pointer lock is no longer a pause.**
   *
   * Releasing the lock is now how every screen shows the mouse, and Chrome drops it on any Escape, so treating the
   * missing lock as "the player left" is what made the game freeze every time the cursor appeared. Only losing the
   * *window* means the player really left — that still pauses, exactly like alt-tabbing out of any other game.
   */
  /** Phase 12: `좌측 클릭으로 게임 재개` overlay (browser only; created in `init`). */
  private resumeGate: ResumeGate | null = null;
  private onWindowBlur = (): void => this.onFocusLost();
  private onVisibilityChange = (): void => { if (document.visibilityState === 'hidden') this.onFocusLost(); };
  /** Tab closing mid-solo-raid: flush the session so the last seconds of the run are not lost (2026-09-07). */
  private onPageHide = (): void => { if (this.isSoloRaid() && this.ctx.isGameplayPhase()) this.saveSolo(); };

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', ({ seed, mode, planet }) => this.onNewMission(seed, mode, planet)),
      b.on('world:ready', () => {
        if (!this.awaitingWorld) return;
        this.awaitingWorld = false;
        this.onWorldReady();
      }),
      b.on('player:landed', () => {
        if (ctx.phase === 'deploying') this.setPhase('playing');
      }),
      b.on('extraction:activated', () => { if (ctx.phase === 'playing') this.setPhase('extracting'); }),
      b.on('extraction:shipLanded', () => { if (ctx.phase === 'extracting') this.setPhase('shipLanded'); }),
      b.on('extraction:boarded', () => { this.boarded = true; }),
      b.on('extraction:liftoff', () => {
        if (ctx.phase !== 'shipLanded' && ctx.phase !== 'extracting') return;
        this.setPhase('liftoff');
        this.completeTimer = LIFTOFF_TO_COMPLETE;
      }),
      b.on('player:died', () => this.onLocalDied()),
      b.on('game:respawn', () => this.onRespawnRequest()),
      b.on('player:spawned', () => { this.respawnTimer = -1; this.respawnLastSec = -1; }),
      /* Downed is NOT death: the mission keeps running and a defibrillator can still bring the player back. */
      b.on('player:downed', () => this.onLocalDowned()),
      b.on('player:revived', () => this.onLocalRevived()),
      // stats.kills / cratesOpened / damageTaken are incremented by Enemy / World / Player systems;
      // missionTime + stats.timeSeconds advance in Engine.frame(). GameFlow only finalizes them.
      b.on('game:abort', () => this.onAbort()),
      b.on('game:paused', ({ paused }) => this.setPaused(paused, false)),
      /* multiplayer */
      b.on('net:remoteDied', () => this.checkAllDead()),
      b.on('net:peerLeft', () => this.checkAllDead()),
      b.on('net:lobbyLeft', ({ reason }) => this.onLobbyLeft(reason)),
      /* reconnection (hub era) */
      b.on('net:reconnecting', ({ attempt }) => {
        if (!this.inMission()) return;
        ctx.bus.emit('ui:notify', { text: `서버 재연결 중… (${attempt})`, kind: 'warning', duration: 3 });
      }),
      b.on('net:resumed', ({ seamless, inProgress, lobby }) => {
        if (!this.inMission()) return;
        if (seamless) { ctx.bus.emit('ui:notify', { text: '재연결됨', kind: 'success' }); return; }
        // the party moved on (different mission / back in the ship): drop our stale mission and regroup.
        // A 훈련장 is entered individually and is not the squad's mission — never report it as one.
        const training = lobby?.started === true && (lobby.mode ?? 'raid') === 'training';
        ctx.bus.emit('ui:notify', {
          text: training ? '훈련장 연결이 끊겼습니다 — 함선으로 복귀'
            : inProgress ? '분대가 다른 임무를 진행 중입니다 — 함선으로 복귀' : '분대가 함선으로 복귀했습니다',
          kind: 'warning', duration: 4,
        });
        this.disconnectAbortTimer = -1;
        ctx.bus.emit('game:abort', {});
        ctx.bus.emit('hub:enter', { ship: 'shared' });
      }),
      /* Phase 7: raid session / rejoin / ghosts / host migration / training */
      b.on('net:raidLoaded', ({ blob }) => { this.raidBlob = blob; }),
      b.on('net:gameStarting', ({ rejoin, mode }) => this.onGameStarting(rejoin ?? false, mode)),
      b.on('net:ghostRestore', ({ state }) => this.onGhostRestore(state)),
      // Phase 9: ghost states live on the refs (`RemotePlayerRef.ghostState`, net fills them); a ghost that bleeds out
      // is caught by the 0.5 s timer that runs while the local player is out
      b.on('net:peerSuspended', () => this.checkAllDead()),
      b.on('net:hostChanged', ({ isLocalHost }) => this.onHostChanged(isLocalHost)),
      b.on('training:exitRequested', () => this.exitTraining()),
      b.on('inventory:itemAdded', () => this.saveRaid()),
      b.on('crate:looted', () => this.saveRaid()),
    );
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
    this.resumeGate = new ResumeGate(ctx);
    this.unsubs.push(installDesktopRelockHook(ctx));
    /*
     * 2026-09-07: a solo raid interrupted by a closed tab / crash is resumable for `SOLO_RAID_GRACE_MS`. Read the
     * file here and act on it from the first `update()` — the other systems are registered but have not run a frame
     * yet, and `WorldSystem` must be listening before we emit `game:newMission`.
     */
    const solo = loadSoloRaid();
    const status = soloRaidStatus(solo);
    this.soloPending = status === 'fresh' ? solo : null;
    this.soloExpired = status === 'stale';
    if (status !== 'none') clearSoloRaid();
    // Make sure listeners know the initial phase even though ctx.phase already equals 'menu'.
    ctx.phase = 'menu';
    ctx.bus.emit('game:phaseChanged', { phase: 'menu', prev: 'menu' });
  }

  /** Mission running or its result screen showing (anything the hub / a disconnect has to abort first). */
  inMission(): boolean { return Phases.inMission(this); }

  /** Live mission (not a result screen). */
  inLiveMission(): boolean { return Phases.inLiveMission(this); }

  isTraining(): boolean { return Phases.isTraining(this); }

  /**
   * Phase 8: standing in the personal / shared ship. Esc pauses here too (the terminal is opened from the console,
   * not from Escape any more), but the pause is menu-only — `freeze` stays false so the ship keeps animating and
   * nothing mission-related (abort, stats, timers) happens.
   */
  inShip(): boolean { return Phases.inShip(this); }

  /**
   * Phase 12: no UI blocker besides the 재개 게이트's own token. The gate is an overlay over a running game, not a
   * screen — Escape on it must open the 일시정지 메뉴 and a window blur behind it must still pause.
   */
  noScreenOpen(): boolean { return Phases.noScreenOpen(this); }

  /** Phase 12: a screen other than the 일시정지 메뉴 itself (and the gate) holds a blocker — the pause must yield. */
  private otherScreenOpen(): boolean { return Phases.otherScreenOpen(this); }

  /* ── Multiplayer helpers ─────────────────────────────────────────────── */
  /** Subscribe to host `flow` messages once `ctx.net` exists (NetSystem publishes it before this system inits, but stay lazy). */
  ensureNetHooks(): void { return Wire.ensureNetHooks(this); }

  /** Clients only: mirror the host's mission-level decisions. */
  onFlowMessage(msg: FlowMessage, from: PeerId): void { return Wire.onFlowMessage(this, msg, from); }

  private onLocalDied(): void { return Death.onLocalDied(this); }

  /** Emits `game:respawnAvailable` once per whole second while the respawn timer runs (and once at 0). */
  tickRespawn(): void { return Death.tickRespawn(this); }

  /** `game:respawn` (UI): honoured only while dead, after the delay and while the raid is still running (never on 레이드 실패). */
  private onRespawnRequest(): void { return Death.onRespawnRequest(this); }

  /** Downed (tactical kit hook): the mission keeps running — a squadmate or a defibrillator can still bring the player back. */
  private onLocalDowned(): void { return Death.onLocalDowned(this); }

  private onLocalRevived(): void { return Death.onLocalRevived(this); }

  /** True when a player is out of the fight for good — downed players are still revivable. */
  isLocalOut(): boolean { return Death.isLocalOut(this); }

  /**
   * Is this remote member still "in the fight"? Ghost-aware (Phase 7):
   *   - not part of the mission (`inMission` false / IN_HUB / left) → ignored (returns false);
   *   - suspended (socket down, host simulates a ghost) → alive unless the ghost is dead (`state` 2);
   *   - otherwise alive unless dead-and-not-downed (a downed peer can still be revived).
   */
  isRemoteAlive(r: RemotePlayerRef): boolean { return Death.isRemoteAlive(this, r); }

  /** Host only: nobody left alive / downed / alive-as-a-ghost → `flow over` to the squad and 레이드 실패 locally. */
  checkAllDead(): void { return Death.checkAllDead(this); }

  /** Phase 7: authority moved (host migration). The new host takes the wipe check over; the old one just mirrors. */
  private onHostChanged(isLocalHost: boolean): void { return Wire.onHostChanged(this, isLocalHost); }

  /**
   * The party is gone (server gave up on us / host left / kicked) mid-mission → abort after a short toast and
   * return to the personal ship. A plain socket drop is `net:reconnecting` (handled above) and never aborts.
   */
  private onLobbyLeft(reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft'): void { return Wire.onLobbyLeft(this, reason); }

  /* ── Pause / focus ───────────────────────────────────────────────────── */
  /**
   * The player left the window (alt-tab, another app, a hidden tab). This is the **only** pause trigger besides
   * Escape since the 2026-09-07 커서 rework: a missing pointer lock means the mouse is being used as a cursor, which
   * is a normal in-game state now, while a missing window really is someone walking away.
   */
  private onFocusLost(): void { return Phases.onFocusLost(this); }

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
  private toggleFreeCursor(on?: boolean): void { return Phases.toggleFreeCursor(this, on); }

  /** Left click on the world while the Alt 커서 is up = 카메라 복귀 (see `toggleFreeCursor`). */
  readonly onFreeCursorClick = (e: MouseEvent): void => {
    if (e.button !== 0 || e.target !== this.ctx.canvas) return;
    this.toggleFreeCursor(false);
  };

  /* ── Mission start / rejoin ──────────────────────────────────────────── */
  /** NetSystem announces a session start right before its `game:newMission`; `rejoin` = re-entering a running mission. */
  private onGameStarting(rejoin: boolean, mode: MissionMode | undefined): void { return Phases.onGameStarting(this, rejoin, mode); }

  private onNewMission(seed: number, mode: MissionMode | undefined, planet?: PlanetId | null): void { return Phases.onNewMission(this, seed, mode, planet); }

  /** World generated: deploy — or, on a rejoin, restore the raid blob and wait for the host's ghost. */
  onWorldReady(): void { return Phases.onWorldReady(this); }

  /** `ghost restore` from the host: stand where the ghost was; a dead ghost enters the respawn flow. */
  onGhostRestore(state: PlayerRestoreState): void { return Session.onGhostRestore(this, state); }

  /** No `ghost restore` within NET_GHOST_RESTORE_TIMEOUT_S → normal hellpod drop at the mission spawn. */
  private restoreFallback(): void { return Session.restoreFallback(this); }

  /* ── Raid session (multiplayer raid only) ────────────────────────────── */
  isRaidSession(): boolean { return Session.isRaidSession(this); }

  /** Solo raid: no relay to upload to, so the session is mirrored into localStorage instead (`SoloRaid.ts`). */
  isSoloRaid(): boolean { return Session.isSoloRaid(this); }

  /** Upload my mid-raid state so a reconnect can resume it (`RaidSessionBlob`) — or, solo, write it to localStorage. */
  private saveRaid(): void { return Session.saveRaid(this); }

  /** Mirror the live solo raid (seed / planet / clock / stats / inventory / body) into localStorage. */
  saveSolo(): void { return Session.saveSolo(this); }

  /**
   * First frame after boot: either drop back into the stored solo raid (inside `SOLO_RAID_GRACE_MS`) or count it as
   * a 레이드 실패. Runs once — both fields are cleared before anything is emitted.
   */
  private consumeStoredSoloRaid(): void { return Session.consumeStoredSoloRaid(this); }

  /** Re-enter the stored solo raid: same seed / planet, blob restored on `world:ready`, body placed (no hellpod). */
  resumeSoloRaid(save: SoloRaidSave): void { return Session.resumeSoloRaid(this, save); }

  /* ── 훈련장 ─────────────────────────────────────────────────────────── */
  /** The arena's exit console: leave the training, refund the inventory snapshot, back to the ship. */
  private exitTraining(): void { return Phases.exitTraining(this); }

  private onAbort(): void { return Phases.onAbort(this); }

  setPhase(phase: GamePhase): void { return Phases.setPhase(this, phase); }

  setPaused(paused: boolean, emit = true): void { return Phases.setPaused(this, paused, emit); }

  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    if (this.soloPending || this.soloExpired) this.consumeStoredSoloRaid();
    if (this.inLiveMission()) this.wasMultiplayerHost = ctx.isMultiplayer && (ctx.net?.isHost ?? false);

    // Escape: toggle pause (not while another UI blocker — inventory / map / terminal — is open; those
    // consume Escape in a capture-phase listener anyway). Phase 8: the ship pauses on Escape as well,
    // except while the housing / 함선 관리 mode owns the key (it cancels the placement instead).
    /*
     * Phase 12: the 일시정지 메뉴 never shares the screen with another cursor screen. It can only *open* while nothing
     * else is up (below), but a screen can still open *over* it — a container window the interaction finished a frame
     * late, a net-driven window — and the two then fought over Escape (the inventory's capture-phase listener won every
     * press while its backdrop covered the menu's buttons: "둘 다 못 끄는 상태"). The pause has nothing to protect (it
     * freezes nothing), so it yields to the newcomer at once and that screen's own Escape / close path is the only one
     * in play. The gate's token is transparent here (it is not a screen).
     */
    if (this.paused && this.otherScreenOpen()) this.setPaused(false);
    if (ctx.input.wasPressed(Keys.MENU)) {
      if (this.paused) this.setPaused(false);
      // Alt 커서 is the innermost thing Escape can close (it holds a blocker, so the branch below would skip anyway).
      else if (ctx.uiBlockers.has(FREE_CURSOR_BLOCKER)) { this.toggleFreeCursor(false); ctx.input.consume(Keys.MENU); }
      // Never while a screen owns the cursor (a screen that dropped its blocker this frame but kept cursor mode is
      // still open); the 재개 게이트 is not a screen — Escape on it opens the menu normally.
      else if (this.noScreenOpen() && !ctx.input.isCursorMode && !(ctx.player?.isDead ?? false)
        && (ctx.isGameplayPhase() || (this.inShip() && !(ctx.housing?.housingMode ?? false)))) this.setPaused(true);
    }
    // Phase 12: '좌측 클릭으로 게임 재개' (browser) / hidden OS cursor while nothing needs it (Electron shell).
    this.resumeGate?.update();
    syncDesktopCursor(ctx);
    // Alt: free the mouse cursor in place (no screen, no pause). Pressed again — or Escape — gives it back.
    if (ctx.input.wasPressed(Keys.CURSOR)) this.toggleFreeCursor();
    // It is the only cursor owner with no window behind it, so nothing else would ever drop it: a phase change
    // (mission end, abort, docking) or a death has to.
    if (ctx.uiBlockers.has(FREE_CURSOR_BLOCKER)
      && (!(ctx.isGameplayPhase() || this.inShip()) || (ctx.player?.isDead ?? false))) this.toggleFreeCursor(false);

    if (ctx.isGameplayPhase() && !this.isTraining()) {
      // Difficulty ramp 0.3 → 0.7 over 8 minutes of mission time (never on the training range).
      const t = Math.min(1, ctx.missionTime / THREAT_RAMP_SECONDS);
      const threat = THREAT_MIN + (THREAT_MAX - THREAT_MIN) * t;
      if (ctx.enemies && Math.abs(threat - this.lastThreat) > 0.01) {
        this.lastThreat = threat;
        ctx.enemies.setThreatLevel(threat);
      }
    }

    if (this.completeTimer >= 0) {
      this.completeTimer -= dt;
      if (this.completeTimer < 0) this.complete();
    }
    if (this.deathTimer >= 0) {
      this.deathTimer -= dt;
      if (this.deathTimer < 0) { this.deathTimer = -1; this.gameOver(); }
    }
    if (this.respawnTimer >= 0) {
      if (this.respawnTimer > 0) this.respawnTimer = Math.max(0, this.respawnTimer - dt);
      this.tickRespawn();
    }
    if (this.allDeadCheckTimer >= 0) {
      this.allDeadCheckTimer -= dt;
      if (this.allDeadCheckTimer < 0) {
        const stillOut = this.isLocalOut() || (ctx.player?.isDowned ?? false);
        this.allDeadCheckTimer = stillOut ? ALL_DEAD_CHECK_INTERVAL : -1;
        this.checkAllDead();
      }
    }
    if (this.restoreTimer >= 0) {
      this.restoreTimer -= dt;
      if (this.restoreTimer < 0) this.restoreFallback();
    }
    if (this.raidSaveTimer >= 0 && ctx.isGameplayPhase()) {
      this.raidSaveTimer -= dt;
      if (this.raidSaveTimer < 0) this.saveRaid();
    }
    if (this.autoReturnTimer >= 0) {
      this.autoReturnTimer -= dt;
      if (this.autoReturnTimer < 0) {
        this.autoReturnTimer = -1;
        if (ctx.phase === 'dead') ctx.bus.emit('hub:enter', { ship: ctx.net?.lobby ? 'shared' : 'personal' });
      }
    }
    if (this.disconnectAbortTimer >= 0) {
      this.disconnectAbortTimer -= dt;
      if (this.disconnectAbortTimer < 0) {
        this.disconnectAbortTimer = -1;
        ctx.bus.emit('game:abort', {});
        // the lobby is gone → personal ship (onAbort's shared-ship regroup only fires while a lobby exists)
        if (ctx.phase === 'menu') ctx.bus.emit('hub:enter', { ship: ctx.net?.lobby ? 'shared' : 'personal' });
      }
    }
  }

  complete(): void { return Death.complete(this); }

  /** 레이드 실패: solo death (after DEATH_TO_SCREEN) or a squad wipe (host decision, mirrored by `flow over`). */
  gameOver(): void { return Death.gameOver(this); }

  /**
   * Bank the mission result into the persistent profile (progression/). Runs once per mission, before the
   * result screen appears, so `game:complete` / `game:over` listeners already see the new level.
   * Loot XP is only paid on a successful extraction — dying leaves the bag on the ground.
   * A 훈련장 never pays out (and never settles a contract).
   */
  awardMissionXp(): void { return Death.awardMissionXp(this); }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.netUnsub?.(); this.netUnsub = null;
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('mousedown', this.onFreeCursorClick);
    this.resumeGate?.dispose(); this.resumeGate = null;
    document.body.classList.remove('desktop-nocursor');
  }
}
