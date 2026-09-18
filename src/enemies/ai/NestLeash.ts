/**
 * src/enemies/ai/NestLeash.ts — **둥지 벌레의 리시** (2026-09-18, 사용자 결정 「둥지 반경 60 m 리시」).
 *
 * 답하는 질문 하나: *둥지에서 나온 벌레는 어디까지 쫓아오나.*
 *
 * - **누가**: `Enemy.nestOf >= 0` 인 몸뿐이다 — 레이드 시작 때 둥지 둘레에 깔린 수비대와 둥지 보충
 *   (`NestDirector`). 레이드 중 순찰 · 웨이브 · 레이더 강하 · 땅굴벌레가 뱉은 벌레는 -1 이라 **첫 줄에서 그대로
 *   돌아간다** — 그것들의 추격은 한 치도 안 바뀐다.
 * - **얼마나**: 둥지(`guardPos`)에서 `NEST_LEASH_M` 밖으로 나가면 표적을 놓고 걸어 돌아간다. 돌아가는 동안에는 매 틱
 *   `aware` 를 꺼 두므로 **리시 밖에서는 무슨 일이 있어도 다시 달려들지 않는다**. 리시 안에 들어오면 평소 감지
 *   거리로 다시 표적을 잡는다 — 「적당히 따돌리면 돌아가지만, 둥지까지 따라가면 다시 붙는다」.
 * - **이력**: 되돌아오는 판정을 60 m 한 곳에서 하면 경계에서 「놓았다 잡았다」를 되풀이한다. 그래서 한 번 돌아가기
 *   시작하면 `NEST_LEASH_M × NEST_LEASH_RETURN_FRAC` 안에 들어올 때까지 계속 돌아간다 (`Enemy.nestReturning`).
 * - 끝나지 않으면 억지로 끊지 않는 것들: 공중(도약 · 뱉어짐) · 돌진 중 · 경직. 튜토리얼의 `Tutorial.tutorialHold` 와
 *   같은 예외이고, 다음 틱에 땅에 닿으면 그때 돌아간다.
 *
 * 걸음 · 애니메이션 · 충돌은 평소 벌레 상태 기계(`ai/EnemyAI`)가 그대로 맡는다 — 이 파일은 상태 · 표적만 되돌린다.
 * 권위 전용이고 와이어가 없다 (`nestOf` 는 호스트 메모리다 — 호스트가 바뀌면 리시가 풀려 평범한 벌레가 된다, 의도).
 */
import type { Enemy } from '../Enemy';
import { NEST_LEASH_M, NEST_LEASH_RETURN_FRAC } from '../factionTables';

/**
 * 둥지 벌레의 한 틱 (`ai/EnemyAI.updateEnemyAI` 가 인지 갱신 뒤, 상태 기계 바로 앞에서 부른다).
 * 둥지에서 나지 않은 몸은 첫 줄에서 돌아간다.
 */
export function nestLeashHold(e: Enemy): void {
  if (e.nestOf < 0) return;
  // 끝나야 끝나는 것들 — 다음 틱에 땅에 닿으면 그때 접는다 (`Tutorial.tutorialHold` 와 같은 예외)
  if (e.airborne || e.spatT > 0 || e.chargePhase !== 0 || e.state === 'stagger' || e.state === 'dead' || e.state === 'flee') return;
  const dx = e.position.x - e.guardPos.x, dz = e.position.z - e.guardPos.z;
  const home2 = dx * dx + dz * dz;
  const leash = Math.max(0, NEST_LEASH_M);
  if (!e.nestReturning) {
    if (home2 <= leash * leash) return;
    e.nestReturning = true;
  } else {
    const back = leash * Math.max(0, Math.min(1, NEST_LEASH_RETURN_FRAC));
    if (home2 <= back * back) { e.nestReturning = false; return; }
  }
  leashToNest(e);
}

/**
 * 추격을 접고 둥지로 돌려보낸다. `Tutorial.leashHome` 과 같은 목록을 접는다 — 표적 · 인지 · 조사 · 유인 ·
 * 진행 중인 기술. 이동은 `wander` 로 `guardPos` 를 향하게만 해 두고 평소 상태 기계가 걷는다.
 */
function leashToNest(e: Enemy): void {
  e.aware = false;
  e.lostTimer = 0;
  e.target = null;
  e.hasLOS = false;
  e.investigating = false;
  e.hasLure = false;
  e.lureWeight = 0;
  e.suspicionTimer = 0;
  e.spitPhase = 0;
  e.spitAtPoint = false;
  e.toxicPhase = 0;
  e.leaping = false;
  e.structAttack = false;
  e.structBlocking = false;
  e.structTarget = null;
  e.spawnPos.copy(e.guardPos);
  e.state = 'wander';
  e.stateTime = 0;
  e.wanderTimer = 0;
  e.moveTarget.copy(e.guardPos);
  e.hasMoveTarget = true;
  e.hasFacePoint = false;
}
