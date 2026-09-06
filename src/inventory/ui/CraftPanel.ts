import type { CraftRecipe, ItemDef, LoadoutSlot } from '@/shared';
import { WORKBENCH_LABEL_KO } from '@/shared';
import type { BenchRecipeRow, BenchRepairRow, InventorySystem } from '../InventorySystem';
import { SLOT_LABEL, TEXT, fmtSeconds } from './labels';

interface RowView {
  recipe: CraftRecipe;
  locked: boolean;
  el: HTMLElement;
  inputsEl: HTMLElement;
  button: HTMLButtonElement;
  fill: HTMLElement;
}

/**
 * Crafting panel (인벤토리 안의 `제작` 버튼, or a 작업실 bench through `InventoryRef.openBenchCraft`).
 *
 * Normal mode: recipes filtered by station (`field` on a mission, `ship` in the hub) and by the crafting /
 * medicine / gardening skill. **Bench mode** (Phase 6, `sys.getBench()` set): title `WORKBENCH_LABEL_KO[kind] Lv.n`,
 * recipes from `getRecipes('ship', kind, level)` plus **locked rows** for recipes of that bench above its level,
 * material costs scaled by the workshop discount (`sys.craftCost`), and a **repair list** underneath (gun bench:
 * weapons; gear bench: armor + bags) using `sys.repair(uid)` with the same cost readout as the ship workbench.
 * Crafting is *hold to craft*: pressing the button starts `InventorySystem.craft()` and releasing before it
 * finishes cancels it, exactly like a world hold-interaction. The hold time already includes 제작 skill and 재주.
 */
export class CraftPanel {
  readonly el: HTMLElement;
  private titleEl: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private stationEl: HTMLElement;
  private discountEl: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private repairEl: HTMLElement;
  private repairList: HTMLElement;
  private repairEmpty: HTMLElement;
  private repairAllBtn: HTMLButtonElement;
  private repairMsg: HTMLElement;
  private repairMsgTimer: number | null = null;
  private rows: RowView[] = [];
  private sig = '';
  private holding: string | null = null;
  private onWindowUp = (): void => { this.release(); };

  constructor(private readonly sys: InventorySystem, private readonly getDef: (id: string) => ItemDef | undefined) {
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
    this.closeBtn = document.createElement('button');
    this.closeBtn.type = 'button';
    this.closeBtn.className = 'inv-btn inv-craft-close';
    this.closeBtn.textContent = TEXT.bench.close;
    this.closeBtn.hidden = true;
    this.closeBtn.addEventListener('click', () => this.sys.closeBench());
    actions.append(this.discountEl, this.closeBtn);
    head.append(titles, actions);

    this.listEl = document.createElement('div');
    this.listEl.className = 'inv-craft-list';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'inv-craft-empty';
    this.emptyEl.textContent = TEXT.craftNone;

    /* repair list (bench mode only) */
    this.repairEl = document.createElement('div');
    this.repairEl.className = 'inv-craft-repair';
    this.repairEl.hidden = true;
    const rHead = document.createElement('div');
    rHead.className = 'inv-craft-repair-head';
    const rTitle = document.createElement('div');
    rTitle.className = 'inv-eyebrow';
    rTitle.textContent = TEXT.bench.repairTitle;
    this.repairAllBtn = document.createElement('button');
    this.repairAllBtn.type = 'button';
    this.repairAllBtn.className = 'inv-btn inv-repair-all';
    this.repairAllBtn.textContent = TEXT.bench.repairAll;
    this.repairAllBtn.addEventListener('click', () => this.repairAll());
    rHead.append(rTitle, this.repairAllBtn);
    this.repairList = document.createElement('div');
    this.repairList.className = 'inv-repair-list';
    this.repairEmpty = document.createElement('div');
    this.repairEmpty.className = 'inv-craft-empty';
    this.repairEmpty.textContent = TEXT.bench.repairNone;
    this.repairMsg = document.createElement('div');
    this.repairMsg.className = 'inv-repair-msg';
    this.repairMsg.hidden = true;
    this.repairEl.append(rHead, this.repairList, this.repairEmpty, this.repairMsg);

    this.el.append(head, this.listEl, this.emptyEl, this.repairEl);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isOpen(): boolean { return !this.el.hidden; }

  setOpen(open: boolean): void {
    if (this.el.hidden === !open) return;
    this.el.hidden = !open;
    if (!open) { this.release(); this.hideMsg(); }
    else { this.sig = ''; this.refresh(); }
  }

  /** Rebuild the rows when the available recipe set changes; otherwise just repaint counts / progress. */
  refresh(): void {
    if (this.el.hidden) return;
    const bench = this.sys.getBench();
    if (bench) {
      this.stationEl.textContent = TEXT.bench.eyebrow;
      this.titleEl.textContent = `${WORKBENCH_LABEL_KO[bench.kind]} ${TEXT.bench.level(bench.level)}`;
      this.closeBtn.hidden = false;
    } else {
      const station = this.sys.currentStation();
      this.stationEl.textContent = station === 'ship' ? TEXT.craftStationShip : TEXT.craftStationField;
      this.titleEl.textContent = TEXT.craftPanel;
      this.closeBtn.hidden = true;
    }
    const mul = this.sys.craftCostMul();
    this.discountEl.hidden = mul >= 1;
    if (mul < 1) this.discountEl.textContent = TEXT.bench.discount(Math.round((1 - mul) * 100));

    const recipes = this.sys.getBenchRecipes();
    const sig = `${bench ? `${bench.kind}:${bench.level}` : '-'}|${mul}|${recipes.map((r) => `${r.recipe.id}${r.locked ? '!' : ''}`).join('|')}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.build(recipes);
    }
    this.emptyEl.hidden = recipes.length > 0;
    this.paint();
    this.paintRepairs(bench ? this.sys.benchRepairRows() : []);
    this.repairEl.hidden = !bench || (bench.kind !== 'gun' && bench.kind !== 'gear');
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
      this.rows.push({ recipe, locked, el: row, inputsEl: inputs, button, fill });
    }
  }

  private paint(): void {
    const job = this.sys.craftProgress();
    for (const row of this.rows) {
      const ok = !row.locked && this.sys.canCraft(row.recipe.id);
      row.el.classList.toggle('is-locked', !ok);
      row.button.disabled = row.locked || (!ok && job?.recipeId !== row.recipe.id);

      row.inputsEl.innerHTML = '';
      for (const ing of this.sys.craftCost(row.recipe)) {
        const def = this.getDef(ing.defId);
        const have = this.sys.countWhere((d) => d.id === ing.defId);
        const chip = document.createElement('span');
        chip.className = 'inv-craft-chip';
        if (have < ing.qty) chip.classList.add('is-missing');
        chip.textContent = `${def?.name ?? ing.defId} ${have}/${ing.qty}`;
        row.inputsEl.appendChild(chip);
      }
      const time = document.createElement('span');
      time.className = 'inv-craft-chip is-time';
      time.textContent = fmtSeconds(this.sys.craftDuration(row.recipe.id));
      row.inputsEl.appendChild(time);

      const active = job?.recipeId === row.recipe.id;
      row.el.classList.toggle('is-crafting', active);
      row.fill.style.width = active ? `${Math.round(job!.progress * 100)}%` : '0%';
      const label = row.button.querySelector('span');
      if (label) label.textContent = active ? TEXT.craftMaking : TEXT.craftHold;
    }
  }

  /* ── repair list (bench mode) ─────────────────────────────────────────── */

  private paintRepairs(rows: readonly BenchRepairRow[]): void {
    this.repairList.replaceChildren();
    this.repairEmpty.hidden = rows.length > 0;
    let anyAffordable = false;
    for (const r of rows) {
      const max = Math.max(1, r.dur.max);
      const cur = Math.max(0, Math.min(max, r.dur.durability));
      const frac = cur / max;
      const needs = cur < max;
      const canPay = needs && !r.short;
      anyAffordable ||= canPay;

      const row = document.createElement('div');
      row.className = `inv-repair-row${cur <= 0 ? ' is-broken' : ''}${!needs ? ' is-full' : ''}`;
      row.dataset.uid = r.uid;
      const where = document.createElement('div');
      where.className = 'inv-repair-slot';
      where.textContent = r.where ? SLOT_LABEL[r.where as LoadoutSlot] : TEXT.bag;
      const mid = document.createElement('div');
      mid.className = 'inv-repair-mid';
      const name = document.createElement('div');
      name.className = 'inv-repair-name';
      name.textContent = cur <= 0 ? `${r.def.name} · ${TEXT.broken}` : r.def.name;
      const bar = document.createElement('div');
      bar.className = `inv-repair-bar ${frac > 0.5 ? 'ok' : frac > 0.2 ? 'warn' : 'low'}`;
      const fill = document.createElement('i');
      fill.style.width = `${Math.round(frac * 100)}%`;
      bar.appendChild(fill);
      const text = document.createElement('div');
      text.className = 'inv-repair-dur';
      text.textContent = `${Math.round(cur)} / ${Math.round(max)}`;
      mid.append(name, bar, text);
      const cost = document.createElement('div');
      cost.className = `inv-repair-cost${r.short && needs ? ' is-short' : ''}`;
      cost.textContent = !needs ? TEXT.bench.repairDone : r.cost.length === 0 ? '무료' : r.cost.map((c) => `${c.name} ×${c.qty}`).join(' · ');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'inv-btn inv-repair-btn';
      btn.textContent = TEXT.bench.repairBtn;
      btn.disabled = !canPay;
      btn.title = !needs ? TEXT.bench.repairDone : canPay ? '' : TEXT.bench.repairShort;
      btn.addEventListener('click', () => this.repairOne(r.uid));
      row.append(where, mid, cost, btn);
      this.repairList.appendChild(row);
    }
    this.repairAllBtn.disabled = !anyAffordable;
  }

  private repairOne(uid: string): void {
    const ok = this.sys.repair(uid);
    this.sys.sfx(ok ? 'ui_equip' : 'ui_error');
    this.showMsg(ok ? TEXT.bench.repairOk : TEXT.bench.repairFail, ok ? 'ok' : 'bad');
    this.refresh();
  }

  private repairAll(): void {
    const { done, skipped } = this.sys.benchRepairAll();
    this.sys.sfx(done > 0 ? 'ui_equip' : 'ui_error');
    this.showMsg(TEXT.bench.repairAllResult(done, skipped), done > 0 ? 'ok' : 'bad');
    this.refresh();
  }

  private showMsg(text: string, kind: 'ok' | 'bad'): void {
    this.repairMsg.textContent = text;
    this.repairMsg.className = `inv-repair-msg is-${kind}`;
    this.repairMsg.hidden = false;
    if (this.repairMsgTimer !== null) clearTimeout(this.repairMsgTimer);
    this.repairMsgTimer = window.setTimeout(() => this.hideMsg(), 3000);
  }

  private hideMsg(): void {
    if (this.repairMsgTimer !== null) { clearTimeout(this.repairMsgTimer); this.repairMsgTimer = null; }
    this.repairMsg.hidden = true;
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
    this.hideMsg();
    this.el.remove();
  }
}
