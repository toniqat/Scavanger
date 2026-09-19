/**
 * src/inventory/ui/GridTools.ts — the **sort button** and the **filter dropdown** of the bag · stash header (2026-09-12 → 2026-09-15 2nd).
 *
 * The Tab inventory (`InventoryUI`) and the grids embedded in other folders' screens (`TradeGrids`) use the same DOM and
 * classes — the user's request that a bag not look different on two screens. It holds no state: the caller knows who picked what.
 *
 * **2026-09-15 2nd pass (user's decision) — the filter chip row is gone.** The row of ten glyph chips (`.inv-filters` ·
 * `.inv-filter-chip`) ate a whole line above the grid and still could not say in words which chip was what. The filter
 * is now **one dropdown right of the sort button** (`buildFilterSelect`), and the entries still come from `model.FILTER_GROUPS`.
 *
 * **2026-09-16 (user's decision) — the list is drawn here now.** The native `<select>` that lived here was the last OS
 * widget left in the game, and the open list's font · corners · accent colour · scrollbar played apart from the game UI.
 * The three reasons the native one was picked (① clipping in the scroll boxes `.tg-gridwrap` · `.inv-stash-scroll`, ② the
 * outside click, ③ Escape closing the inventory window too) are **all repaid by `src/shared/dropdown.ts`** — that file's
 * header comment answers the three one by one. Here `FILTER_GROUPS` is passed as the entries and only `is-on` is added.
 *
 * The floating list is a child of `document.body`, so it can be left behind alone when the window goes — which is why
 * `FilterControl` hands out `close()` · `dispose()` too, and whoever closes the window (`InventoryUI.hide` / `dispose`) calls them.
 */
import { buildDropdown, type DropdownControl } from '@/shared';
import { FILTER_GROUPS, type FilterGroupId } from '../model';

/**
 * The filter control's public shape — the caller appends `el` and only keeps the display in step with `set(id)`.
 * (It stands where `FilterChips` — the name before the 2026-09-15 2nd pass — stood, and has the same shape.)
 */
export interface FilterControl {
  readonly el: HTMLElement;
  /** Show `id` as the current pick (the caller keeps the state). */
  set(id: FilterGroupId): void;
  /** Close the floating list if it is open — the owning screen calls this when it hides. */
  close(): void;
  /** Close it and drop the control's listeners — the owning screen calls this when it is disposed. */
  dispose(): void;
}

/**
 * **The filter dropdown** (2026-09-15 2nd pass, user's decision). A one-cell control standing right of the sort button,
 * its list in `FILTER_GROUPS` order — it prints the glyph together with the Korean name, so it leans on no `title` tooltip.
 *
 * `.inv-filter-sel` is put on the shell, so the existing selectors (`.inv-filter-sel.is-on` · the width limit of
 * `.tg-block.is-narrow`) still attach. `shared/dropdown` stops pointer events on the trigger · entry buttons itself, so
 * the window's drag logic never reads a pointer pressed here as the start of a drag.
 */
export function buildFilterSelect(onPick: (id: FilterGroupId) => void): FilterControl {
  /** Anything but 「전체」 makes the control look switched on — which grid is filtered, at a glance. */
  const mark = (id: FilterGroupId): void => { dd.el.classList.toggle('is-on', id !== 'all'); };
  const dd: DropdownControl<FilterGroupId> = buildDropdown<FilterGroupId>({
    options: FILTER_GROUPS.map((g) => ({ value: g.id, label: g.label, icon: g.icon })),
    value: 'all',
    label: '필터',
    className: 'inv-filter-sel',
    onPick: (id) => { mark(id); onPick(id); },
  });
  return {
    el: dd.el,
    set(id) { dd.set(id); mark(id); },
    close: () => dd.close(),
    dispose: () => dd.dispose(),
  };
}

/** `정렬` button (auto sort). */
export function buildSortButton(onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'inv-btn inv-sort-btn';
  b.textContent = '정렬';
  b.title = '자동 정렬 — 카테고리 · 등급 · 크기 순, 같은 아이템은 합친다';
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}
