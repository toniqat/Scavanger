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
 *
 * 2026-09-13 (비디오게임, H2): **게임 모드**(`openGame`)가 같은 화면을 쓴다 — 헬스 모드(`open`)는 한 글자도 바뀌지 않았다.
 * 게임 모드의 차이: 판정 = `createGymGame(minigame, 디스크 튜닝)` · 제목 = 디스크 이름 · 부제 = 게임기 · 방식(`벤치프레스형` …) ·
 * 강조색 = 디스크 테마 색(루트의 `--c-accent` 를 덮어 `.gym-*` 전부가 따라간다, 루트 클래스 `is-game`) · 블로커 / ESC / 키 가이드 토큰
 * `housing.game` · 판정 이벤트 `housing:gameBeat` · 끝 = `parts/VideoGame` 의 `completeGameSession` / `endGameSession`.
 * 소리는 헬스와 같은 id(`gym_*`)를 쓴다.
 */
import type {
  GameContext, GameSessionInfo, GymGameTuning, GymMinigame, GymSessionInfo, GymSessionResult, GymStat, KeyGuideEntry,
} from '@/shared';
import {
  GYM_FATIGUE_LABEL_KO, GYM_MINIGAME_LABEL_KO, GYM_PRESS_REPS, GYM_TRAINED_MAX, Keys, MENU_BLOCKER, keyLabel, paintKeycap,
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
/** 화면이 몰고 있는 세션의 종류 — 헬스 기구 · 비디오게임 (2026-09-13). */
export type GymScreenMode = 'gym' | 'game';

/** 헬스 모드의 ESC 토큰 · 키 가이드 owner (블로커 `GYM_BLOCKER` 와 같은 글자). */
const GYM_TOKEN = 'housing.gym';
/** 예비 타이머 간격 (ms) — rAF 가 돌지 않을 때만 일한다 (구현 값). */
const FALLBACK_MS = 50;
/** 마지막 루프가 이보다 오래됐으면 rAF 가 멈춘 것으로 본다 (ms, 구현 값). */
const FALLBACK_STALE_MS = 100;
/** 마지막 판정 뒤 결과 화면으로 넘어가기까지 (ms) — 마지막 판정 글자를 읽을 틈 (연출 시간). */
const RESULT_DELAY_MS = 700;
/** 게임 모드 호흡형 표식 글자. */
const GAME_NOTE_LABELS: GymNoteLabels = { tap: '톡', hold: '꾹' };
const COLOR_SHAPE = /^#[0-9a-fA-F]{6}$/;

const pct = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 100);
const isField = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
  || (t instanceof HTMLElement && t.isContentEditable);

interface Clock { el: HTMLElement; until: number; format: (s: string) => string; text: string }

/** 한 번 연 세션의 모든 것 — 헬스 · 게임이 이것 하나로 갈린다. */
interface ScreenSpec {
  mode: GymScreenMode;
  /** 운동 기구 uid · TV uid. */
  uid: string;
  stat: GymStat;
  minigame: GymMinigame;
  /** 기구 이름 · 디스크 이름. */
  title: string;
  /** 게임기 이름 (게임 모드 부제), 헬스는 ''. */
  consoleName: string;
  /** 게임 테마 색 `#rrggbb`, 헬스 · 잘못된 값은 null. */
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
  /** 마지막으로 끝낸 **헬스** 세션의 결과 (닫은 뒤에도 남는다 — 스모크). */
  lastResult: GymSessionResult | null = null;
  /** 마지막으로 끝낸 **게임** 세션의 결과 (2026-09-13). */
  lastGameResult: GymSessionResult | null = null;
  private spec: ScreenSpec | null = null;
  /** 지금 열린 모드의 블로커 · ESC · 키 가이드 토큰 (닫을 때 spec 이 먼저 비워져도 남는다). */
  private token = GYM_TOKEN;
  private card: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  /** 진행 바의 채움 (2026-09-14 — 옛 `N / M` 글자를 대신한다). */
  private progFill: HTMLElement | null = null;
  private progF = -1;
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
  /** 열린 화면의 모드 (닫혀 있으면 null). */
  get mode(): GymScreenMode | null { return this.isOpen && this.spec ? this.spec.mode : null; }
  /** 화면 루프(rAF · 예비 타이머)가 걸려 있는가 — 스모크 (닫으면 false). */
  get ticking(): boolean { return this.raf !== 0 || this.timer !== 0; }

  /* ── 열기 · 닫기 ─────────────────────────────────────────────────────────── */
  /** 헬스 기구 세션 (A-3a). */
  open(session: GymSessionInfo, equipName: string): void {
    this.openSpec({ mode: 'gym', uid: session.uid, stat: session.stat, minigame: session.minigame, title: equipName, consoleName: '', color: null, tuning: undefined });
  }

  /** 비디오게임 세션 (2026-09-13) — 디스크 이름 · 테마 색 · 튜닝. */
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

  /** 닫는다 — 게임 도중이면 취소다. 세션 끝(`housing:gymSession` / `housing:gameSession {active:false}`)은 parts 가 낸다. */
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

  /* ── 모드별 끝 ───────────────────────────────────────────────────────────── */
  private complete(score: number): GymSessionResult | null {
    return this.spec?.mode === 'game' ? completeGameSession(this.sys, score) : completeGymSession(this.sys, score);
  }

  private currentResult(): GymSessionResult | null {
    return (this.spec?.mode === 'game' ? this.sys.gameState?.result : this.sys.gymState?.result) ?? null;
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
    const s = this.spec;
    if (this.screen !== 'intro' || !s) return false;
    this.clearBody();
    this.game = createGymGame(s.minigame, s.tuning);
    this.screen = 'game';
    const panel = this.panel = el('div', { cls: 'gym-panel', parent: this.root });
    panel.dataset.minigame = s.minigame;
    const head = el('div', { cls: 'gym-head', parent: panel });
    el('div', { cls: 'gym-name', text: `${s.title} · ${this.minigameLabel(s)}`, parent: head });
    // 2026-09-14 (사용자 결정): 라벨 없는 진행 바 하나 — 회차 글자(`N / M`)는 없앴다
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

  /** 스모크: 게임을 건너뛰고 `score` 로 끝낸다 (시작 안내에서도). */
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

  /** 판정 객체가 쌓은 이벤트 → 버스 · 소리 · 판정 글자. 마지막 판정이면 점수를 넘기고 결과 화면을 예약한다. */
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
      // 2026-09-15: Tab 은 맨 위 화면의 것이다 (`housing/ui/Panel` 과 같은 규칙 — `ctx.escape` 스택 순서)
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
   * 안내 한 줄 — 2026-09-15: 키 자리는 `{JUMP}` · `{LEFT}` · `{RIGHT}` **토큰**이고 `renderKeyText` 가 공용 키캡으로 끼워 넣는다
   * (글자 `Space` 대신 키캡 — 마우스로 리바인딩하면 그림). 그릴 때 `Keys` 를 읽으므로 리바인드 = `relabel()` 이 다시 그린다.
   */
  private ruleText(s: ScreenSpec): string {
    const kind = s.minigame;
    const reps = tunedCount(Math.round(GYM_PRESS_REPS), s.tuning?.countMul);
    if (s.mode === 'game') {
      if (kind === 'press') return `커서가 가운데 구역에 들어올 때 {JUMP} — 가운데일수록 좋습니다 (${reps}회)`;
      if (kind === 'breath') return '표식이 선에 닿을 때 {JUMP} — 「톡」 은 짧게, 「꾹」 은 꾹 눌렀다가 끝에서 뗍니다';
      return '표식에 맞춰 왼쪽 {LEFT} · 오른쪽 {RIGHT} 을 누릅니다';
    }
    if (kind === 'press') return `커서가 가운데 구역에 들어올 때 {JUMP} — 가운데일수록 좋습니다 (${reps}회)`;
    if (kind === 'breath') return '표식이 선에 닿을 때 {JUMP} — 「후」 는 짧게, 「하」 는 꾹 눌렀다가 끝에서 뗍니다';
    return '박자에 맞춰 왼발 {LEFT} · 오른발 {RIGHT} 을 번갈아 밟습니다';
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
      paintKeycap(k, a === 'jump' ? Keys.JUMP : a === 'left' ? Keys.LEFT : Keys.RIGHT);   // 2026-09-15: 공용 키캡
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
