/**
 * src/inventory/ui/parts/Screens.ts — **Tab 창의 화면 탭**과 부속 열.
 *
 * 함선에서 Tab 은 인벤토리 / 캐릭터 / 기업 / 함선 네 화면을 한 창 안에서 전환한다
 * (각 화면은 그 폴더가 준 `EmbeddedView` 라서 이 파일은 붙였다 뗐다만 한다).
 * 제작 열과 무한 상자 카탈로그의 열고 닫기도 여기 있다.
 */
import type { EmbeddedView, GameContext, ItemDef, ItemInstance } from '@/shared';
import { Keys, QUICK_SLOTS, QUICK_SLOT_LABEL_KO, isQuickSlotActive, keyLabel, renderItemCost } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { Container } from '../../Container';
import { LOADOUT_SLOTS, isArmorDef, isAttachmentDef, isBagDef, isWeaponDef, type DropTarget, type GridId, type InventorySystem, type ItemLocation, type SlotId } from '../../InventorySystem';
import { BAG_FRAME_ROWS } from '../../model';
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

export function onTab(sys: InventoryUI, tab: ScreenTab): void {
  if (tab === sys.activeTab) return;
  sys.setTab(tab);
  sys.sys.sfx(sys.activeTab === tab ? 'ui_pickup' : 'ui_error');
  }

/**
 * Select a screen tab from outside (`InventorySystem.openScreen`, e.g. the ship's 기업 네트워크 console). Returns
 * true when that tab is what the window ends up showing — `setTab` falls back to 인벤토리 outside the hub or when
 * the owning folder has no view.
 */
export function showScreenTab(sys: InventoryUI, tab: ScreenTab): boolean {
  sys.setTab(tab);
  sys.markTab();
  return sys.activeTab === tab;
  }

/**
 * Swap the window content. `inventory` shows `.inv-layout`; every other tab hides it, shows the `.inv-screen`
 * host and builds that folder's `EmbeddedView` into it. The old view is always disposed first, so exactly one
 * view exists at a time and nothing survives a window close.
 */
export function setTab(sys: InventoryUI, tab: ScreenTab): void {
  if (!sys.root) return;
  if (tab !== 'inventory' && !sys.hub) tab = 'inventory'; // the embedded screens are ship-only
  // 2026-09-08: 튜토리얼 중에는 인벤토리 탭만 — 나머지는 잠긴 채로 그려지고 클릭도 되돌려진다
  if (tab !== 'inventory' && sys.ctx.tutorial?.blockReason('screenTab', tab)) tab = 'inventory';
  if (tab === sys.activeTab && (tab === 'inventory' || sys.screenView)) return;
  // leaving a screen: dispose its view, close the popups that belong to the grid
  sys.screenView?.dispose();
  sys.screenView = null;
  sys.screenHost.replaceChildren();
  sys.screenNote.hidden = true;
  if (tab !== 'inventory') { sys.closeCraft(); sys.disassemble?.close(); }

  if (tab === 'inventory') {
    sys.activeTab = 'inventory';
    sys.layout.hidden = false;
    sys.screenHost.hidden = true;
    sys.markTab();
    sys.emitGuide();               // 2026-09-09: the 키 가이드 line follows the tab
    return;
  }
  const view = sys.buildScreenView(tab);
  if (!view) {
    // the owning folder is unavailable (no ctx.progression / meta / housing): stay on the grid with a note
    sys.activeTab = 'inventory';
    sys.layout.hidden = false;
    sys.screenHost.hidden = true;
    sys.screenNote.hidden = false;
    sys.screenNote.textContent = TEXT.tabs.unavailable(SCREEN_TABS.find((t) => t.id === tab)?.label ?? '');
    sys.markTab();
    sys.emitGuide();
    sys.sys.sfx('ui_error');
    return;
  }
  sys.activeTab = tab;
  sys.screenView = view;
  sys.layout.hidden = true;
  sys.screenHost.hidden = false;
  view.refresh();
  sys.markTab();
  sys.emitGuide();
  }

/** `createSheetView` / `createCorpView` / `createShipView`; null when that system is not present. */
export function buildScreenView(sys: InventoryUI, tab: ScreenTab): EmbeddedView | null {
  try {
    if (tab === 'character') {
      const p = sys.ctx.progression;
      return p && typeof p.createSheetView === 'function' ? p.createSheetView(sys.screenHost) : null;
    }
    if (tab === 'corp') {
      const m = sys.ctx.meta;
      return m && typeof m.createCorpView === 'function' ? m.createCorpView(sys.screenHost) : null;
    }
    const h = sys.ctx.housing;
    return h && typeof h.createShipView === 'function' ? h.createShipView(sys.screenHost) : null;
  } catch (e) {
    console.warn('[inventory] embedded screen failed', tab, e);
    sys.screenHost.replaceChildren();
    return null;
  }
  }

export function markTab(sys: InventoryUI): void {
  // 2026-09-08: 캐릭터 tab wears a red dot while there are unspent 능력치 포인트 (level-ups are easy to miss)
  let statPoints = 0;
  try { statPoints = sys.ctx.progression?.statPoints ?? 0; } catch { statPoints = 0; }
  for (const [id, b] of sys.tabButtons) {
    b.classList.toggle('is-on', id === sys.activeTab);
    // 2026-09-08: 튜토리얼이 막는 탭은 **아예 감춘다** — 자물쇠 + "튜토리얼에서는 ~" 툴팁을 남겨 두는 것보다
    // 지금 쓸 수 있는 탭만 보이는 편이 낫다. 끝나거나 건너뛰면 `tutorial:changed` 로 다시 나타난다.
    const tutHidden = id !== 'inventory' && (sys.ctx.tutorial?.hides('screenTab', id) ?? false);
    b.title = SCREEN_TABS.find((t) => t.id === id)?.title ?? '';
    if (id === 'character') {
      const alert = statPoints > 0;
      b.classList.toggle('has-alert', alert);
      b.dataset.alert = alert ? String(statPoints) : '';
    }
    // 함선 needs the housing system; hide the tab entirely when there is none
    b.hidden = tutHidden || (id === 'ship' && !sys.ctx.housing);
  }
  }

/** `크레딧 n` readout on the ship screen (`ctx.meta.credits`; refreshed on `meta:creditsChanged`). */
export function refreshCredits(sys: InventoryUI): void {
  if (!sys.root) return;
  const meta = sys.ctx.meta;
  const credits = meta && typeof meta.credits === 'number' ? meta.credits : null;
  sys.creditsValue.textContent = credits === null ? TEXT.credits.none : TEXT.credits.value(credits);
  sys.creditsEl.classList.toggle('is-unavailable', credits === null);
  }

export function toggleCraft(sys: InventoryUI): void {
  const open = !sys.craftPanel.isOpen;
  if (!open && sys.sys.getBench()) sys.sys.closeBench(); // bench mode: closing the panel leaves the bench
  else sys.setCraftOpen(open);
  sys.sys.sfx('ui_pickup');
  }

/**
 * System-driven craft panel visibility (`openBenchCraft` / `closeBench`).
 *
 * **2026-09-07**: the panel is a **column of the window** again instead of a modeless popup — `.inv-layout.is-craft`
 * puts the recipe list leftmost (where 함선 창고 sits otherwise) and stacks 가방 over 함선 창고 on the right, so the
 * materials a recipe needs are visible next to it. Still no blocker and no pointer-lock change: the window owns both.
 *
 * **2026-09-08**: `.is-craft` also lands on the **root**, and there it *hides* everything a recipe list has nothing
 * to do with — 장착 장비 + 임플란트 열 · 퀵슬롯 로즈 · 가방 헤더의 `제작`/가치 · 상단 화면 탭. 제작 중에는 재료와
 * 레시피만 남는다 (사용자 결정). 장비 칸이 사라지므로 만든 무기를 장착하려면 제작 창을 닫아야 한다 — 튜토리얼의
 * `openBag` 단계가 그 순서를 그대로 안내한다.
 */
export function setCraftOpen(sys: InventoryUI, open: boolean): void {
  const was = sys.craftPanel.isOpen;
  sys.craftPanel.setOpen(open);
  if (open) sys.disassemble.close();
  else sys.repair.close();          // 수리 팝업은 작업대에 붙어 있다 — 작업대를 떠나면 같이 닫힌다
  sys.layout?.classList.toggle('is-craft', open);
  sys.root?.classList.toggle('is-craft', open);
  // 2026-09-12: the stacked 가방-over-창고 column has no room for the fixed 12-row bag frame — the stash fell off-screen
  sys.bagView?.setFrameRows(open ? null : BAG_FRAME_ROWS);
  if (open) sys.craftPanel.refresh();
  // 2026-09-09 키 가이드: the 제작 열 is its own owner over the window's line. Mouse only — the hold button says what it
  //   is, so the line carries no keys of its own (the guide appends `Tab 닫기` itself).
  if (was !== open) sys.ctx.bus.emit('ui:keyGuide', { owner: 'inventory.craft', keys: open ? [] : null });
  }

/** The panel's 닫기 button / Escape / an outside click: leave the bench too when one is active. */
export function closeCraft(sys: InventoryUI): void {
  if (!sys.craftPanel.isOpen) return;
  if (sys.sys.getBench()) sys.sys.closeBench(); // → setCraftOpen(false) through the system
  else sys.setCraftOpen(false);
  }

/** Repaint the craft rows (progress / counts) without rebuilding the rest of the window. */
export function refreshCraft(sys: InventoryUI): void {
  if (!sys.root || sys.root.hidden) return;
  sys.craftPanel.refresh();
  // Phase 12: the 분해 게이지 advances with the job every frame (cheap tick, not the chip rebuild of `refresh()`)
  if (sys.disassemble.isOpen) sys.disassemble.tick();
  }

/** Show / hide the catalog panel (system state lives in `InventorySystem.isCatalogOpen`). */
export function setCatalog(sys: InventoryUI, open: boolean): void {
  sys.catalogView.setOpen(open);
  if (!open && sys.drag?.catalog) sys.cancelDrag();
  if (!open) sys.tooltip.hide();
  }

/** Double-press on a catalog tile: a fresh instance straight into the bag. */
export function catalogTake(sys: InventoryUI, def: ItemDef): void {
  const r = sys.sys.takeFromCatalog(def.id);
  if (r === 'ok') sys.sys.sfx('ui_pickup');
  else { sys.sys.sfx('ui_error'); sys.catalogView.shake(def.id); sys.ctx.bus.emit('ui:notify', { text: TEXT.catalog.bagFull, kind: 'warning', duration: 1.6 }); }
  }

/**
 * Press on a catalog tile: mint a fresh instance and drag it like any other item (the tile stays). A second press
 * on the same tile within `CATALOG_DBL_MS` counts as the double-click (`takeFromCatalog`) — detected here because
 * the cancelled pointerdown keeps Chrome from synthesising `dblclick` reliably.
 */
export function beginCatalogPress(sys: InventoryUI, def: ItemDef, sample: ItemInstance, e: PointerEvent, tileEl: HTMLElement): void {
  if (sys.drag || sys.dialog.isOpen) return;
  if (e.button !== 0) return;
  e.preventDefault();
  sys.menu.close();
  const now = performance.now();
  const last = sys.lastCatalogPress;
  if (last && last.defId === def.id && now - last.t < CATALOG_DBL_MS) {
    sys.lastCatalogPress = null;
    sys.catalogTake(def);
    return;
  }
  sys.lastCatalogPress = { defId: def.id, t: now };
  const item = sys.sys.getLoot().createItem(def.id, sample.qty);
  // the ghost is centred on the cursor and uses the item's real footprint (the catalog tile is a uniform 2×2)
  const { width, height } = tileSize(def.width, def.height);
  sys.drag = {
    uid: item.uid, item, def, from: BAG_LOC, quickFrom: null, qty: null, catalog: true,
    rotated: false,
    started: false,
    startX: e.clientX, startY: e.clientY,
    grabX: width * 0.5, grabY: height * 0.5,       // the ghost rides the cursor centred (2026-09-07)
    ghost: null, target: null,
    lastX: e.clientX, lastY: e.clientY,
  };
  window.addEventListener('pointermove', sys.onWindowMove);
  window.addEventListener('pointerup', sys.onWindowUp);
  window.addEventListener('pointercancel', sys.onWindowUp);
  }

/** Drag targets of a catalog instance: equipment slots, then the active grids (never the wheel / sockets / world). */
export function updateCatalogTarget(sys: InventoryUI, d: DragState, px: number, py: number): void {
  for (const sv of sys.slots.values()) {
    const r = sv.body.getBoundingClientRect();
    if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
      d.target = { kind: 'slot', slot: sv.slot };
      const pv = sys.sys.previewCatalog(d.item, d.target);
      sv.el.classList.add(pv === 'bad' ? 'is-target-bad' : 'is-target-ok');
      return;
    }
  }
  const { w, h } = sys.footprint(d);
  const left = px - d.grabX, top = py - d.grabY;
  const hit = sys.resolveGridTarget(sys.activeViews(), left, top, w, h, px, py);
  if (hit) {
    const view = hit.view;
    d.target = { kind: 'grid', grid: view.id, x: hit.x, y: hit.y, rotated: d.rotated };
    const pv = sys.sys.previewCatalog(d.item, d.target);
    view.showHighlight(hit.x, hit.y, w, h, pv === 'bad' ? 'bad' : pv === 'swap' ? 'swap' : pv === 'merge' ? 'merge' : 'ok');
  }
  }
