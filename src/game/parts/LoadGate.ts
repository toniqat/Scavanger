/**
 * src/game/parts/LoadGate.ts — **the raid-entry loading gate** (2026-09-15,
 * docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」).
 *
 * The question this file answers: *once the launch countdown ends, what holds the screen until the squad is ready.*
 *
 * ## Why a hold
 * The gate is a **render hold** (`ShaderWarmupRef.holdFor`). Under the hold `Engine` gives a simulation dt of 0 and
 * draws nothing, so **the mission clock · the enemies · the drop pod · the phase flow stop as one** — 「it must not
 * start yet」 does not have to be blocked system by system. In exchange **dt must not be read here**: every time in
 * the gate is `ctx.time` (real time).
 *
 * ## Order
 * 1. Launch countdown ends → hub emits `ui:screenFade {1, RAID_LOAD_FADE_OUT_S, hold:true}` + `raid:loadBegin`,
 *    and the authority actually launches `RAID_LOAD_FADE_OUT_S` later.
 * 2. `game:newMission` → `begin()` here. The world is already generated synchronously (`WorldSystem` builds it inside
 *    its own handler) and `core/Engine` has a `holdForScene()` up — a `holdForScene()` call in the same frame
 *    **coalesces**, so ours waits on that same compilation.
 * 3. Local progress = `RAID_LOAD_WORLD_SHARE` (world generated) + the rest × `ctx.shaders.compileProgress`. In
 *    multiplayer it reports `load p` every `RAID_LOAD_REPORT_S`, and the host counts **humans only** (bots do not
 *    load) and sends `load go` on everyone done or at `RAID_LOAD_TIMEOUT_S`.
 * 4. On release the hold is let go → `ui:screenFade {0, RAID_LOAD_FADE_IN_S}` → only then does the drop sequence run.
 *
 * ## What never takes the gate
 * The training range · the tutorial · a reconnect (`ctx.rejoinPending`) have no gate — the first two never go through
 * a launch pod, and a reconnect steps into a raid that is already running, so nobody waits for it.
 */
import type { GameContext, LoadMessage, PeerId } from '@/shared';
import {
  RAID_LOAD_FADE_IN_S, RAID_LOAD_HOLD_MARGIN_S, RAID_LOAD_MIN_BLACK_S, RAID_LOAD_REPORT_S,
  RAID_LOAD_TIMEOUT_S, RAID_LOAD_WORLD_SHARE,
  humanPlayersOf,
} from '@/shared';
import type { GameFlowSystem } from '../GameFlowSystem';

/** A progress number clamped into 0..1 (a non-finite one reads 0). */
function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

export class LoadGate {
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  private netUnsub: (() => void) | null = null;

  /** The gate is up (a hold is in place). */
  private on = false;
  private seed = 0;
  /** The handle that releases the hold — the resolve of the promise handed to `holdFor`. */
  private letGo: (() => void) | null = null;
  /** The start time on `ctx.time`. dt is 0 under the hold, so it cannot be used. */
  private startedAt = 0;
  private worldReady = false;
  /** The scene warm-up (`holdForScene`) has finished. */
  private compiled = false;
  /** A `holdForScene()` is already up (raising it twice schedules a new compilation). */
  private awaitedScene = false;
  /** hub emitted `raid:loadBegin` = the fade to black is already on its way. */
  private sawBegin = false;
  private lastReportAt = -1;
  private lastEmitAt = -1;
  private sentDone = false;
  /** The host's `load go` arrived for this seed. */
  private goSeen = false;
  private goTimedOut = false;
  /** The progress the others reported (`PeerId` → 0..1). */
  private readonly reports = new Map<PeerId, number>();
  /**
   * Smoke-only injection (`debugAddMember`): it can build 「one squadmate is still loading」 with no relay.
   * While it is not empty even a solo run waits **like a host**.
   */
  private readonly debugMembers = new Map<PeerId, number>();
  /** The reused array behind `members()` (it runs every frame even under the hold — no per-frame allocation). */
  private readonly _members: PeerId[] = [];
  /** Smoke-only override of the wait cap (seconds). null = the csv value. */
  private debugTimeoutS: number | null = null;

  constructor(private readonly sys: GameFlowSystem) {}

  /** Once, from `GameFlowSystem.init`. */
  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('raid:loadBegin', () => { this.sawBegin = true; }),
      b.on('game:newMission', ({ seed }) => this.begin(seed)),
      b.on('world:ready', ({ seed }) => this.onWorldReady(seed)),
      b.on('game:abort', () => this.cancel()),
    );
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netUnsub?.(); this.netUnsub = null;
    this.cancel();
  }

  /* ── State (ui · smokes) ────────────────────────────────────────────── */
  get active(): boolean { return this.on; }
  get localProgress(): number { return this.on ? this.localValue() : 1; }
  get squadProgress(): number { return this.on ? this.squadValue() : 1; }
  /** How many people have not finished yet (the local player included). */
  get waiting(): number { return this.on ? this.waitingCount() : 0; }

  /* ── Begin · cancel ───────────────────────────────────────────────── */
  private begin(seed: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.on) this.cancel();          // a new mission arrived mid-gate — fold it quietly and raise it again
    if (!this.shouldGate()) return;
    this.on = true;
    this.seed = seed;
    this.startedAt = ctx.time;
    this.worldReady = !!ctx.world?.ready;
    this.compiled = false;
    this.awaitedScene = false;
    this.lastReportAt = -1;
    this.lastEmitAt = -1;
    this.sentDone = false;
    this.goSeen = false;
    this.goTimedOut = false;
    this.reports.clear();
    /*
     * If hub already started the fade to black (`raid:loadBegin`) that plate is used as it is. Otherwise (a cheat
     * launch · a legacy path) the screen is blacked here at once — with `hold: true` ui does not clear it even when
     * the phase turns to 'deploying'.
     */
    if (!this.sawBegin) ctx.bus.emit('ui:screenFade', { opacity: 1, durationS: 0, hold: true });
    // used once per launch — if hub only raised the fade and no launch came (it brightens again after the grace),
    // the next launch has to black the screen itself
    this.sawBegin = false;
    const ready = new Promise<void>((resolve) => { this.letGo = resolve; });
    const cap = this.timeoutS() + RAID_LOAD_HOLD_MARGIN_S;
    const shaders = ctx.shaders;
    if (shaders && typeof shaders.holdFor === 'function') shaders.holdFor(ready, cap);
    else shaders?.hold(ready);
    this.awaitScene();
    this.emitProgress();
  }

  /** Is this a mission that takes the gate — raids only, reconnects left out. */
  private shouldGate(): boolean {
    const ctx = this.ctx;
    // the training range and the tutorial do not go through a launch pod
    if (ctx.missionMode !== 'raid') return false;
    if (ctx.rejoinPending || this.sys.rejoining) return false;   // the path that steps into a raid already running
    return true;
  }

  private onWorldReady(seed: number): void {
    if (!this.on || seed !== this.seed) return;
    this.worldReady = true;
    this.awaitScene();
  }

  /**
   * Waits for the scene warm-up to finish. In the **same frame** as the one `core/Engine` already raised on
   * `world:ready` the two coalesce, so no new compilation is scheduled (`ShaderWarmup.holdForScene` — only the
   * number of waiters grows).
   */
  private awaitScene(): void {
    if (this.awaitedScene || !this.worldReady) return;
    const shaders = this.ctx.shaders;
    if (!shaders) { this.compiled = true; return; }
    this.awaitedScene = true;
    const seed = this.seed;
    void shaders.holdForScene().then(() => { if (this.on && this.seed === seed) this.compiled = true; });
  }

  /** The mission folded (`game:abort` · a new mission) — releases the hold alone, with no fade-in and no event. */
  private cancel(): void {
    if (!this.on) return;
    this.on = false;
    this.sawBegin = false;
    this.reports.clear();
    const go = this.letGo; this.letGo = null;
    go?.();
  }

  /* ── Every frame (`GameFlowSystem.update`) ────────────────────────── */
  update(): void {
    if (!this.ctx) return;
    this.hookNet();
    if (!this.on) return;
    const ctx = this.ctx;
    const now = ctx.time;
    const elapsed = now - this.startedAt;
    const local = this.localValue();
    const done = this.localDone(elapsed);

    // progress reports — every period, and once more the moment it reaches 1 (miss that last one and nobody releases)
    if (this.lastReportAt < 0 || now - this.lastReportAt >= RAID_LOAD_REPORT_S || (done && !this.sentDone)) {
      this.lastReportAt = now;
      if (done) this.sentDone = true;
      this.sendProgress(done ? 1 : local);
    }
    if (this.lastEmitAt < 0 || now - this.lastEmitAt >= RAID_LOAD_REPORT_S) {
      this.lastEmitAt = now;
      this.emitProgress();
    }

    const limit = this.timeoutS();
    if (this.isWaitingHost()) {
      if (done && this.waitingCount() === 0) { this.sendGo(false); this.release(false); return; }
      if (elapsed >= limit) { this.sendGo(true); this.release(true); return; }
      return;
    }
    if (this.inSquad()) {
      // client: releases when the host's `go` **and** its own done both land (a late one the moment it finishes).
      if (this.goSeen && done) { this.release(this.goTimedOut); return; }
      // safety net: the host's `go` never arrived (the host died · the message was lost) — it leaves on its own.
      if (elapsed >= limit + RAID_LOAD_HOLD_MARGIN_S) { this.release(true); return; }
      return;
    }
    if (done) this.release(false);
    else if (elapsed >= limit) this.release(true);
  }

  /* ── Progress ───────────────────────────────────────────────────── */
  private localValue(): number {
    if (!this.worldReady) return 0;
    const compile = this.ctx.shaders?.compileProgress;
    const c = clamp01(typeof compile === 'number' ? compile : 1);
    return clamp01(RAID_LOAD_WORLD_SHARE + (1 - RAID_LOAD_WORLD_SHARE) * c);
  }

  /** Local done — the scene warm-up finished and enough black has shown that the gauge does not flicker. */
  private localDone(elapsed: number): boolean {
    return this.compiled && this.worldReady && elapsed >= RAID_LOAD_MIN_BLACK_S;
  }

  /**
   * The **humans** loading this raid alongside the local player (bots excluded · connected · in the mission), who is
   * left out of it. A reused array — read it, use it at once, never keep it (it is called every frame while the gate
   * is up).
   */
  private members(): PeerId[] {
    const out = this._members;
    out.length = 0;
    for (const id of this.debugMembers.keys()) out.push(id);
    const net = this.ctx.net;
    if (!net || !this.ctx.isMultiplayer) return out;
    const me = net.localId;
    for (const p of humanPlayersOf(net.lobby)) {
      if (!p || p.id === me || !p.connected || p.inMission === false) continue;
      if (!out.includes(p.id)) out.push(p.id);
    }
    return out;
  }

  private inSquad(): boolean {
    return this.debugMembers.size > 0 || (this.ctx.isMultiplayer && this.members().length > 0);
  }

  /** Is this the side that sends `go` (the lobby host · a smoke injection). */
  private isWaitingHost(): boolean {
    if (this.debugMembers.size > 0) return true;
    return this.ctx.isMultiplayer && (this.ctx.net?.isHost ?? false) && this.members().length > 0;
  }

  private valueOf(id: PeerId): number {
    const dbg = this.debugMembers.get(id);
    if (dbg !== undefined) return clamp01(dbg);
    return clamp01(this.reports.get(id) ?? 0);
  }

  private squadValue(): number {
    const ids = this.members();
    let sum = this.sentDone ? 1 : this.localValue(), n = 1;
    for (const id of ids) { sum += this.valueOf(id); n++; }
    return clamp01(sum / n);
  }

  private waitingCount(): number {
    let n = (this.sentDone ? 0 : 1);
    for (const id of this.members()) if (this.valueOf(id) < 1) n++;
    return n;
  }

  private timeoutS(): number {
    const o = this.debugTimeoutS;
    return o !== null && Number.isFinite(o) && o > 0 ? o : RAID_LOAD_TIMEOUT_S;
  }

  private emitProgress(): void {
    const remaining = Math.max(0, this.timeoutS() - (this.ctx.time - this.startedAt));
    this.ctx.bus.emit('raid:loadProgress', {
      local: this.sentDone ? 1 : this.localValue(),
      squad: this.inSquad() ? this.squadValue() : (this.sentDone ? 1 : this.localValue()),
      waiting: this.waitingCount(),
      remainingS: remaining,
    });
  }

  /* ── Wire ───────────────────────────────────────────────────────── */
  private hookNet(): void {
    const net = this.ctx?.net;
    if (this.netUnsub || !net || typeof net.onMessage !== 'function') return;
    this.netUnsub = net.onMessage('load', (msg, from) => this.onLoadMessage(msg, from));
  }

  private onLoadMessage(msg: LoadMessage, from: PeerId): void {
    if (!this.on || msg.seed !== this.seed) return;
    if (msg.ev === 'p') {
      this.reports.set(from, clamp01(msg.v));
      return;
    }
    // only the **lobby host** emits `go` (the E-4 authority contract). With no known host it is not accepted.
    const hostId = this.ctx.net?.lobby?.hostId;
    if (!hostId || from !== hostId) return;
    this.goSeen = true;
    this.goTimedOut = msg.to === 1;
  }

  private sendProgress(v: number): void {
    const net = this.ctx.net;
    if (!net || !this.ctx.isMultiplayer) return;
    net.send({ t: 'load', ev: 'p', seed: this.seed, v: clamp01(v) }, 'others');
  }

  private sendGo(timedOut: boolean): void {
    const net = this.ctx.net;
    if (!net || !this.ctx.isMultiplayer || !net.isHost) return;
    net.send(timedOut ? { t: 'load', ev: 'go', seed: this.seed, to: 1 } : { t: 'load', ev: 'go', seed: this.seed }, 'others');
  }

  /* ── Release ────────────────────────────────────────────────────── */
  private release(timedOut: boolean): void {
    if (!this.on) return;
    this.on = false;
    this.sawBegin = false;
    this.reports.clear();
    const go = this.letGo; this.letGo = null;
    go?.();
    // one last progress report (so the gauge disappears at 1), then the fade-in.
    this.ctx.bus.emit('raid:loadProgress', { local: 1, squad: 1, waiting: 0, remainingS: 0 });
    this.ctx.bus.emit('ui:screenFade', { opacity: 0, durationS: RAID_LOAD_FADE_IN_S });
    this.ctx.bus.emit('raid:loadReleased', { timedOut });
  }

  /* ── Debug hooks (`__game.getSystem('gameflow').loadGate`) ─────────── */
  /** Smoke: injects the progress of one fake squadmate (builds 「the host is waiting」 with no relay). */
  debugAddMember(id: PeerId, v: number): void { this.debugMembers.set(id, clamp01(v)); }
  /** Smoke: clears every injected squadmate (an injection does not vanish on its own when the raid ends). */
  debugClearMembers(): void { this.debugMembers.clear(); }
  /** Smoke: shortens the wait cap (null = back to the csv value) — so `RAID_LOAD_TIMEOUT_S` is not waited out. */
  debugSetTimeout(seconds: number | null): void { this.debugTimeoutS = seconds; }
}
