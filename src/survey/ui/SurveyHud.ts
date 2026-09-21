/**
 * src/survey/ui/SurveyHud.ts — the survey camera's own HUD (class prefix `.sv-`).
 *
 * The rectangle frame (twice as large while zoomed), a REC mark while recording, the zoom readout, and one tag per
 * subject kind in the frame (name · account % · a note). Pure DOM under `ctx.uiRoot`, never intercepts the pointer.
 *
 * **No layout reads.** The frame is sized in `vh` from csv (`--sv-h` · `--sv-w`, set once) and tags are placed in
 * percent of the root from the NDC the system projected — nothing here asks the DOM for a size. Every write is
 * skipped when the value did not change, so a still frame writes nothing.
 */
import { SURVEY_LABEL_MAX, SURVEY_RECT_ASPECT, SURVEY_RECT_H_FRAC, SURVEY_ZOOM_RECT_MUL } from '@/shared';
import type { TagState } from '../model';
import '../survey.css';

const NOTE_KO: Readonly<Record<TagState, string>> = {
  rec: '기록 중', idle: '', cut: '프레임 밖', cap: '이번 레이드 한도', done: '완료',
};

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

interface Tag {
  root: HTMLElement;
  name: HTMLElement;
  pct: HTMLElement;
  note: HTMLElement;
  fill: HTMLElement;
  shown: boolean;
  nameText: string;
  pctText: string;
  state: TagState | '';
  x: number;
  y: number;
  fillW: number;
}

export class SurveyHud {
  private readonly root: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly zoomEl: HTMLElement;
  private readonly tags: Tag[] = [];
  private shown = false;
  private zoomed = false;
  private rec = false;
  private zoomText = '';

  constructor(parent: HTMLElement) {
    this.root = el('div', 'sv-hud', parent);
    this.root.style.setProperty('--sv-h', `${SURVEY_RECT_H_FRAC * 100}vh`);
    this.root.style.setProperty('--sv-w', `${SURVEY_RECT_H_FRAC * SURVEY_RECT_ASPECT * 100}vh`);
    this.root.style.setProperty('--sv-zoom-mul', String(SURVEY_ZOOM_RECT_MUL));
    this.frame = el('div', 'sv-frame', this.root);
    for (const c of ['tl', 'tr', 'bl', 'br']) el('i', `sv-corner ${c}`, this.frame);
    const recEl = el('div', 'sv-rec', this.frame);
    recEl.textContent = 'REC';
    this.zoomEl = el('div', 'sv-zoom', this.frame);
    const layer = el('div', 'sv-tags', this.root);
    for (let i = 0; i < SURVEY_LABEL_MAX; i++) {
      const root = el('div', 'sv-tag', layer);
      const head = el('div', 'sv-tag-head', root);
      const name = el('span', 'sv-tag-name', head);
      const pct = el('span', 'sv-tag-pct', head);
      const bar = el('div', 'sv-tag-bar', root);
      const fill = el('i', '', bar);
      const note = el('div', 'sv-tag-note', root);
      this.tags.push({ root, name, pct, note, fill, shown: false, nameText: '', pctText: '', state: '', x: NaN, y: NaN, fillW: -1 });
    }
  }

  setVisible(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.root.classList.toggle('is-on', on);
    if (!on) this.hideTagsFrom(0);
  }

  /** Zoomed = aim held (the frame doubles); `zoom` is the camera's magnification. */
  setZoom(zoomed: boolean, zoom: number): void {
    if (zoomed !== this.zoomed) {
      this.zoomed = zoomed;
      this.root.classList.toggle('is-zoom', zoomed);
    }
    const text = zoomed ? `${Number.isInteger(zoom) ? zoom.toFixed(0) : zoom.toFixed(1)}×` : '';
    if (text !== this.zoomText) { this.zoomText = text; this.zoomEl.textContent = text; }
  }

  setRecording(on: boolean): void {
    if (on === this.rec) return;
    this.rec = on;
    this.root.classList.toggle('is-rec', on);
  }

  /** Tag `i`: `x` / `y` are NDC (−1 … 1, y up); `progress` 0 … 1 (account). */
  setTag(i: number, name: string, progress: number, state: TagState, x: number, y: number): void {
    const t = this.tags[i];
    if (!t) return;
    if (!t.shown) { t.shown = true; t.root.classList.add('is-on'); }
    if (name !== t.nameText) { t.nameText = name; t.name.textContent = name; }
    const pctText = `${Math.floor(progress * 100 + 1e-6)}%`;
    if (pctText !== t.pctText) { t.pctText = pctText; t.pct.textContent = pctText; }
    const w = Math.round(progress * 1000) / 10;
    if (w !== t.fillW) { t.fillW = w; t.fill.style.width = `${w}%`; }
    if (state !== t.state) {
      if (t.state) t.root.classList.remove(`is-${t.state}`);
      t.state = state;
      t.root.classList.add(`is-${state}`);
      t.note.textContent = NOTE_KO[state];
    }
    // percent of the root, rounded to 0.05 % so a steady view writes nothing
    const px = Math.round((x + 1) * 1000) / 20;
    const py = Math.round((1 - y) * 1000) / 20;
    if (px !== t.x) { t.x = px; t.root.style.left = `${px}%`; }
    if (py !== t.y) { t.y = py; t.root.style.top = `${py}%`; }
  }

  hideTagsFrom(i: number): void {
    for (let k = i; k < this.tags.length; k++) {
      const t = this.tags[k];
      if (!t.shown) continue;
      t.shown = false;
      t.root.classList.remove('is-on');
    }
  }

  dispose(): void { this.root.remove(); }
}
