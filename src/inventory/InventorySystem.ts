import * as THREE from 'three';
import type {
  CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, EffectiveWeaponStats, GameContext, GameSystem, InventoryRef, ItemDef, ItemInstance, Loadout, LoadoutSlot,
  SocketSlot, WeaponSlot, WeightInfo, LoadoutPreset, WorkbenchKind,
} from '@/shared';
import { BAG_DEFAULT_COLS, BAG_DEFAULT_QUICK_SLOTS, BAG_DEFAULT_ROWS, Keys, QUICK_SLOTS, SOCKET_SLOTS, isQuickSlotActive } from '@/shared';
import { AMMO_LABEL_KO, ITEM_DEF_MAP, LootService, STARTER_LOADOUT, ammoItemIdFor, getRecipe, isWeaponItemDef, itemWeight } from '@/items';
import { durabilityInfo, gearMultipliers, makeWeightInfo, sumWeight } from './Gear';
import { Grid, OOB, type Placement, type PriorityPlacement } from './Grid';
import { Container, ContainerStore } from './Container';
import { attachedItems, clearSocket, findSocketed, setSocket } from './Sockets';
import {
  assignQuickSlot, autoAssignQuickSlots, createQuickSlots, firstFreeQuickSlot, isQuickIndex, isQuickUsable, pruneQuickSlots,
  quickSlotOf, quickSlotsSignature, relinkQuickSlot, type QuickSlotUids,
} from './QuickSlots';
import { InventoryUI } from './ui/InventoryUI';
import { Stash } from './Stash';

/* ── UI ↔ system vocabulary ─────────────────────────────────────────────── */
/** 'stash' = the ship stash (hub Tab screen only; persisted, see Stash.ts). */
export type GridId = 'bag' | 'container' | 'stash';
/** Equipment slots = the shared `LoadoutSlot` (주무기 I / 주무기 II / 보조무기 / 가방 / 방탄복). */
export type SlotId = LoadoutSlot;
export const LOADOUT_SLOTS: readonly LoadoutSlot[] = ['primary', 'primary2', 'secondary', 'bag', 'armor'];
export const WEAPON_SLOT_IDS: readonly WeaponSlot[] = ['primary', 'primary2', 'secondary'];
export type ItemLocation = { kind: 'grid'; grid: GridId } | { kind: 'slot'; slot: SlotId };
export type DropTarget =
  | { kind: 'grid'; grid: GridId; x: number; y: number; rotated: boolean }
  | { kind: 'slot'; slot: SlotId }
  /** An attachment released over a weapon tile (bag or equipment slot): socket it. */
  | { kind: 'weapon'; uid: string; loc: ItemLocation }
  /** A stim / grenade released over a quick-use wheel cell: assign it (`setQuickSlot`). */
  | { kind: 'quick'; index: number };
/** `ok` mutated, `noop` nothing to do (drop in place), `fail` refused (UI shakes). */
export type OpResult = 'ok' | 'noop' | 'fail';
export type DropPreview = 'ok' | 'swap' | 'merge' | 'noop' | 'bad';
export type UiSfx = 'ui_pickup' | 'ui_drop' | 'ui_rotate' | 'ui_error' | 'ui_equip';
export type BagSize = { cols: number; rows: number; quickSlots: number };
/** How the last mission ended; decides what `game:abort` does to the bag (see README "Reset policy"). */
type MissionOutcome = 'none' | 'complete' | 'over';
/* ── Phase 6: bench crafting vocabulary (CraftPanel) ── */
/** Active 작업실 bench of the craft panel (`openBenchCraft`); null = the plain 제작 panel. */
export type ActiveBench = { kind: WorkbenchKind; level: number };
/** A craft-panel row: `locked` = the recipe belongs to this bench but needs a higher bench level. */
export type BenchRecipeRow = { recipe: CraftRecipe; locked: boolean };
/** A repair-list row of the bench panel (`where` = loadout slot, null = in the bag grid). */
export type BenchRepairRow = {
  uid: string; item: ItemInstance; def: ItemDef; where: LoadoutSlot | null; dur: DurabilityInfo;
  cost: { defId: string; qty: number; name: string; have: number }[]; short: boolean;
};

const AUTO_CLOSE_DISTANCE = 6;
const BLOCKER_TOKEN = 'inventory';
/** World-drop throw: eye position lowered / pushed forward, forward speed + upward pop. */
const DROP_EYE_LOWER = 0.3;
const DROP_FORWARD_OFFSET = 0.4;
const DROP_FORWARD_SPEED = 3.5;
const DROP_UP_SPEED = 2.0;
const MOD_SHIFT = ['ShiftLeft', 'ShiftRight'] as const;
const MOD_CTRL = ['ControlLeft', 'ControlRight'] as const;

/** Which item categories a loadout slot accepts. */
export function slotAccepts(def: ItemDef, slot: LoadoutSlot): boolean {
  if (slot === 'bag') return def.category === 'bag';
  if (slot === 'armor') return def.category === 'armor';
  if (slot === 'secondary') return def.category === 'secondary';
  return def.category === 'primary';
}

export const isWeaponDef = (def: ItemDef | undefined): boolean => isWeaponItemDef(def);
export const isAttachmentDef = (def: ItemDef | undefined): boolean => !!def?.attachment;
export const isBagDef = (def: ItemDef | undefined): boolean => !!def?.bag;
export const isArmorDef = (def: ItemDef | undefined): boolean => def?.category === 'armor' && !!def.armorId;

/** Minimum craft speed multiplier so a pathological derived value cannot make a craft instant. */
const CRAFT_MIN_SPEED = 0.2;

interface CraftJob {
  recipe: CraftRecipe;
  remaining: number;
  duration: number;
  resolve(item: ItemInstance | null): void;
}

/**
 * Owns the player's bag grid, the four equipment slots and the open loot container.
 * Publishes `ctx.inventory` (this) and `ctx.loot` (LootService).
 */
export class InventorySystem implements GameSystem, InventoryRef {
  readonly name = 'inventory';

  private ctx!: GameContext;
  private loot = new LootService();
  private bag!: Grid;
  private loadout: Loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null };
  /** Tactical kit: last emitted weight / loadout (gates `inventory:weightChanged` / `equip:changed`), running craft. */
  private lastWeight: WeightInfo | null = null;
  private lastEquipUids: Partial<Record<LoadoutSlot, string | null>> = {};
  private craftJob: CraftJob | null = null;
  private containers = new ContainerStore((id) => ITEM_DEF_MAP.get(id));
  /** 함선 창고 (persisted). Shown only while the window is open in the hub (`hubMode`). */
  private stash!: Stash;
  private hubMode = false;
  private activeContainer: Container | null = null;
  private _open = false;
  private missionSeed = 0;
  private outcome: MissionOutcome = 'none';
  private lastGrenades = -1;
  private lastStims = -1;
  /** Quick-use wheel: bag item uids by wheel direction (see `QuickSlots.ts`); `lastQuickSig` gates the change event. */
  private quickSlots: QuickSlotUids = createQuickSlots();
  private lastQuickSig = '';
  private lastStashVersion = 0;
  /* Phase 6: 무한 상자 window state + the bench the craft panel is showing. */
  private catalogOpen = false;
  private bench: ActiveBench | null = null;
  private ui: InventoryUI | null = null;
  private offs: Array<() => void> = [];
  private escHandler = (e: KeyboardEvent): void => {
    if (e.code !== Keys.MENU || !this._open) return;
    e.preventDefault();
    e.stopPropagation();
    // A context menu / split dialog swallows the first Escape; the window closes on the next one.
    if (this.ui?.closeOverlays()) return;
    this.closeAll();
  };

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.inventory = this;
    ctx.loot = this.loot;
    this.bag = new Grid(BAG_DEFAULT_COLS, BAG_DEFAULT_ROWS, (id) => ITEM_DEF_MAP.get(id));
    this.stash = new Stash((id) => ITEM_DEF_MAP.get(id), this.loot);
    // ship housing: the 창고 facility decides the stash size. At startup only *grow* to it — a persisted larger grid
    // (older facility state, cheat) is kept, and a shrink could strand items; `housing:stashSizeChanged` applies exactly.
    const housing = ctx.housing;
    if (housing && typeof housing.getStashSize === 'function') {
      const want = housing.getStashSize();
      if (want && Number.isFinite(want.cols) && Number.isFinite(want.rows)) {
        const cols = Math.max(this.stash.cols, Math.floor(want.cols)), rows = Math.max(this.stash.rows, Math.floor(want.rows));
        if ((cols !== this.stash.cols || rows !== this.stash.rows) && this.stash.resize(cols, rows)) this.stash.markDirty();
      }
    }
    this.ui = new InventoryUI(this, ctx);
    this.ui.mount();

    const bus = ctx.bus;
    this.offs.push(
      bus.on('housing:stashSizeChanged', ({ cols, rows }) => {
        if (!this.setStashSize(cols, rows)) {
          ctx.bus.emit('ui:notify', { text: '창고 크기를 바꿀 수 없습니다: 범위 밖에 아이템이 있습니다', kind: 'warning', duration: 2.5 });
        }
      }),
      bus.on('world:ready', ({ seed }) => this.onWorldReady(seed)),
      bus.on('crate:open', ({ crateId, tier, position }) => this.openContainer(crateId, tier, position)),
      bus.on('player:died', () => this.closeAll()),
      bus.on('game:complete', () => { this.outcome = 'complete'; }),
      bus.on('game:over', () => this.onGameOver()),
      bus.on('player:respawn', () => this.onRespawn()),
      bus.on('game:abort', () => this.onAbort()),
      bus.on('game:newMission', () => { this.closeAll(); this.containers.clear(); this.outcome = 'none'; }),
      bus.on('hub:entered', () => { if (this.isCompletelyEmpty()) this.applyStarter(); }),
      bus.on('game:phaseChanged', () => { if (!ctx.isGameplayPhase() && !ctx.isHubPhase()) this.closeAll(); }),
      bus.on('implant:equipped', () => { if (this._open) this.ui?.refresh(); }),
    );
    // Capture-phase so Escape closes the inventory without also reaching the menu system.
    window.addEventListener('keydown', this.escHandler, true);
  }

  update(dt: number, ctx: GameContext): void {
    // Tab: bag window on a mission, the 3-column ship screen (창고 / 장비 / 가방) in the hub
    if (ctx.input.wasPressed(Keys.INVENTORY) && (ctx.isGameplayPhase() || ctx.isHubPhase()) && (this._open || ctx.uiBlockers.size === 0)) {
      this.toggleBag();
    }
    this.updateCraft(dt);
    if (!this._open) return;
    if (ctx.input.wasPressed(Keys.ROTATE_ITEM)) this.ui?.onRotateKey();
    if (ctx.input.wasPressed(Keys.DROP_ITEM)) {
      const shift = MOD_SHIFT.some((c) => ctx.input.isDown(c));
      const ctrl = MOD_CTRL.some((c) => ctx.input.isDown(c));
      this.ui?.onDropKey(shift, ctrl);
    }
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
    this.stash?.dispose();
    this.ui?.dispose();
    this.ui = null;
    if (this.ctx?.inventory === (this as InventoryRef)) this.ctx.inventory = null;
  }

  /* ── reset policy ──────────────────────────────────────────────────────── */

  /**
   * `world:ready`: first mission (no weapon anywhere) → starter kit; otherwise everything is kept and only the
   * events every consumer needs (`loadout:changed`, counts, `inventory:changed`) are re-emitted.
   */
  private onWorldReady(seed: number): void {
    this.missionSeed = seed;
    this.outcome = 'none';
    this.closeAll();
    this.containers.clear();
    if (!this.hasAnyWeapon()) { this.applyStarter(); return; }
    this.lastGrenades = -1; this.lastStims = -1; this.lastQuickSig = '';
    this.emitLoadout();
    this.afterChange();
  }

  /** Legacy mission failure (Phase 2 death flow no longer emits it): everything is lost, back to the starter kit. */
  private onGameOver(): void {
    this.outcome = 'over';
    this.closeAll();
    this.containers.clear();
    this.applyStarter();
  }

  /** Phase 2 death flow: the hellpod re-drop after `PLAYER_RESPAWN_DELAY` brings the starter kit (mission continues, crates keep their state). */
  private onRespawn(): void {
    this.closeAll();
    this.applyStarter();
  }

  /**
   * `game:abort` after a completed mission is just the hub's mechanical transition (result screen → ship): keep
   * the worn weapons for the workbench. After death the kit was already reset. Any other abort (quit mid-mission,
   * lobby lost, back to title) resets to the starter kit.
   */
  private onAbort(): void {
    this.closeAll();
    this.containers.clear();
    const outcome = this.outcome;
    this.outcome = 'none';
    if (outcome === 'complete' || outcome === 'over') return;
    this.applyStarter();
  }

  private hasAnyWeapon(): boolean {
    for (const s of WEAPON_SLOT_IDS) if (this.loadout[s]) return true;
    return this.bag.items().some((p) => isWeaponItemDef(ITEM_DEF_MAP.get(p.item.defId)));
  }

  private isCompletelyEmpty(): boolean {
    return LOADOUT_SLOTS.every((s) => !this.loadout[s]) && this.bag.isEmpty;
  }

  /** Wipe the bag + slots and apply `STARTER_LOADOUT` (`items[].qty` are units / rounds). */
  private applyStarter(): void {
    this.bag.clear();
    const mk = (id: string | null): ItemInstance | null => (id && ITEM_DEF_MAP.has(id) ? this.loot.createItem(id) : null);
    const bagItem = mk(STARTER_LOADOUT.bag);
    this.loadout = {
      primary: mk(STARTER_LOADOUT.primary),
      primary2: mk(STARTER_LOADOUT.primary2),
      secondary: mk(STARTER_LOADOUT.secondary),
      bag: bagItem,
      armor: mk(STARTER_LOADOUT.armor),
    };
    const size = this.bagSizeOf(bagItem);
    this.bag.resize(size.cols, size.rows);
    for (const e of STARTER_LOADOUT.items) this.addUnits(e.id, e.qty);
    autoAssignQuickSlots(this.quickSlots, this.getAllItems(), (id) => ITEM_DEF_MAP.get(id), this.getQuickSlotCount());
    this.lastGrenades = -1; this.lastStims = -1; this.lastQuickSig = ''; // force count / quick-slot events
    this.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: [] });
    this.emitLoadout();
    this.afterChange();
  }

  /* ── InventoryRef ──────────────────────────────────────────────────────── */

  get isOpen(): boolean { return this._open; }

  getLoadout(): Loadout { return { ...this.loadout }; }

  getDef(defId: string): ItemDef | undefined { return ITEM_DEF_MAP.get(defId); }

  getAllItems(): ItemInstance[] { return this.bag.items().map((p) => p.item); }

  getTotalValue(): number { return this.bag.totalValue(); }

  getBagSize(): BagSize { return this.bagSizeOf(this.loadout.bag); }

  /* ── appended: tactical kit — gear slots / weight / durability / crafting ── */

  getEquipped(slot: LoadoutSlot): ItemInstance | null { return this.loadout[slot] ?? null; }

  consumeDef(defId: string, qty: number): boolean {
    const want = Math.max(0, Math.floor(qty));
    if (want === 0) return true;
    if (this.countDef(defId) < want) return false;
    return this.consumeWhere((d) => d.id === defId, want) === want;
  }

  private countDef(defId: string): number {
    return this.countWhere((d) => d.id === defId);
  }

  /** Bag + equipped gear weight against the character's carry capacity (근력 via `ctx.progression`). */
  getWeight(): WeightInfo {
    const mult = gearMultipliers(this.ctx.progression?.derived);
    let w = sumWeight(this.bag.items().map((p) => p.item), (id) => ITEM_DEF_MAP.get(id));
    for (const slot of LOADOUT_SLOTS) {
      const it = this.loadout[slot];
      if (!it) continue;
      const d = ITEM_DEF_MAP.get(it.defId);
      if (d) w += itemWeight(d, it.qty);
    }
    // bigger bags carry more: +0.5 kg of capacity per grid cell above the default bag
    const size = this.bagSizeOf(this.loadout.bag);
    const capacity = mult.carryCapacity + Math.max(0, size.cols * size.rows - BAG_DEFAULT_COLS * BAG_DEFAULT_ROWS) * 0.5;
    return makeWeightInfo(Math.round(w * 100) / 100, capacity, mult.carryRelief);
  }

  private emitWeight(): void {
    const info = this.getWeight();
    const prev = this.lastWeight;
    const same = prev && prev.state === info.state
      && Math.abs(prev.weight - info.weight) < 0.005 && Math.abs(prev.capacity - info.capacity) < 0.005;
    if (same) return;
    this.lastWeight = info;
    this.ctx.bus.emit('inventory:weightChanged', { weight: info.weight, capacity: info.capacity, ratio: info.ratio, state: info.state });
    if ((!prev || prev.state !== info.state) && (info.state === 'heavy' || info.state === 'over')) {
      this.ctx.bus.emit('inventory:overloaded', { state: info.state });
    }
  }

  /** Durability of a weapon (effective max) or armor (`ItemDef.durabilityMax`), or null. */
  getDurability(uid: string): DurabilityInfo | null {
    const item = this.findItem(uid);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return null;
    const stats = this.loot.getEffectiveStats(item);
    if (stats) {
      const cur = Math.max(0, Math.min(stats.maxDurability, item.durability ?? stats.maxDurability));
      return { uid, durability: cur, max: stats.maxDurability, broken: cur <= 0 };
    }
    return durabilityInfo(item, def);
  }

  /** Wear on non-weapon gear (armor per absorbed hit). Weapons keep `updateItem` (weapons/ owns that path). */
  damageDurability(uid: string, amount: number): void {
    const wear = Math.max(0, amount);
    if (wear === 0) return;
    const item = this.findItem(uid);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    const max = def?.durabilityMax;
    if (!item || !def || max === undefined || max <= 0) return;
    const before = Math.max(0, Math.min(max, item.durability ?? max));
    if (before <= 0) return;
    const after = Math.max(0, before - wear);
    if (after === before) return;
    item.durability = after;
    this.ctx.bus.emit('durability:changed', { uid, defId: def.id, durability: after, max });
    this.ctx.bus.emit('inventory:itemUpdated', { item });
    if (after <= 0) {
      this.ctx.bus.emit('durability:broken', { uid, defId: def.id, name: def.name });
      this.ctx.bus.emit('ui:notify', { text: `${def.name} 파손!`, kind: 'danger' });
      this.ctx.bus.emit('audio:play', { id: 'gear_broken' });
    }
    if (this._open) this.ui?.refresh();
  }

  /** Ship workbench: weapons go through `repairWeapon` (materials), armor is restored to full for free. */
  repair(uid: string): boolean {
    if (this.ctx.isRaidActive()) return false;
    const item = this.findItem(uid);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return false;
    if (this.loot.getEffectiveStats(item)) {
      const ok = this.repairWeapon(uid);
      if (ok) this.ctx.bus.emit('repair:completed', { uid, name: def.name, durability: item.durability ?? 0 });
      return ok;
    }
    const max = def.durabilityMax;
    if (max === undefined || max <= 0) return false;
    if ((item.durability ?? max) >= max) return false;
    item.durability = max;
    this.ctx.bus.emit('durability:changed', { uid, defId: def.id, durability: max, max });
    this.ctx.bus.emit('repair:completed', { uid, name: def.name, durability: max });
    this.ctx.bus.emit('audio:play', { id: 'gear_repair' });
    this.afterChange();
    return true;
  }

  /**
   * Context-menu repair readout (hub only): materials still needed for a weapon (`[]` = free / armor), `short`
   * = which of them the bag lacks. null when the item is not worn / not repairable.
   */
  repairInfo(uid: string): { cost: { defId: string; qty: number; name: string; have: number }[]; short: boolean } | null {
    const item = this.findItem(uid);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return null;
    const dur = this.getDurability(uid);
    if (!dur || dur.max <= 0 || dur.durability >= dur.max) return null;
    const cost = (this.loot.getEffectiveStats(item) ? this.loot.getRepairCost(item) : []).map((c) => ({
      ...c, name: ITEM_DEF_MAP.get(c.defId)?.name ?? c.defId, have: this.countDef(c.defId),
    }));
    return { cost, short: cost.some((c) => c.have < c.qty) };
  }

  /** 'ship' while walking the hub / menus, 'field' on a mission. */
  currentStation(): CraftStation {
    return this.ctx.isRaidActive() ? 'field' : 'ship';
  }

  /* ── Phase 6 (2026-09-06): 무한 상자 catalog ──────────────────────────── */

  /**
   * `/items` cheat: open the catalog panel (every item def, infinite stock) inside the inventory window — the ship
   * screen in the hub, the bag window on a mission. Opens the window itself when it is closed (blocker `'inventory'`).
   */
  openCatalog(): void {
    if (this.catalogOpen) return;
    const ctx = this.ctx;
    if (!ctx.isGameplayPhase() && !ctx.isHubPhase()) {
      ctx.bus.emit('ui:notify', { text: '무한 상자는 함선이나 임무 중에만 열 수 있습니다', kind: 'warning', duration: 2 });
      return;
    }
    this.catalogOpen = true;
    if (!this._open) {
      this.activeContainer = null;
      this.hubMode = ctx.isHubPhase();
      this.setOpen(true);
      this.ui?.show(null, this.hubMode);
      ctx.bus.emit('inventory:opened', { containerId: null });
    }
    this.ui?.setCatalog(true);
    ctx.bus.emit('ui:catalogToggled', { open: true });
  }

  /** Close the catalog panel; the rest of the window stays open. */
  closeCatalog(): void {
    if (!this.catalogOpen) return;
    this.catalogOpen = false;
    this.ui?.setCatalog(false);
    this.ctx.bus.emit('ui:catalogToggled', { open: false });
  }

  get isCatalogOpen(): boolean { return this.catalogOpen; }

  /** Units a catalog drag / double-click creates: a full stack for stackables, one otherwise. */
  catalogQty(def: ItemDef): number { return def.stackMax > 1 ? def.stackMax : 1; }

  /** Drag preview for a detached (catalog) instance over `target`: grids (free cell / merge) and equipment slots. */
  previewCatalog(item: ItemInstance, target: DropTarget): DropPreview {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) return 'bad';
    if (target.kind === 'quick' || target.kind === 'weapon') return 'bad';
    if (target.kind === 'slot') {
      if (!slotAccepts(def, target.slot)) return 'bad';
      const current = this.loadout[target.slot];
      if (!current) return 'ok';
      if (target.slot === 'bag') return 'swap'; // the displaced bag is placed first in the resized grid
      return this.canStow(current) ? 'swap' : 'bad';
    }
    const grid = this.getGrid(target.grid);
    if (!grid) return 'bad';
    const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, item.uid);
    if (blockers.length === 0) return 'ok';
    if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
    const other = grid.get(blockers[0]);
    return other && other.item.defId === item.defId && def.stackMax > 1 && other.item.qty < def.stackMax ? 'merge' : 'bad';
  }

  /**
   * Release a catalog drag: the fresh instance lands in the grid cell (or merges into the stack there) / the slot
   * (displaced gear → bag, else stash in the ship). The catalog tile is untouched. 'fail' → the UI shakes the tile.
   */
  dropFromCatalog(item: ItemInstance, target: DropTarget): OpResult {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || this.previewCatalog(item, target) === 'bad') return 'fail';
    if (target.kind === 'slot') {
      const slot = target.slot;
      if (slot === 'bag') {
        if (this.changeBag(item, null, 'grid') !== 'ok') return 'fail';
        this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
        return 'ok';
      }
      const current = this.loadout[slot];
      if (current) {
        const dest = this.stow(current);
        if (!dest) return 'fail';
        const cd = ITEM_DEF_MAP.get(current.defId);
        if (cd) this.emitTransfer(current, cd, { kind: 'slot', slot }, { kind: 'grid', grid: dest });
      }
      this.loadout[slot] = item;
      this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
      this.emitLoadout();
      this.afterChange();
      return 'ok';
    }
    if (target.kind !== 'grid') return 'fail';
    const grid = this.getGrid(target.grid);
    if (!grid) return 'fail';
    const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, item.uid);
    if (blockers.length === 0) {
      if (!grid.place(item, target.x, target.y, target.rotated)) return 'fail';
    } else {
      const other = grid.get(blockers[0]);
      if (!other || grid.mergeInto(item, other.item.uid) <= 0) return 'fail';
    }
    if (target.grid === 'bag') this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
    this.afterChange();
    return 'ok';
  }

  /** Catalog double-click: a fresh instance straight into the bag (merge into stacks first). */
  takeFromCatalog(defId: string): OpResult {
    const def = ITEM_DEF_MAP.get(defId);
    if (!def || !this.catalogOpen) return 'fail';
    const item = this.loot.createItem(defId, this.catalogQty(def));
    if (!this.bag.autoPlace(item)) {
      this.ctx.bus.emit('inventory:full', { item, name: def.name });
      return 'fail';
    }
    this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
    this.afterChange();
    return 'ok';
  }

  /** Where displaced gear can go: the bag, else the ship stash (hub only). */
  private canStow(item: ItemInstance): boolean {
    return this.bag.canAbsorb(item) || (this.ctx.isHubPhase() && this.stash.grid.canAbsorb(item));
  }

  /** Put a detached item into the bag, else the stash (ship). Returns where it went, null when nothing fits. */
  private stow(item: ItemInstance): GridId | null {
    if (this.bag.autoPlace(item)) return 'bag';
    if (this.ctx.isHubPhase() && this.stash.grid.autoPlace(item)) return 'stash';
    return null;
  }

  /* ── Phase 6: stash size (housing 창고 facility) ─────────────────────── */

  getStashSize(): { cols: number; rows: number } { return { cols: this.stash.cols, rows: this.stash.rows }; }

  /** Grow / shrink the stash grid (shrink refused while an item would fall outside). Persists; emits `inventory:stashChanged`. */
  setStashSize(cols: number, rows: number): boolean {
    if (!this.stash.resize(cols, rows)) return false;
    this.afterChange(); // stash version changed → markDirty + inventory:stashChanged + UI re-render
    return true;
  }

  /* ── Phase 6: materials across bag + stash (facility upgrades / furniture) ── */

  countDefAll(defId: string): number { return this.countDef(defId) + this.stashCountDef(defId); }

  private stashCountDef(defId: string): number {
    let n = 0;
    for (const p of this.stash.grid.items()) if (p.item.defId === defId) n += p.item.qty;
    return n;
  }

  /** Bag first, then the stash; all-or-nothing. */
  consumeDefAll(defId: string, qty: number): boolean {
    const want = Math.max(0, Math.floor(qty));
    if (want === 0) return true;
    if (this.countDefAll(defId) < want) return false;
    let left = want;
    const fromBag = Math.min(left, this.countDef(defId));
    if (fromBag > 0) left -= this.consumeWhere((d) => d.id === defId, fromBag);
    if (left > 0) {
      const stash = this.stash.grid;
      const matches = stash.items().filter((p) => p.item.defId === defId).sort((a, b) => a.item.qty - b.item.qty);
      for (const p of matches) {
        if (left <= 0) break;
        const take = Math.min(left, p.item.qty);
        p.item.qty -= take; left -= take;
        if (p.item.qty <= 0) stash.remove(p.item.uid);
        else stash.version++;
      }
      this.afterChange();
    }
    return left === 0;
  }

  /* ── Phase 6: loadout presets (사격장) ───────────────────────────────── */

  captureLoadout(): LoadoutPreset {
    const l = this.loadout;
    return {
      name: '프리셋', primary: l.primary?.defId ?? null, primary2: l.primary2?.defId ?? null, secondary: l.secondary?.defId ?? null,
      bag: l.bag?.defId ?? null, armor: l.armor?.defId ?? null,
      implant: this.ctx.progression?.profile.implant ?? this.ctx.implants?.equipped ?? null,
    };
  }

  /**
   * Equip a preset from the bag (first) and the stash: a slot whose def is found gets the first matching instance
   * (displaced gear → bag, else stash), a def that is nowhere empties the slot and lands in `missing`; `null`
   * entries leave the slot as it is. The implant goes through `ctx.implants.setEquipped` (the Tab screen's path).
   * Ship only — on a mission nothing changes and the result is empty.
   */
  applyLoadout(preset: LoadoutPreset): { equipped: number; missing: string[] } {
    if (!this.ctx.isHubPhase()) return { equipped: 0, missing: [] };
    let equipped = 0;
    const missing: string[] = [];
    for (const slot of LOADOUT_SLOTS) {
      const want = preset[slot];
      if (want === null || want === undefined) continue;
      const cur = this.loadout[slot];
      if (cur?.defId === want) { equipped++; continue; }
      const found = this.findStoredByDef(want);
      if (!found) {
        missing.push(want);
        if (cur) this.unequipToStorage(slot);
        continue;
      }
      if (this.equipFromStorage(found.item, found.grid, slot)) equipped++;
      else missing.push(want);
    }
    if (preset.implant !== null && preset.implant !== undefined) {
      const imp = this.ctx.implants;
      if (imp?.equipped === preset.implant) equipped++;
      else if (imp && typeof imp.setEquipped === 'function' && imp.setEquipped(preset.implant)) equipped++;
      else missing.push(preset.implant);
    }
    this.emitLoadout();
    this.afterChange();
    return { equipped, missing };
  }

  /** First instance of `defId` in the bag, then the stash. */
  private findStoredByDef(defId: string): { item: ItemInstance; grid: GridId } | null {
    for (const gridId of ['bag', 'stash'] as const) {
      const p = this.getGrid(gridId)?.items().find((q) => q.item.defId === defId);
      if (p) return { item: p.item, grid: gridId };
    }
    return null;
  }

  /** Unequip `slot` into the bag, else the stash (ship). The bag slot shrinks the grid first. */
  private unequipToStorage(slot: LoadoutSlot): boolean {
    const cur = this.loadout[slot];
    if (!cur) return true;
    if (slot === 'bag') {
      // the old bag lands in the shrunk grid (priority), else the ship stash through `throwToWorld`
      if (this.changeBag(null, null, 'grid') === 'ok') return true;
      return this.changeBag(null, null, 'world') === 'ok';
    }
    this.loadout[slot] = null;
    const dest = this.stow(cur);
    if (!dest) { this.loadout[slot] = cur; return false; }
    const def = ITEM_DEF_MAP.get(cur.defId);
    if (def) this.emitTransfer(cur, def, { kind: 'slot', slot }, { kind: 'grid', grid: dest });
    return true;
  }

  /** Move a bag / stash item into `slot`; the displaced item goes to the bag, else the stash, else the vacated cells. */
  private equipFromStorage(item: ItemInstance, gridId: GridId, slot: LoadoutSlot): boolean {
    const def = ITEM_DEF_MAP.get(item.defId);
    const grid = this.getGrid(gridId);
    if (!def || !grid || !slotAccepts(def, slot)) return false;
    const from: ItemLocation = { kind: 'grid', grid: gridId };
    if (slot === 'bag') {
      let r = this.changeBag(item, from, 'grid');
      if (r === 'fail' && this.loadout.bag) {
        // the displaced bag does not fit the new grid: park it in the stash first, then retry
        if (this.moveToStash(this.loadout.bag.uid, { kind: 'slot', slot: 'bag' }) !== 'ok') return false;
        const again = this.locate(item.uid);
        if (!again || again.from.kind !== 'grid') return false;
        r = this.changeBag(item, again.from, 'grid');
      }
      return r === 'ok';
    }
    const cur = this.loadout[slot];
    const src = grid.get(item.uid);
    if (!src) return false;
    const sx = src.x, sy = src.y, srot = item.rotated;
    grid.remove(item.uid);
    if (cur) {
      this.loadout[slot] = null;
      let dest: GridId | null = this.stow(cur);
      if (!dest && grid.autoPlace(cur)) dest = gridId;
      if (!dest) { this.loadout[slot] = cur; grid.place(item, sx, sy, srot); return false; }
      const cd = ITEM_DEF_MAP.get(cur.defId);
      if (cd) this.emitTransfer(cur, cd, { kind: 'slot', slot }, { kind: 'grid', grid: dest });
    }
    this.loadout[slot] = item;
    this.emitTransfer(item, def, from, { kind: 'slot', slot });
    return true;
  }

  /* ── Phase 6: 작업실 bench crafting ─────────────────────────────────── */

  /**
   * Open the craft panel in bench mode (ship only): recipes of `getRecipes('ship', bench, level)` + locked rows for
   * the bench's higher-level recipes, workshop cost discount, and the repair list of the gear that bench services.
   */
  openBenchCraft(bench: WorkbenchKind, level: number): void {
    const ctx = this.ctx;
    if (!ctx.isHubPhase()) {
      ctx.bus.emit('ui:notify', { text: '작업대는 함선에서만 사용할 수 있습니다', kind: 'warning', duration: 2 });
      return;
    }
    this.bench = { kind: bench, level: Math.max(0, Math.floor(level)) };
    if (!this._open) {
      this.activeContainer = null;
      this.hubMode = true;
      this.setOpen(true);
      this.ui?.show(null, true);
      ctx.bus.emit('inventory:opened', { containerId: null });
    }
    this.ui?.setCraftOpen(true);
    ctx.bus.emit('ui:craftToggled', { open: true });
  }

  /** Bench the craft panel is showing (null = plain 제작 panel). */
  getBench(): ActiveBench | null { return this.bench; }

  /** Leave bench mode (panel 닫기 / window closed). The window itself stays open. */
  closeBench(): void {
    if (!this.bench) return;
    this.bench = null;
    this.cancelCraft();
    this.ui?.setCraftOpen(false);
    this.ctx.bus.emit('ui:craftToggled', { open: false });
  }

  /** Rows for the craft panel: available recipes, then (bench mode) the bench's recipes above its level as locked. */
  getBenchRecipes(): BenchRecipeRow[] {
    const b = this.bench;
    if (!b) return this.getRecipes(this.currentStation()).map((recipe) => ({ recipe, locked: false }));
    const open = this.getRecipes('ship', b.kind, b.level);
    const skillOf = (id: CraftRecipe['skill']): number => this.ctx.progression?.getSkill(id) ?? 0;
    const locked = this.loot.getAllRecipes().filter((r) =>
      r.station === 'ship' && r.bench === b.kind && (r.benchLevel ?? 1) > b.level && skillOf(r.skill) >= r.skillRequired);
    return [...open.map((recipe) => ({ recipe, locked: false })), ...locked.map((recipe) => ({ recipe, locked: true }))];
  }

  /** Gear the active bench repairs: gun → weapons (slots + bag), gear → armor + bags, others none. Items without durability are skipped. */
  benchRepairRows(): BenchRepairRow[] {
    const b = this.bench;
    if (!b || (b.kind !== 'gun' && b.kind !== 'gear')) return [];
    const wants = (def: ItemDef): boolean => b.kind === 'gun' ? isWeaponItemDef(def) : (def.category === 'armor' || def.category === 'bag');
    const rows: BenchRepairRow[] = [];
    const push = (item: ItemInstance, where: LoadoutSlot | null): void => {
      const def = ITEM_DEF_MAP.get(item.defId);
      if (!def || !wants(def)) return;
      const dur = this.getDurability(item.uid);
      if (!dur || dur.max <= 0) return;
      const cost = (this.loot.getEffectiveStats(item) ? this.loot.getRepairCost(item) : []).map((c) => ({
        ...c, name: ITEM_DEF_MAP.get(c.defId)?.name ?? c.defId, have: this.countDef(c.defId),
      }));
      rows.push({ uid: item.uid, item, def, where, dur, cost, short: cost.some((c) => c.have < c.qty) });
    };
    for (const slot of LOADOUT_SLOTS) { const it = this.loadout[slot]; if (it) push(it, slot); }
    for (const p of this.bag.items()) push(p.item, null);
    return rows;
  }

  /** `모두 수리`: every worn row in order while the materials last. */
  benchRepairAll(): { done: number; skipped: number } {
    let done = 0, skipped = 0;
    for (const row of this.benchRepairRows()) {
      if (row.dur.durability >= row.dur.max) continue;
      if (row.short) { skipped++; continue; }
      if (this.repair(row.uid)) done++; else skipped++;
    }
    return { done, skipped };
  }

  /**
   * Recipes for a station given the current skills. Field: `station: 'field'` recipes only. Ship: field recipes
   * too; a recipe with `bench` needs that bench — at `bench` (given) with `benchLevel ≤ level`, otherwise a placed
   * bench of that kind at that level (`ctx.housing.getBenchLevel`, 0 without housing).
   */
  getRecipes(station: CraftStation, bench?: WorkbenchKind, level = 0): readonly CraftRecipe[] {
    const skillOf = (id: CraftRecipe['skill']): number => this.ctx.progression?.getSkill(id) ?? 0;
    const housing = this.ctx.housing;
    const placedLevel = (kind: WorkbenchKind): number =>
      housing && typeof housing.getBenchLevel === 'function' ? Math.max(0, housing.getBenchLevel(kind) || 0) : 0;
    return this.loot.getAllRecipes().filter((r) => {
      if (skillOf(r.skill) < r.skillRequired) return false;
      if (station === 'field') return r.station === 'field';
      if (r.bench === undefined) return true;
      const need = r.benchLevel ?? 1;
      if (bench !== undefined) return r.bench === bench && need <= level;
      return placedLevel(r.bench) >= need;
    });
  }

  /** Recipes the running station / bench may craft right now. */
  private availableRecipes(): readonly CraftRecipe[] {
    const b = this.bench;
    return b ? this.getRecipes('ship', b.kind, b.level) : this.getRecipes(this.currentStation());
  }

  /** Workshop material discount (`ctx.housing.getCraftCostMul`, ship only); 1 when nothing applies. */
  craftCostMul(): number {
    if (this.currentStation() !== 'ship') return 1;
    const h = this.ctx.housing;
    const m = h && typeof h.getCraftCostMul === 'function' ? h.getCraftCostMul() : 1;
    return Number.isFinite(m) && m > 0 && m < 1 ? m : 1;
  }

  /** Inputs of a recipe after the workshop discount (ceil, never below 1). */
  craftCost(recipe: CraftRecipe): CraftIngredient[] {
    const mul = this.craftCostMul();
    return recipe.inputs.map((i) => ({ defId: i.defId, qty: Math.max(1, Math.ceil(i.qty * mul - 1e-9)) }));
  }

  canCraft(recipeId: string): boolean {
    const r = getRecipe(recipeId);
    if (!r) return false;
    return this.craftCost(r).every((i) => this.countDef(i.defId) >= i.qty);
  }

  /** Seconds one craft takes right now (recipe duration scaled by 제작 skill and 재주). */
  craftDuration(recipeId: string): number {
    const r = getRecipe(recipeId);
    if (!r) return 0;
    const mult = gearMultipliers(this.ctx.progression?.derived);
    const speed = Math.max(CRAFT_MIN_SPEED, mult.craftSpeedMul * mult.useSpeedMul);
    return r.duration / speed;
  }

  craft(recipeId: string): Promise<ItemInstance | null> {
    const r = getRecipe(recipeId);
    if (!r) return Promise.resolve(null);
    this.cancelCraft();
    if (this.availableRecipes().indexOf(r) < 0 || !this.canCraft(recipeId)) {
      this.ctx.bus.emit('craft:failed', { recipeId, reason: 'missing' });
      return Promise.resolve(null);
    }
    const duration = this.craftDuration(recipeId);
    this.ctx.bus.emit('craft:started', { recipeId, duration });
    return new Promise<ItemInstance | null>((resolve) => {
      this.craftJob = { recipe: r, remaining: duration, duration, resolve };
    });
  }

  /** Abort the running craft (releasing the hold button, closing the panel, dying). */
  cancelCraft(): boolean {
    const job = this.craftJob;
    if (!job) return false;
    this.craftJob = null;
    this.ctx.bus.emit('craft:failed', { recipeId: job.recipe.id, reason: 'cancelled' });
    job.resolve(null);
    this.ui?.refreshCraft();
    return true;
  }

  /** 0..1 progress of the running craft (null when idle). */
  craftProgress(): { recipeId: string; progress: number } | null {
    const job = this.craftJob;
    if (!job) return null;
    return { recipeId: job.recipe.id, progress: 1 - Math.max(0, job.remaining) / Math.max(0.001, job.duration) };
  }

  private updateCraft(dt: number): void {
    const job = this.craftJob;
    if (!job || dt <= 0) return;
    job.remaining -= dt;
    if (job.remaining > 0) { this.ui?.refreshCraft(); return; }
    this.craftJob = null;
    const r = job.recipe;
    const outDef = ITEM_DEF_MAP.get(r.outputDefId);
    if (!this.canCraft(r.id) || !outDef) {
      this.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'missing' });
      job.resolve(null);
      this.ui?.refreshCraft();
      return;
    }
    const product = this.loot.createItem(r.outputDefId, Math.min(outDef.stackMax, r.outputQty));
    if (!this.bag.canAbsorb(product)) {
      this.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'space' });
      this.ctx.bus.emit('ui:notify', { text: '가방에 공간이 없습니다', kind: 'warning' });
      job.resolve(null);
      this.ui?.refreshCraft();
      return;
    }
    for (const i of this.craftCost(r)) this.consumeDef(i.defId, i.qty);
    const made = this.addUnits(r.outputDefId, r.outputQty);
    const first = made[0] ?? product;
    this.ctx.bus.emit('inventory:itemAdded', { item: first, name: outDef.name, rarity: outDef.rarity });
    this.ctx.bus.emit('craft:completed', { recipeId: r.id, item: first });
    this.ctx.bus.emit('audio:play', { id: 'craft_done' });
    this.afterChange();
    this.ui?.refreshCraft();
    job.resolve(first);
  }

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
      if (p.item.qty <= 0) this.removeEmptyStack(p.item);
      else this.bag.version++;
    }
    if (consumed > 0) this.afterChange();
    return consumed;
  }

  /* ── quick-use wheel (InventoryRef) ────────────────────────────────────── */

  /** Wheel slots resolved to live bag items (null = empty or the stack left the bag). */
  getQuickSlots(): readonly (ItemInstance | null)[] {
    return this.quickSlots.map((uid) => (uid === null ? null : this.bag.get(uid)?.item ?? null));
  }

  /** Usable wheel slots for the equipped bag (clamped to QUICK_SLOTS; tactical legendary bags define 9). */
  getQuickSlotCount(): number {
    return Math.min(QUICK_SLOTS, this.getBagSize().quickSlots);
  }

  /**
   * Assign bag item `uid` (stim / grenade) to wheel slot `index`, or clear it with null. A uid lives in one slot
   * only, so assigning it elsewhere moves it. Locked slots (`!isQuickSlotActive(index, getQuickSlotCount())`,
   * unlock order N S E W then diagonals) can be cleared but not filled.
   */
  setQuickSlot(index: number, uid: string | null): boolean {
    if (!isQuickIndex(index)) return false;
    if (uid !== null) {
      const item = this.bag.get(uid)?.item;
      if (!item || !isQuickUsable(ITEM_DEF_MAP.get(item.defId))) return false;
      if (!isQuickSlotActive(index, this.getQuickSlotCount())) return false;
    }
    if (assignQuickSlot(this.quickSlots, index, uid)) {
      this.bag.version++; // bag tiles carry the direction badge
      this.syncQuickSlots();
      this.ui?.refresh();
    }
    return true;
  }

  /** Slot index of bag item `uid`, or -1 (UI badges / menu state). */
  quickIndexOf(uid: string): number { return quickSlotOf(this.quickSlots, uid); }

  /** Context menu `빠른 슬롯에 등록`: first free usable slot. 'noop' when already assigned, 'fail' when none is free / not usable. */
  registerQuick(uid: string): OpResult {
    if (this.quickIndexOf(uid) >= 0) return 'noop';
    const index = firstFreeQuickSlot(this.quickSlots, this.getQuickSlotCount());
    if (index < 0) return 'fail';
    return this.setQuickSlot(index, uid) ? 'ok' : 'fail';
  }

  /**
   * Weapons: a stim was injected / a grenade thrown from this exact bag stack. Removes up to `qty` units and
   * returns the count. At 0 the stack leaves the bag (`inventory:itemRemoved`); its wheel slot moves to another
   * stack of the same item when one is free, else clears (`inventory:quickSlotsChanged`).
   */
  consumeItem(uid: string, qty = 1): number {
    const p = this.bag.get(uid);
    const n = Math.min(Math.max(0, Math.floor(qty)), p?.item.qty ?? 0);
    if (!p || n <= 0) return 0;
    p.item.qty -= n;
    if (p.item.qty <= 0) this.removeEmptyStack(p.item);
    else this.bag.version++;
    this.afterChange();
    return n;
  }

  /** A bag stack hit 0: drop it from the grid, hand its wheel slot to a sibling stack of the same def, emit removed. */
  private removeEmptyStack(item: ItemInstance): void {
    this.bag.remove(item.uid);
    if (quickSlotOf(this.quickSlots, item.uid) >= 0) {
      const sibling = this.bag.items().find((q) => q.item.defId === item.defId && !this.quickSlots.includes(q.item.uid));
      if (sibling) relinkQuickSlot(this.quickSlots, item.uid, sibling.item.uid);
    }
    this.ctx.bus.emit('inventory:itemRemoved', { item });
  }

  /** Prune slots whose stack left the bag, then emit `inventory:quickSlotsChanged` when anything the HUD shows changed. */
  private syncQuickSlots(): void {
    pruneQuickSlots(this.quickSlots, (uid) => this.bag.has(uid));
    const active = this.getQuickSlotCount();
    const sig = quickSlotsSignature(this.quickSlots, (uid) => this.bag.get(uid)?.item ?? null, active);
    if (sig === this.lastQuickSig) return;
    this.lastQuickSig = sig;
    this.ctx.bus.emit('inventory:quickSlotsChanged', { slots: [...this.getQuickSlots()], active });
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

  /**
   * Drop `qty` units (default: the whole stack) of `uid` into the world. Searches the bag, the open container
   * and the equipment slots. Emits `inventory:itemRemoved` (player-owned only), `loadout:changed` (slots) and
   * `inventory:itemDropped` — `pickups/` spawns the world object from that. Weapons travel whole (sockets,
   * durability, rounds stay on the instance). Dropping the equipped bag shrinks the grid first (`changeBag`).
   */
  dropItem(uid: string, qty?: number): boolean {
    // in the ship `throwToWorld` lands the item in the stash first (no ground to drop onto)
    const found = this.locate(uid);
    if (!found) return false;
    const { item, from } = found;
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) return false;
    const want = qty === undefined ? item.qty : Math.floor(qty);
    if (!Number.isFinite(want) || want < 1) return false;
    const n = Math.min(want, item.qty);

    if (from.kind === 'slot' && from.slot === 'bag') return this.changeBag(null, null, 'world') === 'ok';

    let dropped: ItemInstance;
    if (n >= item.qty) {
      this.detach(item, from);
      dropped = item;
    } else {
      dropped = this.loot.createItem(item.defId, n);
      item.qty -= n;
      if (from.kind === 'grid') { const g = this.getGrid(from.grid); if (g) g.version++; }
    }
    this.throwToWorld(dropped, this.locKind(from) === 'player');
    if (from.kind === 'slot') this.emitLoadout();
    this.afterChange();
    return true;
  }

  /**
   * Split `qty` units off stack `uid` into a brand-new stack placed at the first free slot of the same grid.
   * False when the item is not stackable, `qty` is not in 1..qty-1, or there is no free cell.
   */
  splitItem(uid: string, qty: number): boolean {
    const found = this.locateInGrids(uid);
    if (!found) return false;
    const { item, grid } = found;
    const def = ITEM_DEF_MAP.get(item.defId);
    const n = Math.floor(qty);
    if (!def || def.stackMax <= 1 || !Number.isFinite(n) || n < 1 || n >= item.qty) return false;
    const created = this.loot.createItem(item.defId, n);
    const slot = grid.findFreeSlot(created, item.rotated);
    if (!slot || !grid.place(created, slot.x, slot.y, slot.rotated)) return false;
    item.qty -= n;
    this.ctx.bus.emit('inventory:itemSplit', { source: item, created });
    this.afterChange();
    return true;
  }

  /** Any player-owned item: bag → equipment slots → attachments socketed in an owned weapon. */
  findItem(uid: string, from?: ItemLocation): ItemInstance | null {
    if (from) {
      if (from.kind === 'slot') return this.loadout[from.slot]?.uid === uid ? (this.loadout[from.slot] ?? null) : null;
      return this.getGrid(from.grid)?.get(uid)?.item ?? null;
    }
    const p = this.bag.get(uid);
    if (p) return p.item;
    for (const s of LOADOUT_SLOTS) {
      const it = this.loadout[s];
      if (it?.uid === uid) return it;
    }
    return findSocketed(this.ownedWeapons(), uid)?.item ?? null;
  }

  /** Patch persistent instance fields (weapons write `ammoInMag` / `durability` here every shot). */
  updateItem(uid: string, patch: Partial<Pick<ItemInstance, 'durability' | 'ammoInMag'>>): boolean {
    const item = this.findItem(uid);
    if (!item) return false;
    if (patch.durability !== undefined) item.durability = Math.max(0, patch.durability);
    if (patch.ammoInMag !== undefined) item.ammoInMag = Math.max(0, patch.ammoInMag);
    if (this.bag.has(uid)) this.bag.version++;
    this.ctx.bus.emit('inventory:itemUpdated', { item });
    this.afterChange();
    return true;
  }

  /** Socket a bag (or open-container) attachment into a player-owned weapon; see `attachFrom`. */
  attachToWeapon(weaponUid: string, attachmentUid: string): boolean {
    const w = this.locate(weaponUid);
    const a = this.locate(attachmentUid);
    if (!w || !a || a.from.kind !== 'grid') return false;
    return this.attachFrom(attachmentUid, a.from, weaponUid, w.from) === 'ok';
  }

  /** Every attachment of weapon `uid` back into the bag (overflow drops to the ground). False when none / not found. */
  detachAllSockets(uid: string): boolean {
    const w = this.locate(uid);
    if (!w || this.locKind(w.from) !== 'player' || !isWeaponItemDef(ITEM_DEF_MAP.get(w.item.defId))) return false;
    const weapon = w.item;
    let n = 0;
    for (const socket of SOCKET_SLOTS) {
      const att = clearSocket(weapon, socket);
      if (!att) continue;
      n++;
      if (!this.bag.autoPlace(att)) this.throwToWorld(att, true);
      this.ctx.bus.emit('inventory:socketChanged', { weapon, socket, attachment: null });
    }
    if (n === 0) return false;
    this.afterSocketChange(weapon);
    this.afterChange();
    return true;
  }

  /** Magazine → bag as ammo of the weapon's calibre (merge into stacks, new stacks, overflow drops). */
  unloadWeapon(uid: string): boolean {
    const w = this.locate(uid);
    if (!w || this.locKind(w.from) !== 'player') return false;
    const weapon = w.item;
    const stats = this.loot.getEffectiveStats(weapon);
    const rounds = Math.floor(weapon.ammoInMag ?? 0);
    if (!stats || rounds <= 0) return false;
    weapon.ammoInMag = 0;
    this.returnRounds(stats.ammoType, rounds);
    if (this.bag.has(weapon.uid)) this.bag.version++;
    this.ctx.bus.emit('inventory:itemUpdated', { item: weapon });
    this.afterChange();
    return true;
  }

  /** Workbench repair: all materials from `LootRef.getRepairCost` or nothing. */
  repairWeapon(uid: string): boolean {
    const w = this.locate(uid);
    if (!w || this.locKind(w.from) !== 'player') return false;
    const weapon = w.item;
    const stats = this.loot.getEffectiveStats(weapon);
    const cost = this.loot.getRepairCost(weapon);
    if (!stats || cost.length === 0) return false;
    for (const c of cost) if (this.countWhere((d) => d.id === c.defId) < c.qty) return false;
    for (const c of cost) this.consumeWhere((d) => d.id === c.defId, c.qty);
    weapon.durability = stats.maxDurability;
    if (this.bag.has(weapon.uid)) this.bag.version++;
    this.ctx.bus.emit('inventory:itemUpdated', { item: weapon });
    this.afterChange();
    return true;
  }

  /** Equip a bag / container item into `slot`, move a weapon between the primary slots, or unequip with null. */
  equip(uid: string | null, slot: LoadoutSlot): boolean {
    if (uid === null) {
      const cur = this.loadout[slot];
      if (!cur) return false;
      return this.quickMove(cur.uid, { kind: 'slot', slot }) === 'ok';
    }
    const found = this.locate(uid);
    const def = found && ITEM_DEF_MAP.get(found.item.defId);
    if (!found || !def) return false;
    return this.dropOnSlot(found.item, def, found.from, slot) === 'ok';
  }

  /** Context menu `창고로 이동` on an equipped item (hub only): unequip straight into the stash. The bag slot shrinks the grid first. */
  moveToStash(uid: string, from: ItemLocation): OpResult {
    if (!this.hubMode) return 'fail';
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    if (from.kind === 'grid' && from.grid === 'stash') return 'noop';
    if (from.kind === 'slot' && from.slot === 'bag') {
      // bag → grid first (its contents must survive the shrink), then the bag itself → stash
      const r = this.changeBag(null, null, 'grid');
      if (r !== 'ok') return r;
      const found = this.locate(uid);
      if (!found || found.from.kind !== 'grid') return 'ok';
      from = found.from;
    }
    const stash = this.stash.grid;
    if (!stash.canAbsorb(item)) { this.ctx.bus.emit('ui:notify', { text: '창고에 공간이 없습니다', kind: 'warning' }); return 'fail'; }
    this.detach(item, from);
    stash.autoPlace(item);
    this.afterMove(item, from, { kind: 'grid', grid: 'stash' });
    return 'ok';
  }

  /** Quick chat: ammo request for weapons, "<name> 필요" for anything else (`chat:post`, kind 'request'). */
  requestItem(uid: string, from: ItemLocation): boolean {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return false;
    const stats = this.loot.getEffectiveStats(item);
    const text = stats ? `탄약 요청: ${def.name} (${AMMO_LABEL_KO[stats.ammoType]})` : `${def.name} 필요`;
    this.ctx.bus.emit('chat:post', { text, kind: 'request' });
    return true;
  }

  openContainer(containerId: string, tier: number, position: THREE.Vector3): void {
    const c = this.containers.getOrCreate(containerId, tier, position, this.loot, this.missionSeed);
    this.showContainer(c);
  }

  /**
   * Loot window for a container whose contents the caller supplies (corpses: `ctx.loot.rollCorpse`).
   * `items` are placed only on the first open of `containerId` (largest-first on the fixed 6×4 grid,
   * overflow dropped with a warning); a known id shows what is left. Title defaults to `컨테이너`.
   */
  openContainerItems(containerId: string, items: ItemInstance[], position: THREE.Vector3, title?: string): void {
    const c = this.containers.getOrCreateWithItems(containerId, items, position, title);
    this.showContainer(c);
  }

  private showContainer(c: Container): void {
    this.activeContainer = c;
    this.hubMode = false;
    this.setOpen(true);
    this.ui?.show(c, false);
    this.ctx.bus.emit('inventory:opened', { containerId: c.id });
    this.checkLooted();
  }

  toggleBag(): void {
    if (this._open) { this.closeAll(); return; }
    this.activeContainer = null;
    this.hubMode = this.ctx.isHubPhase();
    this.setOpen(true);
    this.ui?.show(null, this.hubMode);
    this.ctx.bus.emit('inventory:opened', { containerId: null });
  }

  /** true while the hub screen (with the stash) is what the window shows. */
  get isHubScreen(): boolean { return this._open && this.hubMode; }

  /** Ship stash grid (persisted). */
  getStash(): Grid { return this.stash.grid; }
  getStashItems(): ItemInstance[] { return this.stash.items(); }

  /* ── Phase 5 skeleton (2026-09-06): stubs until the inventory agent implements corp-shop access ── */
  findItemAnywhere(uid: string): ItemInstance | null { return this.findItem(uid) ?? this.stash.grid.get(uid)?.item ?? null; }
  tryAddToStash(_item: ItemInstance): boolean { return false; }
  tryAddItemAnywhere(item: ItemInstance): 'bag' | 'stash' | null { return this.tryAddItem(item) ? 'bag' : null; }
  takeItem(_uid: string, _qty?: number): number { return 0; }

  /** 캐릭터 tab: hand over to progression's character sheet (it owns its own blocker token). */
  openCharacter(): void {
    if (!this.ctx.progression) { this.ctx.bus.emit('ui:notify', { text: '캐릭터 정보를 사용할 수 없습니다', kind: 'warning' }); return; }
    this.closeAll(false);
    this.ctx.bus.emit('ui:statsToggled', { open: true });
  }

  closeAll(relock = true): void {
    if (!this._open) return;
    this.closeCatalog();
    this.closeBench();
    this.activeContainer = null;
    this.hubMode = false;
    this.setOpen(false);
    this.ui?.hide();
    this.ctx.bus.emit('inventory:closed', {});
    // Re-acquire the pointer when we return to gameplay. The Tab/Esc press (or click) that
    // closed the window is the user activation Chrome requires for requestPointerLock().
    // Deferred a microtask so callers that close us right before leaving gameplay
    // (GameFlow complete/abort → setPhase) are seen by the check.
    const ctx = this.ctx;
    if (!relock) return;
    queueMicrotask(() => {
      if (this._open || !(ctx.isGameplayPhase() || ctx.isHubPhase()) || ctx.uiBlockers.size > 0) return;
      if (ctx.player?.isDead ?? false) return;
      ctx.input.requestPointerLock();
    });
  }

  /** Back to the starter kit (also closes windows and forgets rolled containers). */
  reset(): void {
    this.closeAll();
    this.containers.clear();
    this.applyStarter();
  }

  /* ── UI-facing operations ──────────────────────────────────────────────── */

  getGrid(id: GridId): Grid | null {
    if (id === 'bag') return this.bag;
    if (id === 'stash') return this.stash.grid;
    return this.activeContainer?.grid ?? null;
  }
  getActiveContainer(): Container | null { return this.activeContainer; }
  getLoot(): LootService { return this.loot; }
  getStats(item: ItemInstance): EffectiveWeaponStats | null { return this.loot.getEffectiveStats(item); }

  sfx(id: UiSfx): void { this.ctx.bus.emit('audio:play', { id }); }

  /** Find an item anywhere (bag → container → slots). */
  locate(uid: string): { item: ItemInstance; from: ItemLocation } | null {
    const inGrid = this.locateInGrids(uid);
    if (inGrid) return { item: inGrid.item, from: { kind: 'grid', grid: inGrid.gridId } };
    for (const slot of LOADOUT_SLOTS) {
      const it = this.loadout[slot];
      if (it?.uid === uid) return { item: it, from: { kind: 'slot', slot } };
    }
    return null;
  }

  private locateInGrids(uid: string): { item: ItemInstance; grid: Grid; gridId: GridId } | null {
    for (const gridId of ['bag', 'container', 'stash'] as const) {
      const grid = this.getGrid(gridId);
      const p = grid?.get(uid);
      if (grid && p) return { item: p.item, grid, gridId };
    }
    return null;
  }

  /** Slot a double-click / `장착` sends a weapon to: first empty primary slot, else 주무기 I (swap). Armor / bags → their slot. */
  equipTargetFor(def: ItemDef): LoadoutSlot | null {
    if (def.category === 'bag') return 'bag';
    if (def.category === 'armor') return 'armor';
    if (def.category === 'secondary') return 'secondary';
    if (def.category !== 'primary') return null;
    if (!this.loadout.primary) return 'primary';
    if (!this.loadout.primary2) return 'primary2';
    return 'primary';
  }

  /** Split size a Shift (half) / Ctrl (one) drag would carry, or null when the item cannot be split. */
  partialQtyFor(item: ItemInstance, mode: 'half' | 'one'): number | null {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || def.stackMax <= 1 || item.qty < 2) return null;
    return mode === 'one' ? 1 : Math.max(1, Math.floor(item.qty / 2));
  }

  /** Non-mutating classification of a partial-stack drag (`qty` units of `uid`) onto `target`. */
  previewPartial(uid: string, from: ItemLocation, qty: number, target: DropTarget): DropPreview {
    const v = this.validatePartial(uid, from, qty, target);
    if (!v) return 'bad';
    const { item, def, grid, blockers } = v;
    if (blockers.length === 0) return 'ok';
    if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
    if (blockers[0] === uid) return 'noop';
    const other = grid.get(blockers[0]);
    return other && other.item.defId === item.defId && other.item.qty < def.stackMax ? 'merge' : 'bad';
  }

  /**
   * Execute a partial-stack drag: onto a free cell → new stack of `qty` there; onto a same-def stack → merge
   * (capped by `stackMax`); onto the source or anything else → nothing.
   */
  dropPartial(uid: string, from: ItemLocation, qty: number, target: DropTarget): OpResult {
    const v = this.validatePartial(uid, from, qty, target);
    if (!v || target.kind !== 'grid' || from.kind !== 'grid') return 'fail';
    const { item, def, grid, blockers } = v;
    const to: ItemLocation = { kind: 'grid', grid: target.grid };
    const srcGrid = this.getGrid(from.grid);
    if (!srcGrid) return 'fail';

    if (blockers.length === 0) {
      const created = this.loot.createItem(item.defId, qty);
      if (!grid.place(created, target.x, target.y, target.rotated)) return 'fail';
      item.qty -= qty;
      srcGrid.version++;
      if (this.locKind(from) !== this.locKind(to)) this.emitTransfer(created, def, from, to);
      this.ctx.bus.emit('inventory:itemSplit', { source: item, created });
      this.afterChange();
      return 'ok';
    }
    if (blockers.length !== 1 || blockers[0] === OOB) return 'fail';
    if (blockers[0] === uid) return 'noop';
    const other = grid.get(blockers[0]);
    if (!other || other.item.defId !== item.defId) return 'fail';
    const moved = Math.min(def.stackMax - other.item.qty, qty);
    if (moved <= 0) return 'fail';
    other.item.qty += moved;
    item.qty -= moved;
    grid.version++;
    srcGrid.version++;
    if (this.locKind(from) !== this.locKind(to)) this.emitTransfer({ ...item, qty: moved }, def, from, to);
    this.afterChange();
    return 'ok';
  }

  private validatePartial(uid: string, from: ItemLocation, qty: number, target: DropTarget):
    { item: ItemInstance; def: ItemDef; grid: Grid; blockers: string[] } | null {
    if (from.kind !== 'grid' || target.kind !== 'grid') return null;
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def || def.stackMax <= 1) return null;
    const n = Math.floor(qty);
    if (!Number.isFinite(n) || n < 1 || n >= item.qty) return null;
    const grid = this.getGrid(target.grid);
    if (!grid) return null;
    const probe: ItemInstance = { uid: '__split__', defId: item.defId, qty: n, rotated: target.rotated };
    return { item, def, grid, blockers: grid.blockersAt(probe, target.x, target.y, target.rotated, probe.uid) };
  }

  /** Non-mutating classification used for the drag highlight. */
  previewDrop(uid: string, from: ItemLocation, target: DropTarget): DropPreview {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'bad';

    if (target.kind === 'weapon') return this.previewAttach(uid, from, target.uid, target.loc);

    if (target.kind === 'quick') {
      if (from.kind !== 'grid' || from.grid !== 'bag' || !isQuickUsable(def)) return 'bad';
      if (!isQuickIndex(target.index) || !isQuickSlotActive(target.index, this.getQuickSlotCount())) return 'bad';
      return this.quickSlots[target.index] === uid ? 'noop' : this.quickSlots[target.index] ? 'swap' : 'ok';
    }

    if (target.kind === 'slot') {
      if (!slotAccepts(def, target.slot)) return 'bad';
      const current = this.loadout[target.slot];
      if (from.kind === 'slot') {
        if (from.slot === target.slot) return 'noop';
        if (target.slot === 'bag' || from.slot === 'bag') return 'bad';
        return current ? 'swap' : 'ok';
      }
      if (!current) return 'ok';
      if (target.slot === 'bag') return 'swap'; // the displaced bag is placed first in the resized grid
      return this.canPlaceDisplaced(current, from, uid) ? 'swap' : 'bad';
    }

    const grid = this.getGrid(target.grid);
    if (!grid) return 'bad';
    if (from.kind === 'grid' && from.grid === target.grid) {
      const p = grid.get(uid);
      if (p && p.x === target.x && p.y === target.y && item.rotated === target.rotated) return 'noop';
    }
    const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, uid);
    if (from.kind === 'slot' && from.slot === 'bag' && target.grid !== 'bag') return 'bad';
    if (blockers.length === 0) return 'ok';
    if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
    const other = grid.get(blockers[0]);
    if (!other) return 'bad';
    if (other.item.defId === item.defId && def.stackMax > 1 && other.item.qty < def.stackMax) return 'merge';
    if (from.kind === 'slot') {
      const od = ITEM_DEF_MAP.get(other.item.defId);
      return od && slotAccepts(od, from.slot) ? 'swap' : 'bad';
    }
    return this.canSwap(item, from.grid, other.item, grid) ? 'swap' : 'bad';
  }

  /** Execute a drag-and-drop. */
  drop(uid: string, from: ItemLocation, target: DropTarget): OpResult {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    if (target.kind === 'weapon') return this.attachFrom(uid, from, target.uid, target.loc);
    if (target.kind === 'quick') {
      const pv = this.previewDrop(uid, from, target);
      if (pv === 'bad') return 'fail';
      if (pv === 'noop') return 'noop';
      return this.setQuickSlot(target.index, uid) ? 'ok' : 'fail';
    }
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

    // the equipped bag dragged into the grid: unequip (grid shrinks, bag lands at the target cell if it still exists)
    if (from.kind === 'slot' && from.slot === 'bag') {
      if (target.grid !== 'bag') return 'fail';
      if (blockers.length === 0) return this.changeBag(null, null, 'grid', { x: target.x, y: target.y });
      if (blockers.length !== 1) return 'fail';
      const other = grid.get(blockers[0]);
      const od = other && ITEM_DEF_MAP.get(other.item.defId);
      if (!other || !od || od.category !== 'bag') return 'fail';
      return this.changeBag(other.item, to, 'grid', { x: other.x, y: other.y });
    }

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
        // the whole stack merged away: its wheel slot follows the surviving stack
        if (target.grid === 'bag') relinkQuickSlot(this.quickSlots, item.uid, other.item.uid);
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
      if (!od || !slotAccepts(od, from.slot)) return 'fail';
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

  /** Right-click quick action: container ↔ bag auto-place; slot → bag (the bag slot shrinks the grid first). */
  quickMove(uid: string, from: ItemLocation): OpResult {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    if (from.kind === 'slot' && from.slot === 'bag') return this.changeBag(null, null, 'grid');
    let dest: GridId;
    if (from.kind === 'slot') dest = 'bag';
    else if (from.grid === 'container' || from.grid === 'stash') dest = 'bag';
    else if (this.activeContainer) dest = 'container';
    else if (this.hubMode) dest = 'stash';
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

  /** Double-click: weapons / bags equip (`equipTargetFor`), anything else quick-moves. */
  activate(uid: string, from: ItemLocation): OpResult {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    const slot = this.equipTargetFor(def);
    if (slot) {
      if (from.kind === 'slot') return 'noop';
      return this.dropOnSlot(item, def, from, slot);
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

  /* ── sockets (UI drag path) ────────────────────────────────────────────── */

  /** Can attachment `uid` (at `from`) be socketed into weapon `weaponUid` (at `loc`)? */
  previewAttach(uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): DropPreview {
    const att = this.findItem(uid, from);
    const attDef = att && ITEM_DEF_MAP.get(att.defId);
    const weapon = this.findItem(weaponUid, loc);
    if (!att || !attDef?.attachment || !weapon || from.kind !== 'grid') return 'bad';
    if (this.locKind(loc) !== 'player' || !isWeaponItemDef(ITEM_DEF_MAP.get(weapon.defId))) return 'bad';
    if (!this.loot.canAttach(weapon, att)) return 'bad';
    return weapon.sockets?.[attDef.attachment.socket] ? 'swap' : 'ok';
  }

  /**
   * Socket attachment `uid` into weapon `weaponUid`. The previous attachment in that socket returns to the bag
   * (or drops to the ground when nothing fits). Emits `inventory:socketChanged`, `inventory:itemUpdated`.
   */
  attachFrom(uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): OpResult {
    if (this.previewAttach(uid, from, weaponUid, loc) === 'bad' || from.kind !== 'grid') return 'fail';
    const att = this.findItem(uid, from)!;
    const attDef = ITEM_DEF_MAP.get(att.defId)!;
    const weapon = this.findItem(weaponUid, loc)!;
    const socket: SocketSlot = attDef.attachment!.socket;
    const grid = this.getGrid(from.grid);
    if (!grid) return 'fail';
    grid.remove(att.uid);
    const prev = setSocket(weapon, socket, att);
    if (from.grid === 'container') this.ctx.bus.emit('inventory:itemAdded', { item: att, name: attDef.name, rarity: attDef.rarity });
    if (prev && !this.bag.autoPlace(prev)) this.throwToWorld(prev, true);
    if (this.bag.has(weapon.uid)) this.bag.version++;
    this.ctx.bus.emit('inventory:socketChanged', { weapon, socket, attachment: att });
    this.afterSocketChange(weapon);
    this.afterChange();
    return 'ok';
  }

  /** After a socket change: a smaller magazine spills its excess rounds into the bag; weapons re-read the instance. */
  private afterSocketChange(weapon: ItemInstance): void {
    const stats = this.loot.getEffectiveStats(weapon);
    if (stats && weapon.ammoInMag !== undefined && weapon.ammoInMag > stats.magSize) {
      const excess = weapon.ammoInMag - stats.magSize;
      weapon.ammoInMag = stats.magSize;
      this.returnRounds(stats.ammoType, excess);
    }
    this.ctx.bus.emit('inventory:itemUpdated', { item: weapon });
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

  /** 'player' = bag / loadout (HUD counts, sockets); the crate and the stash are 'container'. */
  private locKind(loc: ItemLocation): 'player' | 'container' {
    return loc.kind === 'grid' && loc.grid !== 'bag' ? 'container' : 'player';
  }

  private bagSizeOf(item: ItemInstance | null): BagSize {
    const b = item ? ITEM_DEF_MAP.get(item.defId)?.bag : undefined;
    return b
      ? { cols: b.cols, rows: b.rows, quickSlots: b.quickSlots }
      : { cols: BAG_DEFAULT_COLS, rows: BAG_DEFAULT_ROWS, quickSlots: BAG_DEFAULT_QUICK_SLOTS };
  }

  /** Weapons the player owns (slots + bag), for socket lookups. */
  private *ownedWeapons(): Iterable<ItemInstance> {
    for (const s of WEAPON_SLOT_IDS) { const it = this.loadout[s]; if (it) yield it; }
    for (const p of this.bag.items()) if (isWeaponItemDef(ITEM_DEF_MAP.get(p.item.defId))) yield p.item;
  }

  /**
   * Add `qty` units of `defId` to the bag: merge into existing stacks, then new stacks (chunked by `stackMax`).
   * Returns the stacks that did not fit (never placed anywhere — caller drops or discards them).
   */
  private addUnits(defId: string, qty: number): ItemInstance[] {
    const def = ITEM_DEF_MAP.get(defId);
    const overflow: ItemInstance[] = [];
    if (!def) return overflow;
    let left = Math.max(0, Math.floor(qty));
    while (left > 0) {
      const chunk = Math.min(def.stackMax, left);
      left -= chunk;
      const item = this.loot.createItem(defId, chunk);
      if (this.bag.mergeIntoStacks(item) <= 0) continue;
      if (!this.bag.autoPlace(item)) overflow.push(item);
    }
    return overflow;
  }

  /** Rounds of `type` back into the bag (unload / mag downgrade); what does not fit lands on the ground. */
  private returnRounds(type: EffectiveWeaponStats['ammoType'], rounds: number): void {
    for (const stack of this.addUnits(ammoItemIdFor(type), rounds)) this.throwToWorld(stack, false);
  }

  /** Emit the world drop for `item` (already detached). `owned` → also `inventory:itemRemoved` (HUD counts). */
  private throwToWorld(item: ItemInstance, owned: boolean): void {
    // in the ship an overflowing item (bag swap, socket swap) lands in the stash instead of vanishing
    if (this.ctx.isHubPhase() && this.stash.grid.autoPlace(item)) {
      if (owned) this.ctx.bus.emit('inventory:itemRemoved', { item });
      this.ctx.bus.emit('ui:notify', { text: `${ITEM_DEF_MAP.get(item.defId)?.name ?? item.defId} → 함선 창고`, kind: 'info', duration: 2 });
      return;
    }
    if (owned) this.ctx.bus.emit('inventory:itemRemoved', { item });
    const position = new THREE.Vector3();
    const velocity = new THREE.Vector3();
    const player = this.ctx.player;
    if (player) {
      const forward = player.getForward(new THREE.Vector3());
      player.getEyePosition(position);
      position.y -= DROP_EYE_LOWER;
      position.addScaledVector(forward, DROP_FORWARD_OFFSET);
      velocity.copy(forward).multiplyScalar(DROP_FORWARD_SPEED);
      velocity.y += DROP_UP_SPEED;
    }
    this.ctx.bus.emit('inventory:itemDropped', { item, position, velocity });
  }

  /**
   * Equip `next` (null = unequip) as the bag. The grid is resized to the new bag; the displaced bag is placed
   * first (at `hint`, else the new bag's former cells, else the first free slot), everything else is relocated
   * around it and whatever no longer fits is dropped into the world (`inventory:bagChanged.dropped`).
   * Refused (nothing changes) only when the displaced bag itself cannot fit the new grid at all.
   * `from` null with a `next` = a detached instance (catalog drag) that lives in no grid yet.
   */
  private changeBag(next: ItemInstance | null, from: ItemLocation | null, oldTo: 'grid' | 'world', hint?: { x: number; y: number }): OpResult {
    const old = this.loadout.bag;
    if (!next && !old) return 'noop';
    if (next && old && next.uid === old.uid) return 'noop';
    const nextDef = next ? ITEM_DEF_MAP.get(next.defId) : undefined;
    if (next && !nextDef?.bag) return 'fail';

    const snap = this.bag.snapshot();
    const srcGrid = from?.kind === 'grid' ? this.getGrid(from.grid) : null;
    let srcPos: Placement | undefined;
    if (next && from) {
      if (from.kind !== 'grid' || !srcGrid) return 'fail';
      srcPos = srcGrid.get(next.uid);
      if (!srcPos) return 'fail';
      srcGrid.remove(next.uid);
    }
    const size = this.bagSizeOf(next);
    const priority: PriorityPlacement[] = [];
    if (old && oldTo === 'grid') {
      const h = hint ?? (from?.kind === 'grid' && from.grid === 'bag' && srcPos ? { x: srcPos.x, y: srcPos.y } : undefined);
      priority.push({ item: old, x: h?.x, y: h?.y });
    }
    const overflow = this.bag.resize(size.cols, size.rows, priority);
    if (old && oldTo === 'grid' && overflow.includes(old)) {
      this.bag.restore(snap);
      if (next && srcGrid && srcPos) srcGrid.place(next, srcPos.x, srcPos.y, next.rotated);
      return 'fail';
    }
    this.loadout.bag = next;
    if (next && nextDef && from) this.emitTransfer(next, nextDef, from, { kind: 'slot', slot: 'bag' });
    for (const it of overflow) this.throwToWorld(it, true);
    if (old && oldTo === 'world') this.throwToWorld(old, true);
    if (overflow.length > 0) {
      this.ctx.bus.emit('ui:notify', { text: `가방 공간 부족: 아이템 ${overflow.length}개를 바닥에 떨어뜨렸습니다`, kind: 'warning' });
    }
    this.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: overflow });
    this.emitLoadout();
    this.afterChange();
    return 'ok';
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
    const l = this.loadout;
    this.ctx.bus.emit('loadout:changed', { primary: l.primary, secondary: l.secondary, primary2: l.primary2, bag: l.bag, armor: l.armor ?? null });
    for (const slot of LOADOUT_SLOTS) {
      const uid = l[slot]?.uid ?? null;
      if (this.lastEquipUids[slot] === uid) continue;
      this.lastEquipUids[slot] = uid;
      this.ctx.bus.emit('equip:changed', { slot, item: l[slot] ?? null });
    }
  }

  private afterChange(): void {
    const grenades = this.countWhere((d) => d.category === 'grenade');
    const stims = this.countWhere((d) => d.category === 'stim');
    if (grenades !== this.lastGrenades) { this.lastGrenades = grenades; this.ctx.bus.emit('grenade:countChanged', { count: grenades }); }
    if (stims !== this.lastStims) { this.lastStims = stims; this.ctx.bus.emit('stim:countChanged', { count: stims }); }
    this.syncQuickSlots();
    this.emitWeight();
    this.ctx.bus.emit('inventory:changed', { totalValue: this.bag.totalValue(), itemCount: this.bag.count });
    if (this.stash.grid.version !== this.lastStashVersion) {
      this.lastStashVersion = this.stash.grid.version;
      this.stash.markDirty();
      this.ctx.bus.emit('inventory:stashChanged', { count: this.stash.count });
    }
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

  /** Can `current` (being displaced from a weapon slot) be placed where the dragged item came from, or anywhere sensible? */
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
    if (!slotAccepts(def, slot)) return 'fail';
    if (from.kind === 'slot') {
      if (from.slot === slot) return 'noop';
      if (slot === 'bag' || from.slot === 'bag' || slot === 'armor' || from.slot === 'armor') return 'fail';
      // 주무기 I ↔ 주무기 II (both slots accept the same category, so the swap is always valid)
      const cur = this.loadout[slot];
      if (cur && !slotAccepts(ITEM_DEF_MAP.get(cur.defId)!, from.slot)) return 'fail';
      this.loadout[slot] = item;
      this.loadout[from.slot] = cur ?? null;
      this.emitLoadout();
      this.afterChange();
      return 'ok';
    }
    if (slot === 'bag') return this.changeBag(item, from, 'grid');
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

/** Attachments socketed in `weapon` (socket order) — re-exported for the UI. */
export { attachedItems };
