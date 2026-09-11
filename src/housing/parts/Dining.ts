/**
 * src/housing/parts/Dining.ts — **주방 식탁** (A-3c, 2026-09-11).
 *
 * 「조리대에서 만든 요리를 **식탁에서 먹으면** 다음 레이드 1회분 버프가 실린다.」
 *
 * 규칙의 주인은 progression 이다 (`ProgressionRef.useMeal` — 함선 게이트 · 고정 1칸 · 한국어 사유). housing 은
 * **아이템을 뺄 수 있는지**만 먼저 보고, progression 이 받아들였을 때 1개를 뺀다. 순서를 뒤집으면(빼고 나서
 * 묻는다) 거절당했을 때 되돌릴 곳이 없다 — 이것은 A-13 의 `inventory/parts/StashOps.usePrepItem` 이 세운 규약을
 * 그대로 따른 것이다.
 *
 * 식탁은 두 가지다:
 *   • 개인 함선의 **가구**(`interaction: 'dining_table'`) — `uid` 가 그 가구다.
 *   • 공유 함선의 **고정 식탁** — 가구가 아니라 hub 가 심어 둔 상호작용 지점이라 **`uid` 가 null** 이다.
 * 공유 함선에서만 「분대에 차리기」가 보인다: 요리 **1개**를 소모하고 `housing:mealServed` 를 낸다 —
 * 실제 전파는 net 이 한다 (housing 은 이벤트만 낸다, 「남에게 영향 주는 메시지는 권위에서만 받는다」).
 */
import type { ItemDef } from '@/shared';
import { isDiningTableDefId } from '../ShipState';
import type { HousingSystem } from '../HousingSystem';

/** 공유 함선의 고정 식탁 앞에 서 있는가 (uid 없는 식탁은 이것 하나뿐이다). */
export function isSharedTable(sys: HousingSystem): boolean {
  return sys.ctx.hub?.ship === 'shared';
}

/** The 식탁 가구 behind `uid`, or null when it is not one (or gone). `uid` null = 공유 함선의 고정 식탁. */
export function diningTableOf(sys: HousingSystem, uid: string) {
  const item = sys.getPlacedByUid(uid);
  return item && isDiningTableDefId(item.defId) ? item : null;
}

/**
 * 왜 지금 식탁을 쓸 수 없는가 (null = 괜찮다). 레이드 중에는 열리지 않는다 — 식사는 **출격 전에** 차리는 것이다.
 */
export function diningBlock(sys: HousingSystem, uid: string | null): string | null {
  const ctx = sys.ctx;
  if (ctx.isRaidActive() || !ctx.isHubPhase()) return '함선에서만 쓸 수 있습니다';
  if (uid === null) return isSharedTable(sys) ? null : '식탁이 없습니다';
  return diningTableOf(sys, uid) ? null : '식탁이 아닙니다';
}

/* ── item lookups ──────────────────────────────────────────────────────── */
/** 요리 def with its `meal` data, or null when `defId` is not a 요리. */
export function mealDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.meal ? def : null;
}

/** 지금 갖고 있는 요리 (가방 + 함선 창고), 일반 → 특선 순서로 — 식탁 화면의 목록. */
export function getOwnedMeals(sys: HousingSystem): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number }[] = [];
  for (const def of loot.getAllItemDefs()) {
    if (!def.meal) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty });
  }
  out.sort((a, b) => (sys.mealDef(a.defId)?.meal?.tier ?? 0) - (sys.mealDef(b.defId)?.meal?.tier ?? 0));
  return out;
}

/* ── 먹기 · 차리기 ──────────────────────────────────────────────────────── */
/**
 * 요리 하나를 먹는다 — **progression 에 먼저 묻고 성공(null)할 때만** 아이템을 뺀다 (`StashOps.usePrepItem` 규약).
 * 이미 차려 둔 식사가 있으면 그것을 **교체**한다 (거절 사유가 아니다, 계약에 적힌 그대로).
 */
export function eatMeal(sys: HousingSystem, uid: string | null, defId: string): string | null {
  const block = diningBlock(sys, uid);
  if (block) return block;
  const def = sys.mealDef(defId);
  if (!def || !def.meal) return '요리가 아닙니다';
  if (sys.countDef(defId) < 1) return `${def.name}이(가) 없습니다`;
  const prog = sys.ctx.progression;
  if (!prog || typeof prog.useMeal !== 'function') return '식사를 실을 수 없습니다';
  const refusal = prog.useMeal(defId);
  if (refusal) return refusal;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(defId, 1)) {
    // 자리(보유 수량)를 미리 걸렀으므로 사실상 오지 않는 가지다 — progression 은 이미 실었다.
    console.error('[housing] 식사를 실었지만 요리를 빼지 못했다', defId);
  }
  return null;
}

/**
 * 공유 함선의 식탁에서 **분대 전원**에게 차린다 (사용자 결정): 요리 **1개**만 소모하고 분대원이 같은 식사를 받는다.
 *
 * housing 이 하는 일은 셋뿐이다 — ① 아이템 1개 소모, ② **나 자신에게** `serveMeal` (전파는 남에게 가는 것이라
 * 내 몫은 여기서 챙긴다), ③ `housing:mealServed {defId, by}` 를 낸다 — `by` 는 PeerId 가 아니라 **표시 이름**이다
 * (토스트가 그대로 찍는다). 실제 와이어(`meal serve`)와 권위 검사는 net 의 몫이다 — housing 은 다른 폴더의
 * 내부를 모른다.
 *
 * ⚠ **housing 은 `housing:mealServed` 를 구독하지 않는다.** net 의 수신 경로가 같은 이벤트를 다시 내므로,
 * 여기서 듣고 아이템을 소모하면 차린 본인의 요리가 두 번 빠진다.
 */
export function serveMealToSquad(sys: HousingSystem, uid: string | null, defId: string): string | null {
  const block = diningBlock(sys, uid);
  if (block) return block;
  if (!isSharedTable(sys)) return '공유 함선의 식탁에서만 차릴 수 있습니다';
  const def = sys.mealDef(defId);
  if (!def || !def.meal) return '요리가 아닙니다';
  if (sys.countDef(defId) < 1) return `${def.name}이(가) 없습니다`;
  const prog = sys.ctx.progression;
  if (!prog || typeof prog.serveMeal !== 'function') return '식사를 차릴 수 없습니다';
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(defId, 1)) return '요리를 꺼낼 수 없습니다';
  prog.serveMeal(defId);
  // `by` 는 PeerId 가 아니라 **표시 이름**이다 — `ui/hud/Notifications` 가 토스트에 그대로 찍는다.
  sys.ctx.bus.emit('housing:mealServed', { defId, by: sys.ctx.net?.playerName || '나' });
  return null;
}

/** Open the 식사 화면 (`dining_table` interaction). `uid` null = 공유 함선의 고정 식탁. */
export function openDiningTable(sys: HousingSystem, uid: string | null): void {
  if (!sys.diningTable) return;
  const block = diningBlock(sys, uid);
  if (block) { sys.notify(block, 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.diningTable.openTable(uid);
}
