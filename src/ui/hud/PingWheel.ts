import { PING_HOLD_KINDS, PING_HOLD_LABEL_KO } from '@/shared';
import '../styles/wheels.css';
import { el, setText, toggleClass } from '../dom';

/** SVG geometry (viewBox units = px) — a flatter, wider ring than the 4칸 휠: only 좌/우 가 있다. */
const SIZE = 240;
const R_IN = 54;
const R_OUT = 108;
const SECTOR_GAP_DEG = 6;
const LABEL_RADIUS = (R_IN + R_OUT) / 2;

/** Which side is showing / hovered. `ammo` is the 아래로 드래그 leg, not a wheel sector. */
export type PingSide = 'left' | 'right';
/** The four `PingKind`s the hold gesture can place — derived from the contract table, never re-typed by hand. */
export type PingHoldKind = (typeof PING_HOLD_KINDS)[keyof typeof PING_HOLD_KINDS][PingSide];

const SIDE_DEG: Record<PingSide, number> = { left: 270, right: 90 };
const COLOR: Record<string, string> = {
  caution: '#ffc23a', attack: '#ff6a3d', help: '#ff4d4d', abandon: '#8a929c',
};

/** Annular sector path; angles in degrees, 0 = up, clockwise. */
function sectorPath(a0: number, a1: number): string {
  const c = SIZE / 2;
  const pt = (r: number, a: number): string => {
    const t = ((a - 90) * Math.PI) / 180;
    return `${(c + r * Math.cos(t)).toFixed(2)} ${(c + r * Math.sin(t)).toFixed(2)}`;
  };
  return `M${pt(R_OUT, a0)} A${R_OUT} ${R_OUT} 0 0 1 ${pt(R_OUT, a1)} L${pt(R_IN, a1)} A${R_IN} ${R_IN} 0 0 0 ${pt(R_IN, a0)} Z`;
}

interface Sector { arc: SVGPathElement; root: HTMLElement; nm: HTMLElement }

/**
 * **지역 핑 홀드 휠 (`.pwheel`, 2026-09-09).** 순수 표현 위젯이다 — 제스처는 그대로 `hud/Pings` 가 본다
 * (`PING_HOLD_MAX` · `PING_DRAG_THRESHOLD_PX` · 누른 시점의 조준 광선까지 v2 그대로), 이 클래스는 `setOpen` /
 * `setHover` 로 그 상태를 그린다. 2026-09-09 이전의 한 줄짜리 `.ping-hint` (`◄ 주의 · 돌격 ► · ▼ 탄약`)를 대신한다.
 *
 * **좌/우 두 칸의 뜻은 로컬 플레이어의 상태가 정한다** (`shared/comms.ts` 의 `PING_HOLD_KINDS`):
 * 서 있을 때 좌 = 여기 조심해(`caution`) · 우 = 저쪽으로 가자(`attack`), **전투불능이면** 좌 = 살려줘(`help`) ·
 * 우 = 나를 버려(`abandon`). 라벨은 `PING_HOLD_LABEL_KO`, 색은 `hud/Pings` 의 `PING_COLOR` 와 같은 값이다.
 * 서 있을 때만 아래쪽에 **`▼ 탄약`** 다리(`.ammo-leg`)가 붙는다 — 전투불능 플레이어는 총을 못 쏘므로
 * 탄약을 부탁할 이유가 없어 그 제스처가 아예 사라진다 (그때 아래 드래그는 그냥 평범한 핑이다).
 *
 * 휠은 `pointer-events:none` 오버레이이고 blocker · ESC 스택 · 포인터 락 어디에도 손대지 않는다.
 */
export class PingWheel {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private items: HTMLElement;
  private ammoLeg: HTMLElement;
  private sectors: Record<PingSide, Sector>;
  private open = false;
  private downed = false;
  private hover: PingSide | 'ammo' | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'pwheel', parent });
    const svgNS = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(svgNS, 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    this.svg.setAttribute('class', 'ring');
    this.root.appendChild(this.svg);
    this.items = el('div', { cls: 'items', parent: this.root });

    const make = (side: PingSide): Sector => {
      const a = SIDE_DEG[side];
      const arc = document.createElementNS(svgNS, 'path');
      arc.setAttribute('class', 'parc');
      arc.setAttribute('d', sectorPath(a - 90 + SECTOR_GAP_DEG / 2, a + 90 - SECTOR_GAP_DEG / 2));
      this.svg.appendChild(arc);
      const t = ((a - 90) * Math.PI) / 180;
      const root = el('div', { cls: `psector ${side}`, parent: this.items });
      root.style.left = `${(50 + (LABEL_RADIUS * Math.cos(t) * 100) / SIZE).toFixed(2)}%`;
      root.style.top = `${(50 + (LABEL_RADIUS * Math.sin(t) * 100) / SIZE).toFixed(2)}%`;
      el('span', { cls: 'ar', text: side === 'left' ? '◄' : '►', parent: root });
      const nm = el('span', { cls: 'nm', text: '', parent: root });
      return { arc, root, nm };
    };
    this.sectors = { left: make('left'), right: make('right') };

    this.ammoLeg = el('div', { cls: 'ammo-leg', parent: this.root });
    el('span', { cls: 'ar', text: '▼', parent: this.ammoLeg });
    el('span', { cls: 'nm', text: '탄약', parent: this.ammoLeg });

    this.applyLabels();
  }

  get isOpen(): boolean { return this.open; }
  get isDowned(): boolean { return this.downed; }
  /** Kind the given side would place right now (`hud/Pings` reads the same table). */
  kindOf(side: PingSide): PingHoldKind { return PING_HOLD_KINDS[this.downed ? 'downed' : 'alive'][side]; }

  setOpen(open: boolean, downed: boolean): void {
    if (downed !== this.downed) { this.downed = downed; this.applyLabels(); }
    if (open === this.open) return;
    this.open = open;
    if (!open) this.setHover(null);
    toggleClass(this.root, 'show', open);
  }

  setHover(hover: PingSide | 'ammo' | null): void {
    if (hover === this.hover) return;
    this.hover = hover;
    toggleClass(this.sectors.left.root, 'hover', hover === 'left');
    toggleClass(this.sectors.right.root, 'hover', hover === 'right');
    if (this.sectors.left.arc.classList.contains('hover') !== (hover === 'left')) this.sectors.left.arc.classList.toggle('hover', hover === 'left');
    if (this.sectors.right.arc.classList.contains('hover') !== (hover === 'right')) this.sectors.right.arc.classList.toggle('hover', hover === 'right');
    toggleClass(this.ammoLeg, 'hover', hover === 'ammo');
  }

  private applyLabels(): void {
    toggleClass(this.root, 'downed', this.downed);
    for (const side of ['left', 'right'] as const) {
      const kind = this.kindOf(side);
      const s = this.sectors[side];
      setText(s.nm, PING_HOLD_LABEL_KO[kind]);
      s.root.style.setProperty('--pc', COLOR[kind] ?? '#7fb7e6');
      s.arc.style.setProperty('--pc', COLOR[kind] ?? '#7fb7e6');
    }
    // 전투불능일 때는 탄약 요청 다리가 없다 (총을 못 쏘는 사람이 탄약을 부를 이유가 없다)
    this.ammoLeg.hidden = this.downed;
  }

  dispose(): void { this.root.remove(); }
}
