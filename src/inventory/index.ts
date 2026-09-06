export { InventorySystem, LOADOUT_SLOTS, WEAPON_SLOT_IDS, slotAccepts, isWeaponDef, isAttachmentDef, isBagDef } from './InventorySystem';
export type { GridId, SlotId, ItemLocation, DropTarget, OpResult, DropPreview, UiSfx, BagSize } from './InventorySystem';
export { Grid, OOB } from './Grid';
export type { Placement, Footprint, SlotHint, DefLookup, Ignore, PriorityPlacement, GridSnapshot } from './Grid';
export { socketOf, socketContent, attachedItems, filledSocketCount, setSocket, clearSocket, clearAllSockets, findSocketed } from './Sockets';
export {
  QUICK_AUTO_GRENADE, QUICK_AUTO_STIM, createQuickSlots, isQuickUsable, isQuickIndex, quickSlotOf, firstFreeQuickSlot, assignQuickSlot,
  clearQuickSlotOf, relinkQuickSlot, pruneQuickSlots, autoAssignQuickSlots, quickSlotsSignature,
} from './QuickSlots';
export type { QuickSlotUids } from './QuickSlots';
export { Container, ContainerStore, CONTAINER_COLS, CONTAINER_ROWS } from './Container';
export { runInventorySelfTest } from './__selftest__';
/* Phase 5: loadout persistence + shared item serialisation */
export { LoadoutStore, LOADOUT_SAVE_VERSION, loadLoadoutSave, isEmptyLoadoutSave } from './Loadout';
export type { LoadoutSave } from './Loadout';
export { serializeExtras, serializePlacement, reviveItem, readSaveFile, writeSaveFile, safeStorage, savedCell } from './Serialize';
export type { SavedExtras, SavedPlacement } from './Serialize';
