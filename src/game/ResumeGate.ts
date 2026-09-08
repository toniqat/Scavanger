import type { GameContext } from '@/shared';
import { Keys, RESUME_GATE_BLOCKER, isDesktopShell, keyLabel } from '@/shared';
import './resume-gate.css';

/**
 * 브라우저 재개 게이트 — `좌측 클릭으로 게임 재개` (Phase 12, browser only).
 *
 * Every cursor screen releases the pointer lock and `main.ts` re-requests it when the last owner leaves. Outside
 * fullscreen that request is **refused whenever the screen was closed with Escape**: Chrome grants Escape no user
 * activation, so the player is left with a running game, a visible OS cursor and no hint of what to do. `Input` keeps
 * the intent (`awaitingLockGesture`) and retries from the next click or key; this overlay makes that state visible —
 * the world stays blurred (the window that just closed took its own blur with it), gameplay input stays off through
 * `RESUME_GATE_BLOCKER`, the world keeps running exactly like the 일시정지 메뉴, and the one thing on screen is the
 * click that is the gesture Chrome wants.
 *
 * Polled from `GameFlowSystem.update` (the refusal is asynchronous — a rejected promise or a 250 ms silence — so an
 * event at the moment cursor mode ends is too early to know). Shown when: browser (never the Electron shell), a
 * gameplay or hub phase, alive, no cursor owner, lock missing and `awaitingLockGesture`. Hidden the moment the lock
 * is back (from our click or any other gesture — WASD, a canvas click), when a screen takes the cursor (Escape on the
 * gate opens the 일시정지 메뉴 normally: `GameFlowSystem` treats the gate's token as transparent), or when the phase
 * stops qualifying. Once shown it survives the retry window running out — the click still works after it.
 *
 * A screen closed with its **own** key (Tab) re-locks at once (a real key press carries activation), so the gate
 * never appears on that path.
 */
export class ResumeGate {
  private readonly root: HTMLElement;
  private readonly hintKey: HTMLElement;
  private _shown = false;

  constructor(private readonly ctx: GameContext) {
    const root = this.root = document.createElement('div');
    root.className = 'resume-gate interactive hidden';
    const title = document.createElement('div');
    title.className = 'rg-title';
    title.textContent = '좌측 클릭으로 게임 재개';
    const sub = document.createElement('div');
    sub.className = 'rg-sub';
    this.hintKey = document.createElement('span');
    this.hintKey.className = 'keycap';
    const subText = document.createElement('span');
    subText.textContent = '일시 정지 메뉴';
    sub.append(this.hintKey, subText);
    root.append(title, sub);
    ctx.uiRoot.appendChild(root);
    this.refreshLabel();
    root.addEventListener('mousedown', this.onClick);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get shown(): boolean { return this._shown; }

  /**
   * The gate only ever makes sense for a session that **had** the lock and lost it (the Escape case). A session that
   * never got one — a browser that refuses pointer lock outright, a headless harness that stubs the request without
   * ever locking — would otherwise sit behind an overlay whose only exit is a request that browser keeps refusing.
   * Same rule the old lost-lock watchdog used before the 2026-09-07 커서 rework removed it.
   */
  private everLocked = false;

  /** Once per frame from GameFlow. */
  update(): void {
    const ctx = this.ctx;
    const input = ctx.input;
    if (input.isPointerLocked) this.everLocked = true;
    if (this._shown) {
      if (input.isPointerLocked || input.isCursorMode || !this.phaseOk()) this.hide();
      return;
    }
    if (!this.everLocked) return;
    if (isDesktopShell()) return;
    if (!this.phaseOk() || input.isCursorMode || input.isPointerLocked) return;
    if (!input.awaitingLockGesture) return;
    this.show();
  }

  /** Gameplay or walking the ship, alive, no cutscene / warp. */
  private phaseOk(): boolean {
    const ctx = this.ctx;
    if (!(ctx.isGameplayPhase() || ctx.isHubPhase())) return false;
    if (ctx.player?.isDead ?? false) return false;
    if (ctx.hub?.travelling ?? false) return false;
    return true;
  }

  private show(): void {
    if (this._shown) return;
    this._shown = true;
    this.refreshLabel();
    this.root.classList.remove('hidden');
    this.ctx.uiBlockers.add(RESUME_GATE_BLOCKER);
    this.ctx.bus.emit('ui:resumeGate', { shown: true });
  }

  private hide(): void {
    if (!this._shown) return;
    this._shown = false;
    this.root.classList.add('hidden');
    this.ctx.uiBlockers.delete(RESUME_GATE_BLOCKER);
    this.ctx.bus.emit('ui:resumeGate', { shown: false });
  }

  private refreshLabel(): void { this.hintKey.textContent = keyLabel(Keys.MENU); }

  /** The click **is** the user gesture: ask for the lock right here. `update()` hides the gate once it arrives. */
  private readonly onClick = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.ctx.input.requestPointerLock();
  };

  dispose(): void {
    this.hide();
    this.root.remove();
  }
}

/* ── 데스크톱 셸 커서 (Phase 12) ──────────────────────────────────────────────────────────────────────────────────
 * The Electron shell never shows the gate: the lock is retaken by the shell's own Escape handling, and while no screen
 * owns the cursor the OS cursor is simply hidden (`body.desktop-nocursor`), whether or not the lock is held right now.
 * A screen taking cursor mode (the Alt 커서 included — it is a cursor owner) shows it again; result / title screens are
 * not gameplay phases, so the cursor is visible there.
 */
const DESKTOP_NOCURSOR_CLASS = 'desktop-nocursor';

/**
 * `window.__scavShellRelock` — called by the Electron main process on every Escape **key-up**, from a script that runs
 * *with a user gesture* (`webContents.executeJavaScript(code, true)`), which is the activation a `requestPointerLock()`
 * needs and the one thing a page cannot give itself after an Escape. The hook waits two frames so the screen the
 * Escape closed has released cursor mode (GameFlow / the screens poll keys per frame), then re-locks only when nothing
 * owns the cursor and the phase wants the lock. Chromium's transient activation lasts far longer than two frames.
 * Installed unconditionally (the browser simply never calls it) so the shell never depends on load order.
 */
export function installDesktopRelockHook(ctx: GameContext): () => void {
  const w = window as unknown as { __scavShellRelock?: () => void };
  const hook = (): void => {
    const attempt = (): void => {
      const input = ctx.input;
      if (input.isCursorMode || input.isPointerLocked) return;
      if (!(ctx.isGameplayPhase() || ctx.isHubPhase()) || (ctx.player?.isDead ?? false)) return;
      input.requestPointerLock();
    };
    requestAnimationFrame(() => requestAnimationFrame(attempt));
  };
  w.__scavShellRelock = hook;
  return () => { if (w.__scavShellRelock === hook) delete w.__scavShellRelock; };
}

/** Once per frame from GameFlow. Cheap: `classList.toggle` with an unchanged value is a no-op. */
export function syncDesktopCursor(ctx: GameContext): void {
  const hide = isDesktopShell()
    && (ctx.isGameplayPhase() || ctx.isHubPhase())
    && !ctx.input.isCursorMode
    && !(ctx.player?.isDead ?? false);
  document.body.classList.toggle(DESKTOP_NOCURSOR_CLASS, hide);
}
