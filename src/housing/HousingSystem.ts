import type {
  AnalysisSlot, AnalysisSlotInfo,
  BookSlotInfo, CraftIngredient, CultureSlot, CultureSlotInfo, EmbeddedView, FacilityId, FacilityInfo, FacilityRequirement, FurnitureDef,
  GameContext, GameSystem, GrowPlotInfo,
  GrowSlot, GrowSlotInfo, GrowTier, HarvestDestination,
  HousingRef, ItemDef, LoadoutPreset, PlacedBook, PlacedFurniture, ProfileRef, RoomPurpose, RoomState, ShipState, SkillId,
  StoredFurniture, WorkbenchKind,
} from '@/shared';
import { ShipStore, loadState, maxUidIndex, sanitize, writeState } from './ShipState';
import type { SanitizeOutcome } from './ShipState';
import { mergeCost } from './Rules';
import { GrowStation } from './ui/GrowStation';
import { Analyzer } from './ui/Analyzer';
import { CultureTank } from './ui/CultureTank';
import { DiningTable } from './ui/DiningTable';
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
import * as Lab from './parts/Lab';
import * as Culture from './parts/Culture';
import * as Dining from './parts/Dining';
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
   * 2026-09-12 (v7 · v8): the local save carried 작업실 / 사격장 room levels, 방 9 · 10 or a 시뮬레이션실 / 휴식 공간 that
   * `sanitize` moved or refunded — write it back and keep it over an older server copy.
   */
  private migrated = false;
  /** 2026-09-12: `sanitize` put back a 공용 시설 가구 (조종석) the save had lost — write it back (not an edit). */
  private granted = false;
  /**
   * 2026-09-11: a real edit (`changed()`) happened — as opposed to the boot-time "fresh state" save. Together with
   * `ShipStore.isDirty` it tells `onProfileLoaded` that the local state holds an edit **newer than anything the profile
   * has seen**, which must not be thrown away (see there).
   */
  private editPending = false;
  private unsubs: Array<() => void> = [];
  /* 2026-09-12: `presetMenu` (ui/PresetMenu) is gone with the preset feature — see `parts/Presets.ts` */
  growStation: GrowStation | null = null;
  /** 분석 화면 (연구실, 2026-09-11). 이름이 `analyzer` 가 아닌 것은 `openAnalyzer` 메서드와 겹치지 않게 하기 위함이다. */
  analyzerPanel: Analyzer | null = null;
  /** 배양 화면 (배양조 A-14, 2026-09-11) — 메서드는 `openCultureTank` 라 이름이 겹치지 않는다. */
  cultureTank: CultureTank | null = null;
  /** 식사 화면 (주방 A-3c, 2026-09-11) — 메서드는 `openDiningTable` 이다. */
  diningTable: DiningTable | null = null;
  bookshelfMenu: BookshelfMenu | null = null;
  lastStash = { cols: 0, rows: 0 };
  /** `books` were checked against `ctx.loot` once (unknown / non-book ids dropped) — see `books()`. */
  booksPruned = false;
  /** `grows` were checked against `ctx.loot` once (unknown 토양 / 씨앗 dropped) — see `grows()`. */
  growsPruned = false;
  /** `analyses` were checked against `ctx.loot` once (unknown 표본 dropped) — see `analyses()`. */
  analysesPruned = false;
  /** `cultures` were checked against `ctx.loot` once (unknown 배지 / 세포주 dropped) — see `cultures()`. */
  culturesPruned = false;
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
    this.migrated = loaded.migrated;
    this.granted = loaded.granted;
    this.nextUid = maxUidIndex(this.state.furniture);
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.housing = this;
    this.store = new ShipStore(() => this.state, () => this.profileRef());
    if (this.fresh || this.migrated || this.granted) this.store.markDirty();
    // v7 · v8: the moved levels / removed rooms are a local edit the server copy has never seen — a welcome inside the debounce must not undo it
    if (this.migrated) this.editPending = true;
    this.growStation = new GrowStation(ctx, this);
    this.analyzerPanel = new Analyzer(ctx, this);
    this.cultureTank = new CultureTank(ctx, this);
    this.diningTable = new DiningTable(ctx, this);
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
    this.growStation?.dispose(); this.analyzerPanel?.dispose();
    this.cultureTank?.dispose(); this.diningTable?.dispose(); this.bookshelfMenu?.dispose();
    this.growStation = null; this.analyzerPanel = null;
    this.cultureTank = null; this.diningTable = null; this.bookshelfMenu = null;
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
      console.warn(`[housing] retired furniture / room level refund: ${lost} units dropped (함선 창고가 가득 참)`);
      this.notify('없어진 시설 · 가구를 정리했습니다 — 함선 창고가 가득 차 재료 일부를 돌려주지 못했습니다', 'warning');
    } else {
      // 2026-09-12: 은퇴 재배층뿐 아니라 사라진 방 시설 레벨(작업실 · 사격장)의 환불도 같은 자루로 온다
      this.notify('없어진 시설 · 가구를 정리하고 재료를 함선 창고에 돌려주었습니다', 'info');
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
    this.analysesPruned = false;
    this.culturesPruned = false;
    this.fresh = false;
    writeState(this.state);                      // localStorage is the cache of the server copy (not re-uploaded)
    // …unless the server copy itself was a pre-v8 document `sanitize` just migrated (room levels · 방 9 · 10 · 시뮬레이션실 /
    // 휴식 공간) or one missing a 공용 시설 가구 it had to put back: upload it once
    if (out.migratedRoomLevels || out.migratedRooms || out.grantedCockpit) this.store?.markDirty();
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
  /** 서재 (`getBookBonus`, every shelved book of that skill). 2026-09-12: the 시뮬레이션 허브 term left with the furniture. */
  getSkillGainMul(skill: SkillId): number { return Rooms.getSkillGainMul(this, skill); }

  /** 2026-09-12: 빈 방에 `purpose` 를 증축하는 데 채워지지 않은 시설 레벨 요구 (발전기 Lv.1 게이트 — `Rules.purposeRequirementsFor`). */
  purposeRequirements(purpose: RoomPurpose): readonly FacilityRequirement[] { return Rooms.purposeRequirements(this, purpose); }

  /** 2026-09-12: 놓인 가구의 다음 강화를 막는 시설 레벨 요구 (`Rules.furnitureUpgradeRequirementsFor`). */
  furnitureUpgradeRequirements(uid: string): readonly FacilityRequirement[] { return Furn.furnitureUpgradeRequirements(this, uid); }
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

  /** 이 조각의 **다음 레벨** 비용. 최대 레벨이거나 배치된 조각이 아니면 null. (B-13, 2026-09-11) */
  furnitureUpgradeCost(uid: string): CraftIngredient[] | null { return Furn.furnitureUpgradeCost(this, uid); }

  /**
   * 지금 이 가구를 **제작**할 수 없는 한국어 사유, null = 만들 수 있다 (B-13). 재료 부족과 별개로, 이미 가지고
   * 있는 실용 가구(`isUtilityFurniture`, 배치 + 가구 창고 합산)는 여기서 잠긴다.
   */
  furnitureCraftBlock(defId: string): string | null { return Furn.furnitureCraftBlock(this, defId); }

  /* ── 연구실 분석기 (A-12, 2026-09-11) ──────────────────────────────────── */
  /** 해석 칸 (`ShipState.analyses`); prunes ids `ctx.loot` no longer knows on first access. */
  analyses(): AnalysisSlot[] { return Lab.analyses(this); }

  /** 해석 도감 (append-only). */
  sampleDex(): string[] { return Lab.sampleDex(this); }

  /** The 분석기 behind `uid`, or null when it is not one (or gone). */
  analyzerOf(uid: string): PlacedFurniture | null { return Lab.analyzerOf(this, uid); }

  analysisAt(uid: string, slot: number): AnalysisSlot | null { return Lab.analysisAt(this, uid, slot); }

  /** Drop every 해석 칸 of an analyzer that is being recovered (the samples go with it). */
  dropAnalysesOf(uid: string): void { return Lab.dropAnalysesOf(this, uid); }

  /** Finished 칸 of an analyzer (the `housing:analysisChanged` payload and the hub's 발광 창). */
  readyAnalyses(uid: string): number { return Lab.readyAnalyses(this, uid); }

  analysisChanged(uid: string, reason: string): void { return Lab.analysisChanged(this, uid, reason); }

  /** 표본 def with its `sample` data, or null when `defId` is not a 표본. */
  sampleDef(defId: string): ItemDef | null { return Lab.sampleDef(this, defId); }

  getAnalyses(uid: string): AnalysisSlotInfo[] { return Lab.getAnalyses(this, uid); }

  startAnalysis(uid: string, slot: number, sampleDefId: string): string | null { return Lab.startAnalysis(this, uid, slot, sampleDefId); }

  cancelAnalysis(uid: string, slot: number): string | null { return Lab.cancelAnalysis(this, uid, slot); }

  collectAnalysis(uid: string, slot: number, dest?: HarvestDestination): string | null { return Lab.collectAnalysis(this, uid, slot, dest); }

  collectAllAnalyses(uid: string): number { return Lab.collectAllAnalyses(this, uid); }

  getOwnedSamples(): { defId: string; qty: number }[] { return Lab.getOwnedSamples(this); }

  getSampleDex(): readonly string[] { return Lab.getSampleDex(this); }

  getSampleDexRatio(): number { return Lab.getSampleDexRatio(this); }

  openAnalyzer(uid: string): void { return Lab.openAnalyzer(this, uid); }

  /* ── 온실 배양조 (A-14, 2026-09-11) ────────────────────────────────────── */
  /** 배양 칸 (`ShipState.cultures`); prunes ids `ctx.loot` no longer knows on first access. */
  cultures(): CultureSlot[] { return Culture.cultures(this); }

  /** The 배양조 behind `uid`, or null when it is not one (or gone). */
  tankOf(uid: string): PlacedFurniture | null { return Culture.tankOf(this, uid); }

  cultureAt(uid: string, slot: number): CultureSlot | null { return Culture.cultureAt(this, uid, slot); }

  /** Drop every 배양 칸 of a tank that is being recovered (its 배지 · 세포주 go with it). */
  dropCulturesOf(uid: string): void { return Culture.dropCulturesOf(this, uid); }

  /** Finished 칸 of a tank (the `housing:cultureChanged` payload and the hub's glowing tubes). */
  readyCultures(uid: string): number { return Culture.readyCultures(this, uid); }

  cultureChanged(uid: string, reason: string): void { return Culture.cultureChanged(this, uid, reason); }

  /** 배지 def with its `medium` data, or null when `defId` is not a 배지. */
  mediumDef(defId: string): ItemDef | null { return Culture.mediumDef(this, defId); }

  /** 세포주 def with its `strain` data, or null when `defId` is not a 세포주. */
  strainDef(defId: string): ItemDef | null { return Culture.strainDef(this, defId); }

  getCultureSlots(uid: string): CultureSlotInfo[] { return Culture.getCultureSlots(this, uid); }

  fillMedium(uid: string, slot: number, mediumDefId: string): string | null { return Culture.fillMedium(this, uid, slot, mediumDefId); }

  clearMedium(uid: string, slot: number, discardStrain?: boolean): string | null { return Culture.clearMedium(this, uid, slot, discardStrain); }

  insertStrain(uid: string, slot: number, strainDefId: string): string | null { return Culture.insertStrain(this, uid, slot, strainDefId); }

  harvestCulture(uid: string, slot: number, dest?: HarvestDestination): string | null { return Culture.harvestCulture(this, uid, slot, dest); }

  harvestAllCultures(uid: string): number { return Culture.harvestAllCultures(this, uid); }

  getOwnedMediums(): { defId: string; qty: number }[] { return Culture.getOwnedMediums(this); }

  getOwnedStrains(): { defId: string; qty: number }[] { return Culture.getOwnedStrains(this); }

  openCultureTank(uid: string): void { return Culture.openCultureTank(this, uid); }

  /* ── 주방 식탁 (A-3c, 2026-09-11) ──────────────────────────────────────── */
  /** 공유 함선의 고정 식탁 앞인가 (「분대에 차리기」가 보이는 유일한 조건). */
  isSharedTable(): boolean { return Dining.isSharedTable(this); }

  /** 왜 지금 식탁을 쓸 수 없는가 (null = 괜찮다). `uid` null = 공유 함선의 고정 식탁. */
  diningBlock(uid: string | null): string | null { return Dining.diningBlock(this, uid); }

  /** 요리 def with its `meal` data, or null when `defId` is not a 요리. */
  mealDef(defId: string): ItemDef | null { return Dining.mealDef(this, defId); }

  /** 지금 갖고 있는 요리 (가방 + 함선 창고), 일반 → 특선 순서. */
  getOwnedMeals(): { defId: string; qty: number }[] { return Dining.getOwnedMeals(this); }

  /** 요리 하나를 먹는다 — `progression.useMeal` 에 **먼저 묻고** 성공할 때만 아이템을 뺀다. */
  eatMeal(uid: string | null, defId: string): string | null { return Dining.eatMeal(this, uid, defId); }

  /** 공유 함선 식탁에서 분대 전원에게 차린다 (요리 1개 소모 + `housing:mealServed`; 전파는 net 이 한다). */
  serveMealToSquad(uid: string | null, defId: string): string | null { return Dining.serveMealToSquad(this, uid, defId); }

  openDiningTable(uid: string | null): void { return Dining.openDiningTable(this, uid); }

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

  clearSoil(uid: string, tier: GrowTier, slot: number, discardCrop?: boolean): string | null { return Garden.clearSoil(this, uid, tier, slot, discardCrop); }

  plantSeedAt(uid: string, tier: GrowTier, slot: number, seedDefId: string): string | null { return Garden.plantSeedAt(this, uid, tier, slot, seedDefId); }

  harvestAt(uid: string, tier: GrowTier, slot: number, dest?: HarvestDestination): string | null { return Garden.harvestAt(this, uid, tier, slot, dest); }

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

  /* ── loadout presets (은퇴 — 2026-09-12 사용자 결정 「프리셋 기능 제거」: 전부 「슬롯 없음」으로 답한다, `parts/Presets.ts`) ── */
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
