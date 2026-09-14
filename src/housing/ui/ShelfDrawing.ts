import type { ShelfMedium } from '@/shared';
import { SHELF_SLOTS, SHELF_TIERS, SHELF_TIER_COLS, shelfSlotsPerTier } from '@/shared';
import { clear, el, setText, toggleClass } from './dom';

/**
 * **그려진 선반** (2026-09-13) — 서재 보관함 화면 왼쪽 카드의 가구 그림. 책장 · 디스크 전시대 · 레코드랙 · 게임 디스크 전시대가 같은 뼈대를
 * 쓰고 매체가 모양만 바꾼다 (전부 CSS 로 그린다 — 이미지 파일 없음, `housing.css` 의 `.lib-*`):
 *
 * - 책장 = 나무 틀 + 선반 4층 × (5칸 × 2줄) = 40권, 꽂힌 칸 = 시리즈 색 **책등**(글리프 + 세로쓰기 시리즈 이름)
 * - 디스크 전시대 = 금속 틀 + 아크릴 턱 3층 × 4칸, 꽂힌 칸 = **디스크 케이스**(색 디스크 · 띠)
 * - 레코드랙 = 검은 랙 2층 × 4칸, 꽂힌 칸 = **레코드 슬리브**(뒤로 삐져나온 LP)
 * - 게임 디스크 전시대 (2026-09-13) = 짙은 남색 틀 3층 × 4칸, 꽂힌 칸 = 윗단이 디스크 테마 색인 **게임 케이스**
 *
 * **2026-09-14 (층당 여러 줄, 사용자 결정)**: 층 수 `SHELF_TIERS` · 한 줄의 칸 수 `SHELF_TIER_COLS` · 한 층의 칸 수
 * `shelfSlotsPerTier` 가 전부 계약(`shared/housing`)에 있고 이 파일은 그대로 그린다 — 한 층(`.lib-tier`, 아래가 두꺼운
 * 선반 판)이 `.lib-row` 를 필요한 만큼 품고, 한 줄이 `SHELF_TIER_COLS` 열 격자다. 열 수는 `.lib-case` 의
 * `--lib-cols` 로 CSS 에 넘어간다 (칸 크기 · 글자 크기는 CSS 가 매체별로 정한다).
 * ⚠ 층은 **표시**일 뿐이다 — 저장되는 것은 `slot` 인덱스 하나이고 번호는 0 부터 이어진다.
 *
 * 2026-09-13 (서재 시리즈): 꽂힌 칸에 **권 번호 배지**(`.lib-vol`, `II` — 단편이면 숨김)가 붙고, 그 시리즈를 전권 모았으면 `.is-full`
 * (초록 윤곽)이다. 색 `--rc` 는 부르는 쪽이 고른다 (시리즈 색 · 게임 디스크 테마 색).
 *
 * 칸 번호는 **위 → 아래, 왼 → 오른쪽**이고 3D 모델(`hub/interiors/Furniture` 의 `bookshelf`)과 같은 순서다.
 * 빈 칸은 같은 모양의 흐린 점선 윤곽이다. `.lib-slot[data-slot]` 이 드롭 대상이고(TradeGrids 가 `.is-over` 를 붙인다),
 * 꽂힌 칸의 `.lib-item` 에는 `data-item-tip` + `data-def-id` 가 붙어 `ui/hud/ItemTip` 이 아이템 카드를 띄운다.
 * 이 파일은 상태도 리스너도 없다 — 칠하기는 `paintShelfSlot`, 규칙은 `parts/Library` 다.
 */

/**
 * 한 줄에 그리는 칸 수. 2026-09-14 부터 매체마다 다르다 — 값의 원본은 계약의 `SHELF_TIER_COLS` 다.
 * @deprecated 옛 고정값 2 를 읽던 곳을 위해 남긴다 (부르는 곳 없음).
 */
export const SHELF_COLS = 2;

export interface ShelfSlotView {
  readonly slot: number;
  /** `.lib-slot[data-slot]` — the drop target; `.is-filled` while something is shelved, `.is-full` while its series is complete. */
  readonly root: HTMLElement;
  /** `.lib-item` — the spine / case / sleeve (a dashed outline of the same shape while empty). */
  readonly item: HTMLElement;
  readonly glyph: HTMLElement;
  readonly label: HTMLElement;
  /** `.lib-vol` — the volume badge (`II`), hidden for a one-shot or an empty slot. */
  readonly vol: HTMLElement;
}

export interface ShelfDrawing {
  readonly root: HTMLElement;
  readonly medium: ShelfMedium;
  readonly slots: readonly ShelfSlotView[];
}

/** What one slot shows. `defId` null = empty (the other fields are ignored except `line`). */
export interface ShelfSlotPaint {
  defId: string | null;
  /** Tint (`--rc`) — the series colour, or a game disc's theme colour. */
  color: string;
  glyph: string;
  /** Short readable name on the item (the series name / the game's name). */
  label: string;
  /** The slot's info line (shown under the shelf while the slot is hovered). 2026-09-14: **빈 칸은 빈 문자열**이다 — 빈 칸 호버는 아무것도 말하지 않는다. */
  line: string;
  /** 2026-09-13: roman volume number (`II`) — empty / omitted hides the badge. */
  volume?: string;
  /** 2026-09-13: the series is complete (every volume shelved in a running holder). */
  full?: boolean;
}

/** (Re)draw the case for `medium` into `host` (emptied first). */
export function buildShelfDrawing(host: HTMLElement, medium: ShelfMedium): ShelfDrawing {
  clear(host);
  const root = el('div', { cls: 'lib-case', attrs: { 'data-medium': medium }, parent: host });
  const count = SHELF_SLOTS[medium];
  const cols = Math.max(1, SHELF_TIER_COLS[medium]);
  const perTier = shelfSlotsPerTier(medium);
  const tiers = Math.max(1, SHELF_TIERS[medium]);
  root.style.setProperty('--lib-cols', String(cols));
  const slots: ShelfSlotView[] = [];
  for (let t = 0; t < tiers; t++) {
    const tier = el('div', { cls: 'lib-tier', parent: root });
    const rowsInTier = Math.max(1, Math.ceil(perTier / cols));
    for (let r = 0; r < rowsInTier; r++) {
      const row = el('div', { cls: 'lib-row', parent: tier });
      for (let c = 0; c < cols; c++) {
        const slot = t * perTier + r * cols + c;
        // 빈 격자 칸: 층에 배정된 칸을 넘었거나(마지막 층이 짧다) 전체 칸 수를 넘었다 — 자리는 지키고 드롭 대상이 아니다
        if (slot >= count || r * cols + c >= perTier) { el('div', { cls: 'lib-slot is-void', parent: row }); continue; }
        const slotEl = el('div', { cls: 'lib-slot', attrs: { 'data-slot': String(slot) }, parent: row });
        el('span', { cls: 'lib-num', text: String(slot + 1), parent: slotEl });
        const item = el('div', { cls: 'lib-item', parent: slotEl });
        el('i', { cls: 'lib-deco', parent: item });              // disc in its case · LP behind its sleeve · disc in a game case · (book: none)
        const face = el('div', { cls: 'lib-face', parent: item });
        const glyph = el('span', { cls: 'lib-glyph', text: '', parent: face });
        const label = el('span', { cls: 'lib-label', text: '', parent: face });
        const vol = el('span', { cls: 'lib-vol', text: '', parent: item });
        vol.hidden = true;
        slots.push({ slot, root: slotEl, item, glyph, label, vol });
      }
    }
  }
  el('div', { cls: 'lib-plinth', parent: root });
  return { root, medium, slots };
}

/** Paint one slot — only what changed is written (a refresh per inventory event must stay cheap). */
export function paintShelfSlot(v: ShelfSlotView, p: ShelfSlotPaint): void {
  const filled = p.defId !== null;
  toggleClass(v.root, 'is-filled', filled);
  toggleClass(v.root, 'is-full', filled && p.full === true);
  if (filled) {
    if (v.item.dataset.defId !== p.defId) { v.item.dataset.itemTip = ''; v.item.dataset.defId = p.defId!; }
    if (v.item.dataset.rc !== p.color) { v.item.dataset.rc = p.color; v.item.style.setProperty('--rc', p.color); }
  } else if (v.item.dataset.defId !== undefined) {
    delete v.item.dataset.itemTip;
    delete v.item.dataset.defId;
  }
  setText(v.glyph, filled ? p.glyph : '');
  setText(v.label, filled ? p.label : '');
  const vol = filled ? p.volume ?? '' : '';
  setText(v.vol, vol);
  if (v.vol.hidden !== !vol) v.vol.hidden = !vol;
  if (v.root.dataset.line !== p.line) v.root.dataset.line = p.line;
}
