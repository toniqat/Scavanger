/**
 * src/enemies/named/Director.ts — **the named rogue spawn director** (2026-09-11).
 *
 * The question this file answers: *does a named rogue appear in this raid, which one, and where does it stand.*
 *
 * ## The roll (host · once per raid)
 * The `world:ready` authority branch of `EnemySystem` calls `roll()` once, **after** site group placement (`SiteGroups`).
 * No-op in the training range. The seed stream is the single `hash('named@<worldSeed>')` (before 2026-09-13 it was
 * `worldSeed ^ hash('named')` — nearby seeds had similar first rolls), and that stream draws, in order,
 *   (1) whether one appears, `NAMED_ROGUE_CHANCE_BY_THREAT[planetThreat(planet) − 1]` (2026-09-13 — one row per
 *      planet threat in `data/tables.csv`; no planet = threat 1, and a row of 0 is a threat that never gets one).
 *      All three named rogues and the scan drone are faction `raider` (`data/enemies.csv`),
 *   (2) which of the three (uniform),
 *   (3) the spot · the Heavy escorts' spots
 * — the same seed + the same planet = the same answer. The roll only happens at `world:ready`, so someone promoted by
 * a host transfer does not roll again (as a replica they already received the named rogue through `ee spawn`).
 *
 * ## Spots (all ≥ `NAMED_ROGUE_MIN_SPAWN_DIST` from the spawn · inside the map · outside the rail corridor · outside structure footprints · unblocked)
 *  - Roden (`rogue_sniper`) — **a hill in the open**: several candidates are drawn, and the one with few obstacles
 *    around it (`obstacleCoverage`), far from structures and **higher** than its surroundings wins. It faces the spawn point (= the side the squad comes from).
 *  - Tagilla (`rogue_hammer`) — **beside a structure**: the spot with the most cover within `NAMED_HAMMER.structureRadius`
 *    of one structure far from the spawn. `guardPos` = that structure. With no structure on the map, the spot with the most obstacles.
 *  - The Heavy (`rogue_heavy`) — **beside a structure · ruin (crate) far from the spawn**. SMG rogue escorts,
 *    `NAMED_HEAVY_ESCORTS_BY_SQUAD[squad size − 1]` of them, stand within `NAMED_HEAVY.escortRadius`
 *    (`escortOf` = the Heavy → exactly the existing boss escort leash rule).
 *
 * ## Spawning · the announcement
 * Spawning takes the existing `spawnRogue` path, so `enemy:spawned` · `ee spawn` go out as they always do. A named rogue
 * and its escorts are the rogue faction, so `ensureCapacity` never recycles them (`e.isRogue`). `enemy:namedSpawned` goes
 * out right after the spawn on the authority; on a replica it goes out once per id, the first time a named type is seen
 * through `enemy:spawned` (`ee spawn`) or through a replica a snapshot created silently (`onReplicaCreated`, C-52 — a late
 * joiner); both paths read the same record. `reset()` clears it every raid and a host transfer (promotion · demotion)
 * leaves it alone — ids survive the transfer, so a named rogue already announced is not announced twice.
 *
 * Values like the placement search's candidate count and sampling radius are **parameters of the search algorithm**, not
 * balance numbers, so they live in this file — the same nature as `SiteGroups.ts`'s own `CANDIDATE_EXTRA` and fallback
 * ring constants, and each placement search keeps its own. The appearance chance, the distances and the escort count
 * all come from csv.
 */
import * as THREE from 'three';
import {
  ENEMY_SPAWN_BLOCK_RATIO, ENEMY_SPAWN_CLEARANCE_MUL, NAMED_HEAVY_ESCORTS_BY_SQUAD, NAMED_ROGUE_MIN_SPAWN_DIST,
  NAMED_ROGUE_TYPES, RAIL_CLEARANCE_M, ROVER_ROUTE_CLEARANCE_M, Random, isNamedRogueType, planetThreat, planetTier,
  type EnemyType, type NamedRogueType, type PlanetId, type WorldRef,
} from '@/shared';
/**
 * 2026-09-13: the appearance chance — index 0 = planet threat 1 … 2 = threat 3 (`data/tables.csv`). The old
 * `NAMED_ROGUE_CHANCE_BY_RANK` (5 slots by planet rank) is retired — named rogues are the raider faction, so they
 * only stand on planets raiders appear on (threat 2–3).
 */
import { NAMED_ROGUE_CHANCE_BY_THREAT as NAMED_CHANCE_BY_THREAT } from '../factionTables';
import type { Enemy } from '../Enemy';
import { ENEMY_STATS, NAMED_HAMMER, NAMED_HEAVY } from '../EnemyTypes';
import type { RogueSpawnHost } from '../RogueGuards';

/* ── Weapons (item def ids from items/WeaponDefs — a rogue's `weaponId` is the family-id convention, as in `ROGUE_AI_TEXT`) ── */
/** Roden's sniper rifle = sniper rifle family I. */
const SNIPER_WEAPON = 'sr';
/** The Heavy's minigun = `u_minigun` in `data/weapons_unique.csv` (item id `wpn_u_minigun`). */
const HEAVY_WEAPON = 'u_minigun';
/** The SMG family I the Heavy's escorts carry. */
const ESCORT_WEAPON = 'smg';

/* ── Placement search parameters (not balance numbers) ─────────────────────────────────────── */
/** It stands at least this far inside the map edge (m). */
const EDGE_MARGIN = 24;
/** Extra room kept clear beyond the rail corridor half-width (m) — standing right on the corridor edge, the tram grazes it. */
const RAIL_EXTRA_M = 4;
/** Number of Roden candidates. */
const SNIPER_CANDIDATES = 48;
/** Roden: radius of the circle openness is measured over (m). */
const SNIPER_OPEN_RADIUS = 22;
/** Roden: radius of the ring the surrounding heights are sampled on (m) and the sample count. */
const SNIPER_RING_RADIUS = 30;
const SNIPER_RING_SAMPLES = 8;
/** Roden: stays at least this far from a structure footprint (m). The score stops rising at `SNIPER_STRUCT_CAP`. */
const SNIPER_STRUCT_MIN = 30;
const SNIPER_STRUCT_CAP = 80;
/** Roden score weights: 1 m above the surroundings · openness 1.0 · 1 m of structure distance · how far it leans toward the map edge. */
const W_PROMINENCE = 1;
const W_OPEN = 40;
const W_STRUCT = 0.1;
const W_EDGE = 40;
/** Past this fraction of the half-width from the map centre the score is cut (a corner the squad hardly ever reaches). */
const EDGE_SOFT = 0.75;
/** Tagilla: ring samples per structure, radius of the circle cover density is measured over (m), minimum gap outside the footprint (m). */
const HAMMER_RING_TRIES = 16;
const HAMMER_COVER_RADIUS = 10;
const HAMMER_FOOTPRINT_GAP = 1.5;
/** The Heavy: the ring around the anchor (structure · ruin) — minimum · maximum gap outside the footprint (m) and the sample count. */
const HEAVY_RING_MIN = 6;
const HEAVY_RING_MAX = 18;
const HEAVY_RING_TRIES = 12;
/** The rough radius used when the anchor is a crate (m). */
const CRATE_ANCHOR_RADIUS = 3;
/** Number of random candidates drawn when there is no anchor at all. */
const FALLBACK_CANDIDATES = 32;
/** Spot retries per escort. */
const ESCORT_TRIES = 6;
/** Squad capacity — the same value as `RogueDrop` · `WaveDirector`. */
const MAX_SQUAD = 4;
/** Debug spawn: distance ahead of the player (m). */
const DEBUG_AHEAD_M = 40;

const _p = new THREE.Vector3();
const _best = new THREE.Vector3();
const _guard = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/** This raid's roll result (`EnemySystem.debugNamedRoll`). */
export interface NamedRollResult {
  /** Whether this client rolled this raid (false on a replica · in the training range · before the roll). */
  rolled: boolean;
  planet: PlanetId | null;
  /** `planetTier` (1..5) — unused by the chance since 2026-09-13 (debug display only). */
  tier: number;
  /** 2026-09-13: `planetThreat` (1..3) — the index into the chance `NAMED_ROGUE_CHANCE_BY_THREAT[threat − 1]`. */
  threat: number;
  /** The appearance chance. */
  chance: number;
  /** The rolled value (0..1, `< chance` = it appears). */
  roll: number;
  /** The type drawn (null when none appeared). */
  type: NamedRogueType | null;
  /** Whether a spot was found and it actually stands there. */
  placed: boolean;
  /** The named rogue's enemy id, null with none. */
  id: number | null;
  position: { x: number; y: number; z: number } | null;
  /** What the spot was decided from: `structure:<id>` · `crate` · `open`. */
  anchor: string | null;
  /** Number of escorts placed with the Heavy. */
  escorts: number;
}

/** What the director asks of `EnemySystem`. */
export interface NamedDirectorHost extends RogueSpawnHost {
  /** Whether this client simulates enemies (single player or the host). */
  readonly authority: boolean;
  /** Whether this is the simulation training range. */
  readonly training: boolean;
  /** Active enemy lookup (a replica's `enemy:spawned` → the named announcement). */
  find(id: number): Enemy | undefined;
}

function emptyResult(): NamedRollResult {
  return { rolled: false, planet: null, tier: 1, threat: 1, chance: 0, roll: 1, type: null, placed: false, id: null, position: null, anchor: null, escorts: 0 };
}

export class NamedRogueDirector {
  private host!: NamedDirectorHost;
  /** Enemy ids this raid already emitted `enemy:namedSpawned` for. */
  private readonly announced = new Set<number>();
  private result: NamedRollResult = emptyResult();
  private debugCount = 0;

  bind(host: NamedDirectorHost): void { this.host = host; }

  /** Raid reset (`Pool.reset`). */
  reset(): void {
    this.announced.clear();
    this.result = emptyResult();
  }

  /* ── The roll ─────────────────────────────────────────────────────────── */
  /**
   * Once in the `world:ready` authority branch, after the rogue guards are placed. If one appears, a spot is found, it
   * is placed and announced. `planet` = this raid's target planet (null = treated as difficulty 1).
   */
  roll(planet: PlanetId | null): NamedRollResult {
    const host = this.host;
    const ctx = host?.ctx;
    const world = ctx?.world;
    if (!host || !host.authority || host.training || ctx.isTraining() || !world?.ready) return this.result;
    const tier = planetTier(planet);
    const threat = planetThreat(planet);
    const idx = Math.max(0, Math.min(NAMED_CHANCE_BY_THREAT.length - 1, threat - 1));
    const raw = NAMED_CHANCE_BY_THREAT[idx];
    const chance = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    // 2026-09-13: the world seed goes **inside** the hash — with `seed ^ hash('named')`, seeds differing only in the low bits had similar first rolls
    const rng = new Random(Random.hash(`named@${world.seed >>> 0}`));
    const r = rng.next();
    const res = emptyResult();
    res.rolled = true; res.planet = planet; res.tier = tier; res.threat = threat; res.chance = chance; res.roll = r;
    this.result = res;
    /* 2026-09-14 (the intel broker's 「현상 수배」): a buyer **skips the appearance roll and the type roll** and gets
     * that named rogue for certain. The spot roll is unchanged — this rng is entirely separate from the world stream
     * (`Random.hash('named@' + seed)`), so stream identity is no concern, and saving the two draws here would only
     * move the spot (which is what makes 「the named rogue you named stands in its own place on that map」 true). */
    const wanted = ctx.missionIntel?.namedId ?? null;
    const forced: NamedRogueType | null = wanted && isNamedRogueType(wanted) ? wanted : null;
    if (!forced && !(r < chance)) return res;

    // The type roll is **always consumed** — that way the spot roll after it starts from the same place for a buyer and a non-buyer
    const rolledType = NAMED_ROGUE_TYPES[rng.int(0, NAMED_ROGUE_TYPES.length - 1)];
    const type = forced ?? rolledType;
    res.type = type;
    const spawn = world.getPlayerSpawn();
    let anchor: string | null = null;
    if (type === 'rogue_sniper') anchor = pickSniperSpot(world, rng, spawn, _best) ? 'open' : null;
    else if (type === 'rogue_hammer') anchor = pickHammerSpot(world, rng, spawn, _best, _guard);
    else anchor = pickHeavySpot(world, rng, spawn, _best, _guard);
    if (!anchor) return res;
    if (type === 'rogue_sniper') _guard.copy(_best);

    settle(world, _best, ENEMY_STATS[type].radius);
    // Roden faces the side the squad comes from (the spawn); Tagilla and the Heavy turn their back on what they guard and look outward
    const yaw = type === 'rogue_sniper'
      ? Math.atan2(spawn.x - _best.x, spawn.z - _best.z)
      : outwardYaw(_best, _guard);
    const e = this.spawnNamed(type, _best, yaw, _guard, rng, res);
    if (!e) return res;
    res.anchor = anchor;
    return res;
  }

  /** This raid's roll result (a copy). */
  debugRoll(): NamedRollResult {
    const r = this.result;
    return { ...r, position: r.position ? { ...r.position } : null };
  }

  /* ── The announcement ─────────────────────────────────────────────────── */
  /** `enemy:spawned` — replicas only: `enemy:namedSpawned` the first time a named type is seen, once per id. On the authority the spawn path emits it itself. */
  onSpawned(id: number, type: EnemyType): void {
    const host = this.host;
    if (!host || host.authority || !isNamedRogueType(type)) return;
    const e = host.find(id);
    if (!e) return;
    this.announce(e);
  }

  /**
   * 2026-09-11 (C-52): a replica a snapshot (a keyframe · a delta carrying `ty`) created **silently** (the
   * get-or-create in `net/Replica.onSnapshot` — a late joiner that missed `ee spawn`). It does not emit
   * `enemy:spawned` (that would change what other subscribers such as sounds and the HUD do) and emits the named
   * announcement only. The record is the same `announced` as `onSpawned`, so an `ee spawn` before or after it still
   * means once per id. On the authority it does nothing (the spawn path emits it itself).
   */
  onReplicaCreated(e: Enemy): void {
    const host = this.host;
    if (!host || host.authority) return;
    this.announce(e);
  }

  private announce(e: Enemy): void {
    const type = e.type;
    if (!isNamedRogueType(type) || this.announced.has(e.id)) return;
    this.announced.add(e.id);
    this.host.ctx.bus.emit('enemy:namedSpawned', { id: e.id, type, position: e.position });
  }

  /* ── Debug ────────────────────────────────────────────────────────────── */
  /**
   * Places `type` with no judgement at all (escorts included for the Heavy). With no `at`, `DEBUG_AHEAD_M` ahead of
   * the local player. It touches neither the one-per-raid rule nor the roll record. null when not the authority.
   */
  debugSpawn(type: NamedRogueType, at?: { x: number; z: number }): Enemy | null {
    const host = this.host;
    const ctx = host?.ctx;
    const world = ctx?.world;
    if (!host || !host.authority || !world?.ready || !isNamedRogueType(type)) return null;
    const player = ctx.player;
    const look = player ? player.position : world.getPlayerSpawn();
    if (at) _p.set(at.x, 0, at.z);
    else if (player) {
      player.getForward(_fwd);
      _fwd.y = 0;
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
      _fwd.normalize();
      _p.set(player.position.x + _fwd.x * DEBUG_AHEAD_M, 0, player.position.z + _fwd.z * DEBUG_AHEAD_M);
    } else _p.set(look.x, 0, look.z + DEBUG_AHEAD_M);
    settle(world, _p, ENEMY_STATS[type].radius);
    const yaw = Math.atan2(look.x - _p.x, look.z - _p.z);
    _guard.copy(_p);
    const rng = new Random(((world.seed >>> 0) ^ Random.hash('named:debug') ^ ++this.debugCount) >>> 0);
    return this.spawnNamed(type, _p, yaw, _guard, rng, null);
  }

  /* ── Spawning ─────────────────────────────────────────────────────────── */
  /** One named rogue (+ escorts for the Heavy). With a `res`, the result is written into it. */
  private spawnNamed(type: NamedRogueType, pos: THREE.Vector3, yaw: number, guard: THREE.Vector3, rng: Random, res: NamedRollResult | null): Enemy | null {
    const host = this.host;
    const weapon = type === 'rogue_sniper' ? SNIPER_WEAPON : type === 'rogue_heavy' ? HEAVY_WEAPON : '';
    // 2026-09-13: the Heavy is one squad with its escorts (`leader`) — no site (`site`) (named loot is decided by its own guaranteed drop table)
    const squadId = type === 'rogue_heavy' ? host.allocSquadId() : -1;
    const e = host.spawnRogue(type, pos, yaw, guard, weapon, null, squadId >= 0 ? { squadId, role: 'leader' } : undefined);
    if (!e) return null;
    let escorts = 0;
    if (type === 'rogue_heavy') escorts = this.placeEscorts(e, rng, squadId);
    if (res) {
      res.placed = true;
      res.id = e.id;
      res.position = { x: e.position.x, y: e.position.y, z: e.position.z };
      res.escorts = escorts;
    }
    this.announce(e);
    return e;
  }

  /** Places SMG **raider** escorts within `escortRadius` of the Heavy (the same squad as the Heavy). Returns how many were placed. */
  private placeEscorts(heavy: Enemy, rng: Random, squadId: number): number {
    const host = this.host;
    const world = host.ctx.world!;
    const idx = Math.max(0, Math.min(MAX_SQUAD - 1, squadSize(host) - 1));
    const count = Math.max(0, Math.round(NAMED_HEAVY_ESCORTS_BY_SQUAD[idx] ?? 0));
    if (count <= 0) return 0;
    const radius = Math.max(2, NAMED_HEAVY.escortRadius);
    const escortRadius = ENEMY_STATS.raider.radius;
    const base = rng.range(0, Math.PI * 2);
    let placed = 0;
    for (let i = 0; i < count; i++) {
      let ok = false;
      for (let a = 0; a < ESCORT_TRIES && !ok; a++) {
        const ang = base + (i / count) * Math.PI * 2 + rng.range(-0.45, 0.45);
        const rad = rng.range(radius * 0.4, radius);
        _p.set(heavy.position.x + Math.cos(ang) * rad, 0, heavy.position.z + Math.sin(ang) * rad);
        if (!world.isInsideBounds(_p.x, _p.z) || blocked(world, _p.x, _p.z, escortRadius)) continue;
        ok = true;
      }
      if (!ok) continue;
      settle(world, _p, escortRadius);
      const yaw = outwardYaw(_p, heavy.position);
      // escortOf = the Heavy → `spawnRogue` sets the leash to `ROGUE_AI.escortLeash` and RogueAI pins guardPos to the Heavy.
      // 2026-09-13: the escorts are raiders (the same squad as the Heavy). They follow it, so no flanker is assigned.
      if (host.spawnRogue('raider', _p, yaw, heavy.position, ESCORT_WEAPON, heavy, { squadId, role: 'member' })) placed++;
    }
    return placed;
  }
}

/* ══ Picking a spot ══════════════════════════════════════════════════════════════════════════════════ */

/** Roden: a hill in the open. Writes it into `out` and returns true when one is found. */
function pickSniperSpot(world: WorldRef, rng: Random, spawn: THREE.Vector3, out: THREE.Vector3): boolean {
  const half = world.size / 2 - EDGE_MARGIN;
  const radius = ENEMY_STATS.rogue_sniper.radius;
  let bestScore = -Infinity;
  for (let i = 0; i < SNIPER_CANDIDATES; i++) {
    // Exactly two rng draws per candidate — a rejected one consumes the same, so the escort placement rolls after it do not shift
    const x = rng.range(-half, half);
    const z = rng.range(-half, half);
    if (!spotOk(world, x, z, spawn, radius)) continue;
    const clearance = structureClearance(world, x, z);
    if (clearance < SNIPER_STRUCT_MIN) continue;
    const h = world.getHeightAt(x, z);
    let ring = 0;
    for (let k = 0; k < SNIPER_RING_SAMPLES; k++) {
      const a = (k / SNIPER_RING_SAMPLES) * Math.PI * 2;
      ring += world.getHeightAt(x + Math.cos(a) * SNIPER_RING_RADIUS, z + Math.sin(a) * SNIPER_RING_RADIUS);
    }
    const prominence = h - ring / SNIPER_RING_SAMPLES;
    const open = world.obstacleCoverage(x, z, SNIPER_OPEN_RADIUS);
    const edge = Math.max(0, Math.hypot(x, z) / Math.max(1, world.size / 2) - EDGE_SOFT);
    const score = prominence * W_PROMINENCE - open * W_OPEN + Math.min(clearance, SNIPER_STRUCT_CAP) * W_STRUCT - edge * W_EDGE;
    if (score > bestScore) { bestScore = score; out.set(x, h, z); }
  }
  return bestScore > -Infinity;
}

/** Tagilla: a spot with plenty of cover beside a structure far from the spawn. `guard` = that structure (the spot itself with none). The reason string, or null. */
function pickHammerSpot(world: WorldRef, rng: Random, spawn: THREE.Vector3, out: THREE.Vector3, guard: THREE.Vector3): string | null {
  const radius = ENEMY_STATS.rogue_hammer.radius;
  const structures = farthestFirst(world.getStructures(), spawn);
  if (structures.length > 0) {
    // Starts in the farther half and goes once around — a near structure is used only when no spot came up at all
    const start = rng.int(0, Math.max(0, Math.ceil(structures.length / 2) - 1));
    for (let n = 0; n < structures.length; n++) {
      const s = structures[(start + n) % structures.length];
      const inner = s.radius + HAMMER_FOOTPRINT_GAP;
      const outer = Math.max(inner + 2, Math.min(NAMED_HAMMER.structureRadius, s.radius + 12));
      let best = -Infinity;
      for (let t = 0; t < HAMMER_RING_TRIES; t++) {
        const ang = rng.range(0, Math.PI * 2);
        const rad = rng.range(inner, outer);
        const x = s.position.x + Math.cos(ang) * rad;
        const z = s.position.z + Math.sin(ang) * rad;
        if (!spotOk(world, x, z, spawn, radius)) continue;
        const cover = world.obstacleCoverage(x, z, HAMMER_COVER_RADIUS);
        if (cover > best) { best = cover; out.set(x, 0, z); }
      }
      if (best > -Infinity) {
        guard.copy(s.position);
        return `structure:${s.id}`;
      }
    }
  }
  // A map with no structure: the spot where obstacles are densest (= the most cover)
  if (!pickOpenOrCluttered(world, rng, spawn, radius, HAMMER_COVER_RADIUS, 1, out)) return null;
  guard.copy(out);
  return 'open';
}

/** The Heavy: beside a structure · ruin (crate) far from the spawn. `guard` = that anchor. The reason string, or null. */
function pickHeavySpot(world: WorldRef, rng: Random, spawn: THREE.Vector3, out: THREE.Vector3, guard: THREE.Vector3): string | null {
  const radius = ENEMY_STATS.rogue_heavy.radius;
  const structures = farthestFirst(world.getStructures(), spawn);
  if (structures.length > 0) {
    const start = rng.int(0, Math.max(0, Math.ceil(structures.length / 2) - 1));
    for (let n = 0; n < structures.length; n++) {
      const s = structures[(start + n) % structures.length];
      if (ringAround(world, rng, spawn, s.position, s.radius, radius, out)) {
        guard.copy(s.position);
        return `structure:${s.id}`;
      }
    }
  }
  const crates = farthestFirst(world.getCrates().filter((c) => c.tier >= 2), spawn);
  if (crates.length > 0) {
    const tries = Math.min(crates.length, 8);
    const start = rng.int(0, Math.max(0, Math.ceil(crates.length / 2) - 1));
    for (let n = 0; n < tries; n++) {
      const c = crates[(start + n) % crates.length];
      if (ringAround(world, rng, spawn, c.position, CRATE_ANCHOR_RADIUS, radius, out)) {
        guard.copy(c.position);
        return 'crate';
      }
    }
  }
  if (!pickOpenOrCluttered(world, rng, spawn, radius, HAMMER_COVER_RADIUS, 0, out)) return null;
  guard.copy(out);
  return 'open';
}

/** The first valid spot on the `HEAVY_RING_MIN..MAX` ring outside the anchor's footprint. */
function ringAround(world: WorldRef, rng: Random, spawn: THREE.Vector3, center: THREE.Vector3, footprint: number, radius: number, out: THREE.Vector3): boolean {
  for (let t = 0; t < HEAVY_RING_TRIES; t++) {
    const ang = rng.range(0, Math.PI * 2);
    const rad = footprint + rng.range(HEAVY_RING_MIN, HEAVY_RING_MAX);
    const x = center.x + Math.cos(ang) * rad;
    const z = center.z + Math.sin(ang) * rad;
    if (!spotOk(world, x, z, spawn, radius)) continue;
    out.set(x, 0, z);
    return true;
  }
  return false;
}

/**
 * With no anchor: of the random candidates, the one with the highest obstacle density in the `coverRadius` circle
 * (`sign` 1); with `sign` 0, the first valid one.
 */
function pickOpenOrCluttered(world: WorldRef, rng: Random, spawn: THREE.Vector3, radius: number, coverRadius: number, sign: 0 | 1, out: THREE.Vector3): boolean {
  const half = world.size / 2 - EDGE_MARGIN;
  let best = -Infinity;
  for (let i = 0; i < FALLBACK_CANDIDATES; i++) {
    const x = rng.range(-half, half);
    const z = rng.range(-half, half);
    if (!spotOk(world, x, z, spawn, radius)) continue;
    const score = sign === 1 ? world.obstacleCoverage(x, z, coverRadius) : 0;
    if (score > best) { best = score; out.set(x, 0, z); if (sign === 0) return true; }
  }
  return best > -Infinity;
}

/* ══ Shared judgements ═══════════════════════════════════════════════════════════════════════════════ */

/** Whether a named rogue may stand here: inside the map · far enough from the spawn · outside the rail corridor · outside structure footprints · not blocked. */
function spotOk(world: WorldRef, x: number, z: number, spawn: THREE.Vector3, radius: number): boolean {
  const half = world.size / 2 - EDGE_MARGIN;
  if (Math.abs(x) > half || Math.abs(z) > half || !world.isInsideBounds(x, z)) return false;
  if (Math.hypot(x - spawn.x, z - spawn.z) < NAMED_ROGUE_MIN_SPAWN_DIST) return false;
  if (railDistance(world, x, z) < RAIL_CLEARANCE_M + RAIL_EXTRA_M) return false;
  // 2026-09-13: the rover's dirt road corridor is kept clear too — so a prone sniper does not lie in the middle of the road the rover drives down.
  if (roverRouteDistance(world, x, z) < ROVER_ROUTE_CLEARANCE_M + RAIL_EXTRA_M) return false;
  if (world.structureAt(x, z)) return false;
  return !blocked(world, x, z, radius);
}

/** Horizontal distance to the rover road's centre line (a closed loop) (m). Infinity with no rover. No allocation. */
function roverRouteDistance(world: WorldRef, x: number, z: number): number {
  const pts = world.rover?.route.points;
  if (!pts || pts.length < 2) return Infinity;
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const abx = b.x - a.x, abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / len2)) : 0;
    const dx = x - (a.x + abx * t), dz = z - (a.z + abz * t);
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** The same rule as `Spawner.spawnBlocked`, applied to the radius directly — a named rogue is below `ENEMY_BIG_RADIUS`, so that function is always false for it. */
function blocked(world: WorldRef, x: number, z: number, radius: number): boolean {
  return world.obstacleCoverage(x, z, Math.max(0.5, radius) * ENEMY_SPAWN_CLEARANCE_MUL) > ENEMY_SPAWN_BLOCK_RATIO;
}

/** Horizontal distance to the nearest rail centre line (m). Infinity with no rails. No allocation. */
function railDistance(world: WorldRef, x: number, z: number): number {
  let best = Infinity;
  const lines = world.getRailLines();
  for (let l = 0; l < lines.length; l++) {
    const pts = lines[l].points;
    const n = pts.length;
    if (n === 0) continue;
    if (n === 1) { best = Math.min(best, Math.hypot(x - pts[0].x, z - pts[0].z)); continue; }
    const segs = lines[l].kind === 'loop' ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const abx = b.x - a.x, abz = b.z - a.z;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / len2)) : 0;
      const dx = x - (a.x + abx * t), dz = z - (a.z + abz * t);
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Distance to the nearest structure footprint edge (m). Infinity with no structures. */
function structureClearance(world: WorldRef, x: number, z: number): number {
  let best = Infinity;
  const list = world.getStructures();
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const d = Math.hypot(x - s.position.x, z - s.position.z) - s.radius;
    if (d < best) best = d;
  }
  return best;
}

/** Only those at least `NAMED_ROGUE_MIN_SPAWN_DIST` from the spawn, farthest first (a copy — the world's array is left alone). */
function farthestFirst<T extends { position: THREE.Vector3 }>(list: readonly T[], spawn: THREE.Vector3): T[] {
  const d = (o: T): number => Math.hypot(o.position.x - spawn.x, o.position.z - spawn.z);
  return list.filter((o) => d(o) >= NAMED_ROGUE_MIN_SPAWN_DIST).sort((a, b) => d(b) - d(a));
}

/** Pushes it out of obstacles and down to the height its feet rest at. */
function settle(world: WorldRef, p: THREE.Vector3, radius: number): void {
  world.resolveCollision(p, Math.max(1, radius + 0.4));
  p.y = world.getSurfaceY(p.x, p.z, world.getHeightAt(p.x, p.z));
}

/** The yaw that turns its back on `center` and looks outward: `atan2(Δx, Δz)` at the centre turned by π (humanoid yaw convention, nose along +Z). */
function outwardYaw(p: THREE.Vector3, center: THREE.Vector3): number {
  if (Math.abs(p.x - center.x) + Math.abs(p.z - center.z) < 1e-3) return 0;
  return Math.atan2(center.x - p.x, center.z - p.z) + Math.PI;
}

/** Squad size (1..4). 1 in single player. The same calculation as `RogueDrop.squadSize` · `WaveDirector.squadSize`. */
function squadSize(host: NamedDirectorHost): number {
  const net = host.ctx.net;
  let n = 1;
  if (net) for (const r of net.getRemotePlayers()) if (r.connected) n++;
  return Math.max(1, Math.min(MAX_SQUAD, n));
}
