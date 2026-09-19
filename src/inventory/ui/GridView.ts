import type { AmmoType, EffectiveWeaponStats, ItemDef, ItemInstance, Loadout, RaidFoundScope, SocketSlot } from '@/shared';
import { CONTAINER_TAKE_ANIM_S, CONTAINER_TAKE_END_SCALE, CONTAINER_TAKE_RISE_PX, SOCKET_SLOTS } from '@/shared';
import { countsForRecovery, sameRaidFoundScope } from '@/shared';
import { mealQualityStars, normalizeMealQuality } from '@/shared';
import type { Grid } from '../Grid';
import type { GridId } from '../InventorySystem';
import { WEAPON_SLOT_IDS } from '../model';
import { CELL, DURABILITY_LOW, GAP, TEXT, applyGridCellVar, tileSizeAt } from './labels';

export type DefLookup = (defId: string) => ItemDef | undefined;
/** Effective stats for weapon instances (null for anything else); drives socket pips + durability bar. */
export type StatsLookup = (item: ItemInstance) => EffectiveWeaponStats | null;
export type HighlightState = 'ok' | 'bad' | 'swap' | 'merge';

export interface TileHandlers {
  onPointerDown(uid: string, gridId: GridId, e: PointerEvent): void;
  onEnter(uid: string, gridId: GridId, e: PointerEvent): void;
  onMove(uid: string, gridId: GridId, e: PointerEvent): void;
  onLeave(uid: string, gridId: GridId): void;
  onContext(uid: string, gridId: GridId, e: MouseEvent): void;
  onDblClick(uid: string, gridId: GridId): void;
}

/** Phase 7: an item rolled into a container that has not been searched yet shows only its footprint. */
export const isHiddenItem = (item: ItemInstance): boolean => item.searched === false;

/* ── 2026-09-12 (user's decision): the ribbon only on the ammo I need ────────────────────────────────────────
 * "a display ribbon is added at the top right of an ammo tile only for ammo that fits the weapon I have equipped."
 *
 * `buildTileContent`, which draws the tile, is a **pure function** the grid · equipment slot · ghost · catalog · trade
 * screens all share, so it knows no loadout. One module holds "the ammo types needed now" and the drawing side (the Tab
 * window `InventoryUI` · the embedded grids `TradeGrids`) refreshes it — display state that never touches inventory data.
 */
let neededAmmo: ReadonlySet<string> = new Set<string>();

/** Is `def` the ammo an equipped primary uses (always false when it is not ammo). */
export const isNeededAmmo = (def: ItemDef): boolean =>
  def.category === 'ammo' && def.ammoType !== undefined && neededAmmo.has(def.ammoType);

/**
 * Swaps the table for the ammo types of the equipped primary slots I · II. It returns **true only when it changed**, so
 * the caller redraws the tiles only then (`GridView.refresh(true)`). Swap the gun and the ribbon follows.
 */
export function setNeededAmmoFrom(loadout: Loadout, getStats: StatsLookup): boolean {
  const next = new Set<AmmoType>();
  for (const slot of WEAPON_SLOT_IDS) {
    const w = loadout[slot];
    if (!w) continue;
    const stats = getStats(w);
    if (stats) next.add(stats.ammoType);
  }
  if (next.size === neededAmmo.size) {
    let same = true;
    for (const t of next) if (!neededAmmo.has(t)) { same = false; break; }
    if (same) return false;
  }
  neededAmmo = next;
  return true;
}

/* ── 2026-09-12 (E1, user's decision): favourites — a **blue ribbon** at the tile's top right ─────────────────────
 * The module holds one table for the same reason as `neededAmmo`: `buildTileContent` is a pure function and knows no
 * inventory. Its owner is `InventorySystem` (`parts/Favorites`); only a copy arrives here. `favoriteRev` rises on every
 * change and `GridView.refresh` repaints on it even if the grid version stood still (the ribbon · the dark 「즐겨찾기」 filter).
 */
let favoriteDefs: ReadonlySet<string> = new Set<string>();
let favoriteRev = 0;

/** Is this item def a favourite (a display copy — the rule is `InventoryRef.isFavorite`). */
export const isFavoriteDef = (defId: string): boolean => favoriteDefs.has(defId);
/** How often the favourites table changed — it goes into the signature that decides a redraw. */
export const favoritesRevision = (): number => favoriteRev;
/** Swaps the table (only `parts/Favorites` calls it). */
export function setFavoriteDefs(defs: ReadonlySet<string>): void {
  favoriteDefs = new Set(defs);
  favoriteRev++;
}

/* ── 2026-09-13 (library series, user's decision): a book · video · record 「not yet shelved」 — the **same** ribbon ──────
 * The query is housing's single `HousingRef.isShelfItemWanted(defId)` (that medium's holder is owned + no holder holds the same def).
 * The module holds a source · a cache for the same reason as the favourites table — `buildTileContent` knows no ctx. The source is hung
 * in `parts/ShelfWanted` alone and the answer is asked **once per def** and cached (housing is not called per tile). When
 * `bumpShelfWanted()` empties the cache and raises the revision (`housing:libraryChanged` and the like) `GridView.refresh` repaints
 * even with the grid version unmoved. The class is `.is-shelf-wanted` — CSS lays its selector **beside** the `.is-favorite` rule
 * (both at once = one ribbon). Sort-first · the 「즐겨찾기」 filter · the salvage/sell confirm · the container glow stay the real favourite's.
 */
let shelfWantedSource: ((defId: string) => boolean) | null = null;
let shelfWantedRev = 0;
const shelfWantedCache = new Map<string, boolean>();

/** Does this def's tile take the 「not yet shelved」 ribbon (only books · videos · records are asked — the rest never reach the source). */
export function isShelfWantedDef(def: ItemDef): boolean {
  if (!shelfWantedSource || !(def.book || def.disc || def.record)) return false;
  let v = shelfWantedCache.get(def.id);
  if (v === undefined) {
    try { v = shelfWantedSource(def.id) === true; } catch { v = false; }
    shelfWantedCache.set(def.id, v);
  }
  return v;
}
/** How often the ribbon's answers may have changed — it goes into the signature that decides a redraw. */
export const shelfWantedRevision = (): number => shelfWantedRev;
/** Hangs / unhooks the source (only `parts/ShelfWanted` calls it). */
export function setShelfWantedSource(fn: ((defId: string) => boolean) | null): void {
  shelfWantedSource = fn;
  bumpShelfWanted();
}
/** Empties the cache and raises the revision — the library · a holder changed. */
export function bumpShelfWanted(): void {
  shelfWantedCache.clear();
  shelfWantedRev++;
}

/* ── 2026-09-12 (item recovery contracts, user's decision): a contract item found this raid — the **same** ribbon ────────────
 * Only in a raid (not the training range), `.is-recovery-item` is hung on stacks of an active `extract_with_items` contract item that
 * carry **this raid's mark** (`ItemInstance.raidFound`). CSS declares it as the `.is-favorite` ribbon, so the two are indistinguishable
 * and both at once draw one ribbon. `.is-favorite` still means 「the user's favourite」 alone (filter · sort · glow · sell/salvage
 * confirm). The scope's owner is `InventorySystem` (`parts/RaidFound.raidFoundScope`) and the copy here is swapped every frame · repaint.
 */
let recoveryScope: RaidFoundScope | null = null;
let recoveryRev = 0;

/** Does this tile take the recovery-contract ribbon (a display copy — the rule is `shared/raidFound.countsForRecovery`). */
export const isRecoveryTile = (item: ItemInstance): boolean => countsForRecovery(item, recoveryScope);
/** How often the recovery scope changed — it goes into the signature that decides a redraw. */
export const recoveryRevision = (): number => recoveryRev;
/** Swaps the scope. **True only when it changed**. */
export function setRecoveryScope(scope: RaidFoundScope | null): boolean {
  if (sameRaidFoundScope(scope, recoveryScope)) return false;
  recoveryScope = scope;
  recoveryRev++;
  return true;
}

/**
 * Footprint-only content for an unsearched container item (Phase 7 search): neutral colour, `?` icon, `???` name —
 * nothing that leaks the def (no rarity class / colour, no qty, no pips, no durability).
 */
function buildHiddenTileContent(el: HTMLElement, item: ItemInstance, w: number, h: number, cell: number): void {
  el.className = 'inv-tile rarity-hidden is-hidden-item';
  el.style.removeProperty('--rc');
  const { width, height } = tileSizeAt(w, h, cell);
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.classList.toggle('is-wide', w >= 2);
  el.classList.toggle('is-tall', h >= 2);
  el.classList.toggle('is-rotated', item.rotated);
  el.innerHTML = '';
  const icon = document.createElement('div');
  icon.className = 'inv-tile-icon';
  icon.textContent = TEXT.search.hiddenIcon;
  el.appendChild(icon);
  if (w >= 2 || h >= 2) {
    const name = document.createElement('div');
    name.className = 'inv-tile-name';
    name.textContent = TEXT.search.hiddenName;
    el.appendChild(name);
  }
}

/* ── 2026-09-14 (user's decision): the durability gauge · accepted sockets only ───────────────────────────────────────────
 * **Every tile with durability** (weapon · armor · bag · the 회복 스프레이 gauge …) wears a thin gauge along its bottom — before equipping
 * (bag · stash · crate · corpse · trade grids) and on the equipment-slot card. Its colour walks the remaining ratio **green (full) →
 * yellow → orange → red (empty)**; the palette is CSS variables (`--dur-c-full` · `--dur-c-mid` · `--dur-c-low` · `--dur-c-empty`,
 * inventory.css `:root`) and only **which two of the four evenly spaced colours, at what %** is written here (`--dur-a` · `--dur-b` · `--dur-t`).
 * The number left the tile — `cur / max` is the tooltip's. Pips and the socket row draw **only the accepted sockets** (`stats.sockets`).
 */
const DUR_COLOR_STOPS = ['var(--dur-c-empty)', 'var(--dur-c-low)', 'var(--dur-c-mid)', 'var(--dur-c-full)'] as const;

/** Writes the gauge colour variables for the remaining `ratio` (0 … 1) on `el` — CSS paints with `color-mix(in srgb, var(--dur-b) var(--dur-t), var(--dur-a))`. */
export function setDurabilityColorVars(el: HTMLElement, ratio: number): void {
  const segs = DUR_COLOR_STOPS.length - 1;
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 1)) * segs;
  const i = Math.min(segs - 1, Math.floor(r));
  el.style.setProperty('--dur-a', DUR_COLOR_STOPS[i]);
  el.style.setProperty('--dur-b', DUR_COLOR_STOPS[i + 1]);
  el.style.setProperty('--dur-t', `${Math.round((r - i) * 100)}%`);
}

/** Max durability of a tile's item — the effective stats for a weapon, `def.durabilityMax` otherwise. 0 = no durability (no gauge). */
export function durabilityMaxOf(def: ItemDef, stats?: EffectiveWeaponStats | null): number {
  if (stats) return Math.max(1, stats.maxDurability);
  return def.durabilityMax !== undefined && def.durabilityMax > 0 ? def.durabilityMax : 0;
}

/**
 * The sockets a weapon tile's pips · the tooltip's socket row draw — the sockets that weapon **accepts** (`stats.sockets`) plus an
 * attachment still sitting in a socket it does not accept (an old save), in `SOCKET_SLOTS` order. All five if the field comes empty (an old loader).
 */
export function shownSockets(item: ItemInstance, stats: EffectiveWeaponStats): SocketSlot[] {
  const accepted: readonly SocketSlot[] = Array.isArray(stats.sockets) ? stats.sockets : SOCKET_SLOTS;
  return SOCKET_SLOTS.filter((s) => accepted.includes(s) || !!item.sockets?.[s]);
}

/**
 * The equipped-item card that fills an **equipment slot** box (2026-09-08). Shared by the Tab window
 * (`ui/InventoryUI`) and the read-only 분대원 장비 view (`ui/CrewLoadoutView`) so the two never drift apart.
 *
 * The slot no longer draws the item at its grid footprint: a 4×2 돌격소총 and a 5×1 저격소총 are the same object in
 * the hand and only differ in how they pack a bag, so the box is one size and the card fills it. Everything the old
 * `.inv-slot-meta` sentence carried is laid out in fixed corners instead — name top-left, sockets top-right, rounds
 * bottom-left and the durability gauge along the bottom edge — so the same thing is always in the same place, 무기 · 방탄복 ·
 * 가방 alike. 2026-09-14: the `120/300` durability number is gone (the gauge's colour says it; the tooltip keeps the numbers)
 * and the socket pips are only the sockets the weapon accepts (`shownSockets`).
 *
 * Keeps the `.inv-tile` (+ `.is-weapon`) contract the drag / socket-drop / tooltip code matches on.
 *
 * @returns true when the item is worn (durability below max) — the caller flags its `.inv-slot` with `is-worn`.
 */
export function buildSlotCardContent(el: HTMLElement, item: ItemInstance, def: ItemDef, stats?: EffectiveWeaponStats | null): boolean {
  el.className = `inv-tile inv-slot-card rarity-${def.rarity}`;
  if (isFavoriteDef(def.id)) el.classList.add('is-favorite');   // 2026-09-12 (E1): the blue ribbon
  if (isRecoveryTile(item)) el.classList.add('is-recovery-item');   // 2026-09-12: a recovery contract — the same ribbon
  if (isShelfWantedDef(def)) el.classList.add('is-shelf-wanted');   // 2026-09-13: library media not yet shelved — the same ribbon
  el.style.setProperty('--rc', def.color);
  el.innerHTML = '';

  const icon = document.createElement('div');
  icon.className = 'inv-slot-ico';
  icon.textContent = def.icon;
  el.appendChild(icon);

  const name = document.createElement('div');
  name.className = 'inv-slot-name';
  name.textContent = def.name;
  el.appendChild(name);

  if (stats) {
    el.classList.add('is-weapon');
    const socks = shownSockets(item, stats);
    if (socks.length > 0) {
      const pips = document.createElement('div');
      pips.className = 'inv-slot-sockets';
      for (const sk of socks) {
        const pip = document.createElement('i');
        pip.className = 'inv-pip';
        pip.dataset.socket = sk;
        if (item.sockets?.[sk]) pip.classList.add('is-filled');
        pips.appendChild(pip);
      }
      el.appendChild(pips);
    }

    const ammo = document.createElement('div');
    ammo.className = 'inv-slot-ammo';
    ammo.textContent = `${item.ammoInMag ?? 0}/${stats.magSize}`;
    el.appendChild(ammo);
  }

  // 무기 read their durability from the effective stats; 방탄복 / 가방 from the def
  const max = durabilityMaxOf(def, stats);
  if (max <= 0) return false;
  // 2026-09-14: gauge only — the `cur/max` number (`.inv-slot-durnum`) left the card
  const { cur } = appendDurabilityBar(el, item, max, 'inv-slot-dur', !def.bag);
  return cur < max;
}

/**
 * Builds the visual content of a tile (shared by grid tiles, slot tiles and the drag ghost). Weapons (`stats`
 * given) also get five socket pips (filled = attached) and a thin durability bar (amber < 30 %, red at 0).
 * An unsearched container item (`searched === false`) renders the footprint mask instead.
 */
export function buildTileContent(el: HTMLElement, item: ItemInstance, def: ItemDef, w: number, h: number, stats?: EffectiveWeaponStats | null, cell: number = CELL): void {
  if (isHiddenItem(item)) { buildHiddenTileContent(el, item, w, h, cell); return; }
  el.className = `inv-tile rarity-${def.rarity}`;
  if (def.attachment) el.classList.add('is-attachment');
  if (def.bag) el.classList.add('is-bag');
  // 2026-09-12: the top-right ribbon — only ammo the equipped weapon uses (it can never collide with a weapon tile's socket pips)
  if (isNeededAmmo(def)) el.classList.add('is-ammo-needed');
  // 2026-09-12 (E1): the favourite's blue ribbon — if it is needed ammo too, CSS pushes the yellow ribbon **below** it (both show)
  if (isFavoriteDef(def.id)) el.classList.add('is-favorite');
  // 2026-09-12: a recovery-contract item found this raid — the favourite's ribbon (an unsearched tile already returned above: nothing leaks)
  if (isRecoveryTile(item)) el.classList.add('is-recovery-item');
  // 2026-09-13 (library series): a book · video · record whose holder is owned but which is shelved nowhere — the same ribbon (with a favourite CSS draws one)
  if (isShelfWantedDef(def)) el.classList.add('is-shelf-wanted');
  el.style.setProperty('--rc', def.color);
  const { width, height } = tileSizeAt(w, h, cell);
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.classList.toggle('is-wide', w >= 2);
  el.classList.toggle('is-tall', h >= 2);
  el.classList.toggle('is-rotated', item.rotated);
  el.innerHTML = '';

  const icon = document.createElement('div');
  icon.className = 'inv-tile-icon';
  icon.textContent = def.icon;
  el.appendChild(icon);

  if (w >= 2 || h >= 2) {
    const name = document.createElement('div');
    name.className = 'inv-tile-name';
    name.textContent = def.name;
    el.appendChild(name);
  }

  const qty = document.createElement('div');
  qty.className = 'inv-tile-qty';
  qty.textContent = def.stackMax > 1 ? `${item.qty}` : '';
  qty.hidden = def.stackMax <= 1;
  el.appendChild(qty);

  // 2026-09-13 (meal quality): a small `★n` bottom left, on a meal with quality only — its corner differs from qty (bottom right) · wheel dir (top left) · ribbon (top right)
  const quality = def.meal ? normalizeMealQuality(item.quality) : 0;
  if (quality > 0) {
    el.classList.add('has-quality');
    const star = document.createElement('div');
    star.className = 'inv-tile-quality';
    star.dataset.quality = String(quality);
    star.textContent = `★${quality}`;
    star.title = mealQualityStars(quality);
    el.appendChild(star);
  }

  if (stats) {
    el.classList.add('is-weapon');
    // 2026-09-14: only the sockets this weapon accepts (a unique that accepts none draws no pip row)
    const socks = shownSockets(item, stats);
    if (socks.length > 0) {
      const pips = document.createElement('div');
      pips.className = 'inv-tile-sockets';
      for (const s of socks) {
        const pip = document.createElement('i');
        pip.className = 'inv-pip';
        pip.dataset.socket = s;
        if (item.sockets?.[s]) pip.classList.add('is-filled');
        pips.appendChild(pip);
      }
      el.appendChild(pips);
    }
  }
  /*
 * 2026-09-14 (user's decision): **every** item with durability wears the gauge — weapons (effective max), 방탄복 · 가방 and a
   * channelled consumable's 게이지 (회복 스프레이, Phase 12 — an empty can stays a tile, marked broken, until the ship
   * repairs it). Before this only weapons and the spray had a bar, so a worn 방탄복 looked new until it was equipped.
   */
  const durMax = durabilityMaxOf(def, stats);
  if (durMax > 0) appendDurabilityBar(el, item, durMax, 'inv-tile-dur', !def.bag);

  const glow = document.createElement('div');
  glow.className = 'inv-tile-glow';
  el.appendChild(glow);
}

/**
 * Thin durability gauge along the tile's bottom edge (`.inv-tile-dur`, the slot card's `.inv-slot-dur`): a track with a
 * child fill (`i.inv-dur-fill`, width `--p`) coloured by the remaining ratio (`setDurabilityColorVars`); `is-low` under
 * `DURABILITY_LOW`, `is-broken` on the bar **and** the tile at 0. `data-ratio` carries the ratio (smoke / debug).
 */
function appendDurabilityBar(el: HTMLElement, item: ItemInstance, maxDurability: number, cls = 'inv-tile-dur', breakable = true): { cur: number; max: number } {
  const max = Math.max(1, maxDurability);
  const cur = Math.max(0, Math.min(max, item.durability ?? max));
  const ratio = cur / max;
  const bar = document.createElement('div');
  bar.className = `${cls} inv-dur`;
  bar.style.setProperty('--p', `${Math.round(ratio * 100)}%`);
  bar.dataset.ratio = ratio.toFixed(3);
  setDurabilityColorVars(bar, ratio);
  const fill = document.createElement('i');
  fill.className = 'inv-dur-fill';
  bar.appendChild(fill);
  // a 가방 at 0 keeps its grid (2026-09-11 C-36: "0 이어도 효과 없음") — an empty gauge, never the red broken look
  if (cur <= 0 && breakable) { bar.classList.add('is-broken'); el.classList.add('is-broken'); }
  else if (ratio < DURABILITY_LOW) bar.classList.add('is-low');
  el.appendChild(bar);
  return { cur, max };
}

/**
 * 2026-09-12: everything a grid tile draws, as one string — `GridView.refresh` rebuilds a tile's DOM only when this
 * changed. Weapon stats (sockets / grade / durability bar) derive from the fields listed here, so they are covered.
 * Several parts do **not** come from the instance, so they are folded in explicitly — each can change while the item
 * stands still, and each draws a ribbon or a badge:
 *  - `needAmmo` (2026-09-12) — the **equipped weapon**'s calibre, so swapping guns redraws the ammo tiles.
 *  - `favorite` (2026-09-12, E1) — the def-id table in this module (`parts/Favorites` owns it).
 *  - `recovery` (2026-09-12) — the active recovery contract's scope (`parts/RaidFound`), so taking or abandoning a
 *    contract redraws the marked tiles.
 *  - `shelfWanted` (2026-09-13) — `HousingRef.isShelfItemWanted`, so shelving a volume drops the ribbon.
 * `item.quality` is on the instance but is listed too, because the ★ badge is drawn from it.
 */
function tileSignature(item: ItemInstance, w: number, h: number, badge: string | undefined, needAmmo: boolean, favorite: boolean, recovery = false, shelfWanted = false): string {
  let sockets = '';
  if (item.sockets) for (const s of SOCKET_SLOTS) sockets += `${item.sockets[s]?.defId ?? ''},`;
  return `${item.defId}|${item.qty}|${item.rotated ? 1 : 0}|${w}x${h}|${item.durability ?? ''}|${item.ammoInMag ?? ''}|${sockets}|${item.searched === false ? 0 : 1}|${badge ?? ''}|${needAmmo ? 1 : 0}|${favorite ? 1 : 0}|${recovery ? 1 : 0}|${item.quality ?? ''}|${shelfWanted ? 1 : 0}`;
}

/** Small wheel-direction badge (top-left) on a bag tile that sits in a quick-use slot. */
export function addQuickBadge(el: HTMLElement, glyph: string): void {
  el.classList.add('is-quick');
  const b = document.createElement('div');
  b.className = 'inv-tile-quick';
  b.textContent = glyph;
  el.appendChild(b);
}

/**
 * Renders one Grid as DOM: a static cell layer, absolutely positioned item
 * tiles, and a highlight rectangle for drag feedback. Tiles are diffed by uid so
 * only changed grids re-render.
 */
export class GridView {
  readonly el: HTMLElement;
  private cellsEl: HTMLElement;
  private tilesEl: HTMLElement;
  private hlEl: HTMLElement;
  private tiles = new Map<string, HTMLElement>();
  private grid: Grid | null = null;
  private lastVersion = -1;
  /** 2026-09-12 (E1): `favoritesRevision()` at the last repaint. */
  private lastFavRev = -1;
  /** 2026-09-12 (item recovery contracts): `recoveryRevision()` at the last repaint. */
  private lastRecoveryRev = -1;
  /** 2026-09-13 (library series): `shelfWantedRevision()` at the last repaint. */
  private lastShelfRev = -1;
  private dims = '';
  /** uid → direction glyph for items assigned to the quick-use wheel (bag grid only). */
  private quickBadges = new Map<string, string>();
  /** Phase 7: the container item being searched (`.inv-tile-scan` with `--p`) and takes awaiting the host. */
  private scan: { uid: string; progress: number } | null = null;
  private pendingUids = new Set<string>();
  /** Phase 10: uids whose next removal animates out instead of being deleted on the spot (a live container take). */
  private vanishUids = new Set<string>();
  /** Tiles currently animating out → their removal timer. */
  private vanishing = new Map<HTMLElement, number>();
  /**
   * 2026-09-09: items this view must **not draw** although they sit in the grid (no tile → no hover, no press, no
   * drag, no menu). The stash view answers with `ctx.tutorial.hides('stashItem', defId)` so the guided steps show only
   * the tutorial's own materials; the data is untouched and the tiles come back on the next forced refresh.
   */
  private hideItem: ((item: ItemInstance) => boolean) | null = null;

  /** Cell edge / cell pitch of this grid in px. Only the 기업 거래 desk passes anything but the default. */
  /** 2026-09-14: it used to be `readonly` — crossing a window-height step makes `setCell` move both together. */
  private cell: number;
  private step: number;
  /**
   * 2026-09-12 (the fixed bag frame, user's decision): the box is drawn at least this many rows tall. Rows past the grid's real
   * `rows` are blank space — no cell layer, no drop target — so the 가방 panel keeps the size of the longest bag and a
   * bigger bag simply fills more of that space with cells. null = the box is exactly the grid.
   */
  private frameRows: number | null = null;
  /**
   * 2026-09-12 (the filter): tiles the predicate rejects get `.is-filtered-out` (dimmed). Positions never change and the
   * tile stays draggable — a Diablo grid that hid items would lie about which cells are free.
   */
  private filter: ((item: ItemInstance, def: ItemDef) => boolean) | null = null;
  /**
   * 2026-09-12: per-tile content signature. `refresh` used to rebuild **every** tile's DOM whenever the grid version
   * moved (a 200-stack 창고 → 200 × `innerHTML` for one drop), which is what made dragging in the embedded grids
   * stutter. A tile is now rebuilt only when what it draws changed; otherwise only its position is written.
   */
  private sigs = new Map<string, string>();

  constructor(readonly id: GridId, private readonly getDef: DefLookup, private readonly getStats: StatsLookup, private readonly handlers: TileHandlers, cell: number = CELL) {
    this.cell = cell;
    this.step = cell + GAP;
    this.el = document.createElement('div');
    this.el.className = `inv-grid inv-grid-${id}`;
    // 2026-09-14: written **always**. It used to be left to the CSS `--inv-cell` at the default size, but that value now
    // moves with the window height (`labels.gridCellForHeight`), so writing it in one place alone splits it from JS's `step`.
    applyGridCellVar(this.el, cell);
    this.cellsEl = document.createElement('div');
    this.cellsEl.className = 'inv-cells';
    this.tilesEl = document.createElement('div');
    this.tilesEl.className = 'inv-tiles';
    this.hlEl = document.createElement('div');
    this.hlEl.className = 'inv-hl';
    this.hlEl.hidden = true;
    this.el.append(this.cellsEl, this.tilesEl, this.hlEl);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get current(): Grid | null { return this.grid; }

  /** Predicate for items to leave undrawn (see `hideItem`); null shows everything. Re-renders at once. */
  setHideItem(fn: ((item: ItemInstance) => boolean) | null): void {
    this.hideItem = fn;
    this.refresh(true);
  }

  setGrid(grid: Grid | null): void {
    this.grid = grid;
    this.lastVersion = -1;
    this.sigs.clear();
    if (!grid) { this.clearTiles(); return; }
    this.syncDims(grid);
    this.refresh(true);
  }

  /**
   * 2026-09-14 (smaller cells on a small screen): changes the cell edge. Box px · drag pitch · highlight all read `step`,
   * so the CSS variable and `step` move **at once** and the cell layer · tiles are redrawn. Called only when a resize crosses a step.
   */
  setCell(px: number): void {
    const cell = Math.max(1, Math.round(px));
    if (cell === this.cell) return;
    this.cell = cell;
    this.step = cell + GAP;
    applyGridCellVar(this.el, cell);
    this.dims = '';               // forces the cell layer to be rebuilt (`syncDims` skips when the dimensions match)
    this.sigs.clear();            // tile content rides the cell size, so the signatures are dropped and everything is redrawn
    if (this.grid) { this.syncDims(this.grid); this.refresh(true); }
  }

  /** 2026-09-12: minimum box height in rows (see `frameRows`); null = exactly the grid. */
  setFrameRows(rows: number | null): void {
    const next = rows !== null && rows > 0 ? Math.floor(rows) : null;
    if (next === this.frameRows) return;
    this.frameRows = next;
    this.dims = '';
    if (this.grid) this.syncDims(this.grid);
    this.el.classList.toggle('has-frame', next !== null);
  }

  /** 2026-09-12: dim every tile the predicate rejects (null = show all at full strength). Cheap: classes only. */
  setFilter(fn: ((item: ItemInstance, def: ItemDef) => boolean) | null): void {
    this.filter = fn;
    const grid = this.grid;
    for (const [uid, el] of this.tiles) {
      const item = grid?.get(uid)?.item;
      const def = item && this.getDef(item.defId);
      el.classList.toggle('is-filtered-out', !!fn && !!item && !!def && !fn(item, def));
    }
  }

  /** Rebuild the cell layer when the grid dimensions changed (bag swap, stash resize). */
  private syncDims(grid: Grid): void {
    const dims = `${grid.cols}x${grid.rows}`;
    if (dims === this.dims) return;
    this.dims = dims;
    this.el.style.setProperty('--cols', String(grid.cols));
    this.el.style.setProperty('--rows', String(grid.rows));
    this.el.style.width = `${grid.cols * this.step - GAP}px`;
    this.el.style.height = `${Math.max(grid.rows, this.frameRows ?? 0) * this.step - GAP}px`;
    this.cellsEl.innerHTML = '';
    for (let i = 0; i < grid.cols * grid.rows; i++) {
      const c = document.createElement('div');
      c.className = 'inv-cell';
      this.cellsEl.appendChild(c);
    }
  }

  refresh(force = false): void {
    const grid = this.grid;
    if (!grid) return;
    // 2026-09-12 (E1): a favourites change repaints even when the grid version stood still (the ribbon · the 「즐겨찾기」 filter)
    // 2026-09-12: …and when the recovery-contract scope changed (raid start / end, contract abandoned) — the ribbon follows it
    // 2026-09-13: …and when the library ribbon's answers may have changed (`housing:libraryChanged`)
    if (!force && grid.version === this.lastVersion && favoriteRev === this.lastFavRev && recoveryRev === this.lastRecoveryRev
      && shelfWantedRev === this.lastShelfRev) return;
    this.lastVersion = grid.version;
    this.lastFavRev = favoriteRev;
    this.lastRecoveryRev = recoveryRev;
    this.lastShelfRev = shelfWantedRev;
    this.syncDims(grid);

    const seen = new Set<string>();
    for (const p of grid.items()) {
      const def = this.getDef(p.item.defId);
      if (!def) continue;
      if (this.hideItem?.(p.item)) continue; // not in `seen` → an existing tile is swept away below
      seen.add(p.item.uid);
      let el = this.tiles.get(p.item.uid);
      const fp = grid.footprintOf(p.item);
      if (!el) {
        el = document.createElement('div');
        el.dataset.uid = p.item.uid;
        this.bindTile(el, p.item.uid);
        this.tiles.set(p.item.uid, el);
        this.tilesEl.appendChild(el);
        // 2026-09-12: no `.is-new` pop — an item that moved grids is simply there (user's decision: it moves at once)
      }
      const badge = this.quickBadges.get(p.item.uid);
      const sig = tileSignature(p.item, fp.w, fp.h, badge, isNeededAmmo(def), isFavoriteDef(def.id), isRecoveryTile(p.item), isShelfWantedDef(def));
      if (this.sigs.get(p.item.uid) !== sig) {
        this.sigs.set(p.item.uid, sig);
        const wasDragging = el.classList.contains('is-dragging');
        const wasHover = el.classList.contains('is-hover');
        buildTileContent(el, p.item, def, fp.w, fp.h, this.getStats(p.item), this.cell);
        if (badge && !isHiddenItem(p.item)) addQuickBadge(el, badge);
        if (this.scan?.uid === p.item.uid) this.applyScan(el, this.scan.progress);
        if (wasDragging) el.classList.add('is-dragging');
        if (wasHover) el.classList.add('is-hover');
      }
      el.classList.toggle('is-pending', this.pendingUids.has(p.item.uid));
      el.classList.toggle('is-filtered-out', !!this.filter && !this.filter(p.item, def));
      el.style.transform = `translate(${p.x * this.step}px, ${p.y * this.step}px)`;
    }
    for (const [uid, el] of this.tiles) {
      if (seen.has(uid)) continue;
      this.tiles.delete(uid);
      this.sigs.delete(uid);
      // the item being searched left the grid (a remote take): drop the gauge state, it would otherwise linger
      // on the container until the next `updateSearch` frame
      if (this.scan?.uid === uid) this.scan = null;
      this.clearScanOn(el);
      if (this.vanishUids.delete(uid)) this.startVanish(el);
      else el.remove();
    }
  }

  /* ── Phase 10: live container take (exit animation) ── */

  /**
   * Mark `uid` so the next `refresh()` that no longer finds it animates the tile out (`.is-vanishing`, removed after
   * `CONTAINER_TAKE_ANIM_S`) instead of deleting it synchronously. Used when another member's take is confirmed.
   */
  vanish(uid: string): void {
    if (this.tiles.has(uid)) this.vanishUids.add(uid);
  }

  private startVanish(el: HTMLElement): void {
    el.classList.remove('is-hover', 'is-dragging', 'is-pending', 'is-scanning', 'is-split-source', 'is-socket-ok', 'is-socket-bad');
    // the animation drives the `translate:` / `scale:` / `opacity` channels — `transform` is the tile's cell position
    el.style.setProperty('--vanish-t', `${CONTAINER_TAKE_ANIM_S}s`);
    el.style.setProperty('--vanish-rise', `${-CONTAINER_TAKE_RISE_PX}px`);
    el.style.setProperty('--vanish-scale', String(CONTAINER_TAKE_END_SCALE));
    el.classList.add('is-vanishing');
    const timer = window.setTimeout(() => { this.vanishing.delete(el); el.remove(); }, Math.round(CONTAINER_TAKE_ANIM_S * 1000) + 60);
    this.vanishing.set(el, timer);
  }

  private clearScanOn(el: HTMLElement): void {
    el.querySelector('.inv-tile-scan')?.remove();
    el.classList.remove('is-scanning');
  }

  private stopVanishing(): void {
    for (const [el, timer] of this.vanishing) { clearTimeout(timer); el.remove(); }
    this.vanishing.clear();
    this.vanishUids.clear();
  }

  private bindTile(el: HTMLElement, uid: string): void {
    el.addEventListener('pointerdown', (e) => this.handlers.onPointerDown(uid, this.id, e));
    el.addEventListener('pointerenter', (e) => { el.classList.add('is-hover'); this.handlers.onEnter(uid, this.id, e); });
    el.addEventListener('pointermove', (e) => this.handlers.onMove(uid, this.id, e));
    el.addEventListener('pointerleave', () => { el.classList.remove('is-hover'); this.handlers.onLeave(uid, this.id); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.handlers.onContext(uid, this.id, e); });
    el.addEventListener('dblclick', (e) => { e.preventDefault(); this.handlers.onDblClick(uid, this.id); });
  }

  /** Quick-slot badges (uid → glyph). Forces a re-render when the set changed. */
  setQuickBadges(badges: ReadonlyMap<string, string>): void {
    let same = badges.size === this.quickBadges.size;
    if (same) for (const [uid, g] of badges) if (this.quickBadges.get(uid) !== g) { same = false; break; }
    if (same) return;
    this.quickBadges = new Map(badges);
    this.refresh(true);
  }

  /* ── Phase 7: container scan gauge / pending takes ── */

  /**
   * Show the scan gauge on `uid` at `progress` (0..1); null clears it. Cheap: only the `--p` custom property changes
   * while the same item is being searched (no re-render), so it can be called every frame.
   */
  setScan(uid: string | null, progress = 0): void {
    const prev = this.scan;
    if (uid === null) {
      if (!prev) return;
      this.scan = null;
      const el = this.tiles.get(prev.uid);
      if (el) { el.querySelector('.inv-tile-scan')?.remove(); el.classList.remove('is-scanning'); }
      return;
    }
    const p = Math.max(0, Math.min(1, progress));
    if (prev && prev.uid !== uid) {
      const old = this.tiles.get(prev.uid);
      if (old) { old.querySelector('.inv-tile-scan')?.remove(); old.classList.remove('is-scanning'); }
    }
    this.scan = { uid, progress: p };
    const el = this.tiles.get(uid);
    if (el) this.applyScan(el, p);
  }

  private applyScan(el: HTMLElement, progress: number): void {
    let scan = el.querySelector<HTMLElement>('.inv-tile-scan');
    if (!scan) {
      scan = document.createElement('div');
      scan.className = 'inv-tile-scan';
      el.appendChild(scan);
    }
    scan.style.setProperty('--p', `${Math.round(progress * 100)}%`);
    el.classList.add('is-scanning');
  }

  /** Tiles whose take is waiting for the host's answer pulse (`is-pending`). */
  setPending(uids: ReadonlySet<string>): void {
    let same = uids.size === this.pendingUids.size;
    if (same) for (const u of uids) if (!this.pendingUids.has(u)) { same = false; break; }
    if (same) return;
    this.pendingUids = new Set(uids);
    for (const [id, el] of this.tiles) el.classList.toggle('is-pending', this.pendingUids.has(id));
  }

  /** Socket-drop feedback on a weapon tile (attachment dragged over it). null clears every tile. */
  setSocketTarget(uid: string | null, state: 'ok' | 'bad' | null): void {
    for (const [id, el] of this.tiles) {
      el.classList.toggle('is-socket-ok', id === uid && state === 'ok');
      el.classList.toggle('is-socket-bad', id === uid && state === 'bad');
    }
  }

  private clearTiles(): void {
    this.stopVanishing();
    for (const el of this.tiles.values()) el.remove();
    this.tiles.clear();
    this.sigs.clear();
    this.scan = null;
  }

  /* ── drag feedback ─────────────────────────────────────────────────────── */

  rect(): DOMRect { return this.el.getBoundingClientRect(); }

  /**
   * True when the pointer lies within `pad` px of this grid's box. `pad = 0` is strict containment — the caller
   * (`InventoryUI.updateDragTarget`) resolves strictly first and only then with a tolerance, so two grids that sit
   * a few px apart (가방 over 함선 창고) can no longer steal each other's edge rows.
   */
  hitTest(pointerX: number, pointerY: number, pad: number): boolean {
    if (!this.grid) return false;
    const r = this.rect();
    if (r.width <= 0 || r.height <= 0) return false;
    // 2026-09-12: the blank rows of a fixed 가방 frame (`frameRows`) are not a target — only the real cells are
    const cellsBottom = Math.min(r.bottom, r.top + this.grid.rows * this.step - GAP);
    let top = r.top - pad, bottom = cellsBottom + pad;
    const clip = this.clipEl;
    if (clip && clip.scrollHeight > clip.clientHeight + 1) {
      // 2026-09-11 (C-60): rows scrolled out of the viewport are not a target, and a clipped edge has no tolerance —
      // otherwise a release over the panel header would land on a row hidden above it
      const c = clip.getBoundingClientRect();
      if (r.top < c.top) top = c.top;
      if (r.bottom > c.bottom) bottom = c.bottom;
    }
    return pointerX >= r.left - pad && pointerX <= r.right + pad && pointerY >= top && pointerY <= bottom;
  }

  /**
   * 2026-09-11 (C-60): the scroll viewport this grid sits in (the container panel's `.inv-cont-scroll`). Cell math keeps
   * reading the grid's own `getBoundingClientRect` (it already includes the scroll offset — nothing is cached); the clip
   * only trims `hitTest` to the visible rows while the viewport actually overflows. null = no clipping (bag · 창고).
   */
  setClip(el: HTMLElement | null): void { this.clipEl = el; }
  private clipEl: HTMLElement | null = null;

  /** Tolerance (px) used for the padded second pass. */
  get hitPad(): number { return this.step * 0.5; }

  /**
   * Cell under a ghost whose top-left is at (left, top) in client space, clamped
   * so a w×h footprint stays inside. Null when the pointer is outside the grid (`pad` px of tolerance).
   */
  cellForGhost(left: number, top: number, w: number, h: number, pointerX: number, pointerY: number, pad = this.step * 0.5): { x: number; y: number } | null {
    const grid = this.grid;
    if (!grid) return null;
    if (!this.hitTest(pointerX, pointerY, pad)) return null;
    const r = this.rect();
    let x = Math.round((left - r.left) / this.step);
    let y = Math.round((top - r.top) / this.step);
    x = Math.max(0, Math.min(grid.cols - w, x));
    y = Math.max(0, Math.min(grid.rows - h, y));
    if (w > grid.cols || h > grid.rows) return null;
    return { x, y };
  }

  showHighlight(x: number, y: number, w: number, h: number, state: HighlightState): void {
    const { width, height } = tileSizeAt(w, h, this.cell);
    this.hlEl.hidden = false;
    this.hlEl.className = `inv-hl is-${state}`;
    this.hlEl.style.width = `${width}px`;
    this.hlEl.style.height = `${height}px`;
    this.hlEl.style.transform = `translate(${x * this.step}px, ${y * this.step}px)`;
  }

  hideHighlight(): void { this.hlEl.hidden = true; }

  setDragging(uid: string | null): void {
    for (const [id, el] of this.tiles) el.classList.toggle('is-dragging', id === uid);
  }

  /**
   * Partial (Shift/Ctrl) drag feedback: the source tile stays lit and its badge shows what would remain.
   * `remaining` null clears the state; the next `refresh(true)` rebuilds the badge anyway.
   */
  markSplitSource(uid: string, remaining: number | null): void {
    const el = this.tiles.get(uid);
    if (!el) return;
    el.classList.toggle('is-split-source', remaining !== null);
    const badge = el.querySelector<HTMLElement>('.inv-tile-qty');
    if (!badge) return;
    if (remaining === null) {
      const item = this.grid?.get(uid)?.item;
      if (item) badge.textContent = String(item.qty);
    } else {
      badge.textContent = String(remaining);
    }
  }

  shake(uid: string): void {
    const el = this.tiles.get(uid);
    if (!el) return;
    el.classList.remove('is-shake');
    void el.offsetWidth; // restart animation
    el.classList.add('is-shake');
    setTimeout(() => el.classList.remove('is-shake'), 360);
  }

  tileEl(uid: string): HTMLElement | undefined { return this.tiles.get(uid); }

  /** 2026-09-12: visit every drawn tile (per-tile flags an embedding view layers on top — `TradeGrids` staging / tips). */
  forEachTile(fn: (uid: string, el: HTMLElement) => void): void {
    for (const [uid, el] of this.tiles) fn(uid, el);
  }

  dispose(): void {
    this.clearTiles();
    this.el.remove();
  }
}
