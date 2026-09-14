import * as THREE from 'three';
import { TUTORIAL_ENEMY_LEASH_M, TUTORIAL_ENEMY_SENSE_M, type TutorialCheckpointId, type TutorialFallRule } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * 튜토리얼 행성 — **맵의 모양 그 자체** (2026-09-14, `docs/plans/tutorial-raid.md` A절).
 *
 * 이 파일은 `world/tutorial/` 의 공용 어휘다 (`CLAUDE.md` 의 `model.ts` + `parts/` 규약): 좌표 · 치수 · 타입 ·
 * 작은 기하 헬퍼만 있고 상태는 없다. **여기 있는 숫자는 csv 로 나가지 않는다** — 밸런스 수치가 아니라 손으로
 * 지은 지형의 형상이기 때문이고, `TrainingArena.ts` 가 같은 판단을 먼저 했다 (레인 x · 사선 z · 천장 높이).
 * 밸런스인 것(적 감지 · 이탈 · 낙하 피해 · 부활 지연)은 전부 `data/constants.csv` 에서 import 한다.
 *
 * ## 좌표 규약
 * **앞 = −Z** 다 (플레이어 yaw 0 의 정면 = `(-sin 0, 0, -cos 0)` = −Z). 그래서 아래의 모든 z 는 **큰 값에서
 * 작은 값으로** 흘러가고 (`z0 > z1`), 구간 순서를 읽는 것이 곧 플레이 순서를 읽는 것이다.
 * **+x = 걸어가는 플레이어의 오른쪽**이다: 오른쪽 = forward × up = `(0,0,−1) × (0,1,0)` = `(1,0,0)`.
 * (그래서 아래 적 · 소품 주석의 「왼쪽」은 x < 0, 「오른쪽」은 x > 0 이다.)
 * x 는 좌우이고 통로의 반폭은 **구간마다 다르다**(`CORRIDOR_PROFILE` · `corridorHalfXAt`), 그 바깥은 통째로
 * 절벽 벽이라 플레이어가 통로를 벗어날 길이 없다.
 *
 * ## 왜 지형(높이장)이 아니라 「데크 상자」인가
 * 절벽 둘이 이 맵의 핵심인데, 높이장은 **수직면을 만들 수 없다**. 1 m 격자에 10 m 를 떨어뜨리면 84° 경사가 되고,
 * 84° 는 `PlayerController` 의 `STEEP_COS`(50°) 를 넘어 **미끄러져 내려간다** — 낙하 피해가 0 이고(계속 접지다)
 * 「달려서 건넌다 · 뛰어내린다」가 둘 다 사라진다. 그래서 바닥(`VOID_Y`)은 평평한 판 하나로 두고, 걸어 다니는
 * 데크를 **사각 콜라이더**(`SpatialHash.addBox`)로 세운다: 옆면은 완전한 벽이고 가장자리를 넘으면 그대로 떨어진다.
 * 구조물의 바닥판 · 전차 데크가 이미 그렇게 살고 있어서 `getSurfaceY` · `resolveCollision` 은 한 줄도 안 바뀐다.
 * 절벽 1 의 가장자리만 **사선**이라 회전 OBB 두 장을 더 쓴다 (아래 `CHASM_TILT` 절).
 * ──────────────────────────────────────────────────────────────────────────── */

/* ── 층 높이 ──────────────────────────────────────────────────────────────── */

/** 바닥(협곡 밑). 절벽 1 에 빠지면 여기까지 떨어진다 — 규칙이 `kill` 이라 높이는 연출이다. */
export const VOID_Y = -34;
/** 앞쪽 절반(기상 ~ 안드로이드 1조)이 서 있는 데크 윗면. */
export const DECK_UPPER_Y = 0;
/** 절벽 2 아래, 뒤쪽 절반(보급 ~ 함선)의 데크 윗면. 낙차 10 m = `FALL_DAMAGE` 로 45 — 아프지만 죽지 않는다. */
export const DECK_LOWER_Y = -10;
/** 절벽 2 의 낙차 (m). 표시 · 검산용. */
export const CLIFF_DROP_M = DECK_UPPER_Y - DECK_LOWER_Y;

/* ── 통로 ────────────────────────────────────────────────────────────────── */

/**
 * **전투 구역**의 반폭. 2026-09-14 3차 사용자 결정으로 22 → **15.4**(−30 %) — 2차의 「너무 넓다」가 전투 구역에도
 * 남아 있었다. 엄폐 · 회피 여지를 남겨야 하는 곳만 이 폭을 지킨다 — 4차부터는 **안드로이드 구간과 마지막
 * 구간 둘뿐**이다 (벌레 구간은 `CORRIDOR_BUG_HALF_X` 로 내려갔다).
 * 데크 · 벽 바깥 면 · 트리거 볼륨의 기준이기도 하므로 **구간 폭 중 가장 큰 값이어야 한다**.
 */
export const CORRIDOR_MAX_HALF_X = 15.4;
/**
 * **지나가는 구간**의 반폭 — 2026-09-14 2차 사용자 결정(「너무 넓어서 어디로 가야 할지 잘 모르겠다」)으로
 * 전투가 없는 구간을 절반으로 줄였다. 걷기 · 달려 뛰기 · 포복 · 낙하 · 보급이 전부 이 폭이다 (3차: 7.7).
 */
export const CORRIDOR_PASS_HALF_X = CORRIDOR_MAX_HALF_X / 2;
/**
 * **벌레 구간**(z 62 … 0)의 반폭 — 2026-09-14 4차 사용자 결정으로 15.4 → **4.6**(−70 %). 여기는 엄폐가 필요한
 * 전투장이 아니라 **처음 총을 쏴 보는 목**이라 넓을 이유가 없었다: 넓으면 벌레 둘이 좌우로 흩어져 어디를
 * 봐야 할지 모른다. 지나가는 구간(7.7)보다도 **좁아** 프로파일이 「좁아졌다 다시 넓어지는」 모양이 되는데
 * 그것이 의도다 — 목이 좁아야 벌레가 정면에 선다. 통과 폭 9.2 m 는 플레이어 지름(0.9)의 10 배라 좌우로
 * 피할 여지는 남고, 벌레(`radius` 0.45)를 x ±2.5 에 세워도 벽 안쪽 면까지 1 m 가까이 남는다.
 */
export const CORRIDOR_BUG_HALF_X = 4.6;
/** 통로 양옆 절벽 벽의 두께 (안쪽 면은 구간마다 다르다 — `corridorHalfXAt`). */
export const WALL_T = 3;
/**
 * 절벽 벽의 **바깥** 면. 구간 폭과 무관하게 이 x 까지 통째로 바위다 — 좁은 구간에서 벽 두께만큼만 세우면
 * 그 뒤(넓은 데크가 계속 깔려 있다)가 뚫려 보이고, 깔때기 이음매에 사람이 빠질 구멍이 생긴다.
 */
export const CORRIDOR_OUTER_X = CORRIDOR_MAX_HALF_X + WALL_T;
/** 절벽 벽의 윗면 (위 데크에서 18 m). 하늘은 열려 있고 옆으로는 나갈 수 없다. */
export const WALL_TOP_Y = 18;

/** 통로 반폭 프로파일의 제어점. */
export interface CorridorPoint { readonly z: number; readonly halfX: number }

/**
 * **구간별 통로 반폭** (z 내림차순 = 플레이 순서). 이웃한 두 제어점의 폭이 같으면 곧은 구간, 다르면
 * 그 사이가 **깔때기**(선형 보간)다. 깔때기는 `parts/Ground` 가 비스듬한 판(회전 OBB) 하나로 세우므로
 * 계단 턱이 없고 몸이 낄 자리도 없다.
 *
 * 적이 서는 구간 셋과 그 폭의 근거:
 *   z  62 …   0 — 벌레 두 마리 (스폰 z 34 · 28). 체크포인트 `bugs`(60) ~ `crawl`(−10) 구간.
 *                 2026-09-14 3차: 26 → **62 m** 로 늘리고 벌레를 안쪽 깊숙이 세웠다 — 「좀더 멀리서 보이도록」.
 *                 4차: 반폭만 15.4 → **4.6**(`CORRIDOR_BUG_HALF_X`) — 길이는 그대로다.
 *   z −34 … −66 — 안드로이드 두 대 (스폰 z −48 · −54). 체크포인트 `android`(−32) ~ `drop`(−71) 구간.
 *   z −112 … 끝 — 안드로이드 두 대(−125 · −128) + 무너진 벽(−114) + 버려진 함선(−149).
 *                 함선 외피(`extraction/Hull`)가 로컬 x ±5.25(나셀) · z −9.7…+0.6 이고 램프가 +Z 로 3.0 m 더
 *                 열리므로, 반폭 15.4 에서 **좌우 여유 10.15 m** · 램프 발치(−145.75)에서 `ship` 체크포인트
 *                 (−143)까지 2.75 m 다. 좁히면 들어가지 않는다.
 *
 * ⚠ 데크(`DECKS`)는 **줄이지 않는다** — 늘 `±CORRIDOR_MAX_HALF_X` 다. 좁은 구간에서는 벽이 그 데크 위에
 * 서는 것이고, 그래야 깔때기 이음매나 벽 두께 계산이 어긋나도 발밑이 사라지지 않는다.
 */
export const CORRIDOR_PROFILE: readonly CorridorPoint[] = [
  { z: 121, halfX: CORRIDOR_PASS_HALF_X },   // 기상 · 폐허 · 절벽 1 · 시체 ①
  { z: 68, halfX: CORRIDOR_PASS_HALF_X },
  { z: 62, halfX: CORRIDOR_BUG_HALF_X },     // ↑ 좁아진다 — 벌레 구간 입구 (6 m 에 걸쳐 = 벽 각 27°)
  { z: 0, halfX: CORRIDOR_BUG_HALF_X },
  { z: -12, halfX: CORRIDOR_PASS_HALF_X },   // ↑ 넓어진다 — 무너진 통로(포복) 앞 깔때기 (12 m 에 걸쳐 = 벽 각 15°)
  { z: -28, halfX: CORRIDOR_PASS_HALF_X },
  { z: -34, halfX: CORRIDOR_MAX_HALF_X },    // ↑ 넓어진다 — 안드로이드 전투장 입구
  { z: -66, halfX: CORRIDOR_MAX_HALF_X },
  { z: -73, halfX: CORRIDOR_PASS_HALF_X },   // ↑ 좁아진다 — 절벽 2 앞 깔때기 (위 · 아래 데크가 같은 폭이어야 착지가 안전하다)
                                             //   4차: 절벽 가장자리를 −82 → −77 로 당겼으므로 이 제어점도 −78 → −73 —
                                             //   가장자리보다 4 m 앞에서 좁아지기가 끝나야 뛰어내리는 자리와 착지 자리의 폭이 같다
  { z: -106, halfX: CORRIDOR_PASS_HALF_X },
  { z: -112, halfX: CORRIDOR_MAX_HALF_X },   // ↑ 넓어진다 — 무너진 벽 · 마지막 전투 · 함선
  { z: -165, halfX: CORRIDOR_MAX_HALF_X },
];

/** 그 z 에서의 통로 반폭 (제어점 사이는 선형 보간). 맵 바깥의 z 는 양 끝 값으로 잘린다. */
export function corridorHalfXAt(z: number): number {
  const p = CORRIDOR_PROFILE;
  if (z >= p[0].z) return p[0].halfX;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    if (z < b.z) continue;
    const span = a.z - b.z;
    if (span <= 0) return b.halfX;
    return a.halfX + (b.halfX - a.halfX) * ((a.z - z) / span);
  }
  return p[p.length - 1].halfX;
}
/** 맵의 z 양끝 (막다른 벽 바깥). 2026-09-14 3차: 벌레 구간을 36 m 늘려 `Z_END` 가 −129 → −165 가 됐다. */
export const Z_START = 121;
export const Z_END = -165;
/**
 * 지도 · 핑이 쓰는 한 변 (`WorldRef.size`). 통로 전체가 들어간다 — 지도는 원점 중심이라 반변(170)이
 * `max(|Z_START|, |Z_END|)` = 165 보다 커야 한다.
 */
export const TUTORIAL_MAP_SIZE = 340;
/** 데크 콜라이더 한 장의 최대 한 변 — `SpatialHash.maxRadius` 가 커지면 모든 질의가 느려진다 (16 m 칸). */
export const DECK_TILE_M = 16;
/** 꾸밈(잔해 · 돌부스러기)의 고정 시드. 손으로 지은 맵이라 미션 시드와 무관하게 늘 같은 모습이다. */
export const DRESSING_SEED = 0x7ea11e;

/* ── 사각형 ──────────────────────────────────────────────────────────────── */

/** XZ 사각형. `z0 > z1` (앞 = −Z) 규약을 지킨다. */
export interface Rect { x0: number; x1: number; z0: number; z1: number }

export function rectContains(r: Rect, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x1 && z <= r.z0 && z >= r.z1;
}

/**
 * `r` 을 한 변 `max` 이하의 타일로 나눈다 (콜라이더 한 장이 커지면 `SpatialHash.maxRadius` 가 커져 **모든**
 * 해시 질의가 느려진다 — 데크 하나를 통째로 넣으면 외접원이 85 m 다).
 *
 * ⚠ **안쪽 경계는 `TILE_OVERLAP` 만큼 겹친다.** `boxContainsXZ` 는 경계를 포함(`<=`)하지만 반올림 오차로
 * 정확히 경계 위의 점이 양쪽 타일 모두에서 밖으로 읽히면 그 프레임의 `getSurfaceY` 가 지형(협곡 바닥)을
 * 돌려줘 **발밑이 사라진다**. 바깥 경계(사각형 자신의 가장자리)는 늘리지 않으므로 절벽의 틈 · 데크 끝은
 * 설계한 치수 그대로다.
 */
export const TILE_OVERLAP = 0.05;

export function tileRect(r: Rect, max: number): Rect[] {
  const out: Rect[] = [];
  const w = r.x1 - r.x0, d = r.z0 - r.z1;
  const nx = Math.max(1, Math.ceil(w / max)), nz = Math.max(1, Math.ceil(d / max));
  const o = TILE_OVERLAP;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      out.push({
        x0: r.x0 + (w * i) / nx - (i > 0 ? o : 0),
        x1: r.x0 + (w * (i + 1)) / nx + (i < nx - 1 ? o : 0),
        z0: r.z0 - (d * j) / nz + (j > 0 ? o : 0),
        z1: r.z0 - (d * (j + 1)) / nz - (j < nz - 1 ? o : 0),
      });
    }
  }
  return out;
}

/* ── 데크 ────────────────────────────────────────────────────────────────── */

export interface DeckRect { readonly id: string; readonly rect: Rect; readonly top: number }

/**
 * **절벽 2 의 가장자리 z** — 위 데크가 여기서 끊기고 아래 데크가 여기서 시작한다. 데크 · 낙하 규칙 볼륨 ·
 * 부스러기의 높이 판정이 전부 이 한 값을 본다 (숫자를 베껴 쓰면 하나만 고쳤을 때 착지 구역이 어긋난다).
 *
 * 2026-09-14 4차 사용자 결정으로 −82 → **−77**: 안드로이드 구간 끝(−66)에서 16 m 를 더 걸어야 절벽이 나와
 * 「이제 뭘 하라는 거지」가 됐다 — 11 m 면 통로를 나오면서 바로 보인다. 뒤 구간(`supply` −92 · 무너진 벽
 * −114 · 함선 −149 · `Z_END`)은 하나도 안 건드렸으므로 **아래 데크가 5 m 길어질 뿐**이다.
 */
export const CLIFF2_EDGE_Z = -77;

/**
 * 걸어 다니는 땅. 셋뿐이고 그 사이의 **빈 곳이 곧 절벽**이다:
 *   `upper_a` ↔ `upper_b` 사이 = 절벽 1 (달려서 점프해야 넘는다 — 가장자리가 **사선**이라 두 회전 OBB
 *     `parts/Ground.buildChasmEdges` 가 여기서부터 사선까지를 마저 채운다),
 *   `upper_b` 의 끝(z = `CLIFF2_EDGE_Z` −77)에서 `lower` 로 = 절벽 2 (뛰어내린다).
 *
 * ⚠ `upper_a.z1`(85.8) · `upper_b.z0`(74.9) 는 **사선에서 가장 물러난 자리**다 — 축 정렬 사각형이라 사선을
 * 그대로 담을 수 없어서, 사선까지의 쐐기는 회전 OBB 가 덮고 이 둘은 그 안쪽에서 끝난다. 검산은
 * `CHASM_EDGE` 주석에.
 */
export const DECKS: readonly DeckRect[] = [
  { id: 'upper_a', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: 118, z1: 85.8 }, top: DECK_UPPER_Y },
  { id: 'upper_b', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: 74.9, z1: CLIFF2_EDGE_Z }, top: DECK_UPPER_Y },
  { id: 'lower', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: CLIFF2_EDGE_Z, z1: -162 }, top: DECK_LOWER_Y },
];

/* ── 절벽 1 (사선) ───────────────────────────────────────────────────────── */

/**
 * 절벽 1 의 **기울기** (2026-09-14 3차, 사용자 결정 — 「무너진 절벽」). 통로 축(−Z)에 대해 20° 기울어 있고
 * 양쪽 가장자리가 **평행**이라 틈의 폭은 어디서나 같다.
 *
 * 난이도는 그대로다:
 *   - 통로를 따라(−Z) 재면 틈은 늘 `CHASM_GAP_Z` = **3.6 m**. 걸으며 뛰면 4.2 m/s × 0.633 s = 2.66 m 라 못 넘고,
 *     달리며 뛰면 7.2 m/s × 0.633 s = 4.56 m 라 넘는다 (체공 = `2 × JUMP_SPEED(7.6) / GRAVITY(24)` = 0.633 s).
 *   - 사선에 **수직**으로(= 가장 짧게) 건너도 3.6 × cos 20° = **3.383 m** 라 걸어 뛰기(2.66)로는 여전히 못 넘고
 *     사용자가 정한 하한 3.0 m 위다. 어느 방향으로 건너든 3.383 … 3.6 m 사이다.
 */
export const CHASM_TILT = (20 * Math.PI) / 180;
/** 사선이 통로 한가운데(x = 0)를 지나는 z — 가까운 쪽(위 데크 `upper_a`) 가장자리. */
export const CHASM_NEAR_Z = 82;
/** 통로 축(−Z)을 따라 잰 틈. */
export const CHASM_GAP_Z = 3.6;
/**
 * 절벽 1 을 **달려서 넘기 위해 필요한 도움닫기** (m, 가까운 쪽 가장자리에서 뒤로). 「달려야만 넘는다」가
 * 이 절벽의 전부이므로 이 값은 두 곳이 **같이** 읽어야 한다:
 *   ① `cliff` 체크포인트의 부활 자리 (`CHASM_NEAR_Z + CHASM_RUNUP_M`),
 *   ② 「마지막으로 땅에 서 있던 자리」를 **적지 않는 띠**의 접근 쪽 폭 (`TutorialWorld.pollSafeGround`).
 * 하나만 고치면 못 넘고 떨어진 사람이 도움닫기 없는 자리에 되살아나 「다시 떨어지라」가 된다 —
 * 2026-09-14 4차에 실제로 그렇게 됐다가 상수 하나로 묶었다.
 * `PLAYER_SPRINT_SPEED`(7.2)에 이르는 데 필요한 거리보다 넉넉하다.
 */
export const CHASM_RUNUP_M = 12;
/**
 * 사선 가장자리를 만드는 회전 OBB 한 장의 치수 (`parts/Ground.buildChasmEdges`).
 *   `width`   = 사선에 **수직**인 폭. 사선 면을 한쪽 면으로 삼고 데크 쪽으로 이만큼 뻗는다.
 *   `halfLen` = 사선 방향 반길이.
 *
 * **검산** (k = tan 20° = 0.36397, 1/cos 20° = 1.06418):
 *   - 걸어 다닐 수 있는 x 는 |x| ≤ `CORRIDOR_PASS_HALF_X`(7.7) 뿐이다(그 바깥은 벽). 여유를 봐 |x| ≤ 9 를 보장한다.
 *   - 가까운 쪽 판의 **먼 경계**는 `82 − kx + 7.0 × 1.06418`. x = +9 에서 82 − 3.276 + 7.449 = **86.17** >
 *     `upper_a.z1`(85.8) — 빈틈 없이 겹친다 (반대쪽 x = −9 에서는 92.7 로 훨씬 여유롭다).
 *   - 먼 쪽 판의 **먼 경계**는 `78.4 − kx − 7.449`. x = −9 에서 78.4 + 3.276 − 7.449 = **74.23** <
 *     `upper_b.z0`(74.9) — 역시 겹친다.
 *   - `halfLen` 12.0 이면 판의 끝이 x ≈ ±13.7 까지 간다 (벽 안쪽 면은 |x| ≥ 6.6 이므로 통로에 닿는 구간은
 *     전부 덮인다). 그보다 바깥의 쐐기는 벽 몸통(VOID_Y…WALL_TOP_Y)이 채워 보이지도 닿지도 않는다.
 */
export const CHASM_EDGE = { width: 7.0, halfLen: 12.0 } as const;

/** 그 x 에서 가까운 쪽(위 데크) 가장자리의 z. */
export function chasmNearZAt(x: number): number { return CHASM_NEAR_Z - x * Math.tan(CHASM_TILT); }
/** 그 x 에서 먼 쪽(건너편 데크) 가장자리의 z. */
export function chasmFarZAt(x: number): number { return chasmNearZAt(x) - CHASM_GAP_Z; }
/** 그 점이 절벽 1 의 틈 안인가 (`margin` 만큼 넉넉히 본다). */
export function inChasm(x: number, z: number, margin = 0): boolean {
  return z <= chasmNearZAt(x) + margin && z >= chasmFarZAt(x) - margin;
}

/**
 * 절벽 1 의 **바깥 사각형** (사선 틈 전체를 담는 축 정렬 상자). 낙하 규칙 볼륨 · 꾸밈 제외 구역이 쓴다 —
 * 사선 자체는 위의 `chasm*ZAt` 이 답한다.
 */
export const CHASM: Rect = {
  x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X,
  z0: CHASM_NEAR_Z + CORRIDOR_MAX_HALF_X * Math.tan(CHASM_TILT),          // 87.61 (x = −15.4)
  z1: CHASM_NEAR_Z - CHASM_GAP_Z - CORRIDOR_MAX_HALF_X * Math.tan(CHASM_TILT),  // 72.79 (x = +15.4)
};

/* ── 체크포인트 ──────────────────────────────────────────────────────────── */

/** y 를 가진 트리거 볼륨 (위 · 아래 데크를 z 만으로는 가를 수 없다). */
export interface Volume extends Rect { y0: number; y1: number }

export interface CheckpointSpec {
  readonly id: TutorialCheckpointId;
  /** 부활 자리 — 발 위치. */
  readonly at: THREE.Vector3;
  /** 부활 때 바라볼 yaw (전부 0 = 앞으로). */
  readonly yaw: number;
  /** 지나면 이 체크포인트가 켜지는 볼륨. 통로를 가로지르는 띠라 옆으로 피해 갈 수 없다. */
  readonly trigger: Volume;
}

const UPPER_Y0 = DECK_UPPER_Y - 3, UPPER_Y1 = DECK_UPPER_Y + 6;
const LOWER_Y0 = DECK_LOWER_Y - 3, LOWER_Y1 = DECK_LOWER_Y + 6;
/**
 * 체크포인트 · 낙하 규칙 볼륨의 반폭. **가장 넓은 구간 기준**이라 좁은 구간에서는 벽 바깥까지 넘치지만
 * 그쪽은 벽이 막아서 사람이 못 간다 — 넘치는 쪽이 안전하다(구간 폭을 고쳐도 띠가 새지 않는다).
 */
const W = CORRIDOR_MAX_HALF_X + 1;

function cp(id: TutorialCheckpointId, x: number, y: number, z: number, z0: number, z1: number): CheckpointSpec {
  const upper = y > (DECK_UPPER_Y + DECK_LOWER_Y) / 2;
  return {
    id,
    at: new THREE.Vector3(x, y, z),
    yaw: 0,
    trigger: { x0: -W, x1: W, z0, z1, y0: upper ? UPPER_Y0 : LOWER_Y0, y1: upper ? UPPER_Y1 : LOWER_Y1 },
  };
}

/**
 * 열 곳. 순서는 `TUTORIAL_CHECKPOINTS` 와 **같아야 한다** (`TutorialWorld` 가 생성자에서 검산한다).
 *
 * ⚠ **배치 규칙**: 모든 체크포인트는 그 구간 적의 감지 반경(`TUTORIAL_ENEMY_SENSE_M` = 12 m) **밖**이다 —
 * 무기를 잃고 부활한 사람이 자기 시체까지 걸어갈 수 있어야 하기 때문이다. 실제 거리는 아래 `ENEMIES` 주석에
 * 계산해 뒀고, 2026-09-14 3차 재배치 뒤 가장 빡빡한 곳도 15.3 m 다. 좌표를 고치면 그 표를 다시 계산한다.
 *
 * 부활 자리는 **전부 x = 0** 이라 `CORRIDOR_PROFILE` 을 어떻게 좁혀도 벽 안이다 (가장 좁은 구간의 반폭이
 * 7.7 m 라 넉넉하다).
 */
export const CHECKPOINTS: readonly CheckpointSpec[] = [
  cp('wake', 0, DECK_UPPER_Y, 112, 118, 104),      // 폐허 한가운데 — 여기서 깨어난다
  // 절벽 1 앞. x 0 에서 가장자리(82)까지 `CHASM_RUNUP_M` = 12 m 의 도움닫기 — 자리를 상수에서 뽑으므로
  // 「부활 자리를 적지 않는 띠」(`TutorialWorld.pollSafeGround`)와 늘 같은 값이다.
  cp('cliff', 0, DECK_UPPER_Y, CHASM_NEAR_Z + CHASM_RUNUP_M, 100, 88),
  // ⚠ 띠의 시작(75)은 **사선 틈의 가장 먼 끝**(x +7.7 에서 far 가장자리 75.60)보다 뒤여야 한다. 그렇지 않으면
  // 절벽 1 의 오른쪽에서 **떨어지는 중에** 이 띠를 지나(볼륨 y 는 −3 까지 열려 있다) 못 넘은 사람이 건너편
  // 체크포인트를 얻는다. 벽에 밀린 몸은 사선에서 몸 반지름만큼 떨어지므로 실제로는 z ≥ 76.08 이다.
  cp('corpse', 0, DECK_UPPER_Y, 72, 75, 68),       // 절벽을 넘은 자리. 시체 ① 이 6 m 앞
  cp('bugs', 0, DECK_UPPER_Y, 60, 64, 54),         // 벌레 전투장 입구 — 벌레는 26 m 앞
  cp('crawl', 0, DECK_UPPER_Y, -10, -6, -14),      // 무너진 통로 **바로 앞** (2026-09-14 3차)
  cp('android', 0, DECK_UPPER_Y, -32, -28, -36),   // 통로를 나온 자리. 안드로이드 2체
  cp('drop', 0, DECK_UPPER_Y, -71, -68, -75),      // 절벽 2 **바로 앞** (가장자리 −77 에서 6 m) — 2026-09-14 4차
  cp('supply', 0, DECK_LOWER_Y, -92, -88, -96),    // 떨어진 자리. 시체 ② 가 앞에
  cp('wall', 0, DECK_LOWER_Y, -108, -104, -112),   // 무너진 벽 앞
  cp('ship', 0, DECK_LOWER_Y, -143, -139, -147),   // 버려진 함선 램프 앞
];

/* ── 낙하 규칙 ───────────────────────────────────────────────────────────── */

export interface FallRuleVolume extends Volume { readonly rule: TutorialFallRule }

/**
 * 떨어진 **자리**(착지 지점)가 정하는 규칙. 볼륨 밖은 전역 낙하 피해 그대로(`normal`).
 * 목록 순서대로 처음 맞는 것이 이긴다.
 */
export const FALL_RULES: readonly FallRuleVolume[] = [
  // 절벽 1 바닥 — 넘지 못했다는 뜻이라 즉사시키고 체크포인트로 돌려보낸다.
  // 사선 틈의 **바깥 사각형**(`CHASM`)에 1.5 m 를 더한 띠다. 그 z 범위에서 y 가 `DECK_UPPER_Y − 3` 밑인
  // 자리는 협곡뿐이라(위 데크 위에서는 y = 0) 사선을 그대로 따라 자를 필요가 없다.
  { rule: 'kill', x0: -W - WALL_T, x1: W + WALL_T, z0: CHASM.z0 + 1.5, z1: CHASM.z1 - 1.5, y0: VOID_Y - 6, y1: DECK_UPPER_Y - 3 },
  // 절벽 2 착지 구역 — 반드시 살아남아야 하는 낙하. 피해는 들어가되 체력 1 밑으로 내려가지 않는다
  { rule: 'clamp', x0: -W, x1: W, z0: CLIFF2_EDGE_Z, z1: -102, y0: DECK_LOWER_Y - 4, y1: DECK_LOWER_Y + 4 },
];

/* ── 적 ──────────────────────────────────────────────────────────────────── */

export interface EnemySpot { readonly type: string; readonly x: number; readonly y: number; readonly z: number; readonly yaw: number }

/**
 * 여섯 마리. 굴림도 웨이브도 순찰도 없다 (`enemies/` 가 `world:ready` 에서 한 번 읽어 그대로 세운다).
 * yaw = π 라 전부 다가오는 플레이어(+Z 쪽)를 보고 있다.
 *
 * **종류** (2026-09-14 3차 — 튜토리얼 전용 타입, `data/enemies.csv` · `enemies/EnemyTypes.TUTORIAL_ENEMY_BASE`):
 * `*_loot` 만 확정 드롭이 있고 나머지는 아무것도 떨어뜨리지 않는다. **+x 가 걸어가는 플레이어의 오른쪽**이다
 * (좌표 규약 절의 forward × up 계산).
 *   벌레            — 왼쪽(x −2.5) `tut_bug_loot` · 오른쪽(x +2.5) `tut_bug`
 *   앉아쏴 안드로이드 — 오른쪽(x +7) `tut_android_loot` · 왼쪽(x −7) `tut_android`
 *   무너진 벽 뒤     — 둘 다 `tut_android`
 *
 * **체크포인트까지의 거리** (감지 12 m 를 넘는지의 근거 — 좌표를 고치면 다시 계산한다):
 *   `bugs`(0,60)     → (−2.5,34) 26.1 · (2.5,28) 32.1
 *   `crawl`(0,−10)   → (−2.5,34) 44.1 · (2.5,28) 38.1
 *   `android`(0,−32) → (−7,−48) 17.5 · (7,−54) 23.1
 *   `drop`(0,−71)    → (−7,−48) 24.0 · (7,−54) 18.4
 *   `wall`(0,−108)   → (−3,−125) 17.3 · (3,−128) 20.2
 *   `ship`(0,−143)   → (−3,−125) 18.2 · (3,−128) 15.3
 * 가장 빡빡한 곳이 15.3 m 다.
 *
 * **자기 구간의 벽 안인가** (2026-09-14 4차, 벌레 구간이 좁아졌으므로 다시 잰다 — 반폭은 `corridorHalfXAt`):
 *   벌레 둘   (z 34 · 28) 반폭 `CORRIDOR_BUG_HALF_X` 4.6 → `|x|` 2.5 + `radius` 0.45 = 2.95, **여유 1.65 m**.
 *             벽의 안쪽 면은 `Ground` 의 bite 만큼 더 파고들지만 그 몫도 폭에 비례해 줄어(4 × 0.55 × 4.6/15.4
 *             = 0.66) 최소 3.94 이므로 **여유 0.99 m** 는 남는다.
 *   안드로이드 넷 (z −48 · −54 · −125 · −128) 반폭 15.4 → `|x| ≤ 7`, 여유 8.4 m 이상.
 *
 * **무너진 벽 뒤 둘의 거리 검산** (2026-09-14 3차 — 「벽 앞에서 던진 수류탄 하나가 둘을 잡는다」):
 *   `GRENADE_RADIUS` = 6 m (`weapons/Grenade.ts`, `items.csv` 설명의 「반경 6 m」와 같은 값), 피해는 거리에
 *   선형 감쇠. 두 대의 한가운데는 (0, −126.5) 이고 각자까지 √(3² + 1.5²) = **3.35 m** 라 둘 다 반경 안이다
 *   (피해 계수 1 − 3.35/6 = 0.44).
 *   벽(`BROKEN_WALL.z` −114 · 두께 2.2 → 앞면 −112.9)에 붙어 선 사람은 z ≈ −112.5 이므로 그 한가운데까지
 *   **14.0 m** — 기본 투척 거리(`throwRangeMetres`: 34 m/s · 올려주기 3.5 · 중력 24 · 눈높이 1.55 → **18.14 m**)
 *   안이고, 동시에 폭발 반경 6 m 밖이라 **자기 수류탄에 맞지 않는다**. 옛 배치는 둘이 13.4 m 떨어져 있어
 *   (한 대의 반경 안에 다른 한 대가 절대 못 들어왔다) 이 학습이 성립하지 않았다.
 */
export const ENEMIES: readonly EnemySpot[] = [
  { type: 'tut_bug_loot', x: -2.5, y: DECK_UPPER_Y, z: 34, yaw: Math.PI },      // 왼쪽 — 무기 · 재료를 떨어뜨린다
  { type: 'tut_bug', x: 2.5, y: DECK_UPPER_Y, z: 28, yaw: Math.PI },            // 오른쪽
  { type: 'tut_android', x: -7, y: DECK_UPPER_Y, z: -48, yaw: Math.PI },        // 왼쪽
  { type: 'tut_android_loot', x: 7, y: DECK_UPPER_Y, z: -54, yaw: Math.PI },    // 오른쪽 — 돌격소총 · 탄약
  { type: 'tut_android', x: -3, y: DECK_LOWER_Y, z: -125, yaw: Math.PI },       // 무너진 벽 뒤 (수류탄 하나에 둘)
  { type: 'tut_android', x: 3, y: DECK_LOWER_Y, z: -128, yaw: Math.PI },
];

export const ENEMY_SENSE = TUTORIAL_ENEMY_SENSE_M;
export const ENEMY_LEASH = TUTORIAL_ENEMY_LEASH_M;

/* ── 시체 세 구 ──────────────────────────────────────────────────────────── */

/**
 * 고정 아이템 목록이다 — **컨테이너 굴림을 쓰지 않는다**. `qty: 'stack'` 은 그 아이템의 `stackMax` 한 칸
 * 가득(탄약)이라는 뜻이고, 숫자를 코드에 적지 않으려는 것이다.
 */
export interface CorpseSpec {
  /** `corpse:` 접두사 = 빛기둥이 서는 유일한 종류 (`ui/hud/pillar.pillarAllowed`). */
  readonly id: string;
  readonly name: string;
  readonly x: number; readonly y: number; readonly z: number;
  readonly yaw: number;
  readonly items: readonly { readonly id: string; readonly qty: number | 'stack' }[];
}

/**
 * 셋 다 `|x| ≤ 9` 이고 각자 그 구간의 반폭(6.67 · 7.7 · 15.4) 안이다 — ① 은 벌레 구간 깔때기 한복판(z 66)이라
 * 2026-09-14 4차에 10.3 → 6.67 로 줄었지만 `x` 가 2 뿐이라 그대로 둔다.
 * ③ 은 무너진 벽 3 m 뒤 오른쪽 구석이라 벽 뒤 안드로이드 둘에서 12.5 m · 14.4 m 떨어져 있다 — 벽을 넘자마자
 * 뒤지려다 감지 반경(12 m)에 걸리지 않는다.
 */
export const CORPSES: readonly CorpseSpec[] = [
  {
    id: 'corpse:tut_gear', name: '분대원의 시체', x: 2, y: DECK_UPPER_Y, z: 66, yaw: 2.3,
    items: [{ id: 'wpn_smg', qty: 1 }, { id: 'bag_common', qty: 1 }, { id: 'ammo_light', qty: 'stack' }],
  },
  {
    id: 'corpse:tut_supply', name: '위생병의 시체', x: -3, y: DECK_LOWER_Y, z: -100, yaw: -1.1,
    items: [{ id: 'heal_bandage', qty: 2 }, { id: 'grenade_frag', qty: 2 }],
  },
  {
    id: 'corpse:tut_relic', name: '약탈자의 시체', x: 9, y: DECK_LOWER_Y, z: -117, yaw: 0.6,
    items: [{ id: 'gem_amber', qty: 1 }, { id: 'cred_chip', qty: 2 }],
  },
];

/* ── 버려진 함선 (= 진짜 탈출선을 착륙 상태로 세운다) ────────────────────── */

/**
 * `ctx.extraction.beginPreLanded(position, yaw)` 에 넘길 자리. 함선 원점은 데크 위에 있고 (`Ship.floorYAt` 규약),
 * **뒷 램프는 `(sin yaw, cos yaw)` 쪽으로 열린다** — yaw 0 이면 +Z, 즉 다가오는 플레이어 정면이다.
 * z 는 외피(`extraction/Hull`)의 기수 끝이 로컬 −9.7 m 라 −149 다: 월드 −158.7 로 아래 데크 끝(−162)과
 * 막다른 벽 안쪽에 들어간다. 화물칸은 월드 −154.2 … −149.8, 램프는 그 뒤(−145.75 까지)로 열린다.
 */
export const SHIP_POS = new THREE.Vector3(0, DECK_LOWER_Y, -149);
export const SHIP_YAW = 0;

/* ── 손으로 지은 구조물의 치수 ───────────────────────────────────────────── */

/** 무너진 통로 (포복 구간): 통로가 좁아지고 머리 위로 슬래브가 지난다. */
export const CRAWL = {
  z0: -14, z1: -28,
  /**
   * 지나갈 수 있는 폭의 절반. 2026-09-14 2차 사용자 결정으로 3 → **2.1**(−30 %) — 「좁아서 앉아야 한다」가
   * 이 구간의 요점이라 더 좁혔지만, 플레이어 지름(`PLAYER_RADIUS` 0.45 × 2 = 0.9 m)의 **4.7 배**라
   * 앉은 채 좌우로 피할 여유는 남는다 (통과 폭 4.2 m).
   */
  gapHalfX: 2.1,
  /**
   * 구간 **한가운데**에서 머리 위 슬래브의 밑면 (데크 윗면 기준). **선 몸(`BOX_HEADROOM` 2.1)은 막고 앉은 몸
   * (`PLAYER_CROUCH_CLEARANCE_M` 1.3)은 지나는** 사이 값이다 — 2026-09-14 에 `PlayerController` 가 자세 높이를
   * `resolveCollision` 에 넘기게 되면서 「앉아서만 지나갈 수 있다」가 진짜가 됐다. 그 밑에서는 일어설 수도 없다
   * (`player/parts/Locomotion.canStandHere`). 두 상수 **사이**를 벗어나면 구간이 뜻을 잃으므로 함께 본다.
   */
  clearance: 1.65,
  /**
   * 슬래브의 두께. 2026-09-14 4차 사용자 결정으로 1.2 → **2.4**(「천장을 위로 더 두껍게」) — 얇은 판 하나가
   * 떠 있으면 무너진 잔해가 아니라 선반처럼 보였다. **밑면은 그대로이고 위로만 두꺼워진다**: 그림도
   * (`Dressing` 이 중심을 `clearance + slabThickness / 2` 에 둔다) 콜라이더도(밑면을 base 로, 두께를 height 로
   * 넣는다) 밑면 기준이라 이 값을 키워도 통과 높이는 한 치도 안 바뀐다. 위쪽은 양옆 잔해 더미(높이 5.2)
   * 안이라 삐져나오지 않는다 (출구에서 1.95 + 2.4 = 4.35).
   */
  slabThickness: 2.4,
  /**
   * 2026-09-14 3차 — 슬래브를 **기울여** 무너져 내려앉은 잔해처럼 보이게 한다. 밑면의 기울기(dy/dz)다.
   * 4차 사용자 결정으로 **부호를 뒤집었다**: 들어가는 쪽(z0)이 낮고 나가는 쪽(z1)이 높다 — 앉아서 앞을
   * 겨눌 때(`crouchAim`) 카메라가 슬래브에 박히던 곳이 **출구**였고, 「점점 낮아지는 굴로 기어든다」보다
   * 「기어들어 갔다가 빠져나온다」가 이 구간의 뜻에 맞는다. 값은 입구 1.35 → 출구 1.95 를 깊이 14 m 로 나눈
   * 것이라 `−0.6 / 14` 로 적는다 (0.0428…을 손으로 반올림해 적으면 양 끝이 요청과 어긋난다).
   *
   * **검산** (깊이 14 m, 한가운데 `clearance` 1.65):
   *   가장 높은 곳 z1 = −28 → 1.65 + 7 × 0.042857 = **1.95 m** < `BOX_HEADROOM` 2.1 → 어디서도 못 선다 ✔
   *   가장 낮은 곳 z0 = −14 → 1.65 − 7 × 0.042857 = **1.35 m** > `PLAYER_CROUCH_CLEARANCE_M` 1.3 → 앉으면 지난다 ✔
   *
   * 콜라이더는 `slabSegments` 장으로 쪼갠 축 정렬 상자이고 각 조각의 밑면은 그 조각 **한가운데**의 값이라
   * 그려진 밑면과 최대 `(14/7)/2 × 0.042857` = **0.043 m** 어긋난다 (3차의 0.053 보다 좁다 — 조각을 4 → 7 로
   * 늘린 이유가 그것이다: 입구 조각의 밑면이 설계값 1.35 에 더 가까이 선다).
   * 조각별 밑면 (z 중심 −15 · −17 · −19 · −21 · −23 · −25 · −27):
   *   **1.393 · 1.479 · 1.564 · 1.650 · 1.736 · 1.821 · 1.907** — 일곱 다 1.3 과 2.1 사이 ✔
   * 하나라도 1.3 밑으로 내려가면 앉아서도 못 지나가고, 2.1 위로 올라가면 서서 지나갈 수 있어 구간이 뜻을 잃는다.
   */
  slabSlope: -0.6 / 14,
  slabSegments: 7,
} as const;

/** 그 z 에서 슬래브 밑면의 높이 (데크 윗면 기준). */
export function crawlClearanceAt(z: number): number {
  return CRAWL.clearance + CRAWL.slabSlope * (z - (CRAWL.z0 + CRAWL.z1) / 2);
}

/** 무너진 벽 — 통로를 가로막고 가운데만 뚫려 있다. */
export const BROKEN_WALL = { z: -114, thickness: 2.2, height: 4.6, gapHalfX: 2.5 } as const;

/** 시작 폐허가 서는 구역. */
export const RUINS = { z0: 118, z1: 96 } as const;

/* ── 기하 헬퍼 (TrainingArena 와 같은 수법) ─────────────────────────────── */

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);

export function placed(geo: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  _q.setFromEuler(new THREE.Euler(0, ry, 0));
  _v.set(x, y, z);
  _m.compose(_v, _q, _s);
  geo.applyMatrix4(_m);
  return geo;
}

export function box(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  return placed(new THREE.BoxGeometry(w, h, d), x, y, z, ry);
}

/** `rect` 을 밑면 `y0` · 윗면 `top` 의 상자 지오메트리로. */
export function rectBox(rect: Rect, y0: number, top: number): THREE.BufferGeometry {
  const w = rect.x1 - rect.x0, d = rect.z0 - rect.z1, h = top - y0;
  return box(w, h, d, (rect.x0 + rect.x1) / 2, y0 + h / 2, (rect.z0 + rect.z1) / 2);
}
