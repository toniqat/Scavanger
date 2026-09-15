import type { CurrencyDef, GameContext, GrowSocketDef, ItemDef, ItemInstance, ShelfMedium, SkillId, StatId, UniqueWeaponKind } from '@/shared';
import {
  UNIQUE_WEAPON_LABEL_KO,
  CATEGORY_COLOR, CATEGORY_ICON, CATEGORY_LABEL_KO, ENV_COLOR, ENV_LABEL_KO, GROW_SOCKET_EFFECT_LABEL_KO,
  GROW_SOCKET_TARGET_LABEL_KO, MEAL_BUFF_LABEL_KO, PERK_DEFS,
  RARITY_COLORS, RARITY_LABEL_KO, SAMPLE_FAMILY_COLOR, SAMPLE_FAMILY_ICON, SAMPLE_FAMILY_LABEL_KO,
  SHELF_INTERACTION, SHELF_MEDIUM_LABEL_KO, SOIL_TAG_COLOR, SOIL_TAG_LABEL_KO,
  currencyDef, formatCredits, growSocketSlotsFor, itemCreditValue, shelfItemOf,
} from '@/shared';
import { el, setText } from '../dom';
import { cookStepsText, mealBuffAmountText, mealEffects, mealQualityText, mealTierLabel } from './mealText';
/* 2026-09-13 (요리 미니게임): 품질 줄 */
import { normalizeMealQuality } from '@/shared';
import { COMPUTE_CLUSTER_MAX_CORES, COMPUTE_CORE_DEF_ID, PROCESSOR_DEF_ID } from '@/shared';   // 2026-09-13 암호화폐 채굴

/* 2026-09-15 (가젯 개편): 설명 인라인 마크업 · 스펙 줄은 `@/items` 한 곳이 만든다 — 격자 카드(`inventory/ui/Tooltip`)와 **같은 함수**다. */
import type { SpecSeg, SpecValue } from '@/items';
import { itemSpecRows, parseItemText } from '@/items';

/**
 * `[라벨, 값, 값 글자색?]` — 세 번째 칸은 인라인 색이고 클래스를 만들지 않는다 (아래 주석).
 * 2026-09-15: 값은 통짜 문자열이거나 **조각 목록**(`SpecSeg[]`)이다 — 「5초간 매 초 HP 4 회복, 총 20 회복」처럼
 * 숫자만 본문 색이고 나머지 글자는 흐린 줄이 생겼다. 조각의 색도 modifier 클래스가 아니라 인라인이다.
 */
type TipRow = [string, SpecValue, string?];

/** 흐린 조각 · 강조 조각의 색 (카드 팔레트). 격자 카드는 자기 `--inv-*` 로 같은 뜻을 칠한다. */
const SEG_DIM_COLOR = 'var(--c-text-dim)';
const SEG_EM_COLOR = 'var(--c-accent)';
/** 스펙 줄의 이득 · 손해 색. */
const TONE_COLOR = { good: 'var(--c-success)', bad: 'var(--c-danger)' } as const;

/** 2026-09-13 (요리 품질): 품질 줄의 별 색 — 버프 썸네일의 별 배지(`styles/buffs.css` `.bfs-cell[data-q]`)와 같은 금색. */
const MEAL_QUALITY_STAR_COLOR = '#ffd24a';

/* 2026-09-13 (서재 시리즈 · 비디오게임): 시리즈 이름 · 효과 줄 · 등장 행성 · 기구 · 기업 · 조리 단계 이름 */
import type { LibraryEffect } from '@/shared';
import { COOK_GAME_LABEL_KO, CORP_DEFS, FURNITURE_DEFS, GYM_MINIGAME_LABEL_KO, LIBRARY_SERIES_MAP, PLANET_DEFS } from '@/shared';

/** 2026-09-13: `보관 — 아직 꽂지 않음` 의 글자색 = 타일 띠의 파랑 (`--c-favorite`, 없으면 같은 파랑). */
const FAVORITE_BAND_COLOR = 'var(--c-favorite, #4a90ff)';
/** 가구 def id → def (보관함 보유 판정). */
const FURNITURE_DEF_BY_ID = new Map(FURNITURE_DEFS.map((d) => [d.id, d] as const));
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
/** 권 번호 1 … 10 → 로마 숫자 (범위 밖은 아라비아 숫자). */
function romanVolume(n: number): string {
  const v = Math.floor(n);
  return ROMAN[v] ?? String(v);
}
/** 배율 가산 → `+12.5 %` (소수 한 자리까지). */
function pctText(v: number): string {
  const n = Math.round((Number.isFinite(v) ? v : 0) * 1000) / 10;
  const mag = Math.abs(n);
  return `${n < 0 ? '−' : '+'}${Number.isInteger(mag) ? String(mag) : mag.toFixed(1)} %`;
}

/** 유한한 양수인가 (옛 csv 로 비어 온 내구도 · 시간 칸을 거른다). */
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * 2026-09-14 (사용자 결정): 카드가 설 자리를 칩 쪽에서 정하는 옵트인 속성 (`data-tip-anchor="left"` = 커서 **좌상단**).
 * 칩 자신에 찍어도 되고 칩을 담은 줄(`.fcard-cost` · `.inv-craft-costs` …)에 한 번 찍어도 된다 — `move()` 가
 * `closest` 로 읽는다. 다른 폴더는 이 상수를 import 하지 않고 `dataset.tipAnchor = 'left'` 만 쓴다 (폴더 간 import 금지).
 */
export const TIP_ANCHOR_ATTR = 'data-tip-anchor';

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
 * **온실 개편 (2026-09-11)**: 토양(`def.soil`)은 `속성`(`SOIL_TAG_LABEL_KO`, 값 글자만 `SOIL_TAG_COLOR` 로 물든다) ·
 * `수확` 두 줄을, 씨앗(`def.seed`)은 `재배 시간` 아래에 **맞는 토양** 한 줄을 같은 색으로 얻는다 — 어떤 흙에 심어야
 * `SOIL_MATCH_SPEEDUP` 를 받는지가 씨앗 카드에서 끝나야 한다. 색은 인라인 `style.color` 로만 칠한다: `.it-stats .v`
 * 에 modifier 클래스를 새로 달면 HUD 위젯 클래스와 이름이 겹칠 위험이 있다 (2026-09-10 `.hold` 사고).
 *
 * **주방 · 배양조 · 프린터 (2026-09-11)**: 요리(`def.meal`)는 `사용 — 다음 레이드 1회분` · 버프 이름을 행 이름으로 쓴
 * `<버프> +n` (· tier 2 면 `구분 — 특선 요리`), 주머니(`def.pouch`)는 `주머니 c × r` · `수납`(받는 카테고리 이름),
 * 세포주(`def.strain`)는 `배양조 n 시간` · `산출물`, 배지(`def.medium`)는 `배양 n 회` · `배양 속도 +n %`
 * (`speedMul` 0.7 = +30 %). 요리 값의 부호 · 단위는 `hud/mealText` 가 찍는다 — 레이드 HUD 의 식사 배지와 **같은
 * 문장**이어야 하고, `%` 인지 `kg` 인지를 정하는 표는 `shared/labels` 의 `MEAL_BUFF_UNIT` 하나다.
 *
 * **연구실 (2026-09-11)**: 표본(`def.sample`)은 `분석기 해석 n 시간` · `산출물` (· 처음이면 `최초 해석` 보너스),
 * 준비물(`def.prep`)은 `사용 — 다음 레이드 1회분` · `차단 — <환경> 환경` 을 얻는다. 환경 이름 · 색은 `ENV_LABEL_KO` ·
 * `ENV_COLOR` 하나에서 오고 (HUD 배지 · 행성 브리핑과 같은 원본), 색은 위와 같은 이유로 인라인이다.
 *
 * **재화 (2026-09-09)**: 계약 · 퀘스트 보상의 크레딧 · 경험치 · 기업별 신뢰도는 아이템이 아니지만 같은 자리에
 * 같은 크기의 칩(`shared/currency.buildCurrencyChip`)으로 선다. 그 칩은 `data-def-id` 대신
 * **`data-currency-id`** 를 달고, 이 카드는 그것도 받아 `.is-currency` 로 그린다 — 헤더에 `재화` 배지가 붙고
 * 아이템의 분류 · 등급 · 무게 · 가치 줄은 나오지 않는다. 아이템과 구분되는 틀이 필요하다는 요구가 여기서 끝난다.
 *
 * **요리 재료 티어 (2026-09-13, `docs/DECISIONS.md` 「2026-09-13 — 요리 재료 티어」)**: 요리는 `구분 — <티어 이름>`(`MEAL_TIER_LABEL_KO`, 은퇴 요리는 생략) ·
 * `사용` 아래에 **능력치 줄 전부**(`hud/mealText.mealEffects` — `effects` 가 없는 옛 def 는 한 줄)를 얻는다 (옛 `구분 — 특선 요리` 는 없다).
 * 토양은 `수확 n 회` 대신 **`내구도 최대 n`** · **`소켓 칸 n 칸`**(`growSocketSlotsFor(등급)`), 배지는 `배양 n 회` 대신 같은 두 줄 + `배양 속도`,
 * 세포주는 스캐폴드 산출이 있으면 **`스캐폴드 배양 n 시간`** · **`스캐폴드 산출`** 두 줄을 더 얻고, 배양 스캐폴드(`def.scaffold`)는 `사용` 한 줄
 * 설명, 소켓(`def.growSocket`)은 `종류`(`GROW_SOCKET_TARGET_LABEL_KO` · 끼우는 곳) · `<효과 이름>`(`GROW_SOCKET_EFFECT_LABEL_KO`: speed = `시간 −n %`,
 * wear = `마모 −n %`, yield = `n % 확률로 +1 개`, 값은 인라인 `CATEGORY_COLOR.socket`) · `장착` 을 얻는다. 표본은 **`계열`**(글리프 + 이름, 인라인
 * `SAMPLE_FAMILY_COLOR`) · `분석기 해석 n 시간`(표의 기준 시간) · `결과 — <계열> 결과표` 이고 옛 `산출물` · `최초 해석` 줄은 계열이 없는 옛 def 에만 남는다.
 * 은퇴 아이템(`def.retired`)은 맨 위에 **`상태 — 더 이상 쓰이지 않는 아이템`**(흐린 글자) 한 줄.
 *
 * **요리 미니게임 (2026-09-13, `docs/DECISIONS.md` 「2026-09-13 — 요리 미니게임」)**: 요리는 호버한 요소가 `data-uid` 를 달고 그 인스턴스의 품질이
 * 0 보다 크면 `구분` 아래에 **`품질 — ★★★☆☆ +15 %`**(`hud/mealText.mealQualityText`) 한 줄을 얻고, 능력치 줄이 **보너스 반영 수치**가 된다
 * (`mealEffects(meal, quality)` — 먹었을 때 `derive.applyMealBuff` 가 더하는 값과 같은 식). 인스턴스가 없는 칩(재료 · 보상 칩)은 품질 0 기준값이다.
 * 조리대 요리(`cookStepsOf` 가 비지 않은 것)는 능력치 줄 아래에 **`조리 — ① 썰기 → ② 젓기`**(`cookStepsText`) 한 줄 — 단계가 없으면 줄도 없다.
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
   * **사용자 버그 「빠른 이동한 아이템의 툴팁이 마우스를 움직일 때까지 남는다」의 이 카드 쪽.** 카드는 `pointerout` 으로 내려가는데,
   * 더블클릭 · 우클릭 메뉴로 아이템을 옮기면 격자(`inventory/ui/TradeGrids` → `GridView`)가 **커서 아래의 타일을 DOM 에서 떼어 낸다** —
   * 떼어 낸 요소에는 `pointerout` 이 오지 않으므로 카드는 이미 없는 칩을 설명한 채 떠 있었다. 그래서 카드가 떠 있는 동안 매 프레임
   * 칩이 아직 연결돼 있는지만 싸게 보고(`isConnected` · `.is-vanishing`), 떨어졌거나 인벤토리가 방금 바뀌었으면(`recheckFrames` —
   * 같은 요소가 다른 칸으로 옮겨 갔을 수 있다) **마지막 포인터 위치를 다시 짚는다**(`rehit`): 거기 칩이 있으면 그 칩을, 없으면 내린다.
   * 인벤토리 이벤트 뒤 두 프레임인 이유: 격자는 이벤트를 받은 **다음** rAF 에 다시 그리는데(`TradeGrids.scheduleRefresh`) 그 콜백과
   * 이 루프의 순서는 등록 순서라 한 프레임으로는 다시 그리기 전을 짚을 수 있다.
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
    const id = chip.dataset.defId ?? null;
    if (!id) return false;
    const uid = chip.dataset.uid ?? null;
    if (!this.visible || id !== this.defId || uid !== this.uid) this.render(id, uid);
    return this.watching(chip);
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
      '.item-chip[data-def-id], [data-item-tip][data-def-id], [data-currency-id]',
    ) as HTMLElement | null;
  }

  private defOf(defId: string): ItemDef | undefined {
    const ctx = this.ctx;
    if (!ctx) return undefined;
    try { return ctx.loot?.getItemDef(defId) ?? ctx.inventory?.getDef(defId); } catch { return undefined; }
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
    // 2026-09-15: 전설 유니크 무기는 `무기` 대신 **자기 종류**(`컴포짓 보우 · 전설`) — 이름이 별명뿐이라 종류는 여기서 읽힌다.
    //   csv `class`(AR / DMR / SMG / SR)는 사격 숙련만 고르고 화면에 나오지 않는다.
    const uniqueKind = this.uniqueKindOf(def);
    const kindWord = uniqueKind ? UNIQUE_WEAPON_LABEL_KO[uniqueKind] : (CATEGORY_LABEL_KO[def.category] ?? def.category);
    setText(this.subEl, `${kindWord} · ${RARITY_LABEL_KO[def.rarity] ?? def.rarity}`);
    this.renderDesc(def.description);

    const rows: TipRow[] = [];
    // 2026-09-13: 은퇴 아이템은 맨 위에 한 줄 — 정의는 남았지만 어느 출처 · 소비처에서도 빠졌다
    if (def.retired) rows.push(['상태', '더 이상 쓰이지 않는 아이템', 'var(--c-text-dim)']);
    const have = this.owned(defId);
    if (have >= 0) rows.push(['보유', `${have} 개`]);
    /* 2026-09-15 (가젯 개편, 사용자 결정): 회복약 · 실드 충전기 · 전투 소모품 · 가젯 · 수류탄의 스펙 —
       **맨 위가 `사용 시간`** 이고 설명 글에서는 그 수치를 전부 걷어냈다 (`data/items.csv`). 표는 `items/ItemSpec` 하나다. */
    for (const r of itemSpecRows(def)) rows.push([r.k, r.v, r.tone ? TONE_COLOR[r.tone] : undefined]);
    if (def.seed) rows.push(['재배 시간', `${def.seed.growHours} 시간`]);
    // 온실 개편 (2026-09-11): 씨앗은 자기가 원하는 흙을, 토양은 자기 속성과 남은 수확 횟수를 적는다.
    // `soilTag` 는 계약상 필수지만 옛 세이브 · 옛 csv 로 비어 올 수 있어 표에 있을 때만 그린다.
    const seedTag = def.seed?.soilTag;
    if (seedTag && SOIL_TAG_LABEL_KO[seedTag]) rows.push(['맞는 토양', SOIL_TAG_LABEL_KO[seedTag], SOIL_TAG_COLOR[seedTag]]);
    const soil = def.soil;
    if (soil) {
      if (SOIL_TAG_LABEL_KO[soil.tag]) rows.push(['속성', SOIL_TAG_LABEL_KO[soil.tag], SOIL_TAG_COLOR[soil.tag]]);
      // 2026-09-13: 「수확 n 회」 → 최대 내구도 + 소켓 칸 (가방의 토양은 늘 새것이라 `최대` 다 — 닳은 흙은 재배 화면이 말한다)
      if (positive(soil.durability)) rows.push(['내구도', `최대 ${Math.round(soil.durability)}`]);
      rows.push(['소켓 칸', `${growSocketSlotsFor(def.rarity)} 칸`]);
    }
    /* 연구실 (A-12 · A-13, 2026-09-11): 표본은 **분석기에 넣었을 때 무엇이 얼마나 걸려 나오는가**, 준비물은
       **어떤 환경을 몇 번 막아 주는가** 가 카드에서 끝나야 한다. 씨앗 · 토양 줄과 같은 자리 · 같은 인라인 색 규약이다
       (`.it-stats .v` 에 modifier 클래스를 만들지 않는다 — 2026-09-10 `.hold` 사고). 해석 시간은 도감 진척으로
       줄어들지만 그것은 분석 화면이 말한다: 여기 적는 것은 **표에 있는 기준 시간**이다. */
    const sample = def.sample;
    if (sample) {
      /* 2026-09-13 (요리 재료 티어): 결과는 계열 결과표(`ANALYSIS_RESULTS`)에서 분석 레벨로 해금 · 추첨된다 — 카드는 **계열**을
         말하고, 무엇이 얼마의 확률로 나오는지는 분석 도감이 말한다. `rewardDefId` 는 결과표가 비었을 때의 대체일 뿐이라 적지 않는다.
         계열이 없는 def(새 열을 모르는 옛 로더)만 옛 두 줄을 그대로 쓴다. */
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
    /* 암호화폐 채굴 (2026-09-13): 연산 코어 · 프로세서는 평범한 재료처럼 보이지만 **어디에 쓰는가**가 카드에서 끝나야 한다. */
    if (def.id === COMPUTE_CORE_DEF_ID) rows.push(['사용', `연산 클러스터에 꽂는다 (최대 ${COMPUTE_CLUSTER_MAX_CORES}개)`]);
    else if (def.id === PROCESSOR_DEF_ID) rows.push(['사용', '회로 기판과 조립해 연산 코어로 만든다']);
    const prep = def.prep;
    if (prep && ENV_LABEL_KO[prep.env]) {
      rows.push(['사용', '다음 레이드 1회분']);
      rows.push(['차단', `${ENV_LABEL_KO[prep.env]} 환경`, ENV_COLOR[prep.env]]);
    }
    /* 서재 매체 (A-3e, 2026-09-12): 책 · 디스크 · 레코드는 같은 역할이라 같은 두 줄이다 — **어떤 숙련을 올리는가**와
       **서재의 어느 보관함에 꽂는가**. 매체 판정은 계약의 `shelfItemOf` 하나이고, 보관함 이름은 가구 표(`furniture.csv`)에서
       그 매체의 interaction 을 가진 서재 가구를 찾아 쓴다 — 이름을 여기 베껴 적지 않는다(표가 바뀌면 카드가 따라온다). */
    /* 2026-09-13 (서재 시리즈, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」): 옛 `숙련` 한 줄(숙련별 · 등급 가중치)은 없어졌다 — 효과는
       이제 **시리즈**의 효과 줄이 정한다. 시리즈 매체는 `시리즈` · `권` · 효과 줄(전권 값) · `진행` · `보관` · `꽂는 곳` · `등장 행성`. */
    const shelf = shelfItemOf(def);
    if (shelf) {
      const media = def.book ?? def.disc ?? def.record;
      if (media?.series) this.seriesRows(rows, def, media.series, media.volume ?? 1, shelf.medium);
      rows.push(['꽂는 곳', `서재 · ${this.shelfName(shelf.medium)}`]);
    }
    /* 2026-09-13 (비디오게임): 게임 디스크 = 게임기 · 능력치 · 방식 · 사용, 게임기 = TV 에 장착 */
    const game = def.gameDisc;
    if (game) {
      rows.push(['게임기', this.consoleName(game.console)]);
      rows.push(['능력치', this.statName(game.stat)]);
      rows.push(['방식', GYM_MINIGAME_LABEL_KO[game.minigame] ?? game.minigame]);
      rows.push(['사용', '게임 디스크 전시대에 꽂고 TV 로 플레이']);
    }
    if (def.gameConsole) rows.push(['사용', 'TV 에 장착']);
    /* 주방 · 배양조 · 프린터 (A-3c · A-14 · A-15, 2026-09-11): 요리 · 주머니 · 세포주 · 배지 넷도 준비물과 같은 결로
       「무엇을 얼마나 오래 / 얼마나 올려 주는가」가 카드에서 끝난다. 요리의 값은 `hud/mealText` 가 찍는다 — 레이드
       HUD 의 식사 배지와 **같은 문장**이어야 하고, 단위(`%` · `kg` · `m`)를 정하는 표는 `shared/labels` 의
       `MEAL_BUFF_UNIT` 하나다. `durabilityLossMul` 은 `amount` 가 음수라 「장비 손상 −20 %」로 이득으로 읽힌다.
       색은 위 토양 · 환경 줄과 같은 이유로 **인라인**이다 (`.it-stats .v` 에 modifier 클래스를 만들지 않는다). */
    const meal = def.meal;
    if (meal) {
      // 2026-09-13: 티어 이름 + 능력치 줄 전부. 은퇴한 옛 특선 요리(tier 2)는 「페이스트 요리」 가 아니므로 구분 줄을 뺀다.
      const tier = def.retired ? '' : mealTierLabel(meal);
      if (tier) rows.push(['구분', tier]);
      // 2026-09-13 (요리 품질): 인스턴스가 있을 때만 — 칩(재료 · 보상)은 품질이 없다
      const quality = normalizeMealQuality(this.instanceOf(uid, defId)?.quality);
      const qText = mealQualityText(quality);
      if (qText) rows.push(['품질', qText, MEAL_QUALITY_STAR_COLOR]);
      rows.push(['사용', '다음 레이드 1회분']);
      for (const e of mealEffects(meal, quality)) {
        rows.push([MEAL_BUFF_LABEL_KO[e.buff] ?? '효과', mealBuffAmountText(e.buff, e.amount), CATEGORY_COLOR.meal]);
      }
      // 2026-09-13 (요리 미니게임): 조리대에서 하는 미니게임 순서
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
      // 2026-09-13 (T3): 스캐폴드가 든 칸에서는 종별 고기를 만든다 — 그 산출이 있는 세포주만 두 줄 더
      if (strain.scaffoldOutputDefId) {
        const sc = this.defOf(strain.scaffoldOutputDefId);
        if (positive(strain.scaffoldHours)) rows.push(['스캐폴드 배양', `${strain.scaffoldHours} 시간`]);
        rows.push(['스캐폴드 산출', `${sc?.name ?? strain.scaffoldOutputDefId} ×${strain.scaffoldOutputQty ?? 1}`]);
      }
    }
    if (def.scaffold) rows.push(['사용', '배양조 — 배지 다음 · 세포주 전에 넣으면 종별 고기 (수확 때 소모)']);
    const medium = def.medium;
    if (medium) {
      // 2026-09-13: 「배양 n 회」 → 최대 내구도 (토양과 같은 규칙 — 0 이어도 쓰고 속도 · 소켓 효과가 비율로 준다) + 소켓 칸
      if (positive(medium.durability)) rows.push(['내구도', `최대 ${Math.round(medium.durability)}`]);
      // speedMul 0.7 = 「30 % 빠름」. 1 보다 큰 배지(느린 배지)가 생겨도 부호가 그대로 뒤집힌다.
      const faster = Math.round((1 - medium.speedMul) * 100);
      if (faster !== 0) rows.push(['배양 속도', `${faster > 0 ? '+' : '−'}${Math.abs(faster)} %`]);
      rows.push(['소켓 칸', `${growSocketSlotsFor(def.rarity)} 칸`]);
    }
    if (def.growSocket) this.socketRows(rows, def.growSocket);
    if (def.bag) rows.push(['가방', `${def.bag.cols} × ${def.bag.rows} · 퀵 ${def.bag.quickSlots}`]);
    /* 2026-09-11 (C-36 후속): 가방 내구도 — 인스턴스가 있으면 `cur / max`, 칩뿐이면 새 가방의 `최대 max`.
       2026-09-15 (가젯 개편): **내구도를 들고 다니는 가젯**(돔 실드 · 바리케이드)도 같은 줄이다 — 배치물이 받은
       피해가 아이템 내구도로 남으므로(`GadgetDef.wearsItemDurability`) 카드가 그것을 말해야 한다. */
    if ((def.bag || def.category === 'gadget') && def.durabilityMax !== undefined && def.durabilityMax > 0) {
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
    for (const [k, v, color] of rows) {
      el('span', { cls: 'k', text: k, parent: this.statsEl });
      const vEl = el('span', { cls: 'v', parent: this.statsEl });
      if (color) vEl.style.color = color;
      if (typeof v === 'string') vEl.textContent = v;
      else for (const seg of v) this.appendSeg(vEl, seg);
    }
    this.statsEl.hidden = rows.length === 0;
    // 2026-09-15: 한 발 무게가 0.1 kg 아래인 탄약(표창 0.02 · 탄띠 0.0075 …)이 `0.0 kg` 로 찍히던 것 — 1 kg 아래는 유효 자리까지
    setText(this.weightAmount, def.weight !== undefined ? `${def.weight >= 1 ? def.weight.toFixed(1) : String(Number(def.weight.toFixed(4)))} kg` : '—');
    setText(this.valueAmount, formatCredits(itemCreditValue(def)));
    this.root.hidden = false;
    this.visible = true;
  }

  /* ── 2026-09-15 (가젯 개편): 조각 색 · 설명 인라인 마크업 ──────────────────────────────────────────────── */

  /** 값 조각 하나. 흐린 조각만 인라인 색을 받는다 (`.it-stats .v` 에 modifier 클래스를 만들지 않는다 — 2026-09-10 `.hold` 사고). */
  private appendSeg(host: HTMLElement, seg: SpecSeg): void {
    const sp = el('span', { text: seg.text, parent: host });
    if (seg.dim) sp.style.color = SEG_DIM_COLOR;
  }

  /**
   * 설명 문단. `data/items.csv` 의 `description` 은 이제 `{em}…{/em}` · `{dim}…{/dim}` · `{br}` 토큰을 쓸 수 있고
   * 푸는 곳은 `items/ItemText.parseItemText` **하나**다 (격자 카드도 같은 함수를 부른다). 토큰이 없으면 한 줄짜리
   * 조각 하나라 예전과 똑같이 그려진다.
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

  /**
   * 2026-09-13: 흙 · 배지 소켓 세 줄 — `종류`(토양 소켓 · 끼우는 곳), `<효과 이름> <값>`, `장착`. 값은 `amount` 를 %로
   * (speed = 시간이 줄어드는 비율, wear = 마모가 줄어드는 비율, yield = 수확마다 +1 개가 붙을 확률). speed · yield 는 흙 · 배지
   * 내구도 비율만큼만 듣는다는 계약(`GrowSocketEffect`)을 `장착` 줄이 말한다.
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

  /** 숙련의 한국어 이름 (`getSkillDef`), progression 이 없으면 id. */
  private skillName(skill: SkillId): string {
    try { return this.ctx?.progression?.getSkillDef(skill)?.name ?? skill; } catch { return skill; }
  }

  /** 능력치의 한국어 이름 (`getStatDef`), progression 이 없으면 id. */
  private statName(stat: StatId): string {
    try { return this.ctx?.progression?.getStatDef(stat)?.name ?? stat; } catch { return stat; }
  }

  /* ── 2026-09-13 서재 시리즈 · 비디오게임 ─────────────────────────────────────────────────────────────────────────── */

  /**
   * 시리즈 매체의 줄들. 수치는 전부 시리즈 표(`LIBRARY_SERIES_MAP`) · housing 질의에서 오고 여기서는 문장만 만든다.
   *  - `시리즈` 이름 · `권` (`II / V권`, 1권짜리는 `단편`)
   *  - 효과 줄마다 한 행 — 값은 **전권 기준**(여러 권이면 값 뒤에 `(전권)`), 글자색은 매체 카테고리 색
   *  - `진행 n/N권 · 적용 n %` (`getSeriesProgress` — 보조 가구 배율은 빼고 시리즈 몫만)
   *  - `보관` — 그 매체의 보관함이 없으면 `보관함 없음`, 있으면 `isShelfItemWanted` 로 `아직 꽂지 않음` / `서재에 꽂혀 있음`
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

  /** 효과 줄 하나 → `[행 이름, 값]`. 모르는 대상이면 null. */
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
   * `'none'` = 이 매체의 보관함을 배치 · 가구 창고 어디에도 갖고 있지 않다, `'wanted'` = 보관함은 있는데 같은 종류가 안 꽂혀 있다,
   * `'shelved'` = 꽂혀 있다, `null` = housing 이 답하지 못한다 (줄을 그리지 않는다).
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

  /** 운동 기구 interaction → 그 가구 이름 (가구 표에서 찾는다). */
  private furnitureName(interaction: string): string {
    return FURNITURE_DEFS.find((d) => d.interaction === interaction)?.name ?? interaction;
  }

  /** 조리 레시피 id → 산출 요리 이름. */
  private recipeName(recipeId: string): string {
    try {
      const r = this.ctx?.loot?.getAllRecipes().find((x) => x.id === recipeId);
      if (r) return this.defOf(r.outputDefId)?.name ?? r.outputDefId;
    } catch { /* skeleton */ }
    return recipeId;
  }

  /** 게임기 종류 → 그 게임기 아이템 이름 (`ItemDef.gameConsole.console`). */
  private consoleName(consoleId: string): string {
    try {
      const d = this.ctx?.loot?.getAllItemDefs().find((x) => x.gameConsole?.console === consoleId);
      if (d) return d.name;
    } catch { /* skeleton */ }
    return consoleId;
  }

  /**
   * 매체를 받는 서재 보관함의 이름 — 서재 가구 중 `SHELF_INTERACTION[medium]` 을 가진 def (책장 · 디스크 전시대 · 레코드랙).
   * housing 이 답하지 못하면 `디스크 보관함` 처럼 매체 이름으로 만든다.
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
   * 커서 옆에 카드를 세운다. 기본은 **커서 우하단**(가방 · 창고 격자 타일이 처음부터 쓰던 자리)이다.
   *
   * **2026-09-14 (사용자 결정) — 재료 칩은 커서 좌상단이다.** 시설 관리 · 작업대 제작의 「필요 아이템」 줄은
   * 화면 아래쪽에 있어서, 우하단 기본 자리에서 카드가 세로로 넘쳐 **위로만** 뒤집혔다 — 결과가 「커서 우상단」
   * 이라 눌러야 할 칩을 카드가 덮었다. 그 줄들은 자기(또는 자기를 담은 상자의) `data-tip-anchor="left"` 로
   * 좌상단을 요청하고, 여기서는 그 한 속성만 본다 (`chipAt` 이 집은 칩에서 `closest` 로 읽으므로 칩마다
   * 찍어도 되고 줄 전체에 한 번 찍어도 된다). 어느 쪽이든 **화면 밖으로 나가면 예전처럼 반대편으로 뒤집는다.**
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
