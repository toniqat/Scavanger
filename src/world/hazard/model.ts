/**
 * src/world/hazard/model.ts — the **vocabulary** environmental hazards share. It holds no state at all.
 *
 * Look numbers (colour · particle density · wall thickness) are all `data/hazards.csv` — this file is the **only**
 * reader of that table, and `data:check`'s orphan check reads that csv through this module (`DATA_OWNERS` in
 * `scripts/data-check.mjs`). Rule numbers (start · damage · radius · growth speed) are `data/constants.csv`, read by `@/shared`.
 *
 * ⚠ THREE is never used **as a value** here (`data:check` reads this module very early —
 *   the same convention as `structures/model.ts`).
 */
import {
  HAZARD_KINDS, HAZARD_START_MAX_S, HAZARD_START_MIN_S, HAZARD_START_STEP_S,
  type HazardKind, addDataIssue, csvRows,
} from '@/shared';

/** One `data/hazards.csv` row — one hazard's look numbers. */
export interface HazardRow {
  kind: HazardKind;
  /** The colour mixed into fog · sky inside a zone (`atmo:override.color`). */
  fogColor: number;
  /**
   * 2026-09-10 — the multiplier on fog density in the middle of a zone = **how hard sight is narrowed**. The four
   * hazards used to share one `HAZARD_FOG_MUL`; the storm eye must be far larger — the eye reads only if the inside does not.
   */
  fogMul: number;
  particleColor: number;
  particleCount: number;
  particleSize: number;
  /** Half-side (m) of the particle cloud. It follows the camera and wraps inside this box. */
  particleBox: number;
  driftMps: number;
  riseMps: number;
  wallColor: number;
  wallOpacity: number;
  wallHeight: number;
  /** Curtain thickness (m) of a `front` hazard's front. */
  frontBandM: number;
}

/** All of `data/hazards.csv`. */
export const HAZARD_ROWS: readonly HazardRow[] = csvRows('hazards.csv').map((r) => {
  const kind = r.str('kind') as HazardKind;
  if (!(HAZARD_KINDS as readonly string[]).includes(kind)) {
    r.report('kind', `'${kind}' 는 ${HAZARD_KINDS.join(' | ')} 중 하나여야 한다`);
  }
  return {
    kind,
    fogColor: r.num('fogColor', { min: 0 }),
    fogMul: r.num('fogMul', { min: 1, max: 60 }),
    particleColor: r.num('particleColor', { min: 0 }),
    particleCount: r.int('particleCount', { min: 0, max: 4000 }),
    particleSize: r.num('particleSize', { min: 0 }),
    particleBox: r.num('particleBox', { min: 1 }),
    driftMps: r.num('driftMps'),
    riseMps: r.num('riseMps'),
    wallColor: r.num('wallColor', { min: 0 }),
    wallOpacity: r.num('wallOpacity', { min: 0, max: 1 }),
    wallHeight: r.num('wallHeight', { min: 0 }),
    frontBandM: r.num('frontBandM', { min: 0 }),
  };
});

const BY_KIND = new Map<HazardKind, HazardRow>();
for (const row of HAZARD_ROWS) {
  if (BY_KIND.has(row.kind)) addDataIssue({ file: 'hazards.csv', line: 0, column: 'kind', message: `'${row.kind}' 가 중복이다` });
  else BY_KIND.set(row.kind, row);
}

/** Looks up one row. Asking for a missing kind leaves an issue for `data:check` to catch and returns undefined. */
export function hazardRow(kind: HazardKind): HazardRow | undefined {
  const row = BY_KIND.get(kind);
  if (!row) addDataIssue({ file: 'hazards.csv', line: 0, column: kind, message: `'${kind}' 줄이 없다` });
  return row;
}

/** Is this a hazard whose zone is a `front` (a straight sweep) — sandstorm · blizzard. */
export function isFrontKind(kind: HazardKind): boolean {
  return kind === 'sandstorm' || kind === 'blizzard';
}

/**
 * Draws the start time in `HAZARD_START_STEP_S` (30 s) steps — 6:00 · 6:30 … 8:00.
 * `roll` is one [0,1) value (the caller draws it from the mission seed).
 */
export function pickStartSeconds(roll: number): number {
  const step = HAZARD_START_STEP_S > 0 ? HAZARD_START_STEP_S : 30;
  const steps = Math.max(0, Math.floor((HAZARD_START_MAX_S - HAZARD_START_MIN_S) / step));
  const i = Math.min(steps, Math.floor(roll * (steps + 1)));
  return HAZARD_START_MIN_S + i * step;
}

/* ── this raid's hazard plan ──────────────────────────────────────────────────────────────────────
 * **A function of the mission seed + the planet's candidates only.** That is why there is no wire in normal play —
 * every client answers the same (the same philosophy as fog). Only a late joiner takes this whole plan by `hzq sync`. */

/** One spore source = the spot of a **giant mushroom grove** on the terrain. */
export interface SporeSource {
  x: number;
  z: number;
  /** The `missionTime` (s) it starts blooming. Each source is pushed back by `SPORE_SOURCE_INTERVAL_S`. */
  eruptAt: number;
  /**
   * How fast this source's radius grows (m/s). Normally `SPORE_GROWTH_MPS`; a source that blooms late grows
   * that much faster so it still reaches `sourceRadius` within `HAZARD_FULL_S` (the map is guaranteed sealed).
   */
  growthMps: number;
}

export interface HazardPlan {
  kind: HazardKind;
  /** Start time (`ctx.missionTime` seconds). */
  startsAt: number;
  /** Unit vector of the `front` travel direction ((0,0) for other hazards). */
  dirX: number;
  dirZ: number;
  /** Centre of the `storm_eye` safe circle — **fixed for the whole raid**. */
  eyeX: number;
  eyeZ: number;
  /** `spores` sources (an empty array for other hazards). */
  sources: SporeSource[];
  /**
   * Radius (m) of one fully grown source. `SPORE_RADIUS_MAX` is the floor, and the drawn arrangement is measured
   * for **the distance from any point of the map to its nearest source**, then taken larger than that —
   * only then is no safe area left at `HAZARD_FULL_S`.
   */
  sourceRadius: number;
}

/* ── Giant mushroom grove dimensions (a look matter, not csv — not balance numbers) ──────────────── */

/** Range of how many giant mushrooms one grove stands up. */
export const GROVE_CAPS_MIN = 5;
export const GROVE_CAPS_MAX = 8;
/** Grove radius (m) — the giant mushrooms scatter inside it. */
export const GROVE_RADIUS = 9;
/** Stem radius (m) range. **The stem is the only collider** (the cap is in the air — the same reason as `Props`' trees). */
export const GROVE_STEM_R_MIN = 0.42;
export const GROVE_STEM_R_MAX = 0.95;
/** Stem height (m) range. */
export const GROVE_STEM_H_MIN = 4.2;
export const GROVE_STEM_H_MAX = 9.0;
/** Cap radius = stem radius × the range of this multiplier. */
export const GROVE_CAP_MUL_MIN = 3.4;
export const GROVE_CAP_MUL_MAX = 5.2;
/** Range of how many **harvestable mushrooms** are planted around a grove (`Gather` plants them). */
export const GROVE_PICKS_MIN = 3;
export const GROVE_PICKS_MAX = 5;
/** The ring (m) the harvest mushrooms are planted in — outside, so they do not overlap a giant stem. */
export const GROVE_PICK_RING_MIN = 4.5;
export const GROVE_PICK_RING_MAX = 13;
/** The flora variant the harvest mushrooms use (`Gather`'s number 1 = 포자균 갓). */
export const GROVE_PICK_VARIANT = 1;

/* ── progress · emit intervals ─────────────────────────────────────────────────────────────────── */

/** `hazard:progress` emit interval (s). The contract nails it down as "a few times per second" — not every frame. */
export const PROGRESS_EMIT_S = 0.4;
/** Smallest change (in blend) that re-emits `atmo:override`. A smaller wobble is not sent. */
export const ATMO_EPS = 0.02;
