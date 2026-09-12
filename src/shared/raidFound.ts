/**
 * src/shared/raidFound.ts — **「이번 레이드에서 얻은 아이템」 표식** (2026-09-12, 아이템 회수 계약 — 사용자 결정).
 *
 * `extract_with_items` 계약은 **그 레이드 안에서 루팅 굴림으로 생긴** 아이템만 센다. 함선에서 가져온 것 · 제작 · 상점 ·
 * 기본 지급 · 튜토리얼 · 콘솔은 세지 않는다. 그 구분을 인스턴스에 붙는 `ItemInstance.raidFound`(= 그 레이드의 맵 시드)가 들고,
 * 표식은 **아이템과 함께 다닌다** (바닥에 버려 분대원이 주워도 · 시체에 들어가도 · 재접속 blob 에도).
 *
 * 규칙을 아는 곳은 이 파일 하나다 — meta(개수 · 정산) · inventory(스택 분리 · 사선 띠)가 같은 함수를 부른다.
 *   - 찍는 곳: 상자 · 구조물/플랫폼/전차 컨테이너(열쇠 부가 포함) · 보급 상자 · 적 시체(네임드 포함) · 채집 노드.
 *     전부 `raidFoundSeed(ctx)` 가 null 이 아닐 때만 (진짜 레이드 · 훈련장 아님) — 굴림의 rng 는 건드리지 않는다.
 *   - 합치기: **활성 회수 계약의 아이템만** 표식이 같은 스택끼리 합친다 (`raidFoundStackKey`). 다른 아이템은 예전처럼
 *     합치되, 표식이 다른 둘이 합쳐지면 결과는 표식이 없다 (`mergeRaidFoundMark` — 섞어서 세탁하지 않는다).
 *   - 레이드가 끝나면 inventory 가 몸 · 창고 전부에서 지운다 — 함선에서는 다시 평범하게 합쳐진다.
 */
import type { GameContext } from './GameContext';
import type { ItemInstance } from './types';

/** 표식을 읽고 쓰는 데 필요한 인스턴스 필드만. */
export type RaidFoundItem = Pick<ItemInstance, 'defId' | 'raidFound'>;

/** 활성 회수 계약의 범위 — 이 레이드의 시드와 계약 아이템 def id. */
export interface RaidFoundScope {
  readonly seed: number;
  readonly defId: string;
}

/**
 * 지금 루팅 굴림이 찍어야 할 시드 — 진짜 레이드(출격 중 · 훈련장 아님)이고 월드가 있을 때 그 맵의 시드(`WorldRef.seed`),
 * 아니면 null (함선 · 훈련장 · 메뉴 · 월드 생성 전).
 */
export function raidFoundSeed(ctx: Pick<GameContext, 'isRaidActive' | 'isTraining' | 'world'>): number | null {
  if (!ctx.isRaidActive() || ctx.isTraining()) return null;
  const seed = ctx.world?.seed;
  return typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : null;
}

/** `item` 이 레이드 `seed` 에서 얻은 것인가 (시드는 `>>> 0` 으로 맞춰 비교한다). seed 가 없으면 언제나 false. */
export function isRaidFound(item: Pick<ItemInstance, 'raidFound'> | null | undefined, seed: number | null | undefined): boolean {
  if (!item || typeof seed !== 'number' || !Number.isFinite(seed)) return false;
  const rf = item.raidFound;
  return typeof rf === 'number' && Number.isFinite(rf) && (rf >>> 0) === (seed >>> 0);
}

/** 굴림 결과에 표식을 찍는다 (최상위 인스턴스만 — 소켓 부착물은 무기와 한 몸이다). seed 가 null 이면 아무것도 안 한다. */
export function markRaidFound(items: ItemInstance | readonly (ItemInstance | null | undefined)[] | null | undefined, seed: number | null): void {
  if (seed === null || !items) return;
  const s = seed >>> 0;
  if (Array.isArray(items)) { for (const it of items) if (it) it.raidFound = s; }
  else (items as ItemInstance).raidFound = s;
}

/** 표식을 지운다. 있었으면 true. */
export function stripRaidFound(item: ItemInstance | null | undefined): boolean {
  if (!item || item.raidFound === undefined) return false;
  delete item.raidFound;
  return true;
}

/** 나눈 스택(`created`)이 원래 스택(`from`)의 표식을 물려받는다. */
export function copyRaidFoundMark(created: ItemInstance, from: Pick<ItemInstance, 'raidFound'>): void {
  if (typeof from.raidFound === 'number') created.raidFound = from.raidFound;
  else delete created.raidFound;
}

/**
 * `source` 의 수량이 `target` 에 합쳐진 **뒤에** 부른다: 둘의 표식이 같을 때만 결과가 표식을 유지한다. 활성 계약 아이템은
 * `raidFoundStackKey` 가 애초에 다른 표식끼리 합치지 않으므로, 여기서 지워지는 것은 다른 아이템(과 지난 레이드의 표식)뿐이다.
 */
export function mergeRaidFoundMark(target: ItemInstance, source: Pick<ItemInstance, 'raidFound'>): void {
  if (target.raidFound !== source.raidFound) delete target.raidFound;
}

/** `ctx` 의 활성 회수 계약 범위 — 진짜 레이드이고 활성 계약이 `extract_with_items` 일 때만, 아니면 null. */
export function raidFoundScopeOf(ctx: Pick<GameContext, 'isRaidActive' | 'isTraining' | 'world' | 'meta'>): RaidFoundScope | null {
  const seed = raidFoundSeed(ctx);
  if (seed === null) return null;
  const def = ctx.meta?.activeContract?.def;
  const defId = def && def.goal === 'extract_with_items' ? def.itemDefId : undefined;
  return typeof defId === 'string' && defId ? { seed, defId } : null;
}

/** 이 스택이 활성 회수 계약에 세어지는가 (사선 띠 · 개수). */
export function countsForRecovery(item: RaidFoundItem | null | undefined, scope: RaidFoundScope | null): boolean {
  return !!item && !!scope && item.defId === scope.defId && isRaidFound(item, scope.seed);
}

/**
 * 스택 분류 열쇠 — 같은 def 의 두 스택은 이 값이 같을 때만 합친다. 활성 회수 계약 아이템만 `'rf'`(이번 레이드) / `''` 로
 * 갈리고, 나머지는 전부 `''` 라 예전과 똑같이 합쳐진다.
 */
export function raidFoundStackKey(item: RaidFoundItem, scope: RaidFoundScope | null): string {
  return scope && item.defId === scope.defId && isRaidFound(item, scope.seed) ? 'rf' : '';
}

/** 두 범위가 같은가 (표시 사본 갱신 판단). */
export function sameRaidFoundScope(a: RaidFoundScope | null, b: RaidFoundScope | null): boolean {
  return a === b || (!!a && !!b && a.seed === b.seed && a.defId === b.defId);
}
