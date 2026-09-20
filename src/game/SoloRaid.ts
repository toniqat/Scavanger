import type { IntelPick, MissionStats, PlanetId } from '@/shared';
/* 2026-09-14: the tutorial resumes from this same file — which mission it was · how far it got */
import { TUTORIAL_CHECKPOINTS, type TutorialCheckpointId } from '@/shared';
import { slotKey } from '@/shared';
/* 2026-09-14: the intel broker — a resume restores fixed gimmicks **exactly like the planet**, or the map differs */
import { sanitizeIntelPicks } from '@/shared';
import { SOLO_CLOCK_BACK_TOLERANCE_MS, SOLO_CLOCK_HIGH_KEY } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * The solo raid session save (2026-09-07).
 *
 * A multiplayer raid already survives a dropped socket: the relay holds the lobby slot, the host parks the body and
 * `welcome.raid` hands the mid-raid inventory back. A **solo** raid had none of that — closing the tab (or a crash)
 * simply threw the run away, and reopening the game dropped the player at the title with their pre-raid loadout, so a
 * bad moment could be undone by reloading.
 *
 * This module is the solo equivalent, written to localStorage next to `scav.loadout` / `scav.stash`:
 *   - `GameFlowSystem` writes a snapshot every `RAID_SAVE_INTERVAL_S` and on loot while a solo raid is live;
 *   - reopening the game **within `SOLO_RAID_GRACE_MS`** resumes that raid — same seed, planet, mission clock, stats,
 *     inventory and body pose (no hellpod);
 *   - reopening **after** the window counts as a raid failure: the save is dropped and the kit resets like any other
 *     failed raid, so there is no reload-to-undo.
 *
 * It owns nothing else: the world is regenerated from the seed (procedural + deterministic), and enemies / containers
 * are not part of the snapshot — exactly the guarantees a multiplayer rejoin gives.
 *
 * 2026-09-11 (E-5): the local clock is no longer trusted blindly — `clockHigh` (clock went back) · a save from the
 * future · the loadout's `raidSeed` marker (the save key was deleted). See `soloRaidStatus` / `soloRaidBootStatus`.
 * ──────────────────────────────────────────────────────────────────────────── */

export const SOLO_RAID_STORAGE_KEY = 'scav.soloraid';
export const SOLO_RAID_SAVE_VERSION = 1;
/**
 * How long a closed solo raid may be resumed. Past this the run is lost (a raid failure).
 * 2026-09-15: **the tutorial is not held to it** — see the first line of `soloRaidStatus`.
 */
export const SOLO_RAID_GRACE_MS = 5 * 60 * 1000;

/** Body pose as `PlayerRef.restoreState` wants it, but plain-JSON (no `THREE.Vector3`). */
export interface SoloRaidPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  downHp: number;
  /** 0 alive · 1 downed · 2 dead. */
  state: 0 | 1 | 2;
  /**
   * appended (2026-09-10): the shield. **A v1 save has none** — an omission is not 0 but "unknown", and
   * `PlayerRef.restoreState` restores it to the armor maximum (the same contract as `PlayerRestoreState.shield`).
   */
  shield?: number;
}

export interface SoloRaidSave {
  v: number;
  /** `Date.now()` at the write — the staleness clock. */
  savedAt: number;
  seed: number;
  planet: PlanetId | null;
  missionTime: number;
  stats: MissionStats;
  /**
   * `InventoryRef.captureRaidState()` output (opaque here, exactly like `RaidSessionBlob.inventory`). 2026-09-11 (C-61):
   * it carries the once-per-raid bag wear mark (`bagWorn`) too, so a resumed solo raid never wears the bag twice —
   * this file stores the blob untouched (`loadSoloRaid` keeps `f.inventory` as is) and needs no field of its own.
   */
  inventory: unknown;
  pose: SoloRaidPose;
  /**
   * appended (2026-09-14, the intel broker): the **fixed gimmicks** this raid is running on (`IntelSpec.picks`). An
   * old save has none — omitted = nothing was bought. It has to be restored exactly like `planet`: without that, only
   * the player who resumed builds a map with no gimmicks (the seed is the same, so the terrain matches and only the
   * extraction pads · the basements · the nests disappear, which is worse).
   */
  intel?: IntelPick[];
  /**
   * appended (2026-09-14, the tutorial rework): **which mission** this session was. An old save has none = `'raid'`.
   * `resumeSoloRaid` emits `game:newMission {mode}` from this value — without it, resuming the tutorial builds
   * a **procedural planet** from the same seed (the hand-built map disappears entirely).
   */
  mode?: 'raid' | 'tutorial';
  /**
   * appended (2026-09-14, the tutorial rework): the last checkpoint passed. The world is rebuilt and goes back to
   * `'wake'`, so without this value the player who resumed is pushed **all the way back on their next death**.
   */
  checkpoint?: TutorialCheckpointId;
}

/** How a stored save reads right now. */
export type SoloRaidStatus = 'none' | 'fresh' | 'stale';

/** localStorage, or null when it is unavailable (private mode, sandbox, quota). */
function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__scav_solo_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Read + sanitise the stored solo raid; null when missing, corrupt or from another save version. */
export function loadSoloRaid(): SoloRaidSave | null {
  const s = storage();
  if (!s) return null;
  let file: unknown;
  try {
    const raw = s.getItem(slotKey(SOLO_RAID_STORAGE_KEY));
    if (!raw) return null;
    file = JSON.parse(raw);
  } catch { return null; }
  if (!file || typeof file !== 'object') return null;
  const f = file as Partial<SoloRaidSave>;
  if (f.v !== SOLO_RAID_SAVE_VERSION) return null;
  if (typeof f.seed !== 'number' || !Number.isFinite(f.seed)) return null;
  if (!f.stats || typeof f.stats !== 'object') return null;
  const p = f.pose;
  if (!p || typeof p !== 'object') return null;
  const state = p.state === 1 || p.state === 2 ? p.state : 0;
  const intel = sanitizeIntelPicks(f.intel);
  const mode = f.mode === 'tutorial' ? 'tutorial' : 'raid';
  const checkpoint = TUTORIAL_CHECKPOINTS.includes(f.checkpoint as TutorialCheckpointId) ? f.checkpoint as TutorialCheckpointId : null;
  return {
    v: SOLO_RAID_SAVE_VERSION,
    savedAt: num(f.savedAt),
    seed: f.seed,
    planet: (typeof f.planet === 'string' ? f.planet : null) as PlanetId | null,
    ...(intel.length ? { intel } : {}),
    ...(mode === 'tutorial' ? { mode } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    missionTime: Math.max(0, num(f.missionTime)),
    stats: f.stats,
    inventory: f.inventory ?? null,
    pose: {
      x: num(p.x), y: num(p.y), z: num(p.z), yaw: num(p.yaw), hp: num(p.hp, 1), downHp: num(p.downHp), state,
      ...(typeof p.shield === 'number' && Number.isFinite(p.shield) ? { shield: Math.max(0, p.shield) } : {}),
    },
  };
}

/**
 * `fresh` = inside the grace window (resumable); `stale` = the run is lost.
 *
 * 2026-09-11 (E-5 — the offline defence, user's decisions 1–3): the grace used to be `now − savedAt ≤ 5 min` on the
 * local clock and a save from the future was always fresh, so "play with the clock ahead, close, set it back" kept a
 * run resumable forever.
 *   ① `clockHigh` (the latest `Date.now()` this slot has seen, `readClockHigh`): booting more than
 *      `SOLO_CLOCK_BACK_TOLERANCE_MS` before it means the clock went back → `stale`.
 *   ② a save more than that tolerance in the future → `stale`; a few seconds (NTP correction) still resume.
 * (③, the loadout's `raidSeed` marker, is checked by the caller — it needs `InventoryRef`.)
 * What stays open (accepted): close → set the clock back → reopen inside 5 min without having booted in between.
 *
 * **2026-09-15 (user's decision — the tutorial resumes whenever it is closed and reopened)**: with
 * `save.mode === 'tutorial'` none of the three above is read. Both the grace and the clock defence are devices for
 * **when there is progress to undo** — they are there to stop 「closing, putting the clock back and undoing a loss」,
 * and the tutorial has neither loot to lose nor a failure; its one point is 「carry on from the middle」. Opened a
 * week later it is still `fresh`.
 */
export function soloRaidStatus(save: SoloRaidSave | null, now: number = Date.now(), clockHigh = 0): SoloRaidStatus {
  if (!save) return 'none';
  if (save.mode === 'tutorial') return 'fresh';
  const age = now - save.savedAt;
  if (age < -SOLO_CLOCK_BACK_TOLERANCE_MS) return 'stale';
  if (clockHigh > 0 && now < clockHigh - SOLO_CLOCK_BACK_TOLERANCE_MS) return 'stale';
  // a save a few seconds in the future (NTP moved the clock back a little) is still fresh
  return age <= SOLO_RAID_GRACE_MS ? 'fresh' : 'stale';
}

/**
 * E-5 ③: how the boot reads the stored raid together with the loadout's solo raid marker (`InventoryRef.soloRaidSeed`).
 * A marker whose save is gone (the key was deleted) or belongs to another seed is a lost run exactly like a stale save.
 *
 * 2026-09-15: the tutorial never has that marker in the first place — `inventory/parts/Lifecycle.onWorldReady` calls
 * `markRaid` only while `missionMode === 'raid'`. So with a tutorial save `raidSeed` is null and this check passes
 * straight through. Why the check is kept: a marker that **is** still there is the trace of a real raid left
 * half-resumed, and then, tutorial save or not, that raid is the one that was lost (`stale` = its failure).
 */
export function soloRaidBootStatus(save: SoloRaidSave | null, raidSeed: number | null, now: number = Date.now(), clockHigh = 0): SoloRaidStatus {
  const status = soloRaidStatus(save, now, clockHigh);
  if (raidSeed !== null && (!save || save.seed !== raidSeed)) return 'stale';
  return status;
}

/** E-5 ①: the latest `Date.now()` recorded for this slot (0 = never). */
export function readClockHigh(): number {
  const s = storage();
  if (!s) return 0;
  try {
    const v = Number(s.getItem(slotKey(SOLO_CLOCK_HIGH_KEY)));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
}

/**
 * E-5 ①: record `now` if it is later than what is stored (boot · every solo raid save · saves in the ship). `reset`
 * writes `now` unconditionally — used when a **new** solo raid starts, so a clock that once ran far ahead (then
 * corrected) does not fail every later resume; a run already pending was judged at boot before that can happen.
 */
export function bumpClockHigh(now: number = Date.now(), reset = false): void {
  const s = storage();
  if (!s || !Number.isFinite(now) || now <= 0) return;
  try {
    if (!reset && now <= readClockHigh()) return;
    s.setItem(slotKey(SOLO_CLOCK_HIGH_KEY), String(Math.floor(now)));
  } catch { /* quota / blocked */ }
}

/** Write the snapshot. Silently gives up when storage is blocked / full — a raid must never break on a save. */
export function saveSoloRaid(save: SoloRaidSave): void {
  const s = storage();
  if (!s) return;
  try { s.setItem(slotKey(SOLO_RAID_STORAGE_KEY), JSON.stringify(save)); } catch { /* quota / blocked */ }
  bumpClockHigh();
}

/** Drop the stored raid (extraction, failure, abort, resume consumed). */
export function clearSoloRaid(): void {
  const s = storage();
  if (!s) return;
  try { s.removeItem(slotKey(SOLO_RAID_STORAGE_KEY)); } catch { /* blocked */ }
}
