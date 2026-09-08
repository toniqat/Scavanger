import type { TutorialGate, TutorialStepId } from '@/shared';
import { blockedBy } from '../model';
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
 * `step` 에서 `gate`(+ `id`)가 막히는지. 막히면 한국어 사유, 아니면 null.
 * `step` 이 null(비활성)이면 호출부가 부르기 전에 걸러 주지만, 방어적으로 여기서도 null 을 돌려준다.
 */
export function blockReason(step: TutorialStepId | null, gate: TutorialGate, id?: string): string | null {
  if (!step) return null;
  // 인벤토리 탭은 언제나 열려 있다 — 장착 · 제작 · 탄약 넣기가 전부 그 창에서 일어난다
  if (gate === 'screenTab' && (id === undefined || id === 'inventory')) return null;
  const def = stepDef(step);
  const allow = def.allow?.[gate];
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

/** 지금 그 요소를 숨겨야 하는가. */
export function hides(step: TutorialStepId | null, gate: TutorialGate): boolean {
  if (!step) return false;
  if (ALWAYS_HIDDEN.includes(gate)) return true;
  return false;
}
