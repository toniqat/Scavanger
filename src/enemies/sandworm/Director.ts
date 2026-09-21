/**
 * src/enemies/sandworm/Director.ts — **the sandworm event director** (2026-09-13, appearance check reworked 2026-09-15).
 *
 * The question this file answers: *does a sandworm appear this raid, when · where, and what does it do afterwards.*
 *
 * ## Appearance — a cumulative chance (user's decision 2026-09-15, `src/enemies/README.md` Decisions)
 * No pre-roll and no time window. Every `SANDWORM_CHECK_S` the **host** reads the conditions and rolls that moment's `p` — at most once per raid.
 *   1. Candidates = living humans (local + `ctx.net.getRemotePlayers()` in the mission, not dead, not downed) + **android
 *      squadmates** (`ctx.allies.getCombatBodies()`). Weight state: local `ctx.inventory.getWeight().state`, remote
 *      `RemotePlayerRef.weightState` (an older sender = unknown = normal), android = its bag kg / capacity on the same human thresholds (`WEIGHT_*_RATIO`; unknown = normal).
 *   2. **An eligible member** = sprinting (`isSprinting` · `PlayerFlags.SPRINT` · `ALLY_FLAGS.SPRINT`) and carrying `light`
 *      (slightly heavy) or more. The largest cluster of ≥ `SANDWORM_MIN_MEMBERS` (2) eligible members within
 *      `SANDWORM_GROUP_RADIUS` (40 m) is taken — with none, p = 0. **Alone (solo with no android) it never appears.**
 *   3. p = `SANDWORM_BASE_CHANCE_BY_THREAT[threat]` × min(1, Σ weights) × the closeness factor (+ the lure bonus), clamped to 0..1.
 *      - Weights: light `SANDWORM_P_PER_LIGHT`, heavy · over `SANDWORM_P_PER_HEAVY`.
 *      - Closeness factor: mean pairwise distance in the cluster d̄ ≤ `SANDWORM_P_NEAR_M` → 1, d̄ = `SANDWORM_GROUP_RADIUS` → `SANDWORM_P_FAR_MUL` (linear between).
 *      - Lure: with a living lure grenade (the gadget lure deployable · `LureField`'s `'lure'`) within `SANDWORM_LURE_RANGE_M` of the
 *        cluster centre, `SANDWORM_P_LURE` is added and that spot becomes the eruption spot with `SANDWORM_LURE_SPOT_CHANCE` (ground check fails → the other one).
 *   4. Spot check (`validSpot`): inside the map · nobody in the cluster stands `OFF_TERRAIN_M` above the terrain (deck · roof ·
 *      tram) · `WorldRef.burrowGroundOk(x, z, BURROW_GROUND_CHECK_R × scale)` (flat bare ground — no structure · rail · dirt road ·
 *      prop · nest · spore grove · hazard zone · gather node · crate · ship hull; a world without it = false). A successful roll on a bad spot skips this check.
 *
 * ### p for one check (csv defaults — light 0.12 · heavy 0.25 · near 20 m · far ×0.25 · threat 0.6 / 0.8 / 1.0, no lure)
 * | members · weight | d̄ ≤ 20 m (threat 1 · 2 · 3) | d̄ = 40 m (threat 1 · 2 · 3) |
 * |------------------|------------------------------|------------------------------|
 * | 2 light          | 0.144 · 0.192 · 0.24         | 0.036 · 0.048 · 0.06         |
 * | 2 heavy          | 0.30 · 0.40 · 0.50           | 0.075 · 0.10 · 0.125         |
 * | 3 light          | 0.216 · 0.288 · 0.36         | 0.054 · 0.072 · 0.09         |
 * | 3 heavy          | 0.45 · 0.60 · 0.75           | 0.1125 · 0.15 · 0.1875       |
 * | 4 light          | 0.288 · 0.384 · 0.48         | 0.072 · 0.096 · 0.12         |
 * | 4 heavy          | 0.60 · 0.80 · 1.00           | 0.15 · 0.20 · 0.25           |
 * 3 heavy · 20 m · threat 3 = 0.75/check → 98 % within 3 checks 2 s apart. 2 light · 40 m · threat 2 = 0.048/check → 52 % in 30 s (15 checks).
 * A lure grenade adds +0.15 to any cell.
 *
 * ## The thumper (`sandworm:summon`, gadgets emits it on the host)
 * Not yet this raid → the warning starts right there, no chance and no ground check (only `OFF_TERRAIN_M`). Already happened = ignored.
 *
 * ## The type (planet threat)
 * threat 1 → the **young one** `sandworm_weak` (hp fixed at `SANDWORM_WEAK_HP` · body · eruption radius × `SANDWORM_WEAK_SCALE` · spits scavengers only),
 * threat 2–3 → the adult `sandworm` (hp rolled `SANDWORM_HP_MIN..MAX`). The console · smokes can force `weak`.
 *
 * ## The sequence
 *   Warning `SANDWORM_WARN_S` (5 s): `ee wormWarn` → every client gets dust · churned soil (building up) · a damage-radius ring ·
 *   a shake rising weak → strong with distance · the toast 「지상이변 발생」 · a ground rumble.
 *   → Eruption: damage + knockback to players within radius R (`applyDamage` — local directly, remote as `dmg.kb`, a disconnected
 *   member as `ghost:damage`) · enemies of other factions · drones · the sandworm spawns (`ee spawn` + `em` = emerging, max hp
 *   decided by the host as `ee wormErupt.hp` · type `ty`) · a pack of bugs digs out, sized by the squad (`SANDWORM_BURST_BY_SQUAD`).
 *   → Spitting bugs `SANDWORM_SPIT_PHASE_S` (30 s): `SANDWORM_SPIT_COUNT` at a time are spat from the mouth on an arc
 *   (`ee wormSpit`, alive cap `SANDWORM_ALIVE_CAP`). **Kill it first and it spits no more.**
 *   → Acid: rooted in the ground, acid volleys at the nearest player within `SANDWORM_ACID_RANGE` (the existing `ee acid` · `ee acidAt`).
 * When it dies a boss-grade corpse is left (`sandworm` · `sandworm_weak` in `loot_corpses.csv`); kill · squad kill · contracts keep their paths.
 *
 * ## Late joins · reconnects · host transfer
 * A host that got `flow rejoined` calls `resync()` — the warning in progress (remaining eta), `wormErupt {sy: 1}` per living
 * sandworm (max hp · remaining spit time · type), or `wormErupt {id: 0, sy: 1}` (the already-happened mark) when it is over. A
 * replica writes what it gets onto the sandworm (`Enemy.wormSpitUntil` · `maxHp`), so a promoted host carries straight on, and the `done` mark stops a second one.
 *
 * Every number is csv. The constants in this file are only the FX beats (the shake tick · the mouth wind-up time) · the acid
 * scatter · the composition weights for a mission with no planet · the spot check's height threshold.
 */
import * as THREE from 'three';
import {
  ALLY_FLAGS, BURROW_EMERGE_S, BURROW_GROUND_CHECK_R, PLAYER_RADIUS, PlayerFlags, explosionFalloff, planetThreat,
  SANDWORM_ACID_INTERVAL_S, SANDWORM_ACID_RANGE, SANDWORM_ACID_VOLLEY, SANDWORM_ALERT_RADIUS, SANDWORM_ALIVE_CAP,
  SANDWORM_BASE_CHANCE_BY_THREAT, SANDWORM_BURST_BY_SQUAD, SANDWORM_BURST_RING_MAX, SANDWORM_BURST_RING_MIN, SANDWORM_CHECK_S,
  SANDWORM_ERUPT_DAMAGE, SANDWORM_ERUPT_KNOCKBACK, SANDWORM_ERUPT_RADIUS, SANDWORM_GROUP_RADIUS, SANDWORM_HP_MAX, SANDWORM_HP_MIN,
  SANDWORM_LURE_RANGE_M, SANDWORM_LURE_SPOT_CHANCE, SANDWORM_MIN_MEMBERS, SANDWORM_P_FAR_MUL, SANDWORM_P_LURE, SANDWORM_P_NEAR_M,
  SANDWORM_P_PER_HEAVY, SANDWORM_P_PER_LIGHT, SANDWORM_RISE_S, SANDWORM_SHAKE_MAX, SANDWORM_SPIT_COUNT, SANDWORM_SPIT_FLIGHT_S,
  SANDWORM_SPIT_INTERVAL_S, SANDWORM_SPIT_MAX_M, SANDWORM_SPIT_MIN_M, SANDWORM_SPIT_PHASE_S, SANDWORM_WARN_S, SANDWORM_WEAK_HP,
  SANDWORM_WEAK_SCALE, WEIGHT_HEAVY_RATIO, WEIGHT_LIGHT_RATIO, WEIGHT_OVER_RATIO,
  type EnemyEvent, type EnemyType, type PlanetEcosystem, type PlanetId, type WeightState,
} from '@/shared';
import { Enemy } from '../Enemy';
import { ENEMY_CLASH, ENEMY_STATS, isWormType, type WormEnemyType } from '../EnemyTypes';
import { ecoAllows, pickEcoType, spawnBlocked } from '../Spawner';
import type { CombatTarget } from '../Targets';
import { turnToward, yawTo } from '../ai/Steering';
import { round, tuple } from '../net/HostSync';
import { isVec3Tuple } from '../model';
import { applyWormHint, WORM_HINT_ACID, WORM_HINT_SPIT } from './Pose';
/* appended (2026-09-15, android squadmates): the androids' share of the eruption */
import { damageAlliesAt } from '../parts/Damage';
import type { EnemySystem } from '../EnemySystem';

/** Candidates for the adult's spit · eruption pack (drawn on the planet ecosystem's weights). Artillery · charger · behemoth are too big to spit. */
const SPIT_TYPES: readonly EnemyType[] = ['scavenger', 'hunter', 'warrior', 'spewer', 'toxic'];
/** Weights in the same order, used in a mission with no planet (`eco` null). */
const SPIT_FALLBACK: readonly number[] = [5, 2, 1.2, 1, 0.8];
/** The young one (threat 1) spits **only the weakest bug**, and its eruption pack is that alone (user's decision). */
const SPIT_TYPES_WEAK: readonly EnemyType[] = ['scavenger'];
const SPIT_FALLBACK_WEAK: readonly number[] = [1];
/** Squad capacity — the same value as in `RogueDrop` · `WaveDirector`. */
const MAX_SQUAD = 4;
/** Interval at which the warning shake is added (s) — `camera:shake` **adds** trauma, so this beat is the unit of strength. */
const WARN_SHAKE_TICK_S = 0.2;
/** How long the mouth opens before a spit · acid (s) — wire hints 21 / 22 stand this much earlier. */
const SPIT_WINDUP_S = 0.7;
const ACID_WINDUP_S = 0.6;
/** From the second shot of an acid volley on, the radius it is scattered around the target (m). */
const ACID_SCATTER_MIN = 2.5;
const ACID_SCATTER_MAX = 5;
/** Replica: a warning whose eruption broadcast never arrived is cleared by itself this long after (s). */
const REPLICA_WARN_TIMEOUT_S = 3;
/** Spot check: skipped when anyone in the cluster stands this far above the terrain (a deck · roof · tram) (m). */
const OFF_TERRAIN_M = 1.2;
/** Skipped when a standable prop (a rock) rises this far right above the spot (m). */
const PROP_ON_SPOT_M = 0.6;
/** Cap of the candidate list (4 humans + 3 androids — the reuse pool's size). */
const MAX_CANDIDATES = 8;

const TOAST_WARN = '지상이변 발생 — 발밑에서 무언가 파고 올라온다!';
const TOAST_KILLED = '땅굴벌레 처치 — 사체를 수색할 수 있다';
const TOAST_KILLED_WEAK = '어린 땅굴벌레 처치 — 사체를 수색할 수 있다';

const TWO_PI = Math.PI * 2;
const _p = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Vector3();
const _kb = new THREE.Vector3();
const _to = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _mouth = new THREE.Vector3();
const _erupt = new THREE.Vector3();
const _lure = new THREE.Vector3();

/** One candidate of the appearance check (reused). */
interface Candidate {
  x: number; z: number;
  sprint: boolean;
  ws: WeightState;
  android: boolean;
  /** Did it fall into the cluster on this check. */
  inGroup: boolean;
}

/** The result of one check (`debugState().plan.last` · `debugChance`). */
export interface SandwormCheck {
  /** `ctx.time`. */
  at: number;
  /** Candidate count (humans + androids). */
  candidates: number;
  /** Eligible member count (sprinting + light or heavier). */
  eligible: number;
  /** Members of the largest cluster (< SANDWORM_MIN_MEMBERS → p = 0). */
  n: number;
  /** Σ weights (before the cap). */
  sum: number;
  /** Mean pairwise distance inside the cluster (m). */
  spread: number;
  closeMul: number;
  lure: boolean;
  p: number;
  cx: number; cz: number;
}

/** This raid's appearance setup (`EnemySystem.debugSandwormState.plan`). */
export interface SandwormPlan {
  /** Planet threat (1..3). */
  threat: number;
  /** The threat multiplier for one check (`SANDWORM_BASE_CHANCE_BY_THREAT`). 0 = no natural appearance this raid (a planet with no bugs · the training range). */
  base: number;
  /** This planet's sandworm type. */
  type: WormEnemyType;
  /** How many checks the host ran · how many rolls succeeded (including ones deferred by a bad spot). */
  checks: number;
  hits: number;
  /** The last check (null when there is none yet). */
  last: SandwormCheck | null;
}

function emptyPlan(): SandwormPlan {
  return { threat: 1, base: 0, type: 'sandworm', checks: 0, hits: 0, last: null };
}

/** Planet threat → type (1 = the young one). */
export function wormTypeForThreat(threat: number): WormEnemyType {
  return threat <= 1 ? 'sandworm_weak' : 'sandworm';
}
/** The type's size multiplier — multiplies the eruption radius · the spot check's radius. */
export function wormScaleOf(type: EnemyType): number {
  return type === 'sandworm_weak' ? SANDWORM_WEAK_SCALE : 1;
}
/** kg / capacity → weight state (the same thresholds as a human's `WeightInfo.state` — used for an android's bag). */
function weightStateOfRatio(ratio: number): WeightState {
  if (!Number.isFinite(ratio)) return 'normal';
  if (ratio >= WEIGHT_OVER_RATIO) return 'over';
  if (ratio >= WEIGHT_HEAVY_RATIO) return 'heavy';
  if (ratio >= WEIGHT_LIGHT_RATIO) return 'light';
  return 'normal';
}
function weightOf(ws: WeightState): number {
  return ws === 'light' ? SANDWORM_P_PER_LIGHT : ws === 'heavy' || ws === 'over' ? SANDWORM_P_PER_HEAVY : 0;
}

export class SandwormDirector {
  private sys!: EnemySystem;
  private plan: SandwormPlan = emptyPlan();
  private eco: PlanetEcosystem | null = null;
  /** This raid's event has already started (at most once per raid — a replica sets it on the broadcast). */
  private done = false;
  /** A thumper called it (debug display). */
  private summoned = false;
  private checkTimer = 0;
  private readonly warn = { active: false, p: new THREE.Vector3(), startedAt: 0, eruptAt: 0, shakeAcc: 0, r: 0, type: 'sandworm' as WormEnemyType };
  /** Length of the next eruption's spit phase (s) as changed by the console · a smoke; null = csv. */
  private forcedSpitS: number | null = null;
  /** Replica: max hp · spit end time received as `wormErupt` — applied and cleared once that enemy exists. */
  private readonly meta = new Map<number, { hp: number; spitUntil: number }>();
  /** Candidate pool of the appearance check (no allocation). */
  private readonly cands: Candidate[] = [];
  private readonly lastCheck: SandwormCheck = { at: 0, candidates: 0, eligible: 0, n: 0, sum: 0, spread: 0, closeMul: 0, lure: false, p: 0, cx: 0, cz: 0 };
  /* Debug · smoke counters (this client's) */
  warnings = 0;
  eruptions = 0;
  spitVolleys = 0;
  acidVolleys = 0;
  warnShakes = 0;

  bind(sys: EnemySystem): void {
    this.sys = sys;
    for (let i = this.cands.length; i < MAX_CANDIDATES; i++) this.cands.push({ x: 0, z: 0, sprint: false, ws: 'normal', android: false, inGroup: false });
  }

  /** Raid reset (`Pool.reset`). */
  reset(): void {
    this.plan = emptyPlan();
    this.eco = null;
    this.done = false;
    this.summoned = false;
    this.checkTimer = 0;
    this.warn.active = false;
    this.forcedSpitS = null;
    this.meta.clear();
    this.warnings = 0; this.eruptions = 0; this.spitVolleys = 0; this.acidVolleys = 0; this.warnShakes = 0;
  }

  /* ── setup ────────────────────────────────────────────────────────────── */
  /** `world:ready` (authority and replica alike). The training range · tutorial have no plan (base 0). */
  onWorldReady(planet: PlanetId | null, eco: PlanetEcosystem | null, training: boolean): void {
    const ctx = this.sys?.ctx;
    const world = ctx?.world;
    this.eco = eco;
    this.plan = emptyPlan();
    if (!ctx || training || ctx.isTraining() || !world?.ready) return;
    const threat = planetThreat(planet);
    const type = wormTypeForThreat(threat);
    const raw = SANDWORM_BASE_CHANCE_BY_THREAT[threat - 1];
    let base = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    if (eco && !this.spitTypes(type).some((t) => ecoAllows(eco, t))) base = 0;   // a planet where no bugs live
    this.plan = { threat, base, type, checks: 0, hits: 0, last: null };
    this.checkTimer = SANDWORM_CHECK_S;
    if (base > 0) this.prewarm(type);
  }

  private spitTypes(type: EnemyType): readonly EnemyType[] { return type === 'sandworm_weak' ? SPIT_TYPES_WEAK : SPIT_TYPES; }
  private spitFallback(type: EnemyType): readonly number[] { return type === 'sandworm_weak' ? SPIT_FALLBACK_WEAK : SPIT_FALLBACK; }

  /** Builds one rig of this planet's type into the pool ahead of time, puts it hidden in the scene and warms its shader (`acquire` takes it straight out). */
  private prewarm(type: WormEnemyType): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    let pool = sys.pools.get(type);
    if (!pool) { pool = []; sys.pools.set(type, pool); }
    if (pool.length === 0) {
      const e = new Enemy(type);
      e.bindHost(sys);
      pool.push(e);
    }
    const root = pool[pool.length - 1].rig.root;
    if (!root.parent) ctx.scene.add(root);
    void ctx.shaders?.warm(root);
  }

  /* ── per frame ────────────────────────────────────────────────────────── */
  update(dt: number): void {
    const sys = this.sys;
    const ctx = sys?.ctx;
    if (!ctx?.world?.ready) return;
    if (this.warn.active) this.tickWarn(dt);
    if (this.meta.size > 0) this.applyMeta();
    if (!sys.authority || !ctx.isGameplayPhase()) return;
    const now = ctx.time;
    if (this.warn.active) {
      if (now >= this.warn.eruptAt) this.erupt();
    } else if (!this.done && this.plan.base > 0 && ctx.phase === 'playing') {
      this.checkTimer -= dt;
      if (this.checkTimer <= 0) {
        this.checkTimer = SANDWORM_CHECK_S;
        this.check();
      }
    }
    const active = sys.active;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (isWormType(e.type) && e.active && e.state !== 'dead') this.tickWorm(e, dt);
    }
  }

  /* ── the appearance check (host) ───────────────────────────────────────── */
  /** Fills the candidate list (humans + androids). Returns the candidate count. */
  private collectCandidates(): number {
    const sys = this.sys;
    const ctx = sys.ctx;
    const cands = this.cands;
    let n = 0;
    const put = (x: number, z: number, sprint: boolean, ws: WeightState, android: boolean): void => {
      if (n >= cands.length) return;
      const c = cands[n++];
      c.x = x; c.z = z; c.sprint = sprint; c.ws = ws; c.android = android; c.inGroup = false;
    };
    const p = ctx.player;
    if (p && !p.isDead && !p.isDowned && !p.isDropping && p.roverRide !== true) {
      const inv = ctx.inventory;
      const ws: WeightState = inv && typeof inv.getWeight === 'function' ? inv.getWeight().state : 'normal';
      put(p.position.x, p.position.z, p.isSprinting === true, ws, false);
    }
    const net = ctx.net;
    if (net && ctx.isMultiplayer) {
      const remotes = net.getRemotePlayers();
      for (let i = 0; i < remotes.length; i++) {
        const r = remotes[i];
        if (!r.connected || !r.inMission || (r.stale && !r.suspended)) continue;
        const f = r.flags;
        if (r.isDead || r.isDowned || (f & (PlayerFlags.DEAD | PlayerFlags.DOWNED | PlayerFlags.DROPPING | PlayerFlags.IN_ROVER | PlayerFlags.IN_HUB)) !== 0) continue;
        if (r.suspended) { put(r.position.x, r.position.z, false, r.weightState ?? 'normal', false); continue; }   // a ghost does not sprint
        put(r.position.x, r.position.z, (f & PlayerFlags.SPRINT) !== 0, r.weightState ?? 'normal', false);
      }
    }
    const allies = ctx.allies;
    if (allies) {
      const bodies = allies.getCombatBodies();
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        const lo = allies.getLoadout(b.id);
        const ws = lo && lo.capacity > 0 ? weightStateOfRatio(lo.weight / lo.capacity) : 'normal';
        put(b.position.x, b.position.z, (b.flags & ALLY_FLAGS.SPRINT) !== 0, ws, true);
      }
    }
    return n;
  }

  /**
   * Computes one check's chance from the candidates `cands[0..count)` (it does not roll). A lure only means anything once
   * the cluster centre is known, so it runs in two stages: cluster → centre → (after the caller found a lure) `applyLure`.
   */
  private evaluate(cands: readonly Candidate[], count: number, out: SandwormCheck, base: number): void {
    out.candidates = count; out.eligible = 0; out.n = 0; out.sum = 0; out.spread = 0; out.closeMul = 0; out.lure = false; out.p = 0; out.cx = 0; out.cz = 0;
    const r2 = SANDWORM_GROUP_RADIUS * SANDWORM_GROUP_RADIUS;
    let eligible = 0;
    for (let i = 0; i < count; i++) { cands[i].inGroup = false; if (cands[i].sprint && weightOf(cands[i].ws) > 0) eligible++; }
    out.eligible = eligible;
    const minN = Math.max(1, Math.round(SANDWORM_MIN_MEMBERS));
    if (eligible < minN) return;
    // the largest cluster: each eligible member is an anchor, counting the eligible members inside the radius
    let bestN = 0, bestAnchor = -1, bestSum = 0;
    for (let i = 0; i < count; i++) {
      const a = cands[i];
      if (!a.sprint || weightOf(a.ws) <= 0) continue;
      let n = 0, sum = 0;
      for (let j = 0; j < count; j++) {
        const b = cands[j];
        if (!b.sprint) continue;
        const w = weightOf(b.ws);
        if (w <= 0) continue;
        const dx = a.x - b.x, dz = a.z - b.z;
        if (dx * dx + dz * dz > r2) continue;
        n++; sum += w;
      }
      if (n > bestN || (n === bestN && sum > bestSum)) { bestN = n; bestAnchor = i; bestSum = sum; }
    }
    if (bestN < minN || bestAnchor < 0) return;
    const a = cands[bestAnchor];
    let cx = 0, cz = 0;
    for (let j = 0; j < count; j++) {
      const b = cands[j];
      if (!b.sprint || weightOf(b.ws) <= 0) continue;
      const dx = a.x - b.x, dz = a.z - b.z;
      if (dx * dx + dz * dz > r2) continue;
      b.inGroup = true; cx += b.x; cz += b.z;
    }
    cx /= bestN; cz /= bestN;
    // distance = the mean distance **between** cluster members (measured to the centre, two 40 m apart read as 20 m and 「the closer the better」 disappears)
    let spread = 0, pairs = 0;
    for (let j = 0; j < count; j++) {
      const b = cands[j];
      if (!b.inGroup) continue;
      for (let k = j + 1; k < count; k++) {
        const c = cands[k];
        if (!c.inGroup) continue;
        spread += Math.hypot(b.x - c.x, b.z - c.z); pairs++;
      }
    }
    spread = pairs > 0 ? spread / pairs : 0;
    const near = Math.max(0, SANDWORM_P_NEAR_M);
    const span = Math.max(1e-6, SANDWORM_GROUP_RADIUS - near);
    const k = THREE.MathUtils.clamp((spread - near) / span, 0, 1);
    const closeMul = THREE.MathUtils.lerp(1, THREE.MathUtils.clamp(SANDWORM_P_FAR_MUL, 0, 1), k);
    out.n = bestN; out.sum = bestSum; out.spread = spread; out.closeMul = closeMul; out.cx = cx; out.cz = cz;
    out.p = THREE.MathUtils.clamp(base * Math.min(1, bestSum) * closeMul, 0, 1);
  }

  /** Adds the bonus when a lure grenade is near the cluster centre (only when there is an eligible cluster). */
  private applyLure(out: SandwormCheck, lureNear: boolean): void {
    out.lure = lureNear;
    if (out.n > 0 && lureNear) out.p = THREE.MathUtils.clamp(out.p + Math.max(0, SANDWORM_P_LURE), 0, 1);
  }

  /** If a living lure grenade is within `SANDWORM_LURE_RANGE_M` of the cluster centre `(cx, cz)`, writes its spot into `out`. */
  private findLure(cx: number, cz: number, out: THREE.Vector3): boolean {
    const sys = this.sys;
    const ctx = sys.ctx;
    const range = Math.max(0, SANDWORM_LURE_RANGE_M);
    if (sys.lures.nearestLure(cx, cz, range, ctx.time, out)) return true;
    const g = ctx.gadgets;
    if (g) {
      _c.set(cx, 0, cz);
      const dep = g.findDistraction(_c, range);
      if (dep) { out.copy(dep.position); return true; }
    }
    return false;
  }

  /** One check (host): candidates → chance → roll → spot → warning. */
  private check(): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    const world = ctx.world;
    if (!world) return;
    const plan = this.plan;
    const out = this.lastCheck;
    out.at = ctx.time;
    const count = this.collectCandidates();
    this.evaluate(this.cands, count, out, plan.base);
    const lureNear = out.n > 0 && this.findLure(out.cx, out.cz, _lure);
    this.applyLure(out, lureNear);
    plan.checks++;
    plan.last = { ...out };
    if (out.p <= 0 || Math.random() >= out.p) return;
    plan.hits++;
    // the spot: whether the lure's spot or the cluster centre is looked at first
    const scale = wormScaleOf(plan.type);
    const lureFirst = lureNear && Math.random() < SANDWORM_LURE_SPOT_CHANCE;
    const spots: Array<[number, number]> = lureFirst
      ? [[_lure.x, _lure.z], [out.cx, out.cz]]
      : lureNear ? [[out.cx, out.cz], [_lure.x, _lure.z]] : [[out.cx, out.cz]];
    for (let i = 0; i < spots.length; i++) {
      if (this.validSpot(spots[i][0], spots[i][1], scale, _p)) { this.warnAt(_p, SANDWORM_WARN_S, plan.type); return; }
    }
  }

  /**
   * Is this ground erupt-able: inside the map · nobody nearby is on a deck · roof · tram · no rock right above it ·
   * `burrowGroundOk` (flat bare ground; a world without it = false). On success it writes into `out` at the terrain height.
   */
  private validSpot(x: number, z: number, scale: number, out: THREE.Vector3): boolean {
    const sys = this.sys;
    const world = sys.ctx.world!;
    if (!world.isInsideBounds(x, z)) return false;
    if (!this.nobodyOffTerrain(x, z)) return false;
    const h = world.getHeightAt(x, z);
    if (world.getSurfaceY(x, z, h) > h + PROP_ON_SPOT_M) return false;
    if (!(world.burrowGroundOk?.(x, z, BURROW_GROUND_CHECK_R * scale) ?? false)) return false;
    out.set(x, h, z);
    return true;
  }

  /** Nobody within `SANDWORM_GROUP_RADIUS` of `(x, z)` stands `OFF_TERRAIN_M` above the terrain (on a deck · roof · tram = false). */
  private nobodyOffTerrain(x: number, z: number): boolean {
    const sys = this.sys;
    const world = sys.ctx.world!;
    const r2 = SANDWORM_GROUP_RADIUS * SANDWORM_GROUP_RADIUS;
    const alive = sys.targets.alive;
    for (let i = 0; i < alive.length; i++) {
      const p = alive[i].position;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (p.y > world.getHeightAt(p.x, p.z) + OFF_TERRAIN_M) return false;
    }
    return true;
  }

  /* ── the thumper (host) ────────────────────────────────────────────────── */
  /**
   * `sandworm:summon` — not yet this raid → the warning starts at `position` at once, no chance and no ground check (the
   * placement preview already passed `burrowGroundOk`). Someone nearby on a deck · roof drops the call; already there = ignored. true when started.
   */
  onSummon(position: THREE.Vector3): boolean {
    const sys = this.sys;
    const ctx = sys?.ctx;
    const world = ctx?.world;
    if (!sys || !sys.authority || !ctx || !world?.ready || !ctx.isGameplayPhase() || this.done || this.warn.active) return false;
    if (!world.isInsideBounds(position.x, position.z) || !this.nobodyOffTerrain(position.x, position.z)) return false;
    _p.set(position.x, world.getHeightAt(position.x, position.z), position.z);
    this.summoned = true;
    this.warnAt(_p, SANDWORM_WARN_S, this.plan.type);
    return true;
  }

  /* ── the warning ──────────────────────────────────────────────────────── */
  /** Host: starts the warning and broadcasts it. */
  private warnAt(p: THREE.Vector3, eta: number, type: WormEnemyType): void {
    const sys = this.sys;
    const r = SANDWORM_ERUPT_RADIUS * wormScaleOf(type);
    this.startWarnLocal(p, eta, r, type);
    if (sys.hosting) sys.ctx.net!.send({ t: 'ee', ev: 'wormWarn', p: tuple(p, 2), eta: round(eta, 2), r: round(r, 2) }, 'others');
  }

  /** This client's warning FX (authority · replica alike). A warning already running at the same spot only has its remaining time matched. */
  private startWarnLocal(p: THREE.Vector3, eta: number, r: number, type: WormEnemyType): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    const now = ctx.time;
    const w = this.warn;
    const already = w.active && w.p.distanceToSquared(p) < 1;
    this.done = true;
    w.eruptAt = now + eta;
    if (already) return;
    w.active = true;
    w.p.copy(p);
    w.r = r;
    w.type = type;
    const elapsed = Math.max(0, SANDWORM_WARN_S - eta);
    w.startedAt = now - elapsed;
    w.shakeAcc = 0;
    this.warnings++;
    sys.burrowFx?.warn(p, r, eta, ctx.world, now, elapsed);
    sys.playAudio('sandworm_rumble', p, 1, 1);
    ctx.bus.emit('ui:notify', { text: TOAST_WARN, kind: 'danger', duration: 5 });
    ctx.bus.emit('sandworm:warning', { position: p.clone(), radius: r, eta });
  }

  private endWarn(): void {
    this.warn.active = false;
    this.sys.burrowFx?.endWarn();
  }

  /** A shake rising weak → strong with distance (every client). */
  private tickWarn(dt: number): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    const w = this.warn;
    const now = ctx.time;
    if (!sys.authority && now > w.eruptAt + REPLICA_WARN_TIMEOUT_S) { this.endWarn(); return; }
    w.shakeAcc -= dt;
    if (w.shakeAcc > 0) return;
    w.shakeAcc = WARN_SHAKE_TICK_S;
    const d = sys.targets.distToLocal(w.p);
    if (!(d < SANDWORM_ALERT_RADIUS)) return;
    const k = THREE.MathUtils.clamp((now - w.startedAt) / SANDWORM_WARN_S, 0, 1);
    const fall = Math.pow(1 - d / SANDWORM_ALERT_RADIUS, 1.5);
    this.warnShakes++;
    ctx.bus.emit('camera:shake', { intensity: SANDWORM_SHAKE_MAX * (0.12 + 0.88 * k * k) * fall, duration: 0.3 });
  }

  /* ── the eruption (host) ──────────────────────────────────────────────── */
  private erupt(): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    const world = ctx.world;
    if (!world) return;
    const p = _erupt.copy(this.warn.p);
    const type = this.warn.type;
    const R = this.warn.r > 0 ? this.warn.r : SANDWORM_ERUPT_RADIUS * wormScaleOf(type);
    this.endWarn();
    this.eruptions++;

    const face = sys.targets.nearestAlive(p);
    const yaw = face ? Math.atan2(face.position.x - p.x, face.position.z - p.z) : Math.random() * TWO_PI;
    const worm = sys.spawn(type, p, yaw, true, true, SANDWORM_RISE_S);
    const spitPhase = this.forcedSpitS ?? SANDWORM_SPIT_PHASE_S;
    this.forcedSpitS = null;
    let hp = 0;
    if (worm) {
      // the adult rolls MIN..MAX, the young one is fixed (user's decision, 750)
      hp = type === 'sandworm_weak'
        ? Math.max(1, Math.round(SANDWORM_WEAK_HP))
        : Math.round(SANDWORM_HP_MIN + Math.random() * Math.max(0, SANDWORM_HP_MAX - SANDWORM_HP_MIN));
      worm.maxHp = hp;
      worm.hp = hp;
      worm.aware = true;
      worm.wormSpitUntil = ctx.time + SANDWORM_RISE_S + spitPhase;
      worm.wormTimer = SPIT_WINDUP_S + 0.5;   // the first spit comes soon after it is fully up (the tick only runs once the emerge ends)
    }

    // damage + knockback — local directly, remote as `dmg.kb`, a disconnected squadmate as `ghost:damage` (`applyDamage` splits them)
    const players = sys.targets.alive;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      const dx = t.position.x - p.x, dz = t.position.z - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > R + PLAYER_RADIUS) continue;
      /* 2026-09-15 (user's decision — every explosive uses the same formula): **damage** is the shared two-step stair
       * (`shared/explosion`) while **knockback** stays the old linear one. The line drawn that day — only damage got a new
       * falloff curve — holds here too: a stepped knockback cuts the flung distance off at the safe-zone edge. Both keep the 0.3 floor.
       * The young one scales only its **radius** by `SANDWORM_WEAK_SCALE` (damage · knockback speed unchanged — user's decision 「knockback + damage radius 70 %」). */
      const kbFalloff = THREE.MathUtils.clamp(1 - Math.max(0, d - PLAYER_RADIUS) / R, 0.3, 1);
      const falloff = Math.max(0.3, explosionFalloff(Math.max(0, d - PLAYER_RADIUS), R));
      if (d > 0.05) _kb.set(dx / d, 0, dz / d);
      else { const a = Math.random() * TWO_PI; _kb.set(Math.cos(a), 0, Math.sin(a)); }
      _kb.y = 0.8;
      _kb.normalize();
      sys.applyDamage(t, SANDWORM_ERUPT_DAMAGE * falloff, p, worm?.id ?? 0, type, null, 0, false, _kb, SANDWORM_ERUPT_KNOCKBACK * kbFalloff);
    }
    // 2026-09-15 (android squadmates): the same formula as the human loop (horizontal distance · 0.3 floor). No knockback — the authority runs the body.
    damageAlliesAt(sys, p, R, SANDWORM_ERUPT_DAMAGE, worm?.id ?? 0, type, 0.3, 'feet2d');
    _c.set(p.x, p.y + 1, p.z);
    sys.explode(_c, R, SANDWORM_ERUPT_DAMAGE * ENEMY_CLASH.damageMul, 'ai', null, worm, 'bug');   // 2026-09-17: × the enemy → enemy multiplier   // enemies of other factions (bugs are its own side)
    ctx.drones?.applyExplosion(p, R, SANDWORM_ERUPT_DAMAGE);
    sys.targets.damageVehicleAt(p, R, SANDWORM_ERUPT_DAMAGE, 0.3);   // 2026-09-13: the rover (the same minimum falloff as a player)

    this.spawnBurst(p, type);
    this.eruptFxLocal(p, R);
    if (worm) {
      if (sys.hosting) {
        sys.ctx.net!.send({ t: 'ee', ev: 'wormErupt', id: worm.id, p: tuple(p, 2), r: round(R, 2), hp, spit: round(worm.wormSpitUntil - ctx.time, 2), ty: type }, 'others');
      }
      ctx.bus.emit('sandworm:erupted', { id: worm.id, position: worm.position.clone(), radius: R });
    }
  }

  /** The pack of bugs that digs out on the ring with the eruption (the squad head-count table). The young one, scavengers only. */
  private spawnBurst(p: THREE.Vector3, wormType: WormEnemyType): void {
    const sys = this.sys;
    const world = sys.ctx.world!;
    const idx = Math.max(0, Math.min(MAX_SQUAD - 1, squadSize(sys) - 1));
    const want = Math.max(0, Math.round(SANDWORM_BURST_BY_SQUAD[idx] ?? 0));
    if (want <= 0) return;
    const allowed = sys.ensureCapacity(want, SANDWORM_ALIVE_CAP);
    const base = Math.random() * TWO_PI;
    const from = this.spitTypes(wormType), fb = this.spitFallback(wormType);
    for (let i = 0; i < allowed; i++) {
      const type = pickEcoType(this.eco, from, fb);
      if (!type) continue;
      let placed = false;
      let ang = base;
      for (let a = 0; a < 4 && !placed; a++) {
        ang = base + (i / allowed) * TWO_PI + (Math.random() - 0.5) * 0.6 + a * 0.9;
        const rad = SANDWORM_BURST_RING_MIN + Math.random() * Math.max(0, SANDWORM_BURST_RING_MAX - SANDWORM_BURST_RING_MIN);
        _q.set(p.x + Math.sin(ang) * rad, 0, p.z + Math.cos(ang) * rad);
        if (!world.isInsideBounds(_q.x, _q.z)) continue;
        world.resolveCollision(_q, ENEMY_STATS[type].radius + 0.3);
        if (spawnBlocked(world, type, _q.x, _q.z)) continue;
        placed = true;
      }
      if (!placed) continue;
      _q.y = world.getHeightAt(_q.x, _q.z);
      const face = sys.targets.nearestAlive(_q);
      const yaw = face ? Math.atan2(face.position.x - _q.x, face.position.z - _q.z) : ang;
      sys.spawn(type, _q, yaw, true, true, BURROW_EMERGE_S);
    }
  }

  /** Eruption FX (authority · replica alike): the soil blast · the roar · the distance shake. */
  private eruptFxLocal(p: THREE.Vector3, r: number): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    sys.burrowFx?.erupt(p, r, ctx.world);
    sys.playAudio('sandworm_erupt', p, 1, 1);
    sys.playAudio('sandworm_roar', p, 1, 1);
    const d = sys.targets.distToLocal(p);
    if (d < SANDWORM_ALERT_RADIUS) {
      ctx.bus.emit('camera:shake', { intensity: Math.min(1, 0.25 + 0.75 * Math.pow(1 - d / SANDWORM_ALERT_RADIUS, 1.2)), duration: 0.8 });
    }
  }

  /* ── the sandworm tick (host) ─────────────────────────────────────────── */
  private tickWorm(e: Enemy, dt: number): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    e.velocity.set(0, 0, 0);
    e.hasMoveTarget = false;
    e.investigating = false;
    e.relentless = true;
    e.aware = true;
    if (e.state !== 'stagger') e.state = 'chase';   // incineration rides stagger — it does not spit meanwhile
    if (e.emergeT > 0) { e.namedHint = 0; applyWormHint(e, 0, dt); return; }
    const target = sys.targets.nearestAlive(e.position);
    if (target) e.yaw = turnToward(e.yaw, yawTo(e.position, target.position), e.stats.turnRate, dt);
    let hint = 0;
    if (!e.isIncapacitated) {
      e.wormTimer -= dt;
      if (ctx.time < e.wormSpitUntil) {
        if (e.wormTimer <= SPIT_WINDUP_S) hint = WORM_HINT_SPIT;
        if (e.wormTimer <= 0) { e.wormTimer = SANDWORM_SPIT_INTERVAL_S; this.spitBugs(e, target); }
      } else if (target && target.dist2D(e.position) <= SANDWORM_ACID_RANGE) {
        if (e.wormTimer <= ACID_WINDUP_S) hint = WORM_HINT_ACID;
        if (e.wormTimer <= 0) { e.wormTimer = SANDWORM_ACID_INTERVAL_S; this.spitAcid(e, target); }
      } else if (e.wormTimer < ACID_WINDUP_S + 0.2) {
        e.wormTimer = ACID_WINDUP_S + 0.2;   // out of range: once they come in, the mouth opens and then it fires
      }
    }
    e.namedHint = hint;
    applyWormHint(e, hint, dt);
  }

  /** Spits bugs from the mouth (host). The bugs are created first by `ee spawn`, then `ee wormSpit` announces the flight. */
  private spitBugs(e: Enemy, target: CombatTarget | null): void {
    const sys = this.sys;
    const world = sys.ctx.world!;
    const want = Math.max(0, Math.round(SANDWORM_SPIT_COUNT));
    const n = sys.ensureCapacity(want, SANDWORM_ALIVE_CAP);
    if (n <= 0) return;
    mouthOf(e, _mouth);
    const base = target ? Math.atan2(target.position.x - e.position.x, target.position.z - e.position.z) : Math.random() * TWO_PI;
    const entries: [number, number, number, number][] = [];
    const lo = SANDWORM_SPIT_MIN_M, hi = Math.max(lo, SANDWORM_SPIT_MAX_M);
    const from = this.spitTypes(e.type), fb = this.spitFallback(e.type);
    for (let i = 0; i < n; i++) {
      const type = pickEcoType(this.eco, from, fb);
      if (!type) continue;
      const ang = base + (Math.random() - 0.5) * 1.8;
      const dist = lo + Math.random() * (hi - lo);
      _to.set(e.position.x + Math.sin(ang) * dist, 0, e.position.z + Math.cos(ang) * dist);
      if (!world.isInsideBounds(_to.x, _to.z)) _to.set(e.position.x - Math.sin(ang) * dist, 0, e.position.z - Math.cos(ang) * dist);
      if (!world.isInsideBounds(_to.x, _to.z)) continue;
      world.resolveCollision(_to, ENEMY_STATS[type].radius + 0.3);
      _to.y = world.getSurfaceY(_to.x, _to.z, world.getHeightAt(_to.x, _to.z));
      const b = sys.spawn(type, _mouth, ang, true, true);
      if (!b) continue;
      b.startSpat(_mouth, _to, SANDWORM_SPIT_FLIGHT_S);
      entries.push([b.id, round(_to.x, 2), round(_to.y, 2), round(_to.z, 2)]);
    }
    if (entries.length === 0) return;
    this.spitVolleys++;
    sys.fx?.burst(_mouth, 36, 'acid', 6);
    sys.playAudio('sandworm_spit', _mouth, 1, 1);
    if (sys.hosting) {
      sys.ctx.net!.send({ t: 'ee', ev: 'wormSpit', id: e.id, from: tuple(_mouth, 2), b: entries, T: round(SANDWORM_SPIT_FLIGHT_S, 2) }, 'others');
    }
  }

  /** Acid volley (host): the first shot leads the target (`ee acid`), the rest are scattered around it (`ee acidAt`). Damage takes the existing acid path. */
  private spitAcid(e: Enemy, target: CombatTarget): void {
    const sys = this.sys;
    const world = sys.ctx.world!;
    mouthOf(e, _mouth);
    sys.fireAcid(_mouth, e, target);
    const extra = Math.max(0, Math.round(SANDWORM_ACID_VOLLEY) - 1);
    for (let k = 0; k < extra; k++) {
      const a = Math.random() * TWO_PI;
      const r = ACID_SCATTER_MIN + Math.random() * (ACID_SCATTER_MAX - ACID_SCATTER_MIN);
      _aim.set(target.position.x + Math.cos(a) * r, 0, target.position.z + Math.sin(a) * r);
      if (!world.isInsideBounds(_aim.x, _aim.z)) continue;
      _aim.y = world.getHeightAt(_aim.x, _aim.z);
      sys.fireAcidAt(_mouth, _aim, e);
    }
    this.acidVolleys++;
    sys.playAudio('sandworm_spit', _mouth, 0.8, 1.3);
  }

  /* ── death (every client — `parts/Damage.onEnemyKilled`) ───────────────── */
  onWormKilled(e: Enemy): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    sys.burrowFx?.puff(e.position, 3 * wormScaleOf(e.type), ctx.world);
    sys.playAudio('sandworm_death', e.position, 1, e.type === 'sandworm_weak' ? 1.25 : 1);
    ctx.bus.emit('ui:notify', { text: e.type === 'sandworm_weak' ? TOAST_KILLED_WEAK : TOAST_KILLED, kind: 'success', duration: 4 });
    const d = sys.targets.distToLocal(e.position);
    if (d < 40) ctx.bus.emit('camera:shake', { intensity: 0.45 * (1 - d / 40) * wormScaleOf(e.type), duration: 0.6 });
  }

  /* ── the wire (replica) ───────────────────────────────────────────────── */
  onWire(msg: EnemyEvent): void {
    const sys = this.sys;
    if (!sys || sys.authority) return;
    const ctx = sys.ctx;
    if (!ctx.world?.ready) return;
    switch (msg.ev) {
      case 'wormWarn': {
        if (!isVec3Tuple(msg.p) || !Number.isFinite(msg.eta)) return;
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        const r = Number.isFinite(msg.r) && msg.r > 0 ? msg.r : SANDWORM_ERUPT_RADIUS;
        // the type is only guessed from the radius (`ee spawn.ty` decides the spawn) — this value is used only for the warning ring · event radius
        const type: WormEnemyType = r < SANDWORM_ERUPT_RADIUS * 0.999 ? 'sandworm_weak' : 'sandworm';
        this.startWarnLocal(_p, THREE.MathUtils.clamp(msg.eta, 0, SANDWORM_WARN_S * 2), r, type);
        return;
      }
      case 'wormErupt': {
        this.done = true;
        if (!(msg.id > 0) || !isVec3Tuple(msg.p)) return;   // id 0 = nothing but the mark that the event already ended
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        if (this.warn.active) this.endWarn();
        const r = Number.isFinite(msg.r) && msg.r > 0 ? msg.r : SANDWORM_ERUPT_RADIUS;
        if (!msg.sy) { this.eruptions++; this.eruptFxLocal(_p, r); }
        const hp = Number.isFinite(msg.hp) && msg.hp > 0 ? msg.hp : 0;
        const spit = Number.isFinite(msg.spit) ? Math.max(0, msg.spit) : 0;
        this.meta.set(msg.id, { hp, spitUntil: ctx.time + spit });
        this.applyMeta();
        if (!msg.sy) ctx.bus.emit('sandworm:erupted', { id: msg.id, position: _p.clone(), radius: r });
        return;
      }
      case 'wormSpit': {
        if (!isVec3Tuple(msg.from) || !Array.isArray(msg.b) || !Number.isFinite(msg.T)) return;
        _mouth.set(msg.from[0], msg.from[1], msg.from[2]);
        const T = THREE.MathUtils.clamp(msg.T, 0.2, 3);
        for (let i = 0; i < msg.b.length; i++) {
          const row = msg.b[i];
          if (!Array.isArray(row) || row.length !== 4 || !row.every(Number.isFinite)) continue;
          const b = sys.byId.get(row[0]);
          if (!b || !b.active || b.state === 'dead') continue;
          _to.set(row[1], row[2], row[3]);
          b.startSpat(_mouth, _to, T);
        }
        this.spitVolleys++;
        sys.fx?.burst(_mouth, 36, 'acid', 6);
        sys.playAudio('sandworm_spit', _mouth, 1, 1);
        return;
      }
      default:
        return;
    }
  }

  /** Replica: writes the max hp · spit end time it kept onto that sandworm (a promotion carries straight on). */
  private applyMeta(): void {
    const sys = this.sys;
    for (const [id, m] of this.meta) {
      const e = sys.byId.get(id);
      if (!e || !e.active || !isWormType(e.type)) continue;
      if (m.hp > 0) { e.maxHp = m.hp; if (e.hp > m.hp) e.hp = m.hp; }
      e.wormSpitUntil = m.spitUntil;
      this.meta.delete(id);
    }
  }

  /** Host: resends the progress on a reconnect · late join (`flow rejoined`). */
  resync(): void {
    const sys = this.sys;
    if (!sys?.hosting) return;
    const ctx = sys.ctx;
    const net = ctx.net!;
    const now = ctx.time;
    if (this.warn.active) {
      net.send({ t: 'ee', ev: 'wormWarn', p: tuple(this.warn.p, 2), eta: round(Math.max(0, this.warn.eruptAt - now), 2), r: round(this.warn.r, 2) }, 'others');
    }
    let alive = 0;
    const active = sys.active;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (!isWormType(e.type) || !e.active || e.state === 'dead') continue;
      alive++;
      net.send({ t: 'ee', ev: 'wormErupt', id: e.id, p: tuple(e.position, 2), r: round(SANDWORM_ERUPT_RADIUS * wormScaleOf(e.type), 2), hp: round(e.maxHp, 0), spit: round(Math.max(0, e.wormSpitUntil - now), 2), sy: 1, ty: e.type }, 'others');
    }
    if (this.done && !this.warn.active && alive === 0) {
      net.send({ t: 'ee', ev: 'wormErupt', id: 0, p: [0, 0, 0], r: 0, hp: 0, spit: 0, sy: 1 }, 'others');
    }
  }

  /* ── debug ────────────────────────────────────────────────────────────── */
  /**
   * Console · smoke: ignores the chance · ground check · once-per-raid and starts the warning **now** (authority, in a raid only). No `at` = under the local player.
   * `spitS` = this eruption's spit phase (s, 0 = straight to acid). `weak` = force the young one (omitted = planet threat). true when started.
   */
  debugForce(opts: { at?: { x: number; z: number }; spitS?: number; weak?: boolean } = {}): boolean {
    const sys = this.sys;
    const ctx = sys?.ctx;
    const world = ctx?.world;
    if (!sys || !sys.authority || sys.training || !ctx || ctx.isTraining() || !world?.ready || !ctx.isGameplayPhase() || this.warn.active) return false;
    const src = opts.at ?? ctx.player?.position ?? null;
    if (!src || !world.isInsideBounds(src.x, src.z)) return false;
    _p.set(src.x, world.getHeightAt(src.x, src.z), src.z);
    this.forcedSpitS = typeof opts.spitS === 'number' && Number.isFinite(opts.spitS) && opts.spitS >= 0 ? opts.spitS : null;
    this.warnAt(_p, SANDWORM_WARN_S, opts.weak ? 'sandworm_weak' : this.plan.type);
    return true;
  }

  /** Smoke: clears the 「it already happened this raid」 mark — to test `sandworm:summon` after a forced eruption. */
  debugClearOnce(): void { this.done = false; this.summoned = false; }

  /**
   * Smoke: computes one check's chance from a made-up member list (it neither rolls nor changes state). `threat` omitted = this
   * raid's plan. Every other field is `SandwormCheck` as it is.
   */
  debugChance(members: ReadonlyArray<{ x: number; z: number; ws: WeightState; sprint: boolean }>, lure = false, threat?: number): SandwormCheck {
    const list: Candidate[] = members.slice(0, MAX_CANDIDATES).map((m) => ({ x: m.x, z: m.z, sprint: m.sprint, ws: m.ws, android: false, inGroup: false }));
    const raw = threat === undefined ? this.plan.base : SANDWORM_BASE_CHANCE_BY_THREAT[Math.max(1, Math.min(3, Math.round(threat))) - 1];
    const base = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    const out: SandwormCheck = { at: this.sys?.ctx.time ?? 0, candidates: 0, eligible: 0, n: 0, sum: 0, spread: 0, closeMul: 0, lure: false, p: 0, cx: 0, cz: 0 };
    this.evaluate(list, list.length, out, base);
    this.applyLure(out, lure);
    return out;
  }

  debugState(): {
    plan: SandwormPlan; done: boolean; summoned: boolean; warning: { x: number; y: number; z: number; eta: number; r: number; type: WormEnemyType } | null;
    worms: Array<{ id: number; type: EnemyType; hp: number; maxHp: number; spitLeft: number; emerging: boolean; hint: number }>;
    warnings: number; eruptions: number; spitVolleys: number; acidVolleys: number; warnShakes: number;
  } {
    const sys = this.sys;
    const now = sys?.ctx.time ?? 0;
    const worms: Array<{ id: number; type: EnemyType; hp: number; maxHp: number; spitLeft: number; emerging: boolean; hint: number }> = [];
    if (sys) {
      for (const e of sys.active) {
        if (!isWormType(e.type) || !e.active || e.state === 'dead') continue;
        worms.push({ id: e.id, type: e.type, hp: e.hp, maxHp: e.maxHp, spitLeft: Math.max(0, e.wormSpitUntil - now), emerging: e.emergeT > 0, hint: e.namedHint });
      }
    }
    const w = this.warn;
    return {
      plan: { ...this.plan, last: this.plan.last ? { ...this.plan.last } : null }, done: this.done, summoned: this.summoned,
      warning: w.active ? { x: w.p.x, y: w.p.y, z: w.p.z, eta: w.eruptAt - now, r: w.r, type: w.type } : null,
      worms, warnings: this.warnings, eruptions: this.eruptions, spitVolleys: this.spitVolleys, acidVolleys: this.acidVolleys, warnShakes: this.warnShakes,
    };
  }
}

/** World position of the mouth (the rig's mouth group — last frame's pose). With no rig, the head sphere's centre. */
function mouthOf(e: Enemy, out: THREE.Vector3): THREE.Vector3 {
  const rig = e.rig;
  if (rig.kind === 'worm') {
    rig.root.updateMatrixWorld(true);
    return rig.mouth.getWorldPosition(out);
  }
  return e.headCenter(out);
}

/** Squad size (1..4). Single-player is 1. The same computation as `RogueDrop.squadSize` · `WaveDirector.squadSize`. */
function squadSize(sys: EnemySystem): number {
  const net = sys.ctx.net;
  let n = 1;
  if (net) for (const r of net.getRemotePlayers()) if (r.connected) n++;
  return Math.max(1, Math.min(MAX_SQUAD, n));
}
