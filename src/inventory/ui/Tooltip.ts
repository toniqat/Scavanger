import type { ArmorDef, EffectiveWeaponStats, ItemDef, ItemInstance, SkillId, WeaponDef } from '@/shared';
import { SOCKET_LABEL_KO, SOCKET_SLOTS } from '@/shared';
import { WEAPON_CLASS_LABEL_KO } from '@/items';
import {
  DURABILITY_LOW, TEXT, ammoTypeLabel, categoryLabel, effectiveRange, fmtDeg, fmtMul, fmtValue, gradeLabel, rarityColor, rarityLabel,
  weaponClassLabel,
} from './labels';

export interface TooltipLookups {
  getWeapon(weaponId: string): WeaponDef | undefined;
  getDef(defId: string): ItemDef | undefined;
  /** Graded + socketed numbers for a weapon instance (null for non-weapons). */
  getStats(item: ItemInstance): EffectiveWeaponStats | null;
  /** appended: tactical kit — armor plate data for 'armor' items. */
  getArmorDef(armorId: string): ArmorDef | undefined;
  /** appended (Phase 9): Korean skill name for a 서적 (`ItemDef.book.skill`); the id when progression is not around. */
  getSkillName?(id: SkillId): string;
}

/**
 * Hover card: name, category · rarity, description, value, size and — for weapons — the effective stats
 * (grade / sockets folded in), durability and the five sockets; attachments list their effects, bags their grid.
 */
export class Tooltip {
  readonly el: HTMLElement;
  private visible = false;

  constructor(private readonly lookups: TooltipLookups) {
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

    const rows: Array<[string, string, string?]> = [];
    const weapon = def.weaponId ? this.lookups.getWeapon(def.weaponId) : undefined;
    const stats = weapon ? this.lookups.getStats(item) : null;
    if (weapon && stats) {
      const s = TEXT.weaponStats;
      const dmg = weapon.pellets ? `${stats.damage} × ${weapon.pellets} ${TEXT.pellets}` : `${stats.damage}`;
      rows.push([s.weaponClass, weaponClassLabel(weapon)]);
      rows.push([s.grade, gradeLabel(stats)]);
      rows.push([s.damage, dmg]);
      rows.push([s.magSize, `${stats.magSize}`]);
      rows.push([s.loaded, `${Math.max(0, item.ammoInMag ?? 0)} / ${stats.magSize}`]);
      rows.push([s.fireRate, `${stats.fireRate} /s`]);
      rows.push([s.recoil, fmtDeg(stats.recoilV)]);
      rows.push([s.adsTime, `${stats.adsTime.toFixed(2)} s`]);
      rows.push([s.reload, `${stats.reloadTime.toFixed(1)} s`]);
      rows.push([s.mode, weapon.automatic ? TEXT.auto : TEXT.semi]);
      rows.push([s.ammo, ammoTypeLabel(stats.ammoType)]);
      rows.push([s.effectiveRange, `${effectiveRange(weapon)} m`]);
      if (stats.adsZoom > 1 || stats.scope) rows.push([s.zoom, `${stats.adsZoom}×${stats.scope ? ' · 스코프' : ''}`]);
      const max = Math.max(1, stats.maxDurability);
      const cur = Math.max(0, Math.min(max, item.durability ?? max));
      const durClass = cur <= 0 ? 'is-broken' : cur / max < DURABILITY_LOW ? 'is-low' : undefined;
      rows.push([s.durability, cur <= 0 ? `${TEXT.broken} · 0 / ${max}` : `${cur} / ${max}`, durClass]);
    }
    if (def.attachment) {
      const a = def.attachment;
      const t = TEXT.attachmentStats;
      rows.push([t.socket, SOCKET_LABEL_KO[a.socket]]);
      const fits: string[] = [];
      if (a.classes) fits.push(a.classes.map((c) => WEAPON_CLASS_LABEL_KO[c]).join(', '));
      if (a.ammoTypes) fits.push(a.ammoTypes.map(ammoTypeLabel).join(', '));
      rows.push([t.fits, fits.length ? fits.join(' · ') : t.all]);
      const fx = a.effects;
      if (fx.recoilV !== undefined) rows.push([t.recoilV, fmtMul(fx.recoilV)]);
      if (fx.recoilH !== undefined) rows.push([t.recoilH, fmtMul(fx.recoilH)]);
      if (fx.spread !== undefined) rows.push([t.spread, fmtMul(fx.spread)]);
      if (fx.hipSpread !== undefined) rows.push([t.hipSpread, fmtMul(fx.hipSpread)]);
      if (fx.adsTime !== undefined) rows.push([t.adsTime, fmtMul(fx.adsTime)]);
      if (fx.magSize !== undefined) rows.push([t.magSize, fmtMul(fx.magSize)]);
      if (fx.adsZoom !== undefined) rows.push([t.zoom, `${fx.adsZoom}×`]);
      if (fx.scope) rows.push([t.scope, '✓']);
      if (fx.laser) rows.push([t.laser, '✓']);
    }
    if (def.bag) {
      const b = TEXT.bagStats;
      rows.push([b.grid, `${def.bag.cols} × ${def.bag.rows}${def.bag.tactical ? ` · ${b.tactical}` : ''}`]);
      rows.push([b.quickSlots, `${def.bag.quickSlots}`]);
    }
    if (def.armorId) {
      const a = this.lookups.getArmorDef(def.armorId);
      const t = TEXT.armorStats;
      if (a) {
        rows.push([t.dr, `${Math.round(a.damageReduction * 100)} %`]);
        const max = def.durabilityMax ?? a.durabilityMax;
        rows.push([t.durability, `${Math.round(Math.max(0, Math.min(max, item.durability ?? max)))} / ${max}`]);
        if (a.perk !== 'none') rows.push([t.perk, a.description]);
      }
    }
    if (def.book) {
      const t = TEXT.bookStats;
      rows.push([t.skill, this.lookups.getSkillName?.(def.book.skill) ?? def.book.skill]);
      rows.push([t.use, t.shelf]);
    }
    if (def.weight !== undefined) rows.push([TEXT.weight, `${(def.weight * Math.max(1, item.qty)).toFixed(1)} kg`]);
    if (def.healAmount) rows.push(['회복', `+${def.healAmount} HP`]);
    if (def.stackMax > 1) rows.push([TEXT.qty, `${item.qty} / ${def.stackMax}`]);
    rows.push([TEXT.size, `${def.width} × ${def.height}`]);
    rows.push([TEXT.value, def.stackMax > 1 && item.qty > 1 ? `${fmtValue(def.value)} × ${item.qty}` : fmtValue(def.value * item.qty)]);

    const table = document.createElement('div');
    table.className = 'inv-tt-stats';
    for (const [k, v, cls] of rows) {
      const kEl = document.createElement('span'); kEl.className = 'k'; kEl.textContent = k;
      const vEl = document.createElement('span'); vEl.className = cls ? `v ${cls}` : 'v'; vEl.textContent = v;
      table.append(kEl, vEl);
    }
    this.el.appendChild(table);

    if (weapon) {
      const sockets = document.createElement('div');
      sockets.className = 'inv-tt-sockets';
      const title = document.createElement('div');
      title.className = 'inv-tt-sockets-title';
      title.textContent = TEXT.weaponStats.sockets;
      sockets.appendChild(title);
      for (const s of SOCKET_SLOTS) {
        const att = item.sockets?.[s];
        const attDef = att ? this.lookups.getDef(att.defId) : undefined;
        const row = document.createElement('div');
        row.className = attDef ? 'inv-tt-socket is-filled' : 'inv-tt-socket';
        const k = document.createElement('span'); k.className = 'k'; k.textContent = SOCKET_LABEL_KO[s];
        const v = document.createElement('span'); v.className = 'v'; v.textContent = attDef?.name ?? TEXT.socketEmpty;
        if (attDef) v.style.color = rarityColor(attDef);
        row.append(k, v);
        sockets.appendChild(row);
      }
      this.el.appendChild(sockets);
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
