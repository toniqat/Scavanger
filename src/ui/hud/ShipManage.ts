import type { CraftIngredient, FacilityRequirement, FurnitureDef, FurnitureModelKind, GameContext, ItemDef, RoomPurpose } from '@/shared';
import {
  COCKPIT_ROOM_INDEX, FACILITY_COLOR, FACILITY_GLYPH, FACILITY_LABEL_KO, Keys, renderItemCost, ROOM_PURPOSES_ACTIVE, ROOM_PURPOSES_ASSIGNABLE,
  ROOM_PURPOSE_COLOR, ROOM_PURPOSE_GLYPH, ROOM_PURPOSE_LABEL_KO, SHIP_ROOM_COUNT, UI_HOLD_CONFIRM_S, purposeGeneratorLevel,
  WORKBENCH_ICON, buildFacilityChip, buildItemChip, createHoldButtonCap, isCockpitOnlyFurniture, isUtilityFurniture, slotKey,
} from '@/shared';
import { el, restartAnim, setText, toggleClass } from '../dom';
/* 2026-09-14 (user's decision): the hover card of a 필요 아이템 row goes to the top-left of the cursor — the source of that opt-in attribute is `ItemTip` alone. */
import { TIP_ANCHOR_ATTR } from './ItemTip';

/**
 * Per-slot localStorage key that reopens the right-hand tab (가구 제작 / 가구 창고) **the way it was last seen**
 * (2026-09-15, user's decision). Remembering the room is housing's part (`MANAGE_ROOM_KEY` in
 * `housing/parts/Furniture` — that side decides which room opens). An unreadable or odd value silently falls back to
 * the old default `'craft'`.
 */
const MANAGE_TAB_KEY = 'scav.shipManage.tab';

function readManageTab(): FurnTab | null {
  try {
    const raw = window.localStorage?.getItem(slotKey(MANAGE_TAB_KEY));
    return raw === 'craft' || raw === 'store' ? raw : null;
  } catch { return null; }
}

function writeManageTab(tab: FurnTab): void {
  try { window.localStorage?.setItem(slotKey(MANAGE_TAB_KEY), tab); } catch { /* private mode · blocked site data */ }
}

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
/** 2026-09-12: the 가구 제작 list is split into 시설 가구 (`isUtilityFurniture`) and 꾸밈용 가구. */
type FurnKind = 'utility' | 'decor';
/** How long the placement-refusal toast above the 인스펙터 stays up (UI timing, not balance). */
const TOAST_MS = 2200;

/** A free grid cell + yaw the 배치 button would drop a stored piece on (2026-09-09). */
interface FreeSpot { x: number; y: number; yaw: 0 | 1 | 2 | 3 }

/** Glyph per procedural furniture model (no asset files — the card thumbnail is a tinted frame + a character). */
const MODEL_GLYPH: Readonly<Record<FurnitureModelKind, string>> = {
  /* The glyphs of the five workbenches come from `WORKBENCH_ICON` in `shared` — they must be the same characters as the craft tab (`inventory/ui/labels`). */
  bench_gun: WORKBENCH_ICON.gun, bench_gear: WORKBENCH_ICON.gear, bench_gadget: WORKBENCH_ICON.gadget,
  bench_medical: WORKBENCH_ICON.medical, bench_refine: WORKBENCH_ICON.refine,
  range_console: '▣', target_lane: '◎', sim_hub: '◈',
  /* Greenhouse rework (2026-09-11): the old grow rack `grow_rack` is retired but its glyph is left in place (`Record`
     demands all of them, and an old save path that draws retired furniture falling through to `?? '▨'` makes the card
     look entirely different). The new grow station is not one rack but stacked racks, so it is told apart by the
     **double flower** `✿` — one Unicode character as the no-external-assets rule requires, and a different character
     from `❀` (the old grow rack) · `❦` (a potted plant) · `❁` (the crop category). */
  grow_rack: '❀', grow_station: '✿', repair_bench: '⛏', bookshelf: '▤',
  locker: '▤', table: '▭', shelf: '☰', crate: '▨', lamp: '☀', plant: '❦', chair: '⌂', bunk: '▬',
  /* Lab (A-11 · A-12 · A-13, 2026-09-11): the extractor · the mixer are workbenches, so the source of their glyphs is
     `WORKBENCH_ICON` (they must be the same characters as the craft tab `inventory/ui/labels`); the analyzer is not a
     workbench but a station, so it has its own character — the benzene ring `⌬` collides with none of the characters
     above and still reads as 「the thing that analyses」. */
  analyzer: '⌬', bench_extract: WORKBENCH_ICON.extract, bench_mixer: WORKBENCH_ICON.mixer,
  /* Kitchen · culture tank · printer (A-3c · A-14 · A-15, 2026-09-11): the cook bench · the printer are workbenches, so
     the source of their glyphs is `WORKBENCH_ICON` (the same characters as the craft tab `inventory/ui/labels` — the
     2026-09-10 contract); the dining table · the culture tank are not workbenches but stations, so they have their own
     characters: the dining table `⊞` (a top with places laid — told apart from the plain table `▭`), the culture tank
     `⚗` (a still — 「something grows inside」). Both are one Unicode character colliding with none of the above. */
  bench_cook: WORKBENCH_ICON.cook, bench_print: WORKBENCH_ICON.print,
  dining_table: '⊞', culture_tank: '⚗',
  /* 2026-09-13 (crypto mining): the compute cluster `▥` (a server rack of cells in a row) · the main computer `⌨` — colliding with no furniture character above or below */
  compute_cluster: '▥', mining_computer: '⌨',
  /* 2026-09-13 (cooking minigame): the four automatic cooking pieces. All four of the lead's placeholder characters were
     changed — `⊚` collided with the record rack, and `▦` · `⩡` were the same as the cook screen's step chip glyphs
     (`COOK_GAME_ICON` 굽기 · 붓기), so 「furniture」 and 「step」 read as one character (the auto grill also fries); `⊗` read
     as 「closed」. The food processor `⌽` (a round bowl on a blade shaft) · the auto grill `≋` (a glowing heating coil) ·
     the auto stirrer `⚲` (a stirring blade lowered down) · the measuring dispenser `⛛` (a funnel). All four are one
     Unicode character colliding with none above or below (no external assets). */
  food_processor: '⌽', auto_grill: '≋', auto_stirrer: '⚲', pour_dispenser: '⛛',
  /* 2026-09-12 (user's decision): the two that were fixed installations of the cockpit became shared facility furniture —
     the implant bay `⚕` (medical) · the computer `⌨` (a keyboard), both colliding with none of the characters above. */
  implant_bay: '⚕', corp_computer: '⌨',
  /* 2026-09-12 (A-3e): library media — a shelf takes the same character as the item category
     (`CATEGORY_ICON.disc/record`), a helper piece its own shape. The gramophone · jukebox · turntable are one role but
     look different, so their characters differ too. */
  disc_stand: '◉', record_rack: '⊚', rocking_chair: '⌓', tv: '⊡', gramophone: '♫', jukebox: '♪', turntable: '◐',
  /* 2026-09-12 (A-3a): gym equipment. Three of the lead's placeholder characters were changed — `╤`/`╦` were almost the
     same shape at card size, `═` read as nothing at all and `⊘` read as 「forbidden」. The bench rack `╤` (a barbell on
     posts) · the smith machine `╫` (a bar across two rails) · the treadmill `▱` (a tilted belt plate) · the exercise
     bike `⚯` (two wheels joined by a frame). All four collide with none of the characters above. */
  bench_rack: '╤', smith_machine: '╫', treadmill: '▱', exercise_bike: '⚯',
  /* 2026-09-13: the drawer unit that was a fixed prop of the cockpit — `☷` (three drawers). It collides with none of the characters above. */
  drawer: '☷',
  /* 2026-09-13 (library series · video games): the lead's placeholder characters — whoever owns hub/ui may check for
     collisions and change them. The game disc stand `⊟` · the sofa `⊔` · the low table `⊓` · the rug `⬚`. */
  game_stand: '⊟', sofa: '⊔', low_table: '⊓', rug: '⬚',
};

/**
 * Purposes offered to an empty room. 2026-09-12: the contract's `ROOM_PURPOSES_ASSIGNABLE` — 시뮬레이션실 · 휴식 공간
 * are gone from it (they are left in `ROOM_PURPOSES` alone so that old saves can be read), and so are 빈 방 / 조종석.
 */
const ASSIGNABLE: readonly RoomPurpose[] = ROOM_PURPOSES_ASSIGNABLE;
/** 2026-09-12: the most material chips a furniture card shows in its one-line cost row (no wrapping). */
const CARD_COST_MAX = 4;
/** Cost chip edge in the furniture cards / inspector: wide enough that `99+/99` fits inside the thumbnail strip. */
const CARD_CHIP = 36;
/** The 재료 부족 toast of the inspector's dimmed 업그레이드 button (the user's decided sentence verbatim). */
const SHORT_UPGRADE_TEXT = '재료가 부족하여 업그레이드할 수 없습니다.';
/** 2026-09-17: blocker / cursor / escape token of the 가구 제작 modal (`openCraft`). */
const CRAFT_MODAL_TOKEN = 'shipManage:craft';
/** Material chip edge inside the 가구 제작 modal (UI size, not balance). */
const CRAFT_MODAL_CHIP = 44;

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
 *         with the Korean reason from `ctx.housing.purposeBlock` when the rules or the materials refuse it.
 *       · a room **with a purpose** → the 가구 목록 behind two tabs (Phase 9 UI pass):
 *           **가구 제작** — every furniture def the room accepts (`getFurnitureFor`), its craft materials as
 *           `.item-chip`s and a 제작 button that calls `ctx.housing.craftFurniture` (this is the only place furniture
 *           is crafted); clicking the row selects it for placement when one is already in storage.
 *           **가구 창고** — what `getStored()` holds: pieces this room accepts first, every other stored piece under
 *           them, dimmed and disabled with the reason (`<용도> 전용`). **2026-09-09 (배치 버튼):** clicking a store
 *           card only **selects** it (`.is-sel` highlight) — it no longer arms ghost placement (`selectFurniture` is
 *           not called from this tab). Each accepted card carries a **`배치` button** (`.fcard-place`, right side,
 *           the craft tab's `.fcard-craft` twin) that drops the piece **straight into the current room** on the
 *           first free cell: `findFreeSpot` asks **`HousingRef.findFreeSpot`** (2026-09-10 — the scan order and the
 *           rotation are housing/'s rule: from the screen's top left, rows first, with the furniture facing the
 *           screen's bottom); a hit goes to
 *           `HousingRef.place` (storage qty decrements there, `housing:furniturePlaced` fires — the tutorial's
 *           `benchPlace` step completes on it). The button is **disabled when nothing fits** and the `.fcard-note`
 *           says why: `배치 가능` / `자리 없음` / `<용도> 전용`. The fit result is part of the store list's memo key
 *           and is recomputed on every room change — `housing:changed`, `furniturePlaced` / `Moved` / `Recovered`,
 *           `facilityUpgraded`, `roomPurposeChanged` and the manage-room switch all refresh it.
 *         A 시설 제거 button in the header clears the room — through a confirm popup and
 *         `HousingRef.removeRoomFacility`, so every material the facility cost comes back (2026-09-08).
 *
 * Driven by `housing:shipManageChanged` (open / close / room change) and `housing:changed` (storage, purposes,
 * materials) plus the per-piece housing events above; `housing:selectionChanged` only re-marks the active card.
 * Takes no blocker token — housing/ owns the mode and hub/ owns the camera and the placement keys.
 *
 * **Phase 12 (시설 증축 that "did nothing"):** on a fresh ship every purpose is refused by the 발전기 gate
 * (`ROOM_PURPOSE_BUILD_GENERATOR_LEVEL` 1 vs a generator at level 0) while the cost chips read as affordable — the
 * reason only lived in a `title` tooltip on a `disabled` button, and the generator itself could only be raised from
 * the Tab 함선 tab. Now: the picker is headed by a **발전기 row** (`.sm-gen`: level, next-level cost chips,
 * 업그레이드 → the confirm popup → `ctx.housing.upgrade('generator')`) that is highlighted while it is what blocks
 * the purposes; a purpose row stays **clickable** when blocked and prints its Korean reason inline (`.sm-block`) —
 * clicking it repeats the reason as a toast; and an allowed purpose opens a centred **modeless confirm popup**
 * (`.sm-confirm`: `정말로 N번 방을 <용도> 시설로 만들겠습니까?` + `renderItemCost` chips of `purposeCost`, 확인 →
 * `setRoomPurpose`, 취소 / Esc → close). Escape is caught in the capture phase and `Input.consume`d, so it closes
 * the popup only — the hub's own Esc (leave 시설 관리) and game/'s pause never see it.
 *
 * **B-13 (2026-09-11, user's decision — the click inspector):** **clicking a placed piece** in 시설 관리 mode makes
 * hub/'s raycast emit `housing:furnitureSelected {uid}` and this screen show the `.sm-inspect` card — name · glyph ·
 * `Lv.n / max` · **the next upgrade's cost chips** (`HousingRef.furnitureUpgradeCost`) · the refusal reason
 * (`furnitureUpgradeBlock`) · `강화` (`upgradeFurniture`). `{uid: null}` (a click on empty floor) · ✕ · changing the
 * room · closing the screen take the card down. `upgradeFurniture` had been there since Phase 8 but nothing called it,
 * so a workbench's Lv.2–3 was unreachable by playing — this is that entrance. The card is in the same grain as
 * `.sm-confirm` but is **modeless**, so it does not cover the screen (another piece can be clicked while it is up).
 * There is no hold confirm either: an upgrade is not an irreversible confirm (the same judgement as the 강화 row of
 * `housing/ui/GrowStation`).
 *
 * **B-13 (2026-09-11, user's decision — a utility piece the ship already owns cannot be made):** a 가구 제작 card asks
 * `HousingRef.furnitureCraftBlock`. With a reason (재료 부족 · `이미 보유 중입니다`) the card is **dimmed + the reason in
 * its `title` + the 제작 button disabled** and sinks to the **bottom** of the list — what can be made is on top (the same
 * grain as `purposeRank` of the 용도 지정 picker). That reason is part of `cardsKey`: when materials arrive and the
 * reason disappears, the list must be redrawn.
 *
 * **2026-09-12 (user's decision — housing mode UI improvements):**
 *   - The 용도 지정 list **does not draw a purpose already built** (every purpose is one per ship —
 *     `Rules.purposeChangeReason`). A `다음 업데이트` purpose stays visible, locked. **The 발전기 row left the purpose
 *     list and moved under the room list on the left** (`.sm-rooms .sm-gen` — the class is unchanged, so the tutorial's
 *     `.sm-gen .sm-gen-btn` focusing survives).
 *   - **시설 가구 / 꾸밈용 가구** sub-tabs inside the 가구 제작 tab (`.sm-subtabs`). For a utility piece already owned the
 *     craft button becomes `이미 보유 중` (disabled) and the 「이미 보유 중입니다」 line under the card is gone. A
 *     시설 가구 card carries no owned count.
 *   - **`위치 이동`** at the inspector's bottom left → `housing:moveRequested {uid}` → hub/'s move state (the same path
 *     as E). Pressing a place where it cannot go makes hub/ emit `housing:placeRefused` and this screen show it as a
 *     toast **above** the inspector (`.sm-toast`) — the inspector and the toast stack in one `.sm-dock` at the bottom centre.
 *
 * **2026-09-12 2nd pass (user's decision — the cockpit · the upgrade section · the 시설 제거 hold):**
 *   - **The cockpit at the very top** of the room list (`COCKPIT_ROOM_INDEX`, no room number) — it has 가구 제작 /
 *     가구 창고 only and no 시설 제거. The head label on the right is the facility name alone. 용도 지정 walks
 *     `ROOM_PURPOSES_ASSIGNABLE` only (no 시뮬레이션실 · 휴식 공간).
 *   - A furniture card's materials sit under the name on **one line · at most four** (`CARD_COST_MAX`, `CARD_CHIP` px —
 *     보유/필요 fits inside the thumbnail). The 시설 가구 / 꾸밈용 가구 sub-tabs stand **in 가구 창고 too**.
 *   - The inspector's `위치 이동` button is gone (E · holding LMB does it — hub/ announces the cursor gauge with
 *     `housing:moveHold`). The bottom of the card is the **upgrade section**: `업그레이드 비용` · material chips + the
 *     facility level chip (`buildFacilityChip`) · `업그레이드`. It is clickable even when dimmed, and with too few
 *     materials it toasts `재료가 부족하여 업그레이드할 수 없습니다.`, otherwise that reason.
 *   - The confirm of the `시설 제거` (red) popup is a press of the red `시설 제거` for `UI_HOLD_CONFIRM_S` — the title is
 *     `{시설 이름} 제거`, and the chips handed back show the quantity only.
 *
 * **2026-09-08 (the tutorial hides instead of locking):** an entry for which
 * `ctx.tutorial.hides('roomPurpose' | 'furniture', id)` is true **leaves** the list — instead of keeping a row tagged
 * with a "튜토리얼에서는 ~" reason, only what can be built right now is shown (during the guide step, the 발전기 row +
 * the one 작업실 row). When the step moves on or the tutorial is skipped, `tutorial:changed` redraws the list and
 * everything that was hidden comes back.
 *
 * **2026-09-17 (user's decision — the craft modal · 가구 창고 red dots):**
 *   - A furniture card's `제작` (or a click on a card with nothing in storage) no longer crafts at once but opens the
 *     **craft modal** (`.sm-craft`) in the centre of the screen — the same thumbnail as the list (`.fcard-thumb`) ·
 *     `{furniture name} 제작` · every material chip under it (`renderItemCost`, 보유/필요 · `.is-short`) · pressing
 *     `제작` (`.sm-craft-ok`) at the bottom right for `UI_HOLD_CONFIRM_S` runs `craftFurniture` → `housing:changed
 *     {reason:'craft'}` (the tutorial's `bench` step moves on here). The modal holds the blocker · the cursor ·
 *     `ctx.escape` with `CRAFT_MODAL_TOKEN` — Escape · Tab · `취소` · a click on the backdrop close it. Enter is
 *     swallowed. A blocked card (재료 부족 · 이미 보유) still answers with its reason toast alone, as before.
 *   - **Red dots (session only, never saved):** a piece just made (`craftFurniture` succeeded) or recovered
 *     (`housing:furnitureRecovered`) goes into `dotPending` and puts a dot (`.sm-dot`) on the `가구 창고` tab. The moment
 *     the store list is visible (the tab is pressed, or it already was that tab) the tab's dot goes and a dot stands on
 *     the thumbnails of those furniture cards (`dotCards`). Closing the screen or placing that piece clears the card's
 *     dot. When a dot is hidden behind another sub-tab, a dot stands on that sub-tab too.
 */
export class ShipManage {
  readonly root: HTMLElement;
  private roomsEl: HTMLElement;
  private sideHead: HTMLElement;
  private clearBtn: HTMLButtonElement;
  private tabsEl: HTMLElement;
  private tabBtns = new Map<FurnTab, HTMLButtonElement>();
  /* 2026-09-12: 시설 가구 / 꾸밈용 가구 (inside the 가구 제작 tab), the 발전기 row under the room list, the toast of the bottom dock */
  private subtabsEl: HTMLElement;
  private kindBtns = new Map<FurnKind, HTMLButtonElement>();
  private kind: FurnKind = 'utility';
  private genEl: HTMLElement;
  private genKey = '';
  private toastEl: HTMLElement;
  private toastTimer = 0;
  private cardsEl: HTMLElement;
  private storeEl: HTMLElement;
  private purposesEl: HTMLElement;
  private emptyEl: HTMLElement;
  private rows: RoomRow[] = [];
  private cards: Card[] = [];
  private cardsKey = '';
  private storeKey = '';
  private purposeKey = '';
  private tab: FurnTab = readManageTab() ?? 'craft';   // 2026-09-15: the tab last seen (user's decision)
  private active = false;
  private room: number | null = null;
  private selected: string | null = null;
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  /* Phase 12: confirm popup */
  private confirmEl: HTMLElement;
  private confirmTitle: HTMLElement;
  private confirmBody: HTMLElement;
  private confirmCost: HTMLElement;
  private confirmCard: HTMLElement;
  /** 2026-09-15 2nd pass: the left-click hold keycap left of the label inside the 시설 제거 confirm button — detached on a confirm that is not a hold. */
  private confirmCap: HTMLElement;
  private confirmOk: HTMLButtonElement;
  private confirmOkText: HTMLElement;
  private confirmFill: HTMLElement;
  private confirmCancel: HTMLButtonElement;
  private confirmAction: (() => void) | null = null;
  private pendingPurpose: RoomPurpose | null = null;
  /* 2026-09-12: the 시설 제거 confirm is an irreversible one — the red `시설 제거` button must be held for `UI_HOLD_CONFIRM_S` */
  private confirmDanger = false;
  private holdStart = 0;
  private holdTimer = 0;
  private holdT = 0;
  private readonly onHoldUp = (): void => this.stopHold();
  /* B-13: the click inspector (modeless — it takes neither a blocker nor an escape token) */
  private inspectEl: HTMLElement;
  private inspectThumb: HTMLElement;
  private inspectGlyph: HTMLElement;
  private inspectName: HTMLElement;
  private inspectLv: HTMLElement;
  private inspectDesc: HTMLElement;
  /** 2026-09-13: the 조종석 전용 시설 line (shown only for `isCockpitOnlyFurniture` pieces). */
  private inspectLock: HTMLElement;
  /* 2026-09-12: the bottom upgrade section — `업그레이드 비용` · material + facility level chips · `업그레이드` */
  private inspectCost: HTMLElement;
  private inspectBtn: HTMLButtonElement;
  private inspectUid: string | null = null;
  /* 2026-09-17: the 가구 제작 modal (blocker · escape token `CRAFT_MODAL_TOKEN`) */
  private craftEl: HTMLElement;
  private craftThumb: HTMLElement;
  private craftGlyph: HTMLElement;
  private craftSize: HTMLElement;
  private craftTitle: HTMLElement;
  private craftCost: HTMLElement;
  private craftNote: HTMLElement;
  private craftCancel: HTMLButtonElement;
  private craftOk: HTMLButtonElement;
  private craftFill: HTMLElement;
  private craftDefId: string | null = null;
  private craftHoldStart = 0;
  private craftHoldTimer = 0;
  private craftHoldT = 0;
  private readonly onCraftHoldUp = (): void => this.stopCraftHold();
  /* 2026-09-17: 가구 창고 red dots (session only) — those up on the tab / those up on the cards */
  private dotPending = new Set<string>();
  private dotCards = new Set<string>();
  private storeTabDot: HTMLElement | null = null;
  private kindDots = new Map<FurnKind, HTMLElement>();

  private onKey = (e: KeyboardEvent): void => {
    if (this.isCraftOpen) {
      // 2026-09-17: the craft modal — Enter never confirms (it is swallowed), Tab closes the modal only (시설 관리 · the inventory behind it never see it).
      // Escape is not eaten here: this modal is the top of `ctx.escape`, so game/'s policy closes it first.
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.code === Keys.INVENTORY) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.ctx?.input.consume(Keys.INVENTORY);
        this.closeCraft(true);
      }
      return;
    }
    if (!this.isConfirmOpen) return;
    // 2026-09-12: Enter never makes an irreversible confirm (시설 제거) — it is only eaten (it does not press the focused 취소 either)
    if (this.confirmDanger && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.code !== Keys.MENU) return;
    // Capture phase on `window`: `Input`'s bubble listener never records this Escape, so neither the hub (leave
    // 시설 관리) nor game/ (pause) polls it. `consume` covers the case where Input already saw it this frame.
    e.preventDefault();
    e.stopImmediatePropagation();
    this.ctx?.input.consume(Keys.MENU);
    this.closeConfirm();
  };

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'ship-manage', parent });

    const rooms = el('div', { cls: 'sm-rooms interactive', parent: this.root });
    el('div', { cls: 'sm-title', text: '방 목록', parent: rooms });
    this.roomsEl = el('div', { cls: 'sm-room-list', parent: rooms });
    // 2026-09-12 (user's decision): the cockpit stands **always at the top**, rooms 1 … SHIP_ROOM_COUNT below it. The
    // cockpit is not a room — its number cell is empty (`.is-cockpit`) and `조종석` stands in the name's place.
    // `data-room` is the handle the smoke tests · the tutorial pick a row by.
    for (const i of [COCKPIT_ROOM_INDEX, ...Array.from({ length: SHIP_ROOM_COUNT }, (_, k) => k)]) {
      const cockpit = i === COCKPIT_ROOM_INDEX;
      const b = el('button', { cls: cockpit ? 'sm-room is-cockpit' : 'sm-room', parent: this.roomsEl });
      b.dataset.room = String(i);
      const thumbEl = el('div', { cls: 'sm-thumb', parent: b });
      const glyphEl = el('span', { cls: 'g', text: ROOM_PURPOSE_GLYPH[cockpit ? 'cockpit' : 'empty'], parent: thumbEl });
      if (!cockpit) el('span', { cls: 'n', text: `방 ${i + 1}`, parent: b });
      const purposeEl = el('span', { cls: 'p', text: cockpit ? ROOM_PURPOSE_LABEL_KO.cockpit : '—', parent: b });
      const countEl = el('span', { cls: 'c', text: '', parent: b });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickRoom(i); });
      this.rows.push({ index: i, root: b, thumbEl, glyphEl, purposeEl, countEl, key: '' });
    }
    // 2026-09-12: the 발전기 row is a whole-ship facility, so it lives under the room list (it left the 용도 지정 list)
    this.genEl = el('div', { cls: 'sm-gen-host', parent: rooms });

    const side = el('div', { cls: 'sm-side interactive', parent: this.root });
    const head = el('div', { cls: 'sm-side-head', parent: side });
    this.sideHead = el('div', { cls: 'sm-bar-head', text: '가구', parent: head });
    this.clearBtn = el('button', { cls: 'sm-clear', text: '시설 제거', parent: head });   // 2026-09-12: was 빈 방으로
    this.clearBtn.addEventListener('click', (e) => { e.stopPropagation(); this.clearRoom(); });
    // 가구 제작 / 가구 창고 tabs (hidden while an empty room shows the 용도 지정 picker)
    this.tabsEl = el('div', { cls: 'sm-tabs', parent: side });
    for (const [id, label] of [['craft', '가구 제작'], ['store', '가구 창고']] as ReadonlyArray<readonly [FurnTab, string]>) {
      const b = el('button', { cls: 'sm-tab', text: label, parent: this.tabsEl });
      b.dataset.tab = id;               // 2026-09-08: the handle the tutorial spotlight picks the '가구 창고' tab by
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickTab(id); });
      this.tabBtns.set(id, b);
      if (id === 'store') { this.storeTabDot = el('i', { cls: 'sm-dot', parent: b }); this.storeTabDot.hidden = true; }
    }
    // 2026-09-12: the sub-tabs inside 가구 제작 — 시설 가구 (furniture that does something on E) / 꾸밈용 가구
    this.subtabsEl = el('div', { cls: 'sm-subtabs', parent: side });
    for (const [id, label] of [['utility', '시설 가구'], ['decor', '꾸밈용 가구']] as ReadonlyArray<readonly [FurnKind, string]>) {
      const b = el('button', { cls: 'sm-subtab', text: label, parent: this.subtabsEl });
      b.dataset.kind = id;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickKind(id); });
      this.kindBtns.set(id, b);
      const dot = el('i', { cls: 'sm-dot', parent: b });
      dot.hidden = true;
      this.kindDots.set(id, dot);
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
    /* Phase 12: centred modeless confirm popup (purpose build / 발전기 upgrade). A child of the screen root, so it is
       gated with it; `.interactive` because the `.hud.housing` layer itself is pointer-events: none. */
    this.confirmEl = el('div', { cls: 'sm-confirm interactive', parent: this.root });
    this.confirmEl.hidden = true;
    const card = this.confirmCard = el('div', { cls: 'sm-confirm-card', parent: this.confirmEl });
    this.confirmTitle = el('div', { cls: 'title', text: '시설 증축', parent: card });
    this.confirmBody = el('div', { cls: 'body', parent: card });
    this.confirmCost = el('div', { cls: 'cost', parent: card });
    // 2026-09-15 (user's decision): the hover card of a material · facility thumbnail goes to the **top-left** of the
    // cursor (the same contract as `renderCostRow`). This calls `renderItemCost` directly, so the attribute is stamped
    // once — it stays even on a frame where the cost is empty.
    this.confirmCost.setAttribute(TIP_ANCHOR_ATTR, 'left');
    const acts = el('div', { cls: 'acts', parent: card });
    const cancel = this.confirmCancel = el('button', { cls: 'ui-btn', text: '취소', parent: acts });
    this.confirmOk = el('button', { cls: 'ui-btn primary sm-confirm-ok', parent: acts });
    // 2026-09-15 2nd pass (user's decision): instead of the old notice line (`.sm-confirm-hint`), the left-click hold
    // keycap left of the label inside the button says 「how to press it」 — attached only to a held confirm (= `danger`) (`openConfirm`).
    this.confirmCap = createHoldButtonCap();
    this.confirmFill = el('i', { cls: 'sm-hold-fill', parent: this.confirmOk });
    this.confirmOkText = el('span', { cls: 'sm-confirm-ok-t', text: '확인', parent: this.confirmOk });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); this.closeConfirm(true); });
    // 2026-09-12: a danger confirm (시설 제거) never runs on a click — only the `UI_HOLD_CONFIRM_S` hold below does
    this.confirmOk.addEventListener('click', (e) => { e.stopPropagation(); if (!this.confirmDanger) this.runConfirm(); });
    this.confirmOk.addEventListener('pointerdown', (e) => { if (this.confirmDanger && e.button === 0) { e.preventDefault(); this.startHold(); } });
    this.confirmOk.addEventListener('pointerleave', () => this.stopHold());
    // a click on the dimmed backdrop cancels, like the 함선 tab's popups
    this.confirmEl.addEventListener('mousedown', (e) => { if (e.target === this.confirmEl) this.closeConfirm(true); });

    /* 2026-09-17 (user's decision): the 가구 제작 modal — a centred thumbnail (the list's own `.fcard-thumb`) ·
       `{name} 제작` · material chips · a 1 s hold on `제작` at the bottom right. It reuses `.sm-confirm`'s plate as it is
       (z 79, above the tutorial spotlight). */
    this.craftEl = el('div', { cls: 'sm-confirm sm-craft interactive', parent: this.root });
    this.craftEl.hidden = true;
    const ccard = el('div', { cls: 'sm-confirm-card sm-craft-card', parent: this.craftEl });
    ccard.setAttribute('role', 'dialog');
    const chead = el('div', { cls: 'sm-craft-head', parent: ccard });
    this.craftThumb = el('div', { cls: 'fcard-thumb sm-craft-thumb', parent: chead });
    this.craftGlyph = el('span', { cls: 'fcard-glyph', text: '▨', parent: this.craftThumb });
    this.craftSize = el('span', { cls: 'fcard-size', text: '', parent: this.craftThumb });
    this.craftTitle = el('div', { cls: 'title sm-craft-title', text: '', parent: chead });
    el('div', { cls: 'sm-craft-label', text: '필요 재료', parent: ccard });
    this.craftCost = el('div', { cls: 'sm-craft-cost', parent: ccard });
    this.craftNote = el('div', { cls: 'sm-craft-note', text: '', parent: ccard });
    this.craftNote.hidden = true;
    const cacts = el('div', { cls: 'acts', parent: ccard });
    this.craftCancel = el('button', { cls: 'ui-btn', text: '취소', parent: cacts });
    this.craftOk = el('button', { cls: 'ui-btn primary sm-confirm-ok sm-craft-ok', parent: cacts });
    createHoldButtonCap(this.craftOk);
    this.craftFill = el('i', { cls: 'sm-hold-fill', parent: this.craftOk });
    el('span', { cls: 'sm-confirm-ok-t', text: '제작', parent: this.craftOk });
    this.craftCancel.addEventListener('click', (e) => { e.stopPropagation(); this.closeCraft(true); });
    // a click never crafts — only the `UI_HOLD_CONFIRM_S` hold does
    this.craftOk.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
    this.craftOk.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); this.startCraftHold(); } });
    this.craftOk.addEventListener('pointerleave', () => this.stopCraftHold());
    this.craftEl.addEventListener('mousedown', (e) => { if (e.target === this.craftEl) this.closeCraft(true); });

    /* B-13 (2026-09-11): the click inspector. It speaks the same box language as `.sm-confirm` but is a **modeless**
       card that does not cover the background — it stands at the bottom centre between the room list (left) · the
       furniture list (right), and the next piece can be clicked while the card is up. */
    /* 2026-09-12: the inspector and the toast above it stack in one column at the bottom centre (`.sm-dock`) — the toast is always right above the card */
    const dock = el('div', { cls: 'sm-dock', parent: this.root });
    this.toastEl = el('div', { cls: 'sm-toast', parent: dock });
    this.toastEl.hidden = true;
    this.inspectEl = el('div', { cls: 'sm-inspect interactive', parent: dock });
    this.inspectEl.hidden = true;
    const ihead = el('div', { cls: 'sm-ins-head', parent: this.inspectEl });
    this.inspectThumb = el('div', { cls: 'fcard-thumb', parent: ihead });
    this.inspectGlyph = el('span', { cls: 'fcard-glyph', text: '▨', parent: this.inspectThumb });
    const ititle = el('div', { cls: 'sm-ins-title', parent: ihead });
    this.inspectName = el('div', { cls: 'sm-ins-name', text: '', parent: ititle });
    this.inspectLv = el('div', { cls: 'sm-ins-lv ui-mono', text: '', parent: ititle });
    const ix = el('button', { cls: 'sm-ins-x', text: '✕', parent: ihead });
    ix.title = '닫기';
    ix.addEventListener('click', (e) => { e.stopPropagation(); this.setInspect(null, true); });
    this.inspectDesc = el('div', { cls: 'sm-ins-desc', text: '', parent: this.inspectEl });
    /* 2026-09-13 (user's decision): a cockpit-only facility (the implant bay · the computer) has no recovery · removal — the card says so in one line */
    this.inspectLock = el('div', { cls: 'sm-ins-desc sm-ins-lock', text: '조종석 전용 시설 — 조종석 안에서만 옮길 수 있고, 회수 · 제거할 수 없습니다.', parent: this.inspectEl });
    this.inspectLock.hidden = true;
    /* 2026-09-12 (user's decision): the `위치 이동` button is gone (E · holding LMB does it) and the bottom of the card
       is the **upgrade section** — `업그레이드 비용` at the far left · material chips + the facility level chip · `업그레이드` at the far right. */
    const upsec = el('div', { cls: 'sm-ins-upsec', parent: this.inspectEl });
    el('span', { cls: 'sm-ins-up-label', text: '업그레이드 비용', parent: upsec });
    this.inspectCost = el('div', { cls: 'sm-ins-cost', parent: upsec });
    this.inspectCost.setAttribute(TIP_ANCHOR_ATTR, 'left');   // 2026-09-15: the top-left card even on a frame with no materials (facility chips only)
    this.inspectBtn = el('button', { cls: 'sm-gen-btn sm-ins-up', text: '업그레이드', parent: upsec });
    this.inspectBtn.addEventListener('click', (e) => { e.stopPropagation(); this.upgradeInspected(); });

    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    window.addEventListener('keydown', this.onKey, true);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:shipManageChanged', ({ active, room }) => this.setActive(active, room)),
      b.on('housing:changed', () => { if (this.active) this.refresh(); }),
      // 2026-09-09: the 배치 button's fit check depends on what is on the floor and how big the room is — every
      // change to the room re-scans (the list memo carries the result, so an unchanged answer redraws nothing)
      // 2026-09-17: a placed piece's red dot goes · a recovered piece gets a 가구 창고 red dot (counted even while the screen is closed — session only)
      b.on('housing:furniturePlaced', ({ item }) => { this.clearDot(item.defId); if (this.active) this.refresh(); }),
      b.on('housing:furnitureMoved', () => { if (this.active) this.refresh(); }),
      b.on('housing:furnitureRecovered', ({ defId }) => { this.markNew(defId); if (this.active) this.refresh(); }),
      b.on('housing:facilityUpgraded', () => { if (this.active) this.refresh(); }),
      b.on('housing:roomPurposeChanged', () => { if (this.active) this.refresh(); }),
      b.on('housing:selectionChanged', ({ defId }) => this.markSelection(defId)),
      // B-13 (2026-09-11): hub/'s 시설 관리 raycast picked a placed piece (`uid: null` = empty floor → deselect).
      b.on('housing:furnitureSelected', ({ uid }) => this.setInspect(uid)),
      // 2026-09-12: a place where it cannot go (the toast above the inspector). The 위치 이동 button is gone, so `moveStateChanged` is no longer listened to
      b.on('housing:placeRefused', ({ reason }) => this.showToast(reason)),
      b.on('inventory:changed', () => { if (this.active) this.refresh(); }),
      b.on('inventory:stashChanged', () => { if (this.active) this.refresh(); }),
      b.on('game:newMission', () => this.setActive(false, null)),
      b.on('game:abort', () => this.setActive(false, null)),
      // 2026-09-08: when the tutorial moves its step on or is skipped, the purposes · furniture that were hidden appear again
      b.on('tutorial:changed', () => { if (this.active) this.refresh(); }),
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
  /** Phase 12: the confirm popup (purpose build or 발전기 upgrade) and the purpose it is asking about (debug). */
  get isConfirmOpen(): boolean { return !this.confirmEl.hidden; }
  get confirmPurpose(): RoomPurpose | null { return this.pendingPurpose; }
  /** B-13: the click inspector — whether it is up and which placed piece it describes (debug / smoke). */
  get isInspectOpen(): boolean { return !this.inspectEl.hidden; }
  get inspectedUid(): string | null { return this.inspectEl.hidden ? null : this.inspectUid; }
  /**
   * B-13: whether the inspector's 업그레이드 button would upgrade right now (debug / smoke). 2026-09-12: a blocked button
   * stays clickable (it answers with a toast), so "live" is the absence of `.is-disabled`, not the `disabled` attribute.
   */
  get canUpgradeInspected(): boolean {
    return !this.inspectEl.hidden && !this.inspectBtn.disabled && !this.inspectBtn.classList.contains('is-disabled');
  }
  /** 2026-09-12: whether the open confirm is the red 시설 제거 hold, and its hold fill 0 … 1 (debug / smoke). */
  get isConfirmDanger(): boolean { return this.isConfirmOpen && this.confirmDanger; }
  get confirmHoldProgress(): number { return this.holdT; }
  /** 2026-09-12: which 가구 제작 sub-tab is showing, and the refusal toast text while it is up (debug / smoke). */
  get craftKind(): FurnKind { return this.kind; }
  get toastText(): string | null { return this.toastEl.hidden ? null : this.toastEl.textContent; }
  /** 2026-09-17: the 가구 제작 modal — open, which def, hold fill 0 … 1 (debug / smoke). */
  get isCraftOpen(): boolean { return !this.craftEl.hidden; }
  get craftModalDefId(): string | null { return this.craftEl.hidden ? null : this.craftDefId; }
  get craftHoldProgress(): number { return this.craftHoldT; }
  /** 2026-09-17: 가구 창고 red dots — the tab dot's pending defs and the defs whose store cards carry a dot (debug / smoke). */
  get storeDotPending(): readonly string[] { return [...this.dotPending]; }
  get storeDotCards(): readonly string[] { return [...this.dotCards]; }

  /**
   * 2026-09-08 — an entry the tutorial blocks is **not drawn at all** rather than tagged with a reason. Only what can
   * be done right now is left in the list, so "why can't I" never arises (always false while the tutorial is off).
   */
  private tutHides(gate: 'roomPurpose' | 'furniture', id: string): boolean {
    return this.ctx?.tutorial?.hides(gate, id) ?? false;
  }

  /** The tutorial step mixed into the list cache key — a changed step changes the hidden set too. */
  private get tutKey(): string { return this.ctx?.tutorial?.step ?? '-'; }

  private setActive(active: boolean, room: number | null): void {
    const changed = active !== this.active || room !== this.room;
    this.active = active;
    this.room = active ? room : null;
    toggleClass(this.root, 'show', active);
    if (changed && this.isConfirmOpen) this.closeConfirm();
    if (changed && this.isCraftOpen) this.closeCraft();
    // B-13: the inspector describes one placed piece — a different room (or a closed screen) is a different subject
    if (changed) this.setInspect(null);
    if (!active) {
      // 2026-09-17 (user's decision): closing the window clears the cards' red dots (those still up on the tab stay)
      this.dotCards.clear();
      this.paintDots();
      this.selected = null;
      this.cardsKey = '';
      this.storeKey = '';
      this.purposeKey = '';
      this.genKey = '';
      this.hideToast();
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
    writeManageTab(tab);
    this.cardsEl.scrollTop = 0;
    this.storeEl.scrollTop = 0;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refreshSide();
  }

  /** 2026-09-12: the 시설 가구 / 꾸밈용 가구 sub-tabs of 가구 제작. */
  private pickKind(kind: FurnKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.cardsEl.scrollTop = 0;
    this.storeEl.scrollTop = 0;       // 2026-09-12: the 가구 창고 tab is filtered by the same sub-tab
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refreshSide();
  }

  /**
   * A 가구 제작 row: open the 제작 modal for it. 2026-09-17 (user's decision): nothing is crafted from the row any more —
   * the modal's `제작` hold (`craftNow`) is the only path. A blocked row still answers with its reason toast.
   */
  private craftCard(defId: string): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    // B-13 (2026-09-11): not only 재료 부족 but 「이미 보유 중입니다」 is caught here too — the source of the reason is housing/
    const block = this.craftBlock(defId);
    if (block) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: block, kind: 'warning' });
      return;
    }
    this.openCraft(defId);
  }

  /** The modal's hold finished: re-check (materials may have moved while it was up), craft, mark the store red dot. */
  private craftNow(defId: string): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const block = this.craftBlock(defId);
    if (block) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: block, kind: 'warning' });
      this.paintCraft();
      return;
    }
    // `craftFurniture` emits `housing:changed {reason:'craft'}` — the tutorial's `bench` step advances on it
    if (!housing.craftFurniture(defId)) { this.ctx.bus.emit('audio:play', { id: 'ui_deny' }); this.paintCraft(); return; }
    this.closeCraft();
    this.markNew(defId);
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    const def = housing.getFurnitureDef(defId);
    this.ctx.bus.emit('ui:notify', { text: `${def?.name ?? defId} 제작 완료 — 가구 창고에 있습니다`, kind: 'success' });
    this.refresh();
  }

  /* ── 2026-09-17: the 가구 제작 modal ──────────────────────────────── */
  private openCraft(defId: string): void {
    const ctx = this.ctx;
    const def = ctx.housing?.getFurnitureDef(defId);
    if (!def || !def.craft) return;
    this.stopCraftHold();
    this.craftDefId = defId;
    this.paintCraft();
    if (this.craftEl.hidden) {
      this.craftEl.hidden = false;
      ctx.uiBlockers.add(CRAFT_MODAL_TOKEN);
      ctx.input.setCursorMode(true, CRAFT_MODAL_TOKEN);
      ctx.escape.push(CRAFT_MODAL_TOKEN, () => { this.closeCraft(true); });
    }
    ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.craftCancel.focus({ preventScroll: true });   // the first focus of an irreversible confirm is 취소
  }

  /** Redraw the modal's thumbnail, title, material chips and blocked state for `craftDefId` (materials can change while open). */
  private paintCraft(): void {
    const housing = this.ctx.housing;
    const defId = this.craftDefId;
    const def = defId ? housing?.getFurnitureDef(defId) : undefined;
    if (!housing || !defId || !def) return;
    this.craftThumb.style.setProperty('--fc', def.color);
    setText(this.craftGlyph, MODEL_GLYPH[def.model] ?? '▨');
    setText(this.craftSize, `${def.cols}×${def.rows}`);
    setText(this.craftTitle, `${def.name} 제작`);
    this.craftCost.replaceChildren();
    if (def.craft && def.craft.length) this.renderCostRow(this.craftCost, def.craft, CRAFT_MODAL_CHIP);
    else el('span', { cls: 'item-chip-free', text: '재료 없음', parent: this.craftCost });
    const block = this.craftBlock(defId);
    // A material shortage is said by the chips with `.is-short`, so it is not written as text (the 2026-09-15 contract) — only another reason gets a line
    const short = (def.craft ?? []).some((c) => this.owned(c.defId) < c.qty);
    this.craftNote.hidden = !block || short;
    setText(this.craftNote, block ?? '');
    toggleClass(this.craftOk, 'is-disabled', !!block);
    this.craftOk.setAttribute('aria-disabled', block ? 'true' : 'false');
  }

  private closeCraft(sound = false): void {
    if (this.craftEl.hidden) return;
    this.stopCraftHold();
    this.craftEl.hidden = true;
    this.craftDefId = null;
    const ctx = this.ctx;
    if (ctx) {
      ctx.uiBlockers.delete(CRAFT_MODAL_TOKEN);
      ctx.input.setCursorMode(false, CRAFT_MODAL_TOKEN);
      ctx.escape.remove(CRAFT_MODAL_TOKEN);
      if (sound) ctx.bus.emit('audio:play', { id: 'ui_close' });
    }
    if (this.craftEl.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur?.();
  }

  /** `UI_HOLD_CONFIRM_S` hold on 제작 — `setInterval` + `performance.now()` like the 시설 제거 hold (rAF stalls headless). */
  private startCraftHold(): void {
    if (this.craftHoldTimer || this.craftEl.hidden || !this.craftDefId) return;
    const block = this.craftBlock(this.craftDefId);
    if (block) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: block, kind: 'warning' });
      return;
    }
    this.craftHoldStart = performance.now();
    this.craftHoldT = 0;
    this.craftOk.classList.add('is-holding');
    window.addEventListener('pointerup', this.onCraftHoldUp);
    window.addEventListener('pointercancel', this.onCraftHoldUp);
    this.ctx.bus.emit('audio:play', { id: 'ui_pickup' });
    this.craftHoldTimer = window.setInterval(() => {
      this.craftHoldT = Math.min(1, (performance.now() - this.craftHoldStart) / (Math.max(0.05, UI_HOLD_CONFIRM_S) * 1000));
      this.craftFill.style.width = `${(this.craftHoldT * 100).toFixed(1)}%`;
      if (this.craftHoldT >= 1) {
        const id = this.craftDefId;
        this.stopCraftHold();
        if (id) this.craftNow(id);
      }
    }, 16);
  }

  private stopCraftHold(): void {
    if (this.craftHoldTimer) { clearInterval(this.craftHoldTimer); this.craftHoldTimer = 0; }
    window.removeEventListener('pointerup', this.onCraftHoldUp);
    window.removeEventListener('pointercancel', this.onCraftHoldUp);
    this.craftHoldStart = 0;
    this.craftHoldT = 0;
    this.craftFill.style.width = '0%';
    this.craftOk.classList.remove('is-holding');
  }

  /* ── 2026-09-17: 가구 창고 red dots (session only) ─────────────── */
  /** Whether the 가구 창고 list is on screen right now (tab `store`, a room with a purpose, screen open). */
  private get storeShowing(): boolean {
    return this.active && this.tab === 'store' && !this.storeEl.hidden;
  }

  /** A piece just went into furniture storage (crafted / recovered). Seen at once if the store list is up, else the tab dot. */
  private markNew(defId: string): void {
    if (this.storeShowing) this.dotCards.add(defId);
    else this.dotPending.add(defId);
    this.paintDots();
  }

  /** That def was placed: its card dot goes; the tab dot too once none of it is left in storage. */
  private clearDot(defId: string): void {
    this.dotCards.delete(defId);
    if ((this.storedCounts().get(defId) ?? 0) <= 0) this.dotPending.delete(defId);
    this.paintDots();
  }

  /** The store list became visible: the tab dot is consumed and its defs move onto their cards. */
  private revealDots(): void {
    if (!this.dotPending.size) return;
    for (const id of this.dotPending) this.dotCards.add(id);
    this.dotPending.clear();
  }

  /** Paint the tab / sub-tab / card dots from the two sets (defs no longer in storage are dropped first). */
  private paintDots(): void {
    const stored = this.storedCounts();
    for (const set of [this.dotPending, this.dotCards]) {
      for (const id of [...set]) if ((stored.get(id) ?? 0) <= 0) set.delete(id);
    }
    if (this.storeTabDot) this.storeTabDot.hidden = this.dotPending.size === 0;
    const showing = this.storeShowing;
    const housing = this.ctx?.housing;
    for (const [kind, dot] of this.kindDots) {
      let on = false;
      if (showing && kind !== this.kind && housing) {
        for (const id of this.dotCards) {
          const def = housing.getFurnitureDef(id);
          if (def && isUtilityFurniture(def) === (kind === 'utility')) { on = true; break; }
        }
      }
      dot.hidden = !on;
    }
    if (!showing) return;
    for (const c of this.cards) {
      const on = this.dotCards.has(c.defId);
      let dot = c.root.querySelector<HTMLElement>('.fcard-thumb > .sm-dot');
      if (on && !dot) {
        const thumb = c.root.querySelector<HTMLElement>('.fcard-thumb');
        if (thumb) dot = el('i', { cls: 'sm-dot', parent: thumb });
      }
      if (dot) dot.hidden = !on;
    }
  }

  /** A 가구 제작 row with a piece in storage: arm it for ghost placement (housing refuses a def with nothing stored). */
  private pickCard(defId: string): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    housing.selectFurniture(this.selected === defId ? null : defId);
  }

  /**
   * A 가구 창고 row (2026-09-09): **select only** — highlight the card, nothing on the cursor. Placement from this
   * tab goes through the row's 배치 button (`placeCard`); clicking the row again clears the highlight.
   */
  private selectStoreCard(defId: string): void {
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.markSelection(this.selected === defId ? null : defId);
  }

  /**
   * First free cell for `defId` in `room`. **2026-09-10: the rule moved to housing/** (`HousingRef.findFreeSpot` →
   * `housing/Rules.autoPlaceSpot`) — rows are filled first from the screen's top left and the furniture faces the
   * screen's bottom. This screen only asks for the answer; the coordinate derivation and its reasoning live next to
   * the placement rules.
   * Null when nothing fits (or the def is refused in that room).
   */
  private findFreeSpot(room: number, defId: string): FreeSpot | null {
    return this.ctx.housing?.findFreeSpot(room, defId) ?? null;
  }

  /** The 배치 button: drop one stored piece on the first free cell of the current room (`findFreeSpot`). */
  private placeCard(defId: string): void {
    const housing = this.ctx.housing;
    const room = this.room;
    if (!housing || room === null) return;
    const def = housing.getFurnitureDef(defId);
    const spot = this.findFreeSpot(room, defId);
    if (!spot) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: `${def?.name ?? defId} — 이 방에 놓을 자리가 없습니다`, kind: 'warning' });
      this.refresh();
      return;
    }
    const placed = housing.place(room, defId, spot.x, spot.y, spot.yaw);
    if (!placed) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: `${def?.name ?? defId} 배치에 실패했습니다`, kind: 'warning' });
      this.refresh();
      return;
    }
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    this.ctx.bus.emit('ui:notify', { text: `${def?.name ?? defId} — 방 ${room + 1} 에 배치했습니다`, kind: 'success' });
    // `place` already emitted `housing:furniturePlaced` + `housing:changed`, which redraw the list; this covers a bus
    // that has no listener wired yet (dispose races) and costs nothing when the memo key is unchanged.
    this.refresh();
  }

  /**
   * A 용도 row was pressed. Blocked → the reason (already printed under the row) is repeated as a toast and the row
   * flashes; allowed → the confirm popup. Nothing is built from the row itself any more (Phase 12).
   */
  private pickPurpose(purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    const room = this.room;
    if (!housing || room === null) return;
    const blocked = housing.purposeBlock(room, purpose);
    if (blocked) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning' });
      const row = this.purposesEl.querySelector<HTMLElement>(`.sm-purpose[data-purpose="${purpose}"]`);
      if (row) restartAnim(row, 'flash');
      return;
    }
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.openConfirm(
      `방 ${room + 1} — ${ROOM_PURPOSE_LABEL_KO[purpose]} 증축`,
      `정말로 ${room + 1}번 방을 ${ROOM_PURPOSE_LABEL_KO[purpose]} 시설로 만들겠습니까? 재료는 가방과 함선 창고에서 함께 빠져나갑니다.`,
      housing.purposeCost(purpose),
      purpose,
      () => this.buildPurpose(room, purpose),
    );
  }

  /** 확인 on a purpose: re-check the rules (materials may have moved while the popup was up), then build. */
  private buildPurpose(room: number, purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const blocked = housing.purposeBlock(room, purpose);
    if (blocked) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning' });
    } else if (housing.setRoomPurpose(room, purpose)) {
      this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
      this.ctx.bus.emit('ui:notify', { text: `방 ${room + 1} → ${ROOM_PURPOSE_LABEL_KO[purpose]} 증축 완료`, kind: 'success' });
      this.tab = 'craft';
      this.kind = 'utility';
    } else {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: '증축에 실패했습니다', kind: 'danger' });
    }
    this.refresh();
  }

  /** The 발전기 row's 업그레이드 button: blocked → reason toast, else the confirm popup → `housing.upgrade`. */
  private pickGenerator(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const info = housing.getFacility('generator');
    if (info.blocked || !info.nextCost) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: info.blocked ?? '업그레이드할 수 없습니다', kind: 'warning' });
      return;
    }
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.openConfirm(
      `발전기 Lv.${info.level} → Lv.${info.level + 1}`,
      `발전기를 Lv.${info.level + 1} 로 업그레이드하겠습니까? 재료는 가방과 함선 창고에서 함께 빠져나갑니다.`,
      info.nextCost,
      null,
      () => {
        const ok = housing.upgrade('generator');
        this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
        this.ctx.bus.emit('ui:notify', ok
          ? { text: `발전기 Lv.${housing.getFacility('generator').level}`, kind: 'success' }
          : { text: housing.getFacility('generator').blocked ?? '업그레이드에 실패했습니다', kind: 'warning' });
        this.refresh();
      },
    );
  }

  /* ── Phase 12: confirm popup ─────────────────────────────────────────── */
  /**
   * `opts.refund` (2026-09-12): the chips are what the player **gets back**, so they show the returned quantity only
   * (`×N`) — a have/need split read as a shortage. `opts.danger`: the red `시설 제거` confirm — no click / Enter, only a
   * `UI_HOLD_CONFIRM_S` hold on the button; focus starts on 취소.
   */
  private openConfirm(
    title: string, body: string, cost: readonly CraftIngredient[], purpose: RoomPurpose | null, action: () => void,
    opts: { danger?: boolean; refund?: boolean; okText?: string; requirements?: readonly FacilityRequirement[] } = {},
  ): void {
    this.stopHold();
    setText(this.confirmTitle, title);
    setText(this.confirmBody, body);
    this.confirmCost.replaceChildren();
    if (cost.length && opts.refund) {
      this.confirmCost.classList.add('item-chips');
      for (const c of cost) this.confirmCost.appendChild(buildItemChip(this.itemDef(c.defId), { need: c.qty, size: 34 }));
    } else if (cost.length) {
      renderItemCost(this.confirmCost, cost, (id) => this.itemDef(id), (id) => this.owned(id), { size: 34 });
    } else {
      el('span', { cls: 'item-chip-free', text: '재료 없음', parent: this.confirmCost });
    }
    for (const r of opts.requirements ?? []) this.confirmCost.appendChild(this.facilityChip(r, 34));
    this.confirmDanger = !!opts.danger;
    toggleClass(this.confirmCard, 'is-danger', this.confirmDanger);
    if (this.confirmDanger) this.confirmOk.insertBefore(this.confirmCap, this.confirmFill);
    else this.confirmCap.remove();
    setText(this.confirmOkText, opts.okText ?? '확인');
    toggleClass(this.confirmOk, 'primary', !this.confirmDanger);
    toggleClass(this.confirmOk, 'sm-danger', this.confirmDanger);
    this.confirmAction = action;
    this.pendingPurpose = purpose;
    this.confirmEl.hidden = false;
    (this.confirmDanger ? this.confirmCancel : this.confirmOk).focus({ preventScroll: true });
  }

  private closeConfirm(sound = false): void {
    if (this.confirmEl.hidden) return;
    this.stopHold();
    this.confirmEl.hidden = true;
    this.confirmAction = null;
    this.pendingPurpose = null;
    this.confirmDanger = false;
    if (sound) this.ctx?.bus.emit('audio:play', { id: 'ui_close' });
  }

  private runConfirm(): void {
    const action = this.confirmAction;
    this.closeConfirm();
    action?.();
  }

  /**
   * 2026-09-12: the 시설 제거 hold. `setInterval` + `performance.now()` like `housing/ui/UpgradeModal` (rAF stalls in the
   * headless smokes); releasing anywhere, leaving the button or closing the popup resets it to zero.
   */
  private startHold(): void {
    if (!this.confirmDanger || this.holdTimer || this.confirmEl.hidden) return;
    this.holdStart = performance.now();
    this.holdT = 0;
    this.confirmOk.classList.add('is-holding');
    window.addEventListener('pointerup', this.onHoldUp);
    window.addEventListener('pointercancel', this.onHoldUp);
    this.ctx?.bus.emit('audio:play', { id: 'ui_pickup' });
    this.holdTimer = window.setInterval(() => {
      this.holdT = Math.min(1, (performance.now() - this.holdStart) / (Math.max(0.05, UI_HOLD_CONFIRM_S) * 1000));
      this.confirmFill.style.width = `${(this.holdT * 100).toFixed(1)}%`;
      if (this.holdT >= 1) { this.stopHold(); this.runConfirm(); }
    }, 16);
  }

  private stopHold(): void {
    if (this.holdTimer) { clearInterval(this.holdTimer); this.holdTimer = 0; }
    window.removeEventListener('pointerup', this.onHoldUp);
    window.removeEventListener('pointercancel', this.onHoldUp);
    this.holdStart = 0;
    this.holdT = 0;
    this.confirmFill.style.width = '0%';
    this.confirmOk.classList.remove('is-holding');
  }

  /**
   * One 시설 레벨 요구 chip (`shared/itemChip.buildFacilityChip`).
   *
   * 2026-09-15 (user's decision): the chip draws **only an icon, like an item chip** — the facility name that used to
   * be written inside the thumbnail is gone (the shape is the `.facility-chip` rule of `housing/housing.css`), and the
   * name · the required level are said by the tooltip that appears on hovering the thumbnail (`data-fc-tip`). The text
   * is the same sentence as housing's `facilityChipTip` (no cross-folder imports, so the one line is copied over).
   */
  private facilityChip(r: FacilityRequirement, size: number): HTMLElement {
    const chip = buildFacilityChip(FACILITY_LABEL_KO[r.facility], FACILITY_GLYPH[r.facility], FACILITY_COLOR[r.facility], r.have, r.need, { size });
    const text = `${FACILITY_LABEL_KO[r.facility]} — Lv.${r.need} 필요 (현재 Lv.${r.have})`;
    chip.dataset.fcTip = text;
    chip.title = text;
    return chip;
  }

  /* ── B-13 (2026-09-11): the click inspector ─────────────────────── */

  /**
   * The only consumer of `housing:furnitureSelected`. When `uid` is not a placed piece (it was taken away · it is in
   * another room) the card goes down — disappearing is more honest than drawing a missing piece as 「Lv.0」.
   */
  private setInspect(uid: string | null, sound = false): void {
    const was = this.inspectUid;
    this.inspectUid = uid;
    if (!uid) {
      if (!this.inspectEl.hidden) {
        this.inspectEl.hidden = true;
        if (sound) this.ctx?.bus.emit('audio:play', { id: 'ui_close' });
      }
      return;
    }
    if (uid !== was) this.ctx?.bus.emit('audio:play', { id: 'ui_click' });
    this.refreshInspect();
  }

  /**
   * Redraws the one card. `refresh()` calls it every time, so when materials arrive or an upgrade finishes the cost
   * chips · the reason · the button follow by themselves (the card is small enough to have no memo key — unlike the
   * list it holds fewer than ten elements).
   */
  private refreshInspect(): void {
    const housing = this.ctx.housing;
    const uid = this.inspectUid;
    if (!housing || !uid) { if (!this.inspectEl.hidden) this.inspectEl.hidden = true; return; }
    const piece = housing.getPlacedByUid(uid);
    const def = piece ? housing.getFurnitureDef(piece.defId) : undefined;
    if (!piece || !def) { this.inspectUid = null; this.inspectEl.hidden = true; return; }

    this.inspectEl.hidden = false;
    this.inspectThumb.style.setProperty('--fc', def.color);
    setText(this.inspectGlyph, MODEL_GLYPH[def.model] ?? '▨');
    setText(this.inspectName, def.name);
    setText(this.inspectLv, `Lv.${piece.level} / ${def.maxLevel}`);
    setText(this.inspectDesc, def.description);
    this.inspectLock.hidden = !isCockpitOnlyFurniture(def);

    // 2026-09-12 (user's decision): the bottom upgrade section — material chips + the unmet facility level chip, and
    // `업그레이드` on the right. The button is clickable even when blocked (dimmed + `aria-disabled`) — pressing it
    // makes the toast above the inspector say why.
    const cost = this.upgradeCost(uid);
    const reason = this.upgradeBlock(uid);
    this.inspectCost.replaceChildren();
    if (!cost) {
      el('span', { cls: 'item-chip-free', text: def.maxLevel <= 1 ? '업그레이드할 수 없는 가구' : '최대 레벨', parent: this.inspectCost });
    } else {
      if (cost.length) this.renderCostRow(this.inspectCost, cost, 34);
      else el('span', { cls: 'item-chip-free', text: '재료 없음', parent: this.inspectCost });
      for (const r of this.upgradeRequirements(uid)) this.inspectCost.appendChild(this.facilityChip(r, 34));
    }
    const blocked = !!reason;
    setText(this.inspectBtn, cost ? '업그레이드' : '최대');
    this.inspectBtn.disabled = !cost;
    toggleClass(this.inspectBtn, 'is-disabled', !!cost && blocked);
    this.inspectBtn.setAttribute('aria-disabled', !cost || blocked ? 'true' : 'false');
    this.inspectBtn.title = reason ?? (cost ? `${def.name} Lv.${piece.level + 1}` : '최대 레벨');
  }

  /**
   * 2026-09-12: the unmet facility level requirement (the generator). The contract query
   * `furnitureUpgradeRequirements` is the source; with no implementation yet, the same answer is built from housing/'s
   * rule 「raising a piece to Lv.n needs the generator at Lv.n or above」.
   */
  private upgradeRequirements(uid: string): readonly FacilityRequirement[] {
    const housing = this.ctx.housing;
    if (!housing) return [];
    if (typeof housing.furnitureUpgradeRequirements === 'function') {
      try { return housing.furnitureUpgradeRequirements(uid); } catch { /* fall through */ }
    }
    const piece = housing.getPlacedByUid(uid);
    if (!piece || !this.upgradeCost(uid)) return [];
    const have = housing.getFacility('generator').level, need = piece.level + 1;
    return have < need ? [{ facility: 'generator', have, need }] : [];
  }

  /**
   * 2026-09-12: the unmet facility level requirement of a 시설 증축 — with no contract query, that purpose's generator gate.
   * 2026-09-13 (power allocation dropped): the gate differs per purpose — the level each one needs is `purposeGeneratorLevel`.
   */
  private purposeRequirements(purpose: RoomPurpose): readonly FacilityRequirement[] {
    const housing = this.ctx.housing;
    if (!housing) return [];
    if (typeof housing.purposeRequirements === 'function') {
      try { return housing.purposeRequirements(purpose); } catch { /* fall through */ }
    }
    const have = housing.getFacility('generator').level, need = purposeGeneratorLevel(purpose);
    return have < need ? [{ facility: 'generator', have, need }] : [];
  }

  /**
   * A cost row of item chips (2026-09-12): the 보유 count is capped at `99+` so the `보유/필요` strip inside a
   * `CARD_CHIP` thumbnail never sticks out of it (the numbers themselves are unchanged — only the label).
   */
  private renderCostRow(host: HTMLElement, cost: readonly CraftIngredient[], size: number): void {
    renderItemCost(host, cost, (id) => this.itemDef(id), (id) => this.owned(id), { size });
    // 2026-09-14 (user's decision): the hover card of a 필요 아이템 row goes to the **top-left** of the cursor
    // (`ui/hud/ItemTip.TIP_ANCHOR_ATTR`) — these rows sit low on the screen, so at the default place (bottom-right) the
    // card overflowed, flipped upwards only and covered the chip.
    host.setAttribute(TIP_ANCHOR_ATTR, 'left');
    for (const h of host.querySelectorAll<HTMLElement>('.item-chip-have')) {
      if (Number(h.textContent) > 99) h.textContent = '99+';
    }
  }

  /** 2026-09-12: the toast above the inspector (`housing:placeRefused`). The same sentence arriving again flashes again. */
  private showToast(text: string): void {
    if (!this.active) return;
    setText(this.toastEl, text);
    this.toastEl.hidden = false;
    restartAnim(this.toastEl, 'flash');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.hideToast(), TOAST_MS);
  }

  private hideToast(): void {
    clearTimeout(this.toastTimer);
    this.toastTimer = 0;
    this.toastEl.hidden = true;
  }

  /**
   * The 업그레이드 button. It is not an irreversible confirm, so there is neither a 1 s hold nor a confirm popup (the
   * same as GrowStation's 강화 row). 2026-09-12 (user's decision): a dimmed button is clickable too — with too few
   * materials the toast above the inspector reads `재료가 부족하여 업그레이드할 수 없습니다.`, and any other reason
   * (the generator level …) is shown in the same place.
   */
  private upgradeInspected(): void {
    const housing = this.ctx.housing;
    const uid = this.inspectUid;
    if (!housing || !uid) return;
    const cost = this.upgradeCost(uid);
    if (!cost) return;                               // max level — the button is really disabled then
    const reason = this.upgradeBlock(uid);
    if (reason) {
      const short = cost.some((c) => this.owned(c.defId) < c.qty);
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.showToast(short ? SHORT_UPGRADE_TEXT : reason);
      this.refreshInspect();
      return;
    }
    const ok = housing.upgradeFurniture(uid);
    const piece = housing.getPlacedByUid(uid);
    const name = piece ? housing.getFurnitureDef(piece.defId)?.name ?? piece.defId : '가구';
    this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
    this.ctx.bus.emit('ui:notify', ok
      ? { text: `${name} Lv.${piece?.level ?? '?'}`, kind: 'success' }
      : { text: this.upgradeBlock(uid) ?? '강화에 실패했습니다', kind: 'warning' });
    // Redraw the room list · the furniture list · the card together (materials left, so a craft card's reason can differ)
    this.refresh();
  }

  /**
   * The contract's three queries (2026-09-11) **may be implemented late** in housing/ (the folders are built
   * separately). Rather than the whole screen dying then, the same answer is built from the queries that were always
   * there — once the implementation lands it is used by itself.
   */
  private upgradeCost(uid: string): readonly CraftIngredient[] | null {
    const housing = this.ctx.housing;
    if (!housing) return null;
    if (typeof housing.furnitureUpgradeCost === 'function') {
      try { return housing.furnitureUpgradeCost(uid); } catch { /* fall through */ }
    }
    const piece = housing.getPlacedByUid(uid);
    const def = piece ? housing.getFurnitureDef(piece.defId) : undefined;
    if (!piece || !def || piece.level >= def.maxLevel) return null;
    return def.upgradeCost[piece.level - 1] ?? [];
  }

  private upgradeBlock(uid: string): string | null {
    const housing = this.ctx.housing;
    if (!housing) return '함선을 읽을 수 없습니다';
    if (typeof housing.furnitureUpgradeBlock === 'function') {
      try { return housing.furnitureUpgradeBlock(uid); } catch { /* fall through */ }
    }
    return this.upgradeCost(uid) ? null : '최대 레벨입니다';
  }

  /**
   * A craft card's refusal reason. On top of a material shortage it locks **a utility piece already owned**
   * (`isUtilityFurniture`) — every judgement lives inside housing/'s `furnitureCraftBlock` and this screen only draws
   * the answer.
   */
  private craftBlock(defId: string): string | null {
    const housing = this.ctx.housing;
    if (!housing) return null;
    if (typeof housing.furnitureCraftBlock === 'function') {
      try { return housing.furnitureCraftBlock(defId); } catch { /* fall through */ }
    }
    const info = housing.canCraftFurniture(defId);
    // 2026-09-15 (user's decision): the missing materials are **not written out as text** — the material chips say it themselves with `.is-short`
    return info.ok ? null : '재료 부족';
  }

  /**
   * Header 시설 제거: give the room back. Placed pieces go to the 가구 창고 and **every material the facility ever
   * cost comes back into the 함선 창고**.
   *
   * 2026-09-08: this used to call `setRoomPurpose(room, 'empty')` straight, which is the *free* path housing takes
   * **after** it has already worked out a refund — so clearing a room from here silently burned the 시설 증축 price
   * and the player could not rebuild what they had just torn down by mistake. It goes through
   * `HousingRef.removeRoomFacility` now (the same call the Tab 함선 tab's 🗑 makes), and because the mistake is the
   * whole story it asks first, showing the chips it is about to hand back.
   */
  private clearRoom(): void {
    const housing = this.ctx.housing;
    const room = this.room;
    if (!housing || room === null || room === COCKPIT_ROOM_INDEX) return;
    const blocked = housing.purposeBlock(room, 'empty');
    if (blocked) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning' });
      return;
    }
    const label = ROOM_PURPOSE_LABEL_KO[this.purposeOf(room)];
    const placed = housing.getPlaced(room).length;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    // 2026-09-12 (user's decision): the title is `{시설 이름} 제거`, the chips handed back show the quantity only, and the confirm is a 1 s hold on the red `시설 제거`
    this.openConfirm(
      `${label} 제거`,
      `정말로 ${label} 시설을 제거하겠습니까?${placed > 0 ? ` 놓인 가구 ${placed}개는 가구 창고로 돌아갑니다.` : ''} 들어간 재료는 전부 함선 창고로 돌려받습니다.`,
      housing.facilityRefund(room),
      null,
      () => this.emptyRoom(room, label),
      { danger: true, refund: true, okText: '시설 제거' },
    );
  }

  /** The 시설 제거 confirm: `removeRoomFacility` refunds 100 % into the 함선 창고 (or refuses with a Korean reason). */
  private emptyRoom(room: number, label: string): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const reason = housing.removeRoomFacility(room);
    if (reason) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: reason, kind: 'warning' });
    } else {
      this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
      this.ctx.bus.emit('ui:notify', { text: `${label} — 시설을 제거하고 재료를 함선 창고로 돌려보냈습니다`, kind: 'success' });
    }
    this.refresh();
  }

  /**
   * 2026-09-12: purpose of a list index — the cockpit is not in `ShipState.rooms`, so it is `'cockpit'` even while
   * housing/ has not learned `getRoom(COCKPIT_ROOM_INDEX)` yet.
   */
  private purposeOf(index: number): RoomPurpose {
    if (index === COCKPIT_ROOM_INDEX) return 'cockpit';
    return this.ctx.housing?.getRoom(index)?.purpose ?? 'empty';
  }

  /* ── render ──────────────────────────────────────────────────────────── */
  private refresh(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    for (const r of this.rows) {
      const purpose = this.purposeOf(r.index);
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
    this.refreshGenerator();
    this.refreshSide();
    // B-13: the inspector rides the same single pass — the card follows when the materials · the level · the piece's existence change
    this.refreshInspect();
    // 2026-09-17: an open craft modal's material chips · blocked state ride the same pass too (they follow as materials arrive or leave)
    if (this.isCraftOpen) this.paintCraft();
  }

  private refreshSide(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const room = this.room;
    const purpose = room !== null ? this.purposeOf(room) : 'empty';
    const assigning = room !== null && purpose === 'empty';
    const cockpit = room === COCKPIT_ROOM_INDEX;

    // 2026-09-12 (user's decision): the head label is the facility name alone — `가구 · 방 N — 작업실` → `작업실`
    setText(this.sideHead, room === null ? '가구' : assigning ? '용도 지정' : ROOM_PURPOSE_LABEL_KO[purpose]);
    // 시설 제거 is only offered on an assigned room the rules allow to go back to 빈 방 — never on the cockpit
    this.clearBtn.hidden = room === null || assigning || cockpit || !!housing.purposeBlock(room, 'empty');

    this.purposesEl.hidden = !assigning;
    this.tabsEl.hidden = assigning || room === null;
    for (const [id, b] of this.tabBtns) toggleClass(b, 'is-on', id === this.tab);
    // 2026-09-12: the 시설 가구 / 꾸밈용 가구 sub-tabs stand in 가구 창고 too
    this.subtabsEl.hidden = assigning || room === null;
    for (const [id, b] of this.kindBtns) toggleClass(b, 'is-on', id === this.kind);
    if (assigning) {
      this.cardsEl.hidden = true;
      this.storeEl.hidden = true;
      this.emptyEl.hidden = true;
      this.refreshPurposes(room as number);
      return;
    }
    this.cardsEl.hidden = this.tab !== 'craft';
    this.storeEl.hidden = this.tab !== 'store';
    if (this.tab === 'craft') { this.refreshCards(room, purpose); this.paintDots(); }
    else {
      // 2026-09-17: the moment the store list is visible the tab's red dot goes and moves onto those furniture cards
      if (this.active && room !== null) this.revealDots();
      this.refreshStore(room, purpose);
      this.paintDots();
    }
  }

  /** A purpose some **other** room of the ship already has (2026-09-12: every purpose is one per ship). */
  private builtElsewhere(room: number, p: RoomPurpose): boolean {
    const housing = this.ctx.housing;
    if (!housing) return false;
    for (let i = 0; i < SHIP_ROOM_COUNT; i++) if (i !== room && housing.getRoom(i)?.purpose === p) return true;
    return false;
  }

  /**
   * The 발전기 row under the 방 목록 (2026-09-12 — it used to lead the 용도 지정 picker). Level, next cost chips and
   * 업그레이드 → the confirm popup → `ctx.housing.upgrade('generator')`.
   * 2026-09-13 (user's decision — power allocation dropped): the generator starts at Lv.1, so the 「가동」 hint (`is-hint`) and the power panel under
   * this row are gone.
   * 2026-09-14 (user's decision): the **per-level unlock list** (`.sm-gen-unlocks`) attached then was removed too — the
   * row became a five-line table and pushed the room list out. 「this purpose needs the generator at Lv.n」 is said right
   * there by the 발전기 chip of the 용도 지정 card.
   */
  private refreshGenerator(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const gen = housing.getFacility('generator');
    const key = `g${gen.level}/${gen.maxLevel}|${gen.blocked ?? ''}|${this.costKeyOf(gen.nextCost)}`;
    if (key === this.genKey) return;
    this.genKey = key;
    this.genEl.replaceChildren();
    const g = el('div', { cls: `sm-gen${gen.blocked && gen.nextCost ? ' is-blocked' : ''}`, parent: this.genEl });
    const head = el('div', { cls: 'hd', parent: g });
    const gthumb = el('div', { cls: 'sm-thumb', parent: head });
    gthumb.style.setProperty('--pc', FACILITY_COLOR.generator);
    el('span', { cls: 'g', text: FACILITY_GLYPH.generator, parent: gthumb });
    const gline = el('div', { cls: 'ln', parent: head });
    el('span', { cls: 'nm', text: '발전기', parent: gline });
    el('span', { cls: 'lv ui-mono', text: `Lv.${gen.level} / ${gen.maxLevel}`, parent: gline });
    const gbtn = el('button', { cls: 'sm-gen-btn', text: gen.nextCost ? '업그레이드' : '최대', parent: head });
    gbtn.disabled = !gen.nextCost;
    gbtn.title = gen.blocked ?? `발전기 Lv.${gen.level + 1}`;
    gbtn.addEventListener('click', (e) => { e.stopPropagation(); this.pickGenerator(); });
    if (gen.nextCost) {
      const gcost = el('div', { cls: 'sm-cost', parent: g });
      this.renderCostRow(gcost, gen.nextCost, 24);
    }
    // 2026-09-14 (user's decision): the per-level **unlock list** (`.sm-gen-unlocks`) was removed — the 발전기 row became
    // a five-line table and pushed the room list out, and the same information is said by the **generator level chip**
    // of the 용도 지정 card (`buildFacilityChip`, `refreshPurposes`) right where that purpose is chosen. The CSS went with it.
    const genNote = gen.blocked && gen.nextCost ? gen.blocked : gen.nextCost ? '' : '최대 레벨';
    if (genNote) el('div', { cls: 'sm-block', text: genNote, parent: g });
  }

  /**
   * 용도 지정 buttons for an empty room — **purposes the ship already has are not drawn at all** (2026-09-12), the rest
   * are sorted 제작 가능 → 제작 불가, each led by the shared facility thumbnail (`ROOM_PURPOSE_GLYPH` /
   * `ROOM_PURPOSE_COLOR`) and followed by the **materials the 시설 증축 costs** as `.item-chip`s. A blocked purpose
   * keeps the Korean reason as its title and as a short line under the name.
   */
  private refreshPurposes(room: number): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const entries = ASSIGNABLE
      .filter((p) => !this.tutHides('roomPurpose', p) && !this.builtElsewhere(room, p))
      .map((p) => {
        const blocked = housing.purposeBlock(room, p);
        return { p, blocked, rank: blocked ? 1 : 0, cost: housing.purposeCost(p), reqs: this.purposeRequirements(p) };
      });
    entries.sort((a, b) => a.rank - b.rank || ASSIGNABLE.indexOf(a.p) - ASSIGNABLE.indexOf(b.p));
    const key = `${room}|t${this.tutKey}|`
      + entries.map((e) => `${e.p}${e.rank}${e.blocked ?? ''}${this.costKeyOf(e.cost)}${e.reqs.map((r) => `${r.facility}${r.have}/${r.need}`).join('')}`).join(',');
    if (key === this.purposeKey) return;
    this.purposeKey = key;
    this.purposesEl.replaceChildren();

    for (const { p, blocked, rank, cost, reqs } of entries) {
      const b = el('button', { cls: `sm-purpose rank-${rank}`, parent: this.purposesEl });
      b.dataset.purpose = p;
      const thumb = el('div', { cls: 'sm-thumb', parent: b });
      thumb.style.setProperty('--pc', ROOM_PURPOSE_COLOR[p]);
      el('span', { cls: 'g', text: ROOM_PURPOSE_GLYPH[p], parent: thumb });
      const body = el('div', { cls: 'bd', parent: b });
      const line = el('div', { cls: 'ln', parent: body });
      el('span', { cls: 'nm', text: ROOM_PURPOSE_LABEL_KO[p], parent: line });
      if (!ROOM_PURPOSES_ACTIVE.includes(p)) el('span', { cls: 'badge', text: '다음 업데이트', parent: line });
      const costEl = el('div', { cls: 'sm-cost', parent: body });
      this.renderCostRow(costEl, cost, 24);
      // 2026-09-12 (user's decision): the generator level requirement is not a sentence but a wide double-bordered chip on the same row as the material chips
      for (const r of reqs) costEl.appendChild(this.facilityChip(r, 24));
      // Phase 12: the reason is printed, not tucked into a tooltip, and the row stays clickable (→ toast + flash)
      if (blocked) el('div', { cls: 'sm-block', text: blocked, parent: body });
      toggleClass(b, 'is-blocked', !!blocked);
      b.setAttribute('aria-disabled', blocked ? 'true' : 'false');
      b.title = blocked ?? `${ROOM_PURPOSE_LABEL_KO[p]} 증축`;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickPurpose(p); });
      // 2026-09-15 (user's decision): a **`시설 증축` button** at the right of the row — the same place · the same grain
      // as a furniture card's `제작` · `배치`. No new path is made: it goes **exactly** where pressing the row goes,
      // `pickPurpose` → the confirm popup → `setRoomPurpose` (clickable even when blocked — the reason toast + the row
      // flash answer just the same).
      const build = el('button', { cls: 'sm-purpose-build', text: '시설 증축', parent: b });
      build.title = blocked ?? `${ROOM_PURPOSE_LABEL_KO[p]} 증축`;
      build.setAttribute('aria-disabled', blocked ? 'true' : 'false');
      toggleClass(build, 'is-disabled', !!blocked);
      build.addEventListener('click', (e) => { e.stopPropagation(); this.pickPurpose(p); });
    }
  }

  /**
   * 가구 제작 tab: one row per furniture def the room accepts **of the chosen sub-tab** (2026-09-12: 시설 가구 =
   * `isUtilityFurniture`, 꾸밈용 가구 = the rest) — cost chips + a 제작 button. A utility piece the ship already owns
   * (placed anywhere or in storage) shows **`이미 보유 중`** on its disabled button instead of a note line, and utility
   * cards never show an owned count (you only ever have one).
   */
  private refreshCards(room: number | null, purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const stored = this.storedCounts();
    const placedIds = new Set(housing.getPlaced().map((f) => f.defId));
    const kind = this.kind;
    // B-13 (2026-09-11): what can be made on top, what carries a refusal reason at the bottom (the same grain as the
    // 용도 지정 picker). `sort` is stable, so within one rank the catalogue order is left as it is.
    const defs = housing.getFurnitureFor(purpose)
      .filter((d) => !this.tutHides('furniture', d.id) && (kind === 'utility') === isUtilityFurniture(d))
      .map((d) => {
        const utility = isUtilityFurniture(d);
        // 2026-09-14: **a piece built several times over (`multi`) is never 「이미 보유 중」** — the bookshelf · chair ·
        // sofa · disc stand · record rack · game disc stand · compute cluster. The rules side
        // (`housing/parts/Furniture.furnitureCraftBlock`) had been looking at `!def.multi` since 2026-09-13, but only
        // this screen did not, so the button of a piece that could be made was locked.
        const have = utility && !d.multi && (placedIds.has(d.id) || (stored.get(d.id) ?? 0) > 0);
        return { def: d, block: this.craftBlock(d.id), utility, have };
      });
    defs.sort((a, b) => Number(!!a.block) - Number(!!b.block));

    // Rebuild only when the visible content actually changed (sub-tab / room / def list / storage / 보유 / material
    // counts / tutorial step / **the refusal reason** — when materials arrive and the reason goes, the card must lose
    // its dim and rise up the list).
    const key = `craft|${kind}|${room}|${purpose}|t${this.tutKey}|`
      + defs.map(({ def: d, block, have }) => `${d.id}:${stored.get(d.id) ?? 0}:${have ? 1 : 0}:${this.costKey(d)}:${block ?? ''}`).join(',');
    if (key === this.cardsKey) { this.markSelection(this.selected); return; }
    this.cardsKey = key;

    this.cardsEl.replaceChildren();
    this.cards = [];
    this.emptyEl.hidden = defs.length > 0;
    if (!defs.length) setText(this.emptyEl, kind === 'utility' ? '이 방에 설치할 수 있는 시설 가구가 없습니다' : '이 방에 설치할 수 있는 꾸밈용 가구가 없습니다');
    for (const { def, block, utility, have } of defs) {
      const owned = stored.get(def.id) ?? 0;
      const card = el('button', { cls: `fcard${block ? ' is-locked' : ''}${have ? ' is-owned' : ''}`, parent: this.cardsEl });
      card.dataset.defId = def.id;      // 2026-09-08: the handle the tutorial spotlight · the smokes pick a card by
      card.style.setProperty('--fc', def.color);
      card.title = block ? `${def.name} — ${block}` : `${def.name}\n${def.description}`;
      const thumb = el('div', { cls: 'fcard-thumb', parent: card });
      el('span', { cls: 'fcard-glyph', text: MODEL_GLYPH[def.model] ?? '▨', parent: thumb });
      el('span', { cls: 'fcard-size', text: `${def.cols}×${def.rows}`, parent: thumb });
      const body = el('div', { cls: 'fcard-body', parent: card });
      el('div', { cls: 'fcard-name', text: def.name, parent: body });
      // 2026-09-12 (user's decision): the material row is its own grid row under the name — ≤ `CARD_COST_MAX` chips on one
      // line, `CARD_CHIP` px each so the 보유/필요 strip fits inside the thumbnail. A piece that cannot be crafted
      // (공용 시설 가구 — 시술대 · 컴퓨터, `craft` null) says so instead of the 무료 a null cost would render.
      const cost = el('div', { cls: 'fcard-cost', parent: card });
      if (def.craft) this.renderCostRow(cost, def.craft.slice(0, CARD_COST_MAX), CARD_CHIP);
      else el('span', { cls: 'fcard-nocraft', text: '제작 불가', parent: cost });
      // 2026-09-12: the owned count is for 꾸밈용 가구 only (there is only ever one 시설 가구, so there is no reason to count)
      if (!utility) {
        const own = el('div', { cls: 'fcard-own', text: `보유 ${owned}`, parent: body });
        toggleClass(own, 'none', owned <= 0);
      }
      toggleClass(card, 'is-empty', owned <= 0 && !have);
      // As Phase 12 taught, the reason is **printed** — except that 「이미 보유 중」 is said by the button's text instead (2026-09-12)
      if (block && !have) el('div', { cls: 'fcard-note is-locked', text: block, parent: body });
      // the row selects a stored piece for placement; the 제작 button spends materials for a new one
      card.addEventListener('click', (e) => { e.stopPropagation(); if (owned > 0) this.pickCard(def.id); else this.craftCard(def.id); });
      // 2026-09-17: this button opens the craft modal — the actual craft is the modal's 1 s hold on `제작` (.sm-craft-ok)
      const make = el('button', { cls: 'fcard-craft', text: have ? '이미 보유 중' : def.craft ? '제작' : '제작 불가', parent: card });
      make.disabled = !!block || !def.craft;
      make.title = block ?? (def.craft ? `${def.name} 제작` : `${def.name} — 제작할 수 없는 가구입니다`);
      make.addEventListener('click', (e) => { e.stopPropagation(); this.craftCard(def.id); });
      this.cards.push({ defId: def.id, root: card });
    }
    this.markSelection(this.selected);
  }

  /**
   * 가구 창고 tab: everything in furniture storage. Pieces this room accepts come first; the rest follow, dimmed and
   * disabled, so the player can still see what the ship owns without switching rooms. 2026-09-09: a row click only
   * selects (highlight), the row's **배치** button (`.fcard-place`) places on the first free cell (`findFreeSpot`)
   * and is disabled — with `자리 없음` in the note — when the room is full for that piece.
   */
  private refreshStore(room: number | null, purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const allowed = new Set(housing.getFurnitureFor(purpose).map((d) => d.id));
    const stored = this.storedCounts();
    const kind = this.kind;
    const entries = [...stored].map(([defId, qty]) => {
      const fits = allowed.has(defId);
      const spot = fits && room !== null ? this.findFreeSpot(room, defId) : null;
      return { defId, qty, def: housing.getFurnitureDef(defId), fits, spot };
    }).filter((e) => !!e.def && (kind === 'utility') === isUtilityFurniture(e.def)) as Array<{ defId: string; qty: number; def: FurnitureDef; fits: boolean; spot: FreeSpot | null }>;
    entries.sort((a, b) => Number(b.fits) - Number(a.fits) || a.def.name.localeCompare(b.def.name, 'ko'));

    // the fit result is part of the key: a piece placed / recovered elsewhere in the room flips `자리 없음` ↔ `배치 가능`
    // 2026-09-12: so is the 시설 가구 / 꾸밈용 가구 sub-tab (the store is filtered by it too)
    const key = `store|${kind}|${room}|${purpose}|${entries.map((e) => `${e.defId}:${e.qty}:${e.fits ? 1 : 0}${e.spot ? 1 : 0}`).join(',')}`;
    if (key === this.storeKey) { this.markSelection(this.selected); return; }
    this.storeKey = key;

    this.storeEl.replaceChildren();
    this.cards = [];
    this.emptyEl.hidden = entries.length > 0;
    if (entries.length === 0) {
      setText(this.emptyEl, stored.size === 0
        ? '가구 창고가 비어 있습니다 — 가구 제작 탭에서 만드세요'
        : kind === 'utility' ? '가구 창고에 시설 가구가 없습니다' : '가구 창고에 꾸밈용 가구가 없습니다');
    }
    for (const { defId, qty, def, fits, spot } of entries) {
      const card = el('button', { cls: `fcard store${fits ? '' : ' is-blocked'}`, parent: this.storeEl });
      card.dataset.defId = defId;       // the same handle as the 가구 제작 card — the tutorial spotlight · the smokes pick it
      card.style.setProperty('--fc', def.color);
      card.title = fits ? `${def.name}\n${def.description}` : `${def.name} — 이 방에 설치할 수 없습니다`;
      const thumb = el('div', { cls: 'fcard-thumb', parent: card });
      el('span', { cls: 'fcard-glyph', text: MODEL_GLYPH[def.model] ?? '▨', parent: thumb });
      el('span', { cls: 'fcard-size', text: `${def.cols}×${def.rows}`, parent: thumb });
      const body = el('div', { cls: 'fcard-body', parent: card });
      el('div', { cls: 'fcard-name', text: def.name, parent: body });
      const note = !fits ? `${ROOM_PURPOSE_LABEL_KO[def.room === 'any' ? 'empty' : def.room]} 전용` : spot ? '배치 가능' : '자리 없음';
      const noteEl = el('div', { cls: 'fcard-note', text: note, parent: body });
      toggleClass(noteEl, 'is-full', fits && !spot);
      const own = el('div', { cls: 'fcard-own', text: `보유 ${qty}`, parent: body });
      toggleClass(own, 'none', qty <= 0);
      card.disabled = !fits;
      // the row only highlights itself; the 배치 button is the one that touches the floor
      if (fits) card.addEventListener('click', (e) => { e.stopPropagation(); this.selectStoreCard(defId); });
      const place = el('button', { cls: 'fcard-place', text: '배치', parent: card });
      place.disabled = !fits || !spot;
      place.title = !fits ? '이 방에 설치할 수 없습니다' : spot ? `${def.name} 배치 — 방 ${(room ?? 0) + 1} 의 빈 자리에 놓습니다` : '이 방에 놓을 자리가 없습니다';
      place.addEventListener('click', (e) => { e.stopPropagation(); this.placeCard(defId); });
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

  dispose(): void {
    this.stopHold();
    this.closeCraft();
    for (const u of this.unsubs) u();
    clearTimeout(this.toastTimer);
    window.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
  }
}
