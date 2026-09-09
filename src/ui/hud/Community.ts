import type { GameContext, SquadInvite } from '@/shared';
import {
  COMMUNITY_BLOCKER, COMMUNITY_TAP_MAX_S, Keys, SQUAD_INVITE_HOLD_S, SQUAD_INVITE_MAX, formatPlayerCode, keyLabel,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { AskPopup } from '../menus/askPopup';
import { SocialColumn } from '../menus/social/SocialColumn';
import { SOCIAL_UNAVAILABLE_KO, socialOf } from '../menus/social/socialSource';
import type { CutsceneWatch } from './CutsceneWatch';

/**
 * 커뮤니티 icon + 분대 초대 stack (`.community`, social layer — the layer that stays visible in the ship), Phase 11.
 *
 * Ship only, exactly like `hud/ShipManageHint`: it self-gates on `ctx.isHubPhase()` every frame and never appears in
 * a raid (the ESC screen's social column is ship-only for the same reason). Top-right, above the `.cheat-tag` (whose
 * `top` shifts down in the hub so the two cannot overlap):
 *   - the **thumbnail** with the number of connected friends (`SocialRef.onlineFriends`) **inside its bottom-right**
 *     corner and a red dot at its **top-right** while a friend request is waiting (`SocialRef.hasNews`);
 *   - clicking it — or a **tap of `Keys.INVITE` (P)** — opens the 커뮤니티 panel, and the same tap closes it. Since
 *     2026-09-08 this is the game's **only** social surface (the ESC screen's column is gone) and Escape belongs to
 *     the 일시정지 메뉴, so P is both the open and the close key. It holds `COMMUNITY_BLOCKER` +
 *     `setCursorMode(true, COMMUNITY_BLOCKER)` and emits `ui:communityToggled`;
 *   - **분대 초대 panels** stack *under* the thumbnail (at most `SQUAD_INVITE_MAX`, newest on top) with a
 *     `Keys.INVITE` (P) hold gauge — `SQUAD_INVITE_HOLD_S` of holding the key in the ship with no other blocker up
 *     calls `social.acceptInvite(from)`. Expiry / acceptance simply removes the invite from `SocialRef.invites`.
 *
 * Counts, the red dot and the invite list are polled once per frame from the mirror and compared before any DOM is
 * written; with no relay the thumbnail still shows (count 0, no dot) and the panel carries the one
 * `소셜 기능을 사용할 수 없습니다` line.
 *
 * **Phase 12:** hidden for the length of a docking / warp cutscene (`CutsceneWatch` — `hub:docking` / `hub:travel`
 * start → end, phase `'docking'`, `ctx.hub.travelling`); the phase check alone missed the warp, whose phase stays
 * `'hub'`. The open panel closes when a cutscene starts.
 *
 * **2026-09-09:** **Tab (`Keys.INVENTORY`) closes the panel too** (consumed so the inventory does not open — its own
 * guard already refuses while `COMMUNITY_BLOCKER` is up), and the open panel emits `ui:keyGuide {owner:'community'}`
 * (`우클릭 메뉴` · `P 닫기`; re-emitted on `input:bindingsChanged`, `null` on close) for the bottom-right 키 가이드,
 * which appends `Tab 닫기` itself.
 */
export class Community {
  readonly root: HTMLElement;
  private btn: HTMLButtonElement;
  private countEl: HTMLElement;
  private dot: HTMLElement;
  private inviteWrap: HTMLElement;
  private panel!: HTMLElement;
  private panelCode!: HTMLElement;
  private column!: SocialColumn;
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  private shown = false;
  private _open = false;
  private lastCount = -1;
  private lastNews = false;
  private inviteKey = '';
  private cards: { from: string; root: HTMLElement; fill: HTMLElement }[] = [];
  private held = 0;
  private lastHeldShown = -1;

  /** 2026-09-08: P tap = panel, P hold = invite. `pHeld` is the whole press; `pAccepted` blocks the tap after one. */
  private pAccepted = false;
  private pHeld = 0;
  private closeBtn: HTMLElement | null = null;

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
    this.btn.title = '커뮤니티';
    el('span', { cls: 'cm-glyph', text: '⛬', parent: this.btn });
    el('span', { cls: 'cm-tag', text: '커뮤니티', parent: this.btn });
    this.countEl = el('span', { cls: 'cm-count ui-mono', text: '0', parent: this.btn });
    this.dot = el('i', { cls: 'cm-dot', parent: this.btn });
    this.dot.hidden = true;
    this.inviteWrap = el('div', { cls: 'cm-invites', parent: this.root });
    this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    /* The panel is a direct child of `#ui-root` so it is never hidden by the social layer's own gating. */
    this.panel = el('div', { cls: 'community-panel interactive', parent: ctx.uiRoot });
    this.panel.hidden = true;
    const frame = el('div', { cls: 'cp-frame', parent: this.panel });
    const head = el('div', { cls: 'cp-head', parent: frame });
    el('div', { cls: 'cp-title', text: '커뮤니티', parent: head });
    this.panelCode = el('div', { cls: 'cp-code ui-mono', text: '', parent: head });
    const close = el('button', { cls: 'ui-btn small cp-close', text: `닫기 (${keyLabel(Keys.INVITE)})`, parent: head });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.closeBtn = close;
    this.column = new SocialColumn(frame, {
      squad: true,
      onWhisper: (code, name) => { this.close(); ctx.bus.emit('chat:whisperTo', { code, name }); },
    });
    this.column.bind(ctx);
    this.panel.addEventListener('mousedown', (e) => e.stopPropagation());
    /*
     * 2026-09-09 — **분대장 넘기기**. 분대원 행(`.sc-srow[data-peer-id]`, `menus/social/SocialColumn` 이 그린다)을
     * 우클릭하면 메뉴가 뜬다. 내가 호스트가 아니거나 나 자신을 눌렀으면 아무것도 열지 않는다 (규칙은 서버와
     * 같다: 호스트만, 같은 로비의 연결된 멤버에게만). 확정은 되돌릴 수 없는 일이 아니지만 실수 방지를 위해
     * `menus/askPopup` 의 확인 팝업을 한 번 거치고, 초기 포커스는 그 팝업의 규약대로 **취소** 쪽이다.
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
    /*
     * `title.css` 의 `.tm-ask` 는 타이틀 화면 **안**에 놓이려고 `position:absolute; z-index:5` 다. 여기서는
     * `#ui-root` 의 직계 자식이라 커뮤니티 패널(과 그 위의 우클릭 메뉴) 밑으로 깔린다 — 이 인스턴스에만
     * 인라인으로 못을 박는다 (`.sc-confirm` 이 쓰는 302 보다 위).
     */
    this.ask.root.style.position = 'fixed';
    this.ask.root.style.zIndex = '320';
    window.addEventListener('mousedown', this.onDocDownLead, true);

    this.unsubs.push(
      ctx.bus.on('social:updated', () => { this.inviteKey = ''; }),
      ctx.bus.on('social:invited', () => { this.inviteKey = ''; }),
      ctx.bus.on('social:inviteClosed', () => { this.inviteKey = ''; this.held = 0; }),
      // The 닫기 label and the invite hint both name the live `Keys.INVITE` — never cache a key label.
      ctx.bus.on('input:bindingsChanged', () => { this.inviteKey = ''; this.refreshKeyLabels(); if (this._open) this.emitGuide(); }),
      ctx.bus.on('game:phaseChanged', () => { if (this._open && !ctx.isHubPhase()) this.close(); }),
      ctx.bus.on('game:newMission', () => { if (this._open) this.close(); }),
    );
  }

  /** Whether the thumbnail is showing / the panel is open / how many invite panels are stacked (debug). */
  get isShowing(): boolean { return this.shown; }
  get isOpen(): boolean { return this._open; }
  get inviteCount(): number { return this.cards.length; }
  /** 0..1 of the P hold on the newest invite (debug). */
  get holdProgress(): number { return Math.min(1, this.held / SQUAD_INVITE_HOLD_S); }
  /** The panel's social column (debug). */
  get socialColumn(): SocialColumn { return this.column; }

  update(dt: number, ctx: GameContext): void {
    // Visible in the ship whenever nothing else owns the screen — our own panel does not count.
    const blockers = ctx.uiBlockers;
    const free = blockers.size === 0 || (blockers.size === 1 && blockers.has(COMMUNITY_BLOCKER));
    const cutscene = this.cutscene?.active ?? (ctx.phase === 'docking' || (ctx.hub?.travelling ?? false));
    // 2026-09-08: 튜토리얼이 도는 동안에는 우측 상단 커뮤니티 버튼을 감춘다 (안내 밖으로 새지 않게)
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
    const news = !!social?.available && social.hasNews;
    if (news !== this.lastNews) { this.lastNews = news; this.dot.hidden = !news; }

    const invites = (social?.available ? social.invites : []).slice(-SQUAD_INVITE_MAX);
    const key = invites.map((v) => `${v.from}|${v.name}`).join(',');
    if (key !== this.inviteKey) { this.inviteKey = key; this.rebuildInvites(invites); }

    /*
     * P (`Keys.INVITE`) — **tap = 커뮤니티 패널, hold = 분대 초대 수락** (2026-09-08).
     *
     * The panel used to close on Escape; Escape is the 일시정지 메뉴 now, so P became both the open and the close
     * key. The invite hold it already carried keeps priority: the toggle fires on *release*, and only when the press
     * stayed inside `COMMUNITY_TAP_MAX_S` — a longer press was an invite hold the player abandoned, and must not
     * open a panel as a consolation prize. With no invite on screen there is nothing to hold for, so any release
     * toggles and the key stays forgiving.
     */
    if (ctx.input.wasPressed(Keys.INVITE)) { this.pHeld = 0; this.pAccepted = false; }
    const down = ctx.input.isDown(Keys.INVITE);
    if (down) this.pHeld += dt;                       // the whole press, whether or not it can accept anything
    const canHold = this.shown && blockers.size === 0 && this.cards.length > 0;
    const holding = canHold && down;
    this.held = holding ? this.held + dt : 0;         // the gauge, which only runs while an invite can be accepted
    if (holding && this.held >= SQUAD_INVITE_HOLD_S) {
      const from = this.cards[0].from;
      this.held = 0;
      this.pAccepted = true;
      social?.acceptInvite(from);
      this.inviteKey = '';
    }
    // `free` above already ignores our own blocker, so the panel can close itself; a 일시정지 메뉴 / 인벤토리 on
    // top of it clears `free` and P goes quiet. A press held past the tap window was aimed at an invite, so an
    // abandoned hold must not also open the panel.
    if (ctx.input.wasReleased(Keys.INVITE) && !this.pAccepted && free && (this.shown || this._open)
      && (this.cards.length === 0 || this.pHeld <= COMMUNITY_TAP_MAX_S)) this.toggle();
    this.applyHold();
  }

  private refreshKeyLabels(): void {
    if (this.closeBtn) setText(this.closeBtn, `닫기 (${keyLabel(Keys.INVITE)})`);
  }

  /* ── 분대장 넘기기 (2026-09-09) ───────────────────────────────────────── */
  /** 우클릭한 분대원 행에 붙는 한 줄 메뉴. `leader:transferRequested` 가 net 으로 가는 유일한 입구다. */
  private openLeadMenu(peerId: string, name: string, x: number, y: number): void {
    this.leadTarget = peerId;
    const items = el('div', { cls: 'sc-menu-items' });
    // `.sc-mi .w` 는 붉은 "못 하는 이유" 칸이므로 이름은 라벨 안에 넣는다.
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
      x.title = '초대 무시';
      x.addEventListener('click', (e) => { e.stopPropagation(); socialOf(this.ctx)?.dismissInvite(inv.from); this.inviteKey = ''; });
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
    ctx.input.setCursorMode(true, COMMUNITY_BLOCKER);
    const social = socialOf(ctx);
    social?.refresh();
    setText(this.panelCode, social?.available && social.me
      ? `내 아이디 ${formatPlayerCode(social.me.code)}`
      : SOCIAL_UNAVAILABLE_KO);
    this.column.refresh(true);
    this.emitGuide();
    ctx.bus.emit('ui:communityToggled', { open: true });
    ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this._open) return;
    const ctx = this.ctx;
    this._open = false;
    this.panel.hidden = true;
    this.column.contextMenu?.close();
    this.closeLeadMenu();
    this.ask.close();
    ctx.uiBlockers.delete(COMMUNITY_BLOCKER);
    ctx.input.setCursorMode(false, COMMUNITY_BLOCKER);
    ctx.bus.emit('ui:keyGuide', { owner: 'community', keys: null });
    ctx.bus.emit('ui:communityToggled', { open: false });
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
      this.ctx?.input.setCursorMode(false, COMMUNITY_BLOCKER);
    }
    this.column?.dispose();
    this.panel?.remove();
    this.root.remove();
  }
}
