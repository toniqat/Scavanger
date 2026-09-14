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
  /* appended (2026-09-14, 튜토리얼 개편): 체크포인트 부활 */
  TUTORIAL_RESPAWN_DELAY_S,
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
  // 튜토리얼 (2026-09-14): 레이드 실패가 없다 — 시체는 평소대로 서고 체크포인트에서 다시 선다.
  if (sys.isTutorial()) { onTutorialDied(sys); return; }
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
    // 2026-09-13: 자발적 귀환이면 레이드 실패 화면 대신 사망 연출 뒤 곧장 함선으로 (`finishReturnToShip` 이 결산한다)
    if (sys.returnPending) sys.returnTimer = DEATH_TO_SCREEN;
    else sys.deathTimer = DEATH_TO_SCREEN;
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
  if (sys.returnPending) {
    // 2026-09-13: 자발적 귀환 — 구조선을 기다리지 않고 나간다. 분대장 기기도 떨어뜨리지 않는다: 나가면서 보내는
    // `lobby:mission false` 로 서버가 살아 있는 대원에게 분대장을 곧장 넘긴다 (기기는 주인 없는 물건으로 남는다).
    sys.returnTimer = DEATH_TO_SCREEN;
  } else {
    Leader.onHostDied(sys);
    const left = ctx.stratagems?.rescueLeft ?? 0;
    ctx.bus.emit('ui:notify', {
      text: left > 0 ? `전사 — 분대원의 구조선을 기다립니다 (남은 구조선 ${left})` : '전사 — 남은 구조선이 없습니다',
      kind: 'danger', duration: 5,
    });
  }
  if (MISSION_FAILS_WHEN_ALL_DEAD) {
    sys.allDeadCheckTimer = ALL_DEAD_CHECK_INTERVAL;
    sys.checkAllDead();
  }
  }

/* ═══════════════ 튜토리얼 체크포인트 부활 (2026-09-14, `docs/plans/tutorial-raid.md` B) ═══════════════
 *
 * 「완전한 사망에는 자동 부활이 없다」(2026-09-09)는 그대로다 — 이것은 그 규칙을 뚫는 예외가 아니라
 * `ctx.missionMode === 'tutorial'` 안에서만 사는 **별도 갈래**이고, 되살리는 수단도 이미 있는 계약
 * (`player:respawn`)이다. 훈련장 갈래(바로 위)의 형제라고 보면 된다.
 *
 * 훈련장과 다른 점 셋:
 *   ① **시체가 선다** — 장비 · 가방 · 퀵슬롯이 그 안에 남아야 주우러 갈 수 있다 (사용자 결정). 그래서
 *      체크포인트는 그 구간 적의 감지 범위 밖에 둔다 (`shared/tutorialWorld` 머리 주석의 배치 규칙).
 *   ② **세이브를 지우지 않는다** — 솔로 레이드는 죽는 순간 세션을 지우지만(C-70, 「죽는 순간 레이드는
 *      끝났다」) 튜토리얼의 사망은 끝이 아니다. 새로고침하면 체크포인트부터 이어 한다.
 *   ③ **레이드 실패가 없다** — `gameOver()` 로 가지 않고 페이즈도 그대로다.
 */
function onTutorialDied(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  sys.setPaused(false);
  sys.respawnTimer = -1; sys.respawnLastSec = -1;
  sys.deathTimer = -1;
  // 장착 임플란트는 건드리지 않는다 — 튜토리얼 사망으로 영구히 잃는 것은 없다 (솔로 레이드 갈래와 정반대다).
  Corpse.spawnLocalCorpse(sys);
  /*
   * **사망 직후 저장은 하지 않는다** (멀티 사망과 정반대이고, 그것이 옳다). 멀티에서 빈 가방을 강제로 찍는
   * 이유는 「시체에도 있고 가방에도 있는 복제」를 막기 위해서인데, 솔로 세이브에는 시체가 담기지 않으므로
   * 여기서 빈 가방을 찍으면 새로고침한 사람은 **시체도 장비도 없이** 깨어난다. `parts/Session.saveRaid` 의
   * 솔로 가드(`isDead` → 저장하지 않는다)를 그대로 통과시켜 마지막 **생전** 스냅샷을 남기고, 부활한 뒤
   * 다시 도는 주기 저장이 체크포인트 진행을 담는다. 세이브 자체를 지우지 않는 것이 이 갈래의 요점이다.
   */
  sys.tutorialRespawnTimer = TUTORIAL_RESPAWN_DELAY_S;
  /*
   * 2026-09-14 4차 — 「체크포인트에서」라고 적지 않는다. 부활 자리를 정하는 것은
   * `world/tutorial` 의 `respawnPose()` 이고, 그날부터 그것은 대개 **마지막으로 땅에 서 있던 자리**다
   * (체크포인트는 그 기록이 없을 때의 보험으로 내려갔다 — 사용자 결정). 문구가 자리를 단정하면
   * 절벽에서 떨어진 사람이 「체크포인트로 갔겠거니」 하고 엉뚱한 곳을 찾는다.
   */
  ctx.bus.emit('ui:notify', { text: '마지막으로 서 있던 자리에서 다시 시작합니다', kind: 'warning', duration: TUTORIAL_RESPAWN_DELAY_S });
  }

/**
 * `TUTORIAL_RESPAWN_DELAY_S` 가 지났다 (`GameFlowSystem.update`). 체크포인트 자리에서 다시 선다 —
 * 자리를 아는 곳은 맵을 지은 `world/tutorial` 하나뿐이라 거기 묻고, 없으면 월드 스폰으로 떨어진다.
 * `player:respawn` 계약에는 yaw 가 없으므로 바라볼 방향은 부활 **직후** `teleport` 로 한 번 돌려세운다.
 */
export function tutorialRespawn(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  sys.tutorialRespawnTimer = -1;
  if (!sys.isTutorial() || !sys.inLiveMission()) return;
  let pose: { position: THREE.Vector3; yaw: number } | null = null;
  try { pose = ctx.world?.tutorial?.respawnPose() ?? null; } catch (e) { console.error('[gameflow] tutorial respawnPose failed', e); }
  const position = pose ? pose.position : (ctx.world?.getPlayerSpawn()?.clone() ?? null);
  if (!position) return;
  ctx.bus.emit('player:respawn', { position });
  if (pose && ctx.player) {
    try { ctx.player.teleport(position, pose.yaw, false); } catch { /* 몸이 아직 없다 — 방향만 못 맞출 뿐이다 */ }
  }
  }

/**
 * 2026-09-13 — **자발적 귀환** (일시정지 메뉴 `함선으로 귀환` → 경고 팝업 → 1초 홀드, 사용자 결정).
 *
 * 레이드를 버리고 나가는 것은 **그 자리에서 죽는 것과 같다**: `PlayerRef.die()` 가 진짜 `player:died` 를 내므로
 * `onLocalDied` 가 평소대로 정리한다 — 분대면 시체가 서고 장비 · 가방 · 장착 임플란트의 망가진 짝이 거기 남고(분대원이
 * 회수한다), 솔로면 전부 잃는다. 다른 점은 둘뿐이다: 구조선 대기(분대) · 레이드 실패 화면(솔로)을 건너뛰고,
 * `DEATH_TO_SCREEN` 사망 연출 뒤 `finishReturnToShip` 이 곧장 함선으로 보낸다.
 *
 * 죽일 몸이 없거나 잃을 것이 없는 곳 — 훈련장 · 강하 중 · 결과 화면 — 은 예전처럼 곧장 `hub:enter` 다.
 * 이미 죽어 있으면(분대 관전 중) 시체는 이미 섰으므로 기다리지 않는다.
 */
export function requestReturnToShip(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (sys.returnPending) { finishReturnToShip(sys); return; }   // 사망 연출 중에 한 번 더 — 더 기다리지 않는다
  const player = ctx.player;
  const canDie = ctx.isGameplayPhase() && !sys.isTraining() && !!player && typeof player.die === 'function' && !player.isDropping;
  if (!canDie) { ctx.bus.emit('hub:enter', { ship: ctx.net?.lobby ? 'shared' : 'personal' }); return; }
  sys.returnPending = true;
  ctx.bus.emit('ui:notify', { text: '함선으로 귀환합니다', kind: 'warning', duration: DEATH_TO_SCREEN });
  if (sys.isLocalOut()) { finishReturnToShip(sys); return; }
  player.die!();   // → `player:died` → `onLocalDied` (동기) 가 손실을 정리하고 `returnTimer` 를 건다
  if (sys.returnTimer < 0) finishReturnToShip(sys);   // 사망이 흐름에 닿지 않았다 (안전망 — 그래도 나간다)
  }

/** 자발적 귀환의 끝: 이 사람의 레이드를 진짜 사망처럼 결산하고 함선으로. `returnTimer` 가 다 되면 `update` 가 부른다. */
export function finishReturnToShip(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  sys.returnTimer = -1;
  if (sys.inLiveMission() && !sys.isTraining()) {
    if (!ctx.isMultiplayer) {
      // 솔로: 레이드 실패와 같은 결산(사망 XP · 계약 정산 · 킷 리셋). 결과 화면은 아래 `hub:enter` 가 같은 프레임에 걷는다.
      sys.deathTimer = -1;
      sys.gameOver();
    } else {
      // 분대: 레이드는 분대원에게 계속된다. 사망자가 레이드 끝에 받던 결산을 지금 받고 이 사람만 빠진다 —
      // `endSession` 의 `lobby:reset`(호스트 = 분대 전체 종료)이 아니라 `lobby:mission false` 다.
      ctx.stats.extracted = false;
      ctx.stats.lootValue = ctx.inventory?.getTotalValue() ?? 0;
      ctx.stats.timeSeconds = ctx.missionTime;
      ctx.stats.mode = ctx.missionMode;
      sys.awardMissionXp();
      if (typeof ctx.net?.leaveMission === 'function') ctx.net.leaveMission();
    }
  }
  // 전멸 · 탈출로 결과 화면이 이미 떴어도 같은 길이다. `onAbort` 가 `returnPending` 을 보고 `flow abort` 를 보내지 않는다.
  ctx.bus.emit('hub:enter', { ship: ctx.net?.lobby ? 'shared' : 'personal' });
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
  // A dead, downed or left-behind player still sees the result screen (the squad was done), but did not extract.
  // 2026-09-13 (탈출 개편): only the liftoff's `aboard` counts — solo too, since a solo player can now miss the ship.
  const outOfAction = (ctx.player?.isDead ?? false) || (ctx.player?.isDowned ?? false);
  ctx.stats.extracted = sys.aboardAtLiftoff && !outOfAction;
  // 2026-09-13: riders who leave while squadmates play on step out of the mission at their result screen (below) — the
  // raid is not over for the others, so no `flow complete` and no lobby reset.
  const leaveAlone = ctx.isMultiplayer && sys.aboardAtLiftoff && !sys.squadExtraction;
  ctx.stats.lootValue = ctx.inventory?.getTotalValue() ?? 0;
  ctx.stats.timeSeconds = ctx.missionTime;
  ctx.stats.mode = ctx.missionMode;
  ctx.uiBlockers.delete('inventory');
  ctx.inventory?.closeAll();
  sys.completeTimer = -1;
  sys.allDeadCheckTimer = -1;
  sys.raidSaveTimer = -1;
  sys.tutorialRespawnTimer = -1;   // 2026-09-14
  clearSoloRaid();          // the run is over — nothing left to resume
  ctx.progression?.clearActivePreps();   // A-13: 탈출 — 이번 레이드분 준비물은 여기서 비운다 (사망만으로는 비우지 않는다)
  sys.awardMissionXp();
  // Host: make sure every client (even one that missed the liftoff message) reaches the result screen — only when the raid
  // really ended for the squad (2026-09-13).
  if (ctx.isMultiplayer && ctx.net?.isHost && !leaveAlone) ctx.net.send({ t: 'flow', ev: 'complete' }, 'others');
  sys.setPhase('complete');
  ctx.bus.emit('game:complete', { stats: { ...ctx.stats } });
  /*
   * 2026-09-13: `lobby:mission false` — the server hands the host role to a squadmate still in the raid (same path as
   * `finishReturnToShip`). Done after the settlement above so nothing of ours is uploaded into a raid we left, and after the
   * result screen is up; the extraction flow of the ones left behind resets a second later (`LEFT_BEHIND_RESET_S`).
   */
  if (leaveAlone && typeof ctx.net?.leaveMission === 'function') ctx.net.leaveMission();
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
  sys.tutorialRespawnTimer = -1;   // 2026-09-14
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
 * 2026-09-13 (서재 시리즈, docs/plans/library-series-games.md): 서재 효과의 레이드 경험치 배율 `1 + raidXp`.
 * housing 이 합산을 모르면(병렬 작업 · 스켈레톤) 1. 음수 · NaN 은 0 으로 본다.
 */
export function libraryRaidXpMul(ctx: GameContext): number {
  const h = ctx.housing;
  if (!h || typeof h.getLibraryEffects !== 'function') return 1;
  let add = 0;
  try { add = Number(h.getLibraryEffects()?.raidXp ?? 0); } catch { add = 0; }
  return 1 + (Number.isFinite(add) && add > 0 ? add : 0);
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
    // 2026-09-13 (서재 시리즈): 레이드 경험치 책 — `raidXp` 는 배율 가산이다 (0.1 = +10 %). 레이드 몫(처치 · 시간 · 탈출 · 전리품)에만
    // 곱하고 아래 계약 보상 XP 에는 곱하지 않는다 — 계약 보상은 `contracts.csv` 의 고정값이다.
    xp = Math.round(xp * libraryRaidXpMul(ctx));

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
