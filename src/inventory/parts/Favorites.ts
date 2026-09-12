/**
 * src/inventory/parts/Favorites.ts — **아이템 즐겨찾기** (2026-09-12, E1, 사용자 결정).
 *
 * 답하는 질문: *이 아이템 종류를 즐겨찾기했는가, 그리고 그 표는 언제 저장되고 어디서 오나.*
 *
 *  - 단위는 **아이템 종류(def id)** 다 — 같은 아이템은 전부 표시된다. 가지고 있지 않은 것도 켤 수 있다.
 *  - **캐릭터별 · 서버 동기**: 로드아웃 문서의 `fav` 목록에 실린다 (`Loadout.LoadoutSave.fav`). 새 프로필 키를 만들지 않았다.
 *  - 킷(장비 · 가방)과 **수명이 다르다**. 그래서 `applyLoadoutSave`(레이드 blob · 훈련장 복원 · 크루 카드도 지나는 길)는
 *    즐겨찾기를 건드리지 않고, 표를 갈아 끼우는 곳은 둘뿐이다 — 부팅 때 로컬 파일(`Lifecycle.restoreLoadoutSave`)과
 *    서버 문서(`ProfileDocs.applyProfileDocs`, 레이드 중에도 — 킷은 레이드 blob 이 진실이지만 즐겨찾기는 아니다).
 *  - **저장**: 함선에서는 곧바로 로드아웃 저장을 예약한다(`markDirty('favorite')`). 함선 밖(레이드 · 훈련장)에서는 그 자리에서
 *    로드아웃을 쓰면 들고 나간 킷이 파일에 적히므로(리셋 정책 위반) `favoritesDirty` 만 세우고, 다음 로드아웃 저장
 *    (탈출 `complete` · 사망 `corpse` · 실패 `starter` · 다음 `hub:entered`)이 함께 싣는다.
 *  - **서버 문서가 로컬 편집을 덮지 않는다** (CLAUDE.md 2026-09-11): 올리지 못한 토글이 있으면(`favoritesDirty` 또는 저장
 *    디바운스 중) 들어온 목록을 적용하지 않는다 — 그 편집이 곧 올라간다.
 *  - 표시는 `ui/GridView` 의 모듈 사본(`setFavoriteDefs`)이 맡는다 — 타일 띠 · 정렬 · 필터 · 분해 확인은 전부 이 표를 본다.
 */
import { ITEM_DEF_MAP } from '@/items';
import { sanitizeFavoriteList } from '../Loadout';
import { setFavoriteDefs } from '../ui/GridView';
import type { InventorySystem } from '../InventorySystem';

export function isFavorite(sys: InventorySystem, defId: string): boolean {
  return sys.favorites.has(defId);
}

/** Sorted copy (cached until the set changes). */
export function favoriteDefIds(sys: InventorySystem): readonly string[] {
  if (!sys.favoriteIdsCache) sys.favoriteIdsCache = Object.freeze([...sys.favorites].sort()) as string[];
  return sys.favoriteIdsCache;
}

/** What the loadout document carries (`LoadoutSave.fav`); undefined when there is nothing. */
export function captureFavorites(sys: InventorySystem): string[] | undefined {
  return sys.favorites.size > 0 ? [...sys.favorites].sort() : undefined;
}

/**
 * Turn a favourite on / off (`on` omitted = flip). Unknown def → false, nothing changes. Returns the new state; emits
 * `inventory:favoritesChanged` and schedules the save only when the state really changed.
 */
export function toggleFavorite(sys: InventorySystem, defId: string, on?: boolean): boolean {
  if (typeof defId !== 'string' || !ITEM_DEF_MAP.has(defId)) return false;
  const was = sys.favorites.has(defId);
  const next = on === undefined ? !was : !!on;
  if (next === was) return was;
  if (next) sys.favorites.add(defId); else sys.favorites.delete(defId);
  commit(sys, [defId]);
  persist(sys);
  return next;
}

/**
 * Replace the whole table with a saved list (boot file · server document). No save — the list came from storage.
 * `force` = the boot path, which runs before anything could have been edited.
 */
export function applySavedFavorites(sys: InventorySystem, raw: unknown, force = false): void {
  // a toggle that has not gone up yet is newer than any document that arrives now
  if (!force && (sys.favoritesDirty || sys.saveTimer !== null)) return;
  const next = new Set(sanitizeFavoriteList(raw) ?? []);
  const changed: string[] = [];
  for (const id of sys.favorites) if (!next.has(id)) changed.push(id);
  for (const id of next) if (!sys.favorites.has(id)) changed.push(id);
  if (changed.length === 0) return;
  sys.favorites = next;
  commit(sys, changed);
}

/** The loadout save went out (any reason) — its `fav` is on disk / on its way to the server. */
export function onLoadoutSaved(sys: InventorySystem): void {
  sys.favoritesDirty = false;
}

/** `hub:entered`: a toggle made outside the ship is written with the first save back in it. */
export function flushDeferred(sys: InventorySystem): void {
  if (sys.favoritesDirty && sys.ctx.isHubPhase()) sys.loadoutStore.markDirty('favorite');
}

function commit(sys: InventorySystem, changed: readonly string[]): void {
  sys.favoriteIdsCache = null;
  setFavoriteDefs(sys.favorites);
  for (const defId of changed) sys.ctx.bus.emit('inventory:favoritesChanged', { defId, favorite: sys.favorites.has(defId) });
}

function persist(sys: InventorySystem): void {
  sys.favoritesDirty = true;
  // outside the ship a loadout write would put the carried kit on disk mid-raid — the next save takes the list along
  if (sys.ctx.isHubPhase()) sys.loadoutStore.markDirty('favorite');
}
