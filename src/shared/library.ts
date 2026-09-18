/**
 * src/shared/library.ts — the **library series · media effects · video games** contract (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」).
 *
 * Source of the numbers: `data/library_series.csv` (series · effect lines · the planets they appear on) · `data/item_aliases.csv` (old item id → new id).
 * The items themselves (volume number · value · weight · drops) are built by items/ from the media csv (`series` · `volume` of `ItemDef.book` / `disc` / `record`,
 * `ItemDef.gameDisc` · `gameConsole`).
 *
 * Rules (user's decision):
 *  - 1 book volume = 1 effect line · 1 video = 2 lines · 1 record = 3 lines (`LIBRARY_EFFECT_LINES`). An effect line's value is the **full-series** one.
 *  - Series share = 1 with every volume, else the distinct volumes shelved × `SHELF_SERIES_VOLUME_SHARE` (`librarySeriesFraction`). Several copies of one volume count as one.
 *  - A record has no series (`volumes` 1). A game disc has no effect — shelving it on a game disc stand only makes it playable on the TV.
 *  - One series appears only on set planets (`planets`). Records · game discs only on planets of threat 2 or above, and very rarely.
 *
 * ⚠ This file imports `./housing` · `./types` **as types only** (only `MEAL_BUFFS` from `./types` is a value) — it creates no import cycle.
 */
import { csvRows } from './data/tables';
import { SHELF_SERIES_VOLUME_SHARE } from './constants';
import { SKILL_IDS } from './progression';
import type { SkillId, StatId } from './progression';
import { MEAL_BUFFS } from './types';
import type { MealBuff } from './types';
import type { CorpId } from './meta';
import { PLANET_IDS } from './planets';
import type { PlanetId } from './planets';
import type { FurnitureInteraction, GymMinigame } from './housing';

/* ── Effects ──────────────────────────────────────────────────────────────── */

export type LibraryEffectKind = 'skillGain' | 'derived' | 'gymScore' | 'cookScore' | 'raidXp' | 'trustXp' | 'recipe';
export const LIBRARY_EFFECT_KINDS: readonly LibraryEffectKind[] = ['skillGain', 'derived', 'gymScore', 'cookScore', 'raidXp', 'trustXp', 'recipe'];

/** What a gym bonus targets — the 4 pieces of gym equipment (the two bench-press machines get their own, user's spec 「one for each of the four」). */
export type LibraryGymTarget = 'gym_bench_press' | 'gym_smith' | 'gym_treadmill' | 'gym_cycle';
export const LIBRARY_GYM_TARGETS: readonly LibraryGymTarget[] = ['gym_bench_press', 'gym_smith', 'gym_treadmill', 'gym_cycle'];
/** What a cooking bonus targets — only grilling · stir-frying · chopping · mincing (user's spec). */
export type LibraryCookTarget = 'chop' | 'mince' | 'grill' | 'stirfry';
export const LIBRARY_COOK_TARGETS: readonly LibraryCookTarget[] = ['chop', 'mince', 'grill', 'stirfry'];
/** What a trust bonus targets — every corporation (`all`) or one corporation. */
export type LibraryTrustTarget = CorpId | 'all';
export const LIBRARY_TRUST_TARGETS: readonly LibraryTrustTarget[] = ['all', 'helix', 'bastion', 'nomad', 'ceres'];

/**
 * One effect line. `value` is the **full-series** value:
 *  - `skillGain`  added to the skill gain multiplier (0.1 = +10 %)
 *  - `derived`    the same units as a meal buff (`*Mul` · `gritChance` = added to the multiplier, the rest = the unit itself). Applied at once, so very small
 *  - `gymScore`   added to a gym session's score (0 … 1)
 *  - `cookScore`  added to that cooking step's score (0 … 1)
 *  - `raidXp`     added to the raid-end XP multiplier (target is the empty string)
 *  - `trustXp`    added to the contract-completion trust multiplier (`all` is added to all four corporations)
 *  - `recipe`     unlocks that cook recipe (`value` is unused — 1). Books only · single volume · **only while shelved**
 */
export type LibraryEffect =
  | { kind: 'skillGain'; target: SkillId; value: number }
  | { kind: 'derived'; target: MealBuff; value: number }
  | { kind: 'gymScore'; target: LibraryGymTarget; value: number }
  | { kind: 'cookScore'; target: LibraryCookTarget; value: number }
  | { kind: 'raidXp'; target: ''; value: number }
  | { kind: 'trustXp'; target: LibraryTrustTarget; value: number }
  | { kind: 'recipe'; target: string; value: number };

/** Media that produce a library effect (game discs excluded). A subset of `ShelfMedium`. */
export type LibraryMedium = 'book' | 'disc' | 'record';
/** How many effect lines one medium carries (user's decision 「one copy, several targets at once」). */
export const LIBRARY_EFFECT_LINES: Readonly<Record<LibraryMedium, number>> = { book: 1, disc: 2, record: 3 };
/** Max volumes per medium — books V · video III · records a single volume (user's spec). */
/* 2026-09-15 2nd pass (user's decision): books are **at most 3 volumes** too. This is the one source of 「books ≤ 3」, so a 4 is refused here. */
export const LIBRARY_MAX_VOLUMES: Readonly<Record<LibraryMedium, number>> = { book: 3, disc: 3, record: 1 };

export interface LibrarySeriesDef {
  id: string;
  medium: LibraryMedium;
  /** Series name (no volume number — items builds the item name like `이름 II`). */
  name: string;
  /** Volume count (1 = a single volume). */
  volumes: number;
  /** Planets this series appears on. */
  planets: readonly PlanetId[];
  /** Full-series effect lines (`LIBRARY_EFFECT_LINES[medium]` of them). */
  effects: readonly LibraryEffect[];
  description: string;
}

const isIn = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

/** Reads one `kind:target:value` line (`raidXp::0.1` · `recipe:cook_x:`). On a bad line it `report`s and returns null. */
export function parseLibraryEffect(raw: string, report: (message: string) => void): LibraryEffect | null {
  const parts = raw.trim().split(':');
  if (parts.length < 2 || parts.length > 3) { report(`효과 '${raw}' 는 kind:target:value 모양이어야 한다`); return null; }
  const [kind, target, valueText = ''] = parts.map((s) => s.trim());
  if (!isIn(LIBRARY_EFFECT_KINDS, kind)) { report(`효과 종류 '${kind}' 를 모른다 (${LIBRARY_EFFECT_KINDS.join(' · ')})`); return null; }
  const value = kind === 'recipe' ? 1 : Number(valueText);
  if (!Number.isFinite(value)) { report(`효과 '${raw}' 의 값이 숫자가 아니다`); return null; }
  switch (kind) {
    case 'skillGain': if (isIn(SKILL_IDS, target)) return { kind, target, value }; break;
    case 'derived': if (isIn(MEAL_BUFFS, target)) return { kind, target, value }; break;
    case 'gymScore': if (isIn(LIBRARY_GYM_TARGETS, target)) return { kind, target, value }; break;
    case 'cookScore': if (isIn(LIBRARY_COOK_TARGETS, target)) return { kind, target, value }; break;
    case 'raidXp': if (target === '') return { kind, target: '', value }; break;
    case 'trustXp': if (isIn(LIBRARY_TRUST_TARGETS, target)) return { kind, target, value }; break;
    case 'recipe': if (target !== '') return { kind, target, value }; break;
  }
  report(`효과 '${raw}' 의 대상 '${target}' 이 ${kind} 에 맞지 않는다`);
  return null;
}

/** `data/library_series.csv` — every series (file order). */
export const LIBRARY_SERIES_DEFS: readonly LibrarySeriesDef[] = csvRows('library_series.csv').map((r): LibrarySeriesDef => {
  const medium = r.str('medium');
  const med: LibraryMedium = isIn(['book', 'disc', 'record'] as const, medium) ? medium : 'book';
  if (med !== medium) r.report('medium', `매체 '${medium}' 는 book · disc · record 중 하나여야 한다`);
  const volumes = r.int('volumes', { min: 1, max: LIBRARY_MAX_VOLUMES[med] });
  const effects: LibraryEffect[] = [];
  for (const raw of r.str('effects').split('|')) {
    if (!raw.trim()) continue;
    const e = parseLibraryEffect(raw, (m) => r.report('effects', m));
    if (e) effects.push(e);
  }
  if (effects.length !== LIBRARY_EFFECT_LINES[med]) {
    r.report('effects', `${med} 시리즈의 효과 줄은 ${LIBRARY_EFFECT_LINES[med]} 개여야 한다 (지금 ${effects.length})`);
  }
  const planets: PlanetId[] = [];
  for (const p of r.str('planets').split('|').map((s) => s.trim()).filter(Boolean)) {
    if (isIn(PLANET_IDS, p)) planets.push(p); else r.report('planets', `행성 '${p}' 를 모른다 (${PLANET_IDS.join(' · ')})`);
  }
  if (planets.length === 0) r.report('planets', '등장 행성이 하나 이상 있어야 한다');
  return { id: r.str('id'), medium: med, name: r.str('name'), volumes, planets, effects, description: r.str('description') };
});

export const LIBRARY_SERIES_MAP: ReadonlyMap<string, LibrarySeriesDef> = new Map(LIBRARY_SERIES_DEFS.map((s) => [s.id, s]));

/** Series share — 1 with every volume, else `have × SHELF_SERIES_VOLUME_SHARE` (0 … below 1). */
export function librarySeriesFraction(have: number, total: number): number {
  if (!(total > 0) || !(have > 0)) return 0;
  if (have >= total) return 1;
  return Math.min(1, Math.floor(have) * SHELF_SERIES_VOLUME_SHARE);
}

/** The summed library effects (`HousingRef.getLibraryEffects`). Every value is an **amount to add** (a multiplier is used as 1 plus it). */
export interface LibraryEffectsSummary {
  skillGain: Readonly<Partial<Record<SkillId, number>>>;
  derived: Readonly<Partial<Record<MealBuff, number>>>;
  gymScore: Readonly<Partial<Record<LibraryGymTarget, number>>>;
  cookScore: Readonly<Partial<Record<LibraryCookTarget, number>>>;
  raidXp: number;
  trustXp: Readonly<Partial<Record<LibraryTrustTarget, number>>>;
  /** Cook recipe ids that are open right now. */
  recipes: readonly string[];
  /** Rises every time the sum changes (`housing:libraryChanged.revision`). */
  revision: number;
}

export const EMPTY_LIBRARY_EFFECTS: LibraryEffectsSummary = Object.freeze({
  skillGain: {}, derived: {}, gymScore: {}, cookScore: {}, raidXp: 0, trustXp: {}, recipes: [], revision: 0,
});

/** Contract trust multiplier of corporation `corp` — `1 + trustXp.all + trustXp[corp]`. */
export function libraryTrustMul(e: LibraryEffectsSummary | null | undefined, corp: CorpId): number {
  if (!e) return 1;
  return 1 + (e.trustXp.all ?? 0) + (e.trustXp[corp] ?? 0);
}

/** One series that gives a value to one effect target (`HousingRef.getLibrarySources`). */
export interface LibrarySourceInfo {
  seriesId: string;
  name: string;
  medium: LibraryMedium;
  /** Distinct volumes shelved in a working holder. */
  have: number;
  total: number;
  /** `librarySeriesFraction(have, total)`. */
  fraction: number;
  /** The value actually added to this target (series share · aux furniture multiplier included). */
  value: number;
  /** The full-series value (the effect line as it is). */
  fullValue: number;
  /** Whether that medium's aux furniture multiplier applied. */
  auxApplied: boolean;
  /** Item def ids of the shelved volumes. */
  defIds: readonly string[];
}

/* ── Video games ──────────────────────────────────────────────────────────── */

/** Stats a game trains (a subset of `GymStat`). */
export type GameStat = Extract<StatId, 'intelligence' | 'perception'>;
export const GAME_STATS: readonly GameStat[] = ['intelligence', 'perception'];

/**
 * Judgement tuning that differs per game disc (user's decision 「the 3 gym minigames + per-disc tuning」). All optional — omitted = the same as the gym.
 *  - `speedMul`  bench-press cursor speed × · beat-game beat interval ÷ (bigger = faster)
 *  - `windowMul` good · perfect band (bench press) · judgement window (beat games) × (smaller = harder)
 *  - `countMul`  judgement count × (rounded, minimum 1)
 *  - `pattern`   beat-game marker pattern — tokens joined by `-`. Breath type = `t` (tap) · `h` (hold) · `r` (rest one beat), cycle type = `L` · `R` · `r`.
 *                The pattern repeats for the judgement count. Empty = the gym default (후-후-하 / alternating L-R).
 */
export interface GymGameTuning {
  speedMul?: number;
  windowMul?: number;
  countMul?: number;
  pattern?: string;
}

/** A game console item (`ItemDef.gameConsole`). Its `console` must match the game disc's `console` for it to be played. */
export interface GameConsoleDef {
  console: string;
}

/** A game disc item (`ItemDef.gameDisc`). */
export interface GameDiscDef {
  /** The game console kind it needs (`GameConsoleDef.console`). */
  console: string;
  stat: GameStat;
  minigame: GymMinigame;
  tuning: GymGameTuning;
  /** Theme colour of the game screen · the TV screen (`#rrggbb`). */
  color: string;
}

/** A game session in progress (`HousingRef.gameSession`). */
export interface GameSessionInfo {
  tvUid: string;
  /** Uid of the seat being sat on. 2026-09-17 (user's decision): a seat is not a condition — null when there is no valid seat facing the TV (played standing). */
  seatUid: string | null;
  discDefId: string;
  stat: GameStat;
  minigame: GymMinigame;
}

/** One row of the TV screen's game list (`HousingRef.getPlayableGames`). */
export interface PlayableGameInfo {
  defId: string;
  /** The game disc stand it is shelved in. */
  standUid: string;
  /**
   * Korean reason this disc cannot be picked (no console · console mismatch · the stand is not working), null when it can.
   * A seat is not a reason (2026-09-17 — played standing when there is none), and neither is a debuff — it can still be played for 0 XP (the same as the gym).
   */
  block: string | null;
}

/** Interactions of seat furniture that can face a TV — chair · sofa (`seat`) · rocking chair. */
export const SEAT_INTERACTIONS: readonly FurnitureInteraction[] = ['seat', 'rocking_chair'];

/* ── Old item ids (user's decision: existing books · discs · records → volume 1 of a new series) ───── */

/** `data/item_aliases.csv` — old def id → new def id. Every place that reads an item id from a save or the wire goes through `resolveItemAlias`. */
export const ITEM_ALIASES: ReadonlyMap<string, string> = new Map(csvRows('item_aliases.csv').map((r) => [r.str('from'), r.str('to')] as const));

/** The new id for an old id, otherwise unchanged. */
export function resolveItemAlias(defId: string): string {
  return ITEM_ALIASES.get(defId) ?? defId;
}
