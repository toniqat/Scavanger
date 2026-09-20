/**
 * The HUD's screen size — measured on `resize` only, read from here everywhere else.
 *
 * Eleven world-projecting widgets used to ask `ctx.uiRoot.clientWidth` / `clientHeight` themselves inside
 * `lateUpdate`. A layout **read** that follows a style **write** forces the browser to lay the whole UI out again,
 * and the widgets interleave the two: whichever one reads first pays for every style the frame has written so far.
 * Measured 2026-09-19 (`docs/DECISIONS.md` perf Phase 2): 1.14 ms/frame with 160 bodies, 7.3 ms at worst — the second
 * biggest cost in the frame after the render block, for a number that only changes when the window does.
 *
 * **Never read `clientWidth` / `clientHeight` (or `getBoundingClientRect`) on a per-frame HUD path again.** If
 * something resizes the UI root without a window resize, call `refreshHudViewport()` once at that point.
 */

/** Live viewport size in CSS pixels. Mutated in place, so a destructuring read (`const { w, h } = hudViewport`) is free. */
export const hudViewport = { w: 1, h: 1 };

let rootEl: HTMLElement | null = null;

/** Re-measure the UI root. Called on every window resize; call it by hand only if the root changed size on its own. */
export function refreshHudViewport(): void {
  const root = rootEl;
  if (!root) return;
  // A root that is display:none (or not laid out yet) reports 0 — fall back to the window so no projection divides by 0.
  hudViewport.w = root.clientWidth || window.innerWidth || 1;
  hudViewport.h = root.clientHeight || window.innerHeight || 1;
}

/** Bind the viewport to `ctx.uiRoot` (once, from `HudSystem.init`). Returns the unsubscribe for `dispose`. */
export function bindHudViewport(root: HTMLElement): () => void {
  rootEl = root;
  refreshHudViewport();
  const onResize = (): void => refreshHudViewport();
  window.addEventListener('resize', onResize);
  return () => {
    window.removeEventListener('resize', onResize);
    if (rootEl === root) rootEl = null;
  };
}
