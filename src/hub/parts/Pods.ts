/**
 * src/hub/parts/Pods.ts — **발사 포드 · 카운트다운 · 출격**.
 *
 * 포드에 타면 준비 완료가 되고, 접속한 전원이 준비되면 3초 카운트다운 뒤 호스트가 `startGame` 한다.
 * 임무가 진행 중이면 포드는 재합류 입구가 된다. 탑승을 막는 이유(`podBlockReason`)는 프롬프트로
 * 보여 준다 — `canInteract:false` 로 막으면 프롬프트 자체가 사라져 이유를 알 수 없다.
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
import { LaunchWarnPanel } from '../ui/LaunchWarnPanel';
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
/* 격납고 (2026-09-08): the visit status line lives with the rest of the hangar logic. */
import * as Hangar from './Hangar';
import type { HubSystem } from '../HubSystem';

export function getLaunchSlots(sys: HubSystem): readonly HubLaunchSlot[] { return sys.slots; }

/* ── pods ──────────────────────────────────────────────────────────────── */
export function localSlot(sys: HubSystem): number { return sys.ctx.net?.lobby ? sys.ctx.net.localSlot : 0; }

export function podPrompt(sys: HubSystem, slot: number): string | null {
  if (!sys.podCanInteract(slot)) return null;
  return sys.podBlockReason(slot) ?? (sys.ctx.net?.lobby && sys.ctx.net.missionInProgress ? '임무 진행 중 — 재투입' : '발사 슬롯 탑승');
  }

/**
 * Basic pod availability: the pod is reachable and free. The **reasons boarding is refused anyway** live in
 * `podBlockReason` — they keep `canInteract` true on purpose, because `ctx.interactables.findBest` skips an
 * interactable that answers false and the player would then see no prompt at all (and no reason).
 */
export function podCanInteract(sys: HubSystem, slot: number): boolean {
  const ctx = sys.ctx;
  if (ctx.phase !== 'hub' || sys.cutscene || sys.travelling || sys.boardedSlot >= 0 || sys.menu.isOpen || sys.wbMenu.isOpen
    || sys.launchWarn.isOpen || sys.housingMode.active || sys.corpMenuOpen()) return false;
  if (slot !== sys.localSlot()) return false;
  const pod = sys.pods[slot];
  return !!pod && pod.occupant === null;
  }

/**
 * Why boarding is refused right now (also the pod's prompt text), or null when the slot takes us:
 * a training runs in the lobby (join from the terminal instead), or the ship has no 목표 행성 (Phase 11).
 */
export function podBlockReason(sys: HubSystem, slot: number): string | null {
  void slot;
  // 2026-09-08: 튜토리얼이 아직 출격 단계에 오지 않았으면 지금 해야 할 일을 프롬프트에 그대로 띄운다
  const tut = sys.ctx.tutorial?.blockReason('board') ?? null;
  if (tut) return tut;
  if (sys.trainingRunning()) return '훈련 진행 중 — 터미널에서 합류';
  if (sys.planet === null) return '목표 행성 미지정 — 터미널에서 지정';
  return null;
  }

export function boardPod(sys: HubSystem, slot: number): void {
  const ctx = sys.ctx;
  if (!sys.podCanInteract(slot)) return;
  const net = ctx.net;
  if (sys.trainingRunning()) {
    // pods stay closed while a training runs: the terminal's 시뮬레이션 훈련장 entry joins it
    ctx.bus.emit('ui:notify', { text: '훈련 진행 중 — 터미널에서 합류할 수 있습니다', kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return;
  }
  if (sys.planet === null) {
    // 목표 행성 미지정: nothing to launch at (the server refuses a raid start with `no_planet` as well)
    ctx.bus.emit('ui:notify', { text: '목표 행성이 없습니다 — 터미널에서 행성을 지정하세요', kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return;
  }
  if (net?.lobby && net.missionInProgress) {
    ctx.bus.emit('ui:notify', { text: '임무에 재투입합니다', kind: 'warning' });
    net.rejoinMission();          // → net:gameStarting + game:newMission → teardown('mission')
    return;
  }
  // 출격 준비 경고 (2026-09-08): 주무기 · 탄약 · 가방 · 방탄복 · 전술 임플란트 · 회복 아이템을 훑고, 걸리는 게
  // 있으면 이유를 전부 보여 준 뒤 확인을 받는다. 막지는 않는다 — 같은 조합을 한 번 넘겼으면 다시 묻지 않는다.
  const warnings = ctx.inventory?.getLaunchWarnings?.() ?? [];
  const sig = LaunchWarnPanel.signatureOf(warnings);
  if (warnings.length === 0) sys.launchWarnAck = '';   // fully kitted out again → the next lapse asks afresh
  else if (sig !== sys.launchWarnAck) {
    sys.launchWarn.open(warnings, () => { sys.launchWarnAck = sig; sys.boardPod(slot); });
    return;
  }
  const pod = sys.pods[slot];
  sys.boardedSlot = slot;
  sys.boardedAt = ctx.time;
  const p = ctx.player;
  if (p) {
    p.spawnStanding(pod.def.position, pod.def.yaw);
    p.setInPod(true);
    p.setControlsEnabled(false);
    pod.getCameraShot(_camPos, _camLook);
    p.setCameraOverride(_camPos, _camLook);
  }
  if (net?.lobby) { net.setReady(true); sys.readySentAt = ctx.time; }
  ctx.bus.emit('audio:play', { id: 'ui_equip' });
  sys.syncPods();
  }

/** Un-board. `sendReady` false when the lobby state already changed (reset / mission start / leaving the ship). */
export function leavePod(sys: HubSystem, sendReady: boolean, placeOutside = true): void {
  if (sys.boardedSlot < 0) return;
  const ctx = sys.ctx;
  const pod = sys.pods[sys.boardedSlot];
  sys.boardedSlot = -1;
  const p = ctx.player;
  if (p) {
    p.setInPod(false);
    p.setCameraOverride(null);
    p.setControlsEnabled(true);
    if (placeOutside && pod) {
      _front.copy(pod.def.position).addScaledVector(pod.def.door, 1.3);
      p.spawnStanding(_front, pod.def.yaw);
    }
  }
  if (sendReady && ctx.net?.lobby) ctx.net.setReady(false);
  if (sys.countdown >= 0) { sys.countdown = -1; ctx.bus.emit('ui:notify', { text: '발사 취소', kind: 'warning' }); }
  sys.syncPods();
  }

/** Mirror lobby ready flags into pod occupancy / tags; emits `hub:slotChanged` on changes. */
export function syncPods(sys: HubSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const lobby = net?.lobby ?? null;
  const localId: PeerId = net?.localId ?? 'local';
  const localSlot = sys.localSlot();
  const me = lobby ? lobby.players.find((q) => q.id === localId) : undefined;
  const training = sys.trainingRunning();

  // server dropped our ready flag (lobby reset / kick-back) while we sit in the pod → step out
  if (sys.boardedSlot >= 0 && lobby && me && !me.ready && !lobby.started && ctx.time - sys.readySentAt > READY_ECHO_GRACE) {
    sys.leavePod(false, true);
    ctx.bus.emit('ui:notify', { text: '발사 슬롯이 초기화되었습니다', kind: 'warning' });
    return;   // leavePod re-runs syncPods
  }

  // 발사 준비 패널 cells, filled while we walk the pods below (`null` = no member in that slot at all)
  const cells: (ReadyCellInfo | null)[] = new Array(HUB_READY_CELLS).fill(null);

  for (let i = 0; i < sys.pods.length; i++) {
    const pod = sys.pods[i];
    const slot = pod.slot;
    let occupant: PeerId | null = null;
    let name = '빈 슬롯', state = '—', local = false;
    let present = false, connected = true, peerId: PeerId | null = null;
    if (slot === localSlot && (!lobby || me)) {
      local = true; present = true; peerId = localId;
      name = net?.playerName ?? '스캐빈저';
      if (sys.boardedSlot === slot) { occupant = localId; state = '탑승 완료'; }
      else state = training ? '훈련 진행 중' : net?.missionInProgress ? '임무 진행 중 — 재투입' : '대기 중';
    } else if (lobby) {
      const q = lobby.players.find((pl) => pl.slot === slot);
      if (q) {
        name = q.name; present = true; peerId = q.id; connected = q.connected;
        if (!q.connected) state = '연결 끊김';
        else if (training) state = q.inMission ? '훈련 중' : '대기 중';      // a training never closes a pod door
        else if (q.ready) { occupant = q.id; state = lobby.started ? '임무 중' : '탑승 완료'; }
        else state = '대기 중';
      }
    }
    if (present && slot < HUB_READY_CELLS) {
      cells[slot] = {
        slot, peerId, name, ready: occupant !== null, local, connected, state,
        ...sys.crewLook(local, peerId),
      };
    }
    const changed = pod.setDisplay({ occupant, name, state, local, closed: occupant !== null });
    if (sys.slots[i]) sys.slots[i].occupant = occupant;
    if (changed) ctx.bus.emit('hub:slotChanged', { slot, peerId: occupant, local });
  }
  // interactive (blocker + software cursor) only while WE are boarded — see `ui/ReadyPanel`
  sys.ready.sync(cells, sys.boardedSlot >= 0 && ctx.phase === 'hub' && !sys.cutscene);
  }

/* ── launch countdown ──────────────────────────────────────────────────── */
export function resolveSeed(sys: HubSystem): number {
  const lobby = sys.ctx.net?.lobby;
  if (lobby && lobby.seed !== null) return lobby.seed >>> 0;
  return (sys.missionSeed ?? randomSeed()) >>> 0;
  }

export function launch(sys: HubSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const seed = sys.resolveSeed();
  const planet = sys.planet;
  if (planet === null) return;         // the pod gate should have caught this (server: `no_planet`)
  if (net?.lobby && net.isHost) {
    sys.launched = true;
    // server → game:start {planet} → net emits game:newMission → teardown('mission')
    net.startGame(seed, 'raid', planet);
  } else if (!net?.lobby) {
    // the emitter sets the mode AND the planet before `game:newMission` (Phase 7 / 11 contract)
    ctx.missionMode = 'raid';
    ctx.missionPlanet = planet;
    ctx.bus.emit('game:newMission', { seed, mode: 'raid', planet });
  }
  }

export function tickCountdown(sys: HubSystem, dt: number): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const lobby = net?.lobby ?? null;
  const boarded = sys.boardedSlot >= 0;
  let ready = boarded ? 1 : 0, total = 1, allReady = boarded;
  if (lobby) {
    const connected = lobby.players.filter((p) => p.connected);
    total = Math.max(1, connected.length);
    ready = connected.filter((p) => p.ready).length;
    allReady = boarded && !lobby.started && connected.length > 0 && ready === connected.length;
  }
  const authority = !lobby || (net?.isHost ?? false);

  if (allReady && sys.countdown < 0 && !sys.launched) {
    sys.countdown = HUB_LAUNCH_COUNTDOWN;
    sys.lastCountdownSecond = -1;
    ctx.bus.emit('audio:play', { id: 'ui_equip' });
  } else if (!allReady) {
    sys.launched = false;
    if (sys.countdown >= 0) { sys.countdown = -1; if (lobby) ctx.bus.emit('ui:notify', { text: '발사 취소 — 승무원 대기', kind: 'warning' }); }
  }

  if (sys.countdown >= 0) {
    sys.countdown -= dt;
    const sec = Math.max(0, Math.ceil(sys.countdown));
    if (sec !== sys.lastCountdownSecond) {
      sys.lastCountdownSecond = sec;
      // Clients mirror the host's countdown locally (same ready state, same length) so HUD/audio/chat react everywhere.
      ctx.bus.emit('hub:launchCountdown', { seconds: sec, ready, total });
      if (sec > 0) ctx.bus.emit('audio:play', { id: 'ui_click' });
    }
    if (sys.countdown <= 0) {
      sys.countdown = -1;
      if (authority) sys.launch();
      return;
    }
  }

  // status line
  const visit = Hangar.visitStatus(sys);
  if (boarded) {
    if (sys.countdown >= 0) sys.status.set(String(Math.max(0, Math.ceil(sys.countdown))), '발사 준비 완료', { count: true, progress: 1 - sys.countdown / HUB_LAUNCH_COUNTDOWN });
    else if (lobby) sys.status.set(`탑승 대기 중 (${ready}/${total})`, '슬롯에서 내리기', { keycap: 'E' });
    else sys.status.set('발사 준비', '슬롯에서 내리기', { keycap: 'E' });
  } else if (lobby && net?.missionInProgress) {
    if (sys.trainingRunning()) sys.status.set(`훈련 진행 중 (${sys.trainingCount()}명)`, '터미널에서 합류할 수 있습니다');
    else sys.status.set('임무 진행 중', '발사 슬롯에 탑승하면 재투입됩니다');
  } else if (visit) {
    // 격납고 (2026-09-08): inside a bay's ship — the only reminder of how to get back out (and that it is read-only)
    sys.status.set(visit.main, visit.sub);
  } else {
    sys.status.hide();
  }
  }
