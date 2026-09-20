import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { el, damp } from '../dom';

interface Arc { el: HTMLElement; angle: number; life: number; }
const ARC_POOL = 6;
const ARC_LIFE = 1.4;

/**
 * Directional damage arcs around the reticle, low-HP vignette with heartbeat, red edge flash.
 *
 * 2026-09-09: the arc is a **220 px ring with a 6 px, ~70° red wedge** (`.dmg-arc`: conic-gradient masked to a ring,
 * drop-shadow glow; peak opacity 0.95, life 1.4 s, `rotate(angle)` unchanged) — the old 140 px / 3 px border-top arc was
 * too faint to read mid-fight. Arcs are driven by **`ui:damageIndicator` only**: `player/parts/Vitals` emits it *and*
 * `player:damaged {from}` for the same hit, and listening to both drew two arcs per hit. `player:damaged` still drives
 * the edge flash (it also fires for damage-over-time, which has no direction).
 */
export class DamageOverlay {
  readonly vignette: HTMLElement;
  readonly edgeFlash: HTMLElement;
  readonly arcsRoot: HTMLElement;
  private arcs: Arc[] = [];
  private vignetteAlpha = 0;
  private lastVig = -1;
  private heartbeat = 0;
  private tmp = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.vignette = el('div', { cls: 'vignette', parent });
    this.edgeFlash = el('div', { cls: 'edge-flash', parent });
    this.arcsRoot = el('div', { cls: 'dmg-arcs', parent });
    for (let i = 0; i < ARC_POOL; i++) {
      this.arcs.push({ el: el('div', { cls: 'dmg-arc', parent: this.arcsRoot }), angle: 0, life: 0 });
    }
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('ui:damageIndicator', ({ from }) => this.indicate(from, ctx)),
      // edge flash only — the arc for this hit comes through `ui:damageIndicator` (same emitter, one arc per hit)
      ctx.bus.on('player:damaged', () => {
        this.edgeFlash.classList.remove('show');
        void this.edgeFlash.offsetWidth;
        this.edgeFlash.classList.add('show');
        window.setTimeout(() => this.edgeFlash.classList.remove('show'), 40);
      }),
      ctx.bus.on('game:newMission', () => this.reset()),
      ctx.bus.on('game:abort', () => this.reset()),
    );
  }

  private indicate(from: THREE.Vector3, ctx: GameContext): void {
    const player = ctx.player;
    if (!player) return;
    this.tmp.subVectors(from, player.position);
    if (this.tmp.lengthSq() < 0.01) return;
    // Screen-relative angle: 0 = ahead (top of ring), clockwise.
    const camF = ctx.camera.getWorldDirection(new THREE.Vector3());
    const camYaw = Math.atan2(camF.x, -camF.z);
    const toYaw = Math.atan2(this.tmp.x, -this.tmp.z);
    let rel = toYaw - camYaw;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const deg = THREE.MathUtils.radToDeg(rel);
    // Reuse an arc close to this angle, else the oldest.
    let slot = this.arcs.find((a) => a.life > 0 && Math.abs(((a.angle - deg + 540) % 360) - 180) < 25);
    if (!slot) slot = this.arcs.reduce((best, a) => (a.life < best.life ? a : best), this.arcs[0]);
    slot.angle = deg;
    slot.life = ARC_LIFE;
  }

  update(dt: number, ctx: GameContext): void {
    for (const a of this.arcs) {
      if (a.life <= 0) continue;
      a.life -= dt;
      const t = Math.max(0, a.life / ARC_LIFE);
      const alpha = t < 0.3 ? t / 0.3 : 1;
      a.el.style.opacity = (alpha * 0.95).toFixed(2);
      a.el.style.transform = `rotate(${a.angle.toFixed(1)}deg) scale(${(1 + (1 - t) * 0.15).toFixed(3)})`;
      if (a.life <= 0) a.el.style.opacity = '0';
    }

    const p = ctx.player;
    const ratio = p ? p.hp / Math.max(1, p.maxHp) : 1;
    let target = 0;
    if (p && !p.isDead && ratio < 0.4 && ctx.isGameplayPhase()) {
      const sev = 1 - ratio / 0.4; // 0..1
      this.heartbeat += dt * (1.2 + sev * 1.2) * Math.PI * 2;
      const beat = Math.pow(Math.max(0, Math.sin(this.heartbeat)), 6);
      target = 0.35 + sev * 0.45 + beat * 0.25;
    } else if (p?.isDead) {
      target = 0.9;
    }
    this.vignetteAlpha = damp(this.vignetteAlpha, target, 8, dt);
    if (Math.abs(this.vignetteAlpha - this.lastVig) > 0.005) {
      this.lastVig = this.vignetteAlpha;
      this.vignette.style.opacity = this.vignetteAlpha.toFixed(3);
    }
  }

  private reset(): void {
    for (const a of this.arcs) { a.life = 0; a.el.style.opacity = '0'; }
    this.vignetteAlpha = 0;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.vignette.remove(); this.edgeFlash.remove(); this.arcsRoot.remove();
  }
}
