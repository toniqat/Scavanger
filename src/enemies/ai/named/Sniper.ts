/**
 * src/enemies/ai/named/Sniper.ts — **Roden** (`rogue_sniper`, 2026-09-11).
 *
 * A sniper who puts an anti-materiel rifle on a player's head across wide open ground. **No shot comes without a
 * telegraph** — every shot goes out only after a scope glint lasting `NAMED_SNIPER.glintTime` (hint 15 ·
 * `named:sniperGlint` · `ee glint`). Break the line during the glint (take cover) and the round buries itself in the
 * cover — the world raycast in `fireGun` stops it exactly as it always does.
 *
 * States (`Enemy.namedData` = `SniperData`, created on the first tick — on the host only):
 *  - **Prone** (hint 14) — lies at its nest (`guardPos`) and sweeps slowly through the scope. `e.aware` is always true,
 *    so shot tracking (`ai/Investigate`) or a lost sight line never drags it off the nest.
 *  - **Near mode** — of the living players within `detectRange` (× the stealth factor), the nearest one whose
 *    **prone eye height → head** line is open. Once the body has turned onto it and `fireCooldown` has run out,
 *    glint → fire. Accuracy is linear with distance, `nearAccuracyMax` → `nearAccuracyMin`.
 *  - **Far mode** — with a player outside `detectRange` but inside `droneRange`, `launchScanDrone` puts a scan drone
 *    up. Once the drone is `done`, it shoots the nearest target with `exposure ≥ exposeNeeded` and an open line, at
 *    `scannedAccuracy`. If no line opens within `scanWait` it gives up. A drone that goes down before `done` costs
 *    `droneRetry`, a shot at a scanned target costs `droneCooldown`. Either way the drone's id is left in
 *    `SniperData.resolvedDroneId` (the signal for the drone to clear the exposure display and fly home).
 *  - **Relocating** (hint 0 = it stands up and runs) — once it is hit, or a player comes within `closeThreat`, it moves
 *    6–10 m sideways away from the threat, once per `relocateCooldown` (never further from the nest than `nestLeash`).
 *    It does not move during a glint — a shot that was telegraphed is seen through. C-62: with the muzzle brake buried
 *    (`muzzleBuried`) the moment a glint would start, it takes the same relocation with no telegraph — picking the
 *    candidate whose muzzle is clear toward the target (`buriedBeforeGlint`).
 *  - Stagger · incineration — hint 0 for the ordinary rogue poses (crouch · writhe), and the glint is cancelled.
 *
 * **It shoots players only** (the lead's decision): `t` (= `pickTarget`'s answer, which may be a bug or a drone) is
 * unused; it picks from `host.targets.alive` itself. Drone proxies (`isDrone`) and enemy proxies (`enemy`) get neither
 * a glint nor the 150 damage.
 *
 * The FX (tracer · flash · the distant report) are one `named/SniperShot` that the host and replicas both call. The
 * glint sprite and the prone pose are drawn by `models/named/SniperLook` from `e.namedHint`.
 */
import * as THREE from 'three';
import type { EnemyEvent, PeerId, WorldRef } from '@/shared';
import type { Enemy, EnemyHost, RogueShotOpts } from '../../Enemy';
import { NAMED_SCAN_DRONE, NAMED_SNIPER } from '../../EnemyTypes';
import type { CombatTarget } from '../../Targets';
import type { ReplicaHost } from '../../net/Replica';
import { round, tuple } from '../../net/HostSync';
import { clearSniperGlint, holdSniperGlint } from '../../models/named/SniperLook';
import { sniperGlintFx, sniperShotFx, type SniperFxHost } from '../../named/SniperShot';
import { lookAtTarget } from '../Common';
import { integrate } from '../EnemyAI';
import { visionClarity } from '../Perception';
import { turnToward, yawTo } from '../Steering';
import { launchScanDrone } from './ScanDrone';
import { scanDroneDataOf, sniperDataOf, type ScanDroneData, type SniperData } from './model';

/* ── Wire hints (`EnemyWire.a`) ── */
const HINT_PRONE = 14;
const HINT_GLINT = 15;

/* ── Algorithm · look constants (the balance numbers are NAMED_SNIPER) ── */
/** Target picking (line-of-fire raycast) interval, s. */
const PICK_INTERVAL_S = 0.3;
/** No glint starts until the prone pose has settled (s). */
const PRONE_SETTLE_S = 0.7;
/** The body must face the target within this angle (rad) before a glint starts. */
const FACE_TOL = 0.12;
/**
 * Origin of the line-of-fire check: height above the feet · distance forward toward the target (m). C-56 (2026-09-11):
 * the forward distance is **at or below the body radius (0.4)** — the old 0.9 m sat outside the prone body, so the ray
 * started **inside** the mound or rock right in front and never saw the block (a world ray whose origin is inside an
 * obstacle reports no hit). Starting inside the body catches everything between the body and the target.
 */
const EYE_UP = 0.32;
const EYE_FWD = 0.3;
/** The body → muzzle check just before firing: the flash bursts this far back toward the body from the blocked point (m). */
const MUZZLE_BURY_BACK = 0.12;
/** The same smoke threshold as `ai/Perception` — at or below this clarity the line counts as blocked. */
const SMOKE_BLIND = 0.4;
/** From the target's eye height up to the centre of the head (m). */
const HEAD_ABOVE_EYE = 0.06;
/** How far beside the head a shot is thrown when the accuracy roll misses (m, the user specified 1–2 m). */
const MISS_MIN_M = 1;
const MISS_MAX_M = 2;
/** Relocating: distance moved at a time (m) · maximum running time (s). */
const RELOCATE_MIN_M = 6;
const RELOCATE_MAX_M = 10;
const RELOCATE_MAX_S = 4.5;
/** C-62: candidates looked at when relocating because of a buried muzzle — the two sides × (random · maximum · minimum distance). */
const RELOCATE_TRIES = 6;
/** Minimum s to the next glint once one was cancelled (the target went down · disappeared). */
const CANCEL_COOLDOWN_S = 1.2;
/** Retry this long after a drone could not be launched (s). */
const LAUNCH_RETRY_S = 3;
/** The phase numbers in `ScanDrone.ts` — a drone at or past this one (flying home · escaping) is not adopted. */
const DRONE_PHASE_RETURN = 2;
/** The safety net for a drone that never answers: s added to `loiterMax`. */
const DRONE_TIMEOUT_PAD_S = 20;
/** Width (rad) · speed (rad/s) of the scope sweep with nothing to do. */
const WATCH_SWEEP = 0.5;
const WATCH_SPEED = 0.23;

const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _head = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _body = new THREE.Vector3();
const _cand = new THREE.Vector3();
const _shot = { from: new THREE.Vector3(), to: new THREE.Vector3() };
const SHOT_OPTS: RogueShotOpts = { aimAt: _aim, fx: false, wire: false, out: _shot };

function createData(e: Enemy): SniperData {
  return {
    kind: 'sniper',
    droneId: null,
    droneCooldown: LAUNCH_RETRY_S,
    fireCooldown: PRONE_SETTLE_S,
    aimTargetId: null,
    glintLeft: 0,
    aimScanned: false,
    resolvedDroneId: null,
    scanWait: -1,
    droneAge: 0,
    lastHp: e.hp,
    relocate: 0,
    relocateCd: 0,
    proneTime: 0,
    pickId: null,
    pickScanned: false,
    pickAt: 0,
    watchYaw: e.yaw,
  };
}

/** What Roden may shoot = a living **player** (drone and enemy proxies excluded). */
function isPlayerTarget(t: CombatTarget): boolean {
  return t.present && !t.isDeadOrDowned && t.enemy === null && !t.isDrone && !t.isVehicle;
}

function hosting(host: EnemyHost): boolean {
  const ctx = host.ctx;
  return !host.replica && ctx.isMultiplayer && ctx.isAuthority && !!ctx.net;
}

function peerOf(host: EnemyHost, t: CombatTarget): PeerId | null {
  if (t.isLocal) return host.ctx.net?.localId ?? null;
  return t.id === 'ai' ? null : (t.id as PeerId);
}

function findEnemy(host: EnemyHost, id: number): Enemy | null {
  const list = host.active;
  for (let i = 0; i < list.length; i++) if (list[i].id === id && list[i].active) return list[i];
  return null;
}

function angleDiff(a: number, b: number): number {
  const d = b - a;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

function headOf(t: CombatTarget, out: THREE.Vector3): THREE.Vector3 {
  return out.set(t.position.x, t.position.y + t.eyeHeight + HEAD_ABOVE_EYE, t.position.z);
}

function nearestPlayer(host: EnemyHost, p: THREE.Vector3): CombatTarget | null {
  const list = host.targets.alive;
  let best: CombatTarget | null = null;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!isPlayerTarget(t)) continue;
    const d = t.dist2D(p);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/**
 * The prone eye height → target head line. Regardless of the body's facing, it starts at the scope position `EYE_FWD`
 * ahead **toward the target** — the rig's muzzle (where it currently points) is not used, because a target it has not
 * turned onto yet must still be pickable. That position is inside Roden's body (an enemy is not a world obstacle), so
 * the effect is the same as `ai/FireLine`'s "start behind the muzzle" convention. Smoke blocks it too.
 */
function lineOpen(e: Enemy, host: EnemyHost, t: CombatTarget, head: THREE.Vector3): boolean {
  const world = host.ctx.world;
  if (!world) return false;
  const dx = head.x - e.position.x, dz = head.z - e.position.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) return true;
  _eye.set(e.position.x + (dx / l) * EYE_FWD, e.position.y + EYE_UP, e.position.z + (dz / l) * EYE_FWD);
  _dir.subVectors(head, _eye);
  const dist = _dir.length();
  if (dist < 0.5) return true;
  _dir.multiplyScalar(1 / dist);
  if (world.raycast(_eye, _dir, dist - 0.35) !== null) return false;
  return visionClarity(e, host, t) > SMOKE_BLIND;
}

/** The data of the current drone if it has finished scanning (otherwise null). */
function finishedScan(e: Enemy, d: SniperData, host: EnemyHost): ScanDroneData | null {
  if (d.droneId === null) return null;
  const drone = findEnemy(host, d.droneId);
  const sd = drone ? scanDroneDataOf(drone) : null;
  return sd && sd.done && sd.sniperId === e.id ? sd : null;
}

function resolveDrone(d: SniperData, cooldown: number): void {
  d.resolvedDroneId = d.droneId;
  d.droneId = null;
  d.droneCooldown = cooldown;
  d.scanWait = -1;
  d.droneAge = 0;
}

/**
 * Adopting an ownerless scan drone (C-49): for a drone that came over on host promotion, `ScanDrone.ts` writes the
 * nearest Roden as its `sniperId` and gives it fresh data. That Roden (promoted too, its `SniperData` just created) has
 * `droneId === null`, so it picks the drone up here. Only a drone no Roden has claimed yet (`!claimed`) — one just
 * released (`resolvedDroneId`) or on its way home is not grabbed back.
 */
function adoptDrone(e: Enemy, d: SniperData, host: EnemyHost): void {
  const list = host.active;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o.type !== 'rogue_scan_drone' || !o.active || o.state === 'dead' || o.state === 'flee' || o.id === d.resolvedDroneId) continue;
    const sd = scanDroneDataOf(o);
    if (!sd || sd.sniperId !== e.id || sd.claimed || o.namedPhase >= DRONE_PHASE_RETURN) continue;
    d.droneId = o.id;
    d.droneAge = 0;
    d.scanWait = -1;
    return;
  }
}

/** Drone lifetime bookkeeping: scan finished → the window waiting for a line; lost or intercepted before it finished → `droneRetry`. */
function trackDrone(e: Enemy, d: SniperData, host: EnemyHost, dt: number): void {
  if (d.droneId === null) adoptDrone(e, d, host);
  if (d.droneId === null) return;
  if (d.glintLeft > 0 && d.aimScanned) return;          // glinting at a scanned target — the shot settles it
  d.droneAge += dt;
  const drone = findEnemy(host, d.droneId);
  const sd = drone ? scanDroneDataOf(drone) : null;
  const mine = !!sd && sd.sniperId === e.id;
  if (mine && sd!.done) {
    if (d.scanWait < 0) d.scanWait = NAMED_SNIPER.scanWait;
    d.scanWait -= dt;
    if (d.scanWait <= 0) resolveDrone(d, NAMED_SNIPER.droneRetry);   // the line never opened — give up
    return;
  }
  const lost = !mine || drone!.state === 'dead' || drone!.state === 'flee'
    || d.droneAge > NAMED_SCAN_DRONE.loiterMax + DRONE_TIMEOUT_PAD_S;
  if (lost) resolveDrone(d, NAMED_SNIPER.droneRetry);    // intercepted or lost before the scan finished
}

/** Picks the target to shoot — near mode first (detection range · line), else a scanned target (exposure · range · line). The nearest one. */
function pick(e: Enemy, d: SniperData, host: EnemyHost): void {
  d.pickId = null;
  d.pickScanned = false;
  const scan = finishedScan(e, d, host);
  const need = NAMED_SNIPER.exposeNeeded;
  const list = host.targets.alive;
  let best: CombatTarget | null = null;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!isPlayerTarget(t)) continue;
    const dist = t.dist2D(e.position);
    const stealth = t.stealth > 0 && t.stealth <= 1 ? t.stealth : 1;
    if (dist > NAMED_SNIPER.detectRange * stealth || dist >= bestD) continue;
    if (!lineOpen(e, host, t, headOf(t, _head))) continue;
    best = t; bestD = dist;
  }
  if (best) {
    d.pickId = best.id;
    d.pickScanned = !!scan && (scan.exposure.get(best.id) ?? 0) >= need;
    return;
  }
  if (!scan) return;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!isPlayerTarget(t) || (scan.exposure.get(t.id) ?? 0) < need) continue;
    const dist = t.dist2D(e.position);
    if (dist > NAMED_SNIPER.range || dist >= bestD) continue;
    if (!lineOpen(e, host, t, headOf(t, _head))) continue;
    best = t; bestD = dist;
  }
  if (best) { d.pickId = best.id; d.pickScanned = true; }
}

function cancelGlint(d: SniperData): void {
  d.glintLeft = 0;
  d.aimTargetId = null;
  d.aimScanned = false;
  d.fireCooldown = Math.max(d.fireCooldown, CANCEL_COOLDOWN_S);
  d.pickAt = 0;
}

/** Starts the scope glint — the telegraph. A local host event + sound, plus `ee glint` in multiplayer. */
function startGlint(e: Enemy, d: SniperData, host: EnemyHost, t: CombatTarget, scanned: boolean): void {
  const ctx = host.ctx;
  const dur = NAMED_SNIPER.glintTime;
  d.aimTargetId = t.id;
  d.glintLeft = dur;
  d.aimScanned = scanned;
  ctx.bus.emit('named:sniperGlint', { enemyId: e.id, position: e.position, targetLocal: t.isLocal, duration: dur });
  sniperGlintFx(host, e.position, t.isLocal);
  if (hosting(host)) ctx.net!.send({ t: 'ee', ev: 'glint', id: e.id, dur: round(dur, 2), target: peerOf(host, t) }, 'others');
}

/** The glint ended — one shot. The accuracy roll sends `fireGun` at the head or 1–2 m beside it (damage and occlusion are the host's judgement). */
function fire(e: Enemy, d: SniperData, host: EnemyHost, t: CombatTarget): void {
  const dist = t.dist2D(e.position);
  let acc = THREE.MathUtils.lerp(NAMED_SNIPER.nearAccuracyMax, NAMED_SNIPER.nearAccuracyMin,
    THREE.MathUtils.clamp(dist / Math.max(1, NAMED_SNIPER.detectRange), 0, 1));
  if (d.aimScanned) acc = Math.max(acc, NAMED_SNIPER.scannedAccuracy);
  const hitRoll = Math.random() < acc;
  headOf(t, _aim);
  if (!hitRoll) {
    // A miss: thrown 1–2 m beside the head (the round only reaches the world — the crack going past and the dust are the second warning)
    const dx = _aim.x - e.position.x, dz = _aim.z - e.position.z;
    const l = Math.hypot(dx, dz) || 1;
    const side = Math.random() < 0.5 ? -1 : 1;
    const off = MISS_MIN_M + Math.random() * (MISS_MAX_M - MISS_MIN_M);
    _aim.x += (-dz / l) * side * off;
    _aim.z += (dx / l) * side * off;
    _aim.y += (Math.random() - 0.35) * 0.6;
  }
  SHOT_OPTS.damage = NAMED_SNIPER.damage;
  SHOT_OPTS.range = NAMED_SNIPER.range;
  // C-56: turning during the glint, the long barrel (muzzle ≈ 2.3 m ahead of the body) may have buried itself in a rock
  // or a mound. `fireGun` casts its world ray from the muzzle, so left alone the round would pass through the rock — if
  // the body → muzzle segment is blocked, it **lands at that point**. A telegraphed shot is still fired (sound · flash ·
  // `ee snipe hit:false` · cooldown) — it does not relocate. Since C-62 the same check also runs **before** the glint
  // starts (`buriedBeforeGlint`), so what reaches here is only a muzzle buried while turning during the glint.
  const buried = muzzleBuried(e, host, _shot.from, _shot.to);
  const struck = buried ? false : host.fireGun(e, t, 0, 1, SHOT_OPTS);
  if (buried) host.ctx.bus.emit('enemy:shot', { id: e.id, type: e.type, from: _shot.from.clone(), to: _shot.to.clone(), hit: false });
  e.anim.recoil = 1;
  sniperShotFx(host, _shot.from, _shot.to, struck);
  if (hosting(host)) {
    host.ctx.net!.send({ t: 'ee', ev: 'snipe', id: e.id, from: tuple(_shot.from, 2), to: tuple(_shot.to, 2), hit: struck, target: peerOf(host, t) }, 'others');
  }
  d.glintLeft = 0;
  d.aimTargetId = null;
  d.fireCooldown = NAMED_SNIPER.fireInterval;
  d.pickAt = 0;
  if (d.aimScanned && d.droneId !== null) resolveDrone(d, NAMED_SNIPER.droneCooldown);
  d.aimScanned = false;
}

/**
 * With a world obstacle on the body centre (feet + `EYE_UP`) → rig muzzle segment, returns true and fills `from` ·
 * `to` with that blocked point (the flash `MUZZLE_BURY_BACK` back toward the body) (C-56). An enemy is not a world
 * obstacle, so its own body never catches.
 */
function muzzleBuried(e: Enemy, host: EnemyHost, from: THREE.Vector3, to: THREE.Vector3): boolean {
  const world = host.ctx.world;
  if (!world) return false;
  e.muzzle(_muzzle);
  _body.set(e.position.x, e.position.y + EYE_UP, e.position.z);
  _dir.subVectors(_muzzle, _body);
  const len = _dir.length();
  if (len < 1e-3) return false;
  _dir.multiplyScalar(1 / len);
  const hit = world.raycast(_body, _dir, len);
  if (!hit) return false;
  const d = Math.max(0, hit.distance);
  to.copy(_body).addScaledVector(_dir, d);
  from.copy(_body).addScaledVector(_dir, Math.max(0, d - MUZZLE_BURY_BACK));
  return true;
}

/** A scan drone at the nearest player outside the detection range and inside the drone range. */
function maybeLaunchDrone(e: Enemy, d: SniperData, host: EnemyHost): void {
  if (d.droneId !== null || d.droneCooldown > 0 || d.proneTime < PRONE_SETTLE_S) return;
  const list = host.targets.alive;
  let best: CombatTarget | null = null;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!isPlayerTarget(t)) continue;
    const dist = t.dist2D(e.position);
    if (dist <= NAMED_SNIPER.detectRange || dist > NAMED_SNIPER.droneRange || dist >= bestD) continue;
    best = t; bestD = dist;
  }
  if (!best) return;
  const drone = launchScanDrone(host, e, best);
  if (drone) {
    d.droneId = drone.id;
    d.droneAge = 0;
    d.scanWait = -1;
    d.watchYaw = yawTo(e.position, best.position);
  } else d.droneCooldown = LAUNCH_RETRY_S;
}

/**
 * A muzzle buried right before a glint (C-62): no telegraph goes out. It does not aim again for `CANCEL_COOLDOWN_S`,
 * and once the relocation cooldown has run out it moves to **a spot whose muzzle is clear toward the target** (the
 * candidate check in `startRelocate`). Still on cooldown, it waits where it is — the target moving clear or the cooldown
 * ending makes it judge again, so buried → wait → buried on the same spot never exceeds `relocateCooldown`. The prone
 * muzzle's horizontal reach and rise are read from the `_body` · `_muzzle` that `muzzleBuried` just filled.
 */
function buriedBeforeGlint(e: Enemy, d: SniperData, host: EnemyHost, t: CombatTarget): void {
  d.fireCooldown = Math.max(d.fireCooldown, CANCEL_COOLDOWN_S);
  if (d.relocate > 0 || d.relocateCd > 0) return;
  const reach = Math.hypot(_muzzle.x - _body.x, _muzzle.z - _body.z);
  startRelocate(e, d, host, t.position, reach, _muzzle.y - _body.y);
}

/** true when, lying prone at `(px, pz)`, the body centre → muzzle segment (horizontal `reach` toward `aim` · height `rise`) is not blocked by the world (C-62). */
function muzzleClearAt(world: WorldRef, px: number, pz: number, aim: THREE.Vector3, reach: number, rise: number): boolean {
  const dx = aim.x - px, dz = aim.z - pz;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) return true;
  _cand.set(px, world.getSurfaceY(px, pz, world.getHeightAt(px, pz)) + EYE_UP, pz);
  _dir.set((dx / l) * reach, rise, (dz / l) * reach);
  const len = _dir.length();
  if (len < 1e-3) return true;
  _dir.multiplyScalar(1 / len);
  return world.raycast(_cand, _dir, len) === null;
}

/**
 * Moves a short way sideways, away from the threat (inside the nest leash). The destination is `Enemy.coverPos` (Roden
 * does not use the cover cycle). C-62: with `muzzleReach > 0` it walks the two sides × three distances
 * (`RELOCATE_TRIES`) in order and takes the first spot whose muzzle is clear toward `from` (`muzzleClearAt`) — it never
 * picks a blocked spot again. With no clear spot, the first candidate as before. Without a `muzzleReach` (hit · a close
 * threat) it is not one bit different from before (down to the order of the random calls).
 */
function startRelocate(e: Enemy, d: SniperData, host: EnemyHost, from: THREE.Vector3 | null, muzzleReach = 0, muzzleRise = 0): void {
  const world = host.ctx.world!;
  let ax: number, az: number;
  const fl = from ? Math.hypot(e.position.x - from.x, e.position.z - from.z) : 0;
  if (from && fl > 1e-3) { ax = (e.position.x - from.x) / fl; az = (e.position.z - from.z) / fl; }
  else { const ang = Math.random() * Math.PI * 2; ax = Math.cos(ang); az = Math.sin(ang); }
  const side0 = Math.random() < 0.5 ? -1 : 1;
  const step0 = RELOCATE_MIN_M + Math.random() * (RELOCATE_MAX_M - RELOCATE_MIN_M);
  const tries = from && muzzleReach > 0 ? RELOCATE_TRIES : 1;
  const leash = NAMED_SNIPER.nestLeash;
  for (let k = 0; k < tries; k++) {
    const side = k % 2 === 0 ? side0 : -side0;
    const step = k < 2 ? step0 : k < 4 ? RELOCATE_MAX_M : RELOCATE_MIN_M;
    let dx = ax * 0.55 - az * side * 0.85;
    let dz = az * 0.55 + ax * side * 0.85;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    let px = e.position.x + dx * step;
    let pz = e.position.z + dz * step;
    const gx = px - e.guardPos.x, gz = pz - e.guardPos.z;
    const gl = Math.hypot(gx, gz);
    if (gl > leash) { px = e.guardPos.x + (gx / gl) * leash; pz = e.guardPos.z + (gz / gl) * leash; }
    if (!world.isInsideBounds(px, pz)) { px = e.guardPos.x; pz = e.guardPos.z; }
    if (k === 0) e.coverPos.set(px, 0, pz);               // the answer when no spot is clear = the one old candidate
    if (tries > 1 && muzzleClearAt(world, px, pz, from!, muzzleReach, muzzleRise)) { e.coverPos.set(px, 0, pz); break; }
  }
  e.hasCover = true;
  d.relocate = RELOCATE_MAX_S;
  d.relocateCd = NAMED_SNIPER.relocateCooldown;
  d.proneTime = 0;
  d.pickId = null;
  d.pickAt = 0;
}

export function updateSniper(e: Enemy, dt: number, host: EnemyHost, _t: CombatTarget | null, _targetAlive: boolean): void {
  const world = host.ctx.world;
  if (!world) return;
  const s = e.stats;
  const a = e.anim;
  let d = sniperDataOf(e);
  if (!d) { d = createData(e); e.namedData = d; }

  e.aware = true;   // always alert — see the header
  if (d.droneCooldown > 0) d.droneCooldown -= dt;
  if (d.fireCooldown > 0) d.fireCooldown -= dt;
  if (d.relocateCd > 0) d.relocateCd -= dt;
  const hurt = e.hp < d.lastHp - 0.01;
  d.lastHp = e.hp;
  trackDrone(e, d, host, dt);

  e.hasMoveTarget = false;
  e.hasFacePoint = false;
  let speed = 0;
  let aimT = 0.7;
  let crouchT = 0;
  let hint = HINT_PRONE;
  let wantYaw: number | null = null;

  if (e.state === 'stagger') {
    // Stagger · incineration: the ordinary rogue poses (hint 0), the glint is cancelled
    if (d.glintLeft > 0) cancelGlint(d);
    d.relocate = 0;
    d.proneTime = 0;
    hint = 0;
    e.staggerTimer -= dt;
    if (e.incapTimer > 0) { e.incapTimer = Math.max(0, e.incapTimer - dt); crouchT = 0.35; aimT = 0; }
    else { crouchT = 0.5; a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.3, dt * 6); }
    if (e.staggerTimer <= 0 && e.incapTimer <= 0) { e.incapTimer = 0; e.state = 'chase'; e.stateTime = 0; }
  } else {
    if (e.state !== 'chase' && e.state !== 'idle') { e.state = 'idle'; e.stateTime = 0; }   // alert · wander → Roden's two states
    const threat = nearestPlayer(host, e.position);
    const threatD = threat ? threat.dist2D(e.position) : Infinity;

    if (d.glintLeft <= 0 && d.relocate <= 0 && d.relocateCd <= 0 && (hurt || threatD < NAMED_SNIPER.closeThreat)) {
      startRelocate(e, d, host, threat && threatD <= NAMED_SNIPER.droneRange ? threat.position : null);
    }

    if (d.relocate > 0) {
      // Relocating: it stands up and runs (hint 0 — a replica walks the default rogue walk)
      d.relocate -= dt;
      hint = 0; speed = s.speed; aimT = 0.3;
      e.state = 'chase';
      e.moveTarget.copy(e.coverPos); e.hasMoveTarget = true;
      const dx = e.coverPos.x - e.position.x, dz = e.coverPos.z - e.position.z;
      if (dx * dx + dz * dz < 0.8 || d.relocate <= 0) {
        d.relocate = 0;
        d.proneTime = 0;
        if (threat) d.watchYaw = yawTo(e.position, threat.position);
      }
    } else {
      d.proneTime += dt;
      if (d.glintLeft > 0) {
        // During the glint: it keeps turning onto the target and fires when the glint ends
        e.state = 'chase';
        const tgt = d.aimTargetId !== null ? host.targets.get(d.aimTargetId) : undefined;
        if (!tgt || !isPlayerTarget(tgt)) cancelGlint(d);
        else {
          wantYaw = yawTo(e.position, tgt.position);
          lookAtTarget(e, tgt, dt);
          hint = HINT_GLINT; aimT = 1;
          d.glintLeft -= dt;
          if (d.glintLeft <= 0) { fire(e, d, host, tgt); hint = HINT_PRONE; }
        }
      } else {
        d.pickAt -= dt;
        if (d.pickAt <= 0) { d.pickAt = PICK_INTERVAL_S; pick(e, d, host); }
        const tgt = d.pickId !== null ? host.targets.get(d.pickId) : undefined;
        if (tgt && isPlayerTarget(tgt)) {
          e.state = 'chase';
          wantYaw = yawTo(e.position, tgt.position);
          d.watchYaw = wantYaw;
          lookAtTarget(e, tgt, dt);
          aimT = 0.9;
          if (d.fireCooldown <= 0 && d.proneTime >= PRONE_SETTLE_S && Math.abs(angleDiff(e.yaw, wantYaw)) < FACE_TOL) {
            // C-62: the buried muzzle brake is checked **before** the telegraph goes out — on a blocked spot it relocates instead of glinting
            if (muzzleBuried(e, host, _shot.from, _shot.to)) buriedBeforeGlint(e, d, host, tgt);
            else {
              startGlint(e, d, host, tgt, d.pickScanned);
              hint = HINT_GLINT; aimT = 1;
            }
          }
        } else {
          // Nothing to shoot: it sweeps the scope slowly around the nearest player (inside the drone range)
          if (threat && threatD <= NAMED_SNIPER.droneRange) { d.watchYaw = yawTo(e.position, threat.position); e.state = 'chase'; }
          else e.state = 'idle';
          wantYaw = d.watchYaw + Math.sin(a.time * WATCH_SPEED + e.id) * WATCH_SWEEP;
          a.headYaw = THREE.MathUtils.lerp(a.headYaw, Math.sin(a.time * 0.5) * 0.25, dt * 2);
          a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.05, dt * 3);
        }
        if (d.glintLeft <= 0) maybeLaunchDrone(e, d, host);
      }
    }
  }

  e.namedHint = hint;
  if (wantYaw !== null && hint !== 0) e.yaw = turnToward(e.yaw, wantYaw, NAMED_SNIPER.proneTurnRate, dt);
  a.aim += (aimT - a.aim) * Math.min(1, dt * (aimT > a.aim ? 7 : 3));
  a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 7);
  a.shake = Math.max(0, a.shake - dt * 4);
  integrate(e, dt, world, host, speed, false);
}

/* ── Replica ──────────────────────────────────────────────────────────────── */

/** The pose is overwritten only in `afterSniperReplica` (a prone body keeps the terrain snap as it is). */
export function beforeSniperReplica(_e: Enemy, _hint: number): void { /* nothing to do */ }

/** Hints 14 / 15: the default rogue animation targets (crouch · half-raised gun) are overwritten with the prone aim — `SniperLook` lays the body down. */
export function afterSniperReplica(e: Enemy, hint: number, dt: number): void {
  if (hint !== HINT_PRONE && hint !== HINT_GLINT) return;
  const a = e.anim;
  a.crouch += (0 - a.crouch) * Math.min(1, dt * 10);
  const aimT = hint === HINT_GLINT ? 1 : 0.7;
  a.aim += (aimT - a.aim) * Math.min(1, dt * 7);
}

/** `ee glint` → the glint sprite · sound · `named:sniperGlint`. `ee snipe` → tracer · flash · the distant report · recoil (damage is the host's `dmg`). */
export function onSniperEvent(host: ReplicaHost, msg: Extract<EnemyEvent, { ev: 'glint' | 'snipe' }>): void {
  const ctx = host.ctx;
  const fxHost: SniperFxHost = host;
  const e = host.find(msg.id);
  if (msg.ev === 'glint') {
    if (!e || !e.active) return;
    const localId = ctx.net?.localId ?? null;
    const targetLocal = msg.target !== null && msg.target === localId;
    if (e.rig.kind === 'rogue') holdSniperGlint(e.rig, msg.dur);
    sniperGlintFx(fxHost, e.position, targetLocal);
    ctx.bus.emit('named:sniperGlint', { enemyId: msg.id, position: e.position, targetLocal, duration: msg.dur });
    return;
  }
  _from.set(msg.from[0], msg.from[1], msg.from[2]);
  _to.set(msg.to[0], msg.to[1], msg.to[2]);
  if (e) {
    e.anim.recoil = 1;
    if (e.rig.kind === 'rogue') clearSniperGlint(e.rig);
  }
  sniperShotFx(fxHost, _from, _to, msg.hit);
  ctx.bus.emit('enemy:shot', { id: msg.id, type: e?.type ?? 'rogue_sniper', from: _from.clone(), to: _to.clone(), hit: msg.hit });
}
