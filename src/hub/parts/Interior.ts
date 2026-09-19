/**
 * src/hub/parts/Interior.ts — **building and tearing down a ship interior**.
 *
 * Geometry of the personal ship (cockpit → corridor → 10 rooms → airlock) and of the shared ship, the stations,
 * the furniture layer (`buildHousing`), room tracking and the door signs. Every client must build identical
 * geometry or the shared ship's position snapshots do not line up.
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
import { TablePlates } from '../interiors/TablePlates';   // 2026-09-16 plate models — squadmates' plates on the shared table
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
/* The shared ship's hangar (2026-09-08) */
import * as Hangar from './Hangar';
import * as SquadDock from './SquadDock';
/* 2026-09-15: the cockpit android bays · the standing spots in front of the launch pods · clearing the raid-entry fade */
import * as Androids from './Androids';
import * as Pods from './Pods';
import type { HubSystem } from '../HubSystem';

/**
 * `fromBay` (2026-09-08, the hangar): the bay slot we just walked out of — the shared ship then spawns the player in
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
  // 2026-09-15 (squads · dock matchmaking): which squad's shared ship this is — first, `sys.planet` below already reads it.
  // A bay's personal ship keeps the squad it hangs off; the ordinary personal ship belongs to nobody's squad.
  sys.shipLobbyCode = ship === 'shared' ? (sys.debugLobby?.code ?? ctx.net?.lobby?.code ?? null) : (sys.visit ? sys.shipLobbyCode : null);
  /*
   * Hangar (2026-09-08): a personal ship entered from a bay carries **no launch pod**. Its slot-0 pod is the solo
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
  // 2026-09-08: while the tutorial has not reached its terminal step only the terminal is locked (benches · computer stay)
  const canUseTerminal = (): boolean => sys.stationUsable() && !ctx.tutorial?.blockReason('terminal');
  /*
   * Visiting a personal ship (2026-09-08): someone else's ship registers **no consoles at all**. `stationUsable()` already
   * refuses them, but an unusable interactable still sits in the registry and competes with `findBest` for the
   * player's prompt — a visit should leave nothing to press but the way out.
   */
  const ro = sys.visitReadOnly;
  sys.terminal = ro ? null : new Terminal(ctx, interior.terminal, () => sys.menu.open(), canUseTerminal);
  /*
   * 2026-09-12 (user's decision — the repair bench was dropped): `hub_workbench` was registered here. The shared ship's
   * aft-wall bench and the personal ship's `furn_repair_bench` furniture both opened the weapon repair window; repair
   * now happens **in the inventory** (anywhere aboard, given the materials). The bench prop stays as an armoury silhouette.
   */
  // 2026-09-12: only the shared ship still has a built-in computer desk — the personal ship's is `furn_corp_computer`
  // furniture (the layer registers it under the same `hub_computer` id, see `interiors/Furniture`)
  sys.computer = ro || !interior.computer ? null : new Computer(ctx, interior.computer, () => sys.openCorpMenu(), canUseConsole);
  sys.buildStations(interior);
  sys.buildHousing(interior);
  /*
   * 2026-09-15 (android squadmates): only the shared ship has the three cockpit bays and the standing spots in front of
   * the launch pods. A visited ship (`visit`) gets none — `getAndroidBays` already answers empty, so nothing registers.
   */
  Androids.buildPodStands(sys);
  if (ship === 'shared') { Hangar.buildBays(sys); Androids.buildAndroidBays(sys); }
  if (ship === 'personal' && sys.visit) buildHangarExit(sys, interior);

  /*
   * Hangar (2026-09-08): two extra entry points. Walking into a bay's ship puts us at its **airlock** (we came in
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
  Pods.clearRaidLaunch(sys);   // 2026-09-15: the raid-entry fade's wall-clock timer never outlives the interior
  sys.knownLobbyPlanet = ctx.net && sys.squadLobby() ? (ctx.net.lobbyPlanet ?? null) : null;
  sys.applyPlanetLook();
  sys.syncPods();
  sys.updateTerminalScreen();
  return spawn;
  }

/**
 * Ship stations: the implant bay, which opens the Tab ship screen (inventory window: `창고` / `장비` + implant slots /
 * `가방`). Its geometry is already merged into the interior. (Phase 8 removed the hydroponics station — growing is
 * the `온실` room's `furn_grow_rack` furniture now.)
 */
export function buildStations(sys: HubSystem, interior: ShipInterior): void {
  const s = interior.stations;
  // During a visit (someone else's ship) there are no stations at all — looking around only (2026-09-08)
  if (!s || sys.visitReadOnly) return;
  // 2026-09-12: only the shared ship has a built-in bay; the personal ship's is `furn_implant_bay` furniture
  if (s.implantBay) sys.addStation('hub_implant_bay', s.implantBay, '전술 임플란트 장착', () => openImplantBay(sys.ctx));
  /*
   * The shared ship's fixed dining table (the kitchen, A-3c, 2026-09-11). The personal ship's table is **furniture** in
   * the kitchen, but the shared ship has no furniture, so one spot planted by the interior stands in for it — per the
   * contract the `null` of `openDiningTable(null)` **is** that fixed table (no uid). A personal ship has no `diningTable`.
   */
  if (s.diningTable) sys.addStation('hub_dining_table', s.diningTable, '식탁 · 식사', () => openDiningTable(sys.ctx, null), 2.4);
  // 2026-09-16 (plate models, user's decision): every squadmate's plate sits on that table — a dish shape plus the cook's name tag per setting
  if (s.diningTable && s.diningPlates?.length) {
    sys.tablePlates?.dispose();
    sys.tablePlates = new TablePlates(sys.ctx, interior.root, s.diningPlates, s.diningTable.yaw);
  }
  }

/**
 * The implant bay: opens the Tab window (its implant slots). The shared ship's built-in one (`hub_implant_bay`) and the
 * personal ship's shared-facility furniture (`furn_implant_bay`, 2026-09-12) take the same road.
 */
function openImplantBay(ctx: GameContext): void {
  const inv = ctx.inventory;
  if (inv && !inv.isOpen) inv.toggleBag();
}

/**
 * The dining screen (the kitchen, A-3c, 2026-09-11): a furniture table opens with that piece's `uid`, **the shared ship's
 * fixed table with `null`** (`HousingRef.openDiningTable`'s contract). Duck-typed in case that folder is not there yet.
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
 * Decorating the ship (personal ship): the furniture layer and the housing-mode controller.
 *
 * Phase 8 UI pass: the room door consoles (`hub_room_<i>`) and the cockpit facility console (`hub_facility`) are
 * **gone**, along with their geometry — rooms, purposes and facilities are managed from the Tab `함선` tab and from
 * `시설 관리` (M). Only the furniture pieces themselves still answer to E.
 */
export function buildHousing(sys: HubSystem, interior: ShipInterior): void {
  const ctx = sys.ctx;
  if (!(interior instanceof PersonalShip)) { sys.housingMode.setShip(null, null); return; }
  /*
   * Visiting a personal ship (2026-09-08): a visited ship's furniture comes off that member's `ship state`, never from
   * `ctx.housing` (which is *our* ship). A sourced layer subscribes to nothing and registers no interactables, and
   * ship management is denied the interior, so nothing in here can be touched.
   */
  const source = sys.visitShip ? Hangar.furnitureSource(ctx, sys.visitShip) : null;
  // 2026-09-12: the cockpit is a furniture area too (`COCKPIT_ROOM_INDEX`) — rooms first, cockpit last
  const areas = [...interior.rooms, interior.cockpit];
  sys.furniture = new FurnitureLayer(ctx, areas, interior.collider, {
    canUse: () => sys.stationUsable(),
    onBench: (kind, level) => {
      const inv = ctx.inventory;
      if (inv && typeof inv.openBenchCraft === 'function') inv.openBenchCraft(kind, level);
      else ctx.bus.emit('ui:notify', { text: '작업대를 사용할 수 없습니다', kind: 'warning' });
    },
    /*
     * 2026-09-12 (user's decision — the simulation room was dropped): `onRangeConsole` (the locker → the preset menu)
     * and `onSimHub` (the simulation hub → the training arena) lived here. Both pieces are retired (`retired=1`), the
     * presets are gone, and the training arena opens from the **terminal**.
     */
    // Shared-facility furniture (2026-09-12): the two fixtures that were built into the cockpit — they open the same windows as then
    onImplantBay: () => openImplantBay(ctx),
    onCorpComputer: () => sys.openCorpMenu(),
    onGrowRack: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openGrowMenu === 'function') h.openGrowMenu(uid);
      else ctx.bus.emit('ui:notify', { text: '재배층을 사용할 수 없습니다', kind: 'warning' });
    },
    // The greenhouse rework (2026-09-11): the grow station — the old grow-rack road is left above, this opens one more door
    onGrowStation: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openGrowStation === 'function') h.openGrowStation(uid);
      else ctx.bus.emit('ui:notify', { text: '재배 스테이션을 사용할 수 없습니다', kind: 'warning' });
    },
    /*
     * The repair bench (Phase 8 → retired 2026-09-12): `furn_repair_bench` is `retired=1` in `data/furniture.csv`, so
     * `ShipState.sanitize` removes a placed one and refunds its materials — nothing can reach this branch. The value
     * stays because `FurnitureInteraction` is a contract, so the branch stays too (**doing nothing**, in `interiors/Furniture`).
     */
    onBookshelf: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openBookshelfMenu === 'function') h.openBookshelfMenu(uid);
      else ctx.bus.emit('ui:notify', { text: '책장을 사용할 수 없습니다', kind: 'warning' });
    },
    // The lab (A-12, 2026-09-11): the analyzer — load a sample · collect the resolved form · the analysis catalogue
    onAnalyzer: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openAnalyzer === 'function') h.openAnalyzer(uid);
      else ctx.bus.emit('ui:notify', { text: '분석기를 사용할 수 없습니다', kind: 'warning' });
    },
    // The greenhouse culture tank (A-14, 2026-09-11): pour the medium · insert a strain · harvest
    onCultureTank: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openCultureTank === 'function') h.openCultureTank(uid);
      else ctx.bus.emit('ui:notify', { text: '배양조를 사용할 수 없습니다', kind: 'warning' });
    },
    /*
     * The cook screen (2026-09-13, the cooking minigames): the cook bench (`workbench_cook`) passes that piece's uid, an
     * auto appliance (`cook_*`) the ship's cook-bench uid the layer found (null with none). It **never falls through to
     * the inventory craft window (`openBenchCraft`)** — cook recipes left that road to close the no-quality back door.
     */
    onCookStation: (uid) => {
      if (uid === null) { ctx.bus.emit('ui:notify', { text: '조리대가 없습니다', kind: 'warning' }); return; }
      const h = ctx.housing;
      if (h && typeof h.openCookStation === 'function') {
        try { h.openCookStation(uid); } catch (err) { console.warn('[hub] openCookStation failed', err); }
      } else ctx.bus.emit('ui:notify', { text: '조리대를 사용할 수 없습니다', kind: 'warning' });
    },
    /*
     * Crypto mining (2026-09-13 → merged 2026-09-14): the two pieces open **the same window** — the mining screen of four
     * top tabs (`채굴` · `클러스터 현황` · `지갑` · `거래소`), and **the default tab is the pressed piece's tab** (user's
     * decision): compute cluster → `채굴`, main computer → `클러스터 현황`. That contract lives in `housing`'s
     * `openComputeCluster` / `openMiningComputer`; here the two names are simply called (duck-typed — that folder may be absent).
     */
    onComputeCluster: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openComputeCluster === 'function') {
        try { h.openComputeCluster(uid); } catch (err) { console.warn('[hub] openComputeCluster failed', err); }
      } else ctx.bus.emit('ui:notify', { text: '연산 클러스터를 사용할 수 없습니다', kind: 'warning' });
    },
    onMiningComputer: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openMiningComputer === 'function') {
        try { h.openMiningComputer(uid); } catch (err) { console.warn('[hub] openMiningComputer failed', err); }
      } else ctx.bus.emit('ui:notify', { text: '메인 컴퓨터를 사용할 수 없습니다', kind: 'warning' });
    },
    // The kitchen table (A-3c, 2026-09-11): the personal ship's table is **furniture**, so it opens with that piece's uid
    // (the shared ship's fixed table is not furniture but `buildStations`' `hub_dining_table`, and opens with `null`)
    onDiningTable: (uid) => openDiningTable(ctx, uid),
    /* ── library media (A-3e) · the gym (A-3a), 2026-09-12 — all duck-typed (the folder built in parallel may be absent) ── */
    onShelf: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openShelf === 'function') h.openShelf(uid);
      else ctx.bus.emit('ui:notify', { text: '보관함을 사용할 수 없습니다', kind: 'warning' });
    },
    onSit: (_uid, pose) => {
      const p = ctx.player;
      let ok = false;
      if (p && typeof p.setFurniturePose === 'function') {
        try { ok = p.setFurniturePose(pose); } catch (err) { console.warn('[hub] setFurniturePose failed', err); }
      }
      if (ok) ctx.bus.emit('audio:play', { id: 'chair_creak', position: pose.anchor.clone() });
      else ctx.bus.emit('ui:notify', { text: '지금은 앉을 수 없습니다', kind: 'warning' });
      return ok;
    },
    onToggle: (uid) => {
      const h = ctx.housing;
      const next = h && typeof h.toggleFurniture === 'function' ? h.toggleFurniture(uid) : null;
      if (next === null) ctx.bus.emit('ui:notify', { text: '켜고 끌 수 없습니다', kind: 'warning' });
    },
    // 2026-09-13 video games: the TV screen (on/off · mounting a console · seat state · the game list) — duck-typed
    onTvMenu: (uid) => {
      const h = ctx.housing;
      if (h && typeof h.openTvMenu === 'function') {
        try { h.openTvMenu(uid); } catch (err) { console.warn('[hub] openTvMenu failed', err); }
      } else ctx.bus.emit('ui:notify', { text: 'TV 화면을 사용할 수 없습니다', kind: 'warning' });
    },
    onGym: (uid) => {
      const h = ctx.housing;
      if (!h || typeof h.startGymSession !== 'function') { ctx.bus.emit('ui:notify', { text: '운동 기구를 사용할 수 없습니다', kind: 'warning' }); return; }
      let reason: string | null = null;
      try { reason = h.startGymSession(uid); } catch (err) { console.warn('[hub] startGymSession failed', err); reason = '운동 기구를 사용할 수 없습니다'; }
      if (reason) ctx.bus.emit('ui:notify', { text: reason, kind: 'warning' });
    },
    /*
     * Remote furniture staging (2026-09-12, character buffs · furniture pose sync): a squadmate in the same ship turns
     * that piece through their `furniturePose`. A visited ship's layer (`source`) takes the same two callbacks — a visitor
     * watching the owner work out is what this was built for.
     */
    remotePlayers: () => sys.remoteFurnitureRefs(),
    hubSite: () => sys.hubSite,
  }, source);
  sys.housingMode.setShip(source ? null : interior, source ? null : sys.furniture);
  sys.refreshRoomSigns();
  }

/**
 * Hangar (2026-09-08): the way back out of a bay's ship. The airlock at the end of the corridor is the rear ramp we
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
  // During a visit that member's `ship state` says what each room's purpose is (our `ctx.housing` is our own ship)
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
 * Door sign + room light of one room (an empty room reads dark, an assigned one is lit and gets a pool light).
 *
 * 2026-09-11 (the lab): the sign accent is the purpose's **own** colour (`ROOM_PURPOSE_COLOR`, the same table the Tab
 * `함선` tab's room list and the `시설 관리` cards take their thumbnails from) instead of one amber for every assigned
 * room — so `온실` reads green, `연구실` purple and `작업실` amber from the corridor, as they already do in the UI.
 * CLAUDE.md "the same formula in two folders moves to `shared`": the table is in `shared`, nothing is copied here.
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
 * **not warping** — 2026-09-09: the window warp no longer runs a cutscene, so `travelling` has to be checked here itself).
 */
export function stationUsable(sys: HubSystem): boolean {
  // Nothing is usable during a visit (someone else's ship) — terminal · repair bench · corporate network · implant bay alike (2026-09-08)
  if (sys.visitReadOnly) return false;
  return sys.ctx.phase === 'hub' && !sys.menu.isOpen && !(sys.ctx.inventory?.isOpen ?? false)
    && !(sys.ctx.housing?.isMenuOpen ?? false) && !sys.corpMenuOpen() && sys.boardedSlot < 0 && !sys.cutscene && !sys.travelling
    && !sys.housingMode.active;
  }

export function disposeInterior(sys: HubSystem): void {
  // a ship prebuilt for a transition that never finished (a new transition, a re-entry, the mission) goes with it
  if (sys.pendingInterior) { sys.pendingInterior.interior.dispose(); sys.pendingInterior = null; }
  Hangar.clearBays(sys);
  Androids.clearAndroidBays(sys);   // 2026-09-15: the cockpit bay interactables and the standing spots go with the interior too
  sys.clearLeaderHandoff();   // 2026-09-09: the leader-handoff interactables go with the interior too
  sys.housingMode.setShip(null, null);
  sys.furniture?.dispose(); sys.furniture = null;
  for (const pod of sys.pods) pod.dispose();
  sys.pods = [];
  for (const id of sys.stationIds) sys.ctx.interactables.unregister(id);
  sys.stationIds.length = 0;
  sys.terminal?.dispose(); sys.terminal = null;
  sys.computer?.dispose(); sys.computer = null;
  sys.tablePlates?.dispose(); sys.tablePlates = null;   // 2026-09-16: the shared table's plates (before the interior — they hang off its root)
  sys.interior?.dispose(); sys.interior = null;
  sys.collider = null;
  sys.ship = null;
  sys.slots = [];
  }

/**
 * Leave the hub. 'mission': `game:newMission` arrived (World already generated, Player already respawned — only
 * release our hooks). 'menu': back to the title (`game:abort` or `타이틀로`) — also restores the planet atmosphere.
 */
export function teardown(sys: HubSystem, reason: 'mission' | 'menu'): void {
  if (!sys.interior && !sys.cutscene) return;
  const ctx = sys.ctx;
  // 2026-09-15 (squads · dock matchmaking): a countdown / fade never outlives the hub; the next ship build says where we stand again
  SquadDock.clearDockState(sys);
  sys.dockMine = null;
  sys.shipLobbyCode = null;
  // 2026-09-15: the raid-entry fade and a pending android request end with the ship too (the fade itself passes to game/LoadGate)
  Pods.clearRaidLaunch(sys);
  sys.androidPending = null;
  if (sys.boardedSlot >= 0) sys.leavePod(false, false);
  sys.menu.close(false);
  sys.status.hide();
  sys.ready.hide();
  sys.cutscene?.dispose(); sys.cutscene = null;
  sys.cancelTravel();
  sys.disposeInterior();
  sys.visit = null; sys.visitShip = null; sys.pendingBay = null;   // Hangar: a visit never survives leaving the hub
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
