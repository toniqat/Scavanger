import type { MissionRewards, RaidContractRow } from '@/shared';
import { formatCredits } from '@/shared';
import { el, fmtInt, setText } from '../../dom';
import { CONTRACT_OUTCOME_CLASS, CONTRACT_OUTCOME_TEXT, contractOutcome } from '../RewardsBlock';

const ROW_DELAY = 0.2;   // seconds before the first row fades in
const ROW_STEP = 0.14;   // seconds between two rows
const ROW_FADE = 0.3;    // fade length of one row

interface RowView { root: HTMLElement; bar: HTMLElement; frac: number }

/**
 * Page ③ of the result screen — **분대 계약** (2026-09-21, the paged result screen, user's decisions): one row per squad
 * member, cleared or not — name (`나` for me), the contract's label, a state tag and `progress / target` with a thin
 * bar. My row, when `rewards.contract` is the settlement it came from, keeps the old contract line's wording
 * (`CONTRACT_OUTCOME_TEXT` — `계약 성공` · `계약 미완 · 계속` · `계약 실패 · 진척 유지 안 됨`) and the success rewards
 * (`신뢰도 +rep · 크레딧 +C`). With no `rewards.contracts` the page falls back to my own `rewards.contract`.
 * Rows fade in one after another (stepped in `update`, reduced motion clips CSS transitions).
 */
export class ContractsPage {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private rows: RowView[] = [];
  private timer = 0;
  private running = false;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'rs-contracts', parent });
    this.list = el('div', { cls: 'rs-ct-list', parent: this.root });
    this.empty = el('div', { cls: 'rs-ct-empty', text: '진행 중인 계약이 없었습니다', parent: this.root });
    this.empty.hidden = true;
  }

  fill(r: MissionRewards | undefined, dead: boolean): void {
    this.list.replaceChildren();
    this.rows = [];
    this.running = false;
    const settle = r?.contract ?? null;
    let rows: RaidContractRow[] = r?.contracts ? [...r.contracts] : [];
    if (!r?.contracts && settle) {
      rows = [{ name: '나', self: true, label: settle.name, success: contractOutcome(settle) === 'success', progress: settle.progress, target: settle.target }];
    }
    rows.sort((a, b) => Number(b.self) - Number(a.self));
    this.empty.hidden = rows.some((x) => x.label !== null);

    for (const row of rows) {
      const root = el('div', { cls: 'rs-ct', parent: this.list });
      if (row.self) root.classList.add('is-me');
      const who = el('div', { cls: 'rs-ct-who', parent: root });
      el('span', { cls: 'rs-ct-name', text: row.self ? '나' : row.name, parent: who });
      const body = el('div', { cls: 'rs-ct-body', parent: root });
      const tag = el('span', { cls: 'rs-ct-tag', parent: who });
      const bar = el('div', { cls: 'rs-ct-bar', parent: body });
      const fill = el('div', { cls: 'rs-ct-fill', parent: bar });
      let frac = 0;
      if (row.label === null) {
        root.classList.add('is-none');
        el('div', { cls: 'rs-ct-label', text: '계약 없음', parent: body });
        setText(tag, '—');
        bar.hidden = true;
      } else {
        const target = Math.max(1, row.target);
        frac = Math.min(1, Math.max(0, row.progress / target));
        const line = el('div', { cls: 'rs-ct-line', parent: body });
        el('span', { cls: 'rs-ct-label', text: row.label, parent: line });
        el('span', { cls: 'rs-ct-prog', text: `${fmtInt(row.progress)} / ${fmtInt(row.target)}`, parent: line });
        body.insertBefore(line, bar);
        // My row reads the settlement itself (the old contract line); a squadmate's row only knows success or not.
        const outcome = row.self && settle ? contractOutcome(settle, dead ? 'failed' : 'incomplete') : (row.success ? 'success' : null);
        if (outcome) {
          root.classList.add(`is-${CONTRACT_OUTCOME_CLASS[outcome]}`);
          setText(tag, CONTRACT_OUTCOME_TEXT[outcome]);
        } else {
          root.classList.add('is-keep');
          setText(tag, '계약 미완');
        }
        if (row.self && settle && outcome === 'success') {
          el('div', { cls: 'rs-ct-pay', text: `신뢰도 +${fmtInt(settle.rep)} · 크레딧 ${formatCredits(settle.credits, { sign: true })}`, parent: body });
        }
      }
      fill.style.transform = 'scaleX(0)';
      root.style.opacity = '0';
      this.rows.push({ root, bar: fill, frac });
    }
  }

  enter(): void { this.timer = 0; this.running = true; }

  finish(): void {
    if (!this.running) return;
    this.timer = ROW_DELAY + this.rows.length * ROW_STEP + ROW_FADE;
    this.update(0);
  }

  update(dt: number): void {
    if (!this.running) return;
    this.timer += dt;
    let done = true;
    for (let i = 0; i < this.rows.length; i++) {
      const k = Math.min(1, Math.max(0, (this.timer - ROW_DELAY - i * ROW_STEP) / ROW_FADE));
      if (k < 1) done = false;
      const v = this.rows[i];
      v.root.style.opacity = k.toFixed(3);
      v.bar.style.transform = `scaleX(${(v.frac * (1 - Math.pow(1 - k, 3))).toFixed(4)})`;
    }
    if (done) this.running = false;
  }

  stop(): void { this.running = false; }

  /** Row texts (debug). */
  get rowTexts(): string[] { return this.rows.map((r) => r.root.textContent ?? ''); }
}
