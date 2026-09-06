import * as THREE from 'three';
import {
  BURNOUT_DURATION, ENEMY_STATUS_BITS, NET_INTERP_DELAY, type EnemyEvent, type EnemySnapshot, type EnemyType, type EnemyWireState, type GameContext,
} from '@/shared';
import type { Enemy } from '../Enemy';
import type { CombatTarget, TargetList } from '../Targets';
import { applySlope } from '../ai/EnemyAI';
import { lookAtTarget } from '../ai/Common';

/* ────────────────────────────────────────────────────────────────────────────
 * Client-side enemy replicas (joined multiplayer clients, `!ctx.isAuthority`).
 * The host streams EnemySnapshots (10 Hz) + EnemyEvents; this module buffers them per enemy, renders the
 * interpolated pose NET_INTERP_DELAY behind arrival, and drives the bug / rogue animation from the wire state so the
 * same rig path is used as on the host. No AI, spawner, waves or damage run here.
 * Phase 4: hints 5–11, `w` (rogue rifle), and the `shoot / shell / intercept / shellHit / charge / toxic / corpse /
 * corpseGone` events are mirrored through `ReplicaHost`.
 * ──────────────────────────────────────────────────────────────────────────── */

const RING = 8;
const MAX_EXTRAPOLATE = 0.25;
const TWO_PI = Math.PI * 2;
/**
 * A status bit seen in a snapshot keeps the matching visual timer alive at least this long (snapshots arrive every
 * 0.1 s); a bit that is gone clamps an optimistic local timer down to it so the effect fades within a beat.
 */
const STATUS_HOLD = 0.35;

export interface Sample {
  t: number;              // arrival time (ctx.time)
  x: number; y: number; z: number;
  yaw: number;
  hp: number;
  st: EnemyWireState;
  a: number;
  /** status bits (`ENEMY_STATUS_BITS`) */
  sb: number;
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
    for (let i = 0; i < RING; i++) this.s.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0, hp: 0, st: 'idle', a: 0, sb: 0 });
  }

  clear(): void { this.head = 0; this.count = 0; this.seenSeq = 0; }

  push(t: number, x: number, y: number, z: number, yaw: number, hp: number, st: EnemyWireState, a: number, sb = 0): void {
    const smp = this.s[this.head];
    smp.t = t; smp.x = x; smp.y = y; smp.z = z; smp.yaw = yaw; smp.hp = hp; smp.st = st; smp.a = a; smp.sb = sb;
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
  /* ── Phase 4 (visual mirrors of host events) ── */
  rogueShotVisual(id: number, from: THREE.Vector3, to: THREE.Vector3, hit: boolean): void;
  shellVisual(sid: number, from: THREE.Vector3, target: THREE.Vector3, flight: number): void;
  shellInterceptedRemote(sid: number, p: THREE.Vector3): void;
  shellLandedRemote(sid: number, p: THREE.Vector3): void;
  chargeVisual(id: number, target: THREE.Vector3): void;
  toxicVisual(id: number, p: THREE.Vector3): void;
  corpseSpawnedRemote(id: number, type: EnemyType, p: THREE.Vector3, weaponId: string | undefined): void;
  corpseGoneRemote(id: number): void;
  /* ── Phase 7 (rogue AI v2) ── */
  /** Visual rogue grenade from `ee grenade` (position / velocity / fuse as thrown on the host). */
  grenadeVisual(id: number, p: THREE.Vector3, v: THREE.Vector3, fuse: number): void;
  /** Host's `grenadeHit`: pop the local copy (or just the FX) at `p`. */
  grenadeHitRemote(p: THREE.Vector3): void;
}

const _pose: Pose = { x: 0, y: 0, z: 0, yaw: 0 };
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
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
      if (w.w) e.weaponId = w.w;
      const buf = e.netBuf ?? (e.netBuf = new ReplicaBuffer());
      buf.push(now, w.p[0], w.p[1], w.p[2], w.yaw, w.hp, w.st, w.a ?? 0, w.sb ?? 0);
      buf.seenSeq = seq;
    }
    if (msg.full) {
      const active = host.active;
      for (let i = active.length - 1; i >= 0; i--) {
        const e = active[i];
        if (!e.active) continue;
        // corpses drop out of the host's snapshot after ~1.5 s but stay lootable: our own corpse timer removes them
        if (e.state === 'dead') continue;
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
        host.playAudio('bug_attack', _p, 1, msg.ty === 'behemoth' ? 0.4 : msg.ty === 'charger' ? 0.6 : msg.ty === 'warrior' ? 0.8 : 1.05);
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
      /* ── Phase 4 ── */
      case 'shoot': {
        _p.set(msg.from[0], msg.from[1], msg.from[2]);
        _p2.set(msg.to[0], msg.to[1], msg.to[2]);
        const e = host.find(msg.id);
        if (e) e.anim.recoil = 1;
        host.rogueShotVisual(msg.id, _p, _p2, msg.hit);
        return;
      }
      case 'shell': {
        _p.set(msg.from[0], msg.from[1], msg.from[2]);
        _p2.set(msg.target[0], msg.target[1], msg.target[2]);
        host.shellVisual(msg.sid, _p, _p2, msg.flight);
        return;
      }
      case 'intercept':
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        host.shellInterceptedRemote(msg.sid, _p);
        return;
      case 'shellHit':
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        host.shellLandedRemote(msg.sid, _p);
        return;
      case 'charge': {
        _p.set(msg.target[0], msg.target[1], msg.target[2]);
        host.chargeVisual(msg.id, _p);
        return;
      }
      case 'toxic':
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        host.toxicVisual(msg.id, _p);
        return;
      case 'corpse': {
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        const e = host.find(msg.id);
        if (e && msg.w) e.weaponId = msg.w;
        host.corpseSpawnedRemote(msg.id, msg.ty, _p, msg.w);
        return;
      }
      case 'corpseGone':
        host.corpseGoneRemote(msg.id);
        return;
      /* ── Phase 7 ── */
      case 'grenade': {
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        _p2.set(msg.v[0], msg.v[1], msg.v[2]);
        host.grenadeVisual(msg.id, _p, _p2, msg.fuse);
        return;
      }
      case 'grenadeHit':
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        host.grenadeHitRemote(_p);
        return;
    }
  }

  /**
   * Phase 7 (host → client demotion): keep `e` rendering as a replica until the new host's first snapshot arrives.
   * Seeds the ring buffer with the current pose / hp / state so `update` has something to sample; the enemy still
   * drops out on the next full snapshot that does not list it.
   */
  adopt(e: Enemy, now: number): void {
    const buf = e.netBuf ?? (e.netBuf = new ReplicaBuffer());
    buf.clear();
    buf.push(now, e.position.x, e.position.y, e.position.z, e.yaw, e.hp, e.state as EnemyWireState, 0, 0);
    buf.seenSeq = this.seq;
  }

  /** Newest wire sample of a replica (promotion seeds the simulated enemy from it), or null. */
  latestOf(e: Enemy): Sample | null { return e.netBuf ? e.netBuf.latest() : null; }

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
    const rogue = e.isRogue;

    e.airborne = hint === 4;
    e.leaping = e.airborne;
    e.chargePhase = hint === 1 || hint === 10 ? 1 : hint === 2 || hint === 11 ? 2 : 0;
    e.spitPhase = hint === 3 ? 1 : 0;
    e.toxicPhase = hint === 9 ? 1 : 0;
    e.dug = hint === 8 ? 1 : 0;
    e.roguePhase = hint === 5 ? 3 : hint === 6 ? 2 : hint === 7 ? 4 : 0;
    // Phase 7: hold the reload / throw timers so Enemy.animate blends the same poses the host shows
    if (rogue) {
      e.reloadTimer = hint === 12 ? STATUS_HOLD : 0;
      e.throwTimer = hint === 13 ? STATUS_HOLD : 0;
    }
    e.position.set(_pose.x, _pose.y, _pose.z);
    if (!e.airborne) e.position.y = world.getHeightAt(_pose.x, _pose.z);   // hide small height mismatches
    e.yaw = _pose.yaw;
    e.hp = latest.hp;
    e.state = latest.st;
    e.aware = latest.st !== 'idle' && latest.st !== 'wander';
    if (latest.st === 'flee') e.fleeTimer += dt;
    this.applyStatusBits(e, latest.sb);

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
    let aimT = rogue && e.aware ? 0.5 : 0;
    switch (latest.st) {
      case 'alert': crouchT = rogue ? 0 : 0.25; mandT = 0.7; if (rogue) aimT = 0.8; break;
      case 'attack': mandT = 1; break;
      case 'stagger': crouchT = e.type === 'charger' || e.type === 'behemoth' || rogue ? 0.5 : 0.3; pitchT = 0.35; break;
      default: break;
    }
    switch (hint) {
      case 1: shakeT = 1; crouchT = a.shake * 0.35; mandT = 1; break;
      case 2: mandT = 1; pitchT = -0.2; break;
      case 3: abdT = 1; crouchT = a.abdomen * 0.2; mandT = a.abdomen; break;
      case 4: crouchT = -0.3; mandT = 1; pitchT = 0.3; break;
      case 5: aimT = 1; crouchT = 0; break;
      case 6: aimT = 0.35; crouchT = 1; break;
      case 7: aimT = 1; crouchT = 0; break;
      case 8: crouchT = 0.8; mandT = 0.4; break;
      case 9: abdT = 1; crouchT = 0.25; mandT = 1; break;
      case 10: shakeT = 1; crouchT = a.shake * 0.3; mandT = 1; break;
      case 11: mandT = 1; pitchT = -0.2; break;
      case 12: aimT = 0.25; crouchT = 1; break;          // Phase 7: reloading
      case 13: aimT = 0.2; crouchT = 0; break;           // Phase 7: grenade wind-up
      default: break;
    }
    a.shake += (shakeT - a.shake) * Math.min(1, dt * (shakeT > 0 ? 2.5 : 4));
    a.abdomen += (abdT - a.abdomen) * Math.min(1, dt * (abdT > 0 ? 3 : 2));
    a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 8);
    a.mandible += (mandT - a.mandible) * Math.min(1, dt * 10);
    a.aim += (aimT - a.aim) * Math.min(1, dt * (aimT > a.aim ? 7 : 3));

    // head: track the nearest player while aware, idle sway otherwise
    const look = e.aware && hint !== 2 && hint !== 11 ? this.host.targets.nearestAlive(e.position) : null;
    if (look) lookAtTarget(e, look, dt);
    else {
      a.headYaw = THREE.MathUtils.lerp(a.headYaw, hint === 2 || hint === 11 ? 0 : Math.sin(a.time * 0.7) * 0.35, dt * 3);
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, Math.sin(a.time * 1.1) * 0.1, dt * 3);
    }
    if (pitchT !== null) a.headPitch = THREE.MathUtils.lerp(a.headPitch, pitchT, dt * 6);

    if (!e.airborne) applySlope(e, world, dt);
  }

  /**
   * Mirror the host's status bits (`EnemyWire.sb`) into the local visual timers: burning embers, the 전소 writhe and
   * the shock spark all run from the same fields the authority uses, so `EnemySystem.updateStatuses` / `Enemy.animate`
   * render them unchanged. A bit that rises while the local timer is idle also emits the matching bus event
   * (`enemy:incinerated` / `enemy:shocked`) — an optimistic local `applyStatus` already set the timer, so no double emit.
   */
  private applyStatusBits(e: Enemy, sb: number): void {
    const bus = this.host.ctx.bus;
    if (sb & ENEMY_STATUS_BITS.INCINERATED) {
      if (e.incapTimer <= 0) bus.emit('enemy:incinerated', { id: e.id, position: e.position, duration: BURNOUT_DURATION });
      e.incapTimer = Math.max(e.incapTimer, STATUS_HOLD);
    } else if (e.incapTimer > STATUS_HOLD) e.incapTimer = STATUS_HOLD;
    if (sb & ENEMY_STATUS_BITS.SHOCKED) {
      if (e.shockTimer <= 0) bus.emit('enemy:shocked', { id: e.id, position: e.position });
      e.shockTimer = Math.max(e.shockTimer, STATUS_HOLD);
    } else if (e.shockTimer > STATUS_HOLD) e.shockTimer = STATUS_HOLD;
    if (sb & ENEMY_STATUS_BITS.BURNING) e.burnTimer = Math.max(e.burnTimer, STATUS_HOLD);
    else if (e.burnTimer > STATUS_HOLD) e.burnTimer = STATUS_HOLD;
    if (sb & ENEMY_STATUS_BITS.SLOWED) e.slowTimer = Math.max(e.slowTimer, STATUS_HOLD);
    else if (e.slowTimer > STATUS_HOLD) e.slowTimer = STATUS_HOLD;
  }
}
