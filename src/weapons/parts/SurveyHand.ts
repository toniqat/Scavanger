/**
 * src/weapons/parts/SurveyHand.ts — the **survey camera** as the held quick item (2026-09-21, user's decisions).
 *
 * A camera (`shared/survey.ts` `surveyCameraOf`) is an `items.csv` gadget row without a `gadgetId`, so the ordinary
 * gadget path would deny it on LMB and flip the throw mode on RMB. Instead this hand only **routes input**:
 *   - LMB held → `surveyHand.trigger` (survey/ records every subject inside its frame while it is true);
 *   - RMB held → `surveyHand.aimed`, and `WeaponSystem.update` reports `hasWeapon` so player/ enters ADS — the
 *     camera's zoom is the gun ADS mechanism (the rig narrows `camera.fov` by `aimZoom`), fed from
 *     `ctx.survey.zoom` through `Firing.applyCameraZoom`;
 *   - the zoom steps themselves (interact / reload while aimed) are read by survey/'s input gate, which runs
 *     **before** player/ so it can consume the keys ahead of the interaction prompt.
 * Nothing is consumed and nothing is used up here — the camera's durability is survey/'s (`damageDurability`).
 * The input flags are the same gate a gun trigger passes (`inputFree`: gameplay, pointer lock, `canUseWeapons`, no
 * roll, no ship call, no drone / rover latch, no wheel, not carrying).
 */
import { MouseButtons, surveyCameraOf, type SurveyHandState } from '@/shared';
import type { QuickHand } from '../model';
import type { WeaponSystem } from '../WeaponSystem';

export function makeSurveyHand(): SurveyHandState {
  return { active: false, uid: null, defId: null, trigger: false, aimed: false };
}

/** True when the item in hand is a survey camera (never the virtual detonator). */
export function isSurveyHand(q: QuickHand | null | undefined): boolean {
  return !!q && !q.detonator && !!surveyCameraOf(q.defId);
}

/**
 * Start of every weapons frame: which camera is in the hand (none while holstered), input flags cleared — only
 * `updateSurveyHand` raises them, so a frame spent swapping / reloading / in a menu reports a released trigger.
 */
export function beginSurveyFrame(sys: WeaponSystem): void {
  const h = sys.surveyHand;
  const q = sys.quick;
  const on = !sys.holstered && isSurveyHand(q);
  h.active = on;
  h.uid = on && q ? q.uid : null;
  h.defId = on && q ? q.defId : null;
  h.trigger = false;
  h.aimed = false;
}

/** The camera in hand, every frame (`updateQuickHand` hands over before any gadget / heal path reads a button). */
export function updateSurveyHand(sys: WeaponSystem, inputFree: boolean): void {
  const h = sys.surveyHand;
  const zoom = sys.ctx.survey?.zoom;
  if (typeof zoom === 'number' && zoom > 0) sys.applyCameraZoom(zoom);
  if (!inputFree || sys.quickHolsterT > 0) return;
  const input = sys.ctx.input;
  h.aimed = input.isMouseDown(MouseButtons.AIM);
  h.trigger = input.isMouseDown(MouseButtons.FIRE);
}
