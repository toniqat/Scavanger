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
  /**
   * 2026-09-16: 이 종류를 내 막타로 처치하면 레이드 끝에 받는 캐릭터 경험치 (1마리당, csv `raidXp`). 레이드 경험치의 **유일한** 원천이다 —
   * 킬 자리(`parts/Damage.onEnemyKilled` · `net/Replica` `kill`)가 `ctx.stats.killXp` 에 더하고 `game/` 이 정산한다.
   */
  raidXp: number;
}

/** 적 종류를 csv `type` 칸이 받는 순서 — `ALL_ENEMY_TYPES` 와 같은 목록이다. */
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
 * 2026-09-16: 처치 1마리의 레이드 경험치 (`EnemyStats.raidXp`). 와이어에서 온 모르는 종류 · 잘못된 값은 0 — 킬 카운트는 그대로 센다.
 * 두 킬 자리(권위 `parts/Damage.onEnemyKilled`, 복제 `net/Replica` `kill`)가 **같은 조건**(내 막타)에서 이것만 더한다.
 */
export function raidXpOf(type: EnemyType): number {
  const xp = ENEMY_STATS[type]?.raidXp;
  return typeof xp === 'number' && Number.isFinite(xp) && xp > 0 ? xp : 0;
}

/* Type-specific ability tuning — data/enemy_abilities.csv */
const ability = <K extends string>(block: string): Record<K, number> => numberMap<K>('enemy_abilities.csv', block, 'block');

/**
 * 2026-09-17: `arcGravityMul` = 도약 포물선의 중력 배수 · `flipDamage` = 한 도약 동안 누적 피해가 이 이상이면 뒤집힌다 ·
 * `flipDuration` = 뒤집혀 있는 s (`ai/HunterFlip.ts`).
 */
export const HUNTER_LEAP = ability<'minDist' | 'maxDist' | 'damage' | 'cooldown' | 'flightTime' | 'hitRadius' | 'arcGravityMul' | 'flipDamage' | 'flipDuration'>('HUNTER_LEAP');
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
 * 2026-09-17 (포병 호위 · 사격 조건 · 발사 자세 · 1회 소환 — `ai/ArtilleryPack.ts`): `escortMin/Max` · `escortFollowDist` · `packRingMin/Max` ·
 * `supportRadius` · `supportCheckS` · `braceTime` · `postFireLock` · `summonMin/Max` (뜻은 csv 블록 머리말).
 * 2026-09-18 (포격 준비 · 부대 재소환): `prepTime` · `squadCooldown` 이 붙었다 — 「평생 한 번」 제한은 없어졌다.
 */
export const ARTILLERY_AI = ability<'retreatDist' | 'approachDist' | 'fireMin' | 'fireMax' | 'digTime' | 'maxRange' | 'spawnMin' | 'spawnMax' | 'maxRefusals' | 'refusalCooldown'
  | 'escortMin' | 'escortMax' | 'escortFollowDist' | 'packRingMin' | 'packRingMax' | 'supportRadius' | 'supportCheckS' | 'braceTime' | 'postFireLock' | 'summonMin' | 'summonMax'
  /* 2026-09-18 (사용자 결정 — 포격 준비 · 자기 부대 재소환): `prepTime` = 표적 곁에 벌레가 생긴 뒤 첫 발까지의 준비 s ·
     `squadCooldown` = 제 스캐빈저가 전멸한 뒤 새 무리를 부르기까지의 s (뜻은 csv 블록 머리말). */
  | 'prepTime' | 'squadCooldown'>('ARTILLERY_AI');
export const TOXIC_AI = ability<'swell'>('TOXIC_AI');
/**
 * 2026-09-17 (사용자 결정): 적이 **다른 적**에게 주는 피해 배수 (1/3). 플레이어 · 안드로이드 분대원 · 드론 · 차량에게 주는 피해는 받지 않는다.
 * 쓰는 곳: `parts/Damage.applyDamage` 의 적 가지, `parts/Attacks` (총 · 수류탄 · 소이 지대 · 포탄 · 독성 자폭), `sandworm/Director` 분출.
 * 베헤모스 돌진은 전용 값(`BEHEMOTH_AI.enemyDamage`)을 직접 줄였다. 환경 재해(`HAZARD_ENEMY_DPS`)는 빠진다.
 */
export const ENEMY_CLASH = ability<'damageMul'>('ENEMY_CLASH');
export const BEHEMOTH_AI = ability<'engageDist' | 'chargeCooldown' | 'overshoot' | 'maxDuration' | 'enemyDamage' | 'enemyShove' | 'stumble'>('BEHEMOTH_AI');

export const ALL_ENEMY_TYPES: readonly EnemyType[] = ['scavenger', 'hunter', 'warrior', 'spewer', 'charger', 'rogue', 'rogue_boss', 'artillery', 'toxic', 'behemoth', 'rogue_sniper', 'rogue_hammer', 'rogue_heavy', 'rogue_scan_drone', 'android', 'raider', 'sandworm', 'tut_bug_loot', 'tut_bug', 'tut_android_loot', 'tut_android', 'sandworm_weak', 'scavenger_summon', 'bug_egg'];

/* ── 2026-09-14 3차: 튜토리얼 전용 4종 (`docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」) ──────────────────
 *
 * 이 네 종류가 새로 갖는 것은 **고정 드롭 표** 하나뿐이다 (`data/loot_corpses.csv` · `loot_corpse_rolls.csv`).
 * 리그 · 겉모습 · AI · 소리는 **바탕 종류**의 것을 그대로 쓴다 — 그래서 타입별 표(`BUG_PARAMS` · `ROGUE_RIG_PARAMS` ·
 * `STEP_VOICES` · `MELEE_VOICES` …)에 줄을 더하지 않고, 그 표를 읽는 자리에서 `baseTypeOf` 를 한 번 지난다.
 * 표에 줄을 더했다면 튜토리얼 벌레만 다른 지오메트리를 새로 굽고(셰이더 예산), 새 종류를 넣을 때마다 표 대여섯 개를
 * 함께 고쳐야 했을 것이다.
 *
 * `data/enemies.csv` 의 수치는 **자기 줄**을 쓴다 (안드로이드 체력 절반이 그 줄에 있다) — 바탕 종류는 "무엇처럼
 * 생겼고 무엇처럼 움직이나" 만 답한다.
 */
export type TutorialEnemyType = 'tut_bug_loot' | 'tut_bug' | 'tut_android_loot' | 'tut_android';
/** 튜토리얼 종류 → 바탕 종류. 여기 있는 id 가 `world/tutorial` 의 목록이 쓰는 계약 id 다. */
export const TUTORIAL_ENEMY_BASE: Readonly<Record<TutorialEnemyType, EnemyType>> = {
  tut_bug_loot: 'scavenger',
  tut_bug: 'scavenger',
  tut_android_loot: 'android',
  tut_android: 'android',
};
export const isTutorialEnemyType = (t: EnemyType): t is TutorialEnemyType =>
  Object.prototype.hasOwnProperty.call(TUTORIAL_ENEMY_BASE, t);
/* ── 2026-09-17: 포병의 소환 스캐빈저 — 튜토리얼 종류와 같은 요령으로 리그 · AI · 소리를 바탕 종류에서 빌린다 (다른 것은 드롭 0 % 뿐). ── */
export type VariantEnemyType = 'scavenger_summon';
/** 본편 변종 → 바탕 종류. 튜토리얼 종류가 아니므로 `isTutorialEnemyType` 은 false 다. */
export const VARIANT_ENEMY_BASE: Readonly<Record<VariantEnemyType, EnemyType>> = {
  scavenger_summon: 'scavenger',
};
export const isVariantEnemyType = (t: EnemyType): t is VariantEnemyType =>
  Object.prototype.hasOwnProperty.call(VARIANT_ENEMY_BASE, t);
/**
 * 리그 · 겉모습 · AI 가지 · 소리를 고를 때 쓰는 종류. 튜토리얼 전용 종류 · 본편 변종(2026-09-17 소환 스캐빈저)이면 바탕 종류, 아니면 자기 자신이다
 * (본편 · 훈련장의 모든 적은 **첫 줄에서 자기 자신을 그대로** 돌려받는다).
 */
export const baseTypeOf = (t: EnemyType): EnemyType =>
  (isTutorialEnemyType(t) ? TUTORIAL_ENEMY_BASE[t] : isVariantEnemyType(t) ? VARIANT_ENEMY_BASE[t] : t);
/**
 * 2026-09-13: 땅굴벌레 — 여섯 다리 리그도 인간형 리그도 아닌 **자기 리그**(`models/WormModel`)를 쓴다. 땅에 박힌 채 움직이지 않으며
 * AI 는 `sandworm/Director` 가 돌린다 (`ai/EnemyAI` 는 이 종류를 곧장 돌려보낸다).
 */
/**
 * 2026-09-15: 위협 1 행성의 **어린 땅굴벌레** `sandworm_weak` 도 같은 리그 · 같은 디렉터다 — 다른 것은 `data/enemies.csv` 의 자기 줄
 * (`SANDWORM_WEAK_SCALE` 배 크기 · `SANDWORM_WEAK_HP` 체력)과 디렉터의 뱉기 목록(스캐빈저만) · 분출 반경 배수뿐이다.
 * 종류 분기는 **늘 이 함수**로 한다 (`=== 'sandworm'` 을 쓰면 어린 개체가 빠진다).
 */
export type WormEnemyType = 'sandworm' | 'sandworm_weak';
export const isWormType = (t: EnemyType): t is WormEnemyType => t === 'sandworm' || t === 'sandworm_weak';
/**
 * 2026-09-18 (사용자 결정 「벌레 알을 파괴 가능한 적으로」): **벌레 알** — 둥지 밑동에 박힌 채 움직이지 · 돌지 · 공격하지 · 알아채지
 * 않는 팩션 bug 의 표적. 여섯 다리 리그도 인간형 리그도 아닌 **자기 리그**(`models/EggModel`)를 쓰고 AI 는 없다
 * (`ai/EnemyAI.updateEnemyAI` 가 첫 줄에서 돌려보낸다). 종류 분기는 늘 이 함수로 한다.
 */
export type EggEnemyType = 'bug_egg';
export const isEggType = (t: EnemyType): t is EggEnemyType => t === 'bug_egg';
/** Types rendered with the six-legged bug rig (everything but the humanoid rogues). 2026-09-11: 네임드 3종 + 스캔 드론도 버그 리그가 아니다. 2026-09-13: 안드로이드 · 레이더도. */
export type BugType = Exclude<EnemyType, 'rogue' | 'rogue_boss' | 'rogue_sniper' | 'rogue_hammer' | 'rogue_heavy' | 'rogue_scan_drone' | 'android' | 'raider' | WormEnemyType | TutorialEnemyType | VariantEnemyType
  /* 2026-09-18: 벌레 알도 자기 리그다 (`models/EggModel`) — 버그 리그 표(`BUG_PARAMS`)에 줄이 없다. */
  | EggEnemyType>;
/**
 * Humanoid rogue rig (`models/RogueModel`). 2026-09-11: 네임드 3종 포함. 스캔 드론은 계약 단계에서 임시로 여기 들어 있다 —
 * 스캔 드론 담당이 자기 리그를 만들면 이 줄에서 뺀다. 2026-09-13: 안드로이드 · 레이더 (같은 리그, 다른 외피).
 * ⚠ 이름과 달리 **리그** 판정이다 — "로그 팩션인가" 는 `Enemy.isRogue`, "벌레가 아닌 인간형 AI 인가" 는 `Enemy.isHumanoid`.
 */
export const isRogueType = (t: EnemyType): boolean => t === 'rogue' || t === 'rogue_boss' || t === 'rogue_sniper' || t === 'rogue_hammer' || t === 'rogue_heavy' || t === 'rogue_scan_drone' || t === 'android' || t === 'raider'
  /* 2026-09-14 3차: 튜토리얼 안드로이드도 같은 인간형 리그다 (`baseTypeOf` 가 외피를 고른다). 튜토리얼 벌레는 그대로 버그 리그. */
  || t === 'tut_android' || t === 'tut_android_loot';

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
