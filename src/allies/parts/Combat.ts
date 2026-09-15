/**
 * src/allies/parts/Combat.ts — **교전**. 사용자 결정 「레이더 AI 처럼 은엄폐 사용, 투척 · 가젯은 쓰지 않는다」.
 *
 * 흐름: 감지(`ALLY_SENSE_RADIUS_M` + 사선) → **적 핑**(`ALLY_ENEMY_PING_COOLDOWN_S`) → 엄폐 자리로 (`pickCoverSpot` —
 * 적 인간형과 **같은 식**, `shared/cover.ts`) → 몸을 내밀어 `ALLY_BURST_MIN..MAX` 발 → 숨어서 `ALLY_BURST_PAUSE_S`.
 * 탄창은 있고 **예비 탄약은 무한**이다 (사용자 결정). 피해는 호스트가 `ctx.enemies.applyAllyHit` 로 넣는다 (킬 크레딧 없음).
 *
 * 사선에 사람 · 다른 안드로이드가 걸리면 **쏘지 않는다** — 아군 오사는 이 게임에서 진짜 피해다.
 */
import * as THREE from 'three';
import {
  ALLY_AIM_ERROR_DEG, ALLY_BURST_MAX, ALLY_BURST_MIN, ALLY_BURST_PAUSE_S, ALLY_DAMAGE_MUL,
  ALLY_ENEMY_PING_COOLDOWN_S, ALLY_FIRE_RANGE_M, ALLY_FLAGS, ALLY_RUN_SPEED, ALLY_SENSE_RADIUS_M,
  PLAYER_HEIGHT, PLAYER_RADIUS, pickCoverSpot,
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

export function eyeOf(a: Ally, out: THREE.Vector3): THREE.Vector3 {
  return out.set(a.position.x, a.position.y + PLAYER_HEIGHT * EYE_FRAC, a.position.z);
}

/** 감지 반경 안에서 사선이 트인 가장 가까운 적. 없으면 null. */
export function senseEnemy(sys: AllySystem, a: Ally): EnemyRef | null {
  const enemies = sys.ctx.enemies;
  if (!enemies) return null;
  const list = enemies.queryNear(a.position, ALLY_SENSE_RADIUS_M);
  let best: EnemyRef | null = null;
  let bestD = Infinity;
  eyeOf(a, _eye);
  for (const e of list) {
    if (e.isDead) continue;
    const d = a.position.distanceTo(e.position);
    if (d >= bestD) continue;
    if (!hasLineOfSight(sys, _eye, e)) continue;
    best = e; bestD = d;
  }
  return best;
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
  const e = senseEnemy(sys, a);
  if (!e) {
    if (a.targetEnemyId !== null) a.targetEnemyId = null;
    return null;
  }
  // 분대장이 적 핑을 찍었으면 그 대상을 우선한다 (`Commands.preferredEnemy`).
  const pref = sys.preferredEnemyId;
  if (pref !== null) {
    const list = sys.ctx.enemies?.queryNear(a.position, ALLY_SENSE_RADIUS_M) ?? [];
    const target = list.find((x) => x.id === pref && !x.isDead);
    a.targetEnemyId = target ? target.id : e.id;
  } else a.targetEnemyId = e.id;

  // 처음 알아챘으면 적 핑 (사용자 결정 「감지 범위 내에 적을 발견하면 적 핑을 찍기」).
  if (sys.ctx.time - a.lastEnemyPingAt >= ALLY_ENEMY_PING_COOLDOWN_S) {
    a.lastEnemyPingAt = sys.ctx.time;
    Ping.place(sys, a, 'enemy', e.position, undefined, e.id);
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

export function act(sys: AllySystem, a: Ally, dt: number): void {
  const enemies = sys.ctx.enemies;
  const target = enemies && a.targetEnemyId !== null
    ? enemies.queryNear(a.position, ALLY_SENSE_RADIUS_M).find((e) => e.id === a.targetEnemyId && !e.isDead) ?? null
    : null;
  if (!target) { a.targetEnemyId = null; Nav.halt(a); return; }

  a.lookVec.set(target.position.x, target.position.y + target.height * CHEST_FRAC, target.position.z);
  a.lookAt = a.lookVec;

  // 엄폐 자리 — 본문은 enemies 가 채운다 (계약 커밋에서는 늘 false → 그 자리에서 웅크리고 싸운다).
  if (sys.ctx.world && sys.leaderKnown) {
    a.hasCover = pickCoverSpot(sys.ctx.world, {
      from: a.position, threat: target.position, anchor: sys.leaderPos, anchorRadius: sys.harness,
      minThreatDist: PLAYER_RADIUS * 2, maxThreatDist: ALLY_FIRE_RANGE_M,
      bodyRadius: PLAYER_RADIUS, chestHeight: PLAYER_HEIGHT * CHEST_FRAC,
      threatEyeHeight: target.height * EYE_FRAC, searchRadius: sys.harness,
    }, a.cover);
  } else a.hasCover = false;

  const dist = a.position.distanceTo(target.position);
  a.fireCd -= dt;
  a.reloadT -= dt;
  a.running = false;

  // 사거리 밖이면 다가간다 (하네스 안쪽으로).
  if (dist > ALLY_FIRE_RANGE_M) {
    Nav.clampToHarness(sys.leaderKnown ? sys.leaderPos : a.position, sys.harness, target.position, _v1);
    a.running = true;
    Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt);
    return;
  }

  // 엄폐가 있으면 그 자리로, 쏠 때만 몸을 내민다.
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
