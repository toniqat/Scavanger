import type { ShelfMedium } from '@/shared';
import { SHELF_SLOTS, SHELF_TIERS, SHELF_TIER_COLS, shelfSlotsPerTier } from '@/shared';
import { clear, el, setText, toggleClass } from './dom';

/**
 * **그려진 선반** (2026-09-13) — 서재 보관함 화면 왼쪽 카드의 가구 그림. 책장 · 디스크 전시대 · 레코드랙 · 게임 디스크 전시대가 같은 뼈대를
 * 쓰고 매체가 모양만 바꾼다 (전부 CSS 로 그린다 — 이미지 파일 없음, `housing.css` 의 `.lib-*`).
 *
 * **2026-09-16 (사용자 결정 — 칸은 아이템 격자 칸이다)**: 한 칸에 그리던 **전용 그림**(책등 · 디스크 케이스 ·
 * 레코드 슬리브 · 게임 케이스 = `.lib-deco` · `.lib-face` · `.lib-glyph` · `.lib-label`)을 걷어내고, 꽂힌 칸에는
 * **가방에서 보던 아이템 타일 그대로**(`ui/ItemTile.buildStationItemTile`)가 선다. 수량 숫자는 그리지 않는다.
 * 가구(틀 · 층 판 · 구분막 · 받침)는 그대로다 — 바뀐 것은 「칸 **안**에 무엇이 서는가」뿐이다.
 * 타일은 `paintShelfSlot` 에 넘어온 `buildTile` 이 만든다 — 이 파일은 여전히 `ctx` 를 모른다.
 *
 * **2026-09-14 (층당 여러 줄, 사용자 결정)**: 층 수 `SHELF_TIERS` · 한 줄의 칸 수 `SHELF_TIER_COLS` · 한 층의 칸 수
 * `shelfSlotsPerTier` 가 전부 계약(`shared/housing`)에 있고 이 파일은 그대로 그린다 — 한 층(`.lib-tier`, 아래가 두꺼운
 * 선반 판)이 `.lib-row` 를 필요한 만큼 품고, 한 줄이 `SHELF_TIER_COLS` 열 격자다. 열 수는 `.lib-case` 의
 * `--lib-cols` 로 CSS 에 넘어간다.
 * ⚠ 층은 **표시**일 뿐이다 — 저장되는 것은 `slot` 인덱스 하나이고 번호는 0 부터 이어진다.
 *
 * **2026-09-15 (구분막 · 칸 번호 제거, 사용자 결정)**:
 * - 칸의 **숫자 표기(`.lib-num`)를 없앴다.** 꽂는 자리는 그림이 말하고 번호는 어차피 저장값일 뿐이다.
 * - 한 줄의 **가운데에 구분막**이 선다. 새 자식을 만들지 않고 가운데 오른쪽 칸에 `.is-div` 를 붙여 CSS 가 그 칸의
 *   왼쪽에 판을 세운다 — `.lib-row` 의 자식은 여전히 **칸뿐**이라 열 수를 세는 쪽(스모크 · CSS 격자)이 안 흔들린다.
 *   구분막 자리는 `floor(cols / 2)` 이고, 열이 하나면 구분막이 없다.
 *
 * 2026-09-13 (서재 시리즈): 꽂힌 칸에 **권 번호 배지**(`.lib-vol`, `II` — 단편이면 숨김)가 붙고, 그 시리즈를 전권 모았으면 `.is-full`
 * (초록 윤곽)이다.
 *
 * 칸 번호는 **위 → 아래, 왼 → 오른쪽**이고 3D 모델(`hub/interiors/Furniture` 의 `bookshelf`)과 같은 순서다.
 * 빈 칸은 인벤토리의 빈 칸처럼 점선 상자다. `.lib-slot[data-slot]` 이 드롭 대상이고(TradeGrids 가 `.is-over` 를 붙인다),
 * 아이템 카드(`ui/hud/ItemTip`)는 타일이 `data-item-tip` 을 달고 온다.
 * 이 파일은 상태도 리스너도 없다 — 칠하기는 `paintShelfSlot`, 규칙은 `parts/Library` 다.
 */

/**
 * 한 줄에 그리는 칸 수. 2026-09-14 부터 매체마다 다르다 — 값의 원본은 계약의 `SHELF_TIER_COLS` 다.
 * @deprecated 옛 고정값 2 를 읽던 곳을 위해 남긴다 (부르는 곳 없음).
 */
export const SHELF_COLS = 2;

/**
 * **한 칸의 상자** (px) — 가구 그림에서 한 칸이 차지하는 자리다 (2026-09-16 부터 JS 가 원본이고 CSS 는
 * `--lib-item-w` / `--lib-item-h` 로 받는다: 아이템 타일의 칸 크기를 같은 값에서 유도해야 해서 두 곳에 둘 수 없다).
 * 값은 2026-09-15 까지 CSS 가 쓰던 것 그대로이고, 매체의 아이템 발자국(책 1×2 · 디스크 2×2 · 레코드 3×3 ·
 * 게임 1×2)이 이 상자 안에 통째로 들어간다 — 배치 상수다.
 */
const SHELF_SLOT_BOX: Readonly<Record<ShelfMedium, { width: number; height: number }>> = {
  book: { width: 44, height: 86 },
  disc: { width: 58, height: 58 },
  record: { width: 70, height: 70 },
  game: { width: 46, height: 64 },
};

/** 그 매체의 한 칸 상자 (px) — 부르는 쪽이 여기에 맞는 타일 칸 크기를 잰다 (`ui/ItemTile.cellToFit`). */
export function shelfSlotBox(medium: ShelfMedium): { width: number; height: number } {
  return SHELF_SLOT_BOX[medium] ?? SHELF_SLOT_BOX.book;
}

export interface ShelfSlotView {
  readonly slot: number;
  /** `.lib-slot[data-slot]` — the drop target; `.is-filled` while something is shelved, `.is-full` while its series is complete. */
  readonly root: HTMLElement;
  /** `.lib-item` — the cell box: the item tile while filled, a dashed outline while empty. */
  readonly item: HTMLElement;
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
  const box = shelfSlotBox(medium);
  root.style.setProperty('--lib-cols', String(cols));
  root.style.setProperty('--lib-item-w', `${box.width}px`);
  root.style.setProperty('--lib-item-h', `${box.height}px`);
  // 2026-09-15: 구분막이 서는 열 (그 칸의 **왼쪽**에 판이 선다). 열이 하나뿐이면 구분막이 없다.
  const divAt = cols >= 2 ? Math.floor(cols / 2) : -1;
  const slots: ShelfSlotView[] = [];
  for (let t = 0; t < tiers; t++) {
    const tier = el('div', { cls: 'lib-tier', parent: root });
    const rowsInTier = Math.max(1, Math.ceil(perTier / cols));
    for (let r = 0; r < rowsInTier; r++) {
      const row = el('div', { cls: 'lib-row', parent: tier });
      for (let c = 0; c < cols; c++) {
        const slot = t * perTier + r * cols + c;
        const div = c === divAt ? ' is-div' : '';
        // 빈 격자 칸: 층에 배정된 칸을 넘었거나(마지막 층이 짧다) 전체 칸 수를 넘었다 — 자리는 지키고 드롭 대상이 아니다
        if (slot >= count || r * cols + c >= perTier) { el('div', { cls: `lib-slot is-void${div}`, parent: row }); continue; }
        const slotEl = el('div', { cls: `lib-slot${div}`, attrs: { 'data-slot': String(slot) }, parent: row });
        const item = el('div', { cls: 'lib-item', parent: slotEl });
        const vol = el('span', { cls: 'lib-vol', text: '', parent: slotEl });
        vol.hidden = true;
        slots.push({ slot, root: slotEl, item, vol });
      }
    }
  }
  el('div', { cls: 'lib-plinth', parent: root });
  return { root, medium, slots };
}

/**
 * Paint one slot — only what changed is written (a refresh per inventory event must stay cheap).
 * `buildTile` makes the inventory tile for a def id; it is only called when the slot's item **changed**
 * (`data-def-id` on the cell box is the memo), so a 1 Hz refresh never rebuilds a tile.
 */
export function paintShelfSlot(v: ShelfSlotView, p: ShelfSlotPaint, buildTile: (defId: string) => HTMLElement): void {
  const filled = p.defId !== null;
  toggleClass(v.root, 'is-filled', filled);
  toggleClass(v.root, 'is-full', filled && p.full === true);
  if (v.item.dataset.defId !== (p.defId ?? undefined)) {
    clear(v.item);
    if (filled) {
      // `data-item-tip` + `data-def-id` 는 칸 상자에도 그대로 둔다 (타일이 스스로 달고 오지만, 「꽂힌 칸이
      // 아이템 카드를 띄운다」는 이 요소의 오랜 계약이고 스모크도 여기를 본다 — `scripts/smoke-library.mjs`)
      v.item.dataset.itemTip = '';
      v.item.dataset.defId = p.defId!;
      v.item.appendChild(buildTile(p.defId!));
    } else {
      delete v.item.dataset.itemTip;
      delete v.item.dataset.defId;
    }
  }
  const vol = filled ? p.volume ?? '' : '';
  setText(v.vol, vol);
  if (v.vol.hidden !== !vol) v.vol.hidden = !vol;
  if (v.root.dataset.line !== p.line) v.root.dataset.line = p.line;
}
