import type { ImplantId, PlayerProfile, SkillId, StatId } from '@/shared';
import {
  IMPLANT_IDS, PROFILE_STORAGE_KEY, PROFILE_VERSION, SKILL_IDS, SKILL_LEVEL_MAX, STAT_BASE, STAT_IDS, STAT_MAX,
} from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * localStorage persistence for the PlayerProfile.
 * Every single access is wrapped in try/catch: private-mode Safari throws on
 * `window.localStorage` itself, and a quota error must never break a mission.
 * ──────────────────────────────────────────────────────────────────────────── */

export type LoadOutcome = 'loaded' | 'migrated' | 'fresh' | 'corrupt';

export interface LoadResult {
  profile: PlayerProfile;
  outcome: LoadOutcome;
  /** Version found on disk (−1 when nothing / unreadable). */
  foundVersion: number;
}

/** Storage handle, or null when localStorage is unavailable (private mode, disabled cookies, SSR). */
function storage(): Storage | null {
  try {
    const s = window.localStorage;
    // Touch it — some browsers only throw on first use.
    const probe = '__scav_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function zeroSkills(): Record<SkillId, number> {
  const out = {} as Record<SkillId, number>;
  for (const id of SKILL_IDS) out[id] = 0;
  return out;
}

function baseStats(): Record<StatId, number> {
  const out = {} as Record<StatId, number>;
  for (const id of STAT_IDS) out[id] = STAT_BASE;
  return out;
}

export function freshProfile(name = '스캐빈저'): PlayerProfile {
  return {
    version: PROFILE_VERSION,
    name,
    level: 1,
    xp: 0,
    statPoints: 0,
    stats: baseStats(),
    skills: zeroSkills(),
    skillProgress: zeroSkills(),
    implant: null,
    raids: 0,
    extractions: 0,
  };
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Coerce whatever was on disk into a valid current-version profile. Written to be
 * forward-tolerant: unknown fields are dropped, missing ones take their defaults, and
 * every number is clamped. Add a `if (raw.version < N) …` step here when PROFILE_VERSION grows.
 */
export function migrate(raw: unknown): PlayerProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const found = num(r.version, 0, 0, 1e6);
  // A profile written by a *newer* build may use fields we cannot interpret — start over but keep the name.
  if (found > PROFILE_VERSION) {
    const p = freshProfile(typeof r.name === 'string' && r.name ? r.name.slice(0, 16) : undefined);
    return p;
  }

  const p = freshProfile(typeof r.name === 'string' && r.name ? r.name.slice(0, 16) : undefined);
  p.level = Math.round(num(r.level, 1, 1, 999));
  p.xp = num(r.xp, 0, 0, 1e9);
  p.statPoints = Math.round(num(r.statPoints, 0, 0, 9999));
  p.raids = Math.round(num(r.raids, 0, 0, 1e7));
  p.extractions = Math.round(num(r.extractions, 0, 0, 1e7));

  const stats = (r.stats ?? {}) as Record<string, unknown>;
  for (const id of STAT_IDS) p.stats[id] = Math.round(num(stats[id], STAT_BASE, 0, STAT_MAX));

  const skills = (r.skills ?? {}) as Record<string, unknown>;
  const prog = (r.skillProgress ?? {}) as Record<string, unknown>;
  for (const id of SKILL_IDS) {
    p.skills[id] = Math.round(num(skills[id], 0, 0, SKILL_LEVEL_MAX));
    p.skillProgress[id] = p.skills[id] >= SKILL_LEVEL_MAX ? 0 : num(prog[id], 0, 0, 0.999999);
  }

  const implant = r.implant;
  p.implant = typeof implant === 'string' && (IMPLANT_IDS as readonly string[]).includes(implant)
    ? (implant as ImplantId)
    : null;

  p.version = PROFILE_VERSION;
  return p;
}

export function loadProfile(): LoadResult {
  const s = storage();
  if (!s) return { profile: freshProfile(), outcome: 'fresh', foundVersion: -1 };
  let raw: string | null = null;
  try {
    raw = s.getItem(PROFILE_STORAGE_KEY);
  } catch {
    return { profile: freshProfile(), outcome: 'fresh', foundVersion: -1 };
  }
  if (!raw) return { profile: freshProfile(), outcome: 'fresh', foundVersion: -1 };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { profile: freshProfile(), outcome: 'corrupt', foundVersion: -1 };
  }
  const foundVersion = typeof (parsed as { version?: unknown })?.version === 'number'
    ? ((parsed as { version: number }).version | 0)
    : -1;
  const migrated = migrate(parsed);
  if (!migrated) return { profile: freshProfile(), outcome: 'corrupt', foundVersion };
  return {
    profile: migrated,
    outcome: foundVersion === PROFILE_VERSION ? 'loaded' : 'migrated',
    foundVersion,
  };
}

/** Returns false when the write failed (private mode / quota); callers just keep playing. */
export function saveProfile(profile: PlayerProfile): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredProfile(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
