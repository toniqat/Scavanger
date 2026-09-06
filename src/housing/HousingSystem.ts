import type {
  CraftIngredient, FacilityId, FacilityInfo, FurnitureDef, GameContext, GameSystem, HousingRef, LoadoutPreset, PlacedFurniture,
  ProfileRef, RoomPurpose, RoomState, ShipState, SkillId, StoredFurniture, WorkbenchKind,
} from '@/shared';
import { FURNITURE_DEFS, FURNITURE_DEF_MAP, IMPLANT_IDS, benchKindOf } from '@/shared';
import {
  canPlaceAt, craftCostMulFor, facilityBlockReason, facilityLevel, facilityMaxLevel, facilityName, furnitureAllowedIn,
  furnitureUpgradeReason, isRoomIndex, isRoomPurpose, missingIngredients, nextFacilityCost, nextFurnitureCost, presetCountFor,
  purposeChangeReason, skillGainMulFor, stashSizeFor,
} from './Rules';
import { ShipStore, freshRoom, loadState, maxUidIndex, sanitize, writeState } from './ShipState';
import { RoomMenu } from './ui/RoomMenu';
import { FacilityMenu } from './ui/FacilityMenu';
import { PresetMenu } from './ui/PresetMenu';
import type { HousingPanel } from './ui/Panel';
import './housing.css';

const FACILITY_IDS: readonly FacilityId[] = ['generator', 'storage', 'workshop', 'range'];
const PRESET_NAME_MAX = 24;

/**
 * Ship housing (함선 꾸미기): owns the ShipState (rooms / facilities / furniture / presets), every rule and number
 * (see Rules.ts), persistence (ShipState.ts) and the three DOM panels (ui/). Publishes `ctx.housing`.
 * hub/ builds the geometry and the housing-mode camera / cursor on top of this API and its `housing:*` events.
 *
 * Materials come from `ctx.inventory.countDefAll / consumeDefAll` (bag + stash); both are guarded with `typeof`
 * because inventory/ is built in parallel — without them nothing can be bought.
 * Phase 7: the state is mirrored into the server profile document `ship` on every save; `net:profileLoaded` replaces
 * it with the server copy and re-emits `housing:loaded` so hub/ rebuilds the personal ship.
 */
export class HousingSystem implements GameSystem, HousingRef {
  readonly name = 'housing';
  state: ShipState;
  housingMode = false;
  housingRoom: number | null = null;
  selectedFurniture: string | null = null;
  selectedYaw: 0 | 1 | 2 | 3 = 0;

  private ctx!: GameContext;
  private store: ShipStore | null = null;
  private nextUid = 0;
  private fresh = false;
  private unsubs: Array<() => void> = [];
  private roomMenu: RoomMenu | null = null;
  private facilityMenu: FacilityMenu | null = null;
  private presetMenu: PresetMenu | null = null;
  private lastStash = { cols: 0, rows: 0 };

  constructor() {
    const loaded = loadState();
    this.state = loaded.state;
    this.fresh = loaded.fresh;
    this.nextUid = maxUidIndex(this.state.furniture);
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.housing = this;
    this.store = new ShipStore(() => this.state, () => this.profileRef());
    if (this.fresh) this.store.markDirty();
    this.roomMenu = new RoomMenu(ctx, this);
    this.facilityMenu = new FacilityMenu(ctx, this);
    this.presetMenu = new PresetMenu(ctx, this);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('game:abort', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('hub:left', () => { this.closeMenus(); this.exitHousingMode(); }),
      b.on('game:phaseChanged', ({ phase }) => { if (phase !== 'hub') { this.closeMenus(); this.exitHousingMode(); } }),
      b.on('net:profileLoaded', () => this.onProfileLoaded()),
    );
    b.emit('housing:loaded', { state: this.state });
    this.lastStash = this.getStashSize();
    b.emit('housing:stashSizeChanged', { ...this.lastStash });
  }

  update(_dt: number, ctx: GameContext): void {
    if (this.housingMode && (ctx.phase !== 'hub' || ctx.hub?.ship !== 'personal')) this.exitHousingMode();
  }

  dispose(): void {
    this.closeMenus();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.roomMenu?.dispose(); this.facilityMenu?.dispose(); this.presetMenu?.dispose();
    this.roomMenu = this.facilityMenu = this.presetMenu = null;
    this.store?.dispose(); this.store = null;
  }

  /* ── server profile (Phase 7) ──────────────────────────────────────────── */
  private profileRef(): ProfileRef | null {
    const p = this.ctx?.net?.profile;
    return p && typeof p === 'object' ? p : null;
  }

  /**
   * `net:profileLoaded`: the server `ship` document (sanitised like a local load) replaces the state — housing mode and
   * panels close first, `housing:loaded` + `housing:changed {reason:'profile'}` fire so hub/ rebuilds the personal
   * ship, and the stash size event follows when the storage level differs. No document yet → the local state is
   * uploaded instead.
   */
  private onProfileLoaded(): void {
    const p = this.profileRef();
    if (!p || !p.available) return;
    let doc: unknown;
    try { doc = p.get('ship'); } catch { doc = undefined; }
    if (!doc || typeof doc !== 'object') { this.store?.upload(); return; }
    this.closeMenus();
    this.exitHousingMode();
    this.store?.cancel();
    this.state = sanitize(doc);
    this.nextUid = maxUidIndex(this.state.furniture);
    this.fresh = false;
    writeState(this.state);                      // localStorage is the cache of the server copy (not re-uploaded)
    const b = this.ctx.bus;
    b.emit('housing:loaded', { state: this.state });
    b.emit('housing:changed', { reason: 'profile' });
    this.emitStashSizeIfChanged();
  }

  /* ── helpers ───────────────────────────────────────────────────────────── */
  private changed(reason: string): void {
    this.store?.markDirty();
    this.ctx.bus.emit('housing:changed', { reason });
  }

  /** Units of `defId` in bag + stash (0 while inventory has no `countDefAll`). */
  countDef = (defId: string): number => {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.countDefAll !== 'function') return 0;
    return inv.countDefAll(defId);
  };

  /** 한국어 item name for cost lines. */
  nameOf = (defId: string): string => this.ctx.loot?.getItemDef(defId)?.name ?? defId;

  private canAfford(cost: readonly CraftIngredient[]): boolean {
    return missingIngredients(cost, this.countDef).length === 0;
  }

  /** All-or-nothing: verified with `countDef` first, then consumed def by def. */
  private consume(cost: readonly CraftIngredient[]): boolean {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.consumeDefAll !== 'function') return false;
    if (!this.canAfford(cost)) return false;
    for (const c of cost) if (!inv.consumeDefAll(c.defId, c.qty)) return false;
    return true;
  }

  private notify(text: string, kind: 'info' | 'warning' | 'danger' | 'success' = 'info'): void {
    this.ctx.bus.emit('ui:notify', { text, kind });
  }

  private storageEntry(defId: string): StoredFurniture | null {
    let best: StoredFurniture | null = null;
    for (const s of this.state.furnitureStorage) if (s.defId === defId && s.qty > 0 && (!best || s.level > best.level)) best = s;
    return best;
  }

  private addToStorage(defId: string, level: number, qty = 1): void {
    const e = this.state.furnitureStorage.find((s) => s.defId === defId && s.level === level);
    if (e) e.qty += qty; else this.state.furnitureStorage.push({ defId, level, qty });
  }

  private takeFromStorage(entry: StoredFurniture): void {
    entry.qty -= 1;
    if (entry.qty <= 0) this.state.furnitureStorage.splice(this.state.furnitureStorage.indexOf(entry), 1);
  }

  private emitStashSizeIfChanged(): void {
    const size = this.getStashSize();
    if (size.cols === this.lastStash.cols && size.rows === this.lastStash.rows) return;
    this.lastStash = size;
    this.ctx.bus.emit('housing:stashSizeChanged', { ...size });
  }

  /* ── housing mode ──────────────────────────────────────────────────────── */
  /** Why housing mode cannot start for `room`; null = fine. */
  housingModeBlock(room: number): string | null {
    const ctx = this.ctx;
    if (!isRoomIndex(this.state, room)) return '없는 방입니다';
    if (ctx.phase !== 'hub') return '함선에서만 꾸밀 수 있습니다';
    if (ctx.hub?.ship !== 'personal') return '개인 함선에서만 꾸밀 수 있습니다';
    // hub's `currentRoom` is null in the corridor / cockpit: the player has to stand inside the room being decorated
    if (ctx.hub.currentRoom !== room) return `방 ${room + 1} 안에서만 꾸밀 수 있습니다`;
    return null;
  }

  enterHousingMode(room: number): boolean {
    if (this.housingModeBlock(room)) return false;
    this.closeMenus();
    if (this.housingMode && this.housingRoom === room) return true;
    this.housingMode = true;
    this.housingRoom = room;
    this.selectedFurniture = null;
    this.selectedYaw = 0;
    this.ctx.bus.emit('housing:modeChanged', { active: true, room });
    this.ctx.bus.emit('housing:selectionChanged', { defId: null, yaw: 0 });
    return true;
  }

  exitHousingMode(): void {
    if (!this.housingMode) return;
    this.housingMode = false;
    this.housingRoom = null;
    this.selectedFurniture = null;
    this.selectedYaw = 0;
    this.ctx.bus.emit('housing:modeChanged', { active: false, room: null });
  }

  /** `null` clears the selection; a def that is not in furniture storage is ignored (selection unchanged). */
  selectFurniture(defId: string | null): void {
    if (defId !== null && (!FURNITURE_DEF_MAP.has(defId) || !this.storageEntry(defId))) return;
    if (defId === this.selectedFurniture) return;
    this.selectedFurniture = defId;
    this.ctx.bus.emit('housing:selectionChanged', { defId, yaw: this.selectedYaw });
  }

  rotateSelection(): void {
    this.selectedYaw = ((this.selectedYaw + 1) % 4) as 0 | 1 | 2 | 3;
    this.ctx.bus.emit('housing:selectionChanged', { defId: this.selectedFurniture, yaw: this.selectedYaw });
  }

  /* ── rooms ─────────────────────────────────────────────────────────────── */
  getRoom(index: number): RoomState { return this.state.rooms[index] ?? freshRoom(); }

  /** 한국어 reason `setRoomPurpose` would refuse (null = allowed). Used by the room menu for button hints. */
  purposeBlock(index: number, purpose: RoomPurpose): string | null {
    return purposeChangeReason(this.state, index, purpose);
  }

  setRoomPurpose(index: number, purpose: RoomPurpose): boolean {
    if (!isRoomIndex(this.state, index) || !isRoomPurpose(purpose)) return false;
    const room = this.state.rooms[index];
    if (room.purpose === purpose) return true;
    if (purposeChangeReason(this.state, index, purpose)) return false;
    if (purpose === 'empty') {
      for (const f of this.state.furniture.filter((p) => p.room === index)) this.recover(f.uid);
    }
    // a greenhouse that goes away takes its labs with it
    if (room.purpose === 'greenhouse' && !this.state.rooms.some((r, i) => i !== index && r.purpose === 'greenhouse')) {
      for (let i = 0; i < this.state.rooms.length; i++) if (this.state.rooms[i].purpose === 'lab') this.setRoomPurpose(i, 'empty');
    }
    room.purpose = purpose;
    room.level = purpose === 'empty' ? 0 : 1;
    this.ctx.bus.emit('housing:roomPurposeChanged', { room: index, purpose });
    this.changed('purpose');
    if (this.housingMode && this.housingRoom === index) this.selectFurniture(null);
    return true;
  }

  findRoom(purpose: RoomPurpose): number { return this.state.rooms.findIndex((r) => r.purpose === purpose); }

  /* ── facilities ────────────────────────────────────────────────────────── */
  getFacilities(): FacilityInfo[] { return FACILITY_IDS.map((id) => this.getFacility(id)); }

  getFacility(id: FacilityId): FacilityInfo {
    const level = facilityLevel(this.state, id);
    return {
      id, name: facilityName(id), level, maxLevel: facilityMaxLevel(id),
      nextCost: nextFacilityCost(id, level),
      blocked: facilityBlockReason(this.state, id, this.countDef, this.nameOf),
    };
  }

  upgrade(id: FacilityId): boolean {
    if (!FACILITY_IDS.includes(id)) return false;
    const info = this.getFacility(id);
    if (info.blocked || !info.nextCost) return false;
    if (!this.consume(info.nextCost)) return false;
    const level = info.level + 1;
    if (id === 'generator') this.state.generatorLevel = level;
    else if (id === 'storage') this.state.storageLevel = level;
    else {
      const room = this.state.rooms.find((r) => r.purpose === id);
      if (!room) return false;
      room.level = level;
    }
    this.ctx.bus.emit('housing:facilityUpgraded', { id, level });
    this.changed(`facility:${id}`);
    if (id === 'storage') this.emitStashSizeIfChanged();
    return true;
  }

  getBenchLevel(kind: WorkbenchKind): number {
    let best = 0;
    for (const f of this.state.furniture) {
      const def = FURNITURE_DEF_MAP.get(f.defId);
      if (def && benchKindOf(def.interaction) === kind) best = Math.max(best, f.level);
    }
    return best;
  }

  getCraftCostMul(): number { return craftCostMulFor(facilityLevel(this.state, 'workshop')); }
  getSkillGainMul(skill: SkillId): number { return skillGainMulFor(skill, facilityLevel(this.state, 'range')); }
  getStashSize(): { cols: number; rows: number } { return stashSizeFor(this.state.storageLevel); }

  /* ── furniture ─────────────────────────────────────────────────────────── */
  getFurnitureDef(id: string): FurnitureDef | undefined { return FURNITURE_DEF_MAP.get(id); }
  getAllFurnitureDefs(): readonly FurnitureDef[] { return FURNITURE_DEFS; }
  getFurnitureFor(purpose: RoomPurpose): readonly FurnitureDef[] { return FURNITURE_DEFS.filter((d) => furnitureAllowedIn(d, purpose)); }
  getPlaced(room?: number): readonly PlacedFurniture[] { return room === undefined ? this.state.furniture : this.state.furniture.filter((f) => f.room === room); }
  getPlacedByUid(uid: string): PlacedFurniture | null { return this.state.furniture.find((f) => f.uid === uid) ?? null; }
  getStored(): readonly StoredFurniture[] { return this.state.furnitureStorage; }

  canPlace(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): boolean {
    const def = FURNITURE_DEF_MAP.get(defId);
    return !!def && canPlaceAt(this.state, room, def, x, y, yaw, ignoreUid);
  }

  place(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): PlacedFurniture | null {
    const entry = this.storageEntry(defId);
    if (!entry || !this.canPlace(room, defId, x, y, yaw)) return null;
    this.takeFromStorage(entry);
    const item: PlacedFurniture = { uid: `f-${++this.nextUid}`, defId, room, x, y, yaw, level: entry.level };
    this.state.furniture.push(item);
    this.ctx.bus.emit('housing:furniturePlaced', { item });
    this.changed('place');
    if (this.selectedFurniture === defId && !this.storageEntry(defId)) this.selectFurniture(null);
    return item;
  }

  move(uid: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): boolean {
    const item = this.getPlacedByUid(uid);
    if (!item || !this.canPlace(item.room, item.defId, x, y, yaw, uid)) return false;
    if (item.x === x && item.y === y && item.yaw === yaw) return true;
    item.x = x; item.y = y; item.yaw = yaw;
    this.ctx.bus.emit('housing:furnitureMoved', { item });
    this.changed('move');
    return true;
  }

  recover(uid: string): boolean {
    const i = this.state.furniture.findIndex((f) => f.uid === uid);
    if (i < 0) return false;
    const item = this.state.furniture[i];
    this.state.furniture.splice(i, 1);
    this.addToStorage(item.defId, item.level);
    this.ctx.bus.emit('housing:furnitureRecovered', { uid, defId: item.defId, room: item.room });
    this.changed('recover');
    return true;
  }

  canCraftFurniture(defId: string): { ok: boolean; missing: CraftIngredient[] } {
    const def = FURNITURE_DEF_MAP.get(defId);
    if (!def || !def.craft) return { ok: false, missing: [] };
    const missing = missingIngredients(def.craft, this.countDef);
    return { ok: missing.length === 0, missing };
  }

  craftFurniture(defId: string): boolean {
    const def = FURNITURE_DEF_MAP.get(defId);
    if (!def || !def.craft || !this.canCraftFurniture(defId).ok) return false;
    if (!this.consume(def.craft)) return false;
    this.addToStorage(defId, 1);
    this.changed('craft');
    return true;
  }

  /** 한국어 reason a placed piece cannot be upgraded (null = can). */
  furnitureUpgradeBlock(uid: string): string | null {
    const item = this.getPlacedByUid(uid);
    return item ? furnitureUpgradeReason(this.state, item, this.countDef, this.nameOf) : '설치되지 않은 가구입니다';
  }

  upgradeFurniture(uid: string): boolean {
    const item = this.getPlacedByUid(uid);
    if (!item || furnitureUpgradeReason(this.state, item, this.countDef, this.nameOf)) return false;
    const def = FURNITURE_DEF_MAP.get(item.defId)!;
    const cost = nextFurnitureCost(def, item.level);
    if (!cost || !this.consume(cost)) return false;
    item.level += 1;
    this.ctx.bus.emit('housing:furnitureUpgraded', { item });
    this.changed('furnitureUpgrade');
    return true;
  }

  /* ── loadout presets (사격장) ──────────────────────────────────────────── */
  getPresetCount(): number { return presetCountFor(facilityLevel(this.state, 'range')); }

  getPresets(): readonly (LoadoutPreset | null)[] {
    const n = this.getPresetCount();
    return Array.from({ length: n }, (_, i) => this.state.presets[i] ?? null);
  }

  savePreset(index: number, preset: LoadoutPreset): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.getPresetCount() || !preset) return false;
    const implant = preset.implant && (IMPLANT_IDS as readonly string[]).includes(preset.implant) ? preset.implant : null;
    const copy: LoadoutPreset = {
      name: (preset.name || `프리셋 ${index + 1}`).slice(0, PRESET_NAME_MAX),
      primary: preset.primary ?? null, primary2: preset.primary2 ?? null, secondary: preset.secondary ?? null,
      bag: preset.bag ?? null, armor: preset.armor ?? null, implant,
    };
    while (this.state.presets.length <= index) this.state.presets.push(null);
    this.state.presets[index] = copy;
    this.changed('preset');
    return true;
  }

  deletePreset(index: number): boolean {
    if (!this.state.presets[index]) return false;
    this.state.presets[index] = null;
    while (this.state.presets.length && this.state.presets[this.state.presets.length - 1] === null) this.state.presets.pop();
    this.changed('preset');
    return true;
  }

  applyPreset(index: number): { equipped: number; missing: string[] } | null {
    const preset = index >= 0 && index < this.getPresetCount() ? this.state.presets[index] : null;
    if (!preset || this.ctx.phase !== 'hub') return null;
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.applyLoadout !== 'function') return null;
    const result = inv.applyLoadout(preset);
    this.ctx.bus.emit('housing:presetApplied', { index, equipped: result.equipped, missing: result.missing });
    return result;
  }

  /** Current equipment as a preset (`ctx.inventory.captureLoadout`), null while inventory has no capture yet. */
  captureLoadout(): LoadoutPreset | null {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.captureLoadout !== 'function') return null;
    return inv.captureLoadout();
  }

  /* ── UI ────────────────────────────────────────────────────────────────── */
  private panels(): HousingPanel[] {
    const out: HousingPanel[] = [];
    if (this.roomMenu) out.push(this.roomMenu);
    if (this.facilityMenu) out.push(this.facilityMenu);
    if (this.presetMenu) out.push(this.presetMenu);
    return out;
  }

  get isMenuOpen(): boolean { return this.panels().some((p) => p.isOpen); }

  openRoomMenu(room: number): void {
    if (!isRoomIndex(this.state, room) || !this.roomMenu) return;
    this.exitHousingMode();
    this.closeMenus(false);
    this.roomMenu.openRoom(room);
  }

  openFacilityMenu(): void {
    if (!this.facilityMenu) return;
    this.exitHousingMode();
    this.closeMenus(false);
    this.facilityMenu.open();
  }

  openPresetMenu(): void {
    if (!this.presetMenu) return;
    this.exitHousingMode();
    this.closeMenus(false);
    if (this.getPresetCount() === 0) this.notify('사격장 방이 있어야 프리셋을 쓸 수 있습니다', 'warning');
    this.presetMenu.open();
  }

  /** Close every panel; `relock` false when another panel opens right away. */
  closeMenus(relock = true): void {
    for (const p of this.panels()) if (p.isOpen) p.close(relock);
  }

  save(): void { this.store?.flush(); }
}
