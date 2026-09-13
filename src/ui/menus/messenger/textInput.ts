import { Keys } from '@/shared';

export interface TextInputHandlers {
  /** Enter (한국어 IME 가 조합 중이던 Enter 는 조합이 끝난 뒤 한 번). */
  onEnter(): void;
  /** Escape. */
  onEscape?(): void;
  /** Tab (`Keys.INVENTORY`) — 공용 닫기. */
  onTab?(): void;
}

/**
 * 메신저 입력칸 배선 (2026-09-14). 옛 `menus/social/SocialPages` 의 규약을 그대로 옮겼다:
 *   - 키는 게임에 닿지 않는다 (`Input` 은 window bubble 에서 듣는다 — 여기서 `stopPropagation`). 그래서 P 를 쳐도 패널이 안 닫힌다.
 *   - 한국어 IME 의 조합 확정 Enter 는 `isComposing`(또는 keyCode 229)로 오므로 그 자리에서 보내지 않고 `compositionend` 뒤에 보낸다.
 *   - Escape · Tab 은 호스트가 정한다 (Tab 은 공용 닫기).
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
