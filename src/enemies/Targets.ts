import * as THREE from 'three';
import { CLOAK_DETECT_MUL, PLAYER_HEIGHT, PlayerFlags, blastReachesBody, explosionFalloff, type AllyBodyView, type DroneRef, type GameContext, type PeerId, type PlayerRef, type RoverRef, type WorldRef } from '@/shared';
import type { Enemy } from './Enemy';

/** `'local'` is the player on this machine; `'ai'` is another enemy (faction warfare, Phase 4); anything else is a remote peer id. */
export type TargetId = PeerId | 'local' | 'ai';

const EYE_STAND = 1.55, EYE_CROUCH = 1.15, EYE_PRONE = 0.45;

/**
 * 2026-09-13 (the rover): the slack (m) between the hull's judgement box (`RoverRef.halfLength/halfWidth/height`) and the world raycast (the hull collider).
 * A line-of-sight check stops this far **short** of entering the hull — otherwise the hull's own collider blocks the line and the vehicle is never seen.
 * A shot counts as hitting the vehicle when the world impact lands within this much of the hull's face (the collider may be a little larger than the judgement box).
 * An algorithm constant, not a csv number.
 */
export const VEHICLE_RAY_MARGIN = 0.5;

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
  /* ── appended (2026-09-11): drone targets ─────────────────────────────────── */
  /**
   * The drone this target proxies (`TargetList.drones`), else null. A drone proxy's `id` is `'ai'` — so that the player
   * id scheme (`'local'` / PeerId) is left alone — and damage goes to `ctx.drones.damageDrone` by `droneId`.
   * The reference is not cleared when the drone goes away (only `present` / `isDead` drop) — so an enemy holding it as
   * its target at that moment never mistakes the proxy for a player and sends a `dmg` to `'ai'`.
   */
  drone: DroneRef | null = null;
  droneId: string | null = null;
  droneRadius = 0;
  droneHeight = 0;
  /** How many m the drone body's **underside** floats above the surface below it — whether a melee bug can reach it (`pickTarget`). */
  droneAltitude = 0;
  /** Whether `TargetList` saw this drone in this refresh (the frame number). */
  droneStamp = 0;
  /** For estimating velocity — `DroneRef` carries none, so it is differenced from the position. */
  readonly dronePrev = new THREE.Vector3();
  dronePrevAt = -Infinity;
  /* ── appended (2026-09-13): the rover ─────────────────────────────────────── */
  /**
   * This player is riding **inside** the rover (local `PlayerRef.roverRide` · remote `PlayerFlags.IN_ROVER`). A rider takes
   * no damage at all, so it is neither an enemy's target nor its victim — it folds into `isDeadOrDowned`, drops out of
   * `alive`, and an enemy holding it re-targets. It stays in `all` (spawn and recycle distances still see the body).
   */
  riding = false;
  /**
   * The rover this target proxies (`TargetList.vehicles`), else null. The proxy `id` is `'ai'` — the same reason as the drone.
   * The reference is not cleared when the vehicle goes away (destroyed · raid over); only `present` / `isDead` drop.
   * `position` = the **floor** at the hull's centre (`RoverVehicleDef.position`), `dist2D` = the distance to the hull footprint's (OBB) **edge**.
   */
  vehicle: RoverRef | null = null;
  /** Vehicle proxy: the hull yaw (the `RoverVehicleDef.yaw` convention — forward = (cos, 0, sin)). The `yaw` field is written separately in the player convention. */
  vehicleYaw = 0;
  /** Vehicle proxy: it is driving right now (`patrol` · `trip`) — it can be heard. */
  vehicleMoving = false;
  readonly vehiclePrev = new THREE.Vector3();
  vehiclePrevAt = -Infinity;
  /* ── appended (2026-09-15): android squadmates ────────────────────────────── */
  /**
   * The android squadmate's body this target proxies (`TargetList.allies`), else null. The proxy `id` is `'ai'` for the same
   * reason as the drone and the vehicle — mixed into the player id scheme (`'local'` / PeerId), `applyDamage`'s remote
   * branch would send a `dmg` to somebody who does not exist. Identity is `allyId` (`AllyBodyView.id`), damage goes to `ctx.allies.damage`.
   * The reference is not cleared when the android goes away; only `present` / `isDead` drop (the same reason as the drone).
   */
  ally: AllyBodyView | null = null;
  allyId: string | null = null;
  /** Whether `TargetList` saw this android in this refresh (the frame number). */
  allyStamp = 0;

  constructor(readonly id: TargetId) {}

  get isLocal(): boolean { return this.id === 'local'; }
  get isEnemy(): boolean { return this.enemy !== null; }
  get isDrone(): boolean { return this.drone !== null; }
  get isVehicle(): boolean { return this.vehicle !== null; }
  /** 2026-09-15: android squadmates — body size, line of sight and aim are a person's; only the damage goes to `ctx.allies.damage`. */
  get isAlly(): boolean { return this.ally !== null; }

  /** True when bugs must neither hunt nor hurt this player (dead, or downed and waiting for a revive — or 2026-09-13 riding inside the rover). */
  get isDeadOrDowned(): boolean { return this.isDead || this.downed || this.riding; }

  getEyePosition(out: THREE.Vector3): THREE.Vector3 {
    if (this.player) return this.player.getEyePosition(out);
    if (this.drone || this.vehicle) return this.getChest(out);
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
    // a drone proxy's `position` is the body's underside, so its centre sits half the height above it (an air drone = the original body centre)
    // 2026-09-13: a vehicle proxy's centre = half the hull height (measured from the floor point)
    const h = this.vehicle ? this.vehicle.height * 0.5 : this.drone ? this.droneHeight * 0.5 : this.enemy ? this.enemy.height * 0.6 : PLAYER_HEIGHT * 0.65;
    return out.set(this.position.x, this.position.y + h, this.position.z);
  }

  /**
   * Body radius for hit tests (players PLAYER_RADIUS-like via the caller; enemies their own; drones their body).
   * 2026-09-13: a vehicle is 0 — its `dist2D` already measures to the hull's edge, so every "`d < reach + bodyRadius`" rule
   * reads the edge distance unchanged.
   */
  get bodyRadius(): number { return this.vehicle ? 0 : this.drone ? this.droneRadius : this.enemy ? this.enemy.radius : 0.45; }
  get bodyHeight(): number { return this.vehicle ? this.vehicle.height : this.drone ? this.droneHeight : this.enemy ? this.enemy.height : PLAYER_HEIGHT; }

  /** 2D distance to `p` — for a vehicle proxy (2026-09-13) the distance to the hull footprint's **edge** (0 inside). */
  dist2D(p: THREE.Vector3): number {
    if (this.vehicle) return this.vehicleGap2D(p.x, p.z);
    return Math.hypot(this.position.x - p.x, this.position.z - p.z);
  }

  /* ── 2026-09-13: hull box (OBB) queries for the rover — called on a vehicle proxy only. No allocation. ── */

  /** Horizontal distance from `(x, z)` to the hull footprint (0 inside it). */
  vehicleGap2D(x: number, z: number): number {
    const v = this.vehicle!;
    const c = Math.cos(this.vehicleYaw), s = Math.sin(this.vehicleYaw);
    const dx = x - this.position.x, dz = z - this.position.z;
    const ox = Math.max(0, Math.abs(dx * c + dz * s) - v.halfLength);
    const oz = Math.max(0, Math.abs(-dx * s + dz * c) - v.halfWidth);
    return Math.hypot(ox, oz);
  }

  /** Distance from point `p` to the hull box (floor … floor + height), 0 inside it — explosions and acid splashes. */
  vehicleGap3D(p: THREE.Vector3): number {
    const g = this.vehicleGap2D(p.x, p.z);
    const y0 = this.position.y, y1 = y0 + this.vehicle!.height;
    const oy = p.y < y0 ? y0 - p.y : p.y > y1 ? p.y - y1 : 0;
    return Math.hypot(g, oy);
  }

  /** Whether `(x, z)` is inside the hull footprint widened by `pad`. */
  vehicleContainsXZ(x: number, z: number, pad: number): boolean {
    const v = this.vehicle!;
    const c = Math.cos(this.vehicleYaw), s = Math.sin(this.vehicleYaw);
    const dx = x - this.position.x, dz = z - this.position.z;
    return Math.abs(dx * c + dz * s) <= v.halfLength + pad && Math.abs(-dx * s + dz * c) <= v.halfWidth + pad;
  }

  /**
   * Writes into `out`'s x / z the point on the hull footprint widened by `pad` that is nearest to `from` (y is left alone). When `from` is already
   * inside, the point pushed out to the nearest face. It is the steering goal that makes an enemy approach the hull's side, not the vehicle's **centre**.
   */
  vehicleApproach(from: THREE.Vector3, pad: number, out: THREE.Vector3): THREE.Vector3 {
    const v = this.vehicle!;
    const c = Math.cos(this.vehicleYaw), s = Math.sin(this.vehicleYaw);
    const hl = v.halfLength + pad, hw = v.halfWidth + pad;
    const dx = from.x - this.position.x, dz = from.z - this.position.z;
    let lx = dx * c + dz * s, lz = -dx * s + dz * c;
    if (Math.abs(lx) <= hl && Math.abs(lz) <= hw) {
      if (hl - Math.abs(lx) < hw - Math.abs(lz)) lx = (lx < 0 ? -1 : 1) * hl;
      else lz = (lz < 0 ? -1 : 1) * hw;
    } else {
      lx = Math.max(-hl, Math.min(hl, lx));
      lz = Math.max(-hw, Math.min(hw, lz));
    }
    out.x = this.position.x + lx * c - lz * s;
    out.z = this.position.z + lx * s + lz * c;
    return out;
  }

  /** How far along the ray (`d` is a unit vector) it enters the hull box — 0 when the origin is inside, −1 when it misses within `maxT` (a slab test). */
  rayVehicle(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number {
    const v = this.vehicle!;
    const c = Math.cos(this.vehicleYaw), s = Math.sin(this.vehicleYaw);
    const hh = v.height * 0.5;
    const rx = o.x - this.position.x, rz = o.z - this.position.z;
    const ox = rx * c + rz * s, oz = -rx * s + rz * c, oy = o.y - (this.position.y + hh);
    const dx = d.x * c + d.z * s, dz = -d.x * s + d.z * c, dy = d.y;
    let t0 = 0, t1 = maxT;
    // x (the forward axis)
    if (Math.abs(dx) < 1e-9) { if (Math.abs(ox) > v.halfLength) return -1; }
    else {
      let a = (-v.halfLength - ox) / dx, b = (v.halfLength - ox) / dx;
      if (a > b) { const k = a; a = b; b = k; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    // z (the side axis)
    if (Math.abs(dz) < 1e-9) { if (Math.abs(oz) > v.halfWidth) return -1; }
    else {
      let a = (-v.halfWidth - oz) / dz, b = (v.halfWidth - oz) / dz;
      if (a > b) { const k = a; a = b; b = k; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    // y
    if (Math.abs(dy) < 1e-9) { if (Math.abs(oy) > hh) return -1; }
    else {
      let a = (-hh - oy) / dy, b = (hh - oy) / dy;
      if (a > b) { const k = a; a = b; b = k; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    return t0;
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
  /* ── appended (2026-09-11): drone targets ── */
  /**
   * Proxies for the drones an enemy may target right now (`DroneRef.aggroable`, alive). **They go into neither `all` nor `alive`** —
   * so the spawner, waves, acid splashes, shells and separation never mistake a drone for a player. Only the paths that have to
   * know about drones (`pickTarget` · rogue fire · a direct acid hit · body contact `nearestAliveWithin`) read this list.
   * One proxy per drone id, kept while that drone is in the world (going quiet only drops `present`) — one allocation, when it first appears.
   */
  readonly drones: CombatTarget[] = [];
  private readonly droneById = new Map<string, CombatTarget>();
  /** Every drone proxy (quiet ones included) — for the sweep that finds drones that went away. Iterating Map entries allocates a tuple per frame. */
  private readonly droneAll: CombatTarget[] = [];
  private droneFrame = 0;
  /* ── appended (2026-09-13): the rover ── */
  /**
   * The proxy for the rover an enemy may target (`RoverRef.targetable`) — one per raid, so 0 or 1 entries. **It goes into neither `all` nor `alive`**
   * (the same reason as the drone — so the spawner, waves, separation and the player loop never mistake the vehicle for a player). Only the paths
   * that have to know about it (`pickTarget` · fire · acid · body contact · enemy explosions) read it. The one proxy is reused for good.
   */
  readonly vehicles: CombatTarget[] = [];
  private readonly vehicleProxy = new CombatTarget('ai');
  /* ── appended (2026-09-15): android squadmates ── */
  /**
   * Proxies for the android squadmates an enemy may target (`AlliesRef.getCombatBodies`). **They go into neither `all` nor `alive`** —
   * the same reason as the drone and the vehicle, and because the places that count 「the raid fails when every human is dead」
   * (user's decision) must not count an android as a human. Spawner anchors, wave facing and `nearestAlive` see people only.
   * Only target choice, fire, acid, body contact and area damage read this list.
   */
  readonly allies: CombatTarget[] = [];
  private readonly allyById = new Map<string, CombatTarget>();
  private readonly allyAll: CombatTarget[] = [];
  private allyFrame = 0;
  /**
   * Debug injection (`EnemySystem.debugAllyTargets`) — when it is not null this list is used instead of `ctx.allies`.
   * It is the only way `scripts/smoke-enemy-allies.mjs` can test the enemy half without allies/.
   */
  allyOverride: readonly AllyBodyView[] | null = null;
  /** 2026-09-18: the world the blast-occlusion test (`damageVehicleAt`) reads — `refresh` stores it every frame. */
  private world: WorldRef | null = null;

  refresh(ctx: GameContext): void {
    this.world = ctx.world ?? null;
    this.refreshDrones(ctx);
    this.refreshVehicle(ctx);
    this.refreshAllies(ctx);
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
      t.riding = player.roverRide === true;   // 2026-09-13: inside the rover — neither a target nor a victim
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
        t.riding = (r.flags & PlayerFlags.IN_ROVER) !== 0;   // 2026-09-13
      }
    }

    this.all.length = 0;
    this.alive.length = 0;
    this.gone.length = 0;
    for (const t of this.byId.values()) {
      if (!t.present) { this.gone.push(t.id); continue; }
      this.all.push(t);
      if (!t.isDead && !t.downed && !t.riding) this.alive.push(t);
    }
    for (let i = 0; i < this.gone.length; i++) this.byId.delete(this.gone[i]);
  }

  private obtain(id: TargetId): CombatTarget {
    let t = this.byId.get(id);
    if (!t) { t = new CombatTarget(id); this.byId.set(id, t); }
    t.present = true;
    return t;
  }

  /**
   * 2026-09-11: `ctx.drones.getDrones()` → `drones`. A walking ground drone has `aggroable` false and never reaches the list (an enemy
   * that sees it ignores it). The proxy `position` is the **body's underside** — for a ground drone that is `DroneRef.position` (the
   * floor point) unchanged, for an air drone half the height below the body centre. So the existing feet-based formulas (`getChest` ·
   * `rayStandingCapsule` · `lookAtTarget` · acid aim) fit an air drone unchanged. yaw is flipped into the player convention (forward = −sin, −cos).
   */
  private refreshDrones(ctx: GameContext): void {
    const frame = ++this.droneFrame;
    this.drones.length = 0;
    const list = ctx.drones?.getDrones();
    if (list && list.length > 0) {
      const world = ctx.world && ctx.world.ready ? ctx.world : null;
      const now = ctx.time;
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        let t = this.droneById.get(d.id);
        if (!t) {
          t = new CombatTarget('ai');
          t.droneId = d.id;
          this.droneById.set(d.id, t);
          this.droneAll.push(t);
        }
        t.drone = d;
        t.droneStamp = frame;
        const p = d.position;
        const bottom = d.kind === 'air' ? p.y - d.height * 0.5 : p.y;
        // velocity = a position difference. Refreshed twice in one frame (world:ready and the like), the previous value is left alone.
        const dt = now - t.dronePrevAt;
        if (dt > 1e-3) {
          if (dt < 0.5) t.velocity.set((p.x - t.dronePrev.x) / dt, (p.y - t.dronePrev.y) / dt, (p.z - t.dronePrev.z) / dt);
          else t.velocity.set(0, 0, 0);
          t.dronePrev.copy(p);
          t.dronePrevAt = now;
        }
        t.position.set(p.x, bottom, p.z);
        t.yaw = d.yaw + Math.PI;
        t.droneRadius = d.radius;
        t.droneHeight = d.height;
        t.player = null;
        t.suspended = false;
        t.stealth = 1;
        t.downed = false;
        t.isDead = !(d.hp > 0);
        t.present = d.aggroable && !t.isDead;
        if (!t.present) continue;
        t.droneAltitude = world ? Math.max(0, bottom - world.getSurfaceY(p.x, p.z, bottom)) : 0;
        this.drones.push(t);
      }
    }
    // a drone that left the world: its proxy is dropped. An enemy holding that proxy sees `present` false and re-targets.
    for (let i = this.droneAll.length - 1; i >= 0; i--) {
      const t = this.droneAll[i];
      if (t.droneStamp === frame) continue;
      t.present = false;
      t.isDead = true;
      if (t.droneId !== null) this.droneById.delete(t.droneId);
      this.droneAll.splice(i, 1);
    }
  }

  /**
   * 2026-09-13: `ctx.world.rover` → `vehicles`. Destroyed, no road, or the world not ready yet = the list is emptied (only `present` /
   * `isDead` drop and the `vehicle` reference stays — so an enemy holding the proxy at that moment never mistakes it for a player).
   * Velocity is a position difference; yaw is written across in the player convention (forward = −sin, −cos) and the hull convention's value goes in `vehicleYaw`.
   */
  private refreshVehicle(ctx: GameContext): void {
    this.vehicles.length = 0;
    const t = this.vehicleProxy;
    const world = ctx.world;
    const rover = world && world.ready ? world.rover ?? null : null;
    if (!rover || !rover.targetable) {
      t.present = false; t.isDead = true; t.vehicleMoving = false; t.vehiclePrevAt = -Infinity;
      return;
    }
    const v = rover.vehicle;
    const p = v.position;
    const now = ctx.time;
    t.vehicle = rover;
    const dt = now - t.vehiclePrevAt;
    if (dt > 1e-3) {
      if (dt < 0.5) t.velocity.set((p.x - t.vehiclePrev.x) / dt, (p.y - t.vehiclePrev.y) / dt, (p.z - t.vehiclePrev.z) / dt);
      else t.velocity.set(0, 0, 0);
      t.vehiclePrev.copy(p);
      t.vehiclePrevAt = now;
    }
    t.position.copy(p);
    t.vehicleYaw = v.yaw;
    t.yaw = Math.atan2(-Math.cos(v.yaw), -Math.sin(v.yaw));
    t.vehicleMoving = v.state === 'patrol' || v.state === 'trip';
    t.player = null;
    t.suspended = false;
    t.stealth = 1;
    t.downed = false;
    t.riding = false;
    t.isDead = false;
    t.present = true;
    this.vehicles.push(t);
  }

  /**
   * 2026-09-15 (android squadmates): `ctx.allies.getCombatBodies()` → `allies`. By contract that list is already filtered to 「in a
   * raid · neither downed nor dead · visible」, but it is checked once more here so that a list one frame late is still safe.
   * One proxy per android id, kept while that unit is in the list — one allocation, when it is first seen.
   */
  private refreshAllies(ctx: GameContext): void {
    const frame = ++this.allyFrame;
    this.allies.length = 0;
    const list = this.allyOverride ?? ctx.allies?.getCombatBodies();
    if (list && list.length > 0) {
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        let t = this.allyById.get(b.id);
        if (!t) {
          t = new CombatTarget('ai');
          t.allyId = b.id;
          this.allyById.set(b.id, t);
          this.allyAll.push(t);
        }
        t.ally = b;
        t.allyStamp = frame;
        t.position.copy(b.position);
        t.velocity.copy(b.velocity);
        t.yaw = b.yaw;
        t.player = null;
        t.suspended = false;
        t.stealth = 1;
        t.riding = false;
        t.downed = b.downed;
        t.isDead = b.dead;
        t.eyeHeight = b.pose === 'crouch' ? EYE_CROUCH : EYE_STAND;
        t.present = !b.hidden && !b.dead && !b.downed;
        if (!t.present) continue;
        this.allies.push(t);
      }
    }
    // an android that left the list: its proxy is dropped (an enemy holding it as its target sees `present` false and re-targets)
    for (let i = this.allyAll.length - 1; i >= 0; i--) {
      const t = this.allyAll[i];
      if (t.allyStamp === frame) continue;
      t.present = false;
      t.isDead = true;
      if (t.allyId !== null) this.allyById.delete(t.allyId);
      this.allyAll.splice(i, 1);
    }
  }

  /** 2026-09-15: the nearest android proxy to `p` that may be targeted right now (null when there is none). */
  nearestAllyAlive(p: THREE.Vector3): CombatTarget | null {
    let best: CombatTarget | null = null;
    let bestD = Infinity;
    for (let i = 0; i < this.allies.length; i++) {
      const t = this.allies[i];
      if (t.isDeadOrDowned) continue;
      const d = t.dist2D(p);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /** 2026-09-15: the nearest android proxy within `maxDist` of `p` — the re-target in `applyAllyHit`. */
  allyNear(p: THREE.Vector3, maxDist: number): CombatTarget | null {
    const t = this.nearestAllyAlive(p);
    return t && t.dist2D(p) <= maxDist ? t : null;
  }

  /** 2026-09-13: the rover proxy that may be targeted right now, else null. */
  vehicleTarget(): CombatTarget | null {
    return this.vehicles.length > 0 ? this.vehicles[0] : null;
  }

  /**
   * 2026-09-13 (the rover): one explosion or eruption **an enemy made** damages the hull when it reaches it — falloff by the shared
   * two-step stair (`shared/explosion`, 2026-09-15 user's decision — it used to be linear `1 − d / radius`; floor `minFalloff`) over
   * the distance from the blast centre to the hull box. Called **only in an authority branch** (`RoverRef.damage` is
   * ignored on a replica, but there is no reason to call it twice). Not put inside the shared `explode()` that player and gadget blasts pass through — user's decision 「only enemies and hazards damage it」.
   */
  damageVehicleAt(center: THREE.Vector3, radius: number, damage: number, minFalloff = 0.15): boolean {
    const t = this.vehicleTarget();
    if (!t || !t.vehicle || !(radius > 0) || !(damage > 0)) return false;
    const d = t.vehicleGap3D(center);
    if (d >= radius) return false;
    // 2026-09-18 (user's decision): a hull past a wall or a roof is not hit (the 3 body points — a ray that starts inside the hull does not see its own collider)
    if (!blastReachesBody(this.world, center, t.position.x, t.position.y, t.position.z, t.bodyHeight)) return false;
    t.vehicle.damage(damage * Math.max(minFalloff, explosionFalloff(d, radius)), center);
    return true;
  }

  clear(): void {
    this.byId.clear();
    this.all.length = 0;
    this.alive.length = 0;
    this.vehicles.length = 0;
    this.vehicleProxy.present = false;
    this.vehicleProxy.isDead = true;
    this.vehicleProxy.vehiclePrevAt = -Infinity;
    for (let i = 0; i < this.droneAll.length; i++) { const t = this.droneAll[i]; t.present = false; t.isDead = true; }
    this.droneAll.length = 0;
    this.droneById.clear();
    this.drones.length = 0;
    // 2026-09-15: the android proxies (the debug injection is left alone when the raid ends — `debugAllyTargets(null)` clears it)
    for (let i = 0; i < this.allyAll.length; i++) { const t = this.allyAll[i]; t.present = false; t.isDead = true; }
    this.allyAll.length = 0;
    this.allyById.clear();
    this.allies.length = 0;
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

  /**
   * Nearest alive target within `radius` (2D), or null — the **body contact** query (charger rush, hunter leap landing,
   * toxic swell trigger). 2026-09-11: aggroable drones count too, but only when their body is within `radius`
   * **vertically** of `p` (the enemy's feet) as well — a bug does not bump into an air drone hovering overhead.
   * `nearestAlive` (target choice, wave facing, spawner anchors) still sees players only.
   */
  nearestAliveWithin(p: THREE.Vector3, radius: number): CombatTarget | null {
    const t = this.nearestAlive(p);
    let best = t && t.dist2D(p) < radius ? t : null;
    let bestD = best ? best.dist2D(p) : radius;
    for (let i = 0; i < this.drones.length; i++) {
      const d = this.drones[i];
      if (d.isDeadOrDowned) continue;
      const dd = d.dist2D(p);
      if (dd >= bestD) continue;
      if (d.position.y - p.y > radius || d.position.y + d.droneHeight < p.y - radius) continue;
      best = d; bestD = dd;
    }
    // 2026-09-15: android squadmates — the same body as a person, so the same rule (horizontal distance only)
    for (let i = 0; i < this.allies.length; i++) {
      const a = this.allies[i];
      if (a.isDeadOrDowned) continue;
      const dd = a.dist2D(p);
      if (dd < bestD) { best = a; bestD = dd; }
    }
    // 2026-09-13: the rover — horizontal distance to the hull's **edge** (`dist2D`), only when it overlaps vertically too
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      if (v.isDeadOrDowned) continue;
      const dd = v.dist2D(p);
      if (dd >= bestD) continue;
      if (v.position.y - p.y > radius || v.position.y + v.bodyHeight < p.y - radius) continue;
      best = v; bestD = dd;
    }
    return best;
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
