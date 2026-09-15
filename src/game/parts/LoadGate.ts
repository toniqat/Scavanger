/**
 * src/game/parts/LoadGate.ts — **레이드 진입 로딩 게이트** (2026-09-15,
 * docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」).
 *
 * 이 파일이 답하는 질문: *발사 카운트다운이 끝난 뒤, 분대 전원이 준비될 때까지 무엇이 화면을 붙잡고 있는가.*
 *
 * ## 왜 hold 인가
 * 게이트는 **렌더 hold** 다 (`ShaderWarmupRef.holdFor`). hold 중에는 `Engine` 이 시뮬레이션 dt 를 0 으로 주고 아무것도
 * 그리지 않으므로 **임무 시계 · 적 · 강하 포드 · 페이즈 흐름이 통째로 멈춘다** — 「아직 시작하면 안 된다」를 시스템마다
 * 따로 막을 필요가 없다. 그 대신 여기서 **dt 를 쓰면 안 된다**: 게이트의 모든 시간은 `ctx.time`(실시간)이다.
 *
 * ## 순서
 * 1. 발사 카운트다운 끝 → hub 가 `ui:screenFade {1, RAID_LOAD_FADE_OUT_S, hold:true}` + `raid:loadBegin`,
 *    `RAID_LOAD_FADE_OUT_S` 뒤 권위가 실제로 발사한다.
 * 2. `game:newMission` → 여기서 `begin()`. 월드는 이미 동기로 생성돼 있고(`WorldSystem` 이 자기 핸들러 안에서 만든다)
 *    `core/Engine` 이 `holdForScene()` 을 걸어 둔 상태다 — 같은 프레임의 `holdForScene()` 호출은 **합쳐지므로**
 *    우리 것도 같은 컴파일을 기다린다.
 * 3. 진행도 = `RAID_LOAD_WORLD_SHARE`(월드 생성) + 나머지 × `ctx.shaders.compileProgress`. 멀티면 `RAID_LOAD_REPORT_S`
 *    마다 `load p` 로 알리고, 호스트가 **사람만** 세어(봇은 로딩하지 않는다) 전원 완료 또는 `RAID_LOAD_TIMEOUT_S` 에
 *    `load go` 를 보낸다.
 * 4. 풀리면 hold 해제 → `ui:screenFade {0, RAID_LOAD_FADE_IN_S}` → 강하 시퀀스가 그제서야 흐른다.
 *
 * ## 안 타는 길
 * 훈련장 · 튜토리얼 · 재접속(`ctx.rejoinPending`)은 게이트가 없다 — 앞의 둘은 발사 포드를 거치지 않고, 재접속은
 * 이미 굴러가는 레이드에 끼어드는 것이라 아무도 기다려 주지 않는다.
 */
import type { GameContext, LoadMessage, PeerId } from '@/shared';
import {
  RAID_LOAD_FADE_IN_S, RAID_LOAD_HOLD_MARGIN_S, RAID_LOAD_MIN_BLACK_S, RAID_LOAD_REPORT_S,
  RAID_LOAD_TIMEOUT_S, RAID_LOAD_WORLD_SHARE,
  humanPlayersOf,
} from '@/shared';
import type { GameFlowSystem } from '../GameFlowSystem';

/** 진행도 한 사람 몫. */
function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

export class LoadGate {
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  private netUnsub: (() => void) | null = null;

  /** 게이트가 걸려 있다 (hold 중). */
  private on = false;
  private seed = 0;
  /** hold 를 푸는 손잡이 — `holdFor` 에 넘긴 약속의 resolve. */
  private letGo: (() => void) | null = null;
  /** `ctx.time` 기준 시작 시각. dt 는 hold 중 0 이라 쓸 수 없다. */
  private startedAt = 0;
  private worldReady = false;
  /** 씬 컴파일(`holdForScene`)이 끝났다. */
  private compiled = false;
  /** 이미 `holdForScene()` 을 걸었다 (두 번 걸면 새 컴파일이 예약된다). */
  private awaitedScene = false;
  /** hub 가 `raid:loadBegin` 을 냈다 = 암전은 이미 오고 있다. */
  private sawBegin = false;
  private lastReportAt = -1;
  private lastEmitAt = -1;
  private sentDone = false;
  /** 호스트의 `load go` 가 이 시드로 도착했다. */
  private goSeen = false;
  private goTimedOut = false;
  /** 다른 사람들이 알려 온 진행도 (`PeerId` → 0..1). */
  private readonly reports = new Map<PeerId, number>();
  /**
   * 스모크 전용 주입 (`debugAddMember`): 릴레이 없이도 「분대원 하나가 아직 로딩 중」을 만들 수 있다.
   * 비어 있지 않으면 솔로여도 **호스트처럼** 기다린다.
   */
  private readonly debugMembers = new Map<PeerId, number>();
  /** `members()` 의 재사용 배열 (hold 중에도 프레임마다 돈다 — 매 프레임 할당하지 않는다). */
  private readonly _members: PeerId[] = [];
  /** 스모크 전용 대기 상한 덮어쓰기 (초). null = csv 값. */
  private debugTimeoutS: number | null = null;

  constructor(private readonly sys: GameFlowSystem) {}

  /** `GameFlowSystem.init` 에서 한 번. */
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

  /* ── 상태 (ui · 스모크) ─────────────────────────────────────────────── */
  get active(): boolean { return this.on; }
  get localProgress(): number { return this.on ? this.localValue() : 1; }
  get squadProgress(): number { return this.on ? this.squadValue() : 1; }
  /** 아직 끝내지 못한 사람 수 (나 포함). */
  get waiting(): number { return this.on ? this.waitingCount() : 0; }

  /* ── 시작 · 취소 ──────────────────────────────────────────────────── */
  private begin(seed: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.on) this.cancel();          // 새 미션이 게이트 도중에 왔다 — 조용히 접고 다시 건다
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
     * hub 가 이미 암전을 시작했으면(`raid:loadBegin`) 그 판을 그대로 쓴다. 아니면(치트 발사 · 예전 경로) 여기서
     * 즉시 검게 만든다 — `hold: true` 라 페이즈가 'deploying' 으로 바뀌어도 ui 가 걷지 않는다.
     */
    if (!this.sawBegin) ctx.bus.emit('ui:screenFade', { opacity: 1, durationS: 0, hold: true });
    // 한 발사에 한 번만 쓴다 — hub 가 암전만 걸고 발사가 오지 않으면(유예 뒤 다시 밝아진다) 다음 발사는 스스로 검게 만들어야 한다
    this.sawBegin = false;
    const ready = new Promise<void>((resolve) => { this.letGo = resolve; });
    const cap = this.timeoutS() + RAID_LOAD_HOLD_MARGIN_S;
    const shaders = ctx.shaders;
    if (shaders && typeof shaders.holdFor === 'function') shaders.holdFor(ready, cap);
    else shaders?.hold(ready);
    this.awaitScene();
    this.emitProgress();
  }

  /** 게이트를 태울 미션인가 — 레이드만, 재접속은 빼고. */
  private shouldGate(): boolean {
    const ctx = this.ctx;
    if (ctx.missionMode !== 'raid') return false;          // 훈련장 · 튜토리얼은 발사 포드를 거치지 않는다
    if (ctx.rejoinPending || this.sys.rejoining) return false;   // 이미 도는 레이드에 끼어드는 길
    return true;
  }

  private onWorldReady(seed: number): void {
    if (!this.on || seed !== this.seed) return;
    this.worldReady = true;
    this.awaitScene();
  }

  /**
   * 씬 컴파일이 끝나기를 기다린다. `core/Engine` 이 `world:ready` 에 이미 걸어 둔 것과 **같은 프레임**이면 합쳐지므로
   * 새 컴파일이 예약되지 않는다 (`ShaderWarmup.holdForScene` — 대기자만 늘어난다).
   */
  private awaitScene(): void {
    if (this.awaitedScene || !this.worldReady) return;
    const shaders = this.ctx.shaders;
    if (!shaders) { this.compiled = true; return; }
    this.awaitedScene = true;
    const seed = this.seed;
    void shaders.holdForScene().then(() => { if (this.on && this.seed === seed) this.compiled = true; });
  }

  /** 미션이 접혔다 (`game:abort` · 새 미션) — 페이드인도 이벤트도 없이 hold 만 푼다. */
  private cancel(): void {
    if (!this.on) return;
    this.on = false;
    this.sawBegin = false;
    this.reports.clear();
    const go = this.letGo; this.letGo = null;
    go?.();
  }

  /* ── 매 프레임 (`GameFlowSystem.update`) ──────────────────────────── */
  update(): void {
    if (!this.ctx) return;
    this.hookNet();
    if (!this.on) return;
    const ctx = this.ctx;
    const now = ctx.time;
    const elapsed = now - this.startedAt;
    const local = this.localValue();
    const done = this.localDone(elapsed);

    // 진행도 알림 — 주기마다, 그리고 1 에 닿는 순간 한 번 더 (마지막 한 번을 놓치면 아무도 풀지 못한다)
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
      // 클라이언트: 호스트의 `go` 와 내 로딩이 **둘 다** 끝나야 푼다 (늦은 사람은 자기가 끝나는 순간).
      if (this.goSeen && done) { this.release(this.goTimedOut); return; }
      // 안전망: 호스트의 `go` 가 끝내 오지 않았다 (호스트가 죽었다 · 메시지를 잃었다) — 혼자 나간다.
      if (elapsed >= limit + RAID_LOAD_HOLD_MARGIN_S) { this.release(true); return; }
      return;
    }
    if (done) this.release(false);
    else if (elapsed >= limit) this.release(true);
  }

  /* ── 진행도 ─────────────────────────────────────────────────────── */
  private localValue(): number {
    if (!this.worldReady) return 0;
    const compile = this.ctx.shaders?.compileProgress;
    const c = clamp01(typeof compile === 'number' ? compile : 1);
    return clamp01(RAID_LOAD_WORLD_SHARE + (1 - RAID_LOAD_WORLD_SHARE) * c);
  }

  /** 내 준비 끝 — 씬 컴파일이 끝났고, 게이지가 깜빡이지 않을 만큼 검은 화면을 보여 줬다. */
  private localDone(elapsed: number): boolean {
    return this.compiled && this.worldReady && elapsed >= RAID_LOAD_MIN_BLACK_S;
  }

  /**
   * 이 레이드를 같이 로딩하는 **사람들** (봇 제외 · 연결 · 미션 안). 나는 빠져 있다.
   * 재사용 배열이다 — 읽고 바로 쓰고 보관하지 않는다 (게이트가 걸린 동안 매 프레임 불린다).
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

  /** 내가 `go` 를 보낼 쪽인가 (로비 호스트 · 스모크 주입). */
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

  /* ── 와이어 ─────────────────────────────────────────────────────── */
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
    // `go` 는 **로비 호스트만** 낸다 (E-4 권한 규약). 호스트를 모르면 받지 않는다.
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

  /* ── 해제 ───────────────────────────────────────────────────────── */
  private release(timedOut: boolean): void {
    if (!this.on) return;
    this.on = false;
    this.sawBegin = false;
    this.reports.clear();
    const go = this.letGo; this.letGo = null;
    go?.();
    // 마지막 진행도 한 번 (게이지가 1 에서 사라지도록), 그 다음 페이드인.
    this.ctx.bus.emit('raid:loadProgress', { local: 1, squad: 1, waiting: 0, remainingS: 0 });
    this.ctx.bus.emit('ui:screenFade', { opacity: 0, durationS: RAID_LOAD_FADE_IN_S });
    this.ctx.bus.emit('raid:loadReleased', { timedOut });
  }

  /* ── 디버그 훅 (`__game.getSystem('gameflow').loadGate`) ───────────── */
  /** 스모크: 가짜 분대원 하나의 진행도를 주입한다 (릴레이 없이 「호스트가 기다린다」를 만든다). */
  debugAddMember(id: PeerId, v: number): void { this.debugMembers.set(id, clamp01(v)); }
  /** 스모크: 주입한 분대원을 전부 지운다 (주입은 레이드가 끝나도 저절로 사라지지 않는다). */
  debugClearMembers(): void { this.debugMembers.clear(); }
  /** 스모크: 대기 상한을 짧게 (null = csv 값으로 되돌린다). 60 초를 실제로 기다리지 않기 위한 것이다. */
  debugSetTimeout(seconds: number | null): void { this.debugTimeoutS = seconds; }
}
