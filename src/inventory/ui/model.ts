/**
 * src/inventory/ui/model.ts — 인벤토리 창의 공용 어휘.
 *
 * `InventoryUI` 에서 떼어낸 상수 · 타입만 있다. 클래스를 참조하지 않으므로 `parts/*` 모듈이
 * 클래스를 되돌아 import 하지 않고 쓸 수 있다(순환 import 방지).
 * `InventoryUI.ts` 가 그대로 재수출하므로 기존 import 경로는 전부 유지된다.
 */
import './../inventory.css';
import type { EmbeddedView, GameContext, ItemDef, ItemInstance } from '@/shared';
import { Keys, QUICK_SLOTS, QUICK_SLOT_LABEL_KO, isQuickSlotActive, keyLabel, renderItemCost } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { Container } from '../Container';
import { LOADOUT_SLOTS, isArmorDef, isAttachmentDef, isBagDef, isWeaponDef, type DropTarget, type GridId, type InventorySystem, type ItemLocation, type SlotId } from '../InventorySystem';
import { CraftPanel } from './CraftPanel';
import { CatalogView } from './CatalogView';
import { DisassemblePanel } from './DisassemblePanel';
import { filledSocketCount } from '../Sockets';
import { isQuickUsable } from '../QuickSlots';
import { GridView, buildTileContent, type HighlightState } from './GridView';
import { Tooltip } from './Tooltip';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { SplitDialog } from './SplitDialog';
import { QUICK_DIR_GLYPH, QUICK_ROSE_ORDER, SLOT_LABEL, STEP, TEXT, fmtValue, slotKeyLabel, tierTitle, tileSize, fmtKg, weightLabel } from './labels';

export const DRAG_THRESHOLD = 4; // px before a press becomes a drag
/** The dragged ghost's size lift. Lives here, not in CSS — see `positionGhost`. */
export const GHOST_SCALE = 1.04;
export const MIDDLE_BUTTON = 1;
/** Two presses on the same catalog tile within this window = 가방에 넣기. */
export const CATALOG_DBL_MS = 400;
export const BAG_LOC: ItemLocation = { kind: 'grid', grid: 'bag' };
export const LOCK_SVG = '<svg viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="6" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 6V4a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

/**
 * Screen tabs above the window (Arc Raiders style), hub mode only.
 *
 * **Phase 8**: the tabs no longer close the window and open a separate full-screen popup. Selecting one swaps the
 * `.inv-layout` content for a `.inv-screen` host and builds the owning folder's **embedded view** into it —
 * `ctx.progression.createSheetView` / `ctx.meta.createCorpView` / `ctx.housing.createShipView`, each an
 * `EmbeddedView` we `refresh()` on show and `dispose()` on leave. The window keeps its single `inventory` blocker
 * and its blurred `.inv-root` backdrop is the 배경 블러 the design asks for.
 */
export type ScreenTab = 'inventory' | 'character' | 'corp' | 'ship';
export const SCREEN_TABS: readonly { id: ScreenTab; label: string; title?: string }[] = [
  { id: 'inventory', label: TEXT.tabs.inventory },
  { id: 'character', label: TEXT.tabs.character, title: TEXT.tabs.characterHint },
  { id: 'corp', label: TEXT.tabs.corp, title: TEXT.tabs.corpHint },
  { id: 'ship', label: TEXT.tabs.ship, title: TEXT.tabs.shipHint },
];

export interface DragState {
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

export interface SlotView {
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
export interface QuickCell {
  index: number;
  el: HTMLElement;
  tile: HTMLElement | null;
  uid: string | null;
}

/**
 * Arc Raiders-styled DOM for the Diablo grid.
 *   - Mission (Tab / crate): container panel (left), bag (center, quick-use rose underneath), equipment column (right).
 *   - Ship (`hub` = true, 2026-09-06): screen tabs (인벤토리 / 캐릭터 / 기업) on top, then **함선 창고** (scrollable stash
 *     grid, left) · **장착 장비** (5 slots; the 전술 임플란트 moved to the 캐릭터 tab in the Phase 9 UI pass) · **가방** with the
 *     quick-use rose to its right (≥ 1600 px wide; under the grid on narrower windows). Right-click on worn gear
 *     offers 수리 there; a "drop" (X / backdrop release) lands in the stash because the ship has no ground.
 * Owns drag & drop, rotation, tooltips, context menus.
 */
