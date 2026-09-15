/**
 * src/housing/ui/cook/PlateAsk.ts — **「식탁의 요리를 바꿉니다」 경고** (2026-09-16 접시 모델, 사용자 결정).
 *
 * 함선의 식탁에는 접시가 하나뿐이고 다시 요리하면 옛 접시가 **바뀐다** — 되돌릴 수 없으므로 조리를 **시작하기 전에** 묻는다
 * (조리대 화면의 「조리 시작」 · 조리 오버레이 결과의 「다시 만들기」 둘 다). 프로젝트 확인 규칙 그대로 공용 `openHoldAsk` 를 쓴다:
 * 확정 = `UI_HOLD_CONFIRM_S` 홀드, Enter 는 확정하지 않는다, Escape = 취소, 최초 포커스 = 취소.
 *
 * 한 번에 하나다 (`sys.plateAsk`) — 띄운 화면이 강제로 닫히면(`closePlateAsk`) 아무것도 부르지 않고 닫는다. 중간에 조리를 그만두면 접시는
 * 그대로 남는다 (접시는 요리가 **끝날 때** 바뀐다, `parts/Cooking.completeCookRun`).
 */
import type { HoldAskHandle } from '@/shared';
import { getMealDef, mealQualityStars, normalizeMealQuality, openHoldAsk } from '@/shared';
import type { HousingSystem } from '../../HousingSystem';

export interface PlateAskState {
  handle: HoldAskHandle;
  /** 스모크: 홀드 없이 확정 (`cookDebug.confirmReplace`). */
  confirm(): void;
}

/** 스모크 · CSS 가 이 팝업을 찾는 표식 (`.sh-ask[data-ask]`). */
export const PLATE_ASK_ID = 'cook-replace-plate';

/**
 * 식탁에 접시가 있으면 경고를 띄우고 true (확정되면 `onConfirm`), 접시가 없으면 아무것도 띄우지 않고 false — 부른 쪽이 곧장 시작한다.
 * `mealDefId` = 이번에 만들 요리.
 */
export function askReplacePlate(sys: HousingSystem, mealDefId: string, onConfirm: () => void): boolean {
  const plate = sys.getPlate();
  if (!plate) return false;
  closePlateAsk(sys);
  const q = normalizeMealQuality(plate.quality);
  const oldName = `${getMealDef(plate.mealDefId)?.name ?? plate.mealDefId}${q > 0 ? ` ${mealQualityStars(q)}` : ''}`;
  const newName = getMealDef(mealDefId)?.name ?? mealDefId;
  const prog = sys.ctx.progression;
  const eaten = !!prog && prog.getMeal() === plate.mealDefId && (typeof prog.getMealQuality === 'function' ? prog.getMealQuality() : 0) === q;
  const run = (): void => {
    if (sys.plateAsk?.handle === handle) sys.plateAsk = null;
    onConfirm();
  };
  const handle = openHoldAsk(sys.ctx, {
    id: PLATE_ASK_ID,
    title: '식탁의 요리를 바꿉니다',
    body: [
      `식탁에 차려 둔 「${oldName}」 이(가) 이번 요리 「${newName}」 로 바뀝니다.`,
      eaten ? '이미 먹은 식사는 다음 레이드에 그대로 실려 있습니다.' : '아직 먹지 않았습니다 — 바뀐 접시는 되돌릴 수 없습니다.',
      '조리를 중간에 그만두면 지금 접시는 그대로 남습니다.',
    ].join('\n'),
    danger: !eaten,
    buttons: [
      { label: '취소', cancel: true, run: () => { if (sys.plateAsk?.handle === handle) sys.plateAsk = null; } },
      { label: '요리 시작', kind: eaten ? 'primary' : 'danger', hold: true, run },
    ],
    onCancel: () => { if (sys.plateAsk?.handle === handle) sys.plateAsk = null; },
  });
  sys.plateAsk = { handle, confirm: () => { if (!handle.isOpen) return; handle.close(); run(); } };
  return true;
}

/** 떠 있는 경고를 **아무것도 부르지 않고** 닫는다 (띄운 화면이 사라질 때). */
export function closePlateAsk(sys: HousingSystem): void {
  const a = sys.plateAsk;
  sys.plateAsk = null;
  if (a?.handle.isOpen) a.handle.close();
}
