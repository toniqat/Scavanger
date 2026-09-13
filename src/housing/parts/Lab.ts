/**
 * src/housing/parts/Lab.ts — **연구실 분석기** (A-12, 2026-09-11 · 결과표 개편 2026-09-13).
 *
 * 「표본을 넣으면 현실 시간만큼 해석되고, 회수하면 산출물 하나와 그 계열의 분석 경험치를 받는다.」
 * 해석 칸은 가구 레벨이 연다 (`analyzerSlotsForLevel`, Lv.1 = 1칸 … Lv.3 = 3칸) 이고 **칸 번호는 강화해도
 * 밀리지 않는다** — 돌아가던 해석이 다른 칸으로 옮겨 가면 안 된다.
 *
 * **2026-09-13 (요리 재료 티어 — docs/plans/food-tiers.md §4.3)**: 표본은 **계열**(`SampleDef.family` — 세포 · 광물 · DNA)로
 * 해석된다. 넣는 순간 ① 그 계열의 **분석 레벨**(`ShipState.analysisXp` → `analysisLevelForXp`)이 시간을 정하고
 * (`Rules.analysisDurationMs`), ② 결과표(`ANALYSIS_RESULTS`)를 그 레벨로 **지금 굴려** 칸에 적는다(`resultDefId` · `resultQty` —
 * 회수에 실패해도 다시 굴리지 않는다; 표가 비면 표본의 `rewardDefId` 가 대체 산출물이다). 회수하면 산출물 하나만 건네고(첫 해석
 * 보너스 없음) 그 계열에 `ANALYSIS_XP_BY_RARITY[표본 등급]` 이 쌓여 레벨이 오르면 `housing:analysisLevelUp`, 처음 받은 산출물이면
 * 분석 도감(`ShipState.analysisFound`)에 적고 `housing:analysisFound` 를 낸다. 옛 표본 도감(`sampleDex`)은 조용히 계속 채우지만
 * `housing:sampleDexAdded` 는 더 내지 않는다. 결과를 안 굴린 옛 세이브의 칸은 **회수할 때** 그때 레벨로 굴린다.
 * 은퇴한 표본도 자기 계열로 해석된다.
 *
 * 순수 판정(해석 시간 · 결과 추첨 · 확률 · 진행도 · 남은 초)은 전부 `../Rules.ts` 에 있고, 여기서는 상태를 바꾼다.
 */
import type {
  AnalysisLevelInfo, AnalysisResultInfo, AnalysisSlot, AnalysisSlotInfo, HarvestDestination, ItemDef, PlacedFurniture, SampleFamily,
} from '@/shared';
import {
  ANALYSIS_LEVEL_MAX, ANALYSIS_RESULTS, ANALYSIS_XP_BY_RARITY, ANALYZER_MAX_SLOTS, SAMPLE_FAMILIES,
  analysisLevelForXp, analysisTimeMul, analysisXpForLevel, analyzerSlotUnlockLevel, analyzerSlotsForLevel,
} from '@/shared';
import { analysisChances, analysisDurationMs, growProgress, growRemainingS, rollAnalysisResult } from '../Rules';
import { isAnalyzerDefId } from '../ShipState';
import { formatRemaining } from '../ui/dom';
import type { HousingSystem } from '../HousingSystem';
import { deliverItem, noRoomReason } from './Deliver';

/* ── state access ──────────────────────────────────────────────────────── */
/**
 * 해석 칸. The save only shape-checks 표본 ids (`spec_*`); the first time `ctx.loot` is around every id that is not a
 * real 표본 any more is dropped here (서재의 `books()` · 온실의 `grows()` 와 같은 규약 — 아이템 표에서 사라진 def 가
 * 분석기를 깨뜨리지 않는다). 은퇴한 표본(`ItemDef.retired`)은 `sample` 데이터가 남아 있으므로 걸러지지 않는다.
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

/** 옛 해석 도감 (append-only: 한 번 회수한 표본). 2026-09-13 부터 화면에 나오지 않지만 조용히 계속 채운다. */
export function sampleDex(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.sampleDex)) sys.state.sampleDex = [];
  return sys.state.sampleDex;
}

/** 2026-09-13: 계열별 분석 누적 경험치 (`ShipState.analysisXp`). */
function analysisXp(sys: HousingSystem): Partial<Record<SampleFamily, number>> {
  const cur = sys.state.analysisXp;
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) sys.state.analysisXp = {};
  return sys.state.analysisXp!;
}

/** 2026-09-13: 분석 도감 — 분석기에서 한 번이라도 회수한 산출물 def id (append-only). */
function analysisFound(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.analysisFound)) sys.state.analysisFound = [];
  return sys.state.analysisFound;
}

/** The 분석기 behind `uid`, or null when it is not one (or gone). */
export function analyzerOf(sys: HousingSystem, uid: string): PlacedFurniture | null {
  const item = sys.getPlacedByUid(uid);
  return item && isAnalyzerDefId(item.defId) ? item : null;
}

export function analysisAt(sys: HousingSystem, uid: string, slot: number): AnalysisSlot | null {
  return sys.analyses().find((a) => a.uid === uid && a.slot === slot) ?? null;
}

/** Drop every 해석 칸 of an analyzer that is being recovered (the samples go with it). */
export function dropAnalysesOf(sys: HousingSystem, uid: string): void {
  const list = sys.analyses();
  for (let i = list.length - 1; i >= 0; i--) if (list[i].uid === uid) list.splice(i, 1);
}

/** Finished 칸 of an analyzer (the `housing:analysisChanged` payload and the hub's 발광 창). */
export function readyAnalyses(sys: HousingSystem, uid: string): number {
  const now = sys.nowMs();
  return sys.analyses().filter((a) => a.uid === uid && now >= a.readyAt).length;
}

export function analysisChanged(sys: HousingSystem, uid: string, reason: string): void {
  sys.changed(reason);
  sys.ctx.bus.emit('housing:analysisChanged', { uid, ready: sys.readyAnalyses(uid) });
}

/* ── item lookups ──────────────────────────────────────────────────────── */
/** 표본 def with its `sample` data, or null when `defId` is not a 표본. */
export function sampleDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.sample ? def : null;
}

/** Every 표본 def the item table knows (은퇴한 것 포함 — 해석은 된다). */
function allSampleDefs(sys: HousingSystem): readonly ItemDef[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  return loot.getAllItemDefs().filter((d) => !!d.sample);
}

/** 표본의 계열. 표에 계열이 없으면(옛 아이템 표) 세포로 본다. */
function familyOfDef(def: ItemDef | null | undefined): SampleFamily {
  const f = (def?.sample as { family?: unknown } | undefined)?.family;
  return typeof f === 'string' && (SAMPLE_FAMILIES as readonly string[]).includes(f) ? (f as SampleFamily) : 'cell';
}

/** 분석 결과 · 대체 산출물로 받을 수 있는 아이템인가 — 아이템 표에 있고 은퇴하지 않았다. */
function resultDefOk(sys: HousingSystem): (defId: string) => boolean {
  return (defId) => {
    const d = sys.defOf(defId);
    return !!d && !d.retired;
  };
}

/** 계열의 지금 분석 레벨 (1 … `ANALYSIS_LEVEL_MAX`). */
function levelOf(sys: HousingSystem, family: SampleFamily): number {
  return analysisLevelForXp(analysisXp(sys)[family] ?? 0);
}

/** 결과 한 번 굴리기 — 결과표가 비면 표본의 대체 산출물(`rewardDefId`), 그것도 못 받으면 null. */
function rollResult(sys: HousingSystem, def: ItemDef, family: SampleFamily, level: number): { defId: string; qty: number } | null {
  const rolled = rollAnalysisResult(family, level, Math.random, resultDefOk(sys));
  if (rolled) return rolled;
  const s = def.sample;
  if (!s || !s.rewardDefId || !sys.defOf(s.rewardDefId)) return null;
  return { defId: s.rewardDefId, qty: Math.max(1, Math.floor(Number.isFinite(s.rewardQty) ? s.rewardQty : 1)) };
}

/* ── 분석 화면이 읽는 값 ────────────────────────────────────────────────── */
/**
 * Every 해석 칸 of one analyzer — **always `ANALYZER_MAX_SLOTS`** in slot order, locked ones included so the panel can
 * draw the slots an upgrade will open. `[]` when `uid` is not an analyzer. 2026-09-13: 결과(`resultDefId` · `rewardDefId`)는
 * **끝난 칸에서만** 채워지고, `firstTime` = 끝났고 그 결과가 분석 도감에 없다.
 */
export function getAnalyses(sys: HousingSystem, uid: string): AnalysisSlotInfo[] {
  const analyzer = sys.analyzerOf(uid);
  if (!analyzer) return [];
  const now = sys.nowMs();
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
      // 진행도 · 남은 초는 온실과 같은 순수 시각 계산이다 (`Rules` 의 그 둘은 작물인지 표본인지 모른다)
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

/** 표본 item defs the player owns right now (bag + stash, 은퇴한 표본 포함), 계열 순(`SAMPLE_FAMILIES`) → 해석 시간 짧은 순. */
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

/** 옛 해석 도감: 한 번이라도 회수한 표본 def id. */
export function getSampleDex(sys: HousingSystem): readonly string[] { return sys.sampleDex(); }

/**
 * @deprecated 2026-09-13 — 분석 도감 진척 0…1: 결과표의 **서로 다른 산출물**(받을 수 있는 것) 중 `analysisFound` 에 든 비율.
 * 해석 시간은 더 이상 이 값을 보지 않는다 (분석 레벨이 정한다).
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

/** 2026-09-13: 한 계열의 분석 레벨 · 경험치 · 시간 배수 (`HousingRef.getAnalysisLevel`). */
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
 * 2026-09-13: 한 계열의 결과표 (`HousingRef.getAnalysisResults`) — 받을 수 있는 아이템의 줄만, 최소 레벨 오름차순 → 같은 레벨은
 * 가중치 내림차순. `chance` 는 지금 레벨의 확률(`Rules.analysisChances`, 잠긴 줄은 0).
 */
export function getAnalysisResults(sys: HousingSystem, family: SampleFamily): AnalysisResultInfo[] {
  const ok = resultDefOk(sys);
  const level = levelOf(sys, family);
  const chances = analysisChances(family, level, ok);
  const found = analysisFound(sys);
  return ANALYSIS_RESULTS
    .filter((r) => r.family === family && ok(r.defId))
    .slice()
    .sort((a, b) => (a.minLevel - b.minLevel) || (b.weight - a.weight))
    .map((r) => {
      const unlocked = r.minLevel <= level;
      return {
        defId: r.defId, qtyMin: r.qtyMin, qtyMax: r.qtyMax, minLevel: r.minLevel,
        unlocked,
        chance: unlocked ? chances[r.defId] ?? 0 : 0,
        found: found.includes(r.defId),
      };
    });
}

/** 2026-09-13: 분석 도감 (`HousingRef.getAnalysisFound`). */
export function getAnalysisFound(sys: HousingSystem): readonly string[] { return analysisFound(sys); }

/* ── 한국어 게이트 ──────────────────────────────────────────────────────── */
/** Why `uid` / `slot` is not a usable 해석 칸 right now; null = fine. Every mutator starts here. */
function slotBlock(sys: HousingSystem, uid: string, slot: number): string | null {
  const analyzer = sys.analyzerOf(uid);
  if (!analyzer) return '분석기가 아닙니다';
  if (!Number.isInteger(slot) || slot < 0 || slot >= ANALYZER_MAX_SLOTS) return '없는 해석 칸입니다';
  if (slot >= analyzerSlotsForLevel(analyzer.level)) return `분석기를 Lv.${analyzerSlotUnlockLevel(slot)} 로 강화해야 열립니다`;
  return null;
}

/* ── 칸 조작 ────────────────────────────────────────────────────────────── */
/**
 * Put one 표본 (bag → stash, consumes 1) into an empty 칸. 2026-09-13: 계열 · 분석 레벨이 **여기서** `readyAt` 을 정하고, 결과도
 * **여기서** 굴려 칸에 적는다 — 나중에 레벨이 올라도 돌아가던 해석의 시간 · 결과는 움직이지 않는다.
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
  const startedAt = sys.nowMs();
  sys.analyses().push({
    uid, slot, sampleDefId, startedAt,
    readyAt: startedAt + analysisDurationMs(def.sample.analyzeHours, level),
    family, resultDefId: result.defId, resultQty: result.qty,
  });
  sys.analysisChanged(uid, 'analysisStart');
  return null;
}

/** Stop a running 해석. **The sample is not returned** (부은 흙과 같다, 계약에 적힌 그대로). */
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
 * Collect a finished 해석: 칸에 적힌 결과 **하나**가 `dest` 로 간다 (첫 해석 보너스 없음). 결과가 없는 옛 칸은 지금 레벨로 굴려
 * 칸에 먼저 적는다(자리가 없어 실패해도 다시 굴리지 않는다). 성공하면 칸 제거 → 계열 경험치 → 레벨이 올랐으면
 * `housing:analysisLevelUp` → 새 산출물이면 `analysisFound` + `housing:analysisFound`. 옛 표본 도감은 조용히 채운다.
 */
export function collectAnalysis(sys: HousingSystem, uid: string, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const a = sys.analysisAt(uid, slot);
  if (!a) return '해석 중인 표본이 없습니다';
  const now = sys.nowMs();
  if (now < a.readyAt) return `아직 해석 중입니다 (${formatRemaining(Math.ceil((a.readyAt - now) / 1000))} 남음)`;
  const def = sys.sampleDef(a.sampleDefId);
  const loot = sys.ctx.loot;
  if (!def || !loot || typeof loot.createItem !== 'function') return '해석 결과를 만들 수 없습니다';
  const family = a.family ?? familyOfDef(def);

  if (!a.resultDefId) {
    // 옛 세이브의 칸 — 회수하는 지금 굴린다 (한 번만: 칸에 적어 두고 저장한다)
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
  // 경험치 → 레벨업
  const xpMap = analysisXp(sys);
  const before = Math.max(0, xpMap[family] ?? 0);
  const gain = ANALYSIS_XP_BY_RARITY[def.rarity];
  const after = before + (Number.isFinite(gain) && gain > 0 ? gain : 0);
  xpMap[family] = after;
  const lvBefore = analysisLevelForXp(before), lvAfter = analysisLevelForXp(after);
  for (let lv = lvBefore + 1; lv <= lvAfter; lv++) sys.ctx.bus.emit('housing:analysisLevelUp', { family, level: lv });
  // 분석 도감
  const found = analysisFound(sys);
  if (!found.includes(resultDefId)) {
    found.push(resultDefId);
    sys.ctx.bus.emit('housing:analysisFound', { family, defId: resultDefId });
  }
  // 옛 표본 도감은 조용히 (`housing:sampleDexAdded` 는 더 내지 않는다)
  const dex = sys.sampleDex();
  if (!dex.includes(a.sampleDefId)) dex.push(a.sampleDefId);
  sys.analysisChanged(uid, 'analysisCollect');
  return null;
}

/** Collect every finished 칸 of the analyzer; returns how many were taken. */
export function collectAllAnalyses(sys: HousingSystem, uid: string): number {
  const analyzer = sys.analyzerOf(uid);
  if (!analyzer) return 0;
  let taken = 0;
  for (let slot = 0; slot < analyzerSlotsForLevel(analyzer.level); slot++) {
    const a = sys.analysisAt(uid, slot);
    if (!a || sys.nowMs() < a.readyAt) continue;
    if (sys.collectAnalysis(uid, slot) === null) taken++;
  }
  return taken;
}

/** Open the 분석 화면 (`analyzer` interaction): 좌 해석 칸 · 우 가방 + 함선 창고 + 분석 도감. */
export function openAnalyzer(sys: HousingSystem, uid: string): void {
  if (!sys.analyzerPanel) return;
  if (!sys.analyzerOf(uid)) { sys.notify('분석기가 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.analyzerPanel.openAnalyzer(uid);
}
