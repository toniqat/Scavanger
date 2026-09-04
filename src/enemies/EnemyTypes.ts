import type { EnemyType } from '@/shared';

/** Static gameplay tuning per bug type. Visual/rig parameters live in models/BugParams.ts. */
export interface EnemyStats {
  type: EnemyType;
  hp: number;
  /** chase speed (m/s) */
  speed: number;
  /** idle wander speed (m/s) */
  wanderSpeed: number;
  /** collider + hit-capsule radius */
  radius: number;
  /** hit-capsule height from feet */
  height: number;
  /** head hit-sphere radius (world units) */
  headRadius: number;
  /** melee damage */
  attackDamage: number;
  /** seconds between melee attacks */
  attackCooldown: number;
  /** center-to-center distance at which melee starts */
  attackRange: number;
  /** seconds from attack start until damage is applied */
  attackWindup: number;
  /** yaw turn rate (rad/s) */
  turnRate: number;
  /** acceleration (m/s²) */
  accel: number;
  sightRadius: number;
  hearRadius: number;
  /** damage multipliers by hit part */
  headMul: number;
  rearMul: number;
  frontMul: number;
  /** separation weight (heavier pushes lighter) */
  mass: number;
  /** emits bug_step footsteps when near the player */
  stepSound: boolean;
  /** fraction of maxHp in a single hit that causes a stagger */
  staggerFraction: number;
}

export const ENEMY_STATS: Record<EnemyType, EnemyStats> = {
  scavenger: {
    type: 'scavenger', hp: 60, speed: 5.5, wanderSpeed: 1.6, radius: 0.45, height: 0.9, headRadius: 0.2,
    attackDamage: 8, attackCooldown: 0.8, attackRange: 1.6, attackWindup: 0.18, turnRate: 8, accel: 22,
    sightRadius: 40, hearRadius: 55, headMul: 2, rearMul: 1, frontMul: 1, mass: 1, stepSound: false, staggerFraction: 0.25,
  },
  hunter: {
    type: 'hunter', hp: 180, speed: 7.5, wanderSpeed: 2.2, radius: 0.6, height: 1.25, headRadius: 0.27,
    attackDamage: 14, attackCooldown: 1.0, attackRange: 2.0, attackWindup: 0.22, turnRate: 7, accel: 26,
    sightRadius: 40, hearRadius: 55, headMul: 2, rearMul: 1, frontMul: 1, mass: 2, stepSound: false, staggerFraction: 0.25,
  },
  warrior: {
    type: 'warrior', hp: 320, speed: 4.5, wanderSpeed: 1.6, radius: 0.8, height: 1.6, headRadius: 0.36,
    attackDamage: 25, attackCooldown: 1.2, attackRange: 2.2, attackWindup: 0.35, turnRate: 4, accel: 14,
    sightRadius: 40, hearRadius: 55, headMul: 2, rearMul: 1, frontMul: 1, mass: 4, stepSound: true, staggerFraction: 0.25,
  },
  spewer: {
    type: 'spewer', hp: 260, speed: 3.2, wanderSpeed: 1.2, radius: 0.9, height: 1.7, headRadius: 0.32,
    attackDamage: 12, attackCooldown: 1.5, attackRange: 2.3, attackWindup: 0.35, turnRate: 3, accel: 10,
    sightRadius: 40, hearRadius: 55, headMul: 2, rearMul: 1, frontMul: 1, mass: 4, stepSound: false, staggerFraction: 0.25,
  },
  charger: {
    type: 'charger', hp: 900, speed: 4, wanderSpeed: 1.5, radius: 1.3, height: 2.3, headRadius: 0.55,
    attackDamage: 30, attackCooldown: 2.0, attackRange: 2.9, attackWindup: 0.4, turnRate: 2.2, accel: 9,
    sightRadius: 45, hearRadius: 60, headMul: 1, rearMul: 2.5, frontMul: 0.5, mass: 10, stepSound: true, staggerFraction: 0.25,
  },
};

/* Type-specific ability tuning */
export const HUNTER_LEAP = { minDist: 5, maxDist: 9, damage: 22, cooldown: 4, flightTime: 0.62, hitRadius: 2.4 };
export const SPEWER_SPIT = { minDist: 8, maxDist: 22, damage: 18, splashDamage: 10, slowDuration: 2, cooldown: 3.0, windup: 0.55, deathBurstRadius: 4, deathBurstDamage: 20 };
export const CHARGER_CHARGE = { minDist: 7, maxDist: 30, windup: 0.8, speed: 14, damage: 45, maxDuration: 3.5, stumble: 1.5, cooldown: 3.0 };

export const ALL_ENEMY_TYPES: readonly EnemyType[] = ['scavenger', 'hunter', 'warrior', 'spewer', 'charger'];
