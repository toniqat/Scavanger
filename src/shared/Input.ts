import {
  LOCK_BOUNCE_GRACE_MS, LOCK_ESCAPE_DEFER_MS, LOCK_GESTURE_RETRY_MS, LOCK_RELOCK_RETRIES, LOCK_USER_EXIT_COOLDOWN_MS,
} from './constants';
import { CursorMode } from './cursor';

/** How long after a lock request we check whether it actually took (engines that return no promise). */
const LOCK_RESULT_CHECK_MS = 250;

/**
 * Global input state. Owned by shared/, read by player, inventory UI and menus.
 * Poll `isDown` / `wasPressed` in update(); mouse delta is accumulated per frame and cleared by Engine.endFrame().
 */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  private mouseDown = new Set<number>();
  private mousePressed = new Set<number>();
  private mouseReleased = new Set<number>();
  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;
  /** Client-space pointer position. The single source of truth for every UI hit test (`uiX` / `uiY` alias it). */
  mouseX = 0;
  mouseY = 0;
  private lockTarget: HTMLElement | null = null;
  private bound = false;
  /**
   * 2026-09-07 rework: which UI surfaces want the **real** mouse cursor. While `cursor.active` the pointer lock is
   * released, so the browser delivers genuine events to the DOM and gameplay simply stops seeing the mouse
   * (`mouseDX/DY` need the lock, and the button sets below are not filled). See `shared/cursor.ts`.
   */
  readonly cursor = new CursorMode();

  bind(target: HTMLElement): void {
    if (this.bound) return;
    this.bound = true;
    this.lockTarget = target;
    window.addEventListener('keydown', (e) => {
      // Tab/Esc are game keys; Alt would otherwise focus the browser menu bar (커서 호출 키).
      if (e.code === 'Tab' || e.code === 'Escape' || e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    });
    /*
     * 2026-09-10 — Escape 의 시각만 재는 capture 리스너 (`escapeHeld` · `escapeUpAt`, see `relockBlockedFor`).
     * 가장 안쪽 팝업(설정 · 콘솔 · 수량 지정 · 채팅)은 Escape 를 자기 capture 핸들러에서 삼켜 위의 keydown 이
     * 그것을 **보지 못한다** — 그런데 그 팝업이 닫히면서 커서를 놓으면 `main.ts` 가 재잠금을 요청하므로, 키를
     * 놓친 채로 요청하면 이 파일이 막으려는 바로 그 사고가 난다. 그래서 시각 기록만 window 의 capture 단계에서
     * 따로 한다 — 키를 '눌린 것'으로 기록하지는 않으므로 팝업의 삼킴은 그대로다.
     */
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape') this.escapeHeld = true; }, true);
    window.addEventListener('keyup', (e) => { if (e.code === 'Escape') { this.escapeHeld = false; this.escapeUpAt = performance.now(); } }, true);
    window.addEventListener('blur', () => {
      this.down.clear(); this.mouseDown.clear();
      // Escape 를 누른 채 창을 떠나면 keyup 이 오지 않는다 — 그 프레임을 Escape 창의 끝으로 친다.
      if (this.escapeHeld) { this.escapeHeld = false; this.escapeUpAt = performance.now(); }
    });
    window.addEventListener('mousedown', (e) => {
      // middle button = ping; stop browser auto-scroll while locked
      if (e.button === 1 && this.isPointerLocked) e.preventDefault();
      // 커서 모드: the press belongs to the UI under the real cursor, which already received it natively. Recording
      // it here as well would fire the gun behind an open panel.
      if (this.cursor.active) return;
      // 좌클릭으로 카메라 되찾기 (2026-09-07): nobody owns the cursor, yet the lock is missing — a screen was closed
      // with Escape and Chrome refused to hand the lock back (see the gesture retry below). The click *is* the
      // gesture Chrome was waiting for, so take the camera back on the spot and swallow the press: the recapture
      // click must not also fire the weapon.
      if (this.takeLockOnClick(e)) return;
      if (!this.mouseDown.has(e.button)) this.mousePressed.add(e.button);
      this.mouseDown.add(e.button);
      // Rebindable actions may sit on a mouse button: mirror it as the synthetic key code `MouseN`.
      const code = `Mouse${e.button}`;
      if (!this.down.has(code)) this.pressed.add(code);
      this.down.add(code);
    });
    window.addEventListener('mouseup', (e) => {
      if (this.cursor.active) { this.mouseDown.delete(e.button); return; }
      this.mouseDown.delete(e.button);
      this.mouseReleased.add(e.button);
      const code = `Mouse${e.button}`;
      this.down.delete(code);
      this.released.add(code);
    });
    window.addEventListener('mousemove', (e) => {
      // A locked pointer freezes the client coordinates, so this only tracks a real position while the cursor is
      // free — which is exactly when the UI needs one.
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      if (this.isPointerLocked && !this.cursor.active) { this.mouseDX += e.movementX; this.mouseDY += e.movementY; }
    });
    window.addEventListener('wheel', (e) => {
      if (this.cursor.active) return;                  // the panel under the cursor scrolls natively
      this.wheelDelta += Math.sign(e.deltaY);
    }, { passive: true });
    window.addEventListener('contextmenu', (e) => { if (this.isPointerLocked) e.preventDefault(); });
    // The lock arrived (from a request of ours or a click on the canvas) — stop waiting for a gesture.
    // The lock *left* without us asking → the player pressed Escape (see `onUserUnlock`).
    document.addEventListener('pointerlockchange', () => {
      if (this.isPointerLocked) {
        this.disarmLockGestureRetry();
        this.selfExit = false;
        this.relockPending = false;
        this.deferredRelock = false;
        this.lockInFlight = false;
        this.blockedUntil = 0;
        this.relockRetries = LOCK_RELOCK_RETRIES;
        this.lockAcquiredAt = performance.now();
        // 2026-09-08: a request that was already in flight when a screen took 커서 모드 lands *after* it — the
        // cursor would vanish under a popup the player is meant to click. Hand it straight back.
        if (this.cursor.active) this.exitPointerLock();
        return;
      }
      const self = this.selfExit;
      this.selfExit = false;
      // 2026-09-08: a re-lock that was asked for **while this exit was still in flight** (see `requestPointerLock`)
      // is issued here, now that `pointerLockElement` is really gone. Without it the request was silently dropped
      // and the player was left with a free cursor and no way to ask for the lock again — which is what made
      // 훈련장을 빠져나온 뒤 / 화면이 한 tick 떴다 사라진 뒤 카메라가 죽고 Escape 만 남던 상태였다.
      if (this.relockPending) {
        this.relockPending = false;
        if (!this.cursor.active) { this.requestPointerLock(); return; }
      }
      if (self || !this.wantLock) return;
      /*
       * 2026-09-09 — **우리가 방금 요청한 락이 튕겨 나온 것은 Escape 가 아니다.**
       *
       * 전체화면 Chrome 과 데스크톱 셸(Electron)은 화면 · 모드가 닫히면서 `main.ts` 가 다시 잡은 락을 넘겨줬다가
       * 곧바로 도로 가져가는 일이 있다. 창 모드 브라우저에서는 안 나던 증상이라 오래 안 잡혔는데, 그 두 번째
       * `pointerlockchange` 가 여기서 `userUnlock()` 으로 새어 나가면 `game/` 이 그것을 Escape 로 읽고
       * **일시정지 메뉴를 혼자 띄운다** — 하우징 모드를 Tab 으로 닫으면 ESC 메뉴가 뜨던 문제가 바로 이것이고,
       * 인벤토리 · 지도 · 터미널처럼 닫으면서 락을 되찾는 화면 전부가 같은 뿌리를 공유한다.
       *
       * 그래서 락을 **잡은 직후**(`lockAcquiredAt`) `LOCK_BOUNCE_GRACE_MS` 안에 사라진 락은 플레이어의 것이
       * 아니라고 보고 메뉴를 띄우지 않는다 (2026-09-10 에 기준을 요청 시각에서 획득 시각으로 옮겼다 — 아래).
       * 진짜 Escape 를 이 창에서 놓치더라도 손해가 없다: 락이 없는 상태의 Escape 는 진짜 keydown 으로 들어와
       * `GameFlowSystem.update` 가 그대로 메뉴를 연다.
       */
      /*
       * 2026-09-10 — 여기서 잃은 락은 **플레이어가 Escape 로 푼 것**이고, Chromium 은 그 뒤
       * `LOCK_USER_EXIT_COOLDOWN_MS`(실측 ~1.25초) 동안 재요청을 전부 거부한다 ("Pointer lock cannot be
       * acquired immediately after the user has exited the lock"). 제스처로는 앞당겨지지 않으므로 —
       * 클릭도 키도 소용없다 — 시각을 적어 두고 `requestPointerLock` 이 그만큼 미루게 한다.
       */
      this.userExitAt = performance.now();
      /*
       * 튕겨 나온 락(잡자마자 사라진 것)은 Escape 가 아니다: 메뉴를 띄우지 말고 쿨다운 뒤 다시 잡는다.
       * 2026-09-10 — 기준을 **요청 시각에서 획득 시각으로** 옮겼다. 재잠금이 이제 Escape 를 뗀 뒤로 미뤄지므로
       * (`relockBlockedFor`) 요청과 획득 사이가 수백 ms 씩 벌어지고, 요청 기준으로 재면 그 지연만큼 창이 길어져
       * 화면을 닫자마자 누른 **진짜** Escape 까지 삼켰다. 튕김은 언제나 획득 직후에 일어난다.
       */
      if (performance.now() - this.lockAcquiredAt < LOCK_BOUNCE_GRACE_MS) {
        if (this.wantLock && !this.cursor.active) this.deferredRelock = true;
        this.armLockGestureRetry();
        return;
      }
      this.userUnlock?.();
    });
    // 전체화면에서 Escape 를 게임 키로 (see `syncKeyboardLock`).
    document.addEventListener('fullscreenchange', this.syncKeyboardLock);
    this.syncKeyboardLock();
  }

  isDown(code: string): boolean { return this.down.has(code); }
  wasPressed(code: string): boolean { return this.pressed.has(code); }
  /**
   * Swallow a press for the rest of this frame (Phase 8). Systems are polled in registration order, so a later system
   * would otherwise react to the same key a earlier one just handled — e.g. hub/ closes the terminal on Escape and
   * drops its blocker, and game/ then sees an unblocked Escape and opens the 일시정지 메뉴 in the same frame.
   * Call this right after handling a key that a later system also polls.
   */
  consume(code: string): void { this.pressed.delete(code); }
  /** Same for a mouse button (`wasMousePressed`), including its synthetic `MouseN` key code. */
  consumeMouse(button: number): void { this.mousePressed.delete(button); this.pressed.delete(`Mouse${button}`); }
  wasReleased(code: string): boolean { return this.released.has(code); }
  /** 0 = left, 1 = middle, 2 = right */
  isMouseDown(button: number): boolean { return this.mouseDown.has(button); }
  wasMousePressed(button: number): boolean { return this.mousePressed.has(button); }
  wasMouseReleased(button: number): boolean { return this.mouseReleased.has(button); }

  get isPointerLocked(): boolean { return !!this.lockTarget && document.pointerLockElement === this.lockTarget; }
  /**
   * A left click **on the 3D canvas** while the camera wants the lock but does not have it: re-request it and
   * report true so the caller swallows the press. Gated on `wantLock`, so the title screen (nobody asked for the
   * lock) is untouched, and on the canvas being the event target, so a click on an interactive HUD element still
   * belongs to that element. A denied request still arms the gesture retry, exactly as before.
   */
  private takeLockOnClick(e: MouseEvent): boolean {
    if (e.button !== 0 || !this.wantLock || this.isPointerLocked || !this.lockTarget) return false;
    if (e.target !== this.lockTarget) return false;
    this.requestPointerLock();
    return true;
  }
  /** performance.now() of the last pointer-lock request (Chrome throttles re-locks right after an Esc exit). */
  lastLockRequest = 0;
  /** performance.now() when the lock was last granted — the anchor for the bounce test below. */
  private lockAcquiredAt = 0;
  /**
   * A `requestPointerLock()` that arrived while our own `exitPointerLock()` was still in flight (2026-09-08).
   * `document.exitPointerLock()` clears `pointerLockElement` in a **task**, but the screens that release the cursor
   * re-lock from a **microtask**, so the request used to see `isPointerLocked === true` and vanish. Deferred to
   * `pointerlockchange` instead.
   */
  private relockPending = false;

  /* ── 2026-09-10: Escape 직후의 재잠금은 **미룬다** (exe 에서 ESC 로 화면을 닫으면 조작이 죽던 문제) ────────────
   *
   * Electron 44 / Chromium 실측 (`docs/HISTORY.md` 2026-09-10):
   *   ① 화면이 열려 있는 동안에는 락이 없다. Escape 로 화면이 닫히면 `main.ts` 가 **같은 프레임에** 락을
   *      요청하고 Chromium 은 그것을 **허가한다** — 그런데 아직 처리 중이던 그 Escape 가 방금 생긴 락을
   *      곧바로 도로 가져간다. 브라우저 눈에는 *플레이어가 Escape 로 락을 푼 것*이다.
   *   ② 그 뒤 `LOCK_USER_EXIT_COOLDOWN_MS`(~1.25초) 동안 **모든** 재요청이 거부된다:
   *      "Pointer lock cannot be acquired immediately after the user has exited the lock".
   *      클릭도 키 입력도 이 쿨다운을 앞당기지 못한다 (제스처의 문제가 아니다).
   *   ③ 그래서 카메라가 죽어 있다가 **좌클릭 한 번**에 살아났다 — 그 클릭이 마침 1.25초 뒤였을 뿐이다.
   *      (`takeLockOnClick` · 제스처 재시도가 그때 다시 요청해 성공한다.)
   *   ④ Escape 를 뗀 뒤에 요청하면 활성화(user activation) 없이도 그냥 성공한다 — 즉 필요한 것은
   *      제스처가 아니라 **타이밍**이다. `electron/main.ts` 의 `__scavShellRelock` 이 건네던 activation 은
   *      원인을 잘못 짚은 것이었고, 이제는 이 게이트를 함께 통과한다.
   *
   * 그래서 요청이 막힌 시간대(= Escape 를 누르고 있는 동안 + 뗀 뒤 `LOCK_ESCAPE_DEFER_MS`, 그리고 진짜
   * 사용자 해제 뒤 `LOCK_USER_EXIT_COOLDOWN_MS`)에 들어온 요청은 **브라우저에 보내지 않고** 의사만
   * 적어 둔다(`deferredRelock`). `endFrame()` 이 매 프레임 그 시각을 다시 재서 통과하는 순간 한 번만 보낸다 —
   * 여러 곳(main.ts 의 마이크로태스크 · 셸 훅 · 제스처 재시도)에서 겹쳐 들어와도 요청은 하나로 합쳐지므로
   * Chromium 의 "Too many pointer lock requests in a short window of time" 스로틀에도 걸리지 않는다.
   */
  private escapeHeld = false;
  private escapeUpAt = 0;
  private userExitAt = 0;
  /** Chromium's own rate limit / cooldown told us to wait — do not ask again before this (ms, `performance.now`). */
  private blockedUntil = 0;
  /** How many timed retries a single "the camera wants the lock" episode may still spend (reset on lock / release). */
  private relockRetries = LOCK_RELOCK_RETRIES;
  /** A request that arrived inside the blocked window — `endFrame` re-issues it once the window passes. */
  private deferredRelock = false;

  /** ms to wait before the browser will accept a pointer-lock request (0 = ask now). */
  private relockBlockedFor(): number {
    const now = performance.now();
    let until = 0;
    if (this.escapeHeld) until = now + LOCK_ESCAPE_DEFER_MS;                       // 아직 누르고 있다 — 매 프레임 다시 잰다
    else if (this.escapeUpAt) until = Math.max(until, this.escapeUpAt + LOCK_ESCAPE_DEFER_MS);
    if (this.userExitAt) until = Math.max(until, this.userExitAt + LOCK_USER_EXIT_COOLDOWN_MS);
    if (this.blockedUntil) until = Math.max(until, this.blockedUntil);
    return Math.max(0, until - now);
  }

  requestPointerLock(): void {
    if (!this.lockTarget) return;
    // 2026-09-08: **never** take the mouse away from an open screen. Callers that fire a relock right after a phase
    // change (the hub entering the personal ship, say) would otherwise race a popup that opened in the same tick and
    // leave the player with a clickable card and no cursor. `main.ts` re-locks when the last owner leaves.
    if (this.cursor.active) return;
    // Our own unlock is still in flight (`pointerLockElement` is cleared in a task, this is a microtask) — hold the
    // request and re-issue it from `pointerlockchange`. Both halves are checked: an engine that clears the element
    // synchronously (and the headless stubs, which never fire the event at all) take the plain path below.
    if (this.selfExit && this.isPointerLocked) { this.relockPending = true; return; }
    if (this.isPointerLocked) return;
    this.wantLock = true;
    // Escape 창 · 사용자 해제 쿨다운 안이면 보내지 않는다 (위 블록) — `endFrame` 이 풀리는 프레임에 다시 부른다.
    if (this.relockBlockedFor() > 0) { this.deferredRelock = true; return; }
    /*
     * 2026-09-10 — 요청은 한 번에 하나만. 같은 클릭에 `takeLockOnClick` 과 `onLockGesture` 가, 부팅 때는
     * `main.ts` 와 `hub/Transitions` 가 같은 ms 에 겹쳐 들어와 두 번째가 "Pointer lock pending" 으로 거부되고
     * 있었다 — 그 헛요청까지 Chromium 의 "Too many pointer lock requests in a short window of time" 카운터에
     * 들어간다. 결과(허가 · 거부 · 아래 250 ms 확인)가 올 때까지는 새 요청을 보내지 않는다.
     */
    // 의사는 남긴다 — 앞선 요청이 조용히 실패해도 `endFlush` 가 250 ms 뒤에 이 요청을 대신 보낸다.
    if (this.lockInFlight && performance.now() - this.lastLockRequest < LOCK_RESULT_CHECK_MS) { this.deferredRelock = true; return; }
    this.deferredRelock = false;
    this.lockInFlight = true;
    this.lastLockRequest = performance.now();
    // Modern Chrome returns a Promise that rejects when the lock is denied (e.g. headless, no user gesture) —
    // swallow it so a denied re-lock never surfaces as an unhandled rejection, and wait for a gesture instead.
    const denied = (e?: unknown): void => this.onLockDenied(e);
    const swallow = (r: unknown): void => {
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(denied);
    };
    try { swallow((this.lockTarget as any).requestPointerLock?.({ unadjustedMovement: true }) ?? this.lockTarget.requestPointerLock()); }
    catch (e) { try { swallow(this.lockTarget.requestPointerLock()); } catch { denied(e); } }
    // Older engines return nothing at all, so also check the outcome once the event loop has settled.
    window.setTimeout(() => denied(), LOCK_RESULT_CHECK_MS);
  }
  exitPointerLock(): void {
    this.wantLock = false;
    this.relockPending = false;
    this.deferredRelock = false;
    this.lockInFlight = false;
    this.blockedUntil = 0;
    this.relockRetries = LOCK_RELOCK_RETRIES;
    this.disarmLockGestureRetry();
    if (this.isPointerLocked) { this.selfExit = true; document.exitPointerLock(); }
  }

  /* ── 2026-09-08: Escape while locked is a *lock exit*, never a keydown ─────────────────────────────────────
   *
   * The browser reserves Escape for leaving the pointer lock and **swallows the key** — the page is never told.
   * That is why the 일시정지 메뉴 used to need two presses: the first Escape only freed the cursor. Every browser
   * FPS solves this the same way, by treating the *unlock itself* as the menu key: `pointerlockchange` is the only
   * signal there is (`web.dev/articles/pointerlock-intro`).
   *
   * `exitPointerLock()` above marks our own releases (a screen taking 커서 모드), so what reaches the listener is a
   * lock the player took away while the camera still wanted it — Escape, or a focus loss, which pauses anyway.
   *
   * Re-locking from here would be pointless: after the default unlock gesture the spec requires a fresh engagement
   * gesture before `requestPointerLock` succeeds, and repeated Escapes let the UA demand more still. The pause
   * menu's `게임으로 돌아가기` click **is** that gesture, which is why Escape must not close the menu.
   */
  private selfExit = false;
  private userUnlock: (() => void) | null = null;
  /** One listener (`main.ts`), mirrored onto the bus as `input:pointerLockLost`. */
  onUserUnlock(listener: (() => void) | null): void { this.userUnlock = listener; }

  /* ── 2026-09-07: a denied lock request waits for the next real user gesture ──────────────────────────────────
   *
   * Chrome does **not** treat Escape as user activation (it is reserved for leaving fullscreen / pointer lock), and
   * it refuses a pointer-lock request for a moment after the user escaped out of one. So closing a screen with
   * Escape — the way most players close one — asks for the lock at the one instant Chrome will not grant it. Instead
   * of giving up, hold the intent and retry from the player's next real gesture (a click, or any key that is not
   * Escape) — in practice the first WASD tap, so the lock comes back at once.
   *
   * `syncKeyboardLock` below removes the problem outright while the game is fullscreen.
   */
  /** Someone asked for the lock and it has not been granted or cancelled yet. */
  private wantLock = false;
  private lockRetryUntil = 0;
  private lockRetryBound = false;

  /** true while a denied lock request is still waiting for a user gesture to retry from. */
  get awaitingLockGesture(): boolean { return this.lockRetryBound && performance.now() < this.lockRetryUntil; }
  /** true while a refused request is going to be re-sent by itself (`game/ResumeGate` stays out of the way). */
  get relockScheduled(): boolean { return this.deferredRelock; }

  /** A request of ours has not been answered yet (granted / refused / the 250 ms check below). */
  private lockInFlight = false;
  /**
   * Chromium refuses a pointer-lock request for two reasons that **no gesture can fix**, both purely about timing
   * (Electron 44 실측, 2026-09-10): the ~1.25 s cooldown after the player left the lock with Escape, and the rate
   * limit on requests in a short window. Those we simply ask again for, a moment later. Everything else — above all
   * "A user gesture is required to request Pointer Lock" — is the case the 좌측 클릭 게이트 / gesture retry exists
   * for, and is left to it.
   */
  private static readonly TIMING_DENIAL = /too many pointer lock requests|immediately after the user has exited|pointer lock pending/i;

  private onLockDenied(err?: unknown): void {
    this.lockInFlight = false;
    if (this.deferredRelock) return;                                  // already scheduled — one retry is enough
    if (!this.wantLock || this.isPointerLocked || this.cursor.active) return;
    const msg = err instanceof Error ? err.message : '';
    if (msg && Input.TIMING_DENIAL.test(msg) && this.relockRetries > 0) {
      this.relockRetries--;
      this.blockedUntil = performance.now() + LOCK_USER_EXIT_COOLDOWN_MS;
      this.deferredRelock = true;
      return;
    }
    this.armLockGestureRetry();
  }

  private armLockGestureRetry(): void {
    if (!this.wantLock || this.isPointerLocked || !this.lockTarget) return;
    if (this.lockRetryBound) return;                    // keep the original deadline: never wait longer than one window
    this.lockRetryBound = true;
    this.lockRetryUntil = performance.now() + LOCK_GESTURE_RETRY_MS;
    window.addEventListener('pointerdown', this.onLockGesture, true);
    window.addEventListener('keydown', this.onLockGesture, true);
  }

  private disarmLockGestureRetry(): void {
    this.lockRetryUntil = 0;
    if (!this.lockRetryBound) return;
    this.lockRetryBound = false;
    window.removeEventListener('pointerdown', this.onLockGesture, true);
    window.removeEventListener('keydown', this.onLockGesture, true);
  }

  private onLockGesture = (e: Event): void => {
    if (e instanceof KeyboardEvent && (e.code === 'Escape' || e.repeat)) return;   // Escape grants none in Chrome
    if (!this.wantLock || this.isPointerLocked || !this.awaitingLockGesture) { this.disarmLockGestureRetry(); return; }
    if (this.cursor.active) { this.disarmLockGestureRetry(); return; }             // a screen opened in the meantime
    this.disarmLockGestureRetry();
    this.requestPointerLock();
  };

  /* ── 전체화면 키보드 락 (2026-09-07) ──────────────────────────────────────────
   *
   * Escape is the one key the page cannot keep: Chrome consumes it to leave fullscreen / pointer lock, which is why a
   * screen closed with Escape lands in the retry above. `navigator.keyboard.lock(['Escape'])` — available **only**
   * while the document is fullscreen — routes it to the page instead, so Escape stops breaking the lock and
   * "메뉴를 Esc 로 닫으면 즉시 카메라" becomes literally true. Leaving fullscreen is then a *long* Escape press,
   * which is the browser's own documented affordance for it.
   */
  private readonly syncKeyboardLock = (): void => {
    const kb = (navigator as unknown as {
      keyboard?: { lock?(codes?: string[]): Promise<void> | undefined; unlock?(): void };
    }).keyboard;
    if (!kb) return;
    try {
      if (document.fullscreenElement) {
        const r = kb.lock?.(['Escape']);
        if (r && typeof r.catch === 'function') r.catch(() => { /* denied — the gesture retry covers it */ });
      } else kb.unlock?.();
    } catch { /* unsupported (Firefox / Safari) — the gesture retry covers it */ }
  };

  /** Is the document fullscreen with Escape routed to the page? (HUD hint / diagnostics.) */
  get keyboardLocked(): boolean {
    const kb = (navigator as unknown as { keyboard?: { lock?: unknown } }).keyboard;
    return !!document.fullscreenElement && !!kb?.lock;
  }

  /* ── 마우스 커서 모드 ────────────────────────────────────────────────────── */
  /** true while a UI surface owns the real mouse cursor (the pointer lock is released, the camera does not turn). */
  get isCursorMode(): boolean { return this.cursor.active; }
  /** Cursor position in client px. Kept under its own name so UI code reads intent, not the raw field. */
  get cursorX(): number { return this.mouseX; }
  get cursorY(): number { return this.mouseY; }
  /**
   * Enter / leave 커서 모드. `owner` is the caller's `ctx.uiBlockers` token; nesting is ref-counted, so a popup
   * layered over the inventory does not take the cursor away when it closes. Entering **releases the pointer lock**
   * (that is the whole mechanism); the re-lock on the way out is `main.ts`'s single relock point.
   */
  setCursorMode(active: boolean, owner: string): void {
    if (!this.cursor.setMode(active, owner)) return;
    if (this.cursor.active) {
      this.exitPointerLock();
      // Buttons held when the lock went away would stay stuck down (no `mouseup` reaches the gameplay path).
      this.mouseDown.clear(); this.mousePressed.clear(); this.mouseReleased.clear();
      this.mouseDX = 0; this.mouseDY = 0; this.wheelDelta = 0;
    }
    this.cursor.emitChange();
  }
  /** Seed the tracked cursor position (a panel's default focus, tests). The OS cursor itself cannot be warped. */
  setCursorPosition(x: number, y: number): void { this.mouseX = x; this.mouseY = y; }
  /** Cursor position a UI surface should read. */
  get uiX(): number { return this.mouseX; }
  get uiY(): number { return this.mouseY; }
  /** Element under the cursor (`document.elementFromPoint`); null when nothing is hit. */
  elementUnderCursor(): Element | null {
    if (typeof document.elementFromPoint !== 'function') return null;
    return document.elementFromPoint(this.mouseX, this.mouseY);
  }

  /** Called by Engine at the end of every frame. */
  endFrame(): void {
    this.flushDeferredRelock();
    this.pressed.clear(); this.released.clear();
    this.mousePressed.clear(); this.mouseReleased.clear();
    this.mouseDX = 0; this.mouseDY = 0; this.wheelDelta = 0;
  }

  /** 미뤄 둔 재잠금(위 `requestPointerLock` 의 게이트)을 조건이 풀리는 첫 프레임에 한 번만 보낸다. */
  private flushDeferredRelock(): void {
    if (!this.deferredRelock) return;
    // 그 사이에 화면이 열렸거나(커서 주인) 락이 이미 돌아왔으면 의사 자체가 사라진다.
    if (!this.wantLock || this.cursor.active || this.isPointerLocked) { this.deferredRelock = false; return; }
    if (this.relockBlockedFor() > 0) return;
    if (this.lockInFlight && performance.now() - this.lastLockRequest < LOCK_RESULT_CHECK_MS) return;
    this.deferredRelock = false;
    this.requestPointerLock();
  }
}
