import type { MissionStats } from './types';
/* appended (Phase 11, 2026-09-07): 소셜 */
import type { SocialRecord } from './social';

/* ────────────────────────────────────────────────────────────────────────────
 * Server profile + raid session (Phase 7, 2026-09-06).
 *
 * The relay server (server/) now keeps a small **profile store** per session token (→ PeerId) and a **raid session
 * store** per started lobby. Both are opaque JSON documents the server never interprets — except `credits`, which the
 * server owns so a purchase is a real server transaction. The client mirrors every document into localStorage as a
 * cache / offline fallback: when no server answers, everything keeps working exactly as before Phase 7.
 *
 * This file is imported by the browser AND the Node server (type-only there) — no runtime deps.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Documents the server stores per profile. Each owning folder decides the shape (it is its own localStorage save). */
export type ProfileDocKey = 'meta' | 'stash' | 'loadout' | 'progression' | 'ship';
export const PROFILE_DOC_KEYS: readonly ProfileDocKey[] = ['meta', 'stash', 'loadout', 'progression', 'ship'];

/** Server-side profile record as sent in `welcome.profile` / `profile:docs`. */
export interface ProfileRecord {
  /** Server-owned balance. `null` = the server has no balance yet (first contact) — the client migrates its local one. */
  credits: number | null;
  /** Opaque documents by key (absent = never uploaded). */
  docs: Partial<Record<ProfileDocKey, unknown>>;
  /** Server time (ms) of the last write, for the terminal / debugging. */
  updatedAt: number;
  /* ── appended (Phase 9) ── */
  /**
   * Per-document stamp (epoch ms, the writer's `ctx.net.serverNow()` at save time) of the copy the server holds.
   * `profile:set` carries `at`; the server keeps a document only when `at >= docsAt[key]` (newest wins, ties accept)
   * and stores `at` (clamped to its own clock + `PROFILE_CLOCK_SKEW_MS`). A set without `at` (`fresh`) is accepted only
   * while the key is absent. Absent for documents written before Phase 9 (treated as 0 → any stamped write wins).
   */
  docsAt?: Partial<Record<ProfileDocKey, number>>;
}
/** A client stamp may run ahead of the server clock by at most this much before it is clamped. */
export const PROFILE_CLOCK_SKEW_MS = 5 * 60_000;

/** Debounce for `profile:set` uploads (ms). `flush()` sends immediately (pagehide / mission end). */
export const PROFILE_SYNC_DEBOUNCE_MS = 1500;
/** Server refuses a document larger than this (bytes of JSON). */
export const PROFILE_DOC_MAX_BYTES = 256 * 1024;

/**
 * Everything a client needs to resume its own character after a reconnect mid-raid. `inventory` is the inventory
 * folder's own serialization (`InventoryRef.captureRaidState`); hp / position / downed state are NOT here — the host
 * keeps them as a ghost (`GhostMessage`) and hands them back with `ghost restore`.
 */
export interface RaidSessionBlob {
  /** Mission seed the blob belongs to; the server only returns it while the lobby is still running that seed. */
  seed: number;
  /** ctx.missionTime when saved. */
  missionTime: number;
  stats: MissionStats;
  inventory: unknown;
  /** Client time (ms) when saved, for staleness checks. */
  savedAt: number;
}
/** Seconds between periodic `raid:save` uploads while a raid is running (game/ also saves on container loot). */
export const RAID_SAVE_INTERVAL_S = 5;
/** Server drops a raid blob larger than this. */
export const RAID_BLOB_MAX_BYTES = 256 * 1024;

/** Result of a server credits transaction (`credits:tx` → `credits:result`). */
export interface CreditsTxResult {
  ok: boolean;
  /** Authoritative balance after the transaction (unchanged when `ok` is false). */
  credits: number;
  /** Korean reason when refused (`크레딧 부족`). */
  reason?: string;
}

/**
 * `ctx.net.profile` — published by net/NetSystem. Every persisting folder (meta, inventory stash + loadout,
 * progression, housing) uses it the same way:
 *   1. keep reading / writing localStorage as today;
 *   2. on `net:profileLoaded` replace the local state with `get(key)` when it is defined (server wins);
 *   3. after every local save also call `set(key, save)`.
 * When `available` is false (offline / single-player without a relay) `set` is a no-op and `get` returns undefined.
 */
export interface ProfileRef {
  /** true once the current connection answered with a profile record. */
  readonly available: boolean;
  /** Server-owned credits mirror (null until loaded / offline). */
  readonly credits: number | null;
  get(key: ProfileDocKey): unknown | undefined;
  /**
   * Queue an upload (debounced `PROFILE_SYNC_DEBOUNCE_MS`). Phase 9: **never dropped** — while offline the newest doc
   * per key waits in the pending map (stamped `at = serverNow()` at call time) and is sent on the next connection;
   * at `welcome` a pending doc older than the server's `docsAt[key]` is discarded in favour of the server copy.
   * `opts.fresh` = a default / starter save that must not beat a real profile: sent without a stamp, the server
   * keeps it only when it has no document for that key (inventory's first-run starter kit, startup stash resize).
   */
  set(key: ProfileDocKey, doc: unknown, opts?: { fresh?: boolean }): void;
  /** Send every queued document now. */
  flush(): void;
  /**
   * Credits transaction: the server applies `delta` atomically and answers with the new balance; a negative delta that
   * would go below 0 is refused (`ok: false`). Rejects (throws) only when the socket is gone. Offline → callers apply
   * the delta locally themselves (meta/ does).
   */
  addCredits(delta: number, reason: string): Promise<CreditsTxResult>;
}

/* ══ appended: Phase 11 — 소셜 (2026-09-07) ═════════════════════════════════════════════════════════════════ */

export interface ProfileRecord {
  /**
   * Friends / requests / 최근 만난 플레이어 of this profile, plus the 아이디 the server assigned it.
   * **Server-owned and server-readable** — unlike `docs`, which are opaque blobs the relay never interprets, the
   * relay has to cross-reference these to resolve a `SocialSnapshot`. A client never receives this record verbatim.
   * Absent until the profile first connects with a token (an anonymous socket gets no profile at all).
   */
  social?: SocialRecord;
}

/* ══ appended: 2026-09-11 — 프로필 GC (B-2) ═══════════════════════════════════════════════════════════════════ */

export interface ProfileRecord {
  /**
   * Server time (ms) of the owner's last connect or disconnect. **Server-internal** — `ProfileStore.snapshot()` does not
   * copy it, so it never reaches a client. Absent on records written before 2026-09-11: the GC then reads
   * `max(updatedAt, social.updatedAt)` instead (every real session writes a document, so that is close enough).
   */
  seenAt?: number;
}
/**
 * The relay deletes a profile whose owner has not connected for this long (credits, documents, 아이디 and all) and
 * drops its 아이디 from everyone's friends / requests / 최근 만난 플레이어. A connected socket or a lobby member (even
 * one inside its reconnect grace) is never collected. Server-read, so a TS literal like the other relay timings.
 */
export const PROFILE_GC_INACTIVE_MS = 90 * 24 * 60 * 60_000;
