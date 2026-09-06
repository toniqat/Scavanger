import type { BookSlotInfo, GameContext } from '@/shared';
import { BOOKS_PER_SHELF, BOOK_GAIN_MAX, BOOK_XP_PER_BOOK, buildItemChip } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { bookWeightOf } from '../Rules';
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

/**
 * 책장 패널 (Phase 9, `openBookshelfMenu(uid)` — E on a 서재 책장): `BOOKS_PER_SHELF` slot cards (책 chip, the skill it
 * teaches and its weight, 꽂기 / 빼기), a picker of the books the player owns (`getOwnedBooks()`, bag + stash, item
 * chips with the count — click = select, click again = deselect) and the 도감 (`ui/BookDex.ts`, shared with the 함선
 * tab). Every rule lives in `HousingSystem.placeBook / takeBook`; the panel only shows their 한국어 reasons.
 * Emits `ui:bookshelfToggled {open, uid}`; on the `ui:housingToggled` wire it reports `page: null` like the 재배 panel.
 */
export class BookshelfMenu extends HousingPanel {
  private uid = '';
  private pickDefId: string | null = null;
  private title: HTMLElement;
  private subtitle: HTMLElement;
  private cards: SlotCard[] = [];
  private bookList: HTMLElement;
  private bookHint: HTMLElement;
  private dex: BookDexView;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'bookshelf', 'bookshelf-menu');
    const f = this.frame;
    const head = el('div', { cls: 'hs-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    this.title = el('div', { cls: 'title', text: '책장', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });

    const page = el('div', { cls: 'hs-page', parent: f });
    const secShelf = this.section(page, '책장 칸');
    const grid = el('div', { cls: 'hs-shelf', parent: secShelf });
    for (let slot = 0; slot < BOOKS_PER_SHELF; slot++) grid.appendChild(this.buildCard(slot).root);

    const secBooks = this.section(page, '보유 서적');
    this.bookList = el('div', { cls: 'hs-books', parent: secBooks });
    this.bookHint = el('div', { cls: 'hint', text: '', parent: secBooks });

    const secDex = this.section(page, '도감');
    this.dex = createBookDex(ctx, housing, secDex);

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: f });
    const left = el('div', { cls: 'left', parent: foot });
    el('div', { cls: 'hint', text: `책 한 권마다 그 숙련의 상승량 +${Math.round(BOOK_XP_PER_BOOK * 100)} % × 희귀도 가중치 (숙련당 최대 ×${BOOK_GAIN_MAX.toFixed(1)}). 꽂아 본 책은 도감에 남습니다.`, parent: left });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
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

  /** Open the panel for one 책장. */
  openShelf(uid: string): void {
    this.uid = uid;
    this.openPanel();
    this.ctx.bus.emit('ui:bookshelfToggled', { open: true, uid });
  }

  override close(relock = true): void {
    const wasOpen = this.isOpen;
    super.close(relock);
    if (wasOpen) this.ctx.bus.emit('ui:bookshelfToggled', { open: false, uid: null });
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  private put(slot: number): void {
    if (!this.pickDefId) { this.showMsg('꽂을 책을 먼저 고르세요', 'warning'); return; }
    const name = this.housing.nameOf(this.pickDefId);
    const reason = this.housing.placeBook(this.uid, slot, this.pickDefId);
    if (reason) this.showMsg(reason, 'warning');
    else this.showMsg(`${slot + 1}번 칸에 ${name} 꽂기 완료`, 'success');
    this.refresh();
  }

  private take(slot: number): void {
    const reason = this.housing.takeBook(this.uid, slot);
    if (reason) this.showMsg(reason, 'warning');
    else this.showMsg(`${slot + 1}번 칸의 책을 뺐습니다`, 'success');
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
    const shelf = h.getPlacedByUid(this.uid);
    const infos = h.getBooks(this.uid);
    const filled = infos.filter((i) => i.defId !== null).length;
    setText(this.title, shelf ? `책장 · 방 ${shelf.room + 1}` : '책장');
    setText(this.subtitle, shelf ? `${filled} / ${BOOKS_PER_SHELF}권 · 꽂힌 책은 그 숙련의 상승량을 올립니다.` : '책장이 사라졌습니다.');

    // picker
    clear(this.bookList);
    const owned = h.getOwnedBooks();
    if (this.pickDefId && !owned.some((b) => b.defId === this.pickDefId)) this.pickDefId = null;
    if (!owned.length) {
      el('div', { cls: 'hs-empty', text: '가방과 창고에 서적이 없습니다 — 레이드 컨테이너, 로그 시체, 세레스 상점에서 구하세요', parent: this.bookList });
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
    const picked = this.pickDefId ? h.defOf(this.pickDefId) : null;
    setText(this.bookHint, picked && picked.book
      ? `${picked.name} · ${this.skillName(picked.book.skill)} 숙련 · 가중치 ×${bookWeightOf(picked)}`
      : '책을 고르고 빈 칸의 꽂기를 누르세요. 빼기는 가방(없으면 창고)으로 돌려줍니다.');

    // slots
    this.cards.forEach((card, slot) => {
      const info: BookSlotInfo | undefined = infos[slot];
      const empty = !info || info.defId === null;
      toggleClass(card.root, 'empty', empty);
      if (empty) {
        setText(card.state, '비어 있음');
        clear(card.chip);
        setText(card.line, this.pickDefId ? `${h.nameOf(this.pickDefId)} 꽂기` : '책을 선택하세요');
        card.put.hidden = false;
        card.put.disabled = !this.pickDefId;
        card.take.hidden = true;
        return;
      }
      const def = h.defOf(info!.defId!);
      clear(card.chip);
      card.chip.appendChild(buildItemChip(def, { withName: true, size: CHIP_SIZE_SMALL }));
      setText(card.state, info!.skill ? this.skillName(info!.skill) : '알 수 없는 책');
      setText(card.line, info!.weight > 0 ? `가중치 ×${info!.weight} · ${this.skillName(info!.skill)} ×${h.getBookBonus(info!.skill!).toFixed(2)}` : '효과 없음');
      card.put.hidden = true;
      card.take.hidden = false;
      card.take.disabled = false;
    });

    this.dex.refresh();
  }
}
