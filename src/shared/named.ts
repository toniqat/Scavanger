import type { EnemyType } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Named rogues (2026-09-11). Owner: `enemies/` — spawning is `enemies/named/Director`, the AI is `enemies/ai/named/*`.
 *
 * There is **at most one per raid** (user's decision). The chance is read from the `NAMED_ROGUE_CHANCE_BY_RANK` table by
 * the planet's difficulty rank (`planetTier`, 1..5), and which of the three it is comes from the same seed stream — the
 * answer is the same even when the host changes. Every named rogue uses the humanoid rogue rig and its faction is `rogue`.
 *
 *  - 로든 (`rogue_sniper`)  — a prone sniper in the open. At a distance it targets only a player who has taken
 *    `scanPulses` pulses from its **scan drone** (`rogue_scan_drone`) (high accuracy); inside its detection range it
 *    fires with no drone (accuracy falling with distance).
 *    A scope glint (`named:sniperGlint`) always comes up first — there is no instant death without a warning.
 *  - 타길라 (`rogue_hammer`) — a hammer in melee. 50 a second once it is on you. 10× the hp of a normal rogue. It stands near cover and structures.
 *  - 헤비 (`rogue_heavy`)    — a minigun. It comes with an SMG rogue escort (`NAMED_HEAVY_ESCORTS_BY_SQUAD`, by squad size).
 * ──────────────────────────────────────────────────────────────────────────── */

export type NamedRogueType = 'rogue_sniper' | 'rogue_hammer' | 'rogue_heavy';

export const NAMED_ROGUE_TYPES: readonly NamedRogueType[] = ['rogue_sniper', 'rogue_hammer', 'rogue_heavy'];

/** The names written in-game. */
export const NAMED_ROGUE_NAME_KO: Readonly<Record<NamedRogueType, string>> = {
  rogue_sniper: '로든',
  rogue_hammer: '타길라',
  rogue_heavy: '헤비',
};

export function isNamedRogueType(t: EnemyType | string | null | undefined): t is NamedRogueType {
  return t === 'rogue_sniper' || t === 'rogue_hammer' || t === 'rogue_heavy';
}
