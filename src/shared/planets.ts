import type { EnemyType } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Planets (Phase 11, 2026-09-07).
 *
 * A mission is still generated from a **random seed** — the seed decides layout, crates, nests, rogue-guard
 * placement and loot. What the player now picks at the terminal is the **planet**: the terrain palette, the sky,
 * whether there is fog at all, and the ecosystem (which enemies live here, how many, which herbs grow).
 *
 * Before Phase 11 both of those came from the seed as well (`world/biomes.pickBiome(seed)` and
 * `core/Atmosphere.applySeed(seed)`, paired only by the implicit "both lists have exactly 5 entries" rule). A planet
 * makes the pairing **explicit**: `PlanetDef.biome` names the `world/biomes.ts` entry and `PlanetDef.sky` names the
 * `core/Sky.ts` `SKY_PALETTES` entry, so neither list can reorder the other into a mismatch again. With no planet
 * selected (an older peer, `game:newMission` without the field) both fall back to the seeded draw exactly as before.
 *
 * This file is imported by the browser AND the Node server (type-only there) — no runtime deps.
 * Owner: shared/. `world/` reads `biome` + `eco.herbs` + `eco.gatherDensity`, `core/` reads `sky` / `fog` / `fogMul`,
 * `enemies/` reads `eco`, `hub/` reads everything for the terminal, `ui/` reads the labels.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Planet ids double as their `world/biomes.ts` biome id — one planet per biome in this build. */
export type PlanetId = 'amber' | 'tundra' | 'mossy' | 'ashen' | 'crimson';

/** Terminal order (left <-> right at the hologram) and the wire order. Never reorder; append only. */
export const PLANET_IDS: readonly PlanetId[] = ['amber', 'tundra', 'mossy', 'ashen', 'crimson'];

/**
 * Who lives here. Every number is a **re-weighting of existing content** — Phase 11 adds no enemy type and no item.
 *
 * `bugs` are relative weights for the composition tables in `enemies/Spawner.ts` (`ambientGroup` / `waveGroup`):
 * a type absent from the map (or 0) never spawns on this planet, and the existing threat gates still apply on top
 * (a `charger` weight does nothing until mission threat has ramped far enough to allow chargers at all), so the
 * difficulty curve is unchanged — only *which* silhouettes fill it.
 */
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
 * The five planets. Hologram colours mirror each biome's dominant ground tone, so the sphere at the terminal reads
 * as the place the squad will land on.
 */
export const PLANET_DEFS: readonly PlanetDef[] = [
  {
    id: 'amber', name: '아켈론 II', terrain: '호박빛 사막', threat: 1,
    brief: '모래에 묻힌 채굴 전초. 벌레는 드물지만 약탈자 거점이 촘촘하다.',
    biome: 'amber', sky: 'amber-dusk', fog: true, fogMul: 1,
    hologram: 0xb89a68, hologramAtmo: 0xffc98a,
    eco: {
      bugs: { scavenger: 4, hunter: 2, warrior: 1, artillery: 1 },
      pressure: 0.85, rogues: 1.4, boss: true, maxArtillery: 1, maxBehemoth: 0,
      herbs: { herb_ashleaf: 3, herb_bloodroot: 1, herb_glowcap: 0.5 }, gatherDensity: 0.7,
    },
  },
  {
    id: 'tundra', name: '보레아스 IX', terrain: '동토 툰드라', threat: 2,
    brief: '얼어붙은 평원. 무리 사냥꾼이 시야 밖에서 달려든다.',
    biome: 'tundra', sky: 'cold-blue', fog: true, fogMul: 1.15,
    hologram: 0xcbd0cc, hologramAtmo: 0x9ad8ff,
    eco: {
      bugs: { scavenger: 3, hunter: 4, charger: 2, warrior: 2 },
      pressure: 1, rogues: 0.8, boss: false, maxArtillery: 1, maxBehemoth: 1,
      herbs: { herb_bloodroot: 2, herb_ashleaf: 2, herb_glowcap: 1 }, gatherDensity: 0.9,
    },
  },
  {
    id: 'mossy', name: '베르단트 III', terrain: '이끼 습지', threat: 2,
    brief: '포자로 뿌연 습지. 산성 개체가 많고 약초가 무성하다.',
    biome: 'mossy', sky: 'toxic-green', fog: true, fogMul: 1.3,
    hologram: 0x66683c, hologramAtmo: 0x5affb0,
    eco: {
      bugs: { scavenger: 4, spewer: 3, toxic: 3, warrior: 2, hunter: 1 },
      pressure: 1.15, rogues: 0.6, boss: false, maxArtillery: 1, maxBehemoth: 1,
      herbs: { herb_bloodroot: 3, herb_glowcap: 3, herb_ashleaf: 1 }, gatherDensity: 1.5,
    },
  },
  {
    id: 'ashen', name: '피로스 VII', terrain: '잿빛 화산지대', threat: 3,
    brief: '재가 내리는 용암 지대. 중장갑 개체와 포격이 상시 압박한다.',
    biome: 'ashen', sky: 'rust-storm', fog: true, fogMul: 1.25,
    hologram: 0x4c4c4e, hologramAtmo: 0xff7a1a,
    eco: {
      bugs: { scavenger: 3, warrior: 3, charger: 3, behemoth: 1, artillery: 2 },
      pressure: 1.2, rogues: 1, boss: true, maxArtillery: 3, maxBehemoth: 2,
      herbs: { herb_ashleaf: 3, herb_glowcap: 1 }, gatherDensity: 0.6,
    },
  },
  {
    id: 'crimson', name: '카민 I', terrain: '적색 외계 평원', threat: 3,
    brief: '포그 없는 맑은 하늘 — 멀리까지 보이고, 저쪽에서도 이쪽이 보인다.',
    biome: 'crimson', sky: 'pale-noon', fog: false, fogMul: 1,
    hologram: 0x8e3c4c, hologramAtmo: 0xff5ad0,
    eco: {
      bugs: { scavenger: 2, hunter: 3, spewer: 2, warrior: 2, artillery: 2 },
      pressure: 0.9, rogues: 1.6, boss: true, maxArtillery: 2, maxBehemoth: 1,
      herbs: { herb_glowcap: 4, herb_bloodroot: 2 }, gatherDensity: 1,
    },
  },
];

const PLANET_BY_ID = new Map<string, PlanetDef>(PLANET_DEFS.map((p) => [p.id, p]));

export function isPlanetId(v: unknown): v is PlanetId {
  return typeof v === 'string' && PLANET_BY_ID.has(v);
}

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

export const PLANET_NONE_LABEL = '목표 미지정';
/** 위협 등급 badge text, indexed by `PlanetDef.threat`. */
export const PLANET_THREAT_LABELS: readonly string[] = ['', '위협 낮음', '위협 보통', '위협 높음'];

/** localStorage key of the last planet the player picked (hub-owned, client-local; absent = never picked). */
export const PLANET_STORAGE_KEY = 'scav.planet';
