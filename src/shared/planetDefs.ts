/**
 * 행성 정의표 — 수치의 원본은 `data/planets.csv` 다.
 *
 * `planets.ts` 와 갈라져 있는 이유: 릴레이 서버(`server/`)가 `planets.ts` 를 **Node 에서 직접** 실행한다
 * (`isPlanetId` 하나 때문에). 이 파일은 csv 를 읽으므로 Vite 번들 안에서만 살 수 있고, 서버는 여기를
 * 건드리지 않는다. 두 파일 모두 `@/shared` 배럴로 나가므로 게임 코드에서는 차이가 보이지 않는다.
 */
import type { EnemyType } from './types';
import type { PlanetId } from './planets';
import { PLANET_IDS, PLANET_NONE_LABEL } from './planets';
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
  /** 위협 등급 1..3. A terminal badge only: the real ramp is still mission time (`setThreatLevel`). */
  threat: 1 | 2 | 3;
  /** `world/biomes.ts` `Biome.id` this planet's ground uses. */
  biome: string;
  /** `core/Sky.ts` `SkyPalette.name` this planet's sky uses. */
  sky: string;
  /** false = 포그 없는 맑은 하늘: core forces `fog.density = 0` and backs the sky with its horizon colour. */
  fog: boolean;
  /** Multiplier on the sky palette's own `fogDensity` while `fog` (1 = exactly as the palette ships it). */
  fogMul: number;
  /** Hologram sphere colour and its atmosphere shell (hex; `hub/interiors/Starfield.ts` `Planet` takes both). */
  hologram: number;
  hologramAtmo: number;
  eco: PlanetEcosystem;
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

/** 위협 등급 badge text, indexed by `PlanetDef.threat`. */
export const PLANET_THREAT_LABELS: readonly string[] = ['', '위협 낮음', '위협 보통', '위협 높음'];
