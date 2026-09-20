/**
 * src/weapons/model.ts — the weapon folder's shared vocabulary.
 *
 * Only the constants · types · scratch objects split out of `WeaponSystem`. Nothing here references the class,
 * so a `parts/*` module can use these values without importing the class back (no circular import).
 * `WeaponSystem.ts` re-exports the file as it is, so every existing import path still works.
 */
import * as THREE from 'three';
import {
  GameContext, Keys, MouseButtons, WEAPON_DURABILITY_PER_SHOT, WEAPON_SWAP_TIME_PRIMARY, WEAPON_SWAP_TIME_SECONDARY,
  IMPLANT_OVERCHARGE_FIRERATE_MUL,
  QUICK_SLOTS, QUICK_SLOT_UNLOCK_ORDER, QUICK_USABLE_CATEGORIES, isQuickSlotActive, QUICK_WHEEL_HOLD, QUICK_WHEEL_DRAG_PX, GRENADE_FUSE, GRENADE_COOK_MAX, GRENADE_UNDERHAND_SPEED_MUL,
  HEAL_HOLD_S, CONSUMABLE_SLOW_KEY, CONSUMABLE_SLOW_MUL, DEFIB_USE_TIME_S,
  type GameSystem, type WeaponDef, type ItemInstance, type ItemDef, type PlayerRef, type PlayerWeaponHost, type EnemyRef, type Vec3Tuple,
  type WeaponSlot, type EffectiveWeaponStats, type WeaponClass, type GadgetId, type WeaponRemoteState,
} from '@/shared';
import type { Obstacle as WorldObstacle, InterceptableRef, PeerId } from '@/shared';
import { ARMOR_IMMUNE_AMMO } from '@/shared';
import { FxManager } from '@/core/fx';
import { randomInCone } from '@/core/util/MathUtil';
import { boostItemOf, shieldChargeOf } from '@/items';
import { WEAPON_SLOTS, defaultFor, kindOf, shotSoundId, shotPitchFor, weaponClassOf, damageFalloff, statsFromDef, STANCE_ACCURACY } from './WeaponDefaults';
import { WeaponModel, type WeaponAttachmentVisuals } from './WeaponModel';
import { attachmentVisualsFor, attachmentIdsOf, sameIds } from './Attachments';
import { WeaponFx } from './fx/WeaponFx';
import { GrenadeManager } from './Grenade';
import { ProjectilePool, projectileOptsFor, type ProjectileHit } from './Projectile';
import { RemoteWeapons } from './RemoteWeapons';
import { MeleeController } from './Melee';
import { raycastBlockers, damageBarrierAt, makeBlockInfo } from './Blocking';
import { createUniqueHandler, UniqueFx, type UniqueHandler, type UniqueInput, type UniqueServices, type UniqueShot, type UniqueWeapon } from './unique';

export type Host = PlayerRef & PlayerWeaponHost;

/**
 * A weapon held in one of the three slots. `inst` is the inventory's own `ItemInstance` (shared reference) —
 * `ammoInMag` / `durability` live on it so they travel with the item (drop, pickup, stash); `stats` are the
 * graded + socketed numbers the weapon fires with (`ctx.loot.getEffectiveStats`).
 */
export interface WeaponInstance {
  uid: string;
  slot: WeaponSlot;
  def: WeaponDef;
  inst: ItemInstance;
  stats: EffectiveWeaponStats;
  model: WeaponModel;
  /** Phase 6: behaviour handler for `def.unique` weapons (null for regular guns). */
  unique: UniqueHandler | null;
  /** Continuous weapons: fractional ammo / durability spent since the last whole unit was written. */
  ammoFrac: number;
  durFrac: number;
}

export interface HitInfo { point: THREE.Vector3; normal: THREE.Vector3; distance: number; enemy: EnemyRef | null; obstacle: boolean; valid: boolean; headshot: boolean; obstacleRef: WorldObstacle | null; armored: boolean; intercept: InterceptableRef | null;
  /** Phase 9: the hit stopped at an implant barrier of this owner (damage is applied once in `applyHit`, never by the raycast). */
  barrierOwner: PeerId | 'local' | null }

export const BLOOM_PER_SHOT = 0.14;
export const BLOOM_DECAY = 2.6;
export const FIRING_POSE_HOLD = 0.6;
export const LOADOUT_FALLBACK_DELAY = 1.0;
export const SPRINT_SPREAD_MUL = 1.5;
export const MOVING_SPREAD_MUL = 1.35;
/** Delay from the shot to the bolt-cycle sound (sniper). */
export const BOLT_SOUND_DELAY = 0.22;
/** Min seconds between "내구도 소진" toasts. */
export const BROKEN_NOTIFY_INTERVAL = 2.0;
/** Gun draw-down time when a consumable is taken into the hand (F). */
export const QUICK_HOLSTER_TIME = 0.15;
/** Seconds between two stim injections / grenade wind-ups. */
export const QUICK_USE_COOLDOWN = 0.4;
/** Shortest fuse a cooked grenade leaves the hand with. */
export const GRENADE_MIN_FUSE = 0.15;
/** Overhand throw speed / lift (pre-Phase 2 numbers). */
// 2026-09-09: throw ballistics live in data/constants.csv (shared) so progression can quote the range in metres.
export { GRENADE_THROW_SPEED, GRENADE_THROW_LIFT, GRENADE_UNDERHAND_LIFT } from '@/shared';

export type QuickKind = 'stim' | 'grenade' | 'gadget';

/** A consumable taken into the hand from a quick slot (`active = 'quick'`): the bag's own `ItemInstance` plus its def. */
export interface QuickHand {
  index: number;
  uid: string;
  defId: string;
  item: ItemInstance;
  def: ItemDef;
  kind: QuickKind;
  /**
   * 2026-09-11 — **the detonator hand** (a virtual state). What stays in the hand once every remote mine (C4)
   * has been placed and the slot is empty while my C4 are still out in the world. It is not bound to a quick
   * slot, so `index` is −1 and `item` is a synthetic instance with `qty: 0` (`DETONATOR_UID_PREFIX + defId`),
   * announced with `quick:equipped {index: null, item}`.
   */
  detonator?: boolean;
}

/**
 * 2026-09-11 — seconds the detonator hand is kept right after the last C4 was placed, even while
 * `liveRemoteMineCount()` reads 0. A non-host's placement is a `gadq` request, so my C4 is not counted until the
 * host confirms and replicates it — **not a balance number but a network confirm grace**. The grace ends the
 * instant one or more are counted, and the hand goes back to the gun when the count falls to 0 after that.
 */
export const DETONATOR_CONFIRM_GRACE_S = 2;
/** Prefix of the detonator hand's synthetic `ItemInstance.uid` — it collides with no uid in the inventory. */
export const DETONATOR_UID_PREFIX = 'detonator:';

/**
 * Seconds a healing consumable / shield charger / combat boost / **gadget** is held before it fires (0 = instant).
 *
 * 2026-09-15 (the gadget rework · user's bug 「바리케이드 사용 시간이 적용되지 않고 회수에만 시간이 걸린다」):
 * a gadget was **always 0** here — `ItemDef.gadgetUseTime` (the column of the same name in `items.csv`) is read
 * on the **same hold path** as a heal item (`healUseTime`) · a shield charger (`shieldUseTime`) · a combat boost
 * (`boostUseTime`). With a value set, `QuickUse.updateQuickHand` sends it to `beginHeal`, so the crosshair hold
 * ring (`heal:holdChanged`) turns by itself. With none, the defibrillator takes `DEFIB_USE_TIME_S`, every other
 * gadget 0 (instant).
 */
export function useTimeOf(def: ItemDef): number {
  if (def.heal) return def.heal.spray ? 0 : Math.max(0, def.heal.useTime);
  // 2026-09-10 shield charger: the same hold path as a healing consumable, but with its own use time (data/items.csv)
  const sc = shieldChargeOf(def.id);
  if (sc) return Math.max(0, sc.useTime);
  // 2026-09-12 the three combat boosts (`아드레날린` · `각성제` · `안정제`): the same hold path, their own use time
  //   (data/items.csv `boostUseTime`)
  const boost = boostItemOf(def.id);
  if (boost) return Math.max(0, boost.useTime);
  if (def.category === 'stim') return HEAL_HOLD_S;
  // 2026-09-15: a grenade cooks instead (hold = the fuse), so it never takes this path — `gadgetUseTime` is on
  //   gadget rows only.
  if (def.grenade !== undefined) return 0;
  if (typeof def.gadgetUseTime === 'number') return Math.max(0, def.gadgetUseTime);
  return def.gadgetId === 'defib' ? DEFIB_USE_TIME_S : 0;
}

/**
 * 2026-09-15 (the gadget rework, user's decision): **what the consumable in hand behaves like**.
 *
 * `ItemCategory`'s `'grenade'` was removed, so a grenade is `category: 'gadget'` too and `def.category` can no
 * longer be cast straight to `QuickKind` — `ItemDef.grenade` alone decides whether it is a grenade
 * (`shared/types.ts`). This one function is the only place that splits 「grenade cooking · throwing」 from
 * 「gadget use」.
 */
export function quickKindOf(def: ItemDef): QuickKind {
  if (def.grenade !== undefined) return 'grenade';
  return def.category === 'stim' ? 'stim' : 'gadget';
}

/** Remaining gauge of a heal-spray instance (a fresh can that never got a `durability` reads full). */
export function gaugeOf(inst: ItemInstance, def: ItemDef): number {
  const max = def.durabilityMax ?? 0;
  return Math.max(0, Math.min(max, inst.durability ?? max));
}

/** Seconds between the batched `buff heal` messages a spray sends to squadmates in range. */
export const SPRAY_SEND_INTERVAL = 0.5;
/** Phase 12: `item:channelChanged` rate while a spray channel runs. */
export const CHANNEL_EMIT_HZ = 10;

export const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _pd = new THREE.Vector3(), _tA = new THREE.Vector3(), _tB = new THREE.Vector3();
export const _muzzle = new THREE.Vector3(), _target = new THREE.Vector3(), _md = new THREE.Vector3(), _right = new THREE.Vector3(), _tmp = new THREE.Vector3();
/** Phase 12: impact point handed to `ctx.enemies.reportShot` (scratch). */
export const _rep = new THREE.Vector3();
export const _netDir = new THREE.Vector3();
export const _mq = new THREE.Quaternion();
/**
 * 2026-09-12 (hybrid shot resolution): a near-muzzle hit closer than this to the crosshair point is the
 * crosshair's own target (aiming at a wall 2 m ahead), not an obstruction — no red marker, no crosshair warning.
 * A tolerance, not a balance value.
 */
export const AIM_BLOCK_SAME_EPS = 0.25;
export const _block = new THREE.Vector3();
export const _blockInfo = makeBlockInfo();

export function makeHit(): HitInfo { return { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, enemy: null, obstacle: false, valid: false, headshot: false, obstacleRef: null, armored: false, intercept: null, barrierOwner: null }; }

/** Vector3 → wire tuple rounded to 3 dp (fresh tuples: messages are serialized asynchronously by the relay). */
export function toTuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
}
