import type {
  GameContext, GameSystem, GamePhase, FlowMessage, PeerId, MissionMode, RaidSessionBlob, PlayerRestoreState, RemotePlayerRef,
} from '@/shared';
import type { PlanetId } from '@/shared';
import type { TutorialCheckpointId } from '@/shared';
import { Keys } from '@/shared';
import { ResumeGate, installDesktopRelockHook, syncDesktopCursor } from './ResumeGate';
import type { SoloRaidSave } from './SoloRaid';
import { bumpClockHigh } from './SoloRaid';

import { ALL_DEAD_CHECK_INTERVAL, LIFTOFF_TO_COMPLETE, THREAT_MAX, THREAT_MIN, THREAT_RAMP_SECONDS } from './model';
/** Folder vocabulary (constants · types · scratch objects) lives in `model.ts`; re-exported for old import paths. */
export * from './model';
import * as Death from './parts/Death';
import * as Session from './parts/Session';
import * as Phases from './parts/Phases';
import * as Wire from './parts/Wire';
/* appended (2026-09-09): player corpses · the squad-leader device */
import { PlayerCorpseManager } from './Corpses';
import * as Corpse from './parts/CorpseNet';
import * as Leader from './parts/Leader';
import type { LeaderDeviceObject } from './parts/Leader';
/* appended (2026-09-15): results screen rework — peak carried value · damage per source · the last hit */
import { RaidReport } from './parts/RaidReport';
/* appended (2026-09-21): the raid-end XP counters (gathers · structures found · map explored) */
import { RaidXpTracker } from './parts/RaidXp';
/* appended (2026-09-15): the raid-entry loading gate */
import { LoadGate } from './parts/LoadGate';
/* appended (2026-09-15): title `이어하기` · `레이드 포기` */
import { RaidResume } from './parts/Resume';

export class GameFlowSystem implements GameSystem {
  readonly name = 'gameflow';
  ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  netUnsub: (() => void) | null = null;

  awaitingWorld = false;
  completeTimer = -1;
  deathTimer = -1;
  /**
   * Phase 2's respawn countdown. **Nothing has armed it since 2026-09-09** — automatic respawn is gone and the
   * only way back is the rescue drop. The field, `PLAYER_RESPAWN_DELAY` and `game:respawnAvailable` are kept as
   * contract stubs.
   */
  respawnTimer = -1;
  respawnLastSec = -1;

  /* ── 2026-09-09: corpses · the squad-leader device ── */
  /** Every player corpse standing in the raid (`ctx.corpses`). None of them goes away before the raid ends. */
  corpses: PlayerCorpseManager | null = null;
  corpseUnsubs: Array<() => void> = [];
  /** The squad-leader device lying on the ground (exists only once the host is fully dead). */
  leaderDevice: LeaderDeviceObject | null = null;
  leaderUnsubs: Array<() => void> = [];
  paused = false;
  lastThreat = -1;
  /**
   * 2026-09-15 (results screen rework): fills the `stats.peakLootValue` · `stats.death` that the results screen
   * reads (`parts/RaidReport`).
   */
  readonly report = new RaidReport(this);
  /** 2026-09-21 (raid-end XP settlement): counts gathers · discovered structures · map explored into `ctx.stats` (`parts/RaidXp`). */
  readonly raidXp = new RaidXpTracker(this);
  /**
   * 2026-09-15 (raid-entry loading): the gate that holds the screen after the launch countdown until every
   * squad member is ready (`parts/LoadGate`). `ui/`'s radial gauge and the smokes read it as
   * `__game.getSystem('gameflow').loadGate`.
   */
  readonly loadGate = new LoadGate(this);
  /**
   * 2026-09-15 (title `이어하기` · `레이드 포기`): offers the remaining raid (solo save · tutorial · squad lobby)
   * on the title and takes `이어하기` / `레이드 포기` (`parts/Resume`, `ctx.raidResume`). Replaces the old
   * `consumeStoredSoloRaid`, which dropped the boot straight into the raid.
   */
  readonly raidResume = new RaidResume(this);

  /* ── multiplayer ── */
  /** Local player entered the dropship bay (cleared on death / new mission). */
  boarded = false;
  /**
   * 2026-09-13 (extraction rework): the local player was aboard and alive when the ship left
   * (`extraction:liftoff.aboard`) — the only thing that makes `stats.extracted` true now. Set together with
   * `squadExtraction` when a liftoff ends this player's raid.
   */
  aboardAtLiftoff = false;
  /**
   * 2026-09-13: that liftoff left nobody alive outside (`extraction:liftoff.squadDone`) — the raid ends for the whole squad, and
   * the host sends `flow complete` as before. false = only the riders leave: they `leaveMission()` at their result screen and the
   * rest play on.
   */
  squadExtraction = false;
  /** 2026-09-15: true only inside `parts/Death.completeTutorialSkip` — `complete()` counts the run as extracted regardless of the body. */
  tutorialSkipComplete = false;
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
  /**
   * 2026-09-13: the voluntary return — while true, `onLocalDied` starts `returnTimer` instead of waiting for a
   * rescue drop or showing the `레이드 실패` screen.
   */
  returnPending = false;
  /** 2026-09-13: seconds after dying on a voluntary return until the ship (`parts/Death.finishReturnToShip`). */
  returnTimer = -1;
  /** Raid session upload cadence (multiplayer raid only). */
  raidSaveTimer = -1;
  /** 2026-09-14: seconds from a tutorial death to the checkpoint respawn (-1 = no wait, `parts/Death`). */
  tutorialRespawnTimer = -1;
  /** Blob the server handed back with `welcome` (resume into a running raid); applied after the rejoin's `world:ready`. */
  raidBlob: RaidSessionBlob | null = null;
  /** true between `net:gameStarting {rejoin:true}` and the restore / fallback. */
  rejoining = false;
  /** Pose to hand `restoreState` once the resumed world is ready (solo counterpart of the host's `ghost restore`). */
  soloRestore: PlayerRestoreState | null = null;
  /** 2026-09-14: the last checkpoint a resumed tutorial passed (put back after `world:ready`, null = none). */
  soloCheckpoint: TutorialCheckpointId | null = null;
  /**
   * 2026-09-15: id of the last tutorial step saved. `tutorial:changed` also arrives for reasons that are not a
   * step change (the stamina reveal), so a save is forced **only on the frame the step really changed**
   * (`parts/Session.saveTutorialStep`).
   */
  lastTutorialStep: string | null = null;
  /** > 0 while waiting for the host's `ghost restore` after a rejoin. */
  restoreTimer = -1;
  /** Inventory as it was when the training range was entered (ammo / durability are refunded on exit). */
  trainingSnapshot: unknown = null;
  /**
   * 2026-09-07 (cursor rework): a lost pointer lock is not, by itself, a pause. Releasing the lock is how every
   * screen shows the mouse, so treating a missing lock as "the player left" made the game freeze whenever the
   * cursor appeared. Losing the *window* means the player really left — that still pauses.
   *
   * 2026-09-08: a lock the player took away **while the camera still wanted it** is a different thing — it is the
   * Escape key, which the browser swallowed. `Input.onUserUnlock` reports exactly that case (our own releases are
   * marked and skipped) and it opens the pause menu through the same `input:pointerLockLost` event.
   */
  /** Phase 12: `좌측 클릭으로 게임 재개` overlay (browser only; created in `init`). */
  private resumeGate: ResumeGate | null = null;
  private onWindowBlur = (): void => this.onFocusLost();
  private onVisibilityChange = (): void => { if (document.visibilityState === 'hidden') this.onFocusLost(); };
  /**
   * Tab closing mid-solo-raid: flush the session so the last seconds of the run are not lost (2026-09-07).
   * 2026-09-11 (C-70): never flush after death — it would bring back the save `parts/Death.onLocalDied` has just
   * deleted, so a reload revives the player (the same reason as the solo guard in `parts/Session.saveRaid`, and
   * this path does not go through that function).
   */
  private onPageHide = (): void => { if (this.isSoloRaid() && this.ctx.isGameplayPhase() && !this.isLocalOut()) this.saveSolo(); };

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // 2026-09-09: publish the corpse store as `ctx.corpses` (the rescue-drop candidate list and the map read it).
    this.corpses = new PlayerCorpseManager(ctx);
    ctx.corpses = this.corpses;
    // 2026-09-10: plant the squad-leader device's point light in the scene up front — adding and removing the
    // device would change the light count, which recompiles the shader of every material in the scene
    // (the `installLeaderLight` comment in `parts/Leader`).
    Leader.installLeaderLight(this);
    // 2026-09-15: must subscribe **before** the `player:died` → `onLocalDied` (strip into the corpse) below, so
    // the carried value is measured at the moment of death.
    this.report.bind();
    this.raidXp.bind();
    /*
     * 2026-09-15 (raid-entry loading): the gate binds here too. Its `game:newMission` subscription must come
     * **before the `onNewMission` below** — if the phase rolls on before the gate takes its hold, the first
     * frame goes by bright.
     */
    this.loadGate.bind(ctx);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', ({ seed, mode, planet }) => this.onNewMission(seed, mode, planet)),
      b.on('world:ready', () => {
        // 2026-09-09: a new world holds no corpse and no squad-leader device — a client asks the host for the
        // current state.
        this.clearCorpses();
        this.ensureNetHooks();
        Corpse.requestCorpseSync(this);
        Leader.requestLeaderSync(this);
        if (!this.awaitingWorld) return;
        this.awaitingWorld = false;
        this.onWorldReady();
      }),
      b.on('player:landed', () => {
        if (ctx.phase !== 'deploying') return;
        this.setPhase('playing');
        // 2026-09-11 (E-5): the body is on the ground — the resumable snapshot takes the real pose right away
        if (this.isSoloRaid() && !ctx.rejoinPending) this.saveSolo();
      }),
      // E-5 ①: a save made in the ship is a clock reading too
      b.on('inventory:loadoutSaved', () => { if (ctx.isHubPhase()) bumpClockHigh(); }),
      b.on('hub:entered', () => bumpClockHigh()),
      b.on('extraction:activated', () => { if (ctx.phase === 'playing') this.setPhase('extracting'); }),
      b.on('extraction:shipLanded', () => { if (ctx.phase === 'extracting') this.setPhase('shipLanded'); }),
      b.on('extraction:boarded', () => { this.boarded = true; }),
      b.on('extraction:liftoff', ({ aboard, squadDone }) => {
        // 2026-09-15: the tutorial skip (`ExtractionRef.skipToComplete`) — straight to the results screen, with
        // no liftoff cinematic and no wait (`parts/Death`)
        if (Death.isTutorialSkipLiftoff(this)) { Death.completeTutorialSkip(this); return; }
        if (ctx.phase !== 'shipLanded' && ctx.phase !== 'extracting') return;
        const mine = aboard ?? true, done = squadDone ?? true;
        // 2026-09-13: left behind while someone alive stays too — the raid goes on (`extraction:reset` returns the phase).
        if (!mine && !done) return;
        this.aboardAtLiftoff = mine;
        this.squadExtraction = done;
        this.setPhase('liftoff');
        this.completeTimer = LIFTOFF_TO_COMPLETE;
      }),
      // 2026-09-13: the ship left without us → back to 'playing'; any console can call the next one.
      b.on('extraction:reset', () => {
        if (this.completeTimer >= 0) return;
        if (ctx.phase === 'extracting' || ctx.phase === 'shipLanded' || ctx.phase === 'liftoff') this.setPhase('playing');
      }),
      b.on('player:died', () => this.onLocalDied()),
      // 2026-09-13: the pause menu's `함선으로 귀환` (after the warning popup's confirm) — dies on the spot →
      // the ship once the death animation is over
      b.on('game:returnToShip', () => Death.requestReturnToShip(this)),
      // 2026-09-09: `game:respawn` is no longer subscribed to (no automatic respawn — only the rescue drop).
      b.on('player:spawned', () => { this.respawnTimer = -1; this.respawnLastSec = -1; }),
      /* ── 2026-09-09: corpses · the rescue drop · the squad-leader device ── */
      b.on('crate:looted', ({ crateId }) => Corpse.onContainerLooted(this, crateId)),
      b.on('rescue:landed', ({ target }) => Death.onRescueLanded(this, target)),
      b.on('world:cleared', () => this.clearCorpses()),
      /* Downed is NOT death: the mission keeps running and a defibrillator can still bring the player back. */
      b.on('player:downed', () => this.onLocalDowned()),
      b.on('player:revived', () => this.onLocalRevived()),
      // stats.kills / cratesOpened / damageTaken are incremented by Enemy / World / Player systems;
      // missionTime + stats.timeSeconds advance in Engine.frame(). GameFlow only finalizes them.
      b.on('game:abort', () => this.onAbort()),
      b.on('game:abort', () => this.clearCorpses()),
      b.on('game:newMission', () => this.clearCorpses()),
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
        // The training range is entered individually and is not the squad's mission — never report it as one.
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
      b.on('net:hostChanged', ({ hostId, isLocalHost }) => {
        this.onHostChanged(isLocalHost);
        // 2026-09-09: this toast has exactly one owner — picking the device up and the right-click transfer in
        // `ui/hud/Community` both end up here.
        Leader.onHostChangedToast(this, hostId, isLocalHost);
      }),
      b.on('training:exitRequested', () => this.exitTraining()),
      b.on('inventory:itemAdded', () => this.saveRaid()),
      b.on('crate:looted', () => this.saveRaid()),
      /* 2026-09-15 (user's decision): the tutorial saves **on every step and every checkpoint** — a 5 s cadence
       * does not capture the step change, so closing the game right after learning something makes that step
       * start over (`parts/Session`). */
      b.on('tutorial:changed', ({ step }) => Session.saveTutorialStep(this, step)),
      b.on('tutorial:checkpoint', () => Session.saveTutorialCheckpoint(this)),
      // The browser ate an Escape to free the cursor (`main.ts` ← `Input.onUserUnlock`) — that press was the
      // pause menu. Also fired by `onFocusLost` below, where the pause is the same outcome.
      b.on('input:pointerLockLost', () => this.escapePause()),
    );
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
    this.resumeGate = new ResumeGate(ctx);
    this.unsubs.push(installDesktopRelockHook(ctx));
    /*
     * 2026-09-07: a solo raid interrupted by a closed tab / crash is resumable for `SOLO_RAID_GRACE_MS`.
     * 2026-09-15 (title `이어하기`): the boot no longer drops straight back into it — `parts/Resume` reads the file (and the
     * squad raid marker) here and offers the raid on the title; a save already too old at boot still fails on the first frame.
     */
    this.raidResume.bind();
    // Make sure listeners know the initial phase even though ctx.phase already equals 'menu'.
    ctx.phase = 'menu';
    ctx.bus.emit('game:phaseChanged', { phase: 'menu', prev: 'menu' });
  }

  /** Mission running or its result screen showing (anything the hub / a disconnect has to abort first). */
  inMission(): boolean { return Phases.inMission(this); }

  /** Live mission (not a result screen). */
  inLiveMission(): boolean { return Phases.inLiveMission(this); }

  isTraining(): boolean { return Phases.isTraining(this); }

  /** 2026-09-14: is a tutorial raid running (death = checkpoint respawn, never a raid failure). */
  isTutorial(): boolean { return Phases.isTutorial(this); }

  /**
   * Phase 8: standing in the personal / shared ship. Esc pauses here too (the terminal is opened from the console,
   * not from Escape any more), but the pause is menu-only — `freeze` stays false so the ship keeps animating and
   * nothing mission-related (abort, stats, timers) happens.
   */
  inShip(): boolean { return Phases.inShip(this); }

  /**
   * Phase 12: no UI blocker besides the resume gate's own token. The gate is an overlay over a running game, not
   * a screen — Escape on it must open the pause menu and a window blur behind it must still pause.
   */
  noScreenOpen(): boolean { return Phases.noScreenOpen(this); }

  /* ── Multiplayer helpers ─────────────────────────────────────────────── */
  /** Subscribe to host `flow` messages once `ctx.net` exists (NetSystem publishes it before this system inits, but stay lazy). */
  ensureNetHooks(): void {
    Wire.ensureNetHooks(this);
    // 2026-09-09: corpses / the squad-leader device bind at the same moment (once each, after `net` exists).
    Corpse.hookCorpseNet(this);
    Leader.hookLeaderNet(this);
  }

  /** Mission reset: clear every corpse and the squad-leader device, disposing their geometry. */
  clearCorpses(): void {
    this.corpses?.clear();
    Leader.clearDevice(this);
  }

  /** Clients only: mirror the host's mission-level decisions. */
  onFlowMessage(msg: FlowMessage, from: PeerId): void { return Wire.onFlowMessage(this, msg, from); }

  private onLocalDied(): void { return Death.onLocalDied(this); }

  /** Emits `game:respawnAvailable` once per whole second while the respawn timer runs (and once at 0). */
  tickRespawn(): void { return Death.tickRespawn(this); }

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

  /** Host only: nobody left alive / downed / alive-as-a-ghost → `flow over` to the squad, raid failure locally. */
  checkAllDead(): void { return Death.checkAllDead(this); }

  /** Phase 7: authority moved (host migration). The new host takes the wipe check over; the old one just mirrors. */
  private onHostChanged(isLocalHost: boolean): void { return Wire.onHostChanged(this, isLocalHost); }

  /**
   * The party is gone (server gave up on us / host left / kicked) mid-mission → abort after a short toast and
   * return to the personal ship. A plain socket drop is `net:reconnecting` (handled above) and never aborts.
   */
  private onLobbyLeft(reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft' | 'moved'): void { return Wire.onLobbyLeft(this, reason); }

  /* ── Pause / focus ───────────────────────────────────────────────────── */
  /**
   * The player left the window (alt-tab, another app, a hidden tab). This is the **only** pause trigger besides
   * Escape since the 2026-09-07 cursor rework: a missing pointer lock means the mouse is being used as a cursor,
   * which is a normal in-game state now, while a missing window really is someone walking away.
   */
  private onFocusLost(): void { return Phases.onFocusLost(this); }

  /** Escape (or a pointer lock the player took away) → the pause menu. See `parts/Phases.escapePause`. */
  escapePause(): void { return Phases.escapePause(this); }

  /** One Escape: close the topmost open screen, or open the pause menu when there is none (2026-09-09). */
  escapeKey(): void { return Phases.escapeKey(this); }

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

  /** Re-enter the stored solo raid: same seed / planet, blob restored on `world:ready`, body placed (no hellpod). */
  resumeSoloRaid(save: SoloRaidSave): void { return Session.resumeSoloRaid(this, save); }

  /* ── Training range ─────────────────────────────────────────────── */
  /** The arena's exit console: leave the training, refund the inventory snapshot, back to the ship. */
  private exitTraining(): void { return Phases.exitTraining(this); }

  private onAbort(): void { return Phases.onAbort(this); }

  setPhase(phase: GamePhase): void { return Phases.setPhase(this, phase); }

  setPaused(paused: boolean, emit = true): void { return Phases.setPaused(this, paused, emit); }

  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    this.raidResume.update();   // 2026-09-15: a save already too old at boot fails · the solo grace on the title
    if (this.inLiveMission()) this.wasMultiplayerHost = ctx.isMultiplayer && (ctx.net?.isHost ?? false);

    // Escape: **close the topmost screen; with nothing to close, the pause menu** (2026-09-09) — see `escapeKey`.
    // Reached only while the pointer is already free (a screen is open); the locked case arrives as
    // `input:pointerLockLost` instead, and that one has no screen to close by definition.
    if (ctx.input.wasPressed(Keys.MENU)) { ctx.input.consume(Keys.MENU); this.escapeKey(); }
    // Phase 12: '좌측 클릭으로 게임 재개' (browser) / hidden OS cursor while nothing needs it (Electron shell). The
    // gate only ever shows once every screen **and** the pause menu are gone and the lock could not be retaken.
    this.resumeGate?.update();
    syncDesktopCursor(ctx);
    // 2026-09-10: the Alt cursor (`Keys.CURSOR` → freeing the mouse with no screen open) was removed — the cursor
    // now appears only when a screen opens.

    if (ctx.isGameplayPhase() && !this.isTraining()) {
      // Difficulty ramp 0.3 → 0.7 over 8 minutes of mission time (never on the training range).
      const t = Math.min(1, ctx.missionTime / THREAT_RAMP_SECONDS);
      const threat = THREAT_MIN + (THREAT_MAX - THREAT_MIN) * t;
      if (ctx.enemies && Math.abs(threat - this.lastThreat) > 0.01) {
        this.lastThreat = threat;
        ctx.enemies.setThreatLevel(threat);
      }
    }

    this.report.update(dt);   // 2026-09-15: low-rate polling of the peak carried value (in a raid · alive only)
    // 2026-09-15: the loading gate has to keep running inside its own hold — so it reads `ctx.time`, not `dt`
    // (with no gate it costs nothing).
    this.loadGate.update();
    if (this.completeTimer >= 0) {
      this.completeTimer -= dt;
      if (this.completeTimer < 0) this.complete();
    }
    if (this.deathTimer >= 0) {
      this.deathTimer -= dt;
      if (this.deathTimer < 0) { this.deathTimer = -1; this.gameOver(); }
    }
    // 2026-09-09: the squad-leader device on the ground pulses (a no-op when there is none).
    Leader.updateLeader(this, dt);
    // 2026-09-11 (C-18): a corpse left on a running tram rides along with it (an empty loop with no rider).
    this.corpses?.update();
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
        // 2026-09-16: the same path as a results screen's `함선으로 귀환` — fade to black → loading → fade in
        // (`ui/menus/ShipReturn` emits the `hub:enter`)
        if (ctx.phase === 'dead') ctx.bus.emit('ui:shipReturn', {});
      }
    }
    // 2026-09-14: tutorial — once the death animation ends the player stands again at the checkpoint (no failure)
    if (this.tutorialRespawnTimer >= 0) {
      this.tutorialRespawnTimer -= dt;
      if (this.tutorialRespawnTimer < 0) Death.tutorialRespawn(this);
    }
    // 2026-09-13: the voluntary return — once the death animation ends, settle up and go to the ship
    // (`parts/Death.finishReturnToShip`)
    if (this.returnTimer >= 0) {
      this.returnTimer -= dt;
      if (this.returnTimer < 0) Death.finishReturnToShip(this);
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

  /** 2026-09-15: fill `stats.peakLootValue` · `stats.death` before settlement (`RaidReport.fill` — idempotent). */
  complete(): void { this.report.fill(); return Death.complete(this); }

  /** Raid failure: solo death (after DEATH_TO_SCREEN) or a squad wipe (host decision, mirrored by `flow over`). */
  gameOver(): void { this.report.fill(); return Death.gameOver(this); }

  /**
   * Bank the mission result into the persistent profile (progression/). Runs once per mission, before the
   * result screen appears, so `game:complete` / `game:over` listeners already see the new level.
   * Raid XP = the sum of the `parts/RaidXp` cards (× `XP_DEATH_MUL` when not extracted) — 2026-09-21.
   * The training range never pays out (and never settles a contract).
   */
  awardMissionXp(): void { return Death.awardMissionXp(this); }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.report.dispose();
    this.raidXp.dispose();
    this.loadGate.dispose();
    this.raidResume.dispose();
    this.netUnsub?.(); this.netUnsub = null;
    Corpse.unhookCorpseNet(this);
    Leader.unhookLeaderNet(this);
    /*
     * 2026-09-21: the manager holds a `pcorpse` subscription of its own (the `ride` note — `Corpses.hookNet`), which
     * is **not** `sys.corpseUnsubs` above and **not** dropped by `clearCorpses()` (a mission reset keeps listening).
     * The system's teardown is the one place that releases it.
     */
    this.corpses?.dispose();
    this.clearCorpses();
    if (this.ctx?.corpses === this.corpses) this.ctx.corpses = null;
    this.corpses = null;
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
    this.resumeGate?.dispose(); this.resumeGate = null;
    document.body.classList.remove('desktop-nocursor');
  }
}
