/* ────────────────────────────────────────────────────────────────────────────
 * 암호화폐 정의 + 채굴 · 거래 수치 (2026-09-13, docs/plans/power-crypto.md, 사용자 결정).
 *
 * 원본은 `data/crypto.csv`(코인 8종) + `data/tuning.csv`(단위 · 수수료 · 코어 배수 · 시세 틱). 이 파일은 csv 로더를 쓰므로
 * **릴레이는 import 하지 않는다** — 릴레이가 필요한 값은 `scripts/economy-table.mjs` 가 `server/economy.gen.json` 의
 * `crypto` 절로 옮기고, 식은 둘 다 `shared/cryptoMarket.ts`(런타임 import 없음)를 부른다.
 *
 * 규칙 요약 (사용자 결정):
 *  - 처음 4종(`corp` 없음)은 열려 있고, 나머지 4종은 그 기업의 퀘스트(`unlockQuest`)를 완료해야 채굴 · 매매할 수 있다. 차트는 늘 보인다.
 *  - 채굴은 연산 클러스터 한 대 = 한 주기. 코어 n 개면 주기 = `cycleHours × COMPUTE_CORE_TIME_MUL^(n−1)`, 한 주기에 `yieldUnits` 가 지갑에 들어온다.
 *  - 지갑은 정수 단위(`CRYPTO_UNITS_PER_COIN` 단위 = 코인 1개)이고 함선 상태(`ShipState.cryptoWallet`)에 산다.
 *  - 매매는 서버 시세로만 한다 — 크레딧 사유 `cbuy:<coin>:<units>` · `csell:<coin>:<units>` 를 릴레이가 시세 창 안에서 검증한다.
 * ──────────────────────────────────────────────────────────────────────────── */
import { csvRows, keyTable } from './data/tables';
import type { CorpId } from './meta';
/* 2026-09-14: 기업 퀘스트 폐지 — 해금 퀘스트는 NPC 퀘스트 (`data/npc_quests.csv`) */
import { NPC_QUEST_DEFS } from './npc';
import { cryptoTradeCredits, formatCryptoUnits, miningCycleMs, type CryptoTradeSide } from './cryptoMarket';

const T = /* data/tuning.csv */ keyTable('tuning.csv');

export interface CryptoCoinDef {
  /** 소문자 · 숫자 · _ — 세이브 · 서버 시세 · 크레딧 사유가 이 id 를 쓴다. */
  id: string;
  name: string;
  /** 거래소 표기 (`SCRP`). */
  ticker: string;
  /** 연관 기업. null = 처음부터 열린 코인. */
  corp: CorpId | null;
  /** 완료해야 채굴 · 매매가 열리는 NPC 퀘스트 id (`data/npc_quests.csv`). null = 열려 있다. */
  unlockQuest: string | null;
  color: string;
  glyph: string;
  /** 코어 1개일 때 채굴 주기 (실시간 시간). */
  cycleHours: number;
  /** 주기 한 번에 지갑에 들어오는 단위 수. */
  yieldUnits: number;
  /** 코인 1개의 기준 시세 (크레딧). */
  basePrice: number;
  /** 하루 표준편차 (비율). 서버 시세 시뮬레이션이 쓴다. */
  volatility: number;
  description: string;
}

const COIN_ID = /^[a-z0-9_]+$/;
const QUEST_IDS = new Set(NPC_QUEST_DEFS.map((q) => q.id));

export const CRYPTO_COIN_DEFS: readonly CryptoCoinDef[] = csvRows('crypto.csv').map((r) => {
  const id = r.str('id');
  if (id && !COIN_ID.test(id)) r.report('id', `'${id}' — 소문자 · 숫자 · _ 만 쓴다 (크레딧 사유 문법)`);
  const unlockQuest = r.has('unlockQuest') ? r.str('unlockQuest') : null;
  if (unlockQuest && !QUEST_IDS.has(unlockQuest)) r.report('unlockQuest', `'${unlockQuest}' 는 data/npc_quests.csv 에 없는 퀘스트다`);
  return {
    id,
    name: r.str('name'),
    ticker: r.str('ticker'),
    corp: r.has('corp') ? (r.str('corp') as CorpId) : null,
    unlockQuest,
    color: r.str('color'),
    glyph: r.str('glyph'),
    cycleHours: r.num('cycleHours', { min: 0.01 }),
    yieldUnits: r.int('yieldUnits', { min: 1 }),
    basePrice: r.num('basePrice', { min: 1 }),
    volatility: r.num('volatility', { min: 0 }),
    description: r.str('description'),
  };
});

export const CRYPTO_COIN_MAP: ReadonlyMap<string, CryptoCoinDef> = new Map(CRYPTO_COIN_DEFS.map((d) => [d.id, d]));

/** 지갑 단위 수 = 코인 1개. */
export const CRYPTO_UNITS_PER_COIN = T.num('CRYPTO_UNITS_PER_COIN');
/** 거래소 수수료 (살 때 얹고 팔 때 뗀다). */
export const CRYPTO_TRADE_FEE = T.num('CRYPTO_TRADE_FEE');
/** 거래 한 번의 최대 단위 수. */
export const CRYPTO_TRADE_MAX_UNITS = T.num('CRYPTO_TRADE_MAX_UNITS');
/** 서버가 거래 금액을 맞춰 보는 시세 창 (초). */
export const CRYPTO_QUOTE_WINDOW_S = T.num('CRYPTO_QUOTE_WINDOW_S');
/** 서버 시세가 한 번 움직이는 간격 (초). */
export const CRYPTO_TICK_S = T.num('CRYPTO_TICK_S');
/** 연산 클러스터 한 대의 코어 칸 수. */
export const COMPUTE_CLUSTER_MAX_CORES = T.num('COMPUTE_CLUSTER_MAX_CORES');
/** 코어가 하나 늘 때마다 채굴 주기에 곱하는 값. */
export const COMPUTE_CORE_TIME_MUL = T.num('COMPUTE_CORE_TIME_MUL');

/** 이 코인을 코어 `cores` 개로 채굴할 때의 주기 (ms). 코어 0 = Infinity. */
export function coinCycleMs(def: CryptoCoinDef, cores: number): number {
  return miningCycleMs(def.cycleHours, cores, COMPUTE_CORE_TIME_MUL);
}

/** 지갑 단위 → `12.345`. */
export function formatCoinUnits(units: number): string {
  return formatCryptoUnits(units, CRYPTO_UNITS_PER_COIN);
}

/** 코인 표기 → 지갑 단위 (내림). 숫자가 아니면 0. */
export function coinToUnits(coins: number): number {
  return Number.isFinite(coins) ? Math.max(0, Math.floor(coins * CRYPTO_UNITS_PER_COIN + 1e-6)) : 0;
}

/** 이 시세로 `units` 를 사고팔 때의 크레딧 (클라이언트 계산 — 릴레이도 같은 식으로 검증한다). */
export function cryptoCreditsFor(side: CryptoTradeSide, pricePerCoin: number, units: number): number {
  return cryptoTradeCredits(side, pricePerCoin, units, CRYPTO_UNITS_PER_COIN, CRYPTO_TRADE_FEE);
}
