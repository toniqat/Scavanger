import type { GameContext, PlayerCode, SocialPlayer } from '@/shared';
import { PLAY_BLOCK_LABELS, PRESENCE_LABELS, SOCIAL_ERROR_MESSAGE_KO, SQUAD_INVITE_TTL_S, formatPlayerCode } from '@/shared';
import { el, setText, toggleClass } from './dom';

/* ────────────────────────────────────────────────────────────────────────────
 * 분대 초대 창 (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 분대 · 도킹 매칭」 — 사용자 결정).
 *
 * 터미널 매칭 탭의 빈 초상 칸 `초대` 가 연다. 친구 → 최근 만난 플레이어 순이고 한 줄 = 이름 · 아이디
 * (`formatPlayerCode`) · 레벨 · 접속 상태(`PRESENCE_LABELS`) · 오른쪽 `초대`. 초대는 `ctx.net.social.playWith` 하나이고
 * 규칙은 전부 서버 / `playBlock` 의 것이다 — 이 창은 막힌 사유(`PLAY_BLOCK_LABELS`)를 버튼에 그대로 적을 뿐이다.
 * 이미 보낸 초대는 `SocialPlayer.inviteAt` 이 열려 있는 동안 `초대 중 · n초` 로 잠근다 (`SQUAD_INVITE_TTL_S`).
 * 이미 내 분대에 있는 사람은 `playBlock` 이 모르는 경우라(서버가 `in_squad` 로 답한다) 여기서 먼저 `분대원` 으로 잠근다.
 *
 * 줄 목록은 `social:updated` · 로비 변경 때만 다시 짓고, 남은 초는 `tick()` 이 버튼 글자만 고친다 — 매 프레임 줄을
 * 다시 지으면 누르던 버튼이 사라진다.
 *
 * 화면 규약: blocker / escape 토큰 `hub:invite`, 키 가이드 owner `hub.invite`, Tab · E · Escape 로 닫힌다
 * (`HubMenu.closeTop`). CSS 접두사 `.hinv-` (`hub/intel.css`). Owner: hub/ui.
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
    try { this.ctx.net?.social.refresh(); } catch { /* 옛 구현 — 이미 받은 목록으로 그린다 */ }
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

  /** 목록을 다시 짓는다 (`social:updated` · 로비 · 접속 상태가 바뀔 때 터미널이 부른다). */
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

  /** 버튼 글자 · 잠금만 고친다 (남은 초가 흐른다). 터미널의 `update` 가 열려 있는 동안 매 프레임 부른다. */
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
