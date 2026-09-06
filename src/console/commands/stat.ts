import type { GameContext, StatId } from '@/shared';
import { STAT_IDS } from '@/shared';
import type { CommandFactory } from './types';
import { err, parseNumber } from './types';

/** Short aliases accepted next to the full ids and the Korean names from `getStatDef`. */
const STAT_ALIASES: Record<string, StatId> = {
  str: 'strength', end: 'endurance', per: 'perception', int: 'intelligence', dex: 'dexterity',
};

/** Resolve `str` / `strength` / `근력` → StatId (case-insensitive), or null. */
export function resolveStatId(raw: string, ctx: GameContext): StatId | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (STAT_ALIASES[s]) return STAT_ALIASES[s];
  if ((STAT_IDS as readonly string[]).includes(s)) return s as StatId;
  const p = ctx.progression;
  if (p) for (const id of STAT_IDS) { const def = p.getStatDef(id); if (def && def.name === raw.trim()) return id; }
  return null;
}

export function statNames(ctx: GameContext): string[] {
  const p = ctx.progression;
  const out: string[] = [...Object.keys(STAT_ALIASES), ...STAT_IDS];
  if (p) for (const id of STAT_IDS) { const n = p.getStatDef(id)?.name; if (n) out.push(n); }
  return out;
}

/** `stat <id|한국어> <±xp>` — raw stat XP through `ctx.progression.addStatXp`; prints `근력 7 (312/1852)`. */
export const stat: CommandFactory = () => ({
  name: 'stat',
  usage: 'stat <id|이름> <±xp>',
  description: '스탯 경험치를 더하거나 뺍니다 (str/end/per/int/dex, 전체 id, 한국어 이름)',
  run(args, ctx) {
    if (args.length < 2) return err('사용법: /stat <id|이름> <±xp>');
    const prog = ctx.progression;
    if (!prog || typeof prog.addStatXp !== 'function') return err('진행 시스템이 준비되지 않았습니다');
    const amount = parseNumber(args[args.length - 1]);
    if (Number.isNaN(amount)) return err(`경험치가 숫자가 아닙니다: ${args[args.length - 1]}`);
    const id = resolveStatId(args.slice(0, -1).join(' '), ctx);
    if (!id) return err(`알 수 없는 스탯: ${args.slice(0, -1).join(' ')} (${STAT_IDS.join('/')})`);
    prog.addStatXp(id, amount);
    const value = prog.getStat(id);
    const next = typeof prog.statXpToNext === 'function' ? prog.statXpToNext(id) : 0;
    const progress = typeof prog.getStatProgress === 'function' ? prog.getStatProgress(id) : 0;
    const name = prog.getStatDef(id)?.name ?? id;
    return `${name} ${value} (${Math.round(progress * next)}/${next})`;
  },
  complete(args, ctx) {
    if (args.length > 1) return [];
    const p = (args[0] ?? '').toLowerCase();
    return statNames(ctx).filter((n) => n.toLowerCase().startsWith(p));
  },
});
