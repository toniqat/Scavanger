import type { HarvestDestination, ItemDef } from '@/shared';
import { buildItemChip } from '@/shared';
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
  /** A drag really started (the panel hides its hover card). */
  onDragStart?(): void;
}

const THRESHOLD_PX = 5;
const GHOST_PX = 54;

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
    this.o.collect(s.p.key, target.dataset.tgGrid === 'bag' ? 'bag' : 'stash');
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

  private startGhost(p: Product): void {
    const g = el('div', { cls: 'hs-ghost' });
    g.appendChild(buildItemChip(this.o.defOf(p.defId), { size: GHOST_PX, have: p.qty }));
    document.body.appendChild(g);
    this.ghost = g;
    this.placeGhost(this.press?.x ?? 0, this.press?.y ?? 0);
    this.o.onDragStart?.();
  }

  private placeGhost(x: number, y: number): void {
    if (this.ghost) this.ghost.style.transform = `translate(${Math.round(x - GHOST_PX / 2)}px, ${Math.round(y - GHOST_PX / 2)}px)`;
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
