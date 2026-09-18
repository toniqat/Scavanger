import type { GameContext, RoverRef } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { clamp01, el, fmtInt, setText, toggleClass } from '../dom';
import '../styles/rover.css';

/**
 * Rover passenger HUD (2026-09-13). Up only while `ctx.world.rover.localAboard` — bottom centre of the gameplay layer.
 *
 *  - **Riding mode**: turns `rover-view` on at the gameplay HUD root (`parent`) — CSS hides the weapon panel · implant ·
 *    ship call · stamina · crosshair · gauges · wheels (the same list as `drone-view` — none of it is usable aboard).
 *  - **Panel**: the `탐사 차량` tag · hp `1,420 / 2,000` · the hp bar (red below 25 %) · one state line
 *    (`정차 중 · M 목적지 선택` / `출발까지 N초 → 정류장 X` / `이동 중 → 정류장 X`).
 *  - **Key guide**: only while stopped, `M 목적지 선택` through `ui:keyGuide {owner:'rover'}` (the guide appends no close
 *    entry for this owner — `NO_CLOSE_OWNERS` in `hud/KeyGuide`). The E-hold prompt to get off is the player's interaction prompt (not duplicated here).
 *
 * The toasts (stations revealed · paid departure · arrival · destruction · hp warnings) are `hud/RaidAlerts`, and picking
 * a destination on the map is `map/MapScreen`. The DOM is written only when a value changed (key string comparison).
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
      // KeyGuide empties its own stack on these two events — the state here is kept in step
      b.on('game:newMission', () => this.hide()),
      b.on('game:abort', () => this.hide()),
    );
  }

  /** Per frame (HudSystem, independent of layer visibility — the guide · classes must be cleared in time). */
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

  /** Smoke hook: whether the passenger HUD is up. */
  get isShowing(): boolean { return this.shown; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.guideOn) this.emitGuide(false);
    this.parent.classList.remove('rover-view');
    this.root.remove();
  }
}
