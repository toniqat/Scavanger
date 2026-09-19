/**
 * src/inventory/ui/TipPin.ts — **the pinned tooltip** (2026-09-14, user's decision).
 *
 * Holding LMB on an item tile **without moving** (inside `DRAG_THRESHOLD`) for `UI_HOLD_CONFIRM_S` fills a ring gauge on the cursor
 * (`ui:cursorHold` → `ui/hud/CursorHoldGauge`); once full, that item's inventory tooltip is **pinned in place** — it stops following
 * the cursor and a small diamond (`.inv-tt-pin`) juts out of its top-right corner. Moving past the threshold before it fills is the
 * ordinary drag and the gauge goes; releasing before it fills is the ordinary click (this file leaves that press alone — the host keeps its own drag state).
 *
 * It releases on: a press anywhere **outside** the pinned card (window capture `pointerdown` — that press still goes through below) ·
 * a press on the diamond · Escape (the top entry of `ctx.escape`) · the window closing (the host's `hide` / `dispose`) · the item
 * disappearing (`validate`) · something else pinning (`ui:tipPinned` — there is exactly one pin on the whole screen).
 *
 * **The sockets of a pinned weapon card** — hovering a thumbnail shows that attachment's card as the floating hover card (`host.hoverTip`).
 * While the weapon sits where its sockets can be touched (bag · equipment slot · 함선 창고 — `InventoryRef.canDetachSockets`), the thumbnail
 * can be dragged onto a grid cell or the drop zone (`host.aimDetach` picks and highlights the cell, `InventorySystem.detachSocket` moves it).
 * A weapon inside a crate · corpse is hover-card only. A socket change redraws the pinned card (`validate` — only when the signature changed).
 *
 * Its relation to the floating hover card (a decision): hovering **another** item while one is pinned still shows the usual hover card —
 * comparing two items side by side is the commonest use of pinning. The pinned item's **own** tile shows none (it would be the same card twice).
 *
 * There are two hosts: the Tab window (`InventoryUI` — bag · stash · equipment slots · the wheel · pouches · crate/corpse windows) and
 * the embedded grids (`TradeGrids` — 기업 screens · ship stations). Grid shape · drop targets · ghost shape differ per host, so `TipPinHost` asks.
 */
import type { GameContext, ItemDef, ItemInstance, SocketSlot } from '@/shared';
import { SOCKET_SLOTS, UI_HOLD_CONFIRM_S } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { DetachTarget, ItemLocation, OpResult } from '../model';
import type { InventorySystem } from '../InventorySystem';
import { Tooltip, type TooltipLookups } from './Tooltip';
import { DRAG_THRESHOLD } from './model';

/** One socket being dragged. */
export interface SocketDrag {
  weaponUid: string;
  socket: SocketSlot;
  item: ItemInstance;
  def: ItemDef;
}

/** The drop spot picked under the pointer — with `ok` false it is highlighted red and releasing does nothing. */
export interface DetachAim {
  target: DetachTarget;
  ok: boolean;
}

export interface TipPinHost {
  /** The head of the `escape` key · `ui:tipPinned` owner (each instance gets a number). */
  owner: string;
  /** Mounts the pinned card (`TipPin.el`) — once, from the constructor. */
  mount(el: HTMLElement): void;
  /** The floating hover card — also the attachment card of a pinned card's socket thumbnail. Taken down the moment something is pinned. */
  hoverTip: Tooltip;
  /** Where to pin — the floating hover card's `transform` (with none, a new spot is taken from the press position). */
  pinAnchor?(): string | null;
  /** The ghost of the attachment being dragged (the same shape as the host's drag ghost) — with its half size. */
  buildGhost(item: ItemInstance, def: ItemDef): { el: HTMLElement; halfW: number; halfH: number };
  ghostParent: HTMLElement;
  /** Where the item is right now (null = gone → the pin releases). */
  locate(uid: string): { item: ItemInstance; from: ItemLocation } | null;
  /** Whether this weapon's sockets can be dragged out. */
  canDetach(weaponUid: string): boolean;
  /** Picks the drop spot under the pointer and highlights the cell. null = no spot (releasing leaves it where it was). */
  aimDetach(px: number, py: number, drag: SocketDrag): DetachAim | null;
  clearDetachAim(): void;
  detach(drag: SocketDrag, target: DetachTarget): OpResult;
  /** A socket drag started / ended (the Tab window raises its drop zone with `.is-dragging`). */
  onSocketDrag?(active: boolean): void;
}

/** Both hosts use the same tooltip lookups (the same content as `InventoryUI`'s floating card). */
export function inventoryTooltipLookups(sys: InventorySystem, ctx: GameContext): TooltipLookups {
  const loot = sys.getLoot();
  return {
    getWeapon: getWeaponDef,
    getDef: (id) => ITEM_DEF_MAP.get(id),
    getStats: (item) => sys.getStats(item),
    getArmorDef: (id) => loot.getArmorDef(id),
    getSkillName: (id) => { try { return ctx.progression?.getSkillDef(id)?.name ?? id; } catch { return id; } },
    getStatName: (id) => { try { return ctx.progression?.getStatDef(id)?.name ?? id; } catch { return id; } },
    countOwned: (defId) => sys.countDefAll(defId),
    getBaseStats: (defId) => loot.getEffectiveStats(defId),
    allWeaponItemDefs: () => loot.getAllItemDefs().filter((d) => d.weaponId !== undefined),
    findAmmoDef: (type) => loot.getAllItemDefs().find((d) => d.category === 'ammo' && d.ammoType === type),
  };
}

interface HoldState {
  uid: string;
  x0: number; y0: number;
  x: number; y: number;
  t0: number;
  ms: number;
  timer: number;
  raf: number;
  /** 2026-09-15: whether this hold has put the ring up yet (it waits for `RING_SHOW_AT`). */
  ringShown: boolean;
  onFire?: () => void;
}

/**
 * 2026-09-15 (user's decision): the ring appears only once progress reaches this fraction — so a short press such as a double-click or
 * the start of a drag does not flash a ring on the cursor. From there it draws the real progress (from 0.25) and the confirm time
 * (`UI_HOLD_CONFIRM_S`) is unchanged. The threshold is the pinned tooltip's alone — the ship management move hold (`housing:moveHold`) is untouched.
 */
const RING_SHOW_AT = 0.25;

interface SocketPress {
  drag: SocketDrag;
  x0: number; y0: number;
  started: boolean;
  ghost: { el: HTMLElement; halfW: number; halfH: number } | null;
}

/** The signature that decides a redraw — the instance fields the card shows + whether it can be dragged out. */
function pinSignature(item: ItemInstance, canDetach: boolean): string {
  let s = `${item.defId}|${item.qty}|${item.durability ?? ''}|${item.ammoInMag ?? ''}|${item.quality ?? ''}|${canDetach ? 1 : 0}|`;
  if (item.sockets) for (const k of SOCKET_SLOTS) s += `${item.sockets[k]?.uid ?? ''},`;
  return s;
}

let ownerSeq = 0;

export class TipPin {
  /** The pinned card (`Tooltip.el` + `.is-pinned`). `hidden` while nothing is pinned. */
  readonly el: HTMLElement;
  private readonly tip: Tooltip;
  private readonly owner: string;
  private readonly escKey: string;
  private hold: HoldState | null = null;
  private pinned: { uid: string; loc: ItemLocation; sig: string; transform: string } | null = null;
  private sock: SocketPress | null = null;
  private hoverSocket: SocketSlot | null = null;
  private validateQueued = false;
  private readonly unsubs: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly ctx: GameContext, lookups: TooltipLookups, private readonly host: TipPinHost) {
    this.owner = `${host.owner}#${++ownerSeq}`;
    this.escKey = `inventory.tipPin:${this.owner}`;
    this.tip = new Tooltip(lookups);
    this.el = this.tip.el;
    this.el.classList.add('is-pinned');
    host.mount(this.el);
    this.el.addEventListener('pointerover', this.onTipOver);
    this.el.addEventListener('pointermove', this.onTipMove);
    this.el.addEventListener('pointerout', this.onTipOut);
    this.el.addEventListener('pointerdown', this.onTipDown);
    this.el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    const b = ctx.bus;
    const later = (): void => this.scheduleValidate();
    this.unsubs.push(
      b.on('inventory:socketChanged', later), b.on('inventory:itemUpdated', later), b.on('inventory:changed', later),
      b.on('inventory:stashChanged', later), b.on('inventory:bagChanged', later), b.on('loadout:changed', later),
      // exactly one pin on the whole screen — when somewhere else pins, this one releases
      b.on('ui:tipPinned', ({ owner, uid }) => { if (uid !== null && owner !== this.owner) this.unpin(); }),
    );
  }

  /* ── state (smokes · the host) ─────────────────────────────────────────── */

  get isHolding(): boolean { return this.hold !== null; }
  get isPinned(): boolean { return this.pinned !== null; }
  get pinnedUid(): string | null { return this.pinned?.uid ?? null; }
  get isSocketDragging(): boolean { return !!this.sock?.started; }

  /* ── holding ───────────────────────────────────────────────────────────── */

  /**
   * An LMB press started on a tile. If `UI_HOLD_CONFIRM_S` passes without moving, `onFire` runs (the host drops the press that
   * is not yet a drag) and then it pins. Moving past the threshold or releasing cancels.
   */
  beginHold(uid: string, x: number, y: number, onFire?: () => void): void {
    this.cancelHold();
    if (this.disposed) return;
    const ms = Math.max(50, UI_HOLD_CONFIRM_S * 1000);
    const h: HoldState = { uid, x0: x, y0: y, x, y, t0: performance.now(), ms, timer: 0, raf: 0, ringShown: false, onFire };
    this.hold = h;
    // the confirm is a timer, the gauge is rAF (the same contract as `shared/holdAsk` — it confirms at 1 s even if frames stall)
    h.timer = window.setTimeout(() => this.fireHold(), ms);
    if (typeof requestAnimationFrame === 'function') h.raf = requestAnimationFrame(this.holdFrame);
    window.addEventListener('pointermove', this.onHoldMove, true);
    window.addEventListener('pointerup', this.onHoldEnd, true);
    window.addEventListener('pointercancel', this.onHoldEnd, true);
    this.emitHold(0);
  }

  /** Cancels the hold — the ring goes down. Nothing happens with no hold. */
  cancelHold(): void {
    const h = this.hold;
    if (!h) return;
    this.hold = null;
    clearTimeout(h.timer);
    if (h.raf) cancelAnimationFrame(h.raf);
    window.removeEventListener('pointermove', this.onHoldMove, true);
    window.removeEventListener('pointerup', this.onHoldEnd, true);
    window.removeEventListener('pointercancel', this.onHoldEnd, true);
    // 2026-09-15: a hold that never reached `RING_SHOW_AT` never put the ring up — nothing to take down
    if (h.ringShown) this.ctx.bus.emit('ui:cursorHold', { owner: this.owner, progress: null });
  }

  /** Ring progress — silent below `RING_SHOW_AT` (2026-09-15), the real fraction from there on. */
  private emitHold(t: number): void {
    const h = this.hold;
    if (!h || t < RING_SHOW_AT) return;
    h.ringShown = true;
    this.ctx.bus.emit('ui:cursorHold', { owner: this.owner, progress: t, x: h.x, y: h.y });
  }

  private holdFrame = (): void => {
    const h = this.hold;
    if (!h) return;
    h.raf = 0;
    const t = Math.min(1, (performance.now() - h.t0) / h.ms);
    this.emitHold(t);
    if (t < 1) h.raf = requestAnimationFrame(this.holdFrame);
  };

  private onHoldMove = (e: PointerEvent): void => {
    const h = this.hold;
    if (!h) return;
    h.x = e.clientX; h.y = e.clientY;
    if (Math.hypot(h.x - h.x0, h.y - h.y0) >= DRAG_THRESHOLD) this.cancelHold();   // the ordinary drag — the host takes it from here
  };

  private onHoldEnd = (): void => { this.cancelHold(); };

  private fireHold(): void {
    const h = this.hold;
    if (!h) return;
    this.cancelHold();
    h.onFire?.();
    this.pinAt(h.uid, h.x, h.y);
  }

  /* ── pin / unpin ───────────────────────────────────────────────────────── */

  /** Pins `uid`'s tooltip (swapping out whatever was pinned before). false when the item cannot be found. */
  pinAt(uid: string, x: number, y: number): boolean {
    if (this.disposed) return false;
    const found = this.host.locate(uid);
    const def = found ? ITEM_DEF_MAP.get(found.item.defId) : undefined;
    if (!found || !def) return false;
    const anchor = this.host.pinAnchor?.() ?? null;
    this.endSocketDrag();
    const wasPinned = this.pinned !== null;
    this.pinned = { uid, loc: found.from, sig: '', transform: '' };
    this.render(found.item, def, x, y);
    this.pinned.transform = anchor || this.el.style.transform;
    this.el.style.transform = this.pinned.transform;
    this.host.hoverTip.hide();
    this.hoverSocket = null;
    if (!wasPinned) window.addEventListener('pointerdown', this.onOutsideDown, true);
    this.ctx.escape.push(this.escKey, () => { this.unpin(); });
    this.ctx.bus.emit('ui:tipPinned', { owner: this.owner, uid });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    return true;
  }

  /** Releases the pin (nothing happens with none). */
  unpin(): void {
    const p = this.pinned;
    if (!p) return;
    this.pinned = null;
    this.endSocketDrag();
    window.removeEventListener('pointerdown', this.onOutsideDown, true);
    this.ctx.escape.remove(this.escKey);
    if (this.hoverSocket) { this.hoverSocket = null; this.host.hoverTip.hide(); }
    this.tip.hide();
    delete this.el.dataset.uid;
    this.ctx.bus.emit('ui:tipPinned', { owner: this.owner, uid: null });
  }

  /**
   * Is the pinned item still there · is the card stale. Gone → it unpins; a changed signature (sockets · durability · magazine ·
   * quantity …) → redrawn in the same spot. Called by the host's `refresh` and by inventory events (coalesced in a microtask) — cheap.
   */
  validate(): void {
    const p = this.pinned;
    if (!p) return;
    const found = this.host.locate(p.uid);
    const def = found ? ITEM_DEF_MAP.get(found.item.defId) : undefined;
    if (!found || !def) { this.unpin(); return; }
    p.loc = found.from;
    if (pinSignature(found.item, this.host.canDetach(p.uid)) === p.sig) return;
    this.render(found.item, def, 0, 0);
    this.el.style.transform = p.transform;
  }

  private scheduleValidate(): void {
    if (!this.pinned || this.validateQueued) return;
    this.validateQueued = true;
    queueMicrotask(() => { this.validateQueued = false; this.validate(); });
  }

  private render(item: ItemInstance, def: ItemDef, x: number, y: number): void {
    this.tip.show(item, def, x, y);
    const diamond = document.createElement('button');
    diamond.type = 'button';
    diamond.className = 'inv-tt-pin';
    diamond.title = '고정 해제';
    diamond.setAttribute('aria-label', '고정 해제');
    this.el.appendChild(diamond);
    const canDetach = this.host.canDetach(item.uid);
    for (const sq of this.el.querySelectorAll<HTMLElement>('.inv-tt-sock.is-filled')) sq.classList.toggle('can-detach', canDetach);
    this.el.dataset.uid = item.uid;
    if (this.pinned) this.pinned.sig = pinSignature(item, canDetach);
  }

  private onOutsideDown = (e: PointerEvent): void => {
    const t = e.target as Node | null;
    if (t && this.el.contains(t)) return;
    this.unpin();   // that press still goes through below (pressing another tile starts that tile's press · drag as usual)
  };

  /* ── the pinned card's sockets: hover card · dragging out ───────────────── */

  private socketAt(target: EventTarget | null): HTMLElement | null {
    const n = target as Element | null;
    return n && typeof n.closest === 'function' ? n.closest<HTMLElement>('.inv-tt-sock.is-filled') : null;
  }

  private attachmentIn(socket: SocketSlot): SocketDrag | null {
    const p = this.pinned;
    if (!p) return null;
    const att = this.host.locate(p.uid)?.item.sockets?.[socket];
    const def = att ? ITEM_DEF_MAP.get(att.defId) : undefined;
    return att && def ? { weaponUid: p.uid, socket, item: att, def } : null;
  }

  private onTipOver = (e: PointerEvent): void => {
    if (this.sock?.started) return;
    const sq = this.socketAt(e.target);
    const socket = sq?.dataset.socket as SocketSlot | undefined;
    if (!socket || socket === this.hoverSocket) return;
    const a = this.attachmentIn(socket);
    if (!a) return;
    this.hoverSocket = socket;
    this.host.hoverTip.show(a.item, a.def, e.clientX, e.clientY);
  };

  private onTipMove = (e: PointerEvent): void => {
    if (this.hoverSocket && !this.sock?.started) this.host.hoverTip.move(e.clientX, e.clientY);
  };

  private onTipOut = (e: PointerEvent): void => {
    if (!this.hoverSocket) return;
    const to = this.socketAt(e.relatedTarget);
    if (to && to.dataset.socket === this.hoverSocket) return;
    this.hoverSocket = null;
    this.host.hoverTip.hide();
  };

  private onTipDown = (e: PointerEvent): void => {
    const t = e.target as Element | null;
    if (t && typeof t.closest === 'function' && t.closest('.inv-tt-pin')) {
      e.preventDefault();
      e.stopPropagation();
      this.unpin();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      return;
    }
    if (e.button !== 0) return;
    const sq = this.socketAt(t);
    if (!sq || !sq.classList.contains('can-detach')) return;
    const a = this.attachmentIn(sq.dataset.socket as SocketSlot);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    this.endSocketDrag();
    this.sock = { drag: a, x0: e.clientX, y0: e.clientY, started: false, ghost: null };
    window.addEventListener('pointermove', this.onSockMove, true);
    window.addEventListener('pointerup', this.onSockUp, true);
    window.addEventListener('pointercancel', this.onSockUp, true);
  };

  /** Whether (x, y) is over the pinned card — releasing there does nothing. */
  private overCard(x: number, y: number): boolean {
    const under = document.elementFromPoint(x, y);
    return !!under && this.el.contains(under);
  }

  private onSockMove = (e: PointerEvent): void => {
    const s = this.sock;
    if (!s) return;
    const x = e.clientX, y = e.clientY;
    if (!s.started) {
      if (Math.hypot(x - s.x0, y - s.y0) < DRAG_THRESHOLD) return;
      s.started = true;
      if (this.hoverSocket) { this.hoverSocket = null; this.host.hoverTip.hide(); }
      s.ghost = this.host.buildGhost(s.drag.item, s.drag.def);
      s.ghost.el.classList.add('inv-sock-ghost');
      this.host.ghostParent.appendChild(s.ghost.el);
      this.el.classList.add('is-sock-dragging');
      this.el.querySelector<HTMLElement>(`.inv-tt-sock[data-socket="${s.drag.socket}"]`)?.classList.add('is-dragging');
      this.host.onSocketDrag?.(true);
      this.ctx.bus.emit('audio:play', { id: 'ui_pickup' });
    }
    const g = s.ghost;
    if (g) g.el.style.transform = `translate3d(${Math.round(x - g.halfW)}px, ${Math.round(y - g.halfH)}px, 0)`;
    let aim: DetachAim | null = null;
    if (this.overCard(x, y)) this.host.clearDetachAim();
    else aim = this.host.aimDetach(x, y, s.drag);
    g?.el.classList.toggle('is-ok', !!aim?.ok);
    g?.el.classList.toggle('is-bad', !!aim && !aim.ok);
  };

  private onSockUp = (e: PointerEvent): void => {
    const s = this.sock;
    if (!s) return;
    const started = s.started;
    const aim = started && e.type === 'pointerup' && !this.overCard(e.clientX, e.clientY)
      ? this.host.aimDetach(e.clientX, e.clientY, s.drag)
      : null;
    this.endSocketDrag();
    if (!started || !aim) return;   // a click on the socket thumbnail · nowhere to drop — it stays put
    if (!aim.ok) { this.ctx.bus.emit('audio:play', { id: 'ui_error' }); return; }
    const r = this.host.detach(s.drag, aim.target);
    this.ctx.bus.emit('audio:play', { id: r === 'ok' ? 'ui_drop' : 'ui_error' });
    this.validate();
  };

  private endSocketDrag(): void {
    const s = this.sock;
    if (!s) return;
    this.sock = null;
    window.removeEventListener('pointermove', this.onSockMove, true);
    window.removeEventListener('pointerup', this.onSockUp, true);
    window.removeEventListener('pointercancel', this.onSockUp, true);
    if (!s.started) return;
    s.ghost?.el.remove();
    this.host.clearDetachAim();
    this.el.classList.remove('is-sock-dragging');
    this.el.querySelector('.inv-tt-sock.is-dragging')?.classList.remove('is-dragging');
    this.host.onSocketDrag?.(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelHold();
    this.unpin();
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.tip.dispose();
  }
}
