import type * as THREE from 'three';
import type { EnemySnapshot, EnemyWire, EnemyWireState, Vec3Tuple } from '@/shared';
import type { Enemy } from '../Enemy';

/* ────────────────────────────────────────────────────────────────────────────
 * Host → clients encoding helpers (authority side). Allocation here is fine: snapshots go out at
 * NET_ENEMY_SNAPSHOT_HZ and events are sparse.
 * ──────────────────────────────────────────────────────────────────────────── */

export function round(v: number, dp: number): number {
  const m = dp === 1 ? 10 : dp === 2 ? 100 : dp === 3 ? 1000 : 10 ** dp;
  return Math.round(v * m) / m;
}

export function tuple(v: THREE.Vector3, dp = 2): Vec3Tuple {
  return [round(v.x, dp), round(v.y, dp), round(v.z, dp)];
}

/**
 * Animation hint: 0 none, 1 charger windup, 2 charger rush, 3 spewer windup, 4 hunter airborne;
 * Phase 4: 5 rogue shooting, 6 rogue in cover, 7 rogue rushing, 8 artillery dug in, 9 toxic swelling, 10 behemoth windup, 11 behemoth rush.
 */
export function animHint(e: Enemy): number {
  if (e.isRogue) {
    if (e.state === 'stagger') return 6;
    switch (e.roguePhase) {
      case 2: return 6;
      case 3: return e.hitCrouchTimer > 0 ? 6 : 5;
      case 4: return 7;
      default: return 0;
    }
  }
  if (e.type === 'behemoth') {
    if (e.chargePhase === 1) return 10;
    if (e.chargePhase === 2) return 11;
    return 0;
  }
  if (e.type === 'toxic') return e.toxicPhase === 1 ? 9 : 0;
  if (e.type === 'artillery') return e.dug > 0.5 ? 8 : 0;
  if (e.airborne) return 4;
  if (e.chargePhase === 1) return 1;
  if (e.chargePhase === 2) return 2;
  if (e.spitPhase > 0) return 3;
  return 0;
}

/** Corpses leave the snapshot once the death animation has settled (replicas keep them from their own corpse timer). */
const CORPSE_SNAPSHOT_SECONDS = 1.5;

/**
 * Full snapshot of every active enemy (alive, staggered, fleeing, or a corpse still animating).
 * Size: ~90 bytes per enemy as JSON (`{"id":123,"ty":"scavenger","p":[123.45,12.34,-56.78],"yaw":1.234,"hp":60,"st":"chase"}`),
 * so 60 enemies ≈ 5.5 kB per snapshot ≈ 55 kB/s per client at 10 Hz.
 */
export function encodeSnapshot(active: readonly Enemy[], time: number): EnemySnapshot {
  const e: EnemyWire[] = [];
  for (let i = 0; i < active.length; i++) {
    const x = active[i];
    if (!x.active) continue;
    if (x.state === 'dead' && x.deathTimer > CORPSE_SNAPSHOT_SECONDS) continue;
    const w: EnemyWire = {
      id: x.id,
      ty: x.type,
      p: tuple(x.position, 2),
      yaw: round(x.yaw, 3),
      hp: round(x.hp, 1),
      st: x.state as EnemyWireState,
    };
    const a = animHint(x);
    if (a !== 0) w.a = a;
    if (x.weaponId) w.w = x.weaponId;
    e.push(w);
  }
  return { t: 'es', time, full: true, e };
}
