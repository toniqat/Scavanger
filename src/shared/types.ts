import type * as THREE from 'three';
import type { Random } from './Random';
import type { GameContext } from './GameContext';

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

/** Ping categories (owner: ui/hud/Pings). `attack` / `caution` are the drag-gesture pings, `item` = dropped item / crate. */
export type PingKind = 'ground' | 'enemy' | 'crate' | 'extraction' | 'item' | 'attack' | 'caution';

/** Chat line categories (owner: ui/hud/ChatLog). */
export type ChatKind = 'text' | 'ping' | 'request' | 'system';

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
  | 'bag';        // backpack (equippable in the `bag` loadout slot), see `ItemDef.bag`

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

/**
 * Ammo calibres. v2 (weapon package): `light` 경량탄 (SMG, HG) · `medium` 준중량탄 (AR) · `heavy` 중량탄 (SR, DMR) ·
 * `shell` 산탄 (SG). The legacy values stay in the union for compatibility but no def uses them any more.
 * Ammo items carry rounds in `ItemInstance.qty` (stackMax = rounds per stack); a weapon's "reserve" is the
 * total rounds of its calibre in the bag.
 */
export type AmmoType = 'rifle' | 'pistol' | 'shotgun' | 'energy' | 'light' | 'medium' | 'heavy' | 'shell';

/** Weapon archetype. Drives damage falloff, recoil/spread profile, ADS zoom and HUD labels. */
export type WeaponClass = 'AR' | 'SMG' | 'SR' | 'DMR' | 'SG' | 'PISTOL';

/* ── appended (weapon package, 2026-09-05) ── */
/** Weapon grade: I 일반 · II 고급 · III 희귀 · IV 서사 · V 전설 (maps 1:1 to `Rarity`). Higher = more damage + durability. */
export type WeaponGrade = 1 | 2 | 3 | 4 | 5;
/** Weapon socket slots. Every weapon has all five (for now). */
export type SocketSlot = 'muzzle' | 'grip' | 'mag' | 'stock' | 'sight';
/** Equipment slots. `primary` = 주무기 I (key 1), `primary2` = 주무기 II (key 2), `secondary` = 보조무기 (key 3), `bag` = 가방. */
export type LoadoutSlot = 'primary' | 'primary2' | 'secondary' | 'bag';
export type WeaponSlot = Exclude<LoadoutSlot, 'bag'>;

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
  /** Base weapon this grade belongs to (`ar23` for `ar23_g3`); undefined → the def is its own family. */
  family?: string;
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
   * Entries reference bag items (stacks stay in the grid); a slot clears when its stack is consumed / dropped.
   * Only the first `getQuickSlotCount()` slots are usable (bag def `quickSlots`).
   */
  getQuickSlots(): readonly (ItemInstance | null)[];
  /** Assign bag item `uid` (category in QUICK_USABLE_CATEGORIES) to wheel slot `index`, or clear it with null. Emits `inventory:quickSlotsChanged`. */
  setQuickSlot(index: number, uid: string | null): boolean;
  /** Usable wheel slots for the equipped bag (BAG_DEFAULT_QUICK_SLOTS without a bag). */
  getQuickSlotCount(): number;
  /** Consume `qty` units of the exact item `uid` (bag). Returns how many were removed. Clears the quick slot at 0. */
  consumeItem(uid: string, qty?: number): number;
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
}

/* ────────────────────────────────────────────────────────────────────────────
 * World
 * ──────────────────────────────────────────────────────────────────────────── */
export interface Obstacle {
  position: THREE.Vector3;   // center (y = base height)
  radius: number;            // cylinder collider radius
  height: number;            // for projectiles / visuals
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
  /** Respawn like at mission start: hellpod drop-in at `position`, full hp, alive, not downed. Emits `player:spawned` / `player:landed`. */
  respawn(position: THREE.Vector3): void;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Enemies
 * ──────────────────────────────────────────────────────────────────────────── */
export type EnemyType = 'scavenger' | 'hunter' | 'warrior' | 'spewer' | 'charger';

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
}

export interface EnemyHit {
  enemy: EnemyRef;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  /** Which hitbox was struck (appended by enemies): head ×2 for most bugs, rear ×2.5 on chargers. */
  part?: 'head' | 'body' | 'rear' | 'front';
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
}
