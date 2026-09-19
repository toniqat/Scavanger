/**
 * src/inventory/parts/CorpseLoot.ts — **on death everything carried goes to the corpse** (2026-09-09).
 *
 * The one question this file answers: *what happens to the inventory when the player dies fully, and how those
 * contents become the corpse container.*
 *
 * - `stripForCorpse()` — pulls the equipment slots · bag grid · quick slots out whole and leaves the player **empty-handed**
 *   (once, in the death handling). A weapon's durability · loaded ammo · sockets ride along on the `ItemInstance`, so they are
 *   preserved. 2026-09-11 (C-12): the equipped implants' **broken pairs** (`ctx.progression.stripImplantsForCorpse`) go to the
 *   corpse too. (C-36): before the strip the equipped bag wears one raid's worth.
 * - `openContainerItemsSized()` — a corpse uses a grid bigger than a crate's (`PLAYER_CORPSE_COLS × PLAYER_CORPSE_ROWS`
 *   against `CONTAINER_COLS × CONTAINER_ROWS`). When even that is not enough (a legendary bag full + two weapons +
 *   quick slots + implants) it takes everything in **by growing rows** — `fitCorpseGrid`.
 * - `primeCorpseContainer()` — in multiplayer the container is built the moment the `pcorpse` wire arrives, so the host can
 *   judge a `contq take` for **a corpse it never opened**. The take itself is the existing `cont` / `contq` path unchanged.
 */
import * as THREE from 'three';
import type { CorpseItemWire, GameContext, ItemInstance, PlayerCorpseWire } from '@/shared';
import { PLAYER_CORPSE_COLS, PLAYER_CORPSE_ROWS, normalizeMealQuality } from '@/shared';
import { resolveItemAlias } from '@/shared';   // 2026-09-13 (the library series): old media ids on a corpse that came from an older peer · an old save
import { ITEM_DEF_MAP } from '@/items';
import { Grid } from '../Grid';
import { LOADOUT_SLOTS } from '../model';
import type { InventorySystem } from '../InventorySystem';
import * as Docs from './ProfileDocs';
import * as Pouch from './Pouch';

/** The `pcorpse:...` container grid (bigger than a crate's — the equipment + bag at the moment of death must all fit). */
export function corpseGridSize(): { cols: number; rows: number } {
  return { cols: PLAYER_CORPSE_COLS, rows: PLAYER_CORPSE_ROWS };
}

/** The cap on the rows `fitCorpseGrid` adds (on top of the base row count) — beyond that it is not a grid but a bug. */
const CORPSE_GRID_GROW_LIMIT = 64;

/**
 * 2026-09-11 (C-12) — the grid every one of `items` fits into **in that exact order** (`autoPlace`, as in `Container.fill`).
 * When the base `cols × rows` is not enough the columns stay and only rows are added. The simulation runs on shallow
 * copies (`autoPlace` changes `qty` while merging stacks), so the instances handed in are left alone.
 *
 * The same list gives the same size, so the dead player · the host (`primeCorpseContainer`) · someone who opens it late all
 * build the same grid (a take travels by `idx`, not by grid position, so a differing size would not be wrong — but the same is better).
 * Once the implants' broken pairs started coming to the corpse, a legendary bag full + two weapons + quick slots + implants
 * can go past `PLAYER_CORPSE_COLS × PLAYER_CORPSE_ROWS` — the overflow used to **disappear** with one warning line (`Container.fill`).
 */
export function fitCorpseGrid(items: readonly ItemInstance[], cols: number, rows: number): { cols: number; rows: number } {
  const getDef = (id: string) => ITEM_DEF_MAP.get(id);
  let c = Math.max(1, Math.floor(cols));
  const r0 = Math.max(1, Math.floor(rows));
  for (const it of items) {
    const d = getDef(it.defId);
    if (d) c = Math.max(c, Math.min(d.width, d.height));   // rotation is allowed, so the short side must fit
  }
  for (let r = r0; r <= r0 + CORPSE_GRID_GROW_LIMIT; r++) {
    const g = new Grid(c, r, getDef);
    if (items.every((it) => g.autoPlace({ ...it }))) return { cols: c, rows: r };
  }
  return { cols: c, rows: r0 + CORPSE_GRID_GROW_LIMIT };
}

/**
 * Pulls everything held at the moment of death — the equipment slots (주무기 I · II · 방탄복 · 가방; the `secondary` slot
 * survives in the contract only and is always empty) · the bag grid · the quick slots · **the equipped implants' broken
 * twins** — into one list and empties the local inventory. **Revival fully empty-handed** (user's decision): nothing is handed back on the rescue drop either.
 *
 * 2026-09-11 (C-12, user's decision): implants no longer stay on the body. `ctx.progression.stripImplantsForCorpse()` skips
 * the ship gate, unequips them, returns the **broken pair** instances and saves itself — here they are only taken and
 * appended to the end of the list. On a build without that method (an optional contract) it is an empty array and nothing changes.
 * (C-36): **before** the strip the equipped bag wears one raid's worth (`wearBagForRaid`, once per raid together with extraction).
 */
export function stripForCorpse(sys: InventorySystem): ItemInstance[] {
  sys.wearBagForRaid();
  const out: ItemInstance[] = [];
  for (const s of LOADOUT_SLOTS) {
    const it = sys.loadout[s];
    if (it) out.push(it);
  }
  for (const p of sys.bag.items()) out.push(p.item);
  // 2026-09-09: the wheel is its own container — its stacks are carried too, so they go on the corpse as well
  for (const it of sys.quickSlots) if (it) out.push(it);
  // 2026-09-11 (A-15): what is inside the pouch goes the same way (the pouch item itself was already taken by `LOADOUT_SLOTS` above)
  for (const it of Pouch.drainPouch(sys)) out.push(it);
  // 2026-09-11 (C-12): the equipped implants' broken pairs (progression unequips + saves itself; optional contract)
  const implants = sys.ctx.progression?.stripImplantsForCorpse?.() ?? [];
  for (const it of implants) if (it) out.push(it);

  sys.closeAll();
  sys.loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null, pouch: null };
  sys.bag.clear();
  const size = sys.bagSizeOf(null);
  sys.bag.resize(size.cols, size.rows);
  sys.quickSlots.fill(null);
  Pouch.resetPouchGrid(sys);
  sys.strippedForCorpse = true;
  sys.lastGrenades = -1; sys.lastStims = -1; sys.lastQuickSig = ''; sys.lastPouchSig = '';
  sys.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: [] });
  sys.emitLoadout();
  sys.afterChange();
  // a reload after death must not resurrect the kit that is now lying on the ground
  sys.announcePending = false;
  sys.loadoutStore.saveNow('corpse');
  // 2026-09-11 (E-6): the empty loadout and the implant strip progression just saved are one edit → one transaction
  Docs.joinProfileTx(sys, ['loadout', 'progression']);
  return out;
}

/**
 * The same as `openContainerItems` but with the grid size given. For an id already known both `items` and the size are
 * ignored and what is left inside is shown (the container cache is the truth).
 */
export function openContainerItemsSized(sys: InventorySystem, containerId: string, items: ItemInstance[],
  position: THREE.Vector3, cols: number, rows: number, title?: string): void {
  if (sys.isShowingContainer(containerId)) return;   // 2026-09-11 (C-16): already on screen — no re-show, no event
  const first = !sys.openedIds.has(containerId);
  sys.openedIds.add(containerId);
  const size = sys.containers.get(containerId) ? { cols, rows } : fitCorpseGrid(items, cols, rows);
  const c = sys.containers.getOrCreateWithItems(containerId, items, position, title, size);
  sys.showContainer(c);
  sys.ctx.bus.emit('inventory:containerOpened', { containerId, first });
}

/** `CorpseItemWire[]` → real instances (durability · loaded ammo · sockets ride along in `ex`). */
export function corpseItemsFromWire(sys: InventorySystem, wire: readonly CorpseItemWire[]): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (const w of wire) {
    if (!w || typeof w.defId !== 'string') continue;
    const defId = resolveItemAlias(w.defId);
    if (!ITEM_DEF_MAP.has(defId)) continue;
    const item = sys.loot.createItem(defId, Math.max(1, Math.floor(w.qty || 1)), w.ex);
    if (item && typeof w.rf === 'number' && Number.isFinite(w.rf)) item.raidFound = w.rf >>> 0;   // 2026-09-12: omitted = no mark
    const q = normalizeMealQuality(w.q);   // 2026-09-13: meal quality (omitted = 0)
    if (item && q > 0) item.quality = q;
    if (item) out.push(item);
  }
  return out;
}

/**
 * Builds the corpse container **without opening it**. The host has to judge a `contq take` for a corpse it has never
 * opened once, and a client that joins late must get the same `idx` order.
 * An id already known is left alone.
 */
export function primeCorpseContainer(sys: InventorySystem, wire: PlayerCorpseWire): void {
  if (!wire || typeof wire.id !== 'string' || sys.containers.get(wire.id)) return;
  const p = wire.p;
  const pos = new THREE.Vector3(p?.[0] ?? 0, p?.[1] ?? 0, p?.[2] ?? 0);
  const items = corpseItemsFromWire(sys, wire.items ?? []);
  const base = corpseGridSize();
  sys.containers.getOrCreateWithItems(wire.id, items, pos,
    `${wire.name ?? '분대원'}의 유해`, fitCorpseGrid(items, base.cols, base.rows));
}

/** The `pcorpse` subscription — the container is built the moment the wire arrives (once, in `init`). */
export function hookCorpseWire(sys: InventorySystem, ctx: GameContext): (() => void) | null {
  const net = ctx.net;
  if (!net || typeof net.onMessage !== 'function') return null;
  return net.onMessage('pcorpse', (msg) => {
    if (msg.ev === 'spawn') primeCorpseContainer(sys, msg.corpse);
    else if (msg.ev === 'sync') for (const c of msg.corpses ?? []) primeCorpseContainer(sys, c);
  });
}
