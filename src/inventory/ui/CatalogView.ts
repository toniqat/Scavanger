import type { ItemCategory, ItemDef, ItemInstance } from '@/shared';
import type { InventorySystem } from '../InventorySystem';
import { buildTileContent } from './GridView';
import { TEXT, rarityColor } from './labels';

/** Handlers the window supplies (drag / tooltip / double-click / close). */
export interface CatalogHandlers {
  onPointerDown(def: ItemDef, sample: ItemInstance, e: PointerEvent, tileEl: HTMLElement): void;
  onEnter(def: ItemDef, sample: ItemInstance, e: PointerEvent): void;
  onMove(e: PointerEvent): void;
  onLeave(): void;
  onDblClick(def: ItemDef): void;
  onClose(): void;
}

export type CatalogTabId = 'all' | 'weapon' | 'ammo' | 'attachment' | 'bag' | 'armor' | 'implant' | 'gadget' | 'consumable' | 'material' | 'herb' | 'seed' | 'book' | 'furniture';

interface CatalogTab {
  id: CatalogTabId;
  label: string;
  /** null = every category. */
  categories: readonly ItemCategory[] | null;
}

/** Category tabs of the 무한 상자, derived from `ItemCategory` (weapons / consumables / materials fold two categories each). */
export const CATALOG_TABS: readonly CatalogTab[] = [
  { id: 'all', label: TEXT.catalog.tabs.all, categories: null },
  { id: 'weapon', label: TEXT.catalog.tabs.weapon, categories: ['primary'] },   // 2026-09-10: 보조무기 제거
  { id: 'ammo', label: TEXT.catalog.tabs.ammo, categories: ['ammo'] },
  { id: 'attachment', label: TEXT.catalog.tabs.attachment, categories: ['attachment'] },
  { id: 'bag', label: TEXT.catalog.tabs.bag, categories: ['bag'] },
  { id: 'armor', label: TEXT.catalog.tabs.armor, categories: ['armor'] },
  { id: 'implant', label: TEXT.catalog.tabs.implant, categories: ['implant'] },   // Phase 12: 임플란트 items (working + broken)
  { id: 'gadget', label: TEXT.catalog.tabs.gadget, categories: ['gadget'] },
  { id: 'consumable', label: TEXT.catalog.tabs.consumable, categories: ['grenade', 'stim'] },
  { id: 'material', label: TEXT.catalog.tabs.material, categories: ['material', 'valuable'] },
  { id: 'herb', label: TEXT.catalog.tabs.herb, categories: ['herb'] },
  { id: 'seed', label: TEXT.catalog.tabs.seed, categories: ['seed'] },
  { id: 'book', label: TEXT.catalog.tabs.book, categories: ['book', 'disc', 'record'] },   // Phase 9: 서적 · 2026-09-12 (A-3e): 디스크 · 레코드도 같은 서재 탭
  { id: 'furniture', label: TEXT.catalog.tabs.furniture, categories: ['furniture'] },
];

/** Uniform tile footprint of the catalog (cells). */
const TILE_W = 2;
const TILE_H = 2;

interface CatalogEntry {
  def: ItemDef;
  /** Sample instance for the tile / tooltip (never placed anywhere; a drag mints a fresh one). */
  sample: ItemInstance;
  el: HTMLElement;
  tile: HTMLElement;
  /** Lower-cased search key (name + id). */
  key: string;
}

/**
 * 무한 상자 (`/items` cheat): one tile per `ItemDef` (every weapon grade is its own def), category tabs, a search
 * box and a scrolling grid. The panel sits in the container-panel position of the inventory window; the window
 * owns the drag (a fresh `ctx.loot.createItem` per drag) and the tooltip through `CatalogHandlers`. Tiles never
 * disappear — stock is infinite.
 */
export class CatalogView {
  readonly el: HTMLElement;
  private tabsEl: HTMLElement;
  private searchEl: HTMLInputElement;
  private countEl: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private entries: CatalogEntry[] = [];
  private byDef = new Map<string, CatalogEntry>();
  private tabButtons = new Map<CatalogTabId, HTMLButtonElement>();
  private tab: CatalogTabId = 'all';
  private query = '';
  private built = false;

  constructor(
    private readonly sys: InventorySystem,
    private readonly getDef: (id: string) => ItemDef | undefined,
    private readonly handlers: CatalogHandlers,
  ) {
    this.el = document.createElement('section');
    this.el.className = 'inv-panel inv-panel-catalog';
    this.el.hidden = true;
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());

    /* header */
    const head = document.createElement('header');
    head.className = 'inv-head';
    const titles = document.createElement('div');
    titles.className = 'inv-head-titles';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'inv-eyebrow';
    eyebrow.textContent = TEXT.catalog.eyebrow;
    const title = document.createElement('h2');
    title.className = 'inv-title';
    title.textContent = TEXT.catalog.title;
    titles.append(eyebrow, title);
    const actions = document.createElement('div');
    actions.className = 'inv-head-actions';
    this.countEl = document.createElement('div');
    this.countEl.className = 'inv-capacity inv-cat-count';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'inv-btn inv-cat-close';
    close.textContent = TEXT.catalog.close;
    close.addEventListener('click', () => this.handlers.onClose());
    actions.append(this.countEl, close);
    head.append(titles, actions);

    /* tabs */
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'inv-cat-tabs';

    /* search (keys stay inside the field: the game's Input listens on window in the bubble phase) */
    this.searchEl = document.createElement('input');
    this.searchEl.type = 'text';
    this.searchEl.className = 'inv-cat-search';
    this.searchEl.placeholder = TEXT.catalog.search;
    this.searchEl.autocomplete = 'off';
    this.searchEl.spellcheck = false;
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      this.searchEl.addEventListener(type, (e) => { if (e.code !== 'Escape') e.stopPropagation(); });
    }
    this.searchEl.addEventListener('input', () => { this.query = this.searchEl.value.trim(); this.apply(); });

    /* grid */
    const scroll = document.createElement('div');
    scroll.className = 'inv-cat-scroll';
    this.listEl = document.createElement('div');
    this.listEl.className = 'inv-cat-grid';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'inv-cat-empty';
    this.emptyEl.textContent = TEXT.catalog.empty;
    this.emptyEl.hidden = true;
    scroll.append(this.listEl, this.emptyEl);

    const hint = document.createElement('div');
    hint.className = 'inv-stash-hint';
    hint.textContent = TEXT.catalog.hint;

    this.el.append(head, this.tabsEl, this.searchEl, scroll, hint);
  }

  get isOpen(): boolean { return !this.el.hidden; }
  get activeTab(): CatalogTabId { return this.tab; }

  setOpen(open: boolean): void {
    if (this.el.hidden === !open) return;
    this.el.hidden = !open;
    if (open) { this.ensureBuilt(); this.apply(); }
    else this.searchEl.blur();
  }

  /** Tile element of a def (smoke tests / shake). */
  tileEl(defId: string): HTMLElement | undefined { return this.byDef.get(defId)?.tile; }

  shake(defId: string): void {
    const tile = this.tileEl(defId);
    if (!tile) return;
    tile.classList.remove('is-shake');
    void tile.offsetWidth;
    tile.classList.add('is-shake');
    setTimeout(() => tile.classList.remove('is-shake'), 360);
  }

  setTab(id: CatalogTabId): void {
    if (!this.tabButtons.has(id)) return;
    this.tab = id;
    for (const [tid, b] of this.tabButtons) b.classList.toggle('is-on', tid === id);
    this.apply();
  }

  /** Phase 9: select the tab whose categories include `cat` (`openCatalog({category})`); false when no such tab is built. */
  setTabForCategory(cat: ItemCategory): boolean {
    const tab = CATALOG_TABS.find((t) => t.categories?.includes(cat));
    if (!tab || !this.tabButtons.has(tab.id)) return false;
    this.setTab(tab.id);
    return true;
  }

  setQuery(q: string): void {
    this.searchEl.value = q;
    this.query = q.trim();
    this.apply();
  }

  /** Build the tabs and one tile per item def (once). */
  private ensureBuilt(): void {
    if (this.built) return;
    this.built = true;
    const defs = this.sys.getLoot().getAllItemDefs();
    const present = new Set<ItemCategory>(defs.map((d) => d.category));
    for (const t of CATALOG_TABS) {
      // tabs whose categories have no defs are dropped (e.g. 가구 before furniture items exist)
      if (t.categories && !t.categories.some((c) => present.has(c))) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `inv-cat-tab${t.id === this.tab ? ' is-on' : ''}`;
      b.dataset.tab = t.id;
      b.textContent = t.label;
      b.addEventListener('click', () => this.setTab(t.id));
      this.tabsEl.appendChild(b);
      this.tabButtons.set(t.id, b);
    }
    for (const def of defs) {
      const sample: ItemInstance = { uid: `cat:${def.id}`, defId: def.id, qty: this.sys.catalogQty(def), rotated: false };
      const wrap = document.createElement('div');
      wrap.className = `inv-cat-item cat-${def.category}`;
      wrap.dataset.def = def.id;
      const tile = document.createElement('div');
      tile.dataset.uid = sample.uid;
      buildTileContent(tile, sample, def, TILE_W, TILE_H, this.sys.getStats(sample));
      tile.classList.add('inv-cat-tile');
      tile.addEventListener('pointerdown', (e) => this.handlers.onPointerDown(def, sample, e, tile));
      tile.addEventListener('pointerenter', (e) => { tile.classList.add('is-hover'); this.handlers.onEnter(def, sample, e); });
      tile.addEventListener('pointermove', (e) => this.handlers.onMove(e));
      tile.addEventListener('pointerleave', () => { tile.classList.remove('is-hover'); this.handlers.onLeave(); });
      tile.addEventListener('dblclick', (e) => { e.preventDefault(); this.handlers.onDblClick(def); });
      const cap = document.createElement('div');
      cap.className = 'inv-cat-cap';
      cap.textContent = def.name;
      cap.style.color = rarityColor(def);
      wrap.append(tile, cap);
      const entry: CatalogEntry = { def, sample, el: wrap, tile, key: `${def.name} ${def.id}`.toLowerCase() };
      this.entries.push(entry);
      this.byDef.set(def.id, entry);
    }
  }

  /** Re-append the entries matching the tab + query (tiles are cached, so listeners survive). */
  private apply(): void {
    if (!this.built) return;
    const tab = CATALOG_TABS.find((t) => t.id === this.tab) ?? CATALOG_TABS[0];
    const q = this.query.toLowerCase();
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const e of this.entries) {
      if (tab.categories && !tab.categories.includes(e.def.category)) continue;
      if (q && !e.key.includes(q)) continue;
      frag.appendChild(e.el);
      n++;
    }
    this.listEl.replaceChildren(frag);
    this.emptyEl.hidden = n > 0;
    this.countEl.textContent = TEXT.catalog.count(n);
  }

  /** Number of tiles currently shown (smoke tests). */
  get visibleCount(): number { return this.listEl.childElementCount; }

  dispose(): void {
    this.el.remove();
    this.entries = [];
    this.byDef.clear();
  }

  /** Def lookup passthrough (kept for symmetry with the other views). */
  defOf(id: string): ItemDef | undefined { return this.getDef(id); }
}
