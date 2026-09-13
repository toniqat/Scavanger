/**
 * src/housing/ui/cook/CookScreen.ts — **조리 오버레이** (2026-09-13, `docs/plans/cooking-minigames.md` §6-1). 화면 하단 가운데 패널 하나
 * (`.cook-panel`)가 단계마다 내용을 갈아 끼운다 — 위쪽 3D(조리대 앞 자세 · 고정 카메라, hub)가 보이게 화면을 덮지 않는다:
 *
 *   단계 i ─ 자동 가구가 있으면 선택 카드(`choose`: 「직접 하기」 / 「자동 — 자동 교반기 Lv.2 · 60 %」), 없으면 곧장 ─▶
 *           미니게임(`game`) 또는 자동 연출(`auto`) ─▶ 단계 점수 글자(`step`, 0.7 초) ─▶ 다음 단계 … ─▶ 결과(`result`)
 *
 * 머리줄 = 요리 이름 + 단계 진행(`① 썰기 ✓ → ② 젓기 …`).
 *
 * **마우스 게임이라 커서 모드를 켠다** (`setCursorMode(true, 'housing.cook')` — 선택 카드 · 굽기 조각을 클릭해야 한다). 입력은
 * 게임 무대(`.cook-stage`)의 `pointerdown`(button 0 = 좌 · 2 = 우, `preventDefault` 로 호환 mouse 이벤트를 막는다)과
 * `window` capture `pointerup`(창 밖에서 뗀 것도 받는다)이고, 패널 위 `contextmenu` 는 막는다. 입력이 오면 **그 순간까지**
 * 판정 객체를 먼저 민 뒤 넘기고 그 자리에서 다시 그린다.
 *
 * 닫기(= 취소, 재료 소모 없음 — 결과 화면이면 이미 나온 요리는 그대로): Escape(`ctx.escape` 토큰 `housing.cook`) · Tab(capture 에서
 * 삼키고 `consume(Keys.INVENTORY)` — 인벤토리가 같은 키에 열리지 않는다). E 는 선택 카드 · 결과에서 닫고 게임 도중에는 삼키기만 한다.
 * 키 가이드 owner `housing.cook`.
 *
 * 루프는 `ui/gym/GymScreen` 의 2026-09-12 정정 그대로다 — `requestAnimationFrame` 이 프레임마다 밀고 그리고, 예비 타이머는 rAF 가
 * 멈췄을 때(헤드리스 · 가려진 창)만 일한다.
 */
import type { CookAutoInfo, CookBeatAction, CookJudge, CookResult, CookSessionInfo, CookStepDef, GameContext, KeyGuideEntry } from '@/shared';
import {
  COOK_CHOP_CUTS, COOK_GAME_ICON, COOK_GAME_LABEL_KO, COOK_JUDGE_LABEL_KO, COOK_LIQUID_LABEL_KO, Keys, MENU_BLOCKER,
  buildItemChip, keyLabel, mealQualityBonus, mealQualityStars,
} from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import { COOK_BLOCKER, completeCookRun, endCook, recordCookStep, restartBlock, restartCook } from '../../parts/Cooking';
import { createCookGame } from '../../parts/CookGames';
import type { AnyCookGame, CookButton } from '../../parts/CookGames';
import { mealEffectLines, mealTierText } from '../DiningTable';
import { clear, el, setText, toggleClass } from '../dom';
import { createCookView, replayCookClass } from './CookViews';
import type { CookView } from './CookViews';
import './cook.css';

export type CookScreenKind = 'choose' | 'game' | 'auto' | 'step' | 'result';

const ESCAPE_TOKEN = 'housing.cook';
const GUIDE_OWNER = 'housing.cook';
/** 예비 타이머 간격 · rAF 가 멈췄다고 볼 시간 (ms, 구현 값 — GymScreen 과 같다). */
const FALLBACK_MS = 50;
const FALLBACK_STALE_MS = 100;
/** 단계 점수 글자를 보여 주는 시간 (ms, 연출 — 설계안 「0.7 초」). */
const STEP_SCORE_MS = 700;
/** 자동 조리 가구가 단계를 처리하는 연출 시간 (ms, 연출 — 점수와 무관). */
const AUTO_MS = 1100;
const CIRCLED = ['①', '②', '③', '④', '⑤'];
/** 젓기 긁는 소리(`cook_stir`)의 최소 간격 (ms) — 연출 `stir` 는 hub 의 국자를 위해 더 촘촘히 온다 (구현 값). */
const STIR_SOUND_MIN_MS = 450;

/** 연출 입력 → 소리 (`audio:play`). `pour_stop` 은 소리가 없다. */
const BEAT_SOUND: Partial<Record<CookBeatAction, string>> = {
  cut: 'cook_chop', mince_h: 'cook_mince', mince_v: 'cook_mince', flip: 'cook_flip', remove: 'cook_remove', burn: 'cook_burn',
  toss: 'cook_toss', stir: 'cook_stir', pour_start: 'cook_pour',
};

const pct = (v: number): number => Math.round(Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)) * 100);
const isField = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
  || (t instanceof HTMLElement && t.isContentEditable);
const buttonOf = (b: number): CookButton | null => (b === 0 ? 'left' : b === 2 ? 'right' : null);

export class CookScreen {
  readonly root: HTMLElement;
  screen: CookScreenKind | null = null;
  game: AnyCookGame | null = null;
  stepIndex = 0;
  /** 마지막으로 끝낸 판의 결과 (닫은 뒤에도 남는다 — 스모크). */
  lastResult: CookResult | null = null;
  private opened = false;
  private info: CookSessionInfo | null = null;
  private readonly panel: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly stepsEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly verdict: HTMLElement;
  private readonly stepScoreEl: HTMLElement;
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
    this.root = el('div', { cls: 'cook', parent: ctx.uiRoot });
    this.root.hidden = true;
    this.panel = el('div', { cls: 'cook-panel', parent: this.root });
    const head = el('div', { cls: 'cook-head', parent: this.panel });
    this.nameEl = el('div', { cls: 'cook-name', parent: head });
    this.stepsEl = el('div', { cls: 'cook-steps', parent: head });
    this.body = el('div', { cls: 'cook-body', parent: this.panel });
    this.verdict = el('div', { cls: 'cook-verdict', parent: this.panel });
    this.stepScoreEl = el('div', { cls: 'cook-stepscore', parent: this.panel });
    this.hint = el('div', { cls: 'cook-hint', parent: this.panel });
    this.panel.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    // 패널 안의 클릭이 캔버스의 클릭-락 폴백까지 가지 않게
    this.panel.addEventListener('mousedown', (e) => e.stopPropagation());
    this.body.addEventListener('pointerdown', this.onPointerDown);
  }

  get isOpen(): boolean { return this.opened; }
  /** 화면 루프(rAF · 예비 타이머)가 걸려 있는가 — 스모크 (닫으면 false). */
  get ticking(): boolean { return this.raf !== 0 || this.timer !== 0; }

  /* ── 열기 · 닫기 ─────────────────────────────────────────────────────────── */
  /** 오버레이를 연다 — 단계는 아직 시작하지 않는다 (`beginSteps`, `parts/Cooking.startCook` 이 세션 이벤트 뒤에 부른다). */
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

  /** 첫 단계부터. */
  beginSteps(): void {
    if (!this.opened || !this.info) return;
    this.stepIndex = 0;
    this.beginStep();
  }

  /** 닫는다 — 결과 전이면 취소다. 세션 끝(`housing:cookSession {active:false}`)은 `endCook` 이 낸다. */
  close(): void {
    if (!this.opened) return;
    this.teardown();
    endCook(this.sys);
  }

  private teardown(): void {
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
    this.body.removeEventListener('pointerdown', this.onPointerDown);
    this.root.remove();
  }

  /* ── 루프 ────────────────────────────────────────────────────────────────── */
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

  /* ── 흐름 ────────────────────────────────────────────────────────────────── */
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
    const auto = this.sys.getCookAuto(step.game);
    if (auto) this.showChoose(step, auto);
    else this.play(step);
  }

  /** 선택 카드 → 직접 하기 / 자동. 선택 카드가 아니면 false. */
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
    this.button(row, `자동 — ${name} Lv.${auto.level} · ${pct(auto.score)} %`, () => this.choose('auto'), 'cook-choose-auto');
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
    setText(this.hint, this.ruleText(step));
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
    el('div', { cls: 'cook-auto-score', text: `단계 점수 ${pct(auto.score)} %`, parent: box });
    this.autoStart = performance.now();
    this.autoEndAt = this.autoStart + AUTO_MS;
    setText(this.hint, '');
    this.paintHead();
    this.ctx.bus.emit('housing:cookStep', { uid: info.uid, index: this.stepIndex, total: info.steps.length, game: step.game, phase: 'play', auto: true, score: null });
    this.ctx.bus.emit('audio:play', { id: 'cook_auto' });
    this.emitGuide();
    this.paint();
  }

  /** 판정 객체가 쌓은 이벤트 → 버스 · 소리 · 판정 글자. 게임이 끝났으면 단계를 마무리한다. */
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
    const s = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
    recordCookStep(this.sys, this.stepIndex, s, auto);
    this.screen = 'step';
    this.down.clear();
    this.advanceAt = performance.now() + STEP_SCORE_MS;
    this.ctx.bus.emit('housing:cookStep', { uid: info.uid, index: this.stepIndex, total: info.steps.length, game: step.game, phase: 'done', auto, score: s });
    this.ctx.bus.emit('audio:play', { id: 'cook_step' });
    setText(this.stepScoreEl, `${auto ? '자동 · ' : ''}${COOK_GAME_LABEL_KO[step.game]} ${pct(s)} %`);
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

  /** 스모크: 지금 단계를 `score` 로 끝내고 곧장 다음 단계(또는 결과)로 — 단계 점수 글자를 기다리지 않는다. */
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

  /** 결과 화면의 「다시 만들기」 — 한국어 사유 / null. */
  restart(): string | null {
    if (this.screen !== 'result') return '결과 화면이 아닙니다';
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

  /* ── 결과 ────────────────────────────────────────────────────────────────── */
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
    info.steps.forEach((s, i) => {
      const row = el('div', { cls: 'cook-result-step', parent: steps });
      el('span', { text: `${CIRCLED[i] ?? ''} ${COOK_GAME_LABEL_KO[s.game]}${r?.stepAuto[i] ? ' · 자동' : ''}`, parent: row });
      el('b', { text: `${pct(r?.stepScores[i] ?? 0)} %`, parent: row });
    });

    const meal = el('div', { cls: 'cook-result-meal', parent: card });
    const def = this.sys.mealDef(info.mealDefId);
    const chipWrap = el('div', { cls: 'cook-result-chip', parent: meal });
    chipWrap.appendChild(buildItemChip(def ?? undefined, { size: 56 }));
    if (q > 0) el('span', { cls: 'cook-qbadge', text: `★${q}`, parent: chipWrap });
    const text = el('div', { cls: 'cook-result-text', parent: meal });
    el('div', { cls: 'cook-result-name', text: def?.meal ? `${def.name} · ${mealTierText(def.meal)}` : def?.name ?? info.mealDefId, parent: text });
    if (def?.meal) el('div', { cls: 'cook-result-effects', text: mealEffectLines(def.meal, q).join('\n'), parent: text });
    if (r && !r.reason) el('div', { cls: 'cook-landed', text: `→ ${r.landed === 'bag' ? '가방' : '함선 창고'}`, parent: text });
    else el('div', { cls: 'cook-warn', text: r?.reason ?? '요리를 완성하지 못했습니다', parent: text });

    const foot = el('div', { cls: 'cook-result-foot', parent: card });
    const again = restartBlock(this.sys);
    const againBtn = this.button(foot, '다시 만들기', () => this.restart(), 'cook-again');
    toggleClass(againBtn, 'is-blocked', !!again);
    if (again) el('div', { cls: 'cook-again-reason', text: again, parent: foot });
    this.button(foot, '닫기', () => this.close(), 'primary cook-close');
    this.emitGuide();
  }

  /* ── 그리기 ──────────────────────────────────────────────────────────────── */
  private clearBody(): void {
    this.view?.dispose();
    this.view = null;
    this.autoBar = null;
    clear(this.body);
  }

  private paint(): void {
    if ((this.screen === 'game' || this.screen === 'step') && this.view) this.view.paint();
    if (this.screen === 'auto' && this.autoBar) {
      const f = Math.max(0, Math.min(1, (performance.now() - this.autoStart) / AUTO_MS));
      this.autoBar.style.setProperty('--f', f.toFixed(3));
    }
  }

  /** 머리줄 단계 진행 — `① 썰기 ✓ → ② 젓기 …`. */
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

  private ruleText(step: CookStepDef): string {
    switch (step.game) {
      case 'chop': return `표식이 선에 닿을 때 좌클릭 — ${Math.round(COOK_CHOP_CUTS)}번 썹니다. 박자 밖의 헛클릭은 다음 칼질의 실패입니다`;
      case 'mince': return '좌클릭 = 좌우 게이지 · 우클릭 = 상하 게이지. 같은 버튼만 연달아 누르면 반대쪽이 줄어듭니다 — 번갈아 빠르게';
      case 'grill': return '익어 가는 조각을 50 % 에서 클릭해 뒤집고, 100 % 에서 한 번 더 클릭해 꺼냅니다 — 늦으면 탑니다';
      case 'stirfry': return '링이 팬에 닿을 때 좌클릭 — 맞출수록 많이 볶이고, 틀려도 조금은 볶입니다';
      case 'stir': return '좌클릭을 누르고 있으면 저으며 온도가 내려가고, 떼면 올라갑니다 — 온도를 초록 구간에 두세요';
      default: return `좌클릭을 누르고 있으면 붓습니다 — ${COOK_LIQUID_LABEL_KO[step.liquid ?? 'water'] ?? ''} ${Math.round(step.targetMl ?? 0)} ml 를 맞추고 손을 떼면 잠시 뒤 끝납니다`;
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

  /* ── 입력 ────────────────────────────────────────────────────────────────── */
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.opened || this.screen !== 'game' || !this.game) return;
    const target = e.target as Element | null;
    if (!target?.closest?.('.cook-stage')) return;
    const button = buttonOf(e.button);
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    this.tick();                                   // 판정은 **지금** 시각에서
    if (this.screen !== 'game' || !this.game) return;
    this.down.add(button);
    this.view?.input(button, true);
    const piece = target.closest<HTMLElement>('.cook-piece[data-i]');
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
    e.preventDefault();
    e.stopImmediatePropagation();
    if (code === Keys.INVENTORY) this.ctx.input.consume(Keys.INVENTORY);
    if (e.repeat) return;
    if (code === Keys.INVENTORY || this.screen === 'choose' || this.screen === 'result') this.close();
  };
}
