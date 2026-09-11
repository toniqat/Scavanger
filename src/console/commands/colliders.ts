import type { CommandFactory } from './types';
import { err } from './types';

const ON = new Set(['1', 'on', 'true', 'yes']);
const OFF = new Set(['0', 'off', 'false', 'no']);

/**
 * `colliders [0|1]` — 플레이어 둘레 콜라이더 와이어프레임 토글 (인자 없음 = 뒤집기). 2026-09-12: 실내 "보이지 않는 벽"
 * 을 눈으로 찾는 도구. 그리기는 `ColliderOverlay` (원기둥 노랑 · 상자 하늘 · 경사 초록 · 볼록 윤곽 주황).
 */
export const colliders: CommandFactory = (host) => ({
  name: 'colliders',
  usage: 'colliders <0|1>',
  description: '콜라이더 와이어프레임 토글 — 원기둥 노랑 · 상자 하늘 · 경사 초록 · 볼록 윤곽 주황 (플레이어 둘레 30 m)',
  run(args) {
    let next: boolean;
    if (args.length === 0) next = !host.colliders;
    else {
      const a = args[0].toLowerCase();
      if (ON.has(a)) next = true;
      else if (OFF.has(a)) next = false;
      else return err('사용법: /colliders <0|1>');
    }
    host.setColliders(next);
    return next ? `콜라이더 표시 켜짐 (${host.colliderCount}개)` : '콜라이더 표시 꺼짐';
  },
  complete(args) {
    const p = args[0] ?? '';
    return ['0', '1'].filter((v) => v.startsWith(p));
  },
});
