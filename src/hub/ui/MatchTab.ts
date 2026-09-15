import type { GameContext, LobbyPlayer, NetRef } from '@/shared';
import { NET_MAX_PLAYERS, NET_SLOT_COLORS_CSS, activeSlot, isDockedLobby, readSlotCard, sanitizeAccent } from '@/shared';
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
 *    분대원은 둘 다 잠기고 `분대장만 매칭할 수 있습니다`, `dockPending` 동안은 `도킹 중…`, 접속이 없으면
 *    `서버에 연결되어 있지 않습니다` + `다시 연결`(옛 `신호 찾기` 가 하던 명시적 재접속 — 이 길이 없으면 추방 ·
 *    인원 초과 뒤 터미널에서 다시 붙을 방법이 없다).
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
}

export class MatchTab {
  readonly root: HTMLElement;
  private readonly tiles: Tile[] = [];
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
    const under = el('div', { cls: 'hmt-under', parent: root });
    this.hint = el('div', { cls: 'hmt-hint', text: '', parent: under });
    this.btnReconnect = this.button(under, '다시 연결', () => this.host.connectThen(() => { /* 접속만 */ }), 'hmt-small hmt-reconnect');
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
    const invite = this.button(root, '초대', () => this.host.openInvite(), 'hmt-invite');
    return { root, face, img, initial, badge, state, name, lv, invite, faceKey: '' };
  }

  /** 로비 · 접속 · 소셜 상태를 다시 읽는다 (터미널의 `refresh` 가 탭이 보일 때 부른다). */
  refresh(): void {
    const ctx = this.ctx, net = ctx.net ?? null;
    const lobby = net?.lobby ?? null;
    const docked = isDockedLobby(lobby);
    const isHost = !!lobby && !!net?.isHost;

    setText(this.status, !lobby ? '개인 함선' : docked ? `공유 함선 도킹됨 · ${lobby.players.length}/${NET_MAX_PLAYERS}` : `분대 대기 중 · ${lobby.players.length}/${NET_MAX_PLAYERS}`);

    // ── 초상 4칸: 나 → 다른 분대원(슬롯 순) → 빈 칸 ──
    const entries = this.entries(net, lobby?.players ?? []);
    const canInvite = !lobby || (isHost && !lobby.started && lobby.players.length < NET_MAX_PLAYERS);
    for (let i = 0; i < this.tiles.length; i++) this.paintTile(this.tiles[i], entries[i] ?? null, canInvite);

    // ── 매칭 버튼 ──
    this.btnPrivate.hidden = docked;
    this.btnPublic.hidden = docked;
    this.btnUndock.hidden = !docked;
    this.btnLeave.hidden = !lobby || docked;
    let block: string | null = null;
    let reconnect = false;
    if (docked) {
      this.btnUndock.disabled = false;
    } else {
      const status = net?.status ?? 'offline';
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
    this.hint.hidden = !block;
    setText(this.hint, block ?? '');
    this.btnReconnect.hidden = !reconnect;
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
    });
    const others = players.filter((p) => p !== mine).slice().sort((a, b) => a.slot - b.slot);
    for (const p of others) {
      out.push({
        name: p.name || '—',
        level: typeof p.level === 'number' && p.level > 0 ? p.level : null,
        accent: sanitizeAccent(p.accent) ?? NET_SLOT_COLORS_CSS[p.slot] ?? NET_SLOT_COLORS_CSS[0],
        isHost: p.isHost,
        connected: p.connected !== false,
        me: false,
        slot: p.slot,
      });
    }
    return out;
  }

  private paintTile(t: Tile, e: Entry | null, canInvite: boolean): void {
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
      t.invite.hidden = false;
      t.invite.disabled = !canInvite;
      return;
    }
    t.invite.hidden = true;
    t.root.className = `hmt-tile${e.me ? ' is-me' : ''}${e.connected ? '' : ' is-off'}${e.isHost ? ' is-host' : ''}`;
    t.root.style.setProperty('--sc', e.accent);
    t.badge.hidden = !e.isHost;
    t.state.hidden = e.connected;
    setText(t.state, e.connected ? '' : '연결 끊김');
    setText(t.name, e.name);
    setText(t.lv, e.level !== null ? `Lv.${e.level}` : '');
    setText(t.initial, e.name.slice(0, 1));
    if (t.faceKey !== e.accent) {
      t.faceKey = e.accent;
      let url: string | null = null;
      try { url = this.ctx.player?.snapshotFace?.({ accent: e.accent }) ?? null; } catch { url = null; }
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
