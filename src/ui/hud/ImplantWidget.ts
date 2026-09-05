import type { GameContext, ImplantDef, ImplantId } from '@/shared';
import { KEY_IMPLANT } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_R = 20;
const RING_CIRC = 2 * Math.PI * RING_R;
const MAX_CHARGE_DOTS = 6;
/** Q is the implant key; show just the letter. */
const KEY_LABEL = KEY_IMPLANT.replace('Key', '');

/**
 * Bottom-center tactical implant readout: glyph + radial cooldown ring + charge pips + barrier durability bar.
 *
 * Data comes from the `implant:*` events and, for smooth per-frame cooldowns, from `ctx.implants` (optional —
 * the whole widget stays hidden while no implant is equipped or the implant system is not registered yet).
 */
export class ImplantWidget {
  readonly root: HTMLElement;
  private ico: HTMLElement;
  private nameEl: HTMLElement;
  private cdText: HTMLElement;
  private ring: SVGCircleElement;
  private chargeRow: HTMLElement;
  private chargeDots: HTMLElement[] = [];
  private barrier: HTMLElement;
  private barrierFill: HTMLElement;
  private barrierText: HTMLElement;

  private ctx!: GameContext;
  private equipped: ImplantId | null = null;
  private def: ImplantDef | null = null;
  private remaining = 0;
  private total = 0;
  private charges = 1;
  private maxCharges = 1;
  private wielded = false;
  private barrierHp = 0;
  private barrierMax = 0;
  private barrierActive = false;
  private lastKey = '';
  private lastBarrierKey = '';
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'implant', parent });
    this.root.hidden = true;

    const dial = el('div', { cls: 'dial', parent: this.root });
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('class', 'track');
    track.setAttribute('cx', '24'); track.setAttribute('cy', '24'); track.setAttribute('r', String(RING_R));
    this.ring = document.createElementNS(SVG_NS, 'circle');
    this.ring.setAttribute('class', 'prog');
    this.ring.setAttribute('cx', '24'); this.ring.setAttribute('cy', '24'); this.ring.setAttribute('r', String(RING_R));
    this.ring.style.strokeDasharray = `${RING_CIRC}`;
    this.ring.style.strokeDashoffset = '0';
    svg.appendChild(track); svg.appendChild(this.ring);
    dial.appendChild(svg);
    this.ico = el('span', { cls: 'ico', text: '◈', parent: dial });
    this.cdText = el('span', { cls: 'cd ui-mono', text: '', parent: dial });

    const info = el('div', { cls: 'info', parent: this.root });
    const head = el('div', { cls: 'head', parent: info });
    el('span', { cls: 'keycap', text: KEY_LABEL, parent: head });
    this.nameEl = el('span', { cls: 'name', text: '—', parent: head });
    this.chargeRow = el('div', { cls: 'charges', parent: info });
    for (let i = 0; i < MAX_CHARGE_DOTS; i++) {
      const d = el('i', { parent: this.chargeRow });
      d.hidden = true;
      this.chargeDots.push(d);
    }
    this.barrier = el('div', { cls: 'barrier', parent: info });
    this.barrier.hidden = true;
    const bar = el('div', { cls: 'bar', parent: this.barrier });
    this.barrierFill = el('i', { parent: bar });
    this.barrierText = el('span', { cls: 'val ui-mono', text: '', parent: this.barrier });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('implant:equipped', ({ id }) => this.setEquipped(id)),
      b.on('implant:cooldownChanged', ({ id, remaining, total, charges, maxCharges }) => {
        if (this.equipped === null) this.setEquipped(id);
        this.remaining = remaining; this.total = total;
        this.charges = charges; this.maxCharges = maxCharges;
      }),
      b.on('implant:wieldChanged', ({ wielded }) => {
        this.wielded = wielded;
        toggleClass(this.root, 'wielded', wielded);
      }),
      b.on('implant:activated', () => {
        this.root.classList.remove('pulse');
        void this.root.offsetWidth;
        this.root.classList.add('pulse');
      }),
      b.on('implant:barrierChanged', ({ hp, maxHp, active }) => {
        this.barrierHp = hp; this.barrierMax = maxHp; this.barrierActive = active;
      }),
      b.on('implant:barrierHit', () => {
        this.barrier.classList.remove('hit');
        void this.barrier.offsetWidth;
        this.barrier.classList.add('hit');
      }),
      b.on('game:newMission', () => this.resetTransient()),
      b.on('game:abort', () => this.resetTransient()),
    );
  }

  private resetTransient(): void {
    this.wielded = false;
    toggleClass(this.root, 'wielded', false);
    this.barrierHp = 0; this.barrierMax = 0; this.barrierActive = false;
  }

  private setEquipped(id: ImplantId | null): void {
    this.equipped = id;
    this.def = id ? (this.ctx.implants?.getDef(id) ?? null) : null;
    if (!id) { this.root.hidden = true; return; }
    setText(this.ico, this.def?.icon ?? '◈');
    setText(this.nameEl, this.def?.name ?? '임플란트');
    this.root.style.setProperty('--ic', this.def?.color ?? 'var(--c-info)');
    this.root.hidden = false;
  }

  update(_dt: number, ctx: GameContext): void {
    const imp = ctx.implants;
    // Late registration: pick the equipped implant up as soon as the system exists.
    if (imp && imp.equipped !== this.equipped) this.setEquipped(imp.equipped);
    if (this.equipped === null) { if (!this.root.hidden) this.root.hidden = true; return; }
    if (!this.def && imp) this.def = imp.getDef(this.equipped) ?? null;

    if (imp) {
      this.remaining = imp.cooldownRemaining;
      this.total = imp.cooldownTotal;
      this.charges = imp.charges;
      this.maxCharges = imp.maxCharges;
      this.barrierHp = imp.barrierHp;
      this.barrierMax = imp.barrierMaxHp;
      this.barrierActive = imp.barrierActive;
      if (imp.wielded !== this.wielded) {
        this.wielded = imp.wielded;
        toggleClass(this.root, 'wielded', this.wielded);
      }
    }

    const frac = this.total > 0 ? Math.min(1, Math.max(0, this.remaining / this.total)) : 0;
    const ready = this.charges > 0 && this.remaining <= 0.001;
    const key = `${frac.toFixed(3)}|${this.charges}|${this.maxCharges}|${ready ? 1 : 0}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.ring.style.strokeDashoffset = `${(RING_CIRC * (1 - frac)).toFixed(1)}`;
      setText(this.cdText, this.remaining > 0.05 ? this.remaining.toFixed(this.remaining < 10 ? 1 : 0) : '');
      toggleClass(this.root, 'ready', ready);
      toggleClass(this.root, 'cooling', !ready);
      const show = this.maxCharges > 1;
      this.chargeRow.hidden = !show;
      if (show) {
        const n = Math.min(MAX_CHARGE_DOTS, this.maxCharges);
        for (let i = 0; i < MAX_CHARGE_DOTS; i++) {
          const dot = this.chargeDots[i];
          dot.hidden = i >= n;
          toggleClass(dot, 'on', i < this.charges);
        }
      }
    }

    const showBarrier = this.barrierMax > 0;
    if (showBarrier) {
      const r = Math.min(1, Math.max(0, this.barrierHp / this.barrierMax));
      const bkey = `${r.toFixed(3)}|${this.barrierActive ? 1 : 0}`;
      if (bkey !== this.lastBarrierKey) {
        this.lastBarrierKey = bkey;
        this.barrierFill.style.transform = `scaleX(${r.toFixed(3)})`;
        setText(this.barrierText, `${Math.round(this.barrierHp)}`);
        toggleClass(this.barrier, 'active', this.barrierActive);
        toggleClass(this.barrier, 'low', r < 0.25);
      }
    }
    if (this.barrier.hidden === showBarrier) this.barrier.hidden = !showBarrier;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
