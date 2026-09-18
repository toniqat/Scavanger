import type { GameContext } from '@/shared';
import { RAID_LOAD_FADE_IN_S, RAID_LOAD_FADE_OUT_S, RAID_LOAD_MIN_BLACK_S } from '@/shared';
import { toggleClass } from '../dom';
import type { LoadingGauge } from '../hud/LoadingGauge';

type Stage = 'idle' | 'fadeOut' | 'loading' | 'fadeIn';

/**
 * **The result screen → ship return fade to black** (2026-09-16, user's decision — `ui:shipReturn`).
 *
 * The `함선으로 귀환` of a result screen (`탈출 성공` · `전사` · `레이드 실패`) used to emit `hub:enter` straight away, so
 * the whole ship popped into view on the frame the result window disappeared (the next frame then froze on the shader
 * compile hold). Now:
 *
 * 1. **fadeOut** — the result window (`--shipret-menu-o`) and the black plate (the same plate as `ui:screenFade`, held)
 *    darken together over `RAID_LOAD_FADE_OUT_S`. The window is above the plate (z 84 over z 82), so the plate alone
 *    cannot cover it and it is pushed separately.
 * 2. **loading** — once fully black, the loading gauge (`LoadingGauge.beginLocal`) comes up and `hub:enter` is emitted.
 *    The plate stays black until the ship is built and `ctx.shaders.holdForScene()` ends (progress = `compileProgress`).
 *    The gauge stays up for at least `RAID_LOAD_MIN_BLACK_S` (the same number as raid-entry loading — the same cutscene).
 * 3. **fadeIn** — the gauge comes down and the plate clears over `RAID_LOAD_FADE_IN_S`.
 *
 * **While this cutscene holds the plate (fadeOut · loading) nobody else may clear it** — `HudSystem` clears the plate at
 * once on the `game:abort` · `hub:entered` that `hub:enter` emits synchronously, and the tutorial clears its own black
 * with `{0, 0}` on `hub:entered`. Let those three through and the ship shows for one frame before it is compiled. So the
 * plate is painted directly through the `fade` callback, not through the bus, and `HudSystem` ignores those paths while
 * `ownsPlate`. The key guide · server badge above the plate (z 83–84) are hidden with it through `--shipret-o`
 * (= 1 − the plate's opacity) (`styles/loading.css`).
 *
 * Clocks: the fades ride `HudSystem.stepScreenFade`'s dt interpolation (no CSS transition, because of reduced motion),
 * and the loading wait uses `performance.now()` because dt is 0 during the hold — the same reason as `LoadingGauge`.
 */
export class ShipReturn {
  private stage: Stage = 'idle';
  private t0 = 0;
  private loadedAt = 0;
  private compiled = false;
  /** This return's generation — so a late compile completion cannot end the next return. */
  private gen = 0;
  private lastMenuO = -1;
  private lastPlateO = -1;

  constructor(
    private readonly ctx: GameContext,
    private readonly gauge: LoadingGauge,
    /** Paints the black plate directly (`HudSystem.setScreenFade`). */
    private readonly fade: (opacity: number, durationS: number, hold: boolean) => void,
    /** The opacity the plate is painted with right now (`HudSystem.screenFadeShown`). */
    private readonly plateShown: () => number,
  ) {}

  /** This cutscene holds the plate — another `ui:screenFade` · abort · arrival clearing it is ignored. */
  get ownsPlate(): boolean { return this.stage === 'fadeOut' || this.stage === 'loading'; }
  get active(): boolean { return this.stage !== 'idle'; }
  /** Smoke hook: the current stage. */
  get stageName(): Stage { return this.stage; }

  /** `ui:shipReturn`. Does nothing when this is not a result screen or one is already running. */
  start(): void {
    const phase = this.ctx.phase;
    if (this.stage !== 'idle' || (phase !== 'complete' && phase !== 'dead')) return;
    this.stage = 'fadeOut';
    this.gen++;
    this.t0 = performance.now();
    this.lastMenuO = -1; this.lastPlateO = -1;
    toggleClass(this.ctx.uiRoot, 'ui-shipret', true);
    this.paint(1);
    this.fade(1, RAID_LOAD_FADE_OUT_S, true);
  }

  update(): void {
    if (this.stage === 'idle') return;
    const now = performance.now();
    const ctx = this.ctx;
    switch (this.stage) {
      case 'fadeOut': {
        const d = Math.max(0, RAID_LOAD_FADE_OUT_S) * 1000;
        const k = d > 0 ? Math.min(1, (now - this.t0) / d) : 1;
        this.paint(1 - k);
        if (k < 1 || this.plateShown() < 1) return;
        this.beginLoading();
        return;
      }
      case 'loading': {
        const p = ctx.shaders?.compileProgress;
        this.gauge.setLocalProgress(this.compiled ? 1 : typeof p === 'number' ? p : 0);
        if (!this.compiled || now - this.loadedAt < Math.max(0, RAID_LOAD_MIN_BLACK_S) * 1000) return;
        this.stage = 'fadeIn';
        this.gauge.endLocal();
        this.fade(0, RAID_LOAD_FADE_IN_S, false);
        return;
      }
      case 'fadeIn':
        this.paintPlate();
        if (this.plateShown() > 0) return;
        this.finish();
        return;
      default:
    }
  }

  /** Fully black — bring the gauge up and enter the ship. */
  private beginLoading(): void {
    const ctx = this.ctx;
    const phase = ctx.phase;
    this.stage = 'loading';
    this.compiled = false;
    this.loadedAt = performance.now();
    this.gauge.beginLocal();
    // The result screen has already vanished under the plate — undoing the filter as the window closes shows nothing
    if (phase === 'complete' || phase === 'dead') {
      ctx.bus.emit('hub:enter', { ship: ctx.net?.lobby ? 'shared' : 'personal' });
    } else if (phase !== 'hub') {
      // Meanwhile another path (an abort · the title) took the screen — just release the black and step back
      this.stage = 'fadeIn';
      this.gauge.endLocal(true);
      this.fade(0, RAID_LOAD_FADE_IN_S, false);
      return;
    }
    const gen = this.gen;
    const done = (): void => { if (this.gen === gen && this.stage === 'loading') this.compiled = true; };
    const shaders = ctx.shaders;
    if (!shaders || ctx.phase !== 'hub') { done(); return; }
    // `hub:enter` already scheduled it on this frame — overlapping calls merge into one scene compile and release when it ends
    void shaders.holdForScene().then(done, done);
  }

  private finish(): void {
    this.stage = 'idle';
    toggleClass(this.ctx.uiRoot, 'ui-shipret', false);
    this.ctx.uiRoot.style.removeProperty('--shipret-menu-o');
    this.ctx.uiRoot.style.removeProperty('--shipret-o');
  }

  /** The result window's opacity + the widgets above the plate. */
  private paint(menuO: number): void {
    const o = Math.round(Math.max(0, Math.min(1, menuO)) * 1000) / 1000;
    if (o !== this.lastMenuO) {
      this.lastMenuO = o;
      this.ctx.uiRoot.style.setProperty('--shipret-menu-o', o.toFixed(3));
    }
    this.paintPlate();
  }

  private paintPlate(): void {
    const o = Math.round((1 - Math.max(0, Math.min(1, this.plateShown()))) * 1000) / 1000;
    if (o === this.lastPlateO) return;
    this.lastPlateO = o;
    this.ctx.uiRoot.style.setProperty('--shipret-o', o.toFixed(3));
  }

  /** When the HUD goes down — a running cutscene is dropped where it stands (gauge cleared, CSS variables removed). */
  dispose(): void {
    if (this.stage === 'idle') return;
    this.gen++;
    this.gauge.endLocal(true);
    this.finish();
  }
}
