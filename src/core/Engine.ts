import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GameContext, getPlanet, type GameSystem } from '@/shared';
import { Atmosphere } from './Atmosphere';
import { FxManager } from './fx/FxManager';

const MAX_DT = 0.05;

/**
 * Renderer / scene / camera owner and the main loop.
 *
 * Frame order: update(all systems) → lateUpdate(all) → FX pools → atmosphere → render → input.endFrame().
 * While `game:paused` is active systems still receive update/lateUpdate but with dt = 0.
 */
export class Engine {
  readonly ctx: GameContext;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly atmosphere: Atmosphere;
  readonly fx: FxManager;

  private readonly systems: GameSystem[] = [];
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private postEnabled = true;
  private started = false;
  private paused = false;
  private lastTime = 0;
  private rafId = 0;
  // perf guard
  private slowFrames = 0;
  private perfChecked = false;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1600);
    this.camera.position.set(0, 3, 6);
    this.scene.add(this.camera);

    this.ctx = new GameContext(canvas, uiRoot, this.scene, this.camera, this.renderer);
    this.ctx.input.bind(canvas);

    this.atmosphere = new Atmosphere(this.scene);
    this.fx = FxManager.install(this.scene);

    this.setupPost();
    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.ctx.bus.on('world:ready', ({ seed, planet }) => {
      /* Phase 11: a selected planet names its own sky palette; without one the sky is still drawn from the seed. */
      const def = getPlanet(planet ?? this.ctx.missionPlanet);
      const p = def ? this.atmosphere.applyPlanet(def) : this.atmosphere.applySeed(seed);
      this.renderer.toneMappingExposure = p.exposure;
      this.fx.clear();
    });
    this.ctx.bus.on('game:abort', () => { this.fx.clear(); this.atmosphere.setOverride(1, null, 0); });
    /* appended (2026-09-09): 환경 재해가 시야를 좁히는 유일한 통로. 마지막으로 받은 값 하나만 남는다. */
    this.ctx.bus.on('atmo:override', ({ fogMul, color, blend }) => this.atmosphere.setOverride(fogMul, color, blend));
    // freeze === false (multiplayer pause menu) keeps the simulation running; only the menu is shown.
    this.ctx.bus.on('game:paused', ({ paused, freeze }) => { this.paused = paused && freeze !== false; });
  }

  addSystem(system: GameSystem): void {
    if (this.started) {
      system.init(this.ctx);
    }
    this.systems.push(system);
  }

  getSystem<T extends GameSystem>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const s of this.systems) {
      try { s.init(this.ctx); } catch (e) { console.error(`[Engine] init failed for ${s.name}`, e); }
    }
    this.lastTime = performance.now();
    const loop = (now: number) => {
      this.rafId = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.started = false;
    for (const s of this.systems) s.dispose?.();
  }

  /** Bloom / output post chain. Off → plain renderer.render (tone mapping still applied). */
  setPostProcessing(enabled: boolean): void {
    this.postEnabled = enabled;
    if (enabled) this.perfChecked = true;   // an explicit 화면 설정 choice outranks the auto-disable guard below
  }
  get isPostProcessing(): boolean { return this.postEnabled && this.composer !== null; }

  /* ── 화면 설정 (2026-09-08, driven by `ui:displayChanged` from main.ts) ────────────────────────────────────
   *
   * Two knobs beyond the bloom above. Both are deliberately shallow: nothing here recompiles a material or rebuilds
   * the render graph, so a player can flick them while standing in a raid.
   */
  /**
   * 그림자. `renderer.shadowMap.enabled` is the tempting switch and the wrong one — flipping it invalidates every
   * material's shader and would need a `needsUpdate` sweep of the whole scene. The sun is the only shadow caster, so
   * turning *it* off costs one boolean, skips the shadow-map pass entirely, and leaves every shader untouched.
   */
  setShadows(enabled: boolean): void {
    this.atmosphere.sun.castShadow = enabled;
  }
  get hasShadows(): boolean { return this.atmosphere.sun.castShadow; }

  /**
   * 해상도 배율: how many device pixels the canvas gets per CSS pixel, on top of the 1.5 cap the constructor sets.
   * Below 1 the frame is rendered small and upscaled by the compositor (the cheapest real perf knob there is).
   */
  setResolutionScale(scale: number): void {
    const s = Math.max(0.5, Math.min(2, scale || 1));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5) * s);
    this.resize();
  }

  private setupPost(): void {
    try {
      const size = new THREE.Vector2();
      this.renderer.getSize(size);
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.35, 0.45, 0.85);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    } catch (e) {
      console.warn('[Engine] post-processing unavailable, falling back', e);
      this.composer = null; this.bloomPass = null;
    }
  }

  private resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.composer?.setSize(w, h);
    this.bloomPass?.setSize(w * pr * 0.5, h * pr * 0.5);
    this.fx.setViewport(w * pr, h * pr);
  }

  private frame(now: number): void {
    const ctx = this.ctx;
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (!(dt > 0)) dt = 0;
    if (dt > MAX_DT) dt = MAX_DT;

    ctx.time += dt;
    const sdt = this.paused ? 0 : dt * ctx.timeScale;
    if (!this.paused && ctx.isGameplayPhase()) {
      ctx.missionTime += sdt;
      ctx.stats.timeSeconds = ctx.missionTime;
    }

    for (const s of this.systems) {
      try { s.update(sdt, ctx); } catch (e) { console.error(`[Engine] update failed in ${s.name}`, e); }
    }
    for (const s of this.systems) {
      if (!s.lateUpdate) continue;
      try { s.lateUpdate(sdt, ctx); } catch (e) { console.error(`[Engine] lateUpdate failed in ${s.name}`, e); }
    }

    this.fx.update(sdt, this.camera);
    this.atmosphere.update(ctx.time, this.camera, ctx.player ? ctx.player.position : null);

    if (this.postEnabled && this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);

    this.perfGuard(dt);
    ctx.input.endFrame();
  }

  /** Auto-disable bloom once if the frame time stays poor during the first minute. */
  private perfGuard(dt: number): void {
    if (this.perfChecked || !this.postEnabled || !this.composer) return;
    if (dt >= MAX_DT - 1e-4) this.slowFrames++; else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (this.slowFrames > 240) {
      this.perfChecked = true;
      this.postEnabled = false;
      console.info('[Engine] sustained slow frames — bloom disabled');
    }
    if (this.ctx.time > 90) this.perfChecked = true;
  }
}
