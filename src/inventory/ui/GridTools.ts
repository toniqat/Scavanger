/**
 * src/inventory/ui/GridTools.ts — 가방 · 창고 머리의 **정렬 버튼**과 **필터 칩 줄** (2026-09-12).
 *
 * Tab 인벤토리(`InventoryUI`)와 다른 폴더 화면에 끼우는 격자(`TradeGrids`)가 같은 DOM · 같은 클래스를 쓴다 — 두 화면에서
 * 가방이 다르게 보이면 안 된다는 사용자 요청 그대로다. 상태는 들고 있지 않다: 누가 어떤 칩을 켰는지는 부른 쪽이 안다.
 */
import { FILTER_GROUPS, type FilterGroupId } from '../model';

export interface FilterChips {
  readonly el: HTMLElement;
  /** Light the chip for `id` (the caller keeps the state). */
  set(id: FilterGroupId): void;
}

/** One row of compact icon chips; `title` carries the Korean name. */
export function buildFilterChips(onPick: (id: FilterGroupId) => void): FilterChips {
  const el = document.createElement('div');
  el.className = 'inv-filters';
  const chips = new Map<FilterGroupId, HTMLButtonElement>();
  for (const g of FILTER_GROUPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `inv-filter-chip${g.id === 'all' ? ' is-on' : ''}`;
    b.dataset.filter = g.id;
    b.title = g.label;
    b.setAttribute('aria-label', g.label);
    b.textContent = g.icon;
    b.addEventListener('click', (e) => { e.stopPropagation(); onPick(g.id); });
    chips.set(g.id, b);
    el.appendChild(b);
  }
  return {
    el,
    set(id) { for (const [cid, b] of chips) b.classList.toggle('is-on', cid === id); },
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
