import * as THREE from 'three';
import {
  BEHEMOTH_CHARGE_DAMAGE, BEHEMOTH_CHARGE_SPEED, BEHEMOTH_WINDUP, ENEMY_FIRE_STRAFE_S, PLAYER_RADIUS, SHELL_FLIGHT_TIME, TOXIC_TRIGGER_DIST,
} from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { ARTILLERY_AI, BEHEMOTH_AI, TOXIC_AI } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';
import { lookAtTarget, startMelee, stumble, type AttackResult } from './Common';
import { shellArcBlocked } from '../parts/Attacks';

/* ────────────────────────────────────────────────────────────────────────────
 * Phase 4 bug gimmicks: artillery (stand-off mortar), toxic (suicide runner), behemoth (line charge).
 * Called from EnemyAI's chase / attack dispatch; movement still goes through EnemyAI.integrate.
 * ──────────────────────────────────────────────────────────────────────────── */

const _knock = new THREE.Vector3();
const _side = new THREE.Vector3();

/** 궤적이 막힌 포병이 옆으로 옮겨 가는 거리(m) — 후보는 이것의 1 · 2 배. 그림/알고리즘 상수라 csv 대상이 아니다. */
const ARTILLERY_RELOCATE_M = 7;
/** 2026-09-11 (C-24): 표적 쪽 · 오르막 후보까지의 거리(m). 알고리즘 상수. */
const ARTILLERY_PROBE_FORWARD_M = 10;
/** 후보 자리가 이보다 장애물로 덮여 있으면(`obstacleCoverage`) 서지 않는다 — 바위 한가운데를 고르지 않게. */
const ARTILLERY_PROBE_MAX_COVERAGE = 0.25;
const _aimT = new THREE.Vector3();
const _from = new THREE.Vector3();
const _uphill = new THREE.Vector3();

/* ── artillery ──────────────────────────────────────────────────────────── */
/**
 * Keeps ARTILLERY_RANGE from its target: retreats inside `ARTILLERY_AI.retreatDist`, closes in beyond `approachDist`,
 * otherwise digs in and lobs a shell every `fireMin`–`fireMax` s at targets within `maxRange`. Never melees.
 * (2026-09-09: 42 / 88 / 98 m — the whole envelope shrank 30 % with `ARTILLERY_RANGE` 90 → 63.)
 */
export function chaseArtillery(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  const s = e.stats;
  const a = e.anim;
  const d = e.distToTarget;
  const tp = t.position;
  e.facePoint.copy(tp); e.hasFacePoint = true;
  lookAtTarget(e, t, dt);
  if (d < ARTILLERY_AI.retreatDist) {
    const dx = e.position.x - tp.x, dz = e.position.z - tp.z;
    const inv = 1 / Math.max(1e-3, d);
    e.moveTarget.set(e.position.x + dx * inv * 15, 0, e.position.z + dz * inv * 15);
    e.hasMoveTarget = true;
    e.hasFacePoint = false;                 // run away facing the way it goes
    e.dug = Math.max(0, e.dug - dt * 2);
    a.crouch = e.dug * 0.8;
    return s.speed;
  }
  if (d > ARTILLERY_AI.approachDist) {
    e.moveTarget.copy(tp); e.hasMoveTarget = true;
    e.dug = Math.max(0, e.dug - dt * 2);
    a.crouch = e.dug * 0.8;
    return s.speed * 0.8;
  }
  /*
   * 2026-09-10 (낮은 궤적): 궤적이 막혀 발사가 거절된 뒤 자리를 옮기는 중. 정점이 9.9 m 로 내려온 만큼
   * 언덕 · 나무 · 폐허 벽 뒤에서는 제 발치에 떨어지므로, 같은 자리에서 6~9초마다 자살하게 두지 않고
   * 굴착을 풀고 옆으로 걸어간 뒤 다시 판다. **조준만 하고 굳어 있지 않는다.**
   */
  if (e.fireBlockTimer > 0) {
    e.fireBlockTimer -= dt;
    // 2026-09-11 (C-24): 고른 자리에 닿으면 바로 다시 판다 (걷는 시간은 거리에서 나온다 — `artilleryRelocate`)
    // `chase()` 가 매 프레임 moveTarget 을 표적으로 덮으므로 거절 시점에 적어 둔 자리(`shellSpot`)를 다시 싣는다
    e.moveTarget.copy(e.shellSpot);
    if (Math.hypot(e.shellSpot.x - e.position.x, e.shellSpot.z - e.position.z) < 1) e.fireBlockTimer = 0;
    e.hasMoveTarget = true;
    e.hasFacePoint = false;
    e.dug = Math.max(0, e.dug - dt * 2);
    a.crouch = e.dug * 0.8;
    return s.speed * 0.9;
  }
  // hold position: dig in, then fire on the timer
  e.hasMoveTarget = false;
  e.dug = Math.min(1, e.dug + dt / ARTILLERY_AI.digTime);
  a.crouch = e.dug * 0.8;
  a.mandible = 0.4;
  e.shellTimer -= dt;
  if (e.shellTimer <= 0) {
    if (e.dug >= 0.95 && d <= ARTILLERY_AI.maxRange && !t.isDeadOrDowned) {
      if (host.fireShell(e, t)) {
        e.shellRefusals = 0;
        a.recoil = 1;
        a.flinch = Math.max(a.flinch, 0.6); a.flinchZ = -0.6; a.flinchX = 0;   // rear squat on fire
        e.shellTimer = ARTILLERY_AI.fireMin + Math.random() * (ARTILLERY_AI.fireMax - ARTILLERY_AI.fireMin);
      } else artilleryRelocate(e, host, t);
    } else e.shellTimer = 0.5;
  }
  return 0;
}

/** Relocation probes relative to the target line: [along n (toward the target), along p (perpendicular)] in m. */
const ARTILLERY_PROBES: ReadonlyArray<readonly [number, number]> = [
  [0, ARTILLERY_RELOCATE_M], [0, -ARTILLERY_RELOCATE_M],
  [ARTILLERY_PROBE_FORWARD_M, 0],
  [0, ARTILLERY_RELOCATE_M * 2], [0, -ARTILLERY_RELOCATE_M * 2],
  [ARTILLERY_PROBE_FORWARD_M, ARTILLERY_RELOCATE_M], [ARTILLERY_PROBE_FORWARD_M, -ARTILLERY_RELOCATE_M],
];

/**
 * 궤적이 막혀 발사가 거절됐다 (2026-09-11 C-24 · X-4 개정). 굴착을 풀고 **뚫린 자리를 사전 검사로 찾아** 옮긴 뒤 다시 판다.
 *
 * 예전(2026-09-10)에는 표적 수직으로 7 m 옮기되 방향을 **매번 뒤집어**, 1.5 s 걷는 동안 ≈3.5 m 만 가고 두 자리를 영원히
 * 왕복했다(X-4 핑퐁). 이제 후보 7곳(좌우 7 · 14 m, 표적 쪽 10 m, 그 둘의 조합) + 오르막 한 곳을 `shellArcBlocked` 로
 * 미리 검사하고(거절 1회당 레이 ≤ 32 — 발사 주기에만 돈다, 핫 패스 아님) 뚫린 곳 중 **가장 가까운** 곳으로 간다.
 * 부호 교대는 없다. 뚫린 곳이 없으면 표적 쪽으로 다가간다(후퇴 거리까지). 연속 `ARTILLERY_AI.maxRefusals` 번 거절되면
 * 다른 표적으로 바꾸고 `refusalCooldown` 동안 쏘지 않는다. 높은 궤적 · 능선 폭발은 넣지 않는다 (2026-09-10 "화면 안" 결정).
 */
function artilleryRelocate(e: Enemy, host: EnemyHost, t: CombatTarget): void {
  const world = host.ctx.world!;
  e.dug = 0;
  e.shellRefusals++;
  e.fireBlockTimer = ENEMY_FIRE_STRAFE_S;
  // the shell timer only runs while dug in (`chaseArtillery`), so it waits for the re-dig, not for the walk
  e.shellTimer = ARTILLERY_AI.digTime + 0.2;
  if (e.shellRefusals >= ARTILLERY_AI.maxRefusals) {
    e.shellRefusals = 0;
    e.shellTimer = Math.max(e.shellTimer, ARTILLERY_AI.refusalCooldown);
    const other = otherTargetInRange(e, host, t);
    if (other) { e.target = other; e.targetTimer = ARTILLERY_AI.refusalCooldown; e.distToTarget = other.dist2D(e.position); }
  }
  const tp = (e.target ?? t).position;   // after a retarget the new spot is searched against the new target
  const dx = tp.x - e.position.x, dz = tp.z - e.position.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) { e.fireBlockTimer = 0; return; }
  const nx = dx / l, nz = dz / l;
  _aimT.set(tp.x, world.getHeightAt(tp.x, tp.z), tp.z);
  let bestD = Infinity, bx = 0, bz = 0;
  const probe = (cx: number, cz: number): void => {
    if (!world.isInsideBounds(cx, cz)) return;
    const walk = Math.hypot(cx - e.position.x, cz - e.position.z);
    if (walk >= bestD) return;
    const td = Math.hypot(tp.x - cx, tp.z - cz);
    if (td < ARTILLERY_AI.retreatDist || td > ARTILLERY_AI.maxRange) return;
    if (world.obstacleCoverage(cx, cz, e.stats.radius) > ARTILLERY_PROBE_MAX_COVERAGE) return;
    _from.set(cx, world.getHeightAt(cx, cz) + e.stats.height * 0.95, cz);
    if (shellArcBlocked(world, _from, _aimT, SHELL_FLIGHT_TIME)) return;
    bestD = walk; bx = cx; bz = cz;
  };
  for (let i = 0; i < ARTILLERY_PROBES.length; i++) {
    const [along, side] = ARTILLERY_PROBES[i];
    probe(e.position.x + nx * along - nz * side, e.position.z + nz * along + nx * side);
  }
  // uphill: the terrain normal's horizontal part points downhill — a higher spot clears a ridge in front
  world.getNormalAt(e.position.x, e.position.z, _uphill);
  const hl = Math.hypot(_uphill.x, _uphill.z);
  if (hl > 0.05) probe(e.position.x - _uphill.x / hl * ARTILLERY_PROBE_FORWARD_M, e.position.z - _uphill.z / hl * ARTILLERY_PROBE_FORWARD_M);
  if (bestD < Infinity) { e.shellSpot.set(bx, 0, bz); walkFor(e, bestD); return; }
  // nothing clear nearby: close in on the target (never inside the retreat distance)
  const step = Math.min(ARTILLERY_PROBE_FORWARD_M * 1.5, l - ARTILLERY_AI.retreatDist - 2);
  if (step > 2) { e.shellSpot.set(e.position.x + nx * step, 0, e.position.z + nz * step); walkFor(e, step); }
  else e.fireBlockTimer = 0;   // nowhere to go — dig in again where it stands (the refusal cap handles the rest)
}

/**
 * Walk long enough to actually reach a spot `dist` m away (the 2026-09-10 fixed `ENEMY_FIRE_STRAFE_S` covered ≈3.5 m of a
 * 7 m leg — half of X-4); arriving early ends the walk (`chaseArtillery`), then it digs in again.
 */
function walkFor(e: Enemy, dist: number): void {
  e.fireBlockTimer = Math.min(8, Math.max(ENEMY_FIRE_STRAFE_S, dist / Math.max(0.5, e.stats.speed * 0.9) + 0.4));
}

/** Nearest alive player other than `cur` within `ARTILLERY_AI.maxRange` (the refusal cap's new target), or null. */
function otherTargetInRange(e: Enemy, host: EnemyHost, cur: CombatTarget): CombatTarget | null {
  const list = host.targets.alive;
  let best: CombatTarget | null = null, bestD = ARTILLERY_AI.maxRange;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === cur) continue;
    const dd = c.dist2D(e.position);
    if (dd < bestD) { bestD = dd; best = c; }
  }
  return best;
}

/* ── toxic ──────────────────────────────────────────────────────────────── */
/** Fast straight runner; swells when within TOXIC_TRIGGER_DIST of any target (its own or another alive player). */
export function chaseToxic(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  const s = e.stats;
  const d = e.distToTarget;
  const tp = t.position;
  e.moveTarget.copy(tp); e.hasMoveTarget = true;
  lookAtTarget(e, t, dt);
  if (d > 3) {
    const w = Math.sin(e.anim.time * 3.1 + e.id) * Math.min(1.5, d * 0.1);
    const dx = tp.x - e.position.x, dz = tp.z - e.position.z;
    e.moveTarget.x += -dz / d * w; e.moveTarget.z += dx / d * w;
  }
  const reach = TOXIC_TRIGGER_DIST + e.stats.radius;
  if (d < reach + t.bodyRadius || host.targets.nearestAliveWithin(e.position, reach + PLAYER_RADIUS)) startSwell(e, host);
  return s.speed;
}

function startSwell(e: Enemy, host: EnemyHost): void {
  e.state = 'attack'; e.stateTime = 0; e.attackTimer = 0;
  e.toxicPhase = 1; e.swellTimer = 0;
  e.hasMoveTarget = false;
  host.playAudio('bug_screech', e.position, 0.7, 1.5);
}

/** Swell for TOXIC_AI.swell seconds (hint 9), then burst: `kill(false)` → EnemySystem.onEnemyKilled applies the blast. */
export function attackToxic(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, r: AttackResult): AttackResult {
  const a = e.anim;
  r.speed = 0; r.allowOverlap = false; r.mandible = 1;
  if (t) { e.facePoint.copy(t.position); e.hasFacePoint = true; lookAtTarget(e, t, dt); }
  e.swellTimer += dt;
  a.abdomen = Math.min(1, e.swellTimer / TOXIC_AI.swell);
  a.crouch = a.abdomen * 0.25;
  if (e.swellTimer >= TOXIC_AI.swell) {
    e.toxicPhase = 2;
    e.kill(false);
  }
  void host;
  return r;
}

/* ── behemoth ───────────────────────────────────────────────────────────── */
/** Approach to ~18 m, then wind up and line-charge; melee like a warrior when the charge is cooling down. */
export function chaseBehemoth(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  const s = e.stats;
  const d = e.distToTarget;
  const meleeRange = s.attackRange + PLAYER_RADIUS;
  lookAtTarget(e, t, dt);
  e.moveTarget.copy(t.position); e.hasMoveTarget = true;
  if (d < meleeRange && e.attackCd <= 0) { startMelee(e); return 0; }
  // 2026-09-11 (C-47): 떠 있는 공중 드론 **밑으로는** 돌진하지 않는다 — 몸이 닿지 않는 표적을 향한 돌진은 헛돌기만 한다
  if (d <= BEHEMOTH_AI.engageDist + 4 && d > meleeRange * 0.8 && e.chargeCd <= 0 && e.hasLOS && canBodyReach(e, t)) { startCharge(e, host); return 0; }
  if (d > BEHEMOTH_AI.engageDist) return s.speed;
  return s.speed * 0.6;   // lumber while the charge cools down
}

function startCharge(e: Enemy, host: EnemyHost): void {
  e.state = 'attack'; e.stateTime = 0;
  e.attackTimer = 0; e.attackHitDone = false;
  e.chargePhase = 1; e.chargeTimer = 0;
  e.hasMoveTarget = false;
  e.chargeVictims.length = 0;
  e.chargeDrones.length = 0;
  host.playAudio('bug_screech', e.position, 1.0, 0.35);
}

const _tp = new THREE.Vector3();

/**
 * 2026-09-11 (C-47): can the charging body touch `t` at all? A target whose underside floats above the behemoth's height
 * (a hovering air drone) is out of reach — same rule as `ai/named/Hammer.canReachVertically`. Players / enemies /
 * ground drones always pass.
 */
function canBodyReach(e: Enemy, t: CombatTarget): boolean {
  const bottom = t.position.y - e.position.y;
  return bottom <= e.stats.height && bottom + t.bodyHeight >= -e.stats.height * 0.5;
}

export function attackBehemoth(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, r: AttackResult): AttackResult {
  const a = e.anim;
  const tp = t ? t.position : e.position;
  r.speed = 0; r.allowOverlap = false; r.mandible = 1;

  if (e.chargePhase === 1) {
    e.facePoint.copy(tp); e.hasFacePoint = true;
    if (t) lookAtTarget(e, t, dt);
    a.shake = Math.min(1, e.attackTimer / BEHEMOTH_WINDUP);
    a.crouch = a.shake * 0.3;
    if (e.attackTimer >= BEHEMOTH_WINDUP) {
      e.chargePhase = 2; e.chargeTimer = 0; e.chargeSeq++;
      e.chargeDir.set(tp.x - e.position.x, 0, tp.z - e.position.z);
      if (e.chargeDir.lengthSq() < 1e-4) e.facing(e.chargeDir); else e.chargeDir.normalize();
      e.yaw = Math.atan2(e.chargeDir.x, e.chargeDir.z);
      e.chargeEnd.copy(tp).addScaledVector(e.chargeDir, BEHEMOTH_AI.overshoot);
      a.shake = 0; a.crouch = 0;
      host.playAudio('bug_attack', e.position, 1.0, 0.4);
      _tp.copy(tp);
      host.onChargeStarted(e, _tp);
    }
    return r;
  }

  // rushing along a straight line
  e.chargeTimer += dt;
  r.allowOverlap = true; r.speed = BEHEMOTH_CHARGE_SPEED;
  e.velocity.set(e.chargeDir.x * BEHEMOTH_CHARGE_SPEED, 0, e.chargeDir.z * BEHEMOTH_CHARGE_SPEED);
  e.hasFacePoint = false; e.hasMoveTarget = false;
  a.headYaw = THREE.MathUtils.lerp(a.headYaw, 0, dt * 6);
  a.headPitch = THREE.MathUtils.lerp(a.headPitch, -0.2, dt * 6);
  const stamp = e.id * 1000 + e.chargeSeq;
  const pos = e.position;

  // players in the path (each once per charge): damage + sideways shove
  const players = host.targets.alive;
  const hitR = e.stats.radius + PLAYER_RADIUS + 0.4;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (e.chargeVictims.indexOf(p.id) >= 0) continue;
    if (p.dist2D(pos) >= hitR) continue;
    e.chargeVictims.push(p.id);
    const side = Math.sign(e.chargeDir.z * (p.position.x - pos.x) - e.chargeDir.x * (p.position.z - pos.z)) || 1;
    _knock.set(e.chargeDir.z * side, 0.35, -e.chargeDir.x * side).addScaledVector(e.chargeDir, 0.45).normalize();
    host.chargeHit(e, p, BEHEMOTH_CHARGE_DAMAGE, _knock);
  }
  // 2026-09-11 (C-47): 노려도 되는 드론도 들이받는다 — 몸이 수직으로 겹칠 때만(떠 있는 공중 드론 밑은 지나간다).
  // 드론 프록시의 id 는 전부 'ai' 라 한 돌진에 한 번은 `droneId` 로 가린다. 피해는 `applyDamage` 의 드론 가지 → `damageDrone`.
  const drones = host.targets.drones;
  for (let i = 0; i < drones.length; i++) {
    const dr = drones[i];
    if (dr.isDeadOrDowned || dr.droneId === null || e.chargeDrones.indexOf(dr.droneId) >= 0) continue;
    if (dr.dist2D(pos) >= e.stats.radius + dr.bodyRadius + 0.4) continue;
    if (dr.position.y > pos.y + e.stats.height || dr.position.y + dr.bodyHeight < pos.y - 0.5) continue;
    e.chargeDrones.push(dr.droneId);
    _knock.copy(e.chargeDir);
    host.chargeHit(e, dr, BEHEMOTH_CHARGE_DAMAGE, _knock);
  }
  // enemies of either faction in the path: heavy damage + shove
  const active = host.active;
  for (let i = 0; i < active.length; i++) {
    const o = active[i];
    if (o === e || !o.isCombatant || o.hitByCharge === stamp) continue;
    const reach = e.stats.radius + o.stats.radius * 0.8;
    const dx = o.position.x - pos.x, dz = o.position.z - pos.z;
    if (dx * dx + dz * dz >= reach * reach) continue;
    o.hitByCharge = stamp;
    const side = Math.sign(e.chargeDir.z * dx - e.chargeDir.x * dz) || 1;
    _side.set(e.chargeDir.z * side, 0, -e.chargeDir.x * side);
    o.takeDamage(BEHEMOTH_AI.enemyDamage, undefined, undefined, 'ai');
    if (o.isCombatant) {
      o.velocity.addScaledVector(_side, BEHEMOTH_AI.enemyShove);
      if (o.type !== 'behemoth' && !o.airborne) o.enterStagger(0.8);
    }
  }
  // past the end point / too long → stagger out of the charge
  const passed = (e.chargeEnd.x - pos.x) * e.chargeDir.x + (e.chargeEnd.z - pos.z) * e.chargeDir.z;
  if ((passed < 0 && e.chargeTimer > 0.3) || e.chargeTimer > BEHEMOTH_AI.maxDuration) {
    stumble(e, BEHEMOTH_AI.chargeCooldown, BEHEMOTH_AI.stumble);
  }
  return r;
}
