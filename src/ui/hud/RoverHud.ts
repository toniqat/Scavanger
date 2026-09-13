import type { GameContext, RoverRef } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { clamp01, el, fmtInt, setText, toggleClass } from '../dom';
import '../styles/rover.css';

/**
 * 탐사 차량 탑승 HUD (2026-09-13). `ctx.world.rover.localAboard` 동안만 뜬다 — 게임플레이 레이어의 하단 중앙.
 *
 *  - **탑승 모드**: 게임플레이 HUD 루트(`parent`)에 `rover-view` 를 켠다 — CSS 가 무기 패널 · 임플란트 · 함선 호출 ·
 *    스태미나 · 크로스헤어 · 게이지 · 휠을 숨긴다 (`drone-view` 와 같은 목록 — 탑승 중에는 쓸 수 없다).
 *  - **패널**: `탐사 차량` 태그 · 체력 `1,420 / 2,000` · 체력 바(25 % 아래 붉게) · 상태 한 줄
 *    (`정차 중 · M 목적지 선택` / `출발까지 N초 → 정류장 X` / `이동 중 → 정류장 X`).
 *  - **키 가이드**: 정차 중에만 `ui:keyGuide {owner:'rover'}` 로 `M 목적지 선택` (가이드는 이 owner 에 닫기를 붙이지 않는다 —
 *    `hud/KeyGuide` 의 `NO_CLOSE_OWNERS`). 하차 E 홀드 프롬프트는 player 의 상호작용 프롬프트가 맡는다 (여기서 중복하지 않는다).
 *
 * 토스트(정류장 공개 · 결제 출발 · 도착 · 파괴 · 체력 경고)는 `hud/RaidAlerts`, 지도 목적지 선택은 `map/MapScreen`.
 * DOM 쓰기는 값이 바뀔 때만 한다 (키 문자열 비교).
 */
export class RoverHud {
  readonly root: HTMLElement;
  private readonly parent: HTMLElement;
  private readonly hpVal: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly stateEl: HTMLElement;
  private ctx: GameContext | null = null;
  private shown = false;
  private guideOn = false;
  private lastKey = '';
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.parent = parent;
    this.root = el('div', { cls: 'rv-hud', parent });
    const head = el('div', { cls: 'rv-head', parent: this.root });
    el('span', { cls: 'rv-tag', text: '탐사 차량', parent: head });
    this.hpVal = el('span', { cls: 'rv-hpval ui-mono', text: '', parent: head });
    const bar = el('div', { cls: 'rv-bar', parent: this.root });
    this.hpFill = el('div', { cls: 'fill', parent: bar });
    this.stateEl = el('div', { cls: 'rv-state', text: '', parent: this.root });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('input:bindingsChanged', () => { this.lastKey = ''; if (this.guideOn) this.emitGuide(true); }),
      // KeyGuide 는 이 두 이벤트에 스스로 스택을 비운다 — 여기 상태도 맞춰 둔다
      b.on('game:newMission', () => this.hide()),
      b.on('game:abort', () => this.hide()),
    );
  }

  /** Per frame (HudSystem, 레이어 가시성과 무관 — 가이드 · 클래스를 제때 걷어야 한다). */
  update(_dt: number, ctx: GameContext): void {
    const rv: RoverRef | null = ctx.world?.rover ?? null;
    const aboard = !!rv?.localAboard && ctx.isGameplayPhase();
    if (aboard !== this.shown) {
      this.shown = aboard;
      toggleClass(this.root, 'show', aboard);
      toggleClass(this.parent, 'rover-view', aboard);
      this.lastKey = '';
    }
    const wantGuide = aboard && rv !== null && rv.vehicle.state === 'stopped';
    if (wantGuide !== this.guideOn) { this.guideOn = wantGuide; this.emitGuide(wantGuide); }
    if (!aboard || !rv) return;

    const v = rv.vehicle;
    const frac = v.maxHp > 0 ? clamp01(v.hp / v.maxHp) : 0;
    const target = v.targetId ? this.stationLabel(rv, v.targetId) : '';
    const key = `${Math.ceil(v.hp)}|${v.maxHp}|${v.state}|${Math.ceil(v.timer)}|${target}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    setText(this.hpVal, `${fmtInt(Math.max(0, Math.ceil(v.hp)))} / ${fmtInt(v.maxHp)}`);
    this.hpFill.style.width = `${(frac * 100).toFixed(1)}%`;
    toggleClass(this.root, 'low', frac <= 0.25);
    setText(this.stateEl, this.stateText(rv, target));
  }

  private stateText(rv: RoverRef, target: string): string {
    const v = rv.vehicle;
    switch (v.state) {
      case 'stopped': return `정차 중 · ${keyLabel(Keys.MAP)} 목적지 선택`;
      case 'departing': return `출발까지 ${Math.max(0, Math.ceil(v.timer))}초 → ${target || '목적지'}`;
      case 'trip': return `이동 중 → ${target || '목적지'} · 하차 불가`;
      case 'patrol': return target ? `순환 운행 → ${target}` : '순환 운행 중';
      case 'destroyed': return '파괴됨';
    }
  }

  private stationLabel(rv: RoverRef, id: string): string {
    for (const st of rv.route.stations) if (st.id === id) return st.label;
    return '';
  }

  private emitGuide(on: boolean): void {
    this.ctx?.bus.emit('ui:keyGuide', { owner: 'rover', keys: on ? [{ key: keyLabel(Keys.MAP), label: '목적지 선택' }] : null });
  }

  private hide(): void {
    this.guideOn = false;
    if (this.shown) {
      this.shown = false;
      toggleClass(this.root, 'show', false);
      toggleClass(this.parent, 'rover-view', false);
    }
    this.lastKey = '';
  }

  /** 스모크 훅: 탑승 HUD 가 떠 있는가. */
  get isShowing(): boolean { return this.shown; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.guideOn) this.emitGuide(false);
    this.parent.classList.remove('rover-view');
    this.root.remove();
  }
}
