import type { CurrencyDef, GameContext, GrowSocketDef, ItemDef, ItemInstance, ShelfMedium, SkillId, StatId, UniqueWeaponKind } from '@/shared';
import {
  UNIQUE_WEAPON_LABEL_KO,
  CATEGORY_COLOR, CATEGORY_ICON, CATEGORY_LABEL_KO, ENV_COLOR, ENV_LABEL_KO, GROW_SOCKET_EFFECT_LABEL_KO,
  GROW_SOCKET_TARGET_LABEL_KO, MEAL_BUFF_LABEL_KO, PERK_DEFS,
  RARITY_COLORS, RARITY_LABEL_KO, SAMPLE_FAMILY_COLOR, SAMPLE_FAMILY_ICON, SAMPLE_FAMILY_LABEL_KO,
  SHELF_INTERACTION, SHELF_MEDIUM_LABEL_KO, SOIL_TAG_COLOR, SOIL_TAG_LABEL_KO,
  currencyDef, formatCredits, growSocketSlotsFor, itemCreditValue, shelfItemOf,
} from '@/shared';
/* appended (2026-09-16, the collectible super category): the 종류 row can be two levels, like 「수집품 > 서적」 */
import { categoryPathKo } from '@/shared';
import { el, setText } from '../dom';
import { cookStepsText, mealBuffAmountText, mealEffects, mealQualityText, mealTierLabel } from './mealText';
/* 2026-09-13 (cooking minigame): the quality row */
import { getMealDef, normalizeMealQuality } from '@/shared';
import { COMPUTE_CLUSTER_MAX_CORES, PROCESSOR_DEF_ID } from '@/shared';   // 2026-09-13 crypto mining (2026-09-16: compute cores dropped)

/* 2026-09-15 (gadget rework): the description's inline markup · the spec rows are made by `@/items` alone — the **same function** as the grid card (`inventory/ui/Tooltip`). */
import type { SpecSeg, SpecValue } from '@/items';
import { AMMO_LABEL_KO, itemSpecRows, parseItemText } from '@/items';
/*
 * 2026-09-16 (user bug 「the gun card on the corp screen differs from the bag card」): a weapon card's numbers and
 * sentences are made by `shared/weaponTip` alone — the grid card (`inventory/ui/Tooltip`) paints them as gauge bars,
 * this card as table rows.
 */
import { weaponTipRows } from '@/shared';

/**
 * `[label, value, value text colour?]` — the third slot is an inline colour and makes no class (the comment below).
 * 2026-09-15: the value is a whole string or a **segment list** (`SpecSeg[]`) — 「5초간 매 초 HP 4 회복, 총 20 회복」 and
 * its like gave rows where only the numbers take the body colour and the rest is dim. A segment's colour is inline too,
 * not a modifier class.
 */
type TipRow = [string, SpecValue, string?];

/** Colour of a dim segment · an emphasised segment (the card palette). The grid card paints the same meaning with its own `--inv-*`. */
const SEG_DIM_COLOR = 'var(--c-text-dim)';
const SEG_EM_COLOR = 'var(--c-accent)';
/** The gain · loss colours of a spec row. */
const TONE_COLOR = { good: 'var(--c-success)', bad: 'var(--c-danger)' } as const;

/** 2026-09-13 (meal quality): the star colour of the quality row — the same gold as the buff thumbnail's star badge (`styles/buffs.css` `.bfs-cell[data-q]`). */
const MEAL_QUALITY_STAR_COLOR = '#ffd24a';

/* 2026-09-13 (library series · video games): series names · effect rows · the planets it appears on · equipment · corporations · cook step names */
import type { LibraryEffect } from '@/shared';
import { COOK_GAME_LABEL_KO, CORP_DEFS, FURNITURE_DEFS, GYM_MINIGAME_LABEL_KO, LIBRARY_SERIES_MAP, PLANET_DEFS, gameMinigameLabel } from '@/shared';

/** 2026-09-13: the text colour of `보관 — 아직 꽂지 않음` = the tile band's blue (`--c-favorite`, the same blue when it is missing). */
const FAVORITE_BAND_COLOR = 'var(--c-favorite, #4a90ff)';
/** Furniture def id → def (deciding whether the shelf is owned). */
const FURNITURE_DEF_BY_ID = new Map(FURNITURE_DEFS.map((d) => [d.id, d] as const));
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
/** Volume number 1 … 10 → a Roman numeral (Arabic numbers outside the range). */
function romanVolume(n: number): string {
  const v = Math.floor(n);
  return ROMAN[v] ?? String(v);
}
/** A multiplier addend → `+12.5 %` (to one decimal place). */
function pctText(v: number): string {
  const n = Math.round((Number.isFinite(v) ? v : 0) * 1000) / 10;
  const mag = Math.abs(n);
  return `${n < 0 ? '−' : '+'}${Number.isInteger(mag) ? String(mag) : mag.toFixed(1)} %`;
}

/** Whether it is a finite positive number (filters out durability · time cells that came empty from an old csv). */
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * 2026-09-14 (user's decision): the opt-in attribute with which the chip side decides where the card stands
 * (`data-tip-anchor="left"` = the **top-left** of the cursor). It can be stamped on the chip itself or once on the row
 * that holds the chips (`.fcard-cost` · `.inv-craft-costs` …) — `move()` reads it with `closest`. Other folders do not
 * import this constant and only write `dataset.tipAnchor = 'left'` (no cross-folder imports).
 */
export const TIP_ANCHOR_ATTR = 'data-tip-anchor';

/**
 * 2026-09-16 (user's decision): **the opt-in attribute that swaps the bottom bar's 「가치」 for that screen's own value.**
 * A shelf tile of the 기업 거래 screen must show 「구매가」 and a sell-slot tile 「판매가」 — the value is the same number
 * wherever the item is, so it is not what is read on a trade screen. Stamping `data-tip-price` (an integer of credits) +
 * `data-tip-price-label` (a Korean label) on the chip (or on the box that holds it) turns the name and the amount at the
 * right of the bottom bar into those two. It is the same contract as `data-tip-anchor`, so it is read with `closest`
 * like `move()` does, and other folders do not import this constant and only write `dataset.tipPrice`.
 * A chip without the attribute (bag · stash · world · craft materials) keeps 「가치」 as before.
 */
export const TIP_PRICE_ATTR = 'data-tip-price';

/**
 * 2026-09-17 (user bug 「hovering the trust thumbnail of a quest reward shows no tooltip」): the **text card** opt-in. A chip
 * that is neither an item nor a currency — the NPC personal trust chip of a quest card
 * (`menus/messenger/Trust.buildTrustChip`) is that one. That chip has the same hexagonal frame and the same `◈` as the
 * corporation trust chip, but NPC trust is not a currency in `data/currencies.csv` (no fake currency def is made), so it
 * cannot carry `data-currency-id` and was leaning on the native `title` alone — the game's card never appeared. Now a
 * chip that stamps `data-tip-name` (+ `data-tip-sub` · `data-tip-desc` · `data-tip-color`) has that text drawn in the
 * same shape as a currency card (no value bar). Other folders only write `dataset.tipName`.
 */
export const TIP_NAME_ATTR = 'data-tip-name';
/** The default name for a `data-tip-price` given no label. */
const TIP_PRICE_LABEL_DEFAULT = '가격';
/** The default name at the right of the bottom bar (an item's `가치`). */
const TIP_VALUE_LABEL = '가치';

/**
 * Material cost chip hover card (`.item-tip`, Phase 8 UI pass). Every cost chip anywhere in the game — 시설 업그레이드,
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
 * 2026-09-11 (C-36 follow-up): **one bag durability row** — now that a bag has `durabilityMax`, the `내구도` row sits
 * under the `가방` row. When the hovered element also carries `data-uid` (a tile of `inventory/ui/TradeGrids`) and its
 * instance can be found it is the same `cur / max` as `inventory/ui/Tooltip` (never written as `파손` even at 0 — a bag's
 * grid is unchanged at 0); on a chip with no instance (craft · repair material chips) it is a new bag's `최대 max`.
 *
 * 2026-09-08: an `implant` def also lists 장착칸 · 퍽 · 능력치 (· 상태 when broken) — the inventory's 임플란트 칸
 * is a row of square thumbnails now, so this card is where an equipped implant's numbers are read.
 *
 * Phase 10: 가치 left the stats table for a **bottom bar** (`.itip-value`) rendered with the one credit formatter —
 * `formatCredits(itemCreditValue(def))`, i.e. `1,200 C` (the old `cr` suffix is gone).
 *
 * 2026-09-09: the bottom bar is **무게 on the left · 가치 on the right** (`.itip-value .wt` / `.val`, each `k` label +
 * `v` amount) and the `크기 (w × h)` row is gone from every card — the footprint is what the bag grid already shows.
 * The stats table hides itself when no row is left.
 *
 * **Greenhouse rework (2026-09-11)**: soil (`def.soil`) gets the two rows `속성` (`SOIL_TAG_LABEL_KO`, only the value
 * text is tinted with `SOIL_TAG_COLOR`) and `수확`, and a seed (`def.seed`) gets one **맞는 토양** row in the same colour
 * under `재배 시간` — which soil it must be planted in for `SOIL_MATCH_SPEEDUP` has to end on the seed's card. The colour
 * is painted only as an inline `style.color`: a new modifier class on `.itip-stats .v` risks colliding by name with a
 * HUD widget class (the 2026-09-10 `.hold` accident).
 *
 * **Kitchen · culture tank · printer (2026-09-11)**: a meal (`def.meal`) gets `사용 — 다음 레이드 1회분` · `<버프> +n`
 * with the buff name as the row name (· `구분 — 특선 요리` at tier 2), a pouch (`def.pouch`) `주머니 c × r` · `수납`
 * (the names of the categories it takes), a strain (`def.strain`) `배양조 n 시간` · `산출물`, a medium (`def.medium`)
 * `배양 n 회` · `배양 속도 +n %` (`speedMul` 0.7 = +30 %). The sign · unit of a meal value are printed by `hud/mealText` —
 * it must be the **same sentence** as the raid HUD's meal badge, and the table that decides whether it is `%` or `kg` is
 * `MEAL_BUFF_UNIT` in `shared/labels`, that one alone.
 *
 * **Lab (2026-09-11)**: a sample (`def.sample`) gets `분석기 해석 n 시간` · `산출물` (· the `최초 해석` bonus when it is
 * the first), and a preparation (`def.prep`) gets `사용 — 다음 레이드 1회분` · `차단 — <환경> 환경`. The environment name ·
 * colour come from `ENV_LABEL_KO` · `ENV_COLOR` alone (the same source as the HUD badge · the planet briefing), and the
 * colour is inline for the same reason as above.
 *
 * **Currencies (2026-09-09)**: the credits · XP · per-corporation trust of a contract · quest reward are not items, but
 * they stand in the same place as a chip of the same size (`shared/currency.buildCurrencyChip`). That chip carries
 * **`data-currency-id`** instead of `data-def-id`, and this card takes that too and draws it as `.is-currency` — a `재화`
 * badge joins the header and an item's 분류 · 등급 · 무게 · 가치 rows do not appear. The demand for a frame that is told
 * apart from an item ends here.
 *
 * **Cooking ingredient tiers (2026-09-13, `docs/DECISIONS.md` 「2026-09-13 — 요리 재료 티어」)**: a meal gets `구분 — <tier name>`
 * (`MEAL_TIER_LABEL_KO`, omitted for a retired meal) · **every stat row** under `사용` (`hud/mealText.mealEffects` — one row for
 * an old def with no `effects`); the old `구분 — 특선 요리` is gone. Soil gets **`내구도 최대 n`** · **`소켓 칸 n 칸`**
 * (`growSocketSlotsFor(rarity)`) instead of `수확 n 회`, a medium the same two rows + `배양 속도` instead of `배양 n 회`, a strain
 * two more rows **`스캐폴드 배양 n 시간`** · **`스캐폴드 산출`** when it has a scaffold output, a culture scaffold (`def.scaffold`)
 * one `사용` line of description, and a socket (`def.growSocket`) gets `종류` (`GROW_SOCKET_TARGET_LABEL_KO` · where it goes) ·
 * `<effect name>` (`GROW_SOCKET_EFFECT_LABEL_KO`: speed = `시간 −n %`, wear = `마모 −n %`, yield = `n % 확률로 +1 개`, the value
 * inline `CATEGORY_COLOR.socket`) · `장착`. A sample is **`계열`** (glyph + name, inline `SAMPLE_FAMILY_COLOR`) · `분석기 해석 n 시간`
 * (the table's base time) · `결과 — <계열> 결과표`, and the old `산출물` · `최초 해석` rows are left only on an old def with no family.
 * A retired item (`def.retired`) gets one **`상태 — 더 이상 쓰이지 않는 아이템`** line (dim text) at the top.
 *
 * **Cooking minigame (2026-09-13, `docs/DECISIONS.md` 「2026-09-13 — 요리 미니게임」)**: when the hovered element carries `data-uid`
 * and that instance's quality is above 0, a meal gets one **`품질 — ★★★☆☆ +15 %`** row (`hud/mealText.mealQualityText`) under
 * `구분`, and its stat rows become **the numbers with the bonus folded in** (`mealEffects(meal, quality)` — the same formula
 * `derive.applyMealBuff` adds when it is eaten). A chip with no instance (material · reward chips) is the quality-0 baseline.
 * A cook-bench meal (one whose `cookStepsOf` is not empty) gets one **`조리 — ① 썰기 → ② 젓기`** row (`cookStepsText`) under
 * the stat rows — no step, no row.
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
  /** The 재화 id when the card is drawing a currency right now (null for an item). */
  private currencyId: string | null = null;
  /** The content key when the card is a text card (`TIP_NAME_ATTR`) right now (null otherwise). */
  private textKey: string | null = null;
  private visible = false;
  private unsubs: Array<() => void> = [];
  /** 2026-09-15: the element the card is describing — watched while visible (see `watch`). */
  private chip: HTMLElement | null = null;
  /** Last pointer position over `ctx.uiRoot` (client px); −1 = unknown. */
  private lastX = -1;
  private lastY = -1;
  private raf = 0;
  /** Frames left in which `watch` re-hit-tests even though the chip is still connected (after an inventory change). */
  private recheckFrames = 0;

  private onOver = (e: PointerEvent): void => {
    this.lastX = e.clientX; this.lastY = e.clientY;
    const chip = this.chipAt(e.target);
    if (!chip || !this.show(chip)) { this.hide(); return; }
    this.move(e.clientX, e.clientY, chip);
  };
  private onMove = (e: PointerEvent): void => {
    this.lastX = e.clientX; this.lastY = e.clientY;
    const chip = this.chipAt(e.target);
    if (!chip) { this.hide(); return; }
    // also re-show after something hid the card (a room change, a rebuilt panel) while the cursor never left the chip
    this.show(chip);
    if (this.visible) this.move(e.clientX, e.clientY, chip);
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
    const head = el('div', { cls: 'itip-head', parent: this.root });
    this.nameEl = el('div', { cls: 'itip-name', parent: head });
    this.subEl = el('div', { cls: 'itip-sub', parent: head });
    this.descEl = el('p', { cls: 'itip-desc', parent: this.root });
    this.statsEl = el('div', { cls: 'itip-stats', parent: this.root });
    // Phase 10: 가치 left the stats table and became the card's bottom bar. 2026-09-09: 무게 joined it — weight on the
    // LEFT (`무게 1.2 kg`), 가치 on the RIGHT (amount right-aligned, `100 C`); the 크기 row is gone from the stats.
    this.valueEl = el('div', { cls: 'itip-value', parent: this.root });
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
      // 2026-09-14: a tooltip was pinned (1 s hold on an item tile) — the card that was following the cursor goes
      ctx.bus.on('ui:tipPinned', ({ uid }) => { if (uid !== null) this.hide(); }),
      // 2026-09-15: items moved (a quick move re-lays the grids) — re-hit-test for a couple of frames (`watch`)
      ctx.bus.on('inventory:changed', this.requestRecheck),
      ctx.bus.on('inventory:stashChanged', this.requestRecheck),
      ctx.bus.on('inventory:bagChanged', this.requestRecheck),
      ctx.bus.on('inventory:itemUpdated', this.requestRecheck),
      ctx.bus.on('loadout:changed', this.requestRecheck),
    );
  }

  /* ── 2026-09-15: a chip that leaves from under a still cursor ──────────────────────────────────────────────────────── */

  /**
   * **This card's half of the user bug 「the tooltip of a quick-moved item stays until the mouse moves」.** The card goes
   * down on `pointerout`, but moving an item with a double click · the right-click menu makes the grid
   * (`inventory/ui/TradeGrids` → `GridView`) **detach the tile under the cursor from the DOM** — a detached element gets
   * no `pointerout`, so the card stayed up describing a chip that was already gone. So while the card is up, every frame
   * it only cheaply looks at whether the chip is still connected (`isConnected` · `.is-vanishing`), and when it has come
   * off or the inventory has just changed (`recheckFrames` — the same element may have moved to another cell) it
   * **points again at the last pointer position** (`rehit`): the chip there when there is one, else the card goes down.
   * Why two frames after an inventory event: the grid redraws on the rAF **after** the event it received
   * (`TradeGrids.scheduleRefresh`), and the order of that callback and this loop is registration order, so one frame can
   * land before the redraw.
   */
  private requestRecheck = (): void => {
    if (this.visible) this.recheckFrames = 2;
  };

  private startWatch(): void {
    if (this.raf || typeof requestAnimationFrame !== 'function') return;
    this.raf = requestAnimationFrame(this.watch);
  }

  private stopWatch(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.recheckFrames = 0;
  }

  private watch = (): void => {
    this.raf = 0;
    if (!this.visible) return;
    const chip = this.chip;
    if (!chip || !chip.isConnected || chip.classList.contains('is-vanishing') || this.recheckFrames > 0) {
      if (this.recheckFrames > 0) this.recheckFrames--;
      this.rehit();
    }
    if (this.visible) this.startWatch();
  };

  /** Point again at the last pointer position: describe the chip there, or hide when there is none. */
  private rehit(): void {
    if (this.lastX < 0 || this.lastY < 0) { this.hide(); return; }
    const chip = this.chipAt(document.elementFromPoint(this.lastX, this.lastY));
    if (!chip || !this.show(chip)) { this.hide(); return; }
    this.move(this.lastX, this.lastY, chip);
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
    // 2026-09-14: a tile whose inventory tooltip is pinned (`inventory/ui/TipPin`, `data-tip-pinned`) — the pinned card is its card
    if (chip.dataset.tipPinned !== undefined) return false;
    const cy = chip.dataset.currencyId ?? null;
    if (cy) {
      if (!this.visible || cy !== this.currencyId) this.renderCurrency(cy);
      return this.watching(chip);
    }
    const tipName = chip.dataset.tipName;
    if (tipName) {
      const key = [tipName, chip.dataset.tipSub ?? '', chip.dataset.tipDesc ?? '', chip.dataset.tipColor ?? ''].join('');
      if (!this.visible || key !== this.textKey) this.renderText(chip, key);
      return this.watching(chip);
    }
    const id = chip.dataset.defId ?? null;
    if (!id) return false;
    const uid = chip.dataset.uid ?? null;
    if (!this.visible || id !== this.defId || uid !== this.uid) this.render(id, uid);
    // 2026-09-16: **the chip may have changed** even when `render` was skipped (the same def is on the shelf and in the
    //   sell slot) — the bottom bar is rewritten from this chip every time. `render` always puts 「가치」 back, so overwriting it only here is enough.
    this.applyPriceTag(chip);
    return this.watching(chip);
  }

  /**
   * Writes the right of the bottom bar with the value this chip asks for (`TIP_PRICE_ATTR` — the item's 「가치」 when there
   * is none). A currency card has the bar itself hidden (`renderCurrency`), so this is touched only for an item.
   */
  private applyPriceTag(chip: HTMLElement): void {
    if (!this.visible || !this.defId) return;
    const host = chip.closest<HTMLElement>(`[${TIP_PRICE_ATTR}]`);
    const price = host ? Number(host.getAttribute(TIP_PRICE_ATTR)) : Number.NaN;
    const label = this.valueEl.querySelector<HTMLElement>('.val > .k');
    if (host && Number.isFinite(price)) {
      if (label) setText(label, host.dataset.tipPriceLabel || TIP_PRICE_LABEL_DEFAULT);
      setText(this.valueAmount, formatCredits(price));
      return;
    }
    if (label) setText(label, TIP_VALUE_LABEL);
    const def = this.defOf(this.defId);
    setText(this.valueAmount, def ? formatCredits(itemCreditValue(def)) : '—');
  }

  /** 2026-09-15: remember the described chip and keep an eye on it while the card is up. Returns `visible`. */
  private watching(chip: HTMLElement): boolean {
    if (!this.visible) return false;
    this.chip = chip;
    this.startWatch();
    return true;
  }

  private chipAt(target: EventTarget | Element | null): HTMLElement | null {
    const node = target as Element | null;
    if (!node || typeof node.closest !== 'function') return null;
    // `.item-chip` is the shared cost chip; `[data-item-tip]` lets another folder opt a plain element in
    // (inventory/ui/TradeGrids stamps it on the 기업 거래 grids' tiles, which are not chips).
    // `[data-currency-id]` is the 재화 칩 (2026-09-09) — same card, a different body.
    return node.closest(
      `.item-chip[data-def-id], [data-item-tip][data-def-id], [data-currency-id], [${TIP_NAME_ATTR}]`,
    ) as HTMLElement | null;
  }

  private defOf(defId: string): ItemDef | undefined {
    const ctx = this.ctx;
    if (!ctx) return undefined;
    // 2026-09-16 (the plate model): a meal chip (dining table · cook bench) is not an item — it is found in the meal table (`shared/meals`)
    try { return ctx.loot?.getItemDef(defId) ?? ctx.inventory?.getDef(defId) ?? getMealDef(defId); } catch { return undefined; }
  }

  /** 2026-09-15: the unique kind behind a weapon item (`bow` …), undefined for graded guns and every other item. */
  private uniqueKindOf(def: ItemDef): UniqueWeaponKind | undefined {
    if (!def.weaponId) return undefined;
    try { return this.ctx?.loot?.getWeaponDef(def.weaponId)?.unique; } catch { return undefined; }
  }

  /** Units in bag + stash; −1 when inventory cannot answer (mission crate window has no `countDefAll` gap, but be safe). */
  private owned(defId: string): number {
    const inv = this.ctx?.inventory;
    if (!inv || typeof inv.countDefAll !== 'function') return -1;
    try { return inv.countDefAll(defId); } catch { return -1; }
  }

  /**
   * The weapon detail rows (`shared/weaponTip.weaponTipRows`) — 대미지 · 연사 · 반동 · 사거리 · 탄종 · 장전 · 발사 모드 ·
   * 배율 · 내구도 · 소켓. When the hovered element points at an instance with `data-uid` these are **that gun's numbers**
   * (effective values with sockets folded in · rounds left · durability left); with no instance, as on a shelf tile,
   * they are the def's grade numbers. An empty array when it is not a weapon.
   */
  private weaponRows(def: ItemDef, uid: string | null): ReturnType<typeof weaponTipRows> {
    const loot = this.ctx?.loot;
    if (!def.weaponId || !loot) return [];
    try {
      const weapon = loot.getWeaponDef(def.weaponId);
      if (!weapon) return [];
      const inst = this.instanceOf(uid, def.id);
      const stats = loot.getEffectiveStats(inst ?? def.id);
      if (!stats) return [];
      return weaponTipRows(weapon, stats, {
        item: inst,
        ammoLabel: AMMO_LABEL_KO[stats.ammoType],
        gauges: true, durability: true, sockets: true,
        attachmentName: (id) => this.defOf(id)?.name,
      });
    } catch { return []; }
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
    this.textKey = null;
    this.root.classList.remove('is-currency');
    this.valueEl.hidden = false;
    this.root.style.setProperty('--rc', RARITY_COLORS[def.rarity] ?? RARITY_COLORS.common);
    this.root.style.setProperty('--ic', def.color);
    setText(this.nameEl, `${def.icon || CATEGORY_ICON[def.category] || '?'} ${def.name}`);
    // 2026-09-15: a legendary unique weapon shows **its own kind** (`컴포짓 보우 · 전설`) instead of `무기` — its name is
    //   only a nickname, so the kind is read here. The csv `class` (AR / DMR / SMG / SR) only picks the shooting skill and never appears on screen.
    // 2026-09-16: a non-unique item is read **down to its super category** — a book is `수집품 > 서적`, a rifle the one level `주무기`.
    //   The separator and the labels belong to `shared/labels.categoryPathKo` alone (the bag grid tooltip calls the same function).
    const uniqueKind = this.uniqueKindOf(def);
    const kindWord = uniqueKind ? UNIQUE_WEAPON_LABEL_KO[uniqueKind] : (categoryPathKo(def.category) ?? def.category);
    setText(this.subEl, `${kindWord} · ${RARITY_LABEL_KO[def.rarity] ?? def.rarity}`);
    this.renderDesc(def.description);

    const rows: TipRow[] = [];
    // 2026-09-13: a retired item gets one row at the top — its def remains but it left every source · consumer
    if (def.retired) rows.push(['상태', '더 이상 쓰이지 않는 아이템', 'var(--c-text-dim)']);
    const have = this.owned(defId);
    if (have >= 0) rows.push(['보유', `${have} 개`]);
    /*
     * 2026-09-16 (user bug): **weapon details.** The 기업 거래 screen (the shelf · the buy slot · the sell slot · the stash
     * and bag grids inside it) all use this card, and it had no damage · range here, so the same gun read differently
     * from the bag grid (`inventory/ui/Tooltip`). The rows and the sentences are made by the **same function** as that
     * card (`shared/weaponTip`) — only the drawing is table rows.
     */
    for (const r of this.weaponRows(def, uid)) rows.push([r.k, r.v]);
    /* 2026-09-15 (gadget rework, user's decision): the specs of healing consumables · shield chargers · combat
       consumables · gadgets · grenades — **`사용 시간` comes first**, and every one of those numbers was taken out of the
       description text (`data/items.csv`). The table is `items/ItemSpec` alone. */
    for (const r of itemSpecRows(def)) rows.push([r.k, r.v, r.tone ? TONE_COLOR[r.tone] : undefined]);
    if (def.seed) rows.push(['재배 시간', `${def.seed.growHours} 시간`]);
    // Greenhouse rework (2026-09-11): a seed writes the soil it wants, soil writes its own tag and the harvests left.
    // `soilTag` is required by the contract but can come empty from an old save · an old csv, so it is drawn only when the table has it.
    const seedTag = def.seed?.soilTag;
    if (seedTag && SOIL_TAG_LABEL_KO[seedTag]) rows.push(['맞는 토양', SOIL_TAG_LABEL_KO[seedTag], SOIL_TAG_COLOR[seedTag]]);
    const soil = def.soil;
    if (soil) {
      if (SOIL_TAG_LABEL_KO[soil.tag]) rows.push(['속성', SOIL_TAG_LABEL_KO[soil.tag], SOIL_TAG_COLOR[soil.tag]]);
      // 2026-09-13: 「수확 n 회」 → max durability + socket slots (soil in the bag is always new, so it is `최대` — worn soil is told by the growing screen)
      if (positive(soil.durability)) rows.push(['내구도', `최대 ${Math.round(soil.durability)}`]);
      rows.push(['소켓 칸', `${growSocketSlotsFor(def.rarity)} 칸`]);
    }
    /* Lab (A-12 · A-13, 2026-09-11): **what comes out of the analyzer and how long it takes** for a sample, and **which
       environment is blocked how many times** for a preparation, have to end on the card. The same place and the same
       inline colour contract as the seed · soil rows (no modifier class on `.itip-stats .v` — the 2026-09-10 `.hold`
       accident). The analysis time falls with catalogue progress, but that is told by the analysis screen: what is
       written here is **the base time in the table**. */
    const sample = def.sample;
    if (sample) {
      /* 2026-09-13 (cooking ingredient tiers): the result is unlocked by analysis level and rolled from the family result
         table (`ANALYSIS_RESULTS`) — the card says the **family**, and what comes out at what chance is told by the
         analysis catalogue. `rewardDefId` is only the fallback for an empty result table, so it is not written. Only a
         def with no family (an old loader that does not know the new column) keeps the old two rows as they were. */
      const fam = (sample as Partial<typeof sample>).family;
      if (fam && SAMPLE_FAMILY_LABEL_KO[fam]) {
        rows.push(['계열', `${SAMPLE_FAMILY_ICON[fam] ?? ''} ${SAMPLE_FAMILY_LABEL_KO[fam]}`.trim(), SAMPLE_FAMILY_COLOR[fam]]);
        rows.push(['분석기 해석', `${sample.analyzeHours} 시간`]);
        rows.push(['결과', `${SAMPLE_FAMILY_LABEL_KO[fam]} 결과표 — 분석 도감`]);
      } else {
        const reward = this.defOf(sample.rewardDefId);
        rows.push(['분석기 해석', `${sample.analyzeHours} 시간`]);
        rows.push(['산출물', `${reward?.name ?? sample.rewardDefId} ×${sample.rewardQty}`]);
        if (sample.firstDefId) {
          const first = this.defOf(sample.firstDefId);
          rows.push(['최초 해석', `${first?.name ?? sample.firstDefId} ×${sample.firstQty ?? 1}`]);
        }
      }
    }
    /* Crypto mining: a processor looks like an ordinary material, but **what it is used for** has to end on the card.
       2026-09-16 (user's decision): compute cores are gone and a processor goes into the cluster **as it is** — it now
       has durability and wears down each cycle, so both are put in one row (the durability left is already shown by the
       tooltip's own durability row). */
    if (def.id === PROCESSOR_DEF_ID) rows.push(['사용', `연산 클러스터에 꽂는다 (최대 ${COMPUTE_CLUSTER_MAX_CORES}개) · 주기마다 닳는다`]);
    const prep = def.prep;
    if (prep && ENV_LABEL_KO[prep.env]) {
      rows.push(['사용', '다음 레이드 1회분']);
      rows.push(['차단', `${ENV_LABEL_KO[prep.env]} 환경`, ENV_COLOR[prep.env]]);
    }
    /* Library media (A-3e, 2026-09-12): a book · disc · record have the same role, so they get the same two rows —
       **which skill it raises** and **which shelf of the library it goes on**. The medium is decided by the contract's
       `shelfItemOf` alone, and the shelf name is found in the furniture table (`furniture.csv`) as the library furniture
       whose interaction is that medium's — the name is never copied here (the card follows when the table changes). */
    /* 2026-09-13 (library series, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」): the old single `숙련` row (per skill ·
       rarity weighted) is gone — the effect is now decided by the **series**' effect rows. A series medium gets `시리즈` ·
       `권` · the effect rows (the all-volumes value) · `진행` · `보관` · `꽂는 곳` · `등장 행성`. */
    const shelf = shelfItemOf(def);
    if (shelf) {
      const media = def.book ?? def.disc ?? def.record;
      if (media?.series) this.seriesRows(rows, def, media.series, media.volume ?? 1, shelf.medium);
      rows.push(['꽂는 곳', `서재 · ${this.shelfName(shelf.medium)}`]);
    }
    /* 2026-09-13 (video games): a game disc = 게임기 · 능력치 · 방식 · 사용, a console = TV 에 장착 */
    const game = def.gameDisc;
    if (game) {
      rows.push(['게임기', this.consoleName(game.console)]);
      rows.push(['능력치', this.statName(game.stat)]);
      // 2026-09-19 (B-32): a **game disc** is named by `gameMinigameLabel` (`호흡형`), never by the gym equipment
      // list above it (`호흡 달리기`) — this row printed the gym name and so was the only screen spelling it differently.
      rows.push(['방식', gameMinigameLabel(game.minigame)]);
      rows.push(['사용', '게임 디스크 전시대에 꽂고 TV 로 플레이']);
    }
    if (def.gameConsole) rows.push(['사용', 'TV 에 장착']);
    /* Kitchen · culture tank · printer (A-3c · A-14 · A-15, 2026-09-11): the four — meal · pouch · strain · medium — end
       on the card in the same grain as a preparation: 「what it raises, by how much / for how long」. A meal's value is
       printed by `hud/mealText` — it must be the **same sentence** as the raid HUD's meal badge, and the table that
       decides the unit (`%` · `kg` · `m`) is `MEAL_BUFF_UNIT` in `shared/labels` alone. `durabilityLossMul` has a
       negative `amount`, so it reads as the gain in 「장비 손상 −20 %」. The colour is **inline** for the same reason as
       the soil · environment rows above (no modifier class on `.itip-stats .v`). */
    const meal = def.meal;
    if (meal) {
      // 2026-09-13: the tier name + every stat row. A retired old 특선 요리 (tier 2) is not 「페이스트 요리」, so its 구분 row is left out.
      const tier = def.retired ? '' : mealTierLabel(meal);
      if (tier) rows.push(['구분', tier]);
      // 2026-09-13 (meal quality): only when there is an instance — a chip (material · reward) has no quality
      const quality = normalizeMealQuality(this.instanceOf(uid, defId)?.quality);
      const qText = mealQualityText(quality);
      if (qText) rows.push(['품질', qText, MEAL_QUALITY_STAR_COLOR]);
      rows.push(['사용', '식탁에서 먹기 — 다음 레이드 1회분']);   // 2026-09-16 the plate model: a meal is the dining table's plate
      for (const e of mealEffects(meal, quality)) {
        rows.push([MEAL_BUFF_LABEL_KO[e.buff] ?? '효과', mealBuffAmountText(e.buff, e.amount), CATEGORY_COLOR.meal]);
      }
      // 2026-09-13 (cooking minigame): the order of the minigames done at the cook bench
      const steps = cookStepsText(defId);
      if (steps) rows.push(['조리', steps]);
    }
    const pouch = def.pouch;
    if (pouch) {
      rows.push(['주머니', `${pouch.cols} × ${pouch.rows}`]);
      const kinds = pouch.accepts.map((c) => CATEGORY_LABEL_KO[c] ?? c).join(' · ');
      if (kinds) rows.push(['수납', kinds]);
    }
    const strain = def.strain;
    if (strain) {
      const out = this.defOf(strain.outputDefId);
      rows.push(['배양조', `${strain.cultureHours} 시간`]);
      rows.push(['산출물', `${out?.name ?? strain.outputDefId} ×${strain.outputQty}`]);
      // 2026-09-13 (T3): a cell with a scaffold in it makes species meat — two more rows only on a strain that has that output
      if (strain.scaffoldOutputDefId) {
        const sc = this.defOf(strain.scaffoldOutputDefId);
        if (positive(strain.scaffoldHours)) rows.push(['스캐폴드 배양', `${strain.scaffoldHours} 시간`]);
        rows.push(['스캐폴드 산출', `${sc?.name ?? strain.scaffoldOutputDefId} ×${strain.scaffoldOutputQty ?? 1}`]);
      }
    }
    if (def.scaffold) rows.push(['사용', '배양조 — 배지 다음 · 세포주 전에 넣으면 종별 고기 (수확 때 소모)']);
    const medium = def.medium;
    if (medium) {
      // 2026-09-13: 「배양 n 회」 → max durability (the same rule as soil — used even at 0, and the speed · socket effects apply by ratio) + socket slots
      if (positive(medium.durability)) rows.push(['내구도', `최대 ${Math.round(medium.durability)}`]);
      // speedMul 0.7 = 「30 % faster」. Should a medium above 1 (a slow medium) appear, the sign flips by itself.
      const faster = Math.round((1 - medium.speedMul) * 100);
      if (faster !== 0) rows.push(['배양 속도', `${faster > 0 ? '+' : '−'}${Math.abs(faster)} %`]);
      rows.push(['소켓 칸', `${growSocketSlotsFor(def.rarity)} 칸`]);
    }
    if (def.growSocket) this.socketRows(rows, def.growSocket);
    if (def.bag) rows.push(['가방', `${def.bag.cols} × ${def.bag.rows} · 퀵 ${def.bag.quickSlots}`]);
    /* 2026-09-11 (C-36 follow-up): bag durability — `cur / max` with an instance, a new bag's `최대 max` on a bare chip.
       2026-09-15 (gadget rework): **a gadget that carries durability** (dome shield · barricade) gets the same row — the
       damage a deployable took stays as item durability (`GadgetDef.wearsItemDurability`), so the card must say it. */
    if ((def.bag || def.category === 'gadget') && def.durabilityMax !== undefined && def.durabilityMax > 0) {
      const max = def.durabilityMax;
      const inst = this.instanceOf(uid, defId);
      rows.push(['내구도', inst ? `${Math.round(Math.max(0, Math.min(max, inst.durability ?? max)))} / ${max}` : `최대 ${max}`]);
    }
    // 2026-09-08: implants — when the inventory's implant slots turned from a vertical list into a row of square
    //   thumbnails (name · perk · stats left that card), this card became where that information lives.
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
    for (const [k, v, color] of rows) {
      el('span', { cls: 'k', text: k, parent: this.statsEl });
      const vEl = el('span', { cls: 'v', parent: this.statsEl });
      if (color) vEl.style.color = color;
      if (typeof v === 'string') vEl.textContent = v;
      else for (const seg of v) this.appendSeg(vEl, seg);
    }
    this.statsEl.hidden = rows.length === 0;
    // 2026-09-15: ammo whose per-round weight is a fraction of a kilogram (표창 · 탄띠 … — `data/items.csv` `weight`) used to print as `0.0 kg` — under 1 kg goes to the significant digits
    setText(this.weightAmount, def.weight !== undefined ? `${def.weight >= 1 ? def.weight.toFixed(1) : String(Number(def.weight.toFixed(4)))} kg` : '—');
    setText(this.valueAmount, formatCredits(itemCreditValue(def)));
    this.root.hidden = false;
    this.visible = true;
  }

  /* ── 2026-09-15 (gadget rework): segment colours · the description's inline markup ──────── */

  /** One value segment. Only a dim segment takes an inline colour (no modifier class on `.itip-stats .v` — the 2026-09-10 `.hold` accident). */
  private appendSeg(host: HTMLElement, seg: SpecSeg): void {
    const sp = el('span', { text: seg.text, parent: host });
    if (seg.dim) sp.style.color = SEG_DIM_COLOR;
  }

  /**
   * The description paragraph. `description` in `data/items.csv` can now use the `{em}…{/em}` · `{dim}…{/dim}` · `{br}`
   * tokens, and the **one** place that resolves them is `items/ItemText.parseItemText` (the grid card calls the same
   * function). With no token it is one segment on one line, so it is drawn exactly as before.
   */
  private renderDesc(text: string): void {
    const lines = parseItemText(text);
    this.descEl.replaceChildren();
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) el('br', { parent: this.descEl });
      for (const s of lines[i]) {
        const sp = el('span', { text: s.text, parent: this.descEl });
        if (s.style === 'em') sp.style.color = SEG_EM_COLOR;
        else if (s.style === 'dim') sp.style.color = SEG_DIM_COLOR;
      }
    }
  }

  /**
   * The 재화 card. It appears in the same box · the same place as the item card, but the 분류/등급 row becomes a `재화`
   * badge and the value bar disappears — a currency has neither a rarity nor a sell price. Trust keeps the corporation
   * colour as it is, so the card is tinted in the corporation colour too.
   */
  private renderCurrency(id: string): void {
    const def: CurrencyDef | undefined = currencyDef(id);
    if (!def) { this.hide(); return; }
    this.currencyId = id;
    this.textKey = null;
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

  /** The text card (`TIP_NAME_ATTR`) — draws the name · the 분류 row · the description the chip stamped, in the same frame as the 재화 card. */
  private renderText(chip: HTMLElement, key: string): void {
    const color = chip.dataset.tipColor || 'var(--c-text-dim)';
    this.textKey = key;
    this.currencyId = null;
    this.defId = null;
    this.uid = null;
    this.root.classList.add('is-currency');
    this.root.style.setProperty('--rc', color);
    this.root.style.setProperty('--ic', color);
    setText(this.nameEl, chip.dataset.tipName ?? '');
    setText(this.subEl, chip.dataset.tipSub ?? '');
    setText(this.descEl, chip.dataset.tipDesc ?? '');
    this.statsEl.replaceChildren();
    this.statsEl.hidden = true;
    this.valueEl.hidden = true;
    this.root.hidden = false;
    this.visible = true;
  }

  /**
   * 2026-09-13: the three soil · medium socket rows — `종류` (a soil socket · where it goes), `<effect name> <value>`,
   * `장착`. The value is `amount` as a % (speed = the fraction the time falls by, wear = the fraction the wear falls by,
   * yield = the chance of +1 per harvest). The `장착` row states the contract (`GrowSocketEffect`) that speed · yield
   * apply only in proportion to the soil · medium durability.
   */
  private socketRows(rows: TipRow[], s: GrowSocketDef): void {
    const kind = GROW_SOCKET_TARGET_LABEL_KO[s.target];
    if (!kind) return;
    rows.push(['종류', `${kind} · ${s.target === 'soil' ? '재배 스테이션의 흙' : '배양조의 배지'}`]);
    const pct = Math.round((Number.isFinite(s.amount) ? s.amount : 0) * 1000) / 10;
    const num = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
    const value = s.effect === 'yield' ? `${num} % 확률로 +1 개` : s.effect === 'speed' ? `시간 −${num} %` : `마모 −${num} %`;
    rows.push([GROW_SOCKET_EFFECT_LABEL_KO[s.target]?.[s.effect] ?? '효과', value, CATEGORY_COLOR.socket]);
    rows.push(['장착', s.effect === 'wear' ? '영구 — 교체하면 파괴' : '영구 — 내구도 비율만큼 적용 · 교체하면 파괴']);
  }

  /** The Korean name of a skill (`getSkillDef`), the id when there is no progression. */
  private skillName(skill: SkillId): string {
    try { return this.ctx?.progression?.getSkillDef(skill)?.name ?? skill; } catch { return skill; }
  }

  /** The Korean name of a stat (`getStatDef`), the id when there is no progression. */
  private statName(stat: StatId): string {
    try { return this.ctx?.progression?.getStatDef(stat)?.name ?? stat; } catch { return stat; }
  }

  /* ── 2026-09-13 library series · video games ───────────────────────────────────────────────────────────── */

  /**
   * The rows of a series medium. Every number comes from the series table (`LIBRARY_SERIES_MAP`) · a housing query, and
   * only the sentences are made here.
   *  - the `시리즈` name · `권` (`II / V권`, `단편` for a one-volume series)
   *  - one row per effect row — the value is **for all volumes** (`(전권)` after the value when there are several), the
   *    text colour is the medium's category colour
   *  - `진행 n/N권 · 적용 n %` (`getSeriesProgress` — the series' share only, without the helper furniture multiplier)
   *  - `보관` — `보관함 없음` with no shelf for that medium, else `아직 꽂지 않음` / `서재에 꽂혀 있음` from `isShelfItemWanted`
   *  - `등장 행성`
   */
  private seriesRows(rows: TipRow[], def: ItemDef, seriesId: string, volume: number, medium: ShelfMedium): void {
    const series = LIBRARY_SERIES_MAP.get(seriesId);
    if (!series) return;
    const color = CATEGORY_COLOR[def.category];
    rows.push(['시리즈', series.name]);
    rows.push(['권', series.volumes <= 1 ? '단편' : `${romanVolume(volume)} / ${romanVolume(series.volumes)}권`]);
    const full = series.volumes > 1 ? ' (전권)' : '';
    for (const e of series.effects) {
      const line = this.effectRow(e);
      if (line) rows.push([line[0], `${line[1]}${e.kind === 'recipe' ? '' : full}`, color]);
    }
    const h = this.ctx?.housing;
    if (h && typeof h.getSeriesProgress === 'function') {
      try {
        const p = h.getSeriesProgress(seriesId);
        if (p) rows.push(['진행', `${p.have}/${p.total}권 · 적용 ${Math.round(p.fraction * 100)} %`]);
      } catch { /* skeleton */ }
    }
    const shelved = this.shelvedState(def.id, medium);
    if (shelved === 'none') rows.push(['보관', '보관함 없음', 'var(--c-text-dim)']);
    else if (shelved === 'wanted') rows.push(['보관', '아직 꽂지 않음', FAVORITE_BAND_COLOR]);
    else if (shelved === 'shelved') rows.push(['보관', '서재에 꽂혀 있음']);
    const planets = series.planets.map((id) => PLANET_DEFS.find((p) => p.id === id)?.name ?? id);
    if (planets.length) rows.push(['등장 행성', planets.join(' · ')]);
  }

  /** One effect row → `[row name, value]`. Null for an unknown target. */
  private effectRow(e: LibraryEffect): [string, string] | null {
    switch (e.kind) {
      case 'skillGain': return [`${this.skillName(e.target)} 상승량`, pctText(e.value)];
      case 'derived': return [MEAL_BUFF_LABEL_KO[e.target] ?? e.target, mealBuffAmountText(e.target, e.value)];
      case 'gymScore': return [`${this.furnitureName(e.target)} 점수`, pctText(e.value)];
      case 'cookScore': return [`${COOK_GAME_LABEL_KO[e.target] ?? e.target} 점수`, pctText(e.value)];
      case 'raidXp': return ['레이드 경험치', pctText(e.value)];
      case 'trustXp': return [e.target === 'all' ? '계약 신뢰도 (모든 기업)' : `${CORP_DEFS[e.target]?.name ?? e.target} 계약 신뢰도`, pctText(e.value)];
      case 'recipe': return ['레시피', `${this.recipeName(e.target)} — 꽂혀 있는 동안`];
    }
    return null;
  }

  /**
   * `'none'` = no shelf for this medium is owned, neither placed nor in 가구 창고, `'wanted'` = the shelf is there but
   * nothing of the same kind is on it, `'shelved'` = it is shelved, `null` = housing cannot answer (the row is not drawn).
   */
  private shelvedState(defId: string, medium: ShelfMedium): 'none' | 'wanted' | 'shelved' | null {
    const h = this.ctx?.housing;
    if (!h || typeof h.isShelfItemWanted !== 'function') return null;
    try {
      const want = SHELF_INTERACTION[medium];
      const isHolder = (id: string): boolean => FURNITURE_DEF_BY_ID.get(id)?.interaction === want;
      const st = h.state;
      const owned = !!st && ((st.furniture ?? []).some((p) => isHolder(p.defId)) || (st.furnitureStorage ?? []).some((s) => s.qty > 0 && isHolder(s.defId)));
      if (!owned) return 'none';
      return h.isShelfItemWanted(defId) ? 'wanted' : 'shelved';
    } catch { return null; }
  }

  /** A gym equipment interaction → that furniture's name (found in the furniture table). */
  private furnitureName(interaction: string): string {
    return FURNITURE_DEFS.find((d) => d.interaction === interaction)?.name ?? interaction;
  }

  /** A cook recipe id → the name of the meal it outputs. */
  private recipeName(recipeId: string): string {
    try {
      const r = this.ctx?.loot?.getAllRecipes().find((x) => x.id === recipeId);
      if (r) return this.defOf(r.outputDefId)?.name ?? r.outputDefId;
    } catch { /* skeleton */ }
    return recipeId;
  }

  /** A console kind → that console item's name (`ItemDef.gameConsole.console`). */
  private consoleName(consoleId: string): string {
    try {
      const d = this.ctx?.loot?.getAllItemDefs().find((x) => x.gameConsole?.console === consoleId);
      if (d) return d.name;
    } catch { /* skeleton */ }
    return consoleId;
  }

  /**
   * The name of the library shelf that takes a medium — the library furniture def with `SHELF_INTERACTION[medium]`
   * (책장 · 디스크 전시대 · 레코드랙). When housing cannot answer, it is built from the medium name, like `디스크 보관함`.
   */
  private shelfName(medium: ShelfMedium): string {
    try {
      const def = this.ctx?.housing?.getFurnitureFor('library').find((d) => d.interaction === SHELF_INTERACTION[medium]);
      if (def) return def.name;
    } catch { /* skeleton */ }
    return `${SHELF_MEDIUM_LABEL_KO[medium]} 보관함`;
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

  /**
   * Stands the card next to the cursor. The default is the **bottom-right of the cursor** (the place the bag · stash
   * grid tiles used from the start).
   *
   * **2026-09-14 (user's decision) — a material chip goes to the top-left of the cursor.** The 「필요 아이템」 rows of
   * 시설 관리 · workbench crafting sit low on the screen, so at the default bottom-right place the card overflowed
   * vertically and flipped **upwards only** — the result was 「the top-right of the cursor」 and the card covered the chip
   * that had to be clicked. Those rows ask for the top-left with `data-tip-anchor="left"` on themselves (or on the box
   * that holds them), and only that one attribute is looked at here (`closest` reads it from the chip `chipAt` picked,
   * so it can be stamped per chip or once on the whole row). Either way, **going off screen still flips it to the other
   * side as before.**
   */
  private move(x: number, y: number, chip?: HTMLElement | null): void {
    const pad = 16;
    const w = this.root.offsetWidth, h = this.root.offsetHeight;
    const anchorLeft = !!chip?.closest(`[${TIP_ANCHOR_ATTR}="left"]`);
    let left = anchorLeft ? x - w - pad : x + pad;
    let top = anchorLeft ? y - h - pad : y + pad;
    if (anchorLeft) {
      if (left < 8) left = x + pad;
      if (top < 8) top = Math.min(window.innerHeight - h - 8, y + pad);
    } else {
      if (left + w > window.innerWidth - 8) left = x - w - pad;
      if (top + h > window.innerHeight - 8) top = y - h - pad;
    }
    this.root.style.transform = `translate(${Math.round(Math.max(8, left))}px, ${Math.round(Math.max(8, top))}px)`;
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.defId = null;
    this.uid = null;
    this.currencyId = null;
    this.textKey = null;
    this.chip = null;
    this.stopWatch();
    this.root.hidden = true;
  }

  dispose(): void {
    this.stopWatch();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }
}
