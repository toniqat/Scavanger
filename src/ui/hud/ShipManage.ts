import type { FurnitureDef, FurnitureModelKind, GameContext, ItemDef, RoomPurpose } from '@/shared';
import {
  renderItemCost, ROOM_PURPOSES, ROOM_PURPOSES_ACTIVE, ROOM_PURPOSE_COLOR, ROOM_PURPOSE_GLYPH,
  ROOM_PURPOSE_LABEL_KO, SHIP_ROOM_COUNT,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';

interface RoomRow {
  index: number;
  root: HTMLButtonElement;
  thumbEl: HTMLElement;
  glyphEl: HTMLElement;
  purposeEl: HTMLElement;
  countEl: HTMLElement;
  key: string;
}

interface Card {
  defId: string;
  root: HTMLButtonElement;
}

/** Which list the right-hand panel shows for a room that already has a purpose. */
type FurnTab = 'craft' | 'store';

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
 *   - **Right**: a vertical side panel that shows one of two things for the selected room:
 *       · an **empty** room → the 용도 지정 picker: every assignable `RoomPurpose` led by the shared facility
 *         thumbnail and followed by the **materials the 시설 증축 costs** (`ctx.housing.purposeCost` rendered with
 *         `renderItemCost` — the Phase 9 UI pass dropped the prose description in favour of the cost chips), disabled
 *         with the 한국어 reason from `ctx.housing.purposeBlock` when the rules or the materials refuse it.
 *       · a room **with a purpose** → the 가구 목록 behind two tabs (Phase 9 UI pass):
 *           **가구 제작** — every furniture def the room accepts (`getFurnitureFor`), its craft materials as
 *           `.item-chip`s and a 제작 button that calls `ctx.housing.craftFurniture` (this is the only place furniture
 *           is crafted); clicking the row selects it for placement when one is already in storage.
 *           **가구 창고** — what `getStored()` holds: pieces this room accepts first (clickable → `selectFurniture`),
 *           every other stored piece under them, dimmed and disabled with the reason.
 *         A 빈 방으로 button in the header clears the room.
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
  private tabsEl: HTMLElement;
  private tabBtns = new Map<FurnTab, HTMLButtonElement>();
  private cardsEl: HTMLElement;
  private storeEl: HTMLElement;
  private purposesEl: HTMLElement;
  private emptyEl: HTMLElement;
  private rows: RoomRow[] = [];
  private cards: Card[] = [];
  private cardsKey = '';
  private storeKey = '';
  private purposeKey = '';
  private tab: FurnTab = 'craft';
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
      const thumbEl = el('div', { cls: 'sm-thumb', parent: b });
      const glyphEl = el('span', { cls: 'g', text: ROOM_PURPOSE_GLYPH.empty, parent: thumbEl });
      el('span', { cls: 'n', text: `방 ${i + 1}`, parent: b });
      const purposeEl = el('span', { cls: 'p', text: '—', parent: b });
      const countEl = el('span', { cls: 'c', text: '', parent: b });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickRoom(i); });
      this.rows.push({ index: i, root: b, thumbEl, glyphEl, purposeEl, countEl, key: '' });
    }

    const side = el('div', { cls: 'sm-side interactive', parent: this.root });
    const head = el('div', { cls: 'sm-side-head', parent: side });
    this.sideHead = el('div', { cls: 'sm-bar-head', text: '가구', parent: head });
    this.clearBtn = el('button', { cls: 'sm-clear', text: '빈 방으로', parent: head });
    this.clearBtn.addEventListener('click', (e) => { e.stopPropagation(); this.clearRoom(); });
    // 가구 제작 / 가구 창고 tabs (hidden while an empty room shows the 용도 지정 picker)
    this.tabsEl = el('div', { cls: 'sm-tabs', parent: side });
    for (const [id, label] of [['craft', '가구 제작'], ['store', '가구 창고']] as ReadonlyArray<readonly [FurnTab, string]>) {
      const b = el('button', { cls: 'sm-tab', text: label, parent: this.tabsEl });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickTab(id); });
      this.tabBtns.set(id, b);
    }
    this.purposesEl = el('div', { cls: 'sm-purposes', parent: side });
    this.purposesEl.hidden = true;
    this.cardsEl = el('div', { cls: 'sm-cards', parent: side });
    this.storeEl = el('div', { cls: 'sm-store', parent: side });
    this.storeEl.hidden = true;
    this.emptyEl = el('div', { cls: 'sm-empty', text: '이 방에 설치할 수 있는 가구가 없습니다', parent: side });
    this.emptyEl.hidden = true;

    // The lists scroll vertically with the wheel; the wheel also cycles the housing selection, so keep it local.
    for (const scroller of [this.cardsEl, this.storeEl, this.purposesEl]) {
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
      b.on('inventory:changed', () => { if (this.active) this.refresh(); }),
      b.on('inventory:stashChanged', () => { if (this.active) this.refresh(); }),
      b.on('game:newMission', () => this.setActive(false, null)),
      b.on('game:abort', () => this.setActive(false, null)),
    );
  }

  /** Whether the manage screen is showing (debug). */
  get isShowing(): boolean { return this.active; }
  /** Room the screen is editing (debug). */
  get activeRoom(): number | null { return this.room; }
  /** Furniture cards currently rendered in the visible list (debug). */
  get cardCount(): number { return this.cards.length; }
  /** Purpose buttons currently rendered — non-zero only while an empty room is selected (debug). */
  get purposeCount(): number { return this.purposesEl.hidden ? 0 : this.purposesEl.childElementCount; }
  /** Which furniture tab is showing (debug). */
  get furnitureTab(): FurnTab { return this.tab; }

  private setActive(active: boolean, room: number | null): void {
    const changed = active !== this.active || room !== this.room;
    this.active = active;
    this.room = active ? room : null;
    toggleClass(this.root, 'show', active);
    if (!active) {
      this.selected = null;
      this.cardsKey = '';
      this.storeKey = '';
      this.purposeKey = '';
      return;
    }
    if (changed) { this.cardsEl.scrollTop = 0; this.storeEl.scrollTop = 0; this.purposesEl.scrollTop = 0; }
    this.refresh();
  }

  private pickRoom(index: number): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    // housing/ answers with `housing:shipManageChanged {room}` — the highlight follows that, not the click.
    housing.setManageRoom(index);
  }

  private pickTab(tab: FurnTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.cardsEl.scrollTop = 0;
    this.storeEl.scrollTop = 0;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refreshSide();
  }

  /** A 가구 제작 row: craft one piece into furniture storage (materials come from bag + stash). */
  private craftCard(defId: string): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const info = housing.canCraftFurniture(defId);
    if (!info.ok) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      const short = info.missing.map((m) => `${this.itemDef(m.defId)?.name ?? m.defId} ${m.qty}`).join(' · ');
      this.ctx.bus.emit('ui:notify', { text: `재료 부족: ${short}`, kind: 'warning' });
      return;
    }
    if (!housing.craftFurniture(defId)) { this.ctx.bus.emit('audio:play', { id: 'ui_deny' }); return; }
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    const def = housing.getFurnitureDef(defId);
    this.ctx.bus.emit('ui:notify', { text: `${def?.name ?? defId} 제작 완료 — 가구 창고에 있습니다`, kind: 'success' });
    this.refresh();
  }

  /** A 가구 창고 row: arm it for placement (housing refuses a def with nothing in storage). */
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
      this.tab = 'craft';
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
        setText(r.glyphEl, ROOM_PURPOSE_GLYPH[purpose]);
        r.thumbEl.style.setProperty('--pc', ROOM_PURPOSE_COLOR[purpose]);
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
    this.tabsEl.hidden = assigning || room === null;
    for (const [id, b] of this.tabBtns) toggleClass(b, 'is-on', id === this.tab);
    if (assigning) {
      this.cardsEl.hidden = true;
      this.storeEl.hidden = true;
      this.emptyEl.hidden = true;
      this.refreshPurposes(room as number);
      return;
    }
    this.cardsEl.hidden = this.tab !== 'craft';
    this.storeEl.hidden = this.tab !== 'store';
    if (this.tab === 'craft') this.refreshCards(room, purpose);
    else this.refreshStore(room, purpose);
  }

  /**
   * Rank of a purpose in the 용도 지정 picker (Phase 9 UI pass): **0** assignable right now, **1** blocked by a
   * prerequisite (materials, the 발전기 gate, 연구실 without an 온실, furniture that must be recovered first),
   * **2** already built somewhere else on the ship. The list is sorted by rank, then by the catalogue order.
   */
  private purposeRank(room: number, p: RoomPurpose, blocked: string | null): 0 | 1 | 2 {
    if (!blocked) return 0;
    const housing = this.ctx.housing;
    if (!housing) return 1;
    for (let i = 0; i < SHIP_ROOM_COUNT; i++) if (i !== room && housing.getRoom(i)?.purpose === p) return 2;
    return 1;
  }

  /**
   * 용도 지정 buttons for an empty room, **sorted 제작 가능 → 제작 불가 → 이미 제작** (`purposeRank`), each led by
   * the shared facility thumbnail (`ROOM_PURPOSE_GLYPH` / `ROOM_PURPOSE_COLOR`) and followed by the **materials the
   * 시설 증축 costs** as `.item-chip`s. The prose description is gone (Phase 9 UI pass); a blocked purpose keeps the
   * 한국어 reason as its title and, when the rules refuse it outright, as a short line under the name.
   */
  private refreshPurposes(room: number): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const entries = ASSIGNABLE.map((p) => {
      const blocked = housing.purposeBlock(room, p);
      return { p, blocked, rank: this.purposeRank(room, p, blocked), cost: housing.purposeCost(p) };
    });
    entries.sort((a, b) => a.rank - b.rank || ASSIGNABLE.indexOf(a.p) - ASSIGNABLE.indexOf(b.p));
    const key = `${room}|${entries.map((e) => `${e.p}${e.rank}${this.costKeyOf(e.cost)}`).join(',')}`;
    if (key === this.purposeKey) return;
    this.purposeKey = key;
    this.purposesEl.replaceChildren();
    for (const { p, blocked, rank, cost } of entries) {
      const b = el('button', { cls: `sm-purpose rank-${rank}`, parent: this.purposesEl });
      const thumb = el('div', { cls: 'sm-thumb', parent: b });
      thumb.style.setProperty('--pc', ROOM_PURPOSE_COLOR[p]);
      el('span', { cls: 'g', text: ROOM_PURPOSE_GLYPH[p], parent: thumb });
      const body = el('div', { cls: 'bd', parent: b });
      const line = el('div', { cls: 'ln', parent: body });
      el('span', { cls: 'nm', text: ROOM_PURPOSE_LABEL_KO[p], parent: line });
      if (rank === 2) el('span', { cls: 'badge', text: '이미 제작', parent: line });
      else if (!ROOM_PURPOSES_ACTIVE.includes(p)) el('span', { cls: 'badge', text: '다음 업데이트', parent: line });
      const costEl = el('div', { cls: 'sm-cost', parent: body });
      renderItemCost(costEl, cost, (id) => this.itemDef(id), (id) => this.owned(id), { size: 24 });
      toggleClass(b, 'is-blocked', !!blocked);
      b.disabled = !!blocked;
      b.title = blocked ?? `${ROOM_PURPOSE_LABEL_KO[p]} 증축`;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickPurpose(p); });
    }
  }

  /** 가구 제작 tab: one row per furniture def the room accepts — cost chips + a 제작 button. */
  private refreshCards(room: number | null, purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const defs = housing.getFurnitureFor(purpose);
    const stored = this.storedCounts();

    // Rebuild only when the visible content actually changed (room / def list / storage / material counts).
    const key = `craft|${room}|${purpose}|${defs.map((d) => `${d.id}:${stored.get(d.id) ?? 0}:${this.costKey(d)}`).join(',')}`;
    if (key === this.cardsKey) { this.markSelection(this.selected); return; }
    this.cardsKey = key;

    this.cardsEl.replaceChildren();
    this.cards = [];
    this.emptyEl.hidden = defs.length > 0;
    for (const def of defs) {
      const owned = stored.get(def.id) ?? 0;
      const can = housing.canCraftFurniture(def.id);
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
      // the row selects a stored piece for placement; the 제작 button spends materials for a new one
      card.addEventListener('click', (e) => { e.stopPropagation(); if (owned > 0) this.pickCard(def.id); else this.craftCard(def.id); });
      const make = el('button', { cls: 'fcard-craft', text: '제작', parent: card });
      make.disabled = !can.ok;
      make.title = can.ok ? `${def.name} 제작` : '재료가 부족합니다';
      make.addEventListener('click', (e) => { e.stopPropagation(); this.craftCard(def.id); });
      this.cards.push({ defId: def.id, root: card });
    }
    this.markSelection(this.selected);
  }

  /**
   * 가구 창고 tab: everything in furniture storage. Pieces this room accepts come first and are clickable; the rest
   * follow, dimmed and disabled, so the player can still see what the ship owns without switching rooms.
   */
  private refreshStore(room: number | null, purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const allowed = new Set(housing.getFurnitureFor(purpose).map((d) => d.id));
    const stored = this.storedCounts();
    const entries = [...stored].map(([defId, qty]) => ({ defId, qty, def: housing.getFurnitureDef(defId), fits: allowed.has(defId) }))
      .filter((e) => !!e.def) as Array<{ defId: string; qty: number; def: FurnitureDef; fits: boolean }>;
    entries.sort((a, b) => Number(b.fits) - Number(a.fits) || a.def.name.localeCompare(b.def.name, 'ko'));

    const key = `store|${room}|${purpose}|${entries.map((e) => `${e.defId}:${e.qty}:${e.fits ? 1 : 0}`).join(',')}`;
    if (key === this.storeKey) { this.markSelection(this.selected); return; }
    this.storeKey = key;

    this.storeEl.replaceChildren();
    this.cards = [];
    this.emptyEl.hidden = entries.length > 0;
    if (entries.length === 0) setText(this.emptyEl, '가구 창고가 비어 있습니다 — 가구 제작 탭에서 만드세요');
    for (const { defId, qty, def, fits } of entries) {
      const card = el('button', { cls: `fcard store${fits ? '' : ' is-blocked'}`, parent: this.storeEl });
      card.style.setProperty('--fc', def.color);
      card.title = fits ? `${def.name}\n${def.description}` : `${def.name} — 이 방에 설치할 수 없습니다`;
      const thumb = el('div', { cls: 'fcard-thumb', parent: card });
      el('span', { cls: 'fcard-glyph', text: MODEL_GLYPH[def.model] ?? '▨', parent: thumb });
      el('span', { cls: 'fcard-size', text: `${def.cols}×${def.rows}`, parent: thumb });
      const body = el('div', { cls: 'fcard-body', parent: card });
      el('div', { cls: 'fcard-name', text: def.name, parent: body });
      el('div', { cls: 'fcard-note', text: fits ? '클릭해 배치' : `${ROOM_PURPOSE_LABEL_KO[def.room === 'any' ? 'empty' : def.room]} 전용`, parent: body });
      const own = el('div', { cls: 'fcard-own', text: `보유 ${qty}`, parent: body });
      toggleClass(own, 'none', qty <= 0);
      card.disabled = !fits;
      if (fits) card.addEventListener('click', (e) => { e.stopPropagation(); this.pickCard(defId); });
      this.cards.push({ defId, root: card });
    }
    this.markSelection(this.selected);
  }

  /** Furniture storage merged per def id (levels collapse — placement takes the highest level anyway). */
  private storedCounts(): Map<string, number> {
    const stored = new Map<string, number>();
    for (const s of this.ctx.housing?.getStored() ?? []) stored.set(s.defId, (stored.get(s.defId) ?? 0) + s.qty);
    return stored;
  }

  private costKey(def: FurnitureDef): string {
    return this.costKeyOf(def.craft);
  }

  private costKeyOf(cost: readonly { defId: string; qty: number }[] | null | undefined): string {
    if (!cost || cost.length === 0) return '-';
    return cost.map((c) => `${c.defId}x${c.qty}/${this.owned(c.defId)}`).join('+');
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
