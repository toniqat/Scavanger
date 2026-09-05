import type { GameContext, ItemInstance, WeaponSlot } from '@/shared';
import { WEAPON_DEFAULT_DURABILITY } from '@/shared';
import { WEAPON_CLASS_LABEL_KO, weaponClassOf, AMMO_LABEL_KO } from '@/items';
import { el, setText, toggleClass } from '../dom';
import { SlotStrip, WEAPON_SLOT_KEY, WEAPON_SLOT_LABEL_KO } from './SlotStrip';

/** Durability ratio at/below which the bar turns amber (`.worn`). */
const DURABILITY_WORN = 0.3;

/** Usage hint per consumable category (`.weapon.consumable .hint`). */
const CONSUMABLE_HINT: Record<string, string> = {
  stim: '좌클릭 사용',
  grenade: '좌클릭 홀드 · R 코킹 · 우클릭 언더핸드',
};

/**
 * Bottom-right weapon readout: slot strip (1/2/3/F), slot tag + Korean slot label, weapon name, durability bar,
 * mag / reserve (bag rounds), class + calibre tag, reload arc, swap sweep, low / empty / broken states.
 * **Consumable mode** (`.weapon.consumable`, `quick:equipped {item}`): the gun rows are hidden and a `.cons` block shows
 * the item name + stack count (`quick:used.remaining` / `inventory:itemUpdated`) with a usage hint; back to gun mode on
 * `quick:equipped {item:null}` or the next `weapon:equipped`. Gun state keeps updating underneath, so the switch back is
 * just a class toggle.
 */
export class WeaponPanel {
  readonly root: HTMLElement;
  readonly slots: SlotStrip;
  private slotEl: HTMLElement;
  private slotLblEl: HTMLElement;
  private nameEl: HTMLElement;
  private magEl: HTMLElement;
  private reserveEl: HTMLElement;
  private typeEl: HTMLElement;
  private reloadingEl: HTMLElement;
  private duraEl: HTMLElement;
  private duraFill: HTMLElement;
  private swapEl: HTMLElement;
  private arc: HTMLElement;
  private arcProg: SVGCircleElement;
  private readonly circ = 2 * Math.PI * 14;

  private consName: HTMLElement;
  private consCnt: HTMLElement;
  private consHint: HTMLElement;
  private consUid = '';
  private consumable = false;

  private weaponId = '';
  private weaponUid = '';
  private magSize = 1;
  private reloadTotal = 0;
  private reloadLeft = 0;
  private lastDash = -1;
  private lastDura = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'weapon', parent });
    this.slots = new SlotStrip(this.root);

    const nameRow = el('div', { cls: 'name-row', parent: this.root });
    this.slotEl = el('span', { cls: 'slot', text: '1', parent: nameRow });
    this.slotLblEl = el('span', { cls: 'slot-lbl', text: WEAPON_SLOT_LABEL_KO.primary, parent: nameRow });
    this.nameEl = el('span', { cls: 'name', text: '—', parent: nameRow });

    this.duraEl = el('div', { cls: 'dura', parent: this.root });
    this.duraFill = el('div', { cls: 'fill', parent: this.duraEl });
    this.swapEl = el('div', { cls: 'swap', parent: this.root });
    el('div', { cls: 'fill', parent: this.swapEl });

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

    // Consumable mode block (stim / grenade in hand) — shown instead of the gun rows via `.weapon.consumable`.
    const cons = el('div', { cls: 'cons', parent: this.root });
    const consRow = el('div', { cls: 'name-row', parent: cons });
    el('span', { cls: 'slot', text: 'T', parent: consRow });
    el('span', { cls: 'slot-lbl', text: '빠른 사용', parent: consRow });
    this.consName = el('span', { cls: 'name', text: '—', parent: consRow });
    const consCntRow = el('div', { cls: 'ammo-row', parent: cons });
    this.consCnt = el('span', { cls: 'mag', text: '0', parent: consCntRow });
    el('span', { cls: 'cnt-lbl', text: '개', parent: consCntRow });
    this.consHint = el('div', { cls: 'hint', text: '', parent: cons });
  }

  bind(ctx: GameContext): void {
    this.slots.bind(ctx);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('quick:equipped', ({ item }) => {
        if (item) this.enterConsumable(item, ctx); else this.exitConsumable();
      }),
      b.on('quick:used', ({ item, remaining }) => {
        if (this.consumable && item.uid === this.consUid) this.setConsCount(remaining);
      }),
      b.on('inventory:itemUpdated', () => {
        if (!this.consumable || !this.consUid) return;
        const inst = ctx.inventory?.findItem(this.consUid);
        if (inst) this.setConsCount(inst.qty);
      }),
      b.on('weapon:equipped', (p) => {
        this.exitConsumable();
        this.weaponId = p.weaponId;
        this.magSize = Math.max(1, p.magSize);
        this.setSlot(p.slot);
        setText(this.nameEl, p.name);
        const def = ctx.loot?.getWeaponDef(p.weaponId);
        setText(this.typeEl, def ? `${WEAPON_CLASS_LABEL_KO[weaponClassOf(def)]} · ${AMMO_LABEL_KO[def.ammoType] ?? def.ammoType}` : '—');
        this.setAmmo(p.ammoInMag, p.reserveRounds);
        this.endReload();
        // Seed the durability bar from the equipped item instance (durabilityChanged only fires on change).
        const inst = ctx.inventory?.getLoadout()[p.slot] ?? null;
        this.weaponUid = inst?.uid ?? '';
        const max = def?.maxDurability ?? WEAPON_DEFAULT_DURABILITY;
        this.setDurability(inst?.durability ?? max, max, false);
      }),
      b.on('weapon:ammoChanged', (p) => {
        if (p.weaponId !== this.weaponId && this.weaponId) return;
        this.magSize = Math.max(1, p.magSize);
        this.setAmmo(p.ammoInMag, p.reserveRounds);
      }),
      b.on('weapon:durabilityChanged', (p) => {
        if (!this.isActive(p.uid, p.weaponId)) return;
        this.setDurability(p.durability, p.max, false);
      }),
      b.on('weapon:broken', (p) => {
        if (!this.isActive(p.uid, p.weaponId)) return;
        this.setDurability(0, 1, true);
      }),
      b.on('weapon:swapStarted', ({ slot, duration }) => this.startSwap(slot, duration)),
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
      b.on('loadout:changed', ({ primary, primary2, secondary }) => {
        if (!primary && !primary2 && !secondary) {
          this.weaponId = '';
          this.weaponUid = '';
          setText(this.nameEl, '무장 없음');
          setText(this.typeEl, '—');
          this.setAmmo(0, 0);
          this.setDurability(1, 1, false);
          this.endSwap();
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

  private enterConsumable(item: ItemInstance, ctx: GameContext): void {
    const def = ctx.inventory?.getDef(item.defId) ?? ctx.loot?.getItemDef(item.defId);
    this.consUid = item.uid;
    this.consumable = true;
    setText(this.consName, def?.name ?? item.defId);
    setText(this.consHint, CONSUMABLE_HINT[def?.category ?? ''] ?? '좌클릭 사용');
    this.setConsCount(item.qty);
    toggleClass(this.root, 'consumable', true);
  }

  private exitConsumable(): void {
    if (!this.consumable) return;
    this.consumable = false;
    this.consUid = '';
    toggleClass(this.root, 'consumable', false);
  }

  private setConsCount(n: number): void {
    setText(this.consCnt, String(Math.max(0, n)));
    toggleClass(this.consCnt, 'empty', n <= 0);
    toggleClass(this.consCnt, 'low', n === 1);
  }

  /** Whether a consumable (stim / grenade) is in hand instead of a gun. */
  get isConsumable(): boolean { return this.consumable; }

  private isActive(uid: string, weaponId: string): boolean {
    if (this.weaponUid) return uid === this.weaponUid;
    return weaponId === this.weaponId;
  }

  private setSlot(slot: WeaponSlot): void {
    setText(this.slotEl, WEAPON_SLOT_KEY[slot] ?? '1');
    setText(this.slotLblEl, WEAPON_SLOT_LABEL_KO[slot] ?? '');
  }

  private setAmmo(mag: number, reserve: number): void {
    setText(this.magEl, String(mag));
    setText(this.reserveEl, String(reserve));
    const ratio = mag / this.magSize;
    toggleClass(this.magEl, 'empty', mag <= 0);
    toggleClass(this.magEl, 'low', mag > 0 && ratio <= 0.25);
  }

  /** Durability bar: grey → amber (`.worn` < 30 %) → red (`.broken` at 0, flashes when `flash`). */
  private setDurability(value: number, max: number, flash: boolean): void {
    const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
    if (Math.abs(ratio - this.lastDura) > 0.002) {
      this.lastDura = ratio;
      this.duraFill.style.transform = `scaleX(${ratio.toFixed(3)})`;
    }
    const broken = value <= 0;
    toggleClass(this.duraEl, 'worn', !broken && ratio < DURABILITY_WORN);
    toggleClass(this.duraEl, 'broken', broken);
    toggleClass(this.root, 'broken', broken);
    if (flash) {
      this.root.classList.remove('broken-flash');
      void this.root.offsetWidth;
      this.root.classList.add('broken-flash');
    }
  }

  private startSwap(slot: WeaponSlot, duration: number): void {
    this.setSlot(slot);
    this.swapEl.style.setProperty('--swap-d', `${Math.max(0.05, duration).toFixed(2)}s`);
    this.swapEl.classList.remove('show');
    void this.swapEl.offsetWidth;
    this.swapEl.classList.add('show');
  }

  private endSwap(): void { this.swapEl.classList.remove('show'); }

  private endReload(): void {
    this.reloadLeft = 0;
    this.arc.classList.remove('show');
    this.reloadingEl.classList.remove('show');
    this.arcProg.style.strokeDashoffset = `${this.circ}`;
    this.lastDash = -1;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.slots.dispose(); this.root.remove(); }
}
