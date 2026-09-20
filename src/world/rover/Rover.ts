/**
 * src/world/rover/Rover.ts — the rover **vehicle · state machine · turret · boarding · sync** (owner: R2, 2026-09-13).
 *
 * The rules' source is the rover section of `shared/types.ts`. What is left here is **lifecycle · state machine · the boarding / fare flow · multiplayer**;
 * geometry (`parts/Body`) · FX (`parts/Fx`) · turret (`parts/Turret`) · ramming (`parts/Impact`) · exit spots (`parts/Exits`) all moved down into parts.
 *
 * ## State machine (host-authoritative — in single player one is one's own host)
 *   stopped ──(dwell `ROVER_DWELL_S`, paused while riders are aboard)──▶ patrol ──(next station reached)──▶ stopped
 *   stopped ──(a rider pays)──▶ departing ──(`ROVER_DEPART_GRACE_S`)──▶ trip ──(destination reached → all ejected)──▶ stopped
 *   any state ──(hp 0)──▶ destroyed (for the rest of the raid — the wreck stays and riders get out where it fell)
 * A change of travel direction is turned on the spot while standing (`ROVER_TURN_RATE`) — a paid trip the other way turns within the departure grace.
 * The motion curve (acceleration · braking · turning) runs through **the same function** (`motion`) on host and client, and a client is corrected by the host's `s`.
 *
 * ## Wire (`RoverMessage` / `RoverRequest`; the receiving side accepts only what the lobby host sent)
 * - Host → everyone: `state` (every `ROVER_NET_INTERVAL` and on every change) · `trip` (the fare is committed — only `by` pays credits) · `eject` (arrival · destruction) · `fire`.
 * - Client → host: `board` · `exit` · `trip` · `sync`. The host checks lobby membership · alive · distance · state and sends a `reply`.
 * - Late joins (`flow rejoined`) and `net:hostChanged` work like the tram's. A new host carries on from the last state it received.
 *
 * ## Riders
 * The list is held by PeerId (`'local'` in single player) and shown outside with this client's own id swapped to
 * `'local'` (`RoverVehicleDef.riders`). The body · camera · damage exemption are player's `setRoverRide`; this file
 * only hands over the binding (`RoverRideBinding`). The host drops riders who left the lobby, disconnected or died, every frame.
 */
import * as THREE from 'three';
import {
  HAZARD_DPS, HAZARD_TICK_S,
  ROVER_ACCEL, ROVER_ALIGN_EPS, ROVER_BOARD_CHECK_RANGE, ROVER_BOARD_HOLD_S, ROVER_BOARD_RANGE, ROVER_BRAKE,
  ROVER_CAMERA_DISTANCE, ROVER_DEPART_GRACE_S, ROVER_DWELL_S, ROVER_HALF_LENGTH, ROVER_HALF_WIDTH,
  ROVER_HAZARD_DAMAGE_MUL, ROVER_HEIGHT, ROVER_HP, ROVER_NET_INTERVAL, ROVER_PATROL_SPEED, ROVER_SEATS, ROVER_SNAP_M,
  ROVER_STATES, ROVER_TRIP_SPEED, ROVER_TURN_RATE,
  formatCreditReason,
  type GameContext, type PeerId, type RoverMessage, type RoverRef, type RoverRequest, type RoverRideBinding,
  type RoverRouteDef, type RoverState, type RoverVehicleDef, type RoverWire,
} from '@/shared';
import type { BuildCtx } from '../build';
import type { SpatialHash } from '../SpatialHash';
import type { Terrain } from '../Terrain';
import {
  angleDelta, forwardDistance, makeRoverPath, roverFareFor, routeDelta, sampleRoute, shortestTrip, wrapAngle, wrapRouteS,
  type RoverPath,
} from './model';
import {
  applyRoverWreckLook, buildRoverBody, placeRoverBody, spinRoverWheels, tiltRoverBody, type RoverBody,
} from './parts/Body';
import { pickExitSpots } from './parts/Exits';
import { RoverFx } from './parts/Fx';
import { updateRoverImpacts } from './parts/Impact';
import { applyRemoteShot, makeTurretState, updateTurretLogic, updateTurretVisual } from './parts/Turret';

/** The boarding interaction id — a constant, because there is one vehicle per raid. */
const BOARD_ID = 'rover:board';
/** Heights above the road surface (m) of the seat (a rider's feet) · the orbit camera focus · the boarding interaction spot. Framing, not balance numbers. */
const SEAT_UP = 0.6;
const FOCUS_UP = 0.6;
const HATCH_UP = 1.2;
/** The minimum speed just before arrival (m/s) — so the braking curve does not converge on 0 and never quite arrive. */
const ARRIVE_CREEP = 1;
/** How fast the body follows the terrain tilt (1/s) · the maximum tilt (rad). */
const TILT_SMOOTH = 5;
const TILT_MAX = 0.35;
/** The fore-aft and side-to-side sample distances the tilt is measured over (m). */
const TILT_SAMPLE_L = 2.6;
const TILT_SAMPLE_W = 1.3;
/** After a state change, broadcasts are gathered for this long (seconds) and sent once. */
const LATE_SEND_S = 0.1;
/** Client: after this long (seconds) missing from the host's list, it releases its own ride (against a lost message or a host transfer). */
const RECONCILE_S = 1.5;
/** After this long (seconds) with no answer to a fare request, it can be pressed again. */
const TRIP_PENDING_S = 3;

export class Rover {
  readonly group = new THREE.Group();
  private game: GameContext | null = null;
  private hash: SpatialHash | null = null;
  private terrain: Terrain | null = null;
  private route: RoverRouteDef | null = null;
  private path: RoverPath | null = null;
  private body: RoverBody | null = null;
  private fx: RoverFx | null = null;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private built = false;
  private netHooked = false;
  private readonly unsubs: Array<() => void> = [];

  private readonly def: RoverVehicleDef = {
    position: new THREE.Vector3(), yaw: 0, state: 'stopped', s: 0, dir: 1,
    hp: ROVER_HP, maxHp: ROVER_HP, stationId: null, targetId: null, timer: 0, riders: [],
  };
  /** The index of the station it stands at (stopped · departing), else −1. */
  private stationIdx = -1;
  /** departing · trip = the destination, patrol = the next station, otherwise −1. */
  private targetIdx = -1;
  private speed = 0;
  private speedMul = 1;
  private riderNet: string[] = [];
  private revealed = false;
  private readonly hitUntil = new Map<string, number>();
  private readonly turret = makeTurretState();
  private netTimer = 0;
  private lastSend = -Infinity;
  private dirty = false;
  private hazardTimer = 0;
  /** Client: the arc position the host gave (advanced by dead reckoning). */
  private targetS = 0;
  /** Client: has the first `state` arrived (the first apply raises no events). */
  private synced = false;
  private rid = 0;
  private pendingTrip = -1;
  private pendingTripAt = -Infinity;
  private boardedAt = -Infinity;
  private aboardSeenAt = -Infinity;
  private pitch = 0;
  private roll = 0;

  private readonly seat = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly hatch = new THREE.Vector3();
  private readonly binding: RoverRideBinding;
  private readonly refImpl: RoverRef;

  // scratch
  private readonly sPos = new THREE.Vector3();
  private readonly sTan = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly muzzle = new THREE.Vector3();
  private readonly fireFrom = new THREE.Vector3();
  private readonly fireTo = new THREE.Vector3();

  constructor() {
    this.group.name = 'Rover';
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.binding = {
      seat: this.seat,
      focus: this.focus,
      get yaw(): number { return self.def.yaw; },
      cameraDistance: ROVER_CAMERA_DISTANCE,
      get canExit(): boolean { return self.exitAllowed(); },
      lockedPrompt: '이동 중 — 하차 불가',
      requestExit: () => self.requestExit(),
    };
    this.refImpl = {
      get route(): RoverRouteDef { return self.route as RoverRouteDef; },
      vehicle: this.def,
      get stationsRevealed(): boolean { return self.revealed; },
      get localAboard(): boolean { return self.localAboard; },
      isStationSwallowed: (id) => self.swallowed(self.indexOf(id)),
      tripDistance: (id) => self.tripDistanceTo(self.indexOf(id)),
      fareTo: (id) => { const d = self.tripDistanceTo(self.indexOf(id)); return d === null ? null : roverFareFor(d); },
      tripBlock: (id) => self.tripBlock(self.indexOf(id)),
      requestTrip: (id) => self.requestTrip(self.indexOf(id)),
      get targetable(): boolean { return self.built && self.def.state !== 'destroyed'; },
      halfLength: ROVER_HALF_LENGTH,
      halfWidth: ROVER_HALF_WIDTH,
      height: ROVER_HEIGHT,
      damage: (amount, from) => self.damage(amount, from),
    };
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  attach(ctx: GameContext): void {
    this.game = ctx;
    this.unsubs.push(ctx.bus.on('cheat:rover', ({ action, value }) => this.cheat(action, value)));
    this.ensureNet();
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netHooked = false;
    this.game = null;
  }

  build(route: RoverRouteDef, bctx: BuildCtx): void {
    if (this.built) this.dispose();
    const game = this.game;
    if (route.stations.length < 2 || route.points.length < 3) return;
    this.hash = bctx.hash;
    this.terrain = bctx.terrain;
    this.route = route;
    const path = makeRoverPath(route.points.map((p) => p.clone()));
    this.path = path;

    const rng = bctx.rng.fork('roverVehicle');
    const n = route.stations.length;
    this.stationIdx = rng.int(0, n - 1);
    this.targetIdx = -1;
    const d = this.def;
    d.s = route.stations[this.stationIdx].s;
    d.state = 'stopped';
    d.dir = 1;
    d.hp = ROVER_HP;
    d.maxHp = ROVER_HP;
    d.timer = ROVER_DWELL_S;
    this.riderNet = [];
    d.riders = [];
    this.syncIds();
    this.revealed = false;
    this.speed = 0;
    this.speedMul = 1;
    this.hitUntil.clear();
    this.netTimer = 0;
    this.lastSend = -Infinity;
    this.dirty = false;
    this.hazardTimer = 0;
    this.targetS = d.s;
    this.synced = false;
    this.pendingTrip = -1;
    this.boardedAt = -Infinity;
    this.aboardSeenAt = -Infinity;

    this.body = buildRoverBody(bctx.hash, rng, this.geos, this.mats);
    this.group.add(this.body.root);
    this.fx = new RoverFx(this.group, this.geos, this.mats);

    sampleRoute(path, d.s, this.sPos, this.sTan);
    d.yaw = Math.atan2(this.sTan.z, this.sTan.x);
    this.turret.worldYaw = d.yaw;
    this.turret.targetId = null;
    this.turret.aimUntil = -Infinity;
    this.place(0, true);
    bctx.root.add(this.group);
    this.built = true;

    if (game) this.registerBoard(game);
    this.ensureNet();
    this.requestSync();
  }

  dispose(): void {
    const game = this.game;
    if (this.built && this.boardedAt > -Infinity && game?.player?.roverRide) this.releaseLocal(null);
    game?.interactables.unregister(BOARD_ID);
    if (this.body && this.hash) this.hash.remove(this.body.hullEntry);
    this.fx?.dispose();
    this.fx = null;
    this.body = null;
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.geos = [];
    this.mats = [];
    this.group.clear();
    this.group.removeFromParent();
    this.route = null;
    this.path = null;
    this.hash = null;
    this.terrain = null;
    this.riderNet = [];
    this.def.riders = [];
    this.built = false;
  }

  /** The `RoverRef` when there is a vehicle, else null. */
  get ref(): RoverRef | null { return this.built && this.route ? this.refImpl : null; }

  /* ── per-frame ─────────────────────────────────────────────────────── */

  update(dt: number, _t: number): void {
    const game = this.game, body = this.body, fx = this.fx;
    if (!this.built || !game || !body || !fx || !this.path || !this.route) return;
    fx.update(dt);
    if (this.def.state === 'destroyed') return;
    const host = this.isHost;
    if (host) this.hostTick(dt, game); else this.clientTick(dt);
    if (this.destroyed) return;   // hostTick may have destroyed it (re-read the narrowed type)

    this.motion(dt, host);
    this.place(dt, false);
    const now = game.time;
    updateTurretVisual(this.turret, body, this.def.yaw, now, dt);
    const moving = this.def.state === 'patrol' || this.def.state === 'trip';
    if (host && moving && game.isGameplayPhase()) updateTurretLogic(game, this.turret, body, dt, now, this.onFire);
    updateRoverImpacts(game, this.def, this.speed, this.hitUntil, this.def.riders);

    if (host) {
      this.hazardTick(dt, game);
      if (this.destroyed) return;
      this.pruneRiders(game);
      this.broadcastTick(dt, game);
    } else {
      this.reconcileLocal(game);
    }
  }

  /** Host: the dwell and departure-grace timers. */
  private hostTick(dt: number, game: GameContext): void {
    const d = this.def;
    if (d.state === 'stopped') {
      if (this.riderNet.length === 0) {
        d.timer = Math.max(0, d.timer - dt);
        if (d.timer <= 0 && game.isGameplayPhase()) this.startPatrol();
      }
    } else if (d.state === 'departing') {
      d.timer = Math.max(0, d.timer - dt);
      if (d.timer <= 0) this.setState('trip');
    }
  }

  /** Client: the display timer, plus correction by the host's arc position (advanced by dead reckoning, then pulled in). */
  private clientTick(dt: number): void {
    const d = this.def, path = this.path;
    if (!path) return;
    if ((d.state === 'stopped' && this.riderNet.length === 0) || d.state === 'departing') d.timer = Math.max(0, d.timer - dt);
    if (d.state !== 'patrol' && d.state !== 'trip') return;
    this.targetS = wrapRouteS(path, this.targetS + d.dir * this.speed * dt);
    const delta = routeDelta(path, d.s, this.targetS);
    if (Math.abs(delta) > ROVER_SNAP_M) d.s = this.targetS;
    else d.s = wrapRouteS(path, d.s + delta * Math.min(1, dt * 4));
  }

  /** Acceleration · braking · turning on the spot · travel (the same curve on host and client). Only the host judges arrival. */
  private motion(dt: number, host: boolean): void {
    const d = this.def, path = this.path, route = this.route;
    if (!path || !route) return;
    const st = d.state;
    sampleRoute(path, d.s, this.sPos, this.sTan);
    const tanYaw = Math.atan2(this.sTan.z, this.sTan.x);
    const desired = d.dir < 0 ? tanYaw + Math.PI : tanYaw;
    const moving = st === 'patrol' || st === 'trip';
    const diff = angleDelta(d.yaw, desired);
    if (st === 'departing' || moving) {
      if (this.speed > 0.5) d.yaw = wrapAngle(d.yaw + diff * Math.min(1, dt * 6));
      else { const step = ROVER_TURN_RATE * dt; d.yaw = wrapAngle(d.yaw + Math.max(-step, Math.min(step, diff))); }
    }
    if (!moving || this.targetIdx < 0) { this.speed = 0; return; }
    if (this.speed <= 0.5 && Math.abs(diff) > ROVER_ALIGN_EPS) { this.speed = 0; return; }

    const targetS = route.stations[this.targetIdx].s;
    const remaining = d.dir > 0 ? forwardDistance(path, d.s, targetS) : forwardDistance(path, targetS, d.s);
    const mul = this.speedMul;
    const vmax = (st === 'trip' ? ROVER_TRIP_SPEED : ROVER_PATROL_SPEED) * mul;
    const brakeV = Math.sqrt(2 * ROVER_BRAKE * mul * remaining);
    this.speed = Math.min(vmax, this.speed + ROVER_ACCEL * mul * dt, Math.max(ARRIVE_CREEP, brakeV));
    const step = Math.min(this.speed * dt, remaining);
    d.s = wrapRouteS(path, d.s + d.dir * step);
    if (this.body) spinRoverWheels(this.body, step);
    if (host && remaining - step <= 0.02) this.arrive();
  }

  /** Places the body · collider · tilt · seat / focus / boarding spot at the current `s`. */
  private place(dt: number, snap: boolean): void {
    const body = this.body, path = this.path, d = this.def;
    if (!body || !path) return;
    sampleRoute(path, d.s, this.sPos, this.sTan);
    const x = this.sPos.x, y = this.sPos.y, z = this.sPos.z;
    d.position.set(x, y, z);
    placeRoverBody(body, this.hash, x, y, z, d.yaw);
    const terrain = this.terrain;
    if (terrain) {
      const c = Math.cos(d.yaw), s = Math.sin(d.yaw);
      const hf = terrain.getHeightAt(x + c * TILT_SAMPLE_L, z + s * TILT_SAMPLE_L);
      const hb = terrain.getHeightAt(x - c * TILT_SAMPLE_L, z - s * TILT_SAMPLE_L);
      const hp = terrain.getHeightAt(x - s * TILT_SAMPLE_W, z + c * TILT_SAMPLE_W);
      const hm = terrain.getHeightAt(x + s * TILT_SAMPLE_W, z - c * TILT_SAMPLE_W);
      const tp = Math.max(-TILT_MAX, Math.min(TILT_MAX, Math.atan2(hf - hb, TILT_SAMPLE_L * 2)));
      const tr = Math.max(-TILT_MAX, Math.min(TILT_MAX, Math.atan2(hp - hm, TILT_SAMPLE_W * 2)));
      const k = snap ? 1 : Math.min(1, dt * TILT_SMOOTH);
      this.pitch += (tp - this.pitch) * k;
      this.roll += (tr - this.roll) * k;
      tiltRoverBody(body, this.pitch, this.roll);
    }
    this.seat.set(x, y + SEAT_UP, z);
    this.focus.set(x, y + ROVER_HEIGHT + FOCUS_UP, z);
    this.hatch.set(x, y + HATCH_UP, z);
    body.root.updateMatrixWorld(true);
  }

  /* ── State transitions (every client raises the same events) ───────────── */

  private setState(next: RoverState): void {
    const prev = this.def.state;
    this.syncIds();
    if (prev === next) return;
    this.def.state = next;
    this.syncIds();
    this.dirty = true;
    this.onTransition(prev, next);
  }

  private onTransition(prev: RoverState, next: RoverState): void {
    const game = this.game;
    if (!game) return;
    const d = this.def;
    game.bus.emit('rover:state', { state: next, stationId: d.stationId, targetId: d.targetId });
    const wasStill = prev === 'stopped' || prev === 'departing';
    if ((next === 'patrol' || next === 'trip') && wasStill) {
      game.bus.emit('rover:departed', { trip: next === 'trip', targetId: d.targetId });
      if (this.localAboard) game.bus.emit('rover:destinationSelect', { open: false });
    }
    if (next === 'stopped' && (prev === 'patrol' || prev === 'trip')) {
      game.bus.emit('rover:arrived', { stationId: d.stationId ?? '', trip: prev === 'trip' });
    }
    if (next === 'destroyed') this.onDestroyed(true);
  }

  private syncIds(): void {
    const st = this.route?.stations;
    this.def.stationId = st && this.stationIdx >= 0 ? st[this.stationIdx]?.id ?? null : null;
    this.def.targetId = st && this.targetIdx >= 0 ? st[this.targetIdx]?.id ?? null : null;
  }

  private startPatrol(): void {
    const route = this.route;
    if (!route || this.stationIdx < 0) return;
    this.targetIdx = (this.stationIdx + 1) % route.stations.length;
    this.stationIdx = -1;
    this.def.dir = 1;
    this.def.timer = 0;
    this.setState('patrol');
  }

  /** Host: the destination (`targetIdx`) is reached. On a paid trip everyone is ejected. */
  private arrive(): void {
    const route = this.route, d = this.def;
    const idx = this.targetIdx;
    if (!route || idx < 0) return;
    const trip = d.state === 'trip';
    d.s = route.stations[idx].s;
    this.speed = 0;
    this.stationIdx = idx;
    this.targetIdx = -1;
    d.timer = ROVER_DWELL_S;
    this.setState('stopped');
    if (trip) this.ejectAll('arrived');
    this.sendState();
  }

  /** Every client: the destruction FX and the wreck look. `explode` false = a late joiner received an already broken vehicle. */
  private onDestroyed(explode: boolean): void {
    const game = this.game, body = this.body, fx = this.fx, d = this.def;
    this.speed = 0;
    this.targetIdx = -1;
    this.syncIds();
    if (body) {
      applyRoverWreckLook(body);
      tiltRoverBody(body, this.pitch - 0.05, this.roll + 0.08);
      body.root.updateMatrixWorld(true);
    }
    if (fx) {
      if (explode) fx.explode(d.position);
      fx.setWreckSmoke(d.position);
    }
    if (game) {
      if (explode) game.bus.emit('rover:destroyed', { position: d.position.clone() });
      // A rider who missed the eject message does not stay inside the car either
      if (game.player?.roverRide && this.boardedAt > -Infinity) {
        this.releaseLocal(pickExitSpots(game.world, d, 1)[0] ?? null);
      }
    }
  }

  /* ── Riders ─────────────────────────────────────────────────────────── */

  private get isHost(): boolean {
    const c = this.game;
    return !c?.isMultiplayer || !c.net || c.net.isHost;
  }

  private get isMpClient(): boolean {
    const c = this.game;
    return !!c?.isMultiplayer && !!c.net && !c.net.isHost;
  }

  /** The id that points at this client in the rider list (multiplayer = its own PeerId, single player = `'local'`). */
  private get selfId(): string {
    const c = this.game;
    return c?.isMultiplayer && c.net?.localId ? c.net.localId : 'local';
  }

  private get localAboard(): boolean { return this.riderNet.includes(this.selfId); }

  private get destroyed(): boolean { return this.def.state === 'destroyed'; }

  private setRiders(list: string[], emit = true): void {
    const old = this.riderNet;
    const self = this.selfId;
    this.riderNet = list;
    this.def.riders = list.map((id) => (id === self ? 'local' : id));
    if (list.includes(self) && this.game) this.aboardSeenAt = this.game.time;
    const game = this.game;
    if (!emit || !game) return;
    for (const id of list) {
      if (old.includes(id)) continue;
      const local = id === self;
      game.bus.emit('rover:boarded', { by: local ? 'local' : id, name: this.nameOf(id), local, aboard: true });
      // 2026-09-14 (NPC quest interact): the local player boarded — the host has confirmed it in the rider list, so a client is exact too
      if (local) game.bus.emit('world:interacted', { kind: 'rover', id: BOARD_ID });
    }
    for (const id of old) {
      if (list.includes(id)) continue;
      const local = id === self;
      game.bus.emit('rover:boarded', { by: local ? 'local' : id, name: this.nameOf(id), local, aboard: false });
    }
    this.dirty = true;
  }

  private nameOf(id: string): string {
    const net = this.game?.net;
    if (id === this.selfId) return net?.playerName || '나';
    return net?.getLobbyPlayer(id as PeerId)?.name ?? net?.getRemotePlayer(id as PeerId)?.name ?? '분대원';
  }

  private reveal(): void {
    if (this.revealed) return;
    this.revealed = true;
    this.dirty = true;
    this.game?.bus.emit('rover:stationsRevealed', {});
  }

  private registerBoard(game: GameContext): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    game.interactables.register({
      id: BOARD_ID,
      position: this.hatch,
      radius: ROVER_BOARD_RANGE,
      kind: 'console',
      hidePillar: true,
      // When blocked the hold is 0 = refused the moment it is pressed (the same rule as the tram call console — nobody is refused after filling the gauge)
      get holdTime(): number { return self.boardBlock() === null ? ROVER_BOARD_HOLD_S : 0; },
      getPrompt: () => self.boardBlock() ?? '탐사 차량 탑승',
      canInteract: () => !!self.game?.isGameplayActive() && self.built && !self.localAboard && !self.game?.player?.roverRide,
      interact: () => self.requestBoard(),
    });
  }

  /** Why the local player cannot board right now (the prompt · the refusal). */
  private boardBlock(): string | null {
    const d = this.def;
    if (!this.built) return '탐사 차량이 없습니다';
    if (d.state === 'destroyed') return '파괴된 차량';
    if (d.state === 'patrol' || d.state === 'trip') return '이동 중에는 탈 수 없습니다';
    if (this.swallowed(this.stationIdx)) return '재해 지역 — 이용할 수 없습니다';
    if (this.riderNet.length >= ROVER_SEATS) return '만석';
    if (this.localAboard) return '이미 탑승 중입니다';
    return this.game?.player?.roverBoardBlock?.() ?? null;
  }

  private requestBoard(): void {
    const game = this.game;
    if (!game) return;
    const block = this.boardBlock();
    if (block) { this.refuse(block); return; }
    if (this.isMpClient && game.net) {
      game.net.send({ t: 'roverq', ev: 'board', rid: ++this.rid }, 'host');
      return;
    }
    const reason = this.hostBoard(this.selfId);
    if (reason) this.refuse(reason);
  }

  /** Host: boards `id`. The refusal reason, or null. */
  private hostBoard(id: string): string | null {
    const d = this.def;
    if (d.state === 'destroyed') return '파괴된 차량';
    if (d.state !== 'stopped' && d.state !== 'departing') return '이동 중에는 탈 수 없습니다';
    if (this.swallowed(this.stationIdx)) return '재해 지역 — 이용할 수 없습니다';
    if (this.riderNet.includes(id)) return null;
    if (this.riderNet.length >= ROVER_SEATS) return '만석';
    const local = id === this.selfId;
    if (local && !this.engageLocal()) return this.game?.player?.roverBoardBlock?.() ?? '지금은 탈 수 없습니다';
    this.setRiders([...this.riderNet, id]);
    this.reveal();
    if (local && d.state === 'stopped') this.game?.bus.emit('rover:destinationSelect', { open: true });
    this.sendState();
    return null;
  }

  /** Puts the local body in the car (did player accept it). */
  private engageLocal(): boolean {
    const game = this.game;
    const p = game?.player;
    if (!game || !p?.setRoverRide) return false;
    if (!p.roverRide) p.setRoverRide(this.binding);
    if (!p.roverRide) return false;
    this.boardedAt = game.time;
    this.aboardSeenAt = game.time;
    return true;
  }

  /** Puts the local body out. With no `at`, at the current spot. */
  private releaseLocal(at: THREE.Vector3 | null): void {
    const game = this.game;
    const p = game?.player;
    if (p?.roverRide) p.setRoverRide?.(null, at ? at.clone() : undefined);
    this.boardedAt = -Infinity;
    game?.bus.emit('rover:destinationSelect', { open: false });
  }

  private exitAllowed(): boolean {
    return this.built && (this.def.state === 'stopped' || this.def.state === 'departing');
  }

  private requestExit(): void {
    const game = this.game;
    if (!game) return;
    if (!this.exitAllowed()) { this.refuse(this.def.state === 'destroyed' ? '파괴된 차량' : '이동 중 — 하차 불가'); return; }
    if (this.isMpClient && game.net) {
      game.net.send({ t: 'roverq', ev: 'exit', rid: ++this.rid }, 'host');
      return;
    }
    const res = this.hostExit(this.selfId);
    if (res.reason) this.refuse(res.reason);
  }

  /** Host: puts `id` out. For the local one the body gets out at once; for a remote one the spot is handed back. */
  private hostExit(id: string): { reason: string | null; spot: THREE.Vector3 | null } {
    const aboard = this.riderNet.includes(id);
    if (aboard && !this.exitAllowed()) return { reason: '이동 중 — 하차 불가', spot: null };
    const spot = pickExitSpots(this.game?.world ?? null, this.def, 1)[0] ?? null;
    if (aboard) this.setRiders(this.riderNet.filter((x) => x !== id));
    if (id === this.selfId) this.releaseLocal(spot);
    this.sendState();
    return { reason: null, spot };
  }

  /** Host: ejects everyone (arrival · destruction). */
  private ejectAll(reason: 'arrived' | 'destroyed'): void {
    const game = this.game;
    const ids = this.riderNet.slice();
    if (!game || ids.length === 0) return;
    const spots = pickExitSpots(game.world, this.def, ids.length);
    const exits: Record<string, [number, number, number]> = {};
    ids.forEach((id, i) => { const p = spots[i]; exits[id] = [p.x, p.y, p.z]; });
    this.setRiders([]);
    const net = game.net;
    if (game.isMultiplayer && net) net.send({ t: 'rover', ev: 'eject', reason, exits }, 'others');
    const mine = exits[this.selfId];
    if (mine) this.releaseLocal(this.tmp.set(mine[0], mine[1], mine[2]));
  }

  /** Host: drops riders who left the lobby, disconnected or died, and a local ride player released on its own. */
  private pruneRiders(game: GameContext): void {
    if (this.riderNet.length === 0) return;
    const self = this.selfId;
    const net = game.net;
    const gone = (id: string): boolean => {
      if (id === self) return !game.player?.roverRide && game.time - this.boardedAt > 0.5;
      if (!game.isMultiplayer || !net) return true;
      const r = net.getRemotePlayer(id as PeerId);
      return !net.getLobbyPlayer(id as PeerId) || !r || !r.connected || r.suspended || r.isDead || !r.inMission;
    };
    if (!this.riderNet.some(gone)) return;
    this.setRiders(this.riderNet.filter((id) => !gone(id)));
    this.sendState();
  }

  /** Client: gets out on its own when it stays missing from the host's list. */
  private reconcileLocal(game: GameContext): void {
    if (!game.player?.roverRide || this.boardedAt === -Infinity) return;
    const now = game.time;
    if (this.localAboard) { this.aboardSeenAt = now; return; }
    if (now - this.boardedAt > RECONCILE_S && now - this.aboardSeenAt > RECONCILE_S) {
      this.releaseLocal(pickExitSpots(game.world, this.def, 1)[0] ?? null);
    }
  }

  private refuse(reason: string): void {
    this.game?.bus.emit('rover:refused', { reason });
  }

  /* ── The paid trip ──────────────────────────────────────────────────── */

  private indexOf(id: string): number {
    return this.route ? this.route.stations.findIndex((s) => s.id === id) : -1;
  }

  private swallowed(idx: number): boolean {
    const route = this.route;
    if (!route || idx < 0 || idx >= route.stations.length) return false;
    const hz = this.game?.world?.hazard;
    if (!hz || !hz.active) return false;
    const p = route.stations[idx].polePosition;
    return hz.isInside(p.x, p.z);
  }

  private tripDistanceTo(idx: number): number | null {
    const path = this.path, route = this.route, d = this.def;
    if (!path || !route || idx < 0 || idx >= route.stations.length || this.stationIdx < 0 || idx === this.stationIdx) return null;
    if (d.state !== 'stopped' && d.state !== 'departing') return null;
    return shortestTrip(path, route.stations[this.stationIdx].s, route.stations[idx].s).distance;
  }

  private tripBlock(idx: number): string | null {
    const d = this.def, game = this.game;
    if (!this.built || !this.route) return '탐사 차량이 없습니다';
    if (d.state === 'destroyed') return '파괴된 차량';
    if (!this.localAboard) return '탑승 중이 아닙니다';
    if (d.state === 'departing') return '이미 요금을 냈습니다';
    if (d.state !== 'stopped') return '정차 중에만 출발할 수 있습니다';
    if (idx < 0) return '알 수 없는 정류장입니다';
    if (idx === this.stationIdx) return '현재 정류장입니다';
    if (this.swallowed(idx)) return '재해 지역 — 갈 수 없습니다';
    const dist = this.tripDistanceTo(idx);
    if (dist === null) return '정차 중에만 출발할 수 있습니다';
    if ((game?.meta?.credits ?? 0) < roverFareFor(dist)) return '크레딧이 부족합니다';
    if (this.pendingTrip >= 0 && game && game.time - this.pendingTripAt < TRIP_PENDING_S) return '요청을 처리하는 중입니다';
    return null;
  }

  private requestTrip(idx: number): string | null {
    const game = this.game;
    const block = this.tripBlock(idx);
    if (block) return block;
    const dist = this.tripDistanceTo(idx);
    if (!game || dist === null) return '정차 중에만 출발할 수 있습니다';
    const fare = roverFareFor(dist);
    if (this.isMpClient && game.net) {
      this.pendingTrip = ++this.rid;
      this.pendingTripAt = game.time;
      game.net.send({ t: 'roverq', ev: 'trip', rid: this.pendingTrip, to: idx, fare }, 'host');
      return null;
    }
    const reason = this.hostTrip(this.selfId, idx, fare);
    if (reason) { this.refuse(reason); return reason; }
    return null;
  }

  /** Host: `by` pays `fare` and departs for `idx`. The refusal reason, or null. */
  private hostTrip(by: string, idx: number, fare: number): string | null {
    const route = this.route, path = this.path, d = this.def;
    if (!route || !path) return '탐사 차량이 없습니다';
    if (d.state === 'departing') return '이미 요금을 냈습니다';
    if (d.state !== 'stopped') return '정차 중에만 출발할 수 있습니다';
    if (!this.riderNet.includes(by)) return '탑승 중이 아닙니다';
    if (!Number.isInteger(idx) || idx < 0 || idx >= route.stations.length || idx === this.stationIdx) return '갈 수 없는 정류장입니다';
    if (this.swallowed(idx)) return '재해 지역 — 갈 수 없습니다';
    const dist = this.tripDistanceTo(idx);
    if (dist === null) return '정차 중에만 출발할 수 있습니다';
    if (roverFareFor(dist) !== fare) return '요금이 바뀌었습니다 — 다시 선택하세요';
    const from = this.stationIdx;
    d.dir = shortestTrip(path, route.stations[from].s, route.stations[idx].s).dir;
    this.targetIdx = idx;
    d.timer = ROVER_DEPART_GRACE_S;
    this.setState('departing');
    const game = this.game;
    if (game?.isMultiplayer && game.net) game.net.send({ t: 'rover', ev: 'trip', by, from, to: idx, fare }, 'others');
    this.applyTripFact(by, from, idx, fare);
    this.sendState();
    return null;
  }

  /** Every client: the paid departure is committed. **Only the payer** spends credits. */
  private applyTripFact(by: string, from: number, to: number, fare: number): void {
    const game = this.game, route = this.route;
    if (!game || !route) return;
    const st = route.stations;
    const a = st[from], b = st[to];
    if (!a || !b) return;
    const local = by === this.selfId;
    game.bus.emit('rover:tripStarted', {
      by: local ? 'local' : by, name: this.nameOf(by), fromId: a.id, toId: b.id, fare, local, grace: ROVER_DEPART_GRACE_S,
    });
    if (local) {
      this.pendingTrip = -1;
      const ok = game.meta?.addCredits(-fare, formatCreditReason({ kind: 'rover', id: a.id, to: b.id }));
      if (ok === false) console.warn(`[Rover] 요금 ${fare} 결제 실패 (크레딧 부족 · 오프라인 거절)`);
    }
    if (this.localAboard) game.bus.emit('rover:destinationSelect', { open: false });
  }

  /* ── Damage ─────────────────────────────────────────────────────────── */

  private damage(amount: number, _from?: THREE.Vector3): void {
    if (!this.built || this.def.state === 'destroyed' || !(amount > 0) || !this.isHost) return;
    this.applyDamage(amount, false);
  }

  private applyDamage(amount: number, hazard: boolean): void {
    const d = this.def;
    if (d.state === 'destroyed') return;
    d.hp = Math.max(0, d.hp - amount);
    this.dirty = true;
    this.game?.bus.emit('rover:damaged', { hp: d.hp, maxHp: d.maxHp, hazard });
    if (d.hp <= 0) this.destroy();
  }

  private destroy(): void {
    this.targetIdx = -1;
    this.speed = 0;
    this.ejectAll('destroyed');
    this.setState('destroyed');
    this.sendState();
  }

  /** Host: inside a hazard zone, hazard damage × `ROVER_HAZARD_DAMAGE_MUL` every `HAZARD_TICK_S` (even with no riders). */
  private hazardTick(dt: number, game: GameContext): void {
    if (!game.isGameplayPhase()) return;
    const hz = game.world?.hazard;
    const d = this.def;
    if (!hz || !hz.active || !hz.isInside(d.position.x, d.position.z)) { this.hazardTimer = 0; return; }
    this.hazardTimer += dt;
    while (this.hazardTimer >= HAZARD_TICK_S && d.state !== 'destroyed') {
      this.hazardTimer -= HAZARD_TICK_S;
      this.applyDamage(HAZARD_DPS * hz.damageMul * ROVER_HAZARD_DAMAGE_MUL * HAZARD_TICK_S, true);
    }
  }

  /** Host: one turret shot — FX, event, broadcast. */
  private readonly onFire = (from: THREE.Vector3, to: THREE.Vector3, targetId: number): void => {
    const game = this.game;
    this.fx?.tracer(from, to);
    if (!game) return;
    game.bus.emit('rover:fired', { from: this.fireFrom.copy(from), to: this.fireTo.copy(to), targetId });
    if (game.isMultiplayer && game.net?.isHost) game.net.send({ t: 'rover', ev: 'fire', p: [to.x, to.y, to.z] }, 'others');
  };

  /* ── Cheats (the console's `rover`) ─────────────────────────────────── */

  private cheat(action: 'hp' | 'speed' | 'depart' | 'arrive', value: number | undefined): void {
    if (!this.built || !this.isHost || !this.route || !this.path) return;
    const d = this.def;
    switch (action) {
      case 'hp': {
        const v = Math.max(0, value ?? d.hp);
        if (v <= 0) { this.applyDamage(d.hp + 1, false); break; }
        d.hp = Math.min(d.maxHp, v);
        this.dirty = true;
        this.game?.bus.emit('rover:damaged', { hp: d.hp, maxHp: d.maxHp, hazard: false });
        break;
      }
      case 'speed':
        this.speedMul = Math.max(0.1, Math.min(50, value ?? 1));
        break;
      case 'depart':
        if (d.state === 'stopped' || d.state === 'departing') d.timer = 0;
        break;
      case 'arrive':
        if ((d.state === 'patrol' || d.state === 'trip') && this.targetIdx >= 0) {
          d.s = wrapRouteS(this.path, this.route.stations[this.targetIdx].s - d.dir * 6);
          this.speed = Math.min(this.speed, ROVER_PATROL_SPEED);
          this.sendState();
        }
        break;
    }
  }

  /* ── Multiplayer ──────────────────────────────────────────────────── */

  private wire(): RoverWire {
    const d = this.def;
    return {
      s: d.s, dir: d.dir, st: Math.max(0, ROVER_STATES.indexOf(d.state)), stn: this.stationIdx, tgt: this.targetIdx,
      tm: d.timer, hp: d.hp, rd: this.riderNet.slice(), rv: this.revealed ? 1 : 0,
    };
  }

  private sendState(): void {
    const game = this.game;
    this.dirty = false;
    if (!game || !game.isMultiplayer || !game.net?.isHost || !this.built) return;
    game.net.send({ t: 'rover', ev: 'state', rover: this.wire() }, 'others');
    this.netTimer = ROVER_NET_INTERVAL;
    this.lastSend = game.time;
  }

  private broadcastTick(dt: number, game: GameContext): void {
    if (!game.isMultiplayer || !game.net?.isHost) { this.dirty = false; return; }
    this.netTimer -= dt;
    if (this.netTimer <= 0 || (this.dirty && game.time - this.lastSend >= LATE_SEND_S)) this.sendState();
  }

  private applyWire(w: RoverWire): void {
    const route = this.route, path = this.path, game = this.game;
    if (!this.built || !route || !path || !game) return;
    const d = this.def;
    const n = route.stations.length;
    const wasSynced = this.synced;
    const prev = d.state;
    const prevHp = d.hp;
    const next: RoverState = ROVER_STATES[w.st] ?? 'stopped';
    d.dir = w.dir === -1 ? -1 : 1;
    this.stationIdx = Number.isInteger(w.stn) && w.stn >= 0 && w.stn < n ? w.stn : -1;
    this.targetIdx = Number.isInteger(w.tgt) && w.tgt >= 0 && w.tgt < n ? w.tgt : -1;
    d.timer = Math.max(0, Number(w.tm) || 0);
    d.hp = Math.max(0, Math.min(d.maxHp, Number(w.hp) || 0));
    this.targetS = wrapRouteS(path, Number(w.s) || 0);
    const moving = next === 'patrol' || next === 'trip';
    if (!wasSynced || !moving) d.s = this.targetS;
    if (w.rv && !this.revealed) this.reveal();
    const riders = Array.isArray(w.rd) ? w.rd.filter((x): x is string => typeof x === 'string').slice(0, ROVER_SEATS) : [];
    this.setRiders(riders, wasSynced);

    if (!wasSynced) {
      this.synced = true;
      d.state = next;
      this.syncIds();
      sampleRoute(path, d.s, this.sPos, this.sTan);
      if (next === 'stopped' || moving) d.yaw = wrapAngle(Math.atan2(this.sTan.z, this.sTan.x) + (d.dir < 0 ? Math.PI : 0));
      this.place(0, true);
      game.bus.emit('rover:state', { state: next, stationId: d.stationId, targetId: d.targetId });
      if (next === 'destroyed') this.onDestroyed(false);
      return;
    }
    if (prev !== next && moving && (prev === 'stopped' || prev === 'departing')) this.speed = 0;
    this.setState(next);
    if (d.hp < prevHp) {
      const hz = game.world?.hazard;
      const hazard = !!hz && hz.active && hz.isInside(d.position.x, d.position.z);
      game.bus.emit('rover:damaged', { hp: d.hp, maxHp: d.maxHp, hazard });
    }
  }

  private applyReply(m: Extract<RoverMessage, { ev: 'reply' }>): void {
    const game = this.game;
    if (!game) return;
    if (!m.ok) {
      if (m.req === 'trip') this.pendingTrip = -1;
      this.refuse(m.reason ?? '요청이 거절되었습니다');
      return;
    }
    switch (m.req) {
      case 'board':
        if (!this.engageLocal()) {
          // player did not accept it — ask the host to drop this client from the list
          game.net?.send({ t: 'roverq', ev: 'exit', rid: ++this.rid }, 'host');
          this.refuse(game.player?.roverBoardBlock?.() ?? '지금은 탈 수 없습니다');
        } else if (this.def.state === 'stopped') {
          game.bus.emit('rover:destinationSelect', { open: true });
        }
        break;
      case 'exit':
        this.releaseLocal(m.exit ? this.tmp.set(m.exit[0], m.exit[1], m.exit[2]) : null);
        break;
      case 'trip':
        this.pendingTrip = -1;
        break;
    }
  }

  private applyFire(p: [number, number, number]): void {
    const game = this.game, body = this.body;
    if (!game || !body || this.def.state === 'destroyed') return;
    this.tmp.set(p[0], p[1], p[2]);
    applyRemoteShot(this.turret, body, this.tmp, game.time, this.muzzle);
    this.fx?.tracer(this.muzzle, this.tmp);
    // A replica is sent the impact point only, so the shot arrives with no target (`rover:fired.targetId`).
    game.bus.emit('rover:fired', { from: this.fireFrom.copy(this.muzzle), to: this.fireTo.copy(this.tmp), targetId: null });
  }

  private handleRequest(m: RoverRequest, from: PeerId): void {
    const game = this.game;
    const net = game?.net;
    if (!game || !net) return;
    if (m.ev === 'sync') { this.sendSyncTo(from); return; }
    const rid = typeof m.rid === 'number' ? m.rid : 0;
    const reply = (ok: boolean, reason?: string, exit?: THREE.Vector3 | null): void => {
      net.send({
        t: 'rover', ev: 'reply', to: from, rid, req: m.ev, ok,
        ...(reason ? { reason } : {}), ...(exit ? { exit: [exit.x, exit.y, exit.z] as [number, number, number] } : {}),
      }, from);
    };
    if (!this.built || !this.route) { reply(false, '탐사 차량이 없습니다'); return; }
    const lobbyPlayer = net.getLobbyPlayer(from);
    const r = net.getRemotePlayer(from);
    if (!lobbyPlayer || !r || r.isDead || r.isDowned) { reply(false, '지금은 이용할 수 없습니다'); return; }
    switch (m.ev) {
      case 'board': {
        if (r.position.distanceTo(this.def.position) > ROVER_BOARD_CHECK_RANGE) { reply(false, '차량에서 너무 멉니다'); return; }
        const reason = this.hostBoard(from);
        reply(!reason, reason ?? undefined);
        return;
      }
      case 'exit': {
        const res = this.hostExit(from);
        reply(!res.reason, res.reason ?? undefined, res.spot);
        return;
      }
      case 'trip': {
        const reason = this.hostTrip(from, Number(m.to), Number(m.fare));
        reply(!reason, reason ?? undefined);
        return;
      }
    }
  }

  private ensureNet(): void {
    const game = this.game;
    const net = game?.net;
    if (!game || !net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('rover', (m: RoverMessage, from) => {
        const n = game.net;
        if (!n || n.isHost || from !== n.lobby?.hostId) return;
        switch (m.ev) {
          case 'state': this.applyWire(m.rover); break;
          case 'reply': if (m.to === n.localId) this.applyReply(m); break;
          case 'trip': this.applyTripFact(m.by, m.from, m.to, m.fare); break;
          case 'eject': {
            const e = n.localId ? m.exits[n.localId] : undefined;
            if (e && game.player?.roverRide) this.releaseLocal(this.tmp.set(e[0], e[1], e[2]));
            break;
          }
          case 'fire': this.applyFire(m.p); break;
        }
      }),
      net.onMessage('roverq', (m: RoverRequest, from) => {
        if (!game.net?.isHost) return;
        this.handleRequest(m, from);
      }),
      net.onMessage('flow', (m, from) => { if (m.ev === 'rejoined' && game.net?.isHost) this.sendSyncTo(from); }),
      game.bus.on('net:hostChanged', ({ isLocalHost }) => {
        if (!this.built) return;
        if (isLocalHost) { this.synced = true; this.sendState(); } else this.requestSync();
      }),
    );
  }

  private requestSync(): void {
    const game = this.game;
    if (!game || !this.isMpClient || !game.net) return;
    game.net.send({ t: 'roverq', ev: 'sync' }, 'host');
  }

  private sendSyncTo(to: PeerId): void {
    const game = this.game;
    if (!game?.isMultiplayer || !game.net || !this.built) return;
    game.net.send({ t: 'rover', ev: 'state', rover: this.wire() }, to);
  }
}
