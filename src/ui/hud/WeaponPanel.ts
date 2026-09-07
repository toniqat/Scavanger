import type { GameContext, ItemDef, ItemInstance, UniqueWeaponKind, WeaponDef, WeaponSlot } from '@/shared';
import { Keys, WEAPON_DEFAULT_DURABILITY, keyLabel } from '@/shared';
import { buildItemChip } from '@/shared';
import { WEAPON_CLASS_LABEL_KO, weaponClassOf } from '@/items';
import { el, setText, toggleClass } from '../dom';
import { SlotStrip, weaponSlotKey } from './SlotStrip';

/** Durability ratio at/below which the bar turns amber (`.worn`). */
const DURABILITY_WORN = 0.3;

/** Thumbnail edge of the weapon chip in the bottom-right box. */
const WEAPON_THUMB_SIZE = 34;

/** Usage hint per consumable category (`.weapon.consumable .hint`). */
const CONSUMABLE_HINT: Record<string, string> = {
  // Phase 10: the 회복약 is a 2 s hold (`HEAL_HOLD_S`), shown as the crosshair ring `hud/HealGauge`.
  stim: '좌클릭 2초 홀드',
  grenade: '좌클릭 홀드 · R 코킹 · 우클릭 언더핸드',
};

/** Fixed `좌: … / 우: …` fire-mode texts per unique weapon kind (`WeaponDef.altFire` — RMB is an alternative fire, not ADS). */
const UNIQUE_MODES: Readonly<Record<UniqueWeaponKind, { l: string; r: string }>> = {
  flamethrower: { l: '넓은 화염', r: '긴 화염 제트' },
  shockgun: { l: '연쇄 전격', r: '충전 볼트' },
  shuriken: { l: '표창 1개', r: '표창 3개 (F 길게: 용검)' },
  bow: { l: '화살', r: '정조준' },
  bazooka: { l: '착탄 로켓', r: '공중 폭발 (바닥 우클릭: 로켓 점프)' },
  minigun: { l: '예열 후 사격', r: '—' },
};

/**
 * Bottom-right weapon readout: slot strip (1/2/3/F), durability bar, mag / reserve (bag rounds) with the weapon
 * **thumbnail** beside them, slot tag + class tag, swap sweep, low / empty / broken states. The reload readout moved
 * to the crosshair in Phase 10 (`hud/ReloadGauge`) — this panel no longer owns an arc or a `재장전` pill.
 *
 * 2026-09-07: the separate name line above the durability bar is gone. The name now lives in `.wthumb`, a
 * fixed-size horizontal box right of the ammo count holding the inventory item chip (`buildItemChip`, so the icon
 * and rarity colour match the bag exactly) plus the weapon name.
 * **Consumable mode** (`.weapon.consumable`, `quick:equipped {item}`): the gun rows are hidden and a `.cons` block shows
 * the item name + stack count (`quick:used.remaining` / `inventory:itemUpdated`) with a usage hint; back to gun mode on
 * `quick:equipped {item:null}` or the next `weapon:equipped`. Gun state keeps updating underneath, so the switch back is
 * just a class toggle.
 */
export class WeaponPanel {
  readonly root: HTMLElement;
  readonly slots: SlotStrip;
  private slotEl: HTMLElement;
  private nameEl: HTMLElement;
  private magEl: HTMLElement;
  private reserveEl: HTMLElement;
  private typeEl: HTMLElement;
  private thumbEl: HTMLElement;
  private thumbIcon: HTMLElement;
  private duraEl: HTMLElement;
  private duraFill: HTMLElement;
  private swapEl: HTMLElement;

  private modesEl: HTMLElement;
  private modeL: HTMLElement;
  private modeR: HTMLElement;

  private consName: HTMLElement;
  private consKey: HTMLElement;
  private consCnt: HTMLElement;
  private consHint: HTMLElement;
  private consUid = '';
  private consumable = false;

  private weaponId = '';
  private weaponUid = '';
  private magSize = 1;
  private lastDura = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'weapon', parent });
    this.slots = new SlotStrip(this.root);

    this.duraEl = el('div', { cls: 'dura', parent: this.root });
    this.duraFill = el('div', { cls: 'fill', parent: this.duraEl });
    this.swapEl = el('div', { cls: 'swap', parent: this.root });
    el('div', { cls: 'fill', parent: this.swapEl });

    // Phase 10: the reload arc that used to sit left of this row is gone — `hud/ReloadGauge` draws it at the crosshair.
    const ammoRow = el('div', { cls: 'ammo-row', parent: this.root });
    const ammoNums = el('div', { cls: 'ammo-nums', parent: ammoRow });
    this.magEl = el('span', { cls: 'mag', text: '0', parent: ammoNums });
    this.reserveEl = el('span', { cls: 'reserve', text: '0', parent: ammoNums });
    // Fixed-size thumbnail box right of the count: inventory item chip + weapon name (2026-09-07).
    this.thumbEl = el('div', { cls: 'wthumb', parent: ammoRow });
    this.thumbIcon = el('div', { cls: 'wt-icon', parent: this.thumbEl });
    this.nameEl = el('span', { cls: 'name wt-name', text: '—', parent: this.thumbEl });

    const tagRow = el('div', { cls: 'name-row', parent: this.root });
    this.slotEl = el('span', { cls: 'slot', text: '1', parent: tagRow });
    this.typeEl = el('span', { cls: 'type', text: '—', parent: tagRow });

    // Unique-weapon fire modes (`.modes`, only for defs with `altFire` / `unique`): `좌: …` / `우: …`.
    this.modesEl = el('div', { cls: 'modes', parent: this.root });
    const rowL = el('div', { cls: 'mode', parent: this.modesEl });
    el('span', { cls: 'mk', text: '좌', parent: rowL });
    this.modeL = el('span', { cls: 'mv', text: '', parent: rowL });
    const rowR = el('div', { cls: 'mode', parent: this.modesEl });
    el('span', { cls: 'mk', text: '우', parent: rowR });
    this.modeR = el('span', { cls: 'mv', text: '', parent: rowR });

    // Consumable mode block (stim / grenade in hand) — shown instead of the gun rows via `.weapon.consumable`.
    const cons = el('div', { cls: 'cons', parent: this.root });
    const consRow = el('div', { cls: 'name-row', parent: cons });
    this.consKey = el('span', { cls: 'slot', text: keyLabel(Keys.QUICK), parent: consRow });
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
      b.on('input:bindingsChanged', () => setText(this.consKey, keyLabel(Keys.QUICK))),
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
        // Phase 9 UI pass: the slot word (주무기 …) and the calibre (준중량탄 …) are gone — the numbered chip and the class say enough.
        setText(this.typeEl, def ? WEAPON_CLASS_LABEL_KO[weaponClassOf(def)] : '—');
        this.setModes(def);
        this.setAmmo(p.ammoInMag, p.reserveRounds);
        // Seed the durability bar from the equipped item instance (durabilityChanged only fires on change).
        const inst = ctx.inventory?.getLoadout()[p.slot] ?? null;
        this.weaponUid = inst?.uid ?? '';
        // the item def behind the equipped weapon (`wpn_<id>` for graded guns) drives the thumbnail
        const itemDefId = inst?.defId ?? `wpn_${p.weaponId}`;
        this.setThumb(ctx.inventory?.getDef(itemDefId) ?? ctx.loot?.getItemDef(itemDefId));
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
          this.setThumb(undefined);
          this.setModes(undefined);
          this.setAmmo(0, 0);
          this.setDurability(1, 1, false);
          this.endSwap();
          /* reload state lives in `hud/ReloadGauge` now (it hides itself on death / reset / cancel) */
        }
      }),
    );
  }

  /** Rebuild the weapon thumbnail (the shared inventory chip, so icon + rarity colour match the bag). */
  private setThumb(def: ItemDef | undefined): void {
    this.thumbIcon.replaceChildren();
    if (def) this.thumbIcon.appendChild(buildItemChip(def, { size: WEAPON_THUMB_SIZE }));
    toggleClass(this.thumbEl, 'is-empty', !def);
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

  /** `좌: … / 우: …` mode lines for unique weapons (`.weapon.has-modes`); hidden for every graded weapon. */
  private setModes(def: WeaponDef | undefined): void {
    const modes = def && (def.altFire || def.unique) && def.unique ? UNIQUE_MODES[def.unique] : null;
    toggleClass(this.root, 'has-modes', !!modes);
    setText(this.modeL, modes ? modes.l : '');
    setText(this.modeR, modes ? modes.r : '');
  }

  /** Whether the unique fire-mode lines are showing (debug). */
  get hasModes(): boolean { return this.root.classList.contains('has-modes'); }

  private setSlot(slot: WeaponSlot): void {
    setText(this.slotEl, weaponSlotKey(slot));
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

  dispose(): void { for (const u of this.unsubs) u(); this.slots.dispose(); this.root.remove(); }
}
