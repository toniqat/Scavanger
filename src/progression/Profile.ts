import type { EquippedImplant, ImplantId, PlayerProfile, SkillId, StatId } from '@/shared';
import {
  IMPLANT_IDS, PROFILE_STORAGE_KEY, PROFILE_VERSION, SKILL_IDS, SKILL_LEVEL_MAX, STAT_BASE, STAT_IDS, STAT_MAX, STAT_MIN,
} from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * localStorage persistence for the PlayerProfile.
 * Every single access is wrapped in try/catch: private-mode Safari throws on
 * `window.localStorage` itself, and a quota error must never break a mission.
 * ──────────────────────────────────────────────────────────────────────────── */

export type LoadOutcome = 'loaded' | 'migrated' | 'fresh' | 'corrupt';

/** 전술 임플란트 a brand-new profile starts with (all six are owned from level 1; 갈고리 is the mobility staple). */
export const DEFAULT_IMPLANT: ImplantId = 'grapple';

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

/** Zero stat-XP progress for every stat (fresh profile / migration of a save from before 2026-09-06). */
export function zeroStatProgress(): Record<StatId, number> {
  const out = {} as Record<StatId, number>;
  for (const id of STAT_IDS) out[id] = 0;
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
    // 2026-09-07: a fresh character starts with 갈고리 in the tactical implant slot rather than an empty one
    // (every implant is owned from the start, so an empty slot was just a missed default).
    implant: DEFAULT_IMPLANT,
    raids: 0,
    extractions: 0,
    statProgress: zeroStatProgress(),
    // Phase 12 (2026-09-08): equipped 임플란트 items live here while out of the grids
    implants: [],
  };
}

/** Hard cap on stored equipped implants (IMPLANT_SLOTS_MAX is 10 and every implant costs >= 1 slot; this only bounds junk). */
const IMPLANTS_STORE_MAX = 32;

/**
 * Sanitise the `implants` array of a stored profile (Phase 12): objects with a non-empty string `uid` + `defId` only,
 * duplicates by uid dropped, `durability` kept when finite. Whether the def still exists is **not** checked here
 * (Profile.ts imports nothing from items/) — `ProgressionSystem.pruneImplants` does that once `ctx.loot` is up.
 */
export function sanitizeImplants(raw: unknown): EquippedImplant[] {
  if (!Array.isArray(raw)) return [];
  const out: EquippedImplant[] = [];
  const seen = new Set<string>();
  for (const it of raw) {
    if (out.length >= IMPLANTS_STORE_MAX) break;
    if (!it || typeof it !== 'object') continue;
    const { uid, defId, durability } = it as Record<string, unknown>;
    if (typeof uid !== 'string' || !uid || typeof defId !== 'string' || !defId || seen.has(uid)) continue;
    seen.add(uid);
    const e: EquippedImplant = { uid: uid.slice(0, 64), defId: defId.slice(0, 64) };
    if (typeof durability === 'number' && Number.isFinite(durability)) e.durability = Math.max(0, durability);
    out.push(e);
  }
  return out;
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

  // Stats live in STAT_MIN..STAT_MAX (stat XP can lower them, never below the floor).
  const stats = (r.stats ?? {}) as Record<string, unknown>;
  for (const id of STAT_IDS) p.stats[id] = Math.round(num(stats[id], STAT_BASE, STAT_MIN, STAT_MAX));

  // Stat XP progress (appended 2026-09-06): missing → zeros; a maxed stat may sit at exactly 1, everything else < 1.
  const statProg = (r.statProgress ?? {}) as Record<string, unknown>;
  const sp = zeroStatProgress();
  for (const id of STAT_IDS) sp[id] = num(statProg[id], 0, 0, p.stats[id] >= STAT_MAX ? 1 : 0.999999);
  p.statProgress = sp;

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

  // Phase 12: equipped implant items — missing on older saves → []
  p.implants = sanitizeImplants(r.implants);

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
