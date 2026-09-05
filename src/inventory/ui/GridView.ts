import type { ItemDef, ItemInstance } from '@/shared';
import type { Grid } from '../Grid';
import type { GridId } from '../InventorySystem';
import { STEP, TEXT, tileSize } from './labels';

export type DefLookup = (defId: string) => ItemDef | undefined;
export type HighlightState = 'ok' | 'bad' | 'swap' | 'merge';
/** Per-item extras resolved at render time (crate search mask, durability bar). */
export type TileStateLookup = (item: ItemInstance, def: ItemDef) => TileOptions;

export interface TileHandlers {
  onPointerDown(uid: string, gridId: GridId, e: PointerEvent): void;
  onEnter(uid: string, gridId: GridId, e: PointerEvent): void;
  onMove(uid: string, gridId: GridId, e: PointerEvent): void;
  onLeave(uid: string, gridId: GridId): void;
  onContext(uid: string, gridId: GridId, e: MouseEvent): void;
  onDblClick(uid: string, gridId: GridId): void;
}

export interface TileOptions {
  /** Crate search (감정): the item is still being identified — icon, name and qty are masked. */
  hidden?: boolean;
  /** 0..1 durability bar drawn along the bottom edge; null / undefined = no bar. */
  durability?: number | null;
}

/** Builds the visual content of a tile (shared by grid tiles, slot tiles and the drag ghost). */
export function buildTileContent(
  el: HTMLElement, item: ItemInstance, def: ItemDef, w: number, h: number, opts: TileOptions = {},
): void {
  const masked = opts.hidden === true;
  el.className = `inv-tile rarity-${masked ? 'common' : def.rarity}`;
  el.style.setProperty('--rc', masked ? '#6b727b' : def.color);
  const { width, height } = tileSize(w, h);
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.classList.toggle('is-wide', w >= 2);
  el.classList.toggle('is-tall', h >= 2);
  el.classList.toggle('is-rotated', !masked && item.rotated);
  el.classList.toggle('is-hidden-item', masked);
  el.innerHTML = '';

  const icon = document.createElement('div');
  icon.className = 'inv-tile-icon';
  icon.textContent = masked ? '?' : def.icon;
  el.appendChild(icon);

  if (w >= 2 || h >= 2) {
    const name = document.createElement('div');
    name.className = 'inv-tile-name';
    name.textContent = masked ? TEXT.hidden : def.name;
    el.appendChild(name);
  }

  const qty = document.createElement('div');
  qty.className = 'inv-tile-qty';
  qty.textContent = !masked && def.stackMax > 1 ? `${item.qty}` : '';
  qty.hidden = masked || def.stackMax <= 1;
  el.appendChild(qty);

  const dur = opts.durability;
  if (!masked && dur !== null && dur !== undefined) {
    const bar = document.createElement('div');
    bar.className = 'inv-tile-dur';
    if (dur <= 0) bar.classList.add('is-broken');
    else if (dur < 0.25) bar.classList.add('is-low');
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(0, Math.min(1, dur)) * 100}%`;
    bar.appendChild(fill);
    el.appendChild(bar);
  }

  if (masked) {
    const scan = document.createElement('div');
    scan.className = 'inv-tile-scan';
    el.appendChild(scan);
  }

  const glow = document.createElement('div');
  glow.className = 'inv-tile-glow';
  el.appendChild(glow);
}

/**
 * Renders one Grid as DOM: a static cell layer, absolutely positioned item
 * tiles, and a highlight rectangle for drag feedback. Tiles are diffed by uid so
 * only changed grids re-render.
 */
export class GridView {
  readonly el: HTMLElement;
  private cellsEl: HTMLElement;
  private tilesEl: HTMLElement;
  private hlEl: HTMLElement;
  private tiles = new Map<string, HTMLElement>();
  private grid: Grid | null = null;
  private lastVersion = -1;
  private dims = '';

  /** Extra per-item state the owner supplies (search mask, durability bar). */
  private state: TileStateLookup = () => ({});
  /** Signature of the last render's per-item state; a change forces a rebuild even at the same version. */
  private lastStateSig = '';

  constructor(readonly id: GridId, private readonly getDef: DefLookup, private readonly handlers: TileHandlers) {
    this.el = document.createElement('div');
    this.el.className = `inv-grid inv-grid-${id}`;
    this.cellsEl = document.createElement('div');
    this.cellsEl.className = 'inv-cells';
    this.tilesEl = document.createElement('div');
    this.tilesEl.className = 'inv-tiles';
    this.hlEl = document.createElement('div');
    this.hlEl.className = 'inv-hl';
    this.hlEl.hidden = true;
    this.el.append(this.cellsEl, this.tilesEl, this.hlEl);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get current(): Grid | null { return this.grid; }

  setGrid(grid: Grid | null): void {
    this.grid = grid;
    this.lastVersion = -1;
    this.lastStateSig = '';
    if (!grid) { this.clearTiles(); return; }
    const dims = `${grid.cols}x${grid.rows}`;
    if (dims !== this.dims) {
      this.dims = dims;
      this.el.style.setProperty('--cols', String(grid.cols));
      this.el.style.setProperty('--rows', String(grid.rows));
      this.el.style.width = `${grid.cols * STEP - 2}px`;
      this.el.style.height = `${grid.rows * STEP - 2}px`;
      this.cellsEl.innerHTML = '';
      for (let i = 0; i < grid.cols * grid.rows; i++) {
        const c = document.createElement('div');
        c.className = 'inv-cell';
        this.cellsEl.appendChild(c);
      }
    }
    this.refresh(true);
  }

  /** Supply the per-item extras (search mask, durability). Triggers a rebuild on the next refresh. */
  setStateLookup(fn: TileStateLookup): void {
    this.state = fn;
    this.lastStateSig = '';
  }

  refresh(force = false): void {
    const grid = this.grid;
    if (!grid) return;
    const states = new Map<string, TileOptions>();
    let sig = '';
    for (const p of grid.items()) {
      const def = this.getDef(p.item.defId);
      if (!def) continue;
      const st = this.state(p.item, def);
      states.set(p.item.uid, st);
      sig += `${p.item.uid}:${st.hidden ? 1 : 0}:${st.durability === null || st.durability === undefined ? '-' : st.durability.toFixed(2)};`;
    }
    if (!force && grid.version === this.lastVersion && sig === this.lastStateSig) return;
    this.lastVersion = grid.version;
    this.lastStateSig = sig;

    const seen = new Set<string>();
    for (const p of grid.items()) {
      const def = this.getDef(p.item.defId);
      if (!def) continue;
      seen.add(p.item.uid);
      let el = this.tiles.get(p.item.uid);
      const fp = grid.footprintOf(p.item);
      if (!el) {
        el = document.createElement('div');
        el.dataset.uid = p.item.uid;
        this.bindTile(el, p.item.uid);
        this.tiles.set(p.item.uid, el);
        this.tilesEl.appendChild(el);
        el.classList.add('is-new');
        requestAnimationFrame(() => el?.classList.remove('is-new'));
      }
      const wasDragging = el.classList.contains('is-dragging');
      const wasHover = el.classList.contains('is-hover');
      buildTileContent(el, p.item, def, fp.w, fp.h, states.get(p.item.uid) ?? {});
      if (wasDragging) el.classList.add('is-dragging');
      if (wasHover) el.classList.add('is-hover');
      el.style.transform = `translate(${p.x * STEP}px, ${p.y * STEP}px)`;
    }
    for (const [uid, el] of this.tiles) {
      if (!seen.has(uid)) { el.remove(); this.tiles.delete(uid); }
    }
  }

  private bindTile(el: HTMLElement, uid: string): void {
    el.addEventListener('pointerdown', (e) => this.handlers.onPointerDown(uid, this.id, e));
    el.addEventListener('pointerenter', (e) => { el.classList.add('is-hover'); this.handlers.onEnter(uid, this.id, e); });
    el.addEventListener('pointermove', (e) => this.handlers.onMove(uid, this.id, e));
    el.addEventListener('pointerleave', () => { el.classList.remove('is-hover'); this.handlers.onLeave(uid, this.id); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.handlers.onContext(uid, this.id, e); });
    el.addEventListener('dblclick', (e) => { e.preventDefault(); this.handlers.onDblClick(uid, this.id); });
  }

  private clearTiles(): void {
    for (const el of this.tiles.values()) el.remove();
    this.tiles.clear();
  }

  /* ── drag feedback ─────────────────────────────────────────────────────── */

  rect(): DOMRect { return this.el.getBoundingClientRect(); }

  /**
   * Cell under a ghost whose top-left is at (left, top) in client space, clamped
   * so a w×h footprint stays inside. Null when the pointer is outside the grid.
   */
  cellForGhost(left: number, top: number, w: number, h: number, pointerX: number, pointerY: number): { x: number; y: number } | null {
    const grid = this.grid;
    if (!grid) return null;
    const r = this.rect();
    const pad = STEP * 0.5;
    if (pointerX < r.left - pad || pointerX > r.right + pad || pointerY < r.top - pad || pointerY > r.bottom + pad) return null;
    let x = Math.round((left - r.left) / STEP);
    let y = Math.round((top - r.top) / STEP);
    x = Math.max(0, Math.min(grid.cols - w, x));
    y = Math.max(0, Math.min(grid.rows - h, y));
    if (w > grid.cols || h > grid.rows) return null;
    return { x, y };
  }

  showHighlight(x: number, y: number, w: number, h: number, state: HighlightState): void {
    const { width, height } = tileSize(w, h);
    this.hlEl.hidden = false;
    this.hlEl.className = `inv-hl is-${state}`;
    this.hlEl.style.width = `${width}px`;
    this.hlEl.style.height = `${height}px`;
    this.hlEl.style.transform = `translate(${x * STEP}px, ${y * STEP}px)`;
  }

  hideHighlight(): void { this.hlEl.hidden = true; }

  setDragging(uid: string | null): void {
    for (const [id, el] of this.tiles) el.classList.toggle('is-dragging', id === uid);
  }

  /**
   * Partial (Shift/Ctrl) drag feedback: the source tile stays lit and its badge shows what would remain.
   * `remaining` null clears the state; the next `refresh(true)` rebuilds the badge anyway.
   */
  markSplitSource(uid: string, remaining: number | null): void {
    const el = this.tiles.get(uid);
    if (!el) return;
    el.classList.toggle('is-split-source', remaining !== null);
    const badge = el.querySelector<HTMLElement>('.inv-tile-qty');
    if (!badge) return;
    if (remaining === null) {
      const item = this.grid?.get(uid)?.item;
      if (item) badge.textContent = String(item.qty);
    } else {
      badge.textContent = String(remaining);
    }
  }

  shake(uid: string): void {
    const el = this.tiles.get(uid);
    if (!el) return;
    el.classList.remove('is-shake');
    void el.offsetWidth; // restart animation
    el.classList.add('is-shake');
    setTimeout(() => el.classList.remove('is-shake'), 360);
  }

  tileEl(uid: string): HTMLElement | undefined { return this.tiles.get(uid); }

  dispose(): void {
    this.clearTiles();
    this.el.remove();
  }
}
