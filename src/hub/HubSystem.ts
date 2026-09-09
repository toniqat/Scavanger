import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import { getPlanet, isPlanetId, planetLabel, HUB_TRAVEL_DURATION, PLANET_NONE_LABEL, PLANET_STORAGE_KEY } from '@/shared';
import type { CrewCardWire, GameContext, GameSystem, HubLaunchSlot, HubRef, HubShipBay, HubShipKind, Interactable, InteriorCollider, LoadoutSlot, LobbyState, PeerId, RoomPurpose, ShipVisitWire } from '@/shared';
import { CREW_CARD_MIN_INTERVAL_S, CREW_LOADOUT_COOLDOWN_S, HUB_DOCKING_DURATION, HUB_LAUNCH_COUNTDOWN, HUB_READY_BLOCKER, HUB_READY_CELLS, Keys, MENU_BLOCKER, NET_SLOT_COLORS, ROOM_PURPOSE_LABEL_KO } from '@/shared';
import { PersonalShip } from './interiors/PersonalShip';
import { SharedShip } from './interiors/SharedShip';
import type { StationDef } from './interiors/stations';
import type { ShipInterior } from './interiors/types';
import { FurnitureLayer } from './interiors/Furniture';
import { roomAtWorld } from './interiors/RoomLayout';
import { HousingMode } from './HousingMode';
import { LaunchPod } from './LaunchPod';
import { Terminal } from './Terminal';
import { Workbench } from './Workbench';
import { Computer } from './Computer';
import { DockingCutscene, type DockDirection } from './DockingCutscene';
import { HubMenu } from './ui/HubMenu';
import { WorkbenchMenu } from './ui/WorkbenchMenu';
import { LaunchWarnPanel } from './ui/LaunchWarnPanel';
import { HubStatus } from './ui/HubStatus';
import { ReadyPanel, type ReadyCellInfo } from './ui/ReadyPanel';
import { randomSeed } from './ui/dom';
import './hub.css';

import { type DockTransition, type WarpState, LOCK_REQUEST_GRACE_MS, READY_ECHO_GRACE, UNBOARD_GRACE, _camLook, _camPos, _front } from './model';
/** 폴더 공용 어휘(상수 · 타입 · 스크래치)는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 재수출한다. */
export * from './model';
import * as Planet from './parts/Planet';
import * as Pods from './parts/Pods';
import * as Interior from './parts/Interior';
import * as Trans from './parts/Transitions';
import * as Crew from './parts/Crew';
/* 공용 함선 격납고 (2026-09-08) */
import * as Hangar from './parts/Hangar';

export class HubSystem implements GameSystem, HubRef {
  readonly name = 'hub';
  ctx!: GameContext;
  private unsubs: Array<() => void> = [];

  /* HubRef */
  ship: HubShipKind | null = null;
  collider: InteriorCollider | null = null;
  missionSeed: number | null = null;
  get active(): boolean { return this.ctx?.phase === 'hub' || this.ctx?.phase === 'docking'; }
  /**
   * Next mission seed (null = random). Only the dev console's `/seed` calls this — the terminal has no seed field any
   * more. In a lobby the host also pushes it to the server (`setLobbySeed`); a non-host is refused (false).
   */
  setMissionSeed(seed: number | null): boolean {
    const net = this.ctx?.net;
    if (net?.lobby && !net.isHost) return false;
    this.missionSeed = seed === null ? null : seed >>> 0;
    if (net?.lobby && this.missionSeed !== null) net.setLobbySeed(this.missionSeed);
    this.updateTerminalScreen();
    return true;
  }
  /* ── 목표 행성 (Phase 11) ──────────────────────────────────────────────── */
  /**
   * 목표 행성 of the next raid. In a lobby this **mirrors `LobbyState.planet`** (the host owns it and every member
   * reads the same value off its own `lobby:state`); solo it is the local pick, remembered in localStorage
   * `PLANET_STORAGE_KEY`. Null = nothing picked yet — the launch slots refuse boarding until it is set.
   */
  get planet(): PlanetId | null {
    const net = this.ctx?.net;
    if (net?.lobby) return net.lobbyPlanet ?? null;
    return this.localPlanet;
  }
  /**
   * true while the ship is warping to a new planet (2026-09-09: the 창문 워프 — terminal closed, pods / bays / consoles
   * unavailable, but the **controls stay on** and the camera is the player's; nothing is locked).
   */
  travelling = false;
  /** 창문 워프 in flight (`parts/Planet.tickTravel`), null at rest. `travelling` is its public shadow. */
  warp: WarpState | null = null;
  /** The solo pick (persisted); in a lobby `LobbyState.planet` wins and this is only the fallback. */
  localPlanet: PlanetId | null = null;
  /** `lobby.planet` as of the last `net:lobbyUpdated` we reacted to — a change starts the squad's cutscene. */
  knownLobbyPlanet: PlanetId | null = null;

  /**
   * Pick the 목표 행성 and fly there. Refused (false) for a non-host in a lobby, for an unknown id, while a
   * cutscene / travel runs, while a launch countdown is ticking, outside the hub and when it is already the target.
   * On success: `hub:travel {stage:'start'}` → the 창문 워프 (`hub:warpProgress` every frame, controls on) →
   * `hub:travel {stage:'end'}` + `hub:planetChanged`. The ship interior is **not** rebuilt — only the view outside it changes.
   */
  setPlanet(planet: PlanetId): boolean { return Planet.setPlanet(this, planet); }

  /** Korean reason 행성 이동 is refused right now, or null when it is allowed (the terminal renders it). */
  travelBlockReason(planet?: PlanetId): string | null { return Planet.travelBlockReason(this, planet); }

  /** Restore the solo pick (`PLANET_STORAGE_KEY`); an unknown / absent value stays null (목표 미지정). */
  private loadPlanet(): void { return Planet.loadPlanet(this); }

  savePlanet(): void { return Planet.savePlanet(this); }

  /**
   * Fly to `planet` — the 창문 워프 (2026-09-09). Everyone steps out of their pod, the terminal / workbench close and
   * `warp` is armed for `HUB_TRAVEL_DURATION`; `tickTravel` drives the interior's `setWarp`, `hub:warpProgress` and the
   * hull shake every frame. No cutscene, no camera override, no control lock. The interior is **kept** (no
   * `disposeInterior`, no rebuild, the phase stays `'hub'`) — a planet change is a change of scenery, not a new ship.
   */
  startTravel(planet: PlanetId, by: 'local' | 'squad'): void { return Planet.startTravel(this, planet, by); }

  finishTravel(planet: PlanetId, by: 'local' | 'squad'): void { return Planet.finishTravel(this, planet, by); }

  /** One frame of the 창문 워프 (no-op at rest). Runs **after** the pod / status tick so its status line wins. */
  tickTravel(dt: number): void { return Planet.tickTravel(this, dt); }

  /** Drop a warp in flight without landing it (interior teardown / swap). No `hub:travel {end}` — see `parts/Planet`. */
  cancelTravel(): void { return Planet.cancelTravel(this); }

  /** The decorative planet outside the viewports takes the 목표 행성's colours (nothing else is rebuilt). */
  applyPlanetLook(): void { return Planet.applyPlanetLook(this); }
  /** Personal-ship room the player stands in (XZ inside the room's 4 × 4 m floor), else null. */
  get currentRoom(): number | null { return this._currentRoom; }
  _currentRoom: number | null = null;
  getLaunchSlots(): readonly HubLaunchSlot[] { return Pods.getLaunchSlots(this); }
  /** Debug: true while the workbench (repair) menu is open. */
  get isWorkbenchOpen(): boolean { return !!this.wbMenu?.isOpen; }
  /** Debug: housing-mode controller (camera / cursor / ghost). */
  get housing(): HousingMode { return this.housingMode; }
  /** Debug: furniture renderer of the current personal ship. */
  get furnitureLayer(): FurnitureLayer | null { return this.furniture; }

  /* ── 시뮬레이션 훈련장 (Phase 7) ─────────────────────────────────────────── */
  /** A training is running in our lobby (`lobby.started` with mode `'training'`). */
  trainingRunning(): boolean { return Crew.trainingRunning(this); }
  /** A raid is running in our lobby (pods rejoin it; the training hub is locked). */
  raidRunning(): boolean { return Crew.raidRunning(this); }
  /** Connected members currently inside the training. */
  trainingCount(): number { return Crew.trainingCount(this); }

  /**
   * Enter the 시뮬레이션 훈련장 — from the 사격장 `furn_sim_hub` (personal ship) or the shared-ship terminal.
   * No countdown, no ready gating, individual entry: in a lobby any member calls `ctx.net.startGame(seed, 'training')`
   * (the server marks only the caller `inMission`), a training already running is joined with `rejoinMission()`, and a
   * running raid refuses. Solo: `ctx.missionMode = 'training'` is set **before** `game:newMission {seed, mode}` so
   * every `game:newMission` handler (world included) already sees the mode. Returns true when a request went out.
   */
  startTraining(): boolean { return Crew.startTraining(this); }

  interior: ShipInterior | null = null;
  pods: LaunchPod[] = [];
  terminal: Terminal | null = null;
  workbench: Workbench | null = null;
  /** 함선 컴퓨터 (Phase 5): `hub_computer` → `ctx.meta.openCorpMenu()`. */
  computer: Computer | null = null;
  stationIds: string[] = [];
  /** 함선 꾸미기: furniture meshes / colliders / interactables of the personal ship + the housing-mode controller. */
  furniture: FurnitureLayer | null = null;
  housingMode!: HousingMode;
  slots: HubLaunchSlot[] = [];
  cutscene: DockingCutscene | null = null;
  menu!: HubMenu;
  wbMenu!: WorkbenchMenu;
  /** 출격 준비 경고 (2026-09-08): raised by `boardPod` when the launch check has something to say. */
  launchWarn!: LaunchWarnPanel;
  /** Warning signature the player already waved through — the same set never asks twice. Cleared on a real change. */
  launchWarnAck = '';
  status!: HubStatus;
  /** 발사 준비 패널 (Phase 10): 4 portrait cells + the 분대원 장비 popup. */
  ready!: ReadyPanel;

  /* ── crew cards (Phase 10; hub sends, net/ receives) ───────────────────── */
  /** `ctx.time` of the last `crew card` broadcast (debounced by `CREW_CARD_MIN_INTERVAL_S`). */
  lastCardAt = -Infinity;
  /** A change arrived inside the debounce window — send once it expires. */
  cardDirty = false;
  /** `ctx.time` we last answered each peer's `crewq loadout` (`CREW_LOADOUT_COOLDOWN_S`). */
  readonly loadoutAnsweredAt = new Map<PeerId, number>();
  crewUnsub: (() => void) | null = null;

  /* ── 공용 함선 격납고 (2026-09-08; hub sends `ship state`, net/ receives) ── */
  /**
   * The 개인 함선 we walked into from a hangar bay, or null on the shared deck / in the ordinary solo personal ship.
   * `peerId` null = **our own** ship (full functionality); a peer's id = a visit (`readOnly`).
   */
  visit: { peerId: PeerId | null; slot: number; readOnly: boolean } | null = null;
  /** Layout the visited ship was built from (a peer's `ship state`); null in our own ship. */
  visitShip: ShipVisitWire | null = null;
  /** A bay we boarded before that member's layout had arrived — `Hangar.tickPendingVisit` finishes or gives up. */
  pendingBay: { slot: number; peerId: PeerId; until: number } | null = null;
  /** Interactable ids of the four bays (shared ship only). */
  bayIds: string[] = [];
  /** `ctx.time` of the last `ship state` broadcast (debounced by `SHIP_VISIT_MIN_INTERVAL_S`). */
  lastShipStateAt = -Infinity;
  /** A ship change arrived inside the debounce window — send once it expires. */
  shipStateDirty = false;
  /** `ctx.time` we last answered each peer's `shipq state` (`SHIP_VISIT_COOLDOWN_S`). */
  readonly shipAnsweredAt = new Map<PeerId, number>();
  shipUnsub: (() => void) | null = null;

  /**
   * Which ship interior we stand in, as a PeerId — null on the shared deck (공유 함선 + 격납고), our own id in our
   * own ship, the owner's in a visited one. `net/Snapshotter` puts it on the wire as `PlayerSnapshot.hs` and remote
   * avatars whose value differs are hidden, so a tour of somebody's ship is private to the people inside it.
   */
  get hubSite(): PeerId | null {
    const v = this.visit;
    if (!v) return null;
    return v.peerId ?? (this.ctx.net?.localId ?? 'local');
  }
  /** PeerId of the ship being **visited** (someone else's), or null in our own ship / on the shared deck. */
  get visitingPeer(): PeerId | null { return this.visit?.peerId ?? null; }
  /** Inside someone else's ship: every console, bench, furniture piece and 시설 관리 is refused (둘러보기 전용). */
  get visitReadOnly(): boolean { return this.visit?.readOnly === true; }
  /** The hangar's four 개인 함선 bays with their occupants (empty outside the shared ship). */
  getShipBays(): readonly HubShipBay[] { return Hangar.getShipBays(this); }
  /** Board the 개인 함선 parked in `slot` (ours or a squadmate's). See `parts/Hangar.enterShipBay`. */
  enterShipBay(slot: number): boolean { return Hangar.enterShipBay(this, slot); }
  /** Walk back out of a bay's ship into the hangar. */
  returnToHangar(): boolean { return Hangar.returnToHangar(this); }
  /** Swap the interior to `peerId`'s personal ship (null = ours), remembering the bay we came from. */
  boardShip(peerId: PeerId | null, slot: number): void { return Trans.boardShip(this, peerId, slot); }
  /** Swap back to the shared ship and put the player in front of the bay. */
  leaveShip(): void { return Trans.leaveShip(this); }
  /** Answer `shipq state`; also called on `hub:entered` when `ctx.net` was missing at init. */
  bindShipRequests(): void { return Hangar.bindShipRequests(this); }

  /* ── 분대장 넘기기 (2026-09-09) ─────────────────────────────────────────── */
  /**
   * 공용 함선 안의 원격 분대원마다 `lead:<peerId>` `Interactable` 을 세운다 (내가 호스트일 때만).
   * 아바타 자체는 `player/RemotePlayerSystem` 소유라 위치만 읽는다 — 자세히는 `parts/Crew`.
   */
  readonly leaderHandoffs = new Map<PeerId, { it: Interactable; pos: THREE.Vector3 }>();
  updateLeaderHandoff(): void { return Crew.updateLeaderHandoff(this); }
  clearLeaderHandoff(): void { return Crew.clearLeaderHandoff(this); }

  boardedSlot = -1;
  boardedAt = 0;
  /** `ctx.time` of the last un-board — the pod refuses a new boarding for `REBOARD_GRACE` after it. */
  leftPodAt = -Infinity;
  readySentAt = -Infinity;
  countdown = -1;
  lastCountdownSecond = -1;
  launched = false;

  /**
   * A lost pointer lock only leaves the *room-console* housing mode (browser Esc while decorating). Since Phase 8
   * the hub **pauses** like a mission — `game/` owns that — so the terminal menu is never forced open here any more,
   * and 함선 관리 runs **deliberately unlocked** (clickable 방 목록 / 가구 카드 바), so it ignores lock changes.
   */
  private onPointerLockChange = (): void => {
    const ctx = this.ctx;
    if (this.housingMode.manage) return;                    // 함선 관리 owns the cursor
    // any blocker (inventory / housing panels; the 기업 screen is the inventory window's own blocker since
    // 2026-09-07) owns the lock loss — except the READY panel's token, which never released the lock (Phase 10)
    if (ctx.input.isPointerLocked || ctx.phase !== 'hub' || this.uiBlocked() || this.corpMenuOpen()) return;
    if (performance.now() - ctx.input.lastLockRequest < LOCK_REQUEST_GRACE_MS) return;
    if (this.housingMode.active) { this.housingMode.exit(); this.relock(); }
  };

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.hub = this;
    this.loadPlanet();
    this.menu = new HubMenu(ctx, {
      onClosed: () => this.relock(),
      startTraining: () => this.startTraining(),
      planet: () => this.planet,
      travelBlock: (planet) => this.travelBlockReason(planet),
      travelTo: (p) => { this.setPlanet(p); },
    });
    this.wbMenu = new WorkbenchMenu(ctx, { onClosed: () => this.relock() });
    this.launchWarn = new LaunchWarnPanel(ctx, { onClosed: () => this.relock() });
    // ReadyPanel **before** HubStatus: `hub.css` lifts the status line off the panel with a sibling selector.
    this.ready = new ReadyPanel(ctx);
    this.status = new HubStatus(ctx);
    this.housingMode = new HousingMode(ctx);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('hub:enter', ({ ship }) => this.enter(ship)),
      // crew cards: the shared ship announces us once and asks everyone else for theirs (Phase 10)
      b.on('hub:entered', ({ ship }) => { if (ship === 'shared') { this.announceCrew(); Hangar.announceShip(this); } }),
      // 격납고 (2026-09-08): our own ship layout is what a squadmate's bay renders — re-publish it when it changes
      b.on('housing:changed', () => Hangar.shipStateChanged(this)),
      b.on('housing:loaded', () => Hangar.shipStateChanged(this)),
      b.on('housing:booksChanged', () => Hangar.shipStateChanged(this)),
      b.on('progress:levelUp', () => this.crewCardChanged()),
      b.on('implant:equipped', () => this.crewCardChanged()),
      b.on('equip:changed', () => this.crewCardChanged()),
      b.on('loadout:changed', () => this.crewCardChanged()),
      b.on('inventory:loadoutSaved', () => this.crewCardChanged()),
      // a peer's card arrived (net/ stores it) → repaint that READY cell
      b.on('net:crewCard', () => { if (this.interior && this.active) this.syncPods(); }),
      b.on('housing:roomPurposeChanged', ({ room }) => this.refreshRoomSign(room)),
      b.on('housing:changed', () => this.refreshRoomSigns()),
      b.on('housing:loaded', () => this.refreshRoomSigns()),
      b.on('game:newMission', () => this.teardown('mission')),
      b.on('game:abort', () => { if (this.interior || this.cutscene) this.teardown('menu'); }),
      b.on('net:lobbyUpdated', ({ lobby }) => this.onLobbyUpdated(lobby)),
      b.on('net:lobbyLeft', () => this.onLobbyLeft()),
      b.on('net:resumed', ({ inProgress }) => this.onResumed(inProgress)),
      b.on('net:peerJoined', ({ name }) => { if (this.active) b.emit('ui:notify', { text: `${name} 함선 합류`, kind: 'info' }); }),
      b.on('net:peerLeft', ({ name }) => { if (this.active) b.emit('ui:notify', { text: `${name} 함선 이탈`, kind: 'warning' }); }),
      b.on('net:statusChanged', () => { this.resendReady(); this.updateTerminalScreen(); }),
      b.on('meta:creditsChanged', () => this.updateTerminalScreen()),
      b.on('meta:loaded', () => this.updateTerminalScreen()),
    );
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.bindCrewRequests();
    this.bindShipRequests();
  }

  dispose(): void {
    this.teardown('menu');
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.crewUnsub?.(); this.crewUnsub = null;
    this.shipUnsub?.(); this.shipUnsub = null;
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.menu.dispose();
    this.wbMenu.dispose();
    this.launchWarn.dispose();
    this.status.dispose();
    this.ready.dispose();
    this.housingMode.dispose();
    if (this.ctx?.hub === this) this.ctx.hub = null;
  }

  /* ── crew cards (Phase 10) ─────────────────────────────────────────────── */
  /**
   * Answer the two `crewq` requests. Receiving / storing cards is `net/`'s job (`getCrewCard`, `net:crewCard`,
   * `net:crewLoadout`); the hub only **sends**. Registered once — `ctx.net` exists by our `init` (NetSystem is
   * registered first) but the ref is optional in the contract, so a missing one is retried on `hub:entered`.
   */
  bindCrewRequests(): void { return Crew.bindCrewRequests(this); }

  /** Our own card: level / ship implant / armor + the three weapon slots (no attachments). */
  crewCard(): CrewCardWire { return Crew.crewCard(this); }

  /**
   * A level / implant / equipment change: repaint our own READY cell, then broadcast (debounced). Only while the hub
   * is up — mid-raid loadout churn is nobody's business, and a `crewq sync` re-reads the card on demand anyway.
   */
  private crewCardChanged(): void { return Crew.crewCardChanged(this); }

  /** `to` omitted = broadcast to `others`; `force` skips the debounce (a direct `crewq sync` answer / arrival). */
  sendCrewCard(force: boolean, to?: PeerId): void { return Crew.sendCrewCard(this, force, to); }

  /** `crewq loadout` answer: our card + `ctx.inventory.captureCrewLoadout()`, rate-limited per requester. */
  sendCrewLoadout(to: PeerId): void { return Crew.sendCrewLoadout(this, to); }

  /** Arriving in the shared ship: publish our card and ask the squad for theirs. */
  private announceCrew(): void { return Crew.announceCrew(this); }

  /**
   * UI blockers that own the input, **ignoring the READY panel's own token**. The panel keeps the pointer lock and
   * only draws a software cursor, so it must not stop the pod's Esc / E un-board or the lock-loss handler — exactly
   * the shape of `HousingMode.blockedByPanel()`.
   */
  /* `private` is stripped because `parts/Crew` reads it (folder convention: parts get at what they touch). */
  uiBlocked(): boolean {
    const b = this.ctx.uiBlockers;
    if (b.size === 0) return false;
    return !(b.size === 1 && b.has(HUB_READY_BLOCKER));
  }

  /* ── enter / build / teardown ──────────────────────────────────────────── */
  private enter(requested: HubShipKind): void { return Trans.enter(this, requested); }

  /** Personal ship: connect in the background; a lobby on `welcome` (resume) moves us straight to the shared ship. */
  tryResume(): void { return Trans.tryResume(this); }

  build(ship: HubShipKind, viaAirlock: boolean, fromBay?: number): THREE.Vector3 { return Interior.build(this, ship, viaAirlock, fromBay); }

  /**
   * 함선 시설: the implant bay, which opens the Tab ship screen (inventory window: 창고 / 장비 + 임플란트 슬롯 /
   * 가방). Its geometry is already merged into the interior. (Phase 8 removed the hydroponics station — 재배 is
   * the 온실 room's `furn_grow_rack` furniture now.)
   */
  buildStations(interior: ShipInterior): void { return Interior.buildStations(this, interior); }

  addStation(id: string, def: StationDef, prompt: string | (() => string), onUse: () => void, radius = 2.3): void { return Interior.addStation(this, id, def, prompt, onUse, radius); }

  /**
   * 함선 꾸미기 (personal ship): the furniture layer and the housing-mode controller.
   *
   * Phase 8 UI pass: the room door consoles (`hub_room_<i>`) and the cockpit facility console (`hub_facility`) are
   * **gone**, along with their geometry — rooms, purposes and facilities are managed from the Tab 함선 tab and from
   * 시설 관리 (M). Only the furniture pieces themselves still answer to E.
   */
  buildHousing(interior: ShipInterior): void { return Interior.buildHousing(this, interior); }

  roomPurpose(i: number): RoomPurpose | null { return Interior.roomPurpose(this, i); }
  roomPurposeLabel(i: number): string { return Interior.roomPurposeLabel(this, i); }
  /** Door sign + 방 조명 of one room (an empty room reads dark, an assigned one is lit and gets a pool light). */
  refreshRoomSign(i: number): void { return Interior.refreshRoomSign(this, i); }
  refreshRoomSigns(): void { return Interior.refreshRoomSigns(this); }

  /** Track the personal-ship room under the player; emits `hub:roomEntered` on change (null = corridor / cockpit). */
  private trackRoom(): void { return Interior.trackRoom(this); }

  /**
   * 함선 컴퓨터: open the corporation screen. **2026-09-07**: it has no overlay of its own any more — `openCorpMenu`
   * opens the Tab window on its 기업 tab (`InventoryRef.openScreen('corp')`), so the blocker and the in-game cursor
   * are the inventory window's. While `ctx.meta` is missing, a stub, or refuses, the player gets a warning toast.
   */
  openCorpMenu(): void {
    const meta = this.ctx.meta;
    if (meta && typeof meta.openCorpMenu === 'function') {
      try { meta.openCorpMenu(); } catch (e) { console.warn('[hub] openCorpMenu failed', e); }
      if (this.corpMenuOpen()) return;
    }
    this.ctx.bus.emit('ui:notify', { text: '기업 네트워크에 접속할 수 없습니다', kind: 'warning' });
  }

  /** True while the corporation screen (`ctx.meta`) is open. */
  corpMenuOpen(): boolean {
    try { return this.ctx.meta?.isMenuOpen === true; } catch { return false; }
  }

  /** Terminal / station consoles are usable while walking the ship (not boarded, no menu, not docking, not decorating). */
  stationUsable(): boolean { return Interior.stationUsable(this); }

  disposeInterior(): void { return Interior.disposeInterior(this); }

  /**
   * Leave the hub. 'mission': `game:newMission` arrived (World already generated, Player already respawned — only
   * release our hooks). 'menu': back to the title (`game:abort` or 타이틀로) — also restores the planet atmosphere.
   */
  teardown(reason: 'mission' | 'menu'): void { return Interior.teardown(this, reason); }

  setSpaceMode(on: boolean): void { return Trans.setSpaceMode(this, on); }

  relock(): void { return Trans.relock(this); }

  /* ── docking transitions ───────────────────────────────────────────────── */
  startTransition(direction: DockTransition): void { return Trans.startTransition(this, direction); }

  finishTransition(direction: DockTransition): void { return Trans.finishTransition(this, direction); }

  /** Swap interiors without a cutscene (resume after reload / seamless cases). */
  swapDirect(target: HubShipKind): void { return Trans.swapDirect(this, target); }

  /* ── net events ────────────────────────────────────────────────────────── */
  private onLobbyUpdated(lobby: LobbyState): void { return Trans.onLobbyUpdated(this, lobby); }

  private onLobbyLeft(): void { return Trans.onLobbyLeft(this); }

  /**
   * `net:resumed`. A **훈련장** is not the squad's mission (individual entry, the lobby stays open), so a reconnect
   * while one runs must never read as `분대가 임무 중` — it points at the terminal instead.
   */
  private onResumed(inProgress: boolean): void { return Trans.onResumed(this, inProgress); }

  /* ── pods ──────────────────────────────────────────────────────────────── */
  localSlot(): number { return Pods.localSlot(this); }

  podPrompt(slot: number): string | null { return Pods.podPrompt(this, slot); }

  /**
   * Basic pod availability: the pod is reachable and free. The **reasons boarding is refused anyway** live in
   * `podBlockReason` — they keep `canInteract` true on purpose, because `ctx.interactables.findBest` skips an
   * interactable that answers false and the player would then see no prompt at all (and no reason).
   */
  podCanInteract(slot: number): boolean { return Pods.podCanInteract(this, slot); }

  /**
   * Why boarding is refused right now (also the pod's prompt text), or null when the slot takes us:
   * a training runs in the lobby (join from the terminal instead), or the ship has no 목표 행성 (Phase 11).
   */
  podBlockReason(slot: number): string | null { return Pods.podBlockReason(this, slot); }

  boardPod(slot: number): void { return Pods.boardPod(this, slot); }

  /** Un-board. `sendReady` false when the lobby state already changed (reset / mission start / leaving the ship). */
  leavePod(sendReady: boolean, placeOutside = true): void { return Pods.leavePod(this, sendReady, placeOutside); }

  /** Mirror lobby ready flags into pod occupancy / tags; emits `hub:slotChanged` on changes. */
  syncPods(): void { return Pods.syncPods(this); }

  /**
   * The socket came back while we sit in a pod: re-send the ready flag (2026-09-09).
   *
   * `NetClient.send` silently drops anything posted while the socket is not OPEN, so the `setReady(true)` from
   * `boardPod` is lost across a reconnect and the squad would wait for a member the server never marked ready.
   * `readySentAt` is pushed forward with it so `syncPods` gives the fresh echo its full `READY_ECHO_GRACE`.
   */
  resendReady(): void {
    const net = this.ctx.net;
    if (this.boardedSlot < 0 || !net?.lobby || !net.connected) return;
    net.setReady(true);
    this.readySentAt = this.ctx.time;
  }

  /** Level / ship implant / armor of a READY cell: local reads the refs, a peer reads its `crew card`. */
  crewLook(local: boolean, peerId: PeerId | null): Pick<ReadyCellInfo, 'level' | 'implant' | 'armorId'> { return Interior.crewLook(this, local, peerId); }

  updateTerminalScreen(): void {
    if (!this.terminal) return;
    const net = this.ctx.net;
    const lobby = net?.lobby ?? null;
    const seed = lobby ? lobby.seed : this.missionSeed;
    const seedText = seed === null ? '시드 무작위' : `시드 ${seed}`;
    const status = net?.status === 'connected' ? '네트워크 연결됨' : net?.status === 'connecting' ? '연결 중…' : '오프라인';
    const planetLine = `목표 ${this.travelling ? `${planetLabel(this.planet)} 이동 중` : (getPlanet(this.planet)?.name ?? PLANET_NONE_LABEL)}`;
    const lines = lobby
      ? [`함선 ${lobby.code}`, `승무원 ${lobby.players.length}/4 · ${lobby.isPublic ? '공개' : '비공개'}`, planetLine, seedText]
      : ['개인 함선', status, planetLine, seedText];
    if (lobby && this.trainingRunning()) lines.push(`훈련장 ${this.trainingCount()}명`);
    const credits = this.credits();
    if (credits !== null) lines.push(`크레딧 ${credits.toLocaleString('ko-KR')}`);
    this.terminal.setScreen(lines, '#5fd7ff');
  }

  /** `ctx.meta.credits` (Phase 5), null while meta is missing. */
  private credits(): number | null {
    const c = this.ctx.meta?.credits;
    return typeof c === 'number' && Number.isFinite(c) ? Math.max(0, Math.round(c)) : null;
  }

  /* ── launch countdown ──────────────────────────────────────────────────── */
  resolveSeed(): number { return Pods.resolveSeed(this); }

  launch(): void { return Pods.launch(this); }

  private tickCountdown(dt: number): void { return Pods.tickCountdown(this, dt); }

  /* ── frame ─────────────────────────────────────────────────────────────── */
  update(dt: number, ctx: GameContext): void {
    this.menu.update(dt);
    this.wbMenu.update();
    this.ready.update(dt, ctx.time);
    // a card change inside the debounce window goes out as soon as it expires
    if (this.cardDirty) this.sendCrewCard(false);
    // 격납고 (2026-09-08): the same trailing flush for our ship layout
    if (this.shipStateDirty) Hangar.sendShipState(this, false);
    if (this.cutscene) {
      this.cutscene.update(dt);
      if (this.cutscene) this.status.set(this.cutscene.direction === 'dock' ? '도킹 절차 진행 중' : '도킹 해제 중', null);
      return;
    }
    if (ctx.phase !== 'hub' || !this.interior) return;
    // (2026-09-09) a 창문 워프 does **not** return early here: the interior keeps animating (자동문 · 방 조명 · star
    // drift — and now the streaks), the player keeps walking, and `tickTravel` runs at the tail of this frame.

    this.interior.update(dt, ctx.time);
    // 자동문 + 방 조명 follow the player — both interiors have sliding doors since the 격납고 (2026-09-08)
    if (this.interior.updateNear) {
      const pp = ctx.player?.position;
      this.interior.updateNear(dt, pp?.x ?? 0, pp?.z ?? 0);
    }
    this.furniture?.update(ctx.time);
    for (const pod of this.pods) pod.update(dt, ctx.time);
    this.trackRoom();
    // 격납고: a bay boarded before its layout arrived finishes (or gives up) here
    Hangar.tickPendingVisit(this);
    // 분대장 넘기기 (2026-09-09): 같은 함선 안의 원격 분대원마다 상호작용 지점을 따라 붙인다 (호스트만)
    this.updateLeaderHandoff();

    // housing mode owns the input (cursor / place / rotate / recover / C / M) while active
    if (this.housingMode.active) { this.housingMode.update(dt); this.tickCountdown(dt); this.tickTravel(dt); return; }

    /*
     * 2026-09-08 (ESC = 항상 일시정지): the hub does not read Escape any more. Every screen here closes on the key
     * that opened it — the 터미널 and the 정비 벤치 on **E** (both hang off an `Interactable`), the 분대원 장비
     * popup on another right-click or its 닫기 button — and Escape falls straight through to game/.
     *
     * 2026-09-09 (ESC 닫기): 그 Escape 가 이제 **화면을 닫는다**. 여기서 키를 읽는 대신 각 화면이 열릴 때
     * `ctx.escape` 에 자기 닫기를 올리고(`ui/HubMenu` · `ui/WorkbenchMenu` · `ui/LaunchWarnPanel` ·
     * `ui/CrewLoadoutPanel` — `'hub'` 토큰을 나눠 쓰므로 key 는 각자), `game/escapeKey` 가 맨 위 하나만 닫는다.
     *
     * `HubSystem` updates **before** `PlayerSystem`, so the E that opens one of these panels is polled here while the
     * panel is still closed: one tap can never open and close it in the same frame. Typing in the terminal's fields
     * never reaches `Input` at all (`hub/ui/dom.isolateInput` stops the event at the field).
     */
    if (ctx.input.wasPressed(Keys.INTERACT) && !ctx.uiBlockers.has(MENU_BLOCKER)) {
      // 출격 준비 경고 (2026-09-08): opened by the pod itself, not by a key — E is its keyboard 취소.
      if (this.launchWarn.isOpen) { this.launchWarn.close(); ctx.input.consume(Keys.INTERACT); }
      else if (this.wbMenu.isOpen) { this.wbMenu.close(); ctx.input.consume(Keys.INTERACT); }
      else if (this.menu.isOpen) { this.menu.close(); ctx.input.consume(Keys.INTERACT); }
      // 분대원 장비 popup before the pod: it is modeless over the pod view and holds no blocker of its own, so
      // without this step the same E would un-board out from under it (Phase 10 ordering, on the new key).
      else if (this.ready.closePopup()) { ctx.input.consume(Keys.INTERACT); }
      else if (this.boardedSlot >= 0 && !this.uiBlocked() && ctx.time - this.boardedAt > UNBOARD_GRACE) {
        this.leavePod(true);
      }
    }
    // M: 함선 관리 (housing's manage mode; the HUD draws the room list / furniture bar). Read `Keys.MAP` live.
    if (ctx.uiBlockers.size === 0 && this.boardedSlot < 0 && ctx.input.wasPressed(Keys.MAP)) this.openShipManage();

    this.tickCountdown(dt);
    this.tickTravel(dt);
  }

  /**
   * 함선 관리 (M in the ship): housing enters its manage mode from anywhere in the personal ship (no "stand in the
   * room" gate) and `HousingMode` takes the camera on `housing:shipManageChanged`. Refused in the shared ship.
   */
  openShipManage(): boolean {
    const ctx = this.ctx;
    if (ctx.phase !== 'hub' || this.cutscene || this.housingMode.active) return false;
    // 격납고 (2026-09-08): a visited ship is 둘러보기 전용 — 시설 관리 belongs to its owner alone
    if (this.visitReadOnly) {
      ctx.bus.emit('ui:notify', { text: '방문 중에는 함선을 관리할 수 없습니다', kind: 'warning' });
      return false;
    }
    if (!(this.interior instanceof PersonalShip)) {
      ctx.bus.emit('ui:notify', { text: '개인 함선에서만 관리할 수 있습니다', kind: 'warning' });
      return false;
    }
    const h = ctx.housing;
    if (!h || typeof h.openShipManage !== 'function') {
      ctx.bus.emit('ui:notify', { text: '함선 관리를 사용할 수 없습니다', kind: 'warning' });
      return false;
    }
    try { return h.openShipManage(this._currentRoom ?? undefined); } catch { return false; }
  }
}
