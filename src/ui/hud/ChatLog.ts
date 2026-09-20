import type { GameContext, ChatKind, PeerId, PlayerCode, WhisperLine } from '@/shared';
import { Keys, CHAT_MAX_LINES, NET_SLOT_COLORS_CSS, PRIVATE_CHAT_LABEL_KO, SOCIAL_WHISPER_MAX, createKeycap, formatPlayerCode, paintKeycap } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { isPeerBlocked, socialOf } from '../menus/social/socialSource';
import { whisperStateClass, whisperStateText } from '../menus/social/whisperText';
import '../styles/social.css';

const BLOCKER = 'chat';
const LINE_FADE_AFTER = 12;   // seconds a line stays fully visible while the input is closed
const FADE_CHECK = 0.25;      // seconds between fade sweeps
/** 2026-09-11 (B-4): the relay's own whisper cap (was 120, so a long whisper was cut short on the sender's side). */
const MAX_TEXT = SOCIAL_WHISPER_MAX;
/** `/r <텍스트>` — reply to the last 개인 대화 partner. `/ㄱ` is the same keys on a Korean layout. */
const REPLY_RE = /^\/[rRㄱ](?:\s+([\s\S]*))?$/;

interface Line { el: HTMLElement; time: number; faded: boolean }

/**
 * Squad chat log (bottom-left, above the vitals; bottom-left in the hub). Lines `[HH:MM] 이름: 텍스트` styled by
 * `ChatKind` (`text` default, `ping` cyan italic, `request` amber, `system` grey). Lines fade ~12 s after they
 * arrive unless the input is open (then the whole log shows and the panel scrolls with the wheel).
 *
 * Input: `Keys.CHAT` (Enter) while `ctx.isControlActive()` (gameplay OR hub) opens a text field — blocker token
 * `'chat'` plus `input.setCursorMode(true, 'chat')` (cursor mode **releases** the pointer lock and the real cursor owns the UI;
 * the relock on close is `main.ts`'s single relock point). A capture-phase keydown listener with
 * `stopImmediatePropagation` keeps Esc from pausing and letters from moving the player.
 *
 * **2026-09-09 (the chat UI cleanup).**
 *   • **Enter sends and keeps the input open** (cleared, still focused, no hide/show so the row's entrance animation
 *     never re-runs); an empty Enter is a no-op. Closing is **Tab (`Keys.INVENTORY`) or Esc** only — Tab is consumed
 *     (`ctx.input.consume`) so the inventory does not open on the same press. Esc on an empty whisper input drops
 *     the target first, exactly as before. A `.chat-hint` chip (`<Tab 키캡> 키로 닫기`, live `keyLabel`) sits flush
 *     right of the single-line input; the input is `flex:1; min-width:0` so long text scrolls inside it and never
 *     runs under the hint.
 *   • **Closed state shows 3.5 lines**: the log's closed `max-height` is 3.5 × line pitch + 3 gaps, computed in CSS
 *     from `--chat-fs` · `--chat-lh` · `--chat-gap` (`base.css`), so the fourth-oldest visible line is cut in half at
 *     the top under the fade mask. Open keeps its 300 px panel.
 *   • **Korean IME Enter** (2026-09-09, later): the Enter that commits a composing syllable fires `keydown` with
 *     `isComposing` (legacy `keyCode 229`) *before* `compositionend`; sending on it cleared the field and the IME then
 *     re-inserted the last syllable on its own. The capture handler now ignores Enter / Esc while `e.isComposing`,
 *     `keyCode === 229` or the input's own `compositionstart`→`compositionend` window is open — but a composing **Enter**
 *     is remembered (`sendAfterCompose`) and posted right after `compositionend`, so Korean still sends on ONE Enter (a composing Tab only keeps
 *     focus), so "안녕" + Enter commits, and the next Enter posts one line "안녕" with an empty field.
 *   • **Bottom-of-log bug**: the scroll container's height changes after `scrollTop` was set — `close()` shrinks it
 *     from 300 px back to the closed height (a scroll box keeps its `scrollTop`, not its bottom edge, when it shrinks,
 *     so the newest ~130 px slid out of view), and the web font swapping in after the first lines grew every line
 *     under a scroll position computed for the fallback font. Both were re-pinned by a `stick()` that wrote
 *     `scrollTop = scrollHeight`; **since 2026-09-20 the box pins itself** — see `.chat-lines` below.
 *
 * **2026-09-20 (`docs/PERF_PLAN.md` Phase B) — this widget reads no layout, ever.** It used to force a full
 * synchronous layout of the whole UI **per line**: `measure()` asked a fresh row for its
 * `getBoundingClientRect().height` and `stick()` read `scrollHeight`, both from inside the frame, right after
 * `HudSystem.update` had dirtied the HUD. Three android callouts landing in one frame cost **8.3 ms** of that
 * frame — the largest one-off the perf plan found, and a breach of CLAUDE.md §4.2 「no layout read inside a frame」.
 * Neither read is needed:
 *   • the closed height is arithmetic on CSS numbers, so `base.css` computes it with `calc()`;
 *   • the scroller `.chat-lines` is `column-reverse` around one `.chat-lines-inner`, so its scroll origin **is** the
 *     bottom edge and the newest line stays in view by itself — through open / close, a font swap and a resize.
 *     The reversal is CSS only: `.chat-line` elements keep their oldest→newest document order.
 * A reader who has scrolled up now **stays** where they are when a line arrives (`stick` used to yank them down).
 * Anything added here must keep the count at zero: `scripts/smoke-layout-reads.mjs` fails the build otherwise.
 *
 * Feeds: `chat:post` (own line, sent as `ChatMessage` to 'others' while in a lobby), `net:chat`, and system lines for
 * `net:peerJoined/peerLeft`, `pickup:taken` (remote), `hub:slotChanged`, `hub:launchCountdown`, and (Phase 7)
 * `net:hostChanged` (`호스트 변경: <name>`), `net:peerSuspended` (`<name> 연결 끊김` / `재연결`), the training arena
 * (`시뮬레이션 훈련장 입장` on `game:newMission {mode:'training'}`, `퇴장` on `training:exitRequested`). Every line emits
 * `chat:message`. Works as a local log in single-player too.
 *
 * **개인 대화 (Phase 11's 귓속말, officially renamed 2026-09-14).** `chat:whisperTo {code, name}` opens the input in **whisper mode**
 * (the lines land in the same `SocialRef.whisperHistory` the messenger's 대화 tab draws): a `.chat-target` chip reads `→ 이름` and every Enter goes out through
 * `ctx.net.social.whisper(code, text)` instead of `chat:post`. The sender's echo is **not** written locally — the
 * whisper mirror answers with `social:whisper {line}` for both directions (`line.out` distinguishes them) and that is
 * what draws a `kind:'whisper'` line; a `whisper()` that returns false (offline / unavailable / empty) leaves a system
 * failure line instead. Clearing the target (the chip's ×, or Escape on an empty input) drops back to squad chat.
 * While a target is set the bottom-left column is raised to mid-screen (`.hud-bl.whispering`).
 *
 * **Delivery state · blocking · /r (2026-09-11, B-4).**
 *   • An outgoing line arrives `state:'pending'` and is drawn dimmed (`.pending`); `social:whisperUpdated` finds the row
 *     by `line.nonce` and turns it `sent` / `stored` (`오프라인 보관 — 접속하면 전달`) / `failed` (`전송 실패 — 오프라인`)
 *     **in place** — there is no separate error toast any more. The `.wst` tag carries that text (`menus/social/whisperText`).
 *     A backlog line (`line.backlog`) is tagged `접속 전에 받음`. The input cap is `SOCIAL_WHISPER_MAX` (the relay's).
 *   • Squad chat **text** from a member whose 아이디 I blocked (`net.getLobbyPlayer(id).code` → `SocialRef.isBlocked`) is
 *     not drawn; their pings and comms-wheel lines (`ping` / `request`) still are.
 *   • `/r <텍스트>` (also `/ㄱ`) whispers the last partner (`SocialRef.lastWhisperPeer`); `/r` alone aims the input at them.
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
  /** The active whisper target, or null for ordinary squad chat (Phase 11). */
  private target: { code: PlayerCode; name: string } | null = null;
  /** 2026-09-11 (B-4): my whisper rows still able to change state, by `line.nonce`. */
  private whisperRows = new Map<number, HTMLElement>();
  private unsubs: Array<() => void> = [];

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
    // `.chat-lines` is the scroller (`column-reverse`, one child) and `.chat-lines-inner` holds the rows in normal
    // order — see the 2026-09-20 note above and `base.css`.
    const scroller = el('div', { cls: 'chat-lines', parent: this.root });
    this.list = el('div', { cls: 'chat-lines-inner', parent: scroller });
    this.inputRow = el('div', { cls: 'chat-input-row', parent: this.root });
    this.inputRow.hidden = true;
    this.targetChip = el('span', { cls: 'chat-target', parent: this.inputRow });
    this.targetChip.hidden = true;
    this.targetName = el('span', { cls: 't', text: '', parent: this.targetChip });
    const clearTarget = el('button', { cls: 'x', text: '×', parent: this.targetChip });
    clearTarget.title = `${PRIVATE_CHAT_LABEL_KO} 대상 해제`;
    clearTarget.addEventListener('click', (e) => { e.stopPropagation(); this.setTarget(null); this.input.focus(); });
    el('span', { cls: 'chat-prompt', text: '›', parent: this.inputRow });
    this.input = el('input', {
      // + 3 so `/r ` plus a full-length whisper still fits (the text itself is cut to MAX_TEXT on send)
      cls: 'chat-input', attrs: { type: 'text', maxlength: String(MAX_TEXT + 3), placeholder: '메시지 입력… (Enter 전송)', spellcheck: 'false', autocomplete: 'off' },
      parent: this.inputRow,
    });
    // Flush-right close hint — its own flex item after the input (`flex:none`), so typed text can never run under it.
    const hint = el('span', { cls: 'chat-hint', parent: this.inputRow });
    this.closeKey = createKeycap(Keys.INVENTORY, { parent: hint });   // 2026-09-15: 공용 키캡
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
    // No `ResizeObserver` and no `document.fonts.ready` hook: both existed only to re-pin the newest line after the
    // box changed height, and `column-reverse` pins it for free (the header's 2026-09-20 note).
  }

  get isOpen(): boolean { return this._open; }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.warmUpSoon();
    const b = ctx.bus;
    this.unsubs.push(
      b.on('input:bindingsChanged', () => paintKeycap(this.closeKey, Keys.INVENTORY)),
      b.on('chat:post', ({ text, kind }) => this.post(text, kind)),
      b.on('net:chat', ({ id, name, text, kind }) => {
        const k = kind ?? 'text';
        // B-4 (2026-09-11): typed lines from a squad-mate I blocked are not drawn — pings / comms-wheel lines still are.
        if (k === 'text' && this.isBlockedPeer(id)) return;
        this.add(id, name, text, k, false);
      }),
      /* 2026-09-15 (android squadmates): the one line allies/ and `hud/Pings` emit. **Never relayed** — `ally:chat` is
       * already emitted on every client (the host sends it over the `ally chat` wire), and turning it back into `chat:post`
       * here would show the same line twice. The colour before the name is that unit’s lobby slot colour. */
      b.on('ally:chat', ({ name, slot, text }) => this.addAlly(name, slot, text)),
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
      /* ── Phase 11: whispers ── */
      b.on('chat:whisperTo', ({ code, name }) => { this.setTarget({ code, name }); this.open(); this.input.focus(); }),
      b.on('social:whisper', ({ line }) => this.addWhisper(line)),
      b.on('social:whisperUpdated', ({ line }) => this.updateWhisper(line)),
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

  /** 2026-09-15: an android’s line — `<이름>: 텍스트`, the name in that unit’s slot colour (`.chat-line.ally`, `--sc`). */
  private addAlly(name: string, slot: number, text: string): void {
    const t = String(text ?? '').trim().slice(0, MAX_TEXT);
    if (!t) return;
    const row = this.add(null, name || '안드로이드', t, 'text', false, 'ally');
    row.style.setProperty('--sc', NET_SLOT_COLORS_CSS[slot] ?? '#fff');
  }

  /**
   * One whisper, either direction (`line.out` = I sent it). Drawn as a `kind:'whisper'` line; B-4 adds the delivery
   * state as a modifier class + a `.wst` tag, and keeps a still-changing row by nonce for `updateWhisper`.
   */
  private addWhisper(line: WhisperLine): void {
    const who = line.out
      ? `${PRIVATE_CHAT_LABEL_KO} → ${line.name || formatPlayerCode(line.code)}`
      : `${PRIVATE_CHAT_LABEL_KO} ${line.name || formatPlayerCode(line.code)}`;
    const row = this.add(null, who, line.text, 'whisper', line.out, whisperStateClass(line));
    const st = whisperStateText(line);
    const tag = el('span', { cls: 'wst', text: st, parent: row });
    tag.hidden = !st;
    if (line.nonce !== undefined && line.state === 'pending') {
      row.dataset.nonce = String(line.nonce);
      this.whisperRows.set(line.nonce, row);
    }
  }

  /** B-4: `social:whisperUpdated` — the pending row settles in place (sent · stored · failed). */
  private updateWhisper(line: WhisperLine): void {
    if (line.nonce === undefined) return;
    const row = this.whisperRows.get(line.nonce);
    if (!row) return;
    row.classList.remove('pending', 'stored', 'failed');
    const mod = whisperStateClass(line);
    if (mod) row.classList.add(mod);
    const tag = row.querySelector<HTMLElement>('.wst');
    const st = whisperStateText(line);
    if (tag) { setText(tag, st); tag.hidden = !st; }
    if (line.state !== 'pending') { this.whisperRows.delete(line.nonce); delete row.dataset.nonce; }
  }

  /** B-4: whether squad-mate `id`'s 아이디 is on my 차단 목록 (shared with `hud/TypingBubbles` — `socialSource`). */
  private isBlockedPeer(id: PeerId): boolean { return isPeerBlocked(this.ctx, id); }

  /** Aim the input at one 아이디 (null = back to squad chat). Also raises the bottom-left column. */
  private setTarget(t: { code: PlayerCode; name: string } | null): void {
    this.target = t;
    this.targetChip.hidden = !t;
    if (t) setText(this.targetName, `→ ${t.name || formatPlayerCode(t.code)}`);
    this.input.placeholder = t ? `${PRIVATE_CHAT_LABEL_KO} 입력… (Enter 전송 · Esc 대상 해제)` : '메시지 입력… (Enter 전송)';
    toggleClass(this.root, 'whispering', !!t);
    // The column that holds the log is owned by HudSystem (`.hud-bl`); the spec puts it mid-left while whispering.
    const col = this.root.parentElement;
    if (col && col.classList.contains('hud-bl')) toggleClass(col, 'whispering', !!t);
  }

  /** Whether the input is aimed at a whisper target (debug). */
  get whisperTarget(): PlayerCode | null { return this.target?.code ?? null; }

  /** 2026-09-15 (debug / smoke): the drawn lines — class · name · body (oldest first). */
  get lineStates(): Array<{ cls: string; who: string; text: string }> {
    return this.lines.map((l) => ({
      cls: l.el.className,
      who: l.el.querySelector('.who')?.textContent ?? '',
      text: l.el.querySelector('.txt')?.textContent ?? '',
    }));
  }

  /** Display name of a peer id (lobby list → remote ref → own name when it is us). */
  private peerName(id: PeerId, isLocal: boolean): string {
    const net = this.ctx.net;
    if (isLocal || id === net?.localId) return net?.playerName ?? '나';
    return net?.getLobbyPlayer(id)?.name ?? net?.getRemotePlayer(id)?.name ?? '분대원';
  }

  /**
   * **Pay a chat row's first layout at boot** (2026-09-20, `docs/PERF_PLAN.md` Phase B).
   *
   * Removing the per-line `getBoundingClientRect` was only half of it: the browser still lays the row out once, and
   * the *first* row of the page costs far more than the rest — the `.chat-line` rules have never been matched, and
   * the Korean glyphs have never been shaped. Measured on the reference machine: three rows in one frame cost
   * **5.3 ms** of layout the first time and **0.5 ms** every time after. In the android first-contact frame that one
   * lump was most of the lost frame.
   *
   * So one throwaway row is drawn and removed on a timer right after `bind` — **outside `Engine.frame`** (the title
   * screen is up, nothing is waiting on it), which is both why it is free and why it does not trip
   * `scripts/smoke-layout-reads.mjs`. It must stay off the frame: moving this read into a `world:ready` handler
   * would put a forced layout back inside a frame.
   *
   * The row carries the classes and the text shape a real line has (`ping` + `ally` are the callout's), so what gets
   * resolved here is what an android callout needs. Nothing else in the widget knows about it.
   */
  private warmUpSoon(): void {
    window.setTimeout(() => {
      const row = el('div', { cls: 'chat-line ping ally', parent: this.list });
      el('span', { cls: 'ts ui-mono', text: '[00:00]', parent: row });
      el('span', { cls: 'who', text: '안드로이드:', parent: row });
      el('span', { cls: 'txt', text: '적 발견', parent: row });
      void row.offsetHeight;      // the one layout this costs, paid here instead of mid-fight
      row.remove();
    }, 0);
  }

  private add(id: PeerId | null, name: string, text: string, kind: ChatKind, local: boolean, mod = ''): HTMLElement {
    const d = new Date();
    const hh = d.getHours().toString().padStart(2, '0'), mm = d.getMinutes().toString().padStart(2, '0');
    const line = el('div', { cls: `chat-line ${kind}${local ? ' me' : ''}${mod ? ` ${mod}` : ''}` });
    el('span', { cls: 'ts ui-mono', text: `[${hh}:${mm}]`, parent: line });
    if (kind !== 'system') el('span', { cls: 'who', text: `${name}:`, parent: line });
    el('span', { cls: 'txt', text, parent: line }); // textContent → no markup injection
    this.list.appendChild(line);
    this.lines.push({ el: line, time: performance.now() / 1000, faded: false });
    while (this.lines.length > CHAT_MAX_LINES) {
      const old = this.lines.shift()!;
      if (old.el.dataset.nonce) this.whisperRows.delete(Number(old.el.dataset.nonce));
      old.el.remove();
    }
    this.ctx.bus.emit('chat:message', { id, name, text, kind, local });
    return line;
  }

  /* ── input ─────────────────────────────────────────────────────────────── */

  open(): void {
    if (this._open) return;
    const ctx = this.ctx;
    this._open = true;
    ctx.uiBlockers.add(BLOCKER);
    // Cursor mode releases the pointer lock and hands UI input to the real cursor (ref-counted by this token).
    ctx.input.setCursorMode(true, BLOCKER);
    this.root.classList.add('interactive', 'open');
    for (const l of this.lines) if (l.faded) { l.faded = false; toggleClass(l.el, 'faded', false); }
    this.inputRow.hidden = false;
    this.input.value = '';
    this.composing = false;
    this.sendAfterCompose = false;
    this.input.focus();
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
    ctx.bus.emit('ui:chatToggled', { open: false });
  }

  /**
   * Enter: send what is typed and **stay open** (2026-09-09) — the field is cleared and keeps focus, the row is never
   * hidden so its entrance animation does not replay. An empty Enter does nothing. The whisper target is kept.
   */
  private send(): void {
    const raw = this.input.value.trim();
    if (!raw) return;
    // B-4: `/r <텍스트>` → the last whisper partner; `/r` alone aims the input at them (either mode).
    const reply = REPLY_RE.exec(raw);
    if (reply) {
      this.reply((reply[1] ?? '').trim().slice(0, MAX_TEXT));
      this.input.value = '';
      this.input.focus();
      return;
    }
    const text = raw.slice(0, MAX_TEXT);
    const t = this.target;
    if (t) {
      // The mirror echoes a successful whisper back as `social:whisper {line.out}` — never double-write it here.
      const sent = socialOf(this.ctx)?.whisper(t.code, text) ?? false;
      if (!sent) this.system(`${PRIVATE_CHAT_LABEL_KO} 전송 실패 — ${t.name || formatPlayerCode(t.code)}`);
    } else {
      this.ctx.bus.emit('chat:post', { text, kind: 'text' });
    }
    this.input.value = '';
    this.input.focus();
  }

  /** `/r` — whisper `text` to `SocialRef.lastWhisperPeer`, or aim the input at them when `text` is empty. */
  private reply(text: string): void {
    const social = socialOf(this.ctx);
    const last = social?.lastWhisperPeer ?? null;
    if (!social || !last) { this.system(`답장할 ${PRIVATE_CHAT_LABEL_KO} 상대가 없습니다`); return; }
    const name = social.whisperPeers().find((p) => p.code === last)?.name || social.find(last)?.name || formatPlayerCode(last);
    if (!text) { this.setTarget({ code: last, name }); return; }
    if (!social.whisper(last, text)) this.system(`${PRIVATE_CHAT_LABEL_KO} 전송 실패 — ${name}`);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    window.removeEventListener('keydown', this.keyHandler, true);
    if (this._open) { this._open = false; this.ctx?.uiBlockers.delete(BLOCKER); this.ctx?.input.setCursorMode(false, BLOCKER); }
    this.root.remove();
  }
}
