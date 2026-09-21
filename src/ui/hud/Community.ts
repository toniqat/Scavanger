import type { GameContext, SquadInvite } from '@/shared';
import {
  COMMUNITY_BLOCKER, COMMUNITY_TAP_MAX_S, Keys, MENU_BLOCKER, MESSENGER_DOT_POP_PX, MESSENGER_DOT_POP_S, SQUAD_INVITE_HOLD_S,
  SQUAD_INVITE_MAX, createKeycap, formatPlayerCode, isBotPlayer, keyLabel, paintKeycap,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { AskPopup } from '../menus/askPopup';
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
 * The **messenger** icon + panel host + squad invite stack (`.community`, social layer — the layer that stays visible in the ship).
 * Phase 11's community panel became the **messenger** on 2026-09-14 (`menus/messenger/Messenger` — 대화 · 친구 · 퀘스트).
 * What this class holds is unchanged: the window frame, the blocker (`COMMUNITY_BLOCKER`), the software cursor,
 * the Escape stack, the P tap toggle / P hold invite accept, the key guide. Inside the panel frame is built by `Messenger`.
 *
 * Ship only, exactly like `hud/ShipManageHint`: it self-gates on `ctx.isHubPhase()` every frame and never appears in
 * a raid (user's decision 2026-09-14: the messenger is ship-only — in a raid only the chat window's private chat and the map's quest panel). Top-right:
 *   - the **thumbnail** with the number of connected friends (`SocialRef.onlineFriends`) inside its bottom-right corner
 *     and, at its **top-right**, a red **count badge** (`.cm-dot.has-num`) = `messengerUnreadTotal` — NPC · private chat ·
 *     group room unread + received room invites + received friend requests (2026-09-14; it was a plain red dot for a friend request);
 *   - clicking it — or a **tap of `Keys.INVITE` (P)** — opens the panel, and the same tap closes it. It holds
 *     `COMMUNITY_BLOCKER` + `setCursorMode(true, COMMUNITY_BLOCKER)` and emits `ui:communityToggled` **and**
 *     `ui:messengerToggled`;
 *   - **squad invite panels** stack *under* the thumbnail (at most `SQUAD_INVITE_MAX`, newest on top) with a
 *     `Keys.INVITE` (P) hold gauge — `SQUAD_INVITE_HOLD_S` of holding the key in the ship with no other blocker up
 *     calls `social.acceptInvite(from)`.
 *
 * `ui:openMessenger {tab, npc, code, room}` opens the panel onto that target (ignored outside the ship / in a cutscene /
 * while the tutorial hides the button).
 *
 * **2026-09-16 (user's decision — the messenger is still ship-only):**
 *  - a new NPC message (`npc:message`) **raises no toast.** The button's red dot (the count badge) pops up and settles
 *    back into place instead (`MESSENGER_DOT_POP_S` · `MESSENGER_DOT_POP_PX`). What the message says is known only by
 *    opening the messenger. `update(dt)` pushes the movement as an inline transform — because with reduced motion, as on
 *    this PC, base.css clips CSS animations · transitions to 0.01 ms and it would be over in one frame.
 *  - a **`Keys.INVITE` keycap** (P) sits **under the button** — the label is read at use time (repainted on `input:bindingsChanged`).
 *  - **even with a Tab window (inventory · character · corporation · ship tab) or the ESC pause menu up** the button is
 *    visible and takes the mouse (`overMenu`). A panel opened over them draws **above** that menu (`.over-inv` /
 *    `.over-pause` z-index — base.css), and closing it with Escape (the top of the `ctx.escape` stack) · Tab · P returns
 *    to the menu below. Those menus do not take Tab while `COMMUNITY_BLOCKER` is held (`InventorySystem.update` ·
 *    `PauseMenu.handleKey`). With the settings overlay · a pause warning popup up the button hides (`pauseProbe`). This is
 *    why the root is a direct child of `#ui-root` and not the social layer — a `'menu'` blocker hides that layer whole.
 *
 * **Phase 12:** hidden for the length of a docking / warp cutscene (`CutsceneWatch`). The open panel closes when a
 * cutscene starts. **2026-09-09:** Tab (`Keys.INVENTORY`) closes the panel too (consumed), and the open panel emits
 * `ui:keyGuide {owner:'community'}` (`우클릭 메뉴` · `P 닫기`). **2026-09-11 (B-3 · B-4):** an invite card's × is a real
 * decline; the panel head's `차단 목록 n` opens the 친구 tab's blocked page.
 */
export class Community {
  readonly root: HTMLElement;
  private btn: HTMLButtonElement;
  private countEl: HTMLElement;
  private dot: HTMLElement;
  private inviteWrap: HTMLElement;
  /** 2026-09-16: the `Keys.INVITE` keycap under the button. */
  private keyEl: HTMLElement;
  /** 2026-09-16: the red dot's pop — seconds elapsed (`< 0` = idle) and a pending request to start once the dot shows. */
  private popT = -1;
  private popPending = false;
  /** Whether it stands over a Tab window / the pause menu right now (so the class toggles only on a change). */
  private overKind: 'none' | 'inv' | 'pause' = 'none';
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

  /* 2026-09-09 — squad leader transfer: the right-click menu on a squadmate row + a confirm popup. Opens only while I am the host. */
  private leadMenu!: HTMLElement;
  private ask!: AskPopup;
  private leadTarget: string | null = null;
  private readonly onDocDownLead = (e: MouseEvent): void => {
    if (this.leadMenu.hidden) return;
    if (e.target instanceof Node && this.leadMenu.contains(e.target)) return;
    this.closeLeadMenu();
  };

  /**
   * `pauseProbe` (2026-09-16): whether the pause menu is up **on its own** (no settings overlay · warning popup above it) —
   * HudSystem supplies it. With none, the button never shows over a `'menu'` blocker.
   */
  constructor(parent: HTMLElement, private cutscene: CutsceneWatch | null = null, private pauseProbe: (() => boolean) | null = null) {
    this.root = el('div', { cls: 'community', parent });
    this.btn = el('button', { cls: 'cm-btn interactive', parent: this.root });
    this.btn.title = '메신저';
    el('span', { cls: 'cm-glyph', text: '✉', parent: this.btn });
    el('span', { cls: 'cm-tag', text: '메신저', parent: this.btn });
    this.countEl = el('span', { cls: 'cm-count ui-mono', text: '0', parent: this.btn });
    this.dot = el('i', { cls: 'cm-dot has-num ui-mono', parent: this.btn });
    this.dot.hidden = true;
    this.keyEl = createKeycap(Keys.INVITE, { parent: this.root });
    this.keyEl.classList.add('cm-key');
    this.inviteWrap = el('div', { cls: 'cm-invites', parent: this.root });
    this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    /* 2026-09-16: the button moves to be a direct child of `#ui-root` too — it has to stand over Tab windows · the pause menu, and the social layer hides on `'menu'`. */
    ctx.uiRoot.appendChild(this.root);
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
     * 2026-09-09 — **squad leader transfer**. Right-clicking a squadmate row in the 친구 tab (`.sc-srow[data-peer-id]`,
     * drawn by `menus/social/SocialColumn`) raises a menu. Nothing opens when I am not the host or I clicked myself (the same rule as the server's).
     */
    this.panel.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const row = (e.target as HTMLElement | null)?.closest?.('.sc-srow[data-peer-id]') as HTMLElement | null;
      const peerId = row?.dataset.peerId ?? null;
      const net = ctx.net;
      if (!peerId || !net?.lobby || !net.isHost || peerId === net.localId) { this.closeLeadMenu(); return; }
      const member = net.lobby.players.find((p) => p.id === peerId);
      // 2026-09-15 (android squadmates): a bot never becomes the host (a relay rule) — the transfer menu does not open.
      if (!member || !member.connected || isBotPlayer(member)) { this.closeLeadMenu(); return; }
      this.openLeadMenu(peerId, member.name || '분대원', e.clientX + 4, e.clientY + 4);
    });
    /* The menu · popup live under `#ui-root`, not the panel — so the panel's overflow never clips them. */
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
      ctx.bus.on('input:bindingsChanged', () => { this.inviteKey = STALE_KEY; paintKeycap(this.keyEl, Keys.INVITE); this.messengerView.refreshKeyLabels(); if (this._open) this.emitGuide(); }),
      ctx.bus.on('game:phaseChanged', () => { if (this._open && !ctx.isHubPhase()) this.close(); }),
      ctx.bus.on('game:newMission', () => { if (this._open) this.close(); }),
      /* 2026-09-14: the messenger */
      ctx.bus.on('npc:unreadChanged', () => { this.unreadAcc = 1; }),
      ctx.bus.on('social:unreadChanged', () => { this.unreadAcc = 1; }),
      ctx.bus.on('room:unreadChanged', () => { this.unreadAcc = 1; }),
      ctx.bus.on('room:updated', () => { this.unreadAcc = 1; }),
      // 2026-09-16: no toast — with the panel closed the red dot pops (after the badge has read the new count)
      ctx.bus.on('npc:message', () => { if (!this._open && ctx.isHubPhase()) { this.popPending = true; this.unreadAcc = 1; } }),
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
    const own = blockers.has(COMMUNITY_BLOCKER) ? 1 : 0;
    const free = blockers.size === own;
    /*
     * 2026-09-16: it stands **over a Tab window / the pause menu** too — only while that one screen (+ our panel) is up;
     * anything else stacked on top (salvage · settings · a warning popup · a tutorial popup …) hides it. The Tab window's
     * blocker token belongs to inventory/, so it is read through `InventoryRef.isOpen` (open = that token is there → a matching count means it alone).
     */
    const overInv = !free && blockers.size === 1 + own && (ctx.inventory?.isOpen ?? false);
    const overPause = !free && blockers.size === 1 + own && blockers.has(MENU_BLOCKER) && (this.pauseProbe?.() ?? false);
    const overMenu = overInv || overPause;
    const cutscene = this.cutscene?.active ?? (ctx.phase === 'docking' || (ctx.hub?.travelling ?? false));
    // 2026-09-08: while a tutorial runs the top-right button is hidden (so nothing leaks outside the guide)
    const tutorial = ctx.tutorial?.hides('community') ?? false;
    const on = ctx.isHubPhase() && (free || overMenu) && !cutscene && !tutorial;
    if (tutorial && this._open) this.close();
    if (on !== this.shown) {
      this.shown = on;
      toggleClass(this.root, 'show', on);
      if (!on) this.held = 0;
    }
    const kind = overInv ? 'inv' : overPause ? 'pause' : 'none';
    if (kind !== this.overKind) {
      this.overKind = kind;
      for (const n of [this.root, this.panel]) {
        toggleClass(n, 'over-inv', kind === 'inv');
        toggleClass(n, 'over-pause', kind === 'pause');
      }
    }
    if (this._open && (!ctx.isHubPhase() || cutscene)) this.close();
    // 2026-09-09: Tab closes every screen (the pause menu stacked on top keeps it, like P below).
    // 2026-09-16: a panel opened over a menu closes **only the panel** on Tab — the Tab window · pause menu below do not take Tab while this blocker is held.
    if (this._open && (free || overMenu) && ctx.input.wasPressed(Keys.INVENTORY)) {
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
      // a new NPC message pops once the badge is showing (the count at once; what arrived is never said)
      if (this.popPending && !this.dot.hidden) { this.popPending = false; this.popT = 0; }
    }
    this.stepPop(dt);

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
     * P (`Keys.INVITE`) — **tap = the messenger panel, hold = accept a squad invite** (2026-09-08). The toggle fires on *release*, and only
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
    if (ctx.input.wasReleased(Keys.INVITE) && !this.pAccepted && (free || overMenu) && (this.shown || this._open)
      && (this.cards.length === 0 || this.pHeld <= COMMUNITY_TAP_MAX_S)) this.toggle();
    this.applyHold();
  }

  /**
   * 2026-09-16 — one frame of the red dot's pop. The curve: up to the first peak (`MESSENGER_DOT_POP_PX`) and back down,
   * one smaller bounce, then back in place. For a moment at the start it swells a little and returns. An inline transform,
   * not a CSS animation (class comment — reduced motion). While idle it is one comparison.
   */
  private stepPop(dt: number): void {
    if (this.popT < 0) return;
    this.popT += Math.max(0, dt);
    const u = this.popT / Math.max(1e-3, MESSENGER_DOT_POP_S);
    if (u >= 1 || this.dot.hidden) {
      this.popT = -1;
      this.dot.style.transform = '';
      return;
    }
    // only the curve’s shape (ratios) lives here: the first peak at 55 % of the time, the second peak at 22 % of the height, the swell up to +25 % over the first 30 %
    const first = 0.55;
    const y = u < first
      ? MESSENGER_DOT_POP_PX * Math.sin(Math.PI * (u / first))
      : MESSENGER_DOT_POP_PX * 0.22 * Math.sin(Math.PI * ((u - first) / (1 - first)));
    const k = 1 + 0.25 * Math.sin(Math.PI * Math.min(1, u / 0.3));
    this.dot.style.transform = `translateY(${(-y).toFixed(2)}px) scale(${k.toFixed(3)})`;
  }

  /** Whether the red dot is popping right now (debug / smoke). */
  get isDotPopping(): boolean { return this.popT >= 0; }

  /* ── Squad leader transfer (2026-09-09) ───────────────────────────────── */
  /** The one-row menu attached to the right-clicked squadmate row. `leader:transferRequested` is the only door to net. */
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

  /** The squadmate the right-click menu is aimed at (debug / smoke). */
  get leaderMenuTarget(): string | null { return this.leadTarget; }

  /** Key guide entries for the open panel (the guide appends `Tab 닫기` itself; P is the panel's own close key). */
  private emitGuide(): void {
    this.ctx.bus.emit('ui:keyGuide', {
      owner: 'community',
      keys: [
        { key: keyLabel('Mouse2'), label: '메뉴' },   // 2026-09-15: the `RMB` label → the key guide draws it as the mouse glyph
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
      const top = el('div', { cls: 'cmi-top', parent: card });
      el('span', { cls: 'cmi-id ui-mono', text: formatPlayerCode(inv.from), parent: top });
      const x = el('button', { cls: 'cmi-x', text: '×', parent: top });
      x.title = '초대 거절';
      x.addEventListener('click', (e) => { e.stopPropagation(); socialOf(this.ctx)?.declineInvite(inv.from); this.inviteKey = STALE_KEY; });
      el('div', { cls: 'cmi-name', text: `${inv.name || '분대원'} 분대 초대`, parent: card });
      el('div', { cls: 'cmi-hint', text: `${keyLabel(Keys.INVITE)} 홀드로 참여`, parent: card });
      const bar = el('div', { cls: 'cmi-bar', parent: card });
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
    this.popPending = false;
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
