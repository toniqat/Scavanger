import type { GameContext } from '@/shared';
import { el, setText, toggleClass, fmtTime, setVisible } from '../dom';
import '../styles/raidHud.css';

/**
 * 2026-09-10: 임무 목표 문구는 화면에서 사라졌다 (사용자 결정 — 좌측 상단에는 **임무 시간만** 남는다).
 * 이 표는 계약이라 지우지 않는다: `ui/HudSystem` 이 페이즈마다 `ui:objective` 를 계속 내보내고
 * `src/ui/index.ts` 가 export 한다. 지금은 아무도 그 문구를 그리지 않을 뿐이다.
 */
export const OBJECTIVE_TEXT = {
  find: { text: '탈출 지점을 찾아 스위치를 활성화하세요', sub: '컴퍼스의 마커를 따라 이동' },
  countdown: { text: '함선 도착까지 대기', sub: '함선이 곧 착륙합니다' },
  board: { text: '함선에 탑승하세요', sub: '후방 램프를 통해 진입' },
  liftoffSwitch: { text: '함선 내부 스위치로 출발을 시작하세요', sub: '탑승 완료 — 스위치 뒤 10초 유예' },
  liftoff: { text: '이륙 중', sub: '임무 완료까지 대기' },
  /** 2026-09-13 (탈출 개편): 출발 유예 — 취소되지 않고, 0 이 되면 함선 안에 살아 있는 사람만 떠난다. */
  departing: { text: '함선이 곧 출발합니다', sub: '함선 안에 있어야 탈출합니다' },
  /** Phase 7 training arena (`ctx.isTraining()`): world/ refreshes `subText` with the target hit counter. */
  training: { text: '시뮬레이션 훈련장 · 출구 콘솔로 종료', sub: '탄약 · 내구도 미소모' },
} as const;

/**
 * 튜토리얼 레이드인가 — 그 동안 이 파일의 **두 위젯이 통째로 없다** (2026-09-14, 사용자 결정 — 아래 `Objective` 머리 주석).
 *
 * 규칙이 튜토리얼 **진행도**가 아니라 **미션 종류**에 붙는 이유: 시계와 탈출 타이머는 그 레이드 자체의 성질이다.
 * 트랙을 건너뛰어도(= 즉시 탈출) 여전히 튜토리얼 레이드이고, 레이드가 아니면 언제나 false 다.
 * 옛 게이트(`hides('hud', 'extractionTimer')` — 트랙이 도는 동안 true)는 계약이라 함께 본다.
 */
function tutorialRaid(ctx: GameContext): boolean {
  return ctx.missionMode === 'tutorial' || (ctx.tutorial?.hides('hud', 'extractionTimer') ?? false);
}

/**
 * 좌측 상단 **임무 시간** + 나침반 아래의 큰 탈출 카운트다운.
 *
 * 2026-09-10: `임무 목표` 라벨 · 목표 문구(`.text`) · 보조 문구(`.sub`) 가 전부 없어졌다. 남은 것은 `.head` 의
 * 마름모 표식과 시계 하나뿐이고, 그만큼 시계가 커졌다 (`styles/raidHud.css`). 훈련장의 명중/격추 카운터는
 * `hud/TrainingPanel` 이 이미 자기 패널에 그리므로 이 줄이 없어도 화면에서 사라지지 않는다.
 *
 * `set()` 은 **계약으로 남긴 no-op** 이다 — `HudSystem` 이 탈출 카운트다운마다 부르는데, 그 숫자는
 * 아래 `.countdown` 타이머가 이미 크게 그리고 있다.
 *
 * **2026-09-14 (튜토리얼, 사용자 결정) — 튜토리얼 레이드에서는 좌측 상단 시계도, 상단 중앙 타이머도 없다.**
 * 2차 결정은 「도착」 · 「자동 출발까지」 만 걷어 내고 「함선 도착까지」 · 「함선 출발까지」 는 남겼는데, 튜토리얼 함선은
 * 이미 서 있고(`beginPreLanded` 가 `extraction:activated` 를 내면서 「함선 도착까지 00:20」이 뜬 채 멈춰 있었다)
 * 3차부터 스위치를 누르면 유예 없이 곧장 뜨므로(`skipToLiftoff`) 남길 사실이 하나도 없다. 두 뿌리(`.objective` ·
 * `.countdown`)에 `.hud-tut-hidden`(`display:none !important`)을 달아 `setVisible` 과 싸우지 않고, 핸들러도 모드에
 * 들어가지 않는다 — 튜토리얼이 끝난 다음 레이드에서 옛 모드가 한 프레임 비치지 않게.
 */
export class Objective {
  readonly root: HTMLElement;
  readonly timerRoot: HTMLElement;
  private timeEl: HTMLElement;
  private labelEl: HTMLElement;
  private clockEl: HTMLElement;
  private lastClockStr = '';
  private lastTimeStr = '';
  /** 두 뿌리에 `.hud-tut-hidden` 이 달려 있다 (바뀔 때만 클래스를 만진다). */
  private tutHidden = false;
  /**
   * 2026-09-13 (탈출 개편): which timer the big widget shows. `countdown` 함선 도착까지 → `arrived` 「도착」 (2.5 s) →
   * `waiting` 자동 출발까지 → `departing` 함선 출발까지 (urgent) → hidden on liftoff / reset. Everyone sees it, aboard or not.
   *
   * 2026-09-14 (튜토리얼): `tutorialRaid` 가 참이면 **어느 모드에도** 들어가지 않는다 (위 머리 주석).
   */
  private mode: 'none' | 'countdown' | 'arrived' | 'waiting' | 'departing' = 'none';
  private arrivedTimer = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'objective', parent });
    const head = el('div', { cls: 'head', parent: this.root });
    // 2026-09-07: the 임무 시간 moved here from the top-right `mission-info` block (which also carried the 처치 counter,
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

  /** Smoke hook (2026-09-14): 튜토리얼 레이드라 시계 · 타이머를 통째로 접고 있다. */
  get hiddenForTutorial(): boolean { return this.tutHidden; }

  private reset(): void {
    this.mode = 'none';
    window.clearTimeout(this.arrivedTimer);
    this.lastTimeStr = '';
    this.timerRoot.classList.remove('urgent', 'arrived');
    setVisible(this.timerRoot, false);
  }

  /** 계약 유지용 no-op (2026-09-10: 목표 문구는 더 이상 그리지 않는다). */
  set(_text: string, _sub: string): void { /* 목표 문구 없음 */ }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); this.timerRoot.remove(); }
}
