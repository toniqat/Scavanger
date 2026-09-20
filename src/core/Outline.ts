import * as THREE from 'three';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import type { OutlineChannel, OutlineRef } from '@/shared';

/**
 * `ctx.outline` (2026-09-12) — the screen-space outline. Its contract is `OutlineRef` in `shared/render.ts`.
 *
 * In ship management, hovering a piece of furniture raises a **faint white** (`hover`) outline and picking one a
 * **mid-bright yellow-green** (`selected`) outline (user's decision — a screen-space outline pass). three's
 * `OutlinePass` is used one per channel.
 *
 * - **Costs nothing while unused**: an empty channel sets `enabled = false`, so the composer skips it and the canvas
 *   path never calls it. `set` with the same list does nothing. When both channels hold the same object (or its
 *   ancestor · descendant), only `selected` is drawn.
 * - **It stands with bloom off too**: with a composer it is inserted after bloom and before OutputPass (`attach`);
 *   on the bloom-off canvas path `renderDirect` draws the scene and then **draws the same passes over** the canvas —
 *   switching the canvas path to the composer would change the render target being drawn into and recompile the whole
 *   scene (Engine `applyPost` comment). The canvas goes through neither tone mapping nor sRGB encoding, so that path
 *   swaps in colours already encoded to sRGB.
 * - **It removes the first hover's compile hitch** (`warm`): an outline material's program key follows **the state of
 *   where it is drawn** — the depth · mask materials, which draw the scene as an override, see the scene's fog ·
 *   point-light count · shadows and the render target (linear); the full-screen quad sees 0 lights · no fog · the
 *   render target; and the final overlay sees the canvas (sRGB · ACES) on the canvas path. So whenever that state
 *   changes (fog kind · the sun's shadow · the bloom path) the same conditions are mimicked and `renderer.compile`
 *   links the programs ahead of time (KHR_parallel_shader_compile — the driver finishes it in the background). The
 *   point-light count is held fixed for the whole session by `LightBudget`, so Engine calls this only **after**
 *   `beforeRender` (which fills the budget). The mask step draws with every unselected mesh hidden, so the warm-up
 *   runs inside that same hiding — a light parented under a mesh drops out of the count there too.
 * - **It creates no light.** The `visible` the pass flips covers meshes · sprites · points · lines only, never
 *   lights or groups, and it is restored before the render ends — the count `smoke-lights` takes (`traverseVisible`)
 *   is the same between frames.
 * - **It does not redraw shadows**: so that the two `renderer.render(scene)` calls inside the pass do not redraw the
 *   sun's shadow map too, `shadowMap.autoUpdate` is off for their duration (the main render already refreshed the
 *   shadow map this frame).
 */

/** The look of each channel (a UI presentation value, not a balance number). */
const STYLE: Readonly<Record<OutlineChannel, { color: number; strength: number; thickness: number }>> = {
  hover: { color: 0xffffff, strength: 1.4, thickness: 1.0 },      // faint white
  selected: { color: 0xa8f060, strength: 3.0, thickness: 1.5 },   // mid-bright yellow-green
};

/** The pass that draws one outline channel — shadow-map updates are off during its internal scene renders. */
class ChannelPass extends OutlinePass {
  override render(
    renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number, maskActive: boolean,
  ): void {
    const auto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    try { super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive); }
    finally { renderer.shadowMap.autoUpdate = auto; }
  }
}

/** The pass's real (underscore) internals — `@types/three` still lists the pre-rename names. */
interface PassInternals {
  _selectionCache: Set<THREE.Object3D>;
  _visibilityCache: Map<THREE.Object3D, boolean>;
  _changeVisibilityOfNonSelectedObjects(visible: boolean): void;
}

function isInside(obj: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (o === root) return true;
  return false;
}

function sameList(a: readonly THREE.Object3D[], b: readonly THREE.Object3D[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Channel {
  pass: ChannelPass;
  /** What the caller asked for (kept even while detached from the scene — it may come back). */
  wanted: THREE.Object3D[];
  linear: THREE.Color;
  /** `linear` encoded to sRGB — the canvas path writes straight into the display buffer. */
  display: THREE.Color;
}

export class Outline implements OutlineRef {
  private readonly channels: Record<OutlineChannel, Channel>;
  private readonly order: readonly Channel[];
  /** Warm-up stand-ins: the scene-override materials on a plain + an instanced box, the full-screen ones on a quad. */
  private readonly warmScene = new THREE.Group();
  private readonly warmMask = new THREE.Group();
  private readonly warmQuad = new THREE.Group();
  private readonly warmOverlay = new THREE.Group();
  private readonly warmCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly warmGeos: THREE.BufferGeometry[] = [];
  /** Fog kind × 4 + sun shadow × 2 + canvas path — the scene state the outline programs were last linked for (−1 = never). */
  private warmedState = -1;

  constructor(private readonly scene: THREE.Scene, camera: THREE.Camera) {
    const make = (ch: OutlineChannel): Channel => {
      const s = STYLE[ch];
      const pass = new ChannelPass(new THREE.Vector2(256, 256), scene, camera);
      const linear = new THREE.Color(s.color);                // hex → working (linear) space
      pass.visibleEdgeColor.copy(linear);
      pass.hiddenEdgeColor.copy(linear);                      // occluded edges look the same (the hub ceiling is back-face culled, but the depth pass is double-sided)
      pass.edgeStrength = s.strength;
      pass.edgeThickness = s.thickness;
      pass.edgeGlow = 0;
      pass.pulsePeriod = 0;
      pass.enabled = false;
      return { pass, wanted: [], linear, display: linear.clone().convertLinearToSRGB() };
    };
    this.channels = { hover: make('hover'), selected: make('selected') };
    this.order = [this.channels.hover, this.channels.selected];   // selected draws last = on top
    this.buildWarmObjects();
  }

  /* ── OutlineRef ── */
  set(channel: OutlineChannel, objects: readonly THREE.Object3D[] | null): void {
    const ch = this.channels[channel];
    const next = objects ? objects.filter((o): o is THREE.Object3D => !!o) : [];
    if (sameList(ch.wanted, next)) return;
    ch.wanted = next;
  }

  clear(): void {
    for (const ch of this.order) ch.wanted = [];
    for (const ch of this.order) { ch.pass.selectedObjects = []; ch.pass.enabled = false; }
  }

  /** Debug / smoke: objects each channel is drawing this frame. */
  get drawing(): { hover: number; selected: number } {
    return { hover: this.channels.hover.pass.selectedObjects.length, selected: this.channels.selected.pass.selectedObjects.length };
  }

  /* ── Engine hooks ── */
  /** Insert both passes into the composer right before its last pass (OutputPass). */
  attach(composer: { passes: unknown[]; insertPass(pass: unknown, index: number): void }): void {
    const at = Math.max(0, composer.passes.length - 1);
    composer.insertPass(this.channels.hover.pass, at);
    composer.insertPass(this.channels.selected.pass, at + 1);
  }

  /** Drawing-buffer size (CSS size × pixel ratio). The composer resizes attached passes too; this covers the canvas path. */
  setSize(width: number, height: number): void {
    for (const ch of this.order) ch.pass.setSize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  }

  /**
   * Once per frame before drawing: resolve what each channel really draws — objects detached from the scene drop out,
   * `selected` wins over `hover` (same object, ancestor or descendant) — and enable only non-empty passes.
   */
  prepare(): void {
    const sel = this.channels.selected, hov = this.channels.hover;
    const selLive = this.live(sel.wanted, sel.pass.selectedObjects);
    const hovLive = this.live(hov.wanted, hov.pass.selectedObjects, selLive);
    sel.pass.selectedObjects = selLive;
    hov.pass.selectedObjects = hovLive;
    sel.pass.enabled = selLive.length > 0;
    hov.pass.enabled = hovLive.length > 0;
  }

  /** Whether any channel draws this frame. */
  get active(): boolean { return this.channels.hover.pass.enabled || this.channels.selected.pass.enabled; }

  /**
   * The canvas path (bloom off): the scene is already on the canvas — add the outlines on top of it. The passes'
   * final overlay binds `readBuffer`, so null = the canvas; `writeBuffer` is never read.
   */
  renderDirect(renderer: THREE.WebGLRenderer, dt: number): void {
    if (!this.active) return;
    for (const ch of this.order) {
      if (!ch.pass.enabled) continue;
      ch.pass.visibleEdgeColor.copy(ch.display);
      ch.pass.hiddenEdgeColor.copy(ch.display);
      ch.pass.render(renderer, null as unknown as THREE.WebGLRenderTarget, null as unknown as THREE.WebGLRenderTarget, dt, false);
      ch.pass.visibleEdgeColor.copy(ch.linear);
      ch.pass.hiddenEdgeColor.copy(ch.linear);
    }
    renderer.setRenderTarget(null);
  }

  /**
   * Link the outline programs for the scene state they will be drawn in (see the class comment). Cheap no-op unless
   * the state key changed. **Call only after `LightBudget` has filled the scene** (Engine: after `shaders.beforeRender`).
   */
  warm(renderer: THREE.WebGLRenderer, camera: THREE.Camera, sunShadow: boolean, canvasPath: boolean): void {
    // called every frame: compare the three inputs without building a key string (no per-frame allocation)
    const fog = this.scene.fog;
    const fogKind = fog ? ((fog as THREE.FogExp2).isFogExp2 ? 2 : 1) : 0;
    const state = fogKind * 4 + (sunShadow ? 2 : 0) + (canvasPath ? 1 : 0);
    if (state === this.warmedState) return;
    this.warmedState = state;
    const prevTarget = renderer.getRenderTarget();
    const rt = this.channels.selected.pass.renderTargetMaskBuffer;
    const hider = this.channels.selected.pass as unknown as PassInternals;
    try {
      renderer.setRenderTarget(rt);
      // step 1 (depth of the non-selected objects): the scene as it is
      renderer.compile(this.warmScene, camera, this.scene);
      // step 1b (mask of the selected objects): every mesh / sprite / point / line hidden, like the pass does
      hider._selectionCache.clear();
      hider._changeVisibilityOfNonSelectedObjects(false);
      try { renderer.compile(this.warmMask, camera, this.scene); }
      finally { hider._changeVisibilityOfNonSelectedObjects(true); hider._visibilityCache.clear(); }
      // full-screen quads: no lights, no fog, into a render target (the overlay too on the composer path)
      renderer.compile(this.warmQuad, this.warmCam);
      renderer.compile(this.warmOverlay, this.warmCam);
      if (canvasPath) {
        renderer.setRenderTarget(null);
        renderer.compile(this.warmOverlay, this.warmCam);
      }
    } catch (e) {
      console.warn('[Outline] warm-up failed', e);
    } finally {
      renderer.setRenderTarget(prevTarget);
    }
  }

  /** Force the next `warm` to run again (e.g. after a scene swap that the key cannot see). */
  invalidateWarm(): void { this.warmedState = -1; }

  dispose(): void {
    this.clear();
    for (const ch of this.order) ch.pass.dispose();
    for (const g of this.warmGeos) g.dispose();
    this.warmGeos.length = 0;
  }

  /* ── internals ── */
  /** `wanted` filtered to objects in the scene (and, for hover, not overlapping `exclude`). Reuses `out` when unchanged. */
  private live(wanted: readonly THREE.Object3D[], current: THREE.Object3D[], exclude?: readonly THREE.Object3D[]): THREE.Object3D[] {
    let changed = false;
    let n = 0;
    for (const o of wanted) {
      if (!isInside(o, this.scene)) continue;
      if (exclude && exclude.some((e) => isInside(o, e) || isInside(e, o))) continue;
      if (current[n] !== o) changed = true;
      n++;
    }
    if (!changed && n === current.length) return current;
    const out: THREE.Object3D[] = [];
    for (const o of wanted) {
      if (!isInside(o, this.scene)) continue;
      if (exclude && exclude.some((e) => isInside(o, e) || isInside(e, o))) continue;
      out.push(o);
    }
    return out;
  }

  private buildWarmObjects(): void {
    const pass = this.channels.selected.pass;
    const box = new THREE.BoxGeometry(1, 1, 1);            // position + normal + uv — like the merged furniture geometry
    this.warmGeos.push(box);
    const plainAndInstanced = (group: THREE.Group, mat: THREE.Material): void => {
      group.add(new THREE.Mesh(box, mat));
      const inst = new THREE.InstancedMesh(box, mat, 1);
      inst.setMatrixAt(0, new THREE.Matrix4());
      group.add(inst);
    };
    plainAndInstanced(this.warmScene, pass.depthMaterial);
    plainAndInstanced(this.warmMask, pass.prepareMaskMaterial);
    // FullScreenQuad's geometry: position + uv, no normal
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    this.warmGeos.push(quad);
    for (const m of [pass.materialCopy, pass.edgeDetectionMaterial, pass.separableBlurMaterial1, pass.separableBlurMaterial2]) {
      this.warmQuad.add(new THREE.Mesh(quad, m));
    }
    this.warmOverlay.add(new THREE.Mesh(quad, pass.overlayMaterial));
  }
}
