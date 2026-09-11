/**
 * src/inventory/ui/parts/ContextMenu.ts — **우클릭 메뉴 · 수량 분할 · 버리기**.
 *
 * 아이템마다 무엇을 할 수 있는지(장착 · 수리 · 분해 · 장전 탄약 탈착 · 소켓 탈착 · 창고로 이동 ·
 * 버리기 · 채팅에 올리기)를 한곳에서 정한다. 실제 동작은 전부 `ctx.inventory` 를 부르고,
 * 이 파일은 **어떤 항목을 보여줄지**만 결정한다.
 */
import type { EmbeddedView, GameContext, ItemDef, ItemInstance } from '@/shared';
import { Keys, QUICK_SLOTS, QUICK_SLOT_LABEL_KO, isQuickSlotActive, keyLabel, renderItemCost } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import type { Container } from '../../Container';
import { LOADOUT_SLOTS, isArmorDef, isAttachmentDef, isBagDef, isPouchDef, isWeaponDef, type DropTarget, type GridId, type InventorySystem, type ItemLocation, type SlotId } from '../../InventorySystem';
import { CraftPanel } from '../CraftPanel';
import { CatalogView } from '../CatalogView';
import { DisassemblePanel } from '../DisassemblePanel';
import { filledSocketCount } from '../../Sockets';
import { isQuickUsable } from '../../QuickSlots';
import { GridView, buildTileContent, type HighlightState } from '../GridView';
import { Tooltip } from '../Tooltip';
import { ContextMenu, type MenuEntry } from '../ContextMenu';
import { SplitDialog } from '../SplitDialog';
import { QUICK_DIR_GLYPH, QUICK_ROSE_ORDER, SLOT_LABEL, STEP, TEXT, fmtValue, slotKeyLabel, tierTitle, tileSize, fmtKg, weightLabel } from '../labels';
import { BAG_LOC, CATALOG_DBL_MS, DRAG_THRESHOLD, type DragState, GHOST_SCALE, LOCK_SVG, MIDDLE_BUTTON, type QuickCell, SCREEN_TABS, type ScreenTab, type SlotView } from '../model';
import type { InventoryUI } from '../InventoryUI';

/**
 * Right-click on a wheel cell: `빠른 슬롯 해제` (assigned cells only).
 * 2026-09-10: 상자를 열어 둔 채라면 `상자로 이동` 도 함께 — 퀵슬롯에서 곧장 상자로 넣는 두 번째 길
 * (첫 번째는 휠 칸을 상자 격자로 끌어다 놓는 것).
 */
export function onQuickContextMenu(sys: InventoryUI, index: number, e: MouseEvent): void {
  if (sys.drag?.started || sys.dialog.isOpen) return;
  sys.menu.close();
  const cell = sys.quickCells[index];
  const uid = cell?.uid;
  if (!uid) return;
  sys.tooltip.hide();
  const from: ItemLocation = { kind: 'quick', index };
  const entries: MenuEntry[] = [
    { label: TEXT.menu.quickClear, run: () => sys.result(sys.sys.setQuickSlot(index, null) ? 'ok' : 'fail', 'ui_drop', BAG_LOC, uid) },
  ];
  if (sys.sys.getActiveContainer()) {
    entries.push({ label: TEXT.menu.toContainer, run: () => sys.result(sys.sys.quickMove(uid, from), 'ui_drop', from, uid) });
  }
  entries.push({ label: TEXT.menu.request, hint: '휠클릭', separator: true, run: () => { sys.sys.requestItem(uid, BAG_LOC); } });
  sys.menu.open(e.clientX, e.clientY, entries);
  }

/**
 * Scheme: plain right-click on a weapon, a bag, armor, worn gear (ship) or a stack with qty ≥ 2 opens the menu; on
 * anything else it performs the quick action directly (container / stash ↔ bag / slot → bag). Shift+right-click
 * always opens the menu.
 */
export function onContextMenu(sys: InventoryUI, uid: string, from: ItemLocation, e: MouseEvent): void {
  if (sys.drag?.started || sys.dialog.isOpen) return;
  sys.menu.close();
  if (sys.locked(uid, from)) return;
  const item = sys.sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return;
  const isStack = def.stackMax > 1 && item.qty >= 2;
  const quickable = isQuickUsable(def) && from.kind === 'grid' && from.grid === 'bag';
  const repairable = sys.hub && !!sys.sys.repairInfo(uid);
  const breakable = sys.canDisassemble(uid, from);
  // A-13: 준비물은 어디서든 우클릭하면 메뉴가 뜬다 (함선에서는 `사용`, 레이드 중에는 잠긴 채로 사유가 보인다)
  // A-3c · A-15 (2026-09-11): 요리(`먹기`)와 주머니(장착)도 마찬가지다
  const hasMenu = isStack || isWeaponDef(def) || isBagDef(def) || isArmorDef(def) || isPouchDef(def)
    || quickable || repairable || breakable || !!def.prep || !!def.meal;
  if (!hasMenu && !e.shiftKey) {
    sys.result(sys.sys.quickMove(uid, from), 'ui_drop', from, uid);
    return;
  }
  sys.tooltip.hide();
  sys.menu.open(e.clientX, e.clientY, sys.menuEntries(uid, from, item, def));
  }

/**
 * Weapons: quick action (장착 / 주무기 II로 장착 / 가방으로 이동 / 상자로 이동 / 창고로 이동) · 수리 (ship, worn gear) ·
 * 장전된 탄약 모두 탈착 (ammo loaded) · 무기 소켓 모두 탈착 (any socket filled) · 탄약 요청 · 버리기 (mission only).
 * Bags / armor: 장착 / 가방으로 이동 · 요청 · 버리기. Attachments are socketed by drag only (no 장착 entry). Stacks add the split entries.
 */
export function menuEntries(sys: InventoryUI, uid: string, from: ItemLocation, item: ItemInstance, def: ItemDef): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const isWeapon = isWeaponDef(def);
  const isStack = def.stackMax > 1 && item.qty >= 2;
  const hasContainer = !!sys.sys.getActiveContainer();
  const quick = () => sys.result(sys.sys.quickMove(uid, from), 'ui_drop', from, uid);
  // A-15: 주머니도 「내가 들고 있는 것」이다 (퀵슬롯과 같다)
  const owned = from.kind === 'slot' || from.kind === 'quick' || from.grid === 'bag' || from.grid === 'pouch';

  // 1. quick action (what a plain right-click / double-click does)
  if (from.kind === 'slot') {
    entries.push({ label: TEXT.menu.toBag, run: quick });
    if (sys.hub) entries.push({ label: TEXT.menu.toStash, run: () => sys.result(sys.sys.moveToStash(uid, from), 'ui_drop', from, uid) });
  } else {
    const target = sys.sys.equipTargetFor(def);
    if (target) {
      const label = target === 'primary2' ? TEXT.menu.equipPrimary2 : TEXT.menu.equip;
      entries.push({ label, run: () => sys.result(sys.sys.activate(uid, from), 'ui_equip', from, uid) });
      if (def.category === 'primary' && target !== 'primary2') {
        entries.push({ label: TEXT.menu.equipPrimary2, run: () => sys.result(sys.sys.equip(uid, 'primary2') ? 'ok' : 'fail', 'ui_equip', from, uid) });
      }
    }
    if (from.kind === 'quick') entries.push({ label: TEXT.menu.toBag, run: quick });   // 2026-09-09: 휠 → 가방
    else if (from.grid === 'container') entries.push({ label: TEXT.menu.toBag, run: quick });
    else if (from.grid === 'stash') entries.push({ label: TEXT.menu.toBag, run: quick });
    else if (from.grid === 'pouch') entries.push({ label: TEXT.menu.toBag, run: quick });   // A-15: 주머니 → 가방
    else if (hasContainer && !isBagDef(def)) entries.push({ label: TEXT.menu.toContainer, run: quick });
    else if (sys.hub && !isBagDef(def)) entries.push({ label: TEXT.menu.toStash, run: quick });
  }

  // 1a. repair (ship only, worn weapon / armor the player owns)
  if (sys.hub && owned) {
    const info = sys.sys.repairInfo(uid);
    if (info) {
      // Phase 8: the material requirement is item chips (thumbnail + 보유/필요), not a text run
      const costs = document.createElement('div');
      const have = new Map(info.cost.map((c) => [c.defId, c.have]));
      renderItemCost(costs, info.cost, (id) => ITEM_DEF_MAP.get(id), (id) => have.get(id) ?? 0, { size: 28 });
      entries.push({
        label: TEXT.menu.repair,
        // 2026-09-10: 재료가 있으면 **왜 이만큼인가** = 남은 내구도 구간 (`제작 재료 × 구간 배수`)
        hint: info.short ? TEXT.menu.repairShort
          : info.bucket ? TEXT.durability.repair(info.bucket.label, info.bucket.repairMul) : undefined,
        costs,
        separator: entries.length > 0,
        run: () => {
          const ok = sys.sys.repair(uid);
          sys.result(ok ? 'ok' : 'fail', 'ui_equip', from, uid);
          if (!ok) sys.ctx.bus.emit('ui:notify', { text: info.short ? TEXT.menu.repairShortMsg : TEXT.menu.repairFail, kind: 'warning', duration: 2 });
        },
      });
    }
  }

  // 1b. weapon maintenance (player-owned weapons only)
  if (isWeapon && owned) {
    if ((item.ammoInMag ?? 0) > 0) {
      entries.push({ label: TEXT.menu.unload, separator: entries.length > 0, run: () => sys.result(sys.sys.unloadWeapon(uid) ? 'ok' : 'fail', 'ui_drop', from, uid) });
    }
    if (filledSocketCount(item) > 0) {
      entries.push({ label: TEXT.menu.detachAll, run: () => sys.result(sys.sys.detachAllSockets(uid) ? 'ok' : 'fail', 'ui_drop', from, uid) });
    }
  }

  // 1c. quick-use wheel (stims / grenades). 2026-09-10: from **any** grid — 가방 · 열어 둔 상자 · 함선 창고.
  if (isQuickUsable(def) && from.kind === 'grid') {
    const idx = sys.sys.quickIndexOf(uid);
    if (idx >= 0) {
      entries.push({ label: `${TEXT.menu.quickClear} (${QUICK_DIR_GLYPH[idx]})`, separator: entries.length > 0, run: () => sys.result(sys.sys.setQuickSlot(idx, null) ? 'ok' : 'fail', 'ui_drop', from, uid) });
    } else {
      entries.push({ label: TEXT.menu.quickAssign, hint: '더블클릭', separator: entries.length > 0, run: () => sys.result(sys.sys.registerQuick(uid), 'ui_equip', from, uid) });
    }
  }

  /* 1c-2. 준비물 (A-13, 2026-09-11): **함선에서만** — 쓰면 그 자리에서 소모돼 다음 레이드 1회분으로 실린다
   * (`ctx.progression.usePrep`). 레이드 중이거나 이미 같은 환경을 준비했으면 항목은 그대로 보이되 사유가
   * 붙고, 눌러도 아이템은 사라지지 않는다 — 거절은 조용히 삼키지 않는다. */
  if (def.prep) {
    const blocked = !sys.hub ? TEXT.menu.usePrepRaid : null;
    entries.push({
      label: TEXT.menu.usePrep,
      hint: blocked ?? def.prep.short,
      separator: entries.length > 0,
      run: () => {
        if (blocked) {
          sys.sys.sfx('ui_error');
          sys.ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning', duration: 2 });
          return;
        }
        const refusal = sys.sys.usePrepItem(uid, from);
        sys.result(refusal ? 'fail' : 'ok', 'ui_equip', from, uid);
        if (refusal) sys.ctx.bus.emit('ui:notify', { text: refusal, kind: 'warning', duration: 2.4 });
        else sys.ctx.bus.emit('ui:notify', { text: `${def.name} — 다음 레이드에 실렸다`, kind: 'success', duration: 2.4 });
      },
    });
  }

  /* 1c-3. 요리 (A-3c, 2026-09-11): 준비물의 `사용` 바로 옆 — **함선에서만** 먹을 수 있고, 먹으면 그 자리에서
   * 소모돼 다음 레이드 1회분으로 실린다 (`ctx.progression.useMeal`). 레이드 중에는 항목이 그대로 보이되 사유가
   * 붙고 아이템은 사라지지 않는다.
   * ⚠ 「먹는 행위」의 제자리는 **주방의 식탁**이다 (사용자 결정) — 이것은 편의 경로이고 둘 다 같은 `useMeal` 이다. */
  if (def.meal) {
    const blocked = !sys.hub ? TEXT.menu.eatMealRaid : null;
    entries.push({
      label: TEXT.menu.eatMeal,
      hint: blocked ?? undefined,
      separator: entries.length > 0,
      run: () => {
        if (blocked) {
          sys.sys.sfx('ui_error');
          sys.ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning', duration: 2 });
          return;
        }
        const refusal = sys.sys.useMealItem(uid, from);
        sys.result(refusal ? 'fail' : 'ok', 'ui_equip', from, uid);
        if (refusal) sys.ctx.bus.emit('ui:notify', { text: refusal, kind: 'warning', duration: 2.4 });
        else sys.ctx.bus.emit('ui:notify', { text: `${def.name} — 다음 레이드에 실렸다`, kind: 'success', duration: 2.4 });
      },
    });
  }

  // 1d. 분해 (Phase 8): any item with a matching `break_*` recipe — the ammo packs today
  if (sys.canDisassemble(uid, from)) {
    entries.push({
      label: TEXT.disassemble.menu,
      separator: entries.length > 0,
      run: () => sys.openDisassemble(uid),
    });
  }

  // 2. split
  if (isStack && from.kind === 'grid') {
    const half = Math.max(1, Math.floor(item.qty / 2));
    entries.push({ label: TEXT.menu.splitHalf, hint: 'Shift', separator: entries.length > 0, run: () => sys.split(uid, from, half) });
    if (item.qty > 2) entries.push({ label: TEXT.menu.splitOne, hint: 'Ctrl', run: () => sys.split(uid, from, 1) });
    entries.push({ label: TEXT.menu.splitCustom, run: () => sys.openSplitDialog(uid, from) });
  }

  // 3. quick chat request
  entries.push({
    label: isWeapon ? TEXT.menu.requestAmmo : TEXT.menu.request,
    hint: '휠클릭',
    separator: entries.length > 0,
    run: () => { sys.sys.requestItem(uid, from); },
  });

  // 4. drop (not in the ship — there is no ground to drop onto)
  if (!sys.hub) {
    const dropKey = keyLabel(Keys.DROP_ITEM);
    entries.push({ label: TEXT.menu.drop, hint: dropKey, danger: true, separator: true, run: () => sys.dropToWorld(uid, from, undefined) });
    if (isStack) entries.push({ label: TEXT.menu.dropOne, hint: `Shift+${dropKey}`, danger: true, run: () => sys.dropToWorld(uid, from, 1) });
  }
  return entries;
  }

/**
 * Phase 8 — 분해 is offered on player-owned items (bag / equipment slots) that have a `break_*` recipe; a
 * container stack must be taken first, because the recipe consumes from the bag.
 */
export function canDisassemble(sys: InventoryUI, uid: string, from: ItemLocation): boolean {
  // the recipe consumes from the bag, so a crate / 창고 stack has to be taken into the bag first
  if (from.kind === 'grid' && from.grid !== 'bag') return false;
  return !!sys.sys.disassembleRecipeFor(uid);
  }

/** Open the modeless 분해 dialog for `uid` (expected result + a 분해 button). False when the item has no recipe. */
export function openDisassemble(sys: InventoryUI, uid: string): boolean {
  sys.menu.close();
  sys.tooltip.hide();
  if (sys.disassemble.isOpen) sys.disassemble.close();
  const ok = sys.disassemble.open(uid, null);
  sys.sys.sfx(ok ? 'ui_pickup' : 'ui_error');
  return ok;
  }

export function split(sys: InventoryUI, uid: string, from: ItemLocation, qty: number): void {
  const ok = sys.sys.splitItem(uid, qty);
  sys.result(ok ? 'ok' : 'fail', 'ui_pickup', from, uid);
  }

export function openSplitDialog(sys: InventoryUI, uid: string, from: ItemLocation): void {
  const item = sys.sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return;
  sys.tooltip.hide();
  sys.dialog.open(item, def, (qty) => sys.split(uid, from, qty));
  }

export function dropToWorld(sys: InventoryUI, uid: string, from: ItemLocation, qty: number | undefined): void {
  const ok = sys.sys.dropItem(uid, qty);
  if (ok) sys.sys.sfx('ui_drop');
  else { sys.sys.sfx('ui_error'); sys.shake(from, uid); }
  if (sys.hovered?.uid === uid) { sys.hovered = null; sys.tooltip.hide(); }
  }
