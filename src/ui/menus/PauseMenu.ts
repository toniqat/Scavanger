import type { GameContext } from '@/shared';
import { el, setText } from '../dom';
import { MenuBase } from './MenuBase';

/** One 경고 팝업 the menu can raise: title, body, the label of the red button and what it does. */
interface Ask {
  title: string;
  body: string;
  ok: string;
  run(): void;
}

/**
 * Escape menu: 게임으로 돌아가기 / 설정 / (임무 중에만) 함선으로 귀환 / (분대에 속했을 때만) 파티 떠나기 / 타이틀로 /
 * 게임 종료. Driven by `game:paused`.
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
 *
 * **2026-09-08 (두 번째 패스)**, all of it the same idea — the screen should say what it does and never do something
 * irreversible on one click:
 *  - The `일시 정지` heading is gone. Escape does not actually freeze a raid (`freeze:false` in the ship, and the
 *    world keeps running under it), so the word was a lie; the buttons are the whole screen now.
 *  - **Tab** is a second way out (`게임으로 돌아가기 (Tab)`) — the key is fixed, not `Keys.INVENTORY`, so the label can
 *    never disagree with it. `InventorySystem` already refuses Tab while the `'menu'` blocker is up, so the two
 *    cannot both fire.
 *  - **파티 떠나기** (`net.leaveLobby`, the same call as 도킹 해제) appears only while `ctx.net.lobby` exists — i.e.
 *    aboard the shared ship or in a squad raid.
 *  - **게임 종료** closes the window: in the Electron shell that quits the app; a browser tab cannot be closed by a
 *    script it did not open, so there it says so and falls back to the title screen.
 *  - 파티 떠나기 / 타이틀로 / 게임 종료 all go through the in-frame **경고 팝업** (`.pause-ask`), which owns Escape and
 *    Enter while it is up so neither reaches the menu underneath.
 *
 * **2026-09-09 (자리 고정)**: the menu no longer chases the mouse. It used to shift itself so `게임으로 돌아가기` sat
 * under the viewport centre (`parkUnderCursor`, `--menu-dx/dy`) — the page cannot move the OS cursor, so the menu
 * moved instead. That is gone: the frame is now **vertically centred in the left half** of the screen, a plain CSS
 * position (`.menu.pause`, `ui/styles/base.css`), the same place every time. 설정 opens centred over it.
 */
export class PauseMenu extends MenuBase {
  private returnBtn: HTMLButtonElement;
  private leaveBtn: HTMLButtonElement;
  private resumeBtn: HTMLButtonElement;
  /** True while the pause was opened from the ship (no mission to abandon). */
  private inHub = false;
  /** The 경고 팝업 and the action it is guarding (null = closed). */
  private ask: HTMLElement;
  private askTitle: HTMLElement;
  private askBody: HTMLElement;
  private askOk: HTMLButtonElement;
  private pending: Ask | null = null;
  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);

  constructor(parent: HTMLElement, private readonly onSettings: () => void) {
    super(parent, 'pause');
    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.resumeBtn = this.button(actions, '게임으로 돌아가기 (Tab)', () => this.resume(), 'primary');
    this.button(actions, '설정', () => this.onSettings());
    this.returnBtn = this.button(actions, '함선으로 귀환', () => this.returnToShip(), 'danger');
    this.leaveBtn = this.button(actions, '파티 떠나기', () => this.confirm({
      title: '파티 떠나기',
      body: '분대에서 나갑니다. 공유 함선에서는 개인 함선으로 돌아갑니다.',
      ok: '떠나기',
      run: () => this.leaveParty(),
    }), 'danger');
    this.button(actions, '타이틀로', () => this.confirm({
      title: '타이틀로',
      body: '진행 중인 임무를 포기하고 타이틀 화면으로 돌아갑니다. 회수하지 못한 전리품은 사라집니다.',
      ok: '타이틀로',
      run: () => this.toTitle(),
    }), 'danger');
    this.button(actions, '게임 종료', () => this.confirm({
      title: '게임 종료',
      body: '게임을 종료합니다. 진행 중인 임무는 저장되지 않습니다.',
      ok: '종료',
      run: () => this.quit(),
    }), 'danger');

    /* ── 경고 팝업: inside the frame's overlay so it darkens exactly the menu it guards ── */
    this.ask = el('div', { cls: 'pause-ask', parent: this.root });
    this.ask.hidden = true;
    const card = el('div', { cls: 'pause-ask-card', parent: this.ask });
    this.askTitle = el('div', { cls: 'pause-ask-title', text: '', parent: card });
    this.askBody = el('div', { cls: 'pause-ask-body', text: '', parent: card });
    const foot = el('div', { cls: 'pause-ask-foot', parent: card });
    const no = el('button', { cls: 'ui-btn small', text: '취소', parent: foot });
    this.askOk = el('button', { cls: 'ui-btn small danger', text: '확인', parent: foot }) as HTMLButtonElement;
    no.addEventListener('click', (e) => { e.stopPropagation(); this.closeAsk(); });
    this.askOk.addEventListener('click', (e) => { e.stopPropagation(); this.runAsk(); });
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
        this.leaveBtn.style.display = ctx.net?.lobby ? '' : 'none';
        this.show();
      }),
      ctx.bus.on('game:phaseChanged', () => this.hide()),
      // Someone else dropped the lobby (kick, 도킹 해제 elsewhere, disconnect) while the menu is up.
      ctx.bus.on('net:lobbyLeft', () => { this.leaveBtn.style.display = 'none'; }),
      ctx.bus.on('net:lobbyUpdated', () => { this.leaveBtn.style.display = this.ctx.net?.lobby ? '' : 'none'; }),
    );
  }

  /** Whether the hub variant is showing (debug). */
  get isHubVariant(): boolean { return this.inHub; }
  /** Whether the 경고 팝업 is up (debug / smoke). */
  get isAskOpen(): boolean { return !this.ask.hidden; }
  /** The 파티 떠나기 button (debug / smoke). */
  get partyButton(): HTMLButtonElement { return this.leaveBtn; }

  protected override onShow(): void {
    window.addEventListener('keydown', this.onKey, true);
  }

  protected override onHide(): void {
    this.closeAsk();
    window.removeEventListener('keydown', this.onKey, true);
  }

  /**
   * Tab leaves the menu; while the 경고 팝업 is up it owns Escape (cancel) and Enter (confirm) so neither falls
   * through. Escape on the bare menu stays unhandled on purpose — `game/GameFlowSystem` owns that key and the menu
   * is deliberately click-to-close (the click is also the gesture the browser wants before re-locking the pointer).
   */
  private handleKey(e: KeyboardEvent): void {
    if (!this.visible) return;
    if (!this.ask.hidden) {
      if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.closeAsk(); }
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopImmediatePropagation(); this.runAsk(); }
      return;
    }
    if (e.code !== 'Tab') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.resume();
  }

  private resume(): void {
    this.ctx.bus.emit('game:paused', { paused: false });
  }

  /* ── 경고 팝업 ───────────────────────────────────────────────────────────── */

  private confirm(ask: Ask): void {
    this.pending = ask;
    setText(this.askTitle, ask.title);
    setText(this.askBody, ask.body);
    setText(this.askOk, ask.ok);
    this.ask.hidden = false;
    this.askOk.focus({ preventScroll: true });
  }

  private closeAsk(): void {
    if (this.ask.hidden) return;
    this.ask.hidden = true;
    this.pending = null;
  }

  private runAsk(): void {
    const ask = this.pending;
    this.closeAsk();
    if (!ask) return;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    ask.run();
  }

  private returnToShip(): void {
    this.ctx.bus.emit('hub:enter', { ship: this.ctx.net?.lobby ? 'shared' : 'personal' });
  }

  /**
   * 파티 떠나기 — the same call the 함선 메뉴's 도킹 해제 makes (`net.leaveLobby`). The relay drops our slot and
   * `hub/` swaps the shared ship back to the personal one on `net:lobbyLeft`; the menu closes so the player lands in
   * the ship rather than behind this screen.
   */
  private leaveParty(): void {
    const ctx = this.ctx;
    try { ctx.net?.leaveLobby(); } catch (e) { console.error('[ui] leaveLobby failed', e); }
    ctx.bus.emit('ui:notify', { text: '분대에서 나왔습니다', kind: 'info', duration: 2 });
    this.resume();
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

  /**
   * 게임 종료. `window.close()` quits the Electron shell (`electron/main.ts` owns the only BrowserWindow). A browser
   * refuses it for a tab the page did not open and simply does nothing, so we check a tick later and, still alive,
   * tell the player to close the tab themselves — and go to the title screen, which is as far as a page can get.
   */
  private quit(): void {
    const ctx = this.ctx;
    try { window.close(); } catch (e) { console.error('[ui] window.close failed', e); }
    window.setTimeout(() => {
      if (window.closed) return;
      ctx.bus.emit('ui:notify', { text: '브라우저에서는 탭을 직접 닫아주세요', kind: 'warning', duration: 3.5 });
      this.toTitle();
    }, 250);
  }
}
