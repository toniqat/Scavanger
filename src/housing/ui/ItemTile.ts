import type { GameContext } from '@/shared';
import { ITEM_GRID_GAP, buildItemGridChip, itemGridBox } from '@/shared';

/**
 * **가구 화면의 아이템 칸** (2026-09-16, 사용자 결정 「연산 클러스터 · 전시대의 칸을 아이템 그리드로 바꾼다」).
 *
 * 꽂힌 것은 **가방에서 보던 바로 그 타일**이다: 그리는 것은 인벤토리의 `InventoryRef.buildItemTile` 한 벌이고
 * (§4.1 「같은 마크업을 두 폴더에 두지 않는다」) 여기는 크기만 정한다. 전용 그림(코어 칩 · 책등 · 디스크 케이스)을
 * 손으로 그리던 자리다 — 같은 아이템이 가방에서와 다르게 보이면 무엇이 꽂혔는지 두 번 배워야 한다.
 *
 * **수량 숫자는 그리지 않는다** (사용자 결정): 이 칸들은 「한 칸에 하나」라 우하단 배지가 늘 `1` 이거나 뜻이 없다.
 * 인벤토리 타일의 배지 요소(`.inv-tile-qty`)를 **숨기기만** 한다 — 지우지 않는 이유는, 이름이 바뀌어도 최악이
 * 「숫자가 다시 보인다」이지 예외가 아니기 때문이다.
 *
 * 인벤토리가 아직 없을 때(housing 은 inventory 보다 **먼저** 등록된다)는 공용 칩(`buildItemGridChip`)이 대신 선다.
 */

/** 칸 한 변(px)의 최소 — 이보다 작으면 글리프가 읽히지 않는다 (배치 상수). */
const MIN_TILE_CELL = 14;

/**
 * `boxW × boxH` px 상자 안에 **발자국 `w × h` 칸**이 통째로 들어가는 칸 한 변(px).
 * 칸 사이 여백(`ITEM_GRID_GAP`)까지 셈에 넣는다 — `itemGridBox` 의 역식이다.
 */
export function cellToFit(boxW: number, boxH: number, w: number, h: number, gap: number = ITEM_GRID_GAP): number {
  const cw = Math.max(1, Math.floor(w)), ch = Math.max(1, Math.floor(h));
  const byW = (boxW - gap * (cw - 1)) / cw;
  const byH = (boxH - gap * (ch - 1)) / ch;
  return Math.max(MIN_TILE_CELL, Math.floor(Math.min(byW, byH)));
}

export interface StationTileOptions {
  /** 격자 칸 한 변(px). */
  cell: number;
  /** 있으면 타일 아래 내구도 바 (인벤토리 타일과 같은 규칙). */
  durability?: number;
}

/** 그 아이템의 발자국이 차지하는 상자 (px) — 칸 상자를 이 크기로 잡으면 타일이 딱 맞는다. */
export function stationTileBox(ctx: GameContext, defId: string, cell: number): { width: number; height: number } {
  const def = ctx.loot?.getItemDef(defId);
  return itemGridBox(def?.width ?? 1, def?.height ?? 1, cell);
}

/**
 * 한 칸에 들어갈 **인벤토리 타일 하나**. 수량 배지는 숨어 있고, 호버 카드(`data-item-tip`)는 인벤토리 타일이
 * 스스로 달고 온다. 반환 요소에는 `.hs-tile` 이 붙어 글리프 · 이름 크기가 칸 크기를 따라간다 (`housing.css`).
 */
export function buildStationItemTile(ctx: GameContext, defId: string, opts: StationTileOptions): HTMLElement {
  const inv = ctx.inventory;
  const cell = Math.max(MIN_TILE_CELL, Math.round(opts.cell));
  const tile = inv && typeof inv.buildItemTile === 'function'
    ? inv.buildItemTile(defId, 1, opts.durability === undefined ? { cell } : { cell, durability: opts.durability })
    : buildItemGridChip(ctx.loot?.getItemDef(defId), { cell });
  tile.classList.add('hs-tile');
  tile.style.setProperty('--inv-cell', `${cell}px`);
  const qty = tile.querySelector<HTMLElement>('.inv-tile-qty');
  if (qty) qty.hidden = true;
  return tile;
}
