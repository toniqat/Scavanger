import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { el, toggleClass } from '../dom';

type StatusKind = 'burn' | 'shock';

/** Lifetime per kind (s, simulation time): 전소 marker fades over 1.5 s, the spark flashes for 0.6 s. */
const LIFETIME: Readonly<Record<StatusKind, number>> = { burn: 1.5, shock: 0.6 };
const TEXT: Readonly<Record<StatusKind, string>> = { burn: '🔥 전소', shock: '⚡' };
const POOL = 12;
/** Height above the enemy position the marker floats at (m). */
const LIFT = 1.6;

interface Slot {
  el: HTMLElement;
  kind: StatusKind | null;
  pos: THREE.Vector3;
  born: number;
  lastKey: string;
}

/**
 * Pooled world-space status markers in the gameplay layer: `enemy:incinerated` → `🔥 전소` (`.smarker.burn`, rises and fades
 * over 1.5 s), `enemy:shocked` → `⚡` spark (`.smarker.shock`, 0.6 s pop). Positions are projected through `ctx.camera` in
 * `lateUpdate`; DOM is written only when the rounded transform / opacity changes. Ages on `ctx.time` (never wall-clock).
 * Oldest slot is recycled when all 12 are busy. Cleared on mission reset.
 */
export class StatusMarkers {
  readonly root: HTMLElement;
  private slots: Slot[] = [];
  private v = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'status-markers', parent });
    for (let i = 0; i < POOL; i++) {
      const e = el('div', { cls: 'smarker', parent: this.root });
      this.slots.push({ el: e, kind: null, pos: new THREE.Vector3(), born: 0, lastKey: '' });
    }
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('enemy:incinerated', ({ position }) => this.spawn('burn', position, ctx.time)),
      b.on('enemy:shocked', ({ position }) => this.spawn('shock', position, ctx.time)),
      b.on('game:newMission', () => this.clear()),
      b.on('game:abort', () => this.clear()),
    );
  }

  /** Live markers (debug). */
  get activeCount(): number { let n = 0; for (const s of this.slots) if (s.kind) n++; return n; }

  private spawn(kind: StatusKind, position: THREE.Vector3, now: number): void {
    let slot: Slot | null = null;
    let oldest: Slot = this.slots[0];
    for (const s of this.slots) {
      if (!s.kind) { slot = s; break; }
      if (s.born < oldest.born) oldest = s;
    }
    if (!slot) slot = oldest;
    slot.kind = kind;
    slot.pos.copy(position);
    slot.born = now;
    slot.lastKey = '';
    slot.el.textContent = TEXT[kind];
    toggleClass(slot.el, 'burn', kind === 'burn');
    toggleClass(slot.el, 'shock', kind === 'shock');
    toggleClass(slot.el, 'show', true);
  }

  private release(s: Slot): void {
    s.kind = null;
    s.lastKey = '';
    s.el.classList.remove('show', 'burn', 'shock');
    s.el.style.opacity = '0';
  }

  private clear(): void { for (const s of this.slots) if (s.kind) this.release(s); }

  lateUpdate(ctx: GameContext): void {
    const cam = ctx.camera;
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    const now = ctx.time;
    for (const s of this.slots) {
      if (!s.kind) continue;
      const life = LIFETIME[s.kind];
      const age = now - s.born;
      if (age >= life) { this.release(s); continue; }
      const t = age / life;
      this.v.copy(s.pos);
      this.v.y += LIFT + (s.kind === 'burn' ? t * 0.8 : t * 0.3);
      this.v.project(cam);
      if (this.v.z > 1 || this.v.z < -1) { this.hide(s); continue; }
      const sx = (this.v.x * 0.5 + 0.5) * w;
      const sy = (-this.v.y * 0.5 + 0.5) * h;
      if (sx < -60 || sx > w + 60 || sy < -40 || sy > h + 40) { this.hide(s); continue; }
      // burn: hold then fade over the last 60 %; shock: quick pop, then fade.
      const alpha = s.kind === 'burn' ? (t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6) : 1 - t * t;
      const key = `${Math.round(sx)}|${Math.round(sy)}|${alpha.toFixed(2)}`;
      if (key === s.lastKey) continue;
      s.lastKey = key;
      s.el.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -50%)`;
      s.el.style.opacity = alpha.toFixed(2);
    }
  }

  private hide(s: Slot): void {
    if (s.lastKey !== 'hidden') { s.lastKey = 'hidden'; s.el.style.opacity = '0'; }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
