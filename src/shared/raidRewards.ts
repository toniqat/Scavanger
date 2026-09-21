/**
 * Raid-end settlement contract (2026-09-21, the result screen rework — user's decisions):
 *
 * - The result screen is **paged**: ① loot value (this raid's `raidFound` value · total carried value) → ② XP cards →
 *   ③ squad contracts → ④ squadmates' player trust (squad raids only). Death / wipe uses the same screen; every XP card is
 *   multiplied by `XP_DEATH_MUL` and says so.
 * - Raid XP is no longer kills only: kills · gathering · structure discovery · map revealed % · survey progress · one card
 *   **per squadmate** for player trust · contract / quest XP.
 *
 * Owner: `game/` fills `MissionRewards.cards` / `squad` in `parts/Death.awardMissionXp`; `ui/menus` draws them.
 * Types only — no state, no imports of feature folders.
 */
import type { PlayerCode } from './social';

/** What one XP card is paid for. Add-only. */
export type RaidXpKind =
  | 'kill'        // `stats.killXp`
  | 'gather'      // gather nodes collected this raid
  | 'discover'    // structures discovered (platform · lab · outpost · crashed ship)
  | 'mapReveal'   // fog explored fraction at raid end
  | 'survey'      // one card per survey subject that gained progress this raid (`SurveyRef.raidGains`)
  | 'trust'       // one card per human squadmate — XP by the pair's player-trust level before this raid
  | 'contract';   // corp contract reward XP

export interface RaidXpCard {
  kind: RaidXpKind;
  /** Unique within one settlement (`trust:<code>`, `survey:<subjectId>`, `kill`, …) — the UI keys DOM by it. */
  id: string;
  /** Korean card title (`처치`, `채집`, `구조물 발견`, `지도 탐사`, subject name, squadmate name …). */
  title: string;
  /** Short Korean detail line (`12회`, `3곳`, `47 %`, `+18 %`, `신뢰도 Lv.2`). Optional. */
  detail?: string;
  /** Final XP of this card **after** the death multiplier and the library multiplier — the cards sum to `xpEarned`. */
  xp: number;
  /** Trust cards: who the card is about (accent for the frame colour). */
  peer?: { code: PlayerCode; name: string; accent?: string };
}

/** Page ④ row — one human squadmate who shared this raid (me excluded, androids excluded). */
export interface RaidSquadEntry {
  /** Relay peer id at settlement time (the like request targets `code`, not this). */
  peerId: string;
  code: PlayerCode;
  name: string;
  accent?: string;
  level?: number;
  shipModel?: string;
  /** Pair trust points **before** this raid's grant (the bar animates from here). */
  trustBefore: number;
  /** Points this raid adds to the pair (`PLAYER_TRUST_RAID_GAIN`, the relay applies the same). */
  trustRaidGain: number;
}

/** Page ③ row — one squad member's contract result. */
export interface RaidContractRow {
  /** Member display name (`나` for me is the UI's job — this carries the real name). */
  name: string;
  self: boolean;
  /** Korean contract label, null = that member had no contract. */
  label: string | null;
  success: boolean;
  /** `progress / target` at settlement. */
  progress: number;
  target: number;
}
