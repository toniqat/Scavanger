/**
 * **큰 수 축약 표기** (2026-09-16 사용자 결정).
 *
 * 크레딧 · 판매가 · 가치 · 재화 수량 · 경험치처럼 **자릿수가 얼마든 커질 수 있는 값**은 전부 이 한 곳을 지난다.
 * 개수 · 무게 · 내구도처럼 "정확한 값이 곧 뜻인" 수는 여기 오지 않는다 — `3.0k발` 같은 표기는 읽는 사람을 속인다.
 *
 * 규칙 (사용자 결정 그대로):
 *   |n| < 10,000        → `9,999`        자리 구분 쉼표, 축약하지 않는다
 *   |n| < 1,000,000     → `10.0k`        소수점 **1** 자리
 *   |n| < 1,000,000,000 → `1.00m`        소수점 **2** 자리
 *   그 이상             → `1.00b`        소수점 **2** 자리
 *
 * `k` 만 1,000 이 아니라 **10,000 부터**다: 네 자리(`1,234`)는 한눈에 읽히지만 다섯 자리부터는 그렇지 않다는 것이
 * 이 규칙의 이유다. 그래서 `9,999` 다음 값이 `10.0k` 로 이어진다.
 *
 * 소수점 아래는 **버린다**(`Math.trunc`). 올림이면 `999,999` 가 `1000.0k` 가 되어 단위 경계가 깨진다 — 버리면
 * `999.9k` 로 끝나고 `1.00m` 이 정확히 1,000,000 부터 시작한다.
 */

/** 축약이 시작되는 값. 이 아래는 쉼표만 찍는다. */
const COMPACT_FROM = 10_000;

/** [한계값, 나눌 값, 단위, 소수 자릿수] — 큰 단위부터 본다. */
const UNITS: readonly [number, string, number][] = [
  [1_000_000_000, 'b', 2],
  [1_000_000, 'm', 2],
  [1_000, 'k', 1],
];

/** `1234` → `1,234`. 부호 없는 정수 문자열. */
export function groupDigits(n: number): string {
  return Math.abs(Math.round(Number.isFinite(n) ? n : 0)).toLocaleString('ko-KR');
}

/**
 * 부호를 뺀 절대값 하나를 규칙대로 적는다 (`10.0k` · `1.00m`). 부호는 부르는 쪽이 붙인다.
 * 소수 자리는 버림이라 `999999` → `999.9k`, `999999999` → `999.99m` 로 끝난다.
 */
export function formatCompactNumber(n: number): string {
  const v = Math.abs(Math.round(Number.isFinite(n) ? n : 0));
  if (v < COMPACT_FROM) return v.toLocaleString('ko-KR');
  for (const [div, unit, digits] of UNITS) {
    if (v < div) continue;
    const pow = 10 ** digits;
    // 버림: 1000.0k 같은 경계 넘김을 막는다 (위 주석).
    return `${(Math.trunc((v / div) * pow) / pow).toFixed(digits)}${unit}`;
  }
  return v.toLocaleString('ko-KR');
}

/** `formatCompactNumber` + 부호. `sign: true` 면 양수에도 `+` 를 붙인다. 음수는 언제나 `−`(U+2212). */
export function formatCompactSigned(n: number, sign = false): string {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const head = v < 0 ? '−' : sign ? '+' : '';
  return `${head}${formatCompactNumber(v)}`;
}
