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
/** 지하실 계단이 지나갈 슬래브 구멍의 반길이(m). */
export const STAIR_HALF = 1.5;
/** 지하실 천장 슬래브 두께(m) — 윗면이 지상층 바닥과 정확히 같은 높이가 되게 밑으로 판다. */
export const SLAB_T = 0.5;
/**
 * 지하실 구덩이 벽의 페더 폭(m). 지형은 사각 구덩이를 이 폭에 걸쳐 내려간다 (`Terrain.build`).
 * **천장 슬래브는 이만큼 더 넓게 덮어야 한다** — 안 그러면 구덩이 둘레에 폭 1.6 m 짜리 도랑이 생겨
 * 실내를 걷다 빠진다. `Terrain` 과 `structures/parts/Build` 가 같은 값을 봐야 하므로 여기 하나만 둔다.
 */
export const PIT_BLEND = 1.6;
/** 컨테이너 상호작용 반경(m) — 상자(2.8)보다 좁다. 실내에 밀집하므로 서로를 가리지 않게. */
export const CONTAINER_RADIUS = 1.9;
