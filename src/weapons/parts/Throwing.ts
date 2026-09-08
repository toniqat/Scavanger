/**
 * src/weapons/parts/Throwing.ts — **손에 든 것을 던지기** (수류탄 · 투척 가젯).
 *
 * 좌클릭 홀드로 들고, R 로 핀을 뽑아 쿠킹하고(`grenade:holdChanged` + 퓨즈가 와이어로 나간다),
 * 놓으면 오버핸드 / 우클릭이면 언더핸드로 나간다. 손 안에서 터지는 경우(`explodeInHand`)도 여기.
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
import { WEAPON_SLOTS, defaultFor, kindOf, shotSoundId, shotPitchFor, weaponClassOf, damageFalloff, statsFromDef, STANCE_ACCURACY } from '../WeaponDefaults';
import { WeaponModel, type WeaponAttachmentVisuals } from '../WeaponModel';
import { attachmentVisualsFor, attachmentIdsOf, sameIds } from '../Attachments';
import { WeaponFx } from '../fx/WeaponFx';
import { GrenadeManager } from '../Grenade';
import { ProjectilePool, projectileOptsFor, type ProjectileHit } from '../Projectile';
import { RemoteWeapons } from '../RemoteWeapons';
import { MeleeController } from '../Melee';
import { raycastBlockers, damageBarrierAt, makeBlockInfo } from '../Blocking';
import { createUniqueHandler, UniqueFx, type UniqueHandler, type UniqueInput, type UniqueServices, type UniqueShot, type UniqueWeapon } from '../unique';
import { BLOOM_DECAY, BLOOM_PER_SHOT, BOLT_SOUND_DELAY, BROKEN_NOTIFY_INTERVAL, CHANNEL_EMIT_HZ, FIRING_POSE_HOLD, GRENADE_MIN_FUSE, GRENADE_THROW_LIFT, GRENADE_THROW_SPEED, GRENADE_UNDERHAND_LIFT, type HitInfo, type Host, LOADOUT_FALLBACK_DELAY, MOVING_SPREAD_MUL, QUICK_HOLSTER_TIME, QUICK_USE_COOLDOWN, type QuickHand, type QuickKind, SPRAY_SEND_INTERVAL, SPRINT_SPREAD_MUL, type WeaponInstance, _block, _blockInfo, _d, _md, _mq, _muzzle, _netDir, _o, _pd, _rep, _right, _tA, _tB, _target, _tmp, gaugeOf, makeHit, toTuple, useTimeOf } from '../model';
import type { WeaponSystem } from '../WeaponSystem';

/* ── grenade hold ── */
export function fuseLeft(sys: WeaponSystem): number {
  return sys.cooking ? Math.max(GRENADE_MIN_FUSE, GRENADE_FUSE - sys.cooked) : GRENADE_FUSE;
  }

export function emitHold(sys: WeaponSystem): void {
  sys.ctx.bus.emit('grenade:holdChanged', { holding: sys.holding, cooking: sys.cooking, cooked: sys.cooked, fuse: sys.fuseLeft(), underhand: sys.underhand });
  }

export function beginHold(sys: WeaponSystem): void {
  sys.holding = true; sys.cooking = false; sys.cooked = 0;
  sys.emitHold();
  }

export function updateHold(sys: WeaponSystem, dt: number, host: Host, q: QuickHand): void {
  const input = sys.ctx.input;
  if (!input.isMouseDown(MouseButtons.FIRE)) { sys.throwHeld(host, q, false); return; }
  let changed = false;
  if (!sys.cooking && input.wasPressed(Keys.RELOAD)) {
    sys.cooking = true; sys.cooked = 0; changed = true;
    sys.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.7 });
  }
  if (input.wasMousePressed(MouseButtons.AIM)) { sys.underhand = !sys.underhand; changed = true; }
  if (sys.cooking) {
    sys.cooked += dt;
    if (sys.cooked >= GRENADE_COOK_MAX) { sys.explodeInHand(host, q); return; }
    changed = true;
  }
  if (changed) sys.emitHold();
  }

/** LMB released: lob the grenade with the remaining fuse; the stack shrinks by one. */
export function throwHeld(sys: WeaponSystem, host: Host, q: QuickHand, dropAtFeet: boolean): void {
  const fuse = sys.fuseLeft();
  const remaining = sys.consumeQuick(q);
  if (remaining < 0) { sys.endHold(true); if (!dropAtFeet) sys.returnToGun(); return; }
  sys.handPosition(host, _tmp);
  if (dropAtFeet) {
    _md.set(0, 0.5, 0);
  } else {
    host.getAimRay(_o, _d);
    // 근력 (Phase 5): range ∝ speed², so the speed scales by √throwRangeMul
    const throwMul = Math.sqrt(Math.max(0.25, sys.ctx.progression?.derived.throwRangeMul ?? 1));
    if (sys.underhand) {
      _md.copy(_d).multiplyScalar(GRENADE_THROW_SPEED * GRENADE_UNDERHAND_SPEED_MUL * throwMul).addScaledVector(host.velocity, 0.5);
      _md.y = Math.max(_md.y * 0.5, 0) + GRENADE_UNDERHAND_LIFT;
    } else {
      _md.copy(_d).multiplyScalar(GRENADE_THROW_SPEED * throwMul).addScaledVector(host.velocity, 0.5);
      _md.y += GRENADE_THROW_LIFT;
    }
  }
  sys.grenades.throw(_tmp, _md, false, fuse);
  if (sys.ctx.isMultiplayer && sys.ctx.net) sys.ctx.net.send({ t: 'grenade', p: toTuple(_tmp), v: toTuple(_md), fuse: Math.round(fuse * 100) / 100 });
  sys.firingTimer = FIRING_POSE_HOLD;
  sys.quickCooldown = QUICK_USE_COOLDOWN / sys.useSpeedMul();
  sys.ctx.bus.emit('quick:used', { index: q.index, item: q.item, remaining });
  sys.endHold(true);
  if (remaining <= 0 && !dropAtFeet) sys.returnToGun();
  }

/** Cooked past `GRENADE_COOK_MAX`: the grenade goes off in the hand (self damage included). */
export function explodeInHand(sys: WeaponSystem, host: Host, q: QuickHand): void {
  const remaining = sys.consumeQuick(q);
  sys.handPosition(host, _tmp);
  _md.set(0, 0, 0);
  sys.grenades.throw(_tmp, _md, false, 0);
  if (sys.ctx.isMultiplayer && sys.ctx.net) sys.ctx.net.send({ t: 'grenade', p: toTuple(_tmp), v: [0, 0, 0], fuse: 0 });
  sys.quickCooldown = QUICK_USE_COOLDOWN / sys.useSpeedMul();
  if (remaining >= 0) sys.ctx.bus.emit('quick:used', { index: q.index, item: q.item, remaining });
  sys.endHold(true);
  if (remaining <= 0) sys.returnToGun();
  }

/** Hold interrupted (swap / holster / death / abort / other item): no throw — unless the pin is pulled, then it drops at the feet. */
export function cancelHold(sys: WeaponSystem, host: Host): void {
  sys.cancelHeal();   // Phase 10: the same interruptions throw away a 회복약 hold
  if (!sys.holding) return;
  if (sys.cooking && sys.quick) sys.throwHeld(host, sys.quick, true);
  else sys.endHold(true);
  }

export function endHold(sys: WeaponSystem, emit: boolean): void {
  const was = sys.holding;
  sys.holding = false; sys.cooking = false; sys.cooked = 0;
  if (emit && was) sys.emitHold();
  }

/** Right hand in front of the shoulder (grenade release point). */
export function handPosition(sys: WeaponSystem, host: Host, out: THREE.Vector3): void {
  host.getAimRay(_o, _d);
  host.getEyePosition(out);
  _right.set(Math.cos(host.yaw), 0, -Math.sin(host.yaw));
  out.addScaledVector(_d, 0.6).addScaledVector(_right, 0.25);
  }

export function emitGrenadeCount(sys: WeaponSystem): void {
  const inv = sys.ctx.inventory;
  const count = inv ? inv.countWhere((d) => d.category === 'grenade') : sys.fallbackGrenades;
  sys.ctx.bus.emit('grenade:countChanged', { count });
  }
