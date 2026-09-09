/**
 * src/world/hazard/model.ts — 환경 재해가 공유하는 **어휘**. 상태는 하나도 들고 있지 않다.
 *
 * 그림 수치(색 · 입자 밀도 · 벽 두께)는 전부 `data/hazards.csv` 다 — 이 파일이 그 표를 읽는 **유일한** 자리이고
 * `data:check` 의 고아 검사가 이 모듈을 통해 그 csv 를 읽는다 (`scripts/data-check.mjs` 의 `DATA_OWNERS`).
 * 규칙 수치(시작 시각 · 피해 · 반경 · 성장 속도)는 `data/constants.csv` 이고 `@/shared` 가 이미 읽어 준다.
 *
 * ⚠ 여기서는 THREE 를 **값으로** 쓰지 않는다 (`data:check` 가 이 모듈을 아주 이르게 읽는다 —
 *   `structures/model.ts` 와 같은 규약이다).
 */
import {
  HAZARD_KINDS, HAZARD_START_MAX_S, HAZARD_START_MIN_S, HAZARD_START_STEP_S,
  type HazardKind, addDataIssue, csvRows,
} from '@/shared';

/** `data/hazards.csv` 한 줄 — 재해 하나의 그림 수치. */
export interface HazardRow {
  kind: HazardKind;
  /** 구역 안에서 포그 · 하늘에 섞어 넣을 색 (`atmo:override.color`). */
  fogColor: number;
  particleColor: number;
  particleCount: number;
  particleSize: number;
  /** 입자 구름의 반변(m). 카메라를 따라다니며 이 상자 안에서 감긴다. */
  particleBox: number;
  driftMps: number;
  riseMps: number;
  wallColor: number;
  wallOpacity: number;
  wallHeight: number;
  /** `front` 재해의 전선 커튼 두께(m). */
  frontBandM: number;
}

/** `data/hazards.csv` 전체. */
export const HAZARD_ROWS: readonly HazardRow[] = csvRows('hazards.csv').map((r) => {
  const kind = r.str('kind') as HazardKind;
  if (!(HAZARD_KINDS as readonly string[]).includes(kind)) {
    r.report('kind', `'${kind}' 는 ${HAZARD_KINDS.join(' | ')} 중 하나여야 한다`);
  }
  return {
    kind,
    fogColor: r.num('fogColor', { min: 0 }),
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

/** 한 줄 찾기. 없는 종류를 물으면 `data:check` 가 잡도록 문제를 남기고 undefined. */
export function hazardRow(kind: HazardKind): HazardRow | undefined {
  const row = BY_KIND.get(kind);
  if (!row) addDataIssue({ file: 'hazards.csv', line: 0, column: kind, message: `'${kind}' 줄이 없다` });
  return row;
}

/** 도형이 `front`(직선 잠식)인 재해인가 — 모래 폭풍 · 눈보라. */
export function isFrontKind(kind: HazardKind): boolean {
  return kind === 'sandstorm' || kind === 'blizzard';
}

/**
 * 시작 시각을 `HAZARD_START_STEP_S`(30초) 단위로 끊어 뽑는다 — 6분 00초 · 6분 30초 … 8분 00초.
 * `roll` 은 [0,1) 하나 (호출하는 쪽이 미션 시드에서 뽑는다).
 */
export function pickStartSeconds(roll: number): number {
  const step = HAZARD_START_STEP_S > 0 ? HAZARD_START_STEP_S : 30;
  const steps = Math.max(0, Math.floor((HAZARD_START_MAX_S - HAZARD_START_MIN_S) / step));
  const i = Math.min(steps, Math.floor(roll * (steps + 1)));
  return HAZARD_START_MIN_S + i * step;
}

/* ── 이번 레이드의 재해 계획 ──────────────────────────────────────────────────────────────────────
 * **미션 시드 + 행성 후보만의 함수**다. 그래서 평상시 와이어가 없다 — 모든 클라이언트가 같은 답을 낸다
 * (안개와 같은 철학). 늦게 합류한 사람만 `hzq sync` 로 이 계획을 통째로 받는다. */

/** 독성 포자 발생지 하나 = 지형의 **거대 버섯 군락** 자리. */
export interface SporeSource {
  x: number;
  z: number;
  /** 피어오르기 시작하는 `missionTime`(초). 발생지마다 `SPORE_SOURCE_INTERVAL_S` 씩 밀린다. */
  eruptAt: number;
  /**
   * 이 발생지의 반경이 자라는 속도(m/s). 보통 `SPORE_GROWTH_MPS` 이고, 늦게 피어오르는 발생지만
   * `HAZARD_FULL_S` 안에 `sourceRadius` 에 닿도록 그만큼 빨라진다 (맵 봉쇄 보장).
   */
  growthMps: number;
}

export interface HazardPlan {
  kind: HazardKind;
  /** 시작 시각 (`ctx.missionTime` 초). */
  startsAt: number;
  /** `front` 진행 방향의 단위 벡터 (다른 재해에서는 (0,0)). */
  dirX: number;
  dirZ: number;
  /** `storm_eye` 안전 원의 중심 — **레이드 내내 고정**이다. */
  eyeX: number;
  eyeZ: number;
  /** `spores` 발생지 (다른 재해에서는 빈 배열). */
  sources: SporeSource[];
  /**
   * 발생지 하나가 끝까지 자랐을 때의 반경(m). `SPORE_RADIUS_MAX` 를 하한으로 두고, 뽑힌 배치에서
   * **맵의 어느 점이든 가장 가까운 발생지까지의 거리**를 실제로 재서 그보다 크게 잡는다 —
   * 그래야 `HAZARD_FULL_S` 에 안전지대가 하나도 남지 않는다.
   */
  sourceRadius: number;
}

/* ── 거대 버섯 군락의 치수 (그림의 문제라 csv 로 빼지 않는다 — 밸런스 수치가 아니다) ─────────────── */

/** 군락 하나에 세우는 거대 버섯 수의 범위. */
export const GROVE_CAPS_MIN = 5;
export const GROVE_CAPS_MAX = 8;
/** 군락 반경(m) — 이 안에 거대 버섯이 흩어진다. */
export const GROVE_RADIUS = 9;
/** 줄기 반경(m) 범위. **콜라이더는 이 줄기뿐이다** (갓은 공중에 있다 — `Props` 의 나무와 같은 이유). */
export const GROVE_STEM_R_MIN = 0.42;
export const GROVE_STEM_R_MAX = 0.95;
/** 줄기 높이(m) 범위. */
export const GROVE_STEM_H_MIN = 4.2;
export const GROVE_STEM_H_MAX = 9.0;
/** 갓 반경 = 줄기 반경 × 이 배수의 범위. */
export const GROVE_CAP_MUL_MIN = 3.4;
export const GROVE_CAP_MUL_MAX = 5.2;
/** 군락 주위에 심는 **채집 가능한 버섯** 수의 범위 (`Gather` 가 심는다). */
export const GROVE_PICKS_MIN = 3;
export const GROVE_PICKS_MAX = 5;
/** 채집 버섯이 심어지는 고리(m) — 거대 버섯 줄기에 겹치지 않게 바깥쪽이다. */
export const GROVE_PICK_RING_MIN = 4.5;
export const GROVE_PICK_RING_MAX = 13;
/** 채집 버섯이 쓰는 식물 변종 (`Gather` 의 1번 = 포자균 갓). */
export const GROVE_PICK_VARIANT = 1;

/* ── 진행 · 발행 주기 ──────────────────────────────────────────────────────────────────────────── */

/** `hazard:progress` 발행 주기(초). 계약이 "초당 몇 번 수준" 이라고 못 박아 뒀다 — 프레임마다 쏘지 않는다. */
export const PROGRESS_EMIT_S = 0.4;
/** `atmo:override` 재발행의 최소 변화폭 (blend). 이보다 작게 흔들리면 보내지 않는다. */
export const ATMO_EPS = 0.02;
