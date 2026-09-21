/**
 * src/net/parts/Crypto.ts — **`ctx.net.crypto`: the crypto quote desk** (2026-09-13).
 *
 * Quotes originate at the relay (`server/CryptoMarket.ts` — the user's decision: the chart and trading need a server
 * connection). This file only holds what arrives and owns no rules:
 *
 *  - `watch()` is ref-counted. The first subscription sends `crypto:watch {on:true}`, the last release `{on:false}`.
 *    The server forgets the subscription per connection, so it is turned back on **on every welcome** (reconnect ·
 *    reload) while a subscriber is left. Turning it on makes the server send one quote immediately.
 *  - `available` = the socket is attached and a `crypto:prices` arrived **on this connection**. An old relay (no
 *    quotes) never sends one, so it stays false — the screen then reads 「서버에 연결되어야 합니다」. A drop makes it
 *    false at once and leaves the last quotes (`prices`) alone. With no subscription no new quote arrives — a screen
 *    that prices something must hold a `watch()` while it is open (`pricesAt` is how fresh it is).
 *  - `requestHistory(coin, range)` → `crypto:history` → the **last answer** is cached per (coin, range) and
 *    `net:cryptoHistory` fires. Without a connection it silently does nothing (the screen calls again once
 *    `net:cryptoPrices` shows that `available` went on).
 *  - The cached candles are **alive**: every arriving quote is folded into the cache's last candle (high · low ·
 *    close inside the same candle bucket; a new bucket appends one candle and trims to `CRYPTO_CANDLE_COUNT`). It is
 *    how the server builds its candles too, so the chart flows without asking again — a chart only has to redraw on
 *    `net:cryptoPrices` (`net:cryptoHistory` is emitted only as the answer to a request).
 *
 * Every received frame is checked field by field (coin id grammar · a finite positive price · a known range · the
 * candle-count cap).
 */
import type { CryptoCandle, CryptoChartRange, CryptoMarketRef, ServerToClient } from '@/shared';
import { CRYPTO_CANDLE_COUNT, CRYPTO_CANDLE_MS, CRYPTO_CHART_RANGES } from '@/shared';
import type { NetSystem } from '../NetSystem';

type PricesMsg = Extract<ServerToClient, { t: 'crypto:prices' }>;
type HistoryMsg = Extract<ServerToClient, { t: 'crypto:history' }>;

/** Same grammar as the credit reason id of `cbuy:` / `csell:` (`shared/crypto.ts`'s `COIN_ID`). */
const COIN_RE = /^[a-z0-9_]{1,32}$/;
const RANGE_SET: ReadonlySet<string> = new Set(CRYPTO_CHART_RANGES);
const MAX_COINS = 64;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const key = (coin: string, range: CryptoChartRange): string => `${coin}|${range}`;

export class CryptoMarketClient implements CryptoMarketRef {
  private sys: NetSystem | null = null;
  private refs = 0;
  /** A `crypto:prices` arrived on the current connection. */
  private live = false;
  private _prices: Record<string, number> = {};
  private _change: Record<string, number> = {};
  private _at = 0;
  private readonly histories = new Map<string, CryptoCandle[]>();

  init(sys: NetSystem): void { this.sys = sys; }

  dispose(): void {
    if (this.refs > 0) this.send({ t: 'crypto:watch', on: false });
    this.refs = 0;
    this.live = false;
    this.histories.clear();
    this.sys = null;
  }

  /* ── CryptoMarketRef ── */

  get available(): boolean { return this.live && this.sys !== null && this.sys.client.connected; }
  get prices(): Readonly<Record<string, number>> { return this._prices; }
  get change24h(): Readonly<Record<string, number>> { return this._change; }
  get pricesAt(): number { return this._at; }

  watch(): () => void {
    this.refs++;
    if (this.refs === 1) this.send({ t: 'crypto:watch', on: true });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs = Math.max(0, this.refs - 1);
      if (this.refs === 0) this.send({ t: 'crypto:watch', on: false });
    };
  }

  requestHistory(coin: string, range: CryptoChartRange): void {
    if (typeof coin !== 'string' || !COIN_RE.test(coin) || !RANGE_SET.has(range)) return;
    this.send({ t: 'crypto:history', coin, range });
  }

  getHistory(coin: string, range: CryptoChartRange): readonly CryptoCandle[] | null {
    return this.histories.get(key(coin, range)) ?? null;
  }

  /* ── NetSystem hooks ── */

  /** Every `welcome` (first connect, reconnect, reload): the server forgot the watch flag → turn it back on if anyone holds one. */
  onWelcome(): void {
    this.live = false;
    if (this.refs > 0) this.send({ t: 'crypto:watch', on: true });
  }

  onDisconnected(): void { this.live = false; }

  onPrices(msg: PricesMsg): void {
    if (!finite(msg.at) || !isRecord(msg.prices)) return;
    const prices: Record<string, number> = {};
    const change: Record<string, number> = {};
    let n = 0;
    for (const [id, p] of Object.entries(msg.prices)) {
      if (!COIN_RE.test(id) || !finite(p) || p <= 0) continue;
      prices[id] = p;
      const ch = isRecord(msg.change24h) ? msg.change24h[id] : undefined;
      change[id] = finite(ch) ? ch : 0;
      if (++n >= MAX_COINS) break;
    }
    this._prices = prices;
    this._change = change;
    this._at = msg.at;
    this.live = true;
    for (const [k, list] of this.histories) {
      const [coin, range] = k.split('|') as [string, CryptoChartRange];
      const p = prices[coin];
      if (p !== undefined) foldPrice(list, range, msg.at, p);
    }
    this.sys?.ctx.bus.emit('net:cryptoPrices', { at: msg.at });
  }

  onHistory(msg: HistoryMsg): void {
    if (typeof msg.coin !== 'string' || !COIN_RE.test(msg.coin) || !RANGE_SET.has(msg.range) || !Array.isArray(msg.candles)) return;
    const range = msg.range;
    const out: CryptoCandle[] = [];
    for (const c of msg.candles.slice(-CRYPTO_CANDLE_COUNT[range])) {
      if (!isRecord(c) || !finite(c.t) || !finite(c.o) || !finite(c.h) || !finite(c.l) || !finite(c.c)) continue;
      if (c.o <= 0 || c.c <= 0 || c.l <= 0 || c.h < c.l) continue;
      if (out.length > 0 && c.t <= out[out.length - 1].t) continue;
      out.push({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c });
    }
    this.histories.set(key(msg.coin, range), out);
    this.sys?.ctx.bus.emit('net:cryptoHistory', { coin: msg.coin, range });
  }

  private send(m: { t: 'crypto:watch'; on: boolean } | { t: 'crypto:history'; coin: string; range: CryptoChartRange }): void {
    this.sys?.client.send(m);
  }
}

/** Fold one price into a cached candle list exactly like the relay builds its candles (the open of a new bucket = the last close). */
function foldPrice(list: CryptoCandle[], range: CryptoChartRange, at: number, p: number): void {
  const ms = CRYPTO_CANDLE_MS[range];
  const t = Math.floor(at / ms) * ms;
  const last = list.length > 0 ? list[list.length - 1] : null;
  if (last && last.t === t) {
    if (p > last.h) last.h = p;
    if (p < last.l) last.l = p;
    last.c = p;
    return;
  }
  if (last && last.t > t) return;
  const o = last ? last.c : p;
  list.push({ t, o, h: Math.max(o, p), l: Math.min(o, p), c: p });
  const n = CRYPTO_CANDLE_COUNT[range];
  if (list.length > n) list.splice(0, list.length - n);
}
