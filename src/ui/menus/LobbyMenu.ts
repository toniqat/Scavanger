import type { GameContext, LobbyState, NetRef, NetStatus } from '@/shared';
import { NET_MAX_PLAYERS, NET_SLOT_COLORS_CSS, NET_LOBBY_CODE_LENGTH, isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { MenuBase } from './MenuBase';
import { parseSeed } from './seed';

type MsgKind = 'info' | 'warning' | 'danger' | 'success';

const STATUS_TEXT: Record<NetStatus, string> = { offline: '오프라인', connecting: '연결 중', connected: '연결됨', error: '오류' };
const MSG_TTL_MS = 4500;
const STATUS_POLL = 0.5;

interface SlotCard { root: HTMLElement; name: HTMLElement; host: HTMLElement; state: HTMLElement }

/**
 * Multiplayer lobby screen (phase 'menu').
 *
 * Views: **join** (no lobby: name, create, code + join, back) and **room** (code + copy buttons, 4 slot cards,
 * ready toggle, host-only seed + start, leave). Visible when `ctx.net.lobby` exists or the screen was opened via
 * `ui:lobbyToggled {open:true}` (title button / invite URL). Hidden on any non-menu phase and on `net:gameStarting`.
 * Re-renders on `net:lobbyUpdated`; `net:error` and copy results are surfaced inline (the HUD notification stack is
 * hidden while a menu is up) and also via `ui:notify`.
 */
export class LobbyMenu extends MenuBase {
  private open = false;
  private busy = false;
  private statusTimer = 0;
  private msgTimer: number | null = null;

  // header
  private pill: HTMLElement;
  // join view
  private joinView: HTMLElement;
  private nameInput: HTMLInputElement;
  private createBtn: HTMLButtonElement;
  private codeInput: HTMLInputElement;
  private joinBtn: HTMLButtonElement;
  private joinMsg: HTMLElement;
  // room view
  private roomView: HTMLElement;
  private codeEl: HTMLElement;
  private cards: SlotCard[] = [];
  private readyBtn: HTMLButtonElement;
  private hostRow: HTMLElement;
  private seedInput: HTMLInputElement;
  private startBtn: HTMLButtonElement;
  private startSub: HTMLElement;
  private waitText: HTMLElement;
  private roomMsg: HTMLElement;

  constructor(parent: HTMLElement) {
    super(parent, 'lobby');

    /* ── header ── */
    const head = el('div', { cls: 'lobby-head', parent: this.frame });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'wordmark small', html: 'SCAV<span>A</span>NGER', parent: hl });
    el('div', { cls: 'title', text: '분대 로비', parent: hl });
    this.pill = el('div', { cls: 'status-pill offline', parent: head });
    el('i', { parent: this.pill });
    el('span', { text: STATUS_TEXT.offline, parent: this.pill });

    /* ── join view ── */
    this.joinView = el('div', { cls: 'lobby-view join', parent: this.frame });
    const nameField = el('div', { cls: 'field', parent: this.joinView });
    el('span', { cls: 'ui-label', text: '호출 부호 (이름)', parent: nameField });
    this.nameInput = el('input', { cls: 'ui-input', attrs: { type: 'text', placeholder: '스캐빈저', maxlength: '16', spellcheck: 'false', autocomplete: 'off' }, parent: nameField });
    this.stopKeys(this.nameInput);
    this.nameInput.addEventListener('change', () => this.commitName());

    const createRow = el('div', { cls: 'actions', parent: this.joinView });
    this.createBtn = this.button(createRow, '로비 생성', () => void this.create(), 'primary');

    const or = el('div', { cls: 'or', parent: this.joinView });
    el('i', { parent: or }); el('span', { text: '또는 코드로 참가', parent: or }); el('i', { parent: or });

    const codeField = el('div', { cls: 'field', parent: this.joinView });
    el('span', { cls: 'ui-label', text: `로비 코드 (${NET_LOBBY_CODE_LENGTH}자)`, parent: codeField });
    const codeRow = el('div', { cls: 'row', parent: codeField });
    this.codeInput = el('input', { cls: 'ui-input code-input', attrs: { type: 'text', placeholder: 'ABC234', maxlength: String(NET_LOBBY_CODE_LENGTH), spellcheck: 'false', autocomplete: 'off', autocapitalize: 'characters' }, parent: codeRow });
    this.stopKeys(this.codeInput, () => void this.join());
    this.codeInput.addEventListener('input', () => {
      const n = normalizeLobbyCode(this.codeInput.value).slice(0, NET_LOBBY_CODE_LENGTH);
      if (n !== this.codeInput.value) this.codeInput.value = n;
    });
    this.joinBtn = this.button(codeRow, '참가', () => void this.join());
    this.joinMsg = this.msgEl(this.joinView);

    const back = el('div', { cls: 'actions', parent: this.joinView });
    this.button(back, '뒤로', () => this.ctx.bus.emit('ui:lobbyToggled', { open: false }));

    /* ── room view ── */
    this.roomView = el('div', { cls: 'lobby-view room', parent: this.frame });
    const codeBlock = el('div', { cls: 'code-block', parent: this.roomView });
    el('span', { cls: 'ui-label', text: '로비 코드 — 분대원에게 전달', parent: codeBlock });
    this.codeEl = el('div', { cls: 'code ui-mono', text: '------', parent: codeBlock });
    const copyRow = el('div', { cls: 'row', parent: codeBlock });
    this.button(copyRow, '코드 복사', () => void this.copy(this.ctx.net?.lobby?.code ?? '', '코드 복사됨'), 'small');
    this.button(copyRow, '초대 링크 복사', () => void this.copy(this.ctx.net?.getInviteUrl() ?? '', '초대 링크 복사됨'), 'small');

    const slots = el('div', { cls: 'slots', parent: this.roomView });
    for (let i = 0; i < NET_MAX_PLAYERS; i++) {
      const root = el('div', { cls: 'slot-card empty', parent: slots });
      root.style.setProperty('--sc', NET_SLOT_COLORS_CSS[i] ?? '#fff');
      el('i', { cls: 'bar', parent: root });
      const body = el('div', { cls: 'body', parent: root });
      const top = el('div', { cls: 'top', parent: body });
      el('span', { cls: 'num ui-mono', text: String(i + 1), parent: top });
      const name = el('span', { cls: 'name', text: '빈 자리', parent: top });
      const host = el('span', { cls: 'badge', text: '호스트', parent: top });
      host.hidden = true;
      const state = el('div', { cls: 'state', text: '', parent: body });
      this.cards.push({ root, name, host, state });
    }

    this.roomMsg = this.msgEl(this.roomView);

    const actions = el('div', { cls: 'lobby-actions', parent: this.roomView });
    this.readyBtn = this.button(actions, '준비', () => this.toggleReady(), 'primary');

    this.hostRow = el('div', { cls: 'host-row', parent: actions });
    const seedField = el('div', { cls: 'field', parent: this.hostRow });
    el('span', { cls: 'ui-label', text: '임무 시드 (비워두면 무작위)', parent: seedField });
    const seedRow = el('div', { cls: 'row', parent: seedField });
    this.seedInput = el('input', { cls: 'ui-input', attrs: { type: 'text', placeholder: '예: 8813', maxlength: '12', spellcheck: 'false' }, parent: seedRow });
    this.stopKeys(this.seedInput, () => this.start());
    this.button(seedRow, '무작위', () => { this.seedInput.value = String(Math.floor(Math.random() * 99999)); });
    this.startBtn = this.button(this.hostRow, '임무 배치', () => this.start(), 'primary');
    this.startBtn.disabled = true;
    this.startSub = el('div', { cls: 'sub', text: '모든 분대원이 준비되어야 합니다', parent: this.hostRow });

    this.waitText = el('div', { cls: 'wait', text: '호스트가 임무를 시작하기를 기다리는 중…', parent: actions });
    this.button(actions, '로비 나가기', () => this.ctx.net?.leaveLobby(), 'danger');

    el('div', { cls: 'version', text: 'SCAVANGER · SQUAD', parent: this.root });
  }

  /* ── wiring ─────────────────────────────────────────────────────────────── */

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:phaseChanged', () => this.refresh()),
      b.on('ui:lobbyToggled', ({ open }) => { this.open = open; this.refresh(); }),
      b.on('net:lobbyUpdated', ({ lobby }) => { this.busy = false; this.render(lobby); this.refresh(); }),
      b.on('net:lobbyLeft', ({ reason }) => {
        this.busy = false;
        if (reason === 'hostLeft') this.leftMessage('호스트가 나갔습니다', 'warning');
        else if (reason === 'disconnected') this.leftMessage('서버와의 연결이 끊어졌습니다', 'danger');
        else if (reason === 'kicked') this.leftMessage('로비에서 제외되었습니다', 'warning');
        this.refresh();
      }),
      b.on('net:error', ({ message }) => {
        this.busy = false;
        this.setMsg(message || '네트워크 오류', 'danger');
        b.emit('ui:notify', { text: message || '네트워크 오류', kind: 'danger' });
        this.syncButtons();
      }),
      b.on('net:statusChanged', ({ status }) => {
        if (status === 'error' || status === 'offline') this.busy = false;
        this.updateStatus();
        this.syncButtons();
      }),
      b.on('net:peerJoined', ({ name }) => this.setMsg(`${name} 합류`, 'success')),
      b.on('net:peerLeft', ({ name }) => this.setMsg(`${name} 이탈`, 'warning')),
      b.on('net:gameStarting', () => this.hide()),
    );
    this.refresh();
    this.checkInvite();
  }

  /** Invite URL (`?lobby=CODE`) → open the lobby screen with the code pre-filled. Safe to call more than once. */
  checkInvite(): void {
    const net = this.ctx.net;
    if (!net?.inviteCode || this.codeInput.value) return;
    this.codeInput.value = normalizeLobbyCode(net.inviteCode).slice(0, NET_LOBBY_CODE_LENGTH);
    if (!this.open && this.ctx.phase === 'menu') this.ctx.bus.emit('ui:lobbyToggled', { open: true });
  }

  update(dt: number): void {
    if (!this.visible) return;
    this.statusTimer += dt;
    if (this.statusTimer >= STATUS_POLL) { this.statusTimer = 0; this.updateStatus(); }
  }

  private refresh(): void {
    const ctx = this.ctx;
    const net = ctx.net;
    const show = ctx.phase === 'menu' && !!net && (!!net.lobby || this.open);
    if (!show) { this.hide(); return; }
    const inLobby = !!net.lobby;
    this.joinView.hidden = inLobby;
    this.roomView.hidden = !inLobby;
    if (inLobby) this.render(net.lobby!);
    this.updateStatus();
    this.syncButtons();
    this.show();
  }

  protected override onShow(): void {
    const net = this.ctx.net;
    if (net && !this.nameInput.value) this.nameInput.value = net.playerName;
    if (!net?.lobby) {
      // focus the most useful field
      window.setTimeout(() => { if (this.visible && !this.ctx.net?.lobby) (this.codeInput.value ? this.codeInput : this.nameInput).focus(); }, 30);
    }
  }

  protected override onHide(): void {
    this.busy = false;
    this.clearMsg();
  }

  /* ── join view actions ──────────────────────────────────────────────────── */

  private commitName(): void {
    const net = this.ctx.net;
    if (!net) return;
    const name = sanitizePlayerName(this.nameInput.value);
    this.nameInput.value = name;
    if (name !== net.playerName) net.setPlayerName(name);
  }

  private async ensureConnected(net: NetRef): Promise<boolean> {
    if (net.connected) return true;
    this.busy = true; this.syncButtons(); this.updateStatus();
    try {
      await net.connect();
      return net.connected;
    } catch (err) {
      this.setMsg('서버에 연결할 수 없습니다', 'danger');
      this.ctx.bus.emit('ui:notify', { text: '서버에 연결할 수 없습니다', kind: 'danger' });
      console.warn('[lobby] connect failed', err);
      return false;
    } finally {
      this.busy = false; this.syncButtons(); this.updateStatus();
    }
  }

  private async create(): Promise<void> {
    const net = this.ctx.net;
    if (!net || this.busy) return;
    this.commitName();
    if (!(await this.ensureConnected(net))) return;
    this.busy = true; this.syncButtons();
    net.createLobby();
  }

  private async join(): Promise<void> {
    const net = this.ctx.net;
    if (!net || this.busy) return;
    const code = normalizeLobbyCode(this.codeInput.value);
    this.codeInput.value = code;
    if (!isValidLobbyCode(code)) {
      this.setMsg(`로비 코드는 ${NET_LOBBY_CODE_LENGTH}자입니다 (I·O·0·1 제외)`, 'danger');
      this.codeInput.focus();
      return;
    }
    this.commitName();
    if (!(await this.ensureConnected(net))) return;
    this.busy = true; this.syncButtons();
    net.joinLobby(code);
  }

  /* ── room view actions ──────────────────────────────────────────────────── */

  private toggleReady(): void {
    const net = this.ctx.net;
    if (!net?.lobby || !net.localId) return;
    const me = net.getLobbyPlayer(net.localId);
    net.setReady(!(me?.ready ?? false));
  }

  private start(): void {
    const net = this.ctx.net;
    if (!net?.lobby || !net.isHost) return;
    if (!this.allReady(net.lobby)) { this.setMsg('모든 분대원이 준비되어야 합니다', 'warning'); return; }
    net.startGame(parseSeed(this.seedInput.value));
  }

  private async copy(text: string, okMsg: string): Promise<void> {
    if (!text) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
    } catch { ok = false; }
    if (!ok) {
      // fallback: select the code so the user can Ctrl+C
      try {
        const range = document.createRange(); range.selectNodeContents(this.codeEl);
        const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
        ok = document.execCommand?.('copy') ?? false;
      } catch { ok = false; }
    }
    this.setMsg(ok ? okMsg : '자동 복사 실패 — 코드를 직접 복사하세요', ok ? 'success' : 'warning');
    this.ctx.bus.emit('ui:notify', { text: ok ? '복사됨' : '복사 실패', kind: ok ? 'success' : 'warning', duration: 2 });
  }

  /* ── rendering ──────────────────────────────────────────────────────────── */

  private render(lobby: LobbyState): void {
    const net = this.ctx.net;
    if (!net) return;
    setText(this.codeEl, lobby.code);
    for (let i = 0; i < NET_MAX_PLAYERS; i++) {
      const card = this.cards[i];
      const p = lobby.players.find((q) => q.slot === i);
      toggleClass(card.root, 'empty', !p);
      toggleClass(card.root, 'me', !!p && p.id === net.localId);
      toggleClass(card.root, 'ready', !!p && p.ready);
      setText(card.name, p ? p.name : '빈 자리');
      card.host.hidden = !(p?.isHost ?? false);
      setText(card.state, p ? (p.ready ? '준비 완료' : '대기 중') : (lobby.started ? '' : '참가 대기'));
    }
    const me = net.localId ? net.getLobbyPlayer(net.localId) : undefined;
    const ready = me?.ready ?? false;
    setText(this.readyBtn, ready ? '준비 취소' : '준비');
    toggleClass(this.readyBtn, 'primary', !ready);
    toggleClass(this.readyBtn, 'on', ready);

    const isHost = net.isHost;
    this.hostRow.hidden = !isHost;
    this.waitText.hidden = isHost;
    const all = this.allReady(lobby);
    this.startBtn.disabled = !all || lobby.started;
    setText(this.startSub, lobby.started ? '임무 진행 중 — 종료 후 다시 배치할 수 있습니다'
      : all ? `분대 ${lobby.players.length}명 준비 완료` : '모든 분대원이 준비되어야 합니다');
    toggleClass(this.startSub, 'ok', all && !lobby.started);
    if (lobby.seed !== null && !this.seedInput.value) this.seedInput.value = String(lobby.seed);
  }

  private allReady(lobby: LobbyState): boolean {
    return lobby.players.length > 0 && lobby.players.every((p) => p.ready);
  }

  private updateStatus(): void {
    const net = this.ctx.net;
    const status: NetStatus = net?.status ?? 'offline';
    const shown: NetStatus = this.busy && status !== 'connected' ? 'connecting' : status;
    let text = STATUS_TEXT[shown];
    if (shown === 'connected' && net) text += ` · ${Math.max(0, Math.round(net.rttMs))} ms`;
    const span = this.pill.lastElementChild as HTMLElement | null;
    if (span) setText(span, text);
    for (const k of Object.keys(STATUS_TEXT) as NetStatus[]) toggleClass(this.pill, k, k === shown);
  }

  private syncButtons(): void {
    this.createBtn.disabled = this.busy;
    this.joinBtn.disabled = this.busy;
    toggleClass(this.joinView, 'busy', this.busy);
  }

  /* ── messages ───────────────────────────────────────────────────────────── */

  private msgEl(parent: HTMLElement): HTMLElement {
    const m = el('div', { cls: 'form-msg', text: '', parent });
    m.hidden = true;
    return m;
  }

  /** Inline message in whichever view is showing. */
  private setMsg(text: string, kind: MsgKind): void {
    for (const m of [this.joinMsg, this.roomMsg]) {
      setText(m, text);
      m.className = `form-msg ${kind}`;
      m.hidden = false;
    }
    if (this.msgTimer !== null) window.clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => this.clearMsg(), MSG_TTL_MS);
  }

  private clearMsg(): void {
    if (this.msgTimer !== null) { window.clearTimeout(this.msgTimer); this.msgTimer = null; }
    this.joinMsg.hidden = true; this.roomMsg.hidden = true;
  }

  /** We were dropped from a lobby for a reason worth telling: keep the screen up (join view) with the message. */
  private leftMessage(text: string, kind: MsgKind): void {
    this.ctx.bus.emit('ui:notify', { text, kind });
    if (!this.open && this.ctx.phase === 'menu') this.ctx.bus.emit('ui:lobbyToggled', { open: true });
    this.setMsg(text, kind);
  }

  /* ── helpers ────────────────────────────────────────────────────────────── */

  /** Inputs must not leak keys to the game Input (mirrors TitleMenu's seed field). Enter → `onEnter`. */
  private stopKeys(input: HTMLInputElement, onEnter?: () => void): void {
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && onEnter) onEnter(); });
    input.addEventListener('keyup', (e) => e.stopPropagation());
  }

  override dispose(): void {
    if (this.msgTimer !== null) window.clearTimeout(this.msgTimer);
    super.dispose();
  }
}
