import type { GameContext, ChatKind, PeerId } from '@/shared';
import { Keys, CHAT_MAX_LINES } from '@/shared';
import { el, toggleClass } from '../dom';

const BLOCKER = 'chat';
const LINE_FADE_AFTER = 12;   // seconds a line stays fully visible while the input is closed
const FADE_CHECK = 0.25;      // seconds between fade sweeps
const MAX_TEXT = 120;

interface Line { el: HTMLElement; time: number; faded: boolean }

/**
 * Squad chat log (bottom-left, above the vitals; bottom-left in the hub). Lines `[HH:MM] 이름: 텍스트` styled by
 * `ChatKind` (`text` default, `ping` cyan italic, `request` amber, `system` grey). Lines fade ~12 s after they
 * arrive unless the input is open (then the whole log shows and the panel scrolls with the wheel).
 *
 * Input: `Keys.CHAT` (Enter) while `ctx.isControlActive()` (gameplay OR hub) opens a text field — blocker token
 * `'chat'` is added BEFORE `exitPointerLock()`; Enter sends (`chat:post` kind 'text', ≤ 120 chars), Esc cancels;
 * closing removes the token and re-requests pointer lock one microtask later. A capture-phase keydown listener
 * with `stopImmediatePropagation` keeps Esc from pausing and letters from moving the player.
 *
 * Feeds: `chat:post` (own line, sent as `ChatMessage` to 'others' while in a lobby), `net:chat`, and system lines for
 * `net:peerJoined/peerLeft`, `pickup:taken` (remote), `hub:slotChanged`, `hub:launchCountdown`. Every line emits
 * `chat:message`. Works as a local log in single-player too.
 */
export class ChatLog {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private inputRow: HTMLElement;
  private input: HTMLInputElement;
  private ctx!: GameContext;
  private lines: Line[] = [];
  private _open = false;
  private acc = 0;
  private lastCountdown = -1;
  private unsubs: Array<() => void> = [];

  private keyHandler = (e: KeyboardEvent): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this._open) {
      if (e.code === Keys.CHAT || e.code === 'NumpadEnter') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) this.send();
      } else if (e.code === Keys.MENU) {
        e.preventDefault(); e.stopImmediatePropagation();
        this.close();
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
    el('span', { cls: 'chat-prompt', text: '›', parent: this.inputRow });
    this.input = el('input', {
      cls: 'chat-input', attrs: { type: 'text', maxlength: String(MAX_TEXT), placeholder: '메시지 입력… (Enter 전송 · Esc 취소)', spellcheck: 'false', autocomplete: 'off' },
      parent: this.inputRow,
    });
    el('span', { cls: 'chat-hint', text: `${MAX_TEXT}자`, parent: this.inputRow });
    // Keep game input from seeing typed characters (Input listens on window in the bubble phase).
    this.input.addEventListener('keydown', (e) => e.stopPropagation());
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.input.addEventListener('blur', () => { if (this._open) this.input.focus(); });
    this.root.addEventListener('wheel', (e) => { if (this._open) e.stopPropagation(); }, { passive: true });
  }

  get isOpen(): boolean { return this._open; }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
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
      b.on('game:newMission', () => { this.lastCountdown = -1; if (this._open) this.close(false); }),
      b.on('game:abort', () => { if (this._open) this.close(false); }),
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
    this.list.scrollTop = this.list.scrollHeight;
    this.ctx.bus.emit('chat:message', { id, name, text, kind, local });
  }

  /* ── input ─────────────────────────────────────────────────────────────── */

  open(): void {
    if (this._open) return;
    const ctx = this.ctx;
    this._open = true;
    ctx.uiBlockers.add(BLOCKER);        // before exiting the lock → GameFlow does not treat it as a pause
    ctx.input.exitPointerLock();
    this.root.classList.add('interactive', 'open');
    for (const l of this.lines) if (l.faded) { l.faded = false; toggleClass(l.el, 'faded', false); }
    this.inputRow.hidden = false;
    this.input.value = '';
    this.input.focus();
    this.list.scrollTop = this.list.scrollHeight;
    ctx.bus.emit('ui:chatToggled', { open: true });
  }

  close(relock = true): void {
    if (!this._open) return;
    const ctx = this.ctx;
    this._open = false;
    this.inputRow.hidden = true;
    this.input.blur();
    this.root.classList.remove('interactive', 'open');
    ctx.uiBlockers.delete(BLOCKER);
    // restart the fade clock so the log does not vanish the moment the input closes
    const now = performance.now() / 1000;
    for (const l of this.lines) l.time = Math.max(l.time, now - LINE_FADE_AFTER + 3);
    this.acc = FADE_CHECK;
    ctx.bus.emit('ui:chatToggled', { open: false });
    if (relock) {
      queueMicrotask(() => {
        if (this._open || !ctx.isControlActive()) return;
        if (ctx.player?.isDead ?? false) return;
        ctx.input.requestPointerLock();
      });
    }
  }

  private send(): void {
    const text = this.input.value.trim().slice(0, MAX_TEXT);
    if (text) this.ctx.bus.emit('chat:post', { text, kind: 'text' });
    this.close();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    window.removeEventListener('keydown', this.keyHandler, true);
    if (this._open) { this._open = false; this.ctx?.uiBlockers.delete(BLOCKER); }
    this.root.remove();
  }
}
