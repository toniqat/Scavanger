import * as THREE from 'three';
import type { GhostWire, ImplantId, PeerId, PlayerSnapshot, RemoteAvatarRef, RemotePlayerRef, Stance } from '@/shared';
import { NET_INTERP_DELAY, NET_STALE_AFTER, PLAYER_MAX_HP, PlayerFlags } from '@/shared';

const RING_SIZE = 16;
const MAX_EXTRAPOLATE = 0.25;
/** A snapshot whose seq is this far below the last accepted one is a restarted stream, not a late packet. */
const SEQ_RESET_GAP = 200;
const TWO_PI = Math.PI * 2;
const EMPTY_ATT: readonly string[] = [];

interface Sample {
  arrival: number;
  s: PlayerSnapshot | null;
}

/** Keep the previous attachment array when the contents are equal (consumers compare by reference). */
function sameAttachments(prev: readonly string[], next: string[] | undefined): readonly string[] {
  if (!next || !Array.isArray(next) || next.length === 0) return EMPTY_ATT;
  if (prev.length === next.length) {
    let same = true;
    for (let i = 0; i < next.length; i++) if (prev[i] !== next[i]) { same = false; break; }
    if (same) return prev;
  }
  return next.filter((a) => typeof a === 'string');
}

/** Shortest signed angular difference b - a in (-π, π]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d <= -Math.PI) d += TWO_PI;
  return d;
}

/**
 * Interpolated view of one remote player. NetSystem pushes snapshots (`push`) and advances the view every
 * frame (`tick`). `position` / `velocity` are stable Vector3 instances for the ref's lifetime.
 */
export class RemotePlayer implements RemotePlayerRef {
  readonly id: PeerId;
  name: string;
  slot: number;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  stance: Stance = 'stand';
  flags = 0;
  hp = PLAYER_MAX_HP;
  readonly maxHp = PLAYER_MAX_HP;
  weaponId: string | null = null;
  stridePhase = 0;
  moveBlend = 0;
  lastUpdate = 0;
  connected = true;
  stale = false;
  /* appended (Phase 7): suspended members / ghosts / mission membership — maintained by NetSystem from `lobby:state`. */
  /** Socket down but slot kept: the body is a host ghost (`applyGhost`), never removed for this. */
  suspended = false;
  /** `LobbyPlayer.inMission` mirror. */
  inMission = true;
  /** true while `position / yaw / hp / flags` come from `ghost state` instead of the snapshot ring. */
  ghosted = false;
  /** Ghost bleed-out hp (state 1) from the last `ghost state`. */
  ghostDownHp = 0;
  /** Def id of the consumable in hand (`PlayerSnapshot.h`), or null. */
  heldItemId: string | null = null;
  /** Attachment def ids on the active weapon (`PlayerSnapshot.att`); the same array while unchanged. */
  attachments: readonly string[] = EMPTY_ATT;
  avatar: RemoteAvatarRef | null = null;
  /** ctx.time at which NetSystem removes this ref (set when the peer leaves). */
  removeAt = Infinity;

  private lastSeq = -1;
  private readonly ring: Sample[] = [];
  private head = 0;   // index of the oldest sample
  private count = 0;
  private hasAny = false;

  constructor(id: PeerId, name: string, slot: number, now: number) {
    this.id = id;
    this.name = name;
    this.slot = slot;
    this.lastUpdate = now;
    for (let i = 0; i < RING_SIZE; i++) this.ring.push({ arrival: 0, s: null });
  }

  get isDead(): boolean { return (this.flags & PlayerFlags.DEAD) !== 0; }
  /** 전투불능 (Phase 2): crawling, revivable. */
  get isDowned(): boolean { return (this.flags & PlayerFlags.DOWNED) !== 0; }

  /* appended: tactical kit — gear the remote avatar renders, straight off the newest snapshot. */
  implantId: ImplantId | null = null;
  armorId: string | null = null;
  get isCloaked(): boolean { return (this.flags & PlayerFlags.CLOAKED) !== 0; }

  /**
   * The peer's snapshot stream restarted (page reload / rejoin with the same stable PeerId → `seq` starts at 1
   * again). Forget the sequence guard and the interpolation history; the next `push` snaps to the new stream.
   */
  resetStream(): void {
    this.lastSeq = -1;
    this.count = 0;
    this.head = 0;
    this.hasAny = false;
    for (const r of this.ring) r.s = null;
  }

  /**
   * Accept a snapshot; out-of-order (seq ≤ last) samples are dropped. A `seq` far below the last one (or any
   * lower `seq` while we are stale) is a restarted stream (reload / rejoin) and is accepted after `resetStream()`.
   * Returns false when dropped.
   */
  push(s: PlayerSnapshot, now: number): boolean {
    // A snapshot from a ghosted member means they are back: the live stream replaces the host's ghost.
    if (this.ghosted) this.clearGhost();
    if (s.seq <= this.lastSeq) {
      if (!this.stale && s.seq > this.lastSeq - SEQ_RESET_GAP) return false;
      this.resetStream();
    }
    this.lastSeq = s.seq;
    const idx = (this.head + this.count) % RING_SIZE;
    if (this.count === RING_SIZE) {
      this.head = (this.head + 1) % RING_SIZE; // overwrite oldest
    } else {
      this.count++;
    }
    const slot = this.ring[idx];
    slot.arrival = now;
    slot.s = s;
    this.lastUpdate = now;
    this.stale = false;

    // Discrete fields come from the newest sample.
    this.stance = s.stance;
    this.flags = s.f;
    this.hp = s.hp;
    this.weaponId = s.w;
    this.moveBlend = s.move;
    this.implantId = s.imp ?? null;
    this.armorId = s.ar ?? null;
    this.heldItemId = typeof s.h === 'string' ? s.h : null;
    this.attachments = sameAttachments(this.attachments, s.att);
    if (!this.hasAny) {
      this.hasAny = true;
      this.position.set(s.p[0], s.p[1], s.p[2]);
      this.velocity.set(s.v[0], s.v[1], s.v[2]);
      this.yaw = s.yaw;
      this.pitch = s.pitch;
      this.stridePhase = s.stride;
    }
    return true;
  }

  /** Force the dead state without waiting for the next snapshot (DiedMessage). */
  markDead(): void {
    this.flags |= PlayerFlags.DEAD;
    this.hp = 0;
  }

  /**
   * Phase 7: the host's ghost of this (suspended) member — position / yaw / hp / downed / dead override the snapshot
   * ring until a live snapshot (`push`) or `clearGhost()` (ghost gone). Velocity is zero: ghosts do not move.
   */
  applyGhost(g: GhostWire): void {
    this.ghosted = true;
    this.position.set(g.p[0], g.p[1], g.p[2]);
    this.velocity.set(0, 0, 0);
    this.yaw = g.yaw;
    this.moveBlend = 0;
    this.hp = g.hp;
    this.ghostDownHp = g.dhp;
    let f = this.flags & ~(PlayerFlags.DOWNED | PlayerFlags.DEAD | PlayerFlags.DROPPING | PlayerFlags.IN_HUB | PlayerFlags.IN_POD);
    if (g.st === 1) f |= PlayerFlags.DOWNED;
    else if (g.st === 2) f |= PlayerFlags.DEAD;
    this.flags = f;
    if (g.st === 2) this.hp = 0;
  }

  /** Back to snapshot mode (ghost gone / member returned). The next live snapshot snaps the view. */
  clearGhost(): void {
    if (!this.ghosted) return;
    this.ghosted = false;
    this.resetStream();
  }

  /** Advance the interpolated view to `now` (ctx.time). Allocation-free. */
  tick(now: number): void {
    this.stale = now - this.lastUpdate > NET_STALE_AFTER;
    if (this.ghosted) return; // the ghost owns the pose
    if (this.count === 0) return;
    const renderTime = now - NET_INTERP_DELAY;
    const newestIdx = (this.head + this.count - 1) % RING_SIZE;
    const newest = this.ring[newestIdx];
    const ns = newest.s!;

    if (renderTime >= newest.arrival) {
      // Beyond the newest sample: extrapolate with velocity for a short while, then hold.
      const dt = this.stale ? 0 : Math.min(renderTime - newest.arrival, MAX_EXTRAPOLATE);
      this.position.set(ns.p[0] + ns.v[0] * dt, ns.p[1] + ns.v[1] * dt, ns.p[2] + ns.v[2] * dt);
      this.velocity.set(ns.v[0], ns.v[1], ns.v[2]);
      this.yaw = ns.yaw;
      this.pitch = ns.pitch;
      this.stridePhase = ns.stride;
      return;
    }

    // Find the pair (a, b) bracketing renderTime; walk from newest backwards (usually 1–2 steps).
    let bIdx = newestIdx;
    let aIdx = newestIdx;
    for (let k = this.count - 1; k >= 0; k--) {
      const idx = (this.head + k) % RING_SIZE;
      if (this.ring[idx].arrival <= renderTime) { aIdx = idx; break; }
      bIdx = idx;
      aIdx = idx;
    }
    const a = this.ring[aIdx];
    const b = this.ring[bIdx];
    const as = a.s!;
    const bs = b.s!;
    if (aIdx === bIdx || b.arrival <= a.arrival) {
      // Older than our oldest sample (or degenerate pair): hold that sample.
      this.position.set(as.p[0], as.p[1], as.p[2]);
      this.velocity.set(as.v[0], as.v[1], as.v[2]);
      this.yaw = as.yaw;
      this.pitch = as.pitch;
      this.stridePhase = as.stride;
      return;
    }
    const t = (renderTime - a.arrival) / (b.arrival - a.arrival);
    this.position.set(
      as.p[0] + (bs.p[0] - as.p[0]) * t,
      as.p[1] + (bs.p[1] - as.p[1]) * t,
      as.p[2] + (bs.p[2] - as.p[2]) * t,
    );
    this.velocity.set(
      as.v[0] + (bs.v[0] - as.v[0]) * t,
      as.v[1] + (bs.v[1] - as.v[1]) * t,
      as.v[2] + (bs.v[2] - as.v[2]) * t,
    );
    this.yaw = as.yaw + angleDelta(as.yaw, bs.yaw) * t;
    this.pitch = as.pitch + (bs.pitch - as.pitch) * t;
    this.stridePhase = as.stride + angleDelta(as.stride, bs.stride) * t;
  }

  dispose(): void {
    this.count = 0;
    this.head = 0;
    for (const r of this.ring) r.s = null;
    this.avatar = null;
  }
}
