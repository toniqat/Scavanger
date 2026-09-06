import type { CommandFactory } from './types';
import { err } from './types';

/**
 * Same rule as the hub terminal's `parseSeed` (copied — hub internals are not importable):
 * `random` / blank → null, digits → uint32, anything else → FNV-1a hash of the text.
 */
export function parseSeedArg(raw: string): number | null {
  const s = raw.trim();
  if (!s || s.toLowerCase() === 'random') return null;
  if (/^\d+$/.test(s)) return Number(s) >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** `seed <숫자|문구|random>` — next mission seed via `ctx.hub.setMissionSeed`; ship phase only, lobby host only. */
export const seed: CommandFactory = () => ({
  name: 'seed',
  usage: 'seed <숫자|문구|random>',
  description: '다음 임무 시드를 정합니다 (함선에서만, 로비는 호스트만)',
  run(args, ctx) {
    if (args.length === 0) return err('사용법: /seed <숫자|문구|random>');
    if (ctx.phase !== 'hub') return err('함선(hub)에서만 사용할 수 있습니다');
    const hub = ctx.hub;
    if (!hub || typeof hub.setMissionSeed !== 'function') return err('함선 시스템이 준비되지 않았습니다');
    const value = parseSeedArg(args.join(' '));
    if (!hub.setMissionSeed(value)) return err('로비 호스트만 시드를 설정할 수 있습니다');
    ctx.bus.emit('cheat:seed', { seed: value });
    return value === null ? '임무 시드: 무작위' : `임무 시드: ${value}`;
  },
  complete(args) {
    const p = (args[0] ?? '').toLowerCase();
    return 'random'.startsWith(p) ? ['random'] : [];
  },
});
