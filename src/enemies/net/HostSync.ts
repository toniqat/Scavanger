import type * as THREE from 'three';
import {
  ENEMY_STATUS_BITS, NET_ENEMY_KEYFRAME_S, NET_ENEMY_SNAPSHOT_HZ, type EnemySnapshot, type EnemyType, type EnemyWire, type EnemyWireState, type Vec3Tuple,
} from '@/shared';
import type { Enemy } from '../Enemy';

/* ────────────────────────────────────────────────────────────────────────────
 * Host → clients encoding helpers (authority side). Allocation here is fine: snapshots go out at
 * NET_ENEMY_SNAPSHOT_HZ and events are sparse.
 * ──────────────────────────────────────────────────────────────────────────── */

export function round(v: number, dp: number): number {
  const m = dp === 1 ? 10 : dp === 2 ? 100 : dp === 3 ? 1000 : 10 ** dp;
  return Math.round(v * m) / m;
}

export function tuple(v: THREE.Vector3, dp = 2): Vec3Tuple {
  return [round(v.x, dp), round(v.y, dp), round(v.z, dp)];
}

/**
 * Animation hint: 0 none, 1 charger windup, 2 charger rush, 3 spewer windup, 4 hunter airborne;
 * Phase 4: 5 rogue shooting, 6 rogue in cover, 7 rogue rushing, 8 artillery dug in, 9 toxic swelling, 10 behemoth windup, 11 behemoth rush;
 * Phase 7: 12 rogue reloading, 13 rogue throwing a grenade.
 * 2026-09-11: 14..20 belong to the named rogues and are set directly by `ai/named/*` on `Enemy.namedHint`.
 */
export function animHint(e: Enemy): number {
  if (e.spatT > 0 && e.state !== 'dead') return 4;   // 2026-09-13: 지하벌레가 뱉은 몸은 날고 있다 (종류 분기보다 먼저 — 독성 · 포병도)
  if (e.namedHint > 0 && e.state !== 'dead') return e.namedHint;   // 죽은 몸은 마지막 힌트(연사 19 등)를 싣지 않는다
  if (e.isHumanoid) {
    if (e.incapTimer > 0) return 0;      // 전소: the replica writhes from the status bit, not the cover pose
    if (e.state === 'stagger') return 6;
    if (e.throwTimer > 0) return 13;     // Phase 7: grenade wind-up
    if (e.reloadTimer > 0) return 12;    // Phase 7: reloading (crouched, rifle down)
    switch (e.roguePhase) {
      case 2: return 6;
      case 3: return e.hitCrouchTimer > 0 ? 6 : 5;
      case 4: return 7;
      default: return 0;
    }
  }
  if (e.type === 'behemoth') {
    if (e.chargePhase === 1) return 10;
    if (e.chargePhase === 2) return 11;
    return 0;
  }
  if (e.type === 'toxic') return e.toxicPhase === 1 ? 9 : 0;
  if (e.type === 'artillery') return e.dug > 0.5 ? 8 : 0;
  if (e.airborne) return 4;
  if (e.chargePhase === 1) return 1;
  if (e.chargePhase === 2) return 2;
  if (e.spitPhase > 0) return 3;
  return 0;
}

/** Corpses leave the snapshot once the death animation has settled (replicas keep them from their own corpse timer). */
const CORPSE_SNAPSHOT_SECONDS = 1.5;

/** Live status bits (`EnemyWire.sb`, `ENEMY_STATUS_BITS`): burning / slowed / 전소 / shocked. 0 when clean. */
export function statusBits(e: Enemy): number {
  let b = 0;
  if (e.burnTimer > 0) b |= ENEMY_STATUS_BITS.BURNING;
  if (e.slowTimer > 0 && e.slowFactor < 1) b |= ENEMY_STATUS_BITS.SLOWED;
  if (e.incapTimer > 0) b |= ENEMY_STATUS_BITS.INCINERATED;
  if (e.shockTimer > 0) b |= ENEMY_STATUS_BITS.SHOCKED;
  return b;
}

/**
 * Phase 9: what the host last sent for one enemy (rounded wire values). A delta compares the current rounded fields
 * against this entry and sends only the differences; `seenSeq` marks the snapshot that last listed the id so the
 * encoder can tell which ids dropped out (`gone`).
 */
interface CacheEntry {
  ty: EnemyType;
  x: number; y: number; z: number;
  yaw: number;
  hp: number;
  st: EnemyWireState;
  a: number;
  sb: number;
  w: string;
  seenSeq: number;
}

/** Snapshots between two keyframes (`NET_ENEMY_KEYFRAME_S × NET_ENEMY_SNAPSHOT_HZ`). */
export const KEYFRAME_EVERY = Math.max(1, Math.round(NET_ENEMY_KEYFRAME_S * NET_ENEMY_SNAPSHOT_HZ));

/**
 * Phase 9: per-host delta state for `encodeSnapshot`. `seq` is monotonic for the life of the cache; `forceFull` makes
 * the next snapshot a keyframe (set by `reset`, and by the system on `flow rejoined / takeover`). Entries are reused
 * per id; the map only grows with the number of enemies that ever appeared since the last keyframe rebuild.
 */
export class SnapshotCache {
  private readonly entries = new Map<number, CacheEntry>();
  seq = 0;
  forceFull = true;
  /** Diagnostics: kind of the last snapshot encoded. */
  lastFull = false;

  /** Forget every entry and start a fresh keyframe. `seqBase` lets a promoted host continue past the seq its replica saw. */
  reset(seqBase = 0): void {
    this.entries.clear();
    this.seq = Math.max(0, Math.floor(seqBase));
    this.forceFull = true;
    this.lastFull = false;
  }

  get size(): number { return this.entries.size; }
  has(id: number): boolean { return this.entries.has(id); }

  /** @internal encoder access */
  get map(): Map<number, CacheEntry> { return this.entries; }
}

/** Corpses leave the snapshot once the death animation has settled (replicas keep them from their own corpse timer). */
function eligible(x: Enemy): boolean {
  return x.active && !(x.state === 'dead' && x.deathTimer > CORPSE_SNAPSHOT_SECONDS);
}

/**
 * Phase 9: delta snapshot of every active enemy (alive, staggered, fleeing, or a corpse still animating).
 * - **Keyframe** (`force`, `cache.forceFull`, or every `KEYFRAME_EVERY` snapshots by `seq`): every field of every
 *   eligible enemy, `full: true`; `a` / `sb` are omitted when 0 (the replica reads an omitted field as 0 in a keyframe).
 * - **Delta**: only enemies whose rounded fields changed since the cache last saw them, and only the changed fields;
 *   an id the cache does not hold gets its full field set (`ty` / `w` included) so `ee spawn`-created replicas and
 *   late listeners can build it. `a` / `sb` are written whenever they changed — a change back to 0 is sent as an
 *   explicit `0` because an omitted delta field means "unchanged".
 * - `gone` = ids the cache held that are not eligible this snapshot (despawned, or a corpse past its snapshot window;
 *   replicas keep dead bodies from their own corpse timer). Sent on keyframes too (harmless, and it lets a replica
 *   release before its sweep).
 * A keyframe is ~90 B per enemy as JSON; a delta for an idle swarm is a few bytes per moving enemy.
 */
export function encodeSnapshot(active: readonly Enemy[], time: number, cache: SnapshotCache, force = false): EnemySnapshot {
  const seq = ++cache.seq;
  const full = force || cache.forceFull || seq % KEYFRAME_EVERY === 0;
  cache.forceFull = false;
  cache.lastFull = full;
  const map = cache.map;
  const e: EnemyWire[] = [];
  for (let i = 0; i < active.length; i++) {
    const x = active[i];
    if (!eligible(x)) continue;
    const px = round(x.position.x, 2), py = round(x.position.y, 2), pz = round(x.position.z, 2);
    const yaw = round(x.yaw, 3);
    const hp = round(x.hp, 1);
    const st = x.state as EnemyWireState;
    const a = animHint(x);
    const sb = x.state === 'dead' ? 0 : statusBits(x);
    const wid = x.weaponId || '';
    let entry = map.get(x.id);
    if (full || !entry) {
      const w: EnemyWire = { id: x.id, ty: x.type, p: [px, py, pz], yaw, hp, st };
      if (a !== 0) w.a = a;
      if (wid) w.w = wid;
      if (sb !== 0) w.sb = sb;
      e.push(w);
      if (!entry) {
        entry = { ty: x.type, x: px, y: py, z: pz, yaw, hp, st, a, sb, w: wid, seenSeq: seq };
        map.set(x.id, entry);
      } else {
        entry.ty = x.type; entry.x = px; entry.y = py; entry.z = pz; entry.yaw = yaw; entry.hp = hp; entry.st = st; entry.a = a; entry.sb = sb; entry.w = wid;
        entry.seenSeq = seq;
      }
      continue;
    }
    entry.seenSeq = seq;
    let w: EnemyWire | null = null;
    if (entry.ty !== x.type) { w = { id: x.id, ty: x.type }; entry.ty = x.type; }
    if (entry.x !== px || entry.y !== py || entry.z !== pz) {
      (w ??= { id: x.id }).p = [px, py, pz];
      entry.x = px; entry.y = py; entry.z = pz;
    }
    if (entry.yaw !== yaw) { (w ??= { id: x.id }).yaw = yaw; entry.yaw = yaw; }
    if (entry.hp !== hp) { (w ??= { id: x.id }).hp = hp; entry.hp = hp; }
    if (entry.st !== st) { (w ??= { id: x.id }).st = st; entry.st = st; }
    if (entry.a !== a) { (w ??= { id: x.id }).a = a; entry.a = a; }
    if (entry.w !== wid) { if (wid) (w ??= { id: x.id }).w = wid; entry.w = wid; }
    if (entry.sb !== sb) { (w ??= { id: x.id }).sb = sb; entry.sb = sb; }
    if (w) e.push(w);
  }
  let gone: number[] | undefined;
  for (const [id, entry] of map) {
    if (entry.seenSeq === seq) continue;
    (gone ??= []).push(id);
    map.delete(id);
  }
  const msg: EnemySnapshot = { t: 'es', time, seq, full, e };
  if (gone) msg.gone = gone;
  return msg;
}
