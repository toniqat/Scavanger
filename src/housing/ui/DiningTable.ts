import type { GameContext, MealBuff, MealDef, MealEffect, TablePlateInfo } from '@/shared';
import {
  MEAL_BUFF_LABEL_KO, MEAL_BUFF_UNIT, MEAL_TIER_LABEL_KO, buildItemChip, getMealDef, mealQualityBonus, mealQualityStars, normalizeMealQuality,
} from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { HousingPanel } from './Panel';
import { buildStationShell } from './StationShell';
import type { StationShell } from './StationShell';
import { clear, el, setText, toggleClass } from './dom';

/**
 * **The dining screen** (the kitchen A-3c 2026-09-11 → **2026-09-16 the plate model**, user's decision — `openDiningTable(uid)` ← E on a dining table; `uid` null = the
 * shared ship's fixed table).
 *
 * A meal is not an item. A meal finished at the cook bench becomes **a plate on the dining table** (`HousingRef.getTablePlates`), and this screen shows those plates and
 * 「the meal loaded for the next raid」. There is no grid card (stash · bag) — there is no meal item to drag onto it.
 *
 *   • One plate = the chip (a ★n badge) · the name · the stars · the tier · who cooked it · the stat lines (with the quality bonus folded in) · 「먹기」.
 *     The personal ship's table = the player's one plate, the shared ship's table = the player's plate + squadmates' plates (with the cook's name).
 *   • **Eating does not use the plate up** — 「먹기」 is `parts/Dining.eatPlate` (→ `ProgressionRef.useMeal`), and when the pending meal is already that meal · that quality
 *     the button is dimmed and a 「먹음」 mark goes on it (`plateEatBlock`). Eating another plate **replaces** the pending meal.
 *   • The plates are taken away when the next raid starts (2026-09-17: the footer note that said that rule was removed on the user's decision).
 *
 * Not one rule lives here — the screen copies the Korean reasons `eatPlate` · `plateEatBlock` return, verbatim.
 *
 * The source of the buff wording is the contract's `MEAL_BUFF_LABEL_KO` · `MEAL_BUFF_UNIT` pair — only a line whose unit is 「%」 is `amount × 100`, and a negative line
 * such as `durabilityLossMul` reads as 「−n %」 as it stands (it means equipment damage goes down). The text helpers below are used by the cook bench screen · the cook overlay too.
 */
export class DiningTable extends HousingPanel {
  /** null = the shared ship's fixed table (not furniture, so it has no uid). */
  private uid: string | null = null;
  private readonly shell: StationShell;
  private readonly platesLabel: HTMLElement;
  private readonly platesEl: HTMLElement;
  private readonly mealCard: HTMLElement;
  private readonly mealChip: HTMLElement;
  private readonly mealName: HTMLElement;
  private readonly mealBuff: HTMLElement;
  private readonly activeNote: HTMLElement;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'dining', 'dining-table hs-station');
    this.coalesceRefresh = true;
    this.shell = buildStationShell(this.frame, {
      title: '식탁',
      upgrade: false,
      inventory: false,                 // 2026-09-16: a meal is not an item — there is no stash · bag card
      button: (p, l, fn, c) => this.button(p, l, fn, c),
    });
    const left = this.shell.left;
    this.platesLabel = el('div', { cls: 'ui-label', text: '식탁에 차린 요리', parent: left });
    this.platesEl = el('div', { cls: 'dt-plates', parent: left });
    el('div', { cls: 'ui-label', text: '다음 레이드에 실린 식사', parent: left });
    this.mealCard = el('div', { cls: 'dt-meal', parent: left });
    this.mealChip = el('div', { cls: 'dt-plate-chip cook-dt-chip', parent: this.mealCard });
    const mb = el('div', { cls: 'dt-plate-body', parent: this.mealCard });
    this.mealName = el('div', { cls: 'dt-plate-name', text: '', parent: mb });
    this.mealBuff = el('div', { cls: 'dt-plate-buff', text: '', parent: mb });
    this.activeNote = el('div', { cls: 'hint dt-active', text: '', parent: left });

    this.mountMsg();
    // 2026-09-17 (user's decision): the footer note was removed, and 「닫기」 sits **at the bottom right inside the dining card**, not at the bottom right of the whole screen
    const foot = el('div', { cls: 'dt-foot', parent: this.shell.stationCard });
    this.button(foot, '닫기', () => this.close(), 'dt-close');
    // the plates change from housing state · the squadmate wire, the meal from progression — neither is `housing:changed`
    this.unsubs.push(
      ctx.bus.on('housing:tablePlatesChanged', () => this.refreshIfOpen()),
      ctx.bus.on('progress:mealChanged', () => this.refreshIfOpen()),
    );
  }

  /* ── open ──────────────────────────────────────────────────────────────── */
  /** Opens the panel for one dining table (`null` = the shared ship's fixed table). */
  openTable(uid: string | null): void {
    this.uid = uid;
    this.openPanel();
  }

  /** The dining table open right now (smoke tests). null = the shared ship's fixed table — the last value even once closed. */
  get tableUid(): string | null { return this.uid; }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /** Eats one plate (smoke tests use it too). `ownerId` null = the player's own plate. A Korean reason / null. */
  eat(ownerId: string | null): string | null {
    const plate = this.housing.getTablePlates(this.uid).find((p) => p.ownerId === ownerId) ?? null;
    const reason = this.housing.eatPlate(this.uid, ownerId);
    if (reason) this.deny(reason);
    else if (plate) {
      const whose = plate.mine ? '' : ` (${plate.ownerName} 님의 요리)`;
      this.showMsg(`${qualityName(getMealDef(plate.mealDefId)?.name ?? plate.mealDefId, plate.quality)}을(를) 먹었습니다${whose} — 다음 레이드에 실립니다`, 'success');
    }
    this.requestRefresh();          // the meal is loaded into progression — `progress:mealChanged` comes too, but not on a refusal
    return reason;
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const shared = this.housing.isSharedTable() && this.uid === null;
    setText(this.shell.title, shared ? '공유 함선 식탁' : '식탁');
    setText(this.platesLabel, shared ? '식탁에 차린 요리 — 분대원 모두' : '식탁에 차린 요리');
    this.paintPlates(shared);
    this.paintMeal();
  }

  /** One plate at a time: the chip (★n) · the name + stars · the tier · who cooked it · the stat lines · eat. One note cell when empty. */
  private paintPlates(shared: boolean): void {
    clear(this.platesEl);
    const plates = this.housing.getTablePlates(this.uid);
    if (!plates.length) {
      el('div', {
        cls: 'dt-empty',
        text: shared
          ? '식탁이 비어 있습니다.\n분대원이 자기 함선의 조리대에서 요리하면 이 식탁에도 차려집니다.'
          : '차린 요리가 없습니다.\n조리대에서 요리하면 이 식탁에 차려집니다 (함선당 한 접시).',
        parent: this.platesEl,
      });
      return;
    }
    for (const p of plates) this.buildPlate(p, shared);
  }

  private buildPlate(p: TablePlateInfo, shared: boolean): void {
    const def = getMealDef(p.mealDefId);
    const q = normalizeMealQuality(p.quality);
    const block = this.housing.plateEatBlock(this.uid, p.ownerId);
    const eaten = block === '이미 먹었습니다';
    const row = el('div', {
      cls: `dt-plate${p.mine ? ' is-mine' : ''}${eaten ? ' is-eaten' : ''}`,
      attrs: { 'data-def': p.mealDefId, 'data-q': String(q), 'data-owner': p.ownerId ?? 'me' },
      parent: this.platesEl,
    });
    const chip = el('div', { cls: 'dt-plate-chip cook-dt-chip', parent: row });
    chip.appendChild(buildItemChip(def, { size: 48 }));
    if (q > 0) el('span', { cls: 'cook-dt-q', text: `★${q}`, parent: chip });
    const body = el('div', { cls: 'dt-plate-body', parent: row });
    const title = el('div', { cls: 'dt-plate-name', parent: body });
    el('span', { text: `${def?.name ?? p.mealDefId} `, parent: title });
    el('span', { cls: `cook-dt-stars q-${q}`, text: mealQualityStars(q), parent: title });
    const who = p.mine ? (shared ? `내 요리 · ${p.ownerName}` : '내 요리') : `${p.ownerName} 님의 요리`;
    el('div', { cls: 'dt-plate-owner', text: [def?.meal ? mealTierText(def.meal) : '', who].filter(Boolean).join(' · '), parent: body });
    el('div', { cls: 'dt-plate-buff', text: def?.meal ? mealEffectLines(def.meal, q).join('\n') : '', parent: body });
    const acts = el('div', { cls: 'dt-plate-acts', parent: row });
    const btn = this.button(acts, eaten ? '먹음' : '먹기', () => { this.eat(p.ownerId); }, `small primary dt-eat${block ? ' is-blocked' : ''}`);
    if (block) btn.title = block;
    const note = el('div', { cls: 'dt-plate-note', text: block && !eaten ? block : '', parent: acts });
    note.hidden = !block || eaten;
  }

  /** One cell for the meal loaded for the next raid + a note for this raid's (`MEAL_BUFF_LABEL_KO` · `MEAL_BUFF_UNIT` are the source) — the quality bonus folded in. */
  private paintMeal(): void {
    const prog = this.ctx.progression;
    const pending = typeof prog?.getMeal === 'function' ? prog.getMeal() : null;
    const active = typeof prog?.getActiveMeal === 'function' ? prog.getActiveMeal() : null;
    const def = getMealDef(pending);
    const quality = def && typeof prog?.getMealQuality === 'function' ? normalizeMealQuality(prog.getMealQuality()) : 0;
    clear(this.mealChip);
    this.mealChip.appendChild(buildItemChip(def, { size: 40 }));
    if (def && quality > 0) el('span', { cls: 'cook-dt-q', text: `★${quality}`, parent: this.mealChip });
    toggleClass(this.mealCard, 'is-empty', !def);
    setText(this.mealName, def ? `${def.name} ${mealQualityStars(quality)} · ${mealTierText(def.meal)}` : '아직 먹은 요리가 없습니다');
    setText(this.mealBuff, def ? mealEffectLines(def.meal, quality).join('\n') : '');
    const activeDef = getMealDef(active);
    const activeQ = activeDef && typeof prog?.getActiveMealQuality === 'function' ? normalizeMealQuality(prog.getActiveMealQuality()) : 0;
    setText(this.activeNote, activeDef ? `지금 레이드에는 「${qualityName(activeDef.name, activeQ)}」이(가) 실려 있습니다.` : '');
    this.activeNote.hidden = !activeDef;
  }
}

/** `치즈 오믈렛 ★★★☆☆` — the name alone at quality 0. */
export function qualityName(name: string, quality: number): string {
  return quality > 0 ? `${name} ${mealQualityStars(quality)}` : name;
}

/**
 * One stat line. A buff whose unit is `'%'` is a multiplier addition, so `amount × 100` is printed; the rest print in their own unit.
 * The value decides the sign — `durabilityLossMul` has a negative `amount`, so it reads 「장비 손상 −20 %」 (which is a good thing).
 */
export function mealEffectText(buff: MealBuff, amount: number): string {
  const unit = MEAL_BUFF_UNIT[buff] ?? '';
  const value = unit === '%' ? amount * 100 : amount;
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded < 0 ? '−' : '+';
  return `${MEAL_BUFF_LABEL_KO[buff] ?? buff} ${sign}${Math.abs(rounded)}${unit ? ` ${unit}` : ''}`;
}

/**
 * All of a meal's stats (2026-09-13, user's decision 「버프는 하나, 능력치 줄이 늘어난다」). Consumers read `MealDef.effects` —
 * an old def without it is read as the one `buff` · `amount` line.
 */
export function mealEffects(meal: MealDef): readonly MealEffect[] {
  if (Array.isArray(meal.effects) && meal.effects.length) return meal.effects;
  return [{ buff: meal.buff, amount: meal.amount }];
}

/**
 * One string per stat line (a plate joins them with line breaks). 2026-09-13: given `quality`, each line is `amount × (1 + mealQualityBonus(quality))` —
 * the same formula as progression's `derive.applyMealBuff` (omitted = quality 0 = the original numbers).
 */
export function mealEffectLines(meal: MealDef, quality = 0): string[] {
  const mul = 1 + mealQualityBonus(quality);
  return mealEffects(meal).map((e) => mealEffectText(e.buff, e.amount * mul));
}

/**
 * 「what by how much」 in one line — joins **every** stat with ` · ` (2026-09-13: it used to write only the first buff; the name · signature are unchanged,
 * `quality` is an optional argument appended at the end).
 */
export function mealBuffText(meal: MealDef, quality = 0): string {
  return mealEffectLines(meal, quality).join(' · ');
}

/** A tier name such as 「고기 요리」 (`MEAL_TIER_LABEL_KO`) — the retired old speciality meals (tier 2) are read from the table as they stand too. */
export function mealTierText(meal: MealDef): string {
  return MEAL_TIER_LABEL_KO[meal.tier] ?? `티어 ${meal.tier}`;
}
