import './../inventory.css';
import type { EmbeddedView, GameContext, ItemDef, ItemInstance, KeyGuideEntry } from '@/shared';
import { Keys, isQuickSlotActive, keyLabel } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { Container } from '../Container';
import { LOADOUT_SLOTS, isArmorDef, isBagDef, isWeaponDef, type DropTarget, type GridId, type InventorySystem, type ItemLocation, type SlotId } from '../InventorySystem';
import { BAG_FRAME_ROWS, filterPredicate, type FilterGroupId } from '../model';
import { buildFilterSelect, buildSortButton, type FilterControl } from './GridTools';
import { CraftPanel } from './CraftPanel';
import { CatalogView } from './CatalogView';
import { DisassemblePanel } from './DisassemblePanel';
import { RepairPanel } from './RepairPanel';
import { ImplantPanel } from './ImplantPanel';
import { isQuickUsable } from '../QuickSlots';
import { GridView, setNeededAmmoFrom, setRecoveryScope } from './GridView';
import { Tooltip } from './Tooltip';
import { TipPin, inventoryTooltipLookups } from './TipPin';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { SplitDialog } from './SplitDialog';
import { CELL, SLOT_LABEL, STEP, TEXT, applyGridCellVar, capacityLabel, fmtCreditNumber, pouchAcceptsLabel, slotKeyLabel, syncGridCell, tierTitle, fmtKg, weightLabel } from './labels';

import { CATALOG_DBL_MS, type DragState, MIDDLE_BUTTON, type QuickCell, SCREEN_TABS, type ScreenTab, type SlotView } from './model';
/** The folder's shared vocabulary (constants · types · scratch) lives in `model.ts` — re-exported for the existing import paths. */
export * from './model';

/**
 * 2026-09-14: insurance timer (ms) for the fallback placement flash to turn itself off. Longer than the
 * `inv-slot-flash` · `inv-quick-flash` animations in `inventory.css` (0.62 s) — the normal path is `animationend`.
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
  /** Layer that holds the modeless popups (the implant picker / 제작 / 분해) above `.inv-layout`. */
  private modelessLayer!: HTMLElement;
  /**
   * **The card that holds the bag pane** (`.inv-panel-grids` — the class name was kept for selector compatibility).
   *
   * In the 2026-09-15 2nd pass the stash + the bag were two panes inside this card, with the equipment column to their
   * left (equipment | stash | bag). **2026-09-16 (user's decision): the ship Tab is stash | equipment | bag.** The stash
   * pane (`.inv-panel-stash`) is a direct card of `.inv-layout` and stands left of the equipment column; in the ship
   * stash · equipment · bag are joined by their seams into one panel (`inventory.css`). Each pane still keeps its own
   * scroll · sort · filter. The one-card stash + bag of other folders' screens belongs to `TradeGrids`, not to this.
   */
  private rightCol!: HTMLElement;
  disassemble!: DisassemblePanel;
  /**
   * The `모두 수리` modal popup (the repair list does not sit under the craft panel).
   * 2026-09-14 (user's decision): its opening button moved **from the workbench header to the far left of the bag's
   * filter chip row** (`repairAllBtn`) — the repair gate asks "in the ship?", not "which workbench?" (`benchRepairRows`).
   */
  repair!: RepairPanel;
  /** 2026-09-14: the orange `모두 수리` at the far left of the bag's filter row (ship only — hidden during a raid). */
  private repairAllBtn!: HTMLButtonElement;
  /** 2026-09-16: `모두 창고로 이동` between `모두 수리` and `정렬` (ship only — the bag grid alone goes to the stash). */
  private bagToStashBtn!: HTMLButtonElement;
  /** 2026-09-08: tactical implants + implant items, under the equipment slots (moved here from the character sheet). */
  implantPanel!: ImplantPanel;
  /** 2026-09-16: the held-credits text at the right end of the bag's bottom row (`Screens.refreshCredits`). */
  creditsValue!: HTMLElement;
  private containerPanel!: HTMLElement;
  private containerTitle!: HTMLElement;
  private containerTier!: HTMLElement;
  /** Phase 7: `감정 중 · n개 남음` / `감정 완료` readout in the container header. */
  private searchStatus!: HTMLElement;
  private stashPanel!: HTMLElement;
  private stashCount!: HTMLElement;
  /** 2026-09-16: `업그레이드` at the right end of the stash header (hidden when there is no `ctx.housing` — `refresh`). */
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
  /** 2026-09-11 (A-15): the **pouch grid** under the quick slots — `hidden` and drawing nothing with no pouch equipped. */
  pouchPanel!: HTMLElement;
  pouchTitle!: HTMLElement;
  pouchView!: GridView;
  slots = new Map<SlotId, SlotView>();
  /* appended: tactical kit */
  craftPanel!: CraftPanel;
  /* Phase 6: the infinite box */
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
  /** 2026-09-12: the bag · stash filter — one choice for both grids (and the pouch) of this window. */
  filterGroup: FilterGroupId = 'all';
  /** 2026-09-15 2nd pass: the filter dropdowns in the stash · bag headers (both show the same `filterGroup`). */
  private filterChips: FilterControl[] = [];
  /** 2026-09-12: the bag grid's scroll viewport (the fixed 12-row frame can be taller than a short window). */
  bagScroll!: HTMLElement;

  constructor(public readonly sys: InventorySystem, public readonly ctx: GameContext) {}

  /* ── mount / visibility ────────────────────────────────────────────────── */

  mount(): void {
    if (this.root) return;
    // 2026-09-14: a cell's edge rides the window height (`labels.gridCellForHeight`). It is set **before** the grids
    // are built, and when the window size crosses a step `onViewportResize` hands the new value to window and grids.
    syncGridCell();
    const getDef = (id: string) => ITEM_DEF_MAP.get(id);
    const getStats = (item: ItemInstance) => this.sys.getStats(item);
    const root = document.createElement('div');
    root.className = 'inv-root';
    applyGridCellVar(root);
    /*
     * 2026-09-18 (user's decision): on the ship Tab the **stash pane keeps its old height**. The tallest bag's frame
     * (`BAG_FRAME_ROWS`) used to push the row height up and the stash was that tall; with the frame gone that reason is
     * gone. Writing that height onto the stash grid's floor needs css to know the row count — from `data/bags.csv`.
     */
    root.style.setProperty('--inv-bag-frame-rows', String(BAG_FRAME_ROWS));
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
    /*
     * 2026-09-16 (user's decision): the top-right `CREDITS n` pill is gone — that corner is the messenger button's spot
     * (it shows over the Tab window too), and the held credits are the `12,345 C` text at the **right end of the bag
     * panel's bottom row**. That element is built together with the bag's footer.
     */

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
     * 2026-09-15 2nd pass: the top-left label was removed once, **put back 2026-09-16 (user's decision)** — with the
     * stash out as a direct card of `.inv-layout` and [stash][equipment][bag] joined into one sheet, the header's left
     * went blank and stopped reading apart from the equipment column across the seam. It is a quiet section title
     * (the `.inv-eyebrow` family), so it never comes before the tool row.
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
     * 2026-09-16 (user's decision): **`업그레이드`** to the right of the filter — the modal that grows the stash's cell
     * count belongs to housing, so only the one line `HousingRef.openStorageUpgrade()` is called (facility level · cost ·
     * the hold confirm are that folder's rules). With no `ctx.housing` (a raid · outside the ship) the button has
     * nothing to press, so it is **hidden outright** instead of left dimmed.
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
    // 2026-09-09: in the tutorial the stash shows only that step's materials · products (`stashItem` gate; false when off)
    this.stashView.setHideItem((item) => this.ctx.tutorial?.hides('stashItem', item.defId) ?? false);
    const sScroll = document.createElement('div');
    sScroll.className = 'inv-stash-scroll';
    sScroll.appendChild(this.stashView.el);
    // 2026-09-08: the '가방 ↔ 창고: 드래그 또는 우클릭…' hint line under the stash is gone — drag and right-click are
    //   already what the bag grid does, so one more line on screen has no reason (user's decision: the obvious goes).
    // 2026-09-15 2nd pass: the grid sits right under the one header row (count · sort · filter) — no separate chip row
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
     * 2026-09-14 (user's decision): **`모두 수리` sits at the far left of the bag-side tool row** — it came from the
     * workbench header. In the ship it presses whichever workbench is open (or none): the repair gate is only
     * `benchRepairRows`' 「in the ship」, and during a raid that list is empty so the button hides too (`refresh`).
     *
     * 2026-09-15 2nd pass: that row is now **the bag pane's one header row** (`모두 수리` · `정렬` · the filter dropdown)
     * — the chip row that stood apart above the grid is gone and its place moved into the header. The stash pane has
     * its own sort · filter in its own header.
     */
    const bTools = document.createElement('div');
    bTools.className = 'inv-bag-tools';
    this.repairAllBtn = document.createElement('button');
    this.repairAllBtn.type = 'button';
    // ⚠ `.inv-repair-all` is already `RepairPanel`'s run button (a global stylesheet — reusing the name brings its rules).
    this.repairAllBtn.className = 'inv-btn inv-repair-open-btn';
    this.repairAllBtn.textContent = TEXT.bench.repairAll;
    this.repairAllBtn.title = TEXT.bench.repairAll;
    this.repairAllBtn.addEventListener('click', (e) => { e.stopPropagation(); this.repair.open(this.repairAllBtn); });
    /*
     * 2026-09-16 (user's decision): **`모두 창고로 이동` between `모두 수리` and `정렬`.** Shown in the ship only (`refresh`),
     * it moves the bag grid's items alone — quick slots · pouch · equipment stay. A reversible move, so no confirm.
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
    /*
     * 2026-09-18 (user's decision): **the grid is drawn at exactly the equipped bag's size** — the fixed 12-row frame of
     * 2026-09-12 (`BAG_FRAME_ROWS`) is gone. Matching the card's height to the equipment column is css's job
     * (`.inv-panel-grids { align-self: stretch }`), and the spare room is card padding, not empty grid rows. The frame
     * survives only in `TradeGrids`, where the bag stands beside the stash.
     */
    const bScroll = document.createElement('div');
    bScroll.className = 'inv-bag-scroll';
    bScroll.appendChild(this.bagView.el);
    this.bagView.setClip(bScroll);
    bScroll.addEventListener('scroll', () => { const d = this.drag; if (d?.started) this.updateDragTarget(d.lastX, d.lastY); }, { passive: true });
    this.bagScroll = bScroll;
    const bBody = document.createElement('div');
    bBody.className = 'inv-bag-body';
    /*
     * 2026-09-11 (A-15) — **the pouch grid sits right under the quick-slot panel** (user's decision). With no pouch
     * equipped the whole block is `hidden` — not even a 「주머니가 없습니다」 spot is kept (`getPouchSize()` is `{0,0}`).
     * The one title line says the name **and what it accepts**, so why something does not fit is known before the red
     * highlight shows it.
     */
    const pPanel = document.createElement('div');
    pPanel.className = 'inv-pouch';
    pPanel.hidden = true;
    this.pouchTitle = document.createElement('div');
    this.pouchTitle.className = 'inv-pouch-title';
    this.pouchView = new GridView('pouch', getDef, getStats, this.tileHandlers());
    pPanel.append(this.pouchTitle, this.pouchView.el);
    this.pouchPanel = pPanel;
    const bFoot = document.createElement('footer');
    bFoot.className = 'inv-foot';
    /*
     * 2026-09-16 (user's decision): the bottom row = **a small `가방 내 가치 1,000 C` at the left end** (number white,
     * rest grey) + **held credits `12,345 C` at the right end** (text, not a chip). The right end used to be the bag value.
     */
    const vWrap = document.createElement('span');
    vWrap.className = 'inv-bagval';
    const vLabel = document.createElement('span');
    vLabel.textContent = `${TEXT.bagValue} `;
    this.valueEl = document.createElement('span');
    this.valueEl.className = 'inv-bagval-num';
    const vUnit = document.createElement('span');
    vUnit.textContent = ` ${TEXT.creditUnit}`;
    vWrap.append(vLabel, this.valueEl, vUnit);
    this.creditsValue = document.createElement('span');
    this.creditsValue.className = 'inv-credits-value';
    bFoot.append(vWrap, this.creditsValue);
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
    /*
     * 2026-09-18 (user's decision) — **weight · bag value · held credits sit at the bottom of the grid's right-hand
     * column**. Two rows eating the card's whole width used to sit **under** the grid, so the card alone grew ~90 px
     * while the space beside the quick slots stayed empty. They now go into one column with the quick slots · the pouch
     * (`.inv-bag-side`) and stick to that column's floor (css `.inv-bag-readouts`) — in the narrow layouts (a raid under
     * 1280 px · the ship under 1600 px) that column drops below the grid, so the old vertical stack is unchanged.
     */
    const bReadouts = document.createElement('div');
    bReadouts.className = 'inv-bag-readouts';
    bReadouts.append(this.weightEl, bFoot);
    const bSide = document.createElement('div');
    bSide.className = 'inv-bag-side';
    bSide.append(this.buildQuickPanel(), pPanel, bReadouts);
    bBody.append(bScroll, bSide);
    // 2026-09-15 2nd pass: the tools (`모두 수리` · sort · filter) sit in the bag's **one header row** — no chip row above
    bPanel.append(bHead, bBody);
    // 2026-09-15 4th pass: the recipe list's hover card is the grid tiles' **floating card** (`this.tooltip`) — as the catalog's
    this.craftPanel = new CraftPanel(this.sys, getDef, () => this.closeCraft(), {
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
     * 2026-09-08: an implant is not a character stat but gear that is carried out — its place is right under the
     * equipment slots. 2026-09-12 (user's decision, option A): it is now one cell **inside the equipment grid**
     * (`grid-area: implant`) — right under 주무기 II, left of the pouch. At narrow widths the grid unrolls into a single
     * vertical column, so it is inserted before `pouch` in the DOM too.
     */
    this.implantPanel = new ImplantPanel(this.sys, this.ctx);
    const pouchSlotEl = this.slots.get('pouch')?.el ?? null;
    eqGrid.insertBefore(this.implantPanel.root, pouchSlotEl);

    /* the infinite box (Phase 6): leftmost panel, shown only while the catalog is open */
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
     * 2026-09-16 (user's decision) — **the ship Tab = stash | equipment | bag.** Screen order comes from the css `order`
     * (infinite box −1 · crate 0 · stash 0 · equipment 1 · bag card 2). The stash is a direct card of `.inv-layout` and
     * stands **after** the crate in the DOM, so even with a crate window up in the ship it touches the equipment column
     * (the seam rules assume that neighbour). The raid Tab has the stash `hidden`, so [equipment][bag]; crate looting
     * stays [crate][equipment][bag]. The two grids each keep their own scroll · sort · filter.
     */
    this.rightCol = document.createElement('section');
    this.rightCol.className = 'inv-panel inv-panel-grids inv-col-right';
    this.rightCol.append(bPanel);
    // 2026-09-15 4th pass: the craft detail is a separate card right of the bench panel (`craftPanel.detailEl`)
    //   — its place comes from `.is-craft`'s css `order`
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
      // Phase 12: the 분해 gauge reports its hold (≤ 30 Hz, once with done:true, {t:0} on a cancel)
      this.ctx.bus.emit('inventory:disassembleProgress', { uid, t, done });
    });
    this.repair = new RepairPanel(this.sys, getDef);
    this.modelessLayer.append(this.disassemble.el, this.repair.el);

    /*
     * 2026-09-14 (user's decision): **the bottom-centre hint pill bar (`.inv-hints`) is gone.** Five of its entries
     * repeated the bottom-right key guide (`guideKeys`) verbatim, and the mouse modifiers that did not overlap
     * (Shift · Ctrl drag) moved into that guide. This spot (`.inv-footer`) now holds only the drop zone, which shows
     * during a drag alone.
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
      // Phase 12: implant tooltip — stat names from progression, owned counts (bag + stash) for the repair chips
      getStatName: (id) => { try { return this.ctx.progression?.getStatDef(id)?.name ?? id; } catch { return id; } },
      countOwned: (defId) => this.sys.countDefAll(defId),
      // 2026-09-09: weapon gauges — bare def stats (white layer + catalog maxima), the weapon defs to scan, the
      // ammo item of a calibre for the corner thumbnail (catalog scanned per call; the card is built on hover only)
      getBaseStats: (defId) => this.sys.getLoot().getEffectiveStats(defId),
      allWeaponItemDefs: () => this.sys.getLoot().getAllItemDefs().filter((d) => d.weaponId !== undefined),
      findAmmoDef: (type) => this.sys.getLoot().getAllItemDefs().find((d) => d.category === 'ammo' && d.ammoType === type),
      // 2026-09-12: `getDurabilityBucket` · `canSalvage` dropped out — the card's bucket row became the durability gauge
    });
    this.ghostLayer = document.createElement('div');
    this.ghostLayer.className = 'inv-ghost-layer';
    /*
     * 2026-09-14 (user's decision): **pinning the tooltip.** Holding a tile (grid · equipment slot · wheel · pouch ·
     * crate/corpse window) still for a second stands its tooltip in place (`ui/TipPin` — the hold is raised by
     * `Drag.beginPress`). The pinned card is DOM **behind** the floating card (the first `.inv-tooltip` is still the
     * floating one — the smokes find it that way) and one z step lower, so a comparison card hovered on another item
     * while one is pinned draws above it. Sockets of a pinned weapon card drag out onto a bag · stash · pouch cell, or
     * (in a raid) onto 버리기.
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

    root.append(this.tabsEl, layout, this.screenHost, this.screenNote, footer,
      this.modelessLayer, this.tooltip.el, this.pin.el, this.ghostLayer);
    this.menu = new ContextMenu(root);
    // 2026-09-09: the 수량 지정 dialog is its own key guide owner (`Enter 확인`) stacked over the window's line
    this.dialog = new SplitDialog(root, (open) => this.ctx.bus.emit('ui:keyGuide', { owner: 'inventory.split', keys: open ? [{ key: 'Enter', label: '확인' }] : null }));
    this.ctx.uiRoot.appendChild(root);
    // key labels follow the live bindings
    this.ctx.bus.on('input:bindingsChanged', () => { this.refreshKeyLabels(); this.emitGuide(); });
    // 2026-09-08: screen tabs · recipes the tutorial hid come back the moment the step advances or is skipped
    // 2026-09-09: the stash grid's `version` does not move when the step does, so the hidden-item sweep is forced here
    this.ctx.bus.on('tutorial:changed', () => { this.markTab(); this.stashView.refresh(true); this.refresh(); });
    // 2026-09-12 (E1): favourites — `GridView.refresh` repaints grid tiles off the revision; a built catalog tile only has its mark fixed
    this.ctx.bus.on('inventory:favoritesChanged', () => this.onFavoritesChanged());
  }

  /* ── 2026-09-12 (E1): favourites ───────────────────────────────────────── */

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
   * 2026-09-13 (library series): the 「not yet shelved」 ribbon's answer changed (`parts/ShelfWanted` calls this once
   * after clearing its cache). `GridView.refresh` repaints grid tiles off the revision; a built catalog tile only has
   * its class fixed.
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

  /* ── the key guide (2026-09-09) ────────────────────────────────────────── */

  /**
   * Keys the window's active tab really answers to, for the bottom-right key guide (`ui:keyGuide`, owner
   * `'inventory'`). Labels are read live (`keyLabel`), so this is re-emitted on `input:bindingsChanged` and on every
   * tab change; the guide appends `Tab 닫기` itself, so the close key is never listed here. The embedded 캐릭터 / 기업 /
   * 함선 tabs are mouse-only → `[]` (the guide then shows the close entry alone).
   *
   * **2026-09-14 (user's decision):** removing the bottom-centre `.inv-hints` pill bar brought the **mouse modifiers**
   * that lived on that row alone here — `Shift + 드래그 절반` · `Ctrl + 드래그 하나` (a `combo`, so two keycaps are joined
   * by a small `+`). The old row's `드래그→무기` (attach) · `드래그→퀵슬롯` (register) were **left out on purpose**: a drag
   * lights that cell green and announces itself, and nine entries make one row wider than a 1280 px screen (the guide
   * is `white-space: nowrap`). What cannot be seen — the modifier keys — comes first.
   *
   * **2026-09-15 (user's decision):** right-click · middle-click are handed over as the labels `RMB` · `MMB` rather than
   * as text, so the key guide draws them as the **mouse glyph** (`shared/keycap`). Both are real buttons unrelated to
   * rebinding (`contextmenu` · `MIDDLE_BUTTON`), so they are `Mouse2` · `Mouse1`, not `Keys`.
   * The 절반 · 하나 rows dropped `+ 드래그` — `Shift 절반` · `Ctrl 하나`.
   */
  guideKeys(): KeyGuideEntry[] {
    if (this.activeTab !== 'inventory') return [];
    return [
      { key: keyLabel(Keys.ROTATE_ITEM), label: '회전' },
      // X: on a mission it drops on the ground, in the ship it goes to the stash (`InventorySystem.dropItem`)
      { key: keyLabel(Keys.DROP_ITEM), label: this.hub ? '창고로' : '버리기' },
      // 2026-09-12 (E1): quick move is the double-click; right-click opens the menu on every item (favourite included)
      { key: '더블클릭', label: '빠른 이동' },
      { key: keyLabel('Mouse2'), label: '메뉴' },
      { key: keyLabel('Mouse1'), label: '요청' },
      { key: 'Shift', label: '절반' },
      { key: 'Ctrl', label: '하나' },
    ];
  }

  /** Emit the window's key guide line (no-op while hidden — `hide()` sends the `null` instead). */
  emitGuide(): void {
    if (!this.visible) return;
    this.ctx.bus.emit('ui:keyGuide', { owner: 'inventory', keys: this.guideKeys() });
  }

  /**
   * Close the context menu / split dialog / modeless popups if open. Returns true when something was closed, so the
   * system's Escape handler consumes that press instead of closing the whole window (Phase 8: the implant picker,
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
   * that fallen-through Escape now closes the window (`shared/escape`'s topmost entry = this window); it used to be
   * the pause menu. Either way the popup-first rule is unchanged. The 제작 column is a column of the window (its own
   * 제작 button toggles it), not a popup, so it goes with the window.
   */
  closePopups(): boolean {
    const a = this.dialog?.close() ?? false;
    const b = this.menu?.close() ?? false;
    // 2026-09-12 (E1): while the favourite-salvage confirm card is up, Escape · Tab bite only that card (분해 stays open)
    const d = (this.disassemble?.cancelConfirm() ?? false) || (this.disassemble?.close() ?? false);
    const r = this.repair?.close() ?? false;
    const f = this.implantPanel?.closePickers() ?? false;   // 2026-09-08: the implant picker eats one Escape too
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
    // C-60 (2026-09-11 fix): measured **directly, once** here — see the comment below
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
    this.closeOverlays();          // the popups / the 제작 column drop their own key guide owners first …
    this.setTab('inventory');
    this.tooltip.hide();
    this.pin.cancelHold();   // 2026-09-14: a closing window drops the pinned card (and a hold in progress)
    this.pin.unpin();
    this.hovered = null;
    // 2026-09-16: the filter list is a child of `document.body`, so it would stay on screen alone — cleared with the window
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
   * **2026-09-11 (fix) — the places that swap the container do not wait for the observer.** Its callback arrives next
   * frame, and closing a corpse window whose rows grew and opening a plain crate **immediately** after can leave no
   * callback in between — the `.is-scroll` the corpse window put on then stays, and a 6×4 crate that does not overflow
   * is 8 px wider by the scrollbar gutter (what made `smoke-quickslots`' C-60 「보통 상자는 모양이 그대로다」 go red now
   * and then). It is not that the observer misses a new node — `containerView.el` is built once and never replaced.
   * **Nobody was measuring again**, that is all. So the container-swap branches of `show()` and `refresh()` call here
   * directly (reading `scrollHeight` flushes layout synchronously, so the answer is right on the spot). The observer
   * only handles changes while the window stands.
   */
  syncContainerScroll(): void {
    const s = this.containerScroll;
    if (!s) return;
    s.classList.toggle('is-scroll', s.scrollHeight > s.clientHeight + 1);
  }

  /**
   * 2026-09-14 (smaller cells on a small screen): works only when the window height crossed a step — `syncGridCell()`
   * moves `CELL` · `STEP`, and the window's `--inv-cell` plus the four live grids follow to the same value. A drag in
   * flight is cancelled, because its pitch changes.
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
    for (const f of this.filterChips) f.dispose();   // 2026-09-16: a floating filter list is not a child of the window
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

  /** 2026-09-17: corp reputation changed — re-gate the 기업 screen tab (`Screens.corpTabLocked`). */
  onCorpAccessChanged(): void { return Screens.onCorpAccessChanged(this); }

  /** `크레딧 n` readout on the ship screen (`ctx.meta.credits`; refreshed on `meta:creditsChanged`). */
  refreshCredits(): void { return Screens.refreshCredits(this); }

  /* ── refresh ───────────────────────────────────────────────────────────── */

  refresh(): void {
    if (!this.root || this.root.hidden) return;
    /*
     * 2026-09-12 (user's decision): the top-right ribbon only on **ammo I need**. The table lives in `ui/GridView` and is
     * swapped in here — it answers true only when it changed, so the tiles are redrawn whole only on the frame the
     * weapon changed.
     */
    // 2026-09-12 (item recovery contracts): the ribbon's scope is refreshed here too (the system does it every frame too) —
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
      this.valueEl.textContent = fmtCreditNumber(bag.totalValue() + this.equippedValue());
    }
    const c = this.sys.getActiveContainer();
    if (c !== this.container) {
      this.container = c;
      this.containerPanel.hidden = !c;
      this.containerView.setGrid(c ? c.grid : null);
      this.containerScroll.scrollTop = 0;
      this.syncContainerScroll();   // C-60: measured again right where the container changes (no waiting for the observer)
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
      // 2026-09-16 (user's decision): **`사용칸 / 전체칸` only.** The item-def count (`stash.count`) that came before it
      //   wrote as a number what the grid already draws, and what the stash is asked is 「how full is it」, nothing else.
      this.stashCount.textContent = capacityLabel(stash.usedCells(), stash.cols * stash.rows);
    }
    // 2026-09-16: the held credits sit on the bag's bottom row, so they show in a raid window too — outside the ship branch
    this.refreshCredits();
    // 2026-09-16: the stash upgrade is a ship feature — with no `ctx.housing` there is nothing to call, so the button goes
    this.stashUpgradeBtn.hidden = !this.ctx.housing;
    /*
     * 2026-09-14: `모두 수리` is **ship only** — during a raid `benchRepairRows` is an empty list, so the button hides too.
     * With nothing to repair it is left dimmed (removing and re-adding it would shake the chip row's places).
     */
    this.repairAllBtn.hidden = this.ctx.isRaidActive();
    if (!this.repairAllBtn.hidden) {
      const worn = this.sys.benchRepairRows(true).length;
      this.repairAllBtn.disabled = worn === 0;
      this.repairAllBtn.title = worn === 0 ? TEXT.bench.repairNone : TEXT.bench.repairAll;
    }
    // 2026-09-16: `모두 창고로 이동` — only in the ship window, which has a stash; dimmed on an empty bag grid (else the row shakes)
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

  /* ── Phase 7: container search ─────────────────────────────────────────── */

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

  /* ── 2026-09-14: the fallback placement flash ──────────────────────────── */

  /**
   * **The slot itself says where the item went** (user's decision). When a double-click in a crate · corpse could not
   * reach the bag and pushed the item into an empty equipment slot · implant slot · empty quick slot, a
   * `가방이 가득 찼습니다 — …` toast used to appear in a corner of the screen. Now the slot it really went into flashes
   * green for a moment (`.is-flash`, the `inv-slot-flash` keyframes in `inventory.css`).
   *
   * It must be a **different class** from the drag's `is-target-ok` — the drag preview wipes that class every frame, so
   * the same name would make the flash vanish on its first frame. It takes itself off when the animation ends
   * (`animationend`, with a timer as insurance for environments that cannot run animations).
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

  /** An equipment slot (주무기 I · II · 가방 · 방탄복 · 주머니). */
  flashSlot(slot: SlotId): void { this.flash(this.slots.get(slot)?.el); }

  /** A quick-slot wheel cell. */
  flashQuick(index: number): void { this.flash(this.quickCell(index)); }

  /** The implant equipment slots — the block (`.inv-impitems`) flashes, not one cell (`equipImplant` names no spot). */
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
   * puts the recipe list leftmost (where the stash sits otherwise) and stacks the bag over the stash on the right, so
   * the materials a recipe needs are visible next to it. Still no blocker and no pointer-lock change: the window owns both.
   */
  setCraftOpen(open: boolean): void { return Screens.setCraftOpen(this, open); }

  /** The panel's 닫기 button / Escape / an outside click: leave the bench too when one is active. */
  closeCraft(): void { return Screens.closeCraft(this); }

  /** Repaint the craft rows (progress / counts) without rebuilding the rest of the window. */
  refreshCraft(): void { return Screens.refreshCraft(this); }

  /* ── Phase 6: the infinite box ─────────────────────────────────────────── */

  /** Show / hide the catalog panel (system state lives in `InventorySystem.isCatalogOpen`). */
  setCatalog(open: boolean): void { return Screens.setCatalog(this, open); }

  /** Catalog panel (smoke tests / tab & search control). */
  get catalog(): CatalogView { return this.catalogView; }

  /** Double-press on a catalog tile: a fresh instance straight into the bag. */
  catalogTake(def: ItemDef): void { return Screens.catalogTake(this, def); }

  /** Last catalog press (double-press detection: a second press on the same tile within `CATALOG_DBL_MS` = into the stash (ship) else the bag). */
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
   * what stopped the bag and the stash (stacked with a small gap since the 2026-09-07 pass) from stealing each other's
   * edge rows — `activeViews()` is ordered stash → bag, so the padded box of the stash used to swallow drops the
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

  /* ── the pouch grid (2026-09-11, A-15) ─────────────────────────────────── */

  /**
   * With a pouch equipped its grid is drawn under the quick slots; with none the whole block is hidden.
   * The title is one line, `<pouch name> · <what it accepts>` (`TEXT.pouch.line`).
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
   * Credit value of everything in the equipment slots (2026-09-08). The value readout under the bag used to count
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

  /* ── 2026-09-12: auto sort · filter ────────────────────────────────────── */

  /**
   * 2026-09-16: the `모두 창고로 이동` button. Everything fitting is only a sound; anything left over for want of room
   * raises one toast (`창고에 공간이 없습니다 (n개 남음)`). The ready-state lock announces itself through the system's
   * `readOnlyBlocked`.
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

  /** `정렬` in the bag / stash header. A drag in progress is dropped first (its source may move). */
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

  /** Pick a filter entry: every grid of the window dims what the group does not contain. */
  setFilterGroup(id: FilterGroupId): void {
    this.filterGroup = id;
    const pred = filterPredicate(id, (defId) => this.sys.isFavorite(defId));   // 2026-09-12 (E1): the 「즐겨찾기」 entry
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
   * 2026-09-11 (A-15): the pouch joins the list **only while its block is drawn** — a hidden grid must never
   * swallow a drop the player aimed at the bag.
   */
  activeViews(): GridView[] {
    const out: GridView[] = [];
    if (this.container) out.push(this.containerView);
    if (this.hub) out.push(this.stashView);
    // 2026-09-13: the infinite box layout hides the pouch block with CSS (`.is-catalog`), not `hidden` — check both
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
   * 2026-09-15 (user bug 「the tooltip of an item moved by a double-click in a corpse window stays until the mouse moves」).
   *
   * **Cause**: the hover card only goes down on a tile's `pointerleave`. But when a quick move (double-click · the
   * right-click menu · auto placement) moves the item, `refresh()` **takes the tile under the cursor out of the DOM**
   * (`GridView`'s `el.remove()` · the equipment slot / wheel cell's `innerHTML = ''`), and the browser sends no
   * `pointerleave` to a detached element — the next pointer move merely sends `pointerover` to the new element. So the
   * card stood with `hovered` pointing at a tile that was already gone, and stayed until another tile was entered or the
   * window was left. It stood out in the corpse window because a double-click there almost always sends the item **into
   * another grid** (a bag → bag cell move leaves the same element).
   *
   * **Fix**: checked here on every grid repaint (the end of `refresh()`) and on the frame after an operation that
   * returned a result (`result()`) — is the hovered item still in that spot, is its tile element connected and not
   * vanishing, and **is that tile under the last pointer position**. Any "no" takes the card down. A tile newly arrived
   * under the cursor gets its `pointerenter` as usual on the next pointer move. Cards of the floating corp screen · a
   * station grid (`TradeGrids`) are `ui/hud/ItemTip`, which runs the same check there.
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
