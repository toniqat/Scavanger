/**
 * Player ↔ player trust (2026-09-21, user's decisions):
 *
 * - **One symmetric value per pair** (A↔B), kept by the relay in the profile/social store — never the client's word.
 * - A finished raid shared by two humans adds `PLAYER_TRUST_RAID_GAIN` to that pair (once per raid per pair, the relay
 *   decides). Androids never count.
 * - On the result screen each human may **like** each squadmate once per raid → the pair gains `PLAYER_TRUST_LIKE_GAIN`.
 * - The pair's level (before the raid) adds a per-squadmate XP card at settlement (`raidRewards.RaidXpCard` kind `trust`).
 * - Shown in the messenger 친구 tab like NPC trust.
 *
 * Owner: `net/` implements `TrustRef` as `ctx.net.trust`; `server/` owns the numbers on the wire.
 */
import type { PlayerCode } from './social';

export interface PlayerTrustInfo {
  /** Accumulated pair points (0 when the pair never played). */
  points: number;
  /** 0 … max level. */
  level: number;
  /** Next level's accumulated points, null at the top. */
  next: number | null;
  /** 0 … 1 inside the current level's band (1 at the top). */
  frac: number;
}

export interface TrustRef {
  /** Current pair trust with that player (from the last relay push). Unknown → all zero. */
  get(code: PlayerCode): PlayerTrustInfo;
  /** Level → info helper for a raw point value (the result screen animates raw points). */
  infoOf(points: number): PlayerTrustInfo;
  /** True when I may still like that squadmate for the raid that just ended. */
  canLike(code: PlayerCode): boolean;
  /** True once I liked that squadmate for the raid that just ended. */
  hasLiked(code: PlayerCode): boolean;
  /** Send the like. Returns false when refused locally (already liked, not a squadmate of that raid, offline). */
  like(code: PlayerCode): boolean;
}

/* ══ appended 2026-09-21 (agent TRUST — owner: server/ · net/): the wire, the rules, the pure level math ══
 *
 * **Who gains, when** (relay-authoritative — `server/Trust.ts`):
 * - A raid start (`lobby:start` mode raid) records a **raid** on the relay: the humans marked `inMission` at that moment
 *   who have a profile (anonymous sockets and android bot members never count). Each of them now points at that raid;
 *   it replaces whatever raid they pointed at before (so the previous raid's like window closes).
 * - A member **finishes** the raid with its own end of the session: `lobby:mission {inMission:false}` **without**
 *   `keep` (death · extraction · a voluntary return — a client's `endSession` / `leaveMission`), or the host's
 *   `lobby:reset` (a raid host ends its session with a reset instead). A finish **counts** only when at least
 *   `PLAYER_TRUST_RAID_MIN_S` passed since the start — a start-and-quit cannot farm the pair gain.
 * - It does **not** count: `keep` (a reload — the raid is not over for that member), `lobby:abandon` (drifted), leaving
 *   the lobby / grace expiry / an operator kick while the raid is still unfinished for that member, or a finish before
 *   the minimum time.
 * - Each pair of counted finishers gains `PLAYER_TRUST_RAID_GAIN` once — granted the moment the **second** of the two
 *   finishes, so it never depends on who ends first. The relay sends `trust:gain {reason:'raid'}` to both.
 * - **Likes**: a member whose finish counted may like every other human of that raid (they need not have finished)
 *   once → `PLAYER_TRUST_LIKE_GAIN` to the pair. The window stays open until that member's next raid start, or for
 *   `PLAYER_TRUST_LIKE_WINDOW_S` at most (raid records are memory-only — a relay restart closes every window).
 *
 * Persistence: `SocialRecord.trust` (`PlayerCode` → pair points) on **both** records of the pair, written together —
 * the value is symmetric. The client sees its own map as `SocialSnapshot.trust` (codes that still resolve only).
 */

/** Why the relay refused a `trust:like`. */
export type TrustLikeError =
  | 'unavailable'  // anonymous socket / no profile
  | 'not_found'    // the code has no profile
  | 'self'
  | 'no_raid'      // I point at no raid (never played one here, the window expired, or the relay restarted)
  | 'not_mate'     // that player was not a human of my last raid
  | 'not_counted'  // my own finish did not count (still inside, left early, drifted, under the minimum time)
  | 'already';     // I already liked them for that raid

export const TRUST_LIKE_ERROR_KO: Readonly<Record<TrustLikeError, string>> = {
  unavailable: '서버 프로필이 없어 신뢰도를 줄 수 없습니다.',
  not_found: '대원을 찾을 수 없습니다.',
  self: '자기 자신에게는 줄 수 없습니다.',
  no_raid: '좋아요를 줄 수 있는 레이드가 없습니다.',
  not_mate: '지난 레이드를 함께한 대원이 아닙니다.',
  not_counted: '이번 레이드는 좋아요를 줄 수 없습니다.',
  already: '이미 좋아요를 보냈습니다.',
};

/** Client → relay. */
export type TrustClientToServer =
  /** Like a squadmate of my last raid (by code — a PeerId never crosses the wire). */
  | { t: 'trust:like'; code: PlayerCode };

/** Relay → client. */
export type TrustServerToClient =
  /**
   * My like window for the last raid I finished (sent when my finish is recorded, after a like, and after `welcome`).
   * `open` false = that raid gives me no likes (`mates` then empty). A raid start closes it on the client by itself.
   */
  | { t: 'trust:window'; open: boolean; mates: PlayerCode[]; liked: PlayerCode[] }
  /**
   * A pair value moved. `reason` raid = the shared raid grant, like = a like. `mine` (likes only): true = I sent it,
   * false = they liked me. `points` = the pair's new total.
   */
  | { t: 'trust:gain'; code: PlayerCode; name: string; points: number; delta: number; reason: 'raid' | 'like'; mine?: boolean }
  /** My `trust:like` was refused. */
  | { t: 'trust:refused'; code: PlayerCode; error: TrustLikeError; message: string };

/** Largest pair value the relay keeps (a guard, not a balance number — levels come from `PLAYER_TRUST_TABLE`). */
export const PLAYER_TRUST_POINTS_MAX = 1_000_000;
/** Pair entries kept per profile; past it the lowest values go first. */
export const PLAYER_TRUST_PAIRS_MAX = 500;

/**
 * Level math for raw points against a threshold table (`PLAYER_TRUST_TABLE` on the client). Pure — the relay never
 * needs levels, and this file must not pull the Vite csv loader into it.
 */
export function playerTrustInfo(points: number, table: readonly number[]): PlayerTrustInfo {
  const p = Number.isFinite(points) ? Math.max(0, Math.floor(points)) : 0;
  let level = 0;
  for (let i = 1; i < table.length; i++) if (p >= table[i]) level = i;
  const max = Math.max(0, table.length - 1);
  const prev = table[level] ?? 0;
  const next = level >= max ? null : table[level + 1] ?? null;
  const frac = next === null ? 1 : Math.min(1, Math.max(0, (p - prev) / Math.max(1, next - prev)));
  return { points: p, level, next, frac };
}

export interface TrustRef {
  /**
   * Pair trust as it stood when my **last raid started** (captured on `game:start`) — the settlement's
   * `RaidSquadEntry.trustBefore`. Outside that capture (no raid yet on this page) it equals `get`.
   */
  beforeRaid(code: PlayerCode): PlayerTrustInfo;
}
/* ══ end 2026-09-21 player trust wire ══ */
