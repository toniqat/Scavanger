import type { GameContext } from '@/shared';
import { el, setText, toggleClass, fmtTime, setVisible } from '../dom';
import '../styles/raidHud.css';

/**
 * 2026-09-10: the mission objective text is gone from the screen (user's decision — the top left keeps **the mission clock only**).
 * This table is a contract and is not deleted: `ui/HudSystem` still emits `ui:objective` per phase and
 * `src/ui/index.ts` exports it. It is only that nobody draws the text any more.
 */
export const OBJECTIVE_TEXT = {
  find: { text: '탈출 지점을 찾아 스위치를 활성화하세요', sub: '컴퍼스의 마커를 따라 이동' },
  countdown: { text: '함선 도착까지 대기', sub: '함선이 곧 착륙합니다' },
  board: { text: '함선에 탑승하세요', sub: '후방 램프를 통해 진입' },
  liftoffSwitch: { text: '함선 내부 스위치로 출발을 시작하세요', sub: '탑승 완료 — 스위치 뒤 10초 유예' },
  liftoff: { text: '이륙 중', sub: '임무 완료까지 대기' },
  /** 2026-09-13 (the extraction rework): the departure grace — it cannot be cancelled, and at 0 only those alive inside the ship leave. */
  departing: { text: '함선이 곧 출발합니다', sub: '함선 안에 있어야 탈출합니다' },
  /** Phase 7 training arena (`ctx.isTraining()`): world/ refreshes `subText` with the target hit counter. */
  training: { text: '시뮬레이션 훈련장 · 출구 콘솔로 종료', sub: '탄약 · 내구도 미소모' },
} as const;

/**
 * Whether this is the tutorial raid — while it is, **both widgets of this file are gone entirely** (2026-09-14, user's decision — the `Objective` head comment below).
 *
 * Why the rule hangs on the **mission kind** and not on tutorial **progress**: the clock and the extraction timer are a property of that raid itself.
 * Skipping the track (= extracting at once) still leaves it the tutorial raid, and outside a raid it is always false.
 * The old gate (`hides('hud', 'extractionTimer')` — true while the track runs) is a contract, so it is read as well.
 */
function tutorialRaid(ctx: GameContext): boolean {
  return ctx.missionMode === 'tutorial' || (ctx.tutorial?.hides('hud', 'extractionTimer') ?? false);
}

/**
 * The top-left **mission clock** + the big extraction countdown under the compass.
 *
 * 2026-09-10: the `임무 목표` label · the objective text (`.text`) · the sub text (`.sub`) are all gone. What is left is the diamond
 * mark in `.head` and one clock, and the clock grew by that much (`styles/raidHud.css`). The training range's hit / kill counter is
 * already drawn by `hud/TrainingPanel` in its own panel, so it does not leave the screen without this row.
 *
 * `set()` is a **no-op kept as a contract** — `HudSystem` calls it on every extraction countdown, but that number is
 * already drawn large by the `.countdown` timer below.
 *
 * **2026-09-14 (tutorial, user's decision) — in the tutorial raid there is neither the top-left clock nor the top-centre timer.**
 * The 2nd decision took out only 「도착」 · 「자동 출발까지」 and kept 「함선 도착까지」 · 「함선 출발까지」, but the tutorial ship
 * is already standing there (`beginPreLanded` emitting `extraction:activated` left 「함선 도착까지 00:20」 up and frozen), and from the 3rd
 * pass pressing the switch lifts off at once with no grace (`skipToLiftoff`), so there is not one fact left to state. Both roots (`.objective` ·
 * `.countdown`) carry `.hud-tut-hidden` (`display:none !important`) so nothing fights `setVisible`, and the handlers do not enter
 * a mode either — so the old mode never flashes for a frame in the raid after the tutorial.
 */
export class Objective {
  readonly root: HTMLElement;
  readonly timerRoot: HTMLElement;
  private timeEl: HTMLElement;
  private labelEl: HTMLElement;
  private clockEl: HTMLElement;
  private lastClockStr = '';
  private lastTimeStr = '';
  /** Whether `.hud-tut-hidden` is on both roots (the class is touched only on change). */
  private tutHidden = false;
  /**
   * 2026-09-13 (the extraction rework): which timer the big widget shows. `countdown` 함선 도착까지 → `arrived` 「도착」 (2.5 s) →
   * `waiting` 자동 출발까지 → `departing` 함선 출발까지 (urgent) → hidden on liftoff / reset. Everyone sees it, aboard or not.
   *
   * 2026-09-14 (tutorial): while `tutorialRaid` is true it enters **no mode at all** (the head comment above).
   */
  private mode: 'none' | 'countdown' | 'arrived' | 'waiting' | 'departing' = 'none';
  private arrivedTimer = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'objective', parent });
    const head = el('div', { cls: 'head', parent: this.root });
    // 2026-09-07: the mission clock moved here from the top-right `mission-info` block (which also carried the kill counter,
    // now dropped entirely). 2026-09-10: it is the only thing left in this corner.
    this.clockEl = el('span', { cls: 'clock ui-mono', text: '00:00', parent: head });

    this.timerRoot = el('div', { cls: 'countdown hidden ui-fade', parent });
    this.labelEl = el('div', { cls: 'ui-label', text: '함선 도착까지', parent: this.timerRoot });
    this.timeEl = el('div', { cls: 'time', text: '00:20', parent: this.timerRoot });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('extraction:activated', () => {
        if (tutorialRaid(ctx)) return;
        this.setMode('countdown', '함선 도착까지');
        setVisible(this.timerRoot, true);
      }),
      b.on('extraction:tick', ({ remaining }) => {
        if (this.mode !== 'countdown') return;
        this.setTime(fmtTime(remaining));
        toggleClass(this.timerRoot, 'urgent', remaining <= 10 && remaining > 0);
      }),
      b.on('extraction:shipLanded', () => {
        if (tutorialRaid(ctx)) return;
        this.setMode('arrived', '함선 도착까지');
        this.timerRoot.classList.add('arrived');
        this.setTime('도착');
        setVisible(this.timerRoot, true);
        window.clearTimeout(this.arrivedTimer);
        this.arrivedTimer = window.setTimeout(() => { if (this.mode === 'arrived') this.setMode('waiting', '자동 출발까지'); }, 2500);
      }),
      // 2026-09-13: the idle timer, then the uncancellable grace
      b.on('extraction:departureTick', ({ stage, remaining }) => {
        if (tutorialRaid(ctx)) return;
        if (stage === 'waiting') {
          if (this.mode === 'arrived') return;   // keep 「도착」 up for its 2.5 s
          if (this.mode !== 'waiting') this.setMode('waiting', '자동 출발까지');
          this.setTime(fmtTime(remaining));
        } else {
          if (this.mode !== 'departing') { this.setMode('departing', '함선 출발까지'); this.timerRoot.classList.add('urgent'); }
          this.setTime(fmtTime(Math.ceil(remaining)));
        }
        setVisible(this.timerRoot, true);
      }),
      b.on('extraction:liftoff', () => this.reset()),
      b.on('extraction:reset', () => this.reset()),
      b.on('game:abort', () => this.reset()),
      b.on('game:newMission', () => this.reset()),
    );
  }

  private setMode(mode: Objective['mode'], label: string): void {
    this.mode = mode;
    this.timerRoot.classList.remove('urgent', 'arrived');
    setText(this.labelEl, label);
    this.lastTimeStr = '';
  }

  private setTime(s: string): void {
    if (s === this.lastTimeStr) return;
    this.lastTimeStr = s;
    setText(this.timeEl, s);
  }

  /** Mission clock; called every frame by `HudSystem`. */
  update(ctx: GameContext): void {
    const tut = tutorialRaid(ctx);
    if (tut !== this.tutHidden) {
      this.tutHidden = tut;
      toggleClass(this.root, 'hud-tut-hidden', tut);
      toggleClass(this.timerRoot, 'hud-tut-hidden', tut);
    }
    if (tut) return;
    const t = fmtTime(ctx.missionTime);
    if (t === this.lastClockStr) return;
    this.lastClockStr = t;
    setText(this.clockEl, t);
  }

  /** Smoke hook (2026-09-14): this is the tutorial raid, so the clock · timer are folded away entirely. */
  get hiddenForTutorial(): boolean { return this.tutHidden; }

  private reset(): void {
    this.mode = 'none';
    window.clearTimeout(this.arrivedTimer);
    this.lastTimeStr = '';
    this.timerRoot.classList.remove('urgent', 'arrived');
    setVisible(this.timerRoot, false);
  }

  /** A no-op kept for the contract (2026-09-10: the objective text is no longer drawn). */
  set(_text: string, _sub: string): void { /* no objective text */ }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); this.timerRoot.remove(); }
}
