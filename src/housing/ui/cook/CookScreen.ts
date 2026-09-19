/**
 * src/housing/ui/cook/CookScreen.ts — **the cook overlay** (2026-09-13, `docs/DECISIONS.md` 「2026-09-13 — 요리 미니게임」). One panel at the bottom centre of the screen
 * (`.cook-panel`) swaps its contents per step — it does not cover the screen, so the 3D above it (the pose at the cook bench · the fixed camera, hub) stays visible:
 *
 *   step i ─ with an auto appliance the choice card (`choose`: 「직접 하기」 / 「자동 — 자동 교반기 Lv.2 · 60 %」), without one straight on ─▶
 *           the minigame (`game`) or the auto presentation (`auto`) ─▶ the step-score text (`step`, 0.7 s) ─▶ the next step … ─▶ the result (`result`)
 *
 * The header row = the meal name + the step progress (`① 썰기 ✓ → ② 젓기 …`).
 *
 * **It is a mouse game, so cursor mode goes on** (`setCursorMode(true, 'housing.cook')` — the choice card · the grilling pieces have to be clicked). Input is
 * `pointerdown` on the game stage (`.cook-stage`) (button 0 = left · 2 = right, `preventDefault` blocks the compatibility mouse events) and
 * `window` capture `pointerup` (a release outside the window is taken too), and `contextmenu` over the panel is blocked. When input arrives, the judgement
 * object is pushed **up to that instant** first, then handed the input, and redrawn on the spot.
 *
 * Closing (= cancel, no material consumed — on the result screen a meal already produced is left alone): Escape (`ctx.escape` token `housing.cook`) · Tab (swallowed in
 * capture and `consume(Keys.INVENTORY)` — the inventory does not open on the same key). E closes on the choice card · the result and is only swallowed during a game.
 * Key guide owner `housing.cook`.
 *
 * The loop is exactly `ui/gym/GymScreen`'s 2026-09-12 correction — `requestAnimationFrame` pushes and draws every frame, and the fallback timer works only when
 * rAF has stopped (headless · a hidden window).
 */
import type { CookAutoInfo, CookBeatAction, CookJudge, CookResult, CookSessionInfo, CookStepDef, GameContext, KeyGuideEntry } from '@/shared';
import {
  COOK_CHOP_CUTS, COOK_GAME_ICON, COOK_GAME_LABEL_KO, COOK_JUDGE_LABEL_KO, COOK_LIQUID_LABEL_KO, Keys, MENU_BLOCKER,
  buildItemChip, createKeycap, keyLabel, mealQualityBonus, mealQualityStars,
} from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import { COOK_BLOCKER, applyCookStepBonus, completeCookRun, cookStepBonus, endCook, recordCookStep, restartBlock, restartCook } from '../../parts/Cooking';
import type { CookStepBonus } from '../../parts/Cooking';
import { createCookGame } from '../../parts/CookGames';
import type { AnyCookGame, CookButton } from '../../parts/CookGames';
import { mealEffectLines, mealTierText, qualityName } from '../DiningTable';
import { askReplacePlate, closePlateAsk } from './PlateAsk';
import { clear, el, setText, toggleClass } from '../dom';
import { createCookView, replayCookClass } from './CookViews';
import type { CookView } from './CookViews';
import './cook.css';

export type CookScreenKind = 'choose' | 'game' | 'auto' | 'step' | 'result';

const ESCAPE_TOKEN = 'housing.cook';
const GUIDE_OWNER = 'housing.cook';
/** The fallback timer interval · how long before rAF counts as stopped (ms, implementation values — the same as GymScreen). */
const FALLBACK_MS = 50;
const FALLBACK_STALE_MS = 100;
/** How long the step-score text shows (ms, presentation — the design's 「0.7 초」). */
const STEP_SCORE_MS = 700;
/** How long the auto appliance's presentation takes to handle a step (ms, presentation — unrelated to the score). */
const AUTO_MS = 1100;
const CIRCLED = ['①', '②', '③', '④', '⑤'];
/** The minimum interval between the stirring scrape sounds (`cook_stir`) (ms) — the presentation's `stir` comes more densely, for hub's ladle (an implementation value). */
const STIR_SOUND_MIN_MS = 450;

/** Presentation input → sound (`audio:play`). `pour_stop` has no sound. */
const BEAT_SOUND: Partial<Record<CookBeatAction, string>> = {
  cut: 'cook_chop', mince_h: 'cook_mince', mince_v: 'cook_mince', flip: 'cook_flip', remove: 'cook_remove', burn: 'cook_burn',
  toss: 'cook_toss', stir: 'cook_stir', pour_start: 'cook_pour',
};

const pct = (v: number): number => Math.round(Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)) * 100);

/** The cooking guidance's button tokens → the real mouse button codes (2026-09-15). */
const RULE_MOUSE: Readonly<Record<string, string>> = { L: 'Mouse0', R: 'Mouse2' };

/**
 * 2026-09-15: refills `host` with the `{L}` · `{R}` tokens fitted with the shared keycap (the mouse glyph, `kc-inline`). Text goes in as text nodes only.
 * (`renderKeyText` takes `Keys` action tokens, so the real left / right buttons, which are rebind-independent, are drawn separately here.)
 */
function renderMouseRule(host: HTMLElement, text: string): void {
  host.textContent = '';
  const re = /\{([LR])\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) host.appendChild(document.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    createKeycap(RULE_MOUSE[m[1]], { cls: 'kc-inline', parent: host });
  }
  if (last < text.length) host.appendChild(document.createTextNode(text.slice(last)));
}

/** 2026-09-13 (H3): where the bonus came from — `(+요리 숙련 · 서재)`, an empty string with none. */
function bonusSourcesText(b: CookStepBonus | undefined): string {
  if (!b || !(b.total > 0)) return '';
  const names = [b.skill > 0 ? '요리 숙련' : '', b.library > 0 ? '서재' : ''].filter(Boolean);
  return names.length ? `(+${names.join(' · ')})` : '';
}
/** 2026-09-13 (H3): the bonus numbers — `요리 숙련 +8 · 서재 +4` (the hover title). */
function bonusDetailText(b: CookStepBonus | undefined): string {
  if (!b || !(b.total > 0)) return '';
  const parts: string[] = [];
  if (b.skill > 0) parts.push(`요리 숙련 +${Math.round(b.skill * 100)}`);
  if (b.library > 0) parts.push(`서재 +${Math.round(b.library * 100)}`);
  return parts.join(' · ');
}
const isField = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
  || (t instanceof HTMLElement && t.isContentEditable);
const buttonOf = (b: number): CookButton | null => (b === 0 ? 'left' : b === 2 ? 'right' : null);

export class CookScreen {
  readonly root: HTMLElement;
  screen: CookScreenKind | null = null;
  game: AnyCookGame | null = null;
  stepIndex = 0;
  /** The result of the last finished run (it survives closing — smoke tests). */
  lastResult: CookResult | null = null;
  private opened = false;
  private info: CookSessionInfo | null = null;
  private readonly panel: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly stepsEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly verdict: HTMLElement;
  private readonly stepScoreEl: HTMLElement;
  /** The step progress bar (2026-09-14, user's decision 「라벨 없이 바만」). */
  private readonly progBar: HTMLElement;
  private readonly progFill: HTMLElement;
  private progF = -1;
  private readonly hint: HTMLElement;
  private view: CookView | null = null;
  private autoInfo: CookAutoInfo | null = null;
  private autoBar: HTMLElement | null = null;
  private autoStart = 0;
  private autoEndAt = 0;
  private advanceAt = 0;
  private raf = 0;
  private timer = 0;
  private last = 0;
  private lastLoop = 0;
  private lastStirSound = 0;
  private readonly down = new Set<CookButton>();

  constructor(private readonly ctx: GameContext, private readonly sys: HousingSystem) {
    // 2026-09-17: the root is `.cook-ovl` — the old name `.cook` collided with the grenade cook gauge in `ui/styles/base.css` (`opacity: 0` · a 120 px box), so
    // with the session · blocker · DOM all alive the overlay became **a transparent 120 px box** and the minigame was never once visible
    this.root = el('div', { cls: 'cook-ovl', parent: ctx.uiRoot });
    this.root.hidden = true;
    this.panel = el('div', { cls: 'cook-panel', parent: this.root });
    const head = el('div', { cls: 'cook-head', parent: this.panel });
    this.nameEl = el('div', { cls: 'cook-name', parent: head });
    this.stepsEl = el('div', { cls: 'cook-steps', parent: head });
    this.body = el('div', { cls: 'cook-body', parent: this.panel });
    this.verdict = el('div', { cls: 'cook-verdict', parent: this.panel });
    this.stepScoreEl = el('div', { cls: 'cook-stepscore', parent: this.panel });
    this.progBar = el('div', { cls: 'cook-prog', parent: this.panel });
    this.progFill = el('i', { cls: 'cook-prog-fill', parent: this.progBar });
    this.hint = el('div', { cls: 'cook-hint', parent: this.panel });
    // 2026-09-14: the area where right-click (mincing) must not open the browser menu is the same as **the area that takes input** — the whole overlay
    this.root.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    // so a click inside the panel does not reach the canvas's click-to-lock fallback
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('pointerdown', this.onPointerDown);
  }

  get isOpen(): boolean { return this.opened; }
  /** Whether the screen loop (rAF · the fallback timer) is running — smoke tests (false once closed). */
  get ticking(): boolean { return this.raf !== 0 || this.timer !== 0; }

  /* ── Open · close ────────────────────────────────────────────────────────── */
  /** Opens the overlay — the steps do not start yet (`beginSteps`, which `parts/Cooking.startCook` calls after the session event). */
  open(info: CookSessionInfo, mealName: string): void {
    if (this.opened) this.teardown();
    this.opened = true;
    this.info = info;
    this.stepIndex = 0;
    this.game = null;
    this.screen = null;
    this.lastResult = null;
    this.ctx.uiBlockers.add(COOK_BLOCKER);
    this.ctx.escape.push(ESCAPE_TOKEN, () => this.close());
    this.ctx.input.setCursorMode(true, COOK_BLOCKER);
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('pointerup', this.onPointerUp, true);
    setText(this.nameEl, mealName);
    this.root.hidden = false;
    replayCookClass(this.panel, 'is-in');
    this.startLoop();
  }

  /** From the first step. */
  beginSteps(): void {
    if (!this.opened || !this.info) return;
    this.stepIndex = 0;
    this.beginStep();
  }

  /** Closes — before the result that is a cancel. The session end (`housing:cookSession {active:false}`) is emitted by `endCook`. */
  close(): void {
    if (!this.opened) return;
    this.teardown();
    endCook(this.sys);
  }

  private teardown(): void {
    closePlateAsk(this.sys);                // 2026-09-16: when it closes with the 「다시 만들기」 warning up, the warning is taken down without confirming
    this.stopLoop();
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('pointerup', this.onPointerUp, true);
    this.clearBody();
    this.down.clear();
    this.root.hidden = true;
    this.opened = false;
    this.screen = null;
    this.game = null;
    this.info = null;
    this.autoInfo = null;
    this.ctx.uiBlockers.delete(COOK_BLOCKER);
    this.ctx.escape.remove(ESCAPE_TOKEN);
    this.ctx.input.setCursorMode(false, COOK_BLOCKER);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: null });
  }

  dispose(): void {
    this.close();
    this.stopLoop();
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.remove();
  }

  /* ── The loop ────────────────────────────────────────────────────────────── */
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

  private readonly onFrame = (): void => {
    this.raf = requestAnimationFrame(this.onFrame);
    this.loop();
  };

  private readonly onFallback = (): void => {
    if (performance.now() - this.lastLoop < FALLBACK_STALE_MS) return;
    this.loop();
  };

  private loop(): void {
    if (!this.opened) { this.stopLoop(); return; }
    this.lastLoop = performance.now();
    this.tick();
    this.paint();
  }

  /* ── The flow ────────────────────────────────────────────────────────────── */
  private tick(): void {
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (this.screen === 'game' && this.game) {
      if (!this.game.done) this.game.update(dt);
      this.flush();
    } else if (this.screen === 'auto') {
      if (now >= this.autoEndAt) this.finishStep(this.autoInfo?.score ?? 0, true);
    } else if (this.screen === 'step') {
      if (now >= this.advanceAt) this.advance();
    }
  }

  private currentStep(): CookStepDef | null {
    return this.info?.steps[this.stepIndex] ?? null;
  }

  private beginStep(): void {
    const info = this.info;
    const step = this.currentStep();
    if (!info || !step) return;
    this.clearBody();
    this.game = null;
    this.autoInfo = null;
    this.resetProgress();
    const auto = this.sys.getCookAuto(step.game);
    if (auto) this.showChoose(step, auto);
    else this.play(step);
  }

  /** The choice card → manual / auto. false when it is not the choice card. */
  choose(mode: 'manual' | 'auto'): boolean {
    const step = this.currentStep();
    if (this.screen !== 'choose' || !step) return false;
    if (mode === 'auto' && this.autoInfo) this.startAuto(step);
    else this.play(step);
    return true;
  }

  private showChoose(step: CookStepDef, auto: CookAutoInfo): void {
    const info = this.info!;
    this.screen = 'choose';
    this.autoInfo = auto;
    const card = el('div', { cls: 'cook-choose', parent: this.body });
    el('div', { cls: 'cook-choose-title', text: `${CIRCLED[this.stepIndex] ?? ''} ${COOK_GAME_ICON[step.game]} ${COOK_GAME_LABEL_KO[step.game]}`, parent: card });
    el('div', { cls: 'cook-choose-sub', text: this.stepDetail(step), parent: card });
    const row = el('div', { cls: 'cook-choose-row', parent: card });
    this.button(row, '직접 하기', () => this.choose('manual'), 'primary cook-choose-manual');
    const name = this.applianceName(auto);
    const bonus = cookStepBonus(this.sys, step.game);           // 2026-09-13 (H3): an auto step gets the cooking skill · library bonus too
    const autoBtn = this.button(row, `자동 — ${name} Lv.${auto.level} · ${pct(auto.score)} %${bonus.total > 0 ? ` (+${Math.round(bonus.total * 100)})` : ''}`,
      () => this.choose('auto'), 'cook-choose-auto');
    if (bonus.total > 0) autoBtn.title = bonusDetailText(bonus);
    setText(this.hint, `자동으로 넘기면 이 단계 점수는 ${name}의 레벨로 정해집니다 — 강화할수록 높아집니다`);
    this.paintHead();
    this.ctx.bus.emit('housing:cookStep', { uid: info.uid, index: this.stepIndex, total: info.steps.length, game: step.game, phase: 'choose', auto: false, score: null });
    this.emitGuide();
  }

  private play(step: CookStepDef): void {
    const info = this.info!;
    this.clearBody();
    const game = this.game = createCookGame(step);
    this.view = createCookView(game, this.body, (id) => this.sys.defOf(id));
    this.screen = 'game';
    this.down.clear();
    this.last = performance.now();
    renderMouseRule(this.hint, this.ruleText(step));
    this.paintHead();
    this.ctx.bus.emit('housing:cookStep', { uid: info.uid, index: this.stepIndex, total: info.steps.length, game: step.game, phase: 'play', auto: false, score: null });
    this.emitGuide();
    this.flush();
    this.paint();
  }

  private startAuto(step: CookStepDef): void {
    const info = this.info!;
    const auto = this.autoInfo!;
    this.clearBody();
    this.screen = 'auto';
    const box = el('div', { cls: 'cook-auto', parent: this.body });
    el('div', { cls: 'cook-auto-glyph', text: COOK_GAME_ICON[step.game], parent: box });
    el('div', { cls: 'cook-auto-name', text: `${this.applianceName(auto)} Lv.${auto.level} — ${COOK_GAME_LABEL_KO[step.game]} 자동 처리 중`, parent: box });
    const bar = this.autoBar = el('div', { cls: 'cook-hbar cook-auto-bar', parent: box });
    el('i', { cls: 'cook-hbar-fill', parent: bar });
    const bonus = cookStepBonus(this.sys, step.game);           // 2026-09-13 (H3)
    el('div', {
      cls: 'cook-auto-score',
      text: bonus.total > 0
        ? `단계 점수 ${pct(auto.score)} → ${pct(applyCookStepBonus(auto.score, bonus))} % ${bonusSourcesText(bonus)}`
        : `단계 점수 ${pct(auto.score)} %`,
      parent: box,
    });
    this.autoStart = performance.now();
    this.autoEndAt = this.autoStart + AUTO_MS;
    setText(this.hint, '');
    this.paintHead();
    this.ctx.bus.emit('housing:cookStep', { uid: info.uid, index: this.stepIndex, total: info.steps.length, game: step.game, phase: 'play', auto: true, score: null });
    this.ctx.bus.emit('audio:play', { id: 'cook_auto' });
    this.emitGuide();
    this.paint();
  }

  /** The events the judgement object piled up → the bus · sounds · the judgement text. Finishes the step when the game is over. */
  private flush(): void {
    const g = this.game, info = this.info;
    if (!g || !info) return;
    for (const ev of g.drain()) {
      if (ev.type === 'sound') { this.ctx.bus.emit('audio:play', { id: ev.id }); continue; }
      if (ev.type === 'beat') {
        this.ctx.bus.emit('housing:cookBeat', { uid: info.uid, game: g.game, action: ev.action, quality: ev.quality });
        const snd = BEAT_SOUND[ev.action];
        const now = performance.now();
        const throttled = ev.action === 'stir' && now - this.lastStirSound < STIR_SOUND_MIN_MS;
        if (snd && !throttled) {
          if (ev.action === 'stir') this.lastStirSound = now;
          this.ctx.bus.emit('audio:play', { id: snd });
        }
        this.view?.beat(ev.action, ev.quality);
        continue;
      }
      this.ctx.bus.emit('audio:play', { id: `cook_${ev.quality}` });
      this.view?.judged(ev.quality, ev.index);
      this.flash(ev.quality);
    }
    if (g.done && this.screen === 'game') this.finishStep(g.score, false);
  }

  private finishStep(score: number, auto: boolean): void {
    const info = this.info;
    const step = this.currentStep();
    if (!info || !step) return;
    const raw = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
    // 2026-09-13 (H3): the place that writes it returns the cooking skill · library bonus added and clamped to 1 — the event · the quality use that value
    const s = recordCookStep(this.sys, this.stepIndex, raw, auto);
    const bonus = this.sys.cookState?.stepBonus[this.stepIndex];
    this.screen = 'step';
    this.down.clear();
    this.advanceAt = performance.now() + STEP_SCORE_MS;
    this.ctx.bus.emit('housing:cookStep', { uid: info.uid, index: this.stepIndex, total: info.steps.length, game: step.game, phase: 'done', auto, score: s });
    this.ctx.bus.emit('audio:play', { id: 'cook_step' });
    clear(this.stepScoreEl);
    const label = `${auto ? '자동 · ' : ''}${COOK_GAME_LABEL_KO[step.game]}`;
    if (bonus && bonus.total > 0) {
      el('span', { text: `${label} ${pct(raw)} → ${pct(s)} %`, parent: this.stepScoreEl });
      el('small', { cls: 'cook-stepscore-bonus', text: bonusSourcesText(bonus), parent: this.stepScoreEl });
    } else {
      el('span', { text: `${label} ${pct(s)} %`, parent: this.stepScoreEl });
    }
    replayCookClass(this.stepScoreEl, 'show');
    this.paintHead();
    this.emitGuide();
  }

  private advance(): void {
    const info = this.info;
    if (!info) return;
    this.stepIndex++;
    if (this.stepIndex < info.steps.length) this.beginStep();
    else this.completeRun();
  }

  private completeRun(): void {
    const r = completeCookRun(this.sys);
    this.lastResult = r;
    this.showResult(r);
  }

  /** Smoke tests: ends the current step with `score` and moves straight on to the next step (or the result) — it does not wait for the step-score text. */
  finishStepWith(score: number): boolean {
    if (!this.opened) return false;
    if (this.screen === 'choose' || this.screen === 'game' || this.screen === 'auto') {
      this.finishStep(score, this.screen === 'auto');
      this.advance();
      return true;
    }
    if (this.screen === 'step') { this.advance(); return true; }
    return false;
  }

  /**
   * The result screen's 「다시 만들기」 — a Korean reason / null.
   * 2026-09-16 (the plate model, user's decision): the meal just made is on the dining table, so **before making it again** the 「식탁의 요리를 바꿉니다」 warning goes up
   * (null then — it starts again once confirmed). `skipAsk` = a confirm that has passed the warning.
   */
  restart(skipAsk = false): string | null {
    if (this.screen !== 'result') return '결과 화면이 아닙니다';
    const block = restartBlock(this.sys);
    if (!block && !skipAsk && this.info && askReplacePlate(this.sys, this.info.mealDefId, () => { if (this.opened && this.screen === 'result') this.restart(true); })) {
      return null;
    }
    const reason = restartCook(this.sys);
    if (reason) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: reason, kind: 'warning' });
      return reason;
    }
    this.stepIndex = 0;
    this.beginStep();
    return null;
  }

  /* ── The result ──────────────────────────────────────────────────────────── */
  private showResult(r: CookResult | null): void {
    const info = this.info;
    if (!info) return;
    this.clearBody();
    this.game = null;
    this.screen = 'result';
    this.down.clear();
    setText(this.hint, '');
    this.paintHead();
    const card = el('div', { cls: 'cook-result', parent: this.body });
    const main = el('div', { cls: 'cook-result-main', parent: card });
    const q = r?.quality ?? 0;
    el('div', { cls: `cook-stars q-${q}`, text: mealQualityStars(q), parent: main });
    const score = el('div', { cls: 'cook-score', parent: main });
    el('span', { cls: 'cook-score-num', text: String(pct(r?.score ?? 0)), parent: score });
    el('span', { cls: 'cook-score-unit', text: '%', parent: score });
    el('div', { cls: 'cook-bonus', text: `능력치 +${Math.round(mealQualityBonus(q) * 100)} %`, parent: main });
    const steps = el('div', { cls: 'cook-result-steps', parent: main });
    const st = this.sys.cookState;
    info.steps.forEach((s, i) => {
      const row = el('div', { cls: 'cook-result-step', parent: steps });
      el('span', { text: `${CIRCLED[i] ?? ''} ${COOK_GAME_LABEL_KO[s.game]}${r?.stepAuto[i] ? ' · 자동' : ''}`, parent: row });
      // 2026-09-13 (H3): a step with a bonus reads `72 → 84 % (+요리 숙련 · 서재)`, hover = the numbers
      const bonus = st?.stepBonus[i];
      const final = r?.stepScores[i] ?? 0;
      if (bonus && bonus.total > 0 && st) {
        row.classList.add('has-bonus');
        row.title = bonusDetailText(bonus);
        const val = el('b', { text: `${pct(st.stepRaw[i] ?? final)} → ${pct(final)} %`, parent: row });
        el('i', { cls: 'cook-result-step-bonus', text: ` ${bonusSourcesText(bonus)}`, parent: val });
      } else {
        el('b', { text: `${pct(final)} %`, parent: row });
      }
    });

    const meal = el('div', { cls: 'cook-result-meal', parent: card });
    const def = this.sys.mealDef(info.mealDefId);
    const chipWrap = el('div', { cls: 'cook-result-chip', parent: meal });
    chipWrap.appendChild(buildItemChip(def ?? undefined, { size: 56 }));
    if (q > 0) el('span', { cls: 'cook-qbadge', text: `★${q}`, parent: chipWrap });
    const text = el('div', { cls: 'cook-result-text', parent: meal });
    el('div', { cls: 'cook-result-name', text: def?.meal ? `${def.name} · ${mealTierText(def.meal)}` : def?.name ?? info.mealDefId, parent: text });
    if (def?.meal) el('div', { cls: 'cook-result-effects', text: mealEffectLines(def.meal, q).join('\n'), parent: text });
    // 2026-09-16 (the plate model): the meal is set on the dining table — an old plate that was replaced gets a line too
    if (r && !r.reason) {
      const landed = r.landed === 'bag' ? '가방' : r.landed === 'stash' ? '함선 창고' : '식탁에 차렸습니다';
      el('div', { cls: 'cook-landed', text: `→ ${landed}`, parent: text });
      if (r.replaced) {
        const old = qualityName(this.sys.mealDef(r.replaced.mealDefId)?.name ?? r.replaced.mealDefId, r.replaced.quality);
        el('div', { cls: 'cook-landed cook-replaced', text: `「${old}」 을(를) 치웠습니다`, parent: text });
      }
    }
    else el('div', { cls: 'cook-warn', text: r?.reason ?? '요리를 완성하지 못했습니다', parent: text });

    const foot = el('div', { cls: 'cook-result-foot', parent: card });
    const again = restartBlock(this.sys);
    const againBtn = this.button(foot, '다시 만들기', () => this.restart(), 'cook-again');
    toggleClass(againBtn, 'is-blocked', !!again);
    if (again) el('div', { cls: 'cook-again-reason', text: again, parent: foot });
    this.button(foot, '닫기', () => this.close(), 'primary cook-close');
    this.emitGuide();
  }

  /* ── Drawing ─────────────────────────────────────────────────────────────── */
  private clearBody(): void {
    this.view?.dispose();
    this.view = null;
    this.autoBar = null;
    clear(this.body);
  }

  private paint(): void {
    if ((this.screen === 'game' || this.screen === 'step') && this.view) this.view.paint();
    let auto = 0;
    if (this.screen === 'auto' && this.autoBar) {
      auto = Math.max(0, Math.min(1, (performance.now() - this.autoStart) / AUTO_MS));
      this.autoBar.style.setProperty('--f', auto.toFixed(3));
    }
    // only during a game does the whole overlay take input (so it does not cover the choice card · result buttons)
    toggleClass(this.root, 'is-playing', this.screen === 'game');
    this.paintProgress(auto);
  }

  /** The step progress bar — the fill only, no text (CSS follows with ease-out). On the choice card · the result the bar itself is hidden. */
  private paintProgress(auto: number): void {
    const on = this.screen === 'game' || this.screen === 'auto' || this.screen === 'step';
    toggleClass(this.progBar, 'is-off', !on);
    let f = 0;
    if (this.screen === 'game' && this.game) f = this.game.completion;
    else if (this.screen === 'auto') f = auto;
    else if (this.screen === 'step') f = 1;
    if (Math.abs(f - this.progF) <= 1e-4) return;
    this.progF = f;
    this.progFill.style.transform = `scaleX(${Math.max(0, Math.min(1, f)).toFixed(4)})`;
  }

  /** A new step restarts the bar from 0 (the transition is turned off for one frame so the rewind is not seen). */
  private resetProgress(): void {
    this.progF = 0;
    this.progFill.style.transition = 'none';
    this.progFill.style.transform = 'scaleX(0)';
    void this.progFill.offsetWidth;
    this.progFill.style.transition = '';
  }

  /** The header row's step progress — `① 썰기 ✓ → ② 젓기 …`. */
  private paintHead(): void {
    const info = this.info;
    clear(this.stepsEl);
    if (!info) return;
    const st = this.sys.cookState;
    const result = this.screen === 'result';
    info.steps.forEach((s, i) => {
      if (i > 0) el('span', { cls: 'cook-steps-arrow', text: '→', parent: this.stepsEl });
      const recorded = !!st && st.stepScores[i] !== undefined;
      const done = recorded && (i < this.stepIndex || result || (i === this.stepIndex && this.screen === 'step'));
      const now = !result && i === this.stepIndex && !done;
      const item = el('span', { cls: `cook-steps-item${now ? ' is-now' : ''}${done ? ' is-done' : ''}`, parent: this.stepsEl });
      item.textContent = `${CIRCLED[i] ?? ''} ${COOK_GAME_LABEL_KO[s.game]}${done ? ' ✓' : now ? ' …' : ''}`;
    });
  }

  private flash(q: CookJudge): void {
    const v = this.verdict;
    v.textContent = COOK_JUDGE_LABEL_KO[q];
    v.classList.remove('is-perfect', 'is-good', 'is-miss');
    v.classList.add(`is-${q}`);
    replayCookClass(v, 'show');
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, cls: string): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${cls}`.trim(), text: label, parent });
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); onClick(); });
    return b;
  }

  private applianceName(auto: CookAutoInfo): string {
    return this.sys.getFurnitureDef(auto.defId)?.name ?? '자동 조리 가구';
  }

  private stepDetail(step: CookStepDef): string {
    if (step.game === 'pour') return `${COOK_LIQUID_LABEL_KO[step.liquid ?? 'water'] ?? ''} ${Math.round(step.targetMl ?? 0)} ml 를 붓습니다`;
    if (step.game === 'stir') return '냄비를 저어 온도를 지킵니다';
    const names = [...new Set(step.items)].map((id) => this.sys.nameOf(id));
    return names.length ? `재료: ${names.join(' · ')}` : '';
  }

  /**
   * One line of step guidance. 2026-09-15 (user's decision — the mouse glyph everywhere a keycap appears): the button to press is a `{L}` (left) · `{R}` (right) token and
   * `renderMouseRule` fits the shared keycap's mouse glyph in. Cooking input is not `Keys.FIRE` but **the real left / right buttons**
   * (`CookButton`), so `renderKeyText`'s `{ACTION}` tokens are not used. Grilling is 「pressing a piece」, so it is left as text with no button glyph.
   */
  private ruleText(step: CookStepDef): string {
    switch (step.game) {
      case 'chop': return `표식이 선에 닿을 때 {L} — ${Math.round(COOK_CHOP_CUTS)}번 썹니다. 박자 밖의 헛클릭은 다음 칼질의 실패입니다`;
      case 'mince': return '{L} = 좌우 게이지 · {R} = 상하 게이지. 같은 버튼만 연달아 누르면 반대쪽이 줄어듭니다 — 번갈아 빠르게';
      case 'grill': return '익어 가는 조각을 50 % 에서 클릭해 뒤집고, 100 % 에서 한 번 더 클릭해 꺼냅니다 — 늦으면 탑니다';
      case 'stirfry': return '링이 팬에 닿을 때 {L} — 맞출수록 많이 볶이고, 틀려도 조금은 볶입니다';
      case 'stir': return '{L} 을 누르고 있으면 저으며 온도가 내려가고, 떼면 올라갑니다 — 온도를 초록 구간에 두세요';
      default: return `{L} 을 누르고 있으면 붓습니다 — ${COOK_LIQUID_LABEL_KO[step.liquid ?? 'water'] ?? ''} ${Math.round(step.targetMl ?? 0)} ml 를 맞추고 손을 떼면 잠시 뒤 끝납니다`;
    }
  }

  private emitGuide(): void {
    if (!this.opened) return;
    let keys: KeyGuideEntry[] = [];
    const g = this.screen === 'game' ? this.game : null;
    if (g) {
      const L = keyLabel('Mouse0'), R = keyLabel('Mouse2');
      switch (g.game) {
        case 'chop': keys = [{ key: L, label: '썰기' }]; break;
        case 'mince': keys = [{ key: L, label: '좌우로 다지기' }, { key: R, label: '위아래로 다지기' }]; break;
        case 'grill': keys = [{ key: L, label: '조각 뒤집기 · 꺼내기' }]; break;
        case 'stirfry': keys = [{ key: L, label: '볶기' }]; break;
        case 'stir': keys = [{ key: L, label: '젓기', hold: true }]; break;
        default: keys = [{ key: L, label: '붓기', hold: true }]; break;
      }
    }
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys });
  }

  /* ── Input ───────────────────────────────────────────────────────────────── */
  /**
   * 2026-09-14 (user's decision): minigame input is taken **anywhere on the screen**. It used to be taken only inside `.cook-stage` (a small box in the middle of the
   * panel), so pressing the margin of the 780 px panel did nothing — the gym is keyboard, so it never had the problem. Only during a game does the root take input
   * (`.cook-ovl.is-playing`), so the choice card · result screen buttons still press.
   */
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.opened || this.screen !== 'game' || !this.game) return;
    const target = e.target as Element | null;
    if (target?.closest?.('button')) return;                 // there is no button during a game, but if there is one the button wins
    const button = buttonOf(e.button);
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    this.tick();                                   // the judgement runs from **this** instant
    if (this.screen !== 'game' || !this.game) return;
    this.down.add(button);
    this.view?.input(button, true);
    const piece = target?.closest?.<HTMLElement>('.cook-piece[data-i]') ?? null;
    if (piece && button === 'left') this.game.clickPiece(Number(piece.dataset.i));
    else this.game.press(button);
    this.flush();
    this.paint();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const button = buttonOf(e.button);
    if (!button || !this.down.has(button)) return;
    this.down.delete(button);
    if (!this.opened || this.screen !== 'game' || !this.game) return;
    this.tick();
    if (this.screen !== 'game' || !this.game) return;
    this.view?.input(button, false);
    this.game.release(button);
    this.flush();
    this.paint();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.opened || isField(e.target) || this.ctx.uiBlockers.has(MENU_BLOCKER)) return;
    const code = e.code;
    if (code !== Keys.INVENTORY && code !== Keys.INTERACT) return;
    // 2026-09-16: the 「식탁의 요리를 바꿉니다」 warning is up above — E · Tab belong to the warning, not the overlay (cancel)
    if (this.sys.plateAsk?.handle.isOpen) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (code === Keys.INVENTORY) this.ctx.input.consume(Keys.INVENTORY);
      if (!e.repeat) this.sys.plateAsk.handle.cancel();
      return;
    }
    // 2026-09-15: Tab belongs to **the topmost screen** on the `ctx.escape` stack — it is not intercepted while a window opened later above this one (the
    // the infinite box · the inventory) is there (the same rule as `housing/ui/Panel`).
    if (code === Keys.INVENTORY && this.ctx.escape.topKey !== ESCAPE_TOKEN) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (code === Keys.INVENTORY) this.ctx.input.consume(Keys.INVENTORY);
    if (e.repeat) return;
    if (code === Keys.INVENTORY || this.screen === 'choose' || this.screen === 'result') this.close();
  };
}
