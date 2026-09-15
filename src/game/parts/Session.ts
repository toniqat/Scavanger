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
/* 2026-09-14: 정보상 — 솔로 이어하기가 기믹 고정을 되살린다 (docs/DECISIONS.md 「2026-09-14 — 정보상」) */
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

/**
 * 혼자 도는 **저장 대상 세션**: 릴레이에 올릴 곳이 없어 localStorage 로 대신한다 (`SoloRaid.ts`).
 *
 * 2026-09-14 (튜토리얼 개편): 튜토리얼도 여기 든다 — 새 캐릭터가 첫 레이드 도중 새로고침해도
 * 체크포인트부터 이어 해야 하기 때문이다. 훈련장은 여전히 제외다 (나갈 때 인벤토리를 통째로 되돌린다).
 * 이름은 계약처럼 쓰이고 있어 그대로 두고 뜻만 넓혔다.
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
     * 2026-09-11 (C-70): **솔로는 죽은 뒤 저장하지 않는다.** `parts/Death.onLocalDied` 가 사망 즉시 세이브를 지우는데
     * (죽는 순간 레이드는 끝났다), `DEATH_TO_SCREEN` 2.5초 창 안에 `inventory:itemAdded` · `crate:looted` 가 한 번이라도
     * 오면 방금 지운 파일이 되살아나 새로고침으로 부활할 수 있었다. 전투불능(`isDowned`)은 아직 살아 있으므로 제외한다.
     * **멀티에는 걸지 않는다** — 거기서는 빈 가방을 담은 사망 직후 저장이 바로 복제를 막는 장치다.
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
    /* 2026-09-15 (타이틀 레이드 포기): 몸이 서 있던 자리 — 새로고침한 사람이 타이틀에서 포기하면 그 시체가 여기 선다
     * (`parts/Resume.abandonSquad`). 탐사 차량 안이면 솔로 세이브와 같이 차량 옆 지면이다. */
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
 * 2026-09-15 (사용자 결정 — 「각 단계마다 자동저장」): 튜토리얼 안내가 **한 단계 넘어갈 때마다** 세이브를 한 번 강제한다.
 *
 * `RAID_SAVE_INTERVAL_S`(5초) 주기만으로는 단계 전환이 담기지 않아, 방금 배운 것을 하자마자 껐다 켜면 그 단계를
 * 다시 하게 된다. 새 이벤트는 만들지 않았다 — 단계가 바뀌는 그 자리에서 tutorial 이 이미 내는
 * `tutorial:changed` 하나면 충분하고, 그 이벤트는 스태미나 노출(`markStaminaUsed`)에도 오므로 **단계 id 가 실제로
 * 바뀐 프레임에만** 쓴다 (`sys.lastTutorialStep`).
 *
 * 저장 자체는 평소 경로(`saveRaid`)를 그대로 지난다 — 게임플레이 페이즈 · `rejoinPending` · **사망 뒤에는 저장하지
 * 않는다**(C-70 의 솔로 가드)가 전부 그대로 산다.
 */
export function saveTutorialStep(sys: GameFlowSystem, step: string | null): void {
  if (sys.ctx.missionMode !== 'tutorial') return;
  if (step === sys.lastTutorialStep) return;
  sys.lastTutorialStep = step;
  if (!step) return;            // 트랙이 끝났다 (`finish`) — 이어할 단계가 없다
  saveRaid(sys);
}

/**
 * 2026-09-15: 체크포인트를 지났다 (`tutorial:checkpoint`). 세이브의 `checkpoint` 필드가 **부활 · 이어하기 자리**를
 * 정하므로, 그것이 바뀐 프레임도 단계 전환과 같은 무게로 한 번 쓴다. `world/tutorial` 이 `index` 를 올린 **뒤에**
 * 이벤트를 내므로 `ctx.world.tutorial.checkpoint` 는 이미 새 값이다.
 */
export function saveTutorialCheckpoint(sys: GameFlowSystem): void {
  if (sys.ctx.missionMode !== 'tutorial') return;
  saveRaid(sys);
}

/** 2026-09-13: scratch for the pose saved while riding the 탐사 차량 (`PlayerRef.roverSafePosition`). */
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
  // 2026-09-13: 탐사 차량 안이면 선체 안 좌석이 아니라 차량 옆 지면을 저장한다 (복귀하면 걸어서 서 있다)
  const pos = at ?? (p.roverRide ? p.roverSafePosition?.(_roverSafe) ?? p.position : p.position);
  // 2026-09-14 (튜토리얼): 어떤 미션이었나 · 어디까지 갔나 — 둘 다 없으면 옛 세이브처럼 평범한 레이드다
  const tutorial = ctx.missionMode === 'tutorial';
  const checkpoint = tutorial ? ctx.world?.tutorial?.checkpoint ?? null : null;
  /* 2026-09-14 (정보상): 이 레이드가 쓰고 있는 기믹 고정. 보유 정보는 레이드가 끝나야 소모되므로 (`IntelRef.consume`)
   * 달리는 동안은 아직 손에 있고, 솔로라 「그 행성의 것」이면 곧 이 레이드의 것이다 — `planet` 과 같은 규약이다. */
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
 * 2026-09-15 (타이틀 이어하기): 옛 `consumeStoredSoloRaid` (첫 프레임에 곧장 이어하기 / 실패) 는 없어졌다 — 부팅은 이제
 * 타이틀에서 멈추고 `parts/Resume` 이 `이어하기` 에서만 아래 `resumeSoloRaid` 를 부른다. 세이브 파일도 부팅 때 지우지 않는다.
 */

/** Re-enter the stored solo raid: same seed / planet, blob restored on `world:ready`, body placed (no hellpod). */
export function resumeSoloRaid(sys: GameFlowSystem, save: SoloRaidSave): void {
  const ctx = sys.ctx;
  const tutorial = save.mode === 'tutorial';
  sys.rejoining = true;
  ctx.rejoinPending = true;
  ctx.missionMode = tutorial ? 'tutorial' : 'raid';
  ctx.missionPlanet = tutorial ? null : save.planet;
  /* 2026-09-14 (정보상): `missionPlanet` 과 **똑같이** `game:newMission` emit 전에 세팅한다 — 안 하면 이어한 사람만
   * 기믹이 빠진 맵을 만든다 (시드가 같아 지형은 같고 탈출구 · 지하실만 사라진다). */
  ctx.missionIntel = !tutorial && save.intel && save.intel.length ? resolveIntelEffects(save.intel) : null;
  sys.raidBlob = { seed: save.seed, missionTime: save.missionTime, stats: save.stats, inventory: save.inventory, savedAt: save.savedAt };
  sys.soloRestore = {
    position: new THREE.Vector3(save.pose.x, save.pose.y, save.pose.z),
    yaw: save.pose.yaw,
    // 튜토리얼에는 사망이 없다 — 죽은 채로 닫힌 세이브라도 살아서 체크포인트에 선다
    hp: tutorial ? Math.max(1, save.pose.hp) : save.pose.hp,
    downHp: save.pose.downHp,
    state: tutorial ? 0 : save.pose.state,
    shield: save.pose.shield,
  };
  // 2026-09-14: 월드는 새로 지어지면서 체크포인트가 `'wake'` 로 돌아간다 — `world:ready` 뒤에 되돌린다 (`parts/Phases`)
  sys.soloCheckpoint = tutorial ? save.checkpoint ?? null : null;
  ctx.bus.emit('ui:notify', {
    text: tutorial ? '튜토리얼을 이어서 진행합니다' : '중단된 레이드를 이어서 진행합니다', kind: 'warning', duration: 5,
  });
  ctx.bus.emit('game:newMission', {
    seed: save.seed, mode: tutorial ? 'tutorial' : 'raid', planet: tutorial ? undefined : (save.planet ?? undefined),
  });
  }
