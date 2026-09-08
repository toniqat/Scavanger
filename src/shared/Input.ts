import { LOCK_GESTURE_RETRY_MS } from './constants';
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
    window.addEventListener('blur', () => { this.down.clear(); this.mouseDown.clear(); });
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
      if (!self && this.wantLock) this.userUnlock?.();
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
  /**
   * A `requestPointerLock()` that arrived while our own `exitPointerLock()` was still in flight (2026-09-08).
   * `document.exitPointerLock()` clears `pointerLockElement` in a **task**, but the screens that release the cursor
   * re-lock from a **microtask**, so the request used to see `isPointerLocked === true` and vanish. Deferred to
   * `pointerlockchange` instead.
   */
  private relockPending = false;
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
    this.lastLockRequest = performance.now();
    // Modern Chrome returns a Promise that rejects when the lock is denied (e.g. headless, no user gesture) —
    // swallow it so a denied re-lock never surfaces as an unhandled rejection, and wait for a gesture instead.
    const denied = (): void => this.armLockGestureRetry();
    const swallow = (r: unknown): void => {
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(denied);
    };
    try { swallow((this.lockTarget as any).requestPointerLock?.({ unadjustedMovement: true }) ?? this.lockTarget.requestPointerLock()); }
    catch { try { swallow(this.lockTarget.requestPointerLock()); } catch { denied(); } }
    // Older engines return nothing at all, so also check the outcome once the event loop has settled.
    window.setTimeout(denied, LOCK_RESULT_CHECK_MS);
  }
  exitPointerLock(): void {
    this.wantLock = false;
    this.relockPending = false;
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
    this.pressed.clear(); this.released.clear();
    this.mousePressed.clear(); this.mouseReleased.clear();
    this.mouseDX = 0; this.mouseDY = 0; this.wheelDelta = 0;
  }
}
