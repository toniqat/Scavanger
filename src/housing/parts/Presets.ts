/**
 * src/housing/parts/Presets.ts — **loadout presets (retired)**, the panel list · the old menu entry points.
 *
 * 2026-09-12 (user's decision — the ship-management cleanup): the simulation room went, 관물대 retired with it, and
 * **the preset feature itself was removed.** The contract (`HousingRef`) is add-only, so the methods stay — all of them
 * answer 「there are no slots」: `getPresetCount()` 0, `getPresets()` an empty array, `savePreset` false, `applyPreset`
 * null, `openPresetMenu()` does nothing. The save's `ShipState.presets` is **left alone** — `sanitize` reads it and
 * writes it back unchanged. (The save · apply paths were `inventory.captureLoadout` / `applyLoadout`, both still in inventory.)
 */
import type { LoadoutPreset } from '@/shared';
import { isRoomIndex } from '../Rules';
import type { HousingPanel } from '../ui/Panel';
import type { HousingSystem } from '../HousingSystem';

/* ── loadout presets (retired, 2026-09-12) ──────────────────────────────── */
/** Always 0 — the furniture that opens preset slots (관물대) retired. */
export function getPresetCount(_sys: HousingSystem): number { return 0; }

/** Always an empty array (a stored `state.presets` stays in the save untouched). */
export function getPresets(sys: HousingSystem): readonly (LoadoutPreset | null)[] {
  return Array.from({ length: sys.getPresetCount() }, (_, i) => sys.state.presets[i] ?? null);
}

/** Always false — there are no slots. */
export function savePreset(sys: HousingSystem, index: number, preset: LoadoutPreset): boolean {
  return !!preset && Number.isInteger(index) && index >= 0 && index < sys.getPresetCount() && false;
}

/** Always false — with no slots there is nothing to delete (old presets in the save are left alone). */
export function deletePreset(_sys: HousingSystem, _index: number): boolean { return false; }

/** Always null — there are no slots. */
export function applyPreset(sys: HousingSystem, index: number): { equipped: number; missing: string[] } | null {
  return index >= 0 && index < sys.getPresetCount() ? null : null;
}

/** Current equipment as a preset (`ctx.inventory.captureLoadout`), null while inventory has no capture yet. */
export function captureLoadout(sys: HousingSystem): LoadoutPreset | null {
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.captureLoadout !== 'function') return null;
  return inv.captureLoadout();
}

/* ── UI ────────────────────────────────────────────────────────────────── */
export function panels(sys: HousingSystem): HousingPanel[] {
  const out: HousingPanel[] = [];
  if (sys.growStation) out.push(sys.growStation);
  if (sys.analyzerPanel) out.push(sys.analyzerPanel);
  if (sys.cultureTank) out.push(sys.cultureTank);
  if (sys.diningTable) out.push(sys.diningTable);
  if (sys.bookshelfMenu) out.push(sys.bookshelfMenu);
  if (sys.cookStation) out.push(sys.cookStation);          // the cook bench screen (2026-09-13) — the cooking overlay is not a panel (`cookScreen`)
  if (sys.clusterScreen) out.push(sys.clusterScreen);      // the compute cluster screen (2026-09-13, crypto mining)
  if (sys.miningComputer) out.push(sys.miningComputer);    // the main computer (2026-09-13, crypto mining)
  if (sys.tvMenu) out.push(sys.tvMenu);                    // the TV screen (2026-09-13, video games) — `closeMenus` · `isMenuOpen` look at it too
  return out;
}

/**
 * Phase 8 UI pass: the standalone 방 메뉴 and 함선 시설 메뉴 are gone — rooms and facilities are managed from the
 * Tab 함선 tab (`createShipView`) and from 시설 관리. Both entries stay in the contract and redirect there, so an
 * old caller opens the manage screen on that room instead of nothing at all.
 */
export function openRoomMenu(sys: HousingSystem, room: number): void {
  sys.openShipManage(isRoomIndex(sys.state, room) ? room : undefined);
}

export function openFacilityMenu(sys: HousingSystem): void {
  sys.openShipManage();
}

/**
 * 2026-09-12 (the preset feature removed): **does nothing.** The preset menu (`ui/PresetMenu.ts`) was deleted file and
 * all — only the contract's method remains, so an old caller (E on the retired 관물대) ends quietly.
 */
export function openPresetMenu(_sys: HousingSystem): void { /* retired */ }

/** Close every panel; `relock` false when another panel opens right away. */
export function closeMenus(sys: HousingSystem, relock = true): void {
  for (const p of sys.panels()) if (p.isOpen) p.close(relock);
  // 2026-09-16: the stash upgrade modal is not a panel but a direct child of `ctx.uiRoot`, so it is not in `panels()` —
  // it is closed here too, so a forced exit (raid start · ship switch) never leaves it behind alone.
  sys.storageUpgrade?.close();
}
