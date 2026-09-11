import type { PlayBlock, PlayerCode, SocialPlayer } from '@/shared';
import { PLAY_BLOCK_LABELS, formatPlayerCode } from '@/shared';
import { el, setText } from '../../dom';

export interface SocialMenuActions {
  onPlay(code: PlayerCode): void;
  onWhisper(code: PlayerCode, name: string): void;
  onAdd(code: PlayerCode): void;
  /** Already confirmed by the popup below. */
  onRemove(code: PlayerCode): void;
  /** 2026-09-11 (B-4): `대화 기록` — the column opens its conversation page for that 아이디. */
  onHistory(code: PlayerCode, name: string): void;
  /** 2026-09-11 (B-4): `차단` (already confirmed by the popup below) / `차단 해제` (immediate — it only undoes). */
  onBlock(code: PlayerCode, blocked: boolean): void;
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
 *   - (2026-09-11, B-4) `대화 기록` — the column's conversation page with that 아이디, and `차단` behind its own
 *     confirm card. A blocked row (the column's 차단 목록) offers only `대화 기록` + `차단 해제`.
 *
 * It takes no blocker token: it only ever opens on top of a surface that already owns one (`'menu'` for the ESC
 * screen, `COMMUNITY_BLOCKER` for the community panel). Escape closes just the menu (capture phase,
 * `stopImmediatePropagation`), so the first Escape never also closes the screen underneath.
 *
 * **2026-09-08**: the confirm card is no longer 친구 삭제's alone — `askConfirm(title, body, ok, run)` is the column's
 * general 경고 팝업, and 분대 → **파티 떠나기** (`SocialColumn`) raises the same card.
 */
export class SocialMenu {
  readonly root: HTMLElement;
  readonly confirm: HTMLElement;
  private items: HTMLElement;
  private confirmTitle: HTMLElement;
  private confirmText: HTMLElement;
  private confirmOk: HTMLButtonElement;
  private target: SocialPlayer | null = null;
  /** What the confirm card runs on 확인 (null = closed). */
  private pending: (() => void) | null = null;
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
    this.confirmTitle = el('div', { cls: 'sc-confirm-title', text: '', parent: card });
    this.confirmText = el('div', { cls: 'sc-confirm-body', text: '', parent: card });
    const foot = el('div', { cls: 'sc-confirm-foot', parent: card });
    const no = el('button', { cls: 'ui-btn small', text: '취소', parent: foot });
    this.confirmOk = el('button', { cls: 'ui-btn small danger', text: '확인', parent: foot }) as HTMLButtonElement;
    no.addEventListener('click', (e) => { e.stopPropagation(); this.closeConfirm(); });
    this.confirmOk.addEventListener('click', (e) => {
      e.stopPropagation();
      const run = this.pending;
      this.closeConfirm();
      run?.();
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

  /**
   * Open the menu for one card. `block` is the caller's `SocialRef.playBlock(code)` verdict. `blocked` (2026-09-11,
   * B-4) = I blocked them: only `대화 기록` and `차단 해제` are offered then (the relay swallows everything else anyway).
   */
  openAt(p: SocialPlayer, isFriend: boolean, block: PlayBlock | null, x: number, y: number, blocked = false): void {
    this.target = p;
    this.items.replaceChildren();
    if (blocked) {
      this.entry('history', '대화 기록', true, '');
      this.entry('unblock', '차단 해제', true, '');
    } else {
      this.entry('play', '같이 하기', block === null, block ? PLAY_BLOCK_LABELS[block] : '');
      this.entry('whisper', '귓속말하기', true, '');
      this.entry('history', '대화 기록', true, '');
      if (isFriend) this.entry('remove', '친구 삭제', true, '');
      else this.entry('add', '친구 추가', true, '');
      this.entry('block', '차단', true, '');
    }
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
        case 'history': this.actions.onHistory(p.code, p.name); break;
        case 'block': this.openBlockConfirm(p); break;
        case 'unblock': this.actions.onBlock(p.code, false); break;
        default: break;
      }
    });
  }

  /**
   * The column's shared 경고 팝업 (2026-09-08). 친구 삭제 raises it, and so does 분대 → 파티 떠나기; it floats over
   * whatever surface hosts the column and owns Escape while it is up (see `onKey`).
   */
  askConfirm(title: string, body: string, ok: string, run: () => void): void {
    this.close();
    this.pending = run;
    this._confirmOpen = true;
    setText(this.confirmTitle, title);
    setText(this.confirmText, body);
    setText(this.confirmOk, ok);
    this.confirm.hidden = false;
    this.confirmOk.focus({ preventScroll: true });
  }

  private openConfirm(p: SocialPlayer): void {
    this.askConfirm(
      '친구 삭제',
      `${p.name || '이름 없음'} (${formatPlayerCode(p.code)}) 을(를) 친구 목록에서 제거합니다. 상대의 목록에서도 사라집니다.`,
      '삭제',
      () => this.actions.onRemove(p.code),
    );
  }

  /**
   * 2026-09-11 (B-4): 차단 can be undone, so it is a plain confirm card — no 1초 홀드 — but it is asked first because the
   * relay also ends the friendship / requests on **both** sides, and 차단 해제 does not bring those back.
   */
  private openBlockConfirm(p: SocialPlayer): void {
    this.askConfirm(
      '차단',
      `${p.name || '이름 없음'} (${formatPlayerCode(p.code)}) 을(를) 차단합니다. 귓속말 · 친구 요청 · 분대 초대가 오지 않고 분대 채팅도 가려집니다. 친구 · 요청 · 최근 목록에서도 사라지며, 상대에게는 알리지 않습니다.`,
      '차단',
      () => this.actions.onBlock(p.code, true),
    );
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
