import './../inventory.css';
import type { EmbeddedView, GameContext, ImplantDef, ImplantId, ItemDef, ItemInstance } from '@/shared';
import { Keys, QUICK_SLOTS, QUICK_SLOT_LABEL_KO, isQuickSlotActive, keyLabel, renderItemCost } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { Container } from '../Container';
import { LOADOUT_SLOTS, isArmorDef, isAttachmentDef, isBagDef, isWeaponDef, type DropTarget, type GridId, type InventorySystem, type ItemLocation, type SlotId } from '../InventorySystem';
import { CraftPanel } from './CraftPanel';
import { CatalogView } from './CatalogView';
import { Modeless } from './Modeless';
import { DisassemblePanel } from './DisassemblePanel';
import { filledSocketCount } from '../Sockets';
import { isQuickUsable } from '../QuickSlots';
import { GridView, buildTileContent, type HighlightState } from './GridView';
import { Tooltip } from './Tooltip';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { SplitDialog } from './SplitDialog';
import { QUICK_DIR_GLYPH, QUICK_ROSE_ORDER, SLOT_LABEL, STEP, TEXT, fmtValue, slotKeyLabel, tierTitle, tileSize, fmtKg, weightLabel } from './labels';

const DRAG_THRESHOLD = 4; // px before a press becomes a drag
const MIDDLE_BUTTON = 1;
/** Two presses on the same catalog tile within this window = 가방에 넣기. */
const CATALOG_DBL_MS = 400;
const BAG_LOC: ItemLocation = { kind: 'grid', grid: 'bag' };
const LOCK_SVG = '<svg viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="6" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 6V4a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

/**
 * Screen tabs above the window (Arc Raiders style), hub mode only.
 *
 * **Phase 8**: the tabs no longer close the window and open a separate full-screen popup. Selecting one swaps the
 * `.inv-layout` content for a `.inv-screen` host and builds the owning folder's **embedded view** into it —
 * `ctx.progression.createSheetView` / `ctx.meta.createCorpView` / `ctx.housing.createShipView`, each an
 * `EmbeddedView` we `refresh()` on show and `dispose()` on leave. The window keeps its single `inventory` blocker
 * and its blurred `.inv-root` backdrop is the 배경 블러 the design asks for.
 */
type ScreenTab = 'inventory' | 'character' | 'corp' | 'ship';
const SCREEN_TABS: readonly { id: ScreenTab; label: string; title?: string }[] = [
  { id: 'inventory', label: TEXT.tabs.inventory },
  { id: 'character', label: TEXT.tabs.character, title: TEXT.tabs.characterHint },
  { id: 'corp', label: TEXT.tabs.corp, title: TEXT.tabs.corpHint },
  { id: 'ship', label: TEXT.tabs.ship, title: TEXT.tabs.shipHint },
];

interface DragState {
  uid: string;
  item: ItemInstance;
  def: ItemDef;
  from: ItemLocation;
  /** Wheel cell the drag started from (its tile is a bag item); releasing anywhere but another cell clears that slot. */
  quickFrom: number | null;
  /** Units carried by a Shift (half) / Ctrl (one) drag; null = the whole item. */
  qty: number | null;
  /** Phase 6: the item is a fresh catalog instance (lives in no grid; `from` is a placeholder). */
  catalog: boolean;
  rotated: boolean;
  started: boolean;
  startX: number;
  startY: number;
  grabX: number;
  grabY: number;
  ghost: HTMLElement | null;
  target: DropTarget | null;
  lastX: number;
  lastY: number;
}

interface SlotView {
  slot: SlotId;
  el: HTMLElement;
  body: HTMLElement;
  bodyW: number;
  bodyH: number;
  meta: HTMLElement;
  key: HTMLElement | null;
  tile: HTMLElement | null;
  uid: string | null;
}

/** One cell of the quick-use compass rose. */
interface QuickCell {
  index: number;
  el: HTMLElement;
  tile: HTMLElement | null;
  uid: string | null;
}

/**
 * Arc Raiders-styled DOM for the Diablo grid.
 *   - Mission (Tab / crate): container panel (left), bag (center, quick-use rose underneath), equipment column (right).
 *   - Ship (`hub` = true, 2026-09-06): screen tabs (인벤토리 / 캐릭터 / 기업) on top, then **함선 창고** (scrollable stash
 *     grid, left) · **장착 장비** (5 slots + the tactical-implant slot with its picker, center) · **가방** with the
 *     quick-use rose to its right (≥ 1600 px wide; under the grid on narrower windows). Right-click on worn gear
 *     offers 수리 there; a "drop" (X / backdrop release) lands in the stash because the ship has no ground.
 * Owns drag & drop, rotation, tooltips, context menus.
 */
export class InventoryUI {
  private root: HTMLElement | null = null;
  private layout!: HTMLElement;
  private tabsEl!: HTMLElement;
  /** Phase 8: tab buttons by id, and the host the embedded 캐릭터 / 기업 / 함선 views are built into. */
  private tabButtons = new Map<ScreenTab, HTMLButtonElement>();
  private screenHost!: HTMLElement;
  private screenNote!: HTMLElement;
  private activeTab: ScreenTab = 'inventory';
  private screenView: EmbeddedView | null = null;
  /** Layer that holds the modeless popups (임플란트 picker / 제작 / 분해) above `.inv-layout`. */
  private modelessLayer!: HTMLElement;
  private craftModeless!: Modeless;
  private implantModeless!: Modeless;
  private disassemble!: DisassemblePanel;
  private creditsEl!: HTMLElement;
  private creditsValue!: HTMLElement;
  private containerPanel!: HTMLElement;
  private containerTitle!: HTMLElement;
  private containerTier!: HTMLElement;
  /** Phase 7: `감정 중 · n개 남음` / `감정 완료` readout in the container header. */
  private searchStatus!: HTMLElement;
  private stashPanel!: HTMLElement;
  private stashCount!: HTMLElement;
  private bagCapacity!: HTMLElement;
  private valueEl!: HTMLElement;
  private containerView!: GridView;
  private stashView!: GridView;
  private bagView!: GridView;
  private slots = new Map<SlotId, SlotView>();
  /* appended: tactical kit */
  private craftPanel!: CraftPanel;
  /* Phase 6: 무한 상자 */
  private catalogView!: CatalogView;
  private weightEl!: HTMLElement;
  private weightValue!: HTMLElement;
  private weightState!: HTMLElement;
  private weightFill!: HTMLElement;
  private quickCells: QuickCell[] = [];
  private quickCount!: HTMLElement;
  private quickKey!: HTMLElement;
  private quickHold!: HTMLElement;
  private hintsEl!: HTMLElement;
  /* implant slot (hub) */
  private implantSlot!: HTMLElement;
  private implantBody!: HTMLElement;
  private implantMeta!: HTMLElement;
  private implantPicker!: HTMLElement;
  private implantCards = new Map<ImplantId, HTMLElement>();
  private pickerOpen = false;
  private tooltip!: Tooltip;
  private ghostLayer!: HTMLElement;
  private dropZone!: HTMLElement;
  private menu!: ContextMenu;
  private dialog!: SplitDialog;
  private drag: DragState | null = null;
  private hovered: { uid: string; loc: ItemLocation } | null = null;
  /** Weapon tile currently lit as a socket target (attachment drag). */
  private socketTarget: { uid: string; loc: ItemLocation } | null = null;
  private container: Container | null = null;
  private hub = false;
  private visible = false;
  private closeTimer: number | null = null;

  private onWindowMove = (e: PointerEvent): void => this.handlePointerMove(e);
  private onWindowUp = (e: PointerEvent): void => this.handlePointerUp(e);

  constructor(private readonly sys: InventorySystem, private readonly ctx: GameContext) {}

  /* ── mount / visibility ────────────────────────────────────────────────── */

  mount(): void {
    if (this.root) return;
    const getDef = (id: string) => ITEM_DEF_MAP.get(id);
    const getStats = (item: ItemInstance) => this.sys.getStats(item);
    const root = document.createElement('div');
    root.className = 'inv-root';
    root.hidden = true;
    root.addEventListener('contextmenu', (e) => e.preventDefault());
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
    cPanel.append(cHead, this.containerView.el);
    this.containerPanel = cPanel;

    /* stash panel (hub) */
    const sPanel = document.createElement('section');
    sPanel.className = 'inv-panel inv-panel-stash';
    sPanel.hidden = true;
    const sHead = document.createElement('header');
    sHead.className = 'inv-head';
    const sTitleWrap = document.createElement('div');
    sTitleWrap.className = 'inv-head-titles';
    const sEyebrow = document.createElement('div');
    sEyebrow.className = 'inv-eyebrow';
    sEyebrow.textContent = 'STASH';
    const sTitle = document.createElement('h2');
    sTitle.className = 'inv-title';
    sTitle.textContent = TEXT.stash;
    sTitleWrap.append(sEyebrow, sTitle);
    this.stashCount = document.createElement('div');
    this.stashCount.className = 'inv-capacity';
    sHead.append(sTitleWrap, this.stashCount);
    this.stashView = new GridView('stash', getDef, getStats, this.tileHandlers());
    const sScroll = document.createElement('div');
    sScroll.className = 'inv-stash-scroll';
    sScroll.appendChild(this.stashView.el);
    const sHint = document.createElement('div');
    sHint.className = 'inv-stash-hint';
    sHint.textContent = TEXT.stashHint;
    sPanel.append(sHead, sScroll, sHint);
    this.stashPanel = sPanel;

    /* bag panel */
    const bPanel = document.createElement('section');
    bPanel.className = 'inv-panel inv-panel-bag';
    const bHead = document.createElement('header');
    bHead.className = 'inv-head';
    const bTitleWrap = document.createElement('div');
    bTitleWrap.className = 'inv-head-titles';
    const bEyebrow = document.createElement('div');
    bEyebrow.className = 'inv-eyebrow';
    bEyebrow.textContent = 'INVENTORY';
    const bTitle = document.createElement('h2');
    bTitle.className = 'inv-title';
    bTitle.textContent = TEXT.bag;
    bTitleWrap.append(bEyebrow, bTitle);
    this.bagCapacity = document.createElement('div');
    this.bagCapacity.className = 'inv-capacity';
    const bActions = document.createElement('div');
    bActions.className = 'inv-head-actions';
    const craftBtn = document.createElement('button');
    craftBtn.type = 'button';
    craftBtn.className = 'inv-btn';
    craftBtn.textContent = TEXT.craft;
    craftBtn.addEventListener('click', () => this.toggleCraft());
    bActions.append(this.bagCapacity, craftBtn);
    bHead.append(bTitleWrap, bActions);
    this.bagView = new GridView('bag', getDef, getStats, this.tileHandlers());
    const bBody = document.createElement('div');
    bBody.className = 'inv-bag-body';
    bBody.append(this.bagView.el, this.buildQuickPanel());
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
    bPanel.append(bHead, bBody, this.weightEl, bFoot);
    this.craftPanel = new CraftPanel(this.sys, getDef, () => this.closeCraft());

    /* equipment column */
    const eq = document.createElement('aside');
    eq.className = 'inv-equip';
    const eqEyebrow = document.createElement('div');
    eqEyebrow.className = 'inv-eyebrow';
    eqEyebrow.textContent = TEXT.equipment;
    eq.appendChild(eqEyebrow);
    const eqGrid = document.createElement('div');
    eqGrid.className = 'inv-equip-grid';
    for (const slot of LOADOUT_SLOTS) eqGrid.appendChild(this.buildSlot(slot, SLOT_LABEL[slot]).el);
    eq.appendChild(eqGrid);
    eq.appendChild(this.buildImplantSlot());

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

    layout.append(this.catalogView.el, sPanel, cPanel, eq, bPanel);

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
    this.craftModeless = new Modeless('craft', () => this.closeCraft());
    this.craftModeless.adopt(this.craftPanel.el);
    this.implantModeless = new Modeless('implant', () => this.closePicker());
    this.implantModeless.withHeader('IMPLANT', TEXT.implant.slot).adopt(this.implantPicker);
    this.disassemble = new DisassemblePanel(this.sys, getDef, (open, uid) => {
      this.ctx.bus.emit('ui:disassembleToggled', { open, uid });
    });
    this.modelessLayer.append(this.craftModeless.el, this.implantModeless.el, this.disassemble.el);

    /* hints (mission only; the ship screen has nothing to throw away and its keys are on the slots) */
    this.hintsEl = document.createElement('div');
    this.hintsEl.className = 'inv-hints';
    this.buildHints();

    /* world-drop zone (visible only while dragging; replaces the hint bar) */
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

    this.tooltip = new Tooltip({ getWeapon: getWeaponDef, getDef, getStats, getArmorDef: (id) => this.sys.getLoot().getArmorDef(id) });
    this.ghostLayer = document.createElement('div');
    this.ghostLayer.className = 'inv-ghost-layer';

    root.append(this.tabsEl, this.creditsEl, layout, this.screenHost, this.screenNote, this.hintsEl, dropZone,
      this.modelessLayer, this.tooltip.el, this.ghostLayer);
    this.menu = new ContextMenu(root);
    this.dialog = new SplitDialog(root);
    this.ctx.uiRoot.appendChild(root);
    // key labels follow the live bindings
    this.ctx.bus.on('input:bindingsChanged', () => this.refreshKeyLabels());
  }

  /** Bottom hint bar (mission): rotation / drop keys read the live bindings. */
  private buildHints(): void {
    this.hintsEl.textContent = '';
    const hints: Array<[string, string]> = [
      [keyLabel(Keys.ROTATE_ITEM), TEXT.hintRotate], ['우클릭', '빠른 이동/메뉴'], ['Shift+드래그', '절반'], ['Ctrl+드래그', '하나'],
      ['드래그→무기', '부착'], ['드래그→퀵슬롯', '등록'], [keyLabel(Keys.DROP_ITEM), TEXT.hintDrop], ['휠클릭', '요청'],
    ];
    for (const [key, label] of hints) {
      const h = document.createElement('span');
      h.className = 'inv-hint';
      const k = document.createElement('kbd');
      k.textContent = key;
      h.append(k, document.createTextNode(label));
      this.hintsEl.appendChild(h);
    }
  }

  private refreshKeyLabels(): void {
    this.buildHints();
    for (const sv of this.slots.values()) if (sv.key) sv.key.textContent = slotKeyLabel(sv.slot);
    this.quickKey.textContent = keyLabel(Keys.QUICK);
    this.quickHold.textContent = TEXT.quick.holdHint(keyLabel(Keys.QUICK));
    const dz = this.dropZone.querySelector<HTMLElement>('.inv-key-drop');
    if (dz) dz.textContent = keyLabel(Keys.DROP_ITEM);
  }

  /**
   * Close the context menu / split dialog / modeless popups if open. Returns true when something was closed, so the
   * system's Escape handler consumes that press instead of closing the whole window (Phase 8: the 임플란트 picker,
   * the 필드 제작 panel and the 분해 dialog all sit in this chain — none of them owns a blocker of its own).
   */
  closeOverlays(): boolean {
    const a = this.dialog?.close() ?? false;
    const b = this.menu?.close() ?? false;
    const c = this.closePicker();
    const d = this.disassemble?.close() ?? false;
    const e = this.craftPanel?.isOpen ? (this.closeCraft(), true) : false;
    return a || b || c || d || e;
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
    this.hintsEl.hidden = hub;
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
    this.stashView.setGrid(hub ? this.sys.getStash() : null);
    this.bagView.setGrid(this.sys.getGrid('bag'));
    this.catalogView.setOpen(this.sys.isCatalogOpen);
    this.root.hidden = false;
    this.visible = true;
    this.refresh();
    // force a style flush so the enter transition plays
    void this.root.offsetWidth;
    this.root.classList.add('is-visible');
  }

  hide(): void {
    if (!this.root || !this.visible) return;
    this.visible = false;
    this.cancelDrag();
    this.closeOverlays();
    this.setTab('inventory');
    this.tooltip.hide();
    this.hovered = null;
    this.root.classList.remove('is-visible');
    const root = this.root;
    this.closeTimer = window.setTimeout(() => { root.hidden = true; this.closeTimer = null; }, 180);
  }

  dispose(): void {
    this.cancelDrag();
    this.menu?.dispose();
    this.dialog?.dispose();
    this.containerView.dispose();
    this.stashView.dispose();
    this.bagView.dispose();
    this.catalogView?.dispose();
    this.screenView?.dispose();
    this.screenView = null;
    this.craftPanel?.dispose();
    this.craftModeless?.dispose();
    this.implantModeless?.dispose();
    this.disassemble?.dispose();
    this.tooltip.dispose();
    this.root?.remove();
    this.root = null;
  }

  /* ── screen tabs ───────────────────────────────────────────────────────── */

  private onTab(tab: ScreenTab): void {
    if (tab === this.activeTab) return;
    this.setTab(tab);
    this.sys.sfx(this.activeTab === tab ? 'ui_pickup' : 'ui_error');
  }

  /** The tab currently shown (smoke tests). */
  get screenTab(): ScreenTab { return this.activeTab; }

  /**
   * Swap the window content. `inventory` shows `.inv-layout`; every other tab hides it, shows the `.inv-screen`
   * host and builds that folder's `EmbeddedView` into it. The old view is always disposed first, so exactly one
   * view exists at a time and nothing survives a window close.
   */
  private setTab(tab: ScreenTab): void {
    if (!this.root) return;
    if (tab !== 'inventory' && !this.hub) tab = 'inventory'; // the embedded screens are ship-only
    if (tab === this.activeTab && (tab === 'inventory' || this.screenView)) return;
    // leaving a screen: dispose its view, close the popups that belong to the grid
    this.screenView?.dispose();
    this.screenView = null;
    this.screenHost.replaceChildren();
    this.screenNote.hidden = true;
    if (tab !== 'inventory') { this.closePicker(); this.closeCraft(); this.disassemble?.close(); }

    if (tab === 'inventory') {
      this.activeTab = 'inventory';
      this.layout.hidden = false;
      this.screenHost.hidden = true;
      this.markTab();
      return;
    }
    const view = this.buildScreenView(tab);
    if (!view) {
      // the owning folder is unavailable (no ctx.progression / meta / housing): stay on the grid with a note
      this.activeTab = 'inventory';
      this.layout.hidden = false;
      this.screenHost.hidden = true;
      this.screenNote.hidden = false;
      this.screenNote.textContent = TEXT.tabs.unavailable(SCREEN_TABS.find((t) => t.id === tab)?.label ?? '');
      this.markTab();
      this.sys.sfx('ui_error');
      return;
    }
    this.activeTab = tab;
    this.screenView = view;
    this.layout.hidden = true;
    this.screenHost.hidden = false;
    view.refresh();
    this.markTab();
  }

  /** `createSheetView` / `createCorpView` / `createShipView`; null when that system is not present. */
  private buildScreenView(tab: ScreenTab): EmbeddedView | null {
    try {
      if (tab === 'character') {
        const p = this.ctx.progression;
        return p && typeof p.createSheetView === 'function' ? p.createSheetView(this.screenHost) : null;
      }
      if (tab === 'corp') {
        const m = this.ctx.meta;
        return m && typeof m.createCorpView === 'function' ? m.createCorpView(this.screenHost) : null;
      }
      const h = this.ctx.housing;
      return h && typeof h.createShipView === 'function' ? h.createShipView(this.screenHost) : null;
    } catch (e) {
      console.warn('[inventory] embedded screen failed', tab, e);
      this.screenHost.replaceChildren();
      return null;
    }
  }

  private markTab(): void {
    for (const [id, b] of this.tabButtons) {
      b.classList.toggle('is-on', id === this.activeTab);
      // 함선 needs the housing system; hide the tab entirely when there is none
      if (id === 'ship') b.hidden = !this.ctx.housing;
    }
  }

  /** `크레딧 n` readout on the ship screen (`ctx.meta.credits`; refreshed on `meta:creditsChanged`). */
  refreshCredits(): void {
    if (!this.root) return;
    const meta = this.ctx.meta;
    const credits = meta && typeof meta.credits === 'number' ? meta.credits : null;
    this.creditsValue.textContent = credits === null ? TEXT.credits.none : TEXT.credits.value(credits);
    this.creditsEl.classList.toggle('is-unavailable', credits === null);
  }

  /* ── refresh ───────────────────────────────────────────────────────────── */

  refresh(): void {
    if (!this.root || this.root.hidden) return;
    const bag = this.sys.getGrid('bag');
    if (bag) {
      if (this.bagView.current !== bag) this.bagView.setGrid(bag);
      else this.bagView.refresh();
      const size = this.sys.getBagSize();
      this.bagCapacity.textContent = `${bag.cols}×${bag.rows} · ${bag.usedCells()} / ${bag.cols * bag.rows} · ${TEXT.quickSlots} ${size.quickSlots}`;
      this.valueEl.textContent = fmtValue(bag.totalValue());
    }
    const c = this.sys.getActiveContainer();
    if (c !== this.container) {
      this.container = c;
      this.containerPanel.hidden = !c;
      this.containerView.setGrid(c ? c.grid : null);
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
      this.stashCount.textContent = `${stash.count} · ${stash.usedCells()} / ${stash.cols * stash.rows}`;
      this.refreshCredits();
    }
    this.refreshSlots();
    this.refreshImplant();
    this.refreshQuick();
    this.refreshWeight();
    this.craftPanel.refresh();
    if (this.disassemble.isOpen) this.disassemble.refresh();
    // Phase 8: an embedded 캐릭터 / 기업 / 함선 view repaints from its own state whenever the window does
    if (this.screenView) { try { this.screenView.refresh(); } catch (e) { console.warn('[inventory] screen refresh failed', e); } }
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

  /** An unsearched container item: no tooltip, drag, menu or double-click (Phase 7). */
  private locked(uid: string, loc: ItemLocation): boolean { return this.sys.isItemLocked(uid, loc); }

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

  toggleCraft(): void {
    const open = !this.craftPanel.isOpen;
    if (!open && this.sys.getBench()) this.sys.closeBench(); // bench mode: closing the panel leaves the bench
    else this.setCraftOpen(open);
    this.sys.sfx('ui_pickup');
  }

  /**
   * System-driven craft panel visibility (`openBenchCraft` / `closeBench`). **Phase 8**: the panel lives in a
   * modeless popup, so the frame follows the panel — no blocker, no pointer-lock change, the grid stays live.
   */
  setCraftOpen(open: boolean): void {
    this.craftPanel.setOpen(open);
    if (open) {
      this.closePicker();
      this.disassemble.close();
      this.craftPanel.refresh();
      this.craftModeless.open(null);
    } else {
      this.craftModeless.close();
    }
  }

  /** The panel's 닫기 button / Escape / an outside click: leave the bench too when one is active. */
  private closeCraft(): void {
    if (!this.craftPanel.isOpen && !this.craftModeless.isOpen) return;
    if (this.sys.getBench()) this.sys.closeBench(); // → setCraftOpen(false) through the system
    else this.setCraftOpen(false);
  }

  /** Repaint the craft rows (progress / counts) without rebuilding the rest of the window. */
  refreshCraft(): void {
    if (!this.root || this.root.hidden) return;
    this.craftPanel.refresh();
  }

  /* ── Phase 6: 무한 상자 ─────────────────────────────────────────────── */

  /** Show / hide the catalog panel (system state lives in `InventorySystem.isCatalogOpen`). */
  setCatalog(open: boolean): void {
    this.catalogView.setOpen(open);
    if (!open && this.drag?.catalog) this.cancelDrag();
    if (!open) this.tooltip.hide();
  }

  /** Catalog panel (smoke tests / tab & search control). */
  get catalog(): CatalogView { return this.catalogView; }

  /** Double-press on a catalog tile: a fresh instance straight into the bag. */
  private catalogTake(def: ItemDef): void {
    const r = this.sys.takeFromCatalog(def.id);
    if (r === 'ok') this.sys.sfx('ui_pickup');
    else { this.sys.sfx('ui_error'); this.catalogView.shake(def.id); this.ctx.bus.emit('ui:notify', { text: TEXT.catalog.bagFull, kind: 'warning', duration: 1.6 }); }
  }

  /** Last catalog press (double-press detection: a second press on the same tile within `CATALOG_DBL_MS` = 가방에 넣기). */
  private lastCatalogPress: { defId: string; t: number } | null = null;

  /**
   * Press on a catalog tile: mint a fresh instance and drag it like any other item (the tile stays). A second press
   * on the same tile within `CATALOG_DBL_MS` counts as the double-click (`takeFromCatalog`) — detected here because
   * the cancelled pointerdown keeps Chrome from synthesising `dblclick` reliably.
   */
  private beginCatalogPress(def: ItemDef, sample: ItemInstance, e: PointerEvent, tileEl: HTMLElement): void {
    if (this.drag || this.dialog.isOpen) return;
    if (e.button !== 0) return;
    e.preventDefault();
    this.menu.close();
    this.closePicker();
    const now = performance.now();
    const last = this.lastCatalogPress;
    if (last && last.defId === def.id && now - last.t < CATALOG_DBL_MS) {
      this.lastCatalogPress = null;
      this.catalogTake(def);
      return;
    }
    this.lastCatalogPress = { defId: def.id, t: now };
    const item = this.sys.getLoot().createItem(def.id, sample.qty);
    const r = tileEl.getBoundingClientRect();
    // grab offset relative to the item's real footprint (the catalog tile is a uniform 2×2)
    const { width, height } = tileSize(def.width, def.height);
    this.drag = {
      uid: item.uid, item, def, from: BAG_LOC, quickFrom: null, qty: null, catalog: true,
      rotated: false,
      started: false,
      startX: e.clientX, startY: e.clientY,
      grabX: Math.min(width * 0.5, e.clientX - r.left), grabY: Math.min(height * 0.5, e.clientY - r.top),
      ghost: null, target: null,
      lastX: e.clientX, lastY: e.clientY,
    };
    window.addEventListener('pointermove', this.onWindowMove);
    window.addEventListener('pointerup', this.onWindowUp);
    window.addEventListener('pointercancel', this.onWindowUp);
  }

  /** Drag targets of a catalog instance: equipment slots, then the active grids (never the wheel / sockets / world). */
  private updateCatalogTarget(d: DragState, px: number, py: number): void {
    for (const sv of this.slots.values()) {
      const r = sv.body.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
        d.target = { kind: 'slot', slot: sv.slot };
        const pv = this.sys.previewCatalog(d.item, d.target);
        sv.el.classList.add(pv === 'bad' ? 'is-target-bad' : 'is-target-ok');
        return;
      }
    }
    const { w, h } = this.footprint(d);
    const left = px - d.grabX, top = py - d.grabY;
    for (const view of this.activeViews()) {
      const cell = view.cellForGhost(left, top, w, h, px, py);
      if (!cell) continue;
      d.target = { kind: 'grid', grid: view.id, x: cell.x, y: cell.y, rotated: d.rotated };
      const pv = this.sys.previewCatalog(d.item, d.target);
      view.showHighlight(cell.x, cell.y, w, h, pv === 'bad' ? 'bad' : pv === 'swap' ? 'swap' : pv === 'merge' ? 'merge' : 'ok');
      return;
    }
  }

  /* ── implant slot (hub screen) ─────────────────────────────────────────── */

  /** Below the gear slots: the equipped 전술 임플란트. Click → picker (ship only); clicking the equipped card unequips. */
  private buildImplantSlot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'inv-slot inv-slot-implant';
    const head = document.createElement('div');
    head.className = 'inv-slot-label';
    head.textContent = TEXT.implant.slot;
    const k = document.createElement('kbd');
    k.className = 'inv-key-implant';
    k.textContent = keyLabel(Keys.IMPLANT);
    head.appendChild(k);
    this.implantBody = document.createElement('div');
    this.implantBody.className = 'inv-slot-body inv-implant-body';
    this.implantBody.addEventListener('click', (e) => { e.stopPropagation(); this.togglePicker(); });
    this.implantMeta = document.createElement('div');
    this.implantMeta.className = 'inv-slot-meta';
    // Phase 8: the picker is no longer an inline expander of this column — it lives in a modeless popup
    // (`implantModeless`) anchored to the slot; the grid behind it stays visible and interactive.
    this.implantPicker = document.createElement('div');
    this.implantPicker.className = 'inv-implant-picker';
    el.append(head, this.implantBody, this.implantMeta);
    this.implantSlot = el;
    return el;
  }

  private implantDefs(): readonly ImplantDef[] { return this.ctx.implants?.getAllDefs() ?? []; }

  private refreshImplant(): void {
    const imp = this.ctx.implants;
    const id = imp?.equipped ?? null;
    const def = id ? imp?.getDef(id) ?? null : null;
    this.implantBody.innerHTML = '';
    if (def) {
      const card = document.createElement('div');
      card.className = 'inv-implant-card is-equipped';
      card.style.setProperty('--ic', def.color);
      const ico = document.createElement('span');
      ico.className = 'ico';
      ico.textContent = def.icon;
      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = def.name;
      card.append(ico, name);
      this.implantBody.appendChild(card);
      this.implantSlot.classList.add('has-item');
      this.implantSlot.style.setProperty('--rc', def.color);
      this.implantMeta.textContent = `${TEXT.implant.mode[def.mode]}${def.cooldown > 0 ? ` · ${TEXT.implant.cooldown} ${def.cooldown}s` : ''}${def.charges > 1 ? ` · ${TEXT.implant.charges} ${def.charges}` : ''}`;
    } else {
      const empty = document.createElement('div');
      empty.className = 'inv-slot-empty';
      empty.innerHTML = `<span class="inv-implant-empty-ico">◈</span><span>${imp ? TEXT.implant.empty : TEXT.implant.unavailable}</span>`;
      this.implantBody.appendChild(empty);
      this.implantSlot.classList.remove('has-item');
      this.implantSlot.style.removeProperty('--rc');
      this.implantMeta.textContent = '';
    }
    this.implantSlot.classList.toggle('is-locked', this.ctx.isRaidActive());
    this.implantBody.title = this.ctx.isRaidActive() ? TEXT.implant.raidLocked : TEXT.implant.clickHint;
    if (this.pickerOpen) this.renderPicker();
  }

  private togglePicker(): void {
    if (this.pickerOpen) { this.closePicker(); return; }
    if (!this.ctx.implants) { this.sys.sfx('ui_error'); return; }
    if (this.ctx.isRaidActive()) {
      this.sys.sfx('ui_error');
      this.ctx.bus.emit('ui:notify', { text: TEXT.implant.raidLocked, kind: 'warning', duration: 1.6 });
      return;
    }
    this.menu.close();
    this.tooltip.hide();
    this.disassemble.close();
    this.pickerOpen = true;
    this.implantSlot.classList.add('is-picking');
    this.renderPicker();
    // modeless: anchored to the slot, dismissed by Escape / an outside click, no blocker of its own
    this.implantModeless.open(this.implantSlot);
    this.sys.sfx('ui_pickup');
    requestAnimationFrame(() => this.implantModeless.place());
  }

  private closePicker(): boolean {
    const wasOpen = this.pickerOpen;
    this.pickerOpen = false;
    this.implantSlot?.classList.remove('is-picking');
    const closed = this.implantModeless?.close() ?? false;
    return wasOpen || closed;
  }

  /** Picker cards: one per implant; the equipped one is lit and a click on it unequips. */
  private renderPicker(): void {
    const imp = this.ctx.implants;
    const equipped = imp?.equipped ?? null;
    if (this.implantCards.size === 0) {
      for (const def of this.implantDefs()) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'inv-implant-card';
        card.style.setProperty('--ic', def.color);
        card.dataset.id = def.id;
        const ico = document.createElement('span');
        ico.className = 'ico';
        ico.textContent = def.icon;
        const body = document.createElement('span');
        body.className = 'body';
        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = def.name;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = TEXT.implant.mode[def.mode];
        const desc = document.createElement('span');
        desc.className = 'desc';
        desc.textContent = def.description;
        const line = document.createElement('span');
        line.className = 'line';
        line.append(nm, tag);
        body.append(line, desc);
        card.append(ico, body);
        card.addEventListener('click', (e) => { e.stopPropagation(); this.pickImplant(def.id); });
        this.implantPicker.appendChild(card);
        this.implantCards.set(def.id, card);
      }
    }
    for (const [id, card] of this.implantCards) card.classList.toggle('is-equipped', id === equipped);
  }

  private pickImplant(id: ImplantId): void {
    const imp = this.ctx.implants;
    if (!imp) return;
    const next = imp.equipped === id ? null : id;
    if (!imp.setEquipped(next)) { this.sys.sfx('ui_error'); return; }
    this.sys.sfx('ui_equip');
    const def = imp.getDef(id);
    this.ctx.bus.emit('ui:notify', { text: next ? `${def?.name ?? id} ${TEXT.implant.equipped}` : TEXT.implant.unequipped, kind: 'success', duration: 1.6 });
    this.refreshImplant();
    if (next) this.closePicker();
  }

  /* ── quick-use wheel panel ─────────────────────────────────────────────── */

  /** 3×3 compass rose (N top, clockwise) + a legend column; cells the bag has not unlocked (`isQuickSlotActive`) are locked. */
  private buildQuickPanel(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'inv-quick';
    const rose = document.createElement('div');
    rose.className = 'inv-quick-rose';
    for (const index of QUICK_ROSE_ORDER) {
      if (index < 0) {
        const centre = document.createElement('div');
        centre.className = 'inv-quick-centre';
        this.quickKey = document.createElement('kbd');
        this.quickKey.textContent = keyLabel(Keys.QUICK);
        this.quickCount = document.createElement('span');
        this.quickCount.className = 'inv-quick-count';
        centre.append(this.quickKey, this.quickCount);
        rose.appendChild(centre);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'inv-quick-cell';
      el.dataset.index = String(index);
      el.style.setProperty('--dir-x', String([0, 1, 1, 1, 0, -1, -1, -1][index]));
      el.style.setProperty('--dir-y', String([-1, -1, 0, 1, 1, 1, 0, -1][index]));
      const dir = document.createElement('div');
      dir.className = 'inv-quick-dir';
      dir.textContent = QUICK_DIR_GLYPH[index];
      const lock = document.createElement('div');
      lock.className = 'inv-quick-lock';
      lock.innerHTML = LOCK_SVG;
      const body = document.createElement('div');
      body.className = 'inv-quick-body';
      el.append(dir, lock, body);
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onQuickContextMenu(index, e);
      });
      rose.appendChild(el);
      this.quickCells[index] = { index, el, tile: null, uid: null }; // indexed by wheel slot, not DOM order
    }
    const legend = document.createElement('div');
    legend.className = 'inv-quick-legend';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'inv-eyebrow';
    eyebrow.textContent = TEXT.quick.eyebrow;
    const title = document.createElement('div');
    title.className = 'inv-quick-title';
    title.textContent = TEXT.quick.title;
    const hint = document.createElement('div');
    hint.className = 'inv-quick-hint';
    hint.textContent = TEXT.quick.hint;
    this.quickHold = document.createElement('div');
    this.quickHold.className = 'inv-quick-hint';
    this.quickHold.textContent = TEXT.quick.holdHint(keyLabel(Keys.QUICK));
    legend.append(eyebrow, title, hint, this.quickHold);
    section.append(rose, legend);
    return section;
  }

  private refreshQuick(): void {
    const slots = this.sys.getQuickSlots();
    const active = this.sys.getQuickSlotCount();
    this.quickCount.textContent = `${active}/${QUICK_SLOTS}`;
    const badges = new Map<string, string>();
    for (const cell of this.quickCells) {
      const item = slots[cell.index] ?? null;
      const def = item ? ITEM_DEF_MAP.get(item.defId) : undefined;
      const locked = !isQuickSlotActive(cell.index, active); // unlock order N, S, E, W, then diagonals
      cell.el.classList.toggle('is-locked', locked);
      cell.el.title = locked ? TEXT.quick.locked : `${QUICK_SLOT_LABEL_KO[cell.index]} · ${def?.name ?? TEXT.quick.empty}`;
      const body = cell.el.querySelector<HTMLElement>('.inv-quick-body')!;
      if (item && def) {
        badges.set(item.uid, QUICK_DIR_GLYPH[cell.index]);
        if (!cell.tile) {
          cell.tile = document.createElement('div');
          this.bindQuickTile(cell.tile, cell);
          body.innerHTML = '';
          body.appendChild(cell.tile);
        }
        const wasDragging = cell.tile.classList.contains('is-dragging');
        buildTileContent(cell.tile, item, def, 1, 1);
        if (wasDragging) cell.tile.classList.add('is-dragging');
        cell.tile.dataset.uid = item.uid;
        cell.uid = item.uid;
        cell.el.classList.add('has-item');
        cell.el.style.setProperty('--rc', def.color);
      } else {
        cell.tile = null;
        cell.uid = null;
        body.innerHTML = '';
        cell.el.classList.remove('has-item');
        cell.el.style.removeProperty('--rc');
      }
    }
    this.bagView.setQuickBadges(badges);
  }

  private bindQuickTile(el: HTMLElement, cell: QuickCell): void {
    el.addEventListener('pointerdown', (e) => { if (cell.uid) this.beginPress(cell.uid, BAG_LOC, e, el, cell.index); });
    el.addEventListener('pointerenter', (e) => { if (cell.uid) this.hoverEnter(cell.uid, BAG_LOC, e); });
    el.addEventListener('pointermove', (e) => this.tooltip.move(e.clientX, e.clientY));
    el.addEventListener('pointerleave', () => this.hoverLeave());
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (this.drag?.started) return;
      this.result(this.sys.setQuickSlot(cell.index, null) ? 'ok' : 'fail', 'ui_drop', BAG_LOC, cell.uid ?? '');
    });
  }

  /** Right-click on a wheel cell: `빠른 슬롯 해제` (assigned cells only). */
  private onQuickContextMenu(index: number, e: MouseEvent): void {
    if (this.drag?.started || this.dialog.isOpen) return;
    this.menu.close();
    const cell = this.quickCells[index];
    const uid = cell?.uid;
    if (!uid) return;
    this.tooltip.hide();
    const entries: MenuEntry[] = [
      { label: TEXT.menu.quickClear, run: () => this.result(this.sys.setQuickSlot(index, null) ? 'ok' : 'fail', 'ui_drop', BAG_LOC, uid) },
      { label: TEXT.menu.request, hint: '휠클릭', separator: true, run: () => { this.sys.requestItem(uid, BAG_LOC); } },
    ];
    this.menu.open(e.clientX, e.clientY, entries);
  }

  /** Wheel cell under the pointer (null when not over the rose). */
  private quickCellAt(x: number, y: number): QuickCell | null {
    const el = document.elementFromPoint(x, y);
    const cellEl = el && (el as Element).closest<HTMLElement>('.inv-quick-cell');
    if (!cellEl) return null;
    const index = Number(cellEl.dataset.index);
    return this.quickCells[index] ?? null;
  }

  private refreshSlots(): void {
    const loadout = this.sys.getLoadout();
    for (const sv of this.slots.values()) {
      const item = loadout[sv.slot];
      const def = item ? ITEM_DEF_MAP.get(item.defId) : undefined;
      if (item && def) {
        if (!sv.tile) {
          sv.tile = document.createElement('div');
          this.bindSlotTile(sv.tile, sv);
          sv.body.innerHTML = '';
          sv.body.appendChild(sv.tile);
        }
        sv.uid = item.uid;
        const stats = this.sys.getStats(item);
        buildTileContent(sv.tile, item, def, def.width, def.height, stats);
        sv.tile.dataset.uid = item.uid;
        // oversized tiles (SR 5×1) shrink to the slot body
        const { width, height } = tileSize(def.width, def.height);
        const scale = Math.min(1, sv.bodyW / width, sv.bodyH / height);
        sv.tile.style.transform = scale < 1 ? `scale(${scale.toFixed(3)})` : '';
        if (stats) {
          const max = stats.maxDurability;
          const cur = Math.max(0, Math.min(max, item.durability ?? max));
          sv.meta.textContent = `${def.name} · ${item.ammoInMag ?? 0}/${stats.magSize}발 · ${TEXT.weaponStats.durability} ${cur}/${max}`;
          sv.el.classList.toggle('is-worn', cur < max);
        } else if (def.bag) {
          sv.meta.textContent = `${def.name} · ${def.bag.cols}×${def.bag.rows} · ${TEXT.quickSlots} ${def.bag.quickSlots}`;
          sv.el.classList.remove('is-worn');
        } else if (def.armorId) {
          const a = this.sys.getLoot().getArmorDef(def.armorId);
          const max = def.durabilityMax ?? 0;
          const cur = Math.max(0, Math.min(max, item.durability ?? max));
          sv.meta.textContent = a
            ? `${def.name} · ${TEXT.armorStats.dr} ${Math.round(a.damageReduction * 100)}% · ${TEXT.armorStats.durability} ${Math.round(cur)}/${max}`
            : def.name;
          sv.el.classList.toggle('is-worn', max > 0 && cur < max);
        } else {
          sv.meta.textContent = def.name;
          sv.el.classList.remove('is-worn');
        }
        sv.el.classList.add('has-item');
        sv.el.style.setProperty('--rc', def.color);
      } else {
        sv.tile = null;
        sv.uid = null;
        sv.body.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'inv-slot-empty';
        empty.innerHTML = `<svg viewBox="0 0 64 24" aria-hidden="true"><path d="M2 12h40l6-4h8l4 4v4H46l-4 4H30l-2 3h-6l1-3H2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg><span>${TEXT.emptySlot}</span>`;
        sv.body.appendChild(empty);
        sv.meta.textContent = '';
        sv.el.classList.remove('has-item', 'is-worn');
        sv.el.style.removeProperty('--rc');
      }
    }
  }

  private buildSlot(slot: SlotId, label: string): SlotView {
    const el = document.createElement('div');
    el.className = `inv-slot inv-slot-${slot}`;
    el.dataset.slot = slot;
    const head = document.createElement('div');
    head.className = 'inv-slot-label';
    head.textContent = label;
    let key: HTMLElement | null = null;
    if (slotKeyLabel(slot)) {
      key = document.createElement('kbd');
      key.textContent = slotKeyLabel(slot);
      head.appendChild(key);
    }
    const body = document.createElement('div');
    body.className = 'inv-slot-body';
    const { width, height } = slot === 'bag' ? tileSize(2, 2) : slot === 'armor' ? tileSize(2, 3) : tileSize(4, 2);
    body.style.width = `${width}px`;
    body.style.height = `${height}px`;
    const meta = document.createElement('div');
    meta.className = 'inv-slot-meta';
    el.append(head, body, meta);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sv = this.slots.get(slot);
      if (sv?.uid) this.onContextMenu(sv.uid, { kind: 'slot', slot }, e);
    });
    const sv: SlotView = { slot, el, body, bodyW: width, bodyH: height, meta, key, tile: null, uid: null };
    this.slots.set(slot, sv);
    return sv;
  }

  private bindSlotTile(el: HTMLElement, sv: SlotView): void {
    const loc = (): ItemLocation => ({ kind: 'slot', slot: sv.slot });
    el.addEventListener('pointerdown', (e) => { if (sv.uid) this.beginPress(sv.uid, loc(), e, el); });
    el.addEventListener('pointerenter', (e) => { if (sv.uid) this.hoverEnter(sv.uid, loc(), e); });
    el.addEventListener('pointermove', (e) => this.tooltip.move(e.clientX, e.clientY));
    el.addEventListener('pointerleave', () => this.hoverLeave());
  }

  /* ── grid routing ──────────────────────────────────────────────────────── */

  private viewOf(grid: GridId): GridView {
    return grid === 'bag' ? this.bagView : grid === 'stash' ? this.stashView : this.containerView;
  }

  /** Grids that accept drops right now (crate + bag on a mission, stash + bag in the ship). */
  private activeViews(): GridView[] {
    const out: GridView[] = [];
    if (this.container) out.push(this.containerView);
    if (this.hub) out.push(this.stashView);
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
        if (this.drag) return;
        this.onContextMenu(uid, { kind: 'grid', grid: gridId }, e);
      },
      onDblClick: (uid: string, gridId: GridId) => {
        if (this.drag?.started) return;
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

  private hoverEnter(uid: string, loc: ItemLocation, e: PointerEvent): void {
    if (this.drag?.started) return;
    if (this.locked(uid, loc)) { this.hovered = null; this.tooltip.hide(); return; }
    this.hovered = { uid, loc };
    const item = this.sys.findItem(uid, loc);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (item && def) this.tooltip.show(item, def, e.clientX, e.clientY);
  }

  private hoverLeave(): void {
    this.hovered = null;
    this.tooltip.hide();
  }

  /** Result → sound + shake. `okSfx` is what plays on success; `pending` (host-confirmed take) stays silent until the answer. */
  private result(r: 'ok' | 'noop' | 'fail' | 'pending', okSfx: 'ui_drop' | 'ui_equip' | 'ui_pickup' | 'ui_rotate', from: ItemLocation, uid: string): void {
    if (r === 'ok') this.sys.sfx(okSfx);
    else if (r === 'fail') { this.sys.sfx('ui_error'); this.shake(from, uid); }
  }

  private shake(loc: ItemLocation, uid: string): void {
    if (loc.kind === 'grid') {
      this.viewOf(loc.grid).shake(uid);
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
  private onContextMenu(uid: string, from: ItemLocation, e: MouseEvent): void {
    if (this.drag?.started || this.dialog.isOpen) return;
    this.menu.close();
    this.closePicker();
    if (this.locked(uid, from)) return;
    const item = this.sys.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return;
    const isStack = def.stackMax > 1 && item.qty >= 2;
    const quickable = isQuickUsable(def) && from.kind === 'grid' && from.grid === 'bag';
    const repairable = this.hub && !!this.sys.repairInfo(uid);
    const breakable = this.canDisassemble(uid, from);
    const hasMenu = isStack || isWeaponDef(def) || isBagDef(def) || isArmorDef(def) || quickable || repairable || breakable;
    if (!hasMenu && !e.shiftKey) {
      this.result(this.sys.quickMove(uid, from), 'ui_drop', from, uid);
      return;
    }
    this.tooltip.hide();
    this.menu.open(e.clientX, e.clientY, this.menuEntries(uid, from, item, def));
  }

  /**
   * Weapons: quick action (장착 / 주무기 II로 장착 / 가방으로 이동 / 상자로 이동 / 창고로 이동) · 수리 (ship, worn gear) ·
   * 장전된 탄약 모두 탈착 (ammo loaded) · 무기 소켓 모두 탈착 (any socket filled) · 탄약 요청 · 버리기 (mission only).
   * Bags / armor: 장착 / 가방으로 이동 · 요청 · 버리기. Attachments are socketed by drag only (no 장착 entry). Stacks add the split entries.
   */
  private menuEntries(uid: string, from: ItemLocation, item: ItemInstance, def: ItemDef): MenuEntry[] {
    const entries: MenuEntry[] = [];
    const isWeapon = isWeaponDef(def);
    const isStack = def.stackMax > 1 && item.qty >= 2;
    const hasContainer = !!this.sys.getActiveContainer();
    const quick = () => this.result(this.sys.quickMove(uid, from), 'ui_drop', from, uid);
    const owned = from.kind === 'slot' || from.grid === 'bag';

    // 1. quick action (what a plain right-click / double-click does)
    if (from.kind === 'slot') {
      entries.push({ label: TEXT.menu.toBag, run: quick });
      if (this.hub) entries.push({ label: TEXT.menu.toStash, run: () => this.result(this.sys.moveToStash(uid, from), 'ui_drop', from, uid) });
    } else {
      const target = this.sys.equipTargetFor(def);
      if (target) {
        const label = target === 'primary2' ? TEXT.menu.equipPrimary2 : TEXT.menu.equip;
        entries.push({ label, run: () => this.result(this.sys.activate(uid, from), 'ui_equip', from, uid) });
        if (def.category === 'primary' && target !== 'primary2') {
          entries.push({ label: TEXT.menu.equipPrimary2, run: () => this.result(this.sys.equip(uid, 'primary2') ? 'ok' : 'fail', 'ui_equip', from, uid) });
        }
      }
      if (from.grid === 'container') entries.push({ label: TEXT.menu.toBag, run: quick });
      else if (from.grid === 'stash') entries.push({ label: TEXT.menu.toBag, run: quick });
      else if (hasContainer && !isBagDef(def)) entries.push({ label: TEXT.menu.toContainer, run: quick });
      else if (this.hub && !isBagDef(def)) entries.push({ label: TEXT.menu.toStash, run: quick });
    }

    // 1a. repair (ship only, worn weapon / armor the player owns)
    if (this.hub && owned) {
      const info = this.sys.repairInfo(uid);
      if (info) {
        // Phase 8: the material requirement is item chips (thumbnail + 보유/필요), not a text run
        const costs = document.createElement('div');
        const have = new Map(info.cost.map((c) => [c.defId, c.have]));
        renderItemCost(costs, info.cost, (id) => ITEM_DEF_MAP.get(id), (id) => have.get(id) ?? 0, { size: 28 });
        entries.push({
          label: TEXT.menu.repair,
          hint: info.short ? TEXT.menu.repairShort : undefined,
          costs,
          separator: entries.length > 0,
          run: () => {
            const ok = this.sys.repair(uid);
            this.result(ok ? 'ok' : 'fail', 'ui_equip', from, uid);
            if (!ok) this.ctx.bus.emit('ui:notify', { text: info.short ? TEXT.menu.repairShortMsg : TEXT.menu.repairFail, kind: 'warning', duration: 2 });
          },
        });
      }
    }

    // 1b. weapon maintenance (player-owned weapons only)
    if (isWeapon && owned) {
      if ((item.ammoInMag ?? 0) > 0) {
        entries.push({ label: TEXT.menu.unload, separator: entries.length > 0, run: () => this.result(this.sys.unloadWeapon(uid) ? 'ok' : 'fail', 'ui_drop', from, uid) });
      }
      if (filledSocketCount(item) > 0) {
        entries.push({ label: TEXT.menu.detachAll, run: () => this.result(this.sys.detachAllSockets(uid) ? 'ok' : 'fail', 'ui_drop', from, uid) });
      }
    }

    // 1c. quick-use wheel (bag stims / grenades)
    if (isQuickUsable(def) && from.kind === 'grid' && from.grid === 'bag') {
      const idx = this.sys.quickIndexOf(uid);
      if (idx >= 0) {
        entries.push({ label: `${TEXT.menu.quickClear} (${QUICK_DIR_GLYPH[idx]})`, separator: entries.length > 0, run: () => this.result(this.sys.setQuickSlot(idx, null) ? 'ok' : 'fail', 'ui_drop', from, uid) });
      } else {
        entries.push({ label: TEXT.menu.quickAssign, hint: '더블클릭', separator: entries.length > 0, run: () => this.result(this.sys.registerQuick(uid), 'ui_equip', from, uid) });
      }
    }

    // 1d. 분해 (Phase 8): any item with a matching `break_*` recipe — the ammo packs today
    if (this.canDisassemble(uid, from)) {
      entries.push({
        label: TEXT.disassemble.menu,
        separator: entries.length > 0,
        run: () => this.openDisassemble(uid),
      });
    }

    // 2. split
    if (isStack && from.kind === 'grid') {
      const half = Math.max(1, Math.floor(item.qty / 2));
      entries.push({ label: TEXT.menu.splitHalf, hint: 'Shift', separator: entries.length > 0, run: () => this.split(uid, from, half) });
      if (item.qty > 2) entries.push({ label: TEXT.menu.splitOne, hint: 'Ctrl', run: () => this.split(uid, from, 1) });
      entries.push({ label: TEXT.menu.splitCustom, run: () => this.openSplitDialog(uid, from) });
    }

    // 3. quick chat request
    entries.push({
      label: isWeapon ? TEXT.menu.requestAmmo : TEXT.menu.request,
      hint: '휠클릭',
      separator: entries.length > 0,
      run: () => { this.sys.requestItem(uid, from); },
    });

    // 4. drop (not in the ship — there is no ground to drop onto)
    if (!this.hub) {
      const dropKey = keyLabel(Keys.DROP_ITEM);
      entries.push({ label: TEXT.menu.drop, hint: dropKey, danger: true, separator: true, run: () => this.dropToWorld(uid, from, undefined) });
      if (isStack) entries.push({ label: TEXT.menu.dropOne, hint: `Shift+${dropKey}`, danger: true, run: () => this.dropToWorld(uid, from, 1) });
    }
    return entries;
  }

  /**
   * Phase 8 — 분해 is offered on player-owned items (bag / equipment slots) that have a `break_*` recipe; a
   * container stack must be taken first, because the recipe consumes from the bag.
   */
  private canDisassemble(uid: string, from: ItemLocation): boolean {
    // the recipe consumes from the bag, so a crate / 창고 stack has to be taken into the bag first
    if (from.kind === 'grid' && from.grid !== 'bag') return false;
    return !!this.sys.disassembleRecipeFor(uid);
  }

  /** Open the modeless 분해 dialog for `uid` (expected result + a 분해 button). False when the item has no recipe. */
  openDisassemble(uid: string): boolean {
    this.menu.close();
    this.closePicker();
    this.tooltip.hide();
    if (this.disassemble.isOpen) this.disassemble.close();
    const ok = this.disassemble.open(uid, null);
    this.sys.sfx(ok ? 'ui_pickup' : 'ui_error');
    return ok;
  }

  /** The 분해 dialog (smoke tests). */
  get disassemblePanel(): DisassemblePanel { return this.disassemble; }

  private split(uid: string, from: ItemLocation, qty: number): void {
    const ok = this.sys.splitItem(uid, qty);
    this.result(ok ? 'ok' : 'fail', 'ui_pickup', from, uid);
  }

  private openSplitDialog(uid: string, from: ItemLocation): void {
    const item = this.sys.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return;
    this.tooltip.hide();
    this.dialog.open(item, def, (qty) => this.split(uid, from, qty));
  }

  private dropToWorld(uid: string, from: ItemLocation, qty: number | undefined): void {
    const ok = this.sys.dropItem(uid, qty);
    if (ok) this.sys.sfx('ui_drop');
    else { this.sys.sfx('ui_error'); this.shake(from, uid); }
    if (this.hovered?.uid === uid) { this.hovered = null; this.tooltip.hide(); }
  }

  /* ── drop key (X) ──────────────────────────────────────────────────────── */

  /** X drops the dragged or hovered item; Shift+X one unit, Ctrl+X half the stack. In the ship the item lands in the stash. */
  onDropKey(shift: boolean, ctrl: boolean): void {
    if (this.dialog.isOpen) return;
    this.menu.close();
    const d = this.drag;
    if (d?.catalog) { this.cancelDrag(); return; } // a catalog instance has nothing to throw away
    let uid: string, from: ItemLocation;
    if (d?.started) { uid = d.uid; from = d.from; }
    else if (this.hovered) { uid = this.hovered.uid; from = this.hovered.loc; }
    else return;
    const item = this.sys.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return;
    let qty: number | undefined;
    if (d?.started && d.qty !== null) qty = d.qty;
    else if (def.stackMax > 1 && item.qty >= 2) {
      if (shift) qty = 1;
      else if (ctrl) qty = Math.max(1, Math.floor(item.qty / 2));
    }
    if (d) this.cancelDrag();
    this.dropToWorld(uid, from, qty);
  }

  /* ── rotation (R) ──────────────────────────────────────────────────────── */

  onRotateKey(): void {
    if (this.dialog.isOpen) return;
    if (this.drag?.started) {
      const d = this.drag;
      const def = d.def;
      if (def.width === def.height) return;
      d.rotated = !d.rotated;
      this.rebuildGhost(d);
      this.sys.sfx('ui_rotate');
      this.updateDragTarget(d.lastX, d.lastY);
      return;
    }
    const h = this.hovered;
    if (!h || h.loc.kind !== 'grid') return;
    const r = this.sys.rotateItem(h.uid, h.loc.grid);
    this.result(r, 'ui_rotate', h.loc, h.uid);
  }

  /* ── drag & drop ───────────────────────────────────────────────────────── */

  private beginPress(uid: string, from: ItemLocation, e: PointerEvent, tileEl: HTMLElement, quickFrom: number | null = null): void {
    if (this.drag || this.dialog.isOpen) return;
    if (e.button === MIDDLE_BUTTON) {
      // quick chat request (also stops the browser's middle-click autoscroll)
      e.preventDefault();
      this.menu.close();
      if (!this.locked(uid, from)) this.sys.requestItem(uid, from);
      return;
    }
    if (e.button !== 0) return;
    if (this.locked(uid, from)) return;
    const item = this.sys.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return;
    e.preventDefault();
    this.menu.close();
    this.closePicker();
    // Shift → half the stack, Ctrl → one unit (grid stacks only; falls back to a whole-item drag)
    let qty: number | null = null;
    if (from.kind === 'grid' && quickFrom === null) {
      if (e.shiftKey) qty = this.sys.partialQtyFor(item, 'half');
      else if (e.ctrlKey) qty = this.sys.partialQtyFor(item, 'one');
    }
    const r = tileEl.getBoundingClientRect();
    this.drag = {
      uid, item, def, from, quickFrom, qty, catalog: false,
      rotated: item.rotated,
      started: false,
      startX: e.clientX, startY: e.clientY,
      grabX: e.clientX - r.left, grabY: e.clientY - r.top,
      ghost: null, target: null,
      lastX: e.clientX, lastY: e.clientY,
    };
    window.addEventListener('pointermove', this.onWindowMove);
    window.addEventListener('pointerup', this.onWindowUp);
    window.addEventListener('pointercancel', this.onWindowUp);
  }

  private startDrag(d: DragState): void {
    d.started = true;
    this.tooltip.hide();
    this.root?.classList.add('is-dragging');
    if (d.catalog) {
      // catalog: the source tile stays as it is (infinite stock); no world drop, no wheel targets
      this.root?.classList.add('is-catalog-drag');
      this.rebuildGhost(d);
      this.sys.sfx('ui_pickup');
      return;
    }
    // a stim / grenade from the bag (or a wheel cell): light the usable cells as targets
    if (isQuickUsable(d.def) && d.from.kind === 'grid' && d.from.grid === 'bag' && d.qty === null) this.root?.classList.add('is-quick-drag');
    if (d.quickFrom !== null) {
      this.quickCells[d.quickFrom]?.tile?.classList.add('is-dragging');
      this.root?.classList.add('is-quick-source');
    } else if (d.from.kind === 'grid') {
      const view = this.viewOf(d.from.grid);
      if (d.qty !== null) view.markSplitSource(d.uid, d.item.qty - d.qty);
      else view.setDragging(d.uid);
    } else {
      this.slots.get(d.from.slot)?.tile?.classList.add('is-dragging');
    }
    this.rebuildGhost(d);
    this.sys.sfx('ui_pickup');
  }

  private footprint(d: DragState): { w: number; h: number } {
    return d.rotated ? { w: d.def.height, h: d.def.width } : { w: d.def.width, h: d.def.height };
  }

  private rebuildGhost(d: DragState): void {
    const { w, h } = this.footprint(d);
    if (!d.ghost) {
      d.ghost = document.createElement('div');
      this.ghostLayer.appendChild(d.ghost);
    }
    const ghostItem: ItemInstance = { ...d.item, rotated: d.rotated, qty: d.qty ?? d.item.qty };
    buildTileContent(d.ghost, ghostItem, d.def, w, h);
    d.ghost.classList.add('inv-ghost');
    d.ghost.classList.toggle('is-partial', d.qty !== null);
    const { width, height } = tileSize(w, h);
    // keep the ghost anchored under the cursor: clamp grab offset into the new footprint
    d.grabX = Math.min(Math.max(d.grabX, STEP * 0.5), width - STEP * 0.5);
    d.grabY = Math.min(Math.max(d.grabY, STEP * 0.5), height - STEP * 0.5);
    this.positionGhost(d, d.lastX, d.lastY);
  }

  private positionGhost(d: DragState, x: number, y: number): void {
    if (!d.ghost) return;
    d.ghost.style.transform = `translate(${Math.round(x - d.grabX)}px, ${Math.round(y - d.grabY)}px)`;
  }

  private handlePointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    d.lastX = e.clientX; d.lastY = e.clientY;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
      this.startDrag(d);
    }
    this.positionGhost(d, e.clientX, e.clientY);
    this.updateDragTarget(e.clientX, e.clientY);
  }

  private updateDragTarget(px: number, py: number): void {
    const d = this.drag;
    if (!d || !d.started) return;
    this.bagView.hideHighlight();
    this.containerView.hideHighlight();
    this.stashView.hideHighlight();
    for (const sv of this.slots.values()) sv.el.classList.remove('is-target-ok', 'is-target-bad');
    d.target = null;
    this.dropZone.classList.remove('is-hot');
    this.clearSocketTarget();
    for (const c of this.quickCells) c.el.classList.remove('is-target-ok', 'is-target-bad', 'is-target-swap');

    if (d.catalog) { this.updateCatalogTarget(d, px, py); return; }

    // quick-use wheel cells (any drag: non-usable items light red)
    const cell = this.quickCellAt(px, py);
    if (cell) {
      d.target = { kind: 'quick', index: cell.index };
      const pv = this.preview(d, d.target);
      cell.el.classList.add(pv === 'bad' ? 'is-target-bad' : pv === 'swap' ? 'is-target-swap' : 'is-target-ok');
      return;
    }
    // a wheel-cell drag released anywhere else clears the slot; no other target applies
    if (d.quickFrom !== null) return;

    // attachments: a weapon tile under the pointer (bag or equipment slot) is a socket target
    if (isAttachmentDef(d.def)) {
      const w = this.weaponTileAt(px, py, d.uid);
      if (w) {
        d.target = { kind: 'weapon', uid: w.uid, loc: w.loc };
        const pv = this.preview(d, d.target);
        this.setSocketTarget(w, pv === 'bad' ? 'bad' : 'ok');
        return;
      }
    }

    // equipment slots first
    for (const sv of this.slots.values()) {
      const r = sv.body.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
        d.target = { kind: 'slot', slot: sv.slot };
        const pv = this.preview(d, d.target);
        sv.el.classList.add(pv === 'bad' ? 'is-target-bad' : 'is-target-ok');
        return;
      }
    }

    const { w, h } = this.footprint(d);
    const left = px - d.grabX, top = py - d.grabY;
    for (const view of this.activeViews()) {
      const cell = view.cellForGhost(left, top, w, h, px, py);
      if (!cell) continue;
      d.target = { kind: 'grid', grid: view.id, x: cell.x, y: cell.y, rotated: d.rotated };
      const pv = this.preview(d, d.target);
      const state: HighlightState = pv === 'bad' ? 'bad' : pv === 'swap' ? 'swap' : pv === 'merge' ? 'merge' : 'ok';
      view.showHighlight(cell.x, cell.y, w, h, state);
      return;
    }

    // outside every grid/slot: over the backdrop → world drop (the zone lights up when hovered directly; hidden in the ship)
    if (!this.hub && !this.isOverPanel(px, py)) {
      const r = this.dropZone.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) this.dropZone.classList.add('is-hot');
    }
  }

  private preview(d: DragState, target: DropTarget) {
    if (d.catalog) return this.sys.previewCatalog(d.item, target);
    return d.qty !== null ? this.sys.previewPartial(d.uid, d.from, d.qty, target) : this.sys.previewDrop(d.uid, d.from, target);
  }

  /** Weapon tile under the pointer (the ghost layer ignores pointer events), excluding the dragged item itself. */
  private weaponTileAt(x: number, y: number, exceptUid: string): { uid: string; loc: ItemLocation } | null {
    const el = document.elementFromPoint(x, y);
    const tile = el && (el as Element).closest<HTMLElement>('.inv-tile.is-weapon');
    const uid = tile?.dataset.uid;
    if (!tile || !uid || uid === exceptUid) return null;
    const slotEl = tile.closest<HTMLElement>('.inv-slot');
    if (slotEl?.dataset.slot) return { uid, loc: { kind: 'slot', slot: slotEl.dataset.slot as SlotId } };
    if (tile.closest('.inv-grid-bag')) return { uid, loc: { kind: 'grid', grid: 'bag' } };
    if (tile.closest('.inv-grid-container')) return { uid, loc: { kind: 'grid', grid: 'container' } };
    if (tile.closest('.inv-grid-stash')) return { uid, loc: { kind: 'grid', grid: 'stash' } };
    return null;
  }

  private setSocketTarget(w: { uid: string; loc: ItemLocation }, state: 'ok' | 'bad'): void {
    this.socketTarget = w;
    if (w.loc.kind === 'grid') {
      this.viewOf(w.loc.grid).setSocketTarget(w.uid, state);
    } else {
      const tile = this.slots.get(w.loc.slot)?.tile;
      tile?.classList.toggle('is-socket-ok', state === 'ok');
      tile?.classList.toggle('is-socket-bad', state === 'bad');
    }
  }

  private clearSocketTarget(): void {
    if (!this.socketTarget) return;
    this.socketTarget = null;
    this.bagView.setSocketTarget(null, null);
    this.containerView.setSocketTarget(null, null);
    this.stashView.setSocketTarget(null, null);
    for (const sv of this.slots.values()) sv.tile?.classList.remove('is-socket-ok', 'is-socket-bad');
  }

  /** True when the point lies on a panel / equipment column (a miss there snaps back instead of dropping). */
  private isOverPanel(x: number, y: number): boolean {
    const el = document.elementFromPoint(x, y);
    return !!el && !!(el as Element).closest('.inv-panel, .inv-equip, .inv-menu, .inv-dialog, .scr-tabs, .inv-modeless, .inv-screen');
  }

  private handlePointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (e.button !== 0 && e.type === 'pointerup') return;
    window.removeEventListener('pointermove', this.onWindowMove);
    window.removeEventListener('pointerup', this.onWindowUp);
    window.removeEventListener('pointercancel', this.onWindowUp);
    this.drag = null;

    if (!d.started) return; // plain click
    this.endDragVisuals(d);

    // catalog instance: only a grid cell / slot takes it; anywhere else simply discards the fresh instance
    if (d.catalog) {
      if (!d.target) { this.sys.sfx('ui_error'); return; }
      const r = this.sys.dropFromCatalog(d.item, d.target);
      if (r === 'ok') this.sys.sfx(d.target.kind === 'grid' ? 'ui_drop' : 'ui_equip');
      else if (r === 'fail') { this.sys.sfx('ui_error'); this.catalogView.shake(d.def.id); }
      return;
    }

    // dragged out of a wheel cell: another cell moves the assignment, anywhere else clears it (the item stays in the bag)
    if (d.quickFrom !== null && d.target?.kind !== 'quick') {
      this.result(this.sys.setQuickSlot(d.quickFrom, null) ? 'ok' : 'fail', 'ui_drop', d.from, d.uid);
      return;
    }

    if (!d.target) {
      if (this.isOverPanel(e.clientX, e.clientY)) {
        // missed a cell but still on a panel: snap back
        this.shake(d.from, d.uid);
        this.sys.sfx('ui_error');
        return;
      }
      // released over the backdrop / drop zone: throw it into the world (ship: into the stash)
      this.dropToWorld(d.uid, d.from, d.qty ?? undefined);
      return;
    }
    const r = d.qty !== null ? this.sys.dropPartial(d.uid, d.from, d.qty, d.target) : this.sys.drop(d.uid, d.from, d.target);
    if (r === 'ok') this.sys.sfx(d.target.kind === 'grid' ? 'ui_drop' : 'ui_equip');
    else if (r === 'fail') { this.sys.sfx('ui_error'); this.shake(d.from, d.uid); }
  }

  private endDragVisuals(d: DragState): void {
    d.ghost?.remove();
    d.ghost = null;
    this.root?.classList.remove('is-dragging', 'is-quick-drag', 'is-quick-source', 'is-catalog-drag');
    this.dropZone.classList.remove('is-hot');
    for (const c of this.quickCells) {
      c.el.classList.remove('is-target-ok', 'is-target-bad', 'is-target-swap');
      c.tile?.classList.remove('is-dragging');
    }
    this.bagView.setDragging(null);
    this.containerView.setDragging(null);
    this.stashView.setDragging(null);
    if (d.qty !== null && d.from.kind === 'grid') this.viewOf(d.from.grid).markSplitSource(d.uid, null);
    this.bagView.hideHighlight();
    this.containerView.hideHighlight();
    this.stashView.hideHighlight();
    this.clearSocketTarget();
    for (const sv of this.slots.values()) {
      sv.el.classList.remove('is-target-ok', 'is-target-bad');
      sv.tile?.classList.remove('is-dragging');
    }
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    window.removeEventListener('pointermove', this.onWindowMove);
    window.removeEventListener('pointerup', this.onWindowUp);
    window.removeEventListener('pointercancel', this.onWindowUp);
    this.drag = null;
    if (d.started) this.endDragVisuals(d);
  }
}
