import * as THREE from 'three';
import { SHADER_WARMUP_TIMEOUT_S, type ShaderWarmupRef } from '@/shared';
import { countVisiblePointLights, type LightBudget } from './LightBudget';

interface Job {
  pending: THREE.Material[];
  deadline: number;
  resolve: (ok: boolean) => void;
}

/** `true` when `obj` sits somewhere under `root` (or is it). */
function isInside(obj: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (o === root) return true;
  return false;
}

/**
 * `ctx.shaders` (2026-09-10) — 새 장면을 보여 주기 전에 셰이더를 컴파일해 둔다. 계약은 `shared/render.ts`.
 *
 * **왜 `renderer.compileAsync` 를 그대로 쓰지 않나** — 이유가 둘이다.
 * 1. **렌더 타깃.** 프로그램 키의 `outputColorSpace` · `toneMapping` 은 *지금 바인딩된 렌더 타깃*에서 온다
 *    (`WebGLPrograms.getParameters`). 우리는 `EffectComposer` 의 렌더 타깃에 그리므로(선형 · 톤매핑 없음),
 *    업데이트 도중(타깃 null = 화면: sRGB · ACES) 부른 `compile` 은 **한 번도 쓰이지 않을 변형**을 컴파일한다.
 *    `weapons/fx/WeaponFx.warmUp` 이 정확히 그랬다. 여기서는 컴포저의 타깃을 잠깐 바인딩하고 부른다.
 * 2. **폐기된 머티리얼.** `compileAsync` 는 모은 머티리얼의 `currentProgram.isReady()` 를 10 ms 마다 부르는데,
 *    기다리는 동안 머티리얼이 dispose 되면 `currentProgram` 이 없어 three 의 `setTimeout` 안에서 던진다
 *    (`WeaponFx.warmUp` 주석). 여기서는 Engine 프레임마다 직접 확인하고 없는 프로그램은 준비된 것으로 친다.
 *
 * 광원 상태도 맞춘다: 프로그램 키에는 점광원 개수가 들어가므로, `root` 가 들어오고 `replaces` 가 빠진 뒤의 개수를
 * 계산해 `LightBudget` 여분을 그만큼 잠깐 조정하고 컴파일한 뒤 되돌린다. `compile` 은 동기라 그 사이에 그려지는
 * 프레임은 없다.
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
    this.holds++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.holds--;
    };
    ready.then(release, release);
    setTimeout(release, SHADER_WARMUP_TIMEOUT_S * 1000);   // never trust a promise to hold the game hostage
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
      this.jobs.push({ pending, deadline: performance.now() + SHADER_WARMUP_TIMEOUT_S * 1000, resolve });
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
