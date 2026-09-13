import type { ShelfMedium } from '@/shared';
import { SHELF_SLOTS } from '@/shared';
import { clear, el, setText, toggleClass } from './dom';

/**
 * **그려진 선반** (2026-09-13) — 서재 보관함 화면 왼쪽 카드의 가구 그림. 책장 · 디스크 전시대 · 레코드랙이 같은 뼈대를 쓰고
 * 매체가 모양만 바꾼다 (전부 CSS 로 그린다 — 이미지 파일 없음, `housing.css` 의 `.lib-*`):
 *
 * - 책장 = 나무 틀 + 선반 4단 × 2칸, 꽂힌 칸 = 희귀도 색 **책등**(글리프 + 세로쓰기 숙련 이름)
 * - 디스크 전시대 = 금속 틀 + 아크릴 턱 3단 × 2칸, 꽂힌 칸 = **디스크 케이스**(희귀도 색 디스크 · 띠)
 * - 레코드랙 = 검은 랙 2단 × 2칸, 꽂힌 칸 = **레코드 슬리브**(뒤로 삐져나온 LP)
 *
 * 칸 번호는 **위 → 아래, 왼 → 오른쪽**이고 3D 모델(`hub/interiors/Furniture` 의 `bookshelf`)과 같은 순서다.
 * 빈 칸은 같은 모양의 흐린 점선 윤곽이다. `.lib-slot[data-slot]` 이 드롭 대상이고(TradeGrids 가 `.is-over` 를 붙인다),
 * 꽂힌 칸의 `.lib-item` 에는 `data-item-tip` + `data-def-id` 가 붙어 `ui/hud/ItemTip` 이 아이템 카드를 띄운다.
 * 이 파일은 상태도 리스너도 없다 — 칠하기는 `paintShelfSlot`, 규칙은 `parts/Library` 다.
 */

/** Slots per shelf row in every 서재 보관함 (책장 4 × 2 · 디스크 전시대 3 × 2 · 레코드랙 2 × 2). */
export const SHELF_COLS = 2;

export interface ShelfSlotView {
  readonly slot: number;
  /** `.lib-slot[data-slot]` — the drop target; `.is-filled` while something is shelved. */
  readonly root: HTMLElement;
  /** `.lib-item` — the spine / case / sleeve (a dashed outline of the same shape while empty). */
  readonly item: HTMLElement;
  readonly glyph: HTMLElement;
  readonly label: HTMLElement;
}

export interface ShelfDrawing {
  readonly root: HTMLElement;
  readonly medium: ShelfMedium;
  readonly slots: readonly ShelfSlotView[];
}

/** What one slot shows. `defId` null = empty (the other fields are ignored except `line`). */
export interface ShelfSlotPaint {
  defId: string | null;
  /** Rarity colour (`RARITY_COLORS`) — tints the spine / disc / sleeve. */
  color: string;
  glyph: string;
  /** Short readable name on the item (the skill it teaches). */
  label: string;
  /** The slot's info line (shown under the shelf while the slot is hovered). */
  line: string;
}

/** (Re)draw the case for `medium` into `host` (emptied first). */
export function buildShelfDrawing(host: HTMLElement, medium: ShelfMedium): ShelfDrawing {
  clear(host);
  const root = el('div', { cls: 'lib-case', attrs: { 'data-medium': medium }, parent: host });
  const count = SHELF_SLOTS[medium];
  const rows = Math.ceil(count / SHELF_COLS);
  const slots: ShelfSlotView[] = [];
  for (let r = 0; r < rows; r++) {
    const tier = el('div', { cls: 'lib-tier', parent: root });
    for (let c = 0; c < SHELF_COLS; c++) {
      const slot = r * SHELF_COLS + c;
      if (slot >= count) { el('div', { cls: 'lib-slot is-void', parent: tier }); continue; }   // an odd slot count keeps the grid
      const s = String(slot);
      const slotEl = el('div', { cls: 'lib-slot', attrs: { 'data-slot': s }, parent: tier });
      el('span', { cls: 'lib-num', text: String(slot + 1), parent: slotEl });
      const item = el('div', { cls: 'lib-item', parent: slotEl });
      el('i', { cls: 'lib-deco', parent: item });                // disc in its case · LP behind its sleeve · (book: none)
      const face = el('div', { cls: 'lib-face', parent: item });
      const glyph = el('span', { cls: 'lib-glyph', text: '', parent: face });
      const label = el('span', { cls: 'lib-label', text: '', parent: face });
      slots.push({ slot, root: slotEl, item, glyph, label });
    }
  }
  el('div', { cls: 'lib-plinth', parent: root });
  return { root, medium, slots };
}

/** Paint one slot — only what changed is written (a refresh per inventory event must stay cheap). */
export function paintShelfSlot(v: ShelfSlotView, p: ShelfSlotPaint): void {
  const filled = p.defId !== null;
  toggleClass(v.root, 'is-filled', filled);
  if (filled) {
    if (v.item.dataset.defId !== p.defId) { v.item.dataset.itemTip = ''; v.item.dataset.defId = p.defId!; }
    if (v.item.dataset.rc !== p.color) { v.item.dataset.rc = p.color; v.item.style.setProperty('--rc', p.color); }
  } else if (v.item.dataset.defId !== undefined) {
    delete v.item.dataset.itemTip;
    delete v.item.dataset.defId;
  }
  setText(v.glyph, filled ? p.glyph : '');
  setText(v.label, filled ? p.label : '');
  if (v.root.dataset.line !== p.line) v.root.dataset.line = p.line;
}
