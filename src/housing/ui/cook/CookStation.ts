import type { CraftRecipe, EmbeddedView, GameContext, ItemInstance } from '@/shared';
import {
  COOK_GAME_ICON, COOK_GAME_LABEL_KO, MEAL_TIER_LABEL_KO, buildItemChip, cookStepsOf, getMealDef,
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
/** The chip size of the selected meal (px, a layout value). */
const SEL_CHIP = 52;
/** One side of a list row's thumbnail (px, a layout value). 2026-09-17 (user's decision): a 4-cell grid → wide rows stacked vertically (thumbnail · name). */
const CELL_THUMB = 40;

interface RecipeRow {
  r: CraftRecipe;
  /** The cook bench level is short. */
  locked: boolean;
  /** The reason it cannot be started right now (`HousingRef.cookBlock`), null = it can be started. */
  block: string | null;
  /** 2026-09-13 (H3): the reason when it is locked because the recipe book is not shelved (`cookRecipeBookBlock`). */
  book: string | null;
  /** 2026-09-15 (B-15 → restored 2026-09-16): the badge material when it is locked for want of skill (`cookRecipeSkillBlock`). */
  skill: { label: string; need: number; have: number } | null;
  tier: number;
}

/* 2026-09-16 (user's decision, 2nd pass): the skill-lock branch (the `is-skill` badge) was deleted that same morning and then restored — as long as the
   `skillRequired` column stays, raising a csv number alone has to switch it on. With every value 0 today `x.skill` is always null. */
/**
 * The order inside the list — startable now 0 · not locked but blocked (materials · space) 1 · skill-locked 2.
 * Cook bench level (`locked`) and book locks are dropped by `refresh` before the sort, so only `skill` can still rank a row 2 here.
 */
const rowRank = (x: RecipeRow): number => (!x.block ? 0 : x.skill ? 2 : 1);

const pct = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 100);

/**
 * **The cook bench screen** (2026-09-13 — `openCookStation(uid)` ← E on a cook bench · an auto appliance).
 *
 * The frame is the common `StationShell`: [the cook bench card (upgrade at the top right = upgrading the bench)] [stash · bag].
 *
 * **2026-09-15 3rd pass (user's decision — 「모든 제작 관련 UI」 in one shape)**: it took **the same layout** as the workbench craft window
 * (`inventory/ui/CraftPanel`) — inside the cook bench card, **left = the recipe list** (`.cook-list`) · **right = the chosen recipe's detail** (`.cook-detail`).
 *   • **2026-09-17 (user's decision)**: the list is not a 4-cell thumbnail grid but **wide rows stacked vertically** — a row (`.cook-cell[data-recipe]`)
 *     = the thumbnail on the left (the shared chip — the rarity border is the same as everywhere else) + the name on the right. The tier badge · green dot are gone. It scrolls vertically when it overflows.
 *     **What can be made right now comes first** (a stable sort — the csv order stays as it is inside that; the rank is `data-rank`).
 *   • **2026-09-17 (user's decision)**: a meal with no recipe book (`cookRecipeBookBlock`) or short on cook bench level is **not in the list**.
 *     Only the skill lock (B-15, it does not appear today because `skillRequired` is all 0) stays, dimmed + a badge (`.cook-cell-locks`).
 *   • The detail = the thumbnail + the name · the kind (tier · bench Lv · skill · step count) → **the description** → **how many are held** → the stat lines
 *     (2026-09-17: the base values only — the top-quality bonus is not shown) → **the material thumbnails** (no text line — a short material is said by the chip turning red) →
 *     the step chip row (`① ⫽ 썰기 → ② ◎ 젓기`, with an auto appliance `푸드 프로세서 Lv.2 · 자동 60 %` under the chip) → `조리 시작`
 *     (dimmed + a reason line when blocked · a deny sound + a toast when pressed).
 *   ⚠ **There is no quantity stepper** — one meal comes out of one minigame run. There is no hold button either: the materials are taken **when the cook ends**,
 *     so it is not 「an irreversible confirm」, and stopping mid-way spends nothing.
 *   ⚠ `inventory/ui/CraftPanel.CraftDetail` was **not reused as it stands** — that class takes `InventorySystem` (the concrete class) in its
 *     constructor and calls inventory-internal API such as `craftCost` · `maxCraftCount` · `craftProgress`. What housing
 *     holds is only `ctx.inventory: InventoryRef`, and importing another folder's internals is forbidden by CLAUDE.md
 *     (「다른 기능 폴더의 내부를 import 하지 않는다 — `@/shared` 만」). So **only the layout and the grain are matched** and the cook bench goes
 *     with its own implementation — the bench's button is not a craft but `startCook` (starting the minigame), so it behaves differently too.
 *
 * The stash / bag grids are for looking and tidying — the materials are taken by inventory bag → stash when the cook **ends**.
 * Not one rule lives here — the reasons come from `HousingRef.cookBlock` · `startCook`.
 */
export class CookStation extends HousingPanel {
  /** The uid of the open cook bench. */
  benchUid = '';
  selectedRecipeId: string | null = null;
  /** The chosen meal's 「조리 시작」 block reason (smoke tests). */
  startBlock: string | null = null;
  private readonly shell: StationShell;
  private readonly modal: UpgradeModal;
  private grids: EmbeddedView | null = null;
  /** The list composition last written to the DOM — the cells are not rebuilt when it is the same. */
  private railKey = '';
  /** The recipe list on the left (2026-09-17: a list of vertical rows). */
  private readonly listEl: HTMLElement;
  private readonly selChip: HTMLElement;
  private readonly selName: HTMLElement;
  private readonly selSub: HTMLElement;
  /** One paragraph describing the product (2026-09-15 3rd pass). */
  private readonly selDesc: HTMLElement;
  /** How many are held right now (2026-09-15 3rd pass). */
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
    // 2026-09-15 3rd pass (user's decision): instead of the old rail, **the recipe list on the left + the detail on the right** (the same layout as the workbench craft window)
    this.shell.rail.hidden = true;

    const split = el('div', { cls: 'cook-split', parent: this.shell.left });
    this.listEl = el('div', { cls: 'cook-list', parent: split });
    this.listEl.addEventListener('click', (e) => this.onListClick(e));
    const left = el('div', { cls: 'cook-detail', parent: split });

    const head = el('div', { cls: 'cook-sel-head', parent: left });
    this.selChip = el('div', { cls: 'cook-sel-chip', parent: head });
    const ht = el('div', { cls: 'cook-sel-title', parent: head });
    this.selName = el('div', { cls: 'cook-sel-name', parent: ht });
    this.selSub = el('div', { cls: 'cook-sel-sub', parent: ht });
    this.selDesc = el('div', { cls: 'cook-sel-desc', parent: left });
    this.selOwned = el('div', { cls: 'cook-sel-owned', parent: left });
    el('div', { cls: 'ui-label', text: '능력치', parent: left });
    this.selEffects = el('div', { cls: 'cook-sel-effects', parent: left });
    el('div', { cls: 'ui-label', text: '재료', parent: left });
    this.selCost = el('div', { cls: 'cook-sel-cost', parent: left });
    // 2026-09-14 (user's decision): the hover card of a required-item chip sits at the cursor's **top left** (`ui/hud/ItemTip` reads it with `closest`)
    this.selCost.dataset.tipAnchor = 'left';
    el('div', { cls: 'ui-label', text: '조리 순서', parent: left });
    this.selSteps = el('div', { cls: 'cook-sel-steps', parent: left });
    const start = el('div', { cls: 'cook-sel-start', parent: left });
    this.startBtn = this.button(start, '조리 시작', () => this.start(), 'primary cook-start');
    this.reasonEl = el('div', { cls: 'cook-sel-reason', parent: start });
    this.reasonEl.hidden = true;
    // 2026-09-17 (user's decision): the 「재료는 요리가 끝날 때 빠집니다 …」 note under the detail was taken out

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'hint', text: '미니게임 점수가 요리 품질(별)이 되고, 품질이 높을수록 먹었을 때 능력치가 더 오릅니다.', parent: el('div', { cls: 'left', parent: foot }) });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    this.modal = new UpgradeModal(ctx, this.root, housing);
    this.overlays.push(this.modal);
    // 2026-09-16: the 「식탁의 요리를 바꿉니다」 warning is a popup inside this screen too — E · Tab close the warning, not the screen (= cancel)
    const ask: PanelOverlay = {
      get isOpen() { return !!housing.plateAsk?.handle.isOpen; },
      close: () => housing.plateAsk?.handle.cancel(),
    };
    this.overlays.push(ask);
    // when the plate on the dining table changes, the detail's 「식탁」 line changes
    this.unsubs.push(ctx.bus.on('housing:tablePlatesChanged', () => this.refreshIfOpen()));
    // 2026-09-13 (H3): shelving or pulling a recipe book changes the locks · and the library cooking bonus
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
    closePlateAsk(this.housing);            // 2026-09-16: when the screen closes with the warning up, it is taken down without confirming
    this.grids?.dispose();
    this.grids = null;
    super.close(relock);
    if (wasOpen) this.ctx.bus.emit('ui:cookStationToggled', { open: false, uid: null });
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  private dropOn(_item: ItemInstance, _target: HTMLElement | null): void {
    this.showMsg('재료는 넣지 않아도 됩니다 — 조리가 끝날 때 가방 · 함선 창고에서 빠집니다', 'info');
  }

  /** Picks a meal from the recipe list (smoke tests use it too — the rail itself is hidden since the 2026-09-15 3rd pass). */
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
   * 「조리 시작」 — when it is blocked, a deny sound + a toast. On a start this screen closes and the cook overlay opens.
   * 2026-09-16 (the plate model, user's decision): when a plate is already on the dining table, the 1 s hold warning 「식탁의 요리를 바꿉니다」 goes up **before** starting
   * (`ui/cook/PlateAsk`) — null is returned then, and it starts once confirmed. `skipAsk` = smoke tests · a confirm that has already passed the warning.
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

  /* ── Upgrade (the modal) ───────────────────────────────────────────────── */
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
    // 2026-09-17 (user's decision): a meal with no recipe book or short on cook bench level is dropped from the list — only the skill lock (B-15) stays dimmed
    const rows: RecipeRow[] = cookRecipes(h).map((r) => ({
      r,
      locked: (r.benchLevel ?? 1) > level,
      block: bench ? h.cookBlock(this.benchUid, r.id) : '조리대가 없습니다',
      book: cookRecipeBookBlock(h, r),
      skill: cookRecipeSkillBlock(h, r),
      tier: h.mealDef(r.outputDefId)?.meal?.tier ?? 0,
    })).filter((x) => !x.locked && !x.book).map((x, i) => ({ x, i }))
      // 2026-09-15 3rd pass (user's decision): **what can be made right now comes first** — tier order inside that, csv order inside that (a stable sort)
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
   * The list on the left = **wide rows stacked vertically** (2026-09-17, user's decision — replacing the old 4-cell thumbnail grid): a row = the thumbnail (the shared
   * chip, the rarity border) + the name. A row is `.cook-cell[data-recipe][data-rank]` and carries the old name `.cook-rail-item` as well (smoke tests · old selectors).
   * Meals locked by cook bench level · book were already dropped by `refresh`. Short on materials · space gives `.is-locked`, short on skill gives
   * `.is-bench-locked .is-skill` + a badge under the name (B-15 — it does not appear today because csv `skillRequired` is all 0).
   */
  private buildList(rows: readonly RecipeRow[]): void {
    const list = this.listEl;
    clear(list);
    if (!rows.length) { el('div', { cls: 'hs-empty cook-list-empty', text: '만들 수 있는 요리가 없습니다.', parent: list }); return; }
    const inv = this.ctx.inventory;
    for (const x of rows) {
      const cell = el('button', {
        cls: `cook-cell cook-rail-item${x.r.id === this.selectedRecipeId ? ' is-on is-active' : ''}`
          + `${x.skill ? ' is-bench-locked is-locked is-skill' : x.block ? ' is-locked' : ''}`,
        attrs: { 'data-recipe': x.r.id, 'data-rank': String(rowRank(x)) },
        parent: list,
      });
      cell.type = 'button';
      // 2026-09-16 (the plate model): the product is not an item but a meal from the meal table — the inventory tile (`buildItemTile`) knows no meals, so the shared chip draws it
      const def = getMealDef(x.r.outputDefId);
      const name = def?.name ?? this.housing.nameOf(x.r.outputDefId);
      const thumb = el('div', { cls: 'cook-cell-thumb', parent: cell });
      if (def || !inv || typeof inv.buildItemTile !== 'function') thumb.appendChild(buildItemChip(def, { size: CELL_THUMB }));
      else thumb.appendChild(inv.buildItemTile(x.r.outputDefId, x.r.outputQty, { cell: CELL_THUMB }));
      const text = el('div', { cls: 'cook-cell-text', parent: cell });
      el('div', { cls: 'cook-cell-name', text: name, parent: text });
      const why: string[] = [];
      if (x.skill) {
        const locks = el('span', { cls: 'cook-rail-locks cook-cell-locks', parent: text });
        el('span', { cls: 'cook-rail-lv cook-rail-skill', text: `${x.skill.label} ${x.skill.need}`, parent: locks });
        why.push(`${x.skill.label} 숙련 ${x.skill.need} 필요 (지금 ${x.skill.have})`);
      }
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
    // 2026-09-15 (B-15): when skill is short, the subtitle says what to raise too
    const skillNeed = row.skill ? `${row.skill.label} 숙련 ${row.skill.need}` : '';
    setText(this.selSub, [def?.meal ? mealTierText(def.meal) : '', `조리대 Lv.${r.benchLevel ?? 1}`, skillNeed, `미니게임 ${steps.length}단계`].filter(Boolean).join(' · '));
    // 2026-09-15 3rd pass (user's decision): the description · how many are held — the same order as the workbench detail panel (thumbnail · name · kind → description → held → materials)
    const desc = (def ?? h.defOf(r.outputDefId))?.description ?? '';
    setText(this.selDesc, desc);
    this.selDesc.hidden = !desc;
    // 2026-09-16 (the plate model): instead of 「보유 n」, **what is on the dining table** — cooking replaces this plate
    const plate = h.getPlate();
    const plateName = plate ? qualityName(getMealDef(plate.mealDefId)?.name ?? plate.mealDefId, plate.quality) : '';
    setText(this.selOwned, plate ? `식탁: 「${plateName}」 — 요리하면 바뀝니다` : '식탁: 비어 있음');
    toggleClass(this.selOwned, 'is-none', !plate);

    // Stats: the base values only (one stat per line). 2026-09-17 (user's decision): the value with the top-quality (★★★★★) bonus folded in is not shown
    if (def?.meal) {
      for (const e of mealEffects(def.meal)) {
        const line = el('div', { cls: 'cook-eff-line', parent: this.selEffects });
        el('span', { cls: 'cook-eff-base', text: mealEffectText(e.buff, e.amount), parent: line });
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
      // 2026-09-13 (H3): the cooking skill · library bonus added to this step's score (manual and auto alike)
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
