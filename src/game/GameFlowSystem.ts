import type { GameContext, GameSystem, GamePhase, FlowMessage, PeerId } from '@/shared';
import { GameContext as Ctx, Keys, PlayerFlags } from '@/shared';

const LIFTOFF_TO_COMPLETE = 6.5;   // seconds after extraction:liftoff
const DEATH_TO_SCREEN = 2.5;       // seconds after player:died (single-player only)
const THREAT_MIN = 0.3;
const THREAT_MAX = 0.7;
const THREAT_RAMP_SECONDS = 8 * 60;
/** A pointer-lock exit this soon after a lock request is a denied/failed request, not the user leaving. */
const LOCK_REQUEST_GRACE_MS = 300;
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
 *   - A dead player does not change phase; the host ends the mission (`flow over`) once *everyone* is dead.
 *   - `flow` messages from the host mirror over / complete / abort on the clients.
 *   - `stats.extracted` = boarded && alive at completion (left-behind / dead players get `false`).
 *
 * Ship hub (phases 'hub' / 'docking' are owned by hub/HubSystem and are NOT gameplay: nothing to pause or freeze):
 *   - `hub:enter` while a mission / result phase is active → HubSystem emits `game:abort` first (we go to 'menu'),
 *     then it builds the ship and sets 'hub'. A mission may start from 'hub' (`game:newMission` from the launch pod,
 *     `ctx.net.startGame` or `ctx.net.rejoinMission`).
 *   - After an abort that ends a *lobby* mission (host `flow abort`, 로비로, 임무 포기) we emit `hub:enter shared` one
 *     microtask later so the squad regroups in the shared ship. Solo aborts keep the legacy title-menu behaviour.
 *   - Reconnection: `net:reconnecting` never aborts (toast only); `net:resumed {seamless:false}` aborts → shared ship;
 *     `net:lobbyLeft` (party gone) aborts after 2 s → personal ship.
 */
export class GameFlowSystem implements GameSystem {
  readonly name = 'gameflow';
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  private netUnsub: (() => void) | null = null;

  private awaitingWorld = false;
  private completeTimer = -1;
  private deathTimer = -1;
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

  /** Pointer lock lost (Esc, alt-tab, cursor to another monitor) while playing → pause. */
  private onPointerLockChange = (): void => {
    if (this.ctx.input.isPointerLocked) return;
    this.onFocusLost();
  };
  private onWindowBlur = (): void => this.onFocusLost();

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', ({ seed }) => this.onNewMission(seed)),
      b.on('world:ready', () => {
        if (!this.awaitingWorld) return;
        this.awaitingWorld = false;
        this.setPhase('deploying');
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
      b.on('net:resumed', ({ seamless, inProgress }) => {
        if (!this.inMission()) return;
        if (seamless) { ctx.bus.emit('ui:notify', { text: '재연결됨', kind: 'success' }); return; }
        // the party moved on (different mission / back in the ship): drop our stale mission and regroup
        ctx.bus.emit('ui:notify', { text: inProgress ? '분대가 다른 임무를 진행 중입니다 — 함선으로 복귀' : '분대가 함선으로 복귀했습니다', kind: 'warning', duration: 4 });
        this.disconnectAbortTimer = -1;
        ctx.bus.emit('game:abort', {});
        ctx.bus.emit('hub:enter', { ship: 'shared' });
      }),
    );
    // Intended lock exits (inventory, map, menus, pause) add their blocker token / set paused
    // *before* calling exitPointerLock, so this handler only reacts to unexpected losses.
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('blur', this.onWindowBlur);
    // Make sure listeners know the initial phase even though ctx.phase already equals 'menu'.
    ctx.phase = 'menu';
    ctx.bus.emit('game:phaseChanged', { phase: 'menu', prev: 'menu' });
  }

  /** Mission running or its result screen showing (anything the hub / a disconnect has to abort first). */
  private inMission(): boolean {
    const p = this.ctx.phase;
    return this.ctx.isGameplayPhase() || p === 'deploying' || p === 'complete' || p === 'dead';
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
        if (ctx.isGameplayPhase() || ctx.phase === 'deploying') this.gameOver();
        break;
      case 'complete':
        if (ctx.isGameplayPhase() || ctx.phase === 'deploying') this.complete();
        break;
      case 'abort':
        // host aborted the mission → the whole squad regroups in the shared ship (onAbort schedules hub:enter)
        if (this.inMission()) ctx.bus.emit('game:abort', {});
        break;
      case 'phase':
        // Reserved: phases are derived locally from mirrored extraction events for now.
        break;
    }
  }

  private onLocalDied(): void {
    const ctx = this.ctx;
    if (!ctx.isGameplayPhase() && ctx.phase !== 'deploying') return;
    this.boarded = false;
    if (!ctx.isMultiplayer) {
      if (this.deathTimer >= 0) return;
      this.deathTimer = DEATH_TO_SCREEN;
      this.setPaused(false);
      return;
    }
    // Multiplayer: the phase stays — the squad (and the host simulation) keeps going. The UI shows a spectate overlay.
    this.setPaused(false);
    ctx.bus.emit('ui:notify', { text: '전사 — 팀원이 임무를 계속합니다', kind: 'danger', duration: 4 });
    this.allDeadCheckTimer = ALL_DEAD_CHECK_INTERVAL;
    this.checkAllDead();
  }

  /** Downed (multiplayer, tactical kit): keep the mission alive — the squad may still revive us. */
  private onLocalDowned(): void {
    const ctx = this.ctx;
    if (!ctx.isGameplayPhase() && ctx.phase !== 'deploying') return;
    this.setPaused(false);
    ctx.bus.emit('ui:notify', { text: '쓰러짐 — 아군의 제세동기를 기다립니다', kind: 'danger', duration: 4 });
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

  /** Host only: everyone dead → `flow over` to the squad and game over locally. */
  private checkAllDead(): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!net || !ctx.isMultiplayer || !net.isHost) return;
    if (!ctx.isGameplayPhase() && ctx.phase !== 'deploying') return;
    if (!this.isLocalOut()) return;
    for (const r of net.getRemotePlayers()) {
      // a squadmate who aborted back to the ship (IN_HUB) or a dropped peer waiting for reconnection (stale) is not "alive in the mission";
      // a downed peer IS still in the fight (a defibrillator can bring them back), so it blocks the wipe.
      const downed = (r.isDowned ?? false) || (r.flags & PlayerFlags.DOWNED) !== 0;
      if (r.connected && !r.stale && (!r.isDead || downed) && (r.flags & PlayerFlags.IN_HUB) === 0) return;
    }
    this.allDeadCheckTimer = -1;
    net.send({ t: 'flow', ev: 'over' }, 'others');
    this.gameOver();
  }

  /**
   * The party is gone (server gave up on us / host left / kicked) mid-mission → abort after a short toast and
   * return to the personal ship. A plain socket drop is `net:reconnecting` (handled above) and never aborts.
   */
  private onLobbyLeft(reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft'): void {
    const ctx = this.ctx;
    if (reason === 'left') return;                       // we chose to leave (abort / menu) — nothing to do
    if (!ctx.isGameplayPhase() && ctx.phase !== 'deploying') return;
    if (this.disconnectAbortTimer >= 0) return;
    const text = reason === 'hostLeft' ? '호스트가 나갔습니다 — 함선으로 복귀' : reason === 'kicked' ? '분대에서 분리되었습니다' : '연결이 끊어졌습니다 — 함선으로 복귀';
    ctx.bus.emit('ui:notify', { text, kind: 'danger', duration: DISCONNECT_ABORT_DELAY });
    this.disconnectAbortTimer = DISCONNECT_ABORT_DELAY;
  }

  /* ── Pause / focus ───────────────────────────────────────────────────── */
  private onFocusLost(): void {
    const ctx = this.ctx;
    if (this.paused || !ctx.isGameplayPhase() || ctx.uiBlockers.size > 0) return;
    if (ctx.player?.isDead ?? false) return;
    if (performance.now() - ctx.input.lastLockRequest < LOCK_REQUEST_GRACE_MS) return;
    ctx.bus.emit('input:pointerLockLost', {});
    this.setPaused(true);
  }

  /**
   * Re-acquire the pointer after the pause menu closed. Deferred one microtask so a synchronous
   * follow-up transition (e.g. abort → setPhase('menu'), which unpauses first) is visible to the
   * check; the user activation from the key/click that resumed is still valid by then.
   */
  private relock(): void {
    queueMicrotask(() => {
      const ctx = this.ctx;
      if (this.paused || !ctx.isGameplayPhase() || ctx.uiBlockers.size > 0) return;
      if (ctx.player?.isDead ?? false) return;
      ctx.input.requestPointerLock();
    });
  }

  private onNewMission(seed: number): void {
    this.setPaused(false);
    this.completeTimer = -1;
    this.deathTimer = -1;
    this.lastThreat = -1;
    this.boarded = false;
    this.allDeadCheckTimer = -1;
    this.disconnectAbortTimer = -1;
    this.rewarded = false;
    this.ctx.stats = Ctx.freshStats(seed);
    this.ctx.missionTime = 0;
    this.ctx.uiBlockers.delete('menu');
    this.awaitingWorld = true;
    this.ensureNetHooks();
    // WorldSystem generates synchronously inside its own handler; if it already ran (registered earlier),
    // ctx.world.ready is true and world:ready has been emitted before we got here → handle immediately.
    // (world:ready listeners above would have been skipped because awaitingWorld was false at that time.)
    if (this.ctx.world?.ready && this.ctx.world.seed === seed && this.ctx.phase !== 'deploying') {
      this.awaitingWorld = false;
      this.setPhase('deploying');
    }
  }

  private onAbort(): void {
    const ctx = this.ctx;
    const fromMission = this.inMission();
    // Host abort *during* the mission → the whole squad returns to the ship together. A client aborting only leaves for
    // itself; leaving a result screen (complete / dead) is always local — the mission is already over for everyone.
    const live = ctx.isGameplayPhase() || ctx.phase === 'deploying';
    if (ctx.net && live && (this.wasMultiplayerHost || (ctx.isMultiplayer && ctx.net.isHost))) {
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
    this.deathTimer = -1;
    this.boarded = false;
    this.allDeadCheckTimer = -1;
    this.disconnectAbortTimer = -1;
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
    if (paused && !this.ctx.isGameplayPhase()) return;
    this.paused = paused;
    // Single-player: Engine zeroes dt for every system while game:paused is active.
    // Multiplayer: freeze=false → only the menu shows; the simulation (and the extraction countdown) keeps running.
    // `paused` is set before exiting the lock so onPointerLockChange treats it as intended.
    if (paused) this.ctx.input.exitPointerLock();
    if (emit) this.ctx.bus.emit('game:paused', { paused, freeze: !this.ctx.isMultiplayer });
    // Resume (Esc or "계속" click): PauseMenu has removed its 'menu' blocker by now → re-lock.
    if (!paused) this.relock();
  }

  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    if (ctx.isGameplayPhase() || ctx.phase === 'deploying') this.wasMultiplayerHost = ctx.isMultiplayer && (ctx.net?.isHost ?? false);

    // Escape: toggle pause (not while another UI blocker — inventory / map — is open; those
    // consume Escape in a capture-phase listener anyway).
    if (ctx.input.wasPressed(Keys.MENU)) {
      if (this.paused) this.setPaused(false);
      else if (ctx.isGameplayPhase() && ctx.uiBlockers.size === 0 && !(ctx.player?.isDead ?? false)) this.setPaused(true);
    }
    // Single-player pause freezes everything (Engine also zeroes dt). Multiplayer: keep the timers ticking.
    if (this.paused && !ctx.isMultiplayer) return;

    if (ctx.isGameplayPhase()) {
      // Difficulty ramp 0.3 → 0.7 over 8 minutes of mission time.
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
      if (this.deathTimer < 0) this.gameOver();
    }
    if (this.allDeadCheckTimer >= 0) {
      this.allDeadCheckTimer -= dt;
      if (this.allDeadCheckTimer < 0) {
        const stillOut = this.isLocalOut() || (ctx.player?.isDowned ?? false);
        this.allDeadCheckTimer = stillOut ? ALL_DEAD_CHECK_INTERVAL : -1;
        this.checkAllDead();
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
    ctx.uiBlockers.delete('inventory');
    ctx.inventory?.closeAll();
    this.completeTimer = -1;
    this.allDeadCheckTimer = -1;
    this.awardMissionXp();
    // Host: make sure every client (even one that missed the liftoff message) reaches the result screen.
    if (ctx.isMultiplayer && ctx.net?.isHost) ctx.net.send({ t: 'flow', ev: 'complete' }, 'others');
    this.setPhase('complete');
    ctx.bus.emit('game:complete', { stats: { ...ctx.stats } });
  }

  private gameOver(): void {
    const ctx = this.ctx;
    if (ctx.phase === 'complete' || ctx.phase === 'dead' || ctx.phase === 'menu') return;
    ctx.stats.extracted = false;
    ctx.stats.lootValue = ctx.inventory?.getTotalValue() ?? 0;
    ctx.stats.timeSeconds = ctx.missionTime;
    ctx.uiBlockers.delete('inventory');
    ctx.inventory?.closeAll();
    this.deathTimer = -1;
    this.allDeadCheckTimer = -1;
    this.awardMissionXp();
    this.setPhase('dead');
    ctx.bus.emit('game:over', { stats: { ...ctx.stats } });
  }

  /**
   * Bank the mission result into the persistent profile (progression/). Runs once per mission, before the
   * result screen appears, so `game:complete` / `game:over` listeners already see the new level.
   * Loot XP is only paid on a successful extraction — dying leaves the bag on the ground.
   */
  private awardMissionXp(): void {
    if (this.rewarded) return;
    this.rewarded = true;
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
      if (xp > 0) prog.addXp(xp);
      prog.save();
    } catch (e) {
      console.error('[gameflow] mission XP award failed', e);
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.netUnsub?.(); this.netUnsub = null;
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('blur', this.onWindowBlur);
  }
}
