import type { TutorialGaugeInfo } from '@/shared';
import { TUTORIAL_STEP_DELAY_S, renderKeyText, tutorialCountLabel } from '@/shared';
import { OPTIONAL_PREFIX_KO, type TutorialObjective } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Panel.ts — **the tutorial objective panel** (top left).
 *
 * Same place · same grain as the raid's contract panel (`ui/hud/ContractPanel`), but it does not use that code — the
 * contract panel is gameplay-layer and hides in the ship, this one shows **only in the ship and the tutorial raid**.
 *
 * **2026-09-14 2nd pass (user's decision) — it looks like a quest panel.**
 *
 *   [◇] 조작 안내              ← the track name (accent colour) + the quest glyph
 *    ☐  앞으로 이동             ← an objective row (checkbox + wording)
 *    ☐  (선택) 시체에서 수류탄 획득   ← an optional row (`model.OPTIONAL_PREFIX_KO` + wording)
 *   ▓▓▓▓▓░░░░░░                ← the whole track's progress
 *
 * Three things changed:
 *   ① **the `조작 안내 n / m` text label is gone** — the progress bar below takes that place (progress is still
 *      `index / count`, i.e. **the step count inside the track**).
 *   ② **the title + subtitle two lines became a list of objective rows**. One step can hold several objectives and
 *      some of them are optional (`StepDef.objectives`; with none the subtitle line is the only required objective).
 *   ③ **there is no skip button** — skipping moved to the ESC menu (`TutorialRef.skipTrack`). The intro card's
 *      `건너뛰기` is unchanged. `setLifted` / `is-lifted` stay as a state marker (a smoke reads them).
 *
 * **2026-09-14 3rd pass — sequential reveal.** An objective row that is not open yet **does not even come over**: the
 * picking is a pure function `model.visibleObjectives(list, done)` and `TutorialSystem` passes `show()` only the list
 * it let through. So this file only knows 「draw the rows it was given」; when a row opens `sameIds` differs and the
 * panel rebuilds — `markDone`'s half a beat below catches that timing (the new row appears **after** the check ·
 * the strike-through are drawn).
 *
 * **Half a beat is held so the completion animation shows.** When a step advances the system first draws the check ·
 * the strike-through on that step's required objectives with `markDone()`; the next step's `show()`, arriving right
 * after, is deferred **inside the panel** for `TUTORIAL_STEP_DELAY_S` (`data/constants.csv`) — the window the spotlight · the
 * floor guide already use. The step machine's timing does not change a character (only **the drawing** is deferred).
 *
 * **2026-09-09 — the panel is always above the screens.** Its z-index is fixed at 79 regardless of `is-lifted`
 * (`tutorial.css`). It used to be 24 and rose to 79 only while focusing, so every moment the focus missed its target
 * the inventory screen (`.inv-root`, z 50, blurred backdrop) covered the panel **whole** and the objectives vanished.
 *
 * **2026-09-15 (user's decision) — the keycaps and optional objectives inside an objective row are not grey.**
 *   ① An objective's wording holds **keycap tokens** (`{QUICK:hold}` …) — `shared/keycap.renderKeyText` puts the same
 *      keycap into **both** the text layer (`.tut-obj-txt`) and the strike-through layer (`.tut-obj-strike`): the two
 *      layers must match to the character or the strike misses its row; `relabel()` redraws both on a rebinding.
 *   ② **only a completed row is grey** — an optional objective keeps the required colour until done (`(선택)` stays).
 *
 * **2026-09-15 2nd pass (user's decision) — the `(n/m)` of a counted objective.** The count is not in the wording but
 * in `TutorialObjective.count` (`벌레 처치` + `count: 2` → `벌레 처치 (0/2)`). When progress changes `setCounts` swaps
 * **that number node alone** — rebuilding the row restarts the check's left→right drawing and the strike-through's
 * `clip-path` transition from the beginning every time. Struck on completion the number stays `(2/2)` (the row
 * itself stands unchanged for half a beat after the step advances).
 *
 * **2026-09-18 (user's decision) — the step whose bar measures the objective.** On 출격 안내's raid 「which step
 * is this」 says nothing (there are only two). There alone the bar measures the **loot value** (`PanelView.gauge`)
 * and a number line (`.tut-bar-n`) sits above it — the fill clamps at 1, the text is **the real value**
 * (`1,400 C / 1,000 C`). Every other step · track is unchanged.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Everything one `show()` draws. */
export interface PanelView {
  /** The track name (`model.TRACK_LABEL_KO` — `조작 안내` · `함선 안내` · `증축 안내` · `출격 안내`). */
  track: string;
  objectives: readonly TutorialObjective[];
  /** The ids of completed objectives. */
  done: ReadonlySet<string>;
  /**
   * The count of a counted objective (`TutorialObjective.count`) — objective id → count. A missing id counts as 0.
   */
  counts: Readonly<Record<string, number>>;
  /** The 1-based index within the track · the step count (the progress bar). */
  index: number;
  count: number;
  /**
   * When the progress bar measures **the objective itself rather than the step count** (2026-09-18, user's decision —
   * for 출격 안내's raid progress is 「how much was carried」, not 「which step is this」). The fill clamps at 1, the number
   * label above the bar writes **the value as it came** (`label` — already fully written by
   * `model.creditGaugeLabel`). null · omitted = `index / count` as before.
   */
  gauge?: TutorialGaugeInfo | null;
}

interface Row {
  el: HTMLElement;
  /** The text · strike-through layers and the wording drawn in both (tokens kept — re-resolved on a rebinding). */
  txt: HTMLElement;
  strike: HTMLElement;
  text: string;
  /** The objective count (`TutorialObjective.count`) — null with none; with one both layers get a ` (at/total)`. */
  total: number | null;
  /** The count drawn right now. */
  at: number;
  /** The unit of the count (2026-09-17, `TutorialObjective.countUnit`) — with one the shape is ` (420 / 1,000 C)`. */
  unit?: string;
}

/** The quest glyph — no external assets, so inline SVG (a diamond + a centre dot). */
const QUEST_ICON = '<svg class="tut-quest-ico" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path class="tut-quest-d" d="M8 1.1 14.9 8 8 14.9 1.1 8Z"/>'
  + '<path class="tut-quest-b" d="M8 4.7v4.1"/><circle class="tut-quest-p" cx="8" cy="11.2" r="0.95"/></svg>';

/** The checkbox — a frame + a check drawn left→right (`stroke-dashoffset`, `tutorial.css`). */
const CHECK_SVG = '<svg class="tut-obj-box" viewBox="0 0 16 16" aria-hidden="true">'
  + '<rect class="tut-obj-frame" x="1.6" y="1.6" width="12.8" height="12.8"/>'
  + '<path class="tut-obj-tick" d="M4 8.3 6.9 11.2 12.2 5.1"/></svg>';

/**
 * The tag of a counted objective (2026-09-15 2nd pass, user's decision — `벌레 처치 (1/2)`). Slightly fainter than the
 * body (`.tut-obj-n`). The count is held by **its own node** (`setCounts`), not by the wording, so the row is not
 * rebuilt while counting — which is why `rowKey` below holds no `count` either.
 */
// 2026-09-18: the wording is made in one place, `shared/tutorial.tutorialCountLabel` — the map draws that row with
//   the same function (writing it here too drifted the map to `1000 / 1000 C`). Only the brackets are this panel's.
const countText = (at: number, total: number, unit?: string): string => ` (${tutorialCountLabel(at, total, unit)})`;

export class TutorialPanel {
  readonly root: HTMLElement;
  private readonly trackEl: HTMLElement;
  private readonly list: HTMLElement;
  private readonly fill: HTMLElement;
  /** The number label above the progress bar (2026-09-18) — up only when there is a `gauge`. */
  private readonly num: HTMLElement;
  private readonly rows = new Map<string, Row>();
  /**
   * The `id + wording` of the objective rows drawn right now (in order) — an identical list is not rebuilt, so the
   * animation is never cut.
   */
  private ids: string[] = [];
  private _visible = false;
  private _lifted = false;
  /** New objective rows are deferred while the completion animation shows. */
  private holdTimer = 0;
  private pending: PanelView | null = null;

  constructor(parent: HTMLElement) {
    const root = this.root = document.createElement('div');
    root.className = 'tut-panel';
    root.hidden = true;

    const head = document.createElement('div');
    head.className = 'tut-head';
    head.innerHTML = QUEST_ICON;
    this.trackEl = document.createElement('span');
    this.trackEl.className = 'tut-track';
    head.appendChild(this.trackEl);

    this.list = document.createElement('div');
    this.list.className = 'tut-objs';

    /*
     * 2026-09-18: the number label right above the progress bar — up only while the bar measures the objective itself
     * (`gauge`). Normally (the step count) it hides.
     */
    this.num = document.createElement('div');
    this.num.className = 'tut-bar-n ui-mono';
    this.num.hidden = true;

    const bar = document.createElement('div');
    bar.className = 'tut-bar';
    this.fill = document.createElement('i');
    bar.appendChild(this.fill);

    root.append(head, this.list, this.num, bar);
    parent.appendChild(root);
  }

  get visible(): boolean { return this._visible; }

  /**
   * The spotlight is up — attaches `is-lifted`. Since 2026-09-09 it is **only a state marker**; the z-index is always
   * 79 (so the panel never ends up under a screen). Kept for call-site · smoke compatibility.
   */
  setLifted(on: boolean): void {
    if (on === this._lifted) return;
    this._lifted = on;
    this.root.classList.toggle('is-lifted', on);
  }

  /**
   * Marks objectives done (**only the rows drawn now**). When at least one is newly checked the next `show()` is
   * held for `TUTORIAL_STEP_DELAY_S` so that animation shows — all this half a beat does is keep the check · the
   * strike-through of the moment a step advances from being wiped one frame later.
   */
  markDone(ids: readonly string[]): void {
    let any = false;
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row || row.el.classList.contains('is-done')) continue;
      row.el.classList.add('is-done');
      any = true;
    }
    if (!any) return;
    window.clearTimeout(this.holdTimer);
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = 0;
      const next = this.pending;
      this.pending = null;
      if (next) this.apply(next);
    }, TUTORIAL_STEP_DELAY_S * 1000);
  }

  show(view: PanelView): void {
    if (!this._visible) { this._visible = true; this.root.hidden = false; }
    // The progress bar · the track name are **not deferred** — "one notch further" is itself the reward. Only the
    //   objective rows are.
    if (this.trackEl.textContent !== view.track) this.trackEl.textContent = view.track;
    this.setGauge(view.gauge ?? null, view.index, view.count);
    if (this.holdTimer !== 0 && !sameIds(this.ids, view.objectives)) { this.pending = view; return; }
    this.apply(view);
  }

  /** Actually draws the objective rows (after the deferral has passed). */
  private apply(view: PanelView): void {
    if (!sameIds(this.ids, view.objectives)) this.build(view.objectives);
    for (const o of view.objectives) {
      this.rows.get(o.id)?.el.classList.toggle('is-done', view.done.has(o.id));
    }
    this.setCounts(view.counts);
  }

  /**
   * Fixes **the progress bar** (2026-09-18, user's decision).
   *   • With `g` the bar measures that objective — the fill clamps at 1 (going past never overflows it), the number
   *     is **the real value** (`1,400 C / 1,000 C`): `1,000 C / 1,000 C` past the goal reads as a vanished surplus.
   *   • With `g` null it is **the step count** as before — the number label hides. Without `index` · `count`
   *     the bar is left alone (the poll that counts loot need not report the step count again every time).
   */
  setGauge(g: TutorialGaugeInfo | null, index?: number, count?: number): void {
    if (g) {
      const frac = g.total > 0 ? Math.max(0, Math.min(1, g.at / g.total)) : 0;
      this.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
      if (this.num.textContent !== g.label) this.num.textContent = g.label;
      if (this.num.hidden) this.num.hidden = false;
      return;
    }
    if (!this.num.hidden) { this.num.hidden = true; this.num.textContent = ''; }
    if (index === undefined || count === undefined) return;
    const frac = count > 0 ? Math.max(0, Math.min(1, index / count)) : 0;
    this.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
  }

  /**
   * Fixes the count of a counted objective (2026-09-15 2nd pass, user's decision — `벌레 처치 (1/2)`).
   *
   * **The number node alone is swapped, the row is not rebuilt** — going back through `build()` restarts the check's
   * left→right animation and the strike-through's `clip-path` transition from the start (a completed row is struck
   * again on every kill). The two layers (text · strike-through) must match to the character for the strike to sit on
   * its own row, so **both nodes are fixed together**.
   */
  setCounts(counts: Readonly<Record<string, number>>): void {
    for (const [id, row] of this.rows) {
      if (row.total === null) continue;
      const n = Math.max(0, Math.min(row.total, Math.round(counts[id] ?? 0)));
      if (n === row.at) continue;
      row.at = n;
      const label = countText(n, row.total, row.unit);
      for (const host of [row.txt, row.strike]) {
        const el = host.querySelector('.tut-obj-n');
        if (el) el.textContent = label;
      }
    }
  }

  private build(objectives: readonly TutorialObjective[]): void {
    this.rows.clear();
    this.list.replaceChildren();
    this.ids = objectives.map(rowKey);
    for (const o of objectives) {
      const el = document.createElement('div');
      el.className = o.optional ? 'tut-obj is-optional' : 'tut-obj';
      el.dataset.obj = o.id;
      el.innerHTML = CHECK_SVG;
      const text = (o.optional ? OPTIONAL_PREFIX_KO : '') + o.text;
      const label = document.createElement('span');
      label.className = 'tut-obj-label';
      /*
       * The strike-through **lays the very same text down one more layer** (`.tut-obj-strike`,
       * `text-decoration: line-through`) and peels it left→right with `clip-path`. A single horizontal bar on
       * `::after` would draw a line through mid-air on an
       * **objective wrapped onto two rows** — this wording wraps often even at the panel's full width
       * (`.tut-panel` in `tutorial.css`).
       * 2026-09-15: both layers are drawn with `renderKeyText` — the layers overlap only if the keycaps also line up.
       */
      const txt = document.createElement('span');
      txt.className = 'tut-obj-txt';
      const strike = document.createElement('span');
      strike.className = 'tut-obj-strike';
      strike.setAttribute('aria-hidden', 'true');
      label.append(txt, strike);
      el.appendChild(label);
      const row: Row = { el, txt, strike, text, total: o.count ?? null, at: 0, unit: o.countUnit };
      this.paint(row);
      this.list.appendChild(el);
      this.rows.set(o.id, row);
    }
  }

  /**
   * Draws a row's two layers (text · strike-through) with **the same content** — the keycaps and `(n/m)` must stand
   * in the same place for the strike to be drawn on its own row (`clip-path` peels the text layer left→right).
   */
  private paint(row: Row): void {
    for (const host of [row.txt, row.strike]) {
      renderKeyText(host, row.text);
      if (row.total === null) continue;
      const n = document.createElement('i');
      n.className = 'tut-obj-n';
      n.textContent = countText(row.at, row.total, row.unit);
      host.appendChild(n);
    }
  }

  /** A rebinding — redraws the objective rows' keycaps from the live `Keys` (done marks · elements · counts stay). */
  relabel(): void {
    for (const row of this.rows.values()) this.paint(row);
  }

  hide(): void {
    this.setLifted(false);
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    this.pending = null;
    if (!this._visible) return;
    this._visible = false;
    this.root.hidden = true;
  }

  dispose(): void {
    window.clearTimeout(this.holdTimer);
    this.root.remove();
  }
}

/** What identifies one row — the same id with changed wording is rebuilt. */
const rowKey = (o: TutorialObjective): string => `${o.id} ${o.text}`;

const sameIds = (ids: readonly string[], objectives: readonly TutorialObjective[]): boolean =>
  ids.length === objectives.length && objectives.every((o, i) => ids[i] === rowKey(o));
