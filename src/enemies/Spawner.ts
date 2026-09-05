import * as THREE from 'three';
import type { EnemyType, GameContext } from '@/shared';
import type { Enemy } from './Enemy';
import type { TargetList } from './Targets';

/** Spawn services provided by EnemySystem to the spawner / wave director. */
export interface SpawnHost {
  readonly ctx: GameContext;
  /** Every player (local + remote) this frame; spawn placement keeps out of all of their views. */
  readonly targets: TargetList;
  aliveCount(): number;
  /** Make room for `n` more bugs (despawns corpses first, then far idle bugs). Returns how many may be spawned. */
  ensureCapacity(n: number, cap: number): number;
  spawn(type: EnemyType, position: THREE.Vector3, yaw: number, chase: boolean, relentless: boolean): Enemy | null;
  /** Alive (not dead / fleeing) enemies of one type — per-type caps (artillery, behemoth). */
  countAlive(type: EnemyType): number;
}

/** Per-type alive caps for the gimmick bugs. */
export const MAX_ARTILLERY = 2;
export const MAX_BEHEMOTH = 1;

const _eye = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();

/** True when ANY alive player could see a bug appearing at `point` (inside their forward cone and unobstructed). */
export function isVisibleToAnyPlayer(host: SpawnHost, point: THREE.Vector3): boolean {
  const world = host.ctx.world;
  if (!world) return false;
  const players = host.targets.alive;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    t.getEyePosition(_eye);
    t.getForward(_fwd);
    _d.set(point.x - _eye.x, point.y + 0.8 - _eye.y, point.z - _eye.z);
    const dist = _d.length();
    if (dist < 1e-3) return true;
    _d.multiplyScalar(1 / dist);
    const facing = _d.x * _fwd.x + _d.z * _fwd.z;
    if (facing < 0.2) continue;                  // outside this player's ~80° forward cone
    if (world.raycast(_eye, _d, dist - 1) === null) return true;
  }
  return false;
}

/**
 * Find a spawn center within [minDist, maxDist] of `around`, preferring nests, never within `minPlayerDist` of ANY
 * player or inside any player's view. Falls back to a point behind the player nearest to `around`.
 * Writes into `out`; returns false if nothing works.
 */
export function findSpawnCenter(host: SpawnHost, around: THREE.Vector3, minDist: number, maxDist: number, preferNests: boolean, minPlayerDist: number, out: THREE.Vector3): boolean {
  const world = host.ctx.world;
  if (!world) return false;
  const targets = host.targets;
  const anchor = targets.nearestAlive(around) ?? targets.local() ?? null;
  const ppos = anchor ? anchor.position : around;

  const ok = (p: THREE.Vector3): boolean => {
    if (!world.isInsideBounds(p.x, p.z)) return false;
    if (targets.minDist(p) < minPlayerDist) return false;
    return !isVisibleToAnyPlayer(host, p);
  };

  if (preferNests) {
    const nests = world.getNestPositions();
    // random start index so the same nest is not always chosen
    const n = nests.length;
    if (n > 0) {
      const start = Math.floor(Math.random() * n);
      for (let i = 0; i < n; i++) {
        const nest = nests[(start + i) % n];
        const d = Math.hypot(nest.x - around.x, nest.z - around.z);
        if (d < minDist || d > maxDist) continue;
        if (ok(nest)) { out.copy(nest); out.y = world.getHeightAt(out.x, out.z); return true; }
      }
    }
  }

  const candidates = world.getEnemySpawnPoints(around, 6, minDist, maxDist);
  for (const c of candidates) if (ok(c)) { out.copy(c); out.y = world.getHeightAt(out.x, out.z); return true; }

  // fallback: behind the anchor player
  if (anchor) {
    anchor.getForward(_fwd);
    for (let i = 0; i < 6; i++) {
      const dist = Math.max(minPlayerDist + 5, minDist) + Math.random() * 20;
      const ang = (Math.random() - 0.5) * 1.2;
      const c = Math.cos(ang), s = Math.sin(ang);
      const bx = -_fwd.x * c - _fwd.z * s, bz = _fwd.x * s - _fwd.z * c;
      _p.set(ppos.x + bx * dist, 0, ppos.z + bz * dist);
      if (!world.isInsideBounds(_p.x, _p.z)) continue;
      _p.y = world.getHeightAt(_p.x, _p.z);
      world.resolveCollision(_p, 1.5);
      out.copy(_p); out.y = world.getHeightAt(out.x, out.z);
      return true;
    }
  }
  if (candidates.length > 0) { out.copy(candidates[0]); out.y = world.getHeightAt(out.x, out.z); return true; }
  return false;
}

/** Spawn a group scattered around `center`. Returns spawned count. */
export function spawnGroup(host: SpawnHost, types: readonly EnemyType[], center: THREE.Vector3, chase: boolean, relentless: boolean, faceTarget?: THREE.Vector3): number {
  const world = host.ctx.world;
  if (!world) return 0;
  let n = 0;
  for (let i = 0; i < types.length; i++) {
    const ang = (i / types.length) * Math.PI * 2 + Math.random() * 0.8;
    const rad = 1.5 + Math.random() * (2 + types.length * 0.5);
    _p.set(center.x + Math.cos(ang) * rad, 0, center.z + Math.sin(ang) * rad);
    if (!world.isInsideBounds(_p.x, _p.z)) _p.copy(center);
    world.resolveCollision(_p, 1.2);
    _p.y = world.getHeightAt(_p.x, _p.z);
    const yaw = faceTarget ? Math.atan2(faceTarget.x - _p.x, faceTarget.z - _p.z) : Math.random() * Math.PI * 2;
    if (host.spawn(types[i], _p, yaw, chase, relentless)) n++;
  }
  return n;
}

const groupBuf: EnemyType[] = [];

/** Composition of an ambient patrol for the current threat level (0..1). */
export function ambientGroup(threat: number): readonly EnemyType[] {
  groupBuf.length = 0;
  const scavs = 4 + Math.floor(Math.random() * (5 * (0.5 + threat)));
  for (let i = 0; i < Math.min(8, scavs); i++) groupBuf.push('scavenger');
  if (Math.random() < 0.25 + threat * 0.6) groupBuf.push('hunter');
  if (Math.random() < threat * 0.5) groupBuf.push('hunter');
  if (threat > 0.25 && Math.random() < threat * 0.55) groupBuf.push('warrior');
  if (threat > 0.3 && Math.random() < threat * 0.4) groupBuf.push('spewer');
  if (threat > 0.5 && Math.random() < (threat - 0.5) * 0.4) groupBuf.push('charger');
  // Phase 4: suicide runners from threat 0.4 (artillery is placed separately, 80–120 m out)
  if (threat >= 0.4 && Math.random() < threat * 0.6) groupBuf.push('toxic');
  if (threat >= 0.6 && Math.random() < (threat - 0.4) * 0.5) groupBuf.push('toxic');
  return groupBuf;
}

/** Composition of extraction wave `index` (0-based) with `count` bugs. */
export function waveGroup(index: number, count: number): readonly EnemyType[] {
  groupBuf.length = 0;
  let remaining = count;
  // Phase 4: a behemoth from wave 3 (WaveDirector enforces MAX_BEHEMOTH), toxics from wave 2
  if (index >= 3 && remaining > 6) { groupBuf.push('behemoth'); remaining--; }
  if (index >= 2) {
    const toxics = Math.min(remaining - 4, index >= 4 ? 3 : 2);
    for (let i = 0; i < toxics; i++) groupBuf.push('toxic');
    remaining -= Math.max(0, toxics);
  }
  if (index === 3 || index >= 6) { groupBuf.push('charger'); remaining--; }
  if (index >= 2) {
    const warriors = Math.min(remaining - 3, 1 + Math.floor(index / 2));
    for (let i = 0; i < warriors; i++) groupBuf.push('warrior');
    remaining -= Math.max(0, warriors);
    const spewers = Math.min(remaining - 3, index >= 4 ? 2 : 1);
    for (let i = 0; i < spewers; i++) groupBuf.push('spewer');
    remaining -= Math.max(0, spewers);
  }
  const hunters = Math.min(remaining - 2, 1 + Math.floor(index * 0.75));
  for (let i = 0; i < hunters; i++) groupBuf.push('hunter');
  remaining -= Math.max(0, hunters);
  for (let i = 0; i < remaining; i++) groupBuf.push('scavenger');
  return groupBuf;
}

/**
 * Ambient pressure: patrol groups trickle in from nests 60–140 m away while the players roam.
 * Each patrol is placed around a random alive player (the local one in single-player).
 */
export class AmbientSpawner {
  threat = 0.35;
  private timer = 6;
  private readonly center = new THREE.Vector3();

  get cap(): number { return Math.round(12 + 24 * this.threat); }

  reset(): void { this.timer = 6; }

  /** Seed the map with a few idle patrols far from the players right after world:ready. */
  initialPopulate(host: SpawnHost, around?: THREE.Vector3): void {
    const ctx = host.ctx;
    const world = ctx.world;
    if (!world) return;
    around = around ?? host.targets.local()?.position ?? world.getPlayerSpawn();
    const groups = 2 + Math.round(this.threat * 3);
    for (let g = 0; g < groups; g++) {
      if (!findSpawnCenter(host, around, 70, 220, true, 60, this.center)) break;
      const types = ambientGroup(this.threat);
      const allowed = host.ensureCapacity(types.length, this.cap);
      if (allowed <= 0) break;
      spawnGroup(host, types.slice(0, allowed), this.center, false, false);
    }
  }

  update(dt: number, host: SpawnHost): void {
    const ctx = host.ctx;
    if (ctx.phase !== 'playing' || !ctx.world?.ready || !ctx.player) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = THREE.MathUtils.lerp(25, 12, this.threat) * (0.8 + Math.random() * 0.4);
    if (host.aliveCount() >= this.cap) return;
    const around = host.targets.randomAlive() ?? host.targets.randomPresent(); // everyone downed → still spawn around a body
    if (!around) return;
    const types = ambientGroup(this.threat);
    const allowed = host.ensureCapacity(types.length, this.cap);
    if (allowed <= 0) return;
    if (!findSpawnCenter(host, around.position, 60, 140, true, 30, this.center)) return;
    // patrols that spawn because pressure is high come in already hunting
    const hunting = Math.random() < this.threat * 0.5;
    spawnGroup(host, types.slice(0, allowed), this.center, hunting, false, hunting ? around.position : undefined);
    this.maybeArtillery(host, around.position);
  }

  /** Phase 4: from threat 0.5 an artillery bug may dig in 80–120 m out (≤ MAX_ARTILLERY alive), already aware. */
  private maybeArtillery(host: SpawnHost, around: THREE.Vector3): void {
    if (this.threat < 0.5 || Math.random() > 0.35 + (this.threat - 0.5) * 0.6) return;
    if (host.countAlive('artillery') >= MAX_ARTILLERY) return;
    if (host.ensureCapacity(1, this.cap + 2) <= 0) return;
    if (!findSpawnCenter(host, around, 80, 120, false, 60, this.center)) return;
    const yaw = Math.atan2(around.x - this.center.x, around.z - this.center.z);
    host.spawn('artillery', this.center, yaw, true, false);
  }
}
