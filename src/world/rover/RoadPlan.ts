/**
 * src/world/rover/RoadPlan.ts — 탐사 차량 흙길의 **매크로 계획** (R1, 2026-09-13).
 *
 * `generateLayout` 이 **선로 · 강하 지점 바로 뒤, 다른 모든 배치 앞**에서 부르고(`rng.fork('rover')` — 부모 스트림을 밀지 않아
 * 선로 · 강하 지점 추첨은 이 변경 전과 같다), 그 뒤의 탈출 패드 · 둥지 · 폐허 · 크레이터 · 구조물이 회랑을 피한다
 * (선로와 같은 규칙: 먼저 선 것이 이긴다).
 *
 * 모양 — 정류장 n(4–5)개를 **맵 중심 둘레의 고른 각도 칸**에 하나씩(± `ROVER_STATION_ANGLE_JITTER`) 세워 서로 최대한 멀리
 * 떨어뜨리고, 이웃 정류장 사이를 **극좌표 보간**(각도는 선형, 반지름은 smoothstep + 구간마다 휨)으로 잇는다. 각도가 늘 한 방향으로
 * 늘기 때문에 고리는 **스스로 교차하지 않는다**(중심에 대해 별 모양 다각형). 반지름이 `ROVER_RING_MIN_M` 아래로 내려가지 않으므로
 * - 순환 선로(원점 중심 원)가 있으면 그 한계를 선로 고리 + 두 회랑 + `ROVER_RAIL_GAP_M` 까지 올린다 → **선로를 가로지르지 않는다**.
 * - 왕복 선로(원점을 지나는 선분)는 `railFree` 에 걸린 점만 반지름을 밀어 고친다(수리) → 역시 가로지르지 않는다.
 * 그래서 선로 건널목 · 경사로는 만들 일이 없다 (계획이 그 경우를 버린다).
 *
 * 순수 함수 — THREE 를 쓰지 않는다.
 */
import {
  MAP_SIZE, RAIL_CLEARANCE_M, ROVER_MIN_TURN_RADIUS_M, ROVER_PLAN_ATTEMPTS, ROVER_PLAN_STEP_M, ROVER_POLE_OFFSET_M,
  ROVER_RAIL_GAP_M, ROVER_RING_MIN_M, ROVER_ROUTE_BOUND_M, ROVER_ROUTE_CLEARANCE_M, ROVER_ROUTE_WIGGLE_M,
  ROVER_SPAWN_GAP_M, ROVER_STATION_ANGLE_JITTER, ROVER_STATION_COUNT_MAX, ROVER_STATION_COUNT_MIN,
  ROVER_STATION_MIN_GAP_M, ROVER_STATION_PAD_R, numberList, type Random,
} from '@/shared';
import type { RoverPlan, RoverRoadIndex } from './model';

const TAU = Math.PI * 2;
/** 격자 칸 크기(m) · 한 칸이 담는 거리(m). 호출자의 `clearance + extra` 는 이보다 작아야 정확하다 (최대 ~45 m). */
const INDEX_CELL = 24;
const INDEX_REACH = 64;
/** 회랑에 걸린 점의 반지름을 밀어 보는 순서(m) — 가까운 것부터. */
const REPAIR_OFFSETS = [4, -4, 8, -8, 12, -12, 18, -18, 26, -26, 36, -36, 48, -48, 62, -62];
/** 정류장 하나를 세우려는 시도 수 (각도 칸 안에서). */
const STATION_TRIES = 16;
/**
 * 표본점 검사의 여유(m). 검사는 `ROVER_PLAN_STEP_M` 간격 **점**에서 하지만 회랑 거리(`roverRouteDistance`)는 점 사이 **선분**을 본다 —
 * 반지름 20 m 원(플랫폼 패드 + 회랑)을 10 m 현이 스치면 0.6 m 까지 안으로 파고든다 (3000 시드에서 실제로 0.55 m). 그 몫이다.
 */
const CHORD_MARGIN = 1.5;

export interface RoadPlanInput {
  /** 반지름 `extra` 짜리 자리가 선로 회랑 · 플랫폼 패드를 건드리지 않는가 (`generateLayout` 의 `railFree`). */
  railFree: (x: number, z: number, extra: number) => boolean;
  /** 순환 선로의 반지름. 선로가 없거나 왕복이면 null. */
  railLoopExtent: number | null;
  /** 강하 지점 부지. */
  spawn: { x: number; z: number; radius: number };
  /**
   * 2026-09-14 (정보상 「탐사 차량 확정」): 시도 횟수를 `ROVER_PLAN_ATTEMPTS_INTEL` 로 크게 늘린다. 굴림은 자기 fork 안에서만
   * 도므로 바깥 스트림은 그대로이고, 평소 성공하는 시드는 **첫 성공에서 빠져나오므로 결과도 그대로**다. 그래도 실패할 수
   * 있고(선로 · 강하 지점이 고리를 막는 시드), 그때는 그냥 null 이다 — 호출자가 경고를 찍는다.
   */
  forcePlan?: boolean;
}

/** 정보상 「탐사 차량 확정」의 재시도 횟수 (`data/tables.csv`). */
const PLAN_ATTEMPTS_INTEL = numberList('tables.csv', 'ROVER_PLAN_ATTEMPTS_INTEL')[0] ?? 1024;

interface Sample { th: number; r: number; fixed: boolean }

/** 계획을 세운다. 시도를 다 써도 못 세우면 null (그 레이드에는 탐사 차량이 없다). */
export function planRoverRoute(rng: Random, input: RoadPlanInput): RoverPlan | null {
  const C = ROVER_ROUTE_CLEARANCE_M;
  const padR = ROVER_STATION_PAD_R;
  const lo = Math.max(2, Math.round(ROVER_STATION_COUNT_MIN));
  const n = rng.int(lo, Math.max(lo, Math.round(ROVER_STATION_COUNT_MAX)));
  const rMin = input.railLoopExtent !== null
    ? Math.max(ROVER_RING_MIN_M, input.railLoopExtent + RAIL_CLEARANCE_M + C + ROVER_RAIL_GAP_M)
    : ROVER_RING_MIN_M;
  const spawn = input.spawn;
  const bound = ROVER_ROUTE_BOUND_M;
  const attempts = Math.max(1, input.forcePlan ? Math.max(ROVER_PLAN_ATTEMPTS, PLAN_ATTEMPTS_INTEL) : ROVER_PLAN_ATTEMPTS);
  let spawnGapRoute = 0, spawnGapStation = 0;

  const routeOk = (th: number, r: number): boolean => {
    if (r < rMin) return false;
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    if (Math.abs(x) > bound || Math.abs(z) > bound) return false;
    if (Math.hypot(x - spawn.x, z - spawn.z) < spawnGapRoute + CHORD_MARGIN) return false;
    return input.railFree(x, z, C + CHORD_MARGIN);
  };

  const slot = TAU / n;
  const jitter = Math.max(0, Math.min(0.45, ROVER_STATION_ANGLE_JITTER));
  for (let attempt = 0; attempt < attempts; attempt++) {
    /* 강하 지점 여유(`ROVER_SPAWN_GAP_M`)는 **시도의 앞 절반에만** 건다. 가장자리 강하 지점이 왕복 선로 끝 플랫폼과 같은 쪽에 서면
     * 그 사이 틈(약 66 m)에 「플랫폼 + 회랑」 과 「강하 지점 + 회랑 + 여유」 가 동시에 들어가지 못한다 (3000 시드 중 19개가 그랬다).
     * 뒤 절반은 여유를 0 으로 — 회랑 자체는 여전히 강하 지점 부지를 비운다. */
    /* 2026-09-14: 문턱은 **평소 시도 수**의 절반이다 — 정보상으로 시도를 늘려도 앞 `ROVER_PLAN_ATTEMPTS` 번은
     * 굴림도 판정도 평소와 한 글자도 같다 (평소 성공하던 시드가 다른 경로를 내지 않는다). */
    const spawnGap = attempt < ROVER_PLAN_ATTEMPTS / 2 ? ROVER_SPAWN_GAP_M : 0;
    spawnGapRoute = spawn.radius + C + spawnGap;
    spawnGapStation = spawn.radius + padR + spawnGap;
    const a0 = rng.range(0, TAU);
    const th: number[] = [];
    const rs: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < STATION_TRIES; k++) {
        const t = a0 + i * slot + rng.range(-jitter, jitter) * slot;
        const hi = (bound - padR) / Math.max(Math.abs(Math.cos(t)), Math.abs(Math.sin(t)));
        if (hi < rMin) continue;
        const r = rng.range(rMin, hi);
        const x = Math.cos(t) * r, z = Math.sin(t) * r;
        if (Math.hypot(x - spawn.x, z - spawn.z) < spawnGapStation) continue;
        if (!input.railFree(x, z, padR + 4)) continue;
        if (!routeOk(t, r)) continue;
        th.push(t); rs.push(r);
        break;
      }
      if (th.length !== i + 1) break;
    }
    if (th.length !== n) continue;

    let gapOk = true;
    for (let i = 0; i < n && gapOk; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(Math.cos(th[i]) * rs[i] - Math.cos(th[j]) * rs[j], Math.sin(th[i]) * rs[i] - Math.sin(th[j]) * rs[j]);
        if (d < ROVER_STATION_MIN_GAP_M) { gapOk = false; break; }
      }
    }
    if (!gapOk) continue;

    /* 구간 표본 — 정류장 표본(`fixed`)은 움직이지 않는다 */
    const samples: Sample[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const t0 = th[i];
      const t1 = j === 0 ? th[0] + TAU : th[j];
      const r0 = rs[i], r1 = rs[j];
      const span = t1 - t0;
      const k = Math.max(3, Math.ceil(((r0 + r1) / 2) * span / Math.max(2, ROVER_PLAN_STEP_M)));
      const wig = rng.range(-ROVER_ROUTE_WIGGLE_M, ROVER_ROUTE_WIGGLE_M);
      for (let q = 0; q < k; q++) {
        const u = q / k;
        const e = u * u * (3 - 2 * u);
        samples.push({ th: t0 + span * u, r: r0 + (r1 - r0) * e + wig * Math.sin(Math.PI * u), fixed: q === 0 });
      }
    }

    /* 수리 + 평활화: 회랑에 걸린 점의 반지름을 밀고, 그 턱을 [1,2,1]/4 로 편다 */
    const m = samples.length;
    const src = new Float64Array(m);
    for (let round = 0; round < 6; round++) {
      let bad = 0;
      for (const s of samples) {
        if (s.fixed || routeOk(s.th, s.r)) continue;
        bad++;
        for (const dr of REPAIR_OFFSETS) {
          if (routeOk(s.th, s.r + dr)) { s.r += dr; break; }
        }
      }
      if (bad === 0 && round > 0) break;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < m; i++) src[i] = samples[i].r;
        for (let i = 0; i < m; i++) {
          if (samples[i].fixed) continue;
          samples[i].r = (src[(i - 1 + m) % m] + 2 * src[i] + src[(i + 1) % m]) / 4;
        }
      }
    }
    if (!samples.every((s) => routeOk(s.th, s.r))) continue;

    const points = samples.map((s) => ({ x: Math.cos(s.th) * s.r, z: Math.sin(s.th) * s.r }));
    if (minTurnRadius(points) < ROVER_MIN_TURN_RADIUS_M) continue;

    const stations: RoverPlan['stations'] = [];
    for (let i = 0; i < m; i++) {
      if (!samples[i].fixed) continue;
      const p = points[i];
      const a = points[(i - 1 + m) % m], b = points[(i + 1) % m];
      const tl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      let nx = -(b.z - a.z) / tl, nz = (b.x - a.x) / tl;
      if (nx * p.x + nz * p.z < 0) { nx = -nx; nz = -nz; }        // 맵 바깥쪽
      stations.push({ x: p.x, z: p.z, poleX: p.x + nx * ROVER_POLE_OFFSET_M, poleZ: p.z + nz * ROVER_POLE_OFFSET_M });
    }
    return { points, stations, padRadius: padR, index: buildIndex(points) };
  }
  return null;
}

/** 닫힌 점열의 최소 회전 반경(m) — 연속한 세 점의 외접원 반지름. */
export function minTurnRadius(pts: readonly { x: number; z: number }[]): number {
  const m = pts.length;
  let best = Infinity;
  for (let i = 0; i < m; i++) {
    const a = pts[(i - 1 + m) % m], b = pts[i], c = pts[(i + 1) % m];
    const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ca = Math.hypot(a.x - c.x, a.z - c.z);
    const cross = Math.abs((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x));
    if (cross < 1e-6) continue;
    const r = (ab * bc * ca) / (2 * cross);
    if (r < best) best = r;
  }
  return best;
}

function buildIndex(pts: readonly { x: number; z: number }[]): RoverRoadIndex {
  const half = MAP_SIZE / 2;
  const cols = Math.ceil(MAP_SIZE / INDEX_CELL);
  const cells: number[][] = [];
  for (let i = 0; i < cols * cols; i++) cells.push([]);
  const m = pts.length;
  const clampC = (v: number): number => Math.max(0, Math.min(cols - 1, Math.floor((v + half) / INDEX_CELL)));
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    const c0 = clampC(Math.min(a.x, b.x) - INDEX_REACH), c1 = clampC(Math.max(a.x, b.x) + INDEX_REACH);
    const r0 = clampC(Math.min(a.z, b.z) - INDEX_REACH), r1 = clampC(Math.max(a.z, b.z) + INDEX_REACH);
    for (let cz = r0; cz <= r1; cz++) for (let cx = c0; cx <= c1; cx++) cells[cz * cols + cx].push(i);
  }
  return { cell: INDEX_CELL, cols, half, reach: INDEX_REACH, cells };
}

/**
 * `(x, z)` 에서 흙길 **중심선**까지의 XZ 거리(m). `index.reach` 이상 떨어져 있으면 `reach` 를 돌려준다 (그보다 먼 값은
 * 필요 없다 — 호출자는 `clearance + 반지름` 과만 비교한다).
 */
export function roverRouteDistance(plan: RoverPlan, x: number, z: number): number {
  const ix = plan.index;
  const cx = Math.floor((x + ix.half) / ix.cell), cz = Math.floor((z + ix.half) / ix.cell);
  if (cx < 0 || cz < 0 || cx >= ix.cols || cz >= ix.cols) return ix.reach;
  const list = ix.cells[cz * ix.cols + cx];
  const pts = plan.points;
  const m = pts.length;
  let best2 = ix.reach * ix.reach;
  for (let k = 0; k < list.length; k++) {
    const a = pts[list[k]], b = pts[(list[k] + 1) % m];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
    const px = a.x + dx * t - x, pz = a.z + dz * t - z;
    const d2 = px * px + pz * pz;
    if (d2 < best2) best2 = d2;
  }
  return Math.sqrt(best2);
}
