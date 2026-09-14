/**
 * src/player/parts/IntroWake.ts — **오프닝 기상 연출** (2026-09-14, `docs/plans/tutorial-raid.md` B).
 *
 * 이 파일이 답하는 질문: *깨어나는 동안 몸과 카메라는 무엇을 하는가.*
 *
 * `PlayerRef.playIntroWake(durationS)` 의 구현이다. 튜토리얼이 시작하면서 한 번 부르고(수치는
 * `TUTORIAL_INTRO_WAKE_S`), 그 시간 동안:
 *   - 몸은 **쓰러진 자세**로 시작해 천천히 일어난다. 새 자세를 만들지 않고 전투불능 자세
 *     (`SoldierPose.downed` → `SoldierModel.poseDowned`)의 진행도를 1 → 0 으로 되감는다 — 그 자세가 곧
 *     「등을 대고 쓰러진 산 사람」이고, 0 에서 평소 자세로 매끄럽게 넘어간다.
 *   - 이동 · 자세 · 점프 · 구르기 · 조준 · 무기 · 상호작용 · 마우스 룩이 잠긴다 (드론 조종 게이트를
 *     보는 곳들과 같은 요령 — `PlayerSystem.update` 의 `moveFrozen` · `canUseWeapons`).
 *   - 카메라는 쓰러진 몸을 옆 낮은 곳에서 비추다가 일어나는 속도에 맞춰 살짝 들어온다.
 * 끝나면 **하드 컷**으로 평소 3인칭 백뷰로 돌아가고(`setCameraOverride(null, undefined, true)` — 먼 곳에서
 * 블렌드하면 카메라가 지형을 훑는다) `player:introWakeDone` 을 낸다.
 *
 * 스스로 푸는 경우: `game:abort` · `game:newMission` · 사망 · 리셋 경로(`resetAll` · `respawnAt` ·
 * `spawnStanding` · `restoreState`). 그때는 `player:introWakeDone` 을 내지 않는다 (연출이 끝난 것이 아니다).
 */
import * as THREE from 'three';
import { TUTORIAL_INTRO_WAKE_S } from '@/shared';
import { smoothstep } from '@/core/util/MathUtil';
import type { PlayerSystem } from '../PlayerSystem';

/* 연출 기하 — 밸런스 수치가 아니라 카메라 · 자세 프레이밍이라 `model.ts` 의 `EYE_*` · `FADE_*` 와 같은 자리에 둔다. */
/** 이 진행도까지는 쓰러진 채로 있다가 그 뒤에 일어난다 (0..1). */
const WAKE_RISE_START = 0.3;
/** 카메라가 선 각도 — 몸이 보는 쪽(`bodyYaw`)에서 이만큼 돌아간 옆앞. */
const CAM_YAW_OFFSET = 2.1;
/** 카메라 거리 (시작 → 끝, m) · 높이 (발 기준, m) · 바라보는 높이 (발 기준, m). */
const CAM_DIST = [3.6, 2.7] as const;
const CAM_HEIGHT = [0.75, 1.45] as const;
const CAM_LOOK_Y = [0.35, 1.05] as const;

const _camPos = new THREE.Vector3();
const _camLook = new THREE.Vector3();

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** 0 (시작) … 1 (끝). 연출 중이 아니면 1. */
function progress(sys: PlayerSystem): number {
  if (sys.introWakeT < 0 || sys.introWakeDur <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - sys.introWakeT / sys.introWakeDur));
}

/**
 * `PlayerRef.playIntroWake`. 몸이 월드에 서 있을 때만 받는다 (죽었거나 스폰 전이면 무시).
 * 이미 돌고 있으면 길이만 새로 잡는다.
 */
export function playIntroWake(sys: PlayerSystem, durationS: number): void {
  if (!sys.spawned || sys.isDead || sys._downed) return;
  const dur = Number.isFinite(durationS) && durationS > 0 ? durationS : TUTORIAL_INTRO_WAKE_S;
  // 몸이 하던 일을 전부 내려놓는다 (차량 · 드론 · 가구 · 사다리는 각자의 해제 경로가 있다)
  sys.releaseRoverRide();
  sys.releaseDroneControl();
  sys.releaseFurniturePose('reset');
  sys.clearClimbState();
  sys.setAiming(false);
  sys.setHovering(false);
  sys.controller.cancelRoll();
  sys.controller.velocity.set(0, 0, 0);
  sys.controller.sprinting = false;
  sys.setStance('stand'); sys.standUpTimer = 0;
  sys.cancelHold(); sys.interactTarget = null;
  sys.introWakeDur = Math.max(0.1, dur);
  sys.introWakeT = sys.introWakeDur;
  // 첫 프레임부터 그 자리에서 시작한다 (블렌드해 들어가면 백뷰에서 몸으로 카메라가 훑고 지나간다)
  updateIntroCamera(sys, true);
}

/** `PlayerSystem.update` 가 매 프레임 부른다. 끝나는 프레임에 하드 컷 + `player:introWakeDone`. */
export function updateIntroWake(sys: PlayerSystem, dt: number): void {
  if (sys.introWakeT < 0) return;
  // 몸이 연출을 유지할 수 없게 됐다 (사망 · 전투불능 · 함선) — 조용히 끝낸다
  if (!sys.spawned || sys.isDead || sys._downed) { cancelIntroWake(sys); return; }
  sys.introWakeT -= dt;
  if (sys.introWakeT > 0) { updateIntroCamera(sys, false); return; }
  endIntroWake(sys);
}

/** 연출을 정상 종료한다 — 하드 컷 + `player:introWakeDone`. */
export function endIntroWake(sys: PlayerSystem): void {
  if (sys.introWakeT < 0) return;
  sys.introWakeT = -1; sys.introWakeDur = 0;
  sys.setCameraOverride(null, undefined, true);
  sys.ctx.bus.emit('player:introWakeDone', {});
}

/** 리셋 · 사망 · 새 미션: 알리지 않고 끝낸다. */
export function cancelIntroWake(sys: PlayerSystem): void {
  if (sys.introWakeT < 0) return;
  sys.introWakeT = -1; sys.introWakeDur = 0;
  sys.setCameraOverride(null, undefined, true);
}

/**
 * 쓰러진 정도 0..1 — `SoldierPose.downed` 에 실린다 (`PlayerSystem` 이 전투불능 블렌드와 큰 쪽을 쓴다).
 * 앞 `WAKE_RISE_START` 구간은 1 로 누워 있다가 그 뒤 부드럽게 0 으로 간다.
 */
export function wakeBlend(sys: PlayerSystem): number {
  if (sys.introWakeT < 0) return 0;
  return 1 - smoothstep(WAKE_RISE_START, 1, progress(sys));
}

/** 쓰러진 몸을 비추는 고정 카메라 (일어나는 만큼 눈높이로 함께 올라온다). */
function updateIntroCamera(sys: PlayerSystem, snap: boolean): void {
  const t = progress(sys);
  const feet = sys.controller.position;
  const a = sys.bodyYaw + CAM_YAW_OFFSET;
  const dist = lerp(CAM_DIST[0], CAM_DIST[1], t);
  _camPos.set(feet.x + Math.sin(a) * dist, feet.y + lerp(CAM_HEIGHT[0], CAM_HEIGHT[1], t), feet.z + Math.cos(a) * dist);
  _camLook.set(feet.x, feet.y + lerp(CAM_LOOK_Y[0], CAM_LOOK_Y[1], t), feet.z);
  sys.setCameraOverride(_camPos, _camLook, snap);
}
