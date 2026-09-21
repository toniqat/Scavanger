/* ────────────────────────────────────────────────────────────────────────────
 * Intel broker table loader (2026-09-14, `src/meta/README.md` Decisions).
 *
 * `shared/intel.ts` is **shared with the relay**, so it has no runtime import at all (not even the csv loader).
 * The csv-reading side was therefore split off into this file — **the same split** as `shared/credits.ts`
 * (pure formulas) ↔ `shared/meta.ts` (csv). The relay does not import this file; it is handed the `intel`
 * section of `server/economy.gen.json`.
 *
 * Owner: shared/. Read by `meta/parts/Intel.ts` (prices · purchase) and `hub/ui/IntelMenu.ts` (rows · text · lock reasons).
 * ──────────────────────────────────────────────────────────────────────────── */

import { csvRows, keyTable, numberList } from './data/tables';
import { INTEL_GIMMICKS, INTEL_TIER_MAX, type IntelCostTable, type IntelGimmick } from './intel';
import { PLANET_DEFS } from './planetDefs';
import type { PlanetId } from './planets';

const T = /* data/tuning.csv */ keyTable('tuning.csv');

/** One row of `data/intel_options.csv`. */
export interface IntelOptionDef {
  id: IntelGimmick;
  /** The row's on-screen name (e.g. `탈출 지점`). */
  label: string;
  /** Effect sentence template — `{n}` becomes that tier's bonus count (`intelEffectText`). */
  effect: string;
  /** Tier-1 cost (credits). */
  baseCost: number;
  /** 1 … `INTEL_TIER_MAX`. */
  maxTier: number;
  /** The lowest planet threat at which this row opens (1 = anywhere). */
  minThreat: number;
  /** One tooltip line (the csv's `note`). */
  note: string;
  /** File row order. */
  order: number;
}

const BY_ID = new Map<string, IntelOptionDef>();

export const INTEL_OPTION_DEFS: readonly IntelOptionDef[] = csvRows('intel_options.csv').map((r, order) => {
  const id = r.str('id') as IntelGimmick;
  const def: IntelOptionDef = {
    id,
    label: r.str('label'),
    effect: r.str('effect'),
    baseCost: r.int('baseCost', { min: 0 }),
    maxTier: Math.max(1, Math.min(INTEL_TIER_MAX, r.int('maxTier', { min: 1 }))),
    minThreat: r.has('minThreat') ? r.int('minThreat', { min: 1 }) : 1,
    note: r.optStr('note') ?? '',
    order,
  };
  BY_ID.set(id, def);
  return def;
});

/* Does the csv cover the 7 `IntelGimmick` values exactly — a missing one cannot be bought, and an unknown id never shows. */
{
  const known = new Set<string>(INTEL_GIMMICKS);
  for (const d of INTEL_OPTION_DEFS) {
    if (!known.has(d.id)) {
      // eslint-disable-next-line no-console
      console.warn(`[intel_options.csv] 모르는 기믹 '${d.id}' — shared/intel.ts 의 IntelGimmick 에 없다`);
    }
  }
}

export function intelOptionDef(g: IntelGimmick): IntelOptionDef | undefined { return BY_ID.get(g); }

/** Display order = `INTEL_GIMMICKS` order (the contract's order, not the csv row order — the code and the reason follow it too). */
export const INTEL_OPTIONS_IN_ORDER: readonly IntelOptionDef[] =
  INTEL_GIMMICKS.map((g) => BY_ID.get(g)).filter((d): d is IntelOptionDef => !!d);

/** The price table built from `data/tables.csv` · `data/tuning.csv` — passed to `intelCost` as it is. */
export const INTEL_COST_TABLE: IntelCostTable = {
  options: Object.fromEntries(INTEL_OPTION_DEFS.map((d) => [d.id, { baseCost: d.baseCost, maxTier: d.maxTier }])),
  tierMul: numberList('tables.csv', 'INTEL_TIER_COST_MUL'),
  bundleMul: T.num('INTEL_BUNDLE_COST_MUL'),
  threatMul: numberList('tables.csv', 'INTEL_THREAT_COST_MUL'),
};

/** Planet id → threat (price and lock judgement). */
export function intelPlanetThreat(planet: PlanetId | null | undefined): number {
  if (!planet) return 1;
  return PLANET_DEFS.find((p) => p.id === planet)?.threat ?? 1;
}

/**
 * The highest tier of this row on this planet. **0 = locked** — today `minThreat` is the only lock and `named`
 * is what uses it (user's decision: threat 2 and above only).
 */
export function intelMaxTier(g: IntelGimmick, planet: PlanetId | null | undefined): number {
  const d = BY_ID.get(g);
  if (!d) return 0;
  return intelPlanetThreat(planet) >= d.minThreat ? d.maxTier : 0;
}

/** The effect sentence written on screen at that tier (`{n}` substituted). Empty string at tier 0. */
export function intelEffectText(g: IntelGimmick, tier: number): string {
  const d = BY_ID.get(g);
  if (!d || tier <= 0) return '';
  const n = g === 'hazardDelay' ? tier + 1 : tier;   // only the hazard delay is 「tier + 1 minutes」 — the same formula as resolveIntelEffects
  return d.effect.replace('{n}', String(n));
}
