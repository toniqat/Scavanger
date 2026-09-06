import type { EffectiveWeaponStats, ItemDef, ItemInstance } from '@/shared';
import { SOCKET_SLOTS } from '@/shared';
import type { Grid } from '../Grid';
import type { GridId } from '../InventorySystem';
import { DURABILITY_LOW, STEP, tileSize } from './labels';

export type DefLookup = (defId: string) => ItemDef | undefined;
/** Effective stats for weapon instances (null for anything else); drives socket pips + durability bar. */
export type StatsLookup = (item: ItemInstance) => EffectiveWeaponStats | null;
export type HighlightState = 'ok' | 'bad' | 'swap' | 'merge';

export interface TileHandlers {
  onPointerDown(uid: string, gridId: GridId, e: PointerEvent): void;
  onEnter(uid: string, gridId: GridId, e: PointerEvent): void;
  onMove(uid: string, gridId: GridId, e: PointerEvent): void;
  onLeave(uid: string, gridId: GridId): void;
  onContext(uid: string, gridId: GridId, e: MouseEvent): void;
  onDblClick(uid: string, gridId: GridId): void;
}

/**
 * Builds the visual content of a tile (shared by grid tiles, slot tiles and the drag ghost). Weapons (`stats`
 * given) also get five socket pips (filled = attached) and a thin durability bar (amber < 30 %, red at 0).
 */
export function buildTileContent(el: HTMLElement, item: ItemInstance, def: ItemDef, w: number, h: number, stats?: EffectiveWeaponStats | null): void {
  el.className = `inv-tile rarity-${def.rarity}`;
  if (def.attachment) el.classList.add('is-attachment');
  if (def.bag) el.classList.add('is-bag');
  el.style.setProperty('--rc', def.color);
  const { width, height } = tileSize(w, h);
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.classList.toggle('is-wide', w >= 2);
  el.classList.toggle('is-tall', h >= 2);
  el.classList.toggle('is-rotated', item.rotated);
  el.innerHTML = '';

  const icon = document.createElement('div');
  icon.className = 'inv-tile-icon';
  icon.textContent = def.icon;
  el.appendChild(icon);

  if (w >= 2 || h >= 2) {
    const name = document.createElement('div');
    name.className = 'inv-tile-name';
    name.textContent = def.name;
    el.appendChild(name);
  }

  const qty = document.createElement('div');
  qty.className = 'inv-tile-qty';
  qty.textContent = def.stackMax > 1 ? `${item.qty}` : '';
  qty.hidden = def.stackMax <= 1;
  el.appendChild(qty);

  if (stats) {
    el.classList.add('is-weapon');
    const pips = document.createElement('div');
    pips.className = 'inv-tile-sockets';
    for (const s of SOCKET_SLOTS) {
      const pip = document.createElement('i');
      pip.className = 'inv-pip';
      pip.dataset.socket = s;
      if (item.sockets?.[s]) pip.classList.add('is-filled');
      pips.appendChild(pip);
    }
    el.appendChild(pips);

    const max = Math.max(1, stats.maxDurability);
    const cur = Math.max(0, Math.min(max, item.durability ?? max));
    const ratio = cur / max;
    const bar = document.createElement('div');
    bar.className = 'inv-tile-dur';
    bar.style.setProperty('--p', `${Math.round(ratio * 100)}%`);
    if (cur <= 0) { bar.classList.add('is-broken'); el.classList.add('is-broken'); }
    else if (ratio < DURABILITY_LOW) bar.classList.add('is-low');
    el.appendChild(bar);
  }

  const glow = document.createElement('div');
  glow.className = 'inv-tile-glow';
  el.appendChild(glow);
}

/** Small wheel-direction badge (top-left) on a bag tile that sits in a quick-use slot. */
export function addQuickBadge(el: HTMLElement, glyph: string): void {
  el.classList.add('is-quick');
  const b = document.createElement('div');
  b.className = 'inv-tile-quick';
  b.textContent = glyph;
  el.appendChild(b);
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
  /** uid → direction glyph for items assigned to the quick-use wheel (bag grid only). */
  private quickBadges = new Map<string, string>();

  constructor(readonly id: GridId, private readonly getDef: DefLookup, private readonly getStats: StatsLookup, private readonly handlers: TileHandlers) {
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
    if (!grid) { this.clearTiles(); return; }
    this.syncDims(grid);
    this.refresh(true);
  }

  /** Rebuild the cell layer when the grid dimensions changed (bag swap, stash resize). */
  private syncDims(grid: Grid): void {
    const dims = `${grid.cols}x${grid.rows}`;
    if (dims === this.dims) return;
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

  refresh(force = false): void {
    const grid = this.grid;
    if (!grid) return;
    if (!force && grid.version === this.lastVersion) return;
    this.lastVersion = grid.version;
    this.syncDims(grid);

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
      buildTileContent(el, p.item, def, fp.w, fp.h, this.getStats(p.item));
      const badge = this.quickBadges.get(p.item.uid);
      if (badge) addQuickBadge(el, badge);
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

  /** Quick-slot badges (uid → glyph). Forces a re-render when the set changed. */
  setQuickBadges(badges: ReadonlyMap<string, string>): void {
    let same = badges.size === this.quickBadges.size;
    if (same) for (const [uid, g] of badges) if (this.quickBadges.get(uid) !== g) { same = false; break; }
    if (same) return;
    this.quickBadges = new Map(badges);
    this.refresh(true);
  }

  /** Socket-drop feedback on a weapon tile (attachment dragged over it). null clears every tile. */
  setSocketTarget(uid: string | null, state: 'ok' | 'bad' | null): void {
    for (const [id, el] of this.tiles) {
      el.classList.toggle('is-socket-ok', id === uid && state === 'ok');
      el.classList.toggle('is-socket-bad', id === uid && state === 'bad');
    }
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
