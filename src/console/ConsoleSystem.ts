import * as THREE from 'three';
import type { ConsoleCommand, ConsoleLineKind, ConsoleRef, GameContext, GameSystem } from '@/shared';
import { CONSOLE_HISTORY_KEY, CONSOLE_HISTORY_MAX, CONSOLE_MAX_LINES, CONSOLE_SUGGESTIONS_MAX, Keys, MOVE_CHEAT_SPEED, isDevHost } from '@/shared';
import { builtinCommands } from './commands';
import './console.css';

const BLOCKER = 'console';

interface Suggestion {
  /** Text shown in the list. */
  label: string;
  /** What the input becomes when the suggestion is applied. */
  apply: string;
}

/**
 * Developer console (Unreal-style). Publishes `ctx.console`.
 *
 * Exists only on a **dev client** (`isDevHost()`): otherwise no DOM is built, no key listener is installed and every
 * method is inert. ` (`Keys.CONSOLE`) toggles a one-line input at the bottom of the screen with the recent output above
 * it; while typing, commands starting with the text are listed above the input (↑/↓ cursor, Tab/Enter apply); with an
 * empty input ↑/↓ walk the localStorage history. Open = blocker `'console'` added, then the **in-game cursor**
 * (`input.setCursorMode(true, 'console')` — Phase 10: the pointer lock is *kept*, so there is no `exitPointerLock()`
 * and no microtask re-lock any more); close = token removed and the cursor released. Esc closes only the console
 * (capture-phase listener, swallowed before the pause logic sees it).
 *
 * Built-in commands live in `commands/`; any folder may add its own through `register()`.
 * `/movecheat 1` + Home: `update()` teleports the player along the camera forward at MOVE_CHEAT_SPEED.
 */
export class ConsoleSystem implements GameSystem, ConsoleRef {
  readonly name = 'console';
  readonly enabled = isDevHost();
  private _open = false;
  private _moveCheat = false;
  private commands = new Map<string, ConsoleCommand>();
  private ctx!: GameContext;

  // DOM (dev clients only)
  private root: HTMLElement | null = null;
  private log: HTMLElement | null = null;
  private suggestBox: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private lines: HTMLElement[] = [];

  // suggestions / history
  private suggestions: Suggestion[] = [];
  private suggestIndex = -1;
  private history: string[] = [];
  private historyIndex = 0;      // == history.length when not browsing
  private historyDraft = '';
  private browsingHistory = false;

  private readonly fwd = new THREE.Vector3();
  private readonly next = new THREE.Vector3();

  get isOpen(): boolean { return this._open; }
  get moveCheat(): boolean { return this._moveCheat; }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.console = this;
    if (!this.enabled) return;
    const sys = this;
    for (const c of builtinCommands({
      clearLog: () => sys.clearLog(),
      setMoveCheat: (on) => sys.setMoveCheat(on),
      get moveCheat() { return sys._moveCheat; },
    })) this.register(c);
    this.history = this.loadHistory();
    this.historyIndex = this.history.length;
    this.buildDom(ctx.uiRoot);
    window.addEventListener('keydown', this.keyHandler, true);
    this.print('개발자 콘솔 — help 로 커맨드 목록', 'info');
  }

  update(dt: number, ctx: GameContext): void {
    if (!this.enabled || !this._moveCheat || this._open) return;
    if (!ctx.isControlActive() || !ctx.input.isDown(Keys.MOVE_CHEAT)) return;
    const player = ctx.player;
    if (!player || player.isDead || typeof player.teleport !== 'function') return;
    ctx.camera.getWorldDirection(this.fwd);
    if (this.fwd.lengthSq() < 1e-6) return;
    this.next.copy(player.position).addScaledVector(this.fwd, MOVE_CHEAT_SPEED * dt);
    const world = ctx.world;
    if (world && ctx.isGameplayPhase()) {
      if (!world.isInsideBounds(this.next.x, this.next.z)) return;
      const ground = world.getHeightAt(this.next.x, this.next.z);
      if (this.next.y < ground) this.next.y = ground;
    }
    player.teleport(this.next, undefined, false);
  }

  dispose(): void {
    if (!this.enabled) return;
    window.removeEventListener('keydown', this.keyHandler, true);
    if (this._open) {
      this._open = false;
      this.ctx?.uiBlockers.delete(BLOCKER);
      this.ctx?.input.setCursorMode(false, BLOCKER);
    }
    this.root?.remove();
    this.root = this.log = this.suggestBox = null;
    this.input = null;
  }

  /* ── ConsoleRef ────────────────────────────────────────────────────────── */

  register(cmd: ConsoleCommand): () => void {
    const key = cmd.name.toLowerCase();
    this.commands.set(key, cmd);
    return () => { if (this.commands.get(key) === cmd) this.commands.delete(key); };
  }

  getCommands(): readonly ConsoleCommand[] { return Array.from(this.commands.values()); }

  run(line: string): void {
    if (!this.enabled) return;
    const raw = line.trim();
    if (!raw) return;
    this.pushHistory(raw);
    this.print(`> ${raw}`, 'input');
    const tokens = raw.replace(/^\//, '').trim().split(/\s+/).filter(Boolean);
    const name = (tokens.shift() ?? '').toLowerCase();
    const cmd = this.commands.get(name);
    const outputs: string[] = [];
    const print = (text: string, kind?: ConsoleLineKind): void => { outputs.push(text); this.print(text, kind); };
    const finish = (ok: boolean): void => {
      this.ctx.bus.emit('console:executed', { line: raw, ok, output: outputs.join('\n') });
    };
    if (!name || !cmd) {
      print(`알 수 없는 커맨드: ${name || '(빈 입력)'} — help 로 목록 확인`, 'error');
      finish(false);
      return;
    }
    const handle = (res: void | string | { error: string }): boolean => {
      if (typeof res === 'string') { print(res, 'success'); return true; }
      if (res && typeof res === 'object' && 'error' in res) { print(res.error, 'error'); return false; }
      return true;
    };
    try {
      const res = cmd.run(tokens, this.ctx, print);
      if (res instanceof Promise) {
        res.then((r) => finish(handle(r)), (e) => { print(`오류: ${String(e)}`, 'error'); finish(false); });
        return;
      }
      finish(handle(res));
    } catch (e) {
      print(`오류: ${e instanceof Error ? e.message : String(e)}`, 'error');
      finish(false);
    }
  }

  print(text: string, kind: ConsoleLineKind = 'info'): void {
    const log = this.log;
    if (!this.enabled || !log) return;
    const div = document.createElement('div');
    div.className = `dc-line ${kind}`;
    div.textContent = text;   // textContent → no markup injection
    log.appendChild(div);
    this.lines.push(div);
    while (this.lines.length > CONSOLE_MAX_LINES) this.lines.shift()!.remove();
    log.scrollTop = log.scrollHeight;
  }

  open(): void {
    if (!this.enabled || this._open || !this.root || !this.input) return;
    const ctx = this.ctx;
    this._open = true;
    ctx.uiBlockers.add(BLOCKER);        // blocker first → GameFlow does not treat the cursor as a pause
    ctx.input.setCursorMode(true, BLOCKER);   // Phase 10: the pointer lock is kept, a virtual cursor drives the DOM
    this.root.hidden = false;
    this.input.value = '';
    this.resetHistoryBrowse();
    this.updateSuggestions();
    this.input.focus();
    if (this.log) this.log.scrollTop = this.log.scrollHeight;
    ctx.bus.emit('console:toggled', { open: true });
  }

  close(): void {
    if (!this.enabled || !this._open || !this.root || !this.input) return;
    const ctx = this.ctx;
    this._open = false;
    this.root.hidden = true;
    this.input.blur();
    this.clearSuggestions();
    ctx.uiBlockers.delete(BLOCKER);
    ctx.input.setCursorMode(false, BLOCKER);
    ctx.bus.emit('console:toggled', { open: false });
  }

  /* ── built-in host hooks ───────────────────────────────────────────────── */

  clearLog(): void {
    for (const l of this.lines) l.remove();
    this.lines.length = 0;
  }

  setMoveCheat(enabled: boolean): void {
    if (this._moveCheat === enabled) return;
    this._moveCheat = enabled;
    this.ctx.bus.emit('cheat:moveCheat', { enabled });
  }

  /* ── DOM ───────────────────────────────────────────────────────────────── */

  private buildDom(parent: HTMLElement): void {
    const root = this.root = document.createElement('div');
    root.className = 'dev-console interactive';
    root.hidden = true;
    const log = this.log = document.createElement('div');
    log.className = 'dc-log';
    root.appendChild(log);
    const sug = this.suggestBox = document.createElement('div');
    sug.className = 'dc-suggest';
    sug.hidden = true;
    root.appendChild(sug);
    const row = document.createElement('div');
    row.className = 'dc-input-row';
    const prompt = document.createElement('span');
    prompt.className = 'dc-prompt';
    prompt.textContent = '>';
    row.appendChild(prompt);
    const input = this.input = document.createElement('input');
    input.className = 'dc-input';
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = '커맨드 입력… (help 목록 · Tab 완성 · ↑↓ 제안/히스토리 · Esc 닫기)';
    row.appendChild(input);
    const hint = document.createElement('span');
    hint.className = 'dc-hint';
    hint.textContent = 'DEV';
    row.appendChild(hint);
    root.appendChild(row);
    parent.appendChild(root);

    // Keep typed characters from reaching Input (it listens on window in the bubble phase).
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('input', () => { this.resetHistoryBrowse(); this.updateSuggestions(); });
    input.addEventListener('blur', () => { if (this._open) queueMicrotask(() => { if (this._open) input.focus(); }); });
    root.addEventListener('wheel', (e) => { if (this._open) e.stopPropagation(); }, { passive: true });
    sug.addEventListener('mousedown', (e) => {
      const t = (e.target as HTMLElement).closest('.dc-sug') as HTMLElement | null;
      if (!t) return;
      e.preventDefault();
      const i = Number(t.dataset.index);
      if (!Number.isNaN(i)) { this.suggestIndex = i; this.applySuggestion(); }
    });
  }

  /** Capture-phase window listener: toggles on `Keys.CONSOLE`, owns Esc / ↑ / ↓ / Tab / Enter while open. */
  private keyHandler = (e: KeyboardEvent): void => {
    const input = this.input;
    if (!input) return;
    if (e.code === Keys.CONSOLE) {
      if (e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      // Another text field (chat, terminal name) owns the keyboard → let the character through.
      if (!this._open && this.isForeignTextField(document.activeElement)) return;
      e.preventDefault();               // never type the ` character into the console
      e.stopImmediatePropagation();
      if (this._open) this.close(); else this.open();
      return;
    }
    if (!this._open) return;
    switch (e.code) {
      case 'Escape':
        e.preventDefault(); e.stopImmediatePropagation();
        this.close();
        return;
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault(); e.stopImmediatePropagation();
        const dir = e.code === 'ArrowUp' ? -1 : 1;
        if (input.value === '' || this.browsingHistory || this.suggestions.length === 0) this.browseHistory(dir);
        else this.moveCursor(dir);
        return;
      }
      case 'Tab':
        e.preventDefault(); e.stopImmediatePropagation();
        if (this.suggestions.length > 0) { if (this.suggestIndex < 0) this.suggestIndex = 0; this.applySuggestion(); }
        return;
      case 'Enter':
      case 'NumpadEnter':
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.repeat) return;
        if (this.suggestIndex >= 0 && this.suggestions.length > 0) { this.applySuggestion(); return; }
        this.submit();
        return;
      default:
        // Typing reaches the input element (which stops the bubble itself); keys dispatched elsewhere must not move the player.
        if (e.target !== input) e.stopImmediatePropagation();
        return;
    }
  };

  private isForeignTextField(el: Element | null): boolean {
    if (!el || el === this.input) return false;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable === true;
  }

  private submit(): void {
    const input = this.input;
    if (!input) return;
    const line = input.value.trim();
    input.value = '';
    this.resetHistoryBrowse();
    this.clearSuggestions();
    if (line) this.run(line);
  }

  /* ── suggestions ───────────────────────────────────────────────────────── */

  private updateSuggestions(): void {
    const input = this.input;
    if (!input) return;
    const text = input.value;
    const slash = text.startsWith('/') ? '/' : '';
    const body = text.replace(/^\//, '');
    const list: Suggestion[] = [];
    if (body.trim() !== '' || slash) {
      const space = body.search(/\s/);
      if (space < 0) {
        const prefix = body.toLowerCase();
        const names = Array.from(this.commands.keys()).filter((n) => n.startsWith(prefix)).sort();
        for (const n of names) {
          const c = this.commands.get(n)!;
          list.push({ label: `/${c.usage}  — ${c.description}`, apply: `${slash}${c.name} ` });
        }
      } else {
        const name = body.slice(0, space).toLowerCase();
        const cmd = this.commands.get(name);
        if (cmd?.complete) {
          const rest = body.slice(space + 1);
          const args = rest.split(/\s+/);               // keeps the trailing '' when the user just typed a space
          const current = args[args.length - 1] ?? '';
          let options: string[] = [];
          try { options = cmd.complete(args, this.ctx) ?? []; } catch { options = []; }
          const head = `${slash}${cmd.name} ${args.slice(0, -1).join(' ')}${args.length > 1 ? ' ' : ''}`;
          for (const o of options) {
            if (!o.toLowerCase().startsWith(current.toLowerCase())) continue;
            list.push({ label: `${o}`, apply: `${head}${o} ` });
          }
        }
      }
    }
    this.suggestions = list.slice(0, CONSOLE_SUGGESTIONS_MAX);
    this.suggestIndex = -1;
    this.renderSuggestions();
  }

  private renderSuggestions(): void {
    const box = this.suggestBox;
    if (!box) return;
    box.textContent = '';
    if (this.suggestions.length === 0) { box.hidden = true; return; }
    box.hidden = false;
    this.suggestions.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = `dc-sug${i === this.suggestIndex ? ' sel' : ''}`;
      d.dataset.index = String(i);
      d.textContent = s.label;
      box.appendChild(d);
    });
  }

  private moveCursor(dir: number): void {
    const n = this.suggestions.length;
    if (n === 0) return;
    this.suggestIndex = this.suggestIndex < 0
      ? (dir > 0 ? 0 : n - 1)
      : (this.suggestIndex + dir + n) % n;
    this.renderSuggestions();
  }

  private applySuggestion(): void {
    const input = this.input;
    const s = this.suggestions[this.suggestIndex];
    if (!input || !s) return;
    input.value = s.apply;
    input.setSelectionRange(input.value.length, input.value.length);
    this.resetHistoryBrowse();
    this.updateSuggestions();
  }

  private clearSuggestions(): void {
    this.suggestions = [];
    this.suggestIndex = -1;
    this.renderSuggestions();
  }

  /* ── history ───────────────────────────────────────────────────────────── */

  private loadHistory(): string[] {
    try {
      const raw = localStorage.getItem(CONSOLE_HISTORY_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string').slice(-CONSOLE_HISTORY_MAX) : [];
    } catch { return []; }
  }

  private pushHistory(line: string): void {
    if (this.history[this.history.length - 1] !== line) {
      this.history.push(line);
      while (this.history.length > CONSOLE_HISTORY_MAX) this.history.shift();
      try { localStorage.setItem(CONSOLE_HISTORY_KEY, JSON.stringify(this.history)); } catch { /* storage full / disabled */ }
    }
    this.resetHistoryBrowse();
  }

  private resetHistoryBrowse(): void {
    this.browsingHistory = false;
    this.historyIndex = this.history.length;
    this.historyDraft = '';
  }

  private browseHistory(dir: number): void {
    const input = this.input;
    if (!input || this.history.length === 0) return;
    if (!this.browsingHistory) { this.browsingHistory = true; this.historyIndex = this.history.length; this.historyDraft = input.value; }
    const next = this.historyIndex + dir;
    if (next < 0) return;
    if (next >= this.history.length) {
      // walked past the newest entry → back to what was being typed
      this.historyIndex = this.history.length;
      input.value = this.historyDraft;
      this.browsingHistory = false;
    } else {
      this.historyIndex = next;
      input.value = this.history[next];
    }
    input.setSelectionRange(input.value.length, input.value.length);
    this.suggestions = [];
    this.suggestIndex = -1;
    this.renderSuggestions();
  }
}
