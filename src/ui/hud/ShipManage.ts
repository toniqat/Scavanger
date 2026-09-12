import type { CraftIngredient, FacilityRequirement, FurnitureDef, FurnitureModelKind, GameContext, ItemDef, RoomPurpose } from '@/shared';
import {
  COCKPIT_ROOM_INDEX, FACILITY_COLOR, FACILITY_GLYPH, FACILITY_LABEL_KO, Keys, renderItemCost, ROOM_PURPOSES_ACTIVE, ROOM_PURPOSES_ASSIGNABLE,
  ROOM_PURPOSE_BUILD_GENERATOR_LEVEL, ROOM_PURPOSE_COLOR, ROOM_PURPOSE_GLYPH, ROOM_PURPOSE_LABEL_KO, SHIP_ROOM_COUNT, UI_HOLD_CONFIRM_S,
  WORKBENCH_ICON, buildFacilityChip, buildItemChip, isUtilityFurniture,
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
/** 2026-09-12: the 가구 제작 list is split into 시설 가구 (`isUtilityFurniture`) and 꾸밈용 가구. */
type FurnKind = 'utility' | 'decor';
/** How long the placement-refusal toast above the 인스펙터 stays up (UI timing, not balance). */
const TOAST_MS = 2200;

/** A free grid cell + yaw the 배치 button would drop a stored piece on (2026-09-09). */
interface FreeSpot { x: number; y: number; yaw: 0 | 1 | 2 | 3 }

/** Glyph per procedural furniture model (no asset files — the card thumbnail is a tinted frame + a character). */
const MODEL_GLYPH: Readonly<Record<FurnitureModelKind, string>> = {
  /* 작업대 다섯의 글리프는 `shared` 의 `WORKBENCH_ICON` 이 원본이다 — 제작 탭(`inventory/ui/labels`)과 같은 글자여야 한다. */
  bench_gun: WORKBENCH_ICON.gun, bench_gear: WORKBENCH_ICON.gear, bench_gadget: WORKBENCH_ICON.gadget,
  bench_medical: WORKBENCH_ICON.medical, bench_refine: WORKBENCH_ICON.refine,
  range_console: '▣', target_lane: '◎', sim_hub: '◈',
  /* 온실 개편 (2026-09-11): 옛 재배층 `grow_rack` 은 은퇴했지만 글리프는 남겨 둔다 (`Record` 는 전부를 요구하고,
     은퇴 가구를 그리는 옛 세이브 경로가 `?? '▨'` 로 떨어지면 카드가 통째로 다르게 보인다). 새 재배 스테이션은
     한 층이 아니라 층이 쌓인 물건이라 **겹꽃** `✿` 로 구분한다 — 외부 에셋 금지 규약대로 유니코드 한 글자이고,
     `❀`(옛 재배층) · `❦`(화분) · `❁`(작물 분류)와 모두 다른 글자다. */
  grow_rack: '❀', grow_station: '✿', repair_bench: '⛏', bookshelf: '▤',
  locker: '▤', table: '▭', shelf: '☰', crate: '▨', lamp: '☀', plant: '❦', chair: '⌂', bunk: '▬',
  /* 연구실 (A-11 · A-12 · A-13, 2026-09-11): 추출기 · 조합대는 작업대이므로 글리프의 원본이 `WORKBENCH_ICON` 이고
     (제작 탭 `inventory/ui/labels` 와 같은 글자여야 한다), 분석기는 작업대가 아니라 스테이션이라 자기 글자를 갖는다 —
     벤젠 고리 `⌬` 는 위의 어떤 글자와도 겹치지 않으면서 「해석하는 물건」으로 읽힌다. */
  analyzer: '⌬', bench_extract: WORKBENCH_ICON.extract, bench_mixer: WORKBENCH_ICON.mixer,
  /* 주방 · 배양조 · 프린터 (A-3c · A-14 · A-15, 2026-09-11): 조리대 · 프린터는 작업대이므로 글리프의 원본이
     `WORKBENCH_ICON` 이고(제작 탭 `inventory/ui/labels` 와 같은 글자여야 한다 — 2026-09-10 규약), 식탁 · 배양조는
     작업대가 아니라 스테이션이라 자기 글자를 갖는다: 식탁 `⊞`(자리가 놓인 상판 — `▭` 평범한 탁자와 구분된다),
     배양조 `⚗`(증류기 — 「무언가가 안에서 자란다」). 둘 다 위의 어떤 글자와도 겹치지 않는 유니코드 한 글자다. */
  bench_cook: WORKBENCH_ICON.cook, bench_print: WORKBENCH_ICON.print,
  dining_table: '⊞', culture_tank: '⚗',
  /* 2026-09-12 (사용자 결정): 조종석의 고정 설비였던 둘이 공용 시설 가구가 됐다 — 시술대 `⚕`(의료) · 컴퓨터 `⌨`(키보드),
     둘 다 위의 어떤 글자와도 겹치지 않는다. */
  implant_bay: '⚕', corp_computer: '⌨',
};

/**
 * Purposes offered to an empty room. 2026-09-12: the contract's `ROOM_PURPOSES_ASSIGNABLE` — 시뮬레이션실 · 휴식 공간
 * are gone from it (옛 세이브를 읽으려고 `ROOM_PURPOSES` 에만 남았다), and so are 빈 방 / 조종석.
 */
const ASSIGNABLE: readonly RoomPurpose[] = ROOM_PURPOSES_ASSIGNABLE;
/** 2026-09-12: the most material chips a furniture card shows in its one-line cost row (no wrapping). */
const CARD_COST_MAX = 4;
/** Cost chip edge in the furniture cards / inspector: wide enough that `99+/99` fits inside the thumbnail strip. */
const CARD_CHIP = 36;
/** The 재료 부족 toast of the inspector's dimmed 업그레이드 button (사용자 결정 문장 그대로). */
const SHORT_UPGRADE_TEXT = '재료가 부족하여 업그레이드할 수 없습니다.';

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
 *           **가구 창고** — what `getStored()` holds: pieces this room accepts first, every other stored piece under
 *           them, dimmed and disabled with the reason (`<용도> 전용`). **2026-09-09 (배치 버튼):** clicking a store
 *           card only **selects** it (`.is-sel` highlight) — it no longer arms ghost placement (`selectFurniture` is
 *           not called from this tab). Each accepted card carries a **`배치` button** (`.fcard-place`, right side,
 *           the craft tab's `.fcard-craft` twin) that drops the piece **straight into the current room** on the
 *           first free cell: `findFreeSpot` asks **`HousingRef.findFreeSpot`** (2026-09-10 — the scan order and the
 *           rotation are housing/'s rule: 화면 좌측 상단부터 가로줄 먼저, 가구는 화면 아래를 향한다); a hit goes to
 *           `HousingRef.place` (storage qty decrements there, `housing:furniturePlaced` fires — the tutorial's
 *           `benchPlace` step completes on it). The button is **disabled when nothing fits** and the `.fcard-note`
 *           says why: `배치 가능` / `자리 없음` / `<용도> 전용`. The fit result is part of the store list's memo key
 *           and is recomputed on every room change — `housing:changed`, `furniturePlaced` / `Moved` / `Recovered`,
 *           `facilityUpgraded`, `roomPurposeChanged` and the manage-room switch all refresh it.
 *         A 빈 방으로 button in the header clears the room — through a confirm popup and
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
 * the purposes; a purpose row stays **clickable** when blocked and prints its 한국어 reason inline (`.sm-block`) —
 * clicking it repeats the reason as a toast; and an allowed purpose opens a centred **modeless confirm popup**
 * (`.sm-confirm`: `정말로 N번 방을 <용도> 시설로 만들겠습니까?` + `renderItemCost` chips of `purposeCost`, 확인 →
 * `setRoomPurpose`, 취소 / Esc → close). Escape is caught in the capture phase and `Input.consume`d, so it closes
 * the popup only — the hub's own Esc (leave 시설 관리) and game/'s pause never see it.
 *
 * **B-13 (2026-09-11, 사용자 결정 — 클릭 인스펙터):** 시설 관리 모드에서 **놓인 가구를 클릭**하면 hub/ 의 레이캐스트가
 * `housing:furnitureSelected {uid}` 를 내고 이 화면이 `.sm-inspect` 카드를 띄운다 — 이름 · 글리프 · `Lv.n / max` ·
 * **다음 강화 비용 칩**(`HousingRef.furnitureUpgradeCost`) · 거절 사유(`furnitureUpgradeBlock`) · `강화`
 * (`upgradeFurniture`). `{uid: null}`(빈 곳 클릭) · ✕ · 방 바꾸기 · 화면 닫기가 카드를 내린다. `upgradeFurniture` 는
 * Phase 8 부터 있었지만 부르는 곳이 없어 작업대 Lv.2–3 이 플레이로 도달 불가였다 — 여기가 그 입구다.
 * 카드는 `.sm-confirm` 과 같은 결이지만 **모달리스**라 화면을 덮지 않는다 (계속 다른 가구를 클릭한다). 홀드 확정도
 * 없다: 강화는 되돌릴 수 없는 확정이 아니다 (`housing/ui/GrowStation` 의 강화 줄과 같은 판단).
 *
 * **B-13 (2026-09-11, 사용자 결정 — 이미 가진 실용 가구는 못 만든다):** 가구 제작 카드는 `HousingRef.furnitureCraftBlock`
 * 을 묻는다. 사유가 있으면 (재료 부족 · `이미 보유 중입니다`) 카드가 **딤드 + `title` 에 사유 + 제작 버튼 비활성**
 * 이고 목록의 **맨 아래**로 내려간다 — 만들 수 있는 것이 위다 (용도 지정 picker 의 `purposeRank` 와 같은 결).
 * 그 사유는 `cardsKey` 의 일부다: 재료가 들어와 사유가 사라지면 목록이 다시 그려져야 한다.
 *
 * **2026-09-12 (사용자 결정 — 하우징 모드 UI 개선):**
 *   - 용도 지정 목록은 **이미 지은 용도를 그리지 않는다** (모든 용도가 함선당 하나 — `Rules.purposeChangeReason`).
 *     `다음 업데이트` 용도는 잠긴 채 그대로 보인다. **발전기 행은 용도 목록에서 빠져 좌측 방 목록 아래**로 옮겼다
 *     (`.sm-rooms .sm-gen` — 클래스는 그대로라 튜토리얼의 `.sm-gen .sm-gen-btn` 포커싱이 산다).
 *   - 가구 제작 탭 안에 **시설 가구 / 꾸밈용 가구** 하위 탭(`.sm-subtabs`). 이미 가진 실용 가구는 제작 버튼이
 *     `이미 보유 중`(비활성)이 되고 카드 밑의 「이미 보유 중입니다」 줄은 없다. 시설 가구 카드에는 보유 수가 없다.
 *   - 인스펙터 좌측 하단 **`위치 이동`** → `housing:moveRequested {uid}` → hub/ 의 위치 이동 상태 (E 와 같은 길).
 *     놓을 수 없는 곳을 누르면 hub/ 가 `housing:placeRefused` 를 내고 이 화면이 인스펙터 **위쪽** 토스트(`.sm-toast`)로
 *     띄운다 — 인스펙터와 토스트는 하단 중앙의 한 `.sm-dock` 에 쌓인다.
 *
 * **2026-09-12 2차 (사용자 결정 — 조종석 · 업그레이드 구역 · 시설 제거 홀드):**
 *   - 방 목록 **맨 위에 조종석**(`COCKPIT_ROOM_INDEX`, 방 번호 없음) — 가구 제작 / 가구 창고만 있고 시설 제거가 없다.
 *     우측 머리 라벨은 시설 이름만이다. 용도 지정은 `ROOM_PURPOSES_ASSIGNABLE`(시뮬레이션실 · 휴식 공간 없음)만 돈다.
 *   - 가구 카드의 재료는 이름 아래 **한 줄 · 최대 4개**(`CARD_COST_MAX`, `CARD_CHIP` px — 보유/필요가 썸네일 안에 든다).
 *     시설 가구 / 꾸밈용 가구 하위 탭은 **가구 창고에도** 선다.
 *   - 인스펙터의 `위치 이동` 버튼은 없어졌다(E · LMB 꾹 누르기 — hub/ 가 `housing:moveHold` 로 커서 게이지를 알린다).
 *     카드 하단은 **업그레이드 구역**: `업그레이드 비용` · 재료 칩 + 시설 레벨 칩(`buildFacilityChip`) · `업그레이드`.
 *     딤드여도 눌리고, 재료가 모자라면 `재료가 부족하여 업그레이드할 수 없습니다.` 토스트, 아니면 그 사유.
 *   - `시설 제거`(빨강) 확인 팝업의 확정은 빨간 `시설 제거` 를 `UI_HOLD_CONFIRM_S` 동안 누른다 — 제목 `{시설 이름} 제거`,
 *     돌려받는 칩은 수량만.
 *
 * **2026-09-08 (튜토리얼은 잠그지 않고 감춘다):** `ctx.tutorial.hides('roomPurpose' | 'furniture', id)` 가 참인
 * 항목은 목록에서 **빠진다** — "튜토리얼에서는 ~" 사유를 단 줄을 남겨 두는 대신, 지금 지을 수 있는 것만
 * 보여 준다 (안내 단계에서는 발전기 행 + 작업실 한 줄). 단계가 넘어가거나 튜토리얼을 건너뛰면
 * `tutorial:changed` 로 목록을 다시 그려 감춰 둔 것이 전부 돌아온다.
 */
export class ShipManage {
  readonly root: HTMLElement;
  private roomsEl: HTMLElement;
  private sideHead: HTMLElement;
  private clearBtn: HTMLButtonElement;
  private tabsEl: HTMLElement;
  private tabBtns = new Map<FurnTab, HTMLButtonElement>();
  /* 2026-09-12: 시설 가구 / 꾸밈용 가구 (가구 제작 탭 안), 방 목록 아래 발전기 행, 하단 dock 의 토스트 */
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
  private tab: FurnTab = 'craft';
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
  private confirmHint: HTMLElement;
  private confirmOk: HTMLButtonElement;
  private confirmOkText: HTMLElement;
  private confirmFill: HTMLElement;
  private confirmCancel: HTMLButtonElement;
  private confirmAction: (() => void) | null = null;
  private pendingPurpose: RoomPurpose | null = null;
  /* 2026-09-12: 시설 제거 확인은 되돌릴 수 없는 확정이다 — 빨간 `시설 제거` 버튼을 `UI_HOLD_CONFIRM_S` 동안 눌러야 한다 */
  private confirmDanger = false;
  private holdStart = 0;
  private holdTimer = 0;
  private holdT = 0;
  private readonly onHoldUp = (): void => this.stopHold();
  /* B-13: 클릭 인스펙터 (모달리스 — blocker 도 escape 토큰도 잡지 않는다) */
  private inspectEl: HTMLElement;
  private inspectThumb: HTMLElement;
  private inspectGlyph: HTMLElement;
  private inspectName: HTMLElement;
  private inspectLv: HTMLElement;
  private inspectDesc: HTMLElement;
  /* 2026-09-12: 하단 업그레이드 구역 — `업그레이드 비용` · 재료 + 시설 레벨 칩 · `업그레이드` */
  private inspectCost: HTMLElement;
  private inspectBtn: HTMLButtonElement;
  private inspectUid: string | null = null;

  private onKey = (e: KeyboardEvent): void => {
    if (!this.isConfirmOpen) return;
    // 2026-09-12: Enter 로는 되돌릴 수 없는 확정(시설 제거)이 되지 않는다 — 먹기만 한다 (포커스된 취소도 누르지 않는다)
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
    // 2026-09-12 (사용자 결정): 조종석이 **늘 맨 위**에 서고, 그 아래로 방 1 … SHIP_ROOM_COUNT. 조종석은 방이 아니라
    // 번호 칸이 비어 있고(`.is-cockpit`) 이름 자리에 `조종석` 이 선다. `data-room` 은 스모크 · 튜토리얼이 행을 집는 손잡이다.
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
    // 2026-09-12: 발전기 행은 함선 전체 시설이라 방 목록 아래에 산다 (용도 지정 목록에서 빠졌다)
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
      b.dataset.tab = id;               // 2026-09-08: 튜토리얼 스포트라이트가 '가구 창고' 탭을 집는 손잡이
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickTab(id); });
      this.tabBtns.set(id, b);
    }
    // 2026-09-12: 가구 제작 안의 하위 탭 — 시설 가구(E 로 뭔가를 하는 가구) / 꾸밈용 가구
    this.subtabsEl = el('div', { cls: 'sm-subtabs', parent: side });
    for (const [id, label] of [['utility', '시설 가구'], ['decor', '꾸밈용 가구']] as ReadonlyArray<readonly [FurnKind, string]>) {
      const b = el('button', { cls: 'sm-subtab', text: label, parent: this.subtabsEl });
      b.dataset.kind = id;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickKind(id); });
      this.kindBtns.set(id, b);
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
    this.confirmHint = el('div', { cls: 'sm-confirm-hint', text: `시설 제거 버튼을 ${UI_HOLD_CONFIRM_S}초 동안 누르고 있어야 실행됩니다.`, parent: card });
    this.confirmHint.hidden = true;
    const acts = el('div', { cls: 'acts', parent: card });
    const cancel = this.confirmCancel = el('button', { cls: 'ui-btn', text: '취소', parent: acts });
    this.confirmOk = el('button', { cls: 'ui-btn primary sm-confirm-ok', parent: acts });
    this.confirmFill = el('i', { cls: 'sm-hold-fill', parent: this.confirmOk });
    this.confirmOkText = el('span', { cls: 'sm-confirm-ok-t', text: '확인', parent: this.confirmOk });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); this.closeConfirm(true); });
    // 2026-09-12: a danger confirm (시설 제거) never runs on a click — only the `UI_HOLD_CONFIRM_S` hold below does
    this.confirmOk.addEventListener('click', (e) => { e.stopPropagation(); if (!this.confirmDanger) this.runConfirm(); });
    this.confirmOk.addEventListener('pointerdown', (e) => { if (this.confirmDanger && e.button === 0) { e.preventDefault(); this.startHold(); } });
    this.confirmOk.addEventListener('pointerleave', () => this.stopHold());
    // a click on the dimmed backdrop cancels, like the 함선 tab's popups
    this.confirmEl.addEventListener('mousedown', (e) => { if (e.target === this.confirmEl) this.closeConfirm(true); });

    /* B-13 (2026-09-11): 클릭 인스펙터. `.sm-confirm` 과 같은 상자 언어를 쓰지만 배경을 덮지 않는 **모달리스**
       카드다 — 방 목록(좌) · 가구 목록(우) 사이 하단 중앙에 서서, 카드를 띄운 채로 다음 가구를 클릭할 수 있다. */
    /* 2026-09-12: 인스펙터와 그 위의 토스트가 하단 중앙 한 줄기(`.sm-dock`)에 쌓인다 — 토스트는 늘 카드 바로 위다 */
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
    /* 2026-09-12 (사용자 결정): `위치 이동` 버튼은 없어졌고(E · LMB 꾹 누르기가 한다) 카드 하단이 **업그레이드 구역**이다 —
       맨 좌측 `업그레이드 비용` · 재료 칩 + 시설 레벨 칩 · 맨 우측 `업그레이드`. */
    const upsec = el('div', { cls: 'sm-ins-upsec', parent: this.inspectEl });
    el('span', { cls: 'sm-ins-up-label', text: '업그레이드 비용', parent: upsec });
    this.inspectCost = el('div', { cls: 'sm-ins-cost', parent: upsec });
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
      b.on('housing:furniturePlaced', () => { if (this.active) this.refresh(); }),
      b.on('housing:furnitureMoved', () => { if (this.active) this.refresh(); }),
      b.on('housing:furnitureRecovered', () => { if (this.active) this.refresh(); }),
      b.on('housing:facilityUpgraded', () => { if (this.active) this.refresh(); }),
      b.on('housing:roomPurposeChanged', () => { if (this.active) this.refresh(); }),
      b.on('housing:selectionChanged', ({ defId }) => this.markSelection(defId)),
      // B-13 (2026-09-11): hub/ 의 시설 관리 레이캐스트가 놓인 가구를 집었다 (`uid: null` = 빈 곳 → 선택 해제).
      b.on('housing:furnitureSelected', ({ uid }) => this.setInspect(uid)),
      // 2026-09-12: 놓을 수 없는 곳 (인스펙터 위 토스트). 위치 이동 버튼이 없어져 `moveStateChanged` 는 더 듣지 않는다
      b.on('housing:placeRefused', ({ reason }) => this.showToast(reason)),
      b.on('inventory:changed', () => { if (this.active) this.refresh(); }),
      b.on('inventory:stashChanged', () => { if (this.active) this.refresh(); }),
      b.on('game:newMission', () => this.setActive(false, null)),
      b.on('game:abort', () => this.setActive(false, null)),
      // 2026-09-08: 튜토리얼이 단계를 넘기거나 건너뛰어지면 숨겨 뒀던 용도 · 가구가 다시 나타난다
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

  /**
   * 2026-09-08 — 튜토리얼이 막는 항목은 사유를 달아 두지 않고 **아예 그리지 않는다**. 목록에 지금 할 수
   * 있는 것만 남으므로 "왜 안 되지"가 생기지 않는다 (튜토리얼이 꺼져 있으면 언제나 false).
   */
  private tutHides(gate: 'roomPurpose' | 'furniture', id: string): boolean {
    return this.ctx?.tutorial?.hides(gate, id) ?? false;
  }

  /** 목록 캐시 키에 섞는 튜토리얼 단계 — 단계가 바뀌면 숨김 집합도 바뀐다. */
  private get tutKey(): string { return this.ctx?.tutorial?.step ?? '-'; }

  private setActive(active: boolean, room: number | null): void {
    const changed = active !== this.active || room !== this.room;
    this.active = active;
    this.room = active ? room : null;
    toggleClass(this.root, 'show', active);
    if (changed && this.isConfirmOpen) this.closeConfirm();
    // B-13: the inspector describes one placed piece — a different room (or a closed screen) is a different subject
    if (changed) this.setInspect(null);
    if (!active) {
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
    this.cardsEl.scrollTop = 0;
    this.storeEl.scrollTop = 0;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refreshSide();
  }

  /** 2026-09-12: 가구 제작의 시설 가구 / 꾸밈용 가구 하위 탭. */
  private pickKind(kind: FurnKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.cardsEl.scrollTop = 0;
    this.storeEl.scrollTop = 0;       // 2026-09-12: the 가구 창고 tab is filtered by the same sub-tab
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refreshSide();
  }

  /** A 가구 제작 row: craft one piece into furniture storage (materials come from bag + stash). */
  private craftCard(defId: string): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    // B-13 (2026-09-11): 재료 부족뿐 아니라 「이미 보유 중입니다」도 여기서 걸린다 — 사유의 원본은 housing/ 이다
    const block = this.craftBlock(defId);
    if (block) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: block, kind: 'warning' });
      return;
    }
    if (!housing.craftFurniture(defId)) { this.ctx.bus.emit('audio:play', { id: 'ui_deny' }); return; }
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    const def = housing.getFurnitureDef(defId);
    this.ctx.bus.emit('ui:notify', { text: `${def?.name ?? defId} 제작 완료 — 가구 창고에 있습니다`, kind: 'success' });
    this.refresh();
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
   * `housing/Rules.autoPlaceSpot`) — 화면 좌측 상단부터 가로줄을 먼저 채우고 가구는 화면 아래를 향한다. This
   * screen only asks for the answer; the coordinate derivation and its 근거 live next to the placement rules.
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
      if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
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
      info.level === 0
        ? '발전기를 가동하겠습니까? 발전기 Lv.1 부터 시설을 증축하고 업그레이드할 수 있습니다. 재료는 가방과 함선 창고에서 함께 빠져나갑니다.'
        : `발전기를 Lv.${info.level + 1} 로 업그레이드하겠습니까? 재료는 가방과 함선 창고에서 함께 빠져나갑니다.`,
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
    this.confirmHint.hidden = !this.confirmDanger;
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

  /** One 시설 레벨 요구 as the wide double-bordered chip (`shared/itemChip.buildFacilityChip`). */
  private facilityChip(r: FacilityRequirement, size: number): HTMLElement {
    return buildFacilityChip(FACILITY_LABEL_KO[r.facility], FACILITY_GLYPH[r.facility], FACILITY_COLOR[r.facility], r.have, r.need, { size });
  }

  /* ── B-13 (2026-09-11): 클릭 인스펙터 ─────────────────────────────────── */

  /**
   * `housing:furnitureSelected` 의 유일한 소비자. `uid` 가 배치된 조각이 아니면(치웠다 · 다른 방이다) 카드를
   * 내린다 — 없는 조각을 「Lv.0」으로 그리느니 사라지는 편이 정직하다.
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
   * 카드 한 장을 다시 그린다. `refresh()` 가 매번 부르므로 재료가 들어오거나 강화가 끝나면 비용 칩 · 사유 ·
   * 버튼이 저절로 따라온다 (카드가 작아 memo 키를 두지 않는다 — 목록과 달리 요소가 열 개도 안 된다).
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

    // 2026-09-12 (사용자 결정): 하단 업그레이드 구역 — 재료 칩 + 채워지지 않은 시설 레벨 칩, 우측 `업그레이드`.
    // 막혀 있어도 버튼은 눌린다(딤드 + `aria-disabled`) — 누르면 인스펙터 위 토스트가 이유를 말한다.
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
   * 2026-09-12: 채워지지 않은 시설 레벨 요구 (발전기). 계약 질의 `furnitureUpgradeRequirements` 가 원본이고, 구현이 아직
   * 없으면 housing/ 의 규칙 「가구 Lv.n 으로 올리려면 발전기 Lv.n 이상」으로 같은 답을 만든다.
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

  /** 2026-09-12: 시설 증축의 채워지지 않은 시설 레벨 요구 — 계약 질의가 없으면 발전기 Lv.`ROOM_PURPOSE_BUILD_GENERATOR_LEVEL` 게이트. */
  private purposeRequirements(purpose: RoomPurpose): readonly FacilityRequirement[] {
    const housing = this.ctx.housing;
    if (!housing) return [];
    if (typeof housing.purposeRequirements === 'function') {
      try { return housing.purposeRequirements(purpose); } catch { /* fall through */ }
    }
    const have = housing.getFacility('generator').level, need = ROOM_PURPOSE_BUILD_GENERATOR_LEVEL;
    return have < need ? [{ facility: 'generator', have, need }] : [];
  }

  /**
   * A cost row of item chips (2026-09-12): the 보유 count is capped at `99+` so the `보유/필요` strip inside a
   * `CARD_CHIP` thumbnail never sticks out of it (the numbers themselves are unchanged — only the label).
   */
  private renderCostRow(host: HTMLElement, cost: readonly CraftIngredient[], size: number): void {
    renderItemCost(host, cost, (id) => this.itemDef(id), (id) => this.owned(id), { size });
    for (const h of host.querySelectorAll<HTMLElement>('.item-chip-have')) {
      if (Number(h.textContent) > 99) h.textContent = '99+';
    }
  }

  /** 2026-09-12: 인스펙터 위쪽 토스트 (`housing:placeRefused`). 같은 문장이 다시 오면 다시 번쩍인다. */
  private showToast(text: string): void {
    if (!this.active) return;
    setText(this.toastEl, text);
    this.toastEl.hidden = false;
    this.toastEl.classList.remove('flash'); void this.toastEl.offsetWidth; this.toastEl.classList.add('flash');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.hideToast(), TOAST_MS);
  }

  private hideToast(): void {
    clearTimeout(this.toastTimer);
    this.toastTimer = 0;
    this.toastEl.hidden = true;
  }

  /**
   * 업그레이드 버튼. 되돌릴 수 없는 확정이 아니므로 1초 홀드도 확인 팝업도 없다 (GrowStation 의 강화 줄과 같다).
   * 2026-09-12 (사용자 결정): 딤드된 버튼도 눌린다 — 재료가 모자라면 인스펙터 위 토스트 `재료가 부족하여 업그레이드할 수
   * 없습니다.`, 그 밖의 사유(발전기 레벨 …)면 그 문장을 같은 자리에 띄운다.
   */
  private upgradeInspected(): void {
    const housing = this.ctx.housing;
    const uid = this.inspectUid;
    if (!housing || !uid) return;
    const cost = this.upgradeCost(uid);
    if (!cost) return;                               // 최대 레벨 — the button is really disabled then
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
    // 방 목록 · 가구 목록 · 카드를 함께 다시 그린다 (재료가 빠져 제작 카드의 사유가 달라질 수 있다)
    this.refresh();
  }

  /**
   * 계약(2026-09-11)의 세 질의는 housing/ 에 구현이 **늦게 붙을 수 있다** (폴더별로 나눠 짓는다). 그때
   * 화면이 통째로 죽는 대신, 예전부터 있던 질의로 같은 답을 만든다 — 구현이 붙으면 저절로 그쪽을 쓴다.
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
   * 제작 카드의 거절 사유. 재료 부족에 더해 **이미 가진 실용 가구**(`isUtilityFurniture`)를 잠근다 — 판정은
   * 전부 housing/ 의 `furnitureCraftBlock` 안에 있고 이 화면은 답만 그린다.
   */
  private craftBlock(defId: string): string | null {
    const housing = this.ctx.housing;
    if (!housing) return null;
    if (typeof housing.furnitureCraftBlock === 'function') {
      try { return housing.furnitureCraftBlock(defId); } catch { /* fall through */ }
    }
    const info = housing.canCraftFurniture(defId);
    return info.ok ? null : `재료 부족: ${this.missingText(info.missing)}`;
  }

  private missingText(missing: readonly CraftIngredient[]): string {
    return missing.map((m) => `${this.itemDef(m.defId)?.name ?? m.defId} ${m.qty}`).join(' · ');
  }

  /**
   * Header 빈 방으로: give the room back. Placed pieces go to the 가구 창고 and **every material the facility ever
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
    // 2026-09-12 (사용자 결정): 제목은 `{시설 이름} 제거`, 돌려받는 칩은 수량만, 확정은 빨간 `시설 제거` 1초 홀드
    this.openConfirm(
      `${label} 제거`,
      `정말로 ${label} 시설을 제거하겠습니까?${placed > 0 ? ` 놓인 가구 ${placed}개는 가구 창고로 돌아갑니다.` : ''} 들어간 재료는 전부 함선 창고로 돌려받습니다.`,
      housing.facilityRefund(room),
      null,
      () => this.emptyRoom(room, label),
      { danger: true, refund: true, okText: '시설 제거' },
    );
  }

  /** 시설 제거 확정: `removeRoomFacility` refunds 100 % into the 함선 창고 (or refuses with a 한국어 reason). */
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
    // B-13: 인스펙터도 같은 한 바퀴에 올라탄다 — 재료 · 레벨 · 조각의 존재가 바뀌면 카드가 따라간다
    this.refreshInspect();
  }

  private refreshSide(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const room = this.room;
    const purpose = room !== null ? this.purposeOf(room) : 'empty';
    const assigning = room !== null && purpose === 'empty';
    const cockpit = room === COCKPIT_ROOM_INDEX;

    // 2026-09-12 (사용자 결정): 머리 라벨은 시설 이름만 — `가구 · 방 N — 작업실` → `작업실`
    setText(this.sideHead, room === null ? '가구' : assigning ? '용도 지정' : ROOM_PURPOSE_LABEL_KO[purpose]);
    // 시설 제거 is only offered on an assigned room the rules allow to go back to 빈 방 — never on the cockpit
    this.clearBtn.hidden = room === null || assigning || cockpit || !!housing.purposeBlock(room, 'empty');

    this.purposesEl.hidden = !assigning;
    this.tabsEl.hidden = assigning || room === null;
    for (const [id, b] of this.tabBtns) toggleClass(b, 'is-on', id === this.tab);
    // 2026-09-12: 시설 가구 / 꾸밈용 가구 하위 탭은 가구 창고에도 선다
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
    if (this.tab === 'craft') this.refreshCards(room, purpose);
    else this.refreshStore(room, purpose);
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
   * 가동 / 업그레이드 → the confirm popup → `ctx.housing.upgrade('generator')`. Highlighted (`is-hint`) while the
   * generator is below the 시설 증축 gate, since nothing can be built until it runs.
   */
  private refreshGenerator(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const gen = housing.getFacility('generator');
    const gateBlocks = gen.level < ROOM_PURPOSE_BUILD_GENERATOR_LEVEL;
    const key = `g${gen.level}/${gen.maxLevel}|${gen.blocked ?? ''}|${this.costKeyOf(gen.nextCost)}|${gateBlocks ? 1 : 0}`;
    if (key === this.genKey) return;
    this.genKey = key;
    this.genEl.replaceChildren();
    const g = el('div', { cls: `sm-gen${gateBlocks ? ' is-hint' : ''}${gen.blocked && gen.nextCost ? ' is-blocked' : ''}`, parent: this.genEl });
    const head = el('div', { cls: 'hd', parent: g });
    const gthumb = el('div', { cls: 'sm-thumb', parent: head });
    gthumb.style.setProperty('--pc', FACILITY_COLOR.generator);
    el('span', { cls: 'g', text: FACILITY_GLYPH.generator, parent: gthumb });
    const gline = el('div', { cls: 'ln', parent: head });
    el('span', { cls: 'nm', text: '발전기', parent: gline });
    el('span', { cls: 'lv ui-mono', text: `Lv.${gen.level} / ${gen.maxLevel}`, parent: gline });
    const gbtn = el('button', { cls: 'sm-gen-btn', text: gen.nextCost ? (gen.level === 0 ? '가동' : '업그레이드') : '최대', parent: head });
    gbtn.disabled = !gen.nextCost;
    gbtn.title = gen.blocked ?? (gen.level === 0 ? '발전기 가동' : `발전기 Lv.${gen.level + 1}`);
    gbtn.addEventListener('click', (e) => { e.stopPropagation(); this.pickGenerator(); });
    if (gen.nextCost) {
      const gcost = el('div', { cls: 'sm-cost', parent: g });
      renderItemCost(gcost, gen.nextCost, (id) => this.itemDef(id), (id) => this.owned(id), { size: 24 });
    }
    const genNote = gateBlocks
      ? `시설 증축에는 발전기 Lv.${ROOM_PURPOSE_BUILD_GENERATOR_LEVEL} 이 필요합니다${gen.blocked && gen.nextCost ? ` (${gen.blocked})` : ''}`
      : gen.blocked && gen.nextCost ? gen.blocked : gen.nextCost ? '' : '최대 레벨';
    if (genNote) el('div', { cls: 'sm-block', text: genNote, parent: g });
  }

  /**
   * 용도 지정 buttons for an empty room — **purposes the ship already has are not drawn at all** (2026-09-12), the rest
   * are sorted 제작 가능 → 제작 불가, each led by the shared facility thumbnail (`ROOM_PURPOSE_GLYPH` /
   * `ROOM_PURPOSE_COLOR`) and followed by the **materials the 시설 증축 costs** as `.item-chip`s. A blocked purpose
   * keeps the 한국어 reason as its title and as a short line under the name.
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
      renderItemCost(costEl, cost, (id) => this.itemDef(id), (id) => this.owned(id), { size: 24 });
      // 2026-09-12 (사용자 결정): 발전기 레벨 요구는 문장이 아니라 재료 칩과 같은 줄의 가로 긴 이중 테두리 칩이다
      for (const r of reqs) costEl.appendChild(this.facilityChip(r, 24));
      // Phase 12: the reason is printed, not tucked into a tooltip, and the row stays clickable (→ toast + flash)
      if (blocked) el('div', { cls: 'sm-block', text: blocked, parent: body });
      toggleClass(b, 'is-blocked', !!blocked);
      b.setAttribute('aria-disabled', blocked ? 'true' : 'false');
      b.title = blocked ?? `${ROOM_PURPOSE_LABEL_KO[p]} 증축`;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickPurpose(p); });
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
    // B-13 (2026-09-11): 만들 수 있는 것이 위, 거절 사유가 붙은 것은 맨 아래 (용도 지정 picker 와 같은 결).
    // `sort` 는 안정적이므로 같은 등급 안에서는 카탈로그 순서가 그대로 남는다.
    const defs = housing.getFurnitureFor(purpose)
      .filter((d) => !this.tutHides('furniture', d.id) && (kind === 'utility') === isUtilityFurniture(d))
      .map((d) => {
        const utility = isUtilityFurniture(d);
        const have = utility && (placedIds.has(d.id) || (stored.get(d.id) ?? 0) > 0);
        return { def: d, block: this.craftBlock(d.id), utility, have };
      });
    defs.sort((a, b) => Number(!!a.block) - Number(!!b.block));

    // Rebuild only when the visible content actually changed (sub-tab / room / def list / storage / 보유 / material
    // counts / 튜토리얼 단계 / **거절 사유** — 재료가 들어와 사유가 사라지면 카드가 딤드를 벗고 목록 위로 올라와야 한다).
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
      card.dataset.defId = def.id;      // 2026-09-08: 튜토리얼 스포트라이트 · 스모크가 카드를 집는 손잡이
      card.style.setProperty('--fc', def.color);
      card.title = block ? `${def.name} — ${block}` : `${def.name}\n${def.description}`;
      const thumb = el('div', { cls: 'fcard-thumb', parent: card });
      el('span', { cls: 'fcard-glyph', text: MODEL_GLYPH[def.model] ?? '▨', parent: thumb });
      el('span', { cls: 'fcard-size', text: `${def.cols}×${def.rows}`, parent: thumb });
      const body = el('div', { cls: 'fcard-body', parent: card });
      el('div', { cls: 'fcard-name', text: def.name, parent: body });
      // 2026-09-12 (사용자 결정): the material row is its own grid row under the name — ≤ `CARD_COST_MAX` chips on one
      // line, `CARD_CHIP` px each so the 보유/필요 strip fits inside the thumbnail. A piece that cannot be crafted
      // (공용 시설 가구 — 시술대 · 컴퓨터, `craft` null) says so instead of the 무료 a null cost would render.
      const cost = el('div', { cls: 'fcard-cost', parent: card });
      if (def.craft) this.renderCostRow(cost, def.craft.slice(0, CARD_COST_MAX), CARD_CHIP);
      else el('span', { cls: 'fcard-nocraft', text: '제작 불가', parent: cost });
      // 2026-09-12: 보유 수는 꾸밈용 가구만 (시설 가구는 하나뿐이라 수를 셀 이유가 없다)
      if (!utility) {
        const own = el('div', { cls: 'fcard-own', text: `보유 ${owned}`, parent: body });
        toggleClass(own, 'none', owned <= 0);
      }
      toggleClass(card, 'is-empty', owned <= 0 && !have);
      // Phase 12 의 교훈 그대로 사유는 **인쇄한다** — 단 「이미 보유 중」은 버튼 글자가 대신 말한다 (2026-09-12)
      if (block && !have) el('div', { cls: 'fcard-note is-locked', text: block, parent: body });
      // the row selects a stored piece for placement; the 제작 button spends materials for a new one
      card.addEventListener('click', (e) => { e.stopPropagation(); if (owned > 0) this.pickCard(def.id); else this.craftCard(def.id); });
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
      card.dataset.defId = defId;       // 가구 제작 카드와 같은 손잡이 — 튜토리얼 스포트라이트 · 스모크가 집는다
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
    for (const u of this.unsubs) u();
    clearTimeout(this.toastTimer);
    window.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
  }
}
