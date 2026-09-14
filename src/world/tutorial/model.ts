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
 * x 는 좌우이고 통로는 `±CORRIDOR_HALF_X`, 그 바깥은 통째로 절벽 벽이라 플레이어가 통로를 벗어날 길이 없다.
 *
 * ## 왜 지형(높이장)이 아니라 「데크 상자」인가
 * 절벽 둘이 이 맵의 핵심인데, 높이장은 **수직면을 만들 수 없다**. 1 m 격자에 10 m 를 떨어뜨리면 84° 경사가 되고,
 * 84° 는 `PlayerController` 의 `STEEP_COS`(50°) 를 넘어 **미끄러져 내려간다** — 낙하 피해가 0 이고(계속 접지다)
 * 「달려서 건넌다 · 뛰어내린다」가 둘 다 사라진다. 그래서 바닥(`VOID_Y`)은 평평한 판 하나로 두고, 걸어 다니는
 * 데크를 **사각 콜라이더**(`SpatialHash.addBox`)로 세운다: 옆면은 완전한 벽이고 가장자리를 넘으면 그대로 떨어진다.
 * 구조물의 바닥판 · 전차 데크가 이미 그렇게 살고 있어서 `getSurfaceY` · `resolveCollision` 은 한 줄도 안 바뀐다.
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

/** 걸어 다니는 데크의 반폭. */
export const CORRIDOR_HALF_X = 22;
/** 통로 양옆 절벽 벽의 안쪽 면 = `CORRIDOR_HALF_X`, 두께 `WALL_T`. */
export const WALL_T = 3;
/** 절벽 벽의 윗면 (위 데크에서 18 m). 하늘은 열려 있고 옆으로는 나갈 수 없다. */
export const WALL_TOP_Y = 18;
/** 맵의 z 양끝 (막다른 벽 바깥). */
export const Z_START = 121;
export const Z_END = -129;
/** 지도 · 핑이 쓰는 한 변 (`WorldRef.size`). 통로 전체가 들어간다. */
export const TUTORIAL_MAP_SIZE = 280;
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
 * 걸어 다니는 땅. 셋뿐이고 그 사이의 **빈 곳이 곧 절벽**이다:
 *   `upper_a` ↔ `upper_b` 사이의 `CHASM` = 절벽 1 (달려서 점프해야 넘는다),
 *   `upper_b` 의 끝(z = −46)에서 `lower` 로 = 절벽 2 (뛰어내린다).
 */
export const DECKS: readonly DeckRect[] = [
  { id: 'upper_a', rect: { x0: -CORRIDOR_HALF_X, x1: CORRIDOR_HALF_X, z0: 118, z1: 82 }, top: DECK_UPPER_Y },
  { id: 'upper_b', rect: { x0: -CORRIDOR_HALF_X, x1: CORRIDOR_HALF_X, z0: 78.4, z1: -46 }, top: DECK_UPPER_Y },
  { id: 'lower', rect: { x0: -CORRIDOR_HALF_X, x1: CORRIDOR_HALF_X, z0: -46, z1: -126 }, top: DECK_LOWER_Y },
];

/**
 * 절벽 1 의 틈 — **3.6 m**. 걸으며 뛰면(4.2 m/s × 0.633 s = 2.66 m) 못 넘고, 달리며 뛰면
 * (7.2 m/s × 0.633 s = 4.56 m) 넘는다. 점프 체공은 `2 × JUMP_SPEED / GRAVITY` = 2 × 7.6 / 24.
 */
export const CHASM: Rect = { x0: -CORRIDOR_HALF_X, x1: CORRIDOR_HALF_X, z0: 82, z1: 78.4 };

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
const W = CORRIDOR_HALF_X + 1;

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
 * 계산해 뒀고, 가장 빡빡한 곳도 14 m 다. 좌표를 고치면 그 표를 다시 계산한다.
 */
export const CHECKPOINTS: readonly CheckpointSpec[] = [
  cp('wake', 0, DECK_UPPER_Y, 112, 118, 104),      // 폐허 한가운데 — 여기서 깨어난다
  cp('cliff', 0, DECK_UPPER_Y, 94, 100, 88),       // 절벽 1 앞. 82 까지 12 m 의 도움닫기
  cp('corpse', 0, DECK_UPPER_Y, 74, 78, 68),       // 절벽을 넘은 자리. 시체 ① 이 눈앞
  cp('bugs', 0, DECK_UPPER_Y, 60, 64, 54),         // 벌레 두 마리 앞
  cp('crawl', 0, DECK_UPPER_Y, 27, 31, 22),        // 무너진 통로 앞
  cp('android', 0, DECK_UPPER_Y, 4, 8, 0),         // 통로를 나온 자리. 안드로이드 2체
  cp('drop', 0, DECK_UPPER_Y, -38, -34, -42),      // 절벽 2 위
  cp('supply', 0, DECK_LOWER_Y, -56, -52, -60),    // 떨어진 자리. 시체 ② 가 앞에
  cp('wall', 0, DECK_LOWER_Y, -72, -68, -76),      // 무너진 벽 앞
  cp('ship', 0, DECK_LOWER_Y, -107, -103, -111),   // 버려진 함선 램프 앞
];

/* ── 낙하 규칙 ───────────────────────────────────────────────────────────── */

export interface FallRuleVolume extends Volume { readonly rule: TutorialFallRule }

/**
 * 떨어진 **자리**(착지 지점)가 정하는 규칙. 볼륨 밖은 전역 낙하 피해 그대로(`normal`).
 * 목록 순서대로 처음 맞는 것이 이긴다.
 */
export const FALL_RULES: readonly FallRuleVolume[] = [
  // 절벽 1 바닥 — 넘지 못했다는 뜻이라 즉사시키고 체크포인트로 돌려보낸다
  { rule: 'kill', x0: -W - WALL_T, x1: W + WALL_T, z0: 83.5, z1: 77, y0: VOID_Y - 6, y1: DECK_UPPER_Y - 3 },
  // 절벽 2 착지 구역 — 반드시 살아남아야 하는 낙하. 피해는 들어가되 체력 1 밑으로 내려가지 않는다
  { rule: 'clamp', x0: -W, x1: W, z0: -46, z1: -66, y0: DECK_LOWER_Y - 4, y1: DECK_LOWER_Y + 4 },
];

/* ── 적 ──────────────────────────────────────────────────────────────────── */

export interface EnemySpot { readonly type: string; readonly x: number; readonly y: number; readonly z: number; readonly yaw: number }

/**
 * 여섯 마리. 굴림도 웨이브도 순찰도 없다 (`enemies/` 가 `world:ready` 에서 한 번 읽어 그대로 세운다).
 * yaw = π 라 전부 다가오는 플레이어(+Z 쪽)를 보고 있다.
 *
 * **체크포인트까지의 거리** (감지 12 m 를 넘는지의 근거 — 좌표를 고치면 다시 계산한다):
 *   `bugs`(0,60)    → (−5,46) 14.9 · (6,40) 20.9
 *   `crawl`(0,27)   → (−5,46) 19.6 · (6,40) 14.3
 *   `android`(0,4)  → (−7,−12) 17.5 · (7,−18) 23.1
 *   `drop`(0,−38)   → (−7,−12) 26.9 · (7,−18) 21.2
 *   `wall`(0,−72)   → (−6,−88) 17.1 · (6,−94) 22.8
 *   `ship`(0,−107)  → (−6,−88) 20.0 · (6,−94) 14.3
 * 가장 빡빡한 곳이 14.3 m 다.
 */
export const ENEMIES: readonly EnemySpot[] = [
  { type: 'scavenger', x: -5, y: DECK_UPPER_Y, z: 46, yaw: Math.PI },
  { type: 'scavenger', x: 6, y: DECK_UPPER_Y, z: 40, yaw: Math.PI },
  { type: 'android', x: -7, y: DECK_UPPER_Y, z: -12, yaw: Math.PI },
  { type: 'android', x: 7, y: DECK_UPPER_Y, z: -18, yaw: Math.PI },
  { type: 'android', x: -6, y: DECK_LOWER_Y, z: -88, yaw: Math.PI },
  { type: 'android', x: 6, y: DECK_LOWER_Y, z: -94, yaw: Math.PI },
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

export const CORPSES: readonly CorpseSpec[] = [
  {
    id: 'corpse:tut_gear', name: '분대원의 시체', x: 2, y: DECK_UPPER_Y, z: 66, yaw: 2.3,
    items: [{ id: 'wpn_smg', qty: 1 }, { id: 'bag_common', qty: 1 }, { id: 'ammo_light', qty: 'stack' }],
  },
  {
    id: 'corpse:tut_supply', name: '위생병의 시체', x: -3, y: DECK_LOWER_Y, z: -64, yaw: -1.1,
    items: [{ id: 'heal_bandage', qty: 2 }, { id: 'grenade_frag', qty: 2 }],
  },
  {
    id: 'corpse:tut_relic', name: '약탈자의 시체', x: 5, y: DECK_LOWER_Y, z: -82, yaw: 0.6,
    items: [{ id: 'gem_amber', qty: 1 }, { id: 'cred_chip', qty: 2 }],
  },
];

/* ── 버려진 함선 (= 진짜 탈출선을 착륙 상태로 세운다) ────────────────────── */

/**
 * `ctx.extraction.beginPreLanded(position, yaw)` 에 넘길 자리. 함선 원점은 데크 위에 있고 (`Ship.floorYAt` 규약),
 * **뒷 램프는 `(sin yaw, cos yaw)` 쪽으로 열린다** — yaw 0 이면 +Z, 즉 다가오는 플레이어 정면이다.
 * z 는 외피(`extraction/Hull`)의 기수 끝이 로컬 −9.7 m 라 −113 이다: 월드 −122.7 로 아래 데크 끝(−126)과
 * 막다른 벽 안쪽에 들어간다. 화물칸은 월드 −118.2 … −113.8, 램프는 그 뒤로 열린다.
 */
export const SHIP_POS = new THREE.Vector3(0, DECK_LOWER_Y, -113);
export const SHIP_YAW = 0;

/* ── 손으로 지은 구조물의 치수 ───────────────────────────────────────────── */

/** 무너진 통로 (포복 구간): 통로가 좁아지고 머리 위로 슬래브가 지난다. */
export const CRAWL = {
  z0: 22, z1: 8,
  /** 지나갈 수 있는 폭의 절반. */
  gapHalfX: 3,
  /**
   * 머리 위 슬래브의 **밑면** (데크 윗면 기준). **선 몸(`BOX_HEADROOM` 2.1)은 막고 앉은 몸
   * (`PLAYER_CROUCH_CLEARANCE_M` 1.3)은 지나는** 사이 값이다 — 2026-09-14 에 `PlayerController` 가 자세 높이를
   * `resolveCollision` 에 넘기게 되면서 「앉아서만 지나갈 수 있다」가 진짜가 됐다. 그 밑에서는 일어설 수도 없다
   * (`player/parts/Locomotion.canStandHere`). 두 상수 **사이**를 벗어나면 구간이 뜻을 잃으므로 함께 본다.
   */
  clearance: 1.6,
  slabThickness: 1.2,
} as const;

/** 무너진 벽 — 통로를 가로막고 가운데만 뚫려 있다. */
export const BROKEN_WALL = { z: -78, thickness: 2.2, height: 4.6, gapHalfX: 2.5 } as const;

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
