import type { GameContext } from './GameContext';

/* ────────────────────────────────────────────────────────────────────────────
 * Hiding during a cutscene (2026-09-17, user's decision — B-17). Owner: shared/ — a contract, so it is add-only.
 *
 * **When a cutscene takes the screen, no UI is left on top of it.** Most screens are closed before that —
 * `hub/parts/SquadDock.cancelEverything` closes the pods · housing · every screen on `ctx.escape` · the inventory · the pause menu.
 * But there are **popups that cannot be closed**: closing them is exactly what breaks that feature's state (the tutorial
 * start card — closing it lets the step drift). Such a popup **hides instead of closing** — unseen during the cutscene,
 * and back unchanged when it ends.
 *
 * Hiding is not only the DOM. A popup holds `ctx.uiBlockers` and the soft cursor, so hiding only the screen while it keeps
 * those leaves a cursor floating over the cutscene and blocks `hub/parts/Transitions.relock` too (`uiBlockers.size > 0`).
 * On hiding, a subscriber puts down **the DOM · the blocker · the cursor · a hold gauge in progress** together, and
 * restores all of them when it comes back.
 *
 * Which cutscenes count (`CutsceneKind`):
 *   • `docking`  — docking · undocking (`hub:docking`, the phase in between is `'docking'`)
 *   • `travel`   — the window warp (`hub:travel`). It does not take the camera, but the ship's corner widgets also
 *                  disappear during it (`ui/hud/CutsceneWatch`) — they follow the same rule.
 *   • `liftoff`  — the liftoff cinematic (`ui:cinematic`, emitted by extraction)
 *
 * **Coming back is unconditional** (2026-09-17 user's decision): it reappears exactly as it was before hiding. If the
 * subscriber closed itself in the meantime that is the subscriber's business (`setHidden` is idempotent), and this module
 * knows one line only: "is a cutscene running right now".
 *
 * Why the reset (`RESET_EVENTS`) is needed: an aborted cutscene never emits its matching `end` — when the docking cutscene
 * swallows the window warp (`cancelTravel`) there is no `hub:travel {end}`, and an aborted raid has no
 * `ui:cinematic {false}`. What those paths do emit is `hub:entered` · `hub:left` · `game:abort` · `game:newMission` ·
 * `game:complete` · `game:over`, so those six are read as 「every cutscene has ended」. Without that a popup stays hidden forever.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The kinds of cutscene that take the screen. A subscriber may pick only the ones it needs (all of them by default). */
export type CutsceneKind = 'docking' | 'travel' | 'liftoff';

/** The default subscription scope — all three cutscenes. */
export const CUTSCENE_KINDS: readonly CutsceneKind[] = ['docking', 'travel', 'liftoff'];

export interface CutsceneHideOpts {
  /** Watch only these cutscenes (default `CUTSCENE_KINDS`). */
  kinds?: readonly CutsceneKind[];
}

/** The paths where a cutscene vanishes without ending — any one of them clears every running cutscene (comment above). */
const RESET_EVENTS = ['hub:entered', 'hub:left', 'game:abort', 'game:newMission', 'game:complete', 'game:over'] as const;

/**
 * Calls `onChange(true)` while a cutscene holds the screen and `onChange(false)` when it ends. It is called **only when
 * the value changes** (once even when two cutscenes overlap). Calling the returned function unsubscribes — if it was
 * hidden at that moment it is restored with `onChange(false)`, so no blocker leaks on a teardown path.
 *
 * The first call happens once with **the state right now**: already in the `'docking'` phase or mid-warp
 * (`ctx.hub.travelling`) hides immediately (a popup created during a cutscene — the event has already gone by).
 */
export function watchCutsceneHide(
  ctx: GameContext,
  onChange: (hidden: boolean) => void,
  opts?: CutsceneHideOpts,
): () => void {
  const kinds = new Set<CutsceneKind>(opts?.kinds ?? CUTSCENE_KINDS);
  const running = new Set<CutsceneKind>();
  let hidden = false;
  const unsubs: Array<() => void> = [];

  const apply = (): void => {
    const next = running.size > 0;
    if (next === hidden) return;
    hidden = next;
    onChange(hidden);
  };
  const set = (kind: CutsceneKind, on: boolean): void => {
    if (!kinds.has(kind)) return;
    if (on) running.add(kind); else running.delete(kind);
    apply();
  };

  const b = ctx.bus;
  unsubs.push(
    b.on('hub:docking', ({ stage }) => set('docking', stage === 'start')),
    b.on('hub:travel', ({ stage }) => set('travel', stage === 'start')),
    b.on('ui:cinematic', ({ active }) => set('liftoff', active)),
  );
  for (const ev of RESET_EVENTS) unsubs.push(b.on(ev, () => { running.clear(); apply(); }));

  // A subscriber created during a cutscene — the event has already gone by, so it is read from the state (the same correction as `CutsceneWatch`)
  if (kinds.has('docking') && ctx.phase === 'docking') running.add('docking');
  if (kinds.has('travel') && (ctx.hub?.travelling ?? false)) running.add('travel');
  apply();

  return () => {
    for (const u of unsubs) u();
    unsubs.length = 0;
    running.clear();
    apply();
  };
}
