import type { ComputeClusterInfo, GameContext, HousingRef } from '@/shared';
import { CRYPTO_COIN_DEFS, CRYPTO_COIN_MAP, coinToUnits, formatCoinUnits } from '@/shared';
import type { CommandFactory } from './types';
import { err, parseNumber } from './types';

/**
 * `crypto [wallet <coin> <coins> | cores <uid|all> <n> | ff <hours>]` — 암호화폐 채굴 (2026-09-13, docs/plans/power-crypto.md) 개발용 명령.
 * **`HousingRef` 의 공개 API 만** 쓴다 (`state.clusters` · `cryptoWallet` 를 직접 만지지 않는다 — dev 메서드 셋은 계약의 optional 이다).
 *
 *   - `crypto`                       클러스터마다 코인 · 코어 · 주기 · 진행 · 막힌 사유, 그리고 지갑.
 *   - `crypto wallet <coin> <coins>`  지갑 잔고를 그 코인 개수로 **맞춘다** (`devSetCryptoWallet`, `housing:walletChanged {reason:'cheat'}`).
 *   - `crypto cores <uid|all> <n>`    코어를 아이템 없이 n 개로 맞춘다 (`devSetClusterCores` — 진행도는 접는다).
 *   - `crypto ff <hours>`             채굴할 수 있는 모든 클러스터의 시계를 앞당기고 끝난 주기를 넣는다 (`devAdvanceMining`).
 */
const USAGE = '사용법: /crypto [wallet <코인> <개수> | cores <uid|all> <n> | ff <시간>]';

function hms(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (v: number): string => v.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function coinName(id: string | null): string {
  return id ? CRYPTO_COIN_MAP.get(id)?.name ?? id : '코인 없음';
}

function clusterLine(c: ComputeClusterInfo): string {
  const cycle = c.cycleMs > 0 ? `주기 ${hms(c.cycleMs)} · 진행 ${Math.round(c.progress * 100)} %` : '주기 없음';
  const state = c.mining ? `채굴 중 (${hms(c.remainingS * 1000)} 남음)` : `멈춤 — ${c.block ?? '?'}`;
  return `${c.uid} (방 ${c.room + 1}) · ${coinName(c.coinId)} · 코어 ${c.cores}/${c.maxCores} · ${cycle} · ${state}`;
}

function status(h: HousingRef): string {
  const clusters = h.getComputeClusters?.() ?? [];
  const wallet = h.getCryptoWallet?.() ?? {};
  const lines = clusters.length ? clusters.map(clusterLine) : ['배치된 연산 클러스터가 없습니다'];
  lines.push(`메인 컴퓨터: ${h.getMiningComputerUid?.() ?? '없음'}`);
  const held = CRYPTO_COIN_DEFS.filter((d) => (wallet[d.id] ?? 0) > 0).map((d) => `${d.name} ${formatCoinUnits(wallet[d.id])}`);
  lines.push(`지갑: ${held.length ? held.join(' · ') : '비어 있음'}`);
  return lines.join('\n');
}

function housingOf(ctx: GameContext): HousingRef | null {
  const h = ctx.housing;
  return h && typeof h.getComputeClusters === 'function' ? h : null;
}

export const cryptoCmd: CommandFactory = () => ({
  name: 'crypto',
  usage: 'crypto [wallet <coin> <coins> | cores <uid|all> <n> | ff <hours>]',
  description: '암호화폐 채굴 상태를 보거나, 지갑 잔고 · 클러스터 코어 · 채굴 시간을 조작합니다',
  run(args, ctx) {
    const h = housingOf(ctx);
    if (!h) return err('함선 시스템에 암호화폐 채굴 구현이 아직 없습니다');
    if (args.length === 0) return status(h);
    const sub = args[0].toLowerCase();

    if (sub === 'wallet') {
      if (args.length !== 3) return err(USAGE);
      const coin = CRYPTO_COIN_MAP.get(args[1].toLowerCase()) ?? CRYPTO_COIN_DEFS.find((d) => d.ticker.toLowerCase() === args[1].toLowerCase() || d.name === args[1]);
      if (!coin) return err(`알 수 없는 코인입니다: ${args[1]} (${CRYPTO_COIN_DEFS.map((d) => d.id).join('/')})`);
      const coins = parseNumber(args[2]);
      if (!Number.isFinite(coins) || coins < 0) return err(`코인 개수가 올바르지 않습니다: ${args[2]}`);
      if (typeof h.devSetCryptoWallet !== 'function') return err('함선 시스템에 devSetCryptoWallet 이 아직 없습니다');
      const reason = h.devSetCryptoWallet(coin.id, coinToUnits(coins));
      if (reason) return err(reason);
      return `${coin.name} 지갑 = ${formatCoinUnits(h.getCryptoWallet?.()[coin.id] ?? 0)}`;
    }

    if (sub === 'cores') {
      if (args.length !== 3) return err(USAGE);
      const n = parseNumber(args[2]);
      if (!Number.isInteger(n) || n < 0) return err(`코어 수가 올바르지 않습니다: ${args[2]}`);
      if (typeof h.devSetClusterCores !== 'function') return err('함선 시스템에 devSetClusterCores 가 아직 없습니다');
      const all = h.getComputeClusters?.() ?? [];
      const targets = args[1].toLowerCase() === 'all' ? all.map((c) => c.uid) : [args[1]];
      if (targets.length === 0) return err('배치된 연산 클러스터가 없습니다');
      const out: string[] = [];
      for (const uid of targets) {
        const reason = h.devSetClusterCores(uid, n);
        if (reason) return err(`${uid}: ${reason}`);
        const info = h.getComputeCluster?.(uid);
        out.push(info ? clusterLine(info) : `${uid} 코어 ${n}`);
      }
      return out.join('\n');
    }

    if (sub === 'ff') {
      if (args.length !== 2) return err(USAGE);
      const hours = parseNumber(args[1]);
      if (!Number.isFinite(hours) || hours <= 0) return err(`시간이 올바르지 않습니다: ${args[1]}`);
      if (typeof h.devAdvanceMining !== 'function') return err('함선 시스템에 devAdvanceMining 이 아직 없습니다');
      const units = h.devAdvanceMining(hours);
      return `채굴 시계 +${hours}시간 → 지갑에 ${formatCoinUnits(units)} 코인 단위 합산\n${status(h)}`;
    }

    return err(USAGE);
  },
  complete(args, ctx) {
    if (args.length <= 1) return ['wallet', 'cores', 'ff'];
    const sub = args[0].toLowerCase();
    if (sub === 'wallet' && args.length === 2) return CRYPTO_COIN_DEFS.map((d) => d.id);
    if (sub === 'cores' && args.length === 2) return ['all', ...(housingOf(ctx)?.getComputeClusters?.() ?? []).map((c) => c.uid)];
    return [];
  },
});
