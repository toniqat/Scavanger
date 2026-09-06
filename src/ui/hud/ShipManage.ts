import type { FurnitureDef, FurnitureModelKind, GameContext, ItemDef, RoomPurpose } from '@/shared';
import {
  renderItemCost, ROOM_PURPOSES, ROOM_PURPOSES_ACTIVE, ROOM_PURPOSE_DESC_KO, ROOM_PURPOSE_LABEL_KO, SHIP_ROOM_COUNT,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';

interface RoomRow {
  index: number;
  root: HTMLButtonElement;
  purposeEl: HTMLElement;
  countEl: HTMLElement;
  key: string;
}

interface Card {
  defId: string;
  root: HTMLButtonElement;
}

/** Glyph per procedural furniture model (no asset files — the card thumbnail is a tinted frame + a character). */
const MODEL_GLYPH: Readonly<Record<FurnitureModelKind, string>> = {
  bench_gun: '⚒', bench_gear: '⛭', bench_gadget: '⚙', bench_medical: '✚',
  range_console: '▣', target_lane: '◎', sim_hub: '◈',
  grow_rack: '❀', repair_bench: '⛏', bookshelf: '▤',
  locker: '▤', table: '▭', shelf: '☰', crate: '▨', lamp: '☀', plant: '❦', chair: '⌂', bunk: '▬',
};

/** Purposes offered to an empty room (빈 방 itself is the "clear" action in the header instead). */
const ASSIGNABLE: readonly RoomPurpose[] = ROOM_PURPOSES.filter((p) => p !== 'empty');

/**
 * 시설 관리 screen (`.ship-manage`, Phase 8) — the DOM half of `ctx.housing`'s manage mode (M in the ship). It lives in
 * the **`.hud.housing`** layer so it is never gated by the gameplay / social visibility logic, and is `.interactive`
 * (the layer itself is `pointer-events: none`).
 *
 *   - **Left**: 방 목록 — `SHIP_ROOM_COUNT` rows with the 1-based room number, its `RoomPurpose` label and how many
 *     pieces it holds. Clicking one calls `ctx.housing.setManageRoom(i)`; the active room is highlighted.
 *   - **Right** (Phase 8 UI pass — it used to be a horizontal bar along the bottom): a vertical side panel that shows
 *     one of two things for the selected room:
 *       · an **empty** room → the 용도 지정 picker: every assignable `RoomPurpose`, disabled with the 한국어 reason
 *         from `ctx.housing.purposeBlock` when the rules refuse it (room 1 is the locked 작업실).
 *       · a room **with a purpose** → the 가구 목록: one row per furniture def allowed there
 *         (`getFurnitureFor(purpose)`), thumbnail + name + its craft materials as `.item-chip`s (`renderItemCost`
 *         from `@/shared`, the single cost renderer) + the owned-in-storage count. Clicking one calls
 *         `ctx.housing.selectFurniture(defId)` to enter placement. A 빈 방으로 button in the header clears the room.
 *
 * Driven by `housing:shipManageChanged` (open / close / room change) and `housing:changed` (storage, purposes,
 * materials); `housing:selectionChanged` only re-marks the active card. Takes no blocker token — housing/ owns the
 * mode and hub/ owns the camera and the placement keys.
 */
export class ShipManage {
  readonly root: HTMLElement;
  private roomsEl: HTMLElement;
  private sideHead: HTMLElement;
  private clearBtn: HTMLButtonElement;
  private cardsEl: HTMLElement;
  private purposesEl: HTMLElement;
  private emptyEl: HTMLElement;
  private rows: RoomRow[] = [];
  private cards: Card[] = [];
  private cardsKey = '';
  private purposeKey = '';
  private active = false;
  private room: number | null = null;
  private selected: string | null = null;
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'ship-manage', parent });

    const rooms = el('div', { cls: 'sm-rooms interactive', parent: this.root });
    el('div', { cls: 'sm-title', text: '방 목록', parent: rooms });
    this.roomsEl = el('div', { cls: 'sm-room-list', parent: rooms });
    for (let i = 0; i < SHIP_ROOM_COUNT; i++) {
      const b = el('button', { cls: 'sm-room', parent: this.roomsEl });
      el('span', { cls: 'n', text: `방 ${i + 1}`, parent: b });
      const purposeEl = el('span', { cls: 'p', text: '—', parent: b });
      const countEl = el('span', { cls: 'c', text: '', parent: b });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickRoom(i); });
      this.rows.push({ index: i, root: b, purposeEl, countEl, key: '' });
    }

    const side = el('div', { cls: 'sm-side interactive', parent: this.root });
    const head = el('div', { cls: 'sm-side-head', parent: side });
    this.sideHead = el('div', { cls: 'sm-bar-head', text: '가구', parent: head });
    this.clearBtn = el('button', { cls: 'sm-clear', text: '빈 방으로', parent: head });
    this.clearBtn.addEventListener('click', (e) => { e.stopPropagation(); this.clearRoom(); });
    this.purposesEl = el('div', { cls: 'sm-purposes', parent: side });
    this.purposesEl.hidden = true;
    this.cardsEl = el('div', { cls: 'sm-cards', parent: side });
    this.emptyEl = el('div', { cls: 'sm-empty', text: '이 방에 설치할 수 있는 가구가 없습니다', parent: side });
    this.emptyEl.hidden = true;

    // The list scrolls vertically with the wheel; the wheel also cycles the housing selection, so keep it local.
    for (const scroller of [this.cardsEl, this.purposesEl]) {
      scroller.addEventListener('wheel', (e) => {
        if (scroller.scrollHeight <= scroller.clientHeight) return;
        e.preventDefault(); e.stopPropagation();
        scroller.scrollTop += e.deltaY;
      }, { passive: false });
    }
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:shipManageChanged', ({ active, room }) => this.setActive(active, room)),
      b.on('housing:changed', () => { if (this.active) this.refresh(); }),
      b.on('housing:selectionChanged', ({ defId }) => this.markSelection(defId)),
      b.on('game:newMission', () => this.setActive(false, null)),
      b.on('game:abort', () => this.setActive(false, null)),
    );
  }

  /** Whether the manage screen is showing (debug). */
  get isShowing(): boolean { return this.active; }
  /** Room the screen is editing (debug). */
  get activeRoom(): number | null { return this.room; }
  /** Furniture cards currently rendered (debug). */
  get cardCount(): number { return this.cards.length; }
  /** Purpose buttons currently rendered — non-zero only while an empty room is selected (debug). */
  get purposeCount(): number { return this.purposesEl.hidden ? 0 : this.purposesEl.childElementCount; }

  private setActive(active: boolean, room: number | null): void {
    const changed = active !== this.active || room !== this.room;
    this.active = active;
    this.room = active ? room : null;
    toggleClass(this.root, 'show', active);
    if (!active) {
      this.selected = null;
      this.cardsKey = '';
      this.purposeKey = '';
      return;
    }
    if (changed) { this.cardsEl.scrollTop = 0; this.purposesEl.scrollTop = 0; }
    this.refresh();
  }

  private pickRoom(index: number): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    // housing/ answers with `housing:shipManageChanged {room}` — the highlight follows that, not the click.
    housing.setManageRoom(index);
  }

  private pickCard(defId: string): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    housing.selectFurniture(this.selected === defId ? null : defId);
  }

  private pickPurpose(purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    const room = this.room;
    if (!housing || room === null) return;
    const blocked = housing.purposeBlock(room, purpose);
    if (blocked) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning' });
      return;
    }
    if (housing.setRoomPurpose(room, purpose)) {
      this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
      this.ctx.bus.emit('ui:notify', { text: `방 ${room + 1} → ${ROOM_PURPOSE_LABEL_KO[purpose]}`, kind: 'success' });
    } else this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
    this.refresh();
  }

  /** Header 빈 방으로: give the room back (housing recovers every placed piece into furniture storage first). */
  private clearRoom(): void {
    const housing = this.ctx.housing;
    const room = this.room;
    if (!housing || room === null) return;
    const blocked = housing.purposeBlock(room, 'empty');
    if (blocked) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning' });
      return;
    }
    housing.setRoomPurpose(room, 'empty');
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  /* ── render ──────────────────────────────────────────────────────────── */
  private refresh(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    for (const r of this.rows) {
      const state = housing.getRoom(r.index);
      const purpose = state?.purpose ?? 'empty';
      const count = housing.getPlaced(r.index).length;
      const key = `${purpose}|${count}`;
      if (key !== r.key) {
        r.key = key;
        setText(r.purposeEl, ROOM_PURPOSE_LABEL_KO[purpose]);
        setText(r.countEl, count > 0 ? `${count}개` : '');
        toggleClass(r.root, 'empty', purpose === 'empty');
      }
      toggleClass(r.root, 'is-on', r.index === this.room);
    }
    this.refreshSide();
  }

  private refreshSide(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const room = this.room;
    const purpose = room !== null ? (housing.getRoom(room)?.purpose ?? 'empty') : 'empty';
    const assigning = room !== null && purpose === 'empty';

    setText(this.sideHead, room === null
      ? '가구'
      : assigning ? `방 ${room + 1} — 용도 지정` : `가구 · 방 ${room + 1} — ${ROOM_PURPOSE_LABEL_KO[purpose]}`);
    // clearing is only offered on an assigned room the rules allow to go back to 빈 방 (never the built-in 작업실)
    this.clearBtn.hidden = room === null || assigning || !!housing.purposeBlock(room, 'empty');

    this.purposesEl.hidden = !assigning;
    this.cardsEl.hidden = assigning;
    if (assigning) { this.emptyEl.hidden = true; this.refreshPurposes(room as number); return; }
    this.refreshCards(room, purpose);
  }

  /** 용도 지정 buttons for an empty room; a purpose the rules refuse is disabled with the reason as its title. */
  private refreshPurposes(room: number): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const key = `${room}|${ASSIGNABLE.map((p) => (housing.purposeBlock(room, p) ? '0' : '1')).join('')}`;
    if (key === this.purposeKey) return;
    this.purposeKey = key;
    this.purposesEl.replaceChildren();
    for (const p of ASSIGNABLE) {
      const blocked = housing.purposeBlock(room, p);
      const b = el('button', { cls: 'sm-purpose', parent: this.purposesEl });
      const line = el('div', { cls: 'ln', parent: b });
      el('span', { cls: 'nm', text: ROOM_PURPOSE_LABEL_KO[p], parent: line });
      if (!ROOM_PURPOSES_ACTIVE.includes(p)) el('span', { cls: 'badge', text: '다음 업데이트', parent: line });
      el('div', { cls: 'ds', text: blocked ?? ROOM_PURPOSE_DESC_KO[p], parent: b });
      toggleClass(b, 'is-blocked', !!blocked);
      b.disabled = !!blocked;
      b.title = blocked ?? ROOM_PURPOSE_DESC_KO[p];
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickPurpose(p); });
    }
  }

  private refreshCards(room: number | null, purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const defs = housing.getFurnitureFor(purpose);
    const stored = new Map<string, number>();
    for (const s of housing.getStored()) stored.set(s.defId, (stored.get(s.defId) ?? 0) + s.qty);

    // Rebuild only when the visible content actually changed (room / def list / storage / material counts).
    const key = `${room}|${purpose}|${defs.map((d) => `${d.id}:${stored.get(d.id) ?? 0}:${this.costKey(d)}`).join(',')}`;
    if (key === this.cardsKey) { this.markSelection(this.selected); return; }
    this.cardsKey = key;

    this.cardsEl.replaceChildren();
    this.cards = [];
    this.emptyEl.hidden = defs.length > 0;
    for (const def of defs) {
      const owned = stored.get(def.id) ?? 0;
      const card = el('button', { cls: 'fcard', parent: this.cardsEl });
      card.style.setProperty('--fc', def.color);
      card.title = `${def.name}\n${def.description}`;
      const thumb = el('div', { cls: 'fcard-thumb', parent: card });
      el('span', { cls: 'fcard-glyph', text: MODEL_GLYPH[def.model] ?? '▨', parent: thumb });
      el('span', { cls: 'fcard-size', text: `${def.cols}×${def.rows}`, parent: thumb });
      const body = el('div', { cls: 'fcard-body', parent: card });
      el('div', { cls: 'fcard-name', text: def.name, parent: body });
      const cost = el('div', { cls: 'fcard-cost', parent: body });
      renderItemCost(cost, def.craft, (id) => this.itemDef(id), (id) => this.owned(id), { size: 24 });
      const own = el('div', { cls: 'fcard-own', text: `보유 ${owned}`, parent: body });
      toggleClass(own, 'none', owned <= 0);
      toggleClass(card, 'is-empty', owned <= 0);
      card.addEventListener('click', (e) => { e.stopPropagation(); this.pickCard(def.id); });
      this.cards.push({ defId: def.id, root: card });
    }
    this.markSelection(this.selected);
  }

  private costKey(def: FurnitureDef): string {
    if (!def.craft || def.craft.length === 0) return '-';
    return def.craft.map((c) => `${c.defId}x${c.qty}/${this.owned(c.defId)}`).join('+');
  }

  private itemDef(defId: string): ItemDef | undefined {
    return this.ctx.loot?.getItemDef(defId) ?? this.ctx.inventory?.getDef(defId);
  }

  private owned(defId: string): number {
    return this.ctx.inventory?.countDefAll(defId) ?? 0;
  }

  private markSelection(defId: string | null): void {
    this.selected = defId;
    for (const c of this.cards) toggleClass(c.root, 'is-sel', c.defId === defId);
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
