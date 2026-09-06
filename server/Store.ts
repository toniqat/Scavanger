/**
 * Profile store for the relay server (Phase 7): one `ProfileRecord` per session token (→ PeerId).
 *
 * The server never interprets the documents — they are opaque JSON the owning client folders wrote — except
 * `credits`, which the server owns so a purchase is a real transaction. Persistence is a single JSON file
 * (`<dataDir>/profiles.json`) written with a 1 s debounce and flushed on close; `dataDir: null` keeps everything in
 * memory (selftest). Erasable-TypeScript only (Node native type stripping).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreditsTxResult, ProfileDocKey, ProfileRecord } from '../src/shared/profile.ts';
import { PROFILE_DOC_KEYS, PROFILE_DOC_MAX_BYTES } from '../src/shared/profile.ts';
import type { PeerId } from '../src/shared/net.ts';

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

function sanitizeRecord(raw: unknown): ProfileRecord | null {
  if (!isRecord(raw)) return null;
  const credits = typeof raw.credits === 'number' && Number.isFinite(raw.credits) ? Math.max(0, Math.floor(raw.credits)) : null;
  const docs: Partial<Record<ProfileDocKey, unknown>> = {};
  if (isRecord(raw.docs)) {
    for (const k of PROFILE_DOC_KEYS) if (raw.docs[k] !== undefined) docs[k] = raw.docs[k];
  }
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
  return { credits, docs, updatedAt };
}

export class ProfileStore {
  private readonly profiles = new Map<PeerId, ProfileRecord>();
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
      this.log(`loaded ${n} profiles from ${file}`);
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

  /** Wire copy (documents are shared by reference — never mutated by the server). */
  snapshot(id: PeerId): ProfileRecord {
    const rec = this.get(id);
    return { credits: rec.credits, docs: { ...rec.docs }, updatedAt: rec.updatedAt };
  }

  /** Store one document. `'invalid'` for a bad key, `'too_large'` over `PROFILE_DOC_MAX_BYTES`. */
  setDoc(id: PeerId, key: unknown, doc: unknown): ProfileRecord | 'invalid' | 'too_large' {
    if (!isProfileDocKey(key)) return 'invalid';
    if (doc === undefined) return 'invalid';
    if (docBytes(doc) > PROFILE_DOC_MAX_BYTES) return 'too_large';
    const rec = this.get(id);
    rec.docs[key] = doc;
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
      // Never persist untouched placeholder records.
      if (rec.credits === null && rec.updatedAt === 0 && Object.keys(rec.docs).length === 0) continue;
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
