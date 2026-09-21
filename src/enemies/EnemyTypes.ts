import { addDataIssue, csvRows, numberMap, stringMap, type EnemyFaction, type EnemyType } from '@/shared';

/*
 * Enemy numbers come from `data/enemies.csv` (base stats per type) and `data/enemy_abilities.csv` (special abilities).
 * This file holds no table — only the code that moves those two csv files into typed objects.
 */

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
  /** walks audibly — surface footsteps (`model.stepSound` pitch / gain, `model.emitEnemyStep`; 2026-09-11 C-22 · C-23) */
  stepSound: boolean;
  /** fraction of maxHp in a single hit that causes a stagger */
  staggerFraction: number;
  /**
   * 2026-09-16: the character XP the raid ends with for killing one of this type with my own last hit (per kill, csv
   * `raidXp`). It is the **only** source of raid XP — the kill sites (`parts/Damage.onEnemyKilled` · `net/Replica`
   * `kill`) add it into `ctx.stats.killXp` and `game/` settles it.
   */
  raidXp: number;
}

/** The order the csv `type` column accepts enemy types in — the same list as `ALL_ENEMY_TYPES`. */
const ENEMY_TYPE_VALUES: readonly EnemyType[] = ['scavenger', 'hunter', 'warrior', 'spewer', 'charger', 'rogue', 'rogue_boss', 'artillery', 'toxic', 'behemoth', 'rogue_sniper', 'rogue_hammer', 'rogue_heavy', 'rogue_scan_drone', 'android', 'raider', 'sandworm', 'tut_bug_loot', 'tut_bug', 'tut_android_loot', 'tut_android', 'sandworm_weak', 'scavenger_summon', 'bug_egg'];
const ENEMY_FACTIONS: readonly EnemyFaction[] = ['bug', 'rogue', 'android', 'raider'];

export const ENEMY_STATS: Record<EnemyType, EnemyStats> = (() => {
  const out = {} as Record<EnemyType, EnemyStats>;
  for (const r of csvRows('enemies.csv')) {
    const type = r.enum('type', ENEMY_TYPE_VALUES);
    out[type] = {
      type,
      faction: r.enum('faction', ENEMY_FACTIONS),
      hp: r.num('hp', { min: 1 }),
      speed: r.num('speed', { min: 0 }),
      wanderSpeed: r.num('wanderSpeed', { min: 0 }),
      radius: r.num('radius', { min: 0 }),
      height: r.num('height', { min: 0 }),
      headRadius: r.num('headRadius', { min: 0 }),
      attackDamage: r.num('attackDamage', { min: 0 }),
      attackCooldown: r.num('attackCooldown', { min: 0 }),
      attackRange: r.num('attackRange', { min: 0 }),
      attackWindup: r.num('attackWindup', { min: 0 }),
      turnRate: r.num('turnRate', { min: 0 }),
      accel: r.num('accel', { min: 0 }),
      sightRadius: r.num('sightRadius', { min: 0 }),
      hearRadius: r.num('hearRadius', { min: 0 }),
      headMul: r.num('headMul', { min: 0 }),
      rearMul: r.num('rearMul', { min: 0 }),
      frontMul: r.num('frontMul', { min: 0 }),
      mass: r.num('mass', { min: 0 }),
      stepSound: r.bool('stepSound'),
      staggerFraction: r.num('staggerFraction', { min: 0 }),
      raidXp: r.num('raidXp', { min: 0 }),
    };
  }
  for (const t of ENEMY_TYPE_VALUES) {
    if (!out[t]) addDataIssue({ file: 'enemies.csv', line: 0, column: t, message: `'${t}' 줄이 없다` });
  }
  return out;
})();

/**
 * 2026-09-16: one kill's raid XP (`EnemyStats.raidXp`). An unknown type off the wire or a bad value is 0 — the kill
 * count still counts. The two kill sites (authority `parts/Damage.onEnemyKilled`, replica `net/Replica` `kill`) add
 * this and nothing else, under **the same condition** (my own last hit).
 */
export function raidXpOf(type: EnemyType): number {
  const xp = ENEMY_STATS[type]?.raidXp;
  return typeof xp === 'number' && Number.isFinite(xp) && xp > 0 ? xp : 0;
}

/* Type-specific ability tuning — data/enemy_abilities.csv */
const ability = <K extends string>(block: string): Record<K, number> => numberMap<K>('enemy_abilities.csv', block, 'block');

/**
 * 2026-09-17: `arcGravityMul` = the gravity multiplier of the leap arc · `flipDamage` = damage taken within one leap
 * at or above which it flips · `flipDuration` = the seconds it lies flipped (`ai/HunterFlip.ts`).
 */
export const HUNTER_LEAP = ability<'minDist' | 'maxDist' | 'damage' | 'cooldown' | 'flightTime' | 'hitRadius' | 'arcGravityMul' | 'flipDamage' | 'flipDuration'>('HUNTER_LEAP');
export const SPEWER_SPIT = ability<'minDist' | 'maxDist' | 'damage' | 'splashDamage' | 'slowDuration' | 'cooldown' | 'windup' | 'deathBurstRadius' | 'deathBurstDamage'>('SPEWER_SPIT');
export const CHARGER_CHARGE = ability<'minDist' | 'maxDist' | 'windup' | 'speed' | 'damage' | 'maxDuration' | 'stumble' | 'cooldown'>('CHARGER_CHARGE');

/* Phase 4 ability tuning (world constants live in @/shared/constants: ROGUE_*, ARTILLERY_RANGE, SHELL_*, TOXIC_*, BEHEMOTH_*) */
const ROGUE_AI_TEXT = stringMap<'weapons' | 'bossWeapon'>('enemy_abilities.csv', 'ROGUE_AI_TEXT', 'block');
/**
 * The numbers are the `ROGUE_AI` block, the weapon list the `ROGUE_AI_TEXT` block (one block is all numbers or all
 * strings). coverMin/coverMax = how long cover is held (s), shotGap = the gap between bursts (s), rushMax = how long a
 * rush lasts (s), rushDist = the distance a rush stops at (m), settleTime = how long the aim settles after stopping (s),
 * leash/escortLeash = the leash from the crate · boss (m), bugRange = bugs this close are shot even with a player
 * about (m), hitCrouch = the crouch after being hit (s), bossRounds/bossDamageMul = the boss's rounds per burst and
 * damage multiplier, range = the hitscan range (m).
 */
export const ROGUE_AI = {
  ...ability<'coverMin' | 'coverMax' | 'shotGap' | 'rushMax' | 'rushDist' | 'settleTime' | 'leash' | 'escortLeash' | 'bugRange' | 'hitCrouch' | 'bossRounds' | 'bossDamageMul' | 'range'>('ROGUE_AI'),
  /** rifles handed to guards / the boss (item def ids of items/WeaponDefs) */
  weapons: ROGUE_AI_TEXT.weapons.split('|').map((w) => w.trim()).filter(Boolean) as readonly string[],
  bossWeapon: ROGUE_AI_TEXT.bossWeapon,
};
/**
 * 2026-09-09: `spawnMin` / `spawnMax` = the ring `Spawner.maybeArtillery` digs one in on (m) — sits between retreat and approach so it fires at once.
 * 2026-09-11 (C-24): `maxRefusals` = blocked-arc refusals in a row before retargeting, `refusalCooldown` = seconds of no fire after that.
 * 2026-09-17 (the artillery escort · fire condition · firing stance · the one-off summon — `ai/ArtilleryPack.ts`):
 * `escortMin/Max` · `escortFollowDist` · `packRingMin/Max` · `supportRadius` · `supportCheckS` · `braceTime` ·
 * `postFireLock` · `summonMin/Max` (their meanings are in the csv block's header).
 * 2026-09-18 (the barrage prep · re-summoning the squad): `prepTime` · `squadCooldown` were added — the 「once in a
 * lifetime」 limit is gone.
 */
export const ARTILLERY_AI = ability<'retreatDist' | 'approachDist' | 'fireMin' | 'fireMax' | 'digTime' | 'maxRange' | 'spawnMin' | 'spawnMax' | 'maxRefusals' | 'refusalCooldown'
  | 'escortMin' | 'escortMax' | 'escortFollowDist' | 'packRingMin' | 'packRingMax' | 'supportRadius' | 'supportCheckS' | 'braceTime' | 'postFireLock' | 'summonMin' | 'summonMax'
  /* 2026-09-18 (user's decision — the barrage prep · re-summoning its own squad): `prepTime` = the seconds of prep from
     a bug appearing beside the target to the first shell · `squadCooldown` = the seconds before a new pack is called
     after its own scavengers are wiped out (their meanings are in the csv block's header). */
  | 'prepTime' | 'squadCooldown'>('ARTILLERY_AI');
export const TOXIC_AI = ability<'swell'>('TOXIC_AI');
/**
 * 2026-09-17 (user's decision): the multiplier on damage an enemy deals to **another enemy** (1/3). Damage dealt to a
 * player · android squadmate · drone · vehicle does not take it. Used by: the enemy branch of
 * `parts/Damage.applyDamage`, `parts/Attacks` (gun · grenade · incendiary zone · shell · the toxic self-destruct), and
 * the `sandworm/Director` eruption. The behemoth charge had its own value cut directly (`BEHEMOTH_AI.enemyDamage`).
 * The environmental hazard (`HAZARD_ENEMY_DPS`) is outside it.
 */
export const ENEMY_CLASH = ability<'damageMul'>('ENEMY_CLASH');
export const BEHEMOTH_AI = ability<'engageDist' | 'chargeCooldown' | 'overshoot' | 'maxDuration' | 'enemyDamage' | 'enemyShove' | 'stumble'>('BEHEMOTH_AI');

export const ALL_ENEMY_TYPES: readonly EnemyType[] = ['scavenger', 'hunter', 'warrior', 'spewer', 'charger', 'rogue', 'rogue_boss', 'artillery', 'toxic', 'behemoth', 'rogue_sniper', 'rogue_hammer', 'rogue_heavy', 'rogue_scan_drone', 'android', 'raider', 'sandworm', 'tut_bug_loot', 'tut_bug', 'tut_android_loot', 'tut_android', 'sandworm_weak', 'scavenger_summon', 'bug_egg'];

/* ── 2026-09-14 (3rd pass): the four tutorial-only types ──────────
 *
 * The one thing these four types have of their own is a **fixed drop table** (`data/loot_corpses.csv` ·
 * `loot_corpse_rolls.csv`). The rig · look · AI · sounds are the **base type**'s, used as they are — so no row is added
 * to a per-type table (`BUG_PARAMS` · `ROGUE_RIG_PARAMS` · `STEP_VOICES` · `MELEE_VOICES` …); instead the places that
 * read those tables pass through `baseTypeOf` once. Adding rows would have baked different geometry for the tutorial
 * bug alone (the shader budget) and made every new type a change to five or six tables at once.
 *
 * The numbers in `data/enemies.csv` come from its **own row** (half an android's hp is on that row) — the base type
 * answers only "what does it look like and how does it move".
 */
export type TutorialEnemyType = 'tut_bug_loot' | 'tut_bug' | 'tut_android_loot' | 'tut_android';
/** Tutorial type → base type. The ids here are the contract ids `world/tutorial`'s lists use. */
export const TUTORIAL_ENEMY_BASE: Readonly<Record<TutorialEnemyType, EnemyType>> = {
  tut_bug_loot: 'scavenger',
  tut_bug: 'scavenger',
  tut_android_loot: 'android',
  tut_android: 'android',
};
export const isTutorialEnemyType = (t: EnemyType): t is TutorialEnemyType =>
  Object.prototype.hasOwnProperty.call(TUTORIAL_ENEMY_BASE, t);
/* ── 2026-09-17: the artillery's summoned scavenger — it borrows rig · AI · sounds from the base type by the tutorial types' trick (only its 0 % drop differs). ── */
export type VariantEnemyType = 'scavenger_summon';
/** A main-game variant → its base type. Not a tutorial type, so `isTutorialEnemyType` is false. */
export const VARIANT_ENEMY_BASE: Readonly<Record<VariantEnemyType, EnemyType>> = {
  scavenger_summon: 'scavenger',
};
export const isVariantEnemyType = (t: EnemyType): t is VariantEnemyType =>
  Object.prototype.hasOwnProperty.call(VARIANT_ENEMY_BASE, t);
/**
 * The type used when picking a rig · look · AI branch · sound. For a tutorial-only type or a main-game variant
 * (2026-09-17, the summoned scavenger) it is the base type, otherwise itself (every enemy in the main game and the
 * training range **gets itself straight back on the first line**).
 */
export const baseTypeOf = (t: EnemyType): EnemyType =>
  (isTutorialEnemyType(t) ? TUTORIAL_ENEMY_BASE[t] : isVariantEnemyType(t) ? VARIANT_ENEMY_BASE[t] : t);
/**
 * 2026-09-13: the sandworm — neither the six-legged rig nor the humanoid one but **its own** (`models/WormModel`). It
 * stays buried in the ground without moving and its AI is run by `sandworm/Director` (`ai/EnemyAI` returns this type
 * straight away).
 */
/**
 * 2026-09-15: the **young sandworm** `sandworm_weak` on a threat-1 planet has the same rig and the same director — all
 * that differs is its own row in `data/enemies.csv` (`SANDWORM_WEAK_SCALE` times the size · `SANDWORM_WEAK_HP` hp),
 * the director's spit list (scavengers only) and the eruption radius multiplier.
 * Branch on the type **always through this function** (`=== 'sandworm'` leaves the young one out).
 */
export type WormEnemyType = 'sandworm' | 'sandworm_weak';
export const isWormType = (t: EnemyType): t is WormEnemyType => t === 'sandworm' || t === 'sandworm_weak';
/**
 * 2026-09-18 (user's decision 「벌레 알을 파괴 가능한 적으로」): the **bug egg** — a faction-bug target stuck at a nest
 * mound's base that never moves, turns, attacks or becomes aware. It uses neither the six-legged rig nor the humanoid
 * one but **its own** (`models/EggModel`) and has no AI (`ai/EnemyAI.updateEnemyAI` returns on its first line). Branch
 * on the type always through this function.
 */
export type EggEnemyType = 'bug_egg';
export const isEggType = (t: EnemyType): t is EggEnemyType => t === 'bug_egg';
/** Types rendered with the six-legged bug rig (everything but the humanoid rogues). 2026-09-11: the three named and the scan drone are not on the bug rig either. 2026-09-13: nor are the android · raider. */
export type BugType = Exclude<EnemyType, 'rogue' | 'rogue_boss' | 'rogue_sniper' | 'rogue_hammer' | 'rogue_heavy' | 'rogue_scan_drone' | 'android' | 'raider' | WormEnemyType | TutorialEnemyType | VariantEnemyType
  /* 2026-09-18: the bug egg has its own rig too (`models/EggModel`) — it has no row in the bug rig table (`BUG_PARAMS`). */
  | EggEnemyType>;
/**
 * Humanoid rogue rig (`models/RogueModel`). 2026-09-11: the three named included. The scan drone sits here for now,
 * from the contract stage — take it off this line once its owner builds its own rig. 2026-09-13: the android · raider
 * (the same rig, a different skin).
 * ⚠ Despite the name this is a **rig** test — "is it the rogue faction" is `Enemy.isRogue`, "is it a humanoid AI rather
 * than a bug" is `Enemy.isHumanoid`.
 */
export const isRogueType = (t: EnemyType): boolean => t === 'rogue' || t === 'rogue_boss' || t === 'rogue_sniper' || t === 'rogue_hammer' || t === 'rogue_heavy' || t === 'rogue_scan_drone' || t === 'android' || t === 'raider'
  /* 2026-09-14 (3rd pass): the tutorial android is on the same humanoid rig (`baseTypeOf` picks the skin). The tutorial bug stays on the bug rig. */
  || t === 'tut_android' || t === 'tut_android_loot';

/* ── 2026-09-11: named rogues (shared/named.ts) — read by ai/named/*. A new key goes into that block's union line and the csv block together. ── */
export const NAMED_SNIPER = ability<'droneRange' | 'detectRange' | 'droneCooldown' | 'droneRetry' | 'scanPulses' | 'exposeNeeded' | 'scannedAccuracy' | 'nearAccuracyMax' | 'nearAccuracyMin' | 'damage' | 'fireInterval' | 'glintTime' | 'range' | 'relocateCooldown' | 'nestLeash' | 'closeThreat' | 'scanWait' | 'proneTurnRate'>('NAMED_SNIPER');
export const NAMED_SCAN_DRONE = ability<'altitude' | 'speed' | 'pulseInterval' | 'pulseRadius' | 'loiterMax'>('NAMED_SCAN_DRONE');
export const NAMED_HAMMER = ability<'windup' | 'chargeDist' | 'chargeSpeed' | 'chargeCooldown' | 'structureRadius' | 'giveUpDist' | 'giveUpTime' | 'patrolRadius'>('NAMED_HAMMER');
/* ── 2026-09-13: the humanoid faction per planet — the gun family a spawn hands out (`items/WeaponDefs` family ids; the grade is rolled by corpse loot). ── */
const HUMANOID_WEAPONS_TEXT = stringMap<'android' | 'rogue' | 'raider'>('enemy_abilities.csv', 'HUMANOID_WEAPONS', 'block');
const splitIds = (s: string | undefined): readonly string[] => (s ?? '').split('|').map((w) => w.trim()).filter(Boolean);
export const HUMANOID_WEAPONS: Readonly<Record<'android' | 'rogue' | 'raider', readonly string[]>> = {
  android: splitIds(HUMANOID_WEAPONS_TEXT.android),
  rogue: splitIds(HUMANOID_WEAPONS_TEXT.rogue),
  raider: splitIds(HUMANOID_WEAPONS_TEXT.raider),
};
/* ── 2026-09-13: humanoid faction AI profiles (read by `ai/HumanoidProfile.ts`) — csv blocks HUMANOID_ANDROID · HUMANOID_ROGUE · HUMANOID_RAIDER ── */
const HUMANOID_KEYS = ['reaction', 'aimNear', 'aimFar', 'aimNearDist', 'aimFarDist', 'settleMul', 'burstMin', 'burstMax', 'shotGap', 'burstPause',
  'burstsPerPop', 'coverMul', 'rushChance', 'damageMul', 'enemyDamageMul', 'bugBackoff', 'grenadeMin', 'grenadeMax', 'incendiaryChance', 'grenadeRange', 'grenadeScatter'] as const;
const ANDROID_KEYS = ['engageMin', 'engageMax', 'advanceMul'] as const;
const FLANK_KEYS = ['flankDelay', 'flankCooldown', 'flankMinDist', 'flankMaxDist', 'flankRadius', 'flankBehind', 'flankArcStep', 'flankArrive', 'flankSpeedMul', 'flankMaxTime'] as const;
export type HumanoidProfileKey = (typeof HUMANOID_KEYS)[number];
export type HumanoidProfile = Readonly<Record<HumanoidProfileKey, number>>;
/** `numberMap` does not report a missing key — every block is checked so one mistyped letter does not become NaN fire. */
function checkedBlock<K extends string>(block: string, keys: readonly K[]): Record<K, number> {
  const m = ability<K>(block);
  for (const k of keys) {
    if (typeof m[k] !== 'number' || !Number.isFinite(m[k])) {
      addDataIssue({ file: 'enemy_abilities.csv', line: 0, column: `${block}.${k}`, message: `'${block}.${k}' 가 없다` });
      m[k] = 0;
    }
  }
  return m;
}
export const HUMANOID_ANDROID = checkedBlock<HumanoidProfileKey | (typeof ANDROID_KEYS)[number]>('HUMANOID_ANDROID', [...HUMANOID_KEYS, ...ANDROID_KEYS]);
export const HUMANOID_ROGUE = checkedBlock<HumanoidProfileKey>('HUMANOID_ROGUE', HUMANOID_KEYS);
export const HUMANOID_RAIDER = checkedBlock<HumanoidProfileKey | (typeof FLANK_KEYS)[number]>('HUMANOID_RAIDER', [...HUMANOID_KEYS, ...FLANK_KEYS]);
/** A humanoid enemy's incendiary grenade fire zone (`fx/RogueGrenade` · `parts/Attacks.onFireZoneTick`). */
export const ENEMY_INCENDIARY = checkedBlock<'blastDamage' | 'blastRadius' | 'radius' | 'duration' | 'dps' | 'tick' | 'afterburn'>('ENEMY_INCENDIARY',
  ['blastDamage', 'blastRadius', 'radius', 'duration', 'dps', 'tick', 'afterburn']);
export const NAMED_HEAVY = ability<'spinUp' | 'rof' | 'damage' | 'burstTime' | 'burstCooldown' | 'spread' | 'range' | 'escortRadius' | 'keepMin' | 'keepMax' | 'creepMul' | 'spinMoveMul' | 'linger'>('NAMED_HEAVY');
