/**
 * src/housing/parts/Garden.ts — **온실 재배 스테이션** (온실 개편, 2026-09-11).
 *
 * 「한 칸은 두 단계다 — 흙을 붓고(`fillSoil`), 그 위에 씨앗을 심는다(`plantSeedAt`).」
 * 재배층은 가구 레벨이 연다 (Lv.1 중앙 · Lv.2 아래 · Lv.3 위, 층 id 는 업그레이드해도 안 바뀐다) 이고 한 층에
 * `GROW_SLOTS_PER_TIER` 칸이다. 성장은 예전처럼 **실제 시간**(`ctx.net.serverNow()` ?? `Date.now()`)이고,
 * 토양 궁합 · 원예 숙련은 **심는 순간 `readyAt` 에 확정**되어 그 뒤로 움직이지 않는다. 토양은 수확할 때마다
 * 1회 닳아(`soilUsesLeft`) 0 이 되면 칸이 완전히 비워진다.
 *
 * 순수 판정(층 개방 · 궁합 · 성장 시간 · 진행도)은 전부 `../Rules.ts` 에 있다.
 */
import type { GrowPlotInfo, GrowSlot, GrowSlotInfo, GrowTier, ItemDef, PlacedFurniture, SoilTag } from '@/shared';
import { GROW_SLOTS_PER_TIER, GROW_TIER_DRAW_ORDER, SKILL_LEVEL_MAX, growTiersForLevel } from '@/shared';
import {
  growDurationMs, growProgress, growRemainingS, growTierOpen, growTierUnlockLevel, soilMatches,
} from '../Rules';
import { isGrowStationDefId } from '../ShipState';
import { formatRemaining } from '../ui/dom';
import { RETIRED_RACK_REASON } from '../model';
import type { HousingSystem } from '../HousingSystem';

/* ── state access ──────────────────────────────────────────────────────── */
/**
 * 재배 스테이션 칸. The save only shape-checks soil ids (`soil_*`); the first time `ctx.loot` is around every id that
 * is not a real 토양 any more is dropped here, and an unknown seed leaves plain soil behind (서재의 `books()` 와
 * 같은 규약이다 — 아이템 표에서 사라진 def 가 칸을 깨뜨리지 않는다).
 */
export function grows(sys: HousingSystem): GrowSlot[] {
  if (!Array.isArray(sys.state.grows)) sys.state.grows = [];
  const list = sys.state.grows;
  if (!sys.growsPruned && sys.ctx?.loot && typeof sys.ctx.loot.getItemDef === 'function') {
    sys.growsPruned = true;
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (!sys.defOf(g.soilDefId)?.soil) {
        console.warn(`[housing] unknown soil '${g.soilDefId}' dropped from 재배 스테이션 ${g.uid}`);
        list.splice(i, 1);
        continue;
      }
      if (g.seedDefId && !sys.defOf(g.seedDefId)?.seed) {
        console.warn(`[housing] unknown seed '${g.seedDefId}' dropped from 재배 스테이션 ${g.uid}`);
        delete g.seedDefId; delete g.plantedAt; delete g.readyAt;
      }
    }
  }
  return list;
}

/** The 재배 스테이션 behind `uid`, or null when it is not one (or gone). */
export function stationOf(sys: HousingSystem, uid: string): PlacedFurniture | null {
  const item = sys.getPlacedByUid(uid);
  return item && isGrowStationDefId(item.defId) ? item : null;
}

export function growSlotAt(sys: HousingSystem, uid: string, tier: GrowTier, slot: number): GrowSlot | null {
  return sys.grows().find((g) => g.uid === uid && g.tier === tier && g.slot === slot) ?? null;
}

/** Drop every 칸 of a station that is being recovered (its soil and crops go with it). */
export function dropGrowsOf(sys: HousingSystem, uid: string): void {
  const list = sys.grows();
  for (let i = list.length - 1; i >= 0; i--) if (list[i].uid === uid) list.splice(i, 1);
}

/** Ripe 칸 of a station (for the `housing:growChanged` payload and the hub's station visuals). */
export function readyCount(sys: HousingSystem, uid: string): number {
  const now = sys.nowMs();
  return sys.grows().filter((g) => g.uid === uid && !!g.readyAt && now >= g.readyAt).length;
}

export function growChanged(sys: HousingSystem, uid: string, reason: string): void {
  sys.changed(reason);
  sys.ctx.bus.emit('housing:growChanged', { uid, ready: sys.readyCount(uid) });
}

/* ── item lookups ──────────────────────────────────────────────────────── */
/** Seed def with its `seed` data, or null when `defId` is not a seed. */
export function seedDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.seed ? def : null;
}

/** Soil def with its `soil` data, or null when `defId` is not a 토양. */
export function soilDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.soil ? def : null;
}

/** 원예 skill 0..SKILL_LEVEL_MAX. */
export function gardening(sys: HousingSystem): number {
  const p = sys.ctx.progression;
  if (!p || typeof p.getSkill !== 'function') return 0;
  const v = p.getSkill('gardening');
  return Number.isFinite(v) ? Math.max(0, Math.min(SKILL_LEVEL_MAX, v)) : 0;
}

/** Harvest size after the 원예 `gatherYieldMul` (at least one unit). */
export function yieldQty(sys: HousingSystem, base: number): number {
  const mul = sys.ctx.progression?.derived?.gatherYieldMul ?? 1;
  return Math.max(1, Math.round(base * (Number.isFinite(mul) && mul > 0 ? mul : 1)));
}

/* ── 재배 화면이 읽는 값 ────────────────────────────────────────────────── */
/**
 * Every 칸 of one station — **always `3 × GROW_SLOTS_PER_TIER`** in `GROW_TIER_DRAW_ORDER` (위 → 중앙 → 아래),
 * locked tiers included so the panel can draw the rows an upgrade will open. `[]` when `uid` is not a station.
 */
export function getGrowSlots(sys: HousingSystem, uid: string): GrowSlotInfo[] {
  const station = sys.stationOf(uid);
  if (!station) return [];
  const now = sys.nowMs();
  const out: GrowSlotInfo[] = [];
  for (const tier of GROW_TIER_DRAW_ORDER) {
    const locked = !growTierOpen(station.level, tier);
    const unlockLevel = growTierUnlockLevel(tier);
    for (let slot = 0; slot < GROW_SLOTS_PER_TIER; slot++) {
      const g = locked ? null : sys.growSlotAt(uid, tier, slot);
      const soil = g ? sys.soilDef(g.soilDefId)?.soil ?? null : null;
      const seed = g?.seedDefId ? sys.seedDef(g.seedDefId)?.seed ?? null : null;
      out.push({
        tier, slot, locked, unlockLevel,
        soilDefId: g?.soilDefId ?? null,
        soilTag: soil?.tag ?? null,
        soilUsesLeft: g?.soilUsesLeft ?? 0,
        seedDefId: g?.seedDefId ?? null,
        seedTag: seed?.soilTag ?? null,
        matched: !!seed && soilMatches(soil?.tag ?? null, seed.soilTag),
        progress: growProgress(now, g?.plantedAt, g?.readyAt),
        remainingS: growRemainingS(now, g?.readyAt),
        ready: !!g?.readyAt && now >= g.readyAt,
        yieldDefId: seed?.yieldDefId ?? null,
        yieldQty: seed ? sys.yieldQty(seed.yieldQty) : 0,
      });
    }
  }
  return out;
}

/** Soil item defs the player owns right now (bag + stash), cheapest first — the 재배 화면 picker / hint. */
export function getOwnedSoils(sys: HousingSystem): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number }[] = [];
  for (const def of loot.getAllItemDefs()) {
    if (!def.soil) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty });
  }
  out.sort((a, b) => (sys.soilDef(a.defId)?.soil?.uses ?? 0) - (sys.soilDef(b.defId)?.soil?.uses ?? 0));
  return out;
}

/** Seed item defs the player owns (bag + stash), shortest grow time first. Still used by the 재배 화면. */
export function getOwnedSeeds(sys: HousingSystem): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number }[] = [];
  for (const def of loot.getAllItemDefs()) {
    if (!def.seed) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty });
  }
  out.sort((a, b) => (sys.seedDef(a.defId)?.seed?.growHours ?? 0) - (sys.seedDef(b.defId)?.seed?.growHours ?? 0));
  return out;
}

/* ── 한국어 게이트 ──────────────────────────────────────────────────────── */
/** Why `uid` / `tier` / `slot` is not a usable 칸 right now; null = fine. Every mutator starts here. */
function slotBlock(sys: HousingSystem, uid: string, tier: GrowTier, slot: number): string | null {
  const station = sys.stationOf(uid);
  if (!station) return '재배 스테이션이 아닙니다';
  if (tier !== 0 && tier !== 1 && tier !== 2) return '없는 재배층입니다';
  if (!growTierOpen(station.level, tier)) return `재배 스테이션을 Lv.${growTierUnlockLevel(tier)} 로 강화해야 열립니다`;
  if (!Number.isInteger(slot) || slot < 0 || slot >= GROW_SLOTS_PER_TIER) return '없는 재배 칸입니다';
  return null;
}

/* ── 칸 조작 ────────────────────────────────────────────────────────────── */
/**
 * Pour one soil item (bag → stash) into an empty 칸. `soilUsesLeft` starts at `ItemDef.soil.uses`.
 * 한국어 reason on failure, null on success.
 */
export function fillSoil(sys: HousingSystem, uid: string, tier: GrowTier, slot: number, soilDefId: string): string | null {
  const block = slotBlock(sys, uid, tier, slot);
  if (block) return block;
  if (sys.growSlotAt(uid, tier, slot)) return '이미 흙이 채워져 있습니다';
  const def = sys.soilDef(soilDefId);
  if (!def || !def.soil) return '토양이 아닙니다';
  if (sys.countDef(soilDefId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(soilDefId, 1)) return '토양을 꺼낼 수 없습니다';
  sys.grows().push({ uid, tier, slot, soilDefId, soilUsesLeft: Math.max(1, Math.floor(def.soil.uses)) });
  sys.growChanged(uid, 'soil');
  return null;
}

/**
 * Scrape a 칸 back to 흙 없음. **The soil is not returned** — 남은 횟수가 있어도 버려진다 (한 번 부은 흙은 다시
 * 담지 않는다, 사용자 결정). Refused while something is planted in it.
 */
export function clearSoil(sys: HousingSystem, uid: string, tier: GrowTier, slot: number): string | null {
  const block = slotBlock(sys, uid, tier, slot);
  if (block) return block;
  const g = sys.growSlotAt(uid, tier, slot);
  if (!g) return '흙이 없습니다';
  if (g.seedDefId) return '심어진 씨앗을 먼저 수확하세요';
  const list = sys.grows();
  list.splice(list.indexOf(g), 1);
  sys.growChanged(uid, 'soilClear');
  return null;
}

/**
 * Plant one seed (bag → stash, consumes 1) into a 칸 that already has soil. `readyAt` is fixed **here** from
 * `growHours × 궁합 × 원예`, so a later skill change or a different soil never moves a running timer.
 */
export function plantSeedAt(sys: HousingSystem, uid: string, tier: GrowTier, slot: number, seedDefId: string): string | null {
  const block = slotBlock(sys, uid, tier, slot);
  if (block) return block;
  const g = sys.growSlotAt(uid, tier, slot);
  if (!g) return '흙을 먼저 채우세요';
  if (g.seedDefId) return '이미 씨앗이 심어져 있습니다';
  const def = sys.seedDef(seedDefId);
  if (!def || !def.seed) return '씨앗이 아닙니다';
  if (sys.countDef(seedDefId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(seedDefId, 1)) return '씨앗을 꺼낼 수 없습니다';
  const soilTag: SoilTag | null = sys.soilDef(g.soilDefId)?.soil?.tag ?? null;
  const matched = soilMatches(soilTag, def.seed.soilTag);
  g.plantedAt = sys.nowMs();
  g.readyAt = g.plantedAt + growDurationMs(def.seed.growHours, matched, sys.gardening());
  g.seedDefId = seedDefId;
  sys.growChanged(uid, 'plant');
  return null;
}

/**
 * Harvest one ripe 칸 into the bag (stash fallback). Spends one `soilUsesLeft`: the 칸 empties completely at 0,
 * otherwise it goes back to 심을 준비가 된 흙.
 */
export function harvestAt(sys: HousingSystem, uid: string, tier: GrowTier, slot: number): string | null {
  const block = slotBlock(sys, uid, tier, slot);
  if (block) return block;
  const g = sys.growSlotAt(uid, tier, slot);
  if (!g || !g.seedDefId || !g.readyAt) return '심어진 씨앗이 없습니다';
  const now = sys.nowMs();
  if (now < g.readyAt) return `아직 자라는 중입니다 (${formatRemaining(Math.ceil((g.readyAt - now) / 1000))} 남음)`;
  const seed = sys.seedDef(g.seedDefId)?.seed ?? null;
  const loot = sys.ctx.loot;
  if (!seed || !loot || typeof loot.createItem !== 'function') return '수확물을 만들 수 없습니다';
  const qty = sys.yieldQty(seed.yieldQty);
  const item = loot.createItem(seed.yieldDefId, qty);
  const inv = sys.ctx.inventory;
  const where = inv && typeof inv.tryAddItemAnywhere === 'function'
    ? inv.tryAddItemAnywhere(item)
    : inv && typeof inv.tryAddItem === 'function' && inv.tryAddItem(item) ? 'bag' : null;
  if (!where) return '가방과 창고에 자리가 없습니다';
  // the soil is spent per harvest: at 0 the 칸 goes back to 흙 없음, otherwise it is ready to take a new seed
  delete g.seedDefId; delete g.plantedAt; delete g.readyAt;
  g.soilUsesLeft -= 1;
  if (g.soilUsesLeft <= 0) {
    const list = sys.grows();
    list.splice(list.indexOf(g), 1);
  }
  // the 원예 skill rises off `gather:collected`, exactly like a field herb node
  sys.ctx.bus.emit('gather:collected', { nodeId: `grow:${uid}:${tier}:${slot}`, defId: seed.yieldDefId, qty });
  sys.growChanged(uid, 'harvest');
  return null;
}

/** Harvest every ripe 칸 of the station; returns how many were taken. */
export function harvestAllStation(sys: HousingSystem, uid: string): number {
  const station = sys.stationOf(uid);
  if (!station) return 0;
  let taken = 0;
  for (const tier of growTiersForLevel(station.level)) {
    for (let slot = 0; slot < GROW_SLOTS_PER_TIER; slot++) {
      const g = sys.growSlotAt(uid, tier, slot);
      if (!g || !g.readyAt || sys.nowMs() < g.readyAt) continue;
      if (sys.harvestAt(uid, tier, slot) === null) taken++;
    }
  }
  return taken;
}

/** Open the 재배 화면 (`furn_grow_station` interaction): 좌 재배층 · 우 가방 + 함선 창고. */
export function openGrowStation(sys: HousingSystem, uid: string): void {
  if (!sys.growStation) return;
  if (!sys.stationOf(uid)) { sys.notify('재배 스테이션이 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.growStation.openStation(uid);
}

/* ── 은퇴한 재배층 (Phase 8 API) ─────────────────────────────────────────────
 * 계약은 **추가만** 한다는 규약대로 여섯 메서드가 그대로 남아 있지만, 그것들이 다루던 가구(`furn_grow_rack`)는
 * 은퇴했고 `ShipState.sanitize` 가 함선에서 걷어낸다. 그래서 전부 「없는 재배층」 응답이다 — 조용히 성공한
 * 척하지 않는다. `getOwnedSeeds` 만은 새 화면도 쓰므로 위에 살아 있다.
 * ────────────────────────────────────────────────────────────────────────── */

/** @deprecated 2026-09-11 (온실 개편) — 재배층은 은퇴했다. 언제나 빈 배열. */
export function getPlots(_sys: HousingSystem, _uid: string): GrowPlotInfo[] { return []; }

/** @deprecated 2026-09-11 (온실 개편) — `plantSeedAt` 을 쓴다. */
export function plantSeed(_sys: HousingSystem, _uid: string, _slot: number, _seedDefId: string): string | null { return RETIRED_RACK_REASON; }

/** @deprecated 2026-09-11 (온실 개편) — `harvestAt` 을 쓴다. */
export function harvestPlot(_sys: HousingSystem, _uid: string, _slot: number): string | null { return RETIRED_RACK_REASON; }

/** @deprecated 2026-09-11 (온실 개편) — `harvestAllStation` 을 쓴다. 언제나 0. */
export function harvestAll(_sys: HousingSystem, _uid: string): number { return 0; }

/** @deprecated 2026-09-11 (온실 개편) — `openGrowStation` 을 쓴다. 아무 일도 하지 않는다. */
export function openGrowMenu(_sys: HousingSystem, _uid: string): void { /* 재배층은 은퇴했다 */ }
