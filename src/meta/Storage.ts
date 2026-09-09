import type { CorpId, MetaSave, ProfileRef, QuestState } from '@/shared';
import { CONTRACT_DEFS, CORP_IDS, CREDITS_INITIAL, CREDITS_MAX, META_STORAGE_KEY, QUEST_DEFS, slotKey } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * MetaSave v1 in localStorage `META_STORAGE_KEY` (`scav.meta`), same pattern as `inventory/Stash.ts`:
 * every storage access is wrapped in try/catch (private mode / quota / hostile JSON), loads are sanitised field by
 * field (clamped credits, known corp / quest / contract ids only, `locked` / `available` quest states are never
 * stored — they are recomputed from `QuestDef.requires`), writes are debounced 350 ms and flushed on `pagehide`.
 * Phase 7: every flush also mirrors the save into the server profile (`ctx.net.profile.set('meta', …)`) when one is
 * available; `replace()` swaps the data for the server document without echoing it back.
 * ──────────────────────────────────────────────────────────────────────────── */

export const META_SAVE_VERSION = 1;
const SAVE_DELAY_MS = 350;
/** Guard against an absurd progress figure inflating the HUD (loads and live hits are clamped to it). */
export const MAX_PROGRESS = 1_000_000_000;

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__scav_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

/** A brand-new profile: `CREDITS_INITIAL` credits, rep 0 everywhere, no contract, no quest history. */
export function freshMetaSave(): MetaSave {
  const corps = {} as MetaSave['corps'];
  for (const id of CORP_IDS) corps[id] = { rep: 0, quests: {} };
  return {
    v: META_SAVE_VERSION,
    credits: CREDITS_INITIAL,
    corps,
    activeContract: null,
    stats: { contractsDone: 0, questsDone: 0, creditsEarned: 0, creditsSpent: 0 },
  };
}

/** Normalise anything that came out of storage into a valid `MetaSave` (unknown ids dropped, numbers clamped). */
export function sanitizeMetaSave(raw: unknown): MetaSave {
  const out = freshMetaSave();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<MetaSave> & Record<string, unknown>;
  out.credits = clampInt(r.credits, 0, CREDITS_MAX, CREDITS_INITIAL);

  const corps = (r.corps && typeof r.corps === 'object') ? r.corps as Record<string, unknown> : {};
  for (const id of CORP_IDS) {
    const c = corps[id];
    if (!c || typeof c !== 'object') continue;
    const cc = c as { rep?: unknown; quests?: unknown };
    out.corps[id].rep = clampInt(cc.rep, 0, Number.MAX_SAFE_INTEGER, 0);
    const q = (cc.quests && typeof cc.quests === 'object') ? cc.quests as Record<string, unknown> : {};
    for (const qid in q) {
      const def = QUEST_DEFS.find((d) => d.id === qid);
      if (!def || def.corp !== id) continue;
      const st = q[qid];
      if (st === 'accepted' || st === 'complete') out.corps[id].quests[qid] = st as QuestState;
    }
  }

  const ac = r.activeContract;
  if (ac && typeof ac === 'object') {
    const a = ac as { id?: unknown; progress?: unknown };
    const def = typeof a.id === 'string' ? CONTRACT_DEFS.find((d) => d.id === a.id) : undefined;
    if (def) {
      const p = Number(a.progress);
      out.activeContract = { id: def.id, progress: Number.isFinite(p) ? Math.max(0, Math.min(MAX_PROGRESS, p)) : 0 };
    }
  }

  const st = (r.stats && typeof r.stats === 'object') ? r.stats as Record<string, unknown> : {};
  out.stats.contractsDone = clampInt(st.contractsDone, 0, Number.MAX_SAFE_INTEGER, 0);
  out.stats.questsDone = clampInt(st.questsDone, 0, Number.MAX_SAFE_INTEGER, 0);
  out.stats.creditsEarned = clampInt(st.creditsEarned, 0, Number.MAX_SAFE_INTEGER, 0);
  out.stats.creditsSpent = clampInt(st.creditsSpent, 0, Number.MAX_SAFE_INTEGER, 0);
  return out;
}

/** Owns the save object; the system mutates `data` in place and calls `markDirty()` / `flush()`. */
export class MetaStorage {
  data: MetaSave;
  private timer: number | null = null;
  private dirty = false;
  private onPageHide = (): void => this.flush();

  /** `profile` = the server profile mirror (`ctx.net.profile`), read lazily because net/ may swap it after our init. */
  constructor(private readonly profile: () => ProfileRef | null = () => null) {
    this.data = MetaStorage.load();
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onPageHide);
  }

  static load(): MetaSave {
    const s = storage();
    if (!s) return freshMetaSave();
    try {
      const raw = s.getItem(slotKey(META_STORAGE_KEY));
      if (!raw) return freshMetaSave();
      return sanitizeMetaSave(JSON.parse(raw));
    } catch { return freshMetaSave(); }
  }

  /** Debounced write (a shop session writes once, not per click). */
  markDirty(): void {
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; this.flush(); }, SAVE_DELAY_MS);
  }

  /** Write immediately (page hide, hub entry, dispose) — localStorage first, then the server profile document. */
  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    this.writeCache();
    this.upload();
  }

  /** The serialisable save (`v` pinned). */
  snapshot(): MetaSave { return JSON.parse(JSON.stringify({ ...this.data, v: META_SAVE_VERSION })) as MetaSave; }

  /** localStorage write of the current data (the cache of the server copy); no upload. */
  writeCache(): void {
    const s = storage();
    if (!s) return;
    try { s.setItem(slotKey(META_STORAGE_KEY), JSON.stringify({ ...this.data, v: META_SAVE_VERSION })); } catch { /* quota / private mode */ }
  }

  /** Queue the save into the server profile (`profile:set meta`). Phase 9: offline too — `ProfileSync` stamps + queues it. */
  upload(): void {
    const p = this.profile();
    if (!p || typeof p.set !== 'function') return;
    try { p.set('meta', this.snapshot()); } catch { /* net not ready */ }
  }

  /**
   * Take a server document as the new truth (Phase 7 `net:profileLoaded`): sanitised like a local load, written to
   * localStorage as the cache, **not** uploaded again (it came from the server).
   */
  replace(raw: unknown): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.data = sanitizeMetaSave(raw);
    this.dirty = false;
    this.writeCache();
  }

  /** Replace the data with a fresh save and persist it right away. */
  reset(): void {
    this.data = freshMetaSave();
    this.dirty = true;
    this.flush();
  }

  /** Helper for the corp lookup on a possibly stale id. */
  corp(id: CorpId): MetaSave['corps'][CorpId] {
    return this.data.corps[id] ?? (this.data.corps[id] = { rep: 0, quests: {} });
  }

  dispose(): void {
    this.flush();
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onPageHide);
  }
}
