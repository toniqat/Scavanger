import * as THREE from 'three';
import type { EnemyType, GameContext, PlanetEcosystem } from '@/shared';
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

/**
 * Per-type alive caps for the gimmick bugs — the **defaults** since Phase 11: a mission generated for a planet uses
 * `PlanetEcosystem.maxArtillery` / `maxBehemoth` instead (`maxArtilleryOf` / `maxBehemothOf`). With no planet these
 * are still the numbers, so single-player without a destination behaves exactly as before.
 */
export const MAX_ARTILLERY = 2;
export const MAX_BEHEMOTH = 1;

/* ══ Phase 11: 행성 생태계 (`PlanetEcosystem`) ═══════════════════════════════════════════════════════════════════
 * The ecosystem is a **re-weighting of existing content**: it never adds a type and never opens a threat gate.
 * Group composition keeps the exact ladder it had (the same rolls, the same probabilities, the same
 * `threat > x` / `index >= n` gates, so the difficulty curve is unchanged) — what changed is that each *slot* now
 * draws its silhouette from the planet's weights inside its own power tier. A type the planet does not list (or
 * lists as 0) can never fill a slot, and a slot whose whole tier is missing here is simply skipped (in a wave the
 * leftover count falls through to the filler tier, so waves keep their size).
 * With `eco === null` every helper below returns the pre-Phase-11 answer verbatim.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Bug types a patrol / wave can be composed of. Artillery digs in on its own, rogues are crate guards. */
const GROUP_TYPES: readonly EnemyType[] = ['scavenger', 'hunter', 'warrior', 'spewer', 'charger', 'toxic', 'behemoth'];

/** Interchangeable peer tiers: a slot keeps its power tier, the planet decides which member of it appears. */
const TIER_FILLER: readonly EnemyType[] = ['scavenger'];
const TIER_MEDIUM: readonly EnemyType[] = ['hunter', 'warrior', 'spewer'];
const TIER_HEAVY: readonly EnemyType[] = ['behemoth', 'charger'];
const TIER_RUNNER: readonly EnemyType[] = ['toxic'];

/** Ambient threat gates, transcribed from the pre-Phase-11 `ambientGroup` ladder (behemoths are waves-only). */
const AMBIENT_GATE: Partial<Record<EnemyType, (threat: number) => boolean>> = {
  scavenger: () => true,
  hunter: () => true,
  warrior: (t) => t > 0.25,
  spewer: (t) => t > 0.3,
  toxic: (t) => t >= 0.4,
  charger: (t) => t > 0.5,
  behemoth: () => false,
};

/** Wave gates, transcribed from `waveGroup`'s index ladder (the charger's `index === 3 || index >= 6` stays a slot roll). */
const WAVE_GATE: Partial<Record<EnemyType, (index: number) => boolean>> = {
  scavenger: () => true,
  hunter: () => true,
  warrior: (i) => i >= 2,
  spewer: (i) => i >= 2,
  toxic: (i) => i >= 2,
  charger: (i) => i >= 3,
  behemoth: (i) => i >= 3,
};

type Gate = (t: EnemyType) => boolean;

function weightOf(eco: PlanetEcosystem, t: EnemyType): number {
  const w = eco.bugs[t];
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 0;
}

/** true when this planet has the type at all (any positive weight). `null` eco = everything lives everywhere. */
export function ecoAllows(eco: PlanetEcosystem | null, t: EnemyType): boolean {
  return !eco || weightOf(eco, t) > 0;
}

export function maxArtilleryOf(eco: PlanetEcosystem | null): number {
  if (!eco || !Number.isFinite(eco.maxArtillery)) return MAX_ARTILLERY;
  return Math.max(0, Math.round(eco.maxArtillery));
}

export function maxBehemothOf(eco: PlanetEcosystem | null): number {
  if (!eco || !Number.isFinite(eco.maxBehemoth)) return MAX_BEHEMOTH;
  return Math.max(0, Math.round(eco.maxBehemoth));
}

/** Weighted draw over `from`, restricted to what this planet has and what the gate allows. null = nothing eligible. */
function weightedPick(eco: PlanetEcosystem, from: readonly EnemyType[], open: Gate): EnemyType | null {
  let total = 0;
  for (const t of from) if (open(t)) total += weightOf(eco, t);
  if (total <= 0) return null;
  // deliberately `Math.random()`: composition has always been unseeded (only placement / guards are seed-deterministic)
  let r = Math.random() * total;
  for (const t of from) {
    if (!open(t)) continue;
    const w = weightOf(eco, t);
    if (w <= 0) continue;
    r -= w;
    if (r <= 0) return t;
  }
  for (let i = from.length - 1; i >= 0; i--) if (open(from[i]) && weightOf(eco, from[i]) > 0) return from[i];
  return null;
}

/**
 * The type that fills one composition slot. `def` is what the pre-Phase-11 ladder pushed here (used verbatim when
 * there is no planet); `widen` lets the filler tier fall back to any eligible type so a group is never empty.
 */
function slotType(eco: PlanetEcosystem | null, tier: readonly EnemyType[], def: EnemyType, open: Gate, widen: boolean): EnemyType | null {
  if (!eco) return def;
  return weightedPick(eco, tier, open) ?? (widen ? weightedPick(eco, GROUP_TYPES, open) : null);
}

/** Extra spawn ceilings a planet imposes on the ambient trickle. */
export function ambientCap(threat: number, eco: PlanetEcosystem | null): number {
  const base = 12 + 24 * threat;
  const p = eco && Number.isFinite(eco.pressure) ? Math.max(0, eco.pressure) : 1;
  return Math.max(1, Math.round(base * p));
}

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

/**
 * Composition of an ambient patrol for the current threat level (0..1).
 * `eco` (Phase 11): the planet's ecosystem. The ladder — how many slots there are and when each one opens — is
 * untouched; only the type that fills a slot is drawn from `eco.bugs` inside the slot's tier.
 */
export function ambientGroup(threat: number, eco: PlanetEcosystem | null = null): readonly EnemyType[] {
  groupBuf.length = 0;
  const open: Gate = (t) => (AMBIENT_GATE[t] ?? (() => false))(threat);
  const slot = (tier: readonly EnemyType[], def: EnemyType, widen = false): void => {
    const t = slotType(eco, tier, def, open, widen);
    if (t) groupBuf.push(t);
  };
  const scavs = 4 + Math.floor(Math.random() * (5 * (0.5 + threat)));
  for (let i = 0; i < Math.min(8, scavs); i++) slot(TIER_FILLER, 'scavenger', true);
  if (Math.random() < 0.25 + threat * 0.6) slot(TIER_MEDIUM, 'hunter');
  if (Math.random() < threat * 0.5) slot(TIER_MEDIUM, 'hunter');
  if (threat > 0.25 && Math.random() < threat * 0.55) slot(TIER_MEDIUM, 'warrior');
  if (threat > 0.3 && Math.random() < threat * 0.4) slot(TIER_MEDIUM, 'spewer');
  if (threat > 0.5 && Math.random() < (threat - 0.5) * 0.4) slot(TIER_HEAVY, 'charger');
  // Phase 4: suicide runners from threat 0.4 (artillery is placed separately, 80–120 m out)
  if (threat >= 0.4 && Math.random() < threat * 0.6) slot(TIER_RUNNER, 'toxic');
  if (threat >= 0.6 && Math.random() < (threat - 0.4) * 0.5) slot(TIER_RUNNER, 'toxic');
  return groupBuf;
}

/**
 * Composition of extraction wave `index` (0-based) with `count` bugs.
 * `eco` (Phase 11) as in `ambientGroup`: the slot counts and index gates are unchanged, the silhouettes are drawn
 * from the planet's weights. A tier the planet lacks skips its slots and the leftover count becomes filler, so the
 * wave still arrives with `count` bugs.
 */
export function waveGroup(index: number, count: number, eco: PlanetEcosystem | null = null): readonly EnemyType[] {
  groupBuf.length = 0;
  const open: Gate = (t) => (WAVE_GATE[t] ?? (() => false))(index);
  let remaining = count;
  const add = (tier: readonly EnemyType[], def: EnemyType, n = 1): void => {
    for (let i = 0; i < n; i++) {
      const t = slotType(eco, tier, def, open, false);
      if (!t) return;                       // this tier does not live here → the slot falls through to the filler
      groupBuf.push(t);
      remaining--;
    }
  };
  // Phase 4: a behemoth from wave 3 (WaveDirector enforces the behemoth cap), toxics from wave 2
  if (index >= 3 && remaining > 6) add(TIER_HEAVY, 'behemoth');
  if (index >= 2) add(TIER_RUNNER, 'toxic', Math.min(remaining - 4, index >= 4 ? 3 : 2));
  if (index === 3 || index >= 6) add(TIER_HEAVY, 'charger');
  if (index >= 2) {
    add(TIER_MEDIUM, 'warrior', Math.min(remaining - 3, 1 + Math.floor(index / 2)));
    add(TIER_MEDIUM, 'spewer', Math.min(remaining - 3, index >= 4 ? 2 : 1));
  }
  add(TIER_MEDIUM, 'hunter', Math.min(remaining - 2, 1 + Math.floor(index * 0.75)));
  const rest = Math.max(0, remaining);
  for (let i = 0; i < rest; i++) groupBuf.push(slotType(eco, TIER_FILLER, 'scavenger', open, true) ?? 'scavenger');
  return groupBuf;
}

/**
 * Ambient pressure: patrol groups trickle in from nests 60–140 m away while the players roam.
 * Each patrol is placed around a random alive player (the local one in single-player).
 */
export class AmbientSpawner {
  threat = 0.35;
  /**
   * Phase 11: ecosystem of the 목표 행성 (set by `EnemySystem` at `world:ready`, null = no planet → the old numbers).
   * Scales the population cap (`eco.pressure`), the artillery ceiling and every group's composition.
   */
  eco: PlanetEcosystem | null = null;
  private timer = 6;
  private readonly center = new THREE.Vector3();

  get cap(): number { return ambientCap(this.threat, this.eco); }

  reset(): void { this.timer = 6; }

  /** Phase 7 (host promotion): resume the ambient trickle mid-mission with a normal-length gap instead of the 6 s initial one. */
  resume(): void { this.timer = THREE.MathUtils.lerp(20, 10, this.threat) * (0.6 + Math.random() * 0.4); }

  /** Seed the map with a few idle patrols far from the players right after world:ready. */
  initialPopulate(host: SpawnHost, around?: THREE.Vector3): void {
    const ctx = host.ctx;
    const world = ctx.world;
    if (!world) return;
    around = around ?? host.targets.local()?.position ?? world.getPlayerSpawn();
    const groups = 2 + Math.round(this.threat * 3);
    for (let g = 0; g < groups; g++) {
      if (!findSpawnCenter(host, around, 70, 220, true, 60, this.center)) break;
      const types = ambientGroup(this.threat, this.eco);
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
    const types = ambientGroup(this.threat, this.eco);
    const allowed = host.ensureCapacity(types.length, this.cap);
    if (allowed <= 0) return;
    if (!findSpawnCenter(host, around.position, 60, 140, true, 30, this.center)) return;
    // patrols that spawn because pressure is high come in already hunting
    const hunting = Math.random() < this.threat * 0.5;
    spawnGroup(host, types.slice(0, allowed), this.center, hunting, false, hunting ? around.position : undefined);
    this.maybeArtillery(host, around.position);
  }

  /**
   * Phase 4: from threat 0.5 an artillery bug may dig in 80–120 m out, already aware.
   * Phase 11: the ceiling is `eco.maxArtillery` and a planet whose `eco.bugs` has no artillery never digs one in.
   */
  private maybeArtillery(host: SpawnHost, around: THREE.Vector3): void {
    if (this.threat < 0.5 || Math.random() > 0.35 + (this.threat - 0.5) * 0.6) return;
    if (!ecoAllows(this.eco, 'artillery')) return;
    if (host.countAlive('artillery') >= maxArtilleryOf(this.eco)) return;
    if (host.ensureCapacity(1, this.cap + 2) <= 0) return;
    if (!findSpawnCenter(host, around, 80, 120, false, 60, this.center)) return;
    const yaw = Math.atan2(around.x - this.center.x, around.z - this.center.z);
    host.spawn('artillery', this.center, yaw, true, false);
  }
}
