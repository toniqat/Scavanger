import { SOFT_CURSOR_DBLCLICK_MS, SOFT_CURSOR_SENSITIVITY } from './constants';

/* ────────────────────────────────────────────────────────────────────────────
 * 인게임 마우스 커서 (Phase 10). Owner: shared/ — the second (and last) DOM file here after `itemChip.ts`.
 *
 * The problem: every cursor-using screen used to call `input.exitPointerLock()`, which hands the OS cursor back. On a
 * multi-monitor desktop the cursor then wanders off the game window, and coming back needs a click the game reads as a
 * gameplay click. The fix: **keep the pointer lock** and drive a virtual cursor from `movementX/movementY`, then
 * *synthesise* the DOM pointer/mouse events at the virtual position, dispatching them to
 * `document.elementFromPoint(x, y)`.
 *
 * Because those are real (bubbling) `PointerEvent` / `MouseEvent` objects, **no UI surface has to change**:
 * `#ui-root`'s `pointer-events: none` + `.interactive` opt-in still decides what is hit, delegated listeners still
 * fire, drag code listening on `window` still receives the bubbled move/up, and the three `document.elementFromPoint`
 * hit tests in inventory / meta keep working. A surface only has to (a) stop calling `exitPointerLock()` and its relock
 * microtask, and (b) read `input.uiX / uiY` instead of `input.mouseX / mouseY` if it polls the position itself.
 *
 * The Esc 일시정지 메뉴 is deliberately excluded and keeps the real OS cursor — it is the one screen that must work
 * when the lock is already gone (after an alt-tab, or a lock Chrome refused to re-grant).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Marker put on every event this class synthesises, so `Input`'s own window listeners ignore the echo. */
export const SOFT_CURSOR_FLAG = '__scavSoftCursor';

/** true when `e` was synthesised by the software cursor rather than by a real device. */
export function isSoftCursorEvent(e: Event): boolean {
  return (e as unknown as Record<string, unknown>)[SOFT_CURSOR_FLAG] === true;
}

type ModeListener = (active: boolean, owner: string | null) => void;
/** Fired on every position change so the sprite can follow **immediately** instead of once per game frame. */
type MoveListener = (x: number, y: number) => void;

interface SynthInit {
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
}

function mark<T extends Event>(e: T): T {
  Object.defineProperty(e, SOFT_CURSOR_FLAG, { value: true, enumerable: false });
  return e;
}

function build(type: string, init: SynthInit, extra?: Record<string, unknown>): Event {
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: init.clientX,
    clientY: init.clientY,
    screenX: init.clientX,
    screenY: init.clientY,
    button: init.button,
    buttons: init.buttons,
    ...extra,
  };
  if (type === 'wheel') return mark(new WheelEvent(type, base as WheelEventInit));
  const Pointer = (window as unknown as { PointerEvent?: typeof PointerEvent }).PointerEvent;
  if (Pointer && type.startsWith('pointer')) {
    return mark(new Pointer(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true } as PointerEventInit));
  }
  return mark(new MouseEvent(type, base as MouseEventInit));
}

/** `MouseEvent.button` (0 left / 1 middle / 2 right) → its bit in `MouseEvent.buttons` (1 / 4 / 2). */
function buttonMask(button: number): number {
  return 1 << (button === 1 ? 2 : button === 2 ? 1 : button);
}

const FOCUSABLE = 'input, textarea, select, button, [contenteditable="true"], [tabindex], a[href]';
const TEXTUAL = /^(input|textarea)$/i;

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/**
 * A synthesised event is untrusted, so the browser performs **no default action** for it: a text field never takes the
 * caret and a range slider never moves. Everything below re-implements the few defaults this game actually depends on.
 */
function emulateFocus(el: Element): void {
  const target = el.closest?.(FOCUSABLE) as HTMLElement | null;
  if (target && typeof target.focus === 'function') { target.focus(); return; }
  const active = document.activeElement as HTMLElement | null;
  if (active && TEXTUAL.test(active.tagName) && typeof active.blur === 'function') active.blur();
}

/** The `input[type=range]` under `el`, or null. */
function rangeAt(el: Element | null): HTMLInputElement | null {
  const input = el?.closest?.('input[type="range"]') as HTMLInputElement | null;
  return input ?? null;
}

/** Move a range slider's thumb to the client-x position and fire `input` (the browser's own drag default). */
function driveRange(input: HTMLInputElement, clientX: number): void {
  const r = input.getBoundingClientRect();
  if (r.width <= 0) return;
  const min = Number(input.min || '0');
  const max = Number(input.max || '100');
  const step = Number(input.step || '1') || 1;
  const raw = min + clamp01((clientX - r.left) / r.width) * (max - min);
  const snapped = Math.min(max, Math.max(min, min + Math.round((raw - min) / step) * step));
  const next = String(snapped);
  if (input.value === next) return;
  input.value = next;
  input.dispatchEvent(mark(new Event('input', { bubbles: true })));
}

/**
 * Virtual cursor position + synthetic event dispatch. One instance lives on `Input` (`ctx.input.cursor`); systems talk
 * to it through `Input.setCursorMode / uiX / uiY / elementUnderCursor`, and `ui/hud/SoftCursor` draws the sprite.
 */
export class SoftCursor {
  /** Client-space position of the virtual cursor. */
  x = 0;
  y = 0;
  /** Client px per px of raw locked movement. */
  sensitivity = SOFT_CURSOR_SENSITIVITY;

  private readonly owners = new Set<string>();
  private listener: ModeListener | null = null;
  private moveListener: MoveListener | null = null;
  private hovered: Element | null = null;
  private pressedOn: Element | null = null;
  private lastClickEl: Element | null = null;
  /** Range slider the left button is currently dragging (a synthesised event performs no slider default). */
  private rangeDrag: HTMLInputElement | null = null;
  private lastClickAt = 0;
  /** Mouse buttons currently held, as a `MouseEvent.buttons` mask. */
  private buttons = 0;

  get active(): boolean { return this.owners.size > 0; }
  /** Token of an arbitrary current owner (for the mode-change event); null while inactive. */
  get owner(): string | null { return this.owners.values().next().value ?? null; }

  onModeChange(listener: ModeListener | null): void { this.listener = listener; }

  /**
   * 2026-09-07: the sprite used to be written once per **game** frame (`HudSystem.update` → `ui/hud/SoftCursor`),
   * which put the whole 3D render pipeline between a mouse move and the drawn arrow — the OS cursor is composited
   * with none of that, which is most of why the in-game one felt sluggish. Hit-testing was never lagged (the
   * synthetic `pointermove` goes out from `moveBy` at once); only the picture was. This hands the position straight
   * to the sprite on the input event.
   */
  onMove(listener: MoveListener | null): void { this.moveListener = listener; }

  /**
   * Ref-counted enter / leave, keyed by the caller's `ctx.uiBlockers` token, so a panel layered over the inventory does
   * not steal the cursor from it when it closes. The first owner seeds the position at the viewport centre.
   */
  setMode(active: boolean, owner: string): void {
    const had = this.owners.size > 0;
    if (active) this.owners.add(owner); else this.owners.delete(owner);
    const has = this.owners.size > 0;
    if (has === had) return;
    if (has) {
      this.x = Math.round(window.innerWidth / 2);
      this.y = Math.round(window.innerHeight / 2);
    } else {
      this.syncHover(null);
      this.pressedOn = null;
      this.rangeDrag = null;
      this.buttons = 0;
    }
    this.listener?.(has, this.owner);
  }

  /** Drop every owner (phase change, death, a hard reset). */
  clear(): void {
    if (!this.owners.size) return;
    this.owners.clear();
    this.syncHover(null);
    this.pressedOn = null;
    this.rangeDrag = null;
    this.buttons = 0;
    this.listener?.(false, null);
  }

  setPosition(x: number, y: number): void {
    this.x = this.clampX(x);
    this.y = this.clampY(y);
    this.moveListener?.(this.x, this.y);
    if (this.active) this.dispatch('pointermove', -1);
  }

  /**
   * Track the real OS cursor without synthesising anything. Used when cursor mode is on but the pointer lock is NOT
   * held — Chrome always drops the lock on Escape, and the headless smokes stub `requestPointerLock` away entirely.
   * The native DOM events already reach the UI in that state, so a second synthetic set would double every click;
   * mirroring keeps `uiX / uiY` and the drawn sprite correct and nothing else.
   */
  mirror(x: number, y: number): void {
    this.x = this.clampX(x);
    this.y = this.clampY(y);
    this.moveListener?.(this.x, this.y);
  }

  /**
   * Integrate one raw locked movement event. `Input` calls this from its `mousemove` handler.
   *
   * **Strictly linear** (`SOFT_CURSOR_SENSITIVITY`, 1 client px per raw px). 2026-09-07 briefly added a curve of its
   * own on the theory that the lock's `unadjustedMovement: true` had stripped the OS acceleration and the cursor
   * needed it back; in practice it made the arrow overshoot — a 14 px move travelled 27 px — so the pointer never
   * ended up where the hand aimed it. Windows' own default (pointer speed 6/11, no "enhance pointer precision") is
   * 1:1 too, so linear is both the predictable answer and the closest match to the desktop cursor.
   */
  moveBy(dx: number, dy: number): void {
    if (!this.active || (dx === 0 && dy === 0)) return;
    const gain = this.sensitivity;
    this.x = this.clampX(this.x + dx * gain);
    this.y = this.clampY(this.y + dy * gain);
    this.moveListener?.(this.x, this.y);
    if (this.rangeDrag) driveRange(this.rangeDrag, this.x);
    this.dispatch('pointermove', -1);
  }

  elementUnder(): Element | null {
    if (typeof document.elementFromPoint !== 'function') return null;
    return document.elementFromPoint(this.x, this.y);
  }

  /* ── real device events, forwarded by `Input` while `active` ─────────────── */

  press(button: number): void {
    if (!this.active) return;
    this.buttons |= buttonMask(button);
    const el = this.dispatch('pointerdown', button);
    this.dispatch('mousedown', button, el);
    this.pressedOn = el;
    if (el && button === 0) {
      emulateFocus(el);
      this.rangeDrag = rangeAt(el);
      if (this.rangeDrag) driveRange(this.rangeDrag, this.x);
    }
  }

  release(button: number): void {
    if (!this.active) return;
    this.buttons &= ~buttonMask(button);
    if (this.rangeDrag && button === 0) {
      driveRange(this.rangeDrag, this.x);
      this.rangeDrag.dispatchEvent(mark(new Event('change', { bubbles: true })));
      this.rangeDrag = null;
    }
    const el = this.dispatch('pointerup', button);
    this.dispatch('mouseup', button, el);
    if (el && el === this.pressedOn) {
      if (button === 2) {
        this.dispatch('contextmenu', button, el);
      } else {
        this.dispatch('click', button, el);
        const now = performance.now();
        if (el === this.lastClickEl && now - this.lastClickAt < SOFT_CURSOR_DBLCLICK_MS) {
          this.dispatch('dblclick', button, el);
          this.lastClickEl = null;
        } else {
          this.lastClickEl = el;
          this.lastClickAt = now;
        }
      }
    }
    this.pressedOn = null;
  }

  wheel(deltaY: number, deltaX = 0): void {
    if (!this.active) return;
    this.dispatch('wheel', -1, undefined, { deltaY, deltaX, deltaMode: 0 });
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  private clampX(v: number): number { return Math.max(0, Math.min(window.innerWidth - 1, v)); }
  private clampY(v: number): number { return Math.max(0, Math.min(window.innerHeight - 1, v)); }

  private dispatch(type: string, button: number, forced?: Element | null, extra?: Record<string, unknown>): Element | null {
    const el = forced !== undefined ? forced : this.elementUnder();
    if (type === 'pointermove') this.syncHover(el);
    if (!el) return null;
    const init: SynthInit = { clientX: this.x, clientY: this.y, button: Math.max(0, button), buttons: this.buttons };
    el.dispatchEvent(build(type, init, extra));
    if (type === 'pointermove') el.dispatchEvent(build('mousemove', init, extra));
    return el;
  }

  /** Emit the out/leave + over/enter pairs whenever the element under the cursor changes. */
  private syncHover(el: Element | null): void {
    if (el === this.hovered) return;
    const init: SynthInit = { clientX: this.x, clientY: this.y, button: 0, buttons: this.buttons };
    const prev = this.hovered;
    this.hovered = el;
    if (prev) {
      prev.dispatchEvent(build('pointerout', init, { relatedTarget: el }));
      prev.dispatchEvent(build('mouseout', init, { relatedTarget: el }));
      prev.dispatchEvent(build('pointerleave', init, { bubbles: false, relatedTarget: el }));
      prev.dispatchEvent(build('mouseleave', init, { bubbles: false, relatedTarget: el }));
    }
    if (el) {
      el.dispatchEvent(build('pointerover', init, { relatedTarget: prev }));
      el.dispatchEvent(build('mouseover', init, { relatedTarget: prev }));
      el.dispatchEvent(build('pointerenter', init, { bubbles: false, relatedTarget: prev }));
      el.dispatchEvent(build('mouseenter', init, { bubbles: false, relatedTarget: prev }));
    }
  }
}
