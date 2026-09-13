/**
 * src/net/parts/Crypto.ts — **`ctx.net.crypto`: 암호화폐 시세 창구** (2026-09-13, docs/plans/power-crypto.md).
 *
 * 시세의 원본은 릴레이다 (`server/CryptoMarket.ts` — 사용자 결정: 서버에 붙어 있어야 차트 · 매매가 된다). 이 파일은 받은 것을
 * 들고 있을 뿐이고 규칙이 없다:
 *
 *  - `watch()` 는 참조 계수다. 첫 구독에서 `crypto:watch {on:true}`, 마지막 해제에서 `{on:false}`. 서버는 연결마다 구독을 잊으므로
 *    **welcome 마다**(재접속 · 새로고침) 구독자가 남아 있으면 다시 켠다. 켜는 순간 서버가 시세를 한 번 즉시 보낸다.
 *  - `available` = 소켓이 붙어 있고 **이 연결에서** `crypto:prices` 를 한 번이라도 받았다. 옛 릴레이(시세 없음)는 시세를 영영 안 보내므로
 *    false 로 남는다 — 화면은 「서버에 연결되어야 합니다」. 끊기면 곧바로 false 이고 마지막 시세(`prices`)는 그대로 둔다.
 *    구독이 없으면 시세가 새로 오지 않는다 — 견적을 내는 화면은 열려 있는 동안 `watch()` 를 들고 있어야 한다 (`pricesAt` 으로 신선도를 본다).
 *  - `requestHistory(coin, range)` → `crypto:history` → (coin, range)별로 **마지막 답**을 캐시하고 `net:cryptoHistory`. 연결이 없으면
 *    조용히 아무것도 하지 않는다 (화면이 `net:cryptoPrices` 로 `available` 이 켜진 것을 보고 다시 부른다).
 *  - 캐시된 봉은 **살아 있다**: 시세가 올 때마다 그 가격을 캐시의 마지막 봉에 접고(같은 봉 구간이면 고가 · 저가 · 종가, 새 구간이면 봉
 *    하나를 붙이고 `CRYPTO_CANDLE_COUNT` 로 자른다). 서버가 봉을 만드는 방식과 같아서 다시 요청하지 않아도 차트가 흐른다 —
 *    차트는 `net:cryptoPrices` 에 다시 그리면 된다 (`net:cryptoHistory` 는 요청의 답에만 나간다).
 *
 * 받은 프레임은 필드마다 검사한다 (코인 id 문법 · 유한한 양수 가격 · 알려진 기간 · 봉 개수 상한).
 */
import type { CryptoCandle, CryptoChartRange, CryptoMarketRef, ServerToClient } from '@/shared';
import { CRYPTO_CANDLE_COUNT, CRYPTO_CANDLE_MS, CRYPTO_CHART_RANGES } from '@/shared';
import type { NetSystem } from '../NetSystem';

type PricesMsg = Extract<ServerToClient, { t: 'crypto:prices' }>;
type HistoryMsg = Extract<ServerToClient, { t: 'crypto:history' }>;

/** Same grammar as the credit reason id of `cbuy:` / `csell:` (`shared/crypto.ts` 의 `COIN_ID`). */
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
