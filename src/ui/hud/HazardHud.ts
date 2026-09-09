import * as THREE from 'three';
import type { GameContext, HazardKind, HazardZone } from '@/shared';
import { HAZARD_LABEL_KO } from '@/shared';
import '../styles/hazard.css';
import { el, setText, toggleClass } from '../dom';

/** 예고 배너가 초 단위로만 바뀌므로 DOM 은 초가 바뀔 때만 건드린다. */
const NONE = -1;

/**
 * **환경 재해 HUD (2026-09-09).** `ctx.world.hazard` (`HazardRef`) 와 `hazard:*` 이벤트만 본다 — world/ 가 아직
 * 재해를 만들지 않는 동안 `hazard` 는 null 이고 이벤트도 오지 않으므로 이 위젯은 통째로 잠들어 있는다.
 *
 * 세 부분이다:
 *   - **예고 배너** (`.hz-banner`, 게임플레이 레이어, 나침반 · 탈출 카운트다운 아래 화면 상단 중앙).
 *     `hazard:announced {kind, secondsLeft}` 에 `<재해 이름> 접근 — n초` 로 뜨고 로컬에서 초를 센다
 *     (`update` — 예고는 이벤트 한 번이지 매 초 오는 것이 아니다). `hazard:started` 에 `<재해 이름> 시작` 으로
 *     3초 남았다가 사라지고, 그 뒤로는 안전지대 게이지가 그 자리를 물려받는다. `ui:notify` 토스트 + `wave_alarm`
 *     도 예고 · 시작 때 한 번씩 나간다.
 *   - **안전지대 게이지** (`.hz-prog`): `hazard:progress {progress}` 0..1 을 **남은 안전지대**(`1 − progress`)로
 *     뒤집어 그린다 — 1 이면 맵이 다 덮인 것이고 그때는 `안전지대 없음` 이 된다. 목표 패널(`ui:objective`)은
 *     건드리지 않는다: 그쪽은 미션 플로우가 쓰는 한 줄이라 재해가 끼어들면 탈출 카운트다운을 덮어쓴다.
 *   - **위험 구역 경고** (`.hz-edge` 화면 가장자리 붉은 맥동 + `.hz-inside` 상시 한 줄): `hazard:insideChanged`.
 *     들어갈 때 `wave_alarm`, 나올 때는 소리 없이 꺼진다.
 *
 * **안전 방향 화살표** (`.hz-arrow`): 재해가 진행 중이고 `HazardRef.getZones()` 가 있으면 각 구역에서 벗어나는
 * 방향을 합쳐 (원이면 중심 쪽/바깥쪽, `front` 면 법선 방향) 카메라 기준 각도로 돌린다. 나침반을 건드리지 않고
 * 이 블록 안에서 끝난다 — 나침반은 발견 게이트가 걸린 랜드마크용이고 재해는 함선이 관측하는 현상이라 규칙이 다르다.
 */
export class HazardHud {
  readonly root: HTMLElement;
  readonly edge: HTMLElement;
  private bannerEl: HTMLElement;
  private bannerText: HTMLElement;
  private progEl: HTMLElement;
  private progFill: HTMLElement;
  private progText: HTMLElement;
  private insideEl: HTMLElement;
  private arrowEl: HTMLElement;

  private kind: HazardKind | null = null;
  /** `ctx.time` at which the announced hazard starts, or NONE while nothing is announced. */
  private startsAt = NONE;
  /** `ctx.time` until which the `시작` banner stays up, or NONE. */
  private startedUntil = NONE;
  private lastSecond = NONE;
  private inside = false;
  private progress = 0;
  private lastFill = -1;
  private lastArrow = 999;
  private v = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  /**
   * `parent` = the gameplay layer (banner / gauge / arrow), `overlay` = the full-screen overlay layer, which is where
   * the edge pulse belongs — it must survive next to the vignette and the damage flash rather than inside the HUD.
   */
  constructor(parent: HTMLElement, overlay: HTMLElement) {
    this.root = el('div', { cls: 'hz-hud', parent });

    this.bannerEl = el('div', { cls: 'hz-banner', parent: this.root });
    el('i', { cls: 'warn', parent: this.bannerEl });
    this.bannerText = el('span', { cls: 'txt', text: '', parent: this.bannerEl });

    this.progEl = el('div', { cls: 'hz-prog', parent: this.root });
    const head = el('div', { cls: 'row', parent: this.progEl });
    el('span', { cls: 'ui-label', text: '안전지대', parent: head });
    this.progText = el('span', { cls: 'num ui-mono', text: '100%', parent: head });
    const bar = el('div', { cls: 'bar', parent: this.progEl });
    this.progFill = el('div', { cls: 'fill', parent: bar });
    this.arrowEl = el('div', { cls: 'hz-arrow', parent: this.progEl });
    el('i', { parent: this.arrowEl });
    el('span', { text: '안전 방향', parent: this.arrowEl });

    this.insideEl = el('div', { cls: 'hz-inside', text: '위험 구역 — 즉시 벗어나라', parent: this.root });

    this.edge = el('div', { cls: 'hz-edge', parent: overlay });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('hazard:announced', ({ kind, secondsLeft }) => {
        this.kind = kind;
        this.startsAt = ctx.time + Math.max(0, secondsLeft);
        this.startedUntil = NONE;
        this.lastSecond = NONE;
        ctx.bus.emit('ui:notify', { text: `${HAZARD_LABEL_KO[kind]} 접근 — ${Math.ceil(secondsLeft)}초`, kind: 'warning', duration: 3.5 });
        ctx.bus.emit('audio:play', { id: 'wave_alarm', volume: 0.7 });
      }),
      b.on('hazard:started', ({ kind }) => {
        this.kind = kind;
        this.startsAt = NONE;
        this.startedUntil = ctx.time + 3;
        this.lastSecond = NONE;
        setText(this.bannerText, `${HAZARD_LABEL_KO[kind]} 시작`);
        ctx.bus.emit('ui:notify', { text: `${HAZARD_LABEL_KO[kind]} 시작`, kind: 'danger', duration: 3 });
        ctx.bus.emit('audio:play', { id: 'wave_alarm', volume: 0.85 });
      }),
      b.on('hazard:progress', ({ progress }) => { this.progress = Math.max(0, Math.min(1, progress)); }),
      b.on('hazard:insideChanged', ({ inside, kind }) => {
        if (kind) this.kind = kind;
        if (inside === this.inside) return;
        this.inside = inside;
        toggleClass(this.edge, 'show', inside);
        toggleClass(this.insideEl, 'show', inside);
        if (inside) ctx.bus.emit('audio:play', { id: 'wave_alarm', volume: 0.6 });
      }),
      b.on('player:died', () => this.clearInside()),
      b.on('game:newMission', () => this.reset()),
      b.on('game:abort', () => this.reset()),
    );
  }

  /** Whether the warning banner / the inside warning are up, and the drawn safe-zone share (debug / smoke). */
  get isBannerOn(): boolean { return this.bannerEl.classList.contains('show'); }
  get isInside(): boolean { return this.inside; }
  get safeShare(): number { return 1 - this.progress; }

  private reset(): void {
    this.kind = null;
    this.startsAt = NONE; this.startedUntil = NONE; this.lastSecond = NONE;
    this.progress = 0; this.lastFill = -1;
    this.clearInside();
    toggleClass(this.bannerEl, 'show', false);
    toggleClass(this.progEl, 'show', false);
  }

  private clearInside(): void {
    if (!this.inside) return;
    this.inside = false;
    toggleClass(this.edge, 'show', false);
    toggleClass(this.insideEl, 'show', false);
  }

  update(ctx: GameContext): void {
    const hazard = ctx.world?.hazard ?? null;

    // 예고 배너: 남은 초를 로컬에서 센다 (`hazard:announced` 는 한 번만 온다)
    let banner = false;
    if (this.startsAt !== NONE && this.kind) {
      const left = this.startsAt - ctx.time;
      if (left <= 0) { this.startsAt = NONE; } else {
        banner = true;
        const s = Math.ceil(left);
        if (s !== this.lastSecond) { this.lastSecond = s; setText(this.bannerText, `${HAZARD_LABEL_KO[this.kind]} 접근 — ${s}초`); }
      }
    } else if (this.startedUntil !== NONE) {
      if (ctx.time < this.startedUntil) banner = true; else this.startedUntil = NONE;
    }
    if (banner !== this.bannerEl.classList.contains('show')) toggleClass(this.bannerEl, 'show', banner);

    // 안전지대 게이지: 재해가 굴러가는 동안만
    const active = hazard?.active === true;
    if (active !== this.progEl.classList.contains('show')) toggleClass(this.progEl, 'show', active);
    if (!active) return;
    if (hazard) this.progress = Math.max(0, Math.min(1, hazard.progress));
    const safe = 1 - this.progress;
    const pct = Math.round(safe * 100);
    if (pct !== this.lastFill) {
      this.lastFill = pct;
      this.progFill.style.transform = `scaleX(${safe.toFixed(3)})`;
      setText(this.progText, pct <= 0 ? '없음' : `${pct}%`);
      toggleClass(this.progEl, 'critical', pct <= 20);
    }
    this.updateArrow(ctx, hazard?.getZones() ?? null);
  }

  /**
   * 안전 방향: 각 구역에서 **벗어나는** 방향의 합. `front` 는 법선(`dirX,dirZ`)이 안전한 쪽이고, `circle` 은
   * `safeInside` 면 중심 쪽 · 아니면 바깥쪽이다. 합이 0에 가까우면 (사방이 안전 / 판단 불가) 화살표를 숨긴다.
   */
  private updateArrow(ctx: GameContext, zones: readonly HazardZone[] | null): void {
    const p = ctx.player;
    if (!p || !zones || !zones.length) { this.hideArrow(); return; }
    let sx = 0, sz = 0;
    for (const z of zones) {
      if (z.shape === 'front') { sx += z.dirX; sz += z.dirZ; continue; }
      const dx = p.position.x - z.center.x, dz = p.position.z - z.center.z;
      const d = Math.hypot(dx, dz) || 1;
      if (z.safeInside) { sx -= dx / d; sz -= dz / d; }   // 원 안이 안전 → 중심으로
      else { sx += dx / d; sz += dz / d; }                 // 원 안이 위험 → 바깥으로
    }
    if (Math.hypot(sx, sz) < 1e-3) { this.hideArrow(); return; }
    // 카메라 기준 상대 각 (0 = 정면, 시계방향) — 나침반의 heading 계산과 같은 규약
    const f = ctx.camera.getWorldDirection(this.v);
    const heading = Math.atan2(f.x, -f.z);
    const bearing = Math.atan2(sx, -sz);
    let rel = bearing - heading;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const deg = Math.round((rel * 180) / Math.PI);
    if (deg === this.lastArrow) { if (!this.arrowEl.classList.contains('show')) toggleClass(this.arrowEl, 'show', true); return; }
    this.lastArrow = deg;
    this.arrowEl.style.setProperty('--rot', `${deg}deg`);
    toggleClass(this.arrowEl, 'show', true);
  }

  private hideArrow(): void {
    if (this.arrowEl.classList.contains('show')) { toggleClass(this.arrowEl, 'show', false); this.lastArrow = 999; }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
    this.edge.remove();
  }
}
