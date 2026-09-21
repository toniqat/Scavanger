import * as THREE from 'three';
import { SCENE_POINT_LIGHT_BUDGET } from '@/shared';

/**
 * Scratch stack for `countVisiblePointLights` — module scope so the walk below allocates nothing per frame. Entries
 * above `top` are stale references overwritten by the next walk, one frame later; nothing reads them.
 */
const _stack: THREE.Object3D[] = [];

/**
 * Point lights three.js would collect under `root` (`projectObject` skips invisible subtrees, so does this).
 * `skip` drops one subtree from the walk — `LightBudget` passes its own padding group, whose count it already knows.
 *
 * 2026-09-20 (`docs/PERF.md` perf Phase C · B3): this is an explicit stack rather than `traverseVisible`
 * because it runs **every frame, over the whole scene** — 3 978 nodes in a raid — and `traverseVisible` pays a
 * recursive method call plus a closure call per node. Counting is still exact, and it has to be: the count is part
 * of three.js's shader program key, so a frame that sees one light too many recompiles every lit material in the
 * scene (twice — once up, once back). Recounting on a flag or on an interval was considered and rejected for that
 * reason: point lights really do enter and leave the scene mid-raid (`extraction/Ship`, `player/Hellpod`,
 * `game/parts/Leader`), and a flag missed by one owner is exactly the stall this class exists to prevent.
 */
export function countVisiblePointLights(root: THREE.Object3D, skip: THREE.Object3D | null = null): number {
  let n = 0;
  const stack = _stack;
  let top = 0;
  stack[top++] = root;
  while (top > 0) {
    const o = stack[--top];
    if (o.visible === false || o === skip) continue;
    if ((o as THREE.PointLight).isPointLight) n++;
    const kids = o.children;
    for (let i = 0; i < kids.length; i++) stack[top++] = kids[i];
  }
  return n;
}

/**
 * **Holds the scene's point-light count at one number for the whole session** (2026-09-10).
 *
 * three.js puts the visible point-light count into the shader program key. When the count changes, every lit material
 * in the scene **compiles again** on the next draw, and since each count is its own program, what was compiled before
 * is not reused either. Measured: personal ship 27 → docking cutscene 15 → shared ship 29 → planet 20 — every
 * transition stalled for a few hundred ms up to 3 s.
 *
 * Fixing the lights one at a time on 2026-09-10 to "dim rather than turn off" (the extraction ship · the flare · the
 * hellpod · the squad-leader device) held the count **within one scene**. This holds it **between scenes**: padding
 * lights at intensity 0 are carried up to the budget, and right before each frame is drawn the real lights are
 * counted and only the shortfall is shown. So in the ship, in a cutscene or on a planet alike, the count the shader
 * sees is `SCENE_POINT_LIGHT_BUDGET`.
 *
 * A padding light still costs one pass of the shader loop — so the budget is set to **the scene that really lights
 * the most**: 15 resident lights + the ship's `HUB_POINT_LIGHTS` 8 = 23 (the ship holds more than twenty slots but
 * runs them from that pool, `hub/interiors/LightPool`). A planet has 3 extraction pads + 3 consoles, so mid-raid 2
 * are spare.
 * Real lights over the budget make the count move, so each such value warns once.
 */
export class LightBudget {
  readonly budget: number;
  private readonly group = new THREE.Group();
  private readonly pads: THREE.PointLight[] = [];
  private shown: number;
  private warnedAt = -1;

  constructor(private readonly scene: THREE.Scene, budget = SCENE_POINT_LIGHT_BUDGET) {
    this.budget = Math.max(0, Math.floor(budget));
    this.group.name = 'LightBudget';
    for (let i = 0; i < this.budget; i++) {
      // black, zero intensity, a millimetre of reach, far below the world: it only occupies a slot in the shader loop
      const l = new THREE.PointLight(0x000000, 0, 0.001, 2);
      l.name = 'LightBudgetPad';
      l.position.set(0, -50000, 0);
      l.castShadow = false;
      this.pads.push(l);
      this.group.add(l);
    }
    this.shown = this.budget;
    scene.add(this.group);
  }

  /** Padding lights currently counted by three.js. */
  get padsShown(): number { return this.shown; }

  /** Real point lights in the scene right now (the padding group is skipped rather than counted and subtracted). */
  contentCount(): number { return countVisiblePointLights(this.scene, this.group); }

  /** Show exactly `n` padding lights (clamped). */
  setShown(n: number): void {
    const k = Math.max(0, Math.min(this.budget, n));
    if (k === this.shown) return;
    for (let i = 0; i < this.budget; i++) this.pads[i].visible = i < k;
    this.shown = k;
  }

  /** Top the scene up to the budget for `content` real point lights. */
  fill(content: number): void {
    if (content > this.budget && content !== this.warnedAt) {
      this.warnedAt = content;
      console.warn(`[LightBudget] ${content} point lights exceed SCENE_POINT_LIGHT_BUDGET ${this.budget} — shaders recompile whenever this count changes`);
    }
    this.setShown(this.budget - content);
  }

  /** Once per frame, right before rendering. */
  update(): void { this.fill(this.contentCount()); }
}
