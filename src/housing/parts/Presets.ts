/**
 * src/housing/parts/Presets.ts — **로드아웃 프리셋 (은퇴)** 과 패널 목록 · 옛 메뉴 진입점.
 *
 * 2026-09-12 (사용자 결정 — 시설관리 정리): 시뮬레이션실이 없어지면서 관물대가 은퇴했고 **프리셋 기능 자체를 걷어냈다.**
 * 계약(`HousingRef`)은 추가만 하므로 메서드는 남는다 — 전부 「슬롯이 없다」로 답한다: `getPresetCount()` 0,
 * `getPresets()` 빈 배열, `savePreset` false, `applyPreset` null, `openPresetMenu()` 는 아무 일도 하지 않는다.
 * 세이브의 `ShipState.presets` 는 **건드리지 않는다** — `sanitize` 가 그대로 읽고 그대로 쓴다.
 * (저장 · 적용 경로는 `inventory.captureLoadout` / `applyLoadout` 이었고 그 둘은 inventory 에 그대로 있다.)
 */
import type { LoadoutPreset } from '@/shared';
import { isRoomIndex } from '../Rules';
import type { HousingPanel } from '../ui/Panel';
import type { HousingSystem } from '../HousingSystem';

/* ── loadout presets (은퇴, 2026-09-12) ─────────────────────────────────── */
/** 늘 0 — 프리셋 슬롯을 여는 가구(관물대)가 은퇴했다. */
export function getPresetCount(_sys: HousingSystem): number { return 0; }

/** 늘 빈 배열 (저장된 `state.presets` 는 세이브에 그대로 남는다). */
export function getPresets(sys: HousingSystem): readonly (LoadoutPreset | null)[] {
  return Array.from({ length: sys.getPresetCount() }, (_, i) => sys.state.presets[i] ?? null);
}

/** 늘 false — 슬롯이 없다. */
export function savePreset(sys: HousingSystem, index: number, preset: LoadoutPreset): boolean {
  return !!preset && Number.isInteger(index) && index >= 0 && index < sys.getPresetCount() && false;
}

/** 늘 false — 슬롯이 없으니 지울 것도 없다 (세이브의 옛 프리셋은 그대로 둔다). */
export function deletePreset(_sys: HousingSystem, _index: number): boolean { return false; }

/** 늘 null — 슬롯이 없다. */
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
 * 2026-09-12 (프리셋 기능 제거): **아무 일도 하지 않는다.** 프리셋 메뉴(`ui/PresetMenu.ts`)는 파일째 지웠다 — 계약의 메서드만
 * 남아 옛 호출자(은퇴한 관물대의 E)가 조용히 끝난다.
 */
export function openPresetMenu(_sys: HousingSystem): void { /* retired */ }

/** Close every panel; `relock` false when another panel opens right away. */
export function closeMenus(sys: HousingSystem, relock = true): void {
  for (const p of sys.panels()) if (p.isOpen) p.close(relock);
}
