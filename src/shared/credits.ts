/* ────────────────────────────────────────────────────────────────────────────
 * 서버 크레딧 검증 계약 (2026-09-11, E-4 — docs/plans/net-social-trust.md §5, 사용자 결정 "서버 크레딧 검증까지").
 *
 * Until now `credits:tx {delta, reason}` was applied blindly: the relay only refused a balance below 0. The relay now
 * **parses `reason`** and checks `delta` against an economy table generated from `data/*.csv`:
 *
 *   buy:<defId>                 delta < 0, |delta| ≥ minimum shop price of defId (the best reputation discount)
 *   sell:<defId>:<qty>          0 < delta ≤ value × SELL_PRICE_MUL × qty (rounded like `sellPriceOf`), 1 ≤ qty ≤ stack
 *   refund:<defId>              0 < delta ≤ an unrefunded `buy:<defId>` of this profile within `CREDIT_REFUND_WINDOW_MS`
 *   repair:<brokenId>           delta === −implant repair fee of the repaired implant
 *   refund:repair:<brokenId>    pairs with an unrefunded `repair:<brokenId>` inside the window
 *   contract:<contractId>       delta === contracts.csv reward, at most `CREDIT_CONTRACT_MAX_PER_HOUR` per profile
 *   quest:<questId>             delta === quests.csv reward, once per quest id per profile (ledger)
 *   migrate                     only while the server balance is null, clamped to `CREDITS_MAX`
 *   console · smoke:* · e2e:* · shot     refused unless the relay runs with the dev-economy flag (verify runner / e2e)
 *   anything else               refused (`credits:result ok:false reason:'invalid'`)
 *
 * What this does NOT check (user-accepted, recorded in the plan): whether the item was really owned. The stash /
 * loadout documents are client writes, so a server diff would prove nothing.
 *
 * This file is imported by the browser AND the Node relay — **no runtime imports** (no csv loader, no three).
 * Owner: shared/. `server/` (⑦) validates with `EconomyTable`; `meta/` formats reasons with `formatCreditReason`;
 * `scripts/` generates the table (`server/economy.gen.json`) from the same csv the client reads and fails `data:check`
 * when the committed copy is stale.
 * ──────────────────────────────────────────────────────────────────────────── */

export type CreditReasonKind =
  | 'buy' | 'sell' | 'refund' | 'repair' | 'refund-repair' | 'contract' | 'quest' | 'migrate' | 'dev';

export interface CreditReason {
  kind: CreditReasonKind;
  /** defId (buy · sell · refund), broken implant defId (repair · refund-repair), contract / quest id. '' for migrate / dev. */
  id: string;
  /** sell only. */
  qty?: number;
  /** dev only: the raw tag (`console`, `smoke:xyz`, `e2e:…`, `shot`). */
  tag?: string;
}

/** Wire form. The relay caps `reason` at 64 characters, so ids must stay short (they are csv ids). */
export function formatCreditReason(r: CreditReason): string {
  switch (r.kind) {
    case 'sell': return `sell:${r.id}:${Math.max(1, Math.floor(r.qty ?? 1))}`;
    case 'refund-repair': return `refund:repair:${r.id}`;
    case 'migrate': return 'migrate';
    case 'dev': return r.tag ?? 'console';
    default: return `${r.kind}:${r.id}`;
  }
}

/** Inverse of `formatCreditReason`; null for anything the grammar does not know. Pure — the relay and tests share it. */
export function parseCreditReason(raw: string): CreditReason | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
  if (raw === 'migrate') return { kind: 'migrate', id: '' };
  if (raw === 'console' || raw === 'shot' || raw.startsWith('smoke:') || raw.startsWith('e2e:')) {
    return { kind: 'dev', id: '', tag: raw };
  }
  const parts = raw.split(':');
  const ID = /^[a-z0-9_]+$/i;
  if (parts[0] === 'refund' && parts[1] === 'repair' && parts.length === 3 && ID.test(parts[2])) {
    return { kind: 'refund-repair', id: parts[2] };
  }
  if (parts[0] === 'sell' && parts.length === 3 && ID.test(parts[1]) && /^[1-9]\d{0,4}$/.test(parts[2])) {
    return { kind: 'sell', id: parts[1], qty: Number(parts[2]) };
  }
  if (parts.length === 2 && ID.test(parts[1])) {
    const k = parts[0];
    if (k === 'buy' || k === 'refund' || k === 'repair' || k === 'contract' || k === 'quest') return { kind: k, id: parts[1] };
  }
  return null;
}

/**
 * Everything the relay needs to price a reason, flattened from the csv by the generator (the relay cannot run the
 * Vite csv loader, and `ItemDef.value` is derived in `src/items/`). `v` bumps when the shape changes; `hash` = hash of
 * the source csv so `data:check` can tell a stale copy.
 */
export interface EconomyTable {
  v: 1;
  hash: string;
  creditsInitial: number;
  creditsMax: number;
  shopPriceBaseMul: number;
  shopPriceDiscountPerRep: number;
  shopPriceMinMul: number;
  sellPriceMul: number;
  /** defId → `ItemDef.value` and max stack (1 = unstackable). Only items with a value > 0. */
  items: Record<string, { value: number; stack: number }>;
  /** broken implant defId → credit fee of repairing it (`implantRepairFee` of the repaired def). */
  repairFees: Record<string, number>;
  /** contract id → `creditsReward`. */
  contracts: Record<string, number>;
  /** quest id → `rewards.credits` (only quests with a credit reward). */
  quests: Record<string, number>;
}

/** Same formula as `shared/meta.buyPriceOf`, fed from the table (generator + `data:check` prove they agree). */
export function tableBuyPrice(t: EconomyTable, value: number, repLevel: number): number {
  const mul = Math.max(t.shopPriceMinMul, t.shopPriceBaseMul - t.shopPriceDiscountPerRep * Math.max(0, repLevel));
  return Math.max(1, Math.round(value * mul));
}
/** Same formula as `shared/meta.sellPriceOf`. */
export function tableSellPrice(t: EconomyTable, value: number, qty: number): number {
  return Math.max(0, Math.round(value * t.sellPriceMul * Math.max(0, qty)));
}

/** Server-internal ledger on `ProfileRecord.ledger` (never sent to a client). */
export interface CreditLedger {
  /** Quest ids already paid through `quest:<id>`. */
  quests: string[];
  /** Server epoch ms of recent `contract:` payouts (pruned to the last hour). */
  contractsAt: number[];
  /** Recent debits a refund may pair with (pruned to `CREDIT_REFUND_WINDOW_MS`). */
  debits: { reason: string; amount: number; at: number; refunded: number }[];
}

/** A `refund:` must follow its debit within this long. */
export const CREDIT_REFUND_WINDOW_MS = 60_000;
/** `contract:` payouts accepted per profile per rolling hour (a raid takes minutes; several contracts per raid never happen). */
export const CREDIT_CONTRACT_MAX_PER_HOUR = 12;
/** Env var / CLI flag the relay reads to accept `dev` reasons (verify runner, e2e, `npm run dev:all`). Off in the shipped exe. */
export const CREDIT_DEV_ENV = 'SCAV_DEV_ECONOMY';
