import './../inventory.css';
import type { EmbeddedView, GameContext, ItemDef, ItemInstance, KeyGuideEntry } from '@/shared';
import { Keys, QUICK_SLOTS, QUICK_SLOT_LABEL_KO, isQuickSlotActive, keyLabel, renderItemCost } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { Container } from '../Container';
import { LOADOUT_SLOTS, isArmorDef, isAttachmentDef, isBagDef, isWeaponDef, type DropTarget, type GridId, type InventorySystem, type ItemLocation, type SlotId } from '../InventorySystem';
import { BAG_FRAME_ROWS, filterPredicate, type FilterGroupId } from '../model';
import { buildFilterSelect, buildSortButton, type FilterControl } from './GridTools';
import { CraftPanel } from './CraftPanel';
import { CatalogView } from './CatalogView';
import { DisassemblePanel } from './DisassemblePanel';
import { RepairPanel } from './RepairPanel';
import { ImplantPanel } from './ImplantPanel';
import { filledSocketCount } from '../Sockets';
import { isQuickUsable } from '../QuickSlots';
import { GridView, buildSlotCardContent, buildTileContent, setNeededAmmoFrom, setRecoveryScope, type HighlightState } from './GridView';
import { Tooltip } from './Tooltip';
import { TipPin, inventoryTooltipLookups } from './TipPin';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { SplitDialog } from './SplitDialog';
import { CELL, QUICK_DIR_GLYPH, QUICK_ROSE_ORDER, SLOT_LABEL, STEP, TEXT, applyGridCellVar, capacityLabel, fmtValue, pouchAcceptsLabel, slotKeyLabel, syncGridCell, tierTitle, tileSize, fmtKg, weightLabel } from './labels';

import { BAG_LOC, CATALOG_DBL_MS, DRAG_THRESHOLD, type DragState, GHOST_SCALE, LOCK_SVG, MIDDLE_BUTTON, type QuickCell, SCREEN_TABS, type ScreenTab, type SlotView } from './model';
/** 폴더 공용 어휘(상수 · 타입 · 스크래치)는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 재수출한다. */
export * from './model';

/**
 * 2026-09-14: 폴백 배치 플래시가 스스로 꺼지는 보험 타이머 (ms). `inventory.css` 의 `inv-slot-flash` ·
 * `inv-quick-flash` 애니메이션 길이(0.62 s)보다 넉넉히 길다 — 정상 경로는 `animationend` 가 먼저 뗀다.
 */
const FLASH_MS = 900;

import * as Drag from './parts/Drag';
import * as Menu from './parts/ContextMenu';
import * as QuickUI from './parts/QuickPanel';
import * as SlotUI from './parts/SlotPanel';
import * as Screens from './parts/Screens';

export class InventoryUI {
  root: HTMLElement | null = null;
  layout!: HTMLElement;
  private tabsEl!: HTMLElement;
  /** Phase 8: tab buttons by id, and the host the embedded 캐릭터 / 기업 / 함선 views are built into. */
  tabButtons = new Map<ScreenTab, HTMLButtonElement>();
  screenHost!: HTMLElement;
  screenNote!: HTMLElement;
  activeTab: ScreenTab = 'inventory';
  screenView: EmbeddedView | null = null;
  /** Layer that holds the modeless popups (임플란트 picker / 제작 / 분해) above `.inv-layout`. */
  private modelessLayer!: HTMLElement;
  /**
   * **가방 칸을 담는 카드** (`.inv-panel-grids`, 클래스 이름은 선택자 호환으로 남겼다).
   *
   * 2026-09-15 2차에는 함선 창고 + 가방이 이 카드 안의 두 칸이었고 장비 열이 그 왼쪽이었다 (장비 | 창고 | 가방).
   * **2026-09-16 (사용자 결정): 함선 Tab 은 창고 | 장비 | 가방이다.** 창고 칸(`.inv-panel-stash`)은 `.inv-layout` 의
   * 직속 카드로 나와 장비 열 왼쪽에 서고, 함선에서는 창고 · 장비 · 가방이 이음매로 붙어 한 장의 패널로 보인다
   * (`inventory.css`). 칸마다 자기 세로 스크롤 · 정렬 · 필터를 갖는 것은 그대로다. 다른 폴더 화면의 창고 + 가방
   * 한 카드는 `TradeGrids` 의 몫이고 이 배치와 무관하다.
   */
  private rightCol!: HTMLElement;
  disassemble!: DisassemblePanel;
  /**
   * `모두 수리` 모달 팝업 (수리 목록은 제작 패널 아래에 없다).
   * 2026-09-14 (사용자 결정): 여는 버튼이 **작업대 헤더 → 가방 필터 칩 줄 맨 왼쪽**(`repairAllBtn`)으로 옮겼다 —
   * 수리 게이트는 "어느 작업대냐"가 아니라 "함선이냐"(`benchRepairRows`)이기 때문이다.
   */
  repair!: RepairPanel;
  /** 2026-09-14: 가방 필터 줄 맨 왼쪽의 주황색 `모두 수리` (함선에서만 — 레이드 중에는 숨는다). */
  private repairAllBtn!: HTMLButtonElement;
  /** 2026-09-16: `모두 수리` 와 `정렬` 사이의 `모두 창고로 이동` (함선에서만 — 가방 격자만 창고로). */
  private bagToStashBtn!: HTMLButtonElement;
  /** 2026-09-08: 전술 임플란트 + 임플란트 아이템, under 장착 장비 (moved here from the 캐릭터 시트). */
  implantPanel!: ImplantPanel;
  creditsEl!: HTMLElement;
  creditsValue!: HTMLElement;
  private containerPanel!: HTMLElement;
  private containerTitle!: HTMLElement;
  private containerTier!: HTMLElement;
  /** Phase 7: `감정 중 · n개 남음` / `감정 완료` readout in the container header. */
  private searchStatus!: HTMLElement;
  private stashPanel!: HTMLElement;
  private stashCount!: HTMLElement;
  /** 2026-09-16: 창고 머리 오른쪽 끝의 `업그레이드` (`ctx.housing` 이 없으면 숨는다 — `refresh`). */
  private stashUpgradeBtn!: HTMLButtonElement;
  private bagCapacity!: HTMLElement;
  private valueEl!: HTMLElement;
  containerView!: GridView;
  /** 2026-09-11 (C-60): the container grid's vertical scroll viewport (`.inv-cont-scroll`). */
  containerScroll!: HTMLElement;
  /** C-60: drag auto-scroll loop (`Drag.autoScrollTick`) — rAF id, last frame time (ms), sub-pixel remainder. */
  autoScrollRaf: number | null = null;
  autoScrollLast = 0;
  autoScrollAcc = 0;
  private scrollObserver: ResizeObserver | null = null;
  stashView!: GridView;
  bagView!: GridView;
  /** 2026-09-11 (A-15): 퀵슬롯 아래 **주머니 격자** — 장착한 주머니가 없으면 `hidden` 이고 아무것도 안 그린다. */
  pouchPanel!: HTMLElement;
  pouchTitle!: HTMLElement;
  pouchView!: GridView;
  slots = new Map<SlotId, SlotView>();
  /* appended: tactical kit */
  craftPanel!: CraftPanel;
  /* Phase 6: 무한 상자 */
  catalogView!: CatalogView;
  private weightEl!: HTMLElement;
  private weightValue!: HTMLElement;
  private weightState!: HTMLElement;
  private weightFill!: HTMLElement;
  quickCells: QuickCell[] = [];
  quickCount!: HTMLElement;
  quickKey!: HTMLElement;
  tooltip!: Tooltip;
  /** 2026-09-14: the pinned tooltip (1 s hold on a tile) + its socket drag-out — `ui/TipPin`. */
  pin!: TipPin;
  ghostLayer!: HTMLElement;
  dropZone!: HTMLElement;
  menu!: ContextMenu;
  dialog!: SplitDialog;
  drag: DragState | null = null;
  hovered: { uid: string; loc: ItemLocation } | null = null;
  /** 2026-09-15: last pointer position over the window (client px) — `validateHover` hit-tests it. −1 = unknown. */
  private lastPointerX = -1;
  private lastPointerY = -1;
  private hoverCheckRaf = 0;
  private trackPointer = (e: PointerEvent): void => { this.lastPointerX = e.clientX; this.lastPointerY = e.clientY; };
  /** Weapon tile currently lit as a socket target (attachment drag). */
  socketTarget: { uid: string; loc: ItemLocation } | null = null;
  private container: Container | null = null;
  hub = false;
  private visible = false;
  private closeTimer: number | null = null;

  onWindowMove = (e: PointerEvent): void => this.handlePointerMove(e);
  onWindowUp = (e: PointerEvent): void => this.handlePointerUp(e);
  /** 2026-09-12: capture-phase press while a merge remainder is held on the cursor (`Drag.handleHeldDown`). */
  onWindowDown = (e: PointerEvent): void => Drag.handleHeldDown(this, e);
  /** 2026-09-12: `performance.now()` until which tile dblclick / contextmenu are ignored (held-remainder clicks). */
  suppressClicksUntil = 0;
  /** 2026-09-12: 가방 · 창고 필터 — one choice for both grids (and the 주머니) of this window. */
  filterGroup: FilterGroupId = 'all';
  /** 2026-09-15 2차: 창고 · 가방 머리의 필터 드롭다운 (둘이 같은 `filterGroup` 을 보여 준다). */
  private filterChips: FilterControl[] = [];
  /** 2026-09-12: the 가방 grid's scroll viewport (the fixed 12-row frame can be taller than a short window). */
  bagScroll!: HTMLElement;

  constructor(public readonly sys: InventorySystem, public readonly ctx: GameContext) {}

  /* ── mount / visibility ────────────────────────────────────────────────── */

  mount(): void {
    if (this.root) return;
    // 2026-09-14: 칸 한 변은 창 높이를 탄다 (`labels.gridCellForHeight`). 격자를 만들기 **전에** 맞춰 두고,
    // 창 크기가 계단을 넘으면 `onViewportResize` 가 창 · 격자에 새 값을 나눠 준다.
    syncGridCell();
    const getDef = (id: string) => ITEM_DEF_MAP.get(id);
    const getStats = (item: ItemInstance) => this.sys.getStats(item);
    const root = document.createElement('div');
    root.className = 'inv-root';
    applyGridCellVar(root);
    root.hidden = true;
    window.addEventListener('resize', this.onViewportResize);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('pointermove', this.trackPointer, { capture: true, passive: true });   // 2026-09-15: `validateHover`
    this.root = root;

    /* screen tabs */
    this.tabsEl = document.createElement('nav');
    this.tabsEl.className = 'scr-tabs';
    this.tabsEl.hidden = true; // hub mode only — never over a mission crate window (Phase 8 fix)
    for (const t of SCREEN_TABS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `scr-tab${t.id === 'inventory' ? ' is-on' : ''}`;
      b.textContent = t.label;
      if (t.title) b.title = t.title;
      b.addEventListener('click', () => this.onTab(t.id));
      this.tabsEl.appendChild(b);
      this.tabButtons.set(t.id, b);
    }
    /* credits readout (Phase 5, ship screen only) */
    this.creditsEl = document.createElement('div');
    this.creditsEl.className = 'inv-credits';
    this.creditsEl.hidden = true;
    const crEyebrow = document.createElement('span');
    crEyebrow.className = 'inv-eyebrow';
    crEyebrow.textContent = TEXT.credits.eyebrow;
    this.creditsValue = document.createElement('span');
    this.creditsValue.className = 'inv-credits-value';
    this.creditsEl.append(crEyebrow, this.creditsValue);

    const layout = document.createElement('div');
    layout.className = 'inv-layout';
    this.layout = layout;

    /* container panel */
    const cPanel = document.createElement('section');
    cPanel.className = 'inv-panel inv-panel-container';
    cPanel.hidden = true;
    const cHead = document.createElement('header');
    cHead.className = 'inv-head';
    const cTitleWrap = document.createElement('div');
    cTitleWrap.className = 'inv-head-titles';
    this.containerTitle = document.createElement('h2');
    this.containerTitle.className = 'inv-title';
    this.containerTier = document.createElement('div');
    this.containerTier.className = 'inv-eyebrow';
    cTitleWrap.append(this.containerTier, this.containerTitle);
    const takeAll = document.createElement('button');
    takeAll.type = 'button';
    takeAll.className = 'inv-btn';
    takeAll.textContent = TEXT.takeAll;
    takeAll.addEventListener('click', () => {
      const moved = this.sys.takeAll();
      this.sys.sfx(moved > 0 ? 'ui_pickup' : 'ui_error');
    });
    this.searchStatus = document.createElement('div');
    this.searchStatus.className = 'inv-search-status';
    this.searchStatus.hidden = true;
    const cActions = document.createElement('div');
    cActions.className = 'inv-head-actions';
    cActions.append(this.searchStatus, takeAll);
    cHead.append(cTitleWrap, cActions);
    this.containerView = new GridView('container', getDef, getStats, this.tileHandlers());
    /*
     * 2026-09-11 (C-60): the grid scrolls vertically inside the panel. A corpse that `fitCorpseGrid` grew past the default
     * rows used to push the panel off a small screen. Crates never reach the `max-height`, so they look exactly as before
     * (`.is-scroll` — the scrollbar gutter — is only set while the viewport really overflows).
     */
    const cScroll = document.createElement('div');
    cScroll.className = 'inv-cont-scroll';
    cScroll.appendChild(this.containerView.el);
    this.containerView.setClip(cScroll);
    // a wheel scroll (or the drag auto-scroll) moves the cells under a still pointer: re-resolve the drop target
    cScroll.addEventListener('scroll', () => { const d = this.drag; if (d?.started) this.updateDragTarget(d.lastX, d.lastY); }, { passive: true });
    if (typeof ResizeObserver === 'function') {
      this.scrollObserver = new ResizeObserver(() => this.syncContainerScroll());
      this.scrollObserver.observe(cScroll);
      this.scrollObserver.observe(this.containerView.el);
    }
    this.containerScroll = cScroll;
    cPanel.append(cHead, cScroll);
    this.containerPanel = cPanel;

    /* stash panel (hub) */
    const sPanel = document.createElement('section');
    sPanel.className = 'inv-panel inv-panel-stash';
    sPanel.hidden = true;
    /*
     * 2026-09-15 2차: 좌측 상단 라벨을 한 번 없앴다가, **2026-09-16 (사용자 결정) 다시 넣는다** — 창고가
     * `.inv-layout` 의 직속 카드로 나와 [창고][장비][가방] 한 장으로 이어지면서, 머리 왼쪽이 통째로 빈 여백이 됐고
     * 이음매 너머의 장비 열과 구분이 서지 않았다. 조용한 섹션 제목(`.inv-eyebrow` 계열)이라 도구 줄보다 앞서지 않는다.
     */
    const sHead = document.createElement('header');
    sHead.className = 'inv-head is-bare';
    const sName = document.createElement('div');
    sName.className = 'inv-eyebrow inv-stash-name';
    sName.textContent = '함선 창고';
    this.stashCount = document.createElement('div');
    this.stashCount.className = 'inv-capacity';
    const sActions = document.createElement('div');
    sActions.className = 'inv-head-actions';
    const sChips = buildFilterSelect((id) => this.setFilterGroup(id));
    this.filterChips.push(sChips);
    /*
     * 2026-09-16 (사용자 결정): 필터 오른쪽의 **`업그레이드`** — 창고 칸 수를 늘리는 모달은 housing 것이므로
     * `HousingRef.openStorageUpgrade()` 한 줄만 부른다 (시설 레벨 · 비용 · 홀드 확정은 그쪽 규칙이다).
     * `ctx.housing` 이 없으면(레이드 · 함선 밖) 누를 데가 없는 버튼이라 **통째로 숨긴다** — 딤드로 남기지 않는다.
     */
    this.stashUpgradeBtn = document.createElement('button');
    this.stashUpgradeBtn.type = 'button';
    this.stashUpgradeBtn.className = 'inv-btn inv-stash-upgrade-btn';
    this.stashUpgradeBtn.textContent = '업그레이드';
    this.stashUpgradeBtn.title = '창고 칸 수 늘리기';
    this.stashUpgradeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.housing?.openStorageUpgrade(); });
    sActions.append(this.stashCount, buildSortButton(() => this.sortGrid('stash')), sChips.el, this.stashUpgradeBtn);
    sHead.append(sName, sActions);
    this.stashView = new GridView('stash', getDef, getStats, this.tileHandlers());
    // 2026-09-09: 튜토리얼 중에는 창고에서 그 단계의 재료 · 산출물만 보인다 (`stashItem` 게이트, 꺼져 있으면 항상 false)
    this.stashView.setHideItem((item) => this.ctx.tutorial?.hides('stashItem', item.defId) ?? false);
    const sScroll = document.createElement('div');
    sScroll.className = 'inv-stash-scroll';
    sScroll.appendChild(this.stashView.el);
    // 2026-09-08: 창고 하단의 '가방 ↔ 창고: 드래그 또는 우클릭…' 안내 줄은 없앴다 — 드래그와 우클릭은
    //   가방 격자에서 이미 하는 동작이라 화면에 한 줄 더 적어 둘 이유가 없다 (사용자 결정: 당연한 설명은 지운다).
    // 2026-09-15 2차: 머리 한 줄(개수 · 정렬 · 필터) 아래 바로 격자다 — 따로 서던 필터 칩 줄은 없어졌다
    sPanel.append(sHead, sScroll);
    this.stashPanel = sPanel;

    /* bag panel */
    const bPanel = document.createElement('section');
    bPanel.className = 'inv-panel inv-panel-bag';
    // 2026-09-08: no `INVENTORY` eyebrow and no `가방` title — the grid under it is unmistakable, and the equipment
    //   column is joined to this panel now, so two stacked headings only pushed the two grids apart.
    const bHead = document.createElement('header');
    bHead.className = 'inv-head is-bare';
    this.bagCapacity = document.createElement('div');
    this.bagCapacity.className = 'inv-capacity';
    const bActions = document.createElement('div');
    bActions.className = 'inv-head-actions';
    const craftBtn = document.createElement('button');
    craftBtn.type = 'button';
    craftBtn.className = 'inv-btn inv-bag-craft';
    craftBtn.textContent = TEXT.craft;
    craftBtn.addEventListener('click', () => this.toggleCraft());
    const bChips = buildFilterSelect((id) => this.setFilterGroup(id));
    this.filterChips.push(bChips);
    /*
     * 2026-09-14 (사용자 결정): **`모두 수리` 는 가방 쪽 도구 줄의 맨 왼쪽**이다 — 작업대 헤더에서 옮겨 왔다.
     * 함선에 있으면 어떤 작업대를 열었든(열지 않았든) 눌린다: 수리 게이트는 `benchRepairRows` 의 「함선이냐」
     * 하나뿐이고, 레이드 중에는 그 목록이 비므로 버튼도 숨는다(`refresh`).
     *
     * 2026-09-15 2차: 그 줄은 이제 **가방 칸의 머리 한 줄**이다 (`모두 수리` · `정렬` · 필터 드롭다운) —
     * 격자 위에 따로 서던 칩 줄이 없어지면서 자리를 머리로 옮겼다. 창고 칸은 자기 머리에 자기 정렬 · 필터를 갖는다.
     */
    const bTools = document.createElement('div');
    bTools.className = 'inv-bag-tools';
    this.repairAllBtn = document.createElement('button');
    this.repairAllBtn.type = 'button';
    // ⚠ `.inv-repair-all` 은 이미 `RepairPanel` 의 실행 버튼이다 (전역 스타일시트 — 같은 이름을 쓰면 그쪽 규칙이 온다).
    this.repairAllBtn.className = 'inv-btn inv-repair-open-btn';
    this.repairAllBtn.textContent = TEXT.bench.repairAll;
    this.repairAllBtn.title = TEXT.bench.repairAll;
    this.repairAllBtn.addEventListener('click', (e) => { e.stopPropagation(); this.repair.open(this.repairAllBtn); });
    /*
     * 2026-09-16 (사용자 결정): **`모두 수리` 와 `정렬` 사이의 `모두 창고로 이동`.** 함선에서만 보이고(`refresh`),
     * 가방 격자의 아이템만 옮긴다 — 퀵슬롯 · 주머니 · 장착 장비는 그대로. 되돌릴 수 있는 이동이라 확인이 없다.
     */
    this.bagToStashBtn = document.createElement('button');
    this.bagToStashBtn.type = 'button';
    this.bagToStashBtn.className = 'inv-btn inv-stash-all-btn';
    this.bagToStashBtn.textContent = TEXT.bagToStash.label;
    this.bagToStashBtn.title = TEXT.bagToStash.title;
    this.bagToStashBtn.addEventListener('click', (e) => { e.stopPropagation(); this.moveBagToStash(); });
    bTools.append(this.repairAllBtn, this.bagToStashBtn, buildSortButton(() => this.sortGrid('bag')), bChips.el);
    bActions.append(this.bagCapacity, bTools, craftBtn);
    bHead.append(bActions);
    this.bagView = new GridView('bag', getDef, getStats, this.tileHandlers());
    // 2026-09-12 (사용자 결정): the box is always as tall as the longest bag; a smaller bag leaves blank rows below
    this.bagView.setFrameRows(BAG_FRAME_ROWS);
    const bScroll = document.createElement('div');
    bScroll.className = 'inv-bag-scroll';
    bScroll.appendChild(this.bagView.el);
    this.bagView.setClip(bScroll);
    bScroll.addEventListener('scroll', () => { const d = this.drag; if (d?.started) this.updateDragTarget(d.lastX, d.lastY); }, { passive: true });
    this.bagScroll = bScroll;
    const bBody = document.createElement('div');
    bBody.className = 'inv-bag-body';
    /*
     * 2026-09-11 (A-15) — **주머니 격자는 퀵슬롯 패널 바로 아래**다 (사용자 결정). 장착한 주머니가 없으면
     * 이 블록이 통째로 `hidden` 이다 — 「주머니가 없습니다」 자리조차 두지 않는다 (`getPouchSize()` 가 `{0,0}`).
     * 제목 한 줄이 이름과 **받는 종류**를 함께 말하므로, 빨간 하이라이트를 보기 전에 왜 안 들어가는지 알 수 있다.
     */
    const pPanel = document.createElement('div');
    pPanel.className = 'inv-pouch';
    pPanel.hidden = true;
    this.pouchTitle = document.createElement('div');
    this.pouchTitle.className = 'inv-pouch-title';
    this.pouchView = new GridView('pouch', getDef, getStats, this.tileHandlers());
    pPanel.append(this.pouchTitle, this.pouchView.el);
    this.pouchPanel = pPanel;
    bBody.append(bScroll, this.buildQuickPanel(), pPanel);
    const bFoot = document.createElement('footer');
    bFoot.className = 'inv-foot';
    const vLabel = document.createElement('span');
    vLabel.className = 'inv-eyebrow';
    vLabel.textContent = TEXT.value;
    this.valueEl = document.createElement('span');
    this.valueEl.className = 'inv-value';
    bFoot.append(vLabel, this.valueEl);
    /* weight readout (tactical kit) */
    this.weightEl = document.createElement('div');
    this.weightEl.className = 'inv-weight';
    const wRow = document.createElement('div');
    wRow.className = 'inv-weight-row';
    const wLabel = document.createElement('span');
    wLabel.className = 'inv-eyebrow';
    wLabel.textContent = TEXT.weight;
    this.weightValue = document.createElement('span');
    this.weightValue.className = 'inv-weight-value';
    this.weightState = document.createElement('span');
    this.weightState.className = 'inv-weight-state';
    wRow.append(wLabel, this.weightValue, this.weightState);
    const wTrack = document.createElement('div');
    wTrack.className = 'inv-weight-track';
    this.weightFill = document.createElement('i');
    wTrack.appendChild(this.weightFill);
    this.weightEl.append(wRow, wTrack);
    // 2026-09-15 2차: 도구(`모두 수리` · 정렬 · 필터)는 가방 **머리 한 줄** 안이다 — 격자 위 칩 줄은 없어졌다
    bPanel.append(bHead, bBody, this.weightEl, bFoot);
    // 2026-09-15 4차: 조합 목록 칸의 호버 카드는 격자 타일과 **같은 떠다니는 카드**(`this.tooltip`)다 — 무한 상자 타일과 같은 배선
    this.craftPanel = new CraftPanel(this.sys, getDef, () => this.closeCraft(), (anchor) => this.repair.open(anchor), {
      onEnter: (def, sample, e) => { if (!this.drag?.started && !this.pin.isSocketDragging) this.tooltip.show(sample, def, e.clientX, e.clientY); },
      onMove: (e) => this.tooltip.move(e.clientX, e.clientY),
      onLeave: () => this.tooltip.hide(),
    });

    /* equipment column */
    const eq = document.createElement('aside');
    eq.className = 'inv-equip';
    const eqGrid = document.createElement('div');
    eqGrid.className = 'inv-equip-grid';
    for (const slot of LOADOUT_SLOTS) eqGrid.appendChild(this.buildSlot(slot, SLOT_LABEL[slot]).el);
    eq.appendChild(eqGrid);
    /*
     * 2026-09-08: 임플란트는 캐릭터 스탯이 아니라 들고 나가는 장비 — 장착 장비 칸 바로 아래가 제자리다.
     * 2026-09-12 (사용자 결정 A안): 이제 장비칸 **그리드 안**의 한 칸이다 (`grid-area: implant`) — 주무기 II
     * 바로 아래, 주머니 왼쪽. 좁은 폭에서는 그리드가 한 줄 세로로 풀리므로 DOM 에서도 `pouch` 앞에 끼운다.
     */
    this.implantPanel = new ImplantPanel(this.sys, this.ctx);
    const pouchSlotEl = this.slots.get('pouch')?.el ?? null;
    eqGrid.insertBefore(this.implantPanel.root, pouchSlotEl);

    /* 무한 상자 (Phase 6): leftmost panel, shown only while the catalog is open */
    this.catalogView = new CatalogView(this.sys, getDef, {
      onPointerDown: (def, sample, e, tile) => this.beginCatalogPress(def, sample, e, tile),
      onEnter: (def, sample, e) => { if (!this.drag?.started) this.tooltip.show(sample, def, e.clientX, e.clientY); },
      onMove: (e) => this.tooltip.move(e.clientX, e.clientY),
      onLeave: () => this.tooltip.hide(),
      // double presses are detected in `beginCatalogPress`; a native dblclick that still arrives is ignored there
      onDblClick: () => { /* handled by the press timing */ },
      onClose: () => { this.sys.sfx('ui_drop'); this.sys.closeCatalog(); },
    });

    /*
     * 2026-09-16 (사용자 결정) — **함선 Tab = 창고 | 장비 | 가방.** 화면 순서는 css `order` 가 정한다
     * (무한 상자 −1 · 상자 0 · 창고 0 · 장비 1 · 가방 카드 2). 창고는 `.inv-layout` 의 직속 카드이고 DOM 에서 상자 **뒤**라,
     * 함선에서 상자 창이 함께 떠도 창고가 장비 열과 맞닿는다(이음매 규칙이 그 이웃을 전제한다). 레이드 Tab 은 창고가
     * `hidden` 이라 [장비][가방], 상자 루팅은 [상자][장비][가방] 그대로다. 두 격자는 스크롤 · 정렬 · 필터를 따로 갖는다.
     */
    this.rightCol = document.createElement('section');
    this.rightCol.className = 'inv-panel inv-panel-grids inv-col-right';
    this.rightCol.append(bPanel);
    // 2026-09-15 4차: 제작 상세는 작업대 패널 오른쪽의 별도 카드(`craftPanel.detailEl`) — 순서는 `.is-craft` 의 css `order` 가 정한다
    layout.append(this.catalogView.el, cPanel, sPanel, this.rightCol, this.craftPanel.el, this.craftPanel.detailEl, eq);

    /* Phase 8: embedded 캐릭터 / 기업 / 함선 screens replace the layout in place */
    this.screenHost = document.createElement('div');
    this.screenHost.className = 'inv-screen';
    this.screenHost.hidden = true;
    this.screenNote = document.createElement('div');
    this.screenNote.className = 'inv-screen-note';
    this.screenNote.hidden = true;

    /* Phase 8: modeless popups float above the window; the grid stays visible and interactive behind them */
    this.modelessLayer = document.createElement('div');
    this.modelessLayer.className = 'inv-modeless-layer';
    this.disassemble = new DisassemblePanel(this.sys, getDef, (open, uid) => {
      this.ctx.bus.emit('ui:disassembleToggled', { open, uid });
    }, (uid, t, done) => {
      // Phase 12: the 분해 게이지 reports its hold (≤ 30 Hz, once with done:true, {t:0} on a cancel)
      this.ctx.bus.emit('inventory:disassembleProgress', { uid, t, done });
    });
    this.repair = new RepairPanel(this.sys, getDef);
    this.modelessLayer.append(this.disassemble.el, this.repair.el);

    /*
     * 2026-09-14 (사용자 결정): **중앙 하단 안내 알약 바(`.inv-hints`) 는 없앴다.** 우측 하단 키 가이드(`guideKeys`)와
     * 다섯 항목이 그대로 겹쳤고, 겹치지 않던 마우스 보조 조작(Shift · Ctrl 드래그)은 그 가이드로 옮겼다.
     * 이 자리(`.inv-footer`)에는 이제 드래그 중에만 뜨는 버리기 영역만 산다.
     */
    /* world-drop zone (visible only while dragging) */
    const dropZone = document.createElement('div');
    dropZone.className = 'inv-dropzone';
    const dzTitle = document.createElement('div');
    dzTitle.className = 'inv-dropzone-title';
    const dzKey = document.createElement('kbd');
    dzKey.className = 'inv-key-drop';
    dzKey.textContent = keyLabel(Keys.DROP_ITEM);
    dzTitle.append(document.createTextNode(TEXT.dropZone), dzKey);
    const dzSub = document.createElement('div');
    dzSub.className = 'inv-dropzone-sub';
    dzSub.textContent = TEXT.dropZoneHint;
    dropZone.append(dzTitle, dzSub);
    this.dropZone = dropZone;

    this.tooltip = new Tooltip({
      getWeapon: getWeaponDef, getDef, getStats, getArmorDef: (id) => this.sys.getLoot().getArmorDef(id),
      getSkillName: (id) => { try { return this.ctx.progression?.getSkillDef(id)?.name ?? id; } catch { return id; } },
      // Phase 12: 임플란트 tooltip — stat names from progression, owned counts (bag + 창고) for the repair chips
      getStatName: (id) => { try { return this.ctx.progression?.getStatDef(id)?.name ?? id; } catch { return id; } },
      countOwned: (defId) => this.sys.countDefAll(defId),
      // 2026-09-09: weapon gauges — bare def stats (white layer + catalog maxima), the weapon defs to scan, the
      // ammo item of a calibre for the corner thumbnail (catalog scanned per call; the card is built on hover only)
      getBaseStats: (defId) => this.sys.getLoot().getEffectiveStats(defId),
      allWeaponItemDefs: () => this.sys.getLoot().getAllItemDefs().filter((d) => d.weaponId !== undefined),
      findAmmoDef: (type) => this.sys.getLoot().getAllItemDefs().find((d) => d.category === 'ammo' && d.ammoType === type),
      // 2026-09-12: `getDurabilityBucket` · `canSalvage` 는 빠졌다 — 카드의 `구간` 줄이 내구도 게이지로 대체됐다
    });
    this.ghostLayer = document.createElement('div');
    this.ghostLayer.className = 'inv-ghost-layer';
    /*
     * 2026-09-14 (사용자 결정): **툴팁 고정.** 타일(격자 · 장비칸 · 휠 · 주머니 · 상자/시체 창)을 움직이지 않고 1초 누르면 그 툴팁이
     * 제자리에 선다 (`ui/TipPin` — 누르기는 `Drag.beginPress` 가 건다). 고정 카드는 떠다니는 카드 **뒤** DOM 이고(첫 `.inv-tooltip` 은
     * 여전히 떠다니는 카드다 — 스모크들이 그렇게 찾는다) z 가 한 칸 낮아, 고정한 채 다른 아이템에 올린 비교 카드가 그 위에 뜬다.
     * 고정한 무기 카드의 소켓은 가방 · 창고 · 주머니 칸이나 (레이드의) 버리기로 끌어낸다.
     */
    this.pin = new TipPin(this.ctx, inventoryTooltipLookups(this.sys, this.ctx), {
      owner: 'inventory',
      mount: () => { /* appended with the window below, right before the floating card */ },
      hoverTip: this.tooltip,
      pinAnchor: () => (this.tooltip.el.hidden ? null : this.tooltip.el.style.transform || null),
      buildGhost: (item, def) => Drag.buildSocketGhost(this, item, def),
      ghostParent: this.ghostLayer,
      locate: (uid) => this.sys.locate(uid),
      canDetach: (uid) => this.sys.canDetachSockets(uid),
      aimDetach: (px, py, d) => Drag.aimDetach(this, px, py, d),
      clearDetachAim: () => Drag.clearDetachAim(this),
      detach: (d, target) => this.sys.detachSocket(d.weaponUid, d.socket, target),
      onSocketDrag: (active) => { this.root?.classList.toggle('is-dragging', active); },
    });

    /*
     * 2026-09-07 UI/UX: the footer reserves a **fixed height** so the drop zone appearing at drag start cannot move the
     * panels above it (it used to be a sibling of the centred column and every panel jumped up ~13 px).
     * 2026-09-14: the hint pill bar that shared this slot is gone — the footer holds the drop zone alone.
     */
    const footer = document.createElement('div');
    footer.className = 'inv-footer';
    footer.append(dropZone);

    root.append(this.tabsEl, this.creditsEl, layout, this.screenHost, this.screenNote, footer,
      this.modelessLayer, this.tooltip.el, this.pin.el, this.ghostLayer);
    this.menu = new ContextMenu(root);
    // 2026-09-09: the 수량 지정 dialog is its own 키 가이드 owner (`Enter 확인`) stacked over the window's line
    this.dialog = new SplitDialog(root, (open) => this.ctx.bus.emit('ui:keyGuide', { owner: 'inventory.split', keys: open ? [{ key: 'Enter', label: '확인' }] : null }));
    this.ctx.uiRoot.appendChild(root);
    // key labels follow the live bindings
    this.ctx.bus.on('input:bindingsChanged', () => { this.refreshKeyLabels(); this.emitGuide(); });
    // 2026-09-08: 튜토리얼이 감춘 화면 탭 · 레시피는 단계가 넘어가거나 건너뛰어지는 즉시 돌아온다
    // 2026-09-09: the stash grid's `version` does not move when the 단계 does, so the hidden-item sweep is forced here
    this.ctx.bus.on('tutorial:changed', () => { this.markTab(); this.stashView.refresh(true); this.refresh(); });
    // 2026-09-12 (E1): 즐겨찾기 — 격자 타일은 `GridView.refresh` 가 리비전을 보고 다시 칠하고, 한 번 만든 카탈로그 타일은 표시만 고친다
    this.ctx.bus.on('inventory:favoritesChanged', () => this.onFavoritesChanged());
  }

  /* ── 2026-09-12 (E1): 즐겨찾기 ─────────────────────────────────────────── */

  private favRefreshQueued = false;

  /** Several `inventory:favoritesChanged` in one go (a server document) repaint once. */
  private onFavoritesChanged(): void {
    if (this.favRefreshQueued) return;
    this.favRefreshQueued = true;
    queueMicrotask(() => {
      this.favRefreshQueued = false;
      if (!this.root) return;
      this.catalogView.refreshFavorites();
      this.refresh();
    });
  }

  /**
   * 2026-09-13 (서재 시리즈): 「아직 꽂지 않은」 띠의 답이 바뀌었다 (`parts/ShelfWanted` 가 캐시를 비운 뒤 한 번 부른다).
   * 격자 타일은 `GridView.refresh` 가 리비전을 보고 다시 칠하고, 한 번 만든 카탈로그 타일은 클래스만 고친다.
   */
  onShelfWantedChanged(): void {
    if (!this.root) return;
    this.catalogView.refreshFavorites();
    this.refresh();
  }

  /** The context menu's 「즐겨찾기 켜기 / 끄기」. */
  toggleFavoriteFromMenu(defId: string): void {
    this.sys.toggleFavorite(defId);
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  private refreshKeyLabels(): void {
    for (const sv of this.slots.values()) if (sv.key) sv.key.textContent = slotKeyLabel(sv.slot);
    this.quickKey.textContent = keyLabel(Keys.QUICK);
    const dz = this.dropZone.querySelector<HTMLElement>('.inv-key-drop');
    if (dz) dz.textContent = keyLabel(Keys.DROP_ITEM);
  }

  /* ── 키 가이드 (2026-09-09) ────────────────────────────────────────────── */

  /**
   * Keys the window's active tab really answers to, for the bottom-right 키 가이드 (`ui:keyGuide`, owner
   * `'inventory'`). Labels are read live (`keyLabel`), so this is re-emitted on `input:bindingsChanged` and on every
   * tab change; the guide appends `Tab 닫기` itself, so the close key is never listed here. The embedded 캐릭터 / 기업 /
   * 함선 tabs are mouse-only → `[]` (the guide then shows the close entry alone).
   *
   * **2026-09-14 (사용자 결정):** 중앙 하단의 `.inv-hints` 알약 바를 없애면서 그 줄에만 있던 **마우스 보조 조작**이
   * 여기로 왔다 — `Shift + 드래그 절반` · `Ctrl + 드래그 하나` (`combo` 라 keycap 두 개가 작은 `+` 로 이어진다).
   * 옛 줄의 `드래그→무기`(부착) · `드래그→퀵슬롯`(등록)은 **일부러 뺐다**: 끌고 가면 그 칸이 초록으로 켜져 스스로
   * 알려 주는 조작이고, 아홉 항목이면 한 줄이 1280 px 화면의 가로를 넘긴다 (가이드는 `white-space: nowrap` 이다).
   * 안 보이는 것(수식 키)이 먼저다.
   *
   * **2026-09-15 (사용자 결정):** 우클릭 · 휠클릭은 글자가 아니라 `RMB` · `MMB` 라벨로 넘겨 키 가이드가 **마우스 그림**으로 그린다
   * (`shared/keycap`). 둘 다 리바인딩과 무관한 실제 버튼이라(`contextmenu` · `MIDDLE_BUTTON`) `Keys` 가 아니라 `Mouse2` · `Mouse1` 이다.
   * 절반 · 하나 줄은 `+ 드래그` 를 뺐다 — `Shift 절반` · `Ctrl 하나`.
   */
  guideKeys(): KeyGuideEntry[] {
    if (this.activeTab !== 'inventory') return [];
    return [
      { key: keyLabel(Keys.ROTATE_ITEM), label: '회전' },
      // X: 임무에서는 바닥에 버리고, 함선에서는 창고로 보낸다 (`InventorySystem.dropItem`)
      { key: keyLabel(Keys.DROP_ITEM), label: this.hub ? '창고로' : '버리기' },
      // 2026-09-12 (E1): 빠른 이동은 더블클릭, 우클릭은 모든 아이템에 메뉴 (즐겨찾기 포함)
      { key: '더블클릭', label: '빠른 이동' },
      { key: keyLabel('Mouse2'), label: '메뉴' },
      { key: keyLabel('Mouse1'), label: '요청' },
      { key: 'Shift', label: '절반' },
      { key: 'Ctrl', label: '하나' },
    ];
  }

  /** Emit the window's 키 가이드 line (no-op while hidden — `hide()` sends the `null` instead). */
  emitGuide(): void {
    if (!this.visible) return;
    this.ctx.bus.emit('ui:keyGuide', { owner: 'inventory', keys: this.guideKeys() });
  }

  /**
   * Close the context menu / split dialog / modeless popups if open. Returns true when something was closed, so the
   * system's Escape handler consumes that press instead of closing the whole window (Phase 8: the 임플란트 picker,
   * the 필드 제작 panel and the 분해 dialog all sit in this chain — none of them owns a blocker of its own).
   */
  closeOverlays(): boolean {
    const c = this.closePopups();
    const e = this.craftPanel?.isOpen ? (this.closeCraft(), true) : false;
    return c || e;
  }

  /**
   * The **popups only** — split dialog, right-click context menu, 분해 dialog — without the 제작 column.
   *
   * 2026-09-08: Escape cancels the innermost popup first and otherwise falls through. **2026-09-09 (ESC 닫기)**:
   * 떨어진 그 Escape 는 이제 창을 닫는다 (`shared/escape` 의 맨 위 항목 = 이 창), 예전에는 일시정지 메뉴였다.
   * 어느 쪽이든 팝업 우선 규칙은 그대로다. The 제작 column is a column of the window (its own 제작 button toggles
   * it), not a popup, so it goes with the window.
   */
  closePopups(): boolean {
    const a = this.dialog?.close() ?? false;
    const b = this.menu?.close() ?? false;
    // 2026-09-12 (E1): 즐겨찾기 분해 확인 카드가 떠 있으면 Escape · Tab 은 그 카드만 물린다 (분해 창은 남는다)
    const d = (this.disassemble?.cancelConfirm() ?? false) || (this.disassemble?.close() ?? false);
    const r = this.repair?.close() ?? false;
    const f = this.implantPanel?.closePickers() ?? false;   // 2026-09-08: 임플란트 피커도 Escape 한 번을 먹는다
    return a || b || d || f || r;
  }

  show(container: Container | null, hub = false): void {
    if (!this.root) return;
    if (this.closeTimer !== null) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    this.container = container;
    this.hub = hub;
    this.root.classList.toggle('is-hub', hub);
    // screen tabs are a ship affordance — outside the hub the pill used to draw over the crate window (Phase 8 fix)
    this.tabsEl.hidden = !hub;
    this.setTab('inventory');
    this.markTab();
    this.containerPanel.hidden = !container;
    this.stashPanel.hidden = !hub;
    this.creditsEl.hidden = !hub;
    if (container) {
      if (container.title) {
        // caller-supplied contents (corpses etc.): custom title, no tier eyebrow
        this.containerTitle.textContent = container.title;
        this.containerTier.textContent = container.id.startsWith('corpse:') ? 'REMAINS' : 'CONTAINER';
      } else {
        this.containerTitle.textContent = tierTitle(container.tier);
        this.containerTier.textContent = `SUPPLY CACHE · TIER ${container.tier}`;
      }
      this.containerView.setGrid(container.grid);
    } else {
      this.containerView.setGrid(null);
    }
    this.containerScroll.scrollTop = 0;   // C-60: every opened container starts at its first row
    this.stashView.setGrid(hub ? this.sys.getStash() : null);
    this.bagView.setGrid(this.sys.getGrid('bag'));
    this.refreshPouch();
    this.setCatalog(this.sys.isCatalogOpen);   // 2026-09-13: also syncs the `.is-catalog` layout class
    this.root.hidden = false;
    this.visible = true;
    this.refresh();
    // C-60 (2026-09-11 수정): 여기서 **한 번 직접** 잰다 — 아래 주석 참고
    this.syncContainerScroll();
    this.emitGuide();
    // force a style flush so the enter transition plays
    void this.root.offsetWidth;
    this.root.classList.add('is-visible');
  }

  hide(): void {
    if (!this.root || !this.visible) return;
    this.visible = false;
    this.cancelDrag();
    this.closeOverlays();          // the popups / 제작 열 drop their own 키 가이드 owners first …
    this.setTab('inventory');
    this.tooltip.hide();
    this.pin.cancelHold();   // 2026-09-14: a closing window drops the pinned card (and a hold in progress)
    this.pin.unpin();
    this.hovered = null;
    // 2026-09-16: 필터 목록은 `document.body` 의 자식이라 창이 사라져도 저 혼자 화면에 남는다 — 닫으면서 같이 치운다
    for (const f of this.filterChips) f.close();
    this.ctx.bus.emit('ui:keyGuide', { owner: 'inventory', keys: null });   // … then the window's line goes
    this.root.classList.remove('is-visible');
    const root = this.root;
    this.closeTimer = window.setTimeout(() => { root.hidden = true; this.closeTimer = null; }, 180);
  }

  /**
   * 2026-09-11 (C-60): `.is-scroll` on the container viewport while its grid is taller than the `max-height` — it only
   * reserves the scrollbar gutter, so a crate that fits keeps its exact old box. A `ResizeObserver` on the viewport and
   * the grid drives it while the window stands (grid rows grow, the window height changes).
   *
   * **2026-09-11 (수정) — 컨테이너를 바꾸는 자리에서는 옵저버를 기다리지 않는다.** 옵저버 콜백은 다음 프레임에
   * 오는데, 행이 늘어난 시체 창을 닫고 **곧바로** 평범한 상자를 열면 그 사이에 콜백이 한 번도 안 들어올 수 있다 —
   * 그러면 시체 창에서 붙은 `.is-scroll` 이 그대로 남아, 넘치지도 않는 6×4 상자가 스크롤바 자리 8 px 만큼 넓어진다
   * (`smoke-quickslots` 의 C-60 「보통 상자는 모양이 그대로다」가 간헐적으로 빨갛던 원인). 옵저버가 새 노드를
   * 못 보는 것이 아니다 — `containerView.el` 은 한 번 만들어져 교체되지 않는다. **다시 재는 사람이 없었을 뿐**이다.
   * 그래서 `show()` 와 `refresh()` 의 컨테이너 교체 가지가 여기를 직접 부른다 (`scrollHeight` 읽기가 레이아웃을
   * 동기로 밀어 주므로 그 자리에서 정답이 나온다). 옵저버는 창이 서 있는 동안의 변화만 맡는다.
   */
  syncContainerScroll(): void {
    const s = this.containerScroll;
    if (!s) return;
    s.classList.toggle('is-scroll', s.scrollHeight > s.clientHeight + 1);
  }

  /**
   * 2026-09-14 (작은 화면 칸 축소): 창 높이가 계단을 넘었을 때만 일한다 — `syncGridCell()` 이 `CELL` · `STEP` 을
   * 옮기고, 창의 `--inv-cell` 과 살아 있는 격자 넷이 같은 값으로 따라간다. 끌고 있는 중이면 보폭이 바뀌므로 취소한다.
   */
  private onViewportResize = (): void => {
    if (!this.root || !syncGridCell()) return;
    this.cancelDrag();
    applyGridCellVar(this.root);
    for (const view of [this.containerView, this.stashView, this.bagView, this.pouchView]) view?.setCell(CELL);
    this.syncContainerScroll();
  };

  dispose(): void {
    this.cancelDrag();
    if (this.hoverCheckRaf) { cancelAnimationFrame(this.hoverCheckRaf); this.hoverCheckRaf = 0; }
    window.removeEventListener('resize', this.onViewportResize);
    this.scrollObserver?.disconnect();
    this.scrollObserver = null;
    this.menu?.dispose();
    this.dialog?.dispose();
    this.containerView.dispose();
    this.stashView.dispose();
    this.bagView.dispose();
    this.pouchView?.dispose();
    this.catalogView?.dispose();
    this.screenView?.dispose();
    this.screenView = null;
    this.craftPanel?.dispose();
    this.disassemble?.dispose();
    this.repair?.dispose();
    this.implantPanel?.dispose();   // the two pickers are `ctx.uiRoot` children — they must go with the window
    this.pin?.dispose();
    for (const f of this.filterChips) f.dispose();   // 2026-09-16: 떠 있는 필터 목록은 창의 자식이 아니다
    this.filterChips.length = 0;
    this.tooltip.dispose();
    this.root?.remove();
    this.root = null;
  }

  /* ── screen tabs ───────────────────────────────────────────────────────── */

  private onTab(tab: ScreenTab): void { return Screens.onTab(this, tab); }

  /** The tab currently shown (smoke tests). */
  get screenTab(): ScreenTab { return this.activeTab; }

  /**
   * Select a screen tab from outside (`InventorySystem.openScreen`, e.g. the ship's 기업 네트워크 console). Returns
   * true when that tab is what the window ends up showing — `setTab` falls back to 인벤토리 outside the hub or when
   * the owning folder has no view.
   */
  showScreenTab(tab: ScreenTab): boolean { return Screens.showScreenTab(this, tab); }

  /**
   * Swap the window content. `inventory` shows `.inv-layout`; every other tab hides it, shows the `.inv-screen`
   * host and builds that folder's `EmbeddedView` into it. The old view is always disposed first, so exactly one
   * view exists at a time and nothing survives a window close.
   */
  setTab(tab: ScreenTab): void {
    if (tab !== this.activeTab) this.pin?.unpin();   // 2026-09-14: the pinned item's grid leaves the screen with its tab
    return Screens.setTab(this, tab);
  }

  /** `createSheetView` / `createCorpView` / `createShipView`; null when that system is not present. */
  buildScreenView(tab: ScreenTab): EmbeddedView | null { return Screens.buildScreenView(this, tab); }

  markTab(): void { return Screens.markTab(this); }

  /** `크레딧 n` readout on the ship screen (`ctx.meta.credits`; refreshed on `meta:creditsChanged`). */
  refreshCredits(): void { return Screens.refreshCredits(this); }

  /* ── refresh ───────────────────────────────────────────────────────────── */

  refresh(): void {
    if (!this.root || this.root.hidden) return;
    /*
     * 2026-09-12 (사용자 결정): 내게 **필요한 탄약**에만 우상단 사선 띠. 표는 `ui/GridView` 가 들고 있고 여기서
     * 갈아 끼운다 — 바뀌었을 때만 true 이므로 무기를 바꾼 프레임에만 타일을 통째로 다시 그린다.
     */
    // 2026-09-12 (아이템 회수 계약): the ribbon's scope is refreshed here too (the system also does it every frame) —
    // evaluated first so both tables are updated even when the ammo table changed
    const recoveryChanged = setRecoveryScope(this.sys.raidFoundScope());
    if (setNeededAmmoFrom(this.sys.getLoadout(), (item) => this.sys.getStats(item)) || recoveryChanged) {
      this.bagView.refresh(true);
      this.stashView.refresh(true);
      this.pouchView.refresh(true);
      this.containerView.refresh(true);
    }
    const bag = this.sys.getGrid('bag');
    if (bag) {
      if (this.bagView.current !== bag) this.bagView.setGrid(bag);
      else this.bagView.refresh();
      // 2026-09-08: used / total cells only. The `5×3` grid size and the `퀵슬롯 n` count both restate what the
      //   grid and the rose right below already draw.
      this.bagCapacity.textContent = capacityLabel(bag.usedCells(), bag.cols * bag.rows);
      this.valueEl.textContent = fmtValue(bag.totalValue() + this.equippedValue());
    }
    const c = this.sys.getActiveContainer();
    if (c !== this.container) {
      this.container = c;
      this.containerPanel.hidden = !c;
      this.containerView.setGrid(c ? c.grid : null);
      this.containerScroll.scrollTop = 0;
      this.syncContainerScroll();   // C-60: 컨테이너가 바뀌는 그 자리에서 다시 잰다 (옵저버를 기다리지 않는다)
    } else if (c) {
      this.containerView.refresh();
      this.containerPanel.classList.toggle('is-empty', c.grid.isEmpty);
    }
    this.containerView.setPending(this.sys.pendingTakeUids());
    this.refreshSearchStatus();
    if (this.hub) {
      const stash = this.sys.getStash();
      if (this.stashView.current !== stash) this.stashView.setGrid(stash);
      else this.stashView.refresh();
      // 2026-09-16 (사용자 결정): **사용칸 / 전체칸만.** 앞에 붙던 아이템 종류 수(`stash.count`)는 격자가 이미
      //   그리고 있는 것을 숫자로 한 번 더 적는 줄이었고, 창고에서 궁금한 것은 「얼마나 찼나」 하나다.
      this.stashCount.textContent = capacityLabel(stash.usedCells(), stash.cols * stash.rows);
      this.refreshCredits();
    }
    // 2026-09-16: 창고 업그레이드는 함선 기능 — `ctx.housing` 이 없으면 부를 데가 없으니 버튼을 지운다
    this.stashUpgradeBtn.hidden = !this.ctx.housing;
    /*
     * 2026-09-14: `모두 수리` 는 **함선에서만** — 레이드 중에는 `benchRepairRows` 가 빈 목록이라 버튼도 숨긴다.
     * 고칠 것이 하나도 없으면 딤드로 남긴다 (없앴다 나타나면 칩 줄의 자리가 흔들린다).
     */
    this.repairAllBtn.hidden = this.ctx.isRaidActive();
    if (!this.repairAllBtn.hidden) {
      const worn = this.sys.benchRepairRows(true).length;
      this.repairAllBtn.disabled = worn === 0;
      this.repairAllBtn.title = worn === 0 ? TEXT.bench.repairNone : TEXT.bench.repairAll;
    }
    // 2026-09-16: `모두 창고로 이동` — 창고가 있는 함선 창에서만; 가방 격자가 비면 딤드 (없앴다 나타나면 줄이 흔들린다)
    this.bagToStashBtn.hidden = !this.hub || this.ctx.isRaidActive();
    if (!this.bagToStashBtn.hidden) {
      const empty = (bag?.count ?? 0) === 0;
      this.bagToStashBtn.disabled = empty;
      this.bagToStashBtn.title = empty ? TEXT.bagToStash.empty : TEXT.bagToStash.title;
    }
    this.refreshSlots();
    this.refreshQuick();
    this.refreshPouch();
    this.refreshWeight();
    this.implantPanel.refresh();
    this.craftPanel.refresh();
    if (this.disassemble.isOpen) this.disassemble.refresh();
    if (this.repair.isOpen) this.repair.refresh();
    // Phase 8: an embedded 캐릭터 / 기업 / 함선 view repaints from its own state whenever the window does
    if (this.screenView) { try { this.screenView.refresh(); } catch (e) { console.warn('[inventory] screen refresh failed', e); } }
    this.pin.validate();   // 2026-09-14: the pinned card follows its item (gone → unpinned, sockets changed → redrawn in place)
    this.validateHover();  // 2026-09-15: a tile that left from under the cursor takes its hover card with it
  }

  /* ── Phase 7: container search (감정) ──────────────────────────────────── */

  /**
   * Gauge on the item being searched (`.inv-tile-scan`, `--p` 0..100 %); `active` false = the player stepped out of
   * `SEARCH_MAX_DISTANCE` (readout dims). Called every frame by the system — cheap (one custom property).
   */
  setSearchProgress(uid: string | null, progress: number, active: boolean): void {
    if (!this.root || this.root.hidden) return;
    this.containerView.setScan(uid, progress);
    this.searchStatus.classList.toggle('is-paused', uid !== null && !active);
  }

  /** Header readout: hidden without a container; `감정 중 · n개 남음` while items are hidden, `감정 완료` afterwards. */
  refreshSearchStatus(): void {
    if (!this.root) return;
    const c = this.sys.getActiveContainer();
    if (!c) { this.searchStatus.hidden = true; return; }
    const left = this.sys.unsearchedCount();
    this.searchStatus.hidden = false;
    this.searchStatus.textContent = left > 0 ? TEXT.search.status(left) : TEXT.search.done;
    this.searchStatus.classList.toggle('is-done', left === 0);
    this.containerPanel.classList.toggle('is-searching', left > 0);
  }

  /** Shake a tile from outside the drag flow (a host-denied take). */
  shakeItem(uid: string, loc: ItemLocation): void { this.shake(loc, uid); }

  /* ── 2026-09-14: 폴백 배치 플래시 ──────────────────────────────────────── */

  /**
   * **어디로 들어갔는지 그 칸이 직접 말한다** (사용자 결정). 상자 · 시체 더블클릭이 가방에 못 넣고 빈 장비칸 ·
   * 임플란트 칸 · 빈 퀵슬롯으로 밀어 넣었을 때, 예전에는 `가방이 가득 찼습니다 — …` 토스트가 화면 구석에 떴다.
   * 이제 실제로 들어간 칸이 잠깐 초록으로 번쩍인다 (`.is-flash`, `inventory.css` 의 `inv-slot-flash` 키프레임).
   *
   * 드래그 중의 `is-target-ok` 와 **다른 클래스**여야 한다 — 드래그 프리뷰가 매 프레임 그 클래스를 지우므로
   * 같은 이름을 쓰면 플래시가 첫 프레임에 사라진다. 애니메이션이 끝나면 스스로 뗀다 (`animationend`,
   * 애니메이션을 못 트는 환경을 위해 타이머 보험도 같이 건다).
   */
  private flash(el: HTMLElement | null | undefined): void {
    if (!el) return;
    el.classList.remove('is-flash');
    void el.offsetWidth;   // restart the animation when the same slot flashes twice in a row
    el.classList.add('is-flash');
    const off = (): void => { el.classList.remove('is-flash'); el.removeEventListener('animationend', off); };
    el.addEventListener('animationend', off);
    window.setTimeout(off, FLASH_MS);
  }

  /** 장비 칸 (주무기 I · II · 가방 · 방탄복 · 주머니). */
  flashSlot(slot: SlotId): void { this.flash(this.slots.get(slot)?.el); }

  /** 퀵슬롯 휠 칸. */
  flashQuick(index: number): void { this.flash(this.quickCell(index)); }

  /** 임플란트 장착칸 — 칸 하나가 아니라 그 블록(`.inv-impitems`)이 번쩍인다 (`equipImplant` 는 자리를 안 알려 준다). */
  flashImplant(): void {
    const root = this.implantPanel?.root;
    this.flash(root?.querySelector<HTMLElement>('.inv-impitems') ?? root);
  }

  /**
   * Phase 10: another member's take was confirmed — let the container tile animate out on the next `refresh()`
   * instead of blinking away. Also cancels a drag of that very item (it is not ours any more).
   */
  vanishContainerItem(uid: string): void {
    if (!this.root || this.root.hidden) return;
    if (this.drag?.uid === uid) this.cancelDrag();
    this.containerView.vanish(uid);
  }

  /** An unsearched container item: no tooltip, drag, menu or double-click (Phase 7). */
  locked(uid: string, loc: ItemLocation): boolean { return this.sys.isItemLocked(uid, loc); }

  /* ── appended: tactical kit — weight / crafting ────────────────────────── */

  private refreshWeight(): void {
    const w = this.sys.getWeight();
    this.weightValue.textContent = `${fmtKg(w.weight)} / ${fmtKg(w.capacity)}`;
    this.weightState.textContent = weightLabel(w.state);
    this.weightFill.style.width = `${Math.round(Math.min(1, w.ratio) * 100)}%`;
    this.weightEl.classList.toggle('is-light', w.state === 'light');
    this.weightEl.classList.toggle('is-heavy', w.state === 'heavy');
    this.weightEl.classList.toggle('is-over', w.state === 'over');
  }

  toggleCraft(): void { return Screens.toggleCraft(this); }

  /**
   * System-driven craft panel visibility (`openBenchCraft` / `closeBench`).
   *
   * **2026-09-07**: the panel is a **column of the window** again instead of a modeless popup — `.inv-layout.is-craft`
   * puts the recipe list leftmost (where 함선 창고 sits otherwise) and stacks 가방 over 함선 창고 on the right, so the
   * materials a recipe needs are visible next to it. Still no blocker and no pointer-lock change: the window owns both.
   */
  setCraftOpen(open: boolean): void { return Screens.setCraftOpen(this, open); }

  /** The panel's 닫기 button / Escape / an outside click: leave the bench too when one is active. */
  closeCraft(): void { return Screens.closeCraft(this); }

  /** Repaint the craft rows (progress / counts) without rebuilding the rest of the window. */
  refreshCraft(): void { return Screens.refreshCraft(this); }

  /* ── Phase 6: 무한 상자 ─────────────────────────────────────────────── */

  /** Show / hide the catalog panel (system state lives in `InventorySystem.isCatalogOpen`). */
  setCatalog(open: boolean): void { return Screens.setCatalog(this, open); }

  /** Catalog panel (smoke tests / tab & search control). */
  get catalog(): CatalogView { return this.catalogView; }

  /** Double-press on a catalog tile: a fresh instance straight into the bag. */
  catalogTake(def: ItemDef): void { return Screens.catalogTake(this, def); }

  /** Last catalog press (double-press detection: a second press on the same tile within `CATALOG_DBL_MS` = 가방에 넣기). */
  lastCatalogPress: { defId: string; t: number } | null = null;

  /**
   * Press on a catalog tile: mint a fresh instance and drag it like any other item (the tile stays). A second press
   * on the same tile within `CATALOG_DBL_MS` counts as the double-click (`takeFromCatalog`) — detected here because
   * the cancelled pointerdown keeps Chrome from synthesising `dblclick` reliably.
   */
  private beginCatalogPress(def: ItemDef, sample: ItemInstance, e: PointerEvent, tileEl: HTMLElement): void { return Screens.beginCatalogPress(this, def, sample, e, tileEl); }

  /**
   * Grid cell a ghost of `w × h` at (left, top) would land on, resolved **strictly first**: a grid that actually
   * contains the pointer always wins over one that only sits within its half-cell tolerance. The two-pass order is
   * what stopped 가방 and 함선 창고 (stacked with a small gap since the 2026-09-07 pass) from stealing each other's
   * edge rows — `activeViews()` is ordered 창고 → 가방, so the padded box of the stash used to swallow drops the
   * player aimed at the bag's last row.
   */
  resolveGridTarget(views: GridView[], left: number, top: number, w: number, h: number, px: number, py: number): { view: GridView; x: number; y: number } | null { return Drag.resolveGridTarget(this, views, left, top, w, h, px, py); }

  /** Drag targets of a catalog instance: equipment slots, then the active grids (never the wheel / sockets / world). */
  updateCatalogTarget(d: DragState, px: number, py: number): void { return Screens.updateCatalogTarget(this, d, px, py); }

  /* ── quick-use wheel panel ─────────────────────────────────────────────── */

  /** 3×3 compass rose (N top, clockwise) + a legend column; cells the bag has not unlocked (`isQuickSlotActive`) are locked. */
  private buildQuickPanel(): HTMLElement { return QuickUI.buildQuickPanel(this); }

  private refreshQuick(): void { return QuickUI.refreshQuick(this); }

  bindQuickTile(el: HTMLElement, cell: QuickCell): void { return QuickUI.bindQuickTile(this, el, cell); }

  /* ── 주머니 격자 (2026-09-11, A-15) ────────────────────────────────────── */

  /**
   * 장착한 주머니가 있으면 퀵슬롯 아래에 그 격자를 그리고, 없으면 블록을 통째로 감춘다.
   * 제목은 `<주머니 이름> · <받는 종류>` 한 줄이다 (`TEXT.pouch.line`).
   */
  private refreshPouch(): void {
    const item = this.sys.getEquippedPouch();
    const def = item ? ITEM_DEF_MAP.get(item.defId) : undefined;
    const size = this.sys.getPouchSize();
    const show = !!item && !!def?.pouch && size.cols > 0 && size.rows > 0;
    this.pouchPanel.hidden = !show;
    if (!show || !def?.pouch) { if (this.pouchView.current) this.pouchView.setGrid(null); return; }
    const grid = this.sys.getGrid('pouch');
    if (this.pouchView.current !== grid) this.pouchView.setGrid(grid);
    else this.pouchView.refresh();
    this.pouchTitle.textContent = TEXT.pouch.line(def.name, pouchAcceptsLabel(def.pouch.accepts));
  }

  /** Right-click on a wheel cell: `빠른 슬롯 해제` (assigned cells only). */
  onQuickContextMenu(index: number, e: MouseEvent): void { return Menu.onQuickContextMenu(this, index, e); }

  /** Wheel cell under the pointer (null when not over the rose). */
  quickCellAt(x: number, y: number): QuickCell | null { return QuickUI.quickCellAt(this, x, y); }

  /** The wheel cell element for `index` (drag / shake feedback since 2026-09-09). */
  quickCell(index: number): HTMLElement | null { return this.quickCells.find((c) => c.index === index)?.el ?? null; }

  /**
   * Credit value of everything in the equipment slots (2026-09-08). The 가치 readout under the bag used to count
   * only what was *in* the bag, so equipping a rifle made the number you are carrying out of the raid drop.
   */
  equippedValue(): number {
    const loadout = this.sys.getLoadout();
    let v = 0;
    for (const slot of LOADOUT_SLOTS) {
      const item = loadout[slot];
      if (!item) continue;
      const def = ITEM_DEF_MAP.get(item.defId);
      if (def) v += def.value * Math.max(1, item.qty);
    }
    return v;
  }

  private refreshSlots(): void { return SlotUI.refreshSlots(this); }

  private buildSlot(slot: SlotId, label: string): SlotView { return SlotUI.buildSlot(this, slot, label); }

  bindSlotTile(el: HTMLElement, sv: SlotView): void { return SlotUI.bindSlotTile(this, el, sv); }

  /* ── 2026-09-12: 자동 정렬 · 필터 ─────────────────────────────────────── */

  /** `정렬` in the 가방 / 창고 header. A drag in progress is dropped first (its source may move). */
  /**
   * 2026-09-16: `모두 창고로 이동` 버튼. 다 들어가면 소리만, 자리가 모자라 남은 것이 있으면 토스트 한 번
   * (`창고에 공간이 없습니다 (n개 남음)`). 준비 상태 잠금은 시스템의 `readOnlyBlocked` 가 스스로 알린다.
   */
  moveBagToStash(): void {
    this.cancelDrag();
    this.menu?.close();
    const blocked = this.sys.readOnlyReason() !== null;
    const r = this.sys.moveBagToStash();
    if (blocked) { this.sys.sfx('ui_error'); return; }
    if (r.moved > 0) this.sys.sfx('ui_drop');
    if (r.left > 0) {
      if (r.moved === 0) this.sys.sfx('ui_error');
      this.ctx.bus.emit('ui:notify', { text: TEXT.bagToStash.left(r.left), kind: 'warning', duration: 2.2 });
    }
  }

  sortGrid(id: 'bag' | 'stash'): void {
    this.cancelDrag();
    this.menu?.close();
    const r = this.sys.sortGrid(id);
    if (r === 'ok') this.sys.sfx('ui_drop');
    else if (r === 'fail') {
      this.sys.sfx('ui_error');
      this.ctx.bus.emit('ui:notify', { text: '정렬할 자리가 부족합니다 — 격자를 조금 비워 주세요', kind: 'warning', duration: 2.2 });
    }
  }

  /** Pick a filter chip: every grid of the window dims what the group does not contain. */
  setFilterGroup(id: FilterGroupId): void {
    this.filterGroup = id;
    const pred = filterPredicate(id, (defId) => this.sys.isFavorite(defId));   // 2026-09-12 (E1): 「즐겨찾기」 칩
    this.bagView.setFilter(pred);
    this.stashView.setFilter(pred);
    this.pouchView.setFilter(pred);
    for (const c of this.filterChips) c.set(id);
  }

  /* ── grid routing ──────────────────────────────────────────────────────── */

  viewOf(grid: GridId): GridView {
    if (grid === 'bag') return this.bagView;
    if (grid === 'stash') return this.stashView;
    if (grid === 'pouch') return this.pouchView;
    return this.containerView;
  }

  /**
   * Grids that accept drops right now (crate + bag on a mission, stash + bag in the ship).
   * 2026-09-11 (A-15): the 주머니 joins the list **only while its block is drawn** — a hidden grid must never
   * swallow a drop the player aimed at the bag.
   */
  activeViews(): GridView[] {
    const out: GridView[] = [];
    if (this.container) out.push(this.containerView);
    if (this.hub) out.push(this.stashView);
    // 2026-09-13: the 무한 상자 layout hides the pouch block with CSS (`.is-catalog`), not `hidden` — check both
    if (!this.pouchPanel.hidden && !this.catalogView.isOpen) out.push(this.pouchView);
    out.push(this.bagView);
    return out;
  }

  /* ── tile handlers ─────────────────────────────────────────────────────── */

  private tileHandlers() {
    return {
      onPointerDown: (uid: string, gridId: GridId, e: PointerEvent) => {
        const el = this.viewOf(gridId).tileEl(uid);
        if (el) this.beginPress(uid, { kind: 'grid', grid: gridId }, e, el);
      },
      onEnter: (uid: string, gridId: GridId, e: PointerEvent) => this.hoverEnter(uid, { kind: 'grid', grid: gridId }, e),
      onMove: (_uid: string, _gridId: GridId, e: PointerEvent) => this.tooltip.move(e.clientX, e.clientY),
      onLeave: () => this.hoverLeave(),
      onContext: (uid: string, gridId: GridId, e: MouseEvent) => {
        if (this.drag || performance.now() < this.suppressClicksUntil) return;
        this.onContextMenu(uid, { kind: 'grid', grid: gridId }, e);
      },
      onDblClick: (uid: string, gridId: GridId) => {
        if (this.drag?.started || performance.now() < this.suppressClicksUntil) return;
        const from: ItemLocation = { kind: 'grid', grid: gridId };
        if (this.locked(uid, from)) return;
        const item = this.sys.findItem(uid, from);
        const def = item && ITEM_DEF_MAP.get(item.defId);
        // a stim / grenade in the bag with no crate open: double-click registers it on the wheel
        if (def && isQuickUsable(def) && gridId === 'bag' && !this.sys.getActiveContainer()) {
          this.result(this.sys.registerQuick(uid), 'ui_equip', from, uid);
          return;
        }
        const equips = !!def && (isWeaponDef(def) || isBagDef(def) || isArmorDef(def));
        this.result(this.sys.activate(uid, from), equips ? 'ui_equip' : 'ui_drop', from, uid);
      },
    };
  }

  hoverEnter(uid: string, loc: ItemLocation, e: PointerEvent): void {
    this.lastPointerX = e.clientX; this.lastPointerY = e.clientY;
    if (this.drag?.started || this.pin.isSocketDragging) return;
    if (this.locked(uid, loc)) { this.hovered = null; this.tooltip.hide(); return; }
    this.hovered = { uid, loc };
    // 2026-09-14: the pinned item's own tile shows no second copy of its card (other items still get theirs — compare)
    if (this.pin.pinnedUid === uid) { this.tooltip.hide(); return; }
    const item = this.sys.findItem(uid, loc);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (item && def) this.tooltip.show(item, def, e.clientX, e.clientY);
  }

  hoverLeave(): void {
    this.hovered = null;
    this.tooltip.hide();
  }

  /**
   * 2026-09-15 (사용자 버그 「시체 창에서 더블클릭으로 옮긴 아이템의 툴팁이 마우스를 움직일 때까지 남는다」).
   *
   * **원인**: 호버 카드는 타일의 `pointerleave` 로만 내려간다. 그런데 빠른 이동(더블클릭 · 우클릭 메뉴 · 자동 배치)이 아이템을
   * 옮기면 `refresh()` 가 **커서 아래의 타일을 DOM 에서 떼어 내고**(`GridView` 의 `el.remove()` · 장비칸 / 휠 칸의 `innerHTML = ''`),
   * 떼어 낸 요소에는 브라우저가 `pointerleave` 를 보내지 않는다 — 다음 포인터 이동이 새 요소에 `pointerover` 를 보낼 뿐이다.
   * 그래서 `hovered` 가 이미 없는 타일을 가리킨 채 카드가 떠 있었고, 다른 타일에 들어가거나 창을 벗어날 때까지 남았다.
   * 시체 창에서 도드라진 것은 거기서의 더블클릭이 거의 늘 아이템을 **다른 칸으로** 보내기 때문이다(가방 → 가방 칸 이동은 같은 요소가 남는다).
   *
   * **고침**: 격자가 다시 그려질 때마다(`refresh()` 끝) + 결과를 낸 조작 다음 프레임(`result()`) 여기서 확인한다 — 호버 중인
   * 아이템이 아직 그 자리에 있고, 그 타일 요소가 연결돼 있고 사라지는 중이 아니며, **마지막 포인터 위치 아래에 그 타일이 있는가**.
   * 하나라도 아니면 카드를 내린다. 커서 아래에 새로 온 타일은 다음 포인터 이동에서 평소대로 `pointerenter` 를 받는다.
   * 떠다니는 기업 화면 · 스테이션 격자(`TradeGrids`)의 카드는 `ui/hud/ItemTip` 이라 거기서 같은 확인을 한다.
   */
  validateHover(): void {
    const h = this.hovered;
    if (!h || !this.root || !this.tooltip.isShowing || this.drag?.started) return;
    const host = this.hoverHostEl(h.uid, h.loc);
    let ok = !!host && host.isConnected && !host.classList.contains('is-vanishing') && !!this.sys.findItem(h.uid, h.loc);
    if (ok && host && this.lastPointerX >= 0) {
      const under = document.elementFromPoint(this.lastPointerX, this.lastPointerY);
      ok = !!under && host.contains(under);
    }
    if (!ok) this.hoverLeave();
  }

  /** One `validateHover` next frame (a quick move whose DOM repaint comes from an event handler that runs after us). */
  private scheduleHoverCheck(): void {
    if (this.hoverCheckRaf || typeof requestAnimationFrame !== 'function') return;
    this.hoverCheckRaf = requestAnimationFrame(() => { this.hoverCheckRaf = 0; this.validateHover(); });
  }

  /** The element whose `pointerenter` set `hovered` for this location — null when that tile is gone / holds another item. */
  private hoverHostEl(uid: string, loc: ItemLocation): HTMLElement | null {
    if (loc.kind === 'grid') return this.viewOf(loc.grid).tileEl(uid) ?? null;
    if (loc.kind === 'slot') { const sv = this.slots.get(loc.slot); return sv && sv.uid === uid ? sv.tile : null; }
    const cell = this.quickCells.find((c) => c.index === loc.index);
    return cell && cell.uid === uid ? cell.tile : null;
  }

  /** Result → sound + shake. `okSfx` is what plays on success; `pending` (host-confirmed take) stays silent until the answer. */
  result(r: 'ok' | 'noop' | 'fail' | 'pending', okSfx: 'ui_drop' | 'ui_equip' | 'ui_pickup' | 'ui_rotate', from: ItemLocation, uid: string): void {
    this.scheduleHoverCheck();   // 2026-09-15: the acted-on tile may have just left from under the cursor
    if (r === 'ok') this.sys.sfx(okSfx);
    else if (r === 'fail') { this.sys.sfx('ui_error'); this.shake(from, uid); }
  }

  shake(loc: ItemLocation, uid: string): void {
    if (loc.kind === 'grid') {
      this.viewOf(loc.grid).shake(uid);
    } else if (loc.kind === 'quick') {
      const cell = this.quickCell(loc.index);
      if (cell) {
        cell.classList.remove('is-shake');
        void cell.offsetWidth;
        cell.classList.add('is-shake');
        setTimeout(() => cell.classList.remove('is-shake'), 360);
      }
    } else {
      const sv = this.slots.get(loc.slot);
      if (sv?.tile) {
        sv.tile.classList.remove('is-shake');
        void sv.tile.offsetWidth;
        sv.tile.classList.add('is-shake');
        setTimeout(() => sv.tile?.classList.remove('is-shake'), 360);
      }
    }
  }

  /* ── right-click: quick action or context menu ─────────────────────────── */

  /**
   * Scheme: plain right-click on a weapon, a bag, armor, worn gear (ship) or a stack with qty ≥ 2 opens the menu; on
   * anything else it performs the quick action directly (container / stash ↔ bag / slot → bag). Shift+right-click
   * always opens the menu.
   */
  onContextMenu(uid: string, from: ItemLocation, e: MouseEvent): void { return Menu.onContextMenu(this, uid, from, e); }

  /**
   * Weapons: quick action (장착 / 주무기 II로 장착 / 가방으로 이동 / 상자로 이동 / 창고로 이동) · 수리 (ship, worn gear) ·
   * 장전된 탄약 모두 탈착 (ammo loaded) · 무기 소켓 모두 탈착 (any socket filled) · 탄약 요청 · 버리기 (mission only).
   * Bags / armor: 장착 / 가방으로 이동 · 요청 · 버리기. Attachments are socketed by drag only (no 장착 entry). Stacks add the split entries.
   */
  menuEntries(uid: string, from: ItemLocation, item: ItemInstance, def: ItemDef): MenuEntry[] { return Menu.menuEntries(this, uid, from, item, def); }

  /**
   * Phase 8 — 분해 is offered on player-owned items (bag / equipment slots) that have a `break_*` recipe; a
   * container stack must be taken first, because the recipe consumes from the bag.
   */
  canDisassemble(uid: string, from: ItemLocation): boolean { return Menu.canDisassemble(this, uid, from); }

  /** Open the modeless 분해 dialog for `uid` (expected result + a 분해 button). False when the item has no recipe. */
  openDisassemble(uid: string): boolean { return Menu.openDisassemble(this, uid); }

  /** The 분해 dialog (smoke tests). */
  get disassemblePanel(): DisassemblePanel { return this.disassemble; }

  split(uid: string, from: ItemLocation, qty: number): void { return Menu.split(this, uid, from, qty); }

  openSplitDialog(uid: string, from: ItemLocation): void { return Menu.openSplitDialog(this, uid, from); }

  dropToWorld(uid: string, from: ItemLocation, qty: number | undefined): void { return Menu.dropToWorld(this, uid, from, qty); }

  /* ── drop key (X) ──────────────────────────────────────────────────────── */

  /** X drops the dragged or hovered item; Shift+X one unit, Ctrl+X half the stack. In the ship the item lands in the stash. */
  onDropKey(shift: boolean, ctrl: boolean): void { return Drag.onDropKey(this, shift, ctrl); }

  /* ── rotation (R) ──────────────────────────────────────────────────────── */

  onRotateKey(): void { return Drag.onRotateKey(this); }

  /* ── drag & drop ───────────────────────────────────────────────────────── */

  beginPress(uid: string, from: ItemLocation, e: PointerEvent, tileEl: HTMLElement, quickFrom: number | null = null): void { return Drag.beginPress(this, uid, from, e, tileEl, quickFrom); }

  startDrag(d: DragState): void { return Drag.startDrag(this, d); }

  footprint(d: DragState): { w: number; h: number } { return Drag.footprint(this, d); }

  rebuildGhost(d: DragState): void { return Drag.rebuildGhost(this, d); }

  positionGhost(d: DragState, x: number, y: number): void { return Drag.positionGhost(this, d, x, y); }

  private handlePointerMove(e: PointerEvent): void { return Drag.handlePointerMove(this, e); }

  updateDragTarget(px: number, py: number): void { return Drag.updateDragTarget(this, px, py); }

  preview(d: DragState, target: DropTarget) { return Drag.preview(this, d, target); }

  /** Weapon tile under the pointer (the ghost layer ignores pointer events), excluding the dragged item itself. */
  weaponTileAt(x: number, y: number, exceptUid: string): { uid: string; loc: ItemLocation } | null { return Drag.weaponTileAt(this, x, y, exceptUid); }

  setSocketTarget(w: { uid: string; loc: ItemLocation }, state: 'ok' | 'bad'): void { return Drag.setSocketTarget(this, w, state); }

  clearSocketTarget(): void { return Drag.clearSocketTarget(this); }

  /** True when the point lies on a panel / equipment column (a miss there snaps back instead of dropping). */
  isOverPanel(x: number, y: number): boolean { return Drag.isOverPanel(this, x, y); }

  private handlePointerUp(e: PointerEvent): void { return Drag.handlePointerUp(this, e); }

  endDragVisuals(d: DragState): void { return Drag.endDragVisuals(this, d); }

  cancelDrag(): void { return Drag.cancelDrag(this); }
}
