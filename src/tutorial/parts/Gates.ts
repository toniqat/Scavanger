import type { TutorialGate, TutorialStepId } from '@/shared';
import { TUTORIAL_STASH_WHITELIST, blockedBy } from '../model';
import { stepDef } from '../Steps';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/parts/Gates.ts — **게이트 판정**. 순수 함수라 상태도 ctx 도 없다.
 *
 * 규칙은 하나뿐이다: 현재 단계의 `allow` 에 그 게이트가 없으면 막고, 있으면 (배열일 때) 그 id 만 허용한다.
 * 사유 문구는 "지금 해야 하는 일"을 그대로 알려 준다 — 막힌 이유를 모르는 것이 튜토리얼에서 제일 나쁘다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 세부 사유 — 허용 목록에는 있는데 다른 id 를 골랐을 때. */
const WRONG_ID: Partial<Record<TutorialGate, string>> = {
  roomPurpose: '튜토리얼에서는 작업실만 증축합니다',
  furniture: '튜토리얼에서는 총기 작업대만 다룹니다',
  craft: '튜토리얼에서 지금 만들 것은 따로 있습니다',
  planet: '튜토리얼에서는 첫 번째 행성으로만 갑니다',
};

/** 숨김 전용 게이트 — 튜토리얼이 도는 동안에는 언제나 감춘다. */
const ALWAYS_HIDDEN: readonly TutorialGate[] = ['community', 'matchmaking'];

/**
 * `stashItem` (2026-09-09) — 함선 창고 격자의 아이템 하나. 단계마다 다른 허용 목록이 아니라 **튜토리얼 내내 같은
 * 흰 목록**(지급 재료 · 만든 소총 · 만든 탄약)이라 `Steps.ts` 의 `allow` 에 적지 않고 여기서 직접 본다.
 * `allow.stashItem === true`(`raid`)면 전부 연다. id 없는 호출은 "완전히 열려 있나"라 그때만 null.
 */
function stashItemBlock(allow: true | readonly string[] | undefined, id: string | undefined): string | null {
  if (allow === true) return null;
  if (id === undefined) return null;
  if (TUTORIAL_STASH_WHITELIST.includes(id)) return null;
  return '튜토리얼 중에는 안내에 쓰는 재료와 만든 것만 보입니다';
}

/**
 * `step` 에서 `gate`(+ `id`)가 막히는지. 막히면 한국어 사유, 아니면 null.
 * `step` 이 null(비활성)이면 호출부가 부르기 전에 걸러 주지만, 방어적으로 여기서도 null 을 돌려준다.
 */
export function blockReason(step: TutorialStepId | null, gate: TutorialGate, id?: string): string | null {
  if (!step) return null;
  // 인벤토리 탭은 언제나 열려 있다 — 장착 · 제작 · 탄약 넣기가 전부 그 창에서 일어난다
  if (gate === 'screenTab' && (id === undefined || id === 'inventory')) return null;
  const def = stepDef(step);
  const allow = def.allow?.[gate];
  if (gate === 'stashItem') return stashItemBlock(allow, id);
  if (allow === undefined) {
    if (gate === 'community') return '튜토리얼 중에는 사용할 수 없습니다';
    if (gate === 'screenTab') return '튜토리얼 중에는 인벤토리 탭만 쓸 수 있습니다';
    return blockedBy(def.title);
  }
  if (allow === true) return null;
  if (id !== undefined && allow.includes(id)) return null;
  if (id === undefined) return null;               // id 를 안 준 호출은 "이 종류가 열려 있나"만 묻는 것
  return WRONG_ID[gate] ?? blockedBy(def.title);
}

/**
 * 지금 그 요소를 **그리지 말아야** 하는가 (2026-09-08).
 *
 * 사용자 결정: 잠긴 항목을 "튜토리얼에서는 ~" 사유와 함께 남겨 두지 않고 **아예 숨긴다**. 그래서
 *   • `id` 를 준 호출 = 항목 하나 — `blockReason` 이 막는 것은 곧 숨기는 것이다.
 *   • `id` 없는 호출 = "이 게이트가 **완전히** 열려 있나" — 열려 있지 않으면 그 UI 자체를 좁힌다
 *     (행성 넘김 화살표처럼 "고를 수 있는 것이 하나뿐"인 자리).
 * 튜토리얼이 끝나거나 건너뛰어지면 `step` 이 null 이라 전부 false 로 돌아간다 — 잠금과 숨김이 함께 풀린다.
 */
export function hides(step: TutorialStepId | null, gate: TutorialGate, id?: string): boolean {
  if (!step) return false;
  if (ALWAYS_HIDDEN.includes(gate)) return true;
  if (id !== undefined) return blockReason(step, gate, id) !== null;
  return stepDef(step).allow?.[gate] !== true;
}
