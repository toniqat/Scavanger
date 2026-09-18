/**
 * src/world/structures/model.ts — the **vocabulary** structure · rail parts share. It holds no state at all.
 *
 * Every number is in `data/structures.csv` (counts · sizes · container counts · basement chance · crate tier weights).
 * The same number is never written in code — this file is the only place that reads that table into types.
 * `data:check`'s orphan check reads `structures.csv` through this module (`DATA_OWNERS` in `scripts/data-check.mjs`).
 *
 * ⚠ THREE is never used **as a value** here (`layout.ts` and `data:check` both read this file very early).
 */
import { type CsvRow, type StructureKind, addDataIssue, csvRows } from '@/shared';
/* 2026-09-15 (thumper): validates the planet list of the basement bonus roll */
import { PLANET_IDS, type PlanetId } from '@/shared';

/** The values the csv `kind` column may hold. 3 structures + 2 rail parts. */
export type StructureRowKind = StructureKind | 'rail_platform' | 'tram';

/** One crate tier weight entry (`"2:6|3:3"` → `[{tier:2, weight:6}, …]`). */
export interface TierWeight { tier: number; weight: number }

/** One row of `data/structures.csv`. */
export interface StructureRow {
  kind: StructureRowKind;
  /** Korean name (prompt · toast). */
  label: string;
  minCount: number;
  maxCount: number;
  /** Floor half-length (m). For a tram it is the body's half-length. */
  halfW: number;
  halfD: number;
  wallH: number;
  /** Minimum distance (m) it must keep from another structure · the spawn · an extraction pad. */
  minGap: number;
  containers: number;
  basementChance: number;
  basementDepth: number;
  basementContainers: number;
  tiers: readonly TierWeight[];
  basementTiers: readonly TierWeight[];
  /** Chance a second floor goes up (2026-09-11). 0 = always single-storey (crash-landed ship · rail parts). */
  upperChance: number;
  /**
   * 2026-09-12 — the item id that opens this kind's locked door, and the bonus key in its ground-floor containers
   * (`key_basement` · `keycard_lab`). null = no locked door and no bonus key.
   */
  key: string | null;
  /** The chance each ground-floor container holds `key` as a bonus (never guaranteed). */
  keyChance: number;
  /** Container count range of the floor-2 locked room (0 = no locked room). The room only stands in a building that got a second floor. */
  lockedMin: number;
  lockedMax: number;
  lockedTiers: readonly TierWeight[];
  /* ── appended 2026-09-15 (sandworm · thumper, owner: gadgets — the bonus roll of basement containers) ── */
  /** The item id (`gad_thumper`) each basement container may hold as a bonus at `basementBonusChance`. null = none. */
  basementBonus: string | null;
  basementBonusChance: number;
  /** Rolled only on these planets (`data/planets.csv` ids). Empty = every planet. */
  basementBonusPlanets: readonly PlanetId[];
}

const ROW_KINDS: readonly StructureRowKind[] = ['outpost', 'lab', 'wreck', 'rail_platform', 'tram'];

function tierList(raw: CsvRow, column: string): TierWeight[] {
  return raw.costList(column)
    .map((c) => ({ tier: Number(c.defId), weight: c.qty }))
    .filter((t) => Number.isFinite(t.tier) && t.tier >= 1 && t.tier <= 4 && t.weight > 0);
}

/** All of `data/structures.csv`. Row order = the order placement is attempted in. */
export const STRUCTURE_ROWS: readonly StructureRow[] = csvRows('structures.csv').map((r) => {
  const kind = r.str('kind') as StructureRowKind;
  if (!ROW_KINDS.includes(kind)) r.report('kind', `'${kind}' 는 ${ROW_KINDS.join(' | ')} 중 하나여야 한다`);
  const lockedMin = r.int('lockedMin', { min: 0, fallback: 0 });
  const lockedMax = r.int('lockedMax', { min: 0, fallback: 0 });
  if (lockedMax < lockedMin) r.report('lockedMax', `lockedMax ${lockedMax} 이 lockedMin ${lockedMin} 보다 작다`);
  return {
    kind,
    label: r.str('label'),
    minCount: r.int('minCount', { min: 0 }),
    maxCount: r.int('maxCount', { min: 0 }),
    halfW: r.num('halfW', { min: 0 }),
    halfD: r.num('halfD', { min: 0 }),
    wallH: r.num('wallH', { min: 0 }),
    minGap: r.num('minGap', { min: 0 }),
    containers: r.int('containers', { min: 0 }),
    basementChance: r.num('basementChance', { min: 0, max: 1 }),
    basementDepth: r.num('basementDepth', { min: 0 }),
    basementContainers: r.int('basementContainers', { min: 0 }),
    tiers: tierList(r, 'tiers'),
    basementTiers: tierList(r, 'basementTiers'),
    upperChance: r.num('upperChance', { min: 0, max: 1 }),
    key: r.optStr('key') ?? null,
    keyChance: r.num('keyChance', { min: 0, max: 1, fallback: 0 }),
    lockedMin,
    lockedMax: Math.max(lockedMin, lockedMax),
    lockedTiers: tierList(r, 'lockedTiers'),
    basementBonus: r.optStr('basementBonus') ?? null,
    basementBonusChance: r.num('basementBonusChance', { min: 0, max: 1, fallback: 0 }),
    basementBonusPlanets: r.list('basementBonusPlanets').filter((p) => {
      if ((PLANET_IDS as readonly string[]).includes(p)) return true;
      r.report('basementBonusPlanets', `행성 '${p}' 를 모른다 (${PLANET_IDS.join(' · ')})`);
      return false;
    }) as PlanetId[],
  };
});

const BY_KIND = new Map<StructureRowKind, StructureRow>();
for (const row of STRUCTURE_ROWS) {
  if (BY_KIND.has(row.kind)) addDataIssue({ file: 'structures.csv', line: 0, column: 'kind', message: `'${row.kind}' 가 중복이다` });
  else BY_KIND.set(row.kind, row);
}

/** Finds one row. Asking for a kind that does not exist leaves an issue for `data:check` to catch and returns undefined. */
export function structureRow(kind: StructureRowKind): StructureRow | undefined {
  const row = BY_KIND.get(kind);
  if (!row) addDataIssue({ file: 'structures.csv', line: 0, column: kind, message: `'${kind}' 줄이 없다` });
  return row;
}

/** One crate tier by weight. Tier 1 when the table is empty. */
export function pickTier(tiers: readonly TierWeight[], roll: number): number {
  let total = 0;
  for (const t of tiers) total += t.weight;
  if (total <= 0) return 1;
  let r = roll * total;
  for (const t of tiers) { r -= t.weight; if (r <= 0) return t.tier; }
  return tiers[tiers.length - 1].tier;
}

/* ── Building dimensions (a drawing matter, so they stay out of csv — they are not balance numbers) ─────────── */

/** Wall thickness (m). The collider's `halfZ` is half of it. */
export const WALL_T = 0.42;
/** Doorway width (m). */
export const DOOR_W = 2.6;
/**
 * 2026-09-11 — stairs are a **ramp collider** (`Obstacle.ramp`, `parts/Stairs`). The old `STAIR_HALF` ·
 * `STAIR_RISE_MAX` · `STAIR_TREAD_MIN` sized the steps so that "one step does not become a wall" and are gone.
 */
/** Stair slope (rise ÷ horizontal run). 0.7 ≈ 35°. */
export const STAIR_SLOPE = 0.7;
/** Drawn height of one step (m) — drawing only, unrelated to the collider. */
export const STAIR_STEP_RISE = 0.3;
/** Width of the indoor floor 1 → 2 stairs (m). */
export const STAIR_W = 1.7;
/**
 * 2026-09-12 — length of the **landing** at the stairs' lower end on floor 1 (m, partition face → first step). It used
 * to be 0.8 m, narrower than a body's diameter (0.9 m), so the stairs could not be entered from floor 1 (the one where
 * the stairs were visible looking down from floor 2 but walled off on floor 1).
 */
export const STAIR_LANDING = 1.6;
/** Arrival clearance (m) kept between the stairs' upper end on floor 2 and the outer wall. */
export const STAIR_ARRIVAL = 1.3;
/**
 * 2026-09-12 — the **approach depth** (m) kept clear inside every opening (front door · partition passage · collapsed
 * breach · basement stair entry). Anything that blocks (the stair-hole railing, the stair solid) does not pick a spot
 * overlapping that rectangle (the placement decisions in `parts/Build`).
 */
export const OPENING_APPROACH = 1.6;
/** Thickness (m) of the floor plate between levels (= the lower level's ceiling · the roof). The floor-1
 * plate has the same thickness and so becomes the basement ceiling. */
export const SLAB_T = 0.5;
/** Door height (m). Above it is the lintel wall (with a ceiling present a door is a hole in the wall). */
export const DOOR_H = 2.5;
/** Window width · sill height · top-edge height · glass thickness (m, measured from the level's floor). */
export const WINDOW_W = 1.5;
export const WINDOW_SILL = 1.0;
export const WINDOW_TOP = 2.4;
export const GLASS_T = 0.05;
/** Roof parapet height (m). */
export const PARAPET_H = 1.0;
/** Height · thickness (m) of the railing around the stair hole and the roof hatch. */
export const RAIL_H = 1.0;
export const RAIL_T = 0.12;
/** Width · depth (m) of the roof hatch hole. Sized so a body hanging on the ladder (radius 0.45) passes without touching. */
export const HATCH_W = 1.4;
export const HATCH_D = 1.2;
/** From the ladder face to the centre of the hanging body (m). */
export const LADDER_STANDOFF = 0.55;
/** Basement stair corridor half-width (m) · landing length at the stairs' end (m) · basement floor plate thickness (m). */
export const BASEMENT_HALL_HALF = 1.1;
export const BASEMENT_LANDING = 1.6;
export const BASEMENT_FLOOR_T = 0.3;
/**
 * Feather width (m) of the basement pit wall. The terrain descends into the square pit across this width
 * (`Terrain.build`). **The ceiling slab has to cover this much further out** — otherwise a 1.6 m wide trench forms
 * around the pit and a body walking indoors drops into it. `Terrain` and `structures/parts/Build` must read the same
 * value, so it lives only here.
 */
export const PIT_BLEND = 1.6;
/**
 * 2026-09-12 — inner dimensions (m) of the lab's floor-2 **locked room**. `LEN` = the length along the door wall,
 * `DEPTH` = from the door wall to the outer wall. The door wall runs, from the side-wall end,
 * [clearance `VENT_MARGIN`][vent `VENT_W`][post `VENT_POST`][door `LOCKED_DOOR_W`][the pocket inside the wall the
 * door slides into], so `LEN ≥ VENT_MARGIN + VENT_W + VENT_POST + 2 × LOCKED_DOOR_W` must hold.
 */
export const LOCKED_ROOM_LEN = 5.4;
export const LOCKED_ROOM_DEPTH = 3.4;
/** Locked room door width (m) — twice a body's diameter (0.9 m). Narrower than the basement door (the corridor width). */
export const LOCKED_DOOR_W = 1.8;
/**
 * 2026-09-12 — the **ground-drone vent** (m) at the bottom of the wall beside a locked door. Its width · height are a
 * little larger than a ground drone's body (radius 0.35 · height 0.45, `gadgets/drones/GroundDrone`), and what stops a
 * person is not the size but the **lintel** — the lintel's bottom face (floor + `VENT_H`) is lower than a person's
 * headroom (`BOX_HEADROOM`), so `resolveCollision` pushes them out. Only a body that passes a height
 * (`resolveCollision(p, r, height)`) gets through, and only when `height ≤ VENT_H`. Changing the drone's dimensions
 * means looking at these two values too.
 */
export const VENT_W = 1.0;
export const VENT_H = 0.6;
/** Clearance beside the vent · width of the post between the vent and the door (m). */
export const VENT_MARGIN = 0.3;
export const VENT_POST = 0.4;

/** Container interaction radius (m) — narrower than a crate's (2.8). They crowd indoors, so they must not mask each other. */
export const CONTAINER_RADIUS = 1.9;
/**
 * How far (m) the ground-level floor plate reaches **beyond** the wall centre line — the foundation apron around the
 * building (2026-09-10).
 *
 * Why it is needed: the terrain grid is 2 m wide while the basement pit's feather is only `PIT_BLEND` (1.6 m), so the
 * pit's perimeter drops **inside a single cell**. The terrain in the 1–2 m band inside the wall therefore sat up to
 * 1 m below the floor (measured: −1.08 m at an outpost), and stepping through the door meant falling into that trench
 * and then facing a lip over `PROP_STEP_UP_MAX` (0.9) — the building could only be entered by **jumping**. Laying the
 * plate over the whole footprint plus this width and putting its **top face exactly at `y0`** removes the threshold:
 * the walking floor is this plate, not the terrain.
 */
export const FLOOR_OVERHANG = 0.9;
/** How far (m) the drawn plate rises above the terrain. At 0 it z-fights the terrain on a flat pad. */
export const FLOOR_LIP = 0.02;

/* ── Rail corridor ──────────────────────────────────────────────────────────── */

/**
 * Half-width (m) of the rail corridor. The value's owner is `data/constants.csv` and the one place that reads it is
 * `src/shared/constants.ts` — here only the name is re-exported so call sites inside `world/` stay short.
 */
export { RAIL_CLEARANCE_M } from '@/shared';

/* ── Tram call console (2026-09-10) ───────────────────────────────────────── */

/**
 * Hold time (s) · interaction distance (m) of the platform call console. Only the name is re-exported, for the same
 * reason as `RAIL_CLEARANCE_M` — the value's owner is `data/constants.csv` and `src/shared/constants.ts` is the one
 * place that reads it.
 */
export { TRAM_CALL_HOLD_S, TRAM_CALL_RANGE } from '@/shared';
