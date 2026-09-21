import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import { getPlanet, planetLabel, PLANET_NONE_LABEL } from '@/shared';
import type { CrewCardWire, GameContext, GameSystem, HubAndroidBay, HubLaunchSlot, HubRef, HubShipBay, HubShipKind, Interactable, InteriorCollider, LobbyState, PeerId, RemotePlayerRef, RoomPurpose, ShipVisitWire } from '@/shared';
import { HUB_READY_BLOCKER, Keys, MENU_BLOCKER } from '@/shared';
import { PersonalShip } from './interiors/PersonalShip';
import type { StationDef } from './interiors/stations';
import type { ShipInterior } from './interiors/types';
import { FurnitureLayer } from './interiors/Furniture';
import type { TablePlates } from './interiors/TablePlates';
import { HousingMode } from './HousingMode';
import { LaunchPod } from './LaunchPod';
import { Terminal } from './Terminal';
import { Computer } from './Computer';
import { DockingCutscene } from './DockingCutscene';
import { HubMenu } from './ui/HubMenu';
import { LaunchWarnPanel } from './ui/LaunchWarnPanel';
import { HubStatus } from './ui/HubStatus';
import { ReadyPanel, type ReadyCellInfo } from './ui/ReadyPanel';
import './hub.css';
/* 2026-09-14 the intel broker: match popup (`.hm-`) · intel panel (`.hi-`) · intel screen (`.his-`), wired beside `hub.css`. */
import './intel.css';

import { type AndroidPending, type DockTransition, type RaidLaunchState, type SquadDockState, type WarpState, LOCK_REQUEST_GRACE_MS, UNBOARD_GRACE, _camLook, _camPos, _front } from './model';
/* 2026-09-15: squads · dock matchmaking — undocked squads · the leader's dock countdown · the fade */
import { isDockedLobby } from '@/shared';
/* 2026-09-15: android bot members do not count towards the crew */
import { humanPlayersOf } from '@/shared';
import * as SquadDock from './parts/SquadDock';
import { SquadDockCountdown } from './ui/SquadDockCountdown';
/** The folder vocabulary (constants · types · scratch objects) lives in `model.ts` — re-exported for the old import paths. */
export * from './model';
import * as Planet from './parts/Planet';
import * as Pods from './parts/Pods';
import * as Interior from './parts/Interior';
import * as Trans from './parts/Transitions';
import * as Crew from './parts/Crew';
/* The shared ship's hangar (2026-09-08) */
import * as Hangar from './parts/Hangar';
/* 2026-09-15: the cockpit android bays · the standing spots in front of the launch pods */
import * as Androids from './parts/Androids';

const NO_REMOTES: readonly RemotePlayerRef[] = [];

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
  /* ── target planet (Phase 11) ─────────────────────────────────────────── */
  /**
   * Target planet of the next raid. In a lobby this **mirrors `LobbyState.planet`** (the host owns it and every member
   * reads the same value off its own `lobby:state`); solo it is the local pick, remembered in localStorage
   * `PLANET_STORAGE_KEY`. Null = nothing picked yet — the launch slots refuse boarding until it is set.
   */
  get planet(): PlanetId | null {
    const net = this.ctx?.net;
    // 2026-09-15: the lobby's planet belongs to its shared ship — an undocked squad member keeps flying their own ship
    if (net && this.squadLobby()) return net.lobbyPlanet ?? null;
    return this.localPlanet;
  }

  /* ── squad docking (2026-09-15, `parts/SquadDock`) ───────────────────────── */
  /**
   * Code of the lobby whose shared ship we stand in (set when the shared ship is built; a bay's personal ship keeps it),
   * null in the ordinary personal ship. `squadLobby()` compares it with `ctx.net.lobby` — the one test for "in the squad's ship".
   */
  shipLobbyCode: string | null = null;
  /** Countdown to the leader's dock (right-side panel), null when none. */
  squadDock: SquadDockState | null = null;
  /** Fade-out before the docking cutscene, null when none. */
  dockFade: SquadDockState | null = null;
  /** Code of a docked lobby that arrived as **my own** dock (`NetRef.dockPending` inside its `net:lobbyUpdated`). */
  dockMine: string | null = null;
  dockCountdown!: SquadDockCountdown;
  /** The lobby whose shared ship we stand in, or null (personal ship · undocked squad · docked but not arrived). */
  squadLobby(): LobbyState | null { return SquadDock.squadLobby(this); }
  /**
   * Smoke / debug only (2026-09-15): stand in the shared ship of a **made-up docked lobby**, with no relay at all —
   * `squadLobby()` answers with this one and `parts/Interior.build` writes its code as `shipLobbyCode`. `null` takes
   * the pretence away again. Never set outside `scripts/smoke-*`; a real `ctx.net.lobby` is untouched by it.
   */
  debugLobby: LobbyState | null = null;
  /** Smoke / debug: install `lobby` (or clear it) and swap the interior to the matching ship. */
  debugSharedShip(lobby: LobbyState | null): boolean {
    if (this.ctx.phase !== 'hub' || this.cutscene || this.ctx.net?.lobby) return false;
    this.debugLobby = lobby;
    this.swapDirect(lobby ? 'shared' : 'personal');
    return true;
  }
  /** Debug / smoke: whole seconds left on the squad-dock countdown panel, −1 while it is not shown. */
  get squadDockSeconds(): number { return this.dockCountdown?.seconds ?? -1; }
  /** Debug / smoke: the fade-out before the docking cutscene is running. */
  get dockFading(): boolean { return this.dockFade !== null; }
  /**
   * true while the ship is warping to a new planet (2026-09-09: the window warp — terminal closed, pods / bays / consoles
   * unavailable, but the **controls stay on** and the camera is the player's; nothing is locked).
   */
  travelling = false;
  /** The window warp in flight (`parts/Planet.tickTravel`), null at rest. `travelling` is its public shadow. */
  warp: WarpState | null = null;
  /** The solo pick (persisted); in a lobby `LobbyState.planet` wins and this is only the fallback. */
  localPlanet: PlanetId | null = null;
  /** `lobby.planet` as of the last `net:lobbyUpdated` we reacted to — a change starts the squad's cutscene. */
  knownLobbyPlanet: PlanetId | null = null;
  /**
   * 2026-09-11 (B-6): a `net:lobbyLeft {reason:'moved', to}` is waiting for the new lobby's `net:lobbyUpdated`, which
   * then plays **one** docking cutscene (no undock first). `to` null = any lobby; the timer falls back to a plain leave.
   */
  pendingMove: { to: string | null; timer: ReturnType<typeof setTimeout> } | null = null;

  /**
   * Pick the target planet and fly there. Refused (false) for a non-host in a lobby, for an unknown id, while a
   * cutscene / travel runs, while a launch countdown is ticking, outside the hub and when it is already the target.
   * On success: `hub:travel {stage:'start'}` → the window warp (`hub:warpProgress` every frame, controls on) →
   * `hub:travel {stage:'end'}` + `hub:planetChanged`. The ship interior is **not** rebuilt — only the view outside it changes.
   */
  setPlanet(planet: PlanetId): boolean { return Planet.setPlanet(this, planet); }

  /** Korean reason `행성 이동` is refused right now, or null when it is allowed (the terminal renders it). */
  travelBlockReason(planet?: PlanetId): string | null { return Planet.travelBlockReason(this, planet); }

  /** Restore the solo pick (`PLANET_STORAGE_KEY`); an unknown / absent value stays null (no target). */
  private loadPlanet(): void { return Planet.loadPlanet(this); }

  savePlanet(): void { return Planet.savePlanet(this); }

  /**
   * Fly to `planet` — the window warp (2026-09-09). Everyone steps out of their pod, the terminal / workbench close and
   * `warp` is armed for `HUB_TRAVEL_DURATION`; `tickTravel` drives the interior's `setWarp`, `hub:warpProgress` and the
   * hull shake every frame. No cutscene, no camera override, no control lock. The interior is **kept** (no
   * `disposeInterior`, no rebuild, the phase stays `'hub'`) — a planet change is a change of scenery, not a new ship.
   */
  startTravel(planet: PlanetId, by: 'local' | 'squad'): void { return Planet.startTravel(this, planet, by); }

  finishTravel(planet: PlanetId, by: 'local' | 'squad'): void { return Planet.finishTravel(this, planet, by); }

  /** One frame of the window warp (no-op at rest). Runs **after** the pod / status tick so its status line wins. */
  tickTravel(dt: number): void { return Planet.tickTravel(this, dt); }

  /** Drop a warp in flight without landing it (interior teardown / swap). No `hub:travel {end}` — see `parts/Planet`. */
  cancelTravel(): void { return Planet.cancelTravel(this); }

  /** The decorative planet outside the viewports takes the target planet's colours (nothing else is rebuilt). */
  applyPlanetLook(): void { return Planet.applyPlanetLook(this); }
  /** Personal-ship room the player stands in (XZ inside the room's `ROOM_SIZE × ROOM_DEPTH` floor), else null. */
  get currentRoom(): number | null { return this._currentRoom; }
  _currentRoom: number | null = null;
  getLaunchSlots(): readonly HubLaunchSlot[] { return Pods.getLaunchSlots(this); }
  /** Debug: housing-mode controller (camera / cursor / ghost). */
  get housing(): HousingMode { return this.housingMode; }
  /** Debug: furniture renderer of the current personal ship. */
  get furnitureLayer(): FurnitureLayer | null { return this.furniture; }

  /* ── the training arena (Phase 7) ─────────────────────────────────────── */
  /** A training is running in our lobby (`lobby.started` with mode `'training'`). */
  trainingRunning(): boolean { return Crew.trainingRunning(this); }
  /** A raid is running in our lobby (pods rejoin it; the training hub is locked). */
  raidRunning(): boolean { return Crew.raidRunning(this); }
  /** Connected members currently inside the training. */
  trainingCount(): number { return Crew.trainingCount(this); }

  /**
   * Enter the training arena — from the firing range's `furn_sim_hub` (personal ship) or the shared-ship terminal.
   * No countdown, no ready gating, individual entry: in a lobby any member calls `ctx.net.startGame(seed, 'training')`
   * (the server marks only the caller `inMission`), a training already running is joined with `rejoinMission()`, and a
   * running raid refuses. Solo: `ctx.missionMode = 'training'` is set **before** `game:newMission {seed, mode}` so
   * every `game:newMission` handler (world included) already sees the mode. Returns true when a request went out.
   */
  startTraining(): boolean { return Crew.startTraining(this); }

  interior: ShipInterior | null = null;
  /**
   * 2026-09-10: the ship a running docking cutscene will land in, built `PREBUILD_AFTER_S` into it and compiling in the
   * background (`ready`). `finishTransition` attaches it; `disposeInterior` throws it away if the transition never ends.
   */
  pendingInterior: { kind: HubShipKind; interior: ShipInterior; ready: Promise<boolean> } | null = null;
  pods: LaunchPod[] = [];
  terminal: Terminal | null = null;
  /*
   * 2026-09-12 (user's decision — the repair bench was dropped): `workbench: Workbench | null` and
   * `wbMenu: WorkbenchMenu` stood here. Weapon repair in the ship now happens **in the inventory** (anywhere, given
   * the materials), so `hub/Workbench.ts` (the `hub_workbench` interactable) and `hub/ui/WorkbenchMenu.ts` (the repair
   * window) are gone as whole files and the bench on the shared ship's aft wall is pure prop. Undoing it means
   * reviving those two files, the two fields here, and `new Workbench(...)` plus
   * `FurnitureCallbacks.onRepairBench` in `parts/Interior`. The bus event `hub:workbenchToggled` is a contract and
   * stays in `shared/events` — nobody emits it, that is all.
   */
  /**
   * The ship computer (Phase 5): `hub_computer` → `ctx.meta.openCorpMenu()`. 2026-09-12: only the **shared** ship's built-in desk
   * lives here; the personal ship's computer is `furn_corp_computer` furniture registered by the layer under the same id.
   */
  computer: Computer | null = null;
  stationIds: string[] = [];
  /** Decorating the ship: furniture meshes / colliders / interactables of the personal ship + the housing-mode controller. */
  furniture: FurnitureLayer | null = null;
  /** 2026-09-16 (plate models): the squadmates' plates on the shared ship's fixed table (`interiors/TablePlates`), null elsewhere. */
  tablePlates: TablePlates | null = null;
  housingMode!: HousingMode;
  slots: HubLaunchSlot[] = [];
  cutscene: DockingCutscene | null = null;
  menu!: HubMenu;
  /** The launch warning (2026-09-08): raised by `boardPod` when the launch check has something to say. */
  launchWarn!: LaunchWarnPanel;
  /** Warning signature the player already waved through — the same set never asks twice. Cleared on a real change. */
  launchWarnAck = '';
  status!: HubStatus;
  /** The ready panel (Phase 10): 4 portrait cells + the crew loadout popup. */
  ready!: ReadyPanel;

  /* ── crew cards (Phase 10; hub sends, net/ receives) ───────────────────── */
  /** `ctx.time` of the last `crew card` broadcast (debounced by `CREW_CARD_MIN_INTERVAL_S`). */
  lastCardAt = -Infinity;
  /** A change arrived inside the debounce window — send once it expires. */
  cardDirty = false;
  /** `ctx.time` we last answered each peer's `crewq loadout` (`CREW_LOADOUT_COOLDOWN_S`). */
  readonly loadoutAnsweredAt = new Map<PeerId, number>();
  crewUnsub: (() => void) | null = null;

  /* ── the shared ship's hangar (2026-09-08; hub sends `ship state`, net/ receives) ── */
  /**
   * The personal ship we walked into from a hangar bay, or null on the shared deck / in the ordinary solo personal ship.
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
   * Which ship interior we stand in, as a PeerId — null on the shared deck (shared ship + hangar), our own id in our
   * own ship, the owner's in a visited one. `net/Snapshotter` puts it on the wire as `PlayerSnapshot.hs` and remote
   * avatars whose value differs are hidden, so a tour of somebody's ship is private to the people inside it.
   */
  get hubSite(): PeerId | null {
    const v = this.visit;
    if (!v) return null;
    return v.peerId ?? (this.ctx.net?.localId ?? 'local');
  }
  /* ── remote furniture staging (2026-09-12, character buffs · furniture pose sync) ── */
  /** Fake remote refs planted by a smoke — non-null replaces `ctx.net`'s list **entirely** (the shape `HudSystem.debugRemotes` uses). */
  debugFurnitureRemotes: readonly RemotePlayerRef[] | null = null;
  /**
   * Smoke-test hook: feed synthetic remote refs (`{ id, connected, stale, suspended, hubSite, furniturePose }` is enough) to the
   * furniture layer's remote staging without a relay session. `debugRemoteFurniture(null)` hands it back to `ctx.net`.
   */
  debugRemoteFurniture(refs: readonly RemotePlayerRef[] | null): void { this.debugFurnitureRemotes = refs; }
  /** The remote refs the furniture layer stages from (the debug list while one is installed). */
  remoteFurnitureRefs(): readonly RemotePlayerRef[] {
    if (this.debugFurnitureRemotes) return this.debugFurnitureRemotes;
    const net = this.ctx?.net;
    return net && typeof net.getRemotePlayers === 'function' ? net.getRemotePlayers() : NO_REMOTES;
  }
  /**
   * 2026-09-21: everyone standing in **this** ship — the local player first, then every connected, non-stale
   * squadmate whose `hubSite` matches ours (the same co-presence rule the leader handoff uses, `parts/Crew.ts`:
   * someone touring another member's ship is not in this one). The airlock's automatic doors read it.
   *
   * A **reused** array of reused `Vector3`s: this runs every hub frame, so nothing is allocated (CLAUDE.md §4.1).
   * The positions are the refs' own live vectors, which is exactly what a distance test wants.
   */
  private readonly occupants: THREE.Vector3[] = [];
  private shipOccupants(): readonly THREE.Vector3[] {
    const list = this.occupants;
    list.length = 0;
    const p = this.ctx.player?.position;
    if (p) list.push(p);
    const net = this.ctx.net;
    if (!net || typeof net.getRemotePlayers !== 'function') return list;
    const site = this.hubSite;
    for (const ref of net.getRemotePlayers()) {
      if (!ref.connected || ref.stale) continue;
      if ((ref.hubSite ?? null) !== site) continue;
      list.push(ref.position);
    }
    return list;
  }

  /** PeerId of the ship being **visited** (someone else's), or null in our own ship / on the shared deck. */
  get visitingPeer(): PeerId | null { return this.visit?.peerId ?? null; }
  /** Inside someone else's ship: every console, bench, furniture piece and `시설 관리` is refused (looking around only). */
  get visitReadOnly(): boolean { return this.visit?.readOnly === true; }
  /** The hangar's four personal-ship bays with their occupants (empty outside the shared ship). */
  getShipBays(): readonly HubShipBay[] { return Hangar.getShipBays(this); }
  /** Board the personal ship parked in `slot` (ours or a squadmate's). See `parts/Hangar.enterShipBay`. */
  enterShipBay(slot: number): boolean { return Hangar.enterShipBay(this, slot); }
  /** Walk back out of a bay's ship into the hangar. */
  returnToHangar(): boolean { return Hangar.returnToHangar(this); }
  /** Swap the interior to `peerId`'s personal ship (null = ours), remembering the bay we came from. */
  boardShip(peerId: PeerId | null, slot: number): void { return Trans.boardShip(this, peerId, slot); }
  /** Swap back to the shared ship and put the player in front of the bay. */
  leaveShip(): void { return Trans.leaveShip(this); }
  /** Answer `shipq state`; also called on `hub:entered` when `ctx.net` was missing at init. */
  bindShipRequests(): void { return Hangar.bindShipRequests(this); }

  /* ── the cockpit android bays (2026-09-15, `parts/Androids`) ─────────────── */
  /** Interactable ids of the cockpit's android bays (shared ship only). */
  androidBayIds: string[] = [];
  /** A `lobby:android` request waiting for the relay's answer, null at rest. */
  androidPending: AndroidPending | null = null;
  /** The standing spots in front of the launch pods, by slot (`getPodStandPose`'s source; computed once per ship build). */
  podStands: Array<{ position: THREE.Vector3; yaw: number } | undefined> = [];
  /** The android bays in the shared ship's cockpit (by bay), empty elsewhere. A reused array — read it and use it at once. */
  getAndroidBays(): readonly HubAndroidBay[] { return Androids.getAndroidBays(this); }
  /** The standing spot in front of lobby slot `slot`'s pod (where a recruited android stands ready), null with none. */
  getPodStandPose(slot: number): { position: THREE.Vector3; yaw: number } | null { return Androids.getPodStandPose(this, slot); }
  /** Bring the capsule status strips · name tags in line with the lobby state. */
  refreshAndroidBays(): void { return Androids.refreshAndroidBays(this); }
  /** The bay prompt (it shows the refusal reason as it stands — the launch-pod rule). Debug / smoke. */
  androidPrompt(bay: number): string | null { return Androids.androidPrompt(this, bay); }
  /** Can this bay be reached at all right now (regardless of a refusal reason)? Debug / smoke. */
  androidCanInteract(bay: number): boolean { return Androids.androidCanInteract(this, bay); }

  /* ── the squad-leader handoff (2026-09-09) ────────────────────────────── */
  /**
   * One `lead:<peerId>` `Interactable` per remote squadmate in the shared ship (only while I am the host).
   * The avatar itself belongs to `player/RemotePlayerSystem`, so only its position is read — details in `parts/Crew`.
   */
  readonly leaderHandoffs = new Map<PeerId, { it: Interactable; pos: THREE.Vector3 }>();
  updateLeaderHandoff(): void { return Crew.updateLeaderHandoff(this); }
  clearLeaderHandoff(): void { return Crew.clearLeaderHandoff(this); }

  boardedSlot = -1;
  boardedAt = 0;
  /**
   * 2026-09-14 (the launch-slot UI rework): **the single source of the local ready flag**. Split from boarding
   * (`boardedSlot`): it turns on only when Space is held for `UI_HOLD_CONFIRM_S` while seated (`Pods.toggleReady`).
   * The server's `LobbyPlayer.ready` is no more than its echo — `syncPods` checks for it and rolls this back with none.
   */
  readyLocal = false;
  /** `ctx.time` of the last un-board — the pod refuses a new boarding for `REBOARD_GRACE` after it. */
  leftPodAt = -Infinity;
  readySentAt = -Infinity;
  countdown = -1;
  lastCountdownSecond = -1;
  launched = false;
  /**
   * Raid-entry loading (2026-09-15): the countdown reached 0, the screen is fading to black and the authority launches
   * `RAID_LOAD_FADE_OUT_S` later. Non-null = the launch is **committed** (E, the ready hold and un-readying no longer
   * cancel it) — `parts/Pods.beginRaidLoad` / `tickRaidLaunch`.
   */
  raidLaunch: RaidLaunchState | null = null;
  /** Debug / smoke: the raid-entry fade is running (the launch is committed). */
  get raidLaunching(): boolean { return this.raidLaunch !== null; }

  /**
   * A lost pointer lock only leaves the *room-console* housing mode (browser Esc while decorating). Since Phase 8
   * the hub **pauses** like a mission — `game/` owns that — so the terminal menu is never forced open here any more,
   * and ship management runs **deliberately unlocked** (a clickable room list / furniture card bar), so it ignores lock changes.
   */
  private onPointerLockChange = (): void => {
    const ctx = this.ctx;
    if (this.housingMode.manage) return;                    // ship management owns the cursor
    // any blocker (inventory / housing panels; the `기업` screen is the inventory window's own blocker since
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
    this.launchWarn = new LaunchWarnPanel(ctx, { onClosed: () => this.relock() });
    // ReadyPanel **before** HubStatus: `hub.css` lifts the status line off the panel with a sibling selector.
    // 2026-09-14: the panel measures the ready hold (Space, one second) and calls back; the rules live in `parts/Pods`.
    this.ready = new ReadyPanel(ctx, { toggleReady: () => this.toggleReady() });
    this.status = new HubStatus(ctx);
    this.dockCountdown = new SquadDockCountdown(ctx);   // 2026-09-15: the leader's dock countdown (right side)
    this.housingMode = new HousingMode(ctx);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('hub:enter', ({ ship }) => this.enter(ship)),
      // crew cards: the shared ship announces us once and asks everyone else for theirs (Phase 10)
      b.on('hub:entered', ({ ship }) => { if (ship === 'shared') { this.announceCrew(); Hangar.announceShip(this); } }),
      // Hangar (2026-09-08): our own ship layout is what a squadmate's bay renders — re-publish it when it changes
      b.on('housing:changed', () => Hangar.shipStateChanged(this)),
      b.on('housing:loaded', () => Hangar.shipStateChanged(this)),
      b.on('housing:booksChanged', () => Hangar.shipStateChanged(this)),
      // A-3e (2026-09-12): discs · records · a TV or record player left on are part of the ship a visitor sees too
      b.on('housing:shelfChanged', () => Hangar.shipStateChanged(this)),
      b.on('housing:furnitureToggled', () => Hangar.shipStateChanged(this)),
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
      b.on('net:lobbyUpdated', ({ lobby }) => { Androids.androidAnswered(this); this.onLobbyUpdated(lobby); }),
      b.on('net:lobbyLeft', ({ reason, to }) => { Androids.androidAnswered(this); this.onLobbyLeft(reason, to); }),
      b.on('net:resumed', ({ inProgress }) => this.onResumed(inProgress)),
      /*
       * The cockpit android bays (2026-09-15): the relay's answer releases the pending request — a `lobby:state`
       * and a refusal alike. The toasts (`full` · `human_joined`) are ui/'s share.
       */
      b.on('net:androidReturned', () => Androids.androidAnswered(this)),
      b.on('net:error', () => Androids.androidAnswered(this)),
      /*
       * 2026-09-11 (B-12): the `<name> 함선 합류 · 이탈` toasts on `net:peerJoined` / `net:peerLeft` were taken out —
       * `ui/hud/Notifications` already raises `<name> 합류` · `<name> 이탈` (label `'분대'`) on the same events, and
       * because that is the **same toast stack** as `ui:notify` the ship showed two lines side by side. All that is
       * lost is the word `함선` (standing in the ship and the `'분대'` label give that context), and `Notifications`
       * became the single owner of the toast.
       */
      b.on('net:statusChanged', () => { this.resendReady(); this.updateTerminalScreen(); Androids.androidAnswered(this); }),
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
    this.launchWarn.dispose();
    this.status.dispose();
    this.dockCountdown.dispose();
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

  build(ship: HubShipKind, viaAirlock: boolean, fromBay?: number, prebuilt?: ShipInterior): THREE.Vector3 { return Interior.build(this, ship, viaAirlock, fromBay, prebuilt); }

  /**
   * Ship stations: the implant bay, which opens the Tab ship screen (inventory window: `창고` / `장비` + implant
   * slots / `가방`). Its geometry is already merged into the interior. (Phase 8 removed the hydroponics station —
   * growing is the `온실` room's `furn_grow_rack` furniture now.)
   */
  buildStations(interior: ShipInterior): void { return Interior.buildStations(this, interior); }

  addStation(id: string, def: StationDef, prompt: string | (() => string), onUse: () => void, radius = 2.3): void { return Interior.addStation(this, id, def, prompt, onUse, radius); }

  /**
   * Decorating the ship (personal ship): the furniture layer and the housing-mode controller.
   *
   * Phase 8 UI pass: the room door consoles (`hub_room_<i>`) and the cockpit facility console (`hub_facility`) are
   * **gone**, along with their geometry — rooms, purposes and facilities are managed from the Tab `함선` tab and from
   * `시설 관리` (M). Only the furniture pieces themselves still answer to E.
   */
  buildHousing(interior: ShipInterior): void { return Interior.buildHousing(this, interior); }

  roomPurpose(i: number): RoomPurpose | null { return Interior.roomPurpose(this, i); }
  roomPurposeLabel(i: number): string { return Interior.roomPurposeLabel(this, i); }
  /** Door sign + room light of one room (an empty room reads dark, an assigned one is lit and gets a pool light). */
  refreshRoomSign(i: number): void { return Interior.refreshRoomSign(this, i); }
  refreshRoomSigns(): void { return Interior.refreshRoomSigns(this); }

  /** Track the personal-ship room under the player; emits `hub:roomEntered` on change (null = corridor / cockpit). */
  private trackRoom(): void { return Interior.trackRoom(this); }

  /**
   * The ship computer: opens the corporation screen. **2026-09-07**: it has no overlay of its own any more —
   * `openCorpMenu` opens the Tab window on its `기업` tab (`InventoryRef.openScreen('corp')`), so the blocker and the cursor
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
   * release our hooks). 'menu': back to the title (`game:abort` or `타이틀로`) — also restores the planet atmosphere.
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

  private onLobbyLeft(reason?: string, to?: string): void { return Trans.onLobbyLeft(this, reason, to); }

  /**
   * `net:resumed`. A **training** is not the squad's mission (individual entry, the lobby stays open), so a reconnect
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
   * a training runs in the lobby (join from the terminal instead), or the ship has no target planet (Phase 11).
   */
  podBlockReason(slot: number): string | null { return Pods.podBlockReason(this, slot); }

  boardPod(slot: number): void { return Pods.boardPod(this, slot); }

  /** Un-board. `sendReady` false when the lobby state already changed (reset / mission start / leaving the ship). */
  leavePod(sendReady: boolean, placeOutside = true): void { return Pods.leavePod(this, sendReady, placeOutside); }

  /**
   * 2026-09-14: ready / un-ready (Space held for `UI_HOLD_CONFIRM_S` while seated in the launch slot — measured by
   * `ui/ReadyPanel`). Only the way into readiness puts the launch warning popup first.
   */
  toggleReady(): void { return Pods.toggleReady(this); }

  /** Commit the local ready flag (the launch-warning popup's `그래도 준비` lands here). */
  setReadyLocal(ready: boolean): void { return Pods.setReadyLocal(this, ready); }

  /**
   * 2026-09-14: **am I ready** — the one line another folder asks "may gear be changed right now"
   * (`inventory/InventorySystem.readOnlyReason`) through. The name is fixed so `HubRef` reads it as an optional field.
   */
  get launchReady(): boolean { return this.boardedSlot >= 0 && this.readyLocal; }

  /** Mirror lobby ready flags into pod occupancy / tags; emits `hub:slotChanged` on changes. */
  syncPods(): void { return Pods.syncPods(this); }

  /**
   * The socket came back while we sit in a pod: re-send the ready flag (2026-09-09).
   *
   * `NetClient.send` silently drops anything posted while the socket is not OPEN, so the `setReady(true)` from
   * the ready hold is lost across a reconnect and the squad would wait for a member the server never marked ready.
   * `readySentAt` is pushed forward with it so `syncPods` gives the fresh echo its full `READY_ECHO_GRACE`.
   *
   * 2026-09-14: boarding and readiness are separate, so **`readyLocal` goes back out as it is** (merely seated sends false).
   */
  resendReady(): void {
    const net = this.ctx.net;
    if (this.boardedSlot < 0 || !net || !this.squadLobby() || !net.connected) return;
    net.setReady(this.readyLocal);
    this.readySentAt = this.ctx.time;
  }

  /** Level / ship implant / armor of a READY cell: local reads the refs, a peer reads its `crew card`. */
  crewLook(local: boolean, peerId: PeerId | null): Pick<ReadyCellInfo, 'level' | 'implant' | 'armorId'> { return Interior.crewLook(this, local, peerId); }

  updateTerminalScreen(): void {
    if (!this.terminal) return;
    const net = this.ctx.net;
    // 2026-09-15: the shared ship's lines only inside it — an undocked squad member's terminal is a personal ship's
    const lobby = this.squadLobby();
    const squad = !lobby ? (net?.lobby ?? null) : null;
    const seed = lobby ? lobby.seed : this.missionSeed;
    const seedText = seed === null ? '시드 무작위' : `시드 ${seed}`;
    const status = net?.status === 'connected' ? '네트워크 연결됨' : net?.status === 'connecting' ? '연결 중…' : '오프라인';
    const planetLine = `목표 ${this.travelling ? `${planetLabel(this.planet)} 이동 중` : (getPlanet(this.planet)?.name ?? PLANET_NONE_LABEL)}`;
    /* 2026-09-15 (android squadmates): the crew count is **people** — androids get their own line (a bot takes a slot but is not crew) */
    const crew = humanPlayersOf(lobby ?? squad).length;
    const bots = (lobby ?? squad) ? ((lobby ?? squad)!.players.length - crew) : 0;
    const lines = lobby
      ? [`함선 ${lobby.code}`, `승무원 ${crew}/4 · ${lobby.isPublic ? '공개' : '비공개'}`, planetLine, seedText]
      : ['개인 함선', squad ? `분대 ${crew}/4 · ${isDockedLobby(squad) ? '도킹 중' : '도킹 대기'}` : status, planetLine, seedText];
    if (bots > 0) lines.push(`안드로이드 ${bots}기`);
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
    this.ready.update(dt, ctx.time);
    // 2026-09-15 (squads · dock matchmaking): where the squad should be vs where we stand → countdown / fade / (un)dock
    if (this.active) SquadDock.tick(this, dt);
    // a card change inside the debounce window goes out as soon as it expires
    if (this.cardDirty) this.sendCrewCard(false);
    // Hangar (2026-09-08): the same trailing flush for our ship layout
    if (this.shipStateDirty) Hangar.sendShipState(this, false);
    if (this.cutscene) {
      this.cutscene.update(dt);
      // 2026-09-10: build + compile the destination ship while the cutscene plays (off its first frames)
      if (this.cutscene && !this.pendingInterior && this.cutscene.elapsed >= Trans.PREBUILD_AFTER_S) Trans.prebuildTarget(this);
      if (this.cutscene) this.status.set(this.cutscene.direction === 'dock' ? '도킹 절차 진행 중' : '도킹 해제 중', null);
      return;
    }
    if (ctx.phase !== 'hub' || !this.interior) return;
    // (2026-09-09) a window warp does **not** return early here: the interior keeps animating (room lights · star
    // drift — and now the streaks), the player keeps walking, and `tickTravel` runs at the tail of this frame.

    this.interior.update(dt, ctx.time);
    // Room lights + the airlock's automatic doors follow whoever is aboard (2026-09-21)
    if (this.interior.updateNear) {
      const pp = ctx.player?.position;
      this.interior.updateNear(dt, pp?.x ?? 0, pp?.z ?? 0, {
        occupants: this.shipOccupants(),
        // the room the ship-management camera is looking at gets pool lights too — see `PersonalShip.pickFocus`
        focus: this.housingMode.active ? this.housingMode.room : null,
      });
    }
    this.furniture?.update(ctx.time);
    for (const pod of this.pods) pod.update(dt, ctx.time);
    this.trackRoom();
    // Hangar: a bay boarded before its layout arrived finishes (or gives up) here
    Hangar.tickPendingVisit(this);
    // The leader handoff (2026-09-09): one interaction spot trails every remote squadmate in the same ship (host only)
    this.updateLeaderHandoff();

    // housing mode owns the input (cursor / place / rotate / recover / C / M) while active
    if (this.housingMode.active) { this.housingMode.update(dt); this.tickCountdown(dt); this.tickTravel(dt); return; }

    /*
     * 2026-09-08 (Escape always pauses): the hub does not read Escape any more. Every screen here closes on the key
     * that opened it — the terminal and the repair bench on **E** (both hang off an `Interactable`), the crew loadout
     * popup on another right-click or its `닫기` button — and Escape falls straight through to game/.
     *
     * 2026-09-09 (Escape closes): that Escape now **closes a screen**. Instead of reading the key here, each screen
     * pushes its own close onto `ctx.escape` as it opens (`ui/HubMenu` · `ui/LaunchWarnPanel` ·
     * `ui/CrewLoadoutPanel` — they share the `'hub'` token, so each keeps its own key), and `game/escapeKey` closes
     * the topmost one only.
     *
     * `HubSystem` updates **before** `PlayerSystem`, so the E that opens one of these panels is polled here while the
     * panel is still closed: one tap can never open and close it in the same frame. Typing in the terminal's fields
     * never reaches `Input` at all (`hub/ui/dom.isolateInput` stops the event at the field).
     */
    if (ctx.input.wasPressed(Keys.INTERACT) && !ctx.uiBlockers.has(MENU_BLOCKER)) {
      // The launch warning (2026-09-08): opened by the pod itself, not by a key — E is its keyboard `취소`.
      if (this.launchWarn.isOpen) { this.launchWarn.close(); ctx.input.consume(Keys.INTERACT); }
      // 2026-09-14: the match popup · the intel screen can stand over the terminal — E closes **the topmost one** only (`closeTop`)
      else if (this.menu.isOpen) { this.menu.closeTop(); ctx.input.consume(Keys.INTERACT); }
      // The crew loadout popup before the pod: it is modeless over the pod view and holds no blocker of its own, so
      // without this step the same E would un-board out from under it (Phase 10 ordering, on the new key).
      else if (this.ready.closePopup()) { ctx.input.consume(Keys.INTERACT); }
      // 2026-09-15 (raid-entry loading): once the fade began the launch is **committed** — un-boarding cancels nothing either
      else if (this.boardedSlot >= 0 && !this.raidLaunch && !this.uiBlocked() && ctx.time - this.boardedAt > UNBOARD_GRACE) {
        this.leavePod(true);
      }
    }
    // M: ship management (housing's manage mode; the HUD draws the room list / furniture bar). Read `Keys.MAP` live.
    if (ctx.uiBlockers.size === 0 && this.boardedSlot < 0 && ctx.input.wasPressed(Keys.MAP)) this.openShipManage();

    this.tickCountdown(dt);
    this.tickTravel(dt);
  }

  /**
   * Ship management (M in the ship): housing enters its manage mode from anywhere in the personal ship (no "stand in the
   * room" gate) and `HousingMode` takes the camera on `housing:shipManageChanged`. Refused in the shared ship.
   */
  openShipManage(): boolean {
    const ctx = this.ctx;
    if (ctx.phase !== 'hub' || this.cutscene || this.housingMode.active) return false;
    // Hangar (2026-09-08): a visited ship is for looking around only — `시설 관리` belongs to its owner alone
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
    /* 2026-09-15 4th pass: the room we stand in is **not passed as an argument** — an argument means 「open this room」
       and beats the remembered room, and then 「it comes back to the room last looked at」 (user's decision) never lives.
       The room we stand in is already in `openShipManage`'s fallback chain (`ctx.hub.currentRoom`), used only with no memory. */
    try { return h.openShipManage(); } catch { return false; }
  }
}
