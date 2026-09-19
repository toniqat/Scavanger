/**
 * src/gadgets/parts/Queries.ts — **what other folders ask the deployables**.
 *
 * Enemy AI (`findEnemyTarget` / `findDistraction` / `visionFactor`), weapons (`blocksProjectile` — the dome
 * shield and the barricade stop bullets) and the player (`fireDamageAt` / `jumpPadAt`). All of them are
 * **pure queries** and change no state.
 */
import * as THREE from 'three';
import {
  GADGET_INCENDIARY_DPS, PLAYER_RADIUS,
  type DeployableKind, type DeployableRef, type EnemyRef,
} from '@/shared';
import { ENEMY_TARGET_KINDS, SOLID_KINDS } from '../GadgetDefs';
import { Deployable, BARRICADE_HALF, JUMPPAD_TRIGGER_RADIUS } from '../Deployable';
import { EMPTY_ENEMIES, PLAYER_HALF_H, type Victim, _g0, _g1, _g2, _r0, _r1, _r2, _r3, _r4 } from '../model';
import type { GadgetSystem } from '../GadgetSystem';
/* 2026-09-15 (B-16): the fire zone query · the height a thrown deployable stands at */
import { PROP_STEP_UP_MAX, type FireZoneInfo } from '@/shared';

/**
 * 2026-09-19: the two kind lists `GadgetDefs` publishes, as sets so the per-deployable test stays O(1) on these hot
 * loops. **They are the lists** — they used to be spelled out again by hand here, so adding a kind to the constant
 * (which `index.ts` re-exports and the README states as a rule) changed nothing.
 */
const ENEMY_TARGETS = new Set<DeployableKind>(ENEMY_TARGET_KINDS);
const SOLIDS = new Set<DeployableKind>(SOLID_KINDS);

export function findEnemyTarget(sys: GadgetSystem, pos: THREE.Vector3, radius: number): DeployableRef | null {
  let best: Deployable | null = null, bestD = radius * radius;
  for (const d of sys.deployables) {
    if (d.removing || !d.destructible || d.hp <= 0) continue;
    if (!ENEMY_TARGETS.has(d.kind)) continue;
    const dist = d.position.distanceToSquared(pos);
    // lures are the loudest thing on the field: enemies prefer them
    const score = d.kind === 'lure' ? dist * 0.35 : dist;
    if (score <= bestD) { bestD = score; best = d; }
  }
  return best;
  }

export function findDistraction(sys: GadgetSystem, pos: THREE.Vector3, radius: number): DeployableRef | null {
  let best: Deployable | null = null, bestD = Infinity;
  for (const d of sys.deployables) {
    if (d.removing || d.kind !== 'lure' || !d.armed) continue;
    const dist = d.position.distanceToSquared(pos);
    if (dist > radius * radius && dist > d.radius * d.radius) continue;
    if (dist < bestD) { bestD = dist; best = d; }
  }
  return best;
  }

export function blocksProjectile(sys: GadgetSystem, from: THREE.Vector3, to: THREE.Vector3, fromEnemy: boolean): THREE.Vector3 | null {
  let bestT = Infinity;
  let hit: THREE.Vector3 | null = null;
  for (const d of sys.deployables) {
    if (d.removing || !d.armed || !SOLIDS.has(d.kind)) continue;
    // `SOLID_KINDS` decides what is even considered; each kind still needs its own silhouette here (a dome stops
    // hostile shots only), so a kind added to that list without a branch below blocks nothing.
    let t = -1;
    if (d.kind === 'barricade') t = sys.segmentVsBarricade(d, from, to);
    else if (d.kind === 'domeShield' && fromEnemy) t = sys.segmentVsDome(d, from, to);
    if (t >= 0 && t < bestT) {
      bestT = t;
      hit = (hit ?? new THREE.Vector3()).lerpVectors(from, to, t);
    }
  }
  return hit;
  }

export function visionFactor(sys: GadgetSystem, from: THREE.Vector3, to: THREE.Vector3): number {
  let factor = 1;
  for (const d of sys.deployables) {
    if (d.removing || d.kind !== 'smoke') continue;
    const cover = sys.segmentSphereCoverage(from, to, d.position, d.radius, d.radius * 0.9);
    if (cover > 0) factor *= 1 - 0.92 * cover;
  }
  return THREE.MathUtils.clamp(factor, 0, 1);
  }

export function fireDamageAt(sys: GadgetSystem, pos: THREE.Vector3): number {
  let dps = 0;
  for (const d of sys.deployables) {
    if (d.removing || d.kind !== 'fire') continue;
    const dx = pos.x - d.position.x, dz = pos.z - d.position.z;
    if (dx * dx + dz * dz > d.radius * d.radius) continue;
    if (Math.abs(pos.y - d.position.y) > 3.5) continue;
    dps += GADGET_INCENDIARY_DPS;
  }
  return dps;
  }

export function jumpPadAt(sys: GadgetSystem, pos: THREE.Vector3): DeployableRef | null {
  for (const d of sys.deployables) {
    if (d.removing || d.kind !== 'jumpPad' || !d.armed) continue;
    const dx = pos.x - d.position.x, dz = pos.z - d.position.z;
    if (dx * dx + dz * dz > JUMPPAD_TRIGGER_RADIUS * JUMPPAD_TRIGGER_RADIUS) continue;
    const dy = pos.y - d.position.y;
    if (dy < -0.8 || dy > 1.8) continue;
    return d;
  }
  return null;
  }

/* ═══════════════════════════ geometry helpers ═══════════════════════════ */
/** Segment (from→to) vs the barricade box. Returns the parametric hit t in [0,1], or -1. */
export function segmentVsBarricade(sys: GadgetSystem, d: Deployable, from: THREE.Vector3, to: THREE.Vector3): number {
  const cos = Math.cos(d.yaw), sin = Math.sin(d.yaw);
  const cy = d.position.y + BARRICADE_HALF.y;
  // world → local (inverse Y rotation)
  const ox = from.x - d.position.x, oz = from.z - d.position.z;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const lox = ox * cos - oz * sin, loz = ox * sin + oz * cos;
  const ldx = dx * cos - dz * sin, ldz = dx * sin + dz * cos;
  const loy = from.y - cy;
  let tMin = 0, tMax = 1;
  const slab = (o: number, dd: number, half: number): boolean => {
    if (Math.abs(dd) < 1e-6) return o >= -half && o <= half;
    let t1 = (-half - o) / dd, t2 = (half - o) / dd;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tMin = Math.max(tMin, t1); tMax = Math.min(tMax, t2);
    return tMin <= tMax;
  };
  if (!slab(lox, ldx, BARRICADE_HALF.x)) return -1;
  if (!slab(loy, dy, BARRICADE_HALF.y)) return -1;
  if (!slab(loz, ldz, BARRICADE_HALF.z)) return -1;
  return tMin >= 0 ? tMin : -1;
  }

/** Segment vs the dome hemisphere. Shots that start inside pass out freely. */
export function segmentVsDome(sys: GadgetSystem, d: Deployable, from: THREE.Vector3, to: THREE.Vector3): number {
  _g0.copy(d.position);
  const r = d.radius;
  _g1.subVectors(from, _g0);
  if (_g1.lengthSq() <= r * r && from.y >= _g0.y) return -1;   // shooter inside the dome
  _g2.subVectors(to, from);
  const a = _g2.lengthSq();
  if (a < 1e-6) return -1;
  const b = 2 * _g1.dot(_g2);
  const cc = _g1.lengthSq() - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t < 0 || t > 1) continue;
    const y = from.y + _g2.y * t;
    if (y >= _g0.y - 0.1) return t;
  }
  return -1;
  }

/** 0..1 fraction of the segment swallowed by a sphere (smoke). */
export function segmentSphereCoverage(sys: GadgetSystem, from: THREE.Vector3, to: THREE.Vector3, center: THREE.Vector3, radius: number, height: number): number {
  _g0.subVectors(to, from);
  const len = _g0.length();
  if (len < 1e-4) return 0;
  _g0.multiplyScalar(1 / len);
  _g1.subVectors(center, from);
  const proj = THREE.MathUtils.clamp(_g1.dot(_g0), 0, len);
  _g2.copy(from).addScaledVector(_g0, proj);
  const dx = _g2.x - center.x, dz = _g2.z - center.z;
  const dyRaw = _g2.y - (center.y + height * 0.5);
  const flat = Math.sqrt(dx * dx + dz * dz);
  if (flat > radius || Math.abs(dyRaw) > height) return 0;
  const near = 1 - flat / radius;
  // fully inside the cloud → total cover; grazing → partial
  return THREE.MathUtils.clamp(near, 0, 1);
  }

/**
 * Nearest player (local or remote) whose capsule the segment crosses before reaching `to`.
 * Uses its own scratch vectors: callers (the turret) pass `_a` / `_b` in, so touching those here would
 * silently destroy the caller's ray.
 */
export function playerAlongRay(sys: GadgetSystem, from: THREE.Vector3, to: THREE.Vector3): Victim | null {
  _r0.copy(from); _r1.copy(to);
  _r2.subVectors(_r1, _r0);
  const len = _r2.length();
  if (len < 0.01) return null;
  _r2.multiplyScalar(1 / len);
  let best: Victim | null = null, bestT = len;
  const test = (pos: THREE.Vector3, id: Victim): void => {
    _r3.copy(pos); _r3.y += PLAYER_HALF_H;
    _r4.subVectors(_r3, _r0);
    const t = _r4.dot(_r2);
    if (t <= 0.6 || t >= bestT) return;
    _r4.copy(_r0).addScaledVector(_r2, t);
    if (_r4.distanceTo(_r3) > PLAYER_RADIUS + 0.15) return;
    bestT = t; best = id;
  };
  const ctx = sys.ctx;
  if (ctx.player && !ctx.player.isDead) test(ctx.player.position, 'local');
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (r.isDead || r.stale) continue;
    test(r.position, r.id);
  }
  return best;
  }

/**
 * 2026-09-15 (B-16): live `fire` deployables — the thrown `화염수류탄` and the G-10 incendiary grenade alike,
 * on the authority and on replicas. All of them are `hostile: false` (fire a player lit). It is called **every
 * frame**, so the entry objects (`sys.fireZonePool`) and the list array (`sys.fireZoneList`) are reused —
 * `position` points straight at the deployable's live vector. Anything with 0 or less remaining (a replica
 * waiting for the host's remove) is left out.
 */
export function getFireZones(sys: GadgetSystem): readonly FireZoneInfo[] {
  const list = sys.fireZoneList;
  const pool = sys.fireZonePool;
  list.length = 0;
  const t = sys.ctx.time;
  for (const d of sys.deployables) {
    if (d.removing || d.kind !== 'fire') continue;
    const remaining = d.expires > 0 ? d.expires - t : Infinity;
    if (remaining <= 0) continue;
    let z = pool[list.length];
    if (!z) { z = { id: d.id, position: d.position, radius: d.radius, remaining, hostile: false }; pool[list.length] = z; }
    z.id = d.id; z.position = d.position; z.radius = d.radius; z.remaining = remaining; z.hostile = false;
    list.push(z);
  }
  return list;
  }

/* ═══════════════════════════ placement / items ═══════════════════════════ */
/**
 * The height the authority first stands a thrown deployable (dome · smoke · fire · lure) at.
 * 2026-09-15 (B-16 · why a fire zone was invisible): it used to be `getHeightAt` (**terrain only**) — a thrown
 * canister (`ThrownGadget`) has landed on the **surface** since 2026-09-11 (an upper floor · a roof · a
 * platform deck · a tram), while the deployable dropped to the terrain below it and was buried under the
 * floor plate or roof plate (invisible, and someone standing on the floor above was outside `fireDamageAt`'s
 * 3.5 m height window and did not burn either). It is now the walkable surface **below** that point: the
 * highest one whose top face is at or under `position.y` (`getSurfaceY`'s feet-height convention —
 * `feetY + PROP_STEP_UP_MAX` is its ceiling, so `position.y − PROP_STEP_UP_MAX` is passed in). A G-10 that
 * went off in the air also drops to the surface underfoot.
 */
export function groundY(sys: GadgetSystem, position: THREE.Vector3): number {
  const world = sys.ctx.world;
  if (world && world.ready) return world.getSurfaceY(position.x, position.z, position.y - PROP_STEP_UP_MAX);
  const interior = sys.ctx.player?.interior;
  if (interior) return interior.getFloorAt(position.x, position.z);
  return position.y;
  }

export function derived(sys: GadgetSystem, key: 'useSpeedMul' | 'interactSpeedMul' | 'throwRangeMul', fallback: number): number {
  const v = sys.ctx.progression?.derived?.[key];
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : fallback;
  }

/* ═══════════════════════════ enemy helpers ═══════════════════════════ */
/**
 * The enemy list a deployable sees.
 *
 * 2026-09-18 (nest eggs): it returns **only what fights back** — a nest's `bug_egg` is left out. That keeps a
 * turret from taking an egg as its target and emptying its ammo into it ("the nearest enemy" being the egg
 * right beside it), and a mine laid next to a nest from going off on an egg that is only standing there.
 * Passing `includeProps` includes the eggs — the door for a blast-damage query, which breaks all it reaches.
 * (`EnemyManagerRef.queryNear` has the same default, so this function just passes it through.)
 */
export function enemiesNear(sys: GadgetSystem, pos: THREE.Vector3, radius: number, includeProps = false): readonly EnemyRef[] {
  const enemies = sys.ctx.enemies;
  if (!enemies) return EMPTY_ENEMIES;
  if (typeof enemies.queryNear === 'function') return enemies.queryNear(pos, radius, includeProps);
  const out: EnemyRef[] = [];
  const r2 = radius * radius;
  for (const e of enemies.getEnemies()) {
    if (e.isDead || (e.isEgg && !includeProps)) continue;
    if (e.position.distanceToSquared(pos) <= r2) out.push(e);
  }
  return out;
  }

/**
 * One enemy by id. 2026-09-18: **eggs are never returned** — the one caller is the turret re-acquiring "last
 * tick's target" (`parts/Simulate.updateTurret`), and leaving an egg as a target would undo the filtering
 * `enemiesNear` does.
 */
export function enemyById(sys: GadgetSystem, id: number): EnemyRef | null {
  const enemies = sys.ctx.enemies;
  if (!enemies) return null;
  for (const e of enemies.getEnemies()) if (e.id === id) return e.isEgg ? null : e;
  return null;
  }
