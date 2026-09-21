/* ────────────────────────────────────────────────────────────────────────────
 * Crypto coin defs + the mining · trading numbers (2026-09-13, `src/housing/README.md` Decisions, user's decision).
 *
 * The source is `data/crypto.csv` (8 coins) + `data/tuning.csv` (unit · fee · core multiplier · quote tick). This file
 * uses the csv loader, so **the relay does not import it** — the values the relay needs are moved into the `crypto`
 * section of `server/economy.gen.json` by `scripts/economy-table.mjs`, and both call the same formulas in
 * `shared/cryptoMarket.ts` (no runtime import).
 *
 * The rules in short (user's decision):
 *  - The first 4 (no `corp`) are open; the other 4 can be mined and traded only once that corporation's quest (`unlockQuest`) is completed. The chart is always visible.
 *  - Mining is one compute cluster = one cycle. With n cores the cycle is `cycleHours × COMPUTE_CORE_TIME_MUL^(n−1)`, and one cycle puts `yieldUnits` into the wallet.
 *  - The wallet is in whole units (`CRYPTO_UNITS_PER_COIN` units = 1 coin) and lives in the ship state (`ShipState.cryptoWallet`).
 *  - Trading only ever happens at the server quote — the relay validates the credit reasons `cbuy:<coin>:<units>` · `csell:<coin>:<units>` inside the quote window.
 * ──────────────────────────────────────────────────────────────────────────── */
import { csvRows, keyTable } from './data/tables';
import type { CorpId } from './meta';
/* 2026-09-14: corporation quests retired — the unlock quest is an NPC quest (`data/npc_quests.csv`) */
import { NPC_QUEST_DEFS } from './npc';
import { cryptoTradeCredits, formatCryptoUnits, miningCycleMs, type CryptoTradeSide } from './cryptoMarket';

const T = /* data/tuning.csv */ keyTable('tuning.csv');

export interface CryptoCoinDef {
  /** Lower case · digits · _ — saves, the server quote and credit reasons all use this id. */
  id: string;
  name: string;
  /** Exchange ticker (`SCRP`). */
  ticker: string;
  /** The associated corporation. null = a coin that is open from the start. */
  corp: CorpId | null;
  /** Id of the NPC quest that must be completed before mining / trading opens (`data/npc_quests.csv`). null = open. */
  unlockQuest: string | null;
  color: string;
  glyph: string;
  /** Mining cycle with 1 core (real-time hours). */
  cycleHours: number;
  /** Units that land in the wallet per cycle. */
  yieldUnits: number;
  /** Base price of one coin (credits). */
  basePrice: number;
  /** Daily standard deviation (as a ratio). Used by the server's quote simulation. */
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

/** Wallet units that make 1 coin. */
export const CRYPTO_UNITS_PER_COIN = T.num('CRYPTO_UNITS_PER_COIN');
/** Exchange fee (added when buying, taken off when selling). */
export const CRYPTO_TRADE_FEE = T.num('CRYPTO_TRADE_FEE');
/** Maximum units in one trade. */
export const CRYPTO_TRADE_MAX_UNITS = T.num('CRYPTO_TRADE_MAX_UNITS');
/** The quote window the server checks a trade's amount against (seconds). */
export const CRYPTO_QUOTE_WINDOW_S = T.num('CRYPTO_QUOTE_WINDOW_S');
/** Interval at which the server quote moves (seconds). */
export const CRYPTO_TICK_S = T.num('CRYPTO_TICK_S');
/** Core slots on one compute cluster. */
export const COMPUTE_CLUSTER_MAX_CORES = T.num('COMPUTE_CLUSTER_MAX_CORES');
/** Multiplier applied to the mining cycle for every extra core. */
export const COMPUTE_CORE_TIME_MUL = T.num('COMPUTE_CORE_TIME_MUL');

/** Cycle (ms) of mining this coin with `cores` cores. 0 cores = Infinity. */
export function coinCycleMs(def: CryptoCoinDef, cores: number): number {
  return miningCycleMs(def.cycleHours, cores, COMPUTE_CORE_TIME_MUL);
}

/** Wallet units → `12.345`. */
export function formatCoinUnits(units: number): string {
  return formatCryptoUnits(units, CRYPTO_UNITS_PER_COIN);
}

/** Coin notation → wallet units (floored). 0 when it is not a number. */
export function coinToUnits(coins: number): number {
  return Number.isFinite(coins) ? Math.max(0, Math.floor(coins * CRYPTO_UNITS_PER_COIN + 1e-6)) : 0;
}

/** Credits for buying / selling `units` at this price (the client's calculation — the relay validates with the same formula). */
export function cryptoCreditsFor(side: CryptoTradeSide, pricePerCoin: number, units: number): number {
  return cryptoTradeCredits(side, pricePerCoin, units, CRYPTO_UNITS_PER_COIN, CRYPTO_TRADE_FEE);
}
