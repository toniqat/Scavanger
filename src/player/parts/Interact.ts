/**
 * src/player/parts/Interact.ts — **E interaction**.
 *
 * Picks the best of the `Interactable`s on screen and, telling a tap from a hold, feeds
 * `onHoldProgress` · `onHoldCancel` (the hold time takes the stats' effect here, once only).
 */
import { Keys, type Interactable } from '@/shared';
import { _v } from '../model';
import type { PlayerSystem } from '../PlayerSystem';

/** Tell a hold interactable that its running hold was released / retargeted before completion. */
export function cancelHold(sys: PlayerSystem): void {
  const t = sys.interactTarget;
  if (t && sys.holdProgress > 0 && t.onHoldCancel) {
    try { t.onHoldCancel(); } catch (e) { console.error('[Player] onHoldCancel threw', e); }
  }
  sys.holdProgress = 0;
}

export function updateInteraction(sys: PlayerSystem, dt: number, active: boolean): void {
  const ctx = sys.ctx, input = ctx.input;
  let target: Interactable | null = null;
  if (active && sys.interactCooldown <= 0) {
    sys.rig.getForward(_v);
    target = ctx.interactables.findBest(sys.controller.position, _v);
  }
  if (target !== sys.interactTarget) { sys.cancelHold(); sys.interactTarget = target; }
  if (!input.isDown(Keys.INTERACT)) sys.holdArmed = true;
  let text: string | null = null;
  let isHold = false; // 2026-09-09: told to the prompt so the ui can draw the hold chevron over the keycap
  if (target) {
    text = target.getPrompt();
    // `재주` dexterity (Phase 5): every hold interaction runs `derived.interactSpeedMul` times faster — applied here
    // once, so interactables publish their base `holdTime` and never scale it themselves.
    const hold = (target.holdTime ?? 0) / Math.max(0.25, ctx.progression?.derived.interactSpeedMul ?? 1);
    isHold = hold > 0;
    if (hold > 0) {
      if (input.isDown(Keys.INTERACT) && sys.holdArmed) {
        sys.holdProgress += dt / hold;
        if (sys.holdProgress >= 1) {
          sys.holdArmed = false;
          sys.perform(target); sys.holdProgress = 0; target = null; text = null;
        } else if (target.onHoldProgress) {
          try { target.onHoldProgress(sys.holdProgress); } catch (e) { console.error('[Player] onHoldProgress threw', e); }
        }
      } else if (sys.holdProgress > 0) {
        // released early: the hold decays; a relay-style interactable (revive) is told once
        sys.cancelHold();
      }
    } else if (input.wasPressed(Keys.INTERACT)) {
      sys.perform(target); target = null; text = null;
    }
  } else {
    sys.holdProgress = 0;
  }
  if (text !== sys.lastPromptText || sys.holdProgress !== sys.lastHoldProgress) {
    sys.lastPromptText = text; sys.lastHoldProgress = sys.holdProgress;
    ctx.bus.emit('interact:promptChanged', { text, holdProgress: sys.holdProgress, hold: isHold });
  }
}

export function perform(sys: PlayerSystem, target: Interactable): void {
  sys.interactCooldown = 0.35;
  sys.interactTarget = null;
  /*
   * 2026-09-09: a throwing `interact()` used to be a console line and nothing else — the prompt stayed up, the key
   * did nothing, and the player had no way to tell a bug from "the game ignores me" (that is exactly how a broken
   * pod boarding was reported). The catch stays — one bad interactable must not kill the frame — but it says so.
   */
  try {
    target.interact();
  } catch (e) {
    console.error('[Player] interact threw', e);
    sys.ctx.bus.emit('ui:notify', { text: '상호작용에 실패했습니다', kind: 'warning' });
  }
  sys.ctx.bus.emit('interact:performed', { id: target.id });
  sys.ctx.bus.emit('audio:play', { id: 'interact', position: target.position, volume: 0.7 });
}
