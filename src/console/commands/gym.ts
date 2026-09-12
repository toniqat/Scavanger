import type { GameContext, GymStat, ProgressionRef } from '@/shared';
import { GYM_FATIGUE_LABEL_KO, GYM_STATS } from '@/shared';
import type { CommandFactory } from './types';
import { err, parseNumber } from './types';
import { resolveStatId } from './stat';

/**
 * `gym [clear [str|end] | <str|end> <±xp>]` — 헬스장 (A-3a, 2026-09-12) 개발용 명령. **`ProgressionRef` 의 공개 API 만** 쓴다
 * (`profile.trained` · `gymFatigueUntil` 를 직접 만지지 않는다).
 *
 *   - `gym`                    두 운동 능력치의 단련 보너스 · 진행도 · 디버프 남은 시간.
 *   - `gym <stat> <±xp>`       `addTrainedXp(stat, xp)` — 디버프 · 함선 게이트 · 세션 상한 없음, 음수는 뺀다 (0 아래로는 progression 이 막는다).
 *   - `gym clear [str|end]`    `clearGymFatigue(stat?)` — 생략하면 둘 다.
 *
 * 두 dev 메서드는 계약상 optional 이라 `typeof` 로 묻고, 없으면 빨간 줄로 무엇이 없는지 말한다.
 */
const STAT_SHORT: Readonly<Record<GymStat, string>> = { strength: 'str', endurance: 'end' };

function now(ctx: GameContext): number {
  try {
    const n = ctx.net?.serverNow();
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
  } catch { /* offline / skeleton */ }
  return Date.now();
}

/** `23:12:05` (올림 초). */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (v: number): string => v.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function fatigueLeft(prog: ProgressionRef, id: GymStat, t: number): number {
  const until = typeof prog.getGymFatigueUntil === 'function' ? prog.getGymFatigueUntil(id) : 0;
  return until > t ? until - t : 0;
}

function statusLine(prog: ProgressionRef, id: GymStat, ctx: GameContext): string {
  const name = prog.getStatDef(id)?.name ?? id;
  const bonus = typeof prog.getTrainedBonus === 'function' ? prog.getTrainedBonus(id) : 0;
  const progress = typeof prog.getTrainedProgress === 'function' ? prog.getTrainedProgress(id) : 0;
  const next = typeof prog.trainedXpToNext === 'function' ? prog.trainedXpToNext(id) : 0;
  const left = fatigueLeft(prog, id, now(ctx));
  const fatigue = left > 0 ? `${GYM_FATIGUE_LABEL_KO[id]} ${formatRemaining(left)}` : '디버프 없음';
  return `${name} 단련 +${bonus} (${Math.round(progress * next)}/${next}) · ${fatigue}`;
}

/** `str` / `end` / `strength` / `근력` … → 운동 능력치, 아니면 null. */
function gymStatOf(raw: string, ctx: GameContext): GymStat | null {
  const id = resolveStatId(raw, ctx);
  return id && (GYM_STATS as readonly string[]).includes(id) ? (id as GymStat) : null;
}

const USAGE = '사용법: /gym [clear [str|end] | <str|end> <±xp>]';

export const gym: CommandFactory = () => ({
  name: 'gym',
  usage: 'gym [clear [str|end] | <str|end> <±xp>]',
  description: '헬스장 단련 상태를 보거나, 단련 경험치를 더하거나, 운동 디버프를 지웁니다',
  run(args, ctx) {
    const prog = ctx.progression;
    if (!prog || typeof prog.getStatDef !== 'function') return err('진행 시스템이 준비되지 않았습니다');
    if (typeof prog.getTrainedBonus !== 'function' || typeof prog.getGymFatigueUntil !== 'function') {
      return err('진행 시스템에 헬스장(단련) 구현이 아직 없습니다');
    }
    if (args.length === 0) return GYM_STATS.map((id) => statusLine(prog, id, ctx)).join('\n');

    if (args[0].toLowerCase() === 'clear') {
      if (args.length > 2) return err(USAGE);
      let id: GymStat | undefined;
      if (args.length === 2) {
        const s = gymStatOf(args[1], ctx);
        if (!s) return err(`운동 능력치가 아닙니다: ${args[1]} (${GYM_STATS.map((g) => STAT_SHORT[g]).join('/')})`);
        id = s;
      }
      if (typeof prog.clearGymFatigue !== 'function') return err('진행 시스템에 clearGymFatigue 가 아직 없습니다');
      prog.clearGymFatigue(id);
      const shown = id ? [id] : GYM_STATS;
      return `운동 디버프를 지웠습니다\n${shown.map((g) => statusLine(prog, g, ctx)).join('\n')}`;
    }

    if (args.length < 2) return err(USAGE);
    const raw = args.slice(0, -1).join(' ');
    const id = gymStatOf(raw, ctx);
    if (!id) return err(`운동 능력치가 아닙니다: ${raw} (${GYM_STATS.map((g) => STAT_SHORT[g]).join('/')})`);
    const xp = parseNumber(args[args.length - 1]);
    if (Number.isNaN(xp)) return err(`경험치가 숫자가 아닙니다: ${args[args.length - 1]}`);
    if (typeof prog.addTrainedXp !== 'function') return err('진행 시스템에 addTrainedXp 가 아직 없습니다');
    const before = prog.getTrainedBonus(id);
    prog.addTrainedXp(id, xp);
    const after = prog.getTrainedBonus(id);
    const name = prog.getStatDef(id)?.name ?? id;
    const diff = after - before;
    const step = diff !== 0 ? ` · ${name} 단련 ${diff > 0 ? '+' : '−'}${Math.abs(diff)}` : '';
    return `단련 경험치 ${xp >= 0 ? '+' : '−'}${Math.abs(xp)}${step}\n${statusLine(prog, id, ctx)}`;
  },
  complete(args) {
    const shorts = GYM_STATS.map((s) => STAT_SHORT[s]);
    if (args.length <= 1) {
      const p = (args[0] ?? '').toLowerCase();
      return ['clear', ...shorts].filter((n) => n.startsWith(p));
    }
    if (args.length === 2 && args[0].toLowerCase() === 'clear') {
      const p = args[1].toLowerCase();
      return shorts.filter((n) => n.startsWith(p));
    }
    return [];
  },
});
