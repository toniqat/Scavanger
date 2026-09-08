/**
 * src/weapons/parts/Firing.ts — **격발 · 명중 · 재장전**.
 *
 * 트리거를 당긴 순간부터 피해가 들어갈 때까지: 실효 스탯으로 탄을 뽑고, 내구도를 깎고,
 * 히트스캔/발사체를 쏘고(`raycastAll` — 배리어 · 돔 · 파괴 가능 엄폐물이 여기서 탄을 멈춘다),
 * 명중을 적 · 원격 플레이어에게 전달한다. 정밀 사격 정렬(예측 카메라 원점)이 걸린 곳이기도 하다.
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

/** Bolt-action cycle after each sniper shot: blocks firing, drives the model's bolt animation and the cycle sound. */
export function updateBolt(sys: WeaponSystem, dt: number, weapon: WeaponInstance | null): void {
  if (sys.boltTimer <= 0) return;
  sys.boltTimer -= dt;
  if (sys.boltSoundTimer > 0) {
    sys.boltSoundTimer -= dt;
    if (sys.boltSoundTimer <= 0) sys.ctx.bus.emit('audio:play', { id: 'bolt_cycle', volume: 0.7 });
  }
  if (!weapon) { sys.boltTimer = 0; return; }
  if (sys.boltTimer <= 0) { sys.boltTimer = 0; weapon.model.setBolt(-1); return; }
  weapon.model.setBolt(1 - sys.boltTimer / sys.boltDuration);
  }

/** Tell the player rig (and HUD) the ADS zoom + aim-in time of the weapon in hand. */
export function applyAimZoom(sys: WeaponSystem, stats: EffectiveWeaponStats | null): void {
  const host = sys.getHost();
  const zoom = stats?.adsZoom ?? 1;
  const scope = !!stats?.scope;
  const adsTime = stats?.adsTime ?? -1;
  if (adsTime !== sys.adsTimeSent && adsTime > 0) {
    sys.adsTimeSent = adsTime;
    if (host && typeof host.setAdsTime === 'function') host.setAdsTime(adsTime);
  }
  if (sys.zoomSent.zoom === zoom && sys.zoomSent.scope === scope) return;
  sys.zoomSent.zoom = zoom; sys.zoomSent.scope = scope;
  if (host && typeof host.setAimZoom === 'function') host.setAimZoom(zoom, scope);
  sys.ctx.bus.emit('weapon:scopeChanged', { zoom, scope });
  }

/* ─────────────────────────── reload ─────────────────────────── */
export function tryReload(sys: WeaponSystem, w: WeaponInstance): void {
  if (sys.phase !== 'ready') return;
  if (sys.magOf(w) >= w.stats.magSize) return;
  if (sys.reserveOf(w) <= 0) {
    sys.ctx.bus.emit('ui:notify', { text: '탄약 없음', kind: 'warning', duration: 1.2 });
    sys.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
    return;
  }
  sys.phase = 'reloading';
  sys.reloadTimer = 0;
  // 사격 스킬 (tactical kit): reload gets faster with the class skill (`derived.reloadSpeedMul`)
  sys.reloadDuration = Math.max(0.2, w.stats.reloadTime / sys.reloadSpeedFor(w.stats.weaponClass));
  sys.boltTimer = 0; sys.boltSoundTimer = 0;
  w.model.setBolt(-1);
  w.model.setReload(0);
  sys.ctx.bus.emit('weapon:reloadStarted', { weaponId: w.stats.weaponId, duration: sys.reloadDuration });
  sys.ctx.bus.emit('audio:play', { id: 'reload', volume: 0.8 });
  if (sys.ctx.isMultiplayer && sys.ctx.net) sys.ctx.net.send({ t: 'reload', w: w.stats.weaponId });
  }

export function updateReload(sys: WeaponSystem, dt: number): void {
  const w = sys.slots[sys.active];
  if (!w) { sys.phase = 'ready'; return; }
  sys.reloadTimer += dt;
  const t = Math.min(1, sys.reloadTimer / sys.reloadDuration);
  w.model.setReload(t);
  if (t >= 1) {
    const need = Math.max(0, w.stats.magSize - sys.magOf(w));
    let n = 0;
    const inv = sys.ctx.inventory;
    if (inv) {
      const type = w.stats.ammoType;
      n = need > 0 ? inv.consumeWhere((d) => d.category === 'ammo' && d.ammoType === type, need) : 0;
    } else {
      const r = sys.reserveOf(w);
      n = Math.min(need, r);
      sys.fallbackReserve.set(w.uid, r - n);
    }
    w.inst.ammoInMag = sys.magOf(w) + n;
    w.model.setReload(-1);
    sys.phase = 'ready';
    sys.persist(w, { ammoInMag: w.inst.ammoInMag });
    sys.ctx.bus.emit('weapon:reloadFinished', { weaponId: w.stats.weaponId });
    sys.ctx.bus.emit('audio:play', { id: 'reload_done', volume: 0.7 });
    sys.emitAmmo(w);
  }
  }

/**
 * Reload interrupted (swap, consumable in hand, melee, implant holster, loadout change). Phase 10: this used to be
 * silent — the bottom-right panel only closed its arc because `weapon:equipped` followed. The crosshair reload
 * gauge needs the explicit cancel, so `weapon:reloadCancelled` goes out whenever a reload was really in progress.
 */
export function cancelReload(sys: WeaponSystem): void {
  const w = sys.slots[sys.active];
  const was = sys.phase === 'reloading';
  w?.model.setReload(-1);
  sys.phase = 'ready';
  if (was) sys.ctx.bus.emit('weapon:reloadCancelled', { weaponId: w?.stats.weaponId ?? '' });
  }

/* ─────────────────────────── firing ─────────────────────────── */
/** Trigger pulled on a weapon with 0 durability: click, event, throttled toast. Nothing fires. */
export function onBrokenTrigger(sys: WeaponSystem, w: WeaponInstance): void {
  const ctx = sys.ctx;
  ctx.bus.emit('weapon:broken', { uid: w.uid, weaponId: w.stats.weaponId });
  ctx.bus.emit('audio:play', { id: 'dry_fire', volume: 0.6 });
  if (ctx.time - sys.brokenNotifyAt >= BROKEN_NOTIFY_INTERVAL) {
    sys.brokenNotifyAt = ctx.time;
    ctx.bus.emit('ui:notify', { text: '내구도 소진 — 함선에서 수리 필요', kind: 'warning', duration: 1.6 });
  }
  }

export function fire(sys: WeaponSystem, host: Host, w: WeaponInstance): void {
  const ctx = sys.ctx, def = w.def, st = w.stats;
  // ── ammo + durability (one write per trigger pull; shotgun pellets count once)
  w.inst.ammoInMag = sys.magOf(w) - 1;
  w.inst.durability = Math.max(0, sys.durabilityOf(w) - WEAPON_DURABILITY_PER_SHOT);
  sys.persist(w, { ammoInMag: w.inst.ammoInMag, durability: w.inst.durability });
  // fire rate reacts to an overcharge beam (tactical kit, ×1.3)
  const rate = sys.effectiveFireRate(st);
  sys.cooldown += 1 / rate;
  if (sys.cooldown < 0) sys.cooldown = 1 / rate;
  sys.firingTimer = FIRING_POSE_HOLD;

  const cls = st.weaponClass;
  const aim = host.isAiming ? 1 : 0;
  const moving = host.velocity.lengthSq() > 0.5;
  const stance = STANCE_ACCURACY[host.stance ?? 'stand'] ?? STANCE_ACCURACY.stand;
  const stanceMul = stance[aim];
  const moveMul = host.isSprinting ? SPRINT_SPREAD_MUL : moving ? MOVING_SPREAD_MUL : 1;
  const spread = THREE.MathUtils.lerp(st.spread, st.adsSpread, aim) * stanceMul * (1 + sys.bloom * 1.6) * moveMul;
  sys.bloom = Math.min(1, sys.bloom + BLOOM_PER_SHOT);
  // bolt-action: lock the trigger for the cycle and animate the bolt
  if (cls === 'SR') {
    sys.boltDuration = Math.max(0.3, 1 / rate - 0.05);
    sys.boltTimer = sys.boltDuration;
    sys.boltSoundTimer = BOLT_SOUND_DELAY;
    w.model.setBolt(0);
  }

  host.getAimRay(_o, _d);
  // muzzle world position (model matrices are one frame old → refresh the chain)
  w.model.muzzle.updateWorldMatrix(true, false);
  _muzzle.setFromMatrixPosition(w.model.muzzle.matrixWorld);
  // don't accept camera-ray hits between camera and player (over-the-shoulder)
  _tmp.copy(host.position); _tmp.y += 1.5;
  const camToPlayer = _tmp.distanceTo(_o) + 0.4;

  const pellets = def.pellets && def.pellets > 1 ? def.pellets : 1;
  let anyHit = false, anyKill = false, anyEnemy = false, anyHead = false;
  let reportHit: THREE.Vector3 | null = null;
  // direction replicated to other players: exact muzzle→target line for single shots, aim centre for pellets
  _netDir.copy(_d);
  for (let i = 0; i < pellets; i++) {
    randomInCone(_d, spread, _pd, _tA, _tB);
    sys.raycastAll(_o, _pd, def.range, sys.camHit);
    if (sys.camHit.valid && sys.camHit.distance < camToPlayer) sys.camHit.valid = false;
    if (sys.camHit.valid) _target.copy(sys.camHit.point); else _target.copy(_o).addScaledVector(_pd, def.range);
    _md.subVectors(_target, _muzzle);
    const mdist = _md.length();
    if (mdist < 1e-3) continue;
    _md.divideScalar(mdist);
    if (pellets === 1) _netDir.copy(_md);

    if (def.projectileSpeed) {
      sys.projectiles.fire(_muzzle, _md, def.projectileSpeed, st.damage, def.range, def.tracerColor, st.weaponId, false, projectileOptsFor(def));
      continue;
    }
    sys.raycastAll(_muzzle, _md, mdist + 0.05, sys.gunHit);
    const hit = sys.gunHit.valid ? sys.gunHit : (sys.camHit.valid ? sys.camHit : null);
    const end = hit ? hit.point : _target;
    const fx = FxManager.get();
    if (fx) {
      const len = _muzzle.distanceTo(end);
      fx.tracers.add(_muzzle, end, def.tracerColor, pellets > 1 ? 0.03 : 0.045, len / 420 + 0.045, 420);
    }
    if (hit) {
      const dmg = st.damage * damageFalloff(def, _muzzle.distanceTo(hit.point));
      const r = sys.applyHit(hit, dmg, _md, pellets > 1, st.ammoType);
      anyHit = true;
      reportHit = _rep.copy(hit.point);
      if (hit.enemy) { anyEnemy = true; if (hit.headshot) anyHead = true; }
      if (r) anyKill = true;
    }
  }

  // Phase 12 (총알 추적): every local hitscan shot is reported once per trigger pull along the aim ray — an enemy
  // near the bullet path / impact that could not see us turns toward the origin (enemies/). Projectile weapons are
  // reported by the pool at launch and by `onProjectileHit` at the impact instead.
  if (!def.projectileSpeed) ctx.enemies?.reportShot(_o, _d, def.range, reportHit);

  // ── FX & feedback
  sys.fx.muzzleFlash(_muzzle, _md, def.tracerColor, pellets > 1 ? 1.6 : 1);
  w.model.ejectPort.updateWorldMatrix(false, false);
  _tmp.setFromMatrixPosition(w.model.ejectPort.matrixWorld);
  w.model.ejectPort.getWorldQuaternion(_mq);
  _right.set(1, 0, 0).applyQuaternion(_mq);
  if (kindOf(def) !== 'energy' && (!def.unique || def.unique === 'minigun')) sys.fx.casing(_tmp, _right, host.position.y);
  w.model.kick(pellets > 1 ? 2.2 : cls === 'SR' ? 2.6 : 1);
  // 사격 스킬 (tactical kit): recoil shrinks as the class skill rises (`derived.recoilMul`)
  const recoilMul = sys.recoilMulFor(cls);
  const kick = st.recoilV * (0.85 + Math.random() * 0.3) * stanceMul * recoilMul;
  // horizontal: same ± random as before (items' recoilH = recoil × 0.7, the old constant)
  host.addRecoil(kick, (Math.random() - 0.5) * st.recoilH * stanceMul * recoilMul);
  if (cls === 'SR') ctx.bus.emit('camera:shake', { intensity: 0.35, duration: 0.18 });

  ctx.bus.emit('weapon:fired', { weaponId: st.weaponId, origin: _muzzle.clone(), direction: _d.clone() });
  // one message per trigger pull (shotgun pellets are fanned out visually by the receiver)
  if (ctx.isMultiplayer && ctx.net) ctx.net.send({ t: 'fire', w: st.weaponId, o: toTuple(_muzzle), d: toTuple(_netDir) });
  sys.emitAmmo(w);
  sys.emitDurability(w);
  ctx.bus.emit('audio:play', { id: shotSoundId(kindOf(def)), position: _muzzle, volume: 1, pitch: shotPitchFor(cls) * (0.95 + Math.random() * 0.1) });
  if (anyEnemy) ctx.bus.emit('ui:hitmarker', { kill: anyKill, headshot: anyHead });
  else if (anyHit && pellets === 1) { /* surface hit: no marker */ }
  }

/** Nearest of world & enemy raycasts into `out`. */
export function raycastAll(sys: WeaponSystem, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: HitInfo): void {
  const ctx = sys.ctx;
  out.valid = false; out.enemy = null; out.obstacle = false; out.headshot = false; out.obstacleRef = null; out.armored = false; out.intercept = null; out.barrierOwner = null;
  const eh = ctx.enemies ? ctx.enemies.raycast(origin, dir, maxDist) : null;
  const wh = ctx.world && ctx.world.ready ? ctx.world.raycast(origin, dir, maxDist) : null;
  if (eh && (!wh || eh.distance <= wh.distance)) {
    out.point.copy(eh.point); out.normal.copy(eh.normal); out.distance = eh.distance; out.enemy = eh.enemy; out.valid = true; out.headshot = eh.part === 'head'; out.armored = !!eh.armored;
  } else if (wh) {
    out.point.copy(wh.point); out.normal.copy(wh.normal); out.distance = wh.distance; out.obstacle = !!wh.obstacle; out.obstacleRef = wh.obstacle ?? null; out.valid = true;
  }
  // Phase 4: artillery shells can be shot down — nearest wins
  const ih = ctx.enemies && typeof ctx.enemies.raycastInterceptable === 'function' ? ctx.enemies.raycastInterceptable(origin, dir, out.valid ? out.distance : maxDist) : null;
  if (ih && (!out.valid || ih.distance < out.distance)) {
    out.point.copy(ih.point); out.normal.copy(dir).negate(); out.distance = ih.distance; out.enemy = null; out.obstacle = false; out.obstacleRef = null; out.headshot = false; out.armored = false;
    out.intercept = ih.target; out.valid = true;
  }
  // tactical kit: shields / solid deployables on the way (allied barriers ignore allied bullets — see Blocking.ts).
  // Phase 9: this is a pure query — the barrier is damaged once in `applyHit` when the resolved hit is the barrier.
  const bd = raycastBlockers(ctx, origin, dir, maxDist, _block, false, _blockInfo);
  if (bd >= 0 && (!out.valid || bd < out.distance)) {
    out.point.copy(_block); out.normal.copy(dir).negate(); out.distance = bd;
    out.enemy = null; out.headshot = false; out.armored = false; out.intercept = null; out.obstacleRef = null; out.obstacle = true; out.valid = true;
    out.barrierOwner = _blockInfo.kind === 'barrier' ? _blockInfo.owner : null;
  }
  }

/* ───────────────── tactical kit: progression / implant modifiers (all optional, default 1) ───────────────── */
/** 재주 (Phase 5): consumable / gadget use speed — divides the quick-use cooldown. */
export function useSpeedMul(sys: WeaponSystem): number {
  const v = sys.ctx.progression?.derived.useSpeedMul;
  return typeof v === 'number' && v > 0 ? Math.max(0.25, v) : 1;
  }

/** 사격 스킬 recoil multiplier for a class (1 when progression is not registered yet). */
export function recoilMulFor(sys: WeaponSystem, cls: WeaponClass): number {
  const v = sys.ctx.progression?.derived.recoilMul[cls];
  return typeof v === 'number' && v > 0 ? v : 1;
  }

/** 사격 스킬 reload speed multiplier for a class (>1 = faster). */
export function reloadSpeedFor(sys: WeaponSystem, cls: WeaponClass): number {
  const v = sys.ctx.progression?.derived.reloadSpeedMul[cls];
  return typeof v === 'number' && v > 0 ? v : 1;
  }

/** Fire rate after the overcharge implant bonus. */
export function effectiveFireRate(sys: WeaponSystem, st: EffectiveWeaponStats): number {
  let rate = st.fireRate;
  if (sys.ctx.player?.isOvercharged) rate *= IMPLANT_OVERCHARGE_FIRERATE_MUL;
  return Math.max(0.05, rate);
  }

/** Returns true if the hit killed an enemy. */
export function applyHit(sys: WeaponSystem, h: HitInfo, damage: number, dir: THREE.Vector3, light: boolean, ammoType?: string): boolean {
  const ctx = sys.ctx;
  if (h.intercept) {
    // Phase 4: shot down an artillery shell
    h.intercept.intercept(h.point);
    sys.fx.impactSurface(h.point, h.normal, true);
    ctx.bus.emit('ui:hitmarker', { kill: false });
    ctx.bus.emit('audio:play', { id: 'hit_metal', position: h.point, volume: 0.6 });
    return false;
  }
  if (h.enemy && h.armored && ammoType && ARMOR_IMMUNE_AMMO.includes(ammoType)) {
    // Phase 4: armour plate (behemoth front) — light / medium / shell rounds ricochet, no damage
    sys.fx.impactSurface(h.point, h.normal, true);
    ctx.bus.emit('weapon:hit', { point: h.point.clone(), normal: h.normal.clone(), enemyId: h.enemy.id, damage: 0, killed: false });
    ctx.bus.emit('audio:play', { id: 'hit_metal', position: h.point, volume: light ? 0.35 : 0.6, pitch: 1.3 });
    return false;
  }
  if (h.enemy) {
    const e = h.enemy;
    const wasDead = e.isDead;
    e.takeDamage(damage, h.point, dir);
    const killed = !wasDead && e.isDead;
    sys.fx.impactEnemy(h.point, dir, killed);
    ctx.bus.emit('weapon:hit', { point: h.point.clone(), normal: h.normal.clone(), enemyId: e.id, damage, killed });
    ctx.bus.emit('audio:play', { id: 'hit_flesh', position: h.point, volume: light ? 0.4 : 0.7 });
    return killed;
  }
  // Phase 9: a shot that really stopped at an implant barrier chews its durability — exactly once, here
  if (h.barrierOwner) damageBarrierAt(ctx, h.barrierOwner, h.point);
  // Phase 3: destructible cover (dropped structures) takes the shot's damage
  h.obstacleRef?.destructible?.onDamage(damage, h.point);
  sys.fx.impactSurface(h.point, h.normal, h.obstacle);
  ctx.bus.emit('weapon:hit', { point: h.point.clone(), normal: h.normal.clone(), enemyId: null, damage, killed: false });
  ctx.bus.emit('audio:play', { id: h.obstacle ? 'hit_metal' : 'hit_dirt', position: h.point, volume: light ? 0.25 : 0.45 });
  return false;
  }

export function onProjectileHit(sys: WeaponSystem, h: ProjectileHit, damage: number, weaponId: string): void {
  // Phase 12 총알 추적: the launch was reported by the pool with no hit; the impact completes the report
  if (h.distance > 0.05) sys.ctx.enemies?.reportShot(_rep.copy(h.point).addScaledVector(h.dir, -h.distance), h.dir, h.distance, h.point);
  sys.gunHit.point.copy(h.point); sys.gunHit.normal.copy(h.normal); sys.gunHit.distance = h.distance;
  sys.gunHit.enemy = h.enemy; sys.gunHit.obstacle = h.obstacle; sys.gunHit.obstacleRef = h.obstacleRef ?? null; sys.gunHit.valid = true; sys.gunHit.headshot = h.part === 'head';
  sys.gunHit.armored = !!h.armored; sys.gunHit.intercept = null; sys.gunHit.barrierOwner = h.barrierOwner ?? null;
  let def: WeaponDef | null = null;
  for (const s of WEAPON_SLOTS) {
    const w = sys.slots[s];
    if (w && w.stats.weaponId === weaponId) {
      // Phase 6: rockets etc. resolve in their handler (area damage, self knockback)
      if (w.unique && typeof w.unique.onProjectileHit === 'function') {
        // Phase 9: the handler resolves the damage itself (rockets) — the barrier hit is still ours to bill, once
        if (h.barrierOwner) damageBarrierAt(sys.ctx, h.barrierOwner, h.point);
        w.unique.onProjectileHit(h, damage, w); return;
      }
      def = w.def; break;
    }
  }
  const dmg = def ? damage * damageFalloff(def, h.distance) : damage;
  const killed = sys.applyHit(sys.gunHit, dmg, h.dir, false, def?.ammoType);
  if (h.enemy) sys.ctx.bus.emit('ui:hitmarker', { kill: killed, headshot: sys.gunHit.headshot });
  }
