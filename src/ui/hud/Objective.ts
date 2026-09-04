import type { GameContext } from '@/shared';
import { el, setText, toggleClass, fmtTime, setVisible } from '../dom';

export const OBJECTIVE_TEXT = {
  find: { text: '탈출 지점을 찾아 스위치를 활성화하세요', sub: '컴퍼스의 마커를 따라 이동' },
  countdown: { text: '함선 도착까지 대기', sub: '탈출 지점을 사수하세요' },
  board: { text: '함선에 탑승하세요', sub: '후방 램프를 통해 진입' },
  liftoffSwitch: { text: '함선 내부 스위치를 작동하세요', sub: '탑승 완료 — 이륙 준비' },
  liftoff: { text: '이륙 중', sub: '임무 완료까지 대기' },
} as const;

/** Top-left objective panel + large digital countdown timer under the compass. */
export class Objective {
  readonly root: HTMLElement;
  readonly timerRoot: HTMLElement;
  private textEl: HTMLElement;
  private subEl: HTMLElement;
  private timeEl: HTMLElement;
  private lastTimeStr = '';
  private counting = false;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'objective', parent });
    const head = el('div', { cls: 'head', parent: this.root });
    el('span', { cls: 'ui-label', text: '임무 목표', parent: head });
    this.textEl = el('div', { cls: 'text', text: '', parent: this.root });
    this.subEl = el('div', { cls: 'sub', text: '', parent: this.root });

    this.timerRoot = el('div', { cls: 'countdown hidden ui-fade', parent });
    el('div', { cls: 'ui-label', text: '함선 도착까지', parent: this.timerRoot });
    this.timeEl = el('div', { cls: 'time', text: '02:00', parent: this.timerRoot });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('ui:objective', ({ text, subText }) => this.set(text, subText ?? '')),
      b.on('extraction:activated', () => {
        this.counting = true;
        this.timerRoot.classList.remove('urgent', 'arrived');
        setVisible(this.timerRoot, true);
      }),
      b.on('extraction:tick', ({ remaining }) => {
        if (!this.counting) return;
        const s = fmtTime(remaining);
        if (s !== this.lastTimeStr) { this.lastTimeStr = s; setText(this.timeEl, s); }
        toggleClass(this.timerRoot, 'urgent', remaining <= 30 && remaining > 0);
      }),
      b.on('extraction:shipLanded', () => {
        this.counting = false;
        this.timerRoot.classList.remove('urgent');
        this.timerRoot.classList.add('arrived');
        setText(this.timeEl, '도착');
        window.setTimeout(() => { if (!this.counting) setVisible(this.timerRoot, false); }, 2500);
      }),
      b.on('game:abort', () => this.reset()),
      b.on('game:newMission', () => this.reset()),
    );
  }

  private reset(): void {
    this.counting = false;
    this.lastTimeStr = '';
    this.timerRoot.classList.remove('urgent', 'arrived');
    setVisible(this.timerRoot, false);
    this.set('', '');
  }

  set(text: string, sub: string): void {
    if (this.textEl.textContent === text && this.subEl.textContent === sub) return;
    setText(this.textEl, text);
    setText(this.subEl, sub);
    this.root.classList.remove('swap');
    void this.root.offsetWidth;
    this.root.classList.add('swap');
    this.root.style.opacity = text ? '1' : '0';
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); this.timerRoot.remove(); }
}
