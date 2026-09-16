import type { GameContext } from '@/shared';
import { RAID_LOAD_FADE_IN_S, RAID_LOAD_FADE_OUT_S, RAID_LOAD_MIN_BLACK_S } from '@/shared';
import { toggleClass } from '../dom';
import type { LoadingGauge } from '../hud/LoadingGauge';

type Stage = 'idle' | 'fadeOut' | 'loading' | 'fadeIn';

/**
 * **결과 화면 → 함선 귀환 암전** (2026-09-16, 사용자 결정 — `ui:shipReturn`).
 *
 * 결과 화면(`탈출 성공` · `전사` · `레이드 실패`)의 `함선으로 귀환` 이 예전에는 곧장 `hub:enter` 를 내서, 결과 창이
 * 사라지는 프레임에 함선이 통째로 튀어나왔다 (그다음 프레임은 셰이더 컴파일 hold 로 멈춘 채). 이제는:
 *
 * 1. **fadeOut** — 결과 창(`--shipret-menu-o`)과 검은 판(`ui:screenFade` 와 같은 판, hold)이 `RAID_LOAD_FADE_OUT_S` 에
 *    걸쳐 함께 어두워진다. 결과 창은 검은 판(z 82)보다 위(z 84)라 판만으로는 가려지지 않아 따로 민다.
 * 2. **loading** — 완전히 검어지면 로딩 게이지(`LoadingGauge.beginLocal`)를 띄우고 `hub:enter` 를 낸다. 함선이 지어지고
 *    `ctx.shaders.holdForScene()` 이 끝날 때까지(진행도 = `compileProgress`) 판은 검은 그대로다. 게이지는 최소
 *    `RAID_LOAD_MIN_BLACK_S` 떠 있다 (레이드 진입 로딩과 같은 숫자 — 같은 연출이다).
 * 3. **fadeIn** — 게이지를 내리고 판을 `RAID_LOAD_FADE_IN_S` 에 걸쳐 걷는다.
 *
 * **이 연출이 판을 쥔 동안(fadeOut · loading) 다른 누구도 판을 걷지 못한다** — `hub:enter` 가 동기로 내는 `game:abort` ·
 * `hub:entered` 에서 `HudSystem` 이 판을 즉시 걷고, 튜토리얼도 `hub:entered` 에 자기 암전을 `{0, 0}` 으로 치운다. 그 셋이
 * 그대로 흐르면 컴파일 전 함선이 한 프레임 보인다. 그래서 판은 버스가 아니라 `fade` 콜백으로 직접 칠하고,
 * `HudSystem` 은 `ownsPlate` 동안 그 경로들을 무시한다. 판 위(z 83–84)의 키 가이드 · 서버 배지는 `--shipret-o`
 * (= 1 − 판 불투명도)로 같이 가린다 (`styles/loading.css`).
 *
 * 시계: 페이드는 `HudSystem.stepScreenFade` 의 dt 보간 그대로 (reduced motion 이라 CSS 전이를 쓰지 않는다), 로딩 대기는
 * hold 동안 dt 가 0 이므로 `performance.now()` 다 — `LoadingGauge` 와 같은 이유.
 */
export class ShipReturn {
  private stage: Stage = 'idle';
  private t0 = 0;
  private loadedAt = 0;
  private compiled = false;
  /** 이번 귀환의 세대 — 늦게 도착한 컴파일 완료가 다음 귀환을 끝내지 않게. */
  private gen = 0;
  private lastMenuO = -1;
  private lastPlateO = -1;

  constructor(
    private readonly ctx: GameContext,
    private readonly gauge: LoadingGauge,
    /** 검은 판을 직접 칠한다 (`HudSystem.setScreenFade`). */
    private readonly fade: (opacity: number, durationS: number, hold: boolean) => void,
    /** 지금 칠해진 판의 불투명도 (`HudSystem.screenFadeShown`). */
    private readonly plateShown: () => number,
  ) {}

  /** 판을 이 연출이 쥐고 있다 — 다른 `ui:screenFade` · 중단 · 도착의 판 걷기를 무시한다. */
  get ownsPlate(): boolean { return this.stage === 'fadeOut' || this.stage === 'loading'; }
  get active(): boolean { return this.stage !== 'idle'; }
  /** Smoke hook: 지금 단계. */
  get stageName(): Stage { return this.stage; }

  /** `ui:shipReturn`. 결과 화면이 아니거나 이미 도는 중이면 아무 일도 없다. */
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

  /** 완전히 검어졌다 — 게이지를 띄우고 함선으로 들어간다. */
  private beginLoading(): void {
    const ctx = this.ctx;
    const phase = ctx.phase;
    this.stage = 'loading';
    this.compiled = false;
    this.loadedAt = performance.now();
    this.gauge.beginLocal();
    // 결과 화면은 판 아래로 이미 사라졌다 — 창이 닫히는 순간 필터를 되돌려도 보이지 않는다
    if (phase === 'complete' || phase === 'dead') {
      ctx.bus.emit('hub:enter', { ship: ctx.net?.lobby ? 'shared' : 'personal' });
    } else if (phase !== 'hub') {
      // 그 사이 다른 길(중단 · 타이틀)이 화면을 가져갔다 — 암전만 풀고 물러난다
      this.stage = 'fadeIn';
      this.gauge.endLocal(true);
      this.fade(0, RAID_LOAD_FADE_IN_S, false);
      return;
    }
    const gen = this.gen;
    const done = (): void => { if (this.gen === gen && this.stage === 'loading') this.compiled = true; };
    const shaders = ctx.shaders;
    if (!shaders || ctx.phase !== 'hub') { done(); return; }
    // `hub:enter` 가 이미 같은 프레임에 예약했다 — 겹친 호출은 한 번의 씬 컴파일로 합쳐지고, 그것이 끝나면 풀린다
    void shaders.holdForScene().then(done, done);
  }

  private finish(): void {
    this.stage = 'idle';
    toggleClass(this.ctx.uiRoot, 'ui-shipret', false);
    this.ctx.uiRoot.style.removeProperty('--shipret-menu-o');
    this.ctx.uiRoot.style.removeProperty('--shipret-o');
  }

  /** 결과 창의 불투명도 + 판 위 위젯들. */
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

  /** HUD 가 내려갈 때 — 도는 중이던 연출을 그 자리에서 버린다 (게이지를 걷고 CSS 변수를 지운다). */
  dispose(): void {
    if (this.stage === 'idle') return;
    this.gen++;
    this.gauge.endLocal(true);
    this.finish();
  }
}
