import type { GameContext, PlayerCode, SocialCard, SocialPlayer, WhisperLine } from '@/shared';
import { Keys, SOCIAL_WHISPER_MAX, formatPlayerCode } from '@/shared';
import { el, setText } from '../../dom';
import { socialOf } from './socialSource';
import { whisperStateClass, whisperStateText } from './whisperText';

/** Escape-stack token of an open page (above `COMMUNITY_BLOCKER`, so Escape closes the page before the panel). */
const PAGE_ESCAPE = 'community:page';

export interface SocialPagesHost {
  /** A 차단 목록 row was right-clicked: the column raises its context menu in its blocked form. */
  onContext(p: SocialPlayer, ev: MouseEvent): void;
  /** Tab pressed inside the page's text field (which swallows keys): close the whole panel, like Tab everywhere else. */
  onRequestClose(): void;
}

type PageKind = 'history' | 'blocked';

/**
 * The 커뮤니티 panel's two sub-pages (2026-09-11, B-4), laid **over** the social column (`.sc-page`, absolutely
 * positioned inside `.social-col`) so the panel keeps its fixed box:
 *
 *   - **대화 기록** (`openHistory(code, name)`, the card menu's `대화 기록`) — that 아이디's saved conversation,
 *     oldest first, from `SocialRef.whisperHistory` (client-side, per character slot), with each line's delivery state
 *     (`whisperStateText`) and a text field at the bottom that whispers through `SocialRef.whisper`. It redraws on
 *     `social:whisper` / `social:whisperUpdated` for that 아이디, so a pending line settles in place here too.
 *   - **차단 목록** (`openBlocked()`, the panel head's button) — `SocialRef.blocked`, each row with `차단 해제`
 *     (right-click offers the same plus `대화 기록`). Redraws on `social:updated`.
 *
 * `← 뒤로` or Escape closes the page and leaves the panel open: the page pushes `community:page` onto `ctx.escape`
 * above the panel's own entry. The text field keeps typed keys away from the game (`stopPropagation`), so it handles
 * Escape (close the page) and Tab (the host closes the whole panel) itself, and a Korean IME's committing Enter is sent
 * after `compositionend` exactly like the chat input.
 */
export class SocialPages {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private sub: HTMLElement;
  private body: HTMLElement;
  private empty: HTMLElement;
  private inputRow: HTMLElement;
  private input: HTMLInputElement;
  private kind: PageKind | null = null;
  private peer: { code: PlayerCode; name: string } | null = null;
  private unsubs: Array<() => void> = [];
  private ctx: GameContext | null = null;
  private composing = false;
  private sendAfterCompose = false;

  constructor(parent: HTMLElement, private readonly host: SocialPagesHost) {
    this.root = el('div', { cls: 'sc-page', parent });
    this.root.hidden = true;
    const head = el('div', { cls: 'sc-page-head', parent: this.root });
    const back = el('button', { cls: 'sc-back', text: '← 뒤로', parent: head });
    back.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.title = el('span', { cls: 'sc-page-title', text: '', parent: head });
    this.sub = el('span', { cls: 'sc-page-sub ui-mono', text: '', parent: head });
    this.body = el('div', { cls: 'sc-page-body', parent: this.root });
    this.body.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.empty = el('div', { cls: 'sc-empty sc-page-empty', text: '', parent: this.root });
    this.inputRow = el('div', { cls: 'sc-log-input-row', parent: this.root });
    this.input = el('input', {
      cls: 'sc-log-input',
      attrs: { type: 'text', maxlength: String(SOCIAL_WHISPER_MAX), placeholder: '귓속말 입력… (Enter 전송)', spellcheck: 'false', autocomplete: 'off' },
      parent: this.inputRow,
    });
    const sendBtn = el('button', { cls: 'sc-act ok sc-log-send', text: '보내기', parent: this.inputRow });
    sendBtn.addEventListener('click', (e) => { e.stopPropagation(); this.send(); });
    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
      if (!this.sendAfterCompose) return;
      this.sendAfterCompose = false;
      window.setTimeout(() => { if (this.kind === 'history' && !this.composing) this.send(); }, 0);
    });
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.unsubs.push(
      ctx.bus.on('social:whisper', ({ line }) => { if (this.kind === 'history' && line.code === this.peer?.code) this.render(); }),
      ctx.bus.on('social:whisperUpdated', ({ line }) => { if (this.kind === 'history' && line.code === this.peer?.code) this.render(); }),
      ctx.bus.on('social:updated', () => { if (this.kind === 'blocked') this.render(); }),
    );
  }

  /** Which page is up (debug / smoke), null when none. */
  get openKind(): PageKind | null { return this.kind; }
  /** 아이디 the 대화 기록 page shows (debug / smoke). */
  get peerCode(): PlayerCode | null { return this.kind === 'history' ? this.peer?.code ?? null : null; }

  openHistory(code: PlayerCode, name: string): void {
    this.kind = 'history';
    this.peer = { code, name };
    this.show();
    this.render();
    this.input.value = '';
    this.input.focus({ preventScroll: true });
  }

  openBlocked(): void {
    this.kind = 'blocked';
    this.peer = null;
    this.show();
    this.render();
  }

  /** Re-read the mirror for the open page (after a local mutation such as 차단 해제). */
  refresh(): void { if (this.kind) this.render(); }

  close(): void {
    if (!this.kind) return;
    this.kind = null;
    this.peer = null;
    this.root.hidden = true;
    this.input.blur();
    this.ctx?.escape.remove(PAGE_ESCAPE);
  }

  dispose(): void {
    this.close();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }

  private show(): void {
    this.root.hidden = false;
    this.ctx?.escape.push(PAGE_ESCAPE, () => this.close());
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx || !this.kind) return;
    const social = socialOf(ctx);
    if (this.kind === 'history') {
      const peer = this.peer!;
      const lines = social?.whisperHistory(peer.code) ?? [];
      const name = peer.name || lines.at(-1)?.name || '';
      setText(this.title, '대화 기록');
      setText(this.sub, `${name ? `${name} · ` : ''}${formatPlayerCode(peer.code)}`);
      this.root.classList.add('is-history');
      this.root.classList.remove('is-blocked');
      this.inputRow.hidden = false;
      this.body.replaceChildren(...lines.map((l) => this.logLine(l)));
      setText(this.empty, '주고받은 귓속말이 없습니다');
      this.empty.hidden = lines.length > 0;
      this.body.scrollTop = this.body.scrollHeight;
      return;
    }
    const blocked = social?.blocked ?? [];
    setText(this.title, '차단 목록');
    setText(this.sub, `${blocked.length}명 · 상대에게는 알리지 않습니다`);
    this.root.classList.add('is-blocked');
    this.root.classList.remove('is-history');
    this.inputRow.hidden = true;
    this.body.replaceChildren(...blocked.map((c) => this.blockedRow(c)));
    setText(this.empty, '차단한 플레이어가 없습니다');
    this.empty.hidden = blocked.length > 0;
  }

  private logLine(l: WhisperLine): HTMLElement {
    const mod = whisperStateClass(l);
    const row = el('div', { cls: `sc-logline${l.out ? ' out' : ' in'}${mod ? ` ${mod}` : ''}` });
    const d = new Date(l.at);
    const two = (n: number): string => n.toString().padStart(2, '0');
    el('span', { cls: 'ts ui-mono', text: `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`, parent: row });
    el('span', { cls: 'dir', text: l.out ? '→' : '←', parent: row });
    el('span', { cls: 'txt', text: l.text, parent: row });
    const st = whisperStateText(l);
    if (st) el('span', { cls: 'st', text: st, parent: row });
    return row;
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

  private onInputKey(e: KeyboardEvent): void {
    e.stopPropagation();   // typed keys never reach the game (Input listens on window, bubble phase)
    if (e.isComposing || e.keyCode === 229 || this.composing) {
      if (e.code === Keys.INVENTORY) e.preventDefault();
      if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat) { e.preventDefault(); this.sendAfterCompose = true; }
      return;
    }
    this.sendAfterCompose = false;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      if (!e.repeat) this.send();
    } else if (e.code === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.code === Keys.INVENTORY) {
      e.preventDefault();
      if (!e.repeat) this.host.onRequestClose();
    }
  }

  private send(): void {
    const ctx = this.ctx;
    const peer = this.peer;
    if (!ctx || !peer || this.kind !== 'history') return;
    const text = this.input.value.trim().slice(0, SOCIAL_WHISPER_MAX);
    if (!text) return;
    const social = socialOf(ctx);
    if (!social?.whisper(peer.code, text)) {
      ctx.bus.emit('ui:notify', { text: '귓속말을 보낼 수 없습니다 — 서버 연결을 확인하세요', kind: 'warning', duration: 3 });
      return;
    }
    this.input.value = '';
    this.input.focus({ preventScroll: true });
  }
}
