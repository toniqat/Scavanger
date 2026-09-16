/**
 * src/allies/parts/Combat.ts — **교전**. 사용자 결정 「레이더 AI 처럼 은엄폐 사용, 투척 · 가젯은 쓰지 않는다」.
 *
 * 흐름: 감지(`ALLY_SENSE_RADIUS_M` + 사선) → **적 핑**(`ALLY_ENEMY_PING_COOLDOWN_S`) → 엄폐 자리로 (`pickCoverSpot` —
 * 적 인간형과 **같은 식**, `shared/cover.ts`) → 몸을 내밀어 `ALLY_BURST_MIN..MAX` 발 → 숨어서 `ALLY_BURST_PAUSE_S`.
 * 탄창은 있고 **예비 탄약은 무한**이다 (사용자 결정). 피해는 호스트가 `ctx.enemies.applyAllyHit` 로 넣는다 (킬 크레딧 없음).
 *
 * 사선에 사람 · 다른 안드로이드가 걸리면 **쏘지 않는다** — 아군 오사는 이 게임에서 진짜 피해다.
 *
 * 2026-09-16 사용자 결정 세 가지가 여기 붙었다.
 *  ① **접근전에서는 자리를 옮기지 않는다.** 붙은 적(`ALLY_ENGAGE_MIN_M` 안)에도 `pickCoverSpot` 이 몇 m 떨어진 엄폐
 *     자리를 돌려주면 `act` 가 매 프레임 그 자리로 걸어가다 `return` 해 **사격 분기까지 오지 못한다** — 게다가 달라붙은
 *     적은 같이 움직이므로 「위협 반대편」이 프레임마다 뒤집혀 영원히 도착하지도 못한다. 그래서 붙은 적은 엄폐를 아예
 *     묻지 않고(비싼 레이도 아낀다) 그 자리에서 쏜다. 아군이 사선에 걸리면 여전히 쏘지 않는다.
 *  ② **교전 거리는 무기가 정한다** (`engageRangeOf`) — 산탄총은 붙고 장총은 물러선다.
 *  ③ **PC 가 찍은 적 핑을 우선한다** (`AllySystem.preferredEnemyId`, 해제는 `parts/Commands.tickEnemyPing`).
 *     아직 못 본 상대면 마지막으로 알려진 자리로 **하네스 안에서** 다가간다.
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

/** 눈높이 = 키의 이 비율 (사람과 같은 규약 — 균형 수치가 아니라 몸의 비례다). */
const EYE_FRAC = 0.9;
const CHEST_FRAC = 0.55;

const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** 한 번의 감지 결과 — 재사용 객체다 (매 프레임 기마다 부르므로 새로 만들지 않는다). */
const _sensed: { near: EnemyRef | null; pref: EnemyRef | null } = { near: null, pref: null };

export function eyeOf(a: Ally, out: THREE.Vector3): THREE.Vector3 {
  return out.set(a.position.x, a.position.y + PLAYER_HEIGHT * EYE_FRAC, a.position.z);
}

/**
 * 감지 반경 안을 **한 번만** 훑는다 (`queryNear` 는 배열을 만든다 — 한 프레임에 여러 번 부르지 않는다):
 * 사선이 트인 가장 가까운 적 `near`, 그리고 PC 가 찍은 적 `prefId` 가 보이면 `pref`.
 */
function sense(sys: AllySystem, a: Ally, prefId: number | null): typeof _sensed {
  _sensed.near = null;
  _sensed.pref = null;
  const enemies = sys.ctx.enemies;
  if (!enemies) return _sensed;
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

/** 감지 반경 안에서 사선이 트인 가장 가까운 적. 없으면 null. */
export function senseEnemy(sys: AllySystem, a: Ally): EnemyRef | null {
  return sense(sys, a, null).near;
}

/**
 * 지금 무기로 **붙는 거리** (m) — 사용자 결정 「falloffStart 로 하되 무기 100 % 위력이 아닌 약 50 % 위력부터 허용」.
 * 선형 감쇠(`damageFalloffStats`)의 역함수로 피해가 `ALLY_ENGAGE_DAMAGE_FRAC` 까지 떨어지는 거리를 구하고
 * `ALLY_ENGAGE_MIN_M` … `ALLY_FIRE_RANGE_M` 로 자른다. 감쇠가 없거나 끝까지 그 비율 아래로 안 떨어지는 무기는
 * `ALLY_FIRE_RANGE_M` 그대로다. **무기 def 가 바뀔 때만** 다시 잰다 (`Ally.engageDefId` — 유효 스탯 계산은 싸지 않다).
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
    // `min >= FRAC` 이면 아무리 멀어도 그 위력 아래로 떨어지지 않는다 → 거리를 줄일 이유가 없다.
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
  // 아무것도 못 봤고 지목된 적도 없으면 교전할 이유가 없다.
  if (!near && !seen && pref === null) {
    if (a.targetEnemyId !== null) a.targetEnemyId = null;
    return null;
  }
  // PC 가 찍은 적을 **보고 있으면** 더 가까운 표적보다 우선한다 (사용자 결정 「PC 가 적 핑을 찍으면 요격」).
  // 아직 못 봤으면 가까운 표적을 치되, 그것도 없으면 지목된 적의 마지막 자리로 다가간다 (`act`).
  a.targetEnemyId = seen ? seen.id : near ? near.id : pref;
  // 지목의 수명은 **사선에 넣은 순간**에만 늘어난다 (`Commands.tickEnemyPing` 이 이 시각을 보고 푼다).
  if (seen) sys.preferredEnemyUntil = sys.ctx.time + ALLY_WATCH_S;

  // 처음 알아챘으면 적 핑 (사용자 결정 「감지 범위 내에 적을 발견하면 적 핑을 찍기」).
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

/** 지금 표적 (`a.targetEnemyId`) 을 감지 반경 안에서 다시 잡는다. 없으면 null. */
function findTarget(sys: AllySystem, a: Ally): EnemyRef | null {
  const enemies = sys.ctx.enemies;
  if (!enemies || a.targetEnemyId === null) return null;
  const list = enemies.queryNear(a.position, ALLY_SENSE_RADIUS_M);
  for (const e of list) if (e.id === a.targetEnemyId && !e.isDead) return e;
  return null;
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  const target = findTarget(sys, a);
  if (!target) {
    // PC 가 찍은 적을 아직 못 봤다 → 마지막으로 알려진 자리로 **하네스 안에서** 다가간다 (2026-09-16 사용자 결정).
    // 지목 자체의 해제는 `Commands.tickEnemyPing` 이 한다 (죽음 · 오래 못 봄 · 새 핑).
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
  // 붙은 적(`ALLY_ENGAGE_MIN_M` 안)에게는 엄폐를 묻지 않는다 — 자리를 옮기다 사격 분기에 영영 닿지 못한다 (머리말 ①).
  const contact = dist <= ALLY_ENGAGE_MIN_M;

  // 엄폐 자리 — 위협과의 거리대는 **이 무기의 교전 거리**다 (산탄총은 적 가까이, 장총은 멀찍이 자리를 잡는다).
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

  // 교전 거리 밖이면 다가간다 (하네스 안쪽으로).
  if (dist > range) {
    Nav.clampToHarness(sys.leaderKnown ? sys.leaderPos : a.position, sys.harness, target.position, _v1);
    a.running = true;
    Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt);
    return;
  }

  // 엄폐가 있으면 그 자리로, 쏠 때만 몸을 내민다 (붙은 적에게는 `hasCover` 가 false 라 곧바로 쏜다).
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

/** 한 발. 쐈으면 true (사선에 아군이 걸리면 쏘지 않는다). */
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
  // 조준 오차 — 반각 `ALLY_AIM_ERROR_DEG` 안에서 무작위로 흔든다.
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

/** 사선이 사람 · 다른 안드로이드의 몸을 스치면 true. */
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

/** `a` 주변 반경 안에 살아 있고 깨어 있는 적이 있는가 (구조 안전 판정). */
export function enemiesNear(sys: AllySystem, at: THREE.Vector3, radius: number): boolean {
  const list = sys.ctx.enemies?.queryNear(at, radius) ?? [];
  for (const e of list) if (!e.isDead && !e.isIncapacitated) return true;
  return false;
}

/** 스크래치 (전투 밖에서도 쓰는 눈높이 계산용). */
export { _eye as combatEye };
