/* ────────────────────────────────────────────────────────────────────────────
 * 암호화폐 시세 · 거래 · 채굴 주기의 **순수 식** (2026-09-13, docs/plans/power-crypto.md, 사용자 결정).
 *
 * 브라우저와 Node 릴레이가 함께 import 한다 — `shared/credits.ts` 와 같은 이유로 **런타임 import 가 없다** (csv 로더도 three 도).
 * 수치는 전부 인자로 받는다: 클라이언트는 `shared/crypto.ts`(← `data/crypto.csv` · `data/tuning.csv`)에서,
 * 릴레이는 `server/economy.gen.json` 의 `crypto` 절에서 넘긴다. 같은 식을 두 곳에 베끼지 않는다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 거래소 차트 기간. */
export type CryptoChartRange = '1h' | '1d' | '1w' | '1M';
export const CRYPTO_CHART_RANGES: readonly CryptoChartRange[] = ['1h', '1d', '1w', '1M'];
export const CRYPTO_CHART_RANGE_LABEL_KO: Readonly<Record<CryptoChartRange, string>> = {
  '1h': '1시간', '1d': '1일', '1w': '1주', '1M': '1개월',
};
/** 기간별 봉 하나의 길이(ms) — 서버가 이 길이로 봉을 만들어 답하고 화면이 이 길이로 그린다 (표시 형식이지 밸런스 수치가 아니다). */
export const CRYPTO_CANDLE_MS: Readonly<Record<CryptoChartRange, number>> = {
  '1h': 60_000, '1d': 900_000, '1w': 3_600_000, '1M': 14_400_000,
};
/** 기간별 봉 개수 (= 기간 ÷ 봉 길이). 서버는 이보다 많이 보내지 않는다. */
export const CRYPTO_CANDLE_COUNT: Readonly<Record<CryptoChartRange, number>> = {
  '1h': 60, '1d': 96, '1w': 168, '1M': 180,
};

/** 시세 봉 하나. `t` = 봉 시작의 서버 epoch ms, 가격은 코인 1개당 크레딧. */
export interface CryptoCandle { t: number; o: number; h: number; l: number; c: number }

export type CryptoTradeSide = 'buy' | 'sell';

/**
 * 거래 한 번의 크레딧 (늘 ≥ 0 인 정수). 팔면 수수료를 떼고 **내림**, 사면 수수료를 얹고 **올림** —
 * 쪼개 팔면 내림이 여러 번, 쪼개 사면 올림이 여러 번이라 나눠 거래해서 이득 보는 길이 없다 (`sellPriceFrom` 과 같은 이유).
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
 * 연산 코어 `cores` 개가 꽂힌 클러스터의 채굴 주기 (ms). 1개 = `baseHours`, 하나 늘 때마다 × `coreTimeMul`
 * (사용자 명세: 1개 100 % · 2개 50 % · 3개 25 % …). 코어가 없거나 기준 시간이 없으면 `Infinity` (= 채굴하지 않는다).
 */
export function miningCycleMs(baseHours: number, cores: number, coreTimeMul: number): number {
  const n = Math.floor(cores);
  if (!(n >= 1) || !(baseHours > 0)) return Infinity;
  return Math.max(1000, baseHours * 3_600_000 * Math.pow(coreTimeMul, n - 1));
}

/**
 * 누적 진행도 (주기 단위 — 1 = 한 번 채굴). `segmentAt` 부터 `now` 까지 `cycleMs` 로 흘렀다. `now < segmentAt` 이면 흐르지 않는다.
 * 코어 수 · 코인 · 가동 상태가 바뀌는 순간 부르는 쪽이 지금 값을 `progress` 로 접고 `segmentAt = now` 로 새 구간을 연다.
 */
export function miningProgressAt(progress: number, segmentAt: number, now: number, cycleMs: number): number {
  const p = Number.isFinite(progress) ? Math.max(0, progress) : 0;
  if (!Number.isFinite(cycleMs) || cycleMs <= 0) return p;
  return p + Math.max(0, now - segmentAt) / cycleMs;
}

/** 지갑 단위를 코인 표기로 (`12.345`). 소수 자릿수 = log10(unitsPerCoin). */
export function formatCryptoUnits(units: number, unitsPerCoin: number): string {
  const per = Math.max(1, Math.floor(unitsPerCoin));
  const digits = Math.max(0, Math.round(Math.log10(per)));
  const u = Math.max(0, Math.floor(units));
  const whole = Math.floor(u / per);
  if (digits === 0) return String(whole);
  return `${whole}.${String(u % per).padStart(digits, '0')}`;
}
