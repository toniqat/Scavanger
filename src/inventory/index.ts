export { InventorySystem, LOADOUT_SLOTS, WEAPON_SLOT_IDS, slotAccepts, isWeaponDef, isAttachmentDef, isBagDef } from './InventorySystem';
export type { GridId, SlotId, ItemLocation, DropTarget, OpResult, DropPreview, UiSfx, BagSize } from './InventorySystem';
export { Grid, OOB } from './Grid';
export type { Placement, Footprint, SlotHint, DefLookup, Ignore, PriorityPlacement, GridSnapshot } from './Grid';
export { socketOf, socketContent, attachedItems, filledSocketCount, setSocket, clearSocket, clearAllSockets, findSocketed } from './Sockets';
export {
  QUICK_AUTO_GRENADE, QUICK_AUTO_STIM, createQuickSlots, isQuickUsable, isQuickIndex, quickSlotOf, firstFreeQuickSlot,
  lockedQuickItems, mergeIntoQuick, pickStarterQuick, quickSlotsSignature,
} from './QuickSlots';
export type { QuickSlotItems } from './QuickSlots';
/* 2026-09-10: 퀵슬롯 1:1 교체에서 밀려난 스택이 갈 자리 (미리보기 · 실행이 같은 규칙을 본다) */
export { canQuickSwap, applyQuickSwap } from './QuickSwap';
export type { QuickSwapCell, QuickSwapPlan, QuickSwapWhere } from './QuickSwap';
export { Container, ContainerStore, CONTAINER_COLS, CONTAINER_ROWS } from './Container';
export { runInventorySelfTest } from './__selftest__';
/* Phase 5: loadout persistence + shared item serialisation */
export { LoadoutStore, LOADOUT_SAVE_VERSION, loadLoadoutSave, sanitizeLoadoutSave, isEmptyLoadoutSave } from './Loadout';
/* Phase 7: container search + raid state */
export { searchTimeFor } from './Gear';
export type { RaidInventoryState } from './InventorySystem';
export type { StashSaveFile } from './Stash';
export type { LoadoutSave } from './Loadout';
export { serializeExtras, serializePlacement, reviveItem, readSaveFile, writeSaveFile, safeStorage, savedCell } from './Serialize';
export type { SavedExtras, SavedPlacement } from './Serialize';
/* Phase 8: Tab-screen host, modeless popups, 아이템 분해 */
export { isDisassembleRecipe } from './InventorySystem';
export { Modeless } from './ui/Modeless';
