import type {
  AnalysisLevelInfo, AnalysisResultInfo, GrowSocketTarget, SampleFamily,
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
import { placementBlockReason } from './Rules';                 // 2026-09-13 placement rules (access faces)
import { GrowStation } from './ui/GrowStation';
import { Analyzer } from './ui/Analyzer';
import { CultureTank } from './ui/CultureTank';
import { DiningTable } from './ui/DiningTable';
import { BookshelfMenu } from './ui/BookshelfMenu';
import { createShipView } from './ui/ShipView';
import type { HousingPanel } from './ui/Panel';
// 2026-09-16: the stash upgrade modal — the inventory Tab and the workbench window call it through `HousingRef.openStorageUpgrade()`
import { StorageUpgrade, openBenchUpgrade, openStorageUpgrade } from './ui/StorageUpgrade';
import './housing.css';

/** The folder vocabulary (constants · types · scratch) lives in `model.ts` — re-exported for the existing import paths. */
export * from './model';
import * as Rooms from './parts/Rooms';
import * as Furn from './parts/Furniture';
import * as Garden from './parts/Garden';
import * as Lab from './parts/Lab';
import * as Culture from './parts/Culture';
import * as Dining from './parts/Dining';
import * as Sockets from './parts/Sockets';                  // cooking material tiers (2026-09-13)
import * as Lib from './parts/Library';
import * as Preset from './parts/Presets';
import * as Gym from './parts/Gym';                          // gym (A-3a)
import type { GymState } from './parts/Gym';
import { GymScreen } from './ui/gym/GymScreen';
import * as Cooking from './parts/Cooking';                  // cooking minigames (2026-09-13)
import * as Mining from './parts/Mining';                    // crypto mining (2026-09-13)
import type { ComputeClusterInfo, CryptoCoinInfo, CryptoQuote, CryptoTradeSide } from '@/shared';
import type { CookState } from './parts/Cooking';
import { CookScreen } from './ui/cook/CookScreen';
import { CookStation } from './ui/cook/CookStation';
import type { CookAutoInfo, CookGame, CookSessionInfo, CraftRecipe } from '@/shared';
import type { MiningComputerTab } from '@/shared';
import type { DiningPlate, MealItemDef, TablePlateInfo } from '@/shared';   // 2026-09-16 dining table plates
import type { PlateAskState } from './ui/cook/PlateAsk';
import { closePlateAsk } from './ui/cook/PlateAsk';
// the mining screen (2026-09-13 → merged 2026-09-14: `채굴` · `클러스터 현황` · `지갑` · `거래소` are one window)
import { MiningScreen, openComputeClusterScreen, openMiningComputerScreen } from './ui/mining/MiningScreen';
import * as VideoGame from './parts/VideoGame';              // video games (H2, 2026-09-13)
import * as Music from './parts/Music';                      // music playback (2026-09-14) — pure state, no sound
import { TvMenu } from './ui/tv/TvMenu';

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
  /** The analysis screen (`연구실`, 2026-09-11). Not called `analyzer` so that the name does not clash with `openAnalyzer`. */
  analyzerPanel: Analyzer | null = null;
  /** The culture screen (culture tank A-14, 2026-09-11) — the method is `openCultureTank`, so the names do not clash. */
  cultureTank: CultureTank | null = null;
  /** The dining screen (`주방` A-3c, 2026-09-11) — the method is `openDiningTable`. */
  diningTable: DiningTable | null = null;
  bookshelfMenu: BookshelfMenu | null = null;
  /**
   * The stash upgrade modal (2026-09-16) — it is not a furniture screen and opens on its own as a direct child of
   * `ctx.uiRoot`, so it lives here and not in the panel list (`panels()`). Built on first open, taken down by `dispose()`.
   */
  storageUpgrade: StorageUpgrade | null = null;
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
   * Greenhouse rework (2026-09-11): materials owed for the retired furniture `ShipState.sanitize` swept out of the
   * save. housing/ is registered **before** inventory/, so the 함선 창고 does not exist yet at load time — `update()`
   * pays this into it on the first frame where `ctx.inventory` is around (`flushRetiredRefund`).
   */
  private pendingRefund: CraftIngredient[] = [];

  constructor() {
    const loaded = loadState();
    this.state = loaded.state;
    this.fresh = loaded.fresh;
    this.pendingRefund = loaded.refund;
    this.migrated = loaded.migrated;
    this.granted = loaded.granted;
    this.evictNotice = loaded.evicted;
    this.generatorNotice = loaded.removedByGenerator;
    this.nextUid = maxUidIndex(this.state.furniture);
  }

  /**
   * 2026-09-13 (placement rules, user's decision): how many pieces `sanitize` moved into furniture storage because
   * their old placement breaks the access-face rule. Announced once on the first `update` (at construction time there
   * is no HUD to hear it). The move is saved at once — the server copy then gives the same answer on the next load.
   */
  private evictNotice = 0;
  /**
   * 2026-09-13 (power allocation dropped, user's decision): how many facilities `sanitize` removed because the
   * generator level was too low (`SanitizeOutcome.removedByGenerator`). Announced once on the first `update` like
   * `evictNotice` — the refund itself is announced separately, by `pendingRefund`.
   */
  private generatorNotice = 0;

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.housing = this;
    this.store = new ShipStore(() => this.state, () => this.profileRef());
    if (this.fresh || this.migrated || this.granted || this.evictNotice > 0) this.store.markDirty();
    // v7 · v8: the moved levels / removed rooms are a local edit the server copy has never seen — a welcome inside the debounce must not undo it
    if (this.migrated) this.editPending = true;
    this.growStation = new GrowStation(ctx, this);
    this.analyzerPanel = new Analyzer(ctx, this);
    this.cultureTank = new CultureTank(ctx, this);
    this.diningTable = new DiningTable(ctx, this);
    this.bookshelfMenu = new BookshelfMenu(ctx, this);
    this.gymScreen = new GymScreen(ctx, this);                 // gym (A-3a)
    this.unsubs.push(...Gym.bindGym(this));
    this.cookStation = new CookStation(ctx, this);             // cooking minigames (2026-09-13)
    this.cookScreen = new CookScreen(ctx, this);
    this.unsubs.push(...Cooking.bindCooking(this));
    this.unsubs.push(...Lib.bindLibrary(this));                // library series (H1, 2026-09-13) — folded-effect cache · housing:libraryChanged
    this.unsubs.push(...Mining.bindMining(this));              // crypto mining (2026-09-13)
    this.miningScreen = new MiningScreen(ctx, this);            // the mining screen (merged 2026-09-14 — four tabs, one window)
    this.tvMenu = new TvMenu(ctx, this); this.unsubs.push(...VideoGame.bindVideoGame(this));   // video games (H2, 2026-09-13)
    this.unsubs.push(...Music.bindMusic(this));                // music playback (2026-09-14)
    this.unsubs.push(...Dining.bindDining(this));              // dining table plates (2026-09-16): cleared when a raid starts · squadmate plates
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('game:abort', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('hub:left', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('game:phaseChanged', ({ phase }) => { if (phase !== 'hub') { this.closeMenus(); this.exitHousingMode(); } }),
      b.on('net:profileLoaded', () => this.onProfileLoaded()),
    );
    // This fires inside init, so **a system registered after this one never hears it** — those read
    // `ctx.housing.state` in their own init, and hub rebuilds on the re-emit after `net:profileLoaded` (`onProfileLoaded`).
    b.emit('housing:loaded', { state: this.state });
    this.lastStash = this.getStashSize();
    b.emit('housing:stashSizeChanged', { ...this.lastStash });
  }

  update(_dt: number, ctx: GameContext): void {
    if (this.pendingRefund.length) this.flushRetiredRefund();
    Mining.tickMining(this);                                   // crypto mining: completed cycles into the wallet (1 Hz, 2026-09-13)
    Lib.tickLibrary(this);                                     // library series (H1): a sum counted without loot is counted again on the first frame loot exists
    Music.tickMusic(this);                                     // music playback (2026-09-14): only the clock says whether the track ended (one comparison while off)
    if (this.evictNotice > 0) {
      this.notify(`배치 규칙에 맞지 않는 가구 ${this.evictNotice}개를 가구 창고로 옮겼습니다`, 'warning');
      this.evictNotice = 0;
    }
    if (this.generatorNotice > 0) {
      this.notify(`발전기 레벨이 모자란 시설 ${this.generatorNotice}곳을 제거했습니다 — 증축 재료는 함선 창고, 가구는 가구 창고로 돌아왔습니다`, 'warning');
      this.generatorNotice = 0;
    }
    if (this.housingMode && (ctx.phase !== 'hub' || ctx.hub?.ship !== 'personal')) this.exitHousingMode();
  }

  dispose(): void {
    this.closeMenus();
    closePlateAsk(this);                                       // 2026-09-16: the open 「식탁의 요리를 바꿉니다」 warning
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.growStation?.dispose(); this.analyzerPanel?.dispose();
    this.cultureTank?.dispose(); this.diningTable?.dispose(); this.bookshelfMenu?.dispose();
    this.growStation = null; this.analyzerPanel = null;
    this.cultureTank = null; this.diningTable = null; this.bookshelfMenu = null;
    this.gymScreen?.dispose(); this.gymScreen = null;          // gym (A-3a)
    this.cookScreen?.dispose(); this.cookScreen = null;        // cooking minigames (2026-09-13)
    this.cookStation?.dispose(); this.cookStation = null;
    this.miningScreen?.dispose(); this.miningScreen = null;    // the mining screen (merged 2026-09-14)
    this.storageUpgrade?.dispose(); this.storageUpgrade = null; // the stash upgrade modal (2026-09-16)
    Music.stopMusic(this);                                     // music playback (2026-09-14): so the state does not outlive the window
    this.store?.dispose(); this.store = null;
  }

  /**
   * Greenhouse rework (2026-09-11): pay the retired-furniture refund into the **함선 창고**. Runs on the first frame
   * the inventory exists (housing/ loads its state before inventory/ is even registered). The stash may be full —
   * then only what fits goes in and the rest is dropped with a Korean warning **and** a console line: nothing
   * disappears silently.
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
      // 2026-09-12: the refund for vanished room facility levels (작업실 · 사격장) comes in the same sack, not just the retired grow rack's
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
    const plateBefore = this.getPlate();                          // 2026-09-16: announced when the server copy's plate differs (below)
    this.state = sanitize(doc, out);
    if (out.refund.length) mergeCost(this.pendingRefund, out.refund);   // the server copy can hold retired furniture too
    this.nextUid = maxUidIndex(this.state.furniture);
    this.booksPruned = false;
    this.growsPruned = false;
    this.analysesPruned = false;
    this.culturesPruned = false;
    this.fresh = false;
    writeState(this.state);                      // localStorage is the cache of the server copy (not re-uploaded)
    // …unless the server copy itself was a pre-v8 document `sanitize` just migrated (room levels · 방 9 · 10 · 시뮬레이션실 /
    // 휴식 공간) or one missing a shared facility piece it had to put back: upload it once
    // (2026-09-13: or a pre-v10 document that just got the cockpit decor furniture)
    if (out.migratedRoomLevels || out.migratedRooms || out.grantedCockpit || out.migratedCockpit) this.store?.markDirty();
    // 2026-09-13 (power allocation dropped): the server copy had facilities under the generator level too — announced here (refund via `pendingRefund`, save via `migratedRooms`)
    if (out.removedByGenerator) this.generatorNotice += out.removedByGenerator;
    if (out.migratedLibrary || out.aliasedLibrary) this.store?.markDirty();   // library series (H1): upload the old-id substitution · the duplicate / games-console refund once
    // 2026-09-13 (placement rules): the server copy's old placements moved into furniture storage under the same rule — announce it and upload once
    if (out.evictedByAccess) { this.evictNotice += out.evictedByAccess; this.store?.markDirty(); }
    const b = this.ctx.bus;
    b.emit('housing:loaded', { state: this.state });
    b.emit('housing:changed', { reason: 'profile' });
    this.emitStashSizeIfChanged();
    Dining.afterStateReplaced(this, plateBefore);                // dining table plates (net to the squadmates · hub to the table mesh)
  }

  /* ── helpers ───────────────────────────────────────────────────────────── */
  changed(reason: string): void {
    this.editPending = true;
    this.store?.markDirty();
    this.ctx.bus.emit('housing:changed', { reason });
  }

  /**
   * 2026-09-13: queues the save only — it does not emit `housing:changed`. Called from a place that fixes the state
   * while handling `housing:changed` (`parts/Library`'s old-id substitution) — emitting again here would loop forever.
   */
  saveSoon(): void {
    this.editPending = true;
    this.store?.markDirty();
  }

  /** Units of `defId` in bag + stash (0 while inventory has no `countDefAll`). */
  countDef = (defId: string): number => {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.countDefAll !== 'function') return 0;
    return inv.countDefAll(defId);
  };

  /** Korean item name for cost lines. */
  nameOf = (defId: string): string => this.ctx.loot?.getItemDef(defId)?.name ?? defId;

  /** Item def for a cost chip (`renderItemCost` lookup); undefined renders the neutral placeholder chip. */
  defOf = (defId: string): ItemDef | undefined => this.ctx.loot?.getItemDef(defId);

  /** Epoch ms from the relay when connected, else the local clock — growing runs on real world time. */
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
   * Korean reason `setRoomPurpose` would refuse (null = allowed). Used by the room menu for button hints. `empty`
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
   * **함선 창고**. All-or-nothing: when the stash cannot take the refund nothing is touched and the Korean reason is
   * returned (null = removed).
   */
  removeRoomFacility(index: number): string | null { return Rooms.removeRoomFacility(this, index); }

  /** Korean reason the stash cannot take `cost` (free-cell estimate, deliberately conservative); null when it can. */
  stashSpaceBlock(cost: readonly CraftIngredient[]): string | null { return Rooms.stashSpaceBlock(this, cost); }

  /** Drop `cost` into the stash, splitting at `stackMax`. Returns how many units could **not** be placed. */
  refundToStash(cost: readonly CraftIngredient[]): number { return Rooms.refundToStash(this, cost); }

  getBenchLevel(kind: WorkbenchKind): number { return Rooms.getBenchLevel(this, kind); }

  getCraftCostMul(): number { return Rooms.getCraftCostMul(this); }
  /** 서재 (`getBookBonus`, every shelved book of that skill). 2026-09-12: the 시뮬레이션 허브 term left with the furniture. */
  getSkillGainMul(skill: SkillId): number { return Rooms.getSkillGainMul(this, skill); }

  /** 2026-09-12: facility level requirements still unmet for building `purpose` into a 빈 방 (the generator Lv.1 gate — `Rules.purposeRequirementsFor`). */
  purposeRequirements(purpose: RoomPurpose): readonly FacilityRequirement[] { return Rooms.purposeRequirements(this, purpose); }

  /** 2026-09-12: facility level requirements that block a placed piece's next upgrade (`Rules.furnitureUpgradeRequirementsFor`). */
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
   * 2026-09-13 (placement rules — the `HousingRef.placementBlock` contract): the Korean reason it cannot be placed,
   * null = `canPlace` is true. Order and wording live in one place, `Rules.placementBlockOf` (spot → purpose → grid →
   * fixed prop → stacking → overlap → my own access face → someone else's access face).
   */
  placementBlock(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): string | null {
    const def = this.getFurnitureDef(defId);
    return def ? placementBlockReason(this.state, room, def, x, y, yaw, ignoreUid) : '알 수 없는 가구입니다';
  }

  /**
   * The spot auto placement picks (2026-09-10): from the screen's top left, rows first, and the piece faces the
   * bottom of the screen (yaw 1). The reasoning and the coordinate derivation are in `Rules.autoPlaceSpot`.
   * `null` = this room has no free spot.
   */
  findFreeSpot(room: number, defId: string): { x: number; y: number; yaw: 0 | 1 | 2 | 3 } | null { return Furn.findFreeSpot(this, room, defId); }

  place(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): PlacedFurniture | null { return Furn.place(this, room, defId, x, y, yaw); }

  move(uid: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): boolean { return Furn.move(this, uid, x, y, yaw); }

  /**
   * Korean reason `recover(uid)` would refuse (null = go ahead). A stack blocks (the top layer leaves first), and a
   * 책장 blocks while its books cannot go to the stash (`책을 먼저 빼세요`, a cell-count estimate — `recover` itself
   * does the real placement and rolls back).
   */
  recoverBlock(uid: string): string | null { return Furn.recoverBlock(this, uid); }

  recover(uid: string): boolean { return Furn.recover(this, uid); }

  canCraftFurniture(defId: string): { ok: boolean; missing: CraftIngredient[] } { return Furn.canCraftFurniture(this, defId); }

  craftFurniture(defId: string): boolean { return Furn.craftFurniture(this, defId); }

  /** Korean reason a placed piece cannot be upgraded (null = can). */
  furnitureUpgradeBlock(uid: string): string | null { return Furn.furnitureUpgradeBlock(this, uid); }

  upgradeFurniture(uid: string): boolean { return Furn.upgradeFurniture(this, uid); }

  /** Cost of this piece's **next level**. null at max level, or when it is not a placed piece. (B-13, 2026-09-11) */
  furnitureUpgradeCost(uid: string): CraftIngredient[] | null { return Furn.furnitureUpgradeCost(this, uid); }

  /**
   * The Korean reason this furniture cannot be **crafted** right now, null = it can (B-13). Apart from missing
   * materials, a utility piece the player already owns (`isUtilityFurniture`, placed + furniture storage together)
   * is locked here.
   */
  furnitureCraftBlock(defId: string): string | null { return Furn.furnitureCraftBlock(this, defId); }

  /* ── lab analyzer (A-12, 2026-09-11) ───────────────────────────────────── */
  /** The analysis slots (`ShipState.analyses`); prunes ids `ctx.loot` no longer knows on first access. */
  analyses(): AnalysisSlot[] { return Lab.analyses(this); }

  /** The analysis catalogue (append-only). */
  sampleDex(): string[] { return Lab.sampleDex(this); }

  /** The analyzer behind `uid`, or null when it is not one (or gone). */
  analyzerOf(uid: string): PlacedFurniture | null { return Lab.analyzerOf(this, uid); }

  analysisAt(uid: string, slot: number): AnalysisSlot | null { return Lab.analysisAt(this, uid, slot); }

  /** Drop every analysis slot of an analyzer that is being recovered (the samples go with it). */
  dropAnalysesOf(uid: string): void { return Lab.dropAnalysesOf(this, uid); }

  /** Finished slots of an analyzer (the `housing:analysisChanged` payload and the hub's glowing window). */
  readyAnalyses(uid: string): number { return Lab.readyAnalyses(this, uid); }

  analysisChanged(uid: string, reason: string): void { return Lab.analysisChanged(this, uid, reason); }

  /** Sample def with its `sample` data, or null when `defId` is not a sample. */
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

  /* ══ cooking material tiers (2026-09-13) ══ — analysis level · result table (`parts/Lab`) · soil / medium sockets (`parts/Sockets`) · culture scaffolds (`parts/Culture`) */
  getAnalysisLevel(family: SampleFamily): AnalysisLevelInfo { return Lab.getAnalysisLevel(this, family); }
  getAnalysisResults(family: SampleFamily): AnalysisResultInfo[] { return Lab.getAnalysisResults(this, family); }
  getAnalysisFound(): readonly string[] { return Lab.getAnalysisFound(this); }
  /* 2026-09-16 (sample rework): the per-sample level · catalogue cells per rarity — the analysis screen reads them as `Lv.n · −x %`. */
  getSampleAnalysis(defId: string): import('@/shared').SampleAnalysisInfo | null { return Lab.getSampleAnalysis(this, defId); }
  getAnalysisDexByRarity(): Readonly<Record<import('@/shared').Rarity, number>> { return Lab.getAnalysisDexByRarity(this); }
  insertGrowSocket(uid: string, tier: GrowTier, slot: number, socketDefId: string, replaceIndex?: number): string | null { return Garden.insertGrowSocket(this, uid, tier, slot, socketDefId, replaceIndex); }
  insertCultureSocket(uid: string, slot: number, socketDefId: string, replaceIndex?: number): string | null { return Culture.insertCultureSocket(this, uid, slot, socketDefId, replaceIndex); }
  insertScaffold(uid: string, slot: number, scaffoldDefId: string): string | null { return Culture.insertScaffold(this, uid, slot, scaffoldDefId); }
  takeScaffold(uid: string, slot: number, dest?: HarvestDestination): string | null { return Culture.takeScaffold(this, uid, slot, dest); }
  getOwnedSockets(target?: GrowSocketTarget): { defId: string; qty: number }[] { return Sockets.getOwnedSockets(this, target); }
  /* ══ end of cooking material tiers ══ */

  /* ── greenhouse culture tank (A-14, 2026-09-11) ────────────────────────── */
  /** The culture slots (`ShipState.cultures`); prunes ids `ctx.loot` no longer knows on first access. */
  cultures(): CultureSlot[] { return Culture.cultures(this); }

  /** The culture tank behind `uid`, or null when it is not one (or gone). */
  tankOf(uid: string): PlacedFurniture | null { return Culture.tankOf(this, uid); }

  cultureAt(uid: string, slot: number): CultureSlot | null { return Culture.cultureAt(this, uid, slot); }

  /** Drop every culture slot of a tank that is being recovered (its medium · strain go with it). */
  dropCulturesOf(uid: string): void { return Culture.dropCulturesOf(this, uid); }

  /** Finished slots of a tank (the `housing:cultureChanged` payload and the hub's glowing tubes). */
  readyCultures(uid: string): number { return Culture.readyCultures(this, uid); }

  cultureChanged(uid: string, reason: string): void { return Culture.cultureChanged(this, uid, reason); }

  /** Medium def with its `medium` data, or null when `defId` is not a medium. */
  mediumDef(defId: string): ItemDef | null { return Culture.mediumDef(this, defId); }

  /** Strain def with its `strain` data, or null when `defId` is not a strain. */
  strainDef(defId: string): ItemDef | null { return Culture.strainDef(this, defId); }

  getCultureSlots(uid: string): CultureSlotInfo[] { return Culture.getCultureSlots(this, uid); }

  fillMedium(uid: string, slot: number, mediumDefId: string): string | null { return Culture.fillMedium(this, uid, slot, mediumDefId); }

  clearMedium(uid: string, slot: number, discardStrain?: boolean): string | null { return Culture.clearMedium(this, uid, slot, discardStrain); }

  insertStrain(uid: string, slot: number, strainDefId: string): string | null { return Culture.insertStrain(this, uid, slot, strainDefId); }

  /** 2026-09-17: start the culture in a waiting slot (after the screen's 1 s hold confirm) · take the strain / an unused medium back before the start. */
  startCulture(uid: string, slot: number): string | null { return Culture.startCulture(this, uid, slot); }
  takeStrain(uid: string, slot: number, dest?: HarvestDestination): string | null { return Culture.takeStrain(this, uid, slot, dest); }
  takeMedium(uid: string, slot: number, dest?: HarvestDestination): string | null { return Culture.takeMedium(this, uid, slot, dest); }

  harvestCulture(uid: string, slot: number, dest?: HarvestDestination): string | null { return Culture.harvestCulture(this, uid, slot, dest); }

  harvestAllCultures(uid: string): number { return Culture.harvestAllCultures(this, uid); }

  getOwnedMediums(): { defId: string; qty: number }[] { return Culture.getOwnedMediums(this); }

  getOwnedStrains(): { defId: string; qty: number }[] { return Culture.getOwnedStrains(this); }

  openCultureTank(uid: string): void { return Culture.openCultureTank(this, uid); }

  /* ── kitchen table · plate (A-3c 2026-09-11 → 2026-09-16 plate model) ──── */
  /**
   * Squadmate plates on the shared ship (PeerId → name · plate) — net fills this through `net:squadPlate` and
   * `parts/Dining.bindDining` clears it. My own plate is not here; it is `state.plate`.
   */
  readonly squadPlates = new Map<string, Dining.SquadPlate>();
  /** The open 「식탁의 요리를 바꿉니다」 warning (`ui/cook/PlateAsk`), null when there is none. */
  plateAsk: PlateAskState | null = null;

  /** Standing at the shared ship's fixed dining table? */
  isSharedTable(): boolean { return Dining.isSharedTable(this); }

  /** Why the dining table cannot be used right now (null = it can). `uid` null = the shared ship's fixed table. */
  diningBlock(uid: string | null): string | null { return Dining.diningBlock(this, uid); }

  /** The meal def (`shared/meals` — a meal is not an item), null when it is not a meal. */
  mealDef(defId: string): MealItemDef | null { return Dining.mealDef(this, defId); }

  /** Is a dining table placed on my ship (the cook bench gate)? */
  hasDiningTable(): boolean { return Dining.hasDiningTable(this); }

  /** The plate on my ship's dining table, null when there is none. */
  getPlate(): DiningPlate | null { return Dining.getPlate(this); }

  /** The plates on that table (`uid` = my own table piece → only mine, null = the shared ship's table → the squadmates' too). */
  getTablePlates(uid: string | null): TablePlateInfo[] { return Dining.getTablePlates(this, uid); }

  /** The Korean reason that plate cannot be eaten right now (「이미 먹었습니다」 among them), null = it can. */
  plateEatBlock(uid: string | null, ownerId?: string | null): string | null { return Dining.plateEatBlock(this, uid, ownerId); }

  /** Eat the plate — the plate is not consumed; `progression.useMeal` loads the pending meal. Korean reason / null. */
  eatPlate(uid: string | null, ownerId?: string | null): string | null { return Dining.eatPlate(this, uid, ownerId); }

  /** Dev · smoke: put a plate on my table without cooking. */
  devSetPlate(mealDefId: string, quality = 0): string | null { return Dining.devSetPlate(this, mealDefId, quality); }

  /** Dev · smoke: clear my plate. */
  clearPlate(): boolean { return Dining.clearPlate(this, 'dev'); }

  openDiningTable(uid: string | null): void { return Dining.openDiningTable(this, uid); }

  /* ── greenhouse grow station (2026-09-11) ──────────────────────────────── */
  /** The grow station slots (`ShipState.grows`); prunes ids `ctx.loot` no longer knows on first access. */
  grows(): GrowSlot[] { return Garden.grows(this); }

  /** The grow station behind `uid`, or null when it is not one (or gone). */
  stationOf(uid: string): PlacedFurniture | null { return Garden.stationOf(this, uid); }

  growSlotAt(uid: string, tier: GrowTier, slot: number): GrowSlot | null { return Garden.growSlotAt(this, uid, tier, slot); }

  /** Drop every slot of a station that is being recovered (its soil and crops go with it). */
  dropGrowsOf(uid: string): void { return Garden.dropGrowsOf(this, uid); }

  /** Ripe slots of a station (for the `housing:growChanged` payload and the hub's station visuals). */
  readyCount(uid: string): number { return Garden.readyCount(this, uid); }

  growChanged(uid: string, reason: string): void { return Garden.growChanged(this, uid, reason); }

  /** Seed def with its `seed` data, or null when `defId` is not a seed. */
  seedDef(defId: string): ItemDef | null { return Garden.seedDef(this, defId); }

  /** Soil def with its `soil` data, or null when `defId` is not a soil. */
  soilDef(defId: string): ItemDef | null { return Garden.soilDef(this, defId); }

  /** The `원예` gardening skill, 0..SKILL_LEVEL_MAX. */
  gardening(): number { return Garden.gardening(this); }

  /** Harvest size after the gardening `gatherYieldMul` (at least one unit). */
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

  /* ── the retired grow rack (Phase 8 API) ────────────────────────────────────
   * The contract is add-only, so these stay, but the piece (`furn_grow_rack`) is retired and `sanitize` sweeps it off
   * the ship. Every one of them answers "there is no grow rack" — none silently pretends to have succeeded. */
  /** @deprecated 2026-09-11 (greenhouse rework) — `getGrowSlots`. Always an empty array. */
  getPlots(uid: string): GrowPlotInfo[] { return Garden.getPlots(this, uid); }
  /** @deprecated 2026-09-11 (greenhouse rework) — `plantSeedAt`. */
  plantSeed(uid: string, slot: number, seedDefId: string): string | null { return Garden.plantSeed(this, uid, slot, seedDefId); }
  /** @deprecated 2026-09-11 (greenhouse rework) — `harvestAt`. */
  harvestPlot(uid: string, slot: number): string | null { return Garden.harvestPlot(this, uid, slot); }
  /** @deprecated 2026-09-11 (greenhouse rework) — `harvestAllStation`. Always 0. */
  harvestAll(uid: string): number { return Garden.harvestAll(this, uid); }
  /** @deprecated 2026-09-11 (greenhouse rework) — `openGrowStation`. Does nothing. */
  openGrowMenu(uid: string): void { return Garden.openGrowMenu(this, uid); }

  /* ── crew call sign (Phase 8) ──────────────────────────────────────────── */
  /** hub/ calls this the first time the player names the crew; afterwards the terminal shows a read-only line. */
  lockCrewName(): void {
    if (this.state.nameLocked === true) return;
    this.state.nameLocked = true;
    this.changed('name');
  }

  /* ── embedded ship view (the 함선 tab of the Tab screen) ───────────────── */
  createShipView(host: HTMLElement): EmbeddedView { return createShipView(this.ctx, this, host); }

  /* ── library bookshelves (Phase 9) ─────────────────────────────────────── */
  /**
   * The shelved books. The save only shape-checks def ids (`book_*`); the first time `ctx.loot` is around every id
   * that is no longer a real book is dropped here (a removed book def never breaks the shelf).
   */
  books(): PlacedBook[] { return Lib.books(this); }

  bookDex(): string[] { return Lib.bookDex(this); }

  /** The bookshelf behind `uid`, or null when it is not a bookshelf (or gone). */
  shelfOf(uid: string): PlacedFurniture | null { return Lib.shelfOf(this, uid); }

  booksOf(uid: string): PlacedBook[] { return Lib.booksOf(this, uid); }

  bookAt(uid: string, slot: number): PlacedBook | null { return Lib.bookAt(this, uid, slot); }

  /** Drop every book of a shelf (used after they were moved to the stash, or by a recovered shelf). */
  dropBooksOf(uid: string): void { return Lib.dropBooksOf(this, uid); }

  booksChanged(uid: string, reason: string): void { return Lib.booksChanged(this, uid, reason); }

  /** Book def with its `book` data, or null when `defId` is not a book. */
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

  /* ══ library media (A-3e) ══ — `디스크 전시대` · `레코드랙` · auxiliary furniture · switching a TV / record player
     on (`parts/Library.ts`, 2026-09-12). A `책장` still rides the old path above (`books` · `placeBook` ·
     `housing:booksChanged`), and the shared media API hands a bookshelf over to it. */
  /** Disc · record slots (`ShipState.media`); prunes ids `ctx.loot` no longer knows on first access. */
  media(): PlacedBook[] { return Lib.media(this); }
  /** The disc · record catalogue (append-only). */
  mediaDex(): string[] { return Lib.mediaDex(this); }
  /** uids of the TVs · record players left on (`ShipState.toggled`). */
  toggledUids(): string[] { return Lib.toggledUids(this); }
  /** Everything shelved in holder `uid` (a bookshelf → `booksOf`). */
  shelfItemsOf(uid: string): PlacedBook[] { return Lib.shelfItemsOf(this, uid); }
  /** `…를 먼저 빼세요` while a holder's contents cannot go to the stash (free-cell estimate), else null. */
  shelfBlock(uid: string): string | null { return Lib.shelfBlock(this, uid); }
  /** Move a holder's contents into the stash, all or nothing (a bookshelf → `stashBooksOf`). */
  stashShelfItemsOf(uid: string): boolean { return Lib.stashShelfItemsOf(this, uid); }
  /** Forget the on-state of a recovered piece. */
  dropToggled(uid: string): void { return Lib.dropToggled(this, uid); }
  getShelfMedium(uid: string): import('@/shared').ShelfMedium | null { return Lib.shelfMediumOf(this, uid); }
  getShelfSlots(uid: string): BookSlotInfo[] { return Lib.getShelfSlots(this, uid); }
  placeShelfItem(uid: string, slot: number, defId: string): string | null { return Lib.placeShelfItem(this, uid, slot, defId); }
  takeShelfItem(uid: string, slot: number): string | null { return Lib.takeShelfItem(this, uid, slot); }
  getOwnedShelfItems(medium: import('@/shared').ShelfMedium): { defId: string; qty: number }[] { return Lib.getOwnedShelfItems(this, medium); }
  getShelfDex(medium: import('@/shared').ShelfMedium): readonly string[] { return Lib.getShelfDex(this, medium); }
  getShelfBonus(skill: SkillId): import('@/shared').ShelfBonusInfo { return Lib.getShelfBonus(this, skill); }
  hasShelfAux(medium: import('@/shared').ShelfMedium): boolean { return Lib.hasShelfAux(this, medium); }
  openShelf(uid: string): void { return Lib.openShelf(this, uid); }
  isFurnitureOn(uid: string): boolean { return Lib.isFurnitureOn(this, uid); }
  toggleFurniture(uid: string): boolean | null { return Lib.toggleFurniture(this, uid); }
  /* ══ end of library media (A-3e) ══ */

  /* ══ music playback (2026-09-14) ══ — switching a `축음기` · `주크박스` · `턴테이블` on makes the records shelved in
     the record rack the playlist (`parts/Music.ts`). **No sound comes out** — it is state only, and
     `ui/hud/MusicPlayer` draws off `housing:musicChanged` alone. The queries and controls are the 2026-09-14
     additions to the `HousingRef` contract (all optional), and the screen watches only the events. */
  /** The current playback state — `MUSIC_PLAYER_OFF` while off. `housing:musicChanged` on every change. */
  musicState: import('@/shared').MusicPlayerState = Music.initialMusicState();
  /** The current playback state (so a screen that attaches late need not wait for the first event). */
  getMusicState(): import('@/shared').MusicPlayerState { return Music.musicState(this); }
  /** Next / previous track (a person pressing it moves on even under `'repeat'`). */
  musicNext(): boolean { return Music.musicNext(this); }
  musicPrev(): boolean { return Music.musicPrev(this); }
  /** Switch the playback mode (false when it is the same value). */
  setMusicMode(mode: import('@/shared').MusicMode): boolean { return Music.setMusicMode(this, mode); }
  /** Stop playback — the furniture's `toggled` goes down with it (the same as switching it off with E). */
  musicStop(): boolean { return Music.musicStop(this); }
  /* ══ end of music playback ══ */

  /* ══ gym (A-3a) ══ — exercise machine minigame sessions (`parts/Gym.ts` · judgement `parts/GymGames.ts` · screens `ui/gym/`, 2026-09-12). */
  /** The workout screen (the start briefing · the game · the result). */
  gymScreen: GymScreen | null = null;
  /** The session in progress — `gymSession` is its `info`. */
  gymState: GymState | null = null;
  get gymSession(): import('@/shared').GymSessionInfo | null { return Gym.gymSession(this); }
  gymBlock(uid: string): string | null { return Gym.gymBlock(this, uid); }
  startGymSession(uid: string): string | null { return Gym.startGymSession(this, uid); }
  cancelGymSession(): void { return Gym.cancelGymSession(this); }
  /** Smoke hook — screen state · the judge object · the result · skipping. */
  get gymDebug(): Gym.GymDebug { return Gym.gymDebug(this); }
  /* ══ end of gym (A-3a) ══ */

  /* ══ cooking minigames (2026-09-13) ══ — the cook bench screen · cook sessions (`parts/Cooking.ts` · judgement `parts/CookGames.ts` · screens `ui/cook/`). */
  /** The cook bench screen (recipe list · ingredients · steps · stash / bag). */
  cookStation: CookStation | null = null;
  /** The cook overlay (the pick card · the minigame · the result). */
  cookScreen: CookScreen | null = null;
  /** The cook in progress — `cookSession` is its `info`. */
  cookState: CookState | null = null;
  openCookStation(uid: string): void { return Cooking.openCookStation(this, uid); }
  get cookSession(): CookSessionInfo | null { return Cooking.cookSession(this); }
  cookBlock(uid: string, recipeId: string): string | null { return Cooking.cookBlock(this, uid, recipeId); }
  startCook(uid: string, recipeId: string): string | null { return Cooking.startCook(this, uid, recipeId); }
  cancelCook(): void { return Cooking.cancelCook(this); }
  getCookAuto(game: CookGame): CookAutoInfo | null { return Cooking.getCookAuto(this, game); }
  /** Cook bench recipes (`bench cook` with cook steps). */
  cookRecipes(): CraftRecipe[] { return Cooking.cookRecipes(this); }
  /** Smoke hook — screen state · the judge object · the result · the pick · skipping. */
  get cookDebug(): Cooking.CookDebug { return Cooking.cookDebug(this); }
  /* ══ end of cooking minigames ══ */

  /* ══ the mining screen ══ — `ui/mining/` (2026-09-14, user's decision: the compute cluster screen and the main
     computer were merged into **one window** — top tabs `MINING_TABS` = `채굴` · `클러스터 현황` · `지갑` · `거래소`).
     The rules, the wallet and trading live in `parts/Mining`. */
  /** The merged mining window (`ui/mining/MiningScreen`). */
  miningScreen: MiningScreen | null = null;
  /** @deprecated 2026-09-14 merge — points at the same window (old callers · `parts/Presets.panels()`). */
  get clusterScreen(): MiningScreen | null { return this.miningScreen; }
  /** @deprecated 2026-09-14 merge — points at the same window. */
  get miningComputer(): MiningScreen | null { return this.miningScreen; }
  /** E on a compute cluster — opens the merged window on the `채굴` tab (user's decision: each piece defaults to its own tab). */
  openComputeCluster(uid: string): void { return openComputeClusterScreen(this, uid); }
  /** E on the main computer — opens the merged window on the `클러스터 현황` tab (or the one given). */
  openMiningComputer(uid: string | null, tab?: MiningComputerTab): void { return openMiningComputerScreen(this, uid, tab); }
  /* ══ end of the crypto mining screen ══ */

  /* ══ furniture operation (2026-09-13) ══ — power allocation (allocation · disabling · stopped clocks) was dropped
     the same day (user's decision). The power API (`getPowerOverview` · `setPowerAllocation` · `setFurnitureDisabled` ·
     `getOperationalBenchLevel` …) is not implemented; only the two remaining queries stay. */
  /** Why this piece cannot be used right now — only a compute cluster without a main computer, always null otherwise (`parts/Mining.clusterOperationalBlock`). */
  furnitureOperationalBlock(uid: string): string | null { return Mining.clusterOperationalBlock(this, uid); }
  /** "Now" for a clock-driven piece (growing · culture · analysis) — nothing stops any more, so it is plain `nowMs()`. */
  stationNow(_uid: string): number { return this.nowMs(); }
  /* ══ end of furniture operation ══ */

  /* ── loadout presets (retired — 2026-09-12, user's decision 「프리셋 기능 제거」: every call answers 「슬롯 없음」, `parts/Presets.ts`) ── */
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
  /* appended (2026-09-16): the stash upgrade modal — 「업그레이드」 in the inventory Tab and the workbench window calls it through `HousingRef`. */
  openStorageUpgrade(): void { return openStorageUpgrade(this); }
  /* appended (2026-09-16): the upgrade modal for one workbench — the same modal, only the subject is that piece. */
  openBenchUpgrade(bench: WorkbenchKind): void { return openBenchUpgrade(this, bench); }

  /** Close every panel; `relock` false when another panel opens right away. */
  closeMenus(relock = true): void { return Preset.closeMenus(this, relock); }

  /* ══ crypto mining (2026-09-13) ══ — compute clusters · the wallet · the exchange (`parts/Mining.ts` · pure rules `MiningRules.ts`). The screens (`openComputeCluster` · `openMiningComputer`) are on the ui side. */
  getCryptoCoins(): CryptoCoinInfo[] { return Mining.getCryptoCoins(this); }
  getCryptoWallet(): Readonly<Record<string, number>> { return Mining.getCryptoWallet(this); }
  getMiningComputerUid(): string | null { return Mining.getMiningComputerUid(this); }
  getComputeClusters(): ComputeClusterInfo[] { return Mining.getComputeClusters(this); }
  getComputeCluster(uid: string): ComputeClusterInfo | null { return Mining.getComputeCluster(this, uid); }
  setClusterCoin(uid: string, coinId: string | null): string | null { return Mining.setClusterCoin(this, uid, coinId); }
  insertClusterCores(uid: string, qty: number): string | null { return Mining.insertClusterCores(this, uid, qty); }
  removeClusterCores(uid: string, qty: number, dest?: HarvestDestination): string | null { return Mining.removeClusterCores(this, uid, qty, dest); }
  /* 2026-09-16 (mounting a processor directly): the pair that names a cell — the screen's grid uses these (index = that cell). */
  insertClusterProcessor(uid: string, slot: number, itemUid?: string): string | null { return Mining.insertClusterProcessor(this, uid, slot, itemUid); }
  removeClusterProcessor(uid: string, slot: number, dest?: HarvestDestination): string | null { return Mining.removeClusterProcessor(this, uid, slot, dest); }
  cryptoQuote(coinId: string, side: CryptoTradeSide, units: number): CryptoQuote | null { return Mining.cryptoQuote(this, coinId, side, units); }
  tradeCrypto(coinId: string, side: CryptoTradeSide, units: number): Promise<string | null> { return Mining.tradeCrypto(this, coinId, side, units); }
  devSetCryptoWallet(coinId: string, units: number): string | null { return Mining.devSetCryptoWallet(this, coinId, units); }
  devSetClusterCores(uid: string, cores: number): string | null { return Mining.devSetClusterCores(this, uid, cores); }
  devAdvanceMining(hours: number): number { return Mining.devAdvanceMining(this, hours); }
  /** Dev (2026-09-15, 2nd pass): winds an analyzer's analysis clock forward — console `analyze ff` · `analyze done`. It does not collect. */
  devAdvanceAnalysis(hours: number, uid?: string): number { return Lab.devAdvanceAnalysis(this, hours, uid); }
  /* ══ end of crypto mining ══ */

  /* ══ library series (H1, 2026-09-13) ══ — folded effects · sources · the progress-strip query · recipe unlocks
     (`parts/Library.ts` · pure formula `Rules.computeLibraryEffects`). The sum is cached and `housing:libraryChanged
     {revision}` fires only when it changes (the rules are in `parts/Library`'s section head). */
  getLibraryEffects(): import('@/shared').LibraryEffectsSummary { return Lib.getLibraryEffects(this); }
  getLibrarySources(kind: import('@/shared').LibraryEffectKind, target: string): readonly import('@/shared').LibrarySourceInfo[] { return Lib.getLibrarySources(this, kind, target); }
  getSeriesProgress(seriesId: string): { have: number; total: number; fraction: number } | null { return Lib.getSeriesProgress(this, seriesId); }
  isShelfItemWanted(defId: string): boolean { return Lib.isShelfItemWanted(this, defId); }
  isRecipeUnlocked(recipeId: string): boolean { return Lib.isRecipeUnlocked(this, recipeId); }
  /** For the screens (outside the contract): the state of every series with a shelved volume — series progress and the catalogue on the holder screen. */
  librarySeriesStates(): ReadonlyMap<string, import('./Rules').LibrarySeriesState> { return Lib.librarySeriesStates(this); }
  /** For the screens (outside the contract): did that medium's auxiliary furniture enter the sum (since power was dropped on 2026-09-13 this equals whether it is placed, `hasShelfAux`). */
  libraryAuxActive(medium: import('@/shared').ShelfMedium): boolean { return Lib.libraryAuxActive(this, medium); }
  /** For the screens (outside the contract): is this def shelved in any holder (power plays no part). */
  isShelvedAnywhere(defId: string): boolean { return Lib.isShelvedAnywhere(this, defId); }
  /* ══ end of library series ══ */

  /* ══ video games (H2, 2026-09-13) ══ — the TV console · the seat · the playable list · game sessions
     (`parts/VideoGame.ts` · seat rules `Rules.tvSeatFor` · screens `ui/tv/TvMenu` + the game mode of the workout
     screen, `ui/gym/GymScreen.openGame`). */
  /** The TV screen (on / off · the console · the seat · the playable list). Outside `parts/Presets.panels()`, so `bindVideoGame` closes it. */
  tvMenu: TvMenu | null = null;
  /** The game session in progress — `gameSession` is its `info`. */
  gameState: VideoGame.GameState | null = null;
  get gameSession(): import('@/shared').GameSessionInfo | null { return VideoGame.gameSession(this); }
  getTvConsole(tvUid: string): string | null { return VideoGame.getTvConsole(this, tvUid); }
  attachTvConsole(tvUid: string, defId: string): string | null { return VideoGame.attachTvConsole(this, tvUid, defId); }
  detachTvConsole(tvUid: string): string | null { return VideoGame.detachTvConsole(this, tvUid); }
  getTvSeat(tvUid: string): string | null { return VideoGame.getTvSeat(this, tvUid); }
  tvSeatBlock(tvUid: string): string | null { return VideoGame.tvSeatBlock(this, tvUid); }
  getPlayableGames(tvUid: string): readonly import('@/shared').PlayableGameInfo[] { return VideoGame.getPlayableGames(this, tvUid); }
  openTvMenu(tvUid: string): void { return VideoGame.openTvMenu(this, tvUid); }
  gameBlock(tvUid: string, discDefId: string): string | null { return VideoGame.gameBlock(this, tvUid, discDefId); }
  startGameSession(tvUid: string, discDefId: string): string | null { return VideoGame.startGameSession(this, tvUid, discDefId); }
  cancelGameSession(): void { return VideoGame.cancelGameSession(this); }
  /** Smoke hook — the game mode screen · the judge object (tuning) · the result · the seat rules. */
  get videoGameDebug(): VideoGame.VideoGameDebug { return VideoGame.videoGameDebug(this); }
  /* ══ end of video games ══ */

  save(): void { this.store?.flush(); }
}
