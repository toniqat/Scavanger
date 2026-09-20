import type { CommandFactory } from './types';
import { err, parseNumber } from './types';

/**
 * `worm [뱉기초] [weak]` (2026-09-13 · 2026-09-15) — starts the sandworm event **now** under my own feet (in a
 * raid · authority only). It ignores the cumulative probability · the once-per-raid limit · the ground test.
 * `뱉기초` = how long this eruption's bug-spit phase lasts (seconds, 0 = straight to the poison).
 * `weak` = forces the young one (`sandworm_weak` — its own hp · size row in `data/enemies.csv`,
 * `SANDWORM_WEAK_HP` · `SANDWORM_WEAK_SCALE`) — omitted, the planet threat decides (1 → young,
 * 2–3 → adult).
 * The console does not import enemies/ — it only emits the `cheat:sandworm` bus command (`EnemySystem` receives it).
 */
export const worm: CommandFactory = () => ({
  name: 'worm',
  usage: 'worm [뱉기초] [weak]',
  description: '땅굴벌레 이벤트를 지금 발밑에서 시작합니다 (레이드 중 · 호스트만, weak = 어린 개체)',
  run(args, ctx) {
    if (!ctx.isGameplayPhase() || ctx.isTraining()) return err('레이드 중에만 사용할 수 있습니다');
    if (!ctx.isAuthority) return err('호스트만 사용할 수 있습니다');
    let spitS: number | undefined;
    let weak = false;
    for (const a of args) {
      if (a === 'weak' || a === '어린') { weak = true; continue; }
      const n = parseNumber(a);
      if (!(n >= 0)) return err('사용법: /worm [뱉기초 ≥ 0] [weak]');
      spitS = n;
    }
    const payload: { spitS?: number; weak?: boolean } = {};
    if (spitS !== undefined) payload.spitS = spitS;
    if (weak) payload.weak = true;
    ctx.bus.emit('cheat:sandworm', payload);
    const who = weak ? '어린 땅굴벌레' : '땅굴벌레';
    return spitS === undefined ? `${who} 전조 시작 (5초 뒤 분출)` : `${who} 전조 시작 — 뱉기 단계 ${spitS}초`;
  },
});
