/**
 * src/enemies/ai/named/Heavy.ts — **the Heavy** (`rogue_heavy`, 2026-09-11). A named rogue carrying the unique minigun.
 *
 * ── Host (`updateHeavy`) ───────────────────────────────────────────────────────────────────────────────
 * No cover cycle. It holds `keepMin`–`keepMax` from its target and walks heavily — it closes when far or blind, backs
 * off when too close, and creeps in at `creepMul` on the far side of the band. Visible but with the **muzzle line**
 * blocked (`ai/FireLine`), `fireLineStrafe` steps it aside. With the line open, the state machine (`Enemy.namedPhase`):
 *
 *   ADVANCE(0) ─line + cooldown done→ SPINUP(1, hint 18, `minigun_spinup`, `spinUp` s, movement × `spinMoveMul`)
 *     → line open → FIRE(2, hint 19, `ee spray on`, `burstTime` of spray left)
 *     → no line → LINGER(3, hint 18, spinning empty for `linger` s)
 *   FIRE: on every fire tick (`1 / rof`) `host.fireGun(e, t, spread, 1, { damage, range, fx:false, event:false, wire:false })`.
 *         Turned more than `FIRE_FACING_TOL` off the target, only the barrels spin and nothing fires (the gap to flank it).
 *         The burst over: `ee spray off` + `minigun_spindown` + `burstCooldown` → ADVANCE.
 *         The line broken: `ee spray off` → LINGER.
 *   LINGER: if the line returns inside it, the **remaining spray** resumes at once (`ee spray on` again), else spindown + half the cooldown.
 * Leaving the fight (chase) through a stagger or a lost target cuts the spray where it stands.
 *
 * The wire carries only the two `ee spray` at the start and end of a burst — no `ee shoot` per round. The host-screen
 * FX (one tracer every `TRACER_EVERY` rounds · the muzzle flash · the `minigun_fire` tick) are drawn by this file from
 * the `@/core/fx` pools (flash light intensity 0 — the scene point-light count does not change).
 *
 * ── Replica ──────────────────────────────────────────────────────────────────────────────────────────
 * Once `onHeavyEvent(spray on)` has turned that enemy's spray state on, `afterHeavyReplica` produces the tracers
 * **itself** on the same cadence (the chest of the nearest candidate inside the body's facing cone + `spread`, the yaw
 * forward + head pitch with no candidate) · the flash · the sound. The damage was already sent by the host as `dmg`.
 * A missed `off` still stops on the `burstTime + REMOTE_GRACE` timeout, or once `REMOTE_HINT_MISS` passes with the
 * snapshot hint away from 19. Barrel spin and recoil jitter are drawn identically on both sides by
 * `models/named/HeavyLook` from `Enemy.namedHint`.
 *
 * **Drone targets** (2026-09-11): `pickTarget` may hand it a drone and the Heavy shoots it. It passes no `aimAt`, so the
 * aim point is `CombatTarget.getChest` (the hull centre), which knows about drones; `lookAtTarget` and `hasFireLine`
 * work the same way. It does not back off from a drone (`keepMin` ignored) and plays no flesh-hit sound.
 * A replica's tracers infer the target from the facing (`remoteAimPoint`), so they point at drones and bugs too.
 *
 * The escorting SMG rogues take the existing guard logic (`Enemy.escortOf` → `ai/RogueAI`) — the Heavy does not wait
 * for them, and when the Heavy dies `RogueAI` releases the escorts as ordinary rogues.
 */
import * as THREE from 'three';
import { ROGUE_REACTION, type EnemyEvent, type GameContext } from '@/shared';
import { FxManager } from '@/core/fx';
import type { Enemy, EnemyHost, RogueShotOpts } from '../../Enemy';
import { NAMED_HEAVY } from '../../EnemyTypes';
import type { CombatTarget } from '../../Targets';
import type { ReplicaHost } from '../../net/Replica';
import { lookAtTarget } from '../Common';
import { integrate } from '../EnemyAI';
import { fireLineStrafe, hasFireLine } from '../FireLine';

/* Wire animation hints (`EnemyWire.a`) */
const HINT_SPIN = 18;
const HINT_FIRE = 19;

/* `Enemy.namedPhase` */
const PH_ADVANCE = 0;
const PH_SPINUP = 1;
const PH_FIRE = 2;
const PH_LINGER = 3;

/* ── FX · algorithm constants — not balance numbers, so not csv material (balance is `NAMED_HEAVY`) ── */
/** One tracer every this many rounds. */
const TRACER_EVERY = 2;
/** `minigun_fire` tick interval (s). Shorter than `host.playAudio`'s default throttle (0.12 s), so it goes out on the bus directly. */
const FIRE_AUDIO_TICK = 0.1;
/** Maximum rounds fired in one frame — a frame spike never dumps a burst at once. */
const MAX_SHOTS_PER_FRAME = 3;
/** Turned more than this (rad) off the target, only the barrels spin and nothing fires. */
const FIRE_FACING_TOL = 0.35;
/** Distance to the steering target it backs off to when too close (m). */
const BACKOFF_STEP = 6;
/** Replica: with no `off` after an `ee spray on`, it stops once `burstTime + this` has passed (s). */
const REMOTE_GRACE = 1.5;
/** Replica: while spraying, it stops once this long has passed with the snapshot hint not 19 (s). */
const REMOTE_HINT_MISS = 0.5;
const TRACER_COLOR = 0xffd27a;
const FLASH_COLOR = 0xffc070;
const TWO_PI = Math.PI * 2;

/** `Enemy.namedData` of a `rogue_heavy` — private to this file (host fields and replica fields share one object). */
interface HeavyData {
  kind: 'heavy';
  /** host: seconds of spray left in the current burst (kept through a LINGER so a re-opened line resumes it) */
  burstLeft: number;
  /** host + replica: shots owed by the rof accumulator */
  shotAcc: number;
  /** host + replica: shots fired so far (tracer cadence) */
  shotCount: number;
  /** host + replica: seconds until the next `minigun_fire` tick */
  audioTick: number;
  /** host: an `ee spray on` is out, so an `off` is owed */
  sprayWire: boolean;
  /** replica: spraying per the host's `ee spray` */
  remoteOn: boolean;
  /** replica: safety timeout (s) */
  remoteLeft: number;
  /** replica: seconds the snapshot hint has not been 19 while `remoteOn` */
  remoteHintMiss: number;
  /** replica: last hint seen (spin-up / spin-down audio on the edges) */
  prevHint: number;
}

function heavyData(e: Enemy): HeavyData {
  const d = e.namedData as HeavyData | null;
  if (d && d.kind === 'heavy') return d;
  const n: HeavyData = {
    kind: 'heavy', burstLeft: 0, shotAcc: 0, shotCount: 0, audioTick: 0, sprayWire: false,
    remoteOn: false, remoteLeft: 0, remoteHintMiss: 0, prevHint: 0,
  };
  e.namedData = n;
  return n;
}

const _shotOut = { from: new THREE.Vector3(), to: new THREE.Vector3() };
const _shot: RogueShotOpts = { damage: 0, range: 0, fx: false, event: false, wire: false, out: _shotOut };
const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
const _side = new THREE.Vector3();
const _aimPt = new THREE.Vector3();
const _chest = new THREE.Vector3();

/* ════════════════════════════════════════════════════════════════════════════════════════════════════
 * Host
 * ════════════════════════════════════════════════════════════════════════════════════════════════════ */

export function updateHeavy(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, targetAlive: boolean): void {
  const world = host.ctx.world!;
  const s = e.stats;
  const a = e.anim;
  const d = heavyData(e);
  d.remoteOn = false;   // a promoted host: this AI holds the minigun now (the replica-era spray FX is turned off)
  if (e.namedCooldown > 0) e.namedCooldown -= dt;

  // Nothing to fight → it takes that spot as its new patrol anchor and stands
  if (!targetAlive && e.aware && (e.state === 'chase' || e.state === 'alert')) {
    e.aware = false; e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1.5;
    e.guardPos.copy(e.position);
  }

  let speed = 0;
  let aimT = e.aware ? 0.5 : 0;
  let crouchT = 0;
  let hint = 0;
  e.hasMoveTarget = false;
  e.hasFacePoint = false;

  switch (e.state) {
    case 'idle': {
      e.wanderTimer -= dt;
      a.headYaw = THREE.MathUtils.lerp(a.headYaw, Math.sin(a.time * 0.4) * 0.4, dt * 2);
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0, dt * 3);
      if (e.wanderTimer <= 0) {
        const ang = Math.random() * TWO_PI;
        const rad = 3 + Math.random() * 4;
        e.moveTarget.set(e.guardPos.x + Math.cos(ang) * rad, 0, e.guardPos.z + Math.sin(ang) * rad);
        if (!world.isInsideBounds(e.moveTarget.x, e.moveTarget.z)) e.moveTarget.copy(e.guardPos);
        e.state = 'wander'; e.stateTime = 0;
      }
      break;
    }
    case 'wander': {
      e.hasMoveTarget = true;
      speed = s.wanderSpeed;
      const dx = e.moveTarget.x - e.position.x, dz = e.moveTarget.z - e.position.z;
      if (dx * dx + dz * dz < 0.6 || e.stateTime > 10) { e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 3 + Math.random() * 4; }
      break;
    }
    case 'alert': {
      // The reaction delay: it turns onto the target and raises the minigun
      if (targetAlive) { e.facePoint.copy(t!.position); e.hasFacePoint = true; lookAtTarget(e, t!, dt); }
      aimT = 0.8;
      if (e.stateTime >= ROGUE_REACTION) { e.state = 'chase'; e.stateTime = 0; }
      break;
    }
    case 'chase': {
      if (!targetAlive) { e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1; break; }
      speed = engage(e, d, dt, host, t!);
      aimT = e.namedPhase === PH_ADVANCE ? 0.7 : 1;
      hint = e.namedPhase === PH_FIRE ? HINT_FIRE : e.namedPhase === PH_ADVANCE ? 0 : HINT_SPIN;
      break;
    }
    case 'stagger': {
      e.staggerTimer -= dt;
      if (e.incapTimer > 0) {
        // Incinerated: it writhes with the minigun dropped (anim.writhe)
        e.incapTimer = Math.max(0, e.incapTimer - dt);
        crouchT = 0.35; aimT = 0;
      } else {
        crouchT = 0.35;
        a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.3, dt * 6);
      }
      if (e.staggerTimer <= 0 && e.incapTimer <= 0) {
        e.incapTimer = 0;
        e.state = e.aware && targetAlive ? 'chase' : 'idle';
        e.stateTime = 0; e.wanderTimer = 1;
      }
      break;
    }
    default: break;
  }

  // Leaving the fight (stagger · lost target · patrol) cuts the spray where it stands and spins the barrels down
  if (e.state !== 'chase' && e.namedPhase !== PH_ADVANCE) endBurst(e, d, host, NAMED_HEAVY.burstCooldown * 0.5);

  e.namedHint = hint;   // 0 = `net/HostSync.animHint` falls back to the ordinary rogue hints (stagger 6 and so on)
  a.aim += (aimT - a.aim) * Math.min(1, dt * (aimT > a.aim ? 5 : 3));
  a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 7);
  a.shake = Math.max(0, a.shake - dt * 4);
  integrate(e, dt, world, host, speed, false);
}

/** One tick of the fight while a live target exists: footwork + the spin / fire state machine. Returns the move speed. */
function engage(e: Enemy, d: HeavyData, dt: number, host: EnemyHost, t: CombatTarget): number {
  const s = e.stats;
  const H = NAMED_HEAVY;
  const dist = e.distToTarget;
  lookAtTarget(e, t, dt);
  e.facePoint.copy(t.position); e.hasFacePoint = true;
  // Cheapest first: the eyes (the perception cache) → range → the muzzle line of fire (the `ENEMY_FIRE_LOS_S` cache)
  const line = e.hasLOS && dist <= H.range && hasFireLine(e, host, t);

  /* ── Footwork — it keeps walking with or without a line (a blocked line holds fire only, never movement; FireLine rule 1) ── */
  const mul = e.namedPhase === PH_ADVANCE ? 1 : H.spinMoveMul;
  let speed = 0;
  if (!e.hasLOS || dist > H.keepMax) {
    // Far or out of sight: close in
    e.moveTarget.copy(t.position); e.hasMoveTarget = true;
    speed = s.speed * mul;
  } else if (dist < H.keepMin && !t.isDrone) {
    // Too close: it backs off while facing the target (outside the map it holds). It does not back off from a drone — it sweeps it from where it stands.
    const dx = e.position.x - t.position.x, dz = e.position.z - t.position.z;
    const l = Math.hypot(dx, dz) || 1;
    const mx = e.position.x + (dx / l) * BACKOFF_STEP, mz = e.position.z + (dz / l) * BACKOFF_STEP;
    if (host.ctx.world!.isInsideBounds(mx, mz)) {
      e.moveTarget.set(mx, 0, mz); e.hasMoveTarget = true;
      speed = s.speed * H.creepMul * mul;
    }
  } else if (!line) {
    // Visible but the muzzle is blocked (the target hugs a wall or a rock): it steps aside. At the end of the leg FireLine flips it to the other side.
    fireLineStrafe(e, host, t, dt);
    speed = s.speed * mul;
  } else if (dist > (H.keepMin + H.keepMax) * 0.5) {
    // The far side of the band: it creeps in slowly while firing
    e.moveTarget.copy(t.position); e.hasMoveTarget = true;
    speed = s.speed * H.creepMul * mul;
  }

  /* ── The minigun ── */
  switch (e.namedPhase) {
    case PH_ADVANCE:
      if (line && e.namedCooldown <= 0) {
        e.namedPhase = PH_SPINUP; e.namedTimer = 0;
        d.burstLeft = H.burstTime;
        host.playAudio('minigun_spinup', e.position, 1, 1);
      }
      break;
    case PH_SPINUP:
      // Once the barrels start they spin all the way up — with no line at the end of it, they spin empty
      e.namedTimer += dt;
      if (e.namedTimer >= H.spinUp) {
        if (line) startFire(e, d, host);
        else { e.namedPhase = PH_LINGER; e.namedTimer = H.linger; }
      }
      break;
    case PH_FIRE:
      if (!line) {
        stopWire(e, d, host);
        e.namedPhase = PH_LINGER; e.namedTimer = H.linger; d.shotAcc = 0;
        break;
      }
      d.burstLeft -= dt;
      if (facingError(e, t) <= FIRE_FACING_TOL) fireTick(e, d, host, t, dt);
      if (d.burstLeft <= 0) endBurst(e, d, host, H.burstCooldown);
      break;
    case PH_LINGER:
      e.namedTimer -= dt;
      if (line && d.burstLeft > 0) startFire(e, d, host);
      else if (e.namedTimer <= 0) endBurst(e, d, host, H.burstCooldown * 0.5);
      break;
    default:
      e.namedPhase = PH_ADVANCE;
      break;
  }
  return speed;
}

function startFire(e: Enemy, d: HeavyData, host: EnemyHost): void {
  e.namedPhase = PH_FIRE; e.namedTimer = 0;
  d.shotAcc = 1;       // the first round goes out at once
  d.audioTick = 0;
  if (!d.sprayWire) { d.sprayWire = true; sendSpray(e, host, 1); }
}

function stopWire(e: Enemy, d: HeavyData, host: EnemyHost): void {
  if (!d.sprayWire) return;
  d.sprayWire = false;
  sendSpray(e, host, 0);
}

/** Ends the burst and spins the barrels down (the spindown sound only when they really were spinning). */
function endBurst(e: Enemy, d: HeavyData, host: EnemyHost, cooldown: number): void {
  stopWire(e, d, host);
  if (e.namedPhase !== PH_ADVANCE) host.playAudio('minigun_spindown', e.position, 1, 1);
  e.namedPhase = PH_ADVANCE; e.namedTimer = 0;
  e.namedCooldown = Math.max(e.namedCooldown, cooldown);
  d.burstLeft = 0; d.shotAcc = 0;
}

function sendSpray(e: Enemy, host: EnemyHost, on: 0 | 1): void {
  const ctx = host.ctx;
  if (host.replica || !ctx.isMultiplayer || !ctx.net) return;
  ctx.net.send({ t: 'ee', ev: 'spray', id: e.id, on }, 'others');
}

/** |target direction − body direction| (rad). */
function facingError(e: Enemy, t: CombatTarget): number {
  const want = Math.atan2(t.position.x - e.position.x, t.position.z - e.position.z);
  const rel = want - e.yaw;
  return Math.abs(Math.atan2(Math.sin(rel), Math.cos(rel)));
}

/** This frame's share of the firing (host). Damage · occlusion · barriers · breaking glass are all `fireGun`'s job — this is the cadence and the FX only. */
function fireTick(e: Enemy, d: HeavyData, host: EnemyHost, t: CombatTarget, dt: number): void {
  const H = NAMED_HEAVY;
  d.shotAcc = Math.min(d.shotAcc + dt * H.rof, MAX_SHOTS_PER_FRAME);
  tickFireAudio(host.ctx, e.position, d, dt);
  if (d.shotAcc < 1) return;
  _shot.damage = H.damage;
  _shot.range = H.range;
  const fx = FxManager.get();
  let hit = false;
  while (d.shotAcc >= 1) {
    d.shotAcc -= 1;
    if (host.fireGun(e, t, H.spread, 1, _shot)) hit = true;
    if (fx && d.shotCount % TRACER_EVERY === 0) fx.tracers.add(_shotOut.from, _shotOut.to, TRACER_COLOR, 0.04, 0.06, 0);
    d.shotCount++;
  }
  // One flash per frame (FlashPool is the 6 slots every enemy and weapon shares). Intensity 0 = no light contribution.
  if (fx) fx.flashes.flash(_shotOut.from, FLASH_COLOR, 0, 0.75, 0.04);
  e.anim.recoil = Math.max(e.anim.recoil, 0.6);
  if (hit && !t.isDrone) host.playAudio('hit_flesh', t.position, 0.5, 0.85);
}

/** The `minigun_fire` tick — once per `FIRE_AUDIO_TICK`, not once per round. */
function tickFireAudio(ctx: GameContext, position: THREE.Vector3, d: HeavyData, dt: number): void {
  d.audioTick -= dt;
  if (d.audioTick > 0) return;
  d.audioTick += FIRE_AUDIO_TICK;
  if (d.audioTick <= 0) d.audioTick = FIRE_AUDIO_TICK;
  ctx.bus.emit('audio:play', { id: 'minigun_fire', position, volume: 0.9, pitch: 0.94 + Math.random() * 0.12 });
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════════
 * Replica
 * ════════════════════════════════════════════════════════════════════════════════════════════════════ */

export function beforeHeavyReplica(_e: Enemy, _hint: number): void { /* a ground body — the default snap as it is */ }

/** After the default animation targets were damped: the spin · spray poses, the spin sound edges, and the spray FX `ee spray` turned on. */
export function afterHeavyReplica(e: Enemy, hint: number, dt: number, host: ReplicaHost): void {
  const d = heavyData(e);
  const a = e.anim;
  const spinning = hint === HINT_SPIN || hint === HINT_FIRE;
  const wasSpinning = d.prevHint === HINT_SPIN || d.prevHint === HINT_FIRE;
  d.prevHint = hint;
  if (spinning !== wasSpinning) host.playAudio(spinning ? 'minigun_spinup' : 'minigun_spindown', e.position, 1, 1);

  if (spinning) {
    a.aim += (1 - a.aim) * Math.min(1, dt * 6);
    if (hint === HINT_FIRE) a.recoil = Math.max(a.recoil, 0.45 + Math.random() * 0.2);   // recoil jitter
  }

  if (!d.remoteOn) return;
  d.remoteLeft -= dt;
  d.remoteHintMiss = hint === HINT_FIRE ? 0 : d.remoteHintMiss + dt;
  if (d.remoteLeft <= 0 || d.remoteHintMiss > REMOTE_HINT_MISS) { d.remoteOn = false; d.shotAcc = 0; return; }
  remoteSpray(e, d, host, dt);
}

/**
 * A replica **infers the Heavy's target from its facing** (C-50) — the wire carries only `ee spray {on}`, so who it is
 * shooting is unknown. Of the candidates within `FIRE_FACING_TOL` of the body direction (`e.yaw`, from the snapshot;
 * = the cone the host really pulls the trigger in) and within `range`, the nearest one — players (`targets.alive`) ∪
 * drones enemies go for (`targets.drones`) ∪ enemies of the opposite faction. Found, its chest (`getChest`, height ×
 * 0.6 for an enemy = the same formula) is written into `out` and true is returned. It used to guess the height from the
 * head pitch (toward the nearest **player**), which sent the tracers into thin air when it shot a drone or a bug.
 */
function remoteAimPoint(e: Enemy, host: ReplicaHost, out: THREE.Vector3): boolean {
  aim.px = e.position.x; aim.pz = e.position.z;
  aim.fx = Math.sin(e.yaw); aim.fz = Math.cos(e.yaw);
  aim.best = NAMED_HEAVY.range * NAMED_HEAVY.range;
  aim.found = false;
  aim.out = out;
  const targets = host.targets;
  considerTargets(targets.alive);
  considerTargets(targets.allies);      // 2026-09-15: android squadmates (the same chest height as a person — `getChest`)
  considerTargets(targets.drones);
  considerTargets(targets.vehicles);   // 2026-09-13: the rover (a replica's proxy is refreshed from `ctx.world.rover` too)
  const active = host.active;
  for (let i = 0; i < active.length; i++) {
    const o = active[i];
    if (o === e || o.faction === e.faction || !o.isCombatant) continue;
    considerAim(o.position.x, o.position.y + o.stats.height * 0.6, o.position.z);
  }
  aim.out = null;
  return aim.found;
}

/* `remoteAimPoint`'s scratch — it runs every frame while spraying, so no closure and no array is created. */
const COS_FIRE_TOL = Math.cos(FIRE_FACING_TOL);
const aim = { px: 0, pz: 0, fx: 0, fz: 1, best: 0, found: false, out: null as THREE.Vector3 | null };

function considerTargets(list: readonly CombatTarget[]): void {
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t.present || t.isDeadOrDowned) continue;
    t.getChest(_chest);
    considerAim(_chest.x, _chest.y, _chest.z);
  }
}

function considerAim(x: number, y: number, z: number): void {
  const dx = x - aim.px, dz = z - aim.pz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= aim.best || d2 < 1e-4) return;
  if (dx * aim.fx + dz * aim.fz < COS_FIRE_TOL * Math.sqrt(d2)) return;   // outside the cone (behind included)
  aim.best = d2; aim.found = true;
  aim.out!.set(x, y, z);
}

/**
 * The replica's spray FX — the same cadence as the host (`rof`, `TRACER_EVERY`). The direction is muzzle → the
 * inferred target's chest (`remoteAimPoint`) + `spread`, falling back to the enemy's yaw forward + head pitch with no
 * candidate.
 */
function remoteSpray(e: Enemy, d: HeavyData, host: ReplicaHost, dt: number): void {
  const H = NAMED_HEAVY;
  d.shotAcc = Math.min(d.shotAcc + dt * H.rof, MAX_SHOTS_PER_FRAME);
  tickFireAudio(host.ctx, e.position, d, dt);
  if (d.shotAcc < 1) return;
  const fx = FxManager.get();
  const world = host.ctx.world;
  e.muzzle(_from);
  const aimed = !!fx && !!world && remoteAimPoint(e, host, _aimPt);
  while (d.shotAcc >= 1) {
    d.shotAcc -= 1;
    const tracer = d.shotCount % TRACER_EVERY === 0;
    d.shotCount++;
    if (!tracer || !fx || !world) continue;
    if (aimed && _dir.subVectors(_aimPt, _from).lengthSq() > 1e-4) _dir.normalize();
    // No candidate: a replica looks at the nearest player too (`lookAtTarget`), so the head pitch is the aim height: pitch = −atan(dy / dist)
    else _dir.set(Math.sin(e.yaw), Math.tan(THREE.MathUtils.clamp(-e.anim.headPitch, -0.6, 0.6)), Math.cos(e.yaw)).normalize();
    // The same triangular-distribution spread as `parts/Attacks.fireGun`
    const ey = (Math.random() + Math.random() - 1) * H.spread;
    const ep = (Math.random() + Math.random() - 1) * H.spread * 0.7;
    _side.set(-_dir.z, 0, _dir.x).normalize();
    _dir.addScaledVector(_side, ey);
    _dir.y += ep;
    _dir.normalize();
    const wh = world.raycast(_from, _dir, H.range);
    _to.copy(_from).addScaledVector(_dir, wh ? wh.distance : H.range);
    fx.tracers.add(_from, _to, TRACER_COLOR, 0.04, 0.06, 0);
  }
  if (fx) fx.flashes.flash(_from, FLASH_COLOR, 0, 0.75, 0.04);
}

/** `ee spray {id, on}` — turns the FX state on and off only (it changes no game state). */
export function onHeavyEvent(host: ReplicaHost, msg: Extract<EnemyEvent, { ev: 'spray' }>): void {
  const e = host.find(msg.id);
  if (!e || !e.active || e.state === 'dead' || e.type !== 'rogue_heavy') return;
  const d = heavyData(e);
  if (msg.on === 1) {
    if (!d.remoteOn) { d.shotAcc = 1; d.audioTick = 0; }
    d.remoteOn = true;
    d.remoteLeft = NAMED_HEAVY.burstTime + REMOTE_GRACE;
    d.remoteHintMiss = 0;
  } else {
    d.remoteOn = false;
    d.shotAcc = 0;
  }
}
