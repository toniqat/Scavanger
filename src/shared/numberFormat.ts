/**
 * **Compact notation for big numbers** (2026-09-16 user's decision).
 *
 * Every **value whose digit count can grow without limit** — credits · sale prices · worth · currency amounts · XP —
 * passes through this one place. Numbers where "the exact value is the meaning", like counts · weight · durability, do
 * not come here — a notation like `3.0k발` lies to the reader.
 *
 * The rules (exactly as the user decided):
 *   |n| < 10,000        → `9,999`        grouping commas, not abbreviated
 *   |n| < 1,000,000     → `10.0k`        **1** decimal place
 *   |n| < 1,000,000,000 → `1.00m`        **2** decimal places
 *   Above that          → `1.00b`        **2** decimal places
 *
 * `k` starts at **10,000** and not at 1,000: four digits (`1,234`) read at a glance but five do not, and that is the
 * reason for this rule. So the value after `9,999` continues as `10.0k`.
 *
 * The decimals are **truncated** (`Math.trunc`). Rounding up would turn `999,999` into `1000.0k` and break the unit
 * boundary — truncating ends at `999.9k` and lets `1.00m` start at exactly 1,000,000.
 */

/** The value where abbreviating starts. Below it, only commas are put in. */
const COMPACT_FROM = 10_000;

/** [the threshold, the divisor, the unit, the decimal places] — looked at from the biggest unit down. */
const UNITS: readonly [number, string, number][] = [
  [1_000_000_000, 'b', 2],
  [1_000_000, 'm', 2],
  [1_000, 'k', 1],
];

/** `1234` → `1,234`. An unsigned integer string. */
export function groupDigits(n: number): string {
  return Math.abs(Math.round(Number.isFinite(n) ? n : 0)).toLocaleString('ko-KR');
}

/**
 * Writes one absolute value, the sign removed, by the rules (`10.0k` · `1.00m`). The sign is added by the caller.
 * The decimals are truncated, so `999999` ends as `999.9k` and `999999999` as `999.99m`.
 */
export function formatCompactNumber(n: number): string {
  const v = Math.abs(Math.round(Number.isFinite(n) ? n : 0));
  if (v < COMPACT_FROM) return v.toLocaleString('ko-KR');
  for (const [div, unit, digits] of UNITS) {
    if (v < div) continue;
    const pow = 10 ** digits;
    // Truncation: it stops a boundary overrun like 1000.0k (comment above).
    return `${(Math.trunc((v / div) * pow) / pow).toFixed(digits)}${unit}`;
  }
  return v.toLocaleString('ko-KR');
}

/** `formatCompactNumber` + the sign. With `sign: true` a `+` is put on positives too. A negative is always `−`(U+2212). */
export function formatCompactSigned(n: number, sign = false): string {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const head = v < 0 ? '−' : sign ? '+' : '';
  return `${head}${formatCompactNumber(v)}`;
}
