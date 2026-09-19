import type {
  EmbeddedView, GameContext, ItemDef, ItemInstance, LibraryCookTarget, LibraryEffect, LibraryEffectsSummary, LibraryGymTarget,
  LibraryTrustTarget, MealBuff, PlacedFurniture, ShelfMedium, SkillId,
} from '@/shared';
import { LIBRARY_SERIES_MAP, SHELF_MEDIUM_LABEL_KO, SHELF_SLOTS, shelfMediumOfInteraction } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { LIBRARY_GLYPH, SHELF_GLYPH, SHELF_OBJ_KO, SHELF_UNIT_KO, shelfHolderName } from '../model';
import { libraryLineValue, librarySeriesOfItem, shelfHolderMediumOfItem } from '../Rules';
import { HousingPanel } from './Panel';
import { type BookDexView, createBookDex, gameDiscText, libraryEffectText, volumeRoman } from './BookDex';
import { ProductDrag } from './ProductDrag';
import type { Product } from './ProductDrag';
import { buildStationItemTile } from './ItemTile';
import { type ShelfDrawing, buildShelfDrawing, paintShelfSlot, shelfFootprint } from './ShelfDrawing';
import { buildStationShell, mountStationGrids } from './StationShell';
import type { StationGridsView } from './StationShell';
import type { StationShell } from './StationShell';
import { clear, el, setText, toggleClass } from './dom';

type ShelfTab = 'shelf' | 'dex';

const pct = (v: number): string => `${Math.round(v * 100)} %`;
/** What a holder accepts, for the wrong-medium refusal (`책장에는 서적만 꽂을 수 있습니다`). */
const ACCEPTS_KO: Readonly<Record<ShelfMedium, string>> = { book: '서적', disc: '디스크', record: '레코드', game: '게임 디스크' };

/**
 * The holder screen (Phase 9 the bookshelf → A-3e 2026-09-12 shared media → 2026-09-13 the drawn shelf + series → **2026-09-14 the library screen rework**).
 * `openShelf(uid)` reads the medium from `housing.getShelfMedium(uid)` and redraws for it.
 *
 * **2026-09-14 (user's decision)** — the frame stays the shared `StationShell`, but the rail's and the tabs' roles changed:
 * - **The left rail (`.hs-rail`) = the list of library furniture** (the same grain as the workbench craft window's `.inv-craft-benches`). 「서재」 on top,
 *   and below it every bookshelf · disc stand · record rack · game disc stand **actually placed on the ship**, one row each however many there are.
 *   Picking one switches in place without closing the window.
 * - **「서재」** = the library facility's bonus. **2026-09-15 (user's decision)**: a top-left `적용 효과` (`.lib-eff-head`) label with, below it,
 *   one **wide panel** (`.lib-eff-list`), and inside the panel **one card per placed holder piece** (`.lib-effcard` — glyph ·
 *   name · `n / N` + the effect lines that piece is giving). The bottom card is the facility total (`getLibraryEffects()`).
 *   **With no holder placed at all**, one line `아무 것도 배치되어 있지 않습니다.` stands in the middle of the same-sized panel.
 *   ⚠ The values are **not computed again** here — the series state is `librarySeriesStates()`, a line's value is `libraryLineValue` (the
 *   same function as the shelf cell's info line), and the sum is `getLibraryEffects()`.
 * - **Picking a piece** shows the content's **top tab row** (`StationShell.tabsRow`) `[선반] [도감]` (the old left-rail tabs).
 * - The shelf page = one `n / N권` line + the furniture drawing (`ui/ShelfDrawing`) + one cell info line.
 *   **Hovering an empty cell says nothing**, and a filled cell raises `ui/hud/ItemTip`'s item card through `data-item-tip`.
 *   **2026-09-15**: a cell carries **no number** — neither the drawing (`.lib-num` deleted) nor the message line prints a cell number.
 *
 * Controls:
 * - **Shelving** = drag a stash · bag tile onto a cell (`mountStationGrids` → `dropOn`). Double-clicking a tile = the first empty cell.
 *   On the wrong medium `책장에는 서적만 꽂을 수 있습니다`. On a kind already shelved in any holder `이미 꽂혀 있는 책입니다`.
 *   **Dropping onto a filled cell replaces** — `takeShelfItem` (bag first · the stash with none) then `placeShelfItem`; when the shelving is refused the
 *   one taken out is shelved in the same cell again. Nothing happens for the same item.
 * - **Taking out** = drag a filled cell onto a grid, or double-click it (`ProductDrag` → `takeShelfItem`, bag first whatever grid it was dropped on).
 *
 * Every rule lives in `HousingSystem.placeShelfItem / takeShelfItem` (the bookshelf on the old `placeBook / takeBook`); the panel only relays the Korean reason.
 * A bookshelf emits `ui:bookshelfToggled {open, uid}`, every other holder `ui:shelfToggled {open, uid, medium}`; `ui:housingToggled` carries `page: null`.
 * The root carries `data-medium`. `housing:libraryChanged` redraws too (another holder's · the aux furniture's change).
 */
export class BookshelfMenu extends HousingPanel {
  private uid = '';
  private medium: ShelfMedium = 'book';
  /** false = the rail's 「서재」 row (the whole facility's summary, not a holder). */
  private onHolder = true;
  private tab: ShelfTab = 'shelf';
  private readonly shell: StationShell;
  private readonly tabsRow: HTMLElement;
  private readonly tabBtns: Record<ShelfTab, HTMLButtonElement>;
  private readonly libPage: HTMLElement;
  private readonly libList: HTMLElement;
  private readonly shelfPage: HTMLElement;
  private readonly dexPage: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly caseHost: HTMLElement;
  private readonly infoEl: HTMLElement;
  private readonly dex: BookDexView;
  private readonly drag: ProductDrag;
  private drawing: ShelfDrawing | null = null;
  /** The current drawing's medium + footprint (`book:1x2`) — when item data arrives late the footprint changes and it is rebuilt. */
  private drawingKey = '';
  private grids: StationGridsView | null = null;
  private hoverSlot: number | null = null;
  private railKey = '';
  private libKey = '';
  /** The holder the last `ui:*Toggled {open:true}` was emitted for (so the closing event fires exactly once). */
  private announced: ShelfMedium | null = null;
  private announcedUid = '';
  /** Smoke / perf counters: how often the shelf drawing was (re)built. */
  readonly debug = { builds: 0 };

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'bookshelf', 'bookshelf-menu hs-station');
    this.coalesceRefresh = true;
    this.shell = buildStationShell(this.frame, {
      title: '서재',
      upgrade: false,
      tabs: true,
      button: (p, l, fn, c) => this.button(p, l, fn, c),
    });

    this.shell.rail.hidden = false;
    this.shell.rail.addEventListener('click', (e) => this.onRailClick(e));

    this.tabsRow = this.shell.tabsRow!;
    this.tabBtns = { shelf: this.tabButton(this.tabsRow, '선반', 'shelf'), dex: this.tabButton(this.tabsRow, '도감', 'dex') };

    const pages = el('div', { cls: 'lib-pages', parent: this.shell.left });
    this.libPage = el('div', { cls: 'lib-page', attrs: { 'data-page': 'library' }, parent: pages });
    // 2026-09-15 (user's decision): a top-left `적용 효과` label + one **wide panel** below it. Inside the panel there is one
    // card per placed holder piece, and with nothing placed one line stands in the middle of the same-sized panel.
    el('div', { cls: 'lib-eff-head', text: '적용 효과', parent: this.libPage });
    this.libList = el('div', { cls: 'lib-eff-list', parent: this.libPage });
    this.shelfPage = el('div', { cls: 'lib-page', attrs: { 'data-page': 'shelf' }, parent: pages });
    this.countEl = el('div', { cls: 'lib-count', text: '', parent: this.shelfPage });
    this.caseHost = el('div', { cls: 'lib-casehost', parent: this.shelfPage });
    this.infoEl = el('div', { cls: 'lib-info', text: '', parent: this.shelfPage });
    this.dexPage = el('div', { cls: 'lib-page', attrs: { 'data-page': 'dex' }, parent: pages });
    this.dex = createBookDex(ctx, housing, this.dexPage, 'book');
    this.setTab('shelf');

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'left', parent: foot });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    this.drag = new ProductDrag(this.caseHost, {
      productAt: (t) => this.productAt(t),
      collect: (key) => this.take(Number(key)),
      defOf: (id) => housing.defOf(id),
      // 2026-09-16: it goes to **the cell** it was dropped on (the grids are made when the panel opens, so they come as a function)
      grids: () => this.grids,
      onDragStart: () => this.setHover(null),
    });
    this.caseHost.addEventListener('pointerover', (e) => { if (!this.drag.dragging) this.setHover(this.slotAt(e.target as Element | null)); });
    this.caseHost.addEventListener('pointerleave', () => this.setHover(null));
    this.buildDrawing('book');
    // 2026-09-13 (library series): when the sum changes (another holder · aux furniture) the share · effect numbers change
    this.unsubs.push(ctx.bus.on('housing:libraryChanged', () => this.refreshIfOpen()));
  }

  private tabButton(parent: HTMLElement, label: string, id: ShelfTab): HTMLButtonElement {
    const b = el('button', { cls: 'hs-tab', text: label, attrs: { 'data-tab': id }, parent });
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.tab === id) return;
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.setTab(id);
      this.refreshIfOpen();
    });
    return b;
  }

  private setTab(id: ShelfTab): void {
    this.tab = id;
    for (const k of Object.keys(this.tabBtns) as ShelfTab[]) toggleClass(this.tabBtns[k], 'is-active', k === id);
    this.applyPages();
    if (id === 'dex' && this.onHolder) this.dex.refresh();
  }

  /** Which of the three pages (the library summary · the shelf · the catalogue) is on screen, and whether the tab row shows at all. */
  private applyPages(): void {
    const holder = this.onHolder;
    this.tabsRow.hidden = !holder;
    this.libPage.hidden = holder;
    this.shelfPage.hidden = !holder || this.tab !== 'shelf';
    this.dexPage.hidden = !holder || this.tab !== 'dex';
  }

  /** (Re)build the drawing when the medium on screen changes (the slot count / shape follow it). */
  private buildDrawing(medium: ShelfMedium): void {
    /* 2026-09-17 (user's decision 「a cell's shape follows the size of the item it takes」): a cell = that medium's item footprint grid.
       At constructor time there is no `ctx.loot` (housing registers before inventory) so the footprint is unknown — it is rebuilt once known. */
    const loot = this.ctx.loot;
    const fp = shelfFootprint(loot && typeof loot.getAllItemDefs === 'function' ? loot.getAllItemDefs() : null, medium);
    const key = `${medium}:${fp ? `${fp.w}x${fp.h}` : '-'}`;
    if (this.drawing && this.drawingKey === key) return;
    this.drawingKey = key;
    this.debug.builds++;
    this.hoverSlot = null;
    this.drawing = buildShelfDrawing(this.caseHost, medium, fp);
  }

  /** The medium on screen (smoke / consumers). */
  get shownMedium(): ShelfMedium { return this.medium; }
  /** The holder on screen, `''` while the 「서재」 summary is selected (smoke / consumers). */
  get shownUid(): string { return this.onHolder ? this.uid : ''; }

  /** Open the panel for one holder (bookshelf · disc stand · record rack · game disc stand — the medium comes from the piece). */
  openShelf(uid: string): void {
    const medium = typeof this.housing.getShelfMedium === 'function' ? this.housing.getShelfMedium(uid) ?? 'book' : 'book';
    if (this.isOpen && (this.uid !== uid || this.medium !== medium)) this.close(false);   // closing emits for the old piece
    if (!this.isOpen) this.setTab('shelf');
    this.railKey = '';
    this.select(uid, medium, false);
    this.openPanel();
    if (!this.grids) this.grids = mountStationGrids(this.ctx, this.shell.invHost, '.lib-slot[data-slot]', (item, target) => this.dropOn(item, target));
    this.announce();
  }

  /** Switch what the left pane shows. `uid` null = the 「서재」 summary. */
  private select(uid: string | null, medium: ShelfMedium | null, refresh = true): void {
    this.drag.end();
    this.setHover(null);
    if (uid) {
      this.uid = uid;
      this.medium = medium ?? this.medium;
      this.onHolder = true;
      this.root.dataset.medium = this.medium;
      this.buildDrawing(this.medium);
      this.dex.setMedium(this.medium);
    } else {
      this.onHolder = false;
      delete this.root.dataset.medium;
    }
    this.applyPages();
    if (refresh) this.refresh();
  }

  /** `ui:bookshelfToggled` / `ui:shelfToggled` — one `open: true` per shown holder, one `open: false` when it leaves. */
  private announce(): void {
    const next = this.onHolder && this.isOpen ? this.medium : null;
    const nextUid = next ? this.uid : '';
    if (this.announced === next && this.announcedUid === nextUid) return;
    if (this.announced !== null) {
      if (this.announced === 'book') this.ctx.bus.emit('ui:bookshelfToggled', { open: false, uid: null });
      else this.ctx.bus.emit('ui:shelfToggled', { open: false, uid: null, medium: null });
      this.announced = null;
      this.announcedUid = '';
    }
    if (!next) return;
    if (next === 'book') this.ctx.bus.emit('ui:bookshelfToggled', { open: true, uid: nextUid });
    else this.ctx.bus.emit('ui:shelfToggled', { open: true, uid: nextUid, medium: next });
    this.announced = next;
    this.announcedUid = nextUid;
  }

  override close(relock = true): void {
    const wasOpen = this.isOpen;
    this.drag.end();
    this.setHover(null);
    // the embedded grids keep listening to `inventory:changed` while they live, so a closed panel drops them
    this.grids?.dispose();
    this.grids = null;
    super.close(relock);
    if (!wasOpen) return;
    this.onHolder = false;
    this.announce();
  }

  /* ── The left rail = the list of library furniture ─────────────────────── */
  /** Every holder placed on the ship — picked by `interaction` (no defId is written into the code). */
  private holders(): readonly PlacedFurniture[] {
    return this.housing.getPlaced().filter((p) => {
      const def = this.housing.getFurnitureDef(p.defId);
      return !!def && shelfMediumOfInteraction(def.interaction) !== null;
    });
  }

  /** The list is built only when the furniture line-up changes (the same contract as the workbench list). 「서재」 is always on top. */
  private buildRail(list: readonly PlacedFurniture[]): void {
    const rail = this.shell.rail;
    clear(rail);
    const top = el('button', { cls: 'hs-rail-item', attrs: { 'data-uid': '' }, parent: rail });
    top.type = 'button';
    el('i', { cls: 'hs-rail-ico', text: LIBRARY_GLYPH, parent: top });
    el('span', { cls: 'hs-rail-name', text: '서재', parent: top });
    const seen: Partial<Record<ShelfMedium, number>> = {};
    for (const p of list) {
      const def = this.housing.getFurnitureDef(p.defId);
      const m = def ? shelfMediumOfInteraction(def.interaction) : null;
      if (!m) continue;
      const n = (seen[m] = (seen[m] ?? 0) + 1);
      const btn = el('button', { cls: 'hs-rail-item', attrs: { 'data-uid': p.uid, 'data-medium': m }, parent: rail });
      btn.type = 'button';
      el('i', { cls: 'hs-rail-ico', text: SHELF_GLYPH[m], parent: btn });
      const name = `${def?.name ?? shelfHolderName(m)}${n > 1 ? ` ${n}` : ''}`;
      el('span', { cls: 'hs-rail-name', text: name, parent: btn });
      el('span', { cls: 'hs-rail-cnt', text: '', parent: btn });
      btn.title = name;
    }
  }

  /** Repaints only the selection mark + the cell count. */
  private paintRail(): void {
    for (const btn of Array.from(this.shell.rail.children) as HTMLElement[]) {
      const uid = btn.dataset.uid ?? '';
      toggleClass(btn, 'is-active', uid ? this.onHolder && uid === this.uid : !this.onHolder);
      const cnt = btn.querySelector<HTMLElement>('.hs-rail-cnt');
      if (!cnt || !uid) continue;
      const m = (btn.dataset.medium ?? 'book') as ShelfMedium;
      const filled = this.housing.getShelfSlots(uid).filter((i) => i.defId !== null).length;
      setText(cnt, `${filled} / ${SHELF_SLOTS[m]}`);
    }
  }

  private onRailClick(e: MouseEvent): void {
    const btn = (e.target as Element | null)?.closest<HTMLElement>('.hs-rail-item');
    if (!btn) return;
    e.stopPropagation();
    const uid = btn.dataset.uid ?? '';
    if (uid ? this.onHolder && uid === this.uid : !this.onHolder) return;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    const medium = uid && typeof this.housing.getShelfMedium === 'function' ? this.housing.getShelfMedium(uid) : null;
    this.select(uid || null, medium ?? null);
    this.announce();
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /** A tile was dragged out of the stash / bag onto a slot (`target`), or double-clicked (`target` null → the first empty slot). */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!this.onHolder) return;
    const h = this.housing;
    const m = this.medium;
    const def = h.defOf(item.defId);
    if (!def || shelfHolderMediumOfItem(def) !== m) { this.refuse(`${shelfHolderName(m)}에는 ${ACCEPTS_KO[m]}만 꽂을 수 있습니다`); return; }
    const infos = h.getShelfSlots(this.uid);
    let slot: number;
    if (target) {
      slot = Number(target.dataset.slot);
      if (!Number.isInteger(slot)) { this.refuse(`없는 ${shelfHolderName(m)} 칸입니다`); return; }
    } else {
      const free = infos.find((i) => i.defId === null);
      if (!free) {
        this.refuse(infos.length ? `빈 칸이 없습니다 — 꽂힌 칸을 더블클릭해 ${SHELF_OBJ_KO[m]} 먼저 빼세요` : `${shelfHolderName(m)}이(가) 없습니다`);
        return;
      }
      slot = free.slot;
    }
    const current = infos[slot]?.defId ?? null;
    if (current && this.ctx.phase === 'hub') { this.swap(slot, current, def); return; }
    const reason = h.placeShelfItem(this.uid, slot, def.id);
    if (reason) this.refuse(reason);
    else this.showMsg(`${def.name} 꽂기 완료`, 'success');
  }

  /** Dropped onto an occupied slot: take the old one out (bag first), shelve the new one; roll back when the shelving is refused. */
  private swap(slot: number, currentDefId: string, def: ItemDef): void {
    const h = this.housing;
    if (currentDefId === def.id) { this.showMsg(`이미 ${def.name}이(가) 꽂혀 있습니다`, 'info'); return; }
    // 2026-09-13: a kind already shelved in another cell is refused before anything is taken out (no take-and-put-back round trip)
    if (h.isShelvedAnywhere(def.id)) { this.refuse(`이미 꽂혀 있는 ${SHELF_MEDIUM_LABEL_KO[this.medium]}입니다`); return; }
    const out = h.takeShelfItem(this.uid, slot);
    if (out) { this.deny(out); return; }
    const put = h.placeShelfItem(this.uid, slot, def.id);
    if (put) {
      h.placeShelfItem(this.uid, slot, currentDefId);   // the copy that just came back goes back in (if even this fails it stays in the bag / stash)
      this.refuse(put);
      return;
    }
    this.showMsg(`${h.nameOf(currentDefId)} → ${def.name} 교체 완료`, 'success');
  }

  private take(slot: number): void {
    if (!Number.isInteger(slot) || !this.onHolder) return;
    const reason = this.housing.takeShelfItem(this.uid, slot);
    if (reason) { this.deny(reason); return; }
    this.setHover(null);
    // 2026-09-15: the cell number is no longer said (`n번 칸의 책을 …` → `책을 …`)
    this.showMsg(`${SHELF_OBJ_KO[this.medium]} 뺐습니다`, 'success');
  }

  /** A refusal the player caused by aiming wrong — deny sound + the message line (no toast). */
  private refuse(reason: string): void {
    this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
    this.showMsg(reason, 'warning');
  }

  private slotAt(target: Element | null): number | null {
    const s = Number(target?.closest<HTMLElement>('.lib-slot[data-slot]')?.dataset.slot);
    return Number.isInteger(s) ? s : null;
  }

  private productAt(target: Element): Product | null {
    const slot = this.slotAt(target);
    if (slot === null || !this.onHolder) return null;
    const defId = this.housing.getShelfSlots(this.uid)[slot]?.defId ?? null;
    return defId ? { key: String(slot), defId, qty: 1 } : null;
  }

  private setHover(slot: number | null): void {
    if (slot === this.hoverSlot) return;
    this.hoverSlot = slot;
    this.paintInfo();
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const list = this.holders();
    const railKey = list.map((p) => `${p.uid}:${p.defId}`).join(',');
    if (railKey !== this.railKey) { this.railKey = railKey; this.buildRail(list); }
    // When the picked holder is gone (recovered · moved) it falls back to 「서재」
    if (this.onHolder && !list.some((p) => p.uid === this.uid)) { this.onHolder = false; this.applyPages(); this.announce(); }
    this.paintRail();
    if (!this.onHolder) { this.paintLibrary(list); setText(this.shell.title, '서재'); return; }
    this.paintShelf();
    this.dex.refresh();   // the catalogue is kept up to date even behind its tab (so pressing the tab never draws one frame late)
  }

  /** The shelf page + the title + the cell count. */
  private paintShelf(): void {
    const h = this.housing;
    const m = this.medium;
    const holder = shelfHolderName(m);
    const slots = SHELF_SLOTS[m];
    const shelf = h.getPlacedByUid(this.uid);
    const game = m === 'game';
    const infos = shelf ? h.getShelfSlots(this.uid) : [];
    const filled = infos.filter((i) => i.defId !== null).length;
    setText(this.shell.title, shelf ? `${holder} · 방 ${shelf.room + 1}` : holder);
    setText(this.countEl, shelf ? `${filled} / ${slots}${SHELF_UNIT_KO[m]}` : `${holder}이(가) 사라졌습니다`);

    this.buildDrawing(m);
    // 2026-09-16: what stands in a cell is **the same tile** as in the bag. 2026-09-17: the tile's cell size is the drawing's grid
    // cell (`drawing.cell`) as it is — an empty cell (the footprint grid) and a filled one are the same box
    const drawing = this.drawing!;
    const cell = drawing.cell;
    const empty = { w: drawing.footprint.w, h: drawing.footprint.h, cell };
    const tileOf = (defId: string): HTMLElement => buildStationItemTile(this.ctx, defId, { cell });
    const states = h.librarySeriesStates();
    for (const view of drawing.slots) {
      const info = infos[view.slot];
      const def = info?.defId ? h.defOf(info.defId) : undefined;
      if (!info || !info.defId) {
        // 2026-09-14 (user's decision): an empty cell says nothing — hovering it leaves the info line empty
        paintShelfSlot(view, { defId: null, line: '' }, tileOf, empty);
        continue;
      }
      const name = def?.name ?? info.defId;
      if (game) {
        paintShelfSlot(view, {
          defId: info.defId,
          line: `${name}${def ? ` · ${gameDiscText(this.ctx, def)}` : ''}`,
        }, tileOf, empty);
        continue;
      }
      const s = librarySeriesOfItem(def);
      const series = s ? LIBRARY_SERIES_MAP.get(s.seriesId) : undefined;
      if (!s || !series) {
        paintShelfSlot(view, { defId: info.defId, line: `${name} · 효과 없음` }, tileOf, empty);
        continue;
      }
      const st = states.get(series.id);
      const fraction = st?.fraction ?? 0;
      const effects = series.effects.map((e) => libraryEffectText(this.ctx, e, st ? libraryLineValue(e, st) : 0)).join(' · ');
      const progress = series.volumes > 1 ? ` ${volumeRoman(s.volume)} (${st?.have ?? 0} / ${series.volumes}${SHELF_UNIT_KO[m]} · 몫 ${pct(fraction)})` : ` (단편 · 몫 ${pct(fraction)})`;
      paintShelfSlot(view, {
        defId: info.defId,
        volume: series.volumes > 1 ? volumeRoman(s.volume) : '',
        full: fraction >= 1,
        line: `${name} · ${series.name}${progress}${st ? ` · ${effects}` : ''}`,
      }, tileOf, empty);
    }
    this.paintInfo();
  }

  /**
   * The 「서재」 row's **`적용 효과` panel** (2026-09-14 a summary → **2026-09-15 split per piece**, user's decision).
   *
   * The panel holds **one card per placed holder piece** — under the header row (glyph · name · `n / N` cell count) stand the
   * effect lines that what is shelved in that piece is giving now. The values are **not computed again**: the series state is
   * `librarySeriesStates()` (= what the rules already summed) and a line's value is `libraryLineValue` (the **same function** as the shelf cell's info line).
   * The bottom card is the facility total (`getLibraryEffects()`) — the same series scattered over different pieces folded together.
   *
   * **With no holder placed at all**, one line `아무 것도 배치되어 있지 않습니다.` stands in the middle of the same-sized panel.
   */
  private paintLibrary(list: readonly PlacedFurniture[]): void {
    const h = this.housing;
    const states = h.librarySeriesStates();
    /** One piece's cells → its (deduplicated) series → the effect lines. The game disc stand has no series, so it is always an empty list. */
    const linesOf = (uid: string): string[] => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const info of h.getShelfSlots(uid)) {
        if (!info.defId) continue;
        const s = librarySeriesOfItem(h.defOf(info.defId));
        if (!s || seen.has(s.seriesId)) continue;
        seen.add(s.seriesId);
        const series = LIBRARY_SERIES_MAP.get(s.seriesId);
        const st = series ? states.get(series.id) : undefined;
        if (!series || !st) continue;
        for (const e of series.effects) {
          const v = libraryLineValue(e, st);
          if (v) out.push(`${series.name} — ${libraryEffectText(this.ctx, e, v)}`);
        }
      }
      return out;
    };

    const cards = list.map((p) => {
      const def = h.getFurnitureDef(p.defId);
      const m = def ? shelfMediumOfInteraction(def.interaction) : null;
      if (!m) return null;
      const infos = h.getShelfSlots(p.uid);
      return {
        uid: p.uid, medium: m, name: def?.name ?? shelfHolderName(m),
        filled: infos.filter((i) => i.defId !== null).length, slots: SHELF_SLOTS[m], lines: linesOf(p.uid),
      };
    }).filter((c): c is NonNullable<typeof c> => c !== null);

    const total = this.totalLines();
    const key = `${cards.map((c) => `${c.uid}:${c.name}:${c.filled}/${c.slots}:${c.lines.join('|')}`).join('#')}##${total.join('|')}`;
    if (key === this.libKey) return;
    this.libKey = key;
    clear(this.libList);
    if (!cards.length) {
      el('div', { cls: 'lib-eff-empty', text: '아무 것도 배치되어 있지 않습니다.', parent: this.libList });
      return;
    }
    for (const c of cards) {
      const card = el('div', { cls: 'lib-effcard', attrs: { 'data-uid': c.uid, 'data-medium': c.medium }, parent: this.libList });
      const head = el('div', { cls: 'lib-effcard-head', parent: card });
      el('i', { cls: 'lib-effcard-ico', text: SHELF_GLYPH[c.medium], parent: head });
      el('span', { cls: 'lib-effcard-name', text: c.name, parent: head });
      el('span', { cls: 'lib-effcard-cnt', text: `${c.filled} / ${c.slots}${SHELF_UNIT_KO[c.medium]}`, parent: head });
      if (!c.lines.length) { el('div', { cls: 'lib-eff-none', text: '효과 없음', parent: card }); continue; }
      for (const text of c.lines) el('div', { cls: 'lib-eff', text, parent: card });
    }
    // The facility total — unlike the per-piece lines, **the same series scattered over different pieces** is folded together here
    const sum = el('div', { cls: 'lib-effcard is-total', parent: this.libList });
    const shead = el('div', { cls: 'lib-effcard-head', parent: sum });
    el('i', { cls: 'lib-effcard-ico', text: LIBRARY_GLYPH, parent: shead });
    el('span', { cls: 'lib-effcard-name', text: '서재 전체', parent: shead });
    if (!total.length) el('div', { cls: 'lib-eff-none', text: '효과 없음', parent: sum });
    else for (const text of total) el('div', { cls: 'lib-eff', text, parent: sum });
  }

  /** The facility total lines — the source is `getLibraryEffects()`, **one** place (the 2026-09-13 contract). */
  private totalLines(): string[] {
    const h = this.housing;
    const e: LibraryEffectsSummary | null = typeof h.getLibraryEffects === 'function' ? h.getLibraryEffects() : null;
    const lines: string[] = [];
    if (!e) return lines;
    const push = (eff: LibraryEffect, v: number): void => { if (v) lines.push(libraryEffectText(this.ctx, eff, v)); };
    for (const [k, v] of Object.entries(e.skillGain)) push({ kind: 'skillGain', target: k as SkillId, value: v ?? 0 }, v ?? 0);
    for (const [k, v] of Object.entries(e.derived)) push({ kind: 'derived', target: k as MealBuff, value: v ?? 0 }, v ?? 0);
    for (const [k, v] of Object.entries(e.gymScore)) push({ kind: 'gymScore', target: k as LibraryGymTarget, value: v ?? 0 }, v ?? 0);
    for (const [k, v] of Object.entries(e.cookScore)) push({ kind: 'cookScore', target: k as LibraryCookTarget, value: v ?? 0 }, v ?? 0);
    push({ kind: 'raidXp', target: '', value: e.raidXp }, e.raidXp);
    for (const [k, v] of Object.entries(e.trustXp)) push({ kind: 'trustXp', target: k as LibraryTrustTarget, value: v ?? 0 }, v ?? 0);
    if (e.recipes.length) lines.push(`해금된 레시피 ${e.recipes.length}종`);
    return lines;
  }

  /** The line under the shelf: the hovered slot only (an empty slot and no hover say nothing). */
  private paintInfo(): void {
    const view = this.hoverSlot !== null ? this.drawing?.slots.find((s) => s.slot === this.hoverSlot) : undefined;
    setText(this.infoEl, view?.root.dataset.line ?? '');
  }

  override dispose(): void {
    this.drag.dispose();
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}
