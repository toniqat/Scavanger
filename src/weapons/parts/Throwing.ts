/**
 * src/weapons/parts/Throwing.ts — **throwing what is in the hand** (grenades · throwable gadgets).
 *
 * LMB holds it, R pulls the pin and cooks it (`grenade:holdChanged` + the fuse goes out on the wire),
 * releasing throws it overhand / RMB underhand. The in-hand explosion (`explodeInHand`) is here too.
 */
import * as THREE from 'three';
import {
  Keys, MouseButtons, GRENADE_FUSE, GRENADE_COOK_MAX, GRENADE_UNDERHAND_SPEED_MUL,
} from '@/shared';
import { FIRING_POSE_HOLD, GRENADE_MIN_FUSE, GRENADE_THROW_LIFT, GRENADE_THROW_SPEED, GRENADE_UNDERHAND_LIFT, type Host, QUICK_USE_COOLDOWN, type QuickHand, _block, _blockInfo, _d, _md, _mq, _muzzle, _netDir, _o, _pd, _rep, _right, _tA, _tB, _target, _tmp, toTuple } from '../model';
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
    // `근력` strength (Phase 5): range ∝ speed², so the speed scales by √throwRangeMul
    const throwMul = Math.sqrt(Math.max(0.25, sys.ctx.progression?.derived.throwRangeMul ?? 1));
    if (sys.underhand) {
      _md.copy(_d).multiplyScalar(GRENADE_THROW_SPEED * GRENADE_UNDERHAND_SPEED_MUL * throwMul).addScaledVector(host.velocity, 0.5);
      _md.y = Math.max(_md.y * 0.5, 0) + GRENADE_UNDERHAND_LIFT;
    } else {
      _md.copy(_d).multiplyScalar(GRENADE_THROW_SPEED * throwMul).addScaledVector(host.velocity, 0.5);
      _md.y += GRENADE_THROW_LIFT;
    }
  }
  // 2026-09-15 (B-16): `ItemDef.grenadeFire` (the G-10 incendiary grenade) = a small blast + a fire zone — the
  //   same flight · fuse as the high-explosive one
  sys.grenades.throw(_tmp, _md, false, fuse, !!q.def.grenadeFire);
  if (sys.ctx.isMultiplayer && sys.ctx.net) sys.ctx.net.send({ t: 'grenade', p: toTuple(_tmp), v: toTuple(_md), fuse: Math.round(fuse * 100) / 100, ...(q.def.grenadeFire ? { fire: 1 as const } : {}) });
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
  sys.grenades.throw(_tmp, _md, false, 0, !!q.def.grenadeFire);
  if (sys.ctx.isMultiplayer && sys.ctx.net) sys.ctx.net.send({ t: 'grenade', p: toTuple(_tmp), v: [0, 0, 0], fuse: 0, ...(q.def.grenadeFire ? { fire: 1 as const } : {}) });
  sys.quickCooldown = QUICK_USE_COOLDOWN / sys.useSpeedMul();
  if (remaining >= 0) sys.ctx.bus.emit('quick:used', { index: q.index, item: q.item, remaining });
  sys.endHold(true);
  if (remaining <= 0) sys.returnToGun();
  }

/** Hold interrupted (swap / holster / death / abort / other item): no throw — unless the pin is pulled, then it drops at the feet. */
export function cancelHold(sys: WeaponSystem, host: Host): void {
  sys.cancelHeal();   // Phase 10: the same interruptions throw away a heal hold
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
  const count = inv ? inv.countWhere((d) => d.grenade !== undefined) : sys.fallbackGrenades;
  sys.ctx.bus.emit('grenade:countChanged', { count });
  }
