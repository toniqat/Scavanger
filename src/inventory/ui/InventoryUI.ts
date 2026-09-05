import './../inventory.css';
import type { GameContext, ItemDef, ItemInstance } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { Container } from '../Container';
import type { DropTarget, GridId, InventorySystem, ItemLocation, SlotId } from '../InventorySystem';
import { EQUIP_SLOTS } from '../InventorySystem';
import { durabilityRatio } from '../Gear';
import { GridView, buildTileContent, type HighlightState } from './GridView';
import { QuickBarView } from './QuickBarView';
import { CraftPanel } from './CraftPanel';
import { Tooltip } from './Tooltip';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { SplitDialog } from './SplitDialog';
import { STEP, TEXT, fmtKg, fmtValue, tierTitle, tileSize, weightLabel } from './labels';

const DRAG_THRESHOLD = 4; // px before a press becomes a drag
const MIDDLE_BUTTON = 1;

/** Body footprint (grid cells) reserved by each equipment slot — the largest item of that category. */
const SLOT_FOOTPRINT: Readonly<Record<SlotId, { w: number; h: number }>> = {
  primary: { w: 5, h: 2 },
  secondary: { w: 2, h: 1 },
  armor: { w: 2, h: 3 },
  backpack: { w: 3, h: 3 },
};

const SLOT_LABEL: Readonly<Record<SlotId, string>> = {
  primary: TEXT.primary, secondary: TEXT.secondary, armor: TEXT.armor, backpack: TEXT.backpack,
};

const SLOT_KEY: Readonly<Record<SlotId, string>> = {
  primary: '1', secondary: '2', armor: '', backpack: '',
};

interface DragState {
  uid: string;
  item: ItemInstance;
  def: ItemDef;
  from: ItemLocation;
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
  meta: HTMLElement;
  tile: HTMLElement | null;
  uid: string | null;
}

/**
 * Arc Raiders-styled DOM for the Diablo grid: craft panel / container panel (left), bag + quick-use bar
 * (center), the four equipment slots (right), weight bar, hint bar. Owns drag & drop, rotation, tooltips.
 */
export class InventoryUI {
  private root: HTMLElement | null = null;
  private layout!: HTMLElement;
  private containerPanel!: HTMLElement;
  private containerTitle!: HTMLElement;
  private containerTier!: HTMLElement;
  private bagCapacity!: HTMLElement;
  private valueEl!: HTMLElement;
  private weightValueEl!: HTMLElement;
  private weightStateEl!: HTMLElement;
  private weightFillEl!: HTMLElement;
  private containerView!: GridView;
  private bagView!: GridView;
  private quickBar!: QuickBarView;
  private craftPanel!: CraftPanel;
  private slots = new Map<SlotId, SlotView>();
  private tooltip!: Tooltip;
  private ghostLayer!: HTMLElement;
  private dropZone!: HTMLElement;
  private menu!: ContextMenu;
  private dialog!: SplitDialog;
  private drag: DragState | null = null;
  private hovered: { uid: string; loc: ItemLocation } | null = null;
  private container: Container | null = null;
  private visible = false;
  private closeTimer: number | null = null;
  /** Set when the bag Grid instance was replaced (backpack swap) so the view re-binds it. */
  private gridChanged = false;

  private onWindowMove = (e: PointerEvent): void => this.handlePointerMove(e);
  private onWindowUp = (e: PointerEvent): void => this.handlePointerUp(e);

  constructor(private readonly sys: InventorySystem, private readonly ctx: GameContext) {}

  /* ── mount / visibility ────────────────────────────────────────────────── */

  mount(): void {
    if (this.root) return;
    const getDef = (id: string) => ITEM_DEF_MAP.get(id);
    const root = document.createElement('div');
    root.className = 'inv-root';
    root.hidden = true;
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root = root;

    const layout = document.createElement('div');
    layout.className = 'inv-layout';
    this.layout = layout;

    /* craft panel (left, toggled) */
    this.craftPanel = new CraftPanel(this.sys, getDef);

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
    this.containerView = new GridView('container', getDef, this.tileHandlers());
    this.containerView.setStateLookup((item, def) => ({
      hidden: this.sys.isHidden(item.uid),
      durability: durabilityRatio(item, def),
    }));
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
    const headActions = document.createElement('div');
    headActions.className = 'inv-head-actions';
    const craftBtn = document.createElement('button');
    craftBtn.type = 'button';
    craftBtn.className = 'inv-btn';
    craftBtn.textContent = TEXT.craft;
    craftBtn.addEventListener('click', () => this.toggleCraft());
    this.bagCapacity = document.createElement('div');
    this.bagCapacity.className = 'inv-capacity';
    headActions.append(craftBtn, this.bagCapacity);
    bHead.append(bTitleWrap, headActions);

    this.bagView = new GridView('bag', getDef, this.tileHandlers());
    this.bagView.setStateLookup((item, def) => ({ durability: durabilityRatio(item, def) }));

    this.quickBar = new QuickBarView({
      onClear: (i) => { if (this.sys.setQuickSlot(i, null)) this.sys.sfx('ui_drop'); },
      onUse: (i) => { this.sys.sfx(this.sys.useQuickSlot(i) ? 'ui_equip' : 'ui_error'); this.refresh(); },
    });

    const bFoot = document.createElement('footer');
    bFoot.className = 'inv-foot';
    const vLabel = document.createElement('span');
    vLabel.className = 'inv-eyebrow';
    vLabel.textContent = TEXT.value;
    this.valueEl = document.createElement('span');
    this.valueEl.className = 'inv-value';
    bFoot.append(vLabel, this.valueEl);

    bPanel.append(bHead, this.bagView.el, this.quickBar.el, this.buildWeightBar(), bFoot);

    /* equipment column */
    const eq = document.createElement('aside');
    eq.className = 'inv-equip';
    const eqEyebrow = document.createElement('div');
    eqEyebrow.className = 'inv-eyebrow';
    eqEyebrow.textContent = TEXT.equipment;
    eq.appendChild(eqEyebrow);
    for (const slot of EQUIP_SLOTS) eq.appendChild(this.buildSlot(slot).el);

    layout.append(this.craftPanel.el, cPanel, bPanel, eq);

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

    this.tooltip = new Tooltip(getWeaponDef, (id) => this.sys.getLoot().getArmorDef(id), (id) => this.sys.getLoot().getBackpackDef(id));
    this.ghostLayer = document.createElement('div');
    this.ghostLayer.className = 'inv-ghost-layer';

    root.append(layout, hints, dropZone, this.tooltip.el, this.ghostLayer);
    this.menu = new ContextMenu(root);
    this.dialog = new SplitDialog(root);
    this.ctx.uiRoot.appendChild(root);
  }

  private buildWeightBar(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'inv-weight';
    const label = document.createElement('span');
    label.className = 'inv-eyebrow';
    label.textContent = TEXT.weight;
    this.weightValueEl = document.createElement('span');
    this.weightValueEl.className = 'inv-weight-value';
    this.weightStateEl = document.createElement('span');
    this.weightStateEl.className = 'inv-weight-state';
    const track = document.createElement('div');
    track.className = 'inv-weight-track';
    this.weightFillEl = document.createElement('i');
    track.appendChild(this.weightFillEl);
    const row = document.createElement('div');
    row.className = 'inv-weight-row';
    row.append(label, this.weightValueEl, this.weightStateEl);
    wrap.append(row, track);
    return wrap;
  }

  /** The system replaced the bag Grid (backpack swap) — rebind on the next refresh. */
  markGridChanged(): void {
    this.gridChanged = true;
  }

  private toggleCraft(): void {
    const open = !this.craftPanel.isOpen;
    this.craftPanel.setOpen(open);
    this.ctx.bus.emit('ui:craftToggled', { open });
    this.sys.sfx('ui_drop');
  }

  /** Close the context menu / split dialog if open. Returns true when something was closed (Escape consumed). */
  closeOverlays(): boolean {
    const a = this.dialog?.close() ?? false;
    const b = this.menu?.close() ?? false;
    if (!a && !b && this.craftPanel?.isOpen) { this.toggleCraft(); return true; }
    return a || b;
  }

  show(container: Container | null): void {
    if (!this.root) return;
    if (this.closeTimer !== null) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    this.container = container;
    this.containerPanel.hidden = !container;
    if (container) {
      this.containerTitle.textContent = tierTitle(container.tier);
      this.containerTier.textContent = `SUPPLY CACHE · TIER ${container.tier}`;
      this.containerView.setGrid(container.grid);
    } else {
      this.containerView.setGrid(null);
    }
    this.bagView.setGrid(this.sys.getGrid('bag'));
    this.gridChanged = false;
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
    this.dialog?.close();
    this.menu?.close();
    this.craftPanel.setOpen(false);
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
    this.craftPanel?.dispose();
    this.quickBar?.dispose();
    this.containerView.dispose();
    this.bagView.dispose();
    this.tooltip.dispose();
    this.root?.remove();
    this.root = null;
  }

  /* ── refresh ───────────────────────────────────────────────────────────── */

  refresh(): void {
    if (!this.root || this.root.hidden) return;
    if (this.gridChanged) {
      this.gridChanged = false;
      this.bagView.setGrid(this.sys.getGrid('bag'));
    }
    const bag = this.sys.getGrid('bag');
    if (bag) {
      this.bagView.refresh();
      this.bagCapacity.textContent = `${bag.usedCells()} / ${bag.cols * bag.rows}`;
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
    this.refreshSearch();
    this.refreshSlots();
    this.refreshQuick();
    this.refreshWeight();
    this.refreshCraft();
  }

  /** Repaint just the quick-use strip (`quickbar:changed`). */
  refreshQuick(): void {
    if (!this.root || this.root.hidden) return;
    this.quickBar.render(this.sys.getQuickSlots(), (id) => ITEM_DEF_MAP.get(id));
  }

  /** Repaint just the craft panel (progress ticks while holding). */
  refreshCraft(): void {
    if (!this.root || this.root.hidden) return;
    this.craftPanel.refresh();
  }

  /** Crate search readout — the tiles themselves flip through the GridView state lookup. */
  refreshSearch(): void {
    if (!this.root || this.root.hidden) return;
    const c = this.sys.getActiveContainer();
    if (!c) return;
    if (c.hiddenCount > 0) {
      this.containerTier.textContent = `${TEXT.searching} ${c.hiddenCount}`;
      this.containerView.refresh();
    } else {
      this.containerTier.textContent = `SUPPLY CACHE · TIER ${c.tier}`;
    }
  }

  private refreshWeight(): void {
    const info = this.sys.getWeight();
    this.weightValueEl.textContent = `${fmtKg(info.weight)} / ${fmtKg(info.capacity)}`;
    this.weightStateEl.textContent = weightLabel(info.state);
    this.weightFillEl.style.width = `${Math.min(100, info.ratio * 100).toFixed(1)}%`;
    const wrap = this.weightFillEl.parentElement?.parentElement;
    if (wrap) {
      wrap.classList.toggle('is-light', info.state === 'light');
      wrap.classList.toggle('is-heavy', info.state === 'heavy');
      wrap.classList.toggle('is-over', info.state === 'over');
    }
  }

  private refreshSlots(): void {
    const loadout = this.sys.getLoadout();
    for (const sv of this.slots.values()) {
      const item = loadout[sv.slot] ?? null;
      const def = item ? ITEM_DEF_MAP.get(item.defId) : undefined;
      if (item && def) {
        if (!sv.tile) {
          sv.tile = document.createElement('div');
          this.bindSlotTile(sv.tile, sv);
          sv.body.innerHTML = '';
          sv.body.appendChild(sv.tile);
        }
        sv.uid = item.uid;
        const fp = item.rotated ? { w: def.height, h: def.width } : { w: def.width, h: def.height };
        buildTileContent(sv.tile, item, def, fp.w, fp.h, { durability: durabilityRatio(item, def) });
        sv.tile.dataset.uid = item.uid;
        sv.meta.textContent = this.slotMeta(def, item);
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

  private slotMeta(def: ItemDef, item: ItemInstance): string {
    const w = def.weaponId ? getWeaponDef(def.weaponId) : undefined;
    if (w) return `${w.name} · ${w.magSize}발 탄창`;
    if (def.armorId) {
      const a = this.sys.getLoot().getArmorDef(def.armorId);
      if (a) return `${TEXT.gear.damageReduction} ${(a.damageReduction * 100).toFixed(0)} %`;
    }
    if (def.backpackId) {
      const b = this.sys.getLoot().getBackpackDef(def.backpackId);
      if (b) return `${b.cols} × ${b.rows} · ${TEXT.gear.quickSlots} ${b.quickSlots}`;
    }
    const ratio = durabilityRatio(item, def);
    if (ratio !== null) return `${TEXT.durability} ${(ratio * 100).toFixed(0)} %`;
    return def.name;
  }

  private buildSlot(slot: SlotId): SlotView {
    const el = document.createElement('div');
    el.className = `inv-slot inv-slot-${slot}`;
    el.dataset.slot = slot;
    const head = document.createElement('div');
    head.className = 'inv-slot-label';
    head.textContent = SLOT_LABEL[slot];
    const key = SLOT_KEY[slot];
    if (key) {
      const k = document.createElement('kbd');
      k.textContent = key;
      head.appendChild(k);
    }
    const body = document.createElement('div');
    body.className = 'inv-slot-body';
    const fp = SLOT_FOOTPRINT[slot];
    const { width, height } = tileSize(fp.w, fp.h);
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
    const sv: SlotView = { slot, el, body, meta, tile: null, uid: null };
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
        if (gridId === 'container' && this.sys.isHidden(uid)) { this.sys.sfx('ui_error'); return; }
        const view = gridId === 'bag' ? this.bagView : this.containerView;
        const el = view.tileEl(uid);
        if (el) this.beginPress(uid, { kind: 'grid', grid: gridId }, e, el);
      },
      onEnter: (uid: string, gridId: GridId, e: PointerEvent) => this.hoverEnter(uid, { kind: 'grid', grid: gridId }, e),
      onMove: (_uid: string, _gridId: GridId, e: PointerEvent) => this.tooltip.move(e.clientX, e.clientY),
      onLeave: () => this.hoverLeave(),
      onContext: (uid: string, gridId: GridId, e: MouseEvent) => {
        if (this.drag) return;
        if (gridId === 'container' && this.sys.isHidden(uid)) { this.sys.sfx('ui_error'); return; }
        this.onContextMenu(uid, { kind: 'grid', grid: gridId }, e);
      },
      onDblClick: (uid: string, gridId: GridId) => {
        if (this.drag?.started) return;
        if (gridId === 'container' && this.sys.isHidden(uid)) return;
        const from: ItemLocation = { kind: 'grid', grid: gridId };
        const item = this.sys.findItem(uid, from);
        const def = item && ITEM_DEF_MAP.get(item.defId);
        const isGear = !!def && EQUIP_SLOTS.includes(def.category as SlotId);
        this.result(this.sys.activate(uid, from), isGear ? 'ui_equip' : 'ui_drop', from, uid);
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
   * Scheme: plain right-click on a stack with qty ≥ 2 opens the menu; on anything else it performs the quick
   * action directly (container ↔ bag / slot → bag). Shift+right-click always opens the menu.
   */
  private onContextMenu(uid: string, from: ItemLocation, e: MouseEvent): void {
    if (this.drag?.started || this.dialog.isOpen) return;
    this.menu.close();
    const item = this.sys.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return;
    const isStack = def.stackMax > 1 && item.qty >= 2;
    const hasExtras = def.quickUsable === true || (def.durabilityMax !== undefined && !this.ctx.isRaidActive());
    if (!isStack && !hasExtras && !e.shiftKey) {
      this.result(this.sys.quickMove(uid, from), 'ui_drop', from, uid);
      return;
    }
    this.tooltip.hide();
    this.menu.open(e.clientX, e.clientY, this.menuEntries(uid, from, item, def));
  }

  private menuEntries(uid: string, from: ItemLocation, item: ItemInstance, def: ItemDef): MenuEntry[] {
    const entries: MenuEntry[] = [];
    const isGear = EQUIP_SLOTS.includes(def.category as SlotId);
    const isWeapon = def.category === 'primary' || def.category === 'secondary';
    const isStack = def.stackMax > 1 && item.qty >= 2;
    const hasContainer = !!this.sys.getActiveContainer();

    // 1. quick action (what a plain right-click / double-click does)
    if (from.kind === 'slot') {
      entries.push({ label: TEXT.menu.toBag, run: () => this.result(this.sys.quickMove(uid, from), 'ui_drop', from, uid) });
    } else {
      if (isGear) entries.push({ label: TEXT.menu.equip, run: () => this.result(this.sys.activate(uid, from), 'ui_equip', from, uid) });
      if (from.grid === 'container') entries.push({ label: TEXT.menu.toBag, run: () => this.result(this.sys.quickMove(uid, from), 'ui_drop', from, uid) });
      else if (hasContainer) entries.push({ label: TEXT.menu.toContainer, run: () => this.result(this.sys.quickMove(uid, from), 'ui_drop', from, uid) });
    }

    // 2. quick-use bar assignment (bag items only)
    if (def.quickUsable === true && from.kind === 'grid' && from.grid === 'bag') {
      const slots = this.sys.getQuickSlots();
      const assigned = slots.findIndex((s) => s.item?.uid === uid);
      if (assigned >= 0) {
        entries.push({ label: TEXT.menu.quickClear, separator: entries.length > 0, run: () => { this.sys.setQuickSlot(assigned, null); this.sys.sfx('ui_drop'); } });
      } else if (slots.length > 0) {
        entries.push({
          label: TEXT.menu.quickAssign, separator: entries.length > 0,
          run: () => {
            const free = slots.findIndex((s) => !s.item);
            const idx = free >= 0 ? free : 0;
            this.sys.sfx(this.sys.setQuickSlot(idx, item) ? 'ui_equip' : 'ui_error');
          },
        });
      }
    }

    // 3. repair (ship only)
    if (def.durabilityMax !== undefined && !this.ctx.isRaidActive()) {
      entries.push({ label: TEXT.menu.repair, separator: entries.length > 0, run: () => { this.sys.sfx(this.sys.repair(uid) ? 'ui_equip' : 'ui_error'); } });
    }

    // 4. split
    if (isStack && from.kind === 'grid') {
      const half = Math.max(1, Math.floor(item.qty / 2));
      entries.push({ label: TEXT.menu.splitHalf, hint: 'Shift', separator: entries.length > 0, run: () => this.split(uid, from, half) });
      if (item.qty > 2) entries.push({ label: TEXT.menu.splitOne, hint: 'Ctrl', run: () => this.split(uid, from, 1) });
      entries.push({ label: TEXT.menu.splitCustom, run: () => this.openSplitDialog(uid, from) });
    }

    // 5. quick chat request
    entries.push({
      label: isWeapon ? TEXT.menu.requestAmmo : TEXT.menu.request,
      hint: '휠클릭',
      separator: entries.length > 0,
      run: () => { this.sys.requestItem(uid, from); },
    });

    // 6. drop
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

  private beginPress(uid: string, from: ItemLocation, e: PointerEvent, tileEl: HTMLElement): void {
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
    if (from.kind === 'grid') {
      if (e.shiftKey) qty = this.sys.partialQtyFor(item, 'half');
      else if (e.ctrlKey) qty = this.sys.partialQtyFor(item, 'one');
    }
    const r = tileEl.getBoundingClientRect();
    this.drag = {
      uid, item, def, from, qty,
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
    if (d.from.kind === 'grid') {
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
    buildTileContent(d.ghost, ghostItem, d.def, w, h, { durability: durabilityRatio(d.item, d.def) });
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
    this.quickBar.clearTargets();
    for (const sv of this.slots.values()) sv.el.classList.remove('is-target-ok', 'is-target-bad');
    d.target = null;
    this.dropZone.classList.remove('is-hot');

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

    // quick-use bar
    const qi = this.quickBar.indexAt(px, py);
    if (qi !== null) {
      d.target = { kind: 'quick', index: qi };
      const pv = this.preview(d, d.target);
      if (pv === 'bad') { this.quickBar.setTarget(qi, true); d.target = null; }
      else this.quickBar.setTarget(qi, false);
      return;
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

  /** True when the point lies on a panel / equipment column (a miss there snaps back instead of dropping). */
  private isOverPanel(x: number, y: number): boolean {
    const el = document.elementFromPoint(x, y);
    return !!el && !!(el as Element).closest('.inv-panel, .inv-equip, .inv-menu, .inv-dialog, .inv-quickbar');
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
    this.root?.classList.remove('is-dragging');
    this.dropZone.classList.remove('is-hot');
    this.bagView.setDragging(null);
    this.containerView.setDragging(null);
    this.quickBar.clearTargets();
    if (d.qty !== null && d.from.kind === 'grid') {
      (d.from.grid === 'bag' ? this.bagView : this.containerView).markSplitSource(d.uid, null);
    }
    this.bagView.hideHighlight();
    this.containerView.hideHighlight();
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
