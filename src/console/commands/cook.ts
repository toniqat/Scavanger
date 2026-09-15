import type { MealItemDef } from '@/shared';
import { MEAL_DEFS, MEAL_QUALITY_MAX, cookStepsOf, mealQualityStars } from '@/shared';
import type { CommandFactory } from './types';
import { err, parseNumber } from './types';

/**
 * `cook [plate <요리 id|한국어 이름> [품질 0-5] | clear]` — 요리 미니게임 · 식탁 접시 개발용 명령 (2026-09-13 → 2026-09-16 접시 모델).
 * **공개 ref 만** 쓴다: `ctx.housing.cookSession` · `getPlate` · `devSetPlate` · `clearPlate`, 요리 표 `MEAL_DEFS` (`shared/meals`).
 *
 *   - `cook`                         지금 조리 중인 요리 · 식탁의 접시 한 줄씩 + 사용법.
 *   - `cook plate <요리> [품질]`       조리 없이 내 함선 식탁에 접시를 놓는다 (옛 접시는 바뀐다).
 *   - `cook clear`                   내 식탁의 접시를 치운다.
 *
 * 2026-09-16 (사용자 결정): 요리는 더 이상 아이템이 아니다 — 옛 `cook give`(품질 요리를 가방에)는 없어졌다.
 * 요리 이름에는 띄어쓰기가 있을 수 있어(`치즈 오믈렛`) **끝의 숫자 토큰**을 품질로 읽는다.
 */
const USAGE = '사용법: /cook plate <요리 id|이름> [품질 0-5]  ·  /cook clear';

const squash = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

/** id(대소문자 무시) · 한국어 이름 · 띄어쓰기를 뺀 이름 → 요리 정의. */
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
      } catch { /* housing 미준비 */ }
      return `${line}\n${plateLine}\n${USAGE}`;
    }
    const sub = args[0].toLowerCase();
    if (!h || typeof h.devSetPlate !== 'function' || typeof h.clearPlate !== 'function') return err('함선 시스템이 준비되지 않았습니다');
    if (sub === 'clear') return h.clearPlate() ? '식탁의 접시를 치웠습니다' : '식탁에 접시가 없습니다';
    if (sub !== 'plate' || args.length < 2) return err(USAGE);

    // 끝의 숫자 토큰(이름은 한 토큰 이상 남긴다) = 품질
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
