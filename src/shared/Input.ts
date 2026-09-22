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
    // `window` listeners run in registration order — an overlay that has to swallow a key (chat · the console · a popup)
    // must bind in the **capture** phase to receive it before this one. The smokes fire keys at `document.body` too
    // (firing straight at window skips this order).
    window.addEventListener('keydown', (e) => {
      // Tab/Esc are game keys; Alt would otherwise focus the browser menu bar (the cursor key).
      if (e.code === 'Tab' || e.code === 'Escape' || e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    });
    /*
     * 2026-09-10 — a capture listener that times Escape and nothing else (`escapeHeld` · `escapeUpAt`, see
     * `relockBlockedFor`). The innermost popups (settings · the console · the quantity picker · chat) swallow Escape in
     * their own capture handler, so the keydown above **never sees it** — and yet when such a popup closes and lets the
     * cursor go, `main.ts` asks for a relock, so asking with the key missed is exactly the accident this file exists to
     * prevent. So the timing alone is recorded separately, in window's capture phase — the key is not recorded as
     * 'pressed', so the popup's swallowing is untouched.
     */
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape') this.escapeHeld = true; }, true);
    window.addEventListener('keyup', (e) => { if (e.code === 'Escape') { this.escapeHeld = false; this.escapeUpAt = performance.now(); } }, true);
    window.addEventListener('blur', () => {
      this.down.clear(); this.mouseDown.clear();
      // leaving the window with Escape held sends no keyup — that frame counts as the end of the Escape window.
      if (this.escapeHeld) { this.escapeHeld = false; this.escapeUpAt = performance.now(); }
    });
    window.addEventListener('mousedown', (e) => {
      // middle button = ping; stop browser auto-scroll while locked
      if (e.button === 1 && this.isPointerLocked) e.preventDefault();
      // Cursor mode: the press belongs to the UI under the real cursor, which already received it natively. Recording
      // it here as well would fire the gun behind an open panel.
      if (this.cursor.active) return;
      // Take the camera back with a left click (2026-09-07): nobody owns the cursor, yet the lock is missing — a screen
      // was closed with Escape and Chrome refused to hand the lock back (see the gesture retry below). The click *is*
      // the gesture Chrome was waiting for, so take the camera back on the spot and swallow the press: the recapture
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
        // 2026-09-08: a request that was already in flight when a screen took cursor mode lands *after* it — the
        // cursor would vanish under a popup the player is meant to click. Hand it straight back.
        if (this.cursor.active) this.exitPointerLock();
        return;
      }
      const self = this.selfExit;
      this.selfExit = false;
      // 2026-09-08: a re-lock that was asked for **while this exit was still in flight** (see `requestPointerLock`)
      // is issued here, now that `pointerLockElement` is really gone. Without it the request was silently dropped
      // and the player was left with a free cursor and no way to ask for the lock again — the state where, after
      // leaving the training range / after a screen flashed up for one tick, the camera was dead and only Escape left.
      if (this.relockPending) {
        this.relockPending = false;
        if (!this.cursor.active) { this.requestPointerLock(); return; }
      }
      if (self || !this.wantLock) return;
      /*
       * 2026-09-09 — **a lock we just asked for bouncing straight back out is not Escape.**
       *
       * Fullscreen Chrome and the desktop shell (Electron) sometimes hand over the lock `main.ts` re-acquired as a
       * screen or a mode closes, and then take it straight back. It never showed in a windowed browser, so it went
       * unfound for a long time; and if that second `pointerlockchange` leaks out of here as `userUnlock()`, `game/`
       * reads it as Escape and **puts the pause menu up by itself** — that is exactly the bug where closing housing
       * mode with Tab raised the ESC menu, and every screen that takes the lock back as it closes (the inventory · the
       * map · the terminal) shares the same root.
       *
       * So a lock that disappears within `LOCK_BOUNCE_GRACE_MS` of being **acquired** (`lockAcquiredAt`) is taken not to
       * be the player's, and raises no menu (on 2026-09-10 the anchor moved from the request time to the acquire time —
       * below). Missing a real Escape inside that window costs nothing: with no lock, Escape arrives as a real keydown
       * and `GameFlowSystem.update` opens the menu as usual.
       */
      /*
       * 2026-09-10 — a lock lost here is **one the player released with Escape**, and Chromium then refuses every
       * re-request for `LOCK_USER_EXIT_COOLDOWN_MS` (measured ~1.25 s) ("Pointer lock cannot be
       * acquired immediately after the user has exited the lock"). No gesture brings it forward —
       * neither a click nor a key helps — so the time is written down and `requestPointerLock` defers by that much.
       */
      this.userExitAt = performance.now();
      /*
       * A bounced lock (gone the moment it was acquired) is not Escape: raise no menu, take it again after the cooldown.
       * 2026-09-10 — the anchor moved **from the request time to the acquire time**. A relock is now deferred until
       * Escape is released (`relockBlockedFor`), so hundreds of ms open up between the request and the acquire, and
       * measuring from the request stretched the window by that delay and swallowed even the **real** Escape pressed
       * right after closing a screen. A bounce always happens right after the acquire.
       */
      if (performance.now() - this.lockAcquiredAt < LOCK_BOUNCE_GRACE_MS) {
        if (this.wantLock && !this.cursor.active) this.deferredRelock = true;
        this.armLockGestureRetry();
        return;
      }
      this.userUnlock?.();
    });
    // Escape becomes a game key in fullscreen (see `syncKeyboardLock`).
    document.addEventListener('fullscreenchange', this.syncKeyboardLock);
    this.syncKeyboardLock();
  }

  isDown(code: string): boolean { return this.down.has(code); }
  wasPressed(code: string): boolean { return this.pressed.has(code); }
  /**
   * Swallow a press for the rest of this frame (Phase 8). Systems are polled in registration order, so a later system
   * would otherwise react to the same key a earlier one just handled — e.g. hub/ closes the terminal on Escape and
   * drops its blocker, and game/ then sees an unblocked Escape and opens the pause menu in the same frame.
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

  /* ── 2026-09-10: a relock right after Escape is **deferred** (the bug where closing a screen with ESC in the exe
   * killed the controls) ────────────────────────────────────────────────────────────────────────────────────────
   *
   * Electron 44 / Chromium, measured (commit `3b12420`):
   *   ① While a screen is open there is no lock. When Escape closes the screen, `main.ts` asks for the lock **in the
   *      same frame** and Chromium **grants it** — and then that same Escape, still being processed, takes the
   *      just-born lock straight back. In the browser's eyes it is *the player releasing the lock with Escape*.
   *   ② After that **every** re-request is refused for `LOCK_USER_EXIT_COOLDOWN_MS` (~1.25 s):
   *      "Pointer lock cannot be acquired immediately after the user has exited the lock".
   *      Neither a click nor a key press brings that cooldown forward (it is not a gesture problem).
   *   ③ That is why the camera lay dead and came back on **one left click** — that click just happened to be 1.25 s
   *      later. (`takeLockOnClick` · the gesture retry ask again at that point and succeed.)
   *   ④ A request made after Escape is released simply succeeds, with no user activation — so what is needed is not
   *      a gesture but **timing**. The activation `__scavShellRelock` in `electron/main.ts` used to hand over was
   *      aiming at the wrong cause, and it now passes this gate along with the rest.
   *
   * So a request that arrives inside the blocked window (= while Escape is held + `LOCK_ESCAPE_DEFER_MS` after it is
   * released, and `LOCK_USER_EXIT_COOLDOWN_MS` after a real user release) is **not sent to the browser**; only the
   * intent is written down (`deferredRelock`). `endFrame()` re-measures that time every frame and sends it exactly once,
   * the moment it passes — several places (the microtask in main.ts · the shell hook · the gesture retry) may pile up
   * and the requests still merge into one, so Chromium's "Too many pointer lock requests in a short window of time"
   * throttle is never hit either.
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
    if (this.escapeHeld) until = now + LOCK_ESCAPE_DEFER_MS;                       // still held — re-measured every frame
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
    // Inside the Escape window or the user-exit cooldown it is not sent (the block above) — `endFrame` calls again on the frame it clears.
    if (this.relockBlockedFor() > 0) { this.deferredRelock = true; return; }
    /*
     * 2026-09-10 — one request at a time. On the same click `takeLockOnClick` and `onLockGesture`, and at boot
     * `main.ts` and `hub/Transitions`, piled up in the same ms and the second was being refused with "Pointer lock
     * pending" — and even that wasted request counts toward Chromium's "Too many pointer lock requests in a short
     * window of time" counter. No new request is sent until the outcome (granted · refused · the 250 ms check below) arrives.
     */
    // the intent is kept — even when the earlier request fails silently, `endFlush` sends this one in its place 250 ms later.
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
   * That is why the pause menu used to need two presses: the first Escape only freed the cursor. Every browser
   * FPS solves this the same way, by treating the *unlock itself* as the menu key: `pointerlockchange` is the only
   * signal there is (`web.dev/articles/pointerlock-intro`).
   *
   * `exitPointerLock()` above marks our own releases (a screen taking cursor mode), so what reaches the listener is a
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
   * (Electron 44, measured, 2026-09-10): the ~1.25 s cooldown after the player left the lock with Escape, and the rate
   * limit on requests in a short window. Those we simply ask again for, a moment later. Everything else — above all
   * "A user gesture is required to request Pointer Lock" — is the case the left-click gate / gesture retry exists
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

  /* ── Fullscreen keyboard lock (2026-09-07) ───────────────────────────────────
   *
   * Escape is the one key the page cannot keep: Chrome consumes it to leave fullscreen / pointer lock, which is why a
   * screen closed with Escape lands in the retry above. `navigator.keyboard.lock(['Escape'])` — available **only**
   * while the document is fullscreen — routes it to the page instead, so Escape stops breaking the lock and
   * "close a menu with Esc and the camera is back at once" becomes literally true. Leaving fullscreen is then a *long* Escape press,
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

  /* ── Mouse cursor mode ───────────────────────────────────────────────────── */
  /** true while a UI surface owns the real mouse cursor (the pointer lock is released, the camera does not turn). */
  get isCursorMode(): boolean { return this.cursor.active; }
  /** Cursor position in client px. Kept under its own name so UI code reads intent, not the raw field. */
  get cursorX(): number { return this.mouseX; }
  get cursorY(): number { return this.mouseY; }
  /**
   * Enter / leave cursor mode. `owner` is the caller's `ctx.uiBlockers` token; nesting is ref-counted, so a popup
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
    this.clearEdges();
  }

  /**
   * 2026-09-21 (E-12): forget this frame's edges (pressed / released) and accumulated deltas, keep what is held.
   * `endFrame` = this + the deferred relock.
   */
  clearEdges(): void {
    this.pressed.clear(); this.released.clear();
    this.mousePressed.clear(); this.mouseReleased.clear();
    this.mouseDX = 0; this.mouseDY = 0; this.wheelDelta = 0;
  }

  /**
   * 2026-09-21 (E-12): hide this frame's edges and deltas until `releaseEdges`, keeping what is held. The engine
   * wraps every sim sub-step but the **last** of one rendered frame in it (smoke clock only, `Engine.frame`), so a
   * press, a click or a look delta is seen by exactly one sub-step — and by the one whose state is drawn: a shot
   * fired in an earlier sub-step would leave the screen's crosshair (and aim sway) behind it. Handing the edges to
   * the first sub-step instead failed `smoke-aim-sway`'s "shot lands on the rendered crosshair ray". Nested calls
   * are not supported; input events cannot arrive in between (the frame is one synchronous task).
   * 2026-09-22: the **held state** is wound back with the edges — the earlier sub-steps see the keys and buttons as they
   * were before this frame's events. Hiding only the edges let a sub-step read a button already up with no release
   * edge, which `ui/hud/Pings` takes for 「reset without a release」 and cancels the ping (`smoke-phase2`, 6 lanes).
   * A key both pressed and released this frame keeps its current state (a tap is up before and after).
   */
  holdEdges(): void {
    if (this.held) return;
    this.held = {
      pressed: this.pressed, released: this.released, mousePressed: this.mousePressed, mouseReleased: this.mouseReleased,
      dx: this.mouseDX, dy: this.mouseDY, wheel: this.wheelDelta, down: this.down, mouseDown: this.mouseDown,
    };
    this.down = Input.before(this.down, this.pressed, this.released);
    this.mouseDown = Input.before(this.mouseDown, this.mousePressed, this.mouseReleased);
    this.pressed = new Set(); this.released = new Set();
    this.mousePressed = new Set(); this.mouseReleased = new Set();
    this.mouseDX = 0; this.mouseDY = 0; this.wheelDelta = 0;
  }

  /** Puts back what `holdEdges` hid. */
  releaseEdges(): void {
    const h = this.held;
    if (!h) return;
    this.held = null;
    this.pressed = h.pressed; this.released = h.released;
    this.mousePressed = h.mousePressed; this.mouseReleased = h.mouseReleased;
    this.mouseDX = h.dx; this.mouseDY = h.dy; this.wheelDelta = h.wheel;
    this.down = h.down; this.mouseDown = h.mouseDown;
  }
  /** The held set as it was before this frame's `pressed` / `released` edges (`holdEdges`). */
  private static before<T>(now: Set<T>, pressed: Set<T>, released: Set<T>): Set<T> {
    const was = new Set(now);
    for (const k of pressed) if (!released.has(k)) was.delete(k);
    for (const k of released) if (!pressed.has(k)) was.add(k);
    return was;
  }
  private held: {
    pressed: Set<string>; released: Set<string>; mousePressed: Set<number>; mouseReleased: Set<number>;
    dx: number; dy: number; wheel: number; down: Set<string>; mouseDown: Set<number>;
  } | null = null;

  /** Sends the deferred relock (the gate in `requestPointerLock` above) exactly once, on the first frame the conditions clear. */
  private flushDeferredRelock(): void {
    if (!this.deferredRelock) return;
    // if a screen opened in the meantime (a cursor owner), or the lock already came back, the intent itself disappears.
    if (!this.wantLock || this.cursor.active || this.isPointerLocked) { this.deferredRelock = false; return; }
    if (this.relockBlockedFor() > 0) return;
    if (this.lockInFlight && performance.now() - this.lastLockRequest < LOCK_RESULT_CHECK_MS) return;
    this.deferredRelock = false;
    this.requestPointerLock();
  }
}
