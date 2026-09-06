import type { ClientToServer, CreditsTxResult, EventBus, LobbyErrorCode, ProfileDocKey, ProfileRecord, ProfileRef, ServerToClient } from '@/shared';
import { PROFILE_DOC_KEYS, PROFILE_DOC_MAX_BYTES, PROFILE_SYNC_DEBOUNCE_MS } from '@/shared';

/** A credits transaction that got no `credits:result` within this long is rejected (socket alive but server stuck). */
const TX_TIMEOUT_MS = 10_000;

interface PendingTx { resolve: (r: CreditsTxResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
/** A queued upload: `at` = `serverNow()` when `set` was called, null for a `fresh` (default / starter) save. */
interface PendingDoc { doc: unknown; at: number | null }

/**
 * `ctx.net.profile` (Phase 7): client mirror of the server profile record + debounced document uploads + credits
 * transactions matched by `txId`. Owned by NetSystem, which feeds it the socket events:
 *   - `onWelcome(profile)`  → `available`, `credits`, `docs`; emits `net:profileLoaded {migrated}` (`migrated` =
 *     the server has no balance yet → meta/ uploads its local credits with `addCredits(local, 'migrate')`).
 *   - `onDocs(profile)`     → reply to `profile:get`.
 *   - `onCreditsResult(m)`  → settles the matching `addCredits` promise and mirrors the authoritative balance.
 *   - `onDisconnected()`    → `available=false`; pending transactions reject; queued documents survive.
 *   - `onError(code)`       → `too_large` after an upload evicts the keys of the last flush (never retried forever).
 * Documents are opaque: the owning folder decides the shape and keeps localStorage as its offline copy.
 *
 * Phase 9 (newest wins): `set` is **never dropped**. Every call lands in the pending map stamped with `serverNow()`
 * (`fresh` saves carry no stamp) and is uploaded as `profile:set {key, doc, at | fresh}`; the debounce only runs while
 * a connection is up, otherwise the queue waits for the next `welcome`. At `welcome` / `profile:docs` a pending
 * document older than the server's `docsAt[key]` is discarded in favour of the server copy; a pending `fresh` document
 * loses to any server document. Everything else overlays the mirror and goes up at once.
 */
export class ProfileSync implements ProfileRef {
  private _available = false;
  private _credits: number | null = null;
  private docs: Partial<Record<ProfileDocKey, unknown>> = {};
  /** Server-side stamps of the mirrored documents (Phase 9). */
  private docsAt: Partial<Record<ProfileDocKey, number>> = {};
  /** Documents changed locally but not yet uploaded (newest per key). */
  private readonly pending = new Map<ProfileDocKey, PendingDoc>();
  /** Keys of the last flush, for `too_large` eviction. */
  private lastSent: ProfileDocKey[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly txs = new Map<number, PendingTx>();
  private nextTxId = 1;
  private updatedAt = 0;

  /** Wired by NetSystem: sends a frame when the socket is up (returns false otherwise). */
  send: (msg: ClientToServer) => boolean = () => false;
  /** Wired by NetSystem: `NetRef.serverNow()` (keeps the last server offset while offline). */
  serverNow: () => number = () => Date.now();
  bus: EventBus | null = null;

  constructor() {
    try {
      // The debounce must not lose the last save of a closing tab.
      window.addEventListener('pagehide', () => this.flush());
    } catch { /* no window (tests) */ }
  }

  get available(): boolean { return this._available; }
  get credits(): number | null { return this._credits; }
  /** Last record as the server sent it (for the terminal / debugging). */
  get record(): ProfileRecord {
    const rec: ProfileRecord = { credits: this._credits, docs: { ...this.docs }, updatedAt: this.updatedAt };
    if (Object.keys(this.docsAt).length > 0) rec.docsAt = { ...this.docsAt };
    return rec;
  }
  /** Keys waiting for an upload (offline queue / debounce), for diagnostics and smokes. */
  get pendingKeys(): ProfileDocKey[] { return Array.from(this.pending.keys()); }

  get(key: ProfileDocKey): unknown | undefined {
    return this.docs[key];
  }

  set(key: ProfileDocKey, doc: unknown, opts?: { fresh?: boolean }): void {
    if (!PROFILE_DOC_KEYS.includes(key)) return;
    if (!ProfileSync.fits(doc)) { console.warn(`[net] profile doc '${key}' exceeds ${PROFILE_DOC_MAX_BYTES} bytes; not uploaded`); return; }
    this.docs[key] = doc;
    this.pending.set(key, { doc, at: opts?.fresh ? null : this.serverNow() });
    if (this._available && this.flushTimer === null) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, PROFILE_SYNC_DEBOUNCE_MS);
    }
  }

  flush(): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.pending.size === 0) return;
    this.lastSent = [];
    for (const [key, e] of Array.from(this.pending)) {
      const msg: ClientToServer = e.at === null
        ? { t: 'profile:set', key, doc: e.doc, fresh: true }
        : { t: 'profile:set', key, doc: e.doc, at: e.at };
      if (!this.send(msg)) return; // socket down: keep the queue for the next welcome
      this.pending.delete(key);
      this.lastSent.push(key);
      if (e.at !== null) this.docsAt[key] = e.at;
    }
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
    const migrated = this.applyRecord(profile);
    this.flush();
    if (emit) this.bus?.emit('net:profileLoaded', { profile: this.record, migrated });
  }

  onDocs(profile: ProfileRecord): void {
    const migrated = this.applyRecord(profile);
    this.flush();
    this.bus?.emit('net:profileLoaded', { profile: this.record, migrated });
  }

  /**
   * Mirror a server record and merge the offline queue over it (Phase 9): a pending stamped document survives only
   * when its stamp is not older than the server's `docsAt[key]` (ties: ours), a pending `fresh` document only while
   * the server has nothing for that key. Returns `migrated` (server credits still null).
   */
  private applyRecord(profile: ProfileRecord): boolean {
    const migrated = profile.credits === null;
    this._available = true;
    this._credits = profile.credits;
    this.updatedAt = profile.updatedAt;
    this.docs = { ...profile.docs };
    this.docsAt = { ...(profile.docsAt ?? {}) };
    for (const [key, e] of Array.from(this.pending)) {
      const serverAt = this.docsAt[key] ?? 0;
      const loses = e.at === null ? profile.docs[key] !== undefined : e.at < serverAt;
      if (loses) { this.pending.delete(key); continue; }
      this.docs[key] = e.doc;
    }
    return migrated;
  }

  onCreditsResult(m: Extract<ServerToClient, { t: 'credits:result' }>): void {
    if (typeof m.credits === 'number' && Number.isFinite(m.credits)) this._credits = m.credits;
    const tx = this.txs.get(m.txId);
    if (!tx) return;
    this.txs.delete(m.txId);
    clearTimeout(tx.timer);
    tx.resolve(m.reason !== undefined ? { ok: m.ok, credits: m.credits, reason: m.reason } : { ok: m.ok, credits: m.credits });
  }

  /** A `lobby:error` arrived: `too_large` right after an upload drops those keys from the queue (no endless retry). */
  onError(code: LobbyErrorCode): void {
    if (code !== 'too_large' || this.lastSent.length === 0) return;
    for (const key of this.lastSent) this.pending.delete(key);
    console.warn(`[net] server refused profile doc(s) ${this.lastSent.join(', ')} as too large; not retried`);
    this.lastSent = [];
    if (this.pending.size === 0 && this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
  }

  onDisconnected(): void {
    this._available = false;
    this._credits = null;
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
}
