/**
 * Server-side credit validation (2026-09-11, E-4 ⑦ — `src/shared/credits.ts` is the contract, commits `9bd72ce`
 * (the contract) · `b3fc2f0` (the implementation)).
 *
 * The old relay took `credits:tx {delta, reason}` **as it came** (refusing only a balance falling below 0). Now
 * `reason` is read with `parseCreditReason` and the amount checked against the **economy table**
 * (`economy.gen.json` — `npm run data:check -- --write` builds it from the csv with the client's own code). The
 * rules are exactly the table in `credits.ts`'s header comment:
 *
 *   buy:<id>               delta < 0 and |delta| ≥ the best-trust discount price (`tableMinBuyPrice`)
 *   sell:<id>:<qty>        1 ≤ qty ≤ stack, 0 < delta ≤ `tableSellPrice(value, qty)`
 *   refund:<id>            0 < delta ≤ the unrefunded `buy:<id>` balance inside the ledger's window
 *                          (`CREDIT_REFUND_WINDOW_MS`)
 *   repair:<broken>        delta === −the repair fee
 *   refund:repair:<broken> an unrefunded `repair:<broken>` pair inside the window
 *   contract:<id>          delta === the reward, `CREDIT_CONTRACT_MAX_PER_HOUR` times an hour
 *   quest:<id>             delta === the reward, once per quest id (the ledger)
 *   rover:<from>:<to>      (2026-09-13 rover fare) delta < 0 integer, |delta| ∈ [roverFareMin, roverFareMax]
 *                          (the route length differs per seed, so only the range is read), from ≠ to,
 *                          `CREDIT_ROVER_MAX_PER_HOUR` times an hour (ledger `roverAt`), no refund pair
 *   cbuy:<coin>:<units>    (2026-09-13 crypto buy) delta < 0 integer, |delta| ≥ cryptoTradeCredits('buy', the
 *                          quote window's lowest, units), the coin is in the table and, if it has an unlock quest,
 *                          that quest is in the ledger's `quests`, 1 ≤ units ≤ maxUnits,
 *                          `CREDIT_CRYPTO_MAX_PER_HOUR` times an hour (ledger `cryptoAt`), no refund pair. The
 *                          quote window is the injected `CryptoQuoteSource` (the relay's `CryptoMarket`) — with
 *                          none every trade is refused
 *   csell:<coin>:<units>   (a sell) 0 < delta ≤ cryptoTradeCredits('sell', the window's highest, units); the rest
 *                          is the same as cbuy
 *   intel:<planet>:<code>  (2026-09-14 the intel broker) delta < 0 integer, the planet is in the table's
 *                          `planetThreat`, `parseIntelCode` resolves, every row is in the table with its tier
 *                          within `maxTier`, and |delta| === intelCost(threat, picks, table.intel).
 *                          `CREDIT_INTEL_MAX_PER_HOUR` times an hour (ledger `intelAt`), no refund pair. Whether
 *                          the launch really used that intel is not checked — the map is built by the client (the
 *                          same limit as item ownership)
 *   migrate                once while the balance is null, clamped to [0, CREDITS_MAX]
 *   console · smoke:* · e2e:* · shot   only on a `devEconomy` relay (`SCAV_DEV_ECONOMY=1` — only the relay the
 *                          smoke runner starts; dev:all leaves it off too)
 *   anything else          refused (`CREDIT_TX_INVALID_KO`)
 *
 * This file is **pure** — it takes the balance · ledger and judges (`check`), and writes the ledger once the balance
 * really moved (`commit`). Persistence · atomicity belong to `Store.applyCreditsTx`, the wire to `RelayServer`'s
 * `credits:tx`. Handlers are synchronous, so no other transaction slips between check → apply → commit.
 *
 * The table is read with a **JSON import** (Node's JSON module under `node --experimental-strip-types
 * server/index.ts`). `import.meta` is not used — a rule that came from the old standalone exe's CJS bundle (the exe
 * was dropped 2026-09-15), and keeping it costs nothing.
 */
import type { CreditLedger, CreditReason, EconomyTable } from '../src/shared/credits.ts';
import {
  CREDIT_CONTRACT_MAX_PER_HOUR, CREDIT_DEV_ENV, CREDIT_REFUND_WINDOW_MS, CREDIT_ROVER_MAX_PER_HOUR, economyTableDigest, formatCreditReason,
  parseCreditReason, tableMinBuyPrice, tableSellPrice,
} from '../src/shared/credits.ts';
/* 2026-09-13: crypto trades `cbuy:` · `csell:` (the server's quote window) */
import { CREDIT_CRYPTO_MAX_PER_HOUR } from '../src/shared/credits.ts';
import { cryptoTradeCredits } from '../src/shared/cryptoMarket.ts';
/* 2026-09-14: the intel broker `intel:<planet>:<code>` — the price formula is the **same function** the client
   runs (only the table comes from another source) */
import { CREDIT_INTEL_MAX_PER_HOUR } from '../src/shared/credits.ts';
import { intelCost, parseIntelCode } from '../src/shared/intel.ts';
import generated from './economy.gen.json' with { type: 'json' };

/** Rolling window of the `contract:` hourly cap. */
export const CREDIT_CONTRACT_WINDOW_MS = 60 * 60_000;
/** Ledger caps (a hostile / corrupt `profiles.json` cannot grow a record without bound). */
export const CREDIT_LEDGER_DEBITS_MAX = 256;
export const CREDIT_LEDGER_QUESTS_MAX = 1024;
const LEDGER_REASON_MAX = 64;
const LEDGER_ID_RE = /^[a-z0-9_]+$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Shape check of a table read from JSON. Throws — a relay with a broken table must not start and accept everything. */
export function loadEconomyTable(raw: unknown): EconomyTable {
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.hash !== 'string') throw new Error('economy table: bad header');
  for (const k of ['creditsInitial', 'creditsMax', 'shopPriceBaseMul', 'shopPriceDiscountPerRep', 'shopPriceMinMul', 'sellPriceMul'] as const) {
    if (!finite(raw[k])) throw new Error(`economy table: ${k} is not a number`);
  }
  for (const k of ['items', 'repairFees', 'contracts', 'quests'] as const) {
    if (!isRecord(raw[k])) throw new Error(`economy table: ${k} is not an object`);
  }
  const items = raw.items as Record<string, unknown>;
  for (const [id, it] of Object.entries(items)) {
    if (!isRecord(it) || !finite(it.value) || !finite(it.stack) || it.stack < 1) throw new Error(`economy table: item ${id} is malformed`);
  }
  for (const k of ['repairFees', 'contracts', 'quests'] as const) {
    for (const [id, n] of Object.entries(raw[k] as Record<string, unknown>)) if (!finite(n)) throw new Error(`economy table: ${k}.${id} is not a number`);
  }
  // 2026-09-13: optional (an older table has none — every rover fare is then refused), but never junk
  for (const k of ['roverFareMin', 'roverFareMax'] as const) {
    if (raw[k] !== undefined && !finite(raw[k])) throw new Error(`economy table: ${k} is not a number`);
  }
  // 2026-09-14: optional `intel` (an older table has none — every intel purchase is refused), but never junk
  if (raw.intel !== undefined) {
    const ix = raw.intel;
    if (!isRecord(ix) || !isRecord(ix.options) || !isRecord(ix.planetThreat)) throw new Error('economy table: intel is malformed');
    if (!Array.isArray(ix.tierMul) || !Array.isArray(ix.threatMul) || !finite(ix.bundleMul)) throw new Error('economy table: intel multipliers are malformed');
    for (const n of [...ix.tierMul, ...ix.threatMul]) if (!finite(n)) throw new Error('economy table: intel multiplier is not a number');
    for (const [id, o] of Object.entries(ix.options)) {
      if (!isRecord(o) || !finite(o.baseCost) || !finite(o.maxTier) || o.maxTier < 1) throw new Error(`economy table: intel option ${id} is malformed`);
    }
    for (const [id, n] of Object.entries(ix.planetThreat)) if (!finite(n)) throw new Error(`economy table: intel planetThreat.${id} is not a number`);
  }
  // 2026-09-13: optional `crypto` (an older table has none — every cbuy / csell is refused and no market runs), but never junk
  if (raw.crypto !== undefined) {
    const cx = raw.crypto;
    if (!isRecord(cx) || !isRecord(cx.coins)) throw new Error('economy table: crypto is malformed');
    for (const k of ['unitsPerCoin', 'fee', 'maxUnits', 'quoteWindowMs', 'tickMs'] as const) {
      if (!finite(cx[k])) throw new Error(`economy table: crypto.${k} is not a number`);
    }
    for (const [id, c] of Object.entries(cx.coins)) {
      if (!isRecord(c) || !finite(c.basePrice) || !finite(c.volatility) || (c.unlockQuest !== undefined && typeof c.unlockQuest !== 'string')) {
        throw new Error(`economy table: crypto coin ${id} is malformed`);
      }
    }
  }
  return raw as unknown as EconomyTable;
}

/** The committed table (`economy.gen.json`), shape-checked once at module load. */
export const ECONOMY_TABLE: EconomyTable = loadEconomyTable(generated);

/** Did the table body change without regenerating the digest (hand edit)? The relay logs it; data:check fails on it. */
export function economyTableIntact(t: EconomyTable): boolean {
  return t.hash === economyTableDigest(t);
}

/** `SCAV_DEV_ECONOMY=1|true|yes|on` or the `--dev-economy` flag. Read by `server/index.ts` only (the one relay entry point). */
export function devEconomyFromEnv(env: Record<string, string | undefined> = process.env, argv: readonly string[] = process.argv): boolean {
  if (argv.includes('--dev-economy')) return true;
  const v = (env[CREDIT_DEV_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function emptyLedger(): CreditLedger {
  return { quests: [], contractsAt: [], debits: [] };
}

/**
 * Clean a stored ledger: drop malformed entries, clamp stamps to `now`, prune what no rule can use any more (debits
 * outside the refund window, contract stamps older than an hour) and cap the arrays. null = nothing worth keeping.
 */
export function sanitizeLedger(raw: unknown, now: number = Date.now()): CreditLedger | null {
  if (!isRecord(raw)) return null;
  const out = emptyLedger();
  if (Array.isArray(raw.quests)) {
    const seen = new Set<string>();
    for (const q of raw.quests) {
      if (typeof q !== 'string' || q.length === 0 || q.length > LEDGER_REASON_MAX || !LEDGER_ID_RE.test(q) || seen.has(q)) continue;
      seen.add(q);
      out.quests.push(q);
      if (out.quests.length >= CREDIT_LEDGER_QUESTS_MAX) break;
    }
  }
  if (Array.isArray(raw.contractsAt)) {
    for (const at of raw.contractsAt) if (finite(at)) out.contractsAt.push(Math.min(Math.max(0, Math.floor(at)), now));
  }
  if (Array.isArray(raw.roverAt)) {
    const roverAt: number[] = [];
    for (const at of raw.roverAt) if (finite(at)) roverAt.push(Math.min(Math.max(0, Math.floor(at)), now));
    if (roverAt.length) out.roverAt = roverAt;
  }
  if (Array.isArray(raw.cryptoAt)) {
    const cryptoAt: number[] = [];
    for (const at of raw.cryptoAt) if (finite(at)) cryptoAt.push(Math.min(Math.max(0, Math.floor(at)), now));
    if (cryptoAt.length) out.cryptoAt = cryptoAt;
  }
  if (Array.isArray(raw.intelAt)) {
    const intelAt: number[] = [];
    for (const at of raw.intelAt) if (finite(at)) intelAt.push(Math.min(Math.max(0, Math.floor(at)), now));
    if (intelAt.length) out.intelAt = intelAt;
  }
  if (Array.isArray(raw.debits)) {
    for (const d of raw.debits) {
      if (!isRecord(d) || typeof d.reason !== 'string' || d.reason.length > LEDGER_REASON_MAX || !finite(d.amount) || !finite(d.at)) continue;
      const amount = Math.max(0, Math.floor(d.amount));
      if (amount <= 0) continue;
      const refunded = finite(d.refunded) ? Math.min(amount, Math.max(0, Math.floor(d.refunded))) : 0;
      out.debits.push({ reason: d.reason, amount, at: Math.min(Math.max(0, Math.floor(d.at)), now), refunded });
    }
  }
  pruneLedger(out, now);
  return out.quests.length || out.contractsAt.length || out.debits.length || out.roverAt?.length || out.cryptoAt?.length || out.intelAt?.length ? out : null;
}

/** Drop entries no rule reads any more and enforce the caps (oldest first). Mutates. */
export function pruneLedger(l: CreditLedger, now: number): void {
  l.contractsAt = l.contractsAt.filter((at) => now - at < CREDIT_CONTRACT_WINDOW_MS);
  if (l.roverAt) {
    l.roverAt = l.roverAt.filter((at) => now - at < CREDIT_CONTRACT_WINDOW_MS);
    if (l.roverAt.length > CREDIT_ROVER_MAX_PER_HOUR) l.roverAt.splice(0, l.roverAt.length - CREDIT_ROVER_MAX_PER_HOUR);
    if (l.roverAt.length === 0) delete l.roverAt;
  }
  if (l.cryptoAt) {
    l.cryptoAt = l.cryptoAt.filter((at) => now - at < CREDIT_CONTRACT_WINDOW_MS);
    if (l.cryptoAt.length > CREDIT_CRYPTO_MAX_PER_HOUR) l.cryptoAt.splice(0, l.cryptoAt.length - CREDIT_CRYPTO_MAX_PER_HOUR);
    if (l.cryptoAt.length === 0) delete l.cryptoAt;
  }
  if (l.intelAt) {
    l.intelAt = l.intelAt.filter((at) => now - at < CREDIT_CONTRACT_WINDOW_MS);
    if (l.intelAt.length > CREDIT_INTEL_MAX_PER_HOUR) l.intelAt.splice(0, l.intelAt.length - CREDIT_INTEL_MAX_PER_HOUR);
    if (l.intelAt.length === 0) delete l.intelAt;
  }
  l.debits = l.debits.filter((d) => now - d.at <= CREDIT_REFUND_WINDOW_MS && d.refunded < d.amount);
  if (l.debits.length > CREDIT_LEDGER_DEBITS_MAX) l.debits.splice(0, l.debits.length - CREDIT_LEDGER_DEBITS_MAX);
  if (l.quests.length > CREDIT_LEDGER_QUESTS_MAX) l.quests.splice(0, l.quests.length - CREDIT_LEDGER_QUESTS_MAX);
}

export type CreditCheck =
  | {
    ok: true;
    parsed: CreditReason;
    /** The integer delta to apply (migrate: already clamped). */
    delta: number;
    /** migrate: seed a null balance instead of adding. */
    seed: boolean;
  }
  | {
    ok: false;
    /** Log detail (English, never sent — the client gets `CREDIT_TX_INVALID_KO`). */
    why: string;
  };

export interface CreditEconomyOptions {
  /** Accept `console` · `smoke:*` · `e2e:*` · `shot` (only the relay a smoke runner starts itself — `npm run dev:all` keeps it off). */
  dev?: boolean;
  /** 2026-09-13: where `cbuy:` / `csell:` read the relay's recent price window (the relay passes its `CryptoMarket`). */
  cryptoQuotes?: CryptoQuoteSource | null;
}

/**
 * 2026-09-13: the price window a crypto trade is judged against — lowest / highest price of `coin` inside the relay's quote
 * window at `now` (`server/CryptoMarket.quoteRange`). Injected so this file stays pure (no timers, no RelayServer import).
 */
export interface CryptoQuoteSource {
  quoteRange(coin: string, now: number): { min: number; max: number } | null;
}

export class CreditEconomy {
  readonly table: EconomyTable;
  readonly dev: boolean;
  private cryptoQuotes: CryptoQuoteSource | null;

  constructor(table: EconomyTable = ECONOMY_TABLE, opts: CreditEconomyOptions = {}) {
    this.table = table;
    this.dev = opts.dev === true;
    this.cryptoQuotes = opts.cryptoQuotes ?? null;
  }

  /** 2026-09-13: attach (or detach with null) the market that prices `cbuy:` / `csell:` — without one every crypto trade is refused. */
  setCryptoQuotes(src: CryptoQuoteSource | null): void { this.cryptoQuotes = src; }

  /** The most recent unrefunded debit of `reason` inside the window that still covers `amount`. */
  private pairDebit(ledger: CreditLedger | undefined, reason: string, amount: number, now: number): CreditLedger['debits'][number] | null {
    if (!ledger) return null;
    for (let i = ledger.debits.length - 1; i >= 0; i--) {
      const d = ledger.debits[i];
      if (d.reason !== reason || now - d.at > CREDIT_REFUND_WINDOW_MS || now < d.at - CREDIT_REFUND_WINDOW_MS) continue;
      if (d.amount - d.refunded >= amount) return d;
    }
    return null;
  }

  /** Judge one transaction against the table and the ledger. Pure — nothing changes until `commit`. */
  check(balance: number | null, ledger: CreditLedger | undefined, delta: number, reason: string, now: number = Date.now()): CreditCheck {
    const t = this.table;
    const d = finite(delta) ? Math.trunc(delta) : 0;
    const parsed = parseCreditReason(reason);
    if (!parsed) return { ok: false, why: `unknown reason "${String(reason).slice(0, 64)}"` };
    const okay = (dd: number, seed = false): CreditCheck => ({ ok: true, parsed, delta: dd, seed });
    switch (parsed.kind) {
      case 'dev':
        return this.dev ? okay(d) : { ok: false, why: `dev reason "${parsed.tag}" on a relay without ${CREDIT_DEV_ENV}` };
      case 'migrate':
        if (balance !== null) return { ok: false, why: 'migrate after the balance exists' };
        return okay(Math.min(t.creditsMax, Math.max(0, d)), true);
      case 'buy': {
        const it = t.items[parsed.id];
        if (!it) return { ok: false, why: `buy of unknown item ${parsed.id}` };
        const min = tableMinBuyPrice(t, it.value);
        if (d >= 0) return { ok: false, why: `buy with delta ${d} ≥ 0` };
        if (-d < min) return { ok: false, why: `buy ${parsed.id} for ${-d} < minimum ${min}` };
        return okay(d);
      }
      case 'sell': {
        const it = t.items[parsed.id];
        const qty = parsed.qty ?? 0;
        if (!it) return { ok: false, why: `sell of unknown item ${parsed.id}` };
        if (qty < 1 || qty > it.stack) return { ok: false, why: `sell ${parsed.id} qty ${qty} outside 1…${it.stack}` };
        const max = tableSellPrice(t, it.value, qty);
        if (d <= 0 || d > max) return { ok: false, why: `sell ${parsed.id}×${qty} for ${d} outside 1…${max}` };
        return okay(d);
      }
      case 'refund': {
        if (d <= 0) return { ok: false, why: `refund with delta ${d} ≤ 0` };
        return this.pairDebit(ledger, formatCreditReason({ kind: 'buy', id: parsed.id }), d, now)
          ? okay(d) : { ok: false, why: `refund ${parsed.id} ${d} has no unrefunded buy in the window` };
      }
      case 'repair': {
        const fee = t.repairFees[parsed.id];
        if (fee === undefined) return { ok: false, why: `repair of unknown implant ${parsed.id}` };
        return d === -fee ? okay(d) : { ok: false, why: `repair ${parsed.id} for ${d} ≠ −${fee}` };
      }
      case 'refund-repair': {
        if (d <= 0) return { ok: false, why: `refund:repair with delta ${d} ≤ 0` };
        return this.pairDebit(ledger, formatCreditReason({ kind: 'repair', id: parsed.id }), d, now)
          ? okay(d) : { ok: false, why: `refund:repair ${parsed.id} ${d} has no unrefunded repair in the window` };
      }
      case 'contract': {
        const reward = t.contracts[parsed.id];
        if (reward === undefined) return { ok: false, why: `unknown contract ${parsed.id}` };
        if (d !== reward) return { ok: false, why: `contract ${parsed.id} for ${d} ≠ ${reward}` };
        const recent = (ledger?.contractsAt ?? []).filter((at) => now - at < CREDIT_CONTRACT_WINDOW_MS).length;
        return recent < CREDIT_CONTRACT_MAX_PER_HOUR ? okay(d) : { ok: false, why: `contract cap ${CREDIT_CONTRACT_MAX_PER_HOUR}/h reached` };
      }
      case 'quest': {
        const reward = t.quests[parsed.id];
        if (reward === undefined) return { ok: false, why: `unknown quest ${parsed.id}` };
        if (d !== reward) return { ok: false, why: `quest ${parsed.id} for ${d} ≠ ${reward}` };
        return ledger?.quests.includes(parsed.id) ? { ok: false, why: `quest ${parsed.id} already paid` } : okay(d);
      }
      case 'rover': {
        /* 2026-09-13 rover fare: the fare comes from the seed's route length, which the relay cannot know — so only
         * the csv range, the sign, whole credits and an hourly cap. `parseCreditReason` already refused from === to /
         * bad ids. */
        const lo = t.roverFareMin, hi = t.roverFareMax;
        if (!finite(lo) || !finite(hi)) return { ok: false, why: 'rover fare but the table has no roverFareMin/roverFareMax' };
        if (!finite(delta) || delta !== d) return { ok: false, why: `rover fare ${String(delta)} is not whole credits` };
        if (d >= 0) return { ok: false, why: `rover fare with delta ${d} ≥ 0` };
        if (-d < lo || -d > hi) return { ok: false, why: `rover fare ${-d} outside ${lo}…${hi}` };
        const recent = (ledger?.roverAt ?? []).filter((at) => now - at < CREDIT_CONTRACT_WINDOW_MS).length;
        return recent < CREDIT_ROVER_MAX_PER_HOUR ? okay(d) : { ok: false, why: `rover fare cap ${CREDIT_ROVER_MAX_PER_HOUR}/h reached` };
      }
      case 'intel': {
        /* 2026-09-14 the intel broker: the relay checks **the amount only** — it cannot see whether the launch was
         * really made with that intel (the map is built by the client, the same limit as item ownership). The
         * formula is the client's own `intelCost` and only the table comes from `economy.gen.json`. */
        const ix = t.intel;
        if (!ix) return { ok: false, why: 'intel purchase but the table has no intel section' };
        const threat = Object.prototype.hasOwnProperty.call(ix.planetThreat, parsed.id) ? ix.planetThreat[parsed.id] : undefined;
        if (threat === undefined) return { ok: false, why: `intel for unknown planet ${parsed.id}` };
        const picks = parseIntelCode(parsed.code ?? '');
        if (!picks || picks.length === 0) return { ok: false, why: `intel code "${String(parsed.code).slice(0, 32)}" is malformed` };
        for (const p of picks) {
          const opt = Object.prototype.hasOwnProperty.call(ix.options, p.g) ? ix.options[p.g] : undefined;
          if (!opt) return { ok: false, why: `intel gimmick ${p.g} is not sold` };
          if (p.tier > opt.maxTier) return { ok: false, why: `intel ${p.g} tier ${p.tier} > max ${opt.maxTier}` };
        }
        if (!finite(delta) || delta !== d) return { ok: false, why: `intel price ${String(delta)} is not whole credits` };
        if (d >= 0) return { ok: false, why: `intel with delta ${d} ≥ 0` };
        const want = intelCost(threat, picks, ix);
        if (-d !== want) return { ok: false, why: `intel ${parsed.code} @ ${parsed.id} for ${-d} ≠ ${want}` };
        const recent = (ledger?.intelAt ?? []).filter((at) => now - at < CREDIT_CONTRACT_WINDOW_MS).length;
        return recent < CREDIT_INTEL_MAX_PER_HOUR ? okay(d) : { ok: false, why: `intel cap ${CREDIT_INTEL_MAX_PER_HOUR}/h reached` };
      }
      case 'crypto-buy':
      case 'crypto-sell': {
        /* 2026-09-13 crypto trades (`credits.ts`'s section of the same day): the amount must be one a client could
         * have computed from a price the relay showed inside the quote window — a buy at least the cost at the
         * window's lowest price, a sell at most the payout at its highest. Wallet ownership is not checked (the ship
         * document is a client write — the same limit as items). */
        const cx = t.crypto;
        const buy = parsed.kind === 'crypto-buy';
        if (!cx) return { ok: false, why: 'crypto trade but the table has no crypto section' };
        const coin = Object.prototype.hasOwnProperty.call(cx.coins, parsed.id) ? cx.coins[parsed.id] : undefined;
        if (!coin) return { ok: false, why: `crypto trade of unknown coin ${parsed.id}` };
        if (coin.unlockQuest && !(ledger?.quests ?? []).includes(coin.unlockQuest)) return { ok: false, why: `crypto ${parsed.id} is locked (quest ${coin.unlockQuest} not paid)` };
        const units = parsed.qty ?? 0;
        if (!Number.isInteger(units) || units < 1 || units > cx.maxUnits) return { ok: false, why: `crypto ${parsed.id} units ${units} outside 1…${cx.maxUnits}` };
        if (!finite(delta) || delta !== d) return { ok: false, why: `crypto trade ${String(delta)} is not whole credits` };
        const q = this.cryptoQuotes?.quoteRange(parsed.id, now) ?? null;
        if (!q) return { ok: false, why: `crypto ${parsed.id}: no market price on this relay` };
        if (buy) {
          const min = cryptoTradeCredits('buy', q.min, units, cx.unitsPerCoin, cx.fee);
          if (d >= 0) return { ok: false, why: `crypto buy with delta ${d} ≥ 0` };
          if (-d < min) return { ok: false, why: `crypto buy ${parsed.id}×${units} for ${-d} < ${min} (window low ${q.min})` };
        } else {
          const max = cryptoTradeCredits('sell', q.max, units, cx.unitsPerCoin, cx.fee);
          if (d <= 0 || d > max) return { ok: false, why: `crypto sell ${parsed.id}×${units} for ${d} outside 1…${max} (window high ${q.max})` };
        }
        const recent = (ledger?.cryptoAt ?? []).filter((at) => now - at < CREDIT_CONTRACT_WINDOW_MS).length;
        return recent < CREDIT_CRYPTO_MAX_PER_HOUR ? okay(d) : { ok: false, why: `crypto trade cap ${CREDIT_CRYPTO_MAX_PER_HOUR}/h reached` };
      }
    }
    return { ok: false, why: 'unhandled reason' };
  }

  /** Record an **applied** transaction on the ledger (call only after the balance really moved). Mutates, prunes. */
  commit(ledger: CreditLedger, check: Extract<CreditCheck, { ok: true }>, now: number = Date.now()): void {
    const p = check.parsed;
    switch (p.kind) {
      case 'buy':
      case 'repair':
        ledger.debits.push({ reason: formatCreditReason({ kind: p.kind, id: p.id }), amount: -check.delta, at: now, refunded: 0 });
        break;
      case 'refund':
      case 'refund-repair': {
        const debit = this.pairDebit(ledger, formatCreditReason({ kind: p.kind === 'refund' ? 'buy' : 'repair', id: p.id }), check.delta, now);
        if (debit) debit.refunded += check.delta;
        break;
      }
      case 'contract':
        ledger.contractsAt.push(now);
        break;
      case 'quest':
        if (!ledger.quests.includes(p.id)) ledger.quests.push(p.id);
        break;
      case 'rover':
        // a stamp for the hourly cap only — deliberately not a `debits` entry, so no `refund:` can ever pair with a fare
        (ledger.roverAt ??= []).push(now);
        break;
      case 'crypto-buy':
      case 'crypto-sell':
        // 2026-09-13: the hourly cap only — never a `debits` entry (a trade has no refund; the reverse trade is the undo)
        (ledger.cryptoAt ??= []).push(now);
        break;
      case 'intel':
        // 2026-09-14: the hourly cap only — intel is **not refundable**, so no `debits` entry (the same as rover)
        (ledger.intelAt ??= []).push(now);
        break;
      default:
        break;
    }
    pruneLedger(ledger, now);
  }
}
