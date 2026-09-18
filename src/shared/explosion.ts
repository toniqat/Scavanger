import * as THREE from 'three';
import {
  BLAST_LOS_CHEST_FRAC, BLAST_LOS_FEET_M, BLAST_LOS_HEAD_FRAC, BLAST_LOS_LIFT_M, BLAST_LOS_SLACK_M,
  EXPLOSION_FULL_FRACTION, EXPLOSION_OUTER_MUL, MELEE_LOS_SLACK_M,
} from './constants';
import type { WorldRef } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * 폭발 감쇠 (2026-09-15, 사용자 결정)
 *
 * **왜 이 파일이 있는가.** 폭발 피해의 거리 감쇠가 `damage * (1 - d / radius)` 라는 똑같은
 * 한 줄로 **일곱 폴더에 베껴져** 있었다 — weapons(수류탄 · 바주카) · enemies(적 피해 ·
 * 적 수류탄 · 탐사 차량) · gadgets(지뢰 · C4 · 드론) · stratagems(함선 호출 낙하물 · 구조물).
 * 한 곳만 고치면 같은 폭발이 적과 플레이어에게, 호스트와 리플리카에게 다르게 아프다.
 * 「같은 수식을 두 폴더가 쓰면 `shared` 로 뽑는다」(`ballistics.ts` 가 선례) 그대로다.
 *
 * **무엇이 바뀌었나.** 선형이 아니라 **2단 계단**이다:
 *
 *   ┌ 0 … 0.5 × radius ─ 피해 100 %
 *   ├ 0.5 × radius … radius ─ 피해 50 % (**거리와 무관한 고정값**, 2026-09-17 사용자 결정 60 → 50 %)
 *   └ radius 밖 ─ 0
 *
 * 두 수치는 `data/constants.csv` 의 `EXPLOSION_FULL_FRACTION` · `EXPLOSION_OUTER_MUL` 이다.
 * 선형이던 시절에는 반경을 넓혀도 한가운데 말고는 거의 안 아팠다 — 반경 7.2 m 수류탄의
 * 6 m 지점이 옛 식으로는 중심 피해의 16.7 % 였다. 이제 계단이라 「맞았는가」가 먼저 서고
 * 반경을 넓히는 것이 실제로 넓히는 일이 된다.
 *
 * 검산 (`GRENADE_RADIUS` 7.2 · `GRENADE_DAMAGE` 60 · `EXPLOSION_OUTER_MUL` 0.5 — 2026-09-17 값):
 *   - d = 3.5 m → 3.5 ≤ 3.6 → ×1   → 60
 *   - d = 3.7 m → 3.6 < 3.7 < 7.2 → ×0.5 → 30
 *   - d = 7.0 m → 여전히 ×0.5 → 30
 *   - d = 7.2 m → 반경 밖 → 0
 *
 * ⚠ 자리마다 다른 **하한 클램프**(엄폐물 0.3 · 적 0.15 · 탐사 차량 0.15 · 적 수류탄 0.1)는
 * 없애지 않았다 — `Math.max(하한, explosionFalloff(...))` 로 이 배수 **위에** 얹는다.
 * ⚠ 폭발이 아닌 감쇠(카메라 흔들림 · 소리 거리 곡선 · 땅굴벌레 분출의 자기 규칙 · 독성 분출 ·
 * 곡사포탄의 `×0.75` 처럼 **스스로 다른 곡선을 적어 둔 것**)는 이 함수를 쓰지 않는다.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 중심에서 `dist` 만큼 떨어진 곳이 받는 피해 배수 (0 … 1). 반경 밖 · `radius <= 0` 은 0.
 *
 * `dist` 는 호출자가 재는 거리다 — 몸 반지름을 뺀 **표면까지의 거리**를 넘기는 자리가 많다
 * (적 · 플레이어 · 드론 · 엄폐물). 음수는 0 으로 접는다.
 */
export function explosionFalloff(dist: number, radius: number): number {
  if (!(radius > 0)) return 0;
  const d = dist > 0 ? dist : 0;
  if (d >= radius) return 0;
  return d <= radius * EXPLOSION_FULL_FRACTION ? 1 : EXPLOSION_OUTER_MUL;
}

/** 그 자리에서 실제로 받는 피해 (`damage × explosionFalloff`). 반경 밖은 0. */
export function explosionDamage(damage: number, dist: number, radius: number): number {
  return damage * explosionFalloff(dist, radius);
}

/**
 * 툴팁에 적는 피해 범위 — 바깥 띠(`min`) … 중심(`max`). 2026-09-17 (사용자 결정): 2단 계단 폭발물은
 * 피해를 「30-60」 처럼 **범위**로 적는다. `min` 은 `floor(중심 × EXPLOSION_OUTER_MUL)` — 실제 피해는 내림하지
 * 않지만 카드에 소수를 적지 않으려는 표시용 내림이다. 계단 배수를 이 파일 밖에서 다시 곱하지 않게 여기 둔다.
 */
export function explosionDamageRange(damage: number): { readonly min: number; readonly max: number } {
  return { min: Math.floor(damage * EXPLOSION_OUTER_MUL), max: damage };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 폭발 · 근접 차폐 (2026-09-18, 사용자 결정 「폭발 · 근접 공격이 벽 · 지붕 · 바닥을 뚫지 않는다」)
 *
 * 예전에는 거리만 쟀다 — 벽 너머 방, 지붕 위 포탄 아래 사람, 위층 바닥 너머 벌레가 똑같이 맞았다.
 * 판정은 `WorldRef.raycastBlast` 하나다 (지형 · 구조물 바닥판 · 지붕 · 벽 · 계단 · 소품 · **창유리**).
 *
 * **왜 `raycast` 가 아니라 `raycastBlast` 인가** (2026-09-18 사용자 결정 「창은 깨졌어도 폭발을 막고, 낮은
 * 엄폐물은 기존대로」): 깨진 창틀은 콜라이더를 남기지만 `Obstacle.passRays` 가 되어 `raycast` 를 통과시킨다.
 * 그래서 방 한가운데에 서 있어도 그 방에 창이 하나 있으면 밖의 곡사포 폭발이 창을 지나 몸을 보고 피해를 줬다.
 * `raycastBlast` 는 **유리만** 깨졌든 말든 막는다 — 총알 · 적 시야 · 투척물의 통과는 그대로다.
 * 「낮은 엄폐물은 기존대로」는 저절로 지켜진다: 엄폐물은 `passRays` 가 아니라 두 레이 모두에서 똑같이 막고,
 * 엄폐물 위로 머리만 내민 사람은 아래의 **몸 3점** 규칙이 살려 준다.
 *
 * **몸 3점** (사용자 결정): 발목(`BLAST_LOS_FEET_M`) · 가슴(`× BLAST_LOS_CHEST_FRAC`) · 머리(`× BLAST_LOS_HEAD_FRAC`).
 * 하나라도 폭심이 보이면 원래 피해 그대로, 셋 다 막히면 0 — 낮은 창턱 너머로 머리만 내민 사람은 맞는다.
 *
 * **레이 방향은 몸 → 폭심이다.** 포탄은 맞은 면 위(`hit.point`)에서 터지므로 폭심이 벽 안쪽으로 부동소수만큼 들어가
 * 있을 수 있고, 안에서 시작한 레이는 그 벽을 못 본다(`rayBox` · `rayCylinder` 는 원점이 안이면 빗나감). 몸에서 쏘면
 * 벽 반대편 사람은 벽 입구 면에서 멈춘다. 끝점 앞 `BLAST_LOS_SLACK_M` 안의 면은 폭심이 붙은 면이라 막힘이 아니다.
 * 폭심은 `BLAST_LOS_LIFT_M` 올려 잰다 — 바닥 · 지붕 윗면에 놓인 폭발이 제 발밑 면에 막히지 않게.
 *
 * `world` 가 없으면(허브 · 테스트) 막지 않는다. 엄폐물 자신이 맞는 피해(파괴 가능한 엄폐물 · 구조물)는 부르지 않는다 —
 * 그 몸이 곧 레이가 맞는 콜라이더다.
 * ──────────────────────────────────────────────────────────────────────────── */

const _losFrom = new THREE.Vector3();
const _losTo = new THREE.Vector3();
const _losDir = new THREE.Vector3();

/**
 * `from` → `to` 선분이 월드에 막히지 않았는가. `slack` = 끝점 앞 이 거리 안에서 맞은 면은 무시.
 * 근접 공격(공격자 머리 → 타격점)과 폭발 3점 판정이 같이 쓴다.
 *
 * **근접도 같은 `raycastBlast` 를 쓴다** (2026-09-18, 이 파일의 결정): 창은 깨졌어도 막는다. 깨진 창틀은
 * 사람 · 적의 몸을 여전히 밀어내므로(`passSmall` 은 수류탄 크기만 통과) 적은 창틀 **밖**에 세워진 채로
 * 물어야 하고, 그건 「벽 너머에서 물기」와 다르지 않다. 창 하나 때문에 벽이 사라지는 자리를 폭발에서는
 * 막고 근접에서는 열어 두면 같은 방이 공격 종류마다 다르게 굴어 규칙이 두 개가 된다 — 레이는 하나로 둔다.
 * (주먹은 깨진 창으로 지나가도 괜찮다는 반론이 있었지만, 창틀이 몸을 막는 한 그 자리에 설 수가 없다.)
 */
export function lineClear(world: WorldRef | null | undefined, from: THREE.Vector3, to: THREE.Vector3, slack: number): boolean {
  if (!world || !world.ready) return true;
  _losDir.subVectors(to, from);
  const len = _losDir.length();
  const reach = len - Math.max(0, slack);
  if (!(reach > 1e-3)) return true;
  _losDir.multiplyScalar(1 / len);
  return world.raycastBlast(from, _losDir, reach) === null;
}

/**
 * 폭심 `center` 가 발 `(x, feetY, z)` · 키 `height` 인 몸의 3점 중 하나라도 보이는가. `height <= 0` = 한 점(드론 몸체 중심 등).
 * 피해 계산 **뒤**, 반경 안으로 판정된 대상에만 부른다 (레이 최대 셋 — 첫 번째로 보이는 점에서 끝난다).
 */
export function blastReachesBody(
  world: WorldRef | null | undefined, center: THREE.Vector3, x: number, feetY: number, z: number, height: number,
): boolean {
  if (!world || !world.ready) return true;
  _losTo.set(center.x, center.y + BLAST_LOS_LIFT_M, center.z);
  return bodyPointsVisible(world, _losTo, x, feetY, z, height, BLAST_LOS_SLACK_M);
}

/**
 * 근접 공격(적의 물기 · 도약 · 돌진 · 망치, 2026-09-18)이 몸에 닿는가 — 공격자의 입/머리 `from` 에서 같은 몸 3점을 본다.
 * 폭심을 들어올리지 않고 여유도 `MELEE_LOS_SLACK_M` 로 짧다 (몸끼리 붙어 있으니 끝점 앞 면은 곧 벽이다).
 * 낮은 엄폐물 너머 머리를 문 것은 맞고, 위층 바닥 · 벽 너머는 빗나간다.
 */
export function meleeReachesBody(
  world: WorldRef | null | undefined, from: THREE.Vector3, x: number, feetY: number, z: number, height: number,
): boolean {
  if (!world || !world.ready) return true;
  _losTo.copy(from);
  return bodyPointsVisible(world, _losTo, x, feetY, z, height, MELEE_LOS_SLACK_M);
}

/** 가슴 → 머리 → 발목 순으로 `target` 이 보이는 점이 하나라도 있는가 (`height <= 0` = 발 한 점). `target` 은 모듈 스크래치가 아니어야 한다. */
function bodyPointsVisible(world: WorldRef, target: THREE.Vector3, x: number, feetY: number, z: number, height: number, slack: number): boolean {
  if (!(height > 0)) return lineClear(world, _losFrom.set(x, feetY, z), target, slack);
  if (lineClear(world, _losFrom.set(x, feetY + height * BLAST_LOS_CHEST_FRAC, z), target, slack)) return true;
  if (lineClear(world, _losFrom.set(x, feetY + height * BLAST_LOS_HEAD_FRAC, z), target, slack)) return true;
  return lineClear(world, _losFrom.set(x, feetY + Math.min(BLAST_LOS_FEET_M, height * 0.5), z), target, slack);
}
