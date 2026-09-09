/**
 * src/inventory/ui/parts/Drag.ts — **아이템 끌어 놓기**.
 *
 * 누름 판정 → 고스트 생성 → 커서 추적 → 대상 격자/칸 판정 → 놓기 까지의 포인터 상태 기계 전부.
 * 어떤 칸에 놓을 수 있는지는 여기서 정하지 않는다 — `inventory/parts/DropResolver.ts` 에 물어보고
 * 그 답(`ok` / `swap` / `merge` / `bad`)을 하이라이트 색으로 그릴 뿐이다.
 * 고스트는 커서 **중앙**에 붙고, 확대는 CSS `scale:` 이 아니라 `positionGhost` 의 transform 안에 있다
 * (개별 변환은 translate → scale 순이라 JS 가 쓴 translate 가 곱해져 커서에서 벌어졌다).
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

/**
 * Grid cell a ghost of `w × h` at (left, top) would land on, resolved **strictly first**: a grid that actually
 * contains the pointer always wins over one that only sits within its half-cell tolerance. The two-pass order is
 * what stopped 가방 and 함선 창고 (stacked with a small gap since the 2026-09-07 pass) from stealing each other's
 * edge rows — `activeViews()` is ordered 창고 → 가방, so the padded box of the stash used to swallow drops the
 * player aimed at the bag's last row.
 */
export function resolveGridTarget(sys: InventoryUI, views: GridView[], left: number, top: number, w: number, h: number, px: number, py: number): { view: GridView; x: number; y: number } | null {
  for (const view of views) {
    if (!view.hitTest(px, py, 0)) continue;
    const cell = view.cellForGhost(left, top, w, h, px, py, 0);
    if (cell) return { view, x: cell.x, y: cell.y };
  }
  for (const view of views) {
    const cell = view.cellForGhost(left, top, w, h, px, py);
    if (cell) return { view, x: cell.x, y: cell.y };
  }
  return null;
  }

/** X drops the dragged or hovered item; Shift+X one unit, Ctrl+X half the stack. In the ship the item lands in the stash. */
export function onDropKey(sys: InventoryUI, shift: boolean, ctrl: boolean): void {
  if (sys.dialog.isOpen) return;
  sys.menu.close();
  const d = sys.drag;
  if (d?.catalog) { sys.cancelDrag(); return; } // a catalog instance has nothing to throw away
  let uid: string, from: ItemLocation;
  if (d?.started) { uid = d.uid; from = d.from; }
  else if (sys.hovered) { uid = sys.hovered.uid; from = sys.hovered.loc; }
  else return;
  const item = sys.sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return;
  let qty: number | undefined;
  if (d?.started && d.qty !== null) qty = d.qty;
  else if (def.stackMax > 1 && item.qty >= 2) {
    if (shift) qty = 1;
    else if (ctrl) qty = Math.max(1, Math.floor(item.qty / 2));
  }
  if (d) sys.cancelDrag();
  sys.dropToWorld(uid, from, qty);
  }

export function onRotateKey(sys: InventoryUI): void {
  if (sys.dialog.isOpen) return;
  if (sys.drag?.started) {
    const d = sys.drag;
    const def = d.def;
    if (def.width === def.height) return;
    d.rotated = !d.rotated;
    sys.rebuildGhost(d);
    sys.sys.sfx('ui_rotate');
    sys.updateDragTarget(d.lastX, d.lastY);
    return;
  }
  const h = sys.hovered;
  if (!h || h.loc.kind !== 'grid') return;
  const r = sys.sys.rotateItem(h.uid, h.loc.grid);
  sys.result(r, 'ui_rotate', h.loc, h.uid);
  }

export function beginPress(sys: InventoryUI, uid: string, from: ItemLocation, e: PointerEvent, tileEl: HTMLElement, quickFrom: number | null = null): void {
  if (sys.drag || sys.dialog.isOpen) return;
  if (e.button === MIDDLE_BUTTON) {
    // quick chat request (also stops the browser's middle-click autoscroll)
    e.preventDefault();
    sys.menu.close();
    if (!sys.locked(uid, from)) sys.sys.requestItem(uid, from);
    return;
  }
  if (e.button !== 0) return;
  if (sys.locked(uid, from)) return;
  const item = sys.sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return;
  e.preventDefault();
  sys.menu.close();
  // Shift → half the stack, Ctrl → one unit (grid stacks only; falls back to a whole-item drag)
  let qty: number | null = null;
  if (from.kind === 'grid' && quickFrom === null) {
    if (e.shiftKey) qty = sys.sys.partialQtyFor(item, 'half');
    else if (e.ctrlKey) qty = sys.sys.partialQtyFor(item, 'one');
  }
  // 2026-09-07: the ghost is **centred on the cursor** rather than anchored where the tile was grabbed, so the
  // item the cursor points at is the item that lands. `rebuildGhost` re-centres after a rotation.
  const fp = item.rotated ? { w: def.height, h: def.width } : { w: def.width, h: def.height };
  const size = tileSize(fp.w, fp.h);
  sys.drag = {
    uid, item, def, from, quickFrom, qty, catalog: false,
    rotated: item.rotated,
    started: false,
    startX: e.clientX, startY: e.clientY,
    grabX: size.width * 0.5, grabY: size.height * 0.5,
    ghost: null, target: null,
    lastX: e.clientX, lastY: e.clientY,
  };
  window.addEventListener('pointermove', sys.onWindowMove);
  window.addEventListener('pointerup', sys.onWindowUp);
  window.addEventListener('pointercancel', sys.onWindowUp);
  }

export function startDrag(sys: InventoryUI, d: DragState): void {
  d.started = true;
  sys.tooltip.hide();
  sys.root?.classList.add('is-dragging');
  if (d.catalog) {
    // catalog: the source tile stays as it is (infinite stock); no world drop, no wheel targets
    sys.root?.classList.add('is-catalog-drag');
    sys.rebuildGhost(d);
    sys.sys.sfx('ui_pickup');
    return;
  }
  // a stim / grenade from the bag (or a wheel cell): light the usable cells as targets
  if (isQuickUsable(d.def) && d.from.kind === 'grid' && d.from.grid === 'bag' && d.qty === null) sys.root?.classList.add('is-quick-drag');
  if (d.quickFrom !== null) {
    sys.quickCells[d.quickFrom]?.tile?.classList.add('is-dragging');
    sys.root?.classList.add('is-quick-source');
  } else if (d.from.kind === 'grid') {
    const view = sys.viewOf(d.from.grid);
    if (d.qty !== null) view.markSplitSource(d.uid, d.item.qty - d.qty);
    else view.setDragging(d.uid);
  } else if (d.from.kind === 'quick') {
    sys.quickCell(d.from.index)?.classList.add('is-dragging');
  } else {
    sys.slots.get(d.from.slot)?.tile?.classList.add('is-dragging');
  }
  sys.rebuildGhost(d);
  sys.sys.sfx('ui_pickup');
  }

export function footprint(sys: InventoryUI, d: DragState): { w: number; h: number } {
  return d.rotated ? { w: d.def.height, h: d.def.width } : { w: d.def.width, h: d.def.height };
  }

export function rebuildGhost(sys: InventoryUI, d: DragState): void {
  const { w, h } = sys.footprint(d);
  if (!d.ghost) {
    d.ghost = document.createElement('div');
    sys.ghostLayer.appendChild(d.ghost);
  }
  const ghostItem: ItemInstance = { ...d.item, rotated: d.rotated, qty: d.qty ?? d.item.qty };
  buildTileContent(d.ghost, ghostItem, d.def, w, h);
  d.ghost.classList.add('inv-ghost');
  d.ghost.classList.toggle('is-partial', d.qty !== null);
  const { width, height } = tileSize(w, h);
  // keep the ghost centred under the cursor (a rotation changes the footprint, so this runs again)
  d.grabX = width * 0.5;
  d.grabY = height * 0.5;
  sys.positionGhost(d, d.lastX, d.lastY);
  }

export function positionGhost(sys: InventoryUI, d: DragState, x: number, y: number): void {
  if (!d.ghost) return;
  // The lift must be part of *this* transform (see `.inv-ghost` in inventory.css): as a standalone `scale:` it is
  // applied before the `transform` property and scales the translate, which pushed the ghost away from the cursor.
  d.ghost.style.transform = `translate(${Math.round(x - d.grabX)}px, ${Math.round(y - d.grabY)}px) scale(${GHOST_SCALE})`;
  }

export function handlePointerMove(sys: InventoryUI, e: PointerEvent): void {
  const d = sys.drag;
  if (!d) return;
  d.lastX = e.clientX; d.lastY = e.clientY;
  if (!d.started) {
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
    sys.startDrag(d);
  }
  sys.positionGhost(d, e.clientX, e.clientY);
  sys.updateDragTarget(e.clientX, e.clientY);
  }

export function updateDragTarget(sys: InventoryUI, px: number, py: number): void {
  const d = sys.drag;
  if (!d || !d.started) return;
  sys.bagView.hideHighlight();
  sys.containerView.hideHighlight();
  sys.stashView.hideHighlight();
  for (const sv of sys.slots.values()) sv.el.classList.remove('is-target-ok', 'is-target-bad');
  d.target = null;
  sys.dropZone.classList.remove('is-hot');
  sys.clearSocketTarget();
  for (const c of sys.quickCells) c.el.classList.remove('is-target-ok', 'is-target-bad', 'is-target-swap');

  if (d.catalog) { sys.updateCatalogTarget(d, px, py); return; }

  // quick-use wheel cells (any drag: non-usable items light red)
  const cell = sys.quickCellAt(px, py);
  if (cell) {
    d.target = { kind: 'quick', index: cell.index };
    const pv = sys.preview(d, d.target);
    cell.el.classList.add(pv === 'bad' ? 'is-target-bad' : pv === 'swap' ? 'is-target-swap' : 'is-target-ok');
    return;
  }
  // a wheel-cell drag released anywhere else clears the slot; no other target applies
  if (d.quickFrom !== null) return;

  // attachments: a weapon tile under the pointer (bag or equipment slot) is a socket target
  if (isAttachmentDef(d.def)) {
    const w = sys.weaponTileAt(px, py, d.uid);
    if (w) {
      d.target = { kind: 'weapon', uid: w.uid, loc: w.loc };
      const pv = sys.preview(d, d.target);
      sys.setSocketTarget(w, pv === 'bad' ? 'bad' : 'ok');
      return;
    }
  }

  // equipment slots first
  for (const sv of sys.slots.values()) {
    const r = sv.body.getBoundingClientRect();
    if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
      d.target = { kind: 'slot', slot: sv.slot };
      const pv = sys.preview(d, d.target);
      sv.el.classList.add(pv === 'bad' ? 'is-target-bad' : 'is-target-ok');
      return;
    }
  }

  const { w, h } = sys.footprint(d);
  const left = px - d.grabX, top = py - d.grabY;
  const hit = sys.resolveGridTarget(sys.activeViews(), left, top, w, h, px, py);
  if (hit) {
    d.target = { kind: 'grid', grid: hit.view.id, x: hit.x, y: hit.y, rotated: d.rotated };
    let pv = sys.preview(d, d.target);
    /*
     * 2026-09-07: an **equipment slot → grid** drag that lands on an occupied cell used to be refused outright —
     * the weapon snapped back into its slot and shook even with half the bag free. Retarget the drop (and the
     * highlight, so the player sees where it goes) to the nearest free footprint instead. Grid → grid keeps the
     * strict Diablo rule: the cell you point at is the cell you get.
     */
    if (pv === 'bad' && d.from.kind === 'slot' && d.from.slot !== 'bag' && d.qty === null) {
      const spot = sys.sys.nearestFreeSpot(d.uid, d.from, hit.view.id, hit.x, hit.y, d.rotated);
      if (spot) {
        const retarget: DropTarget = { kind: 'grid', grid: hit.view.id, x: spot.x, y: spot.y, rotated: spot.rotated };
        if (sys.sys.previewDrop(d.uid, d.from, retarget) === 'ok') {
          d.target = retarget;
          pv = 'ok';
          const fp = spot.rotated ? { w: d.def.height, h: d.def.width } : { w: d.def.width, h: d.def.height };
          hit.view.showHighlight(spot.x, spot.y, fp.w, fp.h, 'ok');
          return;
        }
      }
    }
    const state: HighlightState = pv === 'bad' ? 'bad' : pv === 'swap' ? 'swap' : pv === 'merge' ? 'merge' : 'ok';
    hit.view.showHighlight(hit.x, hit.y, w, h, state);
    return;
  }

  // outside every grid/slot: over the backdrop → world drop (the zone lights up when hovered directly; hidden in the ship)
  if (!sys.hub && !sys.isOverPanel(px, py)) {
    const r = sys.dropZone.getBoundingClientRect();
    if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) sys.dropZone.classList.add('is-hot');
  }
  }

export function preview(sys: InventoryUI, d: DragState, target: DropTarget) {
  if (d.catalog) return sys.sys.previewCatalog(d.item, target);
  return d.qty !== null ? sys.sys.previewPartial(d.uid, d.from, d.qty, target) : sys.sys.previewDrop(d.uid, d.from, target);
  }

/** Weapon tile under the pointer (the ghost layer ignores pointer events), excluding the dragged item itself. */
export function weaponTileAt(sys: InventoryUI, x: number, y: number, exceptUid: string): { uid: string; loc: ItemLocation } | null {
  const el = document.elementFromPoint(x, y);
  const tile = el && (el as Element).closest<HTMLElement>('.inv-tile.is-weapon');
  const uid = tile?.dataset.uid;
  if (!tile || !uid || uid === exceptUid) return null;
  const slotEl = tile.closest<HTMLElement>('.inv-slot');
  if (slotEl?.dataset.slot) return { uid, loc: { kind: 'slot', slot: slotEl.dataset.slot as SlotId } };
  if (tile.closest('.inv-grid-bag')) return { uid, loc: { kind: 'grid', grid: 'bag' } };
  if (tile.closest('.inv-grid-container')) return { uid, loc: { kind: 'grid', grid: 'container' } };
  if (tile.closest('.inv-grid-stash')) return { uid, loc: { kind: 'grid', grid: 'stash' } };
  return null;
  }

export function setSocketTarget(sys: InventoryUI, w: { uid: string; loc: ItemLocation }, state: 'ok' | 'bad'): void {
  sys.socketTarget = w;
  if (w.loc.kind === 'grid') {
    sys.viewOf(w.loc.grid).setSocketTarget(w.uid, state);
  } else if (w.loc.kind === 'quick') {
    // a weapon never sits on the wheel, so there is no socket target to mark there
  } else {
    const tile = sys.slots.get(w.loc.slot)?.tile;
    tile?.classList.toggle('is-socket-ok', state === 'ok');
    tile?.classList.toggle('is-socket-bad', state === 'bad');
  }
  }

export function clearSocketTarget(sys: InventoryUI): void {
  if (!sys.socketTarget) return;
  sys.socketTarget = null;
  sys.bagView.setSocketTarget(null, null);
  sys.containerView.setSocketTarget(null, null);
  sys.stashView.setSocketTarget(null, null);
  for (const sv of sys.slots.values()) sv.tile?.classList.remove('is-socket-ok', 'is-socket-bad');
  }

/** True when the point lies on a panel / equipment column (a miss there snaps back instead of dropping). */
export function isOverPanel(sys: InventoryUI, x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y);
  return !!el && !!(el as Element).closest('.inv-panel, .inv-equip, .inv-menu, .inv-dialog, .scr-tabs, .inv-modeless, .inv-screen');
  }

export function handlePointerUp(sys: InventoryUI, e: PointerEvent): void {
  const d = sys.drag;
  if (!d) return;
  if (e.button !== 0 && e.type === 'pointerup') return;
  window.removeEventListener('pointermove', sys.onWindowMove);
  window.removeEventListener('pointerup', sys.onWindowUp);
  window.removeEventListener('pointercancel', sys.onWindowUp);
  sys.drag = null;

  if (!d.started) return; // plain click
  sys.endDragVisuals(d);

  // catalog instance: only a grid cell / slot takes it; anywhere else simply discards the fresh instance
  if (d.catalog) {
    if (!d.target) { sys.sys.sfx('ui_error'); return; }
    const r = sys.sys.dropFromCatalog(d.item, d.target);
    if (r === 'ok') sys.sys.sfx(d.target.kind === 'grid' ? 'ui_drop' : 'ui_equip');
    else if (r === 'fail') { sys.sys.sfx('ui_error'); sys.catalogView.shake(d.def.id); }
    return;
  }

  // dragged out of a wheel cell: another cell moves the assignment, anywhere else clears it (the item stays in the bag)
  if (d.quickFrom !== null && d.target?.kind !== 'quick') {
    sys.result(sys.sys.setQuickSlot(d.quickFrom, null) ? 'ok' : 'fail', 'ui_drop', d.from, d.uid);
    return;
  }

  if (!d.target) {
    if (sys.isOverPanel(e.clientX, e.clientY)) {
      // missed a cell but still on a panel: snap back
      sys.shake(d.from, d.uid);
      sys.sys.sfx('ui_error');
      return;
    }
    // released over the backdrop / drop zone: throw it into the world (ship: into the stash)
    sys.dropToWorld(d.uid, d.from, d.qty ?? undefined);
    return;
  }
  const r = d.qty !== null ? sys.sys.dropPartial(d.uid, d.from, d.qty, d.target) : sys.sys.drop(d.uid, d.from, d.target);
  if (r === 'ok') sys.sys.sfx(d.target.kind === 'grid' ? 'ui_drop' : 'ui_equip');
  else if (r === 'fail') { sys.sys.sfx('ui_error'); sys.shake(d.from, d.uid); }
  }

export function endDragVisuals(sys: InventoryUI, d: DragState): void {
  d.ghost?.remove();
  d.ghost = null;
  sys.root?.classList.remove('is-dragging', 'is-quick-drag', 'is-quick-source', 'is-catalog-drag');
  sys.dropZone.classList.remove('is-hot');
  for (const c of sys.quickCells) {
    c.el.classList.remove('is-target-ok', 'is-target-bad', 'is-target-swap');
    c.tile?.classList.remove('is-dragging');
  }
  sys.bagView.setDragging(null);
  sys.containerView.setDragging(null);
  sys.stashView.setDragging(null);
  if (d.qty !== null && d.from.kind === 'grid') sys.viewOf(d.from.grid).markSplitSource(d.uid, null);
  sys.bagView.hideHighlight();
  sys.containerView.hideHighlight();
  sys.stashView.hideHighlight();
  sys.clearSocketTarget();
  for (const sv of sys.slots.values()) {
    sv.el.classList.remove('is-target-ok', 'is-target-bad');
    sv.tile?.classList.remove('is-dragging');
  }
  }

export function cancelDrag(sys: InventoryUI): void {
  const d = sys.drag;
  if (!d) return;
  window.removeEventListener('pointermove', sys.onWindowMove);
  window.removeEventListener('pointerup', sys.onWindowUp);
  window.removeEventListener('pointercancel', sys.onWindowUp);
  sys.drag = null;
  if (d.started) sys.endDragVisuals(d);
  }
