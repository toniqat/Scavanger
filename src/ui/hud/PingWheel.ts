import { PING_HOLD_KINDS, PING_HOLD_LABEL_KO } from '@/shared';
import '../styles/wheels.css';
import { el, setText, toggleClass } from '../dom';

/** SVG geometry (viewBox units = px) — a flatter, wider ring than the 4-slot wheel: there is only left / right. */
const SIZE = 240;
const R_IN = 54;
const R_OUT = 108;
const SECTOR_GAP_DEG = 6;
const LABEL_RADIUS = (R_IN + R_OUT) / 2;

/** Which side is showing / hovered. 2026-09-10: the downward (ammo) drag leg is gone, so left / right is all of it. */
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
 * **The area ping hold wheel (`.pwheel`, 2026-09-09).** A pure presentation widget — the gesture is still read by
 * `hud/Pings` (`PING_HOLD_MAX` · `PING_DRAG_THRESHOLD_PX` · the aim ray taken at the press, all as in v2), and this
 * class draws that state through `setOpen` / `setHover`. It replaces the one-line `.ping-hint` of before 2026-09-09
 * (`◄ 주의 · 돌격 ► · ▼ 탄약`).
 *
 * **What the two left / right slots mean is decided by the local player's state** (`PING_HOLD_KINDS` in
 * `shared/comms.ts`): standing, left = `여기 조심해` (`caution`) · right = `저쪽으로 가자` (`attack`); **downed**,
 * left = `살려줘` (`help`) · right = `나를 버려` (`abandon`). The labels are `PING_HOLD_LABEL_KO` and the colours the
 * same values as `PING_COLOR` in `hud/Pings`.
 *
 * **2026-09-10 (user's decision): the downward `▼ 탄약` leg was removed.** The same request sits on the `H`
 * communication wheel and a middle-click on the equipped weapon in the inventory sends the same line
 * (`탄약 필요: <탄종>`), so the gestures overlapped — dragging down now just places a plain ping. The wheel has only
 * the two left / right slots (`.ammo-leg`'s CSS was deleted from `styles/wheels.css` too).
 *
 * The wheel is a `pointer-events:none` overlay and touches neither the blocker, the ESC stack nor the pointer lock.
 * Locking the camera while held (2026-09-15, `setLookLocked`) is likewise not this widget's job but that of
 * `hud/Pings`, which owns the gesture.
 */
export class PingWheel {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private items: HTMLElement;
  private sectors: Record<PingSide, Sector>;
  private open = false;
  private downed = false;
  private hover: PingSide | null = null;

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

  setHover(hover: PingSide | null): void {
    if (hover === this.hover) return;
    this.hover = hover;
    toggleClass(this.sectors.left.root, 'hover', hover === 'left');
    toggleClass(this.sectors.right.root, 'hover', hover === 'right');
    if (this.sectors.left.arc.classList.contains('hover') !== (hover === 'left')) this.sectors.left.arc.classList.toggle('hover', hover === 'left');
    if (this.sectors.right.arc.classList.contains('hover') !== (hover === 'right')) this.sectors.right.arc.classList.toggle('hover', hover === 'right');
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
  }

  dispose(): void { this.root.remove(); }
}
