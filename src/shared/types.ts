import type * as THREE from 'three';
import type { Random } from './Random';
import type { GameContext } from './GameContext';
import type { ArmorDef, CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, WeightInfo } from './gear';
import type { LoadoutPreset, WorkbenchKind } from './housing';
import type { SkillId } from './progression';
/* appended (Phase 11, 2026-09-07): planet selection */
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
 * 2026-09-09 (raid play improvements): `help` / `abandon` are the **downed** variant of the same left/right hold gesture —
 * while the local player is DOWNED the `지역 핑` wheel shows `살려줘` / `나를 버려` instead of `여기 조심해` / `저쪽으로 가자`.
 * `structure` = an abandoned structure, `rail` = rails · platforms · trams (aim-assist snaps onto them like a crate does).
 */
export type PingKind =
  | 'ground' | 'enemy' | 'crate' | 'extraction' | 'item' | 'attack' | 'caution'
  | 'help' | 'abandon' | 'structure' | 'rail';

/** Chat line categories (owner: ui/hud/ChatLog). */
/** `whisper` appended (Phase 11): a direct message, rendered with a → id prefix and never relayed to the squad. */
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
  /* 2026-09-15 (user's decision): `'grenade'` retired — the two grenades are `category: 'gadget'` and `ItemDef.grenade` is what tells a grenade apart. */
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
  | 'seed'        // a seed planted in a greenhouse grow plot (see `ItemDef.seed`); loot + corp shop, never craftable
  /* appended: Phase 9 (2026-09-06) */
  | 'book'        // a book shelved on a library bookcase (see `ItemDef.book`): raises one skill's XP gain; loot + corp shop, never craftable
  /* appended: 2026-09-08 */
  | 'implant'     // an implant (a stat-granting equippable, see `ItemDef.implant`): equipped on the 캐릭터 tab, 세레스 바이오 sells / repairs them, broken ones are raid loot
  /* appended: greenhouse rework (2026-09-11) */
  | 'soil'        // soil (see `ItemDef.soil`): poured into a grow station's plot before a seed goes in; gathered per biome only, never craftable
  | 'crop'        // a crop: harvested from a grow plot. Since 2026-09-11 A-3c it is a cook-bench material (the fourth consumer, beside selling · delivery · the extractor)
  /* appended: the lab (A-12 · A-13, 2026-09-11) */
  | 'sample'      // an unidentified sample (see `ItemDef.sample`): put into the analyzer and it is read after that much real time. Raid only — no craft, no shop
  | 'prep'        // a preparation (see `ItemDef.prep`): used in the ship it loads as **one charge for the next raid** (it cancels the planet environment)
  /* appended: kitchen · printer (A-3c · A-15, 2026-09-11) */
  | 'meal'        // a meal (see `ItemDef.meal`): eaten at the ship's dining table it loads as **one charge for the next raid** (it raises one derived stat)
  | 'pouch'       // a pouch (see `ItemDef.pouch`): fitted into the one `pouch` equipment slot it opens its own grid under the quick slots
  | 'key'         // a key — a structure basement keycard and the like. Split off from `valuable` on 2026-09-11: a key pouch must not mix with valuables
  /* appended: video games (2026-09-13, `src/housing/README.md` Decisions) */
  | 'game_disc'   // a game disc (see `ItemDef.gameDisc`): slotted into the game-disc rack it is played on the TV (intelligence · perception training). Drop only
  | 'console'     // a games console (see `ItemDef.gameConsole`): mounted on the TV. 3D-printer craft + a rare drop
  /* appended: library media (A-3e, 2026-09-12) */
  | 'disc'        // a disc (see `ItemDef.disc`): slotted into the library disc rack — the same role as a book and a little stronger. loot + corp shop, never craftable
  /* appended: cooking material tiers (2026-09-13) — a socket (see `ItemDef.growSocket`): a permanent upgrade fitted into poured soil · a medium. Only the analyzer reading unidentified DNA yields one */
  | 'socket'
  | 'record';     // a record (see `ItemDef.record`): slotted into the library record rack — a little stronger than a disc. loot + corp shop, never craftable

/**
 * Item rarity. **Six steps** — `'mythic'` was added above legendary on 2026-09-16 (user's decision).
 * Mythic is **never rolled by a drop table**: only the 6 unique weapons · the 3 trait armors · mythic samples/minerals
 * are mythic (`RARITY_ORDER_LOOT` in `src/items/LootTables.ts` cuts the roll at 5 steps, so a mythic weight written
 *  into a new table is still not rolled — putting mythic into drops means fixing that constant first).
 * Wherever `Record<Rarity, …>` is used, the matching table in `data/tables.csv` must have a mythic row.
 */
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

/**
 * An item's **super category** (2026-09-16, user's decision). One axis laid over `ItemCategory`; it changes no category —
 * the tooltip's kind line reads in two steps like 「수집품 > 서적」, and a quest · contract objective can ask in units of 「수집품」.
 * The mapping and the labels live in exactly one place: `SUPER_CATEGORY_OF` · `SUPER_CATEGORY_LABEL_KO` in `src/shared/labels.ts`.
 * A category with no super category (primary weapon · ammo …) gets `null` from `superCategoryOf` and its kind line stays one step.
 */
export type SuperCategory = 'collectible';

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
/**
 * Equipment slots. `primary` = 주무기 I (key 1), `primary2` = 주무기 II (key 2), `secondary` = 보조무기 (key 3),
 * `bag` = 가방, `armor` = 방탄복.
 *
 * appended (2026-09-11, A-15): `pouch` = the pouch slot, **one cell** (user's decision: fixed at 1). Fitting one opens
 * that pouch's grid under the quick slots — a container of its own, not the bag (`ItemDef.pouch`).
 */
export type LoadoutSlot = 'primary' | 'primary2' | 'secondary' | 'bag' | 'armor' | 'pouch';
export type WeaponSlot = Exclude<LoadoutSlot, 'bag' | 'armor' | 'pouch'>;

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
  /* ── appended 2026-09-14: gun balance (owner: items) ── */
  /** ADS sway multiplier (stock · grip). Folds into `EffectiveWeaponStats.swayMul`. */
  sway?: number;
  /** Multiplier on `falloffStart` / `falloffEnd` (확장 총열 > 1 = damage holds further). */
  falloffRange?: number;
  /** Multiplier on the damage *lost* at `falloffEnd` (`1 − falloffMin`); < 1 = gentler falloff. */
  falloffLoss?: number;
  /** Multiplier on `EffectiveWeaponStats.bulletGravity` (확장 총열 < 1 = less drop). */
  bulletDrop?: number;
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
  /* ── appended 2026-09-14: gun balance · projectile ballistics (owner: items computes, weapons consumes) ── */
  /** Sockets this weapon accepts, in `SOCKET_SLOTS` order (SG = muzzle · mag · sight …). Pips / tooltips / `canAttach` read it. */
  sockets: readonly SocketSlot[];
  /** Multiplier on the class ADS sway amplitude (`data/aim_sway.csv`) — grade handling × stock / grip. 1 = table value. */
  swayMul: number;
  /** Effective damage falloff after sockets (m, m, 0..1). `falloffStart >= falloffEnd` with min 1 = no falloff. */
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  /** Bullet muzzle velocity (m/s). 0 = hitscan (uniques that keep their own path). */
  projectileSpeed: number;
  /** Downward acceleration on the bullet (m/s²), after sockets. 0 = dead straight. */
  bulletGravity: number;
  /** Sustained-fire bloom: added per shot (bloom clamps to 0..1), and spread × (1 + bloom × bloomSpread). */
  bloomPerShot: number;
  bloomSpread: number;
  /** Bloom recovered per second (per class — slow pump / bolt guns recover slowly so rapid follow-ups spread). */
  bloomDecay: number;
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
  /* ── appended 2026-09-14: gun balance (owner: items data) ── */
  /** Sockets this class accepts; undefined → every `SOCKET_SLOTS` entry. */
  sockets?: readonly SocketSlot[];
  /** Bullet drop (m/s²) for the class; undefined → 0. */
  bulletGravity?: number;
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
  /** category 'seed': what it grows into in a greenhouse grow plot and how long that takes in **real** hours. */
  seed?: SeedDef;
  /* ── appended: Phase 9 (2026-09-06, owner: items) ── */
  /** category 'book': which skill the book teaches when shelved in a library bookcase (`BOOK_RARITY_MUL[rarity]` weight). */
  book?: BookDef;
  /* ── appended: healing item rework (2026-09-07, owner: items) ── */
  /** category 'stim': how long it takes to use, how much it heals, and (스프레이) how it channels. */
  heal?: HealDef;
  /* ── appended: greenhouse rework (2026-09-11, owner: items) ── */
  /** category 'soil': which tag it carries and how many harvests it survives. */
  soil?: SoilDef;
  /* ── appended: 2026-09-15 (gadget rework, owner: items) ── */
  /**
   * Is this item a grenade — **the only value that tells a grenade apart** (the `grenade` column of `items.csv`).
   * When `'grenade'` was retired from `ItemCategory` on 2026-09-15 (user's decision), every site that read
   * `category === 'grenade'` moved to this field — a grenade is `category: 'gadget'` now, so the category cannot split them.
   * `grenadeFire` stays as another way of saying `grenade === 'fire'` (it is contract, so it was not deleted, and the loader fills both).
   */
  grenade?: GrenadeKind;
  /**
   * Seconds LMB must be held **before the gadget is used or placed** (the `gadgetUseTime` column of `items.csv`).
   * `weapons/model.useTimeOf(def)` reads it in the **same hold frame** as healing items · shield chargers · combat
   * consumables — before it every gadget was 0, and that is what 「the barricade placement time does not apply」 really was (only picking one back up took time).
   * Left empty the defibrillator gets `DEFIB_USE_TIME_S` and everything else 0.
   */
  gadgetUseTime?: number;
}

/**
 * Kind of grenade (`ItemDef.grenade`). The value `items/LootTables.rollCorpseOn(…, { grenades: { kind } })` was already
 * using, raised to contract on 2026-09-15 — `'frag'` = 파편 수류탄 (high explosive), `'fire'` = 화염 수류탄 (a small blast + a fire zone).
 */
export type GrenadeKind = 'frag' | 'fire';

/**
 * Soil tags (2026-09-11). Four tags, one per gathering biome — `world/` drops the tag's soil on that planet,
 * `data/seeds.csv` names the tag each seed wants. Matching soil grows `SOIL_MATCH_SPEEDUP` faster, a mismatch
 * `SOIL_MISMATCH_PENALTY` slower; there is no "no soil" case because a grow-plot cell must be filled before it takes a seed.
 */
/* appended (more varieties, A-11, 2026-09-11): `saline` 염류 · `spore` 포자 — the two tags the new varieties want. Widening
 * the tag list costs this line · `SOIL_TAG_LABEL_KO` · `SOIL_TAG_COLOR` · the `soil_*` rows of `data/items.csv` · the
 * `soils` weights of `data/planets.csv`, and nothing else (the greenhouse rework was designed that way). */
export type SoilTag = 'ash' | 'frost' | 'humus' | 'mineral' | 'saline' | 'spore';
export const SOIL_TAGS: readonly SoilTag[] = ['ash', 'frost', 'humus', 'mineral', 'saline', 'spore'];

/**
 * Soil data (2026-09-11). `uses` is how many harvests one poured unit survives (`SOIL_USES_BY_RARITY`: 일반 2 ·
 * 고급 3 · 희귀 5) — the count lives on the plot (`GrowSlot.soilUsesLeft`), not on the item, so a poured soil is
 * spent even if the item stack it came from is gone.
 */
export interface SoilDef {
  tag: SoilTag;
  /** Harvests one poured unit survives before the cell goes back to 비어 있음. */
  uses: number;
}

/**
 * Healing consumables (2026-09-07). `weapons` holds LMB for `useTime` (moving at `CONSUMABLE_SLOW_MUL` speed), then
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

/** Book data (Phase 9). One book per skill; rarity decides its weight in `HousingRef.getBookBonus`. */
export interface BookDef {
  skill: SkillId;
}

/** Seed growth data. `growHours` is wall-clock time and keeps running while the game is closed. */
export interface SeedDef {
  /** Real hours from planting to harvest, before the 원예 speed-up (`GROW_SKILL_SPEEDUP`). */
  growHours: number;
  /** Item def harvested from a ripe plot. */
  yieldDefId: string;
  /** Units per plot, before `derived.gatherYieldMul`. */
  yieldQty: number;
  /* ── appended: greenhouse rework (2026-09-11) ── */
  /**
   * The soil tag this seed wants. The grow-plot cell it goes into is already filled with some soil: the same tag grows it
   * `SOIL_MATCH_SPEEDUP` faster, any other tag `SOIL_MISMATCH_PENALTY` slower. Required — every row of
   * `data/seeds.csv` names one.
   */
  soilTag: SoilTag;
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
  /**
   * appended (2026-09-11, A-15): the equipped pouch (`ItemDef.pouch`). It is optional for the same reason `armor` is —
   * saved loadouts · crew cards · presets are written without this slot. Fitting one opens its grid under the quick slots.
   */
  pouch?: ItemInstance | null;
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
   * **2026-09-09 — the wheel is its own container** (user's decision): an entry is the stack *itself*, which is therefore
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
  /** `targetUid` appended (2026-09-08): the exact stack a salvage consumes first (item right-click → 분해). */
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
   * appended 2026-09-16: the bench the craft column is showing right now (null = the plain 제작 panel / no craft
   * column). It is how another folder tells "this screen is a **workbench** window" apart from the Tab inventory —
   * `housing`'s 업그레이드 modal reads it to know whether the header button means the 창고 or that bench.
   */
  getBench?(): { kind: WorkbenchKind; level: number } | null;
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
  /* ── appended (2026-09-14): launch slot readiness (`src/meta/README.md` Decisions) ── */
  /**
   * Has the local player **confirmed readiness** in a launch slot (the 1 s space hold plus the launch warning accepted).
   * Merely **boarding** the pod is false — boarding and readiness split apart on 2026-09-14.
   * `inventory/` reads it and locks the stash · equipment · bag **read-only** (user's decision: no loadout change while ready).
   * It is optional because on a screen with no hub (title · raid) `ctx.hub` itself is null.
   */
  readonly launchReady?: boolean;
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

/**
 * appended (2026-09-18, user's decision 「bug eggs become destructible enemies」): one egg spot at the foot of a nest.
 *
 * The spot is decided by `world/Nests` (the very spot the decorative mesh used to stand on), and standing a `bug_egg`
 * there is the authority's job (`enemies/`). `nest` is the index of the nest the egg belongs to — per-nest respawn and the leash are keyed by it.
 */
export interface NestEggSpot {
  position: THREE.Vector3;
  /**
   * The index of the **nest (pad)** this egg belongs to — per-nest respawn and the leash are keyed by this number.
   *
   * ⚠ It is **not** an index into `getNestPositions()`. That one lists the 4–6 holes (mounds) of a single nest in a row,
   * while this number points at 「what a person calls one nest」 (the pad of `layout.nests`). `getNestPositions()[nest]`
   * silently returns the wrong hole, so it is never used.
   */
  nest: number;
  /** Egg radius (m) — the size of the **visible egg**, not of the enemy body (hitbox · debris spots). */
  radius: number;
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
  /**
   * appended (2026-09-18, user's decision 「a blast does not pass a window」): the same as `raycast` but a ray
   * that **glass blocks** — `raycast` lets a broken window frame (`Obstacle.passRays`) through, and blast
   * visibility (`shared/explosion.blastReachesBody`) using that as it is becomes 「standing inside a building and
   * being hurt by a bombardment beyond the window」. The test is the collider's **kind** (glass), not `passRays` —
   * the tutorial's ghost fence band is `passRays` too, and blocking that as well would turn low cover into a shield.
   * Low cover is unchanged by this ray (it was never `passRays`) — the head of the three body points clears it,
   * so 「a peeker over cover gets hit」 still holds.
   */
  raycastBlast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): TerrainHit | null;
  getObstacles(): readonly Obstacle[];
  getObstaclesNear(x: number, z: number, radius: number): Obstacle[];
  getPlayerSpawn(): THREE.Vector3;
  getExtractionPoints(): readonly ExtractionPointDef[];
  getCrates(): readonly CrateDef[];
  /** Random enemy spawn positions on walkable terrain within [minDist, maxDist] of `around`. */
  getEnemySpawnPoints(around: THREE.Vector3, count: number, minDist: number, maxDist: number): THREE.Vector3[];
  /** Bug nests / hives placed by the world; enemies may spawn from them. */
  getNestPositions(): readonly THREE.Vector3[];
  /**
   * appended (2026-09-18, user's decision 「bug eggs」): the **egg spots** at the foot of a bug nest. The eggs that
   * were decoration became destructible, immobile enemies (`bug_egg`), so the owner of where they stand is still
   * `world/Nests` and standing the enemy there is the authority's (`enemies/`). Empty outside a planet (training range · tutorial).
   */
  getNestEggSpots(): readonly NestEggSpot[];
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
  /**
   * Item def id produced (an 'herb' category item, or `mat_scrap` for a `kind: 'salvage'` node). 2026-09-11 (C-20):
   * a 고철 더미 may **also** hand over a bonus 구동 코어 decided at generation (seeded, csv chance) — that bonus is
   * world-internal and not in this def; the harvest still emits one `gather:collected` (one XP).
   */
  defId: string;
  /** Units produced before the gardening multiplier. */
  qty: number;
  harvested: boolean;
  /* appended (2026-09-08): scrap-metal supply — the 고철 node */
  /**
   * What the node is. undefined / 'herb' = the 약초 plant (원예 XP, 채집 prompt); 'salvage' = a 고철 더미 at a
   * wreck, yielding `mat_scrap` (+ a chance of a bonus core, C-20) with a 해체 prompt and 제작 XP. Both share the
   * placement / net / interact code.
   */
  kind?: GatherNodeKind;
}

/**
 * `GatherNodeDef.kind` (2026-09-08). appended (greenhouse rework, 2026-09-11): `'soil'` — a 토양 더미. One soil tag
 * per planet (the `soils` column of `data/planets.csv`), so which soil tag you can farm is a reason to pick a planet.
 * Shares the placement / net / interact code with the other two; yields a `category: 'soil'` item and 원예 XP.
 */
/* appended (A-11 · A-12, 2026-09-11): `'seed'` a 야생 씨앗 군락 — a different variety per planet (`seeds` · `seedNodes`
 * of `data/planets.csv`); `'sample'` a 미확인 표본 — something for the analyzer to read (`samples` · `sampleNodes`). Both
 * ride the **same** placement · net · interaction code as the soil pile, each on its own rng fork so neither shifts the other's placement. */
/* appended (2026-09-16, user's decision — planet ore veins): `'mineral'` an ore vein. Mining it yields only
 * **unidentified minerals** and the skill is not 원예 but **채광** — that is why this value stands on its own. It hands
 * out a sample, but left as `'sample'` `gather:collected` would pay 원예 XP. Its placement · net · interaction code is exactly the other four's. */
export type GatherNodeKind = 'herb' | 'salvage' | 'soil' | 'seed' | 'sample' | 'mineral';

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
/** 2026-09-09: `rescue_drop` added. `airstrike` dropped out of `STRATAGEM_ORDER`, but its type and def stay. */
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
  /** `source` appended (2026-09-15): who · what hit — the result screen's death cause and the damage taken per cause (`PlayerDamageSource`). Omitted = unknown. */
  /**
   * 2026-09-15 (user's decision — toxic spores): the fourth argument `opts.bypassShield` skips the shield and takes **hp only**.
   * It extends to hazards the reason behind `PLANET_ENV_DPS` (2026-09-11 A-13): armor stopping the atmosphere makes no sense.
   */
  takeDamage(amount: number, from?: THREE.Vector3, source?: PlayerDamageSource, opts?: PlayerDamageOptions): void;
  heal(amount: number): void;
  /** Teleport & reset (used at mission start). */
  respawnAt(position: THREE.Vector3, yaw?: number): void;
  /**
   * Player physically inside the extraction ship; movement constrained to this box (world space).
   * The bounds object is **held by reference** and its owner rewrites it every frame (the ship moves) — never pass a snapshot.
   */
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
  /**
   * Cutscene camera (docking, launch): blends to `pos` looking at `lookAt`; null releases back to the rig.
   * 2026-09-11: `setCameraOverride(null, undefined, true)` = **hard cut** back to the rig (returning from the drone view — a slow blend
   * would sweep the camera through terrain from a distant drone). Plain `null` still blends out as before.
   */
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
   * Downed: hp reached 0 but the player is not dead yet — crawling prone, no weapons, a separate `downHp`
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
  /**
   * true while an overcharge beam is buffing this player (speed / fire rate). 2026-09-11 (C-3): set explicitly by
   * `setOvercharged` — no longer inferred from a speed-modifier key.
   */
  readonly isOvercharged: boolean;
  /** Damage reduction currently granted by armor (0..0.9). Read by the HUD. */
  readonly damageReduction: number;
  /** Burning (incendiary / fire zone): applies DoT and suppresses the grit save. */
  /** `source` appended (2026-09-15, result screen rework): what set the fire — it becomes the burn tick's `player:damaged.source` and the death cause. Omitted = unknown. */
  setBurning(dps: number, duration: number, source?: PlayerDamageSource): void;
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
export type EnemyType = 'scavenger' | 'hunter' | 'warrior' | 'spewer' | 'charger' | 'rogue' | 'rogue_boss' | 'artillery' | 'toxic' | 'behemoth'
  /* appended (2026-09-11): the 3 named rogues (`shared/named`) + 로든's scan drone. All faction rogue. */
  | 'rogue_sniper' | 'rogue_hammer' | 'rogue_heavy' | 'rogue_scan_drone'
  /* appended (2026-09-13): humanoid factions by planet threat — android (threat 1) · raider (threat 2–3). The rogue stays `rogue`. */
  | 'android' | 'raider'
  /* appended (2026-09-13): the sandworm — an event boss stuck in the ground that spits bugs and poison (faction bug, `enemies/sandworm`). */
  | 'sandworm'
  /* appended (2026-09-15): the young sandworm — the sandworm of a threat 1 planet. Fixed `SANDWORM_WEAK_HP` hp · body × `SANDWORM_WEAK_SCALE` ·
     eruption radius by the same multiplier · spits scavengers only. The same rig (`models/WormModel`) · the same director. */
  | 'sandworm_weak'
  /* appended (2026-09-14 3rd pass): 4 tutorial-only kinds. Numbers · rig · AI are the **base kind**'s
     (`enemies/EnemyTypes.baseTypeOf` — `tut_bug*` = scavenger · `tut_android*` = android at half hp) as they are, and the
     only difference is a **fixed drop** (`data/loot_corpses.csv` · `loot_corpse_rolls.csv`). They never stand in a
     main-game raid or on the training range (only the lists of `world/tutorial` use these ids). */
  | 'tut_bug_loot' | 'tut_bug' | 'tut_android_loot' | 'tut_android'
  /* appended (2026-09-17): the summoned scavenger an artillery bug calls exactly once in its life — numbers · rig · AI · sound are scavenger's (`enemies/EnemyTypes.baseTypeOf`), drop 0 %. */
  | 'scavenger_summon'
  /* appended (2026-09-18, user's decision 「bug eggs become destructible enemies」): the **bug egg** at the foot of a nest.
     A stationary faction-bug target that never moves · attacks · notices (`enemies/models/EggModel.ts` is its own rig,
     `enemies/NestDirector.ts` stands it on a `WorldRef.getNestEggSpots()` spot). Immune to stagger · knockback, and it
     enters no head count · pressure · artillery-support maths (`Enemy.isCombatant` is false, so every counting site skips it). */
  | 'bug_egg';
/**
 * Factions fight each other on sight (Phase 4). **Every pair of different factions is hostile** (2026-09-13) —
 * `android` · `raider` appended; the named rogues and the scan drone moved to `raider` (type ids unchanged).
 */
export type EnemyFaction = 'bug' | 'rogue' | 'android' | 'raider';

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
  /**
   * `attacker` appended (2026-09-11, remote-mine kill credit): who dealt the damage — `'local'` · a PeerId · `'ai'`.
   * Omitted it is `'local'`, as before. Used when a damage source with an owner of its own, such as a gadget, hands the credit over.
   */
  takeDamage(amount: number, hitPoint?: THREE.Vector3, hitDir?: THREE.Vector3, attacker?: string): void;
  /* appended (Phase 4) */
  readonly faction: EnemyFaction;
  /* appended (unique weapons, 2026-09-06) */
  /** 전소 (incinerated): writhing on the spot, no movement / attacks, still damageable. Set via `applyStatus('incinerated')`. */
  readonly isIncapacitated: boolean;
  /**
   * appended (2026-09-11, C-62): the point on this body's **hitboxes** nearest to `from`, written into `out` and
   * returned. Melee aims its cone at it, so a body that is not standing upright (a prone 로든 — the lying capsule the
   * raycast already uses) is struck where it actually lies. Optional: callers fall back to `position` + `height`.
   */
  nearestBodyPoint?(from: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
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
  /** Radial damage (`shared/explosion`'s two-step falloff + an enemy-only floor of 0.15). Returns kills. */
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
  /**
   * Enemies within `radius` of `pos` (alive only). Used by turrets, scans, explosions and lures.
   *
   * appended (2026-09-18): **props are left out by default** — a `bug_egg` never comes back unless
   * `includeProps` is true. Almost every caller asks this question to pick a target or to decide "is something
   * dangerous here" (turret targeting, mine contact, android engagement, recon reveal, barrier contact), and a nest
   * egg is none of those; making it the **default** is the only way a caller cannot forget. Pass `includeProps: true`
   * from a query whose answer is "everything this blast touches". An egg is still destroyed by bullets, melee,
   * grenades, `applyAreaDamage` / `applyExplosion` and enemy blasts — none of those go through this call.
   */
  queryNear(pos: THREE.Vector3, radius: number, includeProps?: boolean): EnemyRef[];
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
/**
 * `Interactable.kind` (appended 2026-09-11, C-4). Add members, never rename. Unset = unknown (readers use the id prefix).
 * `object` is deliberately **not** on `Interactable` — the mesh outline it would have fed went away with the light-pillar rule.
 */
export type InteractableKind =
  | 'corpse' | 'playerCorpse' | 'crate' | 'container' | 'gather' | 'pickup' | 'deployable' | 'drone'
  | 'extract' | 'revive' | 'console' | 'objective';

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
   * appended (2026-09-11, C-4): what this is, for code that used to guess from the id prefix (`ui/hud/pillar` · 정찰
   * `implants/effects/Scan`). Readers use `kind` first and fall back to the prefix when it is undefined. Set at least on
   * the two corpse kinds — `'corpse'` = an enemy corpse `corpse:<id>`, `'playerCorpse'` = a squadmate corpse `pcorpse:<owner>:<n>`.
   */
  kind?: InteractableKind;
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
   * The units **leave the inventory** (sale / consumption) — moving an item between grids is `quickMove`, not this.
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

  /* ══ appended 2026-09-12: a standalone tile identical to an inventory tile ════════════════ */
  /**
   * A standalone tile that looks exactly like an inventory grid tile — `w × h` footprint at `cell` px (default 54),
   * rarity background, qty badge, durability bar — stamped `data-item-tip` + `data-def-id` so `ui/hud/ItemTip`
   * raises the hover card. No drag, no listeners; the caller positions it. The 기업 거래 desk draws its stock and
   * 구매 / 판매 trays with it so they read the same as the 가방 / 창고 beside them.
   */
  buildItemTile(defId: string, qty: number, opts?: { cell?: number; durability?: number }): HTMLElement;
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
  /* ── appended 2026-09-13 (splitting the corp screen into cards — `inventory/ui/TradeGrids`) ── */
  /** Label of the right-click menu's first entry (what `onTake` does on this screen). Default `빠른 이동`. */
  takeLabel?: string;
  /**
   * `'wrap'`: one scroll box, blocks side by side, wrapping when narrow. `'split'`: every block scrolls itself and
   * stretches to the view's height; a block is exactly as wide as its grid — mount **one** grid per caller card.
   *
   * **Never read** (2026-09-19, B-37): the implementation's root is always `trade-grids is-split`, so passing
   * `'wrap'` changes nothing. It stays because `src/shared` is add-only (CLAUDE.md §4.1) and two callers still pass
   * `'split'` (`meta/ui/CorpView` · `housing/ui/StationShell`) — deleting it would break them for no gain.
   */
  layout?: 'wrap' | 'split';
  /**
   * Filter chips: `'shared'` (one row over all blocks — the `'wrap'` default), `'block'` (each block's own row under its
   * header — the `'split'` default), `'none'` (place a shared row yourself with `TradeGridsView.mountFilterChips`).
   */
  chips?: 'shared' | 'block' | 'none';
}

/**
 * appended 2026-09-13: what `InventoryRef.createTradeGrids` really returns. The ref's signature still says
 * `EmbeddedView` (add-only contract), so narrow first: `typeof (v as Partial<TradeGridsView>).setCell === 'function'`.
 */
export interface TradeGridsView extends EmbeddedView {
  /** Current cell edge in px. */
  readonly cell: number;
  /** Rebuild the grids at a new cell edge (keeps each block's filter and scrolled row). Same edge = no-op. */
  setCell(px: number): void;
  /** Append one chip row that filters every block of the view into `host` (created on first call); returns it. */
  mountFilterChips(host: HTMLElement): HTMLElement;
  /* ── appended 2026-09-16 (user's report 「dragging an equipped item out must put it in the cell the cursor is on」) ── */
  /**
   * An item that is **not in any grid yet** (a shelf's book, a cluster's core, a station's product) released at
   * viewport point `x, y`: put it in the cell under the cursor. The view resolves the cell exactly as a tile drag
   * does (strict containment first, then the half-cell tolerance), so what the player saw highlighted is where it
   * lands — auto-placing into "the first empty cell" was the old behaviour and the bug.
   *
   * Returns the grid it landed in, `'blocked'` when the cursor **was** over a cell that cannot take the item
   * (occupied by something else, out of bounds — nothing is displaced, the caller refuses), or `null` when the
   * cursor was not over a cell at all (the caller falls back to its own destination rule).
   */
  placeExternalAt?(item: ItemInstance, x: number, y: number): 'bag' | 'stash' | 'blocked' | null;
  /* ── appended 2026-09-17 (user's report 「something dragged out of furniture must highlight **the cell under the cursor** too, like a drag from an equipment slot」) ── */
  /**
   * Hover feedback for the same drop `placeExternalAt` would make: highlights the footprint of `defId × qty`
   * (unrotated) in the cell under viewport point `x, y` — `'ok'` (free), `'merge'` (joins that stack) or `'bad'`
   * (would be refused) — exactly like a tile drag inside the view. `null` = not over a cell (no highlight).
   * Call `clearExternalPreview` when the drag ends or leaves.
   */
  previewExternalAt?(defId: string, qty: number, x: number, y: number): 'ok' | 'merge' | 'bad' | null;
  clearExternalPreview?(): void;
}

/* ══ appended: Phase 7 — known follow-ups (2026-09-06) ═══════════════════════════════════════════════════════ */
/**
 * Kind of mission a world is generated for. `'raid'` = the normal planet drop; `'training'` = the 시뮬레이션 훈련장:
 * a small enclosed arena with pop-up targets, no enemies / crates / extraction, entered from the 사격장 sim hub
 * (personal ship) or the shared-ship terminal, left through the arena's exit console (`training:exitRequested`).
 * Ammo / durability spent in a training are restored on exit (game/ captures + re-applies `captureRaidState`).
 *
 * appended (2026-09-14, tutorial rework — `src/tutorial/README.md` Decisions): `'tutorial'` = the hand-built tutorial planet
 * (`world/tutorial/`). It never goes through the procedural generator and has no fog · hazards · crates · gathering · nests.
 * Enemies stand only in fixed spots as fixed kinds, and a death puts you back at a checkpoint (`ctx.world.tutorial` = `TutorialWorldRef`).
 * Unlike the training range it is a **real raid** — loot · XP carry into the profile and extraction takes the usual road.
 */
export type MissionMode = 'raid' | 'training' | 'tutorial';
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
  /**
   * appended (2026-09-10): the shield. Omitted (an old save · an old host) it is restored to **the armor's maximum, not 0** —
   * reading an unknown value as 0 makes only the person who reconnected silently lose their shield.
   */
  shield?: number;
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
  /**
   * appended (2026-09-13, owner: player): instant **full death** — it skips downed and emits `player:died` whatever the shield · hp.
   * A no-op when already dead. The only caller is game/'s voluntary return (`game:returnToShip`).
   */
  die?(): void;
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
  /**
   * appended (2026-09-11): the hand is the slotless **detonator** left after the last remote mine was placed (`heldItemId` stays
   * the C4 def id). gadgets turns the placement preview off while true; ui shows `우클릭 기폭 (n)`.
   */
  detonator?: boolean;
}
export interface WeaponsRef {
  /* ── appended: Phase 7 (owner: weapons) ── */
  readonly remoteState: WeaponRemoteState;
}
/** appended (2026-09-16, the bottom-right weapon panel): one primary slot's magazine readout — the numbers `weapon:ammoChanged` carries. */
export interface WeaponSlotAmmo {
  weaponId: string;
  magSize: number;
  ammoInMag: number;
  reserveRounds: number;
}
export interface WeaponsRef {
  /* ── appended: 2026-09-16 (owner: weapons) — raid HUD weapon panel ── */
  /**
   * The primary slot the gun hand belongs to — held, or drawn down under a quick-use item / implant / melee swing.
   * null when no primary is equipped. The HUD shows this weapon in the big panel even while it is not in hand.
   */
  readonly activeSlot: WeaponSlot | null;
  /**
   * true while that primary is what the player is actually holding: false with a quick-use item (grenade, heal, stim,
   * gadget, detonator) in hand, a melee swing playing, or the gun holstered (wielded implant, downed, ship phases).
   */
  readonly primaryInHand: boolean;
  /** Magazine / reserve of the weapon in `slot`, or null when the slot is empty. Reserve counts the bag (not per frame). */
  ammoOf(slot: WeaponSlot): WeaponSlotAmmo | null;
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
  /**
   * appended (2026-09-13, owner: progression — unconfirmed stat points on the 캐릭터 tab): the host is about to leave this view **because
   * the player asked** (another screen tab, Tab / Escape close). A view with unsaved work returns **true** — it intercepted, the host
   * must stop there — and calls `proceed()` later if the player chooses to go on anyway (e.g. `버리고 이동`). false / omitted = leave
   * now. Forced exits (phase change, death, `openScreen`, …) do not ask: they just `dispose()`, which discards silently.
   */
  requestLeave?(proceed: () => void): boolean;
}

/**
 * Volume channels the settings menu exposes. `sfx` scales gameplay one-shots; `master` scales everything.
 * appended (2026-09-14): `'bgm'` — the channel the music player window of the 축음기 · 주크박스 · 턴테이블 shows. By the user's decision **no sound comes out yet**
 * (no external assets · procedural music unimplemented), so audio/ only creates this channel's GainNode and hangs nothing under it.
 * Once music really goes in it is hung on that node, and settings · saving · UI do not change by a line.
 */
export type AudioChannel = 'master' | 'sfx' | 'bgm';

export interface AudioSettings {
  master: number;
  sfx: number;
  /** appended (2026-09-14). An old save has none, so the reader fills it with `AUDIO_DEFAULT_BGM`. */
  bgm: number;
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
  /**
   * appended (2026-09-14): the tutorial world's checkpoints · fall rules (the same slot · the same convention as `training`).
   * Null outside a tutorial world — fall damage is then always the global rule.
   */
  readonly tutorial: import('./tutorialWorld').TutorialWorldRef | null;
}

/* ══ appended: Phase 10 — UI improvement pass (2026-09-07) ════════════════════════════════════════════════ */

/* ── varied enemy deaths + chance-based looting (owner: enemies) ── */
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
  /* appended (2026-09-11): a named rogue is always searchable, the scan drone is only wreckage */
  rogue_sniper: 1, rogue_hammer: 1, rogue_heavy: 1, rogue_scan_drone: 0,
  /* appended (2026-09-13): androids · raiders are always searchable too */
  android: 1, raider: 1,
  /* appended (2026-09-13): the sandworm is always searchable (boss-grade loot — data/loot_corpses.csv) */
  sandworm: 1,
  /* appended (2026-09-15): the young sandworm is always searchable too (a smaller table — `sandworm_weak` in data/loot_corpses.csv) */
  sandworm_weak: 1,
  /* appended (2026-09-14 3rd pass): tutorial — only the two `_loot` kinds are always searchable (a fixed 100 % drop); the other two are
     **empty corpses** and never open at all (0 = no interactable is registered — quieter than opening an empty grid). */
  tut_bug_loot: 1, tut_android_loot: 1, tut_bug: 0, tut_android: 0,
  /* appended (2026-09-17): the artillery bug's summoned scavenger — drop 0 % (no search is registered at all, an empty corpse like `tut_bug`) */
  scavenger_summon: 0,
  /* appended (2026-09-18): the bug egg — a broken egg is **always searchable**. Since the crate ring around a nest went away the eggs
     are the nest's reward (`data/loot_corpses.csv` 생체 조직 · `loot_corpse_samples.csv` 미확인 세포) */
  bug_egg: 1,
};

export interface EnemyRef {
  /** The direction this body fell; undefined while alive. */
  readonly deathDir?: EnemyDeathDir;
  /** false when this corpse rolled un-searchable (`CORPSE_LOOT_CHANCE`); undefined while alive. */
  readonly lootable?: boolean;
  /**
   * appended (2026-09-18): this body is a **bug egg** (`bug_egg`) — a fixed target planted at the foot of a nest that never
   * moves · turns · attacks · notices, and inside `enemies/` it is not counted as 「a living, fighting body」.
   *
   * Another folder filters on it **when it reads the enemy list as a threat** — `ctx.enemies.getEnemies()` still holds the eggs
   * (they must be shootable, blastable and lootable, so they are not left out of the list). Anywhere that counts 「the enemies
   * threatening me now」 — the radar, danger indicators, turret targeting, android orders — has to drop them. It means the same
   * as `type === 'bug_egg'`, and this field is the name of that rule.
   */
  readonly isEgg?: boolean;
}

/* ── carrying a wounded squadmate (owner: player) ── */
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

/* ── launch-readiness panel portraits (owner: player, hosted by hub) ── */
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
  /**
   * appended (2026-09-15, the terminal's 매칭 tab): one square face portrait with the **same framing as the character-creation
   * confirm card** (head and shoulders, turned toward the camera's left diagonal), rendered once and returned as a PNG
   * data URL. `accent` = `#rrggbb` (`LobbyPlayer.accent`, falling back to the slot colour). null when no second WebGL
   * context is available — callers draw a name-only tile. May return a cached image for an accent it already drew.
   */
  snapshotFace?(opts: { accent: string; size?: number }): string | null;
}

/* ── viewing a squadmate's gear (owner: inventory) ── */
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

/* ══ appended: Phase 11 — planet selection (2026-09-07) ═════════════════════════════════════════════════ */

export interface HubRef {
  /* ── the target planet (owner: hub; the terminal is the only place it is picked) ── */
  /**
   * The target planet of the next raid, or null while nothing is picked. In a lobby this mirrors `LobbyState.planet` (the
   * host's choice); solo it is the local pick, remembered in localStorage `PLANET_STORAGE_KEY`. Launch slots refuse
   * boarding while it is null.
   */
  readonly planet: PlanetId | null;
  /**
   * Pick the target planet. Refused (`false`) for a non-host in a lobby, while a launch countdown runs, while already
   * travelling, and for an unknown id. On success the ship flies there: `hub:travel {stage:'start'}` → the window warp
   * (2026-09-09: seen through the viewports, controls stay on, `hub:warpProgress` every frame) →
   * `hub:travel {stage:'end'}` → `hub:planetChanged`. In a lobby the host also calls `ctx.net.setLobbyPlanet`, and
   * every member's own `lobby:state` starts the same warp locally.
   */
  setPlanet(planet: PlanetId): boolean;
  /** true while the ship is flying to a new planet (terminal closed, pods unavailable; the player keeps walking). */
  readonly travelling: boolean;
}

export interface WorldRef {
  /* ── the planet (owner: world) ── */
  /**
   * Planet the current world was generated for, or null when it came from the seeded biome draw (an older client,
   * a training, a `game:newMission` without one). `world:ready.planet` carries the same value.
   * (2026-09-15: `MissionComplete`'s `다시 배치` was removed, the feature and all, by the user's decision.)
   */
  readonly planet: PlanetId | null;
}

/* ══ appended: 2026-09-07 UI/UX pass — the corp screen became a tab of the Tab window ════════════ */

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

/* ══ appended: 2026-09-08 — implants (stat-granting equippables) · barrier collision · bullet tracking · scan silhouettes ═
 * Contract for the 2026-09-08 batch (Phase 12).
 * Append-only, as always. Owners are named per member.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * category 'implant' (owner: items). An implant is a Hollow-Knight-charm style equippable: it occupies `slots` of the
 * character's implant slots (`ProgressionRef.implantSlots`, 4 + 1 per 5 levels, max 10) and adds `stats` to the five
 * base stats while equipped. `broken` implants (raid loot) give nothing and cannot be equipped; 세레스 바이오's implant
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
  /** A broken implant: cannot be equipped, gives nothing; only a repair desk wants it. */
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

/* ══ appended: the launch readiness check (2026-09-08, owner: inventory) ═════════════════════════════════════
 * Before boarding a launch slot it sweeps in one pass everything that would be "awkward if you went out like this". Every
 * judgement is the inventory's — it alone knows the bag · equipped gear · ammo stacks · healing items; `hub/` only draws the list.
 * All six are **warnings** and none blocks boarding: press confirm and the launch goes ahead.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type LaunchWarningId =
  | 'noPrimary'    // not carrying a single primary (주무기 I · II)
  | 'lowAmmo'      // less than one set (= one cell, `AMMO_STACK_ROUNDS`) of the calibre of a carried weapon
  | 'noBag'        // no bag equipped
  | 'noArmor'      // no armor equipped
  | 'noImplant'    // no tactical implant equipped (`ctx.implants.equipped`)
  | 'noHeal'       // no healing item (category 'stim') in the bag
  /* appended (2026-09-11, A-13): the target planet has a standing environment (`PlanetDef.env`) but the preparation that
   * blocks it is not loaded for this raid. **A warning only, it does not block** — the soft gate is the user's decision. */
  | 'noEnvPrep'
  /* appended (2026-09-11, A-3c): no meal has been laid out (`ProgressionRef.getMeal()` is null).
   * A warning of the same grain as `noEnvPrep` — cooking is a benefit you may have or go without from the start.
   * 2026-09-12 (user's decision): it comes up **only on a ship with a kitchen** — to someone with neither a cook bench nor
   * a dining table, "식사를 차리지 않았습니다" is nagging with no way to fix it (`ctx.housing.getBenchLevel('cook')`). */
  | 'noMeal'
  /* appended (2026-09-12, user's decision): going out with no accepted corp contract (`ctx.meta.activeContract` is null).
   * Again **a warning only, it does not block** — a raid run without a contract is normal, but it asks once before a whole run is spent. */
  | 'noContract'
  /* appended (2026-09-16, the plate model — user's decision): the dining table holds an uneaten plate while another meal is already loaded —
   * launching clears that plate (`HousingRef.getPlate`). With only a plate and no meal, `noMeal` says 「식탁의 요리를 먹지 않았습니다」 instead. It does not block. */
  | 'plateDiscard';

/** One reason the launch check raised. Both strings are Korean and ready to render. */
export interface LaunchWarning {
  id: LaunchWarningId;
  /** Headline (`주무기가 없습니다`). */
  text: string;
  /** One line of detail — which weapon, how many rounds short … Empty when the headline says it all. */
  detail: string;
}

export interface InventoryRef {
  /**
   * The launch readiness check. Empty array = nothing to warn about. Order is fixed (the `LaunchWarningId` order above) so the
   * popup reads the same every time. Reads only — nothing is equipped, moved or consumed.
   */
  getLaunchWarnings(): LaunchWarning[];
}

/* ══ appended: the shared ship's hangar (2026-09-08, owner: hub) ════════════════════════════════════════════
 * Beyond the automatic door at the back of the shared ship is the **hangar**. The four squadmates' personal ships stand one per bay
 * marked on the floor, and interacting with a ship's rear door (its entrance) walks you inside that person's personal ship — someone else's is **look-only**.
 *
 * Only one interior still exists at a time: the hangar is part of the `'shared'` interior, and entering a bay swaps the
 * interior for `'personal'` (the lobby is kept as it is). Which ship you are inside is what `hubSite` tells.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * One personal-ship bay on the hangar deck. `slot` = the lobby slot the bay belongs to. `occupant` is a plain `string`
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
  /* ── appended (2026-09-08): the shared ship's hangar ── */
  /**
   * The personal ship the player is standing inside, as a PeerId — our own id (or `'local'` offline) in our own
   * ship, the owner's id in a visited one — and **null on the shared deck (the shared ship + the hangar)**. This is what
   * `PlayerSnapshot.hs` carries, so remote avatars can be hidden for anyone standing somewhere else.
   */
  readonly hubSite: string | null;
  /** PeerId of the ship being **visited** (someone else's), or null in our own ship / on the shared deck. */
  readonly visitingPeer: string | null;
  /** True while inside someone else's ship: every station, bench and ship management is refused (look-only). */
  readonly visitReadOnly: boolean;
  /** The hangar's four bays (empty array outside the shared ship). */
  getShipBays(): readonly HubShipBay[];
  /**
   * Board the personal ship parked in `slot`. Ours enters straight away; a peer's needs their `ship state` (requested on
   * the spot when it has not arrived yet, up to `SHIP_VISIT_WAIT_S`). Returns false when the bay is empty or the hub
   * is busy (cutscene / countdown / not in the hangar).
   */
  enterShipBay(slot: number): boolean;
  /** Walk back out through the airlock into the hangar. Returns false when we are not inside a bay's ship. */
  returnToHangar(): boolean;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-09 — death/corpses · the rescue drop · the squad leader · fog of war · walking on terrain features
 *
 * The contract of this batch. Interfaces only ever grow, by **declaration merging** (no renames · no deletions).
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/* ── fog of war (owner: world/Fog, published on `ctx.world.fog`) ────────────────────────────────── */
/**
 * Exploration progress of the raid map. One square grid `MAP_SIZE / FOG_CELL_M` cells to a side is the original, and
 * **a cell once revealed never goes dark again until the raid ends**.
 *
 * What reveals it is **the whole squad** — every `FOG_UPDATE_HZ` world paints `FOG_REVEAL_RADIUS` around the local
 * player and around the living (same-mission) coordinates of `ctx.net.getRemotePlayers()`.
 * Snapshots already flow at 20 Hz, so **no new wire is needed**. Only a client that joined late asks the host for
 * the mask so far with `fogq sync`.
 *
 * It is not built on the training range (`mode === 'training'`) — `ctx.world.fog === null`.
 */
export interface FogRef {
  /** Grid resolution (cells to a side). */
  readonly cells: number;
  /** One cell's edge (m) = `FOG_CELL_M`. */
  readonly cellSize: number;
  /** Rises by 1 every time a new cell is revealed. The map redraws the fog layer only when this value changes. */
  readonly revision: number;
  /** Revealed cells / total cells (0..1) — the HUD's exploration rate. */
  readonly explored: number;
  /**
   * Row-major `cells × cells` mask. 0 = unexplored, 255 = revealed.
   * **Treated as read-only** — the map canvas pushes it straight into ImageData.
   */
  readonly mask: Uint8Array;
  /** Is this world coordinate an already-revealed cell. Outside the bounds it is true (there is nothing to hide off the map). */
  isRevealed(x: number, z: number): boolean;
  /** Is `position` in a revealed cell — the standard query of the object-discovery gate. */
  isDiscovered(position: THREE.Vector3): boolean;
  /** Reveal `radius` m around a world coordinate (world calls it itself, and events such as a rescue drop landing use it too). */
  reveal(x: number, z: number, radius: number): void;
  /** Serialize (base64) / apply, for a client that joined late. Only the host builds it. */
  serialize(): string;
  applySerialized(data: string): void;
}

export interface WorldRef {
  /* ── appended (2026-09-09) ── */
  /** Fog of war. It exists only in a raid and is null on the training range. */
  readonly fog: FogRef | null;
  /**
   * **The height of the surface you can walk on** — the higher of the terrain height and the top of the obstacle there.
   * `getHeightAt` looks only at the terrain, so this is what to ask when the question is where the feet land.
   *
   * Given `feetY` it looks only at tops that can be **stepped onto** from that foot height (at most `feetY + PROP_STEP_UP_MAX`).
   * Without it, it returns the highest top at that spot (for bullet and fall tests).
   * A moving body calls this **before `resolveCollision`** — reverse the order and the body has already been pushed
   * aside, so it can never step onto a low ledge (`player/PlayerController` · `gadgets/drones/GroundDrone` keep this order).
   */
  getSurfaceY(x: number, z: number, feetY?: number): number;
  /**
   * The obstacle a body standing at `(x, z)` with foot height `feetY` is on, or null.
   * While it stands on that obstacle, `resolveCollision` does not push it out.
   * 2026-09-11 (C-38): when tops overlap inside the `PROP_TOP_MARGIN` window, a platform **with a `velocity` (a moving
   * one) is picked over the higher one** — the tie where a rail deck and a tram floor sat level and insertion order let the static one win.
   */
  getStandingObstacle(x: number, z: number, feetY: number): Obstacle | null;
  /**
   * Fraction of the circle of `radius` that obstacles cover (0..1). Used to reject spawn spots for large enemies.
   * It approximates cylinder cross-sections against each other and does not correct for overlap, so it may exceed 1.
   */
  obstacleCoverage(x: number, z: number, radius: number): number;
  /**
   * Pick `count` points inside `radius` around `center` that are at least `minGap` m apart
   * (so rescue pods do not land on top of each other). Terrain height is filled in; short of room it returns only what it found.
   */
  scatterPoints(center: THREE.Vector3, radius: number, count: number, minGap: number, seed?: number): THREE.Vector3[];
}

/* ── a dead player's corpse (owner: game/parts/Corpses, published on `ctx.corpses`) ────────── */
/**
 * One corpse. Neither an enemy corpse's `CORPSE_LIFETIME` nor distance culling applies (user's decision: kept out of optimisation).
 * 2026-09-16 (user's decision): **it disappears once it holds no item** — a corpse that stood empty-handed or was looted clean sinks into
 * the ground over `CORPSE_EMPTY_SINK_S` after `CORPSE_EMPTY_REMOVE_DELAY_S` and is removed (interaction · light pillar · mesh). A removed id never stands again in that raid.
 */
export interface PlayerCorpse {
  /** `pcorpse:<ownerId>:<n>` — one person dying several times leaves several corpses. */
  readonly id: string;
  /** The owner's PeerId (`'sp'` in single player). */
  readonly ownerId: string;
  readonly ownerName: string;
  readonly position: THREE.Vector3;
  readonly yaw: number;
  /** Time of death, in `ctx.missionTime`. */
  readonly diedAt: number;
  /** True once no item is left (the prompt becomes `비어 있음`). */
  readonly emptied: boolean;
}

export interface CorpsesRef {
  getCorpses(): readonly PlayerCorpse[];
  get(id: string): PlayerCorpse | null;
  /** This person's most recent corpse (used when the rescue-ship target list shows a position). */
  latestOf(ownerId: string): PlayerCorpse | null;
  /* ── appended (2026-09-13, extraction rework — owner: game, caller: extraction) ── */
  /**
   * Load the corpse onto a moving object (the extraction ship's `root`): it is laid at `parent`-local `local` (omitted = where it is now)
   * and from then on follows `parent`'s transform exactly (tilt included). `parent` null = set it down where it is in the world. False for an unknown id.
   */
  attachCorpse?(id: string, parent: THREE.Object3D | null, local?: THREE.Vector3): boolean;
  /** Remove the corpse from the raid (it left aboard the ship) — its interaction · mesh go with it and the items inside are lost too. */
  removeCorpse?(id: string): boolean;
  /* ── appended (2026-09-16, removing empty corpses — owner: game, caller: player/RemoteAvatar) ── */
  /**
   * Did a corpse of this person stand at any point in this raid (still true after an empty corpse sank and was removed). Used instead of
   * `latestOf` when deciding whether to hide a dead squadmate's avatar — a corpse disappearing must not bring the dead-pose avatar back. Cleared on mission reset.
   */
  ownerHadCorpse?(ownerId: string): boolean;
}

/* ── the rescue drop (owner: stratagems/parts/Rescue) ────────────────────────────────────────────── */
/** One squadmate cell on the rescue-call screen. */
export interface RescueCandidate {
  readonly peerId: string;
  readonly name: string;
  readonly slot: number;
  /** Selectable because they are dead. False while alive or downed (the cell shows but is disabled). */
  readonly selectable: boolean;
  /** The position of their corpse when dead, else null. */
  readonly corpse: THREE.Vector3 | null;
}

export interface StratagemsRef {
  /* ── appended (2026-09-09): the rescue drop ── */
  /** Rescue drops left (shared by the squad). `RESCUE_DROPS_PER_RAID` at the start of a raid. */
  readonly rescueLeft: number;
  /** Can a rescue be called right now = drops left > 0 and at least one squadmate is dead. */
  readonly rescueAvailable: boolean;
  /** The 4 squadmate cells (only the dead are `selectable`). The rescue selection screen draws this. */
  getRescueCandidates(): readonly RescueCandidate[];
  /** The target picked on the selection screen right now, or null. */
  readonly rescueTarget: string | null;
}

export interface InventoryRef {
  /* ── appended (2026-09-09): corpse looting ── */
  /**
   * **Everything held at the moment of death** — the items in the equipment slots · bag · quick slots plus **the broken pair
   * of every equipped implant** (2026-09-11 C-12, `ProgressionRef.stripImplantsForCorpse`) as one list, and it **empties** the local inventory.
   * It is the only entrance that fills a corpse container, and the death handling calls it exactly once.
   */
  stripForCorpse(): ItemInstance[];
  /**
   * The same as `openContainerItems` but the grid size is given (a corpse is `PLAYER_CORPSE_COLS × PLAYER_CORPSE_ROWS`).
   * For an id already known, both `items` and the size are ignored and what is left inside is shown.
   */
  openContainerItemsSized(containerId: string, items: ItemInstance[], position: THREE.Vector3,
    cols: number, rows: number, title?: string): void;
}

export interface InventoryRef {
  /* ── appended (2026-09-11): save integrity — E-5 · E-6 (owner: inventory) ── */
  /**
   * E-6: write the debounced 창고 / 로드아웃 saves **now** (localStorage + the profile queue — both changed → one
   * `ProfileRef.setMany`). A caller whose edit spans documents (meta/ quest completion) runs this first and then joins the
   * queued documents into its own transaction. Optional: an older build simply has no merged save.
   */
  flushSaves?(): void;
  /**
   * E-5: the seed of the **solo raid** the persisted loadout was carried into (`raidSeed` marker, written at a solo raid's
   * `world:ready`, cleared when it ends — extraction, 레이드 실패, abort). Read at boot by game/: a marker without a solo
   * raid save of the same seed means the save was deleted → the run is lost like a stale one. null = none.
   */
  readonly soloRaidSeed?: number | null;
}

/* ══ appended: 2026-09-09 — raid play improvements (structures · rails · hazards · rogue drops · communication) ═
 * The contract is **add-only**. The owning folder is named at the head of each section.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/* ── box colliders · platforms that carry you along (owner: world) ───────────────────────── */
export interface Obstacle {
  /**
   * **A box (OBB) collider.** Given one, the push-out and the ray use this box instead of the `radius` circle — added on
   * 2026-09-09 for the things a cylinder lies about, such as a building wall or a tram body. `radius` is **still filled in**:
   * `SpatialHash` bucketing and the broad queries (`getObstaclesNear` · `obstacleCoverage`) use that circumscribed circle
   * (`radius >= hypot(halfX, halfZ)` is what keeps a query from missing the box).
   * `yaw` is the Y-axis rotation (rad) and `halfX` / `halfZ` are the half-lengths of the local axes **before** it.
   */
  box?: { halfX: number; halfZ: number; yaw: number };
  /**
   * The velocity (m/s, world space) a body is carried at **while it stands on this obstacle's top**. Trams · moving platforms fill it.
   * **Its presence alone** marks a "moving platform" (a stopped tram fills a zero vector too — `getStandingObstacle` picks
   * it first on a tie, C-38). The riding side (player · enemies · corpses, 2026-09-11 C-18) does **not** add this velocity —
   * only entry goes through `getStandingObstacle`; staying on and moving with it is `shared/ride.ts` (vehicle OBB + headroom,
   * re-solving the vehicle-local coordinates from the vehicle's current transform every frame). The velocity is used only for dismount inertia.
   */
  velocity?: THREE.Vector3;
}

/* ── abandoned structures (owner: world/Structures) ─────────────────────────────────────────────── */
/**
 * An **enterable** derelict building placed at random in every planet sector. Interactable containers are packed inside.
 * 2026-09-12 (user's decision): there are two locked spaces — the **basement** of an `outpost` and the **locked
 * upper-floor room** of a `lab` that rolled a second floor. Both open with a **consumable key** of the matching kind,
 * and no building is guaranteed one — they come rarely from crates · structure containers · rogue corpses · the nomad shop.
 * 2026-09-21 (user's decision): a key is **planet-bound** — `key_basement_<planet>` · `keycard_lab_<planet>`, one pair
 * per `data/planets.csv` row. It opens any building of its kind **on its own planet** and nothing anywhere else, and the
 * planet it drops on is unrelated to the planet it fits, so a key found here is an invitation to go there. Inside both
 * rooms hangs an indestructible ceiling turret that only the matching key switches off (`world/structures/parts/Turret`).
 * The item a door demands is `unlockDefId`, and low in the wall beside the door is a vent only a ground drone fits through.
 */
export type StructureKind = 'outpost' | 'lab' | 'wreck';
export const STRUCTURE_KINDS: readonly StructureKind[] = ['outpost', 'lab', 'wreck'];
export const STRUCTURE_LABEL_KO: Readonly<Record<StructureKind, string>> = {
  outpost: '버려진 전진기지', lab: '버려진 연구실', wreck: '불시착한 함선',
};

export interface StructureDef {
  /** `struct_<kind>_<n>` — seed-deterministic, so it is the same on every client. */
  id: string;
  kind: StructureKind;
  /** Centre of the ground floor (y = floor height). */
  position: THREE.Vector3;
  yaw: number;
  /** Rough radius (m) used by map markers · spawn avoidance · rogue drop targets. */
  radius: number;
  /** Does it have a basement. */
  hasBasement: boolean;
  /** Position of the basement's locked door. Null when `hasBasement` is false. */
  basementDoor: THREE.Vector3 | null;
  /** Has the basement door been opened with a keycard (host-authoritative, spread by `struct unlocked`). */
  unlocked: boolean;
  /** Has a **planet scan** already been run from this structure's computer (once per structure). */
  scanned: boolean;
  /** Has a rogue drop already happened at this structure — the store behind the **once per sector** rule. */
  rogueDropUsed: boolean;
}

/* ── rails · platforms · trams (owner: world/Rails) ─────────────────────────────────────────────── */
/** `loop` = a circular line around the sector's edge, `line` = a straight back-and-forth line crossing the sector. */
export type RailKind = 'loop' | 'line';
export const RAIL_LABEL_KO: Readonly<Record<RailKind, string>> = { loop: '순환 선로', line: '반복 선로' };

/** The platform at a line's end (or at one point of a loop) — a farming spot in its own right. */
export interface RailPlatformDef {
  id: string;
  position: THREE.Vector3;
  yaw: number;
  /** Rough radius (m) of the platform deck. */
  radius: number;
}

export interface RailLineDef {
  /** `rail_<n>`. */
  id: string;
  kind: RailKind;
  /**
   * The points of the line's centre line (y = the rail top's height). For a `loop` the last → first point joins into a
   * **closed ring**; for a `line` it is an open polyline, so the tram reverses at the end.
   */
  points: readonly THREE.Vector3[];
  /** Total length of the centre line (m) — a `loop` includes the closing segment. */
  length: number;
  platforms: readonly RailPlatformDef[];
}

/** Tram state. `idle` = before start-up, `moving` = travelling, `docked` = stopped at a platform. */
export type TramState = 'idle' | 'moving' | 'docked';
/** Wire order (`tram state.st` is an index into this array). Never reorder. */
export const TRAM_STATES: readonly TramState[] = ['idle', 'moving', 'docked'];

export interface TramDef {
  /** `tram_<lineId>`. One tram per line. */
  id: string;
  lineId: string;
  /** Centre of the body (y = deck height). The host simulates it and clients interpolate. */
  position: THREE.Vector3;
  yaw: number;
  state: TramState;
  /** Travelled distance along the line (m). **Host-authoritative** — this one value is the tram's real state. */
  s: number;
  /** Direction of travel (+1 / −1). A `loop` is always +1. */
  dir: 1 | -1;
}

/* ── environmental hazards (owner: world/Hazard) ───────────────────────────────────────────────────── */
/**
 * A planet phenomenon that starts at one moment **on a 30 s step** between `HAZARD_START_MIN_S` and
 * `HAZARD_START_MAX_S` after the raid begins and slowly covers the map. The candidates are fixed per planet (the
 * `hazards` column of `data/planets.csv`) and one of them is drawn **per raid** from the mission seed — no wire is
 * needed. Inside it a body takes `HAZARD_DPS` per second and sight narrows; run to the end and the safe zone is gone, which is effectively a forced extraction.
 *
 * **It is a phenomenon the ship observes, so the fog of war does not hide it** — the map draws it **above** the fog layer.
 */
export type HazardKind = 'sandstorm' | 'blizzard' | 'storm_eye' | 'spores';
export const HAZARD_KINDS: readonly HazardKind[] = ['sandstorm', 'blizzard', 'storm_eye', 'spores'];
/**
 * The name the player sees. 2026-09-13 (user's decision): sandstorm · blizzard · storm eye are all one **「폭풍」** on screen
 * (they are not told apart). Code and docs tell them apart with `HazardKind`.
 */
export const HAZARD_LABEL_KO: Readonly<Record<HazardKind, string>> = {
  sandstorm: '폭풍', blizzard: '폭풍', storm_eye: '폭풍', spores: '독성 포자',
};

/** One danger/safety zone. The map · HUD · `isInside` all look only at this shape. */
export interface HazardZone {
  id: string;
  /**
   * `front` = a half-plane (a broad wall filling in sideways). The front passes through `center` with `(dirX, dirZ)` as
   * its normal, and **the side it has already crossed** (opposite the normal) is the dangerous one. `circle` = a circle.
   */
  shape: 'front' | 'circle';
  center: { x: number; z: number };
  /** Radius (m) of a `circle`. 0 for a `front`. */
  radius: number;
  /** Unit vector of a `front`'s direction of travel. (0, 0) for a `circle`. */
  dirX: number;
  dirZ: number;
  /** `circle` only: true = **inside the circle is safe** and outside is dangerous (the storm eye). false = inside is dangerous (toxic spores). */
  safeInside: boolean;
}

/** Where toxic spores rise from — a **giant mushroom cluster** in the terrain. Only ones found by lifting the fog are `discovered`. */
export interface HazardSource {
  id: string;
  position: THREE.Vector3;
  /** The radius (m) this source finally covers. */
  radius: number;
  /** Has it already started to rise. */
  erupted: boolean;
  /** Is it a spot the player knows because the fog lifted (`FogRef.isDiscovered`). The map draws only these. */
  discovered: boolean;
}

export interface HazardRef {
  /** This raid's hazard. Null on a planet with no candidate (or on the training range). */
  readonly kind: HazardKind | null;
  /** Start time (`ctx.missionTime` seconds). −1 when there is no hazard. */
  readonly startsAt: number;
  /** Has the warning broadcast already gone out (`HAZARD_WARN_S` before). */
  readonly announced: boolean;
  /** Is it running now (`missionTime >= startsAt`). */
  readonly active: boolean;
  /** 0..1 — at 1 it has covered the whole map (no safe zone). */
  readonly progress: number;
  /** Is this point inside the **damage zone** right now. A cheap query, fine to call every frame. */
  isInside(x: number, z: number): boolean;
  /** The shapes the map · HUD draw. The internal array is reused, so **read it and use it at once** (never keep it). */
  getZones(): readonly HazardZone[];
  /** Toxic spore sources. An empty array for every other hazard. */
  getSources(): readonly HazardSource[];
  /** For a client that joined late (only the host builds it). `HazardMessage 'sync'` carries it. */
  serialize(): string;
  applySerialized(data: string): void;
  /* appended (2026-09-13) */
  /**
   * Damage multiplier = the damage per second now / `HAZARD_DPS`. 1 at the start → `HAZARD_DPS_MAX / HAZARD_DPS` at progress 1 (a hazard grows stronger over time).
   * It is 1 before the start too — the caller looks at `active` · `isInside` first. The enemies' silent damage (`enemies/`) multiplies by it.
   */
  readonly damageMul: number;
}

/* ── the world accessors that tie the three above together ─────────────────────────────────────── */
export interface WorldRef {
  /* ── appended (2026-09-09): raid play improvements ── */
  /** Every abandoned structure on this map (an empty array on the training range). */
  getStructures(): readonly StructureDef[];
  /** The structure that holds `(x, z)` (inside its own `radius`), or null. */
  structureAt(x: number, z: number): StructureDef | null;
  /** This map's rails (there may be none — it is random per sector). */
  getRailLines(): readonly RailLineDef[];
  /** The trams on the rails (one per line). */
  getTrams(): readonly TramDef[];
  /** This raid's environmental hazard. Null on a planet with no candidate · on the training range. */
  readonly hazard: HazardRef | null;
  /**
   * appended (2026-09-15, sandworm appearance rework — owner: world): is the `radius` m around `(x, z)` the **flat bare ground**
   * a sandworm can dig out of — the terrain slope is gentle and the circle catches no structure footprint · rail · tram · prop
   * (rock · tree) · spore cluster · danger zone · nest · training fixture. The host's trigger-spot check (`enemies/sandworm/Director`)
   * and the seismic device's placement preview (`gadgets/parts/Preview`) must use the **same judgement**, so it lives here alone.
   * Optional — the tutorial · training worlds do not implement it, and callers read it with `?.` and treat a missing one as false (no sandworm there).
   */
  burrowGroundOk?(x: number, z: number, radius: number): boolean;
}

/* ── weapon grade drops per planet (owner: items/Loot) ────────────────────────────────────────── */
export interface LootRef {
  /**
   * appended (2026-09-09): the **grade of a weapon** out of a crate is decided by the planet (`data/planet_loot.csv`).
   * The weapon is re-graded on that planet's grade curve, and a grade whose curve is 0 never comes out at all
   * (which is why IV · V are sealed on the early planets). With `planet` null it uses the crate tier's rarity weights as before.
   *
   * `rollCrate(tier, rng)` stays as it is and gives the same result as `rollCrateOn(tier, rng, null)`.
   */
  rollCrateOn(tier: number, rng: Random, planet: PlanetId | null,
    /**
     * appended (2026-09-16): this container's roll rules — for now just `lockedRoom` (the lab's locked room = exempt from the epic-plus gate).
     * The opening path and the previews (drone scan · androids · the inventory peek) must pass the **same value** for the
     * results to match — a structure container's value is answered by `WorldRef.crateLootOpts(id)`. Omitted = an ordinary crate.
     */
    opts?: CrateLootOpts): ItemInstance[];
  /**
   * appended (2026-09-09): the grade of a weapon dropped by a corpse (rogue · boss) is **capped** by the same curve.
   * With `planet` null it is exactly `rollCorpse`.
   */
  rollCorpseOn(type: EnemyType, rng: Random, rogueWeaponId: string | undefined, planet: PlanetId | null,
    /** appended (2026-09-13): the input of faction loot — the spawn site · grenades never thrown. Omitted = the old roll. */
    opts?: CorpseLootOpts): ItemInstance[];
}

/* ── appended (2026-09-16): the epic-plus drop-rate gate — the locked room exception (owner: items/Loot · world/Structures) ─ */
/**
 * An extra argument of `LootRef.rollCrateOn`. A planet's `epicPlusMul` (`data/planet_loot.csv`) cuts the rate at which epic · legendary come out,
 * and the one exception is a container in the **lab's locked upper-floor room** (the keycard room) — user's decision 2026-09-16 「the locked room stays as it is」.
 * The value is decided by world (`WorldRef.crateLootOpts`) and every roll path passes it through — seed-deterministic, so previewing ≡ opening.
 */
export interface CrateLootOpts {
  /** true = a lab locked-room container — it skips the epic-plus gate (the planet's grade curve · rarity multipliers still apply). */
  lockedRoom?: boolean;
}

export interface WorldRef {
  /**
   * appended (2026-09-16): the roll rules (`LootRef.rollCrateOn`'s `opts`) of an inventory container id (the id of
   * `WorldRef.getLootContainers` — the bare spec id, no `container:`). `{ lockedRoom: true }` for a locked-room container,
   * undefined for anything else (map crates · supply crates · an unknown id · before the world is ready). The inventory's opening path · peek · android confirmation pass it through.
   */
  crateLootOpts?(containerId: string): CrateLootOpts | undefined;
}

/* ══ appended (2026-09-13): enemy factions per planet — androids · rogues · raiders (owner: enemies · items · world) ═
 * Which faction appears is decided by the planet's threat (`planetThreat`): 1 = androids · 2 = rogues / raiders · 3 = raiders only.
 * Every pair of different factions is hostile (2026-09-13).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════ */
/** The faction names in game. */
export const ENEMY_FACTION_LABEL_KO: Readonly<Record<EnemyFaction, string>> = { bug: '벌레', rogue: '로그', android: '안드로이드', raider: '레이더' };
/**
 * The **site** a humanoid enemy was placed at — an input of corpse loot (the lab = research goods, the outpost = a weapon grade bonus).
 * `platform` = a rail platform, `ruin` = a ruined outpost (`WorldRef.getRuinSites`), `drop` = a raider drop; the rest are `StructureKind`.
 */
export type EnemySpawnSite = StructureKind | 'platform' | 'ruin' | 'drop';
/** The role inside one group. `flanker` = the one member of a raider group that breaks off to flank, `leader` = the rogue group's leader (rogue_boss). */
export type EnemySquadRole = 'member' | 'leader' | 'flanker';
/** The kind of grenade an enemy carries. **The order is the wire index** (`ee grenade.k` · `ee corpse.gk`) — never reorder. */
export type EnemyGrenadeKind = 'frag' | 'incendiary';
export const ENEMY_GRENADE_KINDS: readonly EnemyGrenadeKind[] = ['frag', 'incendiary'];
/** The item id of that kind (what is left on the corpse — `data/items.csv`). */
export const ENEMY_GRENADE_ITEM: Readonly<Record<EnemyGrenadeKind, string>> = { frag: 'grenade_frag', incendiary: 'grenade_incendiary' };

/** Extra arguments of `RogueSpawnHost.spawnRogue` (all optional — omitted = the old spawn). */
export interface HumanoidSpawnOpts {
  site?: EnemySpawnSite | null;
  /** The same value for the same group (unique only inside a raid). Omitted = -1 = no group. */
  squadId?: number;
  role?: EnemySquadRole;
}

/** Extra arguments of `LootRef.rollCorpseOn`. The host builds them from `Enemy`, a replica from `ee corpse.si/gc/gk`. */
export interface CorpseLootOpts {
  site?: EnemySpawnSite | null;
  /** Grenades left unthrown — they go onto the corpse as that same kind (there is no separate grenade drop roll). */
  grenades?: { kind: EnemyGrenadeKind; count: number } | null;
}

/** One ruined outpost (a POI pad of world `Outposts` — **not** the enterable outpost `StructureKind 'outpost'`). */
export interface RuinSiteDef {
  /** `outpost_<i>` (the same id as `fog:discovered {kind:'outpost'}`). */
  readonly id: string;
  readonly position: THREE.Vector3;
  readonly yaw: number;
  readonly radius: number;
}

/** The kind of spot a site group is stood on. */
export type SiteSpawnPlace = 'indoor' | 'outdoor';

export interface WorldRef {
  /** appended (2026-09-13, owner: world): this map's ruined outposts (training range · a map without them = an empty array). */
  getRuinSites?(): readonly RuinSiteDef[];
  /**
   * appended (2026-09-13, owner: world): `count` spots to stand a humanoid group on at site `siteId` — at least `minGap` apart, seed-deterministic.
   * `siteId` = a structure id (`struct_*`) · a rail platform id · a ruin id (`outpost_<i>`).
   *  - `indoor`: a structure = walkable floor inside (the ground floor, and the upper one when there is a second) — clear of walls · containers · the stair opening · the locked room · the basement.
   *    A platform = on the deck, a ruin = on the floor plate inside the walls.
   *  - `outdoor`: the ring outside the footprint, unblocked and clear of the rail corridor.
   * y is the height the feet land at. Short of room it returns only what it found (an unknown id · the training range = an empty array).
   */
  getSiteSpawnPoints?(siteId: string, place: SiteSpawnPlace, count: number, minGap: number, seed: number): THREE.Vector3[];
}

/* ── the rogue drop (owner: enemies/RogueDrop) ─────────────────────────────────────────────────────── */
/** One rogue drop in progress. */
export interface RogueDropView {
  readonly id: string;
  readonly position: THREE.Vector3;
  /** How many are coming down. */
  readonly count: number;
  /** Is a boss (the old rogue squad leader) among them. The 2026-09-13 raider drop has no leader, so it is always false. */
  readonly boss: boolean;
  /** Landing time, in `ctx.time`. */
  readonly landsAt: number;
}

export interface EnemyManagerRef {
  /* ── appended (2026-09-09): the rogue drop ── */
  /**
   * **Host only.** Drops a rogue squad around `position` (a warning → landing after `ROGUE_DROP_ETA_S` → advance).
   * The head count and whether a boss is in it are decided by **the squad size** (`ROGUE_DROP_*` constants) — not by the caller.
   * False when the same `dropId` is already running, or when this is not the host.
   */
  callRogueDrop(dropId: string, position: THREE.Vector3): boolean;
  /** The drops in progress (for the HUD warning · off-screen arrows). */
  getRogueDrops(): readonly RogueDropView[];
}

/* ══ appended (2026-09-10): armor = a shield ═══════════════════════════════════════════════════ */

export interface PlayerRef {
  /* ── the shield (owner: player/PlayerSystem) ────────────────────────────
   * Armor no longer cuts damage (`PlayerRef.damageReduction` remains as contract only and is always 0).
   * It gives an **extra hp pool** instead: incoming damage empties `shield` first and only the rest reaches `hp`.
   * The shield does not regenerate on its own — only the '실드 충전기' consumable (`chargeShield`) and returning to the ship refill it.
   * Every change is announced with `player:shieldChanged`. */
  /** The current shield. 0 with no armor. */
  readonly shield: number;
  /** The equipped armor's `ArmorDef.shield`. 0 when there is none. */
  readonly maxShield: number;
  /** The armor rarity that decides the colour of a shield gauge segment. Null when there is none. */
  readonly shieldRarity: Rarity | null;
  /** Armor tier (numbered armors 1..5, uniques 0). 0 when there is none. */
  readonly shieldTier: number;
  /**
   * The shield charger: refills the shield by `amount` (`Infinity` = full). With no armor, or already full, it returns
   * false **without spending anything** — the caller asks with this before consuming the item.
   */
  chargeShield(amount: number): boolean;
}

/* ══ appended (2026-09-10): the craft rework — repair · salvage tied to durability ══
 *
 * The repair cost and the salvage yield now come from **the materials that item costs to craft fresh**. The remaining
 * durability is split into five 20 % buckets (`durabilityBucketOf`), and each bucket's fixed multiplier is applied to
 * the craft materials (`REPAIR_COST_BY_DURABILITY` · `SALVAGE_YIELD_BY_DURABILITY` in `data/tables.csv`).
 * So for one and the same gun **the repair cost and the salvage yield differ by how much durability is left** — the UI must ask with the instance in hand.
 *
 * The two multipliers always sum to less than 1, so 「craft → (repair) → salvage → craft」 never turns a profit.
 * What checks that against the real numbers is `items/Salvage.checkSalvageEconomy()`, and `npm run data:check` runs it.
 *
 * ⚠ **`getRepairCost(inst)` keeps its signature and only its implementation moved to this rule** (see the original block above):
 *   it is no longer "missing durability ÷ REPAIR_SCRAP_PER" but `craft materials × REPAIR_COST_BY_DURABILITY[bucket]` (rounded
 *   up), and it returns a value for **armor** as well as weapons (armor repair used to be free). An item at full durability,
 *   or with no durability at all, still gives `[]` as before.
 */
export interface LootRef {
  /**
   * The remaining-durability bucket **0..4** — 0 = 0~20 % · 1 = 21~40 % · 2 = 41~60 % · 3 = 61~80 % · 4 = 81~100 %.
   * An item with no durability (bags · materials · ammo) is always **4**.
   */
  durabilityBucketOf(inst: ItemInstance): number;
  /** The description of one bucket — so the UI can draw "which bucket it is in now" and that bucket's multipliers as they are. */
  durabilityBucketInfo(inst: ItemInstance): DurabilityBucketInfo;
  /**
   * The materials this item costs **to craft fresh** (the basis of the repair · salvage maths). `[]` when it has no craft
   * recipe (unique weapons · unique armors · loot-only items). The returned array is shared, so it is never modified.
   */
  getCraftCostOf(defId: string): readonly CraftIngredient[];
  /**
   * What salvaging this instance **right now** yields. Null when it cannot be salvaged (uniques · gear with no craft
   * recipe · a yield of 0). What comes back is still `CraftRecipe`-shaped and its `id` is **the same** as that salvage
   * recipe in `getAllRecipes()` — only `outputQty` / `extraOutputs` differ (multiplied by the durability bucket).
   * The one listed in `getAllRecipes()` is **on bucket 4 (81~100 %)**, so consuming and producing for real must always
   * use the recipe this function returned.
   */
  getSalvageFor(inst: ItemInstance): CraftRecipe | null;
}

/** The return value of `LootRef.durabilityBucketInfo`. */
export interface DurabilityBucketInfo {
  /** 0..4 (0 = 0~20 %). */
  bucket: number;
  /** Remaining durability as a ratio 0..1 (1 when there is no durability). */
  ratio: number;
  /** This bucket's repair material multiplier (craft materials × this, rounded up). */
  repairMul: number;
  /** This bucket's salvage yield multiplier (craft materials × this, rounded down). */
  salvageMul: number;
  /** The Korean bucket label (`81~100 %`). */
  label: string;
}

export interface EnemyManagerRef {
  /* ── appended (2026-09-10): danger indicators ── */
  /**
   * The **enemy** grenades in flight right now (thrown by rogues). The HUD's danger indicators read it alongside
   * friendly grenades (`WeaponsRef.getGrenades()`) — the same `GrenadeView` shape, where `remote` is used to mean
   * "a replica this client has no authority over". One view object is reused per pooled body, so the returned array
   * is reused on the spot too: **the caller must not hold on to it and reads it all within that frame.**
   */
  getEnemyGrenades(): readonly GrenadeView[];
}

/* ══ appended (2026-09-11): convex colliders · ramp platforms · breakable glass · ladders ═
 * The contract is **add-only**. The owning folder is named at the head of each section.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/* ── convex polygon prisms (owner: world) ─────────────────────────────────────────────────────── */
/** One band of a convex collider — the convex outline of the mesh visible between heights `[y0, y1]` (world XZ, counter-clockwise). */
export interface ObstacleHullBand {
  y0: number;
  y1: number;
  /** `[x0, z0, x1, z1, …]` in world coordinates, counter-clockwise (the +X → +Z turn seen from above). */
  points: Float32Array;
}

/**
 * **A convex polygon prism.** Given one, the push-out and the standing test use this outline instead of the `radius`
 * circle — added on 2026-09-11 for props such as rocks · crystals · spires, where one circle cuts into the silhouette
 * from one direction and blocks you short of it from another. By the same convention as `box`, `radius` is **still filled
 * in** (the distance from `position` to the farthest vertex = the circumscribed circle): `SpatialHash` bucketing and the broad queries use that circle.
 */
export interface ObstacleHull {
  /** The outline for movement · standing (`[x0, z0, …]`, world coordinates, counter-clockwise). Its height is `position.y .. position.y + height`. */
  points: Float32Array;
  /** The bands for bullets · line of sight. Without them `points` is used over the whole height. Bands are sorted bottom to top. */
  bands?: readonly ObstacleHullBand[];
}

export interface Obstacle {
  /** A convex polygon prism (2026-09-11). Never used together with `box`. */
  hull?: ObstacleHull;
  /**
   * A **ramp platform** (2026-09-11) — used only together with `box`. The top is a slope rising along the box's local +X:
   * `position.y + height - rise` at local `x = -halfX`, `position.y + height` at `x = +halfX`.
   * Stairs are **stairs to look at and this slope to walk on**, so a body glides up and down instead of hopping step by step.
   */
  ramp?: { rise: number };
  /**
   * A pane that breaks in one hit (window glass, 2026-09-11). Whatever hit it (a bullet · a thrown object) calls
   * `destructible.onDamage`, and once broken the owner takes it out of the hash. It blocks movement, but **a thrown object does not bounce off it: it breaks through.**
   */
  fragile?: boolean;
}

/* ── ladders (owner: world/Structures — the hanging side: player) ───────────────────────────────── */
/**
 * One ladder run in an enterable building. Every coordinate is world space and seed-deterministic.
 * A hanging body is pinned to `base`'s XZ and climbs between `base.y` and `topY`.
 */
export interface LadderDef {
  /** `ladder_<structureId>_<n>`. */
  id: string;
  /** The XZ of the **body centre** while hanging on the ladder, y = the height of the floor below (at the feet). */
  base: THREE.Vector3;
  /** The height of the floor stepped onto at the top (the roof surface). */
  topY: number;
  /** The horizontal unit vector from the ladder face **toward the person hanging on it**. Hanging, the body faces `-normal`. */
  normal: THREE.Vector3;
  /** Where the body stands after stepping off at the top (y = `topY`). It is the floor beyond the ladder (`-normal` direction). */
  exit: THREE.Vector3;
}

export interface WorldRef {
  /* ── appended (2026-09-11) ── */
  /** Every ladder on this map (an empty array on the training range · with no structures). */
  getLadders(): readonly LadderDef[];
}

export interface PlayerRef {
  /* ── appended (2026-09-11): ladders (owner: player) ── */
  /** The id of the ladder currently hung on. Null when not hanging (missing means the same as null). */
  readonly climbingLadder?: string | null;
}

export interface PlayerRef {
  /* ── appended (2026-09-11): drone control (owner: player; caller: gadgets/drones — shared/drones.ts) ── */
  /** true while the local player looks through a drone (`setDroneControl(true)`). */
  readonly droneControl?: boolean;
  /**
   * Drone control mode. While true: movement · jump · stance · roll input is ignored and the body is held still (velocity 0),
   * the **crouch stance is forced** (turning it off restores the stance from just before), aiming is released,
   * `canUseWeapons()` is false, E interaction is gone, and mouse look is not applied to the camera rig — the camera is
   * handed over by drones every frame with `setCameraOverride(pos, look, true)`.
   * Damage still lands (cutting the control off is done by drones watching `player:damaged`).
   * Downed · death · `respawnAt` · `spawnStanding` · `game:abort` set it back to false.
   */
  setDroneControl?(active: boolean): void;
}

/* ══ appended (2026-09-12): library media (A-3e) · the gym (A-3a) — `src/housing/README.md` Decisions ═══════════════════ */

export interface ItemDef {
  /* ── appended (A-3e, owner: items) ── */
  /** category 'disc': the skill it raises when slotted into the library disc rack. Same shape as `BookDef` (rarity = the `BOOK_RARITY_MUL` weight). */
  disc?: BookDef;
  /** category 'record': the skill it raises when slotted into the library record rack. */
  record?: BookDef;
}

/** A pose that gives the body over to a piece of furniture (owner: player; caller: hub). `sit` = the rocking chair, the other three = gym machines. */
export type FurniturePoseKind = 'sit' | 'bench' | 'run' | 'cycle'
  /**
   * appended (2026-09-13, the cooking minigame): standing at the cook bench working the hands. anchor = the **floor** in front of the bench (where the body stands), yaw = facing the bench.
   * The drive phase = the accumulated cycle of the hand motion (slicing · chopping = one knife stroke, stirring = one turn of the ladle, tossing = one flip of the pan, grilling · pouring = a slow sway).
   */
  | 'cook';

export interface FurniturePose {
  kind: FurniturePoseKind;
  /**
   * World coordinate of the surface that carries the body — `sit`: the centre of the seat top · `bench`: the **back
   * (shoulder-blade) spot** on top of the bench pad · `run`: the centre of the treadmill belt · `cycle`: the saddle top. The body offsets (hip height · the length of a lying body) are decided by player.
   */
  anchor: THREE.Vector3;
  /**
   * The facing — the same convention as the player camera yaw (forward = `(−sin yaw, 0, −cos yaw)`). For `bench` it is the **hip → head** direction
   * (lying down with the head toward the barbell rack).
   */
  yaw: number;
  /** A fixed camera. Without one it is the usual third-person rig (mouse look free) — the rocking chair omits it, the gym machines give a fixed camera from the side. */
  camera?: { position: THREE.Vector3; lookAt: THREE.Vector3 } | null;
  /** True and E (`Keys.INTERACT`) releases the pose (the rocking chair toggle). A gym machine is released only by its caller (`setFurniturePose(null)`). */
  releaseOnInteract?: boolean;
}

export interface PlayerRef {
  /* ── appended (2026-09-12): furniture poses (owner: player; caller: hub) ── */
  /** The furniture pose held right now, or null. */
  readonly furniturePose?: FurniturePoseKind | null;
  /**
   * Take / release a furniture pose. While held: movement · jump · stance · roll · weapons · (unless `releaseOnInteract`)
   * E interaction are ignored, and the body is pinned to `anchor` running the pose animation. With a `camera` it blends to
   * that spot. **Releasing puts the body back where it stood just before taking the pose** (it never stays inside the
   * furniture collider). Only in the ship (`phase === 'hub'`) — in a raid · drone control · on a ladder · in a pod · downed
   * it returns false and changes nothing. `game:abort` · `hub:left` · a phase change · `spawnStanding` release it and emit
   * `player:furniturePoseEnded {reason:'reset'}`.
   */
  setFurniturePose?(pose: FurniturePose | null): boolean;
  /**
   * The motion phase 0 … 1 of an exercise pose — `bench`: 0 = the barbell at the chest · 1 = arms fully extended, `run`: one
   * stride cycle (0 → 1 repeating), `cycle`: one turn of the crank (0 = left foot up · 0.5 = right foot up). hub hands it over
   * every frame with the same value it drives the barbell · pedal models with. Never called, player runs it at a default speed itself. Not used for `sit`.
   */
  setFurniturePoseDrive?(phase: number): void;
}

/* ══ appended (2026-09-12): character buffs · furniture pose sync — `src/player/README.md` Decisions ════════ */
import type { CharBuff } from './charBuffs';

export interface FurniturePose {
  /**
   * appended (2026-09-12): the uid of the furniture piece the body was given over to (hub fills it). The buffs (`rest` · `exercise`)
   * and the remote sync (`PlayerSnapshot.fu`) point at that furniture with it — a visitor's hub drives that piece's barbell · belt · crank at the same phase. Omitted = unknown.
   */
  furnitureUid?: string;
}

/** The wire shape of the furniture pose held right now (`PlayerRef.furniturePoseState`, owner: player). */
export interface FurniturePoseState {
  kind: FurniturePoseKind;
  /** `FurniturePose.anchor` as it is (world space). */
  anchor: Readonly<THREE.Vector3>;
  /** `FurniturePose.yaw` as it is (the camera yaw convention; for `bench`, hip → head). */
  yaw: number;
  /**
   * The **unwrapped accumulated phase** — the receiver must be able to interpolate linearly between snapshots. `bench`: 0 … 1
   * (barbell at the chest → arms extended; this one never wraps to begin with) · `run`: the stride count (integer part = which
   * stride, fraction = the phase inside one stride) · `cycle`: the number of crank turns · `sit`: 0.
   */
  phase: number;
  /** `FurniturePose.furnitureUid`, or null when unknown. */
  furnitureUid: string | null;
}

export interface PlayerRef {
  /* ── appended (2026-09-12): character buffs (owner: player) ── */
  /** The wire value of the current furniture pose, or null when there is no pose. net carries it in the snapshot as `fp` · `fu`. */
  readonly furniturePoseState?: FurniturePoseState | null;
  /**
   * Every buff · debuff on this character (`CharBuff`, in `CHAR_BUFF_ORDER`). player gathers progression (meals · preparations ·
   * the exercise debuff) · housing (the exercise session) · its own pose (rest · exercise) · its own environment test (exposure)
   * and swaps in a new array **only when something changed** (the same array means nothing changed — a consumer may compare by reference). Times are epoch ms of `ctx.net.serverNow() ?? Date.now()`.
   */
  readonly buffs?: readonly CharBuff[];
  /** +1 every time `buffs` changes (from 1). net carries it in the snapshot as `bfr`, and the receiver knows from this number whether its list is stale. */
  readonly buffsRevision?: number;
}

/* ══ appended (2026-09-11): the C-item batch contract (commit `36e15e3`, the contract) ══════ */

export interface EnemyManagerRef {
  /**
   * appended (2026-09-11, C-1 · X-6 — it had been a cast-only method of `EnemySystem` since 2026-09-08). Shove every alive
   * combatant within `radius` of `center` horizontally away from it (or along `dir` when given) at `speed` m/s, falling
   * off linearly to 40 % at the rim; a charging behemoth is not shoved (same rule as an explosion). Returns how many
   * were pushed.
   *
   * **Authority** applies the impulse to its own copies. **A replica** cannot move its enemies (the next snapshot would
   * overwrite them), so it forwards one `HitRequest { dmg: 0, kb }` per enemy in range to the host — the same way
   * `applyStatus` forwards `HitRequest.st` — and returns the number of requests sent. Callers never branch on role.
   */
  pushBack(center: THREE.Vector3, radius: number, speed: number, dir?: THREE.Vector3): number;
}

export interface PlayerRef {
  /* ── appended (2026-09-11, C-3): overcharge (owner: player; caller: implants `applyBoost`) ── */
  /**
   * Mark this player overcharged for `duration` seconds (`isOvercharged` true until then); 0 clears it. The caller
   * sets the matching speed modifier with `setSpeedModifier` itself — the two are no longer coupled by a key name.
   */
  setOvercharged?(duration: number): void;
}

/**
 * appended (2026-09-11, C-22): what a foot is standing on — picks the footstep sound. Add members, never rename.
 * Terrain bands map to the natural ones (호박빛 사막 `sand` · 동토 `snow` · 이끼 습지 `moss`/`mud` · 화산 `ash` ·
 * 적색 평원 `organic`, 경사 · 암반 `rock`, 둥지 점액 `organic`), obstacles by what they are (바위 `rock` · 크리스탈
 * `crystal` · 선로 · 전차 · 상자 · 불시착 함선 `metal` · 구조물 바닥 · 훈련장 `concrete`). `dirt` is the fallback and
 * sounds like the old single `footstep`. The ship (hub) is not a `WorldRef` — audio treats it as `metal` by phase.
 */
export type SurfaceMaterial =
  | 'dirt' | 'sand' | 'snow' | 'mud' | 'moss' | 'ash' | 'rock' | 'crystal' | 'organic' | 'metal' | 'concrete';

export interface WorldRef {
  /* ── appended (2026-09-11, C-22): per-material footsteps (owner: world; callers: audio · enemies) ── */
  /**
   * Material under `(x, z)`. With `feetY` the obstacle a body at that foot height stands on wins
   * (`getStandingObstacle` rules), otherwise the terrain band there. One hash query — cheap enough per footstep.
   * Optional so a world that has not generated yet (or a stub) may omit it; callers fall back to `'dirt'`.
   */
  getSurfaceMaterial?(x: number, z: number, feetY?: number): SurfaceMaterial;
}

/* ══ appended (2026-09-11): the lab — analyzer · extractor · mixer (A-11 · A-12 · A-13) ═════════
 *
 * Three strands meet in one room (`lab`):
 *   ① **Unidentified samples** (`ItemDef.sample`) are picked up in a raid — bug corpses · the new gather nodes · structure containers.
 *      (Rogues have no interest in samples — none come off a rogue corpse. User's decision 2026-09-11.)
 *   ② The **analyzer** reads one over that much real time and fills the **analysis catalogue** (`ShipState.sampleDex`); the
 *      fuller the catalogue, the faster the next reading. That reward is one of the two sources of new variety seeds (the other is wild gathering per planet).
 *   ③ The **extractor · mixer** are ordinary workbenches (`WorkbenchKind` += `'extract'` · `'mixer'`) — the extractor pulls
 *      ingredients out of crops · sample products, and the mixer makes **preparations** (`ItemDef.prep`) from them.
 *
 * A preparation is **loaded as one charge for the next raid when used in the ship** (user's decision): it piles up in
 * `PlayerProfile.prep`, moves to `prepActive` at the moment of launch and is kept for that whole raid (kept even on death),
 * and is emptied when the raid ends. Living in the profile is what keeps a person who reconnects from silently losing it (the 2026-09-10 convention).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A planet's standing environment (A-13, user's decision 2026-09-11 — only the two threat 3 planets). It is the `env`
 * column of `data/planets.csv`, and an empty cell means none. Being on that planet without the matching preparation takes
 * **hp only** at `PLANET_ENV_DPS` (an armor shield cannot stop the atmosphere). It is a soft gate — going there is never blocked.
 */
export type EnvKind = 'heat' | 'toxin';
export const ENV_KINDS: readonly EnvKind[] = ['heat', 'toxin'];

/**
 * Unidentified sample data (A-12, owner: items — `data/samples.csv`). Reading runs on **real time**, so it flows on while
 * away from the ship (the same convention as the greenhouse: `startedAt` / `readyAt` are epoch ms of
 * `ctx.net.serverNow() ?? Date.now()`, and once started **a running timer does not move** however much fuller the catalogue gets).
 */
export interface SampleDef {
  /** Real hours one reading takes with an empty catalogue. Catalogue progress · existing knowledge cut it down from here. */
  analyzeHours: number;
  /** What lands in hand when the reading finishes (bag → ship stash). */
  rewardDefId: string;
  rewardQty: number;
  /** What is added on top only on the **first** reading (= a sample not yet in the catalogue). Absent = no bonus. */
  firstDefId?: string;
  firstQty?: number;
}

/**
 * Preparation data (A-13, owner: items — the `prepEnv` · `prepShort` cells of `data/items.csv`). It is the one charge used
 * in the ship and carried into the next raid, and the same `env` cannot be loaded twice (the second is refused with a Korean reason — never swallowed silently).
 */
export interface PrepDef {
  /** The planet environment this preparation cancels. Loaded, that environment's damage becomes **0** (user's decision: a full cancel). */
  env: EnvKind;
  /** The short name stamped on the HUD badge (「방독」 · 「내열」). */
  short: string;
}

export interface ItemDef {
  /* ── appended (2026-09-11, owner: items) ── */
  /** category 'sample': how long the analyzer takes to read it, and what comes out. */
  sample?: SampleDef;
  /** category 'prep': which planet environment this one-raid charge blocks. */
  prep?: PrepDef;
}

export interface WorldRef {
  /* ── appended (2026-09-11, A-13): a planet's standing environment (owner: world; callers: player · ui · hub) ── */
  /**
   * The standing environment of this raid's planet, or null when there is none (null on the training range too). A thin
   * query that just returns `getPlanet(id)?.env` — world answers it so callers need not carry the planet id around.
   */
  readonly env?: EnvKind | null;
}

/* ══ appended (2026-09-11, A-3c · A-14 · A-15): the kitchen · the culture tank · the 3D printer ═════
 *
 * Puts **steps 5 and 6** of the user's six-step spec (the culture tank · the printer) and the **kitchen** into one cycle. The three are one chain:
 *
 *   raid sample `spec_*` ──analyzer──▶ cell line `strain_*` ───────┐
 *   greenhouse crop `crop_*` ──extractor──▶ medium `mat_medium_*` ─┴─culture tank──▶ culture product `cult_*`
 *        ├─ cook bench (`cook`) ──▶ a special dish ──▶ the dining table ──▶ **one meal slot** (one charge for the next raid)
 *        └─ extractor ──▶ 3 filament grades ──▶ printer (`print`) ──▶ rare · epic · legendary bags · the 4 pouches
 *
 * This chain gives the 8 crops their fourth consumer (the cook bench) and makes 「the higher a bag's rarity, the harder
 * the sample it comes from」 (user's decision) true through data alone.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * One derived stat a meal raises. Every value is a field name that **already exists** on `DerivedStats` — and that is the
 * point: making a buff a new concept would mean player · weapons · world · inventory all having to read that concept, while
 * folding it into a derived stat means **no consumer changes by a line** (they already read `ctx.progression.derived`).
 *
 * ⚠ There is **deliberately no** credits · sell-price multiplier. The server validates credits per reason (E-4), so a client
 * adding a multiplier simply gets the `credits:tx` refused. Reward-side buffs are paid in skill XP · gather yield · appraisal speed.
 */
export type MealBuff =
  | 'carryCapacity' | 'maxStamina' | 'staminaRegenMul' | 'healPowerMul' | 'gritChance'
  | 'skillGainMul' | 'gatherYieldMul' | 'searchSpeedMul'
  | 'detectRadius' | 'useSpeedMul' | 'interactSpeedMul' | 'durabilityLossMul';

export const MEAL_BUFFS: readonly MealBuff[] = [
  'carryCapacity', 'maxStamina', 'staminaRegenMul', 'healPowerMul', 'gritChance',
  'skillGainMul', 'gatherYieldMul', 'searchSpeedMul',
  'detectRadius', 'useSpeedMul', 'interactSpeedMul', 'durabilityLossMul',
];

/** A buff whose name ends in `*Mul` is **added to the multiplier** (0.15 = +15 %); the rest are added in that stat's own unit. */
export const isMealBuffMultiplier = (b: MealBuff): boolean => b.endsWith('Mul') || b === 'gritChance';

/**
 * Meal data (A-3c, owner: items — `data/meals.csv`). One meal raises **one buff** only (user's decision: one per meal,
 * mixing survival-side and reward-side ones). Eaten at the ship's dining table it loads as one charge for the next raid,
 * and its lifetime rules are exactly a preparation's (`PlayerProfile.meal` → `mealActive`, kept for that raid even on death).
 */
export interface MealDef {
  buff: MealBuff;
  /** The added value. A buff that `isMealBuffMultiplier` is added to the multiplier, the rest in their own unit. Only `durabilityLossMul` is negative. */
  amount: number;
  /**
   * 1 = a vegetable dish (crops only) · 2 = a meat-paste dish · 3 = a meat · animal-fat dish · 4 = an egg-white · milk-protein dish. For tooltips · sorting.
   * (Widened by the 2026-09-13 cooking material tiers — the old 「2 = a special dish」 is only the four retired meals. The labels are `MEAL_TIER_LABEL_KO`.)
   */
  tier: 1 | 2 | 3 | 4;
}

/**
 * Pouch data (A-15, owner: items — `pouchCols` · `pouchRows` · `pouchAccepts` of `data/items.csv`).
 *
 * A pouch is **not a bag** — it is a separate container fitted into the one `pouch` equipment slot, and equipping it
 * opens its own grid under the quick slots (user's decision). Exactly the pattern 「the quick slots are not the bag grid」
 * set on 2026-09-09: weight · `countWhere` · `consumeWhere` · `stripForCorpse` · the raid blob all look at the pouch,
 * while `getAllItems()` (the trade · repair lists) is **still the bag grid only**.
 */
export interface PouchDef {
  cols: number;
  rows: number;
  /** The item categories this pouch accepts. The grid refuses anything else. */
  accepts: readonly ItemCategory[];
}

/**
 * Cell line · strain data (A-14, owner: items). The product of an analyzer reading, put into a culture tank cell **after a
 * medium has been poured in**. The culture time is fixed into `readyAt` the moment it goes in (the same convention as the greenhouse · analyzer).
 */
export interface StrainDef {
  outputDefId: string;
  outputQty: number;
  /** Culture time (hours) on a basic medium. The medium's grade (`MediumDef.speedMul`) and the 원예 skill cut it from here. */
  cultureHours: number;
}

/**
 * Nutrient medium data (A-14, owner: items). Made at the extractor — a new consumer of greenhouse produce.
 * The same wear convention as soil: it wears **once per harvest** and at 0 the cell is completely empty.
 *
 * Unlike soil's tag matching, a medium has **only a grade** (the judgement was that a second axis has no reason to exist).
 */
export interface MediumDef {
  /** How many harvests this medium survives. */
  uses: number;
  /** Culture time multiplier (1 = base, 0.75 = 25 % faster). */
  speedMul: number;
}

export interface ItemDef {
  /* ── appended (2026-09-11, A-3c · A-14 · A-15; owner: items) ── */
  /** category 'meal': which derived stat this one-raid charge raises, and by how much. */
  meal?: MealDef;
  /** category 'pouch': the separate grid that opens when it is fitted into the `pouch` equipment slot. */
  pouch?: PouchDef;
  /** A cell line · strain (category 'material'): what the culture tank makes from it and how long that takes. */
  strain?: StrainDef;
  /** A nutrient medium (category 'material'): what is poured into a culture tank cell. */
  medium?: MediumDef;
}

export interface InventoryRef {
  /* ── appended (2026-09-11, A-15): pouches (owner: inventory; callers: ui · housing) ── */
  /** The pouch item equipped right now, or null. */
  getEquippedPouch?(): ItemInstance | null;
  /** The grid size of the equipped pouch. `{ cols: 0, rows: 0 }` with no pouch — meaning that whole area is not drawn at all. */
  getPouchSize?(): { cols: number; rows: number };
}

/* ══ appended: 2026-09-12 — consumables · implants · keys · the drone scan · favourites · the gym ══
 * Each parallel agent appends **inside its own block only** (interface merging — written inside `export interface PlayerRef { … }`).
 * Existing declarations are never renamed or deleted. The block order is never changed. */
/* ── [A1] the 3 consumables (PlayerRef boost · ItemDef) ── */
/**
 * The timed effect a consumable applies (2026-09-12, owner: player — `parts/Boosts`). Only one at a time: a new one clears the previous.
 *   `adrenaline` 아드레날린 주사 — full stamina + zero continuous drain (`BOOST_ADRENALINE_DURATION_S`)
 *   `stimulant`  각성제 — faster reload · faster ADS · less aim sway / more stamina drain (`BOOST_STIMULANT_*`)
 * 안정제 (the implant refill) is not a timed effect, so it is not here — weapons calls `ImplantsRef.refillAll`.
 */
export type BoostKind = 'adrenaline' | 'stimulant';

export interface PlayerRef {
  /* ── appended (2026-09-12, A1): consumable effects (owner: player; caller: weapons `parts/Healing.finishHeal`) ── */
  /**
   * Start (or restart) a timed boost. `defId` = the item that caused it (the buff thumbnail draws its icon / name).
   * `adrenaline` also refills the stamina bar at once. Starting one clears the other kind.
   */
  applyBoost?(kind: BoostKind, defId?: string): void;
  /** The boost running now (`remaining` / `duration` in seconds of `ctx.time`), null when none. */
  readonly boost?: { kind: BoostKind; remaining: number; duration: number; defId: string | null } | null;
  /** Aim-sway multiplier (1 normally, `BOOST_STIMULANT_AIM_SWAY_MUL` under 각성제). Read by the camera sway (A2). */
  readonly aimSwayMul?: number;
  /** Reload speed multiplier from boosts (>1 = faster; 1 normally). weapons multiplies the class skill multiplier with it. */
  readonly boostReloadSpeedMul?: number;
  /** ADS transition speed multiplier from boosts (>1 = faster; 1 normally). Applied by player to the ADS blend rate. */
  readonly adsSpeedMul?: number;
  /** Stamina cost multiplier from boosts for continuous drains (sprint · ladder · hover): 0 under 아드레날린, 1.5 under 각성제. */
  readonly staminaDrainMul?: number;
  /** Stamina cost multiplier from boosts for one-off costs (jump · roll · melee · bash): 1.5 under 각성제, else 1. */
  readonly staminaCostMul?: number;
}
/* ── end [A1] ── */
/* ── [A2] aim sway ── */
export interface PlayerWeaponHost {
  /**
   * Aim sway (2026-09-12, weapons → player): the ADS sway of the weapon class in hand — the maximum horizontal angle (degrees) and the sweep frequency (Hz)
   * (`data/aim_sway.csv`). 0 = no sway (no weapon in hand · holstered · a unique whose RMB is the alternative fire). Called beside
   * `setAimZoom` on every equip · swap · unequip. The real sway is grown and shrunk by player from the ADS amount · stance · movement · `aimSwayMul`.
   */
  setAimSway?(amplitudeDeg: number, frequencyHz: number): void;
}
/* ── end [A2] ── */
/* ── [B] tactical implants (`ImplantsRef` lives in shared/implants.ts) ── */
/* ── end [B] ── */
/* ── [C] keys · keycards · the locked room · the crawl vent (WorldRef.resolveCollision height · previewContainerItems) ── */
export interface WorldRef {
  /**
   * appended (2026-09-12, C): the push-out for a body **that stated its height**. Given `height`, a floating box (a lintel · a slab · a tram floor)
   * is measured by **that height** instead of a person's `BOX_HEADROOM` — one whose underside is higher than `feet + height` passes overhead.
   * It is the only way a ground drone (`GroundDrone`) gets through the **crawl vent** beside a locked door (the wall gap whose lintel underside sits just above the drone's height).
   * Not passing it is not one line different from before (players · enemies · remotes · thrown objects).
   */
  resolveCollision(position: THREE.Vector3, radius: number, height?: number): THREE.Vector3;
  /**
   * appended (2026-09-12, C): **what would come out if this client opened** a container world owns (a structure's ground floor `_c` ·
   * basement `_b` · locked room `_l` · a rail platform · a tram · a map crate) — the extra key · keycard roll included. It is the
   * **same function** the opening code uses, so the two cannot drift. Pure and deterministic (no opened flag · no event · no cache).
   * Null when it is not world's or the world is not ready. The **current** contents of an already-opened container are the inventory cache's answer (this function does not know them).
   */
  previewContainerItems?(containerId: string): ItemInstance[] | null;
}
export interface StructureDef {
  /** appended (2026-09-12, C): does it have a **locked room** on the upper floor (only a lab that got a second floor). Absent = false/undefined. */
  hasLockedRoom?: boolean;
  /** Position of the locked room's door (the centre of the door's bottom edge). Absent = null/undefined. */
  lockedRoomDoor?: THREE.Vector3 | null;
  /**
   * The def id of the item that opens this structure's locked door (basement · locked room — at most one per structure).
   * Since 2026-09-21 it is planet-bound and built as `<family>_<mission planet>`: `key_basement_amber` the basement key
   * of 아켈론 II · `keycard_lab_crimson` the lab keycard of 카민 I, and so on. Null/undefined when there is no locked door.
   * One of the opener's is consumed. `unlocked` is the state of that single door.
   */
  unlockDefId?: string | null;
}
/* ── end [C] ── */
/* ── [D] the ground drone scan ── */
export interface InventoryRef {
  /* ── appended (2026-09-12, the drone scan; owner: inventory `parts/Peek`, caller: gadgets/drones `parts/Scan`) ── */
  /**
   * What a container would show if opened now, **without opening it**. For a container this client has already rolled (opened) it is
   * what is inside now; otherwise `tier` (≥ 1) reproduces the **same** deterministic roll as `openContainer` (`missionSeed ^ hash(id)` ·
   * the planet curve) + the same grid fill (overflow dropped) + the takes others already confirmed (`pendingTaken`). Null for an unknown id with no `tier`.
   * It changes nothing — not the cache, `openedIds`, the appraisal state or any event. The returned list is **read-only**.
   */
  peekContainerItems?(containerId: string, tier?: number): readonly ItemInstance[] | null;
  /**
   * The same query for a container whose contents the caller supplies (a corpse · a structure container holding a key). Without
   * `cols` the fill is `openContainerItems`'s (6×4 by default); with it, `openContainerItemsSized`'s (rows grown so everything fits).
   * For an id already rolled, `items` is ignored and the current contents come back. Read-only.
   */
  peekSuppliedItems?(containerId: string, items: readonly ItemInstance[], cols?: number, rows?: number): readonly ItemInstance[];
}
/* ── end [D] ── */
/* ── [E1] the favourites core (InventoryRef) ── */
export interface InventoryRef {
  /* ── appended (2026-09-12, E1): item favourites (owner: inventory; callers: meta · the ui chip delegation) ──
   * A favourite is per **item kind (def id)** — every copy of that item is marked. It is per character and rides in the
   * `fav` list of the loadout document (`loadout`), synced with the server. An item you do not own can be turned on too. */
  /** Is this item kind a favourite. */
  isFavorite?(defId: string): boolean;
  /**
   * Turn a favourite on or off. Given `on` it is set to that; omitted it is toggled. The returned value is the **new state**.
   * An unknown def id changes nothing and returns false. When something really changed, `inventory:favoritesChanged` fires.
   */
  toggleFavorite?(defId: string, on?: boolean): boolean;
  /** Every def id favourited right now (sorted, a read-only copy). */
  readonly favoriteDefIds?: readonly string[];
}
/* ── end [E1] ── */
/* ── [E2] the favourite chip · the item recovery contract ── */
/* ── end [E2] ── */
/* ── [F] the gym minigame ── */
/* ── end [F] ── */

/* ══ appended: 2026-09-12 — the item recovery contract: the 「found in this raid」 mark (§5-2, rules in `shared/raidFound.ts`) ═ */
export interface ItemInstance {
  /**
   * **The map seed of the raid that made** this instance (`WorldRef.seed`, `>>> 0`). Only raid loot rolls stamp it (crates · containers ·
   * supply · enemy corpses · gathering); anything brought from the ship · crafted · bought · issued has none. It travels with the item —
   * the pickup wire (`PickupWire.rf`) · the corpse wire (`CorpseItemWire.rf`) · the raid session blob (`SavedExtras.rf`). **Omitted = not found in a raid.**
   * It is not carried in the profile documents (stash · loadout), and inventory clears it when the raid ends.
   */
  raidFound?: number;
}
/* ══ end 2026-09-12 the item recovery mark ══ */

/* ══ appended: 2026-09-13 — cooking material tiers (user's decision) ════════
 *
 *   T1  planet seeds · soil ──grow station──▶ vegetables · mushrooms ──cook bench──▶ a vegetable dish (stat 1)
 *   T2  unidentified cells ──analyzer──▶ cow · pig · chicken · sheep cell lines ─┐
 *       crops ──extractor──▶ nutrient medium ────────────────────────────────────┴─culture tank──▶ meat paste ─┐
 *       unidentified minerals ──analyzer──▶ rock-salt crystal ──extractor──▶ salt ─────────────────────────────┴─cook bench──▶ a paste dish (stat 2)
 *   T3  unidentified cells ──analyzer Lv.3──▶ microalgae cell line ──culture tank──▶ cellulose ──mixer──▶ a culture scaffold
 *       medium + scaffold + cell line ──culture tank──▶ meat by species · cultured-fat cell line ──culture tank──▶ animal fat ──cook bench──▶ a meat dish (stat 3)
 *   T4  unidentified DNA ──analyzer Lv.3──▶ egg-white · milk-protein cells ──extractor──▶ ingredients ──mixer (+ animal fat · salt)──▶ eggs · milk · cheese
 *       ──cook bench──▶ a dairy dish (stat 4)
 *   socket  unidentified DNA ──analyzer──▶ soil · medium sockets ──▶ permanently fitted into a grow cell's soil · a culture cell's medium
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The **family** of an unidentified sample (user's decision: samples merged down to 3 kinds). The analyzer's result table
 * and its analysis level are per family. The only new drops are `spec_cell` · `spec_mineral` · `spec_dna`, and the 11 old
 * samples keep their defs (`ItemDef.retired`) and are read as a sample of their own family — nothing already owned disappears.
 */
export type SampleFamily = 'dna' | 'mineral' | 'cell';
/** The display order of the families (the analysis catalogue · the rail). */
export const SAMPLE_FAMILIES: readonly SampleFamily[] = ['cell', 'mineral', 'dna'];

export interface SampleDef {
  /**
   * appended (2026-09-13): the family this sample is read as. The result is drawn from the family's result table
   * (`ANALYSIS_RESULTS` in `shared/housing`) — `rewardDefId` · `rewardQty` are now only **the fallback output when that table is empty**, and the `first*` bonus is no longer paid.
   */
  family: SampleFamily;
}

/** Where a socket is fitted — the soil poured into a grow cell (`soil`) · the medium poured into a culture cell (`medium`). */
export type GrowSocketTarget = 'soil' | 'medium';
export const GROW_SOCKET_TARGETS: readonly GrowSocketTarget[] = ['soil', 'medium'];

/**
 * Socket effects. `speed` · `yield` work only in proportion to **that cell's soil · medium durability ratio** (`wear` is the exception, as it protects the durability itself):
 *  - `speed` — grow · culture time −amount (fixed into `readyAt` the moment it is planted · put in; the floor of the summed multiplier is `GROW_SOCKET_TIME_FLOOR`)
 *  - `yield` — on harvest, +1 unit at `amount` probability per socket
 *  - `wear`  — the durability worn per harvest −amount (the floor of the summed multiplier is `GROW_WEAR_MUL_FLOOR`)
 */
export type GrowSocketEffect = 'speed' | 'yield' | 'wear';
export const GROW_SOCKET_EFFECTS: readonly GrowSocketEffect[] = ['speed', 'yield', 'wear'];

/** Socket data (owner: items — `data/sockets.csv`). Once fitted it never comes out (user's decision: fitting over one destroys the old). */
export interface GrowSocketDef {
  target: GrowSocketTarget;
  effect: GrowSocketEffect;
  /** `speed` · `wear` = a ratio (0.1 = 10 %), `yield` = the probability of +1 unit (0 … 1). */
  amount: number;
}

export interface SoilDef {
  /**
   * appended (2026-09-13): maximum durability. Poured soil wears by `SOIL_WEAR_PER_HARVEST` per harvest and **is still used at 0** —
   * only the matching bonus (`SOIL_MATCH_SPEEDUP`) and the socket effects shrink with the `durability / max` ratio and vanish at 0. The mismatch penalty is unchanged.
   * `uses` is used only to move an old save's `soilUsesLeft` over to durability.
   */
  durability: number;
}

export interface MediumDef {
  /**
   * appended (2026-09-13, user's decision: the same durability rule as soil): maximum durability. It wears by `MEDIUM_WEAR_PER_HARVEST`
   * per harvest and is still used at 0 — the medium's speed bonus (`1 − speedMul`) and the socket effects shrink with the durability ratio. `uses` is only for migrating an old save.
   */
  durability: number;
}

export interface StrainDef {
  /**
   * appended (2026-09-13, T3): with a **culture scaffold** in the culture cell, this is made instead of `outputDefId` (meat by species).
   * The three are present together or absent together — a cell line without them (microalgae · cultured fat) cannot go into a cell holding a scaffold.
   */
  scaffoldOutputDefId?: string;
  scaffoldOutputQty?: number;
  /** Culture time (hours) on a basic medium — when a scaffold is present. */
  scaffoldHours?: number;
}

/** One stat rise attached to a meal buff. */
export interface MealEffect {
  buff: MealBuff;
  /** Added to the multiplier when `isMealBuffMultiplier`, otherwise in its own unit (`durabilityLossMul` is negative). */
  amount: number;
}

export interface MealDef {
  /**
   * appended (2026-09-13, user's decision: 「the buff itself is one, and several stat rises hang off that one buff」). Every
   * stat this meal raises — the higher the tier the bigger the numbers and the more rows (T1 1 · T2 2 · T3 3 · T4 4). **Consumers read this.**
   * `buff` · `amount` equal `effects[0]` (kept for old call sites — new code does not use them).
   */
  effects: readonly MealEffect[];
}

export interface ItemDef {
  /* ── appended (2026-09-13, cooking material tiers; owner: items) ── */
  /** category 'socket': a permanent upgrade fitted into poured soil · a medium. */
  growSocket?: GrowSocketDef;
  /** A culture scaffold (category 'material'): put into a culture cell after the medium · before the cell line and that cell makes meat by species. Consumed on harvest. */
  scaffold?: boolean;
  /**
   * A retired item (the 11 old samples · 5 old cell lines · 5 culture products · 4 special dishes). The def stays (what is
   * already owned does not disappear) and it drops out of **every source** (loot · shops · recipe outputs · analysis results · gather sites · culturing). `npm run data:check` catches the references.
   */
  retired?: boolean;
}
/* ══ end 2026-09-13 cooking material tiers ══ */

/* ══ appended: 2026-09-13 — the cooking minigame · meal quality (`src/housing/README.md` Decisions, rules in `shared/cooking.ts`) ═ */
export interface ItemInstance {
  /**
   * The quality of a meal (`ItemDef.meal`) — a star count 0 … `MEAL_QUALITY_MAX`. The cook bench minigame's score decides it (`mealQualityForScore`).
   * Omitted = 0 (old meals · loot · anything that is not a meal). **Different quality means the same def does not merge** (the inventory's stack key).
   * Unlike `raidFound` it **is carried in the stash · loadout documents too** (`SavedExtras.q`) — and in the pickup · corpse wires (`PickupWire.q` · `CorpseItemWire.q`) ·
   * and the raid blob. Any path that splits or copies a stack carries this field over (omitting it drops the quality to 0).
   */
  quality?: number;
}

export interface InventoryRef {
  /* ── appended (2026-09-13, the cooking minigame · meal quality; owner: inventory) ── */
  /** How many of `defId` in the bag + stash sit at exactly quality `quality` (`quality` 0 includes items with no quality field). */
  countDefQualityAll?(defId: string, quality: number): number;
  /** Remove `qty` of `defId` at exactly quality `quality`, bag first → then the stash. All or nothing; false when short. */
  consumeDefQualityAll?(defId: string, quality: number, qty: number): boolean;
  /** The meals owned (`ItemDef.meal`) merged per (def, quality) (bag + stash) — the dining table screen. Ordered tier → def → highest quality. */
  getMealStacks?(): { defId: string; quality: number; qty: number }[];
  /**
   * The Korean reason why cook-bench recipe `recipeId` cannot be made once **right now** (null = it can) — the same gate as ship
   * crafting: is it a cook-bench recipe · is `benchLevel` at least the recipe's bench level · skill · materials (`craftCost`) · room for the one output (stash → bag).
   */
  cookBlock?(recipeId: string, benchLevel: number): string | null;
  /**
   * Finish one cook — it re-checks `cookBlock`, takes the materials and puts the output at quality `quality` into **the stash first → the bag**.
   * `inventory:itemAdded` · `craft:completed {recipeId, item, count:1}` (skill XP · the tutorial · the toast all still live). On failure nothing is taken.
   */
  completeCook?(recipeId: string, benchLevel: number, quality: number): { item: ItemInstance | null; landed: 'bag' | 'stash' | null; reason: string | null };
}
/* ══ end 2026-09-13 the cooking minigame ══ */

/* ══ appended: 2026-09-16 — the dining table plate (a meal is not an item; the plate section of `shared/housing.ts`; owner: inventory) ═
 * Cooking produces no output — housing puts a plate on the dining table. All the inventory does is take the materials.
 * `completeCook` keeps its name as contract but has no implementation (an optional method). `cookBlock` no longer looks for room for an output. */
export interface InventoryRef {
  /**
   * Take the materials of one cook (re-checking `cookBlock`, bag first → then the stash). There is no output. A Korean reason / null.
   * On failure nothing is taken.
   */
  consumeCookInputs?(recipeId: string, benchLevel: number): string | null;
}
/* ══ end 2026-09-16 the dining table plate ══ */

/* ══ appended: 2026-09-13 — the exploration vehicle (rover). This header comment is the original of the user's decisions ═
 * Each parallel agent appends **inside its own block only**. Existing declarations are never renamed or deleted.
 *
 * The exploration vehicle = **one per raid**, a driverless armoured car nobody pilots (unlike Tarkov's BTR there is no driver).
 *   - With no rails it **circles** 4–5 stations along a **closed ring route** (a rutted dirt road), stopping `ROVER_DWELL_S` (60) at each.
 *     A station stands on flat ground beside the route as a marker post, placed as far from the others as possible and clear of other structures. The route corridor is kept clear like a rail line.
 *   - While stopped (`stopped` · `departing`) an E hold (`ROVER_BOARD_HOLD_S`) = boarding. The character **hides inside the vehicle** and cannot use weapons · items · ship calls,
 *     and the camera becomes a **mouse-orbit third person** on the vehicle. A rider **takes no damage at all** (hazards · the planet environment included) — only the vehicle is hit.
 *   - The moment anyone first boards, **every station position stays on the whole squad's map for the rest of the raid** (before that, only stations found through the fog).
 *   - With a rider aboard and nothing paid, the dwell timer stops (it waits). When **one rider pays the fare for everybody** (proportional to the route distance, `ROVER_FARE_MIN`–`MAX`),
 *     it goes **straight** to the target station after a `ROVER_DEPART_GRACE_S` (5) grace (the short way round the ring). People may board and exit during the grace,
 *     and once it has departed neither is possible. On arrival **everyone is forced off** and it resumes circling from a dwell at that station.
 *   - While moving (`patrol` · `trip`) it shoots enemies within a narrow radius. Hp `ROVER_HP` (2000). **Only enemies and hazards** damage it (player weapons · explosions do nothing).
 *     Inside a hazard zone it takes `ROVER_HAZARD_DAMAGE_MUL` (5)× the hazard damage. Destroyed, riders are put out on the spot at once and it is unusable for that raid (wreckage remains).
 *     There is no refund for destruction or for an accident on the way.
 *   - A station swallowed by a hazard cannot be chosen as a destination (a trip already under way still goes), and a vehicle standing at one refuses boarding.
 * Authority: **the host** (as with the tram — the route is seed-deterministic, the wire carries `s` · state · hp · riders). The fare is paid by the payer's own client with `credits:tx`.
 * Owners: world/rover (route planning · the dirt road · stations · the vehicle · sync), player (ride mode · the orbit camera · damage immunity), enemies (targeting the vehicle),
 *       ui/map (stations · the route · picking a destination), server (fare validation).
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** `stopped` dwelling at a station · `departing` the grace after payment · `patrol` circling empty · `trip` a paid run · `destroyed` wrecked (for the rest of the raid). */
export type RoverState = 'stopped' | 'departing' | 'patrol' | 'trip' | 'destroyed';
/** Wire order (`RoverWire.st` is an index into this array). Never reorder. */
export const ROVER_STATES: readonly RoverState[] = ['stopped', 'departing', 'patrol', 'trip', 'destroyed'];
/** What the rover passes to `EnemyRef.takeDamage(…, attacker)` when it hits an enemy — enemies gives no kill credit and pulls aggro onto the vehicle. */
export const ROVER_DAMAGE_SOURCE = 'rover';

export interface RoverStationDef {
  /** `rst<n>` — alphanumeric only (it rides verbatim in the credit reason `rover:<from>:<to>`). */
  id: string;
  /** Route order 0..n-1 (ascending `s`). */
  index: number;
  /** The on-screen name (`정류장 A` …). */
  label: string;
  /** The point on the route the vehicle stops at (y = the road surface). */
  position: THREE.Vector3;
  /** Where the marker post stands (beside the route, y = the ground). Fog discovery · hazard tests · map markers use this point. */
  polePosition: THREE.Vector3;
  /** Travelled distance along the route (m) — the vehicle stops at this `s`. */
  s: number;
}

export interface RoverRouteDef {
  /** The dirt road's centre line (y = the road surface). A **closed ring** — the last → first point joins up. Circling empty always runs in the +s direction. */
  points: readonly THREE.Vector3[];
  /** Total length of the ring (m, the closing segment included). */
  length: number;
  /** In route order (ascending `s`). */
  stations: readonly RoverStationDef[];
}

/** The vehicle's live state (the host simulates it and clients interpolate). The object is reused — never keep it, read it and use it at once. */
export interface RoverVehicleDef {
  /** The bottom centre of the body (y = the road surface). */
  position: THREE.Vector3;
  /** The body's facing. Same convention as `TramDef.yaw`: forward = `(cos yaw, 0, sin yaw)` (the map draws it rotated by `-yaw`). */
  yaw: number;
  state: RoverState;
  /** Travelled distance along the route (m). Host-authoritative. */
  s: number;
  /** The current direction of travel (+1 / −1). Circling empty is +1, a paid run takes the short way. */
  dir: 1 | -1;
  hp: number;
  maxHp: number;
  /** The id of the station it stands at (`stopped` · `departing`), else null. */
  stationId: string | null;
  /** `departing` · `trip` = the paid destination, `patrol` = the next station, otherwise null. */
  targetId: string | null;
  /** `stopped` = seconds of dwell left (it does not count down while a rider is aboard) · `departing` = seconds until departure · otherwise 0. */
  timer: number;
  /** The riders — as seen from this client the local player is `'local'`, the rest are PeerIds. */
  riders: readonly string[];
}

export interface RoverRef {
  readonly route: RoverRouteDef;
  readonly vehicle: Readonly<RoverVehicleDef>;
  /** Has someone boarded once, revealing every station (shared by the squad · for the rest of the raid). On reveal, `rover:stationsRevealed`. */
  readonly stationsRevealed: boolean;
  /** Is the local player aboard right now. */
  readonly localAboard: boolean;
  /** Is this station (its marker post) inside a hazard damage zone right now. */
  isStationSwallowed(stationId: string): boolean;
  /** The paid-run distance from the station it stands at to `stationId` (m, the short way round the ring). Null when it is not stopped, or for the same station. */
  tripDistance(stationId: string): number | null;
  /** The fare for that distance (credits, for everybody). Null when `tripDistance` is null. **The only source of the fare formula** — the map draws this. */
  fareTo(stationId: string): number | null;
  /**
   * The Korean reason the local player **cannot** pay to depart for `stationId` right now, or null when they can.
   * (not aboard · not stopped · already paid · the same station · a hazard zone · not enough credits · destroyed)
   */
  tripBlock(stationId: string): string | null;
  /** Request payment + departure. Null when the request went out, else the `tripBlock` reason. Confirmed by `rover:tripStarted`, refused by `rover:refused`. */
  requestTrip(stationId: string): string | null;
  /** Can enemies target it (it is not destroyed). enemies looks at this when building its target list. */
  readonly targetable: boolean;
  /** The body's collision dimensions (m): half-length (forward axis) · half-width · height. The box = an OBB from `vehicle.position` up by `height`, turned by `vehicle.yaw`. */
  readonly halfLength: number;
  readonly halfWidth: number;
  readonly height: number;
  /**
   * Apply enemy damage. Only applied on the host · in single player (ignored when called on a replica). Hazard damage is applied by world itself, so it does not call this.
   * Player weapons · gadgets · ship calls never call it (user's decision: enemies · hazards only).
   */
  damage(amount: number, from?: THREE.Vector3): void;
}

export interface WorldRef {
  /* ── appended (2026-09-13): the exploration vehicle (owner: world/rover) ── */
  /** This raid's rover. Null on the training range · on a map where no route could be laid · before the world is ready. */
  readonly rover?: RoverRef | null;
}

/** The handle ride mode gives player (owner: built by world/rover, read by player). The vectors are **live** — read them every frame. */
export interface RoverRideBinding {
  /** The world position the rider's feet sit at (inside the body). player moves the body here every frame (the fog · the map · snapshots use this position). */
  readonly seat: THREE.Vector3;
  /** The centre the orbit camera turns around (above the body's roof). */
  readonly focus: THREE.Vector3;
  /** The body's yaw (the `RoverVehicleDef.yaw` convention) — used to put the camera behind the vehicle at the moment of boarding. */
  readonly yaw: number;
  /** The orbit camera's default distance (m). */
  readonly cameraDistance: number;
  /** Can an E hold get you off right now. False and player does not start the hold, showing `lockedPrompt` as the prompt instead. */
  readonly canExit: boolean;
  /** The prompt shown while getting off is blocked (`이동 중 — 하차 불가`). */
  readonly lockedPrompt: string;
  /** The E hold (`ROVER_EXIT_HOLD_S`) finished. When world confirms it, it calls `setRoverRide(null, <the spot to step down on>)` (a refusal is `rover:refused`). */
  requestExit(): void;
}

export interface PlayerRef {
  /* ── appended (2026-09-13): riding the exploration vehicle (owner: player; caller: world/rover) ── */
  /** Is the body aboard the rover. */
  readonly roverRide?: boolean;
  /** The Korean reason boarding is **not** possible right now (dead · downed · carrying · being carried · on a ladder · in drone control · inside a ship/pod), or null when it is. */
  roverBoardBlock?(): string | null;
  /**
   * Board / exit. With a `binding`: the body is hidden (model · shadow — `PlayerFlags.IN_ROVER` for remotes), movement · jump · stance · weapons ·
   * interaction · quick slots · implants · ship calls · pings · the comms wheel are blocked (hung on the same gates that watch `droneControl`), **all damage is
   * ignored** (`takeDamage` · knockback · hazards · the planet environment), the body is put at `seat` every frame, and the camera orbits `focus` on the mouse.
   * An E hold = when `canExit`, the exit hold → `requestExit()`. Tab (the inventory) · M (the map) · chat · Esc still work as usual.
   * With `null`: the body is stood at `exitAt` (where it is now when omitted), made visible again, and the camera hard-cuts back behind the PC.
   * `game:abort` · `game:newMission` · `respawnAt` · `spawnStanding` release it themselves. Already in the same state, it does nothing.
   */
  setRoverRide?(binding: RoverRideBinding | null, exitAt?: THREE.Vector3): void;
  /**
   * appended (R3, player): while aboard, writes into `out` and returns the ground `ROVER_SAFE_SIDE_M` to the vehicle's right (collision push-out included), else null.
   * The raid save (game) uses this spot so it never stores a seat inside the hull — and death · a reset releasing the ride stands the body on the same spot.
   */
  roverSafePosition?(out: THREE.Vector3): THREE.Vector3 | null;

  /* ── appended (2026-09-14): the tutorial opening (owner: player; caller: tutorial) ── */
  /**
   * The tutorial's first scene — it starts in a **collapsed pose** and the body gets up over `durationS` seconds. Through it,
   * movement · stance · weapon · interaction input is locked and player/ holds the camera (on the fallen body, then a **hard cut**
   * to the usual third-person back view as the body rises). `player:introWakeDone` when it ends. It does nothing while already running.
   * `game:abort` · `game:newMission` · death release it themselves.
   */
  /*
   * `opts` appended (2026-09-15, user's decision — a tutorial revival also rises from the ground): with `respawn: true` it is a
   * **revival shot** — no fade to black (`ui:screenFade`), and no opening camera · compass fade · Tab lock · `player:introWakeDone`
   * either (only the collapsed pose → get-up animation and the input lock). Omitted = the opening as it is.
   */
  playIntroWake?(durationS: number, opts?: { respawn?: boolean }): void;
  /**
   * appended (2026-09-14, owner: player; callers: ui/hud/Compass · inventory): the opening wake-up shot is **still running** —
   * the body is rising and the camera has **not fully returned** to the usual third-person back view. Through it the compass is not
   * drawn (it fades in once it ends) and Tab does not bring up the bag (user's decision). It goes false on the frame `player:introWakeDone` fires.
   */
  readonly introWaking?: boolean;
  /**
   * **Sets hp outright** — the place where a scripted scene decides the state of the body. The only user today is the tutorial
   * (the person waking in the ruins is **on a sliver of hp**, so one hit from a bug kills — the user's spec).
   * It raises no hit feedback · direction arc · sound and **does not touch the shield**; dead or downed it does nothing.
   * It never goes below 1 (this function does not kill anyone — killing is `takeDamage`'s job).
   */
  setHp?(hp: number): void;

  /* ── appended (2026-09-14 3rd pass, owner: player; caller: extraction) ── */
  /**
   * The **scene lock** — movement · stance · jump · roll · aim · weapons · interaction · mouse look are locked, and all
   * incoming damage is ignored (neither shield nor hp moves, and there is no downed and no death). The camera is left
   * alone — as in the liftoff shot, something else is already holding it.
   *
   * The only user today is the tutorial ship's liftoff (pressing the switch lifts it at once, and through that the player
   * must be unable to leave the ship or to die — user's decision). `game:abort` · `game:newMission` · returning to the ship release it themselves.
   */
  /*
   * `opts` appended (2026-09-15, user's decision — you depart **while being shot** by the android you did not kill): with
   * `allowDamage: true` the input lock stays but damage **does land** — except that hp never drops below `minHp` (1 by
   * default) and there is no downed and no death. Omitted = as before (all damage ignored).
   */
  setSceneLock?(on: boolean, opts?: { allowDamage?: boolean; minHp?: number }): void;
}
/* ══ end 2026-09-13 the exploration vehicle ══ */

/* ══ appended (2026-09-13): library series · video games — `src/housing/README.md` Decisions (rules in `shared/library.ts`) ═ */
import type { GameConsoleDef, GameDiscDef } from './library';
export interface BookDef {
  /**
   * The series id (`data/library_series.csv`) — the effect is decided by that series' effect row. Since 2026-09-13 every book · video · record has one.
   * ⚠ So `skill` is only the **representative skill** (for sorting · grouping the catalogue) and is not used in the effect maths — a series with no skill effect names the nearest skill.
   */
  series?: string;
  /** Volume number, 1 … the series' volume count. */
  volume?: number;
}
export interface ItemDef {
  /** category 'game_disc': slotted into the game-disc rack and played on the TV. */
  gameDisc?: GameDiscDef;
  /** category 'console': the games console mounted on the TV. */
  gameConsole?: GameConsoleDef;
}
/* ══ end 2026-09-13 library series ══ */

/* ══ appended (2026-09-14): the intel broker's map preview — `src/meta/README.md` Decisions ══════════
 *
 * The intel broker screen shows **the real layout of the sector on sale** as a faint grid (user's decision). For that,
 * `hub/` must build no mesh at all and only receive the result of `generateLayout` — but `WorldLayout` is a `world/`
 * internal type and folders never import each other (CLAUDE.md). So the contract is **one line, `ctx.world.previewLayout(...)`** —
 * it goes through the **same code** as real generation (`world/preview.planLayoutFor`), so the preview cannot lie
 * (the same rule as 「previewing without opening must be the same function as opening」).
 *
 * Every value is **flat data** — no THREE object and no `world/` type leaks out. The coordinate system is world XZ (m) with the origin at the map centre.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

import type { IntelEffects } from './intel';

/** One circle on the preview map (world XZ, radius in m). */
export interface MapPreviewSpot { x: number; z: number; r: number }

/** The result of `WorldRef.previewLayout`. It holds exactly what is needed to draw the map and no mesh. */
export interface MapPreviewLayout {
  /** The seed · planet this preview was drawn for (the call values as given — the screen tells 「intel for another planet」 apart by them). */
  seed: number;
  planet: PlanetId | null;
  /** The map's edge length (m) — the screen uses it to move coordinates onto its grid (`MAP_SIZE`). */
  mapSize: number;
  spawn: MapPreviewSpot;
  extraction: MapPreviewSpot[];
  nests: MapPreviewSpot[];
  /** Ruined outposts. */
  pois: MapPreviewSpot[];
  craters: MapPreviewSpot[];
  structures: Array<MapPreviewSpot & {
    kind: StructureKind;
    /** Was a basement dug (only an outpost can have one). */
    basement: boolean;
    /** 1 or 2 — a lab gets a locked room only when it has two floors. */
    floors: number;
  }>;
  /** The rails (null when there are none). `platforms` are the platform sites. */
  rail: { kind: RailKind; extent: number; angle: number; platforms: MapPreviewSpot[] } | null;
  /** The rover's dirt road (null when there is none). `route` is the point list of the closed ring's centre line. */
  rover: { stations: MapPreviewSpot[]; route: Array<{ x: number; z: number }> } | null;
  /** This raid's hazard kind (null on a planet with none). The start time is not carried here — there is nothing to draw for it on the map. */
  hazard: HazardKind | null;
}

export interface WorldRef {
  /**
   * appended (2026-09-14, the intel broker): computes **the layout only** from `seed` · `planet` · the gimmicks bought
   * (`intel`) — it builds neither terrain nor mesh and never touches the scene, so it may be called **outside a raid (in the
   * ship)** too. It goes through the same function real generation uses, so the preview and the real map cannot drift apart. `intel` is the result of `shared/intel.resolveIntelEffects`, or null.
   */
  previewLayout?(seed: number, planet: PlanetId | null, intel?: IntelEffects | null): MapPreviewLayout;
}
/* ══ end 2026-09-14 the intel broker's map preview ══ */

/* ══ appended (2026-09-15, B-16): the fire-zone query · the G-10 incendiary grenade ════════
 * A fire zone is built by two folders — the enemy incendiary grenade (enemies `fx/RogueGrenade`) and the player's fire
 * grenade · G-10 incendiary grenade (the gadgets deployable `fire`). The HUD danger indicators (ui `hud/DangerIndicators`)
 * read both in the **same shape**. The colour, as always, is 「whose is it」 — `hostile`. The sounds (`fire_ignite` · `fire_crackle`) and drone damage are raised by the folder that owns the zone. */
export interface FireZoneInfo {
  /** An id unique within the folder (the key the HUD stitches pool slots together with). enemies prefixes `e:`, gadgets uses the deployable id as it is. */
  readonly id: string;
  /** The zone's centre (at ground height). */
  readonly position: THREE.Vector3;
  readonly radius: number;
  /** Time left (s). A finished zone is not in the list. */
  readonly remaining: number;
  /** A zone made by an enemy = true (red). One made by a player — mine or a squadmate's — is false (amber); both burn friend and foe alike, but the colour says whose it is. */
  readonly hostile: boolean;
}

export interface EnemyManagerRef {
  /**
   * appended (2026-09-15, B-16): the live fire zones made by enemy incendiary grenades (all `hostile: true`). Both the authority
   * and a replica answer (a replica also lights a visual zone from `ee grenadeHit.k`). Called **every frame** — it reuses an internal array and allocates no new object.
   */
  getFireZones?(): readonly FireZoneInfo[];
}

export interface ItemDef {
  /**
   * appended (2026-09-15, B-16 · the user's bug report 「the incendiary grenade makes no fire zone」): this grenade stands a
   * **fire zone** where it went off (the `grenadeFire` column of `items.csv` — the G-10 incendiary grenade). The **local** grenade
   * explosion in weapons calls `ctx.gadgets.igniteGrenadeFire(pos)` (a replica's, or a visual-only explosion, does not). Absent or false = plain high explosive.
   */
  grenadeFire?: boolean;
}
/* ══ end 2026-09-15 fire zones ══ */

/* ══ appended (2026-09-15): the result screen rework — the death cause · damage taken per cause · the loot value lost ═
 * User's decision: the extraction result screen shows only the mission time · loot value · rewards; the death result screen shows
 * **the loot value lost** (the highest value carried at any point in that raid) + **the death cause** (the last hit — for an enemy
 * body, its face thumbnail · name · the damage taken from it, otherwise the cause's icon · name · that cause's damage) + the XP earned.
 * Every damage path carries the source in the third argument of `PlayerRef.takeDamage(amount, from, source)`, and game/ sums `player:damaged.source` per cause to settle `MissionStats.death`. */

/** The kind of damage source. */
export type DamageCauseKind =
  | 'enemy'      // an enemy body (bug · rogue · raider · android · named · sandworm …) — melee · gunfire · acid · an enemy blast · an enemy fire zone
  | 'fall'       // fall damage
  | 'hazard'     // an environmental hazard (sandstorm · blizzard · storm eye · toxic spores)
  | 'env'        // a planet's standing environment (heat · toxin) — when the preparation is missing
  | 'explosion'  // physical damage that is not an enemy's: a blast with no known owner · a ship call's falling object · a tram collision
  | 'self'       // your own grenade · your own gadget · a grenade that went off in the hand
  | 'ally'       // a squadmate's explosive · fire
  | 'other';     // anything else (when unknown, omitting it is better)

/** 2026-09-15: the fourth argument of `PlayerRef.takeDamage`. Omitting it is exactly as before (the shield first · then hp). */
export interface PlayerDamageOptions {
  /** True skips the shield and takes hp only (the toxic spore hazard — `HAZARD_SPORES_BYPASS_SHIELD`). */
  bypassShield?: boolean;
}

/** The third argument of `PlayerRef.takeDamage` · `player:damaged.source` · `player:died.source`. */
export interface PlayerDamageSource {
  kind: DamageCauseKind;
  /** kind `enemy`: the enemy's `EnemyType` id as it is (the tutorial `tut_bug` and so on — it is not folded to the base kind). */
  enemyType?: string;
  /** kind `enemy`: the body id — the key that sums the damage from one body. The host and replicas use the same value (the enemy's network id). */
  enemyId?: number;
  /** kind `hazard`: a `HazardKind`. */
  hazard?: string;
}

/** The 「death cause」 row of the death result screen (owner: game/ — `MissionStats.death`). */
export interface MissionDeathCause {
  kind: DamageCauseKind;
  enemyType?: string;
  hazard?: string;
  /** The display name — the enemy's name for an enemy, otherwise the cause's name (`낙하` · `독성 포자` …). game/ settles it. */
  label: string;
  /** The total damage taken from that cause (for an enemy, **that body**) in this raid (the share that went into the shield included, an integer). */
  damage: number;
}

export interface MissionStats {
  /** appended (2026-09-15): the **highest** value of what was carried (equipment · bag · quick slots · pouch) at any point in this raid. The death result screen's 「잃은 전리품 가치」. */
  peakLootValue?: number;
  /** appended (2026-09-15): the death cause when the raid ended in death. Null / omitted on an extraction, or when the cause is unknown. */
  death?: MissionDeathCause | null;
}

export interface MissionStats {
  /**
   * appended (2026-09-16, owner: enemies accumulates it and game settles it): the sum of the XP piled up in this raid by kills
   * where **I landed the last hit** — `raidXp` per kind from `data/enemies.csv`. It is added at the same sites and under the same
   * conditions as `kills` (an android squadmate's · a faction kill is 0). The raid session blob · the solo save store `stats` whole, so it survives a reconnect · a resume. Omitted = 0.
   */
  killXp?: number;
}

export interface EnemyManagerRef {
  /**
   * appended (2026-09-15, owner: enemies; caller: the ui death result screen): the **face thumbnail** of that enemy kind — the head ·
   * upper body turned toward the camera's left diagonal, drawn into a `sizePx` square as a data URL. Enemy models are procedural, so
   * only enemies/ can draw them. It borrows its own WebGL renderer briefly and throws it away (never touching the main canvas · the scene's point-light count). Null when it cannot be drawn.
   */
  renderPortrait?(enemyType: string, sizePx: number): string | null;
  /**
   * appended (2026-09-15): the Korean display name of that enemy kind. Null for an unknown kind. `data/enemies.csv` has no name
   * column, so the name table in enemies/ (`models/Portrait`) is the original — a tutorial kind gets the base kind's name.
   */
  enemyDisplayName?(enemyType: string): string | null;
}
/* ══ end 2026-09-15 the result screen rework ══ */

/* ══ appended (2026-09-15): android squadmates · raid entry loading — `src/allies/README.md` Decisions ═
 * The body of the contract is `shared/allies.ts` · the last section of `net.ts`. Here there are only **optional members** hung on existing
 * Refs — each owning folder implements one and callers call it with `?.` (missing, only that feature quietly drops out). 「Authority」 = single player or the lobby host (`ctx.isAuthority`).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import type { WeightInfo as AllyWeightInfo } from './gear';

/** The kind of inventory request (owner: inventory `requestItem`) — `heal` a healing item · `shield` a charge for the equipped armor's shield · `ammo` ammo for the equipped primary · `item` anything else. */
export type ItemRequestKind = 'heal' | 'shield' | 'ammo' | 'item';

/** One android slot (capsule) in the shared ship's cockpit (owner: hub). Coordinates are relative to the ship's origin. */
export interface HubAndroidBay {
  bay: number;
  /** Where the body's feet stand inside the capsule. */
  position: THREE.Vector3;
  /** The yaw looking out of the capsule (body forward = `(−sin yaw, 0, −cos yaw)`, the remote avatar convention). */
  yaw: number;
  /** One step outside the capsule — the end of the coming-out shot · the start of the going-back one. */
  exit: THREE.Vector3;
}

export interface HubRef {
  /** The android slots in the shared ship's cockpit (in bay order). An empty array outside the shared ship. */
  getAndroidBays?(): readonly HubAndroidBay[];
  /** The waiting spot in front of lobby slot `slot`'s launch pod — where an android that became a squadmate stands ready. Null when there is none. */
  getPodStandPose?(slot: number): { position: THREE.Vector3; yaw: number } | null;
}

/** An android's bag grid — a grid model with no DOM (owner: inventory `Grid`, built by `InventoryRef.createAllyBag`). */
export interface AllyBagRef {
  readonly cols: number;
  readonly rows: number;
  items(): readonly ItemInstance[];
  /** Merges into a stack it can join first, then places the rest in free cells — true when it all fits, otherwise false with nothing changed. */
  autoPlace(item: ItemInstance): boolean;
  remove(uid: string): ItemInstance | null;
  /** Resize it (a bag swap). Returns the items that did not fit. */
  resize(cols: number, rows: number): ItemInstance[];
  usedCells(): number;
  totalValue(): number;
  clear(): void;
}

export interface InventoryRef {
  /** Build one bag grid with no DOM (for an android — the same placement rules as the player's bag). */
  createAllyBag?(cols: number, rows: number): AllyBagRef;
  /** The **same weight formula** as a person's — `carried` = the bag + equipped gear, `bag` = the equipped bag (its capacity bonus). No carrying skill. */
  weightInfoFor?(carried: readonly ItemInstance[], bag: ItemInstance | null): AllyWeightInfo;
  /*
   * Looking at the contents uses the existing `peekContainerItems(containerId, tier?)` as it is (the 2026-09-12 drone scan — the same roll as opening).
   */
  /**
   * Authority: a body that is not a person (`by` = an android id) takes one `defId` stack out of a container (one row of the list seen through `peekContainerItems`).
   * For a container not yet rolled, `tier` settles the same roll as opening first. The host records and broadcasts the take exactly as it does a person's,
   * and on a first open it matches the opened look (`crate opened`) too. The item taken (its `raidFound` mark included), or null (none · already taken · not the authority).
   */
  takeContainerItemFor?(containerId: string, tier: number, defId: string, by: string): ItemInstance | null;
}

export interface PickupsRef {
  /** Authority: a body that is not a person (`by`) picks up ground item `id` — it is removed and `item take {by}` is broadcast. The item picked up, or null. */
  takeBy?(id: string, by: string): ItemInstance | null;
}

/** One lootable container (a world crate + a structure locker). `id` is the same as the inventory container id. */
export interface LootContainerInfo {
  readonly id: string;
  readonly position: THREE.Vector3;
  readonly tier: number;
  readonly opened: boolean;
  readonly kind: 'crate' | 'structure';
}

export interface WorldRef {
  /** Every lootable container on this map (world crates + structure lockers). A reused array — read it and use it at once. An empty array on the training range. */
  getLootContainers?(): readonly LootContainerInfo[];
  /**
   * appended (2026-09-15, A6): puts a crate · container an android opened into its **opened look** (lid · door) and tells the
   * squad (`crate opened`). It calls the same site as a person opening it with E, but raises no event · no statistic · no
   * appraisal XP — those hang on a person's interaction only. False for an id not on this map. The only caller is `InventoryRef.takeContainerItemFor`.
   */
  markContainerOpened?(containerId: string): boolean;
}

export interface HazardRef {
  /** Writes into `out` the nearest point to `(x, z)` that is outside the damage zone right now (`margin` m inside the edge). Null when the map is fully covered. */
  nearestSafePoint?(x: number, z: number, margin: number, out: THREE.Vector3): THREE.Vector3 | null;
}

export interface EnemyManagerRef {
  /**
   * Authority: one of an android's shots hit enemy `enemyId` — `takeDamage(…, 'ai')` (no kill credit) plus waking that enemy toward `from`.
   * True when it was applied. False on a replica.
   */
  applyAllyHit?(enemyId: number, damage: number, point: THREE.Vector3, from: THREE.Vector3): boolean;
}

export interface PlayerRef {
  /** The android version of `snapshotFace` — the same framing, with the android helmet · visor. The portrait for the 매칭 tab · launch slots · the squad list. */
  snapshotAndroidFace?(opts: { accent: string; size?: number }): string | null;
}

export interface PlayerRef {
  /**
   * appended (2026-09-16, owner: player; reader: progression's carrying skill): a cumulative odometer (m, never decreasing) of the horizontal
   * distance moved **under the body's own power**. Only walking · running · crouched/prone movement · crawling · rolling · a jump off its own
   * feet raise it. The extraction ship · a ship interior · attachment, drop pods · rescue drops, tram platforms, the rover, being carried, the
   * grapple · dash, jump pads · rocket jumps · knockback, teleports · revival, furniture poses · drone control · the scene lock do not. Readers use only the difference from the value they last saw (it is not consuming, so several readers never steal from each other).
   */
  readonly selfMovedMeters?: number;
}

export interface PortraitRef {
  /**
   * appended (2026-09-15, A4): draws launch-slot portrait cell `index` with the android look (`SoldierModel.setAndroidLook`).
   * Order-independent with `setMember` — the cell remembers it, so it survives the body being rebuilt. owner: player `Portraits.ts`.
   */
  setAndroid?(index: number, on: boolean): void;
}

export interface CorpsesRef {
  /**
   * Authority: leaves the wreckage of a dead android — a `pcorpse:<allyId>:<n>` container (only what it picked up in the raid) plus a body with the android look, broadcast as `pcorpse spawn`.
   * The id of the corpse created, or null.
   */
  spawnAllyCorpse?(allyId: string, name: string, slot: number, position: THREE.Vector3, yaw: number, items: readonly ItemInstance[]): string | null;
}
/* ══ end 2026-09-15 android squadmates ══ */

/* ══ appended 2026-09-21: reload hold · ally healing (owner: weapons · gadgets · implants · player · ui) ══ */

/**
 * Why a running reload is **held** instead of thrown away (2026-09-21, user's decision). A reload used to die on
 * every interruption (`WeaponSystem.cancelReload`); an action that is over in a moment and leaves the gun in the
 * hands now freezes it where it stood and it continues from that point:
 *   - `'roll'`     — the V roll (`PlayerController.rolling`, read through `PlayerWeaponHost.isDiving`).
 *   - `'grapple'`  — the 갈고리 wire is out (`implant:grappleFired` … `implant:grappleReleased`).
 * 대시 is **also** an instant implant, but it is a single-frame teleport — there is no window to hold, so it has no
 * reason of its own; the reload simply runs on through it. Taking 배리어 or 오버차지 in hand still **cancels**.
 */
export type ReloadPauseReason = 'roll' | 'grapple';

/* ══ appended 2026-09-21: rover parts · hostility · wreck crates (owner: world/rover) ══ */

export interface RoverRef {
  /**
   * appended (2026-09-21): has the vehicle turned hostile (the player side dealt `ROVER_AGGRO_DAMAGE` cumulative
   * damage). Host-decided, true for the rest of the raid, and it refuses boarding — a client only reads it.
   */
  readonly hostile?: boolean;
}



