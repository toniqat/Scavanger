import type { GameContext } from '@/shared';
import { el, setVisible } from '../dom';

/**
 * Shared plumbing for full-screen menus: blocker token, cursor mode, show/hide.
 *
 * 2026-09-07 (커서 rework): the pause menu used to be the one screen that released the pointer lock by hand, because
 * every other screen kept it and drove a virtual cursor. Now **every** cursor screen releases it, so this simply
 * takes the same `setCursorMode(true, 'menu')` token as the rest — `Input` does the `exitPointerLock`, and `main.ts`
 * re-locks once the last owner leaves.
 */
export abstract class MenuBase {
  readonly root: HTMLElement;
  protected frame: HTMLElement;
  protected ctx!: GameContext;
  protected unsubs: Array<() => void> = [];
  private _visible = false;

  constructor(parent: HTMLElement, cls: string) {
    this.root = el('div', { cls: `menu interactive hidden ${cls}`, parent });
    el('div', { cls: 'scan', parent: this.root });
    this.frame = el('div', { cls: 'frame', parent: this.root });
  }

  get visible(): boolean { return this._visible; }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  show(): void {
    if (this._visible) return;
    this._visible = true;
    setVisible(this.root, true);
    // restart the entry animation
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    this.ctx.uiBlockers.add('menu');
    this.ctx.input.setCursorMode(true, 'menu');
    this.onShow();
  }

  hide(): void {
    if (!this._visible) return;
    this._visible = false;
    setVisible(this.root, false);
    this.ctx.uiBlockers.delete('menu');
    this.ctx.input.setCursorMode(false, 'menu');
    this.onHide();
  }

  protected onShow(): void { /* override */ }
  protected onHide(): void { /* override */ }

  protected button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`, text: label, parent });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      onClick();
    });
    return b;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
