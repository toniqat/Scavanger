import type { GameContext, ItemFavoriteApi } from '@/shared';
import { ITEM_CHIP_FAVORITE_CLASS, ITEM_FAVORITE_MENU_ATTR, setItemChipFavoriteSource } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/** `ctx.escape` token while the menu is up (the topmost screen closes first — this menu sits over its window). */
const ESCAPE_KEY = 'ui:itemFavoriteMenu';
/** Every chip, plus any `[data-def-id]` element that opted in (`ITEM_FAVORITE_MENU_ATTR`, e.g. the 기업 상점 tiles). */
const SELECTOR = `.item-chip[data-def-id], [${ITEM_FAVORITE_MENU_ATTR}][data-def-id]`;

/**
 * 아이템 칩 즐겨찾기 우클릭 메뉴 (2026-09-12, E2).
 *
 * 즐겨찾기의 원본은 inventory 다 (`InventoryRef.isFavorite` · `toggleFavorite` · `inventory:favoritesChanged`, E1). 인벤토리
 * 격자의 타일은 inventory 자신의 우클릭 메뉴가 맡고, 이 파일은 **가지고 있지 않은 아이템도** 켤 수 있는 나머지 자리를 맡는다 —
 * 퀘스트 납품 · 보상 칩, 제작 · 가구 · 업그레이드 재료 칩(`renderItemCost` 가 그리는 모든 칩), 계약 아이템 칩, 그리고
 * 옵트인한 기업 상점 타일. `ItemTip` 이 호버 카드를 위임하는 방식 그대로 **`ctx.uiRoot` 의 위임 리스너 하나**다.
 *
 *   - 버블 단계에서 듣는다: 안쪽 요소가 자기 `contextmenu` 에서 `stopPropagation` 하면(재배 스테이션 슬롯 · 인벤토리 타일)
 *     그쪽 메뉴가 이기고 이 메뉴는 뜨지 않는다. 브라우저 메뉴를 막으려고 `preventDefault` 만 하는 창(제작 열 · 인벤토리 창)
 *     안의 칩에는 그대로 뜬다.
 *   - `toggleFavorite` 가 없는 inventory(구현 전 · 스켈레톤)에서는 메뉴 자체를 띄우지 않는다.
 *   - 닫기: 항목 선택 · 바깥 pointerdown · 휠 · Escape(`ctx.escape` 맨 위) · 창이 닫힘 · 페이즈 변경.
 *
 * 부팅 때 `setItemChipFavoriteSource` 도 등록한다 — 칩이 만들어질 때 파란 띠(`.is-favorite`)를 붙이는 질의다. 켜고 끈 뒤에는
 * `inventory:favoritesChanged` 를 받아 **DOM 에 이미 있는 같은 def 의 칩 전부**의 클래스를 고친다.
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
    setItemChipFavoriteSource((defId) => this.api()?.isFavorite?.(defId) === true);
    ctx.uiRoot.addEventListener('contextmenu', this.onContext);
    window.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: true });
    const close = (): void => this.close();
    this.unsubs.push(
      () => ctx.uiRoot.removeEventListener('contextmenu', this.onContext),
      () => window.removeEventListener('pointerdown', this.onOutside, true),
      () => window.removeEventListener('wheel', this.onWheel, true),
      ctx.bus.on('inventory:favoritesChanged', ({ defId, favorite }) => this.paint(defId, favorite)),
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
    for (const chip of document.querySelectorAll<HTMLElement>(sel)) chip.classList.toggle(ITEM_CHIP_FAVORITE_CLASS, favorite === true);
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
