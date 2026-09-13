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
    // A-13 (2026-09-11): 준비물 — 대기분 / 이번 레이드분. 새 캐릭터는 둘 다 비어 있다.
    prep: [],
    prepActive: [],
    // A-3c (2026-09-11): 식사 — 고정 1칸이라 배열이 아니다. 안 먹었으면 null.
    meal: null,
    mealActive: null,
    // 2026-09-13 (요리 품질): 식사 id 옆에 붙어 다니는 별 수 0 … MEAL_QUALITY_MAX. 안 먹었으면 0.
    mealQuality: 0,
    mealActiveQuality: 0,
    // A-3a (2026-09-12): 헬스장 — 단련 보너스 · 진행도 · 운동 디버프. 새 캐릭터는 셋 다 비어 있다 (= 0 · 없음).
    trained: {},
    trainedProgress: {},
    gymFatigueUntil: {},
  };
}

/**
 * Sanitise the three 헬스장 maps of a stored profile (A-3a). Only `GYM_STATS` keys survive; `trained` is an integer
 * 0 … `GYM_TRAINED_MAX`, `trainedProgress` 0 … 0.999999 (exactly 1 only while `trained` sits at the cap — the same rule as
 * `statProgress`), `gymFatigueUntil` a finite epoch ms > 0. Zero entries are left out so a fresh / untouched character
 * keeps empty maps. An expired fatigue stamp is kept (it reads as 「없음」 through `getGymFatigueUntil`) — the clock that
 * decides expiry is the relay's, which `Profile.ts` does not have.
 */
export function sanitizeGym(raw: { trained?: unknown; trainedProgress?: unknown; gymFatigueUntil?: unknown }): Pick<PlayerProfile, 'trained' | 'trainedProgress' | 'gymFatigueUntil'> {
  const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const tr = rec(raw.trained), pr = rec(raw.trainedProgress), fa = rec(raw.gymFatigueUntil);
  const trained: Partial<Record<GymStat, number>> = {};
  const trainedProgress: Partial<Record<GymStat, number>> = {};
  const gymFatigueUntil: Partial<Record<GymStat, number>> = {};
  for (const id of GYM_STATS) {
    const n = Math.round(num(tr[id], 0, 0, GYM_TRAINED_MAX));
    if (n > 0) trained[id] = n;
    const p = n >= GYM_TRAINED_MAX ? 1 : num(pr[id], 0, 0, 0.999999);
    if (p > 0) trainedProgress[id] = p;
    const until = num(fa[id], 0, 0, 8.64e15);
    if (until > 0) gymFatigueUntil[id] = until;
  }
  return { trained, trainedProgress, gymFatigueUntil };
}

/** Hard cap on stored prep ids (there is one per `EnvKind`; this only bounds junk from a corrupt file). */
const PREP_STORE_MAX = 8;

/**
 * Sanitise a stored 준비물 list (A-13): non-empty strings only, duplicates dropped, capped. Whether the def still
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
 * Sanitise a stored 식사 id (A-3c): one non-empty string or null. Whether the def still exists — and whether it is
 * really a 요리 — is **not** checked here (`Profile.ts` imports nothing from items/); `ProgressionSystem.pruneMeal`
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

  const implant = r.implant;
  p.implant = typeof implant === 'string' && (IMPLANT_IDS as readonly string[]).includes(implant)
    ? (implant as ImplantId)
    : null;

  // Phase 12: equipped implant items — missing on older saves → []
  p.implants = sanitizeImplants(r.implants);

  /* A-13 (2026-09-11): 준비물. 옛 세이브에는 두 필드가 없다 → 빈 배열. `prepActive` 는 레이드 도중에 끊긴 사람이
   * 돌아왔을 때 그대로 살아 있어야 하는 값이므로 (「재접속으로 돌아온 사람이 조용히 무언가를 잃으면 안 된다」)
   * 여기서 반드시 옮겨 담는다 — migrate 의 결과가 곧 다음 `saveProfile` 의 내용이다. */
  p.prep = sanitizePreps(r.prep);
  p.prepActive = sanitizePreps(r.prepActive);

  /* A-3c (2026-09-11): 식사. 준비물과 **완전히 같은 이유**로 여기서 옮겨 담는다 — migrate 의 결과가 곧 다음
   * `saveProfile` 의 내용이라, 빠뜨리면 식탁에서 먹은 요리가 새로고침 한 번에 사라진다 (2026-09-09 `accent`
   * 사고와 같은 자리). `mealActive` 는 레이드 도중 끊긴 사람이 돌아와도 살아 있어야 하는 값이다. */
  p.meal = sanitizeMeal(r.meal);
  p.mealActive = sanitizeMeal(r.mealActive);
  /* 2026-09-13 (요리 품질): 품질은 요리 id 옆에 붙어 다닌다 — 같은 자리의 같은 교훈이라 여기서 옮기지 않으면 ★★★★★ 요리가
   * 새로고침 한 번에 ☆ 가 된다. 0 … MEAL_QUALITY_MAX 정수로 자르고, 짝이 되는 id 가 없으면 0 이다. */
  p.mealQuality = p.meal ? normalizeMealQuality(r.mealQuality) : 0;
  p.mealActiveQuality = p.mealActive ? normalizeMealQuality(r.mealActiveQuality) : 0;

  /* A-3a (2026-09-12): 헬스장 — 단련 보너스 · 진행도 · 운동 디버프. 같은 자리의 같은 교훈이다: migrate 의 결과가 곧 다음
   * `saveProfile` (그리고 서버 `progression` 문서) 의 내용이라, 여기서 옮기지 않으면 운동으로 얻은 보너스와 24시간 디버프가
   * 새로고침 한 번에 사라진다 — 디버프가 사라지면 곧바로 다시 운동할 수 있다. */
  Object.assign(p, sanitizeGym(r));

  /* 2026-09-09 (캐릭터 생성창): `accent` / `createdAt` / `playedAt` 은 `shared/character.makeCharacterProfile`
   * 이 심는 필드다. 여기서 옮겨 담지 않으면 **첫 저장에서 사라진다** — `migrate` 의 결과가 곧 다음
   * `saveProfile` 의 내용이므로, 새로고침 한 번에 캐릭터의 색과 만든 시각이 지워졌다 (`readSlotCard` 가
   * 읽는 자리도 여기다: 카드의 악센트가 기본색으로 되돌아갔다). 모르는 필드는 계속 버린다. */
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
