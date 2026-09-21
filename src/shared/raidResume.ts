import type { PlanetId } from './planets';

/* ────────────────────────────────────────────────────────────────────────────
 * The title's `이어하기` · `레이드 포기` (2026-09-15, `src/game/README.md` Decisions).
 *
 * Starting the game with a raid left over begins **at the title**. The title puts a red `게임 시작` under the
 * highlighted `이어하기`, and that `게임 시작` only opens the abandon popup (switching to another character means
 * giving this raid up as well — user's decision).
 *
 *  - `solo`     — the solo raid save in localStorage. The grace (`SOLO_RAID_GRACE_MS`) is read **at the moment of the
 *                 press**: crossing it while sitting on the title makes `이어하기` disappear and settles the raid as a loss.
 *  - `tutorial` — the tutorial save (no time limit). Abandoning clears the progress only; the next start is **from the beginning**.
 *  - `squad`    — a squad raid still running in a relay lobby. The title connects and asks only when the boot found
 *                 `SQUAD_RAID_MARK_KEY`. Abandoning = death in that raid + **drifting** (`LobbyPlayer.drifted` — no rescue drop, no rejoin).
 *
 * Owner: game/ (`ctx.raidResume`). The only side that draws it is ui/menus/TitleMenu.
 * ──────────────────────────────────────────────────────────────────────────── */

export type RaidResumeKind = 'solo' | 'tutorial' | 'squad';

/** One portrait cell of the abandon popup (the same vocabulary as the 매칭 tab's cells). */
export interface RaidResumeMember {
  id: string;
  name: string;
  /** null when unknown (android · older server). */
  level: number | null;
  /** `#rrggbb`, null when unknown → the slot colour. */
  accent: string | null;
  slot: number;
  isHost: boolean;
  me: boolean;
  bot: boolean;
  /** The android's cockpit bay (0 for a person). */
  bay: number;
  connected: boolean;
  /** A squadmate who already abandoned this raid. */
  drifted: boolean;
}

export interface RaidResumeOffer {
  kind: RaidResumeKind;
  /** null for the tutorial and for an unknown planet. */
  planet: PlanetId | null;
  /** Mission time in seconds at the last save. */
  missionTime: number;
  /** Me first, then the other squadmates (in slot order). Solo and the tutorial hold me alone. */
  members: readonly RaidResumeMember[];
}

export interface RaidResumeRef {
  /** The raid to offer on the title right now, or null. Always null outside the title (phase `menu`). */
  readonly offer: RaidResumeOffer | null;
  /** A squad raid is being asked of the relay (once at boot, only when the mark exists). */
  readonly checking: boolean;
  /** Resolves once that question is answered (at once when nothing is being asked). Character select and the auto start wait on it. */
  settled(): Promise<void>;
  /** `이어하기`. true when it entered — a solo raid past its grace is settled as a loss on the spot and returns false. */
  resume(): boolean;
  /** `레이드 포기` (after a 1 s hold). Solo = settled as a death · tutorial = from the beginning · squad = death + drifting. */
  abandon(): void;
}

/**
 * The 「this character is inside a squad raid」 mark (it goes through `slotKey` — the session token is per slot). It is
 * written as `{code, seed}` when a squad raid starts and cleared when that raid ends for this person (extraction ·
 * failure · abandon · voluntary return · leaving the lobby). A page reload has no event that clears it, so it stays —
 * and that is exactly what 「there is a reason to ask the server from the title」 means.
 */
export const SQUAD_RAID_MARK_KEY = 'scav.squadraid';
