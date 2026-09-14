import type { GameContext, LobbyState, NetRef } from '@/shared';
import { NET_MAX_PLAYERS, NET_SLOT_COLORS_CSS, isValidLobbyCode, normalizeLobbyCode } from '@/shared';
import { el, isolateInput, setText, toggleClass } from './dom';

/* ────────────────────────────────────────────────────────────────────────────
 * 매칭 팝업 (2026-09-14, `docs/plans/intel-broker.md` §4.1 — 사용자 결정).
 *
 * 터미널이 3열에서 2열로 줄면서(행성이 중앙에서 넓게 · 우측은 정보상 + 훈련장) **옛 좌측 열이 통째로 여기로
 * 왔다.** 로직은 한 줄도 바뀌지 않았다 — 신호 찾기(자동 매칭) · 코드로 도킹 · 신호 송출 · 공유 함선 코드 ·
 * 공개/비공개 · 초대 링크 · 승무원 4행 · 도킹 해제. 네트워크를 만지는 부분은 전부 터미널이 들고 있으므로
 * (`connectThen` · `showMsg` 의 busy 상태 · 인라인 메시지 줄) 이 패널은 **`MatchPanelHost` 를 통해서만** 부른다.
 *
 * 화면 규약: `ctx.uiBlockers` + `ctx.escape.push/remove` 짝(토큰 `hub:match` — 터미널의 `hub` 와 **다른 토큰**이라
 * 뒤의 터미널이 커서를 잃지 않는다), **Tab 으로도 닫힌다**(`HubMenu.update` 가 맨 위 화면으로 보낸다),
 * `ui:keyGuide` 발행(닫기 항목은 가이드가 스스로 붙이므로 `keys` 에 넣지 않는다).
 *
 * CSS 접두사 `.hm-` (`hub/intel.css`) — `rg "\.hm-" src` 가 비어 있음을 확인하고 골랐다.
 * Owner: hub/ui. 여는 곳 — `hub/ui/HubMenu.ts` 머리 우상단 `📡 매칭`.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface MatchPanelHost {
  /** 릴레이에 붙은 뒤 `action` 을 돌린다 (터미널이 busy 상태 · 실패 메시지를 갖는다). */
  connectThen(action: (n: NetRef) => void): void;
  /** 터미널의 인라인 메시지 줄 (닫혀 있으면 토스트). */
  showMsg(text: string, kind?: 'info' | 'success' | 'warning' | 'danger', toast?: boolean): void;
  /** 접속 시도 중인가 (버튼을 잠근다). */
  isBusy(): boolean;
  /** 초대 링크 복사 (터미널이 클립보드 · 실패 표시를 갖는다). */
  copyInvite(): void;
  /** 팝업이 스스로 닫혔다 — 터미널이 자기 화면을 다시 그린다. */
  onClosed(): void;
}

const BLOCKER = 'hub:match';
const GUIDE_OWNER = 'hub.match';

export class MatchPanel {
  readonly root: HTMLElement;
  private _open = false;
  private secSignal: HTMLElement;
  private btnMatch: HTMLButtonElement;
  private codeInput: HTMLInputElement;
  private btnJoin: HTMLButtonElement;
  private btnCreate: HTMLButtonElement;
  private secShip: HTMLElement;
  private codeText: HTMLElement;
  private visTag: HTMLElement;
  private btnInvite: HTMLButtonElement;
  private btnPublic: HTMLButtonElement;
  private crewRows: Array<{ root: HTMLElement; name: HTMLElement; badge: HTMLElement; state: HTMLElement }> = [];
  private btnLeave: HTMLButtonElement;
  private note: HTMLElement;

  constructor(private readonly ctx: GameContext, private readonly host: MatchPanelHost) {
    const root = this.root = el('div', { cls: 'menu hub-menu hm-match interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    const f = el('div', { cls: 'frame', parent: root });

    const head = el('div', { cls: 'hm-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '매칭', parent: hl });
    el('div', { cls: 'subtitle', text: '다른 승무원의 함선에 도킹하거나 내 함선에 신호를 송출합니다', parent: hl });
    this.button(head, '닫기', () => this.close(), 'hm-close');

    const body = el('div', { cls: 'hm-body', parent: f });

    // ── 신호 (개인 함선) ──
    this.secSignal = this.section(body, '신호');
    this.btnMatch = this.button(this.secSignal, '신호 찾기 (자동 매칭)', () => this.host.connectThen((n) => n.quickMatch()), 'primary wide');
    const codeRow = el('div', { cls: 'row', parent: this.secSignal });
    this.codeInput = el('input', {
      cls: 'ui-input code-input',
      attrs: { type: 'text', maxlength: '8', placeholder: '함선 코드', spellcheck: 'false', autocomplete: 'off' },
      parent: codeRow,
    });
    isolateInput(this.codeInput);          // Escape 는 필드만 흐린다 — 팝업은 그대로다
    this.codeInput.addEventListener('input', () => { this.codeInput.value = normalizeLobbyCode(this.codeInput.value); });
    this.codeInput.addEventListener('keydown', (e) => { if (e.code === 'Enter') this.join(); });
    this.btnJoin = this.button(codeRow, '코드로 도킹', () => this.join());
    this.btnCreate = this.button(this.secSignal, '신호 송출 (비공개 함선 생성)', () => this.host.connectThen((n) => n.createLobby()), 'wide');

    // ── 공유 함선 ──
    this.secShip = this.section(body, '공유 함선');
    const codeBlock = el('div', { cls: 'hub-code', parent: this.secShip });
    this.codeText = el('div', { cls: 'code', text: '------', parent: codeBlock });
    this.visTag = el('div', { cls: 'vis', text: '비공개', parent: codeBlock });
    const shipRow = el('div', { cls: 'row', parent: this.secShip });
    this.btnInvite = this.button(shipRow, '초대 링크 복사', () => this.host.copyInvite());
    this.btnPublic = this.button(shipRow, '공개 전환', () => {
      const n = ctx.net; if (!n?.lobby || !n.isHost) return;
      n.setPublic(!n.lobby.isPublic);
    });
    const crew = el('div', { cls: 'hub-crew', parent: this.secShip });
    for (let i = 0; i < NET_MAX_PLAYERS; i++) {
      const row = el('div', { cls: 'crew-row empty', parent: crew });
      row.style.setProperty('--sc', NET_SLOT_COLORS_CSS[i]);
      el('div', { cls: 'bar', parent: row });
      const name = el('div', { cls: 'name', text: '빈 자리', parent: row });
      const badge = el('div', { cls: 'badge', text: '호스트', parent: row });
      badge.hidden = true;
      const state = el('div', { cls: 'state', text: '', parent: row });
      this.crewRows.push({ root: row, name, badge, state });
    }
    this.btnLeave = this.button(this.secShip, '도킹 해제', () => ctx.net?.leaveLobby(), 'danger wide');

    this.note = el('div', { cls: 'hm-note', text: '', parent: body });
    this.note.hidden = true;
    // 로비가 없는 상태가 시작점이다 — `refresh()` 는 팝업이 열려 있을 때만 도므로 여기서 한 번 맞춰 둔다
    this.secShip.hidden = true;

    root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  get isOpen(): boolean { return this._open; }

  open(): void {
    if (this._open) return;
    this._open = true;
    this.root.hidden = false;
    this.ctx.uiBlockers.add(BLOCKER);
    this.ctx.escape.push(BLOCKER, () => this.close());
    this.ctx.input.setCursorMode(true, BLOCKER);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: [] });
    this.refresh();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(BLOCKER);
    this.ctx.escape.remove(BLOCKER);
    this.ctx.input.setCursorMode(false, BLOCKER);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: null });
    this.host.onClosed();
  }

  /** 터미널의 `refresh()` 가 같이 부른다 (로비 · 접속 상태가 바뀌면 여기도 따라온다). */
  refresh(): void {
    if (!this._open) return;
    const ctx = this.ctx, net = ctx.net;
    const lobby = net?.lobby ?? null;
    const isHost = !!net?.isHost && !!lobby;
    // 2026-09-08: 튜토리얼 동안에는 매치메이킹을 통째로 감춘다 (혼자 한 바퀴 돌게 한다)
    const hideNet = ctx.tutorial?.hides('matchmaking') ?? false;
    this.secSignal.hidden = hideNet || !!lobby;
    this.secShip.hidden = hideNet || !lobby;
    this.note.hidden = !hideNet;
    if (hideNet) setText(this.note, '튜토리얼을 마치면 매칭을 쓸 수 있습니다.');

    const canNet = !!net && !this.host.isBusy();
    this.btnMatch.disabled = !canNet;
    this.btnJoin.disabled = !canNet;
    this.btnCreate.disabled = !canNet;

    if (!lobby) return;
    setText(this.codeText, lobby.code);
    setText(this.visTag, lobby.isPublic ? '공개' : '비공개');
    toggleClass(this.visTag, 'public', lobby.isPublic);
    this.btnInvite.disabled = false;
    this.btnPublic.hidden = !isHost;
    setText(this.btnPublic, lobby.isPublic ? '비공개로 전환' : '공개로 전환');
    toggleClass(this.btnPublic, 'on', lobby.isPublic);
    this.renderCrew(lobby, net ?? null);
    this.btnLeave.disabled = false;
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
      const training = lobby.started && (net?.missionMode ?? lobby.mode ?? 'raid') === 'training';
      setText(row.state, off ? '연결 끊김' : training ? (p.inMission ? '훈련장' : '함선') : lobby.started ? (p.ready ? '임무 중' : '함선') : p.ready ? '탑승 완료' : '대기 중');
    }
  }

  private join(): void {
    const code = normalizeLobbyCode(this.codeInput.value);
    if (!isValidLobbyCode(code)) { this.host.showMsg('6자리 함선 코드를 입력하세요', 'warning'); return; }
    this.host.connectThen((n) => n.joinLobby(code));
  }

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

  dispose(): void {
    if (this._open) this.close();
    this.root.remove();
  }
}
