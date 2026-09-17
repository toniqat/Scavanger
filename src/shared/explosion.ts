import { EXPLOSION_FULL_FRACTION, EXPLOSION_OUTER_MUL } from './constants';

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
