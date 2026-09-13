import { addDataIssue, csvRows, numberMap, stringMap, type EnemyFaction, type EnemyType } from '@/shared';

/*
 * 적 수치의 원본은 `data/enemies.csv` (종류별 기본 스탯) 과 `data/enemy_abilities.csv` (특수 능력) 이다.
 * 이 파일에는 표가 없고 그 두 csv 를 타입 있는 객체로 옮기는 코드만 있다.
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
}

/** 적 종류를 csv `type` 칸이 받는 순서 — `ALL_ENEMY_TYPES` 와 같은 목록이다. */
const ENEMY_TYPE_VALUES: readonly EnemyType[] = ['scavenger', 'hunter', 'warrior', 'spewer', 'charger', 'rogue', 'rogue_boss', 'artillery', 'toxic', 'behemoth', 'rogue_sniper', 'rogue_hammer', 'rogue_heavy', 'rogue_scan_drone', 'android', 'raider', 'sandworm'];
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
    };
  }
  for (const t of ENEMY_TYPE_VALUES) {
    if (!out[t]) addDataIssue({ file: 'enemies.csv', line: 0, column: t, message: `'${t}' 줄이 없다` });
  }
  return out;
})();

/* Type-specific ability tuning — data/enemy_abilities.csv */
const ability = <K extends string>(block: string): Record<K, number> => numberMap<K>('enemy_abilities.csv', block, 'block');

export const HUNTER_LEAP = ability<'minDist' | 'maxDist' | 'damage' | 'cooldown' | 'flightTime' | 'hitRadius'>('HUNTER_LEAP');
export const SPEWER_SPIT = ability<'minDist' | 'maxDist' | 'damage' | 'splashDamage' | 'slowDuration' | 'cooldown' | 'windup' | 'deathBurstRadius' | 'deathBurstDamage'>('SPEWER_SPIT');
export const CHARGER_CHARGE = ability<'minDist' | 'maxDist' | 'windup' | 'speed' | 'damage' | 'maxDuration' | 'stumble' | 'cooldown'>('CHARGER_CHARGE');

/* Phase 4 ability tuning (world constants live in @/shared/constants: ROGUE_*, ARTILLERY_RANGE, SHELL_*, TOXIC_*, BEHEMOTH_*) */
const ROGUE_AI_TEXT = stringMap<'weapons' | 'bossWeapon'>('enemy_abilities.csv', 'ROGUE_AI_TEXT', 'block');
/**
 * 숫자는 `ROGUE_AI` 블록, 무기 목록은 `ROGUE_AI_TEXT` 블록이다 (한 블록은 전부 숫자거나 전부 문자열이어야 한다).
 * coverMin/coverMax = 엄폐 유지 시간(s), shotGap = 점사 간격(s), rushMax = 돌격 지속(s), rushDist = 돌격 정지 거리(m),
 * settleTime = 정지 후 조준이 가라앉는 시간(s), leash/escortLeash = 상자·보스로부터의 리시(m),
 * bugRange = 플레이어가 있어도 이 거리 안의 벌레는 쏜다(m), hitCrouch = 피격 후 웅크림(s),
 * bossRounds/bossDamageMul = 보스 연사 수·피해 배수, range = 히트스캔 사거리(m).
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
 */
export const ARTILLERY_AI = ability<'retreatDist' | 'approachDist' | 'fireMin' | 'fireMax' | 'digTime' | 'maxRange' | 'spawnMin' | 'spawnMax' | 'maxRefusals' | 'refusalCooldown'>('ARTILLERY_AI');
export const TOXIC_AI = ability<'swell'>('TOXIC_AI');
export const BEHEMOTH_AI = ability<'engageDist' | 'chargeCooldown' | 'overshoot' | 'maxDuration' | 'enemyDamage' | 'enemyShove' | 'stumble'>('BEHEMOTH_AI');

export const ALL_ENEMY_TYPES: readonly EnemyType[] = ['scavenger', 'hunter', 'warrior', 'spewer', 'charger', 'rogue', 'rogue_boss', 'artillery', 'toxic', 'behemoth', 'rogue_sniper', 'rogue_hammer', 'rogue_heavy', 'rogue_scan_drone', 'android', 'raider', 'sandworm'];
/**
 * 2026-09-13: 지하벌레 — 여섯 다리 리그도 인간형 리그도 아닌 **자기 리그**(`models/WormModel`)를 쓴다. 땅에 박힌 채 움직이지 않으며
 * AI 는 `sandworm/Director` 가 돌린다 (`ai/EnemyAI` 는 이 종류를 곧장 돌려보낸다).
 */
export const isWormType = (t: EnemyType): t is 'sandworm' => t === 'sandworm';
/** Types rendered with the six-legged bug rig (everything but the humanoid rogues). 2026-09-11: 네임드 3종 + 스캔 드론도 버그 리그가 아니다. 2026-09-13: 안드로이드 · 레이더도. */
export type BugType = Exclude<EnemyType, 'rogue' | 'rogue_boss' | 'rogue_sniper' | 'rogue_hammer' | 'rogue_heavy' | 'rogue_scan_drone' | 'android' | 'raider' | 'sandworm'>;
/**
 * Humanoid rogue rig (`models/RogueModel`). 2026-09-11: 네임드 3종 포함. 스캔 드론은 계약 단계에서 임시로 여기 들어 있다 —
 * 스캔 드론 담당이 자기 리그를 만들면 이 줄에서 뺀다. 2026-09-13: 안드로이드 · 레이더 (같은 리그, 다른 외피).
 * ⚠ 이름과 달리 **리그** 판정이다 — "로그 팩션인가" 는 `Enemy.isRogue`, "벌레가 아닌 인간형 AI 인가" 는 `Enemy.isHumanoid`.
 */
export const isRogueType = (t: EnemyType): boolean => t === 'rogue' || t === 'rogue_boss' || t === 'rogue_sniper' || t === 'rogue_hammer' || t === 'rogue_heavy' || t === 'rogue_scan_drone' || t === 'android' || t === 'raider';

/* ── 2026-09-11: 네임드 로그 (shared/named.ts) — ai/named/* 가 읽는다. 키를 더할 때는 그 블록의 유니온 한 줄과 csv 블록에 같이 넣는다. ── */
export const NAMED_SNIPER = ability<'droneRange' | 'detectRange' | 'droneCooldown' | 'droneRetry' | 'scanPulses' | 'exposeNeeded' | 'scannedAccuracy' | 'nearAccuracyMax' | 'nearAccuracyMin' | 'damage' | 'fireInterval' | 'glintTime' | 'range' | 'relocateCooldown' | 'nestLeash' | 'closeThreat' | 'scanWait' | 'proneTurnRate'>('NAMED_SNIPER');
export const NAMED_SCAN_DRONE = ability<'altitude' | 'speed' | 'pulseInterval' | 'pulseRadius' | 'loiterMax'>('NAMED_SCAN_DRONE');
export const NAMED_HAMMER = ability<'windup' | 'chargeDist' | 'chargeSpeed' | 'chargeCooldown' | 'structureRadius' | 'giveUpDist' | 'giveUpTime' | 'patrolRadius'>('NAMED_HAMMER');
/* ── 2026-09-13: 행성별 인간형 팩션 — 스폰이 쥐여 주는 총 계열 (`items/WeaponDefs` 의 계열 id, 등급은 시체 전리품이 굴린다). ── */
const HUMANOID_WEAPONS_TEXT = stringMap<'android' | 'rogue' | 'raider'>('enemy_abilities.csv', 'HUMANOID_WEAPONS', 'block');
const splitIds = (s: string | undefined): readonly string[] => (s ?? '').split('|').map((w) => w.trim()).filter(Boolean);
export const HUMANOID_WEAPONS: Readonly<Record<'android' | 'rogue' | 'raider', readonly string[]>> = {
  android: splitIds(HUMANOID_WEAPONS_TEXT.android),
  rogue: splitIds(HUMANOID_WEAPONS_TEXT.rogue),
  raider: splitIds(HUMANOID_WEAPONS_TEXT.raider),
};
/* ── 2026-09-13: 인간형 팩션 AI 프로필 (`ai/HumanoidProfile.ts` 가 읽는다) — csv 블록 HUMANOID_ANDROID · HUMANOID_ROGUE · HUMANOID_RAIDER ── */
const HUMANOID_KEYS = ['reaction', 'aimNear', 'aimFar', 'aimNearDist', 'aimFarDist', 'settleMul', 'burstMin', 'burstMax', 'shotGap', 'burstPause',
  'burstsPerPop', 'coverMul', 'rushChance', 'damageMul', 'enemyDamageMul', 'bugBackoff', 'grenadeMin', 'grenadeMax', 'incendiaryChance', 'grenadeRange', 'grenadeScatter'] as const;
const ANDROID_KEYS = ['engageMin', 'engageMax', 'advanceMul'] as const;
const FLANK_KEYS = ['flankDelay', 'flankCooldown', 'flankMinDist', 'flankMaxDist', 'flankRadius', 'flankBehind', 'flankArcStep', 'flankArrive', 'flankSpeedMul', 'flankMaxTime'] as const;
export type HumanoidProfileKey = (typeof HUMANOID_KEYS)[number];
export type HumanoidProfile = Readonly<Record<HumanoidProfileKey, number>>;
/** `numberMap` 은 빠진 키를 알리지 않는다 — 오타 한 글자가 NaN 사격이 되지 않게 블록마다 확인한다. */
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
/** 인간형 적의 소이 수류탄 화염 지대 (`fx/RogueGrenade` · `parts/Attacks.onFireZoneTick`). */
export const ENEMY_INCENDIARY = checkedBlock<'blastDamage' | 'blastRadius' | 'radius' | 'duration' | 'dps' | 'tick' | 'afterburn'>('ENEMY_INCENDIARY',
  ['blastDamage', 'blastRadius', 'radius', 'duration', 'dps', 'tick', 'afterburn']);
export const NAMED_HEAVY = ability<'spinUp' | 'rof' | 'damage' | 'burstTime' | 'burstCooldown' | 'spread' | 'range' | 'escortRadius' | 'keepMin' | 'keepMax' | 'creepMul' | 'spinMoveMul' | 'linger'>('NAMED_HEAVY');
