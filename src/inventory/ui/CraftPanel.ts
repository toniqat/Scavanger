import type { CraftRecipe, ItemDef } from '@/shared';
import type { InventorySystem } from '../InventorySystem';
import { TEXT, fmtSeconds } from './labels';

interface RowView {
  recipe: CraftRecipe;
  el: HTMLElement;
  inputsEl: HTMLElement;
  button: HTMLButtonElement;
  fill: HTMLElement;
}

/**
 * Field-crafting panel (인벤토리 안의 `제작` 버튼 → `ui:craftToggled`).
 *
 * Recipes are filtered by station (`field` on a mission, `ship` in the hub) and by the crafting /
 * medicine / gardening skill. Crafting is *hold to craft*: pressing the button starts
 * `InventorySystem.craft()` and releasing before it finishes cancels it, exactly like a world
 * hold-interaction. The hold time already includes 제작 skill and 재주.
 */
export class CraftPanel {
  readonly el: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private stationEl: HTMLElement;
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
    const title = document.createElement('h2');
    title.className = 'inv-title';
    title.textContent = TEXT.craftPanel;
    titles.append(this.stationEl, title);
    head.appendChild(titles);

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
    const station = this.sys.currentStation();
    this.stationEl.textContent = station === 'ship' ? TEXT.craftStationShip : TEXT.craftStationField;
    const recipes = this.sys.getRecipes(station);
    const sig = recipes.map((r) => r.id).join('|');
    if (sig !== this.sig) {
      this.sig = sig;
      this.build(recipes);
    }
    this.emptyEl.hidden = recipes.length > 0;
    this.paint();
  }

  private build(recipes: readonly CraftRecipe[]): void {
    this.listEl.innerHTML = '';
    this.rows = [];
    for (const recipe of recipes) {
      const row = document.createElement('div');
      row.className = 'inv-craft-row';

      const info = document.createElement('div');
      info.className = 'inv-craft-info';
      const name = document.createElement('div');
      name.className = 'inv-craft-name';
      const out = this.getDef(recipe.outputDefId);
      name.textContent = out ? `${recipe.name} → ${out.name} ×${recipe.outputQty}` : recipe.name;
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
      button.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.press(recipe.id);
      });
      button.addEventListener('pointerleave', () => this.release());

      row.append(info, button);
      this.listEl.appendChild(row);
      this.rows.push({ recipe, el: row, inputsEl: inputs, button, fill });
    }
  }

  private paint(): void {
    const job = this.sys.craftProgress();
    for (const row of this.rows) {
      const ok = this.sys.canCraft(row.recipe.id);
      row.el.classList.toggle('is-locked', !ok);
      row.button.disabled = !ok && job?.recipeId !== row.recipe.id;

      row.inputsEl.innerHTML = '';
      for (const ing of row.recipe.inputs) {
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
