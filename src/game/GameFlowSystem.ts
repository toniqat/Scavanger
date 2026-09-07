import * as THREE from 'three';
import type {
  GameContext, GameSystem, GamePhase, FlowMessage, PeerId, MissionMode, RaidSessionBlob, PlayerRestoreState, RemotePlayerRef,
} from '@/shared';
/* appended (Phase 11): 목표 행성 */
import type { PlanetId } from '@/shared';
import {
  GameContext as Ctx, Keys, PlayerFlags, PLAYER_RESPAWN_DELAY, RAID_FAILED_AUTO_RETURN_S, RAID_SAVE_INTERVAL_S,
  NET_GHOST_RESTORE_TIMEOUT_S,
} from '@/shared';
/* appended (2026-09-07, 커서 rework): Alt 커서 blocker token */
import { FREE_CURSOR_BLOCKER } from '@/shared';
/* appended (2026-09-07): 솔로 레이드 로컬 세션 저장 — the single-player counterpart of the relay's raid store */
import { clearSoloRaid, loadSoloRaid, saveSoloRaid, soloRaidStatus, type SoloRaidSave } from './SoloRaid';

const LIFTOFF_TO_COMPLETE = 6.5;   // seconds after extraction:liftoff
const DEATH_TO_SCREEN = 2.5;       // seconds after player:died (single-player only)
/**
 * Phase 7: a squad wipe (or a solo death) fails the raid again. Individual respawns (PLAYER_RESPAWN_DELAY) stay
 * available in a squad until nobody is left alive / downed / alive-as-a-ghost.
 */
const MISSION_FAILS_WHEN_ALL_DEAD = true;
const THREAT_MIN = 0.3;
const THREAT_MAX = 0.7;
const THREAT_RAMP_SECONDS = 8 * 60;
/** Multiplayer host: how often the "is everyone dead?" check re-runs while the local player is dead. */
const ALL_DEAD_CHECK_INTERVAL = 0.5;
/** Multiplayer: seconds between the connection-lost toast and the automatic abort to the menu. */
const DISCONNECT_ABORT_DELAY = 2;

/* ── mission-end character XP (progression) ─────────────────────────────────
 * Kept here (not in progression/) because GameFlow owns the mission result. Progression only
 * banks the number through `ctx.progression.addXp`.
 */
const XP_PER_KILL = 12;
/** Loot is only banked when the player actually got out with it. */
const XP_PER_LOOT_VALUE = 0.08;
/** Flat bonus for a successful extraction. */
const XP_EXTRACT_BONUS = 300;
/** Per minute survived, capped at XP_TIME_CAP. */
const XP_PER_MINUTE = 20;
const XP_TIME_CAP = 300;
/** A wiped squad still learns something: kills count at this fraction. */
const XP_DEATH_MUL = 0.4;

/**
 * Mission phase state machine + stats + pause + difficulty ramp.
 * menu → deploying → playing → extracting → shipLanded → liftoff → complete | dead
 *
 * Multiplayer (all gated on `ctx.isMultiplayer`; single-player behaviour is unchanged):
 *   - Pause only shows the menu (`game:paused {freeze:false}`) — the world keeps running.
 *   - A dead player does not change phase; the host ends the raid (`flow over`) once *everyone* is out.
 *   - `flow` messages from the host mirror over / complete / abort on the clients.
 *   - `stats.extracted` = boarded && alive at completion (left-behind / dead players get `false`).
 *
 * Ship hub (phases 'hub' / 'docking' are owned by hub/HubSystem and are NOT gameplay):
 *   - Phase 8: Escape in 'hub' with no blocker opens the **pause menu** (`game:paused {freeze:false}`) — the ship keeps
 *     animating and no mission side effect (abort / stats / timers) is produced. 'docking' (the cutscene) never pauses.
 *   - `hub:enter` while a mission / result phase is active → HubSystem emits `game:abort` first (we go to 'menu'),
 *     then it builds the ship and sets 'hub'. A mission may start from 'hub' (`game:newMission` from the launch pod,
 *     `ctx.net.startGame` or `ctx.net.rejoinMission`).
 *   - After an abort that ends a *lobby* mission (host `flow abort`, 로비로, 임무 포기) we emit `hub:enter shared` one
 *     microtask later so the squad regroups in the shared ship. Solo aborts keep the legacy title-menu behaviour.
 *   - Reconnection: `net:reconnecting` never aborts (toast only); `net:resumed {seamless:false}` aborts → shared ship;
 *     `net:lobbyLeft` (party gone) aborts after 2 s → personal ship.
 *
 * Phase 7 (known follow-ups):
 *   - Squad wipe = raid failure (`game:raidFailed` + `game:over`, auto return to the ship after RAID_FAILED_AUTO_RETURN_S).
 *   - Raid session blob (`ctx.net.saveRaid`) every RAID_SAVE_INTERVAL_S / on loot; rejoin restores it + the host's ghost.
 *   - 시뮬레이션 훈련장 (`ctx.missionMode === 'training'`): no XP / settlement / threat, death = instant respawn,
 *     `training:exitRequested` → abort + inventory snapshot restored + back to the ship.
 *   - Host takeover (`net:hostChanged {isLocalHost:true}`): the new host runs the wipe check and sends `flow`.
 */
export class GameFlowSystem implements GameSystem {
  readonly name = 'gameflow';
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  private netUnsub: (() => void) | null = null;

  private awaitingWorld = false;
  private completeTimer = -1;
  private deathTimer = -1;
  /** Phase 2: seconds until a respawn is allowed (−1 = not dead / not running). */
  private respawnTimer = -1;
  private respawnLastSec = -1;
  private paused = false;
  private lastThreat = -1;

  /* ── multiplayer ── */
  /** Local player entered the dropship bay (cleared on death / new mission). */
  private boarded = false;
  /** Host: > 0 while the local player is dead → periodic all-dead check. */
  private allDeadCheckTimer = -1;
  /** > 0 after the lobby/server vanished mid-mission → abort when it expires. */
  private disconnectAbortTimer = -1;
  /** Cached each frame so `game:abort` can still reach the squad after NetSystem tore the session down. */
  private wasMultiplayerHost = false;
  /** Mission-end XP is banked exactly once per mission (complete() and gameOver() are both idempotent). */
  private rewarded = false;

  /* ── Phase 7 ── */
  /** > 0 on the 레이드 실패 screen → automatic `hub:enter` when it expires. */
  private autoReturnTimer = -1;
  /** Raid session upload cadence (multiplayer raid only). */
  private raidSaveTimer = -1;
  /** Blob the server handed back with `welcome` (resume into a running raid); applied after the rejoin's `world:ready`. */
  private raidBlob: RaidSessionBlob | null = null;
  /** true between `net:gameStarting {rejoin:true}` and the restore / fallback. */
  private rejoining = false;
  /** 솔로 레이드 found in localStorage at boot and not consumed yet (`resumeSoloRaid` / `failSoloRaid`). */
  private soloPending: SoloRaidSave | null = null;
  /** true when the stored solo raid was already past `SOLO_RAID_GRACE_MS` at boot → 레이드 실패 on the first frame. */
  private soloExpired = false;
  /** Pose to hand `restoreState` once the resumed world is ready (solo counterpart of the host's `ghost restore`). */
  private soloRestore: PlayerRestoreState | null = null;
  /** > 0 while waiting for the host's `ghost restore` after a rejoin. */
  private restoreTimer = -1;
  /** Inventory as it was when the 훈련장 was entered (ammo / durability are refunded on exit). */
  private trainingSnapshot: unknown = null;
  /**
   * 2026-09-07 (커서 rework): **a lost pointer lock is no longer a pause.**
   *
   * Releasing the lock is now how every screen shows the mouse, and Chrome drops it on any Escape, so treating the
   * missing lock as "the player left" is what made the game freeze every time the cursor appeared. Only losing the
   * *window* means the player really left — that still pauses, exactly like alt-tabbing out of any other game.
   */
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
  private inMission(): boolean {
    const p = this.ctx.phase;
    return this.ctx.isGameplayPhase() || p === 'deploying' || p === 'complete' || p === 'dead';
  }

  /** Live mission (not a result screen). */
  private inLiveMission(): boolean {
    return this.ctx.isGameplayPhase() || this.ctx.phase === 'deploying';
  }

  private isTraining(): boolean {
    return this.ctx.missionMode === 'training';
  }

  /**
   * Phase 8: standing in the personal / shared ship. Esc pauses here too (the terminal is opened from the console,
   * not from Escape any more), but the pause is menu-only — `freeze` stays false so the ship keeps animating and
   * nothing mission-related (abort, stats, timers) happens.
   */
  private inShip(): boolean {
    return this.ctx.phase === 'hub';
  }

  /* ── Multiplayer helpers ─────────────────────────────────────────────── */
  /** Subscribe to host `flow` messages once `ctx.net` exists (NetSystem publishes it before this system inits, but stay lazy). */
  private ensureNetHooks(): void {
    const net = this.ctx.net;
    if (!net || this.netUnsub) return;
    this.netUnsub = net.onMessage('flow', (msg, from) => this.onFlowMessage(msg, from));
  }

  /** Clients only: mirror the host's mission-level decisions. */
  private onFlowMessage(msg: FlowMessage, from: PeerId): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!net || !ctx.isMultiplayer || net.isHost) return;
    const hostId = net.lobby?.hostId;
    if (hostId && from !== hostId) return;
    switch (msg.ev) {
      case 'over':
        // the host decided the squad is wiped → 레이드 실패 for everyone
        if (this.inLiveMission()) this.gameOver();
        break;
      case 'complete':
        if (this.inLiveMission()) this.complete();
        break;
      case 'abort':
        // host aborted the mission → the whole squad regroups in the shared ship (onAbort schedules hub:enter)
        if (this.inMission()) ctx.bus.emit('game:abort', {});
        break;
      case 'phase':
      case 'rejoined':
      case 'takeover':
        // `takeover` is translated into `net:hostChanged {isLocalHost:false}` by NetSystem; phases are derived locally.
        break;
    }
  }

  private onLocalDied(): void {
    const ctx = this.ctx;
    if (!this.inLiveMission()) return;
    this.boarded = false;
    // 훈련장: no failure, no respawn timer — straight back onto the arena spawn.
    if (this.isTraining()) {
      this.setPaused(false);
      this.respawnTimer = -1; this.respawnLastSec = -1;
      const spawn = ctx.world?.getPlayerSpawn();
      if (spawn) {
        ctx.bus.emit('ui:notify', { text: '시뮬레이션 재시작', kind: 'info', duration: 2 });
        ctx.bus.emit('player:respawn', { position: spawn.clone() });
      }
      return;
    }
    if (!ctx.isMultiplayer) {
      // Solo: the raid is lost the moment the player dies (Phase 7) — the death screen (레이드 실패) follows the usual delay.
      if (this.deathTimer >= 0) return;
      this.respawnTimer = -1; this.respawnLastSec = -1;
      this.deathTimer = DEATH_TO_SCREEN;
      this.setPaused(false);
      return;
    }
    // Multiplayer: the phase stays — the squad (and the host simulation) keeps going. The UI shows a spectate overlay;
    // a respawn (hellpod at the mission spawn) unlocks after PLAYER_RESPAWN_DELAY unless the squad is wiped first.
    this.respawnTimer = PLAYER_RESPAWN_DELAY;
    this.respawnLastSec = -1;
    this.tickRespawn();
    this.setPaused(false);
    ctx.bus.emit('ui:notify', { text: `전사 — ${PLAYER_RESPAWN_DELAY}초 후 부활 가능`, kind: 'danger', duration: 4 });
    if (MISSION_FAILS_WHEN_ALL_DEAD) {
      this.allDeadCheckTimer = ALL_DEAD_CHECK_INTERVAL;
      this.checkAllDead();
    }
  }

  /** Emits `game:respawnAvailable` once per whole second while the respawn timer runs (and once at 0). */
  private tickRespawn(): void {
    const sec = Math.max(0, Math.ceil(this.respawnTimer));
    if (sec === this.respawnLastSec) return;
    this.respawnLastSec = sec;
    this.ctx.bus.emit('game:respawnAvailable', { seconds: sec });
  }

  /** `game:respawn` (UI): honoured only while dead, after the delay and while the raid is still running (never on 레이드 실패). */
  private onRespawnRequest(): void {
    const ctx = this.ctx;
    if (!(ctx.player?.isDead ?? false)) return;
    if (this.respawnTimer !== 0) return;
    if (!this.inLiveMission()) return;
    const spawn = ctx.world?.getPlayerSpawn();
    if (!spawn) return;
    this.deathTimer = -1; this.respawnTimer = -1; this.respawnLastSec = -1;
    ctx.bus.emit('player:respawn', { position: spawn.clone() });
  }

  /** Downed (tactical kit hook): the mission keeps running — a squadmate or a defibrillator can still bring the player back. */
  private onLocalDowned(): void {
    if (!this.inLiveMission()) return;
    this.setPaused(false);
    // The all-dead check treats a downed player as alive, but a squadmate may be dead already: re-run it
    // so a wipe that happens while we bleed out is still noticed.
    this.allDeadCheckTimer = ALL_DEAD_CHECK_INTERVAL;
  }

  private onLocalRevived(): void {
    if (!(this.ctx.player?.isDead ?? false)) this.allDeadCheckTimer = -1;
  }

  /** True when a player is out of the fight for good — downed players are still revivable. */
  private isLocalOut(): boolean {
    const p = this.ctx.player;
    if (!p) return false;
    return p.isDead && !(p.isDowned ?? false);
  }

  /**
   * Is this remote member still "in the fight"? Ghost-aware (Phase 7):
   *   - not part of the mission (`inMission` false / IN_HUB / left) → ignored (returns false);
   *   - suspended (socket down, host simulates a ghost) → alive unless the ghost is dead (`state` 2);
   *   - otherwise alive unless dead-and-not-downed (a downed peer can still be revived).
   */
  private isRemoteAlive(r: RemotePlayerRef): boolean {
    if (!r.connected || !r.inMission || (r.flags & PlayerFlags.IN_HUB) !== 0) return false;
    const downed = (r.isDowned ?? false) || (r.flags & PlayerFlags.DOWNED) !== 0;
    if (r.suspended) {
      // Phase 9: the host ghost's state sits on the ref (net's `applyGhost` / the host's own `applyToRef`)
      if (r.ghostState !== undefined) return r.ghostState !== 2;
      return !r.isDead || downed;
    }
    return !r.isDead || downed;
  }

  /** Host only: nobody left alive / downed / alive-as-a-ghost → `flow over` to the squad and 레이드 실패 locally. */
  private checkAllDead(): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!MISSION_FAILS_WHEN_ALL_DEAD) return;
    if (!net || !ctx.isMultiplayer || !net.isHost) return;
    if (this.isTraining()) return;
    if (!this.inLiveMission()) return;
    if (!this.isLocalOut()) return;
    for (const r of net.getRemotePlayers()) if (this.isRemoteAlive(r)) return;
    this.allDeadCheckTimer = -1;
    net.send({ t: 'flow', ev: 'over' }, 'others');
    this.gameOver();
  }

  /** Phase 7: authority moved (host migration). The new host takes the wipe check over; the old one just mirrors. */
  private onHostChanged(isLocalHost: boolean): void {
    if (!this.inLiveMission()) return;
    if (!isLocalHost) { this.allDeadCheckTimer = -1; return; }
    this.wasMultiplayerHost = true;
    if (this.isLocalOut() || (this.ctx.player?.isDowned ?? false)) this.allDeadCheckTimer = ALL_DEAD_CHECK_INTERVAL;
    this.checkAllDead();
  }

  /**
   * The party is gone (server gave up on us / host left / kicked) mid-mission → abort after a short toast and
   * return to the personal ship. A plain socket drop is `net:reconnecting` (handled above) and never aborts.
   */
  private onLobbyLeft(reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft'): void {
    const ctx = this.ctx;
    if (reason === 'left') return;                       // we chose to leave (abort / menu) — nothing to do
    if (!this.inLiveMission()) return;
    if (this.disconnectAbortTimer >= 0) return;
    const text = reason === 'hostLeft' ? '호스트가 나갔습니다 — 함선으로 복귀' : reason === 'kicked' ? '분대에서 분리되었습니다' : '연결이 끊어졌습니다 — 함선으로 복귀';
    ctx.bus.emit('ui:notify', { text, kind: 'danger', duration: DISCONNECT_ABORT_DELAY });
    this.disconnectAbortTimer = DISCONNECT_ABORT_DELAY;
  }

  /* ── Pause / focus ───────────────────────────────────────────────────── */
  /**
   * The player left the window (alt-tab, another app, a hidden tab). This is the **only** pause trigger besides
   * Escape since the 2026-09-07 커서 rework: a missing pointer lock means the mouse is being used as a cursor, which
   * is a normal in-game state now, while a missing window really is someone walking away.
   */
  private onFocusLost(): void {
    const ctx = this.ctx;
    if (this.paused || !ctx.isGameplayPhase() || ctx.uiBlockers.size > 0) return;
    if (ctx.player?.isDead ?? false) return;
    ctx.bus.emit('input:pointerLockLost', {});
    this.setPaused(true);
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
  private toggleFreeCursor(on?: boolean): void {
    const ctx = this.ctx;
    const want = on ?? !ctx.uiBlockers.has(FREE_CURSOR_BLOCKER);
    if (want === ctx.uiBlockers.has(FREE_CURSOR_BLOCKER)) return;
    if (want) {
      // Only where the pointer is actually captured — never over another screen, a menu or a result phase.
      if (ctx.uiBlockers.size > 0 || !(ctx.isGameplayPhase() || this.inShip())) return;
      if (ctx.player?.isDead ?? false) return;
      ctx.uiBlockers.add(FREE_CURSOR_BLOCKER);
      ctx.input.setCursorMode(true, FREE_CURSOR_BLOCKER);
      window.addEventListener('mousedown', this.onFreeCursorClick);
    } else {
      window.removeEventListener('mousedown', this.onFreeCursorClick);
      ctx.uiBlockers.delete(FREE_CURSOR_BLOCKER);
      ctx.input.setCursorMode(false, FREE_CURSOR_BLOCKER);
    }
    ctx.bus.emit('ui:freeCursorToggled', { active: want });
  }

  /** Left click on the world while the Alt 커서 is up = 카메라 복귀 (see `toggleFreeCursor`). */
  private readonly onFreeCursorClick = (e: MouseEvent): void => {
    if (e.button !== 0 || e.target !== this.ctx.canvas) return;
    this.toggleFreeCursor(false);
  };

  /* ── Mission start / rejoin ──────────────────────────────────────────── */
  /** NetSystem announces a session start right before its `game:newMission`; `rejoin` = re-entering a running mission. */
  private onGameStarting(rejoin: boolean, mode: MissionMode | undefined): void {
    const ctx = this.ctx;
    this.rejoining = rejoin && mode !== 'training';
    // The player must not hellpod-drop on `world:ready`: the host hands our body back with `ghost restore`.
    ctx.rejoinPending = this.rejoining;
    if (this.rejoining && !this.raidBlob && ctx.net?.raidBlob) this.raidBlob = ctx.net.raidBlob;
  }

  private onNewMission(seed: number, mode: MissionMode | undefined, planet?: PlanetId | null): void {
    const ctx = this.ctx;
    // The emitter (hub / net) sets `ctx.missionMode` before emitting; re-confirm from the event, else from the generated world.
    ctx.missionMode = mode ?? ctx.world?.mode ?? 'raid';
    /*
     * Phase 11: same contract for the 목표 행성 — the emitter sets `ctx.missionPlanet` first, this only re-confirms it.
     * A training has no planet; `MissionComplete`'s 다시 배치 re-emits with the planet it was launched with, and an
     * emit without the field (an older path) keeps whatever the ship last flew to rather than silently rerolling.
     */
    ctx.missionPlanet = this.isTraining() ? null : (planet ?? ctx.missionPlanet);
    this.setPaused(false);
    this.completeTimer = -1;
    this.deathTimer = -1; this.respawnTimer = -1; this.respawnLastSec = -1;
    this.lastThreat = -1;
    this.boarded = false;
    this.allDeadCheckTimer = -1;
    this.disconnectAbortTimer = -1;
    this.autoReturnTimer = -1;
    this.restoreTimer = -1;
    this.rewarded = false;
    ctx.stats = Ctx.freshStats(seed);
    ctx.stats.mode = ctx.missionMode;
    ctx.missionTime = 0;
    ctx.uiBlockers.delete('menu');
    if (!this.rejoining) ctx.rejoinPending = false;
    // 훈련장: remember the inventory so ammo / durability spent on the range are refunded on exit.
    this.trainingSnapshot = this.isTraining() ? (ctx.inventory?.captureRaidState() ?? null) : null;
    this.raidSaveTimer = (this.isRaidSession() || this.isSoloRaid()) ? RAID_SAVE_INTERVAL_S : -1;
    this.awaitingWorld = true;
    this.ensureNetHooks();
    // WorldSystem generates synchronously inside its own handler; if it already ran (registered earlier),
    // ctx.world.ready is true and world:ready has been emitted before we got here → handle immediately.
    // (world:ready listeners above would have been skipped because awaitingWorld was false at that time.)
    if (ctx.world?.ready && ctx.world.seed === seed && ctx.phase !== 'deploying') {
      this.awaitingWorld = false;
      this.onWorldReady();
    }
  }

  /** World generated: deploy — or, on a rejoin, restore the raid blob and wait for the host's ghost. */
  private onWorldReady(): void {
    const ctx = this.ctx;
    this.setPhase('deploying');
    if (!this.rejoining) return;
    this.rejoining = false;
    const blob = this.raidBlob;
    this.raidBlob = null;
    if (blob && blob.seed === ctx.stats.seed) {
      try {
        const applied = ctx.inventory?.applyRaidState(blob.inventory) ?? false;
        ctx.stats = { ...blob.stats, seed: ctx.stats.seed, mode: ctx.missionMode };
        ctx.missionTime = Math.max(0, blob.missionTime);
        ctx.stats.timeSeconds = ctx.missionTime;
        this.rewarded = false;
        ctx.bus.emit('ui:notify', { text: applied ? '레이드 세션 복원됨' : '레이드 진행 상황 복원됨', kind: 'info', duration: 3 });
      } catch (e) {
        console.error('[gameflow] raid blob restore failed', e);
      }
    }
    // Solo resume: there is no host to answer `flow rejoined` — we already hold the body state ourselves.
    const solo = this.soloRestore;
    if (solo) {
      this.soloRestore = null;
      this.onGhostRestore(solo);
      return;
    }
    // The host answers our `flow rejoined` with `ghost restore`; if it never comes, drop in normally.
    this.restoreTimer = NET_GHOST_RESTORE_TIMEOUT_S;
  }

  /** `ghost restore` from the host: stand where the ghost was; a dead ghost enters the respawn flow. */
  private onGhostRestore(state: PlayerRestoreState): void {
    const ctx = this.ctx;
    if (!ctx.rejoinPending && this.restoreTimer < 0) return;
    if (!this.inLiveMission()) return;
    this.restoreTimer = -1;
    ctx.rejoinPending = false;
    this.rejoining = false;
    try { ctx.player?.restoreState(state); } catch (e) { console.error('[gameflow] restoreState failed', e); }
    if (ctx.phase === 'deploying') this.setPhase('playing');
    if (state.state === 2) {
      // Our body bled out while we were away: the usual squad death flow (spectate + timed respawn) applies.
      this.respawnTimer = PLAYER_RESPAWN_DELAY;
      this.respawnLastSec = -1;
      this.tickRespawn();
      ctx.bus.emit('ui:notify', { text: `전사 상태로 복귀 — ${PLAYER_RESPAWN_DELAY}초 후 부활 가능`, kind: 'danger', duration: 4 });
      this.allDeadCheckTimer = ALL_DEAD_CHECK_INTERVAL;
      this.checkAllDead();
    } else {
      ctx.bus.emit('ui:notify', { text: '임무 복귀', kind: 'success', duration: 2.5 });
    }
  }

  /** No `ghost restore` within NET_GHOST_RESTORE_TIMEOUT_S → normal hellpod drop at the mission spawn. */
  private restoreFallback(): void {
    const ctx = this.ctx;
    this.restoreTimer = -1;
    ctx.rejoinPending = false;
    this.rejoining = false;
    if (!this.inLiveMission()) return;
    const spawn = ctx.world?.getPlayerSpawn();
    if (spawn) ctx.player?.respawn(spawn.clone());
  }

  /* ── Raid session (multiplayer raid only) ────────────────────────────── */
  private isRaidSession(): boolean {
    return this.ctx.isMultiplayer && this.ctx.missionMode === 'raid' && !!this.ctx.net;
  }

  /** Solo raid: no relay to upload to, so the session is mirrored into localStorage instead (`SoloRaid.ts`). */
  private isSoloRaid(): boolean {
    return !this.ctx.isMultiplayer && this.ctx.missionMode === 'raid';
  }

  /** Upload my mid-raid state so a reconnect can resume it (`RaidSessionBlob`) — or, solo, write it to localStorage. */
  private saveRaid(): void {
    const ctx = this.ctx;
    if (!ctx.isGameplayPhase() || ctx.rejoinPending) return;
    if (this.isSoloRaid()) { this.saveSolo(); return; }
    if (!this.isRaidSession()) return;
    const net = ctx.net!;
    if (typeof net.saveRaid !== 'function') return;
    try {
      const inventory = ctx.inventory?.captureRaidState() ?? null;
      net.saveRaid({ seed: ctx.stats.seed, missionTime: ctx.missionTime, stats: { ...ctx.stats }, inventory, savedAt: Date.now() });
    } catch (e) {
      console.error('[gameflow] raid save failed', e);
    }
    this.raidSaveTimer = RAID_SAVE_INTERVAL_S;
  }

  /** Mirror the live solo raid (seed / planet / clock / stats / inventory / body) into localStorage. */
  private saveSolo(): void {
    const ctx = this.ctx;
    const p = ctx.player;
    if (!p) return;
    try {
      saveSoloRaid({
        v: 1,
        savedAt: Date.now(),
        seed: ctx.stats.seed,
        planet: ctx.missionPlanet ?? null,
        missionTime: ctx.missionTime,
        stats: { ...ctx.stats },
        inventory: ctx.inventory?.captureRaidState() ?? null,
        pose: {
          x: p.position.x, y: p.position.y, z: p.position.z, yaw: p.yaw,
          hp: p.hp, downHp: p.downHp,
          state: p.isDead ? 2 : p.isDowned ? 1 : 0,
        },
      });
    } catch (e) {
      console.error('[gameflow] solo raid save failed', e);
    }
    this.raidSaveTimer = RAID_SAVE_INTERVAL_S;
  }

  /**
   * First frame after boot: either drop back into the stored solo raid (inside `SOLO_RAID_GRACE_MS`) or count it as
   * a 레이드 실패. Runs once — both fields are cleared before anything is emitted.
   */
  private consumeStoredSoloRaid(): void {
    const ctx = this.ctx;
    const save = this.soloPending;
    const expired = this.soloExpired;
    this.soloPending = null;
    this.soloExpired = false;
    if (ctx.phase !== 'menu') return;   // already somewhere else (a lobby resume beat us to it): leave it alone
    if (expired) {
      // Losing the kit is what `game:abort` outside a completed mission already does (inventory resets to the
      // starter and saves), so the failure needs no special case beyond the message.
      ctx.bus.emit('game:abort', {});
      ctx.bus.emit('ui:notify', { text: '복귀가 너무 늦었습니다 — 레이드 실패', kind: 'danger', duration: 6 });
      return;
    }
    if (!save) return;
    this.resumeSoloRaid(save);
  }

  /** Re-enter the stored solo raid: same seed / planet, blob restored on `world:ready`, body placed (no hellpod). */
  private resumeSoloRaid(save: SoloRaidSave): void {
    const ctx = this.ctx;
    this.rejoining = true;
    ctx.rejoinPending = true;
    ctx.missionMode = 'raid';
    ctx.missionPlanet = save.planet;
    this.raidBlob = { seed: save.seed, missionTime: save.missionTime, stats: save.stats, inventory: save.inventory, savedAt: save.savedAt };
    this.soloRestore = {
      position: new THREE.Vector3(save.pose.x, save.pose.y, save.pose.z),
      yaw: save.pose.yaw, hp: save.pose.hp, downHp: save.pose.downHp, state: save.pose.state,
    };
    ctx.bus.emit('ui:notify', { text: '중단된 레이드를 이어서 진행합니다', kind: 'warning', duration: 5 });
    ctx.bus.emit('game:newMission', { seed: save.seed, mode: 'raid', planet: save.planet ?? undefined });
  }

  /* ── 훈련장 ─────────────────────────────────────────────────────────── */
  /** The arena's exit console: leave the training, refund the inventory snapshot, back to the ship. */
  private exitTraining(): void {
    const ctx = this.ctx;
    if (!this.isTraining() || !this.inMission()) return;
    const snapshot = this.trainingSnapshot;
    this.trainingSnapshot = null;
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

  private onAbort(): void {
    const ctx = this.ctx;
    const fromMission = this.inMission();
    // Host abort *during* the mission → the whole squad returns to the ship together. A client aborting only leaves for
    // itself; leaving a result screen (complete / dead) is always local — the mission is already over for everyone.
    // A training is personal: leaving it never aborts the others.
    const live = this.inLiveMission();
    if (ctx.net && live && !this.isTraining() && (this.wasMultiplayerHost || (ctx.isMultiplayer && ctx.net.isHost))) {
      ctx.net.send({ t: 'flow', ev: 'abort' }, 'others');
    }
    this.wasMultiplayerHost = false;
    // Lobby mission ended by an abort → regroup in the shared ship. Deferred one microtask: if the abort came from
    // HubSystem's own `hub:enter` the ship is already being built (phase 'hub') and this is a no-op.
    if (fromMission && ctx.net?.lobby) {
      queueMicrotask(() => { if (ctx.phase === 'menu' && ctx.net?.lobby) ctx.bus.emit('hub:enter', { ship: 'shared' }); });
    }
    this.setPaused(false);
    this.completeTimer = -1;
    this.deathTimer = -1; this.respawnTimer = -1; this.respawnLastSec = -1;
    this.boarded = false;
    this.allDeadCheckTimer = -1;
    this.disconnectAbortTimer = -1;
    this.autoReturnTimer = -1;
    this.raidSaveTimer = -1;
    this.restoreTimer = -1;
    this.rejoining = false;
    this.raidBlob = null;
    this.soloRestore = null;
    clearSoloRaid();          // quitting to the ship / title ends the solo session (the kit resets below)
    ctx.rejoinPending = false;
    this.rewarded = false;
    this.awaitingWorld = false;
    ctx.uiBlockers.delete('inventory');
    ctx.inventory?.closeAll();
    this.setPhase('menu');
  }

  private setPhase(phase: GamePhase): void {
    this.ctx.setPhase(phase);
  }

  private setPaused(paused: boolean, emit = true): void {
    if (this.paused === paused) return;
    if (paused && !this.ctx.isGameplayPhase() && !this.inShip()) return;
    this.paused = paused;
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
    if (emit) this.ctx.bus.emit('game:paused', { paused, freeze });
  }

  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    if (this.soloPending || this.soloExpired) this.consumeStoredSoloRaid();
    if (this.inLiveMission()) this.wasMultiplayerHost = ctx.isMultiplayer && (ctx.net?.isHost ?? false);

    // Escape: toggle pause (not while another UI blocker — inventory / map / terminal — is open; those
    // consume Escape in a capture-phase listener anyway). Phase 8: the ship pauses on Escape as well,
    // except while the housing / 함선 관리 mode owns the key (it cancels the placement instead).
    if (ctx.input.wasPressed(Keys.MENU)) {
      if (this.paused) this.setPaused(false);
      // Alt 커서 is the innermost thing Escape can close (it holds a blocker, so the branch below would skip anyway).
      else if (ctx.uiBlockers.has(FREE_CURSOR_BLOCKER)) { this.toggleFreeCursor(false); ctx.input.consume(Keys.MENU); }
      else if (ctx.uiBlockers.size === 0 && !(ctx.player?.isDead ?? false)
        && (ctx.isGameplayPhase() || (this.inShip() && !(ctx.housing?.housingMode ?? false)))) this.setPaused(true);
    }
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

  private complete(): void {
    const ctx = this.ctx;
    if (ctx.phase === 'complete' || ctx.phase === 'dead' || ctx.phase === 'menu') return;
    // Multiplayer: a dead, downed or left-behind player still sees the result screen, but did not extract.
    const outOfAction = (ctx.player?.isDead ?? false) || (ctx.player?.isDowned ?? false);
    ctx.stats.extracted = ctx.isMultiplayer ? (this.boarded && !outOfAction) : true;
    ctx.stats.lootValue = ctx.inventory?.getTotalValue() ?? 0;
    ctx.stats.timeSeconds = ctx.missionTime;
    ctx.stats.mode = ctx.missionMode;
    ctx.uiBlockers.delete('inventory');
    ctx.inventory?.closeAll();
    this.completeTimer = -1;
    this.allDeadCheckTimer = -1;
    this.raidSaveTimer = -1;
    clearSoloRaid();          // the run is over — nothing left to resume
    this.awardMissionXp();
    // Host: make sure every client (even one that missed the liftoff message) reaches the result screen.
    if (ctx.isMultiplayer && ctx.net?.isHost) ctx.net.send({ t: 'flow', ev: 'complete' }, 'others');
    this.setPhase('complete');
    ctx.bus.emit('game:complete', { stats: { ...ctx.stats } });
  }

  /** 레이드 실패: solo death (after DEATH_TO_SCREEN) or a squad wipe (host decision, mirrored by `flow over`). */
  private gameOver(): void {
    const ctx = this.ctx;
    if (ctx.phase === 'complete' || ctx.phase === 'dead' || ctx.phase === 'menu') return;
    if (this.isTraining()) return;
    ctx.stats.extracted = false;
    ctx.stats.lootValue = ctx.inventory?.getTotalValue() ?? 0;
    ctx.stats.timeSeconds = ctx.missionTime;
    ctx.stats.mode = ctx.missionMode;
    ctx.uiBlockers.delete('inventory');
    ctx.inventory?.closeAll();
    this.deathTimer = -1; this.respawnTimer = -1; this.respawnLastSec = -1;
    this.allDeadCheckTimer = -1;
    this.raidSaveTimer = -1;
    this.restoreTimer = -1;
    clearSoloRaid();          // 레이드 실패 — the stored session must not resurrect the run
    ctx.rejoinPending = false;
    this.awardMissionXp();
    const stats = { ...ctx.stats };
    ctx.bus.emit('game:raidFailed', { stats });
    this.setPhase('dead');
    ctx.bus.emit('game:over', { stats });
    this.autoReturnTimer = RAID_FAILED_AUTO_RETURN_S;
  }

  /**
   * Bank the mission result into the persistent profile (progression/). Runs once per mission, before the
   * result screen appears, so `game:complete` / `game:over` listeners already see the new level.
   * Loot XP is only paid on a successful extraction — dying leaves the bag on the ground.
   * A 훈련장 never pays out (and never settles a contract).
   */
  private awardMissionXp(): void {
    if (this.rewarded) return;
    this.rewarded = true;
    if (this.isTraining()) return;
    const ctx = this.ctx;
    const prog = ctx.progression;
    if (!prog) return;
    try {
      const s = ctx.stats;
      const extracted = s.extracted;
      let xp = Math.max(0, s.kills) * XP_PER_KILL * (extracted ? 1 : XP_DEATH_MUL);
      xp += Math.min(XP_TIME_CAP, (Math.max(0, s.timeSeconds) / 60) * XP_PER_MINUTE);
      if (extracted) xp += XP_EXTRACT_BONUS + Math.max(0, s.lootValue) * XP_PER_LOOT_VALUE;
      xp = Math.round(xp);

      // `raids` / `extractions` are plain profile counters; ProgressionRef has no setter, so bump + save.
      prog.profile.raids += 1;
      if (extracted) prog.profile.extractions += 1;
      const levelBefore = prog.level;
      // Phase 5: settle the active corp contract first — its XP reward is paid through `addXp` below.
      let contract = null;
      const meta = ctx.meta;
      if (meta && typeof meta.settleMission === 'function') {
        try { contract = meta.settleMission(s); } catch (e) { console.error('[gameflow] contract settlement failed', e); }
      }
      if (contract?.success && contract.xp > 0) xp += contract.xp;
      if (xp > 0) prog.addXp(xp);
      prog.save();
      // Result screens (ui) read the rewards from the `game:complete` / `game:over` stats payload.
      s.rewards = { xpEarned: xp, levelBefore, levelAfter: prog.level, xp: prog.xp, xpToNext: prog.xpToNext, contract };
    } catch (e) {
      console.error('[gameflow] mission XP award failed', e);
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.netUnsub?.(); this.netUnsub = null;
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('mousedown', this.onFreeCursorClick);
  }
}
