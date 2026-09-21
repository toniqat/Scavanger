/**
 * src/housing/parts/Garden.ts — **the greenhouse grow station** (greenhouse rework, 2026-09-11).
 *
 * 「A slot is two steps — pour the soil in (`fillSoil`), then plant a seed on it (`plantSeedAt`).」
 * The three tiers (top · middle · bottom; the tier ids never change) have **all been open at Lv.1 since 2026-09-13**, with
 * `GROW_SLOTS_PER_TIER` slots each. The furniture level raises the **growth speed** instead of tiers (`Rules.growStationSpeedMul`).
 * Growth is **real time** as before (`ctx.net.serverNow()` ?? `Date.now()`), and the soil match · the gardening skill · the
 * station speed are **fixed into `readyAt` the moment it is planted** — with one single exception, **an upgrade**: on the upgrade
 * a growing crop's timeline is compressed by the speed ratio (`rescaleGrowsForUpgrade`).
 *
 * **2026-09-13 (cooking material tiers)**: poured soil carries **durability** (`soilDurability`) and **sockets** (`sockets`).
 * It wears `SOIL_WEAR_PER_HARVEST` per harvest (a `wear` socket cuts that) and **the slot does not empty even at 0** — instead the match bonus and the sockets'
 * `speed` · `yield` shrink by the `durability / maximum` ratio and are gone at 0. `soilUsesLeft` stays because it is a contract field, but its meaning
 * changed to 「harvests left until durability 0」 (`Rules.harvestsUntilWorn`). An old save's slot moves its uses-left ratio into durability on the first read.
 *
 * The pure judgements (tier opening · the match · growth time · progress · wear) are all in `../Rules.ts`, and the socket rules are in `./Sockets.ts`.
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
 * The grow station slots. The save only shape-checks soil ids (`soil_*`); the first time `ctx.loot` is around, every id that
 * is no longer real soil is dropped here, and an unknown seed leaves plain soil behind (the same contract as the library's
 * `books()` — a def gone from the item table must not break the slot).
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
      // 2026-09-13: migrate the durability · sanitize the sockets (the rarity's slot count · soil sockets only)
      normalizeSoil(sys, g, true);
    }
  }
  return list;
}

/* ── soil durability (2026-09-13) ───────────────────────────────────────── */
/**
 * One soil kind's maximum durability — `SoilDef.durability`. With no value in the table (an old item table) it is read as the
 * old harvest count × the wear per harvest (so it reaches 0 after the same number of harvests as the old 「n 회」).
 */
export function soilMaxDurability(def: ItemDef | null | undefined): number {
  const s = def?.soil;
  if (!s) return 0;
  const d = (s as { durability?: number }).durability;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d;
  return Math.max(1, Math.floor(Number.isFinite(s.uses) ? s.uses : 1)) * Math.max(0, SOIL_WEAR_PER_HARVEST);
}

/**
 * Brings one slot's soil state in line with the rules: with no durability (an old save) it is moved over from the uses-left ratio,
 * clamped into the maximum, and `soilUsesLeft` is rewritten as 「harvests left until 0」. With `withSockets` the sockets are filtered too (one runtime sanitize — `grows()`). Does nothing when the soil def is unknown.
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

/** One set of the slot's soil numbers (the screen · planting · harvesting all look at the same values). All 0 when the soil def is unknown. */
function soilStats(sys: HousingSystem, g: GrowSlot): { max: number; dur: number; ratio: number; slots: number } {
  const def = sys.soilDef(g.soilDefId);
  if (!def) return { max: 0, dur: 0, ratio: 0, slots: 0 };
  normalizeSoil(sys, g, false);
  const max = soilMaxDurability(def);
  const dur = g.soilDurability ?? 0;
  return { max, dur, ratio: durabilityRatio(dur, max), slots: growSocketSlotsFor(def.rarity) };
}

/** The grow station behind `uid`, or null when it is not one (or gone). */
export function stationOf(sys: HousingSystem, uid: string): PlacedFurniture | null {
  const item = sys.getPlacedByUid(uid);
  return item && isGrowStationDefId(item.defId) ? item : null;
}

export function growSlotAt(sys: HousingSystem, uid: string, tier: GrowTier, slot: number): GrowSlot | null {
  return sys.grows().find((g) => g.uid === uid && g.tier === tier && g.slot === slot) ?? null;
}

/** Drop every slot of a station that is being recovered (its soil and crops go with it). */
export function dropGrowsOf(sys: HousingSystem, uid: string): void {
  const list = sys.grows();
  for (let i = list.length - 1; i >= 0; i--) if (list[i].uid === uid) list.splice(i, 1);
}

/** Ripe slots of a station (for the `housing:growChanged` payload and the hub's station visuals). */
export function readyCount(sys: HousingSystem, uid: string): number {
  const now = sys.stationNow(uid);
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

/** The soil def with its `soil` data, or null when `defId` is not soil. */
export function soilDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.soil ? def : null;
}

/** The `원예` gardening skill, 0..SKILL_LEVEL_MAX. */
export function gardening(sys: HousingSystem): number {
  const p = sys.ctx.progression;
  if (!p || typeof p.getSkill !== 'function') return 0;
  const v = p.getSkill('gardening');
  return Number.isFinite(v) ? Math.max(0, Math.min(SKILL_LEVEL_MAX, v)) : 0;
}

/** Harvest size after the gardening `gatherYieldMul` (at least one unit). */
export function yieldQty(sys: HousingSystem, base: number): number {
  const mul = sys.ctx.progression?.derived?.gatherYieldMul ?? 1;
  return Math.max(1, Math.round(base * (Number.isFinite(mul) && mul > 0 ? mul : 1)));
}

/* ── what the grow station screen reads ─────────────────────────────────── */
/**
 * Every slot of one station — **always `3 × GROW_SLOTS_PER_TIER`** in `GROW_TIER_DRAW_ORDER` (top → middle → bottom),
 * locked tiers included so the panel can draw the rows an upgrade will open. `[]` when `uid` is not a station.
 */
export function getGrowSlots(sys: HousingSystem, uid: string): GrowSlotInfo[] {
  const station = sys.stationOf(uid);
  if (!station) return [];
  const now = sys.stationNow(uid);
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
        // 2026-09-13: its meaning changed to 「harvests left until durability 0」 (the slot stays even at 0)
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

/** Soil item defs the player owns right now (bag + stash), lowest maximum durability first (2026-09-13 — the old order was by harvest count) — the grow station screen's hint. */
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

/** Seed item defs the player owns (bag + stash), shortest grow time first. Still used by the grow station screen. */
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

/* ── the Korean block reasons ───────────────────────────────────────────── */
/** Why `uid` / `tier` / `slot` is not a usable slot right now; null = fine. Every mutator starts here. */
function slotBlock(sys: HousingSystem, uid: string, tier: GrowTier, slot: number): string | null {
  const station = sys.stationOf(uid);
  if (!station) return '재배 스테이션이 아닙니다';
  if (tier !== 0 && tier !== 1 && tier !== 2) return '없는 재배층입니다';
  if (!growTierOpen(station.level, tier)) return `재배 스테이션을 Lv.${growTierUnlockLevel(tier)} 로 강화해야 열립니다`;
  if (!Number.isInteger(slot) || slot < 0 || slot >= GROW_SLOTS_PER_TIER) return '없는 재배 칸입니다';
  return null;
}

/* ── slot mutations ─────────────────────────────────────────────────────── */
/**
 * Pour one soil item (bag → stash) into an empty slot. 2026-09-13: durability at the maximum (`SoilDef.durability`), no sockets,
 * `soilUsesLeft` = harvests left until 0. A Korean reason on failure, null on success.
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
 * 2026-09-13: inserts one soil socket into poured soil (`HousingRef.insertGrowSocket`). The slot count = the soil's rarity
 * (`growSocketSlotsFor`); when full a `replaceIndex` is needed and the old socket is destroyed. It is not retroactive for a growing crop — `readyAt` is fixed at planting.
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
  // a `wear` socket may have changed — 「harvests left」 is rewritten
  if (g) normalizeSoil(sys, g, false);
  sys.growChanged(uid, 'socket');
  return null;
}

/**
 * Scrape a slot back to no soil. **The soil is not returned** — it is thrown away with uses left (soil once poured is never
 * scooped back, user's decision). Refused while something is planted in it.
 */
export function clearSoil(sys: HousingSystem, uid: string, tier: GrowTier, slot: number, discardCrop = false): string | null {
  const block = slotBlock(sys, uid, tier, slot);
  if (block) return block;
  const g = sys.growSlotAt(uid, tier, slot);
  if (!g) return '흙이 없습니다';
  // 2026-09-12: the pot's right-click 「작물 버리고 흙 비우기」 — it passes only when the crop was asked to go too
  if (g.seedDefId && !discardCrop) return '심어진 씨앗을 먼저 수확하세요';
  const list = sys.grows();
  list.splice(list.indexOf(g), 1);
  sys.growChanged(uid, 'soilClear');
  return null;
}

/**
 * Plant one seed (bag → stash, consumes 1) into a slot that already has soil. `readyAt` is fixed **here** from
 * `growHours × the match × gardening ÷ the station speed`, so a later skill change or a different soil never moves a running
 * timer — only an upgrade of the station does (`rescaleGrowsForUpgrade`, 2026-09-13).
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
  g.plantedAt = sys.stationNow(uid);
  const station = sys.stationOf(uid);
  // 2026-09-13: the match bonus · the socket speed apply as far as the soil durability ratio — fixed at planting
  const { ratio } = soilStats(sys, g);
  g.readyAt = g.plantedAt + growDurationMs(def.seed.growHours, matched, sys.gardening(), station?.level ?? 1, ratio, socketSum(sys, g.sockets, 'speed'));
  g.seedDefId = seedDefId;
  sys.growChanged(uid, 'plant');
  return null;
}

/**
 * **The rescale at the moment of an upgrade** (2026-09-13, user's decision). When the station rises `fromLevel` → `toLevel`, the
 * timeline of every crop growing in it is compressed by the speed ratio (`growStationSpeedMul(from) / growStationSpeedMul(to)`)
 * **around now** — the time left shrinks by that much and the progress carries on unbroken (`Rules.rescaleGrowTimes`). A crop
 * already ripe · a slot holding only soil are left alone. It is the one exception to 「`readyAt` is fixed at planting」.
 * `parts/Furniture.upgradeFurniture` calls it right after raising the level (before `housing:changed`, so it rides into the same save). Returns how many slots changed.
 */
export function rescaleGrowsForUpgrade(sys: HousingSystem, uid: string, fromLevel: number, toLevel: number): number {
  const oldMul = growStationSpeedMul(fromLevel);
  const newMul = growStationSpeedMul(toLevel);
  if (newMul <= oldMul) return 0;
  const now = sys.stationNow(uid);
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
 * Harvest one ripe slot into the bag (stash fallback). 2026-09-13: the quantity = the harvest with the gardening multiplier + the
 * `yield` socket bonus (the ratio **before** the wear), then the soil wears `SOIL_WEAR_PER_HARVEST` (× the `wear` sockets) — **the slot does not empty** and goes back to soil ready to be planted.
 */
export function harvestAt(sys: HousingSystem, uid: string, tier: GrowTier, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, tier, slot);
  if (block) return block;
  const g = sys.growSlotAt(uid, tier, slot);
  if (!g || !g.seedDefId || !g.readyAt) return '심어진 씨앗이 없습니다';
  const now = sys.stationNow(uid);
  if (now < g.readyAt) return `아직 자라는 중입니다 (${formatRemaining(Math.ceil((g.readyAt - now) / 1000))} 남음)`;
  const seed = sys.seedDef(g.seedDefId)?.seed ?? null;
  const loot = sys.ctx.loot;
  if (!seed || !loot || typeof loot.createItem !== 'function') return '수확물을 만들 수 없습니다';
  const { ratio } = soilStats(sys, g);
  const qty = sys.yieldQty(seed.yieldQty) + yieldBonus(sys, g.sockets, ratio, Math.random);
  const item = loot.createItem(seed.yieldDefId, qty);
  if (!deliverItem(sys, item, dest)) return noRoomReason(dest);
  // 2026-09-13: the soil wears per harvest but the slot never empties by itself — at 0 the bonuses are simply gone
  delete g.seedDefId; delete g.plantedAt; delete g.readyAt;
  g.soilDurability = wearAfterHarvest(g.soilDurability ?? 0, SOIL_WEAR_PER_HARVEST, socketSum(sys, g.sockets, 'wear'));
  normalizeSoil(sys, g, false);
  // the gardening skill rises off `gather:collected`, exactly like a field herb node
  sys.ctx.bus.emit('gather:collected', { nodeId: `grow:${uid}:${tier}:${slot}`, defId: seed.yieldDefId, qty });
  sys.growChanged(uid, 'harvest');
  return null;
}

/** Harvest every ripe slot of the station; returns how many were taken. */
export function harvestAllStation(sys: HousingSystem, uid: string): number {
  const station = sys.stationOf(uid);
  if (!station) return 0;
  let taken = 0;
  for (const tier of growTiersForLevel(station.level)) {
    for (let slot = 0; slot < GROW_SLOTS_PER_TIER; slot++) {
      const g = sys.growSlotAt(uid, tier, slot);
      if (!g || !g.readyAt || sys.stationNow(uid) < g.readyAt) continue;
      if (sys.harvestAt(uid, tier, slot) === null) taken++;
    }
  }
  return taken;
}

/** Open the grow station screen (`furn_grow_station` interaction): the tiers on the left · bag + ship stash on the right. */
export function openGrowStation(sys: HousingSystem, uid: string): void {
  if (!sys.growStation) return;
  if (!sys.stationOf(uid)) { sys.notify('재배 스테이션이 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.growStation.openStation(uid);
}

/* ── the retired grow rack (Phase 8 API) ─────────────────────────────────────
 * The contract is **add-only**, so the six methods are still here, but the furniture they worked on (`furn_grow_rack`) is
 * retired and `ShipState.sanitize` sweeps it out of the ship. So they all answer 「there is no grow rack」 — none of them
 * pretends to succeed quietly. Only `getOwnedSeeds` is still alive above, because the new screen uses it too.
 * ────────────────────────────────────────────────────────────────────────── */

/** @deprecated 2026-09-11 (greenhouse rework) — the grow rack is retired. Always an empty array. */
export function getPlots(_sys: HousingSystem, _uid: string): GrowPlotInfo[] { return []; }

/** @deprecated 2026-09-11 (greenhouse rework) — use `plantSeedAt`. */
export function plantSeed(_sys: HousingSystem, _uid: string, _slot: number, _seedDefId: string): string | null { return RETIRED_RACK_REASON; }

/** @deprecated 2026-09-11 (greenhouse rework) — use `harvestAt`. */
export function harvestPlot(_sys: HousingSystem, _uid: string, _slot: number): string | null { return RETIRED_RACK_REASON; }

/** @deprecated 2026-09-11 (greenhouse rework) — use `harvestAllStation`. Always 0. */
export function harvestAll(_sys: HousingSystem, _uid: string): number { return 0; }

/** @deprecated 2026-09-11 (greenhouse rework) — use `openGrowStation`. Does nothing. */
export function openGrowMenu(_sys: HousingSystem, _uid: string): void { /* the grow rack is retired */ }
