import type { AlliesRef, AllyBodyView, AllyId, AllyRosterEntry, GameContext } from '@/shared';

/**
 * src/ui/hud/allySource.ts — **the one place ui reads android squadmates** (2026-09-15).
 *
 * The same kind of file as `menus/social/socialSource`: the squad list · nameplates · map · compass · pings · toasts
 * all pass through here, so a smoke test that plugs one fake `AlliesRef` in with `HudSystem.debugAllies(ref)` can
 * check every drawing without allies/. In a real session it is `ctx.allies` unchanged.
 *
 * ⚠ The array `getBodies()` returns and the vectors inside it are **reused** by allies/ — read, use at once, never keep.
 */
let debugRef: AlliesRef | null = null;

/** Smoke hook: use `ref` instead of `ctx.allies` (null hands it back to the real `ctx.allies`). */
export function setDebugAllies(ref: AlliesRef | null): void { debugRef = ref; }

/** The `AlliesRef` ui looks at right now (null when there is none). */
export function alliesOf(ctx: GameContext | null | undefined): AlliesRef | null {
  return debugRef ?? ctx?.allies ?? null;
}

const NO_ROSTER: readonly AllyRosterEntry[] = [];
const NO_BODIES: readonly AllyBodyView[] = [];

/** My squad's android roster (in bay order). An empty array while allies/ is not there yet. */
export function allyRoster(ctx: GameContext | null | undefined): readonly AllyRosterEntry[] {
  return alliesOf(ctx)?.roster ?? NO_ROSTER;
}

/** Every android body this client knows (a reused array). */
export function allyBodies(ctx: GameContext | null | undefined): readonly AllyBodyView[] {
  const ref = alliesOf(ctx);
  // While allies/ has not implemented this method yet (parallel work), ui simply reads it as empty.
  if (!ref || typeof ref.getBodies !== 'function') return NO_BODIES;
  return ref.getBodies();
}

/** One android's body (null when there is none). */
export function allyBody(ctx: GameContext | null | undefined, id: AllyId): AllyBodyView | null {
  const ref = alliesOf(ctx);
  if (!ref || typeof ref.getBody !== 'function') return null;
  return ref.getBody(id);
}
