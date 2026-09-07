/* ────────────────────────────────────────────────────────────────────────────
 * 마우스 커서 모드 (2026-09-07 rework). Owner: shared/ — with `itemChip.ts` the only DOM-adjacent file here.
 *
 * **The model: 락 = 시점 조작 / 언락 = 진짜 커서.**
 *
 * Phase 10 tried the opposite — every cursor screen *kept* the pointer lock and a virtual cursor synthesised the DOM
 * pointer/mouse events at its own position — to stop the OS cursor wandering onto a second monitor. The cost turned
 * out to be far higher than the benefit: a synthesised event is untrusted, so the browser performs no default action
 * for it (text carets, native drags, sliders all had to be re-implemented), the arrow was a picture the game had to
 * draw and could never match the compositor's own latency, and Chrome drops the lock on **every** Escape — which left
 * a half-broken hybrid state that `game/` papered over by forcing the 일시정지 메뉴 up whenever the lock went missing.
 * That watchdog is what made the game pause every time the Windows cursor appeared.
 *
 * So this class no longer moves anything or dispatches anything. It is a **ref-counted mode flag**:
 *
 *   - a UI surface calls `input.setCursorMode(true, 'inventory')` → `Input` releases the pointer lock, the real OS
 *     cursor comes back (drawn as the game's own arrow by `ui/hud/GameCursor`, a CSS `cursor:` image), and every
 *     click / drag / caret is a genuine browser event again;
 *   - the last owner leaving → `main.ts` re-requests the lock and the camera has the mouse back.
 *
 * The public API (`setCursorMode(active, token)`, ref-counted by the caller's `ctx.uiBlockers` token) is unchanged
 * from Phase 10, so the ~14 screens that call it did not have to move.
 * ──────────────────────────────────────────────────────────────────────────── */

type ModeListener = (active: boolean, owner: string | null) => void;

/**
 * Which UI surfaces currently want the real mouse cursor. `Input` owns the single instance (`ctx.input.cursor`);
 * systems talk to it through `Input.setCursorMode` / `isCursorMode` and never touch it directly.
 */
export class CursorMode {
  private readonly owners = new Set<string>();
  private listener: ModeListener | null = null;

  get active(): boolean { return this.owners.size > 0; }
  /** Token of an arbitrary current owner (for the mode-change event); null while inactive. */
  get owner(): string | null { return this.owners.values().next().value ?? null; }
  /** Is `token` one of the current owners? */
  has(token: string): boolean { return this.owners.has(token); }

  onModeChange(listener: ModeListener | null): void { this.listener = listener; }

  /**
   * Ref-counted enter / leave, keyed by the caller's blocker token, so a popup layered over the inventory does not
   * drop the cursor when it closes. Returns true when the **aggregate** state flipped — `Input` then does the pointer
   * lock work and calls `emitChange()`, so listeners never see a half-applied transition.
   */
  setMode(active: boolean, owner: string): boolean {
    const had = this.owners.size > 0;
    if (active) this.owners.add(owner); else this.owners.delete(owner);
    return (this.owners.size > 0) !== had;
  }

  /** Drop every owner (phase change, death, a hard reset). Returns true when that flipped the aggregate. */
  clear(): boolean {
    if (!this.owners.size) return false;
    this.owners.clear();
    return true;
  }

  /** Fire the mode listener. Called by `Input` once the pointer-lock side of the transition is settled. */
  emitChange(): void { this.listener?.(this.active, this.owner); }
}


/* ══ appended: 2026-09-08 — 데스크톱 셸 판별 ═══════════════════════════════════════════════════════════════════════
 * The Electron shell (`electron/`) loads the same bundle from `http://127.0.0.1:<port>/`, so nothing in the page knows
 * it is a desktop app except the user agent. Two behaviours differ there: no '좌측 클릭으로 게임 재개' gate (the shell
 * hides the cursor itself whenever no screen owns it — Alt 커서 excepted), and `start-game.bat` is gone in favour of
 * the exe. Read it at use time; a test may override it with `window.__scavDesktop`.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __scavDesktop?: boolean };
  if (typeof w.__scavDesktop === 'boolean') return w.__scavDesktop;
  return typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent);
}
