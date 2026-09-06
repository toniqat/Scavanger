import type { GameContext, SkillId } from '@/shared';
import { SKILL_IDS } from '@/shared';
import type { CommandFactory } from './types';
import { err, parseNumber } from './types';

/** Resolve `gun_AR` / `gun_ar` / `사격 · 돌격소총` → SkillId, or null. */
export function resolveSkillId(raw: string, ctx: GameContext): SkillId | null {
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  for (const id of SKILL_IDS) if (id.toLowerCase() === lower) return id;
  const p = ctx.progression;
  if (p) for (const id of SKILL_IDS) { const def = p.getSkillDef(id); if (def && def.name === s) return id; }
  return null;
}

/** `skill <id|한국어> <±xp>` — signed raw skill XP through `ctx.progression.addSkillXpRaw`. */
export const skill: CommandFactory = () => ({
  name: 'skill',
  usage: 'skill <id|이름> <±xp>',
  description: '스킬 경험치를 스케일 없이 더하거나 뺍니다 (gun_AR 등 14종, 한국어 이름)',
  run(args, ctx) {
    if (args.length < 2) return err('사용법: /skill <id|이름> <±xp>');
    const prog = ctx.progression;
    if (!prog || typeof prog.addSkillXpRaw !== 'function') return err('진행 시스템이 준비되지 않았습니다');
    const amount = parseNumber(args[args.length - 1]);
    if (Number.isNaN(amount)) return err(`경험치가 숫자가 아닙니다: ${args[args.length - 1]}`);
    const rawName = args.slice(0, -1).join(' ');
    const id = resolveSkillId(rawName, ctx);
    if (!id) return err(`알 수 없는 스킬: ${rawName} (${SKILL_IDS.join('/')})`);
    prog.addSkillXpRaw(id, amount);
    const level = prog.getSkill(id);
    const progress = typeof prog.getSkillProgress === 'function' ? prog.getSkillProgress(id) : 0;
    const name = prog.getSkillDef(id)?.name ?? id;
    return `${name} Lv.${level} (${Math.round(progress * 100)} %)`;
  },
  complete(args, ctx) {
    if (args.length > 1) return [];
    const p = (args[0] ?? '').toLowerCase();
    const names: string[] = [...SKILL_IDS];
    const prog = ctx.progression;
    if (prog) for (const id of SKILL_IDS) { const n = prog.getSkillDef(id)?.name; if (n) names.push(n); }
    return names.filter((n) => n.toLowerCase().startsWith(p));
  },
});
