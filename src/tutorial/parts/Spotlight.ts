import { TUTORIAL_DIM_FADE_S, TUTORIAL_STEP_DELAY_S, renderKeyText } from '@/shared';
import { RETARGET_INTERVAL } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/parts/Spotlight.ts — **UI focus**.
 *
 * Dims the whole screen and lights only the target element by punching a hole there. The hole is made of four `div`s
 * — fit the top · bottom · left · right plates to the target rect and the centre is left empty; those four plates
 * **eat clicks**. (One `clip-path` plate could draw it, but it eats the pointer over the hole too, or lets it all
 * through.) Only a ring and a short callout sit over the target, `pointer-events: none`, so lit clicks reach the UI.
 *
 * The target arrives as a list of CSS selectors and **the first one found** is used (they widen button → its row →
 * its panel: even if the screen is not drawn yet or its structure changed, at least the panel is lit). With none the
 * spotlight hides itself — it never leaves a dim screen on which nothing can be pressed.
 *
 * **2026-09-08 — union mode** (`union`). Sometimes the thing to guide is not one place but **an action spanning
 * several panes**: the drag that picks an item out of the bag and drops it in an equipment slot. Lighting a single
 * target buries the start or the end under a dim plate, and then **the drag can neither start nor drop**. Union mode
 * punches the rects of everything found **merged into one** — the hole four plates make is always one rectangle, so
 * the panes handed in have to touch for it to read as one connected shape (the equipment column and the bag really do
 * touch: `.inv-layout:not(.is-craft)`'s −24 px seam; since 2026-09-16 stash | equipment | bag all touch in the ship).
 *
 * **2026-09-09 — it lights half a beat late** (`TUTORIAL_STEP_DELAY_S`, `data/constants.csv`). From **the moment the
 * target appears** it waits that long, then raises plates · ring · callout at once — whether a step just moved on or
 * a craft row turned up late on opening the workbench. The new screen must show before the focus follows, or "what
 * opened" does not read. On lighting, the dim plates darken from transparent over `TUTORIAL_DIM_FADE_S`
 * (`.tut-spot.is-lit`, `--tut-dim-fade`) — a retarget within the step (`RETARGET_INTERVAL`) reuses the lit plates and
 * does not fade again. A vanished target (confirm popup · screen closed) waits and fades again when it returns.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Rect { x: number; y: number; w: number; h: number }

/**
 * The **first element actually drawn on screen** among those matching that selector.
 *
 * ⚠ `querySelector` **alone is not enough** (2026-09-14 4th pass — the bug where the `stats` step lit only the tab
 * row forever). The same screen can be in the DOM **twice**: the character sheet is drawn by the standalone overlay
 * `progression` puts up at boot (`.menu.char-sheet`, `[hidden]` = `display:none` while closed) and by the copy
 * inlined into the inventory's character tab (`SheetView`), both from the same `SheetBody`, and `progression` is
 * registered before `inventory`, so **the closed one comes first in document order**. `querySelector('.pg-confirm')`
 * therefore always picked the hidden copy, and with no rect that selector read as a whole miss and fell through to
 * the fallback selector behind it (`.inv-root .scr-tabs`) — a hole punched in the tab row with the character screen
 * open, while the ＋ button and the confirm button sat under a dim plate, so no point could be invested.
 *
 * The visibility test is the same two checks as before — `offsetParent` is unusable because it is null on a HUD
 * piece under a `position: fixed` ancestor that is perfectly visible, and the rect (`getClientRects`) alone is not
 * enough either: some closed screens fold with **`visibility:hidden`** rather than `display:none` (`.ship-manage`)
 * and keep their rect (2026-09-08).
 */
function firstShown(sel: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    if (el.getClientRects().length === 0) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    const q = el.getBoundingClientRect();
    if (q.width <= 0 || q.height <= 0) continue;
    return el;
  }
  return null;
}

/** The ＋ button token inside the callout (2026-09-16 2nd pass). */
const PLUS_TOKEN = '{+}';

/**
 * Draws the callout text (2026-09-16 2nd pass, user's decision — 「＋ 는 버튼 모양으로」). Key tokens (`{ACTION}` ·
 * `{ACTION:hold}`) are drawn as keycaps by `shared/keycap.renderKeyText`, and `{+}` as a small box resembling the
 * stat sheet's ＋ button (`.tut-spot-plus`). Text goes in as text nodes only (no HTML parsing).
 */
export function renderSpotText(host: HTMLElement, text: string): void {
  host.textContent = '';
  const parts = text.split(PLUS_TOKEN);
  parts.forEach((part, i) => {
    if (i > 0) {
      const plus = document.createElement('span');
      plus.className = 'tut-spot-plus';
      plus.textContent = '＋';
      host.appendChild(plus);
    }
    if (!part) return;
    const seg = document.createElement('span');
    renderKeyText(seg, part);
    host.appendChild(seg);
  });
}

/** The margin around the hole (px). */
const PAD = 6;

/**
 * 2026-09-08 — **what it yields to**. On some screens the button the spotlight lights raises a confirm popup on
 * top of it (`.sm-confirm` of building out a facility · starting the generator). The dim plates cover the whole
 * screen, so they cover that popup too and eat its clicks — following the guidance and then not being able to press
 * the next button is the worst state a tutorial has. With any of these selectors on screen the spotlight folds itself
 * (it lights again once the popup closes).
 */
const YIELD_TO: readonly string[] = ['.sm-confirm', '.tut-popup'];

export class Spotlight {
  private readonly root: HTMLElement;
  private readonly panes: HTMLElement[] = [];
  private readonly ring: HTMLElement;
  private readonly tip: HTMLElement;
  private selectors: readonly string[] = [];
  private text = '';
  /** The text last drawn in the callout — the DOM is not rebuilt on every retarget (keycap tokens go in it). */
  private tipText: string | null = null;
  /** Uses the selectors as **the union of them all** rather than "the first one found" (2026-09-08). */
  private union = false;
  /**
   * **No-dim mode** (2026-09-14 2nd pass, user's decision — `StepDef.spotNoDim`). Hole · ring · callout stay as they
   * are and only the four plates turn transparent. And then **clicks pass through too** (`pointer-events: none` in
   * `tutorial.css`) — with no dim plate there, hands tied on their own just read as "why is nothing clicking".
   */
  private noDim = false;
  private timer = 0;
  private last: Rect | null = null;
  private shown = false;
  /**
   * Time left (s) from the target appearing until it lights. `-1` = the target has not been seen yet (not counting).
   * It starts at `TUTORIAL_STEP_DELAY_S` on the first update where the target is visible and `place()`s the moment it
   * reaches 0. Hiding or a changed target puts it back to `-1`.
   */
  private wait = -1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'tut-spot';
    this.root.hidden = true;
    // One csv constant is the source of the fade time — CSS reads only this variable
    this.root.style.setProperty('--tut-dim-fade', `${TUTORIAL_DIM_FADE_S}s`);
    for (let i = 0; i < 4; i++) {
      const p = document.createElement('div');
      p.className = 'tut-spot-pane interactive';
      // The dim plates eat clicks — this is all there is to "blocking clicks"
      p.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
      p.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
      p.addEventListener('contextmenu', (e) => { e.preventDefault(); });
      this.panes.push(p);
      this.root.appendChild(p);
    }
    this.ring = document.createElement('div');
    this.ring.className = 'tut-spot-ring';
    this.tip = document.createElement('div');
    this.tip.className = 'tut-spot-tip';
    this.root.append(this.ring, this.tip);
    parent.appendChild(this.root);
  }

  /**
   * Lights the first of these selectors that is found. An empty list = off.
   * With `union` it merges the rects of **everything found** into one hole instead.
    * With `noDim` the dim plates are left transparent and **clicks pass through too** (a focus of ring · callout
    * only).
   */
  set(selectors: readonly string[] | undefined, text: string, union = false, noDim = false): void {
    const next = selectors ?? [];
    if (next === this.selectors && text === this.text && union === this.union && noDim === this.noDim) return;
    const retarget = next !== this.selectors;
    this.selectors = next;
    this.text = text;
    this.union = union;
    this.noDim = noDim;
    this.root.classList.toggle('is-nodim', noDim);
    this.timer = 0;                       // finds again immediately on the next update
    // The target changed (= the step moved on) — what is lit now folds at once, and the new target lights half a beat
    //   after it appears. A change of callout text alone counts as a retarget and simply follows along.
    if (next.length === 0 || retarget) this.hide();
  }

  /**
   * Every frame. Follows the target moving or disappearing (every `RETARGET_INTERVAL`).
   * While it is off, seeing the target starts counting `wait` down and it lights only once that is spent — during the
   * wait the next check is pulled in to the time left, so the moment it lights is not `RETARGET_INTERVAL` later.
   */
  update(dt: number): void {
    if (this.selectors.length === 0) return;
    // While counting it **never goes below 0**. `-1` is a separate mark for "not counting yet", so a countdown that
    // crossed into negatives would be misread by the `wait < 0` below as "the target just appeared" and would count
    // the 0.5 s again forever (2026-09-09 bug — the spotlight came up tens of seconds late, or never at all:
    // `timer = min(RETARGET_INTERVAL, wait)` tied the two to one value, so they always crossed on the same frame).
    if (this.wait > 0) this.wait = Math.max(0, this.wait - dt);
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = RETARGET_INTERVAL;
    if (this.yielding()) { this.hide(); return; }
    const b = this.union ? this.unionRect() : this.find()?.getBoundingClientRect() ?? null;
    if (!b || b.width <= 0 || b.height <= 0) { this.hide(); return; }
    if (!this.shown) {
      if (this.wait < 0) this.wait = TUTORIAL_STEP_DELAY_S;          // the target just appeared (the `-1` mark) — count now
      if (this.wait > 0) { this.timer = Math.min(RETARGET_INTERVAL, this.wait); return; }
    }
    this.place({ x: b.left - PAD, y: b.top - PAD, w: b.width + PAD * 2, h: b.height + PAD * 2 });
  }

  /** The rect enclosing every target found (null when there is none). */
  private unionRect(): DOMRect | null {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const sel of this.selectors) {
      const el = firstShown(sel);
      if (!el) continue;
      const q = el.getBoundingClientRect();
      if (q.width <= 0 || q.height <= 0) continue;
      l = Math.min(l, q.left); t = Math.min(t, q.top);
      r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    }
    return l === Infinity ? null : new DOMRect(l, t, r - l, b - t);
  }

  /** Is something like a confirm popup up on top (`YIELD_TO`). */
  private yielding(): boolean {
    for (const sel of YIELD_TO) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.getClientRects().length > 0) return true;
    }
    return false;
  }

  /** The one **first visible match** in the selector list. */
  private find(): HTMLElement | null {
    for (const sel of this.selectors) {
      const el = firstShown(sel);
      if (el) return el;
    }
    return null;
  }

  /**
   * Places the four plates + the ring. **The corners are frozen to integers first** (2026-09-09) and all four plates
   * and the ring derive from those four corners — before, each plate rounded its own `top`/`height`, so a fractional
    * target rect **left one horizontal line above and below the hole undimmed** (a 1 px strip, most visible on step
    * 8).
   * Now the bottom plate's `top` is exactly the side plates' `bottom`, so the four plates cover the screen with no
   * gap (a smoke checks that tiling). The hole is taken generously outwards (floor / ceil).
   */
  private place(r: Rect): void {
    const vw = window.innerWidth, vh = window.innerHeight;
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(vw, Math.ceil(r.x + r.w)), y1 = Math.min(vh, Math.ceil(r.y + r.h));
    const px = (v: number): string => `${v}px`;
    const [top, bottom, left, right] = this.panes;
    top.style.cssText = `left:0;top:0;width:${px(vw)};height:${px(y0)}`;
    bottom.style.cssText = `left:0;top:${px(y1)};width:${px(vw)};height:${px(Math.max(0, vh - y1))}`;
    left.style.cssText = `left:0;top:${px(y0)};width:${px(x0)};height:${px(Math.max(0, y1 - y0))}`;
    right.style.cssText = `left:${px(x1)};top:${px(y0)};width:${px(Math.max(0, vw - x1))};height:${px(Math.max(0, y1 - y0))}`;
    this.ring.style.cssText = `left:${px(x0)};top:${px(y0)};width:${px(Math.max(0, x1 - x0))};height:${px(Math.max(0, y1 - y0))}`;
    // the callout goes below the target, above it when that leaves the screen
    const below = y1 + 10;
    const tipTop = below + 44 > vh ? y0 - 44 : below;
    if (this.tipText !== this.text) { this.tipText = this.text; renderSpotText(this.tip, this.text); }
    this.tip.style.cssText = `left:${px(Math.min(Math.max(8, x0), vw - 300))};top:${px(Math.max(8, tipTop))}`;
    this.tip.hidden = !this.text;
    if (!this.shown) {
      this.shown = true;
      this.root.hidden = false;
      // an element just out of `display:none` runs no transition if the class lands on the same frame — reflow,
      //   then light
      void this.root.offsetWidth;
      this.root.classList.add('is-lit');
    }
    this.last = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  private hide(): void {
    this.wait = -1;
    this.tipText = null;              // redraws the keycaps with the current bindings when it lights again
    if (!this.shown) return;
    this.shown = false;
    this.root.hidden = true;
    this.root.classList.remove('is-lit');
    this.last = null;
  }

  /** Smoke / debug: the rect being lit right now — the hole frozen to integer corners (null when there is none). */
  get rect(): Rect | null { return this.last; }
  get visible(): boolean { return this.shown; }
  /** Smoke / debug: the target is visible but the half beat is still counting down. */
  get pending(): boolean { return !this.shown && this.wait > 0; }

  dispose(): void {
    this.root.remove();
  }
}
