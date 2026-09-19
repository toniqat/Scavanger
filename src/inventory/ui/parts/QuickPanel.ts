/**
 * src/inventory/ui/parts/QuickPanel.ts — **the quick-use compass rose**.
 *
 * Opens as many of the eight direction cells as the bag allows (a locked cell is grey) and draws **the stack that cell
 * holds** in each of them. They are filled by a drag and emptied by a double-click.
 *
 * **2026-09-09 — the wheel is its own container** (user's decision). A cell's item is not in the bag grid, so the
 * `ItemLocation` this panel hands over is **`{ kind: 'quick', index }`**, not `BAG_LOC` — that is what lets `findItem` ·
 * the tooltip · the right-click menu · a drag find that stack. The direction badges on bag tiles (`setQuickBadges`) now
 * have nothing to wear: a stack put on the wheel leaves the bag, so there is no tile to badge at all.
 */
import { Keys, QUICK_SLOTS, QUICK_SLOT_LABEL_KO, isQuickSlotActive, keyLabel } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import { type ItemLocation } from '../../InventorySystem';
import { buildTileContent } from '../GridView';
import { QUICK_DIR_GLYPH, QUICK_ROSE_ORDER, TEXT } from '../labels';
import { LOCK_SVG, type QuickCell } from '../model';
import type { InventoryUI } from '../InventoryUI';

/** 3×3 compass rose (N top, clockwise) + a legend column; cells the bag has not unlocked (`isQuickSlotActive`) are locked. */
export function buildQuickPanel(sys: InventoryUI): HTMLElement {
  const section = document.createElement('div');
  section.className = 'inv-quick';
  const rose = document.createElement('div');
  rose.className = 'inv-quick-rose';
  for (const index of QUICK_ROSE_ORDER) {
    if (index < 0) {
      const centre = document.createElement('div');
      centre.className = 'inv-quick-centre';
      sys.quickKey = document.createElement('kbd');
      sys.quickKey.textContent = keyLabel(Keys.QUICK);
      sys.quickCount = document.createElement('span');
      sys.quickCount.className = 'inv-quick-count';
      centre.append(sys.quickKey, sys.quickCount);
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
      if (sys.drag || performance.now() < sys.suppressClicksUntil) return;   // 2026-09-12: held-remainder clicks
      sys.onQuickContextMenu(index, e);
    });
    rose.appendChild(el);
    sys.quickCells[index] = { index, el, tile: null, uid: null }; // indexed by wheel slot, not DOM order
  }
  // 2026-09-08: the rose stands on its own — no `QUICK USE` / `빠른 사용` heading and no "끌어다 놓기" sentence.
  //   The compass glyphs, the centre key cap and the lock icons already say what it is, and the panel sits
  //   directly under the bag grid it is filled from.
  section.append(rose);
  return section;
}

export function refreshQuick(sys: InventoryUI): void {
  const slots = sys.sys.getQuickSlots();
  const active = sys.sys.getQuickSlotCount();
  sys.quickCount.textContent = `${active}/${QUICK_SLOTS}`;
  // 2026-09-09: a wheel stack is not in the bag grid — there is no bag tile to badge, so the map is always empty
  const badges = new Map<string, string>();
  for (const cell of sys.quickCells) {
    const item = slots[cell.index] ?? null;
    const def = item ? ITEM_DEF_MAP.get(item.defId) : undefined;
    const locked = !isQuickSlotActive(cell.index, active); // unlock order N, S, E, W, then diagonals
    cell.el.classList.toggle('is-locked', locked);
    cell.el.title = locked ? TEXT.quick.locked : `${QUICK_SLOT_LABEL_KO[cell.index]} · ${def?.name ?? TEXT.quick.empty}`;
    const body = cell.el.querySelector<HTMLElement>('.inv-quick-body')!;
    if (item && def) {
      if (!cell.tile) {
        cell.tile = document.createElement('div');
        sys.bindQuickTile(cell.tile, cell);
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
  sys.bagView.setQuickBadges(badges);
}

export function bindQuickTile(sys: InventoryUI, el: HTMLElement, cell: QuickCell): void {
  // 2026-09-09: the stack lives in the wheel slot, so every hand-off names that slot (never the bag grid)
  const loc = (): ItemLocation => ({ kind: 'quick', index: cell.index });
  el.addEventListener('pointerdown', (e) => { if (cell.uid) sys.beginPress(cell.uid, loc(), e, el, cell.index); });
  el.addEventListener('pointerenter', (e) => { if (cell.uid) sys.hoverEnter(cell.uid, loc(), e); });
  el.addEventListener('pointermove', (e) => sys.tooltip.move(e.clientX, e.clientY));
  el.addEventListener('pointerleave', () => sys.hoverLeave());
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (sys.drag?.started || performance.now() < sys.suppressClicksUntil) return;
    // back into the bag — refused when the bag is full, and the stack stays in its cell
    sys.result(sys.sys.setQuickSlot(cell.index, null) ? 'ok' : 'fail', 'ui_drop', loc(), cell.uid ?? '');
  });
}

/** Wheel cell under the pointer (null when not over the rose). */
export function quickCellAt(sys: InventoryUI, x: number, y: number): QuickCell | null {
  const el = document.elementFromPoint(x, y);
  const cellEl = el && (el as Element).closest<HTMLElement>('.inv-quick-cell');
  if (!cellEl) return null;
  const index = Number(cellEl.dataset.index);
  return sys.quickCells[index] ?? null;
}
