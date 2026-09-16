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
 * **2026-09-16 (사용자 결정) — 목록은 이제 우리가 그린다.** 여기 있던 네이티브 `<select>` 는 게임 안에 하나 남은
 * OS 위젯이었고, 펼친 목록의 폰트 · 모서리 · 강조색 · 스크롤바가 게임 UI 와 따로 놀았다. 네이티브를 골랐던 이유
 * 셋(① 스크롤 상자 `.tg-gridwrap` · `.inv-stash-scroll` 에 잘림, ② 바깥 클릭, ③ Escape 가 인벤토리 창까지 닫는 문제)은
 * **`src/shared/dropdown.ts` 가 전부 갚는다** — 그 파일 머리 주석이 세 항목을 하나씩 답한다. 여기서는 `FILTER_GROUPS`
 * 를 항목으로 넘기고 `is-on` 강조만 얹는다.
 *
 * 떠 있는 목록은 `document.body` 의 자식이라 창이 사라져도 저 혼자 남을 수 있다 — 그래서 `FilterControl` 은
 * `close()` · `dispose()` 를 함께 내놓고, 창을 닫는 쪽(`InventoryUI.hide` / `dispose`)이 그것을 부른다.
 */
import { buildDropdown, type DropdownControl } from '@/shared';
import { FILTER_GROUPS, type FilterGroupId } from '../model';

/**
 * 필터 컨트롤의 공개 모양 — 부른 쪽은 `el` 을 붙이고 `set(id)` 로 표시만 맞춘다.
 * (2026-09-15 2차 이전 이름 `FilterChips` 의 자리이고 모양이 같다.)
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
 * **필터 드롭다운** (2026-09-15 2차, 사용자 결정). 정렬 버튼 오른쪽에 서는 한 칸짜리 컨트롤이고 목록은
 * `FILTER_GROUPS` 순서 그대로다 — 글리프 + 한국어 이름을 함께 적으므로 `title` 툴팁에 기대지 않는다.
 *
 * 껍데기에 `.inv-filter-sel` 을 얹어 두므로 기존 선택자(`.inv-filter-sel.is-on` · `.tg-block.is-narrow` 의 폭 제한)가
 * 그대로 붙는다. 트리거 · 항목 버튼은 `shared/dropdown` 이 포인터 이벤트를 스스로 멈추므로, 창의 드래그 로직이
 * 여기서 눌린 포인터를 드래그 시작으로 읽지 않는다.
 */
export function buildFilterSelect(onPick: (id: FilterGroupId) => void): FilterControl {
  /** 「전체」가 아니면 컨트롤이 켜진 것처럼 보인다 — 어느 격자가 걸러져 있는지 한눈에. */
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
