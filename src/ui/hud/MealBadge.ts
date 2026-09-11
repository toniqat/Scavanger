import type { GameContext, ItemDef } from '@/shared';
import { CATEGORY_COLOR, CATEGORY_ICON } from '@/shared';
import '../styles/meal.css';
import { el, setText, toggleClass } from '../dom';
import { mealBuffText } from './mealText';

/**
 * **식사 배지 (A-3c, 2026-09-11).** `progress:mealChanged {meal, active}` 의 **유일한** 소비자다 — 무엇을 먹었나 ·
 * 언제 실리고 언제 비는가는 전부 `progression/` 이 정하고 이 위젯은 `active`(= 이번 레이드에 실려 있는 요리) 한 줄을
 * 그리기만 한다. 대기분(`meal`)은 **여기서 안 그린다**: 함선에서 차려 둔 요리는 식탁 화면이 말하고, 이 배지는 「지금
 * 내 몸에 무엇이 걸려 있나」다. 이벤트는 상태가 바뀔 때만 오므로 `update()` 도 타이머도 없다 (`EnvBadge` 와 같은 결).
 *
 * **레이드에서만 보인다** — `.hud.gameplay` 레이어 안에 사는 것이 곧 그 구현이고(레이어가 함선 · 타이틀에서 내려간다),
 * 함선에서 `active` 가 null 인 것과 `.hud.hub` CSS 규칙이 이중 안전장치다. 자리는 환경 배지와 **한 줄에 나란히**:
 * 둘 다 좌측 상단의 `.hud-badges` flex 행 안에 있고, 그 행은 배경도 여백도 없어 **둘 다 없으면 빈 상자가 남지 않는다**
 * (`styles/env.css` 가 행을, `styles/meal.css` 가 이 배지를 갖는다).
 *
 * 문장은 `hud/mealText` 하나에서 온다 — 아이템 툴팁이 같은 요리를 같은 말로 적어야 하기 때문이다. 단위(`%` · `kg` ·
 * `m` · 없음)를 정하는 표는 `shared/labels` 의 `MEAL_BUFF_UNIT` 이고 이 파일은 숫자를 하나도 갖지 않는다.
 * `durabilityLossMul` 처럼 `amount` 가 음수인 버프는 「장비 손상 −20 %」로 그대로 찍혀 이득으로 읽힌다.
 */
export class MealBadge {
  readonly root: HTMLElement;
  private glyphEl: HTMLElement;
  private nameEl: HTMLElement;
  private buffEl: HTMLElement;
  private ctx: GameContext | null = null;
  /** 지금 그리고 있는 요리 def id (못 찾은 def 는 null 로 남겨 다음 이벤트에 다시 시도한다). */
  private defId: string | null = null;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'meal-badge', parent });
    this.glyphEl = el('span', { cls: 'g', text: CATEGORY_ICON.meal, parent: this.root });
    this.nameEl = el('span', { cls: 'nm', text: '', parent: this.root });
    this.buffEl = el('span', { cls: 'bf', text: '', parent: this.root });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('progress:mealChanged', ({ active }) => this.set(active)),
      /* 레이드 경계에서는 **비우지 않고 다시 묻는다** — 출격이 `armPreps()` 로 식사를 싣는 순간과
         `game:newMission` 의 순서를 이 폴더가 보증할 수 없기 때문이다 (지웠다가는 실린 식사를 놓친다). */
      b.on('game:newMission', () => this.refresh()),
      b.on('game:abort', () => this.refresh()),
    );
    this.refresh();
  }

  /** 지금 그리고 있는 요리 def id (debug / smoke), 없으면 null. */
  get shownMeal(): string | null { return this.defId; }

  /** `ctx.progression` 에 직접 물어 지금 실린 요리를 다시 그린다 (구현이 아직 없으면 조용히 빈다). */
  private refresh(): void {
    let active: string | null = null;
    try {
      const prog = this.ctx?.progression;
      if (prog && typeof prog.getActiveMeal === 'function') active = prog.getActiveMeal();
    } catch { active = null; }
    this.set(active);
  }

  private defOf(defId: string): ItemDef | undefined {
    const ctx = this.ctx;
    if (!ctx) return undefined;
    try { return ctx.loot?.getItemDef(defId) ?? ctx.inventory?.getDef(defId); } catch { return undefined; }
  }

  private set(defId: string | null): void {
    if (defId !== null && defId === this.defId) return;
    const def = defId ? this.defOf(defId) : undefined;
    const meal = def?.meal;
    if (!def || !meal) {
      if (this.defId === null) return;
      this.defId = null;
      toggleClass(this.root, 'show', false);
      toggleClass(this.root, 'is-special', false);
      return;
    }
    this.defId = defId;
    this.root.style.setProperty('--mc', def.color || CATEGORY_COLOR.meal);
    setText(this.glyphEl, def.icon || CATEGORY_ICON.meal);
    setText(this.nameEl, def.name);
    const line = mealBuffText(meal.buff, meal.amount);
    setText(this.buffEl, line);
    // pointer-events 가 없어 툴팁은 안 뜨지만, 접근성 도구 · 스모크가 읽을 한 줄은 남겨 둔다 (EnvBadge 와 같다)
    this.root.title = `${def.name} — ${line} · 이번 레이드`;
    toggleClass(this.root, 'is-special', meal.tier === 2);
    toggleClass(this.root, 'show', true);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }
}
