import type { GameContext } from '@/shared';
import { RAID_LOAD_MIN_BLACK_S } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import '../styles/loading.css';

/** 사라지는 데 걸리는 시간 (s) — 연출 길이라 csv 가 아니라 여기 있다 (README 규칙: UI 타이밍 상수는 컴포넌트에). */
const FADE_OUT_S = 0.25;
/** 나타나는 데 걸리는 시간 (s). */
const FADE_IN_S = 0.18;
/** 도는 호의 회전 속도 (deg/s). */
const SPIN_DEG_PER_S = 220;

/**
 * **레이드 진입 로딩 게이지** (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」).
 *
 * 사용자 결정: 발사 카운트다운이 끝나면 화면이 암전되고 (`raid:loadBegin` → hub 가 `ui:screenFade` 를 건다),
 * **암전된 채로 우측 하단에서 원형 게이지가 돈다**. 멀티플레이면 게이지의 채움은 분대 전원(사람)의 진행도를
 * 합친 값이다 — `raid:loadProgress.squad` 를 그대로 그린다 (게임 쪽 `game/LoadGate` 가 계산한다). 전원이 끝나면
 * `raid:loadReleased` 가 오고, 게이지는 빠르게 사라진 뒤 강하 시퀀스가 페이드인된다.
 *
 * **dt 가 0 이다.** 게이트가 도는 동안 엔진은 `ctx.shaders.holdFor` 로 멈춰 있어 모든 시스템이 `dt: 0` 을 받는다.
 * 그래서 이 위젯의 시계는 시뮬레이션 dt 도, CSS 전이/애니메이션도 아닌 **`performance.now()`** 다 — 채움 · 회전 ·
 * 나타남/사라짐 전부. (CSS 로 돌리면 reduced-motion 규칙이 0.01 ms 로 잘라 버리는 문제도 같이 피한다.)
 * `prefers-reduced-motion` 이면 도는 호만 숨기고 채움은 그대로 둔다 (`styles/loading.css`).
 *
 * 최소 표시 시간 `RAID_LOAD_MIN_BLACK_S` — 로딩이 아무리 빨라도 그만큼은 떠 있다 (csv 주석: 「깜빡이며 사라지지
 * 않게」). `game:abort` · `hub:entered` 는 조건 없이 걷는다 (검은 화면에 게이지만 남는 길이 없게).
 */
export class LoadingGauge {
  readonly root: HTMLElement;
  private ring: HTMLElement;
  private spin: HTMLElement;
  private label: HTMLElement;
  private waitEl: HTMLElement;
  private pctEl: HTMLElement;
  private unsubs: Array<() => void> = [];

  /** 게이지가 살아 있나 (사라지는 동안에도 true). */
  private active = false;
  /** 사라지는 중인가 — `raid:loadReleased` 뒤. */
  private fading = false;
  /** 실시간 기준점 (ms): 뜬 순간 · 사라지기 시작한 순간. */
  private shownAt = 0;
  private fadeAt = 0;
  /** 마지막으로 받은 진행도. */
  private squad = 0;
  private waiting = 0;
  /** 마지막으로 쓴 값들 (DOM 쓰기를 아낀다). */
  private lastP = -1;
  private lastSpin = -1;
  private lastOpacity = -1;
  private lastWait = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'ldg', parent });
    this.root.hidden = true;
    this.ring = el('div', { cls: 'ldg-ring', parent: this.root });
    this.spin = el('div', { cls: 'ldg-spin', parent: this.ring });
    const body = el('div', { cls: 'ldg-body', parent: this.root });
    this.label = el('div', { cls: 'ldg-label', text: '로딩 중', parent: body });
    this.pctEl = el('div', { cls: 'ldg-pct ui-mono', text: '0 %', parent: body });
    this.waitEl = el('div', { cls: 'ldg-wait', text: '', parent: body });
    this.waitEl.hidden = true;
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('raid:loadBegin', () => this.show()),
      // 첫 `raid:loadProgress` 만 보고도 뜬다 — `raid:loadBegin` 을 놓친 경로(재접속 · 솔로)에서도 게이지가 보인다.
      b.on('raid:loadProgress', ({ squad, waiting }) => {
        if (!this.active) this.show();
        this.squad = Math.min(1, Math.max(0, Number.isFinite(squad) ? squad : 0));
        this.waiting = Math.max(0, Math.round(Number.isFinite(waiting) ? waiting : 0));
      }),
      b.on('raid:loadReleased', () => this.release()),
      b.on('game:abort', () => this.hide()),
      b.on('hub:entered', () => this.hide()),
    );
  }

  /** 게이지가 보이는가 (debug / smoke — 사라지는 동안에도 true). */
  get isShowing(): boolean { return this.active; }
  /** 채움 0…1 · 기다리는 사람 수 · 지금 칠해진 불투명도 (debug / smoke). */
  get fill(): number { return this.squad; }
  get waitingCount(): number { return this.waiting; }
  get opacity(): number { return this.lastOpacity < 0 ? 0 : this.lastOpacity; }
  /** 도는 호의 각도 (deg) — dt 0 에서도 움직이는지 보는 스모크 훅. */
  get spinDeg(): number { return this.lastSpin < 0 ? 0 : this.lastSpin; }

  private show(): void {
    if (this.active && !this.fading) return;
    this.active = true;
    this.fading = false;
    this.shownAt = performance.now();
    this.root.hidden = false;
    this.lastP = -1; this.lastSpin = -1; this.lastOpacity = -1; this.lastWait = -1;
  }

  /**
   * 풀렸다 — 최소 표시 시간을 채운 뒤 빠르게 사라진다. 페이드인(`RAID_LOAD_FADE_IN_S`)이 도는 동안 게이지가
   * 남아 있으면 밝아지는 화면 위에 떠 있게 되므로, 사라짐은 페이드인보다 짧다 (`FADE_OUT_S`).
   */
  private release(): void {
    if (!this.active || this.fading) return;
    this.fading = true;
    const minEnd = this.shownAt + RAID_LOAD_MIN_BLACK_S * 1000;
    this.fadeAt = Math.max(performance.now(), minEnd);
    // 채움은 끝난 것으로 보여 준다 — 시간 초과로 풀렸어도 게이지가 덜 찬 채 사라지면 「멈춘 것」처럼 보인다.
    this.squad = 1;
    this.waiting = 0;
  }

  private hide(): void {
    if (!this.active) return;
    this.active = false;
    this.fading = false;
    this.root.hidden = true;
    this.lastOpacity = 0;
    this.root.style.opacity = '0';
  }

  /**
   * `dt` 는 **일부러 받지 않는다** — 로딩 게이트 동안 0 이기 때문이다. 모든 시간은 `performance.now()` 에서 온다.
   */
  update(): void {
    if (!this.active) return;
    const now = performance.now();

    // 사라짐 / 나타남
    let alpha: number;
    if (this.fading) {
      const t = (now - this.fadeAt) / (FADE_OUT_S * 1000);
      if (t >= 1) { this.hide(); return; }
      alpha = t <= 0 ? 1 : 1 - t;
    } else {
      alpha = Math.min(1, (now - this.shownAt) / (FADE_IN_S * 1000));
    }
    if (Math.abs(alpha - this.lastOpacity) > 0.01) {
      this.lastOpacity = alpha;
      this.root.style.opacity = alpha.toFixed(2);
    }

    const p = Math.min(1, Math.max(0, this.squad));
    if (Math.abs(p - this.lastP) > 0.004) {
      this.lastP = p;
      this.ring.style.setProperty('--p', p.toFixed(3));
      setText(this.pctEl, `${Math.round(p * 100)} %`);
    }

    const deg = Math.round(((now - this.shownAt) / 1000 * SPIN_DEG_PER_S) % 360);
    if (deg !== this.lastSpin) {
      this.lastSpin = deg;
      this.spin.style.transform = `rotate(${deg}deg)`;
    }

    if (this.waiting !== this.lastWait) {
      this.lastWait = this.waiting;
      this.waitEl.hidden = this.waiting <= 0;
      if (this.waiting > 0) setText(this.waitEl, `${this.waiting}명 대기 중`);
      toggleClass(this.root, 'waiting', this.waiting > 0);
    }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
