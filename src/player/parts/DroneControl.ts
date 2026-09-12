/**
 * src/player/parts/DroneControl.ts — **드론 시점으로 조종하는 동안 몸은 무엇을 하는가** (2026-09-11).
 *
 * `PlayerRef.setDroneControl` 의 구현 (호출자: `gadgets/drones/DroneSystem`, 계약: `shared/types.ts` · `shared/drones.ts`).
 * 켜져 있는 동안 몸은 제자리에 웅크리고 멈춘다 — 이동 · 점프 · 자세 · 구르기 · 달리기 · 조준 · E 상호작용 · 들쳐메기 ·
 * 사다리 · 무기(`canUseWeapons`)가 없고 마우스 시점은 카메라 리그에 들어가지 않는다 (입력은 드론 것이다).
 * 카메라는 드론이 매 프레임 `setCameraOverride(pos, look, true)` 로 준다; 리그는 `setDroneView` 동안 몸의 흔들림 ·
 * FOV 가산을 드론 시점에 섞지 않는다. 피해는 그대로 받는다 — 조종을 끊는 것은 드론 쪽이 `player:damaged` 를 보고 한다.
 *
 * **자세**: 서 있었으면 앉기로 내리고 끌 때 서기로 돌린다. **엎드려 있었으면 엎드린 채로 둔다** — 엎드리기가 앉기보다
 * 낮아(적 `Targets` 의 눈높이) 은신이라는 목적을 이미 채우고, 억지로 앉히면 몸이 한 번 솟았다가 끌 때 다시
 * 엎드리며 `STAND_UP_TIME` 전환을 두 번 탄다.
 */
import type { PlayerSystem } from '../PlayerSystem';

/** 지금 조종을 **시작**해도 되는가. 거부는 조용하다 — `droneControl` 이 false 로 남아 드론 쪽이 알 수 있다. */
export function canEnterDroneControl(sys: PlayerSystem): boolean {
  return canHoldDroneControl(sys) && sys.carryLock <= 0 && sys.furn.kind === null;   // 2026-09-12: 가구 자세 중 거절
}

/** 조종을 **유지**해도 되는가. 몸이 더 이상 자유롭지 않으면(`update` 맨 위의 백스톱) 조종이 풀린다. */
export function canHoldDroneControl(sys: PlayerSystem): boolean {
  const c = sys.controller;
  if (!sys.spawned || sys.isDead || sys._downed || !sys.controlsEnabled) return false;
  if (sys._inPod || sys.carriedSocket !== null || c.climbing) return false;
  if (sys.attachedParent !== null || sys.shipBounds !== null || sys._interior !== null) return false;
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return false;
  return !sys.ctx.isHubPhase();
}

export function setDroneControl(sys: PlayerSystem, active: boolean): void {
  if (!active) { releaseDroneControl(sys, true, false); return; }
  if (sys._droneControl || !canEnterDroneControl(sys)) return;
  // 어깨에 멘 분대원은 먼저 내려놓는다 (다른 행동과 같은 규칙 — 'action' 은 애니메이션 없이 곧장 푼다)
  if (sys._carrying) sys.dropCarried('action');
  const c = sys.controller;
  sys._droneControl = true;
  sys.droneStancePrev = sys._stance;
  sys.setAiming(false);
  if (c.rolling) c.cancelRoll();
  sys.setGrappleTarget(null);
  sys.setHovering(false);
  // 수평 속도 0 (중력 · 접지는 그대로). 달리기 플래그는 다음 `c.update` 가 입력 0 에서 내리며 `player:sprintChanged` 를 낸다
  c.velocity.x = 0; c.velocity.z = 0;
  // 진행 중인 E 홀드는 취소; 대상 · 프롬프트는 다음 `updateInteraction(active=false)` 가 지운다
  sys.cancelHold();
  if (sys._stance === 'stand') sys.setStance('crouch');
  sys.rig.setDroneView(true);
}

/**
 * 조종을 끝낸다. 조종 중이 아니면 아무것도 안 한다.
 * - `restoreStance` — 켜기 전이 서기였고 지금도 강제한 앉기 그대로면 서기로 돌린다 (죽음 · 전투불능 · 리셋 경로는 false —
 *   그 경로가 자세를 스스로 정한다).
 * - `cutCamera` — 드론 카메라 오버라이드를 **즉시** 걷는다. 드론 쪽이 부르는 해제(`setDroneControl(false)`)는 카메라를
 *   건드리지 않고(드론이 `setCameraOverride(null[, , snap])` 로 직접 걷는다), 몸 쪽 자동 해제만 카메라를 끊는다 —
 *   드론 쪽이 해제를 놓쳐도 시점이 드론에 갇히지 않게.
 */
export function releaseDroneControl(sys: PlayerSystem, restoreStance: boolean, cutCamera: boolean): void {
  if (!sys._droneControl) return;
  sys._droneControl = false;
  const prev = sys.droneStancePrev;
  sys.droneStancePrev = null;
  sys.rig.setDroneView(false);
  if (cutCamera) sys.rig.setOverride(null, undefined, true);
  if (restoreStance && prev === 'stand' && sys._stance === 'crouch' && !sys.isDead && !sys._downed) sys.setStance('stand');
}
