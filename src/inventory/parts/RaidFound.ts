/**
 * src/inventory/parts/RaidFound.ts — **아이템 회수 계약: 「이번 레이드에서 얻은 아이템」** (2026-09-12, 사용자 결정).
 *
 * 규칙 자체(시드 · 표식 · 분류 열쇠)는 `shared/raidFound.ts` 한 곳에 있고, 이 파일은 인벤토리가 그것을 **어디에 거는지**만 갖는다:
 *  - `installRaidFoundRules` — 모든 격자 · 휠 · 정렬이 보는 스택 분류 열쇠(`Grid.setStackKeyRule`)와 상자 굴림의 표식 시드
 *    (`ContainerStore.raidMark`). 둘 다 **질의 시점의 ctx** 를 읽는다 — 계약을 포기하면 다음 질의부터 바로 풀린다.
 *  - `raidFoundScope` — 활성 회수 계약 범위 (진짜 레이드 + `extract_with_items` 일 때만).
 *  - `stripRaidMarks` — 레이드가 끝나면(`game:complete` · `game:over` · `game:abort` · `hub:entered`) 몸 · 창고 전부에서 표식을
 *    지운다. 프로필 문서에는 원래 안 실리므로(`Serialize.serializeExtras` 가 쓰지 않는다) 저장할 것은 없다.
 *  - `annotateRaidState` — 레이드 세션 blob 에만 `rf` 를 붙인다 (재접속 · 솔로 이어하기가 표식을 잃지 않게).
 */
import type { ItemInstance, RaidFoundScope } from '@/shared';
import { raidFoundScopeOf, raidFoundSeed, raidFoundStackKey, stripRaidFound } from '@/shared';
import { setStackKeyRule } from '../Grid';
import { LOADOUT_SLOTS, type RaidInventoryState } from '../model';
import type { SavedExtras } from '../Serialize';
import type { InventorySystem } from '../InventorySystem';

/** 활성 회수 계약 범위 (진짜 레이드 · `extract_with_items`), 아니면 null. */
export function raidFoundScope(sys: InventorySystem): RaidFoundScope | null {
  return raidFoundScopeOf(sys.ctx);
}

/** `init` 에서 한 번: 스택 분류 열쇠 + 상자 굴림 표식 시드. */
export function installRaidFoundRules(sys: InventorySystem): void {
  setStackKeyRule((item) => raidFoundStackKey(item, raidFoundScopeOf(sys.ctx)));
  sys.containers.raidMark = () => raidFoundSeed(sys.ctx);
}

/** 한 인스턴스와 소켓 부착물의 표식을 지운다. 지운 것이 있으면 true. */
function stripDeep(item: ItemInstance | null | undefined): boolean {
  if (!item) return false;
  let changed = stripRaidFound(item);
  if (item.sockets) for (const att of Object.values(item.sockets)) if (att && stripRaidFound(att)) changed = true;
  return changed;
}

/**
 * 레이드가 끝났다: 장비칸 · 가방 · 휠 · 주머니 · 함선 창고의 표식을 전부 지운다. 바뀐 격자는 버전을 올려 다시 그려진다.
 * 표식은 문서에 없으므로 저장은 필요 없다. 바뀐 것이 있으면 true.
 */
export function stripRaidMarks(sys: InventorySystem): boolean {
  let changed = false;
  for (const s of LOADOUT_SLOTS) if (stripDeep(sys.loadout[s])) changed = true;
  for (const grid of [sys.bag, sys.pouch, sys.stash.grid]) {
    let touched = false;
    for (const p of grid.items()) if (stripDeep(p.item)) touched = true;
    if (touched) { grid.version++; changed = true; }
  }
  for (const it of sys.quickSlots) if (stripDeep(it)) changed = true;
  return changed;
}

/** `captureRaidState` 의 문서에 표식을 붙인다 — 문서의 항목 순서는 `captureLoadoutSave` 가 읽은 순서 그대로다. */
export function annotateRaidState(sys: InventorySystem, state: RaidInventoryState): void {
  const tag = (sv: SavedExtras | null | undefined, item: ItemInstance | null | undefined): void => {
    if (sv && item && typeof item.raidFound === 'number') sv.rf = item.raidFound;
  };
  for (const s of LOADOUT_SLOTS) tag(state.slots[s], sys.loadout[s]);
  const bag = sys.bag.items();
  state.bag.forEach((sv, i) => tag(sv, bag[i]?.item));
  state.quick.forEach((sv, i) => tag(sv, sys.quickSlots[i]));
  const pouch = sys.pouch.items();
  state.pouch.forEach((sv, i) => tag(sv, pouch[i]?.item));
}
