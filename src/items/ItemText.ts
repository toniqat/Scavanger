/* ════════════════════════════════════════════════════════════════════════════
 * **Inline markup** in an item description (2026-09-15, gadget rework · user's decision)
 *
 * `data/items.csv`'s `description` was one flat string until now and both tooltips printed it with `textContent`.
 * The user asked for 「강조색상 · 회색색상 · 줄바꿈」 in the adrenaline shot's description, so colour
 * **per character** was needed.
 *
 * No new concept was invented — it is the **brace token** convention `shared/keycap.renderKeyText` already uses:
 *
 *   `{em}…{/em}`   the accent colour (each tooltip uses its own: card `--c-accent` · inventory `--inv-accent`)
 *   `{dim}…{/dim}` dim grey (`--c-text-dim` · `--inv-muted`)
 *   `{br}`         a line break
 *
 * The parser is **pure** (`src/items` builds no DOM) — it returns a list of segments per line, and the drawing is
 * `ui/hud/ItemTip` and `inventory/ui/Tooltip`, each in its own colours (one function, so the wording is one).
 * An unknown token (`{foo}`) stays **literal** — an old csv is never silently cut short.
 * ════════════════════════════════════════════════════════════════════════════ */

/** Text colour of a segment. `plain` = that tooltip's body colour. */
export type ItemTextStyle = 'plain' | 'em' | 'dim';

export interface ItemTextSpan {
  readonly text: string;
  readonly style: ItemTextStyle;
}

/** One line = a list of segments. `parseItemText` always returns at least one line. */
export type ItemTextLine = readonly ItemTextSpan[];

const TOKEN = /\{(\/?)(em|dim|br)\}/g;

/**
 * A description string → the segments of each line. With no markup at all it is `[[{ text, style: 'plain' }]]`
 * (so the caller needs no "does it have markup" branch).
 */
export function parseItemText(text: string): ItemTextLine[] {
  const lines: ItemTextSpan[][] = [[]];
  let style: ItemTextStyle = 'plain';
  let at = 0;
  const push = (s: string): void => { if (s) lines[lines.length - 1].push({ text: s, style }); };
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    push(text.slice(at, m.index));
    at = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2];
    if (name === 'br') {
      if (closing) push(m[0]);            // `{/br}` and the like are not tokens — left as text
      else lines.push([]);
    } else if (closing) {
      style = 'plain';
    } else {
      style = name as ItemTextStyle;
    }
  }
  push(text.slice(at));
  return lines.map((l) => l.filter((s) => s.text.length > 0));
}

/** The bare text with the markup stripped (anywhere outside a tooltip · search · smokes). */
export function plainItemText(text: string): string {
  return parseItemText(text).map((l) => l.map((s) => s.text).join('')).join(' ');
}
