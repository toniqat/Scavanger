/**
 * src/game/parts/Death.ts — **사망 · 구조 · 분대 전멸**.
 *
 * **2026-09-09: 자동 부활은 없다.** 완전히 죽으면 그 자리에 시체가 서고(`parts/CorpseNet`), 들고 있던 것은
 * 전부 거기로 넘어간다. 되살아나는 길은 분대원이 부르는 **구조선**(`rescue_drop`)뿐이고, 그 착륙이
 * `rescue:landed` 로 도착한다. **분대 전원이 나가떨어지면 레이드가 실패**한다 (솔로는 죽는 즉시).
 * 끊긴 대원의 고스트도 살아 있는 것으로 세므로 판정이 단순하지 않다.
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
/* appended (2026-09-09): 시체 · 분대장 기기 */
import * as Corpse from './CorpseNet';
import * as Leader from './Leader';
/* appended (2026-09-11, C-70): 사망 직후 레이드 세션 강제 저장 — `GameFlowSystem.saveRaid` 는 private 이라 같은 parts 를 직접 부른다 */
import * as Session from './Session';
import type { GameFlowSystem } from '../GameFlowSystem';

export function onLocalDied(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (!sys.inLiveMission()) return;
  sys.boarded = false;
  // 훈련장: no failure, no respawn timer — straight back onto the arena spawn.
  if (sys.isTraining()) {
    sys.setPaused(false);
    sys.respawnTimer = -1; sys.respawnLastSec = -1;
    const spawn = ctx.world?.getPlayerSpawn();
    if (spawn) {
      ctx.bus.emit('ui:notify', { text: '시뮬레이션 재시작', kind: 'info', duration: 2 });
      ctx.bus.emit('player:respawn', { position: spawn.clone() });
    }
    return;
  }
  if (!ctx.isMultiplayer) {
    // Solo: the raid is lost the moment the player dies (Phase 7) — the death screen (레이드 실패) follows the usual delay.
    if (sys.deathTimer >= 0) return;
    /*
     * 2026-09-11 (C-12 후속, 사용자 결정 "솔로도 완전히 잃는다"): 분대 사망은 장착 임플란트의 망가진 짝을 시체에 넣지만
     * 솔로에는 되찾으러 갈 시체가 없다 — 장비 · 가방과 똑같이 **짝도 없이** 잃는다. 같은 함수가 장착을 풀고 즉시
     * 저장하므로(사망 직후 새로고침으로 되돌릴 수 없다) 돌려준 짝은 버린다.
     */
    ctx.progression?.stripImplantsForCorpse?.();
    sys.respawnTimer = -1; sys.respawnLastSec = -1;
    /*
     * 2026-09-11 (C-70): **죽는 순간 레이드는 끝났다.** 예전에는 주기 저장이 계속 돌고 세이브를 지우는 것은
     * `DEATH_TO_SCREEN`(2.5초) 뒤 `gameOver()` 였다 — 그 사이에 새로고침하면 사망 전 스냅샷으로 **완전히
     * 되살아났다**(솔로는 시체가 없어 손실이 0이다). 그래서 주기 저장을 먼저 끄고 세이브를 **즉시** 지운다.
     * `gameOver()` 의 `clearSoloRaid()` 는 멱등이라 그대로 둔다.
     */
    sys.raidSaveTimer = -1;
    clearSoloRaid();
    sys.deathTimer = DEATH_TO_SCREEN;
    sys.setPaused(false);
    return;
  }
  /*
   * Multiplayer: the phase stays — the squad (and the host simulation) keeps going, and the UI shows the spectate
   * overlay. **2026-09-09: no countdown any more** — the body becomes a lootable corpse and the only way back is a
   * squadmate's 구조선 (`rescue_drop` → `rescue:landed`). `PLAYER_RESPAWN_DELAY` / `game:respawnAvailable` stay in the
   * contract but nobody writes or reads them.
   */
  sys.respawnTimer = -1; sys.respawnLastSec = -1;
  sys.setPaused(false);
  Corpse.spawnLocalCorpse(sys);
  /*
   * 2026-09-11 (C-70): 레이드 세션을 **여기서 한 번 강제로** 저장한다. 주기 저장(`RAID_SAVE_INTERVAL_S`)과
   * 루팅에서만 올라가던 blob 은 사망 순간을 담지 못해, 죽고 나서 새로고침하면 **사망 전 가방**으로 복귀했다 —
   * 장비가 시체에도 서 있고 내 가방에도 그대로 있는 **복제 경로**다. 반드시 `spawnLocalCorpse`(=
   * `InventoryRef.stripForCorpse`) **뒤**여야 한다: 그래야 `captureRaidState()` 가 이미 빈 가방을 찍는다.
   * 페이즈는 사망해도 그대로라 `saveRaid` 의 `isGameplayPhase()` 게이트를 통과하고, `rejoinPending` 가드는 존중한다.
   */
  Session.saveRaid(sys);
  Leader.onHostDied(sys);
  const left = ctx.stratagems?.rescueLeft ?? 0;
  ctx.bus.emit('ui:notify', {
    text: left > 0 ? `전사 — 분대원의 구조선을 기다립니다 (남은 구조선 ${left})` : '전사 — 남은 구조선이 없습니다',
    kind: 'danger', duration: 5,
  });
  if (MISSION_FAILS_WHEN_ALL_DEAD) {
    sys.allDeadCheckTimer = ALL_DEAD_CHECK_INTERVAL;
    sys.checkAllDead();
  }
  }

/**
 * 2026-09-09: **비활성** — 자동 부활이 사라져 `game:respawnAvailable` 은 더 이상 발행되지 않는다.
 * 이벤트도 `PLAYER_RESPAWN_DELAY` 도 계약이라 지우지 않았을 뿐이다.
 */
export function tickRespawn(_sys: GameFlowSystem): void { /* no automatic respawn since 2026-09-09 */ }

/** 2026-09-09: **비활성** — `game:respawn` 은 아무도 발행하지 않고, 발행되더라도 무시한다. */
export function onRespawnRequest(_sys: GameFlowSystem): void { /* rescue only since 2026-09-09 */ }

/**
 * 구조 포드가 착륙했다 (`stratagems/parts/Rescue` 가 발행). **내가 대상일 때만** 반응한다 —
 * 몸을 다시 세우는 것은 `player/` 가 (헬포드 강하 · `RESCUE_REVIVE_HP` · 빈손), 여기서는 흐름만 정리한다.
 */
export function onRescueLanded(sys: GameFlowSystem, target: string): void {
  const ctx = sys.ctx;
  const me = Corpse.localPeerId(sys);
  if (target !== me) return;
  if (!sys.inLiveMission()) return;
  sys.deathTimer = -1;
  sys.respawnTimer = -1; sys.respawnLastSec = -1;
  sys.allDeadCheckTimer = -1;
  if (ctx.phase === 'deploying') sys.setPhase('playing');
  Leader.onHostRevived(sys);
  }

/** Downed (tactical kit hook): the mission keeps running — a squadmate or a defibrillator can still bring the player back. */
export function onLocalDowned(sys: GameFlowSystem): void {
  if (!sys.inLiveMission()) return;
  sys.setPaused(false);
  // The all-dead check treats a downed player as alive, but a squadmate may be dead already: re-run it
  // so a wipe that happens while we bleed out is still noticed.
  sys.allDeadCheckTimer = ALL_DEAD_CHECK_INTERVAL;
  }

export function onLocalRevived(sys: GameFlowSystem): void {
  if (!(sys.ctx.player?.isDead ?? false)) sys.allDeadCheckTimer = -1;
  }

/** True when a player is out of the fight for good — downed players are still revivable. */
export function isLocalOut(sys: GameFlowSystem): boolean {
  const p = sys.ctx.player;
  if (!p) return false;
  return p.isDead && !(p.isDowned ?? false);
  }

/**
 * Is this remote member still "in the fight"? Ghost-aware (Phase 7):
 *   - not part of the mission (`inMission` false / IN_HUB / left) → ignored (returns false);
 *   - suspended (socket down, host simulates a ghost) → alive unless the ghost is dead (`state` 2);
 *   - otherwise alive unless dead-and-not-downed (a downed peer can still be revived).
 */
export function isRemoteAlive(sys: GameFlowSystem, r: RemotePlayerRef): boolean {
  if (!r.connected || !r.inMission || (r.flags & PlayerFlags.IN_HUB) !== 0) return false;
  const downed = (r.isDowned ?? false) || (r.flags & PlayerFlags.DOWNED) !== 0;
  if (r.suspended) {
    // Phase 9: the host ghost's state sits on the ref (net's `applyGhost` / the host's own `applyToRef`)
    if (r.ghostState !== undefined) return r.ghostState !== 2;
    return !r.isDead || downed;
  }
  return !r.isDead || downed;
  }

/** Host only: nobody left alive / downed / alive-as-a-ghost → `flow over` to the squad and 레이드 실패 locally. */
export function checkAllDead(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!MISSION_FAILS_WHEN_ALL_DEAD) return;
  if (!net || !ctx.isMultiplayer || !net.isHost) return;
  if (sys.isTraining()) return;
  if (!sys.inLiveMission()) return;
  if (!sys.isLocalOut()) return;
  for (const r of net.getRemotePlayers()) if (sys.isRemoteAlive(r)) return;
  sys.allDeadCheckTimer = -1;
  net.send({ t: 'flow', ev: 'over' }, 'others');
  sys.gameOver();
  }

export function complete(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (ctx.phase === 'complete' || ctx.phase === 'dead' || ctx.phase === 'menu') return;
  // Multiplayer: a dead, downed or left-behind player still sees the result screen, but did not extract.
  const outOfAction = (ctx.player?.isDead ?? false) || (ctx.player?.isDowned ?? false);
  ctx.stats.extracted = ctx.isMultiplayer ? (sys.boarded && !outOfAction) : true;
  ctx.stats.lootValue = ctx.inventory?.getTotalValue() ?? 0;
  ctx.stats.timeSeconds = ctx.missionTime;
  ctx.stats.mode = ctx.missionMode;
  ctx.uiBlockers.delete('inventory');
  ctx.inventory?.closeAll();
  sys.completeTimer = -1;
  sys.allDeadCheckTimer = -1;
  sys.raidSaveTimer = -1;
  clearSoloRaid();          // the run is over — nothing left to resume
  ctx.progression?.clearActivePreps();   // A-13: 탈출 — 이번 레이드분 준비물은 여기서 비운다 (사망만으로는 비우지 않는다)
  sys.awardMissionXp();
  // Host: make sure every client (even one that missed the liftoff message) reaches the result screen.
  if (ctx.isMultiplayer && ctx.net?.isHost) ctx.net.send({ t: 'flow', ev: 'complete' }, 'others');
  sys.setPhase('complete');
  ctx.bus.emit('game:complete', { stats: { ...ctx.stats } });
  }

/** 레이드 실패: solo death (after DEATH_TO_SCREEN) or a squad wipe (host decision, mirrored by `flow over`). */
export function gameOver(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (ctx.phase === 'complete' || ctx.phase === 'dead' || ctx.phase === 'menu') return;
  if (sys.isTraining()) return;
  ctx.stats.extracted = false;
  ctx.stats.lootValue = ctx.inventory?.getTotalValue() ?? 0;
  ctx.stats.timeSeconds = ctx.missionTime;
  ctx.stats.mode = ctx.missionMode;
  ctx.uiBlockers.delete('inventory');
  ctx.inventory?.closeAll();
  sys.deathTimer = -1; sys.respawnTimer = -1; sys.respawnLastSec = -1;
  sys.allDeadCheckTimer = -1;
  sys.raidSaveTimer = -1;
  sys.restoreTimer = -1;
  clearSoloRaid();          // 레이드 실패 — the stored session must not resurrect the run
  ctx.progression?.clearActivePreps();   // A-13: 전멸 · 실패도 레이드의 끝이다
  ctx.rejoinPending = false;
  sys.awardMissionXp();
  const stats = { ...ctx.stats };
  ctx.bus.emit('game:raidFailed', { stats });
  sys.setPhase('dead');
  ctx.bus.emit('game:over', { stats });
  sys.autoReturnTimer = RAID_FAILED_AUTO_RETURN_S;
  }

/**
 * Bank the mission result into the persistent profile (progression/). Runs once per mission, before the
 * result screen appears, so `game:complete` / `game:over` listeners already see the new level.
 * Loot XP is only paid on a successful extraction — dying leaves the bag on the ground.
 * A 훈련장 never pays out (and never settles a contract).
 */
export function awardMissionXp(sys: GameFlowSystem): void {
  if (sys.rewarded) return;
  sys.rewarded = true;
  if (sys.isTraining()) return;
  const ctx = sys.ctx;
  const prog = ctx.progression;
  if (!prog) return;
  try {
    const s = ctx.stats;
    const extracted = s.extracted;
    let xp = Math.max(0, s.kills) * XP_PER_KILL * (extracted ? 1 : XP_DEATH_MUL);
    xp += Math.min(XP_TIME_CAP, (Math.max(0, s.timeSeconds) / 60) * XP_PER_MINUTE);
    if (extracted) xp += XP_EXTRACT_BONUS + Math.max(0, s.lootValue) * XP_PER_LOOT_VALUE;
    xp = Math.round(xp);

    // `raids` / `extractions` are plain profile counters; ProgressionRef has no setter, so bump + save.
    prog.profile.raids += 1;
    if (extracted) prog.profile.extractions += 1;
    const levelBefore = prog.level;
    // Phase 5: settle the active corp contract first — its XP reward is paid through `addXp` below.
    let contract = null;
    const meta = ctx.meta;
    if (meta && typeof meta.settleMission === 'function') {
      try { contract = meta.settleMission(s); } catch (e) { console.error('[gameflow] contract settlement failed', e); }
    }
    if (contract?.success && contract.xp > 0) xp += contract.xp;
    if (xp > 0) prog.addXp(xp);
    prog.save();
    // Result screens (ui) read the rewards from the `game:complete` / `game:over` stats payload.
    s.rewards = { xpEarned: xp, levelBefore, levelAfter: prog.level, xp: prog.xp, xpToNext: prog.xpToNext, contract };
  } catch (e) {
    console.error('[gameflow] mission XP award failed', e);
  }
  }
