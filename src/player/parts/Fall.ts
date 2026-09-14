/**
 * src/player/parts/Fall.ts — **낙하 피해** (2026-09-14, `docs/plans/tutorial-raid.md` B, 사용자 결정).
 *
 * 이 파일이 답하는 질문: *떨어져서 착지했을 때 얼마나 아픈가.*
 *
 * **튜토리얼 전용이 아니라 게임 전역 기능이다.** 높이를 재는 곳은 `PlayerController`(`MoveResult.fallHeight` —
 * 낙하가 시작된 높이와 착지 높이의 차, 면제된 낙하는 0)이고, 그 높이를 피해로 바꾸는 곳이 여기 하나다.
 *
 *   피해 = min(`FALL_DAMAGE_MAX`, (높이 − `FALL_DAMAGE_SAFE_M`) × `FALL_DAMAGE_PER_M`)
 *
 * 수치는 전부 `data/constants.csv` 에 있다. 피해는 **새 경로를 만들지 않고** `applyDamage` 를 그대로 타므로
 * 실드 → 체력 순서 · 방탄복 마모 · 피격 연출 · 인내(grit) · 전투불능 규칙이 평소와 한 글자도 다르지 않다.
 *
 * 자리마다 규칙이 다른 곳은 튜토리얼 월드뿐이다 — `ctx.world.tutorial?.fallRule(착지 자리)`:
 *   `kill`   즉사 (절벽 1 — 넘지 못하면 체크포인트로 돌아간다)
 *   `clamp`  피해는 들어가되 체력이 1 밑으로 내려가지 않는다 (절벽 2 — 반드시 살아서 착지한다)
 *   `normal` 위 식 그대로 (`ctx.world.tutorial` 이 null 인 본편은 늘 이쪽이다)
 *
 * 피해가 실제로 들어갔을 때만 `player:fell {height, damage, rule}` 을 낸다 (튜토리얼 단계 · HUD · 오디오가 읽는다).
 */
import { FALL_DAMAGE_MAX, FALL_DAMAGE_PER_M, FALL_DAMAGE_SAFE_M, type TutorialFallRule } from '@/shared';
import type { PlayerSystem } from '../PlayerSystem';

/** 순수 식: `height` m 를 떨어졌을 때의 기본 피해 (안전 높이 이하면 0). 스모크 · 콘솔이 같이 쓴다. */
export function fallDamageFor(height: number): number {
  if (!Number.isFinite(height) || height <= FALL_DAMAGE_SAFE_M) return 0;
  return Math.min(FALL_DAMAGE_MAX, (height - FALL_DAMAGE_SAFE_M) * FALL_DAMAGE_PER_M);
}

/**
 * 몸이 이번에 **피해를 받을 수 있는 상태로 땅에 닿았나.** 컨트롤러가 이미 거른 것(갈고리 · 부양 · 차량 발판 ·
 * 사다리 · 함선 실내)과 별개로, 몸이 아예 「떨어질 수 없는」 상태였던 경우를 여기서 한 번 더 막는다 —
 * 탑승자는 어떤 피해도 받지 않는다는 규칙(탐사 차량)이 여기에도 그대로 걸린다.
 */
function canTakeFall(sys: PlayerSystem): boolean {
  if (!sys.spawned || sys.isDead || sys._downed) return false;
  if (sys._roverRide) return false;              // 2026-09-13: 탐사 차량 탑승자는 어떤 피해도 받지 않는다
  if (sys._droneControl) return false;           // 2026-09-11: 몸은 앉아 있다 — 떨어진 것은 드론이다
  if (sys._inPod || sys.isDropping) return false;// 헬포드 강하 착지 · 발사 포드
  if (sys.controller.climbing) return false;     // 사다리
  if (sys._interior !== null || sys.shipBounds !== null) return false;   // 함선 실내 · 탈출선 화물칸
  if (sys.carriedSocket !== null || sys.attachedParent !== null) return false;
  if (sys.introWaking) return false;             // 오프닝 기상 연출 중
  if (!sys.ctx.isGameplayPhase()) return false;  // 함선(허브) · 결과 화면에서는 떨어져도 아프지 않다
  return true;
}

/**
 * `MoveResult.fallHeight > 0` 인 프레임에 `PlayerSystem.update` 가 부른다. 튜토리얼 규칙까지 적용하고
 * 실제로 깎인 만큼을 `player:fell` 로 알린다.
 */
export function onLanded(sys: PlayerSystem, height: number): void {
  if (!(height > 0) || !canTakeFall(sys)) return;
  const ctx = sys.ctx;
  let rule: TutorialFallRule = 'normal';
  try { rule = ctx.world?.tutorial?.fallRule(sys.controller.position) ?? 'normal'; } catch { rule = 'normal'; }

  const before = sys.hp + sys.shield;
  if (rule === 'kill') {
    // 절벽 1: 높이와 무관하게 즉사 — 시체 · 체크포인트 흐름은 game/ 이 평소대로 맡는다
    if (before <= 0) return;
    sys.hp = 0;
    sys.die();
    emitFell(sys, height, before, rule);
    return;
  }

  let damage = fallDamageFor(height);
  if (damage <= 0) return;
  if (rule === 'clamp') {
    // 절벽 2: 체력 1 은 남긴다. 실드부터 먹는 순서는 그대로이므로 「실드 + 체력 − 1」 이 곧 상한이다.
    damage = Math.min(damage, Math.max(0, before - 1));
    if (damage <= 0) return;
  }
  sys.applyDamage(damage, undefined, false);
  emitFell(sys, height, before, rule);
}

/** 실제로 깎인 만큼(실드 + 체력)을 세어 `player:fell` 을 낸다. 0 이면 아무것도 내지 않는다 (무적 시간 등). */
function emitFell(sys: PlayerSystem, height: number, before: number, rule: TutorialFallRule): void {
  const dealt = Math.max(0, before - (sys.hp + sys.shield));
  if (dealt <= 0) return;
  sys.ctx.bus.emit('player:fell', { height, damage: dealt, rule });
}
