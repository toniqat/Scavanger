import type { ItemInstance } from '@/shared';
import { INVENTORY_COLS, INVENTORY_ROWS, QUICK_SLOTS, Random } from '@/shared';
import { ITEM_DEF_MAP, LootService, STARTER_LOADOUT } from '@/items';
import { Grid } from './Grid';
import { attachedItems, clearAllSockets, clearSocket, filledSocketCount, findSocketed, setSocket } from './Sockets';
import {
  QUICK_AUTO_GRENADE, QUICK_AUTO_STIM, createQuickSlots, firstFreeQuickSlot, isQuickUsable, lockedQuickItems,
  mergeIntoQuick, pickStarterQuick, quickSlotOf, quickSlotsSignature,
} from './QuickSlots';
/* 2026-09-10: 퀵슬롯 1:1 교체에서 밀려난 스택이 갈 자리 */
import { applyQuickSwap, canQuickSwap } from './QuickSwap';

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
  const rifle = loot.createItem('wpn_ar');            // 4×2
  check(grid.place(rifle, 0, 0), 'place rifle at 0,0');
  check(!grid.place(rifle, 5, 0), 'cannot place same uid twice');
  check(grid.at(3, 1)?.item.uid === rifle.uid, 'rifle covers (3,1)');
  check(grid.at(4, 0) === undefined, '(4,0) is free');
  const rifle2 = loot.createItem('wpn_ar');
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
  const dmr = loot.createItem('wpn_dmr');               // 4×1
  check(grid.place(dmr, 6, 5), 'place dmr bottom-right');
  check(grid.rotate(dmr.uid), 'rotate dmr via offset search');
  check(dmr.rotated && grid.get(dmr.uid)!.y <= 2, 'dmr moved up to fit vertically');

  // stacks
  const frag = loot.createItem('grenade_frag', 2);
  check(grid.autoPlace(frag), 'autoPlace frag stack');
  const frag2 = loot.createItem('grenade_frag', 2);
  check(grid.autoPlace(frag2), 'autoPlace second frag stack (merge 1, place 1)');
  check(frag.qty === 3, 'first stack topped up to stackMax 3');
  check(frag2.qty === 1 && grid.has(frag2.uid), 'remainder placed as new stack');
  const frag3 = loot.createItem('grenade_frag', 2);
  check(grid.mergeCapacity('grenade_frag') === 2, 'merge capacity 2');
  check(grid.autoPlace(frag3) && !grid.has(frag3.uid) && frag3.qty === 0, 'fully merged stack is not placed');
  check(grid.mergeInto(loot.createItem('grenade_frag', 1), frag2.uid) === 0, 'mergeInto full stack moves 0');

  // split / partial-merge math (what InventorySystem.splitItem / dropPartial do on top of Grid)
  {
    const g = new Grid(4, 2, getDef);
    const src = loot.createItem('grenade_frag', 3);       // stackMax 3 (2026-09-07: 수류탄은 한 칸에 3개), 1×1
    check(g.autoPlace(src), 'split: place source stack');
    const half = Math.max(1, Math.floor(src.qty / 2));
    check(half === 1, 'split: half of 3 is 1');
    const piece = loot.createItem('grenade_frag', half);
    const slot = g.findFreeSlot(piece, src.rotated);
    check(!!slot && !(slot.x === g.get(src.uid)!.x && slot.y === g.get(src.uid)!.y), 'split: free slot differs from source');
    check(g.place(piece, slot!.x, slot!.y, slot!.rotated), 'split: new stack placed');
    src.qty -= half;
    check(src.qty === 2 && piece.qty === 1 && g.count === 2, 'split: 3 → 2 + 1');
    // partial drag onto a same-def stack merges capped by stackMax (3 into a stack of 1 with max 3 → moves 2)
    const big = loot.createItem('grenade_frag', 3);
    check(g.place(big, 3, 1), 'split: place third stack');
    const room = 3 - piece.qty;
    const moved = Math.min(room, big.qty);
    piece.qty += moved; big.qty -= moved;
    check(moved === 2 && piece.qty === 3 && big.qty === 1, 'partial merge capped by stackMax');
    check(g.mergeInto(big, piece.uid) === 0, 'partial merge into full stack moves 0');
    // probe with a foreign uid sees the source as a blocker (drop-on-source → noop path)
    const probe = { uid: '__split__', defId: 'grenade_frag', qty: 1, rotated: false };
    const sp = g.get(src.uid)!;
    const bl = g.blockersAt(probe, sp.x, sp.y, false, probe.uid);
    check(bl.length === 1 && bl[0] === src.uid, 'partial probe reports the source stack as blocker');
    // no free cell → split refused
    const tiny = new Grid(1, 1, getDef);
    const lone = loot.createItem('grenade_frag', 3);
    check(tiny.autoPlace(lone), 'split: 1×1 grid holds the stack');
    check(tiny.findFreeSlot(loot.createItem('grenade_frag', 1)) === null, 'split: refused when the grid is full');
    // invalid quantities
    const bad = (q: number) => !Number.isFinite(q) || Math.floor(q) < 1 || Math.floor(q) >= lone.qty;
    check(bad(0) && bad(3) && bad(NaN) && !bad(2) && !bad(1.7), 'split: qty must be within 1..qty-1');
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

  // corpse loot (Phase 4)
  const c1 = loot.rollCorpse('warrior', new Random(5)).map((i) => `${i.defId}x${i.qty}`).join(',');
  const c2 = loot.rollCorpse('warrior', new Random(5)).map((i) => `${i.defId}x${i.qty}`).join(',');
  check(c1 === c2 && c1.includes('mat_bio_sample'), 'rollCorpse deterministic, bugs drop bio samples');
  const rogue = loot.rollCorpse('rogue', new Random(11), 'smg');
  const rogueWeapon = rogue.find((i) => i.defId === 'wpn_smg');
  const rogueStats = rogueWeapon && loot.getEffectiveStats(rogueWeapon);
  check(!!rogueWeapon && !!rogueStats && (rogueWeapon.durability ?? 0) <= rogueStats.maxDurability * 0.15 + 1, 'rogue corpse carries its weapon at ≤ 15 % durability');
  const lightStack = getDef('ammo_light')!.stackMax;
  check(rogue.some((i) => i.defId === 'ammo_light' && i.qty >= lightStack * 0.3 && i.qty <= lightStack * 0.6), 'rogue corpse drops 30–60 % of the light stack');
  const boss = loot.rollCorpse('rogue_boss', new Random(3), 'dmr');
  check(boss.some((i) => i.defId === 'wpn_dmr_g3' || i.defId === 'wpn_dmr_g4'), 'boss corpse weapon is grade III/IV of the same family');
  check(boss.some((i) => getDef(i.defId)!.category === 'attachment') && boss.some((i) => getDef(i.defId)!.category === 'stim'), 'boss corpse has an attachment and stims');
  check(loot.rollCorpse('nope' as never, new Random(1)).length === 1, 'unknown corpse type → single bio sample');

  // starter ids exist (weapon package shape: primary / primary2 / secondary / bag / items[{id, qty}])
  check(!!getDef(STARTER_LOADOUT.primary), 'starter weapon def exists');   // 2026-09-10: 보조무기 제거 → 주무기
  check(!!getDef(STARTER_LOADOUT.bag) && !!getDef(STARTER_LOADOUT.bag)!.bag, 'starter bag def exists and is a bag');
  for (const e of STARTER_LOADOUT.items) {
    const d = getDef(e.id);
    check(!!d && e.qty >= 1, `starter item def '${e.id}' exists`);
  }

  // resize: grow keeps every placement, shrink relocates then overflows
  {
    const g = new Grid(5, 6, getDef);
    const ar = loot.createItem('wpn_ar');              // 4×2
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
    const ar = loot.createItem('wpn_ar');
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
    const loaded = loot.createItem('wpn_ar', 1, { sockets: { mag: loot.createItem('att_mag_medium') } });
    check(loaded.ammoInMag === 63 && loaded.durability === 500, 'sockets: createItem honours socketed mag size');
  }

  // quick-use wheel: set / move / clear / auto-assign / prune (item left the bag) / consume-to-0 relink
  {
    const g = new Grid(5, 6, getDef);
    const nade = loot.createItem('grenade_frag', 2);
    const stim = loot.createItem('heal_bandage', 2);
    const stim2 = loot.createItem('heal_bandage', 1);
    const ammo = loot.createItem('ammo_medium', 30);
    check(g.autoPlace(nade) && g.autoPlace(stim) && g.autoPlace(ammo), 'quick: seed bag');
    check(g.autoPlace(stim2) && !g.has(stim2.uid) && stim.qty === 3 && stim2.qty === 0, 'quick: second stim merges into the first (3/3), no new tile');
    check(isQuickUsable(getDef('heal_bandage')) && isQuickUsable(getDef('grenade_frag')) && !isQuickUsable(getDef('ammo_medium')), 'quick: only stims / grenades are usable');
    const slots = createQuickSlots();
    check(slots.length === QUICK_SLOTS && slots.every((s) => s === null), 'quick: 8 empty slots');

    /* 2026-09-09 — the wheel is its own container: `pickStarterQuick` only *chooses*, the caller moves the stack
       out of the bag. Starter policy with the common bag (2 usable slots = N + S per QUICK_SLOT_UNLOCK_ORDER). */
    const bagItems = g.items().map((p) => p.item);
    const picks2 = pickStarterQuick(slots, bagItems, getDef, 2);
    check(picks2.length === 2, 'quick: starter picks a grenade and a stim');
    check(picks2[0].index === QUICK_AUTO_GRENADE && picks2[0].item === nade, 'quick: starter grenade goes to N');
    check(picks2[1].index === QUICK_AUTO_STIM && picks2[1].item === stim, 'quick: starter stim goes to S');
    check(picks2.every((q) => !getDef(q.item.defId) || isQuickUsable(getDef(q.item.defId))), 'quick: starter never picks ammo');
    // with a single usable slot only the grenade fits (N); the stim finds no free usable slot
    check(pickStarterQuick(slots, bagItems, getDef, 1).length === 1, 'quick: starter under a 1-slot bag keeps only the grenade');
    check(pickStarterQuick(slots, bagItems, getDef, 0).length === 0, 'quick: starter with no usable slot picks nothing');

    // apply the picks the way `applyStarter` does: the stacks *leave* the bag grid
    for (const { index, item } of picks2) { g.remove(item.uid); slots[index] = item; }
    check(!g.has(nade.uid) && !g.has(stim.uid), 'quick: a stack on the wheel is no longer in the bag grid');
    check(slots[QUICK_AUTO_GRENADE] === nade && slots[QUICK_AUTO_STIM] === stim, 'quick: the wheel holds the stacks themselves');
    check(quickSlotOf(slots, stim.uid) === QUICK_AUTO_STIM && quickSlotOf(slots, ammo.uid) === -1, 'quick: quickSlotOf');

    // unlock order: N and S are taken, so 2 usable slots have nothing free; 3 opens E (index 2)
    check(firstFreeQuickSlot(slots, 2) === -1 && firstFreeQuickSlot(slots, 3) === 2, 'quick: first free usable slot follows QUICK_SLOT_UNLOCK_ORDER');
    check(firstFreeQuickSlot(slots, 0) === -1 && firstFreeQuickSlot(slots, 8) === 2, 'quick: first free with 0 / 8 usable slots');

    // a smaller bag strands whatever sits past its usable count — the system hands those back to the grid
    check(lockedQuickItems(slots, 8).length === 0, 'quick: nothing is stranded under an 8-slot bag');
    const stranded = lockedQuickItems(slots, 1);
    check(stranded.length === 1 && stranded[0].index === QUICK_AUTO_STIM && stranded[0].item === stim, 'quick: a 1-slot bag strands the S stim');

    // merging tops the wheel stack up first (a pickup / craft of the same def)
    const moreStim = loot.createItem('heal_bandage', 2);
    const maxStim = getDef('heal_bandage')?.stackMax ?? 0;
    const before = stim.qty;
    const leftover = mergeIntoQuick(slots, moreStim, getDef);
    check(stim.qty === Math.min(maxStim, before + 2) && leftover === moreStim.qty, 'quick: a pickup merges into the wheel stack first');
    const notStackable = loot.createItem('ammo_medium', 5);
    check(mergeIntoQuick(slots, notStackable, getDef) === notStackable.qty, 'quick: a def with no wheel stack is left untouched');

    // signature changes with qty / active (drives the change event)
    const s1 = quickSlotsSignature(slots, 2);
    stim.qty -= 1;
    const s2 = quickSlotsSignature(slots, 2);
    const s3 = quickSlotsSignature(slots, 3);
    check(s1 !== s2 && s2 !== s3, 'quick: signature tracks qty and active count');
  }

  /*
   * 2026-09-10 — **퀵슬롯 1:1 교체는 가방 여유를 요구하지 않는다** (`QuickSwap.ts`).
   *
   * `setQuickSlot` 은 옮기기라 휠에 있던 스택이 갈 자리가 있어야 하는데, 예전에는 그 자리를 **가방에서만**
   * 찾아 가방이 꽉 차면 교체가 통째로 거절됐다. 들어오는 스택이 격자에서 빠지면 **그 칸이 비므로** 교체는
   * 언제나 성립한다. 여기서 재는 것은 그 규칙 — 출발지별 성공, 자리 없으면 실패, 실패했으면 원상복구.
   */
  {
    const mkBag = (): { bag: Grid; filler: ItemInstance[] } => {
      const bag = new Grid(2, 2, getDef);                 // 4칸
      const filler = [0, 1, 2, 3].map(() => loot.createItem('gem_quartz'));   // 1×1 ×4 = 가방 꽉 참
      for (const f of filler) bag.place(f, filler.indexOf(f) % 2, Math.floor(filler.indexOf(f) / 2));
      return { bag, filler };
    };
    const nade = (q = 1): ItemInstance => loot.createItem('grenade_frag', q);
    const stim = (q = 1): ItemInstance => loot.createItem('heal_bandage', q);

    // ① 가방 격자 → 휠: 밀려난 스택이 **드래그해 온 아이템이 비운 그 칸**으로 들어간다
    {
      const bag = new Grid(2, 2, getDef);
      for (let i = 0; i < 3; i++) bag.place(loot.createItem('gem_quartz'), i % 2, Math.floor(i / 2));
      const incoming = nade(2);
      check(bag.place(incoming, 1, 1), 'quickswap: 가방을 꽉 채운다 (마지막 칸 = 들어올 스택)');
      const occupant = stim(2);
      const plan = { occupant, bag, source: bag, cell: { x: 1, y: 1, rotated: false }, incomingUid: incoming.uid, allowSource: true };
      check(canQuickSwap(plan), 'quickswap: 가방이 꽉 차 있어도 교체는 성립한다 (미리보기)');
      bag.remove(incoming.uid);                            // setQuickSlot 이 하는 그대로
      check(applyQuickSwap(plan) === 'cell', 'quickswap: 밀려난 스택이 비운 그 칸으로 들어간다');
      const at = bag.get(occupant.uid);
      check(!!at && at.x === 1 && at.y === 1, 'quickswap: 정확히 그 자리다');
      check(!bag.has(incoming.uid) && bag.count === 4, 'quickswap: 들어온 스택은 격자에 없고 칸 수는 그대로');
    }

    // ② 컨테이너 → 휠: 가방이 꽉 차면 밀려난 스택이 **그 상자의 빈 자리**로 간다
    {
      const { bag } = mkBag();
      const crate = new Grid(2, 1, getDef);
      const incoming = nade(1);
      check(crate.place(incoming, 0, 0), 'quickswap: 상자에 들어올 스택');
      const occupant = stim(1);
      const plan = { occupant, bag, source: crate, cell: { x: 0, y: 0, rotated: false }, incomingUid: incoming.uid, allowSource: true };
      check(canQuickSwap(plan), 'quickswap: 가방이 꽉 차도 상자 → 휠 교체는 성립한다');
      crate.remove(incoming.uid);
      check(applyQuickSwap(plan) === 'cell', 'quickswap: 밀려난 스택이 상자의 그 칸으로 간다');
      check(crate.has(occupant.uid) && !bag.has(occupant.uid), 'quickswap: 상자에 있고 가방에는 없다');
    }

    // ③ 상자에서 왔더라도 **가방에 자리가 있으면 가방으로** (내 소모품을 상자 바닥에 흘려 두지 않는다 —
    //    자리가 있을 때의 예전 동작 그대로다)
    {
      const bag = new Grid(2, 2, getDef);
      const crate = new Grid(2, 1, getDef);
      const incoming = nade(1);
      crate.place(incoming, 0, 0);
      const occupant = stim(1);
      const plan = { occupant, bag, source: crate, cell: { x: 0, y: 0, rotated: false }, incomingUid: incoming.uid, allowSource: true };
      crate.remove(incoming.uid);
      check(applyQuickSwap(plan) === 'bag', 'quickswap: 상자에서 와도 가방에 자리가 있으면 가방이 먼저다');
      check(bag.has(occupant.uid) && !crate.has(occupant.uid), 'quickswap: 상자 바닥에 흘려 두지 않는다');
    }

    // ④ 멀티플레이의 공유 상자에는 넣지 않는다 (`allowSource: false`) — 가방이 꽉 차면 거절
    {
      const { bag } = mkBag();
      const crate = new Grid(2, 1, getDef);
      const incoming = nade(1);
      crate.place(incoming, 0, 0);
      const occupant = stim(1);
      const plan = { occupant, bag, source: crate, cell: { x: 0, y: 0, rotated: false }, incomingUid: incoming.uid, allowSource: false };
      check(!canQuickSwap(plan), 'quickswap: 공유 상자 + 꽉 찬 가방 = 교체 거절');
      crate.remove(incoming.uid);
      check(applyQuickSwap(plan) === null, 'quickswap: 거절은 실제로도 거절이다');
      check(!crate.has(occupant.uid) && !bag.has(occupant.uid), 'quickswap: 거절했으면 아무 격자도 건드리지 않는다');
    }

    // ⑤ 아무 데도 못 놓으면 null 이고 **격자는 하나도 바뀌지 않는다** (호출자가 들어온 스택을 되돌린다)
    {
      const { bag, filler } = mkBag();
      const crate = new Grid(1, 1, getDef);
      const incoming = loot.createItem('sample_canister');       // 3×1 — 1×1 상자에는 애초에 안 들어간다
      const occupant = loot.createItem('wpn_ar');                // 4×2 — 어느 격자에도 안 들어간다
      const plan = { occupant, bag, source: crate, cell: { x: 0, y: 0, rotated: false }, incomingUid: incoming.uid, allowSource: true };
      check(!canQuickSwap(plan), 'quickswap: 어디에도 안 들어가면 미리보기가 막는다');
      const before = bag.snapshot();
      check(applyQuickSwap(plan) === null, 'quickswap: 실행도 null');
      check(bag.count === 4 && filler.every((f) => bag.has(f.uid)), 'quickswap: 실패해도 가방은 그대로');
      bag.restore(before);
    }

    // ⑥ 병합으로도 자리가 난다 — 가방에 같은 소모품 스택이 있으면 칸이 없어도 흡수된다
    {
      const bag = new Grid(2, 2, getDef);
      const room = loot.createItem('heal_bandage', 1);
      const maxStim = getDef('heal_bandage')?.stackMax ?? 3;
      for (let i = 0; i < 3; i++) bag.place(loot.createItem('gem_quartz'), i % 2, Math.floor(i / 2));
      check(bag.place(room, 1, 1) && bag.count === 4, 'quickswap: 가방이 꽉 찼고 마지막 칸이 붕대 1개');
      const crate = new Grid(1, 1, getDef);
      const incoming = nade(1);
      crate.place(incoming, 0, 0);
      const occupant = stim(Math.max(1, maxStim - 1));
      const plan = { occupant, bag, source: crate, cell: { x: 0, y: 0, rotated: false }, incomingUid: incoming.uid, allowSource: true };
      check(canQuickSwap(plan) && applyQuickSwap(plan) === 'bag', 'quickswap: 빈 칸이 없어도 같은 스택에 병합된다');
      check(occupant.qty === 0 && room.qty === maxStim, 'quickswap: 밀려난 스택이 통째로 병합됐다');
    }
  }

  /* ── 2026-09-10 (제작 대개편 2단계): 내구도 연동 수리 · 분해 ───────────────────────────────────
   *
   * 인벤토리가 이 규칙에 **의존**한다 (수리 팝업 · 분해 팝업 · `updateCraft` 의 산출). 그래서 `items/` 의
   * `checkSalvageEconomy()` (npm run data:check) 와 별개로, **인벤토리가 실제로 부르는 `LootRef` 표면**
   * 으로 한 번 더 확인한다 — 구간 경계 · 방향 · 무한 이득 루프 없음. */
  {
    /** 이 def 의 최대 내구도 — 무기는 실효 스탯, 나머지는 `ItemDef.durabilityMax`. */
    const maxDurOf = (defId: string): number => {
      const stats = loot.getEffectiveStats(loot.createItem(defId));
      return stats ? stats.maxDurability : (getDef(defId)?.durabilityMax ?? 0);
    };
    /** 남은 비율 `frac` 인 인스턴스 하나. */
    const at = (defId: string, frac: number): ItemInstance =>
      loot.createItem(defId, 1, { durability: Math.max(0, Math.round(maxDurOf(defId) * frac)) });
    const bucketAt = (defId: string, frac: number): number => loot.durabilityBucketOf(at(defId, frac));
    // 20 % 단위 다섯 구간, 경계는 아래 구간에 붙는다 (`bucketOfRatio`)
    check(bucketAt('armor_1', 1.0) === 4, '내구도 구간: 100 % → 4');
    check(bucketAt('armor_1', 0.81) === 4, '내구도 구간: 81 % → 4');
    check(bucketAt('armor_1', 0.80) === 3, '내구도 구간: 80 % → 3 (경계는 아래로)');
    check(bucketAt('armor_1', 0.21) === 1, '내구도 구간: 21 % → 1');
    check(bucketAt('armor_1', 0.20) === 0, '내구도 구간: 20 % → 0');
    check(bucketAt('armor_1', 0) === 0, '내구도 구간: 0 % → 0');
    // 내구도가 없는 것(재료 · 탄약 · 가방)은 언제나 구간 4 — UI 가 구간 줄을 그리지 않는 조건이기도 하다
    check(loot.durabilityBucketOf(loot.createItem('mat_scrap', 3)) === 4, '내구도 구간: 내구도가 없으면 언제나 4');
    check(loot.durabilityBucketOf(loot.createItem('bag_common')) === 4, '내구도 구간: 가방도 4');

    const total = (list: readonly { defId: string; qty: number }[]): number => list.reduce((s, c) => s + c.qty, 0);
    const outsOf = (defId: string, frac: number): { defId: string; qty: number }[] => {
      const r = loot.getSalvageFor(at(defId, frac));
      return r ? [{ defId: r.outputDefId, qty: r.outputQty }, ...(r.extraOutputs ?? [])] : [];
    };
    const repairAt = (defId: string, frac: number): number => total(loot.getRepairCost(at(defId, frac)));
    for (const id of ['armor_1', 'armor_3', 'wpn_ar', 'wpn_sr_g3']) {
      const fresh = total(outsOf(id, 1)), wrecked = total(outsOf(id, 0.05));
      check(fresh > wrecked, `분해 산출은 내구도를 탄다: ${id} 만피 ${fresh} > 5 % ${wrecked}`);
      check(repairAt(id, 1) === 0, `가득 찬 ${id} 는 수리비가 없다`);
      check(repairAt(id, 0.05) > repairAt(id, 0.9), `수리비는 내구도가 낮을수록 비싸다 (${id})`);
    }
    // **방탄복 수리는 공짜가 아니다** (2026-09-10) — 예전에는 이 자리가 빈 배열이라 재료 없이 만피가 됐다
    check(repairAt('armor_1', 0.5) > 0, '방탄복 수리에도 재료가 든다');

    // 「제작 → (수리) → 분해 → 제작」 이 이득이 되지 않는다: 어느 구간에서도 수리 + 분해 ≤ 제작
    for (const id of ['armor_1', 'armor_5', 'wpn_ar', 'wpn_smg_g4', 'bag_rare']) {
      const craft = new Map<string, number>();
      for (const c of loot.getCraftCostOf(id)) craft.set(c.defId, (craft.get(c.defId) ?? 0) + c.qty);
      if (craft.size === 0) continue;
      for (const frac of [0.05, 0.3, 0.5, 0.7, 1.0]) {
        const got = new Map<string, number>();
        for (const o of outsOf(id, frac)) got.set(o.defId, (got.get(o.defId) ?? 0) + o.qty);
        for (const c of loot.getRepairCost(at(id, frac))) got.set(c.defId, (got.get(c.defId) ?? 0) + c.qty);
        for (const [mat, qty] of got) {
          check(qty <= (craft.get(mat) ?? 0), `무한 이득 없음: ${id} @${Math.round(frac * 100)} % 의 ${mat} ${qty} ≤ 제작 ${craft.get(mat) ?? 0}`);
        }
      }
    }
    // 유니크는 제작 레시피가 없으니 분해도 없다 (되돌릴 수 없는 유일품) — 수리는 된다
    for (const id of ['armor_regen', 'armor_optical']) {
      check(loot.getCraftCostOf(id).length === 0, `유니크에는 제작 레시피가 없다 (${id})`);
      check(loot.getSalvageFor(loot.createItem(id)) === null, `유니크는 분해되지 않는다 (${id})`);
      check(repairAt(id, 0.5) > 0, `유니크도 수리는 된다 (${id})`);
    }
  }

  if (failures === 0) console.info('[InventorySelfTest] all checks passed');
  else console.error(`[InventorySelfTest] ${failures} check(s) failed`);
  return failures === 0;
}
