/**
 * src/world/hazard/parts/Plan.ts — 이번 레이드의 재해 **추첨**.
 *
 * 전부 미션 시드의 함수다: 종류 · 시작 시각 · 전선 방향 · 폭풍의 눈 중심 · 포자 발생지 자리까지.
 * 그래서 평상시 와이어가 없다 — 모든 클라이언트가 같은 월드를 같은 시드로 만들면 같은 계획이 나온다
 * (`Fog` 와 같은 철학). 늦게 합류한 사람만 `hzq sync` 로 이 계획을 받는다.
 */
import {
  HAZARD_FULL_S, MAP_SIZE, SPORE_GROWTH_MPS, SPORE_RADIUS_MAX, SPORE_SOURCES_MAX, SPORE_SOURCES_MIN,
  SPORE_SOURCE_INTERVAL_S, SPORE_START_S, type HazardKind, type Random,
} from '@/shared';
import { type BuildCtx, PLAY_LIMIT, isSpotFree } from '../../build';
import { padClearance } from '../../layout';
import { GROVE_RADIUS, type HazardPlan, type SporeSource, isFrontKind, pickStartSeconds } from '../model';

const HALF = MAP_SIZE / 2;

/** 군락은 강하 지점 · 탈출 패드에서 이만큼 떨어진 곳에만 선다 (드롭하자마자 독 안에 있으면 안 된다). */
const GROVE_PAD_CLEAR = 34;
/** 군락끼리의 최소 간격(m). 한쪽에 몰리면 반대쪽이 끝까지 안전지대로 남는다. */
const GROVE_MIN_GAP = 130;

/**
 * **거대 버섯 군락 자리**. `spores` 가 후보에 있는 행성이면 이번 레이드에 어떤 재해가 걸렸든 지형에 선다 —
 * 군락은 그 행성의 생태이지 재해의 부속이 아니다. 그래서 **전용 fork** 를 쓴다: 종류 추첨이 이 자리를
 * 밀지 않는다.
 */
export function planGroveSpots(bctx: BuildCtx, rng: Random): Array<{ x: number; z: number }> {
  const want = Math.max(1, rng.int(SPORE_SOURCES_MIN, SPORE_SOURCES_MAX));
  return placeSources(bctx, rng, want);
}

/**
 * 후보 중 하나를 뽑아 이번 레이드의 계획을 만든다. 후보가 비었으면(재해 없는 행성) null.
 *
 * `groveSpots` 는 `planGroveSpots` 가 이미 잡아 둔 군락 자리다 — `spores` 가 걸리면 그 자리가 그대로
 * 발생지가 된다 (사용자 요구: 포자는 거대 버섯 군락에서 피어오른다).
 */
export function planHazard(
  rng: Random, candidates: readonly HazardKind[], groveSpots: ReadonlyArray<{ x: number; z: number }>,
): HazardPlan | null {
  if (candidates.length === 0) return null;
  const kind = candidates.length === 1 ? candidates[0] : rng.pick(candidates);

  // 독성 포자만 시작 시각이 고정이다 (사용자 요구: 6분). 나머지는 30초 단위로 6~8분 사이.
  const startsAt = kind === 'spores' ? SPORE_START_S : pickStartSeconds(rng.next());

  const plan: HazardPlan = {
    kind, startsAt,
    dirX: 0, dirZ: 0,
    eyeX: 0, eyeZ: 0,
    sources: [],
    sourceRadius: SPORE_RADIUS_MAX,
  };

  if (isFrontKind(kind)) {
    // 전선의 진행 방향은 완전 무작위 — 어느 쪽에서 차오를지는 매 레이드 다르다.
    const ang = rng.range(0, Math.PI * 2);
    plan.dirX = Math.cos(ang);
    plan.dirZ = Math.sin(ang);
    return plan;
  }

  if (kind === 'storm_eye') {
    // 눈의 중심은 맵 안쪽 60 % 안 — 가장자리에 붙으면 마지막 안전지대가 절벽 위가 된다.
    const r = HALF * 0.6 * Math.sqrt(rng.next());
    const ang = rng.range(0, Math.PI * 2);
    plan.eyeX = Math.cos(ang) * r;
    plan.eyeZ = Math.sin(ang) * r;
    return plan;
  }

  // ── 독성 포자: 발생지 = 이미 잡아 둔 거대 버섯 군락 ─────────────────────────────────────────
  // 군락을 한 곳도 못 세운 시드라면 포자가 피어오를 자리가 없다 — 이번 레이드는 재해 없이 간다.
  if (groveSpots.length === 0) return null;
  const spots = groveSpots;
  const radius = coverRadius(spots);
  plan.sourceRadius = Math.max(SPORE_RADIUS_MAX, radius);
  const full = plan.startsAt + HAZARD_FULL_S;
  plan.sources = spots.map((s, i) => {
    const eruptAt = plan.startsAt + i * SPORE_SOURCE_INTERVAL_S;
    // 늦게 피어오르는 발생지도 `HAZARD_FULL_S` 안에 다 자라야 안전지대가 남지 않는다
    const growthMps = Math.max(SPORE_GROWTH_MPS, plan.sourceRadius / Math.max(1, full - eruptAt));
    const src: SporeSource = { x: s.x, z: s.z, eruptAt, growthMps };
    return src;
  });
  return plan;
}

/**
 * 발생지 자리 `want` 개. 후보를 여럿 뽑아 **이미 놓인 것들에서 가장 멀리 떨어지는** 것을 고르는
 * best-of-k 라 한쪽에 몰리지 않는다. 자리는 완만하고 비어 있어야 하며 (군락 줄기가 콜라이더로 들어간다)
 * 강하 지점 · 탈출 패드에서도 떨어져 있어야 한다.
 */
function placeSources(bctx: BuildCtx, rng: Random, want: number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  const limit = PLAY_LIMIT - GROVE_RADIUS - 6;
  for (let n = 0; n < want; n++) {
    let bestX = 0, bestZ = 0, bestScore = -Infinity;
    for (let a = 0; a < 260; a++) {
      const x = rng.range(-limit, limit), z = rng.range(-limit, limit);
      if (padClearance(bctx.layout, x, z, GROVE_PAD_CLEAR) < GROVE_RADIUS) continue;
      if (!isSpotFree(bctx, x, z, GROVE_RADIUS, { maxSlope: 0.28, padExtra: GROVE_PAD_CLEAR, limit })) continue;
      let near = Infinity;
      for (const p of out) near = Math.min(near, Math.hypot(p.x - x, p.z - z));
      if (near < GROVE_MIN_GAP && out.length > 0) near -= 1e6;   // 간격을 못 지키는 후보는 사실상 탈락
      if (near > bestScore) { bestScore = near; bestX = x; bestZ = z; }
    }
    if (bestScore === -Infinity) break;      // 이 시드에서는 더 놓을 자리가 없다
    out.push({ x: bestX, z: bestZ });
  }
  return out;
}

/**
 * 이 배치에서 **맵의 어느 점이든 가장 가까운 발생지까지의 거리**. 발생지가 전부 이만큼 자라면 안전지대가
 * 하나도 남지 않는다. 33×33 격자 표본이면 8 m 단위 오차라 여유(+8 m)를 얹어 돌려준다.
 */
function coverRadius(spots: ReadonlyArray<{ x: number; z: number }>): number {
  if (spots.length === 0) return 0;
  const N = 33;
  let worst = 0;
  for (let i = 0; i < N; i++) {
    const x = -HALF + (i / (N - 1)) * MAP_SIZE;
    for (let j = 0; j < N; j++) {
      const z = -HALF + (j / (N - 1)) * MAP_SIZE;
      let near = Infinity;
      for (const s of spots) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < near) near = d;
      }
      if (near > worst) worst = near;
    }
  }
  return worst + MAP_SIZE / (N - 1);
}
