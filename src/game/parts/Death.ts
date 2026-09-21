/**
 * src/game/parts/Death.ts — **death · rescue · the squad wipe**.
 *
 * **2026-09-09: there is no automatic revive.** A full death spawns a corpse on the spot (`parts/CorpseNet`) and
 * everything carried moves into it. The only way back is the **rescue drop** (`rescue_drop`) a squadmate calls,
 * and its landing arrives as `rescue:landed`. **The raid fails once the whole squad is out** (solo: the moment it
 * dies). A disconnected member's ghost counts as alive too, so the check is not a simple one.
 * 2026-09-16 (user's decision): 「everyone」 includes **the androids** — even with every human down, one standing
 * android comes to get them up, so it is not a failure yet (`checkAllDead`).
 */
import * as THREE from 'three';
import type { GameContext, RemotePlayerRef } from '@/shared';
import {
  PlayerFlags, RAID_FAILED_AUTO_RETURN_S,
  /* appended (2026-09-14, the tutorial rework): checkpoint respawn */
  TUTORIAL_RESPAWN_DELAY_S,
  /* appended (2026-09-15, A-17): the fixed reward for completing the tutorial */
  TUTORIAL_RAID_XP,
  /* appended (2026-09-16): raid XP = kill XP only — the multiplier for a raid that did not extract */
  XP_DEATH_MUL,
} from '@/shared';
/* appended (2026-09-15): the tutorial respawn wake */
import { TUTORIAL_RESPAWN_WAKE_S } from '@/shared';
/* appended (2026-09-15): android squadmates — a bot member is left out of the all-dead check */
import { isAndroidId } from '@/shared';
import { clearSoloRaid } from '../SoloRaid';
import { ALL_DEAD_CHECK_INTERVAL, DEATH_TO_SCREEN, MISSION_FAILS_WHEN_ALL_DEAD } from '../model';
/* appended (2026-09-09): corpses · the squad-leader device */
import * as Corpse from './CorpseNet';
import * as Leader from './Leader';
/* appended (2026-09-11, C-70): the forced raid-session save right after death — `GameFlowSystem.saveRaid` is
   private, so the same `parts` module is called directly */
import * as Session from './Session';
import type { GameFlowSystem } from '../GameFlowSystem';

export function onLocalDied(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (!sys.inLiveMission()) return;
  sys.boarded = false;
  // Training range: no failure, no respawn timer — straight back onto the arena spawn.
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
  // Tutorial (2026-09-14): there is no raid failure — the corpse stands as usual and the player stands up again
  // at the checkpoint.
  if (sys.isTutorial()) { onTutorialDied(sys); return; }
  if (!ctx.isMultiplayer) {
    // Solo: the raid is lost the moment the player dies (Phase 7) — the death screen (레이드 실패) follows the usual delay.
    /*
     * 2026-09-16 (the android all-dead check): solo still **fails the moment it dies** — that is not an oversight.
     * An android is a bot member of the relay, so a raid with a lobby is already `isMultiplayer` (= the
     * `checkAllDead` branch below). The only android that reaches here is the dev cheat `/android` running without
     * a server, and a cheat does not change the failure decision.
     */
    if (sys.deathTimer >= 0) return;
    /*
     * 2026-09-11 (C-12 follow-up, user's decision "솔로도 완전히 잃는다"): a squad death puts the broken pair of every
     * equipped implant into the corpse, but solo has no corpse to go back for — they are lost like the equipment
     * and the bag, **without the pair**. The same function unequips and saves immediately (a reload right after
     * death cannot undo it), so the pair it hands back is thrown away.
     */
    ctx.progression?.stripImplantsForCorpse?.();
    sys.respawnTimer = -1; sys.respawnLastSec = -1;
    /*
     * 2026-09-11 (C-70): **the raid is over the moment the player dies.** The periodic save used to keep running
     * and the save was cleared only by `gameOver()` after `DEATH_TO_SCREEN` — a reload in between brought
     * the player **fully back** from the pre-death snapshot (solo has no corpse, so the loss is 0). So the periodic
     * save is turned off first and the save is cleared **immediately**. `gameOver()`'s `clearSoloRaid()` is
     * idempotent, so it is left alone.
     */
    sys.raidSaveTimer = -1;
    clearSoloRaid();
    // 2026-09-13: on a voluntary return the death cutscene leads to the ship. Solo still settles through
    // `finishReturnToShip` → `gameOver()`, so the `레이드 실패` screen **is** raised — the `hub:enter` of the same
    // frame takes it down again, so nobody sees it.
    if (sys.returnPending) sys.returnTimer = DEATH_TO_SCREEN;
    else sys.deathTimer = DEATH_TO_SCREEN;
    sys.setPaused(false);
    return;
  }
  /*
   * Multiplayer: the phase stays — the squad (and the host simulation) keeps going, and the UI shows the spectate
   * overlay. **2026-09-09: no countdown any more** — the body becomes a lootable corpse and the only way back is a
   * squadmate's rescue drop (`rescue_drop` → `rescue:landed`). `PLAYER_RESPAWN_DELAY` / `game:respawnAvailable`
   * stay in the contract but nobody writes or reads them.
   */
  sys.respawnTimer = -1; sys.respawnLastSec = -1;
  sys.setPaused(false);
  Corpse.spawnLocalCorpse(sys);
  /*
   * 2026-09-11 (C-70): the raid session is saved **once, forcibly, here**. A blob that only went up on the
   * periodic save (`RAID_SAVE_INTERVAL_S`) and on looting never captured the moment of death, so a reload after
   * dying came back with the **pre-death bag** — a **duplication path**, the gear standing in the corpse and still
   * sitting in my bag. It must come **after** `spawnLocalCorpse` (= `InventoryRef.stripForCorpse`): only then does
   * `captureRaidState()` capture the already emptied bag. The phase does not change on death, so it passes
   * `saveRaid`'s `isGameplayPhase()` gate, and the `rejoinPending` guard is respected.
   */
  Session.saveRaid(sys);
  if (sys.returnPending) {
    // 2026-09-13: the voluntary return — the player leaves without waiting for a rescue drop. The squad-leader
    // device is not dropped either: the `lobby:mission false` sent on the way out makes the server hand the squad
    // leader straight to a member still alive (the device is left behind as an ownerless thing).
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

/* ═══════════════ Tutorial checkpoint respawn (2026-09-14) ══════════════
 *
 * 「A full death has no automatic revive」 (2026-09-09) still holds — this is not an exception that breaks that
 * rule but a **separate branch** living only inside `ctx.missionMode === 'tutorial'`, and the means of reviving is
 * a contract that already exists (`player:respawn`). Read it as a sibling of the training-range branch (just above).
 *
 * Three things differ from the training range:
 *   ① **a corpse stands** — the equipment · bag · quick slots have to stay in it for the player to be able to go
 *      and pick them up (user's decision). So a checkpoint sits outside the detection range of that stretch's
 *      enemies (the placement rule in `shared/tutorialWorld`'s head comment).
 *   ② **the save is not cleared** — a solo raid clears its session the moment it dies (C-70, 「the raid is over
 *      the moment the player dies」), but a tutorial death is not the end. A reload carries on from the checkpoint.
 *   ③ **there is no raid failure** — it never goes to `gameOver()` and the phase stays as it is.
 */
function onTutorialDied(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  sys.setPaused(false);
  sys.respawnTimer = -1; sys.respawnLastSec = -1;
  sys.deathTimer = -1;
  // Equipped implants are left alone — a tutorial death loses nothing permanently (the exact opposite of the
  // solo raid branch).
  Corpse.spawnLocalCorpse(sys);
  /*
   * **No save is forced right after death** (the exact opposite of a multiplayer death, and that is right). The
   * reason multiplayer forcibly captures an empty bag is to stop 「the duplication that stands in the corpse and
   * stays in the bag」, but a solo save holds no corpse, so capturing an empty bag here would wake the reloading
   * player up **with neither corpse nor gear**. `parts/Session.saveRaid`'s solo guard (`isDead` → does not save) is
   * let through as it is, so the last **living** snapshot stays, and the periodic save that runs again after the
   * respawn captures the checkpoint progress. Not clearing the save itself is the point of this branch.
   */
  sys.tutorialRespawnTimer = TUTORIAL_RESPAWN_DELAY_S;
  /*
   * 2026-09-14 4th pass — the text never says 「체크포인트에서」. What decides the respawn spot is
   * `world/tutorial`'s `respawnPose()`, and from that day on that is usually the **last spot the body stood on the
   * ground** (the checkpoint dropped to being the fallback for when that record is missing — user's decision). If
   * the wording settles the spot, someone who fell off a cliff assumes they went back to the checkpoint and looks
   * in the wrong place.
   */
  ctx.bus.emit('ui:notify', { text: '마지막으로 서 있던 자리에서 다시 시작합니다', kind: 'warning', duration: TUTORIAL_RESPAWN_DELAY_S });
  }

/**
 * `TUTORIAL_RESPAWN_DELAY_S` has passed (`GameFlowSystem.update`). The player stands up again at
 * `world/tutorial`'s `respawnPose()` — since 2026-09-14 usually **the last spot the body stood on the ground**,
 * with the checkpoint only the fallback for when that record is missing (the same reason the toast 12 lines above
 * never says 「체크포인트」). Only `world/tutorial` built the map, so it is the one asked; with no answer the player
 * falls back to the world spawn. The `player:respawn` contract carries no yaw, so the facing is turned once with
 * `teleport` **right after** the respawn.
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
    try { ctx.player.teleport(position, pose.yaw, false); } catch { /* no body yet — only the facing is missed */ }
  }
  /*
   * 2026-09-15 (user's decision — 「부활하면 서 있는 채로 나타나지 않고 쓰러졌다 일어난다」): the respawn wake.
   * `player:respawn` is synchronous, so the body already stands (`respawnAt` cancels the intro wake first), and on
   * top of it only the lying pose → standing up plus the input lock is raised.
   * With `respawn: true` there is no fade to black, no dedicated camera, no compass fade, no Tab lock and no
   * `player:introWakeDone` — the tutorial `wake` step is raised on the opening alone.
   */
  const player = ctx.player;
  if (player && !player.isDead) {
    try { player.playIntroWake?.(TUTORIAL_RESPAWN_WAKE_S, { respawn: true }); } catch (e) { console.error('[gameflow] tutorial respawn wake failed', e); }
  }
  }

/**
 * 2026-09-15 (user's decision — `튜토리얼 건너뛰기` = fade to black → the results screen → the ship): the
 * **skip extraction** `ExtractionRef.skipToComplete` raises. It goes straight to the usual `complete()` with no
 * liftoff cinematic and no `LIFTOFF_TO_COMPLETE` wait — the results screen, the settlement (`TUTORIAL_RAID_XP`)
 * and gaining the ship all take the same path as a real extraction. The body does not have to be inside the ship
 * (waiting out a death · outside): it **counts as extracted**, because the skip is precisely 「extraction done on
 * the player's behalf」.
 *
 * How it is recognised (`isTutorialSkipLiftoff`): in the tutorial `extraction:liftoff` arrives ① while the ship
 * has not lifted yet (`stage !== 'liftoff'`), or ② once more when the phase is already `liftoff`. A normal liftoff
 * raises it exactly once and **after** setting `lifting`, so both shapes can only be a skip (the tutorial is solo,
 * so there is no host rebroadcast and no reconnect sync).
 */
export function isTutorialSkipLiftoff(sys: GameFlowSystem): boolean {
  const ctx = sys.ctx;
  if (!sys.isTutorial()) return false;
  if (ctx.phase === 'liftoff') return true;
  if (ctx.phase !== 'extracting' && ctx.phase !== 'shipLanded') return false;
  return ctx.extraction?.stage !== 'liftoff';
  }

export function completeTutorialSkip(sys: GameFlowSystem): void {
  sys.aboardAtLiftoff = true;
  sys.squadExtraction = true;
  sys.tutorialSkipComplete = true;
  try { sys.complete(); } finally { sys.tutorialSkipComplete = false; }
  }

/**
 * 2026-09-13 — **the voluntary return** (the pause menu's `함선으로 귀환` → warning popup → 1 s hold, user's
 * decision).
 *
 * Leaving a raid behind is **the same as dying on the spot**: `PlayerRef.die()` raises a real `player:died`, so
 * `onLocalDied` cleans up as usual — in a squad a corpse stands and the equipment · bag · the broken pairs of the
 * equipped implants stay in it (a squadmate recovers them), solo loses everything. Only two things differ: waiting
 * for a rescue drop (squad) is skipped, and after the `DEATH_TO_SCREEN` death cutscene `finishReturnToShip`
 * sends the player straight to the ship. Solo goes through `gameOver()` there like a real death, so the
 * `레이드 실패` screen is raised and the `hub:enter` of the same frame takes it down — it is never seen.
 *
 * Where there is no body to kill or nothing to lose — the training range · during the drop · the results screen —
 * it is a direct `hub:enter` as before. Already dead (spectating in a squad): the corpse already stands, so
 * nothing is waited for.
 */
export function requestReturnToShip(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (sys.returnPending) { finishReturnToShip(sys); return; }   // pressed again during the death cutscene — no wait
  const player = ctx.player;
  const canDie = ctx.isGameplayPhase() && !sys.isTraining() && !!player && typeof player.die === 'function' && !player.isDropping;
  if (!canDie) { ctx.bus.emit('hub:enter', { ship: ctx.net?.lobby ? 'shared' : 'personal' }); return; }
  sys.returnPending = true;
  ctx.bus.emit('ui:notify', { text: '함선으로 귀환합니다', kind: 'warning', duration: DEATH_TO_SCREEN });
  if (sys.isLocalOut()) { finishReturnToShip(sys); return; }
  player.die!();   // → `player:died` → `onLocalDied` (synchronous) settles the loss and raises `returnTimer`
  if (sys.returnTimer < 0) finishReturnToShip(sys);   // the death never reached the flow (safety net — leaves anyway)
  }

/**
 * The end of the voluntary return: settles this player's raid like a real death and goes to the ship.
 * `update` calls it once `returnTimer` has run out.
 */
export function finishReturnToShip(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  sys.returnTimer = -1;
  if (sys.inLiveMission() && !sys.isTraining()) {
    if (!ctx.isMultiplayer) {
      // Solo: the same settlement as a raid failure (death XP · contract settlement · kit reset). The results
      // screen is taken down by the `hub:enter` below in the same frame.
      sys.deathTimer = -1;
      sys.gameOver();
    } else {
      // Squad: the raid goes on for the squadmates. The settlement a dead player used to get at the end of the
      // raid is paid now and this one player alone drops out — `lobby:mission false`, not `endSession`'s
      // `lobby:reset` (host = the whole squad ends).
      ctx.stats.extracted = false;
      ctx.stats.lootValue = ctx.inventory?.getTotalValue() ?? 0;
      ctx.stats.timeSeconds = ctx.missionTime;
      ctx.stats.mode = ctx.missionMode;
      sys.awardMissionXp();
      if (typeof ctx.net?.leaveMission === 'function') ctx.net.leaveMission();
    }
  }
  // The same path even when a wipe or an extraction already put the results screen up. `onAbort` reads
  // `returnPending` and sends no `flow abort`.
  ctx.bus.emit('hub:enter', { ship: ctx.net?.lobby ? 'shared' : 'personal' });
  }

/**
 * 2026-09-09: **inactive** — automatic respawn is gone, so `game:respawnAvailable` is no longer emitted.
 * The event and `PLAYER_RESPAWN_DELAY` alike are contract, which is the only reason they were not deleted.
 */
export function tickRespawn(_sys: GameFlowSystem): void { /* no automatic respawn since 2026-09-09 */ }

/** 2026-09-09: **inactive** — nobody emits `game:respawn`, and it is ignored even if something does. */

/**
 * The rescue drop has landed (raised by `stratagems/parts/Rescue`). It reacts **only when I am the target** —
 * rebuilding the body is `player/`'s job (hellpod drop · `RESCUE_REVIVE_HP` · empty-handed); here only the flow
 * is cleaned up.
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
  /*
   * 2026-09-15 (android squadmates): this function is the rule for the **remote player list** — a bot member is
   * not a person, so it is filtered out here. `net/` decided not to make a `RemotePlayerRef` for a bot (A1), but
   * the decision must not hang on one folder's promise, so the id is filtered once more.
   * 2026-09-16 (user's decision 「사람과 안드로이드가 모두 쓰러지거나 죽어야 레이드 실패」): **this filter stays all the
   * same**. Counting the standing androids is the job of `checkAllDead`, which reads `ctx.allies.getBodies()`, and
   * every other caller still reads this function as "is this a human member?".
   */
  if (isAndroidId(r.id)) return false;
  if (!r.connected || !r.inMission || (r.flags & PlayerFlags.IN_HUB) !== 0) return false;
  const downed = (r.isDowned ?? false) || (r.flags & PlayerFlags.DOWNED) !== 0;
  if (r.suspended) {
    // Phase 9: the host ghost's state sits on the ref (net's `applyGhost` / the host's own `applyToRef`)
    if (r.ghostState !== undefined) return r.ghostState !== 2;
    return !r.isDead || downed;
  }
  return !r.isDead || downed;
  }

/**
 * Host only: nobody left alive / downed / alive-as-a-ghost → `flow over` to the squad and a raid failure locally.
 * 2026-09-16 (user's decision): not only every human but **every android too** has to be down or dead for a
 * failure — the decision lives in this one place.
 */
export function checkAllDead(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!MISSION_FAILS_WHEN_ALL_DEAD) return;
  if (!net || !ctx.isMultiplayer || !net.isHost) return;
  if (sys.isTraining()) return;
  if (!sys.inLiveMission()) return;
  if (!sys.isLocalOut()) return;
  for (const r of net.getRemotePlayers()) if (sys.isRemoteAlive(r)) return;
  /*
   * 2026-09-16 (user's decision 「사람과 안드로이드가 모두 쓰러지거나 죽어야 레이드 실패」): with even one android left
   * in the fight it is not a wipe — that unit comes to get the downed PC up (`allies/parts/Rescue`). **A downed
   * android does not count**: nobody gets it up, so it is out of the fight.
   *
   * `isRemoteAlive`'s bot filter (`isAndroidId`) is left alone. That one is the rule for the **remote player
   * list** (`net/` makes no `RemotePlayerRef` for a bot, so almost nothing reaches it there in the first place),
   * and its other callers read it that way. This function is what decides a wipe, so the android rule lives
   * only here.
   *
   * The moments it is looked at again were not added to (no new event is made in `src/shared`): while the local
   * player is dead or downed, `allDeadCheckTimer` re-arms itself every `ALL_DEAD_CHECK_INTERVAL` and calls this
   * function again (`GameFlowSystem.update`), so the moment the last android goes down is caught within that
   * interval.
   */
  for (const b of ctx.allies?.getBodies() ?? []) {
    if (b.mode === 'raid' && !b.dead && !b.downed && !b.hidden) return;
  }
  sys.allDeadCheckTimer = -1;
  net.send({ t: 'flow', ev: 'over' }, 'others');
  sys.gameOver();
  }

export function complete(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  if (ctx.phase === 'complete' || ctx.phase === 'dead' || ctx.phase === 'menu') return;
  // A dead, downed or left-behind player still sees the result screen (the squad was done), but did not extract.
  // 2026-09-13 (the extraction rework): only the liftoff's `aboard` counts — solo too, since a solo player can
  // now miss the ship.
  const outOfAction = (ctx.player?.isDead ?? false) || (ctx.player?.isDowned ?? false);
  // 2026-09-15: the tutorial skip extraction (`completeTutorialSkip`) is an extraction whatever the body's state
  ctx.stats.extracted = (sys.aboardAtLiftoff && !outOfAction) || sys.tutorialSkipComplete;
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
  ctx.progression?.clearActivePreps();   // A-13: extraction — this raid's preps are cleared (death alone does not)
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

/** Raid failure: solo death (after DEATH_TO_SCREEN) or a squad wipe (host decision, mirrored by `flow over`). */
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
  clearSoloRaid();          // raid failure — the stored session must not resurrect the run
  ctx.progression?.clearActivePreps();   // A-13: a wipe or a failure is the end of the raid too
  ctx.rejoinPending = false;
  sys.awardMissionXp();
  const stats = { ...ctx.stats };
  ctx.bus.emit('game:raidFailed', { stats });
  sys.setPhase('dead');
  ctx.bus.emit('game:over', { stats });
  sys.autoReturnTimer = RAID_FAILED_AUTO_RETURN_S;
  }

/**
 * 2026-09-13 (library series): the library effect's raid
 * XP multiplier `1 + raidXp`. 1 when `housing` does not know the sum (parallel work · a skeleton). A negative
 * value or NaN reads as 0.
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
 * 2026-09-16 (user's decision): raid XP comes **only from kills** — `stats.killXp` (Σ `data/enemies.csv` `raidXp`
 * of my last-hit kills, summed by enemies/) × (extracted ? 1 : `XP_DEATH_MUL`) × library multiplier. No loot-value,
 * extraction or survival-time XP. Contract / quest reward XP is added on top, unmultiplied.
 * A training-range mission never pays out (and never settles a contract).
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
    /*
     * 2026-09-15 (A-17, user's decision 「고정 지급 · 정확히 Lv.2」): a **completed tutorial raid** does not go through
     * the settlement formula and takes `TUTORIAL_RAID_XP` as it is (csv). 「정확히 Lv.2」 is what the decision
     * asks for, so that row is kept at `XP_BASE` — tuning either one alone breaks it, and nothing here checks.
     * With kill XP and the library `raidXp` multiplier folded in, some players reach level 3, which makes
     * the number of points the ship track (`levelUp` → `stats`) has to teach waver. The tutorial has no corporation
     * contract, so `settleMission` is not called either (an old contract may still be open, and the tutorial must
     * not settle it).
     * A **tutorial that ended without extracting** (ESC's `튜토리얼 건너뛰기` could not get the player aboard the
     * ship, so it went `game:returnToShip` → `gameOver()`) is not a 「completion」 either, so it pays **0** — the
     * branch right below — and not the main game's formula.
     */
    const tutorialClear = sys.isTutorial() && extracted;
    let xp = 0;
    if (tutorialClear) {
      xp = Number.isFinite(TUTORIAL_RAID_XP) ? Math.max(0, Math.round(TUTORIAL_RAID_XP)) : 0;
    } else if (sys.isTutorial()) {
      /*
       * 2026-09-15 (user's decision 「튜토리얼 전체로 딱 Lv.2」): a tutorial that was not completed (the skip could
       * not get the player aboard the ship, so it went `game:returnToShip` → `gameOver()`) **does not go through
       * the main game's settlement formula either** — kill XP × the death multiplier was applied as it is, so
       * tutorial XP wavered from player to player. It is not a completion, so it is 0 (a path that gives neither
       * the ship nor the level). The contract settlement is skipped too, by the condition below.
       */
      xp = 0;
    } else {
      /*
       * 2026-09-16 (user's decision 「레이드 경험치는 처치로만」): the kill site has already added `data/enemies.csv`
       * `raidXp` per killed type into `stats.killXp` — here only that sum is read. There is no loot-value,
       * extraction-bonus or survival-time XP (it blocks the path where merely holding loot long enough raised a
       * level). An old save with no `killXp` (a blob from before this field) reads 0.
       */
      const killXp = typeof s.killXp === 'number' && Number.isFinite(s.killXp) ? Math.max(0, s.killXp) : 0;
      xp = killXp * (extracted ? 1 : XP_DEATH_MUL);
      // 2026-09-13 (library series): the raid XP books — `raidXp` adds to the multiplier (0.1 = +10 %). It
      // multiplies the raid's share (kill XP) only, never the contract reward XP below — that reward is a fixed
      // `contracts.csv` value.
      xp = Math.round(xp * libraryRaidXpMul(ctx));
    }

    // `raids` / `extractions` are plain profile counters; ProgressionRef has no setter, so bump + save.
    prog.profile.raids += 1;
    if (extracted) prog.profile.extractions += 1;
    const levelBefore = prog.level;
    // Phase 5: settle the active corp contract first — its XP reward is paid through `addXp` below.
    let contract = null;
    const meta = ctx.meta;
    if (!sys.isTutorial() && meta && typeof meta.settleMission === 'function') {
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
