import type { GameContext, StratagemId } from '@/shared';
import { RESCUE_DROPS_PER_RAID, STRATAGEM_DEFS, STRATAGEM_HOST_ONLY, STRATAGEM_ORDER } from '@/shared';
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
  /** 2026-09-09: the lock mark — up when a host-only call is unusable or there is no rescue target. */
  lock: HTMLElement;
}

/**
 * 2026-09-09 — why this call cannot be armed right now (null when it can).
 *
 * It restates **the same rule** as `stratagems/parts/Rescue.armBlockReason` on the UI side. The two judgements must
 * never look at different things, so the ingredients are identical too — only `STRATAGEM_HOST_ONLY` (a contract
 * constant) and the rescue-ship fields of `ctx.stratagems`; it never looks inside the stratagems folder.
 */
export function stratagemLockReason(ctx: GameContext, id: StratagemId): string | null {
  const net = ctx.net;
  if (ctx.isMultiplayer && net && !net.isHost && STRATAGEM_HOST_ONLY.includes(id)) return '분대장 전용';
  if (id === 'rescue_drop') {
    const s = ctx.stratagems;
    if (!s) return null;
    if (s.rescueLeft <= 0) return '소진';
    if (!s.rescueAvailable) return '대상 없음';
  }
  return null;
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
 * (2026-09-09: N 궤도 폭격 ◎, E 보급품 투하 ▣, S 트라이포드 투하 ▦, W 구조선 투하 ✚ — every name is read from
 * `STRATAGEM_DEFS`), each with glyph, name and the shared-cooldown text (the count left on the rescue-ship sector only).
 * 2026-09-09: a sector that cannot be armed right now dims with `.locked` and gets one reason line (🔒 `분대장 전용` /
 * `대상 없음` / `소진`) — the judgement is `stratagemLockReason(ctx, id)` alone, on the same ingredients as the stratagems refusal rule.
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
      // 2026-09-09: one reason line for a locked call. Empty means `hidden`, so it takes no space either.
      const lock = el('span', { cls: 'lk ui-mono', text: '', parent: root });
      lock.hidden = true;
      lock.style.cssText = 'display:block;font-size:10px;letter-spacing:.06em;color:#ff8a8a;';
      this.sectors.push({ id, arc, root, cd, lock });
    });

    const centre = el('div', { cls: 'centre', parent: this.root });
    el('div', { cls: 'ui-label', text: '함선 지원', parent: centre });
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
      /* 2026-09-09: the lock and the rescue count left can change while the wheel is open */
      b.on('net:hostChanged', () => { if (this.open) this.repaint(); }),
      b.on('rescue:countChanged', () => { if (this.open) this.repaint(); }),
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

  /** Force a repaint (a lock / rescue-count change while the wheel is up). */
  private repaint(): void { this.render(); }

  private render(): void {
    const cooling = this.cooldown > 0;
    const cdText = cooling ? `재충전 ${Math.ceil(this.cooldown)}초` : '';
    toggleClass(this.root, 'cooling', cooling);
    const ctx = this.ctx;
    const rescueLeft = ctx?.stratagems?.rescueLeft ?? RESCUE_DROPS_PER_RAID;
    let hoverLock: string | null = null;
    for (const s of this.sectors) {
      const on = this.hover === s.id;
      toggleClass(s.root, 'hover', on);
      tc(s.arc, 'hover', on);
      /* 2026-09-09: a locked call is grey + one lock line. The rescue-ship sector shows the count left instead of the cooldown. */
      const lock = ctx ? stratagemLockReason(ctx, s.id) : null;
      if (on) hoverLock = lock;
      toggleClass(s.root, 'locked', lock !== null);
      s.root.style.opacity = lock !== null ? '0.4' : '';
      setText(s.lock, lock ? `🔒 ${lock}` : '');
      s.lock.hidden = lock === null;
      if (s.id === 'rescue_drop') setText(s.cd, `${rescueLeft}/${RESCUE_DROPS_PER_RAID}`);
      else setText(s.cd, cooling ? `${Math.ceil(this.cooldown)}s` : `${stratagemDef(s.id)?.cooldown ?? 0}s`);
    }
    const def = stratagemDef(this.hover);
    setText(this.nameEl, def ? def.name : '—');
    toggleClass(this.nameEl, 'dim', !def);
    setText(this.cdEl, cdText);
    setText(this.subEl, hoverLock ? hoverLock : def ? def.hint : '마우스로 선택 · G 놓기');
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}

/** Number of sectors (debug / smoke). */
export const STRATAGEM_WHEEL_SECTORS = STRATAGEM_DEFS.length;
