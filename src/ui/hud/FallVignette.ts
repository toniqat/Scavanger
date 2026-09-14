import type { GameContext } from '@/shared';
import { FALL_VIGNETTE_FULL_DAMAGE, FALL_VIGNETTE_S } from '@/shared';
import { el } from '../dom';
import '../styles/fall.css';

/** Opacity under which the plate is hidden outright (no composited full-screen layer left behind). */
const OFF = 0.002;
/** Skip style writes smaller than this (the fade still lands on exactly 0 through `OFF`). */
const WRITE_EPS = 0.004;

/**
 * 낙하 붉은 비네트 (`.fall-vignette`, `#ui-root` 직계, 2026-09-15, TODO B-14).
 *
 * `player:fell {damage}` — 로컬 플레이어가 떨어져 **실제로 깎였을 때만** 오는 사실 — 에 세기
 * `min(1, damage / FALL_VIGNETTE_FULL_DAMAGE)` 로 켜지고 `FALL_VIGNETTE_S` 동안 사라진다(곡선 `k²` — 번쩍 뜨고 빨리 빠진다).
 * 이미 더 진하게 떠 있으면 새 낙하는 무시하고, 더 세면 그 세기로 다시 시작한다 (최댓값). 분대원 낙하(`player:remoteFell`)는
 * 소리 전용이라 여기서는 듣지 않는다. 착지 흔들림은 player 의 `camera:shake`, 소리는 audio 의 몫이다.
 *
 * 사라짐은 CSS 전이가 아니라 `update(dt)` 다 — 시뮬레이션 시간을 따르고, `prefers-reduced-motion` 이 전이를 0 으로 자르는
 * PC 에서도 똑같이 보여야 한다. `game:abort` · `game:newMission` · `hub:entered` 에서 즉시 꺼진다.
 */
export class FallVignette {
  readonly root: HTMLElement;
  private peak = 0;
  private left = 0;
  private shown = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'fall-vignette', parent });
    this.root.hidden = true;
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('player:fell', ({ damage }) => this.hit(damage)),
      b.on('game:abort', () => this.reset()),
      b.on('game:newMission', () => this.reset()),
      b.on('hub:entered', () => this.reset()),
    );
  }

  private hit(damage: number): void {
    if (!(damage > 0)) return;
    const full = FALL_VIGNETTE_FULL_DAMAGE > 0 ? FALL_VIGNETTE_FULL_DAMAGE : 1;
    const strength = Math.min(1, damage / full);
    if (strength <= this.shown) return;          // 이미 더 진하다 — 최댓값
    this.peak = strength;
    this.left = Math.max(0.001, FALL_VIGNETTE_S);
    this.write(strength, true);
  }

  update(dt: number): void {
    if (this.left <= 0) return;
    this.left -= Math.max(0, dt);
    const S = Math.max(0.001, FALL_VIGNETTE_S);
    const k = this.left > 0 ? this.left / S : 0;
    this.write(this.peak * k * k, false);
  }

  private write(o: number, force: boolean): void {
    if (o <= OFF) {
      this.left = 0;
      this.peak = 0;
      if (this.shown !== 0 || !this.root.hidden) {
        this.shown = 0;
        this.root.style.opacity = '0';
        this.root.hidden = true;
      }
      return;
    }
    if (!force && Math.abs(o - this.shown) < WRITE_EPS) return;
    this.shown = o;
    if (this.root.hidden) this.root.hidden = false;
    this.root.style.opacity = o.toFixed(3);
  }

  private reset(): void { this.write(0, true); }

  /** Current plate opacity, 0 = off (debug / smoke). */
  get opacity(): number { return this.shown; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
