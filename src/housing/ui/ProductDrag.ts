import type { HarvestDestination, ItemDef } from '@/shared';
import { buildItemGridChip, itemGridBox } from '@/shared';
import { withDropCell } from '../parts/Deliver';
import { stationGridCell } from './StationShell';
import type { StationGridsView } from './StationShell';
import { el } from './dom';

/** A finished product sitting in a station 칸 (다 자란 작물 · 해석 산출물 · 배양 산물). */
export interface Product {
  /** The panel's own id of the 칸 (`tier:slot` · `slot`). */
  key: string;
  defId: string;
  qty: number;
}

export interface ProductDragOptions {
  /** The finished product under `target`, or null (not ready / not a 칸). */
  productAt(target: Element): Product | null;
  /** Collect the 칸 — dropped on a grid (`'bag'` / `'stash'`) or double-clicked (`'stash-first'`). */
  collect(key: string, dest: HarvestDestination): void;
  defOf(defId: string): ItemDef | undefined;
  /**
   * 2026-09-16 (사용자 보고 「끌어서 뺀 것은 **커서가 놓인 칸**으로 가야 한다」) — 이 화면의 창고 · 가방 격자
   * (`mountStationGrids` 가 준 뷰). 주면 놓은 좌표가 그 칸으로 간다 (`parts/Deliver.withDropCell`); 주지 않으면
   * 예전처럼 첫 빈 칸이다. 격자는 화면이 열릴 때 늦게 만들어지므로 **값이 아니라 함수**로 받는다.
   */
  grids?(): StationGridsView | null;
  /** A drag really started (the panel hides its hover card). */
  onDragStart?(): void;
  /**
   * 2026-09-16 — 고스트가 쓸 격자 칸 한 변(px). 기본은 스테이션 화면의 격자와 같은 `stationGridCell()` 이라
   * 놓을 곳(창고 · 가방 격자)과 끌고 있는 것의 크기가 한 화면 안에서 맞는다. 다른 칸을 쓰는 화면만 넘긴다.
   */
  cellPx?(): number;
}

const THRESHOLD_PX = 5;

/**
 * **다 된 것을 아이템처럼 옮긴다** (2026-09-12) — 수확 버튼 · 모두 수확을 걷어낸 자리.
 *
 * - **더블클릭** → 함선 창고 먼저, 가득이면 가방 (`'stash-first'`, 사용자 결정 — 함선 안이다).
 * - **끌어서 가방 / 함선 창고 격자에 놓기** → 그 격자에만 (`closest('[data-tg-grid]')` — `inventory/ui/TradeGrids`
 *   가 블록에 찍는 속성). 다른 곳에 놓으면 아무 일도 없다.
 *
 * 성능 규약 (재배 화면 드래그 렉): `pointermove` 는 좌표만 적고, 고스트 `transform` 과 격자 강조
 * (`elementFromPoint`)는 **rAF 에 한 번**이다. 놓을 때의 판정은 `pointerup` 좌표로 다시 잰다 — rAF 가 멈춘
 * 헤드리스에서도 결과가 같다.
 */
export class ProductDrag {
  private press: { p: Product; x0: number; y0: number; x: number; y: number } | null = null;
  private ghost: HTMLElement | null = null;
  /** 고스트 상자의 반폭 · 반높이 (px) — 커서가 늘 그 한가운데다. 발자국이 정사각형이 아니므로 둘을 따로 잰다. */
  private halfW = 0;
  private halfH = 0;
  private over: HTMLElement | null = null;
  private raf = 0;

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const p = this.o.productAt(e.target);
    if (!p) return;
    this.end();
    this.press = { p, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY };
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
  };

  private readonly onMove = (e: PointerEvent): void => {
    const s = this.press;
    if (!s) return;
    s.x = e.clientX; s.y = e.clientY;
    if (!this.ghost) {
      if (Math.hypot(s.x - s.x0, s.y - s.y0) < THRESHOLD_PX) return;
      this.startGhost(s.p);
    }
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  };

  private readonly frame = (): void => {
    this.raf = 0;
    const s = this.press;
    if (!s || !this.ghost) return;
    this.placeGhost(s.x, s.y);
    this.setOver(this.gridAt(s.x, s.y));
  };

  private readonly onUp = (e: PointerEvent): void => {
    const s = this.press;
    const dragged = !!this.ghost;
    const target = dragged ? this.gridAt(e.clientX, e.clientY) : null;
    this.end();
    if (!s || !target) return;
    const dest: HarvestDestination = target.dataset.tgGrid === 'bag' ? 'bag' : 'stash';
    /* 2026-09-16: 놓은 **칸**이 곧 결과다 — 좌표를 `Deliver` 에 한 번 적어 두고 규칙 함수를 부른다. 규칙이
       아이템을 건네는 그 한 번만 그 칸으로 가고(막힌 칸이면 거절), 격자 밖이면 예전 규칙 그대로다. */
    const view = this.o.grids?.() ?? null;
    if (!view) { this.o.collect(s.p.key, dest); return; }
    withDropCell({ view, x: e.clientX, y: e.clientY }, () => this.o.collect(s.p.key, dest));
  };

  private readonly onDbl = (e: MouseEvent): void => {
    if (!(e.target instanceof Element)) return;
    const p = this.o.productAt(e.target);
    if (p) this.o.collect(p.key, 'stash-first');
  };

  constructor(private readonly host: HTMLElement, private readonly o: ProductDragOptions) {
    host.addEventListener('pointerdown', this.onDown);
    host.addEventListener('dblclick', this.onDbl);
  }

  get dragging(): boolean { return !!this.ghost; }

  /**
   * 2026-09-16 (버그: 재배 스테이션 · 전시대에서 끌면 격자 크기가 유지되지 않았다) — 고스트는 가방에서 끌 때와 **같은
   * 발자국**이다: 아이템의 `width × height` 칸을 격자 칸 크기(`cellPx`)로 잰 상자(`itemGridBox`). 예전에는 발자국과
   * 무관한 정사각형 칩 하나였다. 크기 식은 인벤토리 격자(`tileSizeAt`)와 같은 것을 `shared/itemChip` 이 갖는다.
   */
  private startGhost(p: Product): void {
    const def = this.o.defOf(p.defId);
    const cell = this.o.cellPx?.() ?? stationGridCell();
    const box = itemGridBox(def?.width ?? 1, def?.height ?? 1, cell);
    this.halfW = box.width / 2;
    this.halfH = box.height / 2;
    const g = el('div', { cls: 'hs-ghost' });
    g.appendChild(buildItemGridChip(def, { cell, have: p.qty }));
    document.body.appendChild(g);
    this.ghost = g;
    this.placeGhost(this.press?.x ?? 0, this.press?.y ?? 0);
    this.o.onDragStart?.();
  }

  private placeGhost(x: number, y: number): void {
    if (this.ghost) this.ghost.style.transform = `translate(${Math.round(x - this.halfW)}px, ${Math.round(y - this.halfH)}px)`;
  }

  private gridAt(x: number, y: number): HTMLElement | null {
    const under = document.elementFromPoint(x, y);
    return under?.closest<HTMLElement>('[data-tg-grid]') ?? null;
  }

  private setOver(t: HTMLElement | null): void {
    if (this.over === t) return;
    this.over?.classList.remove('hs-drop-over');
    this.over = t;
    t?.classList.add('hs-drop-over');
  }

  /** Cancel whatever is in flight (the panel calls this on close). */
  end(): void {
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.ghost?.remove();
    this.ghost = null;
    this.setOver(null);
    this.press = null;
  }

  dispose(): void {
    this.end();
    this.host.removeEventListener('pointerdown', this.onDown);
    this.host.removeEventListener('dblclick', this.onDbl);
  }
}
