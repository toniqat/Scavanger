/**
 * src/housing/ui/gym/GymScreen.ts — **운동 화면** (A-3a, 2026-09-12). 한 오버레이(`.gym`)가 세 화면을 갈아 끼운다:
 *
 *   시작 안내(`intro`) ─ Space ─▶ 게임(`game`) ─ 마지막 판정 ─▶ 결과(`result`)
 *
 * **키보드 게임이라 커서 모드를 켜지 않는다.** 블로커(`housing.gym`)만 올려 다른 시스템(이동 · 상호작용 · M · 인벤토리)을
 * 멈추고, 입력은 `window` capture 단계의 keydown / keyup 리스너가 받는다 — `Keys.JUMP` · `Keys.LEFT` · `Keys.RIGHT` 를
 * **사용 시점에** 읽고 `stopImmediatePropagation` 으로 삼키므로 `Input` 은 점프를 기록조차 못 한다. keyup 은 **우리가
 * keydown 을 삼킨 키만** 삼킨다 — 화면이 열리기 전부터 쥐고 있던 키(걷던 D)의 keyup 까지 먹으면 `Input` 이 그 키를
 * 영영 눌린 채로 안다.
 *
 * 닫기: Escape(`ctx.escape` 토큰 `housing.gym`) · Tab 은 어느 화면에서든 닫는다 — 게임 도중이면 **취소**(보상 · 디버프 없음).
 * E(`Keys.INTERACT`)는 패널 규약대로 시작 안내 · 결과에서 닫고, **게임 도중에는 삼키기만 한다** (사이클의 D 바로 위 키라
 * 한 번 스쳐서 세션을 날리지 않게). 키 가이드 owner 는 `housing.gym` 이고 화면마다 자기 키를 올린다.
 *
 * 시간은 `performance.now()` 기반이다. **루프는 화면 프레임마다 한 번**(`requestAnimationFrame`) 판정 객체를 밀고 그린다 —
 * 키가 오면 **그 순간까지** 먼저 민 뒤 판정하고 그 자리에서 다시 그린다 (틱 간격만큼 판정이 늦지 않고, 화면이 판정과 어긋나지 않는다).
 *
 * 2026-09-12 정정 (F): 처음 판은 `setInterval(16 ms)` 가 밀고 그렸다. 3D 프레임이 무겁고 입력(포인터 락 마우스 · 키)이
 * 들어오는 동안 Chrome 은 렌더링 · 입력 태스크를 타이머보다 먼저 돌리므로, 30 ms 프레임 + 입력 스트림에서 그 타이머는
 * 1.6 초에 24 번(중간 61 ms · 최대 122 ms 간격 — rAF 는 52 번)밖에 못 돌았다. 커서 · 표식이 2–4 프레임씩 건너뛰며 끊겼고,
 * 키 핸들러는 판정 객체만 밀고 그리지 않아 화면이 키 입력 순간에 맞춰 튀는 것처럼 보였다. rAF 는 **그리기 직전에** 돌므로
 * 화면이 바뀌는 프레임마다 반드시 한 번 칠한다. 예비 타이머(`FALLBACK_MS`)는 rAF 가 멈춘 경우(헤드리스 · 가려진 창)에만 일한다.
 */
import type { GameContext, GymMinigame, GymSessionInfo, GymSessionResult, GymStat, KeyGuideEntry } from '@/shared';
import {
  GYM_FATIGUE_LABEL_KO, GYM_MINIGAME_LABEL_KO, GYM_PRESS_REPS, GYM_TRAINED_MAX, Keys, MENU_BLOCKER, keyLabel,
} from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import { GYM_BLOCKER, completeGymSession, endGymSession } from '../../parts/Gym';
import { GYM_QUALITY_LABEL_KO, createGymGame } from '../../parts/GymGames';
import type { GymAction, GymGame, GymQuality } from '../../parts/GymGames';
import { clear, clockText, el, setText, toggleClass } from '../dom';
import { createGymView, replayClass } from './GymViews';
import type { GymView } from './GymViews';
import './gym.css';

export type GymScreenKind = 'intro' | 'game' | 'result';

const ESCAPE_TOKEN = 'housing.gym';
const GUIDE_OWNER = 'housing.gym';
/** 예비 타이머 간격 (ms) — rAF 가 돌지 않을 때만 일한다 (구현 값). */
const FALLBACK_MS = 50;
/** 마지막 루프가 이보다 오래됐으면 rAF 가 멈춘 것으로 본다 (ms, 구현 값). */
const FALLBACK_STALE_MS = 100;
/** 마지막 판정 뒤 결과 화면으로 넘어가기까지 (ms) — 마지막 판정 글자를 읽을 틈 (연출 시간). */
const RESULT_DELAY_MS = 700;

const pct = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 100);
const isField = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
  || (t instanceof HTMLElement && t.isContentEditable);

interface Clock { el: HTMLElement; until: number; format: (s: string) => string; text: string }

export class GymScreen {
  readonly root: HTMLElement;
  screen: GymScreenKind | null = null;
  game: GymGame | null = null;
  /** 마지막으로 끝낸 세션의 결과 (닫은 뒤에도 남는다 — 스모크). */
  lastResult: GymSessionResult | null = null;
  private session: GymSessionInfo | null = null;
  private equipName = '';
  private card: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private verdict: HTMLElement | null = null;
  private view: GymView | null = null;
  private clocks: Clock[] = [];
  private raf = 0;
  private timer = 0;
  /** 판정 객체를 마지막으로 민 시각 (`performance.now()`). */
  private last = 0;
  /** 루프가 마지막으로 돈 시각 — 예비 타이머가 rAF 가 살아 있는지 본다. */
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
  /** 화면 루프(rAF · 예비 타이머)가 걸려 있는가 — 스모크 (닫으면 false). */
  get ticking(): boolean { return this.raf !== 0 || this.timer !== 0; }

  /* ── 열기 · 닫기 ─────────────────────────────────────────────────────────── */
  open(session: GymSessionInfo, equipName: string): void {
    if (this.isOpen) this.teardown();
    this.session = session;
    this.equipName = equipName;
    this.game = null;
    this.lastResult = null;
    this.resultAt = 0;
    this.finalScore = 0;
    this.ctx.uiBlockers.add(GYM_BLOCKER);
    this.ctx.escape.push(ESCAPE_TOKEN, () => this.close());
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    this.root.hidden = false;
    this.showIntro();
    this.startLoop();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** 닫는다 — 게임 도중이면 취소다. 세션 끝(`housing:gymSession {active:false}`)은 `endGymSession` 이 낸다. */
  close(): void {
    if (!this.isOpen) return;
    this.teardown();
    endGymSession(this.sys);
  }

  private teardown(): void {
    this.stopLoop();
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    this.consumed.clear();
    this.view?.dispose(); this.view = null;
    clear(this.root);
    this.card = this.panel = this.countEl = this.verdict = null;
    this.clocks = [];
    this.root.hidden = true;
    this.screen = null;
    this.session = null;
    this.ctx.uiBlockers.delete(GYM_BLOCKER);
    this.ctx.escape.remove(ESCAPE_TOKEN);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: null });
  }

  dispose(): void {
    this.close();
    this.stopLoop();
    for (const u of this.unsubs) u();
    this.unsubs = [];
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

  /** 화면 프레임마다 — 그리기 직전이라 이번 프레임에 반드시 보인다. */
  private readonly onFrame = (): void => {
    this.raf = requestAnimationFrame(this.onFrame);
    this.loop();
  };

  /** rAF 가 멈췄을 때만 (헤드리스 · 가려진 창) — 살아 있으면 한 프레임에 두 번 칠하지 않는다. */
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

  /* ── 흐름 ────────────────────────────────────────────────────────────────── */
  /** 시작 안내 → 게임. */
  start(): boolean {
    const s = this.session;
    if (this.screen !== 'intro' || !s) return false;
    this.clearBody();
    this.game = createGymGame(s.minigame);
    this.screen = 'game';
    const panel = this.panel = el('div', { cls: 'gym-panel', parent: this.root });
    panel.dataset.minigame = s.minigame;
    const head = el('div', { cls: 'gym-head', parent: panel });
    el('div', { cls: 'gym-name', text: `${this.equipName} · ${GYM_MINIGAME_LABEL_KO[s.minigame]}`, parent: head });
    this.countEl = el('div', { cls: 'gym-count', parent: head });
    this.view = createGymView(this.game, panel);
    this.verdict = el('div', { cls: 'gym-verdict', parent: panel });
    el('div', { cls: 'gym-hint', text: this.ruleText(s.minigame), parent: panel });
    this.last = performance.now();
    this.emitGuide();
    this.paint();
    this.ctx.bus.emit('audio:play', { id: 'gym_start' });
    return true;
  }

  /** 스모크: 게임을 건너뛰고 `score` 로 끝낸다 (시작 안내에서도). */
  finishWith(score: number): GymSessionResult | null {
    if (this.screen !== 'intro' && this.screen !== 'game') return null;
    this.finalScore = Math.max(0, Math.min(1, score));
    const r = completeGymSession(this.sys, this.finalScore);
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

  /** 판정 객체가 쌓은 이벤트 → 버스 · 소리 · 판정 글자. 마지막 판정이면 점수를 넘기고 결과 화면을 예약한다. */
  private flush(): void {
    const g = this.game, s = this.session;
    if (!g || !s) return;
    for (const ev of g.drain()) {
      if (ev.type === 'sound') { this.ctx.bus.emit('audio:play', { id: ev.id }); continue; }
      this.ctx.bus.emit('housing:gymBeat', { uid: s.uid, minigame: s.minigame, quality: ev.quality, index: ev.index, total: ev.total });
      this.ctx.bus.emit('audio:play', { id: `gym_${ev.quality}` });
      this.view?.judged(ev.quality, ev.index);
      this.flash(ev.quality);
    }
    if (g.done && !this.resultAt && this.screen === 'game') {
      this.resultAt = performance.now() + RESULT_DELAY_MS;
      this.finalScore = g.score;
      completeGymSession(this.sys, g.score);
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
      if (this.countEl) setText(this.countEl, `${Math.min(this.game.judgements.length + (this.game.done ? 0 : 1), this.game.total)} / ${this.game.total}`);
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

  /* ── 입력 ────────────────────────────────────────────────────────────────── */
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
    this.tick();                                   // 판정은 **지금** 시각에서
    this.view?.input(action, true);
    if (this.screen !== 'game' || !this.game) return;
    this.game.press(action);
    this.flush();
    this.paint();                                  // 판정한 그 자리를 곧바로 — 다음 프레임까지 옛 자리를 보여 주지 않는다
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

  /* ── 화면 ────────────────────────────────────────────────────────────────── */
  private clearBody(): void {
    this.view?.dispose(); this.view = null;
    clear(this.root);
    this.card = this.panel = this.countEl = this.verdict = null;
    this.clocks = [];
  }

  private statName(stat: GymStat): string {
    try { return this.ctx.progression?.getStatDef(stat)?.name ?? stat; } catch { return stat; }
  }

  private ruleText(kind: GymMinigame): string {
    const J = keyLabel(Keys.JUMP);
    if (kind === 'press') return `커서가 가운데 구역에 들어올 때 ${J} — 가운데일수록 좋습니다 (${Math.round(GYM_PRESS_REPS)}회)`;
    if (kind === 'breath') return `표식이 선에 닿을 때 ${J} — 「후」 는 짧게, 「하」 는 꾹 눌렀다가 끝에서 뗍니다`;
    return `박자에 맞춰 왼발 ${keyLabel(Keys.LEFT)} · 오른발 ${keyLabel(Keys.RIGHT)} 을 번갈아 밟습니다`;
  }

  /** 단련 보너스 · 진행도 한 덩어리 (시작 안내 · 결과 공용). */
  private trainedBlock(parent: HTMLElement, stat: GymStat, trained: number, progress: number, need: number | null, capped: boolean): void {
    const box = el('div', { cls: 'gym-trained', parent });
    const line = el('div', { cls: 'gym-trained-line', parent: box });
    el('span', { cls: 'gym-trained-stat', text: this.statName(stat), parent: line });
    el('span', { cls: 'gym-trained-val', text: `+${trained} 단련`, parent: line });
    const tail = capped
      ? '단련 최대치'
      : need !== null && need > 0 ? `다음 단련까지 ${Math.round(progress * need)} / ${need}` : `다음 단련까지 ${pct(progress)} %`;
    el('span', { cls: 'gym-trained-next', text: tail, parent: line });
    const bar = el('div', { cls: 'gym-bar', parent: box });
    el('i', { cls: 'gym-bar-fill', parent: bar }).style.width = `${capped ? 100 : pct(progress)}%`;
  }

  private showIntro(): void {
    const s = this.session;
    if (!s) return;
    this.clearBody();
    this.screen = 'intro';
    const prog = this.ctx.progression;
    const card = this.card = el('div', { cls: 'gym-card gym-intro', parent: this.root });
    el('div', { cls: 'gym-kicker', text: `헬스장 · ${this.statName(s.stat)} 단련`, parent: card });
    el('div', { cls: 'gym-title', text: this.equipName, parent: card });
    el('div', { cls: 'gym-sub', text: GYM_MINIGAME_LABEL_KO[s.minigame], parent: card });
    const trained = prog?.getTrainedBonus?.(s.stat) ?? 0;
    const need = prog?.trainedXpToNext?.(s.stat) ?? null;
    this.trainedBlock(card, s.stat, trained, prog?.getTrainedProgress?.(s.stat) ?? 0, need, trained >= GYM_TRAINED_MAX);
    el('div', { cls: 'gym-rule', text: this.ruleText(s.minigame), parent: card });
    const until = prog?.getGymFatigueUntil?.(s.stat) ?? 0;
    if (until > this.sys.nowMs()) {
      const warn = el('div', { cls: 'gym-warn', parent: card });
      const label = GYM_FATIGUE_LABEL_KO[s.stat], name = this.statName(s.stat);
      this.clocks.push({ el: warn, until, text: '-', format: (t) => `${label} — 이번 운동으로는 ${name}이 오르지 않습니다 (남은 ${t})` });
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
    const s = this.session;
    if (!s) return;
    const g = fromGame ? this.game : null;
    const counts = g ? g.counts() : null;
    this.clearBody();
    this.screen = 'result';
    this.resultAt = 0;
    const r = this.sys.gymState?.result ?? null;
    this.lastResult = r;
    const card = this.card = el('div', { cls: 'gym-card gym-result', parent: this.root });
    el('div', { cls: 'gym-kicker', text: `운동 완료 · ${GYM_MINIGAME_LABEL_KO[s.minigame]}`, parent: card });
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
      el('div', { cls: 'gym-xp', text: `단련 경험치 +${r.xp}`, parent: card });
      const gained = r.trainedAfter - r.trainedBefore;
      if (gained > 0) el('div', { cls: 'gym-level', text: `${name} 단련 +${gained}!`, parent: card });
      this.trainedBlock(card, s.stat, r.trainedAfter, r.progress, null, r.capped);
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

  /* ── 키 이름 (사용 시점) ─────────────────────────────────────────────────── */
  private relabelKeys(): void {
    for (const k of this.root.querySelectorAll<HTMLElement>('.keycap[data-key]')) {
      const a = k.dataset.key as GymAction;
      setText(k, keyLabel(a === 'jump' ? Keys.JUMP : a === 'left' ? Keys.LEFT : Keys.RIGHT));
    }
  }

  private relabel(): void {
    if (!this.isOpen) return;
    this.relabelKeys();
    this.view?.relabel();
    const hint = this.panel?.querySelector<HTMLElement>('.gym-hint');
    if (hint && this.session) setText(hint, this.ruleText(this.session.minigame));
    const rule = this.card?.querySelector<HTMLElement>('.gym-rule');
    if (rule && this.session) setText(rule, this.ruleText(this.session.minigame));
    this.emitGuide();
  }

  private emitGuide(): void {
    const s = this.session;
    if (!s || !this.screen) return;
    const J = keyLabel(Keys.JUMP);
    let keys: KeyGuideEntry[] = [];
    if (this.screen === 'intro') keys = [{ key: J, label: '시작' }];
    else if (this.screen === 'game') {
      if (s.minigame === 'press') keys = [{ key: J, label: '들어 올리기' }];
      else if (s.minigame === 'breath') keys = [{ key: J, label: '후' }, { key: J, label: '하', hold: true }];
      else keys = [{ key: keyLabel(Keys.LEFT), label: '왼발' }, { key: keyLabel(Keys.RIGHT), label: '오른발' }];
    }
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys });
  }
}
