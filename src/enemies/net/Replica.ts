import * as THREE from 'three';
import {
  NET_INTERP_DELAY, type EnemyEvent, type EnemySnapshot, type EnemyType, type EnemyWireState, type GameContext,
} from '@/shared';
import type { Enemy } from '../Enemy';
import type { CombatTarget, TargetList } from '../Targets';
import { applySlope, lookAtTarget } from '../ai/EnemyAI';

/* ────────────────────────────────────────────────────────────────────────────
 * Client-side enemy replicas (joined multiplayer clients, `!ctx.isAuthority`).
 * The host streams EnemySnapshots (10 Hz) + EnemyEvents; this module buffers them per enemy, renders the
 * interpolated pose NET_INTERP_DELAY behind arrival, and drives the bug animation from the wire state so the
 * same BugRig / animateBug path is used as on the host. No AI, spawner, waves or damage run here.
 * ──────────────────────────────────────────────────────────────────────────── */

const RING = 8;
const MAX_EXTRAPOLATE = 0.25;
const TWO_PI = Math.PI * 2;

interface Sample {
  t: number;              // arrival time (ctx.time)
  x: number; y: number; z: number;
  yaw: number;
  hp: number;
  st: EnemyWireState;
  a: number;
}

interface Pose { x: number; y: number; z: number; yaw: number }

/** Fixed-size ring of the last snapshots for one enemy (preallocated, reused across pool cycles). */
export class ReplicaBuffer {
  private readonly s: Sample[] = [];
  private head = 0;          // next write index
  count = 0;
  /** Snapshot sequence in which this enemy was last seen (missing from a full snapshot → despawn). */
  seenSeq = 0;

  constructor() {
    for (let i = 0; i < RING; i++) this.s.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0, hp: 0, st: 'idle', a: 0 });
  }

  clear(): void { this.head = 0; this.count = 0; this.seenSeq = 0; }

  push(t: number, x: number, y: number, z: number, yaw: number, hp: number, st: EnemyWireState, a: number): void {
    const smp = this.s[this.head];
    smp.t = t; smp.x = x; smp.y = y; smp.z = z; smp.yaw = yaw; smp.hp = hp; smp.st = st; smp.a = a;
    this.head = (this.head + 1) % RING;
    if (this.count < RING) this.count++;
  }

  /** i = 0 oldest … count-1 newest */
  private at(i: number): Sample { return this.s[(this.head - this.count + i + RING) % RING]; }

  latest(): Sample | null { return this.count === 0 ? null : this.at(this.count - 1); }

  /** Interpolated (or ≤ MAX_EXTRAPOLATE s extrapolated) pose at `time`. Returns false when empty. */
  sampleAt(time: number, out: Pose): boolean {
    const n = this.count;
    if (n === 0) return false;
    const last = this.at(n - 1);
    if (n === 1 || time <= this.at(0).t) {
      const s0 = n === 1 ? last : this.at(0);
      out.x = s0.x; out.y = s0.y; out.z = s0.z; out.yaw = s0.yaw;
      return true;
    }
    if (time >= last.t) {
      // extrapolate with the velocity implied by the last two samples
      const prev = this.at(n - 2);
      const gap = last.t - prev.t;
      const dtx = Math.min(MAX_EXTRAPOLATE, time - last.t);
      if (gap > 1e-3 && gap < 0.6) {
        const k = dtx / gap;
        out.x = last.x + (last.x - prev.x) * k;
        out.y = last.y + (last.y - prev.y) * k;
        out.z = last.z + (last.z - prev.z) * k;
      } else { out.x = last.x; out.y = last.y; out.z = last.z; }
      out.yaw = last.yaw;
      return true;
    }
    for (let i = n - 2; i >= 0; i--) {
      const s0 = this.at(i), s1 = this.at(i + 1);
      if (time >= s0.t) {
        const span = s1.t - s0.t;
        const f = span > 1e-6 ? (time - s0.t) / span : 1;
        out.x = s0.x + (s1.x - s0.x) * f;
        out.y = s0.y + (s1.y - s0.y) * f;
        out.z = s0.z + (s1.z - s0.z) * f;
        let dy = s1.yaw - s0.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        out.yaw = s0.yaw + dy * f;
        return true;
      }
    }
    out.x = last.x; out.y = last.y; out.z = last.z; out.yaw = last.yaw;
    return true;
  }
}

/** What the replica manager needs from EnemySystem. */
export interface ReplicaHost {
  readonly ctx: GameContext;
  readonly targets: TargetList;
  readonly active: readonly Enemy[];
  find(id: number): Enemy | undefined;
  /** Get-or-create a pooled Enemy carrying the host's id. Silent: no `enemy:spawned`. */
  acquire(id: number, type: EnemyType, position: THREE.Vector3, yaw: number): Enemy | null;
  /** Deactivate back to the pool (no network side effects). */
  release(e: Enemy): void;
  bloodBurst(point: THREE.Vector3, count: number, dir: THREE.Vector3 | null): void;
  playAudio(id: string, position: THREE.Vector3, volume?: number, pitch?: number): void;
  /** Visual-only acid glob from `from` toward the target's current feet position. */
  acidVisual(from: THREE.Vector3, target: CombatTarget, shooterId: number): void;
}

const _pose: Pose = { x: 0, y: 0, z: 0, yaw: 0 };
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();

export class EnemyReplica {
  private seq = 0;

  constructor(private readonly host: ReplicaHost) {}

  clear(): void { this.seq = 0; }

  /* ── inbound ──────────────────────────────────────────────────────────── */
  onSnapshot(msg: EnemySnapshot): void {
    const host = this.host;
    const now = host.ctx.time;
    const seq = ++this.seq;
    const list = msg.e;
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      let e = host.find(w.id);
      if (e && e.type !== w.ty) { host.release(e); e = undefined; }
      if (!e) {
        _p.set(w.p[0], w.p[1], w.p[2]);
        e = host.acquire(w.id, w.ty, _p, w.yaw) ?? undefined;
        if (!e) continue;
      }
      const buf = e.netBuf ?? (e.netBuf = new ReplicaBuffer());
      buf.push(now, w.p[0], w.p[1], w.p[2], w.yaw, w.hp, w.st, w.a ?? 0);
      buf.seenSeq = seq;
    }
    if (msg.full) {
      const active = host.active;
      for (let i = active.length - 1; i >= 0; i--) {
        const e = active[i];
        if (!e.active) continue;
        if (!e.netBuf || e.netBuf.seenSeq !== seq) host.release(e);
      }
    }
  }

  onEvent(msg: EnemyEvent): void {
    const host = this.host;
    const ctx = host.ctx;
    switch (msg.ev) {
      case 'spawn': {
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        let e = host.find(msg.id);
        if (e && e.type !== msg.ty) { host.release(e); e = undefined; }
        if (!e) e = host.acquire(msg.id, msg.ty, _p, msg.yaw) ?? undefined;
        if (!e) return;
        const buf = e.netBuf ?? (e.netBuf = new ReplicaBuffer());
        if (buf.count === 0) buf.push(ctx.time, _p.x, _p.y, _p.z, msg.yaw, e.maxHp, 'idle', 0);
        ctx.bus.emit('enemy:spawned', { id: e.id, type: e.type, position: e.position });
        return;
      }
      case 'kill': {
        const e = host.find(msg.id);
        if (e && e.active) {
          e.hp = 0;
          e.kill(false);                       // death anim + gore + bug_death via host.onEnemyKilled
        }
        const localId = ctx.net?.localId ?? null;
        if (msg.killer !== null && msg.killer === localId) {
          ctx.stats.kills++;
          _p.set(msg.p[0], msg.p[1], msg.p[2]);
          ctx.bus.emit('enemy:killed', { id: msg.id, type: msg.ty, position: e ? e.position : _p.clone() });
        }
        return;
      }
      case 'despawn': {
        const e = host.find(msg.id);
        if (e) host.release(e);
        return;
      }
      case 'damaged': {
        const e = host.find(msg.id);
        if (!e || !e.active) return;
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        const echo = ctx.time - e.lastLocalHit < 0.4;   // our own hit already flashed optimistically
        if (!echo) {
          const a = e.anim;
          a.hitFlash = 1;
          a.flinch = Math.min(1, a.flinch + Math.min(1, msg.amount / e.maxHp * 4 + 0.25));
          if (msg.d) {
            _d.set(msg.d[0], msg.d[1], msg.d[2]);
            const s = Math.sin(e.yaw), c = Math.cos(e.yaw);
            a.flinchX = -(_d.x * c - _d.z * s);
            a.flinchZ = (_d.x * s + _d.z * c);
            host.bloodBurst(_p, 8, _d);
          } else { a.flinchX = (Math.random() - 0.5) * 2; a.flinchZ = 0.3; host.bloodBurst(_p, 8, null); }
          host.playAudio('bug_hit', e.position, 0.6, 0.9 + Math.random() * 0.2);
        }
        ctx.bus.emit('enemy:damaged', { id: e.id, type: e.type, amount: msg.amount, position: e.position, hp: Math.max(0, e.hp - msg.amount) });
        return;
      }
      case 'attack': {
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        host.playAudio('bug_attack', _p, 1, msg.ty === 'charger' ? 0.6 : msg.ty === 'warrior' ? 0.8 : 1.05);
        if (msg.target === ctx.net?.localId) {
          // the damage itself arrives as a `dmg` message (applied by net); mirror the HUD/audio event here
          const e = host.find(msg.id);
          ctx.bus.emit('enemy:attacked', { id: msg.id, type: msg.ty, damage: msg.damage, position: e ? e.position : _p.clone() });
        }
        return;
      }
      case 'acid': {
        const localId = ctx.net?.localId;
        const target = msg.target === localId ? host.targets.local() : host.targets.get(msg.target);
        if (!target) return;
        _p.set(msg.from[0], msg.from[1], msg.from[2]);
        host.acidVisual(_p, target, msg.id);
        return;
      }
      case 'wave':
        ctx.bus.emit('enemy:waveStarted', { index: msg.index, count: msg.count });
        return;
    }
  }

  /* ── per frame ────────────────────────────────────────────────────────── */
  update(dt: number): void {
    const host = this.host;
    const ctx = host.ctx;
    const world = ctx.world;
    if (!world || !world.ready) return;
    const renderT = ctx.time - NET_INTERP_DELAY;
    const active = host.active;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (!e.active) continue;
      if (e.state === 'dead') { e.deathTimer += dt; continue; }
      const buf = e.netBuf;
      if (!buf) continue;
      const latest = buf.latest();
      if (!latest) continue;
      if (latest.st === 'dead') { e.hp = 0; e.kill(false); continue; }
      if (!buf.sampleAt(renderT, _pose)) continue;
      this.drive(e, latest, dt, world);
    }
  }

  private drive(e: Enemy, latest: Sample, dt: number, world: NonNullable<GameContext['world']>): void {
    const a = e.anim;
    const s = e.stats;
    const px = e.position.x, pz = e.position.z;
    const hint = latest.a;

    e.airborne = hint === 4;
    e.leaping = e.airborne;
    e.chargePhase = hint === 1 ? 1 : hint === 2 ? 2 : 0;
    e.spitPhase = hint === 3 ? 1 : 0;
    e.position.set(_pose.x, _pose.y, _pose.z);
    if (!e.airborne) e.position.y = world.getHeightAt(_pose.x, _pose.z);   // hide small height mismatches
    e.yaw = _pose.yaw;
    e.hp = latest.hp;
    e.state = latest.st;
    e.aware = latest.st !== 'idle' && latest.st !== 'wander';
    if (latest.st === 'flee') e.fleeTimer += dt;

    // gait from displacement
    const dx = e.position.x - px, dz = e.position.z - pz;
    const moved = Math.hypot(dx, dz);
    if (dt > 0) e.velocity.set(dx / dt, 0, dz / dt);
    a.gait += (moved / e.rig.params.strideLength) * TWO_PI;
    if (a.gait > 1e6) a.gait -= 1e6;
    const spd = dt > 0 ? moved / dt : 0;
    const targetAnimSpeed = e.airborne ? 0.2 : Math.min(1, spd / Math.max(1, s.speed * 0.8));
    a.speed += (targetAnimSpeed - a.speed) * Math.min(1, dt * 8);

    // animation targets from state + hint (mirrors what the host AI would be setting)
    let shakeT = 0, abdT = 0, crouchT = 0, mandT = e.aware ? 0.25 : 0, pitchT: number | null = null;
    switch (latest.st) {
      case 'alert': crouchT = 0.25; mandT = 0.7; break;
      case 'attack': mandT = 1; break;
      case 'stagger': crouchT = e.type === 'charger' ? 0.5 : 0.3; pitchT = 0.35; break;
      default: break;
    }
    if (hint === 1) { shakeT = 1; crouchT = a.shake * 0.35; mandT = 1; }
    else if (hint === 2) { mandT = 1; pitchT = -0.2; }
    else if (hint === 3) { abdT = 1; crouchT = a.abdomen * 0.2; mandT = a.abdomen; }
    else if (hint === 4) { crouchT = -0.3; mandT = 1; pitchT = 0.3; }
    a.shake += (shakeT - a.shake) * Math.min(1, dt * (shakeT > 0 ? 2.5 : 4));
    a.abdomen += (abdT - a.abdomen) * Math.min(1, dt * (abdT > 0 ? 3 : 2));
    a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 8);
    a.mandible += (mandT - a.mandible) * Math.min(1, dt * 10);

    // head: track the nearest player while aware, idle sway otherwise
    const look = e.aware && hint !== 2 ? this.host.targets.nearestAlive(e.position) : null;
    if (look) lookAtTarget(e, look, dt);
    else {
      a.headYaw = THREE.MathUtils.lerp(a.headYaw, hint === 2 ? 0 : Math.sin(a.time * 0.7) * 0.35, dt * 3);
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, Math.sin(a.time * 1.1) * 0.1, dt * 3);
    }
    if (pitchT !== null) a.headPitch = THREE.MathUtils.lerp(a.headPitch, pitchT, dt * 6);

    if (!e.airborne) applySlope(e, world, dt);
  }
}
