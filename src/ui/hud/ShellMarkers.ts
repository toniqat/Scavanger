import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { DETECT_ENEMY_BASE_RADIUS, shellLaunchVelocity, shellPositionAt } from '@/shared';
import { el } from '../dom';
import '../styles/shellMarkers.css';

/** Pooled markers (on-screen glyphs) and edge arrows — enough for every live shell of two dug-in mortars. */
const MAX = 8;
/** Same edge ring as `Detection`'s enemy arrows, so a shell arrow and an enemy arrow line up. */
const ARROW_RX = 0.34;
const ARROW_RY = 0.34;
/** A shell this close to landing gets the `hot` class (faster pulse). */
const HOT_S = 1.5;
/** Fallback lifetime past `flightTime` (mirrors `ShellProjectile`'s timeout) if neither landed nor intercepted arrives. */
const TIMEOUT_PAD_S = 2.5;

interface Tracked {
  sid: number;
  from: THREE.Vector3;
  vel0: THREE.Vector3;
  flight: number;
  life: number;
  active: boolean;
}
interface Mark { el: HTMLElement; lastKey: string }

/**
 * 포탄 HUD 마커 (2026-09-09). While an artillery shell is in flight **and inside the player's enemy detect radius**
 * (`ctx.progression.derived.enemyDetectRadius` — the 인지력 radius `Detection` uses for enemies), it gets a HUD marker:
 * on screen a danger-coloured diamond with the label `포탄` projected at the shell; off screen an edge arrow on the same
 * ring as the detected-enemy arrows. **Screen marker only — no ground ring** (user decision).
 *
 * The shell's position is not read from the enemies folder (no cross-folder import): the marker integrates the same
 * closed-form arc `enemies/fx/ShellProjectile` flies. 2026-09-10: 그 수식은 이제 `@/shared/ballistics` 한 곳에 있고
 * (`shellLaunchVelocity` · `shellPositionAt`, 중력은 `SHELL_ARC_GRAVITY`) 양쪽이 그것을 부른다 — 베껴 두지 않는다. 인자는
 * the `enemy:shellFired {sid, from, target, flightTime}` payload, so it sits exactly on the visible shell. `life` is
 * accumulated from the same `dt`, like the shell. Dropped on `enemy:shellLanded` / `enemy:shellIntercepted` for that
 * `sid`, or after `flightTime + 2.5 s` as a safety net; cleared on `game:abort` / `game:newMission`.
 *
 * Pooled DOM (MAX marks + MAX arrows), no per-frame allocation, hidden while a menu / the map is open or the player is dead.
 */
export class ShellMarkers {
  readonly root: HTMLElement;
  private ctx!: GameContext;
  private readonly marks: Mark[] = [];
  private readonly arrows: Mark[] = [];
  private readonly tracked: Tracked[] = [];
  private readonly v = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private shown = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'shellmk', parent });
    for (let i = 0; i < MAX; i++) {
      const m = el('div', { cls: 'shellmk-mark', parent: this.root });
      m.hidden = true;
      el('i', { parent: m });
      el('b', { cls: 'ui-mono', text: '포탄', parent: m });
      this.marks.push({ el: m, lastKey: '' });
      const a = el('div', { cls: 'shellmk-arrow', parent: this.root });
      a.hidden = true;
      el('i', { parent: a });
      this.arrows.push({ el: a, lastKey: '' });
      this.tracked.push({ sid: 0, from: new THREE.Vector3(), vel0: new THREE.Vector3(), flight: 0, life: 0, active: false });
    }
  }

  /** Markers + arrows currently visible (debug / smoke). */
  get visibleCount(): number { return this.shown; }
  /** Shells currently tracked (debug / smoke). */
  get trackedCount(): number { let n = 0; for (const t of this.tracked) if (t.active) n++; return n; }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('enemy:shellFired', ({ sid, from, target, flightTime }) => this.track(sid, from, target, flightTime)),
      b.on('enemy:shellLanded', ({ sid }) => this.untrack(sid)),
      b.on('enemy:shellIntercepted', ({ sid }) => this.untrack(sid)),
      b.on('game:abort', () => this.clear()),
      b.on('game:newMission', () => this.clear()),
      b.on('hub:entered', () => this.clear()),
    );
  }

  private track(sid: number, from: THREE.Vector3, target: THREE.Vector3, flightTime: number): void {
    // re-fired id (host migration re-sends) → refresh in place; else take a free slot; else evict the oldest
    let slot: Tracked | null = null;
    for (const t of this.tracked) if (t.active && t.sid === sid) { slot = t; break; }
    if (!slot) for (const t of this.tracked) if (!t.active) { slot = t; break; }
    if (!slot) { slot = this.tracked[0]; for (const t of this.tracked) if (t.life > slot.life) slot = t; }
    const T = Math.max(0.5, flightTime);
    slot.sid = sid;
    slot.from.copy(from);
    shellLaunchVelocity(from, target, T, slot.vel0);
    slot.flight = T;
    slot.life = 0;
    slot.active = true;
  }

  private untrack(sid: number): void {
    for (const t of this.tracked) if (t.active && t.sid === sid) t.active = false;
  }

  private clear(): void {
    for (const t of this.tracked) t.active = false;
    this.hideAll();
  }

  private hideAll(): void {
    for (const m of this.marks) if (!m.el.hidden) { m.el.hidden = true; m.lastKey = ''; }
    for (const a of this.arrows) if (!a.el.hidden) { a.el.hidden = true; a.lastKey = ''; }
    this.shown = 0;
  }

  private radius(ctx: GameContext): number {
    const r = ctx.progression?.derived?.enemyDetectRadius;
    return typeof r === 'number' && r > 0 ? r : DETECT_ENEMY_BASE_RADIUS;
  }

  /** Called after the camera has moved (HudSystem `lateUpdate`) so the projection matches the frame being drawn. */
  lateUpdate(dt: number, ctx: GameContext): void {
    // advance every tracked shell even while hidden, so a marker that reappears is where the shell is
    for (const t of this.tracked) {
      if (!t.active) continue;
      t.life += dt;
      if (t.life > t.flight + TIMEOUT_PAD_S) t.active = false;
    }
    const player = ctx.player;
    const active = ctx.isGameplayPhase() && !!player && !player.isDead
      && !ctx.uiBlockers.has('menu') && !ctx.uiBlockers.has('map');
    if (!active) { if (this.shown) this.hideAll(); return; }

    const cam = ctx.camera;
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    if (w <= 0 || h <= 0) return;
    const cx = w / 2, cy = h / 2;
    const rx = w * ARROW_RX, ry = h * ARROW_RY;
    const from = player!.position;
    const r = this.radius(ctx);
    const r2 = r * r;
    let marks = 0, arrows = 0;
    for (const t of this.tracked) {
      if (!t.active) continue;
      const life = t.life;
      shellPositionAt(t.from, t.vel0, life, this.p);
      const dx = this.p.x - from.x, dz = this.p.z - from.z;
      if (dx * dx + dz * dz > r2) continue;                   // outside the 인지 radius → no marker
      const hot = t.flight - life < HOT_S;
      this.v.copy(this.p).project(cam);
      const behind = this.v.z > 1;
      if (behind) { this.v.x = -this.v.x; this.v.y = -this.v.y; }
      const off = behind || Math.abs(this.v.x) > 0.98 || Math.abs(this.v.y) > 0.98;
      if (!off) {
        if (marks >= MAX) continue;
        const px = (this.v.x * 0.5 + 0.5) * w;
        const py = (-this.v.y * 0.5 + 0.5) * h;
        const m = this.marks[marks++];
        const key = `${px.toFixed(0)}|${py.toFixed(0)}|${hot ? 1 : 0}`;
        if (m.el.hidden) m.el.hidden = false;
        if (key !== m.lastKey) {
          m.lastKey = key;
          m.el.style.transform = `translate(${px.toFixed(0)}px, ${py.toFixed(0)}px)`;
          m.el.classList.toggle('hot', hot);
        }
        continue;
      }
      if (arrows >= MAX) continue;
      const ang = Math.atan2(this.v.y, this.v.x);
      const px = cx + Math.cos(ang) * rx;
      const py = cy - Math.sin(ang) * ry;
      const deg = (-ang * 180) / Math.PI;
      const a = this.arrows[arrows++];
      const key = `${px.toFixed(0)}|${py.toFixed(0)}|${deg.toFixed(0)}|${hot ? 1 : 0}`;
      if (a.el.hidden) a.el.hidden = false;
      if (key !== a.lastKey) {
        a.lastKey = key;
        a.el.style.transform = `translate(${px.toFixed(0)}px, ${py.toFixed(0)}px) translate(-50%, -50%) rotate(${deg.toFixed(0)}deg)`;
        a.el.classList.toggle('hot', hot);
      }
    }
    for (let i = marks; i < MAX; i++) { const m = this.marks[i]; if (!m.el.hidden) { m.el.hidden = true; m.lastKey = ''; } }
    for (let i = arrows; i < MAX; i++) { const a = this.arrows[i]; if (!a.el.hidden) { a.el.hidden = true; a.lastKey = ''; } }
    this.shown = marks + arrows;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
