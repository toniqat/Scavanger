/**
 * src/player/parts/FurniturePose.ts — **가구에 몸을 맡기는 동안 몸은 무엇을 하는가** (2026-09-12, A-3a · A-3e).
 *
 * `PlayerRef.setFurniturePose` / `furniturePose` / `setFurniturePoseDrive` 의 구현 (호출자: hub — 흔들의자 앉기 · 운동 기구,
 * 계약: `shared/types.ts` 끝 · `player:furniturePoseEnded`). 설계: `docs/plans/a3a-a3e.md` §5 · §6-5.
 *
 * - **함선에서만.** `ctx.phase !== 'hub'` · 스폰 전 · 사망 · 전투불능 · 드론 조종 · 사다리 · 포드 · 헬포드 · 업힘 · 들쳐메기 ·
 *   부모에 붙음 · 탈출선 박스면 거절하고 아무것도 바꾸지 않는다. UI 블로커(운동 화면)나 `controlsEnabled` 는 보지 않는다 —
 *   운동 세션은 화면이 열린 채로 자세를 건다.
 * - **자세 중**: 이동 · 점프 · 자세 키 · 구르기 · 조준 · 무기 · 들쳐메기 · E 상호작용이 없다. 컨트롤러는 돌지 않고(콜라이더
 *   해소 없음) 발은 `(anchor.x, 직전 발 높이, anchor.z)` 에 박힌다 — 그래서 `position` 은 가구 위, 높이는 바닥이다.
 *   모델 루트는 `anchor` 로 미끄러져 가고(블렌드) 몸의 오프셋은 `SoldierModel.poseFurniture` 가 anchor 기준으로 정한다.
 * - `releaseOnInteract` 면 E 가 풀기다 (`interact`) — 키를 `consume` 하고 상호작용 쿨다운을 걸어 같은 누름이 가구 프롬프트를
 *   다시 치지 않는다. 앉아 있는 동안 캡션은 `일어나기` 하나.
 * - `camera` 가 있으면 `rig.setOverride(pos, look)` 로 **블렌드**하고 마우스 시점을 리그에 넣지 않는다. 풀 때 오버라이드가
 *   **아직 우리 것일 때만** 걷는다(`CameraRig.overrideMatches` — 그사이 도킹 컷씬이 걸었으면 건드리지 않는다).
 * - **풀면** 발은 직전 자리, 자세는 직전 자세로 즉시 돌아가고 몸 방향 · 모델은 블렌드로 돌아온다. `reset` 은 모델까지 즉시.
 * - 2026-09-12 (캐릭터 버프): `furnitureUid` 를 받아 두고 `furniturePoseState`(와이어 모양, **누적 위상**)를 낸다. 자세가 서거나
 *   풀리면 버프 목록을 다시 모으게 한다(`buffsDirty`). 블렌드 · 루트 · 몸 방향 · `SoldierPose` 쓰기의 식은 `model.ts` 의 공용
 *   함수 — `RemoteAvatar` 가 원격 자세를 같은 식으로 그린다.
 */
import { Keys, type FurniturePose, type FurniturePoseKind, type FurniturePoseState as FurniturePoseWire } from '@/shared';
import { dampAngle } from '@/core/util/MathUtil';
import type { SoldierPose } from '../SoldierModel';
import {
  FURN_BENCH_REP_S, FURN_COOK_CYCLE_PER_S, FURN_CYCLE_REV_PER_S, FURN_EYE, FURN_RUN_STEPS_PER_S, FURN_STAND_PROMPT, FURN_YAW_RATE, _up,
  furnitureBodyYaw, lerpFurnitureRoot, stepFurnitureBlend, writeFurniturePose,
} from '../model';
import type { PlayerSystem } from '../PlayerSystem';

export type FurniturePoseEndReason = 'interact' | 'caller' | 'reset';

/** 2026-09-13: `cook` = 조리대 앞에 서서 손을 놀리는 자세 (anchor = 바닥, 몸의 기하는 `SoldierModel.FURN_COOK`). */
const KINDS: readonly FurniturePoseKind[] = ['sit', 'bench', 'run', 'cycle', 'cook'];
/** 위상이 감기며 주기 수를 세는 자세 — 와이어의 누적 위상이 `steps + phase` 다. */
const isCountingKind = (k: FurniturePoseKind | null): boolean => k === 'run' || k === 'cycle' || k === 'cook';
const TAU = Math.PI * 2;
/** 조각 uid 로 받아 두는 모양 — 버프 · 와이어 검증(`sanitizeCharBuffs`)과 같은 문자 집합. */
const UID_RE = /^[A-Za-z0-9_:\-.]{1,64}$/;

const finite3 = (v: { x: number; y: number; z: number } | null | undefined): boolean =>
  !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** 자세를 **유지**해도 되는가. 거짓이 되면 `update` 맨 위의 백스톱이 `reset` 으로 푼다. */
export function canHoldFurniturePose(sys: PlayerSystem): boolean {
  if (!sys.spawned || sys.isDead || sys._downed) return false;
  if (!sys.ctx || sys.ctx.phase !== 'hub') return false;
  if (sys._droneControl || sys.controller.climbing || sys._inPod) return false;
  if (sys.carriedSocket !== null || sys.attachedParent !== null || sys.shipBounds !== null) return false;
  return !(sys.hellpod.isActive && sys.hellpod.state !== 'exiting');
}

export function setFurniturePose(sys: PlayerSystem, pose: FurniturePose | null): boolean {
  if (!pose) { releaseFurniturePose(sys, 'caller'); return true; }
  if (!KINDS.includes(pose.kind) || !finite3(pose.anchor) || !Number.isFinite(pose.yaw)) return false;
  if (pose.camera && (!finite3(pose.camera.position) || !finite3(pose.camera.lookAt))) return false;
  if (!canHoldFurniturePose(sys) || sys._carrying || sys.carryLock > 0) return false;

  const f = sys.furn, c = sys.controller;
  if (f.kind === null) {
    // 처음 앉는다: 돌아갈 자리를 적고 진행 중인 행동을 전부 끊는다
    f.restorePos.copy(c.position);
    f.restoreYaw = sys.bodyYaw;
    f.restoreStance = sys._stance;
    sys.setAiming(false);
    sys.cancelHold();
    if (c.rolling) c.cancelRoll();
    sys.setGrappleTarget(null);
    sys.setHovering(false);
    sys.meleeTimer = 0;
    if (c.sprinting) { c.sprinting = false; sys.ctx.bus.emit('player:sprintChanged', { sprinting: false }); }
    if (sys._stance !== 'stand') sys.setStance('stand');
    sys.standUpTimer = 0;
    f.driven = false; f.phase = 0; f.steps = 0; f.clock = 0;
  } else if (f.kind !== pose.kind) {
    // 다른 기구로 바로 옮겨 탔다: 돌아갈 자리는 처음 것 그대로, 위상만 새로
    f.driven = false; f.phase = 0; f.steps = 0; f.clock = 0;
  }
  f.kind = pose.kind;
  f.visKind = pose.kind;
  f.releaseOnInteract = !!pose.releaseOnInteract;
  f.anchor.copy(pose.anchor);
  f.yaw = pose.yaw;
  f.furnitureUid = typeof pose.furnitureUid === 'string' && UID_RE.test(pose.furnitureUid) ? pose.furnitureUid : null;
  if (pose.camera) {
    f.hasCamera = true;
    f.camPos.copy(pose.camera.position);
    f.camLook.copy(pose.camera.lookAt);
    sys.rig.setOverride(f.camPos, f.camLook);   // blend in (damp 12) — consumed in this system's lateUpdate
  } else {
    releaseCamera(sys);
  }
  pinBody(sys);
  sys.buffsDirty = true;   // 2026-09-12: 휴식 중 / 운동 중 버프
  return true;
}

/**
 * 자세를 푼다 (자세가 없으면 아무것도 안 한다). 발 · 자세는 즉시 직전 값으로, 몸 방향 · 모델은 `interact` · `caller` 면
 * 블렌드로 돌아오고 `reset` 이면 즉시다 (스폰 · 페이즈 변경 뒤에 옛 자세가 흘러나오지 않게).
 * `player:furniturePoseEnded {kind, reason}` 는 여기 한 곳에서만 나간다.
 */
export function releaseFurniturePose(sys: PlayerSystem, reason: FurniturePoseEndReason): void {
  const f = sys.furn;
  const kind = f.kind;
  if (kind === null) return;
  f.kind = null;
  f.furnitureUid = null;
  sys.buffsDirty = true;
  const c = sys.controller;
  c.position.copy(f.restorePos);
  c.velocity.set(0, 0, 0);
  c.grounded = true;
  c.speed = 0;
  releaseCamera(sys);
  if (sys._stance !== f.restoreStance && !sys.isDead && !sys._downed) sys.setStance(f.restoreStance);
  sys.standUpTimer = 0;
  // 같은 프레임의 E 가 방금 일어난 가구(또는 옆의 다른 것)를 다시 치지 않게
  sys.interactCooldown = Math.max(sys.interactCooldown, 0.35);
  if (reason === 'reset') {
    f.visKind = null;
    f.blend = 0;
    sys.bodyYaw = f.restoreYaw;
    sys.model.resetPose();
    sys.model.root.position.copy(c.position);
    sys.model.root.quaternion.setFromAxisAngle(_up, sys.bodyYaw);
  }
  sys.ctx.bus.emit('player:furniturePoseEnded', { kind, reason });
}

/** 위상 0 … 1 (`bench` 는 자르고, `run` · `cycle` · `cook` 은 감는다). 자세가 없으면 무시. */
export function setFurniturePoseDrive(sys: PlayerSystem, phase: number): void {
  const f = sys.furn;
  if (f.kind === null || !Number.isFinite(phase)) return;
  f.driven = true;
  writePhase(f, phase);
}

function writePhase(f: PlayerSystem['furn'], phase: number): void {
  if (f.kind === 'bench' || f.kind === 'sit') { f.phase = Math.min(1, Math.max(0, phase)); return; }
  const p = phase - Math.floor(phase);
  // 1 → 0 으로 감기면 한 걸음 / 한 바퀴가 지난 것이다 (반대로 감기면 뒤로). `run` 의 좌우 발은 걸음 수의 홀짝이 정하고,
  // 2026-09-12 부터 `cycle` 도 바퀴 수를 센다 — 와이어의 누적 위상(`steps + phase`)이 감기지 않아야 받는 쪽이 보간한다.
  if (p < f.phase - 0.5) f.steps++;
  else if (p > f.phase + 0.5) f.steps--;
  f.phase = p;
}

/** 누적 위상 (와이어 규약): bench 0 … 1 · run 걸음 수 · cycle 바퀴 수 · cook 손 동작 주기 수 · sit 0. 자세가 없으면 0. */
export function cumulativePhase(sys: PlayerSystem): number {
  const f = sys.furn;
  if (f.kind === 'bench') return f.phase;
  if (isCountingKind(f.kind)) return f.steps + f.phase;
  return 0;
}

/** `PlayerRef.furniturePoseState` — 재사용 객체를 채워 돌려준다 (net 이 20 Hz 로 읽는다). 자세가 없으면 null. */
export function poseWireState(sys: PlayerSystem): FurniturePoseWire | null {
  const f = sys.furn;
  if (f.kind === null) return null;
  const w = f.wire;
  w.kind = f.kind;
  w.yaw = f.yaw;
  w.phase = cumulativePhase(sys);
  w.furnitureUid = f.furnitureUid;
  return w;
}

/** 걸린 카메라가 아직 우리 것이면 블렌드로 걷는다. */
function releaseCamera(sys: PlayerSystem): void {
  const f = sys.furn;
  if (!f.hasCamera) return;
  f.hasCamera = false;
  if (sys.rig && sys.rig.overrideMatches(f.camPos)) sys.rig.setOverride(null);
}

/** 발을 가구 위(높이는 직전 바닥)에 박는다 — 컨트롤러는 자세 중 돌지 않는다. */
function pinBody(sys: PlayerSystem): void {
  const f = sys.furn, c = sys.controller;
  c.position.set(f.anchor.x, f.restorePos.y, f.anchor.z);
  c.velocity.set(0, 0, 0);
  c.grounded = true;
  c.speed = 0;
  c.sprinting = false;
}

/**
 * `update` 의 자세 가지 (입력은 이미 0 이다): 스스로 도는 위상 · 발 고정 · E 로 일어나기.
 * `active` = 조작 가능(블로커 없음 · 살아 있음). 운동 화면이 열려 있으면 거짓이라 E 도 읽지 않는다.
 */
export function updateFurniturePose(sys: PlayerSystem, dt: number, active: boolean): void {
  const f = sys.furn;
  if (f.kind === null) return;
  f.clock += dt;
  if (!f.driven) {
    if (f.kind === 'bench') f.phase = 0.5 - 0.5 * Math.cos(TAU * f.clock / FURN_BENCH_REP_S);
    else if (f.kind === 'run') writePhase(f, f.phase + dt * FURN_RUN_STEPS_PER_S);
    else if (f.kind === 'cycle') writePhase(f, f.phase + dt * FURN_CYCLE_REV_PER_S);
    else if (f.kind === 'cook') writePhase(f, f.phase + dt * FURN_COOK_CYCLE_PER_S);   // 2026-09-13: 부른 쪽이 안 몰면 느린 칼질
  }
  pinBody(sys);
  const input = sys.ctx.input;
  if (f.releaseOnInteract && active && input.wasPressed(Keys.INTERACT)) {
    input.consume(Keys.INTERACT);
    releaseFurniturePose(sys, 'interact');
  }
}

/**
 * 자세 중 상호작용 캡션: 잡고 있던 대상 · 홀드는 버리고, `releaseOnInteract` 면 `일어나기` 하나만 띄운다
 * (`parts/Interact.updateInteraction` 대신 불린다).
 */
export function updatePosePrompt(sys: PlayerSystem, active: boolean): void {
  if (sys.interactTarget) { sys.cancelHold(); sys.interactTarget = null; }
  sys.holdProgress = 0;
  const f = sys.furn;
  const text = f.kind !== null && f.releaseOnInteract && active ? FURN_STAND_PROMPT : null;
  if (text !== sys.lastPromptText || sys.lastHoldProgress !== 0) {
    sys.lastPromptText = text; sys.lastHoldProgress = 0;
    sys.ctx.bus.emit('interact:promptChanged', { text, holdProgress: 0, hold: false });
  }
}

/** 자세 블렌드 감쇠. 풀린 뒤 블렌드가 다 빠지면 모델 쪽 자세도 잊는다. */
export function updatePoseBlend(sys: PlayerSystem, dt: number): void {
  const f = sys.furn;
  if (f.visKind === null) return;
  f.blend = stepFurnitureBlend(f.blend, f.kind !== null, dt);
  if (f.kind === null && f.blend < 0.005) { f.blend = 0; f.visKind = null; }
}

/** 자세 중 눈(카메라 피벗) 높이 — 발(바닥) 기준. 자세가 없으면 null. */
export function poseEyeHeight(sys: PlayerSystem): number | null {
  const f = sys.furn;
  if (f.kind === null) return null;
  return f.anchor.y - f.restorePos.y + FURN_EYE[f.kind];
}

/**
 * 몸 방향. 자세 중이면 목표(`bench` 는 머리 → 거치대라 발끝이 반대 = `yaw + π`)로 돌리고 true. 풀린 뒤 블렌드 중이면
 * 직전 방향으로 돌리되 false 를 돌려줘 평소 규칙(이동 방향 · 조준)이 이어서 덮게 한다.
 */
export function updatePoseYaw(sys: PlayerSystem, dt: number): boolean {
  const f = sys.furn;
  if (f.kind !== null) {
    sys.bodyYaw = dampAngle(sys.bodyYaw, furnitureBodyYaw(f.kind, f.yaw), FURN_YAW_RATE, dt);
    return true;
  }
  if (f.visKind !== null) sys.bodyYaw = dampAngle(sys.bodyYaw, f.restoreYaw, FURN_YAW_RATE, dt);
  return false;
}

/** 모델 자세 파라미터. `run` 은 보행 주기에 걸음 위상을 먹이고, 나머지 셋은 `SoldierModel.poseFurniture` 가 뼈대를 맡는다. */
export function applyPoseToSoldier(sys: PlayerSystem, p: SoldierPose): void {
  const f = sys.furn;
  const kind = f.visKind;
  // 풀린 뒤(블렌드 아웃)에도 마지막 위상을 그대로 그린다 — kind 가 null 이면 visKind 로 계산한다
  const cum = isCountingKind(kind) ? f.steps + f.phase : kind === 'bench' ? f.phase : 0;
  writeFurniturePose(p, kind, kind !== null ? f.blend : 0, cum);
}

/**
 * 모델 루트를 쓴다: 직전 자리(풀린 뒤에는 지금 발)에서 `anchor` 로 블렌드. 자세를 그리고 있지 않으면 false —
 * 호출자가 평소대로 쓴다.
 */
export function placeRoot(sys: PlayerSystem): boolean {
  const f = sys.furn;
  if (f.visKind === null) return false;
  const root = sys.model.root;
  root.position.copy(f.kind !== null ? f.restorePos : sys.controller.position).add(sys.bodyOffset);
  lerpFurnitureRoot(root.position, f.anchor, f.blend);
  root.quaternion.setFromAxisAngle(_up, sys.bodyYaw);
  return true;
}
