import type { EmbeddedView, GameContext, ItemDef, ItemInstance, MealDef } from '@/shared';
import { MEAL_BUFF_LABEL_KO, MEAL_BUFF_UNIT, buildItemChip } from '@/shared';
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
    this.plateChip = el('div', { cls: 'dt-plate-chip', parent: this.plate });
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
    this.eat(def);
  }

  private eat(def: ItemDef): void {
    const reason = this.housing.eatMeal(this.uid, def.id);
    this.showMsg(reason ?? `${def.name}을(를) 먹었습니다 — 다음 레이드에 실립니다`, reason ? 'warning' : 'success');
    this.requestRefresh();          // 식사는 progression 에 실린다 — housing / inventory 이벤트만으로는 접시가 안 바뀔 수 있다
  }

  private serve(def: ItemDef): void {
    const reason = this.housing.serveMealToSquad(this.uid, def.id);
    this.showMsg(reason ?? `${def.name}을(를) 분대에 차렸습니다`, reason ? 'warning' : 'success');
    this.requestRefresh();
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const shared = this.housing.isSharedTable();
    setText(this.shell.title, shared ? '공유 함선 식탁' : '식탁');
    this.paintPlate();
    this.buildList(shared);
  }

  /** 접시: 지금 실린 식사 한 칸 + 그 버프 한 줄 (`MEAL_BUFF_LABEL_KO` · `MEAL_BUFF_UNIT` 가 원본). */
  private paintPlate(): void {
    const prog = this.ctx.progression;
    const pending = typeof prog?.getMeal === 'function' ? prog.getMeal() : null;
    const active = typeof prog?.getActiveMeal === 'function' ? prog.getActiveMeal() : null;
    const def = pending ? this.housing.mealDef(pending) : null;

    clear(this.plateChip);
    this.plateChip.appendChild(buildItemChip(def ?? undefined, { size: 44 }));
    toggleClass(this.plate, 'is-empty', !def);
    setText(this.plateName, def ? def.name : '차려 둔 식사가 없습니다');
    setText(this.plateBuff, def?.meal ? mealBuffText(def.meal) : '요리를 먹으면 여기에 실립니다');
    setText(this.plateNote, def
      ? '다른 요리를 먹으면 이 식사를 대신합니다 (먹은 요리는 돌아오지 않습니다)'
      : '아래 목록에서 「먹기」를 누르거나 요리를 여기로 끌어다 놓으세요');
    setText(this.activeNote, active
      ? `지금 레이드에는 「${this.housing.nameOf(active)}」이(가) 실려 있습니다.`
      : '');
    this.activeNote.hidden = !active;
  }

  /** 가진 요리 한 줄씩: 칩 + 이름 · 버프 + 먹기 (공유 함선이면 분대에 차리기도). */
  private buildList(shared: boolean): void {
    clear(this.listEl);
    const owned = this.housing.getOwnedMeals();
    if (!owned.length) {
      el('div', { cls: 'hs-empty', text: '가진 요리가 없습니다 — 주방의 조리대에서 만드세요', parent: this.listEl });
      return;
    }
    for (const { defId, qty } of owned) {
      const def = this.housing.mealDef(defId);
      if (!def || !def.meal) continue;
      const row = el('div', { cls: 'dt-row', parent: this.listEl });
      row.appendChild(buildItemChip(def, { size: 34, have: qty }));
      const body = el('div', { cls: 'body', parent: row });
      el('div', { cls: 'title', text: `${def.name} ×${qty}`, parent: body });
      el('div', { cls: 'sub', text: `${def.meal.tier === 2 ? '특선' : '일반'} · ${mealBuffText(def.meal)}`, parent: body });
      const acts = el('div', { cls: 'dt-acts', parent: row });
      this.button(acts, '먹기', () => this.eat(def), 'small primary');
      if (shared) this.button(acts, '분대에 차리기', () => this.serve(def), 'small');
    }
  }

  override dispose(): void {
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}

/**
 * 「무엇이 얼마나」 한 줄. 단위가 `'%'` 인 버프는 배수 가산이라 `amount × 100` 을 찍고, 나머지는 단위 그대로다.
 * 부호는 값이 정한다 — `durabilityLossMul` 은 음수 `amount` 라 「장비 손상 −20 %」로 읽힌다 (좋은 일이다).
 */
export function mealBuffText(meal: MealDef): string {
  const unit = MEAL_BUFF_UNIT[meal.buff];
  const value = unit === '%' ? meal.amount * 100 : meal.amount;
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded < 0 ? '−' : '+';
  return `${MEAL_BUFF_LABEL_KO[meal.buff]} ${sign}${Math.abs(rounded)}${unit ? ` ${unit}` : ''}`;
}
