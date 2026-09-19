import type { CraftRecipe, ItemDef, RoomPurpose, WorkbenchKind } from '@/shared';
import { FURNITURE_DEFS, WORKBENCH_ICON, WORKBENCH_KINDS, WORKBENCH_LABEL_KO, benchKindOf, createHoldButtonCap, renderItemCost } from '@/shared';
import { getWeaponDef } from '@/items';
import type { BenchRecipeRow, InventorySystem } from '../InventorySystem';
import { buildTileContent, favoritesRevision, shelfWantedRevision } from './GridView';
import { Tooltip } from './Tooltip';
import { inventoryTooltipLookups } from './TipPin';
import { CELL, TEXT, categoryLabel, rarityColor, rarityLabel, weaponClassLabel } from './labels';
import type { ItemInstance } from '@/shared';

/**
 * One entry of the bench list down the left (2026-09-12). `null` = **quick craft** (what is made with no workbench);
 * the rest are the `WorkbenchKind`s actually placed on this ship.
 */
type BenchPick = WorkbenchKind | null;

/** Is this recipe 「quick craft」 — `station: 'field'` means it can be made with no workbench. */
/* A field recipe is quick craft even when it carries its own bench tag — that list means "what can be made without
 * a workbench". (Since 2026-09-10 ammo · bandages · smoke carry a `bench` too; that only marks the bench window.) */
const isFieldRecipe = (r: CraftRecipe): boolean => r.station === 'field';

/**
 * Columns of the recipe list (2026-09-15 4th pass, user's decision 「4 → 5 cells」 — the grids left, freeing the room).
 * CSS reads `--inv-craft-cols` off the panel root (`.inv-panel-craft`), so the list grid and the panel width agree.
 */
export const CRAFT_LIST_COLS = 5;

/**
 * The recipe cell's **hover card** (2026-09-15 4th pass, user's decision) — hovering one shows the product's tooltip.
 * The card belongs to the window (`InventoryUI.tooltip`); this panel only signals, like `CatalogView`'s `CatalogHandlers`.
 * `sample` is one batch of that recipe's product (`loot.createItem`, placed nowhere).
 */
export interface CraftHoverHandlers {
  onEnter(def: ItemDef, sample: ItemInstance, e: PointerEvent): void;
  onMove(e: PointerEvent): void;
  onLeave(): void;
}

/**
 * **The facility a workbench belongs to** (2026-09-13, user's decision). The source is `data/furniture.csv`'s `room`
 * column — the room purpose of the furniture whose interaction is `workbench_<kind>` (`benchKindOf`), read as it
 * stands. No second table here: moving a bench is one csv cell. Retired furniture · `any` are skipped; unknown = workshop.
 */
const BENCH_FACILITY: ReadonlyMap<WorkbenchKind, RoomPurpose> = (() => {
  const m = new Map<WorkbenchKind, RoomPurpose>();
  for (const d of FURNITURE_DEFS) {
    if (d.retired || d.room === 'any') continue;
    const kind = benchKindOf(d.interaction);
    if (kind && !m.has(kind)) m.set(kind, d.room);
  }
  return m;
})();

/** The facility this workbench (`null` = quick craft) belongs to. Quick craft belongs to the workshop (user's decision). */
export function benchFacility(kind: WorkbenchKind | null): RoomPurpose {
  return kind ? BENCH_FACILITY.get(kind) ?? 'workshop' : 'workshop';
}

/**
 * The **upgrade** button in the header. What it upgrades is decided by **what this window was opened as**:
 * a bench window upgrades that bench, the inventory Tab upgrades the stash. — 2026-09-16 (user's report): pressing
 * it at a bench raised the 「창고 업그레이드」 window, and that bug came from here (the button called
 * `openStorageUpgrade` outright). Facility level · cost · hold confirm all belong to housing; this only picks one.
 */
const UPGRADE_KO = { label: '업그레이드', bench: '작업대 업그레이드', storage: '창고 업그레이드' } as const;

/** Fallback table of skill names — only when progression is absent. The source is `name` in `data/skills.csv`. */
const SKILL_LABEL_KO: Readonly<Record<CraftRecipe['skill'], string>> = { crafting: '제작', medicine: '의학', gardening: '원예' };

/** The recipe skill's Korean name — `ProgressionRef.getSkillDef` is the source, else the fallback table → id. */
function skillLabel(sys: InventorySystem, skill: CraftRecipe['skill']): string {
  const prog = sys.ctx.progression;
  const def = prog && typeof prog.getSkillDef === 'function' ? prog.getSkillDef(skill) : null;
  return def && def.id === skill && def.name ? def.name : (SKILL_LABEL_KO[skill] ?? skill);
}

/**
 * **The reason a locked recipe gives** (2026-09-16). Built in this one place so that the cell's bottom ribbon and
 * the detail card's hold button say the same thing.
 *
 * There are two branches and **the bench level comes first**: below the level, skill need not even be asked. If the
 * level is met and the recipe is still outside `getRecipes`, the only reason left is skill (`skillRequired`).
 *
 * 2026-09-16 (user's decision, 2nd): the skill branch was deleted that morning as 「skills have nothing to do with
 * crafting」 and then brought back — as long as the `skillRequired` column stays, raising a csv number later has to
 * be able to turn it on. With every value 0 this branch never appears today.
 */
function lockedReason(sys: InventorySystem, r: CraftRecipe, benchLevel: number): string {
  const need = r.benchLevel ?? 1;
  if (benchLevel < need) return TEXT.bench.lockedLevel(need);
  return TEXT.bench.lockedSkill(skillLabel(sys, r.skill), r.skillRequired);
}

/** One cell of the left recipe list — a product thumbnail. Materials · quantity · button all belong to the detail card. */
interface CellView {
  recipe: CraftRecipe;
  locked: boolean;
  el: HTMLElement;
  /** Product def + the sample for the hover card (null for a recipe whose def is unknown — then there is no card). */
  out: { def: ItemDef; sample: ItemInstance } | null;
}

/** State classes the detail card (`.inv-panel-craft-detail`) copies straight off the detail body (`.inv-craft-row`). */
const DETAIL_STATE_CLASSES = ['is-locked', 'is-nospace', 'is-crafting', 'is-bench-locked'] as const;

/**
 * **The craft detail card** (2026-09-15 2nd pass, user's decision) — split out as a piece so it can be used outside
 * this folder. The cook bench screen (`housing`) takes `CraftDetail`'s DOM and repaint contract as they stand.
 */
export interface CraftDetailHandle {
  /** The card root (`.inv-craft-detail`). The caller appends it wherever it wants. */
  readonly el: HTMLElement;
  /** The recipe id currently drawn (null with none). */
  readonly recipeId: string | null;
  /** Draws this recipe (the same recipe repaints its numbers only). null = an empty card. */
  show(recipe: CraftRecipe | null, locked: boolean): void;
  /** Recomputes materials · held count · quantity cap · button state only. */
  paint(): void;
  /** The minimal repaint during a hold — the gauge only. */
  paintProgress(progress: number): void;
  /** The craft quantity this card currently holds (runs ≥ 1). */
  readonly count: number;
  dispose(): void;
}

/**
 * Crafting panel (the `제작` button inside the inventory, or a workshop bench through `InventoryRef.openBenchCraft`).
 *
 * ## 2026-09-15 2nd pass — **list + detail** (user's decision, the craft UI rework)
 *
 * A 94-row vertical list (thumbnail · name · material chips · stepper · button per row) fitted three rows on a screen,
 * and the stepper squeezed everything else sideways. The panel is now **left = the recipe list · right = the detail**:
 *
 *  - **Left, `.inv-craft-list`**: a grid of **product thumbnails only** (`CRAFT_LIST_COLS` = 4 across). A cell is
 *    `.inv-craft-cell[data-recipe]`; one locked by bench level is `.is-bench-locked`, one whose materials are short
 *    right now is `.is-locked`. **What can be made now comes first** (stable sort), and it re-sorts whenever the
 *    materials change (a craft · an item picked up → `afterChange` → `InventoryUI.refresh` → `paint()`).
 *  - **The detail, `.inv-craft-detail`**: top to bottom ① the product thumbnail + name · kind, ② description and spec
 *    rows **exactly as the item tooltip draws them** (`ui/Tooltip` is embedded there — spec rows are not written
 *    twice), ③ the count held, ④ material **thumbnails** (no 「재료 부족: …」 row — a short chip turns red itself),
 *    ⑤ a horizontal stepper (`지금 목표 / 최대`), ⑥ the hold-to-craft button (a 1 s gauge + left-click hold keycap).
 *  - A bench with nothing to pick draws **one centred line** `제작할 수 있는 레시피가 없습니다.` instead of both.
 *
 * ## 2026-09-15 4th pass — **the detail is a side card · no stash · no bag · 5 columns · hover card** (user's decision)
 *
 *  - The detail is not **inside** the craft panel but a **separate card standing to its right**,
 *    `.inv-panel-craft-detail` (`detailEl`) — the window (`InventoryUI`) appends it right after `el`, and
 *    `.inv-layout.is-craft` decides order and height (matched to the craft panel). With no recipe picked, or an empty
 *    list, the card is `hidden`. It copies the body's state classes and `--rc`, so it wears **the tooltip's frame**.
 *  - While crafting the **stash and bag grid cards hide** (`.inv-layout.is-craft .inv-panel-grids`, css) — materials are
 *    counted from the inventory model, not the grids (`craftCountDef`). Tab · Escape · key guide unchanged (`parts/Screens.setCraftOpen`).
 *  - The recipe list is **5 cells** across (`CRAFT_LIST_COLS`); the cell size is unchanged.
 *  - Hovering a cell shows **the product's inventory tooltip** (`CraftHoverHandlers` → the window's floating card).
 *    The card is dropped when the list is rebuilt or the panel closes (a detached element gets no `pointerleave` — `validateHover`'s reason).
 *  - **Where the product goes**: on the ship the stash first, the bag when it is full; in the field the bag only
 *    (`parts/Crafting.addCraftOutputs`). The held count spans the same range (`InventoryRef.craftCountDef`).
 *
 * ⚠ So that the tutorial's spotlight selector `.inv-craft-row[data-recipe="…"] .inv-craft-btn` keeps matching, **the
 * detail card also carries the name `.inv-craft-row`** (with `.inv-craft-btn` inside it). And when the list is rebuilt
 * with nothing picked it **selects the first cell** — the tutorial leaves that step's one recipe, so that one is it.
 *
 * ## 2026-09-16 — **close · upgrade · locked rows** (user's report · decision)
 *
 *  - **`닫기` closes the bench window**: a Tab window the bench opened itself is closed whole
 *    (`InventoryRef.closeCraftWindow` → `parts/Crafting.BENCH_WINDOW`). It used to fold the craft column only, which uncovered the bag window.
 *  - `업그레이드` sits at the header right, **left of `닫기`** (`HousingRef.openStorageUpgrade` — the same modal as
 *    the inventory Tab stash header row). With no `ctx.housing`, or in a raid, the button is not there at all.
 *  - The list now carries **every** recipe of that bench (`getBenchRecipes`) — a row below the level shows locked, and
 *    **the detail's button** says why (`lockedReason`: `작업대 Lv.2 필요`). 2026-09-16 (user's report, 2nd): the ribbon
 *    `작업대 Lv.n 필요` on the cell thumbnail hid the picture and was dropped — the cell now says it with a deep dim.
 *  - A bench with nothing to pick still **keeps its width and height** (css `.inv-craft-empty` — five thumbnails wide).
 *
 * ## What is unchanged
 *
 * - **The vertical bench list down the left** (`.inv-craft-benches`, 2026-09-12) · same-facility benches only (2026-09-13).
 * - Every recipe holds for the same `CRAFT_HOLD_TIME` (1 s), and **during a hold only the gauge is repainted** (`frozen`).
 * - A recipe the tutorial hides is left out of the list entirely (`ctx.tutorial.hides('craft', id)`).
 * - While the window is `.inv-root.is-craft`, equipment · quick slots · the screen tabs and the bag header's craft /
 *   value are hidden (`parts/Screens.setCraftOpen`).
 */
export class CraftPanel {
  readonly el: HTMLElement;
  /**
   * 2026-09-15 4th pass: **the detail card** (`.inv-panel-craft-detail`) — a sibling panel of `el`. The caller
   * (`InventoryUI`) appends it right after `el`. It shows only with a recipe picked, and hides with the panel.
   */
  readonly detailEl: HTMLElement;
  private titleEl: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private bodyEl: HTMLElement;
  private stationEl: HTMLElement;
  private discountEl: HTMLElement;
  /** 2026-09-16 (user's decision): the stash upgrade button at the header right, **left** of `닫기` (no `ctx.housing` · a raid = hidden). */
  private upgradeBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  /** The cells **in build order (= csv order)**. The on-screen order is changed by `applySort`, in the DOM only. */
  private cells: CellView[] = [];
  private sig = '';
  /** The cell order last written to the DOM (the recipe ids joined). */
  private sortSig = '';
  /** The recipe id the detail card on the right currently holds. */
  private selected: string | null = null;
  private detail: CraftDetail;
  private holding: string | null = null;
  private onWindowUp = (): void => { this.release(); };
  /* ── 2026-09-12: the vertical bench list down the left (replaces 2026-09-10's horizontal tabs) ── */
  /** The column the list lives in (hidden with only one thing to pick — field crafting in a raid). */
  private benchesEl: HTMLElement;
  /** The right column, where the header and the list live (`.inv-panel-craft` lays the two out side by side). */
  private mainEl: HTMLElement;
  /** The list composition last drawn — unchanged means the DOM is not rebuilt. */
  private benchSig = '';
  /**
   * The mark that freezes the list while a hold runs (2026-09-10) — when set, `refresh()` repaints the gauge only.
   * Cells are not moved during a hold anyway (`applySort`), and there is no reason to run 94 cells × (canCraft ·
   * maxCraftCount · craftHasRoom (which copies two grids)) **every frame**.
   */
  private frozen: string | null = null;
  /** 2026-09-15 4th pass: the recipe id of the cell whose hover card is up (null = none). The grounds for dropping it on rebuild · close. */
  private hoverId: string | null = null;

  constructor(
    private readonly sys: InventorySystem,
    private readonly getDef: (id: string) => ItemDef | undefined,
    /** Phase 8: the 닫기 button outside bench mode (the window closes the modeless popup). */
    private readonly onClose: () => void = () => {},
    /**
     * @deprecated 2026-09-14 — since the header's `모두 수리` moved to the bag filter row this panel no longer calls it.
     * The parameter is kept so call sites are not disturbed (the same grain as the add-only, never-delete contract).
     */
    private readonly onRepair: (anchor: HTMLElement) => void = () => {},
    /** 2026-09-15 4th pass: the recipe cell's hover card (absent = no card — smokes · older call sites). */
    private readonly hover: CraftHoverHandlers | null = null,
  ) {
    this.el = document.createElement('section');
    this.el.className = 'inv-panel inv-panel-craft';
    this.el.hidden = true;
    // The list grid and the panel width read the same column count (`inventory.css` `.inv-craft-list` · `.inv-panel-craft`)
    this.el.style.setProperty('--inv-craft-cols', String(CRAFT_LIST_COLS));

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
    // 2026-09-16 (user's decision): the stash upgrade is reachable from the bench window too, not just the inventory Tab — immediately left of `닫기`
    this.upgradeBtn = document.createElement('button');
    this.upgradeBtn.type = 'button';
    this.upgradeBtn.className = 'inv-btn inv-craft-upgrade';
    this.upgradeBtn.textContent = UPGRADE_KO.label;
    this.upgradeBtn.hidden = true;                 // `refresh()` turns it on after reading the ship · `ctx.housing`
    this.upgradeBtn.addEventListener('click', () => {
      const h = this.sys.ctx.housing;
      if (!h) return;
      // In a bench window the bench is passed explicitly — this does not lean on housing's own router.
      const bench = this.sys.getBench?.();
      if (bench && typeof h.openBenchUpgrade === 'function') { this.sys.sfx('ui_pickup'); h.openBenchUpgrade(bench.kind); return; }
      if (typeof h.openStorageUpgrade !== 'function') return;
      this.sys.sfx('ui_pickup');
      h.openStorageUpgrade();
    });
    this.closeBtn = document.createElement('button');
    this.closeBtn.type = 'button';
    this.closeBtn.className = 'inv-btn inv-craft-close';
    this.closeBtn.textContent = TEXT.bench.close;
    this.closeBtn.addEventListener('click', () => {
      /* 2026-09-16 (user's report): a window the bench opened is **the bench window** — folding the craft column only
         uncovers the bag window below it, which reads as 「I closed it and the bag opened」. `parts/Crafting` alone knows the window's owner. */
      if (!this.sys.closeCraftWindow()) this.onClose();
    });
    actions.append(this.discountEl, this.upgradeBtn, this.closeBtn);
    head.append(titles, actions);

    // 2026-09-12: the vertical bench list at the far left (quick craft + the benches placed on this ship)
    this.benchesEl = document.createElement('div');
    this.benchesEl.className = 'inv-craft-benches';
    this.benchesEl.hidden = true;

    this.listEl = document.createElement('div');
    this.listEl.className = 'inv-craft-list';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'inv-craft-empty';
    this.emptyEl.textContent = TEXT.craftNone;

    this.detail = new CraftDetail(this.sys, this.getDef, {
      onPress: (id) => this.press(id),
      onRelease: () => this.release(),
      isHolding: (id) => this.holding === id,
      onCountChanged: () => { this.sys.sfx('ui_pickup'); },
    });

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'inv-craft-body';
    this.bodyEl.append(this.listEl);

    this.mainEl = document.createElement('div');
    this.mainEl.className = 'inv-craft-main';
    this.mainEl.append(head, this.bodyEl, this.emptyEl);

    this.el.append(this.benchesEl, this.mainEl);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());

    // 2026-09-15 4th pass: the detail is a **separate card** right of the craft panel — the window appends it after `el`
    this.detailEl = document.createElement('section');
    this.detailEl.className = 'inv-panel inv-panel-craft-detail';
    this.detailEl.hidden = true;
    this.detailEl.appendChild(this.detail.el);
    this.detailEl.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isOpen(): boolean { return !this.el.hidden; }

  setOpen(open: boolean): void {
    if (this.el.hidden === !open) return;
    this.el.hidden = !open;
    if (!open) { this.release(); this.detailEl.hidden = true; this.dropHover(); }
    else { this.sig = ''; this.frozen = null; this.refresh(); }
  }

  /** Drops the recipe cell's hover card (where a cell disappears — a detached element gets no `pointerleave`). */
  private dropHover(): void {
    if (this.hoverId === null) return;
    this.hoverId = null;
    this.hover?.onLeave();
  }

  /** Rebuild the cells when the available recipe set changes; otherwise just repaint counts / progress. */
  refresh(): void {
    if (this.el.hidden) return;
    /*
     * **2026-09-10 — the gauge only while a hold runs.** `updateCraft` calls `refreshCraft()` every frame, so this
     * function runs 60 times over a 1 s hold. The only thing that changes is the filling bar, and the **rule that
     * cells do not move** (`applySort`) is already there — so after one proper paint on the first frame, only the bar.
     */
    const running = this.sys.craftProgress();
    if (running && this.frozen === running.recipeId) { this.paintProgress(running); return; }
    this.frozen = running?.recipeId ?? null;
    const bench = this.sys.getBench();
    if (bench) {
      // 2026-09-13: the English eyebrow line names the **facility** the bench belongs to (WORKSHOP / LAB / KITCHEN BENCH)
      this.stationEl.textContent = TEXT.bench.eyebrow(benchFacility(bench.kind));
      this.titleEl.textContent = `${WORKBENCH_LABEL_KO[bench.kind]} ${TEXT.bench.level(bench.level)}`;
    } else {
      const station = this.sys.currentStation();
      this.stationEl.textContent = station === 'ship' ? TEXT.craftStationShip : TEXT.craftStationField;
      this.titleEl.textContent = TEXT.craftPanel;
    }
    /* 2026-09-16: upgrading is **only on the ship** — with no `ctx.housing`, or in a raid, the button itself is hidden
       (`HousingRef.openStorageUpgrade`'s contract: 「outside the ship the caller hides the button」).
       The title says **what this window is** — a bench window that read 「창고 업그레이드」 was the bug. */
    const housing = this.sys.ctx.housing;
    this.upgradeBtn.hidden = !housing || typeof housing.openStorageUpgrade !== 'function' || !this.sys.ctx.isHubPhase();
    this.upgradeBtn.title = this.sys.getBench?.() ? UPGRADE_KO.bench : UPGRADE_KO.storage;

    const mul = this.sys.craftCostMul();
    this.discountEl.hidden = mul >= 1;
    if (mul < 1) this.discountEl.textContent = TEXT.bench.discount(Math.round((1 - mul) * 100));

    const tut = this.sys.ctx.tutorial;
    const all = this.sys.getBenchRecipes().filter((r) => !(tut?.hides('craft', r.recipe.id) ?? false));
    // 2026-09-12: the bench list on the left. Once a bench is picked `getBenchRecipes()` already returns only that
    //   bench's rows, so the one thing filtered separately is `빠른제작` (no bench).
    this.buildBenches(bench?.kind ?? null);
    const recipes = bench ? all : all.filter((r) => isFieldRecipe(r.recipe));
    // 2026-09-12 (E1): the favourite ribbon on the product thumbnail rides this signature too (`favoritesRevision`)
    const sig = `${bench ? `${bench.kind}:${bench.level}` : '-'}|${mul}|t${tut?.step ?? '-'}|f${favoritesRevision()}|w${shelfWantedRevision()}`
      + `|${recipes.map((r) => `${r.recipe.id}${r.locked ? '!' : ''}`).join('|')}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.sortSig = '';
      this.build(recipes);
    }
    // An empty list draws one centred line instead of the list and the detail (user's decision)
    const empty = recipes.length === 0;
    this.emptyEl.hidden = !empty;
    this.bodyEl.hidden = empty;
    this.paint();
  }

  /**
   * 2026-09-15 4th pass: the detail **card** (`detailEl`) copies the state of the detail body (`.inv-craft-row`) — the
   * card draws the locked · no-room · crafting border colours and the product's `--rc` (the tooltip's frame), so it is matched here on every change.
   */
  private syncDetailCard(picked: CellView | null): void {
    const card = this.detailEl;
    card.hidden = this.el.hidden || !picked || this.bodyEl.hidden;
    for (const c of DETAIL_STATE_CLASSES) card.classList.toggle(c, this.detail.el.classList.contains(c));
    if (picked?.out) card.style.setProperty('--rc', rarityColor(picked.out.def));
    else card.style.removeProperty('--rc');
  }

  /**
   * **The vertical bench list down the left** (2026-09-12, user's decision). `빠른제작` (what is made with no
   * workbench) is at the top; below it stand the benches **actually placed on this ship**
   * (`ctx.housing.getBenchLevel(kind) > 0`) and the bench **this window was opened from**, in `WORKBENCH_KINDS` order.
   * Pressing one splits the list on the spot (`InventoryRef.switchBench` — it neither closes nor opens a window).
   *
   * Names and glyphs have one source, `WORKBENCH_LABEL_KO` · `WORKBENCH_ICON` (`@/shared`), so the ship management
   * screen · the bench title · this list all use one name. With one thing to pick (field crafting) the column hides.
   *
   * **2026-09-13 (user's decision) — benches of the same facility only.** The list shows only the benches of the
   * **facility** (`benchFacility` — `room` in `data/furniture.csv`) the current bench (`active`, else quick craft) is in.
   */
  private buildBenches(active: BenchPick): void {
    const housing = this.sys.ctx.housing;
    const bench = this.sys.getBench();
    /*
     * The bench this window was **opened from** is in the list whatever `ctx.housing` says, and stands at that level —
     * otherwise the title can read `가공 작업대 Lv.3` while the list on the left has no such row and nothing at all is
     * selected (furniture outside `ctx.housing` (= my ship), as on someone else's ship or the shared ship).
     */
    const levelOf = (kind: WorkbenchKind): number => {
      let lv = 0;
      try { lv = Math.max(0, housing?.getBenchLevel(kind) ?? 0); } catch { lv = 0; }
      return bench && bench.kind === kind ? Math.max(lv, bench.level) : lv;
    };
    const hub = this.sys.ctx.isHubPhase();
    const facility = benchFacility(active);
    const placed = hub
      // 2026-09-13 (the cooking minigame): the cook bench is not a craft-window bench — cooking happens on its own screen (housing)
      ? WORKBENCH_KINDS.filter((k) => k !== 'cook' && benchFacility(k) === facility && (k === active || levelOf(k) > 0))
      : [];
    const picks: BenchPick[] = facility === 'workshop' ? [null, ...placed] : placed;
    this.benchesEl.hidden = !hub || picks.length === 0;
    this.benchesEl.dataset.facility = facility;
    const sig = picks.map((p) => (p === null ? '-' : `${p}:${levelOf(p)}`)).join('|');
    if (sig !== this.benchSig) {
      this.benchSig = sig;
      this.benchesEl.replaceChildren(...picks.map((pick) => {
        const level = pick ? levelOf(pick) : 0;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'inv-craft-bench';
        b.dataset.bench = pick ?? 'field';
        const ico = document.createElement('i');
        ico.className = 'inv-craft-bench-ico';
        ico.textContent = pick ? WORKBENCH_ICON[pick] : TEXT.craftTabs.icon.field ?? '✥';
        const name = document.createElement('span');
        name.className = 'inv-craft-bench-nm';
        name.textContent = pick ? WORKBENCH_LABEL_KO[pick] : TEXT.craftTabs.field;
        b.append(ico, name);
        if (pick) {
          const lv = document.createElement('span');
          lv.className = 'inv-craft-bench-lv';
          lv.textContent = TEXT.bench.level(level);
          b.appendChild(lv);
        }
        b.title = name.textContent;
        b.addEventListener('click', () => {
          if ((this.sys.getBench()?.kind ?? null) === pick) return;
          this.sys.switchBench(pick, level);
          this.sys.sfx('ui_pickup');
          this.sig = '';                 // the list changes wholesale
          this.frozen = null;
          this.selected = null;          // no reason for another bench's recipe to stay
          this.refresh();
        });
        return b;
      }));
    }
    for (const b of this.benchesEl.children) {
      b.classList.toggle('is-on', ((b as HTMLElement).dataset.bench ?? 'field') === (active ?? 'field'));
    }
  }

  /**
   * The minimal repaint during a hold (2026-09-10): only the running row's gauge moves. Material chips · sorting ·
   * the room check are left alone — the slow path of `refresh()` redraws all three at once once the hold ends.
   */
  private paintProgress(job: { recipeId: string; progress: number }): void {
    for (const cell of this.cells) cell.el.classList.toggle('is-crafting', cell.recipe.id === job.recipeId);
    this.detail.paintProgress(this.detail.recipeId === job.recipeId ? job.progress : 0);
    this.detailEl.classList.toggle('is-crafting', this.detail.el.classList.contains('is-crafting'));
  }

  /** The list on the left: a grid of product thumbnails only. Pressing one switches the detail to that recipe. */
  private build(recipes: readonly BenchRecipeRow[]): void {
    this.dropHover();   // cells are rebuilt wholesale — a hovered cell is detached and never gets `pointerleave`
    this.listEl.innerHTML = '';
    this.cells = [];
    for (const { recipe, locked } of recipes) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'inv-craft-cell';
      cell.dataset.recipe = recipe.id;
      if (locked) cell.classList.add('is-bench-locked');

      const out = this.getDef(recipe.outputDefId);
      let sample: ItemInstance | null = null;
      // 2026-09-15 4th pass: the native `title` is gone — it overlapped the hover card. Only a recipe with an unknown def keeps a name.
      if (!out) cell.title = recipe.name;
      if (out) {
        /*
         * 2026-09-09: **fixed at one cell.** Drawing the product at its real grid size blew a 4×2 assault rifle out to
         * four times one ammo cell and the list collapsed (user's report). What matters here is "what comes out"; how
         * many cells it takes is told by the spec card in the detail. A 1×1 tile still draws its stack count badge.
         */
        const tile = document.createElement('div');
        const item = this.sys.loot.createItem(out.id, Math.min(out.stackMax, recipe.outputQty));
        sample = item;
        buildTileContent(tile, item, out, 1, 1, null, CELL);
        cell.appendChild(tile);
        // 2026-09-15 4th pass: hovering shows the product's item tooltip — the same card and placement rule as a grid tile (`Tooltip.move`)
        if (this.hover) {
          const hover = this.hover;
          cell.addEventListener('pointerenter', (e) => { this.hoverId = recipe.id; hover.onEnter(out, item, e); });
          cell.addEventListener('pointermove', (e) => { if (this.hoverId === recipe.id) hover.onMove(e); });
          cell.addEventListener('pointerleave', () => { if (this.hoverId === recipe.id) { this.hoverId = null; hover.onLeave(); } });
        }
        // A stacking def draws its own count; one that does not stack but is made in twos needs the badge.
        if (out.stackMax <= 1 && recipe.outputQty > 1) {
          const badge = document.createElement('div');
          badge.className = 'inv-craft-thumb-qty';
          badge.textContent = `×${recipe.outputQty}`;
          cell.appendChild(badge);
        }
      }
      /* 2026-09-16 (user's report): **no text at all is printed over a locked cell's thumbnail** — the 8 px
         `작업대 Lv.n 필요` ribbon covered the bottom third of a one-cell product picture and hid "what comes out".
         Two places already say why: the hold button's label in the detail (`CraftDetail.paint` → `lockedReason`)
         and the product tooltip on hover. The cell says it with **a dim, nothing more** (`.is-bench-locked`, css). */
      cell.addEventListener('click', () => this.select(recipe.id));
      this.listEl.appendChild(cell);
      this.cells.push({ recipe, locked, el: cell, out: out && sample ? { def: out, sample } : null });
    }
    // Clear the pick when it has left the list — `paint()` then selects the first cell again
    if (this.selected && !this.cells.some((c) => c.recipe.id === this.selected)) this.selected = null;
  }

  /** Picks a cell on the left (ignored during a hold — the button being held must not change recipe). */
  private select(recipeId: string): void {
    if (this.holding || this.selected === recipeId) return;
    this.selected = recipeId;
    this.sys.sfx('ui_pickup');
    this.paint();
  }

  /**
   * **2026-09-10 — what can be made now goes to the top.** Cells that satisfy both materials and bench level come
   * first, and inside each group **the original (csv) order is kept** (a stable sort).
   *
   * - `locked` is the bench level (2026-09-16: skills no longer block crafting). So the only test here is
   *   `!locked && canCraft(id, 1)` — **can it be made at all**, not the quantity shown in the detail.
   * - Room for the output (`craftHasRoom`) is **not** read: a full bag or stash is no property of the recipe, and
   *   the detail card's button already says why.
   * - It runs inside `paint()`, so spending or gaining materials (→ `afterChange` → `InventoryUI.refresh`) re-sorts at once.
   * - **Cells do not move during a hold.** The button being pressed sits in the detail, so a shifting list does not
   *   release the hold, but a picture jumping in front of you is bad in its own right.
   */
  private applySort(): void {
    if (this.holding || this.cells.length < 2) return;
    const order = this.cells
      .map((cell, i) => ({ cell, i, ready: !cell.locked && this.sys.canCraft(cell.recipe.id, 1) }))
      .sort((a, b) => (a.ready === b.ready ? a.i - b.i : a.ready ? -1 : 1));
    const sig = order.map((o) => o.cell.recipe.id).join('|');
    if (sig === this.sortSig) return;
    this.sortSig = sig;
    for (const o of order) this.listEl.appendChild(o.cell.el);
  }

  private paint(): void {
    this.applySort();
    const job = this.sys.craftProgress();
    // With nothing picked, take **the first cell** (after the sort 「what can be made now」 is first, and in a
    // one-recipe list such as the tutorial's it is that one — the spotlight finds the detail's button at once).
    if (!this.selected) {
      const first = (this.listEl.firstElementChild as HTMLElement | null)?.dataset.recipe ?? this.cells[0]?.recipe.id ?? null;
      this.selected = first;
    }
    const picked = this.cells.find((c) => c.recipe.id === this.selected) ?? null;
    for (const cell of this.cells) {
      const active = job?.recipeId === cell.recipe.id;
      const ok = !cell.locked && this.sys.canCraft(cell.recipe.id, 1);
      cell.el.classList.toggle('is-locked', !ok);
      cell.el.classList.toggle('is-on', cell.recipe.id === this.selected);
      cell.el.classList.toggle('is-crafting', active);
    }
    this.detail.show(picked?.recipe ?? null, picked?.locked ?? false);
    this.detail.paint();
    this.syncDetailCard(picked);
  }

  /* ── hold to craft ────────────────────────────────────────────────────── */

  private press(recipeId: string): void {
    if (this.holding) return;
    this.holding = recipeId;
    window.addEventListener('pointerup', this.onWindowUp);
    window.addEventListener('pointercancel', this.onWindowUp);
    // 2026-09-09: the hold buys `count` runs at once (`InventoryRef.craft(id, targetUid?, count)`) — still one
    // `CRAFT_HOLD_TIME`, however many runs it pays for.
    const count = this.detail.recipeId === recipeId ? this.detail.count : 1;
    void this.sys.craft(recipeId, undefined, count).then(() => {
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
    this.dropHover();
    this.detail.dispose();
    this.detailEl.remove();
    this.el.remove();
  }
}

/* ══ the detail card on the right ════════════════════════════════════════════════════════════════════════════ */

interface CraftDetailHooks {
  /** The hold button was pressed. */
  onPress(recipeId: string): void;
  /** The cursor left the hold button. */
  onRelease(): void;
  /** Is this recipe being held right now (it freezes the stepper). */
  isHolding(recipeId: string): boolean;
  /** The quantity changed (one sound). */
  onCountChanged(): void;
}

/**
 * **The detail card of the one picked recipe** (2026-09-15 2nd pass, user's decision).
 *
 * The cook bench screen (`housing`) can use the same card by `new`-ing this class and appending `el` — the public
 * contract is `CraftDetailHandle`. Everything is asked of **the inventory system only** (`craftCost` · `craftCountDef` ·
 * `maxCraftCount` · `canCraft` · `craftHasRoom` · `craftProgress`).
 *
 * The description and spec rows are **not drawn here**: `ui/Tooltip`'s item card is embedded in this panel
 * (`.inv-tooltip.is-embedded`) and used as it stands — weapon gauges · durability · sockets · weight · value must match
 * the hover card letter for letter, and the spec rules are not written twice (「the same formula in two folders moves to shared」).
 */
/* 2026-09-15 3rd pass: made public so the cook bench screen (`housing/ui/cook`) can use the same detail card — only the hold button's behaviour is swapped in through `hooks`. */
export class CraftDetail implements CraftDetailHandle {
  readonly el: HTMLElement;
  private recipe: CraftRecipe | null = null;
  private locked = false;
  private readonly thumbEl: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly kindEl: HTMLElement;
  private readonly specHost: HTMLElement;
  private readonly spec: Tooltip;
  private readonly ownedEl: HTMLElement;
  private readonly costsEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly lessBtn: HTMLButtonElement;
  private readonly moreBtn: HTMLButtonElement;
  private readonly button: HTMLButtonElement;
  private readonly fill: HTMLElement;
  private readonly labelEl: HTMLElement;
  private readonly capEl: HTMLElement;
  /** Runs of the recipe one hold buys (≥ 1). Reset to 1 whenever the shown recipe changes. */
  private runs = 1;
  /** The product id the spec card was last drawn for — the same one is not rebuilt (one card is a hundred DOM lines). */
  private specDefId: string | null = null;

  constructor(
    private readonly sys: InventorySystem,
    private readonly getDef: (id: string) => ItemDef | undefined,
    private readonly hooks: CraftDetailHooks,
  ) {
    // ⚠ It also carries the name `.inv-craft-row` — the tutorial spotlight finds the hold button through
    //   `.inv-craft-row[data-recipe="…"] .inv-craft-btn` (`src/tutorial/Steps.ts`).
    this.el = document.createElement('div');
    this.el.className = 'inv-craft-detail inv-craft-row';

    /* ① the product thumbnail + name · kind — laid out like the item tooltip header (2026-09-15 4th pass): icon top-left, name to its right, kind · rarity below */
    const head = document.createElement('div');
    head.className = 'inv-craft-dhead';
    this.thumbEl = document.createElement('div');
    this.thumbEl.className = 'inv-craft-thumb';
    const titles = document.createElement('div');
    titles.className = 'inv-craft-dtitles';
    this.nameEl = document.createElement('div');
    this.nameEl.className = 'inv-craft-name';
    this.kindEl = document.createElement('div');
    this.kindEl.className = 'inv-craft-dkind';
    titles.append(this.nameEl, this.kindEl);
    head.append(this.thumbEl, titles);

    /* ② description · spec — the item tooltip card is embedded as it stands */
    this.specHost = document.createElement('div');
    this.specHost.className = 'inv-craft-spec';
    this.spec = new Tooltip(inventoryTooltipLookups(this.sys, this.sys.ctx));
    /*
     * ⚠ **The class is swapped** (`inv-tooltip` → `inv-tt-card is-embedded`). This card lives inside `.inv-layout`, that
     * is **earlier in the DOM** than the floating hover card — with the old name `document.querySelector('.inv-tooltip')`
     * picks this card first (exactly what the rule 「a new overlay is appended **after** the floating card」 protects).
     * `Tooltip.show()` never touches `className` (only `innerHTML` and `--rc`), so one swap is enough; the classes
     * **inside** the card (`.inv-tt-*`) stay, so the styling and A's spec-row rework all come across unchanged.
     */
    this.spec.el.className = 'inv-tt-card is-embedded';
    this.specHost.appendChild(this.spec.el);

    /* ③ the count currently held */
    this.ownedEl = document.createElement('div');
    this.ownedEl.className = 'inv-craft-owned';

    /* ④ material thumbnails — no 「재료 부족: …」 text row (user's decision): a chip that is short says so in red */
    this.costsEl = document.createElement('div');
    this.costsEl.className = 'inv-craft-costs';
    // 2026-09-14 (user's decision): the hover card of a required-item chip sits **top-left** of the cursor — `ui/hud/ItemTip`
    // reads this attribute with `closest` (cross-folder imports are banned, so the name is written out, not imported).
    this.costsEl.dataset.tipAnchor = 'left';

    /* ⑤ the horizontal quantity stepper — `지금 목표 / 최대` */
    const stepper = document.createElement('div');
    stepper.className = 'inv-craft-count';
    stepper.title = TEXT.craftCount.hint;
    this.lessBtn = document.createElement('button');
    this.lessBtn.type = 'button';
    this.lessBtn.className = 'inv-craft-step';
    this.lessBtn.textContent = '◀';
    this.lessBtn.title = TEXT.craftCount.less;
    this.countEl = document.createElement('span');
    this.countEl.className = 'inv-craft-count-v';
    this.moreBtn = document.createElement('button');
    this.moreBtn.type = 'button';
    this.moreBtn.className = 'inv-craft-step';
    this.moreBtn.textContent = '▶';
    this.moreBtn.title = TEXT.craftCount.more;
    stepper.append(this.lessBtn, this.countEl, this.moreBtn);

    /* ⑥ hold to craft */
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'inv-btn inv-craft-btn';
    this.fill = document.createElement('i');
    this.fill.className = 'inv-craft-fill';
    // 2026-09-15 2nd pass (user's decision): 「길게 눌러」 is said by the left-click hold keycap left of the label, not in words.
    this.capEl = createHoldButtonCap();
    this.labelEl = document.createElement('span');
    this.labelEl.textContent = TEXT.craftHold;
    this.button.append(this.fill, this.capEl, this.labelEl);

    this.el.append(head, this.specHost, this.ownedEl, this.costsEl, stepper, this.button);

    this.button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.recipe || this.locked) return;
      e.preventDefault();
      this.hooks.onPress(this.recipe.id);
    });
    // The DOM under this button must never be moved or rebuilt during a hold — a re-layout reads as `pointerleave`
    // and releases the craft. That is why only the gauge is painted while holding.
    this.button.addEventListener('pointerleave', () => this.hooks.onRelease());
    this.lessBtn.addEventListener('click', (e) => { e.stopPropagation(); this.step(-1); });
    this.moreBtn.addEventListener('click', (e) => { e.stopPropagation(); this.step(1); });
    // Non-passive: the list underneath must not scroll while the wheel is spending itself on the count.
    stepper.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.step(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  get recipeId(): string | null { return this.recipe?.id ?? null; }
  get count(): number { return this.runs; }

  /**
   * Draws this recipe. **The same recipe rebuilds nothing** — `paint()` passes through here on every
   * `InventoryUI.refresh()`, and reassembling the thumbnail and spec card each time costs a hundred DOM lines a card.
   */
  show(recipe: CraftRecipe | null, locked: boolean): void {
    const same = !!recipe && recipe.id === this.recipe?.id;
    this.recipe = recipe;
    this.el.hidden = !recipe;
    if (!recipe) { this.locked = false; delete this.el.dataset.recipe; return; }
    if (same && locked === this.locked) return;
    this.locked = locked;
    if (!same) {
      this.runs = 1;
      this.el.dataset.recipe = recipe.id;
    }
    this.el.classList.toggle('is-bench-locked', locked);
    const out = this.getDef(recipe.outputDefId);
    // 2026-09-15 4th pass: the header is the item tooltip's frame — the name in rarity colour (as `.inv-tt-name`), the kind row as `.inv-tt-sub`
    if (out) this.el.style.setProperty('--rc', rarityColor(out)); else this.el.style.removeProperty('--rc');
    /* thumbnail · name · kind */
    this.thumbEl.replaceChildren();
    if (out) {
      // `data-item-tip` + `data-def-id` is what `ui/hud/ItemTip` delegates on — the same hover card the cost chips get
      this.thumbEl.dataset.itemTip = '';
      this.thumbEl.dataset.defId = out.id;
      const tile = document.createElement('div');
      const item = this.sys.loot.createItem(out.id, Math.min(out.stackMax, recipe.outputQty));
      buildTileContent(tile, item, out, 1, 1, null, CELL);
      this.thumbEl.appendChild(tile);
      if (out.stackMax <= 1 && recipe.outputQty > 1) {
        const badge = document.createElement('div');
        badge.className = 'inv-craft-thumb-qty';
        badge.textContent = `×${recipe.outputQty}`;
        this.thumbEl.appendChild(badge);
      }
    }
    this.nameEl.textContent = out ? `${out.name} ×${recipe.outputQty}` : recipe.name;
    this.kindEl.textContent = out ? kindLine(out) : '';
    /* description · spec — reassembled only when the product changes */
    if (out && this.specDefId !== out.id) {
      this.specDefId = out.id;
      const sample = this.sys.loot.createItem(out.id, Math.min(out.stackMax, Math.max(1, recipe.outputQty)));
      this.spec.show(sample, out, 0, 0);
    } else if (!out) {
      this.specDefId = null;
      this.spec.hide();
    }
  }

  paint(): void {
    const r = this.recipe;
    if (!r) return;
    const job = this.sys.craftProgress();
    const active = job?.recipeId === r.id;
    // 2026-09-09 (the craft quantity): the count is clamped on every paint — spending materials elsewhere (or a craft that
    // just consumed its own) lowers the ceiling, and a stale `n` would then only fail at the end of the hold.
    const max = Math.max(1, this.sys.maxCraftCount(r.id));
    if (!active && this.runs > max) this.runs = max;
    const n = this.runs;

    const ok = !this.locked && this.sys.canCraft(r.id, n);
    /*
     * 2026-09-09 (user's decision) — **room comes first.** With every material in hand but no cell for the product,
     * a full second of holding only ended in a refusal. Ship = stash → bag, the field = the bag only (`roomForOutputs`).
     */
    const room = ok && this.sys.craftHasRoom(r.id, n);
    const ship = this.sys.ctx.isHubPhase();
    this.el.classList.toggle('is-locked', !ok);
    this.el.classList.toggle('is-nospace', ok && !room);
    this.button.disabled = this.locked || ((!ok || !room) && !active);
    this.button.title = ok && !room ? (ship ? TEXT.craftNoRoomTipShip : TEXT.craftNoRoomTipField) : '';

    /* ③ the count currently held — the same range materials are counted over (ship = bag + `함선 창고`, field = bag) */
    this.ownedEl.textContent = TEXT.craftOwned(this.sys.craftCountDef(r.outputDefId));

    /* ④ material thumbnails — the amount needed is multiplied by the current quantity */
    const cost = this.sys.craftCost(r).map((i) => ({ defId: i.defId, qty: i.qty * n }));
    renderItemCost(this.costsEl, cost, this.getDef, (id) => this.sys.craftCountDef(id), { size: 34 });

    /* ⑤ quantity — `지금 목표 / 최대` (user's decision). The unit is the **total number of products**, as before. */
    this.countEl.textContent = `${r.outputQty * n} / ${r.outputQty * max}`;
    this.el.classList.toggle('is-multi', n > 1);
    this.lessBtn.disabled = this.locked || active || n <= 1;
    this.moreBtn.disabled = this.locked || active || n >= max;

    /* ⑥ the button */
    this.el.classList.toggle('is-crafting', active);
    this.fill.style.width = active ? `${Math.round((job?.progress ?? 0) * 100)}%` : '0%';
    // 2026-09-16: the locked reason says the same as the cell's ribbon (bench level — `lockedReason`)
    this.labelEl.textContent = this.locked ? lockedReason(this.sys, r, this.sys.getBench()?.level ?? 0)
      : active ? TEXT.craftMaking
      : ok && !room ? (ship ? TEXT.craftNoRoomShip : TEXT.craftNoRoomField)
      : TEXT.craftHold;
    // Showing a 「꾹 누르세요」 glyph while pressing changes nothing (materials or room short) would be a lie.
    this.capEl.style.display = this.button.disabled ? 'none' : '';
  }

  paintProgress(progress: number): void {
    const active = progress > 0;
    this.el.classList.toggle('is-crafting', active);
    this.fill.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  }

  /**
   * 2026-09-09 — move the craft quantity by `dir`, clamped to 1 … `maxCraftCount` (what the owned materials pay for).
   * A running craft owns the count it started with, so the stepper is inert while this row is holding.
   */
  private step(dir: number): void {
    const r = this.recipe;
    if (!r || this.locked || this.hooks.isHolding(r.id)) return;
    const max = Math.max(1, this.sys.maxCraftCount(r.id));
    const next = Math.max(1, Math.min(max, this.runs + dir));
    if (next === this.runs) return;
    this.runs = next;
    this.hooks.onCountChanged();
    this.paint();
  }

  dispose(): void {
    this.spec.dispose();
    this.el.remove();
  }
}

/**
 * `돌격소총 · 고급` / `탄약 · 일반` — the **kind** row of the detail header.
 * A weapon shows its class name (a legendary unique its own kind — `labels.weaponClassLabel`, 2026-09-15), everything else its category name.
 */
function kindLine(def: ItemDef): string {
  const w = def.weaponId ? getWeaponDef(def.weaponId) : undefined;
  return `${w ? weaponClassLabel(w) : categoryLabel(def)} · ${rarityLabel(def)}`;
}
