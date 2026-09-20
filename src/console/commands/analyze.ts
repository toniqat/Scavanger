import type { AnalysisSlotInfo, GameContext, HousingRef, PlacedFurniture } from '@/shared';
import { SAMPLE_FAMILIES, SAMPLE_FAMILY_LABEL_KO } from '@/shared';
import type { CommandFactory } from './types';
import { err, parseNumber } from './types';

/**
 * `analyze [ff <시간> | done [uid|all]]` — **the analyzer (cell analysis) time cheat** (2026-09-15, user's decision).
 *
 * The same grain as `gym` · `cook` · `crypto` · `library`: it uses **only `HousingRef`'s public API** and never
 * touches `ShipState` directly. Only fast-forwarding the clock is a dev-only **optional** on the contract
 * (`HousingRef.devAdvanceAnalysis` — `src/shared/housing.ts`), and with none it says in a red line what is
 * missing (the same contract as `devAdvanceMining`).
 *
 *   - `analyze`              level · slots · time left per placed analyzer, plus each family's analysis level and
 *                            time multiplier.
 *   - `analyze ff <시간>`     fast-forwards every analyzer's analysis clock by that much.
 *   - `analyze done [uid|all]` finishes that analyzer's analysis (omitted = all) **now** — it advances by the longest
 *                            remaining time, so no 「large enough number」 is written into the code. Collecting still
 *                            happens on screen as usual.
 *
 * An analyzer is picked by **`FurnitureDef.interaction === 'analyzer'`**, not by def id — so this line does not
 * change as more furniture is added.
 */
const USAGE = '사용법: /analyze [ff <시간> | done [uid|all]]';

function hms(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (v: number): string => v.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Every placed analyzer (`interaction: 'analyzer'`), in room · uid order. */
function analyzers(h: HousingRef): PlacedFurniture[] {
  return h.getPlaced().filter((p) => h.getFurnitureDef(p.defId)?.interaction === 'analyzer');
}

function itemName(ctx: GameContext, defId: string | null): string {
  if (!defId) return '?';
  return ctx.loot?.getItemDef(defId)?.name ?? defId;
}

function slotLine(ctx: GameContext, s: AnalysisSlotInfo): string {
  const n = s.slot + 1;
  if (s.locked) return `  ${n}. 잠김 (Lv.${s.unlockLevel})`;
  if (!s.sampleDefId) return `  ${n}. 빈 칸`;
  const family = s.family ? ` 「${SAMPLE_FAMILY_LABEL_KO[s.family]}」` : '';
  const reward = s.rewardDefId ? ` → ${itemName(ctx, s.rewardDefId)} ×${s.rewardQty}${s.firstTime ? ' (도감 신규)' : ''}` : '';
  if (s.ready) return `  ${n}. ${itemName(ctx, s.sampleDefId)}${family} · 완료${reward}`;
  return `  ${n}. ${itemName(ctx, s.sampleDefId)}${family} · ${Math.round(s.progress * 100)} % (${hms(s.remainingS)} 남음)`;
}

function status(ctx: GameContext, h: HousingRef): string {
  const lines: string[] = [];
  const list = analyzers(h);
  if (!list.length) lines.push('배치된 분석기가 없습니다');
  for (const p of list) {
    const slots = h.getAnalyses(p.uid);
    const busy = slots.filter((s) => !s.locked && s.sampleDefId).length;
    const open = slots.filter((s) => !s.locked).length;
    lines.push(`${p.uid} (방 ${p.room + 1}) · Lv.${p.level} · 칸 ${busy}/${open}`);
    for (const s of slots) lines.push(slotLine(ctx, s));
  }
  const dex = Math.round(h.getSampleDexRatio() * 100);
  lines.push(`도감 진척 ${dex} % · ${SAMPLE_FAMILIES.map((f) => {
    const lv = h.getAnalysisLevel(f);
    return `${SAMPLE_FAMILY_LABEL_KO[f]} Lv.${lv.level} (시간 ×${lv.timeMul.toFixed(2)})`;
  }).join(' · ')}`);
  return lines.join('\n');
}

/** The longest remaining time (in hours) among these analyzers' analyses. 0 when none is running. */
function longestRemainingHours(h: HousingRef, uids: string[]): number {
  let max = 0;
  for (const uid of uids) for (const s of h.getAnalyses(uid)) {
    if (!s.locked && s.sampleDefId && !s.ready) max = Math.max(max, s.remainingS);
  }
  return max / 3600;
}

export const analyze: CommandFactory = () => ({
  name: 'analyze',
  usage: 'analyze [ff <시간> | done [uid|all]]',
  description: '분석기(세포 해석) 상태를 보거나 해석 시간을 앞당깁니다',
  run(args, ctx) {
    const h = ctx.housing;
    if (!h || typeof h.getAnalyses !== 'function') return err('함선 시스템에 분석기 구현이 아직 없습니다');
    if (args.length === 0) return status(ctx, h);
    const sub = args[0].toLowerCase();

    if (sub === 'ff') {
      if (args.length !== 2) return err(USAGE);
      const hours = parseNumber(args[1]);
      if (!Number.isFinite(hours) || hours <= 0) return err(`시간이 올바르지 않습니다: ${args[1]}`);
      if (typeof h.devAdvanceAnalysis !== 'function') return err('함선 시스템에 devAdvanceAnalysis 가 아직 없습니다');
      const done = h.devAdvanceAnalysis(hours);
      return `해석 시계 +${hours}시간 → ${done}칸 완료\n${status(ctx, h)}`;
    }

    if (sub === 'done') {
      if (args.length > 2) return err(USAGE);
      if (typeof h.devAdvanceAnalysis !== 'function') return err('함선 시스템에 devAdvanceAnalysis 가 아직 없습니다');
      const all = analyzers(h);
      if (!all.length) return err('배치된 분석기가 없습니다');
      const target = args.length === 2 && args[1].toLowerCase() !== 'all' ? args[1] : undefined;
      if (target && !all.some((p) => p.uid === target)) return err(`분석기가 아닙니다: ${target}`);
      const hours = longestRemainingHours(h, target ? [target] : all.map((p) => p.uid));
      if (hours <= 0) return `돌아가는 해석이 없습니다\n${status(ctx, h)}`;
      const done = h.devAdvanceAnalysis(hours, target);
      return `해석 즉시 완료 (+${hms(hours * 3600)}) → ${done}칸\n${status(ctx, h)}`;
    }

    return err(USAGE);
  },
  complete(args, ctx) {
    if (args.length <= 1) return ['ff', 'done'];
    const h = ctx.housing;
    if (args[0].toLowerCase() === 'done' && args.length === 2 && h) {
      return ['all', ...analyzers(h).map((p) => p.uid)];
    }
    return [];
  },
});
