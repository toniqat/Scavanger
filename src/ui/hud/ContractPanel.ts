import type { ContractGoalKind, GameContext } from '@/shared';
import { CONTRACT_DEFS, CONTRACT_GOAL_LABEL_KO } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const PULSE_SECONDS = 0.9;

/**
 * Active corp contract under the objective panel (gameplay layer, Phase 5): `계약 · <name>`, the goal label and a
 * `p / t` bar. Shown at `world:ready` when `ctx.meta?.activeContract` exists (name / goal / progress from the
 * `ContractInfo`), updated + briefly pulsed (`.pulse`, `PULSE_SECONDS` of `ctx.time`) on `meta:contractProgress` —
 * which also brings the panel up on its own, resolving the def from `CONTRACT_DEFS`, so a skeleton `ctx.meta` still
 * gets a panel. `달성` badge (`.done`) at progress ≥ target. Hidden on settlement / abandon, `game:abort`, and every
 * non-mission phase; the gameplay layer itself hides it in the hub.
 */
export class ContractPanel {
  readonly root: HTMLElement;
  private nameEl: HTMLElement;
  private goalEl: HTMLElement;
  private numEl: HTMLElement;
  private fillEl: HTMLElement;
  private showing = false;
  private pulseUntil = -1;
  private lastFill = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'contract-panel', parent });
    const head = el('div', { cls: 'head', parent: this.root });
    el('span', { cls: 'ui-label', text: '계약', parent: head });
    el('span', { cls: 'badge', text: '달성', parent: head });
    this.nameEl = el('div', { cls: 'name', text: '', parent: this.root });
    const row = el('div', { cls: 'row', parent: this.root });
    this.goalEl = el('span', { cls: 'goal', text: '', parent: row });
    this.numEl = el('span', { cls: 'num', text: '', parent: row });
    const bar = el('div', { cls: 'bar', parent: this.root });
    this.fillEl = el('div', { cls: 'fill', parent: bar });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('world:ready', () => this.fromMeta(ctx)),
      b.on('meta:contractProgress', ({ id, goal, progress, target }) => {
        const def = CONTRACT_DEFS.find((d) => d.id === id);
        this.set(def?.name ?? id, goal, progress, target);
        this.pulseUntil = ctx.time + PULSE_SECONDS;
        toggleClass(this.root, 'pulse', true);
      }),
      b.on('meta:contractSettled', () => this.hide()),
      b.on('meta:contractAbandoned', () => this.hide()),
      b.on('game:abort', () => this.hide()),
      b.on('game:phaseChanged', ({ phase }) => {
        if (phase === 'complete' || phase === 'dead' || phase === 'hub' || phase === 'menu') this.hide();
      }),
    );
  }

  /** Reads `ctx.meta.activeContract` (null / skeleton = hidden). */
  private fromMeta(ctx: GameContext): void {
    const info = ctx.meta?.activeContract ?? null;
    if (!info) { this.hide(); return; }
    this.set(info.def.name, info.def.goal, info.progress, info.def.target);
  }

  private set(name: string, goal: ContractGoalKind, progress: number, target: number): void {
    setText(this.nameEl, name);
    setText(this.goalEl, CONTRACT_GOAL_LABEL_KO[goal] ?? goal);
    const p = Math.floor(progress);
    setText(this.numEl, `${p.toLocaleString('ko-KR')} / ${target.toLocaleString('ko-KR')}`);
    const fill = target > 0 ? Math.min(1, Math.max(0, progress / target)) : 0;
    if (fill !== this.lastFill) { this.lastFill = fill; this.fillEl.style.transform = `scaleX(${fill.toFixed(4)})`; }
    toggleClass(this.root, 'done', progress >= target && target > 0);
    if (!this.showing) { this.showing = true; this.root.classList.add('show'); }
  }

  private hide(): void {
    if (!this.showing) return;
    this.showing = false;
    this.pulseUntil = -1;
    this.root.classList.remove('show', 'pulse');
  }

  /** One compare per frame: drops the progress pulse on sim time. */
  update(ctx: GameContext): void {
    if (this.pulseUntil >= 0 && ctx.time >= this.pulseUntil) {
      this.pulseUntil = -1;
      this.root.classList.remove('pulse');
    }
  }

  /** Whether the panel is up (debug). */
  get isShowing(): boolean { return this.showing; }
  /** Whether the progress pulse is running (debug). */
  get isPulsing(): boolean { return this.pulseUntil >= 0; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
