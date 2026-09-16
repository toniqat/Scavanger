import * as THREE from 'three';
import {
  PLAYER_HEIGHT, TUTORIAL_ENEMY_LEASH_M, TUTORIAL_ENEMY_SENSE_M,
  type TutorialCheckpointId, type TutorialEnemySpawn, type TutorialFallRule,
} from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * 튜토리얼 행성 — **맵의 모양 그 자체** (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」).
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

/**
 * **지형 높이** (`TutorialWorld.heightAt` · `raycastGround`) — 이 맵에서 콜라이더가 하나도 없는 자리에 떨어지면 닿는 곳.
 * 2026-09-15 −34 → **−100**: 함선 앞을 **바닥이 안 보이는 절벽**(`ABYSS_*`)으로 열었는데 `heightAt` 은 인자가 없는 상수라
 * (`WorldSystem` 이 `heightAt()` 으로 부른다) 거기만 깊게 할 수 없다. −34 에 두면 뛰어내린 몸이 **보이지 않는 바닥**에서
 * 24 m 아래에 선 채 죽는다. 그래서 지형을 통째로 내리고, 절벽 1 의 바닥만 `CHASM_FLOOR_Y` 콜라이더로 예전 높이에 남겼다.
 * 낙하 시간: 아래 데크(−10)에서 90 m = √(2·90/24) = **2.74 s** 뒤 착지 → `kill`.
 */
export const VOID_Y = -100;
/**
 * **절벽 1 의 협곡 바닥** (옛 `VOID_Y`). 이제 지형이 아니라 사각 콜라이더(`parts/Ground`)이고 협곡 바닥 판도 이 높이에
 * 그린다. 규칙이 `kill` 이라 높이는 연출이다 — 떨어지는 시간(√(2·34/24) = 1.68 s)이 예전과 한 치도 다르지 않다.
 */
export const CHASM_FLOOR_Y = -34;
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

/* ── 끝없는 절벽 (함선 앞) ──────────────────────────────────────────────── */

/**
 * **아래 데크가 끝나는 z** — 그 앞은 바닥이 보이지 않는 절벽이다 (2026-09-15, 사용자 결정 「함선 앞은 막힌 벽이 아니라 끝이
 * 안 보이는 낭떠러지」). 전에는 여기에 18 m 짜리 막다른 벽(`Z_END` 캡)이 있었고, 함선이 기수 쪽으로 떠오르며 **그 벽을
 * 뚫고 날아갔다** (이륙 1.6 s 스풀 뒤 a 초에 상승 `6a² + 2a` · 전진 `12(a − 0.8)²` — 벽 꼭대기 y 18 을 넘기 전에
 * 기수가 7.7 m 나아가 캡(−162…−165) 속에 들어갔다).
 *
 * **검산**: 함선(`SHIP_POS`/`SHIP_YAW`) 외피의 가장 앞(기수 끝, 로컬 z −9.7)이 월드 z **−167.80** 이라 가장자리까지 **4.2 m**.
 * 이륙이 앞으로 움직이기 시작할 때(a = 0.8)는 이미 5.4 m 떠 있으므로 데크 모서리와도 부딪히지 않는다.
 */
export const ABYSS_EDGE_Z = -172;
/** 가장자리 너머로 옆 절벽 벽이 **낮아지며** 이어지는 길이 (m). 그 뒤에는 아무것도 없다 — 하늘 돔의 아래쪽(어두운 `ground` 색)이다. */
export const ABYSS_RUN_M = 36;
/** 그 벽 한 조각의 z 길이 — 조각마다 윗면이 한 계단씩 내려가고 안쪽 면이 조금씩 벌어진다 (`parts/Ground.buildAbyss`). */
export const ABYSS_WALL_STEP_M = 6;
/**
 * 절벽 면을 **그리는** 가장 아래 (콜라이더는 `VOID_Y` 까지). 가장자리에서 410 m 아래라 거기까지 보일 일이 없고, 보여도
 * 정점 색이 검정으로 떨어져 있어 하늘 돔의 아래쪽(어두운 `ground` 색)과 이어진다.
 */
export const ABYSS_DRAW_BOTTOM_Y = -420;
/**
 * 절벽 면이 **돌 재질 → 어두워지는 그라데이션**으로 넘어가는 높이. 그 위는 다른 절벽 벽과 같은 돌결 텍스처이고,
 * 그 아래는 `fog: false` 정점 색 재질이다 — 안개(FogExp2)는 멀수록 **밝은** 안개색으로 칠하므로, 안개를 받으면
 * 깊은 곳이 오히려 밝아져 어두운 하늘 돔 아래쪽과 어긋난다.
 */
export const ABYSS_FADE_TOP_Y = -40;
/**
 * 「마지막으로 땅에 서 있던 자리」를 **적지 않는** 가장자리 띠의 폭 (m, `TutorialWorld.pollSafeGround`). 가장자리 코앞에
 * 되살리면 한 걸음에 다시 떨어진다 — 절벽 1 의 `SAFE_CHASM_MARGIN` 과 같은 이유다.
 */
export const ABYSS_SAFE_MARGIN_M = 3;
/**
 * 이 z 부터 앞(−Z)의 곧은 절벽 벽은 **안쪽으로 파고들지 않는다** (`parts/Ground` 의 bite = 0). 옛 규칙대로면
 * −152…−162 조각의 왼쪽 벽이 2.2 m 파고들어 안쪽 면이 x −13.2 이고, 함선 왼쪽 나셀(−13.13)과 **0.07 m** 였다.
 * 0 으로 두면 왼쪽 벽 안쪽 면이 늘 −15.4 라 여유가 **2.27 m** 다 (이륙 궤적 전체를 0.02 s 간격으로 훑어 확인했다).
 * −142 인 이유: 그 조각부터 함선 · `ship` 체크포인트(x −12.5)가 선다.
 */
export const WALL_PLAIN_FROM_Z = -142;

/* ── 옆 벽이 낮아지는 마지막 구간 (2026-09-16, 사용자 결정) ─────────────────── */

/**
 * 사선 방벽의 끝점 둘 · 두께의 절반 — `BARRIER` 가 이 값을 읽는다. 여기(파일 위쪽)에 따로 둔 이유는 **모듈 초기화 순서**다:
 * 철조망 너머의 절벽 구멍(`ABYSS_CUTS`) · 아래 데크 조각(`DECKS`)이 철조망 먼 면을 따라 계단을 만드는데, 그 둘은 `BARRIER` 보다
 * 위에서 초기화된다 (`const` 는 선언 전에 읽으면 ReferenceError).
 */
export const BARRIER_NEAR_END = { x: 17, z: -116 } as const;
export const BARRIER_FAR_END = { x: -8.5, z: -140 } as const;
export const BARRIER_HALF_T = 0.6;

/**
 * 이 z 부터 앞(−Z)의 옆 벽은 **윗면이 낮아진다** (2026-09-16, 사용자 결정 — 「철조망 끝부터 왼쪽 벽은 빠르게 깎여 내려가고 오른쪽 벽은
 * 완만하게 낮아진다, 둘 다 절벽을 감싼다」). 값 = 방벽 `far` 끝의 z. `parts/Ground` 가 이 z 에서 벽 조각을 자르고 그 뒤를
 * `WALL_DESCENT_STEP_M` 조각으로 나눠 조각마다 윗면을 내린다 (파고듦은 0 — `WALL_PLAIN_FROM_Z` 와 같은 이유).
 */
export const WALL_DESCENT_FROM_Z = BARRIER_FAR_END.z;
/** 낮아지는 벽 한 조각의 z 길이 (m). 콜라이더도 조각마다 따로라 계단진 윗면이 곧 콜라이더다. */
export const WALL_DESCENT_STEP_M = 2;
/**
 * 낮아지는 속도 (윗면 m / 앞으로 m). 왼쪽 1.2 는 z −160 에서 바닥값(`WALL_MIN_ABOVE_WALK_M`)에 닿고, 오른쪽 0.5 는 가장자리
 * (`ABYSS_EDGE_Z`)에서 y **2.0** 이다. 가장자리 너머(`parts/Ground.buildAbyss`)는 조각(6 m)마다 왼쪽 `ABYSS_WALL_DROP_L` · 오른쪽
 * `ABYSS_WALL_DROP_R` 씩 계속 내려간다 (오른쪽이 늘 더 완만하다).
 */
export const WALL_DESCENT_RATE_L = 1.2;
export const WALL_DESCENT_RATE_R = 0.5;
/**
 * 걸어 다니는 땅 곁에서 벽 윗면이 그 땅보다 **최소** 이만큼 위다 (m). 점프 1.20 + 올라설 수 있는 단 0.9 = 2.10 < 3.0 이라 벽 위로
 * 올라서지 못한다 (`BARRIER` 검산과 같은 식). 왼쪽 벽은 z −172 까지 길 · 함선 언덕 곁이라 그 언덕(`SHIP_HILL_Y`) 기준으로 잰다 —
 * 오른쪽 벽 곁은 철조망 너머가 전부 절벽이라 바닥값이 없다.
 */
export const WALL_MIN_ABOVE_WALK_M = 3;
/** 가장자리 너머 벽 조각(6 m)마다 윗면이 내려가는 높이 (m) — 왼쪽 · 오른쪽. */
export const ABYSS_WALL_DROP_L = 6;
export const ABYSS_WALL_DROP_R = 3;

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
 *   z −112 … −172 — 사선 방벽(`BARRIER`) + 그 뒤 안드로이드 두 대 + 왼쪽의 버려진 함선 (2026-09-15).
 *                 함선 외피(`extraction/Hull`)가 로컬 x ±5.25(나셀) · z −9.7…+0.6 이고 램프가 +Z 로 3.25 m 까지
 *                 열린다. yaw −10° 로 세우면 월드 발자국이 x −13.13 … −2.76 · z −167.80 … −154.50 이라
 *                 왼쪽 벽(−15.4, `WALL_PLAIN_FROM_Z` 부터 파고듦 0)까지 **2.27 m** 다. 좁히면 들어가지 않는다.
 *                 끝은 막다른 벽이 아니라 **끝없는 절벽**(`ABYSS_EDGE_Z`)이다.
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
  { z: -112, halfX: CORRIDOR_MAX_HALF_X },   // ↑ 넓어진다 — 사선 방벽 · 마지막 전투 · 함선
  { z: ABYSS_EDGE_Z, halfX: CORRIDOR_MAX_HALF_X },   // 여기서 곧은 벽이 끝나고 `Ground.buildAbyss` 가 낮아지는 벽을 잇는다
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
/**
 * 맵의 z 양끝. `Z_START` 는 막다른 벽 바깥, `Z_END` 는 **끝없는 절벽 너머 벽이 끝나는 자리**다.
 * 2026-09-14 3차: 벌레 구간을 36 m 늘려 −129 → −165. 2026-09-15: 막다른 벽을 걷어 내고 절벽 너머까지 넓혀
 * `ABYSS_EDGE_Z − ABYSS_RUN_M` = **−208** (`isInside` · `clampInside` · 낙하 `kill` 볼륨이 이 값까지 본다).
 */
export const Z_START = 121;
export const Z_END = ABYSS_EDGE_Z - ABYSS_RUN_M;
/**
 * 지도 · 핑이 쓰는 한 변 (`WorldRef.size`). 통로 전체가 들어간다 — 지도는 원점 중심이라 반변(210)이
 * `max(|Z_START|, |Z_END|)` = 208 보다 커야 한다 (2026-09-15: 340 → 420).
 */
export const TUTORIAL_MAP_SIZE = 420;
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

/** `r` 을 사방 `m` 만큼 넓힌 사각형 (콜라이더 이음매용 — `TILE_OVERLAP` 주석). */
export function growRect(r: Rect, m: number): Rect {
  return { x0: r.x0 - m, x1: r.x1 + m, z0: r.z0 + m, z1: r.z1 - m };
}

/* ── 철조망 너머 (마지막 구간): 웅덩이 · 벽 · 절벽 구멍 ──────────────────── */

/**
 * **웅덩이의 깊이** (2026-09-15 2차, 사용자 결정 — 「안드로이드가 배치된 곳은 PC 몸체 절반 정도 아래로 꺼져 있고, 함선이
 * 있는 곳까지 오르막 언덕으로 이어진다」; 3차에 「0.9 m 유지 + 벽」으로 재확인). 몸 절반 = `PLAYER_HEIGHT / 2` 이므로 숫자를
 * 적지 않고 거기서 뽑는다.
 *
 * ⚠ 이 값은 **정확히 `PROP_STEP_UP_MAX`(0.9)** 다 (부동소수로도 `−10.9 + 0.9 === −10`). 그래서 턱은
 *   - **사람 · 적에게는 벽이 아니다** — `resolveCollision` 의 「올라설 수 있는 단은 벽이 아니다」 가지(`top <= 발 + 0.9`)와
 *     `getSurfaceY` 의 천장(`발 + 0.9`)이 **둘 다 통과**하므로 열린 가장자리(철조망 쪽 · 오르막 쪽 남은 턱)로 걸어 올라온다.
 *   - **투척물에게는 벽이다** — 같은 가지가 `!small` 로 막혀 있어 반지름 `SMALL_BODY_R`(0.25) 미만의 몸에는 예외가 없다.
 *     수류탄(`weapons/Grenade` 의 `BODY_R` 0.08)은 밀려난다 = **굴러 나가지 못한다.**
 * 2026-09-15 3차: 날아 들어오는 수류탄까지 가두는 것은 턱이 아니라 **벽**(`PIT_WALLS`, 2.5 m)이다.
 */
export const PIT_DEPTH = PLAYER_HEIGHT / 2;
/** 웅덩이 바닥의 윗면. 아래 데크에서 `PIT_DEPTH` 만큼 아래. */
export const PIT_FLOOR_Y = DECK_LOWER_Y - PIT_DEPTH;

/**
 * **웅덩이의 평면** (2026-09-15 3차 — 2차의 x −2 … 6 · z −140.5 … −147 (52 m²) 를 **80.75 m²(×1.55)** 로 넓혔다) — 축 정렬 사각형.
 *
 * 왜 방벽 좌표(회전 사각형)가 아닌가: 데크는 축 정렬 타일(`tileRect`)이고, 회전 사각형의 이음매마다 삼각 슬리버가 남아
 * 발밑이 사라진다. 그래서 자리는 방벽 좌표로 **검산하고**(아래 표) 모양만 축 정렬로 잡았다. 2026-09-15 3차부터 구멍은
 * `subtractRect` 로 파는 것이 아니라 **`DECKS` 의 아래 데크 조각들 사이에 처음부터 비어 있다** (2026-09-16: 서쪽 = 길 `lower_pit_w`,
 * 남서 턱 = 언덕 오르막 `SHIP_SLOPE`, 북쪽 턱 · 동쪽 · 남쪽 = `PIT_WALLS` — 그 너머는 전부 절벽이라 웅덩이는 오르막으로만 들어가는 섬이다).
 *
 * **왜 ×2 가 아니라 ×1.55 인가** (사용자 결정 「약 2배」 · 「웅덩이 안이면 어디서 터져도 둘 다 죽는다」는 양립하지 않는다):
 *   수류탄은 `GRENADE_RADIUS` 7.2 m 안이어야 `EXPLOSION_OUTER_MUL` 0.6 × 250 = 150 > 체력 140 이다. 두 대가 s 만큼 떨어져
 *   서면 「둘 다 7.2 m 안」인 자리는 두 원의 렌즈이고, 축 정렬 사각형이 그 안에 들어가려면 **반대각선 + 반간격 ≤ 7.2** 다.
 *   104 m²(×2, 예: 10.4 × 10)는 반대각선만 7.2 라 한가운데 한 점조차 안 되고, 9.5 × 8.5 는 반대각선 6.37 이라 두 대를
 *   **1.8 m** 간격으로 세우면 최대 모서리 거리가 7.07 로 들어간다 (아래 표). 그 위로는 간격이 1 m 밑으로 내려가 둘이 붙는다.
 *
 * **검산** (방벽 좌표 `barrierLocal` — along = 0.7282·dx + 0.6853·dz · depth = −0.6853·dx + 0.7282·dz, dx = x + 8.5 · dz = z + 140;
 *   안드로이드 A1 (1.85, −144.75) · A2 (3.65, −144.75) — `FINAL_ANDROIDS`):
 *   | 모서리 | along | depth | A1 까지 | A2 까지 |
 *   | (−2.0, −140.5) |  4.39 |  −4.82 | 5.73 | 7.07 |
 *   | ( 7.5, −140.5) | 11.31 | −11.33 | 7.07 | 5.73 |
 *   | (−2.0, −149.0) | −1.43 | −11.01 | 5.73 | 7.07 |
 *   | ( 7.5, −149.0) |  5.48 | −17.52 | 7.07 | 5.73 |
 *   - **철조망과의 사이**: 가장 얕은 모서리가 depth −4.82 이고 철조망 콜라이더의 먼 면이 −0.6 이므로 **4.22 m** 떨어져 있다
 *     (x0 를 더 왼쪽으로 빼면 이 여유가 깨진다 — 사선이라 x0 ≥ −2.32 여야 4 m 다). 2026-09-15 까지는 그 사이가 평지였고
 *     2026-09-16 부터는 **절벽**이다 (`ABYSS_CUTS` 의 철조망 계단 — 사용자 결정 「철조망 너머는 길 · 함선 언덕 · 웅덩이 말고 전부 절벽」).
 *     웅덩이의 북쪽 면은 그래서 절벽 쪽 턱(`PIT_WALLS` 의 `pit_rim_n`, 데크 높이)이다. 철조망에 붙어 서면(눈 1.55) 턱 뒤로
 *     약 2.7 m 만 가려지고 안드로이드(10.5 m 앞)는 그 한참 밖이다.
 *   - **수류탄 한 발로 둘 다**: 네 모서리에서 두 대까지가 전부 7.2 m 안이다 (최대 **7.07**). 수류탄 몸(반지름 0.08)은 벽에서
 *     그만큼 떨어져 멈추므로 실제 최대는 √(5.57² + 4.17²) = 6.96 이고, 적의 몸 가운데(+0.9)까지 세로로 재도 √(7.07² + 0.82²)
 *     = 7.12 < 7.2 다.
 *   - **`ship` 체크포인트 띠(z −150 … −158)를 건드리지 않는다**: 웅덩이 앞 끝이 −149.0 이라 **1.0 m** 여유다 (2차와 같은 값 —
 *     띠를 2 m 뒤로 옮겼다). 이 띠는 `CHECKPOINT_STEP.ship = 'extract'` 라 웅덩이에 뛰어들었다고 수류탄 단계를 건너뛰면 안 된다.
 *     남쪽 벽(−149 … −149.6)이 있어 웅덩이 바닥에서 z −150 에 닿는 길은 오르막 남쪽 턱(x −2 … 1.5)뿐이고, 그것은 곧 함선 띠로
 *     나가는 길이다.
 *   - **함선 발자국**(x −13.13 … −2.76 · z −167.80 … −154.50)과 겹치지 않는다 — x 로 0.76 m · z 로 5.5 m 떨어져 있다.
 *   - **이륙 연출 카메라 첫 자리**(−4.07, −5.9, −139.96 — 2026-09-16 함선 언덕 +0.9)는 웅덩이 밖이고(x 로 2.07), 발밑은 철조망 계단의
 *     절벽 구멍이며, 데크보다 4.1 m **위**다.
 *   - **시체 ③**(9, −117)은 그대로 평지다 (z 로 23.5 m 밖 · 철조망 계단 칸 [8.5, 9.5] 의 가장자리 −125.17 보다 8.2 m 앞).
 */
export const PIT: Rect = { x0: -2, x1: 7.5, z0: -140.5, z1: -149 };

/** 웅덩이 벽의 두께 (m) — 방벽과 같은 0.6 (수류탄이 한 걸음에 뚫고 나가지 못하는 두께, `BARRIER` 주석의 50 fps 검산). */
export const PIT_WALL_T = 0.6;
/**
 * 웅덩이 벽의 높이 (m, **데크 윗면 기준** — 웅덩이 안에서는 0.9 를 더한 3.4 m 다). 사용자 결정 「2.5 m 정도」.
 *   - **못 넘는다**: 점프 1.20 + 올라설 수 있는 단 0.9 = 2.10 < 2.5 (`BARRIER` 검산과 같은 식).
 *   - **수류탄이 못 나간다**: 철조망을 수평으로 넘긴 궤적의 꼭대기가 데크 위 1.805 m 라(`BARRIER` 검산) 2.5 m 벽에 부딪혀
 *     밑동으로 미끄러진다. 이륙 카메라(`SHIP_POS` 검산의 y −5.9 = 데크 +4.1 — 2026-09-16 함선 언덕)보다 낮고, 애초에 x 로 11 m 떨어져 있다.
 */
export const PIT_WALL_H = 2.5;
/**
 * 웅덩이 **북쪽 턱**의 높이 (m, 데크 윗면 기준 — 0 이면 데크 높이의 턱 = 웅덩이 안에서 0.9 m). 2026-09-16: 철조망과 웅덩이 사이의
 * 평지가 절벽이 되면서 북쪽 면에 무엇인가 있어야 한다 — 없으면 웅덩이 바닥이 곧장 절벽 가장자리라 수류탄이 굴러 나가고 안드로이드가
 * 걸어 나간다. **벽(2.5 m)이 아니라 턱**인 이유: 이 면은 2026-09-15 결정 「철조망을 넘겨 던진 수류탄이 들어오는 면 · 철조망 사이로
 * 안드로이드가 보이는 면」이다. 2.5 m 벽이면 철조망에 붙어 선 눈(데크 +1.55)에서 웅덩이 속 가슴(데크 +0.27)이 가려지고,
 * 수평 투척의 궤적 꼭대기(데크 +1.805)도 벽에 걸린다. 데크 높이 턱은 그 사선(웅덩이 북쪽 끝에서 데크 약 +0.9)보다 낮고,
 * 0.9 m = `PROP_STEP_UP_MAX` 라 **수류탄(작은 몸)은 못 넘고** 사람 · 적은 올라선다 (`PIT_DEPTH` 주석). 벽으로 바꾸려면 이 값만 올린다.
 */
export const PIT_NORTH_RIM_H = 0;
/** 오른쪽 절벽 가장자리의 x = 웅덩이 동쪽 벽의 바깥 면. 그 오른쪽은 (철조망 너머에서) 바닥이 없다. */
export const PIT_EAST_X = PIT.x1 + PIT_WALL_T;
/**
 * **함선 띠**(바닥이 남는 왼쪽 띠)의 오른쪽 끝 x. 함선 발자국의 오른쪽 끝 −2.76 에서 **4.26 m** 여유. 남쪽 벽은 여기서 시작하고
 * 그 왼쪽(x −2 … 1.5, 오르막과 평지 1 m)은 벽 없는 0.9 m 턱이다 — 안드로이드 → 함선 사선이 지나는 자리라 막지 않는다
 * (`FINAL_ANDROIDS` 주석의 사선 표: A2 → 화물칸 한가운데 선이 z −149 를 x **0.48** 에서 지난다).
 */
export const SHIP_STRIP_X1 = 1.5;

/**
 * **함선 언덕** (2026-09-16, 사용자 결정 — 「함선은 살짝 언덕 위, 플레이어 몸 절반 높이」). 몸 절반 = `PLAYER_HEIGHT / 2` = 0.9 라
 * 웅덩이 깊이(`PIT_DEPTH`)와 같은 값이다. 함선(`SHIP_POS.y`) · `ship` 체크포인트 · 안전한 높이(`TutorialWorld.SAFE_LEVELS`)가 이것을 읽는다.
 *
 * 턱이 아니라 **오르막**(`SHIP_SLOPE`, 경사 콜라이더)으로 오른다: 0.9 m 는 정확히 `PROP_STEP_UP_MAX` 라 턱이어도 걸어 오르지만,
 * 「뚝」 올라서는 것이 아니라 스르륵 오르는 언덕이어야 한다는 결정이다. 언덕의 나머지 세 면은 벽(왼쪽) · 절벽(오른쪽 `cut_s` ·
 * 앞 `ABYSS_EDGE_Z`)이라 턱으로 오를 자리가 없다.
 */
export const SHIP_HILL_RISE = PLAYER_HEIGHT / 2;
export const SHIP_HILL_Y = DECK_LOWER_Y + SHIP_HILL_RISE;
/**
 * 언덕 오르막의 수평 길이 (m, −Z 방향). 경사 atan(0.9 / 4.5) = **11.3°** (웅덩이 오르막 19.8° 보다 완만하다).
 * 오르막은 웅덩이 앞 끝(`PIT.z1` −149)에서 시작해 **−153.5** 에서 끝난다 — 함선 뒷문 램프의 발끝 모서리(월드 z −154.52 … −155.08,
 * 로컬 x ±1.6 · z 3.25)보다 **1.0 m** 앞이라, 램프는 평평한 언덕 꼭대기(y = 함선 바닥 높이)에 그대로 펼쳐진다.
 */
export const SHIP_SLOPE_RUN = 4.5;
/** 평평한 언덕 꼭대기가 시작하는 z (−153.5). */
export const SHIP_HILL_Z0 = PIT.z1 - SHIP_SLOPE_RUN;
/**
 * 언덕 오르막의 평면 — 함선 띠 전폭 (x −15.4 … `SHIP_STRIP_X1`), z −149 … −153.5. 몸통(`VOID_Y … DECK_LOWER_Y`) + 쐐기 그림 + 경사
 * 콜라이더는 `parts/Ground.buildShipSlope`. 북쪽 끝(−149)은 길(`lower_pit_w`, −10)과 같은 높이에서 시작하고, x −2 … 1.5 에서는 웅덩이의
 * 남쪽 턱(0.9 m)이 된다 — 2026-09-15 의 `lower_ship` 북쪽 끝과 같은 자리 · 같은 높이다.
 */
export const SHIP_SLOPE: Rect = { x0: -CORRIDOR_MAX_HALF_X, x1: SHIP_STRIP_X1, z0: PIT.z1, z1: SHIP_HILL_Z0 };
/**
 * 이 z 부터 앞(−Z)으로는 아래 데크에 **구멍**(절벽)이 있다. 협곡 바닥 판(`parts/Ground` 의 `tut-void-floor`)은 여기서 끝나고,
 * 여기부터의 옆 절벽 벽은 `ABYSS_FADE_TOP_Y` 밑을 어두워지는 띠로 그린다 (구멍으로 떨어지며 보이는 벽이 −100 에서 뚝 끊기지 않게).
 * 값은 오른쪽 벽 곁에서 철조망 콘크리트 토막의 먼 면(x 15.4 에서 z −118.33)보다 1.67 m 뒤. 2026-09-16 부터 철조망 계단(`fenceColumns`)의
 * 가장자리도 이 값으로 자른다 — 마지막 칸 [14.5, 15.4] 이 여기서 잘린다 (그 앞에 구멍이 나면 밑에 협곡 바닥 판이 보인다).
 */
export const ABYSS_CUT_Z0 = -120;

/**
 * **웅덩이의 벽** (2026-09-15 3차, 사용자 결정 — 「수류탄이 다른 곳으로 빠지지 않도록 함선 방향 언덕 외에는 벽으로 둘러싼다」).
 * 옛 콘크리트 `BACKSTOP`(사선)을 대신한다. 콜라이더는 `VOID_Y` 부터 윗면까지 한 기둥이라 바깥 면이 곧 절벽 면이다.
 *   동쪽 `pit_wall_e` — x 7.5 … 8.1, z −140.5 … −149.6. 바깥 면(8.1)이 오른쪽 절벽 가장자리다 (「벽 너머는 절벽이라 바닥없음」).
 *   남쪽 `pit_wall_s` — x 1.5 … 7.5, z −149 … −149.6. 철조망을 넘어 날아온 수류탄을 **멈추는 벽**(옛 `BACKSTOP` 의 몫)이고, 그 뒤는
 *              절벽(`ABYSS_CUTS` 의 `cut_s`)이다. 동쪽 벽과 모서리(7.5, −149 … −149.6)를 나눠 가진다.
 * **열린 면 둘**: 북쪽(철조망을 마주 보는 면 — 넘겨 던진 수류탄이 들어오는 길)과 서쪽(함선 쪽 오르막 `PIT_RAMP_*`).
 * 남쪽 벽이 x 1.5 에서 시작하는 이유는 `SHIP_STRIP_X1` 주석.
 */
export const PIT_WALLS: readonly DeckRect[] = [
  // 2026-09-16: 동쪽 벽이 북쪽 턱의 두께만큼 북쪽으로 늘었다 (−140.5 → −139.9) — 턱과 벽의 모서리를 벽이 닫는다
  { id: 'pit_wall_e', rect: { x0: PIT.x1, x1: PIT_EAST_X, z0: PIT.z0 + PIT_WALL_T, z1: PIT.z1 - PIT_WALL_T }, top: DECK_LOWER_Y + PIT_WALL_H },
  { id: 'pit_wall_s', rect: { x0: SHIP_STRIP_X1, x1: PIT.x1, z0: PIT.z1, z1: PIT.z1 - PIT_WALL_T }, top: DECK_LOWER_Y + PIT_WALL_H },
  // 2026-09-16: 북쪽 턱 (`PIT_NORTH_RIM_H` 주석) — 그 북쪽은 철조망 계단의 절벽 구멍이다
  { id: 'pit_rim_n', rect: { x0: PIT.x0, x1: PIT.x1, z0: PIT.z0 + PIT_WALL_T, z1: PIT.z0 }, top: DECK_LOWER_Y + PIT_NORTH_RIM_H },
];

/**
 * 철조망 **먼 면**(방벽 콜라이더의 건너편 면 — 중심선에서 `BARRIER_HALF_T` 뒤)이 그 x 에서 지나는 z. 방벽은 위에서 보면 `\` 라 x 가 커질수록
 * z 가 커진다: x −8.5 에서 **−140.82** · x 8.1 에서 −125.20 · x 15.4 에서 −118.33 (기울기 dz/dx = 0.941).
 */
export function fenceFarFaceZ(x: number): number {
  const len = Math.hypot(BARRIER_NEAR_END.x - BARRIER_FAR_END.x, BARRIER_NEAR_END.z - BARRIER_FAR_END.z);
  const dx = (BARRIER_NEAR_END.x - BARRIER_FAR_END.x) / len, dz = (BARRIER_NEAR_END.z - BARRIER_FAR_END.z) / len;
  // 가까운 쪽 법선이 (−dz, dx) 이므로 먼 면 위의 한 점 = far 끝 − 법선 × halfT
  const px = BARRIER_FAR_END.x + dz * BARRIER_HALF_T, pz = BARRIER_FAR_END.z - dx * BARRIER_HALF_T;
  return pz + (dz / dx) * (x - px);
}
/** 철조망 계단 한 칸의 x 폭 (m). */
export const FENCE_EDGE_STEP_M = 1;
/**
 * 철조망 먼 면 뒤에 **최소한** 남기는 바닥 (m, 칸의 왼쪽 끝에서 — 칸 안에서는 기울기만큼 0.94 m 더 넓어진다). 방벽 토막이 허공에 걸려
 * 보이지 않게 하는 턱이고, 2026-09-15 의 오른쪽 계단 표의 최솟값(0.35)을 그대로 쓴다.
 */
export const FENCE_LEDGE_MIN_M = 0.35;
/** 칸의 구멍이 이보다 얕으면(m) 구멍을 내지 않고 바닥으로 둔다 — 틈 곁 방벽 `far` 끝 뒤에 0.27 m 짜리 실틈이 생기지 않게. */
export const FENCE_CUT_MIN_M = 0.5;

/** 철조망 계단의 한 칸: x 범위, 가장자리 z(`edge`, 그 앞이 바닥), 구멍이 끝나는 z(`bottom`). `edge === bottom` 이면 구멍이 없다. */
interface FenceColumn { readonly x0: number; readonly x1: number; readonly edge: number; readonly bottom: number }

/**
 * 철조망 계단 칸들 (x 오름차순). 칸 경계 = 방벽 `far` 끝(−8.5)부터 `FENCE_EDGE_STEP_M` 간격 + 웅덩이 서쪽 끝(−2) · 동쪽 벽 바깥 면(8.1) ·
 * 통로 오른쪽 끝(15.4). 가장자리 = `min(fenceFarFaceZ(x0) − FENCE_LEDGE_MIN_M, ABYSS_CUT_Z0)` — 방벽이 `\` 라 칸의 왼쪽 끝에서 먼 면이
 * 가장 뒤이므로, 거기서 턱을 재면 칸 전체에서 가장자리가 먼 면보다 뒤다 (= **가까운 쪽에 구멍이 나지 않는다**). `ABYSS_CUT_Z0` 로 자르는
 * 이유는 협곡 바닥 판(`parts/Ground` 의 `tut-void-floor`)이 거기서 끝나기 때문이다 (그 앞에 구멍이 나면 구멍 밑에 판이 보인다).
 * 구멍의 남쪽 끝(`bottom`)은 그 칸 아래에 무엇이 오느냐다: x ≤ −2 는 길(`lower_pit_w`, −140.5), x −2 … 8.1 은 웅덩이 북쪽 턱 · 동쪽 벽
 * (−139.9), x ≥ 8.1 은 옛 가장자리(`ABYSS_EDGE_Z`)까지 통째로.
 */
function fenceColumns(): FenceColumn[] {
  const xs = new Set<number>([PIT.x0, PIT_EAST_X, CORRIDOR_MAX_HALF_X]);
  for (let x = BARRIER_FAR_END.x; x < CORRIDOR_MAX_HALF_X - 1e-6; x += FENCE_EDGE_STEP_M) xs.add(x);
  const sorted = [...xs].sort((a, b) => a - b);
  const out: FenceColumn[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const x0 = sorted[i], x1 = sorted[i + 1];
    const bottom = x1 <= PIT.x0 ? PIT.z0 : x0 >= PIT_EAST_X ? ABYSS_EDGE_Z : PIT.z0 + PIT_WALL_T;
    const edge = Math.min(fenceFarFaceZ(x0) - FENCE_LEDGE_MIN_M, ABYSS_CUT_Z0);
    out.push({ x0, x1, edge: edge - bottom >= FENCE_CUT_MIN_M ? edge : bottom, bottom });
  }
  return out;
}
const FENCE_COLUMNS = fenceColumns();
/**
 * 철조망 계단이 시작하는 x (**−6.5**) — 그 왼쪽(방벽 왼쪽 틈 · `far` 끝 뒤의 0.35 … 1.56 m 턱)은 통째로 바닥(`lower_gap`)이다.
 * 칸 [−7.5, −6.5] 은 구멍이 0.27 m 뿐이라 `FENCE_CUT_MIN_M` 에 걸려 바닥으로 남는다.
 */
export const FENCE_STAIR_X0 = FENCE_COLUMNS.find((c) => c.edge > c.bottom)?.x0 ?? CORRIDOR_MAX_HALF_X;

/**
 * **철조망 너머의 절벽 구멍** (2026-09-15 3차 → **2026-09-16 전면 개편**, 사용자 결정 — 「철조망 너머는 전부 바닥 없는 절벽이다. 남는 것은
 * 왼쪽 틈에서 함선까지의 길, 함선 언덕, 안드로이드 웅덩이뿐」). 아래 데크에서 **바닥이 없는** 축 정렬 사각형들 — 낙하 규칙 `kill`
 * 볼륨(`FALL_RULES`) · 「마지막으로 서 있던 자리」의 가장자리 띠(`inAbyssCut`, `ABYSS_SAFE_MARGIN_M`) · 부스러기 제외가 읽는다. 땅 자체는
 * `DECKS` 의 아래 데크 조각들이 **이 사각형들을 비워 두는 것**으로 생긴다 (두 목록이 서로의 보수여야 한다 — `lowerTilingErrors` 가 생성할 때 잰다).
 *
 * 남는 바닥: (a) 방벽 가까운 쪽 통로 전체 (`lower_n` · `lower_gap` · `lower_fence_*` — 철조망 먼 면 뒤 0.35 … 1.29 m 턱까지),
 * (b) 방벽 왼쪽 틈에서 함선까지의 길 (`lower_pit_w`, x −15.4 … −2 · z −140.5 … −149 — 웅덩이 오르막이 여기로 올라온다),
 * (c) 함선 언덕 (`SHIP_SLOPE` 오르막 + `ship_hill`, x ≤ `SHIP_STRIP_X1`), (d) 웅덩이 + 벽 + 북쪽 턱 + 오르막 (섬 — 길에서 오르막으로만 들어간다).
 * 2026-09-15 의 (d) 「철조망과 웅덩이 사이의 평지」는 없어졌다.
 *
 * **철조망 계단** (`FENCE_COLUMNS`): 방벽의 먼 면을 따라 1 m 칸마다 가장자리를 올린다 — 칸 26 개 중 구멍이 있는 것은 x −6.5 부터의 24 개.
 *   | x 범위 | 가장자리 z | 구멍의 남쪽 끝 | 먼 면 ~ 가장자리 (턱) |
 *   | −6.5 … −2   | −139.29 … −135.53 | −140.5 (길)          | 0.35 … 1.29 |
 *   | −2 … 8.1    | −135.06 … −126.12 | −139.9 (턱 · 동쪽 벽) | 0.35 … 1.29 |
 *   | 8.1 … 14.5  | −125.55 … −120.47 | −172                 | 0.35 … 1.29 |
 *   | 14.5 … 15.4 | −120 (`ABYSS_CUT_Z0` 로 잘림) | −172        | 0.82 … 1.67 |
 *   콘크리트 토막 둘(`far` 끝 along 0 … 3.5, `near` 끝 along 27 … 35)도 먼 면 뒤에 ≥ 0.35 m 바닥이 남아 허공에 걸리지 않는다.
 *   시체 ③ (9, −117) 은 그 칸의 가장자리(−125.17)보다 8.2 m 앞이다.
 *
 * **남쪽** (`cut_s`, 2026-09-15 그대로): 남쪽 벽의 바깥 면(−149.6)부터 옛 가장자리(`ABYSS_EDGE_Z`)까지, x `SHIP_STRIP_X1` … `PIT_EAST_X`.
 * 함선 발자국과 4.26 m 떨어져 있고 이륙은 기수 쪽(오른쪽 앞)으로 **떠서** 나가므로 바닥이 필요 없다 (`extraction/Hull` 콜라이더는 착륙 중에만 있다).
 */
export const ABYSS_CUTS: readonly Rect[] = [
  ...FENCE_COLUMNS.filter((c) => c.edge > c.bottom).map((c): Rect => ({ x0: c.x0, x1: c.x1, z0: c.edge, z1: c.bottom })),
  { x0: SHIP_STRIP_X1, x1: PIT_EAST_X, z0: PIT.z1 - PIT_WALL_T, z1: ABYSS_EDGE_Z },           // cut_s — 남쪽 벽 너머
];

/** 그 점이 절벽 구멍 안인가 (`margin` 만큼 넉넉히 — 가장자리 띠 판정). */
export function inAbyssCut(x: number, z: number, margin = 0): boolean {
  for (const c of ABYSS_CUTS) {
    if (x >= c.x0 - margin && x <= c.x1 + margin && z <= c.z0 + margin && z >= c.z1 - margin) return true;
  }
  return false;
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
 * 걸어 다니는 땅. 위 데크 둘 + 아래 데크 조각들(2026-09-16: 철조망 계단 칸마다 하나 + 함선 언덕)이고 그 사이의 **빈 곳이 곧 절벽**이다:
 *   `upper_a` ↔ `upper_b` 사이 = 절벽 1 (달려서 점프해야 넘는다 — 가장자리가 **사선**이라 두 회전 OBB
 *     `parts/Ground.buildChasmEdges` 가 여기서부터 사선까지를 마저 채운다),
 *   `upper_b` 의 끝(z = `CLIFF2_EDGE_Z` −77)에서 `lower_n` 으로 = 절벽 2 (뛰어내린다),
 *   아래 데크 조각들 사이의 구멍 = 안드로이드 웅덩이(`PIT`, 0.9 m) 와 철조망 너머의 절벽 구멍(`ABYSS_CUTS`, `kill`),
 *   `ship_hill` 의 끝(z = `ABYSS_EDGE_Z` −172) 너머 = 끝없는 절벽 (2026-09-15 — 떨어지면 `kill`).
 *
 * ⚠ `upper_a.z1`(85.8) · `upper_b.z0`(74.9) 는 **사선에서 가장 물러난 자리**다 — 축 정렬 사각형이라 사선을
 * 그대로 담을 수 없어서, 사선까지의 쐐기는 회전 OBB 가 덮고 이 둘은 그 안쪽에서 끝난다. 검산은
 * `CHASM_EDGE` 주석에.
 *
 * ⚠ 2026-09-16 — **아래 데크는 조각들**이다 (철조망 계단 칸마다 하나). 철조망 너머의 절벽 구멍(`ABYSS_CUTS`)과 안드로이드 웅덩이(`PIT`)가
 * **조각들 사이의 빈 곳**으로 생긴다. 아래 조각(윗면 < `DECK_UPPER_Y`)의 합집합 + `SHIP_SLOPE` + `PIT` + `PIT_WALLS` + `ABYSS_CUTS` 가
 * 정확히 옛 `lower`(x ±15.4 · z −77 … −172)를 **한 번씩** 덮어야 한다 — `lowerTilingErrors` 가 0.25 m 표본으로 재고 `TutorialWorld.build` 가 경고한다.
 *   `lower_n`         x ±15.4          z  −77 … −120    구멍이 시작되기 전 통째 (절벽 2 착지 · 보급 · `wall` 체크포인트 · 시체 ③)
 *   `lower_gap`       x −15.4 … −6.5   z −120 … −140.5  방벽 왼쪽 틈 + 그 앞 통로 (`FENCE_STAIR_X0`)
 *   `lower_fence_*`   x −6.5 … 14.5    z −120 … 가장자리 철조망 가까운 쪽 통로 — 1 m 칸마다 먼 면을 따라 끝난다 (`ABYSS_CUTS` 표)
 *   `lower_pit_w`     x −15.4 … −2     z −140.5 … −149  **길** — 틈에서 함선 언덕까지, 웅덩이 오르막 위 끝
 *   (`SHIP_SLOPE`)    x −15.4 … 1.5    z −149 … −153.5  언덕 오르막 (경사 콜라이더라 이 목록 밖 — `parts/Ground.buildShipSlope`)
 *   `ship_hill`       x −15.4 … 1.5    z −153.5 … −172  **함선 언덕** (윗면 `SHIP_HILL_Y`), 끝은 옛 끝없는 절벽
 * 아래 데크 조각끼리의 이음매는 `parts/Ground` 가 콜라이더만 `TILE_OVERLAP` 만큼 넓혀 겹친다 (`growRect`) — `tileRect` 가 안쪽
 * 경계에 하는 것과 같은 이유이고, 그림(윗면 판)은 설계 치수 그대로라 겹친 판이 깜박이지 않는다.
 */
export const DECKS: readonly DeckRect[] = [
  { id: 'upper_a', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: 118, z1: 85.8 }, top: DECK_UPPER_Y },
  { id: 'upper_b', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: 74.9, z1: CLIFF2_EDGE_Z }, top: DECK_UPPER_Y },
  { id: 'lower_n', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: CLIFF2_EDGE_Z, z1: ABYSS_CUT_Z0 }, top: DECK_LOWER_Y },
  { id: 'lower_gap', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: FENCE_STAIR_X0, z0: ABYSS_CUT_Z0, z1: PIT.z0 }, top: DECK_LOWER_Y },
  ...FENCE_COLUMNS.filter((c) => c.x0 >= FENCE_STAIR_X0 && c.edge < ABYSS_CUT_Z0).map((c, i): DeckRect => ({
    id: `lower_fence_${i}`, rect: { x0: c.x0, x1: c.x1, z0: ABYSS_CUT_Z0, z1: c.edge }, top: DECK_LOWER_Y,
  })),
  { id: 'lower_pit_w', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: PIT.x0, z0: PIT.z0, z1: PIT.z1 }, top: DECK_LOWER_Y },
  { id: 'ship_hill', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: SHIP_STRIP_X1, z0: SHIP_HILL_Z0, z1: ABYSS_EDGE_Z }, top: SHIP_HILL_Y },
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

/** `x1` 은 띠의 오른쪽 끝 — 기본 `W`. 오른쪽이 벽이 아니라 **절벽 구멍**인 `ship` 만 좁힌다 (그 줄의 주석). */
function cp(id: TutorialCheckpointId, x: number, y: number, z: number, z0: number, z1: number, x1 = W): CheckpointSpec {
  const upper = y > (DECK_UPPER_Y + DECK_LOWER_Y) / 2;
  return {
    id,
    at: new THREE.Vector3(x, y, z),
    yaw: 0,
    trigger: { x0: -W, x1, z0, z1, y0: upper ? UPPER_Y0 : LOWER_Y0, y1: upper ? UPPER_Y1 : LOWER_Y1 },
  };
}

/**
 * 열 곳. 순서는 `TUTORIAL_CHECKPOINTS` 와 **같아야 한다** (`TutorialWorld` 가 생성자에서 검산한다).
 *
 * ⚠ **배치 규칙**: 모든 체크포인트는 그 구간 적의 감지 반경(`TUTORIAL_ENEMY_SENSE_M` = 12 m) **밖**이다 —
 * 무기를 잃고 부활한 사람이 자기 시체까지 걸어갈 수 있어야 하기 때문이다. 실제 거리는 아래 `ENEMIES` 주석에
 * 계산해 뒀고, 가장 빡빡한 곳은 **17.46 m** (`android` → 왼쪽 안드로이드) 다. 좌표를 고치면 그 표를 다시 계산한다.
 * **단 하나의 예외 — `ship`** (2026-09-15 3차, 사용자 결정): 마지막 안드로이드 둘의 감지 반경은 함선 램프 · 화물칸까지 닿는
 * `FINAL_ANDROID_SENSE_M`(22 m)이고 `ship` 부활 자리(−12.5, −154 — 2026-09-16 언덕 꼭대기)는 거기서 17.07 · 18.61 m 라 **안**이다. 함선 곁 어디에 띠를
 * 두어도 22 m 밖은 없다 (방벽 왼쪽 틈 (−12.2, −140) 조차 14.83 m). 그 구간의 보장은 대신 ① 의도된 길이 수류탄으로 둘을 먼저
 * 처치하는 것이고(`grenade` 단계), ② 철조망 가까운 쪽에서는 적의 사선이 열리지 않는다(`BARRIER` 검산)는 것이다 — `docs/TODO.md` 참고 절.
 *
 * 부활 자리는 `ship` 하나만 빼고 **x = 0** 이라 `CORRIDOR_PROFILE` 을 어떻게 좁혀도 벽 안이다 (가장 좁은 구간의 반폭이
 * 4.6 m 다). `ship` 은 방벽 왼쪽 틈을 지난 자리(x −12.5)이고 그 조각은 파고듦이 0(`WALL_PLAIN_FROM_Z`)이라 벽까지 2.9 m 다.
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
  // 사선 방벽이 시작하기 **전** — 방벽의 가장 가까운 끝(오른쪽 −116)보다 4 m 앞에서 띠가 끝난다 (2026-09-15)
  cp('wall', 0, DECK_LOWER_Y, -108, -104, -112),
  // 2026-09-15: 방벽 왼쪽 틈을 지나 **함선 램프 앞**. 띠(−150 … −158)는 안드로이드 둘(z −144.75)보다 뒤라 그 둘에게 가려고
  // 틈을 지난 사람이 체크포인트를 먼저 얻지 않는다. 램프 발치(−154.8)를 띠가 덮으므로 램프로 걸어가면 반드시 지난다.
  // ⚠ 2026-09-15 3차 — 웅덩이(`PIT`)의 앞 끝이 −149.0 이라 이 띠(−150)와 **1.0 m** 떨어져 있어야 한다 (2차의 −148 을 2 m 뒤로).
  //    이 체크포인트는 `CHECKPOINT_STEP.ship = 'extract'` 라, 웅덩이에 뛰어든 것만으로 튜토리얼이 수류탄 단계를 건너뛰면 안 된다.
  //    띠의 오른쪽 끝은 `W` 가 아니라 **함선 띠의 끝**(`SHIP_STRIP_X1`)이다 — 그 오른쪽은 벽이 아니라 절벽 구멍(`cut_s`)이라,
  //    떨어지는 몸(볼륨 y 는 −13 까지 열려 있다)이 띠를 지나며 체크포인트를 얻으면 안 된다.
  // 2026-09-16 — 함선 언덕: 부활 자리를 **언덕 꼭대기**(z −154, y `SHIP_HILL_Y`)로 옮겼다. 옛 −152 는 오르막(−149 … −153.5) 한가운데라
  //    경사면 위에 되살아난다. 띠(−150 … −158)는 그대로 — 오르막 중턱에서 켜지고, 볼륨 y(−13 … −4)가 언덕을 담는다.
  //    x −12.5 · z −154 는 램프 발끝의 왼쪽 모서리(−10.64, −155.08)에서 2.1 m 떨어져 있다.
  cp('ship', -12.5, SHIP_HILL_Y, SHIP_HILL_Z0 - 0.5, -150, -158, SHIP_STRIP_X1),
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
  // 2026-09-15: 협곡 바닥이 지형이 아니라 `CHASM_FLOOR_Y` 콜라이더가 됐으므로 y0 도 그 높이에서 잰다.
  { rule: 'kill', x0: -W - WALL_T, x1: W + WALL_T, z0: CHASM.z0 + 1.5, z1: CHASM.z1 - 1.5, y0: CHASM_FLOOR_Y - 6, y1: DECK_UPPER_Y - 3 },
  // 절벽 2 착지 구역 — 반드시 살아남아야 하는 낙하. 피해는 들어가되 체력 1 밑으로 내려가지 않는다
  { rule: 'clamp', x0: -W, x1: W, z0: CLIFF2_EDGE_Z, z1: -102, y0: DECK_LOWER_Y - 4, y1: DECK_LOWER_Y + 4 },
  // 2026-09-15 — **끝없는 절벽** (함선 앞). 가장자리 너머에서 `VOID_Y`(지형)에 닿으면 즉사 → 평소처럼 부활한다.
  // x 는 낮아지는 벽이 벌어지는 폭(마지막 조각 안쪽 면 18.4)까지 넉넉히, z 는 `Z_END` 너머까지 연다. 위 끝이
  // `DECK_LOWER_Y − 3` 이라 아래 데크 가장자리에 서 있는 몸(y −10)은 이 볼륨 밖이다.
  { rule: 'kill', x0: -CORRIDOR_OUTER_X - 6, x1: CORRIDOR_OUTER_X + 6, z0: ABYSS_EDGE_Z, z1: Z_END - 10, y0: VOID_Y - 6, y1: DECK_LOWER_Y - 3 },
  // 2026-09-15 3차 — **철조망 너머의 절벽 구멍** (`ABYSS_CUTS`): 같은 `kill`. 사각형을 1 m 넓혀 두는데, 데크 위(y −10)는 위 끝
  // `DECK_LOWER_Y − 3` 밖이라 넓힌 만큼이 데크에 걸쳐도 서 있는 몸은 잡히지 않는다 (떨어지는 몸은 데크 옆면에 밀려 구멍 안이다).
  ...ABYSS_CUTS.map((c): FallRuleVolume => ({ rule: 'kill', ...growRect(c, 1), y0: VOID_Y - 6, y1: DECK_LOWER_Y - 3 })),
];

/* ── 사선 방벽 (마지막 구간) ─────────────────────────────────────────────── */

/**
 * **위에서 보면 `\` 모양인 사선 방벽** (2026-09-15, 사용자 결정 — 옛 「무너진 벽」(통로를 가로지르고 가운데 5 m 만 뚫림)을 대체).
 * 앞 = 위로 놓고 보면 오른쪽 가까운 쪽(`near`, 오른쪽 절벽 벽 **속**)에서 시작해 왼쪽 · 앞으로 뻗고, 통로는 **왼쪽 끝의 틈**
 * (`far` 끝과 왼쪽 벽 사이) 말고는 전부 막힌다. 플레이어는 방벽의 가까운 쪽 면을 따라 왼쪽 앞으로 걸어 틈을 돌아 들어간다.
 *
 * 세 토막이다 (`far` 끝에서 방벽을 따라 잰 거리):
 *   0 … `solidFarM`                 콘크리트 (높이 `solidHeight`)
 *   `solidFarM` … 길이 − `solidNearM`  **가로 블라인드 철조망** (높이 `fenceHeight`) — 가로 살 사이로 건너편이 보인다
 *   길이 − `solidNearM` … 길이        콘크리트
 *
 * **철조망은 절반 높이로 보이되 사람은 못 넘는다** (2026-09-15 2차, 사용자 결정 — 「넘겨 던지기 쉽게 낮추되 넘어갈 수는 없게」).
 * 그려지는 철조망은 `fenceHeight`(1.35 = 옛 2.7 의 절반)이고, 콜라이더는 **두 겹**이다 (`parts/Dressing.buildBarrier`):
 *   아래  y 0 … `fenceHeight`      평범한 회전 OBB — 사람 · 적 · 총알 · 수류탄 전부 막는다.
 *   위    y `fenceHeight` … `blockHeight`  같은 회전 OBB 인데 `passRays` + `passSmall` 을 켠 **유령 토막**
 *         (`SpatialHash.ObstacleEntry` 의 world 내부 플래그 — 깨진 창틀이 쓰는 그것):
 *         `raycast` 가 무시하므로 **총알 · 적 시야는 위로 지나가고**, `resolveCollision` 은 반지름이 `SMALL_BODY_R`(0.25)
 *         미만인 몸만 통과시키므로 **수류탄은 지나가고 사람(0.45) · 적은 밀려난다**.
 * 두 토막의 이음매는 `BARRIER_GHOST_OVERLAP`(0.05) 만큼 **겹친다** — 정확히 같은 선이면 부동소수 오차로 그 선 위의 점이
 * 양쪽에서 빠질 수 있다 (`TILE_OVERLAP` 이 있는 이유와 같다).
 *
 * **사선 너머가 보이는가** (그림 · 판정을 따로 쟀다 — 판정은 아래 1.35 토막만 막는다):
 *   - 플레이어 → 안드로이드: 눈 `EYE_STAND` 1.55 · 안드로이드 가슴은 웅덩이 바닥 + 1.17 = 데크 **+0.27** 이라 사선이
 *     내려간다. 철조망에서 **1.85 m 안**에 서면 사선이 철조망 윗면(1.35)보다 높아 **넘어 보이고**, 그보다 뒤면 사선이
 *     6.2° 아래로 완만해져 **살 사이 틈**(세로 각 7.0° — `parts/Dressing` 의 `SLAT_*`)으로 보인다. 두 구간이 이어지므로
 *     어디에 서도 보이고 **쏠 수도 있다** (사선이 곧 탄도선이다 — `weapons/parts/AimLine`).
 *   - 안드로이드 → 플레이어: `Perception.hasLineOfSight` 는 눈 → **가슴**이다. 안드로이드 눈은 웅덩이 바닥 + 1.44 = 데크 **+0.54**
 *     라 철조망 윗면(+1.35)이 눈보다 **0.81 m 위**인데, 플레이어 가슴(데크 +1.17)은 그 눈보다 **0.63 m** 위뿐이다 —
 *     사선이 어디서도 0.81 까지 오르지 못하므로 **거리와 무관하게 막힌다** → 철조망 너머의 플레이어를 **못 본다 · 못 쏜다**.
 *     ⚠ 웅덩이(`PIT`) 때문이 아니다 — 웅덩이가 없어도(눈 = 데크 +1.44, 윗면이 그보다 0.09 아래) 가슴이 눈보다 0.27 낮아
 *     철조망에서 20 m 안에서는 늘 막힌다. 즉 **높이를 절반으로 낮춰도 적의 사선은 열리지 않는다** (실측 대신 모델로 검산했다).
 *     그러니 이 구간은 여전히 **먼저 때리는 쪽이 플레이어**이고, 방벽 왼쪽 틈을 돌아 들어가면 그때부터 평소 총격전이다.
 *
 * **검산** (`near` (17, −116) · `far` (−8.5, −140)):
 *   - 길이 √(25.5² + 24²) = **35.02 m**, 방향 (0.7282, 0.6853) = x 축에서 43.3° — `\` 다.
 *   - 틈 = 왼쪽 벽 안쪽 면(−15.4, z −132…−142 조각의 파고듦 0)에서 `far` 끝(−8.5)까지 **6.9 m** (플레이어 지름 0.9 의 7.7 배).
 *   - `near` 의 x 17 은 오른쪽 절벽 벽 몸통(안쪽 면 13.2 … 바깥 면 18.4) 속이라 방벽과 벽 사이에 틈이 없다.
 *   - 가장 가까운 끝이 z −116 이라 `wall` 체크포인트 띠(−104 … −112)보다 4 m 뒤에서 시작한다.
 *   - **못 넘는다**: 점프 높이 `JUMP_SPEED² / 2g` = 7.6² / 48 = 1.20 m 에 올라설 수 있는 단 `PROP_STEP_UP_MAX` 0.9 를 더해도
 *     **2.10 m** < 유령 토막 윗면 `blockHeight` 2.7 · 콘크리트 3.0. (그려진 1.35 만 막았다면 정확히 넘어갔다.)
 *   - **넘겨 던진다**: 손 높이 1.55 에서 **수평으로** 던져도 궤적 꼭대기가 1.55 + 3.5²/(2×24) = **1.805 m** > 1.35 라
 *     올려 던질 필요가 없다 (옛 2.7 은 7.5° 이상 올려야 했고 그만큼 멀리 떨어졌다). 넘어간 수류탄은 웅덩이 남쪽 벽(`PIT_WALLS`)이 멈춘다.
 *   - **두께** 1.2 m(`halfT` 0.6)는 수류탄 때문이다. 투척물은 걸음마다 위치를 옮긴 뒤 `resolveCollision` 이 **가까운 면**으로
 *     밀어내므로, 한 걸음에 방벽의 절반(0.6) + 몸(0.08) = 0.68 m 를 넘게 나아가면 반대편으로 밀려 나간다. 34 m/s 에서
 *     0.68 m = **50 fps** 이상이면 정면으로 던진 수류탄도 막힌다 (옛 무너진 벽 2.2 m 는 29 fps). 그림은 두께 1.1 m 에
 *     살 두 겹이라 콜라이더 면과 살이 5 cm 차이다.
 */
export const BARRIER = {
  // 끝점 · 두께는 파일 위쪽의 `BARRIER_NEAR_END` · `BARRIER_FAR_END` · `BARRIER_HALF_T` (철조망 계단이 초기화 순서상 먼저 읽는다)
  near: BARRIER_NEAR_END,
  far: BARRIER_FAR_END,
  halfT: BARRIER_HALF_T,
  /**
   * **그려지는** 철조망의 높이. 2026-09-15 2차 사용자 결정으로 2.7 → **1.35**(절반) — 넘겨 던지기가 이 구간의 요점인데
   * 2.7 은 수평 투척(꼭대기 1.855)으로 못 넘었다. 막는 일은 `blockHeight` 가 대신한다.
   * 2026-09-17 사용자 결정으로 ×1.5 → **2.025**. 이제 수평 투척(꼭대기 1.805)은 걸리고 **살짝 올려 던져야** 넘어간다.
   * 서서 보는 눈(1.55)보다 높아 위로 넘겨 보이는 자리는 없고, 건너편은 살 사이 틈(세로 각 10.4° — `parts/Dressing` 의 `SLAT_*`)으로만 보인다
   * (웅덩이 속 안드로이드 가슴을 보는 각은 철조망에 붙어 서도 6.2° 이하). `blockHeight` 2.7 · `solidHeight` 3.0 보다 여전히 낮다.
   * 콜라이더(아래 토막 윗면)는 이 값을 그대로 읽으므로 그림과 같이 올라간다. 아래 표의 1.35 기준 검산은 2026-09-15 당시 값이다.
   */
  fenceHeight: 2.025,
  /**
   * 사람 · 적을 막는 기둥의 **윗면** (철조망 밑동 기준). `fenceHeight` 위는 `passRays` + `passSmall` 유령이라 보이지도 않고
   * 총알 · 시야 · 수류탄도 지나가지만, 몸은 여기까지 밀려난다. 근거: 점프 1.20 + 올라설 수 있는 단 0.9 = **2.10 m** 위여야 한다.
   */
  blockHeight: 2.7,
  /**
   * 콘크리트 토막의 높이. 이륙 연출 카메라(`extraction/Cinematic` 의 `CAM_OFFSET` y 3.2 — **함선 바닥 기준**)보다 낮아야 한다: 카메라가
   * 방벽 `far` 끝 3 m 옆(아래 `SHIP_POS` 검산)에서 시작하므로, 더 높으면 카메라가 콘크리트 속에서 출발한다. 2026-09-16 함선이 언덕
   * (`SHIP_HILL_RISE` 0.9) 위에 서면서 카메라는 데크 +4.1 에서 출발한다 — 한계가 3.2 → **4.1**, 지금 여유 1.1 m.
   */
  solidHeight: 3.0,
  /** `far` 끝 콘크리트 토막의 길이. */
  solidFarM: 3.5,
  /** `near` 끝 콘크리트 토막의 길이 (오른쪽 벽 속으로 1.6 m 가 묻힌다). */
  solidNearM: 8,
} as const;

/** 아래(막는) 토막과 위(유령) 토막이 겹치는 높이 — `TILE_OVERLAP` 과 같은 이유다. */
export const BARRIER_GHOST_OVERLAP = 0.05;

/** 방벽의 길이 (m). */
export const BARRIER_LEN = Math.hypot(BARRIER.near.x - BARRIER.far.x, BARRIER.near.z - BARRIER.far.z);
/** `far` → `near` 단위 벡터 (방벽을 따라). */
export const BARRIER_DIR = {
  x: (BARRIER.near.x - BARRIER.far.x) / BARRIER_LEN,
  z: (BARRIER.near.z - BARRIER.far.z) / BARRIER_LEN,
} as const;
/** **가까운 쪽**(플레이어가 오는 쪽, +z 성분이 양수)을 향한 법선 = 방향을 +90° 돌린 것 `(−dir.z, dir.x)`. */
export const BARRIER_NORMAL = { x: -BARRIER_DIR.z, z: BARRIER_DIR.x } as const;
/** 메시 `rotateY` 값 — 로컬 +X 가 방벽 방향이 된다 (`rotateY(θ)` 는 +X 를 `(cos θ, −sin θ)` 로 보낸다). */
export const BARRIER_MESH_YAW = -Math.atan2(BARRIER_DIR.z, BARRIER_DIR.x);

/** 방벽 좌표 (`along` = `far` 끝에서 방벽을 따라 잰 거리, `depth` = 가까운 쪽 +) → 월드 XZ. */
export function barrierPoint(along: number, depth: number): { x: number; z: number } {
  return {
    x: BARRIER.far.x + BARRIER_DIR.x * along + BARRIER_NORMAL.x * depth,
    z: BARRIER.far.z + BARRIER_DIR.z * along + BARRIER_NORMAL.z * depth,
  };
}

/** 월드 XZ → 방벽 좌표. */
export function barrierLocal(x: number, z: number): { along: number; depth: number } {
  const dx = x - BARRIER.far.x, dz = z - BARRIER.far.z;
  return { along: dx * BARRIER_DIR.x + dz * BARRIER_DIR.z, depth: dx * BARRIER_NORMAL.x + dz * BARRIER_NORMAL.z };
}

/* ── 안드로이드 웅덩이의 오르막 (마지막 구간) ────────────────────────────── */

/**
 * 함선 쪽(−X) 면을 채우는 **오르막**의 수평 길이. 동쪽 · 남쪽은 벽(`PIT_WALLS`), 북쪽(철조망 쪽 — 2026-09-16 부터 턱 `pit_rim_n`, 그 너머
 * 절벽)과 오르막 남쪽 턱(x −2 … 1.5 — 그 너머는 함선 언덕 오르막 `SHIP_SLOPE`)은 0.9 m 턱(수직)이다. 그래서 웅덩이는 **섬**이고 들어가는
 * 길은 이 오르막 하나다 (사람 · 적은 0.9 m 턱을 올라설 수 있지만 북쪽 턱 너머는 절벽이다).
 * 경사 atan(0.9 / 2.5) = **19.8°** — `PlayerController` 의 `STEEP_COS`(50°) 안이고, 애초에 경사 콜라이더(`Obstacle.ramp`)라
 * 지형 경사 판정을 타지도 않는다 (`CLAUDE.md` 「지형 경사 판정은 발이 지형 위일 때만」).
 *
 * 왜 −X 면인가: 플레이어는 방벽 왼쪽 틈(≈ x −12.2, z −140)을 돌아 함선(−8.5, −158)으로 걸어간다 — 웅덩이의 −X 면이
 * 그 길을 마주 보는 면이다. 여기에 언덕을 두면 결정문의 「함선이 있는 곳까지 오르막으로 이어진다」가 그대로 되고,
 * 쫓아 나오는 안드로이드도 플레이어 쪽으로 올라온다. 오르막 위 끝(x −2)에서 함선 길(x ≤ −8.5)까지 6.5 m 라 길을 막지 않는다.
 */
export const PIT_RAMP_RUN = 2.5;
/** 오르막이 끝나고 평평한 바닥이 시작하는 x (0.5). A1(x 1.85)은 여기서 **1.35 m** 안쪽이라 평지에 선다. */
export const PIT_RAMP_TOE_X = PIT.x0 + PIT_RAMP_RUN;
/**
 * 오르막 콜라이더가 데크 밑으로 파고드는 길이 — `CLAUDE.md` 의 「램프 위 끝이 평지 바닥판과 0.08 m 겹쳐야 한다」.
 * 정확히 같은 선이면 부동소수 오차로 이음매의 점을 양쪽이 모두 놓쳐 발밑이 한 층 아래가 된다.
 */
export const PIT_RAMP_OVERLAP = 0.08;

/**
 * 그 자리의 **웅덩이 표면 높이** (평평한 바닥 또는 오르막), 웅덩이 밖이면 null. 꾸밈(`parts/Dressing`)이
 * 부스러기를 웅덩이 안에 놓을 때 쓴다 — 데크 높이로 놓으면 0.9 m 떠 보인다.
 */
export function pitSurfaceY(x: number, z: number): number | null {
  if (!rectContains(PIT, x, z)) return null;
  if (x >= PIT_RAMP_TOE_X) return PIT_FLOOR_Y;
  return DECK_LOWER_Y - PIT_DEPTH * ((x - PIT.x0) / PIT_RAMP_RUN);
}

/**
 * 그 자리의 **함선 언덕 표면 높이** (오르막 `SHIP_SLOPE` 또는 꼭대기 `ship_hill`), 언덕 밖이면 null (2026-09-16). 꾸밈이 부스러기를
 * 언덕 위에 놓을 때 · `parts/Ground` 가 오르막 쐐기를 그릴 때 쓴다 (`pitSurfaceY` 와 같은 이유 — 데크 높이로 놓으면 0.9 m 묻힌다).
 * 그림의 경사다 (4.5 m 에 0.9) — 경사 콜라이더는 언덕 밑으로 0.08 m 더 파고들어 최대 1.6 cm 낮다 (`Ground.buildShipSlope` ④).
 */
export function shipHillSurfaceY(x: number, z: number): number | null {
  if (x < -CORRIDOR_MAX_HALF_X || x > SHIP_STRIP_X1 || z > SHIP_SLOPE.z0 || z < ABYSS_EDGE_Z) return null;
  if (z <= SHIP_HILL_Z0) return SHIP_HILL_Y;
  return DECK_LOWER_Y + SHIP_HILL_RISE * ((SHIP_SLOPE.z0 - z) / SHIP_SLOPE_RUN);
}

/* ── 버려진 함선 (= 진짜 탈출선을 착륙 상태로 세운다) ────────────────────── */

/**
 * `ctx.extraction.beginPreLanded(position, yaw)` 에 넘길 자리. 함선 원점은 데크 위에 있고 (`Ship.floorYAt` 규약),
 * **뒷 램프는 `(sin yaw, cos yaw)` 쪽으로 열린다** — yaw 0 이면 +Z, 즉 다가오는 플레이어 정면이다.
 * (적 목록보다 **앞**에 있어야 한다 — 마지막 안드로이드 둘의 yaw 를 `SHIP_POS` 에서 뽑는다.)
 *
 * 2026-09-15 (사용자 결정 — 「함선은 왼쪽, 살짝 비스듬히, 램프가 다가오는 쪽을 보게」): **왼쪽**(x −8.5)에 **yaw −10°** 로 세운다.
 * 램프가 왼쪽 뒤(−0.174, 0.985)를 보므로 방벽 왼쪽 틈에서 곧장 걸어 들어온다. 이륙은 기수 쪽 (0.174, −0.985) = 오른쪽 앞으로
 * 날아가 **벽에서 멀어진다**.
 *
 * **검산** (월드, `extraction/Hull` 외피 + 램프 + 나셀 · 날개 · 꼬리를 0.25 m 간격으로 옮겨 쟀다):
 *   - 발자국 x −13.13 … −2.76 · z −167.80 … −154.50 → 왼쪽 벽(−15.4, `WALL_PLAIN_FROM_Z`)까지 **2.27 m**, 끝없는 절벽
 *     가장자리(−172)까지 **4.20 m**, 방벽까지 **14.05 m**, 함선 띠의 오른쪽 끝(`SHIP_STRIP_X1` 1.5, 그 너머는 절벽 구멍)까지 **4.26 m**.
 *     2026-09-16: 함선 언덕 `ship_hill`(x −15.4 … 1.5 · z −153.5 … −172)이 발자국을 통째로 담는다 — 램프 발끝(z −154.52 … −155.08)은
 *     오르막 끝에서 1.0 m 뒤다. x · z · yaw 는 2026-09-15 그대로다.
 *   - **y = `SHIP_HILL_Y`** (2026-09-16): 뒷문 램프는 함선 바닥 높이에 **평평하게** 펼쳐지므로(`extraction/Ship` 의 `rampAngle` 0) 그 밑의
 *     언덕 윗면과 같아야 한다 — 낮으면 램프 끝에 턱이 생기고, 높으면 램프를 뚫고 땅이 올라온다. 외피 콜라이더의 바닥(`extraction/Hull` 의
 *     `ship.getGroundY()` = 이 y)도, 화물칸 바닥 그림의 여유(`Ship.GROUND_DRAW_LIFT_MAX` — 언덕 윗면 판도 `TOP_LIFT` 0.02)도 그대로 맞는다.
 *   - 램프 발치(로컬 0, 3.25) = (−9.06, −154.80). 틈 한가운데 (−12.20, −140) 에서 거기로 걷는 방향이 램프 축과 **2.0°** 어긋난다.
 *     그 길(x ≈ −9 … −12)은 웅덩이 오르막 위 끝(x −2)에서 6.5 m 이상 떨어져 있다.
 *   - 이륙 궤적(스풀 1.6 s + 상승 `6a² + 2a` · 전진 `12(a − 0.8)²` · 기수 들기 0.35 rad)을 0.02 s 간격으로 따라가며 모든 표본점을
 *     옆 절벽 벽 조각(안쪽 면 · 윗면)과 비교했다 — **닿는 곳이 없다** (벽 윗면을 넘기 전의 전진은 오른쪽 앞으로 18.5 m 뿐이다).
 *     웅덩이 벽(윗면 데크 +2.5 = −7.5)은 발자국에서 x 로 4.26 m 이상 오른쪽이라 궤적과 무관하다.
 *   - 이륙 연출 카메라의 첫 자리(로컬 7.5, 3.2, 17) = (−4.07, **−5.9**, −139.96) (2026-09-16 언덕 +0.9): 방벽 건너편 3.0 m · `far` 끝에서
 *     3.3 m 라 콘크리트 토막(윗면 −7.0)보다 **1.1 m** 위이고, 발밑은 철조망 계단의 절벽 구멍(칸 x −4.5 … −3.5)이다 — 떠 있는 카메라라
 *     바닥이 필요 없다. 웅덩이(`PIT`, x ≥ −2)와는 x 로 2.07 m 밖이다.
 */
export const SHIP_POS = new THREE.Vector3(-8.5, SHIP_HILL_Y, -158);
export const SHIP_YAW = (-10 * Math.PI) / 180;

/* ── 적 ──────────────────────────────────────────────────────────────────── */

export interface EnemySpot {
  readonly type: string; readonly x: number; readonly y: number; readonly z: number; readonly yaw: number;
  /** 이 마리만의 감지 반경 (m). 없으면 `ENEMY_SENSE`(csv). 마지막 둘만 `FINAL_ANDROID_SENSE_M` 이다. */
  readonly sense?: number;
  /**
   * 스폰이 쥐여 주는 총 **계열 id** (`data/weapons.csv` 의 등급 I id — `'sg'` · `'dmr'`). 없으면 팩션 표의 첫 항목
   * (`enemies/Tutorial.weaponFor`). `*_loot` 타입이면 그 총이 그대로 시체에 떨어진다 (`loot_corpse_rolls.csv`).
   */
  readonly weapon?: string;
}

/**
 * 월드가 `enemies/` 에 넘기는 한 줄 = 공용 계약 `TutorialEnemySpawn` + 이 맵만의 `weapon`. 계약(`shared/tutorialWorld`)은 추가
 * 전용이지만 지금은 다른 작업이 `src/shared` 를 편집 중이라 손대지 않았다 — 월드는 이 확장 타입으로 만들고, `enemies/Tutorial`
 * 은 `weapon` 을 선택 필드로 읽는다 (`docs/TODO.md` 참고 절: 계약에 올리는 일).
 */
export interface TutorialSpawnSpec extends TutorialEnemySpawn { weapon?: string }

/**
 * 마지막 안드로이드 둘 — 웅덩이 한가운데 (2.75, −144.75) 에서 x 로 ±0.9 (간격 **1.8 m**, 몸(반지름 0.4) 사이 1.0 m). 왜 이렇게
 * 붙어 서는지는 `PIT` 주석 (「×2 가 아니라 ×1.55」) — 모서리 표의 최대 7.07 < `GRENADE_RADIUS` 7.2 는 이 간격에서 나온다.
 *   A1 = (1.85, −144.75) 산탄총 · A2 = (3.65, −144.75) 지정사수소총, 발 높이 `PIT_FLOOR_Y`.
 * 방벽 좌표로 A1 along 4.28 · depth −10.55, A2 along 5.59 · depth −11.79 — 둘 다 철조망 토막(along 3.5 … 27.0) 앞이라
 * 콘크리트 토막 뒤에 숨지 않고, 철조망 건너편 10.5 · 11.8 m 다 (2차의 10 m 와 거의 같다).
 */
export const FINAL_ANDROIDS = { cx: (PIT.x0 + PIT.x1) / 2, cz: (PIT.z0 + PIT.z1) / 2, halfGap: 0.9 } as const;
/**
 * 마지막 둘의 감지 반경 (m) — 2026-09-15 3차 사용자 결정 「함선 램프 · 화물칸이 감지 반경 안에 들도록 (~22 m)」. 형상 수치라
 * 여기 있다: 두 대에서 램프 발치(−9.06, −154.8)까지 **14.84 · 16.21**, 화물칸 한가운데(로컬 z −2.5 = (−8.07, −160.46))까지
 * **18.58 · 19.60** 이라 22 는 거기에 2.4 m 여유다. csv 의 `TUTORIAL_ENEMY_SENSE_M`(12)은 나머지 넷이 그대로 쓴다.
 * 이 반경이 `ship` 체크포인트(17.07 · 18.61)와 방벽 왼쪽 틈(14.83 · 16.55)까지 담는다는 것은 `CHECKPOINTS` 주석의 예외.
 * 스위치를 누른 뒤에는 `enemies/Tutorial` 의 이륙 사격 창이 반경을 `TUTORIAL_LIFTOFF_FIRE_RANGE_M` 로 더 넓힌다 (두 번째 깨우기).
 */
export const FINAL_ANDROID_SENSE_M = 22;
const FINAL_A1 = { x: FINAL_ANDROIDS.cx - FINAL_ANDROIDS.halfGap, z: FINAL_ANDROIDS.cz };
const FINAL_A2 = { x: FINAL_ANDROIDS.cx + FINAL_ANDROIDS.halfGap, z: FINAL_ANDROIDS.cz };
/**
 * 그 자리에서 **함선**(`SHIP_POS`)을 보는 yaw. 적 yaw 의 정면은 `(sin yaw, cos yaw)` 다 (`enemies/Enemy.facing` · `ai/Steering`) → yaw = atan2(dx, dz).
 * A1 **−2.478** (−142.0°, 정면 (−0.616, −0.788)) · A2 **−2.399** (−137.5°, 정면 (−0.676, −0.737)) — 둘 다 왼쪽 앞의 함선을 본다.
 * ⚠ 2026-09-16 에 바로잡았다: 그 전의 atan2(−dx, −dz) 는 **플레이어** yaw 규약(정면 `(−sin, −cos)`)을 베낀 것이라 둘 다 함선을 등지고 섰다.
 */
function yawToShip(x: number, z: number): number { return Math.atan2(SHIP_POS.x - x, SHIP_POS.z - z); }

/**
 * 여섯 마리. 굴림도 웨이브도 순찰도 없다 (`enemies/` 가 `world:ready` 에서 한 번 읽어 그대로 세운다).
 * 앞의 넷은 yaw = π 라 다가오는 플레이어(+Z 쪽)를 보고, 마지막 둘은 **함선**(`yawToShip`)을 본다 (2026-09-15 3차 — 2차까지는 철조망 쪽).
 *
 * **종류** (2026-09-14 3차 — 튜토리얼 전용 타입, `data/enemies.csv` · `enemies/EnemyTypes.TUTORIAL_ENEMY_BASE`):
 * `*_loot` 만 확정 드롭이 있고 나머지는 아무것도 떨어뜨리지 않는다. **+x 가 걸어가는 플레이어의 오른쪽**이다
 * (좌표 규약 절의 forward × up 계산).
 *   벌레            — **가까운 쪽(z 34) = 오른쪽(x +2.5) `tut_bug_loot`** · 먼 쪽(z 28) = 왼쪽(x −2.5) `tut_bug`
 *                     (2026-09-15 사용자 결정 — 좌우를 바꿨다. 드롭은 여전히 가까운 쪽이다)
 *   앉아쏴 안드로이드 — 오른쪽(x +7) `tut_android_loot`(돌격소총) · 왼쪽(x −7) `tut_android`
 *   철조망 건너편    — 둘 다 `tut_android_loot` (2026-09-15 3차, 사용자 결정 — 「둘 다 100 % 드롭, 하나는 산탄총 하나는 지정사수소총」):
 *                     A1 `weapon: 'sg'` · A2 `weapon: 'dmr'`. 등급 I 그대로(`loot_factions.csv` 에 tut 줄이 없어 등급 굴림이 없다),
 *                     그 탄종(셸 · 중량탄) 한 스택 가득, `mat_cable` 하나 — 오른쪽 앉아쏴 안드로이드의 돌격소총과 같은 규칙이다.
 *
 * **체크포인트까지의 거리** (감지 반경 — 앞의 넷 12 m · 마지막 둘 22 m — 를 넘는지의 근거. 좌표를 고치면 다시 계산한다):
 *   `bugs`(0,60)          → (2.5,34) 26.12 · (−2.5,28) 32.10
 *   `crawl`(0,−10)        → (2.5,34) 44.07 · (−2.5,28) 38.08
 *   `android`(0,−32)      → (−7,−48) **17.46** · (7,−54) 23.09
 *   `drop`(0,−71)         → (−7,−48) 24.04 · (7,−54) 18.38
 *   `wall`(0,−108)        → A1 36.80 · A2 36.93
 *   `ship`(−12.5,−154)    → A1 17.07 · A2 18.61 — **22 m 안** (유일한 예외, `CHECKPOINTS` 주석. 2026-09-16 부활 자리를 언덕 꼭대기로 2 m 옮겼다)
 * 예외를 빼면 가장 빡빡한 곳이 17.46 m 다.
 *
 * **자기 구간의 벽 안인가** (반폭은 `corridorHalfXAt`):
 *   벌레 둘   (z 34 · 28) 반폭 `CORRIDOR_BUG_HALF_X` 4.6 → `|x|` 2.5 + `radius` 0.45 = 2.95, **여유 1.65 m**.
 *             벽의 안쪽 면은 `Ground` 의 bite 만큼 더 파고들지만 그 몫도 폭에 비례해 줄어(4 × 0.55 × 4.6/15.4
 *             = 0.66) 최소 3.94 이므로 **여유 0.99 m** 는 남는다. 좌우를 바꿔도 `|x|` 가 같아 그대로다.
 *   앉아쏴 둘 (z −48 · −54) 반폭 15.4 → `|x| ≤ 7`, 여유 8.4 m 이상.
 *   마지막 둘 (z −144.75) 웅덩이 안 — 동쪽 벽(7.5)까지 A2 몸 끝(4.05)에서 3.45 m, 오르막 발끝(0.5)까지 A1 몸 끝(1.45)에서 0.95 m.
 *
 * **철조망 건너편 둘** (2026-09-15 — 「철조망 사이로 보이고, 넘겨 던진 수류탄 하나에 둘」, 3차 — 「함선을 보고 선다 · 함선이 감지 안」):
 *   - 둘 다 철조망 **건너편 10.5 · 11.8 m** 이고 방벽을 따라 4.3 · 5.6 m 라 가까운 쪽 어디서 봐도 그 앞은 철조망 토막(3.5 … 27.0 m)이다.
 *   - 수류탄은 `PIT` · `PIT_WALLS` 주석: 철조망을 수평으로 넘기면 남쪽 벽(2.5 m)에 부딪혀 밑동으로 떨어지고, **웅덩이 안이면 어디서
 *     터져도** 둘 다 7.2 m 안이라 150 피해 > 체력 140 이다.
 *   - **함선이 보인다** — 눈은 웅덩이 바닥 + 1.44 = **−9.46**, 표적 가슴은 **함선 언덕**(`SHIP_HILL_Y`) + 1.17 = **−7.93** (`Perception.hasLineOfSight`
 *     는 눈 → 가슴). 웅덩이에서 함선 쪽으로 열린 면은 서쪽(오르막, x −2)과 오르막 남쪽 턱(x −2 … 1.5, z −149)뿐이다 (북쪽 턱 너머는 절벽,
 *     동쪽 · 남쪽은 벽). 사선이 그 경계를 지나는 자리 / 그 뒤 **땅에서 가장 가까워지는 곳** — 2026-09-16 언덕 +0.9 로 다시 쟀다 (0.001 간격 표본,
 *     웅덩이 오르막 · 턱 · 벽 · 언덕 오르막 · 언덕 모서리를 전부 넣었다). 표적이 0.9 올라가 사선이 가팔라졌을 뿐 막히는 곳이 없다:
 *       A1 → 램프 발치 (−9.06, −154.8):     x −2 를 z **−148.29** · 사선 −8.92 / 가장 가까운 땅: 언덕 모서리 (−7.65, −153.5) 위 **0.97 m**
 *       A2 → 램프 발치:                     z −149 를 x **−1.73** · 사선 −8.81 (웅덩이 오르막 −10.10 위) / 언덕 모서리 (−7.42, −153.5) 위 0.97 m
 *       A1 → 화물칸 한가운데 (−8.07, −160.46): z −149 를 x **−0.83** · 사선 −9.05 / 언덕 모서리 (−3.67, −153.5) 위 **0.49 m**
 *       A2 → 화물칸 한가운데:                z −149 를 x **0.48** · 사선 −9.05 — 남쪽 벽 시작(1.5)까지 **1.02 m** (`SHIP_STRIP_X1` 이 1.5 인 이유) / 언덕 모서리 위 0.49 m
 *       A1 · A2 → 방벽 왼쪽 틈 (−12.2, −140, 가슴 −8.83): x −2 를 z −143.45 · −143.06 에서 → 틈을 돌아 들어오는 순간부터 보인다 (14.83 · 16.55 m).
 *       A1 · A2 → `ship` 부활 자리 (−12.5, −154): 17.07 · 18.61 m, 땅 위 최소 0.95 · 1.08 m.
 *     화물칸 입구 폭(±1.6, 로컬 z 0.6) 검산은 2차 그대로다: 램프 안쪽 0.8 m 에 선 몸까지는 곧게 보이고 화물칸 한가운데는 외피 옆판이
 *     가린다. 외피 콜라이더는 이륙 스풀(1.6 s) 뒤에 걷히므로(`extraction/Hull`) 그 뒤로는 떠오르는 함선 속 몸까지 사선이 열린다.
 *   - **깨우기 둘** (사용자 결정 — 둘 다): ① 감지 반경 `FINAL_ANDROID_SENSE_M` 22 m 가 램프 · 화물칸을 담는다, ② 스위치를 누르면
 *     (= 튜토리얼 함선은 곧장 `extraction:liftoff`) `enemies/Tutorial.onTutorialLiftoff` 의 사격 창이 40 m 안의 인간형을 탑승자에게 붙인다.
 *   - `homeLeash` 22 m: 램프 발치(14.84 · 16.21)까지 쫓아 나갈 수 있고 함선 발자국 너머로는 못 간다.
 */
export const ENEMIES: readonly EnemySpot[] = [
  { type: 'tut_bug_loot', x: 2.5, y: DECK_UPPER_Y, z: 34, yaw: Math.PI },       // 가까운 쪽 · 오른쪽 — 무기 · 재료를 떨어뜨린다
  { type: 'tut_bug', x: -2.5, y: DECK_UPPER_Y, z: 28, yaw: Math.PI },           // 먼 쪽 · 왼쪽
  { type: 'tut_android', x: -7, y: DECK_UPPER_Y, z: -48, yaw: Math.PI },        // 왼쪽
  { type: 'tut_android_loot', x: 7, y: DECK_UPPER_Y, z: -54, yaw: Math.PI },    // 오른쪽 — 돌격소총 · 탄약
  // 철조망 건너편 (수류탄 하나에 둘) — **웅덩이 바닥**(`PIT`)에 서서 **함선**을 본다. 둘 다 확정 드롭: 산탄총 · 지정사수소총 (2026-09-15 3차)
  { type: 'tut_android_loot', x: FINAL_A1.x, y: PIT_FLOOR_Y, z: FINAL_A1.z, yaw: yawToShip(FINAL_A1.x, FINAL_A1.z), sense: FINAL_ANDROID_SENSE_M, weapon: 'sg' },
  { type: 'tut_android_loot', x: FINAL_A2.x, y: PIT_FLOOR_Y, z: FINAL_A2.z, yaw: yawToShip(FINAL_A2.x, FINAL_A2.z), sense: FINAL_ANDROID_SENSE_M, weapon: 'dmr' },
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
 * ③ (9, −117) 은 2026-09-15 사선 방벽이 들어선 뒤에도 **자리를 옮기지 않았다**: 방벽 좌표로 along 28.5 · depth **+4.41**
 * (가까운 쪽) — 오른쪽 끝 콘크리트 토막 앞 3.8 m 라 방벽 속도 건너편도 아니고, 벽을 따라 걷기 시작하는 길목이다.
 * 철조망 건너편 안드로이드 둘(1.85 · 3.65, −144.75)에서 28.66 · 28.26 m 라 그 둘의 감지 반경(`FINAL_ANDROID_SENSE_M` 22 m) 밖이다.
 * 2026-09-15 3차 — 웅덩이(`PIT`, x −2 … 7.5 · z −140.5 … −149)와는 **z 로 23.5 m**, 2026-09-16 철조망 계단 칸 [8.5, 9.5] 의 가장자리
 * (z −125.17)와는 **8.2 m** 떨어져 있어 그대로 평지다.
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
   *
   * 2026-09-15 1.65 → **1.825** (사용자 보고 「앉아서 지나가면 머리가 천장에 반쯤 박힌다」). 콜라이더는 1.3 을 요구하지만
   * **그려진 머리**는 더 높다 — 앉은 병사 모델(`player/SoldierModel`)의 머리 꼭대기를 쟀다:
   *   엉덩이 `hipsBaseY` 0.98 − 앉기 0.36 = 0.62 → 몸통 → 머리 피벗 0.58 (몸통 기울기 cos ≤ 1) = 1.20
   *   → 헬멧 구 0.17 + 0.145 × 1.08 = 0.327 (볏 윗면 0.32) = **1.53**, 앉아 걸을 때 흔들림 +0.023 = **1.55 m**.
   * 옛 입구 1.35 는 그보다 0.20 m 낮았다 (헬멧 0.33 m 의 절반 이상이 슬래브 속). 새 입구 1.70 은 **0.15 m 위**다.
   */
  clearance: 1.825,
  /**
   * 슬래브의 두께. 2026-09-14 4차 사용자 결정으로 1.2 → **2.4**(「천장을 위로 더 두껍게」) — 얇은 판 하나가
   * 떠 있으면 무너진 잔해가 아니라 선반처럼 보였다. **밑면은 그대로이고 위로만 두꺼워진다**: 그림도
   * (`Dressing` 이 중심을 `clearance + slabThickness / 2` 에 둔다) 콜라이더도(밑면을 base 로, 두께를 height 로
   * 넣는다) 밑면 기준이라 이 값을 키워도 통과 높이는 한 치도 안 바뀐다. 위쪽은 양옆 잔해 더미(높이 5.2)
   * 안이라 삐져나오지 않는다 (출구에서 1.95 + 2.4 = 4.35, 입구에서 1.70 + 2.4 = 4.10).
   */
  slabThickness: 2.4,
  /**
   * 2026-09-14 3차 — 슬래브를 **기울여** 무너져 내려앉은 잔해처럼 보이게 한다. 밑면의 기울기(dy/dz)다.
   * 4차 사용자 결정으로 **부호를 뒤집었다**: 들어가는 쪽(z0)이 낮고 나가는 쪽(z1)이 높다 — 앉아서 앞을
   * 겨눌 때(`crouchAim`) 카메라가 슬래브에 박히던 곳이 **출구**였고, 「점점 낮아지는 굴로 기어든다」보다
   * 「기어들어 갔다가 빠져나온다」가 이 구간의 뜻에 맞는다.
   * 2026-09-15: 출구(1.95)는 그대로 두고 **입구만 1.35 → 1.70** 으로 올렸다 (위 `clearance` 주석 — 앉은 머리 꼭대기 1.55 + 0.15).
   * 그래서 기울기가 −0.6/14 → `−0.25 / 14` 로 **완만해졌다** (0.017857… 을 손으로 반올림해 적으면 양 끝이 어긋난다).
   *
   * **검산** (깊이 14 m, 한가운데 `clearance` 1.825):
   *   가장 높은 곳 z1 = −28 → 1.825 + 7 × 0.017857 = **1.950 m** < `BOX_HEADROOM` 2.1 → 어디서도 못 선다 ✔
   *   가장 낮은 곳 z0 = −14 → 1.825 − 7 × 0.017857 = **1.700 m** > 앉은 머리 꼭대기 1.55 + 0.15 ✔ (`PLAYER_CROUCH_CLEARANCE_M` 1.3 ✔)
   *   앉은 눈높이 `EYE_CROUCH` 1.15 (정조준 +0.22 = 1.37) 도 입구 밑면에서 0.33 m 아래라 카메라가 박히지 않는다.
   *
   * 콜라이더는 `slabSegments` 장으로 쪼갠 축 정렬 상자이고 각 조각의 밑면은 그 조각 **한가운데**의 값이라
   * 그려진 밑면과 최대 `(14/7)/2 × 0.017857` = **0.018 m** 어긋난다.
   * 조각별 밑면 (z 중심 −15 · −17 · −19 · −21 · −23 · −25 · −27):
   *   **1.718 · 1.754 · 1.789 · 1.825 · 1.861 · 1.896 · 1.932** — 일곱 다 1.3 과 2.1 사이 ✔
   * 하나라도 1.3 밑으로 내려가면 앉아서도 못 지나가고, 2.1 위로 올라가면 서서 지나갈 수 있어 구간이 뜻을 잃는다.
   */
  slabSlope: -0.25 / 14,
  slabSegments: 7,
} as const;

/** 그 z 에서 슬래브 밑면의 높이 (데크 윗면 기준). */
export function crawlClearanceAt(z: number): number {
  return CRAWL.clearance + CRAWL.slabSlope * (z - (CRAWL.z0 + CRAWL.z1) / 2);
}

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

/**
 * 옛 아래 데크 사각형(x ±`CORRIDOR_MAX_HALF_X` · z `CLIFF2_EDGE_Z` … `ABYSS_EDGE_Z`)을 아래 조각(`DECKS` 중 윗면 < `DECK_UPPER_Y`) · `SHIP_SLOPE` ·
 * `PIT` · `PIT_WALLS` · `ABYSS_CUTS` 가 **정확히 한 번씩** 덮는지 표본으로 잰다 (2026-09-16 — 철조망 계단이 코드로 생기면서 손 검산을 대신한다).
 * 틀린 자리를 최대 8 개 돌려준다 (빈 배열 = 맞다). 표본 간격 0.25 m 는 가장 좁은 조각(칸 [8.1, 8.5] 0.4 m · 턱 · 벽 0.6 m)보다 좁고,
 * 어긋남 0.113 은 경계 값(0.5 · 0.1 단위 · 계단 가장자리)과 겹치지 않아 경계 위의 점을 두 번 세지 않는다. 생성 때 한 번 — 수 ms.
 */
export function lowerTilingErrors(): string[] {
  const rects: Array<{ id: string; r: Rect }> = [];
  for (const d of DECKS) if (d.top < DECK_UPPER_Y) rects.push({ id: d.id, r: d.rect });
  for (const w of PIT_WALLS) rects.push({ id: w.id, r: w.rect });
  rects.push({ id: 'pit', r: PIT }, { id: 'ship_slope', r: SHIP_SLOPE });
  ABYSS_CUTS.forEach((c, i) => rects.push({ id: `cut_${i}`, r: c }));
  const out: string[] = [];
  const STEP = 0.25, OFF = 0.113;
  for (let x = -CORRIDOR_MAX_HALF_X + OFF; x < CORRIDOR_MAX_HALF_X; x += STEP) {
    for (let z = CLIFF2_EDGE_Z - OFF; z > ABYSS_EDGE_Z; z -= STEP) {
      let n = 0, first = '';
      for (const { id, r } of rects) if (rectContains(r, x, z)) { if (n === 0) first = id; n++; }
      if (n === 1) continue;
      out.push(`(${x.toFixed(2)}, ${z.toFixed(2)}) ${n === 0 ? '빈틈 (바닥도 구멍도 아니다)' : `겹침 ×${n} (${first} …)`}`);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/** `rect` 을 밑면 `y0` · 윗면 `top` 의 상자 지오메트리로. */
export function rectBox(rect: Rect, y0: number, top: number): THREE.BufferGeometry {
  const w = rect.x1 - rect.x0, d = rect.z0 - rect.z1, h = top - y0;
  return box(w, h, d, (rect.x0 + rect.x1) / 2, y0 + h / 2, (rect.z0 + rect.z1) / 2);
}
