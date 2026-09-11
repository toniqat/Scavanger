import type { ClientToServer, CreditsTxResult, EventBus, LobbyErrorCode, ProfileDocKey, ProfileRecord, ProfileRef, ServerToClient } from '@/shared';
import { PROFILE_DOC_KEYS, PROFILE_DOC_MAX_BYTES, PROFILE_SYNC_DEBOUNCE_MS } from '@/shared';

/** A credits transaction that got no `credits:result` within this long is rejected (socket alive but server stuck). */
const TX_TIMEOUT_MS = 10_000;
/** Version of the persisted write queue (`PROFILE_QUEUE_STORAGE_KEY`). Another version is ignored (starts empty). */
const QUEUE_FILE_VERSION = 1;

interface PendingTx { resolve: (r: CreditsTxResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
/**
 * One queued document. `baseRev` = the server rev this local copy was made on top of (E-6); `at` = `serverNow()` when it
 * was queued — only used against a relay that does not speak revisions (Phase 9 stamp) — null for a `fresh` default.
 */
interface QueuedDoc { doc: unknown; baseRev: number; at: number | null }
/** One write: a single `profile:set {baseRev, writeId: id}` or, with 2+ keys, one `profile:setMany {txId: id}`. */
interface QueuedWrite { id: string; docs: Partial<Record<ProfileDocKey, QueuedDoc>> }
/** The persisted queue (`slotKey(PROFILE_QUEUE_STORAGE_KEY)`): known revs + unsent writes + sent-but-unanswered writes. */
interface QueueFile { v: number; revs: Partial<Record<ProfileDocKey, number>>; pending: QueuedWrite[]; inflight: QueuedWrite[] }

type AckMsg = Extract<ServerToClient, { t: 'profile:ack' }>;
type ConflictMsg = Extract<ServerToClient, { t: 'profile:conflict' }>;
type RefusedMsg = Extract<ServerToClient, { t: 'profile:refused' }>;

const DOC_KEYS: ReadonlySet<string> = new Set(PROFILE_DOC_KEYS);
const isDocKey = (k: unknown): k is ProfileDocKey => typeof k === 'string' && DOC_KEYS.has(k);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysOf = (w: QueuedWrite): ProfileDocKey[] => Object.keys(w.docs).filter(isDocKey);
const revNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function sameDoc(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** A write id (`writeId` / `txId`): unique enough per browser profile, ≤ 64 characters (the relay's cap). */
function newWriteId(): string {
  let rnd = '';
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    rnd = a[0].toString(36) + a[1].toString(36);
  } catch { rnd = Math.random().toString(36).slice(2, 14); }
  return `${Date.now().toString(36)}-${rnd}`;
}

/** Sanitise one stored write; null when nothing usable is left. */
function readWrite(raw: unknown): QueuedWrite | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 64 || !isObj(raw.docs)) return null;
  const docs: Partial<Record<ProfileDocKey, QueuedDoc>> = {};
  let any = false;
  for (const [k, e] of Object.entries(raw.docs)) {
    if (!isDocKey(k) || !isObj(e) || e.doc === undefined) continue;
    const at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : null;
    docs[k] = { doc: e.doc, baseRev: revNum(e.baseRev), at };
    any = true;
  }
  return any ? { id: raw.id, docs } : null;
}

/**
 * `ctx.net.profile` (Phase 7): client mirror of the server profile record + queued document uploads + credits
 * transactions matched by `txId`. Owned by NetSystem, which feeds it the socket events:
 *   - `onWelcome(profile)`  → `available`, `credits`, `docs`; emits `net:profileLoaded {migrated}` (`migrated` =
 *     the server has no balance yet → meta/ uploads its local credits with `addCredits(local, 'migrate')`).
 *   - `onDocs(profile)`     → reply to `profile:get`.
 *   - `onAck` / `onConflict` / `onRefused` (E-6) → the answer to one queued write.
 *   - `onCreditsResult(m)`  → settles the matching `addCredits` promise and mirrors the authoritative balance.
 *   - `onDisconnected()`    → `available=false`; pending transactions reject; queued documents survive.
 *   - `onError(code)`       → (Phase 9 relay) `too_large` after an upload evicts the keys of the last flush.
 * Documents are opaque: the owning folder decides the shape and keeps localStorage as its offline copy.
 *
 * **2026-09-11 (E-6) — revisions, not clocks.** A token is one browser profile, so a profile has one writer; the
 * question is never "whose clock is later" but "was this written on top of the copy I last saw". Every queued document
 * carries `baseRev` (the server's `docsRev[key]` the local copy is based on) and goes up as `profile:set {baseRev,
 * writeId}` — or, when one edit spans documents (`setMany`), as **one** `profile:setMany {txId}` stored all or nothing.
 *   - The queue is **persisted** (`useStorage` → `slotKey(PROFILE_QUEUE_STORAGE_KEY)`) and a write leaves it only on
 *     `profile:ack` / `profile:refused` / a conflict resolved in the server's favour — a reload, a crash or a whole
 *     offline session no longer loses the upload.
 *   - Per key at most one write is in flight; a newer local edit waits (its base is the in-flight write's rev + 1).
 *   - At `welcome` / `profile:docs`: a queued write whose `baseRev` equals the server rev **wins** (offline progress is
 *     kept: the mirror shows the local document, `net:profileLoaded` hands it to the folders, and it is sent); a server
 *     rev above it means another session wrote meanwhile → **the server wins** (the write is dropped, console warning +
 *     `net:profileConflict {keys}` before `net:profileLoaded`). A sent write the server already stored (rev = base + 1,
 *     same document — the ack was lost) is simply settled. A server rev *below* the base (restored backup) → local wins,
 *     rebased. A `fresh` default loses silently to any server document.
 *   - A `profile:conflict` while connected: server wins the same way, then `profile:get` re-announces the record.
 * A relay without revisions (its `welcome.profile` has no `docsRev`) keeps the **Phase 9** rules exactly: stamped
 * `profile:set {at}` / `{fresh}` frames, newest stamp wins at welcome, a write leaves the queue once it is sent.
 */
export class ProfileSync implements ProfileRef {
  private _available = false;
  private _credits: number | null = null;
  private docs: Partial<Record<ProfileDocKey, unknown>> = {};
  /** Server-side stamps of the mirrored documents (Phase 9). */
  private docsAt: Partial<Record<ProfileDocKey, number>> = {};
  /** E-6: the server rev each local copy is based on (persisted). */
  private revs: Partial<Record<ProfileDocKey, number>> = {};
  /** E-6: the last record came from a relay that speaks revisions (`docsRev` present). */
  private revMode = false;
  /** Writes not sent yet (each key in at most one of them), oldest first. */
  private pending: QueuedWrite[] = [];
  /** E-6: writes sent and not answered yet (each key in at most one of them). */
  private inflight: QueuedWrite[] = [];
  /** Keys of the last Phase 9 flush, for `too_large` eviction. */
  private lastSent: ProfileDocKey[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly txs = new Map<number, PendingTx>();
  private nextTxId = 1;
  private updatedAt = 0;
  /** E-6: localStorage key of the persisted queue; null = memory only (tests). */
  private storageKey: string | null = null;
  /** E-6: a `profile:get` after a conflict is on its way. */
  private resyncing = false;

  /** Wired by NetSystem: sends a frame when the socket is up (returns false otherwise). */
  send: (msg: ClientToServer) => boolean = () => false;
  /** Wired by NetSystem: `NetRef.serverNow()` (keeps the last server offset while offline). */
  serverNow: () => number = () => Date.now();
  bus: EventBus | null = null;

  constructor() {
    try {
      // The debounce must not lose the last save of a closing tab.
      window.addEventListener('pagehide', () => { this.flush(); this.persist(); });
    } catch { /* no window (tests) */ }
  }

  get available(): boolean { return this._available; }
  get credits(): number | null { return this._credits; }
  /** Last record as the server sent it, with the queued local documents over it (for the terminal / debugging). */
  get record(): ProfileRecord {
    const rec: ProfileRecord = { credits: this._credits, docs: { ...this.docs }, updatedAt: this.updatedAt };
    if (Object.keys(this.docsAt).length > 0) rec.docsAt = { ...this.docsAt };
    if (this.revMode) rec.docsRev = { ...this.revs };
    return rec;
  }
  /** Keys waiting for an upload or its answer (offline queue / debounce / in flight), for diagnostics and smokes. */
  get pendingKeys(): ProfileDocKey[] {
    const out = new Set<ProfileDocKey>();
    for (const w of [...this.inflight, ...this.pending]) for (const k of keysOf(w)) out.add(k);
    return Array.from(out);
  }
  /** E-6 diagnostics (smokes): revision mode, known revs and the queue, as plain JSON. */
  get queueState(): { revMode: boolean; revs: Partial<Record<ProfileDocKey, number>>; pending: { id: string; keys: ProfileDocKey[] }[]; inflight: { id: string; keys: ProfileDocKey[] }[] } {
    return {
      revMode: this.revMode, revs: { ...this.revs },
      pending: this.pending.map((w) => ({ id: w.id, keys: keysOf(w) })),
      inflight: this.inflight.map((w) => ({ id: w.id, keys: keysOf(w) })),
    };
  }

  get(key: ProfileDocKey): unknown | undefined {
    return this.docs[key];
  }

  revOf(key: ProfileDocKey): number { return this.revs[key] ?? 0; }

  /**
   * E-6: persist the queue under `key` (NetSystem passes `slotKey(PROFILE_QUEUE_STORAGE_KEY)` at init, before any
   * folder saves) and load what an earlier page left there. null = memory only.
   */
  useStorage(key: string | null): void {
    this.storageKey = key;
    if (key === null) return;
    let file: QueueFile | null = null;
    try {
      const raw = window.localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (isObj(parsed) && parsed.v === QUEUE_FILE_VERSION) {
        const revs: Partial<Record<ProfileDocKey, number>> = {};
        if (isObj(parsed.revs)) for (const [k, v] of Object.entries(parsed.revs)) if (isDocKey(k) && revNum(v) > 0) revs[k] = revNum(v);
        const list = (v: unknown): QueuedWrite[] => (Array.isArray(v) ? v.map(readWrite).filter((w): w is QueuedWrite => w !== null) : []);
        file = { v: QUEUE_FILE_VERSION, revs, pending: list(parsed.pending), inflight: list(parsed.inflight) };
      }
    } catch { file = null; }
    if (file) {
      // Whatever was queued in memory before this call (nothing, in the game) is newer than the stored queue.
      const memPending = this.pending;
      this.revs = { ...file.revs, ...this.revs };
      this.inflight = [...file.inflight, ...this.inflight];
      this.pending = file.pending;
      const seen = new Set<ProfileDocKey>();
      this.inflight = this.inflight.filter((w) => { const ks = keysOf(w); if (ks.some((k) => seen.has(k))) return false; ks.forEach((k) => seen.add(k)); return true; });
      for (const w of this.pending) for (const k of keysOf(w)) this.docs[k] = w.docs[k]!.doc;
      for (const w of this.inflight) for (const k of keysOf(w)) if (!this.pendingOf(k)) this.docs[k] = w.docs[k]!.doc;
      for (const w of memPending) for (const k of keysOf(w)) { const e = w.docs[k]!; this.enqueue(k, e.doc, e.at === null); }
    }
    this.persist();
  }

  set(key: ProfileDocKey, doc: unknown, opts?: { fresh?: boolean }): void {
    if (!isDocKey(key)) return;
    if (!ProfileSync.fits(doc)) { console.warn(`[net] profile doc '${key}' exceeds ${PROFILE_DOC_MAX_BYTES} bytes; not uploaded`); return; }
    this.enqueue(key, doc, !!opts?.fresh);
    this.persist();
    this.scheduleFlush();
  }

  /**
   * E-6: one edit spanning documents → **one** transaction. Keys whose document equals the mirror and that have nothing
   * queued are skipped (nothing to write); a single remaining key is an ordinary `set`. Every queued write touching one
   * of the keys is merged into the transaction (a newer document for a key replaces the queued one, its base stays).
   */
  setMany(docs: Partial<Record<ProfileDocKey, unknown>>): void {
    const changed: [ProfileDocKey, unknown][] = [];
    for (const [k, doc] of Object.entries(docs)) {
      if (!isDocKey(k) || doc === undefined) continue;
      if (!ProfileSync.fits(doc)) { console.warn(`[net] profile doc '${k}' exceeds ${PROFILE_DOC_MAX_BYTES} bytes; not uploaded`); return; }
      if (!this.pendingOf(k) && !this.inflightOf(k) && this.docs[k] !== undefined && sameDoc(this.docs[k], doc)) continue;
      changed.push([k, doc]);
    }
    if (changed.length === 0) return;
    if (changed.length === 1) { this.set(changed[0][0], changed[0][1]); return; }
    const keys = new Set(changed.map(([k]) => k));
    const touching = this.pending.filter((w) => keysOf(w).some((k) => keys.has(k)));
    this.pending = this.pending.filter((w) => !touching.includes(w));
    const merged: QueuedWrite = { id: newWriteId(), docs: {} };
    for (const w of touching) for (const k of keysOf(w)) merged.docs[k] = w.docs[k];
    const now = this.serverNow();
    for (const [k, doc] of changed) {
      const prev = merged.docs[k];
      merged.docs[k] = { doc, baseRev: prev ? prev.baseRev : this.expectedBase(k), at: now };
      this.docs[k] = doc;
    }
    this.pending.push(merged);
    this.persist();
    this.scheduleFlush();
  }

  flush(): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this._available || this.pending.length + this.inflight.length === 0) return;
    if (!this.revMode) { this.flushLegacy(); return; }
    for (const w of [...this.pending]) {
      const keys = keysOf(w);
      if (keys.length === 0) { this.pending = this.pending.filter((x) => x !== w); continue; }
      if (keys.some((k) => this.inflightOf(k))) continue;   // one write per key in flight; this one waits for the answer
      if (!this.send(ProfileSync.frameOf(w))) break;   // socket down: everything stays queued for the next welcome
      this.pending = this.pending.filter((x) => x !== w);
      this.inflight.push(w);
    }
    this.persist();
  }

  addCredits(delta: number, reason: string): Promise<CreditsTxResult> {
    const txId = this.nextTxId++;
    const d = Math.trunc(delta);
    return new Promise<CreditsTxResult>((resolve, reject) => {
      if (!this._available || !this.send({ t: 'credits:tx', txId, delta: d, reason: reason.slice(0, 64) })) {
        reject(new Error('오프라인'));
        return;
      }
      const timer = setTimeout(() => {
        this.txs.delete(txId);
        reject(new Error('서버 응답 없음'));
      }, TX_TIMEOUT_MS);
      this.txs.set(txId, { resolve, reject, timer });
    });
  }

  /* ── fed by NetSystem ── */
  /** `emit` false = seamless mid-mission resume: refresh availability / credits, but do not re-announce the documents. */
  onWelcome(profile: ProfileRecord | undefined, emit = true): void {
    if (!profile) { this.onDisconnected(); return; }
    const { migrated, conflicts } = this.applyRecord(profile);
    if (conflicts.length > 0) this.reportConflict(conflicts);
    this.resendInflight();
    this.flush();
    if (emit) this.bus?.emit('net:profileLoaded', { profile: this.record, migrated });
  }

  onDocs(profile: ProfileRecord): void {
    const { migrated, conflicts } = this.applyRecord(profile);
    if (conflicts.length > 0) this.reportConflict(conflicts);
    this.flush();
    this.bus?.emit('net:profileLoaded', { profile: this.record, migrated });
  }

  /** E-6: a write was stored — its revs become the base of the local copies, and writes waiting on it may go. */
  onAck(m: AckMsg): void {
    const w = this.takeInflight(m.writeId ?? m.txId);
    if (!w) return;
    for (const k of keysOf(w)) {
      const r = m.revs?.[k];
      const next = typeof r === 'number' && Number.isFinite(r) ? r : w.docs[k]!.baseRev + 1;
      this.revs[k] = Math.max(this.revs[k] ?? 0, next);
    }
    this.persist();
    if (this.pending.length > 0 && this.flushTimer === null) this.flush();
  }

  /**
   * E-6: a write was made on a stale rev and nothing was stored. **The server wins** (user decision): the write and every
   * queued edit built on it are dropped, `net:profileConflict` + a console warning go out, and `profile:get` re-announces
   * the record (`net:profileLoaded`). Exception: every listed rev is *below* the base (the server lost data) → the write
   * is re-queued and rebased by that same reload.
   */
  onConflict(m: ConflictMsg): void {
    const w = this.takeInflight(m.writeId ?? m.txId);
    if (!w) return;
    const keys = keysOf(w);
    const listed = Object.entries(m.docs ?? {}).filter(([k, row]) => isDocKey(k) && isObj(row)) as [ProfileDocKey, { rev: number; doc: unknown }][];
    const behind = listed.length > 0 && listed.every(([k, row]) => revNum(row.rev) < (w.docs[k]?.baseRev ?? 0));
    if (behind) {
      for (const k of keys) if (this.pendingOf(k)) delete w.docs[k];   // a newer queued edit supersedes it
      if (keysOf(w).length > 0) this.pending.unshift(w);
    } else {
      const lost = new Set<ProfileDocKey>(keys);
      this.pending = this.pending.filter((p) => {
        if (!keysOf(p).some((k) => lost.has(k))) return true;
        keysOf(p).forEach((k) => lost.add(k));
        return false;
      });
      this.reportConflict(Array.from(lost));
    }
    this.persist();
    this.resync();
  }

  /** E-6: the write can never succeed as sent (too large · bad key) — dropped, never retried. */
  onRefused(m: RefusedMsg): void {
    const w = this.takeInflight(m.writeId ?? m.txId);
    if (!w) return;
    console.warn(`[net] server refused profile doc(s) ${keysOf(w).join(', ')} (${m.code}); not retried`);
    this.persist();
    if (this.pending.length > 0 && this.flushTimer === null) this.flush();
  }

  onCreditsResult(m: Extract<ServerToClient, { t: 'credits:result' }>): void {
    if (typeof m.credits === 'number' && Number.isFinite(m.credits)) this._credits = m.credits;
    const tx = this.txs.get(m.txId);
    if (!tx) return;
    this.txs.delete(m.txId);
    clearTimeout(tx.timer);
    tx.resolve(m.reason !== undefined ? { ok: m.ok, credits: m.credits, reason: m.reason } : { ok: m.ok, credits: m.credits });
  }

  /** A `lobby:error` arrived: (Phase 9 relay) `too_large` right after an upload drops those keys from the queue. */
  onError(code: LobbyErrorCode): void {
    if (code !== 'too_large' || this.lastSent.length === 0) return;
    const drop = new Set(this.lastSent);
    for (const w of this.pending) for (const k of keysOf(w)) if (drop.has(k)) delete w.docs[k];
    this.pending = this.pending.filter((w) => keysOf(w).length > 0);
    console.warn(`[net] server refused profile doc(s) ${this.lastSent.join(', ')} as too large; not retried`);
    this.lastSent = [];
    this.persist();
    if (this.pending.length === 0 && this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
  }

  onDisconnected(): void {
    this._available = false;
    this._credits = null;
    this.resyncing = false;
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    for (const tx of this.txs.values()) { clearTimeout(tx.timer); tx.reject(new Error('연결 끊김')); }
    this.txs.clear();
  }

  static fits(doc: unknown): boolean {
    try {
      const text = JSON.stringify(doc);
      if (text === undefined) return false;
      // UTF-16 length is a lower bound of the UTF-8 byte count; measure exactly only when it could matter.
      if (text.length * 3 <= PROFILE_DOC_MAX_BYTES) return true;
      return new TextEncoder().encode(text).byteLength <= PROFILE_DOC_MAX_BYTES;
    } catch { return false; }
  }

  /* ── internals ── */

  /** The wire frame of a queued write: `profile:set {baseRev, writeId}` for one key, `profile:setMany {txId}` for more. */
  private static frameOf(w: QueuedWrite): ClientToServer {
    const keys = keysOf(w);
    if (keys.length === 1) {
      const e = w.docs[keys[0]]!;
      return { t: 'profile:set', key: keys[0], doc: e.doc, baseRev: e.baseRev, writeId: w.id };
    }
    const docs: Partial<Record<ProfileDocKey, { doc: unknown; baseRev: number }>> = {};
    for (const k of keys) docs[k] = { doc: w.docs[k]!.doc, baseRev: w.docs[k]!.baseRev };
    return { t: 'profile:setMany', txId: w.id, docs };
  }

  /**
   * E-6, new connection only: a write sent on the previous connection that the welcome copy shows as still valid goes up
   * again with the **same id** — the relay acks a replay of an id it already stored, and stores it once otherwise.
   */
  private resendInflight(): void {
    if (!this.revMode || !this._available) return;
    for (const w of this.inflight) if (!this.send(ProfileSync.frameOf(w))) return;
  }

  private pendingOf(key: ProfileDocKey): QueuedWrite | undefined { return this.pending.find((w) => w.docs[key] !== undefined); }
  private inflightOf(key: ProfileDocKey): QueuedWrite | undefined { return this.inflight.find((w) => w.docs[key] !== undefined); }

  /** The rev a new local edit of `key` is based on: the in-flight write's rev-to-be, else the known server rev. */
  private expectedBase(key: ProfileDocKey): number {
    const w = this.inflightOf(key);
    return w ? w.docs[key]!.baseRev + 1 : (this.revs[key] ?? 0);
  }

  private takeInflight(id: string | undefined): QueuedWrite | undefined {
    if (id === undefined) return undefined;
    const i = this.inflight.findIndex((w) => w.id === id);
    return i < 0 ? undefined : this.inflight.splice(i, 1)[0];
  }

  /**
   * Queue one document. A queued (unsent) write for the key is updated in place — it keeps its base and its
   * transaction. A `fresh` default is dropped when the server (as last seen) already has a document for the key.
   */
  private enqueue(key: ProfileDocKey, doc: unknown, fresh: boolean): void {
    const now = this.serverNow();
    const queued = this.pendingOf(key);
    if (queued) {
      const e = queued.docs[key]!;
      e.doc = doc;
      if (!fresh) e.at = now;
    } else {
      const busy = this.inflightOf(key) !== undefined;
      if (fresh && !busy && (this.revs[key] ?? 0) > 0) return;   // a default never beats a real server document
      this.pending.push({ id: newWriteId(), docs: { [key]: { doc, baseRev: this.expectedBase(key), at: fresh && !busy ? null : now } } });
    }
    this.docs[key] = doc;
  }

  private scheduleFlush(): void {
    if (this._available && this.flushTimer === null) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, PROFILE_SYNC_DEBOUNCE_MS);
    }
  }

  /** Phase 9 relay: every queued document goes up as a stamped (`at`) or `fresh` frame and leaves the queue once sent. */
  private flushLegacy(): void {
    this.lastSent = [];
    for (const list of [this.inflight, this.pending]) {
      for (const w of [...list]) {
        for (const k of keysOf(w)) {
          const e = w.docs[k]!;
          const msg: ClientToServer = e.at === null
            ? { t: 'profile:set', key: k, doc: e.doc, fresh: true }
            : { t: 'profile:set', key: k, doc: e.doc, at: e.at };
          if (!this.send(msg)) { this.persist(); return; }   // socket down: keep the rest for the next welcome
          delete w.docs[k];
          this.lastSent.push(k);
          if (e.at !== null) this.docsAt[k] = e.at;
        }
        list.splice(list.indexOf(w), 1);
      }
    }
    this.persist();
  }

  /**
   * Mirror a server record and weigh the queue against it. Returns `migrated` (server credits still null) and the keys
   * whose queued edits lost to the server copy (E-6 conflicts; a `fresh` default losing is not one).
   */
  private applyRecord(profile: ProfileRecord): { migrated: boolean; conflicts: ProfileDocKey[] } {
    const migrated = profile.credits === null;
    this._available = true;
    this._credits = profile.credits;
    this.updatedAt = profile.updatedAt;
    this.resyncing = false;
    const serverDocs: Partial<Record<ProfileDocKey, unknown>> = isObj(profile.docs) ? profile.docs : {};
    this.docs = { ...serverDocs };
    this.docsAt = { ...(profile.docsAt ?? {}) };
    this.revMode = isObj(profile.docsRev);
    const conflicts = new Set<ProfileDocKey>();

    if (!this.revMode) {
      /* Phase 9 relay: newest stamp per key wins; a pending `fresh` document only while the server has none. */
      const newest = new Map<ProfileDocKey, QueuedDoc>();
      for (const w of [...this.inflight, ...this.pending]) for (const k of keysOf(w)) newest.set(k, w.docs[k]!);
      this.inflight = [];
      this.pending = [];
      for (const [k, e] of newest) {
        const loses = e.at === null ? serverDocs[k] !== undefined : e.at < (this.docsAt[k] ?? 0);
        if (loses) continue;
        this.docs[k] = e.doc;
        this.pending.push({ id: newWriteId(), docs: { [k]: e } });
      }
      this.persist();
      return { migrated, conflicts: [] };
    }

    const S = profile.docsRev as Partial<Record<ProfileDocKey, number>>;
    const sRev = (k: ProfileDocKey): number => revNum(S[k]);
    /* ① sent writes: still valid (resend, same id) · already stored (settle) · server behind (requeue) · conflict */
    const validInflight = new Set<ProfileDocKey>();
    const deadKeys = new Set<ProfileDocKey>();
    const keep: QueuedWrite[] = [];
    const requeue: QueuedWrite[] = [];
    for (const w of this.inflight) {
      const ks = keysOf(w);
      if (ks.every((k) => sRev(k) === w.docs[k]!.baseRev)) { keep.push(w); ks.forEach((k) => validInflight.add(k)); continue; }
      if (ks.every((k) => sRev(k) === w.docs[k]!.baseRev + 1 && sameDoc(serverDocs[k], w.docs[k]!.doc))) continue;   // the ack was lost
      if (ks.every((k) => sRev(k) < w.docs[k]!.baseRev)) { requeue.push(w); continue; }
      ks.forEach((k) => { deadKeys.add(k); conflicts.add(k); });
    }
    this.inflight = keep;
    /* ② unsent writes (a requeued sent write is older than any unsent edit of the same key, which supersedes it) */
    const unsentKeys = new Set(this.pending.flatMap(keysOf));
    for (const w of requeue) for (const k of keysOf(w)) if (unsentKeys.has(k)) delete w.docs[k];
    const all = [...requeue.filter((w) => keysOf(w).length > 0), ...this.pending];
    this.pending = [];
    for (const w of all) {
      const ks = keysOf(w);
      const eff = (k: ProfileDocKey): number => sRev(k) + (validInflight.has(k) ? 1 : 0);
      if (ks.length === 1 && w.docs[ks[0]]!.at === null && serverDocs[ks[0]] !== undefined && !validInflight.has(ks[0])) continue;   // fresh default loses silently
      if (ks.some((k) => deadKeys.has(k) || eff(k) > w.docs[k]!.baseRev)) { ks.forEach((k) => { deadKeys.add(k); conflicts.add(k); }); continue; }
      for (const k of ks) w.docs[k]!.baseRev = eff(k);
      this.pending.push(w);
    }
    /* ③ the mirror shows what will be true once the queue lands */
    for (const w of this.inflight) for (const k of keysOf(w)) this.docs[k] = w.docs[k]!.doc;
    for (const w of this.pending) for (const k of keysOf(w)) this.docs[k] = w.docs[k]!.doc;
    this.revs = {};
    for (const k of PROFILE_DOC_KEYS) if (sRev(k) > 0) this.revs[k] = sRev(k);
    this.persist();
    return { migrated, conflicts: Array.from(conflicts) };
  }

  private reportConflict(keys: ProfileDocKey[]): void {
    if (keys.length === 0) return;
    console.warn(`[net] profile: the server copy of ${keys.join(', ')} was newer than local edits — local edits discarded (server wins)`);
    this.bus?.emit('net:profileConflict', { keys });
  }

  /** After a conflict: fetch the whole record once (`profile:docs` → `onDocs` → `net:profileLoaded`). */
  private resync(): void {
    if (this.resyncing) return;
    if (this.send({ t: 'profile:get' })) this.resyncing = true;
  }

  private persist(): void {
    const key = this.storageKey;
    if (key === null) return;
    try {
      const empty = this.pending.length === 0 && this.inflight.length === 0 && Object.keys(this.revs).length === 0;
      if (empty) { window.localStorage.removeItem(key); return; }
      const file: QueueFile = { v: QUEUE_FILE_VERSION, revs: this.revs, pending: this.pending, inflight: this.inflight };
      window.localStorage.setItem(key, JSON.stringify(file));
    } catch { /* quota / private mode: the queue still lives in memory */ }
  }
}
