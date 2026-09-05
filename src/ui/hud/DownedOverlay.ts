import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { DOWNED_BLEEDOUT, NET_SLOT_COLORS_CSS } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const MAX_MARKERS = 3;          // one per possible squadmate
const REVIVE_PROMPT_RANGE = 6;  // meters — below this the marker shows the defib hint

interface Marker { el: HTMLElement; name: HTMLElement; dist: HTMLElement; lastKey: string }

/**
 * Downed / revive UI (multiplayer).
 *
 * - Local player downed (`player:downed`): full-screen red overlay with the bleed-out countdown
 *   (`ctx.player.bleedoutRemaining`, falling back to a local timer) and the revive hint.
 * - Squadmates downed (`RemotePlayerRef.isDowned`): pooled world markers with name, distance and,
 *   within `REVIVE_PROMPT_RANGE`, a 제세동기 prompt.
 *
 * Lives in its own layer under `ctx.uiRoot` (never takes a UI blocker token, `pointer-events: none`).
 */
export class DownedOverlay {
  readonly root: HTMLElement;
  private panel: HTMLElement;
  private timeEl: HTMLElement;
  private barFill: HTMLElement;
  private markerRoot: HTMLElement;
  private markers: Marker[] = [];

  private downed = false;
  private bleedTotal = DOWNED_BLEEDOUT;
  private bleedLeft = 0;
  private lastKey = '';
  private v = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'downed-layer', parent });
    this.markerRoot = el('div', { cls: 'downed-markers', parent: this.root });
    for (let i = 0; i < MAX_MARKERS; i++) {
      const m = el('div', { cls: 'downed-marker', parent: this.markerRoot });
      m.hidden = true;
      el('i', { cls: 'ico', parent: m });
      const name = el('span', { cls: 'nm', text: '', parent: m });
      const dist = el('span', { cls: 'dist ui-mono', text: '', parent: m });
      el('span', { cls: 'hint', text: '제세동기로 부활', parent: m });
      this.markers.push({ el: m, name, dist, lastKey: '' });
    }
    this.panel = el('div', { cls: 'downed-panel', parent: this.root });
    this.panel.hidden = true;
    el('div', { cls: 'title', text: '전투 불능', parent: this.panel });
    el('div', { cls: 'sub', text: '분대원의 제세동기를 기다리십시오', parent: this.panel });
    const bar = el('div', { cls: 'bar', parent: this.panel });
    this.barFill = el('i', { parent: bar });
    this.timeEl = el('div', { cls: 'time ui-mono', text: '', parent: this.panel });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('player:downed', ({ bleedout }) => {
        this.downed = true;
        this.bleedTotal = bleedout > 0 ? bleedout : DOWNED_BLEEDOUT;
        this.bleedLeft = this.bleedTotal;
        this.panel.hidden = false;
        toggleClass(this.root, 'active', true);
      }),
      b.on('player:revived', () => this.hidePanel()),
      b.on('player:died', () => this.hidePanel()),
      b.on('player:spawned', () => this.hidePanel()),
      b.on('game:abort', () => this.hideAll()),
      b.on('game:newMission', () => this.hideAll()),
    );
  }

  private hidePanel(): void {
    this.downed = false;
    this.bleedLeft = 0;
    if (!this.panel.hidden) this.panel.hidden = true;
    toggleClass(this.root, 'active', false);
  }

  private hideAll(): void {
    this.hidePanel();
    for (const m of this.markers) { if (!m.el.hidden) { m.el.hidden = true; m.lastKey = ''; } }
  }

  update(dt: number, ctx: GameContext): void {
    const p = ctx.player;
    const isDowned = p?.isDowned ?? this.downed;
    if (!isDowned && this.downed) { this.hidePanel(); return; }
    if (!isDowned) return;
    if (!this.downed) {
      // Downed without seeing the event (rejoin): adopt the player's own timer.
      this.downed = true;
      this.bleedTotal = DOWNED_BLEEDOUT;
      this.panel.hidden = false;
      toggleClass(this.root, 'active', true);
    }
    const remaining = p?.bleedoutRemaining;
    this.bleedLeft = typeof remaining === 'number' && remaining > 0 ? remaining : Math.max(0, this.bleedLeft - dt);
    const frac = this.bleedTotal > 0 ? Math.min(1, Math.max(0, this.bleedLeft / this.bleedTotal)) : 0;
    const key = `${frac.toFixed(3)}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.barFill.style.transform = `scaleX(${frac.toFixed(3)})`;
      setText(this.timeEl, `${Math.ceil(this.bleedLeft)}초`);
      toggleClass(this.panel, 'critical', frac < 0.3);
    }
  }

  lateUpdate(ctx: GameContext): void {
    const net = ctx.net;
    const remotes = net?.getRemotePlayers?.();
    let used = 0;
    if (remotes && ctx.isGameplayPhase() && !ctx.uiBlockers.has('menu')) {
      const cam = ctx.camera;
      const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
      const from = ctx.player?.position;
      for (const r of remotes) {
        if (used >= MAX_MARKERS) break;
        if (!r.isDowned || !r.connected || r.isDead) continue;
        this.v.copy(r.position); this.v.y += 1.1;
        this.v.project(cam);
        if (this.v.z > 1) continue;
        const sx = (this.v.x * 0.5 + 0.5) * w;
        const sy = (-this.v.y * 0.5 + 0.5) * h;
        if (sx < -60 || sx > w + 60 || sy < -60 || sy > h + 60) continue;
        const dist = from ? Math.hypot(r.position.x - from.x, r.position.z - from.z) : 0;
        const m = this.markers[used++];
        const key = `${sx.toFixed(0)}|${sy.toFixed(0)}|${Math.round(dist)}|${r.name}`;
        if (m.el.hidden) m.el.hidden = false;
        if (key !== m.lastKey) {
          m.lastKey = key;
          m.el.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -50%)`;
          m.el.style.setProperty('--sc', NET_SLOT_COLORS_CSS[r.slot] ?? '#ffffff');
          setText(m.name, r.name);
          setText(m.dist, `${Math.round(dist)}m`);
          toggleClass(m.el, 'near', dist <= REVIVE_PROMPT_RANGE);
        }
      }
    }
    for (let i = used; i < this.markers.length; i++) {
      const m = this.markers[i];
      if (!m.el.hidden) { m.el.hidden = true; m.lastKey = ''; }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
