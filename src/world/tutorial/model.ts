import * as THREE from 'three';
import {
  PLAYER_HEIGHT, TUTORIAL_ENEMY_LEASH_M, TUTORIAL_ENEMY_SENSE_M,
  type TutorialCheckpointId, type TutorialFallRule,
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
 *   `upper_b` 의 끝(z = `CLIFF2_EDGE_Z` −77)에서 `lower` 로 = 절벽 2 (뛰어내린다),
 *   `lower` 의 끝(z = `ABYSS_EDGE_Z` −172) 너머 = 끝없는 절벽 (2026-09-15 — 떨어지면 `kill`).
 *
 * ⚠ `upper_a.z1`(85.8) · `upper_b.z0`(74.9) 는 **사선에서 가장 물러난 자리**다 — 축 정렬 사각형이라 사선을
 * 그대로 담을 수 없어서, 사선까지의 쐐기는 회전 OBB 가 덮고 이 둘은 그 안쪽에서 끝난다. 검산은
 * `CHASM_EDGE` 주석에.
 *
 * ⚠ 2026-09-15 2차 — `lower`(`PIT_DECK_ID`)에는 **안드로이드 웅덩이 구멍**이 뚫려 있다. 그림 · 윗면 판 · 콜라이더가
 * 전부 `subtractRect(rect, PIT)` 의 네 띠로 나뉘고 구멍 안은 `parts/Ground.buildPit` 가 채운다. 여기 사각형은
 * **구멍을 뺀 모양이 아니라 통째**이고, 빼는 일은 `Ground` 한 곳에서만 한다 (낙하 규칙 · 부스러기 · 클램프가 전부
 * 이 사각형을 「아래 데크의 범위」로 읽기 때문이다).
 */
export const DECKS: readonly DeckRect[] = [
  { id: 'upper_a', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: 118, z1: 85.8 }, top: DECK_UPPER_Y },
  { id: 'upper_b', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: 74.9, z1: CLIFF2_EDGE_Z }, top: DECK_UPPER_Y },
  { id: 'lower', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: CLIFF2_EDGE_Z, z1: ABYSS_EDGE_Z }, top: DECK_LOWER_Y },
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
 * 계산해 뒀고, 2026-09-15 재배치 뒤 가장 빡빡한 곳은 **14.73 m** (`ship` → 안드로이드) 다. 좌표를 고치면 그 표를 다시 계산한다.
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
  // 2026-09-15: 방벽 왼쪽 틈을 지나 **함선 램프 앞**. 띠(−148 … −156)는 안드로이드 둘(z −144.9 · −142.8)보다 뒤라
  // 그 둘에게 가려고 틈을 지난 사람이 체크포인트를 먼저 얻지 않는다. 램프 발치(−154.8)를 띠가 덮으므로 램프로 걸어가면 반드시 지난다.
  // ⚠ 2026-09-15 2차 — 웅덩이(`PIT`)의 앞 끝이 −147.0 이라 이 띠와 **1.0 m** 떨어져 있어야 한다. 이 체크포인트는
  //    `CHECKPOINT_STEP.ship = 'extract'` 라, 웅덩이에 뛰어든 것만으로 튜토리얼이 수류탄 단계를 건너뛰면 안 된다.
  cp('ship', -12.5, DECK_LOWER_Y, -151, -148, -156),
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
 *     올려 던질 필요가 없다 (옛 2.7 은 7.5° 이상 올려야 했고 그만큼 멀리 떨어졌다 — `BACKSTOP` 주석).
 *   - **두께** 1.2 m(`halfT` 0.6)는 수류탄 때문이다. 투척물은 걸음마다 위치를 옮긴 뒤 `resolveCollision` 이 **가까운 면**으로
 *     밀어내므로, 한 걸음에 방벽의 절반(0.6) + 몸(0.08) = 0.68 m 를 넘게 나아가면 반대편으로 밀려 나간다. 34 m/s 에서
 *     0.68 m = **50 fps** 이상이면 정면으로 던진 수류탄도 막힌다 (옛 무너진 벽 2.2 m 는 29 fps). 그림은 두께 1.1 m 에
 *     살 두 겹이라 콜라이더 면과 살이 5 cm 차이다.
 */
export const BARRIER = {
  near: { x: 17, z: -116 },
  far: { x: -8.5, z: -140 },
  halfT: 0.6,
  /**
   * **그려지는** 철조망의 높이. 2026-09-15 2차 사용자 결정으로 2.7 → **1.35**(절반) — 넘겨 던지기가 이 구간의 요점인데
   * 2.7 은 수평 투척(꼭대기 1.855)으로 못 넘었다. 막는 일은 `blockHeight` 가 대신한다.
   */
  fenceHeight: 1.35,
  /**
   * 사람 · 적을 막는 기둥의 **윗면** (철조망 밑동 기준). `fenceHeight` 위는 `passRays` + `passSmall` 유령이라 보이지도 않고
   * 총알 · 시야 · 수류탄도 지나가지만, 몸은 여기까지 밀려난다. 근거: 점프 1.20 + 올라설 수 있는 단 0.9 = **2.10 m** 위여야 한다.
   */
  blockHeight: 2.7,
  /**
   * 콘크리트 토막의 높이. 3.2 보다 낮아야 한다 — 이륙 연출 카메라(`extraction/Cinematic` 의 `CAM_OFFSET` y 3.2)가
   * 방벽 `far` 끝 3 m 옆(아래 `SHIP_POS` 검산)에서 시작하므로, 더 높으면 카메라가 콘크리트 속에서 출발한다.
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

/**
 * 마지막 안드로이드 둘이 서는 자리 (방벽 좌표). 철조망 **건너편** 10 m, 방벽을 따라 3.5 · 6.5 m — 둘 사이 3 m.
 *   A1 = (0.90, −144.88) · A2 = (3.09, −142.83)
 * 2026-09-15 2차: XZ 는 그대로이고 **발 높이만** `PIT_FLOOR_Y`(−10.9)로 내려갔다 — 둘은 웅덩이(`PIT`) 안에 선다.
 */
export const FINAL_ANDROIDS = { along: 5, depth: -10, spread: 1.5 } as const;

/**
 * **안드로이드가 등지고 선 콘크리트 방벽** (2026-09-15) — 철조망 너머로 던진 수류탄을 **멈추는 벽**이다.
 *
 * 왜 아직도 필요한가 (웅덩이 `PIT` 가 생긴 뒤에도): 웅덩이의 턱은 0.9 m 라 **굴러 나가는 것**만 막는다. 날아 들어오는
 * 수류탄은 턱보다 훨씬 높이 지나가므로, 멈춰 세우는 것은 여전히 이 벽이다. 벽에 부딪힌 수류탄은 그 면을 따라 밑동으로
 * 미끄러져 내려온다 (`resolveCollision` 은 위치만 밀고 속도는 두므로).
 *
 * 2026-09-15 2차 — **밑면이 데크가 아니라 웅덩이 바닥**(`PIT_FLOOR_Y`)이다. 그래서
 *   ① 웅덩이 안에서는 예전처럼 4.2 m 벽이고, ② 웅덩이 **밖**(양 끝이 턱을 뚫고 나간다)에서는 아래 0.9 m 가 데크에 묻혀
 *   3.3 m 벽으로 보인다 — 양 끝이 턱에 **박혀** 있어 수류탄이 벽 끝을 돌아 나갈 길이 없다.
 *   ③ 세계 높이로는 윗면이 −5.8 → **−6.7** 로 0.9 m 낮아졌다 (이륙 카메라 −6.8 과의 여유는 그만큼 늘었다).
 *
 * **검산** (방벽 좌표, 안드로이드 한가운데 depth −10, 수류탄 반경 `GRENADE_RADIUS` 7.2 · 피해 `GRENADE_DAMAGE` 250):
 *   - 면의 가까운 쪽 = depth −11.9 + 0.6 = **−11.3** → 안드로이드와 1.3 m, 수류탄이 멈추는 자리(−11.22)와 안드로이드는
 *     √(1.22² + 1.5²) = **1.93 m** — `EXPLOSION_FULL_FRACTION` 0.5 × 7.2 = 3.6 m 안이라 **250 피해 100 %** 다
 *     (> `tut_android` 체력 140). 2026-09-15 에 반경이 6 → 7.2 로 늘어 옛 계산의 170 이 250 이 됐다.
 *   - 철조망 앞 4 m 에서 **수평으로** 넘겨(올려 던질 필요가 없다 — `BARRIER` 검산) 한가운데를 겨누면, 손 높이 1.55 에서
 *     던진 수류탄이 15.3 m 앞 이 벽 면에 **웅덩이 바닥 위 1.60 m** 에서 부딪힌다 (같은 던지기가 바닥에 먼저 닿는
 *     거리는 21.1 m 라 벽이 먼저다). 철조망 위로는 1.80 m 로 지나 0.45 m 여유가 있다.
 *   - 그리고 **웅덩이 안이면 어디서 터져도 둘 다 죽는다** — `PIT` 주석의 표 (모서리 최대 A1 6.72 · A2 6.58 m < 7.2 →
 *     `EXPLOSION_OUTER_MUL` 0.6 × 250 = 150 > 140). 이 벽은 「확실히 둘 다」를 「거의 늘 100 %」로 만드는 장치다.
 *   - 방벽의 월드 가운데 (3.30, −145.24), 양끝 (0.02, −148.32) · (6.57, −142.15) — 오른쪽 벽(13.75)과 6.9 m 떨어져 있다.
 *     웅덩이 안에 남는 구간은 (1.43, −147.00) … (6.00, −142.69) = **6.28 m** 이고 나머지(양 끝 2.72 m)는 턱 속이다.
 *   - 안드로이드 → 함선 시야를 막지 않는다: 두 대와 램프 발치는 방벽 선의 같은 쪽이고(램프 발치 depth −10.39 > −11.9),
 *     화물칸 한가운데로 가는 선은 방벽 선을 방벽 끝에서 10 m 넘게 떨어진 자리에서 지난다.
 */
export const BACKSTOP = { along: 5, depth: -11.9, halfLen: 4.5, halfT: 0.6, height: 4.2 } as const;

/* ── 안드로이드 웅덩이 (마지막 구간) ─────────────────────────────────────── */

/**
 * **웅덩이의 깊이** (2026-09-15 2차, 사용자 결정 — 「안드로이드가 배치된 곳은 PC 몸체 절반 정도 아래로 꺼져 있고, 함선이
 * 있는 곳까지 오르막 언덕으로 이어진다. 수류탄이 다른 곳으로 빠지지 않도록 함선 방향 언덕 외에는 벽으로 둘러싼다」).
 * 몸 절반 = `PLAYER_HEIGHT / 2` 이므로 숫자를 적지 않고 거기서 뽑는다.
 *
 * ⚠ 이 값은 **정확히 `PROP_STEP_UP_MAX`(0.9)** 다 (부동소수로도 `−10.9 + 0.9 === −10`). 그래서 턱은
 *   - **사람 · 적에게는 벽이 아니다** — `resolveCollision` 의 「올라설 수 있는 단은 벽이 아니다」 가지(`top <= 발 + 0.9`)와
 *     `getSurfaceY` 의 천장(`발 + 0.9`)이 **둘 다 통과**하므로 어느 가장자리로든 걸어 올라온다. 두 판정이 같은 식이라
 *     어긋나지 않는다(경계에서 튕기지 않는다).
 *   - **투척물에게는 벽이다** — 같은 가지가 `!small` 로 막혀 있어 반지름 `SMALL_BODY_R`(0.25) 미만의 몸에는 예외가 없다.
 *     수류탄(`weapons/Grenade` 의 `BODY_R` 0.08)은 밀려난다 = **굴러 나가지 못한다.**
 * 사용자 결정의 요점이 「수류탄이 다른 곳으로 빠지지 않게」라 이것이 정확히 원하는 동작이다. 오르막(`PIT_RAMP_*`)은
 * 그래서 「유일한 출구」가 아니라 **함선 쪽으로 이어지는 언덕**이다 (결정문의 그 문장).
 */
export const PIT_DEPTH = PLAYER_HEIGHT / 2;
/** 웅덩이 바닥의 윗면. 아래 데크에서 `PIT_DEPTH` 만큼 아래. */
export const PIT_FLOOR_Y = DECK_LOWER_Y - PIT_DEPTH;
/** 웅덩이 구멍이 뚫리는 데크 (`DECKS` 의 id). */
export const PIT_DECK_ID = 'lower';

/**
 * **웅덩이의 평면** — 축 정렬 사각형이다.
 *
 * 왜 방벽 좌표(회전 사각형)가 아닌가: 데크는 축 정렬 타일(`tileRect`)이고, 구멍을 뚫는 유일한 안전한 방법이
 * **사각형 빼기 → 네 띠로 나눠 깔기**(`subtractRect`)다. 회전 사각형을 빼면 이음매마다 삼각 슬리버가 남아
 * 발밑이 사라진다. 그래서 자리는 방벽 좌표로 **정하고**(아래 depth 표) 모양만 축 정렬로 잡았다.
 *
 * **검산** (방벽 좌표 `barrierLocal`, 안드로이드 A1 (0.90,−144.88) · A2 (3.09,−142.83)):
 *   | 모서리 | along | depth | A1 까지 | A2 까지 |
 *   | (−2.0, −140.5) |  4.39 |  −4.82 | 5.26 | 5.59 |
 *   | ( 6.0, −140.5) | 10.22 | −10.30 | 6.72 | 3.73 |
 *   | (−2.0, −147.0) | −0.06 |  −9.55 | 3.59 | 6.58 |
 *   | ( 6.0, −147.0) |  5.76 | −15.04 | 5.52 | 5.09 |
 *   - **철조망과의 평지**: 가장 얕은 모서리가 depth −4.82 이고 철조망 콜라이더의 먼 면이 −0.6 이므로 **4.22 m** 의
 *     평지가 남는다. 턱에 바짝 붙지 않아야 철조망 앞에서 웅덩이 바닥이 보인다 — 철조망에 붙어 서면(눈 1.55) 턱 뒤로
 *     약 2.7 m 만 가려지고 안드로이드(10.6 m 앞)는 그 한참 밖이다.
 *   - **수류탄 한 발로 둘 다**: 네 모서리에서 두 대까지가 전부 `GRENADE_RADIUS` 7.2 m 안이다 (최대 A1 6.72 · A2 6.58).
 *     3.6 m 밖이어도 `EXPLOSION_OUTER_MUL` 0.6 × 250 = **150** > 체력 140 이므로, **웅덩이 안 어디에서 터져도 둘 다 죽는다.**
 *   - **`ship` 체크포인트 띠(z −148 … −156)를 건드리지 않는다**: 웅덩이 앞 끝이 −147.0 이라 **1.0 m** 여유다. 이 띠는
 *     `CHECKPOINT_STEP.ship = 'extract'` 라 웅덩이에 뛰어들었다고 튜토리얼이 수류탄 단계를 건너뛰면 안 된다.
 *   - **함선 발자국**(x −13.13 … −2.76 · z −167.80 … −154.50)과 겹치지 않는다 — x 로 0.76 m · z 로 7.5 m 떨어져 있다.
 *     이륙은 기수 쪽(오른쪽 앞 · z 가 더 작아지는 쪽)이라 더 멀어진다.
 *   - **이륙 연출 카메라 첫 자리**(−4.07, −6.8, −139.96)는 웅덩이 밖이고(x 로 2.07 · z 로 0.54), 애초에 데크보다 3.2 m
 *     **위**라 파인 자리와는 겹칠 수가 없다.
 *   - **시체 ③**(9, −117)은 그대로 평지다 (x 로 3.0 · z 로 23.5 m 밖).
 *   - **`BACKSTOP`** 은 양 끝이 턱을 뚫고 나가 박힌다 (위 주석).
 */
export const PIT: Rect = { x0: -2, x1: 6, z0: -140.5, z1: -147 };

/**
 * 함선 쪽(−X) 면을 채우는 **오르막**의 수평 길이. 나머지 세 면은 턱(수직)이다.
 * 경사 atan(0.9 / 2.5) = **19.8°** — `PlayerController` 의 `STEEP_COS`(50°) 안이고, 애초에 경사 콜라이더(`Obstacle.ramp`)라
 * 지형 경사 판정을 타지도 않는다 (`CLAUDE.md` 「지형 경사 판정은 발이 지형 위일 때만」).
 *
 * 왜 −X 면인가: 플레이어는 방벽 왼쪽 틈(≈ x −12.2, z −140)을 돌아 함선(−8.5, −158)으로 걸어간다 — 웅덩이의 −X 면이
 * 그 길을 마주 보는 면이다. 여기에 언덕을 두면 결정문의 「함선이 있는 곳까지 오르막으로 이어진다」가 그대로 되고,
 * 쫓아 나오는 안드로이드도 플레이어 쪽으로 올라온다.
 */
export const PIT_RAMP_RUN = 2.5;
/** 오르막이 끝나고 평평한 바닥이 시작하는 x. A1(x 0.90)은 여기서 **0.40 m** 안쪽이라 평지에 선다. */
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
 * `outer` 에서 `hole` 을 뺀 사각형 조각들 (뒤 띠 · 앞 띠 · 왼쪽 · 오른쪽, 최대 넷). `hole` 은 `outer` 안에 온전히
 * 들어 있다고 본다.
 *
 * ⚠ 좌우 띠는 z 를 `TILE_OVERLAP` 만큼 늘려 앞뒤 띠와 **겹친다.** 네 조각이 정확히 같은 선에서 맞닿으면 그 선 위의
 * 점이 반올림 때문에 양쪽 모두에서 밖으로 읽혀 `getSurfaceY` 가 지형(−100)을 돌려준다 — `tileRect` 가 안쪽 경계를
 * 겹치는 것과 **같은 이유**다. 좌우 띠는 x 로 이미 구멍 밖이라 z 를 늘려도 구멍을 덮지 않는다.
 */
export function subtractRect(outer: Rect, hole: Rect): Rect[] {
  const out: Rect[] = [];
  const o = TILE_OVERLAP;
  if (outer.z0 > hole.z0) out.push({ x0: outer.x0, x1: outer.x1, z0: outer.z0, z1: hole.z0 });
  if (hole.z1 > outer.z1) out.push({ x0: outer.x0, x1: outer.x1, z0: hole.z1, z1: outer.z1 });
  const z0 = Math.min(outer.z0, hole.z0 + o), z1 = Math.max(outer.z1, hole.z1 - o);
  if (hole.x0 > outer.x0) out.push({ x0: outer.x0, x1: hole.x0, z0, z1 });
  if (outer.x1 > hole.x1) out.push({ x0: hole.x1, x1: outer.x1, z0, z1 });
  return out;
}

/* ── 적 ──────────────────────────────────────────────────────────────────── */

export interface EnemySpot { readonly type: string; readonly x: number; readonly y: number; readonly z: number; readonly yaw: number }

const FINAL_A1 = barrierPoint(FINAL_ANDROIDS.along - FINAL_ANDROIDS.spread, FINAL_ANDROIDS.depth);
const FINAL_A2 = barrierPoint(FINAL_ANDROIDS.along + FINAL_ANDROIDS.spread, FINAL_ANDROIDS.depth);
/** 마지막 안드로이드가 바라보는 yaw — 철조망(가까운 쪽 법선) 쪽. 적 yaw 의 정면은 `(−sin, −cos)` (yaw π = +Z). */
const FINAL_ANDROID_YAW = Math.atan2(-BARRIER_NORMAL.x, -BARRIER_NORMAL.z);

/**
 * 여섯 마리. 굴림도 웨이브도 순찰도 없다 (`enemies/` 가 `world:ready` 에서 한 번 읽어 그대로 세운다).
 * 앞의 넷은 yaw = π 라 다가오는 플레이어(+Z 쪽)를 보고, 마지막 둘은 철조망 쪽(`FINAL_ANDROID_YAW` = 2.386)을 본다.
 *
 * **종류** (2026-09-14 3차 — 튜토리얼 전용 타입, `data/enemies.csv` · `enemies/EnemyTypes.TUTORIAL_ENEMY_BASE`):
 * `*_loot` 만 확정 드롭이 있고 나머지는 아무것도 떨어뜨리지 않는다. **+x 가 걸어가는 플레이어의 오른쪽**이다
 * (좌표 규약 절의 forward × up 계산).
 *   벌레            — **가까운 쪽(z 34) = 오른쪽(x +2.5) `tut_bug_loot`** · 먼 쪽(z 28) = 왼쪽(x −2.5) `tut_bug`
 *                     (2026-09-15 사용자 결정 — 좌우를 바꿨다. 드롭은 여전히 가까운 쪽이다)
 *   앉아쏴 안드로이드 — 오른쪽(x +7) `tut_android_loot` · 왼쪽(x −7) `tut_android`
 *   철조망 건너편    — 둘 다 `tut_android` (`FINAL_ANDROIDS` — A1 (0.90, −144.88) · A2 (3.09, −142.83))
 *
 * **체크포인트까지의 거리** (감지 12 m 를 넘는지의 근거 — 좌표를 고치면 다시 계산한다):
 *   `bugs`(0,60)          → (2.5,34) 26.12 · (−2.5,28) 32.10
 *   `crawl`(0,−10)        → (2.5,34) 44.07 · (−2.5,28) 38.08
 *   `android`(0,−32)      → (−7,−48) 17.46 · (7,−54) 23.09
 *   `drop`(0,−71)         → (−7,−48) 24.04 · (7,−54) 18.38
 *   `wall`(0,−108)        → A1 36.89 · A2 34.96
 *   `ship`(−12.5,−151)    → A1 **14.73** · A2 17.60
 * 가장 빡빡한 곳이 14.73 m 다. (2026-09-15 2차 — 마지막 둘이 웅덩이로 0.9 m 내려갔지만 XZ 는 그대로이고,
 *  세로를 함께 세도 `ship` → A1 이 **14.76** m 라 표는 사실상 그대로다.)
 *
 * **자기 구간의 벽 안인가** (반폭은 `corridorHalfXAt`):
 *   벌레 둘   (z 34 · 28) 반폭 `CORRIDOR_BUG_HALF_X` 4.6 → `|x|` 2.5 + `radius` 0.45 = 2.95, **여유 1.65 m**.
 *             벽의 안쪽 면은 `Ground` 의 bite 만큼 더 파고들지만 그 몫도 폭에 비례해 줄어(4 × 0.55 × 4.6/15.4
 *             = 0.66) 최소 3.94 이므로 **여유 0.99 m** 는 남는다. 좌우를 바꿔도 `|x|` 가 같아 그대로다.
 *   안드로이드 넷 (z −48 · −54 · −144.9 · −142.8) 반폭 15.4 → `|x| ≤ 7`, 여유 8.4 m 이상.
 *
 * **철조망 건너편 둘** (2026-09-15 — 「철조망 사이로 보이고, 넘겨 던진 수류탄 하나에 둘」):
 *   - 둘 다 철조망 **건너편 10 m** 이고 방벽을 따라 3.5 · 6.5 m 라 가까운 쪽 어디서 봐도 그 앞은 철조망 토막(3.5 … 27.0 m)이다
 *     (콘크리트 토막 뒤에 숨지 않는다).
 *   - 수류탄은 `BACKSTOP` · `PIT` 주석: 철조망을 수평으로 넘겨 던지면 방벽 면에 부딪혀 두 대에게서 1.93 m 에 멈추고(250 피해),
 *     그 밖에도 **웅덩이 안이면 어디서 터져도** 둘 다 7.2 m 안이라 150 피해 > 체력 140 이다.
 *   - **함선이 보인다** (스위치를 누른 뒤 이륙하는 함선 속 플레이어를 쏜다): 두 대와 함선 사이에 방벽 선이 없다 — 방벽 `far`
 *     끝이 (−8.5, −140) 이고 함선 · 두 대는 모두 그 선의 건너편이다. 화물칸 입구가 보이는 범위(함선 로컬 좌표, 입구 폭 ±1.6 이
 *     로컬 z 0.6 에 있다): A1 로컬 (11.54, 11.29), A2 (14.05, 12.93) — 램프 안쪽 0.8 m 에 선 몸까지는 곧게 보이고
 *     (허용 |x| 13.8 · 15.7), 화물칸 한가운데(로컬 z −2.5)는 외피 옆판이 가린다(허용 7.1 · 8.0). 외피 콜라이더는 이륙
 *     스풀(1.6 s) 뒤에 걷히므로(`extraction/Hull`) 그 뒤로는 떠오르는 함선 속 몸까지 사선이 열린다.
 *     2026-09-15 2차 — **웅덩이 턱이 그 사선을 막지 않는다**: 눈이 웅덩이 바닥 + 1.44 라 턱 윗면(데크)보다 0.54 m 위이고,
 *     함선 쪽으로 나가는 사선이 앞 턱(z −147.0)을 지나는 자리(A1 은 2.61 m · A2 는 5.25 m 앞, 둘 다 x ≈ −0.1 … −0.6 이라
 *     턱 폭 안이다)에서 이미 데크보다 각각 **0.64 · 0.71 m** 위다.
 */
export const ENEMIES: readonly EnemySpot[] = [
  { type: 'tut_bug_loot', x: 2.5, y: DECK_UPPER_Y, z: 34, yaw: Math.PI },       // 가까운 쪽 · 오른쪽 — 무기 · 재료를 떨어뜨린다
  { type: 'tut_bug', x: -2.5, y: DECK_UPPER_Y, z: 28, yaw: Math.PI },           // 먼 쪽 · 왼쪽
  { type: 'tut_android', x: -7, y: DECK_UPPER_Y, z: -48, yaw: Math.PI },        // 왼쪽
  { type: 'tut_android_loot', x: 7, y: DECK_UPPER_Y, z: -54, yaw: Math.PI },    // 오른쪽 — 돌격소총 · 탄약
  // 철조망 건너편 (수류탄 하나에 둘) — 2026-09-15 2차부터 **웅덩이 바닥**에 선다 (`PIT`)
  { type: 'tut_android', x: FINAL_A1.x, y: PIT_FLOOR_Y, z: FINAL_A1.z, yaw: FINAL_ANDROID_YAW },
  { type: 'tut_android', x: FINAL_A2.x, y: PIT_FLOOR_Y, z: FINAL_A2.z, yaw: FINAL_ANDROID_YAW },
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
 * 철조망 건너편 안드로이드 둘에서 29.05 · 26.47 m 라 감지 반경(12 m) 밖이다.
 * 2026-09-15 2차 — 웅덩이(`PIT`, x −2 … 6 · z −140.5 … −147)와도 **x 로 3.0 m · z 로 23.5 m** 떨어져 있어 그대로 평지다.
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
 *
 * 2026-09-15 (사용자 결정 — 「함선은 왼쪽, 살짝 비스듬히, 램프가 다가오는 쪽을 보게」): **왼쪽**(x −8.5)에 **yaw −10°** 로 세운다.
 * 램프가 왼쪽 뒤(−0.174, 0.985)를 보므로 방벽 왼쪽 틈에서 곧장 걸어 들어온다. 이륙은 기수 쪽 (0.174, −0.985) = 오른쪽 앞으로
 * 날아가 **벽에서 멀어진다**.
 *
 * **검산** (월드, `extraction/Hull` 외피 + 램프 + 나셀 · 날개 · 꼬리를 0.25 m 간격으로 옮겨 쟀다):
 *   - 발자국 x −13.13 … −2.76 · z −167.80 … −154.50 → 왼쪽 벽(−15.4, `WALL_PLAIN_FROM_Z`)까지 **2.27 m**, 끝없는 절벽
 *     가장자리(−172)까지 **4.20 m**, 방벽까지 **14.05 m**.
 *   - 램프 발치(로컬 0, 3.25) = (−9.06, −154.80). 틈 한가운데 (−12.20, −140) 에서 거기로 걷는 방향이 램프 축과 **2.0°** 어긋난다.
 *   - 이륙 궤적(스풀 1.6 s + 상승 `6a² + 2a` · 전진 `12(a − 0.8)²` · 기수 들기 0.35 rad)을 0.02 s 간격으로 따라가며 모든 표본점을
 *     옆 절벽 벽 조각(안쪽 면 · 윗면)과 비교했다 — **닿는 곳이 없다** (벽 윗면을 넘기 전의 전진은 오른쪽 앞으로 18.5 m 뿐이다).
 *   - 이륙 연출 카메라의 첫 자리(로컬 7.5, 3.2, 17) = (−4.07, **−6.8**, −139.96): 방벽 건너편 3.0 m · `far` 끝에서 3.3 m 라
 *     콘크리트 토막(윗면 −7.0) 위이고, 오른쪽으로 떨어진 `BACKSTOP`(방벽 좌표로 depth −11.9 = **8.9 m 옆**) 과도 겹치지 않는다.
 *     2026-09-15 2차 — 웅덩이(`PIT`)와도 x 로 2.07 · z 로 0.54 m 밖이고, 애초에 데크보다 3.2 m **위**라 파인 자리와 겹칠 수 없다.
 */
export const SHIP_POS = new THREE.Vector3(-8.5, DECK_LOWER_Y, -158);
export const SHIP_YAW = (-10 * Math.PI) / 180;

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

/** `rect` 을 밑면 `y0` · 윗면 `top` 의 상자 지오메트리로. */
export function rectBox(rect: Rect, y0: number, top: number): THREE.BufferGeometry {
  const w = rect.x1 - rect.x0, d = rect.z0 - rect.z1, h = top - y0;
  return box(w, h, d, (rect.x0 + rect.x1) / 2, y0 + h / 2, (rect.z0 + rect.z1) / 2);
}
