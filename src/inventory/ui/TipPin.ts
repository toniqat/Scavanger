/**
 * src/inventory/ui/TipPin.ts — **툴팁 고정** (2026-09-14, 사용자 결정).
 *
 * 아이템 타일을 LMB 로 누른 채 **움직이지 않고**(`DRAG_THRESHOLD` 안) `UI_HOLD_CONFIRM_S` 동안 있으면 커서에 원형 게이지가 차오르고
 * (`ui:cursorHold` → `ui/hud/CursorHoldGauge`), 다 차면 그 아이템의 인벤토리 툴팁이 **제자리에 고정**된다 — 커서를 따라가지 않고,
 * 우상단 모서리에 작은 마름모(`.inv-tt-pin`)가 튀어나온다. 다 차기 전에 문턱을 넘게 움직이면 평소의 드래그이고 게이지는 사라진다.
 * 다 차기 전에 떼면 평소의 클릭이다 (이 파일은 그 누름을 건드리지 않는다 — 호스트가 자기 드래그 상태를 그대로 쓴다).
 *
 * 풀리는 때: 고정 카드 **바깥** 어디든 누르기(window capture `pointerdown` — 그 누름은 그대로 아래로 간다) · 마름모 누르기 · Escape
 * (`ctx.escape` 의 맨 위 항목) · 창이 닫힘(호스트의 `hide` / `dispose`) · 아이템이 사라짐(`validate`) · 다른 곳에서 새로 고정됨
 * (`ui:tipPinned` — 화면 전체에 고정은 하나).
 *
 * **고정한 무기 카드의 소켓** — 썸네일에 올리면 그 부착물의 카드가 떠다니는 호버 카드(`host.hoverTip`)로 뜬다. 무기가 소켓을 만질 수 있는
 * 자리(가방 · 장비칸 · 함선 창고 — `InventoryRef.canDetachSockets`)에 있으면 썸네일을 끌어 격자 칸 · 버리기 영역에 놓을 수 있다
 * (`host.aimDetach` 가 칸을 고르고 강조하며 `InventorySystem.detachSocket` 이 옮긴다). 상자 · 시체 안의 무기는 호버 카드만이다.
 * 소켓이 바뀌면 고정 카드가 다시 그려진다(`validate` — 서명이 바뀔 때만).
 *
 * 떠다니는 호버 카드와의 관계(결정): 고정한 채로 **다른** 아이템에 올리면 평소 호버 카드가 뜬다 — 두 아이템을 나란히 비교하는 것이
 * 고정의 가장 흔한 쓰임이라서다. 고정한 **그** 아이템의 타일에서는 호버 카드를 띄우지 않는다 (같은 카드가 둘이 된다).
 *
 * 호스트가 둘이다: Tab 창(`InventoryUI` — 가방 · 창고 · 장비칸 · 휠 · 주머니 · 상자/시체 창)과 끼워 넣는 격자(`TradeGrids` — 기업 화면 ·
 * 함선 스테이션). 격자 모양 · 드롭 대상 · 고스트 모양은 호스트마다 다르므로 `TipPinHost` 로 묻는다.
 */
import type { GameContext, ItemDef, ItemInstance, SocketSlot } from '@/shared';
import { SOCKET_SLOTS, UI_HOLD_CONFIRM_S } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { DetachTarget, ItemLocation, OpResult } from '../model';
import type { InventorySystem } from '../InventorySystem';
import { Tooltip, type TooltipLookups } from './Tooltip';
import { DRAG_THRESHOLD } from './model';

/** 끌고 있는 소켓 하나. */
export interface SocketDrag {
  weaponUid: string;
  socket: SocketSlot;
  item: ItemInstance;
  def: ItemDef;
}

/** 포인터 아래에서 고른 놓을 곳 — `ok` false 면 빨갛게 강조되고 놓아도 아무 일도 없다. */
export interface DetachAim {
  target: DetachTarget;
  ok: boolean;
}

export interface TipPinHost {
  /** `escape` 키 · `ui:tipPinned` owner 의 머리 (인스턴스마다 번호가 붙는다). */
  owner: string;
  /** 고정 카드(`TipPin.el`)를 붙인다 — 생성자에서 한 번. */
  mount(el: HTMLElement): void;
  /** 떠다니는 호버 카드 — 고정 카드 소켓 썸네일의 부착물 카드로도 쓴다. 고정하는 순간 내린다. */
  hoverTip: Tooltip;
  /** 고정할 자리 — 떠 있던 호버 카드의 `transform` (없으면 누른 자리 기준으로 새로 잡는다). */
  pinAnchor?(): string | null;
  /** 끄는 부착물의 고스트 (호스트의 드래그 고스트와 같은 모양) — 반 크기와 함께. */
  buildGhost(item: ItemInstance, def: ItemDef): { el: HTMLElement; halfW: number; halfH: number };
  ghostParent: HTMLElement;
  /** 아이템이 지금 있는 곳 (null = 사라졌다 → 고정이 풀린다). */
  locate(uid: string): { item: ItemInstance; from: ItemLocation } | null;
  /** 이 무기의 소켓을 끌어낼 수 있나. */
  canDetach(weaponUid: string): boolean;
  /** 포인터 아래 놓을 곳을 고르고 칸을 강조한다. null = 놓을 곳이 없다 (놓으면 제자리). */
  aimDetach(px: number, py: number, drag: SocketDrag): DetachAim | null;
  clearDetachAim(): void;
  detach(drag: SocketDrag, target: DetachTarget): OpResult;
  /** 소켓 드래그가 시작 / 끝났다 (Tab 창은 `.is-dragging` 으로 버리기 영역을 띄운다). */
  onSocketDrag?(active: boolean): void;
}

/** 두 호스트가 같은 툴팁 조회를 쓴다 (`InventoryUI` 의 떠다니는 카드와 같은 내용). */
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
  onFire?: () => void;
}

interface SocketPress {
  drag: SocketDrag;
  x0: number; y0: number;
  started: boolean;
  ghost: { el: HTMLElement; halfW: number; halfH: number } | null;
}

/** 다시 그릴지 가르는 서명 — 카드에 보이는 인스턴스 필드 + 끌 수 있는지. */
function pinSignature(item: ItemInstance, canDetach: boolean): string {
  let s = `${item.defId}|${item.qty}|${item.durability ?? ''}|${item.ammoInMag ?? ''}|${item.quality ?? ''}|${canDetach ? 1 : 0}|`;
  if (item.sockets) for (const k of SOCKET_SLOTS) s += `${item.sockets[k]?.uid ?? ''},`;
  return s;
}

let ownerSeq = 0;

export class TipPin {
  /** 고정 카드 (`Tooltip.el` + `.is-pinned`). 고정되지 않은 동안 `hidden`. */
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
      // 화면 전체에 고정은 하나 — 다른 곳이 고정하면 이쪽이 푼다
      b.on('ui:tipPinned', ({ owner, uid }) => { if (uid !== null && owner !== this.owner) this.unpin(); }),
    );
  }

  /* ── 상태 (smoke · 호스트) ─────────────────────────────────────────────── */

  get isHolding(): boolean { return this.hold !== null; }
  get isPinned(): boolean { return this.pinned !== null; }
  get pinnedUid(): string | null { return this.pinned?.uid ?? null; }
  get isSocketDragging(): boolean { return !!this.sock?.started; }

  /* ── 누르고 있기 ───────────────────────────────────────────────────────── */

  /**
   * 타일에서 LMB 누르기가 시작됐다. 움직이지 않고 `UI_HOLD_CONFIRM_S` 가 지나면 `onFire`(호스트가 아직 드래그가 아닌 누름을 버린다)
   * 뒤에 고정한다. 문턱을 넘게 움직이거나 떼면 취소.
   */
  beginHold(uid: string, x: number, y: number, onFire?: () => void): void {
    this.cancelHold();
    if (this.disposed) return;
    const ms = Math.max(50, UI_HOLD_CONFIRM_S * 1000);
    const h: HoldState = { uid, x0: x, y0: y, x, y, t0: performance.now(), ms, timer: 0, raf: 0, onFire };
    this.hold = h;
    // 확정은 타이머, 게이지는 rAF (`shared/holdAsk` 와 같은 규약 — 프레임이 멈춰도 1 초에 확정된다)
    h.timer = window.setTimeout(() => this.fireHold(), ms);
    if (typeof requestAnimationFrame === 'function') h.raf = requestAnimationFrame(this.holdFrame);
    window.addEventListener('pointermove', this.onHoldMove, true);
    window.addEventListener('pointerup', this.onHoldEnd, true);
    window.addEventListener('pointercancel', this.onHoldEnd, true);
    this.emitHold(0);
  }

  /** 누르기 취소 — 링이 내려간다. 없으면 아무 일도 없다. */
  cancelHold(): void {
    const h = this.hold;
    if (!h) return;
    this.hold = null;
    clearTimeout(h.timer);
    if (h.raf) cancelAnimationFrame(h.raf);
    window.removeEventListener('pointermove', this.onHoldMove, true);
    window.removeEventListener('pointerup', this.onHoldEnd, true);
    window.removeEventListener('pointercancel', this.onHoldEnd, true);
    this.ctx.bus.emit('ui:cursorHold', { owner: this.owner, progress: null });
  }

  private emitHold(t: number): void {
    const h = this.hold;
    if (h) this.ctx.bus.emit('ui:cursorHold', { owner: this.owner, progress: t, x: h.x, y: h.y });
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
    if (Math.hypot(h.x - h.x0, h.y - h.y0) >= DRAG_THRESHOLD) this.cancelHold();   // 평소의 드래그 — 호스트가 이어 받는다
  };

  private onHoldEnd = (): void => { this.cancelHold(); };

  private fireHold(): void {
    const h = this.hold;
    if (!h) return;
    this.cancelHold();
    h.onFire?.();
    this.pinAt(h.uid, h.x, h.y);
  }

  /* ── 고정 / 해제 ───────────────────────────────────────────────────────── */

  /** `uid` 의 툴팁을 고정한다 (이미 다른 것이 고정돼 있으면 갈아 끼운다). 아이템을 못 찾으면 false. */
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

  /** 고정을 푼다 (없으면 아무 일도 없다). */
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
   * 고정한 아이템이 아직 있나 · 카드가 낡았나. 사라졌으면 풀고, 서명(소켓 · 내구도 · 장전 · 수량 …)이 바뀌었으면 같은 자리에 다시 그린다.
   * 호스트의 `refresh` 와 인벤토리 이벤트(마이크로태스크로 합친다)가 부른다 — 싸다.
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
    this.unpin();   // 그 누름은 그대로 아래로 간다 (다른 타일을 누르면 그 타일의 누르기 · 드래그가 평소대로 시작된다)
  };

  /* ── 고정 카드의 소켓: 호버 카드 · 끌어내기 ─────────────────────────────── */

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

  /** (x, y) 가 고정 카드 위인가 — 거기서 놓으면 아무 일도 없다. */
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
    if (!started || !aim) return;   // 소켓 썸네일 클릭 · 놓을 곳이 없는 곳 — 제자리
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
