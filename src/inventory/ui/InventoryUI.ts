import './../inventory.css';
import type { EmbeddedView, GameContext, ItemDef, ItemInstance, KeyGuideEntry } from '@/shared';
import { Keys, QUICK_SLOTS, QUICK_SLOT_LABEL_KO, isQuickSlotActive, keyLabel, renderItemCost } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { Container } from '../Container';
import { LOADOUT_SLOTS, isArmorDef, isAttachmentDef, isBagDef, isWeaponDef, type DropTarget, type GridId, type InventorySystem, type ItemLocation, type SlotId } from '../InventorySystem';
import { CraftPanel } from './CraftPanel';
import { CatalogView } from './CatalogView';
import { DisassemblePanel } from './DisassemblePanel';
import { RepairPanel } from './RepairPanel';
import { ImplantPanel } from './ImplantPanel';
import { filledSocketCount } from '../Sockets';
import { isQuickUsable } from '../QuickSlots';
import { GridView, buildSlotCardContent, buildTileContent, type HighlightState } from './GridView';
import { Tooltip } from './Tooltip';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { SplitDialog } from './SplitDialog';
import { QUICK_DIR_GLYPH, QUICK_ROSE_ORDER, SLOT_LABEL, STEP, TEXT, fmtValue, slotKeyLabel, tierTitle, tileSize, fmtKg, weightLabel } from './labels';

import { BAG_LOC, CATALOG_DBL_MS, DRAG_THRESHOLD, type DragState, GHOST_SCALE, LOCK_SVG, MIDDLE_BUTTON, type QuickCell, SCREEN_TABS, type ScreenTab, type SlotView } from './model';
/** 폴더 공용 어휘(상수 · 타입 · 스크래치)는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 재수출한다. */
export * from './model';
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
  /** Right-hand column wrapper (`display: contents` normally): while 제작 is open it stacks 가방 over 함선 창고. */
  private rightCol!: HTMLElement;
  disassemble!: DisassemblePanel;
  /** 2026-09-08: 작업대 헤더의 `모두 수리` 가 여는 모달 팝업 (수리 목록은 더 이상 제작 패널 아래에 없다). */
  repair!: RepairPanel;
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
  private bagCapacity!: HTMLElement;
  private valueEl!: HTMLElement;
  containerView!: GridView;
  stashView!: GridView;
  bagView!: GridView;
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
  private hintsEl!: HTMLElement;
  tooltip!: Tooltip;
  ghostLayer!: HTMLElement;
  dropZone!: HTMLElement;
  menu!: ContextMenu;
  dialog!: SplitDialog;
  drag: DragState | null = null;
  hovered: { uid: string; loc: ItemLocation } | null = null;
  /** Weapon tile currently lit as a socket target (attachment drag). */
  socketTarget: { uid: string; loc: ItemLocation } | null = null;
  private container: Container | null = null;
  hub = false;
  private visible = false;
  private closeTimer: number | null = null;

  onWindowMove = (e: PointerEvent): void => this.handlePointerMove(e);
  onWindowUp = (e: PointerEvent): void => this.handlePointerUp(e);

  constructor(public readonly sys: InventorySystem, public readonly ctx: GameContext) {}

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
    // 2026-09-09: 튜토리얼 중에는 창고에서 그 단계의 재료 · 산출물만 보인다 (`stashItem` 게이트, 꺼져 있으면 항상 false)
    this.stashView.setHideItem((item) => this.ctx.tutorial?.hides('stashItem', item.defId) ?? false);
    const sScroll = document.createElement('div');
    sScroll.className = 'inv-stash-scroll';
    sScroll.appendChild(this.stashView.el);
    // 2026-09-08: 창고 하단의 '가방 ↔ 창고: 드래그 또는 우클릭…' 안내 줄은 없앴다 — 드래그와 우클릭은
    //   가방 격자에서 이미 하는 동작이라 화면에 한 줄 더 적어 둘 이유가 없다 (사용자 결정: 당연한 설명은 지운다).
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
    bActions.append(this.bagCapacity, craftBtn);
    bHead.append(bActions);
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
    this.craftPanel = new CraftPanel(this.sys, getDef, () => this.closeCraft(), (anchor) => this.repair.open(anchor));

    /* equipment column */
    const eq = document.createElement('aside');
    eq.className = 'inv-equip';
    const eqGrid = document.createElement('div');
    eqGrid.className = 'inv-equip-grid';
    for (const slot of LOADOUT_SLOTS) eqGrid.appendChild(this.buildSlot(slot, SLOT_LABEL[slot]).el);
    eq.appendChild(eqGrid);
    // 2026-09-08: 임플란트는 캐릭터 스탯이 아니라 들고 나가는 장비 — 장착 장비 칸 바로 아래가 제자리다
    this.implantPanel = new ImplantPanel(this.sys, this.ctx);
    eq.appendChild(this.implantPanel.root);

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

    /* 2026-09-07: 가방 + 함선 창고 share a wrapper. It is `display: contents` normally, so the flex `order`s below
       keep today's row (창고 · 장비 · 가방); while the 제작 column is open it becomes a real column and stacks the
       두 격자 on the right (가방 위 · 창고 아래). */
    this.rightCol = document.createElement('div');
    this.rightCol.className = 'inv-col-right';
    this.rightCol.append(bPanel, sPanel);
    layout.append(this.catalogView.el, this.rightCol, cPanel, this.craftPanel.el, eq);

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
    });
    this.ghostLayer = document.createElement('div');
    this.ghostLayer.className = 'inv-ghost-layer';

    /*
     * 2026-09-07 UI/UX: hints and the drop zone share one **fixed-height** slot. They used to be two siblings of the
     * centred column, and swapping the 37 px hint bar for the 63 px drop zone at drag start re-centred the whole
     * window (the panels visibly jumped up). The footer now reserves the taller of the two for good.
     */
    const footer = document.createElement('div');
    footer.className = 'inv-footer';
    footer.append(this.hintsEl, dropZone);

    root.append(this.tabsEl, this.creditsEl, layout, this.screenHost, this.screenNote, footer,
      this.modelessLayer, this.tooltip.el, this.ghostLayer);
    this.menu = new ContextMenu(root);
    // 2026-09-09: the 수량 지정 dialog is its own 키 가이드 owner (`Enter 확인`) stacked over the window's line
    this.dialog = new SplitDialog(root, (open) => this.ctx.bus.emit('ui:keyGuide', { owner: 'inventory.split', keys: open ? [{ key: 'Enter', label: '확인' }] : null }));
    this.ctx.uiRoot.appendChild(root);
    // key labels follow the live bindings
    this.ctx.bus.on('input:bindingsChanged', () => { this.refreshKeyLabels(); this.emitGuide(); });
    // 2026-09-08: 튜토리얼이 감춘 화면 탭 · 레시피는 단계가 넘어가거나 건너뛰어지는 즉시 돌아온다
    // 2026-09-09: the stash grid's `version` does not move when the 단계 does, so the hidden-item sweep is forced here
    this.ctx.bus.on('tutorial:changed', () => { this.markTab(); this.stashView.refresh(true); this.refresh(); });
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
    const dz = this.dropZone.querySelector<HTMLElement>('.inv-key-drop');
    if (dz) dz.textContent = keyLabel(Keys.DROP_ITEM);
  }

  /* ── 키 가이드 (2026-09-09) ────────────────────────────────────────────── */

  /**
   * Keys the window's active tab really answers to, for the bottom-right 키 가이드 (`ui:keyGuide`, owner
   * `'inventory'`). Labels are read live (`keyLabel`), so this is re-emitted on `input:bindingsChanged` and on every
   * tab change; the guide appends `Tab 닫기` itself, so the close key is never listed here. The embedded 캐릭터 / 기업 /
   * 함선 tabs are mouse-only → `[]` (the guide then shows the close entry alone).
   */
  guideKeys(): KeyGuideEntry[] {
    if (this.activeTab !== 'inventory') return [];
    return [
      { key: keyLabel(Keys.ROTATE_ITEM), label: '회전' },
      // X: 임무에서는 바닥에 버리고, 함선에서는 창고로 보낸다 (`InventorySystem.dropItem`)
      { key: keyLabel(Keys.DROP_ITEM), label: this.hub ? '창고로' : '버리기' },
      { key: '우클릭', label: '빠른 이동 · 메뉴' },
      { key: '휠클릭', label: '요청' },
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
   * 2026-09-08 (ESC = 항상 일시정지): Escape no longer closes the window, it cancels the innermost popup and
   * otherwise falls through to the 일시정지 메뉴. The 제작 column is a column of the window (its own 제작 button
   * toggles it), not a popup, so it deliberately stays open under the menu.
   */
  closePopups(): boolean {
    const a = this.dialog?.close() ?? false;
    const b = this.menu?.close() ?? false;
    const d = this.disassemble?.close() ?? false;
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
    this.hovered = null;
    this.ctx.bus.emit('ui:keyGuide', { owner: 'inventory', keys: null });   // … then the window's line goes
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
    this.disassemble?.dispose();
    this.repair?.dispose();
    this.implantPanel?.dispose();   // the two pickers are `ctx.uiRoot` children — they must go with the window
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
  setTab(tab: ScreenTab): void { return Screens.setTab(this, tab); }

  /** `createSheetView` / `createCorpView` / `createShipView`; null when that system is not present. */
  buildScreenView(tab: ScreenTab): EmbeddedView | null { return Screens.buildScreenView(this, tab); }

  markTab(): void { return Screens.markTab(this); }

  /** `크레딧 n` readout on the ship screen (`ctx.meta.credits`; refreshed on `meta:creditsChanged`). */
  refreshCredits(): void { return Screens.refreshCredits(this); }

  /* ── refresh ───────────────────────────────────────────────────────────── */

  refresh(): void {
    if (!this.root || this.root.hidden) return;
    const bag = this.sys.getGrid('bag');
    if (bag) {
      if (this.bagView.current !== bag) this.bagView.setGrid(bag);
      else this.bagView.refresh();
      // 2026-09-08: used / total cells only. The `5×3` grid size and the `퀵슬롯 n` count both restate what the
      //   grid and the rose right below already draw.
      this.bagCapacity.textContent = `${bag.usedCells()} / ${bag.cols * bag.rows}`;
      this.valueEl.textContent = fmtValue(bag.totalValue() + this.equippedValue());
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
    this.refreshQuick();
    this.refreshWeight();
    this.implantPanel.refresh();
    this.craftPanel.refresh();
    if (this.disassemble.isOpen) this.disassemble.refresh();
    if (this.repair.isOpen) this.repair.refresh();
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

  /** Right-click on a wheel cell: `빠른 슬롯 해제` (assigned cells only). */
  onQuickContextMenu(index: number, e: MouseEvent): void { return Menu.onQuickContextMenu(this, index, e); }

  /** Wheel cell under the pointer (null when not over the rose). */
  quickCellAt(x: number, y: number): QuickCell | null { return QuickUI.quickCellAt(this, x, y); }

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

  /* ── grid routing ──────────────────────────────────────────────────────── */

  viewOf(grid: GridId): GridView {
    return grid === 'bag' ? this.bagView : grid === 'stash' ? this.stashView : this.containerView;
  }

  /** Grids that accept drops right now (crate + bag on a mission, stash + bag in the ship). */
  activeViews(): GridView[] {
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

  hoverEnter(uid: string, loc: ItemLocation, e: PointerEvent): void {
    if (this.drag?.started) return;
    if (this.locked(uid, loc)) { this.hovered = null; this.tooltip.hide(); return; }
    this.hovered = { uid, loc };
    const item = this.sys.findItem(uid, loc);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (item && def) this.tooltip.show(item, def, e.clientX, e.clientY);
  }

  hoverLeave(): void {
    this.hovered = null;
    this.tooltip.hide();
  }

  /** Result → sound + shake. `okSfx` is what plays on success; `pending` (host-confirmed take) stays silent until the answer. */
  result(r: 'ok' | 'noop' | 'fail' | 'pending', okSfx: 'ui_drop' | 'ui_equip' | 'ui_pickup' | 'ui_rotate', from: ItemLocation, uid: string): void {
    if (r === 'ok') this.sys.sfx(okSfx);
    else if (r === 'fail') { this.sys.sfx('ui_error'); this.shake(from, uid); }
  }

  shake(loc: ItemLocation, uid: string): void {
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
