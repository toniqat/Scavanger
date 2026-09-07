import * as THREE from 'three';
import type { GameContext, StratagemId } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { STRATAGEM_COLOR, STRATAGEM_GLYPH, stratagemDef, stratagemTargetHint } from './stratagemGlyphs';

/**
 * Ship-call targeting frame (`.targeting-hud`): shown on `stratagem:targeting {active:true}` — the HUD root gets
 * `.targeting` (CSS hides the reticle) and a centre frame with four corner brackets (`.corner`), the call glyph + name
 * (tinted), `좌클 확정 · 우클 취소` (topview) / `좌클 투하 · 우클 취소` (ground) and a distance readout from the last
 * `position` to `ctx.player.position` (refreshed each update; `position` is also polled from the event payload the
 * stratagems system re-emits while active). Removed on `active:false`, death, reset. `pointer-events:none`.
 */
export class TargetingHud {
  readonly root: HTMLElement;
  private ico: HTMLElement;
  private nameEl: HTMLElement;
  private hintEl: HTMLElement;
  private distEl: HTMLElement;
  private active = false;
  private kind: StratagemId | null = null;
  private pos = new THREE.Vector3();
  private hasPos = false;
  private lastDist = '';
  private onToggle: (active: boolean) => void;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement, onToggle: (active: boolean) => void) {
    this.onToggle = onToggle;
    this.root = el('div', { cls: 'targeting-hud', parent });
    const frame = el('div', { cls: 'frame', parent: this.root });
    for (const c of ['tl', 'tr', 'bl', 'br']) el('i', { cls: `corner ${c}`, parent: frame });
    const head = el('div', { cls: 'head', parent: this.root });
    this.ico = el('span', { cls: 'ico', text: '', parent: head });
    this.nameEl = el('span', { cls: 'nm', text: '', parent: head });
    this.distEl = el('div', { cls: 'dist ui-mono', text: '', parent: this.root });
    this.hintEl = el('div', { cls: 'hint', text: '', parent: this.root });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('stratagem:targeting', ({ active, kind, position }) => {
        if (position) { this.pos.copy(position); this.hasPos = true; } else if (!active) this.hasPos = false;
        if (kind) this.kind = kind;
        if (active !== this.active) {
          this.active = active;
          toggleClass(this.root, 'show', active);
          this.onToggle(active);
        }
        if (active) this.render();
        else this.kind = null;
      }),
      b.on('stratagem:armed', ({ id }) => { if (!id) this.set(false); }),
      b.on('player:died', () => this.set(false)),
      b.on('player:downed', () => this.set(false)),
      b.on('game:newMission', () => this.set(false)),
      b.on('game:abort', () => this.set(false)),
    );
  }

  get isActive(): boolean { return this.active; }

  private set(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) { this.kind = null; this.hasPos = false; }
    toggleClass(this.root, 'show', active);
    this.onToggle(active);
  }

  private render(): void {
    const def = stratagemDef(this.kind);
    setText(this.ico, def ? STRATAGEM_GLYPH[def.id] : '');
    this.root.style.setProperty('--sc', def ? STRATAGEM_COLOR[def.id] : 'var(--c-accent)');
    setText(this.nameEl, def ? `${def.name} — 위치 지정` : '위치 지정');
    setText(this.hintEl, def ? stratagemTargetHint(def) : '좌클 확정 · 우클 취소');
    toggleClass(this.root, 'topview', def?.targeting === 'topview');
  }

  update(ctx: GameContext): void {
    if (!this.active) return;
    const p = ctx.player;
    let txt = '';
    if (p && this.hasPos) {
      const d = Math.hypot(this.pos.x - p.position.x, this.pos.z - p.position.z);
      txt = `${Math.round(d)} m`;
    }
    if (txt !== this.lastDist) { this.lastDist = txt; setText(this.distEl, txt); }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
