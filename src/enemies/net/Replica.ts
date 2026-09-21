import * as THREE from 'three';
import {
  BURNOUT_DURATION, ENEMY_DEATH_DIRS, ENEMY_GRENADE_KINDS, ENEMY_STATUS_BITS, NET_INTERP_DELAY, type EnemyEvent, type EnemyGrenadeKind, type EnemySnapshot, type EnemyType, type EnemyWire, type EnemyWireState, type GameContext,
} from '@/shared';
import type { Enemy } from '../Enemy';
import type { CorpseWireOpts } from '../Corpses';
import type { CombatTarget, TargetList } from '../Targets';
import { applySlope, footfall, integrateDeathFall } from '../ai/EnemyAI';
import { goreKindOf, hurtSound, meleeHitSound } from '../model';
import { replicaRidePredict } from '../ai/Ride';
import { lookAtTarget } from '../ai/Common';
/* 2026-09-11: named rogues · the scan drone */
import { isNamedAiType } from '../ai/named';
import { afterNamedReplica, beforeNamedReplica, onNamedEvent } from '../ai/named/remote';
import type { NamedRogueDirector } from '../named/Director';
/* 2026-09-13: burrow spawns · the sandworm */
import { stepSpatFlight } from '../ai/Burrow';
import { applyWormHint } from '../sandworm/Pose';
import { isWormType, raidXpOf } from '../EnemyTypes';

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
  /**
   * `EnemySnapshot.seq` of the last snapshot that touched this enemy (listed in it, or held through a delta that
   * omitted it). A keyframe releases every live replica whose `seenSeq` is not its own seq.
   */
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

  /**
   * Phase 9: apply a (possibly partial) wire on top of the newest sample as a new sample stamped `now`. Fields absent
   * from `w` keep their last value; in a `keyframe` an absent `a` / `sb` means 0 (the host omits zeros there).
   * `push` stays the seeding path (`ee spawn`, `adopt`).
   */
  applyWire(now: number, w: EnemyWire, keyframe: boolean): void {
    const prev = this.latest();
    const smp = this.s[this.head];
    if (prev) { smp.x = prev.x; smp.y = prev.y; smp.z = prev.z; smp.yaw = prev.yaw; smp.hp = prev.hp; smp.st = prev.st; smp.a = prev.a; smp.sb = prev.sb; }
    else { smp.x = 0; smp.y = 0; smp.z = 0; smp.yaw = 0; smp.hp = 0; smp.st = 'idle'; smp.a = 0; smp.sb = 0; }
    if (w.p) { smp.x = w.p[0]; smp.y = w.p[1]; smp.z = w.p[2]; }
    if (w.yaw !== undefined) smp.yaw = w.yaw;
    if (w.hp !== undefined) smp.hp = w.hp;
    if (w.st !== undefined) smp.st = w.st;
    if (keyframe) { smp.a = w.a ?? 0; smp.sb = w.sb ?? 0; }
    else {
      if (w.a !== undefined) smp.a = w.a;
      if (w.sb !== undefined) smp.sb = w.sb;
    }
    smp.t = now;
    this.head = (this.head + 1) % RING;
    if (this.count < RING) this.count++;
  }

  /**
   * Phase 9: the enemy was absent from a delta (nothing changed on the host) — repeat the newest sample at `now` so
   * the interpolator sees a stationary target instead of extrapolating the last movement past the stop.
   */
  hold(now: number): void {
    const prev = this.latest();
    if (!prev) return;
    const smp = this.s[this.head];
    smp.x = prev.x; smp.y = prev.y; smp.z = prev.z; smp.yaw = prev.yaw; smp.hp = prev.hp; smp.st = prev.st; smp.a = prev.a; smp.sb = prev.sb;
    smp.t = now;
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
  /** 2026-09-20: this frame's ear — a replica plays footsteps too (`model.emitEnemyStep`). See `EnemyHost.camPos`. */
  readonly camPos: THREE.Vector3;
  find(id: number): Enemy | undefined;
  /** Get-or-create a pooled Enemy carrying the host's id. Silent: no `enemy:spawned`. */
  acquire(id: number, type: EnemyType, position: THREE.Vector3, yaw: number): Enemy | null;
  /**
   * 2026-09-11 (C-52): the named-rogue director (`EnemySystem.named`). A snapshot that creates a replica silently (a late
   * joiner missed `ee spawn`) still owes `enemy:namedSpawned` — once per id, shared with the `enemy:spawned` path.
   */
  readonly named: Pick<NamedRogueDirector, 'onReplicaCreated'>;
  /** Deactivate back to the pool (no network side effects). */
  release(e: Enemy): void;
  bloodBurst(point: THREE.Vector3, count: number, dir: THREE.Vector3 | null, kind?: 'blood' | 'spark'): void;
  playAudio(id: string, position: THREE.Vector3, volume?: number, pitch?: number): void;
  /** Visual-only acid glob from `from` toward the target's current feet position. */
  acidVisual(from: THREE.Vector3, target: CombatTarget, shooterId: number): void;
  /** 2026-09-11 (C-48): visual-only glob from `from` toward the host's resolved aim point `to` (`ee acidAt`). */
  acidVisualAt(from: THREE.Vector3, to: THREE.Vector3, shooterId: number): void;
  /* ── Phase 4 (visual mirrors of host events) ── */
  rogueShotVisual(id: number, from: THREE.Vector3, to: THREE.Vector3, hit: boolean): void;
  shellVisual(sid: number, from: THREE.Vector3, target: THREE.Vector3, flight: number): void;
  shellInterceptedRemote(sid: number, p: THREE.Vector3): void;
  shellLandedRemote(sid: number, p: THREE.Vector3): void;
  chargeVisual(id: number, target: THREE.Vector3): void;
  toxicVisual(id: number, p: THREE.Vector3): void;
  /** Phase 10: `opts` carries the host's authority for the lootable roll (`ee corpse.lt`) and the fall direction (`dd`). */
  corpseSpawnedRemote(id: number, type: EnemyType, p: THREE.Vector3, weaponId: string | undefined, opts?: CorpseWireOpts): void;
  corpseGoneRemote(id: number): void;
  /** appended (2026-09-16): `ee corpseEmptied` — the host decided this corpse was opened and emptied (`parts/CorpseEmpty`). */
  corpseEmptiedRemote(id: number): void;
  /* ── Phase 7 (rogue AI v2) ── */
  /** Visual rogue grenade from `ee grenade` (position / velocity / fuse as thrown on the host). 2026-09-13: `kind` = `ee grenade.k`. */
  grenadeVisual(id: number, p: THREE.Vector3, v: THREE.Vector3, fuse: number, kind?: EnemyGrenadeKind): void;
  /** Host's `grenadeHit`: pop the local copy (or just the FX) at `p`. 2026-09-13: `kind` = `ee grenadeHit.k` (an incendiary lights the visual fire zone). */
  grenadeHitRemote(p: THREE.Vector3, kind?: EnemyGrenadeKind): void;
  /* ── Phase 12 (frontal barrier absorption) ── */
  /** Host says enemy `id`'s melee landed on **my** raised shield at `p`: deduct `amount` from it + the bite FX. */
  barrierHitRemote(id: number, p: THREE.Vector3, amount: number): void;
  /* ── 2026-09-13 (burrow spawns · the sandworm) ── */
  /** FX · shake · sound for a body that began emerging on `ee spawn.em` (`parts/Burrow.emergeFx`). */
  emergeSpawned(e: Enemy): void;
  /** A body in flight after being spat has landed (`parts/Burrow.spatLandedFx`). */
  burrowLanded(e: Enemy): void;
  /** `ee wormWarn` · `wormErupt` · `wormSpit` → `sandworm/Director.onWire`. */
  onSandwormEvent(msg: EnemyEvent): void;
}

/** 2026-09-13: wire grenade kind index (`ENEMY_GRENADE_KINDS`) → kind; omitted / unknown = undefined. */
function grenadeKindOf(k: number | undefined): EnemyGrenadeKind | undefined {
  return typeof k === 'number' && Number.isInteger(k) && k >= 0 && k < ENEMY_GRENADE_KINDS.length ? ENEMY_GRENADE_KINDS[k] : undefined;
}

const _pose: Pose = { x: 0, y: 0, z: 0, yaw: 0 };
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _d = new THREE.Vector3();

export class EnemyReplica {
  /** `EnemySnapshot.seq` of the last snapshot applied (the host's counter, Phase 9). */
  private seq = 0;
  /** Diagnostics (smoke): deltas whose ids were unknown and carried no `ty` (ignored). */
  ignoredUnknown = 0;
  /** Diagnostics (smoke): kind of the last snapshot applied. */
  lastFull = false;

  constructor(private readonly host: ReplicaHost) {}

  clear(): void { this.seq = 0; this.ignoredUnknown = 0; this.lastFull = false; }

  /** Last `EnemySnapshot.seq` seen (a promoted host continues its own counter past it). */
  get lastSeq(): number { return this.seq; }

  /* ── inbound ──────────────────────────────────────────────────────────── */
  /**
   * Phase 9: `es` is a delta stream. A keyframe (`msg.full`) lists every enemy with every field and sweeps the rest;
   * a delta lists only changed enemies / fields (`ReplicaBuffer.applyWire`), an unknown id without `ty` is ignored
   * (`ee spawn` or the next keyframe brings it), enemies absent from a delta get a `hold` sample so they stand still,
   * and `gone` releases at once — except dead bodies, which the corpse timer owns.
   */
  onSnapshot(msg: EnemySnapshot): void {
    const host = this.host;
    const now = host.ctx.time;
    const seq = msg.seq;
    const full = msg.full;
    this.seq = seq;
    this.lastFull = full;
    const list = msg.e;
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      let e = host.find(w.id);
      if (e && w.ty !== undefined && e.type !== w.ty) { host.release(e); e = undefined; }
      let created = false;
      if (!e) {
        if (w.ty === undefined || !w.p) { this.ignoredUnknown++; continue; }
        _p.set(w.p[0], w.p[1], w.p[2]);
        e = host.acquire(w.id, w.ty, _p, w.yaw ?? 0) ?? undefined;
        if (!e) continue;
        created = true;
      }
      if (w.w) e.weaponId = w.w;
      const buf = e.netBuf ?? (e.netBuf = new ReplicaBuffer());
      buf.applyWire(now, w, full);
      buf.seenSeq = seq;
      // 2026-09-11 (C-52): still silent (no `enemy:spawned`), but a named rogue made here is announced — once per id, the
      // director's record also covers a later / earlier `ee spawn` for the same id
      if (created) host.named.onReplicaCreated(e);
    }
    const active = host.active;
    if (full) {
      for (let i = active.length - 1; i >= 0; i--) {
        const e = active[i];
        if (!e.active) continue;
        // corpses drop out of the host's snapshot after ~1.5 s but stay lootable: our own corpse timer removes them
        if (e.state === 'dead') continue;
        if (!e.netBuf || e.netBuf.seenSeq !== seq) host.release(e);
      }
    } else {
      for (let i = 0; i < active.length; i++) {
        const e = active[i];
        if (!e.active || e.state === 'dead') continue;
        const buf = e.netBuf;
        if (!buf || buf.count === 0 || buf.seenSeq === seq) continue;
        buf.hold(now);
        buf.seenSeq = seq;
      }
    }
    const gone = msg.gone;
    if (gone) {
      for (let i = 0; i < gone.length; i++) {
        const e = host.find(gone[i]);
        if (!e || !e.active || e.state === 'dead') continue;
        const last = e.netBuf?.latest();
        if (last && last.st === 'dead') continue;   // the body is about to die locally; the corpse timer removes it
        host.release(e);
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
        let created = false;
        if (!e) { e = host.acquire(msg.id, msg.ty, _p, msg.yaw) ?? undefined; created = !!e; }
        if (!e) return;
        const buf = e.netBuf ?? (e.netBuf = new ReplicaBuffer());
        if (buf.count === 0) buf.push(ctx.time, _p.x, _p.y, _p.z, msg.yaw, e.maxHp, 'idle', 0);
        // 2026-09-13: burrow spawn — it rises out of the ground over the same time as on the host (FX · shake · sound in `parts/Burrow`)
        if (created && typeof msg.em === 'number' && msg.em > 0) { e.startEmerge(Math.min(msg.em, 5)); host.emergeSpawned(e); }
        ctx.bus.emit('enemy:spawned', { id: e.id, type: e.type, position: e.position });
        return;
      }
      case 'kill': {
        const e = host.find(msg.id);
        if (e && e.active) {
          e.hp = 0;
          // Phase 10: the host's fall direction wins (the seeded fallback in `kill()` agrees anyway)
          e.kill(false, msg.dd !== undefined ? ENEMY_DEATH_DIRS[msg.dd] : undefined);   // death anim + gore + bug_death via host.onEnemyKilled
        }
        const localId = ctx.net?.localId ?? null;
        if (msg.killer !== null && msg.killer === localId) {
          ctx.stats.kills++;
          // 2026-09-16: kill XP — the same condition and the same value as the host's `parts/Damage.onEnemyKilled` (the type is the wire's `ty`)
          ctx.stats.killXp = (ctx.stats.killXp ?? 0) + raidXpOf(msg.ty);
          _p.set(msg.p[0], msg.p[1], msg.p[2]);
          // Phase 9: the wire carries our real peer id; the bus payload names our own credit `'local'` (same as the host path)
          // 2026-09-14: the weapon class = the source of the last request this client sent that enemy (the host's burn-DoT last hit cannot be known)
          ctx.bus.emit('enemy:killed', { id: msg.id, type: msg.ty, position: e ? e.position : _p.clone(), by: 'local', weaponClass: e ? e.lastLocalWeaponClass : null });
        } else if (typeof msg.killer === 'string' && msg.killer) {
          // 2026-09-11 (E-4): a squad-mate's kill (the host counts it too — `parts/Damage.onEnemyKilled`). meta/ derives the
          // squad share of kill goals from this instead of trusting a relayed `meta contractHit`.
          _p.set(msg.p[0], msg.p[1], msg.p[2]);
          ctx.bus.emit('enemy:squadKill', { id: msg.id, type: msg.ty, position: e ? e.position : _p.clone(), by: msg.killer });
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
            host.bloodBurst(_p, 8, _d, goreKindOf(e.type));
          } else { a.flinchX = (Math.random() - 0.5) * 2; a.flinchZ = 0.3; host.bloodBurst(_p, 8, null, goreKindOf(e.type)); }
          // 2026-09-11 (C-51): the same table as the host — a rogue is `hit_flesh` (before, only the replica played `bug_hit` for rogues too)
          host.playAudio(hurtSound(e.type), e.position, 0.6, 0.9 + Math.random() * 0.2);
        }
        ctx.bus.emit('enemy:damaged', { id: e.id, type: e.type, amount: msg.amount, position: e.position, hp: Math.max(0, e.hp - msg.amount) });
        return;
      }
      case 'attack': {
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        // 2026-09-11 (C-51): the per-type melee hit sound table — Tagilla is null (`ee hammer` already plays `hammer_impact`)
        const bite = meleeHitSound(msg.ty);
        if (bite) host.playAudio(bite.id, _p, 1, bite.pitch);
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
      case 'acidAt': {
        // 2026-09-11 (C-48): acid aimed at a drone · enemy · spot — flown to the host's own aim point (the host owns the damage)
        _p.set(msg.from[0], msg.from[1], msg.from[2]);
        _p2.set(msg.to[0], msg.to[1], msg.to[2]);
        host.acidVisualAt(_p, _p2, msg.id);
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
        // Phase 10: `lt: 0` = this corpse rolled un-searchable (no interactable), `dd` = the fall direction
        host.corpseSpawnedRemote(msg.id, msg.ty, _p, msg.w, {
          lootable: msg.lt === undefined ? undefined : msg.lt !== 0,
          deathDir: msg.dd !== undefined ? ENEMY_DEATH_DIRS[msg.dd] : undefined,
          // 2026-09-13: the same loot inputs as the host (the spawn site · remaining grenades)
          loot: msg.si || msg.gc
            ? { site: msg.si ?? null, grenades: msg.gc ? { kind: ENEMY_GRENADE_KINDS[msg.gk ?? 0] ?? 'frag', count: msg.gc } : null }
            : undefined,
        });
        return;
      }
      case 'corpseGone':
        host.corpseGoneRemote(msg.id);
        return;
      case 'corpseEmptied':   // 2026-09-16: a corpse opened and emptied — its lifetime shortens and it sinks (removal is the following `despawn` / its own lifetime)
        host.corpseEmptiedRemote(msg.id);
        return;
      /* ── Phase 7 ── */
      case 'grenade': {
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        _p2.set(msg.v[0], msg.v[1], msg.v[2]);
        host.grenadeVisual(msg.id, _p, _p2, msg.fuse, grenadeKindOf(msg.k) ?? 'frag');
        return;
      }
      case 'grenadeHit':
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        host.grenadeHitRemote(_p, grenadeKindOf(msg.k));
        return;
      /* ── Phase 12 ── */
      case 'barrierHit':
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        host.barrierHitRemote(msg.id, _p, msg.amount);
        return;
      /* ── 2026-09-11: named rogues · the scan drone (ai/named/*) ── */
      case 'scanPulse':
      case 'glint':
      case 'snipe':
      case 'hammer':
      case 'spray':
        onNamedEvent(host, msg);
        return;
      /* ── 2026-09-13: the sandworm (sandworm/Director) ── */
      case 'wormWarn':
      case 'wormErupt':
      case 'wormSpit':
        host.onSandwormEvent(msg);
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
      // Phase 10: a body killed in the air falls here too — the host stops sending it after 1.5 s, so the replica
      // runs the same deterministic fall (`integrateDeathFall`) instead of freezing the corpse mid-air.
      if (e.state === 'dead') { e.deathTimer += dt; integrateDeathFall(e, dt, world); continue; }
      // 2026-09-13: a body the sandworm spat draws the `ee wormSpit` arc itself (snapshots take over after it lands)
      if (e.spatT > 0) { if (stepSpatFlight(e, dt, world)) this.host.burrowLanded(e); continue; }
      const buf = e.netBuf;
      if (!buf) continue;
      const latest = buf.latest();
      if (!latest) continue;
      if (latest.st === 'dead') { e.hp = 0; e.kill(false); continue; }
      if (!buf.sampleAt(renderT, _pose)) continue;
      this.drive(e, latest, dt, world, renderT);
    }
  }

  private drive(e: Enemy, latest: Sample, dt: number, world: NonNullable<GameContext['world']>, renderT: number): void {
    const a = e.anim;
    const s = e.stats;
    const px = e.position.x, py = e.position.y, pz = e.position.z;
    const hint = latest.a;
    const rogue = e.isHumanoid;

    // 2026-09-17: 23 = a flipped hunter falling (airborne, so the terrain snap is off) · 24 = a hunter lying flipped — `Enemy.animate` applies `anim.flip`
    e.airborne = hint === 4 || hint === 23;
    // 2026-09-21 (A-18 phase 2): 26 · 27 · 28 = on a special link and off the floor (`ai/Traverse`) — `Enemy.animate` lays a bug along
    // the wall from `navClimbDir`, and the terrain snap · ride · slope below are off so it is not pulled down to the floor mid-wall.
    if (e.navTrav !== 0) e.clearNav();   // a body adopted mid-link on a demotion: the link was the old authority's
    const aloft = hint >= 26 && hint <= 28;
    e.navAloft = aloft;
    e.navClimbDir = hint === 26 ? 1 : hint === 27 ? -1 : 0;
    e.leaping = hint === 4;
    e.flipFalling = hint === 23;
    e.flipTimer = hint === 24 ? STATUS_HOLD : 0;
    e.chargePhase = hint === 1 || hint === 10 ? 1 : hint === 2 || hint === 11 ? 2 : 0;
    e.spitPhase = hint === 3 ? 1 : 0;
    e.toxicPhase = hint === 9 ? 1 : 0;
    e.dug = hint === 8 || hint === 25 ? 1 : 0;
    e.roguePhase = hint === 5 ? 3 : hint === 6 ? 2 : hint === 7 ? 4 : 0;
    // Phase 7: hold the reload / throw timers so Enemy.animate blends the same poses the host shows
    if (rogue) {
      e.reloadTimer = hint === 12 ? STATUS_HOLD : 0;
      e.throwTimer = hint === 13 ? STATUS_HOLD : 0;
    }
    // 2026-09-11: named rogues — the namedHint the host AI uses is filled on the replica too, and the state is matched before the pose is applied (a scan drone = airborne).
    if (isNamedAiType(e.type)) { e.namedHint = hint; beforeNamedReplica(e, hint); }
    e.position.set(_pose.x, _pose.y, _pose.z);
    // 2026-09-11 (C-18): an enemy riding the tram is advanced along with it by the interpolation delay (`ai/Ride.replicaRidePredict`). The
    // interpolated spot is the host's spot at renderT (extrapolated at most MAX_EXTRAPOLATE) while the tram is at its **current** spot — that gap is lag.
    let rideVel: THREE.Vector3 | null = null;
    if (!e.airborne && !aloft) {
      const lag = Math.max(0, this.host.ctx.time - Math.min(renderT, latest.t + MAX_EXTRAPOLATE));
      rideVel = replicaRidePredict(e, world, latest, this.host.ctx.time, lag, dt, e.position);
    } else e.carrier = null;
    // 2026-09-09: `getSurfaceY` with the host's own y as the foot height — a body standing on a rock keeps its
    // rock top instead of being yanked down to the terrain the moment the snapshot lands.
    if (!e.airborne && !aloft) e.position.y = world.getSurfaceY(e.position.x, e.position.z, _pose.y);   // hide small height mismatches
    e.yaw = _pose.yaw;
    e.hp = latest.hp;
    e.state = latest.st;
    e.aware = latest.st !== 'idle' && latest.st !== 'wander';
    if (latest.st === 'flee') e.fleeTimer += dt;
    this.applyStatusBits(e, latest.sb);

    // gait from displacement — minus what the tram carried (C-18: a rider does not walk at tram speed)
    let dx = e.position.x - px, dz = e.position.z - pz;
    if (dt > 0) e.velocity.set(dx / dt, 0, dz / dt);
    if (rideVel) { dx -= rideVel.x * dt; dz -= rideVel.z * dt; }
    // 2026-09-21: on a wall the legs work from the height gained (the authority's `ai/Traverse` counts the same distance)
    const moved = aloft ? Math.hypot(dx, dz, e.position.y - py) : Math.hypot(dx, dz);
    a.gait += (moved / e.rig.params.strideLength) * TWO_PI;
    if (a.gait > 1e6) a.gait -= 1e6;
    const spd = dt > 0 ? moved / dt : 0;
    const targetAnimSpeed = e.airborne ? 0.2 : Math.min(1, spd / Math.max(1, s.speed * 0.8));
    a.speed += (targetAnimSpeed - a.speed) * Math.min(1, dt * 8);
    // 2026-09-11 (C-23 · X-3): non-hosts hear enemy footsteps too — the same stride accumulation and emission as the authority, from the interpolated movement.
    // A jump of several metres in one frame (the first snapshot · a teleport) is not a step.
    if (s.stepSound && !e.airborne && !aloft && moved < 2) footfall(e, this.host, moved);

    // animation targets from state + hint (mirrors what the host AI would be setting)
    let shakeT = 0, abdT = 0, crouchT = 0, mandT = e.aware ? 0.25 : 0, pitchT: number | null = null;
    let aimT = rogue && e.aware ? 0.5 : 0;
    let braceT = 0;   // 2026-09-17: the artillery firing pose (hint 25)
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
      case 25: crouchT = 0.8; mandT = 0.4; braceT = 1; break;   // 2026-09-17: the artillery firing pose (braced flat)
      case 9: abdT = 1; crouchT = 0.25; mandT = 1; break;
      case 10: shakeT = 1; crouchT = a.shake * 0.3; mandT = 1; break;
      case 11: mandT = 1; pitchT = -0.2; break;
      case 12: aimT = 0.25; crouchT = 1; break;          // Phase 7: reloading
      case 13: aimT = 0.2; crouchT = 0; break;           // Phase 7: grenade wind-up
      case 23: case 24: crouchT = 0; mandT = Math.abs(Math.sin(a.time * 5)); pitchT = 0.3; break;   // 2026-09-17: the hunter flip (the same mouth as `ai/HunterFlip`)
      default: break;
    }
    a.shake += (shakeT - a.shake) * Math.min(1, dt * (shakeT > 0 ? 2.5 : 4));
    a.abdomen += (abdT - a.abdomen) * Math.min(1, dt * (abdT > 0 ? 3 : 2));
    a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 8);
    a.brace += (braceT - a.brace) * Math.min(1, dt * 4);
    a.mandible += (mandT - a.mandible) * Math.min(1, dt * 10);
    a.aim += (aimT - a.aim) * Math.min(1, dt * (aimT > a.aim ? 7 : 3));
    if (isNamedAiType(e.type)) afterNamedReplica(e, hint, dt, this.host);
    if (isWormType(e.type)) applyWormHint(e, hint, dt);   // 2026-09-13: mouth opening · throb · bow (the same function as the host)

    // head: track the nearest player while aware, idle sway otherwise
    const look = e.aware && hint !== 2 && hint !== 11 && hint !== 23 && hint !== 24 ?this.host.targets.nearestAlive(e.position) : null;
    if (look) lookAtTarget(e, look, dt);
    else {
      a.headYaw = THREE.MathUtils.lerp(a.headYaw, hint === 2 || hint === 11 ? 0 : Math.sin(a.time * 0.7) * 0.35, dt * 3);
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, Math.sin(a.time * 1.1) * 0.1, dt * 3);
    }
    if (pitchT !== null) a.headPitch = THREE.MathUtils.lerp(a.headPitch, pitchT, dt * 6);

    if (aloft) { a.slopePitch += (0 - a.slopePitch) * Math.min(1, dt * 6); a.slopeRoll += (0 - a.slopeRoll) * Math.min(1, dt * 6); }
    else if (!e.airborne) applySlope(e, world, dt);
  }

  /**
   * Mirror the host's status bits (`EnemyWire.sb`) into the local visual timers: burning embers, the incinerated writhe and
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
