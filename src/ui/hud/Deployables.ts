import * as THREE from 'three';
import type { GameContext, DeployableKind } from '@/shared';
import { GADGET_MINE_RADIUS } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const MAX_MARKERS = 12;
const MAX_RINGS = 6;            // pooled danger rings (mines)
const POLL_INTERVAL = 0.2;
const MINE_MARKER_RANGE = 140;  // mines are shown to everyone from far away
const OTHER_MARKER_RANGE = 55;

export const DEPLOYABLE_LABEL_KO: Record<DeployableKind, string> = {
  domeShield: '돔 실드', barricade: '바리케이드', mine: '지뢰', turret: '포탑',
  jumpPad: '점프대', smoke: '연막', fire: '화염 지대', lure: '유인 장치',
};
const DEPLOYABLE_ICON: Record<DeployableKind, string> = {
  domeShield: '◐', barricade: '▤', mine: '✸', turret: '⌖',
  jumpPad: '⌃', smoke: '☁', fire: '▲', lure: '♪',
};

interface Entry {
  id: string;
  kind: DeployableKind;
  position: THREE.Vector3;
  radius: number;
  armed: boolean;
}
interface Marker { el: HTMLElement; ico: HTMLElement; lbl: HTMLElement; dist: HTMLElement; lastKey: string }

/**
 * Deployed-gadget indicators. Mines are shown to **everyone** (friendly fire) with a red screen marker and a
 * pulsing blast-radius ring in the world; other deployables (turret, barricade, dome, jump pad, zones) get a
 * quieter marker inside `OTHER_MARKER_RANGE`.
 *
 * Truth comes from `ctx.gadgets.getDeployables()` when the gadget system is registered; until then the list is
 * kept from `gadget:deployed` / `gadget:removed`. Markers and rings are pooled — nothing is allocated per frame.
 */
export class Deployables {
  readonly root: HTMLElement;
  private ctx!: GameContext;
  private markers: Marker[] = [];
  private entries: Entry[] = [];
  private fallback = new Map<string, Entry>();
  private rings: THREE.Mesh[] = [];
  private ringGroup: THREE.Group | null = null;
  private ringGeo: THREE.BufferGeometry | null = null;
  private ringMat: THREE.MeshBasicMaterial | null = null;
  private ringMatArming: THREE.MeshBasicMaterial | null = null;
  private poll = 0;
  private v = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'deployables', parent });
    for (let i = 0; i < MAX_MARKERS; i++) {
      const m = el('div', { cls: 'dmarker', parent: this.root });
      m.hidden = true;
      const ico = el('i', { cls: 'ico', text: '', parent: m });
      const lbl = el('span', { cls: 'lbl', text: '', parent: m });
      const dist = el('span', { cls: 'dist ui-mono', text: '', parent: m });
      this.markers.push({ el: m, ico, lbl, dist, lastKey: '' });
    }
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('gadget:deployed', ({ id, kind, position }) => {
        this.fallback.set(id, {
          id, kind, position: position.clone(),
          radius: kind === 'mine' ? GADGET_MINE_RADIUS : 2,
          armed: kind !== 'mine',
        });
      }),
      b.on('gadget:removed', ({ id }) => { this.fallback.delete(id); }),
      b.on('game:abort', () => this.teardown()),
      b.on('game:newMission', () => this.teardown()),
    );
  }

  private teardown(): void {
    this.fallback.clear();
    this.entries.length = 0;
    for (const m of this.markers) { if (!m.el.hidden) { m.el.hidden = true; m.lastKey = ''; } }
    if (this.ringGroup) {
      this.ctx.scene.remove(this.ringGroup);
      this.ringGroup.clear();
      this.ringGroup = null;
    }
    this.rings.length = 0;
    this.ringGeo?.dispose(); this.ringGeo = null;
    this.ringMat?.dispose(); this.ringMat = null;
    this.ringMatArming?.dispose(); this.ringMatArming = null;
  }

  private ensureRings(): void {
    if (this.ringGroup) return;
    const g = new THREE.RingGeometry(0.92, 1, 48);
    g.rotateX(-Math.PI / 2);
    this.ringGeo = g;
    const mk = (color: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.55, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    this.ringMat = mk(0xff4d4d);
    this.ringMatArming = mk(0xffb347);
    this.ringGroup = new THREE.Group();
    this.ringGroup.name = 'mine-rings';
    for (let i = 0; i < MAX_RINGS; i++) {
      const m = new THREE.Mesh(g, this.ringMat);
      m.visible = false;
      m.frustumCulled = false;
      this.ringGroup.add(m);
      this.rings.push(m);
    }
    this.ctx.scene.add(this.ringGroup);
  }

  update(dt: number, ctx: GameContext): void {
    this.poll -= dt;
    if (this.poll > 0) return;
    this.poll = POLL_INTERVAL;
    this.entries.length = 0;
    const list = ctx.gadgets?.getDeployables?.();
    if (list && list.length) {
      for (const d of list) {
        this.entries.push({ id: d.id, kind: d.kind, position: d.position, radius: d.radius, armed: d.armed });
      }
    } else {
      for (const e of this.fallback.values()) this.entries.push(e);
    }
  }

  lateUpdate(ctx: GameContext): void {
    const active = ctx.isGameplayPhase() && !ctx.uiBlockers.has('menu') && !ctx.uiBlockers.has('map');
    if (!active || this.entries.length === 0) {
      for (const m of this.markers) { if (!m.el.hidden) { m.el.hidden = true; m.lastKey = ''; } }
      for (const r of this.rings) r.visible = false;
      return;
    }
    const cam = ctx.camera;
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    const from = ctx.player?.position;
    let used = 0;
    let ringUsed = 0;
    const t = ctx.time;
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.4);

    for (const e of this.entries) {
      const isMine = e.kind === 'mine';
      const dist = from ? Math.hypot(e.position.x - from.x, e.position.z - from.z) : 0;
      const range = isMine ? MINE_MARKER_RANGE : OTHER_MARKER_RANGE;
      if (dist > range) continue;

      if (isMine && ringUsed < MAX_RINGS) {
        this.ensureRings();
        const ring = this.rings[ringUsed++];
        const r = (e.radius > 0 ? e.radius : GADGET_MINE_RADIUS) * (0.94 + 0.06 * pulse);
        ring.position.set(e.position.x, e.position.y + 0.08, e.position.z);
        ring.scale.set(r, 1, r);
        const mat = e.armed ? this.ringMat : this.ringMatArming;
        if (mat) {
          if (ring.material !== mat) ring.material = mat;
          mat.opacity = e.armed ? 0.35 + 0.3 * pulse : 0.25 + 0.5 * pulse;
        }
        if (!ring.visible) ring.visible = true;
      }

      if (used >= MAX_MARKERS) continue;
      this.v.copy(e.position); this.v.y += 0.9;
      this.v.project(cam);
      if (this.v.z > 1) continue;
      const sx = (this.v.x * 0.5 + 0.5) * w;
      const sy = (-this.v.y * 0.5 + 0.5) * h;
      if (sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) continue;
      const m = this.markers[used++];
      const key = `${sx.toFixed(0)}|${sy.toFixed(0)}|${Math.round(dist)}|${e.kind}|${e.armed ? 1 : 0}`;
      if (m.el.hidden) m.el.hidden = false;
      if (key === m.lastKey) continue;
      m.lastKey = key;
      m.el.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -50%)`;
      setText(m.ico, DEPLOYABLE_ICON[e.kind] ?? '◆');
      setText(m.lbl, e.armed ? (DEPLOYABLE_LABEL_KO[e.kind] ?? '설치물') : `${DEPLOYABLE_LABEL_KO[e.kind] ?? '설치물'} (작동 준비)`);
      setText(m.dist, `${Math.round(dist)}m`);
      toggleClass(m.el, 'mine', isMine);
      toggleClass(m.el, 'arming', !e.armed);
    }

    for (let i = used; i < this.markers.length; i++) {
      const m = this.markers[i];
      if (!m.el.hidden) { m.el.hidden = true; m.lastKey = ''; }
    }
    for (let i = ringUsed; i < this.rings.length; i++) this.rings[i].visible = false;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.teardown();
    this.root.remove();
  }
}
