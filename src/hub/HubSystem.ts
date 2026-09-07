import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import { getPlanet, isPlanetId, planetLabel, HUB_TRAVEL_DURATION, PLANET_NONE_LABEL, PLANET_STORAGE_KEY } from '@/shared';
import type { CrewCardWire, GameContext, GameSystem, HubLaunchSlot, HubRef, HubShipKind, Interactable, InteriorCollider, LoadoutSlot, LobbyState, PeerId, RoomPurpose } from '@/shared';
import { CREW_CARD_MIN_INTERVAL_S, CREW_LOADOUT_COOLDOWN_S, HUB_DOCKING_DURATION, HUB_LAUNCH_COUNTDOWN, HUB_READY_BLOCKER, HUB_READY_CELLS, Keys, NET_SLOT_COLORS, ROOM_PURPOSE_LABEL_KO } from '@/shared';
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
import { HubStatus } from './ui/HubStatus';
import { ReadyPanel, type ReadyCellInfo } from './ui/ReadyPanel';
import { randomSeed } from './ui/dom';
import './hub.css';

/** A pointer-lock exit this soon after a lock request is a denied request, not the user pressing Esc. */
const LOCK_REQUEST_GRACE_MS = 300;
/** Seconds after boarding before E can un-board (the boarding hold-release must not immediately leave). */
const UNBOARD_GRACE = 0.6;
/** Seconds after `setReady(true)` before a server-side `ready=false` is treated as a lobby reset. */
const READY_ECHO_GRACE = 1.5;
/** The two cutscene directions that swap the ship interior (`'travel'` keeps it — see `startTravel`). */
type DockTransition = Exclude<DockDirection, 'travel'>;

const _camPos = new THREE.Vector3();
const _camLook = new THREE.Vector3();
const _front = new THREE.Vector3();

/**
 * Ship hub (Helldivers-style ship interior between missions). Publishes `ctx.hub`.
 *
 * Flow: `hub:enter {personal}` → walk the personal ship → terminal (menu: quick match / code / broadcast) →
 * lobby appears → `docking` cutscene → shared ship (up to 4) → each player boards their launch pod (`setReady`) →
 * every connected member ready → host runs `HUB_LAUNCH_COUNTDOWN` → `ctx.net.startGame(seed)` → `game:newMission`
 * tears the hub down (`hub:left`). Solo: the personal pod launches `game:newMission` directly after the countdown.
 * Phases owned here: 'hub' and 'docking'. Not a gameplay phase (no world, no enemies, no weapons).
 */
export class HubSystem implements GameSystem, HubRef {
  readonly name = 'hub';
  private ctx!: GameContext;
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
  /** true while the travel cutscene runs (controls locked, terminal closed, pods unavailable). */
  travelling = false;
  /** The solo pick (persisted); in a lobby `LobbyState.planet` wins and this is only the fallback. */
  private localPlanet: PlanetId | null = null;
  /** `lobby.planet` as of the last `net:lobbyUpdated` we reacted to — a change starts the squad's cutscene. */
  private knownLobbyPlanet: PlanetId | null = null;

  /**
   * Pick the 목표 행성 and fly there. Refused (false) for a non-host in a lobby, for an unknown id, while a
   * cutscene / travel runs, while a launch countdown is ticking, outside the hub and when it is already the target.
   * On success: `hub:travel {stage:'start'}` → the docking cutscene reused as a warp → `hub:travel {stage:'end'}` +
   * `hub:planetChanged`. The ship interior is **not** rebuilt — only the view outside it changes.
   */
  setPlanet(planet: PlanetId): boolean {
    const ctx = this.ctx;
    if (!isPlanetId(planet)) return false;
    if (this.travelBlockReason() !== null) return false;
    if (this.planet === planet) return false;
    const net = ctx.net;
    if (net?.lobby) {
      // the host owns `lobby.planet`; net mirrors it optimistically, so `this.planet` is already the new value
      net.setLobbyPlanet(planet);
      this.knownLobbyPlanet = planet;
    } else {
      this.localPlanet = planet;
      this.savePlanet();
    }
    this.startTravel(planet, 'local');
    return true;
  }

  /** Korean reason 행성 이동 is refused right now, or null when it is allowed (the terminal renders it). */
  private travelBlockReason(): string | null {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (net?.lobby && !net.isHost) return '호스트만 지정할 수 있습니다';
    if (this.travelling || this.cutscene) return '이동 중';
    if (this.countdown >= 0) return '발사 카운트다운 중';
    if (ctx?.phase !== 'hub') return '함선에서만 지정할 수 있습니다';
    return null;
  }

  /** Restore the solo pick (`PLANET_STORAGE_KEY`); an unknown / absent value stays null (목표 미지정). */
  private loadPlanet(): void {
    try {
      const raw = localStorage.getItem(PLANET_STORAGE_KEY);
      if (isPlanetId(raw)) this.localPlanet = raw;
    } catch { /* private mode */ }
  }

  private savePlanet(): void {
    try {
      if (this.localPlanet) localStorage.setItem(PLANET_STORAGE_KEY, this.localPlanet);
      else localStorage.removeItem(PLANET_STORAGE_KEY);
    } catch { /* private mode */ }
  }

  /**
   * Fly to `planet`. Everyone steps out of their pod, the terminal / workbench close and `DockingCutscene` runs in
   * `'travel'` mode (`HUB_TRAVEL_DURATION`). The interior is **kept** (no `disposeInterior`, no rebuild, the phase
   * stays `'hub'`) — a planet change is a change of scenery, not a new ship.
   */
  private startTravel(planet: PlanetId, by: 'local' | 'squad'): void {
    const ctx = this.ctx;
    const def = getPlanet(planet);
    if (!def) return;
    if (this.boardedSlot >= 0) this.leavePod(true, true);
    this.menu.close(false);
    this.wbMenu.close(false);
    this.ready.hide();
    this.countdown = -1; this.lastCountdownSecond = -1; this.launched = false;
    this.travelling = true;
    this.cutscene?.dispose();
    ctx.bus.emit('hub:travel', { stage: 'start', planet });
    ctx.bus.emit('ui:notify', { text: `${def.name} 항로 진입`, kind: 'info' });
    ctx.bus.emit('audio:play', { id: 'hub_dock_thrusters', volume: 0.85 });
    this.cutscene = new DockingCutscene(ctx, 'travel', HUB_TRAVEL_DURATION, () => this.finishTravel(planet, by), {
      shared: this.ship === 'shared', color: def.hologram, atmo: def.hologramAtmo,
    });
  }

  private finishTravel(planet: PlanetId, by: 'local' | 'squad'): void {
    const ctx = this.ctx;
    this.cutscene?.dispose(); this.cutscene = null;
    this.travelling = false;
    const p = ctx.player;
    if (p) { p.setCameraOverride(null); p.setControlsEnabled(true); }
    this.applyPlanetLook();
    this.updateTerminalScreen();
    this.syncPods();
    ctx.bus.emit('hub:travel', { stage: 'end', planet });
    ctx.bus.emit('hub:planetChanged', { planet, by });
    ctx.bus.emit('ui:notify', { text: `${planetLabel(planet)} 궤도 진입 — 발사 슬롯 개방`, kind: 'success' });
    ctx.bus.emit('audio:play', { id: 'hub_dock_clamp', volume: 0.8 });
    this.relock();
  }

  /** The decorative planet outside the viewports takes the 목표 행성's colours (nothing else is rebuilt). */
  private applyPlanetLook(): void {
    const def = getPlanet(this.planet);
    if (!def) return;
    this.interior?.setPlanetLook?.(def.hologram, def.hologramAtmo);
  }
  /** Personal-ship room the player stands in (XZ inside the room's 4 × 4 m floor), else null. */
  get currentRoom(): number | null { return this._currentRoom; }
  private _currentRoom: number | null = null;
  getLaunchSlots(): readonly HubLaunchSlot[] { return this.slots; }
  /** Debug: true while the workbench (repair) menu is open. */
  get isWorkbenchOpen(): boolean { return !!this.wbMenu?.isOpen; }
  /** Debug: housing-mode controller (camera / cursor / ghost). */
  get housing(): HousingMode { return this.housingMode; }
  /** Debug: furniture renderer of the current personal ship. */
  get furnitureLayer(): FurnitureLayer | null { return this.furniture; }

  /* ── 시뮬레이션 훈련장 (Phase 7) ─────────────────────────────────────────── */
  /** A training is running in our lobby (`lobby.started` with mode `'training'`). */
  private trainingRunning(): boolean {
    const net = this.ctx.net, lobby = net?.lobby;
    return !!lobby?.started && (net?.missionMode ?? lobby?.mode ?? 'raid') === 'training';
  }
  /** A raid is running in our lobby (pods rejoin it; the training hub is locked). */
  private raidRunning(): boolean {
    const net = this.ctx.net, lobby = net?.lobby;
    return !!lobby?.started && (net?.missionMode ?? lobby?.mode ?? 'raid') !== 'training';
  }
  /** Connected members currently inside the training. */
  private trainingCount(): number {
    const lobby = this.ctx.net?.lobby;
    return lobby ? lobby.players.filter((p) => p.connected && p.inMission === true).length : 0;
  }

  /**
   * Enter the 시뮬레이션 훈련장 — from the 사격장 `furn_sim_hub` (personal ship) or the shared-ship terminal.
   * No countdown, no ready gating, individual entry: in a lobby any member calls `ctx.net.startGame(seed, 'training')`
   * (the server marks only the caller `inMission`), a training already running is joined with `rejoinMission()`, and a
   * running raid refuses. Solo: `ctx.missionMode = 'training'` is set **before** `game:newMission {seed, mode}` so
   * every `game:newMission` handler (world included) already sees the mode. Returns true when a request went out.
   */
  startTraining(): boolean {
    const ctx = this.ctx;
    if (ctx.phase !== 'hub' || this.cutscene || this.boardedSlot >= 0 || this.housingMode.active) return false;
    const net = ctx.net;
    const seed = this.resolveSeed();
    const deny = (text: string): false => {
      ctx.bus.emit('ui:notify', { text, kind: 'warning' });
      ctx.bus.emit('audio:play', { id: 'ui_deny' });
      return false;
    };
    if (net?.lobby) {
      if (this.raidRunning()) return deny('임무 진행 중 — 훈련장을 열 수 없습니다');
      if (this.trainingRunning()) {
        if (!net.missionInProgress || typeof net.rejoinMission !== 'function') return deny('이미 훈련장에 있습니다');
        ctx.bus.emit('ui:notify', { text: `훈련장에 합류합니다 (${this.trainingCount()}명 훈련 중)`, kind: 'info' });
        net.rejoinMission();          // → net:gameStarting {mode:'training', rejoin} + game:newMission → teardown('mission')
        return true;
      }
      if (typeof net.startGame !== 'function') return deny('훈련장을 열 수 없습니다');
      ctx.bus.emit('ui:notify', { text: '시뮬레이션 훈련장 입장', kind: 'info' });
      net.startGame(seed, 'training');   // server → game:start {mode:'training'} → net emits game:newMission for us only
      return true;
    }
    ctx.missionMode = 'training';
    ctx.missionPlanet = null;            // the arena has no planet (Phase 11 contract: a training clears it)
    ctx.bus.emit('ui:notify', { text: '시뮬레이션 훈련장 입장', kind: 'info' });
    ctx.bus.emit('game:newMission', { seed, mode: 'training' });
    return true;
  }

  private interior: ShipInterior | null = null;
  private pods: LaunchPod[] = [];
  private terminal: Terminal | null = null;
  private workbench: Workbench | null = null;
  /** 함선 컴퓨터 (Phase 5): `hub_computer` → `ctx.meta.openCorpMenu()`. */
  private computer: Computer | null = null;
  /** `ctx.meta.isMenuOpen` as seen by the previous frame — an Esc that the corp screen's own listener already consumed must not open the terminal. */
  private corpWasOpen = false;
  private stationIds: string[] = [];
  /** 함선 꾸미기: furniture meshes / colliders / interactables of the personal ship + the housing-mode controller. */
  private furniture: FurnitureLayer | null = null;
  private housingMode!: HousingMode;
  private slots: HubLaunchSlot[] = [];
  private cutscene: DockingCutscene | null = null;
  private menu!: HubMenu;
  private wbMenu!: WorkbenchMenu;
  private status!: HubStatus;
  /** 발사 준비 패널 (Phase 10): 4 portrait cells + the 분대원 장비 popup. */
  private ready!: ReadyPanel;

  /* ── crew cards (Phase 10; hub sends, net/ receives) ───────────────────── */
  /** `ctx.time` of the last `crew card` broadcast (debounced by `CREW_CARD_MIN_INTERVAL_S`). */
  private lastCardAt = -Infinity;
  /** A change arrived inside the debounce window — send once it expires. */
  private cardDirty = false;
  /** `ctx.time` we last answered each peer's `crewq loadout` (`CREW_LOADOUT_COOLDOWN_S`). */
  private readonly loadoutAnsweredAt = new Map<PeerId, number>();
  private crewUnsub: (() => void) | null = null;

  private boardedSlot = -1;
  private boardedAt = 0;
  private readySentAt = -Infinity;
  private countdown = -1;
  private lastCountdownSecond = -1;
  private launched = false;

  /**
   * A lost pointer lock only leaves the *room-console* housing mode (browser Esc while decorating). Since Phase 8
   * the hub **pauses** like a mission — `game/` owns that — so the terminal menu is never forced open here any more,
   * and 함선 관리 runs **deliberately unlocked** (clickable 방 목록 / 가구 카드 바), so it ignores lock changes.
   */
  private onPointerLockChange = (): void => {
    const ctx = this.ctx;
    if (this.housingMode.manage) return;                    // 함선 관리 owns the cursor
    // any blocker (inventory / housing panels / the corp screen's 'corp' token) owns the lock loss —
    // except the READY panel's own token, which never released the lock in the first place (Phase 10)
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
      toTitle: () => this.toTitle(),
      onClosed: () => this.relock(),
      startTraining: () => this.startTraining(),
      planet: () => this.planet,
      travelBlock: () => this.travelBlockReason(),
      travelTo: (p) => { this.setPlanet(p); },
    });
    this.wbMenu = new WorkbenchMenu(ctx, { onClosed: () => this.relock() });
    // ReadyPanel **before** HubStatus: `hub.css` lifts the status line off the panel with a sibling selector.
    this.ready = new ReadyPanel(ctx);
    this.status = new HubStatus(ctx);
    this.housingMode = new HousingMode(ctx);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('hub:enter', ({ ship }) => this.enter(ship)),
      // crew cards: the shared ship announces us once and asks everyone else for theirs (Phase 10)
      b.on('hub:entered', ({ ship }) => { if (ship === 'shared') this.announceCrew(); }),
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
      b.on('net:statusChanged', () => this.updateTerminalScreen()),
      b.on('meta:creditsChanged', () => this.updateTerminalScreen()),
      b.on('meta:loaded', () => this.updateTerminalScreen()),
    );
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.bindCrewRequests();
  }

  dispose(): void {
    this.teardown('menu');
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.crewUnsub?.(); this.crewUnsub = null;
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.menu.dispose();
    this.wbMenu.dispose();
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
  private bindCrewRequests(): void {
    if (this.crewUnsub) return;
    const net = this.ctx.net;
    if (!net || typeof net.onMessage !== 'function') return;
    this.crewUnsub = net.onMessage('crewq', (msg, from) => {
      if (msg.ev === 'sync') this.sendCrewCard(true, from);
      else if (msg.ev === 'loadout') this.sendCrewLoadout(from);
    });
  }

  /** Our own card: level / ship implant / armor + the three weapon slots (no attachments). */
  private crewCard(): CrewCardWire {
    const ctx = this.ctx;
    const inv = ctx.inventory;
    const defId = (slot: LoadoutSlot): string | null => {
      if (!inv || typeof inv.getEquipped !== 'function') return null;
      try { return inv.getEquipped(slot)?.defId ?? null; } catch { return null; }
    };
    let level = 1;
    try { const l = ctx.progression?.level; if (typeof l === 'number' && Number.isFinite(l)) level = Math.max(1, Math.round(l)); } catch { /* stub */ }
    let implant: CrewCardWire['implant'] = null;
    try { implant = ctx.implants?.equipped ?? null; } catch { /* stub */ }
    return { level, implant, armor: defId('armor'), primary: defId('primary'), primary2: defId('primary2'), secondary: defId('secondary') };
  }

  /**
   * A level / implant / equipment change: repaint our own READY cell, then broadcast (debounced). Only while the hub
   * is up — mid-raid loadout churn is nobody's business, and a `crewq sync` re-reads the card on demand anyway.
   */
  private crewCardChanged(): void {
    if (!this.interior || !this.active) return;
    this.syncPods();
    if (!this.ctx.net?.lobby) return;
    this.sendCrewCard(false);
  }

  /** `to` omitted = broadcast to `others`; `force` skips the debounce (a direct `crewq sync` answer / arrival). */
  private sendCrewCard(force: boolean, to?: PeerId): void {
    const net = this.ctx.net;
    if (!net?.lobby || typeof net.send !== 'function') { this.cardDirty = false; return; }
    if (!force && this.ctx.time - this.lastCardAt < CREW_CARD_MIN_INTERVAL_S) { this.cardDirty = true; return; }
    if (to === undefined) { this.lastCardAt = this.ctx.time; this.cardDirty = false; }
    try { net.send({ t: 'crew', ev: 'card', card: this.crewCard() }, to ?? 'others'); } catch { /* offline */ }
  }

  /** `crewq loadout` answer: our card + `ctx.inventory.captureCrewLoadout()`, rate-limited per requester. */
  private sendCrewLoadout(to: PeerId): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!net?.lobby || typeof net.send !== 'function') return;
    const last = this.loadoutAnsweredAt.get(to) ?? -Infinity;
    if (ctx.time - last < CREW_LOADOUT_COOLDOWN_S) return;
    const inv = ctx.inventory;
    if (!inv || typeof inv.captureCrewLoadout !== 'function') return;
    let loadout: unknown = null;
    try { loadout = inv.captureCrewLoadout(); } catch { return; }
    if (loadout === null || loadout === undefined) return;
    this.loadoutAnsweredAt.set(to, ctx.time);
    try { net.send({ t: 'crew', ev: 'loadout', card: this.crewCard(), loadout }, to); } catch { /* offline */ }
  }

  /** Arriving in the shared ship: publish our card and ask the squad for theirs. */
  private announceCrew(): void {
    this.bindCrewRequests();
    const net = this.ctx.net;
    if (!net?.lobby || typeof net.send !== 'function') return;
    this.loadoutAnsweredAt.clear();
    this.sendCrewCard(true);
    try { net.send({ t: 'crewq', ev: 'sync' }, 'others'); } catch { /* offline */ }
  }

  /**
   * UI blockers that own the input, **ignoring the READY panel's own token**. The panel keeps the pointer lock and
   * only draws a software cursor, so it must not stop the pod's Esc / E un-board or the lock-loss handler — exactly
   * the shape of `HousingMode.blockedByPanel()`.
   */
  private uiBlocked(): boolean {
    const b = this.ctx.uiBlockers;
    if (b.size === 0) return false;
    return !(b.size === 1 && b.has(HUB_READY_BLOCKER));
  }

  /* ── enter / build / teardown ──────────────────────────────────────────── */
  private enter(requested: HubShipKind): void {
    const ctx = this.ctx;
    // 'shared' needs a lobby; conversely, while a lobby exists the squad lives in the shared ship.
    const ship: HubShipKind = ctx.net?.lobby ? 'shared' : 'personal';
    if (requested !== ship) console.info(`[hub] hub:enter ${requested} → ${ship} (lobby ${ctx.net?.lobby ? 'present' : 'absent'})`);
    const phase = ctx.phase;
    if (phase !== 'menu' && phase !== 'hub' && phase !== 'docking') ctx.bus.emit('game:abort', {});   // abort the mission / result screen first
    if (this.cutscene) { this.cutscene.dispose(); this.cutscene = null; this.travelling = false; }
    if (this.interior && this.ship === ship && ctx.phase === 'hub') return;      // idempotent
    this.disposeInterior();
    const spawn = this.build(ship, false);
    ctx.setPhase('hub');
    ctx.bus.emit('hub:entered', { ship, spawn: spawn.clone() });
    ctx.input.requestPointerLock();
    if (ship === 'personal') this.tryResume();
  }

  /** Personal ship: connect in the background; a lobby on `welcome` (resume) moves us straight to the shared ship. */
  private tryResume(): void {
    const net = this.ctx.net;
    if (!net || typeof net.ensureConnected !== 'function') return;
    net.ensureConnected().then((ok) => {
      if (!ok || !net.lobby) return;
      if (this.ship === 'personal' && this.ctx.phase === 'hub' && !this.cutscene) this.swapDirect('shared');
    }).catch(() => { /* offline personal ship */ });
  }

  private build(ship: HubShipKind, viaAirlock: boolean): THREE.Vector3 {
    const ctx = this.ctx;
    const interior: ShipInterior = ship === 'personal' ? new PersonalShip() : new SharedShip();
    ctx.scene.add(interior.root);
    this.interior = interior;
    this.ship = ship;
    this.collider = interior.collider;
    this.pods = interior.pods.map((def) => new LaunchPod(ctx, def, NET_SLOT_COLORS[def.slot % NET_SLOT_COLORS.length], interior.collider, {
      getPrompt: () => this.podPrompt(def.slot),
      canInteract: () => this.podCanInteract(def.slot),
      interact: () => this.boardPod(def.slot),
    }));
    this.slots = interior.pods.map((d) => ({ slot: d.slot, position: d.position.clone(), yaw: d.yaw, occupant: null }));
    const canUseConsole = (): boolean => this.stationUsable();
    this.terminal = new Terminal(ctx, interior.terminal, () => this.menu.open(), canUseConsole);
    // the personal ship has no built-in bench since Phase 8 (a placed `furn_repair_bench` opens the same menu)
    this.workbench = interior.workbench ? new Workbench(ctx, interior.workbench, () => this.wbMenu.open(), canUseConsole) : null;
    this.computer = new Computer(ctx, interior.computer, () => this.openCorpMenu(), canUseConsole);
    this.buildStations(interior);
    this.buildHousing(interior);

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
    this.setSpaceMode(true);
    this.countdown = -1; this.launched = false; this.lastCountdownSecond = -1;
    this.knownLobbyPlanet = ctx.net?.lobby ? (ctx.net.lobbyPlanet ?? null) : null;
    this.applyPlanetLook();
    this.syncPods();
    this.updateTerminalScreen();
    return spawn;
  }

  /**
   * 함선 시설: the implant bay, which opens the Tab ship screen (inventory window: 창고 / 장비 + 임플란트 슬롯 /
   * 가방). Its geometry is already merged into the interior. (Phase 8 removed the hydroponics station — 재배 is
   * the 온실 room's `furn_grow_rack` furniture now.)
   */
  private buildStations(interior: ShipInterior): void {
    const s = interior.stations;
    if (!s) return;
    this.addStation('hub_implant_bay', s.implantBay, '전술 임플란트 장착', () => {
      const inv = this.ctx.inventory;
      if (inv && !inv.isOpen) inv.toggleBag();
    });
  }

  private addStation(id: string, def: StationDef, prompt: string | (() => string), onUse: () => void, radius = 2.3): void {
    const it: Interactable = {
      id,
      position: def.position.clone(),
      radius,
      getPrompt: () => (this.stationUsable() ? (typeof prompt === 'function' ? prompt() : prompt) : null),
      canInteract: () => this.stationUsable(),
      interact: onUse,
    };
    this.ctx.interactables.register(it);
    this.stationIds.push(id);
  }

  /**
   * 함선 꾸미기 (personal ship): the furniture layer and the housing-mode controller.
   *
   * Phase 8 UI pass: the room door consoles (`hub_room_<i>`) and the cockpit facility console (`hub_facility`) are
   * **gone**, along with their geometry — rooms, purposes and facilities are managed from the Tab 함선 tab and from
   * 시설 관리 (M). Only the furniture pieces themselves still answer to E.
   */
  private buildHousing(interior: ShipInterior): void {
    const ctx = this.ctx;
    if (!(interior instanceof PersonalShip)) { this.housingMode.setShip(null, null); return; }
    this.furniture = new FurnitureLayer(ctx, interior.rooms, interior.collider, {
      canUse: () => this.stationUsable(),
      onBench: (kind, level) => {
        const inv = ctx.inventory;
        if (inv && typeof inv.openBenchCraft === 'function') inv.openBenchCraft(kind, level);
        else ctx.bus.emit('ui:notify', { text: '작업대를 사용할 수 없습니다', kind: 'warning' });
      },
      onRangeConsole: () => {
        const h = ctx.housing;
        if (h && typeof h.openPresetMenu === 'function') h.openPresetMenu();
      },
      onSimHub: () => this.startTraining(),
      onGrowRack: (uid) => {
        const h = ctx.housing;
        if (h && typeof h.openGrowMenu === 'function') h.openGrowMenu(uid);
        else ctx.bus.emit('ui:notify', { text: '재배층을 사용할 수 없습니다', kind: 'warning' });
      },
      onRepairBench: () => this.wbMenu.open(),
      onBookshelf: (uid) => {
        const h = ctx.housing;
        if (h && typeof h.openBookshelfMenu === 'function') h.openBookshelfMenu(uid);
        else ctx.bus.emit('ui:notify', { text: '책장을 사용할 수 없습니다', kind: 'warning' });
      },
    });
    this.housingMode.setShip(interior, this.furniture);
    this.refreshRoomSigns();
  }

  private roomPurpose(i: number): RoomPurpose | null {
    const h = this.ctx.housing;
    if (!h || typeof h.getRoom !== 'function') return null;
    try { return h.getRoom(i).purpose; } catch { return null; }
  }
  private roomPurposeLabel(i: number): string {
    const p = this.roomPurpose(i);
    return p ? ROOM_PURPOSE_LABEL_KO[p] : '빈 방';
  }
  /** Door sign + 방 조명 of one room (an empty room reads dark, an assigned one is lit and gets a pool light). */
  private refreshRoomSign(i: number): void {
    const ship = this.interior;
    if (!(ship instanceof PersonalShip)) return;
    const p = this.roomPurpose(i);
    const assigned = !!p && p !== 'empty';
    ship.setRoomLabel(i, this.roomPurposeLabel(i), assigned ? '#ffd27a' : '#e8e6e1');
    ship.setRoomLit(i, assigned);
  }
  private refreshRoomSigns(): void {
    if (!(this.interior instanceof PersonalShip)) return;
    for (const r of this.interior.rooms) this.refreshRoomSign(r.index);
  }

  /** Track the personal-ship room under the player; emits `hub:roomEntered` on change (null = corridor / cockpit). */
  private trackRoom(): void {
    const p = this.ctx.player;
    let room: number | null = null;
    if (p && this.interior instanceof PersonalShip) room = roomAtWorld(p.position.x, p.position.z);
    if (room === this._currentRoom) return;
    this._currentRoom = room;
    this.ctx.bus.emit('hub:roomEntered', { room, purpose: room === null ? null : this.roomPurpose(room) });
  }

  /**
   * 함선 컴퓨터: open the corporation screen (meta owns the DOM + the `'corp'` blocker). While `ctx.meta` is missing,
   * a stub, or refuses (menu not open afterwards) the player gets a warning toast instead of silence.
   */
  private openCorpMenu(): void {
    const meta = this.ctx.meta;
    if (meta && typeof meta.openCorpMenu === 'function') {
      try { meta.openCorpMenu(); } catch (e) { console.warn('[hub] openCorpMenu failed', e); }
      if (this.corpMenuOpen()) return;
    }
    this.ctx.bus.emit('ui:notify', { text: '기업 네트워크에 접속할 수 없습니다', kind: 'warning' });
  }

  /** True while the corporation screen (`ctx.meta`) is open. */
  private corpMenuOpen(): boolean {
    try { return this.ctx.meta?.isMenuOpen === true; } catch { return false; }
  }

  /** Terminal / station consoles are usable while walking the ship (not boarded, no menu, not docking, not decorating). */
  private stationUsable(): boolean {
    return this.ctx.phase === 'hub' && !this.menu.isOpen && !this.wbMenu.isOpen && !(this.ctx.inventory?.isOpen ?? false)
      && !(this.ctx.housing?.isMenuOpen ?? false) && !this.corpMenuOpen() && this.boardedSlot < 0 && !this.cutscene && !this.housingMode.active;
  }

  private disposeInterior(): void {
    this.housingMode.setShip(null, null);
    this.furniture?.dispose(); this.furniture = null;
    for (const pod of this.pods) pod.dispose();
    this.pods = [];
    for (const id of this.stationIds) this.ctx.interactables.unregister(id);
    this.stationIds.length = 0;
    this.terminal?.dispose(); this.terminal = null;
    this.workbench?.dispose(); this.workbench = null;
    this.computer?.dispose(); this.computer = null;
    this.interior?.dispose(); this.interior = null;
    this.collider = null;
    this.ship = null;
    this.slots = [];
  }

  /**
   * Leave the hub. 'mission': `game:newMission` arrived (World already generated, Player already respawned — only
   * release our hooks). 'menu': back to the title (`game:abort` or 타이틀로) — also restores the planet atmosphere.
   */
  private teardown(reason: 'mission' | 'menu'): void {
    if (!this.interior && !this.cutscene) return;
    const ctx = this.ctx;
    if (this.boardedSlot >= 0) this.leavePod(false, false);
    this.menu.close(false);
    this.wbMenu.close(false);
    this.status.hide();
    this.ready.hide();
    this.cutscene?.dispose(); this.cutscene = null;
    this.travelling = false;
    this.disposeInterior();
    this.countdown = -1; this.launched = false;
    const p = ctx.player;
    if (p) {
      p.setInterior(null);
      p.setCameraOverride(null);
      p.setInPod(false);
      if (reason === 'menu') p.setControlsEnabled(true);
    }
    if (reason === 'menu') this.setSpaceMode(false);
    if (this._currentRoom !== null) { this._currentRoom = null; ctx.bus.emit('hub:roomEntered', { room: null, purpose: null }); }
    ctx.bus.emit('hub:left', {});
  }

  /** 타이틀로: leave the lobby (if any), tear down, phase 'menu' (the title shows because `ctx.net.lobby` is null). */
  private toTitle(): void {
    const ctx = this.ctx;
    if (ctx.net?.lobby) ctx.net.leaveLobby();
    this.teardown('menu');
    ctx.setPhase('menu');
  }

  private setSpaceMode(on: boolean): void {
    const atmo = this.ctx.scene.userData.atmosphere as { setSpaceMode?: (on: boolean) => void } | undefined;
    atmo?.setSpaceMode?.(on);
  }

  private relock(): void {
    queueMicrotask(() => {
      const ctx = this.ctx;
      // never grab the pointer back while decorating — 함선 관리 needs the free cursor for its panels
      if (ctx.phase !== 'hub' || ctx.uiBlockers.size > 0 || this.housingMode.active) return;
      ctx.input.requestPointerLock();
    });
  }

  /* ── docking transitions ───────────────────────────────────────────────── */
  private startTransition(direction: DockTransition): void {
    const ctx = this.ctx;
    if (this.cutscene) {
      if (this.cutscene.direction === direction) return;
      this.cutscene.dispose(); this.cutscene = null; this.travelling = false;
    }
    if (this.boardedSlot >= 0) this.leavePod(false, false);
    this.menu.close(false);
    this.wbMenu.close(false);
    this.ready.hide();
    this.disposeInterior();          // the player keeps the old collider reference until the new ship is built
    ctx.setPhase('docking');
    ctx.bus.emit('hub:docking', { stage: 'start', direction });
    ctx.bus.emit('ui:notify', { text: direction === 'dock' ? '도킹 절차 시작' : '도킹 해제 — 개인 함선으로 복귀', kind: 'info' });
    const duration = direction === 'dock' ? HUB_DOCKING_DURATION : HUB_DOCKING_DURATION * 0.5;
    this.cutscene = new DockingCutscene(ctx, direction, duration, () => this.finishTransition(direction));
  }

  private finishTransition(direction: DockTransition): void {
    const ctx = this.ctx;
    this.cutscene?.dispose(); this.cutscene = null; this.travelling = false;
    const target: HubShipKind = direction === 'dock' && ctx.net?.lobby ? 'shared' : 'personal';
    const spawn = this.build(target, target === 'shared');
    ctx.setPhase('hub');
    ctx.bus.emit('hub:docking', { stage: 'end', direction });
    ctx.bus.emit('hub:entered', { ship: target, spawn: spawn.clone() });
    this.relock();
  }

  /** Swap interiors without a cutscene (resume after reload / seamless cases). */
  private swapDirect(target: HubShipKind): void {
    const ctx = this.ctx;
    this.cutscene?.dispose(); this.cutscene = null; this.travelling = false;
    if (this.boardedSlot >= 0) this.leavePod(false, false);
    this.menu.close(false);
    this.wbMenu.close(false);
    this.ready.hide();
    this.disposeInterior();
    const spawn = this.build(target, target === 'shared');
    ctx.setPhase('hub');
    ctx.bus.emit('hub:entered', { ship: target, spawn: spawn.clone() });
  }

  /* ── net events ────────────────────────────────────────────────────────── */
  private onLobbyUpdated(lobby: LobbyState): void {
    if (!this.active) return;
    if (this.ship === 'personal' && this.ctx.phase === 'hub' && !this.cutscene) {
      if (lobby.started) this.swapDirect('shared');     // resumed into a running mission: no cutscene
      else this.startTransition('dock');
      return;
    }
    // 목표 행성 (Phase 11): the host's pick reaches everyone as `lobby:state` — there is no travel message on the
    // wire, each member plays the cutscene off its own copy. Arriving in the lobby only fills the value (see `build`).
    const lp = lobby.planet ?? null;
    if (lp !== this.knownLobbyPlanet) {
      this.knownLobbyPlanet = lp;
      if (lp && !this.travelling && !this.cutscene && this.ctx.phase === 'hub' && !lobby.started) {
        this.startTravel(lp, 'squad');
        return;                                          // startTravel already re-synced the pods / screen
      }
      this.applyPlanetLook();
    }
    this.syncPods();
    this.updateTerminalScreen();
  }

  private onLobbyLeft(): void {
    if (!this.active) return;
    if (this.ship === 'shared' || (this.cutscene && this.cutscene.direction === 'dock')) this.startTransition('undock');
    else { this.syncPods(); this.updateTerminalScreen(); }
  }

  /**
   * `net:resumed`. A **훈련장** is not the squad's mission (individual entry, the lobby stays open), so a reconnect
   * while one runs must never read as `분대가 임무 중` — it points at the terminal instead.
   */
  private onResumed(inProgress: boolean): void {
    if (!this.active) return;
    if (this.ship !== 'shared') this.swapDirect('shared');
    const training = this.trainingRunning();
    const raid = inProgress && !training;
    this.ctx.bus.emit('ui:notify', {
      text: raid ? '분대가 임무 중입니다 — 발사 슬롯에 탑승하면 재투입됩니다'
        : training ? '함선에 재접속했습니다 — 훈련장이 열려 있습니다 (터미널에서 합류)'
        : '함선에 재접속했습니다',
      kind: raid ? 'warning' : 'success', duration: 5,
    });
  }

  /* ── pods ──────────────────────────────────────────────────────────────── */
  private localSlot(): number { return this.ctx.net?.lobby ? this.ctx.net.localSlot : 0; }

  private podPrompt(slot: number): string | null {
    if (!this.podCanInteract(slot)) return null;
    return this.podBlockReason(slot) ?? (this.ctx.net?.lobby && this.ctx.net.missionInProgress ? '임무 진행 중 — 재투입' : '발사 슬롯 탑승');
  }

  /**
   * Basic pod availability: the pod is reachable and free. The **reasons boarding is refused anyway** live in
   * `podBlockReason` — they keep `canInteract` true on purpose, because `ctx.interactables.findBest` skips an
   * interactable that answers false and the player would then see no prompt at all (and no reason).
   */
  private podCanInteract(slot: number): boolean {
    const ctx = this.ctx;
    if (ctx.phase !== 'hub' || this.cutscene || this.travelling || this.boardedSlot >= 0 || this.menu.isOpen || this.wbMenu.isOpen || this.housingMode.active || this.corpMenuOpen()) return false;
    if (slot !== this.localSlot()) return false;
    const pod = this.pods[slot];
    return !!pod && pod.occupant === null;
  }

  /**
   * Why boarding is refused right now (also the pod's prompt text), or null when the slot takes us:
   * a training runs in the lobby (join from the terminal instead), or the ship has no 목표 행성 (Phase 11).
   */
  private podBlockReason(slot: number): string | null {
    void slot;
    if (this.trainingRunning()) return '훈련 진행 중 — 터미널에서 합류';
    if (this.planet === null) return '목표 행성 미지정 — 터미널에서 지정';
    return null;
  }

  private boardPod(slot: number): void {
    const ctx = this.ctx;
    if (!this.podCanInteract(slot)) return;
    const net = ctx.net;
    if (this.trainingRunning()) {
      // pods stay closed while a training runs: the terminal's 시뮬레이션 훈련장 entry joins it
      ctx.bus.emit('ui:notify', { text: '훈련 진행 중 — 터미널에서 합류할 수 있습니다', kind: 'warning' });
      ctx.bus.emit('audio:play', { id: 'ui_deny' });
      return;
    }
    if (this.planet === null) {
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
    const pod = this.pods[slot];
    this.boardedSlot = slot;
    this.boardedAt = ctx.time;
    const p = ctx.player;
    if (p) {
      p.spawnStanding(pod.def.position, pod.def.yaw);
      p.setInPod(true);
      p.setControlsEnabled(false);
      pod.getCameraShot(_camPos, _camLook);
      p.setCameraOverride(_camPos, _camLook);
    }
    if (net?.lobby) { net.setReady(true); this.readySentAt = ctx.time; }
    ctx.bus.emit('audio:play', { id: 'ui_equip' });
    this.syncPods();
  }

  /** Un-board. `sendReady` false when the lobby state already changed (reset / mission start / leaving the ship). */
  private leavePod(sendReady: boolean, placeOutside = true): void {
    if (this.boardedSlot < 0) return;
    const ctx = this.ctx;
    const pod = this.pods[this.boardedSlot];
    this.boardedSlot = -1;
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
    if (this.countdown >= 0) { this.countdown = -1; ctx.bus.emit('ui:notify', { text: '발사 취소', kind: 'warning' }); }
    this.syncPods();
  }

  /** Mirror lobby ready flags into pod occupancy / tags; emits `hub:slotChanged` on changes. */
  private syncPods(): void {
    const ctx = this.ctx;
    const net = ctx.net;
    const lobby = net?.lobby ?? null;
    const localId: PeerId = net?.localId ?? 'local';
    const localSlot = this.localSlot();
    const me = lobby ? lobby.players.find((q) => q.id === localId) : undefined;
    const training = this.trainingRunning();

    // server dropped our ready flag (lobby reset / kick-back) while we sit in the pod → step out
    if (this.boardedSlot >= 0 && lobby && me && !me.ready && !lobby.started && ctx.time - this.readySentAt > READY_ECHO_GRACE) {
      this.leavePod(false, true);
      ctx.bus.emit('ui:notify', { text: '발사 슬롯이 초기화되었습니다', kind: 'warning' });
      return;   // leavePod re-runs syncPods
    }

    // 발사 준비 패널 cells, filled while we walk the pods below (`null` = no member in that slot at all)
    const cells: (ReadyCellInfo | null)[] = new Array(HUB_READY_CELLS).fill(null);

    for (let i = 0; i < this.pods.length; i++) {
      const pod = this.pods[i];
      const slot = pod.slot;
      let occupant: PeerId | null = null;
      let name = '빈 슬롯', state = '—', local = false;
      let present = false, connected = true, peerId: PeerId | null = null;
      if (slot === localSlot && (!lobby || me)) {
        local = true; present = true; peerId = localId;
        name = net?.playerName ?? '스캐빈저';
        if (this.boardedSlot === slot) { occupant = localId; state = '탑승 완료'; }
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
          ...this.crewLook(local, peerId),
        };
      }
      const changed = pod.setDisplay({ occupant, name, state, local, closed: occupant !== null });
      if (this.slots[i]) this.slots[i].occupant = occupant;
      if (changed) ctx.bus.emit('hub:slotChanged', { slot, peerId: occupant, local });
    }
    // interactive (blocker + software cursor) only while WE are boarded — see `ui/ReadyPanel`
    this.ready.sync(cells, this.boardedSlot >= 0 && ctx.phase === 'hub' && !this.cutscene);
  }

  /** Level / ship implant / armor of a READY cell: local reads the refs, a peer reads its `crew card`. */
  private crewLook(local: boolean, peerId: PeerId | null): Pick<ReadyCellInfo, 'level' | 'implant' | 'armorId'> {
    if (local) {
      const c = this.crewCard();
      return { level: c.level, implant: c.implant, armorId: c.armor };
    }
    const net = this.ctx.net;
    if (!peerId || !net || typeof net.getCrewCard !== 'function') return { level: null, implant: null, armorId: null };
    let card: CrewCardWire | null = null;
    try { card = net.getCrewCard(peerId); } catch { card = null; }
    if (!card) return { level: null, implant: null, armorId: null };
    return { level: card.level, implant: card.implant, armorId: card.armor };
  }

  private updateTerminalScreen(): void {
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
  private resolveSeed(): number {
    const lobby = this.ctx.net?.lobby;
    if (lobby && lobby.seed !== null) return lobby.seed >>> 0;
    return (this.missionSeed ?? randomSeed()) >>> 0;
  }

  private launch(): void {
    const ctx = this.ctx;
    const net = ctx.net;
    const seed = this.resolveSeed();
    const planet = this.planet;
    if (planet === null) return;         // the pod gate should have caught this (server: `no_planet`)
    if (net?.lobby && net.isHost) {
      this.launched = true;
      // server → game:start {planet} → net emits game:newMission → teardown('mission')
      net.startGame(seed, 'raid', planet);
    } else if (!net?.lobby) {
      // the emitter sets the mode AND the planet before `game:newMission` (Phase 7 / 11 contract)
      ctx.missionMode = 'raid';
      ctx.missionPlanet = planet;
      ctx.bus.emit('game:newMission', { seed, mode: 'raid', planet });
    }
  }

  private tickCountdown(dt: number): void {
    const ctx = this.ctx;
    const net = ctx.net;
    const lobby = net?.lobby ?? null;
    const boarded = this.boardedSlot >= 0;
    let ready = boarded ? 1 : 0, total = 1, allReady = boarded;
    if (lobby) {
      const connected = lobby.players.filter((p) => p.connected);
      total = Math.max(1, connected.length);
      ready = connected.filter((p) => p.ready).length;
      allReady = boarded && !lobby.started && connected.length > 0 && ready === connected.length;
    }
    const authority = !lobby || (net?.isHost ?? false);

    if (allReady && this.countdown < 0 && !this.launched) {
      this.countdown = HUB_LAUNCH_COUNTDOWN;
      this.lastCountdownSecond = -1;
      ctx.bus.emit('audio:play', { id: 'ui_equip' });
    } else if (!allReady) {
      this.launched = false;
      if (this.countdown >= 0) { this.countdown = -1; if (lobby) ctx.bus.emit('ui:notify', { text: '발사 취소 — 승무원 대기', kind: 'warning' }); }
    }

    if (this.countdown >= 0) {
      this.countdown -= dt;
      const sec = Math.max(0, Math.ceil(this.countdown));
      if (sec !== this.lastCountdownSecond) {
        this.lastCountdownSecond = sec;
        // Clients mirror the host's countdown locally (same ready state, same length) so HUD/audio/chat react everywhere.
        ctx.bus.emit('hub:launchCountdown', { seconds: sec, ready, total });
        if (sec > 0) ctx.bus.emit('audio:play', { id: 'ui_click' });
      }
      if (this.countdown <= 0) {
        this.countdown = -1;
        if (authority) this.launch();
        return;
      }
    }

    // status line
    if (boarded) {
      if (this.countdown >= 0) this.status.set(String(Math.max(0, Math.ceil(this.countdown))), '발사 준비 완료', { count: true, progress: 1 - this.countdown / HUB_LAUNCH_COUNTDOWN });
      else if (lobby) this.status.set(`탑승 대기 중 (${ready}/${total})`, '슬롯에서 내리기', { keycap: 'E' });
      else this.status.set('발사 준비', '슬롯에서 내리기', { keycap: 'E' });
    } else if (lobby && net?.missionInProgress) {
      if (this.trainingRunning()) this.status.set(`훈련 진행 중 (${this.trainingCount()}명)`, '터미널에서 합류할 수 있습니다');
      else this.status.set('임무 진행 중', '발사 슬롯에 탑승하면 재투입됩니다');
    } else {
      this.status.hide();
    }
  }

  /* ── frame ─────────────────────────────────────────────────────────────── */
  update(dt: number, ctx: GameContext): void {
    this.menu.update(dt);
    this.wbMenu.update();
    this.ready.update(dt, ctx.time);
    // a card change inside the debounce window goes out as soon as it expires
    if (this.cardDirty) this.sendCrewCard(false);
    if (this.cutscene) {
      this.cutscene.update(dt);
      if (this.cutscene) {
        const d = this.cutscene.direction;
        this.status.set(d === 'dock' ? '도킹 절차 진행 중' : d === 'undock' ? '도킹 해제 중' : `${planetLabel(this.planet)} 항로 이동 중`, null);
      }
      return;
    }
    if (ctx.phase !== 'hub' || !this.interior) return;

    this.interior.update(dt, ctx.time);
    // 자동문 + 방 조명 follow the player (personal ship only)
    if (this.interior instanceof PersonalShip) {
      const pp = ctx.player?.position;
      this.interior.updateNear(dt, pp?.x ?? 0, pp?.z ?? 0);
    }
    this.furniture?.update(ctx.time);
    for (const pod of this.pods) pod.update(dt, ctx.time);
    this.trackRoom();

    // housing mode owns the input (cursor / place / rotate / recover / C / Esc) while active
    if (this.housingMode.active) { this.housingMode.update(dt); this.tickCountdown(dt); this.corpWasOpen = this.corpMenuOpen(); return; }

    // Esc: corp screen first, then the menus / un-board. It must **not** open the terminal any more — an Esc that
    // reaches nothing here is the 일시정지 메뉴 (owned by game/, Phase 8). E while boarded: un-board.
    const corpOpen = this.corpMenuOpen();
    if (ctx.input.wasPressed(Keys.MENU)) {
      // Whatever we handle here must be swallowed: game/ polls the same Escape later in the frame and would
      // otherwise open the 일시정지 메뉴 the instant a hub panel released its blocker (Phase 8).
      if (corpOpen) { this.ctx.meta?.closeCorpMenu(); ctx.input.consume(Keys.MENU); }
      else if (this.corpWasOpen) { ctx.input.consume(Keys.MENU); /* the corp screen's own Esc listener just closed it */ }
      else if (this.wbMenu.isOpen) { this.wbMenu.close(); ctx.input.consume(Keys.MENU); }
      else if (this.menu.isOpen) { this.menu.close(); ctx.input.consume(Keys.MENU); }
      // 분대원 장비 popup before the pod: the READY panel is modeless over the pod view (Phase 10)
      else if (this.ready.closePopup()) { ctx.input.consume(Keys.MENU); }
      else if (!this.uiBlocked() && this.boardedSlot >= 0) { this.leavePod(true); ctx.input.consume(Keys.MENU); }
    }
    this.corpWasOpen = corpOpen;
    if (this.boardedSlot >= 0 && !this.uiBlocked() && ctx.input.wasPressed(Keys.INTERACT) && ctx.time - this.boardedAt > UNBOARD_GRACE) {
      this.leavePod(true);
    }
    // M: 함선 관리 (housing's manage mode; the HUD draws the room list / furniture bar). Read `Keys.MAP` live.
    if (ctx.uiBlockers.size === 0 && !corpOpen && this.boardedSlot < 0 && ctx.input.wasPressed(Keys.MAP)) this.openShipManage();

    this.tickCountdown(dt);
  }

  /**
   * 함선 관리 (M in the ship): housing enters its manage mode from anywhere in the personal ship (no "stand in the
   * room" gate) and `HousingMode` takes the camera on `housing:shipManageChanged`. Refused in the shared ship.
   */
  openShipManage(): boolean {
    const ctx = this.ctx;
    if (ctx.phase !== 'hub' || this.cutscene || this.housingMode.active) return false;
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
