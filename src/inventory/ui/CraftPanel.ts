import type { CraftRecipe, ItemDef } from '@/shared';
import { WORKBENCH_LABEL_KO, renderItemCost } from '@/shared';
import type { BenchRecipeRow, InventorySystem } from '../InventorySystem';
import { TEXT } from './labels';

interface RowView {
  recipe: CraftRecipe;
  locked: boolean;
  el: HTMLElement;
  /** Host of the `renderItemCost` chips (Phase 8) — the time chip is its sibling. */
  costsEl: HTMLElement;
  inputsEl: HTMLElement;
  button: HTMLButtonElement;
  fill: HTMLElement;
}

/**
 * Crafting panel (인벤토리 안의 `제작` 버튼, or a 작업실 bench through `InventoryRef.openBenchCraft`).
 *
 * **Phase 8**: the panel is no longer a column of `.inv-layout` — `InventoryUI` adopts `el` into a `Modeless`
 * frame that floats above the window while the grid stays interactive behind it. Only the shell and the material
 * readout changed: costs are `renderItemCost` item chips (`@/shared`) instead of text chips, the 닫기 button is
 * always visible (bench mode leaves the bench, otherwise it closes the popup through `onClose`), and the
 * `break_*` 분해 rows are gone from the list — 분해 lives in the item context menu now (`DisassemblePanel`).
 *
 * Normal mode: recipes filtered by station (`field` on a mission, `ship` in the hub) and by the crafting /
 * medicine / gardening skill. **Bench mode** (Phase 6, `sys.getBench()` set): title `WORKBENCH_LABEL_KO[kind] Lv.n`,
 * recipes from `getRecipes('ship', kind, level)` plus **locked rows** for recipes of that bench above its level, and
 * material costs scaled by the workshop discount (`sys.craftCost`).
 * Crafting is *hold to craft*: pressing the button starts `InventorySystem.craft()` and releasing before it
 * finishes cancels it, exactly like a world hold-interaction.
 *
 * **2026-09-08 (제작 UI 정리)** — three cuts, all the same complaint: this panel is for *making things*.
 *  - The hold is `CRAFT_HOLD_TIME` (1 s) for **every** recipe and the `2.0 s` 시간 칩 is gone. The press is a grace
 *    period before the materials are spent, not a simulation of work — a 돌격소총 was a 6-second press before.
 *  - The **수리 목록 underneath is gone**. `모두 수리` moved into the header (left of 닫기) and opens the modal
 *    `RepairPanel`; a single item is repaired from its right-click menu.
 *  - While the panel is open the window hides 장착 장비 · 퀵슬롯 · 화면 탭 · 가방 헤더의 제작/가치
 *    (`.inv-root.is-craft`, see `parts/Screens.setCraftOpen`) — none of it has anything to do with a recipe list.
 *
 * **2026-09-08 (튜토리얼)**: a recipe `ctx.tutorial.hides('craft', id)` refuses is **left out of the list** rather
 * than drawn with a "튜토리얼에서는 ~" reason — during the guided steps the bench shows exactly the one recipe the
 * step is asking for. The 단계 is part of the rebuild signature, so finishing or skipping the tutorial brings the
 * rest straight back.
 */
export class CraftPanel {
  readonly el: HTMLElement;
  private titleEl: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private stationEl: HTMLElement;
  private discountEl: HTMLElement;
  private closeBtn: HTMLButtonElement;
  /** `ëª¨ë ìë¦¬` â ìë¦¬ë¥¼ íë ììë(íê¸° Â· ì¥ë¹)ììë§ ë³´ì¸ë¤. */
  private repairBtn: HTMLButtonElement;
  private rows: RowView[] = [];
  private sig = '';
  private holding: string | null = null;
  private onWindowUp = (): void => { this.release(); };

  constructor(
    private readonly sys: InventorySystem,
    private readonly getDef: (id: string) => ItemDef | undefined,
    /** Phase 8: the 닫기 button outside bench mode (the window closes the modeless popup). */
    private readonly onClose: () => void = () => {},
    /** 2026-09-08: the header's `모두 수리` — the window opens the `RepairPanel` popup anchored on that button. */
    private readonly onRepair: (anchor: HTMLElement) => void = () => {},
  ) {
    this.el = document.createElement('section');
    this.el.className = 'inv-panel inv-panel-craft';
    this.el.hidden = true;

    const head = document.createElement('header');
    head.className = 'inv-head';
    const titles = document.createElement('div');
    titles.className = 'inv-head-titles';
    this.stationEl = document.createElement('div');
    this.stationEl.className = 'inv-eyebrow';
    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'inv-title';
    this.titleEl.textContent = TEXT.craftPanel;
    titles.append(this.stationEl, this.titleEl);
    const actions = document.createElement('div');
    actions.className = 'inv-head-actions';
    this.discountEl = document.createElement('div');
    this.discountEl.className = 'inv-capacity inv-craft-discount';
    this.discountEl.hidden = true;
    // 2026-09-08: 수리는 패널 하단의 목록이 아니라 헤더의 이 버튼(닫기 왼쪽) → 모달 팝업
    this.repairBtn = document.createElement('button');
    this.repairBtn.type = 'button';
    this.repairBtn.className = 'inv-btn inv-repair-open';
    this.repairBtn.textContent = TEXT.bench.repairAll;
    this.repairBtn.hidden = true;
    this.repairBtn.addEventListener('click', () => this.onRepair(this.repairBtn));
    this.closeBtn = document.createElement('button');
    this.closeBtn.type = 'button';
    this.closeBtn.className = 'inv-btn inv-craft-close';
    this.closeBtn.textContent = TEXT.bench.close;
    this.closeBtn.addEventListener('click', () => {
      if (this.sys.getBench()) this.sys.closeBench(); else this.onClose();
    });
    actions.append(this.discountEl, this.repairBtn, this.closeBtn);
    head.append(titles, actions);

    this.listEl = document.createElement('div');
    this.listEl.className = 'inv-craft-list';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'inv-craft-empty';
    this.emptyEl.textContent = TEXT.craftNone;

    this.el.append(head, this.listEl, this.emptyEl);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isOpen(): boolean { return !this.el.hidden; }

  setOpen(open: boolean): void {
    if (this.el.hidden === !open) return;
    this.el.hidden = !open;
    if (!open) this.release();
    else { this.sig = ''; this.refresh(); }
  }

  /** Rebuild the rows when the available recipe set changes; otherwise just repaint counts / progress. */
  refresh(): void {
    if (this.el.hidden) return;
    const bench = this.sys.getBench();
    if (bench) {
      this.stationEl.textContent = TEXT.bench.eyebrow;
      this.titleEl.textContent = `${WORKBENCH_LABEL_KO[bench.kind]} ${TEXT.bench.level(bench.level)}`;
    } else {
      const station = this.sys.currentStation();
      this.stationEl.textContent = station === 'ship' ? TEXT.craftStationShip : TEXT.craftStationField;
      this.titleEl.textContent = TEXT.craftPanel;
    }
    const mul = this.sys.craftCostMul();
    this.discountEl.hidden = mul >= 1;
    if (mul < 1) this.discountEl.textContent = TEXT.bench.discount(Math.round((1 - mul) * 100));

    const tut = this.sys.ctx.tutorial;
    const recipes = this.sys.getBenchRecipes().filter((r) => !(tut?.hides('craft', r.recipe.id) ?? false));
    const sig = `${bench ? `${bench.kind}:${bench.level}` : '-'}|${mul}|t${tut?.step ?? '-'}`
      + `|${recipes.map((r) => `${r.recipe.id}${r.locked ? '!' : ''}`).join('|')}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.build(recipes);
    }
    this.emptyEl.hidden = recipes.length > 0;
    this.paint();
    // `모두 수리` 버튼은 수리를 하는 작업대에서만 (가젯 · 의료 작업대는 고칠 게 없다)
    this.repairBtn.hidden = !bench || (bench.kind !== 'gun' && bench.kind !== 'gear');
  }

  private build(recipes: readonly BenchRecipeRow[]): void {
    this.listEl.innerHTML = '';
    this.rows = [];
    for (const { recipe, locked } of recipes) {
      const row = document.createElement('div');
      row.className = 'inv-craft-row';
      row.dataset.recipe = recipe.id;
      if (locked) row.classList.add('is-bench-locked');

      const info = document.createElement('div');
      info.className = 'inv-craft-info';
      const name = document.createElement('div');
      name.className = 'inv-craft-name';
      const out = this.getDef(recipe.outputDefId);
      name.textContent = out ? `${recipe.name} → ${out.name} ×${recipe.outputQty}` : recipe.name;
      if (locked) {
        const tag = document.createElement('span');
        tag.className = 'inv-craft-locktag';
        tag.textContent = TEXT.bench.lockedLevel(recipe.benchLevel ?? 1);
        name.appendChild(tag);
      }
      const inputs = document.createElement('div');
      inputs.className = 'inv-craft-inputs';
      const costs = document.createElement('div');
      costs.className = 'inv-craft-costs';
      inputs.appendChild(costs);
      const desc = document.createElement('div');
      desc.className = 'inv-craft-desc';
      desc.textContent = recipe.description;
      info.append(name, inputs, desc);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'inv-btn inv-craft-btn';
      const fill = document.createElement('i');
      fill.className = 'inv-craft-fill';
      const label = document.createElement('span');
      label.textContent = TEXT.craftHold;
      button.append(fill, label);
      if (locked) button.disabled = true;
      else {
        button.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          this.press(recipe.id);
        });
        button.addEventListener('pointerleave', () => this.release());
      }

      row.append(info, button);
      this.listEl.appendChild(row);
      this.rows.push({ recipe, locked, el: row, costsEl: costs, inputsEl: inputs, button, fill });
    }
  }

  private paint(): void {
    const job = this.sys.craftProgress();
    for (const row of this.rows) {
      const ok = !row.locked && this.sys.canCraft(row.recipe.id);
      row.el.classList.toggle('is-locked', !ok);
      row.button.disabled = row.locked || (!ok && job?.recipeId !== row.recipe.id);

      // Phase 8: thumbnail chips with 보유/필요 at the bottom right (dimmed + red 보유 when short)
      renderItemCost(row.costsEl, this.sys.craftCost(row.recipe), this.getDef, (id) => this.sys.countWhere((d) => d.id === id), { size: 30 });
      // 2026-09-08: the `2.0 s` 시간 칩 is gone — every recipe holds for the same `CRAFT_HOLD_TIME` now, so there was
      //   nothing left to tell apart. The button's own fill is the readout.

      const active = job?.recipeId === row.recipe.id;
      row.el.classList.toggle('is-crafting', active);
      row.fill.style.width = active ? `${Math.round(job!.progress * 100)}%` : '0%';
      const label = row.button.querySelector('span');
      if (label) label.textContent = active ? TEXT.craftMaking : TEXT.craftHold;
    }
  }

  /* ── hold to craft ────────────────────────────────────────────────────── */

  private press(recipeId: string): void {
    if (this.holding) return;
    this.holding = recipeId;
    window.addEventListener('pointerup', this.onWindowUp);
    window.addEventListener('pointercancel', this.onWindowUp);
    void this.sys.craft(recipeId).then(() => {
      if (this.holding === recipeId) this.release();
      this.refresh();
    });
    this.paint();
  }

  private release(): void {
    if (!this.holding) return;
    this.holding = null;
    window.removeEventListener('pointerup', this.onWindowUp);
    window.removeEventListener('pointercancel', this.onWindowUp);
    this.sys.cancelCraft();
    this.paint();
  }

  dispose(): void {
    this.release();
    this.el.remove();
  }
}
