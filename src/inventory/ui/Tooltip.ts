import type { AmmoType, ArmorDef, DurabilityBucketInfo, EffectiveWeaponStats, ItemDef, ItemInstance, SkillId, StatId, WeaponDef } from '@/shared';
import { PERK_DEFS, SOCKET_LABEL_KO, SOCKET_SLOTS, itemCreditValue, renderItemCost } from '@/shared';
import { WEAPON_CLASS_LABEL_KO, shieldChargeOf } from '@/items';
import {
  DURABILITY_LOW, TEXT, ammoTypeLabel, categoryLabel, effectiveRange, fmtDeg, fmtKg, fmtMul, fmtValue, rarityColor, rarityLabel,
  socketAbbr, socketTip,
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
  /** appended (Phase 12): Korean stat name for an 임플란트 bonus line (`ItemDef.implant.stats`); the id as a fallback. */
  getStatName?(id: StatId): string;
  /** appended (Phase 12): units of `defId` the player owns (bag + 창고) — the 보유/필요 split of the repair-cost chips. */
  countOwned?(defId: string): number;
  /**
   * appended (2026-09-09, 게이지 툴팁): the **bare** graded def stats of a weapon item def — no sockets
   * (`LootRef.getEffectiveStats(defId)`). The white layer of a gauge; `getStats(item)` is the socketed layer.
   */
  getBaseStats?(defId: string): EffectiveWeaponStats | null;
  /** appended (2026-09-09): every weapon item def in the catalog — the gauge maxima are read off these once. */
  allWeaponItemDefs?(): ItemDef[];
  /** appended (2026-09-09): the ammo item (`category 'ammo'`) of a calibre — the thumbnail in the card's corner. */
  findAmmoDef?(type: AmmoType): ItemDef | undefined;
  /**
   * appended (2026-09-11, C-37): 남은 내구도 구간과 그 구간의 수리 · 분해 배수 (`LootRef.durabilityBucketInfo`).
   * 내구도가 **없는** 아이템에도 구간 4 를 돌려주므로 카드는 내구도 줄을 그린 아이템에만 묻는다.
   */
  getDurabilityBucket?(item: ItemInstance): DurabilityBucketInfo | null;
  /** appended (2026-09-11, C-37): 이 인스턴스를 분해할 수 있는가 (`LootRef.getSalvageFor` 가 null 이 아닌가 — 유니크는 false). */
  canSalvage?(item: ItemInstance): boolean;
}

/** Catalog maxima the weapon gauges are normalised against (computed lazily, once per Tooltip). */
interface GaugeMaxima { damage: number; fireRate: number; recoil: number; range: number }

/** The four gauge stats of one weapon (`damage` already × pellets, `recoil` in radians, `range` in metres). */
interface GaugeValues { damage: number; fireRate: number; recoil: number; range: number }

const gaugeValues = (weapon: WeaponDef, s: EffectiveWeaponStats): GaugeValues => ({
  damage: s.damage * (weapon.pellets ?? 1),
  fireRate: s.fireRate,
  recoil: s.recoilV,
  range: effectiveRange(weapon),
});

/**
 * Hover card: name, category · rarity, description, value, size and — for weapons — the effective stats
 * (grade / sockets folded in), durability and the five sockets; attachments list their effects, bags their grid.
 * Phase 12: 임플란트 (`ItemDef.implant`) show 장착칸 / one line per stat bonus / the legendary perk, and a broken one
 * a red 망가짐 line with its 세레스 바이오 repair cost as item chips; a 회복 스프레이 shows its 게이지 (`durability` /
 * `durabilityMax`, `0 / 200` included — an empty can is still an item).
 *
 * 2026-09-09 (무기 카드 재설계): the numeric 대미지 / 연사 / 반동 / 사거리 rows became a **2×2 gauge grid**
 * (`.inv-tt-gauges`) normalised against the catalog maximum of each stat, with the raw number kept small at the
 * right. Every bar has two layers — the bare def value (`getBaseStats`, white) and the socketed value (`getStats`):
 * a socket that raises a stat paints the extra segment green (`.bonus`), one that lowers it (a muzzle brake on
 * recoil) shrinks the white fill and leaves the removed segment as a hollow green outline (`.reduced`). The ammo
 * calibre is an item-chip-like **thumbnail** in the head's right corner, the five sockets are a **row of small
 * squares** (attachment glyph, rarity border; empty = dashed + socket abbreviation), and the bottom bar reads
 * 무게 on the left and 가치 on the right for every item. 종류 / 등급 / 탄창 / 정조준 시간 / 재장전 / 크기 rows are gone.
 */
export class Tooltip {
  readonly el: HTMLElement;
  private visible = false;
  private maxima: GaugeMaxima | null = null;

  constructor(private readonly lookups: TooltipLookups) {
    this.el = document.createElement('div');
    this.el.className = 'inv-tooltip';
    this.el.hidden = true;
  }

  /**
   * 2026-09-11 (C-37): 내구도 줄 바로 아래 `81~100 % · 분해 40 % · 수리 10 %`. 수리 · 분해 재료가 **제작 재료 × 이
   * 구간의 배수**라서 (`items/Salvage`) 닳은 장비를 뜯을지 고칠지를 카드에서 바로 읽게 한다. 내구도 줄을 그린
   * 아이템(무기 · 방탄복 · 가방)에서만 부른다 — 회복 스프레이 게이지는 제작 재료 규칙이 아니다.
   */
  private pushBucketRow(rows: Array<[string, string, string?]>, item: ItemInstance): void {
    const info = this.lookups.getDurabilityBucket?.(item);
    if (!info || !info.label) return;
    const salvage = this.lookups.canSalvage ? (this.lookups.canSalvage(item) ? info.salvageMul : null) : info.salvageMul;
    rows.push([TEXT.durability.tooltipKey, TEXT.durability.tooltip(info.label, salvage, info.repairMul), 'is-bucket']);
  }

  show(item: ItemInstance, def: ItemDef, x: number, y: number): void {
    this.el.innerHTML = '';
    this.el.style.setProperty('--rc', rarityColor(def));

    const weapon = def.weaponId ? this.lookups.getWeapon(def.weaponId) : undefined;
    const stats = weapon ? this.lookups.getStats(item) : null;

    const head = document.createElement('div');
    head.className = 'inv-tt-head';
    const headText = document.createElement('div');
    headText.className = 'inv-tt-head-text';
    const name = document.createElement('div');
    name.className = 'inv-tt-name';
    name.textContent = def.name;
    const sub = document.createElement('div');
    sub.className = 'inv-tt-sub';
    sub.textContent = `${categoryLabel(def)} · ${rarityLabel(def)}`;
    headText.append(name, sub);
    head.appendChild(headText);
    if (stats) head.appendChild(this.buildAmmoThumb(stats.ammoType));
    this.el.appendChild(head);

    const desc = document.createElement('p');
    desc.className = 'inv-tt-desc';
    desc.textContent = def.description;
    this.el.appendChild(desc);

    if (weapon && stats) this.el.appendChild(this.buildGauges(def, weapon, stats));

    const rows: Array<[string, string, string?]> = [];
    if (weapon && stats) {
      const s = TEXT.weaponStats;
      rows.push([s.loaded, `${Math.max(0, item.ammoInMag ?? 0)} / ${stats.magSize}`]);
      rows.push([s.mode, weapon.automatic ? TEXT.auto : TEXT.semi]);
      if (stats.adsZoom > 1 || stats.scope) rows.push([s.zoom, `${stats.adsZoom}×${stats.scope ? ' · 스코프' : ''}`]);
      const max = Math.max(1, stats.maxDurability);
      const cur = Math.max(0, Math.min(max, item.durability ?? max));
      const durClass = cur <= 0 ? 'is-broken' : cur / max < DURABILITY_LOW ? 'is-low' : undefined;
      rows.push([s.durability, cur <= 0 ? `${TEXT.broken} · 0 / ${max}` : `${cur} / ${max}`, durClass]);
      this.pushBucketRow(rows, item);
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
      // 2026-09-11 (C-36): 가방 내구도 — 레이드마다 닳지만 0 이어도 격자는 그대로라 `파손` 이라 적지 않는다
      const max = def.durabilityMax;
      if (max !== undefined && max > 0) {
        const cur = Math.round(Math.max(0, Math.min(max, item.durability ?? max)));
        rows.push([b.durability, `${cur} / ${max}`, cur / max < DURABILITY_LOW ? 'is-low' : undefined]);
        this.pushBucketRow(rows, item);
      }
    }
    if (def.armorId) {
      const a = this.lookups.getArmorDef(def.armorId);
      const t = TEXT.armorStats;
      if (a) {
        // 2026-09-10: 방탄복은 피해를 깎지 않는다 — 실드(추가 체력)를 준다
        rows.push([t.shield, `+${Math.round(a.shield)}`]);
        const max = def.durabilityMax ?? a.durabilityMax;
        rows.push([t.durability, `${Math.round(Math.max(0, Math.min(max, item.durability ?? max)))} / ${max}`]);
        this.pushBucketRow(rows, item);
        if (a.perk !== 'none') rows.push([t.perk, a.description]);
      }
    }
    // Phase 12: a channelled consumable's 게이지 (회복 스프레이) — `0 / 200` is a valid, repairable state
    if (def.heal?.spray && def.durabilityMax !== undefined && def.durabilityMax > 0) {
      const max = def.durabilityMax;
      const cur = Math.round(Math.max(0, Math.min(max, item.durability ?? max)));
      const cls = cur <= 0 ? 'is-broken' : cur / max < DURABILITY_LOW ? 'is-low' : undefined;
      rows.push([TEXT.gauge, `${cur} / ${max}`, cls]);
    }
    // 2026-09-10: 실드 충전기 — 얼마나 채우는가 · 몇 초 눌러야 하는가
    const charge = shieldChargeOf(def.id);
    if (charge) {
      const t = TEXT.shieldChargeStats;
      rows.push([t.amount, Number.isFinite(charge.amount) ? `+${Math.round(charge.amount)}` : t.full]);
      rows.push([t.useTime, `${charge.useTime} s`]);
    }
    if (def.book) {
      const t = TEXT.bookStats;
      rows.push([t.skill, this.lookups.getSkillName?.(def.book.skill) ?? def.book.skill]);
      rows.push([t.use, t.shelf]);
    }
    // Phase 12: 임플란트 — slot cost + one line per stat bonus (`근력 +2`); a broken one has no bonuses to list
    const imp = def.implant;
    if (imp) {
      const t = TEXT.implantStats;
      rows.push([t.slots, `${imp.slots}`]);
      if (!imp.broken) {
        for (const [id, v] of Object.entries(imp.stats) as Array<[StatId, number | undefined]>) {
          if (!v) continue;
          const label = this.lookups.getStatName?.(id) ?? id;
          rows.push([label, `${v > 0 ? '+' : '−'}${Math.abs(v)}`, v > 0 ? 'is-bonus' : 'is-broken']);
        }
      }
    }
    if (def.healAmount) rows.push(['회복', `+${def.healAmount} HP`]);
    if (def.stackMax > 1) rows.push([TEXT.qty, `${item.qty} / ${def.stackMax}`]);

    if (rows.length > 0) {
      const table = document.createElement('div');
      table.className = 'inv-tt-stats';
      for (const [k, v, cls] of rows) {
        const kEl = document.createElement('span'); kEl.className = 'k'; kEl.textContent = k;
        const vEl = document.createElement('span'); vEl.className = cls ? `v ${cls}` : 'v'; vEl.textContent = v;
        table.append(kEl, vEl);
      }
      this.el.appendChild(table);
    }

    if (imp) {
      const t = TEXT.implantStats;
      // legendary perk: name + description from the shared table
      const perk = imp.perk ? PERK_DEFS[imp.perk] : undefined;
      if (perk && !imp.broken) {
        const p = document.createElement('p');
        p.className = 'inv-tt-perk';
        const k = document.createElement('span'); k.className = 'k'; k.textContent = t.perk;
        const n = document.createElement('span'); n.className = 'n'; n.textContent = perk.name;
        p.append(k, n, document.createTextNode(` — ${perk.description}`));
        this.el.appendChild(p);
      }
      if (imp.broken) {
        const b = document.createElement('div');
        b.className = 'inv-tt-broken';
        b.textContent = t.broken;
        this.el.appendChild(b);
        if (imp.repairCost && imp.repairCost.length > 0) {
          const host = document.createElement('div');
          host.className = 'inv-tt-repair';
          renderItemCost(host, imp.repairCost, (id) => this.lookups.getDef(id), (id) => this.lookups.countOwned?.(id) ?? 0, { size: 28 });
          this.el.appendChild(host);
        }
      }
    }

    if (weapon) this.el.appendChild(this.buildSocketRow(item));

    // Phase 10: 가치 is a bottom bar of the card (same shape as `ui/hud/ItemTip`'s). 2026-09-09: 무게 sits at its
    // left end (a stack's total), 가치 at the right — a stack shows `단가 × 수량` next to the total.
    const value = document.createElement('div');
    value.className = 'inv-tt-value';
    const qty = Math.max(1, item.qty);
    if (def.weight !== undefined) {
      const w = document.createElement('span');
      w.className = 'inv-tt-weight';
      const wk = document.createElement('span'); wk.className = 'k'; wk.textContent = TEXT.weight;
      const wv = document.createElement('span'); wv.className = 'v'; wv.textContent = fmtKg(def.weight * qty);
      w.append(wk, wv);
      value.appendChild(w);
    }
    const amount = document.createElement('span');
    amount.className = 'inv-tt-value-amount';
    const vk = document.createElement('span');
    vk.className = 'k';
    vk.textContent = TEXT.value;
    amount.appendChild(vk);
    if (def.stackMax > 1 && qty > 1) {
      const unit = document.createElement('span');
      unit.className = 'inv-tt-value-unit';
      unit.textContent = `${fmtValue(def.value)} × ${qty}`;
      const total = document.createElement('span');
      total.className = 'inv-tt-value-total';
      total.textContent = fmtValue(itemCreditValue(def, qty));
      amount.append(unit, total);
    } else {
      const total = document.createElement('span');
      total.className = 'inv-tt-value-total';
      total.textContent = fmtValue(itemCreditValue(def, 1));
      amount.appendChild(total);
    }
    value.appendChild(amount);
    this.el.appendChild(value);

    this.el.hidden = false;
    this.visible = true;
    this.move(x, y);
  }

  /* ── weapon card pieces (2026-09-09) ──────────────────────────────────── */

  /**
   * Catalog maxima of the four gauge stats, read once: every weapon item def → its bare graded stats
   * (`getBaseStats`, sockets excluded) and its `WeaponDef` (pellets, range). A missing lookup leaves a maximum at 0
   * and `buildGauges` falls back to the card's own value, so a bar can never overflow and a lone card reads full.
   */
  private gaugeMaxima(): GaugeMaxima {
    if (this.maxima) return this.maxima;
    const m: GaugeMaxima = { damage: 0, fireRate: 0, recoil: 0, range: 0 };
    const defs = this.lookups.allWeaponItemDefs?.() ?? [];
    for (const d of defs) {
      if (!d.weaponId) continue;
      const w = this.lookups.getWeapon(d.weaponId);
      const s = w ? this.lookups.getBaseStats?.(d.id) : null;
      if (!w || !s) continue;
      const v = gaugeValues(w, s);
      m.damage = Math.max(m.damage, v.damage);
      m.fireRate = Math.max(m.fireRate, v.fireRate);
      m.recoil = Math.max(m.recoil, v.recoil);
      m.range = Math.max(m.range, v.range);
    }
    this.maxima = m;
    return m;
  }

  private buildGauges(def: ItemDef, weapon: WeaponDef, stats: EffectiveWeaponStats): HTMLElement {
    const max = this.gaugeMaxima();
    const base = gaugeValues(weapon, this.lookups.getBaseStats?.(def.id) ?? stats);
    const eff = gaugeValues(weapon, stats);
    const s = TEXT.weaponStats;
    const grid = document.createElement('div');
    grid.className = 'inv-tt-gauges';
    const pellets = weapon.pellets ?? 1;
    const dmgText = pellets > 1 ? `${stats.damage}×${pellets}` : `${stats.damage}`;
    grid.append(
      this.buildGauge(s.damage, base.damage, eff.damage, max.damage, dmgText),
      this.buildGauge(s.fireRate, base.fireRate, eff.fireRate, max.fireRate, `${stats.fireRate} /s`),
      this.buildGauge(s.recoil, base.recoil, eff.recoil, max.recoil, fmtDeg(stats.recoilV)),
      this.buildGauge(s.range, base.range, eff.range, max.range, `${eff.range} m`),
    );
    return grid;
  }

  /**
   * One gauge cell: label, two-layer bar, small number. `base` is the bare def value (white), `eff` the socketed one:
   * `eff > base` adds a green `.bonus` segment on top of the white fill, `eff < base` shrinks the white fill to
   * `eff` and outlines the removed `eff..base` span with a hollow `.reduced` box. Fill = value / catalog max.
   */
  private buildGauge(label: string, base: number, eff: number, max: number, text: string): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'inv-tt-gauge';
    const k = document.createElement('span'); k.className = 'k'; k.textContent = label;
    const n = document.createElement('span'); n.className = 'n'; n.textContent = text;
    const track = document.createElement('div');
    track.className = 'track';
    const scale = Math.max(max, base, eff, 1e-9);
    const pct = (v: number): number => Math.max(0, Math.min(100, (v / scale) * 100));
    const fill = document.createElement('i');
    fill.className = 'fill';
    fill.style.width = `${pct(Math.min(base, eff))}%`;
    track.appendChild(fill);
    if (eff > base + 1e-9) {
      const bonus = document.createElement('i');
      bonus.className = 'bonus';
      bonus.style.left = `${pct(base)}%`;
      bonus.style.width = `${pct(eff) - pct(base)}%`;
      track.appendChild(bonus);
      cell.classList.add('is-bonus');
    } else if (eff < base - 1e-9) {
      const reduced = document.createElement('i');
      reduced.className = 'reduced';
      reduced.style.left = `${pct(eff)}%`;
      reduced.style.width = `${pct(base) - pct(eff)}%`;
      track.appendChild(reduced);
      cell.classList.add('is-reduced');
    }
    cell.append(k, track, n);
    return cell;
  }

  /** Ammo calibre thumbnail (head, right corner): the ammo item's glyph in its colour, the calibre name as a caption. */
  private buildAmmoThumb(type: AmmoType): HTMLElement {
    const ammo = this.lookups.findAmmoDef?.(type);
    const thumb = document.createElement('div');
    thumb.className = ammo ? 'inv-tt-ammo' : 'inv-tt-ammo is-unknown';
    thumb.title = `${TEXT.weaponStats.ammo}: ${ammoTypeLabel(type)}`;
    if (ammo) {
      thumb.style.setProperty('--ic', ammo.color);
      const icon = document.createElement('span');
      icon.className = 'ico';
      icon.textContent = ammo.icon;
      thumb.appendChild(icon);
    }
    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = ammoTypeLabel(type);
    thumb.appendChild(cap);
    return thumb;
  }

  /** The five sockets as a row of small squares: attachment glyph + rarity border, or a dashed empty square. */
  private buildSocketRow(item: ItemInstance): HTMLElement {
    const row = document.createElement('div');
    row.className = 'inv-tt-sockets';
    for (const s of SOCKET_SLOTS) {
      const att = item.sockets?.[s];
      const attDef = att ? this.lookups.getDef(att.defId) : undefined;
      const sq = document.createElement('div');
      sq.className = attDef ? 'inv-tt-sock is-filled' : 'inv-tt-sock';
      sq.title = socketTip(s, attDef?.name);
      if (attDef) {
        sq.style.setProperty('--ic', attDef.color);
        sq.style.setProperty('--sc', rarityColor(attDef));
        const icon = document.createElement('span');
        icon.className = 'ico';
        icon.textContent = attDef.icon;
        sq.appendChild(icon);
      } else {
        const cap = document.createElement('span');
        cap.className = 'cap';
        cap.textContent = socketAbbr(s);
        sq.appendChild(cap);
      }
      row.appendChild(sq);
    }
    return row;
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
