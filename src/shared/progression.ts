import type { ImplantId } from './implants';
import type { EmbeddedView, EnvKind, ItemInstance, WeaponClass } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Character stats, skills and the persistent profile.
 * Owner: progression/ProgressionSystem publishes `ctx.progression` and persists a
 * PlayerProfile in localStorage. Stat points may only be spent in the ship.
 * Everything derived from stats/skills is exposed on `derived` so no other folder
 * duplicates a formula.
 * ──────────────────────────────────────────────────────────────────────────── */

export type StatId = 'strength' | 'endurance' | 'perception' | 'intelligence' | 'dexterity';

export const STAT_IDS: readonly StatId[] = ['strength', 'endurance', 'perception', 'intelligence', 'dexterity'];

export type SkillId =
  | 'carry'         // 운반 (근력)
  | 'appraisal'     // 감정 (인지력)
  | 'grit'          // 인내 (지구력)
  | 'gardening'     // 원예 (재주, 지능)
  | 'crafting'      // 제작 (재주, 지능)
  | 'medicine'      // 의학 (지능)
  | 'cryptography'  // 암호학 (지능)
  | 'implant'       // 전술 임플란트 (지능)
  | 'gun_AR' | 'gun_SMG' | 'gun_SR' | 'gun_DMR' | 'gun_SG'  // 사격 (인지력)
  | 'equipment';    // 장비 관리 (재주)

export const SKILL_IDS: readonly SkillId[] = [
  'carry', 'appraisal', 'grit', 'gardening', 'crafting', 'medicine', 'cryptography',
  'implant', 'gun_AR', 'gun_SMG', 'gun_SR', 'gun_DMR', 'gun_SG', 'equipment',
];

export interface StatDef {
  id: StatId;
  name: string;        // 한국어
  description: string;
}

export interface SkillDef {
  id: SkillId;
  name: string;        // 한국어
  description: string;
  /** Stats that scale how fast this skill rises. */
  stats: StatId[];
  /** Weapon class this shooting skill belongs to (undefined for non-shooting skills). */
  weaponClass?: WeaponClass;
}

/** Persisted between raids (localStorage). Bump `version` when the shape changes; older saves are migrated or reset. */
export interface PlayerProfile {
  version: number;
  name: string;
  level: number;
  /** XP toward the next level. */
  xp: number;
  /** Unspent stat points. */
  statPoints: number;
  stats: Record<StatId, number>;
  /** Whole skill levels 0..SKILL_LEVEL_MAX. */
  skills: Record<SkillId, number>;
  /** Fractional progress (0..1) toward the next level of each skill. */
  skillProgress: Record<SkillId, number>;
  /** Implant taken into the next raid. */
  implant: ImplantId | null;
  /** Total raids / extractions, for the ship terminal readout. */
  raids: number;
  extractions: number;
  /* appended (stat XP, 2026-09-06) */
  /**
   * Fractional progress (0..1) toward the next point of each stat (gym equipment, `/stat` cheat). At 1 the stat gains
   * a point (max STAT_MAX), below 0 it loses one (min STAT_MIN). Level-up stat points work as before.
   * Optional so saves from before 2026-09-06 migrate to zeros.
   */
  statProgress?: Record<StatId, number>;
}

/**
 * Every number other systems need. Recomputed by ProgressionSystem whenever stats, skills or gear change.
 * Read it; never re-derive it.
 */
export interface DerivedStats {
  /* 근력 */
  /** Base carry capacity in kg before the backpack bonus. */
  carryCapacity: number;
  meleeDamageMul: number;
  jumpHeightMul: number;
  throwRangeMul: number;
  /** 2026-09-09: flat-ground overhand throw distance (m) — GRENADE_THROW_SPEED × √throwRangeMul ballistics; the sheet shows this, not the multiplier. */
  throwRangeM: number;
  /* 지구력 */
  maxStamina: number;
  staminaRegenMul: number;
  /* 인지력 */
  /** Radius (m) inside which interactables get the fresnel highlight. */
  detectRadius: number;
  /** Radius (m) inside which off-screen enemies get an arrow indicator. */
  enemyDetectRadius: number;
  /* 지능 */
  /** Multiplier on all skill XP gain. */
  skillGainMul: number;
  /* 재주 */
  /** Consumable / gadget use speed. */
  useSpeedMul: number;
  /** Interaction (hold) speed for crates, switches, recovering deployables. */
  interactSpeedMul: number;
  /* skills */
  /** 운반: how much of the 조금 무거움 stamina penalty is cancelled (0..1). */
  carryReliefFactor: number;
  /** 감정: crate search speed multiplier. */
  searchSpeedMul: number;
  /** 인내: chance (0..1) that lethal non-DoT damage leaves 1 hp instead. */
  gritChance: number;
  /** 의학: healing item potency multiplier. */
  healPowerMul: number;
  /** 암호학: extraction ship call speed multiplier (shortens the countdown). */
  shipCallSpeedMul: number;
  /** 전술 임플란트: cooldown multiplier (also folds in the 특수 가방 perk). */
  implantCooldownMul: number;
  /** 사격: per weapon class recoil / reload multipliers. */
  recoilMul: Record<WeaponClass, number>;
  reloadSpeedMul: Record<WeaponClass, number>;
  /** 장비 관리: durability loss multiplier. */
  durabilityLossMul: number;
  /** 원예: herb yield multiplier. */
  gatherYieldMul: number;
  /** 제작: field crafting speed multiplier. */
  craftSpeedMul: number;
}

export interface ProgressionRef {
  readonly profile: PlayerProfile;
  readonly derived: DerivedStats;
  readonly level: number;
  readonly xp: number;
  readonly xpToNext: number;
  readonly statPoints: number;

  getStat(id: StatId): number;
  getSkill(id: SkillId): number;
  getStatDef(id: StatId): StatDef;
  getSkillDef(id: SkillId): SkillDef;
  getAllStatDefs(): readonly StatDef[];
  getAllSkillDefs(): readonly SkillDef[];

  /** Ship only. false during a raid or with no points left. */
  spendStatPoint(id: StatId): boolean;
  /** Raise a skill by `amount` raw points (scaled internally by 지능 and the skill's stats). */
  addSkillXp(id: SkillId, amount: number): void;
  /** Character XP (mission rewards, kills). */
  addXp(amount: number): void;
  /** Shooting skill for a weapon class ('AR' → 'gun_AR'). */
  skillForWeaponClass(cls: WeaponClass): SkillId;

  /** Persist immediately (also autosaved on mission end / level up). */
  save(): void;
  /** Wipe the profile back to a level-1 character. */
  resetProfile(): void;

  /* ── appended: stat XP + raw skill XP (2026-09-06, owner: progression) ── */
  /** 0..1 toward the next point of `id`. */
  getStatProgress(id: StatId): number;
  /** Raw XP for the next point of `id` at its current value (STAT_XP_BASE × value^STAT_XP_EXPONENT). */
  statXpToNext(id: StatId): number;
  /**
   * Add raw stat XP (negative allowed). Crossing 1 → +1 stat (also `progress:statChanged`), dropping below 0 → −1
   * stat (never below STAT_MIN). Emits `progress:statXp`, recomputes `derived` when the value changes, saves.
   */
  addStatXp(id: StatId, amount: number): void;
  /** 0..1 toward the next level of `id`. */
  getSkillProgress(id: SkillId): number;
  /**
   * Signed raw skill XP: no 지능 / stat / level scaling, negative allowed (level −1 when progress drops below 0,
   * never below 0). Cheat / debuff entry point — normal training keeps using `addSkillXp`.
   */
  addSkillXpRaw(id: SkillId, amount: number): void;
  /**
   * External skill-gain multiplier (ship facilities: 사격장 → gun_* skills). Progression reads
   * `ctx.housing?.getSkillGainMul(id)` itself inside `addSkillXp`; this getter exposes the combined value for UI.
   */
  getSkillGainMul(id: SkillId): number;

  /* ══ appended: Phase 8 (2026-09-06) ══════════════════════════════════════ */
  /**
   * Render the 캐릭터 sheet inside `host` (the 캐릭터 tab of the inventory Tab screen) instead of as its own
   * full-screen overlay. The embedded view must not add the `'stats'` blocker, exit the pointer lock or install a
   * window-level Escape listener — the inventory window owns all three.
   */
  createSheetView(host: HTMLElement): EmbeddedView;
}

/* ══ appended: 2026-09-08 — 임플란트(능력치 장착 아이템) · 전설 퍽 ════════════════════════════════════════════════
 * Distinct from the six 전술 임플란트 (`ImplantId`, Q key): these are **items** (`ItemDef.implant`, category
 * 'implant') sold / repaired by 세레스 바이오, looted broken from raids, and slotted on the 캐릭터 tab. The character has
 * `implantSlots` = IMPLANT_SLOTS_BASE + floor(level / IMPLANT_SLOTS_PER_LEVELS), capped at IMPLANT_SLOTS_MAX; each
 * item takes `ItemDef.implant.slots`. Equipped implants add their `stats` to the base stats before `derived` is
 * computed — `getStat(id)` keeps returning the **base** value, `getStatWithImplants(id)` the effective one — and a
 * legendary `perk` becomes `derived.perks[perk] = true`. Owner: progression (rules, storage, 캐릭터 tab UI).
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Legendary implant perks. Effects are read from `derived.perks` by the named owner — never re-derived. */
export type PerkId =
  | 'auto_revive'    // 전투불능 시 레이드당 1회 자동 기상 (owner: player — hp 10 로 즉시 기상, 레이드마다 1회)
  | 'quick_heal'     // 회복 아이템 사용 시간 절반 (owner: weapons — heal hold `useTime × 0.5`)
  | 'kill_stamina';  // 처치 시 스태미나 전량 회복 (owner: player — `enemy:killed.by` 가 로컬이면 stamina = max)

export const PERK_IDS: readonly PerkId[] = ['auto_revive', 'quick_heal', 'kill_stamina'];

export interface PerkDef {
  id: PerkId;
  name: string;        // 한국어
  description: string;
}

export const PERK_DEFS: Readonly<Record<PerkId, PerkDef>> = {
  auto_revive: { id: 'auto_revive', name: '재기동 회로', description: '전투불능이 되면 레이드당 한 번 자동으로 일어난다.' },
  quick_heal: { id: 'quick_heal', name: '가속 대사', description: '회복 아이템 사용 시간이 절반이 된다.' },
  kill_stamina: { id: 'kill_stamina', name: '아드레날린 펌프', description: '적을 처치하면 스태미나가 전부 회복된다.' },
};

/** One equipped implant. The item instance lives here (removed from the inventory grids) until unequipped. */
export interface EquippedImplant {
  uid: string;
  defId: string;
  /** Instance durability, kept so wear survives the round trip (undefined = fresh). */
  durability?: number;
}

export interface PlayerProfile {
  /** appended (2026-09-08): equipped 임플란트 items. Optional so older saves migrate to `[]`. */
  implants?: EquippedImplant[];
}

export interface DerivedStats {
  /** appended (2026-09-08): legendary implant perks currently active. Every key present, false when not equipped. */
  perks: Record<PerkId, boolean>;
}

export interface ProgressionRef {
  /** Total implant slots at the current level (IMPLANT_SLOTS_BASE + level ÷ IMPLANT_SLOTS_PER_LEVELS, ≤ IMPLANT_SLOTS_MAX). */
  readonly implantSlots: number;
  /** Slots occupied by the equipped implants. */
  readonly implantSlotsUsed: number;
  getEquippedImplants(): readonly EquippedImplant[];
  /**
   * Ship only. Takes the item `uid` out of the inventory (`ctx.inventory.takeItem`) and equips it. false — and nothing
   * changes — during a raid, for a non-implant / broken item, or when `slots` would exceed `implantSlots`.
   * Emits `progress:implantsChanged`, recomputes `derived`, saves.
   */
  equipImplant(uid: string): boolean;
  /** Ship only. Returns the item to the 함선 창고 (then the bag; refuses when neither has room). */
  unequipImplant(uid: string): boolean;
  /** Base stat + equipped implant bonuses (what `derived` is computed from). */
  getStatWithImplants(id: StatId): number;
  /** Sum of implant bonuses for `id` (0 when none). */
  getImplantBonus(id: StatId): number;
}

export interface ProgressionRef {
  /* ── appended (2026-09-11, C-12 사용자 결정): 사망하면 장착 임플란트가 몸에서 빠진다 ── */
  /**
   * **Death only** — bypasses the ship gate of `unequipImplant`. Unequips every equipped implant and returns one
   * **broken twin** instance per implant (`brokenImplantIdOf(defId)`, a fresh uid) for the corpse; the working items
   * are gone. Emits `progress:implantsChanged`, recomputes `derived` and **saves at once** (a reload right after dying
   * must not bring them back — same reason as `loadoutStore.saveNow('corpse')`). Called by
   * `InventoryRef.stripForCorpse`; an implant whose def is unknown is dropped without a twin. Empty when none.
   */
  stripImplantsForCorpse?(): ItemInstance[];
}

/**
 * `imp_strength_2` → `imp_broken_strength_2` — the item id of an implant's broken twin (also works for `imp_perk_*`).
 * appended (2026-09-11, C-12): moved here from `items/ImplantDefs` because progression (death strip) and items (the
 * defs) both need the rule. Items re-exports it.
 */
export function brokenImplantIdOf(workingId: string): string {
  return workingId.replace(/^imp_/, 'imp_broken_');
}

/* appended (2026-09-09): 캐릭터 생성 · 슬롯 카드 */
export interface PlayerProfile {
  /**
   * 병사 모델 악센트 색 (`#rrggbb`). 캐릭터 생성창에서 고른다. 없으면 `SOLDIER_DEFAULT_ACCENT`.
   * 3D 프리뷰 · 함선의 내 아바타 · 분대 레이드의 내 병사가 전부 이 색을 쓴다.
   */
  accent?: string;
  /** 캐릭터를 만든 시각 (epoch ms). 슬롯 카드가 정렬 · 표시에 쓴다. 옛 세이브에는 없다. */
  createdAt?: number;
  /** 마지막으로 이 캐릭터로 플레이한 시각 (epoch ms). */
  playedAt?: number;
}

/* ══ appended (2026-09-11, A-13): 준비물 — 다음 레이드 1회분 (사용자 결정) ═══════════════════════════════════
 *
 * 조합대에서 만든 준비물(`ItemDef.prep`)을 **함선에서 쓰면** 그 자리에서 소모돼 `PlayerProfile.prep` 에 대기하고,
 * 출격하는 순간 `prepActive` 로 옮겨져 **그 레이드 내내** 유지된다 (사망해도 그 레이드는 유지 — 장비와 달리
 * 「이미 마신 약」이다). 레이드가 끝나면(탈출 · 전멸 · 포기) 비워진다.
 *
 * 프로필에 사는 것이 요점이다 — 재접속으로 돌아온 사람이 조용히 잃으면 안 된다는 2026-09-10 규약 그대로다.
 * 같은 `env` 는 하나만 실린다 (두 번째 사용은 한국어 사유로 거절하고 아이템을 돌려준다).
 * 주방(A-3c)의 요리 버프가 열리면 같은 두 필드에 얹는다 — 여기가 그 자리다.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

export interface PlayerProfile {
  /** 다음 레이드에 실릴 준비물 item def id (환경당 최대 1개). 옛 세이브에는 없다 = 빈 것. */
  prep?: string[];
  /** 이번 레이드에 실려 있는 준비물. 레이드 밖에서는 비어 있다. */
  prepActive?: string[];
}

export interface ProgressionRef {
  /** 다음 레이드에 실릴 준비물 def id. */
  getPreps(): readonly string[];
  /** 이번 레이드에 실려 있는 준비물 def id (함선에서는 빈 배열). */
  getActivePreps(): readonly string[];
  /**
   * 함선 전용. 준비물 하나를 소비해 다음 레이드분에 싣는다 (아이템은 부르는 쪽이 이미 뺐거나, 구현이
   * `ctx.inventory.consumeDefAll` 로 뺀다 — 구현 폴더가 정한다). 같은 환경을 이미 준비했거나 레이드 중이면
   * 한국어 사유를 돌려주고 **아무것도 바꾸지 않는다**. null = 실렸다.
   */
  usePrep(defId: string): string | null;
  /** 이번 레이드에 `env` 를 막아 주는 준비물이 실려 있나. player 가 환경 피해를 줄지 정할 때 묻는다. */
  hasEnvPrep(env: EnvKind): boolean;
  /**
   * 출격: 대기분을 이번 레이드분으로 옮긴다 (game/ 이 레이드 시작 때 한 번).
   * 2026-09-11 (A-3c): **식사 칸도 함께 옮긴다** (`meal` → `mealActive`) — 그래서 `game/` 은 한 줄도 안 바뀐다.
   */
  armPreps(): void;
  /**
   * 레이드 종료: 이번 레이드분을 비운다 (game/ 이 한 번).
   * 2026-09-11 (A-3c): **식사 칸도 함께 비운다** (`mealActive` → null).
   */
  clearActivePreps(): void;
}

/* ══ appended (2026-09-11, A-3c): 식사 — 다음 레이드 1회분 (사용자 결정: 별도 「식사」 칸 1개) ═══════════════
 *
 * 주방의 조리대에서 만든 요리(`ItemDef.meal`)를 **함선의 식탁에서 먹으면** 그 자리에서 소모돼
 * `PlayerProfile.meal` 에 대기하고, 출격하는 순간 `mealActive` 로 옮겨져 그 레이드 내내 유지된다.
 * 수명 규칙은 준비물과 **완전히 같다** (사망해도 그 레이드는 유지 — 「이미 먹은 밥」).
 *
 * 준비물(`prep`)과 **자리를 다투지 않는다** (사용자 결정): 환경 준비물은 환경당 1개, 식사는 따로 1칸이다.
 * 그래서 배열이 아니라 문자열 하나이고, 두 번째 요리를 먹으면 **교체된다** (거절이 아니다 — 준비물과 다른 점).
 *
 * 버프는 `MealDef.buff` 가 가리키는 **파생 수치**에 접힌다 (`DerivedStats` 의 필드 이름 그대로) — 그래서
 * player · weapons · world · inventory 는 한 줄도 안 바뀐다. `mealActive` 가 바뀌면 `derived` 를 다시 계산한다.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

export interface PlayerProfile {
  /** 다음 레이드에 실릴 요리 item def id. 고정 1칸이라 배열이 아니다. 없거나 null = 안 먹었다. */
  meal?: string | null;
  /** 이번 레이드에 실려 있는 요리. 레이드 밖에서는 null. */
  mealActive?: string | null;
}

export interface ProgressionRef {
  /** 다음 레이드에 실릴 요리 def id, 없으면 null. */
  getMeal(): string | null;
  /** 이번 레이드에 실려 있는 요리 def id (함선에서는 null). */
  getActiveMeal(): string | null;
  /**
   * 함선 전용. 요리 하나를 다음 레이드분에 싣는다 (아이템을 빼는 것은 부르는 쪽 — `usePrep` 과 같은 규약이라
   * **먼저 묻고 성공할 때만** 뺀다). 이미 차려 둔 요리가 있으면 **조용히 교체**한다: 식사는 칸이 하나뿐이고
   * 「바꿔 먹는다」가 자연스럽다. 레이드 중이거나 요리가 아니면 한국어 사유, 성공하면 null.
   */
  useMeal(defId: string): string | null;
  /**
   * 공유 함선 식탁: 남이 차려 준 요리를 **아이템 소모 없이** 받는다 (사용자 결정: 한 명이 차리면 분대 전원).
   * 이미 먹은 사람은 교체된다. 받는 쪽 가드는 net 이 한다 — **로비 호스트가 보낸 것만** 여기까지 온다
   * (「남에게 영향 주는 메시지는 권위에서만 받는다」 E-4).
   */
  serveMeal(defId: string): void;
}

/* ══ appended (2026-09-12, A-3a): 헬스장 — 단련 보너스 · 운동 디버프 (사용자 결정: 스탯 포인트와 따로 센다) ═══════════════
 *
 * 운동 기구 미니게임을 끝내면 housing 이 `applyGymSession(stat, 점수)` 를 부른다. 점수(0 … 1)가 **단련 경험치**
 * (`round(GYM_SESSION_XP × 점수)`)가 되고, 경험치가 `trainedXpToNext` 를 넘으면 그 능력치의 **단련 보너스** `trained[stat]` 가
 * +1 이다 (상한 `GYM_TRAINED_MAX`, 넘친 경험치는 다음 단계로 이월, 상한이면 진행도 1).
 *
 * 단련 보너스는 스탯 포인트(`stats`)와 섞이지 않는다 — `getStat` 은 여전히 기본값이고, 임플란트 보너스처럼 `derived` 를
 * 계산하기 직전에 더해지며(`getStatWithImplants` = 기본 + 임플란트 + 단련, 「`derived` 가 계산되는 값」 이라는 뜻 그대로)
 * 캐릭터 시트는 `10 (+2 단련)` 처럼 따로 보여 준다. `STAT_MAX` 로 자르지 않는다 (임플란트와 같은 의도).
 *
 * 세션을 끝낼 때 그 능력치에 디버프가 없으면 `gymFatigueUntil[stat] = 지금 + GYM_FATIGUE_HOURS` 가 걸린다 (근력 = 근육통 ·
 * 지구력 = 심폐 피로). 디버프 중의 세션은 경험치 × `GYM_FATIGUE_GAIN_MUL`(0 = −100 %)이고 디버프를 **다시 늘리지 않는다**.
 * 점수가 0 이어도 끝낸 세션이면 디버프가 걸린다 (「가구를 사용하면」). 시각은 `ctx.net.serverNow() ?? Date.now()` (온실과 같은
 * 현실 시간). 세 필드 모두 프로필에 살며 `Profile.migrate` 가 옮겨 담아야 새로고침을 견딘다 (2026-09-09 `accent` 사고와 같은 자리).
 * `resetProfile` 은 셋을 비운다.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** 운동으로 단련하는 능력치. */
export type GymStat = Extract<StatId, 'strength' | 'endurance'>;
export const GYM_STATS: readonly GymStat[] = ['strength', 'endurance'];
/** 디버프 이름 — 근력 운동 뒤 근육통, 지구력 운동 뒤 심폐 피로 (사용자 명세). */
export const GYM_FATIGUE_LABEL_KO: Readonly<Record<GymStat, string>> = { strength: '근육통', endurance: '심폐 피로' };

export interface PlayerProfile {
  /** 운동으로 얻은 단련 보너스 (정수, 0 … GYM_TRAINED_MAX). 옛 세이브에는 없다 = 0. */
  trained?: Partial<Record<GymStat, number>>;
  /** 다음 단련 보너스까지의 진행도 0 … 1 (상한이면 1). */
  trainedProgress?: Partial<Record<GymStat, number>>;
  /** 운동 디버프가 끝나는 시각 (epoch ms). 지난 값은 「디버프 없음」 과 같다. */
  gymFatigueUntil?: Partial<Record<GymStat, number>>;
}

/** `applyGymSession` 의 결과 — 결과 화면 · `housing:gymResult` 가 그대로 쓴다. */
export interface GymSessionResult {
  stat: GymStat;
  /** 0 … 1 로 자른 점수. */
  score: number;
  /** 실제로 더해진 단련 경험치 (디버프 중이었으면 0). */
  xp: number;
  /** 세션을 끝낸 순간 이미 디버프 중이었다 (그래서 xp 가 0 이고 디버프는 늘지 않았다). */
  wasFatigued: boolean;
  trainedBefore: number;
  trainedAfter: number;
  /** 세션 뒤 다음 단련까지의 진행도 0 … 1. */
  progress: number;
  /** 단련 보너스가 상한이다. */
  capped: boolean;
  /** 디버프가 끝나는 시각 (epoch ms). */
  fatigueUntil: number;
}

export interface ProgressionRef {
  /** 운동으로 얻은 단련 보너스 (운동 능력치가 아니면 0). */
  getTrainedBonus?(id: StatId): number;
  /** 다음 단련 보너스까지의 진행도 0 … 1. */
  getTrainedProgress?(id: StatId): number;
  /** 지금 단계에서 다음 단련 보너스에 필요한 경험치. */
  trainedXpToNext?(id: StatId): number;
  /** 운동 디버프가 끝나는 시각 (epoch ms). 디버프가 없거나 지났으면 0. */
  getGymFatigueUntil?(id: StatId): number;
  /**
   * 함선 전용. 끝낸 운동 세션 하나를 반영한다 — 단련 경험치를 더하고(디버프 중이면 0), 디버프가 없었으면 건다.
   * `progress:trainedChanged` · (디버프를 걸었으면) `progress:gymFatigue` 를 내고, 보너스가 바뀌면 `derived` 를 다시 계산하고
   * 즉시 저장한다. 레이드 중이거나 운동 능력치가 아니면 null (아무것도 바꾸지 않는다).
   */
  applyGymSession?(id: GymStat, score: number): GymSessionResult | null;
}
