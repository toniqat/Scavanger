import * as THREE from 'three';
import type {
  CraftRecipe, CraftStation, DurabilityInfo, EquipSlot, GadgetId, GameContext, GameSystem,
  InventoryRef, ItemDef, ItemInstance, Loadout, QuickSlot, WeightInfo,
} from '@/shared';
import { Keys, QUICK_SLOT_KEYS } from '@/shared';
import {
  AMMO_LABEL_KO, BASE_BAG_COLS, BASE_BAG_ROWS, ITEM_DEF_MAP, LootService, STARTER_LOADOUT,
  getRecipe, getWeaponDef, itemWeight,
} from '@/items';
import { Grid, OOB } from './Grid';
import { Container, ContainerStore } from './Container';
import {
  backpackOf, durabilityInfo, gearMultipliers, makeWeightInfo, quickSlotCount, sumWeight,
} from './Gear';
import { InventoryUI } from './ui/InventoryUI';

/* ── UI ↔ system vocabulary ─────────────────────────────────────────────── */
export type GridId = 'bag' | 'container';
/** Equipment slots. Widened by the tactical kit: armor + backpack joined the two weapon slots. */
export type SlotId = EquipSlot;
export type ItemLocation = { kind: 'grid'; grid: GridId } | { kind: 'slot'; slot: SlotId };
export type DropTarget =
  | { kind: 'grid'; grid: GridId; x: number; y: number; rotated: boolean }
  | { kind: 'slot'; slot: SlotId }
  /** Quick-use bar cell (assignment only — the item stays in the bag). */
  | { kind: 'quick'; index: number };
/** `ok` mutated, `noop` nothing to do (drop in place), `fail` refused (UI shakes). */
export type OpResult = 'ok' | 'noop' | 'fail';
export type DropPreview = 'ok' | 'swap' | 'merge' | 'noop' | 'bad';
export type UiSfx = 'ui_pickup' | 'ui_drop' | 'ui_rotate' | 'ui_error' | 'ui_equip';

export const EQUIP_SLOTS: readonly SlotId[] = ['primary', 'secondary', 'armor', 'backpack'];

const AUTO_CLOSE_DISTANCE = 6;
const BLOCKER_TOKEN = 'inventory';
/** World-drop throw: eye position lowered / pushed forward, forward speed + upward pop. */
const DROP_EYE_LOWER = 0.3;
const DROP_FORWARD_OFFSET = 0.4;
const DROP_FORWARD_SPEED = 3.5;
const DROP_UP_SPEED = 2.0;
const MOD_SHIFT = ['ShiftLeft', 'ShiftRight'] as const;
const MOD_CTRL = ['ControlLeft', 'ControlRight'] as const;
/** Minimum craft speed multiplier so a pathological derived value cannot make a craft instant. */
const CRAFT_MIN_SPEED = 0.2;

type FullLoadout = { primary: ItemInstance | null; secondary: ItemInstance | null; armor: ItemInstance | null; backpack: ItemInstance | null };

interface CraftJob {
  recipe: CraftRecipe;
  remaining: number;
  duration: number;
  resolve(item: ItemInstance | null): void;
}

/**
 * Owns the player's bag grid, the four equipment slots, the quick-use bar, the weight budget,
 * gear durability, field crafting and the open loot container.
 * Publishes `ctx.inventory` (this) and `ctx.loot` (LootService).
 */
export class InventorySystem implements GameSystem, InventoryRef {
  readonly name = 'inventory';

  private ctx!: GameContext;
  private loot = new LootService();
  private bag!: Grid;
  private loadout: FullLoadout = { primary: null, secondary: null, armor: null, backpack: null };
  private containers = new ContainerStore((id) => ITEM_DEF_MAP.get(id));
  private activeContainer: Container | null = null;
  private _open = false;
  private missionSeed = 0;
  private lastGrenades = -1;
  private lastStims = -1;
  private ui: InventoryUI | null = null;
  private offs: Array<() => void> = [];

  /* tactical kit state */
  private quickUids: (string | null)[] = [];
  private lastQuickSig = '';
  private lastWeight: WeightInfo | null = null;
  private craftJob: CraftJob | null = null;
  private underhand = false;
  private gridDirty = false;

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
    this.bag = new Grid(BASE_BAG_COLS, BASE_BAG_ROWS, (id) => ITEM_DEF_MAP.get(id));
    this.ui = new InventoryUI(this, ctx);
    this.ui.mount();

    const bus = ctx.bus;
    this.offs.push(
      bus.on('world:ready', ({ seed }) => { this.missionSeed = seed; this.reset(); }),
      bus.on('crate:open', ({ crateId, tier, position }) => this.openContainer(crateId, tier, position)),
      bus.on('player:died', () => { this.cancelCraft(); this.closeAll(); }),
      bus.on('game:abort', () => { this.cancelCraft(); this.closeAll(); this.containers.clear(); }),
      bus.on('game:newMission', () => { this.cancelCraft(); this.closeAll(); this.containers.clear(); }),
      bus.on('game:phaseChanged', () => { if (!this.canBeOpen()) { this.cancelCraft(); this.closeAll(); } }),
      // The throw mode is owned by gadgets/; mirror it so quick-use throws match the HUD.
      bus.on('gadget:throwModeChanged', ({ underhand }) => { this.underhand = underhand; }),
      // Gathered herbs / recovered deployables arrive through tryAddItem, but the world emits this first.
      bus.on('gather:collected', () => { this.gridDirty = true; }),
    );
    // Capture-phase so Escape closes the inventory without also reaching the menu system.
    window.addEventListener('keydown', this.escHandler, true);
  }

  update(dt: number, ctx: GameContext): void {
    if (ctx.input.wasPressed(Keys.INVENTORY) && this.canBeOpen() && (this._open || ctx.uiBlockers.size === 0)) {
      this.toggleBag();
    }
    this.updateQuickKeys(ctx);
    this.updateCraft(dt);
    this.updateSearch(dt);

    if (!this._open) {
      if (this.gridDirty) { this.gridDirty = false; this.afterChange(); }
      return;
    }
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
    this.cancelCraft();
    this.closeAll();
    this.ui?.dispose();
    this.ui = null;
    if (this.ctx?.inventory === this) this.ctx.inventory = null;
  }

  /** Phases where the bag may be opened: gameplay **and** the ship hub (gear, repairs, crafting). */
  private canBeOpen(): boolean {
    return this.ctx.isGameplayPhase() || this.ctx.isHubPhase();
  }

  /* ── InventoryRef ──────────────────────────────────────────────────────── */

  get isOpen(): boolean { return this._open; }

  getLoadout(): Loadout {
    return {
      primary: this.loadout.primary, secondary: this.loadout.secondary,
      armor: this.loadout.armor, backpack: this.loadout.backpack,
    };
  }

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

  /** Remove exactly `qty` units of `defId` from the bag; false (and no change) when there is not enough. */
  consumeDef(defId: string, qty: number): boolean {
    const want = Math.max(0, Math.floor(qty));
    if (want === 0) return true;
    if (this.countDef(defId) < want) return false;
    return this.consumeWhere((d) => d.id === defId, want) === want;
  }

  private countDef(defId: string): number {
    return this.countWhere((d) => d.id === defId);
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
   * `inventory:itemDropped` — `pickups/` spawns the world object from that.
   */
  dropItem(uid: string, qty?: number): boolean {
    const found = this.locate(uid);
    if (!found) return false;
    const { item, from } = found;
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) return false;
    if (from.kind === 'grid' && from.grid === 'container' && this.isHidden(uid)) return false;
    const want = qty === undefined ? item.qty : Math.floor(qty);
    if (!Number.isFinite(want) || want < 1) return false;
    const n = Math.min(want, item.qty);

    let dropped: ItemInstance;
    let rebuiltBag = false;
    if (n >= item.qty) {
      if (from.kind === 'slot' && from.slot === 'backpack') {
        this.loadout.backpack = null;
        this.rebuildBag(null);
        rebuiltBag = true;
      } else {
        this.detach(item, from);
      }
      dropped = item;
    } else {
      dropped = this.loot.createItem(item.defId, n);
      item.qty -= n;
      if (from.kind === 'grid') { const g = this.getGrid(from.grid); if (g) g.version++; }
    }
    if (this.locKind(from) === 'player') this.ctx.bus.emit('inventory:itemRemoved', { item: dropped });
    if (from.kind === 'slot') {
      this.ctx.bus.emit('equip:changed', { slot: from.slot, item: null });
      if (from.slot === 'primary' || from.slot === 'secondary') this.emitLoadout();
    }
    if (rebuiltBag) this.ui?.markGridChanged();

    this.throwToWorld(dropped);
    this.afterChange();
    return true;
  }

  /** Emit the world-drop event for an instance that is already detached from every grid/slot. */
  private throwToWorld(item: ItemInstance): void {
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

  /** Quick chat: ammo request for weapons, "<name> 필요" for anything else (`chat:post`, kind 'request'). */
  requestItem(uid: string, from: ItemLocation): boolean {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return false;
    const weapon = def.weaponId ? getWeaponDef(def.weaponId) : undefined;
    const text = weapon ? `탄약 요청: ${weapon.name} (${AMMO_LABEL_KO[weapon.ammoType]})` : `${def.name} 필요`;
    this.ctx.bus.emit('chat:post', { text, kind: 'request' });
    return true;
  }

  openContainer(containerId: string, tier: number, position: THREE.Vector3): void {
    const mult = gearMultipliers(this.ctx.progression?.derived);
    const c = this.containers.getOrCreate(containerId, tier, position, this.loot, this.missionSeed, mult.searchSpeedMul);
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
    // Re-acquire the pointer when we return to gameplay / the hub. The Tab/Esc press (or click) that
    // closed the window is the user activation Chrome requires for requestPointerLock().
    const ctx = this.ctx;
    queueMicrotask(() => {
      if (this._open || !this.canBeOpen() || ctx.uiBlockers.size > 0) return;
      if (ctx.player?.isDead ?? false) return;
      ctx.input.requestPointerLock();
    });
  }

  reset(): void {
    this.cancelCraft();
    this.closeAll();
    this.containers.clear();
    this.bag.clear();
    this.quickUids = [];
    this.lastQuickSig = '';
    this.lastWeight = null;
    this.loadout = {
      primary: this.loot.createItem(STARTER_LOADOUT.primary),
      secondary: this.loot.createItem(STARTER_LOADOUT.secondary),
      armor: this.loot.createItem(STARTER_LOADOUT.armor),
      backpack: this.loot.createItem(STARTER_LOADOUT.backpack),
    };
    this.rebuildBag(null);
    for (const e of STARTER_LOADOUT.bag) this.bag.autoPlace(this.loot.createItem(e.id, e.qty));
    this.lastGrenades = -1; this.lastStims = -1; // force count events
    for (const slot of EQUIP_SLOTS) this.ctx.bus.emit('equip:changed', { slot, item: this.loadout[slot] });
    this.emitLoadout();
    this.afterChange();
  }

  /* ── gear slots (tactical kit) ─────────────────────────────────────────── */

  getEquipped(slot: EquipSlot): ItemInstance | null { return this.loadout[slot]; }

  /**
   * Equip / unequip a gear slot. `item` must be a def of the matching category; when it is already in the
   * bag / open container it is detached from there and whatever was equipped takes its place (or is dropped
   * when there is no room). Changing the backpack rebuilds the bag grid.
   */
  equip(slot: EquipSlot, item: ItemInstance | null): boolean {
    if (item === null) return this.unequipSlot(slot);
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || def.category !== slot) return false;
    const found = this.locate(item.uid);
    if (found && found.from.kind === 'slot') return found.from.slot === slot;
    if (found && found.from.kind === 'grid') {
      if (found.from.grid === 'container' && this.isHidden(item.uid)) return false;
      return this.dropOnSlot(item, def, found.from, slot) === 'ok';
    }
    // Not held anywhere (starter kit / scripted grants).
    this.setSlotDirect(slot, item);
    return true;
  }

  private unequipSlot(slot: EquipSlot): boolean {
    const cur = this.loadout[slot];
    if (!cur) return true;
    if (slot === 'backpack') {
      this.loadout.backpack = null;
      this.rebuildBag(cur);
      this.ui?.markGridChanged();
    } else {
      this.loadout[slot] = null;
      if (!this.bag.autoPlace(cur)) this.throwToWorld(cur);
    }
    this.ctx.bus.emit('equip:changed', { slot, item: null });
    if (slot === 'primary' || slot === 'secondary') this.emitLoadout();
    this.afterChange();
    return true;
  }

  /** Put `item` into `slot` without touching any grid; the displaced item goes to the bag or the floor. */
  private setSlotDirect(slot: EquipSlot, item: ItemInstance | null): void {
    const old = this.loadout[slot];
    if (slot === 'backpack') {
      this.loadout.backpack = item;
      this.rebuildBag(old);
      this.ui?.markGridChanged();
    } else {
      this.loadout[slot] = item;
      if (old && !this.bag.autoPlace(old)) this.throwToWorld(old);
    }
    this.ctx.bus.emit('equip:changed', { slot, item });
    if (slot === 'primary' || slot === 'secondary') this.emitLoadout();
    this.afterChange();
  }

  /**
   * Rebuild the bag grid for the currently equipped backpack and re-place everything it held.
   * `extra` (the backpack that was just taken off) gets the first placement attempt; anything that no
   * longer fits is thrown on the floor, exactly like a manual drop.
   */
  private rebuildBag(extra: ItemInstance | null): void {
    const bp = backpackOf(this.loadout.backpack, this.gearLookup());
    const cols = bp?.cols ?? BASE_BAG_COLS;
    const rows = bp?.rows ?? BASE_BAG_ROWS;
    const carried = this.bag ? this.bag.items().map((p) => p.item) : [];
    carried.sort((a, b) => this.area(b) - this.area(a));
    this.bag = new Grid(cols, rows, (id) => ITEM_DEF_MAP.get(id));

    const overflow: ItemInstance[] = [];
    const place = (it: ItemInstance): void => { if (!this.bag.autoPlace(it)) overflow.push(it); };
    if (extra) place(extra);
    for (const it of carried) place(it);

    for (const it of overflow) {
      const def = ITEM_DEF_MAP.get(it.defId);
      this.ctx.bus.emit('inventory:itemRemoved', { item: it });
      this.throwToWorld(it);
      if (def) this.ctx.bus.emit('ui:notify', { text: `가방이 작아 ${def.name}을(를) 떨어뜨렸습니다`, kind: 'warning' });
    }
    this.pruneQuick();
  }

  private gearLookup() {
    return {
      getDef: (id: string) => ITEM_DEF_MAP.get(id),
      getArmorDef: (id: string) => this.loot.getArmorDef(id),
      getBackpackDef: (id: string) => this.loot.getBackpackDef(id),
    };
  }

  /* ── weight ────────────────────────────────────────────────────────────── */

  getWeight(): WeightInfo {
    const mult = gearMultipliers(this.ctx.progression?.derived);
    let w = sumWeight(this.bag.items().map((p) => p.item), (id) => ITEM_DEF_MAP.get(id));
    for (const slot of EQUIP_SLOTS) {
      const it = this.loadout[slot];
      if (!it) continue;
      const d = ITEM_DEF_MAP.get(it.defId);
      if (d) w += itemWeight(d, it.qty);
    }
    const bp = backpackOf(this.loadout.backpack, this.gearLookup());
    const capacity = mult.carryCapacity + (bp?.capacityBonus ?? 0);
    return makeWeightInfo(Math.round(w * 100) / 100, capacity, mult.carryRelief);
  }

  private emitWeight(): void {
    const info = this.getWeight();
    const prev = this.lastWeight;
    const same = prev && prev.state === info.state
      && Math.abs(prev.weight - info.weight) < 0.005 && Math.abs(prev.capacity - info.capacity) < 0.005;
    if (same) return;
    this.lastWeight = info;
    this.ctx.bus.emit('inventory:weightChanged', {
      weight: info.weight, capacity: info.capacity, ratio: info.ratio, state: info.state,
    });
    if ((!prev || prev.state !== info.state) && (info.state === 'heavy' || info.state === 'over')) {
      this.ctx.bus.emit('inventory:overloaded', { state: info.state });
    }
  }

  /* ── quick-use bar ─────────────────────────────────────────────────────── */

  get quickSlotCount(): number {
    return Math.min(QUICK_SLOT_KEYS.length, quickSlotCount(backpackOf(this.loadout.backpack, this.gearLookup())));
  }

  getQuickSlots(): readonly QuickSlot[] {
    const n = this.quickSlotCount;
    const out: QuickSlot[] = [];
    for (let i = 0; i < n; i++) {
      const uid = this.quickUids[i] ?? null;
      out.push({ index: i, item: uid ? this.bag.get(uid)?.item ?? null : null });
    }
    return out;
  }

  setQuickSlot(index: number, item: ItemInstance | null): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.quickSlotCount) return false;
    if (item === null) {
      if (!this.quickUids[index]) return false;
      this.quickUids[index] = null;
      this.emitQuick(true);
      return true;
    }
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || def.quickUsable !== true) return false;
    if (!this.bag.has(item.uid)) return false;
    for (let i = 0; i < this.quickUids.length; i++) if (this.quickUids[i] === item.uid) this.quickUids[i] = null;
    this.quickUids[index] = item.uid;
    this.emitQuick(true);
    return true;
  }

  /**
   * Fire quick slot `index`. Stims heal on the spot, gadgets go through `ctx.gadgets.use`, grenades and
   * ammo only announce themselves with `quickbar:used` (weapons owns the actual throw / resupply).
   */
  useQuickSlot(index: number): boolean {
    const slot = this.getQuickSlots()[index];
    const item = slot?.item ?? null;
    if (!item) return false;
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || def.quickUsable !== true) return false;
    const player = this.ctx.player;
    if (player?.isDead) return false;

    if (def.category === 'stim') {
      const mult = gearMultipliers(this.ctx.progression?.derived);
      const heal = (def.healAmount ?? 50) * mult.healPowerMul;
      if (!this.consumeDef(def.id, 1)) return false;
      player?.heal(heal);
      this.ctx.bus.emit('player:stimUsed', { hp: player?.hp ?? 0 });
      this.ctx.bus.emit('audio:play', { id: 'stim_use' });
      this.ctx.bus.emit('quickbar:used', { index, item });
      return true;
    }
    if (def.category === 'gadget') {
      const gadgets = this.ctx.gadgets;
      if (!gadgets || !def.gadgetId) {
        this.ctx.bus.emit('ui:notify', { text: '지금은 사용할 수 없습니다', kind: 'warning' });
        return false;
      }
      if (!gadgets.use(def.gadgetId as GadgetId, this.underhand)) return false;
      this.ctx.bus.emit('quickbar:used', { index, item });
      return true;
    }
    // grenades / ammo packs: weapons/ owns the throw and the resupply.
    this.ctx.bus.emit('quickbar:used', { index, item });
    return true;
  }

  private updateQuickKeys(ctx: GameContext): void {
    if (this._open || !ctx.isGameplayActive()) return;
    const n = this.quickSlotCount;
    for (let i = 0; i < n; i++) {
      if (ctx.input.wasPressed(QUICK_SLOT_KEYS[i])) this.useQuickSlot(i);
    }
  }

  /**
   * Drop stale uids and auto-fill empty slots with unassigned quick-usable bag items so the bar is
   * useful without any manual setup. Emits `quickbar:changed` when the resolved contents changed.
   */
  private pruneQuick(): void {
    const n = this.quickSlotCount;
    this.quickUids.length = Math.max(this.quickUids.length, n);
    for (let i = 0; i < this.quickUids.length; i++) {
      const uid = this.quickUids[i];
      if (uid && !this.bag.has(uid)) this.quickUids[i] = null;
    }
    const assigned = new Set(this.quickUids.filter((u): u is string => !!u));
    for (let i = 0; i < n; i++) {
      if (this.quickUids[i]) continue;
      const p = this.bag.items().find((q) => {
        if (assigned.has(q.item.uid)) return false;
        const d = ITEM_DEF_MAP.get(q.item.defId);
        return !!d && d.quickUsable === true;
      });
      if (!p) break;
      this.quickUids[i] = p.item.uid;
      assigned.add(p.item.uid);
    }
  }

  private emitQuick(force = false): void {
    const slots = this.getQuickSlots();
    const sig = slots.map((s) => (s.item ? `${s.item.defId}:${s.item.qty}` : '-')).join('|');
    if (!force && sig === this.lastQuickSig) return;
    this.lastQuickSig = sig;
    this.ctx.bus.emit('quickbar:changed', { slots: slots.map((s) => s.item) });
    this.ui?.refreshQuick();
  }

  /* ── durability ────────────────────────────────────────────────────────── */

  getDurability(uid: string): DurabilityInfo | null {
    const found = this.locateAny(uid);
    if (!found) return null;
    const def = ITEM_DEF_MAP.get(found.item.defId);
    return def ? durabilityInfo(found.item, def) : null;
  }

  damageDurability(uid: string, amount: number): void {
    const wear = Math.max(0, amount);
    if (wear === 0) return;
    const found = this.locateAny(uid);
    if (!found) return;
    const def = ITEM_DEF_MAP.get(found.item.defId);
    const max = def?.durabilityMax;
    if (!def || max === undefined || max <= 0) return;
    const before = Math.max(0, Math.min(max, found.item.durability ?? max));
    if (before <= 0) return;
    const after = Math.max(0, before - wear);
    if (after === before) return;
    found.item.durability = after;
    this.ctx.bus.emit('durability:changed', { uid, defId: def.id, durability: after, max });
    if (after <= 0) {
      this.ctx.bus.emit('durability:broken', { uid, defId: def.id, name: def.name });
      this.ctx.bus.emit('ui:notify', { text: `${def.name} 파손!`, kind: 'danger' });
      this.ctx.bus.emit('audio:play', { id: 'gear_broken' });
    }
    this.gridDirty = true;
    if (this._open) this.ui?.refresh();
  }

  /** Repair a worn item to full. Ship only (`ctx.isRaidActive()` refuses). */
  repair(uid: string): boolean {
    if (this.ctx.isRaidActive()) return false;
    const found = this.locateAny(uid);
    if (!found) return false;
    const def = ITEM_DEF_MAP.get(found.item.defId);
    const max = def?.durabilityMax;
    if (!def || max === undefined || max <= 0) return false;
    if ((found.item.durability ?? max) >= max) return false;
    found.item.durability = max;
    this.ctx.bus.emit('durability:changed', { uid, defId: def.id, durability: max, max });
    this.ctx.bus.emit('repair:completed', { uid, name: def.name, durability: max });
    this.ctx.bus.emit('audio:play', { id: 'gear_repair' });
    this.afterChange();
    return true;
  }

  /** Every item the player owns that tracks durability (bag + equipped). Used by the ship repair bench. */
  getRepairables(): Array<{ item: ItemInstance; def: ItemDef; info: DurabilityInfo }> {
    const out: Array<{ item: ItemInstance; def: ItemDef; info: DurabilityInfo }> = [];
    const add = (item: ItemInstance | null): void => {
      if (!item) return;
      const def = ITEM_DEF_MAP.get(item.defId);
      if (!def) return;
      const info = durabilityInfo(item, def);
      if (info && info.durability < info.max) out.push({ item, def, info });
    };
    for (const slot of EQUIP_SLOTS) add(this.loadout[slot]);
    for (const p of this.bag.items()) add(p.item);
    return out;
  }

  /* ── field crafting ────────────────────────────────────────────────────── */

  /** 'ship' while walking the hub / menus, 'field' on a mission. */
  currentStation(): CraftStation {
    return this.ctx.isRaidActive() ? 'field' : 'ship';
  }

  getRecipes(station: CraftStation): readonly CraftRecipe[] {
    const skillOf = (id: CraftRecipe['skill']): number => this.ctx.progression?.getSkill(id) ?? 0;
    return this.loot.getAllRecipes().filter((r) => {
      if (station === 'field' && r.station !== 'field') return false;
      return skillOf(r.skill) >= r.skillRequired;
    });
  }

  canCraft(recipeId: string): boolean {
    const r = getRecipe(recipeId);
    if (!r) return false;
    return r.inputs.every((i) => this.countDef(i.defId) >= i.qty);
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
    if (this.getRecipes(this.currentStation()).indexOf(r) < 0) {
      this.ctx.bus.emit('craft:failed', { recipeId, reason: 'missing' });
      return Promise.resolve(null);
    }
    if (!this.canCraft(recipeId)) {
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

  /** 0..1 progress of the running craft (0 when idle). */
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
    if (!this.canCraft(r.id)) {
      this.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'missing' });
      job.resolve(null);
      this.ui?.refreshCraft();
      return;
    }
    const outDef = ITEM_DEF_MAP.get(r.outputDefId);
    if (!outDef) { this.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'missing' }); job.resolve(null); return; }
    const product = this.loot.createItem(r.outputDefId, Math.min(outDef.stackMax, r.outputQty));
    if (!this.bag.canAbsorb(product)) {
      this.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'space' });
      this.ctx.bus.emit('ui:notify', { text: '가방에 공간이 없습니다', kind: 'warning' });
      job.resolve(null);
      this.ui?.refreshCraft();
      return;
    }
    for (const i of r.inputs) this.consumeDef(i.defId, i.qty);
    // Overflow beyond one stack is produced as extra stacks (or dropped when the bag is full).
    let remaining = r.outputQty;
    let first: ItemInstance | null = null;
    while (remaining > 0) {
      const qty = Math.min(outDef.stackMax, remaining);
      const item = remaining === r.outputQty ? product : this.loot.createItem(r.outputDefId, qty);
      item.qty = qty;
      remaining -= qty;
      if (!this.bag.autoPlace(item)) { this.throwToWorld(item); }
      else this.ctx.bus.emit('inventory:itemAdded', { item, name: outDef.name, rarity: outDef.rarity });
      if (!first) first = item;
    }
    this.ctx.bus.emit('craft:completed', { recipeId: r.id, item: first ?? product });
    this.ctx.bus.emit('audio:play', { id: 'craft_done' });
    this.afterChange();
    this.ui?.refreshCraft();
    job.resolve(first ?? product);
  }

  /* ── crate search (감정) ───────────────────────────────────────────────── */

  private updateSearch(dt: number): void {
    const c = this.activeContainer;
    if (!c || !this._open || dt <= 0 || c.hiddenCount === 0) return;
    const revealed = c.tickSearch(dt);
    if (revealed.length > 0) {
      this.ctx.bus.emit('audio:play', { id: 'ui_pickup', volume: 0.35 });
      this.ui?.refresh();
    } else {
      this.ui?.refreshSearch();
    }
  }

  /** true while `uid` is still being searched inside the open container. */
  isHidden(uid: string): boolean {
    return this.activeContainer?.isHidden(uid) ?? false;
  }

  searchRemaining(uid: string): number {
    return this.activeContainer?.searchRemaining(uid) ?? 0;
  }

  /* ── UI-facing operations ──────────────────────────────────────────────── */

  getGrid(id: GridId): Grid | null {
    return id === 'bag' ? this.bag : (this.activeContainer?.grid ?? null);
  }
  getActiveContainer(): Container | null { return this.activeContainer; }
  getLoot(): LootService { return this.loot; }

  findItem(uid: string, from: ItemLocation): ItemInstance | null {
    if (from.kind === 'slot') return this.loadout[from.slot]?.uid === uid ? this.loadout[from.slot] : null;
    if (from.grid === 'container' && this.isHidden(uid)) return null;
    return this.getGrid(from.grid)?.get(uid)?.item ?? null;
  }

  sfx(id: UiSfx): void { this.ctx.bus.emit('audio:play', { id }); }

  /** Find an item anywhere (bag → container → slots). */
  locate(uid: string): { item: ItemInstance; from: ItemLocation } | null {
    const inGrid = this.locateInGrids(uid);
    if (inGrid) return { item: inGrid.item, from: { kind: 'grid', grid: inGrid.gridId } };
    for (const slot of EQUIP_SLOTS) {
      const it = this.loadout[slot];
      if (it?.uid === uid) return { item: it, from: { kind: 'slot', slot } };
    }
    return null;
  }

  /** Like `locate` but also matches items that were rolled into an unopened container. */
  private locateAny(uid: string): { item: ItemInstance; from: ItemLocation } | null {
    return this.locate(uid);
  }

  private locateInGrids(uid: string): { item: ItemInstance; grid: Grid; gridId: GridId } | null {
    for (const gridId of ['bag', 'container'] as const) {
      const grid = this.getGrid(gridId);
      const p = grid?.get(uid);
      if (grid && p) return { item: p.item, grid, gridId };
    }
    return null;
  }

  /** Split size a Shift (half) / Ctrl (one) drag would carry, or null when the item cannot be split. */
  partialQtyFor(item: ItemInstance, mode: 'half' | 'one'): number | null {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || def.stackMax <= 1 || item.qty < 2) return null;
    return mode === 'one' ? 1 : Math.max(1, Math.floor(item.qty / 2));
  }

  /** Non-mutating classification of a partial-stack drag (`qty` units of `uid`) onto `target`. */
  previewPartial(uid: string, from: ItemLocation, qty: number, target: DropTarget): DropPreview {
    if (target.kind === 'quick') return 'bad';
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

    if (target.kind === 'quick') {
      if (def.quickUsable !== true) return 'bad';
      if (from.kind !== 'grid' || from.grid !== 'bag') return 'bad';
      if (target.index < 0 || target.index >= this.quickSlotCount) return 'bad';
      return this.quickUids[target.index] === uid ? 'noop' : 'ok';
    }

    if (target.kind === 'slot') {
      if (def.category !== target.slot) return 'bad';
      if (from.kind === 'slot') return from.slot === target.slot ? 'noop' : 'bad';
      const current = this.loadout[target.slot];
      if (!current) return 'ok';
      // Swapping the backpack rebuilds the grid, so the old one always finds a home (or the floor).
      if (target.slot === 'backpack') return 'swap';
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
    if (target.kind === 'quick') {
      if (from.kind !== 'grid' || from.grid !== 'bag') return 'fail';
      if (this.quickUids[target.index] === uid) return 'noop';
      return this.setQuickSlot(target.index, item) ? 'ok' : 'fail';
    }
    if (target.kind === 'slot') return this.dropOnSlot(item, def, from, target.slot);

    const grid = this.getGrid(target.grid);
    if (!grid) return 'fail';
    const to: ItemLocation = { kind: 'grid', grid: target.grid };

    if (from.kind === 'grid' && from.grid === target.grid) {
      const p = grid.get(uid);
      if (p && p.x === target.x && p.y === target.y && item.rotated === target.rotated) return 'noop';
    }

    // Unequipping the backpack into the grid rebuilds the bag: route it through the slot logic.
    if (from.kind === 'slot' && from.slot === 'backpack') {
      const before = this.bag;
      this.unequipSlot('backpack');
      if (this.bag !== before) this.ui?.markGridChanged();
      return 'ok';
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
      this.ctx.bus.emit('equip:changed', { slot: from.slot, item: other.item });
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
    if (from.kind === 'slot') {
      if (from.slot === 'backpack') { this.unequipSlot('backpack'); this.ui?.markGridChanged(); return 'ok'; }
      return this.unequipSlot(from.slot) ? 'ok' : 'fail';
    }
    let dest: GridId;
    if (from.grid === 'container') dest = 'bag';
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

  /** Double-click: gear equips into its slot, anything else quick-moves. */
  activate(uid: string, from: ItemLocation): OpResult {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    if (EQUIP_SLOTS.includes(def.category as SlotId)) {
      if (from.kind === 'slot') return 'noop';
      return this.dropOnSlot(item, def, from, def.category as SlotId);
    }
    return this.quickMove(uid, from);
  }

  rotateItem(uid: string, gridId: GridId): OpResult {
    const grid = this.getGrid(gridId);
    const p = grid?.get(uid);
    if (!grid || !p) return 'fail';
    if (gridId === 'container' && this.isHidden(uid)) return 'fail';
    const def = ITEM_DEF_MAP.get(p.item.defId);
    if (!def || def.width === def.height) return 'noop';
    if (!grid.rotate(uid)) return 'fail';
    this.ctx.bus.emit('inventory:itemRotated', { item: p.item });
    this.afterChange();
    return 'ok';
  }

  /** "모두 가져가기": move every revealed container item into the bag that fits. Returns moved count. */
  takeAll(): number {
    const c = this.activeContainer;
    if (!c) return 0;
    const items = c.grid.items().map((p) => p.item)
      .filter((it) => !c.isHidden(it.uid))
      .sort((a, b) => this.area(b) - this.area(a));
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
    if (from.kind === 'slot') this.ctx.bus.emit('equip:changed', { slot: from.slot, item: null });
    if (to.kind === 'slot') this.ctx.bus.emit('equip:changed', { slot: to.slot, item });
    if (from.kind === 'slot' || to.kind === 'slot') this.emitLoadout();
    this.afterChange();
  }

  /**
   * `loadout:changed` still carries only the two weapon slots (shared contract); armor and backpack
   * changes are announced with `equip:changed`, which every gear consumer listens to.
   */
  private emitLoadout(): void {
    this.ctx.bus.emit('loadout:changed', { primary: this.loadout.primary, secondary: this.loadout.secondary });
  }

  private afterChange(): void {
    const grenades = this.countWhere((d) => d.category === 'grenade');
    const stims = this.countWhere((d) => d.category === 'stim');
    if (grenades !== this.lastGrenades) { this.lastGrenades = grenades; this.ctx.bus.emit('grenade:countChanged', { count: grenades }); }
    if (stims !== this.lastStims) { this.lastStims = stims; this.ctx.bus.emit('stim:countChanged', { count: stims }); }
    this.pruneQuick();
    this.emitQuick();
    this.emitWeight();
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
    if (slot === 'backpack') return this.swapBackpack(item, def, from);
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
    this.ctx.bus.emit('equip:changed', { slot, item });
    if (slot === 'primary' || slot === 'secondary') this.emitLoadout();
    this.afterChange();
    return 'ok';
  }

  /**
   * Backpack swap: the grid itself changes size, so everything is lifted, the new backpack goes on, and
   * the contents (plus the old backpack) are re-placed largest-first. Whatever no longer fits drops.
   */
  private swapBackpack(item: ItemInstance, def: ItemDef, from: ItemLocation): OpResult {
    if (from.kind !== 'grid') return 'fail';
    const srcGrid = this.getGrid(from.grid);
    if (!srcGrid || !srcGrid.has(item.uid)) return 'fail';
    const old = this.loadout.backpack;
    srcGrid.remove(item.uid);
    this.loadout.backpack = item;
    this.rebuildBag(old);
    if (from.grid === 'container') this.emitTransfer(item, def, from, { kind: 'slot', slot: 'backpack' });
    this.ctx.bus.emit('equip:changed', { slot: 'backpack', item });
    this.ui?.markGridChanged();
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
