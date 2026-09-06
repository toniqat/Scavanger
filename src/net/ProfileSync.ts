import type { ClientToServer, CreditsTxResult, EventBus, ProfileDocKey, ProfileRecord, ProfileRef, ServerToClient } from '@/shared';
import { PROFILE_DOC_KEYS, PROFILE_DOC_MAX_BYTES, PROFILE_SYNC_DEBOUNCE_MS } from '@/shared';

/** A credits transaction that got no `credits:result` within this long is rejected (socket alive but server stuck). */
const TX_TIMEOUT_MS = 10_000;

interface PendingTx { resolve: (r: CreditsTxResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/**
 * `ctx.net.profile` (Phase 7): client mirror of the server profile record + debounced document uploads + credits
 * transactions matched by `txId`. Owned by NetSystem, which feeds it the socket events:
 *   - `onWelcome(profile)`  → `available`, `credits`, `docs`; emits `net:profileLoaded {migrated}` (`migrated` =
 *     the server has no balance yet → meta/ uploads its local credits with `addCredits(local, 'migrate')`).
 *   - `onDocs(profile)`     → reply to `profile:get`.
 *   - `onCreditsResult(m)`  → settles the matching `addCredits` promise and mirrors the authoritative balance.
 *   - `onDisconnected()`    → `available=false`; pending transactions reject; queued documents survive and are
 *     re-sent right after the next welcome (they are newer than what the server has).
 * Documents are opaque: the owning folder decides the shape and keeps localStorage as its offline copy.
 */
export class ProfileSync implements ProfileRef {
  private _available = false;
  private _credits: number | null = null;
  private docs: Partial<Record<ProfileDocKey, unknown>> = {};
  /** Documents changed locally but not yet uploaded. */
  private readonly pending = new Map<ProfileDocKey, unknown>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly txs = new Map<number, PendingTx>();
  private nextTxId = 1;
  private updatedAt = 0;

  /** Wired by NetSystem: sends a frame when the socket is up (returns false otherwise). */
  send: (msg: ClientToServer) => boolean = () => false;
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
  get record(): ProfileRecord { return { credits: this._credits, docs: { ...this.docs }, updatedAt: this.updatedAt }; }

  get(key: ProfileDocKey): unknown | undefined {
    return this.docs[key];
  }

  set(key: ProfileDocKey, doc: unknown): void {
    if (!this._available) return;
    if (!PROFILE_DOC_KEYS.includes(key)) return;
    if (!ProfileSync.fits(doc)) { console.warn(`[net] profile doc '${key}' exceeds ${PROFILE_DOC_MAX_BYTES} bytes; not uploaded`); return; }
    this.docs[key] = doc;
    this.pending.set(key, doc);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, PROFILE_SYNC_DEBOUNCE_MS);
    }
  }

  flush(): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.pending.size === 0) return;
    for (const [key, doc] of Array.from(this.pending)) {
      if (!this.send({ t: 'profile:set', key, doc })) return; // socket down: keep the queue for the next welcome
      this.pending.delete(key);
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
    const migrated = profile.credits === null;
    this._available = true;
    this._credits = profile.credits;
    this.updatedAt = profile.updatedAt;
    this.docs = { ...profile.docs };
    // Local edits queued while offline are newer than the server copy: they win and go up right away.
    for (const [key, doc] of this.pending) this.docs[key] = doc;
    this.flush();
    if (emit) this.bus?.emit('net:profileLoaded', { profile: this.record, migrated });
  }

  onDocs(profile: ProfileRecord): void {
    this._available = true;
    this._credits = profile.credits;
    this.updatedAt = profile.updatedAt;
    this.docs = { ...profile.docs };
    for (const [key, doc] of this.pending) this.docs[key] = doc;
    this.bus?.emit('net:profileLoaded', { profile: this.record, migrated: false });
  }

  onCreditsResult(m: Extract<ServerToClient, { t: 'credits:result' }>): void {
    if (typeof m.credits === 'number' && Number.isFinite(m.credits)) this._credits = m.credits;
    const tx = this.txs.get(m.txId);
    if (!tx) return;
    this.txs.delete(m.txId);
    clearTimeout(tx.timer);
    tx.resolve(m.reason !== undefined ? { ok: m.ok, credits: m.credits, reason: m.reason } : { ok: m.ok, credits: m.credits });
  }

  onDisconnected(): void {
    this._available = false;
    this._credits = null;
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
