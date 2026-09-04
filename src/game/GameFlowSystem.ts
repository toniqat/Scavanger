import type { GameContext, GameSystem, GamePhase } from '@/shared';
import { GameContext as Ctx, Keys } from '@/shared';

const LIFTOFF_TO_COMPLETE = 6.5;   // seconds after extraction:liftoff
const DEATH_TO_SCREEN = 2.5;       // seconds after player:died
const THREAT_MIN = 0.3;
const THREAT_MAX = 0.7;
const THREAT_RAMP_SECONDS = 8 * 60;
/** A pointer-lock exit this soon after a lock request is a denied/failed request, not the user leaving. */
const LOCK_REQUEST_GRACE_MS = 300;

/**
 * Mission phase state machine + stats + pause + difficulty ramp.
 * menu → deploying → playing → extracting → shipLanded → liftoff → complete | dead
 */
export class GameFlowSystem implements GameSystem {
  readonly name = 'gameflow';
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];

  private awaitingWorld = false;
  private completeTimer = -1;
  private deathTimer = -1;
  private paused = false;
  private lastThreat = -1;

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
      b.on('extraction:liftoff', () => {
        if (ctx.phase !== 'shipLanded' && ctx.phase !== 'extracting') return;
        this.setPhase('liftoff');
        this.completeTimer = LIFTOFF_TO_COMPLETE;
      }),
      b.on('player:died', () => {
        if (!ctx.isGameplayPhase() && ctx.phase !== 'deploying') return;
        if (this.deathTimer >= 0) return;
        this.deathTimer = DEATH_TO_SCREEN;
        this.setPaused(false);
      }),
      // stats.kills / cratesOpened / damageTaken are incremented by Enemy / World / Player systems;
      // missionTime + stats.timeSeconds advance in Engine.frame(). GameFlow only finalizes them.
      b.on('game:abort', () => this.onAbort()),
      b.on('game:paused', ({ paused }) => this.setPaused(paused, false)),
    );
    // Intended lock exits (inventory, map, menus, pause) add their blocker token / set paused
    // *before* calling exitPointerLock, so this handler only reacts to unexpected losses.
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('blur', this.onWindowBlur);
    // Make sure listeners know the initial phase even though ctx.phase already equals 'menu'.
    ctx.phase = 'menu';
    ctx.bus.emit('game:phaseChanged', { phase: 'menu', prev: 'menu' });
  }

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
    this.ctx.stats = Ctx.freshStats(seed);
    this.ctx.missionTime = 0;
    this.ctx.uiBlockers.delete('menu');
    this.awaitingWorld = true;
    // WorldSystem generates synchronously inside its own handler; if it already ran (registered earlier),
    // ctx.world.ready is true and world:ready has been emitted before we got here → handle immediately.
    // (world:ready listeners above would have been skipped because awaitingWorld was false at that time.)
    if (this.ctx.world?.ready && this.ctx.world.seed === seed && this.ctx.phase !== 'deploying') {
      this.awaitingWorld = false;
      this.setPhase('deploying');
    }
  }

  private onAbort(): void {
    this.setPaused(false);
    this.completeTimer = -1;
    this.deathTimer = -1;
    this.awaitingWorld = false;
    this.ctx.uiBlockers.delete('inventory');
    this.ctx.inventory?.closeAll();
    this.setPhase('menu');
  }

  private setPhase(phase: GamePhase): void {
    this.ctx.setPhase(phase);
  }

  private setPaused(paused: boolean, emit = true): void {
    if (this.paused === paused) return;
    if (paused && !this.ctx.isGameplayPhase()) return;
    this.paused = paused;
    // Engine zeroes dt for every system while game:paused is active.
    // `paused` is set before exiting the lock so onPointerLockChange treats it as intended.
    if (paused) this.ctx.input.exitPointerLock();
    if (emit) this.ctx.bus.emit('game:paused', { paused });
    // Resume (Esc or "계속" click): PauseMenu has removed its 'menu' blocker by now → re-lock.
    if (!paused) this.relock();
  }

  update(dt: number, ctx: GameContext): void {
    // Escape: toggle pause (not while another UI blocker — inventory / map — is open; those
    // consume Escape in a capture-phase listener anyway).
    if (ctx.input.wasPressed(Keys.MENU)) {
      if (this.paused) this.setPaused(false);
      else if (ctx.isGameplayPhase() && ctx.uiBlockers.size === 0 && !(ctx.player?.isDead ?? false)) this.setPaused(true);
    }
    if (this.paused) return;

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
  }

  private complete(): void {
    const ctx = this.ctx;
    ctx.stats.extracted = true;
    ctx.stats.lootValue = ctx.inventory?.getTotalValue() ?? 0;
    ctx.stats.timeSeconds = ctx.missionTime;
    ctx.uiBlockers.delete('inventory');
    ctx.inventory?.closeAll();
    this.setPhase('complete');
    ctx.bus.emit('game:complete', { stats: { ...ctx.stats } });
  }

  private gameOver(): void {
    const ctx = this.ctx;
    ctx.stats.extracted = false;
    ctx.stats.lootValue = ctx.inventory?.getTotalValue() ?? 0;
    ctx.stats.timeSeconds = ctx.missionTime;
    ctx.uiBlockers.delete('inventory');
    ctx.inventory?.closeAll();
    this.setPhase('dead');
    ctx.bus.emit('game:over', { stats: { ...ctx.stats } });
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('blur', this.onWindowBlur);
  }
}
