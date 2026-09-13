/**
 * src/housing/parts/Garden.ts — **온실 재배 스테이션** (온실 개편, 2026-09-11).
 *
 * 「한 칸은 두 단계다 — 흙을 붓고(`fillSoil`), 그 위에 씨앗을 심는다(`plantSeedAt`).」
 * 재배층 세 층(위 · 중앙 · 아래, 층 id 는 그대로)은 **2026-09-13 부터 Lv.1 에서 모두 열려 있고**, 한 층에
 * `GROW_SLOTS_PER_TIER` 칸이다. 가구 레벨은 층 대신 **성장 속도**를 올린다(`Rules.growStationSpeedMul`).
 * 성장은 예전처럼 **실제 시간**(`ctx.net.serverNow()` ?? `Date.now()`)이고, 토양 궁합 · 원예 숙련 · 스테이션 속도는
 * **심는 순간 `readyAt` 에 확정**된다 — 단 하나의 예외는 **강화**다: 강화하는 순간 자라던 작물의 타임라인이 속도
 * 비율로 압축된다(`rescaleGrowsForUpgrade`).
 *
 * **2026-09-13 (요리 재료 티어 — docs/plans/food-tiers.md §4.4)**: 부어 둔 흙에는 **내구도**(`soilDurability`)와 **소켓**(`sockets`)이
 * 있다. 수확마다 `SOIL_WEAR_PER_HARVEST` 만큼 닳고(`wear` 소켓이 줄인다) **0 이어도 칸이 비지 않는다** — 대신 궁합 보너스와 소켓
 * `speed` · `yield` 가 `내구도 / 최대` 비율로 줄어 0 에서는 사라진다. `soilUsesLeft` 는 계약상 필드라 남기되 뜻이
 * 「내구도 0 까지 남은 수확 횟수」로 바뀌었다(`Rules.harvestsUntilWorn`). 옛 세이브의 칸은 처음 읽을 때 남은 횟수 비율로 내구도를 옮긴다.
 *
 * 순수 판정(층 개방 · 궁합 · 성장 시간 · 진행도 · 마모)은 전부 `../Rules.ts` 에 있고, 소켓 규칙은 `./Sockets.ts` 에 있다.
 */
import type { GrowPlotInfo, GrowSlot, GrowSlotInfo, GrowTier, HarvestDestination, ItemDef, PlacedFurniture, SoilTag } from '@/shared';
import { GROW_SLOTS_PER_TIER, GROW_TIER_DRAW_ORDER, SKILL_LEVEL_MAX, SOIL_WEAR_PER_HARVEST, growSocketSlotsFor, growTiersForLevel } from '@/shared';
import {
  durabilityFromUses, durabilityRatio, growDurationMs, growProgress, growRemainingS, growStationSpeedMul, growTierOpen, growTierUnlockLevel,
  harvestsUntilWorn, rescaleGrowTimes, soilMatches, wearAfterHarvest,
} from '../Rules';
import { insertSocket, sanitizeSocketIds, socketSum, yieldBonus } from './Sockets';
import { isGrowStationDefId } from '../ShipState';
import { formatRemaining } from '../ui/dom';
import { RETIRED_RACK_REASON } from '../model';
import { deliverItem, noRoomReason } from './Deliver';
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
      // 2026-09-13: 내구도 이관 · 소켓 정리 (등급 칸 수 · 흙 소켓만)
      normalizeSoil(sys, g, true);
    }
  }
  return list;
}

/* ── 흙 내구도 (2026-09-13) ─────────────────────────────────────────────── */
/**
 * 흙 한 종류의 최대 내구도 — `SoilDef.durability`. 표에 값이 없으면(옛 아이템 표) 옛 수확 횟수 × 수확당 마모로 읽는다
 * (그러면 옛 「n 회」와 같은 수확 뒤에 0 이 된다).
 */
export function soilMaxDurability(def: ItemDef | null | undefined): number {
  const s = def?.soil;
  if (!s) return 0;
  const d = (s as { durability?: number }).durability;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d;
  return Math.max(1, Math.floor(Number.isFinite(s.uses) ? s.uses : 1)) * Math.max(0, SOIL_WEAR_PER_HARVEST);
}

/**
 * 한 칸의 흙 상태를 규칙에 맞춘다: 내구도가 없으면(옛 세이브) 남은 횟수 비율로 옮기고, 최대 안으로 자르고, `soilUsesLeft` 를
 * 「0 까지 남은 수확」으로 다시 적는다. `withSockets` 면 소켓도 거른다 (런타임 정리 한 번 — `grows()`). 흙 def 를 모르면 아무것도 안 한다.
 */
function normalizeSoil(sys: HousingSystem, g: GrowSlot, withSockets: boolean): void {
  const def = sys.soilDef(g.soilDefId);
  if (!def || !def.soil) return;
  const max = soilMaxDurability(def);
  if (typeof g.soilDurability !== 'number' || !Number.isFinite(g.soilDurability)) {
    g.soilDurability = durabilityFromUses(max, g.soilUsesLeft, def.soil.uses);
  }
  g.soilDurability = Math.max(0, Math.min(max, g.soilDurability));
  if (withSockets || !Array.isArray(g.sockets)) g.sockets = sanitizeSocketIds(sys, g.sockets ?? [], 'soil', growSocketSlotsFor(def.rarity));
  g.soilUsesLeft = harvestsUntilWorn(g.soilDurability, SOIL_WEAR_PER_HARVEST, socketSum(sys, g.sockets, 'wear'));
}

/** 칸의 흙 수치 한 벌 (화면 · 파종 · 수확이 같은 값을 본다). 흙 def 를 모르면 전부 0. */
function soilStats(sys: HousingSystem, g: GrowSlot): { max: number; dur: number; ratio: number; slots: number } {
  const def = sys.soilDef(g.soilDefId);
  if (!def) return { max: 0, dur: 0, ratio: 0, slots: 0 };
  normalizeSoil(sys, g, false);
  const max = soilMaxDurability(def);
  const dur = g.soilDurability ?? 0;
  return { max, dur, ratio: durabilityRatio(dur, max), slots: growSocketSlotsFor(def.rarity) };
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
      const st = g ? soilStats(sys, g) : null;
      out.push({
        tier, slot, locked, unlockLevel,
        soilDefId: g?.soilDefId ?? null,
        soilTag: soil?.tag ?? null,
        // 2026-09-13: 뜻이 「내구도 0 까지 남은 수확 횟수」로 바뀌었다 (0 이어도 칸은 남는다)
        soilUsesLeft: g?.soilUsesLeft ?? 0,
        soilDurability: st?.dur ?? 0,
        soilDurabilityMax: st?.max ?? 0,
        soilBonusRatio: st?.ratio ?? 0,
        sockets: g?.sockets ? [...g.sockets] : [],
        socketSlots: st?.slots ?? 0,
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

/** Soil item defs the player owns right now (bag + stash), 최대 내구도가 낮은 것부터 (2026-09-13 — 옛 기준은 수확 횟수) — the 재배 화면 hint. */
export function getOwnedSoils(sys: HousingSystem): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number }[] = [];
  for (const def of loot.getAllItemDefs()) {
    if (!def.soil) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty });
  }
  out.sort((a, b) => soilMaxDurability(sys.soilDef(a.defId)) - soilMaxDurability(sys.soilDef(b.defId)));
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
 * Pour one soil item (bag → stash) into an empty 칸. 2026-09-13: 내구도는 최대(`SoilDef.durability`), 소켓은 없음,
 * `soilUsesLeft` = 0 까지 남은 수확. 한국어 reason on failure, null on success.
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
  const max = soilMaxDurability(def);
  sys.grows().push({
    uid, tier, slot, soilDefId,
    soilDurability: max, sockets: [],
    soilUsesLeft: harvestsUntilWorn(max, SOIL_WEAR_PER_HARVEST, 0),
  });
  sys.growChanged(uid, 'soil');
  return null;
}

/**
 * 2026-09-13: 부어 둔 흙에 토양 소켓 하나를 끼운다 (`HousingRef.insertGrowSocket`). 칸 수 = 흙 등급(`growSocketSlotsFor`),
 * 가득 차면 `replaceIndex` 가 필요하고 옛 소켓은 파괴된다. 자라는 작물에는 소급하지 않는다 — `readyAt` 은 심는 순간 확정이다.
 */
export function insertGrowSocket(
  sys: HousingSystem, uid: string, tier: GrowTier, slot: number, socketDefId: string, replaceIndex?: number,
): string | null {
  const block = slotBlock(sys, uid, tier, slot);
  if (block) return block;
  const g = sys.growSlotAt(uid, tier, slot);
  const slots = g ? soilStats(sys, g).slots : 0;
  const err = insertSocket(sys, g, 'soil', socketDefId, slots, replaceIndex);
  if (err) return err;
  // wear 소켓이 바뀌었을 수 있다 — 「남은 수확」을 다시 적는다
  if (g) normalizeSoil(sys, g, false);
  sys.growChanged(uid, 'socket');
  return null;
}

/**
 * Scrape a 칸 back to 흙 없음. **The soil is not returned** — 남은 횟수가 있어도 버려진다 (한 번 부은 흙은 다시
 * 담지 않는다, 사용자 결정). Refused while something is planted in it.
 */
export function clearSoil(sys: HousingSystem, uid: string, tier: GrowTier, slot: number, discardCrop = false): string | null {
  const block = slotBlock(sys, uid, tier, slot);
  if (block) return block;
  const g = sys.growSlotAt(uid, tier, slot);
  if (!g) return '흙이 없습니다';
  // 2026-09-12: 흙구멍 우클릭 「작물 버리고 흙 비우기」 — 작물까지 버리겠다고 한 경우만 통과한다
  if (g.seedDefId && !discardCrop) return '심어진 씨앗을 먼저 수확하세요';
  const list = sys.grows();
  list.splice(list.indexOf(g), 1);
  sys.growChanged(uid, 'soilClear');
  return null;
}

/**
 * Plant one seed (bag → stash, consumes 1) into a 칸 that already has soil. `readyAt` is fixed **here** from
 * `growHours × 궁합 × 원예 ÷ 스테이션 속도`, so a later skill change or a different soil never moves a running timer —
 * only an upgrade of the station does (`rescaleGrowsForUpgrade`, 2026-09-13).
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
  const station = sys.stationOf(uid);
  // 2026-09-13: 궁합 보너스 · 소켓 speed 는 흙 내구도 비율만큼 — 심는 순간 확정
  const { ratio } = soilStats(sys, g);
  g.readyAt = g.plantedAt + growDurationMs(def.seed.growHours, matched, sys.gardening(), station?.level ?? 1, ratio, socketSum(sys, g.sockets, 'speed'));
  g.seedDefId = seedDefId;
  sys.growChanged(uid, 'plant');
  return null;
}

/**
 * **강화 순간의 재조정** (2026-09-13, 사용자 결정). 스테이션이 `fromLevel` → `toLevel` 로 오르면 그 스테이션에서
 * 자라는 작물의 타임라인을 속도 비율(`growStationSpeedMul(from) / growStationSpeedMul(to)`)로 **지금을 축으로**
 * 압축한다 — 남은 시간이 그만큼 줄고 진행도는 그대로 이어진다 (`Rules.rescaleGrowTimes`). 이미 여문 작물 · 흙만 있는
 * 칸은 건드리지 않는다. 「readyAt 은 심는 순간 확정」의 유일한 예외다. `parts/Furniture.upgradeFurniture` 가 레벨을 올린
 * 직후 부른다 (`housing:changed` 가 나기 전이라 저장에 같이 실린다). 바뀐 칸 수를 돌려준다.
 */
export function rescaleGrowsForUpgrade(sys: HousingSystem, uid: string, fromLevel: number, toLevel: number): number {
  const oldMul = growStationSpeedMul(fromLevel);
  const newMul = growStationSpeedMul(toLevel);
  if (newMul <= oldMul) return 0;
  const now = sys.nowMs();
  let n = 0;
  for (const g of sys.grows()) {
    if (g.uid !== uid || !g.seedDefId || !g.plantedAt || !g.readyAt || now >= g.readyAt) continue;
    const next = rescaleGrowTimes(now, g.plantedAt, g.readyAt, oldMul, newMul);
    g.plantedAt = next.plantedAt;
    g.readyAt = next.readyAt;
    n++;
  }
  return n;
}

/**
 * Harvest one ripe 칸 into the bag (stash fallback). 2026-09-13: 수량 = 원예 배수 적용 수확량 + `yield` 소켓 덤(마모 **전** 비율),
 * 그 뒤 흙이 `SOIL_WEAR_PER_HARVEST`(× `wear` 소켓) 만큼 닳는다 — **칸은 비지 않고** 심을 준비가 된 흙으로 돌아간다.
 */
export function harvestAt(sys: HousingSystem, uid: string, tier: GrowTier, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, tier, slot);
  if (block) return block;
  const g = sys.growSlotAt(uid, tier, slot);
  if (!g || !g.seedDefId || !g.readyAt) return '심어진 씨앗이 없습니다';
  const now = sys.nowMs();
  if (now < g.readyAt) return `아직 자라는 중입니다 (${formatRemaining(Math.ceil((g.readyAt - now) / 1000))} 남음)`;
  const seed = sys.seedDef(g.seedDefId)?.seed ?? null;
  const loot = sys.ctx.loot;
  if (!seed || !loot || typeof loot.createItem !== 'function') return '수확물을 만들 수 없습니다';
  const { ratio } = soilStats(sys, g);
  const qty = sys.yieldQty(seed.yieldQty) + yieldBonus(sys, g.sockets, ratio, Math.random);
  const item = loot.createItem(seed.yieldDefId, qty);
  if (!deliverItem(sys, item, dest)) return noRoomReason(dest);
  // 2026-09-13: the soil wears per harvest but the 칸 never empties by itself — at 0 the bonuses are simply gone
  delete g.seedDefId; delete g.plantedAt; delete g.readyAt;
  g.soilDurability = wearAfterHarvest(g.soilDurability ?? 0, SOIL_WEAR_PER_HARVEST, socketSum(sys, g.sockets, 'wear'));
  normalizeSoil(sys, g, false);
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
