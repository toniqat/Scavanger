import type { GameContext, LaunchWarning } from '@/shared';
import { el, setText } from './dom';

/** What the panel needs from HubSystem. */
export interface LaunchWarnHost {
  /** Called after the panel closed so the hub re-locks the pointer (same contract the other hub menus use). */
  onClosed(): void;
}

/**
 * 출격 준비 경고 (`.menu.hub-menu.launch-warn`, 2026-09-08).
 *
 * 발사 슬롯에 타기 직전, `ctx.inventory.getLaunchWarnings()` 가 무언가를 돌려주면 그 목록을 한 장의 카드로 띄운다.
 * 주무기 없음 · 탄약 한 세트 미만 · 가방 없음 · 방탄복 없음 · 전술 임플란트 없음 · 회복 아이템 없음 — 여섯 가지
 * 각각이 표제 한 줄 + 상세 한 줄로 서고, 아래에 **[그래도 출격]** 과 **[취소]** 가 있다.
 *
 * **막지 않는다.** 확인하면 그대로 탑승하고, 같은 경고 조합(`signature`)에 대해서는 다시 뜨지 않는다 — 장비를
 * 하나라도 고치거나 다른 항목이 걸리면 서명이 달라지므로 그때는 새로 뜬다. 취소는 아무것도 기억하지 않는다.
 *
 * 커서 예절은 다른 함선 패널과 같다: `'hub'` blocker 를 먼저 넣고 소프트 커서를 켠다 — 포인터 락은 유지한다
 * (`exitPointerLock()` 은 부르지 않는다). 2026-09-08 ESC 규칙 변경 이후 Escape 는 일시정지 메뉴로 빠지므로,
 * 키보드 취소는 `HubSystem.update` 의 **E** 사슬이 첫 분기로 잡는다 (`launchWarn.isOpen → close()`).
 */
export class LaunchWarnPanel {
  readonly root: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly list: HTMLElement;
  private readonly subtitle: HTMLElement;
  private _open = false;
  /** Called by 그래도 출격 (cleared on every close, so a cancelled panel can never launch later). */
  private onConfirm: (() => void) | null = null;

  constructor(private readonly ctx: GameContext, private readonly host: LaunchWarnHost) {
    const root = this.root = el('div', { cls: 'menu hub-menu launch-warn interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    const f = this.frame = el('div', { cls: 'frame', parent: root });

    const head = el('div', { cls: 'hub-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '출격 준비 확인', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });

    const sec = el('div', { cls: 'hub-section', parent: f });
    el('div', { cls: 'ui-label', text: '확인이 필요한 항목', parent: sec });
    this.list = el('div', { cls: 'lw-list', parent: sec });

    const foot = el('div', { cls: 'hub-foot', parent: f });
    this.button(foot, '취소', () => this.close());
    this.button(foot, '그래도 출격', () => this.confirm(), 'primary');

    root.addEventListener('mousedown', (e) => e.stopPropagation());   // keep clicks off the canvas' click-to-lock fallback
  }

  get isOpen(): boolean { return this._open; }

  /** Stable key for a warning set — `boardPod` remembers the one the player waved through. */
  static signatureOf(warnings: readonly LaunchWarning[]): string {
    return warnings.map((w) => w.id).join(',');
  }

  /** Raise the panel. `onConfirm` runs on 그래도 출격, after the panel has closed and released its blocker. */
  open(warnings: readonly LaunchWarning[], onConfirm: () => void): void {
    if (this._open || warnings.length === 0) return;
    this._open = true;
    this.onConfirm = onConfirm;
    this.ctx.uiBlockers.add('hub');            // before the cursor mode (GameFlow / hub UI etiquette)
    this.ctx.escape.push('hub:launchWarn', () => this.close());
    this.ctx.input.setCursorMode(true, 'hub'); // keep the pointer lock; draw the software cursor
    setText(this.subtitle, `${warnings.length}가지 · 이대로 출격할 수 있지만 권장하지 않습니다`);
    this.list.replaceChildren();
    for (const w of warnings) {
      const row = el('div', { cls: 'lw-row', parent: this.list, attrs: { 'data-id': w.id } });
      el('span', { cls: 'mark', text: '!', parent: row }).setAttribute('aria-hidden', 'true');
      const body = el('span', { cls: 'body', parent: row });
      el('span', { cls: 'nm', text: w.text, parent: body });
      if (w.detail) el('span', { cls: 'sub', text: w.detail, parent: body });
    }
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
  }

  /** 그래도 출격: close first (the pod gate refuses to board while a blocker is up), then run the callback. */
  private confirm(): void {
    const go = this.onConfirm;
    this.close(false);
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    go?.();
  }

  /** `relock` false when the caller boards right away (boarding takes the camera and controls itself). */
  close(relock = true): void {
    if (!this._open) return;
    this._open = false;
    this.onConfirm = null;
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete('hub');
    this.ctx.escape.remove('hub:launchWarn');
    this.ctx.input.setCursorMode(false, 'hub');
    if (relock) this.host.onClosed();
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`, text: label, parent });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  dispose(): void {
    if (this._open) {
      this.ctx.uiBlockers.delete('hub');
      this.ctx.escape.remove('hub:launchWarn');
      this.ctx.input.setCursorMode(false, 'hub');
    }
    this._open = false;
    this.onConfirm = null;
    this.root.remove();
  }
}
