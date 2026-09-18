import type { GameContext, TutorialTrack } from '@/shared';
import { COMMUNITY_BLOCKER, UI_HOLD_CONFIRM_S, createHoldButtonCap, isDesktopShell } from '@/shared';
import { el, setText } from '../dom';
import { MenuBase } from './MenuBase';

/** One 경고 팝업 the menu can raise: title, body, the label of the red button and what it does. */
interface Ask {
  title: string;
  body: string;
  ok: string;
  /**
   * 2026-09-14 (사용자 결정): 잃을 것이 없는 확정은 **한 번의 탭**이다 — 홀드 게이지도 안내 줄도 그리지 않는다.
   * 「되돌릴 수 없는 확정은 1초 홀드」 규약(2026-09-09)의 근거는 *잃는 것*이고, 함선에서의 타이틀로 · 게임 종료는
   * 포기할 임무도 사라질 전리품도 없다. 생략 = 예전 그대로 홀드.
   */
  tap?: boolean;
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
 * - `함선으로 귀환` emits `game:returnToShip` (during a raid that is death + `leaveMission`; never `hub:enter`, which would abort the whole squad).
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
 * is the deliberate hold.
 *
 * **2026-09-15 2차 (사용자 결정)**: 그것을 말하던 안내 줄(`.pause-ask-hint`)은 없어졌다 — 「어떻게 누르는가」는
 * 확정 버튼 **안, 라벨 왼쪽**의 좌클릭 홀드 키캡(`shared/keycap.createHoldButtonCap`)이 그림으로 말한다.
 * 탭 확정(`Ask.tap`)은 홀드가 아니므로 그 키캡도 붙지 않는다 (예전에 안내 줄을 감추던 자리와 같은 판정이다).
 *
 * **2026-09-14 (튜토리얼 3트랙, 사용자 결정)**: 튜토리얼이 돌고 있는 동안 그 빨간 자리는 `함선으로 귀환` 이 아니라
 * **`튜토리얼 건너뛰기`** 다 (`ctx.tutorial.track !== null` — 어느 트랙이든). 누르면 **지금 도는 트랙 하나만**
 * 건너뛴다(`skipTrack`): 조작은 아는데 증축은 처음인 사람이 있기 때문이다. 되돌릴 수 없으므로 `함선으로 귀환` 이
 * 이미 쓰는 규약 그대로 **경고 팝업 + 1초 홀드**를 지난다. 이 버튼은 **함선에서도 보인다** — 함선 · 증축 트랙은
 * 함선 안에서 도는데, `함선으로 귀환` 의 hub 숨김 규칙을 그대로 물려받으면 그 두 트랙은 건너뛸 길이 없다.
 * 튜토리얼이 없을 때의 `함선으로 귀환` 은 한 글자도 바뀌지 않는다.
 *
 * **2026-09-14 (함선에서의 타이틀로 · 게임 종료, 사용자 결정)**: 두 팝업의 글과 확정 방식이 **지금 임무 중인가**에 따라
 * 갈린다. 판정은 새로 만들지 않고 `함선으로 귀환` 을 숨길 때 쓰는 그 값(`this.inHub` ← `ctx.isHubPhase()`)을 그대로 본다.
 *  - 함선: 「진행 중인 임무를 포기하고 … 전리품은 사라집니다」가 **거짓말**이다 (포기할 임무도 잃을 전리품도 없다) —
 *    함선용 글로 갈아 끼우고, 잃는 것이 없으므로 **한 번의 탭**으로 확정한다 (`Ask.tap`).
 *  - 임무 중: 예전 그대로 임무 문구 + 1초 홀드.
 *  - **`파티 떠나기` 는 함선에서도 홀드다** — 잃는 것은 없어도 분대 다른 사람에게 영향을 주는 행동이라 실수로 눌리면 안 된다.
 */
export class PauseMenu extends MenuBase {
  private returnBtn: HTMLButtonElement;
  private leaveBtn: HTMLButtonElement;
  private resumeBtn: HTMLButtonElement;
  /** True while the pause was opened from the ship (no mission to abandon). */
  private inHub = false;
  /** 2026-09-14: 메뉴를 연 순간 돌고 있던 튜토리얼 트랙 (null = 튜토리얼 아님 → 빨간 자리는 `함선으로 귀환`). */
  private track: TutorialTrack | null = null;
  /** The 경고 팝업 and the action it is guarding (null = closed). */
  private ask: HTMLElement;
  private askTitle: HTMLElement;
  private askBody: HTMLElement;
  /** 2026-09-15 2차: 확정 버튼 안 라벨 왼쪽의 좌클릭 홀드 키캡 — 탭 확정 팝업에서는 떼어 둔다. */
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
    // 2026-09-14: 한 자리, 두 뜻 — 튜토리얼 중이면 `튜토리얼 건너뛰기`, 아니면 `함선으로 귀환` (`refreshReturnButton`).
    this.returnBtn = this.button(actions, '함선으로 귀환', () => this.confirm(this.track ? this.skipAsk(this.track) : this.returnAsk()), 'danger');
    this.leaveBtn = this.button(actions, '파티 떠나기', () => this.confirm({
      title: '파티 떠나기',
      body: '분대에서 나갑니다. 공유 함선에서는 개인 함선으로 돌아갑니다.',
      ok: '떠나기',
      run: () => this.leaveParty(),
    }), 'danger');
    this.button(actions, '타이틀로', () => this.confirm(this.titleAsk()), 'danger');
    this.button(actions, '게임 종료', () => this.confirm(this.quitAsk()), 'danger');

    /* ── 경고 팝업: inside the frame's overlay so it darkens exactly the menu it guards ── */
    this.ask = el('div', { cls: 'pause-ask', parent: this.root });
    this.ask.hidden = true;
    const card = el('div', { cls: 'pause-ask-card', parent: this.ask });
    this.askTitle = el('div', { cls: 'pause-ask-title', text: '', parent: card });
    this.askBody = el('div', { cls: 'pause-ask-body', text: '', parent: card });
    const foot = el('div', { cls: 'pause-ask-foot', parent: card });
    this.askNo = el('button', { cls: 'ui-btn small', text: '취소', parent: foot });
    this.askOk = el('button', { cls: 'ui-btn small danger pause-ask-ok', parent: foot });
    // 홀드 키캡이 채움 바보다 **앞**이라 flex 순서로 라벨 왼쪽에 선다 (채움 바는 absolute 라 줄에서 빠진다).
    this.askCap = createHoldButtonCap(this.askOk);
    this.askFill = el('i', { cls: 'pause-ask-fill', parent: this.askOk });
    this.askOkLabel = el('span', { cls: 'pause-ask-ok-t', text: '확인', parent: this.askOk });
    this.askNo.addEventListener('click', (e) => { e.stopPropagation(); this.closeAsk(); });
    // 홀드 확정: pointerdown starts the sweep, leaving the button cancels, and `onWindowUp` catches every release.
    this.askOk.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.startHold(e); });
    this.askOk.addEventListener('pointerleave', () => this.cancelHold());
    // 홀드 팝업에서 click 은 *확정이 아니다* — 삼켜서 아무도 읽지 못하게 한다.
    // 탭 확정 팝업에서만 이 click 하나가 곧 확정이다 (`startHold` 는 그때 아무것도 무장하지 않는다).
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
   * 2026-09-14: 빨간 자리의 뜻을 정한다.
   *  - 튜토리얼이 돌고 있으면 `튜토리얼 건너뛰기` — **함선에서도 보인다** (함선 · 증축 트랙이 그곳에서 돈다).
   *  - 아니면 예전 그대로 `함선으로 귀환` 이고 함선에서는 숨는다 (포기할 임무가 없다).
   * `.ui-btn` 이 `display` 를 세우므로 `hidden` 속성이 아니라 `display` 를 직접 몬다.
   */
  private refreshReturnButton(): void {
    this.track = this.ctx.tutorial?.track ?? null;
    setText(this.returnBtn, this.track ? '튜토리얼 건너뛰기' : '함선으로 귀환');
    this.returnBtn.style.display = this.track ? '' : this.inHub ? 'none' : '';
  }

  /** Whether the hub variant is showing (debug). */
  get isHubVariant(): boolean { return this.inHub; }
  /** 2026-09-14: 빨간 자리가 지금 건너뛰려는 튜토리얼 트랙 (디버그 / 스모크, null = `함선으로 귀환`). */
  get skipTrackTarget(): TutorialTrack | null { return this.track; }
  /** Whether the 경고 팝업 is up (debug / smoke). */
  get isAskOpen(): boolean { return !this.ask.hidden; }
  /** 2026-09-14: 지금 뜬 팝업이 홀드 없이 탭 한 번으로 확정되는가 (디버그 / 스모크). */
  get isAskTap(): boolean { return !this.ask.hidden && !!this.pending?.tap; }
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
    // 2026-09-16: 메뉴 위에 메신저가 떠 있으면 Tab · Escape 는 그 패널 몫이다 (`hud/Community` · `ctx.escape`) — 메뉴는 남는다
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

  /* ── 경고 팝업 ───────────────────────────────────────────────────────────── */

  private confirm(ask: Ask): void {
    this.pending = ask;
    setText(this.askTitle, ask.title);
    setText(this.askBody, ask.body);
    setText(this.askOkLabel, ask.ok);
    // 탭 한 번으로 끝나는 확정에는 홀드 키캡이 붙지 않는다 (홀드하지 않는데 홀드하라고 그리면 안 된다).
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

  /* ── 확정 홀드 (UI_HOLD_CONFIRM_S) ───────────────────────────────────────── */

  /**
   * Left-button press on the red button arms the sweep; every other button is ignored.
   * 탭 확정 팝업은 여기서 아무것도 무장하지 않는다 — `preventDefault` 조차 하지 않아야 뒤따르는 click 이 그대로 온다.
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

  /**
   * 2026-09-14 (사용자 결정): 함선에서는 포기할 임무도 사라질 전리품도 없다 — 임무 문구를 빼고 **탭 한 번**으로 확정한다.
   * 임무 중에는 예전 문구 · 예전 홀드 그대로다. (함선의 진행은 프로필 · 함선 문서로 이미 저장돼 있으므로 그렇게 말한다.)
   */
  private titleAsk(): Ask {
    return this.inHub
      ? { title: '타이틀로', body: '타이틀 화면으로 돌아갑니다. 함선의 진행 상황은 저장되어 있습니다.', ok: '타이틀로', tap: true, run: () => this.toTitle() }
      : { title: '타이틀로', body: '진행 중인 임무를 포기하고 타이틀 화면으로 돌아갑니다. 회수하지 못한 전리품은 사라집니다.', ok: '타이틀로', run: () => this.toTitle() };
  }

  /** `titleAsk` 와 같은 갈래 — 함선에서는 잃는 것이 없으므로 임무 문구를 빼고 탭 한 번이다. */
  private quitAsk(): Ask {
    return this.inHub
      ? { title: '게임 종료', body: '게임을 종료합니다. 함선의 진행 상황은 저장되어 있습니다.', ok: '종료', tap: true, run: () => this.quit() }
      : { title: '게임 종료', body: '게임을 종료합니다. 진행 중인 임무는 저장되지 않습니다.', ok: '종료', run: () => this.quit() };
  }

  /**
   * 2026-09-14 (사용자 결정): `튜토리얼 건너뛰기` — **지금 도는 트랙 하나만** 끝낸다. 되돌릴 수 없으므로
   * `함선으로 귀환` 과 같은 경고 팝업 + 1초 홀드를 지난다. 글은 **그 트랙을 건너뛰면 무엇이 일어나는지**를
   * 말한다 — 레이드 트랙은 그 자리에서 탈출 처리되어 함선으로 가고(그 흐름은 tutorial · extraction 쪽이다),
   * 나머지 둘은 남은 안내가 사라질 뿐이다. 다른 트랙은 그대로 남아 제 때 시작한다.
   */
  private skipAsk(track: TutorialTrack): Ask {
    const body = track === 'raid'
      ? '진행 중인 튜토리얼을 건너뛰고 함선으로 갑니다. 남은 안내는 다시 나오지 않으며, 되돌릴 수 없습니다.'
      : track === 'ship'
        ? '함선 적응 튜토리얼을 건너뜁니다. 남은 안내는 다시 나오지 않으며, 되돌릴 수 없습니다.'
        // 2026-09-18: 증축 트랙이 `build`(증축 · 제작) 와 `raid2`(출격) 로 갈렸다 — 문구도 갈린다.
        //   `else` 로 뭉뚱그리면 출격 안내를 건너뛰면서 「시설 증축 · 제작」 을 건너뛴다고 적힌다.
        : track === 'raid2'
          ? '출격 준비 튜토리얼을 건너뜁니다. 남은 안내는 다시 나오지 않으며, 되돌릴 수 없습니다.'
          : '시설 증축 · 제작 튜토리얼을 건너뜁니다. 남은 안내는 다시 나오지 않으며, 되돌릴 수 없습니다.';
    return { title: '튜토리얼 건너뛰기', body, ok: '건너뛰기', run: () => this.skipTutorial(track) };
  }

  /** 메뉴를 먼저 닫고 튜토리얼에 넘긴다 — 레이드 트랙의 건너뛰기는 그 자리에서 화면을 바꾼다. */
  private skipTutorial(track: TutorialTrack): void {
    this.resume();
    try { this.ctx.tutorial?.skipTrack(track); } catch (e) { console.error('[ui] skipTrack failed', e); }
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
