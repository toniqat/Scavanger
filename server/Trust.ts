/**
 * Player ↔ player trust on the relay (2026-09-21, user's decisions — the rules are written once in
 * `src/shared/playerTrust.ts`; this file is their bookkeeping).
 *
 * `TrustRaids` knows no sockets and no store: it remembers which humans shared which raid, who finished it in a way that
 * counts, which pairs were already paid and which likes were already given. The relay (`RelayServer.ts`) feeds it the
 * lobby events and applies what it returns to the profile store (`ProfileStore.addTrust`). Memory-only by design — a
 * relay restart closes every open like window and forgets unfinished raids (nobody is paid twice, some are paid never).
 *
 * The numbers come from `data/constants.csv`, read here from disk (`loadTrustNumbers`): the relay runs only from this
 * repo (`start-server.bat`), and it cannot run the Vite csv loader. A missing / broken row stops startup, like a broken
 * economy table does.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PeerId } from '../src/shared/net.ts';
import type { TrustLikeError } from '../src/shared/playerTrust.ts';
import { parseCsv } from '../src/shared/data/csv.ts';

/** The four csv rows the relay uses. */
export interface TrustNumbers {
  /** `PLAYER_TRUST_RAID_GAIN` — per pair per counted raid. */
  raidGain: number;
  /** `PLAYER_TRUST_LIKE_GAIN` — per like. */
  likeGain: number;
  /** `PLAYER_TRUST_RAID_MIN_S` in ms — a finish earlier than this does not count. */
  raidMinMs: number;
  /** `PLAYER_TRUST_LIKE_WINDOW_S` in ms — the longest a finished raid keeps its likes open. */
  likeWindowMs: number;
}

export const TRUST_CSV_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

/** Reads the trust rows from `<dir>/constants.csv`. Throws on a missing or non-numeric row (the relay must not guess). */
export function loadTrustNumbers(dir: string = TRUST_CSV_DIR): TrustNumbers {
  const text = readFileSync(join(dir, 'constants.csv'), 'utf8');
  const rows = parseCsv('constants.csv', text).rows;
  const num = (key: string): number => {
    const row = rows.find((r) => r.raw('key') === key);
    const v = row ? Number(row.raw('value').replace(/_/g, '')) : NaN;
    if (!Number.isFinite(v) || v < 0) throw new Error(`data/constants.csv: ${key} is missing or not a number ≥ 0`);
    return v;
  };
  return {
    raidGain: Math.floor(num('PLAYER_TRUST_RAID_GAIN')),
    likeGain: Math.floor(num('PLAYER_TRUST_LIKE_GAIN')),
    raidMinMs: num('PLAYER_TRUST_RAID_MIN_S') * 1000,
    likeWindowMs: num('PLAYER_TRUST_LIKE_WINDOW_S') * 1000,
  };
}

/** One member's standing in a raid: still inside, finished in a way that counts, or out without counting. */
type MemberState = 'in' | 'counted' | 'out';

interface TrustRaid {
  id: number;
  lobby: string;
  startedAt: number;
  members: Map<PeerId, MemberState>;
  /** When a member's finish counted (the like window runs from here). */
  finishedAt: Map<PeerId, number>;
  /** Sorted `a|b` pair keys already paid. */
  paid: Set<string>;
  /** `liker|target` keys already liked. */
  likes: Set<string>;
}

/** What `window` reports for one member. */
export interface TrustWindow { open: boolean; mates: PeerId[]; liked: PeerId[] }

const pairKey = (a: PeerId, b: PeerId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class TrustRaids {
  readonly numbers: TrustNumbers;
  private seq = 0;
  private readonly raids = new Map<number, TrustRaid>();
  /** Member → the raid it points at (its last raid start). */
  private readonly current = new Map<PeerId, number>();

  constructor(numbers: TrustNumbers) {
    this.numbers = numbers;
  }

  /** Raids still held (the selftest and the console read it). */
  get size(): number { return this.raids.size; }

  /** A raid started in `lobby` with these humans (profiles only — the caller filters bots and anonymous sockets). */
  start(lobby: string, humans: readonly PeerId[], now: number = Date.now()): void {
    const raid: TrustRaid = {
      id: ++this.seq, lobby, startedAt: now, members: new Map(), finishedAt: new Map(), paid: new Set(), likes: new Set(),
    };
    for (const id of humans) {
      raid.members.set(id, 'in');
      this.current.set(id, raid.id);
    }
    this.raids.set(raid.id, raid);
    this.prune(now);
  }

  /** The raid `id` points at, while it is still inside it in lobby `lobby` (else null). */
  private runningOf(id: PeerId, lobby?: string): TrustRaid | null {
    const rid = this.current.get(id);
    const raid = rid === undefined ? undefined : this.raids.get(rid);
    if (!raid || raid.members.get(id) !== 'in') return null;
    if (lobby !== undefined && raid.lobby !== lobby) return null;
    return raid;
  }

  /** True while `id` is still inside a raid of `lobby` that has not ended for it. */
  isInside(id: PeerId, lobby: string): boolean { return this.runningOf(id, lobby) !== null; }

  /**
   * `id` ended its session in `lobby`'s raid. Returns the pairs to pay now (each with the other member) — the empty list
   * when the finish did not count, nothing is pending, or `id` was not inside. null = nothing changed at all.
   */
  finish(id: PeerId, lobby: string, now: number = Date.now()): { counted: boolean; pay: PeerId[] } | null {
    const raid = this.runningOf(id, lobby);
    if (!raid) return null;
    if (now - raid.startedAt < this.numbers.raidMinMs) {
      raid.members.set(id, 'out');
      return { counted: false, pay: [] };
    }
    raid.members.set(id, 'counted');
    raid.finishedAt.set(id, now);
    const pay: PeerId[] = [];
    for (const [other, st] of raid.members) {
      if (other === id || st !== 'counted') continue;
      const key = pairKey(id, other);
      if (raid.paid.has(key)) continue;
      raid.paid.add(key);
      pay.push(other);
    }
    return { counted: true, pay };
  }

  /** `id` left the raid without a counted finish (abandon · leave · grace expiry · kick · a training start). */
  drop(id: PeerId): boolean {
    const raid = this.runningOf(id);
    if (!raid) return false;
    raid.members.set(id, 'out');
    return true;
  }

  /** `id`'s like window, or null when it points at no raid (or the raid is gone). */
  window(id: PeerId, now: number = Date.now()): TrustWindow | null {
    const rid = this.current.get(id);
    const raid = rid === undefined ? undefined : this.raids.get(rid);
    if (!raid) return null;
    const at = raid.finishedAt.get(id);
    const open = raid.members.get(id) === 'counted' && at !== undefined && now - at <= this.numbers.likeWindowMs;
    if (!open) return { open: false, mates: [], liked: [] };
    const mates: PeerId[] = [];
    const liked: PeerId[] = [];
    for (const other of raid.members.keys()) {
      if (other === id) continue;
      mates.push(other);
      if (raid.likes.has(`${id}|${other}`)) liked.push(other);
    }
    return { open, mates, liked };
  }

  /** `liker` likes `target` for its last raid. `ok` = recorded (the caller pays `likeGain` to the pair). */
  like(liker: PeerId, target: PeerId, now: number = Date.now()): 'ok' | TrustLikeError {
    if (liker === target) return 'self';
    const rid = this.current.get(liker);
    const raid = rid === undefined ? undefined : this.raids.get(rid);
    if (!raid) return 'no_raid';
    if (!raid.members.has(target)) return 'not_mate';
    const at = raid.finishedAt.get(liker);
    if (raid.members.get(liker) !== 'counted' || at === undefined) return 'not_counted';
    if (now - at > this.numbers.likeWindowMs) return 'no_raid';
    const key = `${liker}|${target}`;
    if (raid.likes.has(key)) return 'already';
    raid.likes.add(key);
    return 'ok';
  }

  /** Drops raids nobody points at any more and pointers past the like window whose raid is fully over for them. */
  prune(now: number = Date.now()): void {
    for (const [id, rid] of this.current) {
      const raid = this.raids.get(rid);
      if (!raid) { this.current.delete(id); continue; }
      /* A member still `in` is timed from the start (it may come back from a reload and finish — no raid lasts a whole
         like window), everyone else from its finish. */
      const at = raid.finishedAt.get(id) ?? raid.startedAt;
      if (now - at > this.numbers.likeWindowMs) this.current.delete(id);
    }
    const live = new Set(this.current.values());
    for (const rid of this.raids.keys()) if (!live.has(rid)) this.raids.delete(rid);
  }
}
