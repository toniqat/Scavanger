import type {
  BookSlotInfo, CraftIngredient, EmbeddedView, FacilityId, FacilityInfo, FurnitureDef, GameContext, GameSystem, GrowPlot, GrowPlotInfo,
  HousingRef, ItemDef, LoadoutPreset, PlacedBook, PlacedFurniture, ProfileRef, RoomPurpose, RoomState, ShipState, SkillId,
  StoredFurniture, WorkbenchKind,
} from '@/shared';
import {
  BOOKS_PER_SHELF, FURNITURE_DEFS, FURNITURE_DEF_MAP, GROW_PLOTS_PER_RACK, GROW_SKILL_SPEEDUP, IMPLANT_IDS, SKILL_IDS, SKILL_LEVEL_MAX,
  benchKindOf,
} from '@/shared';
import {
  bookGainMulFor, bookWeightOf, canPlaceAt, craftCostMulFor, facilityBlockReason, facilityLevel, facilityMaxLevel, facilityName,
  furnitureAllowedIn, furnitureUpgradeReason, isRoomIndex, isRoomPurpose, layerOf, missingIngredients, nextFacilityCost, nextFreeLayer,
  nextFurnitureCost, presetCountFor, purposeChangeReason, recoverBlockReason, skillGainMulFor, stackLimitOf, stackMembers,
  stashSizeFor,
} from './Rules';
import { ShipStore, freshRoom, isBookshelfDefId, isGrowRackDefId, loadState, maxUidIndex, sanitize, writeState } from './ShipState';
import { PresetMenu } from './ui/PresetMenu';
import { GrowMenu } from './ui/GrowMenu';
import { BookshelfMenu } from './ui/BookshelfMenu';
import { createShipView } from './ui/ShipView';
import { formatRemaining } from './ui/dom';
import type { HousingPanel } from './ui/Panel';
import './housing.css';

const FACILITY_IDS: readonly FacilityId[] = ['generator', 'storage', 'workshop', 'range'];
const PRESET_NAME_MAX = 24;
/** 한국어 refusal when a 책장 cannot be recovered because its books have nowhere to go. */
export const BOOKS_BLOCK_REASON = '책을 먼저 빼세요';

/**
 * Ship housing (함선 꾸미기): owns the ShipState (rooms / facilities / furniture / presets), every rule and number
 * (see Rules.ts), persistence (ShipState.ts) and the three DOM panels (ui/). Publishes `ctx.housing`.
 * hub/ builds the geometry and the housing-mode camera / cursor on top of this API and its `housing:*` events.
 *
 * Materials come from `ctx.inventory.countDefAll / consumeDefAll` (bag + stash); both are guarded with `typeof`
 * because inventory/ is built in parallel — without them nothing can be bought.
 * Phase 7: the state is mirrored into the server profile document `ship` on every save; `net:profileLoaded` replaces
 * it with the server copy and re-emits `housing:loaded` so hub/ rebuilds the personal ship.
 * Phase 9: 서재 책장 — `ShipState.books` (one `PlacedBook` per filled shelf slot) + `bookDex`; the 서재 multiplier
 * (`getBookBonus`, Rules.bookGainMulFor) is folded into `getSkillGainMul`, so progression/ reads one number.
 */
export class HousingSystem implements GameSystem, HousingRef {
  readonly name = 'housing';
  state: ShipState;
  housingMode = false;
  housingRoom: number | null = null;
  selectedFurniture: string | null = null;
  selectedYaw: 0 | 1 | 2 | 3 = 0;
  /** Phase 8: housing mode entered from the M screen (no "stand inside the room" gate, room list + furniture bar). */
  shipManageMode = false;

  private ctx!: GameContext;
  private store: ShipStore | null = null;
  private nextUid = 0;
  private fresh = false;
  private unsubs: Array<() => void> = [];
  private presetMenu: PresetMenu | null = null;
  private growMenu: GrowMenu | null = null;
  private bookshelfMenu: BookshelfMenu | null = null;
  private lastStash = { cols: 0, rows: 0 };
  /** `books` were checked against `ctx.loot` once (unknown / non-book ids dropped) — see `books()`. */
  private booksPruned = false;

  constructor() {
    const loaded = loadState();
    this.state = loaded.state;
    this.fresh = loaded.fresh;
    this.nextUid = maxUidIndex(this.state.furniture);
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.housing = this;
    this.store = new ShipStore(() => this.state, () => this.profileRef());
    if (this.fresh) this.store.markDirty();
    this.presetMenu = new PresetMenu(ctx, this);
    this.growMenu = new GrowMenu(ctx, this);
    this.bookshelfMenu = new BookshelfMenu(ctx, this);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('game:abort', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('hub:left', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('game:phaseChanged', ({ phase }) => { if (phase !== 'hub') { this.closeMenus(); this.exitHousingMode(); } }),
      b.on('net:profileLoaded', () => this.onProfileLoaded()),
    );
    b.emit('housing:loaded', { state: this.state });
    this.lastStash = this.getStashSize();
    b.emit('housing:stashSizeChanged', { ...this.lastStash });
  }

  update(_dt: number, ctx: GameContext): void {
    if (this.housingMode && (ctx.phase !== 'hub' || ctx.hub?.ship !== 'personal')) this.exitHousingMode();
  }

  dispose(): void {
    this.closeMenus();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.presetMenu?.dispose(); this.growMenu?.dispose(); this.bookshelfMenu?.dispose();
    this.presetMenu = null; this.growMenu = null; this.bookshelfMenu = null;
    this.store?.dispose(); this.store = null;
  }

  /* ── server profile (Phase 7) ──────────────────────────────────────────── */
  private profileRef(): ProfileRef | null {
    const p = this.ctx?.net?.profile;
    return p && typeof p === 'object' ? p : null;
  }

  /**
   * `net:profileLoaded`: the server `ship` document (sanitised like a local load) replaces the state — housing mode and
   * panels close first, `housing:loaded` + `housing:changed {reason:'profile'}` fire so hub/ rebuilds the personal
   * ship, and the stash size event follows when the storage level differs. No document yet → the local state is
   * uploaded instead.
   */
  private onProfileLoaded(): void {
    const p = this.profileRef();
    if (!p || !p.available) return;
    let doc: unknown;
    try { doc = p.get('ship'); } catch { doc = undefined; }
    if (!doc || typeof doc !== 'object') { this.store?.upload(); return; }
    this.closeMenus();
    this.exitHousingMode();
    this.store?.cancel();
    this.state = sanitize(doc);
    this.nextUid = maxUidIndex(this.state.furniture);
    this.booksPruned = false;
    this.fresh = false;
    writeState(this.state);                      // localStorage is the cache of the server copy (not re-uploaded)
    const b = this.ctx.bus;
    b.emit('housing:loaded', { state: this.state });
    b.emit('housing:changed', { reason: 'profile' });
    this.emitStashSizeIfChanged();
  }

  /* ── helpers ───────────────────────────────────────────────────────────── */
  private changed(reason: string): void {
    this.store?.markDirty();
    this.ctx.bus.emit('housing:changed', { reason });
  }

  /** Units of `defId` in bag + stash (0 while inventory has no `countDefAll`). */
  countDef = (defId: string): number => {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.countDefAll !== 'function') return 0;
    return inv.countDefAll(defId);
  };

  /** 한국어 item name for cost lines. */
  nameOf = (defId: string): string => this.ctx.loot?.getItemDef(defId)?.name ?? defId;

  /** Item def for a cost chip (`renderItemCost` lookup); undefined renders the neutral placeholder chip. */
  defOf = (defId: string): ItemDef | undefined => this.ctx.loot?.getItemDef(defId);

  /** Epoch ms from the relay when connected, else the local clock — 재배 runs on real world time. */
  private nowMs(): number {
    const net = this.ctx.net;
    if (net && typeof net.serverNow === 'function') {
      const t = net.serverNow();
      if (Number.isFinite(t) && t > 0) return t;
    }
    return Date.now();
  }

  private canAfford(cost: readonly CraftIngredient[]): boolean {
    return missingIngredients(cost, this.countDef).length === 0;
  }

  /** All-or-nothing: verified with `countDef` first, then consumed def by def. */
  private consume(cost: readonly CraftIngredient[]): boolean {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.consumeDefAll !== 'function') return false;
    if (!this.canAfford(cost)) return false;
    for (const c of cost) if (!inv.consumeDefAll(c.defId, c.qty)) return false;
    return true;
  }

  private notify(text: string, kind: 'info' | 'warning' | 'danger' | 'success' = 'info'): void {
    this.ctx.bus.emit('ui:notify', { text, kind });
  }

  private storageEntry(defId: string): StoredFurniture | null {
    let best: StoredFurniture | null = null;
    for (const s of this.state.furnitureStorage) if (s.defId === defId && s.qty > 0 && (!best || s.level > best.level)) best = s;
    return best;
  }

  private addToStorage(defId: string, level: number, qty = 1): void {
    const e = this.state.furnitureStorage.find((s) => s.defId === defId && s.level === level);
    if (e) e.qty += qty; else this.state.furnitureStorage.push({ defId, level, qty });
  }

  private takeFromStorage(entry: StoredFurniture): void {
    entry.qty -= 1;
    if (entry.qty <= 0) this.state.furnitureStorage.splice(this.state.furnitureStorage.indexOf(entry), 1);
  }

  private emitStashSizeIfChanged(): void {
    const size = this.getStashSize();
    if (size.cols === this.lastStash.cols && size.rows === this.lastStash.rows) return;
    this.lastStash = size;
    this.ctx.bus.emit('housing:stashSizeChanged', { ...size });
  }

  /* ── housing mode ──────────────────────────────────────────────────────── */
  /** Why housing mode cannot start for `room`; null = fine. */
  housingModeBlock(room: number): string | null {
    const ctx = this.ctx;
    if (!isRoomIndex(this.state, room)) return '없는 방입니다';
    if (ctx.phase !== 'hub') return '함선에서만 꾸밀 수 있습니다';
    if (ctx.hub?.ship !== 'personal') return '개인 함선에서만 꾸밀 수 있습니다';
    // hub's `currentRoom` is null in the corridor / cockpit: the player has to stand inside the room being decorated
    if (ctx.hub.currentRoom !== room) return `방 ${room + 1} 안에서만 꾸밀 수 있습니다`;
    return null;
  }

  /** Why 함선 관리 cannot start at all (no room gate — that is what separates it from `enterHousingMode`). */
  shipManageBlock(): string | null {
    const ctx = this.ctx;
    if (ctx.phase !== 'hub') return '함선에서만 꾸밀 수 있습니다';
    if (ctx.hub?.ship !== 'personal') return '개인 함선에서만 꾸밀 수 있습니다';
    return null;
  }

  enterHousingMode(room: number): boolean {
    if (this.housingModeBlock(room)) return false;
    return this.enterMode(room);
  }

  /** Shared body of `enterHousingMode` / `openShipManage` — the gates differ, the state change does not. */
  private enterMode(room: number): boolean {
    this.closeMenus();
    if (this.housingMode && this.housingRoom === room) return true;
    this.housingMode = true;
    this.housingRoom = room;
    this.selectedFurniture = null;
    this.selectedYaw = 0;
    this.ctx.bus.emit('housing:modeChanged', { active: true, room });
    this.ctx.bus.emit('housing:selectionChanged', { defId: null, yaw: 0 });
    return true;
  }

  exitHousingMode(): void {
    const wasManage = this.shipManageMode;
    this.shipManageMode = false;
    if (this.housingMode) {
      this.housingMode = false;
      this.housingRoom = null;
      this.selectedFurniture = null;
      this.selectedYaw = 0;
      this.ctx.bus.emit('housing:modeChanged', { active: false, room: null });
    }
    if (wasManage) this.ctx.bus.emit('housing:shipManageChanged', { active: false, room: null });
  }

  /* ── 함선 관리 (Phase 8, M in the ship) ────────────────────────────────── */
  /**
   * Enter the ship-management screen: the housing-mode camera / cursor without the "player stands in the room" gate,
   * plus the room list + furniture bar ui/ draws off `housing:shipManageChanged`. Default room: the one the player is
   * standing in, else the first room with a purpose, else room 1.
   */
  openShipManage(room?: number): boolean {
    if (this.shipManageBlock()) return false;
    const target = isRoomIndex(this.state, room ?? -1)
      ? (room as number)
      : this.ctx.hub?.currentRoom ?? this.state.rooms.findIndex((r) => r.purpose !== 'empty');
    const index = isRoomIndex(this.state, target) ? target : 0;
    this.enterMode(index);
    this.shipManageMode = true;
    this.ctx.bus.emit('housing:shipManageChanged', { active: true, room: index });
    return true;
  }

  setManageRoom(room: number): boolean {
    if (!this.shipManageMode || !isRoomIndex(this.state, room)) return false;
    if (this.housingRoom === room) return true;
    this.housingRoom = room;
    this.selectedFurniture = null;
    this.selectedYaw = 0;
    this.ctx.bus.emit('housing:modeChanged', { active: true, room });
    this.ctx.bus.emit('housing:selectionChanged', { defId: null, yaw: 0 });
    this.ctx.bus.emit('housing:shipManageChanged', { active: true, room });
    return true;
  }

  closeShipManage(): void {
    if (!this.shipManageMode) return;
    this.exitHousingMode();
  }

  /** `null` clears the selection; a def that is not in furniture storage is ignored (selection unchanged). */
  selectFurniture(defId: string | null): void {
    if (defId !== null && (!FURNITURE_DEF_MAP.has(defId) || !this.storageEntry(defId))) return;
    if (defId === this.selectedFurniture) return;
    this.selectedFurniture = defId;
    this.ctx.bus.emit('housing:selectionChanged', { defId, yaw: this.selectedYaw });
  }

  rotateSelection(): void {
    this.selectedYaw = ((this.selectedYaw + 1) % 4) as 0 | 1 | 2 | 3;
    this.ctx.bus.emit('housing:selectionChanged', { defId: this.selectedFurniture, yaw: this.selectedYaw });
  }

  /* ── rooms ─────────────────────────────────────────────────────────────── */
  getRoom(index: number): RoomState { return this.state.rooms[index] ?? freshRoom(); }

  /**
   * 한국어 reason `setRoomPurpose` would refuse (null = allowed). Used by the room menu for button hints. `empty`
   * recovers every piece, so it is also refused while a 책장 in the room cannot hand its books to the stash.
   */
  purposeBlock(index: number, purpose: RoomPurpose): string | null {
    return purposeChangeReason(this.state, index, purpose) ?? (purpose === 'empty' ? this.emptyRoomBlock(index) : null);
  }

  /** Why the room cannot be emptied right now (a 책장 whose books have no stash room), null when it can. */
  private emptyRoomBlock(index: number): string | null {
    for (const f of this.state.furniture) {
      if (f.room !== index || !isBookshelfDefId(f.defId)) continue;
      const reason = this.booksBlock(f.uid);
      if (reason) return reason;
    }
    return null;
  }

  setRoomPurpose(index: number, purpose: RoomPurpose): boolean {
    if (!isRoomIndex(this.state, index) || !isRoomPurpose(purpose)) return false;
    const room = this.state.rooms[index];
    if (room.purpose === purpose) return true;
    if (purposeChangeReason(this.state, index, purpose)) return false;
    if (purpose === 'empty' && this.emptyRoomBlock(index)) return false;
    if (purpose === 'empty') {
      // top layers first so a stack never has to be taken apart from underneath
      const inRoom = this.state.furniture.filter((p) => p.room === index).sort((a, b) => layerOf(b) - layerOf(a));
      for (const f of inRoom) this.recover(f.uid);
    }
    // a greenhouse that goes away takes its labs with it
    if (room.purpose === 'greenhouse' && !this.state.rooms.some((r, i) => i !== index && r.purpose === 'greenhouse')) {
      for (let i = 0; i < this.state.rooms.length; i++) if (this.state.rooms[i].purpose === 'lab') this.setRoomPurpose(i, 'empty');
    }
    room.purpose = purpose;
    room.level = purpose === 'empty' ? 0 : 1;
    this.ctx.bus.emit('housing:roomPurposeChanged', { room: index, purpose });
    this.changed('purpose');
    if (this.housingMode && this.housingRoom === index) this.selectFurniture(null);
    return true;
  }

  findRoom(purpose: RoomPurpose): number { return this.state.rooms.findIndex((r) => r.purpose === purpose); }

  /* ── facilities ────────────────────────────────────────────────────────── */
  getFacilities(): FacilityInfo[] { return FACILITY_IDS.map((id) => this.getFacility(id)); }

  getFacility(id: FacilityId): FacilityInfo {
    const level = facilityLevel(this.state, id);
    return {
      id, name: facilityName(id), level, maxLevel: facilityMaxLevel(id),
      nextCost: nextFacilityCost(id, level),
      blocked: facilityBlockReason(this.state, id, this.countDef, this.nameOf),
    };
  }

  upgrade(id: FacilityId): boolean {
    if (!FACILITY_IDS.includes(id)) return false;
    const info = this.getFacility(id);
    if (info.blocked || !info.nextCost) return false;
    if (!this.consume(info.nextCost)) return false;
    const level = info.level + 1;
    if (id === 'generator') this.state.generatorLevel = level;
    else if (id === 'storage') this.state.storageLevel = level;
    else {
      const room = this.state.rooms.find((r) => r.purpose === id);
      if (!room) return false;
      room.level = level;
    }
    this.ctx.bus.emit('housing:facilityUpgraded', { id, level });
    this.changed(`facility:${id}`);
    if (id === 'storage') this.emitStashSizeIfChanged();
    return true;
  }

  getBenchLevel(kind: WorkbenchKind): number {
    let best = 0;
    for (const f of this.state.furniture) {
      const def = FURNITURE_DEF_MAP.get(f.defId);
      if (def && benchKindOf(def.interaction) === kind) best = Math.max(best, f.level);
    }
    return best;
  }

  getCraftCostMul(): number { return craftCostMulFor(facilityLevel(this.state, 'workshop')); }
  /** 사격장 (`gun_*` × `1 + 0.1 × level`) × 서재 (`getBookBonus`, every shelved book of that skill). */
  getSkillGainMul(skill: SkillId): number { return skillGainMulFor(skill, facilityLevel(this.state, 'range')) * this.getBookBonus(skill); }
  getStashSize(): { cols: number; rows: number } { return stashSizeFor(this.state.storageLevel); }

  /* ── furniture ─────────────────────────────────────────────────────────── */
  getFurnitureDef(id: string): FurnitureDef | undefined { return FURNITURE_DEF_MAP.get(id); }
  getAllFurnitureDefs(): readonly FurnitureDef[] { return FURNITURE_DEFS; }
  getFurnitureFor(purpose: RoomPurpose): readonly FurnitureDef[] { return FURNITURE_DEFS.filter((d) => furnitureAllowedIn(d, purpose)); }
  getPlaced(room?: number): readonly PlacedFurniture[] { return room === undefined ? this.state.furniture : this.state.furniture.filter((f) => f.room === room); }
  getPlacedByUid(uid: string): PlacedFurniture | null { return this.state.furniture.find((f) => f.uid === uid) ?? null; }
  getStored(): readonly StoredFurniture[] { return this.state.furnitureStorage; }

  canPlace(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): boolean {
    const def = FURNITURE_DEF_MAP.get(defId);
    return !!def && canPlaceAt(this.state, room, def, x, y, yaw, ignoreUid);
  }

  place(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): PlacedFurniture | null {
    const entry = this.storageEntry(defId);
    const def = FURNITURE_DEF_MAP.get(defId);
    if (!def || !entry || !this.canPlace(room, defId, x, y, yaw)) return null;
    this.takeFromStorage(entry);
    const item: PlacedFurniture = { uid: `f-${++this.nextUid}`, defId, room, x, y, yaw, level: entry.level };
    const limit = stackLimitOf(def);
    if (limit > 1) item.layer = Math.max(0, nextFreeLayer(stackMembers(this.state, room, def, x, y, yaw), limit));
    this.state.furniture.push(item);
    this.ctx.bus.emit('housing:furniturePlaced', { item });
    this.changed('place');
    if (this.selectedFurniture === defId && !this.storageEntry(defId)) this.selectFurniture(null);
    return item;
  }

  move(uid: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): boolean {
    const item = this.getPlacedByUid(uid);
    if (!item || !this.canPlace(item.room, item.defId, x, y, yaw, uid)) return false;
    if (item.x === x && item.y === y && item.yaw === yaw) return true;
    // a stacked piece may only leave its stack from the top, and lands on the lowest free layer of the target stack
    const def = FURNITURE_DEF_MAP.get(item.defId)!;
    const limit = stackLimitOf(def);
    if (limit > 1) {
      if (recoverBlockReason(this.state, item)) return false;
      const layer = nextFreeLayer(stackMembers(this.state, item.room, def, x, y, yaw, uid), limit);
      if (layer < 0) return false;
      item.layer = layer;
    }
    item.x = x; item.y = y; item.yaw = yaw;
    this.ctx.bus.emit('housing:furnitureMoved', { item });
    this.changed('move');
    return true;
  }

  /**
   * 한국어 reason `recover(uid)` would refuse (null = go ahead). A stack blocks (the top layer leaves first), and a
   * 책장 blocks while its books cannot go to the stash (`책을 먼저 빼세요`, a cell-count estimate — `recover` itself
   * does the real placement and rolls back).
   */
  recoverBlock(uid: string): string | null {
    const item = this.getPlacedByUid(uid);
    if (!item) return '설치되지 않은 가구입니다';
    return recoverBlockReason(this.state, item) ?? this.booksBlock(uid);
  }

  recover(uid: string): boolean {
    const i = this.state.furniture.findIndex((f) => f.uid === uid);
    if (i < 0) return false;
    const item = this.state.furniture[i];
    if (recoverBlockReason(this.state, item)) return false;
    // a 책장 hands its books to the stash first; when they do not all fit nothing moves
    const hadBooks = this.booksOf(uid).length;
    if (hadBooks > 0 && !this.stashBooksOf(uid)) { this.notify(BOOKS_BLOCK_REASON, 'warning'); return false; }
    this.state.furniture.splice(i, 1);
    this.addToStorage(item.defId, item.level);
    this.dropPlotsOf(uid);
    this.ctx.bus.emit('housing:furnitureRecovered', { uid, defId: item.defId, room: item.room });
    this.changed('recover');
    if (hadBooks > 0) this.ctx.bus.emit('housing:booksChanged', { uid, count: 0 });
    return true;
  }

  canCraftFurniture(defId: string): { ok: boolean; missing: CraftIngredient[] } {
    const def = FURNITURE_DEF_MAP.get(defId);
    if (!def || !def.craft) return { ok: false, missing: [] };
    const missing = missingIngredients(def.craft, this.countDef);
    return { ok: missing.length === 0, missing };
  }

  craftFurniture(defId: string): boolean {
    const def = FURNITURE_DEF_MAP.get(defId);
    if (!def || !def.craft || !this.canCraftFurniture(defId).ok) return false;
    if (!this.consume(def.craft)) return false;
    this.addToStorage(defId, 1);
    this.changed('craft');
    return true;
  }

  /** 한국어 reason a placed piece cannot be upgraded (null = can). */
  furnitureUpgradeBlock(uid: string): string | null {
    const item = this.getPlacedByUid(uid);
    return item ? furnitureUpgradeReason(this.state, item, this.countDef, this.nameOf) : '설치되지 않은 가구입니다';
  }

  upgradeFurniture(uid: string): boolean {
    const item = this.getPlacedByUid(uid);
    if (!item || furnitureUpgradeReason(this.state, item, this.countDef, this.nameOf)) return false;
    const def = FURNITURE_DEF_MAP.get(item.defId)!;
    const cost = nextFurnitureCost(def, item.level);
    if (!cost || !this.consume(cost)) return false;
    item.level += 1;
    this.ctx.bus.emit('housing:furnitureUpgraded', { item });
    this.changed('furnitureUpgrade');
    return true;
  }

  /* ── 온실 재배 (Phase 8) ───────────────────────────────────────────────── */
  private plots(): GrowPlot[] {
    if (!Array.isArray(this.state.plots)) this.state.plots = [];
    return this.state.plots;
  }

  /** The 재배층 behind `uid`, or null when it is not a rack (or gone). */
  private rackOf(uid: string): PlacedFurniture | null {
    const item = this.getPlacedByUid(uid);
    return item && isGrowRackDefId(item.defId) ? item : null;
  }

  private plotAt(uid: string, slot: number): GrowPlot | null {
    return this.plots().find((p) => p.uid === uid && p.slot === slot) ?? null;
  }

  /** Drop every plot of a rack that is being recovered (its crops go with it). */
  private dropPlotsOf(uid: string): void {
    const plots = this.plots();
    for (let i = plots.length - 1; i >= 0; i--) if (plots[i].uid === uid) plots.splice(i, 1);
  }

  /** Ready plots of a rack (for the `housing:growChanged` payload and the hub's rack visuals). */
  private readyCount(uid: string): number {
    const now = this.nowMs();
    return this.plots().filter((p) => p.uid === uid && now >= p.readyAt).length;
  }

  private growChanged(uid: string, reason: string): void {
    this.changed(reason);
    this.ctx.bus.emit('housing:growChanged', { uid, ready: this.readyCount(uid) });
  }

  /** Seed def with its `seed` data, or null when `defId` is not a seed. */
  private seedDef(defId: string): ItemDef | null {
    const def = this.defOf(defId);
    return def && def.seed ? def : null;
  }

  /** 원예 skill 0..SKILL_LEVEL_MAX. */
  private gardening(): number {
    const p = this.ctx.progression;
    if (!p || typeof p.getSkill !== 'function') return 0;
    const v = p.getSkill('gardening');
    return Number.isFinite(v) ? Math.max(0, Math.min(SKILL_LEVEL_MAX, v)) : 0;
  }

  getPlots(uid: string): GrowPlotInfo[] {
    if (!this.rackOf(uid)) return [];
    const now = this.nowMs();
    const out: GrowPlotInfo[] = [];
    for (let slot = 0; slot < GROW_PLOTS_PER_RACK; slot++) {
      const plot = this.plotAt(uid, slot);
      if (!plot) {
        out.push({ slot, seedDefId: null, progress: -1, remainingS: 0, ready: false, yieldDefId: null, yieldQty: 0 });
        continue;
      }
      const total = Math.max(1, plot.readyAt - plot.plantedAt);
      const seed = this.seedDef(plot.seedDefId)?.seed ?? null;
      out.push({
        slot,
        seedDefId: plot.seedDefId,
        progress: Math.max(0, Math.min(1, (now - plot.plantedAt) / total)),
        remainingS: Math.max(0, Math.ceil((plot.readyAt - now) / 1000)),
        ready: now >= plot.readyAt,
        yieldDefId: seed?.yieldDefId ?? null,
        yieldQty: seed ? this.yieldQty(seed.yieldQty) : 0,
      });
    }
    return out;
  }

  /** Harvest size after the 원예 `gatherYieldMul` (at least one unit). */
  private yieldQty(base: number): number {
    const mul = this.ctx.progression?.derived?.gatherYieldMul ?? 1;
    return Math.max(1, Math.round(base * (Number.isFinite(mul) && mul > 0 ? mul : 1)));
  }

  plantSeed(uid: string, slot: number, seedDefId: string): string | null {
    if (!this.rackOf(uid)) return '재배층이 아닙니다';
    if (!Number.isInteger(slot) || slot < 0 || slot >= GROW_PLOTS_PER_RACK) return '없는 재배 칸입니다';
    if (this.plotAt(uid, slot)) return '이미 씨앗이 심어져 있습니다';
    const def = this.seedDef(seedDefId);
    if (!def || !def.seed) return '씨앗이 아닙니다';
    if (this.countDef(seedDefId) < 1) return `${def.name}이(가) 없습니다`;
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(seedDefId, 1)) return '씨앗을 꺼낼 수 없습니다';
    const plantedAt = this.nowMs();
    // the 원예 speed-up is baked in once: a later skill change never moves a running timer
    const speed = 1 - GROW_SKILL_SPEEDUP * (this.gardening() / SKILL_LEVEL_MAX);
    const readyAt = plantedAt + Math.max(1000, Math.round(def.seed.growHours * 3600e3 * speed));
    this.plots().push({ uid, slot, seedDefId, plantedAt, readyAt });
    this.growChanged(uid, 'plant');
    return null;
  }

  harvestPlot(uid: string, slot: number): string | null {
    if (!this.rackOf(uid)) return '재배층이 아닙니다';
    const plot = this.plotAt(uid, slot);
    if (!plot) return '심어진 씨앗이 없습니다';
    const now = this.nowMs();
    if (now < plot.readyAt) return `아직 자라는 중입니다 (${formatRemaining(Math.ceil((plot.readyAt - now) / 1000))} 남음)`;
    const seed = this.seedDef(plot.seedDefId)?.seed ?? null;
    const loot = this.ctx.loot;
    if (!seed || !loot || typeof loot.createItem !== 'function') return '수확물을 만들 수 없습니다';
    const qty = this.yieldQty(seed.yieldQty);
    const item = loot.createItem(seed.yieldDefId, qty);
    const inv = this.ctx.inventory;
    const where = inv && typeof inv.tryAddItemAnywhere === 'function'
      ? inv.tryAddItemAnywhere(item)
      : inv && typeof inv.tryAddItem === 'function' && inv.tryAddItem(item) ? 'bag' : null;
    if (!where) return '가방과 창고에 자리가 없습니다';
    this.plots().splice(this.plots().indexOf(plot), 1);
    // the 원예 skill rises off `gather:collected`, exactly like a field herb node
    this.ctx.bus.emit('gather:collected', { nodeId: `grow:${uid}:${slot}`, defId: seed.yieldDefId, qty });
    this.growChanged(uid, 'harvest');
    return null;
  }

  harvestAll(uid: string): number {
    let taken = 0;
    for (let slot = 0; slot < GROW_PLOTS_PER_RACK; slot++) {
      const plot = this.plotAt(uid, slot);
      if (!plot || this.nowMs() < plot.readyAt) continue;
      if (this.harvestPlot(uid, slot) === null) taken++;
    }
    return taken;
  }

  getOwnedSeeds(): { defId: string; qty: number }[] {
    const loot = this.ctx.loot;
    if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
    const out: { defId: string; qty: number }[] = [];
    for (const def of loot.getAllItemDefs()) {
      if (!def.seed) continue;
      const qty = this.countDef(def.id);
      if (qty > 0) out.push({ defId: def.id, qty });
    }
    out.sort((a, b) => (this.seedDef(a.defId)?.seed?.growHours ?? 0) - (this.seedDef(b.defId)?.seed?.growHours ?? 0));
    return out;
  }

  openGrowMenu(uid: string): void {
    if (!this.growMenu) return;
    if (!this.rackOf(uid)) { this.notify('재배층이 없습니다', 'warning'); return; }
    this.exitHousingMode();
    this.closeMenus(false);
    this.growMenu.openRack(uid);
  }

  /* ── 승무원 호출명 (Phase 8) ─────────────────────────────────────────── */
  /** hub/ calls this the first time the player names the crew; afterwards the terminal shows a read-only line. */
  lockCrewName(): void {
    if (this.state.nameLocked === true) return;
    this.state.nameLocked = true;
    this.changed('name');
  }

  /* ── embedded 함선 view (the 함선 tab of the Tab screen) ───────────────── */
  createShipView(host: HTMLElement): EmbeddedView { return createShipView(this.ctx, this, host); }

  /* ── 서재 책장 (Phase 9) ────────────────────────────────────────────────── */
  /**
   * The shelved books. The save only shape-checks def ids (`book_*`); the first time `ctx.loot` is around every id
   * that is not a real 서적 any more is dropped here (a removed book def never breaks the shelf).
   */
  private books(): PlacedBook[] {
    if (!Array.isArray(this.state.books)) this.state.books = [];
    if (!this.booksPruned && this.ctx?.loot && typeof this.ctx.loot.getItemDef === 'function') {
      this.booksPruned = true;
      const books = this.state.books;
      for (let i = books.length - 1; i >= 0; i--) {
        if (!this.defOf(books[i].defId)?.book) { console.warn(`[housing] unknown book '${books[i].defId}' dropped from shelf ${books[i].uid}`); books.splice(i, 1); }
      }
    }
    return this.state.books;
  }

  private bookDex(): string[] {
    if (!Array.isArray(this.state.bookDex)) this.state.bookDex = [];
    return this.state.bookDex;
  }

  /** The 책장 behind `uid`, or null when it is not a bookshelf (or gone). */
  private shelfOf(uid: string): PlacedFurniture | null {
    const item = this.getPlacedByUid(uid);
    return item && isBookshelfDefId(item.defId) ? item : null;
  }

  private booksOf(uid: string): PlacedBook[] { return this.books().filter((b) => b.uid === uid); }

  private bookAt(uid: string, slot: number): PlacedBook | null {
    return this.books().find((b) => b.uid === uid && b.slot === slot) ?? null;
  }

  /** Drop every book of a shelf (used after they were moved to the stash, or by a recovered shelf). */
  private dropBooksOf(uid: string): void {
    const books = this.books();
    for (let i = books.length - 1; i >= 0; i--) if (books[i].uid === uid) books.splice(i, 1);
  }

  private booksChanged(uid: string, reason: string): void {
    this.changed(reason);
    this.ctx.bus.emit('housing:booksChanged', { uid, count: this.booksOf(uid).length });
  }

  /** Book def with its `book` data, or null when `defId` is not a 서적. */
  private bookDef(defId: string): ItemDef | null {
    const def = this.defOf(defId);
    return def && def.book ? def : null;
  }

  /** Free stash cells (cols × rows − occupied), −1 when inventory cannot tell. A cheap estimate for `recoverBlock`. */
  private freeStashCells(): number {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.getStashSize !== 'function' || typeof inv.getStashItems !== 'function') return -1;
    try {
      const size = inv.getStashSize();
      let used = 0;
      for (const it of inv.getStashItems()) {
        const def = this.defOf(it.defId);
        used += def ? def.width * def.height : 1;
      }
      return size.cols * size.rows - used;
    } catch { return -1; }
  }

  /** `책을 먼저 빼세요` while the shelf holds books the stash cannot take (by free-cell estimate), else null. */
  private booksBlock(uid: string): string | null {
    const books = this.booksOf(uid);
    if (!books.length) return null;
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.tryAddToStash !== 'function' || !this.ctx.loot || typeof this.ctx.loot.createItem !== 'function') return BOOKS_BLOCK_REASON;
    const free = this.freeStashCells();
    if (free < 0) return null;                                   // unknown → let `recover` try for real
    let need = 0;
    for (const b of books) { const def = this.defOf(b.defId); need += def ? def.width * def.height : 2; }
    return free >= need ? null : BOOKS_BLOCK_REASON;
  }

  /**
   * Move every book of `uid` into the stash (all or nothing: on the first refusal the ones already added are taken
   * back out with `takeItem`). True when the shelf is empty afterwards.
   */
  private stashBooksOf(uid: string): boolean {
    const books = this.booksOf(uid);
    if (!books.length) return true;
    const inv = this.ctx.inventory;
    const loot = this.ctx.loot;
    if (!inv || typeof inv.tryAddToStash !== 'function' || !loot || typeof loot.createItem !== 'function') return false;
    const added: string[] = [];
    for (const b of books) {
      const item = loot.createItem(b.defId, 1);
      if (!inv.tryAddToStash(item)) {
        if (typeof inv.takeItem === 'function') for (const u of added) inv.takeItem(u);
        return false;
      }
      added.push(item.uid);
    }
    this.dropBooksOf(uid);
    return true;
  }

  getBooks(uid: string): BookSlotInfo[] {
    if (!this.shelfOf(uid)) return [];
    const out: BookSlotInfo[] = [];
    for (let slot = 0; slot < BOOKS_PER_SHELF; slot++) {
      const book = this.bookAt(uid, slot);
      const def = book ? this.bookDef(book.defId) : null;
      out.push({
        slot,
        defId: book?.defId ?? null,
        skill: def?.book?.skill ?? null,
        rarity: def?.rarity ?? null,
        weight: def ? bookWeightOf(def) : 0,
      });
    }
    return out;
  }

  placeBook(uid: string, slot: number, defId: string): string | null {
    if (!this.shelfOf(uid)) return '책장이 아닙니다';
    if (this.ctx.phase !== 'hub') return '함선에서만 책을 꽂을 수 있습니다';
    if (!Number.isInteger(slot) || slot < 0 || slot >= BOOKS_PER_SHELF) return '없는 책장 칸입니다';
    if (this.bookAt(uid, slot)) return '이미 책이 꽂혀 있습니다';
    const def = this.bookDef(defId);
    if (!def) return '서적이 아닙니다';
    if (this.countDef(defId) < 1) return `${def.name}이(가) 없습니다`;
    const inv = this.ctx.inventory;
    // `consumeDefAll` takes from the bag first, then the stash
    if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(defId, 1)) return '책을 꺼낼 수 없습니다';
    this.books().push({ uid, slot, defId });
    const dex = this.bookDex();
    if (!dex.includes(defId)) dex.push(defId);
    this.booksChanged(uid, 'bookPlace');
    return null;
  }

  takeBook(uid: string, slot: number): string | null {
    if (!this.shelfOf(uid)) return '책장이 아닙니다';
    const book = this.bookAt(uid, slot);
    if (!book) return '꽂힌 책이 없습니다';
    const loot = this.ctx.loot;
    if (!loot || typeof loot.createItem !== 'function') return '책을 만들 수 없습니다';
    const item = loot.createItem(book.defId, 1);
    const inv = this.ctx.inventory;
    const where = inv && typeof inv.tryAddItemAnywhere === 'function'
      ? inv.tryAddItemAnywhere(item)
      : inv && typeof inv.tryAddItem === 'function' && inv.tryAddItem(item) ? 'bag' : null;
    if (!where) return '공간 없음 — 가방과 창고에 자리가 없습니다';
    this.books().splice(this.books().indexOf(book), 1);
    this.booksChanged(uid, 'bookTake');
    return null;
  }

  getOwnedBooks(): { defId: string; qty: number }[] {
    const loot = this.ctx.loot;
    if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
    const out: { defId: string; qty: number }[] = [];
    for (const def of loot.getAllItemDefs()) {
      if (!def.book) continue;
      const qty = this.countDef(def.id);
      if (qty > 0) out.push({ defId: def.id, qty });
    }
    const order = (defId: string): number => { const i = SKILL_IDS.indexOf(this.bookDef(defId)?.book?.skill as SkillId); return i < 0 ? SKILL_IDS.length : i; };
    out.sort((a, b) => order(a.defId) - order(b.defId));
    return out;
  }

  getBookBonus(skill: SkillId): number { return bookGainMulFor(skill, this.books(), this.defOf); }

  getBookDex(): readonly string[] { return this.bookDex(); }

  openBookshelfMenu(uid: string): void {
    if (!this.bookshelfMenu) return;
    if (!this.shelfOf(uid)) { this.notify('책장이 없습니다', 'warning'); return; }
    this.exitHousingMode();
    this.closeMenus(false);
    this.bookshelfMenu.openShelf(uid);
  }

  /* ── loadout presets (사격장) ──────────────────────────────────────────── */
  getPresetCount(): number { return presetCountFor(facilityLevel(this.state, 'range')); }

  getPresets(): readonly (LoadoutPreset | null)[] {
    const n = this.getPresetCount();
    return Array.from({ length: n }, (_, i) => this.state.presets[i] ?? null);
  }

  savePreset(index: number, preset: LoadoutPreset): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.getPresetCount() || !preset) return false;
    const implant = preset.implant && (IMPLANT_IDS as readonly string[]).includes(preset.implant) ? preset.implant : null;
    const copy: LoadoutPreset = {
      name: (preset.name || `프리셋 ${index + 1}`).slice(0, PRESET_NAME_MAX),
      primary: preset.primary ?? null, primary2: preset.primary2 ?? null, secondary: preset.secondary ?? null,
      bag: preset.bag ?? null, armor: preset.armor ?? null, implant,
    };
    while (this.state.presets.length <= index) this.state.presets.push(null);
    this.state.presets[index] = copy;
    this.changed('preset');
    return true;
  }

  deletePreset(index: number): boolean {
    if (!this.state.presets[index]) return false;
    this.state.presets[index] = null;
    while (this.state.presets.length && this.state.presets[this.state.presets.length - 1] === null) this.state.presets.pop();
    this.changed('preset');
    return true;
  }

  applyPreset(index: number): { equipped: number; missing: string[] } | null {
    const preset = index >= 0 && index < this.getPresetCount() ? this.state.presets[index] : null;
    if (!preset || this.ctx.phase !== 'hub') return null;
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.applyLoadout !== 'function') return null;
    const result = inv.applyLoadout(preset);
    this.ctx.bus.emit('housing:presetApplied', { index, equipped: result.equipped, missing: result.missing });
    return result;
  }

  /** Current equipment as a preset (`ctx.inventory.captureLoadout`), null while inventory has no capture yet. */
  captureLoadout(): LoadoutPreset | null {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.captureLoadout !== 'function') return null;
    return inv.captureLoadout();
  }

  /* ── UI ────────────────────────────────────────────────────────────────── */
  private panels(): HousingPanel[] {
    const out: HousingPanel[] = [];
    if (this.presetMenu) out.push(this.presetMenu);
    if (this.growMenu) out.push(this.growMenu);
    if (this.bookshelfMenu) out.push(this.bookshelfMenu);
    return out;
  }

  get isMenuOpen(): boolean { return this.panels().some((p) => p.isOpen); }

  /**
   * Phase 8 UI pass: the standalone 방 메뉴 and 함선 시설 메뉴 are gone — rooms and facilities are managed from the
   * Tab 함선 tab (`createShipView`) and from 시설 관리. Both entries stay in the contract and redirect there, so an
   * old caller opens the manage screen on that room instead of nothing at all.
   */
  openRoomMenu(room: number): void {
    this.openShipManage(isRoomIndex(this.state, room) ? room : undefined);
  }

  openFacilityMenu(): void {
    this.openShipManage();
  }

  openPresetMenu(): void {
    if (!this.presetMenu) return;
    this.exitHousingMode();
    this.closeMenus(false);
    if (this.getPresetCount() === 0) this.notify('사격장 방이 있어야 프리셋을 쓸 수 있습니다', 'warning');
    this.presetMenu.open();
  }

  /** Close every panel; `relock` false when another panel opens right away. */
  closeMenus(relock = true): void {
    for (const p of this.panels()) if (p.isOpen) p.close(relock);
  }

  save(): void { this.store?.flush(); }
}
