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
 * **식사 화면** (주방 A-3c 2026-09-11 → **2026-09-16 접시 모델**, 사용자 결정 — `openDiningTable(uid)` ← E on a 식탁; `uid` null = 공유
 * 함선의 고정 식탁).
 *
 * 요리는 아이템이 아니다. 조리대에서 끝난 요리는 **식탁의 접시**가 되고(`HousingRef.getTablePlates`), 이 화면은 그 접시들과
 * 「다음 레이드에 실린 식사」를 보여 준다. 격자 카드(창고 · 가방)는 없다 — 끌어다 놓을 요리 아이템이 없다.
 *
 *   • 접시 한 장 = 칩(★n 배지) · 이름 · 별 · 티어 · 요리한 사람 · 능력치 줄(품질 보너스 반영) · 「먹기」.
 *     개인 함선 식탁 = 내 접시 하나, 공유 함선 식탁 = 내 접시 + 분대원 접시(요리한 사람 이름).
 *   • **먹어도 접시는 줄지 않는다** — 「먹기」는 `parts/Dining.eatPlate`(→ `ProgressionRef.useMeal`)이고, 이미 대기 식사가 그 요리 · 그 품질이면
 *     버튼이 딤드되고 「먹음」 표시가 붙는다(`plateEatBlock`). 다른 접시를 먹으면 대기 식사가 **바뀐다**.
 *   • 접시는 다음 레이드가 시작되면 치워진다 (2026-09-17: 그 규칙을 말하던 바닥 안내문은 사용자 결정으로 걷어냈다).
 *
 * 규칙은 하나도 여기 없다 — 화면은 `eatPlate` · `plateEatBlock` 이 돌려주는 한국어 사유를 그대로 옮긴다.
 *
 * 버프 표기의 원본은 계약의 `MEAL_BUFF_LABEL_KO` · `MEAL_BUFF_UNIT` 한 쌍이다 — 「%」인 줄만 `amount × 100` 이고, `durabilityLossMul` 처럼
 * 음수인 줄은 그대로 「−n %」로 읽힌다 (장비 손상이 줄어든다는 뜻이다). 아래 텍스트 헬퍼는 조리대 화면 · 조리 오버레이도 쓴다.
 */
export class DiningTable extends HousingPanel {
  /** null = 공유 함선의 고정 식탁 (가구가 아니라 uid 가 없다). */
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
      inventory: false,                 // 2026-09-16: 요리는 아이템이 아니다 — 창고 · 가방 카드가 없다
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
    // 2026-09-17 (사용자 결정): 바닥 안내문은 걷어냈고, 「닫기」는 화면 전체의 우하단이 아니라 **식탁 카드 안의 우하단**이다
    const foot = el('div', { cls: 'dt-foot', parent: this.shell.stationCard });
    this.button(foot, '닫기', () => this.close(), 'dt-close');
    // 접시는 housing 상태 · 분대원 와이어에서, 식사는 progression 에서 바뀐다 — 둘 다 `housing:changed` 가 아니다
    this.unsubs.push(
      ctx.bus.on('housing:tablePlatesChanged', () => this.refreshIfOpen()),
      ctx.bus.on('progress:mealChanged', () => this.refreshIfOpen()),
    );
  }

  /* ── open ──────────────────────────────────────────────────────────────── */
  /** Open the panel for one 식탁 (`null` = 공유 함선의 고정 식탁). */
  openTable(uid: string | null): void {
    this.uid = uid;
    this.openPanel();
  }

  /** 지금 열린 식탁 (스모크). null = 공유 함선의 고정 식탁 — 닫혀 있어도 마지막 값. */
  get tableUid(): string | null { return this.uid; }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /** 접시 하나를 먹는다 (스모크도 쓴다). `ownerId` null = 내 접시. 한국어 사유 / null. */
  eat(ownerId: string | null): string | null {
    const plate = this.housing.getTablePlates(this.uid).find((p) => p.ownerId === ownerId) ?? null;
    const reason = this.housing.eatPlate(this.uid, ownerId);
    if (reason) this.deny(reason);
    else if (plate) {
      const whose = plate.mine ? '' : ` (${plate.ownerName} 님의 요리)`;
      this.showMsg(`${qualityName(getMealDef(plate.mealDefId)?.name ?? plate.mealDefId, plate.quality)}을(를) 먹었습니다${whose} — 다음 레이드에 실립니다`, 'success');
    }
    this.requestRefresh();          // 식사는 progression 에 실린다 — `progress:mealChanged` 도 오지만 거절이면 오지 않는다
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

  /** 접시 한 장씩: 칩(★n) · 이름 + 별 · 티어 · 요리한 사람 · 능력치 줄 · 먹기. 비었으면 안내 한 칸. */
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

  /** 다음 레이드에 실린 식사 한 칸 + 지금 레이드분 안내 (`MEAL_BUFF_LABEL_KO` · `MEAL_BUFF_UNIT` 가 원본) — 품질 보너스 반영. */
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

/** `치즈 오믈렛 ★★★☆☆` — 품질 0 이면 이름만. */
export function qualityName(name: string, quality: number): string {
  return quality > 0 ? `${name} ${mealQualityStars(quality)}` : name;
}

/**
 * 능력치 한 줄. 단위가 `'%'` 인 버프는 배수 가산이라 `amount × 100` 을 찍고, 나머지는 단위 그대로다.
 * 부호는 값이 정한다 — `durabilityLossMul` 은 음수 `amount` 라 「장비 손상 −20 %」로 읽힌다 (좋은 일이다).
 */
export function mealEffectText(buff: MealBuff, amount: number): string {
  const unit = MEAL_BUFF_UNIT[buff] ?? '';
  const value = unit === '%' ? amount * 100 : amount;
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded < 0 ? '−' : '+';
  return `${MEAL_BUFF_LABEL_KO[buff] ?? buff} ${sign}${Math.abs(rounded)}${unit ? ` ${unit}` : ''}`;
}

/**
 * 요리의 능력치 전부 (2026-09-13, 사용자 결정 「버프는 하나, 능력치 줄이 늘어난다」). 소비자는 `MealDef.effects` 를 읽는다 —
 * 그것이 없는 옛 def 는 `buff` · `amount` 한 줄로 읽는다.
 */
export function mealEffects(meal: MealDef): readonly MealEffect[] {
  if (Array.isArray(meal.effects) && meal.effects.length) return meal.effects;
  return [{ buff: meal.buff, amount: meal.amount }];
}

/**
 * 능력치 줄마다 한 문자열 (접시는 줄바꿈으로 잇는다). 2026-09-13: `quality` 를 주면 줄마다 `amount × (1 + mealQualityBonus(품질))` —
 * progression 의 `derive.applyMealBuff` 와 같은 식이다 (생략 = 품질 0 = 원래 수치).
 */
export function mealEffectLines(meal: MealDef, quality = 0): string[] {
  const mul = 1 + mealQualityBonus(quality);
  return mealEffects(meal).map((e) => mealEffectText(e.buff, e.amount * mul));
}

/**
 * 「무엇이 얼마나」 한 줄 — **모든** 능력치를 ` · ` 로 잇는다 (2026-09-13: 예전에는 첫 버프 하나만 적었다; 이름 · 시그니처는 그대로,
 * `quality` 는 뒤에 붙은 선택 인자).
 */
export function mealBuffText(meal: MealDef, quality = 0): string {
  return mealEffectLines(meal, quality).join(' · ');
}

/** 「고기 요리」 같은 티어 이름 (`MEAL_TIER_LABEL_KO`) — 은퇴한 옛 특선 요리(티어 2)도 표 그대로 읽는다. */
export function mealTierText(meal: MealDef): string {
  return MEAL_TIER_LABEL_KO[meal.tier] ?? `티어 ${meal.tier}`;
}
