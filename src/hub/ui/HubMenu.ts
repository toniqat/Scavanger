import type { GameContext, LobbyState, NetRef } from '@/shared';
import { NET_SLOT_COLORS_CSS, NET_MAX_PLAYERS, isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName } from '@/shared';
import { el, isolateInput, parseSeed, randomSeed, setText, toggleClass } from './dom';
import { ImplantPanel } from './ImplantPanel';
import { RepairPanel } from './RepairPanel';

/** Terminal pages. `ship` is the original menu (crew / seed / signal / shared ship). */
export type HubTab = 'ship' | 'implant' | 'repair';

/** What the menu needs from HubSystem. */
export interface HubMenuHost {
  getMissionSeed(): number | null;
  setMissionSeed(seed: number | null): void;
  /** "타이틀로": tear the hub down and return to the title. */
  toTitle(): void;
  /** Called after the menu closed itself (Esc / 닫기) so the hub re-locks the pointer. */
  onClosed(): void;
}

const MSG_TTL = 4500;

/**
 * Ship terminal menu (`.menu.hub-menu`): pilot name, mission seed, signal search (quick match) / dock by code /
 * broadcast (private ship) in the personal ship; code + invite + public toggle + crew + undock in the shared ship.
 * Adds the `'hub'` blocker token before exiting pointer lock; emits `ui:hubMenuToggled`.
 */
export class HubMenu {
  readonly root: HTMLElement;
  private frame: HTMLElement;
  private unsubs: Array<() => void> = [];
  private _open = false;
  private msgTimer = 0;
  private busy = false;

  // header
  private subtitle: HTMLElement;
  private pill: HTMLElement;
  private pillText: HTMLElement;
  // pilot / seed
  private nameInput: HTMLInputElement;
  private seedInput: HTMLInputElement;
  private seedHint: HTMLElement;
  private seedRandom: HTMLButtonElement;
  // personal
  private secSignal: HTMLElement;
  private btnMatch: HTMLButtonElement;
  private codeInput: HTMLInputElement;
  private btnJoin: HTMLButtonElement;
  private btnCreate: HTMLButtonElement;
  // shared
  private secShip: HTMLElement;
  private codeText: HTMLElement;
  private visTag: HTMLElement;
  private btnInvite: HTMLButtonElement;
  private btnPublic: HTMLButtonElement;
  private crew: HTMLElement;
  private crewRows: Array<{ root: HTMLElement; name: HTMLElement; badge: HTMLElement; state: HTMLElement }> = [];
  private btnLeave: HTMLButtonElement;
  // pages / tabs (tactical kit)
  private pageShip: HTMLElement;
  private implants: ImplantPanel;
  private repairs: RepairPanel;
  private tabs = new Map<HubTab, HTMLButtonElement>();
  private tab: HubTab = 'ship';
  private btnStats: HTMLButtonElement;
  // footer / message
  private msg: HTMLElement;

  constructor(private readonly ctx: GameContext, private readonly host: HubMenuHost) {
    const root = this.root = el('div', { cls: 'menu hub-menu interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    const f = this.frame = el('div', { cls: 'frame', parent: root });

    // ── header ──
    const head = el('div', { cls: 'hub-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '함선 터미널', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });
    this.pill = el('div', { cls: 'status-pill offline', parent: head });
    el('i', { parent: this.pill });
    this.pillText = el('span', { text: '오프라인', parent: this.pill });

    // ── tabs + page host (tactical kit) ──
    const tabBar = el('div', { cls: 'hub-tabs', parent: f });
    const pages = el('div', { cls: 'hub-pages', parent: f });
    const page = this.pageShip = el('div', { cls: 'hub-page', parent: pages });
    this.implants = new ImplantPanel(ctx, this);
    this.repairs = new RepairPanel(ctx, this);
    pages.appendChild(this.implants.root);
    pages.appendChild(this.repairs.root);
    for (const [id, label] of [['ship', '함선'], ['implant', '임플란트'], ['repair', '정비']] as Array<[HubTab, string]>) {
      const t = el('button', { cls: 'hub-tab', text: label, parent: tabBar });
      t.addEventListener('click', (e) => { e.stopPropagation(); ctx.bus.emit('audio:play', { id: 'ui_click' }); this.setTab(id); });
      this.tabs.set(id, t);
    }

    // ── pilot ──
    const secPilot = this.section(page, '승무원');
    const nameRow = el('div', { cls: 'row', parent: secPilot });
    this.nameInput = el('input', { cls: 'ui-input', attrs: { type: 'text', maxlength: '16', placeholder: '호출명', spellcheck: 'false' }, parent: nameRow });
    isolateInput(this.nameInput, () => this.close());
    this.nameInput.addEventListener('change', () => {
      const n = sanitizePlayerName(this.nameInput.value);
      this.nameInput.value = n;
      ctx.net?.setPlayerName(n);      // also renames in-lobby (server broadcasts lobby:state)
      this.showMsg(`호출명 변경: ${n}`, 'success');
    });
    el('div', { cls: 'hint', text: '분대에 표시되는 이름입니다.', parent: secPilot });

    // ── seed ──
    const secSeed = this.section(page, '임무 시드');
    const seedRow = el('div', { cls: 'row', parent: secSeed });
    this.seedInput = el('input', { cls: 'ui-input', attrs: { type: 'text', placeholder: '비워두면 무작위', spellcheck: 'false' }, parent: seedRow });
    isolateInput(this.seedInput, () => this.close());
    this.seedInput.addEventListener('change', () => this.applySeed(parseSeed(this.seedInput.value)));
    this.seedRandom = this.button(seedRow, '무작위', () => { const s = randomSeed(); this.seedInput.value = String(s); this.applySeed(s); });
    this.seedHint = el('div', { cls: 'hint', text: '', parent: secSeed });

    // ── signal (personal ship) ──
    this.secSignal = this.section(page, '신호');
    this.btnMatch = this.button(this.secSignal, '신호 찾기 (자동 매칭)', () => this.connectThen((n) => n.quickMatch()), 'primary wide');
    const codeRow = el('div', { cls: 'row', parent: this.secSignal });
    this.codeInput = el('input', { cls: 'ui-input code-input', attrs: { type: 'text', maxlength: '8', placeholder: '함선 코드', spellcheck: 'false', autocomplete: 'off' }, parent: codeRow });
    isolateInput(this.codeInput, () => this.close());
    this.codeInput.addEventListener('input', () => { this.codeInput.value = normalizeLobbyCode(this.codeInput.value); });
    this.codeInput.addEventListener('keydown', (e) => { if (e.code === 'Enter') this.join(); });
    this.btnJoin = this.button(codeRow, '코드로 도킹', () => this.join());
    this.btnCreate = this.button(this.secSignal, '신호 송출 (비공개 함선 생성)', () => this.connectThen((n) => n.createLobby()), 'wide');
    el('div', { cls: 'hint', text: '자동 매칭은 공개 함선에 도킹합니다. 코드가 있으면 분대의 함선에 직접 도킹하세요.', parent: this.secSignal });

    // ── ship (shared) ──
    this.secShip = this.section(page, '공유 함선');
    const codeBlock = el('div', { cls: 'hub-code', parent: this.secShip });
    this.codeText = el('div', { cls: 'code', text: '------', parent: codeBlock });
    this.visTag = el('div', { cls: 'vis', text: '비공개', parent: codeBlock });
    const shipRow = el('div', { cls: 'row', parent: this.secShip });
    this.btnInvite = this.button(shipRow, '초대 링크 복사', () => this.copyInvite());
    this.btnPublic = this.button(shipRow, '공개 전환', () => {
      const n = ctx.net; if (!n?.lobby || !n.isHost) return;
      n.setPublic(!n.lobby.isPublic);
    });
    this.crew = el('div', { cls: 'hub-crew', parent: this.secShip });
    for (let i = 0; i < NET_MAX_PLAYERS; i++) {
      const row = el('div', { cls: 'crew-row empty', parent: this.crew });
      row.style.setProperty('--sc', NET_SLOT_COLORS_CSS[i]);
      el('div', { cls: 'bar', parent: row });
      const name = el('div', { cls: 'name', text: '빈 자리', parent: row });
      const badge = el('div', { cls: 'badge', text: '호스트', parent: row });
      badge.hidden = true;
      const state = el('div', { cls: 'state', text: '', parent: row });
      this.crewRows.push({ root: row, name, badge, state });
    }
    this.btnLeave = this.button(this.secShip, '도킹 해제', () => ctx.net?.leaveLobby(), 'danger wide');

    // ── message + footer ──
    this.msg = el('div', { cls: 'form-msg', parent: f });
    this.msg.hidden = true;
    const foot = el('div', { cls: 'hub-foot', parent: f });
    this.btnStats = this.button(foot, '캐릭터', () => this.openStats());
    const footRight = el('div', { cls: 'right', parent: foot });
    this.button(footRight, '닫기', () => this.close());
    this.button(footRight, '타이틀로', () => { this.close(false); host.toTitle(); }, 'danger');

    // keep clicks inside from reaching the canvas' click-to-lock fallback
    root.addEventListener('mousedown', (e) => e.stopPropagation());

    const b = ctx.bus;
    this.unsubs.push(
      b.on('net:statusChanged', () => this.refresh()),
      b.on('net:lobbyUpdated', () => this.refresh()),
      b.on('net:lobbyLeft', ({ reason }) => {
        this.refresh();
        if (reason === 'hostLeft') this.showMsg('호스트가 함선을 떠났습니다', 'warning');
        else if (reason === 'disconnected') this.showMsg('서버와의 연결이 끊어졌습니다', 'danger');
        else if (reason === 'kicked') this.showMsg('함선에서 분리되었습니다', 'warning');
      }),
      b.on('net:error', ({ code, message }) => this.showMsg(this.errorText(code, message), 'danger')),
      b.on('net:matched', ({ created }) => this.showMsg(created ? '열린 신호가 없어 새 공개 함선을 열었습니다' : '신호 포착 — 도킹 절차 시작', 'success')),
      b.on('net:peerJoined', ({ name }) => this.showMsg(`${name} 합류`, 'info')),
      b.on('net:peerLeft', ({ name }) => this.showMsg(`${name} 이탈`, 'warning')),
    );
  }

  get isOpen(): boolean { return this._open; }

  /* ── tabs (tactical kit) ──────────────────────────────────────────────── */
  setTab(tab: HubTab): void {
    this.tab = tab;
    for (const [id, btn] of this.tabs) toggleClass(btn, 'on', id === tab);
    this.pageShip.hidden = tab !== 'ship';
    this.implants.root.hidden = tab !== 'implant';
    this.repairs.root.hidden = tab !== 'repair';
    this.repairs.setVisible(tab === 'repair');
    if (tab === 'implant') this.implants.refresh();
    this.refresh();
  }

  /** 캐릭터: hand over to progression's character sheet (it owns the panel and its own blocker token). */
  private openStats(): void {
    if (!this.ctx.progression) { this.showMsg('캐릭터 정보를 사용할 수 없습니다', 'warning'); return; }
    this.close(false);                       // release the 'hub' blocker; the sheet adds 'stats'
    this.ctx.bus.emit('ui:statsToggled', { open: true });
  }

  /* ── open / close ─────────────────────────────────────────────────────── */
  open(tab: HubTab = 'ship'): void {
    if (this._open) { this.setTab(tab); return; }
    this._open = true;
    this.ctx.uiBlockers.add('hub');            // before the lock exits (GameFlow / hub pointer-lock etiquette)
    this.ctx.input.exitPointerLock();
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    this.nameInput.value = this.ctx.net?.playerName ?? '스캐빈저';
    const seed = this.currentSeed();
    this.seedInput.value = seed === null ? '' : String(seed);
    this.setTab(tab);                          // also refreshes
    this.ctx.bus.emit('ui:hubMenuToggled', { open: true });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(relock = true): void {
    if (!this._open) return;
    this._open = false;
    this.repairs.setVisible(false);
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete('hub');
    this.ctx.bus.emit('ui:hubMenuToggled', { open: false });
    if (relock) this.host.onClosed();
  }

  /* ── state → DOM ──────────────────────────────────────────────────────── */
  refresh(): void {
    if (!this._open) return;
    const ctx = this.ctx, net = ctx.net;
    const lobby = net?.lobby ?? null;
    const status = net?.status ?? 'offline';
    const isHost = !!net?.isHost && !!lobby;

    // header
    setText(this.subtitle, lobby ? `공유 함선 · ${lobby.players.length}/${NET_MAX_PLAYERS} 승무원` : '개인 함선');
    this.pill.className = `status-pill ${status}`;
    setText(this.pillText, status === 'connected' ? `연결됨${net && net.rttMs > 0 ? ` · ${Math.round(net.rttMs)} ms` : ''}` : status === 'connecting' ? '연결 중' : status === 'error' ? '오류' : '오프라인');

    // seed
    const seedEditable = !lobby || isHost;
    this.seedInput.disabled = !seedEditable;
    this.seedRandom.disabled = !seedEditable;
    if (lobby && !isHost) this.seedInput.value = lobby.seed === null ? '' : String(lobby.seed);
    setText(this.seedHint, !lobby ? '숫자 또는 임의의 문구. 비워두면 발사 시 무작위 시드가 선택됩니다.'
      : isHost ? '분대 전원이 같은 시드로 투입됩니다.' : lobby.seed === null ? '호스트가 시드를 선택합니다 (무작위).' : '호스트가 선택한 시드입니다.');

    // tactical-kit pages: 캐릭터 needs progression, the panels degrade on their own
    this.btnStats.disabled = !ctx.progression;
    if (this.tab === 'implant') this.implants.refresh();
    else if (this.tab === 'repair') this.repairs.refresh();

    // sections
    this.secSignal.hidden = !!lobby;
    this.secShip.hidden = !lobby;
    const canNet = !!net && !this.busy;
    this.btnMatch.disabled = !canNet;
    this.btnJoin.disabled = !canNet;
    this.btnCreate.disabled = !canNet;
    if (!net) setText(this.msgEl(), '');

    if (lobby) {
      setText(this.codeText, lobby.code);
      setText(this.visTag, lobby.isPublic ? '공개' : '비공개');
      toggleClass(this.visTag, 'public', lobby.isPublic);
      this.btnPublic.hidden = !isHost;
      setText(this.btnPublic, lobby.isPublic ? '비공개로 전환' : '공개로 전환');
      toggleClass(this.btnPublic, 'on', lobby.isPublic);
      this.renderCrew(lobby, net);
      this.btnLeave.disabled = false;
    }
  }

  private renderCrew(lobby: LobbyState, net: NetRef | null): void {
    for (let slot = 0; slot < NET_MAX_PLAYERS; slot++) {
      const row = this.crewRows[slot];
      const p = lobby.players.find((q) => q.slot === slot);
      if (!p) {
        row.root.className = 'crew-row empty';
        setText(row.name, '빈 자리'); setText(row.state, ''); row.badge.hidden = true;
        continue;
      }
      const me = p.id === net?.localId;
      const off = !p.connected;
      row.root.className = `crew-row${p.ready ? ' ready' : ''}${me ? ' me' : ''}${off ? ' off' : ''}`;
      setText(row.name, p.name);
      row.badge.hidden = !p.isHost;
      setText(row.state, off ? '연결 끊김' : lobby.started ? (p.ready ? '임무 중' : '함선') : p.ready ? '탑승 완료' : '대기 중');
    }
  }

  /* ── actions ──────────────────────────────────────────────────────────── */
  private currentSeed(): number | null {
    const lobby = this.ctx.net?.lobby;
    if (lobby) return lobby.seed;
    return this.host.getMissionSeed();
  }

  private applySeed(seed: number | null): void {
    const net = this.ctx.net;
    if (net?.lobby) {
      if (!net.isHost) return;
      if (seed !== null) net.setLobbySeed(seed);
      else this.showMsg('공유 함선에서는 시드를 비울 수 없습니다 — 무작위 버튼을 사용하세요', 'info');
    } else {
      this.host.setMissionSeed(seed);
    }
    this.refresh();
  }

  private join(): void {
    const code = normalizeLobbyCode(this.codeInput.value);
    if (!isValidLobbyCode(code)) { this.showMsg('6자리 함선 코드를 입력하세요', 'warning'); return; }
    this.connectThen((n) => n.joinLobby(code));
  }

  /** Connect (idempotent) then run `action`; shows an inline error when the relay is unreachable. */
  private connectThen(action: (n: NetRef) => void): void {
    const net = this.ctx.net;
    if (!net) { this.showMsg('멀티플레이 사용 불가 (네트워크 모듈 없음)', 'danger'); return; }
    this.busy = true; this.refresh();
    const p: Promise<boolean> = typeof net.ensureConnected === 'function'
      ? net.ensureConnected()
      : net.connect().then(() => true, () => false);
    p.then((ok) => {
      this.busy = false; this.refresh();
      if (!ok) { this.showMsg('서버에 연결할 수 없습니다', 'danger'); return; }
      action(net);
    }).catch(() => { this.busy = false; this.refresh(); this.showMsg('서버에 연결할 수 없습니다', 'danger'); });
  }

  private copyInvite(): void {
    const url = this.ctx.net?.getInviteUrl();
    if (!url) return;
    const done = (): void => { this.showMsg('초대 링크 복사됨', 'success'); this.ctx.bus.emit('ui:notify', { text: '초대 링크가 복사되었습니다', kind: 'success' }); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => this.showMsg(url, 'info'));
    else this.showMsg(url, 'info');
  }

  private errorText(code: string, message: string): string {
    switch (code) {
      case 'not_found': return '해당 코드의 함선을 찾을 수 없습니다';
      case 'full': return '함선이 만석입니다';
      case 'started': return '해당 함선은 이미 임무 중입니다';
      case 'not_host': return '호스트만 할 수 있습니다';
      case 'not_ready': return '모든 승무원이 탑승해야 합니다';
      case 'in_lobby': return '이미 함선에 도킹되어 있습니다';
      case 'not_in_lobby': return '도킹된 함선이 없습니다';
      case 'not_started': return '진행 중인 임무가 없습니다';
      case 'duplicate': return '다른 탭에서 같은 세션이 연결되었습니다';
      case 'invalid': return '잘못된 요청입니다';
      default: return message || '서버 오류';
    }
  }

  /* ── helpers ──────────────────────────────────────────────────────────── */
  private section(parent: HTMLElement, label: string): HTMLElement {
    const s = el('div', { cls: 'hub-section', parent });
    el('div', { cls: 'ui-label', text: label, parent: s });
    return s;
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`, text: label, parent });
    b.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); onClick(); });
    return b;
  }

  private msgEl(): HTMLElement { return this.msg; }

  showMsg(text: string, kind: 'info' | 'success' | 'warning' | 'danger' = 'info'): void {
    if (!this._open) return;
    this.msg.className = `form-msg ${kind}`;
    setText(this.msg, text);
    this.msg.hidden = false;
    this.msgTimer = performance.now() + MSG_TTL;
  }

  update(): void {
    if (this.msgTimer > 0 && !this.msg.hidden && performance.now() > this.msgTimer) { this.msg.hidden = true; this.msgTimer = 0; }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.implants.dispose();
    this.repairs.dispose();
    this.ctx.uiBlockers.delete('hub');
    this.root.remove();
  }
}
