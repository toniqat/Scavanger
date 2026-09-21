/**
 * src/inventory/ui/parts/Screens.ts — **the Tab window's screen tabs** and the columns beside them.
 *
 * In the ship, Tab switches between four screens inside one window — 인벤토리 / 캐릭터 / 기업 / 함선
 * (each screen is the `EmbeddedView` its own folder handed over, so this file only attaches and detaches it).
 * Opening and closing the craft column and the infinite box catalog live here too.
 */
import type { EmbeddedView, ItemDef, ItemInstance } from '@/shared';
import { anyCorpAccessible } from '@/shared';
import { TEXT, tileSize } from '../labels';
import { BAG_LOC, CATALOG_DBL_MS, type DragState, SCREEN_TABS, type ScreenTab } from '../model';
import type { InventoryUI } from '../InventoryUI';

export function onTab(sys: InventoryUI, tab: ScreenTab): void {
  if (tab === sys.activeTab) return;
  // 2026-09-13: the screen being left may ask first (unconfirmed points on the 캐릭터 tab — `EmbeddedView.requestLeave`) and switch later
  if (sys.screenView?.requestLeave?.(() => onTab(sys, tab))) return;
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
  // 2026-09-08: during the tutorial only the 인벤토리 tab — the rest are drawn locked and a click is turned back
  if (tab !== 'inventory' && sys.ctx.tutorial?.blockReason('screenTab', tab)) tab = 'inventory';
  // 2026-09-17 (user's decision): the 기업 tab stays hidden and refuses to open until some corp reaches 신뢰도 Lv.1
  if (tab === 'corp' && corpTabLocked(sys)) tab = 'inventory';
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
    sys.emitGuide();               // 2026-09-09: the key guide line follows the tab
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

/**
 * 2026-09-17 (user's decision): true while no corp has reached `CORP_ACCESS_REP_LEVEL` — the 기업 screen tab is hidden then
 * (the first level comes from the corp NPCs' first quests). Without `ctx.meta` the tab is not rep-gated here; `buildScreenView`
 * already answers "unavailable".
 */
export function corpTabLocked(sys: InventoryUI): boolean {
  const meta = sys.ctx.meta;
  if (!meta || typeof meta.getRep !== 'function') return false;
  try { return !anyCorpAccessible((c) => meta.getRep(c).level); } catch { return false; }
}

/**
 * Re-evaluate the rep gate live (`meta:repChanged` / `meta:loaded`): re-mark the tabs, and leave the 기업 screen when it
 * just became locked (a reset profile).
 */
export function onCorpAccessChanged(sys: InventoryUI): void {
  if (!sys.root) return;
  if (sys.activeTab === 'corp' && corpTabLocked(sys)) sys.setTab('inventory');
  sys.markTab();
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
  // 2026-09-08: the 캐릭터 tab wears a red dot while there are unspent stat points (level-ups are easy to miss)
  let statPoints = 0;
  try { statPoints = sys.ctx.progression?.statPoints ?? 0; } catch { statPoints = 0; }
  for (const [id, b] of sys.tabButtons) {
    b.classList.toggle('is-on', id === sys.activeTab);
    // 2026-09-08: a tab the tutorial blocks is **hidden outright** — showing only the tabs usable now beats leaving a
    // lock plus a "튜토리얼에서는 ~" tooltip. Once it ends or is skipped they come back on `tutorial:changed`.
    const tutHidden = id !== 'inventory' && (sys.ctx.tutorial?.hides('screenTab', id) ?? false);
    b.title = SCREEN_TABS.find((t) => t.id === id)?.title ?? '';
    if (id === 'character') {
      const alert = statPoints > 0;
      b.classList.toggle('has-alert', alert);
      b.dataset.alert = alert ? String(statPoints) : '';
    }
    // 함선 needs the housing system; hide the tab entirely when there is none
    // 2026-09-17: 기업 stays hidden until some corp reaches 신뢰도 Lv.1 (`corpTabLocked`)
    b.hidden = tutHidden || (id === 'ship' && !sys.ctx.housing) || (id === 'corp' && corpTabLocked(sys));
  }
}

/**
 * The held-credits text (`ctx.meta.credits`; refreshed on `meta:creditsChanged` and every `refresh`). 2026-09-16: not the
 * top-right pill but the `12,345 C` at the right end of the bag's bottom row — one string, unit included (`formatCredits`).
 */
export function refreshCredits(sys: InventoryUI): void {
  if (!sys.root) return;
  const meta = sys.ctx.meta;
  const credits = meta && typeof meta.credits === 'number' ? meta.credits : null;
  const text = credits === null ? TEXT.credits.none : TEXT.credits.value(credits);
  if (sys.creditsValue.textContent !== text) sys.creditsValue.textContent = text;
  sys.creditsValue.classList.toggle('is-unavailable', credits === null);
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
 * puts the recipe list leftmost (where the stash sits otherwise) and stacks the bag over the stash on the right, so
 * the materials a recipe needs are visible next to it. Still no blocker and no pointer-lock change: the window owns both.
 *
 * **2026-09-08**: `.is-craft` also lands on the **root**, and there it *hides* everything a recipe list has nothing
 * to do with — the equipment + implant column · the quick-slot rose · the bag header's `제작` / value · the screen tabs
 * on top. While crafting only materials and recipes are left (user's decision). The equipment slots go with them, so
 * equipping a crafted weapon means closing the craft window — the tutorial's `openBag` step walks exactly that order.
 *
 * **2026-09-15 4th pass (user's decision)**: the stash · bag grid card (`.inv-panel-grids`) hides while crafting too
 * (css `.inv-layout.is-craft`) — materials are counted from the inventory model, not from the grids. The window keeps
 * [the bench list · the recipe list] and [the detail card] alone. Tab · Escape · the key guide are unchanged (the
 * hiding is css only, so the `closeOverlays` → `closeCraft` path does not change).
 */
export function setCraftOpen(sys: InventoryUI, open: boolean): void {
  const was = sys.craftPanel.isOpen;
  sys.craftPanel.setOpen(open);
  if (open) sys.disassemble.close();
  else { sys.repair.close(); sys.tooltip.hide(); }   // the repair popup is attached to the bench — leaving it closes both; so goes the list's hover card
  // 2026-09-15 4th pass: so no hover card and no drag survives on a grid while it is hidden
  if (open) { if (sys.drag && !sys.drag.catalog) sys.cancelDrag(); sys.hoverLeave(); }
  sys.layout?.classList.toggle('is-craft', open);
  sys.root?.classList.toggle('is-craft', open);
  if (open) sys.craftPanel.refresh();
  // 2026-09-09 key guide: the 제작 column is its own owner over the window's line. Mouse only — the hold button says
  //   what it is, so the line carries no keys of its own (the guide appends `Tab 닫기` itself).
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
  // Phase 12: the 분해 gauge advances with the job every frame (cheap tick, not the chip rebuild of `refresh()`)
  if (sys.disassemble.isOpen) sys.disassemble.tick();
}

/**
 * Show / hide the catalog panel (system state lives in `InventorySystem.isCatalogOpen`).
 *
 * **2026-09-13 (user's decision)**: while the catalog is open the window keeps only **the infinite box · the stash (in
 * the ship) · the bag** — `.is-catalog` hides the equipment column (primary · armor · bag slot · tactical implants ·
 * pouch slot) · the quick-slot rose · the pouch grid (`inventory.css`). A hidden slot is no drop target either:
 * `Drag.updateDragTarget` / `updateCatalogTarget` skip the equipment and quick slots and `activeViews()` leaves the
 * pouch grid out. Closing it drops the class and the usual layout returns.
 */
export function setCatalog(sys: InventoryUI, open: boolean): void {
  sys.catalogView.setOpen(open);
  sys.root?.classList.toggle('is-catalog', open);
  sys.layout?.classList.toggle('is-catalog', open);
  if (!open && sys.drag?.catalog) sys.cancelDrag();
  if (!open) sys.tooltip.hide();
}

/** Double-press on a catalog tile: a fresh instance into the stash when it shows (ship), else / then the bag (2026-09-17). */
export function catalogTake(sys: InventoryUI, def: ItemDef): void {
  const r = sys.sys.takeFromCatalog(def.id);
  if (r === 'ok') sys.sys.sfx('ui_pickup');
  else {
    sys.sys.sfx('ui_error'); sys.catalogView.shake(def.id);
    sys.ctx.bus.emit('ui:notify', { text: sys.sys.hubMode ? TEXT.catalog.stashBagFull : TEXT.catalog.bagFull, kind: 'warning', duration: 1.6 });
  }
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
  // 2026-09-13: while the catalog is open the equipment column is hidden (`.is-catalog`) — its slots are no target
  for (const sv of sys.catalogView.isOpen ? [] : sys.slots.values()) {
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
