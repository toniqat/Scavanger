import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GameContext, getPlanet, INDOOR_LIGHT_FADE_S, INDOOR_PROBE_UP_M, type GameSystem } from '@/shared';
import { Atmosphere } from './Atmosphere';
import { FxManager } from './fx/FxManager';
import { LightBudget } from './LightBudget';
import { Outline } from './Outline';
import { ShaderWarmup } from './ShaderWarmup';

const MAX_DT = 0.05;

/*
 * 2026-09-21 (E-12) — the smoke clock. Every smoke waits on `ctx.time`, and in a real game a frame longer than
 * `MAX_DT` is cut to it: below 20 fps the game clock falls behind the wall clock. That is right for a player (a
 * hitch must not teleport bodies) but it is what capped the verify runner's lanes — at `--jobs 6` the pages dip
 * under 20 fps and timing checks (`smoke-ladder` climb speed, `smoke-rover` turret hits) went red.
 *
 * Under the smoke clock a long frame is **not** cut: its time is simulated as several sub-steps of at most
 * `MAX_DT` each (so no system ever sees a larger dt than it does in play), and the frame is still drawn once.
 * `SMOKE_MAX_SUBSTEPS` caps the sub-steps so a frame that is slow *because* of the simulation cannot spiral —
 * past it (under 5 fps) the clock falls behind again, exactly as in play.
 *
 * It is on **only** when the page runs under browser automation (`navigator.webdriver`, which puppeteer's Chrome
 * sets and a player's browser never does) and never in the Electron shell (the user agent, read once — smokes that
 * fake the shell with `window.__scavDesktop` keep the smoke clock). Read once at construction: the clock never
 * changes mode mid-run.
 */
const SMOKE_MAX_SUBSTEPS = 4;
/**
 * E-12 ③ — smoke clock only: game seconds per wall second while a **solo** raid is in its `deploying` phase. Measured
 * 2026-09-21: of one smoke boot's ~8 s, ~3.5 s is the hellpod falling (world generation is 0.3 s, the shader holds
 * ~0.8 s), and 68 smokes start 112 raids. The drop is scenery to all but a handful of them, so it is fast-forwarded
 * through the same ≤ `MAX_DT` sub-steps — 4× while frames stay ≤ `MAX_DT`, less below 20 fps where
 * `SMOKE_MAX_SUBSTEPS` binds (the drop went 3.8 s → 2.0 s of wall time on one idle page). A squad (`ctx.net.lobby`)
 * is left alone: its replicas are fed at wall-clock rate by the relay. A script that inspects the drop itself sets
 * `__game.dropWarp = 1`.
 */
const SMOKE_DROP_WARP = 4;
function smokeClockWanted(): boolean {
  if (typeof navigator === 'undefined' || navigator.webdriver !== true) return false;
  return !/\bElectron\//.test(navigator.userAgent);
}

/**
 * 2026-09-21 (indoor brightness): how often the roof probe is cast, derived from the crossfade rather than picked —
 * one probe per quarter of `INDOOR_LIGHT_FADE_S` means the state can never be more than a quarter of a fade late,
 * which is below noticing, while the ray runs a handful of times a second instead of once per frame.
 */
const INDOOR_PROBE_INTERVAL_S = INDOOR_LIGHT_FADE_S / 4;
/** Straight up — the probe direction, reused (no per-frame allocation). */
const INDOOR_PROBE_DIR = new THREE.Vector3(0, 1, 0);
const _indoorEye = new THREE.Vector3();

/**
 * Renderer / scene / camera owner and the main loop.
 *
 * Frame order: [update(all systems) → lateUpdate(all) → FX pools] × sub-steps (1 in play, see `SMOKE_MAX_SUBSTEPS`)
 * → atmosphere → render → input.endFrame().
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
  /** 2026-09-12: `ctx.outline` — screen-space furniture outlines for 시설 관리 (off = zero cost). */
  readonly outline: Outline;

  private readonly systems: GameSystem[] = [];
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private postEnabled = true;
  /** C-44: the last bloom value the 화면 설정 asked for — or, since C-58, `false` once the perf guard has turned it off. */
  private requestedPost = true;
  private started = false;
  private paused = false;
  private lastTime = 0;
  /** E-12: the smoke clock (see `SMOKE_MAX_SUBSTEPS`) — fixed at construction. */
  readonly smokeClock = smokeClockWanted();
  /**
   * E-12: smoke clock only — game seconds per wall second (a script opts in with `__game.simWarp = 2`). The warped
   * frame is still cut into ≤ `MAX_DT` sub-steps, so a warp costs sub-steps, never a larger dt. Ignored (1) otherwise.
   */
  simWarp = 1;
  /** E-12: smoke clock only — the warp during a solo drop (`SMOKE_DROP_WARP`); a script sets 1 to watch the drop at real speed. */
  dropWarp = SMOKE_DROP_WARP;
  private rafId = 0;
  // perf guard
  private slowFrames = 0;
  private perfChecked = false;
  /** C-58: the guard has turned bloom off this boot (`render:autoAdjusted` went out — at most once). */
  private perfAutoOff = false;
  // indoor brightness (2026-09-21) — a local view correction, see `stepIndoorLight`
  private indoorProbeAt = -Infinity;
  private indoorTarget = 0;
  /** A cutscene owns the screen (`ui:cinematic`) — the correction stands aside while one runs. */
  private cinematic = false;

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
    // 2026-09-12: before `setupPost` — the composer takes the outline passes between bloom and output
    this.outline = new Outline(this.scene, this.camera);
    this.ctx.outline = this.outline;

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
      this.cinematic = false;   // 2026-09-21: a new world, so no cutscene is running — see `game:abort`
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
    this.ctx.bus.on('game:abort', () => {
      this.fx.clear();
      this.atmosphere.setOverride(1, null, 0);
      this.atmosphere.resetIndoor();   // 2026-09-21: the scene is gone, so is whatever roof was over it
      this.indoorTarget = 0;
      // a cutscene torn down with its scene never publishes its own `active:false` — never stay latched
      this.cinematic = false;
    });
    /* 2026-09-21: a cutscene owns the screen (docking · window warp · liftoff) — the indoor lift must not bloom the
     * inside of a dropship halfway through it. Extraction and the hub both publish this. */
    this.ctx.bus.on('ui:cinematic', ({ active }) => { this.cinematic = active; });
    /* appended (2026-09-09): the only path by which a hazard narrows sight. Only the last value received stays. */
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
    this.outline.dispose();   // 2026-09-12: outline passes' render targets / materials and the warm-up geometry
  }

  /**
   * Bloom / output post chain. Off → plain renderer.render (tone mapping still applied).
   *
   * **2026-09-11 (C-44).** `main.ts` calls this on *every* `ui:displayChanged` — the boot publish of the stored settings,
   * a 전체화면 toggle and a resolution change included — so only a **changed request** counts:
   *  - `requestedPost` is the last value the 설정 asked for. The same value again is a no-op: it neither re-enables a
   *    bloom the perf guard turned off (a later 전체화면 toggle used to undo the guard) nor marks the guard as settled.
   *    (C-58: the guard itself sets it to false and the 설정 then publishes its effective bloom — see `perfDisableBloom`.)
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
   * Two knobs beyond the bloom above. **2026-09-11 correction (C-44)**: the old note here said "nothing recompiles a
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
      // 2026-09-12: outlines after bloom (a bright edge must not glow) and before output (tone mapping + sRGB)
      this.outline.attach(this.composer);
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
    this.outline.setSize(w * pr, h * pr);   // the composer sizes its passes too; this covers the canvas path / no composer
    this.fx.setViewport(w * pr, h * pr);
  }

  private frame(now: number): void {
    const ctx = this.ctx;
    let real = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (!(real > 0)) real = 0;
    // play: one step, cut to `MAX_DT`. Smoke clock: the whole (warped) frame, in ≤ `MAX_DT` sub-steps — see `SMOKE_MAX_SUBSTEPS`
    let steps = 1;
    let dt = Math.min(real, MAX_DT);
    if (this.smokeClock) {
      let warp = this.simWarp > 0 ? this.simWarp : 1;
      if (ctx.phase === 'deploying' && !ctx.net?.lobby && this.dropWarp > 1) warp *= this.dropWarp;
      const want = real * warp;
      steps = Math.min(SMOKE_MAX_SUBSTEPS, Math.max(1, Math.ceil(want / MAX_DT - 1e-6)));
      dt = Math.min(want, steps * MAX_DT) / steps;
    }

    // an edge belongs to the **last** sub-step only — the one that is drawn (`Input.holdEdges`); `endFrame` clears it below
    if (steps > 1) ctx.input.holdEdges();
    for (let i = 0; i < steps; i++) {
      if (i === steps - 1) ctx.input.releaseEdges();
      /* between sub-steps, do what the skipped render would have done: bring every `matrixWorld` up to date. Code that
         reads `matrixWorld` / `localToWorld` without updating it (moving decks, attached riders) otherwise reads the
         previous sub-step's transform (suspected in `smoke-raidflow`'s rider-on-deck gap, 0.35–0.38 m vs a 0.35 m bar). */
      if (i > 0) this.scene.updateMatrixWorld();
      this.simulate(dt);
    }

    this.stepIndoorLight(dt * steps);
    this.atmosphere.update(ctx.time, this.camera, ctx.player ? ctx.player.position : null);

    this.shaders.update();         // resolve warm-ups whose programs finished linking
    this.shaders.beforeRender();   // light budget + a queued whole-scene warm-up (may start a hold)
    // 2026-09-12: outlines — what each channel draws this frame (empty = pass off), programs linked for this scene state
    this.outline.prepare();
    const post = this.postEnabled && this.composer !== null;
    // 2026-09-12: warm **before** the hold check — a bloom / shadow toggle starts a hold the same frame it changes the
    // key, and warming only on drawn frames linked the new outline program right *after* the hold released
    // (`smoke-lights` 블룸 토글: 133 → 134). `renderer.compile` only links (parallel), so it never blocks the hold.
    this.outline.warm(this.renderer, this.camera, this.atmosphere.sun.castShadow, !post);
    // while holding, the canvas keeps the last frame: drawing now would block on the very compile we are waiting for
    if (!this.shaders.holding) {
      if (post) this.composer!.render(dt * steps);
      else {
        this.renderer.render(this.scene, this.camera);
        this.outline.renderDirect(this.renderer, dt * steps);   // bloom off: draw the outlines straight over the canvas
      }
    }

    this.perfGuard(Math.min(real, MAX_DT));   // judged on the real frame time, sub-steps or not
    ctx.input.endFrame();
  }

  /** One simulation step of `dt` game seconds: clocks → systems `update` → `lateUpdate` → FX pools. */
  private simulate(dt: number): void {
    const ctx = this.ctx;
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
  }

  /* ── indoor brightness (2026-09-21, user's request 「레이드 실내가 어둡다」) ─────────────────────────────────
   *
   * A **local view correction and nothing else**: the hemisphere fill that is already in the scene is turned up and
   * the fog is thinned while the local player is under a roof. It adds **no light** — the raid light budget has zero
   * spare and a new point light recompiles every material in the scene (CLAUDE.md §4.5, `LightBudget`) — and it
   * sends nothing, so other clients' views are untouched.
   *
   * Excluded, in order: a frozen frame (`dt` 0), anything that is not a gameplay phase (the title, menus, results,
   * `deploying`), the ship (`isHubPhase`, and `spaceMode` covers the hangar / docking look the hub sets directly),
   * the `liftoff` phase and any `ui:cinematic` — a cutscene owns the screen and a dropship hull is a roof — and a
   * world that is not ready. Everything else, raid and training range alike, gets the probe.
   */
  private stepIndoorLight(dt: number): void {
    if (dt <= 0) return;
    const ctx = this.ctx;
    if (!this.indoorApplies()) this.indoorTarget = 0;
    else if (ctx.time - this.indoorProbeAt >= INDOOR_PROBE_INTERVAL_S) {
      this.indoorProbeAt = ctx.time;
      this.indoorTarget = this.probeIndoor() ? 1 : 0;
    }
    this.atmosphere.stepIndoor(dt, this.indoorTarget);
  }

  private indoorApplies(): boolean {
    const ctx = this.ctx;
    if (this.cinematic || this.atmosphere.spaceMode) return false;
    if (!ctx.isGameplayPhase() || ctx.phase === 'liftoff' || ctx.isHubPhase()) return false;
    return !!ctx.player && !!ctx.world && ctx.world.ready;
  }

  /** One ray straight up from the eye: a roof / upper floor within `INDOOR_PROBE_UP_M` means indoors. */
  private probeIndoor(): boolean {
    const ctx = this.ctx;
    const player = ctx.player, world = ctx.world;
    if (!player || !world) return false;
    player.getEyePosition(_indoorEye);
    return world.raycast(_indoorEye, INDOOR_PROBE_DIR, INDOOR_PROBE_UP_M) !== null;
  }

  /**
   * Auto-disable bloom once if the frame time stays poor during the first 90 s — unless the player already chose.
   * 2026-09-11 (C-44): alive again (the boot settings publish used to disarm it), frames spent in a shader hold do not
   * count as slow (dt is real time, and a hold is the compile we asked for), and turning bloom off goes through
   * `applyPost` so it holds for its own recompile too. The player's next real bloom change wins.
   */
  private perfGuard(dt: number): void {
    if (this.perfChecked || !this.postEnabled || !this.composer) return;
    if (this.shaders.holding) return;
    if (dt >= MAX_DT - 1e-4) this.slowFrames++; else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (this.slowFrames > 240) this.perfDisableBloom();
    if (this.ctx.time > 90) this.perfChecked = true;
  }

  /**
   * **2026-09-11 (C-58).** The guard's one action: bloom off, and say so on `render:autoAdjusted` (at most once per boot)
   * so the 설정 row can show `꺼짐 (성능 자동)` and a toast can explain it. Nothing is persisted.
   *
   * `requestedPost` becomes **false** here, i.e. the guard's value is now the current request. That is what makes both
   * halves of the decision work with the one `ui:displayChanged` payload: while the row shows auto-off the 설정 publishes
   * its *effective* bloom (`false`) on every other change (전체화면 · 그림자 · 해상도) → the same value, a no-op, the guard
   * holds; and the player's explicit 켜기 publishes `true` → a changed request → bloom comes back (with its hold).
   * Before C-58 it stayed true, so that explicit `true` would have been swallowed as "same value again".
   */
  private perfDisableBloom(): boolean {
    if (this.perfAutoOff || !this.isPostProcessing) return false;
    this.perfAutoOff = true;
    this.perfChecked = true;
    this.requestedPost = false;
    this.applyPost(false);
    console.info('[Engine] sustained slow frames — bloom disabled');
    this.ctx.bus.emit('render:autoAdjusted', { bloom: false, reason: 'perf' });
    return true;
  }

  /**
   * Dev / smoke hook (C-58): run the perf guard's bloom-off path **now**, ignoring the 90 s window, the slow-frame count
   * and an earlier player choice (`perfChecked`). Still once per boot and only while bloom is actually drawn; returns
   * whether it fired. Reach it as `__game.debugForcePerfGuard()` — nothing in the game calls it.
   */
  debugForcePerfGuard(): boolean { return this.perfDisableBloom(); }
}
