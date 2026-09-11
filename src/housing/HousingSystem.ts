import type {
  BookSlotInfo, CraftIngredient, EmbeddedView, FacilityId, FacilityInfo, FurnitureDef, GameContext, GameSystem, GrowPlotInfo,
  GrowSlot, GrowSlotInfo, GrowTier,
  HousingRef, ItemDef, LoadoutPreset, PlacedBook, PlacedFurniture, ProfileRef, RoomPurpose, RoomState, ShipState, SkillId,
  StoredFurniture, WorkbenchKind,
} from '@/shared';
import { ShipStore, loadState, maxUidIndex, sanitize, writeState } from './ShipState';
import type { SanitizeOutcome } from './ShipState';
import { mergeCost } from './Rules';
import { PresetMenu } from './ui/PresetMenu';
import { GrowStation } from './ui/GrowStation';
import { BookshelfMenu } from './ui/BookshelfMenu';
import { createShipView } from './ui/ShipView';
import type { HousingPanel } from './ui/Panel';
import './housing.css';

import { BOOKS_BLOCK_REASON, FACILITY_IDS, PRESET_NAME_MAX } from './model';
/** 폴더 공용 어휘(상수 · 타입 · 스크래치)는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 재수출한다. */
export * from './model';
import * as Rooms from './parts/Rooms';
import * as Furn from './parts/Furniture';
import * as Garden from './parts/Garden';
import * as Lib from './parts/Library';
import * as Preset from './parts/Presets';

export class HousingSystem implements GameSystem, HousingRef {
  readonly name = 'housing';
  state: ShipState;
  housingMode = false;
  housingRoom: number | null = null;
  selectedFurniture: string | null = null;
  selectedYaw: 0 | 1 | 2 | 3 = 0;
  /** Phase 8: housing mode entered from the M screen (no "stand inside the room" gate, room list + furniture bar). */
  shipManageMode = false;

  ctx!: GameContext;
  private store: ShipStore | null = null;
  nextUid = 0;
  private fresh = false;
  /**
   * 2026-09-11: a real edit (`changed()`) happened — as opposed to the boot-time "fresh state" save. Together with
   * `ShipStore.isDirty` it tells `onProfileLoaded` that the local state holds an edit **newer than anything the profile
   * has seen**, which must not be thrown away (see there).
   */
  private editPending = false;
  private unsubs: Array<() => void> = [];
  presetMenu: PresetMenu | null = null;
  growStation: GrowStation | null = null;
  bookshelfMenu: BookshelfMenu | null = null;
  lastStash = { cols: 0, rows: 0 };
  /** `books` were checked against `ctx.loot` once (unknown / non-book ids dropped) — see `books()`. */
  booksPruned = false;
  /** `grows` were checked against `ctx.loot` once (unknown 토양 / 씨앗 dropped) — see `grows()`. */
  growsPruned = false;
  /**
   * 온실 개편 (2026-09-11): materials owed for the 은퇴 가구 `ShipState.sanitize` swept out of the save. housing/ is
   * registered **before** inventory/, so the 함선 창고 does not exist yet at load time — `update()` pays this into it
   * on the first frame where `ctx.inventory` is around (`flushRetiredRefund`).
   */
  private pendingRefund: CraftIngredient[] = [];

  constructor() {
    const loaded = loadState();
    this.state = loaded.state;
    this.fresh = loaded.fresh;
    this.pendingRefund = loaded.refund;
    this.nextUid = maxUidIndex(this.state.furniture);
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.housing = this;
    this.store = new ShipStore(() => this.state, () => this.profileRef());
    if (this.fresh) this.store.markDirty();
    this.presetMenu = new PresetMenu(ctx, this);
    this.growStation = new GrowStation(ctx, this);
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
    if (this.pendingRefund.length) this.flushRetiredRefund();
    if (this.housingMode && (ctx.phase !== 'hub' || ctx.hub?.ship !== 'personal')) this.exitHousingMode();
  }

  dispose(): void {
    this.closeMenus();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.presetMenu?.dispose(); this.growStation?.dispose(); this.bookshelfMenu?.dispose();
    this.presetMenu = null; this.growStation = null; this.bookshelfMenu = null;
    this.store?.dispose(); this.store = null;
  }

  /**
   * 온실 개편 (2026-09-11): pay the 은퇴 가구 refund into the **함선 창고**. Runs on the first frame the inventory
   * exists (housing/ loads its state before inventory/ is even registered). The stash may be full — then only what
   * fits goes in and the rest is dropped with a 한국어 경고 **and** a console line: 조용히 사라지지 않는다.
   */
  private flushRetiredRefund(): void {
    const cost = this.pendingRefund;
    if (!cost.length) return;
    const inv = this.ctx?.inventory, loot = this.ctx?.loot;
    if (!inv || typeof inv.tryAddToStash !== 'function' || !loot || typeof loot.createItem !== 'function') return;
    this.pendingRefund = [];
    const lost = this.refundToStash(cost);
    if (lost > 0) {
      console.warn(`[housing] retired furniture refund: ${lost} units dropped (함선 창고가 가득 참)`);
      this.notify('은퇴한 재배층을 정리했습니다 — 함선 창고가 가득 차 재료 일부를 돌려주지 못했습니다', 'warning');
    } else {
      this.notify('은퇴한 재배층을 정리하고 재료를 함선 창고에 돌려주었습니다', 'info');
    }
    this.changed('retired');
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
    /* 2026-09-11 — **an edit still inside the 350 ms save debounce wins.** The welcome can land right after a
       placement (slow relay, loaded machine): `p.get('ship')` then returns the profile's copy — the server's, or our
       own *older* offline-queued save (e.g. the boot-time fresh state) — and replacing the state with it while
       `store.cancel()` dropped the pending write **silently undid the edit** (furniture placed, then gone: 0 meshes,
       no interactable; `smoke-training` went red under load). The edit is the newest document by definition
       (ProfileSync is newest-wins), so write it now — it is stamped and uploaded — and keep the local state. */
    if (this.editPending && this.store?.isDirty) {
      this.editPending = false;
      this.store.flush();
      return;
    }
    let doc: unknown;
    try { doc = p.get('ship'); } catch { doc = undefined; }
    if (!doc || typeof doc !== 'object') { this.store?.upload(); return; }
    this.closeMenus();
    this.exitHousingMode();
    this.store?.cancel();
    this.editPending = false;
    const out: SanitizeOutcome = { refund: [] };
    this.state = sanitize(doc, out);
    if (out.refund.length) mergeCost(this.pendingRefund, out.refund);   // 서버 사본에도 은퇴 가구가 있을 수 있다
    this.nextUid = maxUidIndex(this.state.furniture);
    this.booksPruned = false;
    this.growsPruned = false;
    this.fresh = false;
    writeState(this.state);                      // localStorage is the cache of the server copy (not re-uploaded)
    const b = this.ctx.bus;
    b.emit('housing:loaded', { state: this.state });
    b.emit('housing:changed', { reason: 'profile' });
    this.emitStashSizeIfChanged();
  }

  /* ── helpers ───────────────────────────────────────────────────────────── */
  changed(reason: string): void {
    this.editPending = true;
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
  nowMs(): number {
    const net = this.ctx.net;
    if (net && typeof net.serverNow === 'function') {
      const t = net.serverNow();
      if (Number.isFinite(t) && t > 0) return t;
    }
    return Date.now();
  }

  canAfford(cost: readonly CraftIngredient[]): boolean { return Rooms.canAfford(this, cost); }

  /** All-or-nothing: verified with `countDef` first, then consumed def by def. */
  consume(cost: readonly CraftIngredient[]): boolean { return Rooms.consume(this, cost); }

  notify(text: string, kind: 'info' | 'warning' | 'danger' | 'success' = 'info'): void {
    this.ctx.bus.emit('ui:notify', { text, kind });
  }

  storageEntry(defId: string): StoredFurniture | null { return Furn.storageEntry(this, defId); }

  addToStorage(defId: string, level: number, qty = 1): void { return Furn.addToStorage(this, defId, level, qty); }

  takeFromStorage(entry: StoredFurniture): void { return Furn.takeFromStorage(this, entry); }

  emitStashSizeIfChanged(): void { return Rooms.emitStashSizeIfChanged(this); }

  /* ── housing mode ──────────────────────────────────────────────────────── */
  /** Why housing mode cannot start for `room`; null = fine. */
  housingModeBlock(room: number): string | null { return Furn.housingModeBlock(this, room); }

  /** Why 함선 관리 cannot start at all (no room gate — that is what separates it from `enterHousingMode`). */
  shipManageBlock(): string | null { return Furn.shipManageBlock(this); }

  enterHousingMode(room: number): boolean { return Furn.enterHousingMode(this, room); }

  /** Shared body of `enterHousingMode` / `openShipManage` — the gates differ, the state change does not. */
  enterMode(room: number): boolean { return Furn.enterMode(this, room); }

  exitHousingMode(): void { return Furn.exitHousingMode(this); }

  /* ── 함선 관리 (Phase 8, M in the ship) ────────────────────────────────── */
  /**
   * Enter the ship-management screen: the housing-mode camera / cursor without the "player stands in the room" gate,
   * plus the room list + furniture bar ui/ draws off `housing:shipManageChanged`. Default room: the one the player is
   * standing in, else the first room with a purpose, else room 1.
   */
  openShipManage(room?: number): boolean { return Furn.openShipManage(this, room); }

  setManageRoom(room: number): boolean { return Furn.setManageRoom(this, room); }

  closeShipManage(): void { return Furn.closeShipManage(this); }

  /** `null` clears the selection; a def that is not in furniture storage is ignored (selection unchanged). */
  selectFurniture(defId: string | null): void { return Furn.selectFurniture(this, defId); }

  rotateSelection(): void { return Furn.rotateSelection(this); }

  /* ── rooms ─────────────────────────────────────────────────────────────── */
  getRoom(index: number): RoomState { return Rooms.getRoom(this, index); }

  /**
   * 한국어 reason `setRoomPurpose` would refuse (null = allowed). Used by the room menu for button hints. `empty`
   * recovers every piece, so it is also refused while a 책장 in the room cannot hand its books to the stash.
   */
  purposeBlock(index: number, purpose: RoomPurpose): string | null { return Rooms.purposeBlock(this, index, purpose); }

  /** Materials a 시설 증축 to `purpose` would consume (empty for 빈 방). The pickers render these as cost chips. */
  purposeCost(purpose: RoomPurpose): readonly CraftIngredient[] { return Rooms.purposeCost(this, purpose); }

  /** Why the room cannot be emptied right now (a 책장 whose books have no stash room), null when it can. */
  emptyRoomBlock(index: number): string | null { return Rooms.emptyRoomBlock(this, index); }

  /**
   * Give room `index` a purpose. Since the Phase 9 UI pass a 시설 증축 **consumes** `purposeBuildCost(purpose)` from
   * bag + stash (all-or-nothing) and needs 발전기 Lv.1; 빈 방 is free and is the path `removeRoomFacility` takes
   * after it has already worked out the refund.
   */
  setRoomPurpose(index: number, purpose: RoomPurpose): boolean { return Rooms.setRoomPurpose(this, index, purpose); }

  findRoom(purpose: RoomPurpose): number { return Rooms.findRoom(this, purpose); }

  /* ── facilities ────────────────────────────────────────────────────────── */
  getFacilities(): FacilityInfo[] { return Rooms.getFacilities(this); }

  getFacility(id: FacilityId): FacilityInfo { return Rooms.getFacility(this, id); }

  upgrade(id: FacilityId): boolean { return Rooms.upgrade(this, id); }

  /**
   * Materials the player would get back by removing the facility in room `index` — the sum of every upgrade it was
   * raised with — the 시설 증축 price of level 1 plus every upgrade (`Rules.roomRefundCost`). Empty for a 빈 방.
   */
  facilityRefund(index: number): CraftIngredient[] { return Rooms.facilityRefund(this, index); }

  /**
   * 시설 제거 (Phase 9 UI pass): give the room back. Every placed piece goes to furniture storage (that is
   * `setRoomPurpose(index, 'empty')`) and every material spent on the facility's upgrades is refunded into the
   * **함선 창고**. All-or-nothing: when the stash cannot take the refund nothing is touched and the 한국어 reason is
   * returned (null = removed).
   */
  removeRoomFacility(index: number): string | null { return Rooms.removeRoomFacility(this, index); }

  /** 한국어 reason the stash cannot take `cost` (free-cell estimate, deliberately conservative); null when it can. */
  stashSpaceBlock(cost: readonly CraftIngredient[]): string | null { return Rooms.stashSpaceBlock(this, cost); }

  /** Drop `cost` into the stash, splitting at `stackMax`. Returns how many units could **not** be placed. */
  refundToStash(cost: readonly CraftIngredient[]): number { return Rooms.refundToStash(this, cost); }

  getBenchLevel(kind: WorkbenchKind): number { return Rooms.getBenchLevel(this, kind); }

  getCraftCostMul(): number { return Rooms.getCraftCostMul(this); }
  /** 사격장 (`gun_*` × `1 + 0.1 × level`) × 서재 (`getBookBonus`, every shelved book of that skill). */
  getSkillGainMul(skill: SkillId): number { return Rooms.getSkillGainMul(this, skill); }
  getStashSize(): { cols: number; rows: number } { return Rooms.getStashSize(this); }

  /* ── furniture ─────────────────────────────────────────────────────────── */
  getFurnitureDef(id: string): FurnitureDef | undefined { return Furn.getFurnitureDef(this, id); }
  getAllFurnitureDefs(): readonly FurnitureDef[] { return Furn.getAllFurnitureDefs(this); }
  getFurnitureFor(purpose: RoomPurpose): readonly FurnitureDef[] { return Furn.getFurnitureFor(this, purpose); }
  getPlaced(room?: number): readonly PlacedFurniture[] { return Furn.getPlaced(this, room); }
  getPlacedByUid(uid: string): PlacedFurniture | null { return Furn.getPlacedByUid(this, uid); }
  getStored(): readonly StoredFurniture[] { return Furn.getStored(this); }

  canPlace(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): boolean { return Furn.canPlace(this, room, defId, x, y, yaw, ignoreUid); }

  /**
   * 자동 배치가 고를 자리 (2026-09-10): 화면 좌측 상단부터 가로줄 먼저, 가구는 화면 아래를 향한다 (yaw 1).
   * 근거와 좌표 유도는 `Rules.autoPlaceSpot`. `null` = 이 방에 자리가 없다.
   */
  findFreeSpot(room: number, defId: string): { x: number; y: number; yaw: 0 | 1 | 2 | 3 } | null { return Furn.findFreeSpot(this, room, defId); }

  place(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): PlacedFurniture | null { return Furn.place(this, room, defId, x, y, yaw); }

  move(uid: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): boolean { return Furn.move(this, uid, x, y, yaw); }

  /**
   * 한국어 reason `recover(uid)` would refuse (null = go ahead). A stack blocks (the top layer leaves first), and a
   * 책장 blocks while its books cannot go to the stash (`책을 먼저 빼세요`, a cell-count estimate — `recover` itself
   * does the real placement and rolls back).
   */
  recoverBlock(uid: string): string | null { return Furn.recoverBlock(this, uid); }

  recover(uid: string): boolean { return Furn.recover(this, uid); }

  canCraftFurniture(defId: string): { ok: boolean; missing: CraftIngredient[] } { return Furn.canCraftFurniture(this, defId); }

  craftFurniture(defId: string): boolean { return Furn.craftFurniture(this, defId); }

  /** 한국어 reason a placed piece cannot be upgraded (null = can). */
  furnitureUpgradeBlock(uid: string): string | null { return Furn.furnitureUpgradeBlock(this, uid); }

  upgradeFurniture(uid: string): boolean { return Furn.upgradeFurniture(this, uid); }

  /* ── 온실 재배 스테이션 (2026-09-11) ───────────────────────────────────── */
  /** 재배 스테이션 칸 (`ShipState.grows`); prunes ids `ctx.loot` no longer knows on first access. */
  grows(): GrowSlot[] { return Garden.grows(this); }

  /** The 재배 스테이션 behind `uid`, or null when it is not one (or gone). */
  stationOf(uid: string): PlacedFurniture | null { return Garden.stationOf(this, uid); }

  growSlotAt(uid: string, tier: GrowTier, slot: number): GrowSlot | null { return Garden.growSlotAt(this, uid, tier, slot); }

  /** Drop every 칸 of a station that is being recovered (its soil and crops go with it). */
  dropGrowsOf(uid: string): void { return Garden.dropGrowsOf(this, uid); }

  /** Ripe 칸 of a station (for the `housing:growChanged` payload and the hub's station visuals). */
  readyCount(uid: string): number { return Garden.readyCount(this, uid); }

  growChanged(uid: string, reason: string): void { return Garden.growChanged(this, uid, reason); }

  /** Seed def with its `seed` data, or null when `defId` is not a seed. */
  seedDef(defId: string): ItemDef | null { return Garden.seedDef(this, defId); }

  /** Soil def with its `soil` data, or null when `defId` is not a 토양. */
  soilDef(defId: string): ItemDef | null { return Garden.soilDef(this, defId); }

  /** 원예 skill 0..SKILL_LEVEL_MAX. */
  gardening(): number { return Garden.gardening(this); }

  /** Harvest size after the 원예 `gatherYieldMul` (at least one unit). */
  yieldQty(base: number): number { return Garden.yieldQty(this, base); }

  getGrowSlots(uid: string): GrowSlotInfo[] { return Garden.getGrowSlots(this, uid); }

  fillSoil(uid: string, tier: GrowTier, slot: number, soilDefId: string): string | null { return Garden.fillSoil(this, uid, tier, slot, soilDefId); }

  clearSoil(uid: string, tier: GrowTier, slot: number): string | null { return Garden.clearSoil(this, uid, tier, slot); }

  plantSeedAt(uid: string, tier: GrowTier, slot: number, seedDefId: string): string | null { return Garden.plantSeedAt(this, uid, tier, slot, seedDefId); }

  harvestAt(uid: string, tier: GrowTier, slot: number): string | null { return Garden.harvestAt(this, uid, tier, slot); }

  harvestAllStation(uid: string): number { return Garden.harvestAllStation(this, uid); }

  getOwnedSoils(): { defId: string; qty: number }[] { return Garden.getOwnedSoils(this); }

  getOwnedSeeds(): { defId: string; qty: number }[] { return Garden.getOwnedSeeds(this); }

  openGrowStation(uid: string): void { return Garden.openGrowStation(this, uid); }

  /* ── 은퇴한 재배층 (Phase 8 API) ────────────────────────────────────────────
   * 계약은 추가만 하므로 남아 있지만, 그 가구(`furn_grow_rack`)는 은퇴했고 `sanitize` 가 함선에서 걷어낸다.
   * 전부 「없는 재배층」 응답이다 — 조용히 성공한 척하지 않는다. */
  /** @deprecated 2026-09-11 (온실 개편) — `getGrowSlots`. 언제나 빈 배열. */
  getPlots(uid: string): GrowPlotInfo[] { return Garden.getPlots(this, uid); }
  /** @deprecated 2026-09-11 (온실 개편) — `plantSeedAt`. */
  plantSeed(uid: string, slot: number, seedDefId: string): string | null { return Garden.plantSeed(this, uid, slot, seedDefId); }
  /** @deprecated 2026-09-11 (온실 개편) — `harvestAt`. */
  harvestPlot(uid: string, slot: number): string | null { return Garden.harvestPlot(this, uid, slot); }
  /** @deprecated 2026-09-11 (온실 개편) — `harvestAllStation`. 언제나 0. */
  harvestAll(uid: string): number { return Garden.harvestAll(this, uid); }
  /** @deprecated 2026-09-11 (온실 개편) — `openGrowStation`. 아무 일도 하지 않는다. */
  openGrowMenu(uid: string): void { return Garden.openGrowMenu(this, uid); }

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
  books(): PlacedBook[] { return Lib.books(this); }

  bookDex(): string[] { return Lib.bookDex(this); }

  /** The 책장 behind `uid`, or null when it is not a bookshelf (or gone). */
  shelfOf(uid: string): PlacedFurniture | null { return Lib.shelfOf(this, uid); }

  booksOf(uid: string): PlacedBook[] { return Lib.booksOf(this, uid); }

  bookAt(uid: string, slot: number): PlacedBook | null { return Lib.bookAt(this, uid, slot); }

  /** Drop every book of a shelf (used after they were moved to the stash, or by a recovered shelf). */
  dropBooksOf(uid: string): void { return Lib.dropBooksOf(this, uid); }

  booksChanged(uid: string, reason: string): void { return Lib.booksChanged(this, uid, reason); }

  /** Book def with its `book` data, or null when `defId` is not a 서적. */
  bookDef(defId: string): ItemDef | null { return Lib.bookDef(this, defId); }

  /** Free stash cells (cols × rows − occupied), −1 when inventory cannot tell. A cheap estimate for `recoverBlock`. */
  freeStashCells(): number { return Lib.freeStashCells(this); }

  /** `책을 먼저 빼세요` while the shelf holds books the stash cannot take (by free-cell estimate), else null. */
  booksBlock(uid: string): string | null { return Lib.booksBlock(this, uid); }

  /**
   * Move every book of `uid` into the stash (all or nothing: on the first refusal the ones already added are taken
   * back out with `takeItem`). True when the shelf is empty afterwards.
   */
  stashBooksOf(uid: string): boolean { return Lib.stashBooksOf(this, uid); }

  getBooks(uid: string): BookSlotInfo[] { return Lib.getBooks(this, uid); }

  placeBook(uid: string, slot: number, defId: string): string | null { return Lib.placeBook(this, uid, slot, defId); }

  takeBook(uid: string, slot: number): string | null { return Lib.takeBook(this, uid, slot); }

  getOwnedBooks(): { defId: string; qty: number }[] { return Lib.getOwnedBooks(this); }

  getBookBonus(skill: SkillId): number { return Lib.getBookBonus(this, skill); }

  getBookDex(): readonly string[] { return Lib.getBookDex(this); }

  openBookshelfMenu(uid: string): void { return Lib.openBookshelfMenu(this, uid); }

  /* ── loadout presets (사격장) ──────────────────────────────────────────── */
  getPresetCount(): number { return Preset.getPresetCount(this); }

  getPresets(): readonly (LoadoutPreset | null)[] { return Preset.getPresets(this); }

  savePreset(index: number, preset: LoadoutPreset): boolean { return Preset.savePreset(this, index, preset); }

  deletePreset(index: number): boolean { return Preset.deletePreset(this, index); }

  applyPreset(index: number): { equipped: number; missing: string[] } | null { return Preset.applyPreset(this, index); }

  /** Current equipment as a preset (`ctx.inventory.captureLoadout`), null while inventory has no capture yet. */
  captureLoadout(): LoadoutPreset | null { return Preset.captureLoadout(this); }

  /* ── UI ────────────────────────────────────────────────────────────────── */
  panels(): HousingPanel[] { return Preset.panels(this); }

  get isMenuOpen(): boolean { return this.panels().some((p) => p.isOpen); }

  /**
   * Phase 8 UI pass: the standalone 방 메뉴 and 함선 시설 메뉴 are gone — rooms and facilities are managed from the
   * Tab 함선 tab (`createShipView`) and from 시설 관리. Both entries stay in the contract and redirect there, so an
   * old caller opens the manage screen on that room instead of nothing at all.
   */
  openRoomMenu(room: number): void { return Preset.openRoomMenu(this, room); }

  openFacilityMenu(): void { return Preset.openFacilityMenu(this); }

  openPresetMenu(): void { return Preset.openPresetMenu(this); }

  /** Close every panel; `relock` false when another panel opens right away. */
  closeMenus(relock = true): void { return Preset.closeMenus(this, relock); }

  save(): void { this.store?.flush(); }
}
