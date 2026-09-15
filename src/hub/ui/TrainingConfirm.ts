import type { GameContext } from '@/shared';
import { el } from './dom';

/* ────────────────────────────────────────────────────────────────────────────
 * 시뮬레이션 훈련장 입장 확인 (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 분대 · 도킹 매칭」 — 사용자 결정).
 *
 * 터미널 행성 탭 우하단의 `시뮬레이션 훈련장` 버튼이 곧장 입장하지 않고 이 카드를 띄운다. **되돌릴 수 있는 일**이라
 * 1초 홀드가 아니라 클릭 확정이다 (「되돌릴 수 없는 확정은 1초 홀드다」의 반대편). Escape · Tab · E 는 취소이고,
 * 초기 포커스는 `취소` 라 Enter 도 취소를 누른다.
 *
 * 화면 규약: 자기 blocker / escape 토큰 `hub:trainConfirm` (터미널의 `hub` 와 **다른 토큰** — 닫혀도 뒤의 터미널이
 * 커서를 잃지 않는다), 키 가이드 owner `hub.trainConfirm`(닫기 항목은 가이드가 스스로 붙인다).
 * CSS 접두사 `.htc-` (`hub/intel.css`). Owner: hub/ui. 여는 곳 — `HubMenu` 푸터의 `.hub-train`.
 * ──────────────────────────────────────────────────────────────────────────── */

const TOKEN = 'hub:trainConfirm';
const GUIDE_OWNER = 'hub.trainConfirm';

export class TrainingConfirm {
  readonly root: HTMLElement;
  private readonly btnCancel: HTMLButtonElement;
  private _open = false;
  private onConfirm: (() => void) | null = null;

  constructor(private readonly ctx: GameContext, private readonly onClosed: () => void) {
    const root = this.root = el('div', { cls: 'menu hub-menu htc-confirm interactive', parent: ctx.uiRoot });
    root.hidden = true;
    const f = el('div', { cls: 'frame', parent: root });
    const head = el('div', { cls: 'hub-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '시뮬레이션 훈련장', parent: hl });
    el('div', { cls: 'htc-body', text: '시뮬레이션 훈련장에 입장하시겠습니까?', parent: f });
    const foot = el('div', { cls: 'hub-foot', parent: f });
    const right = el('div', { cls: 'right', parent: foot });
    this.btnCancel = this.button(right, '취소', () => this.close(), 'htc-cancel');
    this.button(right, '입장', () => this.confirm(), 'primary htc-ok');
    root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  get isOpen(): boolean { return this._open; }

  open(onConfirm: () => void): void {
    this.onConfirm = onConfirm;
    if (this._open) return;
    this._open = true;
    this.root.hidden = false;
    this.ctx.uiBlockers.add(TOKEN);
    this.ctx.escape.push(TOKEN, () => this.close());
    this.ctx.input.setCursorMode(true, TOKEN);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: [] });
    this.btnCancel.focus();
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.onConfirm = null;
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(TOKEN);
    this.ctx.escape.remove(TOKEN);
    this.ctx.input.setCursorMode(false, TOKEN);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: null });
    this.onClosed();
  }

  /** `입장` — 카드를 먼저 닫고(토큰을 놓고) 입장을 부른다. 거절 사유는 `startTraining` 이 토스트로 말한다. */
  private confirm(): void {
    const run = this.onConfirm;
    this.close();
    run?.();
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`, text: label, parent });
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); onClick(); });
    return b;
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }
}
