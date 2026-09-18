import type {
  GameContext, HoldAskHandle, NpcDef, NpcMessage, NpcQuestRef, PlayerCode, PresenceState, RoomInfo, RoomLine,
} from '@/shared';
import {
  CORP_DEFS, MESSENGER_CHOICE_DELAY_S, NPC_DEF_MAP, NPC_ROLE_LABEL_KO, PRESENCE_LABELS, PRIVATE_CHAT_LABEL_KO, ROOM_MEMBER_MAX, ROOM_NAME_MAX,
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

/** Avatar colour — `NpcDef.color` for an NPC, a fixed colour for players · group rooms. */
const PC_COLOR = '#9fb4cc';
const ROOM_COLOR = '#b69cff';
/** Bubbles further apart than this get a time divider between them. */
const TIME_GAP_MS = 10 * 60_000;
/**
 * The typing reveal (2026-09-14 3rd pass, user's decision) — every **newly arriving** NPC bubble shows `...` for this long.
 * These are **UI timing**, not game balance, so they live in the messenger folder instead of `data/`.
 */
const TYPE_S_PER_CHAR = 0.028;
const TYPE_MIN_S = 0.5;
const TYPE_MAX_S = 2.0;
/**
 * 2026-09-15 (user's decision — 「확인해야 다음 메시지가 온다」): the unread bubbles piled up arrive one by one too when a
 * conversation is **opened for the first time**. Unrolling a long-unread conversation whole would mean waiting
 * `TYPE_MAX_S × line count`, so only this many from the end are typed out and everything before them is drawn at once (worst case `6 × 2 s`).
 */
const TYPE_BACKLOG_MAX = 6;
/**
 * The three dots of the typing `...` (2026-09-17, user's decision — 「점 3개가 서로 천천히 부드럽게 작아졌다가 커졌다가」). One
 * dot's whole shrink-and-grow period (ms), the offset between the dots (ms), and the scale · opacity at its smallest. The
 * same UI timing as the `TYPE_*` above. Why Web Animations instead of CSS `@keyframes`: the `typingBubble` comment.
 */
const TYPE_DOT_PERIOD_MS = 1400;
const TYPE_DOT_STAGGER_MS = 220;
const TYPE_DOT_MIN_SCALE = 0.45;
const TYPE_DOT_MIN_OPACITY = 0.35;
const PRESENCE_RANK: Readonly<Record<PresenceState, number>> = { ship: 0, training: 1, raid: 2, offline: 3 };

const FILTERS: readonly { id: ConvFilter; label: string }[] = [
  { id: 'all', label: '전체' }, { id: 'npc', label: 'NPC' }, { id: 'pc', label: PRIVATE_CHAT_LABEL_KO }, { id: 'room', label: '단체방' },
];

export interface ChatTabHost {
  /** Tab in the text field — closes the whole messenger (the universal close). */
  requestClose(): void;
  /** The bubble quest card's 「퀘스트 탭에서 보기」. */
  openQuest(id: string): void;
  /** Whether the `대화` tab is on screen right now (panel open ∧ tab = `대화`) — asked before marking as read. */
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
 * The messenger's `대화` tab (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *
 * Left list = NPC contacts (`ctx.meta.npc`) · private chat partners (friends + `whisperPeers`) · group rooms (`ctx.net.rooms`) mixed
 * into one row list **ordered by the most recent last message** (the filter chips narrow it). Above them the received room
 * invites (accept · decline) and 「방 만들기」.
 * **A row holds the avatar · the name · the last line and nothing else** (2026-09-14 3rd pass, user's decision — the affiliation label · `n분` · the trust gauge were dropped).
 * Centre = the chosen conversation's bubbles. An NPC is answered by quest cards alone with no text field, a private chat goes
 * through `SocialRef.whisper` (the same history as the chat window), a group room through `RoomsRef.say` — group rooms travel **inside the messenger only** (no chat-window link, user's decision).
 *
 * Repainting: the list only when the key built from the data changed (bus events + 4 Hz polling), the conversation only when an
 * event touching the chosen conversation arrives or the data key changed. A conversation drawn while visible is marked read. A
 * group room asks for its most recent page when first opened and one page more per scroll to the top.
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
  /* ── The typing reveal (2026-09-14 3rd pass) ── only the first `typingShown` of `typingConv`’s bubbles are drawn. */
  private typingConv: string | null = null;
  private typingShown = 0;
  /** The `window.setTimeout` handle (0 = none). */
  private typingTimer = 0;
  /* ── The choice delay (2026-09-17) ── the conversation whose choices may be drawn (`MESSENGER_CHOICE_DELAY_S` has passed) and its timer. */
  private choiceReadyConv: string | null = null;
  private choiceTimer = 0;
  /** The empty tail behind the bubbles (half the conversation window's height — `paintBody`). Always the body's last child. */
  private readonly tail: HTMLElement;

  constructor(parent: HTMLElement, frame: HTMLElement, private readonly host: ChatTabHost) {
    this.root = el('div', { cls: 'ms-chat', parent });

    /* ── Left list ── */
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

    /* ── Centre conversation ── */
    this.thread = el('div', { cls: 'ms-thread is-empty', parent: this.root });
    this.head = el('div', { cls: 'ms-thead', parent: this.thread });
    const wrap = el('div', { cls: 'ms-tbody-wrap', parent: this.thread });
    this.body = el('div', { cls: 'ms-tbody', parent: wrap });
    this.body.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.body.addEventListener('scroll', () => { if (this.body.scrollTop < 40) this.loadOlder(); });
    this.tail = el('div', { cls: 'ms-tail', attrs: { 'aria-hidden': 'true' } });
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

  /* ── Public (messenger · smoke) ────────────────────────────────────────── */

  get selectedKey(): string | null { return this.selected; }
  get filterId(): ConvFilter { return this.filter; }
  get popover(): Popover { return this.pop; }
  get isMembersOpen(): boolean { return this.membersOpen; }

  /** Selects one conversation (`npc:<id>` · `pc:<code>` · `room:<id>`, null = nothing selected). */
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

  /** The tab became visible — repaints the list · the conversation (marking read included) and focuses the text field. */
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

  /** Called by the messenger every frame while visible — compares the data key at 4 Hz (a debug ref that emits no events follows along too). */
  tick(dt: number): void {
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    this.refreshList();
    this.renderThread();
  }

  /* ── The list ──────────────────────────────────────────────────────────── */

  private rows(): ConvRow[] {
    const ctx = this.ctx!;
    const out: ConvRow[] = [];
    const npc = npcOf(ctx);
    if (npc) {
      for (const c of npc.getContacts()) {
        /* 2026-09-14 3rd pass (user's decision): what stays in the row is the **last line** — when a quest offer was the
         * last event, the quest's `summary` is clipped in instead of `[퀘스트] 이름` (「레이븐이 새 거래 상대의 솜씨를…」).
         * 「Last」 is not the end of the whole history but the end of the **bubbles that actually arrived in the conversation**
         * (`deliveredCount`) — reading the end of the history would put the line still unrolling through `...` in the list first.
         * With nothing arrived yet (a first contact never opened) no line is previewed and the bio (`bio`) stands there. */
        const all = npc.getMessages(c.npc.id);
        const last = all[this.deliveredCount(npc, c.npc.id, all) - 1];
        let preview = c.npc.bio;
        if (last?.from === 'quest') {
          const q = npc.getQuest(last.questId);
          preview = q?.def.summary || q?.def.name || preview;
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
    /* 2026-09-14 3rd pass: with no time (`n분`) in the row the per-minute repaint went too — the key looks only at what is drawn. */
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

    /* Received room invites */
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
   * One row of the conversation list — **avatar + name + last line** and nothing else (2026-09-14 3rd pass, user's decision).
   * The affiliation label · the `n분` time · the trust level · the trust gauge all left here (trust is told by the ring around the avatar in the conversation head).
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

  /* ── The conversation ──────────────────────────────────────────────────── */

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
      // 2026-09-14: the head's personal trust gauge · the line-choice row must repaint too, so they go into the fingerprint
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

  /* ── The typing reveal (2026-09-14 3rd pass, user's decision) ──────────────
   * Only newly arriving NPC bubbles land one line at a time through `...` — history already there when the conversation opens
   * appears at once. **No path may trap it**: changing conversation · leaving the tab · closing the panel drops the
   * queue and the next paint shows every remaining bubble (`typingConv = null` → 「this conversation is drawn for the first time」). */

  /** Drops the waiting queue and clears the timer. */
  private flushTyping(): void {
    if (this.typingTimer) { window.clearTimeout(this.typingTimer); this.typingTimer = 0; }
    this.typingConv = null;
    this.typingShown = 0;
    this.clearChoiceGate();
  }

  /** Puts the choice delay back to the start (the timer released + 「not yet」). */
  private clearChoiceGate(): void {
    if (this.choiceTimer) { window.clearTimeout(this.choiceTimer); this.choiceTimer = 0; }
    this.choiceReadyConv = null;
  }

  /**
   * 2026-09-17 (user's decision): the choices stand `MESSENGER_CHOICE_DELAY_S` after the NPC's last bubble landed. A timer
   * already running is never raised again (so the 4 Hz repaint cannot keep pushing the delay back). A changed conversation (`flushTyping`) is thrown away timer and all.
   */
  private scheduleChoices(id: string): void {
    if (this.choiceTimer) return;
    this.choiceTimer = window.setTimeout(() => {
      this.choiceTimer = 0;
      if (this.typingConv !== id) return;
      this.choiceReadyConv = id;
      this.renderThread(true);
    }, Math.round(Math.max(0, MESSENGER_CHOICE_DELAY_S) * 1000));
  }

  /** Opens the next bubble `delay` seconds later (0 = the next frame — my own answers · system lines never wait). */
  private scheduleTyping(id: string, delay: number): void {
    if (this.typingTimer) return;
    this.typingTimer = window.setTimeout(() => {
      this.typingTimer = 0;
      if (this.typingConv !== id) return;
      this.typingShown++;
      this.renderThread(true);
      this.refreshList();   // the list preview follows the line that just arrived too (`deliveredCount`)
    }, Math.round(Math.max(0, delay) * 1000));
  }

  /**
   * The **number of bubbles that arrived in (= are · will be drawn in) the conversation** of that NPC — the definition of
   * 「arrived」 the list preview uses. `typingShown` for the conversation being typed out right now, otherwise the number
   * opening it now would draw at once (`readShownCount`). Both include, like `renderNpc`, the my-answer · system lines that follow, without waiting for them.
   */
  private deliveredCount(npc: NpcQuestRef, id: string, all: readonly NpcMessage[]): number {
    let n = this.typingConv === id ? Math.min(this.typingShown, all.length) : this.readShownCount(npc, id, all);
    while (n < all.length && all[n].from !== 'npc' && all[n].from !== 'quest') n++;
    return n;
  }

  /**
   * The number of bubbles shown at once when a conversation is **drawn for the first time** = 「what was already read」 (2026-09-15, user's decision).
   *
   * The boundary is `NpcQuestRef.readAtOf(id)` alone — one event unrolls into several bubbles (one `intro` line → all of `NpcDef.intro`),
   * so `NpcContactInfo.unread` (a count of events) cannot count them, but bubbles out of the same event share an `at`, so this one time splits them exactly.
   * **It must be asked before `markRead`** — `renderNpc` marks read only after it has drawn everything.
   *
   * A source without that query (the smoke's debug ref · the old implementation) counts **everything as read** and draws it all at once, as before.
   */
  private readShownCount(npc: NpcQuestRef | null, id: string, all: readonly NpcMessage[]): number {
    if (!npc || typeof npc.readAtOf !== 'function') return all.length;
    let readAt = 0;
    try { readAt = npc.readAtOf(id); } catch { return all.length; }
    if (!Number.isFinite(readAt)) return all.length;
    let shown = 0;
    while (shown < all.length && all[shown].at <= readAt) shown++;
    return Math.min(all.length, Math.max(shown, all.length - TYPE_BACKLOG_MAX));
  }

  /**
   * The `...` bubble — three dots that **shrink and grow slowly, off the beat from one another** (2026-09-17, user's decision).
   *
   * The animation is **Web Animations (`element.animate`)**, not CSS `@keyframes`: the `prefers-reduced-motion` rule in `base.css`
   * clips CSS `animation-duration` to 0.01 ms, which left the dots frozen on this development PC (that rule does not reach WAAPI).
   * And because the bubble is rebuilt on every repaint (`replaceChildren`), each animation's `startTime` is pinned to a fixed point
   * of the document timeline (dot i to `i × TYPE_DOT_STAGGER_MS`) so **the phase carries across a rebuild** — it never jumps back to the start.
   */
  private typingBubble(def: NpcDef | undefined, withAvatar: boolean): HTMLElement {
    const row = el('div', { cls: `ms-msg in typing${withAvatar ? '' : ' cont'}` });
    if (withAvatar) {
      const av = el('span', { cls: 'ms-av small', text: def?.glyph || initialOf(def?.name ?? '?'), parent: row });
      av.style.setProperty('--av', def?.color ?? PC_COLOR);
    }
    const bubble = el('div', { cls: 'ms-bubble ms-typing', parent: row });
    // ease-in-out on each band — both the shrinking and the growing half ease to a stop at the end and turn back
    const small = { transform: `scale(${TYPE_DOT_MIN_SCALE})`, opacity: TYPE_DOT_MIN_OPACITY, easing: 'ease-in-out' };
    const big = { transform: 'scale(1)', opacity: 1, easing: 'ease-in-out' };
    for (let i = 0; i < 3; i++) {
      const dot = el('i', { parent: bubble });
      if (typeof dot.animate !== 'function') continue;   // it stays a small motionless dot (the CSS default)
      try {
        const anim = dot.animate([small, big, small], { duration: TYPE_DOT_PERIOD_MS, iterations: Infinity });
        anim.startTime = i * TYPE_DOT_STAGGER_MS;
      } catch { /* no WAAPI — motionless dots */ }
    }
    return row;
  }

  /** The last bubble's bottom edge (in body coordinates, the tail margin excluded). The scroll height when no tail is attached. */
  private contentEnd(): number {
    return this.tail.parentElement === this.body ? this.tail.offsetTop : this.body.scrollHeight;
  }

  /**
   * Swap the body's children, keeping the reader where they were (pinned to the latest line, or anchored after an older page).
   *
   * 2026-09-17 (user's decision): an **empty tail half the conversation window's height** (`.ms-tail`, CSS `50cqh`) always follows
   * the bubbles, so scrolling to the end puts the last bubble around the middle of the window. 「Is it at the bottom」 is therefore
   * judged by whether the **last bubble's bottom edge** (`contentEnd`) is visible, not by the scroll end, and following down goes
   * only as far as that edge reaching the window's bottom (`latest`) — a reader who already scrolled further into the tail is left
   * where they are (maximum scroll is `contentEnd − half a window`, so a new bubble is always visible from there too).
   */
  private paintBody(nodes: HTMLElement[], oldest: number): void {
    const b = this.body;
    const convChanged = this.paintedConv !== this.selected;
    const atBottom = b.scrollTop + b.clientHeight >= this.contentEnd() - 32;
    const prevH = b.scrollHeight;
    const prevTop = b.scrollTop;
    const prepended = !convChanged && oldest > 0 && this.paintedOldest > 0 && oldest < this.paintedOldest;
    b.replaceChildren(...nodes, this.tail);
    const latest = Math.max(0, this.contentEnd() - b.clientHeight);
    if (prepended && !atBottom) b.scrollTop = prevTop + (b.scrollHeight - prevH);
    else if (convChanged) b.scrollTop = latest;
    else if (atBottom) b.scrollTop = Math.max(prevTop, latest);
    this.paintedConv = this.selected;
    this.paintedOldest = oldest;
  }

  private threadHead(glyph: string, color: string, title: string, sub: string, presence?: PresenceState): HTMLElement {
    const av = el('span', { cls: `ms-av big${presence ? ` pres-${presence}` : ''}`, text: glyph });
    av.style.setProperty('--av', color);
    return this.threadHeadWith(av, title, sub);
  }

  /** The head row with an already-built avatar (an NPC's wears the trust ring — `Trust.buildNpcAvatar`). */
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
    /* 2026-09-14 3rd pass (user's decision): the avatar wears the trust ring + the level badge, and the one `bio` line is gone (the first contact's own lines do the introducing). */
    this.threadHeadWith(buildNpcAvatar(ctx, id, name, { glyph: def?.glyph || initialOf(name), color }), name,
      def ? [def.title, corp || NPC_ROLE_LABEL_KO[def.role]].filter(Boolean).join(' · ') : '');
    /* The level · trust readout stands at the **centre-right** of the head row (not under the avatar). */
    const trustEl = buildNpcTrust(ctx, id, name, { color });
    if (trustEl) { trustEl.classList.add('in-right'); this.head.appendChild(trustEl); }

    /* A newly arrived bubble lands one line at a time through `...`. When a conversation is **drawn for the first time**
     * (= `typingConv` differs), 2026-09-15 (user's decision) shows **only as far as what was read** at once and the unread
     * lines still ride the queue and arrive one by one — this is why opening Raven's first contact put all three lines up at
     * once. `markRead` below does the marking, so reopening a conversation finds `readAt` already at the end and draws everything at once by itself. */
    const all: readonly NpcMessage[] = npc?.getMessages(id) ?? [];
    if (this.typingConv !== id) {
      if (this.typingTimer) { window.clearTimeout(this.typingTimer); this.typingTimer = 0; }
      this.typingConv = id;
      this.typingShown = this.readShownCount(npc, id, all);
      /* Choice delay: opening an already-read conversation (= no bubble left to unroll) never waits. With something left to unroll it is raised behind the last bubble. */
      this.clearChoiceGate();
      if (this.typingShown >= all.length) this.choiceReadyConv = id;
    } else if (all.length < this.typingShown) this.typingShown = all.length;   // the history shrank (a reset · another character)
    /* My answers · system lines never wait — they land in the same paint (only NPC bubbles · quest cards wait). */
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
    /* With a bubble still unrolled (= an NPC bubble · a quest card), `...` stands in its place and the next line is scheduled. */
    const pending = all[this.typingShown];
    if (pending) {
      nodes.push(this.typingBubble(def, prevFrom !== 'npc' && prevFrom !== 'quest'));
      const text = pending.from === 'quest' ? npc?.getQuest(pending.questId)?.def.summary ?? ''
        : pending.from === 'npc' ? pending.text : '';
      this.scheduleTyping(id, Math.min(TYPE_MAX_S, Math.max(TYPE_MIN_S, text.length * TYPE_S_PER_CHAR)));
    }
    /* 2026-09-14 (the tutorial rework — `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」): the first contact's **line choices**.
     * While the answer is still open a row of my-answer buttons stands under the bubbles — the same grammar (`ms-btn`)
     * as the quest card's [수락]. Choosing appends one `choice` event, two lines (my answer + the NPC's reply) enter the
     * conversation and `getPendingChoices` becomes an empty array, so the row disappears. Closing and leaving before
     * choosing keeps it there for the next open. Bubbles still being typed all land first.
     * 2026-09-17 (user's decision): even after the last bubble has landed it waits `MESSENGER_CHOICE_DELAY_S` more before standing (`scheduleChoices`).
     * A new bubble that restarts the typing restarts the delay too. */
    if (pending) this.clearChoiceGate();
    let choices = pending ? [] : npc?.getPendingChoices(id) ?? [];
    if (choices.length > 0 && this.choiceReadyConv !== id) {
      this.scheduleChoices(id);
      choices = [];
    }
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
    /* 2026-09-14 3rd pass: the bottom notice (`NPC 에게는 퀘스트 카드로 답합니다`) is gone — the card and the choices speak for themselves. */
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
      && this.contentEnd() <= this.body.clientHeight + 4 && this.autoLoadLen !== all.length) {
      this.autoLoadLen = all.length;
      window.setTimeout(() => this.loadOlder(), 0);
    }

    /* The member drawer */
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

  /* ── Popovers · confirms ───────────────────────────────────────────────── */

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

  /** Leaving = an irreversible confirm → a 1 s hold (root CLAUDE.md 「Irreversible confirms need a 1 s hold」). */
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

  /** A kick can be undone by inviting again — one plain confirm (no hold). */
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
