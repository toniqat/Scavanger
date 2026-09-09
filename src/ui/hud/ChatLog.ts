import type { GameContext, ChatKind, PeerId, PlayerCode, WhisperLine } from '@/shared';
import { Keys, CHAT_MAX_LINES, formatPlayerCode, keyLabel } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { socialOf } from '../menus/social/socialSource';

const BLOCKER = 'chat';
const LINE_FADE_AFTER = 12;   // seconds a line stays fully visible while the input is closed
const FADE_CHECK = 0.25;      // seconds between fade sweeps
const MAX_TEXT = 120;
/** Closed-state log height in line pitches: three full lines + the fourth cut in half at the top (2026-09-09). */
const CLOSED_LINES = 3.5;

interface Line { el: HTMLElement; time: number; faded: boolean }

/**
 * Squad chat log (bottom-left, above the vitals; bottom-left in the hub). Lines `[HH:MM] 이름: 텍스트` styled by
 * `ChatKind` (`text` default, `ping` cyan italic, `request` amber, `system` grey). Lines fade ~12 s after they
 * arrive unless the input is open (then the whole log shows and the panel scrolls with the wheel).
 *
 * Input: `Keys.CHAT` (Enter) while `ctx.isControlActive()` (gameplay OR hub) opens a text field — blocker token
 * `'chat'` plus `input.setCursorMode(true, 'chat')` (Phase 10 §2: the pointer lock is **kept**, the software cursor
 * owns the UI, and there is no relock microtask on close). A capture-phase keydown listener with
 * `stopImmediatePropagation` keeps Esc from pausing and letters from moving the player.
 *
 * **2026-09-09 (채팅 UI 정리).**
 *   • **Enter sends and keeps the input open** (cleared, still focused, no hide/show so the row's entrance animation
 *     never re-runs); an empty Enter is a no-op. Closing is **Tab (`Keys.INVENTORY`) or Esc** only — Tab is consumed
 *     (`ctx.input.consume`) so the inventory does not open on the same press. Esc on an empty whisper input drops
 *     the target first, exactly as before. A `.chat-hint` chip (`<Tab 키캡> 키로 닫기`, live `keyLabel`) sits flush
 *     right of the single-line input; the input is `flex:1; min-width:0` so long text scrolls inside it and never
 *     runs under the hint.
 *   • **Closed state shows 3.5 lines**: the log's closed `max-height` is measured from a real line
 *     (`--chat-closed-h` = 3.5 × line height + 3 gaps) so the fourth-oldest visible line is cut in half at the top
 *     under the fade mask. Open keeps its 300 px panel.
 *   • **Korean IME Enter** (2026-09-09, later): the Enter that commits a composing syllable fires `keydown` with
 *     `isComposing` (legacy `keyCode 229`) *before* `compositionend`; sending on it cleared the field and the IME then
 *     re-inserted the last syllable on its own. The capture handler now ignores Enter / Esc while `e.isComposing`,
 *     `keyCode === 229` or the input's own `compositionstart`→`compositionend` window is open — but a composing **Enter**
 *     is remembered (`sendAfterCompose`) and posted right after `compositionend`, so Korean still sends on ONE Enter (a composing Tab only keeps
 *     focus), so "안녕" + Enter commits, and the next Enter posts one line "안녕" with an empty field.
 *   • **Bottom-of-log bug**: the scroll container's height changes after `scrollTop` was set — `close()` shrinks it
 *     from 300 px back to the closed height (a scroll box keeps its `scrollTop`, not its bottom edge, when it shrinks,
 *     so the newest ~130 px slid out of view), and the web font swapping in after the first lines grew every line
 *     under a scroll position computed for the fallback font. `stick()` now re-pins the bottom synchronously **and**
 *     on the next frame, and is called on add / open / close / `document.fonts.ready` / container resize
 *     (`ResizeObserver`).
 *
 * Feeds: `chat:post` (own line, sent as `ChatMessage` to 'others' while in a lobby), `net:chat`, and system lines for
 * `net:peerJoined/peerLeft`, `pickup:taken` (remote), `hub:slotChanged`, `hub:launchCountdown`, and (Phase 7)
 * `net:hostChanged` (`호스트 변경: <name>`), `net:peerSuspended` (`<name> 연결 끊김` / `재연결`), the training arena
 * (`시뮬레이션 훈련장 입장` on `game:newMission {mode:'training'}`, `퇴장` on `training:exitRequested`). Every line emits
 * `chat:message`. Works as a local log in single-player too.
 *
 * **귓속말 (Phase 11).** `chat:whisperTo {code, name}` (emitted by the ESC social column / the community panel's
 * 귓속말하기) opens the input in **whisper mode**: a `.chat-target` chip reads `→ 이름` and every Enter goes out through
 * `ctx.net.social.whisper(code, text)` instead of `chat:post`. The sender's echo is **not** written locally — the
 * whisper mirror answers with `social:whisper {line}` for both directions (`line.out` distinguishes them) and that is
 * what draws a `kind:'whisper'` line; a `whisper()` that returns false (offline / unavailable / empty) leaves a system
 * failure line instead. Clearing the target (the chip's ×, or Escape on an empty input) drops back to squad chat.
 * While a target is set the bottom-left column is raised to mid-screen (`.hud-bl.whispering`).
 */
export class ChatLog {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private inputRow: HTMLElement;
  private input: HTMLInputElement;
  private targetChip: HTMLElement;
  private targetName: HTMLElement;
  private closeKey: HTMLElement;
  private ctx!: GameContext;
  private lines: Line[] = [];
  private _open = false;
  private acc = 0;
  private lastCountdown = -1;
  /** Active 귓속말 target, or null for ordinary squad chat (Phase 11). */
  private target: { code: PlayerCode; name: string } | null = null;
  private unsubs: Array<() => void> = [];
  /** Last measured line height (px) the closed `max-height` was derived from; 0 = not measured yet. */
  private lineH = 0;
  private stickRaf = 0;
  private resizeObs: ResizeObserver | null = null;

  /** True between `compositionstart` and `compositionend` on the input (Korean IME assembling a syllable). */
  private composing = false;
  /** A composing Enter was seen — send as soon as the IME commits (`compositionend`). */
  private sendAfterCompose = false;

  private keyHandler = (e: KeyboardEvent): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this._open) {
      // 2026-09-09 — Korean IME: the Enter that *commits* a syllable arrives as a keydown while the composition is still
      // open (`isComposing`, legacy `keyCode 229`). Sending on it cleared the field and then `compositionend` re-inserted
      // the syllable on its own — "안녕" + Enter posted "안녕" and left "녕" behind. Let the composition finish instead:
      // no send / close on a composing Enter · Esc; a composing Tab only keeps focus (the next, real press closes).
      if (e.isComposing || e.keyCode === 229 || this.composing) {
        if (e.code === Keys.INVENTORY) { e.preventDefault(); e.stopImmediatePropagation(); }
        // The committing Enter still means "send": remember it and post once `compositionend` has written the syllable,
        // so Korean text goes out on ONE Enter and nothing is left behind in the field.
        if ((e.code === Keys.CHAT || e.code === 'NumpadEnter') && !e.repeat) { e.preventDefault(); this.sendAfterCompose = true; }
        return;
      }
      this.sendAfterCompose = false;
      if (e.code === Keys.CHAT || e.code === 'NumpadEnter') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) this.send();
      } else if (e.code === Keys.INVENTORY) {
        // 2026-09-09: Tab closes every screen. Swallow the press for `Input` too so the inventory does not open.
        e.preventDefault(); e.stopImmediatePropagation();
        ctx.input.consume(Keys.INVENTORY);
        if (!e.repeat) this.close();
      } else if (e.code === Keys.MENU) {
        e.preventDefault(); e.stopImmediatePropagation();
        // Escape on an empty whisper input drops the target first — one key, two steps out.
        if (this.target && !this.input.value.trim()) this.setTarget(null);
        else this.close();
      }
      // other keys reach the input element (which stops their propagation itself)
      return;
    }
    if (e.code !== Keys.CHAT || e.repeat) return;
    if (!ctx.isControlActive()) return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    e.preventDefault(); e.stopImmediatePropagation();
    this.open();
  };

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'chat', parent });
    this.list = el('div', { cls: 'chat-lines', parent: this.root });
    this.inputRow = el('div', { cls: 'chat-input-row', parent: this.root });
    this.inputRow.hidden = true;
    this.targetChip = el('span', { cls: 'chat-target', parent: this.inputRow });
    this.targetChip.hidden = true;
    this.targetName = el('span', { cls: 't', text: '', parent: this.targetChip });
    const clearTarget = el('button', { cls: 'x', text: '×', parent: this.targetChip });
    clearTarget.title = '귓속말 대상 해제';
    clearTarget.addEventListener('click', (e) => { e.stopPropagation(); this.setTarget(null); this.input.focus(); });
    el('span', { cls: 'chat-prompt', text: '›', parent: this.inputRow });
    this.input = el('input', {
      cls: 'chat-input', attrs: { type: 'text', maxlength: String(MAX_TEXT), placeholder: '메시지 입력… (Enter 전송)', spellcheck: 'false', autocomplete: 'off' },
      parent: this.inputRow,
    });
    // Flush-right close hint — its own flex item after the input (`flex:none`), so typed text can never run under it.
    const hint = el('span', { cls: 'chat-hint', parent: this.inputRow });
    this.closeKey = el('span', { cls: 'keycap', text: keyLabel(Keys.INVENTORY), parent: hint });
    el('span', { cls: 'chat-hint-t', text: '키로 닫기', parent: hint });
    // Keep game input from seeing typed characters (Input listens on window in the bubble phase).
    this.input.addEventListener('keydown', (e) => e.stopPropagation());
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    // Korean IME (2026-09-09): remember the composition window so the capture-phase key handler above never sends
    // the half-assembled syllable (some browsers deliver the committing Enter without `isComposing`).
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
      if (!this.sendAfterCompose) return;
      this.sendAfterCompose = false;
      // the committed text is in `value` by now; defer one tick so the IME has fully released the field
      if (this._open) window.setTimeout(() => { if (this._open && !this.composing) this.send(); }, 0);
    });
    this.input.addEventListener('blur', () => { if (this._open) this.input.focus(); });
    this.root.addEventListener('wheel', (e) => { if (this._open) e.stopPropagation(); }, { passive: true });
    // The scroll box changes height on open / close (and with the column's width): re-pin the newest line.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.stick());
      this.resizeObs.observe(this.list);
    }
    // Web fonts arriving after the first lines change every line's height under an already-set scroll position.
    document.fonts?.ready.then(() => { this.lineH = 0; this.measure(); this.stick(); });
  }

  get isOpen(): boolean { return this._open; }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('input:bindingsChanged', () => setText(this.closeKey, keyLabel(Keys.INVENTORY))),
      b.on('chat:post', ({ text, kind }) => this.post(text, kind)),
      b.on('net:chat', ({ id, name, text, kind }) => this.add(id, name, text, kind ?? 'text', false)),
      b.on('net:peerJoined', ({ name }) => this.system(`${name} 합류`)),
      b.on('net:peerLeft', ({ name }) => this.system(`${name} 이탈`)),
      b.on('pickup:taken', ({ item, byLocal, byName }) => {
        if (byLocal) return;
        const name = ctx.loot?.getItemDef(item.defId)?.name ?? item.defId;
        const qty = item.qty > 1 ? ` ×${item.qty}` : '';
        this.system(`${byName ?? '분대원'}이(가) ${name}${qty} 획득`);
      }),
      b.on('hub:slotChanged', ({ slot, peerId, local }) => {
        const who = local ? (ctx.net?.playerName ?? '나') : (peerId ? (ctx.net?.getLobbyPlayer(peerId)?.name ?? '분대원') : null);
        if (peerId) this.system(`${who}이(가) 발사 포드 ${slot + 1}에 탑승`);
        else this.system(`발사 포드 ${slot + 1} 비움`);
      }),
      b.on('hub:launchCountdown', ({ seconds, ready, total }) => {
        const s = Math.ceil(seconds);
        if (s === this.lastCountdown) return;
        this.lastCountdown = s;
        this.system(s <= 0 ? '발사!' : `발사 ${s}초 전 (${ready}/${total} 탑승)`);
      }),
      b.on('hub:entered', () => { this.lastCountdown = -1; }),
      /* ── Phase 7: host migration, suspended members, training arena ── */
      b.on('net:hostChanged', ({ hostId, isLocalHost }) => this.system(`호스트 변경: ${this.peerName(hostId, isLocalHost)}`)),
      b.on('net:peerSuspended', ({ name, suspended }) => this.system(`${name} ${suspended ? '연결 끊김' : '재연결'}`)),
      b.on('training:exitRequested', () => this.system('시뮬레이션 훈련장 퇴장')),
      /* ── Phase 11: 귓속말 ── */
      b.on('chat:whisperTo', ({ code, name }) => { this.setTarget({ code, name }); this.open(); this.input.focus(); }),
      b.on('social:whisper', ({ line }) => this.addWhisper(line)),
      b.on('game:newMission', ({ mode }) => {
        this.lastCountdown = -1;
        if (this._open) this.close(false);
        this.setTarget(null);
        if (mode === 'training') this.system('시뮬레이션 훈련장 입장');
      }),
      b.on('game:abort', () => { if (this._open) this.close(false); this.setTarget(null); }),
      b.on('game:phaseChanged', () => { if (this._open && !ctx.isGameplayPhase() && !ctx.isHubPhase()) this.close(false); }),
    );
    window.addEventListener('keydown', this.keyHandler, true);
  }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc < FADE_CHECK) return;
    this.acc = 0;
    if (this._open) return;
    const now = performance.now() / 1000;
    for (const l of this.lines) {
      const faded = now - l.time > LINE_FADE_AFTER;
      if (faded !== l.faded) { l.faded = faded; toggleClass(l.el, 'faded', faded); }
    }
  }

  /* ── lines ─────────────────────────────────────────────────────────────── */

  /** Local player posts a line (typed text, ping callout, ammo request). */
  private post(text: string, kind: ChatKind): void {
    const ctx = this.ctx;
    const t = text.trim().slice(0, MAX_TEXT);
    if (!t) return;
    this.add(null, ctx.net?.playerName ?? '나', t, kind, true);
    if (ctx.net?.lobby) ctx.net.send({ t: 'chat', text: t, kind }, 'others');
  }

  private system(text: string): void { this.add(null, '시스템', text, 'system', false); }

  /** One whisper, either direction (`line.out` = I sent it). Drawn as a `kind:'whisper'` line. */
  private addWhisper(line: WhisperLine): void {
    const who = line.out ? `귓속말 → ${line.name || formatPlayerCode(line.code)}` : `귓속말 ${line.name || formatPlayerCode(line.code)}`;
    this.add(null, who, line.text, 'whisper', line.out);
  }

  /** Aim the input at one 아이디 (null = back to squad chat). Also raises the bottom-left column. */
  private setTarget(t: { code: PlayerCode; name: string } | null): void {
    this.target = t;
    this.targetChip.hidden = !t;
    if (t) setText(this.targetName, `→ ${t.name || formatPlayerCode(t.code)}`);
    this.input.placeholder = t ? '귓속말 입력… (Enter 전송 · Esc 대상 해제)' : '메시지 입력… (Enter 전송)';
    toggleClass(this.root, 'whispering', !!t);
    // The column that holds the log is owned by HudSystem (`.hud-bl`); the spec puts it mid-left while whispering.
    const col = this.root.parentElement;
    if (col && col.classList.contains('hud-bl')) toggleClass(col, 'whispering', !!t);
  }

  /** Whether the input is aimed at a 귓속말 target (debug). */
  get whisperTarget(): PlayerCode | null { return this.target?.code ?? null; }

  /** Display name of a peer id (lobby list → remote ref → own name when it is us). */
  private peerName(id: PeerId, isLocal: boolean): string {
    const net = this.ctx.net;
    if (isLocal || id === net?.localId) return net?.playerName ?? '나';
    return net?.getLobbyPlayer(id)?.name ?? net?.getRemotePlayer(id)?.name ?? '분대원';
  }

  private add(id: PeerId | null, name: string, text: string, kind: ChatKind, local: boolean): void {
    const d = new Date();
    const hh = d.getHours().toString().padStart(2, '0'), mm = d.getMinutes().toString().padStart(2, '0');
    const line = el('div', { cls: `chat-line ${kind}${local ? ' me' : ''}` });
    el('span', { cls: 'ts ui-mono', text: `[${hh}:${mm}]`, parent: line });
    if (kind !== 'system') el('span', { cls: 'who', text: `${name}:`, parent: line });
    el('span', { cls: 'txt', text, parent: line }); // textContent → no markup injection
    this.list.appendChild(line);
    this.lines.push({ el: line, time: performance.now() / 1000, faded: false });
    while (this.lines.length > CHAT_MAX_LINES) { const old = this.lines.shift()!; old.el.remove(); }
    this.measure(line);
    this.stick();
    this.ctx.bus.emit('chat:message', { id, name, text, kind, local });
  }

  /**
   * Derive the closed `max-height` (`--chat-closed-h` on `.chat`) from a real line so it is exactly `CLOSED_LINES`
   * pitches whatever the font metrics: 3 full lines + 3 gaps + half a line. Re-measured only when the line height
   * actually changes (first line, font swap).
   */
  private measure(line: HTMLElement | null = this.lines[this.lines.length - 1]?.el ?? null): void {
    if (!line) return;
    const h = line.getBoundingClientRect().height;
    if (!(h > 0) || Math.abs(h - this.lineH) < 0.01) return;
    this.lineH = h;
    const gap = parseFloat(getComputedStyle(this.list).rowGap) || 0;
    const full = Math.floor(CLOSED_LINES);
    const px = full * h + full * gap + (CLOSED_LINES - full) * h;
    this.root.style.setProperty('--chat-closed-h', `${px.toFixed(2)}px`);
  }

  /** Pin the newest line to the bottom edge — now, and again after the next layout. */
  private stick(): void {
    const list = this.list;
    list.scrollTop = list.scrollHeight;
    if (this.stickRaf) return;
    this.stickRaf = requestAnimationFrame(() => {
      this.stickRaf = 0;
      list.scrollTop = list.scrollHeight;
    });
  }

  /* ── input ─────────────────────────────────────────────────────────────── */

  open(): void {
    if (this._open) return;
    const ctx = this.ctx;
    this._open = true;
    ctx.uiBlockers.add(BLOCKER);
    // Phase 10 (§2): keep the pointer lock and hand UI input to the software cursor (ref-counted by this token).
    ctx.input.setCursorMode(true, BLOCKER);
    this.root.classList.add('interactive', 'open');
    for (const l of this.lines) if (l.faded) { l.faded = false; toggleClass(l.el, 'faded', false); }
    this.inputRow.hidden = false;
    this.input.value = '';
    this.composing = false;
    this.sendAfterCompose = false;
    this.input.focus();
    this.stick();
    ctx.bus.emit('ui:chatToggled', { open: true });
  }

  /** `relock` is kept for the existing call sites but is a no-op since Phase 10 — the lock was never released. */
  close(relock = true): void {
    void relock;
    if (!this._open) return;
    const ctx = this.ctx;
    this._open = false;
    this.inputRow.hidden = true;
    this.composing = false;
    this.sendAfterCompose = false;
    this.input.blur();
    this.root.classList.remove('interactive', 'open');
    ctx.uiBlockers.delete(BLOCKER);
    ctx.input.setCursorMode(false, BLOCKER);
    // restart the fade clock so the log does not vanish the moment the input closes
    const now = performance.now() / 1000;
    for (const l of this.lines) l.time = Math.max(l.time, now - LINE_FADE_AFTER + 3);
    this.acc = FADE_CHECK;
    // The box just shrank back to the closed height — a scroll container keeps its scrollTop, not its bottom edge.
    this.stick();
    ctx.bus.emit('ui:chatToggled', { open: false });
  }

  /**
   * Enter: send what is typed and **stay open** (2026-09-09) — the field is cleared and keeps focus, the row is never
   * hidden so its entrance animation does not replay. An empty Enter does nothing. The whisper target is kept.
   */
  private send(): void {
    const text = this.input.value.trim().slice(0, MAX_TEXT);
    if (!text) return;
    const t = this.target;
    if (t) {
      // The mirror echoes a successful whisper back as `social:whisper {line.out}` — never double-write it here.
      const sent = socialOf(this.ctx)?.whisper(t.code, text) ?? false;
      if (!sent) this.system(`귓속말 전송 실패 — ${t.name || formatPlayerCode(t.code)}`);
    } else {
      this.ctx.bus.emit('chat:post', { text, kind: 'text' });
    }
    this.input.value = '';
    this.input.focus();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    window.removeEventListener('keydown', this.keyHandler, true);
    this.resizeObs?.disconnect();
    if (this.stickRaf) cancelAnimationFrame(this.stickRaf);
    if (this._open) { this._open = false; this.ctx?.uiBlockers.delete(BLOCKER); this.ctx?.input.setCursorMode(false, BLOCKER); }
    this.root.remove();
  }
}
