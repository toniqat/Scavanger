/**
 * src/world/rover/parts/Turret.ts — the rover's **two turrets** (R2, 2026-09-13 · two guns · hostility 2026-09-21).
 *
 * - `updateTurretVisual` — every client: turns a mount toward its aim point (its own rest facing with none — the nose
 *   gun forward, the tail gun backwards) and switches the muzzle flash on and off. A replica does not know the target,
 *   so it takes the host's `rover fire {p}` impact point as the aim point.
 * - `updateTurretLogic` — **the authority (single player · host) only**, and only while running (`patrol` · `trip`):
 *   it picks the nearest living target within the mount's range with a clear line of sight, turns onto it and fires
 *   once inside the aim cone.
 *
 * ## The two guns (2026-09-21, user's decision)
 * The front mount is a **common-grade SMG** and the rear one a **common-grade assault rifle**: their damage · rate ·
 * range are the `ROVER_TURRET_FRONT_*` / `_REAR_*` csv rows, and the **falloff curve is the gun's own**, read out of
 * `weapons.csv` through `LootRef.getEffectiveStats('smg' | 'ar')` so no second copy of those distances exists here.
 * A destroyed mount simply stops being ticked (`Rover` skips it) — the other one carries on.
 *
 * ## Who it shoots
 * Enemies always, exactly as before (`ROVER_DAMAGE_SOURCE` — aggro on the vehicle, no kill credit). Once the vehicle
 * has turned **hostile** (`ROVER_AGGRO_DAMAGE` of player-side damage) it also shoots people: the local player, every
 * squadmate the host can see and every android. Against those bodies the shot only lands with probability
 * `ROVER_TURRET_PC_ACCURACY` (user's spec 「−50 % accuracy against a PC」) and a miss is **fired anyway**, wide of the
 * body, so the player sees the tracer go past instead of nothing happening. Enemies are not subject to it.
 */
import * as THREE from 'three';
import {
  PLAYER_HEIGHT, PLAYER_RADIUS,
  ROVER_DAMAGE_SOURCE, ROVER_TURRET_AIM_CONE, ROVER_TURRET_FRONT_DAMAGE, ROVER_TURRET_FRONT_INTERVAL_S,
  ROVER_TURRET_FRONT_RANGE, ROVER_TURRET_PC_ACCURACY, ROVER_TURRET_REAR_DAMAGE, ROVER_TURRET_REAR_INTERVAL_S,
  ROVER_TURRET_REAR_RANGE, ROVER_TURRET_RETARGET_S, ROVER_TURRET_TURN_RATE,
  type AllyBodyView, type EnemyRef, type GameContext, type PeerId, type RemotePlayerRef, type WorldRef,
} from '@/shared';
/**
 * 2026-09-21 — the **one** damage-falloff formula (`items/WeaponStats`). `shared/ballistics.ts` holds the shell arc
 * only, so this is the same import `allies/parts/Combat.ts` already makes for the same reason: an AI-driven gun has
 * to fall off exactly the way the player's does. Nothing else of `@/items` is used here.
 */
import { damageFalloffStats } from '@/items';
import { angleDelta } from '../model';
import type { RoverTurretMount } from './Body';

/** After this long (seconds) with no aim point, a turret returns to its rest facing. */
const AIM_HOLD_S = 0.8;
/** How long the muzzle flash stays on (seconds). */
const FLASH_S = 0.05;
/** The sight ray starts this far (m) ahead of the turret — so it does not hit the body's own collider. */
const LOS_SKIP_M = 4.4;
/** A missed shot at a person is thrown this far (m) sideways / up, so the tracer visibly goes past. */
const MISS_SPREAD_M = 2.2;

/** One gun's numbers. Built once per raid (`makeTurretProfiles`) — the falloff comes out of `weapons.csv`. */
export interface RoverTurretProfile {
  damage: number;
  intervalS: number;
  range: number;
  /** The gun's own falloff, in the shape `damageFalloffStats` takes. */
  falloff: { falloffStart: number; falloffEnd: number; falloffMin: number };
}

export interface TurretState {
  /** The turret's world yaw (the body yaw convention). */
  worldYaw: number;
  /**
   * The body it is shooting at, as a key: `e:<enemyId>` · `p` (the local player) · `g:<PeerId>` · `a:<AllyId>`.
   * Empty = none. It is a key rather than a number because the turret now picks people too.
   */
  targetKey: string;
  /** The enemy id of the current target when it is an enemy, else null — this is what `rover:fired` carries. */
  targetId: number | null;
  /**
   * The enemy body behind `targetKey`, held between frames. With the guns' real ranges (120 · 210 m) a
   * `queryNear` every frame would sweep most of the map twice a frame, so the ref is kept and only **validated**
   * (`id` still matches — the pool reuses bodies — and it is still alive). Re-picking still goes through `queryNear`,
   * once every `ROVER_TURRET_RETARGET_S`.
   */
  heldEnemy: EnemyRef | null;
  retarget: number;
  fireTimer: number;
  readonly aim: THREE.Vector3;
  /** It aims at `aim` until this moment (`ctx.time`). */
  aimUntil: number;
  flashUntil: number;
}

export function makeTurretState(): TurretState {
  return {
    worldYaw: 0, targetKey: '', targetId: null, heldEnemy: null, retarget: 0, fireTimer: 0,
    aim: new THREE.Vector3(), aimUntil: -Infinity, flashUntil: -Infinity,
  };
}

/** No falloff at all — what a gun def that `items/` has not registered yet falls back to (×1 at every distance). */
const NO_FALLOFF = Object.freeze({ falloffStart: 0, falloffEnd: 0, falloffMin: 1 });

/**
 * The two guns' numbers, `[front, rear]`. The falloff is looked up once at build: `getEffectiveStats(defId)` on a
 * bare def id is the **common grade** with no sockets, which is what the vehicle mounts.
 */
export function makeTurretProfiles(game: GameContext): readonly [RoverTurretProfile, RoverTurretProfile] {
  const curve = (defId: string): RoverTurretProfile['falloff'] => {
    const st = game.loot?.getEffectiveStats(defId);
    return st ? { falloffStart: st.falloffStart, falloffEnd: st.falloffEnd, falloffMin: st.falloffMin } : NO_FALLOFF;
  };
  return [
    { damage: ROVER_TURRET_FRONT_DAMAGE, intervalS: ROVER_TURRET_FRONT_INTERVAL_S, range: ROVER_TURRET_FRONT_RANGE, falloff: curve('smg') },
    { damage: ROVER_TURRET_REAR_DAMAGE, intervalS: ROVER_TURRET_REAR_INTERVAL_S, range: ROVER_TURRET_REAR_RANGE, falloff: curve('ar') },
  ];
}

const _pivot = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _side = new THREE.Vector3();

/** Every client: one mount's rotation and muzzle flash. */
export function updateTurretVisual(ts: TurretState, mount: RoverTurretMount, hullYaw: number, now: number, dt: number): void {
  mount.group.getWorldPosition(_pivot);
  const want = now < ts.aimUntil ? Math.atan2(ts.aim.z - _pivot.z, ts.aim.x - _pivot.x) : hullYaw + mount.restYaw;
  const d = angleDelta(ts.worldYaw, want);
  const step = ROVER_TURRET_TURN_RATE * dt;
  ts.worldYaw += Math.max(-step, Math.min(step, d));
  mount.group.rotation.y = -(ts.worldYaw - hullYaw);
  mount.muzzleFlash.scale.setScalar(now < ts.flashUntil ? 1 : 1e-4);
}

/** A replica received one of the host's shots — the aim point and muzzle flash only. The muzzle's world position is written into `outMuzzle`. */
export function applyRemoteShot(ts: TurretState, mount: RoverTurretMount, p: THREE.Vector3, now: number, outMuzzle: THREE.Vector3): void {
  ts.aim.copy(p);
  ts.aimUntil = now + AIM_HOLD_S;
  ts.flashUntil = now + FLASH_S;
  mount.barrelTip.getWorldPosition(outMuzzle);
}

/** What the turret is allowed to shoot this frame. Built by `Rover` once per frame and shared by both mounts. */
export interface TurretScope {
  /** The vehicle has turned hostile — people become targets too. */
  hostile: boolean;
  /** Rider ids as the host holds them (PeerIds · the host's own `selfId`) — a rider is inside the car, never a target. */
  riders: readonly string[];
  /** The id that means "this client" in the rider list. */
  selfId: string;
}

/** One resolved candidate. Reused — never stored. */
interface Candidate {
  key: string;
  enemy: EnemyRef | null;
  peer: PeerId | null;
  ally: string | null;
  local: boolean;
  readonly position: THREE.Vector3;
  height: number;
  radius: number;
  playerSide: boolean;
}
const _cand: Candidate = { key: '', enemy: null, peer: null, ally: null, local: false, position: new THREE.Vector3(), height: 0, radius: 0, playerSide: false };
const _best: Candidate = { key: '', enemy: null, peer: null, ally: null, local: false, position: new THREE.Vector3(), height: 0, radius: 0, playerSide: false };

function copyCand(to: Candidate, from: Candidate): void {
  to.key = from.key; to.enemy = from.enemy; to.peer = from.peer; to.ally = from.ally; to.local = from.local;
  to.position.copy(from.position); to.height = from.height; to.radius = from.radius; to.playerSide = from.playerSide;
}

/**
 * The authority: picking a target · aiming · firing, for **one** mount. `fire(from, to, targetId)` is called once per
 * shot, hit or miss (`Rover` does the FX, the broadcast and the event). `from` and `to` are scratch — they are not
 * kept. `targetId` is the enemy the round went to, or null (a person, or a miss) — the target is handed over with the
 * shot rather than read back off the state, so `rover:fired` names the body that took the damage on the line above
 * even when the next frame has already retargeted (2026-09-21, B-73).
 */
export function updateTurretLogic(
  game: GameContext, ts: TurretState, mount: RoverTurretMount, profile: RoverTurretProfile, scope: TurretScope,
  dt: number, now: number,
  fire: (from: THREE.Vector3, to: THREE.Vector3, targetId: number | null) => void,
): void {
  ts.fireTimer -= dt;
  ts.retarget -= dt;
  const world = game.world;
  if (!world) return;
  mount.group.getWorldPosition(_pivot);
  _pivot.y += 0.5;

  let have = false;
  if (ts.retarget <= 0 || !ts.targetKey) {
    ts.retarget = ROVER_TURRET_RETARGET_S;
    have = pickTarget(game, world, scope, _pivot, profile.range);
    ts.targetKey = have ? _best.key : '';
    ts.heldEnemy = have ? _best.enemy : null;
  } else {
    have = resolveTarget(game, scope, ts, _pivot, profile.range + 2);
    if (!have) { ts.targetKey = ''; ts.heldEnemy = null; }
  }
  ts.targetId = have ? _best.enemy?.id ?? null : null;
  if (!have) return;

  _tgt.copy(_best.position);
  _tgt.y += _best.height * 0.55;
  ts.aim.copy(_tgt);
  ts.aimUntil = now + AIM_HOLD_S;
  const want = Math.atan2(_tgt.z - _pivot.z, _tgt.x - _pivot.x);
  if (Math.abs(angleDelta(ts.worldYaw, want)) > ROVER_TURRET_AIM_CONE || ts.fireTimer > 0) return;
  if (!lineOfSight(world, _pivot, _tgt, _best.radius)) { ts.targetKey = ''; ts.heldEnemy = null; ts.targetId = null; return; }

  ts.fireTimer = profile.intervalS;
  ts.flashUntil = now + FLASH_S;
  mount.barrelTip.getWorldPosition(_muzzle);

  // 2026-09-21 — the accuracy penalty against a person. A miss is still a **fired shot**: same rate, same sound, a
  // tracer thrown wide. Silently dropping it would read as the gun jamming.
  if (_best.playerSide && Math.random() >= ROVER_TURRET_PC_ACCURACY) {
    _dir.subVectors(_tgt, _muzzle).normalize();
    _side.set(-_dir.z, 0, _dir.x).normalize();
    const sway = (Math.random() * 2 - 1) * MISS_SPREAD_M;
    _tgt.addScaledVector(_side, sway).y += (Math.random() * 2 - 1) * MISS_SPREAD_M * 0.5;
    fire(_muzzle, _tgt, null);
    return;
  }

  _dir.subVectors(_tgt, _muzzle).normalize();
  const damage = profile.damage * damageFalloffStats(profile.falloff, _muzzle.distanceTo(_tgt));
  applyTurretDamage(game, _best, damage, _tgt, _dir);
  fire(_muzzle, _tgt, _best.enemy?.id ?? null);
}

/** Deals one landed shot to whatever `c` is. Enemies keep `ROVER_DAMAGE_SOURCE`; a person takes it as `explosion` (the tram's convention for a vehicle). */
function applyTurretDamage(game: GameContext, c: Candidate, damage: number, at: THREE.Vector3, dir: THREE.Vector3): void {
  if (c.enemy) { c.enemy.takeDamage(damage, at.clone(), dir.clone(), ROVER_DAMAGE_SOURCE); return; }
  if (c.local) { game.player?.takeDamage(damage, at.clone(), { kind: 'explosion' }); return; }
  if (c.ally) { game.allies?.damage(c.ally, damage, { kind: 'explosion' }, at.clone()); return; }
  if (c.peer && game.isMultiplayer && game.net?.isHost) {
    game.net.send({ t: 'dmg', amount: damage, from: [at.x, at.y, at.z], src: { k: 'explosion' } }, c.peer);
  }
}

/** Fills `_best` with the nearest valid target in range with a clear line of sight. false = nothing to shoot. */
function pickTarget(game: GameContext, world: WorldRef, scope: TurretScope, pivot: THREE.Vector3, range: number): boolean {
  let best = Infinity;
  let found = false;
  const consider = (): void => {
    const d2 = _cand.position.distanceToSquared(pivot);
    if (d2 >= best || d2 > range * range) return;
    _tgt.copy(_cand.position); _tgt.y += _cand.height * 0.55;
    if (!lineOfSight(world, pivot, _tgt, _cand.radius)) return;
    best = d2;
    found = true;
    copyCand(_best, _cand);
  };

  const enemies = game.enemies;
  if (enemies) {
    const near = enemies.queryNear(pivot, range);
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      if (e.isDead) continue;
      fillEnemy(e);
      consider();
    }
  }
  if (!scope.hostile) return found;
  if (fillLocal(game, scope)) consider();
  const net = game.net;
  if (net && game.isMultiplayer) {
    const refs = net.getRemotePlayers();
    for (let i = 0; i < refs.length; i++) if (fillPeer(refs[i], scope)) consider();
  }
  const bodies = game.allies?.getCombatBodies();
  if (bodies) for (let i = 0; i < bodies.length; i++) if (fillAlly(bodies[i])) consider();
  return found;
}

/** Re-fills `_best` from the target the state already holds. false = that body is gone / dead / out of range. */
function resolveTarget(game: GameContext, scope: TurretScope, ts: TurretState, pivot: THREE.Vector3, range: number): boolean {
  const key = ts.targetKey;
  const ok = (): boolean => {
    if (_cand.position.distanceToSquared(pivot) > range * range) return false;
    copyCand(_best, _cand);
    return true;
  };
  if (key.startsWith('e:')) {
    const e = ts.heldEnemy;
    if (!e || e.isDead || e.id !== Number(key.slice(2))) return false;
    fillEnemy(e);
    return ok();
  }
  if (!scope.hostile) return false;
  if (key === 'p') return fillLocal(game, scope) ? ok() : false;
  if (key.startsWith('a:')) {
    const bodies = game.allies?.getCombatBodies();
    if (bodies) for (let i = 0; i < bodies.length; i++) if (bodies[i].id === key.slice(2)) return fillAlly(bodies[i]) ? ok() : false;
    return false;
  }
  if (key.startsWith('g:')) {
    const refs = game.net?.getRemotePlayers();
    if (refs) for (let i = 0; i < refs.length; i++) if (refs[i].id === key.slice(2)) return fillPeer(refs[i], scope) ? ok() : false;
  }
  return false;
}

function fillEnemy(e: EnemyRef): void {
  _cand.key = `e:${e.id}`; _cand.enemy = e; _cand.peer = null; _cand.ally = null; _cand.local = false;
  _cand.position.copy(e.position); _cand.height = e.height; _cand.radius = e.radius; _cand.playerSide = false;
}

function fillLocal(game: GameContext, scope: TurretScope): boolean {
  const p = game.player;
  if (!p || p.isDead || p.isInShip || p.isDropping || p.roverRide) return false;
  if (scope.riders.includes(scope.selfId)) return false;
  _cand.key = 'p'; _cand.enemy = null; _cand.peer = null; _cand.ally = null; _cand.local = true;
  _cand.position.copy(p.position); _cand.height = PLAYER_HEIGHT; _cand.radius = PLAYER_RADIUS; _cand.playerSide = true;
  return true;
}

function fillPeer(r: RemotePlayerRef, scope: TurretScope): boolean {
  if (!r.inMission || r.isDead || r.connected === false || scope.riders.includes(r.id)) return false;
  _cand.key = `g:${r.id}`; _cand.enemy = null; _cand.peer = r.id; _cand.ally = null; _cand.local = false;
  _cand.position.copy(r.position); _cand.height = PLAYER_HEIGHT; _cand.radius = PLAYER_RADIUS; _cand.playerSide = true;
  return true;
}

function fillAlly(b: AllyBodyView): boolean {
  if (b.dead || b.downed || b.hidden) return false;
  _cand.key = `a:${b.id}`; _cand.enemy = null; _cand.peer = null; _cand.ally = b.id; _cand.local = false;
  _cand.position.copy(b.position); _cand.height = PLAYER_HEIGHT; _cand.radius = PLAYER_RADIUS; _cand.playerSide = true;
  return true;
}

/** Is the line from the turret to `to` (a body's mid-height) clear of terrain and obstacles? The ray starts outside the body. */
function lineOfSight(world: WorldRef, from: THREE.Vector3, to: THREE.Vector3, radius: number): boolean {
  _dir.subVectors(to, from);
  const dist = _dir.length();
  if (dist <= LOS_SKIP_M) return true;
  _dir.divideScalar(dist);
  _origin.copy(from).addScaledVector(_dir, LOS_SKIP_M);
  const hit = world.raycast(_origin, _dir, dist - LOS_SKIP_M);
  return !hit || hit.distance >= dist - LOS_SKIP_M - radius - 0.4;
}
