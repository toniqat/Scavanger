import type { AmmoType, ArmorDef, EffectiveWeaponStats, ItemDef, ItemInstance, MealBuff, MealDef, MealEffect, SkillId, StatId, WeaponDef } from '@/shared';
import { PERK_DEFS, SOCKET_LABEL_KO, SOCKET_SLOTS, itemCreditValue, renderItemCost } from '@/shared';
/* 2026-09-13 (요리 품질 · 조리 단계): `ui/hud/ItemTip` 과 같은 요리 줄 — 그 폴더의 `hud/mealText` 는 import 할 수 없어 아래에 작게 한 벌 */
import {
  COOK_GAME_LABEL_KO, MEAL_BUFF_LABEL_KO, MEAL_BUFF_UNIT, MEAL_TIER_LABEL_KO, cookStepsOf, mealQualityBonus, mealQualityStars, normalizeMealQuality,
} from '@/shared';

/* ── 2026-09-13: 요리 줄 포맷 (원본 규칙은 `ui/hud/mealText` — 같은 문장이어야 한다) ───────────────────────────────── */
/** `+15 %` · `+6 kg` · `+20` — 단위는 `MEAL_BUFF_UNIT` 하나가 정한다 (`'%'` 만 100 배). */
function mealAmountText(buff: MealBuff, amount: number): string {
  const unit = MEAL_BUFF_UNIT[buff] ?? '';
  const n = Math.round((unit === '%' ? amount * 100 : amount) * 10) / 10;
  const mag = Math.abs(n);
  return `${n < 0 ? '−' : '+'}${Number.isInteger(mag) ? String(mag) : mag.toFixed(1)}${unit ? ` ${unit}` : ''}`;
}
/** 요리의 능력치 줄 전부 × `(1 + mealQualityBonus(quality))` — `effects` 가 없는 옛 def 는 `buff` · `amount` 한 줄. */
function mealEffectsFor(meal: MealDef, quality: number): MealEffect[] {
  const list = (meal as Partial<MealDef>).effects;
  const base: readonly MealEffect[] = Array.isArray(list) && list.length > 0 ? list : meal.buff ? [{ buff: meal.buff, amount: meal.amount }] : [];
  const mul = 1 + mealQualityBonus(quality);
  return base.map((e) => ({ buff: e.buff, amount: e.amount * mul }));
}
const COOK_STEP_MARK = ['①', '②', '③', '④', '⑤'];
/** `① 썰기 → ② 젓기` — 조리대 요리가 아니면 빈 문자열. */
function cookStepsLine(defId: string): string {
  return cookStepsOf(defId).map((s, i) => `${COOK_STEP_MARK[i] ?? `${i + 1}.`} ${COOK_GAME_LABEL_KO[s.game] ?? s.game}`).join(' → ');
}
import {
  BOOST_ADRENALINE_DURATION_S, BOOST_STIMULANT_ADS_SPEED_MUL, BOOST_STIMULANT_AIM_SWAY_MUL, BOOST_STIMULANT_DURATION_S,
  BOOST_STIMULANT_RELOAD_SPEED_MUL, BOOST_STIMULANT_STAMINA_COST_MUL,
} from '@/shared';
import { WEAPON_CLASS_LABEL_KO, boostItemOf, shieldChargeOf } from '@/items';
import { bagCapacityBonus } from '../Gear';
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
 *
 * **2026-09-12 (사용자 결정)** — 세 가지:
 *  - **내구도는 게이지 한 줄**(`buildDurabilityBar`, `.inv-tt-durbar`)이다. 무기 · 가방 · 방탄복 · 회복 스프레이가
 *    같은 함수를 부르므로 같은 값이 어디서나 같은 모양이고, 그 아래 있던 `구간` 줄(C-37)은 **사라졌다** —
 *    수리 · 분해 구간은 그 팝업들이 자기 자리에서 말한다.
 *  - **가방**은 「소지 한계 +N kg」 한 줄을 더 갖는다 (`Gear.bagCapacityBonus` — 무게 계산과 **같은 식**).
 *  - **방탄복**의 `특성` 행은 설명 문단과 글자가 같으면 서지 않는다 (유니크 description 이 곧 퍽 문장이다).
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
   * **2026-09-12 (사용자 결정) — 내구도는 숫자 줄이 아니라 게이지다.** 무기 2×2 게이지(`buildGauge`)와 같은
   * `.track` / `.fill` 마크업을 쓰되 **한 줄 전체 폭**이고, 채움 색만 남은 비율이 정한다 (`is-low` 30 % 미만 ·
   * `is-broken` 0). 무기 · 가방 · 방탄복 · 회복 스프레이 게이지가 전부 이 하나를 부르므로 같은 값이 화면 어디서나
   * 같은 모양이다. 같은 배치에서 그 아래 `구간` 줄(2026-09-11 C-37)은 사라졌다 — 수리 · 분해의 구간 안내는
   * 수리 팝업(`ui/RepairPanel`)과 분해 팝업(`ui/DisassemblePanel`)이 이미 자기 자리에서 말한다.
   */
  private buildDurabilityBar(label: string, cur: number, max: number, brokenLabel?: string): HTMLElement {
    const safeMax = Math.max(1, max);
    const value = Math.max(0, Math.min(safeMax, cur));
    const ratio = value / safeMax;
    const cell = document.createElement('div');
    cell.className = 'inv-tt-gauge inv-tt-durbar';
    if (value <= 0) cell.classList.add('is-broken');
    else if (ratio < DURABILITY_LOW) cell.classList.add('is-low');
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
    /** 2026-09-12: 이 아이템의 내구도(또는 게이지) 한 줄 게이지. 종류마다 최대치의 출처만 다르고 그림은 하나다. */
    let durBar: HTMLElement | null = null;
    if (weapon && stats) {
      const s = TEXT.weaponStats;
      rows.push([s.loaded, `${Math.max(0, item.ammoInMag ?? 0)} / ${stats.magSize}`]);
      rows.push([s.mode, weapon.automatic ? TEXT.auto : TEXT.semi]);
      if (stats.adsZoom > 1 || stats.scope) rows.push([s.zoom, `${stats.adsZoom}×${stats.scope ? ' · 스코프' : ''}`]);
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
       * 2026-09-12 — **소지 한계 +N kg.** 가방이 늘려 주는 무게는 `Gear.bagCapacityBonus` 하나가 정하고
       * (`data/tuning.csv` 의 `BAG_CAPACITY_PER_CELL` × 기본 격자를 넘는 칸 수) 이 줄은 그 함수를 그대로 부른다 —
       * 숫자를 여기 베껴 적으면 표를 고칠 때 글이 어긋난다. 기본 격자보다 작은 가방은 0 이라 줄 자체가 없다.
       */
      const capBonus = bagCapacityBonus(def.bag);
      if (capBonus > 0) rows.push([b.capacity, `+${fmtKg(capBonus)}`]);
      // 2026-09-11 (C-36): 가방 내구도 — 레이드마다 닳지만 0 이어도 격자는 그대로라 `파손` 이라 적지 않는다
      const max = def.durabilityMax;
      if (max !== undefined && max > 0) durBar = this.buildDurabilityBar(b.durability, item.durability ?? max, max);
    }
    if (def.armorId) {
      const a = this.lookups.getArmorDef(def.armorId);
      const t = TEXT.armorStats;
      if (a) {
        // 2026-09-10: 방탄복은 피해를 깎지 않는다 — 실드(추가 체력)를 준다
        rows.push([t.shield, `+${Math.round(a.shield)}`]);
        /*
         * 2026-09-12 — **퍽 문장은 한 번만.** `ItemDef.description` 은 `ArmorDef.description` 을 그대로 받아온
         * 값이고(`items/ItemDefs`), 유니크 방탄복의 그 문장이 곧 퍽 효과 설명이 됐다 — `특성` 행에 다시 적으면
         * 위의 설명 문단과 **글자 그대로 같은 줄**이 두 번 나온다. 그래서 둘이 다를 때만 행을 세운다.
         */
        if (a.perk !== 'none' && a.description !== def.description) rows.push([t.perk, a.description]);
        const max = def.durabilityMax ?? a.durabilityMax;
        durBar = this.buildDurabilityBar(t.durability, item.durability ?? max, max, TEXT.broken);
      }
    }
    // Phase 12: a channelled consumable's 게이지 (회복 스프레이) — `0 / 200` is a valid, repairable state
    if (def.heal?.spray && def.durabilityMax !== undefined && def.durabilityMax > 0) {
      const max = def.durabilityMax;
      durBar = this.buildDurabilityBar(TEXT.gauge, item.durability ?? max, max);
    }
    // 2026-09-10: 실드 충전기 — 얼마나 채우는가 · 몇 초 눌러야 하는가
    const charge = shieldChargeOf(def.id);
    if (charge) {
      const t = TEXT.shieldChargeStats;
      rows.push([t.amount, Number.isFinite(charge.amount) ? `+${Math.round(charge.amount)}` : t.full]);
      rows.push([t.useTime, `${charge.useTime} s`]);
    }
    // 2026-09-12: 전투 소모품 3종 (아드레날린 · 각성제 · 안정제) — 효과 줄 · 지속 시간 · 사용 시간 (수치는 csv 의 BOOST_*)
    const boost = boostItemOf(def.id);
    if (boost) {
      const t = TEXT.boostStats;
      const up = (mul: number): string => `+${Math.round((mul - 1) * 100)} %`;
      if (boost.effect === 'adrenaline') {
        rows.push([t.stamina, t.staminaFull, 'is-bonus']);
        rows.push([t.drain, t.drainNone, 'is-bonus']);
        rows.push([t.duration, `${BOOST_ADRENALINE_DURATION_S} s`]);
      } else if (boost.effect === 'stimulant') {
        rows.push([t.reload, up(BOOST_STIMULANT_RELOAD_SPEED_MUL), 'is-bonus']);
        rows.push([t.ads, up(BOOST_STIMULANT_ADS_SPEED_MUL), 'is-bonus']);
        rows.push([t.sway, `−${Math.round((1 - BOOST_STIMULANT_AIM_SWAY_MUL) * 100)} %`, 'is-bonus']);
        rows.push([t.staminaCost, up(BOOST_STIMULANT_STAMINA_COST_MUL), 'is-broken']);
        rows.push([t.duration, `${BOOST_STIMULANT_DURATION_S} s`]);
      } else {
        rows.push([t.implant, t.implantFull, 'is-bonus']);
      }
      rows.push([t.useTime, `${boost.useTime} s`]);
    }
    // 2026-09-12 (A-3e): 디스크 · 레코드는 책과 같은 두 줄, 용도만 꽂는 보관함 이름이 다르다
    const media = def.book ?? def.disc ?? def.record;
    if (media) {
      const t = TEXT.bookStats;
      rows.push([t.skill, this.lookups.getSkillName?.(media.skill) ?? media.skill]);
      rows.push([t.use, def.book ? t.shelf : def.disc ? t.discShelf : t.recordShelf]);
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
    /* 2026-09-13 (요리 품질 · 조리 단계): `ui/hud/ItemTip` 의 요리 블록과 같은 줄 — 구분 · 품질(인스턴스 품질 > 0 일 때만) · 사용 ·
       능력치(품질 보너스 반영) · 조리 순서(조리대 요리만). 이 카드는 언제나 인스턴스를 들고 있으므로 품질은 `item.quality` 다. */
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
    // 2026-09-12: 내구도 게이지는 수치 표 **바로 아래** 한 줄 — 표의 두 칸 격자에 들어가지 않는 전체 폭 막대다
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
