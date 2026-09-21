import type { GameContext, MailMessage, MailRef } from '@/shared';
import { COMMUNITY_BLOCKER, MAIL_WINDOW_TOKEN, NPC_DEFS, buildItemGridChip } from '@/shared';
import { el, setText } from '../../dom';
import { clockText, initialOf } from '../messenger/format';
import '../../styles/mail.css';

/** The attachment thumbnail's cell edge (px) — a layout constant, like the messenger's avatar sizes. */
const ATTACH_CELL = 40;
/** Fallback avatar colour for a sender that is not an NPC (system mail). */
const SYSTEM_AV = '#9fb4cc';

/**
 * **The mailbox window** (2026-09-21, user's decision — its own button left of the messenger's, its own window).
 *
 * Messenger-like layout: the list on the left (sender avatar · name, subject, date, unread dot, attachment mark) with a
 * bottom bar of exactly two buttons — `읽은 메일 삭제` (read **and** claimed only; a mail with items left is never
 * deleted) and `모두 받기`. The right side is the selected mail: head, body, and at the bottom the attachments as
 * inventory tiles (`InventoryRef.buildItemTile` — its `data-item-tip` gives the hover card) with a `받기` button.
 *
 * `hud/Community` owns this like the messenger panel: the button, open/close, Tab, the tutorial / cutscene gates and
 * the `over-inv` / `over-pause` layering. This class holds the window's own rules: blocker `COMMUNITY_BLOCKER` (so the
 * Tab window · the pause menu below ignore Tab / Escape exactly as under the messenger — the two windows are never
 * open together), the software cursor and the Escape entry under `MAIL_WINDOW_TOKEN`, the key guide (`owner: 'mail'`).
 * Every rule of the mail itself (claim into the stash, what may be deleted) is `ctx.meta.mail`'s — this only draws.
 * The DOM is rebuilt on `mail:changed` while open (never per frame).
 */
export class MailWindow {
  readonly panel: HTMLElement;
  private list!: HTMLElement;
  private countEl!: HTMLElement;
  private view!: HTMLElement;
  private delBtn!: HTMLButtonElement;
  private allBtn!: HTMLButtonElement;
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  private _open = false;
  private dirty = true;
  private selected: string | null = null;

  constructor(parent: HTMLElement, private readonly onCloseRequest: () => void) {
    this.panel = el('div', { cls: 'community-panel ml-panel interactive', parent });
    this.panel.hidden = true;
    this.panel.addEventListener('mousedown', (e) => e.stopPropagation());
    const frame = el('div', { cls: 'cp-frame ml-frame', parent: this.panel });
    const head = el('div', { cls: 'cp-head ml-head', parent: frame });
    el('div', { cls: 'cp-title', text: '우편함', parent: head });
    this.countEl = el('div', { cls: 'cp-code ml-count ui-mono', parent: head });
    const close = el('button', { cls: 'ui-btn small cp-close', text: '닫기', parent: head });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.onCloseRequest(); });

    const body = el('div', { cls: 'ml-body', parent: frame });
    const col = el('div', { cls: 'ml-col', parent: body });
    this.list = el('div', { cls: 'ml-list', parent: col });
    const bar = el('div', { cls: 'ml-bar', parent: col });
    this.delBtn = el('button', { cls: 'ms-btn', text: '읽은 메일 삭제', parent: bar });
    this.allBtn = el('button', { cls: 'ms-btn primary', text: '모두 받기', parent: bar });
    this.delBtn.addEventListener('click', (e) => { e.stopPropagation(); this.mail()?.deleteRead(); });
    this.allBtn.addEventListener('click', (e) => { e.stopPropagation(); this.mail()?.claimAll(); });
    this.view = el('div', { cls: 'ml-view', parent: body });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.unsubs.push(ctx.bus.on('mail:changed', () => { this.dirty = true; }));
  }

  get isOpen(): boolean { return this._open; }
  /** The mail on the right (debug / smoke). */
  get selectedId(): string | null { return this.selected; }

  private mail(): MailRef | null { return this.ctx?.meta?.mail ?? null; }

  open(): void {
    if (this._open) return;
    const ctx = this.ctx;
    this._open = true;
    this.panel.hidden = false;
    ctx.uiBlockers.add(COMMUNITY_BLOCKER);
    ctx.escape.push(MAIL_WINDOW_TOKEN, () => this.onCloseRequest());
    ctx.input.setCursorMode(true, MAIL_WINDOW_TOKEN);
    // no action keys of its own — the guide still appends `닫기` (Tab / Esc)
    ctx.bus.emit('ui:keyGuide', { owner: 'mail', keys: [] });
    ctx.bus.emit('ui:mailToggled', { open: true });
    ctx.bus.emit('audio:play', { id: 'ui_click' });
    // open on the newest unread mail (else keep the last selection if it still exists)
    const l = this.mail()?.list() ?? [];
    if (!this.selected || !l.some((m) => m.id === this.selected)) this.selected = (l.find((m) => !m.read) ?? l[0])?.id ?? null;
    if (this.selected) this.mail()?.markRead(this.selected);
    this.dirty = true;
    this.render();
  }

  close(): void {
    if (!this._open) return;
    const ctx = this.ctx;
    this._open = false;
    this.panel.hidden = true;
    ctx.uiBlockers.delete(COMMUNITY_BLOCKER);
    ctx.escape.remove(MAIL_WINDOW_TOKEN);
    ctx.input.setCursorMode(false, MAIL_WINDOW_TOKEN);
    ctx.bus.emit('ui:keyGuide', { owner: 'mail', keys: null });
    ctx.bus.emit('ui:mailToggled', { open: false });
  }

  update(): void {
    if (this._open && this.dirty) this.render();
  }

  private select(id: string): void {
    this.selected = id;
    this.dirty = true;
    this.mail()?.markRead(id);   // emits `mail:changed` when it was unread
    this.render();
  }

  private render(): void {
    this.dirty = false;
    const mail = this.mail();
    const l = mail?.list() ?? [];
    if (this.selected && !l.some((m) => m.id === this.selected)) this.selected = l[0]?.id ?? null;
    const unread = l.reduce((n, m) => n + (m.read ? 0 : 1), 0);
    setText(this.countEl, l.length ? `${l.length}통${unread ? ` · 읽지 않음 ${unread}` : ''}` : '');
    this.delBtn.disabled = !l.some((m) => m.read && m.claimed);
    this.allBtn.disabled = !l.some((m) => !m.claimed && m.items.length > 0);

    this.list.replaceChildren();
    if (l.length === 0) el('div', { cls: 'ml-empty', text: '받은 메일이 없습니다', parent: this.list });
    for (const m of l) this.list.appendChild(this.row(m));
    this.renderView(l.find((m) => m.id === this.selected) ?? null);
  }

  private avatar(m: MailMessage, size: '' | ' small' | ' big'): HTMLElement {
    const def = NPC_DEFS.find((d) => d.id === m.from);
    const av = el('span', { cls: `ms-av${size}`, text: def?.glyph || initialOf(m.fromName || m.from) });
    av.style.setProperty('--av', def?.color ?? SYSTEM_AV);
    return av;
  }

  private row(m: MailMessage): HTMLElement {
    const row = el('button', { cls: `ml-row${m.id === this.selected ? ' is-on' : ''}${m.read ? '' : ' is-unread'}` });
    row.dataset.mailId = m.id;
    row.appendChild(this.avatar(m, ''));
    const mid = el('div', { cls: 'ml-rmid', parent: row });
    const top = el('div', { cls: 'ml-rtop', parent: mid });
    el('span', { cls: 'ml-rfrom', text: m.fromName || m.from, parent: top });
    el('span', { cls: 'ml-rdate ui-mono', text: clockText(m.sentAt), parent: top });
    const sub = el('div', { cls: 'ml-rsub', parent: mid });
    el('span', { cls: 'ml-rsubj', text: m.subject || '(제목 없음)', parent: sub });
    if (m.items.length > 0) {
      const clip = el('span', { cls: 'ml-rclip', text: '첨부', parent: sub });
      clip.title = '받지 않은 첨부 아이템';
    }
    if (!m.read) el('i', { cls: 'ml-rdot', parent: row });
    row.addEventListener('click', (e) => { e.stopPropagation(); this.select(m.id); });
    return row;
  }

  private renderView(m: MailMessage | null): void {
    this.view.replaceChildren();
    if (!m) { el('div', { cls: 'ml-empty', text: '메일을 고르세요', parent: this.view }); return; }
    const head = el('div', { cls: 'ml-vhead', parent: this.view });
    head.appendChild(this.avatar(m, ' big'));
    const who = el('div', { cls: 'ml-vwho', parent: head });
    el('div', { cls: 'ml-vsubj', text: m.subject || '(제목 없음)', parent: who });
    const line = el('div', { cls: 'ml-vfrom', parent: who });
    el('span', { text: m.fromName || m.from, parent: line });
    el('span', { cls: 'ml-vdate ui-mono', text: clockText(m.sentAt), parent: line });
    el('div', { cls: 'ml-vbody', text: m.body, parent: this.view });

    const att = el('div', { cls: 'ml-att', parent: this.view });
    const top = el('div', { cls: 'ml-atop', parent: att });
    el('span', { cls: 'ml-asec', text: '첨부 아이템', parent: top });
    if (m.items.length === 0) {
      el('span', { cls: 'ml-anone', text: m.hadItems ? '받음' : '없음', parent: top });
      return;
    }
    const tiles = el('div', { cls: 'ml-tiles', parent: att });
    const inv = this.ctx.inventory;
    for (const a of m.items) {
      const tile = inv && typeof inv.buildItemTile === 'function'
        ? inv.buildItemTile(a.defId, a.qty, { cell: ATTACH_CELL })
        : buildItemGridChip(this.ctx.loot?.getItemDef(a.defId), { cell: ATTACH_CELL, need: a.qty });
      tile.classList.add('ml-tile');
      tile.style.setProperty('--inv-cell', `${ATTACH_CELL}px`);
      tiles.appendChild(tile);
    }
    const take = el('button', { cls: 'ms-btn primary ml-take', text: '받기', parent: top });
    take.title = '함선 창고로 받습니다';
    take.addEventListener('click', (e) => { e.stopPropagation(); this.mail()?.claim(m.id); });
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this._open) {
      this._open = false;
      this.ctx?.uiBlockers.delete(COMMUNITY_BLOCKER);
      this.ctx?.escape.remove(MAIL_WINDOW_TOKEN);
      this.ctx?.input.setCursorMode(false, MAIL_WINDOW_TOKEN);
    }
    this.panel.remove();
  }
}
