import type { MissionStats, PlanetId } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * 솔로 레이드 세션 저장 (2026-09-07).
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
 *   - reopening **after** the window counts as 레이드 실패: the save is dropped and the kit resets like any other
 *     failed raid, so there is no reload-to-undo.
 *
 * It owns nothing else: the world is regenerated from the seed (procedural + deterministic), and enemies / containers
 * are not part of the snapshot — exactly the guarantees a multiplayer rejoin gives.
 * ──────────────────────────────────────────────────────────────────────────── */

export const SOLO_RAID_STORAGE_KEY = 'scav.soloraid';
export const SOLO_RAID_SAVE_VERSION = 1;
/** How long a closed solo raid may be resumed. Past this the run is lost (레이드 실패). */
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
}

export interface SoloRaidSave {
  v: number;
  /** `Date.now()` at the write — the staleness clock. */
  savedAt: number;
  seed: number;
  planet: PlanetId | null;
  missionTime: number;
  stats: MissionStats;
  /** `InventoryRef.captureRaidState()` output (opaque here, exactly like `RaidSessionBlob.inventory`). */
  inventory: unknown;
  pose: SoloRaidPose;
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
    const raw = s.getItem(SOLO_RAID_STORAGE_KEY);
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
  return {
    v: SOLO_RAID_SAVE_VERSION,
    savedAt: num(f.savedAt),
    seed: f.seed,
    planet: (typeof f.planet === 'string' ? f.planet : null) as PlanetId | null,
    missionTime: Math.max(0, num(f.missionTime)),
    stats: f.stats,
    inventory: f.inventory ?? null,
    pose: { x: num(p.x), y: num(p.y), z: num(p.z), yaw: num(p.yaw), hp: num(p.hp, 1), downHp: num(p.downHp), state },
  };
}

/** `fresh` = inside the grace window (resumable); `stale` = the run is lost. */
export function soloRaidStatus(save: SoloRaidSave | null, now: number = Date.now()): SoloRaidStatus {
  if (!save) return 'none';
  const age = now - save.savedAt;
  // a save from the future (clock moved back) is treated as fresh rather than silently destroying the run
  return age <= SOLO_RAID_GRACE_MS ? 'fresh' : 'stale';
}

/** Write the snapshot. Silently gives up when storage is blocked / full — a raid must never break on a save. */
export function saveSoloRaid(save: SoloRaidSave): void {
  const s = storage();
  if (!s) return;
  try { s.setItem(SOLO_RAID_STORAGE_KEY, JSON.stringify(save)); } catch { /* quota / blocked */ }
}

/** Drop the stored raid (extraction, failure, abort, resume consumed). */
export function clearSoloRaid(): void {
  const s = storage();
  if (!s) return;
  try { s.removeItem(SOLO_RAID_STORAGE_KEY); } catch { /* blocked */ }
}
