import type { ItemDef } from './types';
import { CATEGORY_ICON, RARITY_COLORS } from './labels';

/* ────────────────────────────────────────────────────────────────────────────
 * 재료 요구 칩 (Phase 8, 2026-09-06). One shared renderer for "this costs N of that" everywhere a cost is shown:
 * 가구 제작 / 시설 업그레이드 / 필드 · 작업대 제작 / 수리 / 퀘스트 납품 / 재배 씨앗.
 *
 * Before Phase 8 every folder printed its own `"폐금속 3/8"` text run. This module is the single place that turns a
 * cost line into the **thumbnail + 보유/필요 count** the design asks for, so housing/, inventory/, meta/ and ui/ all
 * render an identical chip without importing each other. It is deliberately the only DOM in `src/shared` (like
 * `labels.ts` is the only palette): it takes plain data, touches no context, and registers no listeners.
 *
 * Markup (styled by `.item-chip*` in `src/ui/styles/base.css`):
 *
 *   button|div.item-chip[.is-short][.is-free]      ← `--rc` = rarity colour, `--ic` = category colour
 *                                                  ← `data-def-id` = the item def (ui/hud/ItemTip hovers off it)
 *     div.item-chip-thumb  > span.item-chip-icon   ← ItemDef.icon glyph, tinted with ItemDef.color
 *     div.item-chip-count  > span.have + '/' + span.need
 *     div.item-chip-name                            (only when `withName`)
 *
 * `is-short` (보유 < 필요) dims the whole chip and turns the 보유 number red — the "부족하면 딤드" rule.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ItemChipOptions {
  /** Units the player owns. Omit for a plain "×N" chip with no have/need split. */
  have?: number;
  /** Units required. Omit (with `have`) to render a pure inventory count. */
  need?: number;
  /** Show the item name under the thumbnail (catalogue cards); off for inline cost rows. */
  withName?: boolean;
  /** Thumbnail edge in px. Default 34 (inline cost row); furniture cards use 28. */
  size?: number;
  /** Render as a `<button>` instead of a `<div>` (clickable seed / material pickers). */
  button?: boolean;
  /** Tooltip; defaults to the item name plus its description. */
  title?: string;
}

/** Fallback used when a def id no longer resolves (a removed item still referenced by a save). */
const UNKNOWN: Pick<ItemDef, 'name' | 'icon' | 'color' | 'category' | 'rarity'> = {
  name: '알 수 없는 아이템', icon: '?', color: '#7b828c', category: 'material', rarity: 'common',
};

/**
 * Build one cost / inventory chip. `def` may be undefined — the chip then shows a neutral placeholder rather than
 * throwing, so a stale recipe never breaks a whole panel.
 */
export function buildItemChip(def: ItemDef | undefined, opts: ItemChipOptions = {}): HTMLElement {
  const d = def ?? UNKNOWN;
  const size = opts.size ?? 34;
  const el = document.createElement(opts.button ? 'button' : 'div');
  el.className = 'item-chip';
  if (opts.button) (el as HTMLButtonElement).type = 'button';
  el.style.setProperty('--chip-size', `${size}px`);
  el.style.setProperty('--rc', RARITY_COLORS[d.rarity] ?? RARITY_COLORS.common);
  el.style.setProperty('--ic', d.color);
  // `data-def-id` is the hook the shared hover card (`ui/hud/ItemTip`) delegates on, so every chip everywhere gets
  // the same inventory-style item tooltip. A native `title` would race that card, so it is only written when a
  // caller explicitly asks for one (a chip whose def is unknown keeps the placeholder name as its title).
  if (def) el.dataset.defId = def.id;
  // 2026-09-12 (E2): 즐겨찾기 표식 — the source is registered by ui/ (`setItemChipFavoriteSource`), see the block at the end
  if (def && isItemChipFavorite(def.id)) el.classList.add(ITEM_CHIP_FAVORITE_CLASS);
  if (opts.title !== undefined) el.title = opts.title;
  else if (!def) el.title = d.name;

  const thumb = document.createElement('div');
  thumb.className = 'item-chip-thumb';
  const icon = document.createElement('span');
  icon.className = 'item-chip-icon';
  icon.textContent = d.icon || CATEGORY_ICON[d.category] || '?';
  thumb.appendChild(icon);

  const need = opts.need;
  const have = opts.have;
  if (need !== undefined || have !== undefined) {
    const count = document.createElement('div');
    count.className = 'item-chip-count';
    if (need !== undefined && have !== undefined) {
      const h = document.createElement('span');
      h.className = 'item-chip-have';
      h.textContent = String(Math.max(0, Math.floor(have)));
      const sep = document.createElement('span');
      sep.className = 'item-chip-sep';
      sep.textContent = '/';
      const n = document.createElement('span');
      n.className = 'item-chip-need';
      n.textContent = String(Math.max(0, Math.floor(need)));
      count.append(h, sep, n);
      if (have < need) el.classList.add('is-short');
    } else {
      const only = document.createElement('span');
      only.className = 'item-chip-have';
      only.textContent = `×${Math.max(0, Math.floor(need ?? have ?? 0))}`;
      count.appendChild(only);
    }
    thumb.appendChild(count);
  }
  el.appendChild(thumb);

  if (opts.withName) {
    const name = document.createElement('div');
    name.className = 'item-chip-name';
    name.textContent = d.name;
    el.appendChild(name);
  }
  return el;
}

/** One ingredient as the cost renderers take it. */
export interface ItemChipCost {
  defId: string;
  qty: number;
}

/**
 * Replace `host`'s children with one chip per ingredient. `lookup` resolves a def id (usually
 * `ctx.loot.getItemDef`), `owned` reports how many the player has (bag + stash). An empty cost renders 무료.
 * Returns true when every ingredient is covered, so callers can gate their button in the same pass.
 */
export function renderItemCost(
  host: HTMLElement,
  cost: readonly ItemChipCost[] | null | undefined,
  lookup: (defId: string) => ItemDef | undefined,
  owned: (defId: string) => number,
  opts: Omit<ItemChipOptions, 'have' | 'need'> = {},
): boolean {
  host.replaceChildren();
  host.classList.add('item-chips');
  if (!cost || cost.length === 0) {
    const free = document.createElement('span');
    free.className = 'item-chip-free';
    free.textContent = '무료';
    host.appendChild(free);
    return true;
  }
  let ok = true;
  for (const c of cost) {
    const have = owned(c.defId);
    if (have < c.qty) ok = false;
    host.appendChild(buildItemChip(lookup(c.defId), { ...opts, have, need: c.qty }));
  }
  return ok;
}

/* ══ appended: 2026-09-12 — 시설 레벨 요구 칩 ═══════════════════════════════════════════════════════════════════
 * 「발전기 Lv.2 가 필요하다」 같은 **시설 레벨 요구**를 아이템 칩 옆에 같은 줄로 그린다 (사용자 결정). 아이템과 헷갈리지
 * 않게 **가로로 긴 썸네일 + 이중 테두리**이고, 수치는 필요 갯수가 아니라 `현재 레벨/필요 레벨` 이다.
 *
 *   div.facility-chip[.is-short]                   ← `--fc` = 시설 색, `--chip-size` = 썸네일 높이 (아이템 칩과 같은 값을 넘긴다)
 *     div.facility-chip-thumb                      ← 폭은 높이의 2배 (CSS) · `border-style: double`
 *       span.facility-chip-icon                    ← 시설 글리프 (`FACILITY_GLYPH`)
 *       span.facility-chip-name                    ← 시설 이름 (`FACILITY_LABEL_KO`)
 *       div.facility-chip-count > span.facility-chip-have + '/' + span.facility-chip-need
 *
 * 스타일은 `src/ui/styles/base.css` 의 `.facility-chip*` (아이템 칩 바로 아래). 이 함수는 시설 표를 import 하지 않는다 —
 * 부르는 쪽이 이름 · 글리프 · 색을 넘긴다 (`itemChip.ts` 가 `housing.ts` 에 기대지 않게).
 */
export interface FacilityChipOptions {
  /** 썸네일 높이 px — 같은 줄의 아이템 칩 `size` 와 맞춘다. 기본 34. */
  size?: number;
  /** 네이티브 툴팁. 생략하면 `이름 Lv.need 필요 (현재 Lv.have)`. */
  title?: string;
}

export function buildFacilityChip(
  name: string, glyph: string, color: string, have: number, need: number, opts: FacilityChipOptions = {},
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'facility-chip';
  root.style.setProperty('--chip-size', `${opts.size ?? 34}px`);
  root.style.setProperty('--fc', color);
  const h = Math.max(0, Math.floor(have)), n = Math.max(0, Math.floor(need));
  if (h < n) root.classList.add('is-short');
  root.title = opts.title ?? `${name} Lv.${n} 필요 (현재 Lv.${h})`;

  const thumb = document.createElement('div');
  thumb.className = 'facility-chip-thumb';
  const icon = document.createElement('span');
  icon.className = 'facility-chip-icon';
  icon.textContent = glyph;
  const label = document.createElement('span');
  label.className = 'facility-chip-name';
  label.textContent = name;
  const count = document.createElement('div');
  count.className = 'facility-chip-count';
  const hs = document.createElement('span');
  hs.className = 'facility-chip-have';
  hs.textContent = String(h);
  const sep = document.createElement('span');
  sep.className = 'facility-chip-sep';
  sep.textContent = '/';
  const ns = document.createElement('span');
  ns.className = 'facility-chip-need';
  ns.textContent = String(n);
  count.append(hs, sep, ns);
  thumb.append(icon, label, count);
  root.appendChild(thumb);
  return root;
}

/* ══ appended: 2026-09-12 (E2) — 즐겨찾기 표식 · 우클릭 메뉴 opt-in ═══════════════════════════════════════════════
 * 아이템 즐겨찾기는 **종류(def id) 단위**이고 원본은 inventory 다 (`InventoryRef.isFavorite` · `toggleFavorite` ·
 * `inventory:favoritesChanged`, E1). 칩은 `ctx` 를 모르므로 **모듈 수준 공급자**를 하나 둔다 — ui/ 의
 * `hud/ItemFavoriteMenu` 가 부팅 때 `setItemChipFavoriteSource` 로 등록하고, `buildItemChip` 이 칩을 만들 때 물어
 * `.is-favorite` 를 붙인다 (스타일은 `ui/styles/base.css` 의 파란 사선 띠). 이미 그려진 칩은 같은 메뉴가
 * `inventory:favoritesChanged` 를 받아 DOM 에서 클래스만 고친다 — 칩을 다시 만들 필요가 없다.
 *
 * 우클릭 메뉴 「즐겨찾기 켜기 / 끄기」 는 `.item-chip[data-def-id]` 전부에 자동으로 붙는다. 칩이 아닌 요소(기업 상점의
 * 인벤토리 타일 등)는 `data-def-id` 옆에 **`ITEM_FAVORITE_MENU_ATTR`** 를 달아 옵트인한다 — `data-item-tip` 이 호버 카드에
 * 옵트인하는 것과 같은 규약이다. 안쪽 요소가 자기 `contextmenu` 에서 `stopPropagation` 하면 그쪽 메뉴가 이긴다.
 */

/** Class `buildItemChip` puts on a chip whose def is a favorite. */
export const ITEM_CHIP_FAVORITE_CLASS = 'is-favorite';
/** Attribute (value ignored) that opts a non-chip `[data-def-id]` element into the 즐겨찾기 right-click menu. */
export const ITEM_FAVORITE_MENU_ATTR = 'data-fav-menu';

/**
 * The favorite half of `InventoryRef` as a reader that may predate it sees it (every member optional). Folders that must
 * work before / without inventory's implementation cast `ctx.inventory` to this.
 */
export interface ItemFavoriteApi {
  isFavorite?(defId: string): boolean;
  toggleFavorite?(defId: string, on?: boolean): boolean;
  readonly favoriteDefIds?: readonly string[];
}

let favoriteSource: ((defId: string) => boolean) | null = null;

/** Register (or clear with null) who answers "is this def a favorite?" for every chip built from now on. */
export function setItemChipFavoriteSource(fn: ((defId: string) => boolean) | null): void {
  favoriteSource = fn;
}

/** The registered source's answer; false without a source or when it throws. */
export function isItemChipFavorite(defId: string): boolean {
  if (!favoriteSource) return false;
  try { return favoriteSource(defId) === true; } catch { return false; }
}
