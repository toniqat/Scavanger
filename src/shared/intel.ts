/* ────────────────────────────────────────────────────────────────────────────
 * The intel broker (2026-09-14, user's decision — `src/meta/README.md` Decisions).
 *
 * The concept is 「buying a planet's intel」, but what it actually does is **pin down how many gimmicks that raid
 * has** (Payday 2's pre-heist asset purchase). Until now a map was a pure function of the two values
 * `seed + planet` and only those two went on the wire — the intel broker adds a **third value** to them. So this
 * file is the contract:
 *
 *   IntelPick[]  = what a person picked on screen (gimmick · tier)  — goes into the save · wire · credit reason
 *   IntelEffects = the resolved form the world reads                — consumers read **only this**
 *
 * There is exactly one reason consumers (`world/` · `enemies/`) never resolve `IntelPick[]` themselves: copy the
 * tier → real bonus table into two places and the preview map and the real map silently differ (CLAUDE.md
 * 「previewing contents must equal opening」). `resolveIntelEffects` alone is that table.
 *
 * This file is imported by the browser **and the Node relay** — **no runtime import** (neither the csv loader nor
 * three). Every number is handed in by the caller as a table (`IntelCostTable`): the client passes what it read
 * from `data/intel_options.csv`, the relay the `intel` section of `server/economy.gen.json` — the same pattern as
 * the price formulas of `shared/credits.ts`.
 *
 * Owner: shared/. The implementation is `meta/parts/Intel.ts` (holding · buying), the screen is `hub/ui/IntelMenu.ts`,
 * the world application is `world/` · `enemies/named/Director.ts`, and the check is `server/Economy.ts`.
 * ──────────────────────────────────────────────────────────────────────────── */

import type { PlanetId } from './planets';

/**
 * The 7 buyable gimmicks. The values go into the save · the wire · the credit reason, so they are **never
 * changed** (append only).
 *
 *   extraction   number of extraction pads     +1 / +2
 *   basement     structures with a basement    +1 / +2   (lab · outpost)
 *   hazardDelay  time until the hazard starts  +2 / +3 / +4 minutes
 *   rail         rails guaranteed + platforms  +1
 *   rover        rover guaranteed              +1
 *   named        a named boss chosen           one at a time (only on a planet of threat 2 or higher)
 *   nest         number of bug nests           +1 / +2
 */
export type IntelGimmick = 'extraction' | 'basement' | 'hazardDelay' | 'rail' | 'rover' | 'named' | 'nest';

/** Both the display order and the save order. Sorting and code generation use this order. */
export const INTEL_GIMMICKS: readonly IntelGimmick[] = [
  'extraction', 'basement', 'hazardDelay', 'rail', 'rover', 'named', 'nest',
];

/**
 * The one letter that goes into the credit reason (`intel:<planet>:<code>`). A reason is capped at 64 characters,
 * so a gimmick name cannot be used as it is. The server parses these values, so they are **never changed**.
 */
export const INTEL_GIMMICK_CODE: Record<IntelGimmick, string> = {
  extraction: 'x', basement: 'b', hazardDelay: 'h', rail: 'r', rover: 'v', named: 'n', nest: 'g',
};

const CODE_TO_GIMMICK: Record<string, IntelGimmick> = (() => {
  const m: Record<string, IntelGimmick> = {};
  for (const g of INTEL_GIMMICKS) m[INTEL_GIMMICK_CODE[g]] = g;
  return m;
})();

/** Absolute ceiling on a selectable tier (the csv's `maxTier` can never be larger than this). */
export const INTEL_TIER_MAX = 3;

/** One row's pick. `tier` starts at 1 — 0 means 「안 새다」 (not bought) and never enters `picks` at all. */
export interface IntelPick {
  g: IntelGimmick;
  /** 1 … `maxTier`. */
  tier: number;
  /** `named` only: the chosen enemy type id (`rogue_roden` and the like). It has no effect on the price. */
  id?: string;
}

/** The 「보유 정보」 (intel held) that is saved in the profile and goes on the wire. Only one at a time. */
export interface IntelSpec {
  planet: PlanetId;
  /** The 「지역」 (area) this intel points at = the mission seed. The launch uses this seed. */
  seed: number;
  picks: IntelPick[];
}

/**
 * The resolved form the world reads. **Consumers read only this** — it is published as `ctx.missionIntel` and,
 * exactly like `ctx.missionPlanet`, the emitter sets it **before emitting** `game:newMission` (it is read inside
 * synchronous handlers).
 */
export interface IntelEffects {
  /** Extraction pads +N. */
  extractionBonus: number;
  /** Structures with a basement +N. */
  basementBonus: number;
  /** Hazard start +N seconds. */
  hazardDelayS: number;
  /** > 0 = the rails are guaranteed to stand and platforms are +N. */
  railPlatformBonus: number;
  /** The rover is guaranteed to stand. */
  roverForce: boolean;
  /** The chosen named enemy type id (null when there is none = rolled as usual). */
  namedId: string | null;
  /** Bug nests +N. */
  nestBonus: number;
}

/** The state where nothing was bought. Frozen so a consumer can use it as `?? NO_INTEL`. */
export const NO_INTEL: Readonly<IntelEffects> = Object.freeze({
  extractionBonus: 0,
  basementBonus: 0,
  hazardDelayS: 0,
  railPlatformBonus: 0,
  roverForce: false,
  namedId: null,
  nestBonus: 0,
});

/**
 * The **one and only** table from a tier to the real bonus.
 *
 * Today every row is 「tier = number of bonuses」; only the hazard delay is in minutes, so it is multiplied. The
 * table was not moved out to csv because it is not a balance number but **the definition of what that row
 * means** — write 「탈출구 +2」 and then hand out a different number and the screen is lying. Only the values
 * (price · ceiling) live in `data/intel_options.csv`.
 */
export function resolveIntelEffects(picks: readonly IntelPick[] | null | undefined): IntelEffects {
  const e: IntelEffects = { ...NO_INTEL };
  if (!picks) return e;
  for (const p of picks) {
    const t = Math.max(0, Math.min(INTEL_TIER_MAX, Math.round(p?.tier ?? 0)));
    if (t <= 0) continue;
    switch (p.g) {
      case 'extraction': e.extractionBonus += t; break;
      case 'basement': e.basementBonus += t; break;
      case 'hazardDelay': e.hazardDelayS += (t + 1) * 60; break;   // tier 1 = +2 min, 2 = +3 min, 3 = +4 min
      case 'rail': e.railPlatformBonus += t; break;
      case 'rover': e.roverForce = true; break;
      case 'named': e.namedId = typeof p.id === 'string' && p.id ? p.id : e.namedId; break;
      case 'nest': e.nestBonus += t; break;
      default: break;                                              // an unknown gimmick (an old save · a newer client) is dropped
    }
  }
  return e;
}

/* ── Prices ──────────────────────────────────────────────────────────────── */

/**
 * Everything the price needs. The client builds it from `data/intel_options.csv` + `data/tables.csv` and the relay
 * from the `intel` section of `server/economy.gen.json`, in the same shape — so the **formula lives in one place**.
 */
export interface IntelCostTable {
  /** Gimmick → its tier-1 base cost. A gimmick missing from here cannot be bought. */
  options: Record<string, { baseCost: number; maxTier: number }>;
  /** Multiplier per tier (index 0 = tier 1). Non-linear — raising the same row further costs more. */
  tierMul: number[];
  /** Progressive multiplier applied to the total as the number of pinned rows grows (`bundleMul^(N-1)`). */
  bundleMul: number;
  /** Multiplier per planet threat (index 0 = threat 1). */
  threatMul: number[];
}

/**
 * The total credit cost. It is **non-linear** in two places — the tier of one row (`tierMul`) and the number of
 * pinned rows (`bundleMul^(N-1)`). User's decision 「the more rows you turn on, the more it costs, and not linearly」.
 */
export function intelCost(planetThreat: number, picks: readonly IntelPick[], t: IntelCostTable): number {
  let sum = 0;
  let lines = 0;
  for (const p of picks) {
    const opt = t.options[p?.g];
    if (!opt) continue;
    const tier = Math.max(0, Math.min(Math.round(opt.maxTier), Math.round(p.tier ?? 0)));
    if (tier <= 0) continue;
    sum += opt.baseCost * (t.tierMul[tier - 1] ?? 1);
    lines++;
  }
  if (lines <= 0) return 0;
  const bundle = Math.pow(Math.max(1, t.bundleMul), lines - 1);
  const ti = Math.max(0, Math.min(t.threatMul.length - 1, Math.round(planetThreat) - 1));
  const threat = t.threatMul[ti] ?? 1;
  return Math.max(0, Math.round(sum * bundle * threat));
}

/**
 * The compact code that goes into the credit reason — `intelCode([{g:'extraction',tier:2},{g:'nest',tier:1}]) === 'x2g1'`.
 * It sorts by `INTEL_GIMMICKS` order, so the same picks are **always the same string** (the server recomputes it
 * and compares). The enemy id of `named` is **not carried** — it has no effect on the price and eats the 64-character budget.
 */
export function intelCode(picks: readonly IntelPick[]): string {
  const byG = new Map<IntelGimmick, number>();
  for (const p of picks) {
    const tier = Math.max(0, Math.min(INTEL_TIER_MAX, Math.round(p?.tier ?? 0)));
    if (tier > 0 && INTEL_GIMMICK_CODE[p.g]) byG.set(p.g, tier);
  }
  let out = '';
  for (const g of INTEL_GIMMICKS) {
    const tier = byG.get(g);
    if (tier) out += INTEL_GIMMICK_CODE[g] + String(tier);
  }
  return out;
}

/** The inverse of `intelCode`. null when the shape is wrong (the server receives this value, so it is not lenient). */
export function parseIntelCode(code: string): IntelPick[] | null {
  if (typeof code !== 'string' || code.length === 0 || code.length > 2 * INTEL_GIMMICKS.length) return null;
  if (code.length % 2 !== 0) return null;
  const picks: IntelPick[] = [];
  const seen = new Set<IntelGimmick>();
  for (let i = 0; i < code.length; i += 2) {
    const g = CODE_TO_GIMMICK[code[i]];
    const tier = Number(code[i + 1]);
    if (!g || seen.has(g)) return null;
    if (!Number.isInteger(tier) || tier < 1 || tier > INTEL_TIER_MAX) return null;
    seen.add(g);
    picks.push({ g, tier });
  }
  return picks;
}

/* ── Save · wire hygiene ─────────────────────────────────────────────────── */

/**
 * Passed through before a value from a profile document · lobby state · `game:start` is trusted. null when it is
 * not the right shape.
 */
export function sanitizeIntelSpec(raw: unknown): IntelSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<IntelSpec>;
  if (typeof r.planet !== 'string' || !r.planet) return null;
  if (typeof r.seed !== 'number' || !Number.isFinite(r.seed)) return null;
  const picks = sanitizeIntelPicks(r.picks);
  if (!picks.length) return null;
  return { planet: r.planet as PlanetId, seed: Math.floor(r.seed), picks };
}

/**
 * Washes the row list alone (duplicate gimmicks dropped · tiers clamped · unknown gimmicks discarded · sorted into
 * `INTEL_GIMMICKS` order).
 */
export function sanitizeIntelPicks(raw: unknown): IntelPick[] {
  if (!Array.isArray(raw)) return [];
  const byG = new Map<IntelGimmick, IntelPick>();
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const p = it as Partial<IntelPick>;
    const g = p.g as IntelGimmick;
    if (!INTEL_GIMMICK_CODE[g] || byG.has(g)) continue;
    const tier = Math.max(0, Math.min(INTEL_TIER_MAX, Math.round(Number(p.tier) || 0)));
    if (tier <= 0) continue;
    const id = typeof p.id === 'string' && /^[a-z0-9_]{1,32}$/i.test(p.id) ? p.id : undefined;
    byG.set(g, id ? { g, tier, id } : { g, tier });
  }
  const out: IntelPick[] = [];
  for (const g of INTEL_GIMMICKS) { const p = byG.get(g); if (p) out.push(p); }
  return out;
}

/** Are the two held intels equal (document comparison · save debounce). */
export function intelSpecEqual(a: IntelSpec | null, b: IntelSpec | null): boolean {
  if (!a || !b) return a === b;
  if (a.planet !== b.planet || a.seed !== b.seed) return false;
  if (a.picks.length !== b.picks.length) return false;
  for (let i = 0; i < a.picks.length; i++) {
    const x = a.picks[i], y = b.picks[i];
    if (x.g !== y.g || x.tier !== y.tier || (x.id ?? '') !== (y.id ?? '')) return false;
  }
  return true;
}
