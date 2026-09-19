import type { GameContext, PlayerCode, SocialPlayer } from '@/shared';
import { PLAY_BLOCK_LABELS, PRESENCE_LABELS, SOCIAL_ERROR_MESSAGE_KO, SQUAD_INVITE_TTL_S, formatPlayerCode } from '@/shared';
import { el, setText, toggleClass } from './dom';

/* ────────────────────────────────────────────────────────────────────────────
 * The squad invite window (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 분대 · 도킹 매칭」 — user's decision).
 *
 * Opened by the `초대` on an empty portrait tile of the terminal's matchmaking tab. Friends first, then recently met
 * players, and one row = name · id (`formatPlayerCode`) · level · presence (`PRESENCE_LABELS`) · `초대` on the right.
 * The invite is the single `ctx.net.social.playWith`, and every rule is the server's / `playBlock`'s — this window only
 * writes the blocked reason (`PLAY_BLOCK_LABELS`) onto the button verbatim. An invite already sent is locked as
 * `초대 중 · n초` while `SocialPlayer.inviteAt` is open (`SQUAD_INVITE_TTL_S`). Someone already in my squad is a case
 * `playBlock` does not know (the server answers `in_squad`), so it is locked here first as `분대원`.
 *
 * The row list is rebuilt only on `social:updated` and lobby changes; `tick()` fixes the button text alone as the
 * seconds run down — rebuilding the rows every frame would make the button under the cursor vanish.
 *
 * Screen contract: blocker / escape token `hub:invite`, key guide owner `hub.invite`, closed by Tab · E · Escape
 * (`HubMenu.closeTop`). CSS prefix `.hinv-` (`hub/intel.css`). Owner: hub/ui.
 * ──────────────────────────────────────────────────────────────────────────── */

const TOKEN = 'hub:invite';
const GUIDE_OWNER = 'hub.invite';

interface Row { code: PlayerCode; player: SocialPlayer; btn: HTMLButtonElement }

export class InviteModal {
  readonly root: HTMLElement;
  private _open = false;
  private readonly note: HTMLElement;
  private readonly friendsList: HTMLElement;
  private readonly recentList: HTMLElement;
  private readonly secFriends: HTMLElement;
  private readonly secRecent: HTMLElement;
  private rows: Row[] = [];

  constructor(private readonly ctx: GameContext, private readonly onClosed: () => void) {
    const root = this.root = el('div', { cls: 'menu hub-menu hinv-modal interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    const f = el('div', { cls: 'frame', parent: root });
    const head = el('div', { cls: 'hub-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '분대 초대', parent: hl });
    const close = el('button', { cls: 'ui-btn hinv-close', text: '닫기', parent: head });
    close.type = 'button';
    close.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); this.close(); });

    const body = el('div', { cls: 'hinv-body', parent: f });
    this.note = el('div', { cls: 'hinv-note', text: '', parent: body });
    this.note.hidden = true;
    this.secFriends = this.section(body, '친구');
    this.friendsList = el('div', { cls: 'hinv-list', parent: this.secFriends });
    this.secRecent = this.section(body, '최근 만난 플레이어');
    this.recentList = el('div', { cls: 'hinv-list', parent: this.secRecent });

    root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  get isOpen(): boolean { return this._open; }

  open(): void {
    if (this._open) return;
    this._open = true;
    this.root.hidden = false;
    this.ctx.uiBlockers.add(TOKEN);
    this.ctx.escape.push(TOKEN, () => this.close());
    this.ctx.input.setCursorMode(true, TOKEN);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: [] });
    try { this.ctx.net?.social.refresh(); } catch { /* an older implementation — draw from the list already received */ }
    this.refresh();
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(TOKEN);
    this.ctx.escape.remove(TOKEN);
    this.ctx.input.setCursorMode(false, TOKEN);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: null });
    this.rows = [];
    this.onClosed();
  }

  /** Rebuild the list (called by the terminal when `social:updated` · the lobby · the connection state changes). */
  refresh(): void {
    if (!this._open) return;
    const net = this.ctx.net;
    const social = net?.social ?? null;
    this.rows = [];
    this.friendsList.replaceChildren();
    this.recentList.replaceChildren();

    const unavailable = !net ? '멀티플레이를 사용할 수 없습니다'
      : net.status !== 'connected' ? '서버에 연결되어 있지 않습니다'
        : !social?.available ? SOCIAL_ERROR_MESSAGE_KO.unavailable
          : null;
    this.note.hidden = !unavailable;
    setText(this.note, unavailable ?? '');
    this.secFriends.hidden = !!unavailable;
    this.secRecent.hidden = !!unavailable;
    if (unavailable || !social) return;

    const seen = new Set<PlayerCode>();
    const fill = (list: HTMLElement, players: readonly SocialPlayer[], empty: string): void => {
      let n = 0;
      for (const p of players) {
        if (!p?.code || seen.has(p.code)) continue;
        seen.add(p.code);
        this.row(list, p);
        n++;
      }
      if (n === 0) el('div', { cls: 'hinv-empty', text: empty, parent: list });
    };
    fill(this.friendsList, social.friends, '친구가 없습니다');
    fill(this.recentList, social.recent, '최근 만난 플레이어가 없습니다');
    this.tick();
  }

  /** Fix the button text and its lock only (the seconds run down). The terminal's `update` calls this every frame. */
  tick(): void {
    if (!this._open) return;
    for (const r of this.rows) {
      const s = this.rowState(r.player);
      setText(r.btn, s.text);
      r.btn.disabled = s.disabled;
      toggleClass(r.btn, 'is-pending', s.pending);
    }
  }

  private rowState(p: SocialPlayer): { text: string; disabled: boolean; pending: boolean } {
    const net = this.ctx.net;
    if (!net) return { text: '초대', disabled: true, pending: false };
    if (net.lobby?.players.some((m) => m.code === p.code)) return { text: '분대원', disabled: true, pending: false };
    if (typeof p.inviteAt === 'number' && p.inviteAt > 0) {
      const left = Math.ceil(SQUAD_INVITE_TTL_S - (net.serverNow() - p.inviteAt) / 1000);
      if (left > 0) return { text: `초대 중 · ${left}초`, disabled: true, pending: true };
    }
    const block = net.social.playBlock(p.code);
    if (block) return { text: PLAY_BLOCK_LABELS[block] ?? '초대할 수 없음', disabled: true, pending: false };
    return { text: '초대', disabled: false, pending: false };
  }

  private row(parent: HTMLElement, p: SocialPlayer): void {
    const root = el('div', { cls: 'hinv-row', parent });
    root.dataset.code = p.code;
    const who = el('div', { cls: 'hinv-who', parent: root });
    el('span', { cls: 'hinv-name', text: p.name || '—', parent: who });
    el('span', { cls: 'hinv-code', text: formatPlayerCode(p.code), parent: who });
    el('span', { cls: 'hinv-lv', text: p.level > 0 ? `Lv.${p.level}` : 'Lv.—', parent: root });
    const pres = el('span', { cls: 'hinv-presence', text: PRESENCE_LABELS[p.presence] ?? '', parent: root });
    pres.dataset.presence = p.presence;
    const btn = el('button', { cls: 'ui-btn hinv-btn', text: '초대', parent: root });
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.ctx.net?.social.playWith(p.code);
    });
    this.rows.push({ code: p.code, player: p, btn });
  }

  private section(parent: HTMLElement, label: string): HTMLElement {
    const s = el('div', { cls: 'hub-section hinv-section', parent });
    el('div', { cls: 'ui-label', text: label, parent: s });
    return s;
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }
}
