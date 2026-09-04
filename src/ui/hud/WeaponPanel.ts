import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const AMMO_LABEL: Record<string, string> = {
  rifle: '소총탄', pistol: '권총탄', shotgun: '산탄', energy: '에너지',
};

/** Bottom-right weapon readout: name, mag, reserve, ammo type tag, reload arc, low/empty states. */
export class WeaponPanel {
  readonly root: HTMLElement;
  private slotEl: HTMLElement;
  private nameEl: HTMLElement;
  private magEl: HTMLElement;
  private reserveEl: HTMLElement;
  private typeEl: HTMLElement;
  private reloadingEl: HTMLElement;
  private arc: HTMLElement;
  private arcProg: SVGCircleElement;
  private readonly circ = 2 * Math.PI * 14;

  private weaponId = '';
  private magSize = 1;
  private reloadTotal = 0;
  private reloadLeft = 0;
  private lastDash = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'weapon', parent });
    const nameRow = el('div', { cls: 'name-row', parent: this.root });
    this.slotEl = el('span', { cls: 'slot', text: '1', parent: nameRow });
    this.nameEl = el('span', { cls: 'name', text: '—', parent: nameRow });

    const ammoRow = el('div', { cls: 'ammo-row', parent: this.root });
    this.arc = el('div', { cls: 'arc', parent: ammoRow });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 34 34');
    const track = document.createElementNS(svgNS, 'circle');
    track.setAttribute('class', 'track'); track.setAttribute('cx', '17'); track.setAttribute('cy', '17'); track.setAttribute('r', '14');
    this.arcProg = document.createElementNS(svgNS, 'circle');
    this.arcProg.setAttribute('class', 'prog'); this.arcProg.setAttribute('cx', '17'); this.arcProg.setAttribute('cy', '17'); this.arcProg.setAttribute('r', '14');
    this.arcProg.style.strokeDasharray = `${this.circ}`;
    this.arcProg.style.strokeDashoffset = `${this.circ}`;
    svg.appendChild(track); svg.appendChild(this.arcProg);
    this.arc.appendChild(svg);

    this.magEl = el('span', { cls: 'mag', text: '0', parent: ammoRow });
    this.reserveEl = el('span', { cls: 'reserve', text: '0', parent: ammoRow });

    const tagRow = el('div', { cls: 'name-row', parent: this.root });
    this.reloadingEl = el('span', { cls: 'reloading', text: '재장전', parent: tagRow });
    this.typeEl = el('span', { cls: 'type', text: '—', parent: tagRow });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('weapon:equipped', (p) => {
        this.weaponId = p.weaponId;
        this.magSize = Math.max(1, p.magSize);
        setText(this.slotEl, p.slot === 'primary' ? '1' : '2');
        setText(this.nameEl, p.name);
        const def = ctx.loot?.getWeaponDef(p.weaponId);
        setText(this.typeEl, def ? (AMMO_LABEL[def.ammoType] ?? def.ammoType) : '—');
        this.setAmmo(p.ammoInMag, p.reserveRounds);
        this.endReload();
      }),
      b.on('weapon:ammoChanged', (p) => {
        if (p.weaponId !== this.weaponId && this.weaponId) return;
        this.magSize = Math.max(1, p.magSize);
        this.setAmmo(p.ammoInMag, p.reserveRounds);
      }),
      b.on('weapon:reloadStarted', ({ duration }) => {
        this.reloadTotal = Math.max(0.05, duration);
        this.reloadLeft = this.reloadTotal;
        this.arc.classList.add('show');
        this.reloadingEl.classList.add('show');
      }),
      b.on('weapon:reloadFinished', () => this.endReload()),
      b.on('weapon:dryFire', () => {
        this.magEl.classList.remove('flash');
        void this.magEl.offsetWidth;
        this.magEl.classList.add('flash');
      }),
      b.on('loadout:changed', ({ primary, secondary }) => {
        if (!primary && !secondary) {
          this.weaponId = '';
          setText(this.nameEl, '무장 없음');
          setText(this.typeEl, '—');
          this.setAmmo(0, 0);
        }
      }),
    );
  }

  update(dt: number): void {
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      const t = 1 - Math.max(0, this.reloadLeft) / this.reloadTotal;
      const dash = this.circ * (1 - t);
      if (Math.abs(dash - this.lastDash) > 0.2) {
        this.lastDash = dash;
        this.arcProg.style.strokeDashoffset = dash.toFixed(2);
      }
      if (this.reloadLeft <= 0) this.endReload();
    }
  }

  private setAmmo(mag: number, reserve: number): void {
    setText(this.magEl, String(mag));
    setText(this.reserveEl, String(reserve));
    const ratio = mag / this.magSize;
    toggleClass(this.magEl, 'empty', mag <= 0);
    toggleClass(this.magEl, 'low', mag > 0 && ratio <= 0.25);
  }

  private endReload(): void {
    this.reloadLeft = 0;
    this.arc.classList.remove('show');
    this.reloadingEl.classList.remove('show');
    this.arcProg.style.strokeDashoffset = `${this.circ}`;
    this.lastDash = -1;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
