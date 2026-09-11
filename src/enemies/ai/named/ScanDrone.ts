/**
 * src/enemies/ai/named/ScanDrone.ts — **로든의 스캔 드론** (`rogue_scan_drone`, 2026-09-11).
 *
 * 로든(`Sniper.ts`)이 먼 플레이어를 노릴 때 띄운다. 드론은 표적 머리 위 `NAMED_SCAN_DRONE.altitude` 로 날아가
 * `pulseInterval` 마다 **음파**를 보내고, 반경 `pulseRadius`(수평) 안에서 드론 → 가슴 사선이 열린 플레이어의
 * `exposure` 를 올린다. `NAMED_SNIPER.scanPulses` 번이 되면 `done` — 로든이 쏘거나 놓아 줄 때까지(최대 `loiterMax`)
 * 머물다가 로든에게 돌아가 사라진다. 로든이 죽으면 곧장 솟구쳐 사라진다. 요격당하면 떨어진다(`integrateDeathFall`).
 *
 * 단계(`Enemy.namedPhase`): 0 스캔 · 1 대기(`done`) · 2 귀환 · 3 이탈(로든 사망).
 * 타이머: `namedTimer` = 힌트 20 유지(호스트) / 직전 프레임 y(리플리카) · `namedCooldown` = 비행음 간격.
 *
 * **로컬 노출 표시**(`named:scanExposure`)는 드론 id 별로 세고(`ScanRuntime`) 셋 중 하나에서 0 으로 떨어진다 —
 * 드론이 없어짐(격추 · 귀환) · 나를 겨눈 저격 발사(`named:sniperGlint.targetLocal` 의 `duration` 뒤) · 20 초 무갱신.
 * 드론이 전부 사라져도 시간이 흘러야 하므로 그 동안만 `requestAnimationFrame` 한 줄로 스스로 틱한다(음파 FX 도 같이).
 */
import * as THREE from 'three';
import { CORPSE_FALL_MAX_SPEED, type EnemyEvent, type GameContext, type PeerId } from '@/shared';
import type { Enemy, EnemyHost } from '../../Enemy';
import type { EnemySystem } from '../../EnemySystem';
import type { CombatTarget } from '../../Targets';
import type { ReplicaHost } from '../../net/Replica';
import { NAMED_SCAN_DRONE, NAMED_SNIPER } from '../../EnemyTypes';
import { FLEE_DURATION, isVec3Tuple } from '../../model';
import { round, tuple } from '../../net/HostSync';
import { ScanPulseFx } from '../../fx/ScanPulseFx';
import { turnToward, yawTo } from '../Steering';
import { scanDroneDataOf, sniperDataOf, type ScanDroneData } from './model';

/* ── 비행 느낌 (밸런스 수치가 아니다 — 그것은 NAMED_SCAN_DRONE) ── */
/** Spawn this far above / beside the sniper. */
const LAUNCH_UP = 2.4;
const LAUNCH_SIDE = 1.3;
/** Horizontal velocity blend rate (1/s) — smooth acceleration and braking. */
const ACCEL_RATE = 1.6;
/** Desired horizontal speed = distance × this (slows down on arrival), capped at the speed limit. */
const ARRIVE_GAIN = 0.9;
const CLIMB_GAIN = 1.2;
const CLIMB_MAX = 7;
const DESCEND_MAX = 5;
/** Never lower than the highest surface under (and just ahead of) the drone + this. */
const MIN_CLEARANCE = 3;
const LOOKAHEAD_S = 0.8;
/** Slow circle over the target while scanning. */
const ORBIT_RADIUS = 5;
const ORBIT_RATE = 0.25;
/** Speed limit fraction once over the target (it "follows slowly"). */
const FOLLOW_SPEED_FRAC = 0.55;
/** Pulses only count down within this fraction of `pulseRadius` from the target. */
const SCAN_START_FRAC = 0.6;
/** Homecoming: hover this high over the sniper, despawn within `HOME_RADIUS`. */
const HOME_HEIGHT = 3;
const HOME_RADIUS = 2.5;
const RETURN_MAX_S = 45;
const ESCAPE_S = 3.5;
const ESCAPE_CLIMB = 30;
/** Speed multiplier while 전소 / stunned (drifts, no pulses). */
const STUN_SPEED = 0.3;
const HUM_INTERVAL_S = 1.8;
const HUM_VOLUME = 0.8;
/** Wire hint 20 stays up this long after a pulse (≥ 2 snapshots at `NET_ENEMY_SNAPSHOT_HZ`). */
const PULSE_HINT_S = 0.6;
const HINT_PULSE = 20;
/** Cloaked players (`CombatTarget.stealth` below this) are not caught by the scan. */
const SCAN_STEALTH_MIN = 0.5;
/** Local exposure display clears after this long without a new pulse. */
const EXPOSURE_TIMEOUT_S = 20;

const PHASE_SCAN = 0;
const PHASE_LOITER = 1;
const PHASE_RETURN = 2;
const PHASE_ESCAPE = 3;

const _spawn = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _face = new THREE.Vector3();
const _p = new THREE.Vector3();

/* ════════════════════════════════════════════════════════════════════════════
 * 로컬 노출 · 음파 FX 런타임 (호스트 · 리플리카 공용, ctx 하나당 하나)
 * ════════════════════════════════════════════════════════════════════════════ */

interface ExposureSlot {
  droneId: number;
  sniperId: number | null;
  count: number;
  total: number;
  lastAt: number;
}

const SLOTS = 4;

class ScanRuntime {
  private fx: ScanPulseFx | null = null;
  private readonly slots: ExposureSlot[] = [];
  private readonly unsub: Array<() => void> = [];
  private shownCount = 0;
  private shownTotal = 0;
  private shownSniper: number | null = null;
  private lastTick = -1;
  private loopOn = false;
  private disposed = false;
  /** ctx.time at which a sniper shot aimed at us lands (from the glint), -1 = none. */
  private shotClearAt = -1;
  private shotSniper: number | null = null;
  private readonly loop = (): void => {
    this.loopOn = false;
    if (this.disposed) return;
    this.tick();
    this.ensureLoop();
  };

  constructor(readonly ctx: GameContext, public active: readonly Enemy[]) {
    for (let i = 0; i < SLOTS; i++) this.slots.push({ droneId: 0, sniperId: null, count: 0, total: 0, lastAt: 0 });
    const bus = ctx.bus;
    this.unsub.push(
      bus.on('world:ready', () => this.reset(false)),
      bus.on('game:newMission', () => this.reset(false)),
      bus.on('game:abort', () => this.reset(true)),
      bus.on('named:sniperGlint', ({ enemyId, targetLocal, duration }) => {
        if (!targetLocal) return;
        this.shotClearAt = ctx.time + Math.max(0, duration) + 0.15;
        this.shotSniper = enemyId;
        this.ensureLoop();
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsub) off();
    this.unsub.length = 0;
    this.fx?.dispose();
    this.fx = null;
  }

  /** Mission reset / abort: hide pulses, drop exposure (announcing 0), and on abort free the FX meshes. */
  reset(disposeFx: boolean): void {
    if (disposeFx) { this.fx?.dispose(); this.fx = null; } else this.fx?.clear();
    for (const s of this.slots) s.droneId = 0;
    this.shotClearAt = -1;
    this.shotSniper = null;
    this.refresh();
  }

  spawnFx(p: THREE.Vector3, groundY: number, radius: number): void {
    if (!this.fx) this.fx = new ScanPulseFx(this.ctx.scene);
    this.fx.spawn(p.x, p.y, p.z, groundY, radius, this.ctx.time);
    this.ensureLoop();
  }

  /**
   * A pulse from drone `droneId` went out. `exposed` = it caught the local player; `hostCount` = the host's own count
   * (`ScanDroneData.exposure`), undefined on a replica (which counts the pulses it was named in).
   */
  onPulse(droneId: number, sniperId: number | null, exposed: boolean, hostCount: number | undefined, total: number): void {
    let slot: ExposureSlot | null = null;
    for (const s of this.slots) if (s.droneId === droneId) { slot = s; break; }
    if (!exposed) {
      if (slot) slot.total = total;   // no refresh of `lastAt` — "20 s without an update" counts from the last exposure
      this.refresh();
      return;
    }
    if (!slot) {
      for (const s of this.slots) if (s.droneId === 0) { slot = s; break; }
      if (!slot) {
        slot = this.slots[0];
        for (const s of this.slots) if (s.lastAt < slot.lastAt) slot = s;
      }
      slot.droneId = droneId; slot.count = 0;
    }
    slot.sniperId = sniperId;
    slot.total = total;
    slot.count = hostCount !== undefined ? hostCount : slot.count + 1;
    slot.lastAt = this.ctx.time;
    this.refresh();
    this.ensureLoop();
  }

  clearDrone(droneId: number): void {
    let changed = false;
    for (const s of this.slots) if (s.droneId === droneId) { s.droneId = 0; changed = true; }
    if (changed) this.refresh();
  }

  /** A sniper shot at us went out: clear what that sniper's drones (or any drone of unknown owner) showed. */
  clearSniper(sniperId: number | null): void {
    let changed = false;
    for (const s of this.slots) {
      if (s.droneId !== 0 && (sniperId === null || s.sniperId === null || s.sniperId === sniperId)) { s.droneId = 0; changed = true; }
    }
    if (changed) this.refresh();
  }

  /** Advance FX + timeouts to ctx.time. Idempotent within a frame (hooks and the rAF loop may both call it). */
  tick(): void {
    const now = this.ctx.time;
    if (now === this.lastTick) return;
    this.lastTick = now;
    this.fx?.update(now);
    if (this.shotClearAt >= 0 && now >= this.shotClearAt) {
      const sniper = this.shotSniper;
      this.shotClearAt = -1; this.shotSniper = null;
      this.clearSniper(sniper);
    }
    let changed = false;
    for (const s of this.slots) {
      if (s.droneId === 0) continue;
      if (now - s.lastAt > EXPOSURE_TIMEOUT_S || !droneAlive(this.active, s.droneId)) { s.droneId = 0; changed = true; }
    }
    if (changed) this.refresh();
  }

  private refresh(): void {
    let count = 0, total = this.shownTotal, sniper: number | null = null;
    for (const s of this.slots) {
      if (s.droneId === 0 || s.count <= count) continue;
      count = s.count; total = s.total; sniper = s.sniperId;
    }
    if (count === this.shownCount && (count === 0 || total === this.shownTotal)) return;
    if (count === 0) sniper = this.shownSniper;
    this.shownCount = count; this.shownTotal = total; this.shownSniper = count > 0 ? sniper : null;
    this.ctx.bus.emit('named:scanExposure', { count, total, sniperId: sniper });
  }

  private needsTick(): boolean {
    if (this.fx && this.fx.activeCount > 0) return true;
    if (this.shotClearAt >= 0) return true;
    for (const s of this.slots) if (s.droneId !== 0) return true;
    return false;
  }

  private ensureLoop(): void {
    if (this.loopOn || this.disposed || typeof requestAnimationFrame !== 'function' || !this.needsTick()) return;
    this.loopOn = true;
    requestAnimationFrame(this.loop);
  }
}

let runtime: ScanRuntime | null = null;

function runtimeFor(ctx: GameContext, active: readonly Enemy[]): ScanRuntime {
  if (runtime && runtime.ctx !== ctx) { runtime.dispose(); runtime = null; }
  if (!runtime) runtime = new ScanRuntime(ctx, active);
  runtime.active = active;
  return runtime;
}

function findEnemy(active: readonly Enemy[], id: number): Enemy | null {
  for (let i = 0; i < active.length; i++) if (active[i].id === id && active[i].active) return active[i];
  return null;
}

function droneAlive(active: readonly Enemy[], id: number): boolean {
  const e = findEnemy(active, id);
  return !!e && e.type === 'rogue_scan_drone' && e.state !== 'dead' && e.state !== 'flee';
}

/**
 * `Enemy` keeps its host private (`bindHost`); the replica hooks get no host argument but need `playAudio` for the
 * hum. Read it through the runtime field instead of widening `Enemy` (not this file's to change).
 */
function hostOf(e: Enemy): Pick<EnemyHost, 'playAudio'> | null {
  const h = (e as unknown as { host?: Partial<Pick<EnemyHost, 'playAudio'>> | null }).host;
  return h && typeof h.playAudio === 'function' ? (h as Pick<EnemyHost, 'playAudio'>) : null;
}

/* ════════════════════════════════════════════════════════════════════════════
 * 호스트
 * ════════════════════════════════════════════════════════════════════════════ */

type SystemLike = Partial<Pick<EnemySystem, 'spawnRogue' | 'hosting'>>;

/**
 * 로든이 스캔 드론을 띄운다 (호스트에서만). 저격수 머리 위에서 스폰해 `target` 쪽으로 보낸다 — `namedData` 는
 * `ScanDroneData` (`./model`). 띄우지 못하면 null (리플리카 · 표적이 플레이어가 아님 · 이미 떠 있음 · 풀 가득).
 * 반환한 드론의 id 를 `SniperData.droneId` 에 적는 것은 호출자(Sniper.ts)다.
 */
export function launchScanDrone(host: EnemyHost, sniper: Enemy, target: CombatTarget): Enemy | null {
  if (host.replica || !sniper.active || sniper.state === 'dead' || target.enemy || target.id === 'ai') return null;
  const sd = sniperDataOf(sniper);
  if (sd && sd.droneId !== null && droneAlive(host.active, sd.droneId)) return null;
  for (let i = 0; i < host.active.length; i++) {
    const o = host.active[i];
    if (o.type !== 'rogue_scan_drone' || !o.active || o.state === 'dead' || o.state === 'flee') continue;
    if (scanDroneDataOf(o)?.sniperId === sniper.id) return null;
  }
  const sys = host as unknown as SystemLike;
  if (typeof sys.spawnRogue !== 'function') return null;

  const yaw = yawTo(sniper.position, target.position);
  // beside and above the sniper — `ai/Steering.separate` is 2-D, so spawning straight over a prone sniper would shove it
  _spawn.set(sniper.position.x + Math.cos(yaw) * LAUNCH_SIDE, sniper.position.y + LAUNCH_UP, sniper.position.z - Math.sin(yaw) * LAUNCH_SIDE);
  const e = sys.spawnRogue.call(host, 'rogue_scan_drone', _spawn, yaw, sniper.position, '', null);
  if (!e) return null;
  e.airborne = true;
  e.leaping = false;
  e.vy = 0;
  e.aware = true;
  e.relentless = true;
  e.state = 'chase';
  e.stateTime = 0;
  e.namedPhase = PHASE_SCAN;
  e.namedTimer = 0;
  e.namedHint = 0;
  e.namedCooldown = Math.random() * HUM_INTERVAL_S;
  const data: ScanDroneData = {
    kind: 'scanDrone',
    sniperId: sniper.id,
    targetId: target.id,
    pulses: 0,
    pulseTimer: NAMED_SCAN_DRONE.pulseInterval * 0.5,
    exposure: new Map(),
    done: false,
    loiter: 0,
    claimed: false,
    glinting: false,
    shotGrace: -1,
    leave: 0,
  };
  e.namedData = data;
  runtimeFor(host.ctx, host.active);
  return e;
}

export function updateScanDrone(e: Enemy, dt: number, host: EnemyHost, _t: CombatTarget | null, _targetAlive: boolean): void {
  const ctx = host.ctx;
  const world = ctx.world;
  if (!world) return;
  const rt = runtimeFor(ctx, host.active);
  rt.tick();
  const d = scanDroneDataOf(e);
  if (!d) {
    // spawned without `launchScanDrone` (debug spawn) or promoted from a replica (namedData is host-only): nothing to scan for
    retire(e, rt);
    return;
  }

  // stay out of the ground AI's hands: always airborne, aware, never investigating a shot or a lure
  e.airborne = true;
  e.leaping = false;
  e.aware = true;
  e.relentless = true;
  e.investigating = false;
  e.hasLure = false;
  e.structTarget = null;
  e.structAttack = false;

  // 전소 rides on `stagger` (the ground AI's stagger case never runs for us) — drift, no pulses, until it wears off
  let stunned = false;
  if (e.state === 'stagger') {
    e.staggerTimer -= dt;
    if (e.incapTimer > 0) e.incapTimer = Math.max(0, e.incapTimer - dt);
    if (e.staggerTimer <= 0 && e.incapTimer <= 0) { e.incapTimer = 0; e.state = 'chase'; e.stateTime = 0; }
    else stunned = true;
  } else if (e.state !== 'chase') { e.state = 'chase'; e.stateTime = 0; }

  if (e.namedTimer > 0) { e.namedTimer -= dt; e.namedHint = HINT_PULSE; } else e.namedHint = 0;

  e.namedCooldown -= dt;
  if (e.namedCooldown <= 0) {
    e.namedCooldown = HUM_INTERVAL_S;
    host.playAudio('scan_drone_hum', e.position, HUM_VOLUME);
  }

  const sniper = findEnemy(host.active, d.sniperId);
  const sniperOk = !!sniper && sniper.type === 'rogue_sniper' && sniper.state !== 'dead';
  const sd = sniperOk ? sniperDataOf(sniper!) : null;
  if (sd && sd.droneId === e.id) d.claimed = true;
  // Sniper.ts 의 신호: `resolvedDroneId === 내 id` = 로든이 이 스캔을 소모했다(쐈다 · 포기했다) → 노출을 풀고 복귀.
  // 신호를 못 봤더라도 한 번 붙잡혔던 드론을 `droneId` 에서 놓아 주면 같은 뜻이다.
  const resolved = !!sd && sd.resolvedDroneId === e.id;
  if (resolved) rt.clearDrone(e.id);
  const released = resolved || (d.claimed && (!sd || sd.droneId !== e.id));

  if (!sniperOk && e.namedPhase !== PHASE_ESCAPE) { e.namedPhase = PHASE_ESCAPE; d.leave = 0; }

  // watch the sniper's scanned-shot telegraph: its falling edge is the shot
  if (sd) {
    const glint = sd.glintLeft > 0 && sd.aimScanned;
    if (glint) { d.glinting = true; d.shotGrace = -1; }
    else if (d.glinting) { d.glinting = false; d.shotGrace = NAMED_SNIPER.fireInterval + NAMED_SNIPER.glintTime; }
  }

  const speed = NAMED_SCAN_DRONE.speed * e.slowFactor * (stunned ? STUN_SPEED : 1);
  const alt = NAMED_SCAN_DRONE.altitude;

  switch (e.namedPhase) {
    case PHASE_SCAN:
    case PHASE_LOITER: {
      if (released) { beginReturn(e, d); break; }
      let target = host.targets.get(d.targetId) ?? null;
      if (!target || !target.present || target.isDeadOrDowned) {
        // the player we followed is gone / down: take the nearest one still within the sniper's reach, else go home
        const next = host.targets.nearestAlive(e.position);
        const reach = NAMED_SNIPER.droneRange + NAMED_SCAN_DRONE.pulseRadius;
        if (next && sniper && next.dist2D(sniper.position) <= reach) { d.targetId = next.id; target = next; }
        else { beginReturn(e, d); break; }
      }
      const orbit = e.id * 1.7 + ctx.time * ORBIT_RATE;
      const gx = target.position.x + Math.cos(orbit) * ORBIT_RADIUS;
      const gz = target.position.z + Math.sin(orbit) * ORBIT_RADIUS;
      const gy = Math.max(world.getSurfaceY(e.position.x, e.position.z), world.getHeightAt(target.position.x, target.position.z)) + alt;
      const h = target.dist2D(e.position);
      const cap = h < NAMED_SCAN_DRONE.pulseRadius ? speed * FOLLOW_SPEED_FRAC : speed;
      _face.copy(target.position);
      fly(e, dt, host, gx, gy, gz, cap, _face);

      if (e.namedPhase === PHASE_SCAN) {
        if (!stunned && h <= NAMED_SCAN_DRONE.pulseRadius * SCAN_START_FRAC) {
          d.pulseTimer -= dt;
          if (d.pulseTimer <= 0) pulse(e, d, host, rt);
        }
      } else {
        d.loiter += dt;
        if (d.shotGrace > 0) {
          d.shotGrace -= dt;
          if (d.shotGrace <= 0) { beginReturn(e, d); break; }
        }
        if (d.loiter >= NAMED_SCAN_DRONE.loiterMax) beginReturn(e, d);
      }
      break;
    }
    case PHASE_RETURN: {
      d.leave += dt;
      if (!sniper) { e.namedPhase = PHASE_ESCAPE; d.leave = 0; break; }
      const h = Math.hypot(sniper.position.x - e.position.x, sniper.position.z - e.position.z);
      const home = h < HOME_RADIUS * 4;
      const gy = home
        ? sniper.position.y + HOME_HEIGHT
        : Math.max(world.getSurfaceY(e.position.x, e.position.z), sniper.position.y) + alt * 0.6;
      fly(e, dt, host, sniper.position.x, gy, sniper.position.z, speed, null);
      if ((h < HOME_RADIUS && Math.abs(e.position.y - gy) < 1.2) || d.leave >= RETURN_MAX_S) retire(e, rt);
      break;
    }
    default: {   // PHASE_ESCAPE — the sniper is dead: climb straight out and vanish
      d.leave += dt;
      fly(e, dt, host, e.position.x, e.position.y + ESCAPE_CLIMB, e.position.z, speed * 0.3, null);
      if (d.leave >= ESCAPE_S) retire(e, rt);
      break;
    }
  }
}

function beginReturn(e: Enemy, d: ScanDroneData): void {
  if (e.namedPhase === PHASE_RETURN || e.namedPhase === PHASE_ESCAPE) return;
  e.namedPhase = PHASE_RETURN;
  d.leave = 0;
}

/**
 * Leave the world through the system's own "fled" path: `flee` + a spent `fleeTimer` is despawned by
 * `EnemySystem.update` after the AI loop this same frame (`ee despawn` included) — calling `despawn` from inside the
 * AI loop would swap the array under it.
 */
function retire(e: Enemy, rt: ScanRuntime | null): void {
  rt?.clearDrone(e.id);
  e.namedHint = 0;
  e.namedTimer = 0;
  e.velocity.set(0, 0, 0);
  e.vy = 0;
  e.state = 'flee';
  e.fleeTimer = FLEE_DURATION;
}

/** Smooth 3-D flight toward `(gx, gy, gz)`: blended acceleration, arrival braking, obstacle clearance by altitude. */
function fly(e: Enemy, dt: number, host: EnemyHost, gx: number, gy: number, gz: number, maxSpeed: number, face: THREE.Vector3 | null): void {
  const world = host.ctx.world!;
  const pos = e.position;
  const k = 1 - Math.exp(-ACCEL_RATE * dt);

  // climb first when far below the cruise height (don't scrape across rooftops on the way up)
  const below = gy - pos.y;
  const climbFrac = THREE.MathUtils.clamp(1 - (below - 6) / 10, 0.25, 1);
  const cap = maxSpeed * climbFrac;

  const dx = gx - pos.x, dz = gz - pos.z;
  const dist = Math.hypot(dx, dz);
  let wantX = 0, wantZ = 0;
  if (dist > 0.05) {
    const s = Math.min(cap, dist * ARRIVE_GAIN) / dist;
    wantX = dx * s; wantZ = dz * s;
  }
  e.velocity.x += (wantX - e.velocity.x) * k;
  e.velocity.z += (wantZ - e.velocity.z) * k;
  e.velocity.y = 0;
  const wantVy = THREE.MathUtils.clamp(below * CLIMB_GAIN, -DESCEND_MAX, CLIMB_MAX);
  e.vy += (wantVy - e.vy) * Math.min(1, k * 2);

  const nx = pos.x + e.velocity.x * dt;
  const nz = pos.z + e.velocity.z * dt;
  if (world.isInsideBounds(nx, nz)) { pos.x = nx; pos.z = nz; }
  else { e.velocity.x = 0; e.velocity.z = 0; }
  pos.y += e.vy * dt;
  // clearance: the highest surface here and a little ahead (`getSurfaceY` without feet = tallest top)
  const floor = Math.max(
    world.getSurfaceY(pos.x, pos.z),
    world.getSurfaceY(pos.x + e.velocity.x * LOOKAHEAD_S, pos.z + e.velocity.z * LOOKAHEAD_S),
  ) + MIN_CLEARANCE;
  if (pos.y < floor) { pos.y = floor; if (e.vy < 0) e.vy = 0; }

  // yaw: into the flight while moving, toward the target while hovering
  const sp2 = e.velocity.x * e.velocity.x + e.velocity.z * e.velocity.z;
  const yawT = sp2 > 1 ? Math.atan2(e.velocity.x, e.velocity.z) : face ? yawTo(pos, face) : e.yaw;
  e.yaw = turnToward(e.yaw, yawT, e.stats.turnRate, dt);

  const a = e.anim;
  a.speed += (0.2 - a.speed) * Math.min(1, dt * 5);
  a.aim = 0; a.crouch = 0; a.shake = 0;
  e.distTravelled += Math.sqrt(sp2) * dt;
}

function pulse(e: Enemy, d: ScanDroneData, host: EnemyHost, rt: ScanRuntime): void {
  const ctx = host.ctx;
  const world = ctx.world!;
  const r = NAMED_SCAN_DRONE.pulseRadius;
  const total = NAMED_SNIPER.scanPulses;
  d.pulses++;
  d.pulseTimer = NAMED_SCAN_DRONE.pulseInterval;
  e.namedTimer = PULSE_HINT_S;
  e.namedHint = HINT_PULSE;

  const sys = host as unknown as SystemLike;
  const net = ctx.net;
  const tg: PeerId[] | null = sys.hosting === true && net ? [] : null;
  let exposedLocal = false;
  _origin.copy(e.position);
  _origin.y += 0.2;   // under the scanner dish, below the hull
  const alive = host.targets.alive;
  for (let i = 0; i < alive.length; i++) {
    const t = alive[i];
    if (t.enemy || t.id === 'ai') continue;
    const dx = t.position.x - e.position.x, dz = t.position.z - e.position.z;
    if (dx * dx + dz * dz > r * r) continue;
    if (t.stealth < SCAN_STEALTH_MIN) continue;
    t.getChest(_chest);
    _dir.subVectors(_chest, _origin);
    const len = _dir.length();
    if (len > 0.3) {
      _dir.multiplyScalar(1 / len);
      if (world.raycast(_origin, _dir, len - 0.3)) continue;   // roof / wall / hill between the drone and the chest
    }
    d.exposure.set(t.id, (d.exposure.get(t.id) ?? 0) + 1);
    if (t.id === 'local') {
      exposedLocal = true;
      if (tg && net && net.localId) tg.push(net.localId);
    } else if (tg) tg.push(t.id as PeerId);
  }
  if (d.pulses >= total) { d.done = true; e.namedPhase = PHASE_LOITER; d.loiter = 0; }

  rt.spawnFx(e.position, world.getHeightAt(e.position.x, e.position.z), r);
  host.playAudio('scan_pulse', e.position, 1);
  ctx.bus.emit('named:scanPulse', { enemyId: e.id, position: e.position.clone(), radius: r, index: d.pulses, total, exposedLocal });
  rt.onPulse(e.id, d.sniperId, exposedLocal, exposedLocal ? d.exposure.get('local') : undefined, total);
  if (tg && net) net.send({ t: 'ee', ev: 'scanPulse', id: e.id, p: tuple(e.position, 2), r: round(r, 1), n: d.pulses, of: total, tg }, 'others');
}

/* ════════════════════════════════════════════════════════════════════════════
 * 리플리카 (비호스트) — AI 없음, 연출 · 로컬 노출만
 * ════════════════════════════════════════════════════════════════════════════ */

/** Before the snapshot pose lands: remember last frame's height (vertical speed) and keep `Replica` off the terrain snap. */
export function beforeScanDroneReplica(e: Enemy, _hint: number): void {
  e.namedTimer = e.position.y;
  e.airborne = true;
  e.leaping = false;
}

/** After the default animation targets: vertical speed for a mid-air kill (`Enemy.kill` → `deathVy`), no humanoid pose, hum. */
export function afterScanDroneReplica(e: Enemy, _hint: number, dt: number): void {
  if (dt > 0) e.vy = THREE.MathUtils.clamp((e.position.y - e.namedTimer) / dt, -CORPSE_FALL_MAX_SPEED, CORPSE_FALL_MAX_SPEED);
  const a = e.anim;
  a.aim = 0; a.crouch = 0; a.shake = 0;
  runtime?.tick();
  e.namedCooldown -= dt;
  if (e.namedCooldown <= 0) {
    e.namedCooldown = HUM_INTERVAL_S;
    hostOf(e)?.playAudio('scan_drone_hum', e.position, HUM_VOLUME);
  }
}

/** `ee scanPulse`: the pulse FX, `scan_pulse`, `named:scanPulse` and the local exposure count (`tg` names us). */
export function onScanDroneEvent(host: ReplicaHost, msg: Extract<EnemyEvent, { ev: 'scanPulse' }>): void {
  if (!isVec3Tuple(msg.p)) return;
  const ctx = host.ctx;
  const rt = runtimeFor(ctx, host.active);
  rt.tick();
  _p.set(msg.p[0], msg.p[1], msg.p[2]);
  const r = Number.isFinite(msg.r) ? THREE.MathUtils.clamp(msg.r, 1, 200) : NAMED_SCAN_DRONE.pulseRadius;
  const total = Number.isFinite(msg.of) && msg.of > 0 ? msg.of : NAMED_SNIPER.scanPulses;
  const index = Number.isFinite(msg.n) ? msg.n : 0;
  const world = ctx.world;
  const ground = world && world.ready ? world.getHeightAt(_p.x, _p.z) : _p.y - NAMED_SCAN_DRONE.altitude;
  rt.spawnFx(_p, ground, r);
  host.playAudio('scan_pulse', _p, 1);
  const localId = ctx.net?.localId ?? null;
  const exposedLocal = localId !== null && Array.isArray(msg.tg) && msg.tg.indexOf(localId) >= 0;
  const drone = host.find(msg.id);
  if (drone && drone.state !== 'dead') drone.namedHint = HINT_PULSE;   // the next snapshot confirms it
  ctx.bus.emit('named:scanPulse', { enemyId: msg.id, position: _p.clone(), radius: r, index, total, exposedLocal });
  rt.onPulse(msg.id, null, exposedLocal, undefined, total);
}
