import type { EmbeddedView, GameContext, ItemInstance, TradeGridsView } from '@/shared';
import { FURNITURE_DISABLED_REASON_KO, POWER_SHORT_REASON_KO } from '@/shared';   // 2026-09-13 발전기 전력
import { el, setText, toggleClass } from './dom';

/**
 * **가구 화면 공통 틀** (2026-09-12 · 카드 배치 2026-09-13) — 재배 스테이션 · 분석기 · 배양조 · 식탁(그리고 서재)이 같은
 * 뼈대를 쓴다.
 *
 * 2026-09-13 (사용자 결정 「작업대 제작 화면처럼」): 바깥 틀 하나에 모두 담던 배치를 걷어내고 **따로 떨어진 카드
 * 셋이 한 줄**로 선다 — 작업대 제작 창의 `[제작] [함선 창고] [가방]` 과 같은 결이다. 공유하는 바깥 테두리는 없다.
 *
 * ```
 * ┌ 제목  Lv. 1  +15% ───── [업그레이드] ┐  ┌ 함선 창고 ──────────┐  ┌ 가방 ─────────┐
 * │ ┌ 레일 ┐ ┌ 좌 패널 (가구 내용) ────┐ │  │ 칩 줄               │  │ 칩 줄         │
 * │ │ 목록 │ │                         │ │  │ 창고 격자 (스크롤)  │  │ 가방 격자     │
 * │ └──────┘ └─────────────────────────┘ │  │                     │  │ (스크롤)      │
 * └──────────────────────────────────────┘  └─────────────────────┘  └───────────────┘
 *   메시지 줄 · 안내 ·························································· [닫기]
 * ```
 *
 * - **스테이션 카드**(`.hs-card-station`)가 제목 + `Lv. n` + 부가 글(`meta`, 예: 재배 스테이션의 성장 속도)을 들고,
 *   「업그레이드」 버튼은 **그 카드의** 우상단에 붙는다(화면이 아니라). 레일(스테이션 목록 · 분석기 탭)도 카드 안이다.
 * - **함선 창고 카드**와 **가방 카드**는 따로다 — 카드마다 머리(`.hs-card-head`)와 **자기 세로 스크롤**을 갖는다
 *   (`mountStationGrids` 가 `TradeGrids` 를 카드마다 하나씩, 격자 하나씩 끼운다). 한 스크롤에 두 격자를 세로로 이어
 *   붙이지 않는다는 2026-09-12 규칙이 카드 경계로 저절로 지켜진다.
 * - 격자 칸 크기는 뷰포트로 고른다(`stationGridCell` — 넓으면 54, 아니면 46): 1440 에서도 세 카드가 한 줄에 들어간다.
 *   창 크기가 그 경계를 넘으면 격자를 다시 끼운다. 더 좁으면 CSS 가 스테이션 카드를 위, 두 격자 카드를 아래로 쌓는다.
 *
 * 레일을 쓰지 않는 화면(배양조 · 식탁)에서는 `rail` 이 `hidden` 이라 flex gap 까지 사라진다.
 * `inventory: false` 면 격자 카드를 만들지 않는다(`stashCard` · `bagCard` = null, `invHost` 는 빈 자리).
 */
export interface StationShell {
  /** Header row of the **station card** (title + Lv + meta left, 업그레이드 right). */
  readonly head: HTMLElement;
  readonly title: HTMLElement;
  /** `Lv. n` right of the title (hidden on screens without levels). */
  readonly level: HTMLElement;
  /** Top-right 업그레이드 button of the station card, null when the furniture has no levels (식탁). */
  readonly upBtn: HTMLButtonElement | null;
  /** Body of the station card: `rail` + `left`. */
  readonly body: HTMLElement;
  /** Leftmost vertical rail inside the station card (스테이션 목록 · 탭). Starts `hidden`; a panel that uses it unhides it. */
  readonly rail: HTMLElement;
  readonly left: HTMLElement;
  /** Wrapper of the 함선 창고 + 가방 cards (`.hs-pane-right.hs-inv-cards`). */
  readonly right: HTMLElement;
  /** Host handed to `mountStationGrids` — same element as `right`; it finds the two card hosts inside. */
  readonly invHost: HTMLElement;
  /* appended 2026-09-13 (카드 배치) */
  /** The row of cards (`.hs-cards`) — station card, then `right`. */
  readonly cards: HTMLElement;
  /** The station card (`.hs-card.hs-card-station`). */
  readonly stationCard: HTMLElement;
  /** Small text after `Lv. n` (`.hs-meta`, hidden while empty) — e.g. `성장 속도 +15%`. Set it with `paintStationMeta`. */
  readonly meta: HTMLElement;
  /** 함선 창고 card (`.hs-card-stash`), null with `inventory: false`. */
  readonly stashCard: HTMLElement | null;
  /** 가방 card (`.hs-card-bag`), null with `inventory: false`. */
  readonly bagCard: HTMLElement | null;
  /* appended 2026-09-13 (발전기 전력) */
  /** `비활성화` / `활성화` button left of 업그레이드 (`.hpw-toggle`) — null without the `power` option, hidden for furniture that uses no power. */
  readonly powerBtn: HTMLButtonElement | null;
  /** Banner under the station head (`.hpw-banner`) — `전력 부족 — 시계가 멈췄습니다` / `비활성화됨`, hidden while the piece runs. */
  readonly powerBanner: HTMLElement | null;
  /** The `power` option, kept for `paintStationPower`. */
  readonly power: StationPowerOptions | null;
}

/**
 * appended 2026-09-13 (발전기 전력): which placed piece the screen shows, so the shell can draw its 비활성화 button and the
 * 멈춤 banner. The shell asks `ctx.housing` (duck-typed — the power API is optional in the contract) and never keeps state.
 */
export interface StationPowerOptions {
  ctx: GameContext;
  /** uid of the placed piece on screen; null / '' = none (공유 함선 식탁 · 사라진 가구). */
  uid(): string | null;
}

export interface StationShellOptions {
  /** appended 2026-09-13 (발전기 전력): draws the 비활성화 button + 멈춤 banner (`paintStationLevel` repaints them — `paintStationPower` for screens without levels). */
  power?: StationPowerOptions;
  title: string;
  /** false = no level badge and no 업그레이드 button (식탁). */
  upgrade: boolean;
  onUpgrade?(): void;
  /** The panel's own `button()` (click sound + stopPropagation). */
  button(parent: HTMLElement, label: string, onClick: () => void, cls: string): HTMLButtonElement;
  /** appended 2026-09-13: false = no 함선 창고 / 가방 cards. Default true. */
  inventory?: boolean;
}

/** Which grid a card holds — `data-hs-grid` on the card, read by `mountStationGrids`. */
type CardGrid = 'stash' | 'bag';
const CARD_TITLE: Readonly<Record<CardGrid, string>> = { stash: '함선 창고', bag: '가방' };

function buildInvCard(parent: HTMLElement, id: CardGrid): HTMLElement {
  const card = el('section', { cls: `hs-card hs-card-inv hs-card-${id}`, attrs: { 'data-hs-grid': id }, parent });
  const head = el('div', { cls: 'hs-card-head', parent: card });
  el('div', { cls: 'hs-card-title', text: CARD_TITLE[id], parent: head });
  el('div', { cls: 'hs-inv', parent: card });
  return card;
}

/**
 * Build the card layout into the panel's `.frame`. The frame itself becomes a transparent column (`.hs-station .frame`
 * in `housing.css`): cards row, then whatever the panel appends (message line, footer).
 */
export function buildStationShell(frame: HTMLElement, o: StationShellOptions): StationShell {
  const cards = el('div', { cls: 'hs-cards', parent: frame });
  const stationCard = el('section', { cls: 'hs-card hs-card-station', parent: cards });
  const head = el('div', { cls: 'hs-head hs-station-head', parent: stationCard });
  const hl = el('div', { cls: 'hl', parent: head });
  const title = el('div', { cls: 'title', text: o.title, parent: hl });
  const level = el('div', { cls: 'hs-lv', text: '', parent: hl });
  level.hidden = !o.upgrade;
  const meta = el('div', { cls: 'hs-meta', text: '', parent: hl });
  meta.hidden = true;
  const upBtn = o.upgrade ? o.button(head, '업그레이드', () => o.onUpgrade?.(), 'primary hs-up-open') : null;
  /* 2026-09-13 (발전기 전력): 업그레이드 버튼 **왼쪽**의 비활성화 / 활성화 버튼 + 머리 아래 멈춤 배너 (`paintStationPower`) */
  const power = o.power ?? null;
  let powerBtn: HTMLButtonElement | null = null;
  let powerBanner: HTMLElement | null = null;
  if (power) {
    powerBtn = o.button(head, '비활성화', () => toggleStationPower(power), 'hpw-toggle');
    if (upBtn) head.insertBefore(powerBtn, upBtn);
    powerBtn.hidden = true;
    powerBanner = el('div', { cls: 'hpw-banner', parent: stationCard });
    powerBanner.hidden = true;
  }
  const body = el('div', { cls: 'hs-station-body', parent: stationCard });
  const rail = el('div', { cls: 'hs-rail', parent: body });
  rail.hidden = true;                       // `display: none` → the flex gap next to it disappears too
  const left = el('div', { cls: 'hs-pane hs-pane-left', parent: body });
  const right = el('div', { cls: 'hs-pane-right hs-inv-cards', parent: cards });
  const withInv = o.inventory !== false;
  right.hidden = !withInv;
  // 2026-09-12 (사용자 결정): **함선 창고가 왼쪽, 가방이 오른쪽** — 카드 순서가 곧 그 규칙이다
  const stashCard = withInv ? buildInvCard(right, 'stash') : null;
  const bagCard = withInv ? buildInvCard(right, 'bag') : null;
  return { head, title, level, upBtn, body, rail, left, right, invHost: right, cards, stationCard, meta, stashCard, bagCard, powerBtn, powerBanner, power };
}

/** `Lv. n` + the 업그레이드 button state (`MAX` and disabled at the last level; disabled when the furniture is gone). */
export function paintStationLevel(shell: StationShell, level: number | null, maxLevel: number): void {
  setText(shell.level, level === null ? '' : `Lv. ${level}`);
  const btn = shell.upBtn;
  if (!btn) return;
  const atMax = level !== null && level >= maxLevel;
  btn.disabled = level === null || atMax;
  setText(btn, atMax ? 'MAX' : '업그레이드');
  toggleClass(btn, 'is-max', atMax);
  paintStationPower(shell);                   // 2026-09-13 (발전기 전력): 레벨을 그리는 화면은 전력 줄도 함께 다시 그린다
}

/**
 * appended 2026-09-13 (발전기 전력): the 비활성화 / 활성화 button and the 멈춤 banner of the piece `shell.power.uid()` names.
 * Hidden for furniture that uses no power (or with no `power` option). `paintStationLevel` calls it; screens without levels
 * (식탁 · 서재 보관함) call it from their `refresh`. Reads `ctx.housing` duck-typed — the power API is optional in the contract.
 */
export function paintStationPower(shell: StationShell): void {
  const p = shell.power, btn = shell.powerBtn, banner = shell.powerBanner;
  if (!p || !btn || !banner) return;
  const h = p.ctx.housing;
  const uid = p.uid() || '';
  const item = uid && h ? h.getPlacedByUid(uid) : null;
  const facility = item && h && typeof h.getFacilityPower === 'function' ? h.getFacilityPower(item.room) : null;
  const info = facility?.furniture.find((f) => f.uid === uid) ?? null;
  btn.hidden = !info;
  if (!info || !h) { banner.hidden = true; return; }
  setText(btn, info.disabled ? '활성화' : '비활성화');
  toggleClass(btn, 'is-off', info.disabled);
  btn.title = `요구 전력 ${info.demand}${info.disabled ? ' — 활성화하면 시설 요구 전력에 다시 더해집니다' : ' — 비활성화하면 시설 요구 전력에서 빠지고 작동을 멈춥니다'}`;
  const block = typeof h.furnitureOperationalBlock === 'function' ? h.furnitureOperationalBlock(uid) : info.block;
  const text = !block ? ''
    : block === FURNITURE_DISABLED_REASON_KO ? '비활성화됨 — 시계가 멈췄습니다'
    : block === POWER_SHORT_REASON_KO && facility ? `전력 부족 — 시계가 멈췄습니다 (시설 요구 ${facility.required} · 할당 ${facility.allocated})`
    : block;
  setText(banner, text);
  banner.hidden = !text;
  toggleClass(banner, 'is-disabled', block === FURNITURE_DISABLED_REASON_KO);
}

function toggleStationPower(p: StationPowerOptions): void {
  const h = p.ctx.housing;
  const uid = p.uid();
  if (!h || !uid || typeof h.setFurnitureDisabled !== 'function') return;
  const off = h.isFurnitureDisabled?.(uid) === true;
  const reason = h.setFurnitureDisabled(uid, !off);
  if (reason) {
    p.ctx.bus.emit('audio:play', { id: 'ui_deny' });
    p.ctx.bus.emit('ui:notify', { text: reason, kind: 'warning' });
    return;
  }
  p.ctx.bus.emit('ui:notify', { text: off ? '가구를 활성화했습니다' : '가구를 비활성화했습니다 — 시설 요구 전력에서 빠집니다', kind: 'info' });
}

/** appended 2026-09-13: the small text after `Lv. n` (empty string hides it). */
export function paintStationMeta(shell: StationShell, text: string): void {
  setText(shell.meta, text);
  shell.meta.hidden = !text;
}

/**
 * Grid cell edge for the station cards (px). Three cards must stand in one row at 1440 px: at 54 px the 함선 창고 card
 * alone is ~630 px wide, so below `STATION_WIDE_VIEWPORT` the grids use a 46 px cell (the 기업 거래 desk shrinks its
 * grids the same way, `TradeGridsViewOptions.cell`). Layout constant, not a balance number.
 */
const STATION_WIDE_VIEWPORT = 1760;
export function stationGridCell(viewportWidth = window.innerWidth): number {
  return viewportWidth >= STATION_WIDE_VIEWPORT ? 54 : 46;
}

/**
 * The 함선 창고 / 가방 grids are built **lazily**: housing/ is registered before inventory/, so `ctx.inventory` does not
 * exist yet when a panel is constructed. Null when the inventory cannot render them.
 *
 * 2026-09-13: `host` = `shell.invHost` → one `TradeGrids` **per card, one grid each** (`grids: ['stash']` ·
 * `grids: ['bag']`), same `dropSelector` / `onTake`, cell from `stationGridCell` (re-mounted when a window resize crosses
 * the breakpoint). Any other host (an old caller) still gets the single two-grid view it used to.
 */
export function mountStationGrids(
  ctx: GameContext,
  host: HTMLElement,
  dropSelector: string,
  onTake: (item: ItemInstance, target: HTMLElement | null) => void,
): EmbeddedView | null {
  const inv = ctx.inventory;
  if (!inv || typeof inv.createTradeGrids !== 'function') return null;
  const cardHosts: Array<{ id: CardGrid; host: HTMLElement }> = [];
  for (const id of ['stash', 'bag'] as const) {
    const h = host.querySelector<HTMLElement>(`[data-hs-grid="${id}"] .hs-inv`);
    if (h) cardHosts.push({ id, host: h });
  }
  if (!cardHosts.length) {
    return inv.createTradeGrids(host, { grids: ['stash', 'bag'], dropSelector, onTake: (item, _g, target) => onTake(item, target) });
  }
  return new StationGrids(ctx, cardHosts, dropSelector, onTake);
}

/**
 * Two single-grid `TradeGrids`, one per card, behind one `EmbeddedView`. Uses the inventory's card API (2026-09-13,
 * `src/inventory/README.md` 「카드마다 격자 하나」): `layout: 'split'` (the block stretches to the card and its grid
 * scrolls itself) + `chips: 'block'` (each card its own filter row — the bag's narrow row wraps to two lines), and a
 * resize across the breakpoint calls `setCell` on the live views (keeps filter and scroll) instead of re-mounting.
 */
class StationGrids implements EmbeddedView {
  private views: EmbeddedView[] = [];
  private cell = 0;
  private disposed = false;
  private readonly onResize = (): void => {
    const next = stationGridCell();
    if (this.disposed || next === this.cell) return;
    this.cell = next;
    for (const v of this.views) {
      const live = v as Partial<TradeGridsView>;
      if (typeof live.setCell === 'function') live.setCell(next);
      else { this.mount(); return; }        // an older inventory without `setCell` — rebuild at the new edge
    }
  };

  constructor(
    private readonly ctx: GameContext,
    private readonly hosts: ReadonlyArray<{ id: CardGrid; host: HTMLElement }>,
    private readonly dropSelector: string,
    private readonly onTake: (item: ItemInstance, target: HTMLElement | null) => void,
  ) {
    this.mount();
    window.addEventListener('resize', this.onResize);
  }

  private mount(): void {
    const inv = this.ctx.inventory;
    for (const v of this.views) v.dispose();
    this.views = [];
    if (!inv || typeof inv.createTradeGrids !== 'function') return;
    this.cell = stationGridCell();
    for (const { id, host } of this.hosts) {
      this.views.push(inv.createTradeGrids(host, {
        grids: [id],
        layout: 'split',
        chips: 'block',
        dropSelector: this.dropSelector,
        onTake: (item, _g, target) => this.onTake(item, target),
        cell: this.cell,
        className: 'hs-tg',
      }));
    }
  }

  refresh(): void { for (const v of this.views) v.refresh(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    for (const v of this.views) v.dispose();
    this.views = [];
  }
}
