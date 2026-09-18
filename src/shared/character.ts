import {
  CHAR_NAME_RANDOM_MAX, CHAR_STAT_MAX, CHAR_STAT_MIN, CHAR_STAT_TOTAL, PROFILE_VERSION,
} from './constants';
import { IMPLANT_IDS, type ImplantId } from './implants';
import { SKILL_IDS, STAT_IDS, type PlayerProfile, type SkillId, type StatId } from './progression';
import { type SlotId, writeSlotSave } from './saveSlot';

/* ────────────────────────────────────────────────────────────────────────────
 * Character creation (2026-09-09).
 *
 * The **rules** of the creation window that opens from an empty slot of the character select screen, and the
 * function that plants its result into a slot. `ui/` draws it and `progression/` reads it later, so `shared/` —
 * which both depend on — is its place.
 *
 * **Stats**: all five stats start at `CHAR_STAT_MIN` (1) and are distributed until the sum is
 * `CHAR_STAT_TOTAL` (15) — that is, 15 − 5 = **10** points to spend. One stat's ceiling is `CHAR_STAT_MAX` (5).
 * That is the ceiling **at creation** only; the ceiling a stat grows to in game is still `STAT_MAX` (20).
 *
 * Existing saves are left alone (2026-09-09 decision): the `STAT_BASE` (5) of `progression/Profile.freshProfile`
 * stays and keeps being the default of a profile made without going through the creation window. Only a
 * character that went through it follows the rules here.
 *
 * **Written before boot.** Once creation is done this module writes the slot's `scav.s<n>.profile` itself, and
 * the caller does `setActiveSlot` + `markAutoStart` + `location.reload()`. No path is left for pushing a new
 * profile into a `ProgressionSystem` that is already in memory — the stash · meta · the ship would all have to be
 * read again, and that is a boot.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The creation window's stat floor · ceiling · total (data/constants.csv). */
export const CREATE_STAT_MIN: number = Math.round(CHAR_STAT_MIN);
export const CREATE_STAT_MAX: number = Math.round(CHAR_STAT_MAX);
export const CREATE_STAT_TOTAL: number = Math.round(CHAR_STAT_TOTAL);

/** Points left to distribute when everything starts at the floor (10 under the default rules). */
export const CREATE_STAT_POINTS: number = Math.max(0, CREATE_STAT_TOTAL - CREATE_STAT_MIN * STAT_IDS.length);

/** The prefix the name dice uses. */
export const DEFAULT_CALLSIGN = '스캐빈저';

/** Maximum character-name length (the same value as `sanitizePlayerName`). */
export const CHARACTER_NAME_MAX = 16;

/** What the creation window collects and hands over. */
export interface NewCharacter {
  name: string;
  stats: Record<StatId, number>;
  /** Soldier model accent colour `#rrggbb`. */
  accent: string;
  /** The starting tactical implant. */
  implant: ImplantId;
}

/** The distribution with every stat at the floor (the creation window's starting state). */
export function baseCreateStats(): Record<StatId, number> {
  const out = {} as Record<StatId, number>;
  for (const id of STAT_IDS) out[id] = CREATE_STAT_MIN;
  return out;
}

/** The sum of the distribution. */
export function statTotal(stats: Record<StatId, number>): number {
  let n = 0;
  for (const id of STAT_IDS) n += stats[id] ?? 0;
  return n;
}

/** Points not spent yet (the distribution side blocks it from ever going negative). */
export function statPointsLeft(stats: Record<StatId, number>): number {
  return CREATE_STAT_TOTAL - statTotal(stats);
}

/**
 * Can one stat be moved by `delta`. It looks at the floor · the ceiling · the points left.
 * Raising needs points left; lowering needs to stay above the floor.
 */
export function canAdjustStat(stats: Record<StatId, number>, id: StatId, delta: number): boolean {
  const cur = stats[id] ?? CREATE_STAT_MIN;
  const next = cur + delta;
  if (next < CREATE_STAT_MIN || next > CREATE_STAT_MAX) return false;
  if (delta > 0 && statPointsLeft(stats) < delta) return false;
  return true;
}

/** Presses a distribution back inside the rules (a value coming from outside is not trusted). */
export function clampCreateStats(raw: Partial<Record<StatId, number>>): Record<StatId, number> {
  const out = baseCreateStats();
  for (const id of STAT_IDS) {
    const v = raw[id];
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : CREATE_STAT_MIN;
    out[id] = Math.min(CREATE_STAT_MAX, Math.max(CREATE_STAT_MIN, n));
  }
  // when the sum overflows, cut from the back — the UI blocks an overflow first, but the contract keeps itself
  let over = statTotal(out) - CREATE_STAT_TOTAL;
  for (let i = STAT_IDS.length - 1; i >= 0 && over > 0; i--) {
    const id = STAT_IDS[i];
    const room = out[id] - CREATE_STAT_MIN;
    const cut = Math.min(room, over);
    out[id] -= cut;
    over -= cut;
  }
  return out;
}

/**
 * The dice: scatters the remaining points at random. A stat that reaches the ceiling drops out of the draw, so
 * the sum is always `CREATE_STAT_TOTAL`. `rand` is 0..1 (left open so a test can inject one).
 */
export function rollCreateStats(rand: () => number = Math.random): Record<StatId, number> {
  const out = baseCreateStats();
  let left = CREATE_STAT_POINTS;
  const open: StatId[] = [...STAT_IDS];
  while (left > 0 && open.length > 0) {
    const i = Math.min(open.length - 1, Math.floor(rand() * open.length));
    const id = open[i];
    out[id] += 1;
    left -= 1;
    if (out[id] >= CREATE_STAT_MAX) open.splice(i, 1);
  }
  return out;
}

/** The name dice: `스캐빈저1234`. */
export function rollCallsign(rand: () => number = Math.random): string {
  const n = Math.floor(rand() * (Math.max(1, Math.round(CHAR_NAME_RANDOM_MAX)) + 1));
  return `${DEFAULT_CALLSIGN}${n}`;
}

/** Trims a name into something usable (surrounding whitespace removed · length capped · an empty name becomes the default). */
export function sanitizeCharacterName(raw: string): string {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, CHARACTER_NAME_MAX);
  return t || DEFAULT_CALLSIGN;
}

/** The startable implants to pick from (every one is owned from the start, so the list is all of them). */
export const CREATE_IMPLANT_IDS: readonly ImplantId[] = IMPLANT_IDS;

/**
 * The accent palette (2026-09-09). The colour goes on the cloth · visor · shoulder plate of the procedural
 * soldier model, so only saturations whose silhouette still reads under the ship's dim lighting are picked.
 * Adding values keeps the UI flowing as it is.
 */
export const ACCENT_COLORS: readonly string[] = [
  '#ff8a5c', '#7fb4ff', '#6ee7a8', '#d9b96a', '#c98cff', '#ff6b8a', '#5fd8e0', '#b6c2cf',
];

export const DEFAULT_ACCENT = ACCENT_COLORS[0];

function zeroSkills(): Record<SkillId, number> {
  const out = {} as Record<SkillId, number>;
  for (const id of SKILL_IDS) out[id] = 0;
  return out;
}

function zeroStats(): Record<StatId, number> {
  const out = {} as Record<StatId, number>;
  for (const id of STAT_IDS) out[id] = 0;
  return out;
}

/**
 * A new profile holding the creation window's picks as they are. The same shape as
 * `progression/Profile.freshProfile`, but the stats are the creation window's distribution and the accent · the
 * creation time are attached. Written at the current version, which `migrate` can read.
 */
export function makeCharacterProfile(c: NewCharacter): PlayerProfile {
  const now = Date.now();
  return {
    version: PROFILE_VERSION,
    name: sanitizeCharacterName(c.name),
    level: 1,
    xp: 0,
    statPoints: 0,
    stats: clampCreateStats(c.stats),
    skills: zeroSkills(),
    skillProgress: zeroSkills(),
    /*
     * 2026-09-14 2nd pass (user's decision) — **a new character starts with no tactical implant.** If 「hide the
     * implant」 in the tutorial raid only folded the widget away, Q would still fire the grapple — using something
     * that was never owned. So the value itself is emptied and the grapple is granted and equipped at the
     * **first ship entry** (`progression/ProgressionSystem.grantStarterImplant`, `hub:entered`). Whether the
     * tutorial is completed or skipped, that one place is always passed through. `NewCharacter.implant` stays
     * because it is a contract (the creation window still passes it), but it is not read here — the same
     * treatment as `airstrike` · `secondary`.
     */
    implant: null,
    raids: 0,
    extractions: 0,
    statProgress: zeroStats(),
    implants: [],
    accent: /^#[0-9a-fA-F]{6}$/.test(c.accent) ? c.accent : DEFAULT_ACCENT,
    createdAt: now,
    playedAt: now,
  };
}

/**
 * Plants a new character into a slot. Any save left in that slot is cleared by the caller beforehand with
 * `deleteSlot` (the creation window only opens on an empty slot, so it is usually empty already). `null` when the
 * write fails — a browser whose storage is blocked.
 */
export function createCharacterInSlot(slot: SlotId, c: NewCharacter): PlayerProfile | null {
  const profile = makeCharacterProfile(c);
  return writeSlotSave(slot, 'scav.profile', profile) ? profile : null;
}
