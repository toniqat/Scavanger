import type { GameContext, ItemDef, ItemInstance } from '@/shared';
import { QUICK_SLOTS, QUICK_SLOT_DIRS, isQuickSlotActive } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/** SVG geometry (viewBox units = px). */
const SIZE = 260;
const R_IN = 58;
const R_OUT = 118;
const SECTOR_GAP_DEG = 2.5;
const ITEM_RADIUS = (R_IN + R_OUT) / 2;

interface Sector {
  arc: SVGPathElement;
  root: HTMLElement;
  ico: HTMLElement;
  cnt: HTMLElement;
  lock: HTMLElement;
  dir: HTMLElement;
}

/** `toggleClass` for SVG elements (not HTMLElement). */
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
 * Quick-use radial wheel (`.qwheel`, gameplay layer, `pointer-events:none`): 8 annular sectors (index 0 = N, clockwise
 * — `QUICK_SLOT_DIRS`) showing the slot item's icon (tinted with `ItemDef.color`) + stack count; the hovered sector's
 * item name sits under the centre. Sectors beyond the bag's quick-slot count (`!isQuickSlotActive(i, active)`) are
 * `.locked` (dim + lock glyph), empty ones `.empty`. Shown while `quick:wheelChanged.open`, hover from `.hover`;
 * slot data from the last `inventory:quickSlotsChanged` (seeded from `ctx.inventory.getQuickSlots()`), defs via
 * `ctx.inventory.getDef`. Counts follow `quick:used.remaining` / `inventory:itemUpdated`. Fade ~100 ms via CSS `.show`.
 */
export class QuickWheel {
  readonly root: HTMLElement;
  private sectors: Sector[] = [];
  private nameEl: HTMLElement;
  private slots: (ItemInstance | null)[] = new Array(QUICK_SLOTS).fill(null);
  private active = 0;
  private hover: number | null = null;
  private open = false;
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'qwheel', parent });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute('class', 'ring');
    this.root.appendChild(svg);
    const items = el('div', { cls: 'items', parent: this.root });

    for (let i = 0; i < QUICK_SLOTS; i++) {
      const a = i * 45;
      const arc = document.createElementNS(svgNS, 'path');
      arc.setAttribute('class', 'qarc');
      arc.setAttribute('d', sectorPath(a - 22.5 + SECTOR_GAP_DEG / 2, a + 22.5 - SECTOR_GAP_DEG / 2));
      svg.appendChild(arc);

      const t = ((a - 90) * Math.PI) / 180;
      const root = el('div', { cls: 'qsector empty', parent: items });
      root.style.left = `${(50 + (ITEM_RADIUS * Math.cos(t) * 100) / SIZE).toFixed(2)}%`;
      root.style.top = `${(50 + (ITEM_RADIUS * Math.sin(t) * 100) / SIZE).toFixed(2)}%`;
      const ico = el('span', { cls: 'ico', text: '', parent: root });
      const cnt = el('span', { cls: 'cnt ui-mono', text: '', parent: root });
      const lock = el('span', { cls: 'lock', text: '🔒', parent: root });
      const dir = el('span', { cls: 'dir', text: QUICK_SLOT_DIRS[i] ?? '', parent: root });
      this.sectors.push({ arc, root, ico, cnt, lock, dir });
    }

    const centre = el('div', { cls: 'centre', parent: this.root });
    el('div', { cls: 'ui-label', text: '빠른 사용', parent: centre });
    this.nameEl = el('div', { cls: 'qname', text: '—', parent: centre });
    el('div', { cls: 'qsub', text: '마우스로 선택 · F 놓기', parent: centre });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.seedFromInventory();
    const b = ctx.bus;
    this.unsubs.push(
      b.on('inventory:quickSlotsChanged', ({ slots, active }) => this.setSlots(slots, active)),
      b.on('quick:wheelChanged', ({ open, hover }) => {
        if (open && !this.open) this.seedFromInventory();
        this.open = open;
        this.hover = open ? hover : null;
        toggleClass(this.root, 'show', open);
        this.applyHover();
      }),
      b.on('quick:used', ({ index, remaining }) => {
        const s = this.slots[index];
        if (s) { if (remaining <= 0) this.slots[index] = null; else s.qty = remaining; this.renderSector(index); }
        if (this.hover === index) this.applyHover();
      }),
      b.on('inventory:itemUpdated', () => { if (this.open) this.seedFromInventory(); }),
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
    this.applyHover();
  }

  private seedFromInventory(): void {
    const inv = this.ctx?.inventory;
    if (!inv || typeof inv.getQuickSlots !== 'function' || typeof inv.getQuickSlotCount !== 'function') return;
    try { this.setSlots(inv.getQuickSlots(), inv.getQuickSlotCount()); } catch { /* inventory not ready yet */ }
  }

  private setSlots(slots: readonly (ItemInstance | null)[], active: number): void {
    this.active = active;
    for (let i = 0; i < QUICK_SLOTS; i++) {
      this.slots[i] = slots[i] ?? null;
      this.renderSector(i);
    }
    this.applyHover();
  }

  private defOf(inst: ItemInstance | null): ItemDef | undefined {
    if (!inst) return undefined;
    return this.ctx?.inventory?.getDef(inst.defId) ?? this.ctx?.loot?.getItemDef(inst.defId);
  }

  private renderSector(i: number): void {
    const s = this.sectors[i];
    const inst = this.slots[i];
    const locked = !isQuickSlotActive(i, this.active);
    const def = this.defOf(inst);
    toggleClass(s.root, 'locked', locked);
    tc(s.arc, 'locked', locked);
    toggleClass(s.root, 'empty', !inst);
    tc(s.arc, 'empty', !inst);
    setText(s.ico, def?.icon ?? (inst ? '?' : ''));
    const color = def?.color ?? 'var(--c-text-dim)';
    if (s.ico.style.color !== color) s.ico.style.color = color;
    setText(s.cnt, inst ? String(inst.qty) : '');
  }

  private applyHover(): void {
    for (let i = 0; i < QUICK_SLOTS; i++) {
      const on = this.hover === i;
      toggleClass(this.sectors[i].root, 'hover', on);
      tc(this.sectors[i].arc, 'hover', on);
    }
    const inst = this.hover !== null ? this.slots[this.hover] : null;
    const locked = this.hover !== null && !isQuickSlotActive(this.hover, this.active);
    const def = this.defOf(inst);
    if (locked) setText(this.nameEl, '잠긴 슬롯 — 더 큰 가방 필요');
    else if (def) setText(this.nameEl, inst && inst.qty > 1 ? `${def.name} ×${inst.qty}` : def.name);
    else setText(this.nameEl, this.hover !== null ? '비어 있음' : '—');
    toggleClass(this.nameEl, 'dim', !def || locked);
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
