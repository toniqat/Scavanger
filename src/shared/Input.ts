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
      // middle button = ping; stop browser auto-scroll while locked
      if (e.button === 1 && this.isPointerLocked) e.preventDefault();
      if (!this.mouseDown.has(e.button)) this.mousePressed.add(e.button);
      this.mouseDown.add(e.button);
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseDown.delete(e.button);
      this.mouseReleased.add(e.button);
    });
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      if (this.isPointerLocked) { this.mouseDX += e.movementX; this.mouseDY += e.movementY; }
    });
    window.addEventListener('wheel', (e) => { this.wheelDelta += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('contextmenu', (e) => { if (this.isPointerLocked) e.preventDefault(); });
  }

  isDown(code: string): boolean { return this.down.has(code); }
  wasPressed(code: string): boolean { return this.pressed.has(code); }
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
    try { (this.lockTarget as any).requestPointerLock?.({ unadjustedMovement: true }) ?? this.lockTarget.requestPointerLock(); }
    catch { try { this.lockTarget.requestPointerLock(); } catch { /* ignore */ } }
  }
  exitPointerLock(): void { if (this.isPointerLocked) document.exitPointerLock(); }

  /** Called by Engine at the end of every frame. */
  endFrame(): void {
    this.pressed.clear(); this.released.clear();
    this.mousePressed.clear(); this.mouseReleased.clear();
    this.mouseDX = 0; this.mouseDY = 0; this.wheelDelta = 0;
  }
}
