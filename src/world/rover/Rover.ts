/**
 * src/world/rover/Rover.ts — 탐사 차량 **본체 · 상태 기계 · 포탑 · 탑승 · 동기화** (owner: R2, 2026-09-13).
 *
 * 규칙의 원본은 `shared/types.ts` 의 탐사 차량 절이다. 이 파일에 남은 것은 **수명 · 상태 기계 · 탑승/결제 흐름 · 멀티**이고
 * 지오메트리(`parts/Body`) · 연출(`parts/Fx`) · 포탑(`parts/Turret`) · 부딪힘(`parts/Impact`) · 하차 자리(`parts/Exits`)는 파트로 내렸다.
 *
 * ## 상태 기계 (호스트 권위 — 싱글은 자기가 호스트다)
 *   stopped ──(정차 `ROVER_DWELL_S`, 탑승자가 있으면 멈춤)──▶ patrol ──(다음 정류장 도착)──▶ stopped
 *   stopped ──(탑승자 결제)──▶ departing ──(`ROVER_DEPART_GRACE_S`)──▶ trip ──(목적지 도착 → 전원 강제 하차)──▶ stopped
 *   아무 상태 ──(체력 0)──▶ destroyed (레이드 내내 — 잔해가 남고 탑승자는 그 자리에서 내린다)
 * 진행 방향이 바뀌면 서 있는 동안 제자리에서 돈다 (`ROVER_TURN_RATE`) — 결제 이동이 반대 방향이면 출발 유예 안에 돈다.
 * 이동 곡선(가속 · 제동 · 회전)은 호스트 · 클라이언트가 **같은 함수**(`motion`)로 굴리고, 클라이언트는 호스트의 `s` 로 보정한다.
 *
 * ## 와이어 (`RoverMessage` / `RoverRequest`, 받는 쪽은 로비 호스트가 보낸 것만)
 * - 호스트 → 전원 `state` (`ROVER_NET_INTERVAL` + 바뀔 때마다) · `trip`(결제 확정 — `by` 만 크레딧을 낸다) · `eject`(도착 · 파괴) · `fire`.
 * - 클라이언트 → 호스트 `board` · `exit` · `trip` · `sync`. 호스트는 로비 멤버 · 살아 있음 · 거리 · 상태를 보고 `reply` 한다.
 * - 늦게 합류(`flow rejoined`) · `net:hostChanged` 는 전차와 같다. 새 호스트는 받아 둔 마지막 상태에서 이어 굴린다.
 *
 * ## 탑승자
 * 목록은 PeerId(싱글은 `'local'`)로 들고, 밖으로는 이 클라이언트 기준으로 자기 자신을 `'local'` 로 바꿔 보인다
 * (`RoverVehicleDef.riders`). 몸 · 카메라 · 피해 면제는 player 의 `setRoverRide` 가 하고 여기는 끈(`RoverRideBinding`)만 준다.
 * 호스트는 로비를 떠났거나 끊겼거나 죽은 탑승자를 매 프레임 목록에서 뺀다.
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

/** 탑승 상호작용 id — 차량이 레이드당 하나라 상수다. */
const BOARD_ID = 'rover:board';
/** 좌석(탑승자의 발) · 궤도 카메라 초점 · 탑승 상호작용 자리의 노면 위 높이(m). 그림 자리라 밸런스 수치가 아니다. */
const SEAT_UP = 0.6;
const FOCUS_UP = 0.6;
const HATCH_UP = 1.2;
/** 도착 직전 최저 속도(m/s) — 제동 곡선이 0 에 수렴해 영영 안 닿는 일이 없게. */
const ARRIVE_CREEP = 1;
/** 지형 기울기 따라가기 속도(1/s) · 최대 기울기(rad). */
const TILT_SMOOTH = 5;
const TILT_MAX = 0.35;
/** 기울기를 재는 앞뒤 · 좌우 표본 거리(m). */
const TILT_SAMPLE_L = 2.6;
const TILT_SAMPLE_W = 1.3;
/** 상태가 바뀐 뒤 방송을 이만큼(초)은 모아서 한 번 보낸다. */
const LATE_SEND_S = 0.1;
/** 클라이언트: 호스트 목록에서 이만큼(초) 빠져 있으면 내 탑승을 스스로 푼다 (메시지 유실 · 호스트 이관 대비). */
const RECONCILE_S = 1.5;
/** 결제 요청이 이만큼(초) 답이 없으면 다시 누를 수 있다. */
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
  /** 서 있는(stopped · departing) 정류장 index, 아니면 −1. */
  private stationIdx = -1;
  /** departing · trip = 목적지, patrol = 다음 정류장, 그 밖 −1. */
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
  /** 클라이언트: 호스트가 준 진행거리 (추측 항법으로 앞당긴다). */
  private targetS = 0;
  /** 클라이언트: 첫 `state` 를 받았는가 (첫 적용은 사건을 내지 않는다). */
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

  /** 차량이 있으면 그 `RoverRef`, 없으면 null. */
  get ref(): RoverRef | null { return this.built && this.route ? this.refImpl : null; }

  /* ── per-frame ─────────────────────────────────────────────────────── */

  update(dt: number, _t: number): void {
    const game = this.game, body = this.body, fx = this.fx;
    if (!this.built || !game || !body || !fx || !this.path || !this.route) return;
    fx.update(dt);
    if (this.def.state === 'destroyed') return;
    const host = this.isHost;
    if (host) this.hostTick(dt, game); else this.clientTick(dt);
    if (this.destroyed) return;   // hostTick 이 부쉈을 수 있다 (좁혀진 타입을 다시 읽는다)

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

  /** 호스트: 정차 · 출발 유예 타이머. */
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

  /** 클라이언트: 표시용 타이머 + 호스트 진행거리로 보정 (추측 항법으로 앞당긴 뒤 끌어당긴다). */
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

  /** 가속 · 제동 · 제자리 회전 · 진행 (호스트 · 클라이언트가 같은 곡선). 도착 판정은 호스트만. */
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

  /** 차체 · 콜라이더 · 기울기 · 좌석/초점/탑승 자리를 지금 `s` 에 놓는다. */
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

  /* ── 상태 전이 (모든 클라이언트가 같은 사건을 낸다) ─────────────────────── */

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

  /** 호스트: 목적지(`targetIdx`)에 닿았다. 결제 이동이면 전원 강제 하차. */
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

  /** 모든 클라이언트: 파괴 연출 · 잔해 모습. `explode` false = 늦게 합류해 이미 부서진 차를 받았다. */
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
      // 강제 하차 메시지를 놓친 탑승자도 차 안에 남지 않는다
      if (game.player?.roverRide && this.boardedAt > -Infinity) {
        this.releaseLocal(pickExitSpots(game.world, d, 1)[0] ?? null);
      }
    }
  }

  /* ── 탑승자 ─────────────────────────────────────────────────────────── */

  private get isHost(): boolean {
    const c = this.game;
    return !c?.isMultiplayer || !c.net || c.net.isHost;
  }

  private get isMpClient(): boolean {
    const c = this.game;
    return !!c?.isMultiplayer && !!c.net && !c.net.isHost;
  }

  /** 탑승자 목록에서 이 클라이언트를 가리키는 id (멀티 = 내 PeerId, 싱글 = `'local'`). */
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
      // 2026-09-14 (NPC 퀘스트 interact): 내가 탔다 — 호스트가 탑승자 목록으로 확정한 뒤라 클라이언트도 정확하다
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
      // 막혀 있으면 홀드 0 = 누르는 순간 거절 (전차 호출 콘솔과 같은 규약 — 게이지를 다 채운 뒤 거절당하지 않는다)
      get holdTime(): number { return self.boardBlock() === null ? ROVER_BOARD_HOLD_S : 0; },
      getPrompt: () => self.boardBlock() ?? '탐사 차량 탑승',
      canInteract: () => !!self.game?.isGameplayActive() && self.built && !self.localAboard && !self.game?.player?.roverRide,
      interact: () => self.requestBoard(),
    });
  }

  /** 로컬 플레이어가 지금 탈 수 없는 사유 (프롬프트 · 거절). */
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

  /** 호스트: `id` 를 태운다. 거절 사유 또는 null. */
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

  /** 로컬 몸을 차에 태운다 (player 가 받아들였는가). */
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

  /** 로컬 몸을 내린다. `at` 없으면 지금 자리. */
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

  /** 호스트: `id` 를 내린다. 로컬이면 곧바로 몸을 내리고, 원격이면 자리를 돌려준다. */
  private hostExit(id: string): { reason: string | null; spot: THREE.Vector3 | null } {
    const aboard = this.riderNet.includes(id);
    if (aboard && !this.exitAllowed()) return { reason: '이동 중 — 하차 불가', spot: null };
    const spot = pickExitSpots(this.game?.world ?? null, this.def, 1)[0] ?? null;
    if (aboard) this.setRiders(this.riderNet.filter((x) => x !== id));
    if (id === this.selfId) this.releaseLocal(spot);
    this.sendState();
    return { reason: null, spot };
  }

  /** 호스트: 전원 강제 하차 (도착 · 파괴). */
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

  /** 호스트: 로비를 떠났거나 끊겼거나 죽은 탑승자 · player 가 스스로 푼 로컬 탑승을 뺀다. */
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

  /** 클라이언트: 호스트 목록에서 내가 계속 빠져 있으면 스스로 내린다. */
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

  /* ── 결제 이동 ─────────────────────────────────────────────────────── */

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

  /** 호스트: `by` 가 `idx` 로 `fare` 를 내고 출발한다. 거절 사유 또는 null. */
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

  /** 모든 클라이언트: 결제 출발 확정. **결제자만** 크레딧을 낸다. */
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

  /* ── 피해 ──────────────────────────────────────────────────────────── */

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

  /** 호스트: 재해 구역 안이면 `HAZARD_TICK_S` 마다 재해 피해 × `ROVER_HAZARD_DAMAGE_MUL` (탑승자가 없어도). */
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

  /** 호스트: 포탑 한 발 — 연출 · 사건 · 방송. */
  private readonly onFire = (from: THREE.Vector3, to: THREE.Vector3): void => {
    const game = this.game;
    this.fx?.tracer(from, to);
    if (!game) return;
    game.bus.emit('rover:fired', { from: this.fireFrom.copy(from), to: this.fireTo.copy(to) });
    if (game.isMultiplayer && game.net?.isHost) game.net.send({ t: 'rover', ev: 'fire', p: [to.x, to.y, to.z] }, 'others');
  };

  /* ── 치트 (콘솔 `rover`) ────────────────────────────────────────────── */

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

  /* ── 멀티 ─────────────────────────────────────────────────────────── */

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
          // player 가 받아들이지 않았다 — 호스트 목록에서 나를 빼 달라고 한다
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
    game.bus.emit('rover:fired', { from: this.fireFrom.copy(this.muzzle), to: this.fireTo.copy(this.tmp) });
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
