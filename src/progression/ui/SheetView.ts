import type { EmbeddedView, GameContext, SkillId, StatId } from '@/shared';
import type { CharacterSheetHost } from './SheetBody';
import { el, SheetBody } from './SheetBody';
import './character.css';

/**
 * The **embedded** character sheet (Phase 8) — `ProgressionRef.createSheetView(host)`. Renders exactly the same body
 * as the standalone overlay into the caller's `host` element (the 캐릭터 tab of the inventory Tab screen).
 *
 * Deliberately does **not**: add the `'stats'` blocker, exit / re-request the pointer lock, install a window-level
 * Escape listener or draw the `.scr-tabs` pill — the inventory window owns all four.
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

  refresh(): void {
    if (this.disposed) return;
    this.body.disarmReset();
    this.body.refresh();
  }

  /** Partial updates driven by ProgressionSystem while the tab is open. */
  refreshSkill(id: SkillId): void { if (!this.disposed) this.body.refreshSkill(id); }
  refreshStat(id: StatId): void { if (!this.disposed) this.body.refreshStat(id); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.body.dispose();
    this.wrap.remove();
  }
}
