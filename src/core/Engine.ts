import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GameContext, getPlanet, type GameSystem } from '@/shared';
import { Atmosphere } from './Atmosphere';
import { FxManager } from './fx/FxManager';
import { LightBudget } from './LightBudget';
import { ShaderWarmup } from './ShaderWarmup';

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
  /** 2026-09-10: the scene's point-light count never changes (padding lights) — see `LightBudget`. */
  readonly lights: LightBudget;
  /** 2026-09-10: `ctx.shaders` — compile before showing, hold the frame while the driver links. */
  readonly shaders: ShaderWarmup;

  private readonly systems: GameSystem[] = [];
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private postEnabled = true;
  /** C-44: the last bloom value the 화면 설정 asked for (the perf guard may have turned `postEnabled` off since). */
  private requestedPost = true;
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

    this.lights = new LightBudget(this.scene);
    // compile against the target the scene is really drawn into: the program key's colour space / tone mapping follow it
    this.shaders = new ShaderWarmup(this.renderer, this.scene, this.camera, this.lights,
      () => (this.postEnabled && this.composer ? this.composer.readBuffer : null));
    this.ctx.shaders = this.shaders;

    this.ctx.bus.on('world:ready', ({ seed, planet }) => {
      /* Phase 11: a selected planet names its own sky palette; without one the sky is still drawn from the seed. */
      const def = getPlanet(planet ?? this.ctx.missionPlanet);
      const p = def ? this.atmosphere.applyPlanet(def) : this.atmosphere.applySeed(seed);
      this.renderer.toneMappingExposure = p.exposure;
      this.fx.clear();
      /*
       * 2026-09-10: a whole new world is about to be drawn for the first time. Its shaders used to compile inside that
       * first render — two frames of ~3 s at every drop. Hold instead: the rest of `game:newMission` still runs (hub
       * teardown, hellpod, consoles …), the scene is compiled at the end of the frame, and simulation time stands still
       * until the driver has linked every program.
       */
      void this.shaders.holdForScene();
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

  /**
   * Bloom / output post chain. Off → plain renderer.render (tone mapping still applied).
   *
   * **2026-09-11 (C-44).** `main.ts` calls this on *every* `ui:displayChanged` — the boot publish of the stored settings,
   * a 전체화면 toggle and a resolution change included — so only a **changed request** counts:
   *  - `requestedPost` is the last value the 설정 asked for. The same value again is a no-op: it neither re-enables a
   *    bloom the perf guard turned off (a later 전체화면 toggle used to undo the guard) nor marks the guard as settled.
   *  - `perfChecked` is set only by a real change, i.e. the player's own choice. Before, the boot publish set it and the
   *    guard below never ran once (it was dead code since 2026-09-08).
   *  - Switching the chain swaps the render target the scene is drawn into (composer buffer ↔ canvas), and the program
   *    key's colour space / tone mapping follow that target → every material compiles again. So a real switch
   *    **holds the frame** (`shaders.holdForScene()`) instead of stalling inside the next draw.
   */
  setPostProcessing(enabled: boolean): void {
    if (enabled === this.requestedPost) return;
    this.requestedPost = enabled;
    this.perfChecked = true;   // an explicit 화면 설정 choice outranks the auto-disable guard below
    this.applyPost(enabled);
  }
  get isPostProcessing(): boolean { return this.postEnabled && this.composer !== null; }

  /** Flip the chain; hold for the recompile only when the drawn path really changes. */
  private applyPost(enabled: boolean): void {
    const before = this.isPostProcessing;
    this.postEnabled = enabled;
    if (this.isPostProcessing !== before) void this.shaders.holdForScene();
  }

  /* ── 화면 설정 (2026-09-08, driven by `ui:displayChanged` from main.ts) ────────────────────────────────────
   *
   * Two knobs beyond the bloom above. **2026-09-11 정정 (C-44)**: the old note here said "nothing recompiles a
   * material" — wrong for both. Bloom swaps the render target (above), and shadows change the program key (below).
   * Each is therefore applied **only when its value changes** and holds the frame for the one recompile; the same
   * value published again (boot, 전체화면, 해상도) costs nothing.
   */
  /**
   * 그림자. The sun is the only shadow caster, so this toggles `sun.castShadow`, never `renderer.shadowMap.enabled`
   * (that one would also need a `needsUpdate` sweep of the whole scene). It is still **not** free: three.js builds
   * `shadowMapEnabled` into every lit material's program key from "is any light casting", so the lit materials compile
   * once more (`WebGLPrograms` `shadowMapEnabled`). A real change holds the frame for that.
   */
  setShadows(enabled: boolean): void {
    if (this.atmosphere.sun.castShadow === enabled) return;
    this.atmosphere.sun.castShadow = enabled;
    void this.shaders.holdForScene();
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
    // a shader hold freezes the simulation exactly like `game:paused {freeze}` (systems still run with dt 0)
    const frozen = this.paused || this.shaders.holding;
    const sdt = frozen ? 0 : dt * ctx.timeScale;
    if (!frozen && ctx.isGameplayPhase()) {
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

    this.shaders.update();         // resolve warm-ups whose programs finished linking
    this.shaders.beforeRender();   // light budget + a queued whole-scene warm-up (may start a hold)
    // while holding, the canvas keeps the last frame: drawing now would block on the very compile we are waiting for
    if (!this.shaders.holding) {
      if (this.postEnabled && this.composer) this.composer.render(dt);
      else this.renderer.render(this.scene, this.camera);
    }

    this.perfGuard(dt);
    ctx.input.endFrame();
  }

  /**
   * Auto-disable bloom once if the frame time stays poor during the first 90 s — unless the player already chose.
   * 2026-09-11 (C-44): alive again (the boot settings publish used to disarm it), frames spent in a shader hold do not
   * count as slow (dt is real time, and a hold is the compile we asked for), and turning bloom off goes through
   * `applyPost` so it holds for its own recompile too. The 설정 row is not rewritten: `requestedPost` stays true, and
   * the player's next real bloom change wins.
   */
  private perfGuard(dt: number): void {
    if (this.perfChecked || !this.postEnabled || !this.composer) return;
    if (this.shaders.holding) return;
    if (dt >= MAX_DT - 1e-4) this.slowFrames++; else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (this.slowFrames > 240) {
      this.perfChecked = true;
      this.applyPost(false);
      console.info('[Engine] sustained slow frames — bloom disabled');
    }
    if (this.ctx.time > 90) this.perfChecked = true;
  }
}
