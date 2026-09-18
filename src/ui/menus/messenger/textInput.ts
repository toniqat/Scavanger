import { Keys } from '@/shared';

export interface TextInputHandlers {
  /** Enter (an Enter the Korean IME was still composing arrives once, after the composition ends). */
  onEnter(): void;
  /** Escape. */
  onEscape?(): void;
  /** Tab (`Keys.INVENTORY`) — the universal close. */
  onTab?(): void;
}

/**
 * Messenger text input wiring (2026-09-14). The old `menus/social/SocialPages` contract moved here unchanged:
 *   - the keys never reach the game (`Input` listens on the window bubble — `stopPropagation` here). So typing a p never closes the panel.
 *   - the Korean IME’s committing Enter arrives with `isComposing` (or keyCode 229), so it is not sent there but after `compositionend`.
 *   - Escape · Tab are the host’s decision (Tab is the universal close).
 */
export function wireTextInput(input: HTMLInputElement, h: TextInputHandlers): void {
  let composing = false;
  let sendAfterCompose = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    if (!sendAfterCompose) return;
    sendAfterCompose = false;
    window.setTimeout(() => { if (!composing) h.onEnter(); }, 0);
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229 || composing) {
      if (e.code === Keys.INVENTORY) e.preventDefault();
      if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat) { e.preventDefault(); sendAfterCompose = true; }
      return;
    }
    sendAfterCompose = false;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      if (!e.repeat) h.onEnter();
    } else if (e.code === 'Escape') {
      e.preventDefault();
      h.onEscape?.();
    } else if (e.code === Keys.INVENTORY) {
      e.preventDefault();
      if (!e.repeat) h.onTab?.();
    }
  });
}
