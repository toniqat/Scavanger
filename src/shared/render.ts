/**
 * src/shared/render.ts — **shader pre-compilation and the light budget** (2026-09-10). The contract of `ctx.shaders`; the implementation is `core/ShaderWarmup`.
 *
 * The question this file answers: *how are a new scene's shaders compiled before it is shown.*
 *
 * three.js compiles a material's shader **the moment it is first drawn**, and the main thread stalls while it does (tens
 * to hundreds of ms per program on ANGLE D3D11). On top of that the program key holds **the number of visible point
 * lights** and **the kind of render target**, so a change in the count recompiles everything already compiled. This is what stalled multiplayer docking and the drop for whole seconds.
 *
 * - The point-light count is fixed at `SCENE_POINT_LIGHT_BUDGET` for the whole session by `core/LightBudget` (it turns
 *   on spare lights at intensity 0 to make up the difference). A feature folder only has to **keep its own scene's point lights inside that budget**.
 * - `warm` does no rendering; it only queues the program links (KHR_parallel_shader_compile — the driver finishes them
 *   in the background) and resolves when they are done. **It does not block the main thread.**
 * - `hold*` **stops simulation time and skips drawing** while it waits — the same way as `game:paused {freeze}`, so the
 *   systems keep running at dt 0 (network message handling included) and the last frame stays on screen.
 */
import type * as THREE from 'three';

export interface ShaderWarmupRef {
  /**
   * Compiles every material under `root` **exactly as it will look once `root` is in the scene** (hidden meshes included).
   * Pass `replaces` and it compiles against the light state after that object is gone — the case where the docking cutscene ends, it disappears and the ship comes in.
   * An object outside the scene (not `add`ed yet) works too. Resolves true once every program is ready, and false past `SHADER_WARMUP_TIMEOUT_S`. **It never rejects.**
   */
  warm(root: THREE.Object3D, replaces?: THREE.Object3D | null): Promise<boolean>;
  /**
   * Compiles the whole scene **at the end of this frame (after every update, right before drawing)** and holds until it
   * is done. `holding` is true from this moment on, so objects built later in the same frame go in with it.
   * Overlapping calls merge into one.
   */
  holdForScene(): Promise<boolean>;
  /** Holds until `ready` settles (at most `SHADER_WARMUP_TIMEOUT_S`). */
  hold(ready: Promise<unknown>): void;
  /** While true, Engine hands out a simulation dt of 0 and does not draw. */
  readonly holding: boolean;
  /** The number of point lights always visible in the scene (`SCENE_POINT_LIGHT_BUDGET`). */
  readonly pointLightBudget: number;
}

/* ══ appended: 2026-09-12 — the screen-space outline (`ctx.outline`, implemented in `core/`) ═══════════════════
 * In ship management (housing mode), hovering furniture raises a **faint white** outline and clicking to select it a
 * **mid-bright yellow-green** one (user's decision — a screen-space outline pass). The colour and the thickness belong
 * to core: the channel *is* 「what does this outline mean」.
 * When the same object is in both channels, `selected` wins. With no target at all the pass itself is off and costs 0.
 * **It creates no light** — it does not change the point-light count, so it calls no shader recompile (the CLAUDE.md light rule).
 */
export type OutlineChannel = 'hover' | 'selected';

/* ══ appended: 2026-09-15 — raid entry loading (owner: core `ShaderWarmup`; caller: game `parts/LoadGate`) ══
 * The load gate is a hold — simulation dt 0 · no drawing, so the mission clock, the enemies and the drop pods all wait. The default hold's cap
 * `SHADER_WARMUP_TIMEOUT_S` is shorter than the load wait (`RAID_LOAD_TIMEOUT_S`), so there is a separate entry point that takes the cap. */
export interface ShaderWarmupRef {
  /** Holds until `ready` settles, for at most `timeoutS` seconds. */
  holdFor?(ready: Promise<unknown>, timeoutS: number): void;
  /** Progress 0..1 of the scene compile currently held (materials ready / materials first waited for). 1 when nothing is waiting. */
  readonly compileProgress?: number;
}

export interface OutlineRef {
  /** Replaces `channel`'s outline targets wholesale. `null` or an empty array = turn that channel off. Cheap to call every frame (the same list does nothing). */
  set(channel: OutlineChannel, objects: readonly THREE.Object3D[] | null): void;
  /** Turns both channels off (leaving the mode · a scene change). */
  clear(): void;
}
