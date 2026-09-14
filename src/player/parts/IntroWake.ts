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
 *   - **화면은 검정에서 시작해 밝아진다** (2026-09-14 2차, 사용자 결정 — 아래 *오프닝 페이드*).
 * 끝나면 **하드 컷**으로 평소 3인칭 백뷰로 돌아가고(`setCameraOverride(null, undefined, true)` — 먼 곳에서
 * 블렌드하면 카메라가 지형을 훑는다) `player:introWakeDone` 을 낸다.
 *
 * 스스로 푸는 경우: `game:abort` · `game:newMission` · 사망 · 리셋 경로(`resetAll` · `respawnAt` ·
 * `spawnStanding` · `restoreState`). 그때는 `player:introWakeDone` 을 내지 않는다 (연출이 끝난 것이 아니다).
 *
 * ## 오프닝 페이드 (2026-09-14 2차)
 *
 * 그리는 것은 `ui/` 다 — 이 파일은 `ui:screenFade {opacity, durationS}` 로 **언제 · 얼마 동안**만 말한다
 * (opacity 1 = 완전한 검정, 0 = 투명). 규칙은 하나다: **검은 화면에 갇히지 않는다.**
 * 시작(`playIntroWake`)에 즉시 검정을 깔고, 연출을 끝내거나(`endIntroWake`) 취소하는(`cancelIntroWake`)
 * **모든 경로**가 `{opacity: 0, durationS: 0}` 으로 화면을 되돌린다 — 사망 · 전투불능 · `game:abort` ·
 * `game:newMission` · 리셋이 전부 그 둘 중 하나를 지난다.
 */
import * as THREE from 'three';
import { TUTORIAL_INTRO_WAKE_S } from '@/shared';
import { smoothstep } from '@/core/util/MathUtil';
import type { PlayerSystem } from '../PlayerSystem';

/* 연출 기하 — 밸런스 수치가 아니라 카메라 · 자세 프레이밍이라 `model.ts` 의 `EYE_*` · `FADE_*` 와 같은 자리에 둔다. */
/**
 * 이 진행도까지는 쓰러진 채로 있다가 그 뒤에 일어난다 (0..1).
 * 2026-09-14 3차: **값은 그대로**다 — 일어서는 속도를 절반으로 만든 것은 `TUTORIAL_INTRO_WAKE_S`(4.5 → 9)이고,
 * 여기는 진행도 위의 자리라 그 길이에 비례해 저절로 두 배로 늘어난다 (3.15 → 6.3 초).
 */
const WAKE_RISE_START = 0.3;
/** 카메라가 선 각도 — 몸이 보는 쪽(`bodyYaw`)에서 이만큼 돌아간 옆앞. */
const CAM_YAW_OFFSET = 2.1;
/** 카메라 거리 (시작 → 끝, m) · 높이 (발 기준, m) · 바라보는 높이 (발 기준, m). */
const CAM_DIST = [3.6, 2.7] as const;
const CAM_HEIGHT = [0.75, 1.45] as const;
const CAM_LOOK_Y = [0.35, 1.05] as const;

/* 페이드도 같은 자리에 둔다 — **밸런스 수치가 아니라 연출 진행도(0..1) 위의 자리**라 바로 위
 * `WAKE_RISE_START` 와 한 묶음이고, 길이는 csv 의 `TUTORIAL_INTRO_WAKE_S` 에 비례해 함께 늘고 준다.
 * (csv 줄로 빼려면 `shared/constants.ts` 의 `K.num` 한 줄이 필요하다 — 그 파일은 이 배치의 소유가
 *  아니라 지금은 여기 둔다.) */
/** 이 진행도까지는 완전한 검정 — 아주 짧은 뜸 (9 초 연출에서 0.36 초 = 이전 4.5 초 × 0.08 과 같은 실시간). */
const FADE_HOLD = 0.04;
/**
 * 이 진행도에 다 밝아진다. `WAKE_RISE_START`(일어나기 시작) **직전**이라 몸이 일어설 때는 이미 다 보인다.
 *
 * 2026-09-14 3차 (사용자 결정 — 「약 2초에 걸쳐 서서히 밝아진다」): 밝아지는 데 걸리는 **실시간**은
 * `(FADE_DONE − FADE_HOLD) × TUTORIAL_INTRO_WAKE_S` 다 (`updateIntroWake` 가 그 값을 `ui:screenFade.durationS`
 * 로 넘긴다). 길이가 4.5 → 9 초가 됐으므로 `0.26 − 0.04 = 0.22`, `0.22 × 9 = 1.98 초` ≈ 2 초.
 * 시각으로 풀면: 0.36 초까지 검정 → 2.34 초에 완전히 밝음 → 2.7 초(`WAKE_RISE_START` × 9)에 일어나기 시작.
 * `WAKE_RISE_START` 는 **그대로 0.3** 이라 일어서는 구간이 3.15 → 6.3 초, 즉 정확히 절반 속도가 된다.
 */
const FADE_DONE = 0.26;

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
  // 그리고 그 첫 프레임은 **아무것도 보이지 않는다** — 밝아지는 것은 `updateIntroWake` 가 건다
  fade(sys, 1, 0);
}

/** `ui:screenFade` 한 줄 (그리는 것은 `ui/`). */
function fade(sys: PlayerSystem, opacity: number, durationS: number): void {
  sys.ctx?.bus.emit('ui:screenFade', { opacity, durationS });
}

/** `PlayerSystem.update` 가 매 프레임 부른다. 끝나는 프레임에 하드 컷 + `player:introWakeDone`. */
export function updateIntroWake(sys: PlayerSystem, dt: number): void {
  if (sys.introWakeT < 0) return;
  // 몸이 연출을 유지할 수 없게 됐다 (사망 · 전투불능 · 함선) — 조용히 끝낸다
  if (!sys.spawned || sys.isDead || sys._downed) { cancelIntroWake(sys); return; }
  /*
   * 페이드를 **상태 없이** 건다: 이번 프레임에 진행도가 `FADE_HOLD` 를 넘어섰으면 그때 한 번만
   * 밝아지기 시작한다 (경계를 지나는 프레임은 하나뿐이라 새 플래그가 필요 없다).
   */
  const before = progress(sys);
  sys.introWakeT -= dt;
  const after = progress(sys);
  if (before < FADE_HOLD && after >= FADE_HOLD) {
    fade(sys, 0, Math.max(0, (FADE_DONE - FADE_HOLD) * sys.introWakeDur));
  }
  if (sys.introWakeT > 0) { updateIntroCamera(sys, false); return; }
  endIntroWake(sys);
}

/** 연출을 정상 종료한다 — 하드 컷 + `player:introWakeDone`. */
export function endIntroWake(sys: PlayerSystem): void {
  if (sys.introWakeT < 0) return;
  sys.introWakeT = -1; sys.introWakeDur = 0;
  sys.setCameraOverride(null, undefined, true);
  // 이미 밝아져 있는 것이 정상이지만(페이드는 `FADE_DONE` 에 끝난다) 짧은 연출에서도 확실히 걷는다
  fade(sys, 0, 0);
  sys.ctx.bus.emit('player:introWakeDone', {});
}

/** 리셋 · 사망 · 새 미션: 알리지 않고 끝낸다. **화면은 반드시 되돌린다** (검은 화면에 갇히지 않는다). */
export function cancelIntroWake(sys: PlayerSystem): void {
  if (sys.introWakeT < 0) return;
  sys.introWakeT = -1; sys.introWakeDur = 0;
  sys.setCameraOverride(null, undefined, true);
  fade(sys, 0, 0);
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
