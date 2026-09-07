import type { GameContext, ImplantDef, ImplantId } from '@/shared';
import { IMPLANT_DASH_CHARGES, Keys, keyLabel, onKeybindsChanged } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/** Segments the dash gauge is split into (one per charge). */
const MAX_SEGMENTS = Math.max(3, IMPLANT_DASH_CHARGES);

/**
 * Tactical implant gauge **left of the crosshair**: a rounded vertical bar that shows what the equipped implant
 * is waiting on, with the number (cooldown seconds / charge %) to its left and the implant glyph + key below.
 *
 *   - single-charge cooldown implants (갈고리 / 정찰 / 대전차포): the bar fills up while the cooldown runs and is full
 *     when ready; the text counts the seconds down.
 *   - 대시: the bar is split into three segments, one per charge; each refilling segment fills on its own and a
 *     ready charge turns **yellow**.
 *   - 배리어: the bar is the shield durability. After a collapse it refills from 0 over the 10 s lockout, which is
 *     the cooldown readout; the text shows the lockout seconds, else the hp %.
 *   - 오버차지: the bar is the energy pool (drains while Q is held, refills while released); the text shows the %.
 *
 * Data comes from the `implant:*` events and, for smooth per-frame values, from `ctx.implants` (optional — the
 * widget stays hidden while no implant is equipped or the implant system is not registered yet).
 */
export class ImplantWidget {
  readonly root: HTMLElement;
  private readEl: HTMLElement;
  private gauge: HTMLElement;
  private segs: HTMLElement[] = [];
  private segFills: HTMLElement[] = [];
  private ico: HTMLElement;
  private keyEl: HTMLElement;

  private ctx!: GameContext;
  private equipped: ImplantId | null = null;
  private def: ImplantDef | null = null;
  private remaining = 0;
  private total = 0;
  private charges = 1;
  private maxCharges = 1;
  private wielded = false;
  private holding = false;
  private barrierHp = 0;
  private barrierMax = 0;
  private barrierActive = false;
  private barrierLockout = 0;
  private energy = 0;
  private energyMax = 0;
  private lastKey = '';
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'implant-gauge', parent });
    this.root.hidden = true;
    this.readEl = el('div', { cls: 'read ui-mono', text: '', parent: this.root });
    const col = el('div', { cls: 'col', parent: this.root });
    this.gauge = el('div', { cls: 'gauge', parent: col });
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      // segments stack bottom-up: the first charge is the lowest one
      const seg = el('div', { cls: 'seg', parent: this.gauge });
      const fill = el('i', { parent: seg });
      this.segs.unshift(seg);
      this.segFills.unshift(fill);
    }
    const foot = el('div', { cls: 'foot', parent: col });
    this.ico = el('span', { cls: 'ico', text: '◈', parent: foot });
    this.keyEl = el('span', { cls: 'keycap', text: keyLabel(Keys.IMPLANT), parent: foot });
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
      b.on('implant:wieldChanged', ({ wielded }) => { this.wielded = wielded; toggleClass(this.root, 'wielded', wielded); }),
      b.on('implant:activated', () => {
        this.root.classList.remove('pulse');
        void this.root.offsetWidth;
        this.root.classList.add('pulse');
      }),
      b.on('implant:barrierChanged', ({ hp, maxHp, active }) => { this.barrierHp = hp; this.barrierMax = maxHp; this.barrierActive = active; }),
      b.on('implant:barrierHit', () => {
        this.gauge.classList.remove('hit');
        void this.gauge.offsetWidth;
        this.gauge.classList.add('hit');
      }),
      b.on('implant:energyChanged', ({ energy, max }) => { this.energy = energy; this.energyMax = max; }),
      b.on('game:newMission', () => this.resetTransient()),
      b.on('game:abort', () => this.resetTransient()),
      b.on('input:bindingsChanged', () => setText(this.keyEl, keyLabel(Keys.IMPLANT))),
      onKeybindsChanged(() => setText(this.keyEl, keyLabel(Keys.IMPLANT))),
    );
  }

  private resetTransient(): void {
    this.wielded = false; this.holding = false;
    toggleClass(this.root, 'wielded', false);
    toggleClass(this.root, 'holding', false);
    this.barrierHp = 0; this.barrierMax = 0; this.barrierActive = false; this.barrierLockout = 0;
    this.lastKey = '';
  }

  private setEquipped(id: ImplantId | null): void {
    this.equipped = id;
    this.def = id ? (this.ctx.implants?.getDef(id) ?? null) : null;
    this.lastKey = '';
    if (!id) { this.root.hidden = true; return; }
    setText(this.ico, this.def?.icon ?? '◈');
    this.root.style.setProperty('--ic', this.def?.color ?? 'var(--c-info)');
    this.root.dataset.implant = id;
    this.root.hidden = false;
  }

  update(_dt: number, ctx: GameContext): void {
    const imp = ctx.implants;
    // Late registration: pick the equipped implant up as soon as the system exists.
    if (imp && imp.equipped !== this.equipped) this.setEquipped(imp.equipped);
    if (this.equipped === null) { if (!this.root.hidden) this.root.hidden = true; return; }
    // 2026-09-08: nothing next to the crosshair while 전투불능 — the implant is unusable there, and the downed
    //   screen belongs to the bleed-out / 포기 ring.
    if (ctx.player?.isDowned) { if (!this.root.hidden) this.root.hidden = true; return; }
    if (!this.def && imp) this.def = imp.getDef(this.equipped) ?? null;

    if (imp) {
      this.remaining = imp.cooldownRemaining;
      this.total = imp.cooldownTotal;
      this.charges = imp.charges;
      this.maxCharges = imp.maxCharges;
      this.barrierHp = imp.barrierHp;
      this.barrierMax = imp.barrierMaxHp;
      this.barrierActive = imp.barrierActive;
      this.barrierLockout = imp.barrierLockout;
      this.energy = imp.energy;
      this.energyMax = imp.energyMax;
      if (imp.wielded !== this.wielded) { this.wielded = imp.wielded; toggleClass(this.root, 'wielded', this.wielded); }
      if (imp.holding !== this.holding) { this.holding = imp.holding; toggleClass(this.root, 'holding', this.holding); }
    }

    // hidden with the reticle while any UI blocker is up
    const blocked = ctx.uiBlockers.size > 0;
    if (this.root.classList.contains('blocked') !== blocked) toggleClass(this.root, 'blocked', blocked);

    const id = this.equipped;
    let key: string;
    if (id === 'dash' || this.maxCharges > 1) key = this.renderCharges();
    else if (id === 'barrier') key = this.renderBarrier();
    else if (id === 'overcharge') key = this.renderEnergy();
    else key = this.renderCooldown();
    if (key !== this.lastKey) this.lastKey = key;
  }

  /** Show `n` segments (others hidden) and return them for filling. */
  private useSegments(n: number): void {
    for (let i = 0; i < MAX_SEGMENTS; i++) this.segs[i].hidden = i >= n;
    toggleClass(this.gauge, 'split', n > 1);
  }

  private setFill(i: number, frac: number, cls: 'ready' | 'filling' | 'low' | 'locked' | ''): void {
    const f = Math.min(1, Math.max(0, frac));
    const fill = this.segFills[i];
    const key = `${f.toFixed(3)}|${cls}`;
    if (fill.dataset.k === key) return;
    fill.dataset.k = key;
    fill.style.transform = `scaleY(${f.toFixed(3)})`;
    const seg = this.segs[i];
    seg.className = `seg${cls ? ` ${cls}` : ''}`;
  }

  private setRead(text: string, cls = ''): void {
    setText(this.readEl, text);
    if (this.readEl.dataset.c !== cls) { this.readEl.dataset.c = cls; this.readEl.className = `read ui-mono${cls ? ` ${cls}` : ''}`; }
  }

  /** 갈고리 / 정찰 / 대전차포: one bar filling up while the cooldown runs. */
  private renderCooldown(): string {
    this.useSegments(1);
    const ready = this.charges > 0 && this.remaining <= 0.001;
    const frac = ready ? 1 : this.total > 0 ? 1 - Math.min(1, this.remaining / this.total) : 1;
    this.setFill(0, frac, ready ? 'ready' : 'filling');
    this.setRead(ready ? '' : this.remaining.toFixed(this.remaining < 10 ? 1 : 0), ready ? '' : 'cd');
    toggleClass(this.root, 'ready', ready);
    return `cd|${frac.toFixed(3)}|${ready ? 1 : 0}`;
  }

  /** 대시: one segment per charge; the refilling one fills alone, ready ones are yellow. */
  private renderCharges(): string {
    const n = Math.min(MAX_SEGMENTS, Math.max(1, this.maxCharges));
    this.useSegments(n);
    const refill = this.total > 0 && this.remaining > 0 ? 1 - Math.min(1, this.remaining / this.total) : 0;
    for (let i = 0; i < n; i++) {
      if (i < this.charges) this.setFill(i, 1, 'ready');
      else if (i === this.charges && this.remaining > 0) this.setFill(i, refill, 'filling');
      else this.setFill(i, 0, '');
    }
    const ready = this.charges > 0;
    this.setRead(this.charges < n && this.remaining > 0.05 ? this.remaining.toFixed(1) : `${this.charges}/${n}`, ready ? '' : 'cd');
    toggleClass(this.root, 'ready', ready);
    return `ch|${this.charges}|${refill.toFixed(3)}`;
  }

  /** 배리어: the bar is the shield hp; a collapse refills it from 0 over the lockout (= cooldown). */
  private renderBarrier(): string {
    this.useSegments(1);
    const max = this.barrierMax > 0 ? this.barrierMax : 1;
    const r = Math.min(1, Math.max(0, this.barrierHp / max));
    const locked = this.barrierLockout > 0.001;
    this.setFill(0, r, locked ? 'locked' : r < 0.25 ? 'low' : 'ready');
    this.setRead(locked ? this.barrierLockout.toFixed(this.barrierLockout < 10 ? 1 : 0) : `${Math.round(r * 100)}%`, locked ? 'cd' : '');
    toggleClass(this.root, 'ready', !locked);
    toggleClass(this.root, 'deployed', this.barrierActive);
    return `ba|${r.toFixed(3)}|${locked ? 1 : 0}|${this.barrierActive ? 1 : 0}`;
  }

  /** 오버차지: the bar is the energy pool. */
  private renderEnergy(): string {
    this.useSegments(1);
    const max = this.energyMax > 0 ? this.energyMax : 1;
    const r = Math.min(1, Math.max(0, this.energy / max));
    this.setFill(0, r, this.holding ? 'filling' : r < 0.15 ? 'low' : 'ready');
    this.setRead(`${Math.round(r * 100)}%`, r < 0.15 && !this.holding ? 'cd' : '');
    toggleClass(this.root, 'ready', r > 0.12);
    return `en|${r.toFixed(3)}|${this.holding ? 1 : 0}`;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
