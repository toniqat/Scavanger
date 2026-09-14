/* ────────────────────────────────────────────────────────────────────────────
 * 정보상 (2026-09-14, 사용자 결정 — docs/plans/intel-broker.md).
 *
 * 「행성의 정보를 산다」는 컨셉이지만 실제로 하는 일은 **그 레이드의 기믹 수를 고정하는 것**이다 (페이데이 2 의
 * 하이스트 전 에셋 구매). 지금까지 맵은 `seed + planet` 두 값의 순수 함수였고 와이어에도 그 둘만 실렸다 —
 * 정보상은 거기에 **세 번째 값**을 더한다. 그래서 이 파일이 계약이다:
 *
 *   IntelPick[]  = 사람이 화면에서 고른 것 (기믹 · 단계)          — 저장 · 와이어 · 크레딧 사유에 실린다
 *   IntelEffects = 월드가 읽는 해석본                              — 소비자는 **이것만** 읽는다
 *
 * 소비자(`world/` · `enemies/`)가 `IntelPick[]` 를 직접 해석하지 않는 이유는 하나다: 단계 → 실제 보너스의
 * 대응표가 두 곳에 복사되면 미리보기 지도와 진짜 맵이 조용히 달라진다 (CLAUDE.md 「열지 않고 미리 보는 것은
 * 여는 것과 같은 함수여야 한다」). `resolveIntelEffects` 하나가 그 표다.
 *
 * 이 파일은 브라우저 **와 Node 릴레이**가 함께 import 한다 — **런타임 import 금지** (csv 로더도 three 도 안 된다).
 * 수치는 전부 호출자가 표로 넘긴다 (`IntelCostTable`): 클라는 `data/intel_options.csv` 에서 읽은 것을,
 * 릴레이는 `server/economy.gen.json` 의 `intel` 절을 넘긴다 — `shared/credits.ts` 의 가격 식과 같은 패턴이다.
 *
 * Owner: shared/. 구현은 `meta/parts/Intel.ts`(보유 · 구매), 화면은 `hub/ui/IntelMenu.ts`,
 * 월드 적용은 `world/` · `enemies/named/Director.ts`, 검증은 `server/Economy.ts`.
 * ──────────────────────────────────────────────────────────────────────────── */

import type { PlanetId } from './planets';

/**
 * 살 수 있는 기믹 7종. 값은 세이브 · 와이어 · 크레딧 사유에 실리므로 **바꾸지 않는다** (추가만).
 *
 *   extraction   탈출 패드 수            +1 / +2
 *   basement     지하실이 있는 구조물     +1 / +2   (연구실 · 전진기지)
 *   hazardDelay  재해 시작까지의 시간     +2 / +3 / +4 분
 *   rail         선로 확정 + 플랫폼       +1
 *   rover        탐사 차량 확정           +1
 *   named        네임드 보스 지정         한 번에 하나 (행성 threat 2 이상에서만)
 *   nest         벌레 둥지 수            +1 / +2
 */
export type IntelGimmick = 'extraction' | 'basement' | 'hazardDelay' | 'rail' | 'rover' | 'named' | 'nest';

/** 화면 순서이자 저장 순서. 정렬 · 코드 생성이 이 순서를 쓴다. */
export const INTEL_GIMMICKS: readonly IntelGimmick[] = [
  'extraction', 'basement', 'hazardDelay', 'rail', 'rover', 'named', 'nest',
];

/**
 * 크레딧 사유(`intel:<planet>:<code>`)에 실리는 한 글자. 사유는 64자 상한이라 기믹 이름을 그대로 쓸 수 없다.
 * 값은 서버가 파싱하므로 **바꾸지 않는다**.
 */
export const INTEL_GIMMICK_CODE: Record<IntelGimmick, string> = {
  extraction: 'x', basement: 'b', hazardDelay: 'h', rail: 'r', rover: 'v', named: 'n', nest: 'g',
};

const CODE_TO_GIMMICK: Record<string, IntelGimmick> = (() => {
  const m: Record<string, IntelGimmick> = {};
  for (const g of INTEL_GIMMICKS) m[INTEL_GIMMICK_CODE[g]] = g;
  return m;
})();

/** 고를 수 있는 단계의 절대 상한 (csv 의 `maxTier` 가 이보다 클 수 없다). */
export const INTEL_TIER_MAX = 3;

/** 한 줄의 선택. `tier` 는 1부터 — 0 은 「안 샀다」라서 `picks` 에 아예 들어가지 않는다. */
export interface IntelPick {
  g: IntelGimmick;
  /** 1 … `maxTier`. */
  tier: number;
  /** `named` 전용: 지정한 적 타입 id (`rogue_roden` 류). 가격에는 영향이 없다. */
  id?: string;
}

/** 프로필에 저장되고 와이어로 가는 「보유 정보」. 한 번에 하나만 갖는다. */
export interface IntelSpec {
  planet: PlanetId;
  /** 이 정보가 가리키는 「지역」 = 미션 시드. 출격이 이 시드를 쓴다. */
  seed: number;
  picks: IntelPick[];
}

/**
 * 월드가 읽는 해석본. **소비자는 이것만 읽는다** — `ctx.missionIntel` 로 게시되고, `ctx.missionPlanet` 과
 * 똑같이 `game:newMission` 을 **emit 하기 전에** emitter 가 세팅한다 (동기 핸들러 안에서 읽히므로).
 */
export interface IntelEffects {
  /** 탈출 패드 +N. */
  extractionBonus: number;
  /** 지하실이 있는 구조물 +N. */
  basementBonus: number;
  /** 재해 시작 +N 초. */
  hazardDelayS: number;
  /** > 0 이면 선로가 확정으로 서고 플랫폼이 +N. */
  railPlatformBonus: number;
  /** 탐사 차량이 반드시 선다. */
  roverForce: boolean;
  /** 지정한 네임드 적 타입 id (없으면 null = 평소대로 굴린다). */
  namedId: string | null;
  /** 벌레 둥지 +N. */
  nestBonus: number;
}

/** 아무것도 사지 않은 상태. 소비자가 `?? NO_INTEL` 로 쓸 수 있게 얼려 둔다. */
export const NO_INTEL: Readonly<IntelEffects> = Object.freeze({
  extractionBonus: 0,
  basementBonus: 0,
  hazardDelayS: 0,
  railPlatformBonus: 0,
  roverForce: false,
  namedId: null,
  nestBonus: 0,
});

/**
 * 단계 → 실제 보너스의 **유일한** 대응표.
 *
 * 지금은 전부 「단계 = 보너스 개수」인데 재해 지연만 분 단위라 곱한다. 표를 csv 로 빼지 않은 이유는
 * 이것이 밸런스 수치가 아니라 **그 줄이 무엇을 뜻하는지의 정의**이기 때문이다 — 「탈출구 +2」 라고 써 놓고
 * 다른 수를 주면 화면이 거짓말을 한다. 값(가격 · 상한)만 `data/intel_options.csv` 에 있다.
 */
export function resolveIntelEffects(picks: readonly IntelPick[] | null | undefined): IntelEffects {
  const e: IntelEffects = { ...NO_INTEL };
  if (!picks) return e;
  for (const p of picks) {
    const t = Math.max(0, Math.min(INTEL_TIER_MAX, Math.round(p?.tier ?? 0)));
    if (t <= 0) continue;
    switch (p.g) {
      case 'extraction': e.extractionBonus += t; break;
      case 'basement': e.basementBonus += t; break;
      case 'hazardDelay': e.hazardDelayS += (t + 1) * 60; break;   // 1단계 = +2분, 2 = +3분, 3 = +4분
      case 'rail': e.railPlatformBonus += t; break;
      case 'rover': e.roverForce = true; break;
      case 'named': e.namedId = typeof p.id === 'string' && p.id ? p.id : e.namedId; break;
      case 'nest': e.nestBonus += t; break;
      default: break;                                              // 모르는 기믹(옛 세이브 · 새 클라)은 버린다
    }
  }
  return e;
}

/* ── 가격 ────────────────────────────────────────────────────────────────── */

/**
 * 가격에 필요한 전부. 클라는 `data/intel_options.csv` + `data/tables.csv` 에서, 릴레이는
 * `server/economy.gen.json` 의 `intel` 절에서 같은 모양으로 만들어 넘긴다 — 그래서 **식이 한 곳**이다.
 */
export interface IntelCostTable {
  /** 기믹 → 1단계 기본 비용. 없는 기믹은 살 수 없다. */
  options: Record<string, { baseCost: number; maxTier: number }>;
  /** 단계별 배수 (index 0 = 1단계). 비선형 — 같은 줄을 더 올릴수록 비싸다. */
  tierMul: number[];
  /** 고정한 줄 수가 늘 때마다 총합에 곱해지는 누진 배수 (`bundleMul^(N-1)`). */
  bundleMul: number;
  /** 행성 threat 별 배수 (index 0 = threat 1). */
  threatMul: number[];
}

/**
 * 총 크레딧 비용. **비선형**은 두 군데다 — 같은 줄의 단계(`tierMul`)와 고정한 줄 수(`bundleMul^(N-1)`).
 * 사용자 결정 「많이 활성화할수록 선형이 아니게 더 많이 소모」.
 */
export function intelCost(planetThreat: number, picks: readonly IntelPick[], t: IntelCostTable): number {
  let sum = 0;
  let lines = 0;
  for (const p of picks) {
    const opt = t.options[p?.g];
    if (!opt) continue;
    const tier = Math.max(0, Math.min(Math.round(opt.maxTier), Math.round(p.tier ?? 0)));
    if (tier <= 0) continue;
    sum += opt.baseCost * (t.tierMul[tier - 1] ?? 1);
    lines++;
  }
  if (lines <= 0) return 0;
  const bundle = Math.pow(Math.max(1, t.bundleMul), lines - 1);
  const ti = Math.max(0, Math.min(t.threatMul.length - 1, Math.round(planetThreat) - 1));
  const threat = t.threatMul[ti] ?? 1;
  return Math.max(0, Math.round(sum * bundle * threat));
}

/**
 * 크레딧 사유에 실리는 압축 코드 — `intelCode([{g:'extraction',tier:2},{g:'nest',tier:1}]) === 'x2g1'`.
 * `INTEL_GIMMICKS` 순서로 정렬하므로 같은 선택이면 **언제나 같은 문자열**이다 (서버가 재계산해 맞춰 본다).
 * `named` 의 적 id 는 **싣지 않는다** — 가격에 영향이 없고 64자 예산을 먹는다.
 */
export function intelCode(picks: readonly IntelPick[]): string {
  const byG = new Map<IntelGimmick, number>();
  for (const p of picks) {
    const tier = Math.max(0, Math.min(INTEL_TIER_MAX, Math.round(p?.tier ?? 0)));
    if (tier > 0 && INTEL_GIMMICK_CODE[p.g]) byG.set(p.g, tier);
  }
  let out = '';
  for (const g of INTEL_GIMMICKS) {
    const tier = byG.get(g);
    if (tier) out += INTEL_GIMMICK_CODE[g] + String(tier);
  }
  return out;
}

/** `intelCode` 의 역. 모양이 틀리면 null (서버가 받는 값이라 관대하게 굴지 않는다). */
export function parseIntelCode(code: string): IntelPick[] | null {
  if (typeof code !== 'string' || code.length === 0 || code.length > 2 * INTEL_GIMMICKS.length) return null;
  if (code.length % 2 !== 0) return null;
  const picks: IntelPick[] = [];
  const seen = new Set<IntelGimmick>();
  for (let i = 0; i < code.length; i += 2) {
    const g = CODE_TO_GIMMICK[code[i]];
    const tier = Number(code[i + 1]);
    if (!g || seen.has(g)) return null;
    if (!Number.isInteger(tier) || tier < 1 || tier > INTEL_TIER_MAX) return null;
    seen.add(g);
    picks.push({ g, tier });
  }
  return picks;
}

/* ── 저장 · 와이어 위생 ──────────────────────────────────────────────────── */

/** 프로필 문서 · 로비 상태 · `game:start` 에서 온 값을 믿기 전에 지난다. 모양이 아니면 null. */
export function sanitizeIntelSpec(raw: unknown): IntelSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<IntelSpec>;
  if (typeof r.planet !== 'string' || !r.planet) return null;
  if (typeof r.seed !== 'number' || !Number.isFinite(r.seed)) return null;
  const picks = sanitizeIntelPicks(r.picks);
  if (!picks.length) return null;
  return { planet: r.planet as PlanetId, seed: Math.floor(r.seed), picks };
}

/** 줄 목록만 씻는다 (같은 기믹 중복 제거 · 단계 클램프 · 모르는 기믹 폐기 · `INTEL_GIMMICKS` 순서로 정렬). */
export function sanitizeIntelPicks(raw: unknown): IntelPick[] {
  if (!Array.isArray(raw)) return [];
  const byG = new Map<IntelGimmick, IntelPick>();
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const p = it as Partial<IntelPick>;
    const g = p.g as IntelGimmick;
    if (!INTEL_GIMMICK_CODE[g] || byG.has(g)) continue;
    const tier = Math.max(0, Math.min(INTEL_TIER_MAX, Math.round(Number(p.tier) || 0)));
    if (tier <= 0) continue;
    const id = typeof p.id === 'string' && /^[a-z0-9_]{1,32}$/i.test(p.id) ? p.id : undefined;
    byG.set(g, id ? { g, tier, id } : { g, tier });
  }
  const out: IntelPick[] = [];
  for (const g of INTEL_GIMMICKS) { const p = byG.get(g); if (p) out.push(p); }
  return out;
}

/** 두 보유 정보가 같은가 (문서 비교 · 저장 debounce 용). */
export function intelSpecEqual(a: IntelSpec | null, b: IntelSpec | null): boolean {
  if (!a || !b) return a === b;
  if (a.planet !== b.planet || a.seed !== b.seed) return false;
  if (a.picks.length !== b.picks.length) return false;
  for (let i = 0; i < a.picks.length; i++) {
    const x = a.picks[i], y = b.picks[i];
    if (x.g !== y.g || x.tier !== y.tier || (x.id ?? '') !== (y.id ?? '')) return false;
  }
  return true;
}
