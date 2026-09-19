import type { GameContext, ImplantDef, ImplantId, ImplantMode, ItemDef, ItemInstance, StatId } from '@/shared';
import { Keys, PERK_DEFS, RARITY_COLORS, RARITY_LABEL_KO, buildItemChip, keyLabel } from '@/shared';
import type { InventorySystem } from '../InventorySystem';

/* ────────────────────────────────────────────────────────────────────────────
 * src/inventory/ui/ImplantPanel.ts — **the implant block** (the tactical implant + implant items).
 *
 * 2026-09-08: both blocks moved here from the character sheet (`progression/ui/SheetBody`). An implant is **gear** taken
 * into a raid, not a character-stat screen, and it has to travel in the loadout preset (`LoadoutPreset.implant` ·
 * `implantItems`), so directly under the equipment slots (`.inv-equip`) is its place. Nothing is left on the character tab.
 *
 *   • **The tactical implant** — one of the 5 used with Q (2026-09-15: `대전차포` retired). Pressing the one slot card opens a modeless
 *     picker (`.inv-imp-pop`) and picking a card equips it through `ctx.implants.setEquipped`. It is locked during a raid.
 *     **2026-09-12 (user's decision)**: that slot is not a horizontal bar but a **square thumbnail** the height of the other
 *     equipment slots, and this block (`.inv-implants`) itself goes into the equipment grid's `implant` cell (under 주무기 II · left of the pouch).
 *   • **Implant items** — items carrying `ItemDef.implant`. `임플란트 n / m칸` + the pip row, and below it the equipped ones are
 *     a **horizontal row of square thumbnails** (`.inv-impi-cell`, click = unequip) with the `＋` cell at the end of the row
 *     raising the second picker (`.inv-impi-pop`). Candidates are swept from the bag + 함선 창고.
 *     The thumbnails carry no text — name · 장착칸 · perk · stats are said by `ui/hud/ItemTip`'s hover card through
 *     `data-item-tip` (2026-09-08: a vertical card list was filling one inventory column with three lines of prose each).
 *
 * Both pickers are **direct children of `ctx.uiRoot`** — `.inv-root`'s opening animation leaves a `scale:` behind, which
 * would then become the containing block of a `position: fixed` popup (the same reason the character sheet had).
 *
 * Per the cross-folder contract it imports no other feature folder's internals: stat implants travel only through
 * `ctx.progression` (ProgressionRef), the tactical implant only through `ctx.implants` (ImplantsRef). This panel holds no state at all.
 * ──────────────────────────────────────────────────────────────────────────── */

interface ElOptions { cls?: string; text?: string; parent?: HTMLElement; attrs?: Record<string, string> }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, o: ElOptions = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (o.cls) e.className = o.cls;
  if (o.text !== undefined) e.textContent = o.text;
  if (o.attrs) for (const k in o.attrs) e.setAttribute(k, o.attrs[k]);
  if (o.parent) o.parent.appendChild(e);
  return e;
}

function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

/** The tactical implant (Q). */
const TAC_TEXT = {
  label: '전술 임플란트',
  empty: '장착한 임플란트가 없습니다 — 칸을 눌러 고르세요.',
  slotEmpty: '비어 있음',
  pick: '임플란트 선택',
  unavailable: '임플란트 시스템을 사용할 수 없습니다.',
  raidLocked: '레이드 중에는 임플란트를 교체할 수 없습니다 — 함선에서 바꾸세요.',
  equipped: '장착',
  unequipped: '임플란트를 해제했습니다',
  cooldown: '쿨타임',
  charges: '충전',
  mode: { instant: '즉시', hold: '홀드', wielded: '장비형' } as Readonly<Record<ImplantMode, string>>,
};

/** Implant items (stats · perk). */
const ITEM_TEXT = {
  label: '임플란트',
  slots: (used: number, total: number) => `${used} / ${total}칸`,
  slotCost: (n: number) => `장착칸 ${n}`,
  add: '＋',
  pick: '임플란트 장착',
  nothingToPick: '가방과 함선 창고에 임플란트가 없습니다 — 레이드에서 망가진 임플란트를 찾아 세레스 바이오에서 수리하세요.',
  raidLocked: '레이드 중에는 교체할 수 없습니다',
  shipOnly: '함선에서만 교체할 수 있습니다',
  noRoom: '보관할 공간이 없습니다 — 가방이나 함선 창고를 비우세요',
  broken: '망가짐 — 세레스 바이오에서 수리',
  noFit: '장착칸 부족',
  equipped: '장착',
  unequipped: '해제',
  failed: '장착할 수 없습니다',
};

const RARITY_ORDER: readonly string[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

/** `근력 +2 · 재주 +1` for an implant def (empty string when it has no stat bonus). */
function implantStatLine(def: ItemDef | undefined, statName: (id: StatId) => string): string {
  const stats = def?.implant?.stats;
  if (!stats) return '';
  const parts: string[] = [];
  for (const [id, v] of Object.entries(stats) as Array<[StatId, number | undefined]>) {
    if (typeof v === 'number' && v !== 0) parts.push(`${statName(id)} ${v > 0 ? '+' : ''}${v}`);
  }
  return parts.join(' · ');
}

export class ImplantPanel {
  readonly root: HTMLElement;

  /* tactical implant */
  private readonly tacSlot: HTMLButtonElement;
  private readonly tacHint: HTMLElement;
  private readonly tacPop: HTMLElement;
  private readonly tacGrid: HTMLElement;
  private readonly tacCards = new Map<ImplantId, { root: HTMLButtonElement; meta: HTMLElement }>();
  private tacPickerOpen = false;

  /* implant items */
  private readonly itemCount: HTMLElement;
  private readonly itemPips: HTMLElement;
  private readonly itemList: HTMLElement;
  private readonly itemMsg: HTMLElement;
  private readonly itemAdd: HTMLButtonElement;
  private readonly itemPop: HTMLElement;
  private readonly itemOpts: HTMLElement;
  private itemPickerOpen = false;
  private itemMsgTimer = 0;

  private disposed = false;

  private readonly onTacOutside = (e: PointerEvent): void => {
    const t = e.target as Node | null;
    if (!t || this.tacPop.contains(t) || this.tacSlot.contains(t)) return;
    this.closeTacPicker();
  };
  private readonly onTacKey = (e: KeyboardEvent): void => {
    if (!this.tacPickerOpen || e.code !== 'Escape') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.closeTacPicker();
  };
  private readonly onItemOutside = (e: PointerEvent): void => {
    const t = e.target as Node | null;
    if (!t || this.itemPop.contains(t) || this.itemAdd.contains(t)) return;
    this.closeItemPicker();
  };
  private readonly onItemKey = (e: KeyboardEvent): void => {
    if (!this.itemPickerOpen || e.code !== 'Escape') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.closeItemPicker();
  };

  constructor(private readonly sys: InventorySystem, private readonly ctx: GameContext) {
    const root = this.root = el('div', { cls: 'inv-implants' });

    /* ── tactical implant ── */
    const tacHead = el('div', { cls: 'h', parent: root });
    el('div', { cls: 'inv-eyebrow', text: TAC_TEXT.label, parent: tacHead });
    el('kbd', { cls: 'inv-imp-key', text: keyLabel(Keys.IMPLANT), parent: tacHead });
    this.tacSlot = this.buildTacSlot(root);
    this.tacHint = el('div', { cls: 'hint', text: '', parent: root });

    this.tacPop = el('div', { cls: 'inv-imp-pop interactive', parent: ctx.uiRoot });
    this.tacPop.hidden = true;
    const tacPopHead = el('div', { cls: 'h', parent: this.tacPop });
    el('div', { cls: 'inv-eyebrow', text: TAC_TEXT.pick, parent: tacPopHead });
    const tacClose = el('button', { cls: 'inv-btn inv-imp-close', text: '닫기', parent: tacPopHead, attrs: { type: 'button' } });
    tacClose.addEventListener('click', (e) => { e.stopPropagation(); this.closeTacPicker(); });
    this.tacGrid = el('div', { cls: 'inv-imp-grid', parent: this.tacPop });
    this.buildTacCards();

    /* ── implant items ── */
    const block = el('div', { cls: 'inv-impitems', parent: root });
    const head = el('div', { cls: 'h', parent: block });
    el('div', { cls: 'inv-eyebrow', text: ITEM_TEXT.label, parent: head });
    this.itemCount = el('div', { cls: 'cnt ui-mono', text: '', parent: head });
    this.itemPips = el('div', { cls: 'inv-impi-pips', parent: block });
    this.itemList = el('div', { cls: 'inv-impi-list', parent: block });
    this.itemMsg = el('div', { cls: 'inv-impi-msg', text: '', parent: block });
    this.itemMsg.hidden = true;
    // (the `＋` cell is appended to `itemList` below so it sits at the end of the thumbnail row)
    this.itemAdd = el('button', { cls: 'inv-impi-cell inv-impi-add', text: ITEM_TEXT.add, parent: this.itemList, attrs: { type: 'button', 'aria-label': ITEM_TEXT.pick } });
    this.itemAdd.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.itemPickerOpen) { this.closeItemPicker(); return; }
      const why = this.swapBlockReason();
      if (why) { this.showItemMsg(why, true); return; }
      this.openItemPicker();
    });

    this.itemPop = el('div', { cls: 'inv-impi-pop interactive', parent: ctx.uiRoot });
    this.itemPop.hidden = true;
    const itemPopHead = el('div', { cls: 'h', parent: this.itemPop });
    el('div', { cls: 'inv-eyebrow', text: ITEM_TEXT.pick, parent: itemPopHead });
    const itemClose = el('button', { cls: 'inv-btn inv-imp-close', text: '닫기', parent: itemPopHead, attrs: { type: 'button' } });
    itemClose.addEventListener('click', (e) => { e.stopPropagation(); this.closeItemPicker(); });
    this.itemOpts = el('div', { cls: 'inv-impi-opts', parent: this.itemPop });
  }

  /* ══ shared ═════════════════════════════════════════════════════════════ */

  /** true while either picker is up — the window's Escape chain consumes it before closing itself. */
  get isPickerOpen(): boolean { return this.tacPickerOpen || this.itemPickerOpen; }

  /** Closes both pickers; true when one was actually open. */
  closePickers(): boolean {
    const a = this.closeItemPicker();
    const b = this.closeTacPicker();
    return a || b;
  }

  /**
   * 2026-09-14 2nd pass (user's decision) — **the tactical implant · implants are hidden during the tutorial.** The HUD
   * widget (`ui/hud/ImplantWidget`) already folds on `hides('hud', 'implant')`, so the inventory screen's **equipment
   * slot** reads the same query — 「what is blocked is hidden」 (`shared/tutorial`), the same trick as `ui/InventoryUI`
   * asking `hides('stashItem', …)`. The query is true **only inside the tutorial raid track** and always false outside
   * it, so the ordinary screen does not change by one character. (`[hidden]` is `display: none !important` in
   * `ui/styles/base.css`, so it beats `.inv-implants`'s `display: flex` — the equipment grid's `implant` cell goes empty.)
   */
  refresh(): void {
    if (this.disposed) return;
    const hidden = this.ctx.tutorial?.hides('hud', 'implant') ?? false;
    if (hidden !== this.root.hidden) {
      this.root.hidden = hidden;
      if (hidden) this.closePickers();   // a picker that was up closes with it (a direct child of `ctx.uiRoot`, it would not follow)
    }
    if (hidden) return;
    this.refreshTactical();
    this.refreshItems();
    if (this.itemPickerOpen) this.refreshItemOptions();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closePickers();
    window.clearTimeout(this.itemMsgTimer);
    this.tacPop.remove();
    this.itemPop.remove();
    this.root.remove();
    this.tacCards.clear();
  }

  private itemDef(defId: string): ItemDef | undefined {
    try { return this.sys.getDef(defId); } catch { return undefined; }
  }

  private statName(id: StatId): string {
    try { return this.ctx.progression?.getStatDef(id)?.name ?? id; } catch { return id; }
  }

  private inRaid(): boolean {
    try { return this.ctx.isRaidActive(); } catch { return false; }
  }

  /** Anchor `pop` to the left of `anchor`, clamped into the viewport (both pickers share the rule). */
  private place(pop: HTMLElement, anchor: HTMLElement, alignBottom: boolean): void {
    const a = anchor.getBoundingClientRect();
    const r = pop.getBoundingClientRect();
    const m = 12;
    let left = a.left - r.width - m;
    if (left < m) left = Math.min(a.right + m, window.innerWidth - r.width - m);
    const wanted = alignBottom ? a.bottom - r.height : a.top;
    const top = Math.min(Math.max(m, wanted), window.innerHeight - r.height - m);
    pop.style.left = `${Math.round(Math.max(m, left))}px`;
    pop.style.top = `${Math.round(Math.max(m, top))}px`;
  }

  /* ══ tactical implant ═══════════════════════════════════════════════════ */

  /**
   * **2026-09-12 (user's decision) — a square thumbnail.** It was a horizontal bar of icon + name + tag (`display: flex`),
   * and once this block moved into one cell of the equipment grid (`grid-area: implant`) its shape no longer matched the
   * cells beside it. Now it is a **square cell** the height of the other equipment slots: the icon large in the centre,
   * the name a **bottom caption**, the mode a small top-right tag. Still no description here (2026-09-08) — the picker's card says it.
   */
  private buildTacSlot(parent: HTMLElement): HTMLButtonElement {
    const slot = el('button', { cls: 'inv-imp-slot', parent, attrs: { type: 'button' } });
    el('span', { cls: 'ico', parent: slot }).setAttribute('aria-hidden', 'true');
    el('span', { cls: 'tag', parent: slot });
    el('span', { cls: 'nm', parent: slot });
    slot.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.tacPickerOpen) { this.closeTacPicker(); return; }
      if (this.inRaid()) {
        this.ctx.bus.emit('audio:play', { id: 'ui_error' });
        this.ctx.bus.emit('ui:notify', { text: TAC_TEXT.raidLocked, kind: 'warning', duration: 1.8 });
        return;
      }
      this.openTacPicker();
    });
    return slot;
  }

  /**
   * One card per implant. Re-run from `refreshTactical` while the list is still empty: `ctx.implants` is published by
   * `ImplantSystem.init`, which runs **after** `InventorySystem.init` builds this panel (see `main.ts`), so the
   * first build would otherwise leave the picker permanently empty.
   */
  private buildTacCards(): void {
    for (const def of this.ctx.implants?.getAllDefs() ?? []) this.buildTacCard(def.id);
    this.root.classList.toggle('is-empty', this.tacCards.size === 0);
  }

  private buildTacCard(id: ImplantId): void {
    const def = this.ctx.implants?.getDef(id);
    if (!def) return;
    const card = el('button', { cls: 'inv-imp-card', parent: this.tacGrid, attrs: { type: 'button', 'data-id': id, title: def.description } });
    card.style.setProperty('--ic', def.color);
    el('span', { cls: 'ico', text: def.icon, parent: card }).setAttribute('aria-hidden', 'true');
    const body = el('span', { cls: 'body', parent: card });
    const line = el('span', { cls: 'line', parent: body });
    el('span', { cls: 'nm', text: def.name, parent: line });
    el('span', { cls: 'tag', text: TAC_TEXT.mode[def.mode], parent: line });
    el('span', { cls: 'desc', text: def.description, parent: body });
    const meta = el('span', { cls: 'meta', text: '', parent: body });
    card.addEventListener('click', (e) => { e.stopPropagation(); this.pickTactical(id); this.closeTacPicker(); });
    this.tacCards.set(id, { root: card, meta });
  }

  private refreshTactical(): void {
    const imp = this.ctx.implants;
    if (this.tacCards.size === 0 && imp) this.buildTacCards();
    if (this.tacCards.size === 0) {
      setText(this.tacHint, imp ? TAC_TEXT.empty : TAC_TEXT.unavailable);
      this.tacHint.hidden = false;
      this.paintTacSlot(null, false);
      return;
    }
    const inRaid = this.inRaid();
    const equipped = imp?.equipped ?? null;
    const def = equipped ? imp?.getDef(equipped) ?? null : null;
    // the slot card already carries the name / mode / description, so the hint is only the raid lock
    setText(this.tacHint, inRaid ? TAC_TEXT.raidLocked : '');
    this.tacHint.hidden = !inRaid;
    for (const [id, card] of this.tacCards) {
      const d = imp?.getDef(id);
      card.root.classList.toggle('is-equipped', id === equipped);
      card.root.disabled = inRaid;
      setText(card.meta, d ? `${TAC_TEXT.cooldown} ${d.cooldown}s${d.charges > 1 ? ` · ${TAC_TEXT.charges} ${d.charges}` : ''}` : '');
    }
    this.paintTacSlot(def, inRaid);
    if (inRaid) this.closeTacPicker();
  }

  /**
   * The equipped-implant slot card (empty state included). 2026-09-12: being a square thumbnail, the name is a bottom
   * caption and **the description · mode are said by the `title`** — a narrow cell has no room for the words.
   */
  private paintTacSlot(def: ImplantDef | null, inRaid: boolean): void {
    const slot = this.tacSlot;
    slot.classList.toggle('is-filled', !!def);
    slot.disabled = this.tacCards.size === 0;
    slot.style.setProperty('--ic', def?.color ?? 'rgba(255,255,255,0.35)');
    slot.title = inRaid ? TAC_TEXT.raidLocked
      : def ? `${def.name} · ${TAC_TEXT.mode[def.mode]}\n${def.description}`
      : TAC_TEXT.pick;
    setText(slot.querySelector<HTMLElement>('.ico')!, def?.icon ?? '＋');
    setText(slot.querySelector<HTMLElement>('.nm')!, def?.name ?? TAC_TEXT.slotEmpty);
    const tag = slot.querySelector<HTMLElement>('.tag')!;
    tag.hidden = !def;
    setText(tag, def ? TAC_TEXT.mode[def.mode] : '');
  }

  private pickTactical(id: ImplantId): void {
    const imp = this.ctx.implants;
    if (!imp) return;
    if (this.inRaid()) {
      this.ctx.bus.emit('audio:play', { id: 'ui_error' });
      this.ctx.bus.emit('ui:notify', { text: TAC_TEXT.raidLocked, kind: 'warning', duration: 1.8 });
      return;
    }
    const next = imp.equipped === id ? null : id;
    if (!imp.setEquipped(next)) { this.ctx.bus.emit('audio:play', { id: 'ui_error' }); return; }
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    const def = imp.getDef(id);
    this.ctx.bus.emit('ui:notify', {
      text: next ? `${def?.name ?? id} ${TAC_TEXT.equipped}` : TAC_TEXT.unequipped,
      kind: 'success', duration: 1.6,
    });
    this.refreshTactical();
  }

  private openTacPicker(): void {
    if (this.tacPickerOpen || this.tacCards.size === 0) return;
    this.closeItemPicker();                  // one popup at a time
    this.tacPickerOpen = true;
    this.tacPop.hidden = false;
    this.tacSlot.classList.add('is-open');
    this.refreshTactical();
    this.place(this.tacPop, this.tacSlot, false);
    requestAnimationFrame(() => { if (this.tacPickerOpen) this.place(this.tacPop, this.tacSlot, false); });
    document.addEventListener('pointerdown', this.onTacOutside, true);
    window.addEventListener('keydown', this.onTacKey, true);
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  private closeTacPicker(): boolean {
    if (!this.tacPickerOpen) return false;
    this.tacPickerOpen = false;
    this.tacPop.hidden = true;
    this.tacSlot.classList.remove('is-open');
    document.removeEventListener('pointerdown', this.onTacOutside, true);
    window.removeEventListener('keydown', this.onTacKey, true);
    return true;
  }

  /* ══ implant items ══════════════════════════════════════════════════════ */

  /** Why a swap is refused right now (null = allowed): raid first, then anything that is not the ship. */
  private swapBlockReason(): string | null {
    if (this.inRaid()) return ITEM_TEXT.raidLocked;
    if (this.ctx.phase !== 'hub') return ITEM_TEXT.shipOnly;
    if (!this.ctx.progression) return ITEM_TEXT.failed;
    return null;
  }

  /** Inline one-line feedback under the list (the block is small, so the reason belongs next to it, not in a toast). */
  private showItemMsg(text: string, error: boolean): void {
    setText(this.itemMsg, text);
    this.itemMsg.hidden = false;
    this.itemMsg.classList.toggle('is-error', error);
    this.ctx.bus.emit('audio:play', { id: error ? 'ui_error' : 'ui_click' });
    window.clearTimeout(this.itemMsgTimer);
    this.itemMsgTimer = window.setTimeout(() => { this.itemMsg.hidden = true; }, 2600);
  }

  /** Header count, pip row, equipped rows and the 장착 button state. */
  private refreshItems(): void {
    const prog = this.ctx.progression;
    const total = Math.max(0, (prog?.implantSlots ?? 0) | 0);
    const used = Math.max(0, (prog?.implantSlotsUsed ?? 0) | 0);
    setText(this.itemCount, ITEM_TEXT.slots(used, total));
    // pips: one per slot, filled = used (rebuilt only when the count changes)
    if (this.itemPips.childElementCount !== total) {
      this.itemPips.replaceChildren();
      for (let i = 0; i < total; i++) el('i', { parent: this.itemPips });
    }
    const pips = this.itemPips.children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < used);

    const blocked = this.swapBlockReason();
    const list = prog?.getEquippedImplants() ?? [];
    /*
     * 2026-09-08 — **a horizontal row of square thumbnails**. This was a column of wide rows carrying the name, the slot cost,
     * the perk and the stat line; three lines of prose per implant in a panel that is one column of the inventory
     * window. The equipped implants are items, so they are drawn the way every other item is — a square cell with
     * `buildItemChip` — and the words live in the hover card (`data-item-tip` → `ui/hud/ItemTip`, which grew
     * 장착칸 · perk · stat rows for exactly this). The `＋` cell that opens the picker closes the row.
     */
    for (const el0 of [...this.itemList.children]) if (el0 !== this.itemAdd) el0.remove();
    for (const e of list) {
      const def = this.itemDef(e.defId);
      const row = el('button', {
        cls: 'inv-impi-cell', attrs: { type: 'button', 'data-uid': e.uid, 'data-def-id': e.defId, 'data-item-tip': '' },
      });
      this.itemList.insertBefore(row, this.itemAdd);
      row.style.setProperty('--rc', RARITY_COLORS[def?.rarity ?? 'common']);
      row.appendChild(buildItemChip(def, { size: 38 }));
      el('span', { cls: 'cost', text: `${def?.implant?.slots ?? 0}`, parent: row });
      row.classList.toggle('is-locked', !!blocked);
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const why = this.swapBlockReason();
        if (why) { this.showItemMsg(why, true); return; }
        if (this.ctx.progression?.unequipImplant(e.uid)) {
          this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
          this.showItemMsg(`${def?.name ?? e.defId} ${ITEM_TEXT.unequipped}`, false);
        } else {
          this.showItemMsg(ITEM_TEXT.noRoom, true);
        }
        this.refreshItems();
        if (this.itemPickerOpen) this.refreshItemOptions();
      });
    }
    this.itemAdd.classList.toggle('is-locked', !!blocked);
    this.itemAdd.classList.toggle('is-open', this.itemPickerOpen);
    this.itemAdd.title = blocked ?? ITEM_TEXT.pick;
    if (blocked) this.closeItemPicker();
  }

  /** Every implant item in the bag + 함선 창고 (working first, then rarity high → low, then name). */
  private candidates(): ItemInstance[] {
    const out: ItemInstance[] = [];
    const seen = new Set<string>();
    const take = (items: ItemInstance[] | undefined): void => {
      for (const it of items ?? []) {
        if (seen.has(it.uid)) continue;
        if (!this.itemDef(it.defId)?.implant) continue;
        seen.add(it.uid);
        out.push(it);
      }
    };
    try { take(this.sys.getAllItems()); } catch { /* bag not ready */ }
    try { take(this.sys.getStashItems()); } catch { /* stash not ready */ }
    const rank = (d: ItemDef | undefined): number => RARITY_ORDER.indexOf(d?.rarity ?? 'common');
    out.sort((a, b) => {
      const da = this.itemDef(a.defId), db = this.itemDef(b.defId);
      const ba = da?.implant?.broken ? 1 : 0, bb = db?.implant?.broken ? 1 : 0;
      if (ba !== bb) return ba - bb;
      const r = rank(db) - rank(da);
      if (r !== 0) return r;
      return (da?.name ?? '').localeCompare(db?.name ?? '', 'ko');
    });
    return out;
  }

  private refreshItemOptions(): void {
    const prog = this.ctx.progression;
    const free = Math.max(0, (prog?.implantSlots ?? 0) - (prog?.implantSlotsUsed ?? 0));
    const items = this.candidates();
    this.itemOpts.replaceChildren();
    if (items.length === 0) {
      el('div', { cls: 'inv-impi-empty', text: ITEM_TEXT.nothingToPick, parent: this.itemOpts });
      return;
    }
    for (const it of items) {
      const def = this.itemDef(it.defId);
      const imp = def?.implant;
      const broken = !!imp?.broken;
      const slots = imp?.slots ?? 0;
      const fits = !broken && slots <= free;
      const opt = el('button', { cls: 'inv-impi-opt', parent: this.itemOpts, attrs: { type: 'button', 'data-uid': it.uid, 'data-def-id': it.defId } });
      opt.style.setProperty('--rc', RARITY_COLORS[def?.rarity ?? 'common']);
      opt.appendChild(buildItemChip(def, { size: 30 }));
      const info = el('span', { cls: 'info', parent: opt });
      const line = el('span', { cls: 'line', parent: info });
      el('span', { cls: 'nm', text: def?.name ?? it.defId, parent: line });
      el('span', { cls: 'tag', text: ITEM_TEXT.slotCost(slots), parent: line });
      el('span', { cls: 'tag rar', text: RARITY_LABEL_KO[def?.rarity ?? 'common'], parent: line });
      const perk = imp?.perk ? PERK_DEFS[imp.perk] : null;
      const statLine = implantStatLine(def, (id) => this.statName(id));
      el('span', { cls: 'meta', text: perk ? `${perk.name} — ${perk.description}${statLine ? ` · ${statLine}` : ''}` : statLine, parent: info });
      const why = broken ? ITEM_TEXT.broken : !fits ? ITEM_TEXT.noFit : '';
      if (why) el('span', { cls: 'why', text: why, parent: info });
      opt.classList.toggle('is-dim', !fits);
      opt.classList.toggle('is-broken', broken);
      opt.disabled = !fits;
      opt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const blocked = this.swapBlockReason();
        if (blocked) { this.showItemMsg(blocked, true); this.closeItemPicker(); return; }
        if (this.ctx.progression?.equipImplant(it.uid)) {
          this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
          this.showItemMsg(`${def?.name ?? it.defId} ${ITEM_TEXT.equipped}`, false);
        } else {
          this.showItemMsg(ITEM_TEXT.failed, true);
        }
        this.refreshItems();
        this.refreshItemOptions();
        this.place(this.itemPop, this.itemAdd, true);
      });
    }
  }

  private openItemPicker(): void {
    if (this.itemPickerOpen) return;
    this.closeTacPicker();                   // one popup at a time
    this.itemPickerOpen = true;
    this.itemPop.hidden = false;
    this.itemAdd.classList.add('is-open');
    this.refreshItemOptions();
    this.place(this.itemPop, this.itemAdd, true);
    requestAnimationFrame(() => { if (this.itemPickerOpen) this.place(this.itemPop, this.itemAdd, true); });
    document.addEventListener('pointerdown', this.onItemOutside, true);
    window.addEventListener('keydown', this.onItemKey, true);
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  private closeItemPicker(): boolean {
    if (!this.itemPickerOpen) return false;
    this.itemPickerOpen = false;
    this.itemPop.hidden = true;
    this.itemAdd.classList.remove('is-open');
    document.removeEventListener('pointerdown', this.onItemOutside, true);
    window.removeEventListener('keydown', this.onItemKey, true);
    return true;
  }
}
