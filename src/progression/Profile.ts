import type { EquippedImplant, GymStat, ImplantId, PlayerProfile, SkillId, StatId } from '@/shared';
import {
  GYM_STATS, GYM_TRAINED_MAX,
  IMPLANT_IDS, PROFILE_STORAGE_KEY, PROFILE_VERSION, SKILL_IDS, SKILL_LEVEL_MAX, STAT_BASE, STAT_IDS, STAT_MAX, STAT_MIN,
  normalizeMealQuality, slotKey,
} from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * localStorage persistence for the PlayerProfile.
 * Every single access is wrapped in try/catch: private-mode Safari throws on
 * `window.localStorage` itself, and a quota error must never break a mission.
 * ──────────────────────────────────────────────────────────────────────────── */

export type LoadOutcome = 'loaded' | 'migrated' | 'fresh' | 'corrupt';

/** The tactical implant a brand-new profile starts with (all five are owned from level 1; `갈고리` — the grapple — is the mobility staple). */
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
    /*
     * 2026-09-14 2nd pass (user's decision) — **it starts empty.** This reverses 2026-09-07's "an empty slot is a
     * default someone forgot": the tutorial raid is the stretch where you do not have an implant yet (merely hiding
     * the widget still leaves Q firing), and the grapple is granted and equipped by
     * `ProgressionSystem.grantStarterImplant` on the **first entry into the ship**.
     * `shared/character.makeCharacterProfile` writes null in the same place — the two creation paths must agree.
     */
    implant: null,
    raids: 0,
    extractions: 0,
    statProgress: zeroStatProgress(),
    // Phase 12 (2026-09-08): equipped implant items live here while out of the grids
    implants: [],
    // A-13 (2026-09-11): preparations — the waiting set / this raid's set. Both empty for a new character.
    prep: [],
    prepActive: [],
    // A-3c (2026-09-11): the meal — a fixed single slot, so not an array. null when nothing was eaten.
    meal: null,
    mealActive: null,
    // 2026-09-13 (cook quality): the star count that travels beside the meal id, 0 … MEAL_QUALITY_MAX. 0 when nothing was eaten.
    mealQuality: 0,
    mealActiveQuality: 0,
    // A-3a (2026-09-12): the gym — training bonus · workout debuff. Both empty for a new character (= 0 · none).
    // 2026-09-17: there is no separate training progress (`trainedProgress`) — minigame XP shares the stat-XP bar (`statProgress`).
    trained: {},
    gymFatigueUntil: {},
  };
}

/**
 * Sanitise the gym maps of a stored profile (A-3a). Only `GYM_STATS` keys survive; `trained` is an integer
 * 0 … `GYM_TRAINED_MAX`, `gymFatigueUntil` a finite epoch ms > 0. Zero entries are left out so a fresh / untouched
 * character keeps empty maps. 2026-09-17: the old `trainedProgress` map (a separate training bar) is **dropped** — the
 * training bonus now fills the stat-XP bar (`ProgressionSystem.addStatXp` minigame source); `trained` values are kept
 * as they were. An expired fatigue stamp is kept (it reads as "none" through `getGymFatigueUntil`) — the clock that
 * decides expiry is the relay's, which `Profile.ts` does not have.
 */
export function sanitizeGym(raw: { trained?: unknown; gymFatigueUntil?: unknown }): Pick<PlayerProfile, 'trained' | 'gymFatigueUntil'> {
  const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const tr = rec(raw.trained), fa = rec(raw.gymFatigueUntil);
  const trained: Partial<Record<GymStat, number>> = {};
  const gymFatigueUntil: Partial<Record<GymStat, number>> = {};
  for (const id of GYM_STATS) {
    const n = Math.round(num(tr[id], 0, 0, GYM_TRAINED_MAX));
    if (n > 0) trained[id] = n;
    const until = num(fa[id], 0, 0, 8.64e15);
    if (until > 0) gymFatigueUntil[id] = until;
  }
  return { trained, gymFatigueUntil };
}

/** Hard cap on stored prep ids (there is one per `EnvKind`; this only bounds junk from a corrupt file). */
const PREP_STORE_MAX = 8;

/**
 * Sanitise a stored preparation list (A-13): non-empty strings only, duplicates dropped, capped. Whether the def still
 * exists — and whether two entries share an `env` — is **not** checked here (`Profile.ts` imports nothing from
 * items/); `ProgressionSystem.prunePreps` does that once `ctx.loot` is up, exactly like `sanitizeImplants`.
 */
export function sanitizePreps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of raw) {
    if (out.length >= PREP_STORE_MAX) break;
    if (typeof it !== 'string' || !it) continue;
    const id = it.slice(0, 64);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Sanitise a stored meal id (A-3c): one non-empty string or null. Whether the def still exists — and whether it is
 * really a meal — is **not** checked here (`Profile.ts` imports nothing from items/); `ProgressionSystem.pruneMeal`
 * does that once `ctx.loot` is up, exactly like `prunePreps` / `pruneImplants`.
 */
export function sanitizeMeal(raw: unknown): string | null {
  return typeof raw === 'string' && raw ? raw.slice(0, 64) : null;
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

  /* 2026-09-15: the retired `atlauncher` (대전차포, the anti-tank launcher) is not in `IMPLANT_IDS`, so it becomes
   * null here — migrate's result *is* the next `saveProfile`, so one load erases it from the save too. The empty slot
   * is filled with the grapple by `ProgressionSystem.grantStarterImplant` on the next `hub:entered` (after that it is
   * chosen again from the inventory picker). */
  const implant = r.implant;
  p.implant = typeof implant === 'string' && (IMPLANT_IDS as readonly string[]).includes(implant)
    ? (implant as ImplantId)
    : null;

  // Phase 12: equipped implant items — missing on older saves → []
  p.implants = sanitizeImplants(r.implants);

  /* A-13 (2026-09-11): preparations. An old save has neither field → empty arrays. `prepActive` has to still be there
   * when someone who dropped mid-raid comes back (「nobody who returns through a reconnect may lose something
   * silently」), so it must be carried over here — migrate's result *is* the content of the next `saveProfile`. */
  p.prep = sanitizePreps(r.prep);
  p.prepActive = sanitizePreps(r.prepActive);

  /* A-3c (2026-09-11): the meal. Carried over here for **exactly the same reason** as preparations — migrate's result
   * *is* the content of the next `saveProfile`, so leaving it out makes a meal eaten at the dining table vanish on one
   * reload (the same spot as the 2026-09-09 `accent` incident). `mealActive` has to survive for someone who dropped
   * mid-raid and came back. */
  p.meal = sanitizeMeal(r.meal);
  p.mealActive = sanitizeMeal(r.mealActive);
  /* 2026-09-13 (cook quality): the quality travels beside the meal id — the same lesson in the same place, so not
   * carrying it over turns a ★★★★★ meal into a ☆ on one reload. Clamped to an integer 0 … MEAL_QUALITY_MAX, and 0 when
   * there is no id to pair it with. */
  p.mealQuality = p.meal ? normalizeMealQuality(r.mealQuality) : 0;
  p.mealActiveQuality = p.mealActive ? normalizeMealQuality(r.mealActiveQuality) : 0;

  /* A-3a (2026-09-12): the gym — training bonus · workout debuff (2026-09-17: the old `trainedProgress` is not carried
   * over = discarded). The same lesson in the same place: migrate's result *is* the content of the next `saveProfile`
   * (and of the server `progression` document), so not carrying it over makes the bonus earned by working out and the
   * 24-hour debuff vanish on one reload — and once the debuff is gone you can work out again immediately. */
  Object.assign(p, sanitizeGym(r));

  /* 2026-09-09 (the character creation window): `accent` / `createdAt` / `playedAt` are fields planted by
   * `shared/character.makeCharacterProfile`. Not carrying them over here makes them **disappear on the first save** —
   * `migrate`'s result *is* the content of the next `saveProfile`, so one reload erased the character's colour and
   * creation time (this is also what `readSlotCard` reads: the card's accent fell back to the default colour).
   * Unknown fields are still dropped. */
  const accent = r.accent;
  if (typeof accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(accent)) p.accent = accent;
  const createdAt = num(r.createdAt, 0, 0, 8.64e15);
  if (createdAt > 0) p.createdAt = createdAt;
  const playedAt = num(r.playedAt, 0, 0, 8.64e15);
  if (playedAt > 0) p.playedAt = playedAt;

  p.version = PROFILE_VERSION;
  return p;
}

export function loadProfile(): LoadResult {
  const s = storage();
  if (!s) return { profile: freshProfile(), outcome: 'fresh', foundVersion: -1 };
  let raw: string | null = null;
  try {
    raw = s.getItem(slotKey(PROFILE_STORAGE_KEY));
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
    s.setItem(slotKey(PROFILE_STORAGE_KEY), JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredProfile(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(slotKey(PROFILE_STORAGE_KEY));
  } catch {
    /* ignore */
  }
}
