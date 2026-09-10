/**
 * src/world/rails/model.ts — 선로 · 전차 파트가 공유하는 **어휘**. 상태는 없다.
 *
 * 선로의 진짜 상태는 **선로 위 진행거리 `s` 하나**다 (`TramDef.s`). 경로는 시드 결정적이라 어느
 * 클라이언트에서 계산해도 같은 점열이 나오고, 그래서 멀티에서 흐르는 것은 `s` · 방향 · 상태뿐이다.
 */
import * as THREE from 'three';
import type { TramDef } from '@/shared';
import type { ObstacleEntry } from '../SpatialHash';
import type { ContainerSpec } from '../structures/parts/Containers';

/**
 * 레일 상면이 지형 위로 뜨는 높이(m). 교각이 이 높이를 맞춘다.
 *
 * 2026-09-10: **1.7 → 0.75** (사용자 결정 — "선로가 땅보다 약간 위에 떠 있게"). 이 높이는
 * `PROP_STEP_UP_MAX`(0.9) 안이라 **땅에서 그냥 올라설 수 있다** — 그것이 "선로 위로 다닐 수 있도록" 의
 * 조건이다. 더 높이면(예전 1.7) 발판 콜라이더가 맵을 가로지르는 담이 된다: 올라설 수도 없고
 * (`getSurfaceY` 의 오르막 제한), 밑으로 지나갈 수도 없다 (`obb.BOX_HEADROOM` 2.1 보다 낮다).
 */
export const RAIL_DECK_Y = 0.75;
/** 침목 간격(m). 2026-09-10: 3.2 → 1.8 (침목 사이가 훤히 비어 "빠질 것 같다" 로 보였다). */
export const TIE_STEP = 1.8;
/** 교각 간격(m). 2026-09-10: 13 → 9 — 낮아진 선로에서도 기둥이 중간중간 보이도록. */
export const PIER_STEP = 9;
/** 두 레일 사이 간격의 절반(m). */
export const GAUGE_HALF = 0.9;
/**
 * 2026-09-10 — **걸어 다니는 선로 발판**의 콜라이더 치수. 예전에는 교각만 콜라이더라 선로가 그림일
 * 뿐이었고 침목 사이로 그대로 빠졌다. 침목보다 성긴 간격으로 얇은 상자를 이어 붙인다.
 *
 * **5 → 3 (2026-09-10, 두 번째 배치).** 발판 상자는 평평한데 선로는 기울어 있으므로, 상자 윗면은
 * 자기 중점의 높이이고 양 끝에서 최대 `RAIL_DECK_STEP/2 × RAIL_MAX_GRADE` 만큼 어긋난다. 그 오차가
 * **`TRAM_FLOOR_UP`(0.35) 이상이면 전차 옆의 선로 발판이 전차 바닥과 같은 높이가 되고**,
 * `getStandingObstacle` 이 둘 중 하나를 **동점으로 아무거나** 고른다 — 선로 발판이 뽑히면 `velocity` 가
 * 없으므로 **탑승이 시작되지 않는다** (시드 1234 에서 실제로 그랬다: 오차가 정확히 0.35 였다).
 * 5 m 면 0.35 로 딱 경계, 3 m 면 0.21 이라 여유가 생긴다. 이 관계(`step/2 × grade < TRAM_FLOOR_UP`)를
 * 깨는 값으로 바꾸지 않는다.
 */
export const RAIL_DECK_STEP = 3;
/** 발판 상자의 두께(m). 윗면이 레일 상면과 같은 높이가 되게 밑으로 판다. */
export const RAIL_DECK_T = 0.3;
/** 발판 반폭(m) — 침목 폭과 같다. */
export const RAIL_DECK_HALF_W = GAUGE_HALF + 0.25;
/** 들어 올린 선로가 이웃 점과 벌어질 수 있는 최대 경사 (구간 길이 대비). */
export const RAIL_MAX_GRADE = 0.14;
/** 전차가 플랫폼에 "닿았다" 고 보는 거리(m, 선로 위 거리 기준). */
export const DOCK_WINDOW = 4;
/** 호스트가 전차 상태를 방송하는 주기(초). 경로가 결정적이라 이 정도로 충분하다. */
export const TRAM_NET_INTERVAL = 0.25;
/** 클라이언트가 받은 `s` 와 이만큼(m) 넘게 벌어지면 보간하지 않고 그냥 맞춘다. */
export const TRAM_SNAP_M = 8;
/**
 * 플랫폼 데크 중심이 선로 중심선에서 옆으로 물러나는 거리(m).
 * `data/structures.csv` 의 `rail_platform.halfD`(4.5) + `tram.halfW`(1.9) 에 **0.05 만** 더한 값이다 —
 * 데크 안쪽 모서리를 전차 옆구리에 거의 붙여야 정차했을 때 **틈 없이 걸어서 탄다**. 여기를 넓히면
 * 그 틈으로 떨어진다 (발판 질의는 점 하나만 본다).
 */
export const PLATFORM_OFFSET = 6.45;

/** 시드 결정적인 선로 중심선. `loop` 이면 마지막 → 첫 점이 이어지는 닫힌 고리다. */
export interface RailPath {
  pts: THREE.Vector3[];
  /** 구간 누적 길이 (`cum[0] = 0`, 길이 = 구간 수 + 1). */
  cum: number[];
  total: number;
  loop: boolean;
}

/** 점열에서 누적 길이를 만든다. */
export function makePath(pts: THREE.Vector3[], loop: boolean): RailPath {
  const segs = loop ? pts.length : pts.length - 1;
  const cum = [0];
  let total = 0;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    total += Math.hypot(b.x - a.x, b.z - a.z);
    cum.push(total);
  }
  return { pts, cum, total, loop };
}

/** `s` 를 경로 범위로 접는다 (`loop` 은 감고, `line` 은 끝에서 멈춘다). */
export function wrapS(path: RailPath, s: number): number {
  if (!path.loop) return Math.max(0, Math.min(path.total, s));
  const t = s % path.total;
  return t < 0 ? t + path.total : t;
}

/** 진행거리 `s` 의 위치와 접선. `outTan` 은 정규화된 XZ 방향(수평)이다. */
export function sampleAt(path: RailPath, s: number, outPos: THREE.Vector3, outTan: THREE.Vector3): void {
  const q = wrapS(path, s);
  let lo = 0, hi = path.cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (path.cum[mid] <= q) lo = mid; else hi = mid;
  }
  const a = path.pts[lo], b = path.pts[(lo + 1) % path.pts.length];
  const segLen = Math.max(1e-4, path.cum[lo + 1] - path.cum[lo]);
  const t = Math.max(0, Math.min(1, (q - path.cum[lo]) / segLen));
  outPos.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  const dx = b.x - a.x, dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  outTan.set(dx / l, 0, dz / l);
}

/** `(x, z)` 에 가장 가까운 경로 위 진행거리 (플랫폼을 선로에 붙일 때). */
export function nearestS(path: RailPath, x: number, z: number): number {
  const segs = path.loop ? path.pts.length : path.pts.length - 1;
  let bestS = 0, bestD = Infinity;
  for (let i = 0; i < segs; i++) {
    const a = path.pts[i], b = path.pts[(i + 1) % path.pts.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
    const px = a.x + dx * t, pz = a.z + dz * t;
    const d = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d < bestD) { bestD = d; bestS = path.cum[i] + Math.sqrt(len2) * t; }
  }
  return bestS;
}

/** `loop` 은 감긴 최단 차이, `line` 은 그냥 차이. */
export function deltaS(path: RailPath, from: number, to: number): number {
  let d = to - from;
  if (!path.loop) return d;
  const h = path.total / 2;
  while (d > h) d -= path.total;
  while (d < -h) d += path.total;
  return d;
}

/* ══ 전차 차체 (2026-09-10 — 진행 방향으로 길쭉하게 다시 짰다) ═══════════════════════════════════════
 *
 * **로컬 축 규약**: `로컬 +X = 진행 방향(차 길이)`, `로컬 +Z = 좌우(차 폭)`, `로컬 +Y = 위`.
 * 선로 발판 · 침목 · 플랫폼 데크가 전부 같은 규약을 쓴다 (`Obstacle.box.yaw` 는 수학 규약이라
 * 로컬 +X → 월드 `(cos yaw, sin yaw)` = 선로 접선이고, 같은 상자를 그리는 메시의 Euler 는 `-yaw` 다).
 *
 * 2026-09-10 이전에는 차체 지오메트리만 이 규약을 어겼다 — `structures.csv` 의 `halfW`(1.9, 반**폭**)를
 * 로컬 X 에, `halfD`(6, 반**길이**)를 로컬 Z 에 넣어 **선로와 수직으로 12 m 짜리 판때기**가 달렸다.
 * 치수는 그대로 두고 축만 바로잡았다 (`PLATFORM_OFFSET` 이 이미 `halfW` 를 옆으로 물러나는 거리로
 * 쓰고 있었으니, csv 의 의도는 처음부터 이쪽이었다).
 */
/** 전차 바닥이 레일 상면 위로 뜨는 높이(m). 플랫폼 데크 윗면도 같은 높이라 그냥 걸어 건넌다. */
export const TRAM_FLOOR_UP = 0.35;
/** 승강구의 반길이(m, **진행 방향**). 옆판 가운데를 양쪽 다 비운다 (왕복 선로에서 플랫폼이 반대편에 온다). */
export const TRAM_DOOR_HALF = 1.4;
/** 바닥판 두께(m). 이 상자의 **윗면이 곧 걸어 다니는 데크**이고 탑승 판정의 기준면이다. */
export const TRAM_FLOOR_T = 0.3;
/** 옆판 두께(m). */
export const TRAM_WALL_T = 0.24;
/** 옆판 높이(m) — 허리 높이. 위가 열려 있어야 3인칭 카메라가 갇히지 않는다 (무개차). */
export const TRAM_WALL_H = 1.05;
/** 앞 격벽(기수)의 두께(m). 차체 앞 끝을 막는 판이고 그 뒤가 운전실이다. */
export const TRAM_NOSE_T = 0.3;
/** 운전실 길이(m, 진행 방향) — 앞 격벽 뒤로 이만큼이 **걸어 들어가는** 공간이다. */
export const TRAM_CAB_LEN = 2.2;
/** 운전 콘솔 데스크: 반길이 · 반폭 · 높이(m). 격벽에 등을 대고 선다. */
export const TRAM_DESK_HALF_L = 0.3;
export const TRAM_DESK_HALF_W = 0.85;
export const TRAM_DESK_H = 1.05;

/** 차체와 함께 움직이는 콜라이더 한 조각. 오프셋은 **로컬** (`ox` = 길이 방향, `oz` = 폭 방향). */
export interface MovingPart {
  entry: ObstacleEntry;
  ox: number; oz: number;
  /** 상자 밑면의 y 오프셋 (전차 바닥 기준). */
  oy: number;
}

/** 전차 한 대의 살아 있는 상태. `Rails` 가 하나만 들고 `rails/parts/Tram` 이 굴린다. */
export interface TramInst {
  def: TramDef;
  root: THREE.Group;
  parts: MovingPart[];
  /** 모든 발판 콜라이더가 **같은 객체**를 참조한다 — 제자리에서 고치면 다 같이 바뀐다. */
  vel: THREE.Vector3;
  containers: { spec: ContainerSpec; ox: number; oz: number; oy: number }[];
  /** 운전실 콘솔의 **살아 있는** 위치 (`Interactable.position` 이 바로 이 객체다). */
  consolePos: THREE.Vector3;
  /** 차체 반길이 · 반폭 · 벽 높이(m) — 충돌 판정이 매 프레임 읽는다. */
  halfLen: number; halfWid: number; wallH: number;
  dockTimer: number;
  /**
   * 2026-09-10 — 이번 주행을 시작한 뒤 흐른 시간(초). 시동 알림이 뜬 순간 `-TRAM_START_DELAY_S` 로 놓이므로
   * **음수인 동안은 서 있고**, 0 을 넘으면 `TRAM_ACCEL_S` 에 걸쳐 cubic ease-in 으로 `TRAM_SPEED` 까지 오른다.
   * 클라이언트도 같은 값을 굴린다 — 위치는 호스트의 `s` 로 보정되지만 발판 속도(`vel`)는 스스로 계산한다.
   */
  runT: number;
  lastDock: string | null;
  /** 클라이언트가 맞춰 갈 호스트의 `s` (호스트에서는 쓰지 않는다). */
  targetS: number;
  /** 로컬 플레이어를 다시 칠 수 있게 되기까지 남은 시간(초). */
  hitCooldown: number;
}

/* ── 색 · 빌드 싱크 (2026-09-10, `parts/` 분할) ──────────────────────────────────────────────────────
 * `Rails` 는 병합 지오메트리 · 머티리얼을 스스로 dispose 하므로, 파트가 만든 것을 **여기에 넣어** 돌려준다.
 * 값(THREE.Color)을 쓰지만 이 모듈은 `data-check` 가 이르게 읽는 축(`structures/model` · `hazard/model`)이
 * 아니므로 문제되지 않는다.
 */
export const STEEL = new THREE.Color(0x6a6f76);
export const STEEL_DARK = new THREE.Color(0x33383e);
export const TIE_COLOR = new THREE.Color(0x4a423a);
export const DECK = new THREE.Color(0x6d6a63);
export const DECK_DARK = new THREE.Color(0x45433e);
/** 운전실 유리 · 콘솔 화면. */
export const GLASS = new THREE.Color(0x1b3742);
export const SCREEN = new THREE.Color(0x2f8ea8);
/**
 * 플랫폼 호출 콘솔의 **발광** 색 (2026-09-10). 이 색만 별도 emissive 머티리얼로 그린다 —
 * 선로 본체는 버텍스 컬러 한 장뿐이라 화면이 스스로 빛나지 않아 "조작하는 물건" 으로 읽히지 않았다.
 */
export const CONSOLE_GLOW = new THREE.Color(0x59d8ff);
/** 그 머티리얼의 (거의 검은) 확산색 — 다른 폴더의 발광물이 쓰는 패턴 그대로다. */
export const CONSOLE_GLOW_BASE = new THREE.Color(0x0a1c22);

/** 파트가 만든 것을 넘겨받는 곳. `Rails.dispose` 가 여기 담긴 것을 전부 버린다. */
export interface RailBuild {
  geos: THREE.BufferGeometry[];
  group: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  /**
   * 발광 조각(호출 콘솔의 화면 · 띠 · 버튼). 파트는 여기에 **월드 좌표 지오메트리**만 넣고,
   * `Rails.build` 가 플랫폼을 다 세운 뒤 **한 덩어리**로 합쳐 emissive 메시 하나를 만든다.
   * 움직이는 물건(전차)의 발광은 여기 넣지 않는다 — 합친 메시는 제자리에 남는다.
   */
  glow: THREE.BufferGeometry[];
}
