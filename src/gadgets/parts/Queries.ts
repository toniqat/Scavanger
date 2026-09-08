/**
 * src/gadgets/parts/Queries.ts — **다른 폴더가 배치물에게 묻는 것**.
 *
 * 적 AI(`findEnemyTarget` / `findDistraction` / `visionFactor`), 무기(`blocksProjectile` — 돔 실드와
 * 바리케이드가 탄을 멈춘다), 플레이어(`fireDamageAt` / `jumpPadAt`). 전부 **순수 질의**이고
 * 상태를 바꾸지 않는다.
 */
import * as THREE from 'three';
import {
  GADGET_DEFUSE_TIME, GADGET_INCENDIARY_DPS, GADGET_JUMPPAD_FORWARD, GADGET_JUMPPAD_IMPULSE,
  GADGET_CLOAK_SHARE_RADIUS, GADGET_LURE_RADIUS, GADGET_MINE_ARM_TIME, GADGET_MINE_DAMAGE, GADGET_TURRET_DPS, JUMP_PAD_RETRIGGER_S, Keys, PLAYER_RADIUS,
  type BuffMessage, type DeployableKind, type DeployableRef, type EnemyRef, type FlowMessage, type GadgetDef,
  type GadgetId, type GadgetMessage, type GadgetRequest, type GameContext, type GameSystem, type GadgetsRef,
  type Interactable, type ItemInstance, type DeployableWire, type PeerId, type PlayerWeaponHost, type Vec3Tuple,
} from '@/shared';
import { GADGET_DEFS, gadgetDef, gadgetForKind, isRecoverable } from '../GadgetDefs';
import { Deployable, BARRICADE_HALF, DOME_UNFOLD_TIME, JUMPPAD_TRIGGER_RADIUS, MINE_TRIGGER_RADIUS } from '../Deployable';
import { GadgetVisualPool } from '../GadgetVisuals';
import { ThrownGadgetManager } from '../ThrownGadget';
import { EMPTY_ENEMIES, MAX_DEPLOYABLES, PLACE_CLEARANCE, PLACE_DISTANCE, PLAYER_HALF_H, RECOVER_RADIUS, TURRET_AIM_CONE, TURRET_RETARGET, TURRET_ROF, TURRET_TURN_RATE, USE_COOLDOWN, type Victim, ZONE_TICK, _a, _b, _c, _d, _e, _fwd, _g0, _g1, _g2, _r0, _r1, _r2, _r3, _r4, angleDelta, toTuple } from '../model';
import type { GadgetSystem } from '../GadgetSystem';

export function findEnemyTarget(sys: GadgetSystem, pos: THREE.Vector3, radius: number): DeployableRef | null {
  let best: Deployable | null = null, bestD = radius * radius;
  for (const d of sys.deployables) {
    if (d.removing || !d.destructible || d.hp <= 0) continue;
    if (d.kind !== 'barricade' && d.kind !== 'turret' && d.kind !== 'lure' && d.kind !== 'domeShield') continue;
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
    if (d.removing || !d.armed) continue;
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

/* ═══════════════════════════ placement / items ═══════════════════════════ */
export function groundY(sys: GadgetSystem, position: THREE.Vector3): number {
  const world = sys.ctx.world;
  if (world && world.ready) return world.getHeightAt(position.x, position.z);
  const interior = sys.ctx.player?.interior;
  if (interior) return interior.getFloorAt(position.x, position.z);
  return position.y;
  }

export function derived(sys: GadgetSystem, key: 'useSpeedMul' | 'interactSpeedMul' | 'throwRangeMul', fallback: number): number {
  const v = sys.ctx.progression?.derived?.[key];
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : fallback;
  }

/* ═══════════════════════════ enemy helpers ═══════════════════════════ */
export function enemiesNear(sys: GadgetSystem, pos: THREE.Vector3, radius: number): readonly EnemyRef[] {
  const enemies = sys.ctx.enemies;
  if (!enemies) return EMPTY_ENEMIES;
  if (typeof enemies.queryNear === 'function') return enemies.queryNear(pos, radius);
  const out: EnemyRef[] = [];
  const r2 = radius * radius;
  for (const e of enemies.getEnemies()) {
    if (!e.isDead && e.position.distanceToSquared(pos) <= r2) out.push(e);
  }
  return out;
  }

export function enemyById(sys: GadgetSystem, id: number): EnemyRef | null {
  const enemies = sys.ctx.enemies;
  if (!enemies) return null;
  for (const e of enemies.getEnemies()) if (e.id === id) return e;
  return null;
  }
