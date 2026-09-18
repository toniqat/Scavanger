import { Keys, mouseButtonOf } from './constants';
import { keyLabel } from './Keybinds';

/* ────────────────────────────────────────────────────────────────────────────
 * The shared keycap (2026-09-15, user's decision). Owner: shared/ — a contract, so it is add-only.
 *
 * **Every place** a keycap appears (the key guide · the tutorial's controls/objectives · interaction prompts · HUD hints ·
 * minigame guidance · the ESC control table · the key settings menu) draws it with this one function. Writing
 * `el('span', { cls: 'keycap', text: keyLabel(...) })` per folder makes the mouse-button glyph appear on some screens and
 * stay as the letters `LMB` on others.
 *
 *  - **A keyboard key**: letters as before (`keyLabel`).
 *  - **Mouse left · wheel · right (`Mouse0` · `Mouse1` · `Mouse2`, or the labels `LMB` · `MMB` · `RMB`)**: instead of letters,
 *    **a picture of the top of a mouse** (rounded above, split into left / wheel / right buttons). Only the part to press is
 *    painted **white**. `M4` · `M5` stay as letters.
 *  - **Hold (`hold`)**: keyboard and mouse **look the same** (2026-09-15 2nd pass, user's decision) — `.kc-hold` is added and
 *    ① the bottom border thins to the same 1px as the other sides while the content settles 1px down (a 「pressed key」),
 *    ② the chevron sits **astride the top edge** of the keycap, half inside and half rising outside. It is drawn in
 *    **one** place, `.keycap.kc-hold::before` in `ui/styles/base.css` — the mouse glyph used to draw the chevron inside the
 *    SVG but no longer does (only the fill colour is the **accent colour**).
 *
 * The style (size · padding) belongs to `.keycap.kc-mouse` in `ui/styles/base.css`. Here only DOM and the SVG shape are built.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface KeycapOptions {
  /** A held key — `.kc-hold`, which draws the chevron over the top edge. On the mouse glyph the pressed button is
   *  additionally painted in the accent colour instead of white (the glyph itself draws no chevron). */
  hold?: boolean;
}

/** The mouse glyph's button slot: 0 = left · 1 = wheel · 2 = right. -1 for a code that is not drawn as a glyph. */
export type MouseGlyphButton = 0 | 1 | 2;

const LABEL_TO_BUTTON: Readonly<Record<string, MouseGlyphButton>> = { LMB: 0, MMB: 1, RMB: 2 };

/** `Mouse0` · `Mouse1` · `Mouse2` or the labels `LMB` · `MMB` · `RMB` → the glyph's button slot. Otherwise -1. */
export function mouseGlyphButtonOf(codeOrLabel: string): MouseGlyphButton | -1 {
  if (typeof codeOrLabel !== 'string') return -1;
  const byLabel = LABEL_TO_BUTTON[codeOrLabel];
  if (byLabel !== undefined) return byLabel;
  const m = mouseButtonOf(codeOrLabel);
  return m === 0 || m === 1 || m === 2 ? m : -1;
}

/* The SVG shape — viewBox 16×16. The top of a mouse, a half circle above (below, the straight line where the buttons end).
 * A lit slot is white (`#fff`) or the accent colour; an unlit one is left empty and only outlined (the outline is
 * `currentColor` = the keycap's text colour).
 *
 * 2026-09-15 (ui polish): so that it reads over a dark background at HUD size (about 14 px inside a 20 px keycap) —
 *  - the outline 1.2 → **1.35**, the dividing lines · the wheel 1 → **1.1** (below 1 px they drown in the antialiasing).
 *  - the inside of the wheel is always **filled dark** (`WHEEL_HOLE`). A lit left / right slot is painted up to the middle
 *    line, so leaving the wheel empty lets the white slot bleed into the wheel and the wheel disappears. When the wheel
 *    itself is the lit slot it is filled white / accent.
 *  - (superseded the same day by the 2nd pass, see the header) the hold chevron moved to the **centre** of the lit slot and
 *    its stroke was thickened. The glyph draws no chevron any more — only the fill colour changes.
 *  - the key label (`LMB` …) goes into `<title>` — the glyph keycap's `textContent` stays the same as the old letter keycap,
 *    so every place a smoke · a debug read as `.keycap` text still matches (the assistive name is given separately by the
 *    keycap's `aria-label`). */
const OUTLINE = 'M1.5 15 V8 A6.5 6.5 0 0 1 14.5 8 V15 Z';
const LEFT = 'M1.5 15 V8 A6.5 6.5 0 0 1 8 1.5 V15 Z';
const RIGHT = 'M8 1.5 A6.5 6.5 0 0 1 14.5 8 V15 H8 Z';
const ACCENT = 'var(--c-accent, #ffb347)';
const ON = '#fff';
const WHEEL_HOLE = 'rgba(8, 10, 12, 0.88)';
const GLYPH_LABEL: readonly string[] = ['LMB', 'MMB', 'RMB'];
const SVG_CACHE = new Map<string, string>();

/** The mouse glyph as an SVG string (cached). With `hold` the lit slot is painted in the accent colour instead of white —
 *  the chevron is not drawn here but by `.keycap.kc-hold::before` (2026-09-15 2nd pass, see the header). */
export function mouseGlyphSvg(button: MouseGlyphButton, hold = false): string {
  const key = `${button}|${hold ? 1 : 0}`;
  const hit = SVG_CACHE.get(key);
  if (hit) return hit;
  const fill = hold ? ACCENT : ON;
  const parts: string[] = [`<title>${GLYPH_LABEL[button]}</title>`];
  if (button === 0) parts.push(`<path d="${LEFT}" style="fill:${fill}"/>`);
  if (button === 2) parts.push(`<path d="${RIGHT}" style="fill:${fill}"/>`);
  // The line dividing the left and right slots (above · below the wheel)
  parts.push('<path d="M8 1.5 V4 M8 10 V15" style="fill:none;stroke:currentColor;stroke-width:1.1"/>');
  // The wheel — a dark hole unless it is the lit slot (so the left / right slot's fill does not bleed into it)
  parts.push(`<rect x="6.55" y="4" width="2.9" height="6" rx="1.45" style="fill:${button === 1 ? fill : WHEEL_HOLE};stroke:currentColor;stroke-width:1.1"/>`);
  // The outline
  parts.push(`<path d="${OUTLINE}" style="fill:none;stroke:currentColor;stroke-width:1.35;stroke-linejoin:round"/>`);
  const svg = `<svg class="kcm-glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
  SVG_CACHE.set(key, svg);
  return svg;
}

/**
 * Paints `cap` as a keycap — it may be called repeatedly (it is called again on a rebind · a stance change; with nothing
 * changed it does not touch the DOM).
 * `codeOrLabel` is a `KeyboardEvent.code` / `MouseN`, or an already-built label (`LMB`, `Tab 또는 Esc` …).
 * Classes are **only added** (`keycap` · `kc-hold` · `kc-mouse`) — other classes the call site put on stay as they are.
 */
export function paintKeycap(cap: HTMLElement, codeOrLabel: string, opts?: KeycapOptions): void {
  const hold = opts?.hold === true;
  const btn = mouseGlyphButtonOf(codeOrLabel);
  const stamp = `${codeOrLabel}|${hold ? 1 : 0}`;
  cap.classList.add('keycap');
  cap.classList.toggle('kc-hold', hold);
  cap.classList.toggle('kc-mouse', btn >= 0);
  if (cap.dataset.kc === stamp) return;
  cap.dataset.kc = stamp;
  const label = keyLabel(codeOrLabel);
  if (btn !== -1) {
    cap.innerHTML = mouseGlyphSvg(btn, hold);
    cap.setAttribute('aria-label', label);
    cap.title = label;
  } else {
    cap.textContent = label;
    cap.removeAttribute('aria-label');
    cap.removeAttribute('title');
  }
}

/** Builds a new keycap element and paints it. `tag` defaults to `span`, `cls` is an extra class. */
export function createKeycap(
  codeOrLabel: string,
  opts?: KeycapOptions & { tag?: string; cls?: string; parent?: HTMLElement | null },
): HTMLElement {
  const cap = document.createElement(opts?.tag ?? 'span');
  if (opts?.cls) cap.className = opts.cls;
  paintKeycap(cap, codeOrLabel, opts);
  if (opts?.parent) opts.parent.appendChild(cap);
  return cap;
}

/**
 * The left-click hold keycap put **inside a hold button**, to the left of its label (2026-09-15 2nd pass, user's decision).
 *
 * A button that runs only after being held for `UI_HOLD_CONFIRM_S` (confirm popups · craft · salvage · trade · upgrade ·
 * the intel broker · buying and selling · removing a facility …) used to lay one line 「N초 동안 누르고 있어야 실행됩니다」
 * **above** the button. Instead of that sentence this keycap sits **inside the button** — 「how do I press it」 is told by
 * the picture, and the text keeps only what that line really carried (a blocking reason · a warning).
 *
 * What is built is a `Mouse0` · `hold` keycap whose class is `kc-btn` (size · padding · pointer blocking are in base.css).
 * ⚠ `setText(btn, ...)` replaces `textContent`, so this cap is **put back in front** every time the label is rewritten
 * (the same convention as appendChild'ing the fill bar `i` again).
 */
export function createHoldButtonCap(parent?: HTMLElement | null): HTMLElement {
  return createKeycap('Mouse0', { hold: true, cls: 'kc-btn', parent });
}

/**
 * **Fixed tokens, independent of rebinding** (2026-09-16, user's decision — the tutorial's corpse focus text). The
 * inventory's drag · double-click are real buttons, not `Keys` actions (`contextmenu` · `dblclick`). So writing `{FIRE}` for
 * them becomes a lie once firing is rebound.
 *   `{MOUSE_LEFT}`   → the left-click mouse glyph (`Mouse0`)
 *   `{DOUBLE_CLICK}` → **the same shape** as the key guide's `더블클릭` keycap (`ui/hud/KeyGuide` draws it with `createKeycap('더블클릭')`)
 * They do not collide with `Keys` field names (they are not in the list of upper-case action names). Add-only.
 */
export const KEYCAP_FIXED_TOKENS: Readonly<Record<string, string>> = {
  MOUSE_LEFT: 'Mouse0',
  DOUBLE_CLICK: '더블클릭',
};

/**
 * Embeds keycaps inside a sentence — the token syntax (`KEYCAP_FIXED_TOKENS` uses the same syntax):
 *   `{ACTION}`       → the keycap of `Keys.ACTION` (read at draw time — call it again after a rebind)
 *   `{ACTION:hold}`  → a hold keycap
 *   `{br}`           → a line break
 * `ACTION` is a field name of `KeyBindings`. An unknown token is left as its literal text. `host`'s existing children are cleared.
 * Text goes in only as text nodes (no HTML parsing). An embedded keycap gets the `kc-inline` class.
 */
export function renderKeyText(host: HTMLElement, text: string): void {
  host.textContent = '';
  const re = /\{([A-Za-z_]+)(?::(hold))?\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) host.appendChild(document.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    const name = m[1];
    if (name === 'br') { host.appendChild(document.createElement('br')); continue; }
    const code = KEYCAP_FIXED_TOKENS[name] ?? (Keys as unknown as Record<string, string | undefined>)[name];
    if (typeof code !== 'string') { host.appendChild(document.createTextNode(m[0])); continue; }
    createKeycap(code, { hold: m[2] === 'hold', cls: 'kc-inline', parent: host });
  }
  if (last < text.length) host.appendChild(document.createTextNode(text.slice(last)));
}

/** The plain text with the tokens stripped (for the console · toasts · search). `{ACTION}` becomes its key label, `{br}` a space. */
export function plainKeyText(text: string): string {
  return text.replace(/\{([A-Za-z_]+)(?::hold)?\}/g, (all, name: string) => {
    if (name === 'br') return ' ';
    const code = KEYCAP_FIXED_TOKENS[name] ?? (Keys as unknown as Record<string, string | undefined>)[name];
    return typeof code === 'string' ? keyLabel(code) : all;
  });
}
