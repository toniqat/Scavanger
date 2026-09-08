import type { GameContext, SquadInvite } from '@/shared';
import {
  COMMUNITY_BLOCKER, Keys, SQUAD_INVITE_HOLD_S, SQUAD_INVITE_MAX, formatPlayerCode, keyLabel,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';
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
 *   - clicking it opens the 커뮤니티 panel, which reuses the **same `SocialColumn`** as the ESC screen (blocker
 *     `COMMUNITY_BLOCKER` + `setCursorMode(true, COMMUNITY_BLOCKER)` per the Phase 10 cursor rules — never
 *     `exitPointerLock`), emits `ui:communityToggled` and closes on Escape;
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

  private onKey = (e: KeyboardEvent): void => {
    if (!this._open || e.code !== Keys.MENU) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.close();
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
    const close = el('button', { cls: 'ui-btn small cp-close', text: '닫기 (Esc)', parent: head });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.column = new SocialColumn(frame, {
      squad: true,
      onWhisper: (code, name) => { this.close(); ctx.bus.emit('chat:whisperTo', { code, name }); },
    });
    this.column.bind(ctx);
    this.panel.addEventListener('mousedown', (e) => e.stopPropagation());
    this.panel.addEventListener('contextmenu', (e) => e.preventDefault());

    this.unsubs.push(
      ctx.bus.on('social:updated', () => { this.inviteKey = ''; }),
      ctx.bus.on('social:invited', () => { this.inviteKey = ''; }),
      ctx.bus.on('social:inviteClosed', () => { this.inviteKey = ''; this.held = 0; }),
      ctx.bus.on('input:bindingsChanged', () => { this.inviteKey = ''; }),
      ctx.bus.on('game:phaseChanged', () => { if (this._open && !ctx.isHubPhase()) this.close(); }),
      ctx.bus.on('game:newMission', () => { if (this._open) this.close(); }),
    );
    window.addEventListener('keydown', this.onKey, true);
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
    if (!on && !this._open) return;

    const social = socialOf(ctx);
    const count = social?.available ? social.onlineFriends : 0;
    if (count !== this.lastCount) { this.lastCount = count; setText(this.countEl, String(count)); }
    const news = !!social?.available && social.hasNews;
    if (news !== this.lastNews) { this.lastNews = news; this.dot.hidden = !news; }

    const invites = (social?.available ? social.invites : []).slice(-SQUAD_INVITE_MAX);
    const key = invites.map((v) => `${v.from}|${v.name}`).join(',');
    if (key !== this.inviteKey) { this.inviteKey = key; this.rebuildInvites(invites); }

    /* P hold on the newest invite (rendered first, right under the thumbnail). */
    if (this.cards.length === 0) { this.held = 0; this.applyHold(); return; }
    const holding = this.shown && blockers.size === 0 && ctx.input.isDown(Keys.INVITE);
    this.held = holding ? this.held + dt : 0;
    if (holding && this.held >= SQUAD_INVITE_HOLD_S) {
      const from = this.cards[0].from;
      this.held = 0;
      social?.acceptInvite(from);
      this.inviteKey = '';
    }
    this.applyHold();
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
    ctx.bus.emit('ui:communityToggled', { open: true });
    ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this._open) return;
    const ctx = this.ctx;
    this._open = false;
    this.panel.hidden = true;
    this.column.contextMenu?.close();
    ctx.uiBlockers.delete(COMMUNITY_BLOCKER);
    ctx.input.setCursorMode(false, COMMUNITY_BLOCKER);
    ctx.bus.emit('ui:communityToggled', { open: false });
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    window.removeEventListener('keydown', this.onKey, true);
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
