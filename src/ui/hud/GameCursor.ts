import type { GameContext } from '@/shared';
import { GAME_CURSOR_SIZE } from '@/shared';

/** class carried by `<body>` for as long as the game's own cursor art is installed (i.e. always, once built). */
const BODY_CLASS = 'cursor-ui';
/** class that additionally marks "a UI surface owns the mouse right now" (cursor mode) — for CSS and the smokes. */
const MODE_CLASS = 'cursor-on';
/** id of the injected `<style>` holding the generated `cursor:` rules. */
const STYLE_ID = 'game-cursor-style';

type Variant = 'default' | 'pointer' | 'grab';

/**
 * 게임 마우스 커서 (2026-09-07 rework).
 *
 * Phase 10 drew the in-game cursor as a DOM sprite because the pointer lock was kept and no OS cursor existed. That is
 * over: a cursor screen releases the lock, so the **real** cursor is back and the only job left is making it look like
 * the game's. The arrow is drawn procedurally on a `<canvas>` (no asset files, per the project rule), baked into
 * `cursor: image-set(url(1x) 1x, url(2x) 2x) hx hy, default` and injected once. The compositor draws it from there:
 * zero per-frame work, and it can never lag the pointer the way a drawn sprite did.
 *
 * Three variants: `default` (the arrow), `pointer` (accent arrow, over anything clickable) and `grab` (corner
 * brackets, while something is being dragged). Text fields keep the native I-beam — a caret position is exactly what a
 * custom bitmap cannot express.
 *
 * **Which elements get which variant is not a hand-written list.** The stylesheets already say what is clickable
 * (`cursor: pointer` / `grab` / `grabbing` on ~60 selectors, and more with every screen), so `mirrorSheetRules` walks
 * the loaded rules and re-emits each one prefixed with `body.cursor-ui`, swapping the keyword for our art. A new panel
 * that styles its rows `cursor: pointer` therefore gets the game's pointer for free.
 */
export class GameCursor {
  private installed = false;
  private unsubs: Array<() => void> = [];
  private art: Record<Variant, string> = { default: '', pointer: '', grab: '' };

  constructor() {
    this.install();
    // In a production build the CSS arrives as a <link>, which may still be loading when the HUD initialises.
    if (typeof window !== 'undefined') window.addEventListener('load', this.onLoad);
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(ctx.bus.on('input:cursorModeChanged', ({ active }) => {
      document.body.classList.toggle(MODE_CLASS, active);
    }));
    document.body.classList.toggle(MODE_CLASS, ctx.input.isCursorMode);
  }

  /** Whether the generated cursor art is installed (debug / smoke). */
  get isShowing(): boolean { return this.installed; }

  private readonly onLoad = (): void => { this.install(true); };

  /* ── procedural art ─────────────────────────────────────────────────────── */

  private install(rebuild = false): void {
    const existing = document.getElementById(STYLE_ID);
    if (existing && !rebuild) return;
    const size = GAME_CURSOR_SIZE;
    if (!this.art.default) {
      this.art = { default: this.url('default', size), pointer: this.url('pointer', size), grab: this.url('grab', size) };
    }
    if (!this.art.default) return;                          // no canvas (headless / blocked) — keep the native cursor
    const css = `
body.${BODY_CLASS}, body.${BODY_CLASS} * { cursor: ${this.art.default} !important; }
body.${BODY_CLASS} input[type="text"], body.${BODY_CLASS} input[type="search"],
body.${BODY_CLASS} input[type="number"], body.${BODY_CLASS} input:not([type]),
body.${BODY_CLASS} textarea, body.${BODY_CLASS} [contenteditable="true"] { cursor: text !important; }
${this.mirrorSheetRules()}`;
    const style = (existing as HTMLStyleElement) ?? document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    if (!existing) document.head.appendChild(style);
    document.body.classList.add(BODY_CLASS);
    this.installed = true;
  }

  /**
   * Re-emit every stylesheet rule that sets an interactive `cursor` keyword, prefixed with `body.cursor-ui`, so the
   * blanket arrow above does not flatten the affordances the UI already declares. Same-origin sheets only (all of
   * ours are); a sheet the browser will not let us read is skipped.
   */
  private mirrorSheetRules(): string {
    const swap: Record<string, string> = {
      pointer: this.art.pointer, grab: this.art.grab, grabbing: this.art.grab, move: this.art.grab,
    };
    const out: string[] = [];
    const walk = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        const grouping = rule as CSSGroupingRule;
        if (grouping.cssRules && !(rule as CSSStyleRule).selectorText) { walk(grouping.cssRules); continue; }
        const style = rule as CSSStyleRule;
        const want = swap[(style.style?.cursor ?? '').trim()];
        if (!want || !style.selectorText) continue;
        // A selector that already anchors on <body>/<html> cannot be prefixed with another body selector.
        const parts = style.selectorText.split(',').map((sel) => sel.trim()).filter(Boolean);
        if (parts.some((sel) => /^(body|html|:root)\b/.test(sel))) continue;
        out.push(`${parts.map((sel) => `body.${BODY_CLASS} ${sel}`).join(', ')} { cursor: ${want} !important; }`);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try { if (sheet.cssRules) walk(sheet.cssRules); } catch { /* cross-origin sheet */ }
    }
    return out.join('\n');
  }

  /** `image-set(url(1x) 1x, url(2x) 2x) hx hy, fallback` for one variant, or '' when no canvas is available. */
  private url(kind: Variant, size: number): string {
    const one = this.draw(kind, size, 1);
    const two = this.draw(kind, size, 2);
    if (!one) return '';
    // Hotspot: the arrow's tip, or the centre of the grab brackets.
    const h = kind === 'grab' ? Math.round(size / 2) : 2;
    const set = two ? `image-set(url(${one}) 1x, url(${two}) 2x)` : `url(${one})`;
    return `${set} ${h} ${h}, ${kind === 'pointer' ? 'pointer' : kind === 'grab' ? 'grabbing' : 'default'}`;
  }

  /** Draw one variant at `scale` device pixels per CSS px and return its data URL ('' if canvas is unavailable). */
  private draw(kind: Variant, size: number, scale: number): string {
    let canvas: HTMLCanvasElement;
    try { canvas = document.createElement('canvas'); } catch { return ''; }
    canvas.width = size * scale; canvas.height = size * scale;
    const g = canvas.getContext('2d');
    if (!g) return '';
    g.scale(scale, scale);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const accent = '#ffb347';                               // --c-accent
    if (kind === 'grab') {
      // Four corner brackets around the hotspot: reads as "carrying something" without hiding the tile beneath it.
      const c = size / 2, r = size * 0.34, a = size * 0.16;
      for (let pass = 0; pass < 2; pass++) {
        g.lineWidth = pass === 0 ? 3.2 : 1.6;
        g.strokeStyle = pass === 0 ? 'rgba(0,0,0,0.85)' : accent;   // dark edge, then the light core over it
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          g.beginPath();
          g.moveTo(c + sx * r, c + sy * (r - a));
          g.lineTo(c + sx * r, c + sy * r);
          g.lineTo(c + sx * (r - a), c + sy * r);
          g.stroke();
        }
      }
      try { return canvas.toDataURL('image/png'); } catch { return ''; }
    }
    // Classic arrow, tip at (2,2). Points live in a 24-unit space so the shape survives any GAME_CURSOR_SIZE.
    const u = size / 24;
    const pts: Array<[number, number]> = [[2, 1.6], [2, 19.4], [7.1, 14.7], [10.1, 21.6], [13.4, 20.1], [10.4, 13.4], [17.3, 12.7]];
    g.beginPath();
    g.moveTo(pts[0][0] * u, pts[0][1] * u);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] * u, pts[i][1] * u);
    g.closePath();
    g.lineWidth = 3.4 * u;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.stroke();
    g.fillStyle = kind === 'pointer' ? accent : '#eef2f6';  // --c-text
    g.fill();
    if (kind === 'pointer') {
      // A dark notch inside the head keeps the accent arrow readable on bright panels.
      g.beginPath();
      g.moveTo(4.2 * u, 4.4 * u); g.lineTo(4.2 * u, 13.6 * u); g.lineTo(9.4 * u, 9.4 * u);
      g.closePath();
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fill();
    }
    try { return canvas.toDataURL('image/png'); } catch { return ''; }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (typeof window !== 'undefined') window.removeEventListener('load', this.onLoad);
    document.body.classList.remove(MODE_CLASS);
  }
}
