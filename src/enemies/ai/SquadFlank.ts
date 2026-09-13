import * as THREE from 'three';
import type { Enemy, EnemyHost } from '../Enemy';
import { HUMANOID_RAIDER } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-13: 레이더 우회조 — 그룹마다 한 명(`Enemy.squadRole === 'flanker'`, 스폰 디렉터가 준다)이 분대가 엄폐 대치하는
 * 동안 넓게 돌아 표적의 측면 · 후방으로 가서 푸시한다. 수치는 csv `HUMANOID_RAIDER.flank*`.
 *
 *   조건  같은 `squadId` 의 다른 분대원이 교전(chase · aware) 중 · 내 교전이 `flankDelay` 만큼 이어졌다(`flankCd`) ·
 *         표적 거리가 `flankMinDist … flankMaxDist` · 재장전 · 투척 · 돌격 중이 아니다 · 드론 표적이 아니다.
 *         분대가 없으면(`squadId` −1, 혼자 남았다) 평범한 레이더다.
 *   우회  (`flankPhase` 1, 와이어 힌트 0) 표적을 중심으로 **호를 따라** 간다: 목표 방위 = 표적 정면의 반대편 측면을
 *         `flankBehind` 만큼 뒤로 민 방향(표적이 돌면 목표도 따라 돈다 = 시선 밖에 머문다). 매 틱 지금 방위에서
 *         `flankArcStep` 도 앞 · 반지름은 지금보다 4 m 안쪽(최소 `flankRadius`)의 경유점으로 조향한다 — 곧장 달려들지
 *         않고 나선으로 좁혀 든다. 장애물은 `integrate` 의 회피가 돌아간다. 이동 속도 × `flankSpeedMul`, 사격 없음.
 *   푸시  목표 방위의 `flankArrive` 도 안에 들거나 `flankMaxTime` 이 지나면 `roguePhase` 4 (기존 돌격 — 힌트 7, 허리
 *         사격)로 넘기고 `flankCd` = `flankCooldown`. 돌격이 끝나면 평소 엄폐 순환으로 돌아간다(리시가 끌어당긴다).
 * ──────────────────────────────────────────────────────────────────────────── */

const DEG = Math.PI / 180;
/** 조건이 안 맞으면 이만큼 뒤에 다시 본다 (분대원 스캔을 매 틱 돌리지 않는다) — 알고리즘 상수. */
const RETRY_S = 0.5;
/** 경유점 반지름을 매 틱 지금보다 이만큼 안쪽에 잡는다 (m) — 나선의 조임, 그림 상수. */
const SPIRAL_IN_M = 4;

const _f = new THREE.Vector3();

export interface FlankPose { speed: number; aim: number; crouch: number }

/**
 * A raider squad's flanker. It never rushes on its own (`RogueAI` skips `rushChance` for it): its push comes at the end of
 * the arc — a random rush in the first seconds would carry it to the target's face and spend the flank before it starts.
 */
export function isSquadFlanker(e: Enemy): boolean {
  return e.squadRole === 'flanker' && e.squadId >= 0 && e.faction === 'raider';
}

/** True while the flank arc owns this tick (`pose` written); false = run the normal cover cycle (maybe the push, phase 4). */
export function updateSquadFlank(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget, pose: FlankPose): boolean {
  if (!isSquadFlanker(e)) return false;
  const P = HUMANOID_RAIDER;
  if (e.flankPhase === 0) {
    if (e.flankCd > 0 || e.roguePhase === 4 || e.reloadTimer > 0 || e.throwTimer > 0 || t.drone !== null) return false;
    const d = e.distToTarget;
    if (d < P.flankMinDist || d > P.flankMaxDist || !squadEngaged(e, host)) { e.flankCd = RETRY_S; return false; }
    // take the flank we are already on (the shorter arc)
    t.getForward(_f);
    const ox = e.position.x - t.position.x, oz = e.position.z - t.position.z;
    e.flankSide = _f.x * oz - _f.z * ox >= 0 ? 1 : -1;
    e.flankPhase = 1; e.flankClock = 0;
    e.roguePhase = 0; e.burstLeft = 0; e.popBursts = 0; e.hasCover = false; e.hasPop = false; e.stateTime = 0;
  }

  e.flankClock += dt;
  const cx = t.position.x, cz = t.position.z;
  const ox = e.position.x - cx, oz = e.position.z - cz;
  const re = Math.hypot(ox, oz);
  // goal bearing: the target's side (perpendicular to its forward, on our side) pushed `flankBehind` toward its back
  t.getForward(_f);
  const side = e.flankSide;
  const b = THREE.MathUtils.clamp(P.flankBehind, 0, 1);
  const gx = side * -_f.z * (1 - b) - _f.x * b;
  const gz = side * _f.x * (1 - b) - _f.z * b;
  const thG = Math.atan2(gx, gz);
  const thE = Math.atan2(ox, oz);
  let delta = thG - thE;
  delta = Math.atan2(Math.sin(delta), Math.cos(delta));

  if (Math.abs(delta) < P.flankArrive * DEG || e.flankClock > P.flankMaxTime) {
    // arrived on the flank (or took too long): push like a rush, then back to the cover cycle
    endFlank(e);
    e.roguePhase = 4; e.rushTimer = 0; e.burstTimer = 0.2; e.stateTime = 0;
    return false;
  }

  const step = Math.min(Math.abs(delta), P.flankArcStep * DEG) * Math.sign(delta);
  const thW = thE + step;
  const rw = Math.max(P.flankRadius, re - SPIRAL_IN_M);
  const wx = cx + Math.sin(thW) * rw, wz = cz + Math.cos(thW) * rw;
  if (!host.ctx.world!.isInsideBounds(wx, wz)) {
    // the arc runs off the map on this side: give it up for a while (the squad keeps the pressure)
    endFlank(e);
    e.roguePhase = 0; e.stateTime = 0;
    return false;
  }
  e.moveTarget.set(wx, 0, wz); e.hasMoveTarget = true;
  e.hasFacePoint = false;                         // run the way we go; the head still tracks the target (lookAtTarget)
  pose.speed = e.stats.speed * P.flankSpeedMul;
  pose.aim = 0.45;
  pose.crouch = 0;
  return true;
}

function endFlank(e: Enemy): void {
  e.flankPhase = 0;
  e.flankCd = HUMANOID_RAIDER.flankCooldown * (0.85 + Math.random() * 0.3);
}

/** Is another member of `e`'s squad fighting right now? */
function squadEngaged(e: Enemy, host: EnemyHost): boolean {
  const list = host.active;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === e || o.squadId !== e.squadId || !o.isCombatant) continue;
    if (o.aware && o.state === 'chase') return true;
  }
  return false;
}
