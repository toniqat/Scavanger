import type { GameContext, TutorialTrack } from '@/shared';
import { COMMUNITY_BLOCKER, UI_HOLD_CONFIRM_S, createHoldButtonCap, isDesktopShell } from '@/shared';
import { el, setText } from '../dom';
import { MenuBase } from './MenuBase';

/** One warning popup the menu can raise: title, body, the label of the red button and what it does. */
interface Ask {
  title: string;
  body: string;
  ok: string;
  /**
   * 2026-09-14 (user's decision): a confirm with nothing to lose is **a single tap** — neither a hold gauge nor a
   * notice line is drawn. The 「되돌릴 수 없는 확정은 1초 홀드」 contract (2026-09-09) rests on *what is lost*, and
   * 타이틀로 · 게임 종료 in the ship have no mission to abandon and no loot to vanish. Omitted = the hold, as before.
   */
  tap?: boolean;
  run(): void;
}

/**
 * Escape menu: 게임으로 돌아가기 / 설정 / (only during a mission) 함선으로 귀환 / (only while in a squad) 파티 떠나기 /
 * 타이틀로 / 게임 종료. Driven by `game:paused`.
 *
 * Phase 8: the **ship** can be paused too (`game:paused {freeze:false}` from `game/GameFlowSystem` — Escape in the hub
 * no longer opens the terminal). The hub variant only hides `함선으로 귀환`, which needs a running mission.
 *
 * - `설정` opens the shared `SettingsMenu` overlay on top of this menu (`onSettings`, owned by HudSystem); the key
 *   rebinding lives inside it, so this menu no longer carries its own `키 설정 변경` button.
 * - `함선으로 귀환` emits `game:returnToShip` (during a raid that is death + `leaveMission`; never `hub:enter`, which would abort the whole squad).
 * - `타이틀로` leaves the lobby first (so `game:abort` does not regroup us in the shared ship) and then aborts, which
 *   sends GameFlow to `menu` and tears the hub down → the title screen.
 *
 * **2026-09-08 (ESC = always pause)**: the menu is a bare button column — the `함선 · 일시 정지` variant title, the
 * subtitles (`함선 시스템은 계속 작동합니다` / `시뮬레이션은 계속됩니다`), the multiplayer note and the footer hint
 * are all gone, and so is the ship-only social column: social is the community button / `Keys.INVITE` now, one entry
 * point instead of two. **Escape does not close this menu** — `게임으로 돌아가기` does, and that click is also the user
 * gesture the browser demands before it will hand the pointer lock back after an Escape exit (see `escapePause`).
 *
 * **2026-09-08 (second pass)**, all of it the same idea — the screen should say what it does and never do something
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
 *  - 파티 떠나기 / 타이틀로 / 게임 종료 all go through the in-frame **warning popup** (`.pause-ask`), which owns Escape
 *    and Enter while it is up so neither reaches the menu underneath.
 *
 * **2026-09-09 (fixed position)**: the menu no longer chases the mouse. It used to shift itself so `게임으로 돌아가기` sat
 * under the viewport centre (`parkUnderCursor`, `--menu-dx/dy`) — the page cannot move the OS cursor, so the menu
 * moved instead. That is gone: the frame is now **vertically centred in the left half** of the screen, a plain CSS
 * position (`.menu.pause`, `ui/styles/base.css`), the same place every time. 설정 opens centred over it.
 *
 * **2026-09-09 (a confirm is a 1 s hold)**: the red button in the warning popup is no longer a click — it is the game's
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
 * is the deliberate hold.
 *
 * **2026-09-15 2nd pass (user's decision)**: the notice line that said so (`.pause-ask-hint`) is gone — the
 * left-click hold keycap **inside the confirm button, left of the label** (`shared/keycap.createHoldButtonCap`) says
 * 「how it is pressed」 as a picture instead. A tap confirm (`Ask.tap`) is not a hold, so that keycap is not
 * attached either (the same judgement as the place that used to hide the notice line).
 *
 * **2026-09-14 (three tutorial tracks, user's decision)**: while a tutorial is running, that red slot is not
 * `함선으로 귀환` but **`튜토리얼 건너뛰기`** (`ctx.tutorial.track !== null` — any track). Pressing it skips **only the
 * track running right now** (`skipTrack`): some people know the controls but meet the ship extension for the first
 * time. It cannot be undone, so it passes the **warning popup + 1 s hold**, the contract `함선으로 귀환` already uses.
 * This button **is visible in the ship too** — the ship · build tracks run inside the ship, and inheriting the
 * hub-hiding rule of `함선으로 귀환` as is would leave those two tracks with no way to be skipped. With no tutorial
 * running, `함선으로 귀환` does not change by a single character.
 *
 * **2026-09-14 (타이틀로 · 게임 종료 in the ship, user's decision)**: the prose and the confirm gesture of the two
 * popups differ by **whether a mission is running**. No new judgement is made — it reads the very value that hides
 * `함선으로 귀환` (`this.inHub` ← `ctx.isHubPhase()`).
 *  - In the ship: 「진행 중인 임무를 포기하고 … 전리품은 사라집니다」 is **a lie** (there is no mission to abandon and no
 *    loot to lose) — the ship prose replaces it, and with nothing to lose it confirms on **a single tap** (`Ask.tap`).
 *  - During a mission: the old mission prose + the 1 s hold, unchanged.
 *  - **`파티 떠나기` is a hold in the ship too** — nothing is lost, but it affects other people in the squad, so it
 *    must never be pressed by accident.
 */
export class PauseMenu extends MenuBase {
  private returnBtn: HTMLButtonElement;
  private leaveBtn: HTMLButtonElement;
  private resumeBtn: HTMLButtonElement;
  /** True while the pause was opened from the ship (no mission to abandon). */
  private inHub = false;
  /** 2026-09-14: the tutorial track running the moment the menu opened (null = no tutorial → the red slot is `함선으로 귀환`). */
  private track: TutorialTrack | null = null;
  /** The warning popup and the action it is guarding (null = closed). */
  private ask: HTMLElement;
  private askTitle: HTMLElement;
  private askBody: HTMLElement;
  /** 2026-09-15 2nd pass: the left-click hold keycap inside the confirm button, left of the label — detached on a tap-confirm popup. */
  private askCap: HTMLElement;
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
    // 2026-09-14: one slot, two meanings — `튜토리얼 건너뛰기` during a tutorial, else `함선으로 귀환` (`refreshReturnButton`).
    this.returnBtn = this.button(actions, '함선으로 귀환', () => this.confirm(this.track ? this.skipAsk(this.track) : this.returnAsk()), 'danger');
    this.leaveBtn = this.button(actions, '파티 떠나기', () => this.confirm({
      title: '파티 떠나기',
      body: '분대에서 나갑니다. 공유 함선에서는 개인 함선으로 돌아갑니다.',
      ok: '떠나기',
      run: () => this.leaveParty(),
    }), 'danger');
    this.button(actions, '타이틀로', () => this.confirm(this.titleAsk()), 'danger');
    this.button(actions, '게임 종료', () => this.confirm(this.quitAsk()), 'danger');

    /* ── warning popup: inside the frame's overlay so it darkens exactly the menu it guards ── */
    this.ask = el('div', { cls: 'pause-ask', parent: this.root });
    this.ask.hidden = true;
    const card = el('div', { cls: 'pause-ask-card', parent: this.ask });
    this.askTitle = el('div', { cls: 'pause-ask-title', text: '', parent: card });
    this.askBody = el('div', { cls: 'pause-ask-body', text: '', parent: card });
    const foot = el('div', { cls: 'pause-ask-foot', parent: card });
    this.askNo = el('button', { cls: 'ui-btn small', text: '취소', parent: foot });
    this.askOk = el('button', { cls: 'ui-btn small danger pause-ask-ok', parent: foot });
    // The hold keycap comes **before** the fill bar, so flex order puts it left of the label (the fill bar is
    // absolute and drops out of the row).
    this.askCap = createHoldButtonCap(this.askOk);
    this.askFill = el('i', { cls: 'pause-ask-fill', parent: this.askOk });
    this.askOkLabel = el('span', { cls: 'pause-ask-ok-t', text: '확인', parent: this.askOk });
    this.askNo.addEventListener('click', (e) => { e.stopPropagation(); this.closeAsk(); });
    // Hold confirm: pointerdown starts the sweep, leaving the button cancels, and `onWindowUp` catches every release.
    this.askOk.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.startHold(e); });
    this.askOk.addEventListener('pointerleave', () => this.cancelHold());
    // In a hold popup a click is *not a confirm* — it is swallowed so nobody reads it.
    // Only in a tap-confirm popup is this one click the confirm itself (`startHold` arms nothing then).
    this.askOk.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.pending?.tap) this.runAsk();
    });
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('game:paused', ({ paused }) => {
        if (!paused) { this.hide(); return; }
        // The ship pause (Phase 8) is menu-only: nothing to abandon, so no 함선으로 귀환.
        const hub = ctx.isHubPhase();
        this.inHub = hub;
        this.refreshReturnButton();
        this.leaveBtn.style.display = ctx.net?.lobby ? '' : 'none';
        this.show();
      }),
      ctx.bus.on('game:phaseChanged', () => this.hide()),
      // Someone else dropped the lobby (kick, 도킹 해제 elsewhere, disconnect) while the menu is up.
      ctx.bus.on('net:lobbyLeft', () => { this.leaveBtn.style.display = 'none'; }),
      ctx.bus.on('net:lobbyUpdated', () => { this.leaveBtn.style.display = this.ctx.net?.lobby ? '' : 'none'; }),
    );
  }

  /**
   * 2026-09-14: decides what the red slot means.
   *  - With a tutorial running, `튜토리얼 건너뛰기` — **visible in the ship too** (the ship · build tracks run there).
   *  - Otherwise `함선으로 귀환` as before, hidden in the ship (there is no mission to abandon).
   * `.ui-btn` sets `display`, so this drives `display` directly rather than the `hidden` attribute.
   */
  private refreshReturnButton(): void {
    this.track = this.ctx.tutorial?.track ?? null;
    setText(this.returnBtn, this.track ? '튜토리얼 건너뛰기' : '함선으로 귀환');
    this.returnBtn.style.display = this.track ? '' : this.inHub ? 'none' : '';
  }

  /** Whether the hub variant is showing (debug). */
  get isHubVariant(): boolean { return this.inHub; }
  /** 2026-09-14: the tutorial track the red slot would skip right now (debug / smoke, null = `함선으로 귀환`). */
  get skipTrackTarget(): TutorialTrack | null { return this.track; }
  /** Whether the warning popup is up (debug / smoke). */
  get isAskOpen(): boolean { return !this.ask.hidden; }
  /** 2026-09-14: does the popup now up confirm with one tap instead of a hold (debug / smoke). */
  get isAskTap(): boolean { return !this.ask.hidden && !!this.pending?.tap; }
  /** The 파티 떠나기 button (debug / smoke). */
  get partyButton(): HTMLButtonElement { return this.leaveBtn; }
  /** The warning popup's red 확정 button (debug / smoke). */
  get askConfirmButton(): HTMLButtonElement { return this.askOk; }
  /** How far the confirm hold has swept, 0 … 1 (0 = nothing held) (debug / smoke). */
  get askHoldProgress(): number { return this.holdT; }

  protected override onShow(): void {
    window.addEventListener('keydown', this.onKey, true);
  }

  protected override onHide(): void {
    this.closeAsk();
    window.removeEventListener('keydown', this.onKey, true);
  }

  /**
   * Tab leaves the menu; while the warning popup is up it owns Escape (cancel) and **eats** Enter (2026-09-09: it no
   * longer confirms — confirming is the pointer hold and nothing else), so neither falls through to the chat or to
   * whatever button the browser happens to have focused.
   *
   * **Escape closes the menu only in the desktop shell** (2026-09-09, user's decision). In a browser it stays
   * click-only — Escape carries no user activation, so closing with that key never wins the pointer lock back and the
   * `좌측 클릭으로 게임 재개` gate appears once more. In the shell the main process makes an activation on every ESC
   * key-up (`electron/main.ts` → `__scavShellRelock`), so the camera returns the moment it closes. This handler is a
   * window capture and swallows the key before `Input` records it, so `game/escapeKey` does not reopen the menu in
   * the same frame.
   */
  private handleKey(e: KeyboardEvent): void {
    if (!this.visible) return;
    // 2026-09-16: with the messenger up over the menu, Tab · Escape belong to that panel (`hud/Community` · `ctx.escape`) — the menu stays
    if (this.ctx.uiBlockers.has(COMMUNITY_BLOCKER)) return;
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

  /* ── warning popup ───────────────────────────────────────────────────────── */

  private confirm(ask: Ask): void {
    this.pending = ask;
    setText(this.askTitle, ask.title);
    setText(this.askBody, ask.body);
    setText(this.askOkLabel, ask.ok);
    // A confirm that ends with one tap gets no hold keycap (it must not draw "hold" where nothing is held).
    if (ask.tap) this.askCap.remove(); else this.askOk.insertBefore(this.askCap, this.askFill);
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

  /* ── confirm hold (UI_HOLD_CONFIRM_S) ────────────────────────────────────── */

  /**
   * Left-button press on the red button arms the sweep; every other button is ignored.
   * A tap-confirm popup arms nothing here — it must not even `preventDefault`, so the click that follows arrives intact.
   */
  private startHold(e: PointerEvent): void {
    if (this.pending?.tap) return;
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
   * 2026-09-13 (user's decision): `함선으로 귀환` is a warning popup + a 1 s hold too. During a raid it is the same as
   * **dying on the spot**, so the prose says what is lost — in a squad it stays on the corpse for a squadmate to
   * recover, solo everything is lost.
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

  /**
   * 2026-09-14 (user's decision): in the ship there is no mission to abandon and no loot to vanish — the mission prose
   * is dropped and it confirms on **a single tap**. During a mission the old prose · the old hold stay. (Progress in
   * the ship is already saved in the profile · ship documents, so it says so.)
   */
  private titleAsk(): Ask {
    return this.inHub
      ? { title: '타이틀로', body: '타이틀 화면으로 돌아갑니다. 함선의 진행 상황은 저장되어 있습니다.', ok: '타이틀로', tap: true, run: () => this.toTitle() }
      : { title: '타이틀로', body: '진행 중인 임무를 포기하고 타이틀 화면으로 돌아갑니다. 회수하지 못한 전리품은 사라집니다.', ok: '타이틀로', run: () => this.toTitle() };
  }

  /** The same split as `titleAsk` — in the ship nothing is lost, so the mission prose goes and it is one tap. */
  private quitAsk(): Ask {
    return this.inHub
      ? { title: '게임 종료', body: '게임을 종료합니다. 함선의 진행 상황은 저장되어 있습니다.', ok: '종료', tap: true, run: () => this.quit() }
      : { title: '게임 종료', body: '게임을 종료합니다. 진행 중인 임무는 저장되지 않습니다.', ok: '종료', run: () => this.quit() };
  }

  /**
   * 2026-09-14 (user's decision): `튜토리얼 건너뛰기` — it ends **only the track running right now**. It cannot be
   * undone, so it passes the same warning popup + 1 s hold as `함선으로 귀환`. The prose says **what happens if that
   * track is skipped** — the raid track is extracted on the spot and goes to the ship (that flow belongs to tutorial ·
   * extraction), and for the other two only the remaining guide disappears. The other tracks stay and start in turn.
   */
  private skipAsk(track: TutorialTrack): Ask {
    const body = track === 'raid'
      ? '진행 중인 튜토리얼을 건너뛰고 함선으로 갑니다. 남은 안내는 다시 나오지 않으며, 되돌릴 수 없습니다.'
      : track === 'ship'
        ? '함선 적응 튜토리얼을 건너뜁니다. 남은 안내는 다시 나오지 않으며, 되돌릴 수 없습니다.'
        // 2026-09-18: the extension track split into `build` (증축 · 제작) and `raid2` (출격) — the prose splits too.
        //   Lumping them into one `else` would say 「시설 증축 · 제작」 is skipped while the launch guide is skipped.
        : track === 'raid2'
          ? '출격 준비 튜토리얼을 건너뜁니다. 남은 안내는 다시 나오지 않으며, 되돌릴 수 없습니다.'
          : '시설 증축 · 제작 튜토리얼을 건너뜁니다. 남은 안내는 다시 나오지 않으며, 되돌릴 수 없습니다.';
    return { title: '튜토리얼 건너뛰기', body, ok: '건너뛰기', run: () => this.skipTutorial(track) };
  }

  /** Closes the menu first and hands over to the tutorial — skipping the raid track changes the screen on the spot. */
  private skipTutorial(track: TutorialTrack): void {
    this.resume();
    try { this.ctx.tutorial?.skipTrack(track); } catch (e) { console.error('[ui] skipTrack failed', e); }
  }

  /** The menu closes first; game/ decides what the return means right now (`game:returnToShip` — die here, then the ship). */
  private returnToShip(): void {
    this.resume();
    this.ctx.bus.emit('game:returnToShip', {});
  }

  /**
   * 파티 떠나기 — the same call the ship menu's 도킹 해제 makes (`net.leaveLobby`). The relay drops our slot and
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
