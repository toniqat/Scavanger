/**
 * src/world/structures/model.ts — 구조물 · 선로 파트가 공유하는 **어휘**. 상태는 하나도 들고 있지 않다.
 *
 * 수치는 전부 `data/structures.csv` 다 (개수 · 크기 · 컨테이너 수 · 지하실 확률 · 상자 티어 가중치).
 * 코드에는 같은 숫자를 적지 않는다 — 이 파일이 그 표를 읽어 타입으로 옮기는 유일한 자리다.
 * `data:check` 의 고아 검사가 이 모듈을 통해 `structures.csv` 를 읽는다 (`scripts/data-check.mjs` 의 `DATA_OWNERS`).
 *
 * ⚠ 여기서는 THREE 를 **값으로** 쓰지 않는다 (`layout.ts` 와 `data:check` 가 둘 다 이 파일을 아주 이르게 읽는다).
 */
import { type CsvRow, type StructureKind, addDataIssue, csvRows } from '@/shared';

/** csv 의 `kind` 열이 가질 수 있는 값. 구조물 3종 + 선로 부속 2종. */
export type StructureRowKind = StructureKind | 'rail_platform' | 'tram';

/** 상자 티어 가중치 한 줄 (`"2:6|3:3"` → `[{tier:2, weight:6}, …]`). */
export interface TierWeight { tier: number; weight: number }

/** `data/structures.csv` 한 줄. */
export interface StructureRow {
  kind: StructureRowKind;
  /** 한국어 이름 (프롬프트 · 토스트). */
  label: string;
  minCount: number;
  maxCount: number;
  /** 바닥 반길이(m). 전차는 차체 반길이다. */
  halfW: number;
  halfD: number;
  wallH: number;
  /** 다른 구조물 · 스폰 · 탈출 패드에서 떨어져야 하는 최소 거리(m). */
  minGap: number;
  containers: number;
  basementChance: number;
  basementDepth: number;
  basementContainers: number;
  tiers: readonly TierWeight[];
  basementTiers: readonly TierWeight[];
  /** 2층이 올라갈 확률 (2026-09-11). 0 = 늘 단층 (불시착 함선 · 선로 부속). */
  upperChance: number;
}

const ROW_KINDS: readonly StructureRowKind[] = ['outpost', 'lab', 'wreck', 'rail_platform', 'tram'];

function tierList(raw: CsvRow, column: string): TierWeight[] {
  return raw.costList(column)
    .map((c) => ({ tier: Number(c.defId), weight: c.qty }))
    .filter((t) => Number.isFinite(t.tier) && t.tier >= 1 && t.tier <= 4 && t.weight > 0);
}

/** `data/structures.csv` 전체. 줄 순서 = 배치를 시도하는 순서다. */
export const STRUCTURE_ROWS: readonly StructureRow[] = csvRows('structures.csv').map((r) => {
  const kind = r.str('kind') as StructureRowKind;
  if (!ROW_KINDS.includes(kind)) r.report('kind', `'${kind}' 는 ${ROW_KINDS.join(' | ')} 중 하나여야 한다`);
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
  };
});

const BY_KIND = new Map<StructureRowKind, StructureRow>();
for (const row of STRUCTURE_ROWS) {
  if (BY_KIND.has(row.kind)) addDataIssue({ file: 'structures.csv', line: 0, column: 'kind', message: `'${row.kind}' 가 중복이다` });
  else BY_KIND.set(row.kind, row);
}

/** 한 줄 찾기. 없는 종류를 물으면 `data:check` 가 잡도록 문제를 남기고 undefined. */
export function structureRow(kind: StructureRowKind): StructureRow | undefined {
  const row = BY_KIND.get(kind);
  if (!row) addDataIssue({ file: 'structures.csv', line: 0, column: kind, message: `'${kind}' 줄이 없다` });
  return row;
}

/** 가중치대로 상자 티어 하나. 표가 비었으면 1티어. */
export function pickTier(tiers: readonly TierWeight[], roll: number): number {
  let total = 0;
  for (const t of tiers) total += t.weight;
  if (total <= 0) return 1;
  let r = roll * total;
  for (const t of tiers) { r -= t.weight; if (r <= 0) return t.tier; }
  return tiers[tiers.length - 1].tier;
}

/* ── 건물 치수 (그림의 문제라 csv 로 빼지 않는다 — 밸런스 수치가 아니다) ──────────────────────────── */

/** 벽 두께(m). 콜라이더 `halfZ` 는 이 값의 절반이다. */
export const WALL_T = 0.42;
/** 출입구 폭(m). */
export const DOOR_W = 2.6;
/**
 * 2026-09-11 — 계단은 **경사 콜라이더**(`Obstacle.ramp`)다 (`parts/Stairs`). 예전의 `STAIR_HALF` ·
 * `STAIR_RISE_MAX` · `STAIR_TREAD_MIN` 은 "한 단이 벽이 되지 않게" 단 크기를 맞추던 값이라 필요가 없어졌다.
 */
/** 계단 기울기 (높이 ÷ 수평 길이). 0.7 ≈ 35°. */
export const STAIR_SLOPE = 0.7;
/** 보이는 한 단의 높이(m) — 그림일 뿐 콜라이더와 무관하다. */
export const STAIR_STEP_RISE = 0.3;
/** 1층 → 2층 실내 계단 폭(m). */
export const STAIR_W = 1.7;
/** 층 사이 바닥판(= 아래층 천장 · 옥상) 두께(m). 1층 바닥판도 같은 두께라 지하실 천장이 된다. */
export const SLAB_T = 0.5;
/** 문 높이(m). 그 위는 상인방 벽이다 (천장이 생겼으므로 문은 벽의 구멍이다). */
export const DOOR_H = 2.5;
/** 창문 가로 폭 · 창턱 높이 · 창 윗변 높이 · 유리 두께(m, 층 바닥 기준). */
export const WINDOW_W = 1.5;
export const WINDOW_SILL = 1.0;
export const WINDOW_TOP = 2.4;
export const GLASS_T = 0.05;
/** 옥상 난간벽 높이(m). */
export const PARAPET_H = 1.0;
/** 계단 구멍 · 옥상 해치 둘레 난간 높이 · 두께(m). */
export const RAIL_H = 1.0;
export const RAIL_T = 0.12;
/** 옥상 해치 구멍의 가로 · 세로(m). 사다리에 매달린 몸(반지름 0.45)이 닿지 않고 지나가는 크기. */
export const HATCH_W = 1.4;
export const HATCH_D = 1.2;
/** 사다리 면에서 매달린 몸 중심까지(m). */
export const LADDER_STANDOFF = 0.55;
/** 지하 계단 복도 반폭(m) · 계단 끝 층계참 길이(m) · 지하실 바닥판 두께(m). */
export const BASEMENT_HALL_HALF = 1.1;
export const BASEMENT_LANDING = 1.6;
export const BASEMENT_FLOOR_T = 0.3;
/**
 * 지하실 구덩이 벽의 페더 폭(m). 지형은 사각 구덩이를 이 폭에 걸쳐 내려간다 (`Terrain.build`).
 * **천장 슬래브는 이만큼 더 넓게 덮어야 한다** — 안 그러면 구덩이 둘레에 폭 1.6 m 짜리 도랑이 생겨
 * 실내를 걷다 빠진다. `Terrain` 과 `structures/parts/Build` 가 같은 값을 봐야 하므로 여기 하나만 둔다.
 */
export const PIT_BLEND = 1.6;
/** 컨테이너 상호작용 반경(m) — 상자(2.8)보다 좁다. 실내에 밀집하므로 서로를 가리지 않게. */
export const CONTAINER_RADIUS = 1.9;
/**
 * 지상층 바닥판이 벽 중심선 **바깥으로** 물러나는 폭(m) — 건물 둘레의 기초 앞치마다 (2026-09-10).
 *
 * 왜 필요한가: 지형 격자는 2 m 간격인데 지하실 구덩이의 페더는 `PIT_BLEND`(1.6 m) 뿐이라, 구덩이 둘레가
 * **한 칸 안에서** 내려간다. 그래서 벽 안쪽 1~2 m 띠의 지형이 바닥보다 최대 1 m 넘게 꺼져 있었고
 * (표본: 전진기지에서 −1.08 m), 문으로 들어서면 그 도랑에 빠진 뒤 `PROP_STEP_UP_MAX`(0.9) 를 넘는
 * 턱을 마주쳐 **점프해야만** 들어갈 수 있었다. 바닥판을 발자국 전체 + 이 폭까지 깔고 **윗면을 정확히
 * `y0`** 로 두면 문턱이 사라진다 — 걷는 바닥이 지형이 아니라 이 판이 되기 때문이다.
 */
export const FLOOR_OVERHANG = 0.9;
/** 바닥판이 지형 위로 살짝 솟는 높이(m). 0 이면 평탄한 패드에서 지형과 z-fighting 이 난다. */
export const FLOOR_LIP = 0.02;

/* ── 선로 회랑 ─────────────────────────────────────────────────────────────── */

/**
 * 선로 회랑 반폭(m). 값의 주인은 `data/constants.csv` 이고 그것을 읽는 곳은 `src/shared/constants.ts`
 * 하나다 — 여기서는 이름만 다시 내보내 `world/` 안의 호출부가 짧게 쓰게 한다.
 */
export { RAIL_CLEARANCE_M } from '@/shared';

/* ── 전차 호출 콘솔 (2026-09-10) ──────────────────────────────────────────── */

/**
 * 플랫폼 호출 콘솔의 홀드 시간(초) · 상호작용 거리(m). `RAIL_CLEARANCE_M` 과 같은 이유로 이름만
 * 다시 내보낸다 — 값의 주인은 `data/constants.csv`, 그것을 읽는 곳은 `src/shared/constants.ts` 하나다.
 */
export { TRAM_CALL_HOLD_S, TRAM_CALL_RANGE } from '@/shared';
