import type { GameContext } from '@/shared';
import { UI_HOLD_CONFIRM_S, isDesktopShell } from '@/shared';
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
 *
 * **2026-09-09 (확정은 1초 홀드)**: the red button in the 경고 팝업 is no longer a click — it is the game's
 * hold-to-commit gesture (`UI_HOLD_CONFIRM_S`, `data/constants.csv`), the same one 제작 / 분해 use: a fill sweeps
 * across the button while the pointer is held, letting go early cancels and resets it, and only a completed sweep
 * fires the action, exactly once. The release is watched on `window` (like every drag in this project), so letting
 * the mouse go anywhere — off the button, off the window — can never leave a gauge stuck mid-sweep; the pointer
 * merely leaving the button cancels too.
 *
 * **Enter no longer confirms.** It is swallowed and does nothing: an accidental Enter (the chat key, and the key a
 * browser uses to activate whatever button happens to be focused) must never leave a raid, and a held Enter would
 * have raced key-repeat and focus-activation against the pointer gauge for no gain. Escape still cancels, the
 * initial focus sits on **취소** (so Space is the safe answer, not the destructive one) and the only way to commit
 * is the deliberate hold. The card says so in a hint line built from `UI_HOLD_CONFIRM_S` itself.
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
  private askNo: HTMLButtonElement;
  private askOk: HTMLButtonElement;
  private askOkLabel: HTMLElement;
  private askFill: HTMLElement;
  private pending: Ask | null = null;
  /** `performance.now()` of the pointerdown that started the hold; 0 = nothing held. */
  private holdStart = 0;
  private holdRaf = 0;
  private holdT = 0;
  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);
  /** A release anywhere ends the hold — a pointerup outside the button must not leave the gauge stuck. */
  private readonly onWindowUp = (): void => this.cancelHold();

  constructor(parent: HTMLElement, private readonly onSettings: () => void) {
    super(parent, 'pause');
    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.resumeBtn = this.button(actions, '게임으로 돌아가기 (Tab)', () => this.resume(), 'primary');
    this.button(actions, '설정', () => this.onSettings());
    this.returnBtn = this.button(actions, '함선으로 귀환', () => this.confirm(this.returnAsk()), 'danger');
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
    // The hint is built from the constant, so the screen can never disagree with `data/constants.csv`.
    el('div', { cls: 'pause-ask-hint', text: `확인 버튼을 ${UI_HOLD_CONFIRM_S}초 누르고 있어야 실행됩니다`, parent: card });
    const foot = el('div', { cls: 'pause-ask-foot', parent: card });
    this.askNo = el('button', { cls: 'ui-btn small', text: '취소', parent: foot });
    this.askOk = el('button', { cls: 'ui-btn small danger pause-ask-ok', parent: foot });
    this.askFill = el('i', { cls: 'pause-ask-fill', parent: this.askOk });
    this.askOkLabel = el('span', { cls: 'pause-ask-ok-t', text: '확인', parent: this.askOk });
    this.askNo.addEventListener('click', (e) => { e.stopPropagation(); this.closeAsk(); });
    // 홀드 확정: pointerdown starts the sweep, leaving the button cancels, and `onWindowUp` catches every release.
    this.askOk.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.startHold(e); });
    this.askOk.addEventListener('pointerleave', () => this.cancelHold());
    // A click on the red button is *not* a confirm any more — swallow it so nothing else reads it either.
    this.askOk.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
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
  /** The 경고 팝업's red 확정 button (debug / smoke). */
  get askConfirmButton(): HTMLButtonElement { return this.askOk; }
  /** How far the 확정 홀드 has swept, 0 … 1 (0 = nothing held) (debug / smoke). */
  get askHoldProgress(): number { return this.holdT; }

  protected override onShow(): void {
    window.addEventListener('keydown', this.onKey, true);
  }

  protected override onHide(): void {
    this.closeAsk();
    window.removeEventListener('keydown', this.onKey, true);
  }

  /**
   * Tab leaves the menu; while the 경고 팝업 is up it owns Escape (cancel) and **eats** Enter (2026-09-09: it no
   * longer confirms — confirming is the pointer hold and nothing else), so neither falls through to the chat or to
   * whatever button the browser happens to have focused.
   *
   * **Escape 는 데스크톱 셸에서만 메뉴를 닫는다** (2026-09-09, 사용자 결정). 브라우저에서는 그대로 클릭 전용이다 —
   * Escape 에는 user activation 이 없어서 그 키로 닫으면 포인터 락을 되찾지 못하고 `좌측 클릭으로 게임 재개`
   * 게이트가 한 번 더 뜬다. 셸에서는 메인 프로세스가 ESC key-up 마다 activation 을 만들어 주므로
   * (`electron/main.ts` → `__scavShellRelock`) 닫히는 즉시 카메라가 돌아온다. 이 핸들러는 window capture 라
   * `Input` 이 키를 기록하기 전에 삼키므로, `game/escapeKey` 가 같은 프레임에 메뉴를 다시 열지 않는다.
   */
  private handleKey(e: KeyboardEvent): void {
    if (!this.visible) return;
    if (!this.ask.hidden) {
      if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.closeAsk(); }
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    if (e.code === 'Escape' && isDesktopShell()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.resume();
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
    setText(this.askOkLabel, ask.ok);
    this.ask.hidden = false;
    // Focus the safe button: the destructive one cannot be triggered by a key at all, and a stray Space should
    // cancel rather than look like it is arming something.
    this.askNo.focus({ preventScroll: true });
  }

  private closeAsk(): void {
    if (this.ask.hidden) return;
    this.stopHold();
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

  /* ── 확정 홀드 (UI_HOLD_CONFIRM_S) ───────────────────────────────────────── */

  /** Left-button press on the red button arms the sweep; every other button is ignored. */
  private startHold(e: PointerEvent): void {
    if (e.button !== 0 || !this.pending || this.holdStart) return;
    e.preventDefault();
    this.holdStart = performance.now();
    this.holdT = 0;
    this.askOk.classList.add('is-holding');
    window.addEventListener('pointerup', this.onWindowUp);
    window.addEventListener('pointercancel', this.onWindowUp);
    this.ctx.bus.emit('audio:play', { id: 'ui_pickup' });
    this.tickHold();
  }

  /** One frame of the sweep. Driven by rAF, not by a system update — the menu has no per-frame hook. */
  private readonly tickHold = (): void => {
    if (!this.holdStart) return;
    this.holdRaf = 0;
    const t = Math.min(1, (performance.now() - this.holdStart) / (UI_HOLD_CONFIRM_S * 1000));
    this.holdT = t;
    this.askFill.style.width = `${(t * 100).toFixed(1)}%`;
    if (t < 1) { this.holdRaf = requestAnimationFrame(this.tickHold); return; }
    this.stopHold();
    this.runAsk();      // fires once — `stopHold` disarmed the loop before the action ran
  };

  /** Released early / left the button: back to zero, nothing happens. */
  private cancelHold(): void {
    if (!this.holdStart) return;
    this.stopHold();
  }

  private stopHold(): void {
    this.holdStart = 0;
    this.holdT = 0;
    if (this.holdRaf) { cancelAnimationFrame(this.holdRaf); this.holdRaf = 0; }
    window.removeEventListener('pointerup', this.onWindowUp);
    window.removeEventListener('pointercancel', this.onWindowUp);
    this.askFill.style.width = '0%';
    this.askOk.classList.remove('is-holding');
  }

  /** The hold's `window` listeners and the capture-phase key listener must not outlive the menu. */
  override dispose(): void {
    this.stopHold();
    window.removeEventListener('keydown', this.onKey, true);
    super.dispose();
  }

  /**
   * 2026-09-13 (사용자 결정): `함선으로 귀환` 도 경고 팝업 + 1초 홀드다. 레이드 중에는 **그 자리에서 사망**하는 것과 같으므로
   * 글이 무엇을 잃는지 말한다 — 분대면 시체에 남아 분대원이 회수할 수 있고, 솔로면 전부 잃는다.
   */
  private returnAsk(): Ask {
    const ctx = this.ctx;
    const body = ctx.missionMode === 'training'
      ? '시뮬레이션 훈련장을 나가 함선으로 돌아갑니다.'
      : ctx.isMultiplayer
        ? '임무를 포기하고 함선으로 돌아갑니다. 캐릭터는 그 자리에서 사망하며, 장비 · 가방 · 장착 임플란트는 시체에 남아 분대원이 회수할 수 있습니다.'
        : '임무를 포기하고 함선으로 돌아갑니다. 캐릭터는 그 자리에서 사망하며, 장비 · 가방 · 장착 임플란트를 모두 잃습니다.';
    return { title: '함선으로 귀환', body, ok: '귀환', run: () => this.returnToShip() };
  }

  /** The menu closes first; game/ decides what 귀환 means right now (`game:returnToShip` — die here, then the ship). */
  private returnToShip(): void {
    this.resume();
    this.ctx.bus.emit('game:returnToShip', {});
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
