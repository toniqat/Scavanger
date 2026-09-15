import type { IntelPick, MissionStats, PlanetId } from '@/shared';
/* 2026-09-14: 튜토리얼도 같은 파일로 이어 한다 — 어떤 미션이었나 · 어디까지 갔나 */
import { TUTORIAL_CHECKPOINTS, type TutorialCheckpointId } from '@/shared';
import { slotKey } from '@/shared';
/* 2026-09-14: 정보상 — 이어하기가 **행성과 똑같이** 기믹 고정을 되살려야 같은 맵이 나온다 */
import { sanitizeIntelPicks } from '@/shared';
import { SOLO_CLOCK_BACK_TOLERANCE_MS, SOLO_CLOCK_HIGH_KEY } from '@/shared';

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
 *
 * 2026-09-11 (E-5): the local clock is no longer trusted blindly — `clockHigh` (clock went back) · a save from the
 * future · the loadout's `raidSeed` marker (the save key was deleted). See `soloRaidStatus` / `soloRaidBootStatus`.
 * ──────────────────────────────────────────────────────────────────────────── */

export const SOLO_RAID_STORAGE_KEY = 'scav.soloraid';
export const SOLO_RAID_SAVE_VERSION = 1;
/**
 * How long a closed solo raid may be resumed. Past this the run is lost (레이드 실패).
 * 2026-09-15: **튜토리얼에는 걸리지 않는다** — `soloRaidStatus` 의 첫 줄을 본다.
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
   * appended (2026-09-10): 실드. **v1 세이브에는 없다** — 생략은 0 이 아니라 "모른다"이고,
   * `PlayerRef.restoreState` 가 방탄복 최대치로 복구한다 (`PlayerRestoreState.shield` 규약과 같다).
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
   * appended (2026-09-14, 정보상): 이 레이드가 쓰고 있는 **기믹 고정**(`IntelSpec.picks`). 옛 세이브에는 없다 —
   * 생략 = 아무것도 안 샀다. `planet` 과 똑같이 복원해야 한다: 안 하면 이어한 사람만 기믹이 빠진 맵을 만든다
   * (시드는 같으니 지형은 같고 탈출구 · 지하실 · 둥지만 사라져 더 나쁘다).
   */
  intel?: IntelPick[];
  /**
   * appended (2026-09-14, 튜토리얼 개편): 이 세션이 **어떤 미션**이었나. 옛 세이브에는 없다 = `'raid'`.
   * `resumeSoloRaid` 가 이 값으로 `game:newMission {mode}` 를 낸다 — 안 실으면 튜토리얼을 이어할 때
   * 같은 시드로 **절차 생성 행성**이 만들어진다 (손으로 지은 맵이 통째로 사라진다).
   */
  mode?: 'raid' | 'tutorial';
  /**
   * appended (2026-09-14, 튜토리얼 개편): 마지막으로 지난 체크포인트. 월드는 새로 지어지면서 `'wake'` 로
   * 돌아가므로, 이 값이 없으면 이어한 사람은 **다음에 죽을 때 맨 처음으로** 밀려난다.
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
 * 2026-09-11 (E-5 — 오프라인 방어, 사용자 결정 1–3): the grace used to be `now − savedAt ≤ 5 min` on the local clock and a
 * save from the future was always fresh, so "play with the clock ahead, close, set it back" kept a run resumable forever.
 *   ① `clockHigh` (the latest `Date.now()` this slot has seen, `readClockHigh`): booting more than
 *      `SOLO_CLOCK_BACK_TOLERANCE_MS` before it means the clock went back → `stale`.
 *   ② a save more than that tolerance in the future → `stale`; a few seconds (NTP correction) still resume.
 * (③, the loadout's `raidSeed` marker, is checked by the caller — it needs `InventoryRef`.)
 * What stays open (accepted): close → set the clock back → reopen inside 5 min without having booted in between.
 *
 * **2026-09-15 (사용자 결정 — 튜토리얼은 언제 껐다 켜도 이어서 한다)**: `save.mode === 'tutorial'` 이면 위의 셋을
 * 하나도 보지 않는다. 유예도 시계 방어도 **되돌릴 진행이 있을 때**의 장치다 — 「닫고 시계를 되돌려 손실을 무르는
 * 것」을 막으려고 있는 것인데, 튜토리얼에는 잃을 전리품도 실패도 없고 요점은 「중간부터 이어서」 하나다.
 * 일주일 뒤에 켜도 `fresh` 다.
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
 * 2026-09-15: 튜토리얼에는 그 표식이 애초에 없다 — `inventory/parts/Lifecycle.onWorldReady` 가 `missionMode === 'raid'`
 * 일 때만 `markRaid` 를 부른다. 그래서 튜토리얼 세이브가 있으면 `raidSeed` 는 null 이고 이 검사는 그대로 지나간다.
 * 검사를 그대로 두는 이유: 표식이 **남아 있다면** 그것은 이어하다 만 진짜 레이드의 흔적이고, 그때는 튜토리얼
 * 세이브가 있어도 그 레이드가 잃은 것이 맞다 (`stale` = 그 레이드의 실패).
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
