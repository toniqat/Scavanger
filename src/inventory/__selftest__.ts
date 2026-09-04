import { INVENTORY_COLS, INVENTORY_ROWS, Random } from '@/shared';
import { ITEM_DEF_MAP, LootService, STARTER_LOADOUT } from '@/items';
import { Grid } from './Grid';

/**
 * Dev-only self check for the pure grid + loot logic (no test runner installed).
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

  // starter ids exist
  check(!!getDef(STARTER_LOADOUT.primary) && !!getDef(STARTER_LOADOUT.secondary), 'starter weapon defs exist');
  for (const e of STARTER_LOADOUT.bag) check(!!getDef(e.id), `starter bag def '${e.id}' exists`);

  if (failures === 0) console.info('[InventorySelfTest] all checks passed');
  else console.error(`[InventorySelfTest] ${failures} check(s) failed`);
  return failures === 0;
}
