import type { ImplantId } from './implants';
import type { EmbeddedView, WeaponClass } from './types';

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
