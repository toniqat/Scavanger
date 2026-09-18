/* ────────────────────────────────────────────────────────────────────────────
 * The Escape close stack (2026-09-09). Owner: shared/ — a contract, so it is add-only.
 *
 * **When people see a cursor they try to close that window with ESC.** On 2026-09-08 the opposite was chosen — `Escape`
 * was one key that opened the pause menu, and a screen closed only by the key that had opened it (Tab · M · P · E). The
 * reason was the browser: Escape carries no user activation, so closing a screen with it makes `main.ts`'s relock be
 * refused and the cursor stays.
 *
 * Only half of that reason is left now. In the desktop shell the main process makes an activation on every ESC
 * **key-up** and calls `window.__scavShellRelock` (`electron/main.ts`), so the camera comes back at once, and in the
 * browser the `좌측 클릭으로 게임 재개` gate that already exists (`game/ResumeGate`) takes that one click — it is the UI
 * built for exactly this situation. So **closing a screen with ESC is allowed on both**, and only closing the pause menu
 * itself with ESC stays shell-only (`isDesktopShell()`, `ui/menus/PauseMenu`).
 *
 * Why the system registration order will not do: the shared Tab close has every screen read the key in its own
 * `update()` and `input.consume` it, which makes the closing order the **system registration order** (`main.ts`). With
 * the ship management panel over the map, the system registered first closes and not the panel on top. ESC being "only
 * the topmost one" is the user's decision, so it needs the order they were opened in, and here is the only place that
 * knows it — a screen does `push` on open and `remove` on close, and
 * `game/GameFlowSystem` calls `closeTop()` first when it gets ESC (on false, the pause menu then).
 *
 * It is paired with the cursor/blocker: `push` goes next to `ctx.uiBlockers.add`, `remove` next to `delete`. That way a
 * screen with several teardown paths (`close()` · `hide()` · `dispose()` · a phase change) cleans itself up as well.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One screen's Escape action. **Returning `false` leaves it on the stack** — for a single step taken back inside the
 * screen (like housing mode putting down only the furniture it held while the mode stays on). Any other return value
 * (usually `void`) means "this screen closed", so the entry is removed. To stay, **return `false`** — do not `push` again.
 */
type EscapeClose = () => boolean | void;

interface EscapeEntry {
  /** Stable id — the surface's `ctx.uiBlockers` token, or `token:sub` when several surfaces share one token. */
  key: string;
  close: EscapeClose;
}

/**
 * The stack holding the open screens' Escape actions in the order they were opened. There is exactly one, on
 * `GameContext.escape` (a contract of the same rank as `uiBlockers`, so it is used directly with no ref interface).
 */
export class EscapeStack {
  private readonly entries: EscapeEntry[] = [];

  /**
   * Register (or re-register) `close` as this screen's Escape action. Pushing the same `key` again **moves it to the
   * top** — a reopened screen is always the newest screen.
   */
  push(key: string, close: EscapeClose): void {
    this.remove(key);
    this.entries.push({ key, close });
  }

  /** Idempotent — it can simply be called from every teardown path a screen has. */
  remove(key: string): void {
    const i = this.entries.findIndex((e) => e.key === key);
    if (i >= 0) this.entries.splice(i, 1);
  }

  /**
   * Closes the one most recently opened screen (LIFO). False when nothing is registered — the caller (`game/`) then
   * opens the pause menu.
   *
   * When the close function returns `false` the entry is left (a single step taken back inside the screen). Otherwise
   * the entry is removed, and if the screen's `close()` already called `remove` that is no problem — `remove` is idempotent.
   */
  closeTop(): boolean {
    const top = this.entries.at(-1);
    if (!top) return false;
    if (top.close() !== false) this.remove(top.key);
    return true;
  }

  /** The key of the topmost screen (for diagnostics · the key guide); null when empty. */
  get topKey(): string | null { return this.entries.at(-1)?.key ?? null; }
  get size(): number { return this.entries.length; }
  has(key: string): boolean { return this.entries.some((e) => e.key === key); }
  /** Throws everything away (a hard reset — a phase change · death). The close functions are **not called**. */
  clear(): void { this.entries.length = 0; }
}
