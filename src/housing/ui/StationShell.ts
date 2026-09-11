import type { EmbeddedView, GameContext, ItemInstance } from '@/shared';
import { el, setText, toggleClass } from './dom';

/**
 * **가구 화면 공통 틀** (2026-09-12) — 재배 스테이션 · 분석기 · 배양조 · 식탁이 같은 뼈대를 쓴다.
 *
 * ```
 * ┌ 제목  Lv. 1 ────────────────────────────────────────── [업그레이드] ┐
 * │ ┌ 레일 ┐ ┌ 좌 패널 (가구 내용) ────────┐ ┌ 우 패널 ───────────────┐ │
 * │ │ 목록 │ │                             │ │ 가방 · 함선 창고 격자   │ │
 * │ └──────┘ └─────────────────────────────┘ └────────────────────────┘ │
 * └────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * 제목 옆에는 방 번호가 없고, 제목 밑의 설명 줄 · 「가방 · 함선 창고」 라벨 · 안내문도 없다 (사용자 결정).
 * 업그레이드는 머리줄 오른쪽 버튼 하나가 `UpgradeModal` 을 연다 — 옛 「강화 줄」을 대신한다.
 *
 * **맨 왼쪽 레일** (2026-09-12): 화면이 여러 대상 · 여러 페이지를 가질 때 그것을 고르는 세로 줄이 **늘 같은 자리**에
 * 선다 — 재배 스테이션 목록(3×3 현황 점 + 레드닷)과 분석기의 「해석 / 해석 도감」 탭이 그것이다. 쓰지 않는 화면
 * (배양조 · 식탁)에서는 `hidden` 이라 flex gap 까지 함께 사라진다.
 */
export interface StationShell {
  readonly head: HTMLElement;
  readonly title: HTMLElement;
  /** `Lv. n` right of the title (hidden on screens without levels). */
  readonly level: HTMLElement;
  /** Top-right 업그레이드 button, null when the furniture has no levels (식탁). */
  readonly upBtn: HTMLButtonElement | null;
  readonly body: HTMLElement;
  /** Leftmost vertical rail (스테이션 목록 · 탭). Starts `hidden`; a panel that uses it unhides it. */
  readonly rail: HTMLElement;
  readonly left: HTMLElement;
  readonly right: HTMLElement;
  /** Host of the embedded 가방 / 함선 창고 grids (`mountStationGrids`). */
  readonly invHost: HTMLElement;
}

export interface StationShellOptions {
  title: string;
  /** false = no level badge and no 업그레이드 button (식탁). */
  upgrade: boolean;
  onUpgrade?(): void;
  /** The panel's own `button()` (click sound + stopPropagation). */
  button(parent: HTMLElement, label: string, onClick: () => void, cls: string): HTMLButtonElement;
}

export function buildStationShell(frame: HTMLElement, o: StationShellOptions): StationShell {
  const head = el('div', { cls: 'hs-head hs-station-head', parent: frame });
  const hl = el('div', { cls: 'hl', parent: head });
  const title = el('div', { cls: 'title', text: o.title, parent: hl });
  const level = el('div', { cls: 'hs-lv', text: '', parent: hl });
  level.hidden = !o.upgrade;
  const upBtn = o.upgrade ? o.button(head, '업그레이드', () => o.onUpgrade?.(), 'primary hs-up-open') : null;
  const body = el('div', { cls: 'hs-station-body', parent: frame });
  const rail = el('div', { cls: 'hs-rail', parent: body });
  rail.hidden = true;                       // `display: none` → the flex gap next to it disappears too
  const left = el('div', { cls: 'hs-pane hs-pane-left', parent: body });
  const right = el('div', { cls: 'hs-pane hs-pane-right', parent: body });
  const invHost = el('div', { cls: 'hs-inv', parent: right });
  return { head, title, level, upBtn, body, rail, left, right, invHost };
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

/**
 * The 가방 / 함선 창고 grids are built **lazily**: housing/ is registered before inventory/, so `ctx.inventory` does not
 * exist yet when a panel is constructed. Null when the inventory cannot render them.
 */
export function mountStationGrids(
  ctx: GameContext,
  host: HTMLElement,
  dropSelector: string,
  onTake: (item: ItemInstance, target: HTMLElement | null) => void,
): EmbeddedView | null {
  const inv = ctx.inventory;
  if (!inv || typeof inv.createTradeGrids !== 'function') return null;
  return inv.createTradeGrids(host, {
    /* 2026-09-12 (사용자 결정): **함선 창고가 왼쪽, 내 가방이 오른쪽**. 이것은 `createTradeGrids` 의 기본 순서와
     * 같으므로 사실 생략해도 되지만, 스테이션 4종이 이 한 줄을 공유한다는 것을 눈에 보이게 남긴다 — 예전에는
     * 여기서 `['bag','stash']` 를 **명시로 덮어써서** 기업 화면(기본값)과 스테이션의 좌우가 서로 반대였다. */
    grids: ['stash', 'bag'],
    dropSelector,
    onTake: (item, _gridId, target) => onTake(item, target),
  });
}
