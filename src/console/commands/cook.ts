import type { MealItemDef } from '@/shared';
import { MEAL_DEFS, MEAL_QUALITY_MAX, cookStepsOf, mealQualityStars } from '@/shared';
import type { CommandFactory } from './types';
import { err, parseNumber } from './types';

/**
 * `cook [plate <요리 id|한국어 이름> [품질 0-5] | clear]` — the dev command for the cooking minigame · the
 * dining-table plate (2026-09-13 → the 2026-09-16 plate model).
 * Uses **public refs only**: `ctx.housing.cookSession` · `getPlate` · `devSetPlate` · `clearPlate`, and the meal
 * table `MEAL_DEFS` (`shared/meals`).
 *
 *   - `cook`                         one line each for the meal being cooked now · the plate on the dining table,
 *                                    plus the usage.
 *   - `cook plate <요리> [품질]`       puts a plate on my ship's dining table without cooking (replacing the old one).
 *   - `cook clear`                   takes the plate off my dining table.
 *
 * 2026-09-16 (user's decision): a meal is no longer an item — the old `cook give` (a quality meal into the bag) is
 * gone. A meal name may hold a space (`치즈 오믈렛`), so the **trailing numeric token** is read as the quality.
 */
const USAGE = '사용법: /cook plate <요리 id|이름> [품질 0-5]  ·  /cook clear';

const squash = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

/** id (case-insensitive) · the Korean name · the name with spaces removed → the meal def. */
function resolveMeal(raw: string): MealItemDef | null {
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  const sq = squash(s);
  return MEAL_DEFS.find((d) => d.id.toLowerCase() === lower)
    ?? MEAL_DEFS.find((d) => d.name === s)
    ?? MEAL_DEFS.find((d) => squash(d.name) === sq)
    ?? null;
}

const label = (d: MealItemDef | undefined, id: string, q: number): string => `${d?.name ?? id}${q > 0 ? ` ${mealQualityStars(q)}` : ''}`;

export const cook: CommandFactory = () => ({
  name: 'cook',
  usage: 'cook [plate <요리 id|이름> [품질 0-5] | clear]',
  description: '식탁에 요리 접시를 놓거나 치우고, 지금 조리 중인 요리 · 식탁의 접시를 봅니다',
  run(args, ctx) {
    const h = ctx.housing;
    if (args.length === 0) {
      let line = '조리 중이 아닙니다';
      let plateLine = '식탁: 비어 있음';
      try {
        const s = h?.cookSession;
        if (s) line = `조리 중: ${MEAL_DEFS.find((d) => d.id === s.mealDefId)?.name ?? s.mealDefId} (단계 ${s.steps.length}개)`;
        const p = h?.getPlate?.();
        if (p) plateLine = `식탁: ${label(MEAL_DEFS.find((d) => d.id === p.mealDefId), p.mealDefId, p.quality)}`;
      } catch { /* housing not ready */ }
      return `${line}\n${plateLine}\n${USAGE}`;
    }
    const sub = args[0].toLowerCase();
    if (!h || typeof h.devSetPlate !== 'function' || typeof h.clearPlate !== 'function') return err('함선 시스템이 준비되지 않았습니다');
    if (sub === 'clear') return h.clearPlate() ? '식탁의 접시를 치웠습니다' : '식탁에 접시가 없습니다';
    if (sub !== 'plate' || args.length < 2) return err(USAGE);

    // The trailing numeric token (at least one token is left for the name) = the quality
    const rest = args.slice(1);
    let quality = 0;
    if (rest.length > 1 && !Number.isNaN(parseNumber(rest[rest.length - 1]))) quality = parseNumber(rest.pop());
    const name = rest.join(' ');
    const def = resolveMeal(name);
    if (!def) return err(`알 수 없는 요리: ${name}`);
    if (!Number.isInteger(quality) || quality < 0 || quality > MEAL_QUALITY_MAX) return err(`품질은 0 … ${MEAL_QUALITY_MAX} 정수입니다: ${quality}`);
    const refusal = h.devSetPlate(def.id, quality);
    if (refusal) return err(refusal);
    const steps = cookStepsOf(def.id).length === 0 ? ' · 조리대 요리 아님' : '';
    return `${label(def, def.id, quality)} → 식탁${steps}`;
  },
  complete(args) {
    if (args.length <= 1) {
      const p = (args[0] ?? '').toLowerCase();
      return ['plate', 'clear'].filter((s) => s.startsWith(p));
    }
    if (args[0].toLowerCase() !== 'plate' || args.length > 2) return [];
    const p = args[1].toLowerCase();
    const out: string[] = [];
    for (const d of MEAL_DEFS) {
      if (d.retired) continue;
      if (d.id.toLowerCase().startsWith(p)) out.push(d.id);
      else if (d.name.toLowerCase().startsWith(p)) out.push(d.name);
    }
    return out;
  },
});
