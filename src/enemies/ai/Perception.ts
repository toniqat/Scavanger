import * as THREE from 'three';
import { CLOAK_REVEAL_DISTANCE, ENEMY_SHOT_ALERT_CONE_MUL } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import type { CombatTarget } from '../Targets';

const _o = new THREE.Vector3();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Below this vision factor the target counts as hidden (smoke) even with a clear geometric line. */
const SMOKE_BLIND = 0.4;
/**
 * Phase 12 (총알 추적): half-angle of the widened perception cone toward the shot origin, as a cosine (≈ 45°). Inside
 * it the detection range is × `ENEMY_SHOT_ALERT_CONE_MUL`; outside it the enemy is as blind as before.
 */
const SHOT_CONE_COS = 0.7;

/** Bug eye position (used for LOS and smoke tests). */
function eyeOf(e: Enemy, out: THREE.Vector3): THREE.Vector3 {
  return out.set(e.position.x, e.position.y + e.stats.height * 0.8, e.position.z);
}

/** True when nothing (terrain / props) blocks the line from the bug's eyes to the target's chest. */
export function hasLineOfSight(e: Enemy, host: EnemyHost, target: CombatTarget): boolean {
  const world = host.ctx.world;
  if (!world) return false;
  eyeOf(e, _o);
  target.getChest(_t);
  _d.subVectors(_t, _o);
  const dist = _d.length();
  if (dist < 1e-3) return true;
  _d.multiplyScalar(1 / dist);
  return world.raycast(_o, _d, dist - 0.3) === null;
}

/**
 * 0..1 clarity of the line from the bug's eyes to `target`'s chest, as reported by `ctx.gadgets.visionFactor`
 * (smoke clouds). 1 when there is no gadget system yet or nothing obscures the line.
 */
export function visionClarity(e: Enemy, host: EnemyHost, target: CombatTarget): number {
  const g = host.ctx.gadgets;
  if (!g) return 1;
  eyeOf(e, _o);
  target.getChest(_t);
  const v = g.visionFactor(_o, _t);
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : 1;
}

/**
 * Effective detection range for `target`: base sight radius × the target's stealth factor (은폐)
 * × the smoke clarity between the two (`ctx.gadgets.visionFactor`).
 * An alerted bug closer than `CLOAK_REVEAL_DISTANCE` sees a cloaked target regardless.
 */
export function detectionRange(e: Enemy, host: EnemyHost, target: CombatTarget, clarity: number): number {
  const stealth = target.stealth > 0 && target.stealth <= 1 ? target.stealth : 1;
  const range = e.stats.sightRadius * stealth * clarity;
  return e.aware ? Math.max(range, CLOAK_REVEAL_DISTANCE) : range;
}

/**
 * Phase 12 (총알 추적): range multiplier for `target` while `e` investigates a shot — `ENEMY_SHOT_ALERT_CONE_MUL` when
 * the target lies inside the cone toward `e.shotOrigin`, 1 otherwise. Applied **on top of** `detectionRange`, so the
 * cloak / smoke factors still scale the widened range (a cloaked sniper stays hard to spot, just less so).
 */
export function shotConeFactor(e: Enemy, targetPos: THREE.Vector3): number {
  if (!e.investigating) return 1;
  const ox = e.shotOrigin.x - e.position.x, oz = e.shotOrigin.z - e.position.z;
  const tx = targetPos.x - e.position.x, tz = targetPos.z - e.position.z;
  const lo = Math.hypot(ox, oz), lt = Math.hypot(tx, tz);
  if (lo < 1e-3 || lt < 1e-3) return ENEMY_SHOT_ALERT_CONE_MUL;
  const cos = (ox * tx + oz * tz) / (lo * lt);
  return cos >= SHOT_CONE_COS ? ENEMY_SHOT_ALERT_CONE_MUL : 1;
}

/**
 * Would an **unaware** `e` notice `target` on its next perception tick? The acquisition rule of `updatePerception`
 * (range with cloak / smoke, the 5 m proximity shortcut that a smoke wall still blocks, else a clear line of sight) as
 * a pure query — `EnemySystem.reportShot` uses it to skip enemies that are about to spot the shooter anyway.
 * `widen` = apply the 총알 추적 cone (the perception tick does; the shot report does not).
 */
export function canPerceive(e: Enemy, host: EnemyHost, target: CombatTarget, widen: boolean): boolean {
  const dist = target.dist2D(e.position);
  const clarity = visionClarity(e, host, target);
  let range = detectionRange(e, host, target, clarity);
  if (widen) range *= shotConeFactor(e, target.position);
  if (dist >= range) return false;
  return (dist < Math.min(5, range) && clarity > SMOKE_BLIND) || hasLineOfSight(e, host, target);
}

/**
 * Pick / keep the bug's target: nearest alive player, re-evaluated every 0.5–0.9 s or as soon as the current one
 * dies, goes down or leaves. Hysteresis: a different player must be clearly closer (×0.6 with LOS on the current, ×0.75 without)
 * before the bug switches. A dead or downed target is kept (so "target died → calm down" logic runs) until another is alive.
 * Also refreshes `distToTarget`.
 */
export function acquireTarget(e: Enemy, dt: number, host: EnemyHost): void {
  e.targetTimer -= dt;
  const cur = e.target;
  const curValid = !!cur && cur.present && !cur.isDeadOrDowned;
  if (!curValid || e.targetTimer <= 0) {
    e.targetTimer = 0.5 + Math.random() * 0.4;
    const best = host.pickTarget(e);
    if (!best) {
      if (cur && !cur.present) e.target = null;
    } else if (!curValid) {
      e.target = best;
    } else if (best !== cur) {
      const keep = e.hasLOS ? 0.6 : 0.75;
      if (best.dist2D(e.position) < cur.dist2D(e.position) * keep) e.target = best;
    }
    if (e.target !== cur) { e.hasLOS = false; e.perceptionTimer = 0; }
  }
  e.distToTarget = e.target ? e.target.dist2D(e.position) : Infinity;
}

/** Wake this bug: it now knows about the players. `loud` → screech + propagate to neighbours. */
export function becomeAlert(e: Enemy, host: EnemyHost, loud: boolean): void {
  if (e.state === 'dead' || e.state === 'flee' || !e.active) return;
  const wasAware = e.aware;
  e.aware = true;
  e.lostTimer = 0;
  if (e.state === 'idle' || e.state === 'wander') {
    e.state = 'alert';
    e.stateTime = 0;
    e.hasMoveTarget = false;
  }
  if (!wasAware && loud) {
    host.ctx.bus.emit('enemy:alerted', { id: e.id, type: e.type, position: e.position });
    if (e.isRogue) { /* humans do not screech; the reaction delay + rifle raise reads as the alert */ }
    else if (e.type === 'scavenger' || e.type === 'hunter' || e.type === 'toxic') host.playAudio('bug_screech', e.position, 0.9, e.type === 'hunter' ? 0.9 : 1.15);
    else host.playAudio('bug_screech', e.position, 0.7, e.type === 'behemoth' ? 0.35 : e.type === 'charger' ? 0.55 : 0.75);
    host.alertNear(e.position, 20, e);
  }
}

/**
 * Staggered perception tick (≤ every 0.3 s per bug): sight acquisition with LOS, cloak / smoke aware detection
 * range, lure refresh, standing-in-fire check, and target loss when the target is far and unseen for a while.
 */
export function updatePerception(e: Enemy, dt: number, host: EnemyHost): void {
  e.perceptionTimer -= dt;
  if (e.perceptionTimer > 0) return;
  e.perceptionTimer = 0.3;

  // lures (유인 수류탄 / 소음) — cheap, and also pulls bugs that have no target at all
  e.lureWeight = host.lureFor(e.position, e.lurePos);
  e.hasLure = e.lureWeight > 0;

  // fire zones burn whoever stands in them, even if gadgets/ never calls applyStatus for this bug
  const gadgets = host.ctx.gadgets;
  if (gadgets) {
    const dps = gadgets.fireDamageAt(e.position);
    if (dps > 0) { e.burnDps = Math.max(e.burnDps, dps); e.burnTimer = Math.max(e.burnTimer, 1.2); }
  }

  const t = e.target;
  if (!t || t.isDeadOrDowned) { e.hasLOS = false; return; }
  const dist = e.distToTarget;
  const clarity = visionClarity(e, host, t);
  const range = detectionRange(e, host, t, clarity);

  if (!e.aware) {
    // Phase 12: an investigating enemy looks harder toward the shot origin (cone × ENEMY_SHOT_ALERT_CONE_MUL)
    const acquire = e.investigating ? range * shotConeFactor(e, t.position) : range;
    if (dist < acquire) {
      // very close bugs notice you regardless of LOS (but not through a smoke wall)
      const seen = (dist < Math.min(5, acquire) && clarity > SMOKE_BLIND) || hasLineOfSight(e, host, t);
      e.hasLOS = seen;
      if (seen) becomeAlert(e, host, true);
    } else e.hasLOS = false;
  } else {
    const blinded = clarity <= SMOKE_BLIND && dist > CLOAK_REVEAL_DISTANCE;
    // once alerted a bug keeps tracking well past its acquisition range (90 m for a plain target,
    // but only ~16 m for a cloaked one), and not at all through smoke
    const trackRange = Math.min(90 * clarity, Math.max(range * 2.2, CLOAK_REVEAL_DISTANCE));
    e.hasLOS = !blinded && dist < trackRange && hasLineOfSight(e, host, t);
    // artillery fights from ARTILLERY_RANGE without LOS; rogues keep hunting inside their leash while the target is within range
    if (!e.relentless && e.type !== 'artillery' && !(e.isRogue && dist < 80)) {
      // cloaked / smoked targets are lost faster: any range beyond the (reduced) tracking range counts
      const lost = !e.hasLOS && (dist > 60 || dist > trackRange);
      if (lost) {
        e.lostTimer += 0.3;
        if (e.lostTimer > 10) {
          e.aware = false;
          e.lostTimer = 0;
          e.spawnPos.copy(e.position);
          if (e.state === 'chase' || e.state === 'alert') { e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1; e.hasMoveTarget = false; }
        }
      } else e.lostTimer = 0;
    }
  }
}
