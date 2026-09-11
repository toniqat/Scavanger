/**
 * src/enemies/ai/named/Hammer.ts — **타길라** (`rogue_hammer`, 2026-09-11).
 *
 * 망치 근접 보스. 붙으면 초당 50 (`data/enemies.csv` 의 attackDamage 50 / attackCooldown 1), 체력은 일반 로그 × 10.
 * 엄폐 사이클이 없다 — 표적이 생기면 곧장 달려들고, `chargeDist` 안에서 길이 트였으면 짧게 돌진해 간격을 닫는다.
 *
 * 상태 (`Enemy.state` + `namedPhase`):
 *  - idle / wander   : 스폰 구조물(`guardPos`) 둘레 `patrolRadius` 순찰. wander + phase 3 = 구조물로 돌아가는 중.
 *  - alert           : `ROGUE_REACTION` 동안 돌아선다.
 *  - chase  phase 0  : 추격. 사거리 안 → 휘두르기, 돌진 조건 → phase 2. 길을 막은 설치물은 부순다.
 *  - chase  phase 2  : 돌진 (힌트 17, `chargeSpeed`). `Enemy.chargePhase = 2` 를 빌려 `integrate` 의 직선 이동과
 *                      "장애물에 부딪히면 `stumble`" 을 그대로 쓴다 (벽 · 바위 · 배리어에 막히면 멈칫).
 *  - attack phase 1  : 휘두르기 준비 (힌트 16, `windup`). 끝나는 순간 한 번 내려친다.
 *  - attack phase 4  : 내려친 망치를 들어 올리는 짧은 회복.
 *  - stagger         : 돌진이 막혔을 때 · 전소.
 *
 * 타격 주기: 내려친 순간 `attackCd = attackCooldown − windup` 을 건다. 다음 준비가 끝나는 시각이 정확히
 * `attackCooldown` 뒤이므로, 붙어 있으면 초당 `attackDamage / attackCooldown` 이다.
 *
 * 호스트에서만 돈다. 타격마다 `ee hammer {id, p}` 를 보내고 리플리카는 `onHammerEvent` 로 연출만 재생한다.
 * 자세는 `models/named/HammerLook` 이 `namedHint`(16 들어 올림 · 17 돌진) + `anim.recoil`(내려찍기)로 그린다.
 */
import * as THREE from 'three';
import { PLAYER_RADIUS, ROGUE_REACTION, type DeployableRef, type EnemyEvent, type GameContext } from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import type { Enemy, EnemyHost } from '../../Enemy';
import { NAMED_HAMMER } from '../../EnemyTypes';
import type { CombatTarget, TargetList } from '../../Targets';
import type { ReplicaHost } from '../../net/Replica';
import { tuple } from '../../net/HostSync';
import { HAMMER_HINT_CHARGE, HAMMER_HINT_WINDUP, HAMMER_IMPACT_FORWARD } from '../../models/named/HammerLook';
import { lookAtTarget } from '../Common';
import { integrate } from '../EnemyAI';
import { STRUCT_DAMAGE_MUL } from '../Structures';

/* ── 상태 번호 (`Enemy.namedPhase`, 이 파일 전용) ── */
const PHASE_CHASE = 0;
const PHASE_WINDUP = 1;
const PHASE_CHARGE = 2;
const PHASE_RETURN = 3;
const PHASE_RECOVER = 4;

/* ── 그림 / 알고리즘 상수 (밸런스 수치는 csv — `NAMED_HAMMER` · `enemies.csv`) ── */
const TWO_PI = Math.PI * 2;
/** 내려친 뒤 망치를 들어 올리는 동안 서 있는 시간(s). 타격 주기(`attackCooldown`)에는 영향이 없다. */
const RECOVER_S = 0.25;
/** 준비 중 표적 쪽으로 밀고 들어가는 속도 배수 — 뒷걸음질 한 번으로 준비 동작을 공짜로 피하지 못하게. */
const WINDUP_CREEP = 0.55;
/** 내려치는 순간의 사거리 여유(m): 준비를 시작한 거리 + 이만큼 안이면 맞는다. */
const STRIKE_GRACE = 0.6;
/** 정면 판정 cos (≈ 70°). 옆/뒤로 돌아간 표적은 헛친다. `CLOSE_ALWAYS` m 안(몸에 붙음)은 방향과 무관하게 맞는다. */
const FRONT_COS = 0.34;
const CLOSE_ALWAYS = 1.1;
/** 준비 사거리 밖으로 이만큼은 떨어져 있어야 돌진한다 — 코앞에서 돌진하지 않는다. */
const CHARGE_MIN_GAP = 2;
/** 돌진 길이 막혀 있었을 때 다시 볼 때까지(s) — 매 프레임 레이캐스트를 쏘지 않는다. */
const CHARGE_RETRY_S = 0.6;
/** 돌진 길을 재는 높이(m, 무릎) — 낮은 턱 · 바리케이드도 걸린다. */
const CHARGE_LANE_Y = 0.6;
/** 돌진 중 표적을 따라 꺾는 속도(rad/s) — 옆걸음 한 번에 헛돌진하지는 않되 피할 수는 있을 만큼. */
const CHARGE_TURN = 1.1;
/** 돌진 최대 시간 = chargeDist / chargeSpeed × 이 배수. */
const CHARGE_TIME_MUL = 1.6;
/** 이 거리(m) 안에서만 표적을 정면으로 본다 — 멀리서는 걸음 방향을 봐야 장애물을 도는 모습이 자연스럽다. */
const FACE_DIST = 9;
/** 순찰 중 guardPos 에서 patrolRadius × 이 배수보다 멀면 돌아간다. */
const HOME_MUL = 1.6;
/** 돌아가는 걸음 = 추격 속도 × 이 배수 · 도착 반경(m) · 한 다리 최대 시간(s). */
const RETURN_SPEED = 0.7;
const RETURN_ARRIVE = 3;
const RETURN_TIMEOUT = 40;
/** 맞은 표적의 화면 흔들림 · 주변 흔들림 반경(m) · 그 최대 세기. */
const HIT_SHAKE = 0.6;
const SHAKE_RADIUS = 16;
const SHAKE_MAX = 0.4;
const DUST_COLOR = 0x8a7a64;
const DEBRIS_COLOR = 0x3a332c;

const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** `Enemy.namedData` of a `rogue_hammer` — 스폰마다 한 번 만든다 (프레임당 할당 없음). */
interface HammerData {
  kind: 'hammer';
  /** 표적이 `giveUpDist` 밖에서 안 보인 채로 지난 시간(s). */
  lost: number;
}

function hammerData(e: Enemy): HammerData {
  const d = e.namedData as HammerData | null;
  if (d && d.kind === 'hammer') return d;
  const n: HammerData = { kind: 'hammer', lost: 0 };
  e.namedData = n;
  return n;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 호스트 AI
 * ──────────────────────────────────────────────────────────────────────────── */

export function updateHammer(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, targetAlive: boolean): void {
  const world = host.ctx.world!;
  const s = e.stats;
  const a = e.anim;
  const data = hammerData(e);
  if (e.namedCooldown > 0) e.namedCooldown -= dt;

  // 싸울 상대가 없다 → 진정 (준비 · 돌진 중이던 것도 버린다)
  if (!targetAlive && e.aware && (e.state === 'chase' || e.state === 'alert' || e.state === 'attack')) {
    clearAction(e);
    e.aware = false; e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1.5;
  }

  // 리시: 표적이 giveUpDist 밖에서 giveUpTime 동안 안 보이면 구조물로 돌아간다 (돌진 · 경직 중에는 세지 않는다)
  if (e.aware && targetAlive && e.state !== 'stagger' && e.namedPhase !== PHASE_CHARGE) {
    if (!e.hasLOS && e.distToTarget > NAMED_HAMMER.giveUpDist) {
      data.lost += dt;
      if (data.lost >= NAMED_HAMMER.giveUpTime) goHome(e, data);
    } else data.lost = 0;
  } else if (!e.aware) data.lost = 0;

  let speed = 0;
  let crouchT = 0;
  e.hasMoveTarget = false;
  e.hasFacePoint = false;

  switch (e.state) {
    case 'idle': {
      clearAction(e);
      e.wanderTimer -= dt;
      a.headYaw = THREE.MathUtils.lerp(a.headYaw, Math.sin(a.time * 0.5) * 0.5, Math.min(1, dt * 2));
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0, Math.min(1, dt * 3));
      const r = NAMED_HAMMER.patrolRadius;
      const hx = e.guardPos.x - e.position.x, hz = e.guardPos.z - e.position.z;
      if (hx * hx + hz * hz > (r * HOME_MUL) * (r * HOME_MUL)) { startReturn(e); break; }
      if (e.wanderTimer <= 0) {
        const ang = Math.random() * TWO_PI;
        const rad = r * (0.35 + Math.random() * 0.65);
        e.moveTarget.set(e.guardPos.x + Math.cos(ang) * rad, 0, e.guardPos.z + Math.sin(ang) * rad);
        if (!world.isInsideBounds(e.moveTarget.x, e.moveTarget.z)) e.moveTarget.copy(e.guardPos);
        e.state = 'wander'; e.stateTime = 0;
      }
      break;
    }
    case 'wander': {
      e.hasMoveTarget = true;
      const returning = e.namedPhase === PHASE_RETURN;
      if (returning) e.moveTarget.copy(e.guardPos);
      speed = returning ? s.speed * RETURN_SPEED : s.wanderSpeed;
      const dx = e.moveTarget.x - e.position.x, dz = e.moveTarget.z - e.position.z;
      const arrive = returning ? RETURN_ARRIVE * RETURN_ARRIVE : 0.6;
      if (dx * dx + dz * dz < arrive || e.stateTime > (returning ? RETURN_TIMEOUT : 8)) {
        e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 2 + Math.random() * 4; e.namedPhase = PHASE_CHASE;
      }
      break;
    }
    case 'alert': {
      clearAction(e);
      if (targetAlive) { e.facePoint.copy(t!.position); e.hasFacePoint = true; lookAtTarget(e, t!, dt); }
      crouchT = 0.2;
      if (e.stateTime >= ROGUE_REACTION) { e.state = 'chase'; e.stateTime = 0; }
      break;
    }
    case 'chase': {
      if (!targetAlive) { clearAction(e); e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1; break; }
      speed = e.namedPhase === PHASE_CHARGE ? charge(e, dt, host, t!) : chase(e, dt, host, t!);
      break;
    }
    case 'attack': {
      speed = swing(e, dt, host, t, targetAlive);
      crouchT = e.namedPhase === PHASE_RECOVER ? 0.3 : 0.1;
      break;
    }
    case 'stagger': {
      clearAction(e);
      e.staggerTimer -= dt;
      if (e.incapTimer > 0) {
        e.incapTimer = Math.max(0, e.incapTimer - dt);
        crouchT = 0.35;
      } else {
        crouchT = 0.5;
        a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.3, Math.min(1, dt * 6));
      }
      if (e.staggerTimer <= 0 && e.incapTimer <= 0) {
        e.incapTimer = 0;
        e.state = e.aware && targetAlive ? 'chase' : 'idle';
        e.stateTime = 0; e.wanderTimer = 1;
      }
      break;
    }
    default: break;
  }

  if (e.slowFactor < 1) speed *= e.slowFactor;
  a.aim += (0 - a.aim) * Math.min(1, dt * 6);          // 소총이 없다 — 조준 자세를 쓰지 않는다
  a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 7);
  a.shake = Math.max(0, a.shake - dt * 4);
  integrate(e, dt, world, host, speed, false);
  // 돌진이 벽 · 바위 · 배리어에 막히면 `integrate` 가 `stumble` 로 경직에 넣는다 — 돌진 상태를 같이 버린다
  if (e.state === 'stagger' && e.namedPhase !== PHASE_CHASE) clearAction(e);
}

/** 준비 · 돌진 · 복귀 표시를 전부 내린다 (`namedHint` 0 → 와이어도 기본 로그 힌트로 돌아간다). */
function clearAction(e: Enemy): void {
  e.namedPhase = PHASE_CHASE;
  e.namedTimer = 0;
  e.namedHint = 0;
  e.chargePhase = 0;
  e.structAttack = false;
}

function startReturn(e: Enemy): void {
  e.state = 'wander'; e.stateTime = 0;
  e.namedPhase = PHASE_RETURN;
  e.moveTarget.copy(e.guardPos); e.hasMoveTarget = true;
}

function goHome(e: Enemy, data: HammerData): void {
  clearAction(e);
  e.aware = false;
  e.lostTimer = 0;
  data.lost = 0;
  startReturn(e);
}

/** 준비를 시작하는 중심 간 거리 — 큰 표적(베헤모스 등)은 그 몸 반경만큼 더 멀리서 친다. */
function strikeRange(e: Enemy, t: CombatTarget): number {
  return e.stats.attackRange + Math.max(0, t.bodyRadius - PLAYER_RADIUS);
}

/**
 * 2026-09-11 (드론 표적): 망치가 **위아래로도** 닿는가. 표적 몸의 밑면이 제 키(`stats.height`)보다 높이 떠 있으면
 * (떠 있는 공중 드론) 휘두르지도 · 돌진하지도 · 맞히지도 않는다. 플레이어 · 적 · 지상 드론은 늘 참이다.
 */
function canReachVertically(e: Enemy, t: CombatTarget): boolean {
  const bottom = t.position.y - e.position.y;
  return bottom <= e.stats.height && bottom + t.bodyHeight >= -e.stats.height * 0.5;
}

function inFront(e: Enemy, t: CombatTarget): boolean {
  const dx = t.position.x - e.position.x, dz = t.position.z - e.position.z;
  const l = Math.hypot(dx, dz);
  if (l <= CLOSE_ALWAYS + Math.max(0, t.bodyRadius - PLAYER_RADIUS)) return true;
  return (dx * Math.sin(e.yaw) + dz * Math.cos(e.yaw)) / l >= FRONT_COS;
}

/** 추격 한 틱. 반환 = 이동 속도. */
function chase(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  const s = e.stats;
  const d = e.distToTarget;
  const reach = strikeRange(e, t);
  lookAtTarget(e, t, dt);
  e.moveTarget.copy(t.position); e.hasMoveTarget = true;
  if (d < FACE_DIST) { e.facePoint.copy(t.position); e.hasFacePoint = true; }

  // 바리케이드 · 돔 실드 · 포탑이 길을 막으면 부순다 (`ai/Structures` 가 벌레 근접형과 같은 규칙으로 고른다)
  const st = e.structTarget;
  if (st && st.hp > 0 && d > reach) {
    const sd = Math.hypot(st.position.x - e.position.x, st.position.z - e.position.z);
    if (sd <= s.attackRange + s.radius + st.radius + 0.5) {
      e.facePoint.copy(st.position); e.hasFacePoint = true;
      e.hasMoveTarget = false;
      if (e.attackCd <= 0) startSwing(e, host, true);
      return 0;
    }
    if (e.structBlocking) { e.moveTarget.copy(st.position); return s.speed; }
  }

  const reachable = canReachVertically(e, t);
  if (d <= reach && reachable) {
    e.facePoint.copy(t.position); e.hasFacePoint = true;
    if (e.attackCd <= 0) { startSwing(e, host, false); return 0; }
    // 다음 타격을 기다리는 동안에도 붙어 선다 — 사거리 끝에서 서성이지 않는다
    return d > s.attackRange * 0.6 ? s.speed * 0.5 : 0;
  }

  if (reachable && e.namedCooldown <= 0 && d <= NAMED_HAMMER.chargeDist && d > reach + CHARGE_MIN_GAP && e.hasLOS) {
    if (chargeLaneClear(e, host, t)) { startCharge(e, host, t); return 0; }
    e.namedCooldown = CHARGE_RETRY_S;
  }
  return s.speed;
}

function startSwing(e: Enemy, host: EnemyHost, struct: boolean): void {
  e.state = 'attack'; e.stateTime = 0;
  e.namedPhase = PHASE_WINDUP; e.namedTimer = 0; e.namedHint = HAMMER_HINT_WINDUP;
  e.chargePhase = 0;
  e.attackHitDone = false;
  e.structAttack = struct;
  e.hasMoveTarget = false;
  host.playAudio('hammer_swing', e.position, 1, 0.92 + Math.random() * 0.16);
}

/** 준비(phase 1) → 내려치기 → 회복(phase 4). 반환 = 이동 속도. */
function swing(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, targetAlive: boolean): number {
  const s = e.stats;
  e.namedTimer += dt;
  if (e.namedPhase === PHASE_WINDUP) {
    const struct = e.structAttack ? e.structTarget : null;
    if (struct && struct.hp > 0) { e.facePoint.copy(struct.position); e.hasFacePoint = true; }
    else if (t) { e.facePoint.copy(t.position); e.hasFacePoint = true; lookAtTarget(e, t, dt); }
    let speed = 0;
    if (!struct && t && targetAlive && e.distToTarget > s.attackRange * 0.5) {
      e.moveTarget.copy(t.position); e.hasMoveTarget = true;
      speed = s.speed * WINDUP_CREEP;
    }
    if (e.namedTimer >= NAMED_HAMMER.windup) strike(e, host, targetAlive ? t : null, struct);
    return speed;
  }
  // 회복: 내려친 망치를 들어 올리는 동안 선다
  if (t && targetAlive) lookAtTarget(e, t, dt);
  if (e.namedPhase !== PHASE_RECOVER || e.namedTimer >= RECOVER_S) {
    e.namedPhase = PHASE_CHASE; e.namedTimer = 0;
    e.state = targetAlive ? 'chase' : 'idle'; e.stateTime = 0; e.wanderTimer = 1;
  }
  return 0;
}

/** 내려치는 순간: 사거리 · 정면이면 1회 피해, 늘 땅을 찍는 연출 + `ee hammer`. */
function strike(e: Enemy, host: EnemyHost, t: CombatTarget | null, struct: DeployableRef | null): void {
  const s = e.stats;
  const ctx = host.ctx;
  const world = ctx.world!;
  e.attackHitDone = true;
  e.namedPhase = PHASE_RECOVER; e.namedTimer = 0; e.namedHint = 0;
  e.attackCd = Math.max(0, s.attackCooldown - NAMED_HAMMER.windup);
  e.structAttack = false;
  e.anim.recoil = 1;                                    // HammerLook: 내려찍기

  if (struct) {
    const sd = Math.hypot(struct.position.x - e.position.x, struct.position.z - e.position.z);
    if (struct.hp > 0 && sd <= s.attackRange + s.radius + struct.radius + 0.8) struct.takeDamage(s.attackDamage * STRUCT_DAMAGE_MUL, e.position);
  } else if (t && !t.isDeadOrDowned && t.dist2D(e.position) <= strikeRange(e, t) + STRIKE_GRACE && inFront(e, t) && canReachVertically(e, t)) {
    // 표적이 드론이면 `hitTarget` 이 `ctx.drones.damageDrone` 으로 보낸다 (플레이어 이벤트 없음). 넉백 경로는 쓰지 않는다.
    host.hitTarget(e, s.attackDamage, t.isDrone ? 0 : HIT_SHAKE, t);
  }

  e.facing(_f);
  _p.set(e.position.x + _f.x * HAMMER_IMPACT_FORWARD, e.position.y, e.position.z + _f.z * HAMMER_IMPACT_FORWARD);
  _p.y = world.getSurfaceY(_p.x, _p.z, e.position.y + 0.3);
  impactFx(host, _p);
  host.playAudio('hammer_impact', _p, 1, 0.94 + Math.random() * 0.12);
  if (!host.replica && ctx.isMultiplayer && ctx.net) ctx.net.send({ t: 'ee', ev: 'hammer', id: e.id, p: tuple(_p, 2) }, 'others');
}

/** 무릎 높이로 표적까지 길이 트였나 (돌진 결정 때 한 번 — 막히면 `CHARGE_RETRY_S` 뒤에 다시 본다). */
function chargeLaneClear(e: Enemy, host: EnemyHost, t: CombatTarget): boolean {
  const world = host.ctx.world;
  if (!world) return false;
  _o.set(e.position.x, e.position.y + CHARGE_LANE_Y, e.position.z);
  _d.set(t.position.x - _o.x, t.position.y + CHARGE_LANE_Y - _o.y, t.position.z - _o.z);
  const len = _d.length();
  if (len < 1e-3) return false;
  _d.multiplyScalar(1 / len);
  return world.raycast(_o, _d, Math.max(0.1, len - t.bodyRadius - e.stats.radius)) === null;
}

function startCharge(e: Enemy, host: EnemyHost, t: CombatTarget): void {
  e.namedPhase = PHASE_CHARGE; e.namedTimer = 0; e.namedHint = HAMMER_HINT_CHARGE;
  e.namedCooldown = NAMED_HAMMER.chargeCooldown;
  e.chargePhase = 2;                                    // integrate: 직선 이동 · 장애물 → stumble
  e.chargeDir.set(t.position.x - e.position.x, 0, t.position.z - e.position.z);
  if (e.chargeDir.lengthSq() < 1e-4) e.facing(e.chargeDir); else e.chargeDir.normalize();
  e.yaw = Math.atan2(e.chargeDir.x, e.chargeDir.z);
  e.hasMoveTarget = false; e.hasFacePoint = false;
  host.playAudio('hammer_swing', e.position, 0.85, 0.7);
}

/** 돌진 한 틱. 사거리에 닿으면 곧장 휘두르기로 넘어간다. 반환 = 이동 속도(돌진 중에는 `integrate` 가 velocity 를 그대로 쓴다). */
function charge(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  e.namedTimer += dt;
  const dx = t.position.x - e.position.x, dz = t.position.z - e.position.z;
  const d = Math.hypot(dx, dz);
  if (d > 1e-3) {
    // 표적을 가볍게 따라 꺾는다
    const cur = Math.atan2(e.chargeDir.x, e.chargeDir.z);
    let rel = Math.atan2(dx, dz) - cur;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const ny = cur + THREE.MathUtils.clamp(rel, -CHARGE_TURN * dt, CHARGE_TURN * dt);
    e.chargeDir.set(Math.sin(ny), 0, Math.cos(ny));
  }
  const sp = NAMED_HAMMER.chargeSpeed * (e.slowFactor < 1 ? e.slowFactor : 1);
  e.velocity.set(e.chargeDir.x * sp, 0, e.chargeDir.z * sp);
  e.hasMoveTarget = false; e.hasFacePoint = false;
  lookAtTarget(e, t, dt);

  if (!canReachVertically(e, t)) { endCharge(e); return 0; }   // 떠오른 드론 — 돌진을 접는다
  if (d <= strikeRange(e, t)) {
    endCharge(e);
    if (e.attackCd <= 0) startSwing(e, host, false);
    return 0;
  }
  const ahead = dx * e.chargeDir.x + dz * e.chargeDir.z;   // < 0 = 지나쳤다
  const maxT = NAMED_HAMMER.chargeDist / Math.max(0.1, NAMED_HAMMER.chargeSpeed) * CHARGE_TIME_MUL;
  if ((ahead < 0 && e.namedTimer > 0.25) || e.namedTimer > maxT) endCharge(e);
  return 0;
}

function endCharge(e: Enemy): void {
  e.namedPhase = PHASE_CHASE; e.namedTimer = 0; e.namedHint = 0;
  e.chargePhase = 0;
  e.velocity.multiplyScalar(0.6);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 연출 (호스트 · 리플리카 공용) — 광원 없음, 풀 파티클만
 * ──────────────────────────────────────────────────────────────────────────── */

function impactFx(host: { readonly ctx: GameContext; readonly targets: TargetList }, p: THREE.Vector3): void {
  const fx = FxManager.get();
  if (fx) {
    ParticleBurst.groundBlast(fx.alpha, p, 26, 6, DUST_COLOR, 0.25);
    ParticleBurst.dust(fx.alpha, p, UP, 12, 1.4, DUST_COLOR);
    ParticleBurst.dust(fx.alpha, p, UP, 7, 0.55, DEBRIS_COLOR);   // 파편
    ParticleBurst.sparks(fx.additive, p, UP, 14, 7);
  }
  const dl = host.targets.distToLocal(p);
  if (dl < SHAKE_RADIUS) host.ctx.bus.emit('camera:shake', { intensity: SHAKE_MAX * (1 - dl / SHAKE_RADIUS), duration: 0.28 });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 리플리카 (`./remote` 가 부른다)
 * ──────────────────────────────────────────────────────────────────────────── */

/** 리플리카는 돌진을 적분하지 않는다 (`Replica.drive` 의 `chargePhase` 는 1/2/10/11 만 본다) — 할 일이 없다. */
export function beforeHammerReplica(_e: Enemy, _hint: number): void { /* 의도적으로 비어 있다 */ }

/**
 * 기본 리플리카 자세 위에: 소총 조준 자세를 지우고, 준비 · 돌진 중의 몸 낮춤. 팔 · 망치는 `HammerLook` 이 그린다.
 * `host` 는 `net/Replica.drive` 가 늘 넘긴다 — 준비음(`hammer_swing`)의 출구.
 */
export function afterHammerReplica(e: Enemy, hint: number, dt: number, host: ReplicaHost): void {
  const a = e.anim;
  a.aim = 0;
  // 리플리카는 AI 를 돌리지 않으므로 `namedPhase` 에 직전 힌트를 적어 둔다 — 16 이 새로 켜지면 준비음.
  // (승격되면 AI 가 16/17 을 모르는 phase 로 읽고 추격 · 회복 가지에서 곧 0 으로 되돌린다)
  if (hint === HAMMER_HINT_WINDUP && e.namedPhase !== HAMMER_HINT_WINDUP) {
    host.playAudio('hammer_swing', e.position, 1, 0.92 + Math.random() * 0.16);
  }
  e.namedPhase = hint;
  if (hint === HAMMER_HINT_WINDUP) a.crouch += (0.1 - a.crouch) * Math.min(1, dt * 8);
  else if (hint === HAMMER_HINT_CHARGE) {
    a.crouch += (0.12 - a.crouch) * Math.min(1, dt * 8);
    a.headPitch = THREE.MathUtils.lerp(a.headPitch, -0.15, Math.min(1, dt * 6));
  }
}

/** `ee hammer`: 내려찍기 자세 · 먼지 · 파편 · 흔들림 · `hammer_impact`. 게임 상태는 바꾸지 않는다. */
export function onHammerEvent(host: ReplicaHost, msg: Extract<EnemyEvent, { ev: 'hammer' }>): void {
  _p.set(msg.p[0], msg.p[1], msg.p[2]);
  const e = host.find(msg.id);
  if (e && e.active && e.state !== 'dead') e.anim.recoil = 1;
  impactFx(host, _p);
  host.playAudio('hammer_impact', _p, 1, 0.94 + Math.random() * 0.12);
}
