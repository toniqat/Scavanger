import type { GameContext, StratagemId } from '@/shared';
import { STRATAGEM_DEFS, STRATAGEM_ORDER } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { STRATAGEM_COLOR, STRATAGEM_GLYPH, stratagemDef } from './stratagemGlyphs';

/** SVG geometry (viewBox units = px). */
const SIZE = 280;
const R_IN = 64;
const R_OUT = 128;
const SECTOR_GAP_DEG = 3;
const ITEM_RADIUS = (R_IN + R_OUT) / 2;

interface Sector {
  id: StratagemId;
  arc: SVGPathElement;
  root: HTMLElement;
  cd: HTMLElement;
}

function tc(e: Element, cls: string, on: boolean): void { if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on); }

/** Annular sector path; angles in degrees, 0 = up, clockwise. */
function sectorPath(a0: number, a1: number): string {
  const c = SIZE / 2;
  const pt = (r: number, a: number): string => {
    const t = ((a - 90) * Math.PI) / 180;
    return `${(c + r * Math.cos(t)).toFixed(2)} ${(c + r * Math.sin(t)).toFixed(2)}`;
  };
  return `M${pt(R_OUT, a0)} A${R_OUT} ${R_OUT} 0 0 1 ${pt(R_OUT, a1)} L${pt(R_IN, a1)} A${R_IN} ${R_IN} 0 0 0 ${pt(R_IN, a0)} Z`;
}

/**
 * Ship-call wheel (`.swheel`, gameplay layer, `pointer-events:none`): 4 annular sectors in `STRATAGEM_ORDER`
 * (N 궤도 폭격 ◎, E 항공 폭탄 ▼, S 보급품 투하 ▣, W 구조물 투하 ▦), each with glyph, name and the shared-cooldown text.
 * Shown while `stratagem:wheelChanged.open`, `.hover` from `.hover`; while `stratagem:cooldown.remaining > 0` the whole
 * wheel is `.cooling` (dimmed sectors, `재충전 n초` in the centre), otherwise the centre shows the hovered call name +
 * hint. Seeds the cooldown from `ctx.stratagems` when it opens. Closed on death / down / mission reset.
 */
export class StratagemWheel {
  readonly root: HTMLElement;
  private sectors: Sector[] = [];
  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private cdEl: HTMLElement;
  private open = false;
  private hover: StratagemId | null = null;
  private cooldown = 0;
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'swheel', parent });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute('class', 'ring');
    this.root.appendChild(svg);
    const items = el('div', { cls: 'items', parent: this.root });

    STRATAGEM_ORDER.forEach((id, i) => {
      const a = i * 90;
      const arc = document.createElementNS(svgNS, 'path');
      arc.setAttribute('class', 'sarc');
      arc.setAttribute('d', sectorPath(a - 45 + SECTOR_GAP_DEG / 2, a + 45 - SECTOR_GAP_DEG / 2));
      svg.appendChild(arc);

      const t = ((a - 90) * Math.PI) / 180;
      const root = el('div', { cls: `ssector ${id}`, parent: items });
      root.style.left = `${(50 + (ITEM_RADIUS * Math.cos(t) * 100) / SIZE).toFixed(2)}%`;
      root.style.top = `${(50 + (ITEM_RADIUS * Math.sin(t) * 100) / SIZE).toFixed(2)}%`;
      root.style.setProperty('--sc', STRATAGEM_COLOR[id]);
      const def = stratagemDef(id);
      el('span', { cls: 'ico', text: STRATAGEM_GLYPH[id], parent: root });
      el('span', { cls: 'nm', text: def?.name ?? id, parent: root });
      const cd = el('span', { cls: 'cd ui-mono', text: '', parent: root });
      this.sectors.push({ id, arc, root, cd });
    });

    const centre = el('div', { cls: 'centre', parent: this.root });
    el('div', { cls: 'ui-label', text: '함선 호출', parent: centre });
    this.nameEl = el('div', { cls: 'sname', text: '—', parent: centre });
    this.cdEl = el('div', { cls: 'scd ui-mono', text: '', parent: centre });
    this.subEl = el('div', { cls: 'ssub', text: '마우스로 선택 · G 놓기', parent: centre });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('stratagem:wheelChanged', ({ open, hover }) => {
        if (open && !this.open) this.seedCooldown();
        this.open = open;
        this.hover = open ? hover : null;
        toggleClass(this.root, 'show', open);
        this.render();
      }),
      b.on('stratagem:cooldown', ({ remaining }) => { this.cooldown = Math.max(0, remaining); if (this.open) this.render(); }),
      b.on('game:newMission', () => this.setOpen(false)),
      b.on('game:abort', () => this.setOpen(false)),
      b.on('player:died', () => this.setOpen(false)),
      b.on('player:downed', () => this.setOpen(false)),
    );
  }

  get isOpen(): boolean { return this.open; }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    if (!open) this.hover = null;
    toggleClass(this.root, 'show', open);
    this.render();
  }

  private seedCooldown(): void {
    const s = this.ctx?.stratagems;
    if (s) this.cooldown = Math.max(0, s.cooldown);
  }

  private render(): void {
    const cooling = this.cooldown > 0;
    const cdText = cooling ? `재충전 ${Math.ceil(this.cooldown)}초` : '';
    toggleClass(this.root, 'cooling', cooling);
    for (const s of this.sectors) {
      const on = this.hover === s.id;
      toggleClass(s.root, 'hover', on);
      tc(s.arc, 'hover', on);
      setText(s.cd, cooling ? `${Math.ceil(this.cooldown)}s` : `${stratagemDef(s.id)?.cooldown ?? 0}s`);
    }
    const def = stratagemDef(this.hover);
    setText(this.nameEl, def ? def.name : '—');
    toggleClass(this.nameEl, 'dim', !def);
    setText(this.cdEl, cdText);
    setText(this.subEl, def ? def.hint : '마우스로 선택 · G 놓기');
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}

/** Number of sectors (debug / smoke). */
export const STRATAGEM_WHEEL_SECTORS = STRATAGEM_DEFS.length;
