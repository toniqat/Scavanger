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
import { CREW_CARD_MIN_INTERVAL_S, CREW_LOADOUT_COOLDOWN_S, HUB_DOCKING_DURATION, HUB_LAUNCH_COUNTDOWN, HUB_READY_BLOCKER, HUB_READY_CELLS, Keys, NET_SLOT_COLORS, ROOM_PURPOSE_COLOR, ROOM_PURPOSE_LABEL_KO } from '@/shared';
import { PersonalShip } from '../interiors/PersonalShip';
import { SharedShip } from '../interiors/SharedShip';
import type { StationDef } from '../interiors/stations';
import type { ShipInterior } from '../interiors/types';
import { FurnitureLayer } from '../interiors/Furniture';
import { roomAtWorld } from '../interiors/RoomLayout';
import { HousingMode } from '../HousingMode';
import { LaunchPod } from '../LaunchPod';
import { Terminal } from '../Terminal';
import { Computer } from '../Computer';
import { DockingCutscene, type DockDirection } from '../DockingCutscene';
import { HubMenu } from '../ui/HubMenu';
import { HubStatus } from '../ui/HubStatus';
import { ReadyPanel, type ReadyCellInfo } from '../ui/ReadyPanel';
import { randomSeed } from '../ui/dom';
import { type DockTransition, LOCK_REQUEST_GRACE_MS, READY_ECHO_GRACE, UNBOARD_GRACE, _camLook, _camPos, _front } from '../model';
/* 공용 함선 격납고 (2026-09-08) */
import * as Hangar from './Hangar';
import type { HubSystem } from '../HubSystem';

/**
 * `fromBay` (2026-09-08, 격납고): the bay slot we just walked out of — the shared ship then spawns the player in
 * front of that bay instead of at the deck's default position. Ignored for the personal ship.
 */
export function build(sys: HubSystem, ship: HubShipKind, viaAirlock: boolean, fromBay?: number, prebuilt?: ShipInterior): THREE.Vector3 {
  const ctx = sys.ctx;
  // 2026-09-10: a docking cutscene hands over the ship it built (and compiled) while it played — see `Transitions.prebuildTarget`
  const interior: ShipInterior = prebuilt ?? (ship === 'personal' ? new PersonalShip() : new SharedShip());
  ctx.scene.add(interior.root);
  sys.interior = interior;
  sys.ship = ship;
  sys.collider = interior.collider;
  /*
   * 격납고 (2026-09-08): a personal ship entered from a bay carries **no launch pod**. Its slot-0 pod is the solo
   * launch route, and the squad launches from the shared deck — offering it here would drop a member out of the
   * lobby's own countdown. Boarding a visited stranger's pod would be nonsense besides.
   */
  const podDefs = sys.visit ? [] : interior.pods;
  sys.pods = podDefs.map((def) => new LaunchPod(ctx, def, NET_SLOT_COLORS[def.slot % NET_SLOT_COLORS.length], interior.collider, {
    getPrompt: () => sys.podPrompt(def.slot),
    canInteract: () => sys.podCanInteract(def.slot),
    interact: () => sys.boardPod(def.slot),
  }));
  sys.slots = podDefs.map((d) => ({ slot: d.slot, position: d.position.clone(), yaw: d.yaw, occupant: null }));
  const canUseConsole = (): boolean => sys.stationUsable();
  // 2026-09-08: 튜토리얼이 아직 터미널 단계에 오지 않았으면 터미널만 잠근다 (작업대 · 컴퓨터는 그대로)
  const canUseTerminal = (): boolean => sys.stationUsable() && !ctx.tutorial?.blockReason('terminal');
  /*
   * 개인 함선 방문 (2026-09-08): someone else's ship registers **no consoles at all**. `stationUsable()` already
   * refuses them, but an unusable interactable still sits in the registry and competes with `findBest` for the
   * player's prompt — a visit should leave nothing to press but the way out.
   */
  const ro = sys.visitReadOnly;
  sys.terminal = ro ? null : new Terminal(ctx, interior.terminal, () => sys.menu.open(), canUseTerminal);
  /*
   * 2026-09-12 (사용자 결정 — 정비 벤치 제거): 여기서 `hub_workbench` 를 등록했다. 공유 함선 후벽의 벤치도,
   * 개인 함선의 `furn_repair_bench` 가구도 모두 무기 수리 창을 열었는데, 이제 수리는 **인벤토리에서** 한다
   * (재료만 있으면 함선 어디서든). 벤치 소품 자체는 병기고 실루엣으로 남아 있고 누를 것만 없다.
   */
  sys.computer = ro ? null : new Computer(ctx, interior.computer, () => sys.openCorpMenu(), canUseConsole);
  sys.buildStations(interior);
  sys.buildHousing(interior);
  if (ship === 'shared') Hangar.buildBays(sys);
  if (ship === 'personal' && sys.visit) buildHangarExit(sys, interior);

  /*
   * 격납고 (2026-09-08): two extra entry points. Walking into a bay's ship puts us at its **airlock** (we came in
   * through the rear ramp); walking back out puts us in front of the bay we left, facing the parked ship.
   */
  const bay = ship === 'shared' && fromBay !== undefined ? interior.bays?.[fromBay] ?? null : null;
  const viaBay = ship === 'personal' && sys.visit !== null;
  const enterViaAirlock = viaAirlock || viaBay;
  const yaw = bay ? bay.yaw : enterViaAirlock ? interior.airlockYaw : interior.spawnYaw;
  let spawn = bay ? bay.entrance : enterViaAirlock ? interior.airlock : interior.spawn;
  // Walking in from a bay: far enough off the airlock plate to clear `hub_hangar_exit`'s radius (2.2 m below), so
  // 격납고로 나가기 is not already on screen the instant you step inside.
  if (viaBay) spawn = spawn.clone().addScaledVector(new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), 3.0);
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
  // 방문 중(남의 함선)에는 시설이 통째로 없다 — 둘러보기 전용 (2026-09-08)
  if (!s || sys.visitReadOnly) return;
  sys.addStation('hub_implant_bay', s.implantBay, '전술 임플란트 장착', () => {
    const inv = sys.ctx.inventory;
    if (inv && !inv.isOpen) inv.toggleBag();
  });
  /*
   * 공유 함선의 고정 식탁 (주방 A-3c, 2026-09-11). 개인 함선의 식탁은 주방에 놓는 **가구**지만 공유 함선에는
   * 가구가 없으므로, 인테리어가 심어 둔 지점 하나가 그 자리를 대신한다 — 계약대로 `openDiningTable(null)` 의
   * `null` 이 곧 「공유 함선의 고정 식탁」이다 (uid 가 없다). 개인 함선에는 `diningTable` 자체가 없다.
   */
  if (s.diningTable) sys.addStation('hub_dining_table', s.diningTable, '식탁 · 식사', () => openDiningTable(sys.ctx, null), 2.4);
  }

/**
 * 식사 화면 (주방 A-3c, 2026-09-11): 가구 식탁은 그 조각의 `uid`, **공유 함선의 고정 식탁은 `null`** 로 연다
 * (`HousingRef.openDiningTable` 의 계약). 다른 폴더가 아직 없을 때를 대비해 duck-typed 로 부른다.
 */
function openDiningTable(ctx: GameContext, uid: string | null): void {
  const h = ctx.housing;
  if (h && typeof h.openDiningTable === 'function') h.openDiningTable(uid);
  else ctx.bus.emit('ui:notify', { text: '식탁을 사용할 수 없습니다', kind: 'warning' });
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
  /*
   * 개인 함선 방문 (2026-09-08): a visited ship's furniture comes off that member's `ship state`, never from
   * `ctx.housing` (which is *our* ship). A sourced layer subscribes to nothing and registers no interactables, and
   * 함선 관리 is denied the interior, so nothing in here can be touched.
   */
  const source = sys.visitShip ? Hangar.furnitureSource(ctx, sys.visitShip) : null;
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
    // 온실 개편 (2026-09-11): 재배 스테이션 — 옛 재배층 경로는 위에 그대로 두고 새 문을 하나 더 연다
    onGrowStation: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openGrowStation === 'function') h.openGrowStation(uid);
      else ctx.bus.emit('ui:notify', { text: '재배 스테이션을 사용할 수 없습니다', kind: 'warning' });
    },
    /*
     * 정비 벤치 (Phase 8 → 2026-09-12 은퇴): `furn_repair_bench` 는 `data/furniture.csv` 에서 `retired=1` 이라
     * `ShipState.sanitize` 가 놓인 것을 걷어내고 재료로 환불한다 — 이 칸에 도달할 길이 없다. `FurnitureInteraction`
     * 은 계약이라 값은 남아 있으므로 분기도 남긴다(`interiors/Furniture` 에서 **아무것도 하지 않는** 분기).
     */
    onBookshelf: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openBookshelfMenu === 'function') h.openBookshelfMenu(uid);
      else ctx.bus.emit('ui:notify', { text: '책장을 사용할 수 없습니다', kind: 'warning' });
    },
    // 연구실 (A-12, 2026-09-11): 분석기 — 표본 넣기 · 해석 회수 · 해석 도감
    onAnalyzer: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openAnalyzer === 'function') h.openAnalyzer(uid);
      else ctx.bus.emit('ui:notify', { text: '분석기를 사용할 수 없습니다', kind: 'warning' });
    },
    // 온실 배양조 (A-14, 2026-09-11): 배지 붓기 · 세포주 넣기 · 수확
    onCultureTank: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openCultureTank === 'function') h.openCultureTank(uid);
      else ctx.bus.emit('ui:notify', { text: '배양조를 사용할 수 없습니다', kind: 'warning' });
    },
    // 주방 식탁 (A-3c, 2026-09-11): 개인 함선의 **가구** 식탁이므로 그 조각의 uid 로 연다
    // (공유 함선의 고정 식탁은 가구가 아니라 `buildStations` 의 `hub_dining_table` 이고 `null` 로 연다)
    onDiningTable: (uid) => openDiningTable(ctx, uid),
  }, source);
  sys.housingMode.setShip(source ? null : interior, source ? null : sys.furniture);
  sys.refreshRoomSigns();
  }

/**
 * 격납고 (2026-09-08): the way back out of a bay's ship. The airlock at the end of the corridor is the rear ramp we
 * came in through, so E on it drops us in front of the bay again. Registered for **our own** ship too — the personal
 * ship reached from the hangar has no other exit.
 */
export function buildHangarExit(sys: HubSystem, interior: ShipInterior): void {
  const ctx = sys.ctx;
  const id = 'hub_hangar_exit';
  const anchor = interior.airlock.clone();
  ctx.interactables.register({
    id,
    position: anchor,
    radius: 2.2,
    getPrompt: () => (sys.visit && !sys.cutscene && sys.boardedSlot < 0 && !sys.housingMode.active ? '격납고로 나가기' : null),
    canInteract: () => sys.visit !== null && !sys.cutscene,
    interact: () => { sys.returnToHangar(); },
  });
  sys.stationIds.push(id);
  }

export function roomPurpose(sys: HubSystem, i: number): RoomPurpose | null {
  // 방문 중에는 그 대원의 `ship state` 가 방 용도를 말한다 (우리 `ctx.housing` 은 우리 함선이다)
  const visit = sys.visitShip;
  if (visit) return visit.rooms[i]?.purpose ?? null;
  const h = sys.ctx.housing;
  if (!h || typeof h.getRoom !== 'function') return null;
  try { return h.getRoom(i).purpose; } catch { return null; }
  }

export function roomPurposeLabel(sys: HubSystem, i: number): string {
  const p = sys.roomPurpose(i);
  return p ? ROOM_PURPOSE_LABEL_KO[p] : '빈 방';
  }

/**
 * Door sign + 방 조명 of one room (an empty room reads dark, an assigned one is lit and gets a pool light).
 *
 * 2026-09-11 (연구실): the sign accent is the purpose's **own** colour (`ROOM_PURPOSE_COLOR`, the same table the
 * 함선 tab 방 목록 and the 시설 관리 카드 draw their thumbnails from) instead of one amber for every assigned room —
 * so 온실 reads green, 연구실 purple and 작업실 amber from the corridor, the way they already do in the UI.
 * CLAUDE.md 「같은 것을 두 폴더가 쓰면 `shared` 로 뽑는다」: the table is in `shared`, nothing is copied here.
 */
export function refreshRoomSign(sys: HubSystem, i: number): void {
  const ship = sys.interior;
  if (!(ship instanceof PersonalShip)) return;
  const p = sys.roomPurpose(i);
  const assigned = !!p && p !== 'empty';
  ship.setRoomLabel(i, sys.roomPurposeLabel(i), p && assigned ? ROOM_PURPOSE_COLOR[p] : '#e8e6e1');
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

/**
 * Terminal / station consoles are usable while walking the ship (not boarded, no menu, not docking, not decorating,
 * **not warping** — 2026-09-09: the 창문 워프 no longer runs a cutscene, so `travelling` has to be checked here itself).
 */
export function stationUsable(sys: HubSystem): boolean {
  // 방문 중(남의 함선)에는 아무것도 쓸 수 없다 — 터미널 · 정비대 · 기업 네트워크 · 임플란트 시술대 전부 (2026-09-08)
  if (sys.visitReadOnly) return false;
  return sys.ctx.phase === 'hub' && !sys.menu.isOpen && !(sys.ctx.inventory?.isOpen ?? false)
    && !(sys.ctx.housing?.isMenuOpen ?? false) && !sys.corpMenuOpen() && sys.boardedSlot < 0 && !sys.cutscene && !sys.travelling
    && !sys.housingMode.active;
  }

export function disposeInterior(sys: HubSystem): void {
  // a ship prebuilt for a transition that never finished (a new transition, a re-entry, the mission) goes with it
  if (sys.pendingInterior) { sys.pendingInterior.interior.dispose(); sys.pendingInterior = null; }
  Hangar.clearBays(sys);
  sys.clearLeaderHandoff();   // 2026-09-09: 분대장 넘기기 상호작용도 인테리어와 함께 걷는다
  sys.housingMode.setShip(null, null);
  sys.furniture?.dispose(); sys.furniture = null;
  for (const pod of sys.pods) pod.dispose();
  sys.pods = [];
  for (const id of sys.stationIds) sys.ctx.interactables.unregister(id);
  sys.stationIds.length = 0;
  sys.terminal?.dispose(); sys.terminal = null;
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
  sys.status.hide();
  sys.ready.hide();
  sys.cutscene?.dispose(); sys.cutscene = null;
  sys.cancelTravel();
  sys.disposeInterior();
  sys.visit = null; sys.visitShip = null; sys.pendingBay = null;   // 격납고: a visit never survives leaving the hub
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
