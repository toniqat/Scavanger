/**
 * src/world/hazard/parts/Plan.ts — 이번 레이드의 재해 **추첨**.
 *
 * 전부 미션 시드의 함수다: 종류 · 시작 시각 · 전선 방향 · 폭풍의 눈 중심 · 포자 발생지 자리까지.
 * 그래서 평상시 와이어가 없다 — 모든 클라이언트가 같은 월드를 같은 시드로 만들면 같은 계획이 나온다
 * (`Fog` 와 같은 철학). 늦게 합류한 사람만 `hzq sync` 로 이 계획을 받는다.
 *
 * 2026-09-13 — **종류는 레이아웃보다 먼저** 정해진다 (`drawHazardKind`). 독성 포자 레이드는 강하 지점 · 탈출 패드 ·
 * 발생지 자리가 다른 재해와 반대라서다 (중앙 강하 · 중앙 발생지 · 외곽 패드). 종류 추첨은 여전히 루트 rng 의
 * `'hazard'` fork 의 첫 draw 이고 fork 는 부모를 전진시키지 않으므로, **같은 시드는 이 변경 전과 같은 종류**를 뽑는다.
 */
import {
  HAZARD_FRONT_SPAWN_JITTER_RAD, HAZARD_FULL_S, MAP_SIZE, SPORE_CENTER_GROVE_GAP_M, SPORE_CENTER_RADIUS_M,
  SPORE_GROVE_SPAWN_GAP_M, SPORE_GROWTH_MPS, SPORE_RADIUS_MAX, SPORE_SOURCES_MAX, SPORE_SOURCES_MIN,
  SPORE_SOURCE_INTERVAL_S, SPORE_START_S, type HazardKind, type Random,
} from '@/shared';
import { type BuildCtx, PLAY_LIMIT, isSpotFree } from '../../build';
import { padClearance } from '../../layout';
import { GROVE_RADIUS, type HazardPlan, type SporeSource, isFrontKind, pickStartSeconds } from '../model';

const HALF = MAP_SIZE / 2;

/** 재해 추첨이 쓰는 루트 rng 의 fork 이름. `drawHazardKind` 와 `Hazard.build` 가 **같은 이름**을 써야 같은 종류가 나온다. */
export const HAZARD_FORK = 'hazard';

/** 군락은 강하 지점 · 탈출 패드에서 이만큼 떨어진 곳에만 선다 (드롭하자마자 독 안에 있으면 안 된다). */
const GROVE_PAD_CLEAR = 34;
/** 군락끼리의 최소 간격(m). 한쪽에 몰리면 반대쪽이 끝까지 안전지대로 남는다. */
const GROVE_MIN_GAP = 130;

/**
 * 2026-09-10 — **눈 덮인 지형에는 모래 폭풍이 오지 않는다** (사용자 결정). 같은 `front` 재해인 눈보라로
 * 갈아 끼운다: 도형 · 시작 시각 · 진행 방향은 그대로이고 그림(`data/hazards.csv`)만 바뀐다.
 * 추첨을 다시 하지 않으므로 **같은 시드는 여전히 같은 계획**이다.
 * (오늘의 `data/planets.csv` 는 툰드라 행성에 눈보라만 적어 두므로 이 규칙은 아직 발동하지 않는다 —
 *  csv 를 고치거나 새 눈 지형이 생겨도 규칙이 지켜지도록 코드에 못을 박아 둔 것이다.)
 */
const SNOWY_BIOMES: ReadonlySet<string> = new Set(['tundra']);

/** 후보에서 종류 하나 (`rng` 의 첫 draw — 후보가 하나면 draw 없음). 후보가 비었으면 null. */
function pickKind(rng: Random, candidates: readonly HazardKind[], biomeId: string | null): HazardKind | null {
  if (candidates.length === 0) return null;
  const drawn = candidates.length === 1 ? candidates[0] : rng.pick(candidates);
  // 눈 지형의 모래 폭풍 → 눈보라 (위 `SNOWY_BIOMES`). 추첨 뒤의 치환이라 시드 재현성은 그대로다.
  return drawn === 'sandstorm' && biomeId !== null && SNOWY_BIOMES.has(biomeId) ? 'blizzard' : drawn;
}

/**
 * 2026-09-13 — **레이아웃보다 먼저** 이번 레이드의 재해 종류만 뽑는다. `root` 는 월드의 루트 rng 이고 여기서 `'hazard'`
 * fork 를 새로 만든다 — `Hazard.build` 의 `planHazard` 가 같은 fork 로 같은 첫 draw 를 하므로 둘의 답이 늘 같다.
 * (종류가 독성 포자면 `generateLayout` 이 중앙 강하 · 외곽 패드로, `planGroveSpots` 가 중앙 군락으로 간다.)
 */
export function drawHazardKind(root: Random, candidates: readonly HazardKind[], biomeId: string | null = null): HazardKind | null {
  return pickKind(root.fork(HAZARD_FORK), candidates, biomeId);
}

/**
 * **거대 버섯 군락 자리**. `spores` 가 후보에 있는 행성이면 이번 레이드에 어떤 재해가 걸렸든 지형에 선다 —
 * 군락은 그 행성의 생태이지 재해의 부속이 아니다. 그래서 **전용 fork** 를 쓴다: 종류 추첨이 이 자리를
 * 밀지 않는다.
 *
 * 2026-09-13: `central` = 이번 레이드가 독성 포자다 → 군락이 **맵 중앙**(`SPORE_CENTER_RADIUS_M` 안, 강하 지점에서
 * `SPORE_GROVE_SPAWN_GAP_M` 밖)에 선다. 포자가 중앙에서 외곽으로 퍼져 마지막 안전지대가 외곽의 탈출 패드 쪽이 된다.
 */
export function planGroveSpots(bctx: BuildCtx, rng: Random, central = false): Array<{ x: number; z: number }> {
  const want = Math.max(1, rng.int(SPORE_SOURCES_MIN, SPORE_SOURCES_MAX));
  return central ? placeCentralSources(bctx, rng, want) : placeSources(bctx, rng, want);
}

/**
 * 후보 중 하나를 뽑아 이번 레이드의 계획을 만든다. 후보가 비었으면(재해 없는 행성) null.
 *
 * `groveSpots` 는 `planGroveSpots` 가 이미 잡아 둔 군락 자리다 — `spores` 가 걸리면 그 자리가 그대로
 * 발생지가 된다 (사용자 요구: 포자는 거대 버섯 군락에서 피어오른다).
 *
 * `spawn` (2026-09-13) = 강하 지점. 주면 모래 폭풍 · 눈보라 전선이 **강하 지점이 붙은 맵 가장자리 쪽에서** 들어온다
 * (± `HAZARD_FRONT_SPAWN_JITTER_RAD`). 없으면(스모크의 `debugPlanFor`) 옛날처럼 완전 무작위 방향이다. 어느 쪽이든
 * draw 수는 같다.
 */
export function planHazard(
  rng: Random, candidates: readonly HazardKind[], groveSpots: ReadonlyArray<{ x: number; z: number }>,
  biomeId: string | null = null, spawn: { x: number; z: number } | null = null,
): HazardPlan | null {
  const kind = pickKind(rng, candidates, biomeId);
  if (kind === null) return null;

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
    /* 2026-09-13 — 전선은 **강하 지점 쪽 가장자리**에서 들어온다. 예전에는 방향이 완전 무작위라, 재해 시작 1분 뒤에도 강하
     * 지점이 전선 뒤에 있을 확률이 2.7 %, 2분 뒤 25 % 뿐이었다 (실측 2000 시드 — 폭풍의 눈은 시작 순간 47 %). 전선은 맵
     * 반대편 밖에서 시작해 초당 2 m 남짓으로 오므로 대개 분대를 만나기 전에 레이드가 끝났고, 그것이 "모래 폭풍 · 눈보라를
     * 본 적이 없다" 의 정체였다. 강하 지점은 시드의 함수(`layout.spawn`)이므로 와이어가 필요 없다. */
    const jitter = rng.range(-1, 1);
    let ang: number;
    if (spawn && Math.hypot(spawn.x, spawn.z) > HALF * 0.3) {
      // 강하 지점이 붙은 가장자리에서 맵 안쪽을 향하는 방향 (전선의 진행 방향 = 그 가장자리의 안쪽 법선)
      const base = Math.abs(spawn.x) >= Math.abs(spawn.z)
        ? (spawn.x > 0 ? Math.PI : 0)
        : (spawn.z > 0 ? -Math.PI / 2 : Math.PI / 2);
      ang = base + jitter * HAZARD_FRONT_SPAWN_JITTER_RAD;
    } else {
      ang = (jitter + 1) * Math.PI;
    }
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
 * 2026-09-13 — 독성 포자 레이드의 **중앙 군락**. `placeSources` 와 같은 best-of-k 이되 후보를 맵 중심에서
 * `SPORE_CENTER_RADIUS_M` 원반 안에서만 뽑고, 강하 지점(`layout.spawn`, 중앙에 있다)에서 `SPORE_GROVE_SPAWN_GAP_M`
 * 밖이어야 하며, 군락끼리 간격은 `SPORE_CENTER_GROVE_GAP_M` 이다. 원반 안에 자리가 없으면(구조물 · 선로 · 둥지가 가운데를
 * 차지한 시드) 반경을 1.4배 · 1.8배로 넓혀 다시 본다.
 */
function placeCentralSources(bctx: BuildCtx, rng: Random, want: number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  const limit = PLAY_LIMIT - GROVE_RADIUS - 6;
  const spawn = bctx.layout.spawn;
  for (let n = 0; n < want; n++) {
    let bestX = 0, bestZ = 0, bestScore = -Infinity;
    for (let pass = 0; pass < 3 && bestScore < 0; pass++) {
      const reach = Math.min(limit, SPORE_CENTER_RADIUS_M * (1 + pass * 0.4));
      for (let a = 0; a < 220; a++) {
        const ang = rng.range(0, Math.PI * 2);
        const r = reach * Math.sqrt(rng.next());
        const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
        if (Math.abs(x) > limit || Math.abs(z) > limit) continue;
        if (Math.hypot(x - spawn.x, z - spawn.z) < SPORE_GROVE_SPAWN_GAP_M) continue;
        if (padClearance(bctx.layout, x, z, GROVE_PAD_CLEAR) < GROVE_RADIUS) continue;
        if (!isSpotFree(bctx, x, z, GROVE_RADIUS, { maxSlope: 0.28, padExtra: GROVE_PAD_CLEAR, limit })) continue;
        let near = Infinity;
        for (const p of out) near = Math.min(near, Math.hypot(p.x - x, p.z - z));
        if (near < SPORE_CENTER_GROVE_GAP_M && out.length > 0) near -= 1e6;
        if (near > bestScore) { bestScore = near; bestX = x; bestZ = z; }
      }
    }
    if (bestScore === -Infinity) break;
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
