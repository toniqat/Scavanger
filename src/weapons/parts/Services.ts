/**
 * src/weapons/parts/Services.ts — `WeaponHost` **서비스 객체**.
 *
 * `fx/` · `unique/` · `Melee` · `Grenade` 는 `WeaponSystem` 을 직접 알지 않고 이 객체를 통해서만
 * 월드에 접근한다(레이캐스트 · 피해 적용 · 오디오 · 카메라 흔들림 · 인벤토리 소모 …).
 * 즉 이 파일이 무기 내부 모듈과 나머지 게임 사이의 **유일한 접점**이다.
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

/**
 * The narrow API a `UniqueHandler` gets. Ammo / durability stay on the shared item instance and go through
 * `persist()` exactly like regular shots; the hitscan helper mirrors `fire()`'s single-pellet path.
 */
export function buildServices(sys: WeaponSystem): UniqueServices {
  // (the class body kept a `const sys = this` alias — the parameter is that alias now)
  const ctx = sys.ctx;
  return {
    ctx,
    fx: sys.fx,
    ufx: sys.ufx,
    projectiles: sys.projectiles,
    host: () => sys.getHost(),
    mag: (w) => sys.magOf(w as WeaponInstance),
    reserve: (w) => sys.reserveOf(w as WeaponInstance),
    drain(w, dt) {
      const wi = w as WeaponInstance;
      const mag = sys.magOf(wi);
      if (mag <= 0) return false;
      wi.ammoFrac += (wi.def.ammoPerSec ?? 0) * dt;
      wi.durFrac += dt;
      const units = Math.floor(wi.ammoFrac);
      const wear = Math.floor(wi.durFrac);
      if (units > 0 || wear > 0) {
        if (units > 0) { wi.ammoFrac -= units; wi.inst.ammoInMag = Math.max(0, mag - units); }
        if (wear > 0) { wi.durFrac -= wear; wi.inst.durability = Math.max(0, sys.durabilityOf(wi) - wear * WEAPON_DURABILITY_PER_SHOT); }
        sys.persist(wi, { ammoInMag: sys.magOf(wi), durability: sys.durabilityOf(wi) });
        if (units > 0) sys.emitAmmo(wi);
        if (wear > 0) sys.emitDurability(wi);
      }
      return true;
    },
    spend(w, rounds) {
      const wi = w as WeaponInstance;
      const mag = sys.magOf(wi);
      if (mag < rounds || rounds <= 0) return false;
      wi.inst.ammoInMag = mag - rounds;
      wi.inst.durability = Math.max(0, sys.durabilityOf(wi) - WEAPON_DURABILITY_PER_SHOT);
      sys.persist(wi, { ammoInMag: wi.inst.ammoInMag, durability: wi.inst.durability });
      sys.emitAmmo(wi);
      sys.emitDurability(wi);
      return true;
    },
    brokenCheck(w) {
      const wi = w as WeaponInstance;
      if (sys.durabilityOf(wi) > 0) return false;
      if (!sys.dryFlagged) { sys.dryFlagged = true; sys.onBrokenTrigger(wi); }
      return true;
    },
    dryFire(w) {
      const wi = w as WeaponInstance;
      if (sys.dryFlagged) return;
      sys.dryFlagged = true;
      ctx.bus.emit('weapon:dryFire', { weaponId: wi.stats.weaponId });
      ctx.bus.emit('audio:play', { id: 'dry_fire', volume: 0.6 });
      sys.tryReload(wi);
    },
    tryReload: (w) => sys.tryReload(w as WeaponInstance),
    muzzle(w, out) {
      w.model.muzzle.updateWorldMatrix(true, false);
      return out.setFromMatrixPosition(w.model.muzzle.matrixWorld);
    },
    aimRay(origin, dir) {
      const host = sys.getHost();
      if (host) host.getAimRay(origin, dir); else { origin.set(0, 0, 0); dir.set(0, 0, -1); }
    },
    aimTarget(range, out) {
      const host = sys.getHost();
      if (!host) { out.set(0, 0, 0); return; }
      host.getAimRay(_o, _d);
      _tmp.copy(host.position); _tmp.y += 1.5;
      const camToPlayer = _tmp.distanceTo(_o) + 0.4;
      sys.raycastAll(_o, _d, range, sys.uniqueHit);
      if (sys.uniqueHit.valid && sys.uniqueHit.distance < camToPlayer) sys.uniqueHit.valid = false;
      if (sys.uniqueHit.valid) out.copy(sys.uniqueHit.point); else out.copy(_o).addScaledVector(_d, range);
    },
    hitscan(w, spread, damage, range, tracerWidth, out: UniqueShot) {
      const wi = w as WeaponInstance;
      out.hit = false; out.enemy = false; out.killed = false;
      const host = sys.getHost();
      if (!host) return;
      host.getAimRay(_o, _d);
      wi.model.muzzle.updateWorldMatrix(true, false);
      _muzzle.setFromMatrixPosition(wi.model.muzzle.matrixWorld);
      _tmp.copy(host.position); _tmp.y += 1.5;
      const camToPlayer = _tmp.distanceTo(_o) + 0.4;
      randomInCone(_d, spread, _pd, _tA, _tB);
      sys.raycastAll(_o, _pd, range, sys.camHit);
      if (sys.camHit.valid && sys.camHit.distance < camToPlayer) sys.camHit.valid = false;
      if (sys.camHit.valid) _target.copy(sys.camHit.point); else _target.copy(_o).addScaledVector(_pd, range);
      _md.subVectors(_target, _muzzle);
      const mdist = _md.length();
      if (mdist < 1e-3) { out.end.copy(_target); return; }
      _md.divideScalar(mdist);
      sys.raycastAll(_muzzle, _md, mdist + 0.05, sys.gunHit);
      const hit = sys.gunHit.valid ? sys.gunHit : (sys.camHit.valid ? sys.camHit : null);
      out.end.copy(hit ? hit.point : _target);
      ctx.enemies?.reportShot(_o, _d, range, hit ? hit.point : null);   // Phase 12 총알 추적
      const fxm = FxManager.get();
      if (fxm) fxm.tracers.add(_muzzle, out.end, wi.def.tracerColor, tracerWidth, _muzzle.distanceTo(out.end) / 600 + 0.06, 600);
      if (!hit) return;
      const dmg = damage * damageFalloff(wi.def, _muzzle.distanceTo(hit.point));
      const killed = sys.applyHit(hit, dmg, _md, false, wi.stats.ammoType);
      out.hit = true; out.enemy = !!hit.enemy; out.killed = killed;
      if (hit.enemy) ctx.bus.emit('ui:hitmarker', { kill: killed, headshot: hit.headshot });
    },
    fireStandard(w) {
      const host = sys.getHost();
      if (host) sys.fire(host, w as WeaponInstance);
    },
    announceFire(w, origin, dir, m, c) {
      ctx.bus.emit('weapon:fired', { weaponId: w.stats.weaponId, origin: origin.clone(), direction: dir.clone() });
      if (ctx.isMultiplayer && ctx.net) ctx.net.send({ t: 'fire', w: w.stats.weaponId, o: toTuple(origin), d: toTuple(dir), m, c: Math.round(c * 100) / 100 });
    },
    announceBeamEnd(w, m) {
      if (!ctx.isMultiplayer || !ctx.net) return;
      const host = sys.getHost();
      w.model.muzzle.updateWorldMatrix(true, false);
      _muzzle.setFromMatrixPosition(w.model.muzzle.matrixWorld);
      if (host) host.getAimRay(_o, _d); else _d.set(0, 0, -1);
      ctx.net.send({ t: 'fire', w: w.stats.weaponId, o: toTuple(_muzzle), d: toTuple(_d), m, c: -1 });
    },
    recoil(pitch, yaw) { sys.getHost()?.addRecoil(pitch, yaw); },
    setCooldown(seconds) { sys.cooldown = Math.max(sys.cooldown, seconds); sys.firingTimer = FIRING_POSE_HOLD; },
    cooldown: () => sys.cooldown,
    deny: () => sys.deny(),
    notify(text) { ctx.bus.emit('ui:notify', { text, kind: 'warning', duration: 1.4 }); },
    lightMelee() {
      const host = sys.getHost();
      if (!host) return false;
      const ok = sys.melee.tryStart(host, sys.slots[sys.active]?.def ?? null);
      if (ok) { if (sys.phase === 'reloading') sys.cancelReload(); sys.firingTimer = FIRING_POSE_HOLD * 0.5; }
      return ok;
    },
    lineOfSight(from, to) {
      _tmp.subVectors(to, from);
      const dist = _tmp.length();
      if (dist < 1e-3) return true;
      _tmp.divideScalar(dist);
      const world = ctx.world;
      if (world && world.ready) {
        const wh = world.raycast(from, _tmp, dist);
        if (wh && wh.distance < dist - 0.35) return false;
      }
      const bd = raycastBlockers(ctx, from, _tmp, dist, _block, false);
      return !(bd >= 0 && bd < dist - 0.35);
    },
    emitAmmo: (w) => sys.emitAmmo(w as WeaponInstance),
  };
  }
