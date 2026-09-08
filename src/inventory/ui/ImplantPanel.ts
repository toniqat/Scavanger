import type { GameContext, ImplantDef, ImplantId, ImplantMode, ItemDef, ItemInstance, StatId } from '@/shared';
import { Keys, PERK_DEFS, RARITY_COLORS, RARITY_LABEL_KO, buildItemChip, keyLabel } from '@/shared';
import type { InventorySystem } from '../InventorySystem';

/* ────────────────────────────────────────────────────────────────────────────
 * src/inventory/ui/ImplantPanel.ts — **임플란트 칸** (전술 임플란트 + 임플란트 아이템).
 *
 * 2026-09-08: 두 블록 모두 캐릭터 시트(`progression/ui/SheetBody`)에서 이리로 옮겨왔다. 임플란트는 레이드에 들고
 * 나가는 **장비**지 캐릭터 스탯 화면이 아니고, 로드아웃 프리셋(`LoadoutPreset.implant` · `implantItems`)에 함께
 * 들어가야 하므로 장착 장비 칸(`.inv-equip`) 바로 아래가 제자리다. 캐릭터 탭에는 아무것도 남지 않는다.
 *
 *   • **전술 임플란트** — Q 로 쓰는 6종 중 하나. 슬롯 카드 하나를 누르면 모달리스 피커(`.inv-imp-pop`)가 뜨고
 *     카드를 고르면 `ctx.implants.setEquipped` 로 장착된다. 레이드 중에는 잠긴다.
 *   • **임플란트 아이템** — `ItemDef.implant` 를 가진 아이템. `임플란트 n / m칸` + 핍 줄, 장착한 것 한 줄씩
 *     (클릭 = 해제), `+ 장착` 이 두 번째 피커(`.inv-impi-pop`)를 띄운다. 가방 + 함선 창고를 훑어 후보를 만든다.
 *
 * 두 피커는 **`ctx.uiRoot` 의 직속 자식**이다 — `.inv-root` 의 열림 애니메이션이 `scale:` 을 남기고, 그러면
 * `position: fixed` 팝업의 컨테이닝 블록이 되어 버린다 (캐릭터 시트에서 쓰던 이유와 같다).
 *
 * 폴더 간 규약대로 다른 기능 폴더 내부를 import 하지 않는다: 능력치 임플란트는 `ctx.progression`(ProgressionRef),
 * 전술 임플란트는 `ctx.implants`(ImplantsRef) 로만 오간다. 이 패널은 상태를 하나도 들고 있지 않다.
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

/** 전술 임플란트 (Q). */
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

/** 임플란트 아이템 (능력치 · 퍽). */
const ITEM_TEXT = {
  label: '임플란트',
  slots: (used: number, total: number) => `${used} / ${total}칸`,
  slotCost: (n: number) => `장착칸 ${n}`,
  add: '+ 장착',
  pick: '임플란트 장착',
  none: '장착한 임플란트가 없습니다.',
  nothingToPick: '가방과 함선 창고에 임플란트가 없습니다 — 레이드에서 망가진 임플란트를 찾아 세레스 바이오에서 수리하세요.',
  raidLocked: '레이드 중에는 교체할 수 없습니다',
  shipOnly: '함선에서만 교체할 수 있습니다',
  noRoom: '보관할 공간이 없습니다 — 가방이나 함선 창고를 비우세요',
  broken: '망가짐 — 세레스 바이오에서 수리',
  noFit: '장착칸 부족',
  equipped: '장착',
  unequipped: '해제',
  failed: '장착할 수 없습니다',
  clickToRemove: '클릭해 해제',
};

const RARITY_ORDER: readonly string[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

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

  /* 전술 임플란트 */
  private readonly tacSlot: HTMLButtonElement;
  private readonly tacHint: HTMLElement;
  private readonly tacPop: HTMLElement;
  private readonly tacGrid: HTMLElement;
  private readonly tacCards = new Map<ImplantId, { root: HTMLButtonElement; meta: HTMLElement }>();
  private tacPickerOpen = false;

  /* 임플란트 아이템 */
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

    /* ── 전술 임플란트 ── */
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

    /* ── 임플란트 아이템 ── */
    const block = el('div', { cls: 'inv-impitems', parent: root });
    const head = el('div', { cls: 'h', parent: block });
    el('div', { cls: 'inv-eyebrow', text: ITEM_TEXT.label, parent: head });
    this.itemCount = el('div', { cls: 'cnt ui-mono', text: '', parent: head });
    this.itemPips = el('div', { cls: 'inv-impi-pips', parent: block });
    this.itemList = el('div', { cls: 'inv-impi-list', parent: block });
    this.itemMsg = el('div', { cls: 'inv-impi-msg', text: '', parent: block });
    this.itemMsg.hidden = true;
    this.itemAdd = el('button', { cls: 'inv-btn inv-impi-add', text: ITEM_TEXT.add, parent: block, attrs: { type: 'button' } });
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

  /* ══ 공통 ═══════════════════════════════════════════════════════════════ */

  /** true while either picker is up — the window's Escape chain consumes it before closing itself. */
  get isPickerOpen(): boolean { return this.tacPickerOpen || this.itemPickerOpen; }

  /** Closes both pickers; true when one was actually open. */
  closePickers(): boolean {
    const a = this.closeItemPicker();
    const b = this.closeTacPicker();
    return a || b;
  }

  refresh(): void {
    if (this.disposed) return;
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

  /* ══ 전술 임플란트 ══════════════════════════════════════════════════════ */

  private buildTacSlot(parent: HTMLElement): HTMLButtonElement {
    const slot = el('button', { cls: 'inv-imp-slot', parent, attrs: { type: 'button' } });
    el('span', { cls: 'ico', parent: slot }).setAttribute('aria-hidden', 'true');
    const body = el('span', { cls: 'body', parent: slot });
    const line = el('span', { cls: 'line', parent: body });
    el('span', { cls: 'nm', parent: line });
    el('span', { cls: 'tag', parent: line });
    el('span', { cls: 'desc', parent: body });
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

  /** The equipped-implant slot card (empty state included). */
  private paintTacSlot(def: ImplantDef | null, inRaid: boolean): void {
    const slot = this.tacSlot;
    slot.classList.toggle('is-filled', !!def);
    slot.disabled = this.tacCards.size === 0;
    slot.style.setProperty('--ic', def?.color ?? 'rgba(255,255,255,0.35)');
    slot.title = inRaid ? TAC_TEXT.raidLocked : TAC_TEXT.pick;
    setText(slot.querySelector<HTMLElement>('.ico')!, def?.icon ?? '＋');
    setText(slot.querySelector<HTMLElement>('.nm')!, def?.name ?? TAC_TEXT.slotEmpty);
    const tag = slot.querySelector<HTMLElement>('.tag')!;
    tag.hidden = !def;
    setText(tag, def ? TAC_TEXT.mode[def.mode] : '');
    setText(slot.querySelector<HTMLElement>('.desc')!, def?.description ?? TAC_TEXT.empty);
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

  /* ══ 임플란트 아이템 ════════════════════════════════════════════════════ */

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
    this.itemList.replaceChildren();
    if (list.length === 0) el('div', { cls: 'inv-impi-empty', text: ITEM_TEXT.none, parent: this.itemList });
    for (const e of list) {
      const def = this.itemDef(e.defId);
      const row = el('button', { cls: 'inv-impi-row', parent: this.itemList, attrs: { type: 'button', 'data-uid': e.uid, 'data-def-id': e.defId } });
      row.style.setProperty('--rc', RARITY_COLORS[def?.rarity ?? 'common']);
      row.appendChild(buildItemChip(def, { size: 30 }));
      const info = el('span', { cls: 'info', parent: row });
      const line = el('span', { cls: 'line', parent: info });
      el('span', { cls: 'nm', text: def?.name ?? e.defId, parent: line });
      el('span', { cls: 'tag', text: ITEM_TEXT.slotCost(def?.implant?.slots ?? 0), parent: line });
      const perk = def?.implant?.perk ? PERK_DEFS[def.implant.perk] : null;
      const statLine = implantStatLine(def, (id) => this.statName(id));
      el('span', { cls: 'meta', text: perk ? `${perk.name}${statLine ? ` · ${statLine}` : ''}` : statLine, parent: info });
      el('span', { cls: 'act', text: blocked ?? ITEM_TEXT.clickToRemove, parent: info });
      row.classList.toggle('is-locked', !!blocked);
      row.title = blocked ?? `${def?.name ?? e.defId} — ${ITEM_TEXT.clickToRemove}`;
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
