import type { BookSlotInfo, GameContext, ShelfMedium } from '@/shared';
import { SHELF_AUX_BONUS, SHELF_GAIN_MAX, SHELF_MEDIUM_LABEL_KO, SHELF_SLOTS, SHELF_XP_PER_ITEM, buildItemChip, shelfItemOf } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { shelfItemWeightOf } from '../Rules';
import { SHELF_OBJ_KO, SHELF_UNIT_KO, shelfAuxNames, shelfHolderName } from '../model';
import { HousingPanel } from './Panel';
import { type BookDexView, createBookDex } from './BookDex';
import { CHIP_SIZE_SMALL, clear, el, setText, toggleClass } from './dom';

interface SlotCard {
  root: HTMLElement;
  state: HTMLElement;
  chip: HTMLElement;
  line: HTMLElement;
  put: HTMLButtonElement;
  take: HTMLButtonElement;
}

/** 보유 서적 · 보유 디스크 · 보유 레코드 — the picker section heading per medium. */
const OWNED_LABEL: Readonly<Record<ShelfMedium, string>> = { book: '보유 서적', disc: '보유 디스크', record: '보유 레코드' };
/** Where the picker tells the player to look when they own none. */
const EMPTY_TEXT: Readonly<Record<ShelfMedium, string>> = {
  book: '가방과 창고에 서적이 없습니다 — 레이드 컨테이너, 로그 시체, 세레스 상점에서 구하세요',
  disc: '가방과 창고에 디스크가 없습니다 — 레이드 컨테이너, 세레스 상점에서 구하세요',
  record: '가방과 창고에 레코드가 없습니다 — 레이드 컨테이너, 세레스 상점에서 구하세요',
};

const pct = (v: number): string => `${Math.round(v * 100)} %`;

/**
 * 보관함 패널 (Phase 9 책장 → **A-3e 2026-09-12: 책장 · 디스크 전시대 · 레코드랙 공통**). `openShelf(uid)` reads the medium
 * from `housing.getShelfMedium(uid)` and redraws for it: `SHELF_SLOTS[medium]` slot cards (item chip, the skill it teaches
 * and its weight, 꽂기 / 빼기), a picker of the items of that medium the player owns (`getOwnedShelfItems`, bag + stash, item
 * chips with the count — click = select, click again = deselect), **one 보조 가구 line** (`흔들의자 배치됨 — 책 몫 +25 %`, the
 * number from `SHELF_AUX_BONUS`) and the 도감 (`ui/BookDex.ts`, switched to the same medium). Every rule lives in
 * `HousingSystem.placeShelfItem / takeShelfItem` (a 책장 goes through the old `placeBook / takeBook`); the panel only shows
 * their 한국어 reasons. A 책장 emits `ui:bookshelfToggled {open, uid}` exactly as before; a 디스크 전시대 · 레코드랙 emits
 * `ui:shelfToggled {open, uid, medium}`. On the `ui:housingToggled` wire it reports `page: null` like the 재배 panel.
 * The root carries `data-medium` (CSS tints the filled cards per medium).
 */
export class BookshelfMenu extends HousingPanel {
  private uid = '';
  private medium: ShelfMedium = 'book';
  private pickDefId: string | null = null;
  private title: HTMLElement;
  private subtitle: HTMLElement;
  private grid: HTMLElement;
  private cards: SlotCard[] = [];
  private builtFor: ShelfMedium | null = null;
  private ownedLabel: HTMLElement;
  private bookList: HTMLElement;
  private bookHint: HTMLElement;
  private aux: HTMLElement;
  private dex: BookDexView;
  private footHint: HTMLElement;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'bookshelf', 'bookshelf-menu');
    const f = this.frame;
    const head = el('div', { cls: 'hs-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    this.title = el('div', { cls: 'title', text: '책장', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });

    const page = el('div', { cls: 'hs-page', parent: f });
    const secShelf = this.section(page, '보관함 칸');
    this.grid = el('div', { cls: 'hs-shelf', parent: secShelf });
    this.aux = el('div', { cls: 'hs-shelf-aux', text: '', parent: secShelf });

    const secBooks = this.section(page, OWNED_LABEL.book);
    this.ownedLabel = secBooks.querySelector('.ui-label') as HTMLElement;
    this.bookList = el('div', { cls: 'hs-books', parent: secBooks });
    this.bookHint = el('div', { cls: 'hint', text: '', parent: secBooks });

    const secDex = this.section(page, '도감');
    this.dex = createBookDex(ctx, housing, secDex, 'book');

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: f });
    const left = el('div', { cls: 'left', parent: foot });
    this.footHint = el('div', { cls: 'hint', text: '', parent: left });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
    this.buildCards('book');
  }

  /** (Re)build the slot cards when the medium's slot count differs from what is on screen. */
  private buildCards(medium: ShelfMedium): void {
    if (this.builtFor === medium) return;
    this.builtFor = medium;
    clear(this.grid);
    this.cards = [];
    for (let slot = 0; slot < SHELF_SLOTS[medium]; slot++) this.grid.appendChild(this.buildCard(slot).root);
  }

  private buildCard(slot: number): SlotCard {
    const root = el('div', { cls: 'hs-book', attrs: { 'data-slot': String(slot) } });
    const top = el('div', { cls: 'top', parent: root });
    el('span', { cls: 'idx', text: `${slot + 1}번 칸`, parent: top });
    const state = el('span', { cls: 'state', text: '', parent: top });
    const chip = el('div', { cls: 'chipwrap', parent: root });
    const line = el('div', { cls: 'line', text: '', parent: root });
    const actions = el('div', { cls: 'actions', parent: root });
    const put = this.button(actions, '꽂기', () => this.put(slot), 'small primary');
    const take = this.button(actions, '빼기', () => this.take(slot), 'small');
    const card: SlotCard = { root, state, chip, line, put, take };
    this.cards.push(card);
    return card;
  }

  /** The medium on screen (smoke / consumers). */
  get shownMedium(): ShelfMedium { return this.medium; }

  /** Open the panel for one 보관함 (책장 · 디스크 전시대 · 레코드랙 — the medium comes from the piece). */
  openShelf(uid: string): void {
    const medium = typeof this.housing.getShelfMedium === 'function' ? this.housing.getShelfMedium(uid) ?? 'book' : 'book';
    if (this.isOpen && (this.uid !== uid || this.medium !== medium)) this.close(false);   // closing emits for the old piece
    if (this.medium !== medium) this.pickDefId = null;
    this.uid = uid;
    this.medium = medium;
    this.root.dataset.medium = medium;
    this.buildCards(medium);
    this.dex.setMedium(medium);
    this.openPanel();
    if (medium === 'book') this.ctx.bus.emit('ui:bookshelfToggled', { open: true, uid });
    else this.ctx.bus.emit('ui:shelfToggled', { open: true, uid, medium });
  }

  override close(relock = true): void {
    const wasOpen = this.isOpen;
    super.close(relock);
    if (!wasOpen) return;
    if (this.medium === 'book') this.ctx.bus.emit('ui:bookshelfToggled', { open: false, uid: null });
    else this.ctx.bus.emit('ui:shelfToggled', { open: false, uid: null, medium: null });
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  private put(slot: number): void {
    const m = this.medium;
    if (!this.pickDefId) { this.showMsg(`꽂을 ${SHELF_OBJ_KO[m]} 먼저 고르세요`, 'warning'); return; }
    const name = this.housing.nameOf(this.pickDefId);
    const reason = this.housing.placeShelfItem(this.uid, slot, this.pickDefId);
    if (reason) this.showMsg(reason, 'warning');
    else this.showMsg(`${slot + 1}번 칸에 ${name} 꽂기 완료`, 'success');
    this.refresh();
  }

  private take(slot: number): void {
    const reason = this.housing.takeShelfItem(this.uid, slot);
    if (reason) this.showMsg(reason, 'warning');
    else this.showMsg(`${slot + 1}번 칸의 ${SHELF_OBJ_KO[this.medium]} 뺐습니다`, 'success');
    this.refresh();
  }

  private pick(defId: string): void {
    this.pickDefId = this.pickDefId === defId ? null : defId;
    this.refresh();
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
    const infos = h.getShelfSlots(this.uid);
    const filled = infos.filter((i) => i.defId !== null).length;
    setText(this.title, shelf ? `${holder} · 방 ${shelf.room + 1}` : holder);
    setText(this.subtitle, shelf ? `${filled} / ${slots}${SHELF_UNIT_KO[m]} · 꽂힌 ${label}${m === 'book' ? '은' : '는'} 그 숙련의 상승량을 올립니다.` : `${holder}이(가) 사라졌습니다.`);
    setText(this.ownedLabel, OWNED_LABEL[m]);
    setText(this.footHint, `${label} 하나마다 그 숙련의 상승량 +${pct(SHELF_XP_PER_ITEM[m])} × 희귀도 가중치 (${label} 몫은 숙련당 최대 +${pct(SHELF_GAIN_MAX[m] - 1)}, 책 · 디스크 · 레코드 몫은 따로 잘려 더해집니다). 꽂아 본 ${label}${m === 'book' ? '은' : '는'} 도감에 남습니다.`);

    // 보조 가구: 배치만으로 켜진다 — 배율은 계약의 `SHELF_AUX_BONUS` 에서
    const auxOn = h.hasShelfAux(m);
    const names = shelfAuxNames(m);
    setText(this.aux, auxOn
      ? `${names} 배치됨 — ${label} 몫 +${pct(SHELF_AUX_BONUS[m])}`
      : `${names} 을(를) 서재에 두면 ${label} 몫 +${pct(SHELF_AUX_BONUS[m])}`);
    toggleClass(this.aux, 'on', auxOn);

    // picker
    clear(this.bookList);
    const owned = h.getOwnedShelfItems(m);
    if (this.pickDefId && !owned.some((b) => b.defId === this.pickDefId)) this.pickDefId = null;
    if (!owned.length) {
      el('div', { cls: 'hs-empty', text: EMPTY_TEXT[m], parent: this.bookList });
    } else {
      for (const b of owned) {
        const def = h.defOf(b.defId);
        const chip = buildItemChip(def, { have: b.qty, withName: true, size: 38, button: true });
        chip.classList.add('hs-bookpick');
        toggleClass(chip, 'sel', this.pickDefId === b.defId);
        chip.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); this.pick(b.defId); });
        this.bookList.appendChild(chip);
      }
    }
    const picked = this.pickDefId ? h.defOf(this.pickDefId) : undefined;
    const pickedInfo = shelfItemOf(picked);
    setText(this.bookHint, picked && pickedInfo
      ? `${picked.name} · ${this.skillName(pickedInfo.skill)} 숙련 · 가중치 ×${shelfItemWeightOf(picked)}`
      : `${SHELF_OBJ_KO[m]} 고르고 빈 칸의 꽂기를 누르세요. 빼기는 가방(없으면 창고)으로 돌려줍니다.`);

    // slots
    this.cards.forEach((card, slot) => {
      const info: BookSlotInfo | undefined = infos[slot];
      const empty = !info || info.defId === null;
      toggleClass(card.root, 'empty', empty);
      if (empty) {
        setText(card.state, '비어 있음');
        clear(card.chip);
        setText(card.line, this.pickDefId ? `${h.nameOf(this.pickDefId)} 꽂기` : `${SHELF_OBJ_KO[m]} 선택하세요`);
        card.put.hidden = false;
        card.put.disabled = !this.pickDefId;
        card.take.hidden = true;
        return;
      }
      const def = h.defOf(info!.defId!);
      clear(card.chip);
      card.chip.appendChild(buildItemChip(def, { withName: true, size: CHIP_SIZE_SMALL }));
      setText(card.state, info!.skill ? this.skillName(info!.skill) : `알 수 없는 ${label}`);
      setText(card.line, info!.weight > 0 ? `가중치 ×${info!.weight} · ${this.skillName(info!.skill)} ×${h.getBookBonus(info!.skill!).toFixed(2)}` : '효과 없음');
      card.put.hidden = true;
      card.take.hidden = false;
      card.take.disabled = false;
    });

    this.dex.refresh();
  }
}
