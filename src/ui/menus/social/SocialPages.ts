import type { GameContext, SocialCard, SocialPlayer } from '@/shared';
import { formatPlayerCode } from '@/shared';
import { el, setText } from '../../dom';
import { socialOf } from './socialSource';

/** Escape-stack token of an open page (above `COMMUNITY_BLOCKER`, so Escape closes the page before the panel). */
const PAGE_ESCAPE = 'community:page';

export interface SocialPagesHost {
  /** A 차단 목록 row was right-clicked: the column raises its context menu in its blocked form. */
  onContext(p: SocialPlayer, ev: MouseEvent): void;
  /** Kept for the column's option shape (the old 대화 기록 page's text field asked for it). */
  onRequestClose(): void;
}

type PageKind = 'blocked';

/**
 * The 친구 tab's sub-page (2026-09-11, B-4), laid **over** the social column (`.sc-page`, absolutely positioned inside
 * `.social-col`) so the panel keeps its fixed box:
 *
 *   - **차단 목록** (`openBlocked()`, the panel head's button) — `SocialRef.blocked`, each row with `차단 해제`
 *     (right-click offers the same). Redraws on `social:updated`.
 *
 * `← 뒤로` or Escape closes the page and leaves the panel open: the page pushes `community:page` onto `ctx.escape`
 * above the panel's own entry.
 *
 * 2026-09-14 (메신저): the **대화 기록** page is gone — a conversation with one 아이디 is now the messenger's 대화 tab
 * (`menus/messenger/ChatTab`), which reads the same `SocialRef.whisperHistory`.
 */
export class SocialPages {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private sub: HTMLElement;
  private body: HTMLElement;
  private empty: HTMLElement;
  private kind: PageKind | null = null;
  private unsubs: Array<() => void> = [];
  private ctx: GameContext | null = null;

  constructor(parent: HTMLElement, private readonly host: SocialPagesHost) {
    this.root = el('div', { cls: 'sc-page is-blocked', parent });
    this.root.hidden = true;
    const head = el('div', { cls: 'sc-page-head', parent: this.root });
    const back = el('button', { cls: 'sc-back', text: '← 뒤로', parent: head });
    back.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.title = el('span', { cls: 'sc-page-title', text: '', parent: head });
    this.sub = el('span', { cls: 'sc-page-sub ui-mono', text: '', parent: head });
    this.body = el('div', { cls: 'sc-page-body', parent: this.root });
    this.body.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.empty = el('div', { cls: 'sc-empty sc-page-empty', text: '', parent: this.root });
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.unsubs.push(
      ctx.bus.on('social:updated', () => { if (this.kind === 'blocked') this.render(); }),
    );
  }

  /** Which page is up (debug / smoke), null when none. */
  get openKind(): PageKind | null { return this.kind; }

  openBlocked(): void {
    this.kind = 'blocked';
    this.root.hidden = false;
    this.ctx?.escape.push(PAGE_ESCAPE, () => this.close());
    this.render();
  }

  /** Re-read the mirror for the open page (after a local mutation such as 차단 해제). */
  refresh(): void { if (this.kind) this.render(); }

  close(): void {
    if (!this.kind) return;
    this.kind = null;
    this.root.hidden = true;
    this.ctx?.escape.remove(PAGE_ESCAPE);
  }

  dispose(): void {
    this.close();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx || !this.kind) return;
    const blocked = socialOf(ctx)?.blocked ?? [];
    setText(this.title, '차단 목록');
    setText(this.sub, `${blocked.length}명 · 상대에게는 알리지 않습니다`);
    this.body.replaceChildren(...blocked.map((c) => this.blockedRow(c)));
    setText(this.empty, '차단한 플레이어가 없습니다');
    this.empty.hidden = blocked.length > 0;
  }

  private blockedRow(c: SocialCard): HTMLElement {
    const p: SocialPlayer = { ...c, presence: 'offline', squad: 0, joinable: false };
    const card = el('div', { cls: 'sc-card is-blocked' });
    card.dataset.code = c.code;
    const top = el('div', { cls: 'sc-top', parent: card });
    el('span', { cls: 'sc-id ui-mono', text: formatPlayerCode(c.code), parent: top });
    el('span', { cls: 'sc-lv ui-mono', text: c.level > 0 ? `Lv. ${c.level}` : 'Lv. —', parent: top });
    const bot = el('div', { cls: 'sc-bot', parent: card });
    el('span', { cls: 'sc-name', text: c.name || '이름 없음', parent: bot });
    const un = el('button', { cls: 'sc-act sc-unblock', text: '차단 해제', parent: bot });
    un.addEventListener('click', (e) => {
      e.stopPropagation();
      const ctx = this.ctx;
      if (!ctx) return;
      socialOf(ctx)?.block(c.code, false);
      this.render();
    });
    const open = (e: MouseEvent): void => { e.preventDefault(); e.stopPropagation(); this.host.onContext(p, e); };
    card.addEventListener('contextmenu', open);
    return card;
  }
}
