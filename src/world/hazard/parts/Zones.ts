/**
 * src/world/hazard/parts/Zones.ts — 계획 + `missionTime` → **도형**.
 *
 * `HazardRef.getZones()` 가 돌려주는 것이 전부 여기서 나온다. 규약은 계약(`shared/types.HazardZone`)이
 * 정한 그대로다:
 *
 *   - `front` = 반평면. 전선은 `center` 를 지나고 법선이 `(dirX, dirZ)` = **진행 방향**이며,
 *     **법선의 반대편**(이미 지나온 쪽)이 위험이다. ui/ 의 지도 · 안전 방향 화살표가 그렇게 읽는다.
 *   - `circle` + `safeInside:true` = 폭풍의 눈. 원 **밖**이 위험.
 *   - `circle` + `safeInside:false` = 독성 포자. 원 **안**이 위험.
 *
 * 배열 하나를 재사용한다 (계약: "읽고 바로 쓴다"). 도형 객체도 재사용하므로 프레임당 할당이 0이다.
 */
import {
  HAZARD_EDGE_M, HAZARD_FULL_S, MAP_SIZE, STORM_EYE_RADIUS_END, STORM_EYE_RADIUS_START, STORM_EYE_START_MARGIN_M, type HazardZone,
} from '@/shared';
import { type HazardPlan, isFrontKind } from '../model';

const HALF = MAP_SIZE / 2;
/**
 * 전선이 맵 밖에서 시작해 맵 밖으로 나가도록 양끝에 두는 여유(m). 없으면 progress 0 · 1 에서 전선이 정확히
 * 모서리(축에 나란한 방향이면 **변 전체**)에 걸쳐 부호 0 이 되고, "아직 아무 데도 위험하지 않다" 와
 * "이제 안전지대가 없다" 가 그 줄에서만 어긋난다.
 */
const FRONT_MARGIN = HAZARD_EDGE_M > 0 ? HAZARD_EDGE_M : 8;

/** 0..1 — 1 이면 맵을 다 덮었다. */
export function progressAt(plan: HazardPlan, missionTime: number): number {
  if (missionTime < plan.startsAt) return 0;
  if (HAZARD_FULL_S <= 0) return 1;
  const t = (missionTime - plan.startsAt) / HAZARD_FULL_S;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * 2026-09-13 (사용자 결정) — 폭풍의 눈의 **처음 반경 = 눈 중심에서 가장 먼 맵 꼭짓점까지의 거리**(+`STORM_EYE_START_MARGIN_M`).
 * 그래서 시작 순간에는 맵 사각형 전체가 원 안(안전)이고, 거기서 `HAZARD_FULL_S` 에 걸쳐 서서히 좁아진다. 예전의 고정 300 m 는
 * 시작하자마자 맵의 평균 43 % 를 한꺼번에 삼켰다 (강하 지점이 그 안에 들어 있을 확률 47 %). `STORM_EYE_RADIUS_START` 는 하한으로만
 * 남는다. 계획(`HazardPlan`)에 필드를 더하지 않고 눈 중심에서 매번 계산하므로 옛 호스트의 `hz sync` 도 같은 답을 낸다.
 */
export function stormEyeStartRadius(plan: Pick<HazardPlan, 'eyeX' | 'eyeZ'>): number {
  const far = Math.hypot(HALF + Math.abs(plan.eyeX), HALF + Math.abs(plan.eyeZ)) + STORM_EYE_START_MARGIN_M;
  return far > STORM_EYE_RADIUS_START ? far : STORM_EYE_RADIUS_START;
}

/** 빈 도형 하나 (풀에서 꺼내 쓴다). */
function blank(id: string): HazardZone {
  return { id, shape: 'circle', center: { x: 0, z: 0 }, radius: 0, dirX: 0, dirZ: 0, safeInside: false };
}

/**
 * `out` 을 이번 `missionTime` 의 도형으로 채운다 (길이 조절 포함). 재해가 아직 시작하지 않았으면 비운다.
 * `pool` 은 도형 객체를 재사용하기 위한 것으로, 호출자가 계속 들고 있는 같은 배열이다.
 */
export function buildZones(plan: HazardPlan, missionTime: number, pool: HazardZone[], out: HazardZone[]): void {
  out.length = 0;
  if (missionTime < plan.startsAt) return;
  const progress = progressAt(plan, missionTime);

  const take = (i: number, id: string): HazardZone => {
    while (pool.length <= i) pool.push(blank(`hz_${pool.length}`));
    const z = pool[i];
    z.id = id;
    return z;
  };

  if (isFrontKind(plan.kind)) {
    /* 전선이 맵 밖 한쪽에서 시작해 반대편 밖까지 `HAZARD_FULL_S` 에 걸쳐 지나간다.
     * 정사각 맵을 법선에 투영한 반폭(+`FRONT_MARGIN`)이 `span` 이라, s 를 −span → +span 으로 밀면
     * progress 0 에서는 맵 위에 위험한 점이 하나도 없고 1 에서는 **전부** 위험하다 (검증: 16방향 ×
     * 17×17 표본에서 양끝 실패 0). */
    const span = HALF * (Math.abs(plan.dirX) + Math.abs(plan.dirZ)) + FRONT_MARGIN;
    const s = -span + progress * 2 * span;
    const z = take(0, 'hz_front');
    z.shape = 'front';
    z.center.x = plan.dirX * s;
    z.center.z = plan.dirZ * s;
    z.radius = 0;
    z.dirX = plan.dirX;
    z.dirZ = plan.dirZ;
    z.safeInside = false;
    out.push(z);
    return;
  }

  if (plan.kind === 'storm_eye') {
    const z = take(0, 'hz_eye');
    z.shape = 'circle';
    z.center.x = plan.eyeX;
    z.center.z = plan.eyeZ;
    const r0 = stormEyeStartRadius(plan);
    z.radius = r0 + (STORM_EYE_RADIUS_END - r0) * progress;
    z.dirX = 0;
    z.dirZ = 0;
    z.safeInside = true;
    out.push(z);
    return;
  }

  // 독성 포자: 이미 피어오른 발생지마다 원 하나. 아직인 발생지는 도형이 없다 (지도에는 군락만 뜬다).
  for (let i = 0; i < plan.sources.length; i++) {
    const src = plan.sources[i];
    if (missionTime < src.eruptAt) continue;
    const grown = (missionTime - src.eruptAt) * src.growthMps;
    const r = grown < plan.sourceRadius ? grown : plan.sourceRadius;
    if (r <= 0.01) continue;
    const z = take(out.length, `hz_spore_${i}`);
    z.shape = 'circle';
    z.center.x = src.x;
    z.center.z = src.z;
    z.radius = r;
    z.dirX = 0;
    z.dirZ = 0;
    z.safeInside = false;
    out.push(z);
  }
}

/**
 * `(x, z)` 가 이 도형의 **위험 영역** 안으로 얼마나 들어가 있나(m). 음수면 밖이다.
 * `isInside` 도 경계 페더도 이 하나만 본다.
 */
export function zoneDepth(z: HazardZone, x: number, dz: number): number {
  if (z.shape === 'front') {
    // 법선 방향 부호거리. 양수 = 아직 전선 앞(안전), 음수 = 이미 지나온 쪽(위험)
    return -((x - z.center.x) * z.dirX + (dz - z.center.z) * z.dirZ);
  }
  const d = Math.hypot(x - z.center.x, dz - z.center.z);
  return z.safeInside ? d - z.radius : z.radius - d;
}

/** 도형 전부에 대한 최대 침투 깊이(m). 음수면 어느 위험 구역에도 들어가 있지 않다. */
export function maxDepth(zones: readonly HazardZone[], x: number, z: number): number {
  let best = -Infinity;
  for (let i = 0; i < zones.length; i++) {
    const d = zoneDepth(zones[i], x, z);
    if (d > best) best = d;
  }
  return best;
}
