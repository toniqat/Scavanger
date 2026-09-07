import type { CrewLoadoutViewOptions, EmbeddedView, ItemDef, ItemInstance, LoadoutSlot } from '@/shared';
import {
  BAG_DEFAULT_COLS, BAG_DEFAULT_QUICK_SLOTS, BAG_DEFAULT_ROWS, NET_SLOT_COLORS_CSS, QUICK_SLOTS,
  QUICK_SLOT_LABEL_KO, isQuickSlotActive,
} from '@/shared';
import type { InventorySystem } from '../InventorySystem';
import { LOADOUT_SLOTS } from '../InventorySystem';
import { sanitizeLoadoutSave, type LoadoutSave } from '../Loadout';
import { reviveItem, savedCell } from '../Serialize';
import { Grid } from '../Grid';
import { GridView, buildTileContent } from './GridView';
import { QUICK_DIR_GLYPH, QUICK_ROSE_ORDER, SLOT_LABEL, TEXT, tileSize } from './labels';

/** Blocks a crew view can draw, left to right. There is deliberately **no** 함선 창고 and no 크레딧. */
export type CrewBlock = 'equip' | 'bag' | 'quick';
const DEFAULT_BLOCKS: readonly CrewBlock[] = ['equip', 'bag', 'quick'];

/**
 * **분대원 장비 열람** (Phase 10) — a read-only 장비 / 가방 / 빠른 사용 view of *another* member's loadout document
 * (`InventoryRef.captureCrewLoadout()`, delivered over `crew loadout`). The 발사 준비 패널 in `hub/` puts it inside its
 * own modeless frame; this class only owns the content.
 *
 * It is a genuine snapshot: the document is sanitised with `sanitizeLoadoutSave`, fresh instances are minted with
 * `Serialize.reviveItem` (unknown def ids are skipped with a warning) and placed on a **throwaway `Grid`** that no
 * other code can reach. The tiles are the real `GridView` / `buildTileContent`, but every `TileHandlers` entry is a
 * no-op: no drag, no rotation, no socketing, no context menu, no drop. Nothing here mutates the local inventory.
 *
 * Like every `EmbeddedView` (`ui/TradeGrids.ts` is the precedent): no `ctx.uiBlockers` token, no pointer-lock call and
 * no window Escape listener — the caller's frame owns all three. `dispose()` removes exactly what it added.
 */
export class CrewLoadoutView implements EmbeddedView {
  private readonly root: HTMLElement;
  private readonly blocks: readonly CrewBlock[];
  /** The snapshot's own grid — never registered anywhere, so `GridId 'bag'` here means "this member's bag". */
  private readonly bag: Grid;
  private bagView: GridView | null = null;
  /** Revived instances in `save.bag` order (null = def unknown / no room), for the quick-slot indices. */
  private readonly revived: (ItemInstance | null)[] = [];
  private readonly slots: Partial<Record<LoadoutSlot, ItemInstance>> = {};
  private readonly quickUids: (string | null)[] = new Array<string | null>(QUICK_SLOTS).fill(null);
  private quickActive = BAG_DEFAULT_QUICK_SLOTS;
  private disposed = false;

  /** Null when `loadout` is not a loadout document (the caller falls back to a name-only card). */
  static create(inv: InventorySystem, host: HTMLElement, loadout: unknown, opts: CrewLoadoutViewOptions = {}): CrewLoadoutView | null {
    const save = sanitizeLoadoutSave(loadout);
    if (!save) return null;
    return new CrewLoadoutView(inv, host, save, opts);
  }

  private constructor(
    private readonly inv: InventorySystem,
    host: HTMLElement,
    save: LoadoutSave,
    opts: CrewLoadoutViewOptions,
  ) {
    this.blocks = (opts.blocks && opts.blocks.length > 0 ? opts.blocks : DEFAULT_BLOCKS) as readonly CrewBlock[];
    const getDef = (id: string): ItemDef | undefined => this.inv.getDef(id);
    this.bag = new Grid(BAG_DEFAULT_COLS, BAG_DEFAULT_ROWS, getDef);
    this.build(save);

    this.root = document.createElement('div');
    this.root.className = `crew-loadout${opts.className ? ` ${opts.className}` : ''}`;
    const accent = NET_SLOT_COLORS_CSS[opts.slot ?? -1];
    if (accent) this.root.style.setProperty('--crew-slot', accent);
    if (opts.name) {
      const head = document.createElement('div');
      head.className = 'crew-head';
      const dot = document.createElement('i');
      dot.className = 'crew-dot';
      const name = document.createElement('span');
      name.className = 'crew-name';
      name.textContent = opts.name;
      head.append(dot, name);
      this.root.appendChild(head);
    }
    const row = document.createElement('div');
    row.className = 'crew-blocks';
    for (const block of this.blocks) {
      if (block === 'equip') row.appendChild(this.buildEquip());
      else if (block === 'bag') row.appendChild(this.buildBag(getDef));
      else row.appendChild(this.buildQuick());
    }
    this.root.appendChild(row);
    host.appendChild(this.root);
  }

  /** Mint the snapshot's items: slots (category-checked), bag placements, then the wheel indices. */
  private build(save: LoadoutSave): void {
    const getDef = (id: string): ItemDef | undefined => this.inv.getDef(id);
    const loot = this.inv.getLoot();
    for (const slot of LOADOUT_SLOTS) {
      const item = reviveItem(save.slots[slot], getDef, loot, 'CrewLoadout');
      if (item) this.slots[slot] = item;
    }
    const bagDef = this.slots.bag ? getDef(this.slots.bag.defId) : undefined;
    const size = bagDef?.bag ?? { cols: BAG_DEFAULT_COLS, rows: BAG_DEFAULT_ROWS, quickSlots: BAG_DEFAULT_QUICK_SLOTS };
    this.bag.resize(size.cols, size.rows);
    this.quickActive = Math.max(0, Math.min(QUICK_SLOTS, Math.floor(size.quickSlots)));
    const pending: ItemInstance[] = [];
    for (const sv of save.bag) {
      const item = reviveItem(sv, getDef, loot, 'CrewLoadout');
      this.revived.push(item);
      if (!item) continue;
      const cell = savedCell(sv);
      if (cell && this.bag.place(item, cell.x, cell.y, !!sv.rotated)) continue;
      pending.push(item);
    }
    for (const item of pending) {
      if (!this.bag.autoPlace(item)) this.revived[this.revived.indexOf(item)] = null;
    }
    save.quick.forEach((idx, i) => {
      const item = idx === null ? null : this.revived[idx];
      if (item && this.bag.has(item.uid)) this.quickUids[i] = item.uid;
    });
  }

  /* ── blocks ───────────────────────────────────────────────────────────── */

  private buildEquip(): HTMLElement {
    const eq = document.createElement('aside');
    eq.className = 'inv-equip crew-block';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'inv-eyebrow';
    eyebrow.textContent = TEXT.equipment;
    const grid = document.createElement('div');
    grid.className = 'inv-equip-grid';
    for (const slot of LOADOUT_SLOTS) grid.appendChild(this.buildSlot(slot));
    eq.append(eyebrow, grid);
    return eq;
  }

  private buildSlot(slot: LoadoutSlot): HTMLElement {
    const el = document.createElement('div');
    el.className = `inv-slot inv-slot-${slot} is-readonly`;
    const head = document.createElement('div');
    head.className = 'inv-slot-label';
    head.textContent = SLOT_LABEL[slot];
    const body = document.createElement('div');
    body.className = 'inv-slot-body';
    const { width, height } = slot === 'bag' ? tileSize(2, 2) : slot === 'armor' ? tileSize(2, 3) : tileSize(4, 2);
    body.style.width = `${width}px`;
    body.style.height = `${height}px`;
    const meta = document.createElement('div');
    meta.className = 'inv-slot-meta';
    const item = this.slots[slot];
    const def = item ? this.inv.getDef(item.defId) : undefined;
    if (item && def) {
      const tile = document.createElement('div');
      const stats = this.inv.getStats(item);
      buildTileContent(tile, item, def, def.width, def.height, stats);
      const size = tileSize(def.width, def.height);
      const scale = Math.min(1, width / size.width, height / size.height);
      if (scale < 1) tile.style.transform = `scale(${scale.toFixed(3)})`;
      tile.dataset.uid = item.uid;
      tile.dataset.itemTip = '';
      tile.dataset.defId = item.defId;
      body.appendChild(tile);
      meta.textContent = def.name;
      el.classList.add('has-item');
      el.style.setProperty('--rc', def.color);
    } else {
      const empty = document.createElement('div');
      empty.className = 'inv-slot-empty';
      const label = document.createElement('span');
      label.textContent = TEXT.emptySlot;
      empty.appendChild(label);
      body.appendChild(empty);
    }
    el.append(head, body, meta);
    return el;
  }

  private buildBag(getDef: (id: string) => ItemDef | undefined): HTMLElement {
    const block = document.createElement('div');
    block.className = 'crew-block crew-bag';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'inv-eyebrow';
    eyebrow.textContent = TEXT.bag;
    // every handler is a no-op: this is somebody else's bag
    this.bagView = new GridView('bag', getDef, (item) => this.inv.getStats(item), {
      onPointerDown: () => { /* read-only */ },
      onEnter: () => { /* the caller's frame owns tooltips (`data-item-tip`) */ },
      onMove: () => { /* read-only */ },
      onLeave: () => { /* read-only */ },
      onContext: () => { /* read-only */ },
      onDblClick: () => { /* read-only */ },
    });
    this.bagView.setGrid(this.bag);
    block.append(eyebrow, this.bagView.el);
    return block;
  }

  private buildQuick(): HTMLElement {
    const block = document.createElement('div');
    block.className = 'crew-block crew-quick';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'inv-eyebrow';
    eyebrow.textContent = TEXT.quick.eyebrow;
    const rose = document.createElement('div');
    rose.className = 'inv-quick-rose';
    for (const index of QUICK_ROSE_ORDER) {
      if (index < 0) {
        const centre = document.createElement('div');
        centre.className = 'inv-quick-centre';
        const count = document.createElement('span');
        count.className = 'inv-quick-count';
        count.textContent = `${this.quickActive}/${QUICK_SLOTS}`;
        centre.appendChild(count);
        rose.appendChild(centre);
        continue;
      }
      const cell = document.createElement('div');
      cell.className = 'inv-quick-cell';
      cell.dataset.index = String(index);
      const dir = document.createElement('div');
      dir.className = 'inv-quick-dir';
      dir.textContent = QUICK_DIR_GLYPH[index] ?? '';
      const body = document.createElement('div');
      body.className = 'inv-quick-body';
      cell.append(dir, body);
      const uid = this.quickUids[index];
      const item = uid ? this.bag.get(uid)?.item : undefined;
      const def = item ? this.inv.getDef(item.defId) : undefined;
      if (!isQuickSlotActive(index, this.quickActive)) cell.classList.add('is-locked');
      if (item && def) {
        const tile = document.createElement('div');
        buildTileContent(tile, item, def, 1, 1);
        tile.dataset.uid = item.uid;
        tile.dataset.itemTip = '';
        tile.dataset.defId = item.defId;
        body.appendChild(tile);
        cell.classList.add('has-item');
        cell.style.setProperty('--rc', def.color);
        cell.title = `${QUICK_SLOT_LABEL_KO[index]} · ${def.name}`;
      } else {
        cell.title = `${QUICK_SLOT_LABEL_KO[index]} · ${TEXT.quick.empty}`;
      }
      rose.appendChild(cell);
    }
    block.append(eyebrow, rose);
    return block;
  }

  /* ── EmbeddedView ─────────────────────────────────────────────────────── */

  /** The document is a snapshot, so a repaint only re-renders what is already there (the caller rebuilds for new data). */
  refresh(): void {
    if (this.disposed) return;
    this.bagView?.refresh(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bagView?.dispose();
    this.bagView = null;
    this.bag.clear();
    this.root.remove();
  }
}
