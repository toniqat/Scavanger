import type * as THREE from 'three';
import type { Random } from './Random';
import type { GameContext } from './GameContext';
import type { ArmorDef, CraftRecipe, CraftStation, DurabilityInfo, WeightInfo } from './gear';
import type { LoadoutPreset, WorkbenchKind } from './housing';
import type { SkillId } from './progression';
/* appended (Phase 11, 2026-09-07): 행성 선택 */
import type { PlanetId } from './planets';

/* ────────────────────────────────────────────────────────────────────────────
 * Game phase / flow
 * ──────────────────────────────────────────────────────────────────────────── */
export type GamePhase =
  | 'menu'        // title screen
  | 'deploying'   // hellpod drop intro
  | 'playing'     // free roam, ambient enemies
  | 'extracting'  // countdown running, waves incoming
  | 'shipLanded'  // ship arrived, player may board
  | 'liftoff'     // player pressed ship switch, doors closing / ascending
  | 'complete'    // mission summary screen
  | 'dead'        // death screen
  /* appended (ship hub) */
  | 'hub'         // walking around the personal / shared ship (no world, no enemies, no weapons)
  | 'docking';    // docking / undocking cutscene between the personal and the shared ship

/** Which ship interior the hub is showing. */
export type HubShipKind = 'personal' | 'shared';

/**
 * Ping categories (owner: ui/hud/Pings). `attack` / `caution` are the drag-gesture pings, `item` = dropped item / crate.
 * 2026-09-09 (레이드 플레이 개선): `help` / `abandon` are the **downed** variant of the same left/right hold gesture —
 * while the local player is DOWNED the 지역 핑 wheel shows 살려줘 / 나를 버려 instead of 여기 조심해 / 저쪽으로 가자.
 * `structure` = 버려진 구조물, `rail` = 선로 · 플랫폼 · 전차 (aim-assist snaps onto them like a crate does).
 */
export type PingKind =
  | 'ground' | 'enemy' | 'crate' | 'extraction' | 'item' | 'attack' | 'caution'
  | 'help' | 'abandon' | 'structure' | 'rail';

/** Chat line categories (owner: ui/hud/ChatLog). */
/** `whisper` appended (Phase 11): a direct message, rendered with a → 아이디 prefix and never relayed to the squad. */
export type ChatKind = 'text' | 'ping' | 'request' | 'system' | 'whisper';

export interface MissionStats {
  seed: number;
  kills: number;
  cratesOpened: number;
  damageTaken: number;
  timeSeconds: number;
  lootValue: number;
  extracted: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Items & inventory
 * ──────────────────────────────────────────────────────────────────────────── */
export type ItemCategory =
  | 'primary'     // main weapon (equippable)
  | 'secondary'   // sidearm (equippable)
  | 'grenade'     // throwable, stackable
  | 'stim'        // healing consumable, stackable
  | 'ammo'        // ammo; `qty` = rounds (v2), stackable
  | 'valuable'    // loot with sell value (mission score)
  | 'material'    // resource, stackable, has value
  /* appended (weapon package) */
  | 'attachment'  // weapon socket attachment (muzzle / grip / mag / stock / sight), see `ItemDef.attachment`
  | 'bag'         // backpack (equippable in the `bag` loadout slot), see `ItemDef.bag`
  /* appended: tactical kit */
  | 'armor'       // body armor (equippable in the `armor` loadout slot, see `ItemDef.armorId` → ArmorDef)
  | 'gadget'      // special gadget consumable (see GadgetDef), usable from the quick wheel
  | 'herb'        // gathered plant, crafting input for medicine
  /* appended: ship housing (2026-09-06) */
  | 'furniture'   // ship furniture as an inventory item (see `ItemDef.furnitureId` → FurnitureDef); placed via housing/
  /* appended: Phase 8 (2026-09-06) */
  | 'seed'        // 씨앗 planted in a 온실 재배층 (see `ItemDef.seed`); loot + corp shop, never craftable
  /* appended: Phase 9 (2026-09-06) */
  | 'book'        // 서적 shelved on a 서재 책장 (see `ItemDef.book`): raises one skill's XP gain; loot + corp shop, never craftable
  /* appended: 2026-09-08 */
  | 'implant';    // 임플란트 (능력치 장착 아이템, see `ItemDef.implant`): equipped on the 캐릭터 tab, 세레스 바이오 sells / repairs, broken ones are raid loot

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

/**
 * Ammo calibres. v2 (weapon package): `light` 경량탄 (SMG, HG) · `medium` 준중량탄 (AR) · `heavy` 중량탄 (SR, DMR) ·
 * `shell` 산탄 (SG). The legacy values stay in the union for compatibility but no def uses them any more.
 * Ammo items carry rounds in `ItemInstance.qty` (stackMax = rounds per stack); a weapon's "reserve" is the
 * total rounds of its calibre in the bag.
 */
export type AmmoType = 'rifle' | 'pistol' | 'shotgun' | 'energy' | 'light' | 'medium' | 'heavy' | 'shell'
  /* appended (unique weapons, 2026-09-06): dedicated calibres — 연료통 / 전지 / 표창 / 화살 / 로켓 / 탄띠 */
  | 'fuel' | 'cell' | 'shuriken' | 'arrow' | 'rocket' | 'belt';

/* ── appended (unique weapons, 2026-09-06) ── */
/**
 * Legendary-only unique weapons (`WeaponDef.unique`). No grades, no sockets (`LootRef.canAttach` → false), high
 * base numbers, RMB = alternative fire instead of ADS (`WeaponDef.altFire`). Behaviour lives in weapons/, data in items/.
 */
export type UniqueWeaponKind = 'flamethrower' | 'shockgun' | 'shuriken' | 'bow' | 'bazooka' | 'minigun';

/** Weapon archetype. Drives damage falloff, recoil/spread profile, ADS zoom and HUD labels. */
export type WeaponClass = 'AR' | 'SMG' | 'SR' | 'DMR' | 'SG' | 'PISTOL';

/* ── appended (weapon package, 2026-09-05) ── */
/** Weapon grade: I 일반 · II 고급 · III 희귀 · IV 서사 · V 전설 (maps 1:1 to `Rarity`). Higher = more damage + durability. */
export type WeaponGrade = 1 | 2 | 3 | 4 | 5;
/** Weapon socket slots. Every weapon has all five (for now). */
export type SocketSlot = 'muzzle' | 'grip' | 'mag' | 'stock' | 'sight';
/** Equipment slots. `primary` = 주무기 I (key 1), `primary2` = 주무기 II (key 2), `secondary` = 보조무기 (key 3), `bag` = 가방. */
export type LoadoutSlot = 'primary' | 'primary2' | 'secondary' | 'bag' | 'armor';
export type WeaponSlot = Exclude<LoadoutSlot, 'bag' | 'armor'>;

/** Attachment stat effects. Multipliers default to 1 (0.8 = −20 %); overrides default to "unchanged". Owner: items. */
export interface AttachmentEffects {
  /** Vertical / horizontal recoil multipliers. */
  recoilV?: number;
  recoilH?: number;
  /** Spread multiplier applied to both hip and ADS spread (compensator / choke / stock). */
  spread?: number;
  /** Hip-fire-only spread multiplier (laser sight). */
  hipSpread?: number;
  /** ADS (aim-in) time multiplier (stock). */
  adsTime?: number;
  /** Magazine size multiplier (extended mags). */
  magSize?: number;
  /** Sight: replaces the weapon's ADS FOV divisor / scope overlay flag. */
  adsZoom?: number;
  scope?: boolean;
  /** Laser sight: HUD may show a laser dot; also implies `hipSpread`. */
  laser?: boolean;
}

/** Attachment item data (`ItemDef.attachment`). `classes` / `ammoTypes` undefined = fits every weapon. */
export interface AttachmentDef {
  socket: SocketSlot;
  classes?: readonly WeaponClass[];
  /** Extended magazines fit only weapons of these calibres. */
  ammoTypes?: readonly AmmoType[];
  effects: AttachmentEffects;
}

/** Backpack data (`ItemDef.bag`). Legendary = INVENTORY_COLS × INVENTORY_ROWS; no bag = BAG_DEFAULT_COLS × BAG_DEFAULT_ROWS. */
export interface BagDef {
  cols: number;
  rows: number;
  /** Quick-use wheel slots this bag unlocks (Phase 2 consumable wheel). */
  quickSlots: number;
  /** Tactical variant: slightly smaller grid, more quick slots. */
  tactical?: boolean;
}

/**
 * Final per-instance weapon numbers after grade + sockets (owner: items `computeWeaponStats`, exposed through
 * `LootRef.getEffectiveStats`). Weapons fires with these, never with the raw `WeaponDef`.
 */
export interface EffectiveWeaponStats {
  weaponId: string;
  weaponClass: WeaponClass;
  ammoType: AmmoType;
  grade: WeaponGrade;
  damage: number;
  magSize: number;
  /** radians */
  spread: number;
  adsSpread: number;
  /** Camera kick (radians): vertical base and horizontal base (before the per-shot random). */
  recoilV: number;
  recoilH: number;
  /** Seconds to fully aim in. */
  adsTime: number;
  /** Seconds for the draw/holster swap into this weapon. */
  swapTime: number;
  adsZoom: number;
  scope: boolean;
  laser: boolean;
  maxDurability: number;
  reloadTime: number;
  fireRate: number;
}

export interface WeaponDef {
  id: string;
  name: string;
  slot: 'primary' | 'secondary';
  ammoType: AmmoType;
  damage: number;
  fireRate: number;        // rounds per second
  magSize: number;
  reserveMags: number;     // mags carried at start / after ammo pack
  reloadTime: number;      // seconds
  spread: number;          // radians at hip
  adsSpread: number;       // radians when aiming
  range: number;           // meters
  automatic: boolean;
  pellets?: number;        // shotgun
  projectileSpeed?: number;// if undefined → hitscan
  recoil: number;          // camera kick, radians
  tracerColor: number;     // hex
  /* ── appended: weapon classes (owner: items/weapons) ── */
  /** Archetype; undefined → treated as 'AR' (secondary slot → 'PISTOL'). */
  weaponClass?: WeaponClass;
  /** Distance (m) where damage starts falling off. undefined → no falloff. */
  falloffStart?: number;
  /** Distance (m) where damage reaches `falloffMin`. */
  falloffEnd?: number;
  /** Damage multiplier at/after `falloffEnd` (0..1). */
  falloffMin?: number;
  /** ADS FOV divisor (1 = none, 4 = SR scope). undefined → default ADS zoom. */
  adsZoom?: number;
  /** true → HUD shows a scope overlay while aiming with this weapon. */
  scope?: boolean;
  /* ── appended: weapon package (owner: items) ── */
  /** Grade I..V; undefined → 1. Damage / maxDurability in the def are already the graded values. */
  grade?: WeaponGrade;
  /** Shots before the weapon stops firing (repaired at the ship workbench). undefined → WEAPON_DEFAULT_DURABILITY. */
  maxDurability?: number;
  /** Base weapon this grade belongs to (`ar` for `ar_g3`); undefined → the def is its own family. */
  family?: string;
  /* appended: tactical kit */
  /** Melee damage multiplier granted by this weapon's stock (undefined = MELEE_STOCK_MUL_DEFAULT). */
  meleeMul?: number;
  /* ── appended: unique weapons (2026-09-06, owner: items data / weapons behaviour) ── */
  /** Set on the six legendary uniques. Weapons switches its fire logic on this; items never grades / sockets them. */
  unique?: UniqueWeaponKind;
  /** true → RMB is the alternative fire (no ADS, `adsZoom` ignored); the HUD shows both modes. */
  altFire?: boolean;
  /** Alt-fire damage per hit / per second where the primary `damage` does not apply (flame jet, charged bolt, air-burst rocket). */
  altDamage?: number;
  /** Seconds to charge (shockgun RMB) or spin up (minigun LMB). */
  chargeTime?: number;
  /** Continuous weapons (flame / shock arc): ammo units consumed per second instead of per shot. */
  ammoPerSec?: number;
}

export interface ItemDef {
  id: string;
  name: string;
  description: string;
  category: ItemCategory;
  rarity: Rarity;
  width: number;           // grid cells (before rotation)
  height: number;
  stackMax: number;        // 1 for non-stackable
  value: number;           // score value per unit
  /** CSS color used as icon tint; icon is a short glyph/emoji */
  color: string;
  icon: string;
  /** links to a WeaponDef for primary/secondary */
  weaponId?: string;
  /** ammo packs: which weapon ammo type they refill */
  ammoType?: AmmoType;
  /** stim: hp restored */
  healAmount?: number;
  /* ── appended: weapon package ── */
  /** category 'attachment' */
  attachment?: AttachmentDef;
  /** category 'bag' */
  bag?: BagDef;
  /* ── appended: tactical kit (owner: items) ── */
  /** kg per unit. undefined = 0.1 kg. Counts toward the weight budget. */
  weight?: number;
  /** category 'armor': links to an ArmorDef. */
  armorId?: string;
  /** category 'gadget': links to a GadgetDef (owned by gadgets/). */
  gadgetId?: string;
  /** Fresh durability for non-weapon gear that wears out (armor). Weapons use `WeaponDef.maxDurability`. */
  durabilityMax?: number;
  /** Informational: the item may sit in a quick slot even outside QUICK_USABLE_CATEGORIES. */
  quickUsable?: boolean;
  /* ── appended: ship housing (2026-09-06, owner: items) ── */
  /** category 'furniture': links to a FurnitureDef (owned by housing/). Placing it moves it into the furniture storage. */
  furnitureId?: string;
  /* ── appended: Phase 8 (2026-09-06, owner: items) ── */
  /** category 'seed': what it grows into in a 온실 재배층 and how long that takes in **real** hours. */
  seed?: SeedDef;
  /* ── appended: Phase 9 (2026-09-06, owner: items) ── */
  /** category 'book': which skill the book teaches when shelved in a 서재 책장 (`BOOK_RARITY_MUL[rarity]` weight). */
  book?: BookDef;
  /* ── appended: 회복 아이템 개편 (2026-09-07, owner: items) ── */
  /** category 'stim': how long it takes to use, how much it heals, and (스프레이) how it channels. */
  heal?: HealDef;
}

/**
 * 회복 소모품 (2026-09-07). `weapons` holds LMB for `useTime` (moving at `CONSUMABLE_SLOW_MUL` speed), then
 * consumes one unit and hands `amount` / `overTime` to `PlayerRef.applyHeal`. A def with `spray` is channelled
 * instead: LMB drains the item's own gauge (`ItemDef.durabilityMax` on the instance) tick by tick.
 */
export interface HealDef {
  /** Seconds LMB must be held before the item is consumed (0 = instant; ignored for a `spray`). */
  useTime: number;
  /** Total hp restored (0 for a 스프레이 — it heals per tick instead). */
  amount: number;
  /** Seconds the hp is spread over once the use completes (0 = instant). */
  overTime: number;
  /** 회복 스프레이: channelled from the instance's gauge while LMB is held. */
  spray?: SprayDef;
}

/** Channelled healing (회복 스프레이). The gauge is the instance `durability` out of `ItemDef.durabilityMax`. */
export interface SprayDef {
  /** Seconds per tick. */
  tick: number;
  /** Gauge units drained per tick. */
  gaugePerTick: number;
  /** hp restored per tick, to the user and to every squadmate inside `radius`. */
  healPerTick: number;
  /** Effect radius in metres. */
  radius: number;
}

/** 서적 data (Phase 9). One book per skill; rarity decides its weight in `HousingRef.getBookBonus`. */
export interface BookDef {
  skill: SkillId;
}

/** 씨앗 growth data. `growHours` is wall-clock time and keeps running while the game is closed. */
export interface SeedDef {
  /** Real hours from planting to harvest, before the 원예 speed-up (`GROW_SKILL_SPEEDUP`). */
  growHours: number;
  /** Item def harvested from a ripe plot. */
  yieldDefId: string;
  /** Units per plot, before `derived.gatherYieldMul`. */
  yieldQty: number;
}

export interface ItemInstance {
  uid: string;
  defId: string;
  qty: number;
  rotated: boolean;        // true → occupies height x width instead of width x height
  /* ── appended: weapon package (persist with the item: drops, pickups, stash) ── */
  /** Weapons: shots left before it breaks (0 = broken). Set to max by `LootRef.createItem`. */
  durability?: number;
  /** Weapons: rounds loaded in the magazine (owner: weapons writes, inventory reads for 탄약 탈착). */
  ammoInMag?: number;
  /** Weapons: attached socket items (owner: inventory). */
  sockets?: Partial<Record<SocketSlot, ItemInstance>>;
}

/** Per-instance fields that travel with an item over the wire / into storage. */
export type ItemInstanceExtras = Pick<ItemInstance, 'durability' | 'ammoInMag' | 'sockets'>;

export interface Loadout {
  primary: ItemInstance | null;
  secondary: ItemInstance | null;
  /* appended (weapon package) */
  /** 주무기 II (key 2). */
  primary2: ItemInstance | null;
  /** Equipped backpack; null → BAG_DEFAULT grid. */
  bag: ItemInstance | null;
  /* appended (tactical kit): optional so existing emitters keep compiling. */
  armor?: ItemInstance | null;
}

export interface InventoryRef {
  /** true while any inventory / loot window is open (gameplay input must be blocked) */
  readonly isOpen: boolean;
  getLoadout(): Loadout;
  countWhere(pred: (def: ItemDef, inst: ItemInstance) => boolean): number;
  /** Removes up to qty units matching pred; returns how many were actually consumed. */
  consumeWhere(pred: (def: ItemDef, inst: ItemInstance) => boolean, qty: number): number;
  /** Adds an item to the grid (merges into stacks first). Returns false if it does not fit. */
  tryAddItem(item: ItemInstance): boolean;
  /** Total value of everything in the bag. */
  getTotalValue(): number;
  getAllItems(): ItemInstance[];
  getDef(defId: string): ItemDef | undefined;
  /** Open the loot window for a container; contents are rolled once and cached per containerId. */
  openContainer(containerId: string, tier: number, position: THREE.Vector3): void;
  /** Open just the player's bag (Tab). */
  toggleBag(): void;
  closeAll(): void;
  reset(): void;
  /* ── appended: drop / split (owner: inventory) ── */
  /**
   * Remove `qty` units (default: whole stack) of item `uid` from the bag (or the open container) and emit
   * `inventory:itemDropped` so pickups/PickupSystem spawns a world pickup in front of the player. False if not found.
   */
  dropItem(uid: string, qty?: number): boolean;
  /** Split `qty` units off stack `uid` into a new stack placed in the same grid (auto-placed). False if it does not fit / invalid qty. */
  splitItem(uid: string, qty: number): boolean;
  /* ── appended: weapon package (owner: inventory) ── */
  /** Bag grid in effect (equipped bag def, else BAG_DEFAULT_*). */
  getBagSize(): { cols: number; rows: number; quickSlots: number };
  /** Any player-owned item by uid: bag, loadout slots, or an attachment inside a weapon's sockets. */
  findItem(uid: string): ItemInstance | null;
  /** Patch persistent instance fields; emits `inventory:itemUpdated` (+ `inventory:changed`). False when not found. */
  updateItem(uid: string, patch: Partial<Pick<ItemInstance, 'durability' | 'ammoInMag'>>): boolean;
  /**
   * Put bag item `attachmentUid` into the matching socket of weapon `weaponUid` (bag or loadout). A previous attachment
   * returns to the bag (or drops to the ground when it does not fit). False when incompatible (class / ammo / not an attachment).
   */
  attachToWeapon(weaponUid: string, attachmentUid: string): boolean;
  /** Remove every attachment from weapon `uid` back into the bag (overflow drops). */
  detachAllSockets(uid: string): boolean;
  /** Move the loaded rounds (`ammoInMag`) of weapon `uid` back into the bag as ammo (overflow drops); sets `ammoInMag = 0`. */
  unloadWeapon(uid: string): boolean;
  /** Ship workbench: consume `LootRef.getRepairCost` materials and restore full durability. False when materials are missing. */
  repairWeapon(uid: string): boolean;
  /** Equip `uid` (bag item) into `slot` or unequip the slot with null → emits `loadout:changed`. Used by the hub / UI. */
  equip(uid: string | null, slot: LoadoutSlot): boolean;
  /* ── appended: quick-use slots (Phase 2, owner: inventory) ── */
  /**
   * The 8 wheel slots (index = wheel direction, see QUICK_SLOT_DIRS: 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW).
   * **2026-09-09 — the wheel is its own container** (사용자 결정): an entry is the stack *itself*, which is therefore
   * **not** in the bag grid any more (it still counts toward the bag weight and every `countWhere` / `consumeWhere`
   * query). A slot empties when its stack is consumed / moved back. Before that date the entries referenced bag items
   * and the stacks stayed in the grid.
   * Only the first `getQuickSlotCount()` slots are usable (bag def `quickSlots`).
   */
  getQuickSlots(): readonly (ItemInstance | null)[];
  /**
   * **Move** bag stack `uid` (category in QUICK_USABLE_CATEGORIES) into wheel slot `index`, or empty the slot with
   * null — the stack leaves / re-enters the bag grid. False when the move is refused (locked slot, wrong category,
   * or the bag has no room for the displaced stack). Emits `inventory:quickSlotsChanged`.
   */
  setQuickSlot(index: number, uid: string | null): boolean;
  /** Usable wheel slots for the equipped bag (BAG_DEFAULT_QUICK_SLOTS without a bag). */
  getQuickSlotCount(): number;
  /** Consume `qty` units of the exact item `uid` (bag). Returns how many were removed. Clears the quick slot at 0. */
  consumeItem(uid: string, qty?: number): number;
  /* ── appended: Phase 4 — corpse looting (owner: inventory) ── */
  /**
   * Open the loot window for a container whose contents are supplied by the caller (corpses: `ctx.loot.rollCorpse`).
   * Contents are cached per `containerId` like crates (a second open shows what is left); `crate:looted {crateId}` fires when emptied.
   */
  openContainerItems(containerId: string, items: ItemInstance[], position: THREE.Vector3, title?: string): void;

  /* ── appended: tactical kit (owner: inventory) ── */
  /** Item equipped in a loadout slot, or null. */
  getEquipped(slot: LoadoutSlot): ItemInstance | null;
  /** Live weight budget (bag + equipped gear). Recomputed on every change; emits `inventory:weightChanged`. */
  getWeight(): WeightInfo;
  /** Remove exactly `qty` of `defId` from the bag; false when there is not enough. */
  consumeDef(defId: string, qty: number): boolean;
  /** Field crafting: recipes available at `station` given the current skills. */
  getRecipes(station: CraftStation): readonly CraftRecipe[];
  /** true when every input of `recipeId` is in the bag. `count` (2026-09-09, default 1) = how many runs at once. */
  canCraft(recipeId: string, count?: number): boolean;
  /** Start a craft (hold time applies); resolves to the produced item or null. */
  /** `targetUid` appended (2026-09-08): the exact stack a 분해 consumes first (아이템 우클릭 → 분해). */
  /** `count` appended (2026-09-09): 제작 수량 — the recipe runs `count` times in one hold (inputs × count, output × count). */
  craft(recipeId: string, targetUid?: string, count?: number): Promise<ItemInstance | null>;
  /** Apply wear to a gear item (armor per hit). Emits `durability:changed` / `durability:broken`. Weapons keep `updateItem`. */
  damageDurability(uid: string, amount: number): void;
  /** Durability of a gear item (weapon / armor), or null when it is not tracked. */
  getDurability(uid: string): DurabilityInfo | null;
  /** Ship workbench: repair any gear item (weapon → `repairWeapon`, armor → full durability). */
  repair(uid: string): boolean;

  /* ── appended: dev console · ship housing (2026-09-06, owner: inventory) ── */
  /**
   * 무한 상자 (`/items` cheat): a loot-style window listing **every** item def with infinite stock — dragging a tile
   * into the bag / stash / a slot creates a fresh instance (`ctx.loot.createItem`) and the tile stays. Blocker `'inventory'`,
   * emits `ui:catalogToggled`. Works in the hub and on a mission.
   */
  openCatalog(opts?: { category?: ItemCategory }): void;   // `category` (appended, Phase 9): preselect the tab holding it (훈련장 무기 거치대)
  closeCatalog(): void;
  readonly isCatalogOpen: boolean;
  /** Ship stash grid in effect (STASH_COLS × rows from the storage facility). */
  getStashSize(): { cols: number; rows: number };
  /**
   * Resize the stash (housing storage level). Growing keeps every item in place; shrinking is refused (false) when an
   * item would fall outside. Persists with the stash. Called on `housing:stashSizeChanged` and at startup.
   */
  setStashSize(cols: number, rows: number): boolean;
  /** Units of `defId` in the bag **and** the stash (materials for facility upgrades / furniture). */
  countDefAll(defId: string): number;
  /** Consume `qty` of `defId` from the bag first, then the stash. All-or-nothing; false when short. */
  consumeDefAll(defId: string, qty: number): boolean;
  /** Current equipment as a preset (def ids; implant from `ctx.progression`). */
  captureLoadout(): LoadoutPreset;
  /**
   * Equip a preset from what the bag + stash hold (first instance whose def id matches; stash items are moved into the
   * slot, displaced gear goes to the bag, else the stash). Missing defs leave the slot **empty** (unequipped) and are
   * returned in `missing`. Ship only (false / empty result during a raid).
   */
  applyLoadout(preset: LoadoutPreset): { equipped: number; missing: string[] };
  /**
   * Ship crafting at a 작업실 bench: opens the craft panel filtered to `getRecipes('ship', bench, level)` plus a repair
   * list (`repair(uid)`) for the gear that bench services (gun: weapons + attachments; gear: armor + bags; gadget /
   * medical: no repairs). Blocker `'inventory'`. Called by the hub when the player uses a placed bench.
   */
  openBenchCraft(bench: WorkbenchKind, level: number): void;
  /**
   * Recipes for a station; with `bench` given, only recipes whose `CraftRecipe.bench` is undefined or equals `bench`
   * with `benchLevel ≤ level`. Field station ignores the bench arguments.
   */
  getRecipes(station: CraftStation, bench?: WorkbenchKind, level?: number): readonly CraftRecipe[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * World pickups (owner: pickups/PickupSystem publishes `ctx.pickups`)
 * Dropped items lying on the ground; interactable (E) to take. Multiplayer: host-authoritative (`item` / `itemq`).
 * ──────────────────────────────────────────────────────────────────────────── */
export interface PickupRef {
  readonly id: string;
  readonly item: ItemInstance;
  /** World position (resting on the ground). Stable Vector3 instance. */
  readonly position: THREE.Vector3;
  readonly object: THREE.Object3D;
}

export interface PickupsRef {
  getPickups(): readonly PickupRef[];
  /** Nearest pickup within `radius` of `pos` (pings snap to it), or null. */
  findNear(pos: THREE.Vector3, radius: number): PickupRef | null;
  /** Spawn a pickup (local authority or host). Returns the new id. Clients should drop items via `ctx.inventory.dropItem` instead. */
  spawn(item: ItemInstance, position: THREE.Vector3, velocity?: THREE.Vector3): string;
  clear(): void;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Interiors (owner: hub/HubSystem builds them; player/PlayerSystem consumes via `PlayerRef.setInterior`)
 * Replaces the terrain while the player walks inside a ship: flat decks, wall / prop colliders, camera rays.
 * ──────────────────────────────────────────────────────────────────────────── */
export interface InteriorCollider {
  /** Deck height at (x, z). Return the base deck height when outside every room. */
  getFloorAt(x: number, z: number): number;
  /** Push a circle collider (feet position, radius) out of walls / props / room bounds. Mutates and returns `position`. */
  resolveCollision(position: THREE.Vector3, radius: number): THREE.Vector3;
  /** Ray vs walls / props / decks / ceilings (camera collision, interaction). */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): TerrainHit | null;
  /** Loose world AABB of the whole interior (camera clamp fallback). */
  readonly bounds: { center: THREE.Vector3; halfExtents: THREE.Vector3 };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Ship hub (owner: hub/HubSystem publishes `ctx.hub`)
 * ──────────────────────────────────────────────────────────────────────────── */
export interface HubLaunchSlot {
  /** Lobby slot index (0..NET_MAX_PLAYERS-1); the personal ship has a single slot 0. */
  slot: number;
  /** World position of the pod floor (where a boarded player stands). */
  position: THREE.Vector3;
  yaw: number;
  /** Peer currently boarded (null = empty). Local player → `ctx.net.localId` or 'local' offline. */
  occupant: string | null;
}

export interface HubRef {
  /** Ship currently built, or null while no hub is active (mission / menu). */
  readonly ship: HubShipKind | null;
  /** true during phases 'hub' and 'docking'. */
  readonly active: boolean;
  readonly collider: InteriorCollider | null;
  getLaunchSlots(): readonly HubLaunchSlot[];
  /** Mission seed the host / solo player picked at the terminal (random when null). */
  readonly missionSeed: number | null;
  /* ── appended: dev console (2026-09-06) ── */
  /**
   * Set the next mission seed (null = random). Only the console `/seed` command calls this — the terminal no longer has
   * a seed field. In a lobby the host also pushes it with `ctx.net.setLobbySeed`; a non-host is refused (false).
   */
  setMissionSeed(seed: number | null): boolean;
  /**
   * Personal-ship room the player is standing in (0..SHIP_ROOM_COUNT−1), or null in the corridor / cockpit / shared ship.
   */
  readonly currentRoom: number | null;
}

export interface LootRef {
  /** Roll container contents for a tier (1 = common crate … 4 = rare cache). */
  rollCrate(tier: number, rng?: Random): ItemInstance[];
  getItemDef(defId: string): ItemDef | undefined;
  getWeaponDef(weaponId: string): WeaponDef | undefined;
  getAllItemDefs(): ItemDef[];
  /** Weapons are created fully loaded (`ammoInMag = magSize`) at full `durability`. `extras` override those. */
  createItem(defId: string, qty?: number, extras?: ItemInstanceExtras): ItemInstance;
  /* ── appended: weapon package (owner: items) ── */
  /** Graded + socketed stats for a weapon instance (null when `inst` is not a weapon). Pass a def id string for the bare def. */
  getEffectiveStats(inst: ItemInstance | string): EffectiveWeaponStats | null;
  /** Materials needed to fully repair `inst` at the workbench ([] when nothing to repair / not a weapon). */
  getRepairCost(inst: ItemInstance): { defId: string; qty: number }[];
  /** Can `attachment` go into `weapon`? (socket exists, class / ammo compatible). */
  canAttach(weapon: ItemInstance, attachment: ItemInstance): boolean;
  /* ── appended: Phase 4 (owner: items) ── */
  /**
   * Corpse loot for a dead enemy: bugs → bio samples / glands; rogues → rounds of their weapon's calibre + that weapon at very low
   * durability (`rogueWeaponId` = the WeaponDef id the rogue carried); bosses → a graded weapon + an attachment. Deterministic per `rng`.
   */
  rollCorpse(type: EnemyType, rng?: Random, rogueWeaponId?: string): ItemInstance[];
  /* ── appended: tactical kit (owner: items) ── */
  getArmorDef(armorId: string): ArmorDef | undefined;
  /** Every craft recipe in the game; inventory filters by station and skill. */
  getAllRecipes(): readonly CraftRecipe[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * World
 * ──────────────────────────────────────────────────────────────────────────── */
export interface Obstacle {
  position: THREE.Vector3;   // center (y = base height)
  radius: number;            // cylinder collider radius
  height: number;            // for projectiles / visuals
  /* appended (Phase 3): dynamic obstacles (dropped cover structures) can take damage. Weapons call `onDamage` on a hit. */
  destructible?: DestructibleRef;
  /**
   * appended (2026-09-08): the cylinder `WorldRef.raycast` shoots at, when it differs from the movement cylinder
   * above. `radius` / `height` are tuned so a body never bumps an invisible wall, which for a lumpy prop means they
   * sit **inside** its silhouette — bullets and line-of-sight then pass through rock that is plainly in the way.
   * These two match the prop's drawn extent instead, so 엄폐 works where it looks like it should. Undefined = use
   * `radius` / `height` (every consumer other than the ray keeps reading those two, unchanged).
   */
  shotRadius?: number;
  shotHeight?: number;
}

/** Damageable world object (Phase 3 cover structures). Owner: whoever added the obstacle (stratagems). */
export interface DestructibleRef {
  readonly id: string;
  readonly hp: number;
  readonly maxHp: number;
  onDamage(amount: number, point?: THREE.Vector3): void;
}

export interface ExtractionPointDef {
  id: string;
  position: THREE.Vector3;   // center of the landing pad (flat terrain, radius ≥ 14 m)
  yaw: number;               // facing of the switch console
}

export interface CrateDef {
  id: string;
  position: THREE.Vector3;
  yaw: number;
  tier: number;              // 1..4
  opened: boolean;
}

export interface TerrainHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  obstacle?: Obstacle;
}

export interface WorldRef {
  readonly seed: number;
  readonly size: number;                          // == MAP_SIZE
  readonly ready: boolean;
  getHeightAt(x: number, z: number): number;      // terrain surface Y (fast, analytic/bilinear)
  getNormalAt(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  isInsideBounds(x: number, z: number): boolean;
  /** Push a circle collider out of obstacles & map bounds. Mutates and returns `position`. */
  resolveCollision(position: THREE.Vector3, radius: number): THREE.Vector3;
  /** Ray vs terrain heightfield + obstacle cylinders. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): TerrainHit | null;
  getObstacles(): readonly Obstacle[];
  getObstaclesNear(x: number, z: number, radius: number): Obstacle[];
  getPlayerSpawn(): THREE.Vector3;
  getExtractionPoints(): readonly ExtractionPointDef[];
  getCrates(): readonly CrateDef[];
  /** Random enemy spawn positions on walkable terrain within [minDist, maxDist] of `around`. */
  getEnemySpawnPoints(around: THREE.Vector3, count: number, minDist: number, maxDist: number): THREE.Vector3[];
  /** Bug nests / hives placed by the world; enemies may spawn from them. */
  getNestPositions(): readonly THREE.Vector3[];
  /* ── appended (Phase 3): dynamic obstacles (owner: world) ── */
  /** Register a runtime obstacle (collision, raycast, enemy avoidance). Returns the remover. Cleared with the world. */
  addObstacle(obstacle: Obstacle): () => void;
  /* ── appended: tactical kit (owner: world) ── */
  /**
   * Harvestable nodes scattered over the map — 약초 plants and (2026-09-08) 고철 더미, told apart by
   * `GatherNodeDef.kind`. Consumed nodes stay in the list with `harvested: true`.
   */
  getGatherNodes(): readonly GatherNodeDef[];
}

/** A harvestable plant. Owner: world/WorldSystem (spawn + Interactable); items/ owns the herb it yields. */
export interface GatherNodeDef {
  id: string;
  position: THREE.Vector3;
  /** Item def id produced (an 'herb' category item, or `mat_scrap` for a `kind: 'salvage'` node). */
  defId: string;
  /** Units produced before the gardening multiplier. */
  qty: number;
  harvested: boolean;
  /* appended (2026-09-08): 폐금속 공급 — 고철 노드 */
  /**
   * What the node is. undefined / 'herb' = the 약초 plant (원예 XP, 채집 prompt); 'salvage' = a 고철 더미 at a
   * wreck, yielding `mat_scrap` with a 해체 prompt and 제작 XP. Both share the placement / net / interact code.
   */
  kind?: GatherNodeKind;
}

/** `GatherNodeDef.kind` (2026-09-08). */
export type GatherNodeKind = 'herb' | 'salvage';

/* ────────────────────────────────────────────────────────────────────────────
 * Weapons ref (Phase 3, owner: weapons/WeaponSystem publishes `ctx.weapons`)
 * ──────────────────────────────────────────────────────────────────────────── */
export interface GrenadeView {
  /** Stable Vector3 instance while the grenade is live. */
  readonly position: THREE.Vector3;
  /** Seconds until it explodes. */
  readonly fuse: number;
  /** true for a remote player's replica. */
  readonly remote: boolean;
}
export interface WeaponsRef {
  /** Live grenades (local + replicas) for off-screen indicators. */
  getGrenades(): readonly GrenadeView[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Ship calls / stratagems (Phase 3, owner: stratagems/StratagemSystem publishes `ctx.stratagems`)
 * G hold → wheel → arm a call → target (top view for orbital calls, ground marker for drops) → effect after a delay.
 * All calls share one cooldown.
 * ──────────────────────────────────────────────────────────────────────────── */
/** 2026-09-09: `rescue_drop` 추가. `airstrike` 는 `STRATAGEM_ORDER` 에서 빠졌지만 타입·정의는 남는다. */
export type StratagemId = 'orbital_laser' | 'airstrike' | 'supply_drop' | 'structure_drop' | 'rescue_drop';
export type StratagemStage = 'incoming' | 'active' | 'done';
export interface StratagemCall {
  /** `${peerId|'sp'}-${n}` */
  readonly id: string;
  readonly kind: StratagemId;
  /** Target point on the ground (stable Vector3). */
  readonly position: THREE.Vector3;
  /** ctx.time when the effect starts (beam ignites / bomb hits / crate or structures land). */
  readonly landsAt: number;
  readonly stage: StratagemStage;
  readonly caller: string | null;
}
export interface StratagemsRef {
  /** Call currently in hand (G wheel selection), or null → guns behave normally. */
  readonly armed: StratagemId | null;
  /** true while the top-view / ground targeting is running (camera overridden, weapons must not fire). */
  readonly targeting: boolean;
  /** Shared cooldown seconds left (0 = ready) and the total of the call that started it. */
  readonly cooldown: number;
  readonly cooldownTotal: number;
  getCalls(): readonly StratagemCall[];
  /** Number of cover structures currently standing (debug / HUD). */
  readonly structureCount: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Player
 * ──────────────────────────────────────────────────────────────────────────── */
/** Body stance. Affects speed, eye height, recoil and spread. */
export type Stance = 'stand' | 'crouch' | 'prone';

export interface PlayerRef {
  readonly position: THREE.Vector3;   // feet position
  readonly velocity: THREE.Vector3;
  readonly yaw: number;               // camera/body yaw (radians)
  readonly hp: number;
  readonly maxHp: number;
  readonly isDead: boolean;
  readonly isSprinting: boolean;
  readonly isAiming: boolean;
  readonly object: THREE.Object3D;    // root of the player model
  /* ── appended: stance / stamina / dive (owner: player) ── */
  readonly stance: Stance;
  /** true during the dive animation (Alt). Ends in 'prone'. */
  readonly isDiving: boolean;
  readonly stamina: number;
  readonly maxStamina: number;
  getEyePosition(out?: THREE.Vector3): THREE.Vector3;
  getForward(out?: THREE.Vector3): THREE.Vector3;   // horizontal forward
  takeDamage(amount: number, from?: THREE.Vector3): void;
  heal(amount: number): void;
  /** Teleport & reset (used at mission start). */
  respawnAt(position: THREE.Vector3, yaw?: number): void;
  /** Player physically inside the extraction ship; movement constrained to this box (world space). */
  setShipInterior(bounds: { center: THREE.Vector3; halfExtents: THREE.Vector3 } | null): void;
  /** Lock movement/shooting (cutscenes, liftoff). Camera still follows. */
  setControlsEnabled(enabled: boolean): void;
  /** Re-parent the player root to `parent` (e.g. the ship) so it rides along; null → back to scene. World position is preserved. */
  attachTo(parent: THREE.Object3D | null): void;
  /* ── appended: multiplayer snapshot inputs (owner: player) — read by net/NetSystem every snapshot ── */
  /** Camera pitch (radians, + = up). */
  readonly pitch: number;
  readonly isGrounded: boolean;
  readonly isReloading: boolean;
  readonly isFiring: boolean;
  /** true while inside the hellpod (drop-in not finished); avatar hidden for remotes. */
  readonly isDropping: boolean;
  /** true while inside the extraction ship interior. */
  readonly isInShip: boolean;
  /** Stride phase (radians) and move blend (0..1.2) driving the walk cycle. */
  readonly stridePhase: number;
  readonly moveBlend: number;
  /* ── appended: ship hub / interiors / cutscene camera (owner: player) ── */
  /**
   * Walk inside a ship interior instead of on the terrain: ground = `collider.getFloorAt`, push-out =
   * `collider.resolveCollision`, camera collides with `collider.raycast`. null → back to `ctx.world`.
   * Takes precedence over `setShipInterior` while set. Cleared by `respawnAt`.
   */
  setInterior(collider: InteriorCollider | null): void;
  readonly interior: InteriorCollider | null;
  /** Cutscene camera (docking, launch): blends to `pos` looking at `lookAt`; null releases back to the rig. */
  setCameraOverride(pos: THREE.Vector3 | null, lookAt?: THREE.Vector3, snap?: boolean): void;
  /**
   * Place the player standing (no hellpod) at `position` facing `yaw`, alive, full hp, controls enabled.
   * Used by the hub when entering a ship. Emits `player:spawned`.
   */
  spawnStanding(position: THREE.Vector3, yaw: number): void;
  /** true while the local player is boarded in a launch pod (hub) — movement locked, avatar hidden for remotes. */
  readonly isInPod: boolean;
  setInPod(inPod: boolean): void;
  /* ── appended: down / revive / respawn / quick-use (Phase 2, owner: player) ── */
  /**
   * 전투불능: hp reached 0 but the player is not dead yet — crawling prone, no weapons, a separate `downHp`
   * (PLAYER_DOWN_HP) bleeding PLAYER_DOWN_BLEED_PER_SEC. Damage while downed hits `downHp`; at 0 → `player:died`.
   * `isDead` stays false while downed.
   */
  readonly isDowned: boolean;
  readonly downHp: number;
  /** Teammate finished the revive hold (net) → back up with PLAYER_REVIVE_HP, prone. No-op unless downed. */
  revive(): void;
  /** Start the stim heal-over-time (`player:stimUsed`, `player:healthChanged`). False when dead / downed / already full. Consuming the item is the caller's job. */
  applyStim(healAmount: number): boolean;
  /**
   * appended (2026-09-07): like `applyStim` but with the consumable's own duration — `amount` hp spread over
   * `seconds` (0 / negative = instant). `quiet` skips the 스팀 SFX (스프레이 ticks every 0.1 s). Refuses at full hp.
   */
  applyHeal(amount: number, seconds: number, quiet?: boolean): boolean;
  /** Respawn like at mission start: hellpod drop-in at `position`, full hp, alive, not downed. Emits `player:spawned` / `player:landed`. */
  respawn(position: THREE.Vector3): void;
  /* ── appended: Phase 4 (owner: player) ── */
  /** Shove the player: adds `direction × speed` (m/s, direction normalised, y allowed) to the controller velocity — behemoth charge, blasts. */
  applyKnockback(direction: THREE.Vector3, speed: number): void;

  /* ── appended: tactical kit (owner: player) ── */
  /** true while the melee swing animation is playing (weapons resolves the hit). */
  readonly isMeleeing: boolean;
  /** Start a melee swing (F). false when on cooldown / out of stamina / controls locked. */
  startMelee(): boolean;
  /** Cloaked: enemy detection range is scaled by `CLOAK_DETECT_MUL`. */
  readonly isCloaked: boolean;
  /** Apply / refresh a cloak for `duration` seconds. Optical-camo armor passes Infinity. */
  setCloak(duration: number, source: 'gadget' | 'armor'): void;
  /** 0..1 stealth factor an enemy multiplies its detection range by (1 = fully visible). */
  getStealthFactor(): number;
  /** Movement speed multiplier stacked on top of stance / stamina (overcharge, ultralight armor, weight). */
  setSpeedModifier(key: string, mul: number, duration?: number): void;
  /** Launch the player (jump pad, grapple release): adds to the velocity. */
  applyImpulse(impulse: THREE.Vector3): void;
  /** Grapple: pull the player toward `point` until released. null stops the pull. */
  setGrappleTarget(point: THREE.Vector3 | null): void;
  /** Backpack hover (tactical bag): slow the fall while held. */
  setHovering(hovering: boolean): void;
  readonly isHovering: boolean;
  /** true while an overcharge beam is buffing this player (speed / fire rate). */
  readonly isOvercharged: boolean;
  /** Damage reduction currently granted by armor (0..0.9). Read by the HUD. */
  readonly damageReduction: number;
  /** Burning (incendiary / fire zone): applies DoT and suppresses the grit save. */
  setBurning(dps: number, duration: number): void;
  readonly isBurning: boolean;

  /* ── appended: dev console / unique weapons (2026-09-06, owner: player) ── */
  /**
   * Instant move without a hellpod: feet to `position` (y snapped to the terrain / deck when `snap` is not false),
   * velocity cleared, stance / hp / items untouched. Optional `yaw`. Used by `/move` and the Home move cheat.
   */
  teleport(position: THREE.Vector3, yaw?: number, snap?: boolean): void;
  /** Wide-angle camera (FOV × SLASH_FOV_MUL, damped) while true — the 용검 slash wind-up / swing. */
  setViewWiden(active: boolean): void;
  /** Spend stamina (e.g. the big slash costs `maxStamina × SLASH_STAMINA_RATIO`). False (nothing spent) when short. */
  consumeStamina(amount: number): boolean;
  /**
   * Start a melee swing. `kind` (appended) `'heavy'` = the 용검 big slash pose (SLASH_DURATION, wider arc, weapons
   * resolves hits with SLASH_RANGE / SLASH_ARC_DEG / SLASH_DAMAGE). Default `'light'` = the normal F swing.
   */
  startMelee(kind?: 'light' | 'heavy'): boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Enemies
 * ──────────────────────────────────────────────────────────────────────────── */
/**
 * Enemy archetypes. Phase 4 appends: `rogue` (humanoid gunner, guards crates), `rogue_boss` (1.5× size, 5× hp, 3 escorts),
 * `artillery` (bug that lobs slow interceptable shells from afar), `toxic` (green sac, runs in and bursts — friendly-fire),
 * `behemoth` (4× bug, armoured front shell, line charge with knockback).
 */
export type EnemyType = 'scavenger' | 'hunter' | 'warrior' | 'spewer' | 'charger' | 'rogue' | 'rogue_boss' | 'artillery' | 'toxic' | 'behemoth';
/** Factions fight each other on sight (Phase 4). */
export type EnemyFaction = 'bug' | 'rogue';

export interface EnemyRef {
  readonly id: number;
  readonly type: EnemyType;
  readonly position: THREE.Vector3;
  readonly radius: number;
  readonly height: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly isDead: boolean;
  readonly object: THREE.Object3D;
  takeDamage(amount: number, hitPoint?: THREE.Vector3, hitDir?: THREE.Vector3): void;
  /* appended (Phase 4) */
  readonly faction: EnemyFaction;
  /* appended (unique weapons, 2026-09-06) */
  /** 전소 (incinerated): writhing on the spot, no movement / attacks, still damageable. Set via `applyStatus('incinerated')`. */
  readonly isIncapacitated: boolean;
}

/** Status effects an enemy can carry (appended 2026-09-06; `burning` / `slowed` are the tactical-kit originals). */
export type EnemyStatusKind = 'burning' | 'slowed' | 'incinerated' | 'shocked';

export interface EnemyHit {
  enemy: EnemyRef;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  /** Which hitbox was struck (appended by enemies): head ×2 for most bugs, rear ×2.5 on chargers. */
  part?: 'head' | 'body' | 'rear' | 'front';
  /**
   * appended (Phase 4): the struck hitbox is armour plate (behemoth front shell). Weapons deal **no damage** with
   * `light` / `medium` / `shell` ammo (ricochet FX instead); `heavy` rounds and explosions go through.
   */
  armored?: boolean;
}

/** Something a bullet can shoot down (Phase 4: artillery shells). Owner: enemies. */
export interface InterceptableRef {
  readonly id: number;
  readonly position: THREE.Vector3;
  readonly radius: number;
  /** Destroy it mid-air (FX + `enemy:shellIntercepted`). */
  intercept(point?: THREE.Vector3): void;
}

export interface EnemyManagerRef {
  getEnemies(): readonly EnemyRef[];
  getAliveCount(): number;
  /** Ray vs enemy hitboxes (capsules/spheres). Nearest hit or null. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): EnemyHit | null;
  /** Radial damage with linear falloff. Returns kills. */
  applyExplosion(center: THREE.Vector3, radius: number, damage: number): number;
  /** Intensity 0..1 for ambient pressure (used by GameFlow/difficulty). */
  setThreatLevel(level: number): void;
  /** Called by extraction: waves continuously until stopped. */
  startExtractionWaves(target: THREE.Vector3): void;
  stopExtractionWaves(): void;
  killAll(): void;
  reset(): void;
  /* appended (Phase 4) */
  /** Ray vs interceptable projectiles (artillery shells). Weapons call `target.intercept()` when this is the nearest hit. */
  raycastInterceptable(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { target: InterceptableRef; point: THREE.Vector3; distance: number } | null;

  /* ── appended: tactical kit (owner: enemies) ── */
  /** Enemies within `radius` of `pos` (alive only). Used by turrets, scans, explosions and lures. */
  queryNear(pos: THREE.Vector3, radius: number): EnemyRef[];
  /** Pull aggro toward `pos` for `duration` seconds (lure grenade, gunfire noise). `weight` 0..1 ranks competing lures. */
  addDistraction(pos: THREE.Vector3, radius: number, duration: number, weight: number): void;
  /**
   * Apply a status effect (burning ground, acid). `dps` 0 clears it.
   * Appended (2026-09-06): `'incinerated'` = 전소 for `duration` s (`dps` ignored; enemy writhes, `isIncapacitated`,
   * emits `enemy:incinerated`); `'shocked'` = slow by factor `dps` (0..1, like `slowed`) for `duration` s + `enemy:shocked`.
   * On a replica the call is forwarded to the host as a `HitRequest.st` status hint.
   * `attacker` (appended, Phase 9): PeerId | 'local' credited for the DoT kill (burn kills no longer go to the last
   * direct damager); the host fills it from the relay `from` for a replica's request. Undefined = keep `lastDamager`.
   */
  applyStatus(id: number, status: EnemyStatusKind, dps: number, duration: number, attacker?: string): void;
  /** Damage every enemy in a radius and credit `by` (turret / mine / rocket). Returns kills. */
  applyAreaDamage(center: THREE.Vector3, radius: number, damage: number, by?: string): number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Interaction
 * ──────────────────────────────────────────────────────────────────────────── */
export interface Interactable {
  id: string;
  position: THREE.Vector3;
  radius: number;                 // interaction range (meters)
  /** Prompt text shown by HUD, e.g. "상자 열기". Return null to hide. */
  getPrompt(): string | null;
  canInteract(): boolean;
  interact(): void;
  /** Optional hold time in seconds (switch press). 0/undefined = instant. */
  holdTime?: number;
  /* appended (Phase 2, revive): the player calls these while the hold is running / when it is released early. */
  onHoldProgress?(t: number): void;
  onHoldCancel?(): void;
  /**
   * appended (2026-09-08): true = `ui/hud/Detection` draws **no** 빛기둥 for this interactable, even though it is in
   * range and still interactable. Purely local presentation — a corpse this client has already searched sets it, and
   * nothing about it is replicated (another player looting the same body never clears our pillar, and ours never
   * clears theirs). Leave undefined for the normal "in range → pillar" behaviour.
   */
  hidePillar?: boolean;
}

export interface InteractableRegistry {
  register(i: Interactable): void;
  unregister(id: string): void;
  clear(): void;
  /** Nearest interactable within its own radius of `pos`. */
  findBest(pos: THREE.Vector3, forward?: THREE.Vector3): Interactable | null;
  all(): readonly Interactable[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Systems
 * ──────────────────────────────────────────────────────────────────────────── */
export interface GameSystem {
  readonly name: string;
  /** Called once after all systems are constructed. Do NOT depend on world/player here; subscribe to events. */
  init(ctx: GameContext): void;
  /** Variable timestep update (dt clamped to ≤ 0.05 s). */
  update(dt: number, ctx: GameContext): void;
  /** Called after all updates, before render (camera, UI sync). */
  lateUpdate?(dt: number, ctx: GameContext): void;
  dispose?(): void;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Player ↔ Weapons hooks (appended by player/weapons owner)
 * `ctx.player` also implements this interface; WeaponSystem narrows with a runtime check.
 * ──────────────────────────────────────────────────────────────────────────── */
export interface PlayerWeaponHost {
  /** Right-hand socket the weapon model is parented to (weapon -Z = barrel forward). */
  getWeaponSocket(): THREE.Object3D;
  /** Camera aim ray from the reticle (screen center). Writes `origin` & unit `direction`. */
  getAimRay(origin: THREE.Vector3, direction: THREE.Vector3): void;
  /** Camera recoil kick (radians). Positive pitch = kick upward. */
  addRecoil(pitch: number, yaw: number): void;
  /** Weapon tells the player what it is doing so the model can pose (reload / fire / holstered). */
  setWeaponState(state: { hasWeapon: boolean; reloading: boolean; firing: boolean; twoHanded: boolean }): void;
  /** False while controls are locked (drop-in, liftoff, death) — weapons must not fire. */
  canUseWeapons(): boolean;
  /* ── appended: ADS zoom (weapons → player) ── */
  /** Active weapon's ADS zoom: FOV divisor (1 = none) and whether it is a scoped weapon. Call on equip/swap/unequip. */
  setAimZoom(zoom: number, scope: boolean): void;
  /* ── appended: weapon package ── */
  /** Seconds the active weapon needs to aim in fully (secondary ≈ half of a primary; stocks shorten it). Default 0.25. */
  setAdsTime(seconds: number): void;
  /* ── appended: quick-use wheel / grenade cooking (Phase 2) ── */
  /** While true the mouse delta is consumed by the quick-use wheel instead of the camera (weapons opens the wheel on F hold). */
  setLookLocked(locked: boolean): void;
  /**
   * Extended weapon pose (weapons → player). `throwing` = grenade wind-up pose (right arm back) while LMB is held,
   * `holdingItem` = a consumable (stim / grenade) is in hand instead of a gun (no weapon model, one-handed).
   */
  setWeaponState(state: { hasWeapon: boolean; reloading: boolean; firing: boolean; twoHanded: boolean; throwing?: boolean; holdingItem?: boolean }): void;
  /* ── appended: unique weapons (2026-09-06) ── */
  /**
   * Extra pose hints: `charging` (shockgun RMB / minigun spin-up — braced stance), `spraying` (flame / arc continuous
   * fire), `heavy` (bazooka / minigun carried at the hip, no ADS). All optional; the player ignores unknown flags.
   */
  setWeaponState(state: { hasWeapon: boolean; reloading: boolean; firing: boolean; twoHanded: boolean; throwing?: boolean; holdingItem?: boolean; charging?: boolean; spraying?: boolean; heavy?: boolean; altFire?: boolean }): void;
}

/* ══ appended: Phase 5 — meta progression (2026-09-06, owner: meta/ unless noted) ═══════════════════════ */
/**
 * Mission-end rewards, filled by game/GameFlowSystem right before `game:complete` / `game:over` so the result
 * screens (ui) can show the XP line and the contract settlement. All optional: older emitters keep compiling.
 */
export interface MissionRewards {
  /** Character XP paid for this mission (`ctx.progression.addXp`). */
  xpEarned: number;
  levelBefore: number;
  levelAfter: number;
  /** XP into the current level / needed for the next, after the award. */
  xp: number;
  xpToNext: number;
  /** Active-contract settlement (`ctx.meta.settleMission`), null when no contract was running. */
  contract: import('./meta').ContractSettlement | null;
}
export interface MissionStats {
  /* appended (Phase 5) */
  rewards?: MissionRewards;
}

export interface InventoryRef {
  /* ── appended: Phase 5 — corp shop / stash access (owner: inventory) ── */
  /** Every stack in the ship stash (read-only snapshot). */
  getStashItems(): ItemInstance[];
  /** Like `findItem` but also searches the stash. */
  findItemAnywhere(uid: string): ItemInstance | null;
  /** Add a fresh instance to the stash grid (auto-placed). False when it does not fit. */
  tryAddToStash(item: ItemInstance): boolean;
  /** Bag first, then the stash. Returns where it landed, null when neither has room. */
  tryAddItemAnywhere(item: ItemInstance): 'bag' | 'stash' | null;
  /**
   * Remove `qty` units (default: the whole stack) of bag / stash item `uid` without dropping it (corp sale). Equipped
   * gear is refused. Returns how many units were removed (0 = not found / refused). Clears quick slots at 0.
   */
  takeItem(uid: string, qty?: number): number;

  /* ══ appended: Phase 9 UI pass — embedded trade grids (2026-09-07) ══════════════════════════════════════ */
  /**
   * Render the player's **real 가방 / 함선 창고 grids** into `host` for another folder's screen (the 기업 거래
   * screen's right-hand column). Read + drag-out only: a tile can be dragged onto one of `dropSelector`'s targets
   * or double-clicked, which calls `onTake` — nothing is moved, removed or rearranged by the view itself, so the
   * caller stays the only one mutating the inventory (`takeItem` / `tryAddItemAnywhere`).
   *
   * The view adds **no blocker, no pointer-lock call and no window key listener** — the caller's shell owns those,
   * exactly like `createCorpView` / `createShipView`. `dispose()` removes only what it added.
   */
  createTradeGrids(host: HTMLElement, opts?: TradeGridsViewOptions): EmbeddedView;
}

/** Options for `InventoryRef.createTradeGrids` (Phase 9 UI pass). */
export interface TradeGridsViewOptions {
  /** Grids to render, top to bottom. Default: `['bag', 'stash']`. */
  grids?: readonly ('bag' | 'stash')[];
  /** A tile was dragged onto a `dropSelector` target (`target`) or double-clicked (`target` null). */
  onTake?(item: ItemInstance, gridId: 'bag' | 'stash', target: HTMLElement | null): void;
  /** CSS selector of the caller's legal drop targets. Without it a drag simply snaps back. */
  dropSelector?: string;
  /** Tiles to mark `.is-staged` (already staged in the caller's tray). */
  isStaged?(uid: string): boolean;
  /** Extra class on the view root so the caller can size the blocks from its own stylesheet. */
  className?: string;
  /**
   * Grid cell edge in px (default 54 — the Tab window's). Appended 2026-09-07 for the 기업 거래 desk, whose
   * 가방 / 함선 창고 grids must match the 5-column 구매 / 판매 tray beside them.
   */
  cell?: number;
}

/* ══ appended: Phase 7 — known follow-ups (2026-09-06) ═══════════════════════════════════════════════════════ */
/**
 * Kind of mission a world is generated for. `'raid'` = the normal planet drop; `'training'` = the 시뮬레이션 훈련장:
 * a small enclosed arena with pop-up targets, no enemies / crates / extraction, entered from the 사격장 sim hub
 * (personal ship) or the shared-ship terminal, left through the arena's exit console (`training:exitRequested`).
 * Ammo / durability spent in a training are restored on exit (game/ captures + re-applies `captureRaidState`).
 */
export type MissionMode = 'raid' | 'training';
export interface MissionStats {
  /* appended (Phase 7): mode of the mission the stats belong to (`'raid'` when absent). */
  mode?: MissionMode;
}

/** Body state handed back to a returning member (`ghost restore`) — owner: player. */
export interface PlayerRestoreState {
  position: THREE.Vector3;
  yaw: number;
  hp: number;
  downHp: number;
  /** 0 alive · 1 downed · 2 dead (`GhostState`). */
  state: 0 | 1 | 2;
}

export interface PlayerRef {
  /* ── appended: Phase 7 (owner: player) ── */
  /**
   * Resume the body exactly as the host's ghost left it: standing at `position` (no hellpod), `hp`, downed with
   * `downHp` when `state` 1, dead (spectate / respawn flow) when `state` 2. Emits `player:spawned` for 0 / 1.
   * Called by game/ on a rejoin after `world:ready`; the player must NOT auto-drop on `world:ready` while
   * `ctx.rejoinPending` is true (game/ sets it before the rejoin's `game:newMission`).
   */
  restoreState(state: PlayerRestoreState): void;
  /** true while the 용검 heavy slash pose is playing (`startMelee('heavy')`); MELEE_HEAVY on the wire. */
  readonly isMeleeHeavy: boolean;
}

/**
 * Per-frame pose / item state weapons/ exposes for the snapshot builder (net/ reads it every snapshot, never mutates).
 * One stable object, updated in place — no per-frame allocation.
 */
export interface WeaponRemoteState {
  /** Def id of the consumable / gadget in hand (HOLDING_ITEM), or null. */
  heldItemId: string | null;
  throwing: boolean;
  cooking: boolean;
  charging: boolean;
  spraying: boolean;
  heavy: boolean;
  /** Attachment def ids socketed on the active weapon (empty when none). Same array instance while unchanged. */
  attachments: readonly string[];
}
export interface WeaponsRef {
  /* ── appended: Phase 7 (owner: weapons) ── */
  readonly remoteState: WeaponRemoteState;
}

export interface InventoryRef {
  /* ── appended: Phase 7 (owner: inventory) ── */
  /**
   * Would `qty` units of `defId` fit right now without changing anything? Bag first, then (hub phase only) the stash —
   * returns where it would land. The corp shop greys a line out with `공간 없음` from this before the click.
   */
  canFit(defId: string, qty?: number): 'bag' | 'stash' | null;
  /**
   * Full serialization of the mission-side inventory (bag + 5 slots + quick slots, every instance field incl.
   * durability / rounds / sockets / `searched`) for the raid session blob and the training freeze. Opaque to callers.
   */
  captureRaidState(): unknown;
  /** Replace the bag + slots + quick slots with a `captureRaidState()` result. False (nothing changed) when invalid. */
  applyRaidState(state: unknown): boolean;
}

export interface WorldRef {
  /* ── appended: Phase 7 (owner: world) ── */
  /** Mode the current world was generated for (`'raid'` for the planet). */
  readonly mode: MissionMode;
}

export interface EnemyManagerRef {
  /* ── appended: Phase 7 (owner: enemies) ── */
  /**
   * Live authority switch (mid-mission host migration). `true` = promote: every replica becomes a simulated enemy
   * seeded from its wire state (type / position / hp / state), the spawner + wave director resume from
   * `ctx.missionTime` and the extraction stage, corpses are adopted. `false` = demote: simulated enemies become replicas
   * (the next full `es` from the new host overwrites them). Called by enemies/ itself on `net:hostChanged`; exposed for
   * the console / tests.
   */
  setAuthority(authority: boolean): void;
}

export interface ItemInstance {
  /* appended (Phase 7, owner: inventory): Tarkov-style container search — true once revealed (default for anything not from a container). */
  searched?: boolean;
}

/* ══ appended: Phase 8 — UI/UX pass (2026-09-06) ═══════════════════════════════════════════════════════════ */

/**
 * A screen another folder renders **inside a host element the caller owns** (the 캐릭터 / 기업 / 함선 tabs of the
 * inventory Tab screen). The owning folder builds its DOM into `host` and hands back this handle; the caller calls
 * `refresh()` when its own state changes and `dispose()` when the tab goes away. An embedded view must NOT touch
 * `ctx.uiBlockers`, exit the pointer lock, or install a window-level Escape listener — the host window owns all three.
 */
export interface EmbeddedView {
  /** Repaint from the current state. Safe to call every time the tab is shown. */
  refresh(): void;
  /** Remove every element and listener the view added to the host. */
  dispose(): void;
}

/** Volume channels the settings menu exposes. `sfx` scales gameplay one-shots; `master` scales everything. */
export type AudioChannel = 'master' | 'sfx';

export interface AudioSettings {
  master: number;
  sfx: number;
}

/**
 * `ctx.audio` — published by audio/AudioSystem so ui/ can drive the settings sliders without importing the folder.
 * Values are 0 … 1 and are persisted to localStorage (`AUDIO_STORAGE_KEY`) by audio/ itself.
 */
export interface AudioRef {
  readonly settings: Readonly<AudioSettings>;
  /** Apply immediately (ramps the matching GainNode) and persist (debounced). */
  setVolume(channel: AudioChannel, value: number): void;
  /** Play a short reference blip so the player hears the level they just set. */
  preview(channel: AudioChannel): void;
}

/* ══ appended: Phase 9 — known follow-ups II (2026-09-06) ══════════════════════════════════════════════════ */

/** 시뮬레이션 훈련장 target mode (owner: world/TrainingArena, per client — never on the wire). */
export type TrainingMode = 'static' | 'moving' | 'timed';
export const TRAINING_MODES: readonly TrainingMode[] = ['static', 'moving', 'timed'];
export const TRAINING_MODE_LABEL_KO: Readonly<Record<TrainingMode, string>> = { static: '고정 표적', moving: '이동 표적', timed: '타임 코스' };

/**
 * Training-range controller, `ctx.world.training` while a training world is up (null otherwise). The arena owns the
 * targets, the mode console (`training_mode`, cycles modes) and the weapon rack (`training_rack` →
 * `inventory.openCatalog({category:'primary'})`; everything taken there is undone by game/'s exit restore).
 */
export interface TrainingRef {
  readonly mode: TrainingMode;
  /** false outside a training world or while a timed course is running. Emits `training:modeChanged`. */
  setMode(mode: TrainingMode): boolean;
  /** Knock-downs in the current run (timed: this course; other modes: since entry / `resetScore`). */
  readonly score: number;
  /** Hits in the current run. */
  readonly hits: number;
  /** Seconds left in a running timed course, −1 when idle. */
  readonly remaining: number;
  /** Best timed-course time in seconds (localStorage `TRAINING_BEST_STORAGE_KEY`), null when never finished. */
  readonly bestTime: number | null;
  /** Start a timed course (`TRAINING_COURSE_TARGETS` knock-downs within `TRAINING_COURSE_TIME_S`). false unless mode is `'timed'` and idle. */
  startCourse(): boolean;
  resetScore(): void;
}

export interface WorldRef {
  /* ── appended: Phase 9 (owner: world) ── */
  /** 시뮬레이션 훈련장 controller; null outside a training world. */
  readonly training: TrainingRef | null;
}

/* ══ appended: Phase 10 — UI 개선 pass (2026-09-07) ═════════════════════════════════════════════════════════ */

/* ── 다각화된 적 사망 + 확률 루팅 (owner: enemies) ── */
/** Which way a dying body goes down. Decided deterministically from the world seed × enemy id, so every client agrees. */
export type EnemyDeathDir = 'left' | 'right' | 'back';
/** Wire order of `EnemyDeathDir` (`ee kill/corpse.dd` is an index into this; omitted = 0 = `'left'`). */
export const ENEMY_DEATH_DIRS: readonly EnemyDeathDir[] = ['left', 'right', 'back'];
/**
 * Probability that a corpse of each enemy type can be searched at all. Rolled from an **independent** seeded stream
 * (`worldSeed ^ (enemyId * 0x9e3779b1)`) so it never shifts the existing `rollCorpse` rolls, and so host and replicas
 * agree without a wire field. A corpse that fails the roll registers no interactable (`Corpse.canInteract` false).
 */
export const CORPSE_LOOT_CHANCE: Readonly<Record<EnemyType, number>> = {
  scavenger: 0.1, toxic: 0.1, hunter: 0.1,
  spewer: 0.35, warrior: 0.35, artillery: 0.35, charger: 0.35,
  behemoth: 1, rogue: 1, rogue_boss: 1,
};

export interface EnemyRef {
  /** The direction this body fell; undefined while alive. */
  readonly deathDir?: EnemyDeathDir;
  /** false when this corpse rolled un-searchable (`CORPSE_LOOT_CHANCE`); undefined while alive. */
  readonly lootable?: boolean;
}

/* ── 부상자 들쳐메기 (owner: player) ── */
/** Why a carried squadmate was put back down. `'action'` = the carrier did something other than run. */
export type CarryEndReason = 'manual' | 'action' | 'damage' | 'revived' | 'died' | 'reset';

export interface PlayerRef {
  /** PeerId of the squadmate on our right shoulder, or null. A string so player/ never needs the branded net type. */
  readonly carrying: string | null;
  /** true while another player carries us (we are still DOWNED and our position follows their shoulder socket). */
  readonly isCarried: boolean;
  /**
   * Shoulder a downed squadmate (F tap). false when out of `PLAYER_CARRY_RANGE`, already carrying, downed / dead
   * ourselves, or the target is not downed. The gun is holstered for as long as the carry lasts.
   */
  carry(id: string): boolean;
  /**
   * Put the carried squadmate down at our feet. Returns true when someone was actually dropped — every non-movement
   * action calls this first and re-tries itself on the next frame (`PLAYER_CARRY_DROP_S`).
   */
  dropCarried(reason?: CarryEndReason): boolean;
  /** Ride along on another player's shoulder socket; null detaches. Called on the carried side by player/. */
  setCarriedBy(socket: THREE.Object3D | null): void;
}

export interface PlayerWeaponHost {
  /** Right-shoulder socket a carried squadmate is parented to. Optional — callers must feature-detect. */
  getShoulderSocket?(): THREE.Object3D;
}

/* ── 발사 준비 패널 초상화 (owner: player, hosted by hub) ── */
/**
 * A strip of character portraits rendered into a DOM element. player/ owns it because it needs `SoldierModel`; it uses
 * its **own** `THREE.WebGLRenderer` + scene + lights, because `core/Engine` renders through the composer at the end of
 * the frame and offers no post-render hook, so a portrait cannot share the main canvas.
 */
export interface PortraitRef {
  /** The canvas the portraits draw into (already appended to the host). */
  readonly canvas: HTMLCanvasElement;
  /** Cell `index` shows a body with this slot colour / armor; `null` = empty cell (member not ready). */
  setMember(index: number, member: { slot: number; armorId: string | null } | null): void;
  /** Body yaw in radians for one cell (3/4 view = `HUB_READY_PORTRAIT_YAW`; the model's front is −Z). */
  setYaw(index: number, yaw: number): void;
  /** Draw one frame. No-op while `visible` is false. Call from the owner's `update`. */
  render(dt: number, time: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface PlayerRef {
  /**
   * Build `cells` character portraits into `host` (one canvas, `cells` scissored viewports). Returns null when a second
   * WebGL context is unavailable — callers must degrade to a name-only cell.
   */
  createPortraits(host: HTMLElement, cells: number): PortraitRef | null;
}

/* ── 분대원 장비 열람 (owner: inventory) ── */
/** Options for `InventoryRef.createCrewLoadoutView`. */
export interface CrewLoadoutViewOptions {
  /** Name shown in the header (`LobbyPlayer.name`). */
  name?: string;
  /** Slot colour index for the accent (`NET_SLOT_COLORS_CSS`). */
  slot?: number;
  /** Blocks to render, left to right. Default `['equip', 'bag', 'quick']` — the ship layout minus 함선 창고. */
  blocks?: readonly ('equip' | 'bag' | 'quick')[];
  /** Extra class on the view root so the caller sizes it from its own stylesheet. */
  className?: string;
}

export interface InventoryRef {
  /**
   * Serialize MY bag + equip slots + quick slots for the wire (`CrewMessage.loadout`). Opaque to callers — the same
   * document `captureRaidState()` builds, minus the per-container `searched` flags.
   */
  captureCrewLoadout(): unknown;
  /**
   * Render **another member's** read-only 장비 / 가방 / 빠른 사용 layout from a `captureCrewLoadout()` document into
   * `host`. Nothing is draggable, rotatable, socketable or droppable, there is no credits pill, and unknown def ids are
   * skipped. Returns null when the document is not a loadout. Like every `EmbeddedView`: no `uiBlockers`, no
   * pointer-lock call, no window Escape listener.
   */
  createCrewLoadoutView(host: HTMLElement, loadout: unknown, opts?: CrewLoadoutViewOptions): EmbeddedView | null;
}

/* ══ appended: Phase 11 — 행성 선택 (2026-09-07) ════════════════════════════════════════════════════════════ */

export interface HubRef {
  /* ── 목표 행성 (owner: hub; the terminal is the only place it is picked) ── */
  /**
   * 목표 행성 of the next raid, or null while nothing is picked. In a lobby this mirrors `LobbyState.planet` (the
   * host's choice); solo it is the local pick, remembered in localStorage `PLANET_STORAGE_KEY`. Launch slots refuse
   * boarding while it is null.
   */
  readonly planet: PlanetId | null;
  /**
   * Pick the 목표 행성. Refused (`false`) for a non-host in a lobby, while a launch countdown runs, while already
   * travelling, and for an unknown id. On success the ship flies there: `hub:travel {stage:'start'}` → the 창문 워프
   * (2026-09-09: seen through the viewports, controls stay on, `hub:warpProgress` every frame) →
   * `hub:travel {stage:'end'}` → `hub:planetChanged`. In a lobby the host also calls `ctx.net.setLobbyPlanet`, and
   * every member's own `lobby:state` starts the same warp locally.
   */
  setPlanet(planet: PlanetId): boolean;
  /** true while the ship is flying to a new planet (terminal closed, pods unavailable; the player keeps walking). */
  readonly travelling: boolean;
}

export interface WorldRef {
  /* ── 행성 (owner: world) ── */
  /**
   * Planet the current world was generated for, or null when it came from the seeded biome draw (an older client,
   * a training, `MissionComplete`'s 다시 배치 without one). `world:ready.planet` carries the same value.
   */
  readonly planet: PlanetId | null;
}

/* ══ appended: 2026-09-07 UI/UX pass — 기업 화면이 Tab 창의 탭이 되었다 ══════════════════════════════════════ */

/** A screen of the Tab window (`InventoryRef.openScreen` / `screenTab`). */
export type InventoryScreenTab = 'inventory' | 'character' | 'corp' | 'ship';

export interface InventoryRef {
  /**
   * Open the Tab window in ship mode on a **screen tab**. The 기업 네트워크 console (`hub_computer`) uses this since
   * the corp screen lost its own overlay: `ctx.meta.openCorpMenu()` is `openScreen('corp')`. Ship-only — the embedded
   * screens are — and false when the tab could not be shown (wrong phase, or the owning folder is missing).
   */
  openScreen(tab: InventoryScreenTab): boolean;
  /** Screen tab the window is showing; `'inventory'` while the window is closed. */
  readonly screenTab: InventoryScreenTab;
}

/* ══ appended: 2026-09-08 — 임플란트(능력치 장착 아이템) · 배리어 충돌 · 총알 추적 · 스캔 실루엣 ═══════════════════
 * Contract for the 2026-09-08 batch (see `src/shared/README.md`, last section, and `docs/DECISIONS.md`).
 * Append-only, as always. Owners are named per member.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * category 'implant' (owner: items). An 임플란트 is a Hollow-Knight-charm style equippable: it occupies `slots` of the
 * character's implant slots (`ProgressionRef.implantSlots`, 4 + 1 per 5 levels, max 10) and adds `stats` to the five
 * base stats while equipped. `broken` implants (raid loot) give nothing and cannot be equipped; 세레스 바이오's 임플란트
 * desk repairs one into `repairsTo` for the materials in `repairCost`. Legendary implants may carry a `perk`
 * (`PerkId`, progression folds it into `DerivedStats.perks`). Equip / unequip only in the ship, never mid-raid.
 */
export interface ImplantItemDef {
  /** Implant slots this item occupies while equipped (1..4). */
  slots: number;
  /** Flat stat bonuses while equipped (e.g. `{ strength: 1 }`). Empty for a broken implant. */
  stats: Partial<Record<import('./progression').StatId, number>>;
  /** Legendary perk this implant grants (progression → `derived.perks[perk] = true`). */
  perk?: import('./progression').PerkId;
  /** 망가진 임플란트: cannot be equipped, gives nothing; only a repair desk wants it. */
  broken?: boolean;
  /** Broken only: the def id this repairs into at 세레스 바이오. */
  repairsTo?: string;
  /** Broken only: materials consumed by the repair, besides the broken implant itself. */
  repairCost?: Array<{ defId: string; qty: number }>;
}

export interface ItemDef {
  /** category 'implant' (owner: items): slot cost, stat bonuses, perk, broken / repair data. */
  implant?: ImplantItemDef;
}

export interface EnemyManagerRef {
  /**
   * A bullet flew (owner: enemies; called by weapons for **every** local hitscan / projectile shot, host or not — on a
   * non-host client enemies/ forwards it to the host as a `shotq`). `origin` → `origin + dir × range`, `hit` = the
   * impact point when the shot stopped somewhere (null = flew its full range). An enemy that could **not** perceive the
   * shooter but whose body lies within `ENEMY_SHOT_ALERT_DIST` of the bullet path, or within `ENEMY_SHOT_IMPACT_DIST`
   * of the impact, turns to face the shot origin, widens its perception toward it by `ENEMY_SHOT_ALERT_CONE_MUL` for
   * `ENEMY_SHOT_ALERT_WATCH_S`, and — if it still has not found anyone — advances toward the origin (rogues from cover
   * to cover, bugs directly). Finding the shooter drops into the normal combat cycle. No-op on the 훈련장.
   */
  reportShot(origin: THREE.Vector3, dir: THREE.Vector3, range: number, hit: THREE.Vector3 | null): void;
  /**
   * 정찰 x-ray (owner: enemies): draw a **red silhouette through geometry** (GreaterDepth pass, like the player's
   * occlusion silhouette) for these enemies for `seconds`; a second call extends. Replicas included. `[]` + 0 clears.
   */
  setXray(ids: readonly number[], seconds: number): void;
}

/* ══ appended: 출격 준비 점검 (2026-09-08, owner: inventory) ═══════════════════════════════════════════════════════
 * 발사 슬롯에 타기 전에 "이대로 나가면 곤란한" 것들을 한 번에 훑는다. 판정은 전부 인벤토리가 한다 — 가방 · 장착
 * 장비 · 탄약 스택 · 회복 아이템을 아는 건 거기뿐이고, `hub/` 는 결과 목록을 그리기만 한다.
 * 여섯 가지 모두 **경고**일 뿐 탑승을 막지 않는다: 확인을 누르면 그대로 출격한다.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type LaunchWarningId =
  | 'noPrimary'    // 주무기(주무기 I · II)를 하나도 안 들었다
  | 'lowAmmo'      // 들고 있는 무기의 구경 탄약이 한 세트(= 한 칸, `AMMO_STACK_ROUNDS`) 미만이다
  | 'noBag'        // 가방 미장착
  | 'noArmor'      // 방탄복 미장착
  | 'noImplant'    // 전술 임플란트 미장착 (`ctx.implants.equipped`)
  | 'noHeal';      // 회복 아이템(category 'stim')이 가방에 없다

/** One reason the launch check raised. Both strings are 한국어 and ready to render. */
export interface LaunchWarning {
  id: LaunchWarningId;
  /** Headline (`주무기가 없습니다`). */
  text: string;
  /** One line of detail — which weapon, how many rounds short … Empty when the headline says it all. */
  detail: string;
}

export interface InventoryRef {
  /**
   * 출격 준비 점검. Empty array = nothing to warn about. Order is fixed (the `LaunchWarningId` order above) so the
   * popup reads the same every time. Reads only — nothing is equipped, moved or consumed.
   */
  getLaunchWarnings(): LaunchWarning[];
}

/* ══ appended: 공용 함선 격납고 (2026-09-08, owner: hub) ═══════════════════════════════════════════════════════════
 * 공유 함선 뒤쪽 자동문 너머가 **격납고**다. 분대원 4명의 개인 함선이 바닥에 표시된 구역마다 한 대씩 서 있고,
 * 함선 뒷문(입구)에 상호작용하면 그 사람의 개인 함선 안으로 들어간다 — 남의 함선은 **둘러보기 전용**.
 *
 * 인테리어는 여전히 한 번에 하나만 존재한다: 격납고는 `'shared'` 인테리어의 일부이고, 베이에 들어가면
 * 인테리어가 `'personal'` 로 교체된다(로비는 그대로 유지된다). 어느 함선 안에 있는지는 `hubSite` 가 말한다.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * One 개인 함선 bay on the hangar deck. `slot` = the lobby slot the bay belongs to. `occupant` is a plain `string`
 * (a `PeerId`) for the same reason `HubLaunchSlot.occupant` is: `types.ts` is imported *by* `net.ts`.
 */
export interface HubShipBay {
  slot: number;
  /** Centre of the floor marking. */
  position: THREE.Vector3;
  /** Interaction anchor at the parked ship's rear ramp (deck level). */
  entrance: THREE.Vector3;
  /** Player yaw looking at the ship from the ramp. */
  yaw: number;
  /** Peer parked here (null = the bay is empty / no lobby). */
  occupant: string | null;
}

export interface HubRef {
  /* ── appended (2026-09-08): 공용 함선 격납고 ── */
  /**
   * The personal ship the player is standing inside, as a PeerId — our own id (or `'local'` offline) in our own
   * ship, the owner's id in a visited one — and **null on the shared deck (공유 함선 + 격납고)**. This is what
   * `PlayerSnapshot.hs` carries, so remote avatars can be hidden for anyone standing somewhere else.
   */
  readonly hubSite: string | null;
  /** PeerId of the ship being **visited** (someone else's), or null in our own ship / on the shared deck. */
  readonly visitingPeer: string | null;
  /** True while inside someone else's ship: every station, bench and 시설 관리 is refused (둘러보기 전용). */
  readonly visitReadOnly: boolean;
  /** The hangar's four bays (empty array outside the shared ship). */
  getShipBays(): readonly HubShipBay[];
  /**
   * Board the 개인 함선 parked in `slot`. Ours enters straight away; a peer's needs their `ship state` (requested on
   * the spot when it has not arrived yet, up to `SHIP_VISIT_WAIT_S`). Returns false when the bay is empty or the hub
   * is busy (cutscene / countdown / not in the hangar).
   */
  enterShipBay(slot: number): boolean;
  /** Walk back out through the airlock into the hangar. Returns false when we are not inside a bay's ship. */
  returnToHangar(): boolean;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-09 — 사망/시체 · 구조선 · 분대장 · 전장의 안개 · 지형지물 위 걷기
 *
 * 이 묶음의 계약. 인터페이스는 **선언 병합**으로 늘리기만 한다 (이름 변경 · 삭제 없음).
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/* ── 전장의 안개 (owner: world/Fog, 게시: `ctx.world.fog`) ─────────────────────────────────────────────── */
/**
 * 레이드 맵의 탐색 진행도. `MAP_SIZE / FOG_CELL_M` 변의 정사각 그리드 하나가 원본이고,
 * **한 번 밝힌 칸은 레이드가 끝날 때까지 다시 어두워지지 않는다**.
 *
 * 밝히는 주체는 **분대원 전원**이다 — world 가 매 `FOG_UPDATE_HZ` 마다 로컬 플레이어와
 * `ctx.net.getRemotePlayers()` 의 살아있는(같은 미션 안) 좌표 주위 `FOG_REVEAL_RADIUS` 를 칠한다.
 * 스냅샷이 이미 20 Hz 로 흐르므로 **새 와이어가 필요 없다**. 늦게 합류한 클라이언트만 호스트에게
 * `fogq sync` 로 지금까지의 마스크를 받는다.
 *
 * 훈련장(`mode === 'training'`)에서는 만들어지지 않는다 (`ctx.world.fog === null`).
 */
export interface FogRef {
  /** 격자 해상도 (한 변의 칸 수). */
  readonly cells: number;
  /** 한 칸의 한 변(m) = `FOG_CELL_M`. */
  readonly cellSize: number;
  /** 새 칸이 밝혀질 때마다 1 오른다. 지도는 이 값이 바뀔 때만 안개 레이어를 다시 그린다. */
  readonly revision: number;
  /** 밝혀진 칸의 총 수 / 전체 칸 수 (0..1) — HUD 의 탐색률. */
  readonly explored: number;
  /**
   * 행 우선 `cells × cells` 마스크. 0 = 미탐색, 255 = 밝혀짐.
   * **읽기 전용으로 다룬다** — 지도 캔버스가 그대로 ImageData 로 밀어 넣는다.
   */
  readonly mask: Uint8Array;
  /** 월드 좌표가 이미 밝혀진 칸인가. 범위 밖은 true (맵 밖은 가릴 것이 없다). */
  isRevealed(x: number, z: number): boolean;
  /** `position` 이 밝혀진 칸에 있는가 — 오브젝트 발견 게이트의 표준 질의. */
  isDiscovered(position: THREE.Vector3): boolean;
  /** 월드 좌표 주위 `radius` m 를 밝힌다 (world 가 스스로 부르고, 구조선 착륙 같은 이벤트도 쓴다). */
  reveal(x: number, z: number, radius: number): void;
  /** 늦게 합류한 클라이언트용 직렬화 (base64) / 적용. 호스트만 만든다. */
  serialize(): string;
  applySerialized(data: string): void;
}

export interface WorldRef {
  /* ── appended (2026-09-09) ── */
  /** 전장의 안개. 레이드에서만 존재하고 훈련장에서는 null. */
  readonly fog: FogRef | null;
  /**
   * **걸어 다닐 수 있는 표면의 높이** — 지형 높이와 그 자리 장애물 윗면 중 높은 쪽.
   * `getHeightAt` 은 지형만 보므로 발이 닿는 곳을 물을 때는 이쪽을 쓴다.
   *
   * `feetY` 를 주면 그 발 높이에서 **올라설 수 있는** 윗면만 본다 (`feetY + PROP_STEP_UP_MAX` 이하).
   * 주지 않으면 그 자리에서 제일 높은 윗면을 돌려준다 (총알 · 낙하 판정용).
   */
  getSurfaceY(x: number, z: number, feetY?: number): number;
  /**
   * `(x, z)` 에서 발 높이 `feetY` 로 서 있을 때 밟고 있는 장애물, 없으면 null.
   * 그 위에 선 동안 그 장애물은 `resolveCollision` 이 밀어내지 않는다.
   */
  getStandingObstacle(x: number, z: number, feetY: number): Obstacle | null;
  /**
   * 반경 `radius` 원 안을 장애물이 차지하는 면적 비율(0..1). 대형 적 스폰 자리를 거르는 데 쓴다.
   * 원기둥 단면끼리의 근사값이고 겹침은 보정하지 않으므로 1 을 넘을 수 있다.
   */
  obstacleCoverage(x: number, z: number, radius: number): number;
  /**
   * 서로 `minGap` m 이상 떨어진 지점 `count` 개를 `center` 주변 `radius` 안에서 뽑는다
   * (구조 포드가 겹쳐 떨어지지 않게). 지형 높이가 채워지고, 자리가 모자라면 그만큼만 돌려준다.
   */
  scatterPoints(center: THREE.Vector3, radius: number, count: number, minGap: number, seed?: number): THREE.Vector3[];
}

/* ── 사망한 플레이어의 시체 (owner: game/parts/Corpses, 게시: `ctx.corpses`) ───────────────────────────── */
/**
 * 한 구의 시체. **레이드가 끝날 때까지 사라지지 않는다** — 적 시체의 `CORPSE_LIFETIME` 도, 거리 컬링도
 * 적용되지 않는다 (사용자 결정: 최적화 대상에서 제외).
 */
export interface PlayerCorpse {
  /** `pcorpse:<ownerId>:<n>` — 같은 사람이 여러 번 죽으면 시체도 여러 구가 남는다. */
  readonly id: string;
  /** 주인의 PeerId (싱글은 `'sp'`). */
  readonly ownerId: string;
  readonly ownerName: string;
  readonly position: THREE.Vector3;
  readonly yaw: number;
  /** `ctx.missionTime` 기준 사망 시각. */
  readonly diedAt: number;
  /** 남은 아이템이 하나도 없으면 true (프롬프트가 `비어 있음` 으로 바뀐다). */
  readonly emptied: boolean;
}

export interface CorpsesRef {
  getCorpses(): readonly PlayerCorpse[];
  get(id: string): PlayerCorpse | null;
  /** 이 사람의 가장 최근 시체 (구조선 대상 목록이 위치를 표시할 때 쓴다). */
  latestOf(ownerId: string): PlayerCorpse | null;
}

/* ── 구조선 투하 (owner: stratagems/parts/Rescue) ─────────────────────────────────────────────────────── */
/** 구조선 호출 화면에 뜨는 분대원 한 칸. */
export interface RescueCandidate {
  readonly peerId: string;
  readonly name: string;
  readonly slot: number;
  /** 죽어 있어서 고를 수 있는가. 살아 있거나 전투불능이면 false (칸은 뜨지만 비활성). */
  readonly selectable: boolean;
  /** 죽어 있으면 그 시체의 위치, 아니면 null. */
  readonly corpse: THREE.Vector3 | null;
}

export interface StratagemsRef {
  /* ── appended (2026-09-09): 구조선 ── */
  /** 남은 구조선 횟수 (분대 공용). 레이드 시작 시 `RESCUE_DROPS_PER_RAID`. */
  readonly rescueLeft: number;
  /** 구조선 호출이 지금 가능한가 = 남은 횟수 > 0 이고 죽어 있는 분대원이 하나라도 있다. */
  readonly rescueAvailable: boolean;
  /** 분대원 4칸 (죽은 사람만 `selectable`). 구조선 선택 화면이 이걸 그린다. */
  getRescueCandidates(): readonly RescueCandidate[];
  /** 지금 선택 화면에서 고른 대상, 없으면 null. */
  readonly rescueTarget: string | null;
}

export interface InventoryRef {
  /* ── appended (2026-09-09): 시체 루팅 ── */
  /**
   * **사망 시점의 전부** — 장비 슬롯 · 임플란트 칸 · 가방 · 퀵슬롯의 아이템을 하나의 목록으로 뽑고
   * 로컬 인벤토리를 **비운다**. 시체 컨테이너를 채우는 유일한 입구이고, 사망 처리에서 한 번만 불린다.
   */
  stripForCorpse(): ItemInstance[];
  /**
   * `openContainerItems` 와 같지만 격자 크기를 지정한다 (시체는 `PLAYER_CORPSE_COLS × PLAYER_CORPSE_ROWS`).
   * 이미 알고 있는 id 면 `items` · 크기 모두 무시하고 남은 내용물을 보여 준다.
   */
  openContainerItemsSized(containerId: string, items: ItemInstance[], position: THREE.Vector3,
    cols: number, rows: number, title?: string): void;
}

/* ══ appended: 2026-09-09 — 레이드 플레이 개선 (구조물 · 선로 · 환경 재해 · 로그 강하 · 의사소통) ═════════════
 * 계약은 **추가만** 한다. 소유 폴더는 각 절의 머리에 적었다.
 * 관련 문서: docs/DECISIONS.md 의 `2026-09-09 레이드 플레이 개선`.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/* ── 사각 콜라이더 · 함께 움직이는 발판 (owner: world) ─────────────────────────────────────────────────── */
export interface Obstacle {
  /**
   * **사각(OBB) 콜라이더.** 주면 `radius` 원 대신 이 상자로 밀어내고 레이를 맞춘다 — 건물 벽 · 전차 차체처럼
   * 원기둥으로는 거짓말이 되는 것들을 위해 2026-09-09 에 추가했다. `radius` 는 **여전히 채워 둔다**:
   * `SpatialHash` 버킷팅과 광역 질의(`getObstaclesNear` · `obstacleCoverage`)가 그 외접원을 쓴다
   * (`radius >= hypot(halfX, halfZ)` 여야 질의가 상자를 놓치지 않는다).
   * `yaw` 는 Y축 회전(rad)이고 `halfX` / `halfZ` 는 회전 **전** 로컬 축의 반길이다.
   */
  box?: { halfX: number; halfZ: number; yaw: number };
  /**
   * 이 장애물 **윗면에 서 있는 동안** 함께 실려 가는 속도(m/s, 월드 좌표). 전차 · 움직이는 발판이 채운다.
   * `WorldRef.getStandingObstacle` 로 밟고 있는 장애물을 찾은 쪽(플레이어 · 적 · 시체)이 자기 위치에 더한다.
   * 없거나 0 벡터면 고정 발판이다.
   */
  velocity?: THREE.Vector3;
}

/* ── 버려진 구조물 (owner: world/Structures) ──────────────────────────────────────────────────────────── */
/**
 * 행성 구역마다 무작위로 놓이는 **들어갈 수 있는** 폐건물. 안에 상호작용 컨테이너가 밀집해 있고,
 * `outpost` / `lab` 은 지하실을 가질 수 있다 — 지하실 문은 **항상 잠겨 있고** 그 구조물의 지상층 컨테이너
 * 어딘가에 키카드가 **정확히 하나** 들어 있다.
 */
export type StructureKind = 'outpost' | 'lab' | 'wreck';
export const STRUCTURE_KINDS: readonly StructureKind[] = ['outpost', 'lab', 'wreck'];
export const STRUCTURE_LABEL_KO: Readonly<Record<StructureKind, string>> = {
  outpost: '버려진 전진기지', lab: '버려진 연구실', wreck: '불시착한 함선',
};

export interface StructureDef {
  /** `struct_<kind>_<n>` — 시드 결정적이므로 모든 클라이언트에서 같다. */
  id: string;
  kind: StructureKind;
  /** 지상층 바닥 중심 (y = 바닥 높이). */
  position: THREE.Vector3;
  yaw: number;
  /** 지도 마커 · 스폰 회피 · 로그 강하 목표가 쓰는 대략 반경(m). */
  radius: number;
  /** 지하실이 있는가. */
  hasBasement: boolean;
  /** 지하실 잠금문의 위치. `hasBasement` 가 false 면 null. */
  basementDoor: THREE.Vector3 | null;
  /** 키카드로 지하실 문이 열렸는가 (호스트 권위, `struct unlocked` 로 전파). */
  unlocked: boolean;
  /** 이 구조물의 컴퓨터로 **행성 스캔**을 이미 돌렸는가 (구조물당 1회). */
  scanned: boolean;
  /** 이 구조물에서 로그 강하가 이미 일어났는가 — **구역당 1회**라는 규칙의 저장소. */
  rogueDropUsed: boolean;
}

/* ── 선로 · 플랫폼 · 전차 (owner: world/Rails) ─────────────────────────────────────────────────────────── */
/** `loop` = 구역 외곽을 두르는 순환 선로, `line` = 구역을 가로/세로로 가로지르는 왕복 직선 선로. */
export type RailKind = 'loop' | 'line';
export const RAIL_LABEL_KO: Readonly<Record<RailKind, string>> = { loop: '순환 선로', line: '반복 선로' };

/** 선로 끝(또는 순환 선로 한 곳)의 플랫폼 — 그 자체가 파밍 장소다. */
export interface RailPlatformDef {
  id: string;
  position: THREE.Vector3;
  yaw: number;
  /** 플랫폼 데크의 대략 반경(m). */
  radius: number;
}

export interface RailLineDef {
  /** `rail_<n>`. */
  id: string;
  kind: RailKind;
  /**
   * 선로 중심선의 지점들 (y = 레일 상면 높이). `loop` 이면 마지막 → 첫 지점이 이어지는 **닫힌 고리**이고
   * `line` 이면 열린 꺾은선이라 전차가 끝에서 방향을 뒤집는다.
   */
  points: readonly THREE.Vector3[];
  /** 중심선 전체 길이(m) — `loop` 은 닫는 구간을 포함한다. */
  length: number;
  platforms: readonly RailPlatformDef[];
}

/** 전차의 상태. `idle` = 시동 전, `moving` = 주행, `docked` = 플랫폼 정차 중. */
export type TramState = 'idle' | 'moving' | 'docked';
/** 와이어 순서 (`tram state.st` 가 이 배열의 인덱스다). 재정렬 금지. */
export const TRAM_STATES: readonly TramState[] = ['idle', 'moving', 'docked'];

export interface TramDef {
  /** `tram_<lineId>`. 선로 하나에 전차 하나. */
  id: string;
  lineId: string;
  /** 차체 중심 (y = 데크 높이). 호스트가 굴리고 클라이언트는 보간한다. */
  position: THREE.Vector3;
  yaw: number;
  state: TramState;
  /** 선로 위 진행 거리(m). **호스트 권위** — 이 값 하나가 전차의 진짜 상태다. */
  s: number;
  /** 진행 방향 (+1 / −1). `loop` 은 언제나 +1. */
  dir: 1 | -1;
}

/* ── 환경 재해 (owner: world/Hazard) ───────────────────────────────────────────────────────────────────── */
/**
 * 레이드 시작 뒤 `HAZARD_START_MIN_S`–`HAZARD_START_MAX_S` 사이 **30초 단위**의 한 시각에 시작해 맵을
 * 서서히 덮는 행성 현상. 후보는 행성마다 정해져 있고(`data/planets.csv` 의 `hazards` 열) 그중 하나를
 * **레이드마다** 미션 시드로 뽑는다 — 와이어가 필요 없다. 범위 안에 있으면 초당 `HAZARD_DPS` 피해를 입고
 * 시야가 좁아지며, 끝까지 진행하면 안전지대가 사라져 사실상 강제 탈출이 된다.
 *
 * **함선이 관측하는 현상이므로 전장의 안개에 가려지지 않는다** — 지도는 안개 레이어 **위에** 그린다.
 */
export type HazardKind = 'sandstorm' | 'blizzard' | 'storm_eye' | 'spores';
export const HAZARD_KINDS: readonly HazardKind[] = ['sandstorm', 'blizzard', 'storm_eye', 'spores'];
export const HAZARD_LABEL_KO: Readonly<Record<HazardKind, string>> = {
  sandstorm: '모래 폭풍', blizzard: '눈보라', storm_eye: '폭풍의 눈', spores: '독성 포자',
};

/** 위험/안전 구역 한 덩어리. 지도 · HUD · `isInside` 가 모두 이 도형만 본다. */
export interface HazardZone {
  id: string;
  /**
   * `front` = 반평면(가로로 넓게 차오르는 벽). 전선은 `center` 를 지나고 법선이 `(dirX, dirZ)` 이며
   * **이미 지나온 쪽**(법선의 반대편)이 위험하다. `circle` = 원.
   */
  shape: 'front' | 'circle';
  center: { x: number; z: number };
  /** `circle` 의 반경(m). `front` 에서는 0. */
  radius: number;
  /** `front` 진행 방향의 단위 벡터. `circle` 에서는 (0, 0). */
  dirX: number;
  dirZ: number;
  /** `circle` 만: true = 원 **안이 안전**하고 바깥이 위험 (폭풍의 눈). false = 원 안이 위험 (독성 포자). */
  safeInside: boolean;
}

/** 독성 포자가 피어오를 자리 — 지형의 **거대 버섯 군락**. 안개를 걷어 발견한 것만 `discovered` 다. */
export interface HazardSource {
  id: string;
  position: THREE.Vector3;
  /** 이 발생지가 최종적으로 덮을 반경(m). */
  radius: number;
  /** 이미 피어오르기 시작했는가. */
  erupted: boolean;
  /** 안개가 걷혀 플레이어가 아는 자리인가 (`FogRef.isDiscovered`). 지도는 이것만 그린다. */
  discovered: boolean;
}

export interface HazardRef {
  /** 이번 레이드의 재해. 후보가 없는 행성(또는 훈련장)이면 null. */
  readonly kind: HazardKind | null;
  /** 시작 시각 (`ctx.missionTime` 초). 재해가 없으면 −1. */
  readonly startsAt: number;
  /** 예고 방송이 이미 나갔는가 (`HAZARD_WARN_S` 전). */
  readonly announced: boolean;
  /** 지금 진행 중인가 (`missionTime >= startsAt`). */
  readonly active: boolean;
  /** 0..1 — 1 이면 맵을 다 덮었다 (안전지대 없음). */
  readonly progress: number;
  /** 이 지점이 지금 **피해 구역** 안인가. 매 프레임 불려도 되는 싼 질의다. */
  isInside(x: number, z: number): boolean;
  /** 지도 · HUD 가 그릴 도형. 내부 배열을 재사용하므로 **읽고 바로 쓴다** (보관 금지). */
  getZones(): readonly HazardZone[];
  /** 독성 포자 발생지. 다른 재해는 빈 배열. */
  getSources(): readonly HazardSource[];
  /** 늦게 합류한 클라이언트용 (호스트만 만든다). `HazardMessage 'sync'` 가 실어 나른다. */
  serialize(): string;
  applySerialized(data: string): void;
}

/* ── 위 셋을 묶는 world 접근자 ─────────────────────────────────────────────────────────────────────────── */
export interface WorldRef {
  /* ── appended (2026-09-09): 레이드 플레이 개선 ── */
  /** 이번 맵의 버려진 구조물 전부 (훈련장은 빈 배열). */
  getStructures(): readonly StructureDef[];
  /** `(x, z)` 를 품는 구조물(자기 `radius` 안), 없으면 null. */
  structureAt(x: number, z: number): StructureDef | null;
  /** 이번 맵의 선로 (없을 수도 있다 — 구역마다 무작위). */
  getRailLines(): readonly RailLineDef[];
  /** 선로 위의 전차 (선로 하나당 하나). */
  getTrams(): readonly TramDef[];
  /** 이번 레이드의 환경 재해. 후보가 없는 행성 · 훈련장이면 null. */
  readonly hazard: HazardRef | null;
}

/* ── 행성별 무기 등급 드롭 (owner: items/Loot) ─────────────────────────────────────────────────────────── */
export interface LootRef {
  /**
   * appended (2026-09-09): 상자에서 나온 **무기의 등급**은 행성이 정한다 (`data/planet_loot.csv`).
   * 그 행성의 등급 곡선으로 무기를 다시 등급 매기고, 곡선이 0 인 등급은 아예 나오지 않는다
   * (앞쪽 행성에서 IV · V 가 봉인되는 이유). `planet` 이 null 이면 예전 그대로 상자 티어의 희귀도 가중치를 쓴다.
   *
   * `rollCrate(tier, rng)` 는 그대로 남아 있고 `rollCrateOn(tier, rng, null)` 과 같은 결과를 준다.
   */
  rollCrateOn(tier: number, rng: Random, planet: PlanetId | null): ItemInstance[];
  /**
   * appended (2026-09-09): 시체(로그 · 보스)가 떨구는 무기의 등급도 같은 곡선으로 **상한**을 받는다.
   * `planet` 이 null 이면 `rollCorpse` 와 완전히 같다.
   */
  rollCorpseOn(type: EnemyType, rng: Random, rogueWeaponId: string | undefined, planet: PlanetId | null): ItemInstance[];
}

/* ── 로그 강하 (owner: enemies/RogueDrop) ──────────────────────────────────────────────────────────────── */
/** 진행 중인 로그 강하 한 건. */
export interface RogueDropView {
  readonly id: string;
  readonly position: THREE.Vector3;
  /** 몇 명이 내리는가. */
  readonly count: number;
  /** 보스(로그 분대장)가 섞여 있는가. */
  readonly boss: boolean;
  /** `ctx.time` 기준 착지 시각. */
  readonly landsAt: number;
}

export interface EnemyManagerRef {
  /* ── appended (2026-09-09): 로그 강하 ── */
  /**
   * **호스트 전용.** `position` 주위에 로그 분대를 강하시킨다 (경고 → `ROGUE_DROP_ETA_S` 뒤 착지 → 진격).
   * 인원과 보스 여부는 **분대 인원**에서 정해진다 (`ROGUE_DROP_*` 상수) — 호출자가 정하지 않는다.
   * 이미 같은 `dropId` 가 진행 중이거나 호스트가 아니면 false.
   */
  callRogueDrop(dropId: string, position: THREE.Vector3): boolean;
  /** 진행 중인 강하 (HUD 경고 · 오프스크린 화살표용). */
  getRogueDrops(): readonly RogueDropView[];
}
