import type { CraftRecipe, EmbeddedView, GameContext, ItemInstance, MealBuff } from '@/shared';
import {
  COOK_GAME_ICON, COOK_GAME_LABEL_KO, MEAL_BUFF_UNIT, MEAL_QUALITY_MAX, MEAL_TIER_LABEL_KO, buildItemChip, cookStepsOf,
  mealQualityBonus, mealQualityStars,
} from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import { furnitureMaxLevel, nextFurnitureCost } from '../../Rules';
import { cookBenchAt, cookRecipes } from '../../parts/Cooking';
import { mealEffectText, mealEffects, mealTierText } from '../DiningTable';
import { HousingPanel } from '../Panel';
import { buildStationShell, mountStationGrids, paintStationLevel, paintStationMeta } from '../StationShell';
import type { StationShell } from '../StationShell';
import { UpgradeModal } from '../UpgradeModal';
import type { UpgradeSpec } from '../UpgradeModal';
import { clear, el, renderCost, setText, toggleClass } from '../dom';
import './cook.css';

const CIRCLED = ['①', '②', '③', '④', '⑤'];
/** 선택한 요리의 칩 크기 (px, 레이아웃 값). */
const SEL_CHIP = 52;

interface RecipeRow {
  r: CraftRecipe;
  /** 조리대 레벨이 모자란다. */
  locked: boolean;
  /** 지금 시작할 수 없는 사유 (`HousingRef.cookBlock`), null = 시작할 수 있다. */
  block: string | null;
  tier: number;
}

const pct = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 100);

/** 능력치 값만 (`+5 %`) — `mealEffectText` 에서 이름을 뗀 것. 단위 규칙은 계약 `MEAL_BUFF_UNIT` 그대로. */
function effectValueText(buff: MealBuff, amount: number): string {
  const unit = MEAL_BUFF_UNIT[buff] ?? '';
  const value = unit === '%' ? amount * 100 : amount;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded)}${unit ? ` ${unit}` : ''}`;
}

/**
 * **조리대 화면** (2026-09-13, `docs/plans/cooking-minigames.md` §6-1 — `openCookStation(uid)` ← E on a 조리대 · 자동 조리 가구).
 *
 * 틀은 `StationShell` 공통이다: [조리대 카드(우상단 업그레이드 = 조리대 강화)] [함선 창고] [가방].
 *   • 레일 = 요리 목록, 티어 이름(`MEAL_TIER_LABEL_KO`) 아래로 묶는다. 지금 만들 수 있으면 초록 점, 조리대 레벨이 모자라면 `Lv.n` 딤드.
 *   • 좌 패널 = 고른 요리: 칩 + 티어 · 조리대 레벨 · 단계 수, 능력치 줄(☆ 기준 → ★★★★★ 보너스 반영 범위), 재료 비용 칩(보유/필요),
 *     **단계 칩 줄**(`① ⫽ 썰기 → ② ◎ 젓기`, 자동 가구가 있으면 칩 아래 `푸드 프로세서 Lv.2 · 자동 60 %`), `조리 시작`
 *     (막히면 딤드 + 사유 줄 · 누르면 거절음 + 토스트).
 * 창고 / 가방 격자는 보기 · 정리용이다 — 재료는 조리가 **끝날 때** 가방 → 창고 순서로 inventory 가 뺀다.
 * 규칙은 하나도 여기 없다 — 사유는 `HousingRef.cookBlock` · `startCook` 이 준다.
 */
export class CookStation extends HousingPanel {
  /** 열린 조리대 uid. */
  benchUid = '';
  selectedRecipeId: string | null = null;
  /** 고른 요리의 「조리 시작」 막힘 사유 (스모크). */
  startBlock: string | null = null;
  private readonly shell: StationShell;
  private readonly modal: UpgradeModal;
  private grids: EmbeddedView | null = null;
  private railKey = '';
  private readonly selChip: HTMLElement;
  private readonly selName: HTMLElement;
  private readonly selSub: HTMLElement;
  private readonly selEffects: HTMLElement;
  private readonly selCost: HTMLElement;
  private readonly selSteps: HTMLElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly reasonEl: HTMLElement;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'cook', 'cook-station hs-station');
    this.coalesceRefresh = true;
    this.shell = buildStationShell(this.frame, {
      title: '조리대',
      upgrade: true,
      onUpgrade: () => this.openUpgrade(),
      button: (p, l, fn, c) => this.button(p, l, fn, c),
    });
    this.shell.rail.hidden = false;
    this.shell.rail.classList.add('cook-rail');
    this.shell.rail.addEventListener('click', (e) => this.onRailClick(e));

    const left = this.shell.left;
    const head = el('div', { cls: 'cook-sel-head', parent: left });
    this.selChip = el('div', { cls: 'cook-sel-chip', parent: head });
    const ht = el('div', { cls: 'cook-sel-title', parent: head });
    this.selName = el('div', { cls: 'cook-sel-name', parent: ht });
    this.selSub = el('div', { cls: 'cook-sel-sub', parent: ht });
    el('div', { cls: 'ui-label', text: '능력치 · 요리 품질', parent: left });
    this.selEffects = el('div', { cls: 'cook-sel-effects', parent: left });
    el('div', { cls: 'ui-label', text: '재료', parent: left });
    this.selCost = el('div', { cls: 'cook-sel-cost', parent: left });
    el('div', { cls: 'ui-label', text: '조리 순서', parent: left });
    this.selSteps = el('div', { cls: 'cook-sel-steps', parent: left });
    const start = el('div', { cls: 'cook-sel-start', parent: left });
    this.startBtn = this.button(start, '조리 시작', () => this.start(), 'primary cook-start');
    this.reasonEl = el('div', { cls: 'cook-sel-reason', parent: start });
    this.reasonEl.hidden = true;
    el('div', {
      cls: 'hint cook-sel-note',
      text: '재료는 요리가 끝날 때 빠집니다 — 중간에 그만두면 아무것도 쓰지 않습니다. 만든 요리는 함선 창고에 먼저 들어갑니다.',
      parent: left,
    });

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'hint', text: '미니게임 점수가 요리 품질(별)이 되고, 품질이 높을수록 먹었을 때 능력치가 더 오릅니다.', parent: el('div', { cls: 'left', parent: foot }) });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    this.modal = new UpgradeModal(ctx, this.root, housing);
    this.overlays.push(this.modal);
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  openStation(uid: string): void {
    if (uid !== this.benchUid) this.railKey = '';
    this.benchUid = uid;
    this.openPanel();
    if (!this.grids) this.grids = mountStationGrids(this.ctx, this.shell.invHost, '.cook-sel-drop', (item, target) => this.dropOn(item, target));
    this.ctx.bus.emit('ui:cookStationToggled', { open: true, uid });
  }

  override close(relock = true): void {
    const wasOpen = this.isOpen;
    this.grids?.dispose();
    this.grids = null;
    super.close(relock);
    if (wasOpen) this.ctx.bus.emit('ui:cookStationToggled', { open: false, uid: null });
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  private dropOn(_item: ItemInstance, _target: HTMLElement | null): void {
    this.showMsg('재료는 넣지 않아도 됩니다 — 조리가 끝날 때 가방 · 함선 창고에서 빠집니다', 'info');
  }

  /** 레일에서 요리를 고른다 (스모크도 쓴다). */
  select(recipeId: string): void {
    this.selectedRecipeId = recipeId;
    this.railKey = '';
    if (this.isOpen) this.refresh();
  }

  private onRailClick(e: MouseEvent): void {
    const id = (e.target as Element | null)?.closest<HTMLElement>('.cook-rail-item[data-recipe]')?.dataset.recipe;
    if (!id || id === this.selectedRecipeId) return;
    e.stopPropagation();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.select(id);
  }

  /** 「조리 시작」 — 막혀 있으면 거절음 + 토스트. 시작하면 이 화면은 닫히고 조리 오버레이가 열린다. */
  start(): string | null {
    const id = this.selectedRecipeId;
    if (!id) { this.deny('요리를 고르세요'); return '요리를 고르세요'; }
    const reason = this.housing.startCook(this.benchUid, id);
    if (reason) this.deny(reason);
    return reason;
  }

  /* ── 업그레이드 (모달) ─────────────────────────────────────────────────── */
  private openUpgrade(): void {
    if (!cookBenchAt(this.housing, this.benchUid)) return;
    this.modal.open(() => this.upgradeSpec(), () => this.upgrade());
  }

  private upgradeSpec(): UpgradeSpec | null {
    const h = this.housing;
    const bench = cookBenchAt(h, this.benchUid);
    if (!bench) return null;
    const level = bench.item.level;
    const opened = cookRecipes(h).filter((r) => (r.benchLevel ?? 1) === level + 1).length;
    return {
      name: bench.def.name,
      level,
      maxLevel: furnitureMaxLevel(bench.def),
      gain: opened > 0 ? `요리 ${opened}가지 개방` : '',
      cost: nextFurnitureCost(bench.def, level),
      reason: h.furnitureUpgradeBlock(this.benchUid),
      requirements: h.furnitureUpgradeRequirements(this.benchUid),
    };
  }

  private upgrade(): void {
    const reason = this.housing.furnitureUpgradeBlock(this.benchUid);
    if (reason) { this.deny(reason); return; }
    const before = cookBenchAt(this.housing, this.benchUid)?.item.level ?? 0;
    if (this.housing.upgradeFurniture(this.benchUid)) {
      this.railKey = '';
      this.showMsg(`조리대 Lv.${before + 1}`, 'success');
    } else {
      this.showMsg('강화에 실패했습니다', 'danger');
    }
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing;
    const bench = cookBenchAt(h, this.benchUid);
    setText(this.shell.title, bench?.def.name ?? '조리대');
    const level = bench?.item.level ?? 0;
    paintStationLevel(this.shell, bench ? level : null, bench ? furnitureMaxLevel(bench.def) : 0);
    const rows: RecipeRow[] = cookRecipes(h).map((r) => ({
      r,
      locked: (r.benchLevel ?? 1) > level,
      block: bench ? h.cookBlock(this.benchUid, r.id) : '조리대가 없습니다',
      tier: h.mealDef(r.outputDefId)?.meal?.tier ?? 0,
    }));
    if (!this.selectedRecipeId || !rows.some((x) => x.r.id === this.selectedRecipeId)) {
      this.selectedRecipeId = (rows.find((x) => !x.block) ?? rows.find((x) => !x.locked) ?? rows[0])?.r.id ?? null;
    }
    const ready = rows.filter((x) => !x.block).length;
    paintStationMeta(this.shell, rows.length ? `지금 만들 수 있는 요리 ${ready}` : '');
    const key = `${rows.map((x) => `${x.r.id}:${x.locked ? 1 : 0}:${x.block ? 0 : 1}`).join('|')}#${this.selectedRecipeId}`;
    if (key !== this.railKey) { this.railKey = key; this.buildRail(rows); }
    this.paintSelection(rows.find((x) => x.r.id === this.selectedRecipeId) ?? null);
    this.modal.refresh();
  }

  private buildRail(rows: readonly RecipeRow[]): void {
    const rail = this.shell.rail;
    clear(rail);
    if (!rows.length) { el('div', { cls: 'hs-empty', text: '요리가 없습니다', parent: rail }); return; }
    const tiers = [...new Set(rows.map((x) => x.tier))].sort((a, b) => a - b);
    for (const tier of tiers) {
      el('div', { cls: 'cook-rail-tier', text: MEAL_TIER_LABEL_KO[tier as 1 | 2 | 3 | 4] ?? `티어 ${tier}`, parent: rail });
      for (const x of rows) {
        if (x.tier !== tier) continue;
        const btn = el('button', {
          cls: `hs-rail-item cook-rail-item${x.r.id === this.selectedRecipeId ? ' is-active' : ''}${x.locked ? ' is-locked' : ''}`,
          attrs: { 'data-recipe': x.r.id },
          parent: rail,
        });
        btn.type = 'button';
        el('i', { cls: `cook-rail-dot${x.block ? '' : ' on'}`, parent: btn });
        el('span', { cls: 'hs-rail-name', text: this.housing.nameOf(x.r.outputDefId), parent: btn });
        if (x.locked) el('span', { cls: 'cook-rail-lv', text: `Lv.${x.r.benchLevel ?? 1}`, parent: btn });
      }
    }
  }

  private paintSelection(row: RecipeRow | null): void {
    const h = this.housing;
    clear(this.selChip);
    clear(this.selEffects);
    clear(this.selSteps);
    if (!row) {
      this.selChip.appendChild(buildItemChip(undefined, { size: SEL_CHIP }));
      setText(this.selName, '요리를 고르세요');
      setText(this.selSub, '');
      clear(this.selCost);
      this.startBlock = '요리를 고르세요';
      this.paintStart(this.startBlock);
      return;
    }
    const r = row.r;
    const def = h.mealDef(r.outputDefId);
    const steps = cookStepsOf(r.outputDefId);
    this.selChip.appendChild(buildItemChip(def ?? h.defOf(r.outputDefId), { size: SEL_CHIP }));
    setText(this.selName, h.nameOf(r.outputDefId));
    setText(this.selSub, [def?.meal ? mealTierText(def.meal) : '', `조리대 Lv.${r.benchLevel ?? 1}`, `미니게임 ${steps.length}단계`].filter(Boolean).join(' · '));

    // 능력치: ☆ 기준값 → ★★★★★ 보너스 반영 (한 줄에 한 능력치)
    const maxBonus = mealQualityBonus(MEAL_QUALITY_MAX);
    el('div', { cls: 'cook-eff-head', text: `${mealQualityStars(0)} 기준  →  ${mealQualityStars(MEAL_QUALITY_MAX)} +${Math.round(maxBonus * 100)} %`, parent: this.selEffects });
    if (def?.meal) {
      for (const e of mealEffects(def.meal)) {
        const line = el('div', { cls: 'cook-eff-line', parent: this.selEffects });
        el('span', { cls: 'cook-eff-base', text: mealEffectText(e.buff, e.amount), parent: line });
        el('span', { cls: 'cook-eff-arrow', text: '→', parent: line });
        el('span', { cls: 'cook-eff-max', text: effectValueText(e.buff, e.amount * (1 + maxBonus)), parent: line });
      }
    }

    renderCost(this.selCost, r.inputs, h);

    steps.forEach((s, i) => {
      if (i > 0) el('span', { cls: 'cook-stepchip-arrow', text: '→', parent: this.selSteps });
      const c = el('div', { cls: 'cook-stepchip', attrs: { 'data-game': s.game }, parent: this.selSteps });
      el('div', { cls: 'cook-stepchip-main', text: `${CIRCLED[i] ?? ''} ${COOK_GAME_ICON[s.game]} ${COOK_GAME_LABEL_KO[s.game]}`, parent: c });
      const auto = h.getCookAuto(s.game);
      if (auto) {
        const name = h.getFurnitureDef(auto.defId)?.name ?? '자동 조리 가구';
        el('div', { cls: 'cook-stepchip-auto', text: `${name} Lv.${auto.level} · 자동 ${pct(auto.score)} %`, parent: c });
      }
    });

    this.startBlock = row.block;
    this.paintStart(row.block);
  }

  private paintStart(block: string | null): void {
    toggleClass(this.startBtn, 'is-blocked', !!block);
    setText(this.reasonEl, block ?? '');
    this.reasonEl.hidden = !block;
  }

  override dispose(): void {
    this.modal.dispose();
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}
