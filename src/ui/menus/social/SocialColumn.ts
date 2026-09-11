import type { GameContext, PlayerCode, SocialPlayer, SocialRef } from '@/shared';
import {
  NET_MAX_PLAYERS, NET_SLOT_COLORS_CSS, SOCIAL_CARDS_PER_ROW, SOCIAL_FRIEND_ROWS, SOCIAL_RECENT_ROWS,
  SOCIAL_RECENT_MAX, SQUAD_VOICE_DEFAULT, formatPlayerCode,
} from '@/shared';
import { el, setText, toggleClass } from '../../dom';
import { buildProfileCard, inviteBadgeText } from './ProfileCard';
import { SocialMenu } from './SocialMenu';
import { SocialPages } from './SocialPages';
import { SOCIAL_UNAVAILABLE_KO, socialOf } from './socialSource';
import '../../styles/social.css';

export interface SocialColumnOptions {
  /** Draw the 분대원 section on top (it hides itself when there is no lobby). Both hosts pass true. */
  squad?: boolean;
  /**
   * 귓속말하기 was chosen. The host is expected to close itself **first** and then emit `chat:whisperTo` — the chat
   * input cannot take focus while a `'menu'` blocker is up.
   */
  onWhisper?(code: PlayerCode, name: string): void;
  /** 2026-09-11: Tab inside a page's text field (which swallows keys) — the host closes itself. */
  onRequestClose?(): void;
}

/** Voice slider state — Phase 11 keeps it in this component and does nothing with it (there is no voice chat). */
interface VoiceState { vol: number; muted: boolean }

const VOICE_HINT = '보이스 채팅 준비 중';

/**
 * The 소셜 열 (`.social-col`): 분대원 on top, 친구 (with the incoming friend requests above them) in the middle and
 * 최근 플레이어 at the bottom. **One component, two hosts** — the ESC screen's right-hand column in the ship
 * (`menus/PauseMenu`) and the ship's 커뮤니티 panel (`hud/Community`) both instantiate it, so the two can never drift.
 *
 * Everything is read from `socialOf(ctx)` (= `ctx.net.social`, or the smoke's synthetic ref). While that mirror is
 * missing or `available === false` — offline, solo, an anonymous socket — the column collapses to the single
 * `소셜 기능을 사용할 수 없습니다` line: no empty grids, no dead buttons, nothing that throws.
 *
 * The lists are rebuilt only when a **key** built from the snapshot (+ the lobby, for 분대원) changed, so an idle
 * screen touches no DOM. Rows per grid come from `SOCIAL_FRIEND_ROWS` / `SOCIAL_RECENT_ROWS` (fractional on purpose:
 * a half row is the affordance that says "scroll"), columns from `SOCIAL_CARDS_PER_ROW`.
 *
 * 분대원 rows carry a voice slider + mute toggle. They are **UI only** (`SQUAD_VOICE_DEFAULT`, kept in `voice` below,
 * never read by anyone) and say so in their hint — there is no voice chat in this build.
 *
 * **2026-09-08 — 분대원 1×4.** The squad used to be a stack of full-width rows that only filled the left of the panel;
 * it is a **`NET_MAX_PLAYERS`-wide single row** now, one cell per lobby slot (`--sc` keeps the slot colour), each cell
 * a compact profile with its voice control on the **right**. Slots nobody holds are drawn as `빈 자리` rather than
 * collapsing, so the row's width never changes as squadmates come and go. The section header carries
 * **파티 떠나기**, which asks first through the column's shared confirm card (`SocialMenu.askConfirm`).
 *
 * **2026-09-11 (B-3 · B-4).** A card I have an open squad invite to carries the `초대 중 · n초` badge (`ProfileCard`);
 * `tick()` — polled by the host while open — rewrites those badges once a second off `ctx.net.serverNow()` without
 * rebuilding a card. The card menu gained `대화 기록` / `차단` (`SocialMenu`), and two pages lie over the column
 * (`SocialPages`): the 대화 기록 of one 아이디 and the 차단 목록 (`openBlocked()`, the panel head's button).
 */
export class SocialColumn {
  readonly root: HTMLElement;
  private off: HTMLElement;
  private body: HTMLElement;
  private squadSection: HTMLElement;
  private squadList: HTMLElement;
  private leaveBtn: HTMLButtonElement;
  private reqSection: HTMLElement;
  private reqHead: HTMLElement;
  private reqGrid: HTMLElement;
  private friendSection: HTMLElement;
  private friendHead: HTMLElement;
  private friendGrid: HTMLElement;
  private friendEmpty: HTMLElement;
  private recentHead: HTMLElement;
  private recentGrid: HTMLElement;
  private recentEmpty: HTMLElement;
  private menu: SocialMenu | null = null;
  private pages: SocialPages;
  /** Last whole second the invite badges were written for (`tick`). */
  private badgeSecond = -1;
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  private voice = new Map<string, VoiceState>();
  private lastKey = '';
  private available = false;

  constructor(parent: HTMLElement, private readonly opts: SocialColumnOptions = {}) {
    this.root = el('div', { cls: 'social-col', parent });
    this.off = el('div', { cls: 'sc-off', text: SOCIAL_UNAVAILABLE_KO, parent: this.root });
    this.body = el('div', { cls: 'sc-body', parent: this.root });
    // Start in the unavailable state (`available` is false): a column that is never refreshed must not show empty grids.
    this.body.hidden = true;

    /* ── 분대원 ── */
    this.squadSection = el('div', { cls: 'sc-section squad', parent: this.body });
    const sh = el('div', { cls: 'sc-head', parent: this.squadSection });
    el('span', { cls: 'ui-label', text: '분대원', parent: sh });
    el('span', { cls: 'sc-note', text: VOICE_HINT, parent: sh });
    this.leaveBtn = el('button', { cls: 'sc-leave', text: '파티 떠나기', parent: sh }) as HTMLButtonElement;
    this.leaveBtn.addEventListener('click', (e) => { e.stopPropagation(); this.askLeaveParty(); });
    this.squadList = el('div', { cls: 'sc-squad', parent: this.squadSection });
    this.squadList.style.setProperty('--cols', String(NET_MAX_PLAYERS));
    this.squadSection.hidden = !opts.squad;

    /* ── 받은 친구 요청 ── */
    this.reqSection = el('div', { cls: 'sc-section reqs', parent: this.body });
    const rh = el('div', { cls: 'sc-head', parent: this.reqSection });
    this.reqHead = el('span', { cls: 'ui-label', text: '받은 친구 요청', parent: rh });
    this.reqGrid = this.grid(this.reqSection, 2);

    /* ── 친구 ── */
    this.friendSection = el('div', { cls: 'sc-section friends', parent: this.body });
    const fh = el('div', { cls: 'sc-head', parent: this.friendSection });
    this.friendHead = el('span', { cls: 'ui-label', text: '친구', parent: fh });
    this.friendGrid = this.grid(this.friendSection, SOCIAL_FRIEND_ROWS, true);
    this.friendEmpty = el('div', { cls: 'sc-empty', text: '친구가 없습니다 — 최근 플레이어를 우클릭해 추가하세요', parent: this.friendSection });

    /* ── 최근 플레이어 ── */
    const recent = el('div', { cls: 'sc-section recent', parent: this.body });
    const ch = el('div', { cls: 'sc-head', parent: recent });
    this.recentHead = el('span', { cls: 'ui-label', text: '최근 플레이어', parent: ch });
    this.recentGrid = this.grid(recent, SOCIAL_RECENT_ROWS, true);
    this.recentEmpty = el('div', { cls: 'sc-empty', text: '함께 출격한 기록이 없습니다', parent: recent });

    /* ── 2026-09-11: 대화 기록 · 차단 목록 pages, laid over the column ── */
    this.pages = new SocialPages(this.root, {
      onContext: (p, ev) => {
        const s = this.ctx ? socialOf(this.ctx) : null;
        if (!s) return;
        this.menu?.openAt(p, false, null, ev.clientX + 4, ev.clientY + 4, s.isBlocked(p.code));
      },
      onRequestClose: () => this.opts.onRequestClose?.(),
    });
  }

  /**
   * One card grid. `fixed` (2026-09-08) pins the box to exactly `rows` rows instead of letting it shrink to its
   * content — the 친구 / 최근 플레이어 lists must not resize the panel around them; 받은 친구 요청 stays elastic.
   */
  private grid(parent: HTMLElement, rows: number, fixed = false): HTMLElement {
    const g = el('div', { cls: `sc-grid${fixed ? ' fixed' : ''}`, parent });
    g.style.setProperty('--cols', String(SOCIAL_CARDS_PER_ROW));
    g.style.setProperty('--rows', rows.toFixed(2));
    // The wheel must scroll this grid only — never the housing selection / the map behind it.
    g.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    return g;
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.menu = new SocialMenu(ctx.uiRoot, {
      onPlay: (code) => socialOf(ctx)?.playWith(code),
      onWhisper: (code, name) => this.opts.onWhisper?.(code, name),
      onAdd: (code) => socialOf(ctx)?.requestFriend(code),
      onRemove: (code) => { socialOf(ctx)?.removeFriend(code); this.refresh(true); },
      onHistory: (code, name) => this.pages.openHistory(code, name),
      onBlock: (code, blocked) => { socialOf(ctx)?.block(code, blocked); this.refresh(true); this.pages.refresh(); },
    });
    this.pages.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('social:updated', () => this.refresh()),
      ctx.bus.on('social:play', () => this.refresh()),
      ctx.bus.on('social:error', () => this.refresh()),
      ctx.bus.on('net:lobbyUpdated', () => this.refresh()),
      ctx.bus.on('net:lobbyLeft', () => this.refresh()),
    );
  }

  /** The context menu / confirm card state (debug). */
  get contextMenu(): SocialMenu | null { return this.menu; }
  /** Whether a usable social mirror was found at the last refresh (debug). */
  get isAvailable(): boolean { return this.available; }
  /** The 분대원 header's 파티 떠나기 button (debug / smoke). */
  get leaveButton(): HTMLButtonElement { return this.leaveBtn; }
  /** 2026-09-11: the 대화 기록 / 차단 목록 pages (debug / smoke). */
  get socialPages(): SocialPages { return this.pages; }

  /** Open the 차단 목록 page (the 커뮤니티 panel head's button). */
  openBlocked(): void { this.menu?.close(); this.pages.openBlocked(); }
  /** Open the 대화 기록 page of `code`. */
  openHistory(code: PlayerCode, name: string): void { this.menu?.close(); this.pages.openHistory(code, name); }
  /** Close whichever page is up (the host closing). */
  closePage(): void { this.pages.close(); }

  /**
   * Host-polled while the column is on screen: rewrite each `초대 중` badge once per whole second of the relay clock
   * (a finished one hides itself; the snapshot that follows removes it for good).
   */
  tick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.available) return;
    const now = ctx.net?.serverNow() ?? Date.now();
    const sec = Math.floor(now / 1000);
    if (sec === this.badgeSecond) return;
    this.badgeSecond = sec;
    for (const b of this.root.querySelectorAll<HTMLElement>('.sc-inv[data-until]')) {
      const txt = inviteBadgeText(Number(b.dataset.until), now);
      if (txt === null) { if (!b.hidden) b.hidden = true; continue; }
      if (b.textContent !== txt) b.textContent = txt;
      if (b.hidden) b.hidden = false;
    }
  }

  /** Re-read the mirror and repaint whatever changed. `force` skips the change key (after a local mutation). */
  refresh(force = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const social = socialOf(ctx);
    const ok = !!social && social.available;
    if (ok !== this.available) {
      this.available = ok;
      this.off.hidden = ok;
      this.body.hidden = !ok;
    }
    if (!ok || !social) { this.lastKey = ''; return; }
    const key = this.buildKey(social);
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.paint(social);
  }

  private buildKey(s: SocialRef): string {
    const row = (p: SocialPlayer): string => `${p.code}|${p.name}|${p.level}|${p.presence}|${p.squad}|${p.inviteAt ?? ''}`;
    const lobby = this.opts.squad
      ? (this.ctx.net?.lobby?.players ?? []).map((p) => `${p.id}:${p.slot}:${p.name}`).join(',')
      : '';
    return [
      s.me?.code ?? '', s.friends.map(row).join(','), s.incoming.map(row).join(','), s.recent.map(row).join(','), lobby,
      s.blocked.map((b) => b.code).join(','),
    ].join('#');
  }

  private paint(social: SocialRef): void {
    const ctx = this.ctx;
    const isFriend = (code: PlayerCode): boolean => social.friends.some((f) => f.code === code);
    const now = ctx.net?.serverNow() ?? Date.now();
    this.badgeSecond = -1;
    const handlers = {
      onContext: (p: SocialPlayer, ev: MouseEvent) => {
        this.menu?.openAt(p, isFriend(p.code), social.playBlock(p.code), ev.clientX + 4, ev.clientY + 4, social.isBlocked(p.code));
      },
      onRespond: (code: PlayerCode, accept: boolean) => { social.respondFriend(code, accept); this.refresh(true); },
    };

    /* 분대원 — the lobby is the truth for who is aboard; the snapshot supplies 아이디 / 레벨 where it knows them. */
    if (this.opts.squad) {
      const players = ctx.net?.lobby?.players ?? [];
      this.squadSection.hidden = players.length === 0;
      if (players.length > 0) {
        // One cell per lobby slot: a player sits in their own slot (that is what `--sc` colours), anyone the slot
        // number cannot place falls into the first free cell, and what is left over is drawn as 빈 자리.
        const cells: Array<HTMLElement | null> = new Array(NET_MAX_PLAYERS).fill(null);
        const spill: HTMLElement[] = [];
        for (const p of players) {
          const local = p.id === ctx.net?.localId;
          /* Phase 11: the lobby wire carries the 아이디 / level itself now; the name match is only a fallback. */
          const known = local ? social.me : this.byName(social, p.name);
          const code = p.code ?? known?.code ?? null;
          const level = p.level ?? known?.level ?? 0;
          const cell = this.squadRow(p.id, p.slot, p.name, local, code, level);
          if (p.slot >= 0 && p.slot < NET_MAX_PLAYERS && !cells[p.slot]) cells[p.slot] = cell;
          else spill.push(cell);
        }
        for (let i = 0; i < NET_MAX_PLAYERS && spill.length > 0; i++) if (!cells[i]) cells[i] = spill.shift()!;
        this.squadList.replaceChildren(...cells.map((c, i) => c ?? this.emptySquadCell(i)));
      }
    }

    /* 받은 친구 요청 */
    const inc = social.incoming;
    this.reqSection.hidden = inc.length === 0;
    if (inc.length > 0) {
      setText(this.reqHead, `받은 친구 요청 ${inc.length}`);
      this.reqGrid.replaceChildren(...inc.map((p) => buildProfileCard(p, handlers, true, now)));
    }

    /* 친구 */
    setText(this.friendHead, `친구 ${social.friends.length} · 접속 ${social.onlineFriends}`);
    this.friendGrid.replaceChildren(...social.friends.map((p) => buildProfileCard(p, handlers, false, now)));
    this.friendEmpty.hidden = social.friends.length > 0;
    toggleClass(this.friendGrid, 'is-empty', social.friends.length === 0);

    /* 최근 플레이어 */
    const recent = social.recent.slice(0, SOCIAL_RECENT_MAX);
    setText(this.recentHead, `최근 플레이어 ${recent.length}`);
    this.recentGrid.replaceChildren(...recent.map((p) => buildProfileCard(p, handlers, false, now)));
    this.recentEmpty.hidden = recent.length > 0;
    toggleClass(this.recentGrid, 'is-empty', recent.length === 0);
  }

  /**
   * Fallback for a squad-mate whose `LobbyPlayer.code` is absent (an anonymous socket, or a relay without a profile
   * store): match them against my own lists by name. Unknown → `아이디 미확인`, never a fabricated id.
   */
  private byName(social: SocialRef, name: string): SocialPlayer | undefined {
    if (!name) return undefined;
    const lists = [social.friends, social.incoming, social.outgoing, social.recent];
    for (const l of lists) { const hit = l.find((p) => p.name === name); if (hit) return hit; }
    return undefined;
  }

  /** 파티 떠나기 — `net.leaveLobby()`, the same call as the 함선 메뉴's 도킹 해제, behind the shared confirm card. */
  private askLeaveParty(): void {
    const ctx = this.ctx;
    if (!ctx?.net?.lobby) return;
    this.menu?.askConfirm(
      '파티 떠나기',
      '분대에서 나갑니다. 공유 함선에서는 개인 함선으로 돌아갑니다.',
      '떠나기',
      () => {
        try { ctx.net?.leaveLobby(); } catch (e) { console.error('[ui] leaveLobby failed', e); }
        ctx.bus.emit('ui:notify', { text: '분대에서 나왔습니다', kind: 'info', duration: 2 });
        this.refresh(true);
      },
    );
  }

  /** A lobby slot nobody holds — drawn so the 1×4 row keeps its width (2026-09-08). */
  private emptySquadCell(slot: number): HTMLElement {
    const row = el('div', { cls: 'sc-srow empty' });
    row.style.setProperty('--sc', NET_SLOT_COLORS_CSS[slot] ?? '#fff');
    const left = el('div', { cls: 'sc-sleft', parent: row });
    el('span', { cls: 'sc-name', text: '빈 자리', parent: left });
    return row;
  }

  private squadRow(
    peerId: string, slot: number, name: string, local: boolean, code: PlayerCode | null, level: number,
  ): HTMLElement {
    const row = el('div', { cls: `sc-srow${local ? ' me' : ''}` });
    // 2026-09-09: 분대장 넘기기 우클릭 메뉴가 이 행을 PeerId 로 되짚는다 (`hud/Community` 가 델리게이트한다).
    row.dataset.peerId = peerId;
    row.style.setProperty('--sc', NET_SLOT_COLORS_CSS[slot] ?? '#fff');
    const left = el('div', { cls: 'sc-sleft', parent: row });
    el('span', { cls: 'sc-id ui-mono', text: code ? formatPlayerCode(code) : '아이디 미확인', parent: left });
    el('span', { cls: 'sc-name', text: `${name || '분대원'}${local ? ' (나)' : ''}`, parent: left });
    el('span', { cls: 'sc-lv ui-mono', text: level > 0 ? `Lv. ${level}` : 'Lv. —', parent: left });

    const right = el('div', { cls: 'sc-sright', parent: row });
    right.title = VOICE_HINT;
    const state = this.voice.get(peerId) ?? { vol: SQUAD_VOICE_DEFAULT, muted: false };
    this.voice.set(peerId, state);
    const slider = el('input', { cls: 'sc-vol', parent: right });
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
    slider.value = String(Math.round(state.vol * 100));
    slider.title = VOICE_HINT;
    const mute = el('button', { cls: `sc-mute${state.muted ? ' is-on' : ''}`, text: state.muted ? '🔇' : '🔊', parent: right });
    mute.title = VOICE_HINT;
    const apply = (): void => {
      slider.disabled = state.muted;
      toggleClass(mute, 'is-on', state.muted);
      setText(mute, state.muted ? '🔇' : '🔊');
    };
    slider.addEventListener('input', (e) => { e.stopPropagation(); state.vol = (Number(slider.value) || 0) / 100; });
    slider.addEventListener('mousedown', (e) => e.stopPropagation());
    slider.addEventListener('click', (e) => e.stopPropagation());
    mute.addEventListener('click', (e) => { e.stopPropagation(); state.muted = !state.muted; apply(); });
    apply();
    return row;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.menu?.dispose();
    this.menu = null;
    this.pages.dispose();
    this.root.remove();
  }
}
