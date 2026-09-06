import type { GameContext, SkillId, StatId } from '@/shared';
import { Keys } from '@/shared';
import type { CharacterSheetHost } from './SheetBody';
import { el, SheetBody } from './SheetBody';
import './character.css';

export type { CharacterSheetHost } from './SheetBody';

const BLOCKER = 'stats';

/**
 * 캐릭터 시트 (`.menu.char-sheet`) — the **standalone overlay**: level + XP bar, the five stats with a `＋` button
 * that only works in the ship, the fourteen skills with their training progress, and a readout of every derived
 * number. The body itself is `SheetBody`, shared with the embedded 캐릭터 tab (`SheetView`) so there is exactly one
 * renderer (Phase 8).
 *
 * Opened / closed by `ui:statsToggled` (the ship terminal / `P`) — see ProgressionSystem.
 * Carries the shared screen tabs (인벤토리 → closes the sheet and opens the inventory window · 캐릭터 · 기업 disabled). Adds the
 * `'stats'` UI blocker token **before** exiting pointer lock, and re-locks on close when nothing else blocks.
 */
export class CharacterSheet {
  readonly root: HTMLElement;
  private frame: HTMLElement;
  private body: SheetBody;
  private _open = false;

  private escHandler = (e: KeyboardEvent): void => {
    if (e.code !== Keys.MENU || !this._open) return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  constructor(private readonly ctx: GameContext, host: CharacterSheetHost) {
    const root = this.root = el('div', { cls: 'menu char-sheet interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    // Screen tabs shared with the inventory window (same look, `.scr-tabs` in ui/styles/base.css).
    const tabs = el('nav', { cls: 'scr-tabs', parent: root });
    const tabInv = el('button', { cls: 'scr-tab', text: '인벤토리', parent: tabs });
    tabInv.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.close(false);
      this.ctx.inventory?.toggleBag();
    });
    el('button', { cls: 'scr-tab is-on', text: '캐릭터', parent: tabs });
    const tabCorp = el('button', { cls: 'scr-tab is-disabled', text: '기업', parent: tabs, attrs: { disabled: '', title: '기업 · 계약 · 퀘스트는 준비 중입니다' } });
    tabCorp.disabled = true;
    const f = this.frame = el('div', { cls: 'frame', parent: root });

    this.body = new SheetBody(ctx, host, f, { hint: 'ESC 또는 P 로 닫기', onClose: () => this.close() });

    root.addEventListener('mousedown', (e) => e.stopPropagation());
    window.addEventListener('keydown', this.escHandler, true);
  }

  get isOpen(): boolean { return this._open; }

  /* ── open / close ─────────────────────────────────────────────────────── */
  open(): void {
    if (this._open) return;
    this._open = true;
    this.body.disarmReset();
    // Blocker first, then exit the lock, so GameFlow's pointerlockchange handler sees an intended exit.
    this.ctx.uiBlockers.add(BLOCKER);
    this.ctx.input.exitPointerLock();
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    this.refresh();
    this.ctx.bus.emit('ui:statsToggled', { open: true });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(relock = true): void {
    if (!this._open) return;
    this._open = false;
    this.body.disarmReset();
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(BLOCKER);
    this.ctx.bus.emit('ui:statsToggled', { open: false });
    if (!relock) return;
    // The key press / click that closed us is a user activation → Chrome allows re-locking here.
    queueMicrotask(() => {
      const ctx = this.ctx;
      if (this._open || ctx.uiBlockers.size > 0) return;
      if (!ctx.isGameplayPhase() && !ctx.isHubPhase()) return;
      if (ctx.player?.isDead ?? false) return;
      ctx.input.requestPointerLock();
    });
  }

  /* ── rendering (delegated to the shared body, skipped while hidden) ────── */
  refresh(): void { if (this._open) this.body.refresh(); }
  refreshSkill(id: SkillId): void { if (this._open) this.body.refreshSkill(id); }
  refreshStat(id: StatId): void { if (this._open) this.body.refreshStat(id); }

  dispose(): void {
    window.removeEventListener('keydown', this.escHandler, true);
    this.ctx.uiBlockers.delete(BLOCKER);
    this._open = false;
    this.body.dispose();
    this.root.remove();
  }
}
