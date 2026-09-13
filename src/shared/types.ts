import type * as THREE from 'three';
import type { Random } from './Random';
import type { GameContext } from './GameContext';
import type { ArmorDef, CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, WeightInfo } from './gear';
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
  | 'implant'     // 임플란트 (능력치 장착 아이템, see `ItemDef.implant`): equipped on the 캐릭터 tab, 세레스 바이오 sells / repairs, broken ones are raid loot
  /* appended: 온실 개편 (2026-09-11) */
  | 'soil'        // 토양 (see `ItemDef.soil`): poured into a 재배 스테이션 재배층 before a seed goes in; 바이오별 채집 전용, never craftable
  | 'crop'        // 작물: harvested from a 재배층. 2026-09-11 A-3c 부터 조리대의 요리 재료다 (판매 · 납품 · 추출기와 함께 네 번째 소비처)
  /* appended: 연구실 (A-12 · A-13, 2026-09-11) */
  | 'sample'      // 미확인 표본 (see `ItemDef.sample`): 분석기에 넣어 현실 시간만큼 기다리면 해석된다. 레이드 전용 — 제작도 상점도 없다
  | 'prep'        // 준비물 (see `ItemDef.prep`): 함선에서 쓰면 **다음 레이드 1회분**으로 실린다 (행성 환경 상쇄)
  /* appended: 주방 · 프린터 (A-3c · A-15, 2026-09-11) */
  | 'meal'        // 요리 (see `ItemDef.meal`): 함선 식탁에서 먹으면 **다음 레이드 1회분**으로 실린다 (파생 수치 하나를 올린다)
  | 'pouch'       // 주머니 (see `ItemDef.pouch`): 장비칸 `pouch` 한 칸에 끼우면 퀵슬롯 아래에 별도 격자가 열린다
  | 'key'         // 열쇠 — 구조물 지하실 키카드 등. 2026-09-11 에 `valuable` 에서 갈라져 나왔다: 열쇠 주머니가 귀중품과 섞이면 안 된다
  /* appended: 서재 매체 (A-3e, 2026-09-12) */
  | 'disc'        // 디스크 (see `ItemDef.disc`): 서재 디스크 전시대에 꽂는다 — 책과 같은 역할이고 책보다 조금 세다. loot + corp shop, never craftable
  /* appended: 요리 재료 티어 (2026-09-13) — 소켓 (see `ItemDef.growSocket`): 부어 둔 흙 · 배지에 끼우는 영구 강화. 분석기가 미확인 DNA 를 해석해서만 나온다 */
  | 'socket'
  | 'record';     // 레코드 (see `ItemDef.record`): 서재 레코드랙에 꽂는다 — 디스크보다 조금 세다. loot + corp shop, never craftable

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
/**
 * Equipment slots. `primary` = 주무기 I (key 1), `primary2` = 주무기 II (key 2), `secondary` = 보조무기 (key 3),
 * `bag` = 가방, `armor` = 방탄복.
 *
 * appended (2026-09-11, A-15): `pouch` = 주머니 **한 칸** (사용자 결정: 고정 1칸). 끼우면 퀵슬롯 아래에 그
 * 주머니의 격자가 열린다 — 가방과는 다른 컨테이너다 (`ItemDef.pouch`).
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
  /* ── appended: 온실 개편 (2026-09-11, owner: items) ── */
  /** category 'soil': which 속성 it carries and how many harvests it survives. */
  soil?: SoilDef;
}

/**
 * 토양 속성 (2026-09-11). Four tags, one per gathering biome — `world/` drops the tag's soil on that planet,
 * `data/seeds.csv` names the tag each seed wants. Matching soil grows `SOIL_MATCH_SPEEDUP` faster, a mismatch
 * `SOIL_MISMATCH_PENALTY` slower; there is no "no soil" case because a 재배층 칸 must be filled before it takes a seed.
 */
/* appended (품종 확장 A-11, 2026-09-11): `saline` 염류 · `spore` 포자 — 새 품종이 원하는 두 속성. 태그를 늘리는 데
 * 드는 것은 이 줄 · `SOIL_TAG_LABEL_KO` · `SOIL_TAG_COLOR` · `data/items.csv` 의 `soil_*` 줄 · `data/planets.csv`
 * 의 `soils` 가중치가 전부다 (온실 개편이 그렇게 설계해 뒀다). */
export type SoilTag = 'ash' | 'frost' | 'humus' | 'mineral' | 'saline' | 'spore';
export const SOIL_TAGS: readonly SoilTag[] = ['ash', 'frost', 'humus', 'mineral', 'saline', 'spore'];

/**
 * 토양 data (2026-09-11). `uses` is how many harvests one poured unit survives (`SOIL_USES_BY_RARITY`: 일반 2 ·
 * 고급 3 · 희귀 5) — the count lives on the plot (`GrowSlot.soilUsesLeft`), not on the item, so a poured soil is
 * spent even if the item stack it came from is gone.
 */
export interface SoilDef {
  tag: SoilTag;
  /** Harvests one poured unit survives before the 칸 goes back to 비어 있음. */
  uses: number;
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
  /* ── appended: 온실 개편 (2026-09-11) ── */
  /**
   * 토양 속성 this seed wants. The 재배층 칸 it goes into is already filled with some soil: the same tag grows it
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
   * appended (2026-09-11, A-15): 장착한 주머니 (`ItemDef.pouch`). optional 인 이유는 `armor` 와 같다 —
   * 저장된 로드아웃 · 크루 카드 · 프리셋이 이 칸 없이 적혀 있다. 끼우면 퀵슬롯 아래에 그 격자가 열린다.
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
  /**
   * Item def id produced (an 'herb' category item, or `mat_scrap` for a `kind: 'salvage'` node). 2026-09-11 (C-20):
   * a 고철 더미 may **also** hand over a bonus 구동 코어 decided at generation (seeded, csv chance) — that bonus is
   * world-internal and not in this def; the harvest still emits one `gather:collected` (one XP).
   */
  defId: string;
  /** Units produced before the gardening multiplier. */
  qty: number;
  harvested: boolean;
  /* appended (2026-09-08): 폐금속 공급 — 고철 노드 */
  /**
   * What the node is. undefined / 'herb' = the 약초 plant (원예 XP, 채집 prompt); 'salvage' = a 고철 더미 at a
   * wreck, yielding `mat_scrap` (+ a chance of a bonus core, C-20) with a 해체 prompt and 제작 XP. Both share the
   * placement / net / interact code.
   */
  kind?: GatherNodeKind;
}

/**
 * `GatherNodeDef.kind` (2026-09-08). appended (온실 개편, 2026-09-11): `'soil'` — 토양 더미. One soil tag per
 * planet (`data/planets.csv` 의 `soils` 열), so which 토양 속성 you can farm is a reason to pick a planet.
 * Shares the placement / net / interact code with the other two; yields a `category: 'soil'` item and 원예 XP.
 */
/* appended (A-11 · A-12, 2026-09-11): `'seed'` 야생 씨앗 군락 — 행성마다 다른 품종이 난다 (`data/planets.csv` 의
 * `seeds` · `seedNodes`); `'sample'` 미확인 표본 — 분석기가 해석할 것 (`samples` · `sampleNodes`). 둘 다 토양 더미와
 * **같은** 배치 · 네트워크 · 상호작용 코드를 타고, 각자 전용 rng fork 를 써서 서로의 배치를 흔들지 않는다. */
export type GatherNodeKind = 'herb' | 'salvage' | 'soil' | 'seed' | 'sample';

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
  /**
   * Cutscene camera (docking, launch): blends to `pos` looking at `lookAt`; null releases back to the rig.
   * 2026-09-11: `setCameraOverride(null, undefined, true)` = **hard cut** back to the rig (드론 시점 복귀 — a slow blend
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
  /**
   * true while an overcharge beam is buffing this player (speed / fire rate). 2026-09-11 (C-3): set explicitly by
   * `setOvercharged` — no longer inferred from a speed-modifier key.
   */
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
export type EnemyType = 'scavenger' | 'hunter' | 'warrior' | 'spewer' | 'charger' | 'rogue' | 'rogue_boss' | 'artillery' | 'toxic' | 'behemoth'
  /* appended (2026-09-11): 네임드 로그 3종 (`shared/named`) + 로든의 스캔 드론. 전부 팩션 rogue. */
  | 'rogue_sniper' | 'rogue_hammer' | 'rogue_heavy' | 'rogue_scan_drone'
  /* appended (2026-09-13): 행성 threat 별 인간형 팩션 — 안드로이드(threat 1) · 레이더(threat 2–3). 로그는 `rogue` 그대로. */
  | 'android' | 'raider'
  /* appended (2026-09-13): 지하벌레 — 땅에 박힌 채 버그를 뱉고 독극물을 뱉는 이벤트 보스 (팩션 bug, `enemies/sandworm`). */
  | 'sandworm';
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
   * `attacker` appended (2026-09-11, 원격 지뢰 킬 크레딧): 피해를 준 쪽 — `'local'` · PeerId · `'ai'`.
   * 생략하면 예전처럼 `'local'`. 가젯처럼 소유자가 따로 있는 피해원이 크레딧을 넘길 때 쓴다.
   */
  takeDamage(amount: number, hitPoint?: THREE.Vector3, hitDir?: THREE.Vector3, attacker?: string): void;
  /* appended (Phase 4) */
  readonly faction: EnemyFaction;
  /* appended (unique weapons, 2026-09-06) */
  /** 전소 (incinerated): writhing on the spot, no movement / attacks, still damageable. Set via `applyStatus('incinerated')`. */
  readonly isIncapacitated: boolean;
  /**
   * appended (2026-09-11, C-62): the point on this body's **hitboxes** nearest to `from`, written into `out` and
   * returned. Melee aims its cone at it, so a body that is not standing upright (엎드린 로든 — the lying capsule the
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
/**
 * `Interactable.kind` (appended 2026-09-11, C-4). Add members, never rename. Unset = unknown (readers use the id prefix).
 * `object` is deliberately **not** on `Interactable` — the mesh outline it would have fed went away with the 빛기둥 rule.
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
   * the two corpse kinds — `'corpse'` = 적 시체 `corpse:<id>`, `'playerCorpse'` = 분대원 시체 `pcorpse:<owner>:<n>`.
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

  /* ══ appended 2026-09-12: 인벤토리 타일과 똑같은 독립 타일 ══════════════════════════════════════════════ */
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
  /* ── appended 2026-09-13 (기업 화면 카드 분리 — `inventory/ui/TradeGrids`) ── */
  /** Label of the right-click menu's first entry (what `onTake` does on this screen). Default `빠른 이동`. */
  takeLabel?: string;
  /**
   * `'wrap'` (default): one scroll box, blocks side by side, wrapping when narrow. `'split'`: every block scrolls itself
   * and stretches to the view's height; a block is exactly as wide as its grid — mount **one** grid per caller card.
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
  /**
   * appended (2026-09-10): 실드. 생략(옛 세이브 · 옛 호스트)이면 **0 이 아니라 방탄복의 최대치**로 복구한다 —
   * 모르는 값을 0 으로 읽으면 재접속한 사람만 조용히 실드를 잃는다.
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
   * appended (2026-09-13, owner: player): 즉시 **완전 사망** — 전투불능을 건너뛰고 실드 · 체력과 상관없이 `player:died` 를 낸다.
   * 이미 죽었으면 no-op. 부르는 곳은 game/ 의 자발적 귀환(`game:returnToShip`) 하나다.
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
   * appended (2026-09-11): the hand is the slotless **기폭기** left after the last 원격 지뢰 was placed (`heldItemId` stays
   * the C4 def id). gadgets turns the placement preview off while true; ui shows `우클릭 기폭 (n)`.
   */
  detonator?: boolean;
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
  /**
   * appended (2026-09-13, owner: progression — 캐릭터 탭의 확정 전 능력치 포인트): the host is about to leave this view **because
   * the player asked** (another screen tab, Tab / Escape close). A view with unsaved work returns **true** — it intercepted, the host
   * must stop there — and calls `proceed()` later if the player chooses to go on anyway (e.g. `버리고 이동`). false / omitted = leave
   * now. Forced exits (phase change, death, `openScreen`, …) do not ask: they just `dispose()`, which discards silently.
   */
  requestLeave?(proceed: () => void): boolean;
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
  /* appended (2026-09-11): 네임드는 늘 수색된다, 스캔 드론은 잔해뿐이다 */
  rogue_sniper: 1, rogue_hammer: 1, rogue_heavy: 1, rogue_scan_drone: 0,
  /* appended (2026-09-13): 안드로이드 · 레이더도 늘 수색된다 */
  android: 1, raider: 1,
  /* appended (2026-09-13): 지하벌레는 늘 수색된다 (보스급 전리품 — data/loot_corpses.csv) */
  sandworm: 1,
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
  | 'noHeal'       // 회복 아이템(category 'stim')이 가방에 없다
  /* appended (2026-09-11, A-13): 목표 행성에 상시 환경(`PlanetDef.env`)이 있는데 그 환경을 막는 준비물이
   * 이번 레이드에 실려 있지 않다. **경고일 뿐 막지 않는다** — 소프트 게이트가 사용자 결정이다. */
  | 'noEnvPrep'
  /* appended (2026-09-11, A-3c): 식사를 차리지 않았다 (`ProgressionRef.getMeal()` 이 null).
   * `noEnvPrep` 과 같은 결의 경고일 뿐이다 — 요리는 처음부터 있어도 되고 없어도 되는 이득이다.
   * 2026-09-12 (사용자 결정): **주방이 있는 함선에서만** 올라온다 — 조리대도 식탁도 없는 사람에게
   * "식사를 차리지 않았습니다" 는 고칠 길이 없는 잔소리다 (`ctx.housing.getBenchLevel('cook')`). */
  | 'noMeal'
  /* appended (2026-09-12, 사용자 결정): 수락한 기업 계약 없이 나가려 한다 (`ctx.meta.activeContract` 가 null).
   * 역시 **경고일 뿐 막지 않는다** — 계약 없이 도는 레이드도 정상이지만, 한 판을 통째로 날리기 전에 한 번은 묻는다. */
  | 'noContract';

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
   * 2026-09-11 (C-38): 윗면이 `PROP_TOP_MARGIN` 창 안에서 겹치면 **`velocity` 가 있는(움직이는) 발판을 높이보다
   * 먼저** 고른다 — 선로 발판과 전차 바닥이 같은 높이일 때 삽입 순서로 고정 발판이 이기던 동점.
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
  /* ── appended (2026-09-13, 탈출 개편 — owner: game, caller: extraction) ── */
  /**
   * 시체를 움직이는 물체(탈출 함선의 `root`)에 싣는다: `parent` 로컬 좌표 `local`(생략 = 지금 자리)에 눕히고, 그 뒤로는
   * `parent` 의 변환을 그대로 따라간다(기울기 포함). `parent` null = 지금 월드 자리에 내려놓는다. 모르는 id 면 false.
   */
  attachCorpse?(id: string, parent: THREE.Object3D | null, local?: THREE.Vector3): boolean;
  /** 시체를 레이드에서 치운다 (함선에 실려 떠났다) — 상호작용 · 메시가 함께 사라지고 안의 아이템도 잃는다. */
  removeCorpse?(id: string): boolean;
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
   * **사망 시점의 전부** — 장비 슬롯 · 가방 · 퀵슬롯의 아이템 + **장착 임플란트의 망가진 짝**
   * (2026-09-11 C-12, `ProgressionRef.stripImplantsForCorpse`)을 하나의 목록으로 뽑고 로컬 인벤토리를 **비운다**.
   * 시체 컨테이너를 채우는 유일한 입구이고, 사망 처리에서 한 번만 불린다.
   */
  stripForCorpse(): ItemInstance[];
  /**
   * `openContainerItems` 와 같지만 격자 크기를 지정한다 (시체는 `PLAYER_CORPSE_COLS × PLAYER_CORPSE_ROWS`).
   * 이미 알고 있는 id 면 `items` · 크기 모두 무시하고 남은 내용물을 보여 준다.
   */
  openContainerItemsSized(containerId: string, items: ItemInstance[], position: THREE.Vector3,
    cols: number, rows: number, title?: string): void;
}

export interface InventoryRef {
  /* ── appended (2026-09-11): 저장 무결성 — E-5 · E-6 (owner: inventory) ── */
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
   * **있다는 것 자체가** "움직이는 발판" 표시다 (정지한 전차도 0 벡터로 채운다 — `getStandingObstacle` 이 동점에서
   * 이것을 먼저 고른다, C-38). 탑승하는 쪽(플레이어 · 적 · 시체, 2026-09-11 C-18)은 이 속도를 **더하지 않는다** —
   * 진입만 `getStandingObstacle` 로 하고, 유지 · 이동은 `shared/ride.ts`(차량 OBB + 헤드룸, 차량 로컬 좌표를
   * 매 프레임 차량의 지금 변환으로 다시 푼다)다. 속도는 하차 관성에만 쓴다.
   */
  velocity?: THREE.Vector3;
}

/* ── 버려진 구조물 (owner: world/Structures) ──────────────────────────────────────────────────────────── */
/**
 * 행성 구역마다 무작위로 놓이는 **들어갈 수 있는** 폐건물. 안에 상호작용 컨테이너가 밀집해 있다.
 * 2026-09-12 (사용자 결정): 잠긴 공간은 둘이다 — `outpost` 의 **지하실**(열쇠 `key_basement`)과 2층이 굴려진 `lab` 의
 * **2층 잠긴 방**(키카드 `keycard_lab`). 둘 다 **소모형 만능 열쇠**로 열리고(같은 종류면 어느 건물이든 · 쓰면 1 개 사라진다),
 * 건물마다 확정으로 넣어 두는 열쇠는 없다 — 상자 · 구조물 컨테이너 · 로그 시체 · 노마드 상점에서 드물게 나온다.
 * 문이 요구하는 아이템은 `unlockDefId`, 문 옆 벽 아래에는 지상 드론만 드나드는 환풍구가 있다.
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
/**
 * 플레이어에게 보이는 이름. 2026-09-13 (사용자 결정): 모래 폭풍 · 눈보라 · 폭풍의 눈은 화면에서 전부 **「폭풍」** 하나다
 * (구분하지 않는다). 코드 · 문서에서 가를 때는 `HazardKind` 를 쓴다.
 */
export const HAZARD_LABEL_KO: Readonly<Record<HazardKind, string>> = {
  sandstorm: '폭풍', blizzard: '폭풍', storm_eye: '폭풍', spores: '독성 포자',
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
  /* appended (2026-09-13) */
  /**
   * 피해 배수 = 지금 초당 피해 / `HAZARD_DPS`. 시작 1 → 진행도 1 에서 `HAZARD_DPS_MAX / HAZARD_DPS` (재해가 시간에 따라 강해진다).
   * 시작 전에도 1 이다 — 쓰는 쪽은 `active` · `isInside` 를 먼저 본다. 적의 조용한 피해(`enemies/`)가 곱한다.
   */
  readonly damageMul: number;
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
  rollCorpseOn(type: EnemyType, rng: Random, rogueWeaponId: string | undefined, planet: PlanetId | null,
    /** appended (2026-09-13): 팩션 전리품의 입력 — 스폰 거점 · 던지지 못한 수류탄. 생략 = 예전 굴림. */
    opts?: CorpseLootOpts): ItemInstance[];
}

/* ══ appended (2026-09-13): 행성별 적 팩션 — 안드로이드 · 로그 · 레이더 (owner: enemies · items · world) ═══════════
 * 어떤 팩션이 나오는지는 행성 threat 가 정한다 (`planetThreat`): 1 = 안드로이드 · 2 = 로그 / 레이더 · 3 = 레이더만.
 * 서로 다른 팩션은 전부 적대다. 계획서: docs/plans/enemy-factions.md
 * ════════════════════════════════════════════════════════════════════════════════════════════════════ */
/** 게임 안 팩션 이름. */
export const ENEMY_FACTION_LABEL_KO: Readonly<Record<EnemyFaction, string>> = { bug: '벌레', rogue: '로그', android: '안드로이드', raider: '레이더' };
/**
 * 인간형 적이 배치된 **거점** — 시체 전리품의 입력이다 (연구소 = 연구 물품, 전진기지 = 총기 등급 보너스).
 * `platform` = 선로 플랫폼, `ruin` = 폐허 전초(`WorldRef.getRuinSites`), `drop` = 레이더 강하, 나머지는 `StructureKind`.
 */
export type EnemySpawnSite = StructureKind | 'platform' | 'ruin' | 'drop';
/** 한 그룹 안의 역할. `flanker` = 레이더 그룹에서 떨어져 우회하는 한 명, `leader` = 로그 그룹장(rogue_boss). */
export type EnemySquadRole = 'member' | 'leader' | 'flanker';
/** 적이 들고 다니는 수류탄 종류. **순서가 와이어 인덱스다** (`ee grenade.k` · `ee corpse.gk`) — 재정렬 금지. */
export type EnemyGrenadeKind = 'frag' | 'incendiary';
export const ENEMY_GRENADE_KINDS: readonly EnemyGrenadeKind[] = ['frag', 'incendiary'];
/** 그 종류의 아이템 id (시체에 남는 것 — `data/items.csv`). */
export const ENEMY_GRENADE_ITEM: Readonly<Record<EnemyGrenadeKind, string>> = { frag: 'grenade_frag', incendiary: 'grenade_incendiary' };

/** `RogueSpawnHost.spawnRogue` 의 부가 인자 (전부 생략 가능 — 생략 = 예전 스폰). */
export interface HumanoidSpawnOpts {
  site?: EnemySpawnSite | null;
  /** 같은 그룹이면 같은 값 (레이드 안에서만 유일). 생략 = -1 = 그룹 없음. */
  squadId?: number;
  role?: EnemySquadRole;
}

/** `LootRef.rollCorpseOn` 의 부가 인자. 호스트는 `Enemy` 에서, 리플리카는 `ee corpse.si/gc/gk` 에서 만든다. */
export interface CorpseLootOpts {
  site?: EnemySpawnSite | null;
  /** 던지지 못하고 남은 수류탄 — 그 종류 그대로 시체에 들어간다 (별도 수류탄 드롭 굴림은 없다). */
  grenades?: { kind: EnemyGrenadeKind; count: number } | null;
}

/** 폐허 전초 한 곳 (world `Outposts` 의 POI 패드 — 들어가는 전진기지 `StructureKind 'outpost'` 와 **다르다**). */
export interface RuinSiteDef {
  /** `outpost_<i>` (`fog:discovered {kind:'outpost'}` 와 같은 id). */
  readonly id: string;
  readonly position: THREE.Vector3;
  readonly yaw: number;
  readonly radius: number;
}

/** 거점 그룹을 세울 자리의 종류. */
export type SiteSpawnPlace = 'indoor' | 'outdoor';

export interface WorldRef {
  /** appended (2026-09-13, owner: world): 이번 맵의 폐허 전초 (훈련장 · 없는 맵 = 빈 배열). */
  getRuinSites?(): readonly RuinSiteDef[];
  /**
   * appended (2026-09-13, owner: world): 거점 `siteId` 에 인간형 그룹을 세울 자리 `count` 개 — 서로 `minGap` 이상, 시드 결정적.
   * `siteId` = 구조물 id(`struct_*`) · 선로 플랫폼 id · 폐허 id(`outpost_<i>`).
   *  - `indoor`: 구조물 = 실내의 걸을 수 있는 바닥(지상층, 2층이 있으면 2층도) — 벽 · 컨테이너 · 계단 구멍 · 잠긴 방 · 지하실 밖.
   *    플랫폼 = 데크 위, 폐허 = 바닥판 위 벽 안쪽.
   *  - `outdoor`: 발자국 바깥 둘레, 막히지 않았고 선로 회랑 밖.
   * y 는 발이 닿는 높이. 자리가 모자라면 찾은 만큼만 돌려준다 (모르는 id · 훈련장 = 빈 배열).
   */
  getSiteSpawnPoints?(siteId: string, place: SiteSpawnPlace, count: number, minGap: number, seed: number): THREE.Vector3[];
}

/* ── 로그 강하 (owner: enemies/RogueDrop) ──────────────────────────────────────────────────────────────── */
/** 진행 중인 로그 강하 한 건. */
export interface RogueDropView {
  readonly id: string;
  readonly position: THREE.Vector3;
  /** 몇 명이 내리는가. */
  readonly count: number;
  /** 보스(옛 로그 분대장)가 섞여 있는가. 2026-09-13 레이더 강하에는 분대장이 없어 늘 false 다. */
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

/* ══ appended (2026-09-10): 방탄복 = 실드 ═══════════════════════════════════════════════════════════ */

export interface PlayerRef {
  /* ── 실드 (owner: player/PlayerSystem) ────────────────────────────────────
   * 방탄복은 더 이상 피해를 깎지 않는다 (`PlayerRef.damageReduction` 은 계약으로만 남아 늘 0 이다).
   * 대신 **추가 체력 풀**을 준다: 들어온 피해는 `shield` 를 먼저 비우고 남은 만큼만 `hp` 로 간다.
   * 실드는 스스로 재생하지 않는다 — '실드 충전기' 소모품(`chargeShield`)과 함선 복귀로만 채워진다.
   * 변화는 전부 `player:shieldChanged` 로 알린다. */
  /** 현재 실드. 방탄복이 없으면 0. */
  readonly shield: number;
  /** 장착한 방탄복의 `ArmorDef.shield`. 없으면 0. */
  readonly maxShield: number;
  /** 실드 게이지 칸 색을 정하는 방탄복 등급. 없으면 null. */
  readonly shieldRarity: Rarity | null;
  /** 방탄복 tier (번호 방탄복 1..5, 유니크 0). 없으면 0. */
  readonly shieldTier: number;
  /**
   * 실드 충전기: `amount` 만큼 실드를 채운다 (`Infinity` = 가득). 방탄복이 없거나 이미 가득이면
   * **아무것도 쓰지 않고** false — 호출자가 아이템을 소모하기 전에 이걸로 먼저 묻는다.
   */
  chargeShield(amount: number): boolean;
}

/* ══ appended (2026-09-10): 제작 대개편 — 내구도 연동 수리 · 분해 ═══════════════════════════════════
 *
 * 수리비와 분해 산출은 이제 **그 아이템을 새로 제작할 때 드는 재료**에서 나온다. 남은 내구도를 20 % 단위
 * 다섯 구간으로 나누고 (`durabilityBucketOf`), 구간마다 정해진 배수를 제작 재료에 곱한다
 * (`data/tables.csv` 의 `REPAIR_COST_BY_DURABILITY` · `SALVAGE_YIELD_BY_DURABILITY`).
 * 그래서 같은 총이라도 **지금 남은 내구도에 따라 수리비와 분해 산출이 달라진다** — UI 는 인스턴스를 들고 물어야 한다.
 *
 * 두 배수의 합이 언제나 1 보다 작아서 「제작 → (수리) → 분해 → 제작」 이 이득이 되지 않는다.
 * 실제 숫자로 검사하는 곳은 `items/Salvage.checkSalvageEconomy()` 이고 `npm run data:check` 가 돌린다.
 *
 * ⚠ **`getRepairCost(inst)` 는 시그니처가 그대로이고 구현만 이 규칙으로 바뀌었다** (위 원본 블록 참고):
 *   더 이상 "빠진 내구도 ÷ REPAIR_SCRAP_PER" 가 아니라 `제작 재료 × REPAIR_COST_BY_DURABILITY[구간]`(올림)
 *   이고, 무기뿐 아니라 **방탄복도** 값을 돌려준다 (예전에는 방탄복 수리가 공짜였다). 내구도가 가득이거나
 *   내구도 자체가 없는 아이템은 예전처럼 `[]` 다.
 */
export interface LootRef {
  /**
   * 남은 내구도 구간 **0..4** — 0 = 0~20 % · 1 = 21~40 % · 2 = 41~60 % · 3 = 61~80 % · 4 = 81~100 %.
   * 내구도가 없는 아이템(가방 · 재료 · 탄약)은 언제나 **4** 다.
   */
  durabilityBucketOf(inst: ItemInstance): number;
  /** 구간 하나의 설명 — UI 가 "지금 몇 번째 구간인가" 와 그 배수를 그대로 그릴 수 있게. */
  durabilityBucketInfo(inst: ItemInstance): DurabilityBucketInfo;
  /**
   * 이 아이템을 **새로 제작할 때** 드는 재료 (수리 · 분해 계산의 기준). 제작 레시피가 없으면 `[]`
   * (유니크 무기 · 유니크 방탄복 · 루팅 전용 아이템). 반환 배열은 공유되므로 고치지 않는다.
   */
  getCraftCostOf(defId: string): readonly CraftIngredient[];
  /**
   * 이 인스턴스를 **지금** 분해하면 나오는 것. 분해할 수 없으면 null (유니크 · 제작 레시피가 없는 장비 ·
   * 산출이 0 인 경우). 돌아오는 것은 여전히 `CraftRecipe` 모양이고 `id` 는 `getAllRecipes()` 에 있는
   * 그 분해 레시피와 **같다** — 달라지는 것은 `outputQty` / `extraOutputs` 뿐이다 (내구도 구간이 곱해진 값).
   * `getAllRecipes()` 에 실려 있는 쪽은 **구간 4(81~100 %) 기준**이므로, 실제로 소비 · 산출할 때는
   * 반드시 이 함수가 돌려준 레시피를 써야 한다.
   */
  getSalvageFor(inst: ItemInstance): CraftRecipe | null;
}

/** `LootRef.durabilityBucketInfo` 의 반환값. */
export interface DurabilityBucketInfo {
  /** 0..4 (0 = 0~20 %). */
  bucket: number;
  /** 남은 내구도 비율 0..1 (내구도가 없으면 1). */
  ratio: number;
  /** 이 구간의 수리 재료 배수 (제작 재료 × 이 값, 올림). */
  repairMul: number;
  /** 이 구간의 분해 산출 배수 (제작 재료 × 이 값, 내림). */
  salvageMul: number;
  /** 한국어 구간 표기 (`81~100 %`). */
  label: string;
}

export interface EnemyManagerRef {
  /* ── appended (2026-09-10): 위험 인디케이터 ── */
  /**
   * 지금 날아가는 **적** 수류탄 (로그가 던진 것). HUD 의 위험 인디케이터가 아군 수류탄
   * (`WeaponsRef.getGrenades()`) 과 나란히 읽는다 — 같은 `GrenadeView` 모양이고, `remote` 는
   * "이 클라이언트에 권한이 없는 복제본" 이라는 뜻으로 쓴다. 한 풀 몸체당 view 객체 하나를 재사용하므로
   * 반환 배열도 그 자리에서 다시 쓰인다: **호출자는 붙들어 두지 말고 그 프레임에 다 읽는다.**
   */
  getEnemyGrenades(): readonly GrenadeView[];
}

/* ══ appended (2026-09-11): 볼록 콜라이더 · 경사 발판 · 깨지는 창 · 사다리 ═══════════════════════════════
 * 계약은 **추가만** 한다. 소유 폴더는 각 절의 머리에 적었다.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/* ── 볼록 다각형 기둥 (owner: world) ─────────────────────────────────────────────────────────────────── */
/** 볼록 콜라이더의 한 층 — `[y0, y1]` 높이 사이에서 보이는 메시의 볼록 윤곽 (월드 XZ, 반시계). */
export interface ObstacleHullBand {
  y0: number;
  y1: number;
  /** `[x0, z0, x1, z1, …]` 월드 좌표, 반시계(위에서 내려다본 +X → +Z 회전 방향). */
  points: Float32Array;
}

/**
 * **볼록 다각형 기둥.** 주면 `radius` 원 대신 이 윤곽으로 밀어내고 발판을 판정한다 — 바위 · 크리스탈 · 첨탑처럼
 * 원 하나로는 어떤 방향은 파고들고 어떤 방향은 앞에서 막히는 소품을 위해 2026-09-11 에 추가했다.
 * `box` 와 같은 규약으로 `radius` 는 **여전히 채워 둔다** (`position` 에서 가장 먼 꼭짓점까지 = 외접원):
 * `SpatialHash` 버킷팅과 광역 질의가 그 원을 쓴다.
 */
export interface ObstacleHull {
  /** 이동 · 발판용 윤곽 (`[x0, z0, …]`, 월드 좌표, 반시계). 높이는 `position.y .. position.y + height`. */
  points: Float32Array;
  /** 총알 · 시야용 층. 없으면 `points` 를 전체 높이에 쓴다. 층은 아래에서 위로 정렬돼 있다. */
  bands?: readonly ObstacleHullBand[];
}

export interface Obstacle {
  /** 볼록 다각형 기둥 (2026-09-11). `box` 와 함께 쓰지 않는다. */
  hull?: ObstacleHull;
  /**
   * **경사 발판** (2026-09-11) — `box` 와 함께만 쓴다. 윗면이 상자의 로컬 +X 방향으로 올라가는 경사면이다:
   * 로컬 `x = -halfX` 에서 `position.y + height - rise`, `x = +halfX` 에서 `position.y + height`.
   * 계단은 **보이는 것은 계단, 밟는 것은 이 경사면**이라 한 단씩 튀지 않고 스르륵 오르내린다.
   */
  ramp?: { rise: number };
  /**
   * 한 방에 깨지는 판 (창문 유리, 2026-09-11). 맞힌 쪽(총알 · 투척물)이 `destructible.onDamage` 를 부르고,
   * 깨지면 소유자가 hash 에서 뺀다. 이동은 막지만 **투척물은 이 판에서 튕기지 않고 깨고 지나간다.**
   */
  fragile?: boolean;
}

/* ── 사다리 (owner: world/Structures — 매달리는 쪽: player) ─────────────────────────────────────────────── */
/**
 * 들어갈 수 있는 건물의 사다리 한 줄. 좌표는 전부 월드이고 시드 결정적이다.
 * 매달린 몸은 `base` 의 XZ 에 고정되고 `base.y .. topY` 사이를 오르내린다.
 */
export interface LadderDef {
  /** `ladder_<structureId>_<n>`. */
  id: string;
  /** 사다리에 매달린 **몸 중심**의 XZ, y = 아래 바닥 높이 (발치). */
  base: THREE.Vector3;
  /** 꼭대기에 올라서는 바닥의 높이 (옥상 윗면). */
  topY: number;
  /** 사다리 면에서 **매달린 사람 쪽**으로 향하는 수평 단위 벡터. 매달리면 `-normal` 을 바라본다. */
  normal: THREE.Vector3;
  /** 꼭대기에서 올라선 뒤 서는 자리 (y = `topY`). 사다리 위쪽 너머(`-normal` 방향) 바닥이다. */
  exit: THREE.Vector3;
}

export interface WorldRef {
  /* ── appended (2026-09-11) ── */
  /** 이번 맵의 사다리 전부 (훈련장 · 구조물이 없으면 빈 배열). */
  getLadders(): readonly LadderDef[];
}

export interface PlayerRef {
  /* ── appended (2026-09-11): 사다리 (owner: player) ── */
  /** 지금 매달려 있는 사다리 id. 매달려 있지 않으면 null (없으면 null 과 같다). */
  readonly climbingLadder?: string | null;
}

export interface PlayerRef {
  /* ── appended (2026-09-11): 드론 조종 (owner: player; caller: gadgets/drones — shared/drones.ts) ── */
  /** true while the local player looks through a drone (`setDroneControl(true)`). */
  readonly droneControl?: boolean;
  /**
   * 드론 조종 모드. true 인 동안: 이동 · 점프 · 자세 · 구르기 입력을 무시하고 몸을 세운다(속도 0), **앉기 자세를 강제**하고
   * (false 가 되면 켜기 직전 자세로 돌린다), 조준 해제 · `canUseWeapons()` false · E 상호작용 없음, 마우스 시점은 카메라
   * 리그에 적용하지 않는다 — 카메라는 drones 가 매 프레임 `setCameraOverride(pos, look, true)` 로 준다.
   * 피해는 그대로 받는다 (조종을 끊는 것은 drones 가 `player:damaged` 를 보고 한다).
   * 전투불능 · 사망 · `respawnAt` · `spawnStanding` · `game:abort` 가 false 로 되돌린다.
   */
  setDroneControl?(active: boolean): void;
}

/* ══ appended (2026-09-12): 서재 매체 (A-3e) · 헬스장 (A-3a) — docs/plans/a3a-a3e.md ═══════════════════════════════ */

export interface ItemDef {
  /* ── appended (A-3e, owner: items) ── */
  /** category 'disc': 서재 디스크 전시대에 꽂으면 올리는 숙련. 모양은 `BookDef` 와 같다 (등급 = `BOOK_RARITY_MUL` 가중치). */
  disc?: BookDef;
  /** category 'record': 서재 레코드랙에 꽂으면 올리는 숙련. */
  record?: BookDef;
}

/** 가구에 몸을 맡기는 자세 (owner: player; caller: hub). `sit` = 흔들의자, 나머지 셋 = 헬스장 운동 기구. */
export type FurniturePoseKind = 'sit' | 'bench' | 'run' | 'cycle'
  /**
   * appended (2026-09-13, 요리 미니게임): 조리대 앞에 서서 손을 놀리는 자세. anchor = 조리대 앞 **바닥**(서는 자리), yaw = 조리대를 본다.
   * 드라이브 위상 = 손 동작 누적 주기 (썰기 · 다지기 = 칼질 한 번, 젓기 = 국자 한 바퀴, 볶기 = 팬 한 번 튕김, 굽기 · 붓기 = 느린 흔들림).
   */
  | 'cook';

export interface FurniturePose {
  kind: FurniturePoseKind;
  /**
   * 몸을 받치는 면의 월드 좌표 — `sit`: 좌판 윗면 중앙 · `bench`: 벤치 패드 윗면의 **등(견갑골) 자리** ·
   * `run`: 러닝 벨트 윗면 중앙 · `cycle`: 안장 윗면. 몸의 오프셋(엉덩이 높이 · 누운 몸 길이)은 player 가 정한다.
   */
  anchor: THREE.Vector3;
  /**
   * 향하는 방향 — 플레이어 카메라 yaw 와 같은 규약 (앞 = `(−sin yaw, 0, −cos yaw)`). `bench` 는 **엉덩이 → 머리** 방향이다
   * (누워서 바벨 거치대 쪽으로 머리를 둔다).
   */
  yaw: number;
  /** 고정 카메라. 없으면 평소 3인칭 리그(마우스 시점 자유) — 흔들의자는 생략, 운동 기구는 옆에서 비추는 고정 카메라를 준다. */
  camera?: { position: THREE.Vector3; lookAt: THREE.Vector3 } | null;
  /** true 면 E(`Keys.INTERACT`)로 자세가 풀린다 (흔들의자 토글). 운동 기구는 부른 쪽(`setFurniturePose(null)`)만 푼다. */
  releaseOnInteract?: boolean;
}

export interface PlayerRef {
  /* ── appended (2026-09-12): 가구 자세 (owner: player; caller: hub) ── */
  /** 지금 취하고 있는 가구 자세, 없으면 null. */
  readonly furniturePose?: FurniturePoseKind | null;
  /**
   * 가구 자세를 취한다 / 푼다. 취하는 동안: 이동 · 점프 · 자세 · 구르기 · 무기 · (releaseOnInteract 가 아니면) E 상호작용을
   * 무시하고 몸을 `anchor` 에 붙여 자세 애니메이션을 돈다. `camera` 가 있으면 그 자리로 블렌드한다. **풀면 자세를 취하기 직전에
   * 서 있던 자리로 돌아간다** (가구 콜라이더 안에 남지 않는다). 함선(`phase === 'hub'`)에서만 — 레이드 · 드론 조종 · 사다리 ·
   * 포드 · 전투불능이면 false 를 돌려주고 아무것도 바꾸지 않는다. `game:abort` · `hub:left` · 페이즈 변경 · `spawnStanding` 이
   * 풀고 `player:furniturePoseEnded {reason:'reset'}` 을 낸다.
   */
  setFurniturePose?(pose: FurniturePose | null): boolean;
  /**
   * 운동 자세의 동작 위상 0 … 1 — `bench`: 0 = 바벨이 가슴 · 1 = 팔을 다 편 자리, `run`: 한 걸음 주기(0 → 1 반복),
   * `cycle`: 크랭크 한 바퀴(0 = 왼발이 위 · 0.5 = 오른발이 위). hub 가 바벨 · 페달 모델과 같은 값으로 매 프레임 준다.
   * 한 번도 부르지 않으면 player 가 스스로 기본 속도로 돌린다. `sit` 에는 쓰지 않는다.
   */
  setFurniturePoseDrive?(phase: number): void;
}

/* ══ appended (2026-09-12): 캐릭터 버프 · 가구 자세 동기화 — docs/plans/char-buffs.md ═══════════════════════════ */
import type { CharBuff } from './charBuffs';

export interface FurniturePose {
  /**
   * appended (2026-09-12): 몸을 맡긴 가구 조각의 uid (hub 가 넣는다). 버프(`rest` · `exercise`)와 원격 동기화(`PlayerSnapshot.fu`)가
   * 이것으로 그 가구를 가리킨다 — 방문자 쪽 hub 가 그 조각의 바벨 · 벨트 · 크랭크를 같은 위상으로 돌린다. 생략 = 모른다.
   */
  furnitureUid?: string;
}

/** 지금 취한 가구 자세를 와이어로 보낼 모양 (`PlayerRef.furniturePoseState`, owner: player). */
export interface FurniturePoseState {
  kind: FurniturePoseKind;
  /** `FurniturePose.anchor` 그대로 (월드). */
  anchor: Readonly<THREE.Vector3>;
  /** `FurniturePose.yaw` 그대로 (카메라 yaw 규약, `bench` 는 엉덩이 → 머리). */
  yaw: number;
  /**
   * **감지 않은 누적 위상** — 받는 쪽이 스냅샷 사이를 선형 보간할 수 있어야 한다. `bench`: 0 … 1 (바벨 가슴 → 팔 다 편 자리, 감지
   * 않는 값이 원래 이것이다) · `run`: 걸음 수(정수부 = 몇 번째 걸음, 소수부 = 한 걸음 안의 위상) · `cycle`: 크랭크 바퀴 수 ·
   * `sit`: 0.
   */
  phase: number;
  /** `FurniturePose.furnitureUid`, 모르면 null. */
  furnitureUid: string | null;
}

export interface PlayerRef {
  /* ── appended (2026-09-12): 캐릭터 버프 (owner: player) ── */
  /** 지금 가구 자세의 와이어 값, 자세가 없으면 null. net 이 스냅샷 `fp` · `fu` 로 싣는다. */
  readonly furniturePoseState?: FurniturePoseState | null;
  /**
   * 이 캐릭터에 걸린 버프 · 디버프 전부 (`CharBuff`, `CHAR_BUFF_ORDER` 순). player 가 progression(식사 · 준비물 · 운동 디버프) ·
   * housing(운동 세션) · 자기 자세(휴식 · 운동) · 자기 환경 판정(노출)을 모아 **바뀔 때만** 새 배열로 갈아 끼운다
   * (같은 배열이면 안 바뀐 것이다 — 소비자는 참조로 비교해도 된다). 시각은 `ctx.net.serverNow() ?? Date.now()` 의 epoch ms.
   */
  readonly buffs?: readonly CharBuff[];
  /** `buffs` 가 바뀔 때마다 +1 (1 부터). net 이 스냅샷 `bfr` 로 싣고, 받는 쪽은 이 번호로 목록이 낡았는지 안다. */
  readonly buffsRevision?: number;
}

/* ══ appended (2026-09-11): C 항목 배치 계약 (docs/plans/c-batch.md §3-2) ═══════════════════════════════════ */

export interface EnemyManagerRef {
  /**
   * appended (2026-09-11, C-1 · X-6 — 2026-09-08 부터 `EnemySystem` 의 캐스트 전용 메서드였다). Shove every alive
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
  /* ── appended (2026-09-11, C-3): 오버차지 (owner: player; caller: implants `applyBoost`) ── */
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
  /* ── appended (2026-09-11, C-22): 재질별 발소리 (owner: world; callers: audio · enemies) ── */
  /**
   * Material under `(x, z)`. With `feetY` the obstacle a body at that foot height stands on wins
   * (`getStandingObstacle` rules), otherwise the terrain band there. One hash query — cheap enough per footstep.
   * Optional so a world that has not generated yet (or a stub) may omit it; callers fall back to `'dirt'`.
   */
  getSurfaceMaterial?(x: number, z: number, feetY?: number): SurfaceMaterial;
}

/* ══ appended (2026-09-11): 연구실 — 분석기 · 추출기 · 조합대 (A-11 · A-12 · A-13) ══════════════════════════
 *
 * 세 줄기가 한 방(`lab`)에서 만난다:
 *   ① **미확인 표본**(`ItemDef.sample`)을 레이드에서 주워 온다 — 버그 시체 · 새 채집 노드 · 구조물 컨테이너.
 *      (로그는 표본에 관심이 없다 — 로그 시체에서는 나오지 않는다. 사용자 결정 2026-09-11.)
 *   ② **분석기**가 그것을 현실 시간만큼 해석해 **해석 도감**(`ShipState.sampleDex`)을 채우고, 도감이 찰수록
 *      다음 해석이 빨라진다. 해석 보상이 새 품종 씨앗의 두 공급원 중 하나다 (다른 하나는 행성별 야생 채집).
 *   ③ **추출기 · 조합대**는 평범한 작업대다 (`WorkbenchKind` += `'extract'` · `'mixer'`) — 작물 · 표본 산물에서
 *      성분을 뽑고(추출기), 그 성분으로 **준비물**(`ItemDef.prep`)을 만든다(조합대).
 *
 * 준비물은 **함선에서 쓰면 다음 레이드 1회분**으로 실린다 (사용자 결정): `PlayerProfile.prep` 에 쌓였다가 출격
 * 순간 `prepActive` 로 옮겨져 그 레이드 내내 유지되고 (사망해도 그 레이드는 유지), 레이드가 끝나면 비워진다.
 * 프로필에 사는 덕분에 재접속으로 돌아온 사람이 조용히 잃지 않는다 (2026-09-10 규약).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * 행성 상시 환경 (A-13, 사용자 결정 2026-09-11 — threat 3 두 곳만). `data/planets.csv` 의 `env` 열이고 빈 칸이면
 * 없다. 맞는 준비물 없이 그 행성에 있으면 `PLANET_ENV_DPS` 로 **체력만** 깎인다 (방탄복 실드는 대기를 막지 못한다).
 * 소프트 게이트다 — 들어가는 것 자체는 막지 않는다.
 */
export type EnvKind = 'heat' | 'toxin';
export const ENV_KINDS: readonly EnvKind[] = ['heat', 'toxin'];

/**
 * 미확인 표본 data (A-12, owner: items — `data/samples.csv`). 해석은 **현실 시간**이라 함선을 떠나 있어도 흐른다
 * (온실과 같은 규약: `startedAt` / `readyAt` 는 `ctx.net.serverNow() ?? Date.now()` 의 epoch ms 이고, 시작한 뒤에는
 * 도감이 더 차도 **돌아가던 타이머는 움직이지 않는다**).
 */
export interface SampleDef {
  /** 도감이 텅 빈 상태에서 한 번 해석하는 데 걸리는 실제 시간(시간). 도감 진척 · 기지식이 여기서 깎는다. */
  analyzeHours: number;
  /** 해석이 끝나면 손에 들어오는 것 (가방 → 함선 창고). */
  rewardDefId: string;
  rewardQty: number;
  /** **처음** 해석했을 때(= 도감에 없던 표본)만 얹어 주는 것. 없으면 보너스 없음. */
  firstDefId?: string;
  firstQty?: number;
}

/**
 * 준비물 data (A-13, owner: items — `data/items.csv` 의 `prepEnv` · `prepShort` 칸). 함선에서 써서 다음 레이드에
 * 싣는 1회분이고, 같은 `env` 를 두 번 싣지는 못한다 (두 번째는 한국어 사유로 거절 — 조용히 삼키지 않는다).
 */
export interface PrepDef {
  /** 이 준비물이 상쇄하는 행성 환경. 실려 있으면 그 환경의 피해가 **0** 이 된다 (사용자 결정: 완전 상쇄). */
  env: EnvKind;
  /** HUD 배지에 찍는 짧은 이름 (「방독」 · 「내열」). */
  short: string;
}

export interface ItemDef {
  /* ── appended (2026-09-11, owner: items) ── */
  /** category 'sample': 분석기가 해석하는 데 드는 시간과 그 산출물. */
  sample?: SampleDef;
  /** category 'prep': 어떤 행성 환경을 막아 주는 다음 레이드 1회분인가. */
  prep?: PrepDef;
}

export interface WorldRef {
  /* ── appended (2026-09-11, A-13): 행성 상시 환경 (owner: world; callers: player · ui · hub) ── */
  /**
   * 이번 레이드 행성의 상시 환경, 없으면 null (훈련장도 null). `getPlanet(id)?.env` 를 그대로 돌려주는 얇은 질의다 —
   * 행성 id 를 들고 다니지 않아도 되도록 world 가 대신 답한다.
   */
  readonly env?: EnvKind | null;
}

/* ══ appended (2026-09-11, A-3c · A-14 · A-15): 주방 · 배양조 · 3D 프린터 ═══════════════════════════════════
 *
 * 사용자 6단계 명세의 **5 · 6단계**(배양조 · 프린터)와 **주방**을 한 사이클에 넣는다. 셋은 하나의 사슬이다:
 *
 *   레이드 표본 `spec_*` ──분석기──▶ 세포주 `strain_*` ─┐
 *   온실 작물 `crop_*` ──추출기──▶ 배지 `mat_medium_*` ─┴─배양조──▶ 배양 산물 `cult_*`
 *        ├─ 조리대(`cook`) ──▶ 특선 요리 ──▶ 식탁 ──▶ **식사 1칸** (다음 레이드 1회분)
 *        └─ 추출기 ──▶ 필라멘트 3등급 ──▶ 프린터(`print`) ──▶ 희귀 · 서사 · 전설 가방 · 주머니 4종
 *
 * 이 사슬이 작물 8종의 네 번째 소비처(조리대)를 만들고, 「높은 등급 가방일수록 구하기 어려운 표본에서
 * 나온다」(사용자 결정)를 데이터 하나로 성립시킨다.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * 요리가 올려 주는 파생 수치 한 가지. 값은 전부 `DerivedStats` 에 **이미 있는 필드 이름**이다 — 그것이 요점이다:
 * 버프를 새 개념으로 만들면 player · weapons · world · inventory 가 전부 그 개념을 읽어야 하지만, 파생 수치에
 * 접어 넣으면 **소비자가 한 줄도 안 바뀐다** (이미 `ctx.progression.derived` 를 읽고 있다).
 *
 * ⚠ 크레딧 · 판매가 배수는 **일부러 없다**. 서버가 크레딧을 사유별로 검증하므로(E-4) 클라이언트가 배수를
 * 얹으면 그대로 `credits:tx` 거절이 된다. 보상계 버프는 숙련 XP · 채집량 · 감정 속도로 낸다.
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

/** 이름이 `*Mul` 로 끝나는 버프는 **배수에 가산**된다 (0.15 = +15 %); 나머지는 그 수치의 단위 그대로 더해진다. */
export const isMealBuffMultiplier = (b: MealBuff): boolean => b.endsWith('Mul') || b === 'gritChance';

/**
 * 요리 data (A-3c, owner: items — `data/meals.csv`). 한 요리는 **버프 하나**만 올린다 (사용자 결정: 요리마다
 * 한 가지씩, 생존계 · 보상계를 섞어서). 함선의 식탁에서 먹으면 다음 레이드 1회분으로 실리고, 수명 규칙은
 * 준비물과 완전히 같다 (`PlayerProfile.meal` → `mealActive`, 사망해도 그 레이드는 유지).
 */
export interface MealDef {
  buff: MealBuff;
  /** 가산값. `isMealBuffMultiplier` 인 버프는 배수에 더해지고, 나머지는 단위 그대로. `durabilityLossMul` 만 음수다. */
  amount: number;
  /**
   * 1 = 채소 요리(작물만) · 2 = 고기 페이스트 요리 · 3 = 고기 · 동물기름 요리 · 4 = 난백 · 유단백 요리. 툴팁 · 정렬용.
   * (2026-09-13 요리 재료 티어로 넓혔다 — 옛 「2 = 특선 요리」는 은퇴한 네 요리뿐이다. 이름표는 `MEAL_TIER_LABEL_KO`.)
   */
  tier: 1 | 2 | 3 | 4;
}

/**
 * 주머니 data (A-15, owner: items — `data/items.csv` 의 `pouchCols` · `pouchRows` · `pouchAccepts`).
 *
 * 주머니는 **가방이 아니다** — 장비칸의 `pouch` 한 칸에 끼우는 별도 컨테이너이고, 장착하면 퀵슬롯 아래에
 * 자기 격자가 생긴다 (사용자 결정). 2026-09-09 의 「퀵슬롯은 가방 격자가 아니다」가 만든 패턴 그대로다:
 * 무게 · `countWhere` · `consumeWhere` · `stripForCorpse` · 레이드 blob 은 주머니를 보고,
 * `getAllItems()`(거래 · 수리 목록)는 **여전히 가방 격자만**이다.
 */
export interface PouchDef {
  cols: number;
  rows: number;
  /** 이 주머니가 받아 주는 아이템 카테고리. 그 밖의 것은 격자가 거절한다. */
  accepts: readonly ItemCategory[];
}

/**
 * 세포주 · 균주 data (A-14, owner: items). 분석기 해석의 산출물이고, 배양조 칸에 **배지를 부은 뒤** 넣는다.
 * 배양 시간은 넣는 순간 `readyAt` 에 확정된다 (온실 · 분석기와 같은 규약).
 */
export interface StrainDef {
  outputDefId: string;
  outputQty: number;
  /** 기본 배지 기준 배양 시간(시간). 배지 등급(`MediumDef.speedMul`)과 원예 숙련이 여기서 깎는다. */
  cultureHours: number;
}

/**
 * 영양 배지 data (A-14, owner: items). 추출기에서 만든다 — 온실 산물의 새 소비처다.
 * 토양과 같은 소모 규약: **수확마다 1회** 닳고 0 이면 칸이 완전히 빈다.
 *
 * 토양의 태그 매칭과 달리 배지는 **등급 하나**다 (축을 하나 더 만들 이유가 없다는 판단).
 */
export interface MediumDef {
  /** 이 배지가 버티는 수확 횟수. */
  uses: number;
  /** 배양 시간 배수 (1 = 기본, 0.75 = 25 % 빠름). */
  speedMul: number;
}

export interface ItemDef {
  /* ── appended (2026-09-11, A-3c · A-14 · A-15; owner: items) ── */
  /** category 'meal': 어떤 파생 수치를 얼마나 올려 주는 다음 레이드 1회분인가. */
  meal?: MealDef;
  /** category 'pouch': 장비칸 `pouch` 에 끼우면 열리는 별도 격자. */
  pouch?: PouchDef;
  /** 세포주 · 균주 (category 'material'): 배양조가 무엇을 얼마나 오래 만드는가. */
  strain?: StrainDef;
  /** 영양 배지 (category 'material'): 배양조 칸에 붓는 것. */
  medium?: MediumDef;
}

export interface InventoryRef {
  /* ── appended (2026-09-11, A-15): 주머니 (owner: inventory; callers: ui · housing) ── */
  /** 지금 장착한 주머니 아이템, 없으면 null. */
  getEquippedPouch?(): ItemInstance | null;
  /** 장착한 주머니의 격자 크기. 주머니가 없으면 `{ cols: 0, rows: 0 }` — 그 자리를 통째로 안 그린다는 뜻이다. */
  getPouchSize?(): { cols: number; rows: number };
}

/* ══ appended: 2026-09-12 — 소모품 · 임플란트 · 열쇠 · 드론 스캔 · 즐겨찾기 · 헬스. docs/plans/consumables-keys-favorites.md ══
 * 병렬 에이전트마다 **자기 블록 안에만** 추가한다 (인터페이스 병합 — `export interface PlayerRef { … }` 처럼 그 안에 쓴다).
 * 기존 선언은 이름 변경 · 삭제 금지. 블록 순서를 바꾸지 않는다. */
/* ── [A1] 소모품 3종 (PlayerRef boost · ItemDef) ── */
/**
 * 소모품이 거는 시간제 효과 (2026-09-12, owner: player — `parts/Boosts`). 한 번에 하나만 걸린다: 새로 쓴 것이 앞의 것을 지운다.
 *   `adrenaline` 아드레날린 주사 — 스태미나 전량 + 지속 소모 0 (`BOOST_ADRENALINE_DURATION_S`)
 *   `stimulant`  각성제 — 장전 · 정조준 빠름 · 조준 흔들림 감소 / 스태미나 소모 증가 (`BOOST_STIMULANT_*`)
 * 안정제(임플란트 재충전)는 시간제 효과가 아니라서 여기 없다 — weapons 가 `ImplantsRef.refillAll` 을 부른다.
 */
export type BoostKind = 'adrenaline' | 'stimulant';

export interface PlayerRef {
  /* ── appended (2026-09-12, A1): 소모품 효과 (owner: player; caller: weapons `parts/Healing.finishHeal`) ── */
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
/* ── [A2] 조준 흔들림 ── */
export interface PlayerWeaponHost {
  /**
   * 조준 흔들림 (2026-09-12, weapons → player): 손에 든 무기 계열의 정조준 흔들림 — 좌우 최대 각도(도)와 좌우 왕복 빈도(Hz)
   * (`data/aim_sway.csv`). 0 = 흔들림 없음 (손에 무기가 없다 · 넣었다 · RMB 가 대체 사격인 유니크). 장착 · 교체 · 해제마다
   * `setAimZoom` 옆에서 부른다. 실제 흔들림은 player 가 정조준 정도 · 자세 · 이동 · `aimSwayMul` 로 키우고 줄인다.
   */
  setAimSway?(amplitudeDeg: number, frequencyHz: number): void;
}
/* ── end [A2] ── */
/* ── [B] 전술 임플란트 (ImplantsRef 는 shared/implants.ts) ── */
/* ── end [B] ── */
/* ── [C] 열쇠 · 키카드 · 잠긴 방 · 개구멍 (WorldRef.resolveCollision height · previewContainerItems) ── */
export interface WorldRef {
  /**
   * appended (2026-09-12, C): **키를 밝힌 몸**의 밀어내기. `height` 를 주면 떠 있는 상자(인방 · 슬래브 · 전차 바닥)를
   * 사람 기준 `BOX_HEADROOM` 이 아니라 **그 키**로 잰다 — 밑면이 `발 + height` 보다 높으면 머리 위로 지나간다.
   * 지상드론(`GroundDrone`)이 잠긴 문 옆 **개구멍**(인방 밑면이 드론 키보다 조금 높은 벽 틈)을 지나가는 유일한 길이다.
   * 안 넘기면 예전과 한 줄도 다르지 않다 (플레이어 · 적 · 원격 · 투척물).
   */
  resolveCollision(position: THREE.Vector3, radius: number, height?: number): THREE.Vector3;
  /**
   * appended (2026-09-12, C): world 가 가진 컨테이너(구조물 지상 `_c` · 지하실 `_b` · 잠긴 방 `_l` · 선로 플랫폼 ·
   * 전차 · 맵 상자)를 **이 클라이언트가 처음 열면 나올 내용물** — 열쇠 · 키카드 부가 굴림까지 포함한다. 여는 코드와
   * **같은 함수**라 어긋나지 않는다. 순수 · 결정적이다 (열린 표시 · 이벤트 · 캐시 없음). world 의 것이 아니거나
   * 월드가 준비 전이면 null. 이미 연 컨테이너의 **지금** 내용물은 inventory 의 캐시가 답한다 (이 함수는 모른다).
   */
  previewContainerItems?(containerId: string): ItemInstance[] | null;
}
export interface StructureDef {
  /** appended (2026-09-12, C): 2층 **잠긴 방**이 있는가 (2층이 올라간 연구소만). 없으면 false/undefined. */
  hasLockedRoom?: boolean;
  /** 잠긴 방 문의 위치 (문짝 밑변 가운데). 없으면 null/undefined. */
  lockedRoomDoor?: THREE.Vector3 | null;
  /**
   * 이 구조물의 잠긴 문(지하실 · 잠긴 방 — 구조물마다 많아야 하나)을 여는 아이템 def id
   * (`key_basement` 지하실 열쇠 · `keycard_lab` 연구소 키카드). 잠긴 문이 없으면 null/undefined.
   * 여는 사람의 것이 1 개 소모된다. `unlocked` 는 이 문 하나의 상태다.
   */
  unlockDefId?: string | null;
}
/* ── end [C] ── */
/* ── [D] 지상드론 스캔 ── */
export interface InventoryRef {
  /* ── appended (2026-09-12, 드론 스캔; owner: inventory `parts/Peek`, caller: gadgets/drones `parts/Scan`) ── */
  /**
   * 컨테이너를 **열지 않고** 지금 열면 보일 내용물. 이 클라이언트가 이미 굴린(연) 컨테이너면 지금 들어 있는 것이고,
   * 아니면 `tier`(≥ 1)로 `openContainer` 와 **같은** 결정적 굴림(`missionSeed ^ hash(id)` · 행성 곡선) + 같은 격자 채우기
   * (넘치는 것 탈락) + 이미 확정된 남의 가져가기(`pendingTaken`)를 흉내 낸다. `tier` 없이 모르는 id 면 null.
   * 캐시 · `openedIds` · 감정 상태 · 이벤트 어느 것도 바꾸지 않는다. 돌려준 목록은 **읽기 전용**이다.
   */
  peekContainerItems?(containerId: string, tier?: number): readonly ItemInstance[] | null;
  /**
   * 내용물을 호출자가 대는 컨테이너(시체 · 열쇠가 든 구조물 컨테이너)의 같은 질의. `cols` 가 없으면 `openContainerItems`
   * (기본 6×4), 있으면 `openContainerItemsSized`(전부 들어가도록 행을 늘린다)와 같은 채우기다. 이미 굴린 id 면 `items` 를
   * 무시하고 지금 내용물. 읽기 전용.
   */
  peekSuppliedItems?(containerId: string, items: readonly ItemInstance[], cols?: number, rows?: number): readonly ItemInstance[];
}
/* ── end [D] ── */
/* ── [E1] 즐겨찾기 코어 (InventoryRef) ── */
export interface InventoryRef {
  /* ── appended (2026-09-12, E1): 아이템 즐겨찾기 (owner: inventory; callers: meta · ui 칩 위임) ──
   * 즐겨찾기는 **아이템 종류(def id)** 단위다 — 같은 아이템은 전부 표시된다. 캐릭터별이고 로드아웃 문서(`loadout`)의
   * `fav` 목록에 실려 서버와 동기화된다. 가지고 있지 않은 아이템도 켤 수 있다. */
  /** 이 아이템 종류가 즐겨찾기인가. */
  isFavorite?(defId: string): boolean;
  /**
   * 즐겨찾기를 켜거나 끈다. `on` 을 주면 그 상태로, 생략하면 뒤집는다. 돌려주는 값은 **새 상태**다.
   * 모르는 def id 는 아무것도 바꾸지 않고 false. 실제로 바뀌면 `inventory:favoritesChanged` 가 난다.
   */
  toggleFavorite?(defId: string, on?: boolean): boolean;
  /** 지금 즐겨찾기한 def id 전부 (정렬됨, 읽기 전용 사본). */
  readonly favoriteDefIds?: readonly string[];
}
/* ── end [E1] ── */
/* ── [E2] 즐겨찾기 칩 · 아이템 회수 계약 ── */
/* ── end [E2] ── */
/* ── [F] 헬스 미니게임 ── */
/* ── end [F] ── */

/* ══ appended: 2026-09-12 — 아이템 회수 계약: 「이번 레이드에서 얻은 아이템」 표식 (§5-2, 규칙은 `shared/raidFound.ts`) ══ */
export interface ItemInstance {
  /**
   * 이 인스턴스를 **만든 레이드의 맵 시드** (`WorldRef.seed`, `>>> 0`). 레이드 루팅 굴림(상자 · 컨테이너 · 보급 · 적 시체 ·
   * 채집)만 찍고, 함선에서 가져온 것 · 제작 · 상점 · 지급품에는 없다. 아이템과 함께 다닌다 — 픽업 와이어(`PickupWire.rf`) ·
   * 시체 와이어(`CorpseItemWire.rf`) · 레이드 세션 blob(`SavedExtras.rf`). **생략 = 레이드에서 얻은 것이 아니다.**
   * 프로필 문서(창고 · 로드아웃)에는 실리지 않고, 레이드가 끝나면 inventory 가 지운다.
   */
  raidFound?: number;
}
/* ══ end 2026-09-12 아이템 회수 표식 ══ */

/* ══ appended: 2026-09-13 — 요리 재료 티어 (docs/plans/food-tiers.md, 사용자 결정) ═══════════════════════════════
 *
 *   T1  행성 씨앗 · 토양 ──온실 재배 스테이션──▶ 채소 · 버섯 ──조리대──▶ 채소 요리 (능력치 1)
 *   T2  미확인 세포 ──분석기──▶ 소 · 돼지 · 닭 · 양 세포주 ─┐
 *       작물 ──추출기──▶ 영양 배지 ─────────────────────────┴─배양조──▶ 고기 페이스트 ─┐
 *       미확인 광물 ──분석기──▶ 암염 결정 ──추출기──▶ 소금 ────────────────────────────┴─조리대──▶ 페이스트 요리 (능력치 2)
 *   T3  미확인 세포 ──분석기 Lv.3──▶ 미세조류 세포주 ──배양조──▶ 셀룰로스 ──조합대──▶ 배양 스캐폴드
 *       배지 + 스캐폴드 + 세포주 ──배양조──▶ 종별 고기 · 배양지방 세포주 ──배양조──▶ 동물기름 ──조리대──▶ 고기 요리 (능력치 3)
 *   T4  미확인 DNA ──분석기 Lv.3──▶ 난백 · 유단백 세포 ──추출기──▶ 성분 ──조합대(+ 동물기름 · 소금)──▶ 달걀 · 우유 · 치즈
 *       ──조리대──▶ 유제품 요리 (능력치 4)
 *   소켓 미확인 DNA ──분석기──▶ 토양 · 배지 소켓 ──▶ 재배 칸의 흙 · 배양 칸의 배지에 영구 장착
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * 미확인 표본의 **계열** (사용자 결정: 표본을 3종으로 통합). 분석기의 결과표 · 분석 레벨이 계열 단위다.
 * 새 드롭은 `spec_cell` · `spec_mineral` · `spec_dna` 셋뿐이고, 옛 표본 11종은 정의가 남은 채(`ItemDef.retired`)
 * 자기 계열의 표본으로 해석된다 — 이미 가진 것이 사라지지 않는다.
 */
export type SampleFamily = 'dna' | 'mineral' | 'cell';
/** 계열의 표시 순서 (분석 도감 · 레일). */
export const SAMPLE_FAMILIES: readonly SampleFamily[] = ['cell', 'mineral', 'dna'];

export interface SampleDef {
  /**
   * appended (2026-09-13): 이 표본이 해석되는 계열. 결과는 계열 결과표(`shared/housing` 의 `ANALYSIS_RESULTS`)에서 뽑힌다 —
   * `rewardDefId` · `rewardQty` 는 이제 **결과표가 비었을 때의 대체 산출물**일 뿐이고 `first*` 보너스는 더 주지 않는다.
   */
  family: SampleFamily;
}

/** 소켓이 끼워지는 곳 — 재배 칸에 부어 둔 흙(`soil`) · 배양 칸에 부어 둔 배지(`medium`). */
export type GrowSocketTarget = 'soil' | 'medium';
export const GROW_SOCKET_TARGETS: readonly GrowSocketTarget[] = ['soil', 'medium'];

/**
 * 소켓 효과. `speed` · `yield` 는 **그 칸의 흙 · 배지 내구도 비율**만큼만 듣는다 (`wear` 는 내구도 자체를 지키므로 예외):
 *  - `speed` — 성장 · 배양 시간 −amount (심는 · 넣는 순간 `readyAt` 에 확정, 합산한 배수의 바닥은 `GROW_SOCKET_TIME_FLOOR`)
 *  - `yield` — 수확할 때 소켓마다 amount 확률로 +1 개
 *  - `wear`  — 수확마다 닳는 내구도 −amount (합산한 배수의 바닥은 `GROW_WEAR_MUL_FLOOR`)
 */
export type GrowSocketEffect = 'speed' | 'yield' | 'wear';
export const GROW_SOCKET_EFFECTS: readonly GrowSocketEffect[] = ['speed', 'yield', 'wear'];

/** 소켓 data (owner: items — `data/sockets.csv`). 한 번 끼우면 빠지지 않는다 (사용자 결정: 덮어 끼우면 옛 것은 파괴). */
export interface GrowSocketDef {
  target: GrowSocketTarget;
  effect: GrowSocketEffect;
  /** `speed` · `wear` = 비율(0.1 = 10 %), `yield` = +1 개 확률(0 … 1). */
  amount: number;
}

export interface SoilDef {
  /**
   * appended (2026-09-13): 최대 내구도. 부어 둔 흙은 수확마다 `SOIL_WEAR_PER_HARVEST` 만큼 닳고 **0 이어도 계속 쓴다** —
   * 다만 궁합 보너스(`SOIL_MATCH_SPEEDUP`)와 소켓 효과가 `내구도 / 최대` 비율로 줄어 0 에서는 사라진다. 궁합 패널티는 그대로다.
   * `uses` 는 옛 세이브의 `soilUsesLeft` 를 내구도로 옮기는 데만 쓴다.
   */
  durability: number;
}

export interface MediumDef {
  /**
   * appended (2026-09-13, 사용자 결정: 토양과 같은 내구도 규칙): 최대 내구도. 수확마다 `MEDIUM_WEAR_PER_HARVEST` 만큼 닳고
   * 0 이어도 계속 쓴다 — 배지 속도 보너스(`1 − speedMul`)와 소켓 효과가 내구도 비율로 줄어든다. `uses` 는 옛 세이브 이관용.
   */
  durability: number;
}

export interface StrainDef {
  /**
   * appended (2026-09-13, T3): 배양 칸에 **배양 스캐폴드**가 들어 있으면 `outputDefId` 대신 이것을 만든다 (종별 고기).
   * 셋은 함께 있거나 함께 없다 — 없는 세포주(미세조류 · 배양지방)는 스캐폴드가 든 칸에 넣을 수 없다.
   */
  scaffoldOutputDefId?: string;
  scaffoldOutputQty?: number;
  /** 기본 배지 기준 배양 시간(시간) — 스캐폴드가 있을 때. */
  scaffoldHours?: number;
}

/** 요리 버프에 붙는 능력치 상승 하나. */
export interface MealEffect {
  buff: MealBuff;
  /** `isMealBuffMultiplier` 면 배수에 가산, 아니면 단위 그대로 (`durabilityLossMul` 은 음수). */
  amount: number;
}

export interface MealDef {
  /**
   * appended (2026-09-13, 사용자 결정: 「버프 자체는 1개이고 그 1개의 버프에 여러 능력치 상승이 붙는다」). 이 요리가 올리는
   * 능력치 전부 — 티어가 오를수록 수치도 커지고 줄도 는다 (T1 1 · T2 2 · T3 3 · T4 4). **소비자는 이것을 읽는다.**
   * `buff` · `amount` 는 `effects[0]` 과 같다 (옛 호출부 호환 — 새 코드는 쓰지 않는다).
   */
  effects: readonly MealEffect[];
}

export interface ItemDef {
  /* ── appended (2026-09-13, 요리 재료 티어; owner: items) ── */
  /** category 'socket': 부어 둔 흙 · 배지에 끼우는 영구 강화. */
  growSocket?: GrowSocketDef;
  /** 배양 스캐폴드 (category 'material'): 배양 칸에 배지 다음 · 세포주 전에 넣으면 그 칸이 종별 고기를 만든다. 수확할 때 소모된다. */
  scaffold?: boolean;
  /**
   * 은퇴한 아이템 (옛 표본 11종 · 옛 세포주 5 · 배양 산물 5 · 특선 요리 4). 정의는 남고(가진 것이 사라지지 않는다)
   * **모든 출처**(루팅 · 상점 · 레시피 산출 · 분석 결과 · 채집지 · 배양)에서 빠진다. `npm run data:check` 가 참조를 잡는다.
   */
  retired?: boolean;
}
/* ══ end 2026-09-13 요리 재료 티어 ══ */

/* ══ appended: 2026-09-13 — 요리 미니게임 · 요리 품질 (docs/plans/cooking-minigames.md, 규칙은 `shared/cooking.ts`) ══ */
export interface ItemInstance {
  /**
   * 요리(`ItemDef.meal`)의 품질 — 별 수 0 … `MEAL_QUALITY_MAX`. 조리대 미니게임 점수가 정한다 (`mealQualityForScore`).
   * 생략 = 0 (옛 요리 · 루팅 · 요리가 아닌 아이템). **품질이 다르면 같은 def 라도 합쳐지지 않는다** (inventory 의 스택 열쇠).
   * `raidFound` 와 달리 **창고 · 로드아웃 문서에도 실린다** (`SavedExtras.q`) — 그리고 픽업 · 시체 와이어(`PickupWire.q` · `CorpseItemWire.q`) ·
   * 레이드 blob 모두. 스택을 나누거나 복사하는 경로는 이 필드를 옮긴다 (생략 = 품질 0 으로 떨어진다).
   */
  quality?: number;
}

export interface InventoryRef {
  /* ── appended (2026-09-13, 요리 미니게임 · 요리 품질; owner: inventory) ── */
  /** 가방 + 창고의 `defId` 중 품질이 정확히 `quality` 인 수량 (`quality` 0 = 품질 필드 없음 포함). */
  countDefQualityAll?(defId: string, quality: number): number;
  /** 품질이 정확히 `quality` 인 `defId` 를 가방 먼저 → 창고에서 `qty` 개 뺀다. 전부 또는 전무; 모자라면 false. */
  consumeDefQualityAll?(defId: string, quality: number, qty: number): boolean;
  /** 가진 요리(`ItemDef.meal`)를 (def, 품질)별로 합친 목록 (가방 + 창고) — 식탁 화면. 티어 → def → 품질 높은 순. */
  getMealStacks?(): { defId: string; quality: number; qty: number }[];
  /**
   * 조리대 레시피 `recipeId` 를 **지금** 1회 만들 수 없는 한국어 사유 (null = 가능) — 함선 제작과 같은 게이트: 조리대 레시피인가 ·
   * `benchLevel` 이 레시피의 작업대 레벨 이상인가 · 숙련 · 재료(`craftCost`) · 산출물 1개가 들어갈 자리(창고 → 가방).
   */
  cookBlock?(recipeId: string, benchLevel: number): string | null;
  /**
   * 조리 1회를 마무리한다 — `cookBlock` 을 다시 보고 재료를 빼고 품질 `quality` 인 산출물을 **창고 먼저 → 가방**에 넣는다.
   * `inventory:itemAdded` · `craft:completed {recipeId, item, count:1}` (숙련 XP · 튜토리얼 · 토스트가 그대로 산다). 실패면 아무것도 빼지 않는다.
   */
  completeCook?(recipeId: string, benchLevel: number, quality: number): { item: ItemInstance | null; landed: 'bag' | 'stash' | null; reason: string | null };
}
/* ══ end 2026-09-13 요리 미니게임 ══ */
