/**
 * src/implants/parts/Barrier.ts — **배리어 방패** (Phase 10 손에 드는 형태 → Phase 12 벽 + 실드 배쉬).
 *
 * 방패는 세 가지를 동시에 한다: 적 발사체를 **막고**(`onBarrierBlocked`), 지상 적이 통과하지 못하는
 * **벽**이며(`resolveBarrierCollision` — 부딪힌 적은 잠시 방패를 든 사람을 노린다), 정면 근접을
 * 플레이어 대신 **받는다**(`absorbFrontalAttack`). 들고 좌클릭하면 **실드 배쉬**(`tryBash`).
 * `IMPLANT_BARRIER_CARRY_OFFSET` 은 `PLAYER_RADIUS` 보다 커야 한다 — 그보다 작으면 적 히트스캔이
 * 방패보다 먼저 플레이어 캡슐에 닿아 방패가 조용히 동작하지 않는다.
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

/**
 * Hostile-projectile blocking for the local barrier and every replicated peer barrier.
 * Player shields ignore friendly fire, so `fromEnemy === false` never blocks.
 * **Pure query** (Phase 9): safe for per-tick line-of-sight tests. A caller whose shot really stopped here calls
 * `damageBarrier(owner, point)` once — that is where the local shield loses durability and sparks fly.
 */
export function raycastBarrier(sys: ImplantSystem, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, fromEnemy: boolean): { point: THREE.Vector3; owner: PeerId | 'local' } | null {
  if (!fromEnemy || !sys.ctx) return null;
  let best: BarrierField | null = null;
  let bestDist = Infinity;
  if (sys.barrier.active && sys.barrier.intersect(origin, dir, maxDist, _hitPt)) {
    best = sys.barrier; bestDist = _hitPt.distanceToSquared(origin); _bp.copy(_hitPt);
  }
  for (const b of sys.remote.getBarriers(sys.remoteBarriers)) {
    if (!b.intersect(origin, dir, maxDist, _hitPt)) continue;
    const d = _hitPt.distanceToSquared(origin);
    if (d < bestDist) { bestDist = d; best = b; _bp.copy(_hitPt); }
  }
  if (!best) return null;
  return { point: _bp.clone(), owner: best.owner };
  }

/**
 * A projectile really stopped at a barrier: the local shield takes `amount` (`IMPLANT_BARRIER_BLOCK_DAMAGE` by default) +
 * `implant:barrierHit` (+ collapse / lockout / `imp barrier` sync), a peer's shield only sparks — its owner is
 * authoritative over its hp and broadcasts it.
 */
export function damageBarrier(sys: ImplantSystem, owner: PeerId | 'local', point: THREE.Vector3, amount = IMPLANT_BARRIER_BLOCK_DAMAGE): void {
  if (!sys.ctx) return;
  if (owner === 'local') { if (sys.barrier.active) sys.onBarrierBlocked(point, amount); }
  else sys.fx.spark(point, implantHex('barrier'), 0.3);
  }

export function emitBarrier(sys: ImplantSystem): void {
  if (!sys.ctx || !sys.barrier) return;
  sys.ctx.bus.emit('implant:barrierChanged', {
    hp: sys.barrier.hp, maxHp: sys.barrier.maxHp, active: sys.barrier.active,
  });
  }

/* ═══════════════════════════ 배리어 = 들고 다니는 방패 (Phase 10) ═══════════════════════════ */
/** Refused while the shield is recharging after a collapse (the lockout doubles as its cooldown). */
export function canRaiseShield(sys: ImplantSystem): boolean {
  if (sys.barrierLocked || sys.cdRemaining > 0 || sys.chargesLeft <= 0) {
    sys.ctx.bus.emit('ui:notify', { text: '배리어 재충전 중', kind: 'warning', duration: 1.2 });
    sys.deny();
    return false;
  }
  return true;
  }

/** Q → shield up: the panel appears in front of the carrier and follows them from this frame on. */
export function raiseShield(sys: ImplantSystem): void {
  sys.barrier.raise();
  sys.barrierSinceHit = 0;
  sys.barrierSendAcc = 0;
  sys.followShield();
  sys.applyShieldSpeed();
  sys.emitBarrier();
  sys.ctx.bus.emit('implant:barrierCarried', { up: true });
  sys.activated('barrier', sys.barrier.position);
  sys.ctx.bus.emit('audio:play', { id: 'barrier_deploy', volume: 0.8 });
  sys.sendShield(true);
  }

/** Q again / weapon key / death / phase change → shield down. */
export function lowerShield(sys: ImplantSystem): void {
  if (!sys.barrier?.active) return;
  sys.barrier.lower();
  sys.clearShieldSpeed();
  sys.emitBarrier();
  sys.ctx.bus.emit('implant:barrierCarried', { up: false });
  sys.ctx.bus.emit('audio:play', { id: 'barrier_stow', volume: 0.5 });
  sys.sendShield(false);
  }

/**
 * Per frame while raised: keep the panel on the carrier, keep the movement penalty alive, and (Phase 12) read the
 * 실드 배쉬 input — LMB (`Keys.FIRE`) or the melee key. The melee press is consumed afterwards so weapons/ (which
 * runs later in the frame and already holsters while `blocksWeapons`) can never swing its own melee on the same F.
 */
export function updateShield(sys: ImplantSystem, active: boolean): void {
  if (!sys.barrier.active) return;
  sys.followShield();
  sys.applyShieldSpeed();
  if (!active) return;
  const input = sys.ctx.input;
  const meleeKey = input.wasPressed(Keys.MELEE);
  if (meleeKey || input.wasMousePressed(MouseButtons.FIRE)) {
    sys.tryBash();
    if (meleeKey) input.consume(Keys.MELEE);
  }
  }

/**
 * 실드 배쉬: costs `IMPLANT_SHIELD_BASH_STAMINA`, then strikes every alive enemy inside the box in front of the
 * carrier — the shield's own width (± enemy radius) by `IMPLANT_SHIELD_BASH_RANGE` (+ radius) past the panel
 * plane — for `IMPLANT_SHIELD_BASH_DAMAGE × derived.meleeDamageMul` (no weapon / 개머리판 bonus). The pose is the
 * player's existing heavy swing (`startMelee('heavy')` → MELEE_HEAVY on the wire, so replicas pose for free);
 * the shield itself stays raised. Replica enemies forward the `hit` to the host themselves (`takeDamage`).
 */
export function tryBash(sys: ImplantSystem): void {
  const ctx = sys.ctx;
  const p = ctx.player;
  if (!p || !sys.barrier.active) return;
  if (sys.bashCd > 0 || sys.bashTimer > 0) return;
  if (typeof p.consumeStamina !== 'function' || !p.consumeStamina(IMPLANT_SHIELD_BASH_STAMINA)) {
    sys.deny();
    ctx.bus.emit('ui:notify', { text: '스태미나 부족', kind: 'warning', duration: 0.8 });
    return;
  }
  sys.bashCd = IMPLANT_SHIELD_BASH_COOLDOWN;
  sys.bashTimer = IMPLANT_SHIELD_BASH_SWING_S;
  if (typeof p.startMelee === 'function') p.startMelee('heavy');

  // box in front of the carrier, in panel space: n = forward (panel normal), r = right
  const yaw = p.yaw;
  _n.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  _r.set(-_n.z, 0, _n.x);
  _from.copy(p.position);
  const halfW = IMPLANT_BARRIER_CARRY_WIDTH / 2;
  const reach = IMPLANT_BARRIER_CARRY_OFFSET + IMPLANT_SHIELD_BASH_RANGE;
  const mul = ctx.progression?.derived?.meleeDamageMul ?? 1;
  const dmg = IMPLANT_SHIELD_BASH_DAMAGE * (Number.isFinite(mul) && mul > 0 ? mul : 1);
  let hits = 0;
  const enemies = ctx.enemies;
  if (enemies) {
    _p.copy(_from); _p.y += 0.9;
    const list: readonly EnemyRef[] = enemies.queryNear(_p, reach + halfW + 3);
    for (const e of list) {
      if (e.isDead) continue;
      const dx = e.position.x - _from.x, dz = e.position.z - _from.z;
      const fwd = dx * _n.x + dz * _n.z;
      if (fwd <= 0 || fwd > reach + e.radius) continue;
      if (Math.abs(dx * _r.x + dz * _r.z) > halfW + e.radius) continue;
      _hp.copy(e.position); _hp.y += e.height * 0.5;
      e.takeDamage(dmg, _hp, _n);
      sys.fx.spark(_hp, implantHex('barrier'), 0.4);
      hits++;
    }
  }

  // knockback (2026-09-11 C-1 · X-6): `EnemyManagerRef.pushBack` is contract now. We never branch on role — the
  // authority shoves its own copies, a replica forwards one `HitRequest {dmg: 0, kb}` per enemy to the host itself.
  if (hits > 0 && enemies) {
    _t.copy(_from).addScaledVector(_n, IMPLANT_BARRIER_CARRY_OFFSET + IMPLANT_SHIELD_BASH_RANGE * 0.5); _t.y += 0.9;
    enemies.pushBack(_t, IMPLANT_SHIELD_BASH_RANGE + IMPLANT_BARRIER_CARRY_WIDTH / 2, IMPLANT_SHIELD_BASH_KNOCKBACK, _n);
  }
  // swing FX: a horizontal streak sweeping the panel's front edge, chest high
  _t.copy(_from).addScaledVector(_n, IMPLANT_BARRIER_CARRY_OFFSET + 0.25); _t.y += BASH_FX_Y;
  _tmp.copy(_t).addScaledVector(_r, -halfW);
  _p.copy(_t).addScaledVector(_r, halfW);
  sys.fx.streak(_tmp, _p, implantHex('barrier'), IMPLANT_SHIELD_BASH_SWING_S, 0.5);
  ctx.bus.emit('camera:shake', { intensity: hits > 0 ? 0.28 : 0.14, duration: 0.14 });
  ctx.bus.emit('audio:play', { id: 'melee_swing', volume: 0.8, pitch: 0.85 });
  if (hits > 0) ctx.bus.emit('audio:play', { id: 'barrier_hit', position: _t, volume: 0.7 });
  ctx.bus.emit('implant:bashed', { position: _from.clone(), yaw, hits });
  sys.send({ t: 'imp', ev: 'bash', p: tuple(_from), yaw: Math.round(yaw * 1000) / 1000 });
  }

/**
 * Enemy movement vs every raised shield (local + peers' replicas). The first shield overlapping the mover pushes
 * `pos` out to its front face and names its carrier (enemies/ retargets the bug onto them). Pure apart from `pos`;
 * no allocations — called per simulated bug per tick.
 */
export function resolveBarrierCollision(sys: ImplantSystem, pos: THREE.Vector3, radius: number): PeerId | 'local' | null {
  if (!sys.ctx) return null;
  if (sys.barrier.active && sys.barrier.pushOut(pos, radius)) return 'local';
  for (const b of sys.remote.getBarriers(sys.remoteBarriers)) {
    if (b.pushOut(pos, radius)) return b.owner;
  }
  return null;
  }

/**
 * A melee attack of `amount` from `fromPos` is about to land on `owner`. True when that carrier's raised shield
 * faces the attacker (inside `IMPLANT_BARRIER_CARRY_ARC`, within `ABSORB_RANGE`) and took it instead: the local
 * shield loses `amount` through the normal block path (`implant:barrierHit`, collapse → lockout + `stow()`); a
 * peer's shield only sparks here — the caller sends `ee barrierHit` to that peer, whose `damageBarrier('local', …)`
 * deducts it.
 */
export function absorbFrontalAttack(sys: ImplantSystem, owner: PeerId | 'local', fromPos: THREE.Vector3, amount: number): boolean {
  if (!sys.ctx) return false;
  const b = sys.barrierOf(owner);
  if (!b || !b.active || !b.facing(fromPos, ABSORB_RANGE)) return false;
  b.contactPoint(fromPos, _hitPt);
  if (owner === 'local') sys.onBarrierBlocked(_hitPt, amount);
  else sys.fx.spark(_hitPt, implantHex('barrier'), 0.35);
  return true;
  }

export function barrierOf(sys: ImplantSystem, owner: PeerId | 'local'): BarrierField | null {
  if (owner === 'local') return sys.barrier;
  for (const b of sys.remote.getBarriers(sys.remoteBarriers)) if (b.owner === owner) return b;
  return null;
  }

/** `implant:barrierBumped` from enemies/: a bug pressed against a shield — spark the contact point (throttled). */
export function onBarrierBumped(sys: ImplantSystem, point: THREE.Vector3): void {
  if (sys.bumpFxAcc < BUMP_FX_INTERVAL) return;
  sys.bumpFxAcc = 0;
  sys.fx.spark(point, implantHex('barrier'), 0.22);
  }

/** Panel plane in front of the player's feet, facing where they face. */
export function followShield(sys: ImplantSystem): void {
  const p = sys.ctx.player;
  if (!p) return;
  sys.barrier.follow(p.position, p.yaw);
  }

export function applyShieldSpeed(sys: ImplantSystem): void {
  const p = sys.ctx.player;
  if (p && typeof p.setSpeedModifier === 'function') p.setSpeedModifier(SHIELD_SPEED_KEY, IMPLANT_BARRIER_CARRY_SPEED_MUL);
  }

export function clearShieldSpeed(sys: ImplantSystem): void {
  const p = sys.ctx?.player;
  if (p && typeof p.setSpeedModifier === 'function') p.setSpeedModifier(SHIELD_SPEED_KEY, 1);
  }

/**
 * Regeneration. Lowered: `IMPLANT_BARRIER_REGEN`/s. Raised (Phase 10): `IMPLANT_BARRIER_CARRY_REGEN`/s once
 * `IMPLANT_BARRIER_CARRY_REGEN_DELAY` has passed without a block, so holding the shield up is no longer a
 * one-way drain. After a collapse it is locked for `IMPLANT_BARRIER_BREAK_LOCKOUT` (× cooldown mul) and refills
 * from 0 to full over exactly that window, so the HUD durability gauge doubles as the cooldown readout.
 */
export function tickBarrierRegen(sys: ImplantSystem, dt: number, def: ImplantDef | undefined): void {
  if (def?.id !== 'barrier') return;
  if (sys.barrier.active) sys.barrierSinceHit += dt;
  if (sys.barrier.hp >= sys.barrier.maxHp) return;
  if (sys.barrier.active) {
    if (sys.barrierSinceHit < IMPLANT_BARRIER_CARRY_REGEN_DELAY) return;
    sys.barrier.regen(IMPLANT_BARRIER_CARRY_REGEN, dt);
  } else if (sys.barrierLocked && sys.cdTotal > 0) {
    sys.barrier.regen(sys.barrier.maxHp / sys.cdTotal, dt);
  } else {
    sys.barrier.regen(IMPLANT_BARRIER_REGEN, dt);
  }
  sys.barrierEmitAcc += dt;
  if (sys.barrierEmitAcc >= HUD_EMIT_INTERVAL || sys.barrier.hp >= sys.barrier.maxHp) {
    sys.barrierEmitAcc = 0;
    sys.emitBarrier();
  }
  }

export function onBarrierBlocked(sys: ImplantSystem, point: THREE.Vector3, damage: number): void {
  sys.barrierSinceHit = 0;
  const collapsed = sys.barrier.damage(damage);
  sys.fx.spark(point, implantHex('barrier'), 0.45);
  sys.ctx.bus.emit('implant:barrierHit', { point: point.clone(), damage });
  sys.ctx.bus.emit('audio:play', { id: 'barrier_hit', position: point, volume: 0.5 });
  sys.emitBarrier();
  if (collapsed) {
    sys.chargesLeft = 0;
    sys.barrierLocked = true;
    sys.startCooldown(IMPLANT_BARRIER_BREAK_LOCKOUT * sys.cooldownMul());
    sys.fx.blast(point, 2.4, point.y);
    sys.ctx.bus.emit('ui:notify', { text: '배리어 파괴됨', kind: 'danger', duration: 1.6 });
    sys.ctx.bus.emit('audio:play', { id: 'barrier_break', position: point, volume: 0.9 });
    // `damage()` already lowered the panel — put the (now useless) grip away and tell everyone
    sys.clearShieldSpeed();
    sys.ctx.bus.emit('implant:barrierCarried', { up: false });
    sys.sendShield(false);
    sys.stow();
    return;
  }
  sys.barrierSendAcc += 1;
  if (sys.barrierSendAcc >= BARRIER_SEND_EVERY_HITS) { sys.barrierSendAcc = 0; sys.sendShield(true); }
  }

/**
 * Replicated shield state. The transform rides on our own `PlayerSnapshot` (`p`, `yaw`, `PlayerFlags.BARRIER`,
 * `bhp`), so only "up" and the durability travel here: on raise / lower, every `BARRIER_SEND_EVERY_HITS` blocked
 * hits, and unicast to a late joiner on `flow rejoined`.
 */
export function sendShield(sys: ImplantSystem, up: boolean, to: RelayTarget = 'others'): void {
  sys.send({ t: 'imp', ev: 'shield', up, hp: Math.round(sys.barrier.hp) }, to);
  }

/**
 * Local shield pose for renderers / tests: writes the **panel-bottom centre** into `outPosition` and returns its
 * facing. null while the shield is down (`intersect` measures dy from that y, so the panel spans
 * `y … y + IMPLANT_BARRIER_CARRY_HEIGHT`).
 */
export function getBarrierPose(sys: ImplantSystem, outPosition: THREE.Vector3): { yaw: number } | null {
  if (!sys.barrier?.active) return null;
  outPosition.copy(sys.barrier.position);
  return { yaw: sys.barrier.yaw };
  }
