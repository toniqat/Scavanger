/**
 * src/shared/library.ts — **서재 시리즈 · 매체 효과 · 비디오게임** 계약 (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」).
 *
 * 수치 원본: `data/library_series.csv` (시리즈 · 효과 줄 · 등장 행성) · `data/item_aliases.csv` (옛 아이템 id → 새 id).
 * 아이템 자체(권 번호 · 가치 · 무게 · 드롭)는 items/ 가 매체 csv 에서 만든다 (`ItemDef.book` / `disc` / `record` 의 `series` · `volume`,
 * `ItemDef.gameDisc` · `gameConsole`).
 *
 * 규칙 (사용자 결정):
 *  - 책 1권 = 효과 1줄 · 비디오 1장 = 2줄 · 레코드 1장 = 3줄 (`LIBRARY_EFFECT_LINES`). 효과 줄의 값은 **전권 기준**이다.
 *  - 시리즈 몫 = 전권이면 1, 아니면 꽂힌 서로 다른 권수 × `SHELF_SERIES_VOLUME_SHARE` (`librarySeriesFraction`). 같은 권 여러 장은 1 장.
 *  - 레코드는 시리즈가 없다(`volumes` 1). 게임 디스크는 효과가 없다 — 게임 디스크 전시대에 꽂아 두면 TV 로 플레이할 수 있을 뿐.
 *  - 한 시리즈는 정해진 행성에서만 나온다 (`planets`). 레코드 · 게임 디스크는 threat 2 이상 행성에서만, 아주 드물게.
 *
 * ⚠ 이 파일은 `./housing` · `./types` 를 **타입으로만** 가져온다 (`./types` 의 `MEAL_BUFFS` 만 값) — 순환 import 를 만들지 않는다.
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

/* ── 효과 ─────────────────────────────────────────────────────────────────── */

export type LibraryEffectKind = 'skillGain' | 'derived' | 'gymScore' | 'cookScore' | 'raidXp' | 'trustXp' | 'recipe';
export const LIBRARY_EFFECT_KINDS: readonly LibraryEffectKind[] = ['skillGain', 'derived', 'gymScore', 'cookScore', 'raidXp', 'trustXp', 'recipe'];

/** 헬스 보너스의 대상 — 운동 기구 4종 (벤치프레스 기구 둘은 따로 붙는다, 사용자 명세 「4종에 각각」). */
export type LibraryGymTarget = 'gym_bench_press' | 'gym_smith' | 'gym_treadmill' | 'gym_cycle';
export const LIBRARY_GYM_TARGETS: readonly LibraryGymTarget[] = ['gym_bench_press', 'gym_smith', 'gym_treadmill', 'gym_cycle'];
/** 요리 보너스의 대상 — 굽기 · 볶기 · 썰기 · 다지기만 (사용자 명세). */
export type LibraryCookTarget = 'chop' | 'mince' | 'grill' | 'stirfry';
export const LIBRARY_COOK_TARGETS: readonly LibraryCookTarget[] = ['chop', 'mince', 'grill', 'stirfry'];
/** 신뢰도 보너스의 대상 — 모든 기업(`all`) 또는 기업 하나. */
export type LibraryTrustTarget = CorpId | 'all';
export const LIBRARY_TRUST_TARGETS: readonly LibraryTrustTarget[] = ['all', 'helix', 'bastion', 'nomad', 'ceres'];

/**
 * 효과 줄 하나. `value` 는 **전권 기준** 값이다:
 *  - `skillGain`  숙련 상승량 배율 가산 (0.1 = +10 %)
 *  - `derived`    요리 버프와 같은 단위 (`*Mul` · `gritChance` = 배수 가산, 나머지 = 단위 그대로). 즉시 적용이라 아주 작게
 *  - `gymScore`   운동 세션 점수 가산 (0 … 1)
 *  - `cookScore`  그 조리 단계 점수 가산 (0 … 1)
 *  - `raidXp`     레이드 종료 경험치 배율 가산 (target 은 빈 문자열)
 *  - `trustXp`    계약 완료 신뢰도 배율 가산 (`all` 은 네 기업 모두에 더해진다)
 *  - `recipe`     그 조리 레시피 해금 (`value` 는 쓰지 않는다 — 1). 책 전용 · 단편 · **꽂혀 있는 동안만**
 */
export type LibraryEffect =
  | { kind: 'skillGain'; target: SkillId; value: number }
  | { kind: 'derived'; target: MealBuff; value: number }
  | { kind: 'gymScore'; target: LibraryGymTarget; value: number }
  | { kind: 'cookScore'; target: LibraryCookTarget; value: number }
  | { kind: 'raidXp'; target: ''; value: number }
  | { kind: 'trustXp'; target: LibraryTrustTarget; value: number }
  | { kind: 'recipe'; target: string; value: number };

/** 서재 효과를 내는 매체 (게임 디스크 제외). `ShelfMedium` 의 부분집합. */
export type LibraryMedium = 'book' | 'disc' | 'record';
/** 매체 한 개가 가진 효과 줄 수 (사용자 결정 「한 장이 여러 대상 동시」). */
export const LIBRARY_EFFECT_LINES: Readonly<Record<LibraryMedium, number>> = { book: 1, disc: 2, record: 3 };
/** 매체별 최대 권 수 — 책 V · 비디오 III · 레코드 단편 (사용자 명세). */
export const LIBRARY_MAX_VOLUMES: Readonly<Record<LibraryMedium, number>> = { book: 5, disc: 3, record: 1 };

export interface LibrarySeriesDef {
  id: string;
  medium: LibraryMedium;
  /** 시리즈 이름 (권 번호 없이 — 아이템 이름은 items 가 `이름 II` 처럼 붙인다). */
  name: string;
  /** 권 수 (1 = 단편). */
  volumes: number;
  /** 이 시리즈가 나오는 행성. */
  planets: readonly PlanetId[];
  /** 전권 기준 효과 줄 (`LIBRARY_EFFECT_LINES[medium]` 개). */
  effects: readonly LibraryEffect[];
  description: string;
}

const isIn = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

/** `kind:target:value` 한 줄을 읽는다 (`raidXp::0.1` · `recipe:cook_x:`). 틀리면 `report` 하고 null. */
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

/** `data/library_series.csv` — 시리즈 전부 (파일 순서). */
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

/** 시리즈 몫 — 전권이면 1, 아니면 `have × SHELF_SERIES_VOLUME_SHARE` (0 … 1 미만). */
export function librarySeriesFraction(have: number, total: number): number {
  if (!(total > 0) || !(have > 0)) return 0;
  if (have >= total) return 1;
  return Math.min(1, Math.floor(have) * SHELF_SERIES_VOLUME_SHARE);
}

/** 서재 효과 합산 (`HousingRef.getLibraryEffects`). 값은 전부 **더할 양**이다 (배율이면 1 을 더해서 쓴다). */
export interface LibraryEffectsSummary {
  skillGain: Readonly<Partial<Record<SkillId, number>>>;
  derived: Readonly<Partial<Record<MealBuff, number>>>;
  gymScore: Readonly<Partial<Record<LibraryGymTarget, number>>>;
  cookScore: Readonly<Partial<Record<LibraryCookTarget, number>>>;
  raidXp: number;
  trustXp: Readonly<Partial<Record<LibraryTrustTarget, number>>>;
  /** 지금 열려 있는 조리 레시피 id. */
  recipes: readonly string[];
  /** 합산이 바뀔 때마다 오른다 (`housing:libraryChanged.revision`). */
  revision: number;
}

export const EMPTY_LIBRARY_EFFECTS: LibraryEffectsSummary = Object.freeze({
  skillGain: {}, derived: {}, gymScore: {}, cookScore: {}, raidXp: 0, trustXp: {}, recipes: [], revision: 0,
});

/** 기업 `corp` 의 계약 신뢰도 배율 — `1 + trustXp.all + trustXp[corp]`. */
export function libraryTrustMul(e: LibraryEffectsSummary | null | undefined, corp: CorpId): number {
  if (!e) return 1;
  return 1 + (e.trustXp.all ?? 0) + (e.trustXp[corp] ?? 0);
}

/** 한 효과 대상에 값을 주는 시리즈 하나 (`HousingRef.getLibrarySources`). */
export interface LibrarySourceInfo {
  seriesId: string;
  name: string;
  medium: LibraryMedium;
  /** 작동 중인 보관함에 꽂힌 서로 다른 권 수. */
  have: number;
  total: number;
  /** `librarySeriesFraction(have, total)`. */
  fraction: number;
  /** 이 대상에 실제로 더해지는 값 (시리즈 몫 · 보조 가구 배율까지). */
  value: number;
  /** 전권 기준 값 (효과 줄 그대로). */
  fullValue: number;
  /** 그 매체의 보조 가구 배율이 걸렸는가. */
  auxApplied: boolean;
  /** 꽂혀 있는 권의 item def id. */
  defIds: readonly string[];
}

/* ── 비디오게임 ───────────────────────────────────────────────────────────── */

/** 게임으로 단련하는 능력치 (`GymStat` 의 부분집합). */
export type GameStat = Extract<StatId, 'intelligence' | 'perception'>;
export const GAME_STATS: readonly GameStat[] = ['intelligence', 'perception'];

/**
 * 게임 디스크마다 다른 판정 튜닝 (사용자 결정 「헬스 3종 + 디스크별 튜닝」). 전부 생략 가능 — 생략 = 헬스와 같다.
 *  - `speedMul`  벤치프레스형 커서 속도 × · 박자형 박자 간격 ÷ (클수록 빠르다)
 *  - `windowMul` 성공 · 완벽 구역(벤치프레스) · 판정 창(박자형) × (작을수록 어렵다)
 *  - `countMul`  판정 횟수 × (반올림, 최소 1)
 *  - `pattern`   박자형 표식 패턴 — 토큰을 `-` 로 잇는다. 호흡형 = `t`(탭) · `h`(꾹) · `r`(한 박 쉼), 사이클형 = `L` · `R` · `r`.
 *                패턴을 판정 횟수만큼 반복한다. 비우면 헬스 기본(후-후-하 / L-R 번갈아).
 */
export interface GymGameTuning {
  speedMul?: number;
  windowMul?: number;
  countMul?: number;
  pattern?: string;
}

/** 게임기 아이템 (`ItemDef.gameConsole`). `console` 이 게임 디스크의 `console` 과 같아야 플레이된다. */
export interface GameConsoleDef {
  console: string;
}

/** 게임 디스크 아이템 (`ItemDef.gameDisc`). */
export interface GameDiscDef {
  /** 필요한 게임기 종류 (`GameConsoleDef.console`). */
  console: string;
  stat: GameStat;
  minigame: GymMinigame;
  tuning: GymGameTuning;
  /** 게임 화면 · TV 화면의 테마 색 (`#rrggbb`). */
  color: string;
}

/** 진행 중인 게임 세션 (`HousingRef.gameSession`). */
export interface GameSessionInfo {
  tvUid: string;
  seatUid: string;
  discDefId: string;
  stat: GameStat;
  minigame: GymMinigame;
}

/** TV 화면의 게임 목록 한 줄 (`HousingRef.getPlayableGames`). */
export interface PlayableGameInfo {
  defId: string;
  /** 꽂혀 있는 게임 디스크 전시대. */
  standUid: string;
  /**
   * 이 디스크를 고를 수 없는 한국어 사유 (게임기 없음 · 게임기 불일치 · 전시대가 작동하지 않음), 되면 null.
   * 좌석은 TV 한 대의 문제라 `tvSeatBlock` 이 따로 답하고, 디버프는 사유가 아니다 — 경험치 0 으로 플레이는 된다 (헬스와 같다).
   */
  block: string | null;
}

/** TV 를 볼 수 있는 좌석 가구의 interaction — 의자 · 쇼파(`seat`) · 흔들의자. */
export const SEAT_INTERACTIONS: readonly FurnitureInteraction[] = ['seat', 'rocking_chair'];

/* ── 옛 아이템 id (사용자 결정: 기존 책 · 디스크 · 레코드 → 새 시리즈 1권) ───── */

/** `data/item_aliases.csv` — 옛 def id → 새 def id. 세이브 · 와이어에서 아이템 id 를 읽는 곳이 `resolveItemAlias` 를 지난다. */
export const ITEM_ALIASES: ReadonlyMap<string, string> = new Map(csvRows('item_aliases.csv').map((r) => [r.str('from'), r.str('to')] as const));

/** 옛 id 면 새 id, 아니면 그대로. */
export function resolveItemAlias(defId: string): string {
  return ITEM_ALIASES.get(defId) ?? defId;
}
