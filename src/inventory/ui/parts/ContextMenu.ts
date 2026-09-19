/**
 * src/inventory/ui/parts/ContextMenu.ts — **the right-click menu · splitting a stack · dropping**.
 *
 * One place decides what each item can do (equip · repair · salvage · unload the loaded ammo · detach sockets ·
 * move to the stash · drop · post to chat). Every action calls `ctx.inventory`; this file decides
 * **which entries are shown** and nothing else.
 */
import type { ItemDef, ItemInstance } from '@/shared';
import { Keys, keyLabel, renderItemCost } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import { isWeaponDef, type ItemLocation } from '../../InventorySystem';
import { filledSocketCount } from '../../Sockets';
import { isQuickUsable } from '../../QuickSlots';
import { type MenuEntry } from '../ContextMenu';
import { QUICK_DIR_GLYPH, TEXT } from '../labels';
import { BAG_LOC } from '../model';
import type { InventoryUI } from '../InventoryUI';

/**
 * Right-click on a wheel cell: `빠른 슬롯 해제` (assigned cells only).
 * 2026-09-10: with a crate left open, `상자로 이동` comes along too — the second way from a quick slot straight into
 * the crate (the first is dragging the wheel cell onto the crate grid).
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
  // 2026-09-12 (E1): a stack in a wheel cell toggles its favourite too
  const stack = sys.sys.getQuickSlots()[index];
  if (stack) entries.push(favoriteEntry(sys, stack.defId, true));
  entries.push({ label: TEXT.menu.request, hint: keyLabel('Mouse1'), separator: true, run: () => { sys.sys.requestItem(uid, BAG_LOC); } });
  sys.menu.open(e.clientX, e.clientY, entries);
}

/**
 * **2026-09-12 (E1, user's decision) — right-click opens the menu on every item.** It used to appear only on weapons ·
 * bags · armor · gear to repair · stacks of 2 or more · preparations · meals, and everything else moved straight away
 * on one right-click (Shift + right-click = the menu). That move is now the menu's 「빠른 이동 (…)」 entry and the
 * **double-click**, and the menu always carries 「즐겨찾기 켜기 / 끄기」. A tile before the search (locked) still has no menu.
 */
export function onContextMenu(sys: InventoryUI, uid: string, from: ItemLocation, e: MouseEvent): void {
  if (sys.drag?.started || sys.dialog.isOpen) return;
  sys.menu.close();
  if (sys.locked(uid, from)) return;
  const item = sys.sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return;
  sys.tooltip.hide();
  sys.menu.open(e.clientX, e.clientY, sys.menuEntries(uid, from, item, def));
}

/** 2026-09-12 (E1): the favourite entry — one shape for grid tiles, equipment slot cards and wheel cells. */
export function favoriteEntry(sys: InventoryUI, defId: string, separator: boolean): MenuEntry {
  const on = sys.sys.isFavorite(defId);
  return { label: on ? TEXT.menu.favoriteOff : TEXT.menu.favoriteOn, separator, run: () => sys.toggleFavoriteFromMenu(defId) };
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
  // A-15: the pouch is 「something I am carrying」 too (like the quick slots)
  const owned = from.kind === 'slot' || from.kind === 'quick' || from.grid === 'bag' || from.grid === 'pouch';

  // 1. quick action. 2026-09-12 (E1): 「빠른 이동 (가방 / 창고 / 상자)」 — the move a plain right-click used to make on
  //    its own; the destination is `quickMoveDest`, the very rule `quickMove` follows
  const dest = sys.sys.quickMoveDest(from);
  if (from.kind === 'slot') {
    entries.push({ label: TEXT.menu.quickMove.bag, run: quick });
    if (sys.hub) entries.push({ label: TEXT.menu.toStash, run: () => sys.result(sys.sys.moveToStash(uid, from), 'ui_drop', from, uid) });
  } else {
    const target = sys.sys.equipTargetFor(def);
    if (target) {
      /*
       * 2026-09-14 2nd pass — 「장착」 goes **through `equip`** (it used to be `activate`). The same day the double-click
       * came down to 「only when a slot is empty」, so leaving `activate` here would make the label lie: with both slots
       * full, pressing 「장착」 would **move** the item to the stash · the crate instead. A menu entry is an **explicit
       * order** a person read and chose, so a swap is right — what 「nothing is silently displaced while picking up」
       * (2026-09-10) blocks is a silent swap, not this.
       */
      const label = target === 'primary2' ? TEXT.menu.equipPrimary2 : TEXT.menu.equip;
      entries.push({ label, run: () => sys.result(sys.sys.equip(uid, target) ? 'ok' : 'fail', 'ui_equip', from, uid) });
      if (def.category === 'primary' && target !== 'primary2') {
        entries.push({ label: TEXT.menu.equipPrimary2, run: () => sys.result(sys.sys.equip(uid, 'primary2') ? 'ok' : 'fail', 'ui_equip', from, uid) });
      }
    }
    if (dest) {
      /*
       * `더블클릭` hint only where a double-click makes this very move. Since the 2026-09-14 2nd pass that condition is
       * **「no empty equipment slot · implant slot · wheel cell at all」, from any grid** (`wouldAutoPlace` — the same
       * judgement the double-click makes). The stash also sends with a toast on top, so it is left out whole as before.
       * The bag is the branch that does not look at ③ (the wheel), so it asks with `quick: false` and also leaves out
       * the `registerQuick` interception used while the crate is closed (`ui/InventoryUI.tileHandlers`).
       */
      const fromBag = from.kind === 'grid' && from.grid === 'bag';
      const dblSame = from.kind === 'grid' && from.grid !== 'stash'
        && !sys.sys.wouldAutoPlace(item, def, !fromBag)
        && !(fromBag && isQuickUsable(def) && !hasContainer);
      entries.push({ label: TEXT.menu.quickMove[dest], hint: dblSame ? '더블클릭' : undefined, run: quick });
    }
  }

  // 1a. repair (ship only, worn weapon / armor the player owns)
  if (sys.hub && owned) {
    const info = sys.sys.repairInfo(uid);
    if (info) {
      // Phase 8: the material requirement is item chips (thumbnail + held/needed), not a text run
      const costs = document.createElement('div');
      const have = new Map(info.cost.map((c) => [c.defId, c.have]));
      renderItemCost(costs, info.cost, (id) => ITEM_DEF_MAP.get(id), (id) => have.get(id) ?? 0, { size: 28 });
      entries.push({
        label: TEXT.menu.repair,
        // 2026-09-10: with the materials in hand, **why this much** = the remaining durability bucket (craft materials × bucket multiplier)
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

  // 1c. quick-use wheel (stims / grenades). 2026-09-10: from **any** grid — the bag · an open crate · the stash.
  if (isQuickUsable(def) && from.kind === 'grid') {
    const idx = sys.sys.quickIndexOf(uid);
    if (idx >= 0) {
      entries.push({ label: `${TEXT.menu.quickClear} (${QUICK_DIR_GLYPH[idx]})`, separator: entries.length > 0, run: () => sys.result(sys.sys.setQuickSlot(idx, null) ? 'ok' : 'fail', 'ui_drop', from, uid) });
    } else {
      entries.push({ label: TEXT.menu.quickAssign, hint: '더블클릭', separator: entries.length > 0, run: () => sys.result(sys.sys.registerQuick(uid), 'ui_equip', from, uid) });
    }
  }

  // 1c-1. favourite (2026-09-12, E1, user's decision): every item — toggled per def (the def id)
  entries.push(favoriteEntry(sys, def.id, entries.length > 0));

  /* 1c-2. preparations (A-13, 2026-09-11): **in the ship only** — using one consumes it on the spot and loads it as
   * one use for the next raid (`ctx.progression.usePrep`). During a raid, or with the same environment already
   * prepared, the entry still shows but carries a reason and pressing it consumes nothing — a refusal is never
   * silently swallowed. */
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

  /* 1c-3. cooking — 2026-09-16 (the plate model, user's decision): a meal is not an item. The old right-click `먹기`
   * is gone and the only place to eat is the dining table. */

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
    // 2026-09-15 (user's decision): with armor equipped and the shield not full, 「실드 충전 요청」 — judged by the same function as `requestItem`
    label: isWeapon ? TEXT.menu.requestAmmo : sys.sys.wantsShieldRecharge(from) ? TEXT.menu.requestShield : TEXT.menu.request,
    hint: keyLabel('Mouse1'),
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
  // the recipe consumes from the bag, so a crate / stash stack has to be taken into the bag first
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
