import type { GameContext, TrainingMode, TrainingRef } from '@/shared';
import { TRAINING_MODE_LABEL_KO, TRAINING_COURSE_TARGETS, TRAINING_COURSE_TIME_S } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const PULSE_SECONDS = 0.9;
const URGENT_S = 10;

/**
 * 시뮬레이션 훈련장 panel under the objective (gameplay layer, Phase 9; the `ContractPanel` slot — a contract never
 * shows in a training). Visible only while `ctx.missionMode === 'training'`: `game:phaseChanged → playing` brings it
 * up, `game:abort` / any non-mission phase hides it. Rows: mode chip (`TRAINING_MODE_LABEL_KO`, `training:modeChanged`),
 * 격추 score (`training:scored`; in `timed` mode `n / TRAINING_COURSE_TARGETS` with a bar, `.done` colours at the target),
 * 남은 시간 while a course runs (`ctx.world.training` polled in `update` for fields that changed on the ref itself, so an
 * event's mode / score survives the next frame; `−1` = idle hides the row, red pulse
 * under `URGENT_S`) and 최고 기록 (`bestTime`, hidden while null). `training:courseFinished` → `ui:notify`
 * (`타임 코스 완료 12.3초` / `시간 초과`) + a `PULSE_SECONDS` pulse. Every `training:*` event also brings the panel up on
 * its own when the mission mode is a training, so a `TrainingRef`-less world (skeleton) still yields a panel.
 */
export class TrainingPanel {
  readonly root: HTMLElement;
  private modeEl: HTMLElement;
  private scoreNum: HTMLElement;
  private fillEl: HTMLElement;
  private timeRow: HTMLElement;
  private timeNum: HTMLElement;
  private bestRow: HTMLElement;
  private bestNum: HTMLElement;
  private showing = false;
  private pulseUntil = -1;
  private mode: TrainingMode = 'static';
  private score = 0;
  private best: number | null = null;
  private remaining = -1;
  /** Last values read off the live `TrainingRef` — the poll adopts a field only when the ref itself moved. */
  private polled: { mode: TrainingMode; score: number; best: number | null; remaining: number } | null = null;
  private lastKey = '';
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'training-panel', parent });
    const head = el('div', { cls: 'head', parent: this.root });
    el('span', { cls: 'ui-label', text: '훈련', parent: head });
    this.modeEl = el('span', { cls: 'mode', text: TRAINING_MODE_LABEL_KO.static, parent: head });
    const scoreRow = el('div', { cls: 'row score', parent: this.root });
    el('span', { cls: 'goal', text: '격추', parent: scoreRow });
    this.scoreNum = el('span', { cls: 'num', text: '0', parent: scoreRow });
    const bar = el('div', { cls: 'bar', parent: this.root });
    this.fillEl = el('div', { cls: 'fill', parent: bar });
    this.timeRow = el('div', { cls: 'row time', parent: this.root });
    this.timeRow.hidden = true;
    el('span', { cls: 'goal', text: '남은 시간', parent: this.timeRow });
    this.timeNum = el('span', { cls: 'num', text: '', parent: this.timeRow });
    this.bestRow = el('div', { cls: 'row best', parent: this.root });
    this.bestRow.hidden = true;
    el('span', { cls: 'goal', text: '최고 기록', parent: this.bestRow });
    this.bestNum = el('span', { cls: 'num', text: '', parent: this.bestRow });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    const inTraining = () => ctx.missionMode === 'training';
    this.unsubs.push(
      b.on('game:newMission', ({ mode }) => {
        this.hide();
        this.score = 0; this.remaining = -1; this.best = null; this.mode = 'static';
        if (mode === 'training') this.syncFrom(ctx.world?.training ?? null);
        this.render();
      }),
      b.on('game:phaseChanged', ({ phase }) => {
        if (phase === 'playing' && inTraining()) { this.syncFrom(ctx.world?.training ?? null); this.render(); this.show(); return; }
        if (phase === 'complete' || phase === 'dead' || phase === 'hub' || phase === 'menu') this.hide();
      }),
      b.on('game:abort', () => this.hide()),
      b.on('training:modeChanged', ({ mode }) => {
        this.syncFrom(ctx.world?.training ?? null);
        this.mode = mode;
        this.render();
        if (inTraining()) this.show();
      }),
      b.on('training:scored', ({ score }) => {
        this.score = score;
        this.render();
        if (inTraining()) { this.show(); this.pulse(ctx); }
      }),
      b.on('training:courseFinished', ({ time, score, completed, best }) => {
        this.score = score;
        this.best = best;
        this.remaining = -1;
        this.render();
        if (!inTraining()) return;
        this.show();
        this.pulse(ctx);
        const record = completed && best !== null && Math.abs(best - time) < 1e-3;
        b.emit('ui:notify', completed
          ? { text: `타임 코스 완료 ${fmtSec(time)}${record ? ' · 신기록' : ''}`, kind: 'success' }
          : { text: `시간 초과 — ${score} / ${TRAINING_COURSE_TARGETS} 격추`, kind: 'warning' });
      }),
    );
  }

  /** Copies mode / score / best / clock from the live `TrainingRef` (null = nothing to read). */
  private syncFrom(t: TrainingRef | null): void {
    if (!t) return;
    this.mode = t.mode;
    this.score = t.score;
    this.best = t.bestTime;
    this.remaining = t.remaining;
    this.polled = { mode: t.mode, score: t.score, best: t.bestTime, remaining: t.remaining };
  }

  private render(): void {
    const timed = this.mode === 'timed';
    const running = this.remaining >= 0;
    const key = `${this.mode}|${this.score}|${this.best ?? 'n'}|${running ? this.remaining.toFixed(1) : 'idle'}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    setText(this.modeEl, TRAINING_MODE_LABEL_KO[this.mode] ?? this.mode);
    toggleClass(this.root, 'timed', timed);
    setText(this.scoreNum, timed ? `${this.score} / ${TRAINING_COURSE_TARGETS}` : String(this.score));
    const fill = timed ? Math.min(1, Math.max(0, this.score / TRAINING_COURSE_TARGETS)) : 0;
    this.fillEl.style.transform = `scaleX(${fill.toFixed(4)})`;
    toggleClass(this.root, 'done', timed && this.score >= TRAINING_COURSE_TARGETS);
    this.timeRow.hidden = !running;
    if (running) {
      setText(this.timeNum, fmtSec(Math.min(TRAINING_COURSE_TIME_S, this.remaining)));
      toggleClass(this.timeRow, 'urgent', this.remaining < URGENT_S);
    }
    this.bestRow.hidden = this.best === null;
    if (this.best !== null) setText(this.bestNum, fmtSec(this.best));
  }

  private show(): void {
    if (this.showing) return;
    this.showing = true;
    this.root.classList.add('show');
  }

  private hide(): void {
    if (!this.showing) return;
    this.showing = false;
    this.pulseUntil = -1;
    this.root.classList.remove('show', 'pulse');
  }

  private pulse(ctx: GameContext): void {
    this.pulseUntil = ctx.time + PULSE_SECONDS;
    // restart the CSS animation even if it is still running
    this.root.classList.remove('pulse');
    void this.root.offsetWidth;
    this.root.classList.add('pulse');
  }

  /**
   * Per frame: polls the course clock / score while the panel is up and drops the pulse on sim time.
   * The poll adopts a field only when the **ref itself** changed since the last frame, so a value a
   * `training:*` event already put on the panel is never overwritten by a ref that has not moved yet
   * (the events are emitted from inside the arena's own update, one poll ahead of the panel).
   */
  update(ctx: GameContext): void {
    if (this.pulseUntil >= 0 && ctx.time >= this.pulseUntil) {
      this.pulseUntil = -1;
      this.root.classList.remove('pulse');
    }
    if (!this.showing) return;
    const t = ctx.world?.training ?? null;
    if (!t) { this.polled = null; return; }
    const p = this.polled;
    if (!p) { this.syncFrom(t); this.render(); return; }
    let dirty = false;
    if (t.mode !== p.mode) { p.mode = this.mode = t.mode; dirty = true; }
    if (t.score !== p.score) { p.score = this.score = t.score; dirty = true; }
    if (t.bestTime !== p.best) { p.best = this.best = t.bestTime; dirty = true; }
    if (t.remaining !== p.remaining) { p.remaining = this.remaining = t.remaining; dirty = true; }
    if (dirty) this.render();
  }

  /** Whether the panel is up (debug). */
  get isShowing(): boolean { return this.showing; }
  /** Whether the score pulse is running (debug). */
  get isPulsing(): boolean { return this.pulseUntil >= 0; }
  /** Mode currently shown (debug). */
  get shownMode(): TrainingMode { return this.mode; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}

function fmtSec(s: number): string { return `${Math.max(0, s).toFixed(1)}초`; }
