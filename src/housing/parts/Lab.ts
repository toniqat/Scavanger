/**
 * src/housing/parts/Lab.ts — **the lab analyzer** (A-12, 2026-09-11 · result table rework 2026-09-13).
 *
 * 「A sample put in is analysed for that much real time; collecting it gives one product and that family's analysis XP.」
 * Analysis slots are opened by the furniture level (the count per level is `analyzerSlotsForLevel` in the contract —
 * 2026-09-15 2nd pass, user's decision) and **slot numbers do not shift on an upgrade** — a running analysis must never
 * move to another slot.
 *
 * **2026-09-13 (cooking material tiers)**: a sample is analysed by its **family**
 * (`SampleDef.family` — cell · mineral · DNA). On insertion ① that family's **analysis level** (`ShipState.analysisXp` →
 * `analysisLevelForXp`) fixes the time (`Rules.analysisDurationMs`), ② the result table (`ANALYSIS_RESULTS`) is **rolled now**
 * at that level into the slot (`resultDefId` · `resultQty` — a failed collect never re-rolls; an empty table falls back to the
 * sample's `rewardDefId`). Collecting gives that one product (no first-analysis bonus) and adds `ANALYSIS_XP_BY_RARITY[sample
 * rarity]` to that family; a new level raises `housing:analysisLevelUp`, a first-time product goes into the analysis catalogue
 * (`ShipState.analysisFound`) and raises `housing:analysisFound`, while the old sample catalogue (`sampleDex`) fills quietly with
 * no `housing:sampleDexAdded`. An unrolled old slot rolls **when collected**, at that level. Retired samples are analysed too.
 *
 * **2026-09-16 (the sample rework — user's decision)**: two more rules, both turning on **the sample's rarity**.
 *  ① **The rarity floor** — the roll keeps only rows with `rarityRank(product) ≥ rarityRank(sample)`. A row whose `sampleRarity`
 *     column is set in `data/analysis_results.csv` is that rarity's own and skips the floor (미확인 광물 → 석영, also an empty-pool guard).
 *  ② **A shorter analysis time** — `min(CAP, catalogue entries of the same rarity × PER_ENTRY + the sample level bonus)`. A sample's
 *     level (`ShipState.sampleLevels`) is **how often it was collected**, and `ANALYSIS_SAMPLE_LEVEL_FIRST` far outweighs the
 *     per-level `ANALYSIS_SAMPLE_LEVEL_STEP` after it (`data/constants.csv`) — 「a big bonus the first time it is registered」 **is**
 *     that gap. The family's analysis level time multiplier is multiplied in **separately** from this.
 *
 * The pure judgements (analysis time · speedup · the result roll · chance · progress · seconds left) are all in `../Rules.ts`; this file changes state.
 */
import type {
  AnalysisLevelInfo, AnalysisResultInfo, AnalysisSlot, AnalysisSlotInfo, HarvestDestination, ItemDef, PlacedFurniture, Rarity,
  SampleAnalysisInfo, SampleFamily,
} from '@/shared';
import {
  ANALYSIS_LEVEL_MAX, ANALYSIS_RESULTS, ANALYSIS_SAMPLE_LEVEL_MAX, ANALYSIS_XP_BY_RARITY, ANALYZER_MAX_SLOTS, RARITY_ORDER,
  RESEARCH_XP_ANALYSIS, SAMPLE_FAMILIES,
  analysisLevelForXp, analysisTimeMul, analysisXpForLevel, analyzerSlotUnlockLevel, analyzerSlotsForLevel,
} from '@/shared';
import type { AnalysisRollOpts } from '../Rules';
import {
  analysisChances, analysisDexBonus, analysisDurationMs, analysisLevelBonus, analysisSpeedup,
  growProgress, growRemainingS, rollAnalysisResult,
} from '../Rules';
import { isAnalyzerDefId } from '../ShipState';
import { formatRemaining } from '../ui/dom';
import type { HousingSystem } from '../HousingSystem';
import { deliverItem, noRoomReason } from './Deliver';

/* ── state access ──────────────────────────────────────────────────────── */
/**
 * The analysis slots. The save only shape-checks sample ids (`spec_*`); the first time `ctx.loot` is around, every id that is
 * no longer a real sample is dropped here (the same contract as the library's `books()` · the greenhouse's `grows()` — a def
 * gone from the item table must not break the analyzer). A retired sample (`ItemDef.retired`) keeps its `sample` data, so it stays.
 */
export function analyses(sys: HousingSystem): AnalysisSlot[] {
  if (!Array.isArray(sys.state.analyses)) sys.state.analyses = [];
  const list = sys.state.analyses;
  if (!sys.analysesPruned && sys.ctx?.loot && typeof sys.ctx.loot.getItemDef === 'function') {
    sys.analysesPruned = true;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!sys.defOf(list[i].sampleDefId)?.sample) {
        console.warn(`[housing] unknown sample '${list[i].sampleDefId}' dropped from 분석기 ${list[i].uid}`);
        list.splice(i, 1);
      }
    }
  }
  return list;
}

/** The old analysis catalogue (append-only: samples collected at least once). Off screen since 2026-09-13 but still filled quietly. */
export function sampleDex(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.sampleDex)) sys.state.sampleDex = [];
  return sys.state.sampleDex;
}

/** 2026-09-13: cumulative analysis XP per family (`ShipState.analysisXp`). */
function analysisXp(sys: HousingSystem): Partial<Record<SampleFamily, number>> {
  const cur = sys.state.analysisXp;
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) sys.state.analysisXp = {};
  return sys.state.analysisXp!;
}

/** 2026-09-13: the analysis catalogue — def ids of products ever collected from an analyzer (append-only). */
function analysisFound(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.analysisFound)) sys.state.analysisFound = [];
  return sys.state.analysisFound;
}

/** 2026-09-16: sample def id → analysis level (= how often it was collected). A missing key = level 0. */
function sampleLevels(sys: HousingSystem): Record<string, number> {
  const cur = sys.state.sampleLevels;
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) sys.state.sampleLevels = {};
  return sys.state.sampleLevels!;
}

/** The analyzer behind `uid`, or null when it is not one (or gone). */
export function analyzerOf(sys: HousingSystem, uid: string): PlacedFurniture | null {
  const item = sys.getPlacedByUid(uid);
  return item && isAnalyzerDefId(item.defId) ? item : null;
}

export function analysisAt(sys: HousingSystem, uid: string, slot: number): AnalysisSlot | null {
  return sys.analyses().find((a) => a.uid === uid && a.slot === slot) ?? null;
}

/** Drop every analysis slot of an analyzer that is being recovered (the samples go with it). */
export function dropAnalysesOf(sys: HousingSystem, uid: string): void {
  const list = sys.analyses();
  for (let i = list.length - 1; i >= 0; i--) if (list[i].uid === uid) list.splice(i, 1);
}

/** Finished slots of an analyzer (the `housing:analysisChanged` payload and the hub's glowing window). */
export function readyAnalyses(sys: HousingSystem, uid: string): number {
  const now = sys.stationNow(uid);
  return sys.analyses().filter((a) => a.uid === uid && now >= a.readyAt).length;
}

export function analysisChanged(sys: HousingSystem, uid: string, reason: string): void {
  sys.changed(reason);
  sys.ctx.bus.emit('housing:analysisChanged', { uid, ready: sys.readyAnalyses(uid) });
}

/* ── item lookups ──────────────────────────────────────────────────────── */
/** The sample def with its `sample` data, or null when `defId` is not a sample. */
export function sampleDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.sample ? def : null;
}

/** Every sample def the item table knows (retired ones included — they still analyse). */
function allSampleDefs(sys: HousingSystem): readonly ItemDef[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  return loot.getAllItemDefs().filter((d) => !!d.sample);
}

/** The sample's family. With no family in the table (an old item table) it counts as `cell`. */
function familyOfDef(def: ItemDef | null | undefined): SampleFamily {
  const f = (def?.sample as { family?: unknown } | undefined)?.family;
  return typeof f === 'string' && (SAMPLE_FAMILIES as readonly string[]).includes(f) ? (f as SampleFamily) : 'cell';
}

/** Can this item be received as an analysis result · fallback product — it is in the item table and not retired. */
function resultDefOk(sys: HousingSystem): (defId: string) => boolean {
  return (defId) => {
    const d = sys.defOf(defId);
    return !!d && !d.retired;
  };
}

/** The family's current analysis level (1 … `ANALYSIS_LEVEL_MAX`). */
function levelOf(sys: HousingSystem, family: SampleFamily): number {
  return analysisLevelForXp(analysisXp(sys)[family] ?? 0);
}

/* ── 2026-09-16 (user's decision): the rarity floor · the sample level speedup ─
 * Both rules turn on **the sample's rarity**:
 *  ① The roll — the product's rarity must be at least the sample's (`AnalysisRollOpts` of `Rules.rollAnalysisResult`).
 *  ② The catalogue bonus — catalogue entries are counted **per product rarity** and shorten that rarity's analysis time.
 * Item rarity lives only in ctx's item table, so it is handed to the pure rules **as a callback** (`Rules.ts` knows no ctx).
 * ────────────────────────────────────────────────────────────────────────── */

/** A def's rarity (null when it is not in the item table — the pure rules then let the floor check pass). */
function rarityOf(sys: HousingSystem): (defId: string) => Rarity | null {
  return (defId) => sys.defOf(defId)?.rarity ?? null;
}

/** The options handed to the roll — the sample's rarity (the floor) + a product rarity lookup. */
function rollOpts(sys: HousingSystem, sampleRarity?: Rarity): AnalysisRollOpts {
  return { sampleRarity, rarityOf: rarityOf(sys) };
}

/** Analysis catalogue (`analysisFound`) entries counted **per product rarity** — exactly the axis the catalogue bonus groups on. */
export function getAnalysisDexByRarity(sys: HousingSystem): Record<Rarity, number> {
  const out = Object.fromEntries(RARITY_ORDER.map((r) => [r, 0])) as Record<Rarity, number>;
  const rar = rarityOf(sys);
  for (const id of analysisFound(sys)) {
    const r = rar(id);
    if (r) out[r]++;
  }
  return out;
}

/**
 * One sample's analysis speedup state (`HousingRef.getSampleAnalysis`). null when it is not a sample.
 * speedup = min(CAP, catalogue entries of the same rarity × PER_ENTRY + the sample level bonus) — the formula is `Rules.analysisSpeedup`.
 */
export function getSampleAnalysis(sys: HousingSystem, defId: string): SampleAnalysisInfo | null {
  const def = sys.sampleDef(defId);
  if (!def) return null;
  const level = sampleLevelOf(sys, defId);
  const dexEntries = getAnalysisDexByRarity(sys)[def.rarity] ?? 0;
  return {
    defId, rarity: def.rarity, level, maxLevel: ANALYSIS_SAMPLE_LEVEL_MAX, dexEntries,
    dexBonus: analysisDexBonus(dexEntries),
    levelBonus: analysisLevelBonus(level),
    speedup: analysisSpeedup(dexEntries, level),
  };
}

/** This sample's current level (0 … `ANALYSIS_SAMPLE_LEVEL_MAX`). */
function sampleLevelOf(sys: HousingSystem, defId: string): number {
  const v = sampleLevels(sys)[defId];
  return Number.isFinite(v) ? Math.max(0, Math.min(ANALYSIS_SAMPLE_LEVEL_MAX, Math.floor(v))) : 0;
}

/** The speedup on this sample right now (0 … `ANALYSIS_SPEEDUP_CAP`). 0 when it is not a sample. */
function speedupOf(sys: HousingSystem, def: ItemDef | null): number {
  if (!def) return 0;
  return analysisSpeedup(getAnalysisDexByRarity(sys)[def.rarity] ?? 0, sampleLevelOf(sys, def.id));
}

/* ── 2026-09-13 (H3): the `연구` research skill — a shorter analysis time ── */
/** The research skill's analysis time multiplier (`derived.researchTimeMul`, 1 = unchanged). 1 with no progression, or a bad value. */
export function researchTimeMul(sys: HousingSystem): number {
  const v = sys.ctx?.progression?.derived?.researchTimeMul;   // ctx may not exist yet when the analysis screen calls this from its constructor
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * The analysis time (ms) a sample put in now would take — `Rules.analysisDurationMs(hours, family level, sample speedup) × the research multiplier`, at least 1000 ms.
 * **Fixed the moment it goes in** (`startAnalysis` writes `readyAt` from it — a catalogue entry or a skill level gained later never moves a running analysis).
 */
export function analysisMsFor(sys: HousingSystem, analyzeHours: number, level: number, speedup = 0): number {
  return Math.max(1000, Math.round(analysisDurationMs(analyzeHours, level, speedup) * researchTimeMul(sys)));
}

/** Roll the result once — with an empty result table the sample's fallback product (`rewardDefId`), and null when even that cannot be given. */
function rollResult(sys: HousingSystem, def: ItemDef, family: SampleFamily, level: number): { defId: string; qty: number } | null {
  // 2026-09-16: the sample's rarity is the floor of the product's rarity (a row with `sampleRarity` set is that rarity's own + exempt)
  const rolled = rollAnalysisResult(family, level, Math.random, resultDefOk(sys), rollOpts(sys, def.rarity));
  if (rolled) return rolled;
  const s = def.sample;
  if (!s || !s.rewardDefId || !sys.defOf(s.rewardDefId)) return null;
  return { defId: s.rewardDefId, qty: Math.max(1, Math.floor(Number.isFinite(s.rewardQty) ? s.rewardQty : 1)) };
}

/* ── what the analysis screen reads ─────────────────────────────────────── */
/**
 * Every analysis slot of one analyzer — **always `ANALYZER_MAX_SLOTS`** in slot order, locked ones included so the panel can
 * draw the slots an upgrade will open. `[]` when `uid` is not an analyzer. 2026-09-13: the result (`resultDefId` · `rewardDefId`)
 * is filled **only on a finished slot**, and `firstTime` = it is finished and that result is not in the analysis catalogue.
 */
export function getAnalyses(sys: HousingSystem, uid: string): AnalysisSlotInfo[] {
  const analyzer = sys.analyzerOf(uid);
  if (!analyzer) return [];
  const now = sys.stationNow(uid);
  const open = analyzerSlotsForLevel(analyzer.level);
  const found = analysisFound(sys);
  const out: AnalysisSlotInfo[] = [];
  for (let slot = 0; slot < ANALYZER_MAX_SLOTS; slot++) {
    const locked = slot >= open;
    const a = locked ? null : sys.analysisAt(uid, slot);
    const ready = !!a && now >= a.readyAt;
    const resultDefId = ready && a?.resultDefId ? a.resultDefId : null;
    const resultQty = resultDefId ? Math.max(1, Math.floor(a?.resultQty ?? 1)) : 0;
    out.push({
      slot, locked, unlockLevel: analyzerSlotUnlockLevel(slot),
      sampleDefId: a?.sampleDefId ?? null,
      // progress · seconds left are the same pure time arithmetic as the greenhouse's (those two in `Rules` know of no crop or sample)
      progress: growProgress(now, a?.startedAt, a?.readyAt),
      remainingS: growRemainingS(now, a?.readyAt),
      ready,
      rewardDefId: resultDefId,
      rewardQty: resultQty,
      firstTime: !!resultDefId && !found.includes(resultDefId),
      family: a ? a.family ?? familyOfDef(sys.sampleDef(a.sampleDefId)) : null,
      resultDefId,
      resultQty,
    });
  }
  return out;
}

/** Sample item defs the player owns right now (bag + stash, retired samples included), in family order (`SAMPLE_FAMILIES`) → shortest analysis first. */
export function getOwnedSamples(sys: HousingSystem): { defId: string; qty: number }[] {
  const out: { defId: string; qty: number; def: ItemDef }[] = [];
  for (const def of allSampleDefs(sys)) {
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty, def });
  }
  out.sort((a, b) => (SAMPLE_FAMILIES.indexOf(familyOfDef(a.def)) - SAMPLE_FAMILIES.indexOf(familyOfDef(b.def)))
    || ((a.def.sample?.analyzeHours ?? 0) - (b.def.sample?.analyzeHours ?? 0)));
  return out.map(({ defId, qty }) => ({ defId, qty }));
}

/** The old analysis catalogue: def ids of samples ever collected. */
export function getSampleDex(sys: HousingSystem): readonly string[] { return sys.sampleDex(); }

/**
 * @deprecated 2026-09-13 — analysis catalogue progress 0 … 1: the share of the result table's **distinct products** (the
 * receivable ones) that are in `analysisFound`. The analysis time no longer looks at this value (the analysis level decides it).
 */
export function getSampleDexRatio(sys: HousingSystem): number {
  const ok = resultDefOk(sys);
  const ids = new Set(ANALYSIS_RESULTS.filter((r) => ok(r.defId)).map((r) => r.defId));
  if (!ids.size) return 0;
  const found = analysisFound(sys);
  let n = 0;
  for (const id of ids) if (found.includes(id)) n++;
  return Math.max(0, Math.min(1, n / ids.size));
}

/** 2026-09-13: one family's analysis level · XP · time multiplier (`HousingRef.getAnalysisLevel`). */
export function getAnalysisLevel(sys: HousingSystem, family: SampleFamily): AnalysisLevelInfo {
  const xp = Math.max(0, analysisXp(sys)[family] ?? 0);
  const level = analysisLevelForXp(xp);
  return {
    family, level, xp,
    levelXp: analysisXpForLevel(level),
    nextLevelXp: level < ANALYSIS_LEVEL_MAX ? analysisXpForLevel(level + 1) : null,
    timeMul: analysisTimeMul(level),
  };
}

/**
 * 2026-09-13: one family's result table (`HousingRef.getAnalysisResults`) — only rows of receivable items, ascending by minimum
 * level → descending by weight within a level. `chance` is the chance at the current level (`Rules.analysisChances`, 0 on a locked row).
 */
export function getAnalysisResults(sys: HousingSystem, family: SampleFamily): AnalysisResultInfo[] {
  const ok = resultDefOk(sys);
  const level = levelOf(sys, family);
  /* 2026-09-16: the chances are **for a common sample** — the rarity floor makes the real chance depend on the sample put in,
     and a common sample has the widest pool (= the only set the catalogue can show). The catalogue's header row states that basis. */
  const chances = analysisChances(family, level, ok, rollOpts(sys, 'common'));
  const found = analysisFound(sys);
  /* Rows that share a product (like the six 석영 rows, one per rarity) are merged into one — the catalogue lists 「what comes out」, not csv rows. */
  const merged = new Map<string, AnalysisResultInfo>();
  for (const r of ANALYSIS_RESULTS) {
    if (r.family !== family || !ok(r.defId)) continue;
    const cur = merged.get(r.defId);
    if (!cur) {
      merged.set(r.defId, {
        defId: r.defId, qtyMin: r.qtyMin, qtyMax: r.qtyMax, minLevel: r.minLevel,
        unlocked: r.minLevel <= level, chance: 0, found: found.includes(r.defId),
      });
      continue;
    }
    cur.qtyMin = Math.min(cur.qtyMin, r.qtyMin);
    cur.qtyMax = Math.max(cur.qtyMax, r.qtyMax);
    cur.minLevel = Math.min(cur.minLevel, r.minLevel);
    cur.unlocked = cur.minLevel <= level;
  }
  for (const info of merged.values()) if (info.unlocked) info.chance = chances[info.defId] ?? 0;
  return [...merged.values()].sort((a, b) => (a.minLevel - b.minLevel) || (b.chance - a.chance));
}

/** 2026-09-13: the analysis catalogue (`HousingRef.getAnalysisFound`). */
export function getAnalysisFound(sys: HousingSystem): readonly string[] { return analysisFound(sys); }

/* ── the Korean block reasons ───────────────────────────────────────────── */
/** Why `uid` / `slot` is not a usable analysis slot right now; null = fine. Every mutator starts here. */
function slotBlock(sys: HousingSystem, uid: string, slot: number): string | null {
  const analyzer = sys.analyzerOf(uid);
  if (!analyzer) return '분석기가 아닙니다';
  if (!Number.isInteger(slot) || slot < 0 || slot >= ANALYZER_MAX_SLOTS) return '없는 해석 칸입니다';
  if (slot >= analyzerSlotsForLevel(analyzer.level)) return `분석기를 Lv.${analyzerSlotUnlockLevel(slot)} 로 강화해야 열립니다`;
  return null;
}

/* ── slot mutations ─────────────────────────────────────────────────────── */
/**
 * Put one sample (bag → stash, consumes 1) into an empty slot. 2026-09-13: the family · the analysis level fix `readyAt`
 * **here**, and the result is rolled into the slot **here** too — a later level never moves a running analysis's time or result.
 */
export function startAnalysis(sys: HousingSystem, uid: string, slot: number, sampleDefId: string): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  if (sys.analysisAt(uid, slot)) return '이미 해석 중인 칸입니다';
  const def = sys.sampleDef(sampleDefId);
  if (!def || !def.sample) return '미확인 표본이 아닙니다';
  if (sys.countDef(sampleDefId) < 1) return `${def.name}이(가) 없습니다`;
  const family = familyOfDef(def);
  const level = levelOf(sys, family);
  const result = rollResult(sys, def, family, level);
  if (!result) return '이 표본에서 얻을 수 있는 결과가 없습니다';
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(sampleDefId, 1)) return '표본을 꺼낼 수 없습니다';
  const startedAt = sys.stationNow(uid);
  sys.analyses().push({
    uid, slot, sampleDefId, startedAt,
    // 2026-09-13 (H3): × the research skill · 2026-09-16: × (1 − the sample speedup) — all fixed **the moment it goes in**
    readyAt: startedAt + analysisMsFor(sys, def.sample.analyzeHours, level, speedupOf(sys, def)),
    family, resultDefId: result.defId, resultQty: result.qty,
  });
  sys.analysisChanged(uid, 'analysisStart');
  return null;
}

/** Stop a running analysis. **The sample is not returned** (the same as poured soil, exactly as the contract says). */
export function cancelAnalysis(sys: HousingSystem, uid: string, slot: number): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const a = sys.analysisAt(uid, slot);
  if (!a) return '해석 중인 표본이 없습니다';
  const list = sys.analyses();
  list.splice(list.indexOf(a), 1);
  sys.analysisChanged(uid, 'analysisCancel');
  return null;
}

/**
 * Collect a finished analysis: the **one** result written in the slot goes to `dest` (no first-analysis bonus). An old slot with
 * no result is rolled at the current level and written in first (a failure for lack of room never re-rolls). On success: remove
 * the slot → family XP → `housing:analysisLevelUp` on a new level → `analysisFound` + `housing:analysisFound` on a new product.
 */
export function collectAnalysis(sys: HousingSystem, uid: string, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const a = sys.analysisAt(uid, slot);
  if (!a) return '해석 중인 표본이 없습니다';
  const now = sys.stationNow(uid);
  if (now < a.readyAt) return `아직 해석 중입니다 (${formatRemaining(Math.ceil((a.readyAt - now) / 1000))} 남음)`;
  const def = sys.sampleDef(a.sampleDefId);
  const loot = sys.ctx.loot;
  if (!def || !loot || typeof loot.createItem !== 'function') return '해석 결과를 만들 수 없습니다';
  const family = a.family ?? familyOfDef(def);

  if (!a.resultDefId) {
    // an old save's slot — rolled now, on collection (once only: written into the slot and saved)
    const rolled = rollResult(sys, def, family, levelOf(sys, family));
    if (!rolled) return '해석 결과를 만들 수 없습니다';
    a.family = family;
    a.resultDefId = rolled.defId;
    a.resultQty = rolled.qty;
    sys.changed('analysisRoll');
  }
  const resultDefId = a.resultDefId;
  const qty = Math.max(1, Math.floor(a.resultQty ?? 1));
  if (!deliverItem(sys, loot.createItem(resultDefId, qty), dest)) return noRoomReason(dest);

  const list = sys.analyses();
  list.splice(list.indexOf(a), 1);
  // XP → level up
  const xpMap = analysisXp(sys);
  const before = Math.max(0, xpMap[family] ?? 0);
  const gain = ANALYSIS_XP_BY_RARITY[def.rarity];
  const after = before + (Number.isFinite(gain) && gain > 0 ? gain : 0);
  xpMap[family] = after;
  const lvBefore = analysisLevelForXp(before), lvAfter = analysisLevelForXp(after);
  for (let lv = lvBefore + 1; lv <= lvAfter; lv++) sys.ctx.bus.emit('housing:analysisLevelUp', { family, level: lv });
  // the analysis catalogue
  const found = analysisFound(sys);
  if (!found.includes(resultDefId)) {
    found.push(resultDefId);
    sys.ctx.bus.emit('housing:analysisFound', { family, defId: resultDefId });
  }
  // the old sample catalogue, quietly (`housing:sampleDexAdded` is no longer raised)
  const dex = sys.sampleDex();
  if (!dex.includes(a.sampleDefId)) dex.push(a.sampleDefId);
  /* 2026-09-16 (user's decision): a sample's level is **how often it was collected** — cancelling (`cancelAnalysis`) does not
     count. The first collect, the one that makes level 1, adds `ANALYSIS_SAMPLE_LEVEL_FIRST` whole; every level after adds `..._STEP`. */
  const lvMap = sampleLevels(sys);
  const lvNow = sampleLevelOf(sys, a.sampleDefId);
  if (lvNow < ANALYSIS_SAMPLE_LEVEL_MAX) lvMap[a.sampleDefId] = lvNow + 1;
  // 2026-09-13 (H3): research skill XP — once per collected slot
  const prog = sys.ctx.progression;
  if (prog && typeof prog.addSkillXp === 'function' && RESEARCH_XP_ANALYSIS > 0) {
    try { prog.addSkillXp('research', RESEARCH_XP_ANALYSIS); } catch (e) { console.error('[housing] progression.addSkillXp(research) threw', e); }
  }
  sys.analysisChanged(uid, 'analysisCollect');
  return null;
}

/** Collect every finished slot of the analyzer; returns how many were taken. */
export function collectAllAnalyses(sys: HousingSystem, uid: string): number {
  const analyzer = sys.analyzerOf(uid);
  if (!analyzer) return 0;
  let taken = 0;
  for (let slot = 0; slot < analyzerSlotsForLevel(analyzer.level); slot++) {
    const a = sys.analysisAt(uid, slot);
    if (!a || sys.stationNow(uid) < a.readyAt) continue;
    if (sys.collectAnalysis(uid, slot) === null) taken++;
  }
  return taken;
}

/** Open the analysis screen (`analyzer` interaction): analysis slots on the left · bag + ship stash + the catalogue on the right. */
export function openAnalyzer(sys: HousingSystem, uid: string): void {
  if (!sys.analyzerPanel) return;
  if (!sys.analyzerOf(uid)) { sys.notify('분석기가 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.analyzerPanel.openAnalyzer(uid);
}

/* ── dev only (2026-09-15 2nd pass — console `analyze ff <시간>` · `analyze done [uid|all]`) ─────────────────── */
/**
 * Pull the analysis clock of placed analyzers (`uid` omitted = all of them) **forward** by `hours` and return how many slots
 * finished this time. The same grain as `parts/Mining.devAdvanceMining` — it only moves the time and **does not collect** (a
 * person collects on the screen, or the console does with `collectAllAnalyses`). `startedAt` is pulled along too, so the
 * progress bar never passes 100 %. With `hours` at 0 or below, or not finite, it does nothing (and returns 0).
 */
export function devAdvanceAnalysis(sys: HousingSystem, hours: number, uid?: string): number {
  const ms = Number(hours) * 3_600_000;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const touched = new Set<string>();
  let finished = 0;
  for (const a of sys.analyses()) {
    if (uid !== undefined && a.uid !== uid) continue;
    if (!sys.analyzerOf(a.uid)) continue;                    // slots of an analyzer that is not placed are left alone
    const now = sys.stationNow(a.uid);
    const wasReady = now >= a.readyAt;
    a.startedAt -= ms;
    a.readyAt -= ms;
    if (!wasReady && now >= a.readyAt) finished++;
    touched.add(a.uid);
  }
  for (const u of touched) sys.analysisChanged(u, 'analysisCheat');
  return finished;
}
