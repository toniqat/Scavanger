import type { GameContext, SkillId, StatId } from '@/shared';
import { Keys, MENU_BLOCKER } from '@/shared';
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
 * Opened by `ui:statsToggled` — see ProgressionSystem. **Closed by Tab** since 2026-09-08 (Escape is the
 * 일시정지 메뉴 everywhere), the same key that opens the 캐릭터 tab of the inventory window.
 * Carries the shared screen tabs (인벤토리 → closes the sheet and opens the inventory window · 캐릭터 · 기업 disabled). Adds the
 * `'stats'` UI blocker token and then turns on the **in-game cursor** (`input.setCursorMode(true, 'stats')` —
 * Phase 10: the pointer lock is *kept* and a virtual cursor synthesises the DOM events, so `exitPointerLock()` and
 * the microtask re-lock are both gone).
 */
export class CharacterSheet {
  readonly root: HTMLElement;
  private frame: HTMLElement;
  private body: SheetBody;
  private _open = false;

  /**
   * 2026-09-08: the sheet closes on **Tab** (`Keys.INVENTORY`), the key that opens the same screen as a tab of the
   * inventory window. Escape is no longer handled here at all — it falls through to `game/` and is the 일시정지 메뉴,
   * which then stacks on top of this overlay. The 전술 임플란트 picker still eats its own Escape (`SheetBody`).
   */
  private escHandler = (e: KeyboardEvent): void => {
    if (e.code !== Keys.INVENTORY || !this._open) return;
    if (this.ctx.uiBlockers.has(MENU_BLOCKER)) return;     // the 일시정지 메뉴 is on top — it owns the keyboard
    const t = e.target;                                    // capture-phase: never steal a Tab out of a focused field
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    e.stopPropagation();
    this.requestClose();
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
      const go = (): void => { this.close(false); this.ctx.inventory?.toggleBag(); };
      if (!this.body.requestLeave(go)) go();          // 2026-09-13: unconfirmed ＋ points ask first
    });
    el('button', { cls: 'scr-tab is-on', text: '캐릭터', parent: tabs });
    const tabCorp = el('button', { cls: 'scr-tab is-disabled', text: '기업', parent: tabs, attrs: { disabled: '', title: '기업 · 계약 · 퀘스트는 준비 중입니다' } });
    tabCorp.disabled = true;
    const f = this.frame = el('div', { cls: 'frame', parent: root });

    this.body = new SheetBody(ctx, host, f, { hint: 'Tab 으로 닫기', onClose: () => this.requestClose(), variant: 'overlay' });

    root.addEventListener('mousedown', (e) => e.stopPropagation());
    window.addEventListener('keydown', this.escHandler, true);
  }

  get isOpen(): boolean { return this._open; }

  /**
   * 2026-09-13: the player's own close (Tab · Escape · 닫기). Returns true when the body intercepted it — unconfirmed ＋ points
   * raised the 버리고 이동 / 돌아가기 warning (or a popup of the body was up and this press was its 돌아가기).
   */
  requestClose(): boolean {
    if (this.body.requestLeave(() => this.close())) return true;
    this.close();
    return false;
  }

  /** Forced exit (ProgressionSystem): drop unconfirmed points and the body's popups without asking. */
  discardPending(): void { this.body.discardPending(); }

  /* ── open / close ─────────────────────────────────────────────────────── */
  open(): void {
    if (this._open) return;
    this._open = true;
    this.body.discardPending();
    // Blocker first, then the in-game cursor — the pointer lock is kept, so GameFlow never sees an exit at all.
    this.ctx.uiBlockers.add(BLOCKER);
    // an intercepted close keeps the entry on the stack (`false`); the warning popup sits above it with its own entry
    this.ctx.escape.push(BLOCKER, () => (this.requestClose() ? false : undefined));
    this.ctx.input.setCursorMode(true, BLOCKER);
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    this.refresh();
    // 2026-09-09 키 가이드: the sheet is mouse-only, so its line is the guide's own `Tab 닫기` (owner `'character'`)
    this.ctx.bus.emit('ui:keyGuide', { owner: 'character', keys: [] });
    this.ctx.bus.emit('ui:statsToggled', { open: true });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** `relock` is kept for the call signature only — Phase 10 never dropped the lock, so there is nothing to re-lock. */
  close(_relock = true): void {
    if (!this._open) return;
    this._open = false;
    this.body.discardPending();                        // every path that gets here already asked (or is a forced close)
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(BLOCKER);
    this.ctx.escape.remove(BLOCKER);
    this.ctx.input.setCursorMode(false, BLOCKER);
    this.ctx.bus.emit('ui:keyGuide', { owner: 'character', keys: null });
    this.ctx.bus.emit('ui:statsToggled', { open: false });
  }

  /* ── rendering (delegated to the shared body, skipped while hidden) ────── */
  refresh(): void { if (this._open) this.body.refresh(); }
  refreshSkill(id: SkillId): void { if (this._open) this.body.refreshSkill(id); }
  refreshStat(id: StatId): void { if (this._open) this.body.refreshStat(id); }

  dispose(): void {
    window.removeEventListener('keydown', this.escHandler, true);
    this.ctx.uiBlockers.delete(BLOCKER);
    this.ctx.escape.remove(BLOCKER);
    this.ctx.input.setCursorMode(false, BLOCKER);
    this._open = false;
    this.body.dispose();
    this.root.remove();
  }
}
