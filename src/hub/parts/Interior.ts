/**
 * src/hub/parts/Interior.ts — **함선 내부 짓기 · 허물기**.
 *
 * 개인 함선(조종석 → 복도 → 방 10개 → 에어락)과 공유 함선의 지오메트리, 스테이션 배치,
 * 가구 배치(`buildHousing`), 방 추적과 표지판. 모든 클라이언트가 같은 지오메트리를 만들어야
 * 공유 함선의 위치 스냅샷이 맞는다.
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

export function build(sys: HubSystem, ship: HubShipKind, viaAirlock: boolean): THREE.Vector3 {
  const ctx = sys.ctx;
  const interior: ShipInterior = ship === 'personal' ? new PersonalShip() : new SharedShip();
  ctx.scene.add(interior.root);
  sys.interior = interior;
  sys.ship = ship;
  sys.collider = interior.collider;
  sys.pods = interior.pods.map((def) => new LaunchPod(ctx, def, NET_SLOT_COLORS[def.slot % NET_SLOT_COLORS.length], interior.collider, {
    getPrompt: () => sys.podPrompt(def.slot),
    canInteract: () => sys.podCanInteract(def.slot),
    interact: () => sys.boardPod(def.slot),
  }));
  sys.slots = interior.pods.map((d) => ({ slot: d.slot, position: d.position.clone(), yaw: d.yaw, occupant: null }));
  const canUseConsole = (): boolean => sys.stationUsable();
  // 2026-09-08: 튜토리얼이 아직 터미널 단계에 오지 않았으면 터미널만 잠근다 (작업대 · 컴퓨터는 그대로)
  const canUseTerminal = (): boolean => sys.stationUsable() && !ctx.tutorial?.blockReason('terminal');
  sys.terminal = new Terminal(ctx, interior.terminal, () => sys.menu.open(), canUseTerminal);
  // the personal ship has no built-in bench since Phase 8 (a placed `furn_repair_bench` opens the same menu)
  sys.workbench = interior.workbench ? new Workbench(ctx, interior.workbench, () => sys.wbMenu.open(), canUseConsole) : null;
  sys.computer = new Computer(ctx, interior.computer, () => sys.openCorpMenu(), canUseConsole);
  sys.buildStations(interior);
  sys.buildHousing(interior);

  const spawn = viaAirlock ? interior.airlock : interior.spawn;
  const yaw = viaAirlock ? interior.airlockYaw : interior.spawnYaw;
  const p = ctx.player;
  if (p) {
    p.setInPod(false);
    p.setCameraOverride(null);
    p.setInterior(interior.collider);
    p.spawnStanding(spawn, yaw);
    p.setControlsEnabled(true);
  }
  sys.setSpaceMode(true);
  sys.countdown = -1; sys.launched = false; sys.lastCountdownSecond = -1;
  sys.knownLobbyPlanet = ctx.net?.lobby ? (ctx.net.lobbyPlanet ?? null) : null;
  sys.applyPlanetLook();
  sys.syncPods();
  sys.updateTerminalScreen();
  return spawn;
  }

/**
 * 함선 시설: the implant bay, which opens the Tab ship screen (inventory window: 창고 / 장비 + 임플란트 슬롯 /
 * 가방). Its geometry is already merged into the interior. (Phase 8 removed the hydroponics station — 재배 is
 * the 온실 room's `furn_grow_rack` furniture now.)
 */
export function buildStations(sys: HubSystem, interior: ShipInterior): void {
  const s = interior.stations;
  if (!s) return;
  sys.addStation('hub_implant_bay', s.implantBay, '전술 임플란트 장착', () => {
    const inv = sys.ctx.inventory;
    if (inv && !inv.isOpen) inv.toggleBag();
  });
  }

export function addStation(sys: HubSystem, id: string, def: StationDef, prompt: string | (() => string), onUse: () => void, radius = 2.3): void {
  const it: Interactable = {
    id,
    position: def.position.clone(),
    radius,
    getPrompt: () => (sys.stationUsable() ? (typeof prompt === 'function' ? prompt() : prompt) : null),
    canInteract: () => sys.stationUsable(),
    interact: onUse,
  };
  sys.ctx.interactables.register(it);
  sys.stationIds.push(id);
  }

/**
 * 함선 꾸미기 (personal ship): the furniture layer and the housing-mode controller.
 *
 * Phase 8 UI pass: the room door consoles (`hub_room_<i>`) and the cockpit facility console (`hub_facility`) are
 * **gone**, along with their geometry — rooms, purposes and facilities are managed from the Tab 함선 tab and from
 * 시설 관리 (M). Only the furniture pieces themselves still answer to E.
 */
export function buildHousing(sys: HubSystem, interior: ShipInterior): void {
  const ctx = sys.ctx;
  if (!(interior instanceof PersonalShip)) { sys.housingMode.setShip(null, null); return; }
  sys.furniture = new FurnitureLayer(ctx, interior.rooms, interior.collider, {
    canUse: () => sys.stationUsable(),
    onBench: (kind, level) => {
      const inv = ctx.inventory;
      if (inv && typeof inv.openBenchCraft === 'function') inv.openBenchCraft(kind, level);
      else ctx.bus.emit('ui:notify', { text: '작업대를 사용할 수 없습니다', kind: 'warning' });
    },
    onRangeConsole: () => {
      const h = ctx.housing;
      if (h && typeof h.openPresetMenu === 'function') h.openPresetMenu();
    },
    onSimHub: () => sys.startTraining(),
    onGrowRack: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openGrowMenu === 'function') h.openGrowMenu(uid);
      else ctx.bus.emit('ui:notify', { text: '재배층을 사용할 수 없습니다', kind: 'warning' });
    },
    onRepairBench: () => sys.wbMenu.open(),
    onBookshelf: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openBookshelfMenu === 'function') h.openBookshelfMenu(uid);
      else ctx.bus.emit('ui:notify', { text: '책장을 사용할 수 없습니다', kind: 'warning' });
    },
  });
  sys.housingMode.setShip(interior, sys.furniture);
  sys.refreshRoomSigns();
  }

export function roomPurpose(sys: HubSystem, i: number): RoomPurpose | null {
  const h = sys.ctx.housing;
  if (!h || typeof h.getRoom !== 'function') return null;
  try { return h.getRoom(i).purpose; } catch { return null; }
  }

export function roomPurposeLabel(sys: HubSystem, i: number): string {
  const p = sys.roomPurpose(i);
  return p ? ROOM_PURPOSE_LABEL_KO[p] : '빈 방';
  }

/** Door sign + 방 조명 of one room (an empty room reads dark, an assigned one is lit and gets a pool light). */
export function refreshRoomSign(sys: HubSystem, i: number): void {
  const ship = sys.interior;
  if (!(ship instanceof PersonalShip)) return;
  const p = sys.roomPurpose(i);
  const assigned = !!p && p !== 'empty';
  ship.setRoomLabel(i, sys.roomPurposeLabel(i), assigned ? '#ffd27a' : '#e8e6e1');
  ship.setRoomLit(i, assigned);
  }

export function refreshRoomSigns(sys: HubSystem): void {
  if (!(sys.interior instanceof PersonalShip)) return;
  for (const r of sys.interior.rooms) sys.refreshRoomSign(r.index);
  }

/** Track the personal-ship room under the player; emits `hub:roomEntered` on change (null = corridor / cockpit). */
export function trackRoom(sys: HubSystem): void {
  const p = sys.ctx.player;
  let room: number | null = null;
  if (p && sys.interior instanceof PersonalShip) room = roomAtWorld(p.position.x, p.position.z);
  if (room === sys._currentRoom) return;
  sys._currentRoom = room;
  sys.ctx.bus.emit('hub:roomEntered', { room, purpose: room === null ? null : sys.roomPurpose(room) });
  }

/** Terminal / station consoles are usable while walking the ship (not boarded, no menu, not docking, not decorating). */
export function stationUsable(sys: HubSystem): boolean {
  return sys.ctx.phase === 'hub' && !sys.menu.isOpen && !sys.wbMenu.isOpen && !(sys.ctx.inventory?.isOpen ?? false)
    && !(sys.ctx.housing?.isMenuOpen ?? false) && !sys.corpMenuOpen() && sys.boardedSlot < 0 && !sys.cutscene && !sys.housingMode.active;
  }

export function disposeInterior(sys: HubSystem): void {
  sys.housingMode.setShip(null, null);
  sys.furniture?.dispose(); sys.furniture = null;
  for (const pod of sys.pods) pod.dispose();
  sys.pods = [];
  for (const id of sys.stationIds) sys.ctx.interactables.unregister(id);
  sys.stationIds.length = 0;
  sys.terminal?.dispose(); sys.terminal = null;
  sys.workbench?.dispose(); sys.workbench = null;
  sys.computer?.dispose(); sys.computer = null;
  sys.interior?.dispose(); sys.interior = null;
  sys.collider = null;
  sys.ship = null;
  sys.slots = [];
  }

/**
 * Leave the hub. 'mission': `game:newMission` arrived (World already generated, Player already respawned — only
 * release our hooks). 'menu': back to the title (`game:abort` or 타이틀로) — also restores the planet atmosphere.
 */
export function teardown(sys: HubSystem, reason: 'mission' | 'menu'): void {
  if (!sys.interior && !sys.cutscene) return;
  const ctx = sys.ctx;
  if (sys.boardedSlot >= 0) sys.leavePod(false, false);
  sys.menu.close(false);
  sys.wbMenu.close(false);
  sys.status.hide();
  sys.ready.hide();
  sys.cutscene?.dispose(); sys.cutscene = null;
  sys.travelling = false;
  sys.disposeInterior();
  sys.countdown = -1; sys.launched = false;
  const p = ctx.player;
  if (p) {
    p.setInterior(null);
    p.setCameraOverride(null);
    p.setInPod(false);
    if (reason === 'menu') p.setControlsEnabled(true);
  }
  if (reason === 'menu') sys.setSpaceMode(false);
  if (sys._currentRoom !== null) { sys._currentRoom = null; ctx.bus.emit('hub:roomEntered', { room: null, purpose: null }); }
  ctx.bus.emit('hub:left', {});
  }

/** Level / ship implant / armor of a READY cell: local reads the refs, a peer reads its `crew card`. */
export function crewLook(sys: HubSystem, local: boolean, peerId: PeerId | null): Pick<ReadyCellInfo, 'level' | 'implant' | 'armorId'> {
  if (local) {
    const c = sys.crewCard();
    return { level: c.level, implant: c.implant, armorId: c.armor };
  }
  const net = sys.ctx.net;
  if (!peerId || !net || typeof net.getCrewCard !== 'function') return { level: null, implant: null, armorId: null };
  let card: CrewCardWire | null = null;
  try { card = net.getCrewCard(peerId); } catch { card = null; }
  if (!card) return { level: null, implant: null, armorId: null };
  return { level: card.level, implant: card.implant, armorId: card.armor };
  }
