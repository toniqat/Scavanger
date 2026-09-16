import type { EmbeddedView, GameContext, ItemInstance, TradeGridsView } from '@/shared';
import { el, setText, toggleClass } from './dom';

/**
 * **가구 화면 공통 틀** (2026-09-12 · 카드 배치 2026-09-13) — 재배 스테이션 · 분석기 · 배양조 · 식탁(그리고 서재)이 같은
 * 뼈대를 쓴다.
 *
 * 2026-09-13 (사용자 결정 「작업대 제작 화면처럼」): 바깥 틀 하나에 모두 담던 배치를 걷어내고 **따로 떨어진 카드
 * 셋이 한 줄**로 선다 — 작업대 제작 창의 `[제작] [함선 창고] [가방]` 과 같은 결이다. 공유하는 바깥 테두리는 없다.
 *
 * ```
 * ┌ 제목  Lv. 1  +15% ───── [업그레이드] ┐  ┌ 창고 · 가방 ────────────────────┐
 * │ ┌ 레일 ┐ ┌ 좌 패널 (가구 내용) ────┐ │  │ 창고 격자(스크롤) │ 내 가방(스크롤) │
 * │ │ 목록 │ │                         │ │  │ 정렬 · 필터       │ 정렬 · 필터     │
 * │ └──────┘ └─────────────────────────┘ │  │                   │                 │
 * └──────────────────────────────────────┘  └─────────────────────────────────────┘
 *   메시지 줄 · 안내 ·························································· [닫기]
 * ```
 *
 * - **스테이션 카드**(`.hs-card-station`)가 제목 + `Lv. n` + 부가 글(`meta`, 예: 재배 스테이션의 성장 속도)을 들고,
 *   「업그레이드」 버튼은 **그 카드의** 우상단에 붙는다(화면이 아니라). 레일(스테이션 목록 · 분석기 탭)도 카드 안이다.
 * - **2026-09-15 3차 (사용자 결정 — 창고 + 가방은 한 패널이다)**: 격자 카드는 **하나**(`.hs-card-inv`)이고 그 안에서
 *   `TradeGrids` 가 왼쪽 창고 · 오른쪽 내 가방을 **칸마다 자기 스크롤 · 자기 정렬 · 자기 필터**로 그린다
 *   (`mountStationGrids` 가 `createTradeGrids` 를 **한 번**만 부른다). 옛 배치는 카드마다 한 번씩 **두 번** 불러
 *   카드가 둘이었다 — 인벤토리가 2026-09-15 2차에 한 패널로 바뀌면서 그 갈래가 사라졌다. 카드 머리(`.hs-card-head`)도
 *   같이 없앴다: 이름은 격자 블록이 스스로 말한다(창고는 그림이, 가방은 `내 가방` 라벨이).
 * - 격자 칸 크기는 뷰포트로 고른다(`stationGridCell` — 넓으면 54, 아니면 46): 1440 에서도 카드 둘이 한 줄에 들어간다.
 *   창 크기가 그 경계를 넘으면 살아 있는 뷰에 `setCell` 을 건다. 더 좁으면 CSS 가 스테이션 카드를 위, 격자 카드를 아래로 쌓는다.
 *
 * 레일을 쓰지 않는 화면(배양조 · 식탁)에서는 `rail` 이 `hidden` 이라 flex gap 까지 사라진다.
 * `inventory: false` 면 격자 카드를 만들지 않는다(`invCard` = null, `invHost` 는 빈 자리).
 *
 * 2026-09-13 (같은 날, 사용자 결정 「전력 할당 시스템 제거」): 업그레이드 왼쪽의 비활성화 버튼 · 멈춤 배너(`power` 옵션 ·
 * `paintStationPower` · `.hpw-`)를 걷어냈다 — 가구는 멈추지 않는다.
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
  /**
   * appended 2026-09-15 3차: the **one** 창고 + 가방 card (`.hs-card-inv`), null with `inventory: false`.
   * `TradeGrids` draws both grids inside it.
   */
  readonly invCard: HTMLElement | null;
  /** @deprecated 2026-09-15 3차 — 카드가 하나가 됐다. `invCard` 와 같은 요소다 (이름만 남긴다). */
  readonly stashCard: HTMLElement | null;
  /** @deprecated 2026-09-15 3차 — `invCard` 와 같은 요소다. */
  readonly bagCard: HTMLElement | null;
  /* appended 2026-09-14 (서재 화면 개편) */
  /**
   * 좌 패널 **맨 위의 가로 탭 줄** (`.hs-tabs`), `tabs: true` 일 때만 만들어진다 — 옵션이라 옛 화면(분석기 · 재배 ·
   * 조리대 · 채굴)은 한 줄도 바뀌지 않는다. 레일(`rail`)이 목록이 되면 탭이 갈 곳이 여기다.
   */
  readonly tabsRow: HTMLElement | null;
}

export interface StationShellOptions {
  title: string;
  /** false = no level badge and no 업그레이드 button (식탁). */
  upgrade: boolean;
  onUpgrade?(): void;
  /** The panel's own `button()` (click sound + stopPropagation). */
  button(parent: HTMLElement, label: string, onClick: () => void, cls: string): HTMLButtonElement;
  /** appended 2026-09-13: false = no 함선 창고 / 가방 cards. Default true. */
  inventory?: boolean;
  /** appended 2026-09-14: true = a horizontal tab row at the top of the left pane (`shell.tabsRow`). Default false. */
  tabs?: boolean;
}

/**
 * 2026-09-15 3차: 격자 카드는 **하나**다 (`.hs-card-inv` > `.hs-inv`). 머리줄이 없다 — 창고 · 가방의 이름은
 * `TradeGrids` 블록이 스스로 말한다. `data-hs-grid="inv"` 는 `mountStationGrids` 가 호스트를 찾는 손잡이다.
 */
function buildInvCard(parent: HTMLElement): HTMLElement {
  const card = el('section', { cls: 'hs-card hs-card-inv', attrs: { 'data-hs-grid': 'inv' }, parent });
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
  const body = el('div', { cls: 'hs-station-body', parent: stationCard });
  const rail = el('div', { cls: 'hs-rail', parent: body });
  rail.hidden = true;                       // `display: none` → the flex gap next to it disappears too
  const left = el('div', { cls: 'hs-pane hs-pane-left', parent: body });
  const tabsRow = o.tabs ? el('div', { cls: 'hs-tabs', parent: left }) : null;
  const right = el('div', { cls: 'hs-pane-right hs-inv-cards', parent: cards });
  const withInv = o.inventory !== false;
  right.hidden = !withInv;
  // 2026-09-12 (사용자 결정): **함선 창고가 왼쪽, 가방이 오른쪽** — 2026-09-15 3차부터 그 순서는 `TradeGrids` 의
  // `grids: ['stash','bag']` 이 지킨다 (카드는 하나다)
  const invCard = withInv ? buildInvCard(right) : null;
  return {
    head, title, level, upBtn, body, rail, left, right, invHost: right, cards, stationCard, meta,
    invCard, stashCard: invCard, bagCard: invCard, tabsRow,
  };
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
 * **2026-09-15 3차 (사용자 결정 — 창고 + 가방은 한 패널이다)**: `createTradeGrids` 를 **한 번**만 부른다
 * (`grids: ['stash','bag']`). 인벤토리가 그 한 패널 안에서 왼쪽 창고 · 오른쪽 내 가방을 칸마다 자기 스크롤 · 자기
 * 정렬 · 자기 필터로 그린다. 옛 배치(카드마다 한 번씩 두 번)는 카드가 둘로 갈렸다 — 그 갈래가 없어졌다.
 * 격자 칸은 `stationGridCell()` 이고, 창 크기가 경계를 넘으면 **뷰를 다시 짓지 않고** `setCell` 을 건다(필터 · 스크롤 유지).
 */
export function mountStationGrids(
  ctx: GameContext,
  host: HTMLElement,
  dropSelector: string,
  onTake: (item: ItemInstance, target: HTMLElement | null) => void,
): StationGridsView | null {
  const inv = ctx.inventory;
  if (!inv || typeof inv.createTradeGrids !== 'function') return null;
  // `shell.invHost`(= `right`) 안의 격자 카드. 카드가 없는 호스트를 넘긴 화면은 그 호스트에 그대로 그린다.
  const gridHost = host.querySelector<HTMLElement>('.hs-card-inv .hs-inv') ?? host;
  return new StationGrids(ctx, gridHost, dropSelector, onTake);
}

/**
 * One `TradeGrids`(창고 + 가방) behind one `EmbeddedView`, plus the viewport-driven cell size.
 * `layout: 'split'` · `chips: 'block'` 은 2026-09-15 2차부터 인벤토리의 **유일한** 배치라 값은 그대로 두었다 —
 * 이름을 남겨 두는 편이 「이 화면이 무엇을 기대하는가」를 말해 준다.
 */
/**
 * 2026-09-16 (사용자 보고 「끌어서 뺀 것이 커서가 놓인 칸으로 가야 한다」): 가구 화면이 이 뷰에 묻는 한 가지가
 * 더 생겼다 — **커서 밑의 칸**. 답은 인벤토리의 `TradeGridsView.placeExternalAt` 이고 여기는 그대로 넘긴다
 * (그 판정은 격자를 그리는 쪽만 할 수 있다: 칸 크기 · 스크롤 위치 · 두 격자의 경계).
 */
export interface StationGridsView extends EmbeddedView {
  /** 격자 밖에서 온 아이템을 `x, y` 밑의 칸에 놓는다 — `'blocked'` = 그 칸이 받지 못한다, null = 격자 밖이다. */
  placeExternalAt(item: ItemInstance, x: number, y: number): 'bag' | 'stash' | 'blocked' | null;
  /**
   * 2026-09-17: 끄는 동안 커서 밑 **칸**의 발자국 강조 (`TradeGridsView.previewExternalAt`). null = 격자 밖이거나
   * 옛 인벤토리 — 부른 쪽은 강조하지 않는다.
   */
  previewExternalAt(defId: string, qty: number, x: number, y: number): 'ok' | 'merge' | 'bad' | null;
  /** false = 이 인벤토리에는 칸 미리보기가 없다 (부른 쪽이 옛 「격자 통째 강조」로 떨어진다). */
  readonly canPreview: boolean;
  clearExternalPreview(): void;
}

class StationGrids implements StationGridsView {
  private view: EmbeddedView | null = null;
  private cell = 0;
  private disposed = false;
  private readonly onResize = (): void => {
    const next = stationGridCell();
    if (this.disposed || next === this.cell || !this.view) return;
    this.cell = next;
    const live = this.view as Partial<TradeGridsView>;
    if (typeof live.setCell === 'function') live.setCell(next);
    else this.mount();                      // an older inventory without `setCell` — rebuild at the new edge
  };

  constructor(
    private readonly ctx: GameContext,
    private readonly host: HTMLElement,
    private readonly dropSelector: string,
    private readonly onTake: (item: ItemInstance, target: HTMLElement | null) => void,
  ) {
    this.mount();
    window.addEventListener('resize', this.onResize);
  }

  private mount(): void {
    const inv = this.ctx.inventory;
    this.view?.dispose();
    this.view = null;
    if (!inv || typeof inv.createTradeGrids !== 'function') return;
    this.cell = stationGridCell();
    this.view = inv.createTradeGrids(this.host, {
      grids: ['stash', 'bag'],
      layout: 'split',
      chips: 'block',
      dropSelector: this.dropSelector,
      onTake: (item, _g, target) => this.onTake(item, target),
      cell: this.cell,
      className: 'hs-tg',
    });
  }

  refresh(): void { this.view?.refresh(); }

  /** 인벤토리가 없거나(부팅 순서) 옛 뷰면 null — 부른 쪽은 자기 규칙(가방 먼저 · 창고 먼저)으로 넣는다. */
  placeExternalAt(item: ItemInstance, x: number, y: number): 'bag' | 'stash' | 'blocked' | null {
    const live = this.view as Partial<TradeGridsView> | null;
    return live && typeof live.placeExternalAt === 'function' ? live.placeExternalAt(item, x, y) : null;
  }

  get canPreview(): boolean {
    return typeof (this.view as Partial<TradeGridsView> | null)?.previewExternalAt === 'function';
  }

  previewExternalAt(defId: string, qty: number, x: number, y: number): 'ok' | 'merge' | 'bad' | null {
    const live = this.view as Partial<TradeGridsView> | null;
    return live && typeof live.previewExternalAt === 'function' ? live.previewExternalAt(defId, qty, x, y) : null;
  }

  clearExternalPreview(): void {
    (this.view as Partial<TradeGridsView> | null)?.clearExternalPreview?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    this.view?.dispose();
    this.view = null;
  }
}
