/**
 * src/shared/charBuffView.ts — **where other folders borrow the character-buff thumbnail strip** (2026-09-17,
 * user's decision 「buff · debuff thumbnails next to the name on the character tab, a tooltip on hover」).
 *
 * The strip's drawing (glyph · colour · time gauge · meal star badge · name row) is done by `ui/hud/BuffStrip`
 * alone. progression's character sheet has to use the same row, but folders do not import each other, so ui
 * **registers** its factory here when its module loads (`provideCharBuffStrip`) and other folders take one with
 * `createCharBuffStrip`. Before registration (a smoke or a skeleton with no ui) it is null — the caller then
 * draws without thumbnails.
 *
 * `interactive: true` = the thumbnails take the mouse — every cell is stamped with the shared text-card
 * attributes (`data-tip-name` · `-sub` · `-desc` · `-color`) and `ui/hud/ItemTip` raises the hover card. The
 * HUD's rows (under the hp bar · the squad list) keep the default false and stay `pointer-events: none`.
 */
import type { GameContext } from './GameContext';
import type { CharBuff } from './charBuffs';

export interface CharBuffStripOptions {
  /** Squad-list size (14 px). */
  mini?: boolean;
  /** The hover card (see above). Default false. */
  interactive?: boolean;
}

export interface CharBuffStripView {
  readonly root: HTMLElement;
  /** A new list (does nothing when it is the same reference). */
  set(list: readonly CharBuff[] | null | undefined, ctx: GameContext | null): void;
  /** Time gauges — safe to call often (it only rewrites once a second). */
  update(ctx: GameContext | null): void;
  readonly count: number;
  dispose(): void;
}

export type CharBuffStripFactory = (parent: HTMLElement, opts?: CharBuffStripOptions) => CharBuffStripView;

let factory: CharBuffStripFactory | null = null;

/** ui only: registers the thumbnail-strip factory (the last registration wins). */
export function provideCharBuffStrip(f: CharBuffStripFactory): void { factory = f; }

/** Creates one thumbnail strip inside `parent`. null when ui has not registered one yet. */
export function createCharBuffStrip(parent: HTMLElement, opts?: CharBuffStripOptions): CharBuffStripView | null {
  try { return factory ? factory(parent, opts) : null; } catch { return null; }
}
