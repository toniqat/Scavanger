import type { GameContext, LaunchWarning } from '@/shared';
import { el, setText } from './dom';

/** What the panel needs from HubSystem. */
export interface LaunchWarnHost {
  /** Called after the panel closed so the hub re-locks the pointer (same contract the other hub menus use). */
  onClosed(): void;
}

/**
 * The launch readiness warning (`.menu.hub-menu.launch-warn`, 2026-09-08).
 *
 * **2026-09-14: it comes up just before readying, not on boarding.** The moment `Space` has been held for a second in
 * a launch slot, whatever `ctx.inventory.getLaunchWarnings()` returns is raised as one card. No primary · less than
 * one set of ammo · no bag · no armor · no tactical implant · no healing item — each of the six stands as one headline
 * row plus one detail row, with **[그래도 준비]** and **[취소]** below. Boarding the pod itself now asks nothing
 * (sitting down is not a commitment).
 *
 * **It never blocks.** Confirming readies as asked, and the same combination of warnings (`signature`) never comes up
 * again — fixing any one piece of gear, or tripping a different item, changes the signature and it returns. Cancelling
 * remembers nothing.
 *
 * Cursor etiquette is the other ship panels': add the `'hub'` blocker first, then turn the software cursor on — the
 * pointer lock is kept (`exitPointerLock()` is never called). Since the 2026-09-08 Escape rule change Escape falls
 * through to the pause menu, so the keyboard cancel is caught by the first branch of `HubSystem.update`'s **E** chain
 * (`launchWarn.isOpen → close()`).
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
    this.button(foot, '그래도 준비', () => this.confirm(), 'primary');

    root.addEventListener('mousedown', (e) => e.stopPropagation());   // keep clicks off the canvas' click-to-lock fallback
  }

  get isOpen(): boolean { return this._open; }

  /** Stable key for a warning set — `boardPod` remembers the one the player waved through. */
  static signatureOf(warnings: readonly LaunchWarning[]): string {
    return warnings.map((w) => w.id).join(',');
  }

  /** Raise the panel. `onConfirm` runs on 그래도 준비, after the panel has closed and released its blocker. */
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

  /** 그래도 준비: close first (the ready gate refuses to run while a blocker is up), then run the callback. */
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
