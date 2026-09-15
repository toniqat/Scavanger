import type {
  EmbeddedView, GameContext, ItemDef, ItemInstance, LibraryCookTarget, LibraryEffect, LibraryEffectsSummary, LibraryGymTarget,
  LibraryTrustTarget, MealBuff, PlacedFurniture, ShelfMedium, SkillId,
} from '@/shared';
import { LIBRARY_SERIES_MAP, SHELF_MEDIUM_LABEL_KO, SHELF_SLOTS, shelfMediumOfInteraction } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { LIBRARY_GLYPH, SHELF_GLYPH, SHELF_OBJ_KO, SHELF_UNIT_KO, shelfHolderName } from '../model';
import { libraryLineValue, librarySeriesOfItem, shelfHolderMediumOfItem } from '../Rules';
import { HousingPanel } from './Panel';
import { type BookDexView, createBookDex, gameDiscText, libraryEffectText, seriesTint, volumeRoman } from './BookDex';
import { ProductDrag } from './ProductDrag';
import type { Product } from './ProductDrag';
import { type ShelfDrawing, buildShelfDrawing, paintShelfSlot } from './ShelfDrawing';
import { buildStationShell, mountStationGrids } from './StationShell';
import type { StationShell } from './StationShell';
import { clear, el, setText, toggleClass } from './dom';

type ShelfTab = 'shelf' | 'dex';

const pct = (v: number): string => `${Math.round(v * 100)} %`;
/** What a 보관함 accepts, for the wrong-medium refusal (`책장에는 서적만 꽂을 수 있습니다`). */
const ACCEPTS_KO: Readonly<Record<ShelfMedium, string>> = { book: '서적', disc: '디스크', record: '레코드', game: '게임 디스크' };

/**
 * 보관함 화면 (Phase 9 책장 → A-3e 2026-09-12 매체 공통 → 2026-09-13 그려진 선반 + 시리즈 → **2026-09-14 서재 화면 개편**).
 * `openShelf(uid)` reads the medium from `housing.getShelfMedium(uid)` and redraws for it.
 *
 * **2026-09-14 (사용자 결정)** — 틀은 `StationShell` 공통이되 레일과 탭의 역할이 바뀌었다:
 * - **좌측 레일(`.hs-rail`) = 서재 가구 목록**이다 (작업대 제작 창의 `.inv-craft-benches` 와 같은 결). 맨 위가 **「서재」**,
 *   그 아래로 **함선에 실제로 배치된** 책장 · 디스크 전시대 · 레코드랙 · 게임 디스크 전시대가 여러 대여도 전부 한 줄씩.
 *   고르면 창을 닫지 않고 그 자리에서 바뀐다.
 * - **「서재」** = 서재 시설의 보너스. **2026-09-15 (사용자 결정)**: 좌측 상단 `적용 효과`(`.lib-eff-head`) 라벨과 그 아래
 *   **가로로 긴 패널**(`.lib-eff-list`) 하나이고, 패널 안은 **배치된 보관함 가구마다 한 칸**(`.lib-effcard` — 글리프 ·
 *   이름 · `n / N` + 그 가구가 내고 있는 효과 줄)이다. 맨 아래 한 칸이 시설 전체 합산(`getLibraryEffects()`).
 *   **아무 보관함도 배치돼 있지 않으면** 같은 크기의 패널 가운데에 `아무 것도 배치되어 있지 않습니다.` 한 줄만 선다.
 *   ⚠ 값을 여기서 **새로 계산하지 않는다** — 시리즈 상태는 `librarySeriesStates()`, 줄 값은 `libraryLineValue`(선반 칸
 *   정보 줄과 같은 함수), 합산은 `getLibraryEffects()` 다.
 * - **가구를 고르면** 콘텐츠 **상단 가로 탭**(`StationShell.tabsRow`) `[선반] [도감]` 이 보인다 (옛 좌측 레일 탭).
 * - 선반 페이지 = `n / N권` 한 줄 + 가구 그림(`ui/ShelfDrawing`) + 칸 정보 한 줄.
 *   **빈 칸 호버는 아무것도 말하지 않고**, 꽂힌 칸은 `data-item-tip` 으로 `ui/hud/ItemTip` 의 아이템 카드가 뜬다.
 *   **2026-09-15**: 칸의 **숫자 표기가 없다** — 그림에도(`.lib-num` 삭제) 메시지 줄에도 칸 번호를 적지 않는다.
 *
 * 조작:
 * - **꽂기** = 창고 · 가방 타일을 칸으로 끌어다 놓기 (`mountStationGrids` → `dropOn`). 타일 더블클릭 = 첫 빈 칸.
 *   매체가 맞지 않으면 `책장에는 서적만 꽂을 수 있습니다`. 이미 어느 보관함에든 꽂힌 종류면 `이미 꽂혀 있는 책입니다`.
 *   **이미 꽂힌 칸에 놓으면 교체**다 — `takeShelfItem`(가방 먼저 · 없으면 창고) 뒤에 `placeShelfItem`; 꽂기가 거절되면 뺀 것을
 *   같은 칸에 다시 꽂아 되돌린다. 같은 아이템이면 아무 일도 없다.
 * - **빼기** = 꽂힌 칸을 격자로 끌어다 놓기 또는 더블클릭 (`ProductDrag` → `takeShelfItem`, 놓은 격자와 무관하게 가방 먼저).
 *
 * 규칙은 전부 `HousingSystem.placeShelfItem / takeShelfItem`(책장은 옛 `placeBook / takeBook`)이고 패널은 한국어 사유를 옮길 뿐이다.
 * 책장은 `ui:bookshelfToggled {open, uid}`, 그 밖의 보관함은 `ui:shelfToggled {open, uid, medium}`; `ui:housingToggled` 에는 `page: null`.
 * The root carries `data-medium`. `housing:libraryChanged` 도 다시 그린다 (다른 보관함 · 보조 가구의 변화).
 */
export class BookshelfMenu extends HousingPanel {
  private uid = '';
  private medium: ShelfMedium = 'book';
  /** false = 레일의 「서재」 항목 (보관함이 아니라 시설 전체 요약). */
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
  private grids: EmbeddedView | null = null;
  private hoverSlot: number | null = null;
  private railKey = '';
  private libKey = '';
  /** 마지막으로 `ui:*Toggled {open:true}` 를 낸 보관함 (닫기 이벤트를 한 번만 내기 위해). */
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
    // 2026-09-15 (사용자 결정): 좌측 상단 `적용 효과` 라벨 + 그 아래 **가로로 긴 패널** 하나. 패널 안은 배치된 보관함
    // 가구마다 한 칸이고, 아무것도 배치돼 있지 않으면 같은 크기의 패널 가운데에 한 줄만 선다.
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
      onDragStart: () => this.setHover(null),
    });
    this.caseHost.addEventListener('pointerover', (e) => { if (!this.drag.dragging) this.setHover(this.slotAt(e.target as Element | null)); });
    this.caseHost.addEventListener('pointerleave', () => this.setHover(null));
    this.buildDrawing('book');
    // 2026-09-13 (서재 시리즈): 합산이 바뀌면(다른 보관함 · 보조 가구) 몫 · 효과 숫자가 바뀐다
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

  /** Which of the three pages (서재 요약 · 선반 · 도감) is on screen, and whether the tab row shows at all. */
  private applyPages(): void {
    const holder = this.onHolder;
    this.tabsRow.hidden = !holder;
    this.libPage.hidden = holder;
    this.shelfPage.hidden = !holder || this.tab !== 'shelf';
    this.dexPage.hidden = !holder || this.tab !== 'dex';
  }

  /** (Re)build the drawing when the medium on screen changes (the slot count / shape follow it). */
  private buildDrawing(medium: ShelfMedium): void {
    if (this.drawing?.medium === medium) return;
    this.debug.builds++;
    this.hoverSlot = null;
    this.drawing = buildShelfDrawing(this.caseHost, medium);
  }

  /** The medium on screen (smoke / consumers). */
  get shownMedium(): ShelfMedium { return this.medium; }
  /** The 보관함 on screen, `''` while the 「서재」 summary is selected (smoke / consumers). */
  get shownUid(): string { return this.onHolder ? this.uid : ''; }

  /** Open the panel for one 보관함 (책장 · 디스크 전시대 · 레코드랙 · 게임 디스크 전시대 — the medium comes from the piece). */
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

  /** `ui:bookshelfToggled` / `ui:shelfToggled` — one `open: true` per shown 보관함, one `open: false` when it leaves. */
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

  /* ── 좌측 레일 = 서재 가구 목록 ────────────────────────────────────────── */
  /** 함선에 배치된 보관함 전부 — `interaction` 으로 고른다 (defId 를 코드에 적지 않는다). */
  private holders(): readonly PlacedFurniture[] {
    return this.housing.getPlaced().filter((p) => {
      const def = this.housing.getFurnitureDef(p.defId);
      return !!def && shelfMediumOfInteraction(def.interaction) !== null;
    });
  }

  /** 목록은 가구 구성이 바뀔 때만 짓는다 (작업대 목록과 같은 규약). 맨 위는 늘 「서재」. */
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

  /** 선택 표시 + 칸 수만 다시 칠한다. */
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
  /** A tile was dragged out of the 창고 / 가방 onto a slot (`target`), or double-clicked (`target` null → the first empty slot). */
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
    // 2026-09-13: 다른 칸에 이미 꽂힌 종류면 빼기 전에 거절한다 (빼고 되돌리는 왕복 없이)
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
    // 2026-09-15: 칸 번호를 더 말하지 않는다 (`n번 칸의 책을 …` → `책을 …`)
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
    // 고른 보관함이 사라졌으면(회수 · 이동) 「서재」 로 떨어진다
    if (this.onHolder && !list.some((p) => p.uid === this.uid)) { this.onHolder = false; this.applyPages(); this.announce(); }
    this.paintRail();
    if (!this.onHolder) { this.paintLibrary(list); setText(this.shell.title, '서재'); return; }
    this.paintShelf();
    this.dex.refresh();   // 도감은 탭 뒤에 있어도 최신으로 둔다 (탭을 눌렀을 때 한 프레임 늦게 그려지지 않도록)
  }

  /** 선반 페이지 + 제목 + 칸 수. */
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
    const states = h.librarySeriesStates();
    for (const view of this.drawing!.slots) {
      const info = infos[view.slot];
      const def = info?.defId ? h.defOf(info.defId) : undefined;
      if (!info || !info.defId) {
        // 2026-09-14 (사용자 결정): 빈 칸은 아무 말도 하지 않는다 — 호버해도 정보 줄이 비어 있다
        paintShelfSlot(view, { defId: null, color: '', glyph: '', label: '', line: '' });
        continue;
      }
      const name = def?.name ?? info.defId;
      if (game) {
        paintShelfSlot(view, {
          defId: info.defId, color: def?.gameDisc?.color || '#9ff0c8', glyph: def?.icon || SHELF_GLYPH[m], label: name,
          line: `${name}${def ? ` · ${gameDiscText(this.ctx, def)}` : ''}`,
        });
        continue;
      }
      const s = librarySeriesOfItem(def);
      const series = s ? LIBRARY_SERIES_MAP.get(s.seriesId) : undefined;
      if (!s || !series) {
        paintShelfSlot(view, { defId: info.defId, color: '#9aa3ad', glyph: def?.icon || SHELF_GLYPH[m], label: name, line: `${name} · 효과 없음` });
        continue;
      }
      const st = states.get(series.id);
      const fraction = st?.fraction ?? 0;
      const effects = series.effects.map((e) => libraryEffectText(this.ctx, e, st ? libraryLineValue(e, st) : 0)).join(' · ');
      const progress = series.volumes > 1 ? ` ${volumeRoman(s.volume)} (${st?.have ?? 0} / ${series.volumes}${SHELF_UNIT_KO[m]} · 몫 ${pct(fraction)})` : ` (단편 · 몫 ${pct(fraction)})`;
      paintShelfSlot(view, {
        defId: info.defId,
        color: seriesTint(series.id),
        glyph: def?.icon || SHELF_GLYPH[m],
        label: series.name,
        volume: series.volumes > 1 ? volumeRoman(s.volume) : '',
        full: fraction >= 1,
        line: `${name} · ${series.name}${progress}${st ? ` · ${effects}` : ''}`,
      });
    }
    this.paintInfo();
  }

  /**
   * 「서재」 항목의 **`적용 효과` 패널** (2026-09-14 요약 → **2026-09-15 가구별로 나눔**, 사용자 결정).
   *
   * 패널은 **배치된 보관함 가구마다 한 칸**이다 — 머리줄(글리프 · 이름 · `n / N` 칸 수) 아래에 그 가구에 꽂힌 것이
   * 지금 내고 있는 효과 줄이 선다. 값은 **새로 계산하지 않는다**: 시리즈 상태는 `librarySeriesStates()`(= 규칙이
   * 이미 합산해 둔 것)이고 줄 값은 `libraryLineValue` 하나다 (선반 칸의 정보 줄과 **같은 함수**).
   * 맨 아래 한 칸은 시설 전체 합산(`getLibraryEffects()`) — 서로 다른 가구의 같은 시리즈가 합쳐진 결과다.
   *
   * **아무 보관함도 배치돼 있지 않으면** 같은 크기의 패널 가운데에 `아무 것도 배치되어 있지 않습니다.` 한 줄만 선다.
   */
  private paintLibrary(list: readonly PlacedFurniture[]): void {
    const h = this.housing;
    const states = h.librarySeriesStates();
    /** 가구 한 대의 칸 → (중복 없는) 시리즈 → 효과 줄. 게임 디스크 전시대는 시리즈가 없어 늘 빈 목록이다. */
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
    // 시설 전체 합산 — 가구별 줄과 달리 **서로 다른 가구에 흩어진 같은 시리즈**가 합쳐진 결과다
    const sum = el('div', { cls: 'lib-effcard is-total', parent: this.libList });
    const shead = el('div', { cls: 'lib-effcard-head', parent: sum });
    el('i', { cls: 'lib-effcard-ico', text: LIBRARY_GLYPH, parent: shead });
    el('span', { cls: 'lib-effcard-name', text: '서재 전체', parent: shead });
    if (!total.length) el('div', { cls: 'lib-eff-none', text: '효과 없음', parent: sum });
    else for (const text of total) el('div', { cls: 'lib-eff', text, parent: sum });
  }

  /** 시설 전체 합산 줄 — 원본은 `getLibraryEffects()` **하나**다 (2026-09-13 규약). */
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
