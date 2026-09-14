import type { GameContext, SquadInvite } from '@/shared';
import {
  COMMUNITY_BLOCKER, COMMUNITY_TAP_MAX_S, Keys, NPC_DEF_MAP, NPC_QUEST_MAP, SQUAD_INVITE_HOLD_S, SQUAD_INVITE_MAX,
  formatPlayerCode, keyLabel,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { AskPopup } from '../menus/askPopup';
import { clip } from '../menus/messenger/format';
import { Messenger, messengerUnreadTotal } from '../menus/messenger/Messenger';
import type { SocialColumn } from '../menus/social/SocialColumn';
import { socialOf } from '../menus/social/socialSource';
import type { CutsceneWatch } from './CutsceneWatch';

/**
 * "Rebuild the invite stack on the next frame". Never a real key (`from|name|id,…`, or `''` for an empty stack) — the
 * resets used to write `''`, so closing the **last** invite matched the empty stack's key and its card stayed on screen
 * (2026-09-11, found by smoke-social once a real `SocialSync` drove the stack).
 */
const STALE_KEY = '#';

/**
 * **메신저** 아이콘 + 패널 호스트 + 분대 초대 stack (`.community`, social layer — the layer that stays visible in the ship).
 * Phase 11 의 커뮤니티 패널이 2026-09-14 **메신저**(`menus/messenger/Messenger` — 대화 · 친구 · 퀘스트)로 바뀌었다
 * (docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」). 이 클래스가 쥐는 것은 그대로다: 창 틀, blocker(`COMMUNITY_BLOCKER`), 소프트웨어 커서,
 * Escape 스택, P 탭 토글 / P 홀드 초대 수락, 키 가이드. 패널 틀 안은 `Messenger` 가 짓는다.
 *
 * Ship only, exactly like `hud/ShipManageHint`: it self-gates on `ctx.isHubPhase()` every frame and never appears in
 * a raid (사용자 결정 2026-09-14: 메신저는 함선 전용 — 레이드 중에는 채팅창 개인 대화와 지도 퀘스트 패널만). Top-right:
 *   - the **thumbnail** with the number of connected friends (`SocialRef.onlineFriends`) inside its bottom-right corner
 *     and, at its **top-right**, a red **count badge** (`.cm-dot.has-num`) = `messengerUnreadTotal` — NPC · 개인 대화 ·
 *     단체방 읽지 않음 + 받은 방 초대 + 받은 친구 요청 (2026-09-14; it was a plain red dot for a friend request);
 *   - clicking it — or a **tap of `Keys.INVITE` (P)** — opens the panel, and the same tap closes it. It holds
 *     `COMMUNITY_BLOCKER` + `setCursorMode(true, COMMUNITY_BLOCKER)` and emits `ui:communityToggled` **and**
 *     `ui:messengerToggled`;
 *   - **분대 초대 panels** stack *under* the thumbnail (at most `SQUAD_INVITE_MAX`, newest on top) with a
 *     `Keys.INVITE` (P) hold gauge — `SQUAD_INVITE_HOLD_S` of holding the key in the ship with no other blocker up
 *     calls `social.acceptInvite(from)`.
 *
 * `ui:openMessenger {tab, npc, code, room}` opens the panel onto that target (ignored outside the ship / in a cutscene /
 * while the tutorial hides the button). A new NPC message (`npc:message` intro · offer) toasts while the panel is closed.
 *
 * **Phase 12:** hidden for the length of a docking / warp cutscene (`CutsceneWatch`). The open panel closes when a
 * cutscene starts. **2026-09-09:** Tab (`Keys.INVENTORY`) closes the panel too (consumed), and the open panel emits
 * `ui:keyGuide {owner:'community'}` (`우클릭 메뉴` · `P 닫기`). **2026-09-11 (B-3 · B-4):** an invite card's × is a real
 * 거절; the panel head's `차단 목록 n` opens the 친구 tab's blocked page.
 */
export class Community {
  readonly root: HTMLElement;
  private btn: HTMLButtonElement;
  private countEl: HTMLElement;
  private dot: HTMLElement;
  private inviteWrap: HTMLElement;
  private panel!: HTMLElement;
  private messengerView!: Messenger;
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  private shown = false;
  private _open = false;
  private lastCount = -1;
  private lastUnread = -1;
  private unreadAcc = 1;
  private inviteKey = '';
  private cards: { from: string; root: HTMLElement; fill: HTMLElement }[] = [];
  private held = 0;
  private lastHeldShown = -1;

  /** 2026-09-08: P tap = panel, P hold = invite. `pHeld` is the whole press; `pAccepted` blocks the tap after one. */
  private pAccepted = false;
  private pHeld = 0;
  private lastBlockedLabel = '#';   // never a real label: the first open always writes the button

  /* 2026-09-09 — 분대장 넘기기: 분대원 행의 우클릭 메뉴 + 확인 팝업. 내가 호스트일 때만 열린다. */
  private leadMenu!: HTMLElement;
  private ask!: AskPopup;
  private leadTarget: string | null = null;
  private readonly onDocDownLead = (e: MouseEvent): void => {
    if (this.leadMenu.hidden) return;
    if (e.target instanceof Node && this.leadMenu.contains(e.target)) return;
    this.closeLeadMenu();
  };

  constructor(parent: HTMLElement, private cutscene: CutsceneWatch | null = null) {
    this.root = el('div', { cls: 'community', parent });
    this.btn = el('button', { cls: 'cm-btn interactive', parent: this.root });
    this.btn.title = '메신저';
    el('span', { cls: 'cm-glyph', text: '✉', parent: this.btn });
    el('span', { cls: 'cm-tag', text: '메신저', parent: this.btn });
    this.countEl = el('span', { cls: 'cm-count ui-mono', text: '0', parent: this.btn });
    this.dot = el('i', { cls: 'cm-dot has-num ui-mono', parent: this.btn });
    this.dot.hidden = true;
    this.inviteWrap = el('div', { cls: 'cm-invites', parent: this.root });
    this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    /* The panel is a direct child of `#ui-root` so it is never hidden by the social layer's own gating. */
    this.panel = el('div', { cls: 'community-panel ms-panel interactive', parent: ctx.uiRoot });
    this.panel.hidden = true;
    const frame = el('div', { cls: 'cp-frame', parent: this.panel });
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.messengerView = new Messenger(frame, { close: () => self.close(), get isOpen() { return self._open; } });
    this.messengerView.bind(ctx);
    this.panel.addEventListener('mousedown', (e) => e.stopPropagation());
    /*
     * 2026-09-09 — **분대장 넘기기**. 친구 탭의 분대원 행(`.sc-srow[data-peer-id]`, `menus/social/SocialColumn` 이 그린다)을
     * 우클릭하면 메뉴가 뜬다. 내가 호스트가 아니거나 나 자신을 눌렀으면 아무것도 열지 않는다 (규칙은 서버와 같다).
     */
    this.panel.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const row = (e.target as HTMLElement | null)?.closest?.('.sc-srow[data-peer-id]') as HTMLElement | null;
      const peerId = row?.dataset.peerId ?? null;
      const net = ctx.net;
      if (!peerId || !net?.lobby || !net.isHost || peerId === net.localId) { this.closeLeadMenu(); return; }
      const member = net.lobby.players.find((p) => p.id === peerId);
      if (!member || !member.connected) { this.closeLeadMenu(); return; }
      this.openLeadMenu(peerId, member.name || '분대원', e.clientX + 4, e.clientY + 4);
    });
    /* 메뉴 · 팝업은 패널이 아니라 `#ui-root` 아래에 산다 — 패널의 overflow 에 잘리지 않게. */
    this.leadMenu = el('div', { cls: 'sc-menu interactive', parent: ctx.uiRoot });
    this.leadMenu.hidden = true;
    this.leadMenu.addEventListener('mousedown', (e) => e.stopPropagation());
    this.leadMenu.addEventListener('contextmenu', (e) => e.preventDefault());
    this.ask = new AskPopup(ctx.uiRoot);
    this.ask.bind(ctx);
    this.ask.root.style.position = 'fixed';
    this.ask.root.style.zIndex = '320';
    window.addEventListener('mousedown', this.onDocDownLead, true);

    this.unsubs.push(
      ctx.bus.on('social:updated', () => { this.inviteKey = STALE_KEY; this.unreadAcc = 1; }),
      ctx.bus.on('social:invited', () => { this.inviteKey = STALE_KEY; }),
      ctx.bus.on('social:inviteClosed', () => { this.inviteKey = STALE_KEY; this.held = 0; }),
      // The 닫기 label and the invite hint both name the live `Keys.INVITE` — never cache a key label.
      ctx.bus.on('input:bindingsChanged', () => { this.inviteKey = STALE_KEY; this.messengerView.refreshKeyLabels(); if (this._open) this.emitGuide(); }),
      ctx.bus.on('game:phaseChanged', () => { if (this._open && !ctx.isHubPhase()) this.close(); }),
      ctx.bus.on('game:newMission', () => { if (this._open) this.close(); }),
      /* 2026-09-14: 메신저 */
      ctx.bus.on('npc:unreadChanged', () => { this.unreadAcc = 1; }),
      ctx.bus.on('social:unreadChanged', () => { this.unreadAcc = 1; }),
      ctx.bus.on('room:unreadChanged', () => { this.unreadAcc = 1; }),
      ctx.bus.on('room:updated', () => { this.unreadAcc = 1; }),
      ctx.bus.on('npc:message', ({ npc, entry }) => this.toastNpc(npc, entry.e, entry.q)),
      ctx.bus.on('ui:openMessenger', (t) => {
        const cutscene = this.cutscene?.active ?? (ctx.phase === 'docking' || (ctx.hub?.travelling ?? false));
        if (!ctx.isHubPhase() || cutscene || (ctx.tutorial?.hides('community') ?? false)) return;
        this.open();
        this.messengerView.openTarget(t);
      }),
    );
  }

  /** Whether the thumbnail is showing / the panel is open / how many invite panels are stacked (debug). */
  get isShowing(): boolean { return this.shown; }
  get isOpen(): boolean { return this._open; }
  get inviteCount(): number { return this.cards.length; }
  /** 0..1 of the P hold on the newest invite (debug). */
  get holdProgress(): number { return Math.min(1, this.held / SQUAD_INVITE_HOLD_S); }
  /** The 친구 tab's social column (debug). */
  get socialColumn(): SocialColumn { return this.messengerView.column; }
  /** The messenger body (debug / smoke). */
  get messenger(): Messenger { return this.messengerView; }
  /** The number on the thumbnail's badge (debug / smoke). */
  get unreadBadge(): number { return Math.max(0, this.lastUnread); }

  update(dt: number, ctx: GameContext): void {
    // Visible in the ship whenever nothing else owns the screen — our own panel does not count.
    const blockers = ctx.uiBlockers;
    const free = blockers.size === 0 || (blockers.size === 1 && blockers.has(COMMUNITY_BLOCKER));
    const cutscene = this.cutscene?.active ?? (ctx.phase === 'docking' || (ctx.hub?.travelling ?? false));
    // 2026-09-08: 튜토리얼이 도는 동안에는 우측 상단 버튼을 감춘다 (안내 밖으로 새지 않게)
    const tutorial = ctx.tutorial?.hides('community') ?? false;
    const on = ctx.isHubPhase() && free && !cutscene && !tutorial;
    if (tutorial && this._open) this.close();
    if (on !== this.shown) {
      this.shown = on;
      toggleClass(this.root, 'show', on);
      if (!on) this.held = 0;
    }
    if (this._open && (!ctx.isHubPhase() || cutscene)) this.close();
    // 2026-09-09: Tab closes every screen (the 일시정지 메뉴 stacked on top keeps it, like P below).
    if (this._open && free && ctx.input.wasPressed(Keys.INVENTORY)) {
      ctx.input.consume(Keys.INVENTORY);
      this.close();
    }
    if (!on && !this._open) return;

    const social = socialOf(ctx);
    const count = social?.available ? social.onlineFriends : 0;
    if (count !== this.lastCount) { this.lastCount = count; setText(this.countEl, String(count)); }
    this.unreadAcc += dt;
    if (this.unreadAcc >= 0.25) {
      this.unreadAcc = 0;
      const n = messengerUnreadTotal(ctx);
      if (n !== this.lastUnread) {
        this.lastUnread = n;
        this.dot.hidden = n <= 0;
        setText(this.dot, n > 99 ? '99+' : String(n));
      }
    }

    const invites = (social?.available ? social.invites : []).slice(-SQUAD_INVITE_MAX);
    const key = invites.map((v) => `${v.from}|${v.name}|${v.id ?? ''}`).join(',');
    if (key !== this.inviteKey) { this.inviteKey = key; this.rebuildInvites(invites); }
    if (this._open) {
      this.messengerView.update(dt);
      const n = social?.available ? social.blocked.length : -1;
      const label = n < 0 ? '' : n > 0 ? `차단 목록 ${n}` : '차단 목록';
      if (label !== this.lastBlockedLabel) {
        this.lastBlockedLabel = label;
        this.messengerView.blockedBtn.hidden = n < 0;
        if (label) setText(this.messengerView.blockedBtn, label);
      }
    }

    /*
     * P (`Keys.INVITE`) — **tap = 메신저 패널, hold = 분대 초대 수락** (2026-09-08). The toggle fires on *release*, and only
     * when the press stayed inside `COMMUNITY_TAP_MAX_S` — a longer press was an invite hold the player abandoned. With no
     * invite on screen any release toggles. Typing a `p` into a messenger text field never reaches here: the field stops
     * the key's propagation (`menus/messenger/textInput`).
     */
    if (ctx.input.wasPressed(Keys.INVITE)) { this.pHeld = 0; this.pAccepted = false; }
    const down = ctx.input.isDown(Keys.INVITE);
    if (down) this.pHeld += dt;
    const canHold = this.shown && blockers.size === 0 && this.cards.length > 0;
    const holding = canHold && down;
    this.held = holding ? this.held + dt : 0;
    if (holding && this.held >= SQUAD_INVITE_HOLD_S) {
      const from = this.cards[0].from;
      this.held = 0;
      this.pAccepted = true;
      social?.acceptInvite(from);
      this.inviteKey = STALE_KEY;
    }
    if (ctx.input.wasReleased(Keys.INVITE) && !this.pAccepted && free && (this.shown || this._open)
      && (this.cards.length === 0 || this.pHeld <= COMMUNITY_TAP_MAX_S)) this.toggle();
    this.applyHold();
  }

  /** 2026-09-14: a new NPC message while the panel is closed (ship only) — one toast, no click action. */
  private toastNpc(npcId: string, e: string, questId?: string): void {
    const ctx = this.ctx;
    if (this._open || !ctx.isHubPhase()) return;
    if (e !== 'intro' && e !== 'offer') return;
    const def = NPC_DEF_MAP.get(npcId);
    const name = def?.name ?? '알 수 없는 발신자';
    const first = e === 'intro' ? def?.intro[0] : questId ? NPC_QUEST_MAP.get(questId)?.lines.offer[0] : undefined;
    const tail = first ? ` — ${clip(first, 38)}` : '';
    ctx.bus.emit('ui:notify', { text: `✉ ${name}${tail}`, kind: 'info', duration: 3.2 });
  }

  /* ── 분대장 넘기기 (2026-09-09) ───────────────────────────────────────── */
  /** 우클릭한 분대원 행에 붙는 한 줄 메뉴. `leader:transferRequested` 가 net 으로 가는 유일한 입구다. */
  private openLeadMenu(peerId: string, name: string, x: number, y: number): void {
    this.leadTarget = peerId;
    const items = el('div', { cls: 'sc-menu-items' });
    const b = el('button', { cls: 'sc-mi', parent: items });
    el('span', { cls: 'l', text: `분대장 넘기기 → ${name}`, parent: b });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeLeadMenu();
      this.ask.open({
        title: '분대장 넘기기',
        body: `${name} 대원에게 분대장을 넘깁니다.\n임무 중에는 그 대원이 호스트 권한(적 · 탈출 · 전리품)을 이어받습니다.`,
        ok: '넘기기',
        run: () => { this.ctx.bus.emit('leader:transferRequested', { peerId }); },
      });
    });
    this.leadMenu.replaceChildren(items);
    this.leadMenu.hidden = false;
    const w = 200, h = 46;
    this.leadMenu.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, x))}px`;
    this.leadMenu.style.top = `${Math.max(6, Math.min(window.innerHeight - h - 6, y))}px`;
  }

  private closeLeadMenu(): void {
    if (this.leadMenu?.hidden !== false) return;
    this.leadMenu.hidden = true;
    this.leadTarget = null;
  }

  /** 우클릭 메뉴가 겨누고 있는 분대원 (debug / smoke). */
  get leaderMenuTarget(): string | null { return this.leadTarget; }

  /** 키 가이드 entries for the open panel (the guide appends `Tab 닫기` itself; P is the panel's own close key). */
  private emitGuide(): void {
    this.ctx.bus.emit('ui:keyGuide', {
      owner: 'community',
      keys: [
        { key: '우클릭', label: '메뉴' },
        { key: keyLabel(Keys.INVITE), label: '닫기' },
      ],
    });
  }

  private applyHold(): void {
    const t = Math.min(1, this.held / SQUAD_INVITE_HOLD_S);
    const rounded = Math.round(t * 50) / 50;
    if (rounded === this.lastHeldShown) return;
    this.lastHeldShown = rounded;
    for (let i = 0; i < this.cards.length; i++) {
      this.cards[i].fill.style.transform = `scaleX(${i === 0 ? rounded.toFixed(3) : '0'})`;
    }
  }

  private rebuildInvites(invites: readonly SquadInvite[]): void {
    this.inviteWrap.replaceChildren();
    this.cards = [];
    this.lastHeldShown = -1;
    // Newest first: the card the P hold targets sits directly under the thumbnail.
    for (const inv of [...invites].reverse()) {
      const card = el('div', { cls: `cm-invite${this.cards.length === 0 ? ' is-active' : ''}`, parent: this.inviteWrap });
      card.dataset.from = inv.from;
      const top = el('div', { cls: 'ci-top', parent: card });
      el('span', { cls: 'ci-id ui-mono', text: formatPlayerCode(inv.from), parent: top });
      const x = el('button', { cls: 'ci-x', text: '×', parent: top });
      x.title = '초대 거절';
      x.addEventListener('click', (e) => { e.stopPropagation(); socialOf(this.ctx)?.declineInvite(inv.from); this.inviteKey = STALE_KEY; });
      el('div', { cls: 'ci-name', text: `${inv.name || '분대원'} 분대 초대`, parent: card });
      el('div', { cls: 'ci-hint', text: `${keyLabel(Keys.INVITE)} 홀드로 참여`, parent: card });
      const bar = el('div', { cls: 'ci-bar', parent: card });
      const fill = el('i', { parent: bar });
      this.cards.push({ from: inv.from, root: card, fill });
    }
    this.applyHold();
  }

  private toggle(): void { if (this._open) this.close(); else this.open(); }

  open(): void {
    if (this._open) return;
    const ctx = this.ctx;
    this._open = true;
    this.panel.hidden = false;
    ctx.uiBlockers.add(COMMUNITY_BLOCKER);
    // Phase 10 cursor rules: keep the pointer lock, hand UI input to the software cursor.
    ctx.escape.push(COMMUNITY_BLOCKER, () => this.close());
    ctx.input.setCursorMode(true, COMMUNITY_BLOCKER);
    socialOf(ctx)?.refresh();
    this.messengerView.onOpen();
    this.emitGuide();
    ctx.bus.emit('ui:communityToggled', { open: true });
    ctx.bus.emit('ui:messengerToggled', { open: true });
    ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this._open) return;
    const ctx = this.ctx;
    this._open = false;
    this.panel.hidden = true;
    this.messengerView.onClose();
    this.closeLeadMenu();
    this.ask.close();
    ctx.uiBlockers.delete(COMMUNITY_BLOCKER);
    ctx.escape.remove(COMMUNITY_BLOCKER);
    ctx.input.setCursorMode(false, COMMUNITY_BLOCKER);
    ctx.bus.emit('ui:keyGuide', { owner: 'community', keys: null });
    ctx.bus.emit('ui:communityToggled', { open: false });
    ctx.bus.emit('ui:messengerToggled', { open: false });
    this.unreadAcc = 1;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    window.removeEventListener('mousedown', this.onDocDownLead, true);
    this.ask?.close();
    this.ask?.root.remove();
    this.leadMenu?.remove();
    if (this._open) {
      this._open = false;
      this.ctx?.uiBlockers.delete(COMMUNITY_BLOCKER);
      this.ctx?.escape.remove(COMMUNITY_BLOCKER);
      this.ctx?.input.setCursorMode(false, COMMUNITY_BLOCKER);
    }
    this.messengerView?.dispose();
    this.panel?.remove();
    this.root.remove();
  }
}
