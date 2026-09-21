/**
 * src/housing/parts/Sockets.ts — **soil · medium sockets** (food material tiers, 2026-09-13).
 *
 * 「A permanent upgrade fitted into poured soil · medium.」 The grow station (`parts/Garden.ts`) and the culture tank
 * (`parts/Culture.ts`) use the **same rules**, so there is one set of them here. Sockets are held by the slot
 * (`GrowSlot` · `CultureSlot`) as a list of ids, and the slot count is set by the soil · medium tier
 * (`growSocketSlotsFor`). Fitting into a full slot needs a `replaceIndex`, and the old socket in that spot is
 * **destroyed** — it is never given back (user's decision; the screen asks first with a 1 s hold). Clearing the slot
 * loses them with the soil · medium.
 *
 * `speed` · `yield` scale down by the durability ratio (`Rules.growDurationMs` · `cultureDurationMs` · `yieldBonus`
 * here), `wear` does not ride the ratio (`Rules.wearAfterHarvest`). The numbers come only from the socket item def
 * (`ItemDef.growSocket`, `data/sockets.csv`).
 */
import type { GrowSocketEffect, GrowSocketTarget, ItemDef } from '@/shared';
import { GROW_SOCKET_EFFECTS, GROW_SOCKET_TARGETS } from '@/shared';
import type { HousingSystem } from '../HousingSystem';

/** The socket def (one that has `ItemDef.growSocket`), else null. */
export function socketDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.growSocket ? def : null;
}

/** The sum of `amount` over the fitted sockets with `effect` (an unknown id counts 0). */
export function socketSum(sys: HousingSystem, ids: readonly string[] | undefined, effect: GrowSocketEffect): number {
  let sum = 0;
  for (const id of ids ?? []) {
    const s = socketDef(sys, id)?.growSocket;
    if (s && s.effect === effect && Number.isFinite(s.amount)) sum += Math.max(0, s.amount);
  }
  return sum;
}

/**
 * The socket bonus of one harvest: +1 per `yield` socket at probability `amount × ratio`. `ratio` = the durability
 * ratio **before wear**. `rng01` is called once per socket (the caller passes `Math.random`).
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
 * Filters a socket list read from a save down to the slot: strings · real socket defs · a matching target
 * (`soil` / `medium`) only, up to `slots` of them from the front. Called when `ctx.loot` exists (runtime sanitizing) —
 * `ShipState.sanitize` only looks at the shape.
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

/** The socket field a slot holds (`GrowSlot` · `CultureSlot` are both this shape). */
export interface SocketHolder {
  uid: string;
  sockets?: string[];
}

/**
 * Fits one socket (bag → stash, 1 consumed) into `holder` — the slot gate (`slotBlock`) is passed by the caller first.
 * On success it emits `housing:socketInserted` and returns null, else the Korean reason. `housing:changed` is emitted by
 * the caller (`growChanged` · `cultureChanged`).
 *
 * Reason order: no soil/medium → not a socket → the wrong target → no such socket slot (`replaceIndex` out of range) → full (`replaceIndex` absent) → not owned.
 * `replaceIndex` is the **index of an already fitted socket** (0 … fitted count − 1) — given, it swaps that spot even when free slots remain.
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

/** The sockets owned right now (bag + stash). With `target`, only that side. Order: target (soil → medium) → effect (speed → yield → wear) → amount ascending. */
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
