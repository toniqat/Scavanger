import type { EmbeddedView, GameContext, ItemDef, ItemInstance, ShelfMedium } from '@/shared';
import { RARITY_COLORS, SHELF_AUX_BONUS, SHELF_GAIN_MAX, SHELF_MEDIUM_LABEL_KO, SHELF_SLOTS, SHELF_XP_PER_ITEM, shelfItemOf } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { SHELF_OBJ_KO, SHELF_UNIT_KO, shelfAuxNames, shelfHolderName } from '../model';
import { HousingPanel } from './Panel';
import { type BookDexView, createBookDex } from './BookDex';
import { ProductDrag } from './ProductDrag';
import type { Product } from './ProductDrag';
import { type ShelfDrawing, buildShelfDrawing, paintShelfSlot } from './ShelfDrawing';
import { buildStationShell, mountStationGrids } from './StationShell';
import type { StationShell } from './StationShell';
import { el, setText, toggleClass } from './dom';

type ShelfTab = 'shelf' | 'dex';

const pct = (v: number): string => `${Math.round(v * 100)} %`;
/** 받침 없는 매체 이름 뒤의 주격 조사 (`책은` · `디스크는` · `레코드는`). */
const topicOf = (m: ShelfMedium): string => (m === 'book' ? '은' : '는');
/** The glyph a slot draws when the item def has none. */
const FALLBACK_GLYPH: Readonly<Record<ShelfMedium, string>> = { book: '▤', disc: '◎', record: '◉' };
/** What a 보관함 accepts, for the wrong-medium refusal (`책장에는 서적만 꽂을 수 있습니다`). */
const ACCEPTS_KO: Readonly<Record<ShelfMedium, string>> = { book: '서적', disc: '디스크', record: '레코드' };

/**
 * 보관함 화면 (Phase 9 책장 → A-3e 2026-09-12 매체 공통 → **2026-09-13 그려진 선반 + 드래그**). `openShelf(uid)` reads the
 * medium from `housing.getShelfMedium(uid)` and redraws for it.
 *
 * 틀은 `StationShell` 공통이다 (`upgrade: false` — 세 보관함 모두 maxLevel 1): **레일 = 「선반」 · 「도감」 탭, 좌 카드 = 그 페이지,
 * 우 = 함선 창고 · 가방 격자.** 선반 페이지는 `n / 8권` 한 줄 + 가구 그림(`ui/ShelfDrawing`) + 칸 정보 한 줄(호버한 칸의
 * `n번 칸 · 이름 · 숙련 · 가중치 · 배율`, 아니면 사용법) + 보조 가구 한 줄(`.hs-shelf-aux`).
 *
 * 조작 (옛 보유 목록 칩 · 꽂기 / 빼기 버튼을 걷어냈다):
 * - **꽂기** = 창고 · 가방 타일을 칸으로 끌어다 놓기 (`mountStationGrids` → `dropOn`). 타일 더블클릭 = 첫 빈 칸.
 *   매체가 맞지 않으면 `책장에는 서적만 꽂을 수 있습니다`. **이미 꽂힌 칸에 놓으면 교체**다 — `takeShelfItem`(가방 먼저 ·
 *   없으면 창고) 뒤에 `placeShelfItem`; 꽂기가 거절되면 뺀 것을 같은 칸에 다시 꽂아 되돌린다(같은 def 라 방금 돌아온
 *   한 권이 소모된다). 같은 아이템이면 아무 일도 없다. 함선 밖에서는 교체를 시도하지 않고 `placeShelfItem` 의 사유를 보인다.
 * - **빼기** = 꽂힌 칸을 격자로 끌어다 놓기 또는 더블클릭 (`ProductDrag` → `takeShelfItem`, 놓은 격자와 무관하게 가방 먼저).
 *
 * 규칙은 전부 `HousingSystem.placeShelfItem / takeShelfItem`(책장은 옛 `placeBook / takeBook`)이고 패널은 한국어 사유를
 * 옮길 뿐이다. 책장은 `ui:bookshelfToggled {open, uid}`, 디스크 전시대 · 레코드랙은 `ui:shelfToggled {open, uid, medium}`;
 * `ui:housingToggled` 에는 `page: null`. The root carries `data-medium`.
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
  private readonly footHint: HTMLElement;
  private readonly dex: BookDexView;
  private readonly drag: ProductDrag;
  private drawing: ShelfDrawing | null = null;
  private grids: EmbeddedView | null = null;
  private hoverSlot: number | null = null;
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

  /** Open the panel for one 보관함 (책장 · 디스크 전시대 · 레코드랙 — the medium comes from the piece). */
  openShelf(uid: string): void {
    const medium = typeof this.housing.getShelfMedium === 'function' ? this.housing.getShelfMedium(uid) ?? 'book' : 'book';
    if (this.isOpen && (this.uid !== uid || this.medium !== medium)) this.close(false);   // closing emits for the old piece
    if (!this.isOpen) this.setTab('shelf');
    this.uid = uid;
    this.medium = medium;
    this.root.dataset.medium = medium;
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
    if (!def || shelfItemOf(def)?.medium !== m) { this.refuse(`${shelfHolderName(m)}에는 ${ACCEPTS_KO[m]}만 꽂을 수 있습니다`); return; }
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

  private skillName(id: string | null): string {
    if (!id) return '';
    try {
      const p = this.ctx.progression;
      return (p && typeof p.getSkillDef === 'function' ? p.getSkillDef(id as never)?.name : '') || id;
    } catch { return id; }
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing;
    const m = this.medium;
    const label = SHELF_MEDIUM_LABEL_KO[m];
    const holder = shelfHolderName(m);
    const slots = SHELF_SLOTS[m];
    const shelf = h.getPlacedByUid(this.uid);
    const infos = shelf ? h.getShelfSlots(this.uid) : [];
    const filled = infos.filter((i) => i.defId !== null).length;
    setText(this.shell.title, shelf ? `${holder} · 방 ${shelf.room + 1}` : holder);
    setText(this.countEl, shelf ? `${filled} / ${slots}${SHELF_UNIT_KO[m]} · 꽂힌 ${label}${topicOf(m)} 그 숙련의 상승량을 올립니다` : `${holder}이(가) 사라졌습니다`);
    setText(this.footHint, `${label} 하나마다 그 숙련의 상승량 +${pct(SHELF_XP_PER_ITEM[m])} × 희귀도 가중치 (${label} 몫은 숙련당 최대 +${pct(SHELF_GAIN_MAX[m] - 1)}, 책 · 디스크 · 레코드 몫은 따로 잘려 더해집니다). 꽂아 본 ${label}${topicOf(m)} 도감에 남습니다.`);

    // 보조 가구: 배치만으로 켜진다 — 배율은 계약의 `SHELF_AUX_BONUS` 에서
    const auxOn = h.hasShelfAux(m);
    const names = shelfAuxNames(m);
    setText(this.aux, auxOn
      ? `${names} 배치됨 — ${label} 몫 +${pct(SHELF_AUX_BONUS[m])}`
      : `${names} 을(를) 서재에 두면 ${label} 몫 +${pct(SHELF_AUX_BONUS[m])}`);
    toggleClass(this.aux, 'on', auxOn);

    this.buildDrawing(m);
    for (const view of this.drawing!.slots) {
      const info = infos[view.slot];
      const def = info?.defId ? h.defOf(info.defId) : undefined;
      if (!info || !info.defId) {
        paintShelfSlot(view, { defId: null, color: '', glyph: '', label: '', line: `${view.slot + 1}번 칸 · 비어 있음` });
        continue;
      }
      const skill = this.skillName(info.skill);
      const effect = info.weight > 0 && info.skill ? `가중치 ×${info.weight} · ${skill} ×${h.getBookBonus(info.skill).toFixed(2)}` : '효과 없음';
      paintShelfSlot(view, {
        defId: info.defId,
        color: RARITY_COLORS[info.rarity ?? def?.rarity ?? 'common'],
        glyph: def?.icon || FALLBACK_GLYPH[m],
        label: skill || def?.name || `알 수 없는 ${label}`,
        line: `${view.slot + 1}번 칸 · ${def?.name ?? info.defId}${skill ? ` · ${skill} 숙련` : ''} · ${effect}`,
      });
    }
    this.paintInfo();
    this.dex.refresh();
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
