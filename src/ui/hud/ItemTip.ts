import type { CurrencyDef, GameContext, ItemDef, ItemInstance, StatId } from '@/shared';
import {
  CATEGORY_ICON, CATEGORY_LABEL_KO, PERK_DEFS, RARITY_COLORS, RARITY_LABEL_KO, currencyDef, formatCredits, itemCreditValue,
} from '@/shared';
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
 * 2026-09-11 (C-36 후속): **가방 내구도 한 줄** — 가방이 `durabilityMax` 를 갖게 되면서 `내구도` 줄이 `가방` 줄 아래에
 * 붙는다. 호버한 요소가 `data-uid` 도 달고 있고(`inventory/ui/TradeGrids` 의 타일) 그 인스턴스를 찾을 수 있으면
 * `inventory/ui/Tooltip` 과 같은 `cur / max` (0 이어도 `파손` 이라 적지 않는다 — 가방은 0 이어도 격자가 그대로다),
 * 인스턴스가 없는 칩(제작 · 수리 재료 칩)이면 새 가방의 값 `최대 max` 다.
 *
 * 2026-09-08: an `implant` def also lists 장착칸 · 퍽 · 능력치 (· 상태 when broken) — the inventory's 임플란트 칸
 * is a row of square thumbnails now, so this card is where an equipped implant's numbers are read.
 *
 * Phase 10: 가치 left the stats table for a **bottom bar** (`.it-value`) rendered with the one credit formatter —
 * `formatCredits(itemCreditValue(def))`, i.e. `1,200 C` (the old `cr` suffix is gone).
 *
 * 2026-09-09: the bottom bar is **무게 on the left · 가치 on the right** (`.it-value .wt` / `.val`, each `k` label +
 * `v` amount) and the `크기 (w × h)` row is gone from every card — the footprint is what the bag grid already shows.
 * The stats table hides itself when no row is left.
 *
 * **재화 (2026-09-09)**: 계약 · 퀘스트 보상의 크레딧 · 경험치 · 기업별 신뢰도는 아이템이 아니지만 같은 자리에
 * 같은 크기의 칩(`shared/currency.buildCurrencyChip`)으로 선다. 그 칩은 `data-def-id` 대신
 * **`data-currency-id`** 를 달고, 이 카드는 그것도 받아 `.is-currency` 로 그린다 — 헤더에 `재화` 배지가 붙고
 * 아이템의 분류 · 등급 · 무게 · 가치 줄은 나오지 않는다. 아이템과 구분되는 틀이 필요하다는 요구가 여기서 끝난다.
 */
export class ItemTip {
  readonly root: HTMLElement;
  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private descEl: HTMLElement;
  private statsEl: HTMLElement;
  private valueEl: HTMLElement;
  private valueAmount: HTMLElement;
  private weightAmount: HTMLElement;
  private ctx: GameContext | null = null;
  private defId: string | null = null;
  /** `data-uid` of the hovered element (instance-backed rows such as 가방 내구도), null for a plain def chip. */
  private uid: string | null = null;
  /** 지금 카드가 재화를 그리고 있다면 그 재화 id (아이템일 때 null). */
  private currencyId: string | null = null;
  private visible = false;
  private unsubs: Array<() => void> = [];

  private onOver = (e: PointerEvent): void => {
    const chip = this.chipAt(e.target);
    if (!chip || !this.show(chip)) { this.hide(); return; }
    this.move(e.clientX, e.clientY);
  };
  private onMove = (e: PointerEvent): void => {
    const chip = this.chipAt(e.target);
    if (!chip) { this.hide(); return; }
    // also re-show after something hid the card (a room change, a rebuilt panel) while the cursor never left the chip
    this.show(chip);
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
    // Phase 10: 가치 left the stats table and became the card's bottom bar. 2026-09-09: 무게 joined it — weight on the
    // LEFT (`무게 1.2 kg`), 가치 on the RIGHT (amount right-aligned, `100 C`); the 크기 row is gone from the stats.
    this.valueEl = el('div', { cls: 'it-value', parent: this.root });
    const wt = el('span', { cls: 'wt', parent: this.valueEl });
    el('span', { cls: 'k', text: '무게', parent: wt });
    this.weightAmount = el('span', { cls: 'v ui-mono', text: '', parent: wt });
    const val = el('span', { cls: 'val', parent: this.valueEl });
    el('span', { cls: 'k', text: '가치', parent: val });
    this.valueAmount = el('span', { cls: 'v ui-mono', text: '', parent: val });
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
  /** Def id the card is describing (debug / smoke). Null while it is showing a 재화. */
  get shownDefId(): string | null { return this.visible ? this.defId : null; }
  /** 재화 id the card is describing (debug / smoke). Null while it is showing an item. */
  get shownCurrencyId(): string | null { return this.visible ? this.currencyId : null; }

  /**
   * Draw whichever of the two the hovered chip is. Returns false when the chip carries neither hook, so the
   * caller hides the card instead of leaving a stale one up.
   */
  private show(chip: HTMLElement): boolean {
    const cy = chip.dataset.currencyId ?? null;
    if (cy) {
      if (!this.visible || cy !== this.currencyId) this.renderCurrency(cy);
      return this.visible;
    }
    const id = chip.dataset.defId ?? null;
    if (!id) return false;
    const uid = chip.dataset.uid ?? null;
    if (!this.visible || id !== this.defId || uid !== this.uid) this.render(id, uid);
    return this.visible;
  }

  private chipAt(target: EventTarget | null): HTMLElement | null {
    const node = target as Element | null;
    if (!node || typeof node.closest !== 'function') return null;
    // `.item-chip` is the shared cost chip; `[data-item-tip]` lets another folder opt a plain element in
    // (inventory/ui/TradeGrids stamps it on the 기업 거래 grids' tiles, which are not chips).
    // `[data-currency-id]` is the 재화 칩 (2026-09-09) — same card, a different body.
    return node.closest(
      '.item-chip[data-def-id], [data-item-tip][data-def-id], [data-currency-id]',
    ) as HTMLElement | null;
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

  /** The live instance behind a `data-uid` (bag or stash), only when it really is this def. */
  private instanceOf(uid: string | null, defId: string): ItemInstance | null {
    const inv = this.ctx?.inventory;
    if (!uid || !inv || typeof inv.findItemAnywhere !== 'function') return null;
    try { const it = inv.findItemAnywhere(uid); return it && it.defId === defId ? it : null; } catch { return null; }
  }

  private render(defId: string, uid: string | null = null): void {
    const def = this.defOf(defId);
    if (!def) { this.hide(); return; }
    this.defId = defId;
    this.uid = uid;
    this.currencyId = null;
    this.root.classList.remove('is-currency');
    this.valueEl.hidden = false;
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
    // 2026-09-11 (C-36 후속): 가방 내구도 — 인스턴스가 있으면 `cur / max`, 칩뿐이면 새 가방의 `최대 max`.
    if (def.bag && def.durabilityMax !== undefined && def.durabilityMax > 0) {
      const max = def.durabilityMax;
      const inst = this.instanceOf(uid, defId);
      rows.push(['내구도', inst ? `${Math.round(Math.max(0, Math.min(max, inst.durability ?? max)))} / ${max}` : `최대 ${max}`]);
    }
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
    if (def.stackMax > 1) rows.push(['최대 묶음', `${def.stackMax}`]);
    // 2026-09-09: no 크기 row (the grid footprint is visible in the bag itself); 무게 moved to the bottom bar.

    this.statsEl.replaceChildren();
    for (const [k, v] of rows) {
      el('span', { cls: 'k', text: k, parent: this.statsEl });
      el('span', { cls: 'v', text: v, parent: this.statsEl });
    }
    this.statsEl.hidden = rows.length === 0;
    setText(this.weightAmount, def.weight !== undefined ? `${def.weight.toFixed(1)} kg` : '—');
    setText(this.valueAmount, formatCredits(itemCreditValue(def)));
    this.root.hidden = false;
    this.visible = true;
  }

  /**
   * 재화 카드. 아이템 카드와 같은 상자 · 같은 자리에 뜨지만 분류/등급 줄이 `재화` 배지로 바뀌고 가치 바가
   * 사라진다 — 재화에는 등급도 판매가도 없다. 신뢰도는 기업 색을 그대로 쓰므로 카드도 기업 색으로 물든다.
   */
  private renderCurrency(id: string): void {
    const def: CurrencyDef | undefined = currencyDef(id);
    if (!def) { this.hide(); return; }
    this.currencyId = id;
    this.defId = null;
    this.uid = null;
    this.root.classList.add('is-currency');
    this.root.style.setProperty('--rc', def.color);
    this.root.style.setProperty('--ic', def.color);
    setText(this.nameEl, `${def.icon} ${def.name}`);
    setText(this.subEl, '재화');
    setText(this.descEl, def.description);
    this.statsEl.replaceChildren();
    this.statsEl.hidden = true;
    this.valueEl.hidden = true;
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
    this.uid = null;
    this.currencyId = null;
    this.root.hidden = true;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }
}
