import type { CommandFactory } from './types';
import { fmt } from './types';

/** `pos` — current phase, feet position, yaw and (in the hub) ship / room. Debug convenience. */
export const pos: CommandFactory = () => ({
  name: 'pos',
  usage: 'pos',
  description: '현재 페이즈와 좌표를 출력합니다',
  run(_args, ctx, print) {
    const p = ctx.player;
    print(`페이즈: ${ctx.phase}${ctx.isMultiplayer ? ' (멀티플레이)' : ''}${ctx.hub?.ship ? ` · 함선: ${ctx.hub.ship}` : ''}${ctx.hub?.currentRoom != null ? ` · 방 ${ctx.hub.currentRoom + 1}` : ''}`, 'info');
    if (!p) return '플레이어 없음';
    const yawDeg = ((p.yaw * 180) / Math.PI) % 360;
    const seed = ctx.world?.seed;
    return `위치: (${fmt(p.position.x)}, ${fmt(p.position.y)}, ${fmt(p.position.z)}) · 방향 ${fmt(yawDeg, 0)}°${seed !== undefined ? ` · 시드 ${seed}` : ''}`;
  },
});
