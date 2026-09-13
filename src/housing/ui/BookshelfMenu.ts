import type { EmbeddedView, GameContext, ItemDef, ItemInstance, ShelfMedium } from '@/shared';
import { LIBRARY_SERIES_DEFS, LIBRARY_SERIES_MAP, SHELF_AUX_BONUS, SHELF_MEDIUM_LABEL_KO, SHELF_SERIES_VOLUME_SHARE, SHELF_SLOTS } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { SHELF_OBJ_KO, SHELF_UNIT_KO, shelfAuxNames, shelfHolderName } from '../model';
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
/** 받침 없는 매체 이름 뒤의 주격 조사 (`책은` · `디스크는` · `레코드는` · `게임 디스크는`). */
const topicOf = (m: ShelfMedium): string => (m === 'book' ? '은' : '는');
/** The glyph a slot draws when the item def has none. */
const FALLBACK_GLYPH: Readonly<Record<ShelfMedium, string>> = { book: '▤', disc: '◎', record: '◉', game: '⊛' };
/** What a 보관함 accepts, for the wrong-medium refusal (`책장에는 서적만 꽂을 수 있습니다`). */
const ACCEPTS_KO: Readonly<Record<ShelfMedium, string>> = { book: '서적', disc: '디스크', record: '레코드', game: '게임 디스크' };

/**
 * 보관함 화면 (Phase 9 책장 → A-3e 2026-09-12 매체 공통 → 2026-09-13 그려진 선반 + 드래그 → **2026-09-13 서재 시리즈 · 게임 디스크 전시대**).
 * `openShelf(uid)` reads the medium from `housing.getShelfMedium(uid)` and redraws for it.
 *
 * 틀은 `StationShell` 공통이다 (`upgrade: false`): **레일 = 「선반」 · 「도감」 탭, 좌 카드 = 그 페이지, 우 = 함선 창고 · 가방 격자.**
 * 선반 페이지 = `n / 8권` 한 줄 + 가구 그림(`ui/ShelfDrawing` — 칸마다 권 번호 배지 · 전권이면 초록 윤곽) + 칸 정보 한 줄(호버한 칸의
 * `n번 칸 · 이름 · 시리즈 II (2 / 5권 · 몫 20 %) · 효과`, 아니면 사용법) + 보조 가구 한 줄(`.hs-shelf-aux`) + **시리즈 진척**(`.lib-series`
 * — 이 매체의 꽂힌 시리즈마다 이름 · 권 칸(`is-on` 작동 중인 보관함에 꽂힘 · `is-here` 이 보관함에 꽂힘) · `n / N권 · 몫` · 효과 줄의 지금 값).
 * 게임 디스크 전시대는 효과가 없어 보조 가구 줄이 숨고, 시리즈 진척 자리에 꽂힌 게임 디스크 목록(게임기 · 능력치 · 방식)이 선다.
 *
 * 조작:
 * - **꽂기** = 창고 · 가방 타일을 칸으로 끌어다 놓기 (`mountStationGrids` → `dropOn`). 타일 더블클릭 = 첫 빈 칸.
 *   매체가 맞지 않으면 `책장에는 서적만 꽂을 수 있습니다`. 이미 어느 보관함에든 꽂힌 종류면 `이미 꽂혀 있는 책입니다`(2026-09-13 — 효과가 겹치지 않는다).
 *   **이미 꽂힌 칸에 놓으면 교체**다 — `takeShelfItem`(가방 먼저 · 없으면 창고) 뒤에 `placeShelfItem`; 꽂기가 거절되면 뺀 것을 같은 칸에
 *   다시 꽂아 되돌린다. 같은 아이템이면 아무 일도 없다. 함선 밖에서는 교체를 시도하지 않고 `placeShelfItem` 의 사유를 보인다.
 * - **빼기** = 꽂힌 칸을 격자로 끌어다 놓기 또는 더블클릭 (`ProductDrag` → `takeShelfItem`, 놓은 격자와 무관하게 가방 먼저).
 *
 * 규칙은 전부 `HousingSystem.placeShelfItem / takeShelfItem`(책장은 옛 `placeBook / takeBook`)이고 패널은 한국어 사유를 옮길 뿐이다.
 * 책장은 `ui:bookshelfToggled {open, uid}`, 그 밖의 보관함은 `ui:shelfToggled {open, uid, medium}`; `ui:housingToggled` 에는 `page: null`.
 * The root carries `data-medium`. `housing:libraryChanged` 도 다시 그린다 (다른 보관함 · 보조 가구의 변화).
 */
export class BookshelfMenu extends HousingPanel {
  private uid = '';
  private medium: ShelfMedium = 'book';
  private tab: ShelfTab = 'shelf';
  private readonly shell: StationShell;
  private readonly tabBtns: Record<ShelfTab, HTMLButtonElement>;
  private readonly shelfPage: HTMLElement;
  private readonly dexPage: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly caseHost: HTMLElement;
  private readonly infoEl: HTMLElement;
  private readonly aux: HTMLElement;
  private readonly seriesEl: HTMLElement;
  private readonly footHint: HTMLElement;
  private readonly dex: BookDexView;
  private readonly drag: ProductDrag;
  private drawing: ShelfDrawing | null = null;
  private grids: EmbeddedView | null = null;
  private hoverSlot: number | null = null;
  private seriesKey = '';
  /** Smoke / perf counters: how often the shelf drawing was (re)built. */
  readonly debug = { builds: 0 };

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'bookshelf', 'bookshelf-menu hs-station');
    this.coalesceRefresh = true;
    this.shell = buildStationShell(this.frame, {
      title: '책장',
      upgrade: false,
      button: (p, l, fn, c) => this.button(p, l, fn, c),
    });

    const rail = this.shell.rail;
    rail.hidden = false;
    this.tabBtns = { shelf: this.tabButton(rail, '선반', 'shelf'), dex: this.tabButton(rail, '도감', 'dex') };

    const pages = el('div', { cls: 'lib-pages', parent: this.shell.left });
    this.shelfPage = el('div', { cls: 'lib-page', attrs: { 'data-page': 'shelf' }, parent: pages });
    this.countEl = el('div', { cls: 'lib-count', text: '', parent: this.shelfPage });
    this.caseHost = el('div', { cls: 'lib-casehost', parent: this.shelfPage });
    this.infoEl = el('div', { cls: 'lib-info', text: '', parent: this.shelfPage });
    this.aux = el('div', { cls: 'hs-shelf-aux', text: '', parent: this.shelfPage });
    this.seriesEl = el('div', { cls: 'lib-series', parent: this.shelfPage });
    this.dexPage = el('div', { cls: 'lib-page', attrs: { 'data-page': 'dex' }, parent: pages });
    this.dex = createBookDex(ctx, housing, this.dexPage, 'book');
    this.setTab('shelf');

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    this.footHint = el('div', { cls: 'hint', text: '', parent: el('div', { cls: 'left', parent: foot }) });
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
    // 2026-09-13 (서재 시리즈): 합산이 바뀌면(다른 보관함 · 보조 가구 · 전력) 몫 · 효과 숫자가 바뀐다
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
    });
    return b;
  }

  private setTab(id: ShelfTab): void {
    this.tab = id;
    for (const k of Object.keys(this.tabBtns) as ShelfTab[]) toggleClass(this.tabBtns[k], 'is-active', k === id);
    this.shelfPage.hidden = id !== 'shelf';
    this.dexPage.hidden = id !== 'dex';
    if (id === 'dex') this.dex.refresh();
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

  /** Open the panel for one 보관함 (책장 · 디스크 전시대 · 레코드랙 · 게임 디스크 전시대 — the medium comes from the piece). */
  openShelf(uid: string): void {
    const medium = typeof this.housing.getShelfMedium === 'function' ? this.housing.getShelfMedium(uid) ?? 'book' : 'book';
    if (this.isOpen && (this.uid !== uid || this.medium !== medium)) this.close(false);   // closing emits for the old piece
    if (!this.isOpen) this.setTab('shelf');
    this.uid = uid;
    this.medium = medium;
    this.root.dataset.medium = medium;
    this.seriesKey = '';
    this.buildDrawing(medium);
    this.dex.setMedium(medium);
    this.openPanel();
    if (!this.grids) this.grids = mountStationGrids(this.ctx, this.shell.invHost, '.lib-slot[data-slot]', (item, target) => this.dropOn(item, target));
    if (medium === 'book') this.ctx.bus.emit('ui:bookshelfToggled', { open: true, uid });
    else this.ctx.bus.emit('ui:shelfToggled', { open: true, uid, medium });
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
    if (this.medium === 'book') this.ctx.bus.emit('ui:bookshelfToggled', { open: false, uid: null });
    else this.ctx.bus.emit('ui:shelfToggled', { open: false, uid: null, medium: null });
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /** A tile was dragged out of the 창고 / 가방 onto a slot (`target`), or double-clicked (`target` null → the first empty slot). */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
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
    else this.showMsg(`${slot + 1}번 칸에 ${def.name} 꽂기 완료`, 'success');
  }

  /** Dropped onto an occupied slot: take the old one out (bag first), shelve the new one; roll back when the shelving is refused. */
  private swap(slot: number, currentDefId: string, def: ItemDef): void {
    const h = this.housing;
    if (currentDefId === def.id) { this.showMsg(`${slot + 1}번 칸에 이미 ${def.name}이(가) 꽂혀 있습니다`, 'info'); return; }
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
    this.showMsg(`${slot + 1}번 칸: ${h.nameOf(currentDefId)} → ${def.name} 교체 완료`, 'success');
  }

  private take(slot: number): void {
    if (!Number.isInteger(slot)) return;
    const reason = this.housing.takeShelfItem(this.uid, slot);
    if (reason) { this.deny(reason); return; }
    this.setHover(null);
    this.showMsg(`${slot + 1}번 칸의 ${SHELF_OBJ_KO[this.medium]} 뺐습니다`, 'success');
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
    if (slot === null) return null;
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
    const h = this.housing;
    const m = this.medium;
    const label = SHELF_MEDIUM_LABEL_KO[m];
    const holder = shelfHolderName(m);
    const slots = SHELF_SLOTS[m];
    const shelf = h.getPlacedByUid(this.uid);
    const game = m === 'game';
    const infos = shelf ? h.getShelfSlots(this.uid) : [];
    const filled = infos.filter((i) => i.defId !== null).length;
    setText(this.shell.title, shelf ? `${holder} · 방 ${shelf.room + 1}` : holder);
    setText(this.countEl, !shelf ? `${holder}이(가) 사라졌습니다`
      : game ? `${filled} / ${slots}${SHELF_UNIT_KO[m]} · 꽂힌 게임 디스크는 TV 에서 플레이할 수 있습니다`
        : `${filled} / ${slots}${SHELF_UNIT_KO[m]} · 같은 시리즈의 서로 다른 ${label}${topicOf(m)} 효과가 쌓입니다`);
    setText(this.footHint, game
      ? '게임 디스크는 서재 효과가 없습니다 — TV 에 맞는 게임기를 장착하고 TV 정면의 좌석에서 플레이합니다. 같은 게임 디스크는 한 곳에만 꽂힙니다.'
      : `시리즈의 서로 다른 권마다 전권 효과의 ${pct(SHELF_SERIES_VOLUME_SHARE)}, 전권을 모으면 100 %. 같은 ${label}${topicOf(m)} 한 곳에만 꽂히고 한 번만 셉니다. 꽂아 본 ${label}${topicOf(m)} 도감에 남습니다.`);

    // 보조 가구: 배치 + 작동 중이면 켜진다 — 배율은 계약의 `SHELF_AUX_BONUS` 에서. 게임 디스크는 보조 가구가 없다.
    this.aux.hidden = game;
    if (!game) {
      const placed = h.hasShelfAux(m);
      const active = h.libraryAuxActive(m);
      const names = shelfAuxNames(m);
      setText(this.aux, active
        ? `${names} 작동 중 — ${label} 효과 +${pct(SHELF_AUX_BONUS[m])}`
        : placed ? `${names} 이(가) 멈춰 있습니다 — 작동하면 ${label} 효과 +${pct(SHELF_AUX_BONUS[m])}`
          : `${names} 을(를) 서재에 두면 ${label} 효과 +${pct(SHELF_AUX_BONUS[m])}`);
      toggleClass(this.aux, 'on', active);
    }

    this.buildDrawing(m);
    const states = h.librarySeriesStates();
    for (const view of this.drawing!.slots) {
      const info = infos[view.slot];
      const def = info?.defId ? h.defOf(info.defId) : undefined;
      if (!info || !info.defId) {
        paintShelfSlot(view, { defId: null, color: '', glyph: '', label: '', line: `${view.slot + 1}번 칸 · 비어 있음` });
        continue;
      }
      const name = def?.name ?? info.defId;
      if (game) {
        paintShelfSlot(view, {
          defId: info.defId, color: def?.gameDisc?.color || '#9ff0c8', glyph: def?.icon || FALLBACK_GLYPH[m], label: name,
          line: `${view.slot + 1}번 칸 · ${name}${def ? ` · ${gameDiscText(this.ctx, def)}` : ''}`,
        });
        continue;
      }
      const s = librarySeriesOfItem(def);
      const series = s ? LIBRARY_SERIES_MAP.get(s.seriesId) : undefined;
      if (!s || !series) {
        paintShelfSlot(view, { defId: info.defId, color: '#9aa3ad', glyph: def?.icon || FALLBACK_GLYPH[m], label: name, line: `${view.slot + 1}번 칸 · ${name} · 효과 없음` });
        continue;
      }
      const st = states.get(series.id);
      const fraction = st?.fraction ?? 0;
      const effects = series.effects.map((e) => libraryEffectText(this.ctx, e, st ? libraryLineValue(e, st) : 0)).join(' · ');
      const progress = series.volumes > 1 ? ` ${volumeRoman(s.volume)} (${st?.have ?? 0} / ${series.volumes}${SHELF_UNIT_KO[m]} · 몫 ${pct(fraction)})` : ` (단편 · 몫 ${pct(fraction)})`;
      paintShelfSlot(view, {
        defId: info.defId,
        color: seriesTint(series.id),
        glyph: def?.icon || FALLBACK_GLYPH[m],
        label: series.name,
        volume: series.volumes > 1 ? volumeRoman(s.volume) : '',
        full: fraction >= 1,
        line: `${view.slot + 1}번 칸 · ${name} · ${series.name}${progress}${st ? ` · ${effects}` : ' · 보관함이 멈춰 효과 없음'}`,
      });
    }
    this.paintSeries(infos.map((i) => i.defId).filter((d): d is string => d !== null));
    this.paintInfo();
    this.dex.refresh();
  }

  /** 시리즈 진척 (서재 효과 매체) · 꽂힌 게임 디스크 목록 (게임 디스크 전시대). `here` = 이 보관함에 꽂힌 def. */
  private paintSeries(here: readonly string[]): void {
    const h = this.housing;
    const m = this.medium;
    const label = SHELF_MEDIUM_LABEL_KO[m];
    if (m === 'game') {
      const key = `g|${here.join(',')}`;
      if (key === this.seriesKey) return;
      this.seriesKey = key;
      clear(this.seriesEl);
      el('div', { cls: 'lib-series-head', text: '꽂힌 게임', parent: this.seriesEl });
      if (!here.length) { el('div', { cls: 'lib-ser-empty', text: '꽂힌 게임 디스크가 없습니다', parent: this.seriesEl }); return; }
      for (const id of here) {
        const def = h.defOf(id);
        const row = el('div', { cls: 'lib-ser', attrs: { 'data-def': id }, parent: this.seriesEl });
        el('span', { cls: 'lib-ser-name', text: def?.name ?? id, parent: el('div', { cls: 'lib-ser-top', parent: row }) });
        if (def) el('div', { cls: 'lib-ser-line', text: gameDiscText(this.ctx, def), parent: row });
      }
      return;
    }
    const states = h.librarySeriesStates();
    /** 이 보관함에 꽂힌 시리즈 → 권 번호. */
    const hereVolumes = new Map<string, Set<number>>();
    for (const id of here) {
      const s = librarySeriesOfItem(h.defOf(id));
      if (!s) continue;
      let set = hereVolumes.get(s.seriesId);
      if (!set) { set = new Set(); hereVolumes.set(s.seriesId, set); }
      set.add(s.volume);
    }
    const list = LIBRARY_SERIES_DEFS.filter((s) => s.medium === m && (states.has(s.id) || hereVolumes.has(s.id)));
    const rowsData = list.map((s) => {
      const st = states.get(s.id);
      const lines = s.effects.map((e) => {
        const now = st ? libraryLineValue(e, st) : 0;
        const full = e.kind === 'recipe' ? 1 : e.value;
        const nowText = libraryEffectText(this.ctx, e, now);
        const fullText = e.kind === 'recipe' ? (now ? '해금됨' : '전권이면 해금') : `전권 ${libraryEffectText(this.ctx, e, full).replace(/^.* (?=[+−])/, '')}`;
        return { text: e.kind === 'recipe' ? `${nowText} · ${fullText}` : `${nowText}${st && st.fraction >= 1 && !st.auxApplied ? '' : ` (${fullText})`}`, zero: !now };
      });
      return { s, st, lines, here: hereVolumes.get(s.id) ?? new Set<number>() };
    });
    const key = `s|${rowsData.map((r) => `${r.s.id}:${r.st?.volumes.join('.') ?? ''}:${[...r.here].sort().join('.')}:${r.lines.map((l) => l.text).join('/')}`).join('|')}`;
    if (key === this.seriesKey) return;
    this.seriesKey = key;
    clear(this.seriesEl);
    el('div', { cls: 'lib-series-head', text: '시리즈 진척', parent: this.seriesEl });
    if (!rowsData.length) { el('div', { cls: 'lib-ser-empty', text: `꽂힌 ${label}${topicOf(m)} 아직 없습니다`, parent: this.seriesEl }); return; }
    for (const { s, st, lines, here: hv } of rowsData) {
      const row = el('div', { cls: 'lib-ser', attrs: { 'data-series': s.id }, parent: this.seriesEl });
      toggleClass(row, 'is-full', !!st && st.fraction >= 1);
      toggleClass(row, 'is-off', !st);
      const top = el('div', { cls: 'lib-ser-top', parent: row });
      el('span', { cls: 'lib-ser-name', text: s.name, parent: top });
      const pips = el('span', { cls: 'lib-pips', parent: top });
      const live = new Set(st?.volumes ?? []);
      for (let v = 1; v <= s.volumes; v++) {
        const pip = el('i', { cls: `lib-pip${live.has(v) ? ' is-on' : ''}${hv.has(v) ? ' is-here' : ''}`, parent: pips });
        pip.title = s.volumes > 1 ? `${volumeRoman(v)}권` : '단편';
      }
      el('span', {
        cls: 'lib-ser-cnt',
        text: st ? `${st.have} / ${st.total}${SHELF_UNIT_KO[m]} · 몫 ${pct(st.fraction)}` : '보관함이 멈춤 · 효과 없음',
        parent: top,
      });
      for (const l of lines) el('div', { cls: `lib-ser-line${l.zero ? ' is-zero' : ''}`, text: l.text, parent: row });
    }
  }

  /** The line under the shelf: the hovered slot, else how to use the screen. */
  private paintInfo(): void {
    const view = this.hoverSlot !== null ? this.drawing?.slots[this.hoverSlot] : undefined;
    toggleClass(this.infoEl, 'is-slot', !!view);
    setText(this.infoEl, view?.root.dataset.line
      ?? `창고 · 가방에서 ${SHELF_OBJ_KO[this.medium]} 칸으로 끌어다 놓으면 꽂힙니다 · 꽂힌 칸은 더블클릭하거나 격자로 끌어 뺍니다`);
  }

  override dispose(): void {
    this.drag.dispose();
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}
