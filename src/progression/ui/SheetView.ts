import type { EmbeddedView, GameContext, SkillId, StatId } from '@/shared';
import type { CharacterSheetHost } from './SheetBody';
import { el, SheetBody } from './SheetBody';
import './character.css';

/**
 * The **embedded** character sheet (Phase 8) — `ProgressionRef.createSheetView(host)`. Renders exactly the same body
 * as the standalone overlay into the caller's `host` element (the 캐릭터 tab of the inventory Tab screen).
 *
 * Deliberately does **not**: add the `'stats'` blocker, exit / re-request the pointer lock, install a window-level
 * Escape listener or draw the `.scr-tabs` pill — the inventory window owns all four. The warning popups the body raises
 * (`shared/holdAsk`) hold their own blocker token and Escape entry for as long as they are up.
 *
 * 2026-09-13: `requestLeave` (the optional `EmbeddedView` hook) — the inventory window asks before switching tab / closing on
 * Tab or Escape, and the body raises the 버리고 이동 / 돌아가기 warning while ＋ points are unconfirmed.
 */
export class SheetView implements EmbeddedView {
  private wrap: HTMLElement;
  private body: SheetBody;
  private disposed = false;

  constructor(ctx: GameContext, host: CharacterSheetHost, container: HTMLElement) {
    this.wrap = el('div', { cls: 'cs-embed', parent: container });
    this.body = new SheetBody(ctx, host, this.wrap, { variant: 'embed' });
    this.body.refresh();
  }

  /** Repaint — pending points survive it (ProgressionSystem calls this on every stat / skill / derived change). */
  refresh(): void {
    if (this.disposed) return;
    this.body.refresh();
  }

  /** Partial updates driven by ProgressionSystem while the tab is open. */
  refreshSkill(id: SkillId): void { if (!this.disposed) this.body.refreshSkill(id); }
  refreshStat(id: StatId): void { if (!this.disposed) this.body.refreshStat(id); }

  requestLeave(proceed: () => void): boolean { return !this.disposed && this.body.requestLeave(proceed); }

  /** Forced exit — ProgressionSystem (server document, reset, phase change, death). */
  discardPending(): void { if (!this.disposed) this.body.discardPending(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.body.dispose();
    this.wrap.remove();
  }
}
