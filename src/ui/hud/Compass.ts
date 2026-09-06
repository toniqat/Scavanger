import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const STRIP_WIDTH = 440;
const PX_PER_RAD = STRIP_WIDTH / (Math.PI * 0.9); // ~160° visible
const CARDINALS: Array<[number, string, boolean]> = [
  [0, 'N', true], [45, 'NE', false], [90, 'E', true], [135, 'SE', false],
  [180, 'S', true], [225, 'SW', false], [270, 'W', true], [315, 'NW', false],
];

interface CompassMarker {
  el: HTMLElement;
  dist: HTMLElement;
  pos: THREE.Vector3;
  lastX: number;
  lastDist: number;
}

/** Top-center heading strip with extraction / ship markers. */
export class Compass {
  readonly root: HTMLElement;
  private strip: HTMLElement;
  private markers = new Map<string, CompassMarker>();
  private activeId: string | null = null;
  private shipPos: THREE.Vector3 | null = null;
  private lastYaw = NaN;
  private tmp = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'compass', parent });
    this.strip = el('div', { cls: 'strip', parent: this.root });
    // Build 3 copies (−360°, 0°, +360°) so the strip wraps seamlessly.
    for (let rep = -1; rep <= 1; rep++) {
      for (let deg = 0; deg < 360; deg += 15) {
        const x = THREE.MathUtils.degToRad(deg + rep * 360) * PX_PER_RAD;
        const major = deg % 45 === 0;
        const t = el('div', { cls: major ? 'tick major' : 'tick', parent: this.strip });
        t.style.left = `${x.toFixed(1)}px`;
      }
      for (const [deg, label, major] of CARDINALS) {
        const x = THREE.MathUtils.degToRad(deg + rep * 360) * PX_PER_RAD;
        const c = el('div', { cls: major ? 'card' : 'card minor', text: label, parent: this.strip });
        c.style.left = `${x.toFixed(1)}px`;
      }
    }
    el('div', { cls: 'center', parent: this.root });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('world:ready', () => this.rebuild(ctx)),
      b.on('extraction:activated', ({ pointId }) => { this.activeId = pointId; this.refreshActive(); }),
      b.on('extraction:shipIncoming', ({ position }) => this.setShip(position)),
      b.on('extraction:shipLanded', ({ position }) => this.setShip(position)),
      b.on('extraction:liftoff', () => this.removeShip()),
      // world:ready fires synchronously inside game:newMission (before our handler would) → rebuild there only.
      b.on('game:abort', () => this.clear()),
    );
  }

  private rebuild(ctx: GameContext): void {
    this.clear();
    // Training arena (Phase 7): no extraction, so no markers even if a world reported pads.
    if (ctx.missionMode === 'training' || ctx.world?.mode === 'training') return;
    const pts = ctx.world?.getExtractionPoints() ?? [];
    for (const p of pts) this.addMarker(p.id, p.position, 'marker');
  }

  private setShip(position: THREE.Vector3): void {
    if (!this.shipPos) {
      this.shipPos = position.clone();
      this.addMarker('__ship', this.shipPos, 'marker ship');
    } else this.shipPos.copy(position);
  }
  private removeShip(): void {
    const m = this.markers.get('__ship');
    if (m) { m.el.remove(); this.markers.delete('__ship'); }
    this.shipPos = null;
  }

  private addMarker(id: string, pos: THREE.Vector3, cls: string): void {
    const m = el('div', { cls, parent: this.root });
    el('i', { cls: 'ico', parent: m });
    const dist = el('span', { cls: 'dist', text: '', parent: m });
    this.markers.set(id, { el: m, dist, pos, lastX: NaN, lastDist: -1 });
  }

  private refreshActive(): void {
    for (const [id, m] of this.markers) toggleClass(m.el, 'active', id === this.activeId);
  }

  private clear(): void {
    for (const m of this.markers.values()) m.el.remove();
    this.markers.clear();
    this.activeId = null;
    this.shipPos = null;
  }

  update(ctx: GameContext): void {
    const player = ctx.player;
    if (!player) return;
    const yaw = player.yaw;
    // Heading: yaw 0 = looking toward -Z (north). Strip scrolls opposite to heading.
    const heading = this.headingFromYaw(ctx);
    if (heading !== this.lastYaw) {
      this.lastYaw = heading;
      this.strip.style.transform = `translateX(${(-heading * PX_PER_RAD).toFixed(1)}px)`;
    }
    const half = STRIP_WIDTH / 2 - 14;
    for (const m of this.markers.values()) {
      this.tmp.subVectors(m.pos, player.position);
      const dist = Math.hypot(this.tmp.x, this.tmp.z);
      const bearing = Math.atan2(this.tmp.x, -this.tmp.z); // 0 = north
      let rel = bearing - heading;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      let x = rel * PX_PER_RAD;
      const clamped = Math.abs(x) > half;
      if (clamped) x = Math.sign(x) * half;
      if (Math.abs(x - m.lastX) > 0.3 || Number.isNaN(m.lastX)) {
        m.lastX = x;
        m.el.style.transform = `translateX(calc(-50% + ${x.toFixed(1)}px))`;
      }
      toggleClass(m.el, 'clamped', clamped);
      const d = Math.round(dist);
      if (d !== m.lastDist) { m.lastDist = d; setText(m.dist, `${d}m`); }
    }
    void yaw;
  }

  /** Heading in radians where 0 = north (−Z), increasing clockwise (toward +X). */
  private headingFromYaw(ctx: GameContext): number {
    const f = ctx.player!.getForward(this.tmp);
    return Math.atan2(f.x, -f.z);
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
