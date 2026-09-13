/**
 * src/player/parts/RoverRide.ts — **탐사 차량 안에 탄 동안 몸은 무엇을 하는가** (2026-09-13, R3).
 *
 * `PlayerRef.roverRide` · `roverBoardBlock` · `setRoverRide` · `roverSafePosition` 의 구현 (호출자: `world/rover`, 규칙: `shared/types.ts`
 * 의 탐사 차량 절). 켜져 있는 동안:
 *   - 몸은 **선체 안에 숨는다** — 모델 · 들고 있는 무기 · 그림자 · 실루엣 없음, 원격에는 `PlayerFlags.IN_ROVER`.
 *   - 매 프레임 발이 `binding.seat` 에 붙는다 (중력 · 충돌 · 발소리 없음). 안개 · 지도 · 분대 목록 · 스냅샷이 차량을 따라간다.
 *   - 이동 · 점프 · 자세 · 구르기 · 조준 · 무기 · 상호작용 스캔 · 들쳐메기 · 사다리가 없고, 다른 폴더(퀵슬롯 · 임플란트 · 함선 호출 ·
 *     핑 · 의사소통 휠 · 가젯 · 드론)는 `droneControl` 을 보던 자리에서 `roverRide` 를 같이 본다.
 *   - **어떤 피해도 받지 않는다** — `applyDamage` · 넉백 · 충격(점프대 · 로켓) · 화상 · 행성 환경 · 재해 (차량만 맞는다).
 *   - 카메라는 `CameraRig` 의 **궤도 모드**다 (마우스로 `binding.focus` 주위를 돈다, 휠 = 거리).
 *   - E 꾹 = `binding.canExit` 면 하차 홀드(`ROVER_EXIT_HOLD_S`) → `binding.requestExit()`; 아니면 `lockedPrompt` 만 띄운다.
 * 하차(`setRoverRide(null, exitAt)`)는 `exitAt` 의 지면에 몸을 세우고 다시 보이게 한 뒤 카메라를 PC 뒤로 하드 컷한다.
 * 사망 · 리셋(`game:abort` · 새 미션 · `respawnAt` · `spawnStanding` · 페이즈 이탈)은 `releaseRoverRide` 로 **차량 옆**에 내린다.
 */
import * as THREE from 'three';
import { Keys, PLAYER_RADIUS, ROVER_EXIT_HOLD_S, ROVER_SAFE_SIDE_M, type RoverRideBinding } from '@/shared';
import { _up } from '../model';
import type { PlayerSystem } from '../PlayerSystem';

const _exit = new THREE.Vector3();
const _pivot = new THREE.Vector3();

/** 지금 탈 수 **없는** 한국어 사유, 가능하면 null. */
export function roverBoardBlock(sys: PlayerSystem): string | null {
  if (sys._roverRide) return '이미 탐사 차량에 타 있다';
  if (!sys.spawned || sys.isDead) return '사망한 상태에서는 탈 수 없다';
  if (sys._downed) return '전투불능 상태에서는 탈 수 없다';
  if (sys._carrying) return '분대원을 멘 채로는 탈 수 없다';
  if (sys.carriedSocket !== null) return '업혀 있는 동안은 탈 수 없다';
  if (sys.controller.climbing) return '사다리에 매달린 채로는 탈 수 없다';
  if (sys._droneControl) return '드론 조종 중에는 탈 수 없다';
  if (sys.furn.kind !== null || sys._inPod || sys.isDropping || sys.isInShip) return '지금은 탈 수 없다';
  if (sys.attachedParent !== null || sys._interior !== null || !sys.ctx.isGameplayPhase()) return '지금은 탈 수 없다';
  return null;
}

/** 탑승을 **유지**해도 되는가 — 아니면 `update` 맨 위의 백스톱이 차량 옆에 내린다. */
export function canHoldRoverRide(sys: PlayerSystem): boolean {
  if (!sys.spawned || sys.isDead || sys._downed || !sys.ctx.isGameplayPhase()) return false;
  return !sys._inPod && sys.carriedSocket === null && sys.attachedParent === null && sys._interior === null && sys.shipBounds === null;
}

/** 차체 yaw(`(cos, sin)` 전방) → 카메라 리그 yaw(`(-sin, -cos)` 전방). 같은 쪽을 본다. */
function rigYawOf(vehicleYaw: number): number {
  return Math.atan2(-Math.cos(vehicleYaw), -Math.sin(vehicleYaw));
}

export function setRoverRide(sys: PlayerSystem, binding: RoverRideBinding | null, exitAt?: THREE.Vector3): void {
  if (!binding) { exitRide(sys, exitAt ?? null); return; }
  if (sys._roverRide === binding) return;
  if (sys._roverRide) {
    // 같은 차의 끈이 새로 왔다 (world 가 다시 만들었다) — 몸은 그대로, 카메라만 새 초점으로
    sys._roverRide = binding;
    sys.rig.enterRoverOrbit(binding.focus, binding.cameraDistance, binding.yaw);
    return;
  }
  const block = roverBoardBlock(sys);
  if (block) { console.warn(`[Player] setRoverRide refused: ${block}`); return; }
  enterRide(sys, binding);
}

function enterRide(sys: PlayerSystem, b: RoverRideBinding): void {
  const c = sys.controller;
  // 손 · 몸이 하던 일을 전부 내려놓는다 (무기 쪽 장전 · 투척 · 퀵 휠은 weapons 가 `roverRide` 를 보고 스스로 멈춘다)
  sys.setAiming(false);
  if (c.rolling) c.cancelRoll();
  sys.setGrappleTarget(null);
  sys.setHovering(false);
  sys.setBurning(0, 0);                      // 걸려 있던 화상(DoT)을 지운다 — `_roverRide` 를 세우기 전이라 통과한다
  sys.slowTimer = 0; sys.slowFactor = 1;
  sys.meleeTimer = 0;
  sys.cancelHold(); sys.interactTarget = null; sys.holdProgress = 0;
  if (sys._stance !== 'stand') sys.setStance('stand');
  sys.standUpTimer = 0;
  c.reset(b.seat);                           // 속도 0 · 접지 · 전차 탑승 · 사다리 상태까지 비운다
  sys.bodyOffset.set(0, 0, 0);
  sys._roverRide = b;
  sys.roverHold = 0;
  // 탑승 홀드에 쓴 E 를 아직 누르고 있으면 그 누름이 곧장 하차 홀드가 되지 않게 — 한 번 떼야 한다
  sys.roverHoldArmed = !sys.ctx.input.isDown(Keys.INTERACT);
  sys.model.setVisible(false);
  sys.model.setSilhouette(false);
  sys.rig.enterRoverOrbit(b.focus, b.cameraDistance, b.yaw);
  clearPrompt(sys);
}

function exitRide(sys: PlayerSystem, exitAt: THREE.Vector3 | null): void {
  const b = sys._roverRide;
  if (!b) return;
  const yaw = rigYawOf(b.yaw);
  const c = sys.controller;
  _exit.copy(exitAt ?? c.position);
  groundSpot(sys, _exit);
  sys._roverRide = null;
  sys.roverHold = 0;
  sys.rig.exitRoverOrbit();
  c.reset(_exit);
  sys.bodyYaw = yaw;
  sys.bodyOffset.set(0, 0, 0);
  sys.model.root.position.copy(c.position);
  sys.model.root.quaternion.setFromAxisAngle(_up, yaw);
  if (sys.spawned && !sys.scopeHidden && !sys._inPod) sys.model.setVisible(true);
  _pivot.copy(c.position); _pivot.y += sys.eyePos.y;
  sys.rig.snapTo(_pivot, yaw);               // 하드 컷 — 궤도 자리에서 PC 뒤로 쓸고 지나가지 않는다
  // 하차 홀드의 E 가 내린 자리의 상호작용(상자 · 콘솔)을 곧장 치지 않게
  sys.holdArmed = false;
  sys.interactCooldown = Math.max(sys.interactCooldown, 0.35);
  clearPrompt(sys);
}

/** 발 자리를 지면(낮은 지형지물 윗면 포함)에 붙이고 콜라이더 밖으로 민다. */
function groundSpot(sys: PlayerSystem, p: THREE.Vector3): void {
  const w = sys.ctx.world;
  if (!w || !w.ready) return;
  const feet = Math.max(p.y, w.getHeightAt(p.x, p.z));
  p.y = w.getSurfaceY(p.x, p.z, feet);
  p.copy(w.resolveCollision(p, PLAYER_RADIUS));
}

/** 사망 · 리셋 · 백스톱: 차량 오른쪽 안전한 자리에 내린다. 타 있지 않으면 아무것도 안 한다. */
export function releaseRoverRide(sys: PlayerSystem): void {
  if (!sys._roverRide) return;
  exitRide(sys, roverSafePosition(sys, _pivot));
}

/** 탑승 중이면 좌석에서 차량 오른쪽 `ROVER_SAFE_SIDE_M` 의 지면, 아니면 null. */
export function roverSafePosition(sys: PlayerSystem, out: THREE.Vector3): THREE.Vector3 | null {
  const b = sys._roverRide;
  if (!b) return null;
  // 전방 (cos, sin) 의 오른쪽 = (-sin, cos)
  out.set(b.seat.x - Math.sin(b.yaw) * ROVER_SAFE_SIDE_M, b.seat.y, b.seat.z + Math.cos(b.yaw) * ROVER_SAFE_SIDE_M);
  groundSpot(sys, out);
  return out;
}

/** 매 프레임 (update 맨 위): 발을 좌석에 붙인다. */
export function pinToSeat(sys: PlayerSystem): void {
  const b = sys._roverRide;
  if (!b) return;
  const c = sys.controller;
  c.position.copy(b.seat);
  c.velocity.set(0, 0, 0);
  c.grounded = true;
  c.sprinting = false;
}

/** 탑승 중의 E: 하차 홀드 또는 잠김 프롬프트. `active` = 조작 가능(화면이 안 열려 있다). */
export function updateRoverPrompt(sys: PlayerSystem, dt: number, active: boolean): void {
  const b = sys._roverRide;
  if (!b) return;
  const input = sys.ctx.input;
  if (!input.isDown(Keys.INTERACT)) sys.roverHoldArmed = true;
  let text: string | null = null;
  let hold = false;
  if (active && b.canExit) {
    text = '하차';
    hold = true;
    if (input.isDown(Keys.INTERACT) && sys.roverHoldArmed) {
      sys.roverHold += dt / Math.max(0.05, ROVER_EXIT_HOLD_S);
      if (sys.roverHold >= 1) {
        sys.roverHold = 0;
        sys.roverHoldArmed = false;
        b.requestExit();
        // 솔로 · 호스트는 그 자리에서 내렸을 수 있다 — 그러면 하차 경로가 프롬프트를 이미 지웠다
        if (sys._roverRide !== b) return;
      }
    } else {
      sys.roverHold = 0;
    }
  } else {
    sys.roverHold = 0;
    if (active) text = b.lockedPrompt || null;
  }
  if (text !== sys.lastPromptText || sys.roverHold !== sys.lastHoldProgress) {
    sys.lastPromptText = text; sys.lastHoldProgress = sys.roverHold;
    sys.ctx.bus.emit('interact:promptChanged', { text, holdProgress: sys.roverHold, hold });
  }
}

function clearPrompt(sys: PlayerSystem): void {
  if (sys.lastPromptText === null && sys.lastHoldProgress <= 0) return;
  sys.lastPromptText = null; sys.lastHoldProgress = 0;
  sys.ctx.bus.emit('interact:promptChanged', { text: null, holdProgress: 0 });
}
