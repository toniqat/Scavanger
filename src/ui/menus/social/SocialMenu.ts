import type { PlayBlock, PlayerCode, SocialPlayer } from '@/shared';
import { PLAY_BLOCK_LABELS, formatPlayerCode } from '@/shared';
import { el, setText } from '../../dom';

export interface SocialMenuActions {
  onPlay(code: PlayerCode): void;
  onWhisper(code: PlayerCode, name: string): void;
  onAdd(code: PlayerCode): void;
  /** Already confirmed by the popup below. */
  onRemove(code: PlayerCode): void;
}

/**
 * Right-click menu of a profile card plus the 친구 삭제 confirmation card (Phase 11). Both live as **direct children
 * of `ctx.uiRoot`** so they float over the ESC frame and over the community panel alike, and both are `.interactive`
 * (`#ui-root` itself is `pointer-events: none`).
 *
 * Four entries, exactly as the plan spells them out:
 *   - `같이 하기` — enabled only while `SocialRef.playBlock(code)` is null; otherwise disabled with the Korean reason
 *     from `PLAY_BLOCK_LABELS` beside it (the pure rule the server refuses with, so the UI can never disagree).
 *   - `귓속말하기` — the host closes itself and emits `chat:whisperTo`.
 *   - `친구 삭제` — friends only, and only through the confirm card (mutual removal).
 *   - `친구 추가` — non-friends only (a 최근 플레이어 row).
 *
 * It takes no blocker token: it only ever opens on top of a surface that already owns one (`'menu'` for the ESC
 * screen, `COMMUNITY_BLOCKER` for the community panel). Escape closes just the menu (capture phase,
 * `stopImmediatePropagation`), so the first Escape never also closes the screen underneath.
 */
export class SocialMenu {
  readonly root: HTMLElement;
  readonly confirm: HTMLElement;
  private items: HTMLElement;
  private confirmText: HTMLElement;
  private target: SocialPlayer | null = null;
  private pending: SocialPlayer | null = null;
  private _open = false;
  private _confirmOpen = false;

  private onDocDown = (e: MouseEvent): void => {
    if (!this._open) return;
    if (e.target instanceof Node && this.root.contains(e.target)) return;
    this.close();
  };
  private onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Escape') return;
    if (this._confirmOpen) { e.preventDefault(); e.stopImmediatePropagation(); this.closeConfirm(); return; }
    if (!this._open) return;
    e.preventDefault(); e.stopImmediatePropagation();
    this.close();
  };

  constructor(parent: HTMLElement, private readonly actions: SocialMenuActions) {
    this.root = el('div', { cls: 'sc-menu interactive', parent });
    this.root.hidden = true;
    this.items = el('div', { cls: 'sc-menu-items', parent: this.root });

    this.confirm = el('div', { cls: 'sc-confirm interactive', parent });
    this.confirm.hidden = true;
    const card = el('div', { cls: 'sc-confirm-card', parent: this.confirm });
    el('div', { cls: 'sc-confirm-title', text: '친구 삭제', parent: card });
    this.confirmText = el('div', { cls: 'sc-confirm-body', text: '', parent: card });
    const foot = el('div', { cls: 'sc-confirm-foot', parent: card });
    const no = el('button', { cls: 'ui-btn small', text: '취소', parent: foot });
    const yes = el('button', { cls: 'ui-btn small danger', text: '삭제', parent: foot });
    no.addEventListener('click', (e) => { e.stopPropagation(); this.closeConfirm(); });
    yes.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = this.pending;
      this.closeConfirm();
      if (p) this.actions.onRemove(p.code);
    });
    this.confirm.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousedown', this.onDocDown, true);
    window.addEventListener('keydown', this.onKey, true);
  }

  get isOpen(): boolean { return this._open; }
  get isConfirmOpen(): boolean { return this._confirmOpen; }
  /** 아이디 the menu is aimed at, or null (debug). */
  get targetCode(): PlayerCode | null { return this.target?.code ?? null; }

  /** Open the menu for one card. `block` is the caller's `SocialRef.playBlock(code)` verdict. */
  openAt(p: SocialPlayer, isFriend: boolean, block: PlayBlock | null, x: number, y: number): void {
    this.target = p;
    this.items.replaceChildren();
    this.entry('play', '같이 하기', block === null, block ? PLAY_BLOCK_LABELS[block] : '');
    this.entry('whisper', '귓속말하기', true, '');
    if (isFriend) this.entry('remove', '친구 삭제', true, '');
    else this.entry('add', '친구 추가', true, '');
    this.root.hidden = false;
    this._open = true;
    // Clamp inside the viewport (the card can sit at the bottom-right of the column).
    const w = 190, h = this.items.childElementCount * 34 + 12;
    this.root.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, x))}px`;
    this.root.style.top = `${Math.max(6, Math.min(window.innerHeight - h - 6, y))}px`;
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    this.target = null;
  }

  private entry(act: string, label: string, enabled: boolean, why: string): void {
    const b = el('button', { cls: `sc-mi${enabled ? '' : ' is-off'}`, parent: this.items });
    b.dataset.act = act;
    el('span', { cls: 'l', text: label, parent: b });
    if (why) el('span', { cls: 'w', text: why, parent: b });
    b.disabled = !enabled;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = this.target;
      if (!p || !enabled) return;
      this.close();
      switch (act) {
        case 'play': this.actions.onPlay(p.code); break;
        case 'whisper': this.actions.onWhisper(p.code, p.name); break;
        case 'add': this.actions.onAdd(p.code); break;
        case 'remove': this.openConfirm(p); break;
        default: break;
      }
    });
  }

  private openConfirm(p: SocialPlayer): void {
    this.pending = p;
    this._confirmOpen = true;
    setText(this.confirmText, `${p.name || '이름 없음'} (${formatPlayerCode(p.code)}) 을(를) 친구 목록에서 제거합니다. 상대의 목록에서도 사라집니다.`);
    this.confirm.hidden = false;
  }

  private closeConfirm(): void {
    this._confirmOpen = false;
    this.pending = null;
    this.confirm.hidden = true;
  }

  dispose(): void {
    window.removeEventListener('mousedown', this.onDocDown, true);
    window.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
    this.confirm.remove();
  }
}
