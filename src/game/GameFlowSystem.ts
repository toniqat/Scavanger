import * as THREE from 'three';
import type {
  GameContext, GameSystem, GamePhase, FlowMessage, PeerId, MissionMode, RaidSessionBlob, PlayerRestoreState, RemotePlayerRef,
} from '@/shared';
import type { PlanetId } from '@/shared';
import type { TutorialCheckpointId } from '@/shared';
import {
  GameContext as Ctx, Keys, PlayerFlags, PLAYER_RESPAWN_DELAY, RAID_FAILED_AUTO_RETURN_S, RAID_SAVE_INTERVAL_S,
  NET_GHOST_RESTORE_TIMEOUT_S,
} from '@/shared';
import { RESUME_GATE_BLOCKER } from '@/shared';
import { ResumeGate, installDesktopRelockHook, syncDesktopCursor } from './ResumeGate';
import { clearSoloRaid, loadSoloRaid, saveSoloRaid, soloRaidStatus, type SoloRaidSave } from './SoloRaid';
import { bumpClockHigh } from './SoloRaid';

import { ALL_DEAD_CHECK_INTERVAL, DEATH_TO_SCREEN, DISCONNECT_ABORT_DELAY, LIFTOFF_TO_COMPLETE, MISSION_FAILS_WHEN_ALL_DEAD, THREAT_MAX, THREAT_MIN, THREAT_RAMP_SECONDS } from './model';
/** 폴더 공용 어휘(상수 · 타입 · 스크래치)는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 재수출한다. */
export * from './model';
import * as Death from './parts/Death';
import * as Session from './parts/Session';
import * as Phases from './parts/Phases';
import * as Wire from './parts/Wire';
/* appended (2026-09-09): 플레이어 시체 · 분대장 기기 */
import { PlayerCorpseManager } from './Corpses';
import * as Corpse from './parts/CorpseNet';
import * as Leader from './parts/Leader';
import type { LeaderDeviceObject } from './parts/Leader';
/* appended (2026-09-15): 결과 창 개편 — 최고 소지품 가치 · 원인별 피해 · 막타 */
import { RaidReport } from './parts/RaidReport';
/* appended (2026-09-15): 레이드 진입 로딩 게이트 */
import { LoadGate } from './parts/LoadGate';
/* appended (2026-09-15): 타이틀 이어하기 · 레이드 포기 */
import { RaidResume } from './parts/Resume';

export class GameFlowSystem implements GameSystem {
  readonly name = 'gameflow';
  ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  netUnsub: (() => void) | null = null;

  awaitingWorld = false;
  completeTimer = -1;
  deathTimer = -1;
  /**
   * Phase 2 의 부활 카운트다운. **2026-09-09 이후 아무도 켜지 않는다** — 자동 부활이 사라지고 되살아나는
   * 길은 구조선뿐이다. 필드와 `PLAYER_RESPAWN_DELAY` · `game:respawnAvailable` 은 계약이라 남겨 둔다.
   */
  respawnTimer = -1;
  respawnLastSec = -1;

  /* ── 2026-09-09: 시체 · 분대장 기기 ── */
  /** 레이드에 서 있는 모든 플레이어 시체 (`ctx.corpses`). 레이드가 끝날 때까지 사라지지 않는다. */
  corpses: PlayerCorpseManager | null = null;
  corpseUnsubs: Array<() => void> = [];
  /** 바닥에 떨어진 분대장 기기 (호스트가 완전히 사망했을 때만 존재). */
  leaderDevice: LeaderDeviceObject | null = null;
  leaderUnsubs: Array<() => void> = [];
  paused = false;
  lastThreat = -1;
  /** 2026-09-15 (결과 창 개편): 결과 화면이 읽는 `stats.peakLootValue` · `stats.death` 의 재료 (`parts/RaidReport`). */
  readonly report = new RaidReport(this);
  /**
   * 2026-09-15 (레이드 진입 로딩): 발사 카운트다운 뒤 분대 전원이 준비될 때까지 화면을 붙잡는 게이트
   * (`parts/LoadGate`). ui 의 원형 게이지 · 스모크가 `__game.getSystem('gameflow').loadGate` 로 읽는다.
   */
  readonly loadGate = new LoadGate(this);
  /**
   * 2026-09-15 (타이틀 이어하기 · 레이드 포기): 남은 레이드(솔로 세이브 · 튜토리얼 · 분대 로비)를 타이틀에 내밀고 `이어하기` ·
   * `레이드 포기` 를 받는다 (`parts/Resume`, `ctx.raidResume`). 부팅 때 곧장 레이드로 떨어지던 옛 `consumeStoredSoloRaid` 를 대신한다.
   */
  readonly raidResume = new RaidResume(this);

  /* ── multiplayer ── */
  /** Local player entered the dropship bay (cleared on death / new mission). */
  boarded = false;
  /**
   * 2026-09-13 (탈출 개편): the local player was aboard and alive when the ship left (`extraction:liftoff.aboard`) — the only
   * thing that makes `stats.extracted` true now. Set together with `squadExtraction` when a liftoff ends this player's raid.
   */
  aboardAtLiftoff = false;
  /**
   * 2026-09-13: that liftoff left nobody alive outside (`extraction:liftoff.squadDone`) — the raid ends for the whole squad, and
   * the host sends `flow complete` as before. false = only the riders leave: they `leaveMission()` at their result screen and the
   * rest play on.
   */
  squadExtraction = false;
  /** 2026-09-15: true only inside `parts/Death.completeTutorialSkip` — `complete()` counts the run as extracted regardless of the body. */
  tutorialSkipComplete = false;
  /** Host: > 0 while the local player is dead → periodic all-dead check. */
  allDeadCheckTimer = -1;
  /** > 0 after the lobby/server vanished mid-mission → abort when it expires. */
  disconnectAbortTimer = -1;
  /** Cached each frame so `game:abort` can still reach the squad after NetSystem tore the session down. */
  wasMultiplayerHost = false;
  /** Mission-end XP is banked exactly once per mission (complete() and gameOver() are both idempotent). */
  rewarded = false;

  /* ── Phase 7 ── */
  /** > 0 on the 레이드 실패 screen → automatic `hub:enter` when it expires. */
  autoReturnTimer = -1;
  /** 2026-09-13: 자발적 귀환 — true 인 동안 `onLocalDied` 가 구조선 대기 · 레이드 실패 화면 대신 `returnTimer` 를 건다. */
  returnPending = false;
  /** 2026-09-13: 자발적 귀환으로 죽은 뒤 함선으로 가기까지 남은 초 (`parts/Death.finishReturnToShip`). */
  returnTimer = -1;
  /** Raid session upload cadence (multiplayer raid only). */
  raidSaveTimer = -1;
  /** 2026-09-14: 튜토리얼 사망 → 체크포인트 부활까지 남은 초 (-1 = 대기 없음, `parts/Death.tutorialRespawn`). */
  tutorialRespawnTimer = -1;
  /** Blob the server handed back with `welcome` (resume into a running raid); applied after the rejoin's `world:ready`. */
  raidBlob: RaidSessionBlob | null = null;
  /** true between `net:gameStarting {rejoin:true}` and the restore / fallback. */
  rejoining = false;
  /** Pose to hand `restoreState` once the resumed world is ready (solo counterpart of the host's `ghost restore`). */
  soloRestore: PlayerRestoreState | null = null;
  /** 2026-09-14: 이어하는 튜토리얼이 마지막으로 지난 체크포인트 (`world:ready` 뒤에 되돌린다, null = 없음). */
  soloCheckpoint: TutorialCheckpointId | null = null;
  /**
   * 2026-09-15: 마지막으로 저장한 튜토리얼 단계 id. `tutorial:changed` 는 단계가 아닌 이유(스태미나 노출)로도
   * 오므로, 단계가 **실제로 바뀐 프레임에만** 세이브를 강제한다 (`parts/Session.saveTutorialStep`).
   */
  lastTutorialStep: string | null = null;
  /** > 0 while waiting for the host's `ghost restore` after a rejoin. */
  restoreTimer = -1;
  /** Inventory as it was when the 훈련장 was entered (ammo / durability are refunded on exit). */
  trainingSnapshot: unknown = null;
  /**
   * 2026-09-07 (커서 rework): a lost pointer lock is not, by itself, a pause. Releasing the lock is how every screen
   * shows the mouse, so treating a missing lock as "the player left" made the game freeze whenever the cursor
   * appeared. Losing the *window* means the player really left — that still pauses.
   *
   * 2026-09-08: a lock the player took away **while the camera still wanted it** is a different thing — it is the
   * Escape key, which the browser swallowed. `Input.onUserUnlock` reports exactly that case (our own releases are
   * marked and skipped) and it opens the 일시정지 메뉴 through the same `input:pointerLockLost` event.
   */
  /** Phase 12: `좌측 클릭으로 게임 재개` overlay (browser only; created in `init`). */
  private resumeGate: ResumeGate | null = null;
  private onWindowBlur = (): void => this.onFocusLost();
  private onVisibilityChange = (): void => { if (document.visibilityState === 'hidden') this.onFocusLost(); };
  /**
   * Tab closing mid-solo-raid: flush the session so the last seconds of the run are not lost (2026-09-07).
   * 2026-09-11 (C-70): 죽은 뒤에는 flush 하지 않는다 — `parts/Death.onLocalDied` 가 방금 지운 세이브를 되살려
   * 새로고침 부활을 열어 준다 (`parts/Session.saveRaid` 의 솔로 가드와 같은 이유이고, 이 경로는 그 함수를 지나지 않는다).
   */
  private onPageHide = (): void => { if (this.isSoloRaid() && this.ctx.isGameplayPhase() && !this.isLocalOut()) this.saveSolo(); };

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // 2026-09-09: 시체 저장소를 `ctx.corpses` 로 게시한다 (구조선 대상 목록 · 지도가 읽는다).
    this.corpses = new PlayerCorpseManager(ctx);
    ctx.corpses = this.corpses;
    // 2026-09-10: 분대장 기기의 점광원을 씬에 미리 심는다 — 기기를 넣고 뺄 때 광원 개수가 바뀌면
    // 씬의 모든 머티리얼이 셰이더를 다시 컴파일한다 (`parts/Leader` 의 `installLeaderLight` 주석).
    Leader.installLeaderLight(this);
    // 2026-09-15: 아래 `player:died` → `onLocalDied`(시체로 비우기)보다 **먼저** 구독해야 사망 순간의 소지품 가치를 잰다.
    this.report.bind();
    /*
     * 2026-09-15 (레이드 진입 로딩): 게이트도 여기서 붙는다. `game:newMission` 구독이 **아래의 `onNewMission` 보다
     * 먼저**여야 한다 — 게이트가 hold 를 걸기 전에 페이즈가 굴러가면 첫 프레임이 밝은 채로 지나간다.
     */
    this.loadGate.bind(ctx);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', ({ seed, mode, planet }) => this.onNewMission(seed, mode, planet)),
      b.on('world:ready', () => {
        // 2026-09-09: 새 월드에는 시체도 분대장 기기도 없다. 클라이언트는 호스트에게 현황을 청한다.
        this.clearCorpses();
        this.ensureNetHooks();
        Corpse.requestCorpseSync(this);
        Leader.requestLeaderSync(this);
        if (!this.awaitingWorld) return;
        this.awaitingWorld = false;
        this.onWorldReady();
      }),
      b.on('player:landed', () => {
        if (ctx.phase !== 'deploying') return;
        this.setPhase('playing');
        // 2026-09-11 (E-5): the body is on the ground — the resumable snapshot takes the real pose right away
        if (this.isSoloRaid() && !ctx.rejoinPending) this.saveSolo();
      }),
      // E-5 ①: a save made in the ship is a clock reading too
      b.on('inventory:loadoutSaved', () => { if (ctx.isHubPhase()) bumpClockHigh(); }),
      b.on('hub:entered', () => bumpClockHigh()),
      b.on('extraction:activated', () => { if (ctx.phase === 'playing') this.setPhase('extracting'); }),
      b.on('extraction:shipLanded', () => { if (ctx.phase === 'extracting') this.setPhase('shipLanded'); }),
      b.on('extraction:boarded', () => { this.boarded = true; }),
      b.on('extraction:liftoff', ({ aboard, squadDone }) => {
        // 2026-09-15: 튜토리얼 건너뛰기(`ExtractionRef.skipToComplete`) — 이륙 연출 · 대기 없이 곧장 결과 화면 (`parts/Death`)
        if (Death.isTutorialSkipLiftoff(this)) { Death.completeTutorialSkip(this); return; }
        if (ctx.phase !== 'shipLanded' && ctx.phase !== 'extracting') return;
        const mine = aboard ?? true, done = squadDone ?? true;
        // 2026-09-13: left behind while someone alive stays too — the raid goes on (`extraction:reset` returns the phase).
        if (!mine && !done) return;
        this.aboardAtLiftoff = mine;
        this.squadExtraction = done;
        this.setPhase('liftoff');
        this.completeTimer = LIFTOFF_TO_COMPLETE;
      }),
      // 2026-09-13: the ship left without us → back to 'playing'; any console can call the next one.
      b.on('extraction:reset', () => {
        if (this.completeTimer >= 0) return;
        if (ctx.phase === 'extracting' || ctx.phase === 'shipLanded' || ctx.phase === 'liftoff') this.setPhase('playing');
      }),
      b.on('player:died', () => this.onLocalDied()),
      // 2026-09-13: 일시정지 메뉴 `함선으로 귀환` (경고 팝업 확정 뒤) — 그 자리에서 사망 → 사망 연출 뒤 함선
      b.on('game:returnToShip', () => Death.requestReturnToShip(this)),
      // 2026-09-09: `game:respawn` 은 더 이상 구독하지 않는다 (자동 부활 없음 — 구조선뿐).
      b.on('player:spawned', () => { this.respawnTimer = -1; this.respawnLastSec = -1; }),
      /* ── 2026-09-09: 시체 · 구조선 · 분대장 기기 ── */
      b.on('crate:looted', ({ crateId }) => Corpse.onContainerLooted(this, crateId)),
      b.on('rescue:landed', ({ target }) => Death.onRescueLanded(this, target)),
      b.on('world:cleared', () => this.clearCorpses()),
      /* Downed is NOT death: the mission keeps running and a defibrillator can still bring the player back. */
      b.on('player:downed', () => this.onLocalDowned()),
      b.on('player:revived', () => this.onLocalRevived()),
      // stats.kills / cratesOpened / damageTaken are incremented by Enemy / World / Player systems;
      // missionTime + stats.timeSeconds advance in Engine.frame(). GameFlow only finalizes them.
      b.on('game:abort', () => this.onAbort()),
      b.on('game:abort', () => this.clearCorpses()),
      b.on('game:newMission', () => this.clearCorpses()),
      b.on('game:paused', ({ paused }) => this.setPaused(paused, false)),
      /* multiplayer */
      b.on('net:remoteDied', () => this.checkAllDead()),
      b.on('net:peerLeft', () => this.checkAllDead()),
      b.on('net:lobbyLeft', ({ reason }) => this.onLobbyLeft(reason)),
      /* reconnection (hub era) */
      b.on('net:reconnecting', ({ attempt }) => {
        if (!this.inMission()) return;
        ctx.bus.emit('ui:notify', { text: `서버 재연결 중… (${attempt})`, kind: 'warning', duration: 3 });
      }),
      b.on('net:resumed', ({ seamless, inProgress, lobby }) => {
        if (!this.inMission()) return;
        if (seamless) { ctx.bus.emit('ui:notify', { text: '재연결됨', kind: 'success' }); return; }
        // the party moved on (different mission / back in the ship): drop our stale mission and regroup.
        // A 훈련장 is entered individually and is not the squad's mission — never report it as one.
        const training = lobby?.started === true && (lobby.mode ?? 'raid') === 'training';
        ctx.bus.emit('ui:notify', {
          text: training ? '훈련장 연결이 끊겼습니다 — 함선으로 복귀'
            : inProgress ? '분대가 다른 임무를 진행 중입니다 — 함선으로 복귀' : '분대가 함선으로 복귀했습니다',
          kind: 'warning', duration: 4,
        });
        this.disconnectAbortTimer = -1;
        ctx.bus.emit('game:abort', {});
        ctx.bus.emit('hub:enter', { ship: 'shared' });
      }),
      /* Phase 7: raid session / rejoin / ghosts / host migration / training */
      b.on('net:raidLoaded', ({ blob }) => { this.raidBlob = blob; }),
      b.on('net:gameStarting', ({ rejoin, mode }) => this.onGameStarting(rejoin ?? false, mode)),
      b.on('net:ghostRestore', ({ state }) => this.onGhostRestore(state)),
      // Phase 9: ghost states live on the refs (`RemotePlayerRef.ghostState`, net fills them); a ghost that bleeds out
      // is caught by the 0.5 s timer that runs while the local player is out
      b.on('net:peerSuspended', () => this.checkAllDead()),
      b.on('net:hostChanged', ({ hostId, isLocalHost }) => {
        this.onHostChanged(isLocalHost);
        // 2026-09-09: 이 토스트의 주인은 여기 하나다 — 기기 회수든 커뮤니티 우클릭 이관이든 전부 여기로 모인다.
        Leader.onHostChangedToast(this, hostId, isLocalHost);
      }),
      b.on('training:exitRequested', () => this.exitTraining()),
      b.on('inventory:itemAdded', () => this.saveRaid()),
      b.on('crate:looted', () => this.saveRaid()),
      /* 2026-09-15 (사용자 결정): 튜토리얼은 **단계마다 · 체크포인트마다** 저장한다 — 5초 주기로는 단계 전환이
       * 담기지 않아, 방금 배운 것을 하자마자 껐다 켜면 그 단계를 다시 하게 된다 (`parts/Session`). */
      b.on('tutorial:changed', ({ step }) => Session.saveTutorialStep(this, step)),
      b.on('tutorial:checkpoint', () => Session.saveTutorialCheckpoint(this)),
      // The browser ate an Escape to free the cursor (`main.ts` ← `Input.onUserUnlock`) — that press was the
      // 일시정지 메뉴. Also fired by `onFocusLost` below, where the pause is the same outcome.
      b.on('input:pointerLockLost', () => this.escapePause()),
    );
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
    this.resumeGate = new ResumeGate(ctx);
    this.unsubs.push(installDesktopRelockHook(ctx));
    /*
     * 2026-09-07: a solo raid interrupted by a closed tab / crash is resumable for `SOLO_RAID_GRACE_MS`.
     * 2026-09-15 (타이틀 이어하기): the boot no longer drops straight back into it — `parts/Resume` reads the file (and the
     * squad raid marker) here and offers the raid on the title; a save already too old at boot still fails on the first frame.
     */
    this.raidResume.bind();
    // Make sure listeners know the initial phase even though ctx.phase already equals 'menu'.
    ctx.phase = 'menu';
    ctx.bus.emit('game:phaseChanged', { phase: 'menu', prev: 'menu' });
  }

  /** Mission running or its result screen showing (anything the hub / a disconnect has to abort first). */
  inMission(): boolean { return Phases.inMission(this); }

  /** Live mission (not a result screen). */
  inLiveMission(): boolean { return Phases.inLiveMission(this); }

  isTraining(): boolean { return Phases.isTraining(this); }

  /** 2026-09-14: 튜토리얼 레이드 중인가 (사망 = 체크포인트 부활, 레이드 실패 없음). */
  isTutorial(): boolean { return Phases.isTutorial(this); }

  /**
   * Phase 8: standing in the personal / shared ship. Esc pauses here too (the terminal is opened from the console,
   * not from Escape any more), but the pause is menu-only — `freeze` stays false so the ship keeps animating and
   * nothing mission-related (abort, stats, timers) happens.
   */
  inShip(): boolean { return Phases.inShip(this); }

  /**
   * Phase 12: no UI blocker besides the 재개 게이트's own token. The gate is an overlay over a running game, not a
   * screen — Escape on it must open the 일시정지 메뉴 and a window blur behind it must still pause.
   */
  noScreenOpen(): boolean { return Phases.noScreenOpen(this); }

  /** Phase 12: a screen other than the 일시정지 메뉴 itself (and the gate) holds a blocker — the pause must yield. */

  /* ── Multiplayer helpers ─────────────────────────────────────────────── */
  /** Subscribe to host `flow` messages once `ctx.net` exists (NetSystem publishes it before this system inits, but stay lazy). */
  ensureNetHooks(): void {
    Wire.ensureNetHooks(this);
    // 2026-09-09: 시체 / 분대장 기기도 같은 시점에 붙는다 (`net` 이 생긴 뒤 한 번씩).
    Corpse.hookCorpseNet(this);
    Leader.hookLeaderNet(this);
  }

  /** 미션 리셋: 시체 · 분대장 기기를 전부 치우고 지오메트리를 dispose 한다. */
  clearCorpses(): void {
    this.corpses?.clear();
    Leader.clearDevice(this);
  }

  /** Clients only: mirror the host's mission-level decisions. */
  onFlowMessage(msg: FlowMessage, from: PeerId): void { return Wire.onFlowMessage(this, msg, from); }

  private onLocalDied(): void { return Death.onLocalDied(this); }

  /** Emits `game:respawnAvailable` once per whole second while the respawn timer runs (and once at 0). */
  tickRespawn(): void { return Death.tickRespawn(this); }

  /** `game:respawn` (UI): honoured only while dead, after the delay and while the raid is still running (never on 레이드 실패). */
  private onRespawnRequest(): void { return Death.onRespawnRequest(this); }

  /** Downed (tactical kit hook): the mission keeps running — a squadmate or a defibrillator can still bring the player back. */
  private onLocalDowned(): void { return Death.onLocalDowned(this); }

  private onLocalRevived(): void { return Death.onLocalRevived(this); }

  /** True when a player is out of the fight for good — downed players are still revivable. */
  isLocalOut(): boolean { return Death.isLocalOut(this); }

  /**
   * Is this remote member still "in the fight"? Ghost-aware (Phase 7):
   *   - not part of the mission (`inMission` false / IN_HUB / left) → ignored (returns false);
   *   - suspended (socket down, host simulates a ghost) → alive unless the ghost is dead (`state` 2);
   *   - otherwise alive unless dead-and-not-downed (a downed peer can still be revived).
   */
  isRemoteAlive(r: RemotePlayerRef): boolean { return Death.isRemoteAlive(this, r); }

  /** Host only: nobody left alive / downed / alive-as-a-ghost → `flow over` to the squad and 레이드 실패 locally. */
  checkAllDead(): void { return Death.checkAllDead(this); }

  /** Phase 7: authority moved (host migration). The new host takes the wipe check over; the old one just mirrors. */
  private onHostChanged(isLocalHost: boolean): void { return Wire.onHostChanged(this, isLocalHost); }

  /**
   * The party is gone (server gave up on us / host left / kicked) mid-mission → abort after a short toast and
   * return to the personal ship. A plain socket drop is `net:reconnecting` (handled above) and never aborts.
   */
  private onLobbyLeft(reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft' | 'moved'): void { return Wire.onLobbyLeft(this, reason); }

  /* ── Pause / focus ───────────────────────────────────────────────────── */
  /**
   * The player left the window (alt-tab, another app, a hidden tab). This is the **only** pause trigger besides
   * Escape since the 2026-09-07 커서 rework: a missing pointer lock means the mouse is being used as a cursor, which
   * is a normal in-game state now, while a missing window really is someone walking away.
   */
  private onFocusLost(): void { return Phases.onFocusLost(this); }

  /** Escape (or a pointer lock the player took away) → the 일시정지 메뉴. See `parts/Phases.escapePause`. */
  escapePause(): void { return Phases.escapePause(this); }

  /** Escape 한 번: 열린 화면 중 맨 위 하나를 닫거나, 없으면 일시정지 메뉴 (2026-09-09). */
  escapeKey(): void { return Phases.escapeKey(this); }

  /* ── Mission start / rejoin ──────────────────────────────────────────── */
  /** NetSystem announces a session start right before its `game:newMission`; `rejoin` = re-entering a running mission. */
  private onGameStarting(rejoin: boolean, mode: MissionMode | undefined): void { return Phases.onGameStarting(this, rejoin, mode); }

  private onNewMission(seed: number, mode: MissionMode | undefined, planet?: PlanetId | null): void { return Phases.onNewMission(this, seed, mode, planet); }

  /** World generated: deploy — or, on a rejoin, restore the raid blob and wait for the host's ghost. */
  onWorldReady(): void { return Phases.onWorldReady(this); }

  /** `ghost restore` from the host: stand where the ghost was; a dead ghost enters the respawn flow. */
  onGhostRestore(state: PlayerRestoreState): void { return Session.onGhostRestore(this, state); }

  /** No `ghost restore` within NET_GHOST_RESTORE_TIMEOUT_S → normal hellpod drop at the mission spawn. */
  private restoreFallback(): void { return Session.restoreFallback(this); }

  /* ── Raid session (multiplayer raid only) ────────────────────────────── */
  isRaidSession(): boolean { return Session.isRaidSession(this); }

  /** Solo raid: no relay to upload to, so the session is mirrored into localStorage instead (`SoloRaid.ts`). */
  isSoloRaid(): boolean { return Session.isSoloRaid(this); }

  /** Upload my mid-raid state so a reconnect can resume it (`RaidSessionBlob`) — or, solo, write it to localStorage. */
  private saveRaid(): void { return Session.saveRaid(this); }

  /** Mirror the live solo raid (seed / planet / clock / stats / inventory / body) into localStorage. */
  saveSolo(): void { return Session.saveSolo(this); }

  /** Re-enter the stored solo raid: same seed / planet, blob restored on `world:ready`, body placed (no hellpod). */
  resumeSoloRaid(save: SoloRaidSave): void { return Session.resumeSoloRaid(this, save); }

  /* ── 훈련장 ─────────────────────────────────────────────────────────── */
  /** The arena's exit console: leave the training, refund the inventory snapshot, back to the ship. */
  private exitTraining(): void { return Phases.exitTraining(this); }

  private onAbort(): void { return Phases.onAbort(this); }

  setPhase(phase: GamePhase): void { return Phases.setPhase(this, phase); }

  setPaused(paused: boolean, emit = true): void { return Phases.setPaused(this, paused, emit); }

  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    this.raidResume.update();   // 2026-09-15: 부팅 때 늦은 세이브의 실패 · 타이틀에서 넘어가는 솔로 유예
    if (this.inLiveMission()) this.wasMultiplayerHost = ctx.isMultiplayer && (ctx.net?.isHost ?? false);

    // Escape: **가장 위 화면 하나를 닫고, 닫을 것이 없으면 일시정지 메뉴** (2026-09-09) — see `escapeKey`.
    // Reached only while the pointer is already free (a screen is open); the locked case arrives as
    // `input:pointerLockLost` instead, and that one has no screen to close by definition.
    if (ctx.input.wasPressed(Keys.MENU)) { ctx.input.consume(Keys.MENU); this.escapeKey(); }
    // Phase 12: '좌측 클릭으로 게임 재개' (browser) / hidden OS cursor while nothing needs it (Electron shell). The
    // gate only ever shows once every screen **and** the 일시정지 메뉴 are gone and the lock could not be retaken.
    this.resumeGate?.update();
    syncDesktopCursor(ctx);
    // 2026-09-10: Alt 커서(`Keys.CURSOR` → 화면 없이 마우스만 풀기)는 제거됐다 — 커서는 화면이 열릴 때만 나온다.

    if (ctx.isGameplayPhase() && !this.isTraining()) {
      // Difficulty ramp 0.3 → 0.7 over 8 minutes of mission time (never on the training range).
      const t = Math.min(1, ctx.missionTime / THREAT_RAMP_SECONDS);
      const threat = THREAT_MIN + (THREAT_MAX - THREAT_MIN) * t;
      if (ctx.enemies && Math.abs(threat - this.lastThreat) > 0.01) {
        this.lastThreat = threat;
        ctx.enemies.setThreatLevel(threat);
      }
    }

    this.report.update(dt);   // 2026-09-15: 최고 소지품 가치 저율 폴링 (레이드 중 · 살아 있을 때만)
    // 2026-09-15: 로딩 게이트는 hold 중에도 돌아야 한다 — 그래서 dt 가 아니라 `ctx.time` 을 쓴다 (게이트가 없으면 비용 없음).
    this.loadGate.update();
    if (this.completeTimer >= 0) {
      this.completeTimer -= dt;
      if (this.completeTimer < 0) this.complete();
    }
    if (this.deathTimer >= 0) {
      this.deathTimer -= dt;
      if (this.deathTimer < 0) { this.deathTimer = -1; this.gameOver(); }
    }
    // 2026-09-09: 바닥의 분대장 기기가 맥동한다 (없으면 no-op).
    Leader.updateLeader(this, dt);
    // 2026-09-11 (C-18): 달리는 전차 위에서 죽은 시체는 전차를 따라간다 (탄 시체가 없으면 빈 순회).
    this.corpses?.update();
    if (this.allDeadCheckTimer >= 0) {
      this.allDeadCheckTimer -= dt;
      if (this.allDeadCheckTimer < 0) {
        const stillOut = this.isLocalOut() || (ctx.player?.isDowned ?? false);
        this.allDeadCheckTimer = stillOut ? ALL_DEAD_CHECK_INTERVAL : -1;
        this.checkAllDead();
      }
    }
    if (this.restoreTimer >= 0) {
      this.restoreTimer -= dt;
      if (this.restoreTimer < 0) this.restoreFallback();
    }
    if (this.raidSaveTimer >= 0 && ctx.isGameplayPhase()) {
      this.raidSaveTimer -= dt;
      if (this.raidSaveTimer < 0) this.saveRaid();
    }
    if (this.autoReturnTimer >= 0) {
      this.autoReturnTimer -= dt;
      if (this.autoReturnTimer < 0) {
        this.autoReturnTimer = -1;
        // 2026-09-16: 결과 화면의 `함선으로 귀환` 과 같은 길 — 암전 → 로딩 → 페이드인 (ui/menus/ShipReturn 이 `hub:enter` 를 낸다)
        if (ctx.phase === 'dead') ctx.bus.emit('ui:shipReturn', {});
      }
    }
    // 2026-09-14: 튜토리얼 — 사망 연출이 끝나면 체크포인트에서 다시 선다 (레이드 실패 없음)
    if (this.tutorialRespawnTimer >= 0) {
      this.tutorialRespawnTimer -= dt;
      if (this.tutorialRespawnTimer < 0) Death.tutorialRespawn(this);
    }
    // 2026-09-13: 자발적 귀환 — 사망 연출이 끝나면 결산하고 함선으로 (`parts/Death.finishReturnToShip`)
    if (this.returnTimer >= 0) {
      this.returnTimer -= dt;
      if (this.returnTimer < 0) Death.finishReturnToShip(this);
    }
    if (this.disconnectAbortTimer >= 0) {
      this.disconnectAbortTimer -= dt;
      if (this.disconnectAbortTimer < 0) {
        this.disconnectAbortTimer = -1;
        ctx.bus.emit('game:abort', {});
        // the lobby is gone → personal ship (onAbort's shared-ship regroup only fires while a lobby exists)
        if (ctx.phase === 'menu') ctx.bus.emit('hub:enter', { ship: ctx.net?.lobby ? 'shared' : 'personal' });
      }
    }
  }

  /** 2026-09-15: 결산 앞에서 `stats.peakLootValue` · `stats.death` 를 채운다 (`parts/RaidReport.fill` — 멱등). */
  complete(): void { this.report.fill(); return Death.complete(this); }

  /** 레이드 실패: solo death (after DEATH_TO_SCREEN) or a squad wipe (host decision, mirrored by `flow over`). */
  gameOver(): void { this.report.fill(); return Death.gameOver(this); }

  /**
   * Bank the mission result into the persistent profile (progression/). Runs once per mission, before the
   * result screen appears, so `game:complete` / `game:over` listeners already see the new level.
   * Raid XP comes only from kills (`stats.killXp`, × `XP_DEATH_MUL` when not extracted) — 2026-09-16.
   * A 훈련장 never pays out (and never settles a contract).
   */
  awardMissionXp(): void { return Death.awardMissionXp(this); }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.report.dispose();
    this.loadGate.dispose();
    this.raidResume.dispose();
    this.netUnsub?.(); this.netUnsub = null;
    Corpse.unhookCorpseNet(this);
    Leader.unhookLeaderNet(this);
    this.clearCorpses();
    if (this.ctx?.corpses === this.corpses) this.ctx.corpses = null;
    this.corpses = null;
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
    this.resumeGate?.dispose(); this.resumeGate = null;
    document.body.classList.remove('desktop-nocursor');
  }
}
