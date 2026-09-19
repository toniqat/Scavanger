/**
 * src/housing/ui/gym/GymScreen.ts — **the gym screen** (A-3a, 2026-09-12). One overlay (`.gym`) swaps three screens in:
 *
 *   the intro (`intro`) ─ Space ─▶ the game (`game`) ─ the last judgement ─▶ the result (`result`)
 *
 * **It is a keyboard game, so cursor mode stays off.** Only the blocker (`housing.gym`) goes up, stopping the other systems
 * (movement · interaction · M · inventory), and the input is taken by keydown / keyup listeners in `window`'s capture phase —
 * they read `Keys.JUMP` · `Keys.LEFT` · `Keys.RIGHT` **at use time** and swallow them with `stopImmediatePropagation`, so
 * `Input` never even records the jump. keyup is swallowed **only for a key whose keydown we swallowed** — eating the keyup of
 * a key held since before the screen opened (the D of walking) would leave `Input` believing that key is held forever.
 *
 * Closing: Escape (`ctx.escape` token `housing.gym`) · Tab closes from any screen — mid-game that is a **cancel** (no reward,
 * no debuff). E (`Keys.INTERACT`) closes the intro · the result as the panel contract says, and **mid-game it is only
 * swallowed** (it sits right above cycling's D, so one brush of it must not throw the session away). The key-guide owner is
 * `housing.gym`, and every screen raises its own keys.
 *
 * Time is based on `performance.now()`. **The loop pushes and draws the judge object once per screen frame**
 * (`requestAnimationFrame`) — when a key arrives it is pushed **up to that moment** first, judged, then redrawn on the spot (no judgement late by a tick, no screen out of step with it).
 *
 * 2026-09-12 correction (F): the first build pushed and drew from `setInterval(16 ms)`. While the 3D frame is heavy and
 * input (pointer-lock mouse · keys) keeps arriving, Chrome runs rendering · input tasks ahead of timers, so on 30 ms frames
 * plus an input stream that timer only ran 24 times in 1.6 s (61 ms median · 122 ms worst gap — rAF ran 52). The cursor ·
 * markers skipped 2–4 frames at a time and stuttered, and the key handler pushed the judge object without drawing, so the
 * screen looked as if it jumped at the moment of the key. rAF runs **right before drawing**, so it paints exactly once on
 * every frame that changes. The fallback timer (`FALLBACK_MS`) works only when rAF has stopped (headless · a hidden window).
 *
 * 2026-09-13 (video games, H2): **game mode** (`openGame`) uses the same screen — gym mode (`open`) did not change one letter.
 * Game mode differs in: the judge = `createGymGame(minigame, the disc's tuning)` · the title = the disc name · the subtitle =
 * the console · the kind (`벤치프레스형` …) · the accent colour = the disc's theme colour (it overrides the root's `--c-accent`,
 * so every `.gym-*` follows it, root class `is-game`) · the blocker / ESC / key-guide token `housing.game` · the judgement
 * event `housing:gameBeat` · the end = `parts/VideoGame`'s `completeGameSession` / `endGameSession`.
 * The sounds use the same ids as the gym (`gym_*`).
 */
import type {
  GameContext, GameSessionInfo, GymGameTuning, GymMinigame, GymSessionInfo, GymSessionResult, GymStat, KeyGuideEntry,
} from '@/shared';
import {
  GYM_FATIGUE_LABEL_KO, GYM_MINIGAME_LABEL_KO, GYM_PRESS_REPS, GYM_TRAINED_MAX, Keys, MENU_BLOCKER, formatCompactNumber, formatCompactSigned, keyLabel, paintKeycap,
  renderKeyText,
} from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import { GYM_BLOCKER, completeGymSession, endGymSession } from '../../parts/Gym';
import { GAME_BLOCKER, GAME_MINIGAME_LABEL_KO, completeGameSession, endGameSession } from '../../parts/VideoGame';
import { GYM_QUALITY_LABEL_KO, createGymGame, tunedCount } from '../../parts/GymGames';
import type { GymAction, GymGame, GymQuality } from '../../parts/GymGames';
import { clear, clockText, el, setText, toggleClass } from '../dom';
import { createGymView, replayClass } from './GymViews';
import type { GymNoteLabels, GymView } from './GymViews';
import './gym.css';

export type GymScreenKind = 'intro' | 'game' | 'result';
/** The kind of session the screen is driving — gym equipment · a video game (2026-09-13). */
export type GymScreenMode = 'gym' | 'game';

/** Gym mode's ESC token · key-guide owner (the same text as the blocker `GYM_BLOCKER`). */
const GYM_TOKEN = 'housing.gym';
/** The fallback timer's interval (ms) — it works only while rAF is not running (an implementation value). */
const FALLBACK_MS = 50;
/** A last loop older than this counts as rAF having stopped (ms, an implementation value). */
const FALLBACK_STALE_MS = 100;
/** From the last judgement to the result screen (ms) — a moment to read the last judgement's text (a presentation time). */
const RESULT_DELAY_MS = 700;
/** Game mode's breathing marker text. */
const GAME_NOTE_LABELS: GymNoteLabels = { tap: '톡', hold: '꾹' };
const COLOR_SHAPE = /^#[0-9a-fA-F]{6}$/;

const pct = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 100);
const isField = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
  || (t instanceof HTMLElement && t.isContentEditable);

interface Clock { el: HTMLElement; until: number; format: (s: string) => string; text: string }

/** Everything about one opened session — gym · game split on this one object. */
interface ScreenSpec {
  mode: GymScreenMode;
  /** The gym equipment's uid · the TV's uid. */
  uid: string;
  stat: GymStat;
  minigame: GymMinigame;
  /** The equipment name · the disc name. */
  title: string;
  /** The console name (game mode's subtitle), '' for the gym. */
  consoleName: string;
  /** The game's theme colour `#rrggbb`; null for the gym · for a malformed value. */
  color: string | null;
  tuning: GymGameTuning | undefined;
}

export interface GameScreenOptions {
  title: string;
  color?: string | null;
  tuning?: GymGameTuning;
  consoleName?: string;
}

export class GymScreen {
  readonly root: HTMLElement;
  screen: GymScreenKind | null = null;
  game: GymGame | null = null;
  /** The result of the last finished **gym** session (it survives closing — smoke test). */
  lastResult: GymSessionResult | null = null;
  /** The result of the last finished **game** session (2026-09-13). */
  lastGameResult: GymSessionResult | null = null;
  private spec: ScreenSpec | null = null;
  /** The open mode's blocker · ESC · key-guide token (it survives even when spec is cleared first on close). */
  private token = GYM_TOKEN;
  private card: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  /** The progress bar's fill (2026-09-14 — it replaces the old `N / M` text). */
  private progFill: HTMLElement | null = null;
  private progF = -1;
  private verdict: HTMLElement | null = null;
  private view: GymView | null = null;
  private clocks: Clock[] = [];
  private raf = 0;
  private timer = 0;
  /** The time the judge object was last pushed (`performance.now()`). */
  private last = 0;
  /** The time the loop last ran — the fallback timer looks at it to see whether rAF is alive. */
  private lastLoop = 0;
  private resultAt = 0;
  private finalScore = 0;
  private readonly consumed = new Set<string>();
  private unsubs: Array<() => void> = [];

  constructor(private readonly ctx: GameContext, private readonly sys: HousingSystem) {
    this.root = el('div', { cls: 'gym', parent: ctx.uiRoot });
    this.root.hidden = true;
    this.unsubs.push(ctx.bus.on('input:bindingsChanged', () => this.relabel()));
  }

  get isOpen(): boolean { return this.screen !== null; }
  /** The open screen's mode (null when closed). */
  get mode(): GymScreenMode | null { return this.isOpen && this.spec ? this.spec.mode : null; }
  /** Is the screen loop (rAF · the fallback timer) armed — smoke test (false once closed). */
  get ticking(): boolean { return this.raf !== 0 || this.timer !== 0; }

  /* ── Open · close ────────────────────────────────────────────────────────── */
  /** A gym equipment session (A-3a). */
  open(session: GymSessionInfo, equipName: string): void {
    this.openSpec({ mode: 'gym', uid: session.uid, stat: session.stat, minigame: session.minigame, title: equipName, consoleName: '', color: null, tuning: undefined });
  }

  /** A video-game session (2026-09-13) — the disc name · theme colour · tuning. */
  openGame(info: GameSessionInfo, opts: GameScreenOptions): void {
    const color = typeof opts.color === 'string' && COLOR_SHAPE.test(opts.color) ? opts.color : null;
    this.openSpec({
      mode: 'game', uid: info.tvUid, stat: info.stat, minigame: info.minigame, title: opts.title,
      consoleName: opts.consoleName ?? '', color, tuning: opts.tuning,
    });
  }

  private openSpec(spec: ScreenSpec): void {
    if (this.isOpen) this.teardown();
    this.spec = spec;
    this.token = spec.mode === 'game' ? GAME_BLOCKER : GYM_TOKEN;
    this.game = null;
    if (spec.mode === 'game') this.lastGameResult = null; else this.lastResult = null;
    this.resultAt = 0;
    this.finalScore = 0;
    toggleClass(this.root, 'is-game', spec.mode === 'game');
    if (spec.color) this.root.style.setProperty('--c-accent', spec.color);
    else this.root.style.removeProperty('--c-accent');
    this.ctx.uiBlockers.add(spec.mode === 'game' ? GAME_BLOCKER : GYM_BLOCKER);
    this.ctx.escape.push(this.token, () => this.close());
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    this.root.hidden = false;
    this.showIntro();
    this.startLoop();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** Closes — mid-game that is a cancel. The session end (`housing:gymSession` / `housing:gameSession {active:false}`) is emitted by parts. */
  close(): void {
    if (!this.isOpen) return;
    const mode = this.spec?.mode ?? 'gym';
    this.teardown();
    if (mode === 'game') endGameSession(this.sys);
    else endGymSession(this.sys);
  }

  private teardown(): void {
    const mode = this.spec?.mode ?? 'gym';
    this.stopLoop();
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    this.consumed.clear();
    this.view?.dispose(); this.view = null;
    clear(this.root);
    this.card = this.panel = this.progFill = this.verdict = null;
    this.clocks = [];
    this.root.hidden = true;
    this.root.style.removeProperty('--c-accent');
    toggleClass(this.root, 'is-game', false);
    this.screen = null;
    this.spec = null;
    this.ctx.uiBlockers.delete(mode === 'game' ? GAME_BLOCKER : GYM_BLOCKER);
    this.ctx.escape.remove(this.token);
    this.ctx.bus.emit('ui:keyGuide', { owner: this.token, keys: null });
  }

  dispose(): void {
    this.close();
    this.stopLoop();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }

  /* ── Per-mode end ────────────────────────────────────────────────────────── */
  private complete(score: number): GymSessionResult | null {
    return this.spec?.mode === 'game' ? completeGameSession(this.sys, score) : completeGymSession(this.sys, score);
  }

  private currentResult(): GymSessionResult | null {
    return (this.spec?.mode === 'game' ? this.sys.gameState?.result : this.sys.gymState?.result) ?? null;
  }

  /* ── Loop ────────────────────────────────────────────────────────────────── */
  private startLoop(): void {
    this.stopLoop();
    this.last = this.lastLoop = performance.now();
    this.raf = requestAnimationFrame(this.onFrame);
    this.timer = window.setInterval(this.onFallback, FALLBACK_MS);
  }

  private stopLoop(): void {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  /** Once per screen frame — right before drawing, so it is bound to show this frame. */
  private readonly onFrame = (): void => {
    this.raf = requestAnimationFrame(this.onFrame);
    this.loop();
  };

  /** Only when rAF has stopped (headless · a hidden window) — while it is alive, nothing paints twice in one frame. */
  private readonly onFallback = (): void => {
    if (performance.now() - this.lastLoop < FALLBACK_STALE_MS) return;
    this.loop();
  };

  private loop(): void {
    if (!this.isOpen) { this.stopLoop(); return; }
    this.lastLoop = performance.now();
    this.tick();
    this.paint();
  }

  /* ── Flow ────────────────────────────────────────────────────────────────── */
  /** Intro → game. */
  start(): boolean {
    const s = this.spec;
    if (this.screen !== 'intro' || !s) return false;
    this.clearBody();
    this.game = createGymGame(s.minigame, s.tuning);
    this.screen = 'game';
    const panel = this.panel = el('div', { cls: 'gym-panel', parent: this.root });
    panel.dataset.minigame = s.minigame;
    const head = el('div', { cls: 'gym-head', parent: panel });
    el('div', { cls: 'gym-name', text: `${s.title} · ${this.minigameLabel(s)}`, parent: head });
    // 2026-09-14 (user's decision): one progress bar with no label — the rep text (`N / M`) is gone
    const prog = el('div', { cls: 'gym-prog', parent: head });
    this.progFill = el('i', { cls: 'gym-prog-fill', parent: prog });
    this.progF = -1;
    this.view = createGymView(this.game, panel, s.mode === 'game' ? { labels: GAME_NOTE_LABELS } : {});
    this.verdict = el('div', { cls: 'gym-verdict', parent: panel });
    renderKeyText(el('div', { cls: 'gym-hint', parent: panel }), this.ruleText(s));
    this.last = performance.now();
    this.emitGuide();
    this.paint();
    this.ctx.bus.emit('audio:play', { id: 'gym_start' });
    return true;
  }

  /** Smoke test: skips the game and ends on `score` (from the intro too). */
  finishWith(score: number): GymSessionResult | null {
    if (this.screen !== 'intro' && this.screen !== 'game') return null;
    this.finalScore = Math.max(0, Math.min(1, score));
    const r = this.complete(this.finalScore);
    this.showResult(false);
    return r;
  }

  private tick(): void {
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    const g = this.game;
    if (this.screen !== 'game' || !g) return;
    if (!g.done) { g.update(dt); this.flush(); }
    else if (this.resultAt && now >= this.resultAt) this.showResult(true);
  }

  /** The events the judge object queued → bus · sound · the judgement text. On the last judgement it hands the score over and schedules the result screen. */
  private flush(): void {
    const g = this.game, s = this.spec;
    if (!g || !s) return;
    for (const ev of g.drain()) {
      if (ev.type === 'sound') { this.ctx.bus.emit('audio:play', { id: ev.id }); continue; }
      if (s.mode === 'game') this.ctx.bus.emit('housing:gameBeat', { tvUid: s.uid, quality: ev.quality, index: ev.index, total: ev.total });
      else this.ctx.bus.emit('housing:gymBeat', { uid: s.uid, minigame: s.minigame, quality: ev.quality, index: ev.index, total: ev.total });
      this.ctx.bus.emit('audio:play', { id: `gym_${ev.quality}` });
      this.view?.judged(ev.quality, ev.index);
      this.flash(ev.quality);
    }
    if (g.done && !this.resultAt && this.screen === 'game') {
      this.resultAt = performance.now() + RESULT_DELAY_MS;
      this.finalScore = g.score;
      this.complete(g.score);
    }
  }

  private flash(q: GymQuality): void {
    const v = this.verdict;
    if (!v) return;
    v.textContent = GYM_QUALITY_LABEL_KO[q];
    v.classList.remove('is-perfect', 'is-good', 'is-miss');
    v.classList.add(`is-${q}`);
    replayClass(v, 'show');
  }

  private paint(): void {
    if (this.screen === 'game' && this.game) {
      this.view?.paint();
      if (this.progFill) {
        const f = this.game.completion;
        if (Math.abs(f - this.progF) > 1e-4) { this.progF = f; this.progFill.style.transform = `scaleX(${f.toFixed(4)})`; }
      }
    }
    if (this.clocks.length) {
      const now = this.sys.nowMs();
      for (const c of this.clocks) {
        const left = (c.until - now) / 1000;
        const text = left > 0 ? c.format(clockText(left)) : '';
        if (text !== c.text) { c.text = text; setText(c.el, text); toggleClass(c.el, 'is-gone', !text); }
      }
    }
  }

  /* ── Input ───────────────────────────────────────────────────────────────── */
  private actionOf(code: string): GymAction | null {
    if (code === Keys.JUMP) return 'jump';
    if (code === Keys.LEFT) return 'left';
    if (code === Keys.RIGHT) return 'right';
    return null;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.isOpen || isField(e.target) || this.ctx.uiBlockers.has(MENU_BLOCKER)) return;
    const code = e.code;
    if (code === Keys.INVENTORY || code === Keys.INTERACT) {
      // 2026-09-15: Tab belongs to the topmost screen (the same rule as `housing/ui/Panel` — the `ctx.escape` stack order)
      if (code === Keys.INVENTORY && this.ctx.escape.topKey !== this.token) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (code === Keys.INVENTORY || this.screen !== 'game') this.close();
      return;
    }
    const action = this.actionOf(code);
    if (!action) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.consumed.add(code);
    if (e.repeat) return;
    if (this.screen === 'intro') { if (action === 'jump') this.start(); return; }
    if (this.screen !== 'game' || !this.game) return;
    this.tick();                                   // judge at the **current** time
    this.view?.input(action, true);
    if (this.screen !== 'game' || !this.game) return;
    this.game.press(action);
    this.flush();
    this.paint();                                  // the judged position at once — the old position is never left up until the next frame
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (!this.consumed.has(e.code)) return;
    this.consumed.delete(e.code);
    e.preventDefault();
    e.stopImmediatePropagation();
    const action = this.actionOf(e.code);
    if (!action || this.screen !== 'game' || !this.game) return;
    this.tick();
    this.view?.input(action, false);
    if (this.screen !== 'game' || !this.game) return;
    this.game.release(action);
    this.flush();
    this.paint();
  };

  /* ── Screens ─────────────────────────────────────────────────────────────── */
  private clearBody(): void {
    this.view?.dispose(); this.view = null;
    clear(this.root);
    this.card = this.panel = this.progFill = this.verdict = null;
    this.clocks = [];
  }

  private statName(stat: GymStat): string {
    try { return this.ctx.progression?.getStatDef(stat)?.name ?? stat; } catch { return stat; }
  }

  private minigameLabel(s: ScreenSpec): string {
    return s.mode === 'game' ? GAME_MINIGAME_LABEL_KO[s.minigame] : GYM_MINIGAME_LABEL_KO[s.minigame];
  }

  /**
   * The one-line rule text — 2026-09-15: the key slots are the **tokens** `{JUMP}` · `{LEFT}` · `{RIGHT}` and `renderKeyText` inserts the shared keycaps
   * (a keycap instead of the text `Space` — a mouse glyph once rebound to the mouse). It reads `Keys` while drawing, so a rebind = `relabel()` redraws it.
   */
  private ruleText(s: ScreenSpec): string {
    const kind = s.minigame;
    const reps = tunedCount(Math.round(GYM_PRESS_REPS), s.tuning?.countMul);
    // 벤치프레스 reads the same in both modes — only 호흡 · 사이클 are worded for the screen they are played on (a game disc says 표식, the gym says 발)
    if (kind === 'press') return `커서가 가운데 구역에 들어올 때 {JUMP} — 가운데일수록 좋습니다 (${reps}회)`;
    if (s.mode === 'game') {
      if (kind === 'breath') return '표식이 선에 닿을 때 {JUMP} — 「톡」 은 짧게, 「꾹」 은 꾹 눌렀다가 끝에서 뗍니다';
      return '표식에 맞춰 왼쪽 {LEFT} · 오른쪽 {RIGHT} 을 누릅니다';
    }
    if (kind === 'breath') return '표식이 선에 닿을 때 {JUMP} — 「후」 는 짧게, 「하」 는 꾹 눌렀다가 끝에서 뗍니다';
    return '박자에 맞춰 왼발 {LEFT} · 오른발 {RIGHT} 을 번갈아 밟습니다';
  }

  /**
   * The training bonus · progress as one block (shared by the intro · the result).
   * 2026-09-17 (user's decision): the training number is written as `+N` only. The progress **is the stat-XP bar** itself (the training-only bar
   * is gone — the minigame rule in `ProgressionSystem.addStatXp`). At the cap the bar stops just short of full.
   */
  private trainedBlock(parent: HTMLElement, stat: GymStat, trained: number, progress: number, need: number | null, capped: boolean): void {
    const box = el('div', { cls: 'gym-trained', parent });
    const line = el('div', { cls: 'gym-trained-line', parent: box });
    el('span', { cls: 'gym-trained-stat', text: this.statName(stat), parent: line });
    el('span', { cls: 'gym-trained-val', text: `+${trained}`, parent: line });
    const tail = capped
      ? '단련 최대치'
      : need !== null && need > 0 ? `다음 +1까지 ${formatCompactNumber(Math.round(progress * need))} / ${formatCompactNumber(need)}` : `다음 +1까지 ${pct(progress)} %`;
    el('span', { cls: 'gym-trained-next', text: tail, parent: line });
    const bar = el('div', { cls: 'gym-bar', parent: box });
    el('i', { cls: 'gym-bar-fill', parent: bar }).style.width = `${capped ? 100 : pct(progress)}%`;
  }

  private showIntro(): void {
    const s = this.spec;
    if (!s) return;
    this.clearBody();
    this.screen = 'intro';
    const prog = this.ctx.progression;
    const game = s.mode === 'game';
    const card = this.card = el('div', { cls: 'gym-card gym-intro', parent: this.root });
    el('div', { cls: 'gym-kicker', text: `${game ? '비디오게임' : '헬스장'} · ${this.statName(s.stat)} 단련`, parent: card });
    el('div', { cls: 'gym-title', text: s.title, parent: card });
    el('div', { cls: 'gym-sub', text: game && s.consoleName ? `${s.consoleName} · ${this.minigameLabel(s)}` : this.minigameLabel(s), parent: card });
    const trained = prog?.getTrainedBonus?.(s.stat) ?? 0;
    const need = prog?.trainedXpToNext?.(s.stat) ?? null;
    this.trainedBlock(card, s.stat, trained, prog?.getTrainedProgress?.(s.stat) ?? 0, need, trained >= GYM_TRAINED_MAX);
    renderKeyText(el('div', { cls: 'gym-rule', parent: card }), this.ruleText(s));
    const until = prog?.getGymFatigueUntil?.(s.stat) ?? 0;
    if (until > this.sys.nowMs()) {
      const warn = el('div', { cls: 'gym-warn', parent: card });
      const label = GYM_FATIGUE_LABEL_KO[s.stat], name = this.statName(s.stat);
      const what = game ? '게임' : '운동';
      this.clocks.push({ el: warn, until, text: '-', format: (t) => `${label} — 이번 ${what}으로는 ${name}이 오르지 않습니다 (남은 ${t})` });
    }
    const foot = el('div', { cls: 'gym-foot', parent: card });
    const key = el('span', { cls: 'keycap gym-startkey', parent: foot });
    key.dataset.key = 'jump';
    el('span', { cls: 'gym-foot-label', text: '시작', parent: foot });
    this.relabelKeys();
    this.emitGuide();
    this.paint();
  }

  private showResult(fromGame: boolean): void {
    const s = this.spec;
    if (!s) return;
    const g = fromGame ? this.game : null;
    const counts = g ? g.counts() : null;
    this.clearBody();
    this.screen = 'result';
    this.resultAt = 0;
    const r = this.currentResult();
    if (s.mode === 'game') this.lastGameResult = r; else this.lastResult = r;
    const card = this.card = el('div', { cls: 'gym-card gym-result', parent: this.root });
    el('div', { cls: 'gym-kicker', text: `${s.mode === 'game' ? '게임' : '운동'} 완료 · ${this.minigameLabel(s)}`, parent: card });
    const score = el('div', { cls: 'gym-score', parent: card });
    el('span', { cls: 'gym-score-num', text: String(pct(r?.score ?? this.finalScore)), parent: score });
    el('span', { cls: 'gym-score-unit', text: '%', parent: score });
    if (counts) {
      const row = el('div', { cls: 'gym-counts', parent: card });
      for (const q of ['perfect', 'good', 'miss'] as const) {
        const c = el('span', { cls: `gym-cnt is-${q}`, parent: row });
        el('b', { text: GYM_QUALITY_LABEL_KO[q], parent: c });
        el('span', { text: String(counts[q]), parent: c });
      }
    }
    const name = this.statName(s.stat);
    if (!r) {
      el('div', { cls: 'gym-warn', text: '단련 결과를 반영하지 못했습니다', parent: card });
    } else {
      // 2026-09-16: the XP number uses the shared compact notation (`formatCompactSigned` — 10,000 → `10.0k`). Counts · the training number · the clock stay exact.
      // 2026-09-17: the XP goes into the stat-XP bar (there is no training-only bar) — and the label is that bar's name
      el('div', { cls: 'gym-xp', text: `${name} 경험치 ${formatCompactSigned(r.xp, true)}`, parent: card });
      const gained = r.trainedAfter - r.trainedBefore;
      if (gained > 0) el('div', { cls: 'gym-level', text: `${name} +${gained}!`, parent: card });
      this.trainedBlock(card, s.stat, r.trainedAfter, r.progress, this.ctx.progression?.statXpToNext?.(s.stat) ?? null, r.capped);
      const label = GYM_FATIGUE_LABEL_KO[s.stat];
      if (r.wasFatigued) el('div', { cls: 'gym-warn', text: `${label} 중이라 ${name}이 오르지 않았습니다`, parent: card });
      if (r.fatigueUntil > this.sys.nowMs()) {
        const f = el('div', { cls: 'gym-fatigue', parent: card });
        this.clocks.push({ el: f, until: r.fatigueUntil, text: '-', format: (t) => `${label} · 남은 ${t}` });
      }
    }
    this.emitGuide();
    this.paint();
  }

  /* ── Key names (at use time) ─────────────────────────────────────────────── */
  private relabelKeys(): void {
    for (const k of this.root.querySelectorAll<HTMLElement>('.keycap[data-key]')) {
      const a = k.dataset.key as GymAction;
      paintKeycap(k, a === 'jump' ? Keys.JUMP : a === 'left' ? Keys.LEFT : Keys.RIGHT);   // 2026-09-15: the shared keycap
    }
  }

  private relabel(): void {
    if (!this.isOpen) return;
    this.relabelKeys();
    this.view?.relabel();
    const hint = this.panel?.querySelector<HTMLElement>('.gym-hint');
    if (hint && this.spec) renderKeyText(hint, this.ruleText(this.spec));
    const rule = this.card?.querySelector<HTMLElement>('.gym-rule');
    if (rule && this.spec) renderKeyText(rule, this.ruleText(this.spec));
    this.emitGuide();
  }

  private emitGuide(): void {
    const s = this.spec;
    if (!s || !this.screen) return;
    const J = keyLabel(Keys.JUMP);
    const game = s.mode === 'game';
    let keys: KeyGuideEntry[] = [];
    if (this.screen === 'intro') keys = [{ key: J, label: '시작' }];
    else if (this.screen === 'game') {
      if (s.minigame === 'press') keys = [{ key: J, label: game ? '누르기' : '들어 올리기' }];
      else if (s.minigame === 'breath') keys = game
        ? [{ key: J, label: '톡' }, { key: J, label: '꾹', hold: true }]
        : [{ key: J, label: '후' }, { key: J, label: '하', hold: true }];
      else keys = [{ key: keyLabel(Keys.LEFT), label: game ? '왼쪽' : '왼발' }, { key: keyLabel(Keys.RIGHT), label: game ? '오른쪽' : '오른발' }];
    }
    this.ctx.bus.emit('ui:keyGuide', { owner: this.token, keys });
  }
}
