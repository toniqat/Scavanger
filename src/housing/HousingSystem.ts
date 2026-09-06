import type {
  CraftIngredient, FacilityId, FacilityInfo, FurnitureDef, GameContext, GameSystem, HousingRef, LoadoutPreset, PlacedFurniture,
  RoomPurpose, RoomState, ShipState, SkillId, StoredFurniture, WorkbenchKind,
} from '@/shared';
import { FACILITY_LABEL_KO, SHIP_ROOM_COUNT, SHIP_STATE_VERSION, STASH_COLS, STASH_ROWS } from '@/shared';

/**
 * Ship housing (skeleton — TODO(agent housing): implement per docs/PHASE6-PLAN.md).
 * Publishes `ctx.housing`. Every method below is a placeholder returning "nothing happened".
 */
export class HousingSystem implements GameSystem, HousingRef {
  readonly name = 'housing';
  state: ShipState = {
    version: SHIP_STATE_VERSION,
    rooms: Array.from({ length: SHIP_ROOM_COUNT }, (): RoomState => ({ purpose: 'empty', level: 0 })),
    generatorLevel: 0, storageLevel: 0, furniture: [], furnitureStorage: [], presets: [],
  };
  housingMode = false;
  housingRoom: number | null = null;
  selectedFurniture: string | null = null;
  selectedYaw: 0 | 1 | 2 | 3 = 0;
  isMenuOpen = false;

  init(ctx: GameContext): void { ctx.housing = this; }
  update(_dt: number, _ctx: GameContext): void { /* TODO(agent housing) */ }

  enterHousingMode(_room: number): boolean { return false; }
  exitHousingMode(): void { /* TODO */ }
  selectFurniture(_defId: string | null): void { /* TODO */ }
  rotateSelection(): void { /* TODO */ }

  getRoom(index: number): RoomState { return this.state.rooms[index] ?? { purpose: 'empty', level: 0 }; }
  setRoomPurpose(_index: number, _purpose: RoomPurpose): boolean { return false; }
  findRoom(purpose: RoomPurpose): number { return this.state.rooms.findIndex((r) => r.purpose === purpose); }

  getFacilities(): FacilityInfo[] { return (['generator', 'storage', 'workshop', 'range'] as FacilityId[]).map((id) => this.getFacility(id)); }
  getFacility(id: FacilityId): FacilityInfo {
    return { id, name: FACILITY_LABEL_KO[id], level: 0, maxLevel: 0, nextCost: null, blocked: '준비 중' };
  }
  upgrade(_id: FacilityId): boolean { return false; }
  getBenchLevel(_kind: WorkbenchKind): number { return 0; }
  getCraftCostMul(): number { return 1; }
  getSkillGainMul(_skill: SkillId): number { return 1; }
  getStashSize(): { cols: number; rows: number } { return { cols: STASH_COLS, rows: STASH_ROWS }; }

  getFurnitureDef(_id: string): FurnitureDef | undefined { return undefined; }
  getAllFurnitureDefs(): readonly FurnitureDef[] { return []; }
  getFurnitureFor(_purpose: RoomPurpose): readonly FurnitureDef[] { return []; }
  getPlaced(room?: number): readonly PlacedFurniture[] { return room === undefined ? this.state.furniture : this.state.furniture.filter((f) => f.room === room); }
  getPlacedByUid(uid: string): PlacedFurniture | null { return this.state.furniture.find((f) => f.uid === uid) ?? null; }
  getStored(): readonly StoredFurniture[] { return this.state.furnitureStorage; }
  canPlace(): boolean { return false; }
  place(): PlacedFurniture | null { return null; }
  move(): boolean { return false; }
  recover(_uid: string): boolean { return false; }
  canCraftFurniture(_defId: string): { ok: boolean; missing: CraftIngredient[] } { return { ok: false, missing: [] }; }
  craftFurniture(_defId: string): boolean { return false; }
  upgradeFurniture(_uid: string): boolean { return false; }

  getPresetCount(): number { return 0; }
  getPresets(): readonly (LoadoutPreset | null)[] { return this.state.presets; }
  savePreset(): boolean { return false; }
  deletePreset(): boolean { return false; }
  applyPreset(): { equipped: number; missing: string[] } | null { return null; }

  openRoomMenu(_room: number): void { /* TODO */ }
  openFacilityMenu(): void { /* TODO */ }
  openPresetMenu(): void { /* TODO */ }
  closeMenus(): void { /* TODO */ }
  save(): void { /* TODO */ }
}
