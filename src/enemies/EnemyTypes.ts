import { BEHEMOTH_SCALE, ROGUE_BOSS_HP_MUL, ROGUE_BOSS_SCALE, type EnemyFaction, type EnemyType } from '@/shared';

/** Static gameplay tuning per enemy type. Visual/rig parameters live in models/BugParams.ts (bugs) / models/RogueModel.ts (rogues). */
export interface EnemyStats {
  type: EnemyType;
  /** Phase 4: bugs and rogues fight each other on sight. */
  faction: EnemyFaction;
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
    type: 'scavenger', faction: 'bug', hp: 60, speed: 5.5, wanderSpeed: 1.6, radius: 0.45, height: 0.9, headRadius: 0.2,
    attackDamage: 8, attackCooldown: 0.8, attackRange: 1.6, attackWindup: 0.18, turnRate: 8, accel: 22,
    sightRadius: 40, hearRadius: 55, headMul: 2, rearMul: 1, frontMul: 1, mass: 1, stepSound: false, staggerFraction: 0.25,
  },
  hunter: {
    type: 'hunter', faction: 'bug', hp: 180, speed: 7.5, wanderSpeed: 2.2, radius: 0.6, height: 1.25, headRadius: 0.27,
    attackDamage: 14, attackCooldown: 1.0, attackRange: 2.0, attackWindup: 0.22, turnRate: 7, accel: 26,
    sightRadius: 40, hearRadius: 55, headMul: 2, rearMul: 1, frontMul: 1, mass: 2, stepSound: false, staggerFraction: 0.25,
  },
  warrior: {
    type: 'warrior', faction: 'bug', hp: 320, speed: 4.5, wanderSpeed: 1.6, radius: 0.8, height: 1.6, headRadius: 0.36,
    attackDamage: 25, attackCooldown: 1.2, attackRange: 2.2, attackWindup: 0.35, turnRate: 4, accel: 14,
    sightRadius: 40, hearRadius: 55, headMul: 2, rearMul: 1, frontMul: 1, mass: 4, stepSound: true, staggerFraction: 0.25,
  },
  spewer: {
    type: 'spewer', faction: 'bug', hp: 260, speed: 3.2, wanderSpeed: 1.2, radius: 0.9, height: 1.7, headRadius: 0.32,
    attackDamage: 12, attackCooldown: 1.5, attackRange: 2.3, attackWindup: 0.35, turnRate: 3, accel: 10,
    sightRadius: 40, hearRadius: 55, headMul: 2, rearMul: 1, frontMul: 1, mass: 4, stepSound: false, staggerFraction: 0.25,
  },
  charger: {
    type: 'charger', faction: 'bug', hp: 900, speed: 4, wanderSpeed: 1.5, radius: 1.3, height: 2.3, headRadius: 0.55,
    attackDamage: 30, attackCooldown: 2.0, attackRange: 2.9, attackWindup: 0.4, turnRate: 2.2, accel: 9,
    sightRadius: 45, hearRadius: 60, headMul: 1, rearMul: 2.5, frontMul: 0.5, mass: 10, stepSound: true, staggerFraction: 0.25,
  },
  /* ── Phase 4 ── */
  rogue: {
    type: 'rogue', faction: 'rogue', hp: 140, speed: 4.4, wanderSpeed: 1.4, radius: 0.4, height: 1.8, headRadius: 0.16,
    attackDamage: 0, attackCooldown: 1, attackRange: 0, attackWindup: 0, turnRate: 7, accel: 24,
    sightRadius: 60, hearRadius: 70, headMul: 2, rearMul: 1, frontMul: 1, mass: 2, stepSound: false, staggerFraction: 0.35,
  },
  rogue_boss: {
    type: 'rogue_boss', faction: 'rogue', hp: 140 * ROGUE_BOSS_HP_MUL, speed: 3.8, wanderSpeed: 1.2,
    radius: 0.4 * ROGUE_BOSS_SCALE, height: 1.8 * ROGUE_BOSS_SCALE, headRadius: 0.16 * ROGUE_BOSS_SCALE,
    attackDamage: 0, attackCooldown: 1, attackRange: 0, attackWindup: 0, turnRate: 5, accel: 18,
    sightRadius: 65, hearRadius: 75, headMul: 2, rearMul: 1, frontMul: 1, mass: 6, stepSound: true, staggerFraction: 0.5,
  },
  artillery: {
    type: 'artillery', faction: 'bug', hp: 420, speed: 3.4, wanderSpeed: 1.0, radius: 0.95, height: 1.5, headRadius: 0.3,
    attackDamage: 0, attackCooldown: 2, attackRange: 0, attackWindup: 0, turnRate: 2.5, accel: 9,
    sightRadius: 130, hearRadius: 90, headMul: 2, rearMul: 1.5, frontMul: 1, mass: 5, stepSound: true, staggerFraction: 0.3,
  },
  toxic: {
    type: 'toxic', faction: 'bug', hp: 70, speed: 7.2, wanderSpeed: 1.8, radius: 0.45, height: 1.0, headRadius: 0.17,
    attackDamage: 0, attackCooldown: 1, attackRange: 0, attackWindup: 0, turnRate: 9, accel: 30,
    sightRadius: 45, hearRadius: 60, headMul: 2, rearMul: 1, frontMul: 1, mass: 1, stepSound: false, staggerFraction: 1.1,
  },
  behemoth: {
    type: 'behemoth', faction: 'bug', hp: 1400, speed: 3.6, wanderSpeed: 1.2,
    radius: 0.8 * BEHEMOTH_SCALE, height: 1.6 * BEHEMOTH_SCALE, headRadius: 0.36 * BEHEMOTH_SCALE,
    attackDamage: 45, attackCooldown: 2.2, attackRange: 2.2 * BEHEMOTH_SCALE, attackWindup: 0.55, turnRate: 1.8, accel: 8,
    sightRadius: 60, hearRadius: 70, headMul: 1, rearMul: 2, frontMul: 0.35, mass: 30, stepSound: true, staggerFraction: 0.3,
  },
};

/* Type-specific ability tuning */
export const HUNTER_LEAP = { minDist: 5, maxDist: 9, damage: 22, cooldown: 4, flightTime: 0.62, hitRadius: 2.4 };
export const SPEWER_SPIT = { minDist: 8, maxDist: 22, damage: 18, splashDamage: 10, slowDuration: 2, cooldown: 3.0, windup: 0.55, deathBurstRadius: 4, deathBurstDamage: 20 };
export const CHARGER_CHARGE = { minDist: 7, maxDist: 30, windup: 0.8, speed: 14, damage: 45, maxDuration: 3.5, stumble: 1.5, cooldown: 3.0 };

/* Phase 4 ability tuning (world constants live in @/shared/constants: ROGUE_*, ARTILLERY_RANGE, SHELL_*, TOXIC_*, BEHEMOTH_*) */
export const ROGUE_AI = {
  /** cover hold time range (s), pop-out burst spacing (s), rush duration cap (s), rush stand-off (m) */
  coverMin: 2, coverMax: 4, shotGap: 0.12, rushMax: 6, rushDist: 8,
  /** seconds standing still until the aim error settles */
  settleTime: 1.2,
  /** guard leash from the crate / boss (m) */
  leash: 45, escortLeash: 18,
  /** bugs closer than this are shot even when a player is in range */
  bugRange: 25,
  /** a rogue that took a hit crouches (hint 6) for this long before continuing its cycle */
  hitCrouch: 0.5,
  /** boss burst */
  bossRounds: 6, bossDamageMul: 1.6,
  /** rifles handed to guards / the boss (item def ids of items/WeaponDefs) */
  weapons: ['ar23', 'smg37', 'sg8', 'r63', 'las16'] as readonly string[],
  bossWeapon: 'r63',
  /** hitscan range (m) */
  range: 90,
};
export const ARTILLERY_AI = { retreatDist: 60, approachDist: 125, fireMin: 6, fireMax: 9, digTime: 1.2, maxRange: 140 };
export const TOXIC_AI = { swell: 0.6 };
export const BEHEMOTH_AI = { engageDist: 18, chargeCooldown: 4, overshoot: 6, maxDuration: 3.2, enemyDamage: 160, enemyShove: 9, stumble: 1.6 };

export const ALL_ENEMY_TYPES: readonly EnemyType[] = ['scavenger', 'hunter', 'warrior', 'spewer', 'charger', 'rogue', 'rogue_boss', 'artillery', 'toxic', 'behemoth'];
/** Types rendered with the six-legged bug rig (everything but the humanoid rogues). */
export type BugType = Exclude<EnemyType, 'rogue' | 'rogue_boss'>;
export const isRogueType = (t: EnemyType): boolean => t === 'rogue' || t === 'rogue_boss';
