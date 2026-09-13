/**
 * src/housing/parts/Sockets.ts — **흙 · 배지 소켓** (요리 재료 티어, 2026-09-13 — docs/plans/food-tiers.md §4.2).
 *
 * 「부어 둔 흙 · 배지에 끼우는 영구 강화.」 재배 스테이션(`parts/Garden.ts`)과 배양조(`parts/Culture.ts`)가 **같은 규칙**을
 * 쓰므로 여기 한 벌만 있다. 소켓은 칸(`GrowSlot` · `CultureSlot`)이 id 목록으로 들고 있고, 칸 수는 흙 · 배지 등급이 정한다
 * (`growSocketSlotsFor`). 가득 찬 칸에 끼우려면 `replaceIndex` 를 줘야 하고 그 자리의 옛 소켓은 **파괴된다** — 되돌려 주지 않는다
 * (사용자 결정, 화면이 먼저 1초 홀드로 묻는다). 칸을 비우면 흙 · 배지와 함께 사라진다.
 *
 * `speed` · `yield` 는 내구도 비율로 줄고(`Rules.growDurationMs` · `cultureDurationMs` · 여기의 `yieldBonus`), `wear` 는 비율을 타지
 * 않는다(`Rules.wearAfterHarvest`). 수치는 소켓 아이템 def(`ItemDef.growSocket`, `data/sockets.csv`)에서만 온다.
 */
import type { GrowSocketEffect, GrowSocketTarget, ItemDef } from '@/shared';
import { GROW_SOCKET_EFFECTS, GROW_SOCKET_TARGETS } from '@/shared';
import type { HousingSystem } from '../HousingSystem';

/** 소켓 def (`ItemDef.growSocket` 이 있는 것), 아니면 null. */
export function socketDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.growSocket ? def : null;
}

/** 끼운 소켓 중 `effect` 인 것의 `amount` 합 (모르는 id 는 0). */
export function socketSum(sys: HousingSystem, ids: readonly string[] | undefined, effect: GrowSocketEffect): number {
  let sum = 0;
  for (const id of ids ?? []) {
    const s = socketDef(sys, id)?.growSocket;
    if (s && s.effect === effect && Number.isFinite(s.amount)) sum += Math.max(0, s.amount);
  }
  return sum;
}

/**
 * 수확 한 번의 소켓 덤: `yield` 소켓마다 `amount × ratio` 확률로 +1 개. `ratio` = **마모 전** 내구도 비율. `rng01` 은 소켓마다
 * 한 번 부른다 (부르는 쪽은 `Math.random`).
 */
export function yieldBonus(sys: HousingSystem, ids: readonly string[] | undefined, ratio: number, rng01: () => number): number {
  const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  let extra = 0;
  for (const id of ids ?? []) {
    const s = socketDef(sys, id)?.growSocket;
    if (!s || s.effect !== 'yield') continue;
    const p = Math.max(0, Math.min(1, (Number.isFinite(s.amount) ? s.amount : 0) * r));
    if (p > 0 && rng01() < p) extra++;
  }
  return extra;
}

/**
 * 세이브에서 읽은 소켓 목록을 칸에 맞게 거른다: 문자열 · 진짜 소켓 def · 대상(`soil` / `medium`)이 맞는 것만, 앞에서부터
 * `slots` 개까지. `ctx.loot` 가 있을 때(런타임 정리) 부른다 — `ShipState.sanitize` 는 모양만 본다.
 */
export function sanitizeSocketIds(sys: HousingSystem, ids: unknown, target: GrowSocketTarget, slots: number): string[] {
  const out: string[] = [];
  const cap = Math.max(0, Math.floor(Number.isFinite(slots) ? slots : 0));
  if (!Array.isArray(ids)) return out;
  for (const id of ids) {
    if (out.length >= cap) break;
    if (typeof id !== 'string') continue;
    const s = socketDef(sys, id)?.growSocket;
    if (!s || s.target !== target) {
      console.warn(`[housing] socket '${id}' is not a ${target} socket — dropped`);
      continue;
    }
    out.push(id);
  }
  return out;
}

/** 칸이 들고 있는 소켓 필드 (`GrowSlot` · `CultureSlot` 둘 다 이 모양이다). */
export interface SocketHolder {
  uid: string;
  sockets?: string[];
}

/**
 * 소켓 하나를 (가방 → 창고, 1개 소모) `holder` 에 끼운다 — 칸 게이트(`slotBlock`)는 부르는 쪽이 먼저 지난다. 성공하면
 * `housing:socketInserted` 를 내고 null, 아니면 한국어 사유. `housing:changed` 는 부르는 쪽(`growChanged` · `cultureChanged`)이 낸다.
 *
 * 사유 순서: 흙/배지 없음 → 소켓 아님 → 반대 대상 → 없는 소켓 칸(`replaceIndex` 가 범위 밖) → 가득 참(`replaceIndex` 없음) → 보유 없음.
 * `replaceIndex` 는 **이미 끼운 소켓의 번호**(0 … 끼운 수 − 1)다 — 빈 칸이 남아 있어도 주면 그 자리를 갈아 끼운다.
 */
export function insertSocket(
  sys: HousingSystem, holder: SocketHolder | null, target: GrowSocketTarget, socketDefId: string, slots: number, replaceIndex?: number,
): string | null {
  if (!holder) return target === 'soil' ? '흙을 먼저 채우세요' : '배지를 먼저 채우세요';
  const def = socketDef(sys, socketDefId);
  if (!def || !def.growSocket) return '소켓이 아닙니다';
  if (def.growSocket.target !== target) return target === 'soil' ? '배지 소켓은 배양조에 끼웁니다' : '토양 소켓은 재배 스테이션에 끼웁니다';
  const list = Array.isArray(holder.sockets) ? holder.sockets : [];
  const cap = Math.max(0, Math.floor(Number.isFinite(slots) ? slots : 0));
  const replacing = replaceIndex !== undefined && replaceIndex !== null;
  if (replacing) {
    if (!Number.isInteger(replaceIndex) || replaceIndex < 0 || replaceIndex >= Math.min(list.length, cap)) return '없는 소켓 칸입니다';
  } else if (list.length >= cap) {
    return '소켓 칸이 가득 찼습니다';
  }
  if (sys.countDef(socketDefId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(socketDefId, 1)) return '소켓을 꺼낼 수 없습니다';
  let replaced: string | null = null;
  if (replacing) {
    replaced = list[replaceIndex as number] ?? null;
    list[replaceIndex as number] = socketDefId;
  } else {
    list.push(socketDefId);
  }
  holder.sockets = list;
  sys.ctx.bus.emit('housing:socketInserted', { uid: holder.uid, target, defId: socketDefId, replaced });
  return null;
}

/** 지금 가진 소켓 (가방 + 창고). `target` 을 주면 그쪽만. 순서: 대상(흙 → 배지) → 효과(speed → yield → wear) → 수치 오름차순. */
export function getOwnedSockets(sys: HousingSystem, target?: GrowSocketTarget): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number; def: ItemDef }[] = [];
  for (const def of loot.getAllItemDefs()) {
    const s = def.growSocket;
    if (!s || (target && s.target !== target)) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty, def });
  }
  out.sort((a, b) => {
    const sa = a.def.growSocket!, sb = b.def.growSocket!;
    return (GROW_SOCKET_TARGETS.indexOf(sa.target) - GROW_SOCKET_TARGETS.indexOf(sb.target))
      || (GROW_SOCKET_EFFECTS.indexOf(sa.effect) - GROW_SOCKET_EFFECTS.indexOf(sb.effect))
      || (sa.amount - sb.amount)
      || a.defId.localeCompare(b.defId);
  });
  return out.map(({ defId, qty }) => ({ defId, qty }));
}
