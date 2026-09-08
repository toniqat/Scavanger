import type { GameContext } from '@/shared';
import { TUTORIAL_BLOCKER } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Popup.ts — 시작 안내 카드와 건너뛰기 확인 카드.
 *
 * 두 카드는 같은 셸(`.tut-popup`)을 쓰고 버튼만 다르다.
 *   • **시작 안내** — 확인을 누르면 첫 단계로. `건너뛰기` 버튼도 함께 있다(요구사항).
 *   • **건너뛰기 확인** — 모달리스다: 뒤의 화면은 그대로 살아 있고, 취소하면 하던 자리로 돌아간다.
 *
 * 커서 예절은 함선 패널들과 같다 — `TUTORIAL_BLOCKER` 를 넣고 소프트 커서를 켜되 **포인터 락은 유지**한다.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PopupButton {
  label: string;
  kind?: 'primary' | 'danger' | '';
  onClick: () => void;
}

export class TutorialPopup {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly actsEl: HTMLElement;
  private _open = false;

  constructor(private readonly ctx: GameContext, private readonly onClosed: () => void) {
    const root = this.root = document.createElement('div');
    root.className = 'tut-popup interactive';
    root.hidden = true;
    this.card = document.createElement('div');
    this.card.className = 'tut-popup-card';
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'title';
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'body';
    this.actsEl = document.createElement('div');
    this.actsEl.className = 'acts';
    this.card.append(this.titleEl, this.bodyEl, this.actsEl);
    root.appendChild(this.card);
    root.addEventListener('mousedown', (e) => e.stopPropagation());
    ctx.uiRoot.appendChild(root);
  }

  get isOpen(): boolean { return this._open; }

  open(title: string, lines: readonly string[], buttons: readonly PopupButton[]): void {
    this.titleEl.textContent = title;
    this.bodyEl.replaceChildren();
    for (const l of lines) {
      const p = document.createElement('p');
      p.textContent = l;
      this.bodyEl.appendChild(p);
    }
    this.actsEl.replaceChildren();
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `ui-btn ${b.kind ?? ''}`.trim();
      el.textContent = b.label;
      el.addEventListener('click', (e) => { e.stopPropagation(); b.onClick(); });
      this.actsEl.appendChild(el);
    }
    if (this._open) return;
    this._open = true;
    this.ctx.uiBlockers.add(TUTORIAL_BLOCKER);      // blocker 먼저, 그 다음 커서 (함선 UI 예절)
    this.ctx.input.setCursorMode(true, TUTORIAL_BLOCKER);
    this.root.hidden = false;
    this.card.style.animation = 'none';
    void this.card.offsetWidth;
    this.card.style.animation = '';
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(TUTORIAL_BLOCKER);
    this.ctx.input.setCursorMode(false, TUTORIAL_BLOCKER);
    this.onClosed();
  }

  dispose(): void {
    if (this._open) {
      this.ctx.uiBlockers.delete(TUTORIAL_BLOCKER);
      this.ctx.input.setCursorMode(false, TUTORIAL_BLOCKER);
    }
    this._open = false;
    this.root.remove();
  }
}
