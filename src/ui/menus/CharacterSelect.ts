import type { GameContext, SlotCard, SlotId, StatDef, StatId } from '@/shared';
import {
  CREATE_STAT_MAX, CREATE_STAT_MIN, DEFAULT_ACCENT, SLOT_IDS, STAT_IDS, activeSlot, deleteSlot, formatCredits,
  markAutoStart, readSlotCards, setActiveSlot,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { AskPopup } from './askPopup';
import { enterShip, hasPendingInvite } from './enterShip';

interface CardEls {
  /** The whole card is a pressable surface but not a `<button>` — a `삭제` button goes inside it (nesting buttons is forbidden). */
  root: HTMLElement;
  bar: HTMLElement;
  slotTag: HTMLElement;
  /** Everything a filled slot holds (hidden as a whole when the slot is empty). */
  filled: HTMLElement;
  empty: HTMLElement;
  name: HTMLElement;
  level: HTMLElement;
  credits: HTMLElement;
  stats: Map<StatId, { value: HTMLElement; fill: HTMLElement }>;
  del: HTMLButtonElement;
}

/**
 * Character select (2026-09-09) — the screen the title's `게임 시작` opens.
 *
 * As many big cards as `SLOT_IDS` (3 slots by default) stand side by side in the centre, filled by `readSlotCards()`.
 * There is no index file — the summary is read straight from that slot's save (`shared/saveSlot`).
 *
 *  - **A filled slot**: name · `Lv. n` · credits · the five stats, and that character's accent colour is the card's
 *    colour (`--ac`). Pressing the card starts with that character, and `삭제`, which cannot be undone, passes a
 *    warning popup (`menus/askPopup`) that writes out what disappears.
 *  - **An empty slot**: `＋ 캐릭터 생성` — opens the creation screen for that slot.
 *
 * **2026-09-15 2nd pass (user's decision)**: the result message (`삭제했습니다` · `서버 연결 중…`) is not a panel under
 * the cards (`.form-msg`) but **text at the right end of the bottom row** (`.ts-msg`) — no border · background ·
 * padding, only the text colour by `kind`. The notice label (`캐릭터마다 창고 · 장비 · 함선 · 진행도가 …`) that stood
 * there is gone.
 *
 * **Starting**: if the chosen slot is already `activeSlot()` it goes straight into the ship with no reload
 * (`menus/enterShip`); another slot means `setActiveSlot` + `markAutoStart` + `location.reload()` — the systems read
 * storage once at boot, so a slot switch always comes with a reload.
 *
 * **The invite link** (`?lobby=CODE`) sits in `menus/enterShip` as the flow the old title's `함선 탑승` held, and the
 * auto start after a reload takes that same path, so an invited player still reaches the shared ship after switching slot.
 *
 * It holds no blocker token and no cursor ownership — the title (`MenuBase`) holds them and this screen is laid on top.
 */
export class CharacterSelect {
  readonly root: HTMLElement;
  private ctx!: GameContext;
  private readonly ask: AskPopup;
  private readonly cards = new Map<SlotId, CardEls>();
  private readonly msg: HTMLElement;
  private readonly sub: HTMLElement;
  private busy = false;
  private _open = false;

  constructor(
    parent: HTMLElement,
    private readonly onBack: () => void,
    private readonly onCreate: (slot: SlotId) => void,
  ) {
    this.root = el('div', { cls: 'title-screen char-select interactive', parent });
    this.root.hidden = true;

    const head = el('div', { cls: 'ts-head', parent: this.root });
    el('div', { cls: 'ts-title', text: '캐릭터 선택', parent: head });
    this.sub = el('div', { cls: 'ts-sub', text: '', parent: head });

    const wrap = el('div', { cls: 'csl-cards', parent: this.root });
    for (const id of SLOT_IDS) this.cards.set(id, this.buildCard(wrap, id));

    /* 2026-09-15 2nd pass (user's decision): the result message is not a panel under the cards but **text at the
       bottom right** — the very spot the old notice label (`캐릭터마다 창고 · 장비 …`) stood in, and that label is
       gone. `.ts-foot` is `space-between`, so `뒤로` stays left even with no message (a hidden message is
       `display: none`). */
    const foot = el('div', { cls: 'ts-foot', parent: this.root });
    const back = el('button', { cls: 'ui-btn', text: '뒤로', parent: foot });
    back.addEventListener('click', (e) => { e.stopPropagation(); this.back(); });
    this.msg = el('div', { cls: 'ts-msg', text: '', parent: foot });
    this.msg.hidden = true;

    this.ask = new AskPopup(this.root);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ── build ────────────────────────────────────────────────────────────── */

  private statDefs(): readonly StatDef[] {
    const defs = (this.ctx as GameContext | undefined)?.progression?.getAllStatDefs?.();
    if (defs && defs.length > 0) return defs;
    return STAT_IDS.map((id) => ({ id, name: id, description: '' }));
  }

  private buildCard(parent: HTMLElement, id: SlotId): CardEls {
    const root = el('div', { cls: 'csl-card', attrs: { role: 'button', tabindex: '0' }, parent });
    const bar = el('div', { cls: 'csl-bar', parent: root });
    const slotTag = el('div', { cls: 'csl-slot', text: `슬롯 ${id}`, parent: root });

    /* empty slot */
    const empty = el('div', { cls: 'csl-empty-wrap', parent: root });
    el('div', { cls: 'csl-plus', text: '＋', parent: empty });
    el('div', { cls: 'csl-empty-label', text: '캐릭터 생성', parent: empty });

    /* filled slot */
    const filled = el('div', { cls: 'csl-filled', parent: root });
    const name = el('div', { cls: 'csl-name', text: '', parent: filled });
    const level = el('div', { cls: 'csl-lv', text: '', parent: filled });

    const meta = el('div', { cls: 'csl-meta', parent: filled });
    const cell = (k: string): HTMLElement => {
      const c = el('div', { cls: 'cell', parent: meta });
      el('div', { cls: 'k', text: k, parent: c });
      return el('div', { cls: 'v', text: '0', parent: c });
    };
    const credits = cell('크레딧');

    el('div', { cls: 'csl-divider', parent: filled });

    const statsWrap = el('div', { cls: 'csl-stats', parent: filled });
    const stats = new Map<StatId, { value: HTMLElement; fill: HTMLElement }>();
    // The stat rows only know their names after `bind`, so they are filled on the first `refresh()`.
    statsWrap.dataset.pending = '1';

    const actions = el('div', { cls: 'csl-actions', parent: filled });
    const del = el('button', { cls: 'ui-btn danger', text: '삭제', parent: actions });
    del.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); this.askDelete(id); });

    root.addEventListener('click', (e) => { e.stopPropagation(); this.pick(id); });
    // The card is not a `<button>`, so Enter / Space are taken by hand (so it can be picked by tabbing too).
    root.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Space') return;
      e.preventDefault();
      e.stopPropagation();
      this.pick(id);
    });

    return { root, bar, slotTag, filled, empty, name, level, credits, stats, del };
  }

  /** One card's five stat rows (a shrunken form of the sheet's vocabulary: name · mono value · thin bar). */
  private fillStatRows(card: CardEls): void {
    const wrap = card.filled.querySelector<HTMLElement>('.csl-stats');
    if (!wrap || !wrap.dataset.pending) return;
    delete wrap.dataset.pending;
    for (const def of this.statDefs()) {
      const row = el('div', { cls: 'cc-mini', parent: wrap });
      const top = el('div', { cls: 'row', parent: row });
      el('div', { cls: 'n', text: def.name, parent: top });
      const value = el('div', { cls: 'v', text: '0', parent: top });
      const bar = el('div', { cls: 'bar', parent: row });
      const fill = el('i', { parent: bar });
      card.stats.set(def.id, { value, fill });
    }
  }

  /* ── state ────────────────────────────────────────────────────────────── */

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.ask.bind(ctx);
  }

  get isOpen(): boolean { return this._open; }
  /** How many slots are filled (debug / smoke). */
  get occupiedCount(): number { return readSlotCards().filter((c) => c.name !== null).length; }

  open(): void {
    this._open = true;
    this.root.hidden = false;
    this.busy = false;
    this.msg.hidden = true;
    this.refresh();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.ask.close();
    this.root.hidden = true;
  }

  private back(): void {
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.close();
    this.onBack();
  }

  /* ── render ───────────────────────────────────────────────────────────── */

  refresh(): void {
    const cards = readSlotCards();
    const active = activeSlot();
    setText(this.sub, hasPendingInvite(this.ctx)
      ? '초대를 수락합니다 — 캐릭터를 고르면 공유 함선으로 합류합니다.'
      : '출격할 대원을 고르세요.');
    for (const data of cards) {
      const card = this.cards.get(data.id);
      if (!card) continue;
      this.fillStatRows(card);
      this.renderCard(card, data, data.id === active);
    }
  }

  private renderCard(card: CardEls, data: SlotCard, isActive: boolean): void {
    const occupied = data.name !== null;
    toggleClass(card.root, 'empty', !occupied);
    toggleClass(card.root, 'is-active', occupied && isActive);
    toggleClass(card.root, 'busy', this.busy);
    card.empty.hidden = occupied;
    card.filled.hidden = !occupied;
    card.bar.hidden = !occupied;
    setText(card.slotTag, `슬롯 ${data.id}`);
    const accent = data.accent ?? DEFAULT_ACCENT;
    card.root.style.setProperty('--ac', accent);
    if (!occupied) return;

    setText(card.name, data.name ?? '');
    setText(card.level, `Lv. ${data.level}`);
    setText(card.credits, formatCredits(data.credits, { suffix: true }));
    // The bar's reference is the creation cap (5), stretched to **that card's own maximum** when a stat has grown
    // above it in game — pinning the cap to `STAT_MAX` (20) flattens a fresh character's five rows to the floor.
    let top = CREATE_STAT_MAX;
    for (const id of card.stats.keys()) top = Math.max(top, data.stats[id] ?? 0);
    const span = Math.max(1, top - CREATE_STAT_MIN);
    for (const [id, row] of card.stats) {
      const v = data.stats[id] ?? 0;
      setText(row.value, String(v));
      const t = Math.max(0, Math.min(1, (v - CREATE_STAT_MIN) / span));
      row.fill.style.transform = `scaleX(${t.toFixed(4)})`;
    }
  }

  /** One line at the bottom right. No frame (border · background · padding); `kind` survives only as the **text colour** (`.ts-msg`, `title.css`). */
  private showMsg(text: string, kind: 'info' | 'warning' | 'danger' | 'success'): void {
    this.msg.className = `ts-msg ${kind}`;
    setText(this.msg, text);
    this.msg.hidden = false;
  }

  /* ── picking ──────────────────────────────────────────────────────────── */

  private pick(id: SlotId): void {
    if (this.busy || this.ask.isOpen) return;
    const card = this.cards.get(id);
    if (card?.root.classList.contains('empty')) {
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.close();
      this.onCreate(id);
      return;
    }
    void this.start(id);
  }

  /**
   * Enters the game with that character. The active slot goes straight in with no reload; any other writes the next
   * boot's slot and reloads (thanks to `markAutoStart` the reload skips the title and lands in the ship).
   */
  private async start(id: SlotId): Promise<void> {
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    if (id !== activeSlot()) {
      setActiveSlot(id);
      markAutoStart();
      window.location.reload();
      return;
    }
    this.busy = true;
    this.refresh();
    await enterShip(this.ctx, {
      setBusy: (busy) => {
        this.busy = busy;
        if (busy) this.showMsg('서버 연결 중…', 'info'); else this.msg.hidden = true;
        this.refresh();
      },
      showMessage: (text, kind) => this.showMsg(text, kind),
      // 2026-09-15: asking the server turned up a squad raid still running — fold the select screen and go to the
      // title's `이어하기` (the title folds itself too)
      onResumeOffer: () => this.back(),
    });
    this.busy = false;
    this.refresh();
  }

  /* ── deleting ─────────────────────────────────────────────────────────── */

  private askDelete(id: SlotId): void {
    if (this.busy) return;
    const card = readSlotCards().find((c) => c.id === id);
    if (!card || card.name === null) return;
    this.ask.open({
      title: '캐릭터 삭제',
      body: `${card.name} (Lv. ${card.level}) 을(를) 지웁니다.\n`
        + '창고 · 장비 · 함선 · 진행도 · 크레딧이 모두 사라집니다. 되돌릴 수 없습니다.',
      ok: '삭제',
      danger: true,
      run: () => this.remove(id),
    });
  }

  private remove(id: SlotId): void {
    deleteSlot(id);
    this.showMsg('캐릭터를 삭제했습니다.', 'warning');
    this.refresh();
    // If what was deleted is the slot this boot loaded, the systems in memory still hold that character — making a
    // new character or picking another slot brings a reload then, so nothing is forced here, only a notice is left.
    if (id === activeSlot()) {
      this.showMsg('캐릭터를 삭제했습니다 — 다른 캐릭터를 고르거나 새로 만들면 새 세이브로 시작합니다.', 'warning');
    }
  }

  dispose(): void {
    this.close();
    this.ask.dispose();
    this.root.remove();
  }
}
