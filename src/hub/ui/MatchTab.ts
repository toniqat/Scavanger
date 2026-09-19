import type { GameContext, LobbyPlayer, NetRef } from '@/shared';
import { NET_MAX_PLAYERS, NET_SLOT_COLORS_CSS, activeSlot, isDockedLobby, readSlotCard, sanitizeAccent } from '@/shared';
/* 2026-09-15: android bot members — invites judge by the human count, a bot tile draws only a face + an `안드로이드` tag */
import { androidNameOf, humanPlayersOf, isBotPlayer } from '@/shared';
import { el, setText, toggleClass } from './dom';

/* ────────────────────────────────────────────────────────────────────────────
 * The terminal's matchmaking tab (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 분대 · 도킹 매칭」 — user's decision).
 *
 * It **replaces the old matchmaking popup outright** (`MatchPanel` — signal search · dock by code · invite link ·
 * public toggle · four crew rows). Codes, links and the public toggle are gone from the UI. What is left:
 *
 *  - **Four square portrait tiles** on one row in the centre — me (leftmost) → the lobby's other squadmates (by slot)
 *    → empty tiles. A filled tile = the face (`ctx.player.snapshotFace`, framed like the character-creation confirm
 *    popup) · name · level · a `분대장` badge · `연결 끊김`. Face colour `LobbyPlayer.accent ?? NET_SLOT_COLORS_CSS[slot]`,
 *    and **mine is my own character's accent** (`readSlotCard(activeSlot()).accent` — the same source as
 *    `player/PlayerSystem.localAccentColor`). A null snapshot leaves only the name. An empty tile = `초대` → the invite
 *    window (`InviteModal`). Inviting is allowed **only with no lobby, or as the leader before the start**.
 *  - Under the row, `비공개 매칭` left · `공개 매칭` right → `ctx.net.requestDock(isPublic)` (connect first —
 *    `connectThen`). A squadmate has both locked with `분대장만 매칭할 수 있습니다`; `dockPending` shows `도킹 중…`; while
 *    connecting they stay locked with `서버에 연결하는 중…`. **With no connection** (2026-09-15, 2nd pass, user's
 *    decision) the two buttons **disappear and one `다시 연결` of the same size** takes their place, with the reason line
 *    `서버에 연결되어 있지 않습니다` kept (the explicit reconnect the old `신호 찾기` did — without this path there is no
 *    way back from the terminal after a kick or a full server; earlier that day it was a small button under the line).
 *  - With no connection an empty tile's `초대` is **dimmed but still clickable** (`.is-offline`) — a click flashes the
 *    reason line instead of opening the window (`flashHint`, again on every click). Locking it would leave no way to
 *    see 「why it is refused」, and opening the window would only put the same sentence in an empty one.
 *  - A docked squad (`isDockedLobby`) gets a single `도킹 해제` instead of the two buttons → `leaveLobby()` (only the
 *    one who pressed it leaves). A squad that has not docked gets a small `분대 떠나기` → `leaveLobby()`.
 *
 * Every rule belongs to the server and `net/` — this tab only locks buttons and writes reasons; a refusal arrives as
 * `net:error` on the terminal's message line. CSS prefix `.hmt-` (`hub/intel.css`). Owner: hub/ui. Parent — the
 * `매칭` tab of `HubMenu`.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface MatchTabHost {
  /** Run `action` once attached to the relay (the terminal owns the busy state and the failure message). */
  connectThen(action: (n: NetRef) => void): void;
  /** Is a connection attempt in flight. */
  isBusy(): boolean;
  /** An empty tile's `초대` — opens the invite window. */
  openInvite(): void;
}

interface Tile {
  root: HTMLElement;
  face: HTMLElement;
  img: HTMLImageElement;
  initial: HTMLElement;
  badge: HTMLElement;
  state: HTMLElement;
  name: HTMLElement;
  lv: HTMLElement;
  invite: HTMLButtonElement;
  /** The accent of the face drawn right now — an identical one is not re-snapshotted ('' = empty). */
  faceKey: string;
}

interface Entry {
  name: string;
  level: number | null;
  accent: string;
  isHost: boolean;
  connected: boolean;
  me: boolean;
  slot: number;
  /** 2026-09-15: an android bot member (no invite, no menu). */
  bot: boolean;
  /** The bot's android bay index (its name). */
  bay: number;
  /**
   * 2026-09-15: this bot is **next to give its place up to a human** (the latest android recruited). With the four
   * tiles full of humans + androids there is no empty tile, so the `초대` button would vanish — but the relay still
   * takes a human then and sends this unit back to its bay (`lobby:androidReturned {human_joined}`), so the invite
   * button is laid on this tile instead.
   */
  swap: boolean;
}

/** How long (ms) the no-connection reason line flashes on an `초대` click — the length of `intel.css`'s `hmt-hint-flash`. */
const HINT_FLASH_MS = 600;

export class MatchTab {
  readonly root: HTMLElement;
  private readonly tiles: Tile[] = [];
  /** No connection (`net.status !== 'connected'`) — `초대` dims and flashes the reason line, not the window. `refresh` writes it. */
  private offline = false;
  private flashTimer = 0;
  private readonly btnPrivate: HTMLButtonElement;
  private readonly btnPublic: HTMLButtonElement;
  private readonly btnUndock: HTMLButtonElement;
  private readonly btnLeave: HTMLButtonElement;
  private readonly btnReconnect: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly status: HTMLElement;

  constructor(private readonly ctx: GameContext, parent: HTMLElement, private readonly host: MatchTabHost) {
    const root = this.root = el('div', { cls: 'hmt-tab', parent });
    this.status = el('div', { cls: 'hmt-status', text: '', parent: root });
    const row = el('div', { cls: 'hmt-row', parent: root });
    for (let i = 0; i < NET_MAX_PLAYERS; i++) this.tiles.push(this.buildTile(row, i));

    const actions = el('div', { cls: 'hmt-actions', parent: root });
    this.btnPrivate = this.button(actions, '비공개 매칭', () => this.dock(false), 'hmt-private');
    this.btnUndock = this.button(actions, '도킹 해제', () => this.ctx.net?.leaveLobby(), 'danger hmt-undock');
    this.btnPublic = this.button(actions, '공개 매칭', () => this.dock(true), 'primary hmt-public');
    // 2026-09-15 2nd pass: with no connection this one button replaces the two (same row · same size, `.hmt-actions .ui-btn`)
    this.btnReconnect = this.button(actions, '다시 연결', () => this.host.connectThen(() => { /* connect only */ }), 'primary hmt-reconnect');
    const under = el('div', { cls: 'hmt-under', parent: root });
    this.hint = el('div', { cls: 'hmt-hint', text: '', parent: under });
    this.btnLeave = this.button(under, '분대 떠나기', () => this.ctx.net?.leaveLobby(), 'hmt-small hmt-leave');
    this.btnUndock.hidden = true;
    this.btnLeave.hidden = true;
    this.btnReconnect.hidden = true;
  }

  private buildTile(parent: HTMLElement, index: number): Tile {
    const root = el('div', { cls: 'hmt-tile is-empty', parent });
    root.dataset.index = String(index);
    const face = el('div', { cls: 'hmt-face', parent: root });
    const img = el('img', { parent: face }) as HTMLImageElement;
    img.alt = '';
    img.draggable = false;
    img.hidden = true;
    const initial = el('div', { cls: 'hmt-initial', text: '', parent: face });
    const badge = el('div', { cls: 'hmt-badge', text: '분대장', parent: root });
    badge.hidden = true;
    const state = el('div', { cls: 'hmt-state', text: '', parent: root });
    state.hidden = true;
    const info = el('div', { cls: 'hmt-info', parent: root });
    const name = el('div', { cls: 'hmt-name', text: '', parent: info });
    const lv = el('div', { cls: 'hmt-lv', text: '', parent: info });
    const invite = this.button(root, '초대', () => this.onInvite(), 'hmt-invite');
    return { root, face, img, initial, badge, state, name, lv, invite, faceKey: '' };
  }

  /** Re-read the lobby · connection · social state (the terminal's `refresh` calls this while the tab is visible). */
  refresh(): void {
    const ctx = this.ctx, net = ctx.net ?? null;
    const lobby = net?.lobby ?? null;
    const docked = isDockedLobby(lobby);
    const isHost = !!lobby && !!net?.isHost;
    const status = net?.status ?? 'offline';
    // the invite tiles are drawn first, so the connection state is written here (`paintTile` adds `.is-offline`)
    this.offline = status !== 'connected';

    /* 2026-09-15 (android squadmates): the head count is **humans**; androids count apart and append as `· 안드로이드 n` */
    const humans = humanPlayersOf(lobby).length;
    const bots = lobby ? lobby.players.length - humans : 0;
    const botLine = bots > 0 ? ` · 안드로이드 ${bots}` : '';
    setText(this.status, !lobby ? '개인 함선' : docked ? `공유 함선 도킹됨 · ${humans}/${NET_MAX_PLAYERS}${botLine}` : `분대 대기 중 · ${humans}/${NET_MAX_PLAYERS}${botLine}`);

    // ── four portrait tiles: me → the other squadmates (by slot) → empty tiles ──
    const entries = this.entries(net, lobby?.players ?? []);
    // invites judge by the **human** seats — to take a human the relay sends the latest android back to its bay
    const canInvite = !lobby || (isHost && !lobby.started && humans < NET_MAX_PLAYERS);
    // with no empty tile at all (full of humans + androids) the `swap` bot tile carries the invite button instead
    const swapInvite = canInvite && entries.length >= this.tiles.length;
    for (let i = 0; i < this.tiles.length; i++) this.paintTile(this.tiles[i], entries[i] ?? null, canInvite, swapInvite);

    // ── matchmaking buttons ──
    this.btnUndock.hidden = !docked;
    this.btnLeave.hidden = !lobby || docked;
    let block: string | null = null;
    let reconnect = false;
    if (docked) {
      this.btnUndock.disabled = false;
    } else {
      // the squadmate reason comes before the connection one — a squadmate cannot matchmake even on a live link
      if (!net) block = '멀티플레이를 사용할 수 없습니다';
      else if (net.dockPending) block = '도킹 중…';
      else if (lobby && !isHost) block = '분대장만 매칭할 수 있습니다';
      else if (lobby?.started) block = '임무 진행 중';
      else if (this.host.isBusy() || status === 'connecting') block = '서버에 연결하는 중…';
      else if (status !== 'connected') { block = '서버에 연결되어 있지 않습니다'; reconnect = true; }
      this.btnPrivate.disabled = !!block;
      this.btnPublic.disabled = !!block;
    }
    // 2026-09-15 2nd pass: no connection (and not connecting) → the two buttons go, `다시 연결` stands there, the line stays
    this.btnPrivate.hidden = docked || reconnect;
    this.btnPublic.hidden = docked || reconnect;
    this.btnReconnect.hidden = !reconnect;
    this.hint.hidden = !block;
    setText(this.hint, block ?? '');
  }

  /**
   * An empty tile's `초대`. With a connection, the invite window; without one (2026-09-15, 2nd pass, user's decision)
   * no window opens and **the reason line flashes** — the button is dimmed but clickable, so 「why it is refused」 lands
   * in the eye on every press. When the reason line is hidden for some other cause (disconnected inside a docked
   * lobby, say) the connection sentence is put up first.
   */
  private onInvite(): void {
    if (!this.offline) { this.host.openInvite(); return; }
    if (this.hint.hidden) { setText(this.hint, '서버에 연결되어 있지 않습니다'); this.hint.hidden = false; }
    this.flashHint();
    this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
  }

  /** Highlight the reason line — a second press restarts it (drop the class, reflow, add it back to replay it). */
  private flashHint(): void {
    this.hint.classList.remove('is-flash');
    void this.hint.offsetWidth;
    this.hint.classList.add('is-flash');
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.hint.classList.remove('is-flash'), HINT_FLASH_MS);
  }

  private entries(net: NetRef | null, players: readonly LobbyPlayer[]): Entry[] {
    const out: Entry[] = [];
    const localId = net?.localId ?? null;
    const mine = players.find((p) => p.id === localId) ?? null;
    let card: ReturnType<typeof readSlotCard> | null = null;
    try { card = readSlotCard(activeSlot()); } catch { card = null; }
    const mySlot = mine?.slot ?? 0;
    const lvl = this.ctx.progression?.level;
    out.push({
      name: mine?.name || card?.name || net?.playerName || '나',
      level: typeof lvl === 'number' && lvl > 0 ? lvl : mine?.level ?? card?.level ?? null,
      // mine is my own character's accent (the save) — the value carried in the lobby is its echo
      accent: sanitizeAccent(card?.accent) ?? sanitizeAccent(mine?.accent) ?? NET_SLOT_COLORS_CSS[mySlot] ?? NET_SLOT_COLORS_CSS[0],
      isHost: !!mine?.isHost && players.length > 0,
      connected: true,
      me: true,
      slot: mySlot,
      bot: false,
      bay: 0,
      swap: false,
    });
    const others = players.filter((p) => p !== mine).slice().sort((a, b) => a.slot - b.slot);
    // the latest recruited android — a human joining sends this unit back to its bay first (the server's own order)
    let swapId: string | null = null;
    let swapAt = -Infinity;
    for (const p of players) {
      if (!isBotPlayer(p)) continue;
      const at = p.recruitedAt ?? 0;
      if (at >= swapAt) { swapAt = at; swapId = p.id; }
    }
    for (const p of others) {
      const bot = isBotPlayer(p);
      out.push({
        name: bot ? androidNameOf(p.bay ?? 0) : (p.name || '—'),
        level: !bot && typeof p.level === 'number' && p.level > 0 ? p.level : null,
        accent: sanitizeAccent(p.accent) ?? NET_SLOT_COLORS_CSS[p.slot] ?? NET_SLOT_COLORS_CSS[0],
        isHost: !bot && p.isHost,
        connected: bot || p.connected !== false,
        me: false,
        slot: p.slot,
        bot,
        bay: p.bay ?? 0,
        swap: bot && p.id === swapId,
      });
    }
    return out;
  }

  private paintTile(t: Tile, e: Entry | null, canInvite: boolean, swapInvite: boolean): void {
    if (!e) {
      t.root.className = 'hmt-tile is-empty';
      t.root.style.removeProperty('--sc');
      t.badge.hidden = true;
      t.state.hidden = true;
      setText(t.name, '');
      setText(t.lv, '');
      setText(t.initial, '');
      t.img.hidden = true;
      if (t.faceKey) { t.img.removeAttribute('src'); t.faceKey = ''; }
      // dimmed with no connection (`.is-offline`) — never locked (`onInvite` flashes the reason line)
      t.invite.className = `ui-btn hmt-invite${this.offline ? ' is-offline' : ''}`;
      t.invite.removeAttribute('title');
      t.invite.hidden = false;
      t.invite.disabled = !canInvite;
      return;
    }
    /*
     * 2026-09-15: a bot tile has no invite and no menu — the one exception is the `swap` tile **when there is no
     * empty tile at all**. With the four tiles full of humans + androids the place to invite into vanishes from the
     * screen, yet the relay still takes a human then and sends this unit back to its bay. Dropping the button would
     * tell the lie 「there is no way to invite」.
     */
    if (e.bot && e.swap && swapInvite) {
      t.invite.className = `ui-btn hmt-invite hmt-swap${this.offline ? ' is-offline' : ''}`;
      t.invite.title = `${e.name}이(가) 슬롯으로 돌아가고 그 자리에 들어옵니다`;
      t.invite.hidden = false;
      t.invite.disabled = false;
    } else {
      t.invite.hidden = true;
    }
    t.root.className = `hmt-tile${e.me ? ' is-me' : ''}${e.connected ? '' : ' is-off'}${e.isHost ? ' is-host' : ''}${e.bot ? ' is-bot' : ''}`;
    t.root.style.setProperty('--sc', e.accent);
    t.badge.hidden = !e.isHost;
    // a bot tile's top-right tag is `안드로이드` where `연결 끊김` would be — a bot never disconnects
    t.state.hidden = e.connected && !e.bot;
    setText(t.state, e.bot ? '안드로이드' : e.connected ? '' : '연결 끊김');
    setText(t.name, e.name);
    setText(t.lv, e.level !== null ? `Lv.${e.level}` : '');
    setText(t.initial, e.name.slice(0, 1));
    const faceKey = `${e.bot ? 'a' : 'h'}${e.accent}`;
    if (t.faceKey !== faceKey) {
      t.faceKey = faceKey;
      let url: string | null = null;
      const p = this.ctx.player;
      // an android gets the android face (`snapshotAndroidFace`, owned by `player/`) — without it, name and initial only
      try { url = (e.bot ? p?.snapshotAndroidFace?.({ accent: e.accent }) : p?.snapshotFace?.({ accent: e.accent })) ?? null; } catch { url = null; }
      if (url) { t.img.src = url; t.img.hidden = false; }
      else { t.img.removeAttribute('src'); t.img.hidden = true; }
    }
    // with no GL context the snapshot is null and only the name (and its initial) remain
    toggleClass(t.root, 'no-face', !t.img.getAttribute('src'));
  }

  private dock(isPublic: boolean): void {
    this.host.connectThen((n) => n.requestDock(isPublic));
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`, text: label, parent });
    b.type = 'button';
    b.addEventListener('click', (ev) => { ev.stopPropagation(); if (b.disabled) return; this.ctx.bus.emit('audio:play', { id: 'ui_click' }); onClick(); });
    return b;
  }
}
