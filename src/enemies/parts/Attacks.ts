/**
 * src/enemies/parts/Attacks.ts — **the attacks enemies make**.
 *
 * The acid spit · the rogue's gun · artillery shells (interceptable) · rogue grenades and the incendiary fire zone they leave
 * (`onFireZoneTick`) · the spewer's death burst (`acidBurst`) · the toxic suicide burst. All of it
 * is decided **on the host alone**, the result goes out as an `ee` event, and each client only replays the FX in `parts/RemoteFx.ts`.
 */
import * as THREE from 'three';
import {
  PLAYER_HEIGHT, PLAYER_RADIUS, ROGUE_DAMAGE, ROGUE_GRENADE_DAMAGE, ROGUE_GRENADE_FUSE, ROGUE_GRENADE_RADIUS, SHELL_BLAST_RADIUS, SHELL_DAMAGE, SHELL_FLIGHT_TIME, SHELL_LEAD_MAX, TOXIC_DAMAGE,
  TOXIC_RADIUS, shellLaunchVelocity, shellPositionAt, explosionFalloff, blastReachesBody, type EnemyEvent, type EnemyFaction, type EnemyType, type WorldRef,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { Enemy, type RogueShotOpts } from '../Enemy';
import { ENEMY_CLASH, ENEMY_INCENDIARY, ROGUE_AI, SPEWER_SPIT } from '../EnemyTypes';
import { ENEMY_GRENADE_KINDS, type EnemyGrenadeKind } from '@/shared';
/* appended (2026-09-15, B-16): an enemy fire zone burns drones */
import { FIRE_ZONE_DRONE_HEIGHT } from '@/shared';
import { humanoidProfile } from '../ai/HumanoidProfile';
import { CombatTarget, VEHICLE_RAY_MARGIN } from '../Targets';
import { holdingFire } from '../ai/Common';
import { RogueGrenades } from '../fx/RogueGrenade';
import { tuple } from '../net/HostSync';
import { rayCapsule, rayStandingCapsule } from '../RayTests';
import { BURN_TICK, GRENADE_KNOCKBACK, GRENADE_LOB_SPEED, GRENADE_NOISE, SHELL_ARC_CHECK_FRAC, SHELL_ARC_SAMPLES, _aim, _arcA, _arcD, _arcP, _arcV, _c, _dir, _eye, _hc, _hd, _hp, _kb, _lead, _m, _sd, _sh, _so, _to, _v, _v2, _zero } from '../model';
import { meleeHitSound } from '../model';
import type { EnemySystem } from '../EnemySystem';
/* 2026-09-15 (results screen overhaul): where the player's damage came from (cached per body) */
import { enemyDamageSource, enemyTypeOf } from './Damage';
/* 2026-09-15 (android squadmates): the android share of an enemy's area damage and of a fire zone */
import { allyDamage, damageAlliesAt } from './Damage';

/**
 * 2026-09-15 (results screen overhaul): a shell in flight → the artillery that fired it. The shell pool does not know its owner, so the
 * authority notes it at launch and clears it on landing / interception. With none (host-fired before promotion, lost to a reset) it is id 0 · `artillery`, as before. The cap is a nominal pin.
 */
const _shellOwners = new Map<number, { id: number; type: EnemyType }>();
const SHELL_OWNER_CACHE_MAX = 256;

/**
 * Spit at an explicit point (smoke return fire / deployables) — the glob still hurts whoever it lands on.
 * 2026-09-11 (C-48): the host mirrors it as `ee acidAt {id, from, to}` — before, replicas never saw these globs.
 */
export function fireAcidAt(sys: EnemySystem, from: THREE.Vector3, aimFeet: THREE.Vector3, shooter: Enemy): void {
  if (sys.acid?.fireAt(from, aimFeet, shooter.id, shooter.faction)) sendAcidAt(sys, shooter.id, from, aimFeet);
  }

/** 2026-09-11 (C-48): host → others, a glob `ee acid` cannot describe (drone · enemy · point target). Replicas fly it visually. */
function sendAcidAt(sys: EnemySystem, id: number, from: THREE.Vector3, to: THREE.Vector3): void {
  if (sys.hosting) sys.ctx.net!.send({ t: 'ee', ev: 'acidAt', id, from: tuple(from, 2), to: tuple(to, 2) }, 'others');
  }

export function emberBurst(sys: EnemySystem, position: THREE.Vector3, count: number): void {
  sys.fx?.burst(position, count, 'ember', 1.6);
  }

const _acidTo = new THREE.Vector3();

/* ── Phase 7: rogue grenades ───────────────────────────────────────────── */
/**
 * Authority: lob a grenade from the rogue's off hand onto `target` (feet), `ee grenade` to the others.
 * 2026-09-13: the grenade is **real inventory** — refused while `e.grenadeCount` is 0, and a successful toss spends one
 * (what is left goes to the corpse, `ee corpse.gc`). The kind is `e.grenadeKind` (`ee grenade.k`, omitted = frag) and the
 * landing scatter is the faction's `grenadeScatter` (±m; raiders throw tighter than rogues).
 */
export function throwGrenade(sys: EnemySystem, e: Enemy, target: THREE.Vector3): boolean {
  const ctx = sys.ctx;
  const world = ctx.world;
  if (!world || !sys.grenades || !sys.authority || e.grenadeCount <= 0) return false;
  // launch point: off-hand height, a little ahead of the body
  e.facing(_m).multiplyScalar(e.stats.radius * 0.8);
  _m.add(e.position); _m.y += e.stats.height * 0.78;
  const scatter = humanoidProfile(e).grenadeScatter;
  _aim.copy(target);
  _aim.x += (Math.random() - 0.5) * 2 * scatter; _aim.z += (Math.random() - 0.5) * 2 * scatter;
  if (!world.isInsideBounds(_aim.x, _aim.z)) _aim.copy(target);
  _aim.y = world.getHeightAt(_aim.x, _aim.z);
  const dist = Math.hypot(_aim.x - _m.x, _aim.z - _m.z);
  const flight = THREE.MathUtils.clamp(dist / GRENADE_LOB_SPEED, 0.8, 1.8);
  RogueGrenades.launchVelocity(_m, _aim, flight, _dir);
  // a rock right in front of the hand would bounce the grenade back onto the thrower: refuse (the AI retries elsewhere)
  _v.copy(_dir).normalize();
  if (world.raycast(_m, _v, 2.5) !== null) return false;
  const kind = e.grenadeKind;
  if (!sys.grenades.throw(e.id, _m, _dir, ROGUE_GRENADE_FUSE, true, kind, e.faction)) return false;
  e.grenadeCount = Math.max(0, e.grenadeCount - 1);
  sys.grenadesThrown++;
  sys.playAudio('grenade_throw', e.position, 0.7, 0.95);
  if (sys.hosting) {
    const k = Math.max(0, ENEMY_GRENADE_KINDS.indexOf(kind));
    const msg: EnemyEvent = k > 0
      ? { t: 'ee', ev: 'grenade', id: e.id, p: tuple(_m, 2), v: tuple(_dir, 2), fuse: ROGUE_GRENADE_FUSE, k }
      : { t: 'ee', ev: 'grenade', id: e.id, p: tuple(_m, 2), v: tuple(_dir, 2), fuse: ROGUE_GRENADE_FUSE };
    ctx.net!.send(msg, 'others');
  }
  return true;
  }

/* ── GrenadeHost ───────────────────────────────────────────────────────── */
/**
 * Fuse ran out. Authority: ROGUE_GRENADE_DAMAGE with the shared two-step-stair falloff (`shared/explosion`) over ROGUE_GRENADE_RADIUS to every alive player
 * (local directly, remote via `dmg {kb}`, suspended via `ghost:damage`) and to enemies of the other faction, blast
 * noise, `ee grenadeHit`. Everyone: audio, shake near the local player.
 * 2026-09-13: `kind` — an incendiary is a small blast (`ENEMY_INCENDIARY.blastDamage` / `blastRadius`, no knockback);
 * its fire zone was lit by `RogueGrenades` and burns through `onFireZoneTick`. The spared faction is the **thrower's**
 * (was hard-coded `'rogue'`, so a raider's grenade would have hurt raiders). `ee grenadeHit.k` carries the kind.
 */
export function onGrenadeExploded(sys: EnemySystem, p: THREE.Vector3, authority: boolean, owner: number, kind: EnemyGrenadeKind = 'frag'): void {
  const ctx = sys.ctx;
  sys.grenadesExploded++;
  sys.lastGrenadeBlast.copy(p);
  const fire = kind === 'incendiary';
  const radius = fire ? ENEMY_INCENDIARY.blastRadius : ROGUE_GRENADE_RADIUS;
  const damage = fire ? ENEMY_INCENDIARY.blastDamage : ROGUE_GRENADE_DAMAGE;
  if (authority && sys.authority) {
    const thrower = sys.byId.get(owner);
    const type: EnemyType = thrower?.type ?? enemyTypeOf(sys, owner, 'rogue');   // 2026-09-15: a body that died after throwing still keeps its own type
    const players = sys.targets.alive;
    const reach = radius + PLAYER_RADIUS;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      _c.set(t.position.x, t.position.y + PLAYER_HEIGHT * 0.5, t.position.z);
      const d = _c.distanceTo(p);
      if (d >= reach) continue;
      // 2026-09-18 (user's decision): nothing past a wall · roof · floor is hit (the 3 body points, `shared/explosion.blastReachesBody`)
      if (!blastReachesBody(ctx.world, p, t.position.x, t.position.y, t.position.z, PLAYER_HEIGHT)) continue;
      // 2026-09-15 (user's decision): an enemy grenade uses the shared two-step stair too (`shared/explosion`) — the 0.1 floor is laid on top of it unchanged
      const falloff = Math.max(0.1, explosionFalloff(Math.max(0, d - PLAYER_RADIUS), radius));
      if (fire) { sys.applyDamage(t, damage * falloff, p, owner, type, null, 0.5 * falloff, false); continue; }
      _kb.subVectors(_c, p); _kb.y = Math.max(_kb.y, 0) + 0.35;
      if (_kb.lengthSq() < 1e-4) _kb.set(0, 1, 0); else _kb.normalize();
      sys.applyDamage(t, damage * falloff, p, owner, type, null, 0.9 * falloff, false, _kb, GRENADE_KNOCKBACK * falloff);
    }
    // 2026-09-15 (android squadmates): the same formula as the player loop (the distance measured at the chest · floor 0.1). No knockback.
    damageAlliesAt(sys, p, radius, damage, owner, type, 0.1, 'chest');
    sys.explode(p, radius, damage * ENEMY_CLASH.damageMul, 'ai', null, null, thrower?.faction ?? 'rogue');   // 2026-09-17: the enemy → enemy damage multiplier
    // the drone and rover shares are called **at each enemy blast site**, not inside `explode()` — player weapons, gadgets, ship
    // calls and a replica's `explode` request pass through `explode()` too, so putting it there hits a drone twice and lets a player's attack damage the vehicle.
    ctx.drones?.applyExplosion(p, radius, damage);   // 2026-09-11: on the authority only (damageDrone forwards to the owner)
    sys.targets.damageVehicleAt(p, radius, damage);  // 2026-09-13: the rover (enemy explosions only)
    sys.alertHearing(p, GRENADE_NOISE);
    if (sys.hosting) {
      const k = Math.max(0, ENEMY_GRENADE_KINDS.indexOf(kind));
      ctx.net!.send(k > 0 ? { t: 'ee', ev: 'grenadeHit', p: tuple(p, 2), k } : { t: 'ee', ev: 'grenadeHit', p: tuple(p, 2) }, 'others');
    }
  }
  sys.playAudio('explosion', p, fire ? 0.7 : 0.9, fire ? 1.35 : 1.15);
  const dl = sys.targets.distToLocal(p);
  const shake = fire ? 0.4 : 0.7;
  if (dl < 30) ctx.bus.emit('camera:shake', { intensity: shake * (1 - dl / 30), duration: 0.35 });
  }

/** A body this far above / below a fire zone's centre is on another floor and does not burn (m, geometry — not balance). */
const FIRE_ZONE_HEIGHT = 2.5;

/**
 * 2026-09-13 (`GrenadeHost.onFireZoneTick`, authority only): an enemy incendiary's fire zone burns for `tick` seconds.
 * - **players** inside `radius` (+ body): the local one gets `PlayerRef.setBurning(ENEMY_INCENDIARY.dps, afterburn)` —
 *   the same DoT a player-made fire zone uses (grit save suppressed, `player:burning`); a remote one a quiet `dmg` tick
 *   through `applyDamage` (no `ee attack`), a suspended one `ghost:damage` — the same routing as every other enemy hit.
 * - **enemies not of `faction`**: the burning status (`burnDps` / `burnTimer`), credited to `'ai'` unless a player
 *   already lit it — so an enemy's fire never hands a player a kill.
 * 2026-09-13: the **rover** burns too when its footprint overlaps the zone on the same floor (`RoverRef.damage`, dps × tick).
 * 2026-09-15 (B-16): **drones** burn — horizontal distance ≤ `radius` and below `FIRE_ZONE_DRONE_HEIGHT` over the zone (a ground
 * drone always, an air drone only while it hovers low; another floor below does not). Drones are the players', so the thrower's
 * faction never spares them. `damageDrone(dps × tick)` forwards to the owner itself (`droneq damage`) — owner-authoritative.
 * (Was: "drones are not touched" — the fire zone had no effect on a drone parked in it.)
 */
export function onFireZoneTick(sys: EnemySystem, p: THREE.Vector3, radius: number, owner: number, faction: EnemyFaction, tick: number): void {
  if (!sys.authority) return;
  const dps = ENEMY_INCENDIARY.dps;
  if (!(dps > 0) || !(tick > 0)) return;
  const ctx = sys.ctx;
  const type: EnemyType = enemyTypeOf(sys, owner, 'rogue');
  const players = sys.targets.alive;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    const dx = t.position.x - p.x, dz = t.position.z - p.z;
    const reach = radius + PLAYER_RADIUS;
    if (dx * dx + dz * dz > reach * reach || Math.abs(t.position.y - p.y) > FIRE_ZONE_HEIGHT) continue;
    if (t.isLocal) {
      const pl = ctx.player;
      // 2026-09-15 (results screen overhaul): the burn tick and the cause of death = the enemy body that lit the fire (a cached source — nothing allocated per tick)
      if (pl && !pl.isDead && typeof pl.setBurning === 'function') pl.setBurning(dps, ENEMY_INCENDIARY.afterburn, enemyDamageSource(owner, type));
    } else sys.applyDamage(t, dps * tick, p, owner, type, null, 0, false);
  }
  // 2026-09-15 (android squadmates): standing in the zone costs the same dps × tick as a person (an android has no burning state of its own like `setBurning`)
  const allies = sys.targets.allies;
  for (let i = 0; i < allies.length; i++) {
    const t = allies[i];
    if (t.isDeadOrDowned || t.allyId === null) continue;
    const dx = t.position.x - p.x, dz = t.position.z - p.z;
    const reach = radius + PLAYER_RADIUS;
    if (dx * dx + dz * dz > reach * reach || Math.abs(t.position.y - p.y) > FIRE_ZONE_HEIGHT) continue;
    allyDamage(sys, t.allyId, dps * tick, enemyDamageSource(owner, type), p);
  }
  const veh = sys.targets.vehicleTarget();
  if (veh && veh.vehicle && veh.vehicleGap2D(p.x, p.z) <= radius && Math.abs(veh.position.y - p.y) <= FIRE_ZONE_HEIGHT) {
    veh.vehicle.damage(dps * tick, p);
  }
  // 2026-09-15 (B-16): drones in the zone (see the doc comment — horizontal radius, low over the fire, not a floor below)
  const drones = ctx.drones;
  if (drones) {
    const list = drones.getDrones();
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!(d.hp > 0)) continue;
      const dx = d.position.x - p.x, dz = d.position.z - p.z;
      if (dx * dx + dz * dz > radius * radius) continue;
      const dy = d.position.y - p.y;
      if (dy >= FIRE_ZONE_DRONE_HEIGHT || dy < -FIRE_ZONE_HEIGHT) continue;
      drones.damageDrone(d.id, dps * tick, p);
    }
  }
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.isCombatant || e.faction === faction) continue;
    const dx = e.position.x - p.x, dz = e.position.z - p.z;
    const reach = radius + e.stats.radius;
    if (dx * dx + dz * dz > reach * reach || Math.abs(e.position.y - p.y) > FIRE_ZONE_HEIGHT) continue;
    e.burnDps = Math.max(e.burnDps, dps * ENEMY_CLASH.damageMul);   // 2026-09-17: the enemy → enemy damage multiplier
    e.burnTimer = Math.max(e.burnTimer, ENEMY_INCENDIARY.afterburn);
    if (e.burnTick <= 0) e.burnTick = BURN_TICK;
    if (e.burnAttacker === null) e.burnAttacker = 'ai';
  }
  }

export function fireAcid(sys: EnemySystem, from: THREE.Vector3, shooter: Enemy, target: CombatTarget): void {
  // 2026-09-13: the rover proxy takes the same path — `ee acid` can only name a player, so the aim point goes out as `ee acidAt`. A direct hit is judged by the glob against the hull box.
  if (target.drone || target.vehicle) {
    // 2026-09-11: drone targets — the predictive aim (`fire`) is unchanged. A direct hit is judged by `AcidProjectiles` against the drone body.
    // C-48: `ee acid` can only name a player, so the aim point is sent as `ee acidAt` instead (before this there was no wire at all).
    if (sys.acid?.fire(from, target, shooter.id, _acidTo, shooter.faction)) sendAcidAt(sys, shooter.id, from, _acidTo);
    return;
  }
  if (target.enemy) {
    // bug vs rogue: spit straight at the enemy position (C-48: mirrored as `ee acidAt`; X-5: the glob now hurts the rogue)
    _acidTo.copy(target.position);
    if (sys.acid?.fireAt(from, _acidTo, shooter.id, shooter.faction)) sendAcidAt(sys, shooter.id, from, _acidTo);
    return;
  }
  sys.acid?.fire(from, target, shooter.id, undefined, shooter.faction);
  if (sys.hosting) {
    const net = sys.ctx.net!;
    const tid = target.isLocal ? net.localId : target.id;
    if (tid) net.send({ t: 'ee', ev: 'acid', id: shooter.id, from: tuple(from, 2), target: tid }, 'others');
  }
  }

/** 2026-09-11 (C-51): the pitch now lives in `model.meleeHitSound` (one table for host · replica · barrier paths). */
export function bitePitch(sys: EnemySystem, type: EnemyType): number {
  return meleeHitSound(type)?.pitch ?? 1.05;
  }

/** Rogue hitscan shot (authority): occlusion, player capsules, enemy hitboxes, damage, FX, audio, events, wire. */
/** Returns true when a player / squad target was hit. `opts` (2026-09-11) — see `RogueShotOpts`; omitted = the classic rogue shot. */
export function fireGun(sys: EnemySystem, e: Enemy, target: CombatTarget, aimError: number, damageMul: number, opts?: RogueShotOpts): boolean {
  const ctx = sys.ctx;
  const world = ctx.world;
  if (!world) return false;
  /* 2026-09-14 3rd pass: holding fire (`ExtractionRef.holdFire`) — shots that do not pass the line-of-fire gate (`ai/FireLine`)
     — a named sniper's shot, the minigun spray — are stopped once more here. Before the muzzle FX, the sound and the ammo spend. */
  if (holdingFire(sys)) return false;
  e.muzzle(_m);
  if (opts?.aimAt) _aim.copy(opts.aimAt); else target.getChest(_aim);
  _aim.addScaledVector(target.velocity, 0.06);
  _dir.subVectors(_aim, _m);
  if (_dir.lengthSq() < 1e-4) e.facing(_dir); else _dir.normalize();
  // aim error: rotate around the right / up axes (triangular distribution)
  const ey = (Math.random() + Math.random() - 1) * aimError;
  const ep = (Math.random() + Math.random() - 1) * aimError * 0.7;
  _v.set(-_dir.z, 0, _dir.x).normalize();
  _dir.addScaledVector(_v, ey);
  _dir.y += ep;
  _dir.normalize();

  let hitT = opts?.range ?? ROGUE_AI.range;
  const wh = world.raycast(_m, _dir, hitT);
  if (wh) hitT = wh.distance;
  let victim: CombatTarget | null = null;
  const players = sys.targets.alive;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    const tt = rayStandingCapsule(_m, _dir, t.position, PLAYER_RADIUS, PLAYER_HEIGHT);
    if (tt >= 0 && tt < hitT) { hitT = tt; victim = t; }
  }
  // 2026-09-15 (android squadmates): they stop a bullet with the **same capsule** as a person — the same body size, hit the same way.
  // Damage goes through `applyDamage`'s android branch → `ctx.allies.damage` (on the authority only).
  const allies = sys.targets.allies;
  for (let i = 0; i < allies.length; i++) {
    const t = allies[i];
    if (t.isDeadOrDowned) continue;
    const tt = rayStandingCapsule(_m, _dir, t.position, PLAYER_RADIUS, PLAYER_HEIGHT);
    if (tt >= 0 && tt < hitT) { hitT = tt; victim = t; }
  }
  // 2026-09-11 (enemy ↔ drone): the body of a targetable (aggroable) drone stops a bullet too. The proxy `position` is the body's
  // **underside**, so an air drone uses the same formula, and a flat body (height < diameter) becomes a sphere at the body centre. A walking ground drone is not in the list, so bullets pass through it.
  let droneHit: CombatTarget | null = null;
  const drones = sys.targets.drones;
  for (let i = 0; i < drones.length; i++) {
    const t = drones[i];
    if (t.isDeadOrDowned) continue;
    const r = t.bodyRadius, h = t.bodyHeight, cy = t.position.y + h * 0.5;
    const tt = rayCapsule(_m, _dir, t.position.x, t.position.z, Math.min(cy, t.position.y + r), Math.max(cy, t.position.y + h - r), r).t;
    if (tt >= 0 && tt < hitT) { hitT = tt; victim = null; droneHit = t; }
  }
  // 2026-09-13 (the rover): the hull box. The world raycast stops at the hull collider first (`wh`), so when that impact lands
  // within `VEHICLE_RAY_MARGIN` of the hull's face the vehicle was hit — the same when a bullet aimed at a player hits the vehicle standing in front of it.
  let vehicleHit: CombatTarget | null = null;
  const vehicles = sys.targets.vehicles;
  for (let i = 0; i < vehicles.length; i++) {
    const t = vehicles[i];
    if (t.isDeadOrDowned) continue;
    const tt = t.rayVehicle(_m, _dir, hitT + VEHICLE_RAY_MARGIN);
    if (tt >= 0) { hitT = Math.min(hitT, tt); victim = null; droneHit = null; vehicleHit = t; }
  }
  let foe: Enemy | null = null;
  const eh = sys.raycastEx(_m, _dir, hitT, e);
  if (eh && eh.distance < hitT) { hitT = eh.distance; victim = null; droneHit = null; vehicleHit = null; foe = eh.enemy as Enemy; }
  // Phase 9: a barrier in the line stops the round (one pure raycast per shot; the barrier takes the block damage)
  let barrier = false;
  const imp = ctx.implants;
  if (imp) {
    const bh = imp.raycastBarrier(_m, _dir, hitT, true);
    if (bh) {
      const bd = bh.point.distanceTo(_m);
      if (bd < hitT) { hitT = bd; victim = null; droneHit = null; vehicleHit = null; foe = null; barrier = true; imp.damageBarrier(bh.owner, bh.point); }
    }
  }
  _to.copy(_m).addScaledVector(_dir, hitT);

  const dmg = opts?.damage ?? ROGUE_DAMAGE * damageMul;
  if (victim) sys.applyDamage(victim, dmg, e.position, e.id, e.type, null, 0.2, false);
  else if (droneHit) {
    sys.applyDamage(droneHit, dmg, e.position, e.id, e.type, null, 0, false);   // → ctx.drones.damageDrone
    const fx = FxManager.get();
    if (fx) { _v2.copy(_dir).negate(); ParticleBurst.sparks(fx.additive, _to, _v2, 6, 5); }
  }
  else if (vehicleHit) {
    sys.applyDamage(vehicleHit, dmg, e.position, e.id, e.type, null, 0, false);   // 2026-09-13 → RoverRef.damage
    const fx = FxManager.get();
    if (fx) { _v2.copy(_dir).negate(); ParticleBurst.sparks(fx.additive, _to, _v2, 6, 5); }
  }
  else if (foe && foe.faction !== e.faction) {
    foe.takeDamage(dmg * ENEMY_CLASH.damageMul, _to, _dir, 'ai');   // 2026-09-17: the enemy → enemy damage multiplier (the person and android shares keep the branches above)
    sys.noteClash(_to);
  }
  // 2026-09-11: a rogue's bullet breaks window glass too (when no body and no barrier stopped it and glass is the first surface)
  if (wh && !victim && !droneHit && !vehicleHit && !foe && !barrier && wh.obstacle?.fragile) wh.obstacle.destructible?.onDamage(dmg, wh.point);
  if (wh && !victim && !droneHit && !vehicleHit && !foe && !barrier) {
    const fx = FxManager.get();
    if (fx) ParticleBurst.dust(fx.alpha, wh.point, wh.normal, 4, 0.5);
  }
  if (opts?.fx !== false) sys.shotFx(_m, _to, victim ? 1 : 0);
  if (opts?.event !== false) ctx.bus.emit('enemy:shot', { id: e.id, type: e.type, from: _m.clone(), to: _to.clone(), hit: !!victim });
  if (opts?.wire !== false && sys.hosting) ctx.net!.send({ t: 'ee', ev: 'shoot', id: e.id, from: tuple(_m, 2), to: tuple(_to, 2), hit: !!victim }, 'others');
  if (opts?.out) { opts.out.from.copy(_m); opts.out.to.copy(_to); }
  return !!victim;
  }

/** Tracer + muzzle flash sprite (no lights) + rifle report at the muzzle. */
export function shotFx(sys: EnemySystem, from: THREE.Vector3, to: THREE.Vector3, hit: number): void {
  const fx = FxManager.get();
  if (fx) {
    fx.tracers.add(from, to, 0xffc890, 0.03, 0.09, 0);
    fx.flashes.flash(from, 0xffc070, 0, 0.55, 0.05);
  }
  sys.playAudio('shot_rifle', from, 0.75, 0.9);
  if (hit) sys.playAudio('hit_flesh', to, 0.6, 0.9);
  }

/**
 * The arc check before firing (2026-09-10). Since `SHELL_ARC_GRAVITY` was lowered and the apex went 48.7 m → 9.9 m, shells
 * catch on hills, trees and ruin walls. Bursting where it caught is the right behaviour in itself
 * (`fx/ShellProjectile.update`), but when that is **at its own feet** the artillery kills itself every 6–9 s and firing
 * becomes pointless. So before the shot the first `SHELL_ARC_CHECK_FRAC` of the arc is swept as `SHELL_ARC_SAMPLES` chords.
 *
 * - A chord passes **below** the parabola, so the check is conservative — "clear but read as blocked" happens, never the other way round.
 * - The last descending stretch is deliberately not looked at: the aim point is the ground, so it always catches, and there is no reason to refuse a wall in front of the target.
 * - It is 4 raycasts run only at the moment of firing (one gun every 6–9 s), so it is not a hot path.
 */
export function shellArcBlocked(world: WorldRef, from: THREE.Vector3, target: THREE.Vector3, flight: number): boolean {
  shellLaunchVelocity(from, target, flight, _arcV);
  _arcA.copy(from);
  for (let i = 1; i <= SHELL_ARC_SAMPLES; i++) {
    shellPositionAt(from, _arcV, (i / SHELL_ARC_SAMPLES) * SHELL_ARC_CHECK_FRAC * flight, _arcP);
    _arcD.subVectors(_arcP, _arcA);
    const len = _arcD.length();
    if (len > 1e-4) {
      _arcD.multiplyScalar(1 / len);
      if (world.raycast(_arcA, _arcD, len) !== null) return true;
    }
    _arcA.copy(_arcP);
  }
  return false;
}

/**
 * Artillery: shell `sid` toward the target's predicted position, landing after SHELL_FLIGHT_TIME.
 * The lead is half the flight time of the target's current velocity, **clamped to `SHELL_LEAD_MAX`** (2026-09-09): with a
 * 6.3 s flight a sprinting player would otherwise be led by ~19 m — a shell that lands where you are *going* is not
 * dodgeable, one that lands a few metres ahead of where you *are* is.
 *
 * Returns false when nothing was fired (pool full, or `shellArcBlocked`) — the AI relocates instead.
 */
export function fireShell(sys: EnemySystem, e: Enemy, target: CombatTarget): boolean {
  const ctx = sys.ctx;
  const world = ctx.world;
  if (!world || !sys.shells) return false;
  _lead.copy(target.velocity).multiplyScalar(SHELL_FLIGHT_TIME * 0.5);
  _lead.y = 0;
  const leadLen = _lead.length();
  if (leadLen > SHELL_LEAD_MAX) _lead.multiplyScalar(SHELL_LEAD_MAX / leadLen);
  _aim.copy(target.position).add(_lead);
  _aim.x += (Math.random() - 0.5) * 3; _aim.z += (Math.random() - 0.5) * 3;
  _aim.y = world.getHeightAt(_aim.x, _aim.z);
  _m.set(e.position.x, e.position.y + e.stats.height * 0.95, e.position.z);
  if (shellArcBlocked(world, _m, _aim, SHELL_FLIGHT_TIME)) return false;
  const sid = sys.nextShellId++;
  if (!sys.shells.fire(sid, _m, _aim, SHELL_FLIGHT_TIME)) return false;
  if (_shellOwners.size >= SHELL_OWNER_CACHE_MAX) _shellOwners.clear();
  _shellOwners.set(sid, { id: e.id, type: e.type });   // 2026-09-15: where the landing damage came from
  sys.playAudio('bug_attack', e.position, 1, 0.45);
  const fx = FxManager.get();
  if (fx) { ParticleBurst.smoke(fx.alpha, _m, 10, 1.0, 0x3a3532); fx.flashes.flash(_m, 0xffa060, 0, 1.4, 0.08); }
  ctx.bus.emit('enemy:shellFired', { sid, from: _m.clone(), target: _aim.clone(), flightTime: SHELL_FLIGHT_TIME });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'shell', sid, from: tuple(_m, 2), target: tuple(_aim, 2), flight: SHELL_FLIGHT_TIME }, 'others');
  return true;
  }

/* ── ShellHost ─────────────────────────────────────────────────────────── */
export function onShellLanded(sys: EnemySystem, sid: number, p: THREE.Vector3): void {
  const ctx = sys.ctx;
  const shooter = _shellOwners.get(sid);
  _shellOwners.delete(sid);
  if (sys.authority) {
    const players = sys.targets.alive;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      const d = t.position.distanceTo(p);
      if (d < SHELL_BLAST_RADIUS + PLAYER_RADIUS) {
        // 2026-09-18 (user's decision): a shell that landed on a roof does not hurt the person below it, and one that hit a wall does not hurt anyone past it
        if (!blastReachesBody(ctx.world, p, t.position.x, t.position.y, t.position.z, PLAYER_HEIGHT)) continue;
        _v.set(p.x, p.y + 0.6, p.z);
        if (sys.barrierBlocks(_v, t)) continue;   // Phase 9: the blast stops at a barrier between the crater and the player
        // 2026-09-15 (user's decision — one formula for every explosive): the shared two-step stair instead of the old linear `× 0.75`.
        //   The 0.25 floor stays — the enemy · drone · vehicle shares of the same blast (`sys.explode` · `applyExplosion` · `damageVehicleAt`) are already on that stair.
        const dmg = SHELL_DAMAGE * Math.max(0.25, explosionFalloff(Math.max(0, d - PLAYER_RADIUS), SHELL_BLAST_RADIUS));
        sys.applyDamage(t, dmg, p, shooter?.id ?? 0, shooter?.type ?? 'artillery', null, 0.9, false);
      }
    }
    // 2026-09-15 (android squadmates): the same formula as the player loop (the distance measured at the feet · floor 0.25). Only a person carries a barrier.
    damageAlliesAt(sys, p, SHELL_BLAST_RADIUS, SHELL_DAMAGE, shooter?.id ?? 0, shooter?.type ?? 'artillery', 0.25, 'feet');
    sys.explode(p, SHELL_BLAST_RADIUS, SHELL_DAMAGE * ENEMY_CLASH.damageMul, 'ai', null, null);   // friendly fire on bugs and rogues alike (2026-09-17: × the enemy → enemy multiplier)
    ctx.drones?.applyExplosion(p, SHELL_BLAST_RADIUS, SHELL_DAMAGE);      // 2026-09-11: drones too (once, on the authority)
    sys.targets.damageVehicleAt(p, SHELL_BLAST_RADIUS, SHELL_DAMAGE, 0.25); // 2026-09-13: the rover (the same falloff floor as the player)
  }
  sys.playAudio('explosion', p, 1, 0.85);
  const dl = sys.targets.distToLocal(p);
  if (dl < 45) ctx.bus.emit('camera:shake', { intensity: 0.9 * (1 - dl / 45), duration: 0.4 });
  ctx.bus.emit('enemy:shellLanded', { sid, position: p.clone(), radius: SHELL_BLAST_RADIUS });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'shellHit', sid, p: tuple(p, 2) }, 'others');
  }

export function onShellIntercepted(sys: EnemySystem, sid: number, p: THREE.Vector3, local: boolean): void {
  const ctx = sys.ctx;
  _shellOwners.delete(sid);
  sys.playAudio('explosion', p, 0.6, 1.4);
  ctx.bus.emit('enemy:shellIntercepted', { sid, position: p.clone() });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'intercept', sid, p: tuple(p, 2) }, 'others');
  else if (sys.replica && local) ctx.net?.send({ t: 'intq', sid, p: tuple(p, 2) }, 'host');
  }

export function acidBurst(sys: EnemySystem, e: Enemy): void {
  const ctx = sys.ctx;
  _v.set(e.position.x, e.position.y + 0.9, e.position.z);
  sys.fx?.burst(_v, 90, 'acid', 7);
  sys.fx?.splat(e.position, SPEWER_SPIT.deathBurstRadius * 0.6, 'acid', ctx.world);
  sys.playAudio('acid_splash', e.position, 1, 0.7);
  if (sys.authority) {
    const players = sys.targets.alive;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      const d = t.position.distanceTo(e.position);
      if (d < SPEWER_SPIT.deathBurstRadius && blastReachesBody(ctx.world, e.position, t.position.x, t.position.y, t.position.z, PLAYER_HEIGHT)) {   // 2026-09-18: wall occlusion
        // 2026-09-15 (user's decision): the shared two-step stair — the old linear `× 0.6` had no floor and was 40 % at the rim.
        const dmg = SPEWER_SPIT.deathBurstDamage * explosionFalloff(d, SPEWER_SPIT.deathBurstRadius);
        sys.applyDamage(t, dmg, e.position, e.id, e.type, { duration: 1.2, factor: 0.7 }, 0, false);
      }
    }
    // 2026-09-15 (android squadmates): the same blast as the player loop. Having no floor is the same too (it only measures as generously as the body radius).
    damageAlliesAt(sys, e.position, SPEWER_SPIT.deathBurstRadius, SPEWER_SPIT.deathBurstDamage, e.id, e.type, 0, 'feet');
    ctx.drones?.applyExplosion(e.position, SPEWER_SPIT.deathBurstRadius, SPEWER_SPIT.deathBurstDamage);   // 2026-09-11
    sys.targets.damageVehicleAt(e.position, SPEWER_SPIT.deathBurstRadius, SPEWER_SPIT.deathBurstDamage, 0.4);   // 2026-09-13
  }
  const local = sys.targets.local();
  if (local && !local.isDead) {
    const d = local.position.distanceTo(e.position);
    if (d < 12) ctx.bus.emit('camera:shake', { intensity: 0.3 * (1 - d / 12), duration: 0.25 });
  }
  }

/** Toxic burst (authority): TOXIC_DAMAGE with falloff to players and enemies of both factions, green FX, event, wire. */
export function toxicBurst(sys: EnemySystem, e: Enemy): void {
  const ctx = sys.ctx;
  _c.copy(e.position);
  sys.toxicFx(_c);
  const players = sys.targets.alive;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    const d = t.position.distanceTo(_c);
    if (d < TOXIC_RADIUS + PLAYER_RADIUS && blastReachesBody(ctx.world, _c, t.position.x, t.position.y, t.position.z, PLAYER_HEIGHT)) {   // 2026-09-18: wall occlusion
      // 2026-09-15 (user's decision): the shared two-step stair. The 0.2 floor stays (it is the same blast as the enemy · drone · vehicle shares).
      const dmg = TOXIC_DAMAGE * Math.max(0.2, explosionFalloff(Math.max(0, d - PLAYER_RADIUS), TOXIC_RADIUS));
      sys.applyDamage(t, dmg, _c, e.id, e.type, { duration: 1.5, factor: 0.65 }, 0.5, false);
    }
  }
  // 2026-09-15 (android squadmates): the same formula as the player loop (feet distance · floor 0.2). No slow.
  damageAlliesAt(sys, _c, TOXIC_RADIUS, TOXIC_DAMAGE, e.id, e.type, 0.2, 'feet');
  sys.explode(_c, TOXIC_RADIUS, TOXIC_DAMAGE * ENEMY_CLASH.damageMul, 'ai', null, e);   // 2026-09-17: the enemy → enemy damage multiplier (the player share stays TOXIC_DAMAGE)
  ctx.drones?.applyExplosion(_c, TOXIC_RADIUS, TOXIC_DAMAGE);   // 2026-09-11: the suicide burst is only called on the authority
  sys.targets.damageVehicleAt(_c, TOXIC_RADIUS, TOXIC_DAMAGE, 0.2);   // 2026-09-13: the rover
  ctx.bus.emit('enemy:toxicBurst', { id: e.id, position: _c.clone(), radius: TOXIC_RADIUS });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'toxic', id: e.id, p: tuple(_c, 2) }, 'others');
  }

export function toxicFx(sys: EnemySystem, p: THREE.Vector3): void {
  const ctx = sys.ctx;
  _v.set(p.x, p.y + 0.6, p.z);
  sys.fx?.burst(_v, 110, 'acid', 8);
  sys.fx?.splat(p, TOXIC_RADIUS * 0.55, 'acid', ctx.world);
  const fx = FxManager.get();
  if (fx) { ParticleBurst.ichor(fx.additive, _v, _zero, 30, 0x9fe64a); ParticleBurst.smoke(fx.alpha, _v, 26, 2.4, 0x3d6a1a); }
  sys.playAudio('acid_splash', p, 1, 0.55);
  const dl = sys.targets.distToLocal(p);
  if (dl < 16) ctx.bus.emit('camera:shake', { intensity: 0.45 * (1 - dl / 16), duration: 0.3 });
  }
