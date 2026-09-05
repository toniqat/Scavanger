/** Mission seed helpers shared by the title screen and the multiplayer lobby. */

/** Random 32-bit unsigned seed. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/**
 * Parse the seed field: blank → random, digits → number (uint32), anything else → FNV-1a hash.
 * Identical rules in `TitleMenu` and `LobbyMenu` so a code shared by voice yields the same map.
 */
export function parseSeed(raw: string): number {
  const s = raw.trim();
  if (!s) return randomSeed();
  if (/^\d+$/.test(s)) return Number(s) >>> 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
