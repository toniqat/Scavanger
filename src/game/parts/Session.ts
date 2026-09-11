/**
 * src/game/parts/Session.ts — **레이드 세션 저장과 복귀**.
 *
 * 솔로 레이드는 localStorage 에 5분짜리 스냅샷을 남기고(`SoloRaid.ts`), 멀티는 릴레이의 레이드
 * 저장소를 쓴다. 복귀는 `world:ready` 뒤에 인벤토리 · 스탯 · 시계를 되돌리고, 호스트가 보관하던
 * 몸이 있으면 그 자리에서 일어난다(없으면 헬포드로 떨어진다).
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
import { RESUME_GATE_BLOCKER } from '@/shared';
import { ResumeGate, installDesktopRelockHook, syncDesktopCursor } from '../ResumeGate';
import { clearSoloRaid, loadSoloRaid, saveSoloRaid, soloRaidStatus, type SoloRaidSave } from '../SoloRaid';
import { ALL_DEAD_CHECK_INTERVAL, DEATH_TO_SCREEN, DISCONNECT_ABORT_DELAY, LIFTOFF_TO_COMPLETE, MISSION_FAILS_WHEN_ALL_DEAD, THREAT_MAX, THREAT_MIN, THREAT_RAMP_SECONDS, XP_DEATH_MUL, XP_EXTRACT_BONUS, XP_PER_KILL, XP_PER_LOOT_VALUE, XP_PER_MINUTE, XP_TIME_CAP } from '../model';
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
    // (the host synced it) and only a squadmate's 구조선 brings us back.
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

/** Solo raid: no relay to upload to, so the session is mirrored into localStorage instead (`SoloRaid.ts`). */
export function isSoloRaid(sys: GameFlowSystem): boolean {
  return !sys.ctx.isMultiplayer && sys.ctx.missionMode === 'raid';
  }

/** Upload my mid-raid state so a reconnect can resume it (`RaidSessionBlob`) — or, solo, write it to localStorage. */
export function saveRaid(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (!ctx.isGameplayPhase() || ctx.rejoinPending) return;
  if (sys.isSoloRaid()) { sys.saveSolo(); return; }
  if (!sys.isRaidSession()) return;
  const net = ctx.net!;
  if (typeof net.saveRaid !== 'function') return;
  try {
    const inventory = ctx.inventory?.captureRaidState() ?? null;
    net.saveRaid({ seed: ctx.stats.seed, missionTime: ctx.missionTime, stats: { ...ctx.stats }, inventory, savedAt: Date.now() });
  } catch (e) {
    console.error('[gameflow] raid save failed', e);
  }
  sys.raidSaveTimer = RAID_SAVE_INTERVAL_S;
  }

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
  const pos = at ?? p.position;
  try {
    saveSoloRaid({
      v: 1,
      savedAt: Date.now(),
      seed: ctx.stats.seed,
      planet: ctx.missionPlanet ?? null,
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

/**
 * First frame after boot: either drop back into the stored solo raid (inside `SOLO_RAID_GRACE_MS`) or count it as
 * a 레이드 실패. Runs once — both fields are cleared before anything is emitted.
 */
export function consumeStoredSoloRaid(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  const save = sys.soloPending;
  const expired = sys.soloExpired;
  sys.soloPending = null;
  sys.soloExpired = false;
  if (ctx.phase !== 'menu') return;   // already somewhere else (a lobby resume beat us to it): leave it alone
  if (expired) {
    // Losing the kit is what `game:abort` outside a completed mission already does (inventory resets to the
    // starter and saves), so the failure needs no special case beyond the message.
    ctx.bus.emit('game:abort', {});
    ctx.bus.emit('ui:notify', { text: '복귀가 너무 늦었습니다 — 레이드 실패', kind: 'danger', duration: 6 });
    return;
  }
  if (!save) return;
  // 2026-09-11 (E-5): boot deleted the file; put it straight back (original `savedAt`, so the grace does not restart) —
  // otherwise a reload before the resumed raid's first periodic save would read the loadout marker without a save.
  saveSoloRaid(save);
  sys.resumeSoloRaid(save);
  }

/** Re-enter the stored solo raid: same seed / planet, blob restored on `world:ready`, body placed (no hellpod). */
export function resumeSoloRaid(sys: GameFlowSystem, save: SoloRaidSave): void {
  const ctx = sys.ctx;
  sys.rejoining = true;
  ctx.rejoinPending = true;
  ctx.missionMode = 'raid';
  ctx.missionPlanet = save.planet;
  sys.raidBlob = { seed: save.seed, missionTime: save.missionTime, stats: save.stats, inventory: save.inventory, savedAt: save.savedAt };
  sys.soloRestore = {
    position: new THREE.Vector3(save.pose.x, save.pose.y, save.pose.z),
    yaw: save.pose.yaw, hp: save.pose.hp, downHp: save.pose.downHp, state: save.pose.state, shield: save.pose.shield,
  };
  ctx.bus.emit('ui:notify', { text: '중단된 레이드를 이어서 진행합니다', kind: 'warning', duration: 5 });
  ctx.bus.emit('game:newMission', { seed: save.seed, mode: 'raid', planet: save.planet ?? undefined });
  }
