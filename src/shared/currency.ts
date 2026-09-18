import { csvRows } from './data/tables';
import { formatCompactNumber } from './numberFormat';
import { CORP_DEFS, CORP_IDS, type CorpId } from './meta';

/* ────────────────────────────────────────────────────────────────────────────
 * Currencies (2026-09-09) — reward units that are **not** items: credits · XP · per-corp reputation.
 *
 * Until now a contract's or quest's reward was one line of text like `신뢰도 +12 · XP +40 · 크레딧 +1,200`. On
 * screen an item reward is a thumbnail while only the currency reward was text, so a **currency chip** that
 * stands in the same place at the same size is built. It is the twin of `itemChip.ts` and lives next to it for
 * the same reason — it is the only place that lets contracts (meta/) · quests (meta/) · mission settlement (ui/) ·
 * progression (progression/) draw the very same chip without importing each other.
 *
 * **A frame that reads apart from an item's.** An item chip is a square thumbnail (`.item-chip-thumb`) and a
 * currency chip is a **hexagonal frame with the corners cut** (`.currency-chip`) — size · spacing · count
 * notation follow the same rules as the item chip, so the rows line up even when the two are mixed on one line,
 * and "this is not a thing" reads at a glance. The tooltip uses the same card (`ui/hud/ItemTip`), with a
 * `재화` badge in its header (`.item-tip.is-currency`).
 *
 * **Extension.** Adding a row to `data/currencies.csv` creates a new currency. Reputation alone is a special
 * **template row**: it multiplies into one copy per corp of `data/corps.csv` as `rep:<corp id>`, and the name ·
 * colour · description are that corp's — because reputation is a separate currency per corp and its thumbnail
 * has to differ by the corp's colour.
 *
 * Like `itemChip.ts`, this module **touches no context and builds DOM out of the data it is handed.** No
 * listeners, no state.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The kind of a currency. A new kind widens both the `kind` column of `data/currencies.csv` and this union. */
export type CurrencyKind = 'credits' | 'xp' | 'rep';

/** Id of a corp reputation currency (`rep:helix` …). */
export type RepCurrencyId = `rep:${CorpId}`;

/** A currency id. Reputation has one per corp, so this is not a plain enumeration. */
export type CurrencyId = 'credits' | 'xp' | RepCurrencyId;

export interface CurrencyDef {
  id: CurrencyId;
  kind: CurrencyKind;
  /** Korean display name (a reputation is `헬릭스 방산 신뢰도`). */
  name: string;
  /** The single glyph stamped on the thumbnail. */
  icon: string;
  /** Thumbnail · tooltip title colour. A reputation uses the corp colour. */
  color: string;
  description: string;
  /** The corp when this is a reputation. Absent otherwise. */
  corp?: CorpId;
}

/** Builds the id of a corp reputation currency. */
export function repCurrencyId(corp: CorpId): RepCurrencyId { return `rep:${corp}`; }

/* ── data/currencies.csv → the definition table ───────────────────────────── */

interface RawRow { id: string; kind: CurrencyKind; name: string; icon: string; color: string; description: string }

const RAW: readonly RawRow[] = csvRows('currencies.csv').map((r) => ({
  id: r.str('id'),
  kind: r.str('kind') as CurrencyKind,
  name: r.str('name'),
  icon: r.str('icon'),
  color: r.str('color'),
  description: r.str('description'),
}));

function buildDefs(): Record<CurrencyId, CurrencyDef> {
  const out = {} as Record<CurrencyId, CurrencyDef>;
  for (const row of RAW) {
    if (row.kind === 'rep') {
      // A template row: one copy per corp. The name and colour are the corp's; only the description carries the table's through.
      for (const corp of CORP_IDS) {
        const corpDef = CORP_DEFS[corp];
        const id = repCurrencyId(corp);
        out[id] = {
          id,
          kind: 'rep',
          name: `${corpDef?.name ?? corp} ${row.name}`,
          icon: row.icon,
          color: corpDef?.color ?? row.color,
          description: `${corpDef?.name ?? corp}: ${row.description}`,
          corp,
        };
      }
      continue;
    }
    const id = row.id as CurrencyId;
    out[id] = { id, kind: row.kind, name: row.name, icon: row.icon, color: row.color, description: row.description };
  }
  return out;
}

export const CURRENCY_DEFS: Readonly<Record<CurrencyId, CurrencyDef>> = buildDefs();

/** Every defined currency id (table order → corp order). */
export const CURRENCY_IDS: readonly CurrencyId[] = Object.keys(CURRENCY_DEFS) as CurrencyId[];

/** undefined for an id that does not exist — so an old save referring to a deleted currency cannot break a screen. */
export function currencyDef(id: string): CurrencyDef | undefined {
  return CURRENCY_DEFS[id as CurrencyId];
}

/** One currency reward. Contracts and quests pass their rewards as an array of these. */
export interface CurrencyReward {
  id: CurrencyId;
  amount: number;
}

/* ── Chips ───────────────────────────────────────────────────────────────── */

export interface CurrencyChipOptions {
  /** The amount. Without it the chip is bare, with no count. */
  amount?: number;
  /** Thumbnail side length (px). Default 34 — the same as an item chip. */
  size?: number;
  /** Writes the name under the thumbnail. */
  withName?: boolean;
  /** Prefixes a `+` (reward display). A negative is always `−`. */
  signed?: boolean;
  /** Builds it as a `<button>`. */
  button?: boolean;
  /** The native title. There is no default — the hover card (`ui/hud/ItemTip`) comes up instead. */
  title?: string;
}

/** The fallback display for when an unknown currency id is met. */
const UNKNOWN: CurrencyDef = {
  id: 'credits', kind: 'credits', name: '알 수 없는 재화', icon: '?', color: '#7b828c', description: '',
};

/**
 * `1234` → `1,234`, `12345` → `12.3k`. Every currency amount is shown as an integer.
 * 2026-09-16 (user's decision): from 10,000 up it is compacted — the same formatter as credits (`shared/numberFormat.ts`).
 */
function groupDigits(n: number): string {
  return formatCompactNumber(n); // 2026-09-11 (C-10): the same locale as the game-wide number formatter
}

/**
 * One currency chip. When `id` is not in the table a grey fallback chip comes out (it never throws — one old
 * save must not kill a whole panel).
 *
 * Markup (the styles are `.currency-chip*` in `src/ui/styles/base.css`):
 *
 *   button|div.item-chip.currency-chip      ← `--cy` = the currency colour, `data-currency-id` = the hover card's hook
 *     div.item-chip-thumb.currency-thumb > span.item-chip-icon
 *     div.item-chip-count > span.item-chip-have
 *     div.item-chip-name                     (only with withName)
 */
export function buildCurrencyChip(id: CurrencyId | CurrencyDef, opts: CurrencyChipOptions = {}): HTMLElement {
  const def = typeof id === 'string' ? (currencyDef(id) ?? UNKNOWN) : id;
  const size = opts.size ?? 34;
  const el = document.createElement(opts.button ? 'button' : 'div');
  el.className = 'item-chip currency-chip';
  if (opts.button) (el as HTMLButtonElement).type = 'button';
  el.style.setProperty('--chip-size', `${size}px`);
  el.style.setProperty('--cy', def.color);
  // Fill the item chip's `--rc` / `--ic` slots with the same colour — the two chips share one stylesheet.
  el.style.setProperty('--rc', def.color);
  el.style.setProperty('--ic', def.color);
  el.dataset.currencyId = def.id;
  if (def.corp) el.dataset.corp = def.corp;
  if (opts.title !== undefined) el.title = opts.title;

  const thumb = document.createElement('div');
  thumb.className = 'item-chip-thumb currency-thumb';
  const icon = document.createElement('span');
  icon.className = 'item-chip-icon';
  icon.textContent = def.icon || '◈';
  thumb.appendChild(icon);

  const amount = opts.amount;
  if (amount !== undefined) {
    const count = document.createElement('div');
    count.className = 'item-chip-count';
    const only = document.createElement('span');
    only.className = 'item-chip-have';
    const sign = amount < 0 ? '−' : opts.signed ? '+' : '';
    only.textContent = `${sign}${groupDigits(amount)}`;
    count.appendChild(only);
    thumb.appendChild(count);
  }
  el.appendChild(thumb);

  if (opts.withName) {
    const name = document.createElement('div');
    name.className = 'item-chip-name';
    name.textContent = def.name;
    el.appendChild(name);
  }
  return el;
}

/**
 * Swaps `host`'s children for currency reward chips. A reward whose amount is 0 or missing is skipped, so a
 * quest with no credits has no credit chip either. Whether `host` is cleared — so that item reward chips
 * (`renderItemCost` / `buildItemChip`) can be appended on the same row — is decided by **the caller**; this only
 * does `append`.
 */
export function appendCurrencyRewards(
  host: HTMLElement,
  rewards: readonly CurrencyReward[],
  opts: CurrencyChipOptions = {},
): void {
  host.classList.add('item-chips');
  for (const r of rewards) {
    if (!r || !Number.isFinite(r.amount) || Math.round(r.amount) === 0) continue;
    host.appendChild(buildCurrencyChip(r.id, { signed: true, ...opts, amount: r.amount }));
  }
}
