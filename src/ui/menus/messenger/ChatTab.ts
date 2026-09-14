import type {
  GameContext, HoldAskHandle, NpcDef, NpcMessage, PlayerCode, PresenceState, RoomInfo, RoomLine,
} from '@/shared';
import {
  CORP_DEFS, NPC_DEF_MAP, NPC_ROLE_LABEL_KO, PRESENCE_LABELS, PRIVATE_CHAT_LABEL_KO, ROOM_MEMBER_MAX, ROOM_NAME_MAX,
  ROOM_TEXT_MAX, SOCIAL_WHISPER_MAX, formatPlayerCode, openHoldAsk,
} from '@/shared';
import { el, setText, toggleClass } from '../../dom';
import { SOCIAL_UNAVAILABLE_KO, socialOf } from '../social/socialSource';
import { whisperStateClass, whisperStateText } from '../social/whisperText';
import { clip, clockText, initialOf, roomSystemText } from './format';
import { Popover } from './Popover';
import { buildQuestCard } from './QuestCard';
import { npcOf, roomsOf } from './sources';
import { wireTextInput } from './textInput';
import { buildNpcAvatar, buildNpcTrust, npcTrustOf } from './Trust';

export type ConvKind = 'npc' | 'pc' | 'room';
export type ConvFilter = 'all' | ConvKind;

interface ConvRow {
  key: string;
  kind: ConvKind;
  id: string;
  title: string;
  at: number;
  unread: number;
  preview: string;
  glyph: string;
  color: string;
  presence?: PresenceState;
}

/** 초상 색 — NPC 는 `NpcDef.color`, 플레이어 · 단체방은 고정색. */
const PC_COLOR = '#9fb4cc';
const ROOM_COLOR = '#b69cff';
/** 이 간격보다 멀리 떨어진 말풍선 사이에는 시각 구분선을 넣는다. */
const TIME_GAP_MS = 10 * 60_000;
/**
 * 타이핑 연출 (2026-09-14 3차, 사용자 결정) — **새로 도착하는** NPC 말풍선 하나마다 `...` 를 이만큼 띄웠다 지운다.
 * 게임 밸런스가 아니라 **UI 타이밍**이라 `data/` 가 아니라 메신저 폴더 안에 산다.
 */
const TYPE_S_PER_CHAR = 0.028;
const TYPE_MIN_S = 0.5;
const TYPE_MAX_S = 2.0;
const PRESENCE_RANK: Readonly<Record<PresenceState, number>> = { ship: 0, training: 1, raid: 2, offline: 3 };

const FILTERS: readonly { id: ConvFilter; label: string }[] = [
  { id: 'all', label: '전체' }, { id: 'npc', label: 'NPC' }, { id: 'pc', label: PRIVATE_CHAT_LABEL_KO }, { id: 'room', label: '단체방' },
];

export interface ChatTabHost {
  /** 입력칸의 Tab — 메신저 전체를 닫는다 (공용 닫기). */
  requestClose(): void;
  /** 말풍선 퀘스트 카드의 「퀘스트 탭에서 보기」. */
  openQuest(id: string): void;
  /** 대화 탭이 지금 화면에 보이나 (패널 열림 ∧ 탭 = 대화) — 읽음 표시 전에 본다. */
  isVisible(): boolean;
}

function splitKey(key: string | null): { kind: ConvKind; id: string } | null {
  if (!key) return null;
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const kind = key.slice(0, i);
  if (kind !== 'npc' && kind !== 'pc' && kind !== 'room') return null;
  return { kind, id: key.slice(i + 1) };
}

/**
 * 메신저 `대화` 탭 (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *
 * 좌 목록 = NPC 연락(`ctx.meta.npc`) · 개인 대화 상대(친구 + `whisperPeers`) · 단체방(`ctx.net.rooms`)을 **마지막 메시지가 최근인 순**으로
 * 한 줄에 섞는다 (필터 칩으로 좁힌다). 위에는 받은 방 초대(수락 · 거절)와 「방 만들기」.
 * **줄에는 초상 · 이름 · 마지막 대사만 있다** (2026-09-14 3차, 사용자 결정 — 소속 라벨 · `n분` · 신뢰도 게이지는 없앴다).
 * 가운데 = 고른 대화의 말풍선. NPC 는 입력칸 없이 퀘스트 카드로만 답하고, 개인 대화는 `SocialRef.whisper`(채팅창과 같은 기록),
 * 단체방은 `RoomsRef.say` — 단체방은 **메신저 안에서만** 오간다 (채팅창 연동 없음, 사용자 결정).
 *
 * 다시 그리기: 목록은 데이터에서 만든 키가 바뀔 때만(버스 이벤트 + 4 Hz 폴링), 대화는 고른 대화에 닿는 이벤트가 오거나 데이터 키가
 * 바뀔 때만. 보이는 동안 그린 대화는 읽음으로 표시한다. 단체방은 처음 열 때 최근 쪽을 요청하고, 위로 스크롤하면 한 쪽씩 더 받는다.
 */
export class ChatTab {
  readonly root: HTMLElement;
  private readonly filterBar: HTMLElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly invitesEl: HTMLElement;
  private readonly rowsEl: HTMLElement;
  private readonly listEmpty: HTMLElement;
  private readonly thread: HTMLElement;
  private readonly head: HTMLElement;
  private readonly body: HTMLElement;
  private readonly members: HTMLElement;
  private readonly threadEmpty: HTMLElement;
  private readonly inputRow: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly note: HTMLElement;
  private readonly pop: Popover;
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];
  private selected: string | null = null;
  private filter: ConvFilter = 'all';
  private listKey = '';
  private threadKey = '';
  /** Conversation the body was last painted for (scroll pinning). */
  private paintedConv: string | null = null;
  /** Oldest line time the body was last painted with (prepend detection). */
  private paintedOldest = 0;
  private membersOpen = false;
  private readonly historyRequested = new Set<string>();
  private historyPending: string | null = null;
  /** History length the last automatic older-page load fired at (see `renderRoom`). */
  private autoLoadLen = -1;
  private ask: HoldAskHandle | null = null;
  private acc = 0;
  /* ── 타이핑 연출 (2026-09-14 3차) ── `typingConv` 의 말풍선 중 앞에서 `typingShown` 개까지만 그린다. */
  private typingConv: string | null = null;
  private typingShown = 0;
  /** `window.setTimeout` 손잡이 (0 = 없음). */
  private typingTimer = 0;

  constructor(parent: HTMLElement, frame: HTMLElement, private readonly host: ChatTabHost) {
    this.root = el('div', { cls: 'ms-chat', parent });

    /* ── 좌 목록 ── */
    const side = el('div', { cls: 'ms-side', parent: this.root });
    const sh = el('div', { cls: 'ms-side-head', parent: side });
    el('span', { cls: 'ui-label', text: '대화', parent: sh });
    this.createBtn = el('button', { cls: 'ms-btn small', text: '＋ 방 만들기', parent: sh });
    this.createBtn.type = 'button';
    this.createBtn.dataset.act = 'create-room';
    this.createBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openCreateRoom(); });
    this.filterBar = el('div', { cls: 'ms-filters', parent: side });
    for (const f of FILTERS) {
      const b = el('button', { cls: `ms-filter${f.id === this.filter ? ' is-on' : ''}`, text: f.label, parent: this.filterBar });
      b.type = 'button';
      b.dataset.filter = f.id;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setFilter(f.id); });
    }
    this.invitesEl = el('div', { cls: 'ms-invites', parent: side });
    this.invitesEl.hidden = true;
    this.rowsEl = el('div', { cls: 'ms-rows', parent: side });
    this.rowsEl.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.listEmpty = el('div', { cls: 'ms-empty', text: '', parent: side });

    /* ── 가운데 대화 ── */
    this.thread = el('div', { cls: 'ms-thread is-empty', parent: this.root });
    this.head = el('div', { cls: 'ms-thead', parent: this.thread });
    const wrap = el('div', { cls: 'ms-tbody-wrap', parent: this.thread });
    this.body = el('div', { cls: 'ms-tbody', parent: wrap });
    this.body.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.body.addEventListener('scroll', () => { if (this.body.scrollTop < 40) this.loadOlder(); });
    this.members = el('div', { cls: 'ms-members', parent: wrap });
    this.members.hidden = true;
    this.members.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.threadEmpty = el('div', { cls: 'ms-thread-empty', text: '왼쪽 목록에서 대화를 고르세요', parent: this.thread });
    this.inputRow = el('div', { cls: 'ms-input-row', parent: this.thread });
    this.input = el('input', {
      cls: 'ms-input', attrs: { type: 'text', maxlength: String(SOCIAL_WHISPER_MAX), spellcheck: 'false', autocomplete: 'off' },
      parent: this.inputRow,
    });
    this.sendBtn = el('button', { cls: 'ms-btn primary ms-send', text: '보내기', parent: this.inputRow });
    this.sendBtn.type = 'button';
    this.sendBtn.addEventListener('click', (e) => { e.stopPropagation(); this.send(); });
    wireTextInput(this.input, {
      onEnter: () => this.send(),
      onEscape: () => { this.input.blur(); this.host.requestClose(); },
      onTab: () => this.host.requestClose(),
    });
    this.note = el('div', { cls: 'ms-note', text: '', parent: this.thread });

    this.pop = new Popover(frame);
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.pop.bind(ctx);
    const b = ctx.bus;
    const here = (key: string): void => { if (key === this.selected) this.renderThread(); };
    this.unsubs.push(
      b.on('npc:message', ({ npc }) => { this.refreshList(); here(`npc:${npc}`); }),
      b.on('npc:questChanged', ({ npc }) => here(`npc:${npc}`)),
      b.on('npc:objectiveProgress', () => { if (this.selected?.startsWith('npc:')) this.renderThread(); }),
      b.on('npc:unreadChanged', () => this.refreshList()),
      b.on('social:whisper', ({ line }) => { this.refreshList(); here(`pc:${line.code}`); }),
      b.on('social:whisperUpdated', ({ line }) => here(`pc:${line.code}`)),
      b.on('social:updated', () => { this.refreshList(); if (this.selected?.startsWith('pc:')) this.renderThread(); }),
      b.on('social:unreadChanged', () => this.refreshList()),
      b.on('room:updated', () => { this.refreshList(); if (this.selected?.startsWith('room:')) this.renderThread(); }),
      b.on('room:line', ({ line }) => { this.refreshList(); here(`room:${line.room}`); }),
      b.on('room:lineUpdated', ({ line }) => here(`room:${line.room}`)),
      b.on('room:history', ({ room }) => { if (this.historyPending === room) this.historyPending = null; here(`room:${room}`); }),
      b.on('room:invited', () => this.refreshList()),
      b.on('room:unreadChanged', () => this.refreshList()),
      b.on('room:error', ({ message }) => { if (this.host.isVisible()) ctx.bus.emit('ui:notify', { text: message, kind: 'warning', duration: 2.6 }); }),
    );
  }

  /* ── 공개 (메신저 · 스모크) ────────────────────────────────────────────── */

  get selectedKey(): string | null { return this.selected; }
  get filterId(): ConvFilter { return this.filter; }
  get popover(): Popover { return this.pop; }
  get isMembersOpen(): boolean { return this.membersOpen; }

  /** 대화 하나를 고른다 (`npc:<id>` · `pc:<code>` · `room:<id>`, null = 선택 없음). */
  select(key: string | null): void {
    const parsed = splitKey(key);
    this.selected = parsed ? key : null;
    this.flushTyping();
    this.membersOpen = false;
    this.pop.close();
    this.input.value = '';
    // a filter that hides the chosen conversation would leave it selected but invisible
    if (parsed && this.filter !== 'all' && this.filter !== parsed.kind) this.setFilter('all', false);
    if (parsed?.kind === 'room') this.ensureHistory(parsed.id);
    this.refreshList(true);
    this.renderThread(true);
  }

  setFilter(f: ConvFilter, repaint = true): void {
    this.filter = f;
    for (const b of this.filterBar.querySelectorAll<HTMLElement>('.ms-filter')) toggleClass(b, 'is-on', b.dataset.filter === f);
    if (repaint) this.refreshList(true);
  }

  /** 탭이 보이게 됐다 — 목록 · 대화를 새로 그리고(읽음 표시 포함) 입력칸에 초점. */
  onShow(): void {
    this.refreshList(true);
    this.renderThread(true);
  }

  onHide(): void {
    this.pop.close();
    this.ask?.close();
    this.ask = null;
    this.input.blur();
    this.flushTyping();
  }

  /** 보이는 동안 메신저가 매 프레임 부른다 — 4 Hz 로 데이터 키를 비교한다 (이벤트를 안 내는 디버그 ref 도 따라온다). */
  tick(dt: number): void {
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    this.refreshList();
    this.renderThread();
  }

  /* ── 목록 ──────────────────────────────────────────────────────────────── */

  private rows(): ConvRow[] {
    const ctx = this.ctx!;
    const out: ConvRow[] = [];
    const npc = npcOf(ctx);
    if (npc) {
      for (const c of npc.getContacts()) {
        /* 2026-09-14 3차 (사용자 결정): 줄에 남는 것은 **마지막 대사**다 — 퀘스트 제안이 마지막 사건이면
         * `[퀘스트] 이름` 대신 그 퀘스트의 `summary` 를 잘라 쓴다 (「레이븐이 새 거래 상대의 솜씨를…」). */
        const last = npc.getMessages(c.npc.id).at(-1);
        let preview = c.preview;
        if (last?.from === 'quest') {
          const q = npc.getQuest(last.questId);
          preview = q?.def.summary || q?.def.name || c.preview;
        } else if (last?.from === 'npc' || last?.from === 'system') preview = last.text;
        else if (last?.from === 'me') preview = `나: ${last.text}`;
        out.push({
          key: `npc:${c.npc.id}`, kind: 'npc', id: c.npc.id, title: c.npc.name, at: c.at, unread: c.unread,
          preview, glyph: c.npc.glyph || initialOf(c.npc.name), color: c.npc.color,
        });
      }
    }
    const social = socialOf(ctx);
    if (social?.available) {
      const seen = new Set<string>();
      for (const p of social.whisperPeers()) {
        if (social.isBlocked(p.code)) continue;
        seen.add(p.code);
        const friend = social.find(p.code);
        const last = social.whisperHistory(p.code).at(-1);
        const title = p.name || friend?.name || formatPlayerCode(p.code);
        out.push({
          key: `pc:${p.code}`, kind: 'pc', id: p.code, title, at: p.at,
          unread: social.whisperUnread?.(p.code) ?? 0,
          preview: last ? `${last.out ? '나: ' : ''}${last.text}` : '', glyph: initialOf(title), color: PC_COLOR,
          ...(friend ? { presence: friend.presence } : {}),
        });
      }
      for (const f of social.friends) {
        if (seen.has(f.code) || social.isBlocked(f.code)) continue;
        out.push({
          key: `pc:${f.code}`, kind: 'pc', id: f.code, title: f.name || formatPlayerCode(f.code), at: 0,
          unread: social.whisperUnread?.(f.code) ?? 0, preview: `친구 · ${PRESENCE_LABELS[f.presence]}`,
          glyph: initialOf(f.name), color: PC_COLOR, presence: f.presence,
        });
      }
    }
    const rooms = roomsOf(ctx);
    if (rooms?.available) {
      for (const r of rooms.rooms) {
        out.push({
          key: `room:${r.id}`, kind: 'room', id: r.id, title: r.name, at: r.lastAt,
          unread: rooms.unread(r.id), preview: r.lastText ?? '', glyph: '#', color: ROOM_COLOR,
        });
      }
    }
    out.sort((a, b) => (b.at - a.at)
      || ((a.presence ? PRESENCE_RANK[a.presence] : 9) - (b.presence ? PRESENCE_RANK[b.presence] : 9))
      || a.title.localeCompare(b.title, 'ko'));
    return out;
  }

  private refreshList(force = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const rows = this.rows();
    const rooms = roomsOf(ctx);
    const roomsOk = !!rooms?.available;
    const invites = roomsOk ? rooms!.invites : [];
    /* 2026-09-14 3차: 줄에 시각(`n분`)이 없어져 분 단위 재도색도 없앴다 — 키는 그린 것만 본다. */
    const key = [
      this.filter, this.selected ?? '', roomsOk ? 1 : 0,
      rows.map((r) => `${r.key}|${r.title}|${r.at}|${r.unread}|${r.preview}|${r.presence ?? ''}`).join(','),
      invites.map((i) => `${i.room}|${i.at}|${i.name}`).join(','),
    ].join('#');
    if (!force && key === this.listKey) return;
    this.listKey = key;

    this.createBtn.hidden = !roomsOk;
    for (const b of this.filterBar.querySelectorAll<HTMLElement>('.ms-filter')) {
      const f = b.dataset.filter as ConvFilter;
      const n = f === 'all' ? rows.reduce((s, r) => s + r.unread, 0) : rows.filter((r) => r.kind === f).reduce((s, r) => s + r.unread, 0);
      toggleClass(b, 'has-unread', n > 0);
      if (f === 'room') b.hidden = !roomsOk;
    }

    /* 받은 방 초대 */
    this.invitesEl.hidden = invites.length === 0;
    if (invites.length > 0) {
      const head = el('div', { cls: 'ms-invites-head ui-label', text: `받은 초대 ${invites.length}` });
      this.invitesEl.replaceChildren(head, ...invites.map((inv) => {
        const row = el('div', { cls: 'ms-inv-row' });
        row.dataset.room = inv.room;
        const av = el('span', { cls: 'ms-av', text: '#', parent: row });
        av.style.setProperty('--av', ROOM_COLOR);
        const main = el('span', { cls: 'ms-row-main', parent: row });
        el('span', { cls: 'ms-row-title', text: inv.name, parent: main });
        el('span', { cls: 'ms-row-prev', text: `${inv.fromName || formatPlayerCode(inv.from)} 님의 초대 · ${inv.members}명`, parent: main });
        const acts = el('span', { cls: 'ms-inv-acts', parent: row });
        const no = el('button', { cls: 'ms-btn small', text: '거절', parent: acts });
        no.type = 'button'; no.dataset.act = 'decline';
        const yes = el('button', { cls: 'ms-btn small primary', text: '수락', parent: acts });
        yes.type = 'button'; yes.dataset.act = 'accept';
        no.addEventListener('click', (e) => { e.stopPropagation(); roomsOf(ctx)?.respond(inv.room, false); });
        yes.addEventListener('click', (e) => { e.stopPropagation(); roomsOf(ctx)?.respond(inv.room, true); });
        return row;
      }));
    } else this.invitesEl.replaceChildren();

    const shown = this.filter === 'all' ? rows : rows.filter((r) => r.kind === this.filter);
    this.rowsEl.replaceChildren(...shown.map((r) => this.rowEl(r)));
    const social = socialOf(ctx);
    const emptyText = this.filter === 'npc' ? '아직 연락해 온 NPC 가 없습니다'
      : this.filter === 'room' ? '들어가 있는 단체방이 없습니다'
      : this.filter === 'pc' && !social?.available ? SOCIAL_UNAVAILABLE_KO
      : this.filter === 'pc' ? '친구가 없습니다 — 친구 탭에서 추가하세요'
      : '대화가 없습니다';
    setText(this.listEmpty, emptyText);
    this.listEmpty.hidden = shown.length > 0;
  }

  /**
   * 대화 목록의 한 줄 — **초상 + 이름 + 마지막 대사**뿐이다 (2026-09-14 3차, 사용자 결정).
   * 소속 라벨 · `n분` 시각 · 신뢰도 레벨 · 신뢰도 게이지는 여기서 전부 빠졌다 (신뢰도는 대화창 머리 초상의 고리가 말한다).
   */
  private rowEl(r: ConvRow): HTMLElement {
    const row = el('button', { cls: `ms-row kind-${r.kind}${r.key === this.selected ? ' is-sel' : ''}${r.unread > 0 ? ' has-unread' : ''}${r.presence === 'offline' ? ' is-offline' : ''}` });
    row.type = 'button';
    row.dataset.key = r.key;
    const av = el('span', { cls: `ms-av${r.presence ? ` pres-${r.presence}` : ''}`, text: r.glyph, parent: row });
    av.style.setProperty('--av', r.color);
    const main = el('span', { cls: 'ms-row-main', parent: row });
    const top = el('span', { cls: 'ms-row-top', parent: main });
    el('span', { cls: 'ms-row-title', text: r.title, parent: top });
    const bot = el('span', { cls: 'ms-row-bot', parent: main });
    el('span', { cls: 'ms-row-prev', text: clip(r.preview, 60), parent: bot });
    if (r.unread > 0) el('span', { cls: 'ms-unread ui-mono', text: r.unread > 99 ? '99+' : String(r.unread), parent: bot });
    row.addEventListener('click', (e) => { e.stopPropagation(); this.select(r.key); });
    return row;
  }

  /* ── 대화 ──────────────────────────────────────────────────────────────── */

  /** A cheap fingerprint of what the selected conversation would draw — equal → skip the repaint. */
  private threadDataKey(): string {
    const ctx = this.ctx!;
    const sel = splitKey(this.selected);
    if (!sel) return 'none';
    if (sel.kind === 'npc') {
      const npc = npcOf(ctx);
      if (!npc) return 'npc:none';
      const msgs = npc.getMessages(sel.id);
      const qs = msgs.map((m) => {
        if (m.from !== 'quest') return '';
        const q = npc.getQuest(m.questId);
        return q ? `${q.state}${q.ready ? 1 : 0}${q.blocked ?? ''}${q.objectives.map((o) => `${o.progress}${o.have ?? ''}`).join('.')}` : 'x';
      }).join(',');
      const c = npc.getContacts().find((x) => x.npc.id === sel.id);
      // 2026-09-14: 머리의 개인 신뢰도 게이지 · 대사 선택지 줄도 다시 그려야 하므로 지문에 넣는다
      return `npc|${msgs.length}|${msgs.at(-1)?.at ?? 0}|${qs}|${c?.unread ?? 0}|${npcTrustOf(ctx, sel.id)?.trust ?? ''}|${npc.getPendingChoices(sel.id).length}`;
    }
    if (sel.kind === 'pc') {
      const social = socialOf(ctx);
      if (!social) return 'pc:none';
      const lines = social.whisperHistory(sel.id);
      const f = social.find(sel.id);
      return `pc|${social.available}|${social.isBlocked(sel.id)}|${lines.length}|${lines.at(-1)?.at ?? 0}|${lines.map((l) => l.state ?? '').join('')}|${f?.presence ?? ''}|${f?.name ?? ''}|${social.whisperUnread?.(sel.id) ?? 0}`;
    }
    const rooms = roomsOf(ctx);
    if (!rooms) return 'room:none';
    const info = rooms.find(sel.id);
    const lines = rooms.history(sel.id);
    const members = info ? info.members.map((m) => `${m.code}${m.presence}`).join(',') + `/${info.pending.map((p) => p.code).join(',')}` : '';
    const blocked = socialOf(ctx);
    return `room|${rooms.available}|${info?.name ?? ''}|${info?.owner ?? ''}|${members}|${lines.length}|${lines[0]?.at ?? 0}|${lines.at(-1)?.at ?? 0}|${lines.map((l) => l.state ?? '').join('')}|${rooms.hasMore(sel.id)}|${this.membersOpen}|${this.historyPending === sel.id}|${rooms.unread(sel.id)}|${blocked?.blocked.length ?? 0}`;
  }

  private renderThread(force = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!force && !this.host.isVisible()) { this.threadKey = ''; this.flushTyping(); return; }
    const key = this.threadDataKey();
    if (!force && key === this.threadKey) return;
    this.threadKey = key;
    const sel = splitKey(this.selected);
    toggleClass(this.thread, 'is-empty', !sel);
    this.threadEmpty.hidden = !!sel;
    this.members.hidden = true;
    if (!sel) {
      this.head.replaceChildren();
      this.body.replaceChildren();
      this.inputRow.hidden = true;
      this.note.hidden = true;
      this.paintedConv = null;
      return;
    }
    this.thread.dataset.kind = sel.kind;
    if (sel.kind !== 'npc') this.flushTyping();
    if (sel.kind === 'npc') this.renderNpc(sel.id);
    else if (sel.kind === 'pc') this.renderPc(sel.id);
    else this.renderRoom(sel.id);
  }

  /* ── 타이핑 연출 (2026-09-14 3차, 사용자 결정) ─────────────────────────────
   * 새로 도착하는 NPC 말풍선만 한 줄씩 `...` 를 거쳐 붙는다 — 대화를 열 때 이미 있던 기록은 즉시 전부.
   * **갇히는 길을 만들지 않는다**: 대화를 바꾸거나 · 탭을 떠나거나 · 패널이 닫히면 큐를 버리고
   * 다음 그리기가 남은 말풍선을 전부 보여 준다 (`typingConv = null` → 「이 대화는 처음 그린다」). */

  /** 대기 중인 큐를 버리고 타이머를 정리한다. */
  private flushTyping(): void {
    if (this.typingTimer) { window.clearTimeout(this.typingTimer); this.typingTimer = 0; }
    this.typingConv = null;
    this.typingShown = 0;
  }

  /** 다음 말풍선을 `delay` 초 뒤에 연다 (0 = 다음 프레임 — 내 대답 · 시스템 줄은 기다리지 않는다). */
  private scheduleTyping(id: string, delay: number): void {
    if (this.typingTimer) return;
    this.typingTimer = window.setTimeout(() => {
      this.typingTimer = 0;
      if (this.typingConv !== id) return;
      this.typingShown++;
      this.renderThread(true);
    }, Math.round(Math.max(0, delay) * 1000));
  }

  /** `...` 말풍선 (점 셋이 순차로 커진다 — 애니메이션은 CSS). */
  private typingBubble(def: NpcDef | undefined, withAvatar: boolean): HTMLElement {
    const row = el('div', { cls: `ms-msg in typing${withAvatar ? '' : ' cont'}` });
    if (withAvatar) {
      const av = el('span', { cls: 'ms-av small', text: def?.glyph || initialOf(def?.name ?? '?'), parent: row });
      av.style.setProperty('--av', def?.color ?? PC_COLOR);
    }
    const bubble = el('div', { cls: 'ms-bubble ms-typing', parent: row });
    for (let i = 0; i < 3; i++) el('i', { parent: bubble });
    return row;
  }

  /** Swap the body's children, keeping the reader where they were (bottom-pinned, or anchored after an older page). */
  private paintBody(nodes: HTMLElement[], oldest: number): void {
    const b = this.body;
    const convChanged = this.paintedConv !== this.selected;
    const atBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 32;
    const prevH = b.scrollHeight;
    const prevTop = b.scrollTop;
    const prepended = !convChanged && oldest > 0 && this.paintedOldest > 0 && oldest < this.paintedOldest;
    b.replaceChildren(...nodes);
    if (prepended && !atBottom) b.scrollTop = prevTop + (b.scrollHeight - prevH);
    else if (convChanged || atBottom) b.scrollTop = b.scrollHeight;
    this.paintedConv = this.selected;
    this.paintedOldest = oldest;
  }

  private threadHead(glyph: string, color: string, title: string, sub: string, presence?: PresenceState): HTMLElement {
    const av = el('span', { cls: `ms-av big${presence ? ` pres-${presence}` : ''}`, text: glyph });
    av.style.setProperty('--av', color);
    return this.threadHeadWith(av, title, sub);
  }

  /** 머리줄을 이미 지은 초상으로 (NPC 는 신뢰도 고리를 두른 초상이다 — `Trust.buildNpcAvatar`). */
  private threadHeadWith(av: HTMLElement, title: string, sub: string): HTMLElement {
    const main = el('div', { cls: 'ms-thead-main' });
    el('div', { cls: 'ms-thead-title', text: title, parent: main });
    el('div', { cls: 'ms-thead-sub', text: sub, parent: main });
    this.head.replaceChildren(av, main);
    return main;
  }

  private timeDivider(at: number, prevAt: number, now: number): HTMLElement | null {
    if (at > 0 && (prevAt <= 0 || at - prevAt > TIME_GAP_MS)) return el('div', { cls: 'ms-time', text: clockText(at, now) });
    return null;
  }

  private setInput(mode: 'none' | 'on' | 'off', placeholder: string, note: string, max = SOCIAL_WHISPER_MAX): void {
    this.inputRow.hidden = mode === 'none';
    this.input.disabled = mode !== 'on';
    this.sendBtn.disabled = mode !== 'on';
    this.input.placeholder = placeholder;
    this.input.maxLength = max;
    setText(this.note, note);
    this.note.hidden = !note;
  }

  private renderNpc(id: string): void {
    const ctx = this.ctx!;
    const npc = npcOf(ctx);
    const contact = npc?.getContacts().find((c) => c.npc.id === id);
    const def: NpcDef | undefined = contact?.npc ?? NPC_DEF_MAP.get(id);
    const corp = def?.corp ? CORP_DEFS[def.corp]?.name ?? '' : '';
    const name = def?.name ?? id;
    const color = def?.color ?? PC_COLOR;
    /* 2026-09-14 3차 (사용자 결정): 초상이 신뢰도 고리 + 레벨 배지를 두르고, `bio` 한 줄은 빠졌다 (소개는 첫 연락 대사가 한다). */
    this.threadHeadWith(buildNpcAvatar(ctx, id, name, { glyph: def?.glyph || initialOf(name), color }), name,
      def ? [def.title, corp || NPC_ROLE_LABEL_KO[def.role]].filter(Boolean).join(' · ') : '');
    /* 레벨 · 신뢰도 현황은 머리줄의 **중앙 우측**에 선다 (초상 아래가 아니라). */
    const trustEl = buildNpcTrust(ctx, id, name, { color });
    if (trustEl) { trustEl.classList.add('in-right'); this.head.appendChild(trustEl); }

    /* 새로 도착한 말풍선은 `...` 를 거쳐 한 줄씩 붙는다 — 대화가 바뀌었으면(= 처음 그린다) 있는 것을 전부 즉시 보여 준다. */
    const all: readonly NpcMessage[] = npc?.getMessages(id) ?? [];
    if (this.typingConv !== id) {
      if (this.typingTimer) { window.clearTimeout(this.typingTimer); this.typingTimer = 0; }
      this.typingConv = id;
      this.typingShown = all.length;
    } else if (all.length < this.typingShown) this.typingShown = all.length;   // 기록이 줄었다 (초기화 · 다른 캐릭터)
    /* 내 대답 · 시스템 줄은 기다리지 않는다 — 같은 그리기에서 바로 붙인다 (기다리는 것은 NPC 말풍선 · 퀘스트 카드뿐). */
    while (this.typingShown < all.length) {
      const m = all[this.typingShown];
      if (m.from === 'npc' || m.from === 'quest') break;
      this.typingShown++;
    }
    const msgs = all.slice(0, this.typingShown);
    const now = Date.now();
    const nodes: HTMLElement[] = [];
    let prevAt = 0;
    let prevFrom = '';
    for (const m of msgs) {
      const div = this.timeDivider(m.at, prevAt, now);
      if (div) { nodes.push(div); prevFrom = ''; }
      prevAt = m.at;
      if (m.from === 'quest') {
        const q = npc?.getQuest(m.questId);
        const wrap = el('div', { cls: 'ms-msg in quest' });
        if (q) {
          wrap.appendChild(buildQuestCard(ctx, q, 'bubble', {
            accept: (qid) => { if (!npcOf(ctx)?.accept(qid)) this.deny('지금은 수락할 수 없습니다 — 함선에서만 가능합니다'); },
            openTab: (qid) => this.host.openQuest(qid),
          }));
        } else {
          el('div', { cls: 'ms-bubble sys', text: '더 이상 없는 퀘스트입니다', parent: wrap });
        }
        nodes.push(wrap);
        prevFrom = 'quest';
        continue;
      }
      if (m.from === 'system') {
        nodes.push(el('div', { cls: 'ms-msg sys', text: m.text }));
        prevFrom = 'system';
        continue;
      }
      const inbound = m.from === 'npc';
      const row = el('div', { cls: `ms-msg ${inbound ? 'in' : 'out'}${prevFrom === m.from ? ' cont' : ''}` });
      if (inbound && prevFrom !== 'npc') {
        const av = el('span', { cls: 'ms-av small', text: def?.glyph || initialOf(def?.name ?? '?'), parent: row });
        av.style.setProperty('--av', def?.color ?? PC_COLOR);
      }
      el('div', { cls: 'ms-bubble', text: m.text, parent: row });
      nodes.push(row);
      prevFrom = m.from;
    }
    if (all.length === 0) nodes.push(el('div', { cls: 'ms-msg sys', text: npc ? '아직 받은 메시지가 없습니다' : '퀘스트 정보를 불러올 수 없습니다' }));
    /* 아직 안 푼 말풍선이 있으면(= NPC 말풍선 · 퀘스트 카드) 그 자리에 `...` 를 세우고 다음 줄을 예약한다. */
    const pending = all[this.typingShown];
    if (pending) {
      nodes.push(this.typingBubble(def, prevFrom !== 'npc' && prevFrom !== 'quest'));
      const text = pending.from === 'quest' ? npc?.getQuest(pending.questId)?.def.summary ?? ''
        : pending.from === 'npc' ? pending.text : '';
      this.scheduleTyping(id, Math.min(TYPE_MAX_S, Math.max(TYPE_MIN_S, text.length * TYPE_S_PER_CHAR)));
    }
    /* 2026-09-14 (튜토리얼 개편 — `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」): 첫 연락의 **대사 선택지**.
     * 아직 대답하지 않았으면 말풍선 아래에 내 대답 버튼 줄이 선다 — 퀘스트 카드의 [수락] 과 같은
     * 문법(`ms-btn`)이다. 고르면 `choice` 사건이 하나 붙어 내 대답 + NPC 의 답 두 줄이 대화에 들어오고
     * `getPendingChoices` 가 빈 배열이 되어 줄이 사라진다. 고르기 전에 닫고 나가도 다시 열면 그대로 있다.
     * 아직 타이핑 중인 말풍선이 남아 있으면 그것부터 다 붙은 뒤에 보인다. */
    const choices = pending ? [] : npc?.getPendingChoices(id) ?? [];
    if (choices.length > 0) {
      const row = el('div', { cls: 'ms-msg out choices' });
      const box = el('div', { cls: 'ms-choices', parent: row });
      choices.forEach((label, i) => {
        const b = el('button', { cls: 'ms-btn ms-choice', text: label, parent: box });
        b.type = 'button';
        b.dataset.act = 'choice';
        b.dataset.choice = String(i);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!npcOf(ctx)?.chooseIntro(id, i)) this.deny('지금은 답할 수 없습니다');
        });
      });
      nodes.push(row);
    }
    this.paintBody(nodes, msgs[0]?.at ?? 0);
    /* 2026-09-14 3차: 하단 안내(`NPC 에게는 퀘스트 카드로 답합니다`) 제거 — 카드와 선택지가 스스로 말한다. */
    this.setInput('none', '', '');
    if (npc && contact && contact.unread > 0 && this.host.isVisible()) npc.markRead(id);
  }

  private renderPc(code: PlayerCode): void {
    const ctx = this.ctx!;
    const social = socialOf(ctx);
    const friend = social?.find(code);
    const lines = social?.whisperHistory(code) ?? [];
    const name = friend?.name || lines.at(-1)?.name || social?.whisperPeers().find((p) => p.code === code)?.name || formatPlayerCode(code);
    const blocked = !!social?.isBlocked(code);
    const bits = [formatPlayerCode(code)];
    if (friend) bits.push(`친구 · ${PRESENCE_LABELS[friend.presence]}`);
    if (friend && friend.level > 0) bits.push(`Lv. ${friend.level}`);
    this.threadHead(initialOf(name), PC_COLOR, name, `${PRIVATE_CHAT_LABEL_KO} · ${bits.join(' · ')}`, friend?.presence);

    const now = Date.now();
    const nodes: HTMLElement[] = [];
    let prevAt = 0;
    let prevOut: boolean | null = null;
    for (const l of lines) {
      const div = this.timeDivider(l.at, prevAt, now);
      if (div) { nodes.push(div); prevOut = null; }
      prevAt = l.at;
      const mod = whisperStateClass(l);
      const row = el('div', { cls: `ms-msg ${l.out ? 'out' : 'in'}${prevOut === l.out ? ' cont' : ''}${mod ? ` ${mod}` : ''}` });
      if (!l.out && prevOut !== false) {
        const av = el('span', { cls: 'ms-av small', text: initialOf(name), parent: row });
        av.style.setProperty('--av', PC_COLOR);
      }
      el('div', { cls: 'ms-bubble', text: l.text, parent: row });
      const st = whisperStateText(l);
      if (st) el('div', { cls: 'ms-state', text: st, parent: row });
      nodes.push(row);
      prevOut = l.out;
    }
    if (lines.length === 0) nodes.push(el('div', { cls: 'ms-msg sys', text: `주고받은 ${PRIVATE_CHAT_LABEL_KO}가 없습니다` }));
    this.paintBody(nodes, lines[0]?.at ?? 0);
    if (!social?.available) this.setInput('off', `${PRIVATE_CHAT_LABEL_KO} 입력…`, SOCIAL_UNAVAILABLE_KO);
    else if (blocked) this.setInput('off', `${PRIVATE_CHAT_LABEL_KO} 입력…`, '차단한 상대입니다 — 친구 탭의 차단 목록에서 해제할 수 있습니다');
    else this.setInput('on', `${PRIVATE_CHAT_LABEL_KO} 입력… (Enter 전송)`, '', SOCIAL_WHISPER_MAX);
    if (social && (social.whisperUnread?.(code) ?? 0) > 0 && this.host.isVisible()) social.markWhisperRead?.(code);
  }

  private renderRoom(roomId: string): void {
    const ctx = this.ctx!;
    const rooms = roomsOf(ctx);
    const social = socialOf(ctx);
    const info = rooms?.find(roomId);
    if (!rooms || !info) {
      this.threadHead('#', ROOM_COLOR, '단체방', rooms?.available ? '방을 찾을 수 없습니다 — 나갔거나 사라진 방입니다' : '서버에 연결되어야 단체방을 쓸 수 있습니다');
      this.paintBody([], 0);
      this.setInput('none', '', '');
      return;
    }
    const me = social?.me?.code ?? null;
    const isOwner = !!me && info.owner === me;
    const main = this.threadHead('#', ROOM_COLOR, info.name, `단체방 · 멤버 ${info.members.length}/${ROOM_MEMBER_MAX}${isOwner ? ' · 내가 방장' : ''}`);
    const acts = el('div', { cls: 'ms-thead-acts' });
    this.head.appendChild(acts);
    void main;
    const act = (label: string, id: string, run: () => void, kind = ''): HTMLButtonElement => {
      const b = el('button', { cls: `ms-btn small${kind ? ` ${kind}` : ''}`, text: label, parent: acts });
      b.type = 'button';
      b.dataset.act = id;
      b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
      return b;
    };
    const mb = act(`멤버 ${info.members.length}`, 'members', () => { this.membersOpen = !this.membersOpen; this.renderThread(true); });
    toggleClass(mb, 'is-on', this.membersOpen);
    if (isOwner) {
      act('초대', 'invite', () => this.openInvite(roomId));
      act('이름 변경', 'rename', () => this.openRename(roomId));
    }
    act('나가기', 'leave', () => this.askLeave(roomId), 'danger');

    const all: readonly RoomLine[] = rooms.history(roomId);
    const now = Date.now();
    const nodes: HTMLElement[] = [];
    if (rooms.hasMore(roomId)) {
      nodes.push(el('div', { cls: 'ms-more', text: this.historyPending === roomId ? '이전 대화를 불러오는 중…' : '위로 스크롤하면 이전 대화를 불러옵니다' }));
    }
    let prevAt = 0;
    let prevCode: string | null = null;
    for (const l of all) {
      if (!l.system && social?.isBlocked(l.code)) continue;   // hide what a blocked player says (their system lines stay)
      const div = this.timeDivider(l.at, prevAt, now);
      if (div) { nodes.push(div); prevCode = null; }
      prevAt = l.at;
      if (l.system) {
        nodes.push(el('div', { cls: 'ms-msg sys', text: roomSystemText(l) }));
        prevCode = null;
        continue;
      }
      const out = !!me && l.code === me;
      const state = l.state === 'pending' || l.state === 'failed' ? l.state : '';
      const row = el('div', { cls: `ms-msg ${out ? 'out' : 'in'}${prevCode === l.code ? ' cont' : ''}${state ? ` ${state}` : ''}` });
      if (!out && prevCode !== l.code) {
        el('div', { cls: 'ms-who', text: l.name || formatPlayerCode(l.code), parent: row });
      }
      el('div', { cls: 'ms-bubble', text: l.text, parent: row });
      if (state === 'pending') el('div', { cls: 'ms-state', text: '전송 중…', parent: row });
      else if (state === 'failed') el('div', { cls: 'ms-state', text: '전송 실패', parent: row });
      nodes.push(row);
      prevCode = l.code;
    }
    if (all.length === 0) nodes.push(el('div', { cls: 'ms-msg sys', text: this.historyPending === roomId ? '대화를 불러오는 중…' : '아직 대화가 없습니다' }));
    this.paintBody(nodes, all[0]?.at ?? 0);
    /* A page too short to scroll can never fire the scroll-up load — keep pulling older pages until it overflows (once per
       history length, so a server that answers `more` with nothing cannot spin this). */
    if (rooms.available && rooms.hasMore(roomId) && this.historyPending !== roomId
      && this.body.scrollHeight <= this.body.clientHeight + 4 && this.autoLoadLen !== all.length) {
      this.autoLoadLen = all.length;
      window.setTimeout(() => this.loadOlder(), 0);
    }

    /* 멤버 서랍 */
    this.members.hidden = !this.membersOpen;
    if (this.membersOpen) {
      const list: HTMLElement[] = [el('div', { cls: 'ms-members-head ui-label', text: `멤버 ${info.members.length}/${ROOM_MEMBER_MAX}` })];
      for (const m of info.members) {
        const row = el('div', { cls: `ms-member pres-${m.presence}${m.code === info.owner ? ' is-owner' : ''}` });
        row.dataset.code = m.code;
        const av = el('span', { cls: `ms-av small pres-${m.presence}`, text: initialOf(m.name), parent: row });
        av.style.setProperty('--av', PC_COLOR);
        const mm = el('span', { cls: 'ms-member-main', parent: row });
        el('span', { cls: 'ms-member-name', text: `${m.code === info.owner ? '★ ' : ''}${m.name || formatPlayerCode(m.code)}${m.code === me ? ' (나)' : ''}`, parent: mm });
        el('span', { cls: 'ms-member-sub', text: PRESENCE_LABELS[m.presence], parent: mm });
        if (isOwner && m.code !== me) {
          const k = el('button', { cls: 'ms-btn small danger', text: '내보내기', parent: row });
          k.type = 'button';
          k.dataset.act = 'kick';
          k.addEventListener('click', (e) => { e.stopPropagation(); this.askKick(roomId, m.code, m.name || formatPlayerCode(m.code)); });
        }
        list.push(row);
      }
      if (info.pending.length > 0) {
        list.push(el('div', { cls: 'ms-members-head ui-label', text: `초대 중 ${info.pending.length}` }));
        for (const p of info.pending) {
          const row = el('div', { cls: 'ms-member is-pending' });
          row.dataset.code = p.code;
          el('span', { cls: 'ms-member-name', text: p.name || formatPlayerCode(p.code), parent: row });
        }
      }
      this.members.replaceChildren(...list);
    }

    if (!rooms.available) this.setInput('off', '단체방에 입력…', '서버에 연결되어야 단체방을 쓸 수 있습니다', ROOM_TEXT_MAX);
    else this.setInput('on', '단체방에 입력… (Enter 전송)', '', ROOM_TEXT_MAX);
    if (rooms.unread(roomId) > 0 && this.host.isVisible()) rooms.markRead(roomId);
  }

  private ensureHistory(roomId: string): void {
    const rooms = this.ctx ? roomsOf(this.ctx) : null;
    if (!rooms?.available || this.historyRequested.has(roomId)) return;
    this.historyRequested.add(roomId);
    this.historyPending = roomId;
    rooms.requestHistory(roomId);
  }

  private loadOlder(): void {
    const sel = splitKey(this.selected);
    const rooms = this.ctx ? roomsOf(this.ctx) : null;
    if (sel?.kind !== 'room' || !rooms?.available || this.historyPending === sel.id || !rooms.hasMore(sel.id)) return;
    const oldest = rooms.history(sel.id)[0]?.at;
    this.historyPending = sel.id;
    rooms.requestHistory(sel.id, oldest);
    this.renderThread(true);
  }

  private send(): void {
    const ctx = this.ctx;
    const sel = splitKey(this.selected);
    if (!ctx || !sel || this.input.disabled) return;
    const text = this.input.value.trim();
    if (!text) return;
    if (sel.kind === 'pc') {
      if (!socialOf(ctx)?.whisper(sel.id, text.slice(0, SOCIAL_WHISPER_MAX))) {
        this.deny(`${PRIVATE_CHAT_LABEL_KO}를 보낼 수 없습니다 — 서버 연결을 확인하세요`);
        return;
      }
    } else if (sel.kind === 'room') {
      if (!roomsOf(ctx)?.say(sel.id, text.slice(0, ROOM_TEXT_MAX))) {
        this.deny('단체방에 보낼 수 없습니다 — 서버 연결을 확인하세요');
        return;
      }
    } else return;
    this.input.value = '';
    this.input.focus({ preventScroll: true });
    this.renderThread(true);
  }

  private deny(text: string): void {
    this.ctx?.bus.emit('ui:notify', { text, kind: 'warning', duration: 2.8 });
    this.ctx?.bus.emit('audio:play', { id: 'ui_deny' });
  }

  /* ── 팝오버 · 확인 ─────────────────────────────────────────────────────── */

  private friendPicker(parent: HTMLElement, exclude: ReadonlySet<string>, onPick: (code: PlayerCode, row: HTMLElement) => void): number {
    const ctx = this.ctx!;
    const social = socialOf(ctx);
    const friends = [...(social?.friends ?? [])]
      .filter((f) => !exclude.has(f.code) && !social?.isBlocked(f.code))
      .sort((a, b) => PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence] || a.name.localeCompare(b.name, 'ko'));
    const list = el('div', { cls: 'ms-pop-list', parent });
    list.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    for (const f of friends) {
      const row = el('button', { cls: `ms-pick pres-${f.presence}`, parent: list });
      row.type = 'button';
      row.dataset.code = f.code;
      const av = el('span', { cls: `ms-av small pres-${f.presence}`, text: initialOf(f.name), parent: row });
      av.style.setProperty('--av', PC_COLOR);
      el('span', { cls: 'ms-pick-name', text: f.name || formatPlayerCode(f.code), parent: row });
      el('span', { cls: 'ms-pick-sub', text: PRESENCE_LABELS[f.presence], parent: row });
      row.addEventListener('click', (e) => { e.stopPropagation(); onPick(f.code, row); });
    }
    if (friends.length === 0) el('div', { cls: 'ms-empty', text: '초대할 수 있는 친구가 없습니다', parent: list });
    return friends.length;
  }

  private openCreateRoom(): void {
    const ctx = this.ctx;
    const rooms = ctx ? roomsOf(ctx) : null;
    if (!ctx || !rooms?.available) { this.deny('서버에 연결되어야 단체방을 만들 수 있습니다'); return; }
    this.pop.open('create', '단체방 만들기', (body) => {
      const name = el('input', {
        cls: 'ms-pop-input', attrs: { type: 'text', maxlength: String(ROOM_NAME_MAX), placeholder: '방 이름', spellcheck: 'false', autocomplete: 'off' },
        parent: body,
      });
      el('div', { cls: 'ms-pop-label', text: `함께 초대할 친구 (최대 ${ROOM_MEMBER_MAX - 1}명)`, parent: body });
      const picked = new Set<PlayerCode>();
      this.friendPicker(body, new Set(), (code, row) => {
        if (picked.has(code)) picked.delete(code);
        else if (picked.size < ROOM_MEMBER_MAX - 1) picked.add(code);
        toggleClass(row, 'is-on', picked.has(code));
      });
      const foot = el('div', { cls: 'ms-pop-foot', parent: body });
      const go = el('button', { cls: 'ms-btn primary', text: '만들기', parent: foot });
      go.type = 'button';
      go.dataset.act = 'create';
      const create = (): void => {
        const me = socialOf(ctx)?.me?.name || '나';
        const n = (name.value.trim() || `${me}의 방`).slice(0, ROOM_NAME_MAX);
        if (roomsOf(ctx)?.create(n, [...picked])) this.pop.close();
        else this.deny('단체방을 만들 수 없습니다 — 서버 연결을 확인하세요');
      };
      go.addEventListener('click', (e) => { e.stopPropagation(); create(); });
      wireTextInput(name, { onEnter: create, onEscape: () => this.pop.close(), onTab: () => this.host.requestClose() });
      window.setTimeout(() => name.focus({ preventScroll: true }), 0);
    });
  }

  private openInvite(roomId: string): void {
    const ctx = this.ctx;
    const rooms = ctx ? roomsOf(ctx) : null;
    const info = rooms?.find(roomId);
    if (!ctx || !rooms || !info) return;
    const exclude = new Set<string>([...info.members.map((m) => m.code), ...info.pending.map((p) => p.code)]);
    this.pop.open('invite', `「${info.name}」 에 친구 초대`, (body) => {
      const room = info.members.length + info.pending.length;
      el('div', { cls: 'ms-pop-label', text: `멤버 ${info.members.length} · 초대 중 ${info.pending.length} · 최대 ${ROOM_MEMBER_MAX}명`, parent: body });
      this.friendPicker(body, exclude, (code, row) => {
        if (row.classList.contains('is-on')) return;
        if (room >= ROOM_MEMBER_MAX) { this.deny('방이 가득 찼습니다'); return; }
        roomsOf(ctx)?.invite(roomId, code);
        row.classList.add('is-on');
        const sub = row.querySelector('.ms-pick-sub');
        if (sub) sub.textContent = '초대함';
      });
    });
  }

  private openRename(roomId: string): void {
    const ctx = this.ctx;
    const info = ctx ? roomsOf(ctx)?.find(roomId) : undefined;
    if (!ctx || !info) return;
    this.pop.open('rename', '방 이름 변경', (body) => {
      const input = el('input', {
        cls: 'ms-pop-input', attrs: { type: 'text', maxlength: String(ROOM_NAME_MAX), spellcheck: 'false', autocomplete: 'off' }, parent: body,
      });
      input.value = info.name;
      const foot = el('div', { cls: 'ms-pop-foot', parent: body });
      const ok = el('button', { cls: 'ms-btn primary', text: '변경', parent: foot });
      ok.type = 'button';
      ok.dataset.act = 'rename-ok';
      const apply = (): void => {
        const n = input.value.trim().slice(0, ROOM_NAME_MAX);
        if (!n) return;
        if (n !== info.name) roomsOf(ctx)?.rename(roomId, n);
        this.pop.close();
      };
      ok.addEventListener('click', (e) => { e.stopPropagation(); apply(); });
      wireTextInput(input, { onEnter: apply, onEscape: () => this.pop.close(), onTab: () => this.host.requestClose() });
      window.setTimeout(() => { input.focus({ preventScroll: true }); input.select(); }, 0);
    });
  }

  /** 나가기 = 되돌릴 수 없는 확정 → 1초 홀드 (루트 CLAUDE.md 「되돌릴 수 없는 확정은 1초 홀드다」). */
  private askLeave(roomId: string): void {
    const ctx = this.ctx;
    const info = ctx ? roomsOf(ctx)?.find(roomId) : undefined;
    if (!ctx || !info) return;
    this.pop.close();
    this.ask?.close();
    this.ask = openHoldAsk(ctx, {
      id: 'room-leave',
      title: '단체방 나가기',
      danger: true,
      body: `「${info.name}」 방에서 나갑니다.\n다시 들어가려면 방장의 초대를 받아야 합니다.`,
      buttons: [
        { label: '취소', cancel: true },
        {
          label: '나가기', kind: 'danger', hold: true,
          run: () => {
            roomsOf(ctx)?.leave(roomId);
            if (this.selected === `room:${roomId}`) this.select(null);
          },
        },
      ],
    });
  }

  /** 내보내기는 다시 초대하면 되돌릴 수 있다 — 한 번의 확인 (홀드 없음). */
  private askKick(roomId: string, code: PlayerCode, name: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.ask?.close();
    this.ask = openHoldAsk(ctx, {
      id: 'room-kick',
      title: '멤버 내보내기',
      body: `${name} 님을 방에서 내보냅니다.`,
      buttons: [
        { label: '취소', cancel: true },
        { label: '내보내기', kind: 'danger', run: () => roomsOf(ctx)?.kick(roomId, code) },
      ],
    });
  }

  /** The room drawer's info (smoke). */
  roomInfo(roomId: string): RoomInfo | undefined { return this.ctx ? roomsOf(this.ctx)?.find(roomId) : undefined; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.flushTyping();
    this.ask?.close();
    this.pop.dispose();
    this.root.remove();
  }
}
