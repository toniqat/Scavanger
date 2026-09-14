/* ────────────────────────────────────────────────────────────────────────────
 * 정보상 표 로더 (2026-09-14, docs/plans/intel-broker.md).
 *
 * `shared/intel.ts` 는 **릴레이와 공유**하므로 런타임 import 가 하나도 없다 (csv 로더도 못 쓴다). 그래서 csv 를
 * 읽는 쪽은 이 파일로 갈랐다 — `shared/credits.ts`(순수 식) ↔ `shared/meta.ts`(csv) 와 **같은 갈래**다.
 * 릴레이는 이 파일을 import 하지 않고 `server/economy.gen.json` 의 `intel` 절을 받는다.
 *
 * Owner: shared/. 읽는 곳 — `meta/parts/Intel.ts`(가격 · 구매), `hub/ui/IntelMenu.ts`(줄 · 글자 · 잠김 사유).
 * ──────────────────────────────────────────────────────────────────────────── */

import { csvRows, keyTable, numberList } from './data/tables';
import { INTEL_GIMMICKS, INTEL_TIER_MAX, type IntelCostTable, type IntelGimmick } from './intel';
import { PLANET_DEFS } from './planetDefs';
import type { PlanetId } from './planets';

const T = /* data/tuning.csv */ keyTable('tuning.csv');

/** `data/intel_options.csv` 의 한 줄. */
export interface IntelOptionDef {
  id: IntelGimmick;
  /** 화면 줄 이름 (예: 탈출 지점). */
  label: string;
  /** 효과 문장 템플릿 — `{n}` 이 그 단계의 보너스 수로 바뀐다 (`intelEffectText`). */
  effect: string;
  /** 1단계 비용(크레딧). */
  baseCost: number;
  /** 1 … `INTEL_TIER_MAX`. */
  maxTier: number;
  /** 이 줄이 열리는 행성 최소 threat (1 = 어디서나). */
  minThreat: number;
  /** 툴팁 한 줄 (csv 의 `note`). */
  note: string;
  /** 파일 줄 순서. */
  order: number;
}

const BY_ID = new Map<string, IntelOptionDef>();

export const INTEL_OPTION_DEFS: readonly IntelOptionDef[] = csvRows('intel_options.csv').map((r, order) => {
  const id = r.str('id') as IntelGimmick;
  const def: IntelOptionDef = {
    id,
    label: r.str('label'),
    effect: r.str('effect'),
    baseCost: r.int('baseCost', { min: 0 }),
    maxTier: Math.max(1, Math.min(INTEL_TIER_MAX, r.int('maxTier', { min: 1 }))),
    minThreat: r.has('minThreat') ? r.int('minThreat', { min: 1 }) : 1,
    note: r.optStr('note') ?? '',
    order,
  };
  BY_ID.set(id, def);
  return def;
});

/* csv 가 `IntelGimmick` 7종을 정확히 덮는지 — 빠지면 그 줄은 살 수 없고, 모르는 id 는 화면에 안 뜬다. */
{
  const known = new Set<string>(INTEL_GIMMICKS);
  for (const d of INTEL_OPTION_DEFS) {
    if (!known.has(d.id)) {
      // eslint-disable-next-line no-console
      console.warn(`[intel_options.csv] 모르는 기믹 '${d.id}' — shared/intel.ts 의 IntelGimmick 에 없다`);
    }
  }
}

export function intelOptionDef(g: IntelGimmick): IntelOptionDef | undefined { return BY_ID.get(g); }

/** 화면 순서 = `INTEL_GIMMICKS` 순서 (csv 줄 순서가 아니라 계약 순서 — 코드도 사유도 이 순서다). */
export const INTEL_OPTIONS_IN_ORDER: readonly IntelOptionDef[] =
  INTEL_GIMMICKS.map((g) => BY_ID.get(g)).filter((d): d is IntelOptionDef => !!d);

/** `data/tables.csv` · `data/tuning.csv` 에서 만든 가격 표 — `intelCost` 에 그대로 넘긴다. */
export const INTEL_COST_TABLE: IntelCostTable = {
  options: Object.fromEntries(INTEL_OPTION_DEFS.map((d) => [d.id, { baseCost: d.baseCost, maxTier: d.maxTier }])),
  tierMul: numberList('tables.csv', 'INTEL_TIER_COST_MUL'),
  bundleMul: T.num('INTEL_BUNDLE_COST_MUL'),
  threatMul: numberList('tables.csv', 'INTEL_THREAT_COST_MUL'),
};

/** 행성 id → threat (가격 · 잠김 판정). */
export function intelPlanetThreat(planet: PlanetId | null | undefined): number {
  if (!planet) return 1;
  return PLANET_DEFS.find((p) => p.id === planet)?.threat ?? 1;
}

/**
 * 이 행성에서 이 줄의 최대 단계. **0 = 잠김** — 지금은 `minThreat` 하나뿐이고 네임드가 그것을 쓴다
 * (사용자 결정: threat 2 이상에서만).
 */
export function intelMaxTier(g: IntelGimmick, planet: PlanetId | null | undefined): number {
  const d = BY_ID.get(g);
  if (!d) return 0;
  return intelPlanetThreat(planet) >= d.minThreat ? d.maxTier : 0;
}

/** 그 단계에서 화면에 적는 효과 문장 (`{n}` 치환). 단계 0 이면 빈 문자열. */
export function intelEffectText(g: IntelGimmick, tier: number): string {
  const d = BY_ID.get(g);
  if (!d || tier <= 0) return '';
  const n = g === 'hazardDelay' ? tier + 1 : tier;   // 재해 지연만 「단계+1 분」 — resolveIntelEffects 와 같은 식
  return d.effect.replace('{n}', String(n));
}
