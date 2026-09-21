/**
 * Crypto price simulation · candle history · persistence (2026-09-13 — the contract is `src/shared/cryptoMarket.ts` ·
 * `EconomyTable.crypto` in `src/shared/credits.ts` · `crypto:*` in `src/shared/net.ts`).
 *
 * The relay is the **one source** of coin prices (user's decision — a chart and a trade need the server). The numbers
 * come from the `crypto` section of `economy.gen.json` (← data/crypto.csv · tuning.csv): the base price `basePrice` ·
 * the daily standard deviation `volatility` · the tick `tickMs` · the trade validation window `quoteWindowMs`.
 *
 * **The movement.** Every tick each coin's log price x mean-reverts toward ln(basePrice) (the exact discretisation of
 * an Ornstein–Uhlenbeck process):
 *   x' = μ + (x − μ)·e^(−θ·dt) + volatility·√dt·Z     (dt = tick length ÷ a day, θ = ln2 ÷ `CRYPTO_REVERSION_HALF_LIFE_DAYS`)
 * Rare jumps slip in (`CRYPTO_JUMPS_PER_DAY` expected, size σ = volatility × `CRYPTO_JUMP_SIGMA_MUL`), and x is cut
 * to [μ − ln `CRYPTO_PRICE_BAND`, μ + ln `CRYPTO_PRICE_BAND`] (= that factor below … above the base price). The
 * steady state's log standard deviation is
 * volatility ÷ √(2θ) ≈ 1.47 × volatility, so the band is almost never touched.
 *
 * **The random numbers hold no state.** One step's randomness is a hash of (seed, the coin id's hash, the tick
 * number = time ÷ tickMs, the stream) — so replaying the time it was down tick by tick (the gap fill) gives **the
 * same path** it would have had while running, and the same seed at the same time makes the selftest repeat exactly.
 * The seed lives in `crypto.json` (random on the first start, or from an option).
 *
 * **Candles.** 1-minute candles are kept for `CRYPTO_MINUTE_KEEP_MS`, 1-hour ones for `CRYPTO_HOUR_KEEP_MS` —
 * both sized from the longest range that reads them, so they move with it. The per-range answer (`history`) is
 * exactly `CRYPTO_CANDLE_MS` · `CRYPTO_CANDLE_COUNT` (`src/shared/cryptoMarket.ts` — the one table; the minute
 * candles are grouped up where a range's length is not a minute).
 * The last candle may still be running. A candle's open is the price before it (so the chart never breaks).
 *
 * **The first start · the time it was down.** With no history it starts from the base price `CRYPTO_BACKFILL_MS`
 * ago and fills deterministically up to now — the chart is never empty. A gap while it was down is filled by the
 * same function: the most recent `CRYPTO_FINE_FILL_MS` tick by tick (so the 1-hour · 1-day charts are dense),
 * anything older in `CRYPTO_COARSE_STEP_MS` steps (which yields the 1-hour candles' OHLC), and a gap longer than
 * `CRYPTO_BACKFILL_MS` is cut to it — the coin table (`data/crypto.csv`) × the worst gap is tens of ms.
 *
 * **The trade validation window.** It keeps the tick prices of the last `quoteWindowMs + 2 × tickMs`, and
 * `quoteRange(coin, now)` returns the lowest · highest quote inside [now − quoteWindowMs − tickMs, now] (the quote
 * that was live the moment the window opened = the tick before it included). `Economy.ts` judges the `cbuy` · `csell`
 * amounts with it — this file knows nothing about credits.
 *
 * **Persistence.** `<dataDir>/crypto.json` — the same dance as `Store.ts`: a debounced (`CRYPTO_SAVE_DEBOUNCE_MS`)
 * async write = tmp + fsync → the old file → `.bak` → tmp → the main file; `close()` is synchronous. On a parse
 * failure the original is moved to `crypto.corrupt-<time>.json` and recovered from `.bak`; with neither it is filled
 * again (a price history is data that can be remade). Coins missing from the table are dropped, new coins filled in.
 * `dataDir: null` = memory only.
 *
 * Erasable TypeScript only (Node's native type stripping) · no `import.meta` — a rule that came from the old
 * standalone exe's CJS bundle (the exe was dropped 2026-09-15), and keeping it costs nothing (`Economy.ts` says
 * the same).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EconomyTable } from '../src/shared/credits.ts';
import type { CryptoCandle, CryptoChartRange } from '../src/shared/cryptoMarket.ts';
import { CRYPTO_CANDLE_COUNT, CRYPTO_CANDLE_MS } from '../src/shared/cryptoMarket.ts';
import type { ServerToClient } from '../src/shared/net.ts';

export type CryptoTable = NonNullable<EconomyTable['crypto']>;
export type CryptoPricesMessage = Extract<ServerToClient, { t: 'crypto:prices' }>;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export const CRYPTO_FILE = 'crypto.json';
export const CRYPTO_BACKUP_SUFFIX = '.bak';
/** An unreadable `crypto.json` is moved aside under this name (never overwritten). */
export function corruptCryptoFileName(now: Date = new Date()): string {
  return `crypto.corrupt-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}
/** Write at most this often while ticks keep changing the market (a crash loses ≤ this much; the gap fill regenerates it). */
export const CRYPTO_SAVE_DEBOUNCE_MS = 60_000;

/*
 * The shape of the simulation (the lead's design). Per-coin balance (base price · volatility · tick) lives in
 * the csv; only the **shape of the model** is here: the half-life · the jump frequency · the jump size · the price
 * band. To lift these four into the csv, add fields to `EconomyTable.crypto` and have the generator carry them.
 */
/** Mean-reversion half-life of the log price (days). */
export const CRYPTO_REVERSION_HALF_LIFE_DAYS = 3;
/**
 * Expected jumps per coin per day. Rare on purpose: the jump variance per day is λ · (mul · volatility)², here 0.1 × 2.5² = 0.625 ×
 * volatility² — so the csv `volatility` still describes the market (a larger λ · mul² would drown it).
 */
export const CRYPTO_JUMPS_PER_DAY = 0.1;
/** Jump size σ (log price) = volatility × this. */
export const CRYPTO_JUMP_SIGMA_MUL = 2.5;
/** Hard price band: [basePrice / BAND, basePrice × BAND]. */
export const CRYPTO_PRICE_BAND = 5;

/** 1-minute candles kept (≥ 24 h + one 15-min bucket of slack for the '1d' range). */
export const CRYPTO_MINUTE_KEEP_MS = 25 * HOUR_MS;
/** 1-hour candles kept (≥ 31 days: the '1M' range is 180 × 4 h = 30 days). */
export const CRYPTO_HOUR_KEEP_MS = 32 * DAY_MS;
/** Synthetic history on a first boot, and the longest gap ever replayed. */
export const CRYPTO_BACKFILL_MS = 31 * DAY_MS;
/** The newest part of a backfill / gap replays tick by tick (so the 1h / 1d charts are dense). */
export const CRYPTO_FINE_FILL_MS = DAY_MS;
/** Step cap of the tick-by-tick part (= a day at the shipped 10 s tick). */
export const CRYPTO_FINE_FILL_MAX_STEPS = 8_640;
/** Older parts of a backfill / gap move in these steps (six per hour → real OHLC on the hour candles). */
export const CRYPTO_COARSE_STEP_MS = 10 * MINUTE_MS;

const THETA = Math.LN2 / CRYPTO_REVERSION_HALF_LIFE_DAYS;
const STREAM_TICK = 1;
const STREAM_COARSE = 17;
const U32 = 4_294_967_296;

export interface CryptoQuoteRange { min: number; max: number }

export interface CryptoMarketOptions {
  table: CryptoTable;
  /** Directory holding `crypto.json`; `null` = memory only (selftest). Required — the relay passes the profile store's directory. */
  dataDir: string | null;
  /** RNG seed of a **fresh** market (a loaded file keeps its own). Default: random. */
  seed?: number;
  /** Clock (epoch ms). Default `Date.now`. Selftest only. */
  now?: () => number;
  saveDebounceMs?: number;
  quiet?: boolean;
}

export type CryptoLoadNote = 'memory' | 'backfilled' | 'loaded' | 'bak-recovered' | 'corrupt-recovered' | 'corrupt-backfilled';

interface CoinState {
  id: string;
  hash: number;
  base: number;
  vol: number;
  mu: number;
  lo: number;
  hi: number;
  /** Log price at full precision (persisted, so a reload continues the exact path). */
  x: number;
  /** Rounded price (credits per coin) — what candles, quotes and the wire carry. */
  price: number;
  /** Time of the last simulated step (a tick or coarse-step boundary). */
  lastAt: number;
  minutes: CryptoCandle[];
  hours: CryptoCandle[];
  /** [at, price] of recent ticks (the quote window). */
  recent: [number, number][];
}

interface CoinFileEntry { x: number; p: number; at: number; m: number[][]; h: number[][]; r: number[][] }
interface CryptoFile { v: 1; seed: number; savedAt: number; coins: Record<string, CoinFileEntry> }

/* ── stateless RNG ─────────────────────────────────────────────────────── */

function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a of a coin id. */
function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Uniform in (0, 1) for (seed, coin, step index, stream). */
function rand01(seed: number, coin: number, idx: number, stream: number): number {
  let h = mix((seed >>> 0) ^ 0x9e3779b9);
  h = mix(h ^ coin);
  h = mix(h ^ (idx >>> 0));
  h = mix(h ^ (Math.floor(idx / U32) >>> 0));
  h = mix(h ^ stream);
  return (h + 0.5) / U32;
}

/** Standard normal (Box–Muller over streams `stream` and `stream + 1`). */
function gauss(seed: number, coin: number, idx: number, stream: number): number {
  const u1 = rand01(seed, coin, idx, stream);
  const u2 = rand01(seed, coin, idx, stream + 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/* ── candles ───────────────────────────────────────────────────────────── */

const round2 = (v: number): number => Math.round(v * 100) / 100;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fold price `p` at `at` into the candle list (`prev` = the price just before — the open of a new candle). */
function fold(list: CryptoCandle[], bucketMs: number, at: number, prev: number, p: number): void {
  const t = Math.floor(at / bucketMs) * bucketMs;
  const last = list.length > 0 ? list[list.length - 1] : null;
  if (last && last.t === t) {
    if (p > last.h) last.h = p;
    if (p < last.l) last.l = p;
    last.c = p;
    return;
  }
  if (last && last.t > t) return;
  list.push({ t, o: prev, h: Math.max(prev, p), l: Math.min(prev, p), c: p });
}

/** Index of the first candle with `t >= at` (binary search; `list.length` when none). */
function firstAtOrAfter(list: readonly CryptoCandle[], at: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].t < at) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function pruneBefore(list: CryptoCandle[], cutoff: number): void {
  const i = firstAtOrAfter(list, cutoff);
  if (i > 0) list.splice(0, i);
}

function candleFromTuple(v: unknown): CryptoCandle | null {
  if (!Array.isArray(v) || v.length !== 5 || !v.every(finite)) return null;
  const [t, o, h, l, c] = v as number[];
  if (t < 0 || o <= 0 || c <= 0 || l <= 0 || h < Math.max(o, c, l) || l > Math.min(o, c)) return null;
  return { t: Math.floor(t), o, h, l, c };
}

function candlesFromFile(raw: unknown, now: number): CryptoCandle[] {
  if (!Array.isArray(raw)) return [];
  const out: CryptoCandle[] = [];
  for (const v of raw) {
    const c = candleFromTuple(v);
    if (c && c.t <= now) out.push(c);
  }
  out.sort((a, b) => a.t - b.t);
  const dedup: CryptoCandle[] = [];
  for (const c of out) {
    if (dedup.length > 0 && dedup[dedup.length - 1].t === c.t) dedup[dedup.length - 1] = c;
    else dedup.push(c);
  }
  return dedup;
}

const tuple = (c: CryptoCandle): number[] => [c.t, c.o, c.h, c.l, c.c];

/* ── market ────────────────────────────────────────────────────────────── */

export class CryptoMarket {
  readonly table: CryptoTable;
  readonly tickMs: number;
  /** Called after every tick that moved the market (the relay broadcasts it to watchers). */
  onTick: ((msg: CryptoPricesMessage) => void) | null = null;

  private seed: number;
  private readonly coins = new Map<string, CoinState>();
  private readonly nowFn: () => number;
  private readonly recentKeepMs: number;
  private readonly debounceMs: number;
  private readonly quiet: boolean;
  private file: string | null;
  private message: CryptoPricesMessage = { t: 'crypto:prices', at: 0, prices: {}, change24h: {} };
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private writing: Promise<void> | null = null;
  private gen = 0;
  private writes = 0;
  private closed = false;
  private note: CryptoLoadNote = 'memory';
  private corruptPath: string | null = null;

  constructor(opts: CryptoMarketOptions) {
    this.table = opts.table;
    this.tickMs = Math.max(100, Math.floor(finite(opts.table.tickMs) ? opts.table.tickMs : 10_000));
    this.recentKeepMs = Math.max(0, finite(opts.table.quoteWindowMs) ? opts.table.quoteWindowMs : 0) + 2 * this.tickMs;
    this.nowFn = opts.now ?? Date.now;
    this.debounceMs = opts.saveDebounceMs ?? CRYPTO_SAVE_DEBOUNCE_MS;
    this.quiet = opts.quiet ?? false;
    this.seed = finite(opts.seed) ? Math.floor(opts.seed) >>> 0 : Math.floor(Math.random() * U32) >>> 0;
    this.file = opts.dataDir === null ? null : join(opts.dataDir, CRYPTO_FILE);
    const now = this.nowFn();
    const loaded = this.file !== null ? this.load(now) : null;
    let added = 0;
    for (const [id, def] of Object.entries(this.table.coins)) {
      if (!finite(def.basePrice) || def.basePrice <= 0 || !finite(def.volatility) || def.volatility < 0) continue;
      const restored = loaded?.coins[id];
      const st = this.newCoin(id, def.basePrice, def.volatility, now);
      if (restored && this.restoreCoin(st, restored, now)) { this.coins.set(id, st); continue; }
      this.coins.set(id, st);
      added++;
    }
    for (const st of this.coins.values()) this.advanceCoin(st, now);
    this.refreshMessage();
    if (this.file !== null && (this.note !== 'loaded' || added > 0)) this.markDirty();
    this.log(`${this.coins.size} coins · ${this.note}${added > 0 && this.note === 'loaded' ? ` (+${added} new, backfilled)` : ''} · seed ${this.seed} · ${this.file ?? '(memory)'}`);
  }

  /* ── queries ── */

  get coinIds(): string[] { return [...this.coins.keys()]; }
  /** Server epoch ms of the newest step (the `at` of `crypto:prices` / `crypto:history`). */
  get pricesAt(): number { return this.message.at; }
  get path(): string | null { return this.file; }
  get writeCount(): number { return this.writes; }
  get loadResult(): { note: CryptoLoadNote; corruptPath: string | null; seed: number } {
    return { note: this.note, corruptPath: this.corruptPath, seed: this.seed };
  }
  /** Resolves when no asynchronous write is in flight (selftest). */
  async idle(): Promise<void> { while (this.writing) await this.writing; }

  price(coin: string): number | null { return this.coins.get(coin)?.price ?? null; }

  /** The current `crypto:prices` frame (rebuilt after each step — send it as is). */
  pricesMessage(): CryptoPricesMessage { return this.message; }

  /**
   * Lowest and highest price of `coin` a client could legitimately have quoted at `now`: every tick inside
   * [now − quoteWindowMs − tickMs, …] plus the current price. null = unknown coin.
   */
  quoteRange(coin: string, now: number = this.nowFn()): CryptoQuoteRange | null {
    const st = this.coins.get(coin);
    if (!st) return null;
    const from = now - this.table.quoteWindowMs - this.tickMs;
    let min = st.price, max = st.price;
    for (const [at, p] of st.recent) {
      if (at < from) continue;
      if (p < min) min = p;
      if (p > max) max = p;
    }
    return { min, max };
  }

  /** Candles of one range, oldest first, at most `CRYPTO_CANDLE_COUNT[range]`. null = unknown coin or range. */
  history(coin: string, range: CryptoChartRange | string): CryptoCandle[] | null {
    if (typeof range !== 'string' || !Object.prototype.hasOwnProperty.call(CRYPTO_CANDLE_MS, range)) return null;
    const st = this.coins.get(coin);
    if (!st) return null;
    const r = range as CryptoChartRange;
    const ms = CRYPTO_CANDLE_MS[r], n = CRYPTO_CANDLE_COUNT[r];
    const src = ms % HOUR_MS === 0 ? st.hours : st.minutes;
    const start = Math.floor(st.lastAt / ms) * ms - (n - 1) * ms;
    const out: CryptoCandle[] = [];
    for (let i = firstAtOrAfter(src, start); i < src.length; i++) {
      const c = src[i];
      const t = Math.floor(c.t / ms) * ms;
      const last = out.length > 0 ? out[out.length - 1] : null;
      if (last && last.t === t) {
        if (c.h > last.h) last.h = c.h;
        if (c.l < last.l) last.l = c.l;
        last.c = c.c;
      } else out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c });
    }
    const tail = out.length > n ? out.slice(out.length - n) : out;
    return tail.map((c) => ({ t: c.t, o: round2(c.o), h: round2(c.h), l: round2(c.l), c: round2(c.c) }));
  }

  /* ── time ── */

  /** Advance every coin to `now` (tick boundaries). true = something moved (message rebuilt, save scheduled). */
  advance(now: number = this.nowFn()): boolean {
    let moved = false;
    for (const st of this.coins.values()) if (this.advanceCoin(st, now)) moved = true;
    if (moved) {
      this.refreshMessage();
      this.markDirty();
    }
    return moved;
  }

  /** One timer tick: advance, and hand the new prices to `onTick`. */
  tick(now: number = this.nowFn()): boolean {
    const moved = this.advance(now);
    if (moved) {
      try { this.onTick?.(this.message); } catch (e) { this.warn(`onTick failed: ${(e as Error).message}`); }
    }
    return moved;
  }

  /** Start the tick timer (aligned to tick boundaries, unref'd). */
  start(): void {
    if (this.tickTimer !== null || this.closed) return;
    this.schedule();
  }

  private schedule(): void {
    if (this.closed) return;
    const now = this.nowFn();
    const wait = Math.max(1, (Math.floor(now / this.tickMs) + 1) * this.tickMs - now + 2);
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this.tick();
      this.schedule();
    }, wait);
    this.tickTimer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.tickTimer !== null) { clearTimeout(this.tickTimer); this.tickTimer = null; }
    this.flush();
  }

  /* ── simulation ── */

  private newCoin(id: string, base: number, vol: number, now: number): CoinState {
    const mu = Math.log(base);
    const band = Math.log(CRYPTO_PRICE_BAND);
    return {
      id, hash: idHash(id), base, vol, mu, lo: mu - band, hi: mu + band,
      x: mu, price: round2(base),
      // a fresh coin starts at its base price one backfill ago (aligned, so the synthetic path is a function of seed + now)
      lastAt: Math.floor((now - CRYPTO_BACKFILL_MS) / CRYPTO_COARSE_STEP_MS) * CRYPTO_COARSE_STEP_MS,
      minutes: [], hours: [], recent: [],
    };
  }

  private advanceCoin(st: CoinState, target: number): boolean {
    const tick = this.tickMs;
    const end = Math.floor(target / tick) * tick;
    if (end <= st.lastAt) return false;
    if (end - st.lastAt > CRYPTO_BACKFILL_MS) {
      st.lastAt = Math.floor((end - CRYPTO_BACKFILL_MS) / CRYPTO_COARSE_STEP_MS) * CRYPTO_COARSE_STEP_MS;
    }
    // at most CRYPTO_FINE_FILL_MS, and never more steps than that span has at the csv tick (a short test tick must not multiply the work)
    const fineFrom = end - Math.min(CRYPTO_FINE_FILL_MS, CRYPTO_FINE_FILL_MAX_STEPS * tick);
    const recentFrom = end - this.recentKeepMs;
    for (let at = (Math.floor(st.lastAt / CRYPTO_COARSE_STEP_MS) + 1) * CRYPTO_COARSE_STEP_MS; at <= fineFrom; at += CRYPTO_COARSE_STEP_MS) {
      this.step(st, at, Math.floor(at / CRYPTO_COARSE_STEP_MS), STREAM_COARSE, false);
    }
    for (let at = (Math.floor(st.lastAt / tick) + 1) * tick; at <= end; at += tick) {
      this.step(st, at, Math.floor(at / tick), STREAM_TICK, at >= recentFrom);
    }
    pruneBefore(st.minutes, end - CRYPTO_MINUTE_KEEP_MS);
    pruneBefore(st.hours, end - CRYPTO_HOUR_KEEP_MS);
    let drop = 0;
    while (drop < st.recent.length && st.recent[drop][0] < recentFrom) drop++;
    if (drop > 0) st.recent.splice(0, drop);
    return true;
  }

  private step(st: CoinState, at: number, idx: number, stream: number, keepRecent: boolean): void {
    const dtDays = Math.max(0, at - st.lastAt) / DAY_MS;
    const prev = st.price;
    if (dtDays > 0) {
      let x = st.mu + (st.x - st.mu) * Math.exp(-THETA * dtDays) + st.vol * Math.sqrt(dtDays) * gauss(this.seed, st.hash, idx, stream);
      if (rand01(this.seed, st.hash, idx, stream + 2) < CRYPTO_JUMPS_PER_DAY * dtDays) {
        x += st.vol * CRYPTO_JUMP_SIGMA_MUL * gauss(this.seed, st.hash, idx, stream + 3);
      }
      st.x = Math.min(st.hi, Math.max(st.lo, x));
      st.price = Math.min(round2(st.base * CRYPTO_PRICE_BAND), Math.max(round2(st.base / CRYPTO_PRICE_BAND), round2(Math.exp(st.x))));
    }
    st.lastAt = at;
    fold(st.minutes, MINUTE_MS, at, prev, st.price);
    fold(st.hours, HOUR_MS, at, prev, st.price);
    if (keepRecent) st.recent.push([at, st.price]);
  }

  /** Close of the newest candle that started at or before `at` (minutes first, then hours). */
  private priceAtOrBefore(st: CoinState, at: number): number | null {
    const mi = firstAtOrAfter(st.minutes, at + 1) - 1;
    if (mi >= 0 && at - st.minutes[mi].t < HOUR_MS) return st.minutes[mi].c;
    const hi = firstAtOrAfter(st.hours, at + 1) - 1;
    return hi >= 0 ? st.hours[hi].c : null;
  }

  private refreshMessage(): void {
    const prices: Record<string, number> = {};
    const change24h: Record<string, number> = {};
    let at = 0;
    for (const st of this.coins.values()) {
      prices[st.id] = st.price;
      const before = this.priceAtOrBefore(st, st.lastAt - DAY_MS);
      change24h[st.id] = before && before > 0 ? Math.round((st.price / before - 1) * 10_000) / 10_000 : 0;
      if (st.lastAt > at) at = st.lastAt;
    }
    this.message = { t: 'crypto:prices', at, prices, change24h };
  }

  /* ── persistence ── */

  private log(line: string): void { if (!this.quiet) console.log(`[crypto ${new Date().toISOString()}] ${line}`); }
  private warn(line: string): void { console.warn(`[crypto ${new Date().toISOString()}] ${line}`); }

  private static readFile(path: string): CryptoFile | null {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
    if (!isRecord(parsed) || parsed.v !== 1 || !finite(parsed.seed) || !isRecord(parsed.coins)) return null;
    return parsed as unknown as CryptoFile;
  }

  /** Read `crypto.json` (or its `.bak`). Sets `note` / `seed`. null = start from a backfill. */
  private load(now: number): CryptoFile | null {
    const file = this.file!;
    const bak = `${file}${CRYPTO_BACKUP_SUFFIX}`;
    let data: CryptoFile | null = null;
    if (!existsSync(file)) {
      // a crash between the two renames of a flush leaves only the `.bak` — that IS the latest complete file
      data = existsSync(bak) ? CryptoMarket.readFile(bak) : null;
      this.note = data ? 'bak-recovered' : 'backfilled';
    } else {
      data = CryptoMarket.readFile(file);
      if (data) this.note = 'loaded';
      else {
        const corrupt = join(dirname(file), corruptCryptoFileName(new Date(now)));
        try { renameSync(file, corrupt); this.corruptPath = corrupt; } catch (e) {
          this.warn(`${file} is unreadable and could not be moved aside (${(e as Error).message}) — keeping the market in memory`);
          this.file = null;
          this.note = 'memory';
          return null;
        }
        data = existsSync(bak) ? CryptoMarket.readFile(bak) : null;
        this.note = data ? 'corrupt-recovered' : 'corrupt-backfilled';
        this.warn(`${file} was unreadable → kept as ${corrupt}; ${data ? `recovered from ${bak}` : 'history regenerated'}`);
      }
    }
    if (data) this.seed = Math.floor(data.seed) >>> 0;
    return data;
  }

  /** Restore one coin from its file entry (validated). false = unusable → the caller backfills it. */
  private restoreCoin(st: CoinState, raw: unknown, now: number): boolean {
    if (!isRecord(raw) || !finite(raw.at) || raw.at < 0) return false;
    const p = raw.p, x = raw.x;
    if (!finite(p) || p <= 0) return false;
    st.x = finite(x) ? Math.min(st.hi, Math.max(st.lo, x)) : Math.min(st.hi, Math.max(st.lo, Math.log(p)));
    st.price = Math.min(round2(st.base * CRYPTO_PRICE_BAND), Math.max(round2(st.base / CRYPTO_PRICE_BAND), round2(p)));
    st.minutes = candlesFromFile(raw.m, now);
    st.hours = candlesFromFile(raw.h, now);
    st.recent = [];
    if (Array.isArray(raw.r)) {
      for (const v of raw.r) {
        if (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) && v[1] > 0 && v[0] <= now) st.recent.push([v[0], v[1]]);
      }
      st.recent.sort((a, b) => a[0] - b[0]);
    }
    st.lastAt = Math.floor(raw.at);
    // the clock went back past the file (or the file came from the future): keep the price, forget the "future"
    if (st.lastAt > now) st.lastAt = Math.floor(now / this.tickMs) * this.tickMs;
    return true;
  }

  private serialize(): string {
    const coins: Record<string, CoinFileEntry> = {};
    for (const st of this.coins.values()) {
      coins[st.id] = { x: st.x, p: st.price, at: st.lastAt, m: st.minutes.map(tuple), h: st.hours.map(tuple), r: st.recent.map((r) => [r[0], r[1]]) };
    }
    const out: CryptoFile = { v: 1, seed: this.seed, savedAt: this.nowFn(), coins };
    return JSON.stringify(out);
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.file === null || this.closed || this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flushAsync(); }, this.debounceMs);
    this.saveTimer.unref?.();
  }

  /** Same file dance as `Store.flushAsync`: tmp + fsync → file → .bak → tmp → file; a newer sync flush (`gen`) wins. */
  private flushAsync(): void {
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const file = this.file;
    if (file === null) { this.dirty = false; return; }
    if (this.writing || !this.dirty || this.closed) return;
    this.dirty = false;
    const gen = this.gen;
    const text = this.serialize();
    const tmp = `${file}.tmp`;
    const bak = `${file}${CRYPTO_BACKUP_SUFFIX}`;
    const run = async (): Promise<void> => {
      await mkdir(dirname(file), { recursive: true });
      const fh = await open(tmp, 'w');
      try {
        await fh.writeFile(text, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (gen !== this.gen) { await rm(tmp, { force: true }); return; }
      if (existsSync(file)) await rename(file, bak);
      if (gen !== this.gen) { await rm(tmp, { force: true }); return; }
      await rename(tmp, file);
      this.writes++;
    };
    this.writing = run()
      .catch((e: unknown) => {
        if (gen === this.gen) this.dirty = true;
        this.warn(`failed to write ${file}: ${(e as Error).message}`);
      })
      .finally(() => {
        this.writing = null;
        if (this.dirty && !this.closed) this.markDirty();
      });
  }

  /** Write now, synchronously, when dirty or while an async write is in flight (shutdown / selftest). */
  flush(): void {
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const file = this.file;
    if (file === null) { this.dirty = false; return; }
    if (!this.dirty && !this.writing) return;
    this.gen++;
    this.dirty = false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-sync`;
      writeFileSync(tmp, this.serialize(), { encoding: 'utf8', flush: true });
      if (existsSync(file)) renameSync(file, `${file}${CRYPTO_BACKUP_SUFFIX}`);
      renameSync(tmp, file);
      this.writes++;
    } catch (e) {
      this.dirty = true;
      this.warn(`failed to write ${file}: ${(e as Error).message}`);
    }
  }
}
