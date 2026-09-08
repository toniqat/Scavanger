/**
 * src/hub/parts/Transitions.ts — **함선을 드나드는 전환**.
 *
 * 타이틀 → 개인 함선, 도킹 → 공유 함선, 임무 종료 → 함선, 재접속 복귀. 컷씬을 태울지
 * 바로 바꿔치울지(`swapDirect`)와, 진행 중인 레이드로 자동 재투입할지를 정한다.
 */
import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import { getPlanet, isPlanetId, planetLabel, HUB_TRAVEL_DURATION, PLANET_NONE_LABEL, PLANET_STORAGE_KEY } from '@/shared';
import type { CrewCardWire, GameContext, GameSystem, HubLaunchSlot, HubRef, HubShipKind, Interactable, InteriorCollider, LoadoutSlot, LobbyState, PeerId, RoomPurpose } from '@/shared';
import { CREW_CARD_MIN_INTERVAL_S, CREW_LOADOUT_COOLDOWN_S, HUB_DOCKING_DURATION, HUB_LAUNCH_COUNTDOWN, HUB_READY_BLOCKER, HUB_READY_CELLS, Keys, NET_SLOT_COLORS, ROOM_PURPOSE_LABEL_KO } from '@/shared';
import { PersonalShip } from '../interiors/PersonalShip';
import { SharedShip } from '../interiors/SharedShip';
import type { StationDef } from '../interiors/stations';
import type { ShipInterior } from '../interiors/types';
import { FurnitureLayer } from '../interiors/Furniture';
import { roomAtWorld } from '../interiors/RoomLayout';
import { HousingMode } from '../HousingMode';
import { LaunchPod } from '../LaunchPod';
import { Terminal } from '../Terminal';
import { Workbench } from '../Workbench';
import { Computer } from '../Computer';
import { DockingCutscene, type DockDirection } from '../DockingCutscene';
import { HubMenu } from '../ui/HubMenu';
import { WorkbenchMenu } from '../ui/WorkbenchMenu';
import { HubStatus } from '../ui/HubStatus';
import { ReadyPanel, type ReadyCellInfo } from '../ui/ReadyPanel';
import { randomSeed } from '../ui/dom';
import { type DockTransition, LOCK_REQUEST_GRACE_MS, READY_ECHO_GRACE, UNBOARD_GRACE, _camLook, _camPos, _front } from '../model';
import type { HubSystem } from '../HubSystem';

/* ── enter / build / teardown ──────────────────────────────────────────── */
export function enter(sys: HubSystem, requested: HubShipKind): void {
  const ctx = sys.ctx;
  // 'shared' needs a lobby; conversely, while a lobby exists the squad lives in the shared ship.
  const ship: HubShipKind = ctx.net?.lobby ? 'shared' : 'personal';
  if (requested !== ship) console.info(`[hub] hub:enter ${requested} → ${ship} (lobby ${ctx.net?.lobby ? 'present' : 'absent'})`);
  const phase = ctx.phase;
  if (phase !== 'menu' && phase !== 'hub' && phase !== 'docking') ctx.bus.emit('game:abort', {});   // abort the mission / result screen first
  if (sys.cutscene) { sys.cutscene.dispose(); sys.cutscene = null; sys.travelling = false; }
  if (sys.interior && sys.ship === ship && ctx.phase === 'hub') return;      // idempotent
  sys.disposeInterior();
  const spawn = sys.build(ship, false);
  ctx.setPhase('hub');
  ctx.bus.emit('hub:entered', { ship, spawn: spawn.clone() });
  ctx.input.requestPointerLock();
  if (ship === 'personal') sys.tryResume();
  }

/** Personal ship: connect in the background; a lobby on `welcome` (resume) moves us straight to the shared ship. */
export function tryResume(sys: HubSystem): void {
  const net = sys.ctx.net;
  if (!net || typeof net.ensureConnected !== 'function') return;
  net.ensureConnected().then((ok) => {
    if (!ok || !net.lobby) return;
    if (sys.ship === 'personal' && sys.ctx.phase === 'hub' && !sys.cutscene) sys.swapDirect('shared');
  }).catch(() => { /* offline personal ship */ });
  }

/** 타이틀로: leave the lobby (if any), tear down, phase 'menu' (the title shows because `ctx.net.lobby` is null). */
export function toTitle(sys: HubSystem): void {
  const ctx = sys.ctx;
  if (ctx.net?.lobby) ctx.net.leaveLobby();
  sys.teardown('menu');
  ctx.setPhase('menu');
  }

export function setSpaceMode(sys: HubSystem, on: boolean): void {
  const atmo = sys.ctx.scene.userData.atmosphere as { setSpaceMode?: (on: boolean) => void } | undefined;
  atmo?.setSpaceMode?.(on);
  }

export function relock(sys: HubSystem): void {
  queueMicrotask(() => {
    const ctx = sys.ctx;
    // never grab the pointer back while decorating — 함선 관리 needs the free cursor for its panels
    if (ctx.phase !== 'hub' || ctx.uiBlockers.size > 0 || sys.housingMode.active) return;
    ctx.input.requestPointerLock();
  });
  }

/* ── docking transitions ───────────────────────────────────────────────── */
export function startTransition(sys: HubSystem, direction: DockTransition): void {
  const ctx = sys.ctx;
  if (sys.cutscene) {
    if (sys.cutscene.direction === direction) return;
    sys.cutscene.dispose(); sys.cutscene = null; sys.travelling = false;
  }
  if (sys.boardedSlot >= 0) sys.leavePod(false, false);
  sys.menu.close(false);
  sys.wbMenu.close(false);
  sys.ready.hide();
  sys.disposeInterior();          // the player keeps the old collider reference until the new ship is built
  ctx.setPhase('docking');
  ctx.bus.emit('hub:docking', { stage: 'start', direction });
  ctx.bus.emit('ui:notify', { text: direction === 'dock' ? '도킹 절차 시작' : '도킹 해제 — 개인 함선으로 복귀', kind: 'info' });
  const duration = direction === 'dock' ? HUB_DOCKING_DURATION : HUB_DOCKING_DURATION * 0.5;
  sys.cutscene = new DockingCutscene(ctx, direction, duration, () => sys.finishTransition(direction));
  }

export function finishTransition(sys: HubSystem, direction: DockTransition): void {
  const ctx = sys.ctx;
  sys.cutscene?.dispose(); sys.cutscene = null; sys.travelling = false;
  const target: HubShipKind = direction === 'dock' && ctx.net?.lobby ? 'shared' : 'personal';
  const spawn = sys.build(target, target === 'shared');
  ctx.setPhase('hub');
  ctx.bus.emit('hub:docking', { stage: 'end', direction });
  ctx.bus.emit('hub:entered', { ship: target, spawn: spawn.clone() });
  sys.relock();
  }

/** Swap interiors without a cutscene (resume after reload / seamless cases). */
export function swapDirect(sys: HubSystem, target: HubShipKind): void {
  const ctx = sys.ctx;
  sys.cutscene?.dispose(); sys.cutscene = null; sys.travelling = false;
  if (sys.boardedSlot >= 0) sys.leavePod(false, false);
  sys.menu.close(false);
  sys.wbMenu.close(false);
  sys.ready.hide();
  sys.disposeInterior();
  const spawn = sys.build(target, target === 'shared');
  ctx.setPhase('hub');
  ctx.bus.emit('hub:entered', { ship: target, spawn: spawn.clone() });
  }

/* ── net events ────────────────────────────────────────────────────────── */
export function onLobbyUpdated(sys: HubSystem, lobby: LobbyState): void {
  if (!sys.active) return;
  if (sys.ship === 'personal' && sys.ctx.phase === 'hub' && !sys.cutscene) {
    if (lobby.started) sys.swapDirect('shared');     // resumed into a running mission: no cutscene
    else sys.startTransition('dock');
    return;
  }
  // 목표 행성 (Phase 11): the host's pick reaches everyone as `lobby:state` — there is no travel message on the
  // wire, each member plays the cutscene off its own copy. Arriving in the lobby only fills the value (see `build`).
  const lp = lobby.planet ?? null;
  if (lp !== sys.knownLobbyPlanet) {
    sys.knownLobbyPlanet = lp;
    if (lp && !sys.travelling && !sys.cutscene && sys.ctx.phase === 'hub' && !lobby.started) {
      sys.startTravel(lp, 'squad');
      return;                                          // startTravel already re-synced the pods / screen
    }
    sys.applyPlanetLook();
  }
  sys.syncPods();
  sys.updateTerminalScreen();
  }

export function onLobbyLeft(sys: HubSystem): void {
  if (!sys.active) return;
  if (sys.ship === 'shared' || (sys.cutscene && sys.cutscene.direction === 'dock')) sys.startTransition('undock');
  else { sys.syncPods(); sys.updateTerminalScreen(); }
  }

/**
 * `net:resumed`. A **훈련장** is not the squad's mission (individual entry, the lobby stays open), so a reconnect
 * while one runs must never read as `분대가 임무 중` — it points at the terminal instead.
 */
export function onResumed(sys: HubSystem, inProgress: boolean): void {
  if (!sys.active) return;
  if (sys.ship !== 'shared') sys.swapDirect('shared');
  const training = sys.trainingRunning();
  const raid = inProgress && !training;
  const net = sys.ctx.net;
  /*
   * 2026-09-07: a reconnect into a **running raid** goes straight back into the mission instead of parking the
   * player in the shared ship next to a pod. The relay keeps a dropped raider's slot for the whole mission and the
   * host keeps their body parked, so the squad member returns exactly where they left off — walking to a pod first
   * was busywork that could also time the body out. A 훈련장 is still joined by hand (it is entered individually).
   */
  if (raid && net?.lobby && typeof net.rejoinMission === 'function') {
    sys.ctx.bus.emit('ui:notify', { text: '진행 중인 임무로 복귀합니다', kind: 'warning', duration: 4 });
    // one turn later: `swapDirect` above rebuilt the interior this frame, and `rejoinMission` tears it down again
    queueMicrotask(() => {
      if (!sys.active || sys.ctx.phase !== 'hub' || !net.missionInProgress) return;
      net.rejoinMission();        // → net:gameStarting + game:newMission → teardown('mission')
    });
    return;
  }
  sys.ctx.bus.emit('ui:notify', {
    text: training ? '함선에 재접속했습니다 — 훈련장이 열려 있습니다 (터미널에서 합류)'
      : '함선에 재접속했습니다',
    kind: 'success', duration: 5,
  });
  }
