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
import { placementBlockReason } from './Rules';                 // 2026-09-13 배치 규칙 (접근 면)
import { GrowStation } from './ui/GrowStation';
import { Analyzer } from './ui/Analyzer';
import { CultureTank } from './ui/CultureTank';
import { DiningTable } from './ui/DiningTable';
import { BookshelfMenu } from './ui/BookshelfMenu';
import { createShipView } from './ui/ShipView';
import type { HousingPanel } from './ui/Panel';
// 2026-09-16: 창고 업그레이드 모달 — 인벤토리 Tab · 작업대 창이 `HousingRef.openStorageUpgrade()` 로 부른다
import { StorageUpgrade, openBenchUpgrade, openStorageUpgrade } from './ui/StorageUpgrade';
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
import * as Sockets from './parts/Sockets';                  // 요리 재료 티어 (2026-09-13)
import * as Lib from './parts/Library';
import * as Preset from './parts/Presets';
import * as Gym from './parts/Gym';                          // 헬스장 (A-3a)
import type { GymState } from './parts/Gym';
import { GymScreen } from './ui/gym/GymScreen';
import * as Cooking from './parts/Cooking';                  // 요리 미니게임 (2026-09-13)
import * as Mining from './parts/Mining';                    // 암호화폐 채굴 (2026-09-13)
import type { ComputeClusterInfo, CryptoCoinInfo, CryptoQuote, CryptoTradeSide } from '@/shared';
import type { CookState } from './parts/Cooking';
import { CookScreen } from './ui/cook/CookScreen';
import { CookStation } from './ui/cook/CookStation';
import type { CookAutoInfo, CookGame, CookSessionInfo, CraftRecipe } from '@/shared';
import type { MiningComputerTab } from '@/shared';
import type { DiningPlate, MealItemDef, TablePlateInfo } from '@/shared';   // 2026-09-16 식탁 접시
import type { PlateAskState } from './ui/cook/PlateAsk';
import { closePlateAsk } from './ui/cook/PlateAsk';
// 채굴 화면 (2026-09-13 → 2026-09-14 통합: 채굴 · 클러스터 현황 · 지갑 · 거래소가 한 창이다)
import { MiningScreen, openComputeClusterScreen, openMiningComputerScreen } from './ui/mining/MiningScreen';
import * as VideoGame from './parts/VideoGame';              // 비디오게임 (H2, 2026-09-13)
import * as Music from './parts/Music';                      // 음악 재생 (2026-09-14) — 소리 없는 순수 상태
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
  /** 분석 화면 (연구실, 2026-09-11). 이름이 `analyzer` 가 아닌 것은 `openAnalyzer` 메서드와 겹치지 않게 하기 위함이다. */
  analyzerPanel: Analyzer | null = null;
  /** 배양 화면 (배양조 A-14, 2026-09-11) — 메서드는 `openCultureTank` 라 이름이 겹치지 않는다. */
  cultureTank: CultureTank | null = null;
  /** 식사 화면 (주방 A-3c, 2026-09-11) — 메서드는 `openDiningTable` 이다. */
  diningTable: DiningTable | null = null;
  bookshelfMenu: BookshelfMenu | null = null;
  /**
   * 창고 업그레이드 모달 (2026-09-16) — 가구 화면이 아니라 `ctx.uiRoot` 직계에 홀로 뜨므로 패널 목록(`panels()`)이
   * 아니라 여기에 산다. 처음 열 때 만들어지고 `dispose()` 가 걷는다.
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
    this.evictNotice = loaded.evicted;
    this.generatorNotice = loaded.removedByGenerator;
    this.nextUid = maxUidIndex(this.state.furniture);
  }

  /**
   * 2026-09-13 (배치 규칙, 사용자 결정): `sanitize` 가 접근 면 규칙을 어기는 옛 배치를 가구 창고로 옮긴 조각 수. 첫 `update` 에서 한 번 알린다
   * (생성자 시점에는 알림을 받을 HUD 가 없다). 옮긴 결과는 곧바로 저장한다 — 서버 사본도 다음 로드에서 같은 답을 낸다.
   */
  private evictNotice = 0;
  /**
   * 2026-09-13 (전력 할당 폐지, 사용자 결정): `sanitize` 가 발전기 레벨이 모자라 제거한 시설 수 (`SanitizeOutcome.removedByGenerator`).
   * `evictNotice` 처럼 첫 `update` 에서 한 번 알린다 — 환불 자체는 `pendingRefund` 가 따로 알린다.
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
    this.gymScreen = new GymScreen(ctx, this);                 // 헬스장 (A-3a)
    this.unsubs.push(...Gym.bindGym(this));
    this.cookStation = new CookStation(ctx, this);             // 요리 미니게임 (2026-09-13)
    this.cookScreen = new CookScreen(ctx, this);
    this.unsubs.push(...Cooking.bindCooking(this));
    this.unsubs.push(...Lib.bindLibrary(this));                // 서재 시리즈 (H1, 2026-09-13) — 효과 합산 캐시 · housing:libraryChanged
    this.unsubs.push(...Mining.bindMining(this));              // 암호화폐 채굴 (2026-09-13)
    this.miningScreen = new MiningScreen(ctx, this);            // 채굴 화면 (2026-09-14 통합 — 탭 넷이 한 창)
    this.tvMenu = new TvMenu(ctx, this); this.unsubs.push(...VideoGame.bindVideoGame(this));   // 비디오게임 (H2, 2026-09-13)
    this.unsubs.push(...Music.bindMusic(this));                // 음악 재생 (2026-09-14)
    this.unsubs.push(...Dining.bindDining(this));              // 식탁 접시 (2026-09-16): 레이드 시작에 치움 · 분대원 접시
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('game:abort', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('hub:left', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('game:phaseChanged', ({ phase }) => { if (phase !== 'hub') { this.closeMenus(); this.exitHousingMode(); } }),
      b.on('net:profileLoaded', () => this.onProfileLoaded()),
    );
    // 이 발행은 init 안이라 **뒤에 등록되는 시스템은 못 듣는다** — 그쪽은 자기 init 에서 `ctx.housing.state` 를 읽고,
    // hub 는 `net:profileLoaded` 뒤의 재발행(`onProfileLoaded`)에서 다시 짓는다.
    b.emit('housing:loaded', { state: this.state });
    this.lastStash = this.getStashSize();
    b.emit('housing:stashSizeChanged', { ...this.lastStash });
  }

  update(_dt: number, ctx: GameContext): void {
    if (this.pendingRefund.length) this.flushRetiredRefund();
    Mining.tickMining(this);                                   // 암호화폐 채굴: 끝난 주기를 지갑에 (1 Hz, 2026-09-13)
    Lib.tickLibrary(this);                                     // 서재 시리즈 (H1): loot 없이 센 합산을 loot 가 생긴 첫 프레임에 다시
    Music.tickMusic(this);                                     // 음악 재생 (2026-09-14): 곡이 끝났는지 시각만 본다 (꺼져 있으면 비교 한 번)
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
    closePlateAsk(this);                                       // 2026-09-16: 떠 있는 「식탁의 요리를 바꿉니다」 경고
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.growStation?.dispose(); this.analyzerPanel?.dispose();
    this.cultureTank?.dispose(); this.diningTable?.dispose(); this.bookshelfMenu?.dispose();
    this.growStation = null; this.analyzerPanel = null;
    this.cultureTank = null; this.diningTable = null; this.bookshelfMenu = null;
    this.gymScreen?.dispose(); this.gymScreen = null;          // 헬스장 (A-3a)
    this.cookScreen?.dispose(); this.cookScreen = null;        // 요리 미니게임 (2026-09-13)
    this.cookStation?.dispose(); this.cookStation = null;
    this.miningScreen?.dispose(); this.miningScreen = null;    // 채굴 화면 (2026-09-14 통합)
    this.storageUpgrade?.dispose(); this.storageUpgrade = null; // 창고 업그레이드 모달 (2026-09-16)
    Music.stopMusic(this);                                     // 음악 재생 (2026-09-14): 창이 사라진 채 상태만 남지 않게
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
    const plateBefore = this.getPlate();                          // 2026-09-16: 서버 사본의 접시가 다르면 알린다 (아래)
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
    // (2026-09-13: or a pre-v10 document that just got the 조종석 꾸밈 가구)
    if (out.migratedRoomLevels || out.migratedRooms || out.grantedCockpit || out.migratedCockpit) this.store?.markDirty();
    // 2026-09-13 (전력 할당 폐지): 서버 사본에도 발전기 레벨이 모자란 시설이 있었다 — 알린다 (환불은 `pendingRefund`, 저장은 `migratedRooms`)
    if (out.removedByGenerator) this.generatorNotice += out.removedByGenerator;
    if (out.migratedLibrary || out.aliasedLibrary) this.store?.markDirty();   // 서재 시리즈 (H1): 옛 id 치환 · 중복 / 게임기 환불을 한 번 올린다
    // 2026-09-13 (배치 규칙): 서버 사본의 옛 배치도 같은 규칙으로 가구 창고에 옮겨졌다 — 알리고 한 번 올린다
    if (out.evictedByAccess) { this.evictNotice += out.evictedByAccess; this.store?.markDirty(); }
    const b = this.ctx.bus;
    b.emit('housing:loaded', { state: this.state });
    b.emit('housing:changed', { reason: 'profile' });
    this.emitStashSizeIfChanged();
    Dining.afterStateReplaced(this, plateBefore);                // 식탁 접시 (net 이 분대원에게 · hub 가 식탁 조각에)
  }

  /* ── helpers ───────────────────────────────────────────────────────────── */
  changed(reason: string): void {
    this.editPending = true;
    this.store?.markDirty();
    this.ctx.bus.emit('housing:changed', { reason });
  }

  /**
   * 2026-09-13: 저장만 예약한다 — `housing:changed` 를 내지 않는다. `housing:changed` 를 받은 자리에서 상태를 고치는 쪽(`parts/Library` 의
   * 옛 id 치환)이 부른다 — 여기서 다시 내면 끝없이 돈다.
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
   * 2026-09-13 (배치 규칙 — 계약 `HousingRef.placementBlock`): 놓을 수 없는 한국어 사유, null = `canPlace` 가 true.
   * 순서 · 문장은 `Rules.placementBlockOf` 한 곳 (자리 → 용도 → 격자 → 고정 소품 → 쌓기 → 겹침 → 내 접근 면 → 남의 접근 면).
   */
  placementBlock(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): string | null {
    const def = this.getFurnitureDef(defId);
    return def ? placementBlockReason(this.state, room, def, x, y, yaw, ignoreUid) : '알 수 없는 가구입니다';
  }

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

  /* ══ 요리 재료 티어 (2026-09-13) ══ — 분석 레벨 · 결과표 (`parts/Lab`) · 흙 / 배지 소켓 (`parts/Sockets`) · 배양 스캐폴드 (`parts/Culture`) */
  getAnalysisLevel(family: SampleFamily): AnalysisLevelInfo { return Lab.getAnalysisLevel(this, family); }
  getAnalysisResults(family: SampleFamily): AnalysisResultInfo[] { return Lab.getAnalysisResults(this, family); }
  getAnalysisFound(): readonly string[] { return Lab.getAnalysisFound(this); }
  /* 2026-09-16 (표본 개편): 표본별 레벨 · 등급별 도감 칸 — 분석 화면이 `Lv.n · −x %` 로 읽는다. */
  getSampleAnalysis(defId: string): import('@/shared').SampleAnalysisInfo | null { return Lab.getSampleAnalysis(this, defId); }
  getAnalysisDexByRarity(): Readonly<Record<import('@/shared').Rarity, number>> { return Lab.getAnalysisDexByRarity(this); }
  insertGrowSocket(uid: string, tier: GrowTier, slot: number, socketDefId: string, replaceIndex?: number): string | null { return Garden.insertGrowSocket(this, uid, tier, slot, socketDefId, replaceIndex); }
  insertCultureSocket(uid: string, slot: number, socketDefId: string, replaceIndex?: number): string | null { return Culture.insertCultureSocket(this, uid, slot, socketDefId, replaceIndex); }
  insertScaffold(uid: string, slot: number, scaffoldDefId: string): string | null { return Culture.insertScaffold(this, uid, slot, scaffoldDefId); }
  takeScaffold(uid: string, slot: number, dest?: HarvestDestination): string | null { return Culture.takeScaffold(this, uid, slot, dest); }
  getOwnedSockets(target?: GrowSocketTarget): { defId: string; qty: number }[] { return Sockets.getOwnedSockets(this, target); }
  /* ══ 요리 재료 티어 끝 ══ */

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

  /* ── 주방 식탁 · 접시 (A-3c 2026-09-11 → 2026-09-16 접시 모델) ─────────── */
  /**
   * 공유 함선의 분대원 접시 (PeerId → 이름 · 접시) — net 이 `net:squadPlate` 로 채우고 `parts/Dining.bindDining` 이 지운다.
   * 내 접시는 여기가 아니라 `state.plate` 다.
   */
  readonly squadPlates = new Map<string, Dining.SquadPlate>();
  /** 떠 있는 「식탁의 요리를 바꿉니다」 경고 (`ui/cook/PlateAsk`), 없으면 null. */
  plateAsk: PlateAskState | null = null;

  /** 공유 함선의 고정 식탁 앞인가. */
  isSharedTable(): boolean { return Dining.isSharedTable(this); }

  /** 왜 지금 식탁을 쓸 수 없는가 (null = 괜찮다). `uid` null = 공유 함선의 고정 식탁. */
  diningBlock(uid: string | null): string | null { return Dining.diningBlock(this, uid); }

  /** 요리 정의 (`shared/meals` — 요리는 아이템이 아니다), 요리가 아니면 null. */
  mealDef(defId: string): MealItemDef | null { return Dining.mealDef(this, defId); }

  /** 내 함선에 식탁 가구가 배치돼 있나 (조리대 게이트). */
  hasDiningTable(): boolean { return Dining.hasDiningTable(this); }

  /** 내 함선 식탁의 접시, 없으면 null. */
  getPlate(): DiningPlate | null { return Dining.getPlate(this); }

  /** 그 식탁의 접시들 (`uid` = 내 식탁 가구 → 내 것만, null = 공유 함선 식탁 → 분대원 것까지). */
  getTablePlates(uid: string | null): TablePlateInfo[] { return Dining.getTablePlates(this, uid); }

  /** 지금 그 접시를 먹을 수 없는 한국어 사유 (「이미 먹었습니다」 포함), null = 먹을 수 있다. */
  plateEatBlock(uid: string | null, ownerId?: string | null): string | null { return Dining.plateEatBlock(this, uid, ownerId); }

  /** 접시를 먹는다 — 접시는 줄지 않고 `progression.useMeal` 이 대기 식사를 싣는다. 한국어 사유 / null. */
  eatPlate(uid: string | null, ownerId?: string | null): string | null { return Dining.eatPlate(this, uid, ownerId); }

  /** 개발 · 스모크: 조리 없이 내 식탁에 접시를 놓는다. */
  devSetPlate(mealDefId: string, quality = 0): string | null { return Dining.devSetPlate(this, mealDefId, quality); }

  /** 개발 · 스모크: 내 접시를 치운다. */
  clearPlate(): boolean { return Dining.clearPlate(this, 'dev'); }

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

  /* ══ 서재 매체 (A-3e) ══ — 디스크 전시대 · 레코드랙 · 보조 가구 · TV / 레코드 플레이어 켜기 (`parts/Library.ts`, 2026-09-12).
     책장은 위의 옛 경로(`books` · `placeBook` · `housing:booksChanged`)를 그대로 타고, 매체 공통 API 가 책장이면 그리로 넘긴다. */
  /** 디스크 · 레코드 칸 (`ShipState.media`); prunes ids `ctx.loot` no longer knows on first access. */
  media(): PlacedBook[] { return Lib.media(this); }
  /** 디스크 · 레코드 도감 (append-only). */
  mediaDex(): string[] { return Lib.mediaDex(this); }
  /** 켜 둔 TV · 레코드 플레이어 uid (`ShipState.toggled`). */
  toggledUids(): string[] { return Lib.toggledUids(this); }
  /** Everything shelved in 보관함 `uid` (책장 → `booksOf`). */
  shelfItemsOf(uid: string): PlacedBook[] { return Lib.shelfItemsOf(this, uid); }
  /** `…를 먼저 빼세요` while a 보관함's contents cannot go to the stash (free-cell estimate), else null. */
  shelfBlock(uid: string): string | null { return Lib.shelfBlock(this, uid); }
  /** Move a 보관함's contents into the stash, all or nothing (책장 → `stashBooksOf`). */
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
  /* ══ 서재 매체 (A-3e) 끝 ══ */

  /* ══ 음악 재생 (2026-09-14) ══ — 축음기 · 주크박스 · 턴테이블을 켜면 레코드랙에 꽂힌 레코드가 재생 목록이 된다 (`parts/Music.ts`).
     **소리는 나지 않는다** — 상태뿐이고 `ui/hud/MusicPlayer` 가 `housing:musicChanged` 하나만 보고 그린다.
     질의 · 조작은 `HousingRef` 의 2026-09-14 추가 계약(전부 옵셔널)이고 화면은 이벤트만 본다. */
  /** 지금 재생 상태 — 꺼져 있으면 `MUSIC_PLAYER_OFF`. 바뀔 때마다 `housing:musicChanged`. */
  musicState: import('@/shared').MusicPlayerState = Music.initialMusicState();
  /** 지금 재생 상태 (늦게 붙는 화면이 첫 이벤트를 기다리지 않아도 되게). */
  getMusicState(): import('@/shared').MusicPlayerState { return Music.musicState(this); }
  /** 다음 / 이전 곡 (`'repeat'` 이어도 사람이 누르면 넘어간다). */
  musicNext(): boolean { return Music.musicNext(this); }
  musicPrev(): boolean { return Music.musicPrev(this); }
  /** 재생 방식 전환 (같은 값이면 false). */
  setMusicMode(mode: import('@/shared').MusicMode): boolean { return Music.setMusicMode(this, mode); }
  /** 재생을 멈춘다 — 가구의 `toggled` 도 함께 내린다 (E 로 끈 것과 같다). */
  musicStop(): boolean { return Music.musicStop(this); }
  /* ══ 음악 재생 끝 ══ */

  /* ══ 헬스장 (A-3a) ══ — 운동 기구 미니게임 세션 (`parts/Gym.ts` · 판정 `parts/GymGames.ts` · 화면 `ui/gym/`, 2026-09-12). */
  /** 운동 화면 (시작 안내 · 게임 · 결과). */
  gymScreen: GymScreen | null = null;
  /** 진행 중인 세션 — `gymSession` 이 이것의 `info` 다. */
  gymState: GymState | null = null;
  get gymSession(): import('@/shared').GymSessionInfo | null { return Gym.gymSession(this); }
  gymBlock(uid: string): string | null { return Gym.gymBlock(this, uid); }
  startGymSession(uid: string): string | null { return Gym.startGymSession(this, uid); }
  cancelGymSession(): void { return Gym.cancelGymSession(this); }
  /** 스모크 훅 — 화면 상태 · 판정 객체 · 결과 · 건너뛰기. */
  get gymDebug(): Gym.GymDebug { return Gym.gymDebug(this); }
  /* ══ 헬스장 (A-3a) 끝 ══ */

  /* ══ 요리 미니게임 (2026-09-13) ══ — 조리대 화면 · 조리 세션 (`parts/Cooking.ts` · 판정 `parts/CookGames.ts` · 화면 `ui/cook/`). */
  /** 조리대 화면 (요리 목록 · 재료 · 단계 · 창고 / 가방). */
  cookStation: CookStation | null = null;
  /** 조리 오버레이 (선택 카드 · 미니게임 · 결과). */
  cookScreen: CookScreen | null = null;
  /** 진행 중인 조리 — `cookSession` 이 이것의 `info` 다. */
  cookState: CookState | null = null;
  openCookStation(uid: string): void { return Cooking.openCookStation(this, uid); }
  get cookSession(): CookSessionInfo | null { return Cooking.cookSession(this); }
  cookBlock(uid: string, recipeId: string): string | null { return Cooking.cookBlock(this, uid, recipeId); }
  startCook(uid: string, recipeId: string): string | null { return Cooking.startCook(this, uid, recipeId); }
  cancelCook(): void { return Cooking.cancelCook(this); }
  getCookAuto(game: CookGame): CookAutoInfo | null { return Cooking.getCookAuto(this, game); }
  /** 조리대 레시피 (조리 단계가 있는 `bench cook`). */
  cookRecipes(): CraftRecipe[] { return Cooking.cookRecipes(this); }
  /** 스모크 훅 — 화면 상태 · 판정 객체 · 결과 · 선택 · 건너뛰기. */
  get cookDebug(): Cooking.CookDebug { return Cooking.cookDebug(this); }
  /* ══ 요리 미니게임 끝 ══ */

  /* ══ 채굴 화면 ══ — `ui/mining/` (2026-09-14 사용자 결정: 연산 클러스터 화면 · 메인 컴퓨터를 **한 창**으로 합쳤다 —
     상단 가로 탭 `MINING_TABS` = 채굴 · 클러스터 현황 · 지갑 · 거래소). 규칙 · 지갑 · 매매는 `parts/Mining`. */
  /** 통합 채굴 창 (`ui/mining/MiningScreen`). */
  miningScreen: MiningScreen | null = null;
  /** @deprecated 2026-09-14 통합 — 같은 창을 가리킨다 (옛 호출자 · `parts/Presets.panels()`). */
  get clusterScreen(): MiningScreen | null { return this.miningScreen; }
  /** @deprecated 2026-09-14 통합 — 같은 창을 가리킨다. */
  get miningComputer(): MiningScreen | null { return this.miningScreen; }
  /** 연산 클러스터의 E — 통합 창을 `채굴` 탭으로 연다 (사용자 결정: 가구마다 제 탭이 기본). */
  openComputeCluster(uid: string): void { return openComputeClusterScreen(this, uid); }
  /** 메인 컴퓨터의 E — 통합 창을 `클러스터 현황`(또는 지정한) 탭으로 연다. */
  openMiningComputer(uid: string | null, tab?: MiningComputerTab): void { return openMiningComputerScreen(this, uid, tab); }
  /* ══ 암호화폐 채굴 화면 끝 ══ */

  /* ══ 가구 가동 (2026-09-13) ══ — 같은 날 전력 할당(할당 · 비활성화 · 멈춘 시계)이 폐지됐다 (사용자 결정). 전력 API
     (`getPowerOverview` · `setPowerAllocation` · `setFurnitureDisabled` · `getOperationalBenchLevel` …)는 구현하지 않고, 남은 질의 둘만 둔다. */
  /** 이 가구를 지금 쓸 수 없는 사유 — 메인 컴퓨터 없는 연산 클러스터뿐이고 그 밖에는 늘 null (`parts/Mining.clusterOperationalBlock`). */
  furnitureOperationalBlock(uid: string): string | null { return Mining.clusterOperationalBlock(this, uid); }
  /** 시계형 가구(재배 · 배양 · 해석)의 「지금」 — 멈추는 가구가 없어져 `nowMs()` 그대로다. */
  stationNow(_uid: string): number { return this.nowMs(); }
  /* ══ 가구 가동 끝 ══ */

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
  /* appended (2026-09-16): 창고 업그레이드 모달 — 인벤토리 Tab · 작업대 창의 「업그레이드」가 `HousingRef` 로 부른다. */
  openStorageUpgrade(): void { return openStorageUpgrade(this); }
  /* appended (2026-09-16): 작업대 한 대의 업그레이드 모달 — 같은 모달, 대상만 그 가구다. */
  openBenchUpgrade(bench: WorkbenchKind): void { return openBenchUpgrade(this, bench); }

  /** Close every panel; `relock` false when another panel opens right away. */
  closeMenus(relock = true): void { return Preset.closeMenus(this, relock); }

  /* ══ 암호화폐 채굴 (2026-09-13) ══ — 연산 클러스터 · 지갑 · 거래소 (`parts/Mining.ts` · 순수 규칙 `MiningRules.ts`). 화면(`openComputeCluster` · `openMiningComputer`)은 ui 쪽. */
  getCryptoCoins(): CryptoCoinInfo[] { return Mining.getCryptoCoins(this); }
  getCryptoWallet(): Readonly<Record<string, number>> { return Mining.getCryptoWallet(this); }
  getMiningComputerUid(): string | null { return Mining.getMiningComputerUid(this); }
  getComputeClusters(): ComputeClusterInfo[] { return Mining.getComputeClusters(this); }
  getComputeCluster(uid: string): ComputeClusterInfo | null { return Mining.getComputeCluster(this, uid); }
  setClusterCoin(uid: string, coinId: string | null): string | null { return Mining.setClusterCoin(this, uid, coinId); }
  insertClusterCores(uid: string, qty: number): string | null { return Mining.insertClusterCores(this, uid, qty); }
  removeClusterCores(uid: string, qty: number, dest?: HarvestDestination): string | null { return Mining.removeClusterCores(this, uid, qty, dest); }
  /* 2026-09-16 (프로세서 직접 장착): 칸을 지정하는 짝 — 화면 격자가 이것을 쓴다 (인덱스 = 그 칸). */
  insertClusterProcessor(uid: string, slot: number, itemUid?: string): string | null { return Mining.insertClusterProcessor(this, uid, slot, itemUid); }
  removeClusterProcessor(uid: string, slot: number, dest?: HarvestDestination): string | null { return Mining.removeClusterProcessor(this, uid, slot, dest); }
  cryptoQuote(coinId: string, side: CryptoTradeSide, units: number): CryptoQuote | null { return Mining.cryptoQuote(this, coinId, side, units); }
  tradeCrypto(coinId: string, side: CryptoTradeSide, units: number): Promise<string | null> { return Mining.tradeCrypto(this, coinId, side, units); }
  devSetCryptoWallet(coinId: string, units: number): string | null { return Mining.devSetCryptoWallet(this, coinId, units); }
  devSetClusterCores(uid: string, cores: number): string | null { return Mining.devSetClusterCores(this, uid, cores); }
  devAdvanceMining(hours: number): number { return Mining.devAdvanceMining(this, hours); }
  /** 개발용 (2026-09-15 2차): 분석기 해석 시계를 앞당긴다 — 콘솔 `analyze ff` · `analyze done`. 회수는 하지 않는다. */
  devAdvanceAnalysis(hours: number, uid?: string): number { return Lab.devAdvanceAnalysis(this, hours, uid); }
  /* ══ 암호화폐 채굴 끝 ══ */

  /* ══ 서재 시리즈 (H1, 2026-09-13) ══ — 효과 합산 · 소스 · 띠 질의 · 레시피 해금 (`parts/Library.ts` · 순수 식 `Rules.computeLibraryEffects`).
     합산은 캐시되고 바뀔 때만 `housing:libraryChanged {revision}` 이 난다 (규칙은 `parts/Library` 의 절 머리). */
  getLibraryEffects(): import('@/shared').LibraryEffectsSummary { return Lib.getLibraryEffects(this); }
  getLibrarySources(kind: import('@/shared').LibraryEffectKind, target: string): readonly import('@/shared').LibrarySourceInfo[] { return Lib.getLibrarySources(this, kind, target); }
  getSeriesProgress(seriesId: string): { have: number; total: number; fraction: number } | null { return Lib.getSeriesProgress(this, seriesId); }
  isShelfItemWanted(defId: string): boolean { return Lib.isShelfItemWanted(this, defId); }
  isRecipeUnlocked(recipeId: string): boolean { return Lib.isRecipeUnlocked(this, recipeId); }
  /** 화면용 (계약 밖): 꽂힌 권이 있는 시리즈의 상태 — 보관함 화면의 시리즈 진척 · 도감. */
  librarySeriesStates(): ReadonlyMap<string, import('./Rules').LibrarySeriesState> { return Lib.librarySeriesStates(this); }
  /** 화면용 (계약 밖): 그 매체의 보조 가구가 합산에 들어갔는가 (2026-09-13 전력 폐지 뒤로는 배치 여부 `hasShelfAux` 와 같다). */
  libraryAuxActive(medium: import('@/shared').ShelfMedium): boolean { return Lib.libraryAuxActive(this, medium); }
  /** 화면용 (계약 밖): 이 def 가 어느 보관함에든 꽂혀 있는가 (전력 무관). */
  isShelvedAnywhere(defId: string): boolean { return Lib.isShelvedAnywhere(this, defId); }
  /* ══ 서재 시리즈 끝 ══ */

  /* ══ 비디오게임 (H2, 2026-09-13) ══ — TV 게임기 · 좌석 · 게임 목록 · 게임 세션 (`parts/VideoGame.ts` · 좌석 규칙 `Rules.tvSeatFor` ·
     화면 `ui/tv/TvMenu` + 운동 화면의 게임 모드 `ui/gym/GymScreen.openGame`). */
  /** TV 화면 (켜기/끄기 · 게임기 · 좌석 · 게임 목록). `parts/Presets.panels()` 밖이라 닫기는 `bindVideoGame` 이 한다. */
  tvMenu: TvMenu | null = null;
  /** 진행 중인 게임 세션 — `gameSession` 이 이것의 `info` 다. */
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
  /** 스모크 훅 — 게임 모드 화면 · 판정 객체(튜닝) · 결과 · 좌석 규칙. */
  get videoGameDebug(): VideoGame.VideoGameDebug { return VideoGame.videoGameDebug(this); }
  /* ══ 비디오게임 끝 ══ */

  save(): void { this.store?.flush(); }
}
