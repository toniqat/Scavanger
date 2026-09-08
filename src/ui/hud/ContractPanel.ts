import type { ContractGoalKind, GameContext } from '@/shared';
import { CONTRACT_DEFS, CONTRACT_GOAL_LABEL_KO, NET_SLOT_COLORS_CSS } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const PULSE_SECONDS = 0.9;

interface MateRow {
  root: HTMLElement;
  name: HTMLElement;
  contract: HTMLElement;
  num: HTMLElement;
  fill: HTMLElement;
  key: string;
}

/**
 * Top-left contract block (gameplay layer). Two parts:
 *
 *   - **내 계약** — the accepted corp contract: `계약 · <name>`, its goal label and a `p / t` bar. Shown at
 *     `world:ready` when `ctx.meta?.activeContract` exists, updated + briefly pulsed (`.pulse`, `PULSE_SECONDS` of
 *     `ctx.time`) on `meta:contractProgress` — which also brings the panel up on its own, resolving the def from
 *     `CONTRACT_DEFS`, so a skeleton `ctx.meta` still gets a panel. `달성` badge (`.done`) at progress ≥ target.
 *   - **분대 계약** (Phase 9 UI pass) — one compact row per squad member that has a contract running, from
 *     `ctx.meta.getSquadContracts()` (fed by the relayed `meta contract` broadcast). Slot-coloured name, contract
 *     name and `p / t` with its own thin bar. The block hides itself when nobody else has one, so a solo raid looks
 *     exactly as it did before.
 *
 * The panel is never shown in the **시뮬레이션 훈련장** (`ctx.missionMode === 'training'`, 2026-09-08) — the
 * range is not a raid, so a contract accepted back at the ship has no business on that HUD.
 *
 * The panel as a whole is hidden on settlement / abandon, `game:abort`, and every non-mission phase; the gameplay
 * layer itself hides it in the hub. Since the squad list moved to the bottom-left this is the only thing under the
 * objective, so the two no longer overlap.
 */
export class ContractPanel {
  readonly root: HTMLElement;
  private mineEl: HTMLElement;
  private nameEl: HTMLElement;
  private goalEl: HTMLElement;
  private numEl: HTMLElement;
  private fillEl: HTMLElement;
  private matesEl: HTMLElement;
  private mateRows: MateRow[] = [];
  private showing = false;
  private mine = false;
  private mateCount = 0;
  private pulseUntil = -1;
  private lastFill = -1;
  /** A `meta:squadContract` arrived (or the mission changed) — repaint the rows on the next frame. */
  private mateDirty = true;
  /** Bound in `bind` so `applyShow` can ask the mission mode without a parameter on every call path. */
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'contract-panel', parent });

    this.mineEl = el('div', { cls: 'mine', parent: this.root });
    const head = el('div', { cls: 'head', parent: this.mineEl });
    el('span', { cls: 'ui-label', text: '계약', parent: head });
    el('span', { cls: 'badge', text: '달성', parent: head });
    this.nameEl = el('div', { cls: 'name', text: '', parent: this.mineEl });
    const row = el('div', { cls: 'row', parent: this.mineEl });
    this.goalEl = el('span', { cls: 'goal', text: '', parent: row });
    this.numEl = el('span', { cls: 'num', text: '', parent: row });
    const bar = el('div', { cls: 'bar', parent: this.mineEl });
    this.fillEl = el('div', { cls: 'fill', parent: bar });

    this.matesEl = el('div', { cls: 'mates', parent: this.root });
    this.matesEl.hidden = true;
    el('div', { cls: 'ui-label', text: '분대 계약', parent: this.matesEl });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('world:ready', () => { this.fromMeta(ctx); this.mateDirty = true; this.applyShow(); }),
      b.on('meta:contractProgress', ({ id, goal, progress, target }) => {
        const def = CONTRACT_DEFS.find((d) => d.id === id);
        this.set(def?.name ?? id, goal, progress, target);
        this.pulseUntil = ctx.time + PULSE_SECONDS;
        toggleClass(this.root, 'pulse', true);
      }),
      b.on('meta:squadContract', () => { this.mateDirty = true; }),
      b.on('meta:contractSettled', () => this.hideMine()),
      b.on('meta:contractAbandoned', () => this.hideMine()),
      b.on('game:abort', () => this.hide()),
      b.on('game:phaseChanged', ({ phase }) => {
        if (phase === 'complete' || phase === 'dead' || phase === 'hub' || phase === 'menu') this.hide();
      }),
    );
  }

  /** Reads `ctx.meta.activeContract` (null / skeleton = own block hidden). */
  private fromMeta(ctx: GameContext): void {
    const info = ctx.meta?.activeContract ?? null;
    if (!info) { this.hideMine(); return; }
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
    this.mine = true;
    this.mineEl.hidden = false;
    this.applyShow();
  }

  /** Drop the own-contract block; the squad rows (if any) keep the panel up. */
  private hideMine(): void {
    if (!this.mine) { this.applyShow(); return; }
    this.mine = false;
    this.mineEl.hidden = true;
    this.pulseUntil = -1;
    this.root.classList.remove('pulse', 'done');
    this.lastFill = -1;
    this.applyShow();
  }

  private hide(): void {
    this.mine = false;
    this.mineEl.hidden = true;
    this.pulseUntil = -1;
    this.lastFill = -1;
    this.root.classList.remove('pulse', 'done');
    this.clearMates();
    this.applyShow();
  }

  private applyShow(): void {
    // 2026-09-08: 시뮬레이션 훈련장에는 계약이 없다 — 함선 안에서 받아 둔 계약이 사격 연습 화면에 따라 붙던
    //   것을 여기서 끊는다 (진행도 자체는 meta/ 가 훈련장에서 올리지 않는다; 이건 표시만).
    const training = this.ctx?.missionMode === 'training';
    const show = !training && (this.mine || this.mateCount > 0);
    if (show === this.showing) return;
    this.showing = show;
    toggleClass(this.root, 'show', show);
  }

  /* ── squad rows ────────────────────────────────────────────────────────── */

  private clearMates(): void {
    this.mateCount = 0;
    this.matesEl.hidden = true;
    for (const r of this.mateRows) { r.root.hidden = true; r.key = ''; }
  }

  private mateRow(i: number): MateRow {
    let r = this.mateRows[i];
    if (r) return r;
    const root = el('div', { cls: 'mrow', parent: this.matesEl });
    const top = el('div', { cls: 'top', parent: root });
    const name = el('span', { cls: 'who', text: '', parent: top });
    const num = el('span', { cls: 'num', text: '', parent: top });
    const contract = el('div', { cls: 'ct', text: '', parent: root });
    const bar = el('div', { cls: 'bar', parent: root });
    const fill = el('div', { cls: 'fill', parent: bar });
    r = { root, name, contract, num, fill, key: '' };
    this.mateRows[i] = r;
    return r;
  }

  /** Rebuild the 분대 계약 rows from `ctx.meta.getSquadContracts()` (names / slot colours from `ctx.net`). */
  private refreshMates(ctx: GameContext): void {
    const meta = ctx.meta;
    const list = meta && typeof meta.getSquadContracts === 'function' ? meta.getSquadContracts() : [];
    if (list.length === 0) {
      if (this.mateCount > 0) this.clearMates();
      this.applyShow();
      return;
    }
    const net = ctx.net;
    let i = 0;
    for (const entry of list) {
      if (i >= 3) break;                                   // at most the other three members
      const def = CONTRACT_DEFS.find((d) => d.id === entry.id);
      if (!def) continue;
      const lp = net?.getLobbyPlayer?.(entry.peer) ?? null;
      const ref = net?.getRemotePlayer?.(entry.peer) ?? null;
      const name = lp?.name ?? ref?.name ?? '분대원';
      const slot = lp?.slot ?? ref?.slot ?? 0;
      const p = Math.floor(entry.progress);
      const done = p >= def.target && def.target > 0;
      const key = `${name}|${slot}|${def.id}|${p}`;
      const row = this.mateRow(i++);
      if (key !== row.key) {
        row.key = key;
        row.root.hidden = false;
        row.root.style.setProperty('--sc', NET_SLOT_COLORS_CSS[slot] ?? '#fff');
        setText(row.name, name);
        setText(row.contract, def.name);
        setText(row.num, `${p.toLocaleString('ko-KR')} / ${def.target.toLocaleString('ko-KR')}`);
        row.fill.style.transform = `scaleX(${(def.target > 0 ? Math.min(1, p / def.target) : 0).toFixed(4)})`;
        toggleClass(row.root, 'done', done);
      }
    }
    for (let k = i; k < this.mateRows.length; k++) {
      const r = this.mateRows[k];
      if (!r.root.hidden) { r.root.hidden = true; r.key = ''; }
    }
    this.mateCount = i;
    this.matesEl.hidden = i === 0;
    this.applyShow();
  }

  /** One compare per frame: drops the progress pulse on sim time and repaints the squad rows when they changed. */
  update(ctx: GameContext): void {
    if (this.pulseUntil >= 0 && ctx.time >= this.pulseUntil) {
      this.pulseUntil = -1;
      this.root.classList.remove('pulse');
    }
    // `meta:squadContract` only fires on a real change (the sender dedupes on `{id}|{floor(progress)}`), so a
    // one-frame-late repaint is all this needs — no polling.
    if (!this.mateDirty) return;
    this.mateDirty = false;
    this.refreshMates(ctx);
  }

  /** Whether the panel is up (debug). */
  get isShowing(): boolean { return this.showing; }
  /** Whether the progress pulse is running (debug). */
  get isPulsing(): boolean { return this.pulseUntil >= 0; }
  /** Squad contract rows currently drawn (debug). */
  get mateRowCount(): number { return this.mateCount; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
