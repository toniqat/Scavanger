/**
 * src/inventory/ui/parts/SlotPanel.ts — **장비 칸** (주무기 I / II · 보조무기 · 가방 · 방탄복).
 *
 * 칸 다섯 개의 DOM 을 만들고 아이템 타일을 그린다. 무엇이 어느 칸에 들어갈 수 있는지는
 * `model.ts` 의 `slotAccepts` 가 정하고, 여기서는 그림과 포인터 바인딩만 맡는다.
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
import { GridView, buildSlotCardContent, buildTileContent, type HighlightState } from '../GridView';
import { Tooltip } from '../Tooltip';
import { ContextMenu, type MenuEntry } from '../ContextMenu';
import { SplitDialog } from '../SplitDialog';
import { QUICK_DIR_GLYPH, QUICK_ROSE_ORDER, SLOT_LABEL, STEP, TEXT, fmtValue, slotKeyLabel, tierTitle, tileSize, fmtKg, weightLabel } from '../labels';
import { BAG_LOC, CATALOG_DBL_MS, DRAG_THRESHOLD, type DragState, GHOST_SCALE, LOCK_SVG, MIDDLE_BUTTON, type QuickCell, SCREEN_TABS, type ScreenTab, type SlotView } from '../model';
import type { InventoryUI } from '../InventoryUI';

export function refreshSlots(sys: InventoryUI): void {
  const loadout = sys.sys.getLoadout();
  for (const sv of sys.slots.values()) {
    const item = loadout[sv.slot];
    const def = item ? ITEM_DEF_MAP.get(item.defId) : undefined;
    if (item && def) {
      if (!sv.tile) {
        sv.tile = document.createElement('div');
        sys.bindSlotTile(sv.tile, sv);
        sv.body.innerHTML = '';
        sv.body.appendChild(sv.tile);
      }
      sv.uid = item.uid;
      sv.el.classList.toggle('is-worn', buildSlotCardContent(sv.tile, item, def, sys.sys.getStats(item)));
      sv.tile.dataset.uid = item.uid;
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
      sv.el.classList.remove('has-item', 'is-worn');
      sv.el.style.removeProperty('--rc');
    }
  }
  }

export function buildSlot(sys: InventoryUI, slot: SlotId, label: string): SlotView {
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
  /*
   * 2026-09-08: **every** slot is the same box. It used to be the item's own footprint (weapon 4×2, 방탄복 2×3,
   * 가방 2×2) with the tile scaled to fit, which made a 5×1 저격소총 draw much smaller than a 4×2 돌격소총 — the
   * grid footprint is a bag-packing property and says nothing about the gun. The box is the equipped item's
   * card now; the footprint only shows up in the drag ghost, where it is what the player actually needs.
   */
  el.append(head, body);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sv = sys.slots.get(slot);
    if (sv?.uid) sys.onContextMenu(sv.uid, { kind: 'slot', slot }, e);
  });
  const sv: SlotView = { slot, el, body, key, tile: null, uid: null };
  sys.slots.set(slot, sv);
  return sv;
  }

export function bindSlotTile(sys: InventoryUI, el: HTMLElement, sv: SlotView): void {
  const loc = (): ItemLocation => ({ kind: 'slot', slot: sv.slot });
  el.addEventListener('pointerdown', (e) => { if (sv.uid) sys.beginPress(sv.uid, loc(), e, el); });
  el.addEventListener('pointerenter', (e) => { if (sv.uid) sys.hoverEnter(sv.uid, loc(), e); });
  el.addEventListener('pointermove', (e) => sys.tooltip.move(e.clientX, e.clientY));
  el.addEventListener('pointerleave', () => sys.hoverLeave());
  }
