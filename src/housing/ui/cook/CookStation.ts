import type { CraftRecipe, EmbeddedView, GameContext, ItemInstance, MealBuff } from '@/shared';
import {
  COOK_GAME_ICON, COOK_GAME_LABEL_KO, MEAL_BUFF_UNIT, MEAL_QUALITY_MAX, MEAL_TIER_LABEL_KO, buildItemChip, cookStepsOf,
  getMealDef, mealQualityBonus, mealQualityStars,
} from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import { furnitureMaxLevel, nextFurnitureCost } from '../../Rules';
import { cookBenchAt, cookRecipeBookBlock, cookRecipeSkillBlock, cookRecipes, cookStepBonus } from '../../parts/Cooking';
import { mealEffectText, mealEffects, mealTierText, qualityName } from '../DiningTable';
import { HousingPanel } from '../Panel';
import type { PanelOverlay } from '../Panel';
import { askReplacePlate, closePlateAsk } from './PlateAsk';
import { buildStationShell, mountStationGrids, paintStationLevel, paintStationMeta } from '../StationShell';
import type { StationShell } from '../StationShell';
import { UpgradeModal } from '../UpgradeModal';
import type { UpgradeSpec } from '../UpgradeModal';
import { clear, el, renderCost, setText, toggleClass } from '../dom';
import './cook.css';

const CIRCLED = ['①', '②', '③', '④', '⑤'];
/** 선택한 요리의 칩 크기 (px, 레이아웃 값). */
const SEL_CHIP = 52;
/**
 * 왼쪽 목록의 가로 칸 수 (2026-09-15 3차, 사용자 결정 「가로 최대 4칸」) — 작업대 제작 창의 `CRAFT_LIST_COLS` 와 같은 값이다.
 * 그 상수는 `inventory/ui/CraftPanel` 에 있고 폴더 간 import 이 금지라 여기서 다시 적는다 (밸런스가 아니라 **레이아웃** 값이다).
 * CSS 는 `--cook-cols` 로 받는다.
 */
const COOK_LIST_COLS = 4;
/** 목록 칸의 썸네일 한 변 (px, 레이아웃 값). */
const CELL_THUMB = 48;

interface RecipeRow {
  r: CraftRecipe;
  /** 조리대 레벨이 모자란다. */
  locked: boolean;
  /** 지금 시작할 수 없는 사유 (`HousingRef.cookBlock`), null = 시작할 수 있다. */
  block: string | null;
  /** 2026-09-13 (H3): 레시피 책이 꽂혀 있지 않아 잠겼으면 그 사유 (`cookRecipeBookBlock`). */
  book: string | null;
  /** 2026-09-15 (B-15 → 2026-09-16 복원): 숙련이 모자라 잠겼으면 배지 재료 (`cookRecipeSkillBlock`). */
  skill: { label: string; need: number; have: number } | null;
  tier: number;
}

/* 2026-09-16 (사용자 결정 2차): 숙련 잠김 갈래(`is-skill` 배지)는 같은 날 오전에 지웠다가 되살렸다 — `skillRequired`
   열을 남겨 둔 이상 csv 숫자만 올리면 켜져야 한다. 값이 전부 0 인 지금은 `x.skill` 이 언제나 null 이다. */
/** 레일 안 순서 — 지금 시작할 수 있음 0 · 잠기지 않았지만 막힘(재료 · 자리) 1 · 잠김(조리대 레벨 · 숙련 · 책) 2. */
const rowRank = (x: RecipeRow): number => (!x.block ? 0 : x.locked || x.skill || x.book ? 2 : 1);

const pct = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 100);

/** 능력치 값만 (`+5 %`) — `mealEffectText` 에서 이름을 뗀 것. 단위 규칙은 계약 `MEAL_BUFF_UNIT` 그대로. */
function effectValueText(buff: MealBuff, amount: number): string {
  const unit = MEAL_BUFF_UNIT[buff] ?? '';
  const value = unit === '%' ? amount * 100 : amount;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded)}${unit ? ` ${unit}` : ''}`;
}

/**
 * **조리대 화면** (2026-09-13, `docs/DECISIONS.md` 「2026-09-13 — 요리 미니게임」 — `openCookStation(uid)` ← E on a 조리대 · 자동 조리 가구).
 *
 * 틀은 `StationShell` 공통이다: [조리대 카드(우상단 업그레이드 = 조리대 강화)] [창고 · 가방].
 *
 * **2026-09-15 3차 (사용자 결정 — 「모든 제작 관련 UI」를 한 모양으로)**: 작업대 제작 창(`inventory/ui/CraftPanel`)과
 * **같은 배치**가 됐다 — 조리대 카드 안이 **왼쪽 = 산출물 썸네일만의 격자**(`.cook-list`, 가로 `COOK_LIST_COLS` 칸) ·
 * **오른쪽 = 고른 요리의 상세**(`.cook-detail`)다. 옛 세로 레일(`.hs-rail.cook-rail`)은 걷어냈다.
 *   • 목록 칸(`.cook-cell[data-recipe]`)은 산출물 썸네일 하나 + 티어 배지이고, **지금 만들 수 있는 것이 앞으로**
 *     온다(안정 정렬 — csv 순서는 그 안에서 그대로). 재료 · 숙련 · 책 · 조리대 레벨이 바뀌면 다시 정렬한다.
 *   • **2026-09-15 (B-15) 숙련 잠김 표시는 그대로 살아 있다** — 숙련 · 책 · 조리대 레벨이 모자란 요리도 목록에
 *     **딤드(`.is-bench-locked`) + 배지**로 남고(`.cook-cell-locks`), 고르면 상세까지 다 보이며 **시작만** 막힌다.
 *   • 상세 = 썸네일 + 이름 · 종류(티어 · 조리대 Lv · 숙련 · 단계 수) → **설명** → **보유 수** → 능력치 줄
 *     (☆ 기준 → ★★★★★ 보너스 반영) → **재료 썸네일**(글자 줄 없음 — 모자란 것은 칩이 빨갛게 말한다) →
 *     단계 칩 줄(`① ⫽ 썰기 → ② ◎ 젓기`, 자동 가구가 있으면 칩 아래 `푸드 프로세서 Lv.2 · 자동 60 %`) → `조리 시작`
 *     (막히면 딤드 + 사유 줄 · 누르면 거절음 + 토스트).
 *   ⚠ **수량 스테퍼는 없다** — 요리는 미니게임 한 판에 하나다. 홀드 버튼도 없다: 재료는 조리가 **끝날 때** 빠지므로
 *     「되돌릴 수 없는 확정」이 아니고, 중간에 그만두면 아무것도 쓰지 않는다.
 *   ⚠ `inventory/ui/CraftPanel.CraftDetail` 을 **그대로 쓰지 않았다** — 그 클래스는 `InventorySystem`(구체 클래스)을
 *     생성자로 받고 `craftCost` · `maxCraftCount` · `craftProgress` 같은 인벤토리 내부 API 를 부른다. housing 이
 *     가진 것은 `ctx.inventory: InventoryRef` 뿐이고, 폴더 내부를 import 하는 것은 CLAUDE.md 가 금지한다
 *     (「다른 기능 폴더의 내부를 import 하지 않는다 — `@/shared` 만」). 그래서 **배치와 결만 맞추고** 조리대는
 *     자기 구현으로 간다 — 조리대의 버튼은 제작이 아니라 `startCook`(미니게임 시작)이라 동작도 다르다.
 *
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
  /** 마지막으로 DOM 에 반영한 목록 구성 — 같으면 칸을 다시 만들지 않는다. */
  private railKey = '';
  /** 왼쪽 산출물 썸네일 격자 (2026-09-15 3차). */
  private readonly listEl: HTMLElement;
  private readonly selChip: HTMLElement;
  private readonly selName: HTMLElement;
  private readonly selSub: HTMLElement;
  /** 산출물 설명 한 문단 (2026-09-15 3차). */
  private readonly selDesc: HTMLElement;
  /** 지금 가진 개수 (2026-09-15 3차). */
  private readonly selOwned: HTMLElement;
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
    // 2026-09-15 3차 (사용자 결정): 세로 레일 대신 **왼쪽 썸네일 격자 + 오른쪽 상세** (작업대 제작 창과 같은 배치)
    this.shell.rail.hidden = true;

    const split = el('div', { cls: 'cook-split', parent: this.shell.left });
    this.listEl = el('div', { cls: 'cook-list', parent: split });
    this.listEl.style.setProperty('--cook-cols', String(COOK_LIST_COLS));
    this.listEl.addEventListener('click', (e) => this.onListClick(e));
    const left = el('div', { cls: 'cook-detail', parent: split });

    const head = el('div', { cls: 'cook-sel-head', parent: left });
    this.selChip = el('div', { cls: 'cook-sel-chip', parent: head });
    const ht = el('div', { cls: 'cook-sel-title', parent: head });
    this.selName = el('div', { cls: 'cook-sel-name', parent: ht });
    this.selSub = el('div', { cls: 'cook-sel-sub', parent: ht });
    this.selDesc = el('div', { cls: 'cook-sel-desc', parent: left });
    this.selOwned = el('div', { cls: 'cook-sel-owned', parent: left });
    el('div', { cls: 'ui-label', text: '능력치 · 요리 품질', parent: left });
    this.selEffects = el('div', { cls: 'cook-sel-effects', parent: left });
    el('div', { cls: 'ui-label', text: '재료', parent: left });
    this.selCost = el('div', { cls: 'cook-sel-cost', parent: left });
    // 2026-09-14 (사용자 결정): 필요 아이템 칩의 호버 카드는 커서 **좌상단**이다 (`ui/hud/ItemTip` 이 `closest` 로 읽는다)
    this.selCost.dataset.tipAnchor = 'left';
    el('div', { cls: 'ui-label', text: '조리 순서', parent: left });
    this.selSteps = el('div', { cls: 'cook-sel-steps', parent: left });
    const start = el('div', { cls: 'cook-sel-start', parent: left });
    this.startBtn = this.button(start, '조리 시작', () => this.start(), 'primary cook-start');
    this.reasonEl = el('div', { cls: 'cook-sel-reason', parent: start });
    this.reasonEl.hidden = true;
    el('div', {
      cls: 'hint cook-sel-note',
      // 2026-09-16 (접시 모델, 사용자 결정): 요리는 아이템이 아니라 식탁의 접시다 — 함선당 한 접시, 다시 만들면 바뀐다
      text: '재료는 요리가 끝날 때 빠집니다 — 중간에 그만두면 아무것도 쓰지 않습니다. 완성된 요리는 식탁에 차려집니다 (함선당 한 접시, 다음 레이드가 시작되면 치워집니다).',
      parent: left,
    });

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'hint', text: '미니게임 점수가 요리 품질(별)이 되고, 품질이 높을수록 먹었을 때 능력치가 더 오릅니다.', parent: el('div', { cls: 'left', parent: foot }) });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    this.modal = new UpgradeModal(ctx, this.root, housing);
    this.overlays.push(this.modal);
    // 2026-09-16: 「식탁의 요리를 바꿉니다」 경고도 이 화면 안의 팝업이다 — E · Tab 은 화면이 아니라 경고를 닫는다(= 취소)
    const ask: PanelOverlay = {
      get isOpen() { return !!housing.plateAsk?.handle.isOpen; },
      close: () => housing.plateAsk?.handle.cancel(),
    };
    this.overlays.push(ask);
    // 식탁의 접시가 바뀌면 상세의 「식탁」 줄이 바뀐다
    this.unsubs.push(ctx.bus.on('housing:tablePlatesChanged', () => this.refreshIfOpen()));
    // 2026-09-13 (H3): 레시피 책을 꽂거나 빼면 잠김이 바뀐다 · 서재 요리 보너스도
    this.unsubs.push(ctx.bus.on('housing:libraryChanged', () => { this.railKey = ''; this.refreshIfOpen(); }));
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
    closePlateAsk(this.housing);            // 2026-09-16: 경고가 떠 있던 채 화면이 닫히면 확정 없이 걷는다
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

  private onListClick(e: MouseEvent): void {
    const id = (e.target as Element | null)?.closest<HTMLElement>('.cook-cell[data-recipe]')?.dataset.recipe;
    if (!id || id === this.selectedRecipeId) return;
    e.stopPropagation();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.select(id);
  }

  /**
   * 「조리 시작」 — 막혀 있으면 거절음 + 토스트. 시작하면 이 화면은 닫히고 조리 오버레이가 열린다.
   * 2026-09-16 (접시 모델, 사용자 결정): 식탁에 접시가 이미 있으면 **시작하기 전에** 「식탁의 요리를 바꿉니다」 1 초 홀드 경고를 띄운다
   * (`ui/cook/PlateAsk`) — 그때는 null 을 돌려주고, 확정되면 시작한다. `skipAsk` = 스모크 · 경고를 이미 지난 확정.
   */
  start(skipAsk = false): string | null {
    const id = this.selectedRecipeId;
    if (!id) { this.deny('요리를 고르세요'); return '요리를 고르세요'; }
    const block = this.housing.cookBlock(this.benchUid, id);
    if (block) { this.deny(block); return block; }
    const uid = this.benchUid;
    const mealId = cookRecipes(this.housing).find((r) => r.id === id)?.outputDefId ?? '';
    if (!skipAsk && askReplacePlate(this.housing, mealId, () => {
      const r = this.housing.startCook(uid, id);
      if (r) { this.ctx.bus.emit('audio:play', { id: 'ui_deny' }); this.ctx.bus.emit('ui:notify', { text: r, kind: 'warning' }); }
    })) return null;
    const reason = this.housing.startCook(uid, id);
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
    // 2026-09-15 (B-15): 숙련 잠김 요리도 레일에 있다 — 티어 안에서 시작할 수 있는 것 → 막힌 것 → 잠긴 것 (그 밖의 순서는 표 그대로, 안정 정렬)
    const rows: RecipeRow[] = cookRecipes(h).map((r) => ({
      r,
      locked: (r.benchLevel ?? 1) > level,
      block: bench ? h.cookBlock(this.benchUid, r.id) : '조리대가 없습니다',
      book: cookRecipeBookBlock(h, r),
      skill: cookRecipeSkillBlock(h, r),
      tier: h.mealDef(r.outputDefId)?.meal?.tier ?? 0,
    })).map((x, i) => ({ x, i }))
      // 2026-09-15 3차 (사용자 결정): **지금 만들 수 있는 것이 앞으로** — 그 안에서 티어 순, 그 안에서 csv 순 (안정 정렬)
      .sort((a, b) => rowRank(a.x) - rowRank(b.x) || a.x.tier - b.x.tier || a.i - b.i)
      .map(({ x }) => x);
    if (!this.selectedRecipeId || !rows.some((x) => x.r.id === this.selectedRecipeId)) {
      this.selectedRecipeId = (rows.find((x) => !x.block) ?? rows.find((x) => rowRank(x) < 2) ?? rows[0])?.r.id ?? null;
    }
    const ready = rows.filter((x) => !x.block).length;
    paintStationMeta(this.shell, rows.length ? `지금 만들 수 있는 요리 ${ready}` : '');
    const key = `${rows.map((x) => `${x.r.id}:${x.locked ? 1 : 0}:${x.book ? 1 : 0}:${x.skill ? 1 : 0}:${x.block ? 0 : 1}`).join('|')}#${this.selectedRecipeId}`;
    if (key !== this.railKey) { this.railKey = key; this.buildList(rows); }
    this.paintSelection(rows.find((x) => x.r.id === this.selectedRecipeId) ?? null);
    this.modal.refresh();
  }

  /**
   * 왼쪽 목록 = **산출물 썸네일만의 격자** (2026-09-15 3차, 사용자 결정 — 작업대 제작 창의 `.inv-craft-list` 와 같은 결).
   * 칸은 `.cook-cell[data-recipe]` 이고 옛 이름 `.cook-rail-item` 도 함께 단다 (스모크 · 옛 선택자).
   * 딤드는 두 갈래다 — 지금 재료 · 자리가 모자라면 `.is-locked`, 조리대 레벨 · 숙련 · 책이 모자라면 `.is-bench-locked`
   * (2026-09-15 B-15 그대로: **목록에서 사라지지 않고** 배지로 무엇이 모자란지 말한다).
   */
  private buildList(rows: readonly RecipeRow[]): void {
    const list = this.listEl;
    clear(list);
    if (!rows.length) { el('div', { cls: 'hs-empty cook-list-empty', text: '만들 수 있는 요리가 없습니다.', parent: list }); return; }
    const inv = this.ctx.inventory;
    for (const x of rows) {
      const gated = !!(x.locked || x.book || x.skill);
      const cell = el('button', {
        // `is-book` · `is-skill` 은 **잠김 갈래를 구분하는 표시**다 (옛 레일과 같은 이름 — 스모크도 이것으로 읽는다)
        cls: `cook-cell cook-rail-item${x.r.id === this.selectedRecipeId ? ' is-on is-active' : ''}`
          + `${gated ? ' is-bench-locked is-locked' : x.block ? ' is-locked' : ''}${x.book ? ' is-book' : ''}${x.skill ? ' is-skill' : ''}`,
        attrs: { 'data-recipe': x.r.id },
        parent: list,
      });
      cell.type = 'button';
      // 2026-09-16 (접시 모델): 산출물은 아이템이 아니라 요리 표의 요리다 — 인벤토리 타일(`buildItemTile`)은 요리를 모르므로 공용 칩으로 그린다
      const def = getMealDef(x.r.outputDefId);
      const name = def?.name ?? this.housing.nameOf(x.r.outputDefId);
      const thumb = el('div', { cls: 'cook-cell-thumb', parent: cell });
      if (def || !inv || typeof inv.buildItemTile !== 'function') thumb.appendChild(buildItemChip(def, { size: CELL_THUMB }));
      else thumb.appendChild(inv.buildItemTile(x.r.outputDefId, x.r.outputQty, { cell: CELL_THUMB }));
      if (x.tier > 0) el('span', { cls: 'cook-cell-tier', text: `T${x.tier}`, parent: cell });
      // 지금 만들 수 있으면 초록 점 (옛 레일의 표시 그대로)
      el('i', { cls: `cook-rail-dot cook-cell-dot${x.block ? '' : ' on'}`, parent: cell });
      const why: string[] = [];
      if (x.book) why.push(x.book);
      if (x.locked || x.skill) {
        // 2026-09-15 (B-15): 조리대 레벨 · 숙련 — 모자란 것마다 배지 하나 (둘 다면 둘), 호버 = 무엇이 모자란지
        const locks = el('span', { cls: 'cook-rail-locks cook-cell-locks', parent: cell });
        if (x.locked) {
          el('span', { cls: 'cook-rail-lv', text: `Lv.${x.r.benchLevel ?? 1}`, parent: locks });
          why.push(`조리대 Lv.${x.r.benchLevel ?? 1} 필요`);
        }
        if (x.skill) {
          el('span', { cls: 'cook-rail-lv cook-rail-skill', text: `${x.skill.label} ${x.skill.need}`, parent: locks });
          why.push(`${x.skill.label} 숙련 ${x.skill.need} 필요 (지금 ${x.skill.have})`);
        }
      }
      if (x.book) el('span', { cls: 'cook-rail-lv cook-rail-book cook-cell-book', text: '책', parent: cell });
      const tierName = MEAL_TIER_LABEL_KO[x.tier as 1 | 2 | 3 | 4] ?? '';
      cell.title = [name, tierName, ...why].filter(Boolean).join(' · ');
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
      setText(this.selDesc, '');
      setText(this.selOwned, '');
      clear(this.selCost);
      this.startBlock = '요리를 고르세요';
      this.paintStart(this.startBlock);
      return;
    }
    const r = row.r;
    const def = h.mealDef(r.outputDefId);
    const steps = cookStepsOf(r.outputDefId);
    this.selChip.appendChild(buildItemChip(def ?? h.defOf(r.outputDefId), { size: SEL_CHIP }));
    setText(this.selName, def?.name ?? h.nameOf(r.outputDefId));
    // 2026-09-15 (B-15): 숙련이 모자라면 무엇을 올려야 하는지 부제에도
    const skillNeed = row.skill ? `${row.skill.label} 숙련 ${row.skill.need}` : '';
    setText(this.selSub, [def?.meal ? mealTierText(def.meal) : '', `조리대 Lv.${r.benchLevel ?? 1}`, skillNeed, `미니게임 ${steps.length}단계`].filter(Boolean).join(' · '));
    // 2026-09-15 3차 (사용자 결정): 설명 · 보유 수 — 작업대 상세 패널과 같은 순서 (썸네일 · 이름 · 종류 → 설명 → 보유 → 재료)
    const desc = (def ?? h.defOf(r.outputDefId))?.description ?? '';
    setText(this.selDesc, desc);
    this.selDesc.hidden = !desc;
    // 2026-09-16 (접시 모델): 「보유 n」 대신 **식탁에 무엇이 있나** — 요리하면 이 접시가 바뀐다
    const plate = h.getPlate();
    const plateName = plate ? qualityName(getMealDef(plate.mealDefId)?.name ?? plate.mealDefId, plate.quality) : '';
    setText(this.selOwned, plate ? `식탁: 「${plateName}」 — 요리하면 바뀝니다` : '식탁: 비어 있음');
    toggleClass(this.selOwned, 'is-none', !plate);

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
      // 2026-09-13 (H3): 이 단계 점수에 더해지는 요리 숙련 · 서재 보너스 (직접 하기 · 자동 모두)
      const bonus = cookStepBonus(h, s.game);
      if (bonus.total > 0) {
        const parts = [bonus.skill > 0 ? `숙련 +${Math.round(bonus.skill * 100)}` : '', bonus.library > 0 ? `서재 +${Math.round(bonus.library * 100)}` : ''].filter(Boolean);
        el('div', { cls: 'cook-stepchip-bonus', text: `점수 +${Math.round(bonus.total * 100)} (${parts.join(' · ')})`, parent: c });
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
