import type { AmmoType, ArmorDef, EffectiveWeaponStats, ItemDef, ItemInstance, MealBuff, MealDef, MealEffect, SkillId, StatId, WeaponDef } from '@/shared';
import { PERK_DEFS, SOCKET_LABEL_KO, itemCreditValue, renderItemCost } from '@/shared';
/*
 * 2026-09-16 (user's bug report 「기업 화면의 총 카드가 가방 카드와 다르다」): the **numbers and sentences** a weapon
 * card reads are made by `shared/weaponTip` alone — this card paints them as gauge bars, the chip card
 * (`ui/hud/ItemTip`) as table rows. Computing them again here would split the two cards apart.
 */
import { weaponGaugeTexts, weaponGaugeValues, weaponTipRows, type WeaponGaugeValues } from '@/shared';
/* 2026-09-13 (meal quality · cook steps): the same meal rows as `ui/hud/ItemTip` — that folder's `hud/mealText` cannot be imported, so a small copy sits below */
import {
  COOK_GAME_LABEL_KO, MEAL_BUFF_LABEL_KO, MEAL_BUFF_UNIT, MEAL_TIER_LABEL_KO, cookStepsOf, mealQualityBonus, mealQualityStars, normalizeMealQuality,
} from '@/shared';

/* ── 2026-09-13: meal row formatting (the original rule is `ui/hud/mealText` — the sentences must match) ───────────── */
/** `+15 %` · `+6 kg` · `+20` — the unit is decided by `MEAL_BUFF_UNIT` alone (only `'%'` scales by 100). */
function mealAmountText(buff: MealBuff, amount: number): string {
  const unit = MEAL_BUFF_UNIT[buff] ?? '';
  const n = Math.round((unit === '%' ? amount * 100 : amount) * 10) / 10;
  const mag = Math.abs(n);
  return `${n < 0 ? '−' : '+'}${Number.isInteger(mag) ? String(mag) : mag.toFixed(1)}${unit ? ` ${unit}` : ''}`;
}
/** Every stat row of a meal × `(1 + mealQualityBonus(quality))` — an old def with no `effects` is one `buff` · `amount` row. */
function mealEffectsFor(meal: MealDef, quality: number): MealEffect[] {
  const list = (meal as Partial<MealDef>).effects;
  const base: readonly MealEffect[] = Array.isArray(list) && list.length > 0 ? list : meal.buff ? [{ buff: meal.buff, amount: meal.amount }] : [];
  const mul = 1 + mealQualityBonus(quality);
  return base.map((e) => ({ buff: e.buff, amount: e.amount * mul }));
}
const COOK_STEP_MARK = ['①', '②', '③', '④', '⑤'];
/** `① 썰기 → ② 젓기` — an empty string when it is not a cook-bench meal. */
function cookStepsLine(defId: string): string {
  return cookStepsOf(defId).map((s, i) => `${COOK_STEP_MARK[i] ?? `${i + 1}.`} ${COOK_GAME_LABEL_KO[s.game] ?? s.game}`).join(' → ');
}
/* 2026-09-15 (the gadget rework): the description's inline markup · the spec rows are made by `@/items` alone — the **same function** as the chip card (`ui/hud/ItemTip`). */
import type { SpecSeg, SpecValue } from '@/items';
import { WEAPON_CLASS_LABEL_KO, itemSpecRows, parseItemText } from '@/items';
import { bagCapacityBonus } from '../Gear';
import {
  DURABILITY_LOW, TEXT, ammoTypeLabel, fmtKg, fmtMul, fmtValue, rarityColor, rarityLabel,
  socketTip, weaponClassLabel,
} from './labels';
/* appended (2026-09-16, the collectible super category): the category line under the name can read two levels deep (`수집품 > 서적`) — the same function as the chip card (`ui/hud/ItemTip`) */
import { categoryPathKo } from '@/shared';
/* 2026-09-14: only the sockets it accepts · the durability gauge colour — the same functions as the tile */
import { setDurabilityColorVars, shownSockets } from './GridView';

export interface TooltipLookups {
  getWeapon(weaponId: string): WeaponDef | undefined;
  getDef(defId: string): ItemDef | undefined;
  /** Graded + socketed numbers for a weapon instance (null for non-weapons). */
  getStats(item: ItemInstance): EffectiveWeaponStats | null;
  /** appended: tactical kit — armor plate data for 'armor' items. */
  getArmorDef(armorId: string): ArmorDef | undefined;
  /** appended (Phase 9): Korean skill name for a 서적 (`ItemDef.book.skill`); the id when progression is not around. */
  getSkillName?(id: SkillId): string;
  /** appended (Phase 12): Korean stat name for an implant bonus line (`ItemDef.implant.stats`); the id as a fallback. */
  getStatName?(id: StatId): string;
  /** appended (Phase 12): units of `defId` the player owns (bag + stash) — the held / needed split of the repair-cost chips. */
  countOwned?(defId: string): number;
  /**
   * appended (2026-09-09, the gauge tooltip): the **bare** graded def stats of a weapon item def — no sockets
   * (`LootRef.getEffectiveStats(defId)`). The white layer of a gauge; `getStats(item)` is the socketed layer.
   */
  getBaseStats?(defId: string): EffectiveWeaponStats | null;
  /** appended (2026-09-09): every weapon item def in the catalog — the gauge maxima are read off these once. */
  allWeaponItemDefs?(): ItemDef[];
  /** appended (2026-09-09): the ammo item (`category 'ammo'`) of a calibre — the thumbnail in the card's corner. */
  findAmmoDef?(type: AmmoType): ItemDef | undefined;
}

/** Catalog maxima the weapon gauges are normalised against (computed lazily, once per Tooltip). */
interface GaugeMaxima { damage: number; fireRate: number; recoil: number; range: number }

/** The four gauge stats of one weapon (`damage` already × pellets, `recoil` in radians, `range` in metres). */
type GaugeValues = WeaponGaugeValues;

/**
 * Hover card: name, category · rarity, description, value, size and — for weapons — the effective stats
 * (grade / sockets folded in), durability and the five sockets; attachments list their effects, bags their grid.
 * Phase 12: implants (`ItemDef.implant`) show 장착칸 / one line per stat bonus / the legendary perk, and a broken one
 * a red 망가짐 line with its 세레스 바이오 repair cost as item chips; a 회복 스프레이 shows its gauge (`durability` /
 * `durabilityMax`, `0 / 200` included — an empty can is still an item).
 *
 * 2026-09-09 (the weapon card redesign): the numeric 대미지 / 연사 / 반동 / 사거리 rows became a **2×2 gauge grid**
 * (`.inv-tt-gauges`) normalised against the catalog maximum of each stat, with the raw number kept small at the
 * right. Every bar has two layers — the bare def value (`getBaseStats`, white) and the socketed value (`getStats`):
 * a socket that raises a stat paints the extra segment green (`.bonus`), one that lowers it (a muzzle brake on
 * recoil) shrinks the white fill and leaves the removed segment as a hollow green outline (`.reduced`). The ammo
 * calibre is an item-chip-like **thumbnail** in the head's right corner, the five sockets are a **row of small
 * squares** (attachment glyph, rarity border; empty = dashed + socket abbreviation), and the bottom bar reads
 * weight on the left and value on the right for every item. 종류 / 등급 / 탄창 / 정조준 시간 / 재장전 / 크기 rows are gone.
 *
 * **2026-09-12 (user's decision)** — three things:
 *  - **Durability is one gauge row** — the rule and the reason live above `buildDurabilityBar` (the one place).
 *  - **A bag** carries one more row, 「소지 한계 +N kg」 (`Gear.bagCapacityBonus` — the **same formula** as the weight sum).
 *  - **Armor**'s `특성` row is not raised when its text equals the description paragraph (a unique's description *is* the perk sentence).
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
   * **2026-09-12 (user's decision) — durability is a gauge, not a number row.** It uses the same `.track` / `.fill`
   * markup as the weapon's 2×2 gauges (`buildGauge`), but **one row at full width**, and only the fill colour is decided
   * by the fraction left (`is-low` under `DURABILITY_LOW` · `is-broken` at 0). The weapon · bag · armor · 회복 스프레이 gauges all call
   * this one, so the same value has the same shape anywhere on screen. In that same pass the `구간` row under it
   * (2026-09-11 C-37) went — the repair · salvage buckets are already said by `ui/RepairPanel` and `ui/DisassemblePanel`.
   */
  private buildDurabilityBar(label: string, cur: number, max: number, brokenLabel?: string): HTMLElement {
    const safeMax = Math.max(1, max);
    const value = Math.max(0, Math.min(safeMax, cur));
    const ratio = value / safeMax;
    const cell = document.createElement('div');
    cell.className = 'inv-tt-gauge inv-tt-durbar';
    if (value <= 0) cell.classList.add('is-broken');
    else if (ratio < DURABILITY_LOW) cell.classList.add('is-low');
    setDurabilityColorVars(cell, ratio);   // 2026-09-14: fill colour = the tile gauge's green → yellow → orange → red
    const k = document.createElement('span'); k.className = 'k'; k.textContent = label;
    const n = document.createElement('span'); n.className = 'n';
    n.textContent = value <= 0 && brokenLabel ? `${brokenLabel} · 0 / ${safeMax}` : `${Math.round(value)} / ${safeMax}`;
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('i');
    fill.className = 'fill';
    fill.style.width = `${Math.round(ratio * 100)}%`;
    track.appendChild(fill);
    cell.append(k, track, n);
    return cell;
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
    // 2026-09-15: a unique shows **its own class** (`컴포짓 보우 · 신화`), not `무기` — its name is one nickname, so the class reads only here
    // 2026-09-16: everything else reads down to the super category (`수집품 > 서적`) — `shared/labels.categoryPathKo`
    sub.textContent = `${weapon?.unique ? weaponClassLabel(weapon) : categoryPathKo(def.category)} · ${rarityLabel(def)}`;
    headText.append(name, sub);
    head.appendChild(headText);
    if (stats) head.appendChild(this.buildAmmoThumb(stats.ammoType));
    this.el.appendChild(head);

    this.el.appendChild(this.buildDesc(def.description));

    if (weapon && stats) this.el.appendChild(this.buildGauges(def, weapon, stats));

    /** 2026-09-15: a value is either one whole string or a list of segments (`SpecSeg[]`) — rows appeared where only the number keeps the body colour. */
    const rows: Array<[string, SpecValue, string?]> = [];
    /** 2026-09-12: this item's durability (or gauge) as one gauge row. Only where the maximum comes from differs per def; the drawing is one. */
    let durBar: HTMLElement | null = null;
    if (weapon && stats) {
      const s = TEXT.weaponStats;
      /* 2026-09-16: reload · fire mode · zoom come from `shared/weaponTip` (same sentences as the chip card). The calibre is
         the head's thumbnail, durability the gauge below, the sockets a row of squares — this card takes none of them as rows. */
      for (const r of weaponTipRows(weapon, stats, { item })) rows.push([r.k, r.v]);
      const max = Math.max(1, stats.maxDurability);
      durBar = this.buildDurabilityBar(s.durability, item.durability ?? max, max, TEXT.broken);
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
      /*
       * 2026-09-12 — **「소지 한계 +N kg」.** The weight a bag adds is decided by `Gear.bagCapacityBonus` alone
       * (`data/tuning.csv`'s `BAG_CAPACITY_PER_CELL` × the cells beyond the default grid) and this row calls that function —
       * copying the number here goes out of step the next time the table changes. A bag below the default grid gives 0, so no row.
       */
      const capBonus = bagCapacityBonus(def.bag);
      if (capBonus > 0) rows.push([b.capacity, `+${fmtKg(capBonus)}`]);
      // 2026-09-11 (C-36): bag durability — it wears every raid, but the grid is unchanged at 0, so it is not labelled `파손`
      const max = def.durabilityMax;
      if (max !== undefined && max > 0) durBar = this.buildDurabilityBar(b.durability, item.durability ?? max, max);
    }
    if (def.armorId) {
      const a = this.lookups.getArmorDef(def.armorId);
      const t = TEXT.armorStats;
      if (a) {
        // 2026-09-10: armor does not cut damage — it gives a shield (extra hp)
        rows.push([t.shield, `+${Math.round(a.shield)}`]);
        /*
         * 2026-09-12 — **The perk sentence appears exactly once.** `ItemDef.description` takes `ArmorDef.description` verbatim
         * (`items/ItemDefs`), and a unique armor's sentence *is* its perk description — writing it into the `특성` row would
         * print **literally the same line** twice under the description paragraph. So the row is raised only when they differ.
         */
        if (a.perk !== 'none' && a.description !== def.description) rows.push([t.perk, a.description]);
        const max = def.durabilityMax ?? a.durabilityMax;
        durBar = this.buildDurabilityBar(t.durability, item.durability ?? max, max, TEXT.broken);
      }
    }
    // Phase 12: a channelled consumable's gauge (회복 스프레이) — `0 / 200` is a valid, repairable state
    if (def.heal?.spray && def.durabilityMax !== undefined && def.durabilityMax > 0) {
      const max = def.durabilityMax;
      durBar = this.buildDurabilityBar(TEXT.gauge, item.durability ?? max, max);
    }
    /*
     * 2026-09-15 (the gadget rework, user's decision) — the specs of healing items · shield chargers · combat consumables ·
     * gadgets · grenades are made by **`items/ItemSpec.itemSpecRows` alone** (the same function and sentences as the chip
     * card `ui/hud/ItemTip`). `사용 시간` is always first, the old `지속 소모` row is gone, and those numbers were stripped
     * out of the description text. The shield-charger and combat-consumable blocks that used to sit here folded into these
     * three lines (2026-09-19: their `TEXT` label tables went with them — nothing read them any more).
     */
    for (const r of itemSpecRows(def)) {
      rows.push([r.k, r.v, r.tone === 'good' ? 'is-bonus' : r.tone === 'bad' ? 'is-broken' : undefined]);
    }
    /* 2026-09-15: gadgets that carry durability (dome shield · barricade) — the same one gauge row as weapon · bag · armor. */
    if (def.category === 'gadget' && def.durabilityMax !== undefined && def.durabilityMax > 0) {
      const max = def.durabilityMax;
      durBar = this.buildDurabilityBar(TEXT.bagStats.durability, item.durability ?? max, max, TEXT.broken);
    }
    // 2026-09-12 (A-3e): discs · records get the same two rows as a book; only the holder named in the use row differs
    const media = def.book ?? def.disc ?? def.record;
    if (media) {
      const t = TEXT.bookStats;
      rows.push([t.skill, this.lookups.getSkillName?.(media.skill) ?? media.skill]);
      rows.push([t.use, def.book ? t.shelf : def.disc ? t.discShelf : t.recordShelf]);
    }
    // Phase 12: implants — slot cost + one line per stat bonus (`근력 +2`); a broken one has no bonuses to list
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
    /* 2026-09-13 (meal quality · cook steps): the same rows as `ui/hud/ItemTip`'s meal block — 구분 · 품질 (instance quality > 0 only) ·
       사용 · the stats (quality bonus folded in) · 조리 (cook-bench meals only). This card always holds an instance, so quality is `item.quality`. */
    const meal = def.meal;
    if (meal) {
      const tier = def.retired ? '' : (MEAL_TIER_LABEL_KO[meal.tier] ?? '');
      if (tier) rows.push(['구분', tier]);
      const quality = normalizeMealQuality(item.quality);
      if (quality > 0) rows.push(['품질', `${mealQualityStars(quality)} +${Math.round(mealQualityBonus(quality) * 100)} %`, 'is-quality']);
      rows.push(['사용', '다음 레이드 1회분']);
      for (const e of mealEffectsFor(meal, quality)) rows.push([MEAL_BUFF_LABEL_KO[e.buff] ?? '효과', mealAmountText(e.buff, e.amount), 'is-bonus']);
      const steps = cookStepsLine(def.id);
      if (steps) rows.push(['조리', steps]);
    }
    // 2026-09-15: the old `회복 +N HP` row is replaced by `itemSpecRows`' 「5초간 매 초 HP 4 회복, 총 20 회복」
    if (def.stackMax > 1) rows.push([TEXT.qty, `${item.qty} / ${def.stackMax}`]);

    if (rows.length > 0) {
      const table = document.createElement('div');
      table.className = 'inv-tt-stats';
      for (const [k, v, cls] of rows) {
        const kEl = document.createElement('span'); kEl.className = 'k'; kEl.textContent = k;
        const vEl = document.createElement('span'); vEl.className = cls ? `v ${cls}` : 'v';
        if (typeof v === 'string') vEl.textContent = v;
        else for (const seg of v) vEl.appendChild(this.buildSeg(seg));
        table.append(kEl, vEl);
      }
      this.el.appendChild(table);
    }
    // 2026-09-12: the durability gauge is one row **directly under** the stat table — a full-width bar outside the table's two-column grid
    if (durBar) this.el.appendChild(durBar);

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

    if (weapon && stats) {
      const row = this.buildSocketRow(item, stats);
      if (row) this.el.appendChild(row);
    }

    // Phase 10: value is a bottom bar of the card (same shape as `ui/hud/ItemTip`'s). 2026-09-09: weight sits at its
    // left end (a stack's total), value at the right — a stack shows unit price × quantity next to the total.
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

  /* ── 2026-09-15 (the gadget rework): description markup · value segments ──────── */

  /**
   * The description paragraph. `data/items.csv`'s `description` may use `{em}…{/em}` · `{dim}…{/dim}` · `{br}` tokens and
   * **one** place resolves them — `items/ItemText.parseItemText` (the chip card too). Only the colours are this card's palette.
   */
  private buildDesc(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'inv-tt-desc';
    const lines = parseItemText(text);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) p.appendChild(document.createElement('br'));
      for (const s of lines[i]) {
        const sp = document.createElement('span');
        sp.textContent = s.text;
        if (s.style === 'em') sp.style.color = 'var(--inv-accent)';
        else if (s.style === 'dim') sp.style.color = 'var(--inv-muted)';
        p.appendChild(sp);
      }
    }
    return p;
  }

  /** One value segment — only a dim segment takes an inline colour (numbers keep the body colour). */
  private buildSeg(seg: SpecSeg): HTMLElement {
    const sp = document.createElement('span');
    sp.textContent = seg.text;
    if (seg.dim) sp.style.color = 'var(--inv-muted)';
    return sp;
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
      const v = weaponGaugeValues(w, s);
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
    const base = weaponGaugeValues(weapon, this.lookups.getBaseStats?.(def.id) ?? stats);
    const eff = weaponGaugeValues(weapon, stats);
    // 2026-09-16: the small number beside a gauge is a `shared/weaponTip` sentence too — it must read exactly as the chip card's row
    const text = weaponGaugeTexts(weapon, stats);
    const s = TEXT.weaponStats;
    const grid = document.createElement('div');
    grid.className = 'inv-tt-gauges';
    grid.append(
      this.buildGauge(s.damage, base.damage, eff.damage, max.damage, text.damage),
      this.buildGauge(s.fireRate, base.fireRate, eff.fireRate, max.fireRate, text.fireRate),
      this.buildGauge(s.recoil, base.recoil, eff.recoil, max.recoil, text.recoil),
      this.buildGauge(s.range, base.range, eff.range, max.range, text.range),
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

  /**
   * The weapon's sockets as a **centred** row of small squares: attachment glyph + rarity border, or a dashed empty square
   * with the socket's Korean name (`SOCKET_LABEL_KO`). 2026-09-14 (user's decision): only the sockets the weapon accepts
   * (`shownSockets` — the same list as the tile's pips); null when it accepts none. Every square carries `data-socket` —
   * the pinned card (`ui/TipPin`) shows the attachment's own card on hover and drags it out from there.
   */
  private buildSocketRow(item: ItemInstance, stats: EffectiveWeaponStats): HTMLElement | null {
    const socks = shownSockets(item, stats);
    if (socks.length === 0) return null;
    const row = document.createElement('div');
    row.className = 'inv-tt-sockets';
    for (const s of socks) {
      const att = item.sockets?.[s];
      const attDef = att ? this.lookups.getDef(att.defId) : undefined;
      const sq = document.createElement('div');
      sq.className = attDef ? 'inv-tt-sock is-filled' : 'inv-tt-sock';
      sq.dataset.socket = s;
      // the pinned card shows the attachment's own card on hover — a native `title` would pop up on top of it
      if (!attDef) sq.title = socketTip(s);
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
        cap.textContent = SOCKET_LABEL_KO[s];   // 2026-09-14: the full name (`개머리판`), not the two-letter abbreviation
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

  /** Whether the card is up (2026-09-15 — `InventoryUI.validateHover` only hit-tests while it is). */
  get isShowing(): boolean { return this.visible; }

  dispose(): void { this.el.remove(); }
}
