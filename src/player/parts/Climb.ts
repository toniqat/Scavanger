/**
 * src/player/parts/Climb.ts — **몸이 수직으로 어떻게 옮겨 가는가: 사다리 · 단차 보간** (2026-09-11).
 *
 * 사다리: `ladder:grab` 을 받아 매달리고(`grabLadder`), 매달린 동안의 입력 규칙(`readClimbInput` — W/S · 달리기 ·
 * 점프 · E)을 채우고, 어떤 이유로든 놓이면 `player:climbChanged {ladderId: null}` 를 **한 번만** 낸다
 * (`syncClimb` — 컨트롤러의 `climbLadder` 와 마지막으로 보낸 값을 비교한다). 몸을 움직이는 수학은
 * `PlayerController.updateClimb` 에 있다.
 *
 * 단차 보간: 낮은 바위 · 상자 모서리 · 지면 스냅처럼 **한 프레임에 튀는 높이**를 모델에서만 부드럽게 한다
 * (`updateStepSmoothing` → `bodyOffset`). 물리 위치(충돌 · 스냅샷 · 적 인지)는 그대로 즉시 옮겨 간다.
 */
import * as THREE from 'three';
import { Keys, STEP_SMOOTH_MAX, STEP_SMOOTH_RATE, type LadderDef } from '@/shared';
import { CLIMB_GRAB_OFFSET_MAX, STAMINA_JUMP_COST, STEP_SLOPE_RATIO, STEP_SMOOTH_MIN } from '../model';
import type { PlayerSystem } from '../PlayerSystem';

const _from = new THREE.Vector3();

/**
 * `ladder:grab` (world 의 사다리 `Interactable` 이 E 로 낸다). 죽음 · 전투불능 · 들쳐메기(양쪽) · 포드 · 강하 ·
 * 조작 불가 · 함선 실내 · 탈출선 · 이미 매달림이면 무시한다. 매달리면 구르기 · 조준이 풀리고 자세는 서기다.
 */
export function grabLadder(sys: PlayerSystem, ladder: LadderDef, from: 'bottom' | 'top'): boolean {
  const c = sys.controller;
  if (!ladder || c.climbing) return false;
  if (!sys.spawned || sys.isDead || sys._downed || !sys.controlsEnabled) return false;
  if (sys._droneControl) return false;   // 2026-09-11: 드론 조종 중에는 `ladder:grab` 을 무시한다
  if (sys._carrying || sys.carriedSocket || sys.carryLock > 0 || sys._inPod) return false;
  if (sys._interior || sys.shipBounds || sys.attachedParent) return false;
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return false;
  _from.copy(c.position);
  c.startClimb(ladder, from === 'top' ? 'top' : 'bottom');
  // 물리 위치는 곧장 사다리에 붙고, 모델은 서 있던 자리에서 미끄러져 붙는다 (단차 보간과 같은 오프셋)
  sys.bodyOffset.add(_from.sub(c.position));
  if (sys.bodyOffset.length() > CLIMB_GRAB_OFFSET_MAX) sys.bodyOffset.setLength(CLIMB_GRAB_OFFSET_MAX);
  sys.setAiming(false);
  if (sys._stance !== 'stand') sys.setStance('stand');
  sys.standUpTimer = 0;
  sys._grappling = false;
  sys.setHovering(false);
  sys.cancelHold();
  syncClimb(sys);
  return true;
}

/** 무슨 이유로든 사다리를 놓는다 (속도는 건드리지 않는다 — 그 자리에서 떨어진다). 매달려 있지 않으면 아무것도 안 한다. */
export function releaseLadder(sys: PlayerSystem): void {
  if (sys.controller.climbing) sys.controller.releaseClimb();
  syncClimb(sys);
}

/** 리셋 경로(부활 · 순간이동 · 함선 · 중단): 사다리를 놓고 시각 오프셋 · 자세 블렌드까지 지운다. */
export function clearClimbState(sys: PlayerSystem): void {
  releaseLadder(sys);
  sys.bodyOffset.set(0, 0, 0);
  sys.climbBlend = 0;
}

/** `player:climbChanged` 한 곳 — 컨트롤러의 상태와 마지막으로 보낸 값이 다를 때만. */
export function syncClimb(sys: PlayerSystem): void {
  const id = sys.controller.climbLadder ? sys.controller.climbLadder.id : null;
  if (id === sys.climbSent) return;
  sys.climbSent = id;
  sys.ctx?.bus.emit('player:climbChanged', { ladderId: id });
}

/**
 * 매달린 동안의 입력. `active` 가 아니거나(UI · 조작 끔) 올라서는 중이면 전부 0 — 그 자리에 매달려 있다.
 * 달리기는 **스태미나가 있고 지치지 않았을 때만**(소모는 `Locomotion.updateStamina` 가 `climbFast` 로 한다),
 * 점프는 보통 점프와 같은 스태미나 · 무게 규칙이다. E 는 상호작용이 꺼져 있으므로(PlayerSystem) 여기로만 온다.
 */
export function readClimbInput(sys: PlayerSystem, active: boolean): void {
  const inp = sys.climbInput, input = sys.ctx.input, c = sys.controller;
  inp.z = 0; inp.fast = false; inp.jump = false; inp.drop = false;
  if (!active || c.climbMount >= 0) return;
  inp.z = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
  inp.fast = inp.z !== 0 && input.isDown(Keys.SPRINT) && !sys.exhausted && sys.stamina > 0;
  if (input.wasPressed(Keys.JUMP)) {
    if (sys.stamina >= STAMINA_JUMP_COST && !sys.gear.overloaded) inp.jump = true;
    else sys.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
  }
  inp.drop = !inp.jump && input.wasPressed(Keys.INTERACT) && sys.interactCooldown <= 0;
}

/**
 * 단차 보간. `c.update` 직전의 자리 · 접지를 받아, 접지 → 접지 사이에 **단차로 보이는** 높이 변화가 있었으면
 * 그만큼을 `bodyOffset.y` 에 반대로 쌓는다. 그다음 오프셋 전체(사다리 잡기의 XZ 포함)를 `STEP_SMOOTH_RATE`
 * 로 0 에 감쇠시킨다. 차량 탑승 · 사다리 · 부모에 붙음 · 업힘은 건너뛴다 (그쪽 이동은 연속이거나 남의 것이다).
 */
export function updateStepSmoothing(sys: PlayerSystem, dt: number, prevX: number, prevY: number, prevZ: number, wasGrounded: boolean): void {
  const c = sys.controller, o = sys.bodyOffset;
  if (wasGrounded && c.grounded && !c.riding && !c.climbing && !sys.attachedParent && !sys.carriedSocket) {
    const dy = c.position.y - prevY;
    const ady = Math.abs(dy);
    if (ady > STEP_SMOOTH_MIN && ady <= STEP_SMOOTH_MAX) {
      const run = Math.hypot(c.position.x - prevX, c.position.z - prevZ);
      if (ady > run * STEP_SLOPE_RATIO) o.y -= dy;
    }
  }
  if (o.x === 0 && o.y === 0 && o.z === 0) return;
  if (dt > 0) o.multiplyScalar(Math.exp(-STEP_SMOOTH_RATE * dt));
  if (Math.abs(o.y) > STEP_SMOOTH_MAX) o.y = Math.sign(o.y) * STEP_SMOOTH_MAX;
  if (o.lengthSq() < 1e-6) o.set(0, 0, 0);
}
