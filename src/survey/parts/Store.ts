/**
 * src/survey/parts/Store.ts — account progress per subject, persisted per character slot.
 *
 * Two copies, the same way meta/ keeps its save (2026-09-21):
 *   - localStorage under `slotKey(SURVEY_STORAGE_KEY)` — the offline / single-player store and the cache of the server copy;
 *   - the relay profile document `survey` (`ctx.net.profile`, revisioned by `net/ProfileSync`) — every local write is also
 *     handed to `ProfileRef.set` (offline too: ProfileSync queues it for the next connection), and `net:profileLoaded`
 *     replaces the local save with the server's (server wins). A pending local edit is not lost there: ProfileSync keeps a
 *     queued document in its mirror, so `get('survey')` returns it and the edit is still uploaded.
 * A server with no `survey` document (every profile from before 2026-09-21) gets the local save uploaded — unless the
 * local save is empty, which would otherwise become rev 1 on the server and win over a machine that does have progress.
 */
import { SURVEY_SUBJECT_MAP, slotKey, type ProfileRef } from '@/shared';
import { SURVEY_SAVE_VERSION, SURVEY_STORAGE_KEY, type SubjectSave, type SurveySave } from '../model';

export function freshSave(): SurveySave {
  return { v: SURVEY_SAVE_VERSION, s: {} };
}

/** Anything from storage → a clean save: unknown subjects dropped, progress clamped to 0 … 1, planet ids strings. */
export function sanitizeSave(raw: unknown): SurveySave {
  const out = freshSave();
  if (!raw || typeof raw !== 'object') return out;
  const s = (raw as { s?: unknown }).s;
  if (!s || typeof s !== 'object') return out;
  for (const [id, v] of Object.entries(s as Record<string, unknown>)) {
    if (!SURVEY_SUBJECT_MAP.has(id) || !v || typeof v !== 'object') continue;
    const rec = v as { p?: unknown; pl?: unknown };
    const p = Number(rec.p);
    const pl = Array.isArray(rec.pl) ? rec.pl.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
    out.s[id] = { p: Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0, pl: [...new Set(pl)] };
  }
  return out;
}

export function loadSave(): SurveySave {
  try {
    const text = window.localStorage.getItem(slotKey(SURVEY_STORAGE_KEY));
    return text ? sanitizeSave(JSON.parse(text)) : freshSave();
  } catch {
    return freshSave();
  }
}

export function writeSave(save: SurveySave): void {
  try { window.localStorage.setItem(slotKey(SURVEY_STORAGE_KEY), JSON.stringify(save)); } catch { /* storage unavailable */ }
}

/** The record of `id`, created empty on first touch. */
export function recordOf(save: SurveySave, id: string): SubjectSave {
  return save.s[id] ?? (save.s[id] = { p: 0, pl: [] });
}

/** The survey profile document key (`shared/profile.ts` `ProfileDocKey`). */
const DOC_KEY = 'survey';

/** Queue `save` into the server profile. No-op without a net ref; offline is ProfileSync's business (it queues). */
export function uploadSave(profile: ProfileRef | null | undefined, save: SurveySave): void {
  if (!profile || typeof profile.set !== 'function') return;
  // a copy: ProfileSync keeps the object as its mirror / queued write, and `save` keeps being mutated in place
  try { profile.set(DOC_KEY, JSON.parse(JSON.stringify(save)) as SurveySave); } catch { /* net not ready */ }
}

/**
 * `net:profileLoaded`: the server copy (sanitised like a local load) when there is one, else null — the caller then
 * keeps its local save and uploads it (old profile without a `survey` document). The adopted copy is written to
 * localStorage as the cache, not uploaded again.
 */
export function adoptServer(profile: ProfileRef | null | undefined): SurveySave | null {
  if (!profile || !profile.available || typeof profile.get !== 'function') return null;
  let doc: unknown;
  try { doc = profile.get(DOC_KEY); } catch { doc = undefined; }
  if (!doc || typeof doc !== 'object') return null;
  const save = sanitizeSave(doc);
  writeSave(save);
  return save;
}

/** true when the save holds no progress and no planet stamp (nothing worth migrating to the server). */
export function isEmptySave(save: SurveySave): boolean {
  for (const rec of Object.values(save.s)) if (rec.p > 0 || rec.pl.length > 0) return false;
  return true;
}
