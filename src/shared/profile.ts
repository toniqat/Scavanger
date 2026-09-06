import type { MissionStats } from './types';

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
}

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
  /** Queue an upload (debounced `PROFILE_SYNC_DEBOUNCE_MS`). Ignored while unavailable. */
  set(key: ProfileDocKey, doc: unknown): void;
  /** Send every queued document now. */
  flush(): void;
  /**
   * Credits transaction: the server applies `delta` atomically and answers with the new balance; a negative delta that
   * would go below 0 is refused (`ok: false`). Rejects (throws) only when the socket is gone. Offline → callers apply
   * the delta locally themselves (meta/ does).
   */
  addCredits(delta: number, reason: string): Promise<CreditsTxResult>;
}
