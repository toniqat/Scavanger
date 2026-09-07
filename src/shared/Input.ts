import { SoftCursor, isSoftCursorEvent } from './cursor';

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
  /** Client-space pointer position (for UI when pointer is not locked). */
  mouseX = 0;
  mouseY = 0;
  private lockTarget: HTMLElement | null = null;
  private bound = false;
  /**
   * appended (Phase 10): 인게임 마우스 커서. While `cursor.active` the pointer lock is KEPT and this virtual cursor is
   * driven by the raw `movementX/movementY` deltas, synthesising the DOM pointer/mouse events at its own position
   * (see `shared/cursor.ts`). Systems use `setCursorMode` / `uiX` / `uiY` / `elementUnderCursor` instead of touching it.
   */
  readonly cursor = new SoftCursor();

  bind(target: HTMLElement): void {
    if (this.bound) return;
    this.bound = true;
    this.lockTarget = target;
    window.addEventListener('keydown', (e) => {
      // Tab/Esc are game keys; Alt would otherwise focus the browser menu bar (dive key).
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
      if (isSoftCursorEvent(e)) return;   // our own synthetic echo — never register it as a second press
      // middle button = ping; stop browser auto-scroll while locked
      if (e.button === 1 && this.isPointerLocked) e.preventDefault();
      // Software cursor: the press belongs to the UI under the virtual cursor, not to gameplay. Only while the lock is
      // actually held — unlocked, the real cursor already delivers native events and a second set would double-click.
      if (this.cursor.active && this.isPointerLocked) { this.cursor.press(e.button); return; }
      if (!this.mouseDown.has(e.button)) this.mousePressed.add(e.button);
      this.mouseDown.add(e.button);
      // Rebindable actions may sit on a mouse button: mirror it as the synthetic key code `MouseN`.
      const code = `Mouse${e.button}`;
      if (!this.down.has(code)) this.pressed.add(code);
      this.down.add(code);
    });
    window.addEventListener('mouseup', (e) => {
      if (isSoftCursorEvent(e)) return;
      if (this.cursor.active && this.isPointerLocked) { this.cursor.release(e.button); this.mouseDown.delete(e.button); return; }
      this.mouseDown.delete(e.button);
      this.mouseReleased.add(e.button);
      const code = `Mouse${e.button}`;
      this.down.delete(code);
      this.released.add(code);
    });
    window.addEventListener('mousemove', (e) => {
      if (isSoftCursorEvent(e)) return;
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      if (this.cursor.active) {
        if (this.isPointerLocked) this.cursor.moveBy(e.movementX || 0, e.movementY || 0);
        else this.cursor.mirror(e.clientX, e.clientY);   // no lock (Escape / headless): mirror, never synthesise
        return;
      }
      if (this.isPointerLocked) { this.mouseDX += e.movementX; this.mouseDY += e.movementY; }
    });
    window.addEventListener('wheel', (e) => {
      if (isSoftCursorEvent(e)) return;
      if (this.cursor.active && this.isPointerLocked) { this.cursor.wheel(e.deltaY, e.deltaX); return; }
      this.wheelDelta += Math.sign(e.deltaY);
    }, { passive: true });
    window.addEventListener('contextmenu', (e) => { if (this.isPointerLocked) e.preventDefault(); });
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
  /** performance.now() of the last pointer-lock request (Chrome throttles re-locks right after an Esc exit). */
  lastLockRequest = 0;
  requestPointerLock(): void {
    if (!this.lockTarget || this.isPointerLocked) return;
    this.lastLockRequest = performance.now();
    // Modern Chrome returns a Promise that rejects when the lock is denied (e.g. headless, no user gesture) —
    // swallow it so a denied re-lock never surfaces as an unhandled rejection.
    const swallow = (r: unknown): void => { if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => { /* denied */ }); };
    try { swallow((this.lockTarget as any).requestPointerLock?.({ unadjustedMovement: true }) ?? this.lockTarget.requestPointerLock()); }
    catch { try { swallow(this.lockTarget.requestPointerLock()); } catch { /* ignore */ } }
  }
  exitPointerLock(): void { if (this.isPointerLocked) document.exitPointerLock(); }

  /* ── appended: Phase 10 — 인게임 마우스 커서 ────────────────────────────────── */
  /** true while the virtual cursor owns UI input (the pointer lock is kept and raw deltas drive `cursorX/Y`). */
  get isCursorMode(): boolean { return this.cursor.active; }
  /** Virtual cursor position in client px (only meaningful while `isCursorMode`). */
  get cursorX(): number { return this.cursor.x; }
  get cursorY(): number { return this.cursor.y; }
  /**
   * Enter / leave software-cursor mode. `owner` is the caller's `ctx.uiBlockers` token; nesting is ref-counted, so a
   * popup layered over the inventory does not steal the cursor when it closes. A caller must **not** also call
   * `exitPointerLock()` — keeping the lock is the whole point.
   */
  setCursorMode(active: boolean, owner: string): void { this.cursor.setMode(active, owner); }
  /** Warp the virtual cursor (e.g. onto a panel's default button when it opens). */
  setCursorPosition(x: number, y: number): void { this.cursor.setPosition(x, y); }
  /** Cursor position a UI surface should read: virtual while in cursor mode, the real OS cursor otherwise. */
  get uiX(): number { return this.cursor.active ? this.cursor.x : this.mouseX; }
  get uiY(): number { return this.cursor.active ? this.cursor.y : this.mouseY; }
  /** Element under the UI cursor (`document.elementFromPoint(uiX, uiY)`); null when nothing is hit. */
  elementUnderCursor(): Element | null {
    if (typeof document.elementFromPoint !== 'function') return null;
    return this.cursor.active ? this.cursor.elementUnder() : document.elementFromPoint(this.mouseX, this.mouseY);
  }

  /** Called by Engine at the end of every frame. */
  endFrame(): void {
    this.pressed.clear(); this.released.clear();
    this.mousePressed.clear(); this.mouseReleased.clear();
    this.mouseDX = 0; this.mouseDY = 0; this.wheelDelta = 0;
  }
}
