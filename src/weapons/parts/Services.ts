/**
 * src/weapons/parts/Services.ts — the `WeaponHost` **service object**.
 *
 * `fx/` · `unique/` · `Melee` · `Grenade` never know `WeaponSystem` directly; they reach the world only through
 * this object (raycasts · applying damage · audio · camera shake · consuming from the inventory …).
 * So this file is the **one point of contact** between the weapon-internal modules and the rest of the game.
 */
import {
  WEAPON_DURABILITY_PER_SHOT,
} from '@/shared';
import { FxManager } from '@/core/fx';
import { randomInCone } from '@/core/util/MathUtil';
import { damageFalloff } from '../WeaponDefaults';
import { raycastBlockers } from '../Blocking';
import { type UniqueServices, type UniqueShot } from '../unique';
import { FIRING_POSE_HOLD, type WeaponInstance, _block, _blockInfo, _d, _md, _mq, _muzzle, _netDir, _o, _pd, _rep, _right, _tA, _tB, _target, _tmp, toTuple } from '../model';
import type { WeaponSystem } from '../WeaponSystem';
import { autoFeed } from './Slots';

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
      const w = sys.slots[sys.active];
      if (!host) { out.set(0, 0, 0); return; }
      host.getAimRay(_o, _d);
      // 2026-09-12: the crosshair point of the hybrid resolver (`parts/AimLine`) — from the muzzle's depth on
      if (w) { w.model.muzzle.updateWorldMatrix(true, false); _muzzle.setFromMatrixPosition(w.model.muzzle.matrixWorld); } else _muzzle.copy(host.position);
      sys.aim.begin(host, _muzzle, _o, _d);
      out.copy(sys.aim.resolve(_d, range, sys.uniqueShot).target);
    },
    aimShot(w, range, origin, dir) {
      w.model.muzzle.updateWorldMatrix(true, false);
      _muzzle.setFromMatrixPosition(w.model.muzzle.matrixWorld);
      const host = sys.getHost();
      if (!host) { origin.copy(_muzzle); dir.set(0, 0, -1); return; }
      host.getAimRay(_o, _d);
      sys.aim.begin(host, _muzzle, _o, _d);
      const shot = sys.aim.resolve(_d, range, sys.uniqueShot);
      origin.copy(shot.origin); dir.copy(shot.dir);
    },
    hitscan(w, spread, damage, range, tracerWidth, out: UniqueShot) {
      const wi = w as WeaponInstance;
      out.hit = false; out.enemy = false; out.killed = false;
      const host = sys.getHost();
      if (!host) return;
      host.getAimRay(_o, _d);
      wi.model.muzzle.updateWorldMatrix(true, false);
      _muzzle.setFromMatrixPosition(wi.model.muzzle.matrixWorld);
      randomInCone(_d, spread, _pd, _tA, _tB);
      // 2026-09-12: hybrid judgement, same as `fire()` (`parts/AimLine`)
      sys.aim.begin(host, _muzzle, _o, _d);
      const shot = sys.aim.resolve(_pd, range, sys.uniqueShot);
      const hit = shot.hit;
      out.end.copy(shot.end);
      ctx.enemies?.reportShot(_o, _d, range, hit ? hit.point : null);   // Phase 12 shot tracking
      const fxm = FxManager.get();
      if (fxm) fxm.tracers.add(_muzzle, out.end, wi.def.tracerColor, tracerWidth, _muzzle.distanceTo(out.end) / 600 + 0.06, 600);
      if (!hit) return;
      const dmg = damage * damageFalloff(wi.def, shot.origin.distanceTo(hit.point));
      const killed = sys.applyHit(hit, dmg, shot.dir, false, wi.stats.ammoType);
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
    feed: (w) => autoFeed(sys, w as WeaponInstance),
  };
  }
