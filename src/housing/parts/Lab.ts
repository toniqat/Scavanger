/**
 * src/housing/parts/Lab.ts — **연구실 분석기** (A-12, 2026-09-11).
 *
 * 「표본을 넣으면 현실 시간만큼 해석되고, 회수할 때 해석 도감이 한 칸 찬다.」
 * 해석 칸은 가구 레벨이 연다 (`analyzerSlotsForLevel`, Lv.1 = 1칸 … Lv.3 = 3칸) 이고 **칸 번호는 강화해도
 * 밀리지 않는다** — 돌아가던 해석이 다른 칸으로 옮겨 가면 안 된다. 걸리는 시간은 재배 스테이션과 같은 규약으로
 * **넣는 순간** `readyAt` 에 확정된다: 그 뒤로 도감이 더 차도 돌아가던 해석은 빨라지지 않는다.
 *
 * 순수 판정(해석 시간 · 진행도 · 남은 초)은 전부 `../Rules.ts` 에 있고, 여기서는 상태를 바꾼다.
 * `parts/Garden.ts` 가 그대로 본보기다 — 같은 계층 분리, 같은 이름 규칙, 같은 한국어 사유 규약이다.
 */
import type { AnalysisSlot, AnalysisSlotInfo, HarvestDestination, ItemDef, PlacedFurniture } from '@/shared';
import { ANALYZER_MAX_SLOTS, analyzerSlotUnlockLevel, analyzerSlotsForLevel } from '@/shared';
import { analyzeDurationMs, growProgress, growRemainingS } from '../Rules';
import { isAnalyzerDefId } from '../ShipState';
import { formatRemaining } from '../ui/dom';
import type { HousingSystem } from '../HousingSystem';
import { deliverItem, noRoomReason } from './Deliver';

/* ── state access ──────────────────────────────────────────────────────── */
/**
 * 해석 칸. The save only shape-checks 표본 ids (`spec_*`); the first time `ctx.loot` is around every id that is not a
 * real 표본 any more is dropped here (서재의 `books()` · 온실의 `grows()` 와 같은 규약 — 아이템 표에서 사라진 def 가
 * 분석기를 깨뜨리지 않는다).
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

/** 해석 도감 (append-only: 한 번 회수한 표본은 지워지지 않는다). */
export function sampleDex(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.sampleDex)) sys.state.sampleDex = [];
  return sys.state.sampleDex;
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

/** Every 표본 def the item table knows (the 도감 denominator and the picker order). */
function allSampleDefs(sys: HousingSystem): readonly ItemDef[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  return loot.getAllItemDefs().filter((d) => !!d.sample);
}

/* ── 분석 화면이 읽는 값 ────────────────────────────────────────────────── */
/**
 * Every 해석 칸 of one analyzer — **always `ANALYZER_MAX_SLOTS`** in slot order, locked ones included so the panel can
 * draw the slots an upgrade will open. `[]` when `uid` is not an analyzer.
 */
export function getAnalyses(sys: HousingSystem, uid: string): AnalysisSlotInfo[] {
  const analyzer = sys.analyzerOf(uid);
  if (!analyzer) return [];
  const now = sys.nowMs();
  const open = analyzerSlotsForLevel(analyzer.level);
  const dex = sys.sampleDex();
  const out: AnalysisSlotInfo[] = [];
  for (let slot = 0; slot < ANALYZER_MAX_SLOTS; slot++) {
    const locked = slot >= open;
    const a = locked ? null : sys.analysisAt(uid, slot);
    const sample = a ? sys.sampleDef(a.sampleDefId)?.sample ?? null : null;
    out.push({
      slot, locked, unlockLevel: analyzerSlotUnlockLevel(slot),
      sampleDefId: a?.sampleDefId ?? null,
      // 진행도 · 남은 초는 온실과 같은 순수 시각 계산이다 (`Rules` 의 그 둘은 작물인지 표본인지 모른다)
      progress: growProgress(now, a?.startedAt, a?.readyAt),
      remainingS: growRemainingS(now, a?.readyAt),
      ready: !!a && now >= a.readyAt,
      rewardDefId: sample?.rewardDefId ?? null,
      rewardQty: sample?.rewardQty ?? 0,
      firstTime: !!a && !dex.includes(a.sampleDefId),
    });
  }
  return out;
}

/** 표본 item defs the player owns right now (bag + stash), shortest 해석 first — the 분석 화면 hint. */
export function getOwnedSamples(sys: HousingSystem): { defId: string; qty: number }[] {
  const out: { defId: string; qty: number }[] = [];
  for (const def of allSampleDefs(sys)) {
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty });
  }
  out.sort((a, b) => (sys.sampleDef(a.defId)?.sample?.analyzeHours ?? 0) - (sys.sampleDef(b.defId)?.sample?.analyzeHours ?? 0));
  return out;
}

/** 해석 도감: 한 번이라도 회수한 표본 def id. */
export function getSampleDex(sys: HousingSystem): readonly string[] { return sys.sampleDex(); }

/**
 * 도감 진척 0…1 — **아이템 표가 아는 표본** 중 도감에 든 것의 비율이다 (도감에 남아 있는 옛 id 는 세지 않는다,
 * 그러지 않으면 비율이 1 을 넘을 수 있다). 표본 종류가 하나도 없으면 0.
 */
export function getSampleDexRatio(sys: HousingSystem): number {
  const defs = allSampleDefs(sys);
  if (!defs.length) return 0;
  const dex = sys.sampleDex();
  let known = 0;
  for (const def of defs) if (dex.includes(def.id)) known++;
  return Math.max(0, Math.min(1, known / defs.length));
}

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
 * Put one 표본 (bag → stash, consumes 1) into an empty 칸. `readyAt` is fixed **here** from the 도감 진척 and whether
 * this sample is already known, so a later 도감 entry never moves a running timer.
 */
export function startAnalysis(sys: HousingSystem, uid: string, slot: number, sampleDefId: string): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  if (sys.analysisAt(uid, slot)) return '이미 해석 중인 칸입니다';
  const def = sys.sampleDef(sampleDefId);
  if (!def || !def.sample) return '미확인 표본이 아닙니다';
  if (sys.countDef(sampleDefId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(sampleDefId, 1)) return '표본을 꺼낼 수 없습니다';
  const known = sys.sampleDex().includes(sampleDefId);
  const startedAt = sys.nowMs();
  sys.analyses().push({
    uid, slot, sampleDefId, startedAt,
    readyAt: startedAt + analyzeDurationMs(def.sample.analyzeHours, sys.getSampleDexRatio(), known),
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
 * Collect a finished 해석: the reward goes into the bag (stash fallback). 처음 보는 표본이면 `SampleDef.firstDefId`
 * 보너스가 함께 붙고 해석 도감이 한 칸 찬다. All-or-nothing — when the bonus has nowhere to go the reward is taken
 * back out and the 칸 stays as it was (`stashBooksOf` 와 같은 롤백 규약).
 */
export function collectAnalysis(sys: HousingSystem, uid: string, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const a = sys.analysisAt(uid, slot);
  if (!a) return '해석 중인 표본이 없습니다';
  const now = sys.nowMs();
  if (now < a.readyAt) return `아직 해석 중입니다 (${formatRemaining(Math.ceil((a.readyAt - now) / 1000))} 남음)`;
  const sample = sys.sampleDef(a.sampleDefId)?.sample ?? null;
  const loot = sys.ctx.loot;
  const inv = sys.ctx.inventory;
  if (!sample || !loot || typeof loot.createItem !== 'function') return '해석 결과를 만들 수 없습니다';

  const dex = sys.sampleDex();
  const firstTime = !dex.includes(a.sampleDefId);
  const payout: { defId: string; qty: number }[] = [{ defId: sample.rewardDefId, qty: Math.max(1, Math.floor(sample.rewardQty)) }];
  if (firstTime && sample.firstDefId) payout.push({ defId: sample.firstDefId, qty: Math.max(1, Math.floor(sample.firstQty ?? 1)) });

  const added: string[] = [];
  for (const p of payout) {
    const item = loot.createItem(p.defId, p.qty);
    if (!deliverItem(sys, item, dest)) {
      if (inv && typeof inv.takeItem === 'function') for (const u of added) inv.takeItem(u);
      return noRoomReason(dest);
    }
    added.push(item.uid);
  }

  const list = sys.analyses();
  list.splice(list.indexOf(a), 1);
  if (firstTime) {
    dex.push(a.sampleDefId);
    sys.ctx.bus.emit('housing:sampleDexAdded', { defId: a.sampleDefId });
  }
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

/** Open the 분석 화면 (`analyzer` interaction): 좌 해석 칸 · 우 가방 + 함선 창고 + 해석 도감. */
export function openAnalyzer(sys: HousingSystem, uid: string): void {
  if (!sys.analyzerPanel) return;
  if (!sys.analyzerOf(uid)) { sys.notify('분석기가 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.analyzerPanel.openAnalyzer(uid);
}
