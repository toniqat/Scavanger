import * as THREE from 'three';
import {
  DRONE_SCAN_LABEL_HEIGHT, DRONE_SCAN_LABEL_MAX_DIST, RARITY_COLORS, RARITY_LABEL_KO,
  type DroneScanResult, type GameContext,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';

interface Label {
  res: DroneScanResult;
  root: HTMLElement;
  rarity: HTMLElement;
  name: HTMLElement;
  lastKey: string;
}

const EMPTY: readonly DroneScanResult[] = [];
/** How long the one pop of a new · updated result lasts — the same as `dslPop` in `styles/drone.css`. */
const POP_MS = 600;
/** It starts dimming from this share of the max distance. */
const FADE_FROM = 0.75;

const _cam = new THREE.Vector3();

/**
 * **World labels for drone scan results** (2026-09-12). The only data is `ctx.drones.getScanResults()` — one's own scans
 * and squadmates' sit in the same list, and `gadgets/drones` empties it on a raid reset (`game:newMission/abort` ·
 * `hub:entered` · `world:ready`).
 *
 *  - The target's spot (a live vector — it follows a container on the tram · a corpse too) + `DRONE_SCAN_LABEL_HEIGHT` is
 *    projected in **`lateUpdate`** (CLAUDE.md: screen projection happens in `HudSystem.lateUpdate`). Behind the camera ·
 *    off screen · beyond `DRONE_SCAN_LABEL_MAX_DIST` hides.
 *  - A label = a rarity-coloured diamond + `서사` (a grey `비어 있음` when empty) + the target's small name below. There
 *    is no occlusion test (the same as the extraction `신호소` marker).
 *  - The DOM is reconciled only when the list array changes (`DroneSystem.scanList` is a new array only on a change), and
 *    position · opacity are written only when the rounded key changes.
 *
 * The root is prepended at the **bottom** of the gameplay layer — it never covers HUD text. CSS prefix `.dsl-`.
 */
export class DroneScanLabels {
  readonly root: HTMLElement;
  private readonly labels = new Map<string, Label>();
  private lastList: readonly DroneScanResult[] = EMPTY;
  private readonly v = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'dsl-root' });
    parent.prepend(this.root);
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', () => this.clear()),
      b.on('game:abort', () => this.clear()),
      b.on('hub:entered', () => this.clear()),
    );
  }

  /** `HudSystem.lateUpdate` (after the camera matrix update). */
  lateUpdate(ctx: GameContext): void {
    const list = ctx.drones?.getScanResults?.() ?? EMPTY;
    if (list !== this.lastList) this.sync(list);
    if (this.labels.size === 0) return;
    const cam = ctx.camera;
    _cam.setFromMatrixPosition(cam.matrixWorld);
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    const maxD = Math.max(1, DRONE_SCAN_LABEL_MAX_DIST);
    for (const l of this.labels.values()) {
      const p = l.res.position;
      this.v.set(p.x, p.y + DRONE_SCAN_LABEL_HEIGHT, p.z);
      const dist = this.v.distanceTo(_cam);
      if (dist > maxD) { this.hide(l); continue; }
      this.v.project(cam);
      if (this.v.z > 1 || this.v.z < -1) { this.hide(l); continue; }
      const sx = (this.v.x * 0.5 + 0.5) * w;
      const sy = (-this.v.y * 0.5 + 0.5) * h;
      if (sx < -80 || sx > w + 80 || sy < -40 || sy > h + 40) { this.hide(l); continue; }
      const fade = dist > maxD * FADE_FROM ? Math.max(0, 1 - (dist - maxD * FADE_FROM) / (maxD * (1 - FADE_FROM))) : 1;
      const key = `${Math.round(sx)}|${Math.round(sy)}|${fade.toFixed(2)}`;
      if (key === l.lastKey) continue;
      l.lastKey = key;
      l.root.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -100%)`;
      l.root.style.opacity = fade.toFixed(2);
    }
  }

  private sync(list: readonly DroneScanResult[]): void {
    this.lastList = list;
    const seen = new Set<string>();
    for (const r of list) {
      seen.add(r.id);
      const l = this.labels.get(r.id);
      if (!l) this.create(r);
      else if (l.res !== r) this.fill(l, r, true);
    }
    for (const [id, l] of this.labels) {
      if (seen.has(id)) continue;
      l.root.remove();
      this.labels.delete(id);
    }
  }

  private create(r: DroneScanResult): void {
    const root = el('div', { cls: 'dsl-label', parent: this.root });
    const rarity = el('span', { cls: 'r', parent: root });
    const name = el('span', { cls: 'n', parent: root });
    const l: Label = { res: r, root, rarity, name, lastKey: '' };
    root.style.opacity = '0';
    this.labels.set(r.id, l);
    this.fill(l, r, true);
  }

  private fill(l: Label, r: DroneScanResult, pop: boolean): void {
    l.res = r;
    l.root.dataset.target = r.id;
    l.root.dataset.rarity = r.rarity ?? 'empty';
    toggleClass(l.root, 'empty', r.rarity === null);
    toggleClass(l.root, 'remote', !r.local);
    l.root.style.setProperty('--rc', r.rarity ? RARITY_COLORS[r.rarity] : RARITY_COLORS.common);
    setText(l.rarity, r.rarity ? RARITY_LABEL_KO[r.rarity] : '비어 있음');
    setText(l.name, r.local ? r.name : `${r.name} · ${r.byName}`);
    l.lastKey = '';
    if (!pop) return;
    l.root.classList.remove('pop');
    void l.root.offsetWidth; // restart the animation
    l.root.classList.add('pop');
    window.setTimeout(() => l.root.classList.remove('pop'), POP_MS);
  }

  private hide(l: Label): void {
    if (l.lastKey !== 'hidden') { l.lastKey = 'hidden'; l.root.style.opacity = '0'; }
  }

  private clear(): void {
    for (const l of this.labels.values()) l.root.remove();
    this.labels.clear();
    this.lastList = EMPTY;
  }

  /* ── debug / smoke ── */
  /** How many labels exist (visible or hidden). */
  get count(): number { return this.labels.size; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.clear();
    this.root.remove();
  }
}
