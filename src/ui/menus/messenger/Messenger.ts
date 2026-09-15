import type { GameContext, MessengerTab, PlayerCode, RoomId } from '@/shared';
import { Keys, NPC_DEF_MAP, formatPlayerCode, keyLabel } from '@/shared';
import { el, setText, toggleClass } from '../../dom';
import { SocialColumn } from '../social/SocialColumn';
import { SOCIAL_UNAVAILABLE_KO, socialOf } from '../social/socialSource';
import { ChatTab } from './ChatTab';
import { QuestsTab } from './QuestsTab';
import { npcOf, roomsOf } from './sources';
import '../../styles/messenger.css';

export interface MessengerHost {
  close(): void;
  readonly isOpen: boolean;
}

/** `ui:openMessenger` 의 대상. */
export interface MessengerTarget {
  tab?: MessengerTab;
  npc?: string;
  code?: PlayerCode;
  room?: RoomId;
}

const TABS: readonly { id: MessengerTab; label: string }[] = [
  { id: 'chat', label: '대화' }, { id: 'friends', label: '친구' }, { id: 'quests', label: '퀘스트' },
];

/** 대화 탭 배지: NPC · 개인 대화 · 단체방 읽지 않음 + 받은 방 초대. */
function chatBadge(ctx: GameContext): number {
  const social = socialOf(ctx);
  const rooms = roomsOf(ctx);
  return (npcOf(ctx)?.unreadTotal ?? 0)
    + (social?.available ? social.whisperUnreadTotal ?? 0 : 0)
    + (rooms?.available ? rooms.unreadTotal + rooms.invites.length : 0);
}

/** 친구 탭 배지: 받은 친구 요청. */
function friendsBadge(ctx: GameContext): number {
  const social = socialOf(ctx);
  return social?.available ? social.incoming.length : 0;
}

/** 우상단 썸네일의 합계 — 대화(NPC · 개인 대화 · 단체방 읽지 않음 + 방 초대) + 받은 친구 요청. */
export function messengerUnreadTotal(ctx: GameContext): number {
  return chatBadge(ctx) + friendsBadge(ctx);
}

/**
 * **메신저** 패널 본체 (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」) — 옛 커뮤니티 패널을 대체한다.
 * 창 틀 · blocker · 커서 · Escape · P 토글 · 초대 스택은 여전히 `hud/Community` 가 쥐고, 이 클래스는 틀 안(`.cp-frame`)만 짓는다:
 *
 *   머리  `.cp-head.ms-head` — 제목 `메신저` · 탭 3개(대화 · 친구 · 퀘스트, 배지) · 내 아이디 · `차단 목록 n` · `닫기 (P)`
 *   본문  `.ms-pages` — 탭마다 `.ms-page` 하나:
 *           대화   `ChatTab`    NPC · 개인 대화 · 단체방 목록 + 말풍선
 *           친구   `SocialColumn` (옛 커뮤니티 열 그대로 — 분대원 · 받은 요청 · 친구 · 최근 · 차단 목록 페이지)
 *           퀘스트 `QuestsTab`  진행 중 · 새 제안 · 보류 · 완료
 *
 * 탭은 닫았다 열어도 유지된다 (처음은 대화). `openTarget` 이 `ui:openMessenger` · 친구 탭의 「개인 대화」 · 퀘스트 탭의
 * 「대화 보기」 를 한 길로 받는다.
 */
export class Messenger {
  readonly head: HTMLElement;
  readonly codeEl: HTMLElement;
  readonly blockedBtn: HTMLButtonElement;
  readonly closeBtn: HTMLButtonElement;
  readonly chat: ChatTab;
  readonly quests: QuestsTab;
  readonly column: SocialColumn;
  private readonly tabBtns = new Map<MessengerTab, { btn: HTMLButtonElement; badge: HTMLElement }>();
  private readonly pages = new Map<MessengerTab, HTMLElement>();
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];
  private _tab: MessengerTab = 'chat';
  private badgeAcc = 1;
  private lastBadges = '';

  constructor(frame: HTMLElement, private readonly host: MessengerHost) {
    frame.classList.add('ms-frame');
    this.head = el('div', { cls: 'cp-head ms-head', parent: frame });
    el('div', { cls: 'cp-title', text: '메신저', parent: this.head });
    const tabs = el('div', { cls: 'ms-tabs', parent: this.head });
    for (const t of TABS) {
      const btn = el('button', { cls: `ms-tab${t.id === this._tab ? ' is-on' : ''}`, parent: tabs });
      btn.type = 'button';
      btn.dataset.tab = t.id;
      el('span', { cls: 'ms-tab-l', text: t.label, parent: btn });
      const badge = el('span', { cls: 'ms-badge ui-mono', text: '', parent: btn });
      badge.hidden = true;
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.setTab(t.id); });
      this.tabBtns.set(t.id, { btn, badge });
    }
    this.codeEl = el('div', { cls: 'cp-code ui-mono', text: '', parent: this.head });
    this.blockedBtn = el('button', { cls: 'ui-btn small cp-blocked', text: '차단 목록', parent: this.head });
    this.blockedBtn.addEventListener('click', (e) => { e.stopPropagation(); this.setTab('friends'); this.column.openBlocked(); });
    this.closeBtn = el('button', { cls: 'ui-btn small cp-close', text: `닫기 (${keyLabel(Keys.INVITE)})`, parent: this.head });
    this.closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.host.close(); });

    const body = el('div', { cls: 'ms-pages', parent: frame });
    for (const t of TABS) {
      const page = el('div', { cls: `ms-page ${t.id}`, parent: body });
      page.dataset.tab = t.id;
      page.hidden = t.id !== this._tab;
      this.pages.set(t.id, page);
    }
    this.chat = new ChatTab(this.pages.get('chat')!, frame, {
      requestClose: () => this.host.close(),
      openQuest: (id) => { this.setTab('quests'); this.quests.select(id); },
      isVisible: () => this.host.isOpen && this._tab === 'chat',
    });
    this.column = new SocialColumn(this.pages.get('friends')!, {
      squad: true,
      onWhisper: (code) => this.openTarget({ code }),
      onRequestClose: () => this.host.close(),
    });
    this.quests = new QuestsTab(this.pages.get('quests')!, {
      openNpc: (npcId) => this.openTarget({ npc: npcId }),
      isVisible: () => this.host.isOpen && this._tab === 'quests',
    });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.chat.bind(ctx);
    this.column.bind(ctx);
    this.quests.bind(ctx);
    /*
     * NPC 개인 신뢰도 레벨업 토스트 (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 정보상」) — 기업 신뢰도의
     * `meta:repChanged → <기업> 신뢰도 Lv.n`(`hud/MetaToasts`)과 같은 결이다. 패널이 닫혀 있어도 떠야 하므로
     * `bind` 에서 한 번 걸고(메신저는 HUD 초기화 때 지어진다) `dispose` 에서 푼다.
     */
    this.unsubs.push(ctx.bus.on('meta:npcTrustChanged', ({ npc, level, levelUp }) => {
      if (!levelUp) return;
      const name = NPC_DEF_MAP.get(npc)?.name ?? npc;
      ctx.bus.emit('ui:notify', { text: `${name} 신뢰도 Lv.${level}`, kind: 'success', duration: 4 });
    }));
  }

  get tab(): MessengerTab { return this._tab; }

  setTab(tab: MessengerTab): void {
    const prev = this._tab;
    this._tab = tab;
    for (const [id, { btn }] of this.tabBtns) toggleClass(btn, 'is-on', id === tab);
    for (const [id, page] of this.pages) page.hidden = id !== tab;
    if (prev !== tab) {
      if (prev === 'chat') this.chat.onHide();
      if (prev === 'friends') { this.column.contextMenu?.close(); this.column.closePage(); }
    }
    if (!this.host.isOpen) return;
    if (tab === 'chat') this.chat.onShow();
    else if (tab === 'quests') this.quests.onShow();
    else this.column.refresh(true);
    if (prev !== tab) this.ctx?.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** 대상으로 옮긴다 — NPC · 개인 대화 · 단체방이면 대화 탭의 그 대화, 아니면 `tab`. */
  openTarget(t: MessengerTarget): void {
    if (t.npc) { this.setTab('chat'); this.chat.select(`npc:${t.npc}`); return; }
    if (t.code) { this.setTab('chat'); this.chat.select(`pc:${t.code}`); return; }
    if (t.room) { this.setTab('chat'); this.chat.select(`room:${t.room}`); return; }
    if (t.tab) this.setTab(t.tab);
  }

  /** 패널이 열렸다. */
  onOpen(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const social = socialOf(ctx);
    setText(this.codeEl, social?.available && social.me ? `내 아이디 ${formatPlayerCode(social.me.code)}` : SOCIAL_UNAVAILABLE_KO);
    this.column.refresh(true);
    this.badgeAcc = 1;
    this.setTab(this._tab);
  }

  /** 패널이 닫혔다. */
  onClose(): void {
    this.column.contextMenu?.closeAll();   // 2026-09-15: the 친구 삭제 / 차단 / 파티 떠나기 confirm card too
    this.column.closePage();
    this.chat.onHide();
  }

  refreshKeyLabels(): void {
    setText(this.closeBtn, `닫기 (${keyLabel(Keys.INVITE)})`);
  }

  /** 열려 있는 동안 매 프레임 (`hud/Community.update`). */
  update(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this._tab === 'chat') this.chat.tick(dt);
    else if (this._tab === 'quests') this.quests.tick(dt);
    else this.column.tick();
    this.badgeAcc += dt;
    if (this.badgeAcc < 0.25) return;
    this.badgeAcc = 0;
    const counts: Record<MessengerTab, number> = { chat: chatBadge(ctx), friends: friendsBadge(ctx), quests: QuestsTab.badgeCount(ctx) };
    const key = `${counts.chat}|${counts.friends}|${counts.quests}`;
    if (key === this.lastBadges) return;
    this.lastBadges = key;
    for (const [id, { badge }] of this.tabBtns) {
      const n = counts[id];
      badge.hidden = n <= 0;
      setText(badge, n > 99 ? '99+' : String(n));
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.chat.dispose();
    this.quests.dispose();
    this.column.dispose();
  }
}
