/**
 * Profile store for the relay server (Phase 7): one `ProfileRecord` per session token (→ PeerId).
 *
 * The server never interprets the documents — they are opaque JSON the owning client folders wrote — except
 * `credits`, which the server owns so a purchase is a real transaction, and (Phase 11) `social`, which the relay
 * has to read and cross-reference to resolve a `SocialSnapshot`. Persistence is a single JSON file
 * (`<dataDir>/profiles.json`) written with a 1 s debounce and flushed on close; `dataDir: null` keeps everything in
 * memory (selftest). Erasable-TypeScript only (Node native type stripping).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreditsTxResult, ProfileDocKey, ProfileRecord } from '../src/shared/profile.ts';
import { PROFILE_CLOCK_SKEW_MS, PROFILE_DOC_KEYS, PROFILE_DOC_MAX_BYTES } from '../src/shared/profile.ts';
import type { PeerId } from '../src/shared/net.ts';
import { sanitizePlayerName } from '../src/shared/net.ts';
/* Phase 11 */
import type { PlayerCode, SocialCard, SocialErrorCode, SocialRecord } from '../src/shared/social.ts';
import {
  SOCIAL_FRIEND_MAX, SOCIAL_RECENT_MAX, SOCIAL_REQUEST_MAX, isValidPlayerCode, playerCodeFrom,
} from '../src/shared/social.ts';

export const PROFILE_FILE = 'profiles.json';
export const PROFILE_SAVE_DEBOUNCE_MS = 1000;
/** `credits:tx` reason that seeds a still-null balance with `delta` (local → server migration). */
export const CREDITS_MIGRATE_REASON = 'migrate';
export const CREDITS_REFUSED_KO = '크레딧 부족';
/** Default data directory: `server/data/` next to this file (git-ignored). */
export const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

export interface ProfileStoreOptions {
  /** Directory holding `profiles.json`. `null` = memory only. Default `server/data/`. */
  dataDir?: string | null;
  /** Debounce for file writes (ms). */
  saveDebounceMs?: number;
  quiet?: boolean;
}

interface ProfileFile { v: 1; profiles: Record<PeerId, ProfileRecord> }

const VALID_KEYS: ReadonlySet<string> = new Set(PROFILE_DOC_KEYS);
export function isProfileDocKey(k: unknown): k is ProfileDocKey {
  return typeof k === 'string' && VALID_KEYS.has(k);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Byte length of a document's JSON (`Buffer.byteLength` on the serialization). */
export function docBytes(doc: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(doc) ?? 'null', 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
}

/* ── Phase 11: social ─────────────────────────────────────────────────────── */

/** `social:me {level}` is clamped into this range before it is stored (a level is cosmetic on someone else's row). */
export const SOCIAL_LEVEL_MAX = 999;
/** How many salts `assignCode` tries before it gives up and reuses a colliding code (never reached in practice). */
export const SOCIAL_CODE_SALT_TRIES = 64;

function codeList(raw: unknown, cap: number, drop: ReadonlySet<PlayerCode>): PlayerCode[] {
  if (!Array.isArray(raw)) return [];
  const out: PlayerCode[] = [];
  const seen = new Set<PlayerCode>();
  for (const v of raw) {
    if (typeof v !== 'string' || !isValidPlayerCode(v) || seen.has(v) || drop.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Clean one stored `SocialRecord`: array caps, invalid / duplicate codes, the profile's own code and any code that is
 * already a friend are dropped from the request / recent lists. A code the index cannot place is cleared here and
 * re-assigned by `assignCode` during `load`.
 */
function sanitizeSocial(raw: unknown): SocialRecord | null {
  if (!isRecord(raw)) return null;
  const code = typeof raw.code === 'string' && isValidPlayerCode(raw.code) ? raw.code : '';
  const salt = typeof raw.salt === 'number' && Number.isFinite(raw.salt) ? Math.max(0, Math.floor(raw.salt)) : 0;
  const name = sanitizePlayerName(typeof raw.name === 'string' ? raw.name : '');
  const level = typeof raw.level === 'number' && Number.isFinite(raw.level)
    ? Math.min(SOCIAL_LEVEL_MAX, Math.max(0, Math.floor(raw.level))) : 0;
  const self = new Set<PlayerCode>(code ? [code] : []);
  const friends = codeList(raw.friends, SOCIAL_FRIEND_MAX, self);
  const notSelfOrFriend = new Set<PlayerCode>([...self, ...friends]);
  const incoming = codeList(raw.incoming, SOCIAL_REQUEST_MAX, notSelfOrFriend);
  const outgoing = codeList(raw.outgoing, SOCIAL_REQUEST_MAX, notSelfOrFriend);
  const recent: { code: PlayerCode; at: number }[] = [];
  if (Array.isArray(raw.recent)) {
    const seen = new Set<PlayerCode>();
    for (const v of raw.recent) {
      if (!isRecord(v) || typeof v.code !== 'string' || !isValidPlayerCode(v.code)) continue;
      if (seen.has(v.code) || notSelfOrFriend.has(v.code)) continue;
      seen.add(v.code);
      recent.push({ code: v.code, at: typeof v.at === 'number' && Number.isFinite(v.at) ? Math.max(0, Math.floor(v.at)) : 0 });
      if (recent.length >= SOCIAL_RECENT_MAX) break;
    }
  }
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
  return { code, salt, name, level, friends, incoming, outgoing, recent, updatedAt };
}

function sanitizeRecord(raw: unknown): ProfileRecord | null {
  if (!isRecord(raw)) return null;
  const credits = typeof raw.credits === 'number' && Number.isFinite(raw.credits) ? Math.max(0, Math.floor(raw.credits)) : null;
  const docs: Partial<Record<ProfileDocKey, unknown>> = {};
  if (isRecord(raw.docs)) {
    for (const k of PROFILE_DOC_KEYS) if (raw.docs[k] !== undefined) docs[k] = raw.docs[k];
  }
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
  const rec: ProfileRecord = { credits, docs, updatedAt };
  /* Phase 9: per-document stamps — kept only for present documents, clamped to a sane epoch-ms range. */
  if (isRecord(raw.docsAt)) {
    const docsAt: Partial<Record<ProfileDocKey, number>> = {};
    const maxAt = Date.now() + PROFILE_CLOCK_SKEW_MS;
    let any = false;
    for (const k of PROFILE_DOC_KEYS) {
      const v = raw.docsAt[k];
      if (docs[k] === undefined || typeof v !== 'number' || !Number.isFinite(v)) continue;
      docsAt[k] = Math.min(Math.max(0, Math.floor(v)), maxAt);
      any = true;
    }
    if (any) rec.docsAt = docsAt;
  }
  /* Phase 11: the social half is server-owned, so unlike `docs` it is validated field by field. */
  const social = sanitizeSocial(raw.social);
  if (social) rec.social = social;
  return rec;
}

/** Outcome of `ProfileStore.setDoc`. `'stale'` = an older stamp (or a `fresh` write over an existing document): ignored, not an error. */
export type SetDocResult = ProfileRecord | 'invalid' | 'too_large' | 'stale';

export class ProfileStore {
  private readonly profiles = new Map<PeerId, ProfileRecord>();
  /** Phase 11: `PlayerCode` → owning PeerId. Rebuilt from the file in `load`, extended by `ensureSocial`. */
  private readonly byCode = new Map<PlayerCode, PeerId>();
  private readonly file: string | null;
  private readonly debounceMs: number;
  private readonly quiet: boolean;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private writes = 0;

  constructor(opts: ProfileStoreOptions = {}) {
    const dir = opts.dataDir === undefined ? DEFAULT_DATA_DIR : opts.dataDir;
    this.file = dir === null ? null : join(dir, PROFILE_FILE);
    this.debounceMs = opts.saveDebounceMs ?? PROFILE_SAVE_DEBOUNCE_MS;
    this.quiet = opts.quiet ?? false;
    if (dir !== null) this.load(dir);
  }

  /** Number of records kept (loaded + created by a write). */
  get size(): number { return this.profiles.size; }
  /** Number of file writes performed (diagnostics / selftest). */
  get writeCount(): number { return this.writes; }
  get path(): string | null { return this.file; }

  private log(line: string): void { if (!this.quiet) console.log(`[store ${new Date().toISOString()}] ${line}`); }

  private load(dir: string): void {
    const file = this.file!;
    try {
      if (!existsSync(file)) { this.log(`no ${file} yet (fresh store)`); return; }
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.profiles)) { this.log(`${file}: unrecognized layout, starting empty`); return; }
      let n = 0;
      for (const [id, raw] of Object.entries(parsed.profiles)) {
        const rec = sanitizeRecord(raw);
        if (rec && typeof id === 'string' && id.length > 0) { this.profiles.set(id, rec); n++; }
      }
      /* Phase 11: rebuild the code → PeerId index; a duplicate / cleared code is re-derived below. */
      for (const [id, rec] of this.profiles) {
        const soc = rec.social;
        if (!soc) continue;
        if (soc.code && !this.byCode.has(soc.code)) this.byCode.set(soc.code, id);
        else soc.code = '';
      }
      for (const [id, rec] of this.profiles) {
        if (rec.social && !rec.social.code) { this.assignCode(id, rec.social); this.markDirty(); }
      }
      this.log(`loaded ${n} profiles from ${file} (${this.byCode.size} 아이디)`);
    } catch (e) {
      this.log(`failed to read ${file}: ${(e as Error).message} (starting empty)`);
    }
    void dir;
  }

  /** Record for `id`; a missing profile yields a fresh `{credits: null, docs: {}}` (not persisted until written). */
  get(id: PeerId): ProfileRecord {
    let rec = this.profiles.get(id);
    if (!rec) {
      rec = { credits: null, docs: {}, updatedAt: 0 };
      this.profiles.set(id, rec);
    }
    return rec;
  }

  has(id: PeerId): boolean { return this.profiles.has(id); }

  /** Record for `id` **without** creating one (Phase 11: a lookup by 아이디 must not mint placeholder profiles). */
  getIfExists(id: PeerId): ProfileRecord | undefined { return this.profiles.get(id); }

  /** Wire copy (documents are shared by reference — never mutated by the server). */
  snapshot(id: PeerId): ProfileRecord {
    const rec = this.get(id);
    const out: ProfileRecord = { credits: rec.credits, docs: { ...rec.docs }, updatedAt: rec.updatedAt };
    if (rec.docsAt) out.docsAt = { ...rec.docsAt };
    return out;
  }

  /**
   * Store one document. `'invalid'` for a bad key, `'too_large'` over `PROFILE_DOC_MAX_BYTES`.
   * Phase 9 (newest wins): a stamped write (`at`, the writer's server-clock estimate at save time) is clamped to
   * `now + PROFILE_CLOCK_SKEW_MS` and kept only when `at >= docsAt[key]` (absent = 0; ties accept) — otherwise
   * `'stale'` (silently ignored by the relay). A `fresh` write (or one without `at`) is a default / starter save:
   * kept only while the key is absent, never stamped (so any later stamped write beats it).
   */
  setDoc(id: PeerId, key: unknown, doc: unknown, at?: number, fresh?: boolean): SetDocResult {
    if (!isProfileDocKey(key)) return 'invalid';
    if (doc === undefined) return 'invalid';
    if (docBytes(doc) > PROFILE_DOC_MAX_BYTES) return 'too_large';
    const rec = this.get(id);
    const stamped = !fresh && typeof at === 'number' && Number.isFinite(at);
    if (!stamped) {
      if (rec.docs[key] !== undefined) return 'stale';
      rec.docs[key] = doc;
    } else {
      const t = Math.min(Math.floor(at), Date.now() + PROFILE_CLOCK_SKEW_MS);
      const cur = rec.docsAt?.[key] ?? 0;
      if (t < cur) return 'stale';
      rec.docs[key] = doc;
      if (!rec.docsAt) rec.docsAt = {};
      rec.docsAt[key] = t;
    }
    rec.updatedAt = Date.now();
    this.markDirty();
    return rec;
  }

  /**
   * Atomic credits transaction. A null balance counts as 0 — except a `'migrate'` transaction, which seeds the
   * balance with `delta` (the client's local credits) exactly once; later migrations are no-ops returning the balance.
   * A result below 0 is refused with `크레딧 부족`.
   */
  applyCredits(id: PeerId, delta: number, reason: string): CreditsTxResult {
    const rec = this.get(id);
    const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    if (reason === CREDITS_MIGRATE_REASON) {
      if (rec.credits !== null) return { ok: true, credits: rec.credits };
      rec.credits = Math.max(0, d);
      rec.updatedAt = Date.now();
      this.markDirty();
      return { ok: true, credits: rec.credits };
    }
    const cur = rec.credits ?? 0;
    const next = cur + d;
    if (next < 0) return { ok: false, credits: cur, reason: CREDITS_REFUSED_KO };
    rec.credits = next;
    rec.updatedAt = Date.now();
    this.markDirty();
    return { ok: true, credits: next };
  }

  /* ── Phase 11: social store ─────────────────────────────────────────────── */

  /** Derive a free `PlayerCode` for `id`, bumping the salt past a collision with a *different* peer id. */
  private assignCode(id: PeerId, soc: SocialRecord): PlayerCode {
    for (let salt = 0; salt < SOCIAL_CODE_SALT_TRIES; salt++) {
      const code = playerCodeFrom(id, salt);
      const owner = this.byCode.get(code);
      if (owner === undefined || owner === id) {
        soc.code = code;
        soc.salt = salt;
        this.byCode.set(code, id);
        return code;
      }
    }
    // Astronomically unlikely: keep salt 0 rather than leaving the profile without an 아이디.
    soc.code = playerCodeFrom(id, 0);
    soc.salt = 0;
    return soc.code;
  }

  /** The profile's social record, or undefined when it has none yet (never creates one). */
  social(id: PeerId): SocialRecord | undefined { return this.profiles.get(id)?.social; }

  /**
   * The social record of `id`, created on first contact with a freshly assigned 아이디. `name` (the socket's `?n=` /
   * `lobby:name`) refreshes the stored display name so an offline friend still has one.
   */
  ensureSocial(id: PeerId, name?: string): SocialRecord {
    const rec = this.get(id);
    let soc = rec.social;
    if (!soc) {
      soc = { code: '', salt: 0, name: sanitizePlayerName(name ?? ''), level: 0, friends: [], incoming: [], outgoing: [], recent: [], updatedAt: Date.now() };
      this.assignCode(id, soc);
      rec.social = soc;
      rec.updatedAt = Date.now();
      this.markDirty();
      return soc;
    }
    if (!soc.code) this.assignCode(id, soc);
    if (name !== undefined && name.length > 0) {
      const clean = sanitizePlayerName(name);
      if (clean !== soc.name) { soc.name = clean; this.touchSocial(soc); }
    }
    return soc;
  }

  /** PeerId owning this 아이디, or undefined. The reverse direction is never sent to a client. */
  peerByCode(code: PlayerCode): PeerId | undefined {
    return isValidPlayerCode(code) ? this.byCode.get(code) : undefined;
  }

  /** `{code, name, level}` of a profile that has a social record. */
  card(id: PeerId): SocialCard | null {
    const soc = this.profiles.get(id)?.social;
    return soc ? { code: soc.code, name: soc.name, level: soc.level } : null;
  }

  private touchSocial(soc: SocialRecord): void {
    soc.updatedAt = Date.now();
    this.markDirty();
  }

  /** `social:me` — the owner's own level, clamped to `0 … SOCIAL_LEVEL_MAX`. Returns true when it changed. */
  setSocialLevel(id: PeerId, level: number): boolean {
    const soc = this.ensureSocial(id);
    const v = Number.isFinite(level) ? Math.min(SOCIAL_LEVEL_MAX, Math.max(0, Math.floor(level))) : 0;
    if (soc.level === v) return false;
    soc.level = v;
    this.touchSocial(soc);
    return true;
  }

  /**
   * `social:request` — records the request on **both** records. Errors mirror the contract: `self`, `already`
   * (friends or a pending request either way) and `limit` (`SOCIAL_FRIEND_MAX` / `SOCIAL_REQUEST_MAX`).
   */
  addFriendRequest(fromId: PeerId, toId: PeerId): 'ok' | SocialErrorCode {
    if (fromId === toId) return 'self';
    const mine = this.ensureSocial(fromId);
    const theirs = this.ensureSocial(toId);
    if (mine.friends.includes(theirs.code) || theirs.friends.includes(mine.code)) return 'already';
    if (mine.outgoing.includes(theirs.code) || theirs.incoming.includes(mine.code)) return 'already';
    if (mine.incoming.includes(theirs.code) || theirs.outgoing.includes(mine.code)) return 'already';
    if (mine.friends.length >= SOCIAL_FRIEND_MAX || theirs.friends.length >= SOCIAL_FRIEND_MAX) return 'limit';
    if (mine.outgoing.length >= SOCIAL_REQUEST_MAX || theirs.incoming.length >= SOCIAL_REQUEST_MAX) return 'limit';
    mine.outgoing.unshift(theirs.code);
    theirs.incoming.unshift(mine.code);
    this.touchSocial(mine);
    this.touchSocial(theirs);
    return 'ok';
  }

  /**
   * `social:respond` — the request must sit in my `incoming` (`invalid` otherwise). Accepting adds both sides to
   * `friends` and drops them from both `recent` lists; declining only deletes the request.
   */
  respondFriendRequest(meId: PeerId, otherId: PeerId, accept: boolean): 'ok' | SocialErrorCode {
    const mine = this.ensureSocial(meId);
    const theirs = this.ensureSocial(otherId);
    if (!mine.incoming.includes(theirs.code)) return 'invalid';
    if (accept && (mine.friends.length >= SOCIAL_FRIEND_MAX || theirs.friends.length >= SOCIAL_FRIEND_MAX)) return 'limit';
    mine.incoming = mine.incoming.filter((c) => c !== theirs.code);
    theirs.outgoing = theirs.outgoing.filter((c) => c !== mine.code);
    if (accept) {
      if (!mine.friends.includes(theirs.code)) mine.friends.unshift(theirs.code);
      if (!theirs.friends.includes(mine.code)) theirs.friends.unshift(mine.code);
      mine.recent = mine.recent.filter((r) => r.code !== theirs.code);
      theirs.recent = theirs.recent.filter((r) => r.code !== mine.code);
    }
    this.touchSocial(mine);
    this.touchSocial(theirs);
    return 'ok';
  }

  /** `social:remove` — mutual. `invalid` when we are not friends. */
  removeFriend(meId: PeerId, otherId: PeerId): 'ok' | SocialErrorCode {
    const mine = this.ensureSocial(meId);
    const theirs = this.ensureSocial(otherId);
    if (!mine.friends.includes(theirs.code) && !theirs.friends.includes(mine.code)) return 'invalid';
    mine.friends = mine.friends.filter((c) => c !== theirs.code);
    theirs.friends = theirs.friends.filter((c) => c !== mine.code);
    this.touchSocial(mine);
    this.touchSocial(theirs);
    return 'ok';
  }

  /**
   * 최근 만난 플레이어: two profiles shared a ship. Written newest-first on both records, skipped for friends, and
   * trimmed to `SOCIAL_RECENT_MAX` (oldest first). Returns true when either record changed.
   */
  recordMet(aId: PeerId, bId: PeerId, at: number = Date.now()): boolean {
    if (aId === bId) return false;
    const a = this.social(aId);
    const b = this.social(bId);
    if (!a || !b || !a.code || !b.code) return false;
    let changed = false;
    const push = (rec: SocialRecord, code: PlayerCode): void => {
      if (rec.friends.includes(code)) return;
      rec.recent = rec.recent.filter((r) => r.code !== code);
      rec.recent.unshift({ code, at });
      if (rec.recent.length > SOCIAL_RECENT_MAX) rec.recent.length = SOCIAL_RECENT_MAX;
      this.touchSocial(rec);
      changed = true;
    };
    push(a, b.code);
    push(b, a.code);
    return changed;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.file === null || this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, this.debounceMs);
    this.saveTimer.unref();
  }

  /** Write now when dirty (also called on server close). Synchronous so a shutdown cannot lose the last write. */
  flush(): void {
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.dirty || this.file === null) { this.dirty = false; return; }
    this.dirty = false;
    const out: ProfileFile = { v: 1, profiles: {} };
    for (const [id, rec] of this.profiles) {
      // Never persist untouched placeholder records (a social record counts as content: it holds the 아이디).
      if (rec.credits === null && rec.updatedAt === 0 && Object.keys(rec.docs).length === 0 && !rec.social) continue;
      out.profiles[id] = rec;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(out), 'utf8');
      renameSync(tmp, this.file);
      this.writes++;
    } catch (e) {
      this.dirty = true; // retry on the next write / flush
      this.log(`failed to write ${this.file}: ${(e as Error).message}`);
    }
  }

  close(): void { this.flush(); }
}
