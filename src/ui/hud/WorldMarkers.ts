import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';

interface Marker {
  el: HTMLElement;
  dist: HTMLElement;
  pos: THREE.Vector3;
  lastKey: string;
}

/**
 * Projects extraction pads to screen-space diamond markers.
 *
 * **2026-09-09 — the discovery gate.** A pad nobody has walked near yet does not exist for the HUD: the marker is built
 * at `world:ready` as before but stays hidden until `ctx.world.fog.isDiscovered(position)` is true (the fog reveals
 * on the whole squad's positions, so a squadmate finding it counts). The **active** pad is exempt — once the
 * countdown runs everybody knows where to go. No fog (the training range / an older world) → everything shows as before.
 *
 * **2026-09-14 (tutorial)** — this is the 「world (3D) marker」 the contract names (`hides('hud','shipMarker')`). The
 * tutorial raid **does not draw** the extraction ship diamond at all until the last `extract` step; entering that
 * step releases the gate and it appears as usual. The screen-fixed readout (the compass) is a separate name
 * (`shipScreenMarker`), so it is gone for the whole raid. Outside the tutorial the query is always false, so the
 * normal screen does not change by one glyph.
 *
 * **2026-09-17 (user's decision — 「remove the green translucent sphere floating over the ship entrance」)** — the
 * world marker of the landed ship (`탈출 함선`, the green `.wmarker.ship` circle) is **not drawn in any raid**. It
 * was projected at the ship position + 2.2 m, so it hovered right above the ramp entrance, and up close its alpha
 * only fell to 0.15 — a translucent bead plus faint 「탈출 함선」 text. The ship is a huge landmark by itself, and
 * the ship markers on the map (`ui/map/MapScreen`) · compass (`Compass`) are unchanged. Once the ship sets down the
 * active pad diamond also stays hidden — the pad centre is the ramp entrance, so it would rise in the same spot again.
 */
export class WorldMarkers {
  readonly root: HTMLElement;
  private markers = new Map<string, Marker>();
  private activeId: string | null = null;
  /** The ship has landed — used only to hide the active pad diamond (the ship marker itself is not drawn). */
  private shipLanded = false;
  private v = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'world-markers', parent });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('world:ready', () => {
        this.clear();
        if (ctx.missionMode === 'training' || ctx.world?.mode === 'training') return; // Phase 7: no extraction in the arena
        for (const p of ctx.world?.getExtractionPoints() ?? []) this.add(p.id, p.position, '탈출 지점', 'wmarker');
      }),
      b.on('extraction:activated', ({ pointId }) => {
        this.activeId = pointId;
        for (const [id, m] of this.markers) toggleClass(m.el, 'active', id === pointId);
      }),
      b.on('extraction:shipLanded', () => { this.shipLanded = true; }),
      // 2026-09-13: the ship left without us — back to plain (fog-gated) pad markers
      b.on('extraction:reset', () => {
        this.activeId = null;
        this.shipLanded = false;
        for (const m of this.markers.values()) toggleClass(m.el, 'active', false);
      }),
      b.on('game:abort', () => this.clear()),
    );
  }

  private add(id: string, pos: THREE.Vector3, label: string, cls: string): void {
    this.remove(id);
    const m = el('div', { cls, parent: this.root });
    el('i', { cls: 'ico', parent: m });
    el('span', { cls: 'lbl', text: label, parent: m });
    const dist = el('span', { cls: 'dist', text: '', parent: m });
    this.markers.set(id, { el: m, dist, pos, lastKey: '' });
  }
  private remove(id: string): void {
    const m = this.markers.get(id);
    if (m) { m.el.remove(); this.markers.delete(id); }
  }
  private clear(): void {
    for (const m of this.markers.values()) m.el.remove();
    this.markers.clear();
    this.activeId = null; this.shipLanded = false;
  }

  lateUpdate(ctx: GameContext): void {
    const cam = ctx.camera;
    const player = ctx.player;
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    const fog = ctx.world?.fog ?? null;
    for (const [id, m] of this.markers) {
      // The ship stands on the active pad: its diamond would float right over the ramp — hide it once landed.
      if (this.shipLanded && id === this.activeId) { this.hide(m); continue; }
      // The discovery gate (2026-09-09): a pad nobody has seen yet does not appear at all (the active pad is exempt)
      if (fog && id !== this.activeId && !fog.isDiscovered(m.pos)) { this.hide(m); continue; }
      this.v.copy(m.pos); this.v.y += 2.2;
      this.v.project(cam);
      const behind = this.v.z > 1 || this.v.z < -1;
      if (behind) { this.hide(m); continue; }
      const sx = (this.v.x * 0.5 + 0.5) * w;
      const sy = (-this.v.y * 0.5 + 0.5) * h;
      if (sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) { this.hide(m); continue; }
      const dist = player ? Math.hypot(m.pos.x - player.position.x, m.pos.z - player.position.z) : 0;
      let alpha = 1;
      if (dist < 12) alpha = Math.max(0.15, (dist - 4) / 8);
      if (dist > 400) alpha *= 0.6;
      const key = `${Math.round(sx)}|${Math.round(sy)}|${Math.round(dist)}|${alpha.toFixed(2)}`;
      if (key === m.lastKey) continue;
      m.lastKey = key;
      m.el.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -50%)`;
      m.el.style.opacity = alpha.toFixed(2);
      setText(m.dist, `${Math.round(dist)}m`);
    }
  }

  private hide(m: Marker): void {
    if (m.lastKey !== 'hidden') { m.lastKey = 'hidden'; m.el.style.opacity = '0'; }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
