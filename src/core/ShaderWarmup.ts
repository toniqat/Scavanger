import * as THREE from 'three';
import { SHADER_WARMUP_TIMEOUT_S, type ShaderWarmupRef } from '@/shared';
import { countVisiblePointLights, type LightBudget } from './LightBudget';

interface Job {
  pending: THREE.Material[];
  /** 2026-09-15: how many materials the wait started with — `compileProgress`'s denominator (never 0). */
  initial: number;
  deadline: number;
  resolve: (ok: boolean) => void;
}

/** `true` when `obj` sits somewhere under `root` (or is it). */
function isInside(obj: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (o === root) return true;
  return false;
}

/**
 * `ctx.shaders` (2026-09-10) — compiles shaders before a new scene is shown. The contract is `shared/render.ts`.
 *
 * **Why `renderer.compileAsync` is not used as it comes** — two reasons.
 * 1. **The render target.** The program key's `outputColorSpace` · `toneMapping` come from the *render target bound
 *    right now* (`WebGLPrograms.getParameters`). The scene is drawn into `EffectComposer`'s render target (linear, no
 *    tone mapping), so a `compile` called mid-update (target null = the canvas: sRGB · ACES) compiles a **variant
 *    that is never used**. `weapons/fx/WeaponFx.warmUp` did exactly that. Here the composer's target is bound for it.
 * 2. **Disposed materials.** `compileAsync` polls `currentProgram.isReady()` on the gathered materials every 10 ms,
 *    and a material disposed while it waits has no `currentProgram`, so it throws inside three's `setTimeout`
 *    (`WeaponFx.warmUp` comment). Here every Engine frame checks directly and a missing program counts as ready.
 *
 * The light state is matched too: the program key holds the point-light count, so the count after `root` enters and
 * `replaces` leaves is worked out, `LightBudget`'s padding is adjusted by that much for the compile and restored
 * afterwards. `compile` is synchronous, so no frame is drawn in between.
 */
export class ShaderWarmup implements ShaderWarmupRef {
  private jobs: Job[] = [];
  private holds = 0;
  private sceneWaiters: Array<(ok: boolean) => void> = [];

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly budget: LightBudget,
    /** The target the scene is really drawn into (composer read buffer), null when rendering straight to the canvas. */
    private readonly renderTarget: () => THREE.WebGLRenderTarget | null,
  ) {}

  get holding(): boolean { return this.holds > 0 || this.sceneWaiters.length > 0; }
  get pointLightBudget(): number { return this.budget.budget; }
  /** Debug / smoke: warm-up jobs still waiting on the driver. */
  get pendingJobs(): number { return this.jobs.length; }

  /**
   * 2026-09-15 (raid entry loading): progress 0..1 of the compile in flight — materials ready / materials waited
   * on. With nothing waiting it is 1, and a scene compile that is **only queued** (right after `holdForScene`, still
   * before `beforeRender`) is 0: returning 1 on that frame would start the loading gauge at "done" and send it back
   * down.
   */
  get compileProgress(): number {
    if (this.sceneWaiters.length > 0) return 0;
    if (this.jobs.length === 0) return 1;
    let initial = 0, ready = 0;
    for (const job of this.jobs) {
      initial += job.initial;
      ready += job.initial - job.pending.length;
    }
    if (initial <= 0) return 1;
    return Math.max(0, Math.min(1, ready / initial));
  }

  warm(root: THREE.Object3D, replaces: THREE.Object3D | null = null): Promise<boolean> {
    let materials: Set<THREE.Material>;
    try {
      materials = this.compile(root, replaces);
    } catch (e) {
      console.warn('[ShaderWarmup] compile failed', e);
      return Promise.resolve(false);
    }
    return this.track(materials);
  }

  holdForScene(): Promise<boolean> {
    return new Promise<boolean>((resolve) => this.sceneWaiters.push(resolve));
  }

  hold(ready: Promise<unknown>): void {
    this.holdWith(ready, SHADER_WARMUP_TIMEOUT_S);
  }

  /**
   * 2026-09-15 (raid entry loading): a `hold` that takes its own cap. Waiting for squadmates to load
   * (`RAID_LOAD_TIMEOUT_S`, 60 s) runs longer than the shader-compile cap (`SHADER_WARMUP_TIMEOUT_S`), so holding
   * with that cap means nobody waits at all.
   */
  holdFor(ready: Promise<unknown>, timeoutS: number): void {
    this.holdWith(ready, Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS : SHADER_WARMUP_TIMEOUT_S);
  }

  private holdWith(ready: Promise<unknown>, timeoutS: number): void {
    this.holds++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.holds--;
    };
    ready.then(release, release);
    setTimeout(release, timeoutS * 1000);   // never trust a promise to hold the game hostage
  }

  /** Engine: once per frame, before `beforeRender`. Resolves jobs whose programs finished linking. */
  update(): void {
    if (this.jobs.length === 0) return;
    const now = performance.now();
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const job = this.jobs[i];
      job.pending = job.pending.filter((m) => !this.isReady(m));
      const done = job.pending.length === 0;
      if (done || now > job.deadline) {
        this.jobs.splice(i, 1);
        job.resolve(done);
      }
    }
  }

  /**
   * Engine: after every `update` / `lateUpdate`, right before drawing. Tops the light budget up and runs the queued
   * whole-scene warm-up (`holdForScene`) — here, so everything created during this frame is included.
   */
  beforeRender(): void {
    this.budget.update();
    if (this.sceneWaiters.length === 0) return;
    const waiters = this.sceneWaiters;
    this.sceneWaiters = [];
    const ready = this.warm(this.scene);
    this.hold(ready);
    void ready.then((ok) => { for (const w of waiters) w(ok); });
  }

  private compile(root: THREE.Object3D, replaces: THREE.Object3D | null): Set<THREE.Material> {
    const scene = this.scene;
    const inScene = isInside(root, scene);
    // the lights of whatever `root` replaces will be gone by the time it is drawn
    const muted: THREE.Object3D[] = [];
    if (replaces && replaces !== scene && isInside(replaces, scene)) {
      replaces.traverseVisible((o) => { if ((o as THREE.Light).isLight) muted.push(o); });
    }
    for (const o of muted) o.visible = false;
    const prevPads = this.budget.padsShown;
    const prevTarget = this.renderer.getRenderTarget();
    try {
      let content = this.budget.contentCount();
      if (!inScene) content += countVisiblePointLights(root);
      this.budget.fill(content);
      this.renderer.setRenderTarget(this.renderTarget());
      // Something already in the scene compiles with the whole scene: `compile(root, cam, scene)` gathers the lights of
      // both arguments and would count its own lights twice. Cached programs make the extra traversal cheap.
      return inScene ? this.renderer.compile(scene, this.camera) : this.renderer.compile(root, this.camera, scene);
    } finally {
      this.renderer.setRenderTarget(prevTarget);
      for (const o of muted) o.visible = true;
      this.budget.setShown(prevPads);
    }
  }

  private track(materials: Set<THREE.Material>): Promise<boolean> {
    const pending: THREE.Material[] = [];
    for (const m of materials) if (!this.isReady(m)) pending.push(m);
    if (pending.length === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      this.jobs.push({ pending, initial: pending.length, deadline: performance.now() + SHADER_WARMUP_TIMEOUT_S * 1000, resolve });
    });
  }

  private isReady(material: THREE.Material): boolean {
    const props = this.renderer.properties.get(material) as { currentProgram?: { isReady?: () => boolean } };
    const program = props.currentProgram;
    // disposed under us (the entry is fresh) or never compiled: nothing left to wait for
    if (!program || typeof program.isReady !== 'function') return true;
    try { return program.isReady(); } catch { return true; }
  }
}
