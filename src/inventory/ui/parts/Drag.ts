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
import { BAG_LOC, CATALOG_DBL_MS, CLICK_SUPPRESS_MS, DRAG_THRESHOLD, type DragState, GHOST_SCALE, LOCK_SVG, MIDDLE_BUTTON, type QuickCell, SCREEN_TABS, type ScreenTab, type SlotView } from '../model';
import { AUTO_SCROLL_EDGE_IN, AUTO_SCROLL_EDGE_OUT, AUTO_SCROLL_MAX_SPEED } from '../model';
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
  addDragListeners(sys, false);
  }

function addDragListeners(sys: InventoryUI, held: boolean): void {
  window.addEventListener('pointermove', sys.onWindowMove);
  window.addEventListener('pointerup', sys.onWindowUp);
  window.addEventListener('pointercancel', sys.onWindowUp);
  if (held) window.addEventListener('pointerdown', sys.onWindowDown, true);
}

function removeDragListeners(sys: InventoryUI): void {
  window.removeEventListener('pointermove', sys.onWindowMove);
  window.removeEventListener('pointerup', sys.onWindowUp);
  window.removeEventListener('pointercancel', sys.onWindowUp);
  window.removeEventListener('pointerdown', sys.onWindowDown, true);
}

/**
 * 2026-09-12 (사용자 결정) — **합치고 남은 수량은 커서에 붙는다.** 붕대 2 를 붕대 4 가 든 퀵슬롯(최대 5)에 놓으면
 * 칸은 5 가 되고 1 이 커서에 남는다. 격자끼리 합칠 때도 같다.
 *
 * 남은 수량은 **출발지를 떠나지 않는다** — 출발 스택의 수량이 줄었을 뿐이고, 여기서는 그 스택을 다시 끄는 드래그를
 * `held` 로 열어 둔다. 그래서 세이브 · 시체 벗기기 · 창 닫기 어느 쪽이 끼어들어도 아이템은 제자리에 있다.
 * `qty` null = 남은 스택 전부, 숫자 = 나눈 드래그(Shift / Ctrl)의 남은 몫.
 */
export function holdRemainder(sys: InventoryUI, prev: DragState, qty: number | null, x: number, y: number): void {
  const item = sys.sys.findItem(prev.uid, prev.from);
  if (!item) return;
  const d: DragState = {
    uid: prev.uid, item, def: prev.def, from: prev.from,
    quickFrom: prev.from.kind === 'quick' ? prev.from.index : null,
    qty, catalog: false, rotated: prev.rotated, started: false,
    startX: x, startY: y, grabX: 0, grabY: 0, ghost: null, target: null, lastX: x, lastY: y,
    held: true, armed: false,
  };
  sys.drag = d;
  addDragListeners(sys, true);
  startDrag(sys, d);
  sys.updateDragTarget(x, y);
  sys.suppressClicksUntil = performance.now() + CLICK_SUPPRESS_MS;
}

/**
 * Press while a remainder is held: swallow it (no tile press, no button, no tab under the cursor) and arm the release.
 * The right button lets go instead — the stack is already home.
 */
export function handleHeldDown(sys: InventoryUI, e: PointerEvent): void {
  const d = sys.drag;
  if (!d?.held) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.button === 2) {
    sys.cancelDrag();
    sys.sys.sfx('ui_drop');
    sys.suppressClicksUntil = performance.now() + CLICK_SUPPRESS_MS;
    return;
  }
  if (e.button !== 0) return;
  d.lastX = e.clientX; d.lastY = e.clientY;
  sys.positionGhost(d, e.clientX, e.clientY);
  sys.updateDragTarget(e.clientX, e.clientY);
  d.armed = true;
}

/**
 * 2026-09-11 (C-60) — scroll speed (px/s, negative = up) for a pointer at (px, py) against a vertical scroll viewport.
 * 0 when the viewport does not overflow, the pointer is outside its column, or it is away from the top / bottom edge:
 * inside the view the speed ramps up over `AUTO_SCROLL_EDGE_IN` px towards the edge, and just past it (the panel header
 * above, the padding below — up to `AUTO_SCROLL_EDGE_OUT` px) it is the full `AUTO_SCROLL_MAX_SPEED`.
 */
export function autoScrollSpeed(scroller: HTMLElement | null, px: number, py: number): number {
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) return 0;
  const r = scroller.getBoundingClientRect();
  if (r.height <= 0 || px < r.left || px > r.right) return 0;
  if (py < r.top - AUTO_SCROLL_EDGE_OUT || py > r.bottom + AUTO_SCROLL_EDGE_OUT) return 0;
  const ramp = (inside: number): number => {
    const t = inside <= 0 ? 1 : Math.max(0, 1 - inside / AUTO_SCROLL_EDGE_IN);
    return t * t;
  };
  const fromTop = py - r.top, fromBottom = r.bottom - py;
  if (fromTop < AUTO_SCROLL_EDGE_IN && scroller.scrollTop > 0) return -AUTO_SCROLL_MAX_SPEED * ramp(fromTop);
  if (fromBottom < AUTO_SCROLL_EDGE_IN && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1) {
    return AUTO_SCROLL_MAX_SPEED * ramp(fromBottom);
  }
  return 0;
}

/** C-60: one frame of the drag auto-scroll over the container viewport; reschedules itself until the drag ends. */
export function autoScrollTick(sys: InventoryUI, now: number): void {
  sys.autoScrollRaf = null;
  const d = sys.drag;
  if (!d || !d.started) { stopAutoScroll(sys); return; }
  const dt = sys.autoScrollLast > 0 ? Math.min(0.05, Math.max(0, (now - sys.autoScrollLast) / 1000)) : 0;
  sys.autoScrollLast = now;
  const scroller = sys.containerScroll;
  const v = autoScrollSpeed(scroller, d.lastX, d.lastY);
  if (v !== 0 && dt > 0) {
    // scrollTop snaps to whole px — bank the fraction so a slow ramp still moves
    sys.autoScrollAcc += v * dt;
    const step = Math.trunc(sys.autoScrollAcc);
    if (step !== 0) {
      sys.autoScrollAcc -= step;
      scroller.scrollTop += step;
      sys.updateDragTarget(d.lastX, d.lastY);   // the viewport's `scroll` event does it too, a frame later
    }
  } else {
    sys.autoScrollAcc = 0;
  }
  sys.autoScrollRaf = requestAnimationFrame((t) => autoScrollTick(sys, t));
}

export function startAutoScroll(sys: InventoryUI): void {
  if (sys.autoScrollRaf !== null || typeof requestAnimationFrame !== 'function') return;
  sys.autoScrollLast = 0;
  sys.autoScrollAcc = 0;
  sys.autoScrollRaf = requestAnimationFrame((t) => autoScrollTick(sys, t));
}

export function stopAutoScroll(sys: InventoryUI): void {
  if (sys.autoScrollRaf !== null) cancelAnimationFrame(sys.autoScrollRaf);
  sys.autoScrollRaf = null;
  sys.autoScrollLast = 0;
  sys.autoScrollAcc = 0;
}

export function startDrag(sys: InventoryUI, d: DragState): void {
  d.started = true;
  sys.tooltip.hide();
  sys.root?.classList.add('is-dragging');
  startAutoScroll(sys);   // 2026-09-11 (C-60): idles unless the container viewport overflows and the pointer nears an edge
  if (d.catalog) {
    // catalog: the source tile stays as it is (infinite stock); no world drop, no wheel targets
    sys.root?.classList.add('is-catalog-drag');
    sys.rebuildGhost(d);
    sys.sys.sfx('ui_pickup');
    return;
  }
  // a stim / grenade from any grid — 가방 · 상자 · 창고 (2026-09-10) — or a wheel cell: light the usable cells
  // 2026-09-12: a Shift / Ctrl split may go onto the wheel too (new stack or merge), so it lights the cells as well
  if (isQuickUsable(d.def) && d.from.kind === 'grid') sys.root?.classList.add('is-quick-drag');
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
  sys.pouchView.hideHighlight();   // A-15
  for (const sv of sys.slots.values()) sv.el.classList.remove('is-target-ok', 'is-target-bad');
  d.target = null;
  sys.dropZone.classList.remove('is-hot');
  sys.clearSocketTarget();
  for (const c of sys.quickCells) c.el.classList.remove('is-target-ok', 'is-target-bad', 'is-target-swap');

  if (d.catalog) { sys.updateCatalogTarget(d, px, py); return; }

  // 2026-09-13: the 무한 상자 layout hides 장착 장비 · 퀵슬롯 · 주머니 (`.is-catalog`) — none of them is a target then
  const catalogLayout = sys.catalogView.isOpen;

  // quick-use wheel cells (any drag: non-usable items light red)
  const cell = catalogLayout ? null : sys.quickCellAt(px, py);
  if (cell) {
    d.target = { kind: 'quick', index: cell.index };
    const pv = sys.preview(d, d.target);
    cell.el.classList.add(pv === 'bad' ? 'is-target-bad' : pv === 'swap' ? 'is-target-swap' : 'is-target-ok');
    return;
  }
  // 2026-09-10: a wheel-cell drag may also aim at a grid (가방 · 상자 · 창고) or an equipment slot — 퀵슬롯에서
  // 곧장 상자로. Only when it lands on **no** target at all does the release clear the slot (see `finishDrag`).

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
  for (const sv of catalogLayout ? [] : sys.slots.values()) {
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
  if (tile.closest('.inv-grid-pouch')) return { uid, loc: { kind: 'grid', grid: 'pouch' } };
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
  sys.pouchView.setSocketTarget(null, null);   // A-15 (주머니에 무기는 안 들어가지만 정리는 같이 한다)
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
  if (d.held) {
    // 2026-09-12: a held remainder drops on the release of the *next* press (armed in `handleHeldDown`)
    if (e.type === 'pointercancel') { sys.cancelDrag(); return; }
    if (!d.armed || e.button !== 0) return;
    d.armed = false;
    d.lastX = e.clientX; d.lastY = e.clientY;
    sys.updateDragTarget(e.clientX, e.clientY);
    sys.suppressClicksUntil = performance.now() + CLICK_SUPPRESS_MS;
  } else if (e.button !== 0 && e.type === 'pointerup') return;
  removeDragListeners(sys);
  sys.drag = null;

  if (!d.started) return; // plain click
  sys.endDragVisuals(d);

  // held remainder released over nothing: it is already in its source stack — just let go
  if (d.held && !d.target && !d.catalog) { sys.sys.sfx('ui_drop'); return; }

  // catalog instance: only a grid cell / slot takes it; anywhere else simply discards the fresh instance
  if (d.catalog) {
    if (!d.target) { sys.sys.sfx('ui_error'); return; }
    const r = sys.sys.dropFromCatalog(d.item, d.target);
    if (r === 'ok') sys.sys.sfx(d.target.kind === 'grid' ? 'ui_drop' : 'ui_equip');
    else if (r === 'fail') { sys.sys.sfx('ui_error'); sys.catalogView.shake(d.def.id); }
    return;
  }

  // dragged out of a wheel cell onto nothing: clear the slot (the stack returns to the bag).
  // 2026-09-10: a wheel drag that *does* have a target falls through to the normal drop below — another cell
  // re-orders the wheel, a grid cell moves the stack there (상자 · 창고 포함).
  if (d.quickFrom !== null && !d.target) {
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
  const target = d.target;
  // 2026-09-12: read the merge verdict and the source size **before** the drop — the remainder is what did not move
  const pv = sys.preview(d, target);
  const before = sys.sys.findItem(d.uid, d.from)?.qty ?? 0;
  const r = d.qty !== null ? sys.sys.dropPartial(d.uid, d.from, d.qty, target) : sys.sys.drop(d.uid, d.from, target);
  if (r === 'ok') sys.sys.sfx(target.kind === 'grid' ? 'ui_drop' : 'ui_equip');
  else if (r === 'fail') { sys.sys.sfx('ui_error'); sys.shake(d.from, d.uid); }
  if (r !== 'ok' || pv !== 'merge') return;
  const src = sys.sys.findItem(d.uid, d.from);
  if (!src || src.qty <= 0) return;
  const moved = before - src.qty;
  const left = d.qty !== null ? d.qty - moved : src.qty;
  if (left > 0) holdRemainder(sys, d, left >= src.qty ? null : left, e.clientX, e.clientY);
  }

export function endDragVisuals(sys: InventoryUI, d: DragState): void {
  stopAutoScroll(sys);
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
  sys.pouchView.setDragging(null);   // A-15
  if (d.qty !== null && d.from.kind === 'grid') sys.viewOf(d.from.grid).markSplitSource(d.uid, null);
  sys.bagView.hideHighlight();
  sys.containerView.hideHighlight();
  sys.stashView.hideHighlight();
  sys.pouchView.hideHighlight();
  sys.clearSocketTarget();
  for (const sv of sys.slots.values()) {
    sv.el.classList.remove('is-target-ok', 'is-target-bad');
    sv.tile?.classList.remove('is-dragging');
  }
  }

export function cancelDrag(sys: InventoryUI): void {
  stopAutoScroll(sys);
  const d = sys.drag;
  if (!d) return;
  removeDragListeners(sys);
  sys.drag = null;
  if (d.started) sys.endDragVisuals(d);
  }
