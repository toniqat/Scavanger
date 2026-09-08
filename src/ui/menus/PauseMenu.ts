import type { GameContext } from '@/shared';
import { el } from '../dom';
import { MenuBase } from './MenuBase';

/**
 * How far right of `게임으로 돌아가기`'s middle the cursor should land, as a fraction of the button's width
 * (0.5 would be its right edge). Keeps the arrow comfortably inside the button without hugging the label.
 */
const CURSOR_BIAS = 0.28;
/** Smallest gap the parked frame keeps to the viewport edge, px. */
const MARGIN = 16;

/**
 * Escape menu: 게임으로 돌아가기 / 설정 / (임무 중에만) 함선으로 귀환 / 타이틀로. Driven by `game:paused`.
 *
 * Phase 8: the **ship** can be paused too (`game:paused {freeze:false}` from `game/GameFlowSystem` — Escape in the hub
 * no longer opens the terminal). The hub variant only hides `함선으로 귀환`, which needs a running mission.
 *
 * - `설정` opens the shared `SettingsMenu` overlay on top of this menu (`onSettings`, owned by HudSystem); the key
 *   rebinding lives inside it, so this menu no longer carries its own `키 설정 변경` button.
 * - `함선으로 귀환` emits `hub:enter {ship}` (shared ship while in a lobby, else personal); the hub aborts the mission.
 * - `타이틀로` leaves the lobby first (so `game:abort` does not regroup us in the shared ship) and then aborts, which
 *   sends GameFlow to `menu` and tears the hub down → the title screen.
 *
 * **2026-09-08 (ESC = 항상 일시정지)**: the menu is a bare button column — the `함선 · 일시 정지` variant title, the
 * subtitles (`함선 시스템은 계속 작동합니다` / `시뮬레이션은 계속됩니다`), the multiplayer note and the footer hint
 * are all gone, and so is the ship-only 소셜 열: social is the 커뮤니티 button / `Keys.INVITE` now, one entry point
 * instead of two. **Escape does not close this menu** — `게임으로 돌아가기` does, and that click is also the user
 * gesture the browser demands before it will hand the pointer lock back after an Escape exit (see `escapePause`).
 */
export class PauseMenu extends MenuBase {
  private returnBtn: HTMLButtonElement;
  private resumeBtn: HTMLButtonElement;
  /** True while the pause was opened from the ship (no mission to abandon). */
  private inHub = false;
  private readonly onResize = (): void => this.parkUnderCursor();

  constructor(parent: HTMLElement, private readonly onSettings: () => void) {
    super(parent, 'pause');
    el('div', { cls: 'title', text: '일시 정지', parent: this.frame });
    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.resumeBtn = this.button(actions, '게임으로 돌아가기', () => this.ctx.bus.emit('game:paused', { paused: false }), 'primary');
    this.button(actions, '설정', () => this.onSettings());
    this.returnBtn = this.button(actions, '함선으로 귀환', () => this.returnToShip(), 'danger');
    this.button(actions, '타이틀로', () => this.toTitle(), 'danger');
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('game:paused', ({ paused }) => {
        if (!paused) { this.hide(); return; }
        // The ship pause (Phase 8) is menu-only: nothing to abandon, so no 함선으로 귀환.
        const hub = ctx.isHubPhase();
        this.inHub = hub;
        // `.ui-btn` sets `display`, so the `hidden` attribute would not hide it — drive `display` directly.
        this.returnBtn.style.display = hub ? 'none' : '';
        this.show();
      }),
      ctx.bus.on('game:phaseChanged', () => this.hide()),
    );
  }

  /** Whether the hub variant is showing (debug). */
  get isHubVariant(): boolean { return this.inHub; }

  protected override onShow(): void {
    this.parkUnderCursor();
    window.addEventListener('resize', this.onResize);
  }

  protected override onHide(): void {
    window.removeEventListener('resize', this.onResize);
  }

  /**
   * 2026-09-08 — **커서 자리에 버튼을 갖다 놓는다.**
   *
   * The page cannot move the OS cursor, so the menu moves instead. Escape releases the pointer lock and the browser
   * puts the arrow back where it was captured, i.e. the middle of the canvas — so the frame is shifted until
   * `게임으로 돌아가기` sits under the viewport centre, with the centre landing `CURSOR_BIAS` of the button's width
   * **right of the button's middle**: the click needs no aiming, and the pointer is not sitting on the button's edge.
   *
   * Measured with `offset*` rather than `getBoundingClientRect`, because the frame carries both the entry animation
   * and the offset itself as a `transform` — offsets are layout, so they read the same before and after. The result
   * goes into `--menu-dx/dy` (see `.menu .frame` in `ui/styles/base.css`), which the keyframes carry too, so the
   * menu animates in **at** its parked position instead of sliding there.
   */
  private parkUnderCursor(): void {
    if (!this.visible) return;
    const frame = this.frame, btn = this.resumeBtn;
    if (!frame.offsetWidth || !btn.offsetWidth) return;
    const bx = frame.offsetLeft + btn.offsetLeft + btn.offsetWidth / 2;
    const by = frame.offsetTop + btn.offsetTop + btn.offsetHeight / 2;
    const vw = window.innerWidth, vh = window.innerHeight;
    const clamp = (v: number, lo: number, hi: number): number => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));
    const dx = clamp(vw / 2 - CURSOR_BIAS * btn.offsetWidth - bx, MARGIN - frame.offsetLeft, vw - MARGIN - frame.offsetWidth - frame.offsetLeft);
    const dy = clamp(vh / 2 - by, MARGIN - frame.offsetTop, vh - MARGIN - frame.offsetHeight - frame.offsetTop);
    frame.style.setProperty('--menu-dx', `${Math.round(dx)}px`);
    frame.style.setProperty('--menu-dy', `${Math.round(dy)}px`);
  }

  private returnToShip(): void {
    this.ctx.bus.emit('hub:enter', { ship: this.ctx.net?.lobby ? 'shared' : 'personal' });
  }

  /**
   * 타이틀로. The lobby is left **before** the abort: `GameFlowSystem.onAbort` regroups the squad in the shared ship
   * whenever `ctx.net.lobby` still exists, which would bounce us straight back into the hub.
   */
  private toTitle(): void {
    const ctx = this.ctx;
    try { if (ctx.net?.lobby) ctx.net.leaveLobby(); } catch (e) { console.error('[ui] leaveLobby failed', e); }
    ctx.bus.emit('game:paused', { paused: false });
    // GameFlow's `game:abort` handler clears the mission state and sets the phase to `menu`;
    // HubSystem tears the ship down on the same event, so the title screen is what remains.
    ctx.bus.emit('game:abort', {});
  }
}
