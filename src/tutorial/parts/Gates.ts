import type { TutorialGate, TutorialHudPart, TutorialStepId } from '@/shared';
import { TUTORIAL_TRACK_STEPS } from '@/shared';
import { HUD_GEAR_STEP, HUD_STAMINA_STEP, TUTORIAL_STASH_WHITELIST, blockedBy, type HudRevealState } from '../model';
import { stepDef, trackOf } from '../Steps';

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

/**
 * 숨김 전용 게이트 — 튜토리얼이 도는 동안에는 언제나 감춘다.
 * `matchmaking` = 함선 터미널의 **매칭 탭**째 (2026-09-15 — 옛 머리 우상단 `매칭` 버튼 · 매칭 팝업이 탭으로 바뀌었다;
 * 뜻은 그대로 「혼자 한 바퀴 돌게 한다」). 소비자는 `hub/ui/HubMenu` 하나다.
 * 2026-09-14: `community` 는 여기서 빠졌다 — 함선 트랙의 `messenger` 가 메신저를 **써야** 했기 때문이다 (2026-09-15 까지는
 * `ravenQuest` 도). 빠져도 동작은 같다: `allow.community` 가 없는 단계는 `blockReason` 이 막고 `hides` 가 그것을 그대로 읽는다.
 * 2026-09-16: `messenger` 도 순서에서 빠져 **순서 안의 어떤 단계도 `community` 를 열지 않는다** — 트랙이 도는 동안 메신저는 늘 감춰진다.
 */
const ALWAYS_HIDDEN: readonly TutorialGate[] = ['matchmaking'];

/* ── HUD 점진 노출 (2026-09-14) ────────────────────────────────────────────
 * 숨김 전용이고 **레이드 트랙 안에서만** 산다 — 함선 · 증축 트랙에서는 평소 화면이 한 글자도 안 바뀐다.
 * 규칙은 셋뿐이다:
 *   • `vitals` · `weapon`  — 시체에서 장비를 얻는 단계(`corpseLoot`)를 **지나기 전까지** 숨김.
 *   • `stamina`            — 처음 소모되기 전까지 숨김 (늦어도 `sprintJump` 를 지나면 보인다 — 새로고침 보험).
 *   • `implant`·`stratagem`— 튜토리얼 레이드 **내내** 숨김 (가진 것이 없다).
 * ──────────────────────────────────────────────────────────────────────── */

const RAID_STEPS = TUTORIAL_TRACK_STEPS.raid;

function hudHidden(step: TutorialStepId, id: string | undefined, st: HudRevealState): boolean {
  const i = RAID_STEPS.indexOf(step);
  if (i < 0 || id === undefined) return false;   // 레이드 트랙이 아니거나 id 없는 질의 = 감추지 않는다
  switch (id as TutorialHudPart) {
    case 'implant':
    case 'stratagem': return true;
    case 'vitals':
    case 'weapon': return i <= RAID_STEPS.indexOf(HUD_GEAR_STEP);
    case 'stamina': return !st.staminaUsed && i <= RAID_STEPS.indexOf(HUD_STAMINA_STEP);
    /*
     * 2026-09-14 2차 (사용자 결정) — 탈출 함선 표시. 화면(나침반) 마커와 상단 탈출 타이머는 레이드 내내 없다 —
     * 튜토리얼 함선은 자동 출발을 걸지 않으므로 「자동 출발까지」가 거짓말이다.
     *
     * 2026-09-14 4차 (사용자 결정) — **지도 · 월드 마커도 레이드 내내 없다.** 예전에는 `extract` 단계에서 풀렸는데
     * (`i < RAID_STEPS.indexOf('extract')`), 그 순간 함선 위에 떠오르는 초록 원(`.wmarker.ship` — CSS 원이라
     * 3D 구체처럼 보인다)이 「저게 뭐지」가 됐다. 튜토리얼 맵은 일직선 통로라 마커 없이도 함선을 못 찾을 수 없다.
     */
    case 'shipMarker':
    case 'shipScreenMarker':
    case 'extractionTimer': return true;
    default: return false;
  }
}

/** `hides('hud', …)` 가 아무것도 감추지 않는 기본 상태 (튜토리얼이 꺼져 있을 때 · 호출부가 안 넘겼을 때). */
const HUD_NONE: HudRevealState = { staminaUsed: true };

/**
 * `stashItem` (2026-09-09) — 함선 창고 격자의 아이템 하나. 단계마다 다른 허용 목록이 아니라 **증축 트랙 내내 같은
 * 흰 목록**(지급 재료 · 만든 소총 · 만든 탄약)이라 `Steps.ts` 의 `allow` 에 적지 않고 여기서 직접 본다.
 * `allow.stashItem === true`(`raid` · `extract`)면 전부 연다. id 없는 호출은 "완전히 열려 있나"라 그때만 null.
 */
function stashItemBlock(step: TutorialStepId, allow: true | readonly string[] | undefined, id: string | undefined): string | null {
  if (allow === true) return null;
  if (id === undefined) return null;
  // 2026-09-14: 흰 목록은 **증축 트랙의 것**이다 — 창고를 안내에 쓰는 트랙이 거기뿐이다. 레이드에서 돌아온
  //   사람의 전리품을 함선 트랙이 감추면 곤란하다.
  if (trackOf(step) !== 'build') return null;
  if (TUTORIAL_STASH_WHITELIST.includes(id)) return null;
  return '튜토리얼 중에는 안내에 쓰는 재료와 만든 것만 보입니다';
}

/**
 * `shipManage` (2026-09-16 2차, 사용자 결정) — 시설 관리(함선 관리 모드) 진입. **함선 트랙이 도는 동안에만** 막는다: 능력치를 나눠 주는
 * 안내 한가운데에서 M 으로 관리 카메라에 들어가면 메뉴 · 캐릭터 탭 안내가 통째로 가려진다. 단계 표의 `allow` 로 적지 않는 이유는
 * 「적지 않은 게이트는 막힌다」는 기본 규칙이 증축 트랙(`manage` 가 바로 이것을 연다) · 레이드 트랙까지 막아 버리기 때문이다.
 */
const shipManageBlocked = (step: TutorialStepId): boolean => trackOf(step) === 'ship';

/**
 * `step` 에서 `gate`(+ `id`)가 막히는지. 막히면 한국어 사유, 아니면 null.
 * `step` 이 null(비활성)이면 호출부가 부르기 전에 걸러 주지만, 방어적으로 여기서도 null 을 돌려준다.
 */
export function blockReason(step: TutorialStepId | null, gate: TutorialGate, id?: string): string | null {
  if (!step) return null;
  // `hud` 는 **숨김 전용**이다 — 아무것도 "막지" 않는다 (막힌 것을 숨기는 규칙의 예외, 위 절 참고)
  if (gate === 'hud') return null;
  if (gate === 'shipManage') return shipManageBlocked(step) ? '튜토리얼 중에는 시설 관리를 열 수 없습니다' : null;
  // 인벤토리 탭은 언제나 열려 있다 — 장착 · 제작 · 탄약 넣기가 전부 그 창에서 일어난다
  if (gate === 'screenTab' && (id === undefined || id === 'inventory')) return null;
  const def = stepDef(step);
  const allow = def.allow?.[gate];
  if (gate === 'stashItem') return stashItemBlock(step, allow, id);
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
export function hides(step: TutorialStepId | null, gate: TutorialGate, id?: string, hud: HudRevealState = HUD_NONE): boolean {
  if (!step) return false;
  if (gate === 'hud') return hudHidden(step, id, hud);
  if (gate === 'shipManage') return shipManageBlocked(step);
  if (ALWAYS_HIDDEN.includes(gate)) return true;
  if (id !== undefined) return blockReason(step, gate, id) !== null;
  return stepDef(step).allow?.[gate] !== true;
}
