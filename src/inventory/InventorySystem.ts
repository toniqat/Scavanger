import * as THREE from 'three';
import type { GameContext, GameSystem, InventoryRef, ItemDef, ItemInstance, Loadout } from '@/shared';
import { INVENTORY_COLS, INVENTORY_ROWS, Keys } from '@/shared';
import { ITEM_DEF_MAP, LootService, STARTER_LOADOUT } from '@/items';
import { Grid, OOB } from './Grid';
import { Container, ContainerStore } from './Container';
import { InventoryUI } from './ui/InventoryUI';

/* ── UI ↔ system vocabulary ─────────────────────────────────────────────── */
export type GridId = 'bag' | 'container';
export type SlotId = 'primary' | 'secondary';
export type ItemLocation = { kind: 'grid'; grid: GridId } | { kind: 'slot'; slot: SlotId };
export type DropTarget =
  | { kind: 'grid'; grid: GridId; x: number; y: number; rotated: boolean }
  | { kind: 'slot'; slot: SlotId };
/** `ok` mutated, `noop` nothing to do (drop in place), `fail` refused (UI shakes). */
export type OpResult = 'ok' | 'noop' | 'fail';
export type DropPreview = 'ok' | 'swap' | 'merge' | 'noop' | 'bad';
export type UiSfx = 'ui_pickup' | 'ui_drop' | 'ui_rotate' | 'ui_error' | 'ui_equip';

const AUTO_CLOSE_DISTANCE = 6;
const BLOCKER_TOKEN = 'inventory';

/**
 * Owns the player's bag grid, equipment slots and the open loot container.
 * Publishes `ctx.inventory` (this) and `ctx.loot` (LootService).
 */
export class InventorySystem implements GameSystem, InventoryRef {
  readonly name = 'inventory';

  private ctx!: GameContext;
  private loot = new LootService();
  private bag!: Grid;
  private loadout: Loadout = { primary: null, secondary: null };
  private containers = new ContainerStore((id) => ITEM_DEF_MAP.get(id));
  private activeContainer: Container | null = null;
  private _open = false;
  private missionSeed = 0;
  private lastGrenades = -1;
  private lastStims = -1;
  private ui: InventoryUI | null = null;
  private offs: Array<() => void> = [];
  private escHandler = (e: KeyboardEvent): void => {
    if (e.code !== Keys.MENU || !this._open) return;
    e.preventDefault();
    e.stopPropagation();
    this.closeAll();
  };

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.inventory = this;
    ctx.loot = this.loot;
    this.bag = new Grid(INVENTORY_COLS, INVENTORY_ROWS, (id) => ITEM_DEF_MAP.get(id));
    this.ui = new InventoryUI(this, ctx);
    this.ui.mount();

    const bus = ctx.bus;
    this.offs.push(
      bus.on('world:ready', ({ seed }) => { this.missionSeed = seed; this.reset(); }),
      bus.on('crate:open', ({ crateId, tier, position }) => this.openContainer(crateId, tier, position)),
      bus.on('player:died', () => this.closeAll()),
      bus.on('game:abort', () => { this.closeAll(); this.containers.clear(); }),
      bus.on('game:newMission', () => { this.closeAll(); this.containers.clear(); }),
      bus.on('game:phaseChanged', () => { if (!ctx.isGameplayPhase()) this.closeAll(); }),
    );
    // Capture-phase so Escape closes the inventory without also reaching the menu system.
    window.addEventListener('keydown', this.escHandler, true);
  }

  update(_dt: number, ctx: GameContext): void {
    if (ctx.input.wasPressed(Keys.INVENTORY) && ctx.isGameplayPhase() && (this._open || ctx.uiBlockers.size === 0)) {
      this.toggleBag();
    }
    if (!this._open) return;
    if (ctx.input.wasPressed(Keys.ROTATE_ITEM)) this.ui?.onRotateKey();
    const player = ctx.player;
    if (player?.isDead) { this.closeAll(); return; }
    if (this.activeContainer && player && player.position.distanceTo(this.activeContainer.position) > AUTO_CLOSE_DISTANCE) {
      this.closeAll();
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    window.removeEventListener('keydown', this.escHandler, true);
    this.closeAll();
    this.ui?.dispose();
    this.ui = null;
    if (this.ctx?.inventory === this) this.ctx.inventory = null;
  }

  /* ── InventoryRef ──────────────────────────────────────────────────────── */

  get isOpen(): boolean { return this._open; }

  getLoadout(): Loadout { return { primary: this.loadout.primary, secondary: this.loadout.secondary }; }

  getDef(defId: string): ItemDef | undefined { return ITEM_DEF_MAP.get(defId); }

  getAllItems(): ItemInstance[] { return this.bag.items().map((p) => p.item); }

  getTotalValue(): number { return this.bag.totalValue(); }

  countWhere(pred: (def: ItemDef, inst: ItemInstance) => boolean): number {
    let n = 0;
    for (const p of this.bag.items()) {
      const def = ITEM_DEF_MAP.get(p.item.defId);
      if (def && pred(def, p.item)) n += p.item.qty;
    }
    return n;
  }

  consumeWhere(pred: (def: ItemDef, inst: ItemInstance) => boolean, qty: number): number {
    let left = Math.max(0, Math.floor(qty));
    if (left === 0) return 0;
    let consumed = 0;
    // consume smallest stacks first so partial stacks disappear before full ones
    const matches = this.bag.items()
      .filter((p) => { const d = ITEM_DEF_MAP.get(p.item.defId); return !!d && pred(d, p.item); })
      .sort((a, b) => a.item.qty - b.item.qty);
    for (const p of matches) {
      if (left <= 0) break;
      const take = Math.min(left, p.item.qty);
      p.item.qty -= take; left -= take; consumed += take;
      if (p.item.qty <= 0) {
        this.bag.remove(p.item.uid);
        this.ctx.bus.emit('inventory:itemRemoved', { item: p.item });
      } else {
        this.bag.version++;
      }
    }
    if (consumed > 0) this.afterChange();
    return consumed;
  }

  tryAddItem(item: ItemInstance): boolean {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) return false;
    if (!this.bag.autoPlace(item)) {
      this.ctx.bus.emit('inventory:full', { item, name: def.name });
      return false;
    }
    this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
    this.afterChange();
    return true;
  }

  openContainer(containerId: string, tier: number, position: THREE.Vector3): void {
    const c = this.containers.getOrCreate(containerId, tier, position, this.loot, this.missionSeed);
    this.activeContainer = c;
    this.setOpen(true);
    this.ui?.show(c);
    this.ctx.bus.emit('inventory:opened', { containerId });
    this.checkLooted();
  }

  toggleBag(): void {
    if (this._open) { this.closeAll(); return; }
    this.activeContainer = null;
    this.setOpen(true);
    this.ui?.show(null);
    this.ctx.bus.emit('inventory:opened', { containerId: null });
  }

  closeAll(): void {
    if (!this._open) return;
    this.activeContainer = null;
    this.setOpen(false);
    this.ui?.hide();
    this.ctx.bus.emit('inventory:closed', {});
  }

  reset(): void {
    this.closeAll();
    this.containers.clear();
    this.bag.clear();
    this.loadout = {
      primary: this.loot.createItem(STARTER_LOADOUT.primary),
      secondary: this.loot.createItem(STARTER_LOADOUT.secondary),
    };
    for (const e of STARTER_LOADOUT.bag) this.bag.autoPlace(this.loot.createItem(e.id, e.qty));
    this.lastGrenades = -1; this.lastStims = -1; // force count events
    this.emitLoadout();
    this.afterChange();
  }

  /* ── UI-facing operations ──────────────────────────────────────────────── */

  getGrid(id: GridId): Grid | null {
    return id === 'bag' ? this.bag : (this.activeContainer?.grid ?? null);
  }
  getActiveContainer(): Container | null { return this.activeContainer; }
  getLoot(): LootService { return this.loot; }

  findItem(uid: string, from: ItemLocation): ItemInstance | null {
    if (from.kind === 'slot') return this.loadout[from.slot]?.uid === uid ? this.loadout[from.slot] : null;
    return this.getGrid(from.grid)?.get(uid)?.item ?? null;
  }

  sfx(id: UiSfx): void { this.ctx.bus.emit('audio:play', { id }); }

  /** Non-mutating classification used for the drag highlight. */
  previewDrop(uid: string, from: ItemLocation, target: DropTarget): DropPreview {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'bad';

    if (target.kind === 'slot') {
      if (def.category !== target.slot) return 'bad';
      if (from.kind === 'slot') return from.slot === target.slot ? 'noop' : 'bad';
      const current = this.loadout[target.slot];
      if (!current) return 'ok';
      return this.canPlaceDisplaced(current, from, uid) ? 'swap' : 'bad';
    }

    const grid = this.getGrid(target.grid);
    if (!grid) return 'bad';
    if (from.kind === 'grid' && from.grid === target.grid) {
      const p = grid.get(uid);
      if (p && p.x === target.x && p.y === target.y && item.rotated === target.rotated) return 'noop';
    }
    const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, uid);
    if (blockers.length === 0) return 'ok';
    if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
    const other = grid.get(blockers[0]);
    if (!other) return 'bad';
    if (other.item.defId === item.defId && def.stackMax > 1 && other.item.qty < def.stackMax) return 'merge';
    if (from.kind === 'slot') {
      const od = ITEM_DEF_MAP.get(other.item.defId);
      return od && od.category === def.category ? 'swap' : 'bad';
    }
    return this.canSwap(item, from.grid, other.item, grid) ? 'swap' : 'bad';
  }

  /** Execute a drag-and-drop. */
  drop(uid: string, from: ItemLocation, target: DropTarget): OpResult {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    if (target.kind === 'slot') return this.dropOnSlot(item, def, from, target.slot);

    const grid = this.getGrid(target.grid);
    if (!grid) return 'fail';
    const to: ItemLocation = { kind: 'grid', grid: target.grid };

    if (from.kind === 'grid' && from.grid === target.grid) {
      const p = grid.get(uid);
      if (p && p.x === target.x && p.y === target.y && item.rotated === target.rotated) return 'noop';
    }

    const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, uid);
    if (blockers.includes(OOB)) return 'fail';

    if (blockers.length === 0) {
      if (from.kind === 'grid' && from.grid === target.grid) {
        if (!grid.moveTo(uid, target.x, target.y, target.rotated)) return 'fail';
        this.afterChange();
        return 'ok';
      }
      this.detach(item, from);
      grid.place(item, target.x, target.y, target.rotated);
      this.afterMove(item, from, to);
      return 'ok';
    }

    if (blockers.length !== 1) return 'fail';
    const other = grid.get(blockers[0]);
    if (!other) return 'fail';

    // stack merge
    if (other.item.defId === item.defId && def.stackMax > 1 && other.item.qty < def.stackMax) {
      const moved = grid.mergeInto(item, other.item.uid);
      if (moved <= 0) return 'fail';
      if (item.qty <= 0) {
        this.detach(item, from);
        this.afterMove(item, from, to, moved);
      } else {
        // partial merge: item stays where it was (qty reduced)
        if (from.kind === 'grid') { const g = this.getGrid(from.grid); if (g) g.version++; }
        if (this.locKind(from) !== this.locKind(to)) this.emitTransfer({ ...item, qty: moved }, def, from, to);
        this.afterChange();
      }
      return 'ok';
    }

    // swap with the single blocking item
    if (from.kind === 'slot') {
      const od = ITEM_DEF_MAP.get(other.item.defId);
      if (!od || od.category !== def.category) return 'fail';
      grid.remove(other.item.uid);
      this.loadout[from.slot] = other.item;
      grid.place(item, target.x, target.y, target.rotated);
      this.emitTransfer(other.item, od, to, from);
      this.emitTransfer(item, def, from, to);
      this.emitLoadout();
      this.afterChange();
      return 'ok';
    }
    const srcGrid = this.getGrid(from.grid);
    if (!srcGrid) return 'fail';
    if (!this.performSwap(item, srcGrid, other.item, grid, target.x, target.y, target.rotated)) return 'fail';
    if (from.grid !== target.grid) {
      const od = ITEM_DEF_MAP.get(other.item.defId);
      this.emitTransfer(item, def, from, to);
      if (od) this.emitTransfer(other.item, od, to, from);
    }
    this.afterChange();
    return 'ok';
  }

  /** Right-click: container ↔ bag auto-place; slot → bag. */
  quickMove(uid: string, from: ItemLocation): OpResult {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    let dest: GridId;
    if (from.kind === 'slot') dest = 'bag';
    else if (from.grid === 'container') dest = 'bag';
    else if (this.activeContainer) dest = 'container';
    else return 'fail';
    const grid = this.getGrid(dest);
    if (!grid) return 'fail';
    if (!grid.canAbsorb(item)) {
      if (dest === 'bag') this.ctx.bus.emit('inventory:full', { item, name: def.name });
      return 'fail';
    }
    this.detach(item, from);
    grid.autoPlace(item);
    this.afterMove(item, from, { kind: 'grid', grid: dest });
    return 'ok';
  }

  /** Double-click: weapons equip into their slot, anything else quick-moves. */
  activate(uid: string, from: ItemLocation): OpResult {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    if (def.category === 'primary' || def.category === 'secondary') {
      if (from.kind === 'slot') return 'noop';
      return this.dropOnSlot(item, def, from, def.category);
    }
    return this.quickMove(uid, from);
  }

  rotateItem(uid: string, gridId: GridId): OpResult {
    const grid = this.getGrid(gridId);
    const p = grid?.get(uid);
    if (!grid || !p) return 'fail';
    const def = ITEM_DEF_MAP.get(p.item.defId);
    if (!def || def.width === def.height) return 'noop';
    if (!grid.rotate(uid)) return 'fail';
    this.ctx.bus.emit('inventory:itemRotated', { item: p.item });
    this.afterChange();
    return 'ok';
  }

  /** "모두 가져가기": move every container item into the bag that fits. Returns moved count. */
  takeAll(): number {
    const c = this.activeContainer;
    if (!c) return 0;
    const items = c.grid.items().map((p) => p.item).sort((a, b) => this.area(b) - this.area(a));
    let moved = 0;
    let fullReported = false;
    for (const item of items) {
      const def = ITEM_DEF_MAP.get(item.defId);
      if (!def) continue;
      if (!this.bag.canAbsorb(item)) {
        if (!fullReported) { fullReported = true; this.ctx.bus.emit('inventory:full', { item, name: def.name }); }
        continue;
      }
      c.grid.remove(item.uid);
      this.bag.autoPlace(item);
      this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
      moved++;
    }
    if (moved > 0) this.afterChange();
    return moved;
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private setOpen(open: boolean): void {
    if (this._open === open) return;
    this._open = open;
    if (open) {
      this.ctx.uiBlockers.add(BLOCKER_TOKEN);
      this.ctx.input.exitPointerLock();
    } else {
      this.ctx.uiBlockers.delete(BLOCKER_TOKEN);
    }
  }

  private area(it: ItemInstance): number {
    const d = ITEM_DEF_MAP.get(it.defId);
    return d ? d.width * d.height : 0;
  }

  private locKind(loc: ItemLocation): 'player' | 'container' {
    return loc.kind === 'grid' && loc.grid === 'container' ? 'container' : 'player';
  }

  /** Remove an item from wherever it currently lives (no events). */
  private detach(item: ItemInstance, from: ItemLocation): void {
    if (from.kind === 'slot') {
      if (this.loadout[from.slot]?.uid === item.uid) this.loadout[from.slot] = null;
    } else {
      this.getGrid(from.grid)?.remove(item.uid);
    }
  }

  private emitTransfer(item: ItemInstance, def: ItemDef, from: ItemLocation, to: ItemLocation): void {
    const a = this.locKind(from), b = this.locKind(to);
    if (a === b) return;
    if (b === 'player') this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
    else this.ctx.bus.emit('inventory:itemRemoved', { item });
  }

  private afterMove(item: ItemInstance, from: ItemLocation, to: ItemLocation, qtyOverride?: number): void {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (def) this.emitTransfer(qtyOverride !== undefined ? { ...item, qty: qtyOverride } : item, def, from, to);
    if (from.kind === 'slot' || to.kind === 'slot') this.emitLoadout();
    this.afterChange();
  }

  private emitLoadout(): void {
    this.ctx.bus.emit('loadout:changed', { primary: this.loadout.primary, secondary: this.loadout.secondary });
  }

  private afterChange(): void {
    const grenades = this.countWhere((d) => d.category === 'grenade');
    const stims = this.countWhere((d) => d.category === 'stim');
    if (grenades !== this.lastGrenades) { this.lastGrenades = grenades; this.ctx.bus.emit('grenade:countChanged', { count: grenades }); }
    if (stims !== this.lastStims) { this.lastStims = stims; this.ctx.bus.emit('stim:countChanged', { count: stims }); }
    this.ctx.bus.emit('inventory:changed', { totalValue: this.bag.totalValue(), itemCount: this.bag.count });
    this.checkLooted();
    this.ui?.refresh();
  }

  private checkLooted(): void {
    const c = this.activeContainer;
    if (c && !c.lootedEmitted && c.grid.isEmpty) {
      c.lootedEmitted = true;
      this.ctx.bus.emit('crate:looted', { crateId: c.id });
    }
  }

  /** Can `current` (being displaced from a slot) be placed where the dragged item came from, or anywhere sensible? */
  private canPlaceDisplaced(current: ItemInstance, from: ItemLocation, draggedUid: string): boolean {
    if (from.kind !== 'grid') return false;
    const srcGrid = this.getGrid(from.grid);
    const src = srcGrid?.get(draggedUid);
    if (!srcGrid || !src) return false;
    const ignore = [draggedUid, current.uid];
    if (srcGrid.canPlace(current, src.x, src.y, current.rotated, ignore)) return true;
    if (srcGrid.canPlace(current, src.x, src.y, !current.rotated, ignore)) return true;
    if (srcGrid.findFreeSlot(current, current.rotated, ignore)) return true;
    return from.grid === 'container' && this.bag.findFreeSlot(current) !== null;
  }

  private dropOnSlot(item: ItemInstance, def: ItemDef, from: ItemLocation, slot: SlotId): OpResult {
    if (def.category !== slot) return 'fail';
    if (from.kind === 'slot') return from.slot === slot ? 'noop' : 'fail';
    const srcGrid = this.getGrid(from.grid);
    const src = srcGrid?.get(item.uid);
    if (!srcGrid || !src) return 'fail';
    const current = this.loadout[slot];
    const sx = src.x, sy = src.y, srot = item.rotated;
    srcGrid.remove(item.uid);
    if (current) {
      const placed =
        srcGrid.place(current, sx, sy, current.rotated) ||
        srcGrid.place(current, sx, sy, !current.rotated) ||
        srcGrid.autoPlace(current) ||
        (from.grid === 'container' && this.bag.autoPlace(current));
      if (!placed) { srcGrid.place(item, sx, sy, srot); return 'fail'; }
      if (from.grid === 'container' && srcGrid.has(current.uid)) {
        const cd = ITEM_DEF_MAP.get(current.defId);
        if (cd) this.emitTransfer(current, cd, { kind: 'slot', slot }, from);
      }
    }
    this.loadout[slot] = item;
    this.emitTransfer(item, def, from, { kind: 'slot', slot });
    this.emitLoadout();
    this.afterChange();
    return 'ok';
  }

  private canSwap(item: ItemInstance, fromGrid: GridId, other: ItemInstance, targetGrid: Grid): boolean {
    const srcGrid = this.getGrid(fromGrid);
    const src = srcGrid?.get(item.uid);
    if (!srcGrid || !src) return false;
    const ignore = [item.uid, other.uid];
    if (srcGrid.canPlace(other, src.x, src.y, other.rotated, ignore)) return true;
    if (srcGrid.canPlace(other, src.x, src.y, !other.rotated, ignore)) return true;
    // same-grid: anything free after both are lifted; cross-grid: any free slot in source grid
    const probe = srcGrid === targetGrid ? ignore : [item.uid];
    return srcGrid.findFreeSlot(other, other.rotated, probe) !== null;
  }

  private performSwap(item: ItemInstance, srcGrid: Grid, other: ItemInstance, dstGrid: Grid, x: number, y: number, rotated: boolean): boolean {
    const src = srcGrid.get(item.uid);
    const dst = dstGrid.get(other.uid);
    if (!src || !dst) return false;
    const sx = src.x, sy = src.y, srot = item.rotated;
    const ox = dst.x, oy = dst.y, orot = other.rotated;
    srcGrid.remove(item.uid);
    dstGrid.remove(other.uid);
    if (!dstGrid.place(item, x, y, rotated)) {
      srcGrid.place(item, sx, sy, srot); dstGrid.place(other, ox, oy, orot); return false;
    }
    const placed =
      srcGrid.place(other, sx, sy, orot) ||
      srcGrid.place(other, sx, sy, !orot) ||
      srcGrid.autoPlace(other);
    if (!placed) {
      dstGrid.remove(item.uid);
      srcGrid.place(item, sx, sy, srot);
      dstGrid.place(other, ox, oy, orot);
      return false;
    }
    return true;
  }
}
