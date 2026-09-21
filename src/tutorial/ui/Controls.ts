import type { Input, KeyBindings } from '@/shared';
import { Keys, paintKeycap, renderKeyText } from '@/shared';
import { CONTROL_SECTIONS, CONTROLS_TITLE_KO, hintPairs, type ControlHint, type ControlSection } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Controls.ts — **the right-side control guide** (2026-09-14).
 *
 * Its owner and its place differ from the bottom-right key guide (`ui/hud/KeyGuide`, `.key-guide`) — that one is "the
 * keys of the **screen** open right now" and changes every time a screen opens or closes, while this one is "the
 * controls used in the current **stretch**".
 *
 * **2026-09-14 3rd pass (user's decision) — replacement, not accumulation.** Learnt rows only piled up, so by the
 * end of a raid eight rows filled the right side and the key being learnt was buried among them. Now one `set(hints)`
 * takes 「every row visible in this step」 and **removes what is missing · adds what is new · relabels the survivors**.
 * Row elements are not remade, so a surviving row never flickers when the step changes, and a label that follows the
 * stance (`앉기` ↔ `일어서기`) goes the same way.
 *
 * **2026-09-14 2nd pass (user's decision) — a section per control · two pairs on one row · the place readjusted.**
 *   ① Rows pile up **in section order, not learning order** — the order is `model.CONTROL_SECTIONS` alone
 *      (`stance` joined on 2026-09-16, `meta` on 2026-09-17; nothing here counts them).
 *      A section box **is made when its first row arrives** and is inserted in its own place, so an empty section is
 *      not in the DOM at all — that lets the divider be one line `.tut-ctl-sec + .tut-ctl-sec` (`:empty` plus an
 *      adjacent selector counts a hidden box and leaves a line at the very top). **Unlocking is still per row.**
 *   ② One row can hold several pairs (`ControlHint.more` — `LMB 사격 / RMB 정조준`).
 *   ③ The place is in `tutorial.css` — moved **above** the bottom-right weapon panel · quick slots.
 *
 * Key labels are **read from `Keys` at draw time** (`docs/CONTROLS.md`: never cache a key in a module constant).
 * On a rebinding `TutorialSystem` calls `relabel()` from `input:bindingsChanged`.
 *
 * ⚠ The keycap modifier uses `.keycap.kc-hold` as it is — never make a new class with the same name as a HUD widget
 * (the 2026-09-10 `kc-hold` accident: `.hold` collided with the crosshair hold ring and the keycaps vanished whole).
 *
 * **2026-09-15 (user's decision) — shared keycaps · token-text rows.**
 *   ① Keycaps are painted by `shared/keycap.paintKeycap` — a mouse button comes out as a mouse drawing instead of the
 *      text `LMB`, the same as in the key guide · the interaction prompt.
 *   ② A `ControlHint.text` row draws no pairs: `renderKeyText` **inserts the keycaps inside the sentence**
 *      (`.tut-ctl.is-text`) — e.g. `{QUICK:hold}를 꾹 눌러 수류탄 장착 후,{br}{FIRE:hold} 수류탄 던지기`. Re-resolved on a rebinding.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Cap { el: HTMLElement; action: keyof KeyBindings; hold: boolean }

interface Row {
  el: HTMLElement;
  caps: Cap[];
  hint: ControlHint;
  /** The text box of a token-text row (`hint.text`) — null on a pair row. */
  textEl: HTMLElement | null;
  /** The keycaps lit while held down and their key codes (2026-09-16) — recollected on every paint (`relabelRow`). */
  lit: LitCap[];
}

/** A press-highlight target — the keycap element · its key code (`Keys[action]` · `MouseN`) · whether it is lit. */
interface LitCap { el: HTMLElement; code: string; on: boolean }

/**
 * The keycap highlight class for the length of a press (2026-09-16, user's decision — 「pressing a key shown on the
 * panel turns that keycap orange」). The `tut-` prefix never collides with a HUD widget class (the `.kc-hold`
 * accident, header comment above).
 */
const CAP_DOWN = 'tut-kc-down';

const sectionOf = (h: ControlHint): ControlSection => h.section ?? 'gear';

export class TutorialControls {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly rows = new Map<string, Row>();
  /** The section boxes — made **only when a row arrives** (an empty section is not in the DOM → no divider). */
  private readonly sections = new Map<ControlSection, HTMLElement>();
  private _visible = false;
  /** What `show()` asked for (it is actually shown only while at least one row exists). */
  private want = false;
  /**
   * The folded shape's one row (2026-09-17, user's decision — the `]` of 출격 안내's raid). Folded, the head · the
   * row list hide and only this row stands in the same place (`.tut-controls.is-folded`). The panel element stays, so
   * the rule that has the toast stack measure its bottom (`ui/hud/Notifications`) lives on unchanged.
   */
  private readonly fold: HTMLElement;
  private foldText = '';
  private _folded = false;

  constructor(parent: HTMLElement) {
    const root = this.root = document.createElement('div');
    root.className = 'tut-controls';
    root.hidden = true;

    const head = document.createElement('div');
    head.className = 'ui-label tut-ctl-head';
    head.textContent = CONTROLS_TITLE_KO;

    this.list = document.createElement('div');
    this.list.className = 'tut-ctl-list';

    this.fold = document.createElement('div');
    this.fold.className = 'tut-ctl-fold';
    this.fold.hidden = true;

    root.append(head, this.list, this.fold);
    parent.appendChild(root);
  }

  get folded(): boolean { return this._folded; }

  /** Fold / unfold (2026-09-17). `text` is the folded row's keycap token sentence (`{GUIDE_TOGGLE} 조작 가이드 표시`). */
  setFolded(on: boolean, text: string): void {
    if (on === this._folded && text === this.foldText) return;
    this._folded = on;
    if (text !== this.foldText) { this.foldText = text; renderKeyText(this.fold, text); }
    this.fold.hidden = !on;
    this.root.classList.toggle('is-folded', on);
  }

  get visible(): boolean { return this._visible; }
  /** The ids of the rows piled up right now (the save · smokes). */
  get ids(): string[] { return [...this.rows.keys()]; }

  /**
   * Swaps in **every row visible in this step** (2026-09-14 3rd pass). A surviving row keeps its element and only its
   * wording changes, so nothing flickers on a step change; a row that is gone vanishes where it stood. Empty section
   * boxes go with it — the divider is one line `.tut-ctl-sec + .tut-ctl-sec`, so a leftover box draws a line at
   * the very top.
   */
  set(hints: readonly ControlHint[]): void {
    const want = new Set(hints.map((h) => h.id));
    for (const [id, row] of [...this.rows]) {
      if (want.has(id)) continue;
      row.el.remove();
      this.rows.delete(id);
    }
    for (const h of hints) {
      const have = this.rows.get(h.id);
      if (have) this.render(have, h);
      else this.add(h);
    }
    this.order(hints);
    this.prune();
    this.apply();
  }

  /** Adds one row — nothing happens when it is already there. */
  add(hint: ControlHint): void {
    if (this.rows.has(hint.id)) return;
    const el = document.createElement('div');
    el.className = 'tut-ctl is-new';
    el.dataset.hint = hint.id;
    const row: Row = { el, caps: [], hint, textEl: null, lit: [] };
    this.render(row, hint);
    this.sectionEl(sectionOf(hint)).appendChild(el);
    this.rows.set(hint.id, row);
    // The new-row highlight runs once — after the animation it is an ordinary row (a record, not a notification)
    window.setTimeout(() => el.classList.remove('is-new'), 1400);
    // ⚠ `show(true)` is never called here (2026-09-14 2nd pass) — the guide must stay folded while the inventory
    //   screen is open, and a row added meanwhile would raise the panel by itself. Visibility follows `show()` alone.
    this.apply();
  }

  /** Rebuilds a row's contents (keycaps · wording) — the element itself stays, so its animation · place are kept. */
  private render(row: Row, hint: ControlHint): void {
    row.hint = hint;
    row.caps = [];
    row.textEl = null;
    const isText = hint.text !== undefined;
    row.el.classList.toggle('is-text', isText);
    if (isText) {
      // A token-text row (2026-09-15) — the keycaps go inside the sentence. `relabelRow` draws the text
      //   (the same path as a rebinding).
      const text = document.createElement('span');
      text.className = 'tut-ctl-text';
      row.textEl = text;
      row.el.replaceChildren(text);
      this.relabelRow(row);
      return;
    }
    const frag = document.createDocumentFragment();
    hintPairs(hint).forEach((pair, i) => {
      if (i > 0) frag.appendChild(Object.assign(document.createElement('span'), { className: 'tut-ctl-sep' }));
      const keys = document.createElement('span');
      keys.className = 'tut-ctl-keys';
      for (const action of pair.keys) {
        const cap = document.createElement('span');
        cap.className = 'keycap';
        keys.appendChild(cap);
        row.caps.push({ el: cap, action, hold: !!pair.hold });
      }
      const label = document.createElement('span');
      label.className = 'tut-ctl-label';
      label.textContent = pair.label;
      frag.append(keys, label);
    });
    row.el.replaceChildren(frag);
    this.relabelRow(row);
  }

  /**
   * Matches the row order inside a section to the table (already matching = the DOM is not touched — moving a row
   * replays its animation).
   */
  private order(hints: readonly ControlHint[]): void {
    for (const [section, box] of this.sections) {
      const want = hints.filter((h) => sectionOf(h) === section)
        .map((h) => this.rows.get(h.id)?.el).filter((el): el is HTMLElement => !!el);
      const have = [...box.children];
      if (have.length === want.length && want.every((el, i) => have[i] === el)) continue;
      box.replaceChildren(...want);
    }
  }

  /** Clears a section box with no rows left. */
  private prune(): void {
    for (const [section, box] of [...this.sections]) {
      if (box.childElementCount > 0) continue;
      box.remove();
      this.sections.delete(section);
    }
  }

  /** That section's box — with none it is made and inserted **in the place section order asks for**. */
  private sectionEl(section: ControlSection): HTMLElement {
    const have = this.sections.get(section);
    if (have) return have;
    const el = document.createElement('div');
    el.className = 'tut-ctl-sec';
    el.dataset.sec = section;
    const at = CONTROL_SECTIONS.indexOf(section);
    let before: HTMLElement | null = null;
    for (const s of CONTROL_SECTIONS) {
      if (CONTROL_SECTIONS.indexOf(s) <= at) continue;
      const next = this.sections.get(s);
      if (next) { before = next; break; }
    }
    this.list.insertBefore(el, before);
    this.sections.set(section, el);
    return el;
  }

  /** Several rows at once (restoring from the save — with no highlight). */
  restore(hints: readonly ControlHint[]): void {
    this.set(hints);
    for (const h of hints) this.rows.get(h.id)?.el.classList.remove('is-new');
  }

  /** A rebinding — repaints the keycaps from the live `Keys` (a token-text row is re-resolved whole). */
  relabel(): void {
    for (const row of this.rows.values()) this.relabelRow(row);
    if (this.foldText) renderKeyText(this.fold, this.foldText);
  }

  private relabelRow(row: Row): void {
    if (row.textEl) {
      renderKeyText(row.textEl, row.hint.text ?? '');
    } else {
      // `paintKeycap` does not touch the DOM when nothing changed (the `data-kc` stamp)
      for (const cap of row.caps) paintKeycap(cap.el, Keys[cap.action], { hold: cap.hold });
    }
    this.collectLit(row);
  }

  /**
   * Collects that row's keycaps — on a pair row and a token-text row alike every keycap goes through `paintKeycap`,
   * so the key code is read from the `data-kc` (`code|hold`) stamp. A label that is not a key (`더블클릭`) is never
   * pressed and stays off. A freshly painted element carries no highlight.
   */
  private collectLit(row: Row): void {
    row.lit = [];
    for (const el of row.el.querySelectorAll<HTMLElement>('.keycap')) {
      const stamp = el.dataset.kc ?? '';
      const code = stamp.slice(0, stamp.lastIndexOf('|'));
      if (!code) continue;
      row.lit.push({ el, code, on: el.classList.contains(CAP_DOWN) });
    }
  }

  /**
   * Every frame (2026-09-16, user's decision) — a **key shown on the panel** lights its keycap orange while it is
   * held down (mouse buttons too — `Input` writes `MouseN` as a key code as well). A key not on the panel lights
   * nothing, and only a cap that changed has its class touched. A hidden panel is not read — a cap left lit goes out
   * on the first frame after it comes back.
   */
  update(input: Input): void {
    if (!this._visible) return;
    for (const row of this.rows.values()) {
      for (const cap of row.lit) {
        const on = input.isDown(cap.code);
        if (on === cap.on) continue;
        cap.on = on;
        cap.el.classList.toggle(CAP_DOWN, on);
      }
    }
  }

  /** Show / hide. With no rows at all it always hides. */
  show(on: boolean): void {
    this.want = on;
    this.apply();
  }

  private apply(): void {
    const want = this.want && this.rows.size > 0;
    if (want === this._visible) return;
    this._visible = want;
    this.root.hidden = !want;
  }

  /** The track ended — the next time it comes on, rows pile up from the beginning. */
  clear(): void {
    this.rows.clear();
    this.sections.clear();
    this.list.replaceChildren();
    this.show(false);
  }

  dispose(): void { this.root.remove(); }
}
