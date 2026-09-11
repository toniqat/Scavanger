/**
 * src/weapons/model.ts — 무기 폴더의 공용 어휘.
 *
 * `WeaponSystem` 에서 떼어낸 상수 · 타입 · 스크래치 객체만 있다. 클래스를 참조하지 않으므로
 * `parts/*` 모듈이 클래스를 되돌아 import 하지 않고 이 값들을 쓸 수 있다(순환 import 방지).
 * `WeaponSystem.ts` 가 그대로 재수출하므로 기존 import 경로는 전부 유지된다.
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
import { shieldChargeOf } from '@/items';
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
   * 2026-09-11 — **기폭기 손** (가상 상태). 원격 지뢰(C4)를 다 설치해 슬롯이 비었는데 월드에 내 C4 가 남아 있을 때
   * 손에 남는 것. 퀵슬롯에 묶이지 않으므로 `index` 는 −1, `item` 은 `qty: 0` 인 합성 인스턴스
   * (`DETONATOR_UID_PREFIX + defId`)이고 `quick:equipped {index: null, item}` 으로 알린다.
   */
  detonator?: boolean;
}

/**
 * 2026-09-11 — 마지막 C4 를 설치한 직후 `liveRemoteMineCount()` 가 0 이어도 기폭기 손을 유지하는 시간(초).
 * 비호스트의 설치는 `gadq` 요청이라 호스트가 확정해 복제될 때까지 내 C4 가 세어지지 않는다 — **밸런스 수치가 아니라
 * 네트워크 확정 여유**다. 한 번이라도 1 개 이상 세어지면 여유는 즉시 끝나고, 그 뒤 0 이 되면 총으로 돌아간다.
 */
export const DETONATOR_CONFIRM_GRACE_S = 2;
/** 기폭기 손의 합성 `ItemInstance.uid` 접두사 — 인벤토리의 어떤 uid 와도 겹치지 않는다. */
export const DETONATOR_UID_PREFIX = 'detonator:';

/** Seconds a 회복 소모품 / 실드 충전기 / 제세동기 must be held before it fires (0 = instant, e.g. every other gadget). */
export function useTimeOf(def: ItemDef): number {
  if (def.heal) return def.heal.spray ? 0 : Math.max(0, def.heal.useTime);
  // 2026-09-10 실드 충전기: 회복 소모품과 같은 홀드 틀을 쓰지만 자기 사용 시간을 갖는다 (data/items.csv)
  const sc = shieldChargeOf(def.id);
  if (sc) return Math.max(0, sc.useTime);
  if (def.category === 'stim') return HEAL_HOLD_S;
  return def.gadgetId === 'defib' ? DEFIB_USE_TIME_S : 0;
}

/** Remaining gauge of a 회복 스프레이 instance (a fresh can that never got a `durability` reads full). */
export function gaugeOf(inst: ItemInstance, def: ItemDef): number {
  const max = def.durabilityMax ?? 0;
  return Math.max(0, Math.min(max, inst.durability ?? max));
}

/** Seconds between the batched `buff heal` messages a 스프레이 sends to squadmates in range. */
export const SPRAY_SEND_INTERVAL = 0.5;
/** Phase 12: `item:channelChanged` rate while a 스프레이 channel runs. */
export const CHANNEL_EMIT_HZ = 10;

export const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _pd = new THREE.Vector3(), _tA = new THREE.Vector3(), _tB = new THREE.Vector3();
export const _muzzle = new THREE.Vector3(), _target = new THREE.Vector3(), _md = new THREE.Vector3(), _right = new THREE.Vector3(), _tmp = new THREE.Vector3();
/** Phase 12: impact point handed to `ctx.enemies.reportShot` (scratch). */
export const _rep = new THREE.Vector3();
export const _netDir = new THREE.Vector3();
/**
 * 2026-09-08 (스코프 탄도) — where a scoped shot actually leaves from: the model muzzle projected onto the aim ray,
 * so the bullet rides the crosshair line instead of converging onto it from the left. See `parts/Firing.fire`.
 */
export const _shotO = new THREE.Vector3();
export const _mq = new THREE.Quaternion();
export const _block = new THREE.Vector3();
export const _blockInfo = makeBlockInfo();

export function makeHit(): HitInfo { return { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, enemy: null, obstacle: false, valid: false, headshot: false, obstacleRef: null, armored: false, intercept: null, barrierOwner: null }; }

/** Vector3 → wire tuple rounded to 3 dp (fresh tuples: messages are serialized asynchronously by the relay). */
export function toTuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
}

/**
 * Three weapon slots (주무기 I / 주무기 II / 보조무기): hitscan & projectile firing from the reticle ray with
 * graded + socketed effective stats, spread/bloom, recoil, durability, ammo v2 (reserve = calibre rounds in the
 * bag, magazine on the item), reloads, swap animation, grenades and all weapon FX/events.
 */
