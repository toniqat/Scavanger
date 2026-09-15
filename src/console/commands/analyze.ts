import type { AnalysisSlotInfo, GameContext, HousingRef, PlacedFurniture } from '@/shared';
import { SAMPLE_FAMILIES, SAMPLE_FAMILY_LABEL_KO } from '@/shared';
import type { CommandFactory } from './types';
import { err, parseNumber } from './types';

/**
 * `analyze [ff <시간> | done [uid|all]]` — **분석기(세포 해석) 시간 치트** (2026-09-15, 사용자 결정).
 *
 * `gym` · `cook` · `crypto` · `library` 와 같은 결이다: **`HousingRef` 의 공개 API 만** 쓰고 `ShipState` 를 직접
 * 만지지 않는다. 시계를 앞당기는 것만 dev 전용 optional (`devAdvanceAnalysis`) 이고, 없으면 무엇이 없는지
 * 빨간 줄로 말한다 (`devAdvanceMining` 과 같은 규약).
 *
 *   - `analyze`              배치된 분석기마다 레벨 · 칸 · 남은 시간, 그리고 계열별 분석 레벨 · 시간 배수.
 *   - `analyze ff <시간>`     모든 분석기의 해석 시계를 그만큼 앞당긴다.
 *   - `analyze done [uid|all]` 그 분석기(생략 = 전부)의 해석을 **지금** 끝낸다 — 남은 시간 중 가장 긴 것만큼
 *                            앞당기므로 코드에 「충분히 큰 수」를 적지 않는다. 회수는 평소대로 화면에서 한다.
 *
 * 분석기를 고르는 기준은 def id 가 아니라 **`FurnitureDef.interaction === 'analyzer'`** 다 — 가구가 늘어도 이 줄은 안 바뀐다.
 */
const USAGE = '사용법: /analyze [ff <시간> | done [uid|all]]';

/**
 * 리드 · 하우징(에이전트 D)에게 요청한 dev optional. **계약(`HousingRef`)에 아직 없으므로** 여기서 구조적으로만
 * 좁혀 쓴다 — D 가 `HousingRef` 끝에 같은 시그니처를 optional 로 더하면 이 타입은 그대로 맞물린다
 * (`devAdvanceMining` 과 같은 규약: 없으면 빨간 줄).
 *
 *   `devAdvanceAnalysis?(hours: number, uid?: string): number`
 *   — 배치된 분석기(`uid` 생략 = 전부)의 해석 시계를 `hours` 만큼 앞당기고 **이번에 끝난 칸 수**를 돌려준다.
 *     회수는 하지 않는다 (화면의 일이다).
 */
type AnalyzeDev = { devAdvanceAnalysis?(hours: number, uid?: string): number };

function hms(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (v: number): string => v.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 배치된 분석기 전부 (`interaction: 'analyzer'`), 방 · uid 순. */
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

/** 이 분석기들의 해석 중 가장 오래 남은 시간(시간 단위). 돌아가는 해석이 없으면 0. */
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

    const dev = h as HousingRef & AnalyzeDev;

    if (sub === 'ff') {
      if (args.length !== 2) return err(USAGE);
      const hours = parseNumber(args[1]);
      if (!Number.isFinite(hours) || hours <= 0) return err(`시간이 올바르지 않습니다: ${args[1]}`);
      if (typeof dev.devAdvanceAnalysis !== 'function') return err('함선 시스템에 devAdvanceAnalysis 가 아직 없습니다');
      const done = dev.devAdvanceAnalysis(hours);
      return `해석 시계 +${hours}시간 → ${done}칸 완료\n${status(ctx, h)}`;
    }

    if (sub === 'done') {
      if (args.length > 2) return err(USAGE);
      if (typeof dev.devAdvanceAnalysis !== 'function') return err('함선 시스템에 devAdvanceAnalysis 가 아직 없습니다');
      const all = analyzers(h);
      if (!all.length) return err('배치된 분석기가 없습니다');
      const target = args.length === 2 && args[1].toLowerCase() !== 'all' ? args[1] : undefined;
      if (target && !all.some((p) => p.uid === target)) return err(`분석기가 아닙니다: ${target}`);
      const hours = longestRemainingHours(h, target ? [target] : all.map((p) => p.uid));
      if (hours <= 0) return `돌아가는 해석이 없습니다\n${status(ctx, h)}`;
      const done = dev.devAdvanceAnalysis(hours, target);
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
