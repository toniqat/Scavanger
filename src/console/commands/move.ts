import * as THREE from 'three';
import { MAP_SIZE } from '@/shared';
import type { CommandFactory } from './types';
import { err, fmt, parseNumber } from './types';

const target = new THREE.Vector3();

/** `move <x>,<y>,<z>` — teleport on the planet (gameplay phases only). Commas and spaces both separate the numbers. */
export const move: CommandFactory = () => ({
  name: 'move',
  usage: 'move <x>,<y>,<z>',
  description: '행성에서 좌표로 순간이동합니다 (y 는 지형 아래면 지형 높이로)',
  run(args, ctx) {
    if (!ctx.isGameplayPhase()) return err('행성(임무 중)에서만 사용할 수 있습니다');
    const parts = args.join(' ').split(/[,\s]+/).filter(Boolean);
    const nums = parts.map(parseNumber);
    if (nums.length !== 3 || nums.some((n) => Number.isNaN(n))) return err('좌표 3개가 필요합니다: /move <x>,<y>,<z>');
    const [x, y0, z] = nums;
    const world = ctx.world;
    const player = ctx.player;
    if (!world || !player) return err('행성이 준비되지 않았습니다');
    if (!world.isInsideBounds(x, z)) return err(`맵 범위를 벗어났습니다 (±${MAP_SIZE / 2})`);
    if (typeof player.teleport !== 'function') return err('player.teleport 가 아직 없습니다');
    const ground = world.getHeightAt(x, z);
    const y = y0 < ground ? ground : y0;
    target.set(x, y, z);
    player.teleport(target, undefined, y === ground);
    return `이동: (${fmt(x)}, ${fmt(y)}, ${fmt(z)})`;
  },
});
