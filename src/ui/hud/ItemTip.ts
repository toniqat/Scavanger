import type { GameContext, ItemDef, StatId } from '@/shared';
import { CATEGORY_ICON, CATEGORY_LABEL_KO, PERK_DEFS, RARITY_COLORS, RARITY_LABEL_KO, formatCredits, itemCreditValue } from '@/shared';
import { el, setText } from '../dom';

/**
 * 재료 요구 칩 hover card (`.item-tip`, Phase 8 UI pass). Every cost chip anywhere in the game — 시설 업그레이드,
 * 가구 제작, 필드 · 작업대 제작, 수리, 퀘스트 납품, 씨앗 — is rendered by `src/shared/itemChip.ts`, which stamps the
 * item def on the element as `data-def-id`. This component is the single reader of that hook: one delegated
 * `pointerover` on `ctx.uiRoot` shows an inventory-style card for the item under the cursor. Anything that is not a
 * chip can opt in by stamping `data-item-tip` next to its own `data-def-id` (the 기업 거래 screen's inventory grids
 * do that, so a stash tile there gets the same card).
 *
 * It lives directly under `#ui-root` (not in a `.hud.*` layer) so it floats above the inventory window, the 함선 관리
 * screen and every menu alike, and it is `pointer-events: none` — the chip underneath keeps its own click.
 *
 * Only `ItemDef` data is shown (name · 분류 · 등급 · 설명 + the def's own numbers + 보유 from bag + stash): a chip has
 * no `ItemInstance`, so there is no durability / socket / loaded-ammo section like `inventory/ui/Tooltip` has.
 *
 * 2026-09-08: an `implant` def also lists 장착칸 · 퍽 · 능력치 (· 상태 when broken) — the inventory's 임플란트 칸
 * is a row of square thumbnails now, so this card is where an equipped implant's numbers are read.
 *
 * Phase 10: 가치 left the stats table for a **bottom bar** (`.it-value`, label left / amount right-aligned) rendered
 * with the one credit formatter — `formatCredits(itemCreditValue(def))`, i.e. `1,200 C` (the old `cr` suffix is gone).
 */
export class ItemTip {
  readonly root: HTMLElement;
  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private descEl: HTMLElement;
  private statsEl: HTMLElement;
  private valueEl: HTMLElement;
  private valueAmount: HTMLElement;
  private ctx: GameContext | null = null;
  private defId: string | null = null;
  private visible = false;
  private unsubs: Array<() => void> = [];

  private onOver = (e: PointerEvent): void => {
    const chip = this.chipAt(e.target);
    const id = chip?.dataset.defId ?? null;
    if (!id) { this.hide(); return; }
    if (id !== this.defId) this.render(id);
    this.move(e.clientX, e.clientY);
  };
  private onMove = (e: PointerEvent): void => {
    const chip = this.chipAt(e.target);
    if (!chip) { this.hide(); return; }
    // also re-show after something hid the card (a room change, a rebuilt panel) while the cursor never left the chip
    const id = chip.dataset.defId ?? null;
    if (id && (!this.visible || id !== this.defId)) this.render(id);
    if (this.visible) this.move(e.clientX, e.clientY);
  };
  private onOut = (e: PointerEvent): void => {
    if (!this.visible) return;
    const to = e.relatedTarget as Node | null;
    if (to && this.chipAt(to)) return;
    this.hide();
  };

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'item-tip', parent });
    this.root.hidden = true;
    const head = el('div', { cls: 'it-head', parent: this.root });
    this.nameEl = el('div', { cls: 'it-name', parent: head });
    this.subEl = el('div', { cls: 'it-sub', parent: head });
    this.descEl = el('p', { cls: 'it-desc', parent: this.root });
    this.statsEl = el('div', { cls: 'it-stats', parent: this.root });
    // Phase 10: 가치 left the stats table and became the card's bottom bar — label left, amount right-aligned, `100 C`.
    this.valueEl = el('div', { cls: 'it-value', parent: this.root });
    el('span', { cls: 'k', text: '가치', parent: this.valueEl });
    this.valueAmount = el('span', { cls: 'v ui-mono', text: '', parent: this.valueEl });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const host = ctx.uiRoot;
    host.addEventListener('pointerover', this.onOver);
    host.addEventListener('pointermove', this.onMove);
    host.addEventListener('pointerout', this.onOut);
    this.unsubs.push(
      () => host.removeEventListener('pointerover', this.onOver),
      () => host.removeEventListener('pointermove', this.onMove),
      () => host.removeEventListener('pointerout', this.onOut),
      // a chip can vanish under the cursor (panel rebuilt, popup closed) — never leave the card floating
      ctx.bus.on('game:phaseChanged', () => this.hide()),
      ctx.bus.on('inventory:closed', () => this.hide()),
      ctx.bus.on('housing:shipManageChanged', () => this.hide()),
    );
  }

  /** Whether the card is showing (debug / smoke). */
  get isShowing(): boolean { return this.visible; }
  /** Def id the card is describing (debug / smoke). */
  get shownDefId(): string | null { return this.visible ? this.defId : null; }

  private chipAt(target: EventTarget | null): HTMLElement | null {
    const node = target as Element | null;
    if (!node || typeof node.closest !== 'function') return null;
    // `.item-chip` is the shared cost chip; `[data-item-tip]` lets another folder opt a plain element in
    // (inventory/ui/TradeGrids stamps it on the 기업 거래 grids' tiles, which are not chips).
    return node.closest('.item-chip[data-def-id], [data-item-tip][data-def-id]') as HTMLElement | null;
  }

  private defOf(defId: string): ItemDef | undefined {
    const ctx = this.ctx;
    if (!ctx) return undefined;
    try { return ctx.loot?.getItemDef(defId) ?? ctx.inventory?.getDef(defId); } catch { return undefined; }
  }

  /** Units in bag + stash; −1 when inventory cannot answer (mission crate window has no `countDefAll` gap, but be safe). */
  private owned(defId: string): number {
    const inv = this.ctx?.inventory;
    if (!inv || typeof inv.countDefAll !== 'function') return -1;
    try { return inv.countDefAll(defId); } catch { return -1; }
  }

  private render(defId: string): void {
    const def = this.defOf(defId);
    if (!def) { this.hide(); return; }
    this.defId = defId;
    this.root.style.setProperty('--rc', RARITY_COLORS[def.rarity] ?? RARITY_COLORS.common);
    this.root.style.setProperty('--ic', def.color);
    setText(this.nameEl, `${def.icon || CATEGORY_ICON[def.category] || '?'} ${def.name}`);
    setText(this.subEl, `${CATEGORY_LABEL_KO[def.category] ?? def.category} · ${RARITY_LABEL_KO[def.rarity] ?? def.rarity}`);
    setText(this.descEl, def.description);

    const rows: Array<[string, string]> = [];
    const have = this.owned(defId);
    if (have >= 0) rows.push(['보유', `${have} 개`]);
    if (def.seed) rows.push(['재배 시간', `${def.seed.growHours} 시간`]);
    if (def.healAmount) rows.push(['회복', `+${def.healAmount} HP`]);
    if (def.bag) rows.push(['가방', `${def.bag.cols} × ${def.bag.rows} · 퀵 ${def.bag.quickSlots}`]);
    // 2026-09-08: 임플란트 — 인벤토리의 임플란트 칸이 세로 목록에서 정사각 썸네일 줄로 바뀌면서 (이름 · 퍽 ·
    //   능력치가 카드에서 빠졌다) 그 정보가 사는 곳이 이 카드가 됐다.
    const imp = def.implant;
    if (imp) {
      rows.push(['장착칸', `${imp.slots}`]);
      const perk = imp.perk ? PERK_DEFS[imp.perk] : null;
      if (perk) rows.push(['퍽', perk.name]);
      const stats = this.statLine(imp.stats);
      if (stats) rows.push(['능력치', stats]);
      if (imp.broken) rows.push(['상태', '망가짐 — 세레스 바이오에서 수리']);
    }
    if (def.weight !== undefined) rows.push(['무게', `${def.weight.toFixed(1)} kg`]);
    if (def.stackMax > 1) rows.push(['최대 묶음', `${def.stackMax}`]);
    rows.push(['크기', `${def.width} × ${def.height}`]);

    this.statsEl.replaceChildren();
    for (const [k, v] of rows) {
      el('span', { cls: 'k', text: k, parent: this.statsEl });
      el('span', { cls: 'v', text: v, parent: this.statsEl });
    }
    setText(this.valueAmount, formatCredits(itemCreditValue(def)));
    this.root.hidden = false;
    this.visible = true;
  }

  /** `근력 +2 · 재주 +1` for an implant's stat bonuses (empty when it has none). */
  private statLine(stats: Partial<Record<StatId, number>> | undefined): string {
    if (!stats) return '';
    const parts: string[] = [];
    for (const [id, v] of Object.entries(stats) as Array<[StatId, number | undefined]>) {
      if (typeof v !== 'number' || v === 0) continue;
      let name: string = id;
      try { name = this.ctx?.progression?.getStatDef(id)?.name ?? id; } catch { /* skeleton */ }
      parts.push(`${name} ${v > 0 ? '+' : ''}${v}`);
    }
    return parts.join(' · ');
  }

  private move(x: number, y: number): void {
    const pad = 16;
    const w = this.root.offsetWidth, h = this.root.offsetHeight;
    let left = x + pad, top = y + pad;
    if (left + w > window.innerWidth - 8) left = x - w - pad;
    if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - pad);
    this.root.style.transform = `translate(${Math.round(Math.max(8, left))}px, ${Math.round(top)}px)`;
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.defId = null;
    this.root.hidden = true;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }
}
