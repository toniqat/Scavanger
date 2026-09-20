/**
 * src/game/parts/Session.ts — **raid session save and resume**.
 *
 * A solo raid leaves a snapshot with a five-minute life in localStorage (`SoloRaid.ts`); multiplayer
 * uses the relay's raid store. A resume restores inventory · stats · the clock after `world:ready`, and
 * stands up where the body the host parked stood (with none, it drops in by hellpod).
 */
import * as THREE from 'three';
import type {
  GameContext, GameSystem, GamePhase, FlowMessage, PeerId, MissionMode, RaidSessionBlob, PlayerRestoreState, RemotePlayerRef,
} from '@/shared';
import type { PlanetId } from '@/shared';
import {
  GameContext as Ctx, Keys, PlayerFlags, PLAYER_RESPAWN_DELAY, RAID_FAILED_AUTO_RETURN_S, RAID_SAVE_INTERVAL_S,
  NET_GHOST_RESTORE_TIMEOUT_S,
} from '@/shared';
import { FREE_CURSOR_BLOCKER } from '@/shared';
/* 2026-09-14: the intel broker — a solo resume restores fixed gimmicks (docs/DECISIONS.md 「2026-09-14 — 정보상」) */
import { resolveIntelEffects } from '@/shared';
import { RESUME_GATE_BLOCKER } from '@/shared';
import { ResumeGate, installDesktopRelockHook, syncDesktopCursor } from '../ResumeGate';
import { clearSoloRaid, loadSoloRaid, saveSoloRaid, soloRaidStatus, type SoloRaidSave } from '../SoloRaid';
import { ALL_DEAD_CHECK_INTERVAL, DEATH_TO_SCREEN, DISCONNECT_ABORT_DELAY, LIFTOFF_TO_COMPLETE, MISSION_FAILS_WHEN_ALL_DEAD, THREAT_MAX, THREAT_MIN, THREAT_RAMP_SECONDS } from '../model';
import type { GameFlowSystem } from '../GameFlowSystem';

/** `ghost restore` from the host: stand where the ghost was; a dead ghost enters the respawn flow. */
export function onGhostRestore(sys: GameFlowSystem, state: PlayerRestoreState): void {
  const ctx = sys.ctx;
  if (!ctx.rejoinPending && sys.restoreTimer < 0) return;
  if (!sys.inLiveMission()) return;
  sys.restoreTimer = -1;
  ctx.rejoinPending = false;
  sys.rejoining = false;
  try { ctx.player?.restoreState(state); } catch (e) { console.error('[gameflow] restoreState failed', e); }
  if (ctx.phase === 'deploying') sys.setPhase('playing');
  if (state.state === 2) {
    // Our body bled out while we were away. 2026-09-09: no countdown — the corpse already stands where we fell
    // (the host synced it) and only a squadmate's rescue drop brings us back.
    sys.respawnTimer = -1; sys.respawnLastSec = -1;
    ctx.bus.emit('ui:notify', { text: '전사 상태로 복귀 — 분대원의 구조선을 기다립니다', kind: 'danger', duration: 4 });
    sys.allDeadCheckTimer = ALL_DEAD_CHECK_INTERVAL;
    sys.checkAllDead();
  } else {
    ctx.bus.emit('ui:notify', { text: '임무 복귀', kind: 'success', duration: 2.5 });
  }
  }

/** No `ghost restore` within NET_GHOST_RESTORE_TIMEOUT_S → normal hellpod drop at the mission spawn. */
export function restoreFallback(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  sys.restoreTimer = -1;
  ctx.rejoinPending = false;
  sys.rejoining = false;
  if (!sys.inLiveMission()) return;
  const spawn = ctx.world?.getPlayerSpawn();
  if (spawn) ctx.player?.respawn(spawn.clone());
  }

/* ── Raid session (multiplayer raid only) ────────────────────────────── */
export function isRaidSession(sys: GameFlowSystem): boolean {
  return sys.ctx.isMultiplayer && sys.ctx.missionMode === 'raid' && !!sys.ctx.net;
  }

/**
 * A **session worth saving** that runs alone: nowhere to upload it, so localStorage stands in (`SoloRaid.ts`).
 *
 * 2026-09-14 (the tutorial rework): the tutorial counts here too — a new character that reloads during
 * its first raid has to carry on from the checkpoint. The training range is still excluded (leaving it
 * restores the whole inventory). The name is used like a contract, so it was left alone and only its
 * meaning widened.
 */
export function isSoloRaid(sys: GameFlowSystem): boolean {
  if (sys.ctx.isMultiplayer) return false;
  return sys.ctx.missionMode === 'raid' || sys.ctx.missionMode === 'tutorial';
  }

/** Upload my mid-raid state so a reconnect can resume it (`RaidSessionBlob`) — or, solo, write it to localStorage. */
export function saveRaid(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (!ctx.isGameplayPhase() || ctx.rejoinPending) return;
  if (sys.isSoloRaid()) {
    /*
     * 2026-09-11 (C-70): **a solo raid never saves after death.** `parts/Death.onLocalDied` clears the save the
     * moment the player dies (death is the end of that raid), but one `inventory:itemAdded` · `crate:looted`
     * inside the 2.5 s `DEATH_TO_SCREEN` window brought the file just cleared back, and a reload revived the
     * player. Downed (`isDowned`) is still alive, so it is excluded. **Multiplayer is not held to this** — there
     * the save right after death, holding the emptied bag, is exactly what stops duplication.
     */
    const p = ctx.player;
    if (p?.isDead && !(p.isDowned ?? false)) return;
    sys.saveSolo(); return;
  }
  if (!sys.isRaidSession()) return;
  const net = ctx.net!;
  if (typeof net.saveRaid !== 'function') return;
  try {
    const inventory = ctx.inventory?.captureRaidState() ?? null;
    const blob: RaidSessionBlob = { seed: ctx.stats.seed, missionTime: ctx.missionTime, stats: { ...ctx.stats }, inventory, savedAt: Date.now() };
    /* 2026-09-15 (abandoning from the title): the spot the body stood on — when someone who reloaded abandons from
     * the title, their corpse stands here (`parts/Resume.abandonSquad`). On a rover it is the ground beside it, the
     * same as in the solo save. */
    const p = ctx.player;
    if (p) {
      const pos = p.roverRide ? p.roverSafePosition?.(_roverSafe) ?? p.position : p.position;
      blob.pose = { x: pos.x, y: pos.y, z: pos.z, yaw: p.yaw, state: p.isDead && !(p.isDowned ?? false) ? 2 : (p.isDowned ?? false) ? 1 : 0 };
    }
    net.saveRaid(blob);
  } catch (e) {
    console.error('[gameflow] raid save failed', e);
  }
  sys.raidSaveTimer = RAID_SAVE_INTERVAL_S;
  }

/**
 * 2026-09-15 (user's decision — 「각 단계마다 자동저장」): the tutorial guide forces one save **every time a step is
 * crossed**.
 *
 * The `RAID_SAVE_INTERVAL_S` (5 s) period alone does not capture a step transition, so turning the game off and on
 * right after doing what was just taught makes that step repeat. No new event was made — the one
 * `tutorial:changed` the tutorial already emits at the step change is enough, and since that event arrives on
 * stamina being revealed (`markStaminaUsed`) too, it is used **only on the frame the step id really changed**
 * (`sys.lastTutorialStep`).
 *
 * The save itself takes the usual path (`saveRaid`) unchanged — a gameplay phase · `rejoinPending` · **no saving
 * after death** (C-70's solo guard) all stay alive.
 */
export function saveTutorialStep(sys: GameFlowSystem, step: string | null): void {
  if (sys.ctx.missionMode !== 'tutorial') return;
  if (step === sys.lastTutorialStep) return;
  sys.lastTutorialStep = step;
  if (!step) return;            // the track finished (`finish`) — no step left to carry on from
  saveRaid(sys);
}

/**
 * 2026-09-15: a checkpoint was passed (`tutorial:checkpoint`). The save's `checkpoint` field decides **where a
 * respawn · a resume stands**, so the frame it changes on is written once too, with the same weight as a step
 * transition. `world/tutorial` emits the event **after** raising `index`, so `ctx.world.tutorial.checkpoint`
 * already holds the new value.
 */
export function saveTutorialCheckpoint(sys: GameFlowSystem): void {
  if (sys.ctx.missionMode !== 'tutorial') return;
  saveRaid(sys);
}

/** 2026-09-13: scratch for the pose saved while riding the rover (`PlayerRef.roverSafePosition`). */
const _roverSafe = new THREE.Vector3();

/** Mirror the live solo raid (seed / planet / clock / stats / inventory / body) into localStorage. */
export function saveSolo(sys: GameFlowSystem): void {
  saveSoloAt(sys, null);
  }

/**
 * `saveSolo` with the body placed at `at` instead of where it is (2026-09-11, E-5: the first snapshot of a new solo raid
 * is written at `world:ready`, while the player is still up in the hellpod — standing at the spawn is the resume pose).
 */
export function saveSoloAt(sys: GameFlowSystem, at: THREE.Vector3 | null): void {
  const ctx = sys.ctx;
  const p = ctx.player;
  if (!p) return;
  // 2026-09-13: on a rover the ground beside it is saved, not the seat inside the hull (a resume stands on foot)
  const pos = at ?? (p.roverRide ? p.roverSafePosition?.(_roverSafe) ?? p.position : p.position);
  // 2026-09-14 (tutorial): which mission it was · how far it got — with neither, a plain raid like an old save
  const tutorial = ctx.missionMode === 'tutorial';
  const checkpoint = tutorial ? ctx.world?.tutorial?.checkpoint ?? null : null;
  /* 2026-09-14 (the intel broker): the fixed gimmicks this raid is running on. Intel held is consumed only once the
   * raid ends (`IntelRef.consume`), so it is still in hand while the raid runs, and solo 「belonging to that planet」
   * means belonging to this raid — the same contract as `planet`. */
  const held = ctx.meta?.intel?.get?.() ?? null;
  const picks = held && held.planet === (ctx.missionPlanet ?? null) ? held.picks : null;
  try {
    saveSoloRaid({
      v: 1,
      savedAt: Date.now(),
      seed: ctx.stats.seed,
      planet: ctx.missionPlanet ?? null,
      ...(picks && picks.length ? { intel: picks } : {}),
      ...(tutorial ? { mode: 'tutorial' as const } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      missionTime: ctx.missionTime,
      stats: { ...ctx.stats },
      inventory: ctx.inventory?.captureRaidState() ?? null,
      pose: {
        x: pos.x, y: pos.y, z: pos.z, yaw: p.yaw,
        hp: p.hp, downHp: p.downHp,
        shield: p.shield,
        state: p.isDead ? 2 : p.isDowned ? 1 : 0,
      },
    });
  } catch (e) {
    console.error('[gameflow] solo raid save failed', e);
  }
  sys.raidSaveTimer = RAID_SAVE_INTERVAL_S;
  }

/*
 * 2026-09-15 (title resume): the old `consumeStoredSoloRaid` (resume / fail straight on the first frame) is gone
 * — the boot now stops at the title and `parts/Resume` calls `resumeSoloRaid` below only from `이어하기`. The
 * save file is not
 * deleted at boot either.
 */

/** Re-enter the stored solo raid: same seed / planet, blob restored on `world:ready`, body placed (no hellpod). */
export function resumeSoloRaid(sys: GameFlowSystem, save: SoloRaidSave): void {
  const ctx = sys.ctx;
  const tutorial = save.mode === 'tutorial';
  sys.rejoining = true;
  ctx.rejoinPending = true;
  ctx.missionMode = tutorial ? 'tutorial' : 'raid';
  ctx.missionPlanet = tutorial ? null : save.planet;
  /* 2026-09-14 (the intel broker): set **exactly like** `missionPlanet`, before `game:newMission` is emitted —
   * without
   * it, only the player who resumed builds a map with no gimmicks (the seed is the same, so the terrain matches and
   * only the extraction pads · the basements disappear). */
  ctx.missionIntel = !tutorial && save.intel && save.intel.length ? resolveIntelEffects(save.intel) : null;
  sys.raidBlob = { seed: save.seed, missionTime: save.missionTime, stats: save.stats, inventory: save.inventory, savedAt: save.savedAt };
  sys.soloRestore = {
    position: new THREE.Vector3(save.pose.x, save.pose.y, save.pose.z),
    yaw: save.pose.yaw,
    // the tutorial has no death — even a save closed while dead stands alive at the checkpoint
    hp: tutorial ? Math.max(1, save.pose.hp) : save.pose.hp,
    downHp: save.pose.downHp,
    state: tutorial ? 0 : save.pose.state,
    shield: save.pose.shield,
  };
  // 2026-09-14: a rebuilt world puts the checkpoint back to `'wake'` — restored after `world:ready` (`parts/Phases`)
  sys.soloCheckpoint = tutorial ? save.checkpoint ?? null : null;
  ctx.bus.emit('ui:notify', {
    text: tutorial ? '튜토리얼을 이어서 진행합니다' : '중단된 레이드를 이어서 진행합니다', kind: 'warning', duration: 5,
  });
  ctx.bus.emit('game:newMission', {
    seed: save.seed, mode: tutorial ? 'tutorial' : 'raid', planet: tutorial ? undefined : (save.planet ?? undefined),
  });
  }
