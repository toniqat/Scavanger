import type { CommandFactory } from './types';
import { err, parseNumber } from './types';

/**
 * `worm [뱉기초]` (2026-09-13) — 지하벌레 이벤트를 **지금** 내 발밑에서 시작한다 (레이드 중 · 권위만).
 * 굴림 · 시각 창 · 레이드당 1회는 무시한다. `뱉기초` = 이번 분출의 버그 뱉기 단계 길이(초, 0 = 곧장 독극물).
 * 콘솔은 enemies/ 를 import 하지 않는다 — `cheat:sandworm` 버스 명령만 낸다 (`EnemySystem` 이 받는다).
 */
export const worm: CommandFactory = () => ({
  name: 'worm',
  usage: 'worm [뱉기초]',
  description: '지하벌레 이벤트를 지금 발밑에서 시작합니다 (레이드 중 · 호스트만)',
  run(args, ctx) {
    if (!ctx.isGameplayPhase() || ctx.isTraining()) return err('레이드 중에만 사용할 수 있습니다');
    if (!ctx.isAuthority) return err('호스트만 사용할 수 있습니다');
    let spitS: number | undefined;
    if (args.length > 0) {
      const n = parseNumber(args[0]);
      if (!(n >= 0)) return err('사용법: /worm [뱉기초 ≥ 0]');
      spitS = n;
    }
    ctx.bus.emit('cheat:sandworm', spitS === undefined ? {} : { spitS });
    return spitS === undefined ? '지하벌레 전조 시작 (5초 뒤 분출)' : `지하벌레 전조 시작 — 뱉기 단계 ${spitS}초`;
  },
});
