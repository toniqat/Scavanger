import type { GameContext, LobbyPlayer, NetRef } from '@/shared';
import { NET_MAX_PLAYERS, NET_SLOT_COLORS_CSS, activeSlot, isDockedLobby, readSlotCard, sanitizeAccent } from '@/shared';
/* 2026-09-15: 안드로이드 봇 멤버 — 초대는 사람 수로 판정하고, 봇 칸은 얼굴 + `안드로이드` 꼬리표만 그린다 */
import { androidNameOf, humanPlayersOf, isBotPlayer } from '@/shared';
import { el, setText, toggleClass } from './dom';

/* ────────────────────────────────────────────────────────────────────────────
 * 터미널 매칭 탭 (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 분대 · 도킹 매칭」 — 사용자 결정).
 *
 * 옛 매칭 팝업(`MatchPanel` — 신호 찾기 · 코드 도킹 · 초대 링크 · 공개 전환 · 승무원 4행)을 **통째로 대신한다**.
 * 코드 · 링크 · 공개 토글은 UI 에서 없어졌다. 남은 것:
 *
 *  - 가운데 가로 한 줄의 **정사각 초상 4칸** — 나(맨 왼쪽) → 로비의 다른 분대원(슬롯 순) → 빈 칸.
 *    채워진 칸 = 얼굴(`ctx.player.snapshotFace`, 캐릭터 생성 확정 팝업과 같은 프레이밍) · 이름 · 레벨 · `분대장` 배지 ·
 *    `연결 끊김`. 얼굴 색은 `LobbyPlayer.accent ?? NET_SLOT_COLORS_CSS[slot]`, **나는 내 캐릭터의 악센트**
 *    (`readSlotCard(activeSlot()).accent` — `player/PlayerSystem.localAccentColor` 와 같은 원본). 스냅숏이 null 이면
 *    이름만 남는다. 빈 칸 = `초대` → 초대 창(`InviteModal`). 초대는 **로비가 없거나 내가 분대장이고 시작 전**일 때만.
 *  - 줄 아래 왼쪽 `비공개 매칭` · 오른쪽 `공개 매칭` → `ctx.net.requestDock(isPublic)` (접속부터 — `connectThen`).
 *    분대원은 둘 다 잠기고 `분대장만 매칭할 수 있습니다`, `dockPending` 동안은 `도킹 중…`, 접속 중이면 잠긴 채
 *    `서버에 연결하는 중…`. **접속이 없으면** (2026-09-15 2차, 사용자 결정) 두 버튼은 **사라지고 그 자리에 같은 크기의
 *    `다시 연결`** 하나가 선다 + 사유 줄 `서버에 연결되어 있지 않습니다` (옛 `신호 찾기` 가 하던 명시적 재접속 — 이 길이
 *    없으면 추방 · 인원 초과 뒤 터미널에서 다시 붙을 방법이 없다; 그날 먼저는 사유 줄 밑의 작은 버튼이었다).
 *  - 접속이 없을 때의 빈 칸 `초대` 는 **흐리지만 눌린다** (`.is-offline`) — 누르면 창 대신 사유 줄이 깜박인다
 *    (`flashHint`, 누를 때마다 다시). 잠가 버리면 「왜 못 하는지」를 알 길이 없고, 창을 열면 빈 창에 같은 문장이 뜰 뿐이다.
 *  - 도킹한 분대(`isDockedLobby`)는 두 버튼 대신 `도킹 해제` 하나 → `leaveLobby()` (누른 사람만 나간다).
 *    도킹 전 분대는 작은 `분대 떠나기` → `leaveLobby()`.
 *
 * 규칙은 전부 서버 · `net/` 의 것이다 — 이 탭은 버튼을 잠그고 사유를 적을 뿐, 거절은 `net:error` 로 터미널 메시지 줄에 온다.
 * CSS 접두사 `.hmt-` (`hub/intel.css`). Owner: hub/ui. 부모 — `HubMenu` 의 `매칭` 탭.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface MatchTabHost {
  /** 릴레이에 붙은 뒤 `action` 을 돌린다 (터미널이 busy 상태 · 실패 메시지를 갖는다). */
  connectThen(action: (n: NetRef) => void): void;
  /** 접속 시도 중인가. */
  isBusy(): boolean;
  /** 빈 칸의 `초대` — 초대 창을 연다. */
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
  /** 지금 그려 둔 얼굴의 악센트 — 같으면 다시 찍지 않는다 ('' = 비어 있음). */
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
  /** 2026-09-15: 안드로이드 봇 멤버 (초대도 메뉴도 없다). */
  bot: boolean;
  /** 봇의 조종실 슬롯 번호 (이름). */
  bay: number;
  /**
   * 2026-09-15: 이 봇이 **사람에게 자리를 내줄 차례**다 (가장 늦게 들어온 안드로이드). 네 칸이 사람 + 안드로이드로
   * 가득 차면 빈 칸이 없어 `초대` 버튼이 사라지는데, 릴레이는 그때도 사람을 받아 이 기를 슬롯으로 돌려보낸다
   * (`lobby:androidReturned {human_joined}`) — 그래서 초대 버튼을 이 칸에 얹는다.
   */
  swap: boolean;
}

/** 접속 없음 사유 줄이 `초대` 클릭에 깜박이는 시간 (ms) — `intel.css` `hmt-hint-flash` 애니메이션 길이와 같다. */
const HINT_FLASH_MS = 600;

export class MatchTab {
  readonly root: HTMLElement;
  private readonly tiles: Tile[] = [];
  /** 접속이 없다 (`net.status !== 'connected'`) — `초대` 가 흐려지고 창 대신 사유 줄을 깜박인다. `refresh` 가 적는다. */
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
    // 2026-09-15 2차: 접속이 없으면 매칭 두 버튼 자리에 이 버튼 하나 (같은 줄 · 같은 크기 규칙 `.hmt-actions .ui-btn`)
    this.btnReconnect = this.button(actions, '다시 연결', () => this.host.connectThen(() => { /* 접속만 */ }), 'primary hmt-reconnect');
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

  /** 로비 · 접속 · 소셜 상태를 다시 읽는다 (터미널의 `refresh` 가 탭이 보일 때 부른다). */
  refresh(): void {
    const ctx = this.ctx, net = ctx.net ?? null;
    const lobby = net?.lobby ?? null;
    const docked = isDockedLobby(lobby);
    const isHost = !!lobby && !!net?.isHost;
    const status = net?.status ?? 'offline';
    // 초대 칸이 먼저 그려지므로 접속 여부를 여기서 적는다 (`paintTile` 이 `.is-offline` 을 붙인다)
    this.offline = status !== 'connected';

    /* 2026-09-15 (안드로이드 분대원): 인원은 **사람 수**로 적고, 안드로이드는 따로 센다 — 승무원 2/4 뒤에 안드로이드 2 가 붙는다 */
    const humans = humanPlayersOf(lobby).length;
    const bots = lobby ? lobby.players.length - humans : 0;
    const botLine = bots > 0 ? ` · 안드로이드 ${bots}` : '';
    setText(this.status, !lobby ? '개인 함선' : docked ? `공유 함선 도킹됨 · ${humans}/${NET_MAX_PLAYERS}${botLine}` : `분대 대기 중 · ${humans}/${NET_MAX_PLAYERS}${botLine}`);

    // ── 초상 4칸: 나 → 다른 분대원(슬롯 순) → 빈 칸 ──
    const entries = this.entries(net, lobby?.players ?? []);
    // 초대는 **사람** 자리로 판정한다 — 릴레이가 사람을 들이려고 가장 늦게 들어온 안드로이드를 슬롯으로 돌려보낸다
    const canInvite = !lobby || (isHost && !lobby.started && humans < NET_MAX_PLAYERS);
    // 빈 칸이 하나도 없으면 (사람 + 안드로이드로 가득) `swap` 봇 칸이 초대 버튼을 대신 든다
    const swapInvite = canInvite && entries.length >= this.tiles.length;
    for (let i = 0; i < this.tiles.length; i++) this.paintTile(this.tiles[i], entries[i] ?? null, canInvite, swapInvite);

    // ── 매칭 버튼 ──
    this.btnUndock.hidden = !docked;
    this.btnLeave.hidden = !lobby || docked;
    let block: string | null = null;
    let reconnect = false;
    if (docked) {
      this.btnUndock.disabled = false;
    } else {
      // 분대원 사유가 접속 사유보다 먼저다 — 분대원은 접속이 살아 있어도 매칭할 수 없다
      if (!net) block = '멀티플레이를 사용할 수 없습니다';
      else if (net.dockPending) block = '도킹 중…';
      else if (lobby && !isHost) block = '분대장만 매칭할 수 있습니다';
      else if (lobby?.started) block = '임무 진행 중';
      else if (this.host.isBusy() || status === 'connecting') block = '서버에 연결하는 중…';
      else if (status !== 'connected') { block = '서버에 연결되어 있지 않습니다'; reconnect = true; }
      this.btnPrivate.disabled = !!block;
      this.btnPublic.disabled = !!block;
    }
    // 2026-09-15 2차: 접속이 없으면 (접속 중은 아님) 매칭 두 버튼이 사라지고 그 자리에 `다시 연결` 이 선다; 사유 줄은 남는다
    this.btnPrivate.hidden = docked || reconnect;
    this.btnPublic.hidden = docked || reconnect;
    this.btnReconnect.hidden = !reconnect;
    this.hint.hidden = !block;
    setText(this.hint, block ?? '');
  }

  /**
   * 빈 칸의 `초대`. 접속이 있으면 초대 창; 없으면 (2026-09-15 2차, 사용자 결정) 창을 열지 않고 **사유 줄을 깜박인다** —
   * 버튼은 흐리지만 눌리므로 「왜 안 되는지」가 누를 때마다 눈에 들어온다. 사유 줄이 다른 이유로 숨어 있으면
   * (도킹한 로비에서 끊긴 채 등) 접속 문장을 먼저 세운다.
   */
  private onInvite(): void {
    if (!this.offline) { this.host.openInvite(); return; }
    if (this.hint.hidden) { setText(this.hint, '서버에 연결되어 있지 않습니다'); this.hint.hidden = false; }
    this.flashHint();
    this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
  }

  /** 사유 줄 강조 — 다시 누르면 처음부터 다시 (클래스를 뗐다가 리플로우 뒤 붙여 애니메이션을 재시작한다). */
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
      // 나는 내 캐릭터의 악센트 (세이브) — 로비에 실린 값은 그 메아리다
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
    // 가장 늦게 들어온 안드로이드 — 사람이 합류하면 릴레이가 이 기를 먼저 슬롯으로 돌려보낸다 (서버 규칙과 같은 순서)
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
      // 접속이 없으면 흐리게 (`.is-offline`) — 잠그지는 않는다 (`onInvite` 가 사유 줄을 깜박인다)
      t.invite.className = `ui-btn hmt-invite${this.offline ? ' is-offline' : ''}`;
      t.invite.removeAttribute('title');
      t.invite.hidden = false;
      t.invite.disabled = !canInvite;
      return;
    }
    /*
     * 2026-09-15: 봇 칸에는 초대도 메뉴도 없다 — 단 **빈 칸이 하나도 없을 때**의 `swap` 칸만 예외다. 네 칸이 사람 +
     * 안드로이드로 가득 차면 초대할 자리가 화면에서 사라지는데, 릴레이는 그때도 사람을 받고 이 기를 슬롯으로
     * 돌려보낸다. 버튼을 없애면 「초대할 방법이 없다」는 거짓말이 된다.
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
    // 봇 칸의 우상단 꼬리표는 `연결 끊김` 자리에 `안드로이드` — 봇은 끊기지 않는다
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
      // 안드로이드는 안드로이드 얼굴 (`snapshotAndroidFace`, player/ 소유) — 아직 없으면 이름과 머리글자만 남는다
      try { url = (e.bot ? p?.snapshotAndroidFace?.({ accent: e.accent }) : p?.snapshotFace?.({ accent: e.accent })) ?? null; } catch { url = null; }
      if (url) { t.img.src = url; t.img.hidden = false; }
      else { t.img.removeAttribute('src'); t.img.hidden = true; }
    }
    // GL 컨텍스트가 없어 스냅숏이 null 이면 이름(과 머리글자)만 남는다
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
