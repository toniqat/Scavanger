import type { CommandFactory } from './types';
import { err, parseNumber } from './types';

/**
 * `worm [뱉기초] [weak]` (2026-09-13 · 2026-09-15) — 땅굴벌레 이벤트를 **지금** 내 발밑에서 시작한다 (레이드 중 · 권위만).
 * 누적 확률 · 레이드당 1회 · 땅 검사를 무시한다. `뱉기초` = 이번 분출의 버그 뱉기 단계 길이(초, 0 = 곧장 독극물).
 * `weak` = 어린 개체(`sandworm_weak`, 체력 750 · 70 %)로 강제 — 생략하면 행성 위협이 정한다 (1 → 어린, 2–3 → 성체).
 * 콘솔은 enemies/ 를 import 하지 않는다 — `cheat:sandworm` 버스 명령만 낸다 (`EnemySystem` 이 받는다).
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
