import * as THREE from 'three';
import { CLOAK_DETECT_MUL, PLAYER_HEIGHT, PlayerFlags, type GameContext, type PeerId, type PlayerRef } from '@/shared';
import type { Enemy } from './Enemy';

/** `'local'` is the player on this machine; `'ai'` is another enemy (faction warfare, Phase 4); anything else is a remote peer id. */
export type TargetId = PeerId | 'local' | 'ai';

const EYE_STAND = 1.55, EYE_CROUCH = 1.15, EYE_PRONE = 0.45;

/**
 * Something a bug can hunt: the local player or an interpolated remote player.
 * Instances are stable for as long as the player is present, so an `Enemy.target` reference stays valid
 * across frames; `present` flips to false when the peer leaves / goes stale and the AI must re-target.
 * `position` / `velocity` are copies refreshed once per frame by `TargetList.refresh`.
 */
export class CombatTarget {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  isDead = true;
  /** Downed (crawling, revivable). Never an AI target / victim, but still a body for separation and spawn-distance checks. */
  downed = false;
  present = false;
  yaw = 0;
  eyeHeight = EYE_STAND;
  /**
   * Appended (tactical kit): 0..1 factor an enemy multiplies its detection range by.
   * Local → `PlayerRef.getStealthFactor()`; remote → `CLOAK_DETECT_MUL` while the `CLOAKED` flag is set.
   * Defaults to 1 whenever the player system does not implement it yet.
   */
  stealth = 1;
  /** Set for the local target so eye/forward come straight from the player (camera yaw, pod state…). */
  player: PlayerRef | null = null;
  /**
   * Phase 7: the remote member's socket is down and the host simulates its body (`RemotePlayerRef.suspended`).
   * Still a target; damage goes out as `ghost:damage` instead of a `dmg` message (the host's RemotePlayerSystem applies it).
   */
  suspended = false;
  /**
   * Phase 4: set when this target is another enemy (`id === 'ai'`). Every `Enemy` owns one such proxy (`Enemy.asTarget`)
   * refreshed by the system each frame so bug ↔ rogue combat reuses the player-hunting code paths unchanged.
   */
  enemy: Enemy | null = null;

  constructor(readonly id: TargetId) {}

  get isLocal(): boolean { return this.id === 'local'; }
  get isEnemy(): boolean { return this.enemy !== null; }

  /** True when bugs must neither hunt nor hurt this player (dead, or downed and waiting for a revive). */
  get isDeadOrDowned(): boolean { return this.isDead || this.downed; }

  getEyePosition(out: THREE.Vector3): THREE.Vector3 {
    if (this.player) return this.player.getEyePosition(out);
    if (this.enemy) return out.set(this.position.x, this.position.y + this.enemy.height * 0.8, this.position.z);
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Horizontal forward (same convention as the player camera rig: yaw 0 → -Z). */
  getForward(out: THREE.Vector3): THREE.Vector3 {
    if (this.player) return this.player.getForward(out);
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Point bugs aim at / trace LOS to (chest height). */
  getChest(out: THREE.Vector3): THREE.Vector3 {
    const h = this.enemy ? this.enemy.height * 0.6 : PLAYER_HEIGHT * 0.65;
    return out.set(this.position.x, this.position.y + h, this.position.z);
  }

  /** Body radius for hit tests (players PLAYER_RADIUS-like via the caller; enemies their own). */
  get bodyRadius(): number { return this.enemy ? this.enemy.radius : 0.45; }
  get bodyHeight(): number { return this.enemy ? this.enemy.height : PLAYER_HEIGHT; }

  dist2D(p: THREE.Vector3): number {
    return Math.hypot(this.position.x - p.x, this.position.z - p.z);
  }
}

/**
 * Read `PlayerRef.getStealthFactor()` defensively: the player system may not implement it yet
 * (folders are built in parallel), and a bad value must never make the bugs blind or omniscient.
 */
function readStealth(player: PlayerRef): number {
  const fn = (player as Partial<PlayerRef>).getStealthFactor;
  if (typeof fn !== 'function') return 1;
  const v = fn.call(player);
  return typeof v === 'number' && v > 0 && v <= 1 ? v : 1;
}

/**
 * Per-frame list of every player the enemies know about: the local player (when spawned) plus every connected,
 * non-stale remote player that is not still inside its hellpod — and (Phase 7) every *suspended* member, whose body
 * the host keeps simulating as a ghost. In single-player only the local target exists, so every query below
 * degenerates to the old `ctx.player` behaviour.
 */
export class TargetList {
  /** Every present target (alive, downed or dead). */
  readonly all: CombatTarget[] = [];
  /** Present, alive and not downed — the only players the AI may target or damage. */
  readonly alive: CombatTarget[] = [];
  private readonly byId = new Map<TargetId, CombatTarget>();
  private readonly gone: TargetId[] = [];

  refresh(ctx: GameContext): void {
    for (const t of this.byId.values()) t.present = false;

    const player = ctx.player;
    if (player) {
      const t = this.obtain('local');
      t.player = player;
      t.position.copy(player.position);
      t.velocity.copy(player.velocity);
      t.yaw = player.yaw;
      t.isDead = player.isDead;
      t.downed = player.isDowned;
      t.eyeHeight = player.stance === 'prone' ? EYE_PRONE : player.stance === 'crouch' ? EYE_CROUCH : EYE_STAND;
      t.stealth = readStealth(player);
      t.suspended = false;
    }

    const net = ctx.net;
    if (net && ctx.isMultiplayer) {
      const remotes = net.getRemotePlayers();
      for (let i = 0; i < remotes.length; i++) {
        const r = remotes[i];
        // Phase 7: a suspended member (socket down, slot kept) stays a target — its position / hp / downed / dead come
        // from the host's ghost simulation through the same ref, so only a *non-suspended* stale ref drops out.
        const suspended = r.suspended === true;
        if (!r.connected || (r.stale && !suspended) || (r.flags & PlayerFlags.DROPPING) !== 0) continue;
        const t = this.obtain(r.id);
        t.player = null;
        t.suspended = suspended;
        t.position.copy(r.position);
        t.velocity.copy(r.velocity);
        t.yaw = r.yaw;
        t.isDead = r.isDead || (r.flags & PlayerFlags.DEAD) !== 0;
        t.downed = r.isDowned || (r.flags & PlayerFlags.DOWNED) !== 0;
        t.eyeHeight = r.stance === 'prone' ? EYE_PRONE : r.stance === 'crouch' ? EYE_CROUCH : EYE_STAND;
        t.stealth = (r.isCloaked ?? (r.flags & PlayerFlags.CLOAKED) !== 0) ? CLOAK_DETECT_MUL : 1;
      }
    }

    this.all.length = 0;
    this.alive.length = 0;
    this.gone.length = 0;
    for (const t of this.byId.values()) {
      if (!t.present) { this.gone.push(t.id); continue; }
      this.all.push(t);
      if (!t.isDead && !t.downed) this.alive.push(t);
    }
    for (let i = 0; i < this.gone.length; i++) this.byId.delete(this.gone[i]);
  }

  private obtain(id: TargetId): CombatTarget {
    let t = this.byId.get(id);
    if (!t) { t = new CombatTarget(id); this.byId.set(id, t); }
    t.present = true;
    return t;
  }

  clear(): void {
    this.byId.clear();
    this.all.length = 0;
    this.alive.length = 0;
  }

  get(id: TargetId): CombatTarget | undefined { return this.byId.get(id); }
  local(): CombatTarget | undefined { return this.byId.get('local'); }
  anyAlive(): boolean { return this.alive.length > 0; }

  /** Nearest alive target (2D), or null. */
  nearestAlive(p: THREE.Vector3): CombatTarget | null {
    let best: CombatTarget | null = null;
    let bestD = Infinity;
    for (let i = 0; i < this.alive.length; i++) {
      const t = this.alive[i];
      const d = t.dist2D(p);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /** Nearest alive target within `radius` (2D), or null. */
  nearestAliveWithin(p: THREE.Vector3, radius: number): CombatTarget | null {
    const t = this.nearestAlive(p);
    return t && t.dist2D(p) < radius ? t : null;
  }

  /** Smallest 2D distance from `p` to any present target (alive or dead); Infinity when none. */
  minDist(p: THREE.Vector3): number {
    let best = Infinity;
    for (let i = 0; i < this.all.length; i++) { const d = this.all[i].dist2D(p); if (d < best) best = d; }
    return best;
  }

  /** 2D distance to the local player (Infinity when absent) — for listener-relative audio / shake decisions. */
  distToLocal(p: THREE.Vector3): number {
    const l = this.byId.get('local');
    return l && l.present ? l.dist2D(p) : Infinity;
  }

  randomAlive(): CombatTarget | null {
    const n = this.alive.length;
    return n === 0 ? null : this.alive[Math.floor(Math.random() * n)];
  }

  /**
   * Random present target, preferring one that is not dead (i.e. downed) — the ambient spawner's anchor when nobody
   * is alive, so patrols keep coming while the whole squad is downed / waiting to respawn.
   */
  randomPresent(): CombatTarget | null {
    let n = 0;
    for (let i = 0; i < this.all.length; i++) if (!this.all[i].isDead) n++;
    if (n > 0) {
      let k = Math.floor(Math.random() * n);
      for (let i = 0; i < this.all.length; i++) if (!this.all[i].isDead && k-- === 0) return this.all[i];
    }
    const m = this.all.length;
    return m === 0 ? null : this.all[Math.floor(Math.random() * m)];
  }
}
