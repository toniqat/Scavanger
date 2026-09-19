/**
 * src/allies/parts/Combat.ts — **engagement**. User's decision 「레이더 AI 처럼 은엄폐 사용, 투척 · 가젯은 쓰지 않는다」.
 *
 * The flow: sensing (`ALLY_SENSE_RADIUS_M` + the line of sight) → an **enemy ping**
 * (`ALLY_ENEMY_PING_COOLDOWN_S`) → to the cover spot (`pickCoverSpot` — **the same formula** as an enemy
 * humanoid, `shared/cover.ts`) → leans out for `ALLY_BURST_MIN..MAX` rounds → hides for `ALLY_BURST_PAUSE_S`.
 * There are magazines and **spare ammo is infinite** (user's decision). The host applies the damage through
 * `ctx.enemies.applyAllyHit` (no kill credit).
 *
 * With a person · another android on the line of fire it **does not shoot** — friendly fire is real damage in
 * this game.
 *
 * **It never engages a nest egg** (2026-09-18). Every `queryNear` in this file is a 「what do I shoot / is something
 * dangerous here」 question, so all three leave props out — that is `EnemyManagerRef.queryNear`'s default
 * (`shared/types.ts`), not a filter written here. **Never pass `includeProps: true` from this file**: a nest holds
 * 8–30 eggs, so one such call makes the squad pour its magazines into a nest and stand in front of it. An egg that
 * should die dies to a person's bullet · melee · grenade, none of which come through this call.
 *
 * Three 2026-09-16 user's decisions landed here.
 *  ① **It does not move at contact range.** Even for an enemy that has closed in (inside `ALLY_ENGAGE_MIN_M`),
 *     `pickCoverSpot` returning a cover spot a few m away makes `act` walk toward it every frame and `return`,
 *     so it **never reaches the firing branch** — and a clinging enemy moves along with it, so 「the far side
 *     of the threat」 flips every frame and it never arrives either. So an enemy at contact range is not asked
 *     for cover at all (which also saves the expensive rays) and is shot on the spot. With a friend on the
 *     line it still holds fire.
 *  ② **The weapon decides the engage range** (`engageRangeOf`) — a shotgun closes in, a long gun backs off.
 *  ③ **A PC's enemy ping comes first** (`AllySystem.preferredEnemyId`, cleared by
 *     `parts/Commands.tickEnemyPing`). While it has not seen that one yet, it approaches the last known spot
 *     **inside the harness**.
 */
import * as THREE from 'three';
import {
  ALLY_AIM_ERROR_DEG, ALLY_BURST_MAX, ALLY_BURST_MIN, ALLY_BURST_PAUSE_S, ALLY_DAMAGE_MUL,
  ALLY_ENEMY_PING_COOLDOWN_S, ALLY_ENGAGE_DAMAGE_FRAC, ALLY_ENGAGE_MIN_M, ALLY_FIRE_RANGE_M, ALLY_FLAGS,
  ALLY_RUN_SPEED, ALLY_SENSE_RADIUS_M, ALLY_WATCH_S, PLAYER_HEIGHT, PLAYER_RADIUS, pickCoverSpot,
} from '@/shared';
import type { EnemyRef } from '@/shared';
import { damageFalloffStats } from '@/items';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import type { Proposal } from './Fsm';
import { PRIO, _v1, _v2, _v3, _v4, dist2D } from '../model';
import * as Nav from './Nav';
import * as Ping from './Ping';

/** Eye height = this fraction of the height (as for a person — not a balance number but a body proportion). */
const EYE_FRAC = 0.9;
const CHEST_FRAC = 0.55;

const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** The result of one sensing pass — a reused object (called per unit every frame, so nothing new is made). */
const _sensed: { near: EnemyRef | null; pref: EnemyRef | null } = { near: null, pref: null };

export function eyeOf(a: Ally, out: THREE.Vector3): THREE.Vector3 {
  return out.set(a.position.x, a.position.y + PLAYER_HEIGHT * EYE_FRAC, a.position.z);
}

/**
 * Sweeps inside the sense radius **exactly once** (`queryNear` builds an array — it is not called several
 * times in one frame): `near` is the closest enemy with a clear line of sight, and `pref` the enemy `prefId`
 * the PC picked, when that one is visible.
 */
function sense(sys: AllySystem, a: Ally, prefId: number | null): typeof _sensed {
  _sensed.near = null;
  _sensed.pref = null;
  const enemies = sys.ctx.enemies;
  if (!enemies) return _sensed;
  // Props left out (the default) — sensing picks what to shoot, and a nest egg does not fight back (the header).
  const list = enemies.queryNear(a.position, ALLY_SENSE_RADIUS_M);
  let bestD = Infinity;
  eyeOf(a, _eye);
  for (const e of list) {
    if (e.isDead) continue;
    const isPref = prefId !== null && e.id === prefId;
    const d = a.position.distanceTo(e.position);
    if (!isPref && d >= bestD) continue;
    if (!hasLineOfSight(sys, _eye, e)) continue;
    if (isPref) _sensed.pref = e;
    if (d < bestD) { _sensed.near = e; bestD = d; }
  }
  return _sensed;
}

/** The closest enemy inside the sense radius with a clear line of sight. null with none. */
export function senseEnemy(sys: AllySystem, a: Ally): EnemyRef | null {
  return sense(sys, a, null).near;
}

/**
 * The distance it **closes to** with the weapon in hand (m) — user's decision 「falloffStart 로 하되 무기 100 %
 * 위력이 아닌 약 50 % 위력부터 허용」. The inverse of the linear falloff (`damageFalloffStats`) gives the
 * distance at which the damage drops to `ALLY_ENGAGE_DAMAGE_FRAC`, cut to `ALLY_ENGAGE_MIN_M` …
 * `ALLY_FIRE_RANGE_M`. A weapon with no falloff, or one that never drops below that fraction, keeps
 * `ALLY_FIRE_RANGE_M` as it is. It is measured again **only when the weapon def changes**
 * (`Ally.engageDefId` — computing the effective stats is not cheap).
 */
export function engageRangeOf(sys: AllySystem, a: Ally): number {
  const prim = a.equip.primary;
  const defId = prim?.defId ?? null;
  if (a.engageRange > 0 && a.engageDefId === defId) return a.engageRange;
  a.engageDefId = defId;
  a.engageRange = computeEngageRange(sys, a);
  return a.engageRange;
}

function computeEngageRange(sys: AllySystem, a: Ally): number {
  const st = a.equip.primary ? sys.ctx.loot?.getEffectiveStats(a.equip.primary) : null;
  let r = ALLY_FIRE_RANGE_M;
  if (st) {
    const { falloffStart: start, falloffEnd: end, falloffMin: min } = st;
    // With `min >= FRAC` the damage never drops below that fraction however far → no reason to shorten the range.
    if (end > start && min < ALLY_ENGAGE_DAMAGE_FRAC) {
      r = start + (end - start) * ((1 - ALLY_ENGAGE_DAMAGE_FRAC) / (1 - min));
    }
  }
  return Math.max(ALLY_ENGAGE_MIN_M, Math.min(ALLY_FIRE_RANGE_M, r));
}

function hasLineOfSight(sys: AllySystem, from: THREE.Vector3, e: EnemyRef): boolean {
  const world = sys.ctx.world;
  if (!world) return true;
  _aim.set(e.position.x, e.position.y + e.height * CHEST_FRAC, e.position.z);
  _dir.subVectors(_aim, from);
  const dist = _dir.length();
  if (dist < 1e-3) return true;
  _dir.multiplyScalar(1 / dist);
  const hit = world.raycast(from, _dir, dist);
  return !hit || hit.distance >= dist - 0.3;
}

export function proposal(sys: AllySystem, a: Ally): Proposal | null {
  const pref = sys.preferredEnemyId;
  const { near, pref: seen } = sense(sys, a, pref);
  // Nothing seen and no designated enemy either — no reason to engage.
  if (!near && !seen && pref === null) {
    if (a.targetEnemyId !== null) a.targetEnemyId = null;
    return null;
  }
  // **While it can see** the enemy the PC picked, that one comes before a closer target (user's decision
  // 「PC 가 적 핑을 찍으면 요격」). While it cannot, it hits the closer target; with none either, it approaches
  // the designated enemy's last spot (`act`).
  a.targetEnemyId = seen ? seen.id : near ? near.id : pref;
  // The designation's lifetime grows **only at the moment one has it in its line of sight**
  // (`Commands.tickEnemyPing` reads this time and releases it).
  if (seen) sys.preferredEnemyUntil = sys.ctx.time + ALLY_WATCH_S;

  // An enemy ping the first time it notices one (user's decision 「감지 범위 내에 적을 발견하면 적 핑을 찍기」).
  if (near && sys.ctx.time - a.lastEnemyPingAt >= ALLY_ENEMY_PING_COOLDOWN_S) {
    a.lastEnemyPingAt = sys.ctx.time;
    Ping.place(sys, a, 'enemy', near.position, undefined, near.id);
  }
  return { state: 'combat', prio: PRIO.combat };
}

export function onEnter(sys: AllySystem, a: Ally): void {
  a.burstLeft = 0;
  a.fireCd = 0;
  a.hasCover = false;
  a.poppedOut = false;
  void sys;
}
export function onExit(sys: AllySystem, a: Ally): void {
  a.hasCover = false;
  a.poppedOut = false;
  a.lookAt = null;
  void sys;
}

/** Finds the current target (`a.targetEnemyId`) again inside the sense radius. null with none. */
function findTarget(sys: AllySystem, a: Ally): EnemyRef | null {
  const enemies = sys.ctx.enemies;
  if (!enemies || a.targetEnemyId === null) return null;
  // Props left out (the default) — an egg is never a target, so it can never be re-found as one either.
  const list = enemies.queryNear(a.position, ALLY_SENSE_RADIUS_M);
  for (const e of list) if (e.id === a.targetEnemyId && !e.isDead) return e;
  return null;
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  const target = findTarget(sys, a);
  if (!target) {
    // It has not seen the enemy the PC picked yet → it approaches the last known spot **inside the harness**
    // (2026-09-16 user's decision). Releasing the designation itself is `Commands.tickEnemyPing`'s job
    // (death · not seen for a long while · a newer ping).
    if (a.targetEnemyId !== null && a.targetEnemyId === sys.preferredEnemyId) {
      Nav.clampToHarness(sys.leaderKnown ? sys.leaderPos : a.position, sys.harness, sys.preferredEnemyPos, _v1);
      a.running = true;
      a.lookAt = null;
      Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt);
      return;
    }
    a.targetEnemyId = null;
    a.running = false;
    Nav.halt(a);
    return;
  }

  a.lookVec.set(target.position.x, target.position.y + target.height * CHEST_FRAC, target.position.z);
  a.lookAt = a.lookVec;

  const dist = a.position.distanceTo(target.position);
  const range = engageRangeOf(sys, a);
  // An enemy at contact range (inside `ALLY_ENGAGE_MIN_M`) is not asked for cover — moving to another spot, it
  // would never reach the firing branch (the header's ①).
  const contact = dist <= ALLY_ENGAGE_MIN_M;

  // The cover spot — the distance band from the threat is **this weapon's engage range** (a shotgun takes a
  // spot close to the enemy, a long gun one far off).
  if (!contact && sys.ctx.world && sys.leaderKnown) {
    a.hasCover = pickCoverSpot(sys.ctx.world, {
      from: a.position, threat: target.position, anchor: sys.leaderPos, anchorRadius: sys.harness,
      minThreatDist: PLAYER_RADIUS * 2, maxThreatDist: range,
      bodyRadius: PLAYER_RADIUS, chestHeight: PLAYER_HEIGHT * CHEST_FRAC,
      threatEyeHeight: target.height * EYE_FRAC, searchRadius: sys.harness,
    }, a.cover);
  } else a.hasCover = false;

  a.fireCd -= dt;
  a.reloadT -= dt;
  a.running = false;

  // Outside the engage range it closes in (to inside the harness).
  if (dist > range) {
    Nav.clampToHarness(sys.leaderKnown ? sys.leaderPos : a.position, sys.harness, target.position, _v1);
    a.running = true;
    Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt);
    return;
  }

  // With cover it goes to that spot and leans out only to shoot (at contact range `hasCover` is false, so it
  // shoots straight away).
  if (a.hasCover) {
    const spot = a.poppedOut && a.cover.hasPop ? a.cover.pop : a.cover.cover;
    if (dist2D(a.position, spot) > PLAYER_RADIUS) {
      Nav.step(sys, a, spot, ALLY_RUN_SPEED, dt);
      return;
    }
  }
  Nav.halt(a);
  Nav.face(a, target.position, dt);
  a.flags |= ALLY_FLAGS.AIM;

  if (a.reloadT > 0) { a.flags |= ALLY_FLAGS.RELOAD; a.poppedOut = false; return; }
  if (a.magLeft <= 0) {
    const st = a.equip.primary ? sys.ctx.loot?.getEffectiveStats(a.equip.primary) : null;
    a.reloadT = st?.reloadTime ?? 1;
    a.poppedOut = false;
    return;
  }
  if (a.burstLeft <= 0) {
    if (a.fireCd > 0) { a.poppedOut = false; return; }
    a.burstLeft = Math.round(a.rand.range(ALLY_BURST_MIN, ALLY_BURST_MAX));
  }
  a.poppedOut = true;
  if (a.fireCd > 0) return;
  if (fire(sys, a, target)) {
    a.flags |= ALLY_FLAGS.FIRE;
    a.burstLeft--;
    a.magLeft--;
    const st = a.equip.primary ? sys.ctx.loot?.getEffectiveStats(a.equip.primary) : null;
    a.fireCd = 1 / Math.max(0.1, st?.fireRate ?? 1);
    if (a.burstLeft <= 0) a.fireCd = ALLY_BURST_PAUSE_S;
  }
}

/** One round. true when it fired (with a friend on the line of fire it does not shoot). */
function fire(sys: AllySystem, a: Ally, target: EnemyRef): boolean {
  const ctx = sys.ctx;
  const st = a.equip.primary ? ctx.loot?.getEffectiveStats(a.equip.primary) : null;
  if (!st) return false;
  eyeOf(a, _eye);
  _aim.set(target.position.x, target.position.y + target.height * CHEST_FRAC, target.position.z);
  _dir.subVectors(_aim, _eye);
  const dist = _dir.length();
  if (dist < 1e-3) return false;
  _dir.multiplyScalar(1 / dist);
  // The aim error — jittered at random inside the half-angle `ALLY_AIM_ERROR_DEG`.
  const err = (ALLY_AIM_ERROR_DEG * Math.PI) / 180;
  _dir.x += a.rand.range(-err, err);
  _dir.y += a.rand.range(-err, err) * 0.5;
  _dir.z += a.rand.range(-err, err);
  _dir.normalize();

  if (blockedByFriend(sys, a, _eye, _dir, dist)) return false;

  const hit = ctx.enemies?.raycast(_eye, _dir, ALLY_FIRE_RANGE_M) ?? null;
  _v4.copy(_eye).addScaledVector(_dir, hit ? hit.distance : ALLY_FIRE_RANGE_M);
  if (hit) {
    const dmg = st.damage * ALLY_DAMAGE_MUL * damageFalloffStats(st, hit.distance);
    ctx.enemies?.applyAllyHit?.(hit.enemy.id, dmg, hit.point, _eye);
  }
  ctx.bus.emit('ally:fired', { id: a.id, from: _eye, to: _v4, weaponDefId: a.weaponDefId });
  sys.sendFire(a, _eye, _v4);
  return true;
}

/** true when the line of fire grazes the body of a person · another android. */
function blockedByFriend(sys: AllySystem, a: Ally, from: THREE.Vector3, dir: THREE.Vector3, maxDist: number): boolean {
  const ctx = sys.ctx;
  const check = (p: THREE.Vector3): boolean => {
    _v2.set(p.x, p.y + PLAYER_HEIGHT * CHEST_FRAC, p.z).sub(from);
    const along = _v2.dot(dir);
    if (along <= 0 || along > maxDist) return false;
    _v3.copy(from).addScaledVector(dir, along);
    _v3.x -= p.x; _v3.y -= p.y + PLAYER_HEIGHT * CHEST_FRAC; _v3.z -= p.z;
    return _v3.length() < PLAYER_RADIUS * 1.5;
  };
  const me = ctx.player;
  if (me && !me.isDead && check(me.position)) return true;
  for (const rp of ctx.net?.getRemotePlayers() ?? []) {
    if (rp.isDead) continue;
    if (check(rp.position)) return true;
  }
  for (const o of sys.bodies) {
    if (o === a || o.dead || o.hidden || o.mode !== 'raid') continue;
    if (check(o.position)) return true;
  }
  return false;
}

/**
 * Is there an enemy alive and awake inside the radius around `a` (the rescue safety test).
 *
 * Props stay out (the `queryNear` default) **on purpose** — this asks 「is it dangerous to get this body up here」,
 * and a nest egg is not a danger. Passing `includeProps: true` here would leave an android standing over a downed
 * player in front of a nest forever, waiting for a safety that never comes.
 */
export function enemiesNear(sys: AllySystem, at: THREE.Vector3, radius: number): boolean {
  const list = sys.ctx.enemies?.queryNear(at, radius) ?? [];
  for (const e of list) if (!e.isDead && !e.isIncapacitated) return true;
  return false;
}

/** Scratch (for the eye-height calculation, which is used outside combat too). */
export { _eye as combatEye };
