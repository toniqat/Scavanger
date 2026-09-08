/**
 * src/inventory/ui/parts/QuickPanel.ts — **빠른 사용 나침반 로제트**.
 *
 * 가방이 정한 개수만큼 8방향 칸을 열어 주고(잠긴 칸은 회색), 각 칸에 가방 아이템의 uid 를 물린다.
 * 드래그로 채우고 우클릭으로 비운다.
 */
import type { EmbeddedView, GameContext, ItemDef, ItemInstance } from '@/shared';
import { Keys, QUICK_SLOTS, QUICK_SLOT_LABEL_KO, isQuickSlotActive, keyLabel, renderItemCost } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { Container } from '../../Container';
import { LOADOUT_SLOTS, isArmorDef, isAttachmentDef, isBagDef, isWeaponDef, type DropTarget, type GridId, type InventorySystem, type ItemLocation, type SlotId } from '../../InventorySystem';
import { CraftPanel } from '../CraftPanel';
import { CatalogView } from '../CatalogView';
import { DisassemblePanel } from '../DisassemblePanel';
import { filledSocketCount } from '../../Sockets';
import { isQuickUsable } from '../../QuickSlots';
import { GridView, buildTileContent, type HighlightState } from '../GridView';
import { Tooltip } from '../Tooltip';
import { ContextMenu, type MenuEntry } from '../ContextMenu';
import { SplitDialog } from '../SplitDialog';
import { QUICK_DIR_GLYPH, QUICK_ROSE_ORDER, SLOT_LABEL, STEP, TEXT, fmtValue, slotKeyLabel, tierTitle, tileSize, fmtKg, weightLabel } from '../labels';
import { BAG_LOC, CATALOG_DBL_MS, DRAG_THRESHOLD, type DragState, GHOST_SCALE, LOCK_SVG, MIDDLE_BUTTON, type QuickCell, SCREEN_TABS, type ScreenTab, type SlotView } from '../model';
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
      sys.onQuickContextMenu(index, e);
    });
    rose.appendChild(el);
    sys.quickCells[index] = { index, el, tile: null, uid: null }; // indexed by wheel slot, not DOM order
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
  sys.quickHold = document.createElement('div');
  sys.quickHold.className = 'inv-quick-hint';
  sys.quickHold.textContent = TEXT.quick.holdHint(keyLabel(Keys.QUICK));
  legend.append(eyebrow, title, hint, sys.quickHold);
  section.append(rose, legend);
  return section;
  }

export function refreshQuick(sys: InventoryUI): void {
  const slots = sys.sys.getQuickSlots();
  const active = sys.sys.getQuickSlotCount();
  sys.quickCount.textContent = `${active}/${QUICK_SLOTS}`;
  const badges = new Map<string, string>();
  for (const cell of sys.quickCells) {
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
  el.addEventListener('pointerdown', (e) => { if (cell.uid) sys.beginPress(cell.uid, BAG_LOC, e, el, cell.index); });
  el.addEventListener('pointerenter', (e) => { if (cell.uid) sys.hoverEnter(cell.uid, BAG_LOC, e); });
  el.addEventListener('pointermove', (e) => sys.tooltip.move(e.clientX, e.clientY));
  el.addEventListener('pointerleave', () => sys.hoverLeave());
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (sys.drag?.started) return;
    sys.result(sys.sys.setQuickSlot(cell.index, null) ? 'ok' : 'fail', 'ui_drop', BAG_LOC, cell.uid ?? '');
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
