/**
 * Planet definition table — the source of the numbers is `data/planets.csv`.
 *
 * Why it is split from `planets.ts`: the relay server (`server/`) runs `planets.ts` **directly in Node** (for
 * `isPlanetId` alone). This file reads csv, so it can only live inside the Vite bundle, and the server never
 * touches it. Both files go out through the `@/shared` barrel, so game code sees no difference.
 */
import type { EnemyType, EnvKind, HazardKind } from './types';
import { ENV_KINDS, HAZARD_KINDS } from './types';
import type { PlanetId } from './planets';
import { PLANET_IDS, PLANET_NONE_LABEL, TUTORIAL_PLANET_LABEL } from './planets';
import { csvRows } from './data/tables';

export interface PlanetEcosystem {
  bugs: Partial<Record<EnemyType, number>>;
  /** Multiplier on the ambient population cap (`AmbientSpawner.cap`, today `12 + 24 * threat`). */
  pressure: number;
  /** Multiplier on rogue-guard density (`enemies/RogueGuards.placeRogueGuards`). 0 = a planet with no raiders. */
  rogues: number;
  /** true = the boss squad is always placed while `rogues > 0`; false = only when the seed happens to roll one. */
  boss: boolean;
  /** Per-planet ceilings that used to be the module constants `MAX_ARTILLERY` / `MAX_BEHEMOTH` in `Spawner.ts`. */
  maxArtillery: number;
  maxBehemoth: number;
  /** Relative weights by herb item def id (`world/Gather.ts`). An id the items folder does not know is ignored. */
  herbs: Readonly<Record<string, number>>;
  /** Multiplier on `GATHER_NODES_PER_MISSION`. */
  gatherDensity: number;
}

export interface PlanetDef {
  id: PlanetId;
  /** Planet name shown at the terminal, on the HUD and on the result screen (Korean). */
  name: string;
  /** Terrain line under the name — the `world/biomes.ts` entry's own Korean name. */
  terrain: string;
  /** One-line Korean brief at the terminal. */
  brief: string;
  /** Threat rating 1..3. A terminal badge only: the real ramp is still mission time (`setThreatLevel`). */
  threat: 1 | 2 | 3;
  /** `world/biomes.ts` `Biome.id` this planet's ground uses. */
  biome: string;
  /** `core/Sky.ts` `SkyPalette.name` this planet's sky uses. */
  sky: string;
  /** false = a clear sky with no fog: core forces `fog.density = 0` and backs the sky with its horizon colour. */
  fog: boolean;
  /** Multiplier on the sky palette's own `fogDensity` while `fog` (1 = exactly as the palette ships it). */
  fogMul: number;
  /** Hologram sphere colour and its atmosphere shell (hex; `hub/interiors/Starfield.ts` `Planet` takes both). */
  hologram: number;
  hologramAtmo: number;
  eco: PlanetEcosystem;
  /**
   * appended (2026-09-09): the **environmental hazard candidates** of this planet. A raid draws one of them from
   * the mission seed (the `hazards` column of `data/planets.csv`, joined with `|`). Empty = a planet with no
   * hazard (`WorldRef.hazard` is null). An unknown name is dropped silently — one typo in a row must not break
   * a raid.
   */
  hazards: readonly HazardKind[];
  /**
   * appended (lab A-13, 2026-09-11, user's decision): this planet's **permanent environment** — the `env` column
   * of `data/planets.csv`, null when the cell is empty (= most planets). Being in a raid without the matching
   * preparation (`ItemDef.prep`) keeps draining hp at `PLANET_ENV_DPS` — a **soft gate** that never blocks entry
   * itself, and a preparation cancels it 100 %. Today only two threat-3 planets have one (`피로스 VII` heat ·
   * `카민 I` toxic).
   */
  env: EnvKind | null;
}

/**
 * The five planets — `data/planets.csv`. Hologram colours mirror each biome's dominant ground tone, so the sphere
 * at the terminal reads as the place the squad will land on.
 */

export const PLANET_DEFS: readonly PlanetDef[] = csvRows('planets.csv').map((r) => ({
  id: r.str('id') as PlanetId,
  name: r.str('name'),
  terrain: r.str('terrain'),
  brief: r.str('brief'),
  threat: r.int('threat', { min: 1, max: 3 }) as 1 | 2 | 3,
  biome: r.str('biome'),
  sky: r.str('sky'),
  fog: r.bool('fog'),
  fogMul: r.num('fogMul', { min: 0 }),
  hologram: r.num('hologram'),
  hologramAtmo: r.num('hologramAtmo'),
  hazards: r.list('hazards').filter((h): h is HazardKind => (HAZARD_KINDS as readonly string[]).includes(h)),
  env: r.optEnum('env', ENV_KINDS) ?? null,
  eco: {
    bugs: Object.fromEntries(r.costList('bugs').map((c) => [c.defId, c.qty])) as Partial<Record<EnemyType, number>>,
    pressure: r.num('pressure', { min: 0 }),
    rogues: r.num('rogues', { min: 0 }),
    boss: r.bool('boss'),
    maxArtillery: r.int('maxArtillery', { min: 0 }),
    maxBehemoth: r.int('maxBehemoth', { min: 0 }),
    herbs: Object.fromEntries(r.costList('herbs').map((c) => [c.defId, c.qty])),
    gatherDensity: r.num('gatherDensity', { min: 0 }),
  },
}));

const PLANET_BY_ID = new Map<string, PlanetDef>(PLANET_DEFS.map((p) => [p.id, p]));

/** The def, or undefined for null / an unknown id (an older peer, a hand-edited save). Never throws. */
export function getPlanet(id: PlanetId | string | null | undefined): PlanetDef | undefined {
  return id == null ? undefined : PLANET_BY_ID.get(id);
}

/** Terminal cursor position of a planet (its index in `PLANET_IDS`); 0 when unknown. */
export function planetIndex(id: PlanetId | null | undefined): number {
  const i = id == null ? -1 : PLANET_IDS.indexOf(id);
  return i < 0 ? 0 : i;
}

/** Display name for a planet id — `PLANET_NONE_LABEL` when nothing is selected, so every readout agrees. */
export function planetLabel(id: PlanetId | null | undefined): string {
  return getPlanet(id)?.name ?? PLANET_NONE_LABEL;
}

/**
 * appended (2026-09-16): **this mission's** planet name — `TUTORIAL_PLANET_LABEL` for the tutorial
 * (`ctx.missionMode === 'tutorial'`), else `planetLabel`. Read by the result screens (extraction · death). Why the
 * argument is a mode string: the server reads this file too, so it does not import `GameContext`.
 */
export function missionPlanetLabel(mode: string | null | undefined, id: PlanetId | null | undefined): string {
  return mode === 'tutorial' ? TUTORIAL_PLANET_LABEL : planetLabel(id);
}

/**
 * appended (2026-09-09): **planet difficulty rank 1..5** — the row order of `data/planets.csv` *is* the difficulty
 * order (1 = `아켈론 II` … 5 = `카민 I`). The weapon-grade drop curve (`data/planet_loot.csv`) finds its row by
 * this number. With no planet selected it is 1 (treated like the first planet — the stingiest curve).
 */
export function planetTier(id: PlanetId | null | undefined): number {
  const i = id == null ? -1 : PLANET_IDS.indexOf(id);
  return i < 0 ? 1 : i + 1;
}

/**
 * appended (2026-09-13): **enemy difficulty = the planet's threat 1..3** (user's decision). It decides which
 * humanoid faction appears — 1 = android · 2 = rogue / raider · 3 = raider only (`enemies/` site occupation ·
 * raider drops · named). 1 with no planet selected or for an unknown id.
 */
export function planetThreat(id: PlanetId | null | undefined): 1 | 2 | 3 {
  return getPlanet(id)?.threat ?? 1;
}

/** Threat rating badge text, indexed by `PlanetDef.threat`. */
export const PLANET_THREAT_LABELS: readonly string[] = ['', '위협 낮음', '위협 보통', '위협 높음'];
