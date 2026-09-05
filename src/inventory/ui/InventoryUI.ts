import './../inventory.css';
import type { GameContext, ItemDef, ItemInstance } from '@/shared';
import { QUICK_SLOTS, QUICK_SLOT_LABEL_KO, isQuickSlotActive } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { Container } from '../Container';
import { LOADOUT_SLOTS, isArmorDef, isAttachmentDef, isBagDef, isWeaponDef, type DropTarget, type GridId, type InventorySystem, type ItemLocation, type SlotId } from '../InventorySystem';
import { CraftPanel } from './CraftPanel';
import { filledSocketCount } from '../Sockets';
import { isQuickUsable } from '../QuickSlots';
import { GridView, buildTileContent, type HighlightState } from './GridView';
import { Tooltip } from './Tooltip';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { SplitDialog } from './SplitDialog';
import { QUICK_DIR_GLYPH, QUICK_ROSE_ORDER, SLOT_KEY, SLOT_LABEL, STEP, TEXT, fmtValue, tierTitle, tileSize, fmtKg, weightLabel } from './labels';

const DRAG_THRESHOLD = 4; // px before a press becomes a drag
const MIDDLE_BUTTON = 1;
const BAG_LOC: ItemLocation = { kind: 'grid', grid: 'bag' };
const LOCK_SVG = '<svg viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="6" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 6V4a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

interface DragState {
  uid: string;
  item: ItemInstance;
  def: ItemDef;
  from: ItemLocation;
  /** Wheel cell the drag started from (its tile is a bag item); releasing anywhere but another cell clears that slot. */
  quickFrom: number | null;
  /** Units carried by a Shift (half) / Ctrl (one) drag; null = the whole item. */
  qty: number | null;
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
 * Arc Raiders-styled DOM for the Diablo grid: container panel (left), bag (center),
 * equipment column (right), hint bar. Owns drag & drop, rotation, tooltips.
 */
export class InventoryUI {
  private root: HTMLElement | null = null;
  private layout!: HTMLElement;
  private containerPanel!: HTMLElement;
  private containerTitle!: HTMLElement;
  private containerTier!: HTMLElement;
  private bagCapacity!: HTMLElement;
  private valueEl!: HTMLElement;
  private containerView!: GridView;
  private bagView!: GridView;
  private slots = new Map<SlotId, SlotView>();
  /* appended: tactical kit */
  private craftPanel!: CraftPanel;
  private weightEl!: HTMLElement;
  private weightValue!: HTMLElement;
  private weightState!: HTMLElement;
  private weightFill!: HTMLElement;
  private quickCells: QuickCell[] = [];
  private quickCount!: HTMLElement;
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
    cHead.append(cTitleWrap, takeAll);
    this.containerView = new GridView('container', getDef, getStats, this.tileHandlers());
    cPanel.append(cHead, this.containerView.el);
    this.containerPanel = cPanel;

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
    bPanel.append(bHead, this.bagView.el, this.buildQuickPanel(), this.weightEl, bFoot);
    this.craftPanel = new CraftPanel(this.sys, getDef);

    /* equipment column */
    const eq = document.createElement('aside');
    eq.className = 'inv-equip';
    const eqEyebrow = document.createElement('div');
    eqEyebrow.className = 'inv-eyebrow';
    eqEyebrow.textContent = TEXT.equipment;
    eq.appendChild(eqEyebrow);
    for (const slot of LOADOUT_SLOTS) eq.appendChild(this.buildSlot(slot, SLOT_LABEL[slot], SLOT_KEY[slot]).el);

    layout.append(cPanel, bPanel, this.craftPanel.el, eq);

    /* hints */
    const hints = document.createElement('div');
    hints.className = 'inv-hints';
    for (const [key, label] of TEXT.hints) {
      const h = document.createElement('span');
      h.className = 'inv-hint';
      const k = document.createElement('kbd');
      k.textContent = key;
      h.append(k, document.createTextNode(label));
      hints.appendChild(h);
    }

    /* world-drop zone (visible only while dragging; replaces the hint bar) */
    const dropZone = document.createElement('div');
    dropZone.className = 'inv-dropzone';
    const dzTitle = document.createElement('div');
    dzTitle.className = 'inv-dropzone-title';
    const dzKey = document.createElement('kbd');
    dzKey.textContent = 'X';
    dzTitle.append(document.createTextNode(TEXT.dropZone), dzKey);
    const dzSub = document.createElement('div');
    dzSub.className = 'inv-dropzone-sub';
    dzSub.textContent = TEXT.dropZoneHint;
    dropZone.append(dzTitle, dzSub);
    this.dropZone = dropZone;

    this.tooltip = new Tooltip({ getWeapon: getWeaponDef, getDef, getStats, getArmorDef: (id) => this.sys.getLoot().getArmorDef(id) });
    this.ghostLayer = document.createElement('div');
    this.ghostLayer.className = 'inv-ghost-layer';

    root.append(layout, hints, dropZone, this.tooltip.el, this.ghostLayer);
    this.menu = new ContextMenu(root);
    this.dialog = new SplitDialog(root);
    this.ctx.uiRoot.appendChild(root);
  }

  /** Close the context menu / split dialog if open. Returns true when something was closed (Escape consumed). */
  closeOverlays(): boolean {
    const a = this.dialog?.close() ?? false;
    const b = this.menu?.close() ?? false;
    return a || b;
  }

  show(container: Container | null): void {
    if (!this.root) return;
    if (this.closeTimer !== null) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    this.container = container;
    this.containerPanel.hidden = !container;
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
    this.bagView.setGrid(this.sys.getGrid('bag'));
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
    this.bagView.dispose();
    this.tooltip.dispose();
    this.root?.remove();
    this.root = null;
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
    this.refreshSlots();
    this.refreshQuick();
    this.refreshWeight();
    this.craftPanel.refresh();
  }

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
    this.craftPanel.setOpen(open);
    this.sys.sfx('ui_pickup');
  }

  /** Repaint the craft rows (progress / counts) without rebuilding the rest of the window. */
  refreshCraft(): void {
    if (!this.root || this.root.hidden) return;
    this.craftPanel.refresh();
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
        const k = document.createElement('kbd');
        k.textContent = TEXT.quick.key;
        this.quickCount = document.createElement('span');
        this.quickCount.className = 'inv-quick-count';
        centre.append(k, this.quickCount);
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
    const hold = document.createElement('div');
    hold.className = 'inv-quick-hint';
    hold.textContent = TEXT.quick.holdHint;
    legend.append(eyebrow, title, hint, hold);
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
        } else if (def.bag) {
          sv.meta.textContent = `${def.name} · ${def.bag.cols}×${def.bag.rows} · ${TEXT.quickSlots} ${def.bag.quickSlots}`;
        } else if (def.armorId) {
          const a = this.sys.getLoot().getArmorDef(def.armorId);
          const max = def.durabilityMax ?? 0;
          const cur = Math.max(0, Math.min(max, item.durability ?? max));
          sv.meta.textContent = a
            ? `${def.name} · ${TEXT.armorStats.dr} ${Math.round(a.damageReduction * 100)}% · ${TEXT.armorStats.durability} ${Math.round(cur)}/${max}`
            : def.name;
        } else {
          sv.meta.textContent = def.name;
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
        sv.el.classList.remove('has-item');
        sv.el.style.removeProperty('--rc');
      }
    }
  }

  private buildSlot(slot: SlotId, label: string, key: string): SlotView {
    const el = document.createElement('div');
    el.className = `inv-slot inv-slot-${slot}`;
    el.dataset.slot = slot;
    const head = document.createElement('div');
    head.className = 'inv-slot-label';
    head.textContent = label;
    if (key) {
      const k = document.createElement('kbd');
      k.textContent = key;
      head.appendChild(k);
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
    const sv: SlotView = { slot, el, body, bodyW: width, bodyH: height, meta, tile: null, uid: null };
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

  /* ── tile handlers ─────────────────────────────────────────────────────── */

  private tileHandlers() {
    return {
      onPointerDown: (uid: string, gridId: GridId, e: PointerEvent) => {
        const view = gridId === 'bag' ? this.bagView : this.containerView;
        const el = view.tileEl(uid);
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
    this.hovered = { uid, loc };
    const item = this.sys.findItem(uid, loc);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (item && def) this.tooltip.show(item, def, e.clientX, e.clientY);
  }

  private hoverLeave(): void {
    this.hovered = null;
    this.tooltip.hide();
  }

  /** Result → sound + shake. `okSfx` is what plays on success. */
  private result(r: 'ok' | 'noop' | 'fail', okSfx: 'ui_drop' | 'ui_equip' | 'ui_pickup' | 'ui_rotate', from: ItemLocation, uid: string): void {
    if (r === 'ok') this.sys.sfx(okSfx);
    else if (r === 'fail') { this.sys.sfx('ui_error'); this.shake(from, uid); }
  }

  private shake(loc: ItemLocation, uid: string): void {
    if (loc.kind === 'grid') {
      (loc.grid === 'bag' ? this.bagView : this.containerView).shake(uid);
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
   * Scheme: plain right-click on a weapon, a bag or a stack with qty ≥ 2 opens the menu; on anything else it
   * performs the quick action directly (container ↔ bag / slot → bag). Shift+right-click always opens the menu.
   */
  private onContextMenu(uid: string, from: ItemLocation, e: MouseEvent): void {
    if (this.drag?.started || this.dialog.isOpen) return;
    this.menu.close();
    const item = this.sys.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return;
    const isStack = def.stackMax > 1 && item.qty >= 2;
    const quickable = isQuickUsable(def) && from.kind === 'grid' && from.grid === 'bag';
    const hasMenu = isStack || isWeaponDef(def) || isBagDef(def) || isArmorDef(def) || quickable;
    if (!hasMenu && !e.shiftKey) {
      this.result(this.sys.quickMove(uid, from), 'ui_drop', from, uid);
      return;
    }
    this.tooltip.hide();
    this.menu.open(e.clientX, e.clientY, this.menuEntries(uid, from, item, def));
  }

  /**
   * Weapons: quick action (장착 / 주무기 II로 장착 / 가방으로 이동 / 상자로 이동) · 장전된 탄약 모두 탈착 (ammo loaded) ·
   * 무기 소켓 모두 탈착 (any socket filled) · 탄약 요청 · 버리기. Bags: 장착 / 가방으로 이동 · 요청 · 버리기.
   * Attachments are socketed by drag only (no 장착 entry). Stacks add the split entries.
   */
  private menuEntries(uid: string, from: ItemLocation, item: ItemInstance, def: ItemDef): MenuEntry[] {
    const entries: MenuEntry[] = [];
    const isWeapon = isWeaponDef(def);
    const isStack = def.stackMax > 1 && item.qty >= 2;
    const hasContainer = !!this.sys.getActiveContainer();
    const quick = () => this.result(this.sys.quickMove(uid, from), 'ui_drop', from, uid);

    // 1. quick action (what a plain right-click / double-click does)
    if (from.kind === 'slot') {
      entries.push({ label: TEXT.menu.toBag, run: quick });
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
      else if (hasContainer && !isBagDef(def)) entries.push({ label: TEXT.menu.toContainer, run: quick });
    }

    // 1b. weapon maintenance (player-owned weapons only)
    if (isWeapon && (from.kind === 'slot' || from.grid === 'bag')) {
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

    // 4. drop
    entries.push({ label: TEXT.menu.drop, hint: 'X', danger: true, separator: true, run: () => this.dropToWorld(uid, from, undefined) });
    if (isStack) entries.push({ label: TEXT.menu.dropOne, hint: 'Shift+X', danger: true, run: () => this.dropToWorld(uid, from, 1) });
    return entries;
  }

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

  /** X drops the dragged or hovered item; Shift+X one unit, Ctrl+X half the stack. */
  onDropKey(shift: boolean, ctrl: boolean): void {
    if (this.dialog.isOpen) return;
    this.menu.close();
    const d = this.drag;
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
      this.sys.requestItem(uid, from);
      return;
    }
    if (e.button !== 0) return;
    const item = this.sys.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return;
    e.preventDefault();
    this.menu.close();
    // Shift → half the stack, Ctrl → one unit (grid stacks only; falls back to a whole-item drag)
    let qty: number | null = null;
    if (from.kind === 'grid' && quickFrom === null) {
      if (e.shiftKey) qty = this.sys.partialQtyFor(item, 'half');
      else if (e.ctrlKey) qty = this.sys.partialQtyFor(item, 'one');
    }
    const r = tileEl.getBoundingClientRect();
    this.drag = {
      uid, item, def, from, quickFrom, qty,
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
    // a stim / grenade from the bag (or a wheel cell): light the usable cells as targets
    if (isQuickUsable(d.def) && d.from.kind === 'grid' && d.from.grid === 'bag' && d.qty === null) this.root?.classList.add('is-quick-drag');
    if (d.quickFrom !== null) {
      this.quickCells[d.quickFrom]?.tile?.classList.add('is-dragging');
      this.root?.classList.add('is-quick-source');
    } else if (d.from.kind === 'grid') {
      const view = d.from.grid === 'bag' ? this.bagView : this.containerView;
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
    for (const sv of this.slots.values()) sv.el.classList.remove('is-target-ok', 'is-target-bad');
    d.target = null;
    this.dropZone.classList.remove('is-hot');
    this.clearSocketTarget();
    for (const c of this.quickCells) c.el.classList.remove('is-target-ok', 'is-target-bad', 'is-target-swap');

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
    const views: GridView[] = this.container ? [this.containerView, this.bagView] : [this.bagView];
    for (const view of views) {
      const cell = view.cellForGhost(left, top, w, h, px, py);
      if (!cell) continue;
      d.target = { kind: 'grid', grid: view.id, x: cell.x, y: cell.y, rotated: d.rotated };
      const pv = this.preview(d, d.target);
      const state: HighlightState = pv === 'bad' ? 'bad' : pv === 'swap' ? 'swap' : pv === 'merge' ? 'merge' : 'ok';
      view.showHighlight(cell.x, cell.y, w, h, state);
      return;
    }

    // outside every grid/slot: over the backdrop → world drop (the zone lights up when hovered directly)
    if (!this.isOverPanel(px, py)) {
      const r = this.dropZone.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) this.dropZone.classList.add('is-hot');
    }
  }

  private preview(d: DragState, target: DropTarget) {
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
    return null;
  }

  private setSocketTarget(w: { uid: string; loc: ItemLocation }, state: 'ok' | 'bad'): void {
    this.socketTarget = w;
    if (w.loc.kind === 'grid') {
      (w.loc.grid === 'bag' ? this.bagView : this.containerView).setSocketTarget(w.uid, state);
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
    for (const sv of this.slots.values()) sv.tile?.classList.remove('is-socket-ok', 'is-socket-bad');
  }

  /** True when the point lies on a panel / equipment column (a miss there snaps back instead of dropping). */
  private isOverPanel(x: number, y: number): boolean {
    const el = document.elementFromPoint(x, y);
    return !!el && !!(el as Element).closest('.inv-panel, .inv-equip, .inv-menu, .inv-dialog');
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
      // released over the backdrop / drop zone: throw it into the world
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
    this.root?.classList.remove('is-dragging', 'is-quick-drag', 'is-quick-source');
    this.dropZone.classList.remove('is-hot');
    for (const c of this.quickCells) {
      c.el.classList.remove('is-target-ok', 'is-target-bad', 'is-target-swap');
      c.tile?.classList.remove('is-dragging');
    }
    this.bagView.setDragging(null);
    this.containerView.setDragging(null);
    if (d.qty !== null && d.from.kind === 'grid') {
      (d.from.grid === 'bag' ? this.bagView : this.containerView).markSplitSource(d.uid, null);
    }
    this.bagView.hideHighlight();
    this.containerView.hideHighlight();
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
