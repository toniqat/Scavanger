/**
 * src/inventory/ui/GridTools.ts — 가방 · 창고 머리의 **정렬 버튼**과 **필터 드롭다운** (2026-09-12 → 2026-09-15 2차).
 *
 * Tab 인벤토리(`InventoryUI`)와 다른 폴더 화면에 끼우는 격자(`TradeGrids`)가 같은 DOM · 같은 클래스를 쓴다 — 두 화면에서
 * 가방이 다르게 보이면 안 된다는 사용자 요청 그대로다. 상태는 들고 있지 않다: 누가 어떤 항목을 골랐는지는 부른 쪽이 안다.
 *
 * **2026-09-15 2차 (사용자 결정) — 필터 칩 줄은 없어졌다.** 열 개짜리 글리프 칩 줄(`.inv-filters` · `.inv-filter-chip`)은
 * 격자 위 한 줄을 통째로 먹으면서도 어떤 칩이 무엇인지 글자로 말하지 못했다. 이제 필터는 **정렬 버튼 오른쪽의 드롭다운
 * 하나**(`buildFilterSelect`)이고, 항목의 원본은 그대로 `model.FILTER_GROUPS` 다.
 *
 * 드롭다운은 **네이티브 `<select>`** 다 — 일부러 그렇게 골랐다. 직접 그린 목록은 ① 스크롤 상자(`.tg-gridwrap` ·
 * `.inv-stash-scroll`)에 잘리지 않으려면 `position: fixed` 로 띄워야 하고, ② 바깥 클릭 · Escape 를 스스로 먹어야 하는데
 * (「가장 안쪽 팝업이 Escape 를 삼킨다」) 그 Escape 는 인벤토리 창을 닫는 키와 같은 키다. 네이티브 목록은 셋 다 브라우저가
 * 한다 (Escape 는 목록만 닫고 페이지로 내려오지 않는다). `color-scheme: dark` 라 목록도 어두운 UI 색으로 그려진다.
 */
import { FILTER_GROUPS, type FilterGroupId } from '../model';

/**
 * 필터 컨트롤의 공개 모양 — 부른 쪽은 `el` 을 붙이고 `set(id)` 로 표시만 맞춘다.
 * (2026-09-15 2차 이전 이름 `FilterChips` 의 자리이고 모양이 같다.)
 */
export interface FilterControl {
  readonly el: HTMLElement;
  /** Show `id` as the current pick (the caller keeps the state). */
  set(id: FilterGroupId): void;
}

/**
 * **필터 드롭다운** (2026-09-15 2차, 사용자 결정). 정렬 버튼 오른쪽에 서는 한 칸짜리 컨트롤이고 목록은
 * `FILTER_GROUPS` 순서 그대로다 — 글리프 + 한국어 이름을 함께 적으므로 `title` 툴팁에 기대지 않는다.
 *
 * `change` 만 듣는다: 키보드로 고르든 마우스로 고르든 같은 이벤트다. 열려 있는 목록 위에서 눌린 포인터는 창의 드래그
 * 로직에 닿지 않으므로(브라우저가 팝업을 먹는다) 따로 막을 것이 없다.
 */
export function buildFilterSelect(onPick: (id: FilterGroupId) => void): FilterControl {
  const el = document.createElement('div');
  el.className = 'inv-filter-sel';
  const sel = document.createElement('select');
  sel.className = 'inv-filter-select';
  sel.title = '필터';
  sel.setAttribute('aria-label', '필터');
  for (const g of FILTER_GROUPS) {
    const o = document.createElement('option');
    o.value = g.id;
    o.textContent = `${g.icon} ${g.label}`;
    o.dataset.filter = g.id;
    sel.appendChild(o);
  }
  sel.value = 'all';
  /** 「전체」가 아니면 컨트롤이 켜진 것처럼 보인다 — 어느 격자가 걸러져 있는지 한눈에. */
  const mark = (id: FilterGroupId): void => { el.classList.toggle('is-on', id !== 'all'); };
  sel.addEventListener('change', (e) => {
    e.stopPropagation();
    const id = sel.value as FilterGroupId;
    mark(id);
    onPick(id);
  });
  // the window's own pointer handlers must not read a click on the control as a drag / a background dismissal
  sel.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.appendChild(sel);
  return {
    el,
    set(id) { if (sel.value !== id) sel.value = id; mark(id); },
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
