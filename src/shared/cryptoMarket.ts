/* ────────────────────────────────────────────────────────────────────────────
 * The **pure formulas** of the crypto quote · trading · mining cycle (2026-09-13, `src/housing/README.md` Decisions, user's decision).
 *
 * Imported by the browser AND the Node relay — for the same reason as `shared/credits.ts` it has **no runtime import** (no csv loader, no three).
 * Every number is passed in: the client from `shared/crypto.ts` (← `data/crypto.csv` · `data/tuning.csv`),
 * the relay from the `crypto` section of `server/economy.gen.json`. The same formula is never copied into two places.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Exchange chart ranges. */
export type CryptoChartRange = '1h' | '1d' | '1w' | '1M';
export const CRYPTO_CHART_RANGES: readonly CryptoChartRange[] = ['1h', '1d', '1w', '1M'];
export const CRYPTO_CHART_RANGE_LABEL_KO: Readonly<Record<CryptoChartRange, string>> = {
  '1h': '1시간', '1d': '1일', '1w': '1주', '1M': '1개월',
};
/** Length of one candle per range (ms) — the server builds its answer with it and the screen draws with it (a display format, not a balance number). */
export const CRYPTO_CANDLE_MS: Readonly<Record<CryptoChartRange, number>> = {
  '1h': 60_000, '1d': 900_000, '1w': 3_600_000, '1M': 14_400_000,
};
/** Candles per range (= range ÷ candle length). The server never sends more than this. */
export const CRYPTO_CANDLE_COUNT: Readonly<Record<CryptoChartRange, number>> = {
  '1h': 60, '1d': 96, '1w': 168, '1M': 180,
};

/** One quote candle. `t` = server epoch ms of the candle's start; prices are credits per coin. */
export interface CryptoCandle { t: number; o: number; h: number; l: number; c: number }

export type CryptoTradeSide = 'buy' | 'sell';

/**
 * Credits for one trade (always an integer ≥ 0). Selling takes the fee off and **floors**, buying adds it and **ceils** —
 * splitting a sale floors several times and splitting a purchase ceils several times, so there is no way to profit by
 * splitting a trade (the same reason as `sellPriceFrom`).
 */
export function cryptoTradeCredits(
  side: CryptoTradeSide, pricePerCoin: number, units: number, unitsPerCoin: number, fee: number,
): number {
  const u = Math.max(0, Math.floor(units));
  const gross = (Math.max(0, pricePerCoin) * u) / Math.max(1, unitsPerCoin);
  const f = Math.min(0.99, Math.max(0, fee));
  return side === 'sell' ? Math.max(0, Math.floor(gross * (1 - f))) : Math.max(0, Math.ceil(gross * (1 + f)));
}

/**
 * Mining cycle (ms) of a cluster with `cores` compute cores plugged in. 1 core = `baseHours`, × `coreTimeMul` for every
 * extra one (user's spec: 1 core 100 % · 2 cores 50 % · 3 cores 25 % …). With no core or no base time it is `Infinity` (= it does not mine).
 */
export function miningCycleMs(baseHours: number, cores: number, coreTimeMul: number): number {
  const n = Math.floor(cores);
  if (!(n >= 1) || !(baseHours > 0)) return Infinity;
  return Math.max(1000, baseHours * 3_600_000 * Math.pow(coreTimeMul, n - 1));
}

/**
 * Accumulated progress (in cycles — 1 = one mining round). It ran at `cycleMs` from `segmentAt` to `now`; `now < segmentAt` does not run.
 * The moment the core count, the coin or the running state changes, the caller folds the current value into `progress` and opens a new segment with `segmentAt = now`.
 */
export function miningProgressAt(progress: number, segmentAt: number, now: number, cycleMs: number): number {
  const p = Number.isFinite(progress) ? Math.max(0, progress) : 0;
  if (!Number.isFinite(cycleMs) || cycleMs <= 0) return p;
  return p + Math.max(0, now - segmentAt) / cycleMs;
}

/** Wallet units as coin notation (`12.345`). Decimal places = log10(unitsPerCoin). */
export function formatCryptoUnits(units: number, unitsPerCoin: number): string {
  const per = Math.max(1, Math.floor(unitsPerCoin));
  const digits = Math.max(0, Math.round(Math.log10(per)));
  const u = Math.max(0, Math.floor(units));
  const whole = Math.floor(u / per);
  if (digits === 0) return String(whole);
  return `${whole}.${String(u % per).padStart(digits, '0')}`;
}
