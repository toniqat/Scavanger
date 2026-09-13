import type { EmbeddedView, GameContext, ItemDef, ItemInstance, MealBuff, MealDef, MealEffect } from '@/shared';
import {
  MEAL_BUFF_LABEL_KO, MEAL_BUFF_UNIT, MEAL_TIER_LABEL_KO, buildItemChip, mealQualityBonus, mealQualityStars, normalizeMealQuality,
} from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { HousingPanel } from './Panel';
import { buildStationShell, mountStationGrids } from './StationShell';
import type { StationShell } from './StationShell';
import { clear, el, setText, toggleClass } from './dom';

/**
 * **식사 화면** (주방 A-3c, 2026-09-11 · 화면 개편 2026-09-12 — `openDiningTable(uid)` ← E on a 식탁; `uid` null = 공유
 * 함선의 고정 식탁).
 *
 * 틀은 `StationShell` 공통이다 — 식탁은 레벨이 없어 **`Lv.` 표시와 업그레이드 버튼만 없다** (사용자 결정). 좌 패널 =
 * 지금 실린 식사(접시, 드롭 대상) + 가진 요리 목록, 우 패널 = 가방 · 함선 창고 격자. 제목 밑 설명 줄 · 「가방 · 함선
 * 창고」 라벨 · 안내문은 걷어냈다.
 *
 * 규칙은 하나도 여기 없다 — 「먹기」는 `parts/Dining.eatMeal`(→ `ProgressionRef.useMeal` 에 **먼저 묻고** 성공할
 * 때만 아이템을 뺀다), 「분대에 차리기」는 `parts/Dining.serveMealToSquad` 다. 화면은 그 둘이 돌려주는 한국어
 * 사유를 메시지 줄에 그대로 옮긴다.
 *
 * 버프 표기의 원본은 계약의 `MEAL_BUFF_LABEL_KO` · `MEAL_BUFF_UNIT` 한 쌍이다 — 「%」인 줄만 `amount × 100`
 * 이고, `durabilityLossMul` 처럼 음수인 줄은 그대로 「−n %」로 읽힌다 (장비 손상이 줄어든다는 뜻이다).
 *
 * 2026-09-13 (요리 재료 티어): 요리 하나의 버프에 능력치가 **여러 줄** 붙는다(`MealDef.effects`, T1 1 · T2 2 · T3 3 · T4 4).
 * 접시는 줄마다 한 줄, 목록은 티어 이름(`MEAL_TIER_LABEL_KO` — 옛 「일반 / 특선」 대신) 아래에 ` · ` 로 이어 전부 적는다.
 *
 * 2026-09-13 (요리 품질): 목록은 **(요리, 품질) 한 줄씩**이다(`getMealStacks`) — 칩 좌하단 `★n` 배지 + 이름 옆 별(`★★★☆☆`), 능력치는
 * 그 품질의 보너스를 곱한 값. 먹기 · 차리기 · 접시로 끌어다 놓기가 그 품질을 넘긴다. 접시는 실린 식사의 별(`getMealQuality`)을 보인다.
 */
export class DiningTable extends HousingPanel {
  /** null = 공유 함선의 고정 식탁 (가구가 아니라 uid 가 없다). */
  private uid: string | null = null;
  private readonly shell: StationShell;
  private readonly plate: HTMLElement;
  private readonly plateChip: HTMLElement;
  private readonly plateName: HTMLElement;
  private readonly plateBuff: HTMLElement;
  private readonly plateNote: HTMLElement;
  private readonly activeNote: HTMLElement;
  private readonly listEl: HTMLElement;
  private grids: EmbeddedView | null = null;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'dining', 'dining-table hs-station');
    this.coalesceRefresh = true;
    this.shell = buildStationShell(this.frame, {
      title: '식탁',
      upgrade: false,
      button: (p, l, fn, c) => this.button(p, l, fn, c),
    });
    const left = this.shell.left;
    el('div', { cls: 'ui-label', text: '다음 레이드에 실린 식사', parent: left });
    // 접시 = 드롭 대상 (요리를 끌어다 놓으면 먹는다). `.dt-plate` 는 이 패널 전용 이름이다.
    this.plate = el('div', { cls: 'dt-plate', parent: left });
    this.plateChip = el('div', { cls: 'dt-plate-chip cook-dt-chip', parent: this.plate });
    const pb = el('div', { cls: 'dt-plate-body', parent: this.plate });
    this.plateName = el('div', { cls: 'dt-plate-name', text: '', parent: pb });
    this.plateBuff = el('div', { cls: 'dt-plate-buff', text: '', parent: pb });
    this.plateNote = el('div', { cls: 'dt-plate-note', text: '', parent: pb });
    this.activeNote = el('div', { cls: 'hint dt-active', text: '', parent: left });
    el('div', { cls: 'ui-label', text: '가진 요리', parent: left });
    this.listEl = el('div', { cls: 'dt-list', parent: left });

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', {
      cls: 'hint',
      text: '식사는 출격할 때 실려 그 레이드 내내 유지됩니다 — 죽어도 그 레이드에서는 사라지지 않습니다.',
      parent: el('div', { cls: 'left', parent: foot }),
    });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** Open the panel for one 식탁 (`null` = 공유 함선의 고정 식탁). */
  openTable(uid: string | null): void {
    this.uid = uid;
    this.openPanel();
    if (!this.grids) this.grids = mountStationGrids(this.ctx, this.shell.invHost, '.dt-plate', (item, target) => this.dropOn(item, target));
  }

  override close(relock = true): void {
    // the embedded grids keep listening to `inventory:changed` while they live, so a closed panel drops them
    this.grids?.dispose();
    this.grids = null;
    super.close(relock);
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!target) { this.showMsg('요리를 접시로 끌어다 놓으세요', 'info'); return; }
    const def = this.housing.defOf(item.defId);
    if (!def) { this.showMsg('알 수 없는 아이템입니다', 'warning'); return; }
    if (!def.meal) { this.showMsg('요리만 먹을 수 있습니다', 'warning'); return; }
    this.eat(def, normalizeMealQuality(item.quality));
  }

  private eat(def: ItemDef, quality: number): void {
    const reason = this.housing.eatMeal(this.uid, def.id, quality);
    this.showMsg(reason ?? `${qualityName(def.name, quality)}을(를) 먹었습니다 — 다음 레이드에 실립니다`, reason ? 'warning' : 'success');
    this.requestRefresh();          // 식사는 progression 에 실린다 — housing / inventory 이벤트만으로는 접시가 안 바뀔 수 있다
  }

  private serve(def: ItemDef, quality: number): void {
    const reason = this.housing.serveMealToSquad(this.uid, def.id, quality);
    this.showMsg(reason ?? `${qualityName(def.name, quality)}을(를) 분대에 차렸습니다`, reason ? 'warning' : 'success');
    this.requestRefresh();
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const shared = this.housing.isSharedTable();
    setText(this.shell.title, shared ? '공유 함선 식탁' : '식탁');
    this.paintPlate();
    this.buildList(shared);
  }

  /** 접시: 지금 실린 식사 한 칸 + 그 버프 줄 (`MEAL_BUFF_LABEL_KO` · `MEAL_BUFF_UNIT` 가 원본) — 품질 보너스 반영. */
  private paintPlate(): void {
    const prog = this.ctx.progression;
    const pending = typeof prog?.getMeal === 'function' ? prog.getMeal() : null;
    const active = typeof prog?.getActiveMeal === 'function' ? prog.getActiveMeal() : null;
    const def = pending ? this.housing.mealDef(pending) : null;
    const quality = def && typeof prog?.getMealQuality === 'function' ? normalizeMealQuality(prog.getMealQuality()) : 0;

    clear(this.plateChip);
    this.plateChip.appendChild(buildItemChip(def ?? undefined, { size: 44 }));
    if (def && quality > 0) el('span', { cls: 'cook-dt-q', text: `★${quality}`, parent: this.plateChip });
    toggleClass(this.plate, 'is-empty', !def);
    setText(this.plateName, def?.meal ? `${def.name} ${mealQualityStars(quality)} · ${mealTierText(def.meal)}` : def ? def.name : '차려 둔 식사가 없습니다');
    // 2026-09-13: 요리 하나의 버프에 능력치가 여러 줄 붙는다 (T1 1 · T2 2 · T3 3 · T4 4) — 줄마다 한 줄 (`white-space: pre-line`)
    setText(this.plateBuff, def?.meal ? mealEffectLines(def.meal, quality).join('\n') : '요리를 먹으면 여기에 실립니다');
    setText(this.plateNote, def
      ? '다른 요리(또는 같은 요리의 다른 품질)를 먹으면 이 식사를 대신합니다 (먹은 요리는 돌아오지 않습니다)'
      : '아래 목록에서 「먹기」를 누르거나 요리를 여기로 끌어다 놓으세요');
    const activeQ = active && typeof prog?.getActiveMealQuality === 'function' ? normalizeMealQuality(prog.getActiveMealQuality()) : 0;
    setText(this.activeNote, active
      ? `지금 레이드에는 「${qualityName(this.housing.nameOf(active), activeQ)}」이(가) 실려 있습니다.`
      : '');
    this.activeNote.hidden = !active;
  }

  /** 가진 요리 (요리, 품질) 한 줄씩: 칩(★n) + 이름 · 별 · 버프 + 먹기 (공유 함선이면 분대에 차리기도). */
  private buildList(shared: boolean): void {
    clear(this.listEl);
    const owned = this.housing.getMealStacks();
    if (!owned.length) {
      el('div', { cls: 'hs-empty', text: '가진 요리가 없습니다 — 주방의 조리대에서 만드세요', parent: this.listEl });
      return;
    }
    for (const { defId, quality, qty } of owned) {
      const def = this.housing.mealDef(defId);
      if (!def || !def.meal) continue;
      const row = el('div', { cls: 'dt-row', attrs: { 'data-def': defId, 'data-q': String(quality) }, parent: this.listEl });
      const chipHost = el('div', { cls: 'cook-dt-chip', parent: row });
      chipHost.appendChild(buildItemChip(def, { size: 34, have: qty }));
      if (quality > 0) el('span', { cls: 'cook-dt-q', text: `★${quality}`, parent: chipHost });
      const body = el('div', { cls: 'body', parent: row });
      const title = el('div', { cls: 'title', parent: body });
      el('span', { text: `${def.name} ×${qty} `, parent: title });
      el('span', { cls: `cook-dt-stars q-${quality}`, text: mealQualityStars(quality), parent: title });
      el('div', { cls: 'sub dt-tier', text: mealTierText(def.meal), parent: body });
      // 능력치 줄 전부 (품질 보너스 반영) — 좁으면 줄바꿈한다 (잘리지 않게 `.dt-effects` 는 ellipsis 를 쓰지 않는다)
      el('div', { cls: 'sub dt-effects', text: mealBuffText(def.meal, quality), parent: body });
      const acts = el('div', { cls: 'dt-acts', parent: row });
      this.button(acts, '먹기', () => this.eat(def, quality), 'small primary');
      if (shared) this.button(acts, '분대에 차리기', () => this.serve(def, quality), 'small');
    }
  }

  override dispose(): void {
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}

/** `치즈 오믈렛 ★★★☆☆` — 품질 0 이면 이름만. */
function qualityName(name: string, quality: number): string {
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
