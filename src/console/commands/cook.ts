import type { GameContext, ItemDef } from '@/shared';
import { MEAL_QUALITY_MAX, cookStepsOf, mealQualityStars } from '@/shared';
import type { CommandFactory } from './types';
import { err, parseNumber } from './types';

/**
 * `cook [give <요리 id|한국어 이름> [품질 0-5] [수량]]` — 요리 미니게임 (2026-09-13, `docs/plans/cooking-minigames.md` §6-5) 개발용 명령.
 * **공개 ref 만** 쓴다: `ctx.loot.getAllItemDefs` · `createItem` + 인스턴스의 `quality` · `ctx.inventory.tryAddItem`.
 *
 *   - `cook`                               지금 조리 중인 요리(`ctx.housing.cookSession`) 한 줄 + 사용법.
 *   - `cook give <요리> [품질] [수량]`       품질 붙은 요리를 가방에 (수량은 묶음마다 나눠 넣는다, 자리가 없으면 넣은 만큼만).
 *
 * 요리 이름에는 띄어쓰기가 있을 수 있어(`치즈 오믈렛`) **끝의 숫자 토큰**을 품질 · 수량으로 읽는다 — 하나면 품질, 둘이면 품질 · 수량.
 */
const USAGE = '사용법: /cook give <요리 id|이름> [품질 0-5] [수량]';
/** 한 번에 넣는 수량 상한 (콘솔 오타로 가방을 수천 개로 채우지 않게 — 밸런스 값이 아니다). */
const QTY_MAX = 99;

function mealDefs(ctx: GameContext): ItemDef[] {
  try { return (ctx.loot?.getAllItemDefs() ?? []).filter((d) => !!d.meal); } catch { return []; }
}

const squash = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

/** id(대소문자 무시) · 한국어 이름 · 띄어쓰기를 뺀 이름 → 요리 def. */
function resolveMeal(raw: string, ctx: GameContext): ItemDef | null {
  const s = raw.trim();
  if (!s) return null;
  const defs = mealDefs(ctx);
  const lower = s.toLowerCase();
  const sq = squash(s);
  return defs.find((d) => d.id.toLowerCase() === lower)
    ?? defs.find((d) => d.name === s)
    ?? defs.find((d) => squash(d.name) === sq)
    ?? null;
}

export const cook: CommandFactory = () => ({
  name: 'cook',
  usage: 'cook [give <요리 id|이름> [품질 0-5] [수량]]',
  description: '품질 붙은 요리를 가방에 넣거나, 지금 조리 중인 요리를 봅니다',
  run(args, ctx) {
    if (args.length === 0) {
      let line = '조리 중이 아닙니다';
      try {
        const s = ctx.housing?.cookSession;
        if (s) line = `조리 중: ${ctx.loot?.getItemDef(s.mealDefId)?.name ?? s.mealDefId} (단계 ${s.steps.length}개)`;
      } catch { /* housing 미준비 */ }
      return `${line}\n${USAGE}`;
    }
    if (args[0].toLowerCase() !== 'give' || args.length < 2) return err(USAGE);
    const loot = ctx.loot;
    const inv = ctx.inventory;
    if (!loot || typeof loot.createItem !== 'function') return err('아이템 시스템이 준비되지 않았습니다');
    if (!inv || typeof inv.tryAddItem !== 'function') return err('인벤토리 시스템이 준비되지 않았습니다');

    // 끝의 숫자 토큰(최대 둘, 이름은 한 토큰 이상 남긴다) = 품질 · 수량
    const rest = args.slice(1);
    const nums: number[] = [];
    while (nums.length < 2 && rest.length > 1 && !Number.isNaN(parseNumber(rest[rest.length - 1]))) {
      nums.unshift(parseNumber(rest.pop()));
    }
    const name = rest.join(' ');
    const def = resolveMeal(name, ctx);
    if (!def) {
      let known = false;
      try { known = !!(loot.getItemDef(name.trim()) ?? loot.getAllItemDefs().find((d) => d.name === name.trim())); } catch { /* skeleton */ }
      return err(known ? `요리가 아닙니다: ${name}` : `알 수 없는 요리: ${name}`);
    }
    const quality = nums[0] ?? 0;
    if (!Number.isInteger(quality) || quality < 0 || quality > MEAL_QUALITY_MAX) return err(`품질은 0 … ${MEAL_QUALITY_MAX} 정수입니다: ${nums[0]}`);
    const qty = nums[1] ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > QTY_MAX) return err(`수량은 1 … ${QTY_MAX} 정수입니다: ${nums[1]}`);

    const stack = Math.max(1, Math.floor(def.stackMax || 1));
    let added = 0;
    while (added < qty) {
      const n = Math.min(stack, qty - added);
      const item = loot.createItem(def.id, n);
      if (quality > 0) item.quality = quality;
      if (!inv.tryAddItem(item)) break;
      added += n;
    }
    const label = `${def.name}${quality > 0 ? ` ${mealQualityStars(quality)}` : ''}`;
    const steps = cookStepsOf(def.id).length === 0 ? ' · 조리대 요리 아님' : '';
    if (added === 0) return err(`가방에 자리가 없습니다: ${label}`);
    if (added < qty) return err(`가방에 자리가 모자랍니다: ${label} ×${added} / ${qty}${steps}`);
    return `${label} ×${added} → 가방${steps}`;
  },
  complete(args, ctx) {
    if (args.length <= 1) {
      const p = (args[0] ?? '').toLowerCase();
      return 'give'.startsWith(p) ? ['give'] : [];
    }
    if (args[0].toLowerCase() !== 'give' || args.length > 2) return [];
    const p = args[1].toLowerCase();
    const out: string[] = [];
    for (const d of mealDefs(ctx)) {
      if (d.retired) continue;
      if (d.id.toLowerCase().startsWith(p)) out.push(d.id);
      else if (d.name.toLowerCase().startsWith(p)) out.push(d.name);
    }
    return out;
  },
});
