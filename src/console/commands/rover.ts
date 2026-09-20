import type { CommandFactory } from './types';
import { err, fmt, parseNumber } from './types';

const SUBS = ['tp', 'hp', 'speed', 'depart', 'arrive'];

/**
 * `rover [tp | hp <n> | speed <배수> | depart | arrive]` (2026-09-13) — rover status · dev cheat.
 * No argument = one status line. `tp` = my body to the side of the vehicle. The rest are authority (solo · host)
 * only: `hp` = sets the hp (0 = destroyed) · `speed` = the travel speed multiplier · `depart` = the dwell timer to
 * 0 · `arrive` = while it is running, skips to just short of the destination.
 * The console does not import world/ — reading is `ctx.world.rover`, and the only cheat is the `cheat:rover` bus
 * command.
 */
export const rover: CommandFactory = () => ({
  name: 'rover',
  usage: 'rover [tp|hp <n>|speed <배수>|depart|arrive]',
  description: '탐사 차량 상태 · 치트 (레이드 중, 치트는 호스트만)',
  run(args, ctx) {
    if (!ctx.isGameplayPhase() || ctx.isTraining()) return err('레이드 중에만 사용할 수 있습니다');
    const rv = ctx.world?.rover;
    if (!rv) return err('이번 레이드에는 탐사 차량이 없습니다');
    const v = rv.vehicle;
    const sub = args[0];
    if (!sub) {
      return `탐사 차량 ${v.state} · 체력 ${Math.round(v.hp)}/${v.maxHp} · ${v.stationId ?? '—'} → ${v.targetId ?? '—'} · `
        + `타이머 ${fmt(v.timer, 1)}초 · 탑승 ${v.riders.length} · 정류장 ${rv.route.stations.length}곳${rv.stationsRevealed ? ' (공개됨)' : ''}`;
    }
    if (sub === 'tp') {
      const p = ctx.player;
      const w = ctx.world;
      if (!p || !w) return err('플레이어가 없습니다');
      const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
      const off = rv.halfWidth + 2;
      const to = v.position.clone();
      to.x += -s * off; to.z += c * off;
      to.y = w.getSurfaceY(to.x, to.z, v.position.y + 0.6);
      p.teleport(to, undefined, true);
      return '탐사 차량 옆으로 이동';
    }
    if (!ctx.isAuthority) return err('호스트만 사용할 수 있습니다');
    if (sub === 'hp') {
      const n = parseNumber(args[1]);
      if (!(n >= 0)) return err('사용법: /rover hp <체력 ≥ 0>');
      ctx.bus.emit('cheat:rover', { action: 'hp', value: n });
      return n === 0 ? '탐사 차량 파괴' : `탐사 차량 체력 ${n}`;
    }
    if (sub === 'speed') {
      const n = parseNumber(args[1]);
      if (!(n > 0)) return err('사용법: /rover speed <배수 > 0>');
      ctx.bus.emit('cheat:rover', { action: 'speed', value: n });
      return `탐사 차량 속도 ×${n}`;
    }
    if (sub === 'depart') { ctx.bus.emit('cheat:rover', { action: 'depart' }); return '정차 타이머 0'; }
    if (sub === 'arrive') { ctx.bus.emit('cheat:rover', { action: 'arrive' }); return '목적지 바로 앞으로'; }
    return err(`모르는 하위 명령: ${sub} (${SUBS.join(' · ')})`);
  },
  complete(args) {
    return args.length <= 1 ? SUBS.filter((s) => s.startsWith(args[0] ?? '')) : [];
  },
});
