import * as THREE from 'three';
import type {
  GameContext, GameSystem, Interactable, ExtractionPointDef, PeerId, ExtractionMessage, ExtractionRequest, ExtractionSyncState,
} from '@/shared';
import { EXTRACTION_COUNTDOWN, PlayerFlags } from '@/shared';
import { ExtractionConsole } from './Console';
import { Dropship } from './Ship';
import { FlareColumn, DustRing } from './Particles';

const SHIP_INCOMING_AT = 12;      // seconds remaining when the ship starts its approach
const APPROACH_DURATION = 8;      // approach phase; descent (4.2 s) follows → touchdown ≈ 0 s
/** Host → clients countdown resync interval (seconds). Clients decrement locally in between. */
const NET_TICK_INTERVAL = 0.5;
/** Client: after the host reports touchdown, force-place the ship if it has not landed locally within this time. */
const NET_LAND_FALLBACK = 1.0;
/** Id used for the local player in the boarded set when there is no network id. */
const LOCAL_ID = 'local';

interface PadEntry {
  def: ExtractionPointDef;
  console: ExtractionConsole;
  interactableId: string;
}

/**
 * Extraction flow: pad consoles → countdown + flare → ship flight-in / landing → boarding → interior switch → liftoff.
 * Emits the `extraction:*` events; GameFlowSystem owns the phase transitions.
 *
 * Multiplayer (all gated on `ctx.isMultiplayer`, so single-player is untouched):
 *   - Authority (host): runs the flow exactly as single-player and mirrors every step to the others with
 *     `ExtractionMessage`s ('ex'); accepts `ExtractionRequest`s ('exq') from clients (activate / board / liftoff).
 *   - Client: builds the same pads (deterministic world), forwards console / switch interactions as requests,
 *     and applies the host's 'ex' messages (countdown resync every 0.5 s, ship approach, landing, boarding, liftoff).
 *   - Liftoff gate: every *required* player must be boarded — required = local player if alive + every remote
 *     player that is `connected && !stale && !isDead`.
 */
export class ExtractionSystem implements GameSystem {
  readonly name = 'extraction';
  private ctx!: GameContext;
  private pads: PadEntry[] = [];
  private ship: Dropship | null = null;
  private flare: FlareColumn | null = null;
  private dust: DustRing | null = null;
  private unsubs: Array<() => void> = [];
  private netUnsubs: Array<() => void> = [];
  /** Seed of the world the current pads were built for (guards against event-order races). */
  private padsSeed: number | null = null;

  private activePad: PadEntry | null = null;
  private countdown = 0;
  private counting = false;
  private shipCalled = false;
  private landed = false;
  /** Local player is inside the bay. */
  private boarded = false;
  private lifting = false;
  private doorsClosedEmitted = false;
  private lastBeepSecond = -1;
  private shipLandPos = new THREE.Vector3();
  private shipYaw = 0;
  private dir = new THREE.Vector3();

  /* ── multiplayer state ── */
  /** Host: every peer (incl. local) currently inside the bay. */
  private boardedPeers = new Set<PeerId>();
  private netTickAccum = 0;
  /** Client: latest `boarding` message from the host. */
  private clientBoardedCount = 0;
  private clientRequiredCount = 0;
  private clientReady = false;
  /** Client: > 0 while waiting for the local ship to touch down after the host's `shipLanded`. */
  private landFallbackTimer = -1;
  /** Scratch for required-player counting (host). */
  private requiredIds: PeerId[] = [];

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.ship = new Dropship();
    this.flare = new FlareColumn();
    this.dust = new DustRing();
    ctx.scene.add(this.ship.root, this.flare.group, this.dust.pool.points);

    this.unsubs.push(
      ctx.bus.on('world:ready', () => { this.buildPads(); this.ensureNetHooks(); }),
      ctx.bus.on('game:abort', () => { this.resetMission(true); this.unhookNet(); }),
      // NOTE: WorldSystem generates synchronously inside its own game:newMission handler, so world:ready
      // (and buildPads) has already run by the time this handler fires → keep pads that match the new seed.
      ctx.bus.on('game:newMission', () => this.resetMission(false)),
      // Single-player: the mission is over → let the flare die out. Multiplayer: the squad continues.
      ctx.bus.on('player:died', () => { if (!this.ctx.isMultiplayer) this.flare?.stop(); }),
      // Host: a peer left → its boarding entry is irrelevant; re-broadcast so clients' n/m updates.
      ctx.bus.on('net:peerLeft', ({ id }) => {
        if (!this.isHost()) return;
        this.boardedPeers.delete(id);
        if (this.landed) this.broadcastBoarding();
      }),
      // Client: once the hellpod has landed (deploying → playing) ask the host for the current extraction stage.
      // Harmless on a normal start (host answers `idle`); on a rejoin it rebuilds countdown / ship / boarding state.
      ctx.bus.on('game:phaseChanged', ({ phase, prev }) => {
        if (phase === 'playing' && prev === 'deploying' && this.isClient()) this.sendReq({ t: 'exq', ev: 'sync' });
      }),
    );
  }

  /* ── Multiplayer helpers ─────────────────────────────────────────────── */
  private isHost(): boolean { return this.ctx.isMultiplayer && this.ctx.isAuthority && !!this.ctx.net; }
  private isClient(): boolean { return this.ctx.isMultiplayer && !this.ctx.isAuthority && !!this.ctx.net; }
  private localId(): PeerId { return this.ctx.net?.localId ?? LOCAL_ID; }

  private sendEx(msg: ExtractionMessage): void {
    if (this.isHost()) this.ctx.net!.send(msg, 'others');
  }
  private sendReq(msg: ExtractionRequest): void {
    if (this.isClient()) this.ctx.net!.send(msg, 'host');
  }

  /** Subscribe to net messages once `ctx.net` exists (NetSystem may publish it after our init). */
  private ensureNetHooks(): void {
    const net = this.ctx.net;
    if (!net || this.netUnsubs.length > 0) return;
    this.netUnsubs.push(
      net.onMessage('exq', (msg, from) => this.onRequest(msg, from)),
      net.onMessage('ex', (msg, from) => this.onHostMessage(msg, from)),
    );
  }
  private unhookNet(): void {
    for (const u of this.netUnsubs) u();
    this.netUnsubs.length = 0;
  }

  /** Host: handle a client request. */
  private onRequest(msg: ExtractionRequest, from: PeerId): void {
    if (!this.isHost()) return;
    switch (msg.ev) {
      case 'activate': {
        if (this.ctx.phase !== 'playing' || this.activePad) return;
        const pad = this.pads.find((p) => p.def.id === msg.padId);
        if (pad) this.activate(pad);
        break;
      }
      case 'board': {
        const had = this.boardedPeers.has(from);
        if (msg.inside === had) return;
        if (msg.inside) this.boardedPeers.add(from); else this.boardedPeers.delete(from);
        this.broadcastBoarding();
        break;
      }
      case 'liftoff': {
        if (this.ctx.phase === 'shipLanded' && !this.lifting && this.landed && this.allRequiredBoarded()) this.liftoff();
        break;
      }
      case 'sync':
        // (Re)joining client asks for the full state → reply to that peer only.
        this.ctx.net!.send({ t: 'ex', ev: 'sync', state: this.buildSyncState() }, from);
        break;
    }
  }

  /** Host: snapshot of the current flow for a late / rejoining client. */
  private buildSyncState(): ExtractionSyncState {
    const stage: ExtractionSyncState['stage'] = this.lifting ? 'liftoff'
      : this.landed ? 'shipLanded'
      : this.shipCalled ? 'shipIncoming'
      : this.activePad ? 'countdown'
      : 'idle';
    return {
      stage,
      padId: this.activePad ? this.activePad.def.id : null,
      remaining: this.countdown,
      boarded: Array.from(this.boardedPeers),
      required: this.collectRequired(this.requiredIds).slice(),
    };
  }

  /**
   * Client: apply the host's full state (reply to `exq sync`). Runs each stage's normal entry path in order so
   * GameFlow sees the same `extraction:*` events (activated → shipLanded → liftoff) it would have seen live.
   */
  private applySyncState(state: ExtractionSyncState): void {
    if (state.stage === 'idle') return;
    if (this.activePad) {
      // Already following the live stream → only refresh the countdown / boarding numbers.
      if (this.counting) this.countdown = Math.max(0, state.remaining);
      this.applyBoarding(state.boarded, state.required);
      return;
    }
    const pad = this.pads.find((p) => p.def.id === state.padId);
    if (!pad) return;
    this.beginActivation(pad, EXTRACTION_COUNTDOWN);
    this.countdown = Math.max(0, state.remaining);
    if (state.stage === 'shipIncoming') {
      this.callShip();
    } else if (state.stage === 'shipLanded' || state.stage === 'liftoff') {
      this.forceLandNow();
      this.applyBoarding(state.boarded, state.required);
      if (state.stage === 'liftoff') this.liftoff(); // ship already leaving: we watch it go (not boarded → controls kept)
    }
    this.ctx.bus.emit('ui:notify', { text: '탈출 진행 상황 동기화됨', kind: 'info', duration: 2.5 });
  }

  /** Client: update the n/m boarding mirror (from `boarding` or `sync`). Returns true when the numbers changed. */
  private applyBoarding(boarded: PeerId[], required: PeerId[]): boolean {
    let n = 0;
    for (const id of required) if (boarded.includes(id)) n++;
    const changed = n !== this.clientBoardedCount || required.length !== this.clientRequiredCount;
    this.clientBoardedCount = n;
    this.clientRequiredCount = required.length;
    this.clientReady = required.length > 0 && n === required.length;
    return changed;
  }

  /** Client: mirror the host's flow. */
  private onHostMessage(msg: ExtractionMessage, from: PeerId): void {
    if (!this.isClient()) return;
    const hostId = this.ctx.net!.lobby?.hostId;
    if (hostId && from !== hostId) return;
    const ship = this.ship;
    if (!ship) return;
    switch (msg.ev) {
      case 'activated': {
        if (this.activePad) return;
        const pad = this.pads.find((p) => p.def.id === msg.padId);
        if (pad) this.beginActivation(pad, msg.duration);
        break;
      }
      case 'tick':
        if (this.counting) this.countdown = Math.max(0, msg.remaining);
        break;
      case 'shipIncoming':
        if (this.activePad && !this.shipCalled) this.callShip();
        break;
      case 'shipLanded':
        if (this.activePad && !this.landed && this.landFallbackTimer < 0) this.landFallbackTimer = NET_LAND_FALLBACK;
        break;
      case 'boarding': {
        const changed = this.applyBoarding(msg.boarded, msg.required);
        if (changed && this.landed) this.ctx.bus.emit('ui:notify', { text: `${this.clientBoardedCount}/${this.clientRequiredCount} 탑승`, kind: this.clientReady ? 'success' : 'info', duration: 2 });
        break;
      }
      case 'sync':
        if (msg.state && typeof msg.state === 'object' && Array.isArray(msg.state.boarded) && Array.isArray(msg.state.required)) {
          this.applySyncState(msg.state);
        }
        break;
      case 'liftoff':
        if (this.activePad && !this.lifting) {
          // The host may have landed the ship before we did (message loss / late join) — never miss the ride visuals.
          if (!this.landed) this.forceLandNow();
          this.liftoff();
        }
        break;
      case 'reset':
        this.resetMission(false);
        break;
    }
  }

  /** Host: required = local player if alive + every connected, fresh, alive remote player. */
  private collectRequired(out: PeerId[]): PeerId[] {
    out.length = 0;
    const ctx = this.ctx;
    if (!(ctx.player?.isDead ?? false)) out.push(this.localId());
    const net = ctx.net;
    if (net) {
      for (const r of net.getRemotePlayers()) {
        // Peers walking the shared ship (IN_HUB) are not in this mission and never block the liftoff.
        if (r.connected && !r.stale && !r.isDead && (r.flags & PlayerFlags.IN_HUB) === 0) out.push(r.id);
      }
    }
    return out;
  }

  private allRequiredBoarded(): boolean {
    const req = this.collectRequired(this.requiredIds);
    if (req.length === 0) return false;
    for (const id of req) if (!this.boardedPeers.has(id)) return false;
    return true;
  }

  private broadcastBoarding(notify = true): void {
    const required = this.collectRequired(this.requiredIds).slice();
    let n = 0;
    for (const id of required) if (this.boardedPeers.has(id)) n++;
    this.sendEx({ t: 'ex', ev: 'boarding', boarded: Array.from(this.boardedPeers), required });
    if (notify && this.landed) {
      this.ctx.bus.emit('ui:notify', { text: `${n}/${required.length} 탑승`, kind: n === required.length && n > 0 ? 'success' : 'info', duration: 2 });
    }
  }

  /** Liftoff switch readiness (single-player: local boarded; multiplayer: everyone required is boarded). */
  private liftoffReady(): boolean {
    if (!this.boarded || this.ctx.phase !== 'shipLanded' || this.lifting) return false;
    if (this.isClient()) return this.clientReady;
    if (this.isHost()) return this.allRequiredBoarded();
    return true;
  }

  private waitingPrompt(): string {
    if (this.isClient()) return `탑승 대기 중 (${this.clientBoardedCount}/${this.clientRequiredCount})`;
    const req = this.collectRequired(this.requiredIds);
    let n = 0;
    for (const id of req) if (this.boardedPeers.has(id)) n++;
    return `탑승 대기 중 (${n}/${req.length})`;
  }

  /* ── Pads / consoles ─────────────────────────────────────────────────── */
  private buildPads(): void {
    this.clearPads();
    const world = this.ctx.world;
    if (!world) return;
    this.padsSeed = world.seed;
    for (const def of world.getExtractionPoints()) {
      const dir = new THREE.Vector3(Math.sin(def.yaw), 0, Math.cos(def.yaw));
      // def.position.y is the top of the (flat) landing platform — use it directly.
      const pos = def.position.clone().addScaledVector(dir, 5);
      const console = new ExtractionConsole(pos, def.yaw);
      this.ctx.scene.add(console.group);
      const id = `extract_${def.id}`;
      const interactable: Interactable = {
        id,
        position: console.interactPoint,
        radius: 2.6,
        holdTime: 1.2,
        getPrompt: () => (this.ctx.phase === 'playing' ? '탈출 신호 전송 (E 길게)' : null),
        canInteract: () => this.ctx.phase === 'playing' && !this.activePad,
        interact: () => {
          // Client: ask the host; the host's `activated` message drives our visuals.
          if (this.isClient()) this.sendReq({ t: 'exq', ev: 'activate', padId: entry.def.id });
          else this.activate(entry);
        },
      };
      const entry: PadEntry = { def, console, interactableId: id };
      this.ctx.interactables.register(interactable);
      this.pads.push(entry);
    }
  }

  private clearPads(): void {
    for (const p of this.pads) {
      this.ctx.interactables.unregister(p.interactableId);
      p.console.dispose();
    }
    this.pads.length = 0;
    this.padsSeed = null;
  }

  /* ── Activation / countdown ──────────────────────────────────────────── */
  /** Authority path (single-player / host). */
  private activate(pad: PadEntry): void {
    if (this.activePad) return;
    this.beginActivation(pad, EXTRACTION_COUNTDOWN);
    this.sendEx({ t: 'ex', ev: 'activated', padId: pad.def.id, duration: EXTRACTION_COUNTDOWN });
  }

  /** Shared visuals/events for activation — host and client alike. */
  private beginActivation(pad: PadEntry, duration: number): void {
    this.activePad = pad;
    this.counting = true;
    this.countdown = duration;
    this.shipCalled = false;
    this.landed = false;
    this.lastBeepSecond = -1;
    this.netTickAccum = 0;
    pad.console.setState('active');
    for (const other of this.pads) if (other !== pad) other.console.setState('off');

    const center = pad.def.position.clone(); // platform top at pad center
    this.dir.set(Math.sin(pad.def.yaw), 0, Math.cos(pad.def.yaw));
    this.shipYaw = pad.def.yaw;
    // Ship root sits 5 m back from the pad center so the rear ramp opening lands at the center, facing the console.
    this.shipLandPos.copy(center).addScaledVector(this.dir, -5);
    this.shipLandPos.y = center.y;

    // Flare rises from the pad center (between console and ship landing spot).
    this.flare!.start(center.clone().addScaledVector(this.dir, 2.5));

    // EnemySystem subscribes to extraction:activated / extraction:liftoff itself (start/stop waves).
    this.ctx.bus.emit('extraction:activated', { pointId: pad.def.id, position: center, duration });
    this.ctx.bus.emit('audio:play', { id: 'extract_activate', position: pad.console.interactPoint });
  }

  private callShip(): void {
    this.shipCalled = true;
    this.ship!.startApproach(this.shipLandPos, this.shipYaw, APPROACH_DURATION);
    this.ctx.bus.emit('extraction:shipIncoming', { position: this.shipLandPos.clone(), eta: SHIP_INCOMING_AT });
    this.ctx.bus.emit('audio:play', { id: 'ship_approach', position: this.shipLandPos });
    this.sendEx({ t: 'ex', ev: 'shipIncoming', eta: SHIP_INCOMING_AT });
  }

  /** Client fallback: place the ship on the pad and run the touchdown path. */
  private forceLandNow(): void {
    this.landFallbackTimer = -1;
    if (this.landed || !this.ship) return;
    this.shipCalled = true;
    if (this.ship.forceLand(this.shipLandPos, this.shipYaw)) this.onShipLanded();
  }

  private onShipLanded(): void {
    this.landed = true;
    this.counting = false;
    this.landFallbackTimer = -1;
    this.flare!.stop();
    const pos = this.shipLandPos.clone();
    this.ctx.bus.emit('camera:shake', { intensity: 0.9, duration: 0.7 });
    this.ctx.bus.emit('audio:play', { id: 'ship_land', position: pos });
    this.ctx.bus.emit('extraction:shipLanded', { position: pos });
    this.sendEx({ t: 'ex', ev: 'shipLanded' });
    // Seed the clients' n/m display right away (no toast for this one).
    if (this.isHost()) this.broadcastBoarding(false);

    const ship = this.ship!;
    const sw: Interactable = {
      id: 'ship_liftoff_switch',
      position: ship.interiorSwitchWorld,
      radius: 2.4,
      holdTime: 1.0,
      getPrompt: () => {
        if (!this.boarded || this.ctx.phase !== 'shipLanded') return null;
        if (this.liftoffReady()) return '이륙 스위치 작동 (E 길게)';
        return this.ctx.isMultiplayer ? this.waitingPrompt() : null;
      },
      canInteract: () => this.liftoffReady(),
      interact: () => {
        if (this.isClient()) this.sendReq({ t: 'exq', ev: 'liftoff' });
        else this.liftoff();
      },
    };
    this.ctx.interactables.register(sw);
  }

  private liftoff(): void {
    if (this.lifting) return;
    this.lifting = true;
    this.doorsClosedEmitted = false;
    const ship = this.ship!;
    const player = this.ctx.player;
    ship.beginLiftoff();
    this.ctx.interactables.unregister('ship_liftoff_switch');
    // Multiplayer: only a boarded, living local player rides along — anyone left outside keeps their controls.
    const rideAlong = !this.ctx.isMultiplayer || (this.boarded && !(player?.isDead ?? false));
    if (player && rideAlong) {
      player.setControlsEnabled(false);
      player.attachTo(ship.root);
    }
    this.ctx.bus.emit('extraction:liftoff', { position: ship.position.clone() });
    this.ctx.bus.emit('audio:play', { id: 'ship_liftoff', position: ship.position });
    this.sendEx({ t: 'ex', ev: 'liftoff' });
  }

  /* ── Frame update ────────────────────────────────────────────────────── */
  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    for (const p of this.pads) p.console.update(dt);
    this.flare?.update(dt);
    this.dust?.update(dt);
    const ship = this.ship;
    if (!ship) return;

    if (this.counting && ctx.isGameplayPhase()) {
      this.countdown = Math.max(0, this.countdown - dt);
      ctx.bus.emit('extraction:tick', { remaining: this.countdown, total: EXTRACTION_COUNTDOWN });
      if (this.countdown <= 10 && this.countdown > 0) {
        const sec = Math.ceil(this.countdown);
        if (sec !== this.lastBeepSecond) {
          this.lastBeepSecond = sec;
          ctx.bus.emit('audio:play', { id: 'countdown_beep', volume: sec <= 3 ? 1 : 0.7, pitch: sec <= 3 ? 1.25 : 1 });
        }
      }
      // Only the authority calls the ship; clients wait for `shipIncoming`.
      if (ctx.isAuthority && !this.shipCalled && this.countdown <= SHIP_INCOMING_AT) this.callShip();
      if (this.isHost()) {
        this.netTickAccum += dt;
        if (this.netTickAccum >= NET_TICK_INTERVAL) {
          this.netTickAccum = 0;
          this.sendEx({ t: 'ex', ev: 'tick', remaining: this.countdown });
        }
      }
    }

    // Client: the host reported touchdown but our ship is still in the air → snap it down after a grace period.
    if (this.landFallbackTimer >= 0) {
      this.landFallbackTimer -= dt;
      if (this.landFallbackTimer < 0) this.forceLandNow();
    }

    const ev = ship.update(dt);
    if (ev.touchdown && !this.landed) this.onShipLanded();
    if (ev.rampClosed && this.lifting && !this.doorsClosedEmitted) {
      this.doorsClosedEmitted = true;
      ctx.bus.emit('extraction:doorsClosed', {});
    }

    // Dust while descending near the ground and during the first seconds of liftoff.
    if (ship.descending) {
      const h = ship.position.y - ship.getGroundY();
      const strength = THREE.MathUtils.clamp(1 - h / 18, 0, 1);
      this.dust!.emit(ship.position, ship.getGroundY(), strength, dt);
      if (h < 6) ctx.bus.emit('camera:shake', { intensity: 0.08 * (1 - h / 6), duration: 0.1 });
    } else if (ship.liftingOff) {
      const t = ship.liftoffTime;
      const h = ship.position.y - ship.getGroundY();
      if (t > 1.0 && h < 20) this.dust!.emit(this.shipLandPos, ship.getGroundY(), THREE.MathUtils.clamp(1 - h / 20, 0, 1), dt);
      if (t > 1.2) ctx.bus.emit('camera:shake', { intensity: 0.12, duration: 0.1 });
    }

    // Boarding volume (local player)
    const player = ctx.player;
    if (player && this.landed && !this.lifting && ctx.phase === 'shipLanded') {
      const inside = ship.containsWorldPoint(player.position);
      if (inside && !this.boarded) {
        this.boarded = true;
        player.setShipInterior(ship.getInteriorBounds());
        ctx.bus.emit('extraction:boarded', {});
        this.onLocalBoardingChanged(true);
      } else if (!inside && this.boarded) {
        this.boarded = false;
        player.setShipInterior(null);
        this.onLocalBoardingChanged(false);
      }
    }
  }

  private onLocalBoardingChanged(inside: boolean): void {
    if (this.isHost()) {
      if (inside) this.boardedPeers.add(this.localId()); else this.boardedPeers.delete(this.localId());
      this.broadcastBoarding();
    } else if (this.isClient()) {
      this.sendReq({ t: 'exq', ev: 'board', inside });
    }
  }

  /* ── Reset ───────────────────────────────────────────────────────────── */
  private resetMission(clearPads: boolean): void {
    // Tell clients first (no-op outside a hosted session).
    if (this.activePad || this.landed || this.lifting) this.sendEx({ t: 'ex', ev: 'reset' });
    const world = this.ctx.world;
    const padsAreCurrent = !!world && world.ready && this.padsSeed === world.seed;
    if (clearPads || !padsAreCurrent) this.clearPads();
    else for (const p of this.pads) p.console.setState('idle');
    this.ctx.interactables.unregister('ship_liftoff_switch');
    this.ship?.reset();
    this.flare?.reset();
    this.dust?.reset();
    this.activePad = null;
    this.counting = false;
    this.countdown = 0;
    this.shipCalled = false;
    this.landed = false;
    this.lifting = false;
    this.doorsClosedEmitted = false;
    this.lastBeepSecond = -1;
    this.boardedPeers.clear();
    this.netTickAccum = 0;
    this.clientBoardedCount = 0;
    this.clientRequiredCount = 0;
    this.clientReady = false;
    this.landFallbackTimer = -1;
    if (this.boarded) {
      this.ctx.player?.setShipInterior(null);
      this.boarded = false;
    }
    // Player detachment / control re-enable is handled by PlayerSystem on respawn; be defensive anyway.
    this.ctx.player?.attachTo(null);
    this.ctx.player?.setControlsEnabled(true);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unhookNet();
    this.clearPads();
    this.ctx.interactables.unregister('ship_liftoff_switch');
    this.ship?.dispose(); this.ship = null;
    this.flare?.dispose(); this.flare = null;
    this.dust?.dispose(); this.dust = null;
  }
}
