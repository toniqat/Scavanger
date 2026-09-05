import { INVENTORY_COLS, INVENTORY_ROWS, QUICK_SLOTS, Random } from '@/shared';
import { ITEM_DEF_MAP, LootService, STARTER_LOADOUT } from '@/items';
import { Grid } from './Grid';
import { attachedItems, clearAllSockets, clearSocket, filledSocketCount, findSocketed, setSocket } from './Sockets';
import {
  QUICK_AUTO_GRENADE, QUICK_AUTO_STIM, assignQuickSlot, autoAssignQuickSlots, clearQuickSlotOf, createQuickSlots, firstFreeQuickSlot,
  isQuickUsable, pruneQuickSlots, quickSlotOf, quickSlotsSignature, relinkQuickSlot,
} from './QuickSlots';

/**
 * Dev-only self check for the pure grid + socket + loot logic (no test runner installed).
 * Call `runInventorySelfTest()` from the console or a dev hook; returns true when all asserts pass.
 */
export function runInventorySelfTest(): boolean {
  let failures = 0;
  const check = (cond: unknown, msg: string): void => {
    console.assert(!!cond, `[InventorySelfTest] ${msg}`);
    if (!cond) failures++;
  };
  const loot = new LootService();
  const getDef = (id: string) => ITEM_DEF_MAP.get(id);
  const grid = new Grid(INVENTORY_COLS, INVENTORY_ROWS, getDef);

  // place / bounds
  const rifle = loot.createItem('wpn_ar23');            // 4×2
  check(grid.place(rifle, 0, 0), 'place rifle at 0,0');
  check(!grid.place(rifle, 5, 0), 'cannot place same uid twice');
  check(grid.at(3, 1)?.item.uid === rifle.uid, 'rifle covers (3,1)');
  check(grid.at(4, 0) === undefined, '(4,0) is free');
  const rifle2 = loot.createItem('wpn_ar23');
  check(!grid.canPlace(rifle2, 3, 0), 'overlap detected');
  check(!grid.canPlace(rifle2, 7, 0), 'out of bounds detected (x)');
  check(grid.canPlace(rifle2, 6, 0), 'fits at 6,0');
  check(grid.blockersAt(rifle2, 2, 1).length === 1 && grid.blockersAt(rifle2, 2, 1)[0] === rifle.uid, 'single blocker');

  // rotate
  const canister = loot.createItem('sample_canister');  // 3×1
  check(grid.place(canister, 0, 2), 'place canister 0,2');
  check(grid.rotate(canister.uid), 'rotate canister in place');
  check(canister.rotated === true, 'rotated flag set');
  check(grid.at(0, 4)?.item.uid === canister.uid, 'rotated canister covers (0,4)');
  check(grid.at(2, 2) === undefined, '(2,2) freed after rotation');
  const fp = grid.footprintOf(canister);
  check(fp.w === 1 && fp.h === 3, 'footprint swaps after rotate');

  // rotate with nearby offset fallback: put a 4×1 at bottom-right corner so in-place rotation is OOB
  const dmr = loot.createItem('wpn_r63');               // 4×1
  check(grid.place(dmr, 6, 5), 'place dmr bottom-right');
  check(grid.rotate(dmr.uid), 'rotate dmr via offset search');
  check(dmr.rotated && grid.get(dmr.uid)!.y <= 2, 'dmr moved up to fit vertically');

  // stacks
  const frag = loot.createItem('grenade_frag', 3);
  check(grid.autoPlace(frag), 'autoPlace frag stack');
  const frag2 = loot.createItem('grenade_frag', 3);
  check(grid.autoPlace(frag2), 'autoPlace second frag stack (merge 1, place 2)');
  check(frag.qty === 4, 'first stack topped up to stackMax 4');
  check(frag2.qty === 2 && grid.has(frag2.uid), 'remainder placed as new stack');
  const frag3 = loot.createItem('grenade_frag', 2);
  check(grid.mergeCapacity('grenade_frag') === 2, 'merge capacity 2');
  check(grid.autoPlace(frag3) && !grid.has(frag3.uid) && frag3.qty === 0, 'fully merged stack is not placed');
  check(grid.mergeInto(loot.createItem('grenade_frag', 1), frag2.uid) === 0, 'mergeInto full stack moves 0');

  // split / partial-merge math (what InventorySystem.splitItem / dropPartial do on top of Grid)
  {
    const g = new Grid(4, 2, getDef);
    const src = loot.createItem('grenade_frag', 4);       // stackMax 4, 1×1
    check(g.autoPlace(src), 'split: place source stack');
    const half = Math.max(1, Math.floor(src.qty / 2));
    check(half === 2, 'split: half of 4 is 2');
    const piece = loot.createItem('grenade_frag', half);
    const slot = g.findFreeSlot(piece, src.rotated);
    check(!!slot && !(slot.x === g.get(src.uid)!.x && slot.y === g.get(src.uid)!.y), 'split: free slot differs from source');
    check(g.place(piece, slot!.x, slot!.y, slot!.rotated), 'split: new stack placed');
    src.qty -= half;
    check(src.qty === 2 && piece.qty === 2 && g.count === 2, 'split: 4 → 2 + 2');
    // partial drag onto a same-def stack merges capped by stackMax (3 into a stack of 2 with max 4 → moves 2)
    const big = loot.createItem('grenade_frag', 3);
    check(g.place(big, 3, 1), 'split: place third stack');
    const room = 4 - piece.qty;
    const moved = Math.min(room, big.qty);
    piece.qty += moved; big.qty -= moved;
    check(moved === 2 && piece.qty === 4 && big.qty === 1, 'partial merge capped by stackMax');
    check(g.mergeInto(big, piece.uid) === 0, 'partial merge into full stack moves 0');
    // probe with a foreign uid sees the source as a blocker (drop-on-source → noop path)
    const probe = { uid: '__split__', defId: 'grenade_frag', qty: 1, rotated: false };
    const sp = g.get(src.uid)!;
    const bl = g.blockersAt(probe, sp.x, sp.y, false, probe.uid);
    check(bl.length === 1 && bl[0] === src.uid, 'partial probe reports the source stack as blocker');
    // no free cell → split refused
    const tiny = new Grid(1, 1, getDef);
    const lone = loot.createItem('grenade_frag', 4);
    check(tiny.autoPlace(lone), 'split: 1×1 grid holds the stack');
    check(tiny.findFreeSlot(loot.createItem('grenade_frag', 1)) === null, 'split: refused when the grid is full');
    // invalid quantities
    const bad = (q: number) => !Number.isFinite(q) || Math.floor(q) < 1 || Math.floor(q) >= lone.qty;
    check(bad(0) && bad(4) && bad(NaN) && !bad(3) && !bad(1.7), 'split: qty must be within 1..qty-1');
  }

  // full grid → tryAdd fails without side effects
  const full = new Grid(2, 2, getDef);
  const art = loot.createItem('alien_artifact');        // 2×2
  check(full.autoPlace(art), 'artifact fills 2×2');
  const gem = loot.createItem('gem_quartz');
  check(!full.canAbsorb(gem) && !full.autoPlace(gem), 'no room → refuse');
  check(full.remove(art.uid)?.item.uid === art.uid && full.isEmpty, 'remove empties grid');

  // moveTo restores on failure
  const before = grid.get(rifle.uid)!;
  const bx = before.x, by = before.y;
  check(!grid.moveTo(rifle.uid, 9, 0), 'moveTo OOB refused');
  check(grid.get(rifle.uid)!.x === bx && grid.get(rifle.uid)!.y === by, 'placement unchanged after failed move');
  check(grid.moveTo(rifle.uid, 6, 0), 'moveTo free area');
  check(grid.at(0, 0) === undefined && grid.at(9, 1)?.item.uid === rifle.uid, 'cells updated after move');

  // value
  check(grid.totalValue() > 0, 'total value positive');

  // loot determinism
  const a = loot.rollCrate(3, new Random(1234)).map((i) => `${i.defId}x${i.qty}`).join(',');
  const b = loot.rollCrate(3, new Random(1234)).map((i) => `${i.defId}x${i.qty}`).join(',');
  check(a === b, 'rollCrate deterministic for same seed');
  const t4 = loot.rollCrate(4, new Random(99));
  check(t4.length >= 5 && t4.length <= 6, 'tier 4 rolls 5–6 items');
  check(t4.some((i) => { const c = getDef(i.defId)!.category; return c === 'primary' || c === 'secondary'; }), 'tier 4 guarantees a weapon');
  check(t4.some((i) => { const d = getDef(i.defId)!; return d.category === 'valuable' && (d.rarity === 'epic' || d.rarity === 'legendary'); }), 'tier 4 guarantees epic+ valuable');
  const t1 = loot.rollCrate(1, new Random(7));
  check(t1.length >= 2 && t1.length <= 3, 'tier 1 rolls 2–3 items');

  // starter ids exist (weapon package shape: primary / primary2 / secondary / bag / items[{id, qty}])
  check(!!getDef(STARTER_LOADOUT.primary) && !!getDef(STARTER_LOADOUT.secondary), 'starter weapon defs exist');
  check(!!getDef(STARTER_LOADOUT.bag) && !!getDef(STARTER_LOADOUT.bag)!.bag, 'starter bag def exists and is a bag');
  for (const e of STARTER_LOADOUT.items) {
    const d = getDef(e.id);
    check(!!d && e.qty >= 1, `starter item def '${e.id}' exists`);
  }

  // resize: grow keeps every placement, shrink relocates then overflows
  {
    const g = new Grid(5, 6, getDef);
    const ar = loot.createItem('wpn_ar23');              // 4×2
    const gem = loot.createItem('gem_quartz');            // 1×1
    check(g.place(ar, 0, 0) && g.place(gem, 4, 5), 'resize: seed a 5×6 grid');
    check(g.resize(10, 6).length === 0, 'resize: growing drops nothing');
    check(g.cols === 10 && g.get(ar.uid)!.x === 0 && g.get(gem.uid)!.x === 4 && g.get(gem.uid)!.y === 5, 'resize: grow keeps placements');
    const far = loot.createItem('gem_amber');
    check(g.place(far, 9, 0), 'resize: place a gem in the new area');
    const over1 = g.resize(5, 6);
    check(over1.length === 0 && g.has(far.uid) && g.get(far.uid)!.x < 5, 'resize: shrink relocates an out-of-bounds item into free space');
    const over2 = g.resize(5, 2);                         // 10 cells: the rifle (8) + two gems fit, nothing else
    check(over2.length === 0 && g.count === 3, 'resize: 5×2 still holds rifle + 2 gems');
    const extra = loot.createItem('gem_sapphire');
    check(!g.autoPlace(extra), 'resize: 5×2 grid now has no room for a third gem');
    g.resize(5, 6);
    check(g.autoPlace(extra), 'resize: grown grid takes the gem');
    const over3 = g.resize(4, 2);                         // 8 cells: rifle (4×2) alone fills it → 3 gems overflow
    check(over3.length === 3 && !g.has(gem.uid) && g.has(ar.uid), 'resize: overflow returned when nothing fits (largest kept first)');
    check(over3.every((it) => !g.has(it.uid)), 'resize: overflow items are not in the grid');
    // snapshot / restore undoes a resize entirely
    const snap = g.snapshot();
    g.resize(1, 1);
    check(g.count === 0, 'resize: 1×1 loses everything');
    g.restore(snap);
    check(g.cols === 4 && g.rows === 2 && g.has(ar.uid) && g.count === 1, 'restore: layout back after a failed resize');
    // priority placement: the displaced bag lands first, at its hint
    const g2 = new Grid(10, 6, getDef);
    for (let i = 0; i < 60; i++) g2.place(loot.createItem('gem_quartz'), i % 10, Math.floor(i / 10));
    const oldBag = loot.createItem('bag_legendary');      // 2×2
    const over4 = g2.resize(5, 6, [{ item: oldBag, x: 1, y: 1 }]);
    const bp = g2.get(oldBag.uid);
    check(!!bp && bp.x === 1 && bp.y === 1, 'resize: priority item placed at its hint before anything else');
    check(over4.length === 60 - 26 && g2.count === 27, 'resize: 26 gems kept around the bag, 34 overflow');
  }

  // sockets: attach / detach bookkeeping + effective stats + compatibility
  {
    const ar = loot.createItem('wpn_ar23');
    const brake = loot.createItem('att_brake');
    const choke = loot.createItem('att_choke');
    const brake2 = loot.createItem('att_brake');
    check(loot.canAttach(ar, brake) && !loot.canAttach(ar, choke), 'sockets: brake fits the AR, shotgun choke does not');
    const base = loot.getEffectiveStats(ar)!.recoilV;
    check(setSocket(ar, 'muzzle', brake) === undefined && ar.sockets?.muzzle?.uid === brake.uid, 'sockets: empty socket filled');
    check(Math.abs(loot.getEffectiveStats(ar)!.recoilV - base * 0.75) < 1e-9, 'sockets: brake → recoilV ×0.75');
    check(setSocket(ar, 'muzzle', brake2)?.uid === brake.uid, 'sockets: replacing returns the previous attachment');
    check(filledSocketCount(ar) === 1 && attachedItems(ar)[0].uid === brake2.uid, 'sockets: one filled socket');
    check(findSocketed([ar], brake2.uid)?.socket === 'muzzle' && findSocketed([ar], brake.uid) === null, 'sockets: findSocketed');
    const mag = loot.createItem('att_mag_medium');
    setSocket(ar, 'mag', mag);
    check(loot.getEffectiveStats(ar)!.magSize === 63, 'sockets: extended medium mag → 45 × 1.4 = 63');
    const removed = clearAllSockets(ar);
    check(removed.length === 2 && ar.sockets === undefined && loot.getEffectiveStats(ar)!.magSize === 45, 'sockets: clearAllSockets empties and restores base stats');
    check(clearSocket(ar, 'grip') === undefined, 'sockets: clearing an empty socket is a no-op');
    // a weapon created with an extended mag in `extras` spawns with the bigger magazine
    const loaded = loot.createItem('wpn_ar23', 1, { sockets: { mag: loot.createItem('att_mag_medium') } });
    check(loaded.ammoInMag === 63 && loaded.durability === 500, 'sockets: createItem honours socketed mag size');
  }

  // quick-use wheel: set / move / clear / auto-assign / prune (item left the bag) / consume-to-0 relink
  {
    const g = new Grid(5, 6, getDef);
    const nade = loot.createItem('grenade_frag', 2);
    const stim = loot.createItem('stim', 2);
    const stim2 = loot.createItem('stim', 1);
    const ammo = loot.createItem('ammo_medium', 30);
    check(g.autoPlace(nade) && g.autoPlace(stim) && g.autoPlace(ammo), 'quick: seed bag');
    check(g.autoPlace(stim2) && !g.has(stim2.uid) && stim.qty === 3 && stim2.qty === 0, 'quick: second stim merges into the first (3/3), no new tile');
    check(isQuickUsable(getDef('stim')) && isQuickUsable(getDef('grenade_frag')) && !isQuickUsable(getDef('ammo_medium')), 'quick: only stims / grenades are usable');
    const slots = createQuickSlots();
    check(slots.length === QUICK_SLOTS && slots.every((s) => s === null), 'quick: 8 empty slots');
    // starter policy with the common bag (2 usable slots = N + S per QUICK_SLOT_UNLOCK_ORDER): grenade → N, stim → S
    autoAssignQuickSlots(slots, g.items().map((p) => p.item), getDef, 2);
    check(slots[QUICK_AUTO_GRENADE] === nade.uid && slots[QUICK_AUTO_STIM] === stim.uid && slots[1] === null, 'quick: auto-assign N grenade, S stim under a 2-slot bag');
    // with a single usable slot (no bag) only the grenade fits (N); the stim finds no free usable slot
    autoAssignQuickSlots(slots, g.items().map((p) => p.item), getDef, 1);
    check(slots[QUICK_AUTO_GRENADE] === nade.uid && slots.filter(Boolean).length === 1, 'quick: auto-assign under a 1-slot bag keeps only the grenade');
    autoAssignQuickSlots(slots, g.items().map((p) => p.item), getDef, 6);
    check(slots[QUICK_AUTO_GRENADE] === nade.uid && slots[QUICK_AUTO_STIM] === stim.uid, 'quick: auto-assign N grenade, S stim under a 6-slot bag');
    // set: the same uid occupies one slot only (moves), clear by index / by uid
    check(assignQuickSlot(slots, 2, stim.uid) && slots[2] === stim.uid && slots[QUICK_AUTO_STIM] === null, 'quick: assigning elsewhere moves the stim');
    check(!assignQuickSlot(slots, 2, stim.uid), 'quick: re-assigning the same slot is a no-op');
    check(quickSlotOf(slots, stim.uid) === 2 && quickSlotOf(slots, ammo.uid) === -1, 'quick: quickSlotOf');
    // unlock order: 2 slots → N (taken) then S (free) = 4; 1 slot → only N, taken → -1; 3 slots → N, S, E (E taken by the stim) → 4
    check(firstFreeQuickSlot(slots, 2) === 4 && firstFreeQuickSlot(slots, 1) === -1 && firstFreeQuickSlot(slots, 3) === 4, 'quick: first free usable slot follows QUICK_SLOT_UNLOCK_ORDER');
    check(firstFreeQuickSlot(slots, 0) === -1 && firstFreeQuickSlot(slots, 8) === 4, 'quick: first free with 0 / 8 usable slots');
    check(assignQuickSlot(slots, 2, null) && slots[2] === null, 'quick: clear by index');
    assignQuickSlot(slots, 2, stim.uid);
    check(clearQuickSlotOf(slots, stim.uid) === 2 && slots[2] === null && clearQuickSlotOf(slots, stim.uid) === -1, 'quick: clear by uid');
    // prune: the grenade leaves the bag (dropped / moved to a crate / overflow) → its slot clears
    g.remove(nade.uid);
    check(pruneQuickSlots(slots, (uid) => g.has(uid)) && slots[QUICK_AUTO_GRENADE] === null, 'quick: item leaving the bag clears its slot');
    check(!pruneQuickSlots(slots, (uid) => g.has(uid)), 'quick: prune is idempotent');
    // consume to 0: the slot follows a sibling stack of the same def when one exists, else clears
    assignQuickSlot(slots, 2, stim.uid);
    stim.qty = 0; g.remove(stim.uid);
    const stimB = loot.createItem('stim', 1);
    check(g.autoPlace(stimB), 'quick: sibling stim stack placed');
    check(relinkQuickSlot(slots, stim.uid, stimB.uid) && slots[2] === stimB.uid, 'quick: consumed stack hands its slot to the sibling stack');
    check(!relinkQuickSlot(slots, stimB.uid, stimB.uid), 'quick: relink onto itself is a no-op');
    stimB.qty = 0; g.remove(stimB.uid);
    check(pruneQuickSlots(slots, (uid) => g.has(uid)) && slots[2] === null && slots.every((s) => s === null), 'quick: consuming the last stack clears the slot');
    // signature changes with qty / active (drives the change event)
    const f = loot.createItem('grenade_frag', 2);
    g.autoPlace(f);
    assignQuickSlot(slots, 0, f.uid);
    const resolve = (uid: string) => g.get(uid)?.item ?? null;
    const s1 = quickSlotsSignature(slots, resolve, 2);
    f.qty = 1;
    const s2 = quickSlotsSignature(slots, resolve, 2);
    const s3 = quickSlotsSignature(slots, resolve, 3);
    check(s1 !== s2 && s2 !== s3, 'quick: signature tracks qty and active count');
  }

  if (failures === 0) console.info('[InventorySelfTest] all checks passed');
  else console.error(`[InventorySelfTest] ${failures} check(s) failed`);
  return failures === 0;
}
