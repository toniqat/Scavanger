/**
 * Profile store for the relay server (Phase 7): one `ProfileRecord` per session token (→ PeerId).
 *
 * The server never interprets the documents — they are opaque JSON the owning client folders wrote — except
 * `credits`, which the server owns so a purchase is a real transaction, and (Phase 11) `social`, which the relay
 * has to read and cross-reference to resolve a `SocialSnapshot`. Persistence is a single JSON file
 * (`<dataDir>/profiles.json`) written with a 1 s debounce and flushed on close; `dataDir: null` keeps everything in
 * memory (selftest). Erasable-TypeScript only (Node native type stripping).
 *
 * **2026-09-11 (C-41 · X-2) — 쓰기와 손상 복구.**
 *  - 디바운스 쓰기는 **비동기**다: `tmp` 에 쓰고 `fsync` → 이전 `profiles.json` 을 `profiles.json.bak` 으로 →
 *    `tmp` 를 `profiles.json` 으로 rename. 13 MB 짜리 파일을 동기로 쓰면 그동안 릴레이 전체(스냅샷 중계)가 멎었다.
 *    쓰는 도중에 또 바뀌면 끝난 뒤 **한 번 더** 쓴다. `close()` 는 예전처럼 **동기**다 — 종료 직전의 마지막 쓰기를
 *    잃지 않고, 진행 중이던 비동기 쓰기는 세대 번호(`gen`)가 바뀐 것을 보고 rename 하지 않고 물러난다.
 *  - 예전에는 `profiles.json` 파싱이 실패하면 "starting empty" 로 빈 DB 를 띄웠고 **첫 flush 가 원본을 덮어써**
 *    모든 계정이 영구히 사라졌다(백업도 없었다). 이제 원본을 `profiles.corrupt-<시각>.json` 으로 옮겨 **보존**하고
 *    `.bak`(직전 세대)에서 복구한다. `.bak` 도 없으면 빈 DB 로 시작하되 원본은 그대로 남는다.
 *  - 파일 포맷(`{v:1, profiles}`)은 바뀌지 않았다.
 *
 * **2026-09-11 (B-2) — GC.** 토큰으로 한 번이라도 붙은 사람마다 프로필(≈ 5.7 KB)이 영원히 남던 것을 정리한다.
 * `seenAt`(접속 · 해제 시각) 기준 `PROFILE_GC_INACTIVE_MS`(90일) 동안 안 온 프로필을 통째로 지우고, 남은 프로필의
 * 친구 · 요청 · 최근 목록에서 그 아이디를 뺀다. 최근 만난 플레이어(`SOCIAL_RECENT_TTL_MS`)와 답 없는 친구 요청
 * (`SOCIAL_REQUEST_TTL_MS`, `SocialRecord.requestsAt`)은 30일에 따로 만료된다. 무엇을 지우지 않을지(접속 중 · 로비
 * 멤버)는 릴레이가 `collectGarbage(keep)` 로 알려 준다.
 *
 * **2026-09-11 (E-6) — 문서 리비전.** 문서마다 `docsRev[key]` 가 있고 받아들인 쓰기마다 +1 이다(옛 `at` 쓰기도).
 * 새 쓰기(`writeDocs`)는 시계가 아니라 "내가 본 판 위에 쓰는가" 를 묻는다 — `baseRev` 가 지금 rev 와 같으면 저장,
 * 아니면 `conflict` 로 서버 사본을 돌려준다. 여러 문서는 전부 검사한 뒤 **전부 또는 전무**. 같은 쓰기 id 의 재전송은
 * 다시 ack 한다(메모리에 최근 16개). 옛 파일의 문서는 로드 때 rev 1 로 시드된다. `stale` 무음 규칙은 옛 프레임에만 남는다.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreditsTxResult, ProfileDocKey, ProfileRecord } from '../src/shared/profile.ts';
import { PROFILE_CLOCK_SKEW_MS, PROFILE_DOC_KEYS, PROFILE_DOC_MAX_BYTES, PROFILE_GC_INACTIVE_MS } from '../src/shared/profile.ts';
/* 2026-09-11 (E-6): 문서 리비전 · 트랜잭션 */
import { PROFILE_SETMANY_MAX_BYTES } from '../src/shared/profile.ts';
import type { PeerId } from '../src/shared/net.ts';
import { sanitizePlayerName } from '../src/shared/net.ts';
/* Phase 11 */
import type { PlayerCode, SocialCard, SocialErrorCode, SocialRecord } from '../src/shared/social.ts';
import {
  SOCIAL_FRIEND_MAX, SOCIAL_RECENT_MAX, SOCIAL_RECENT_TTL_MS, SOCIAL_REQUEST_MAX, SOCIAL_REQUEST_TTL_MS,
  isValidPlayerCode, playerCodeFrom,
} from '../src/shared/social.ts';
/* 2026-09-11 (B-4): 차단 · 오프라인 귓속말 보관 */
import { SOCIAL_BLOCK_MAX, SOCIAL_WHISPER_INBOX_MAX, SOCIAL_WHISPER_INBOX_TTL_MS, SOCIAL_WHISPER_MAX } from '../src/shared/social.ts';
/* 2026-09-11 (E-4 ⑦): 서버 크레딧 검증 */
import type { CreditLedger } from '../src/shared/credits.ts';
import { CREDIT_TX_INVALID_KO } from '../src/shared/credits.ts';
import { type CreditEconomy, emptyLedger, sanitizeLedger } from './Economy.ts';

/** B-4: one kept offline whisper (`SocialRecord.inbox` entry). */
export type WhisperInboxLine = NonNullable<SocialRecord['inbox']>[number];

export const PROFILE_FILE = 'profiles.json';
/** 2026-09-11 (X-2): the previous generation, rotated in by every flush just before the new file is renamed into place. */
export const PROFILE_BACKUP_SUFFIX = '.bak';
/** 2026-09-11 (X-2): an unreadable `profiles.json` is moved aside as `profiles.corrupt-<timestamp>.json` (never overwritten). */
export function corruptProfileFileName(now: Date = new Date()): string {
  return `profiles.corrupt-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}
export const PROFILE_SAVE_DEBOUNCE_MS = 1000;
/** `credits:tx` reason that seeds a still-null balance with `delta` (local → server migration). */
export const CREDITS_MIGRATE_REASON = 'migrate';
export const CREDITS_REFUSED_KO = '크레딧 부족';
/** Default data directory: `server/data/` next to this file (git-ignored). */
export const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
/** 2026-09-11 (B-2): how often the relay runs `collectGarbage` (it also runs once at startup). */
export const PROFILE_GC_INTERVAL_MS = 6 * 60 * 60_000;

/** 2026-09-11 (B-2): what one `ProfileStore.collectGarbage` pass did. */
export interface ProfileGcReport {
  /** Profiles deleted because their owner had not connected for `PROFILE_GC_INACTIVE_MS`. */
  removed: PeerId[];
  /** Friend / request / 최근 만난 플레이어 entries whose 아이디 no longer belongs to any profile. */
  danglingRefs: number;
  /** 최근 만난 플레이어 entries older than `SOCIAL_RECENT_TTL_MS`. */
  expiredRecent: number;
  /** Request entries older than `SOCIAL_REQUEST_TTL_MS` — one unanswered request is two entries (incoming + outgoing). */
  expiredRequests: number;
  /** Surviving profiles whose social lists changed (the relay re-sends their snapshot and rebuilds their watches). */
  changed: PeerId[];
}

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
 * re-assigned by `assignCode` during `load`. `now` stamps a pending request that has no `requestsAt` entry yet (B-2).
 */
function sanitizeSocial(raw: unknown, now: number = Date.now()): SocialRecord | null {
  if (!isRecord(raw)) return null;
  const code = typeof raw.code === 'string' && isValidPlayerCode(raw.code) ? raw.code : '';
  const salt = typeof raw.salt === 'number' && Number.isFinite(raw.salt) ? Math.max(0, Math.floor(raw.salt)) : 0;
  const name = sanitizePlayerName(typeof raw.name === 'string' ? raw.name : '');
  const level = typeof raw.level === 'number' && Number.isFinite(raw.level)
    ? Math.min(SOCIAL_LEVEL_MAX, Math.max(0, Math.floor(raw.level))) : 0;
  const self = new Set<PlayerCode>(code ? [code] : []);
  /* B-4: the block list first — a code I blocked cannot also be my friend / request / recent entry. */
  const blocked = codeList(raw.blocked, SOCIAL_BLOCK_MAX, self);
  const selfOrBlocked = new Set<PlayerCode>([...self, ...blocked]);
  const friends = codeList(raw.friends, SOCIAL_FRIEND_MAX, selfOrBlocked);
  const notSelfOrFriend = new Set<PlayerCode>([...selfOrBlocked, ...friends]);
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
  const out: SocialRecord = { code, salt, name, level, friends, incoming, outgoing, recent, updatedAt };
  /* B-2: one stamp per pending request, kept only for codes still pending; a legacy request is stamped `now`. */
  const rawAt = isRecord(raw.requestsAt) ? raw.requestsAt : {};
  const pending = [...incoming, ...outgoing];
  if (pending.length > 0) {
    const requestsAt: Record<PlayerCode, number> = {};
    for (const c of pending) {
      const v = rawAt[c];
      requestsAt[c] = typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(0, Math.floor(v)), now) : now;
    }
    out.requestsAt = requestsAt;
  }
  if (blocked.length > 0) out.blocked = blocked;
  const inbox = sanitizeInbox(raw.inbox, selfOrBlocked, now);
  if (inbox.length > 0) out.inbox = inbox;
  return out;
}

/**
 * B-4: offline whispers as stored — well-formed lines only, none from a code I blocked, none older than
 * `SOCIAL_WHISPER_INBOX_TTL_MS`, oldest first, the newest `SOCIAL_WHISPER_INBOX_MAX` kept.
 */
function sanitizeInbox(raw: unknown, drop: ReadonlySet<PlayerCode>, now: number): WhisperInboxLine[] {
  if (!Array.isArray(raw)) return [];
  const out: WhisperInboxLine[] = [];
  for (const v of raw) {
    if (!isRecord(v) || typeof v.from !== 'string' || !isValidPlayerCode(v.from) || drop.has(v.from)) continue;
    if (typeof v.text !== 'string' || typeof v.at !== 'number' || !Number.isFinite(v.at)) continue;
    const text = v.text.slice(0, SOCIAL_WHISPER_MAX);
    const at = Math.min(Math.max(0, Math.floor(v.at)), now);
    if (text.trim().length === 0 || now - at > SOCIAL_WHISPER_INBOX_TTL_MS) continue;
    out.push({ from: v.from, name: sanitizePlayerName(typeof v.name === 'string' ? v.name : ''), text, at });
  }
  out.sort((a, b) => a.at - b.at);
  return out.length > SOCIAL_WHISPER_INBOX_MAX ? out.slice(out.length - SOCIAL_WHISPER_INBOX_MAX) : out;
}

function sanitizeRecord(raw: unknown, now: number = Date.now()): ProfileRecord | null {
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
  /*
   * E-6: per-document revisions. Every present document gets one: its stored rev (a positive integer), or **1** for a
   * document written before 2026-09-11 (seed) — a client that never saw a rev bases its writes on 0, so its first write
   * on top of an existing document conflicts instead of silently replacing it. A rev without a document is dropped.
   */
  const docsRev: Partial<Record<ProfileDocKey, number>> = {};
  const rawRev = isRecord(raw.docsRev) ? raw.docsRev : {};
  for (const k of PROFILE_DOC_KEYS) {
    if (docs[k] === undefined) continue;
    const v = rawRev[k];
    docsRev[k] = typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
  }
  if (Object.keys(docsRev).length > 0) rec.docsRev = docsRev;
  /* Phase 11: the social half is server-owned, so unlike `docs` it is validated field by field. */
  const social = sanitizeSocial(raw.social, now);
  if (social) rec.social = social;
  /* B-2: written by this server's own clock — clamped to it (a clock that ran ahead must not keep a profile forever). */
  if (typeof raw.seenAt === 'number' && Number.isFinite(raw.seenAt)) rec.seenAt = Math.min(Math.max(0, Math.floor(raw.seenAt)), now);
  /* E-4 (⑦): the credits ledger is server-internal and server-readable → validated, pruned and capped like `social`. */
  const ledger = sanitizeLedger(raw.ledger, now);
  if (ledger) rec.ledger = ledger;
  return rec;
}

/** Outcome of `ProfileStore.setDoc`. `'stale'` = an older stamp (or a `fresh` write over an existing document): ignored, not an error. */
export type SetDocResult = ProfileRecord | 'invalid' | 'too_large' | 'stale';

/* ── 2026-09-11 (E-6): 문서 리비전 ───────────────────────────────────────── */

/** One document of a revision write: the JSON and the `docsRev[key]` it was made on top of (0 = no document yet). */
export interface RevWriteDoc { doc: unknown; baseRev: number }
/**
 * Outcome of `ProfileStore.writeDocs` (a `profile:set {baseRev}` is a one-document call):
 *   - `ack`      — every document stored (or `replay`: this write id was already stored — nothing changed, same revs);
 *   - `conflict` — at least one `baseRev` was not the current rev, **nothing** stored; `docs` = the server copy + rev of
 *                  every conflicting key (`doc` null when the server has none);
 *   - `refused`  — the write can never succeed as sent (bad key / shape → `invalid`, a document or the frame too big →
 *                  `too_large`), nothing stored.
 */
export type RevWriteResult =
  | { kind: 'ack'; revs: Partial<Record<ProfileDocKey, number>>; replay: boolean }
  | { kind: 'conflict'; docs: Partial<Record<ProfileDocKey, { rev: number; doc: unknown }>> }
  | { kind: 'refused'; code: 'invalid' | 'too_large' };
/** E-6: how many accepted write ids the store remembers per profile (a resend after a reconnect is acked again). */
export const PROFILE_WRITE_ID_MEMORY = 16;
/** E-6: longest `writeId` / `txId` the relay accepts. */
export const PROFILE_WRITE_ID_MAX = 64;

export class ProfileStore {
  private readonly profiles = new Map<PeerId, ProfileRecord>();
  /**
   * E-6: the last `PROFILE_WRITE_ID_MEMORY` accepted write ids (`writeId` / `txId`) per profile with the revs they
   * produced, newest last. **Memory only** — after a relay restart a resend is judged on its `baseRev` again, and the
   * client recognises its own write in the welcome copy (rev = base + 1, same document).
   */
  private readonly writeIds = new Map<PeerId, { id: string; revs: Partial<Record<ProfileDocKey, number>> }[]>();
  /** Phase 11: `PlayerCode` → owning PeerId. Rebuilt from the file in `load`, extended by `ensureSocial`. */
  private readonly byCode = new Map<PlayerCode, PeerId>();
  /** Not readonly since 2026-09-11 (X-2): a store whose file could not be read safely drops it and stays in memory. */
  private file: string | null;
  private readonly debounceMs: number;
  private readonly quiet: boolean;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private writes = 0;
  /** C-41: the asynchronous write in flight (null = idle). */
  private writing: Promise<void> | null = null;
  /** C-41: bumped by every synchronous write — an async write that sees a newer generation never renames over it. */
  private gen = 0;
  /** C-41: `close()` ran — no more async writes are scheduled. */
  private closed = false;
  /** X-2: what `load` had to do (`'corrupt-recovered'` / `'corrupt-empty'` / `'bak-recovered'` …) — diagnostics / selftest. */
  private loadNote: 'fresh' | 'loaded' | 'bak-recovered' | 'corrupt-recovered' | 'corrupt-empty' = 'fresh';
  /** X-2: where an unreadable file was moved to (null when nothing was). */
  private corruptPath: string | null = null;

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
  /** X-2: how the last `load` went (diagnostics / selftest). */
  get loadResult(): { note: string; corruptPath: string | null } { return { note: this.loadNote, corruptPath: this.corruptPath }; }
  /** C-41: resolves when no asynchronous write is in flight (selftest; the relay never needs to wait). */
  async idle(): Promise<void> { while (this.writing) await this.writing; }

  private log(line: string): void { if (!this.quiet) console.log(`[store ${new Date().toISOString()}] ${line}`); }

  /** Parse one store file. `null` = unreadable (bad JSON or not our layout); a missing file throws ENOENT. */
  private static readProfileFile(path: string): Record<string, unknown> | null {
    const text = readFileSync(path, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    return isRecord(parsed) && isRecord(parsed.profiles) ? parsed.profiles : null;
  }

  private load(dir: string): void {
    const file = this.file!;
    const bak = `${file}${PROFILE_BACKUP_SUFFIX}`;
    let profiles: Record<string, unknown> | null = null;
    try {
      if (!existsSync(file)) {
        // A crash between the two renames of a flush leaves only the `.bak` — that IS the latest complete file.
        if (existsSync(bak)) {
          profiles = ProfileStore.readProfileFile(bak);
          if (profiles) { this.loadNote = 'bak-recovered'; this.log(`${file} missing — recovered from ${bak}`); }
        }
        if (!profiles) { this.log(`no ${file} yet (fresh store)`); this.loadNote = 'fresh'; return; }
      } else {
        profiles = ProfileStore.readProfileFile(file);
        if (profiles) this.loadNote = 'loaded';
        else {
          /*
           * X-2: never start empty *over* the only copy. Move the unreadable file aside (kept forever), then try the
           * previous generation. The loud line goes to stderr even for a quiet store — this is the one message an
           * operator must not miss.
           */
          const corrupt = join(dir, corruptProfileFileName());
          try { renameSync(file, corrupt); this.corruptPath = corrupt; } catch (e) {
            // Could not move it (locked?) — refuse to ever write over it: this store stays in memory.
            this.warn(`${file} is unreadable and could not be moved aside (${(e as Error).message}) — NOT writing this store`);
            this.file = null;
            return;
          }
          let fromBak: Record<string, unknown> | null = null;
          try { fromBak = existsSync(bak) ? ProfileStore.readProfileFile(bak) : null; } catch { fromBak = null; }
          if (fromBak) {
            profiles = fromBak;
            this.loadNote = 'corrupt-recovered';
            this.warn(`${file} was unreadable → kept as ${corrupt}, recovered the previous generation from ${bak}`);
          } else {
            this.loadNote = 'corrupt-empty';
            this.warn(`${file} was unreadable → kept as ${corrupt}; no usable ${bak}, starting empty (the original is preserved)`);
            return;
          }
        }
      }
      let n = 0;
      const loadedAt = Date.now();   // one stamp for every legacy request, so both halves of a pair expire together
      for (const [id, raw] of Object.entries(profiles)) {
        const rec = sanitizeRecord(raw, loadedAt);
        if (rec && typeof id === 'string' && id.length > 0) { this.profiles.set(id, rec); n++; }
      }
      // Recovered from a backup → put a proper main file back as soon as possible.
      if (this.loadNote !== 'loaded') this.markDirty();
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
      // X-2: an I/O error (locked, no permission) is not "no profiles" — a write would replace a file we never read.
      this.profiles.clear();
      this.byCode.clear();
      this.file = null;
      this.warn(`failed to read ${file}: ${(e as Error).message} — this store keeps running in memory and will NOT write`);
    }
  }

  /** Something an operator must see (a store that recovered or stopped writing). Silenced only for a quiet store. */
  private warn(line: string): void { if (!this.quiet) console.error(`[store ${new Date().toISOString()}] ${line}`); }

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
    /* E-6: always present (even `{}`) — a client reads its presence as "this relay speaks revisions". */
    out.docsRev = { ...(rec.docsRev ?? {}) };
    return out;
  }

  /** E-6: current rev of `key` (0 = never written). */
  revOf(id: PeerId, key: ProfileDocKey): number {
    return this.profiles.get(id)?.docsRev?.[key] ?? 0;
  }

  /** E-6: one accepted write — the document, rev + 1, and (for Phase 9 writers) the server time as its stamp. */
  private bumpRev(rec: ProfileRecord, key: ProfileDocKey): number {
    if (!rec.docsRev) rec.docsRev = {};
    const next = (rec.docsRev[key] ?? 0) + 1;
    rec.docsRev[key] = next;
    return next;
  }

  /**
   * E-6: store one or more documents **all or nothing** on optimistic concurrency. Checked in this order:
   *   ① `writeId` already accepted (a resend after a reconnect) → `ack` with the revs it produced, nothing changes;
   *   ② shape: at least one entry, every key a `ProfileDocKey`, every `doc` defined, every `baseRev` a non-negative
   *      integer → otherwise `refused invalid`; any document over `PROFILE_DOC_MAX_BYTES` or all of them together over
   *      `PROFILE_SETMANY_MAX_BYTES` → `refused too_large`;
   *   ③ every `baseRev` equals the current rev (absent = 0) → otherwise `conflict` listing **every** mismatching key;
   *   ④ store all: rev + 1 each, `docsAt[key]` = server now (so a Phase 9 client's older stamp stays stale).
   * Placeholders are never created by a refused / conflicting write.
   */
  writeDocs(id: PeerId, writeId: string | undefined, entries: Record<string, unknown>): RevWriteResult {
    const seen = writeId !== undefined ? this.writeIds.get(id)?.find((w) => w.id === writeId) : undefined;
    if (seen) return { kind: 'ack', revs: { ...seen.revs }, replay: true };
    const keys = Object.keys(entries);
    if (keys.length === 0) return { kind: 'refused', code: 'invalid' };
    const valid: [ProfileDocKey, RevWriteDoc][] = [];
    let total = 0;
    for (const k of keys) {
      const e = entries[k];
      if (!isProfileDocKey(k) || !isRecord(e) || e.doc === undefined) return { kind: 'refused', code: 'invalid' };
      const base = e.baseRev;
      if (typeof base !== 'number' || !Number.isInteger(base) || base < 0) return { kind: 'refused', code: 'invalid' };
      const bytes = docBytes(e.doc);
      if (bytes > PROFILE_DOC_MAX_BYTES) return { kind: 'refused', code: 'too_large' };
      total += bytes;
      valid.push([k, { doc: e.doc, baseRev: base }]);
    }
    if (total > PROFILE_SETMANY_MAX_BYTES) return { kind: 'refused', code: 'too_large' };
    const rec = this.profiles.get(id);
    const conflicts: Partial<Record<ProfileDocKey, { rev: number; doc: unknown }>> = {};
    let conflicted = false;
    for (const [k, e] of valid) {
      const cur = rec?.docsRev?.[k] ?? 0;
      if (cur === e.baseRev) continue;
      conflicts[k] = { rev: cur, doc: rec?.docs[k] ?? null };
      conflicted = true;
    }
    if (conflicted) return { kind: 'conflict', docs: conflicts };
    const target = this.get(id);
    const now = Date.now();
    const revs: Partial<Record<ProfileDocKey, number>> = {};
    for (const [k, e] of valid) {
      target.docs[k] = e.doc;
      revs[k] = this.bumpRev(target, k);
      if (!target.docsAt) target.docsAt = {};
      target.docsAt[k] = now;
    }
    target.updatedAt = now;
    if (writeId !== undefined) {
      let list = this.writeIds.get(id);
      if (!list) { list = []; this.writeIds.set(id, list); }
      list.push({ id: writeId, revs: { ...revs } });
      if (list.length > PROFILE_WRITE_ID_MEMORY) list.splice(0, list.length - PROFILE_WRITE_ID_MEMORY);
    }
    this.markDirty();
    return { kind: 'ack', revs, replay: false };
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
    // E-6: a Phase 9 write is a write too — a revision client based on the previous rev must now conflict.
    this.bumpRev(rec, key);
    rec.updatedAt = Date.now();
    this.markDirty();
    return rec;
  }

  /**
   * Atomic credits transaction. A null balance counts as 0 — except a `'migrate'` transaction, which seeds the
   * balance with `delta` (the client's local credits) exactly once; later migrations are no-ops returning the balance.
   * A result below 0 is refused with `크레딧 부족`.
   */
  applyCredits(id: PeerId, delta: number, reason: string, max?: number): CreditsTxResult {
    const rec = this.get(id);
    const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    /* E-4 (⑦): `max` = `CREDITS_MAX` — a credit never lifts the balance above it (the client clamps its copy the same way). */
    const cap = (n: number): number => (max !== undefined && Number.isFinite(max) && d > 0 ? Math.min(Math.max(max, 0), n) : n);
    if (reason === CREDITS_MIGRATE_REASON) {
      if (rec.credits !== null) return { ok: true, credits: rec.credits };
      rec.credits = cap(Math.max(0, d));
      rec.updatedAt = Date.now();
      this.markDirty();
      return { ok: true, credits: rec.credits };
    }
    const cur = rec.credits ?? 0;
    const next = cur + d;
    if (next < 0) return { ok: false, credits: cur, reason: CREDITS_REFUSED_KO };
    rec.credits = d > 0 ? Math.max(cur, cap(next)) : next;   // a capped credit never lowers a balance already above the cap
    rec.updatedAt = Date.now();
    this.markDirty();
    return { ok: true, credits: rec.credits };
  }

  /**
   * E-4 (⑦): **validated** credits transaction — what `credits:tx` runs. `economy.check` judges `reason` / `delta` against the
   * generated table and this profile's ledger; a refusal leaves everything untouched and answers `CREDIT_TX_INVALID_KO`
   * (`why` is for the relay log only). Otherwise `applyCredits` moves the balance (capped at `creditsMax`) and, only when
   * that succeeded, the ledger records the debit / refund / payout. One synchronous call, so nothing interleaves.
   */
  applyCreditsTx(id: PeerId, delta: number, reason: string, economy: CreditEconomy, now: number = Date.now()): CreditsTxResult & { why?: string } {
    const rec = this.get(id);
    const check = economy.check(rec.credits, rec.ledger, delta, reason, now);
    if (!check.ok) return { ok: false, credits: rec.credits ?? 0, reason: CREDIT_TX_INVALID_KO, why: check.why };
    const res = this.applyCredits(id, check.delta, check.seed ? CREDITS_MIGRATE_REASON : reason, economy.table.creditsMax);
    if (res.ok) {
      economy.commit(rec.ledger ??= emptyLedger(), check, now);
      if (rec.ledger.quests.length === 0 && rec.ledger.contractsAt.length === 0 && rec.ledger.debits.length === 0) delete rec.ledger;
      this.markDirty();
    }
    return res;
  }

  /** E-4 (⑦): the ledger of `id` (never creates a record). Diagnostics / selftest — the wire never carries it. */
  ledgerOf(id: PeerId): CreditLedger | undefined { return this.profiles.get(id)?.ledger; }

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
    /* B-4: someone I blocked cannot be sent a request (the UI offers none) — unblock first. */
    if (this.hasBlocked(mine, theirs.code)) return 'invalid';
    /* B-4: a half left behind by a block that has since been lifted is not a pending request any more. */
    this.dropOrphanRequest(theirs, mine);
    this.dropOrphanRequest(mine, theirs);
    if (this.hasBlocked(theirs, mine.code)) {
      /*
       * B-4: they blocked me — swallowed. My `outgoing` gets the entry exactly as if it had gone out (so I cannot tell),
       * theirs gets nothing; the B-2 GC withdraws the half after `SOCIAL_REQUEST_TTL_MS`, an unblock drops it at once.
       */
      if (mine.friends.includes(theirs.code) || mine.outgoing.includes(theirs.code) || mine.incoming.includes(theirs.code)) return 'already';
      if (mine.outgoing.length >= SOCIAL_REQUEST_MAX) return 'limit';
      mine.outgoing.unshift(theirs.code);
      (mine.requestsAt ??= {})[theirs.code] = Date.now();
      this.touchSocial(mine);
      return 'ok';
    }
    if (mine.friends.includes(theirs.code) || theirs.friends.includes(mine.code)) return 'already';
    if (mine.outgoing.includes(theirs.code) || theirs.incoming.includes(mine.code)) return 'already';
    if (mine.incoming.includes(theirs.code) || theirs.outgoing.includes(mine.code)) return 'already';
    if (mine.friends.length >= SOCIAL_FRIEND_MAX || theirs.friends.length >= SOCIAL_FRIEND_MAX) return 'limit';
    if (mine.outgoing.length >= SOCIAL_REQUEST_MAX || theirs.incoming.length >= SOCIAL_REQUEST_MAX) return 'limit';
    mine.outgoing.unshift(theirs.code);
    theirs.incoming.unshift(mine.code);
    const at = Date.now();   // B-2: the same stamp on both halves, so the GC withdraws them together
    (mine.requestsAt ??= {})[theirs.code] = at;
    (theirs.requestsAt ??= {})[mine.code] = at;
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
    if (mine.requestsAt) delete mine.requestsAt[theirs.code];
    if (theirs.requestsAt) delete theirs.requestsAt[mine.code];
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
    /* B-4: sharing a ship (by lobby code) with someone blocked either way puts neither in the other's recent list. */
    if (this.hasBlocked(a, b.code) || this.hasBlocked(b, a.code)) return false;
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

  /* ── 2026-09-11 (B-4): 차단 · 오프라인 귓속말 보관 ─────────────────────── */

  private hasBlocked(owner: SocialRecord, code: PlayerCode): boolean {
    return owner.blocked !== undefined && owner.blocked.includes(code);
  }

  /** B-4: true when the profile `ownerId` has blocked the 아이디 `code`. */
  isBlocked(ownerId: PeerId, code: PlayerCode): boolean {
    const soc = this.social(ownerId);
    return soc !== undefined && this.hasBlocked(soc, code);
  }

  /**
   * B-4: `sender.outgoing` holds `receiver` but `receiver.incoming` does not — the swallowed half of a request made
   * while `receiver` had `sender` blocked. Once that block is gone the half means nothing: drop it (and its stamp).
   */
  private dropOrphanRequest(sender: SocialRecord, receiver: SocialRecord): void {
    if (!sender.outgoing.includes(receiver.code) || receiver.incoming.includes(sender.code)) return;
    if (this.hasBlocked(receiver, sender.code)) return;   // still blocked: the half stays (that is the disguise)
    sender.outgoing = sender.outgoing.filter((c) => c !== receiver.code);
    if (sender.requestsAt) {
      delete sender.requestsAt[receiver.code];
      if (sender.incoming.length + sender.outgoing.length === 0) delete sender.requestsAt;
    }
    this.touchSocial(sender);
  }

  /**
   * B-4 `social:block {code, blocked}`. Blocking puts the code at the front of my `blocked` (already there → moved to
   * the front, not an error; `limit` past `SOCIAL_BLOCK_MAX`) and removes the two of us from each other's friends /
   * incoming / outgoing / recent **on both records**. Unblocking only takes it off my list (not blocked → no-op `ok`)
   * and drops a request half they sent me while blocked. The relay closes our open invites and rebuilds both watches.
   */
  setBlocked(meId: PeerId, otherId: PeerId, blocked: boolean): 'ok' | SocialErrorCode {
    if (meId === otherId) return 'self';
    const mine = this.ensureSocial(meId);
    const theirs = this.ensureSocial(otherId);
    if (mine.code === theirs.code) return 'self';
    if (!blocked) {
      if (!this.hasBlocked(mine, theirs.code)) return 'ok';
      mine.blocked = (mine.blocked ?? []).filter((c) => c !== theirs.code);
      if (mine.blocked.length === 0) delete mine.blocked;
      this.touchSocial(mine);
      this.dropOrphanRequest(theirs, mine);
      return 'ok';
    }
    const list = (mine.blocked ?? []).filter((c) => c !== theirs.code);
    if (list.length >= SOCIAL_BLOCK_MAX) return 'limit';
    list.unshift(theirs.code);
    mine.blocked = list;
    const unlink = (rec: SocialRecord, code: PlayerCode): void => {
      rec.friends = rec.friends.filter((c) => c !== code);
      rec.incoming = rec.incoming.filter((c) => c !== code);
      rec.outgoing = rec.outgoing.filter((c) => c !== code);
      rec.recent = rec.recent.filter((r) => r.code !== code);
      if (rec.requestsAt) {
        delete rec.requestsAt[code];
        if (rec.incoming.length + rec.outgoing.length === 0) delete rec.requestsAt;
      }
      if (rec.inbox) {
        rec.inbox = rec.inbox.filter((l) => l.from !== code);
        if (rec.inbox.length === 0) delete rec.inbox;
      }
      this.touchSocial(rec);
    };
    unlink(mine, theirs.code);
    unlink(theirs, mine.code);
    return 'ok';
  }

  /**
   * B-4: keep a whisper for an offline receiver (the relay has checked that sender and receiver are friends). Expired
   * lines go first, then the oldest past `SOCIAL_WHISPER_INBOX_MAX`. false when the receiver has no social record.
   */
  pushWhisperInbox(toId: PeerId, line: WhisperInboxLine, now: number = Date.now()): boolean {
    const soc = this.social(toId);
    if (!soc) return false;
    const kept = (soc.inbox ?? []).filter((l) => now - l.at <= SOCIAL_WHISPER_INBOX_TTL_MS);
    kept.push({ from: line.from, name: line.name, text: line.text.slice(0, SOCIAL_WHISPER_MAX), at: line.at });
    soc.inbox = kept.length > SOCIAL_WHISPER_INBOX_MAX ? kept.slice(kept.length - SOCIAL_WHISPER_INBOX_MAX) : kept;
    this.touchSocial(soc);
    return true;
  }

  /** B-4: the kept whispers still inside the TTL, oldest first — and the inbox is emptied (delivered once). */
  takeWhisperInbox(id: PeerId, now: number = Date.now()): WhisperInboxLine[] {
    const soc = this.social(id);
    if (!soc || !soc.inbox) return [];
    const lines = soc.inbox.filter((l) => now - l.at <= SOCIAL_WHISPER_INBOX_TTL_MS && !this.hasBlocked(soc, l.from));
    delete soc.inbox;
    this.touchSocial(soc);
    return lines;
  }

  /* ── 2026-09-11 (B-2): garbage collection ─────────────────────────────── */

  /** The owner connected or disconnected just now (the relay calls this for token sockets only). Never creates a record. */
  touchSeen(id: PeerId, now: number = Date.now()): void {
    const rec = this.profiles.get(id);
    if (!rec) return;
    rec.seenAt = now;
    this.markDirty();
  }

  /**
   * When the owner was last around: `seenAt`, else (a record from before 2026-09-11) the newest write it has.
   * 0 = unknown (an untouched placeholder) — such a record is never collected.
   */
  private lastSeen(rec: ProfileRecord): number {
    return rec.seenAt ?? Math.max(rec.updatedAt, rec.social?.updatedAt ?? 0);
  }

  /**
   * One GC pass. ① Deletes every profile whose owner has not been seen for `PROFILE_GC_INACTIVE_MS` unless `keep(id)`
   * (the relay passes "connected or a lobby member") — its 아이디 leaves the index, so the same token coming back later
   * starts over as a new profile. ② On every survivor, drops friend / request / 최근 만난 플레이어 entries whose 아이디 no
   * longer resolves, 최근 entries older than `SOCIAL_RECENT_TTL_MS` and requests older than `SOCIAL_REQUEST_TTL_MS`.
   *
   * A legacy record's `seenAt` is filled from `lastSeen` on its first pass: otherwise a friend request *to* an abandoned
   * profile (which bumps its `social.updatedAt`) would keep it alive forever. The GC itself never bumps `updatedAt`.
   */
  collectGarbage(keep: (id: PeerId) => boolean = () => false, now: number = Date.now()): ProfileGcReport {
    const report: ProfileGcReport = { removed: [], danglingRefs: 0, expiredRecent: 0, expiredRequests: 0, changed: [] };
    let dirty = false;
    for (const [id, rec] of this.profiles) {
      const seen = this.lastSeen(rec);
      if (seen <= 0) continue;
      if (rec.seenAt === undefined) { rec.seenAt = seen; dirty = true; }
      if (now - seen <= PROFILE_GC_INACTIVE_MS || keep(id)) continue;
      const code = rec.social?.code;
      if (code && this.byCode.get(code) === id) this.byCode.delete(code);
      this.profiles.delete(id);   // deleting the current entry is safe while iterating a Map
      report.removed.push(id);
      dirty = true;
    }
    for (const [id, rec] of this.profiles) {
      const soc = rec.social;
      if (!soc) continue;
      const resolves = (c: PlayerCode): boolean => {
        if (this.byCode.has(c)) return true;
        report.danglingRefs++;
        return false;
      };
      const reqAt = soc.requestsAt ?? {};
      const stillPending = (c: PlayerCode): boolean => {
        if (!resolves(c)) return false;
        const at = reqAt[c];
        if (at !== undefined && now - at > SOCIAL_REQUEST_TTL_MS) { report.expiredRequests++; return false; }
        return true;
      };
      const friends = soc.friends.filter(resolves);
      const incoming = soc.incoming.filter(stillPending);
      const outgoing = soc.outgoing.filter(stillPending);
      const recent = soc.recent.filter((r) => {
        if (!resolves(r.code)) return false;
        if (now - r.at > SOCIAL_RECENT_TTL_MS) { report.expiredRecent++; return false; }
        return true;
      });
      /* B-4: an offline whisper nobody collected in time goes (not part of the snapshot, so not `changed`). */
      if (soc.inbox) {
        const inbox = soc.inbox.filter((l) => now - l.at <= SOCIAL_WHISPER_INBOX_TTL_MS);
        if (inbox.length !== soc.inbox.length) {
          if (inbox.length === 0) delete soc.inbox; else soc.inbox = inbox;
          dirty = true;
        }
      }
      /* B-4: a blocked 아이디 whose profile is gone cannot be drawn (or unblocked) — dropped like any dangling entry. */
      const blocked = soc.blocked?.filter(resolves);
      const blockedChanged = blocked !== undefined && blocked.length !== (soc.blocked?.length ?? 0);
      if (blockedChanged) { if (blocked.length === 0) delete soc.blocked; else soc.blocked = blocked; }
      const changed = friends.length !== soc.friends.length || incoming.length !== soc.incoming.length
        || outgoing.length !== soc.outgoing.length || recent.length !== soc.recent.length;
      if (!changed) {
        if (blockedChanged) { report.changed.push(id); dirty = true; }
        continue;
      }
      soc.friends = friends;
      soc.incoming = incoming;
      soc.outgoing = outgoing;
      soc.recent = recent;
      const pending = [...incoming, ...outgoing];
      if (pending.length === 0) delete soc.requestsAt;
      else {
        const next: Record<PlayerCode, number> = {};
        for (const c of pending) if (reqAt[c] !== undefined) next[c] = reqAt[c];
        soc.requestsAt = next;
      }
      report.changed.push(id);
      dirty = true;
    }
    if (dirty) this.markDirty();
    return report;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.file === null || this.closed || this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flushAsync(); }, this.debounceMs);
    this.saveTimer.unref();
  }

  /** The file body: every record except untouched placeholders. The format is unchanged since Phase 7. */
  private serialize(): string {
    const out: ProfileFile = { v: 1, profiles: {} };
    for (const [id, rec] of this.profiles) {
      // Never persist untouched placeholder records (a social record counts as content: it holds the 아이디).
      if (rec.credits === null && rec.updatedAt === 0 && Object.keys(rec.docs).length === 0 && !rec.social) continue;
      out.profiles[id] = rec;
    }
    return JSON.stringify(out);
  }

  /**
   * C-41: the debounced write. `tmp` + `fsync` → current file → `.bak` → `tmp` → current file. Only one runs at a time;
   * a change that lands while it is writing leaves `dirty` set, and the write runs once more when this one finishes.
   * A synchronous `flush()` / `close()` in between bumps `gen`, and this write then gives up before either rename so it
   * can never put an older snapshot over a newer one.
   */
  private flushAsync(): void {
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const file = this.file;
    if (file === null) { this.dirty = false; return; }
    if (this.writing || !this.dirty || this.closed) return;   // in flight → the `finally` below runs us again
    this.dirty = false;
    const gen = this.gen;
    const text = this.serialize();
    const tmp = `${file}.tmp`;
    const bak = `${file}${PROFILE_BACKUP_SUFFIX}`;
    const run = async (): Promise<void> => {
      await mkdir(dirname(file), { recursive: true });
      const fh = await open(tmp, 'w');
      try {
        await fh.writeFile(text, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (gen !== this.gen) { await rm(tmp, { force: true }); return; }
      if (existsSync(file)) await rename(file, bak);
      if (gen !== this.gen) { await rm(tmp, { force: true }); return; }
      await rename(tmp, file);
      this.writes++;
    };
    this.writing = run()
      .catch((e: unknown) => {
        if (gen === this.gen) this.dirty = true;   // retry with the next change / flush
        this.warn(`failed to write ${file}: ${(e as Error).message}`);
      })
      .finally(() => {
        this.writing = null;
        if (this.dirty && !this.closed) this.flushAsync();
      });
  }

  /**
   * Write now, **synchronously**, when dirty — or when an async write is still in flight (the process may exit right
   * after this returns, before that write lands). Server close and the selftest use it; a shutdown cannot lose the
   * last write. Same file dance as `flushAsync` (`.bak` rotation), with its own tmp name.
   */
  flush(): void {
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const file = this.file;
    if (file === null) { this.dirty = false; return; }
    if (!this.dirty && !this.writing) return;
    this.gen++;               // an async write in flight must not rename after this
    this.dirty = false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-sync`;
      writeFileSync(tmp, this.serialize(), { encoding: 'utf8', flush: true });
      if (existsSync(file)) renameSync(file, `${file}${PROFILE_BACKUP_SUFFIX}`);
      renameSync(tmp, file);
      this.writes++;
    } catch (e) {
      this.dirty = true; // retry on the next write / flush
      this.warn(`failed to write ${file}: ${(e as Error).message}`);
    }
  }

  close(): void {
    this.closed = true;
    this.flush();
  }
}
