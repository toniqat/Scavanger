/**
 * src/implants/parts/Devices.ts — **갈고리 · 대시 · 정찰 · 오버차지 · 대전차포**.
 *
 * 배리어를 뺀 나머지 임플란트 다섯 종의 실제 동작. 각각 `instant` / `hold` / `wielded` 중
 * 하나의 사용 방식을 갖고 Q 하나로 구동된다. 정찰은 Phase 12 에서 홀드 채널이 아니라
 * **한 번 누르는 광역 스캔**이 되어 이동 중에도 쓸 수 있다.
 */
import * as THREE from 'three';
import {
  IMPLANT_AT_DAMAGE, IMPLANT_AT_RADIUS, IMPLANT_BARRIER_BLOCK_DAMAGE, IMPLANT_BARRIER_BREAK_LOCKOUT,
  IMPLANT_BARRIER_CARRY_OFFSET, IMPLANT_BARRIER_CARRY_REGEN,
  IMPLANT_BARRIER_CARRY_REGEN_DELAY, IMPLANT_BARRIER_CARRY_SPEED_MUL, IMPLANT_BARRIER_CARRY_WIDTH,
  IMPLANT_BARRIER_HP, IMPLANT_BARRIER_REGEN,
  IMPLANT_DASH_DISTANCE, IMPLANT_GRAPPLE_RANGE,
  IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC, IMPLANT_OVERCHARGE_BUFF_HP_RATIO, IMPLANT_OVERCHARGE_ENERGY,
  IMPLANT_OVERCHARGE_RANGE, IMPLANT_OVERCHARGE_REGEN_TIME, IMPLANT_OVERCHARGE_SELF_HEAL_PER_SEC, IMPLANT_OVERCHARGE_SPEED_MUL,
  IMPLANT_SCAN_RADIUS, IMPLANT_SCAN_REVEAL_TIME_V2,
  IMPLANT_SHIELD_BASH_COOLDOWN, IMPLANT_SHIELD_BASH_DAMAGE, IMPLANT_SHIELD_BASH_KNOCKBACK, IMPLANT_SHIELD_BASH_RANGE, IMPLANT_SHIELD_BASH_STAMINA,
  IMPLANT_SHIELD_BASH_SWING_S,
  Keys, MouseButtons, PLAYER_RADIUS,
  type BuffMessage, type EnemyRef, type GameContext, type GameSystem, type ImplantDef, type ImplantId,
  type ImplantMessage, type ImplantsRef, type PeerId, type PlayerRef, type PlayerWeaponHost, type RelayTarget,
  type Vec3Tuple,
} from '@/shared';
import { IMPLANT_DEFS, getImplantDef, implantHex, isImplantId } from '../ImplantDefs';
import { ImplantDevice } from '../devices/ImplantDevice';
import { BarrierField } from '../effects/Barrier';
import { GrappleWire } from '../effects/Grapple';
import { RocketPool, type RocketImpact } from '../effects/AtLauncher';
import { OverchargeBeam, allyPoint, findAlly } from '../effects/Overcharge';
import { revealScan } from '../effects/Scan';
import { ImplantFx } from '../fx/ImplantFx';
import { RemoteImplants } from '../RemoteImplants';
import { ABSORB_RANGE, BARRIER_SEND_EVERY_HITS, BASH_FX_Y, BEAM_SEND_INTERVAL, BOOST_LINGER, BOOST_SEND_INTERVAL, BUMP_FX_INTERVAL, GRAPPLE_ARRIVE_DIST, GRAPPLE_FLY_SPEED, GRAPPLE_MAX_TIME, HEAL_SEND_INTERVAL, HUD_EMIT_INTERVAL, type Host, OVERCHARGE_MIN_START, SCAN_PULSE_FX_S, SHIELD_SPEED_KEY, _bp, _d, _from, _hitPt, _hp, _muzzle, _n, _o, _p, _r, _t, _tmp, tuple } from '../model';
import type { ImplantSystem } from '../ImplantSystem';

/* ═══════════════════════════ 대시 ═══════════════════════════ */
export function castDash(sys: ImplantSystem): void {
  const ctx = sys.ctx;
  const p = ctx.player;
  if (!p) return;
  if (!sys.useCharge()) return;

  p.getForward(_d);
  _d.y = 0;
  if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1);
  _d.normalize();
  _from.copy(p.position);

  let dist = IMPLANT_DASH_DISTANCE;
  _o.copy(p.position); _o.y += 1.0;
  const interior = p.interior;
  const world = ctx.world && ctx.world.ready ? ctx.world : null;
  const hit = interior ? interior.raycast(_o, _d, dist + PLAYER_RADIUS)
    : world ? world.raycast(_o, _d, dist + PLAYER_RADIUS) : null;
  if (hit) dist = Math.max(0, hit.distance - PLAYER_RADIUS - 0.15);

  _t.copy(p.position).addScaledVector(_d, dist);
  const floor = interior ? interior.getFloorAt(_t.x, _t.z) : world ? world.getHeightAt(_t.x, _t.z) : _t.y;
  if (_t.y < floor) _t.y = floor;
  if (interior) interior.resolveCollision(_t, PLAYER_RADIUS);
  else if (world) {
    world.resolveCollision(_t, PLAYER_RADIUS);
    if (!world.isInsideBounds(_t.x, _t.z)) _t.copy(_from);
  }
  // PlayerRef.position is a stable Vector3 instance — teleport by writing into it.
  p.position.copy(_t);

  _tmp.copy(_from); _tmp.y += 0.9;
  _p.copy(_t); _p.y += 0.9;
  sys.fx.streak(_tmp, _p, implantHex('dash'), 0.28, 0.45);
  sys.fx.spark(_p, implantHex('dash'), 0.5);
  ctx.bus.emit('camera:shake', { intensity: 0.18, duration: 0.12 });
  ctx.bus.emit('audio:play', { id: 'dash', volume: 0.7 });
  ctx.bus.emit('implant:dashed', { position: _t.clone(), direction: _d.clone() });
  sys.activated('dash', _t);
  _p.subVectors(_t, _from);
  sys.send({ t: 'imp', ev: 'dash', o: tuple(_from), d: tuple(_p) });
  }

/* ═══════════════════════════ 갈고리 (instant) ═══════════════════════════ */
/** Q: fire at the anchor under the crosshair when it is hookable; while flying / attached Q cuts the wire. */
export function castGrapple(sys: ImplantSystem): void {
  if (sys.grappleState !== 'idle') { sys.releaseGrapple(false); return; }
  if (!sys.grappleTargetValid) { sys.deny(); return; }
  sys.fireGrapple();
  }

export function updateGrapple(sys: ImplantSystem, dt: number, active: boolean): void {
  const ctx = sys.ctx;
  const p = ctx.player;
  if (!p) return;

  if (sys.grappleState === 'idle') {
    // crosshair validity (HUD reticle) — evaluated whenever the grapple is equipped, the gun stays in hand
    let valid = false, distance = 0;
    if (active && sys.ready) {
      sys.aimRay(_o, _d);
      const interior = p.interior;
      const world = ctx.world && ctx.world.ready ? ctx.world : null;
      const hit = interior ? interior.raycast(_o, _d, IMPLANT_GRAPPLE_RANGE)
        : world ? world.raycast(_o, _d, IMPLANT_GRAPPLE_RANGE) : null;
      if (hit) { valid = true; distance = hit.distance; sys.grapplePoint.copy(hit.point); }
    }
    if (valid !== sys.grappleTargetValid || Math.abs(distance - sys.grappleTargetDist) > 0.75) {
      sys.grappleTargetValid = valid;
      sys.grappleTargetDist = distance;
      ctx.bus.emit('implant:grappleTargetChanged', { valid, distance });
    }
    return;
  }

  sys.grappleTimer += dt;
  sys.aimRay(_o, _d);
  sys.muzzle(_muzzle, _d);
  if (sys.grappleState === 'flying') {
    sys.grappleFlown += GRAPPLE_FLY_SPEED * dt;
    const total = _muzzle.distanceTo(sys.grapplePoint);
    if (sys.grappleFlown >= total) {
      sys.grappleState = 'attached';
      sys.grappleTip.copy(sys.grapplePoint);
      sys.setGrapplePull(sys.grapplePoint);
      ctx.bus.emit('implant:grappleAttached', { point: sys.grapplePoint.clone() });
      ctx.bus.emit('audio:play', { id: 'grapple_attach', position: sys.grapplePoint, volume: 0.8 });
      sys.fx.spark(sys.grapplePoint, implantHex('grapple'), 0.4);
      sys.send({ t: 'imp', ev: 'grapple', o: tuple(_muzzle), p: tuple(sys.grapplePoint) });
    } else {
      sys.grappleTip.copy(sys.grapplePoint).sub(_muzzle).normalize().multiplyScalar(sys.grappleFlown).add(_muzzle);
    }
  }
  sys.wire.set(_muzzle, sys.grappleTip, sys.grappleState === 'attached');

  if (sys.grappleState === 'attached') {
    const arrived = p.position.distanceTo(sys.grapplePoint) < GRAPPLE_ARRIVE_DIST;
    if (arrived || sys.grappleTimer > GRAPPLE_MAX_TIME || !active) sys.releaseGrapple(false);
  }
  }

export function fireGrapple(sys: ImplantSystem): void {
  if (!sys.useCharge()) return;
  const ctx = sys.ctx;
  sys.aimRay(_o, _d);
  sys.muzzle(_muzzle, _d);
  sys.grappleState = 'flying';
  sys.grappleFlown = 0;
  sys.grappleTimer = 0;
  sys.grappleTip.copy(_muzzle);
  ctx.bus.emit('implant:grappleFired', { origin: _muzzle.clone(), direction: _d.clone() });
  ctx.bus.emit('audio:play', { id: 'grapple_fire', volume: 0.8 });
  sys.activated('grapple', sys.grapplePoint);
  sys.grappleTargetValid = false;
  ctx.bus.emit('implant:grappleTargetChanged', { valid: false, distance: 0 });
  }

/** `silent` = the wire was cut by something else (stow / death), so no release sting is played. */
export function releaseGrapple(sys: ImplantSystem, silent: boolean): void {
  if (sys.grappleState === 'idle') return;
  sys.grappleState = 'idle';
  sys.grappleFlown = 0;
  sys.grappleTimer = 0;
  sys.wire.hide();
  sys.setGrapplePull(null);
  sys.ctx.bus.emit('implant:grappleReleased', {});
  if (!silent) sys.ctx.bus.emit('audio:play', { id: 'grapple_release', volume: 0.5 });
  sys.aimRay(_o, _d);
  sys.muzzle(_muzzle, _d);
  sys.send({ t: 'imp', ev: 'grapple', o: tuple(_muzzle), p: null });
  }

/** `PlayerRef.setGrappleTarget` is part of the tactical-kit contract; player/ may not have it yet. */
export function setGrapplePull(sys: ImplantSystem, point: THREE.Vector3 | null): void {
  const p = sys.ctx?.player;
  if (p && typeof p.setGrappleTarget === 'function') p.setGrappleTarget(point);
  }

/* ═══════════════════════════ 정찰 (instant, Phase 12) ═══════════════════════════ */
/**
 * Q: one wide pulse (`IMPLANT_SCAN_RADIUS`) around the caster, usable while moving — no hold, no energy. Every
 * interactable + alive enemy inside is revealed for `IMPLANT_SCAN_REVEAL_TIME_V2` to us (`detect:reveal` pillars,
 * `scan:cast` compass marks, `setXray` red silhouettes — all in `revealScan`) and to the squad: `imp scanCast`
 * carries only `p / radius / dur`, each receiver reveals from its own world. `implant:scanned` (pulse 1) stays for
 * the audio hook; `implant:activated` fires once per cast (the implant skill XP hook).
 */
export function castScan(sys: ImplantSystem): void {
  const ctx = sys.ctx;
  const p = ctx.player;
  if (!p) return;
  if (!sys.useCharge()) return;
  const radius = IMPLANT_SCAN_RADIUS, duration = IMPLANT_SCAN_REVEAL_TIME_V2;
  _p.copy(p.position); _p.y += 1.1;
  const targets = revealScan(ctx, _p, radius, duration, true);
  sys.fx.pulse(_p, radius, SCAN_PULSE_FX_S, implantHex('scan'), p.position.y);
  ctx.bus.emit('implant:scanned', { pulse: 1, radius, duration, targets });
  ctx.bus.emit('audio:play', { id: 'scan_pulse', volume: 0.7, pitch: 0.9 });
  sys.activated('scan', _p);
  sys.send({ t: 'imp', ev: 'scanCast', p: tuple(_p), radius, dur: duration });
  }

export function updateOvercharge(sys: ImplantSystem, dt: number, qDown: boolean, qPressed: boolean): void {
  const ctx = sys.ctx;
  const p = ctx.player;
  if (!p) { sys.setOvercharge(false); return; }

  if (!sys.ocActive) {
    if (!qPressed) return;
    if (sys.ocEnergy < OVERCHARGE_MIN_START) { sys.deny(); ctx.bus.emit('ui:notify', { text: '오버차지 충전 중', kind: 'warning', duration: 1 }); return; }
    sys.setOvercharge(true);
  }
  if (!qDown || sys.ocEnergy <= 0) { sys.setOvercharge(false); return; }

  sys.ocEnergy = Math.max(0, sys.ocEnergy - dt);
  sys.energyEmitAcc += dt;
  if (sys.energyEmitAcc >= HUD_EMIT_INTERVAL) { sys.energyEmitAcc = 0; sys.emitEnergy(false); }

  // ── self: slow heal + the buff while healthy
  if (p.hp < p.maxHp) p.heal(IMPLANT_OVERCHARGE_SELF_HEAL_PER_SEC * dt);
  const selfHealthy = p.hp >= p.maxHp * IMPLANT_OVERCHARGE_BUFF_HP_RATIO;
  if (selfHealthy) sys.applyBoost(p, IMPLANT_OVERCHARGE_SPEED_MUL, BOOST_LINGER);

  // ── ally under the crosshair: faster heal (+ buff while healthy), beam locks on
  sys.aimRay(_o, _d);
  const ally = findAlly(ctx, _o, _d, IMPLANT_OVERCHARGE_RANGE);
  const targetId = ally ? ally.id : null;
  sys.syncBeamNet(dt, targetId, !ally);
  if (targetId !== sys.ocTarget) {
    sys.ocTarget = targetId;
    sys.ocHealAcc = 0;
    sys.ocSendAcc = HEAL_SEND_INTERVAL;      // first tick sends immediately
    sys.ocBoostAcc = BOOST_SEND_INTERVAL;
    ctx.bus.emit('implant:overcharge', { mode: 'heal', target: targetId, active: true });
  }
  if (ally) {
    allyPoint(ally, _t);
    sys.muzzle(_muzzle, _d);
    const allyHealthy = ally.maxHp > 0 && ally.hp >= ally.maxHp * IMPLANT_OVERCHARGE_BUFF_HP_RATIO;
    sys.beam.set(_muzzle, _t, allyHealthy ? 'boost' : 'heal', ctx.camera);
    sys.ocSendAcc += dt;
    sys.ocBoostAcc += dt;
    sys.ocHealAcc += IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC * dt;
    if (sys.ocSendAcc >= HEAL_SEND_INTERVAL && sys.ocHealAcc > 0) {
      sys.ocSendAcc = 0;
      sys.sendBuff({ t: 'buff', kind: 'heal', amount: Math.round(sys.ocHealAcc * 10) / 10, duration: 0, by: sys.localName() }, ally.id);
      sys.ocHealAcc = 0;
    }
    if (allyHealthy && sys.ocBoostAcc >= BOOST_SEND_INTERVAL) {
      sys.ocBoostAcc = 0;
      sys.sendBuff({ t: 'buff', kind: 'boost', amount: IMPLANT_OVERCHARGE_SPEED_MUL, duration: BOOST_SEND_INTERVAL + BOOST_LINGER, by: sys.localName() }, ally.id);
    }
  } else {
    sys.beam.hide();
  }
  }

export function setOvercharge(sys: ImplantSystem, on: boolean): void {
  if (on === sys.ocActive) return;
  if (sys.ocActive) sys.ctx.bus.emit('implant:overcharge', { mode: 'heal', target: sys.ocTarget, active: false });
  sys.ocActive = on;
  sys.holdingFlag = on;
  sys.ocTarget = null;
  sys.ocHealAcc = 0;
  sys.ocSendAcc = HEAL_SEND_INTERVAL;
  sys.ocBoostAcc = BOOST_SEND_INTERVAL;
  if (on) {
    sys.ctx.bus.emit('implant:overcharge', { mode: 'heal', target: null, active: true });
    sys.ctx.bus.emit('audio:play', { id: 'overcharge_beam', volume: 0.5 });
    const p = sys.ctx.player;
    if (p) sys.activated('overcharge', p.position);
  } else {
    sys.beam.hide();
    sys.sendBeamOff();
  }
  sys.emitEnergy(true);
  }

/**
 * Phase 7: overcharge beam replication. `imp beam {target, self}` goes out when the channel starts, whenever the
 * locked ally changes, and as a refresh at most every `BEAM_SEND_INTERVAL` while on (a late joiner sees the beam on
 * the next refresh); `sendBeamOff` sends `{target: null, self: false}` immediately when the channel ends.
 */
export function syncBeamNet(sys: ImplantSystem, dt: number, target: PeerId | null, self: boolean): void {
  sys.beamNetAcc += dt;
  const changed = !sys.beamNetOn || target !== sys.beamNetTarget || self !== sys.beamNetSelf;
  if (!changed && sys.beamNetAcc < BEAM_SEND_INTERVAL) return;
  sys.beamNetOn = true; sys.beamNetTarget = target; sys.beamNetSelf = self; sys.beamNetAcc = 0;
  sys.send({ t: 'imp', ev: 'beam', target, self });
  }

export function sendBeamOff(sys: ImplantSystem): void {
  if (!sys.beamNetOn) return;
  sys.beamNetOn = false; sys.beamNetTarget = null; sys.beamNetSelf = false; sys.beamNetAcc = 0;
  sys.send({ t: 'imp', ev: 'beam', target: null, self: false });
  }

/* ═══════════════════════════ 대전차포 (wielded) ═══════════════════════════ */
export function updateLauncher(sys: ImplantSystem, active: boolean): void {
  if (!active) return;
  if (!sys.ctx.input.wasMousePressed(MouseButtons.FIRE)) return;
  if (!sys.useCharge()) return;
  const ctx = sys.ctx;
  sys.aimRay(_o, _d);
  sys.muzzle(_muzzle, _d);
  // aim the rocket at what the reticle is looking at, not straight out of the tube
  const interior = ctx.player?.interior ?? null;
  const world = ctx.world && ctx.world.ready ? ctx.world : null;
  const hit = interior ? interior.raycast(_o, _d, 400) : world ? world.raycast(_o, _d, 400) : null;
  if (hit && hit.distance > 3) _t.copy(hit.point).sub(_muzzle).normalize();
  else _t.copy(_d);
  sys.rockets.fire(_muzzle, _t, false);
  const p = ctx.player as Host | null;
  if (p && typeof p.addRecoil === 'function') p.addRecoil(0.075, (Math.random() - 0.5) * 0.03);
  ctx.bus.emit('camera:shake', { intensity: 0.4, duration: 0.2 });
  ctx.bus.emit('audio:play', { id: 'rocket_fire', volume: 1 });
  sys.activated('atlauncher', _muzzle);
  sys.send({ t: 'imp', ev: 'rocket', o: tuple(_muzzle), d: tuple(_t) });
  }

export function onRocketImpact(sys: ImplantSystem, h: RocketImpact): void {
  const ctx = sys.ctx;
  _hitPt.copy(h.point);
  const world = ctx.world && ctx.world.ready ? ctx.world : null;
  const groundY = world ? world.getHeightAt(_hitPt.x, _hitPt.z) : _hitPt.y;
  sys.fx.blast(_hitPt, IMPLANT_AT_RADIUS, groundY);
  ctx.bus.emit('camera:shake', { intensity: 0.65, duration: 0.35 });
  ctx.bus.emit('audio:play', { id: 'rocket_explode', position: _hitPt, volume: 1 });
  ctx.bus.emit('implant:rocketExploded', { position: _hitPt.clone(), radius: IMPLANT_AT_RADIUS, damage: IMPLANT_AT_DAMAGE });

  const enemies = ctx.enemies;
  if (ctx.isAuthority) {
    if (enemies) {
      const area = (enemies as { applyAreaDamage?: unknown }).applyAreaDamage;
      if (typeof area === 'function') enemies.applyAreaDamage(_hitPt, IMPLANT_AT_RADIUS, IMPLANT_AT_DAMAGE, ctx.net?.localId ?? 'local');
      else enemies.applyExplosion(_hitPt, IMPLANT_AT_RADIUS, IMPLANT_AT_DAMAGE);
    }
  } else if (ctx.net) {
    // client: the host owns enemy damage (it answers with `ee damaged` / `ee kill`)
    ctx.net.send({ t: 'explode', p: tuple(_hitPt), r: IMPLANT_AT_RADIUS, dmg: IMPLANT_AT_DAMAGE }, 'host');
  }
  sys.send({ t: 'imp', ev: 'rocketHit', p: tuple(_hitPt) });
  }

/** e2e hook: the replicated overcharge beam state of `peerId` as this client sees it (null = unknown peer). */
export function debugBeam(sys: ImplantSystem, peerId: PeerId): { on: boolean; target: PeerId | null; self: boolean; until: number } | null {
  return sys.remote?.debugBeam(peerId) ?? null;
  }
