import { Keys, MOVE_CHEAT_SPEED } from '@/shared';
import type { CommandFactory } from './types';
import { err } from './types';

const ON = new Set(['1', 'on', 'true', 'yes']);
const OFF = new Set(['0', 'off', 'false', 'no']);

/** `movecheat [0|1]` — toggle the Home fast-move cheat (no argument = flip). Emits `cheat:moveCheat`. */
export const movecheat: CommandFactory = (host) => ({
  name: 'movecheat',
  usage: 'movecheat <0|1>',
  description: `이동 치트 토글 — 켜진 동안 ${Keys.MOVE_CHEAT} 홀드로 카메라 방향 ${MOVE_CHEAT_SPEED} m/s 이동`,
  run(args) {
    let next: boolean;
    if (args.length === 0) next = !host.moveCheat;
    else {
      const a = args[0].toLowerCase();
      if (ON.has(a)) next = true;
      else if (OFF.has(a)) next = false;
      else return err('사용법: /movecheat <0|1>');
    }
    host.setMoveCheat(next);
    return next ? `이동 치트 켜짐 (${Keys.MOVE_CHEAT} 홀드)` : '이동 치트 꺼짐';
  },
  complete(args) {
    const p = args[0] ?? '';
    return ['0', '1'].filter((v) => v.startsWith(p));
  },
});
