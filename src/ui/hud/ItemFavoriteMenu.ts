import type { GameContext, ItemFavoriteApi } from '@/shared';
import { ITEM_CHIP_FAVORITE_CLASS, ITEM_FAVORITE_MENU_ATTR, setItemChipFavoriteSource } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/** `ctx.escape` token while the menu is up (the topmost screen closes first — this menu sits over its window). */
const ESCAPE_KEY = 'ui:itemFavoriteMenu';
/** Every chip, plus any `[data-def-id]` element that opted in (`ITEM_FAVORITE_MENU_ATTR`, e.g. the 기업 상점 tiles). */
const SELECTOR = `.item-chip[data-def-id], [${ITEM_FAVORITE_MENU_ATTR}][data-def-id]`;

/**
 * Right-click favorite menu on an item chip (2026-09-12, E2).
 *
 * The source of favorites is inventory (`InventoryRef.isFavorite` · `toggleFavorite` · `inventory:favoritesChanged`, E1).
 * Tiles of the inventory grid are taken by inventory's own right-click menu, and this file takes every remaining place
 * where **an item that is not owned** can be turned on too — quest delivery · reward chips, craft · furniture · upgrade
 * material chips (every chip `renderItemCost` draws), contract item chips, and opted-in 기업 상점 tiles. Exactly the way
 * `ItemTip` delegates its hover card, it is **one delegated listener on `ctx.uiRoot`**.
 *
 *   - It listens in the bubble phase: when an inner element `stopPropagation`s in its own `contextmenu` (a grow station
 *     slot · an inventory tile) that menu wins and this one does not appear. It still appears on a chip inside a window
 *     that only `preventDefault`s to block the browser menu (the craft column · the inventory window).
 *   - With an inventory that has no `toggleFavorite` (before implementation · a skeleton) the menu is not opened at all.
 *   - Closing: picking the entry · a pointerdown outside · the wheel · Escape (top of `ctx.escape`) · the window
 *     closing · a phase change.
 *
 * At boot it also registers `setItemChipFavoriteSource` — the query that puts the blue band (`.is-favorite`) on a chip as
 * it is built. After a toggle it takes `inventory:favoritesChanged` and fixes the class of **every chip of that same def
 * already in the DOM**.
 */
export class ItemFavoriteMenu {
  readonly root: HTMLElement;
  private readonly head: HTMLElement;
  private readonly item: HTMLButtonElement;
  private readonly label: HTMLElement;
  private ctx: GameContext | null = null;
  private defId: string | null = null;
  private unsubs: Array<() => void> = [];

  private readonly onContext = (e: MouseEvent): void => {
    const node = e.target as Element | null;
    if (!node || typeof node.closest !== 'function') return;
    const hit = node.closest<HTMLElement>(SELECTOR);
    const defId = hit?.dataset.defId;
    if (!defId) return;
    const api = this.api();
    if (!api || typeof api.toggleFavorite !== 'function') return;
    e.preventDefault();
    this.open(defId, e.clientX, e.clientY);
  };

  private readonly onOutside = (e: PointerEvent): void => {
    if (this.defId !== null && !this.root.contains(e.target as Node | null)) this.close();
  };

  private readonly onWheel = (): void => { if (this.defId !== null) this.close(); };

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'icm', parent, attrs: { role: 'menu' } });
    this.root.hidden = true;
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.head = el('div', { cls: 'icm-head', parent: this.root });
    this.item = el('button', { cls: 'icm-item', parent: this.root, attrs: { type: 'button', role: 'menuitem' } }) as HTMLButtonElement;
    el('span', { cls: 'icm-mark', parent: this.item });
    this.label = el('span', { cls: 'icm-label', parent: this.item });
    this.item.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    // 2026-09-13 (library series): a chip's blue band is 「a favorite **or** a medium not yet shelved in the library」 — one band for both (the one class `.is-favorite`)
    setItemChipFavoriteSource((defId) => this.api()?.isFavorite?.(defId) === true || this.shelfWanted(defId));
    ctx.uiRoot.addEventListener('contextmenu', this.onContext);
    window.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: true });
    const close = (): void => this.close();
    this.unsubs.push(
      () => ctx.uiRoot.removeEventListener('contextmenu', this.onContext),
      () => window.removeEventListener('pointerdown', this.onOutside, true),
      () => window.removeEventListener('wheel', this.onWheel, true),
      ctx.bus.on('inventory:favoritesChanged', ({ defId, favorite }) => this.paint(defId, favorite)),
      ctx.bus.on('housing:libraryChanged', () => this.paintAll()),
      ctx.bus.on('inventory:closed', close),
      ctx.bus.on('game:phaseChanged', close),
      ctx.bus.on('housing:shipManageChanged', close),
    );
  }

  /** Whether the menu is showing (debug / smoke). */
  get isOpen(): boolean { return this.defId !== null; }
  /** Def id the menu is about, null while hidden (debug / smoke). */
  get shownDefId(): string | null { return this.defId; }

  private api(): ItemFavoriteApi | null {
    return (this.ctx?.inventory ?? null) as unknown as ItemFavoriteApi | null;
  }

  private open(defId: string, x: number, y: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const fav = this.api()?.isFavorite?.(defId) === true;
    let name = defId;
    try { name = ctx.loot?.getItemDef(defId)?.name ?? ctx.inventory?.getDef(defId)?.name ?? defId; } catch { /* skeleton */ }
    setText(this.head, name);
    setText(this.label, fav ? '즐겨찾기 끄기' : '즐겨찾기 켜기');
    toggleClass(this.item, 'is-on', fav);
    this.defId = defId;
    this.root.hidden = false;
    // keep it inside the viewport
    const r = this.root.getBoundingClientRect();
    const px = Math.min(x + 2, window.innerWidth - r.width - 8);
    const py = Math.min(y + 2, window.innerHeight - r.height - 8);
    this.root.style.transform = `translate(${Math.max(4, Math.round(px))}px, ${Math.max(4, Math.round(py))}px)`;
    ctx.escape.push(ESCAPE_KEY, () => this.close());
    ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  private toggle(): void {
    const defId = this.defId;
    const api = this.api();
    this.close();
    if (!defId || !api || typeof api.toggleFavorite !== 'function') return;
    const want = !(api.isFavorite?.(defId) === true);
    let now = want;
    try { now = api.toggleFavorite(defId, want) === true; } catch { return; }
    // inventory announces the change too (`inventory:favoritesChanged`); painting here keeps a stub-only source honest
    this.paint(defId, now);
    this.ctx?.bus.emit('audio:play', { id: now ? 'ui_equip' : 'ui_close' });
  }

  /** Re-mark every chip of `defId` already in the DOM (chips built later ask the source themselves). */
  private paint(defId: string, favorite: boolean): void {
    if (typeof defId !== 'string' || !defId) return;
    const sel = `.item-chip[data-def-id="${CSS.escape(defId)}"]`;
    const on = favorite === true || this.shelfWanted(defId);   // 2026-09-13: one class with the library band
    for (const chip of document.querySelectorAll<HTMLElement>(sel)) chip.classList.toggle(ITEM_CHIP_FAVORITE_CLASS, on);
  }

  /** 2026-09-13 (library series): when the library changes, re-decide the band of every chip already drawn (asked once per def). */
  private paintAll(): void {
    const answers = new Map<string, boolean>();
    for (const chip of document.querySelectorAll<HTMLElement>('.item-chip[data-def-id]')) {
      const defId = chip.dataset.defId;
      if (!defId) continue;
      let on = answers.get(defId);
      if (on === undefined) { on = this.api()?.isFavorite?.(defId) === true || this.shelfWanted(defId); answers.set(defId, on); }
      chip.classList.toggle(ITEM_CHIP_FAVORITE_CLASS, on);
    }
  }

  /** `HousingRef.isShelfItemWanted` — the shelf for that medium exists but nothing of the same kind is shelved anywhere. False when the query is missing. */
  private shelfWanted(defId: string): boolean {
    const h = this.ctx?.housing;
    if (!h || typeof h.isShelfItemWanted !== 'function') return false;
    try { return h.isShelfItemWanted(defId) === true; } catch { return false; }
  }

  close(): void {
    if (this.defId === null) return;
    this.defId = null;
    this.root.hidden = true;
    this.ctx?.escape.remove(ESCAPE_KEY);
  }

  dispose(): void {
    this.close();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    setItemChipFavoriteSource(null);
    this.root.remove();
  }
}
