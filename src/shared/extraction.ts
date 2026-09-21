/**
 * src/shared/extraction.ts — **the synchronous queries of the extraction flow** (`ctx.extraction`, the 2026-09-13 extraction rework).
 *
 * The question this file answers: *what does another folder have to ask about the extraction ship every frame.*
 *
 * - An enemy **never** comes inside a landed ship (user's decision). The hull walls are box colliders extraction
 *   registered with `WorldRef.addObstacle`, so they are a wall to everyone, but the rear ramp opening is the hole people
 *   walk through and stays open. `keepEnemyOut` is what closes that hole **to enemies alone** —
 *   `enemies/ai/EnemyAI.integrate` calls it after `world.resolveCollision`. `resolveCollision` does not know who is
 *   calling, so "enemies only" cannot be said with a world collider and was pulled out as a query.
 * - The rest is state the HUD and the smokes read. The events (`extraction:*`) are the source; these values mirror them.
 */
import type * as THREE from 'three';

/** The stage of the extraction flow. `liftoff` = the ship is leaving (a rider gets the liftoff cinematic, those left behind wait for the reset). */
export type ExtractionStage = 'idle' | 'countdown' | 'shipIncoming' | 'landed' | 'departing' | 'liftoff';

export interface ExtractionRef {
  readonly stage: ExtractionStage;
  /** Seconds left of the departure grace. -1 when not `departing`. */
  readonly departRemaining: number;
  /** Seconds until a landed ship raises the automatic departure grace. -1 when not `landed`. */
  readonly idleRemaining: number;
  /** The local player is being carried away aboard the ship (the liftoff cinematic holds the camera). */
  readonly riding: boolean;
  /** Is `position` (the feet) inside the bay of a landed or climbing ship. False with no ship. */
  isInShipBay(position: THREE.Vector3): boolean;
  /**
   * Pushes an enemy body (foot position · radius) out of the bay — toward the opening only (the ship's rear, local +Z).
   * True when it moved. **Enemies only**: the player, remote bodies and throwables never call it. The zone exists only while the ship is near the ground.
   */
  keepEnemyOut(position: THREE.Vector3, radius: number): boolean;

  /* ── appended (2026-09-14, the tutorial rework — `src/tutorial/README.md` Decisions) ── */
  /**
   * Stands an **already-landed extraction ship** on the spot — the console, the 20 s call and the landing shot are all
   * skipped and it goes straight to `landed`. The tutorial's 「버려진 함선」 is this: no separate ship mesh is built, the
   * real extraction ship is simply placed there from the start, so the interior switch → the uncancellable 10 s grace →
   * liftoff → result and settlement all run **down the usual road**.
   *
   * False when `ctx.missionMode !== 'tutorial'` or the stage is no longer `idle` (the main-game extraction flow has no door into it).
   * With `autoDepart: false` the 60 s idle auto-departure is not raised — the tutorial needs time to look around.
   */
  beginPreLanded?(position: THREE.Vector3, yaw: number, opts?: { autoDepart?: boolean }): boolean;

  /* ── appended (2026-09-14 2nd pass, user's decision — skipping the tutorial = extract immediately) ── */
  /**
   * Skips walking aboard and **lifts off at once** — it stands the local player in the bay and moves to `liftoff` with
   * no grace, so the result screen, the settlement and being granted the ship all run **down the usual extraction road**.
   *
   * Tutorial only: false when `ctx.missionMode !== 'tutorial'` or the ship is not `landed`.
   * There is one call site, `TutorialSystem.skipTrack('raid')` (the ESC menu's 「튜토리얼 건너뛰기」 goes there).
   */
  skipToLiftoff?(): boolean;

  /* ── appended (2026-09-14 3rd pass, user's decision — the tutorial ship lifts off the moment the switch is pressed) ── */
  /**
   * True means an enemy **looks at the player but does not fire**. It is the only door that stops an android which was
   * never killed from shooting the player in the bay during the tutorial liftoff — for the same reason as `keepEnemyOut`
   * it is a query, not a world collider (`enemies/ai` calls it right before firing). Outside the tutorial, always false.
   */
  holdFire?(): boolean;

  /* ── appended (2026-09-15, user's decision — skipping the tutorial = fade to black → reward window → the ship) ── */
  /**
   * Skips the ship extraction sequence (walking aboard · the liftoff · the external camera shot) **wholesale** and commits
   * the local player as extracted — the result screen, the settlement and being granted the ship then run **the same road**
   * as a real extraction (only the sight of the ship leaving is missing).
   * The fade to black is raised first by the caller (tutorial) with `ui:screenFade`. Tutorial only: false when
   * `ctx.missionMode !== 'tutorial'` or the extraction is already committed.
   */
  skipToComplete?(): boolean;

  /* ── appended (2026-09-15, android squadmates — `src/allies/README.md` Decisions) ── */
  /** This map's extraction pads — the `id` and the standing spot in front of the console (where an android walks to press it). Reused array. */
  getPads?(): readonly { readonly id: string; readonly position: THREE.Vector3 }[];
  /** Authority: an android pressed the console of pad `padId` — the same flow as a person pressing it. False when not `idle`, or the pad is unknown. */
  requestActivate?(padId: string): boolean;
  /** Writes the boarding point inside the bay of a landed ship into `out`. Null with no landed ship. */
  boardingPoint?(out: THREE.Vector3): THREE.Vector3 | null;
}
