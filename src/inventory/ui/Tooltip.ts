import type { ArmorDef, BackpackDef, ItemDef, ItemInstance, WeaponDef } from '@/shared';
import { MELEE_DAMAGE } from '@/shared';
import { itemWeight, meleeMulOf } from '@/items';
import { durabilityInfo } from '../Gear';
import { TEXT, ammoLabel, categoryLabel, effectiveRange, fmtKg, fmtValue, rarityColor, rarityLabel, weaponClassLabel } from './labels';

export type ArmorLookup = (armorId: string) => ArmorDef | undefined;
export type BackpackLookup = (backpackId: string) => BackpackDef | undefined;

/** Hover card: name, category · rarity, description, durability bar, value, weight, size and stats. */
export class Tooltip {
  readonly el: HTMLElement;
  private visible = false;

  constructor(
    private readonly getWeapon: (weaponId: string) => WeaponDef | undefined,
    private readonly getArmor: ArmorLookup = () => undefined,
    private readonly getBackpack: BackpackLookup = () => undefined,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'inv-tooltip';
    this.el.hidden = true;
  }

  show(item: ItemInstance, def: ItemDef, x: number, y: number): void {
    this.el.innerHTML = '';
    this.el.style.setProperty('--rc', rarityColor(def));

    const head = document.createElement('div');
    head.className = 'inv-tt-head';
    const name = document.createElement('div');
    name.className = 'inv-tt-name';
    name.textContent = def.name;
    const sub = document.createElement('div');
    sub.className = 'inv-tt-sub';
    sub.textContent = `${categoryLabel(def)} · ${rarityLabel(def)}`;
    head.append(name, sub);
    this.el.appendChild(head);

    const desc = document.createElement('p');
    desc.className = 'inv-tt-desc';
    desc.textContent = def.description;
    this.el.appendChild(desc);

    /* durability bar (weapons, armor, backpacks) */
    const dur = durabilityInfo(item, def);
    if (dur) {
      const wrap = document.createElement('div');
      wrap.className = 'inv-tt-dur';
      if (dur.broken) wrap.classList.add('is-broken');
      else if (dur.durability / dur.max < 0.25) wrap.classList.add('is-low');
      const label = document.createElement('div');
      label.className = 'inv-tt-dur-label';
      label.textContent = dur.broken
        ? `${TEXT.durability} · ${TEXT.broken}`
        : `${TEXT.durability} ${Math.round(dur.durability)} / ${dur.max}`;
      const track = document.createElement('div');
      track.className = 'inv-tt-dur-track';
      const fill = document.createElement('i');
      fill.style.width = `${(dur.durability / dur.max) * 100}%`;
      track.appendChild(fill);
      wrap.append(label, track);
      this.el.appendChild(wrap);
    }

    const rows: Array<[string, string]> = [];
    const weapon = def.weaponId ? this.getWeapon(def.weaponId) : undefined;
    if (weapon) {
      const s = TEXT.weaponStats;
      const dmg = weapon.pellets ? `${weapon.damage} × ${weapon.pellets} ${TEXT.pellets}` : `${weapon.damage}`;
      rows.push([s.weaponClass, weaponClassLabel(weapon)]);
      rows.push([s.damage, dmg]);
      rows.push([s.fireRate, `${weapon.fireRate} /s`]);
      rows.push([s.magSize, `${weapon.magSize}`]);
      rows.push([s.reserve, `${weapon.reserveMags}`]);
      rows.push([s.reload, `${weapon.reloadTime.toFixed(1)} s`]);
      rows.push([s.mode, weapon.automatic ? TEXT.auto : TEXT.semi]);
      rows.push([s.ammo, ammoLabel(weapon)]);
      rows.push([s.effectiveRange, `${effectiveRange(weapon)} m`]);
      rows.push([s.range, `${weapon.range} m`]);
      if (weapon.adsZoom && weapon.adsZoom > 1) rows.push([s.zoom, `${weapon.adsZoom}×`]);
      const melee = meleeMulOf(weapon);
      rows.push(['근접 피해', `${Math.round(MELEE_DAMAGE * melee)}${melee > 1 ? ` (×${melee.toFixed(2)})` : ''}`]);
    }

    const armor = def.armorId ? this.getArmor(def.armorId) : undefined;
    if (armor) {
      const g = TEXT.gear;
      rows.push([g.damageReduction, `${(armor.damageReduction * 100).toFixed(0)} %`]);
      if (armor.tier > 0) rows.push([g.tier, `${armor.tier}`]);
      rows.push([g.perk, TEXT.armorPerk[armor.perk] ?? armor.perk]);
    }

    const backpack = def.backpackId ? this.getBackpack(def.backpackId) : undefined;
    if (backpack) {
      const g = TEXT.gear;
      rows.push([g.grid, `${backpack.cols} × ${backpack.rows}`]);
      rows.push([g.quickSlots, `${backpack.quickSlots}`]);
      rows.push([g.capacity, `+${backpack.capacityBonus.toFixed(0)} kg`]);
      if (backpack.tier > 0) rows.push([g.tier, `${backpack.tier}`]);
      rows.push([g.perk, TEXT.backpackPerk[backpack.perk] ?? backpack.perk]);
    }

    if (def.healAmount) rows.push(['회복', `+${def.healAmount} HP`]);
    if (def.stackMax > 1) rows.push([TEXT.qty, `${item.qty} / ${def.stackMax}`]);
    rows.push([TEXT.size, `${def.width} × ${def.height}`]);
    rows.push([TEXT.weight, def.stackMax > 1 && item.qty > 1
      ? `${fmtKg(itemWeight(def, item.qty))} (${fmtKg(itemWeight(def))} × ${item.qty})`
      : fmtKg(itemWeight(def, item.qty))]);
    rows.push([TEXT.value, def.stackMax > 1 && item.qty > 1 ? `${fmtValue(def.value)} × ${item.qty}` : fmtValue(def.value * item.qty)]);

    const table = document.createElement('div');
    table.className = 'inv-tt-stats';
    for (const [k, v] of rows) {
      const kEl = document.createElement('span'); kEl.className = 'k'; kEl.textContent = k;
      const vEl = document.createElement('span'); vEl.className = 'v'; vEl.textContent = v;
      table.append(kEl, vEl);
    }
    this.el.appendChild(table);

    if (def.quickUsable === true) {
      const foot = document.createElement('div');
      foot.className = 'inv-tt-foot';
      foot.textContent = TEXT.quickHint;
      this.el.appendChild(foot);
    }

    this.el.hidden = false;
    this.visible = true;
    this.move(x, y);
  }

  move(x: number, y: number): void {
    if (!this.visible) return;
    const pad = 16;
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    let left = x + pad, top = y + pad;
    if (left + w > window.innerWidth - 8) left = x - w - pad;
    if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - pad);
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.hidden = true;
  }

  dispose(): void { this.el.remove(); }
}
