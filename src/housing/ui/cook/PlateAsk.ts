/**
 * src/housing/ui/cook/PlateAsk.ts — **the 「식탁의 요리를 바꿉니다」 warning** (2026-09-16 the plate model, user's decision).
 *
 * The ship's dining table holds one plate only and cooking again **replaces** the old one — it cannot be undone, so it asks **before** the cook starts
 * (both the cook bench screen's 「조리 시작」 and the cook overlay result's 「다시 만들기」). It uses the shared `openHoldAsk`, exactly as the project's confirm rule says:
 * confirm = a `UI_HOLD_CONFIRM_S` hold, Enter does not confirm, Escape = cancel, initial focus = cancel.
 *
 * One at a time (`sys.plateAsk`) — when the screen that raised it is closed by force (`closePlateAsk`) it closes calling nothing. Stopping the cook mid-way leaves the
 * plate as it stands (the plate changes **when the meal ends**, `parts/Cooking.completeCookRun`).
 */
import type { HoldAskHandle } from '@/shared';
import { getMealDef, mealQualityStars, normalizeMealQuality, openHoldAsk } from '@/shared';
import type { HousingSystem } from '../../HousingSystem';

export interface PlateAskState {
  handle: HoldAskHandle;
  /** Smoke tests: confirms without the hold (`cookDebug.confirmReplace`). */
  confirm(): void;
}

/** The marker smoke tests · CSS find this popup by (`.sh-ask[data-ask]`). */
export const PLATE_ASK_ID = 'cook-replace-plate';

/**
 * With a plate on the dining table, raises the warning and returns true (`onConfirm` once confirmed); with none it raises nothing and returns false — the caller starts straight away.
 * `mealDefId` = the meal about to be made.
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

/** Closes the open warning **calling nothing** (when the screen that raised it goes away). */
export function closePlateAsk(sys: HousingSystem): void {
  const a = sys.plateAsk;
  sys.plateAsk = null;
  if (a?.handle.isOpen) a.handle.close();
}
