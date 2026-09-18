import '../styles/music.css';
import type { GameContext, MusicMode, MusicPlayerState } from '@/shared';
import { AUDIO_DEFAULT_BGM, MUSIC_MODE_LABEL_KO, MUSIC_PLAYER_OFF } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/**
 * The music player window (2026-09-14 user's decision) — turning on the gramophone · jukebox · turntable shows the
 * current track's title · artist · volume · progress in a **small window that is always on screen**. **No sound comes
 * out** (`housing/parts/Music` owns the state and this draws that fact — the state arrives as `housing:musicChanged`,
 * and the buttons only call the optional control contract `musicPrev` · `musicNext` · `setMusicMode` · `musicStop`).
 *
 *  - It is visible **only in the personal ship** (`ctx.phase === 'hub'` **+** `ctx.hub?.ship === 'personal'`, 2026-09-16
 *    user's decision). The gramophone · jukebox · turntable are furniture of my own ship, so the window does not appear
 *    in the shared ship (the squad deck) · the hangar. In a raid · the training range · the title housing already turns
 *    the state off, but the phase gate is held once more so that 「the state remained and the window appears」 cannot
 *    happen at all. **The state is not cleared** — only the window hides, and it comes back unchanged on returning to
 *    the personal ship (why docking · undocking are not subscribed to: `update` re-reads `ctx.hub` every frame, so a
 *    changed ship is followed in that frame by itself).
 *  - **With no `housing:musicChanged` ever received it is `MUSIC_PLAYER_OFF` and the window does not appear** (default = off).
 *  - It hides when the menu blocker (`'menu'`) is raised — **the same rule** as `hud/KeyGuide.apply()` (over other
 *    screens such as the inventory · the map it stays up). So its z is above those windows (≤ 80) and below
 *    `.screen-fade` (82) · `.key-guide` (84): **81**.
 *  - When the playlist is empty (not one record was inserted) the window **does** appear and draws the single line
 *    `꽂힌 레코드가 없습니다` (`.is-empty` — a choice made so that 「it was turned on and nothing happened」 never
 *    arises, and this one rule is kept consistent).
 *  - **The four controls** (`◀` previous · `▶` next · playlist ↔ repeat one track · `■` stop) go through `HousingRef`'s
 *    2026-09-14 added contract (`musicPrev` · `musicNext` · `setMusicMode` · `musicStop`). All of them are **optional**,
 *    so they are called with `?.()` and the button is hidden in a build where the method is missing. The whole window is
 *    `pointer-events: none` and **only the buttons are `auto`** (the same rule as `.nb-actions`) — floating over the map ·
 *    the inventory it never blocks the input beneath it.
 *
 * DOM: `#ui-root` direct child `.mus-player(.show)(.is-empty)` > `.mus-body`
 *      (`.mus-head`(`.mus-icon` + `.mus-mode` + `.mus-vol`) + `.mus-title` + `.mus-artist` + `.mus-bar > .mus-fill` +
 *       `.mus-time` + `.mus-actions`(four `.mus-btn`)).
 * Every class carries the `mus-` prefix (a prefix must differ per folder — the `.ct-cell` collision).
 */
export class MusicPlayer {
  readonly root: HTMLElement;
  private modeEl: HTMLElement;
  private volEl: HTMLElement;
  private titleEl: HTMLElement;
  private artistEl: HTMLElement;
  private barEl: HTMLElement;
  private fillEl: HTMLElement;
  private timeEl: HTMLElement;
  private actions: HTMLElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private modeBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;

  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];

  private state: MusicPlayerState = MUSIC_PLAYER_OFF;
  private volume = AUDIO_DEFAULT_BGM;
  private shown = false;
  /** Last rendered text key — the per-frame update only touches the DOM when something actually changed. */
  private lastText = '';
  private lastFill = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'mus-player', parent });
    const body = el('div', { cls: 'mus-body', parent: this.root });
    const head = el('div', { cls: 'mus-head', parent: body });
    el('span', { cls: 'mus-icon', text: '♪', parent: head });
    this.modeEl = el('span', { cls: 'mus-mode', parent: head });
    this.volEl = el('span', { cls: 'mus-vol', parent: head });
    this.titleEl = el('div', { cls: 'mus-title', parent: body });
    this.artistEl = el('div', { cls: 'mus-artist', parent: body });
    this.barEl = el('div', { cls: 'mus-bar', parent: body });
    this.fillEl = el('div', { cls: 'mus-fill', parent: this.barEl });
    this.timeEl = el('div', { cls: 'mus-time', parent: body });
    this.actions = el('div', { cls: 'mus-actions', parent: body });
    this.prevBtn = this.button('◀', '이전 곡', () => this.housing()?.musicPrev?.() ?? false);
    this.nextBtn = this.button('▶', '다음 곡', () => this.housing()?.musicNext?.() ?? false);
    this.modeBtn = this.button(MUSIC_MODE_LABEL_KO.playlist, '재생 방식 전환', () => {
      const next: MusicMode = this.state.mode === 'repeat' ? 'playlist' : 'repeat';
      return this.housing()?.setMusicMode?.(next) ?? false;
    });
    this.modeBtn.classList.add('mus-btn-mode');
    this.stopBtn = this.button('■', '정지', () => this.housing()?.musicStop?.() ?? false);
  }

  /** `ctx.housing` — all four control contract methods are optional, so every call site is always `?.()`. */
  private housing(): GameContext['housing'] { return this.ctx?.housing ?? null; }

  private button(label: string, title: string, run: () => boolean): HTMLButtonElement {
    const btn = el('button', { cls: 'mus-btn', text: label, attrs: { title, type: 'button' }, parent: this.actions });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!run()) return;
      this.ctx?.bus.emit('audio:play', { id: 'ui_click' });
    });
    // The window only floats over the HUD — keeps a focus ring from staying after a button press and eating key input.
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    return btn;
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:musicChanged', ({ state }) => { this.state = state; this.lastText = ''; }),
      // The volume mirrors the **`오디오 › 음악`** value in settings as it is (this window neither makes sound nor changes the volume).
      b.on('audio:volumeChanged', ({ channel, value }) => {
        if (channel !== 'bgm') return;
        this.volume = value;
        this.lastText = '';
      }),
      // Mission reset — housing turns the state off on the same event, but this clears it too rather than leaning on event order.
      b.on('game:newMission', () => this.reset()),
      b.on('game:abort', () => this.reset()),
    );
    if (ctx.audio) this.volume = ctx.audio.settings.bgm ?? AUDIO_DEFAULT_BGM;
    // Binding late never waits for the first `housing:musicChanged` (`HousingRef.getMusicState?`, the 2026-09-14 contract).
    this.state = ctx.housing?.getMusicState?.() ?? MUSIC_PLAYER_OFF;
    // In a build without the control contract that button is hidden outright (no button that does nothing when pressed).
    const h = ctx.housing;
    this.prevBtn.hidden = typeof h?.musicPrev !== 'function';
    this.nextBtn.hidden = typeof h?.musicNext !== 'function';
    this.modeBtn.hidden = typeof h?.setMusicMode !== 'function';
    this.stopBtn.hidden = typeof h?.musicStop !== 'function';
  }

  private reset(): void {
    this.state = MUSIC_PLAYER_OFF;
    this.lastText = '';
  }

  /** Called every frame from `HudSystem.update` — two compares while nothing is playing. */
  update(ctx: GameContext): void {
    const playing = this.state.furnitureUid !== null;
    const menu = ctx.uiBlockers.has('menu');
    // 2026-09-16: personal ship only. `ctx.hub` is null during a mission and `ship` can be null too, so both are read optionally.
    const personalShip = ctx.hub?.ship === 'personal';
    const on = playing && ctx.phase === 'hub' && personalShip && !menu;
    if (on !== this.shown) { this.shown = on; toggleClass(this.root, 'show', on); }
    if (!on) return;

    const track = this.state.track;
    const empty = track === null;
    toggleClass(this.root, 'is-empty', empty);

    const key = `${track?.defId ?? ''}|${this.state.mode}|${this.volume.toFixed(2)}|${this.state.index}|${this.state.playlist.length}`;
    if (key !== this.lastText) {
      this.lastText = key;
      setText(this.modeEl, MUSIC_MODE_LABEL_KO[this.state.mode]);
      setText(this.volEl, `음량 ${Math.round(this.volume * 100)}%`);
      setText(this.titleEl, track ? track.title : '꽂힌 레코드가 없습니다');
      setText(this.artistEl, track ? track.artist : '');
      this.artistEl.hidden = empty;
      this.barEl.hidden = empty;
      this.timeEl.hidden = empty;
      // Buttons: skipping a track needs a playlist, and the mode button prints **the value it would become** (the current one is in the head row).
      const nextMode: MusicMode = this.state.mode === 'repeat' ? 'playlist' : 'repeat';
      setText(this.modeBtn, MUSIC_MODE_LABEL_KO[nextMode]);
      this.modeBtn.title = `${MUSIC_MODE_LABEL_KO[nextMode]}(으)로 전환`;
      this.prevBtn.disabled = empty;
      this.nextBtn.disabled = empty;
    }
    if (empty) return;

    const lengthMs = Math.max(1, track.lengthS * 1000);
    const elapsed = Math.max(0, Math.min(lengthMs, nowMs(ctx) - this.state.startedAt));
    const frac = elapsed / lengthMs;
    if (Math.abs(frac - this.lastFill) > 0.002) {
      this.lastFill = frac;
      this.fillEl.style.width = `${(frac * 100).toFixed(2)}%`;
      setText(this.timeEl, `${clock(elapsed / 1000)} / ${clock(track.lengthS)}`);
    }
  }

  /* ── debug / smoke ── */
  get isShowing(): boolean { return this.shown; }
  get titleText(): string { return this.titleEl.textContent ?? ''; }
  get artistText(): string { return this.artistEl.textContent ?? ''; }
  get volumeText(): string { return this.volEl.textContent ?? ''; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.state = MUSIC_PLAYER_OFF;
    this.root.remove();
  }
}

/**
 * The 「now」 of the progress bar. `startedAt` is epoch ms stamped by housing with `ctx.net.serverNow() ?? Date.now()`,
 * so it is read by the **same contract** here (the same as the growing · culture · analysis screens).
 */
function nowMs(ctx: GameContext): number {
  const net = ctx.net;
  if (net && typeof net.serverNow === 'function') {
    const t = net.serverNow();
    if (Number.isFinite(t) && t > 0) return t;
  }
  return Date.now();
}

/** `m:ss`. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
