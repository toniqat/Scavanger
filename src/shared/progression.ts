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
  | 'carry'         // `운반` hauling (strength)
  | 'appraisal'     // `감정` appraisal (perception)
  | 'grit'          // `인내` grit (endurance)
  | 'gardening'     // `원예` gardening (dexterity, intelligence)
  | 'crafting'      // `제작` crafting (dexterity, intelligence)
  | 'medicine'      // `의학` medicine (intelligence)
  | 'cryptography'  // `암호학` cryptography (intelligence)
  | 'implant'       // `전술 임플란트` tactical implants (intelligence)
  | 'gun_AR' | 'gun_SMG' | 'gun_SR' | 'gun_DMR' | 'gun_SG'  // `사격` shooting (perception)
  | 'equipment'     // `장비 관리` gear maintenance (dexterity)
  /* appended (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) */
  | 'cooking'       // `요리` cooking (dexterity) — the cook-step score (the automatic one included)
  | 'research'      // `연구` research (intelligence) — analysis time · material refunds at the extractor / mixing bench / 3D printer
  /* appended (2026-09-16, user's decision): planet ore veins */
  | 'mining';       // `채광` mining (dexterity) — the rarity of the unidentified ore a vein yields goes up

export const SKILL_IDS: readonly SkillId[] = [
  'carry', 'appraisal', 'grit', 'gardening', 'crafting', 'medicine', 'cryptography',
  'implant', 'gun_AR', 'gun_SMG', 'gun_SR', 'gun_DMR', 'gun_SG', 'equipment',
  /* appended (2026-09-13) */
  'cooking', 'research',
  /* appended (2026-09-16) */
  'mining',
];

export interface StatDef {
  id: StatId;
  name: string;        // Korean
  description: string;
}

export interface SkillDef {
  id: SkillId;
  name: string;        // Korean
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
  /* strength */
  /** Base carry capacity in kg before the backpack bonus. */
  carryCapacity: number;
  meleeDamageMul: number;
  jumpHeightMul: number;
  throwRangeMul: number;
  /** 2026-09-09: flat-ground overhand throw distance (m) — GRENADE_THROW_SPEED × √throwRangeMul ballistics; the sheet shows this, not the multiplier. */
  throwRangeM: number;
  /* endurance */
  maxStamina: number;
  staminaRegenMul: number;
  /* perception */
  /** Radius (m) inside which interactables get the fresnel highlight. */
  detectRadius: number;
  /** Radius (m) inside which off-screen enemies get an arrow indicator. */
  enemyDetectRadius: number;
  /* intelligence */
  /** Multiplier on all skill XP gain. */
  skillGainMul: number;
  /* dexterity */
  /** Consumable / gadget use speed. */
  useSpeedMul: number;
  /** Interaction (hold) speed for crates, switches, recovering deployables. */
  interactSpeedMul: number;
  /* skills */
  /** `운반` (hauling): how much of the 「조금 무거움」 stamina penalty is cancelled (0..1). */
  carryReliefFactor: number;
  /** `감정` (appraisal): crate search speed multiplier. */
  searchSpeedMul: number;
  /** `인내` (grit): chance (0..1) that lethal non-DoT damage leaves 1 hp instead. */
  gritChance: number;
  /** `의학` (medicine): healing item potency multiplier. */
  healPowerMul: number;
  /** `암호학` (cryptography): extraction ship call speed multiplier (shortens the countdown). */
  shipCallSpeedMul: number;
  /** `전술 임플란트` (tactical implants): cooldown multiplier (also folds in the `특수 가방` perk). */
  implantCooldownMul: number;
  /** `사격` (shooting): per weapon class recoil / reload multipliers. */
  recoilMul: Record<WeaponClass, number>;
  reloadSpeedMul: Record<WeaponClass, number>;
  /** `장비 관리` (gear maintenance): durability loss multiplier. */
  durabilityLossMul: number;
  /** `원예` (gardening): herb yield multiplier. */
  gatherYieldMul: number;
  /** `제작` (crafting): field crafting speed multiplier. */
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
  /** Raise a skill by `amount` raw points (scaled internally by `지능` (intelligence) and the skill's stats). */
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
   *
   * appended (2026-09-17, user's decision 「단련은 능력치 경험치 바를 같이 쓴다」 — training shares the stat XP bar):
   * `source` — omitted = `'action'` (exactly the rule above). `'minigame'` (the gym · video games, `GYM_STATS` only,
   * positive only) fills **the same bar**, but when that addition crosses the bar it is not the base stat that rises
   * but the training bonus `trained[stat]`, by +1 (`progress:trainedChanged`). At `GYM_TRAINED_MAX` training the bar
   * stops just short of full (0.999999) and the overflow is dropped — the next action XP that crosses it gives the
   * base stat +1. The rule itself: `ProgressionSystem.addStatXp`.
   */
  addStatXp(id: StatId, amount: number, source?: StatXpSource): void;
  /** 0..1 toward the next level of `id`. */
  getSkillProgress(id: SkillId): number;
  /**
   * Signed raw skill XP: no `지능` (intelligence) / stat / level scaling, negative allowed (level −1 when progress
   * drops below 0, never below 0). Cheat / debuff entry point — normal training keeps using `addSkillXp`.
   */
  addSkillXpRaw(id: SkillId, amount: number): void;
  /**
   * External skill-gain multiplier (ship facilities: `사격장` the firing range → gun_* skills). Progression reads
   * `ctx.housing?.getSkillGainMul(id)` itself inside `addSkillXp`; this getter exposes the combined value for UI.
   */
  getSkillGainMul(id: SkillId): number;

  /* ══ appended: Phase 8 (2026-09-06) ══════════════════════════════════════ */
  /**
   * Render the `캐릭터` (character) sheet inside `host` (the `캐릭터` tab of the inventory Tab screen) instead of as its own
   * full-screen overlay. The embedded view must not add the `'stats'` blocker, exit the pointer lock or install a
   * window-level Escape listener — the inventory window owns all three.
   */
  createSheetView(host: HTMLElement): EmbeddedView;
}

/* ══ appended: 2026-09-08 — implants (stat-carrying equippable items) · legendary perks ═══════════════════════════
 * Distinct from the six tactical implants (`ImplantId`, Q key): these are **items** (`ItemDef.implant`, category
 * 'implant') sold / repaired by `세레스 바이오`, looted broken from raids, and slotted on the `캐릭터` tab. The character
 * has `implantSlots` = IMPLANT_SLOTS_BASE + floor(level / IMPLANT_SLOTS_PER_LEVELS), capped at IMPLANT_SLOTS_MAX;
 * each item takes `ItemDef.implant.slots`. Equipped implants add their `stats` to the base stats before `derived` is
 * computed — `getStat(id)` keeps returning the **base** value, `getStatWithImplants(id)` the effective one — and a
 * legendary `perk` becomes `derived.perks[perk] = true`. Owner: progression (rules, storage, `캐릭터` tab UI).
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Legendary implant perks. Effects are read from `derived.perks` by the named owner — never re-derived. */
export type PerkId =
  | 'auto_revive'    // gets up once per raid on being downed (owner: player — up at once with hp 10, once per raid)
  | 'quick_heal'     // halves the use time of a healing item (owner: weapons — heal hold `useTime × 0.5`)
  | 'kill_stamina';  // full stamina back on a kill (owner: player — stamina = max when `enemy:killed.by` is local)

export const PERK_IDS: readonly PerkId[] = ['auto_revive', 'quick_heal', 'kill_stamina'];

export interface PerkDef {
  id: PerkId;
  name: string;        // Korean
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
  /** appended (2026-09-08): equipped implant items. Optional so older saves migrate to `[]`. */
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
  /** Ship only. Returns the item to the `함선 창고` (the ship stash; then the bag; refuses when neither has room). */
  unequipImplant(uid: string): boolean;
  /** Base stat + equipped implant bonuses (what `derived` is computed from). */
  getStatWithImplants(id: StatId): number;
  /** Sum of implant bonuses for `id` (0 when none). */
  getImplantBonus(id: StatId): number;
}

export interface ProgressionRef {
  /* ── appended (2026-09-11, C-12 user's decision): death takes the equipped implants out of the body ── */
  /**
   * **Death only** — bypasses the ship gate of `unequipImplant`. Unequips every equipped implant and returns one
   * **broken pair** instance per implant (`brokenImplantIdOf(defId)`, a fresh uid) for the corpse; the working items
   * are gone. Emits `progress:implantsChanged`, recomputes `derived` and **saves at once** (a reload right after dying
   * must not bring them back — same reason as `loadoutStore.saveNow('corpse')`). Called by
   * `InventoryRef.stripForCorpse`; an implant whose def is unknown is dropped without a twin. Empty when none.
   */
  stripImplantsForCorpse?(): ItemInstance[];
}

/**
 * `imp_strength_2` → `imp_broken_strength_2` — the item id of an implant's broken pair (also works for `imp_perk_*`).
 * appended (2026-09-11, C-12): moved here from `items/ImplantDefs` because progression (death strip) and items (the
 * defs) both need the rule. Items re-exports it.
 */
export function brokenImplantIdOf(workingId: string): string {
  return workingId.replace(/^imp_/, 'imp_broken_');
}

/* appended (2026-09-09): character creation · slot cards */
export interface PlayerProfile {
  /**
   * Soldier model accent colour (`#rrggbb`). Picked in the creation window. `SOLDIER_DEFAULT_ACCENT` when absent.
   * The 3D preview · my avatar in the ship · my soldier in a squad raid all use this colour.
   */
  accent?: string;
  /** When the character was made (epoch ms). The slot cards sort and display by it. Absent in an old save. */
  createdAt?: number;
  /** When this character was last played (epoch ms). */
  playedAt?: number;
}

/* ══ appended (2026-09-11, A-13): preparations — one raid's worth (user's decision) ══════════════════════════
 *
 * A preparation made at the mixing bench (`ItemDef.prep`) is **used in the ship**, consumed on the spot, and waits
 * in `PlayerProfile.prep`; the moment the squad launches it moves to `prepActive` and is kept **for that whole
 * raid** (kept through death for that raid — unlike gear, it is 「이미 마신 약」, medicine already drunk). It is
 * emptied when the raid ends (extraction · wipe · abandon).
 *
 * Living in the profile is the point — someone who came back through a reconnect must not lose it silently, the
 * same 2026-09-10 rule as everywhere else. Only one preparation per `env` is loaded (a second use is refused with a
 * Korean reason and the item is handed back). When the kitchen's (A-3c) meal buffs open they lay over the same two
 * fields — this is that place.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

export interface PlayerProfile {
  /** Item def ids of the preparations that will load into the next raid (at most one per environment). Absent in an old save = empty. */
  prep?: string[];
  /** The preparations loaded into this raid. Empty outside a raid. */
  prepActive?: string[];
}

export interface ProgressionRef {
  /** Def ids of the preparations that will load into the next raid. */
  getPreps(): readonly string[];
  /** Def ids of the preparations loaded into this raid (an empty array in the ship). */
  getActivePreps(): readonly string[];
  /**
   * Ship only. Consumes one preparation and loads it for the next raid (the item is either already taken by the
   * caller, or the implementation takes it with `ctx.inventory.consumeDefAll` — the implementing folder decides).
   * When the same environment is already prepared, or during a raid, it returns a Korean reason and **changes
   * nothing**. null = it was loaded.
   */
  usePrep(defId: string): string | null;
  /** Is a preparation that blocks `env` loaded into this raid. player asks when deciding whether to deal environment damage. */
  hasEnvPrep(env: EnvKind): boolean;
  /**
   * Launch: moves what is waiting into this raid's slot (game/ does it once at raid start).
   * 2026-09-11 (A-3c): **the meal slot moves along with it** (`meal` → `mealActive`) — so `game/` changes by not one line.
   */
  armPreps(): void;
  /**
   * Raid end: empties this raid's slot (game/ does it once).
   * 2026-09-11 (A-3c): **the meal slot is emptied along with it** (`mealActive` → null).
   */
  clearActivePreps(): void;
}

/* ══ appended (2026-09-11, A-3c): meals — one raid's worth (user's decision: a separate 「식사」 slot) ═══════
 *
 * A meal made at the kitchen's cook bench (`ItemDef.meal`) is **eaten at the ship's dining table**, consumed on the
 * spot, and waits in `PlayerProfile.meal`; the moment the squad launches it moves to `mealActive` and is kept for
 * that whole raid. The lifetime rules are **exactly the preparations'** (kept through death for that raid — 「이미
 * 먹은 밥」, food already eaten).
 *
 * It **does not compete for a slot** with a preparation (`prep`) (user's decision): an environment preparation is
 * one per environment, and a meal has its own single slot. So it is one string rather than an array, and eating a
 * second meal **replaces** it (not a refusal — this is where it differs from preparations).
 *
 * The buff folds into the **derived stat** `MealDef.buff` points at (literally a `DerivedStats` field name) — so
 * player · weapons · world · inventory change by not one line. A change to `mealActive` recomputes `derived`.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

export interface PlayerProfile {
  /** The item def id of the meal that will load into the next raid. One fixed slot, so not an array. Absent or null = nothing eaten. */
  meal?: string | null;
  /** The meal loaded into this raid. null outside a raid. */
  mealActive?: string | null;
}

export interface ProgressionRef {
  /** The def id of the meal that will load into the next raid, null when there is none. */
  getMeal(): string | null;
  /** The def id of the meal loaded into this raid (null in the ship). */
  getActiveMeal(): string | null;
  /**
   * Ship only. Loads one meal for the next raid (taking the item is the caller's job — the same contract as
   * `usePrep`, so it **asks first and only takes on success**). When a meal is already laid out it is **replaced
   * silently**: a meal has only one slot and 「swapping what you eat」 is the natural thing. During a raid, or for
   * something that is not a meal, a Korean reason; null on success.
   */
  useMeal(defId: string, quality?: number): string | null;   // 2026-09-13: `quality` = the meal's quality (omitted = 0). Only the same meal at **the same quality** is refused
  /**
   * The shared ship's dining table: a meal someone else laid out is taken **without consuming an item** (user's
   * decision: one person cooks, the whole squad eats). Someone who already ate has theirs replaced. The receiving
   * guard is net's — **only what the lobby host sent** gets this far (「a message that affects others is accepted
   * only from the authority」, E-4).
   */
  serveMeal(defId: string, quality?: number): void;   // 2026-09-13: `quality` = the quality of the meal laid out (omitted = 0)
}

/** appended (2026-09-17): where stat XP came from — what rises when the bar is crossed (`ProgressionRef.addStatXp`). */
export type StatXpSource = 'action' | 'minigame';

/* ══ appended (2026-09-12, A-3a): the gym — training bonus · exercise debuff (user's decision: counted apart from stat points) ══
 *
 * When a gym equipment minigame ends, housing calls `applyGymSession(stat, score)`. The score (0 … 1) becomes XP
 * (`round(GYM_SESSION_XP × score)`). 2026-09-17 (user's decision): there is no training-only bar — that XP goes into
 * the **stat XP bar** (`addStatXp(stat, xp, 'minigame')`), and when minigame XP crosses the bar it is the **training
 * bonus** `trained[stat]` that gains +1 instead of the base stat (capped at `GYM_TRAINED_MAX`, the overflow carried
 * over; at the cap the bar stops just short of full).
 *
 * The training bonus never mixes with stat points (`stats`) — `getStat` is still the base value, and like the
 * implant bonus it is added right before `derived` is computed (`getStatWithImplants` = base + implants + training,
 * exactly what 「the value `derived` is computed from」 means), and the character sheet shows it separately as
 * `10 (+2)` (2026-09-17: without the word `단련`). It is not cut at `STAT_MAX` (the same intent as implants).
 *
 * When a session ends and that stat has no debuff, `gymFatigueUntil[stat] = now + GYM_FATIGUE_HOURS` is raised
 * (strength = sore muscles · endurance = cardio fatigue). A session during the debuff is worth XP ×
 * `GYM_FATIGUE_GAIN_MUL` (0 = −100 %) and **does not extend the debuff again**. Even a score of 0 raises the debuff
 * as long as the session was finished (「once the furniture is used」). The clock is `ctx.net.serverNow() ?? Date.now()`
 * (real time, the same as the greenhouse). All three fields live in the profile and `Profile.migrate` has to carry
 * them over to survive a reload (the same place as the 2026-09-09 `accent` accident). `resetProfile` empties all three.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The stats trained by exercising. appended (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」): **video games**
 * train intelligence · perception by the same rules (`applyGymSession` · the training bonus · a 24 h debuff per stat — user's decision 「the same as the gym」).
 */
export type GymStat = Extract<StatId, 'strength' | 'endurance' | 'intelligence' | 'perception'>;
export const GYM_STATS: readonly GymStat[] = ['strength', 'endurance', 'intelligence', 'perception'];
/** Debuff names — sore muscles after strength work, cardio fatigue after endurance work (the user's spec). 2026-09-13: after a game, intelligence = mental fatigue · perception = eye strain. */
export const GYM_FATIGUE_LABEL_KO: Readonly<Record<GymStat, string>> = { strength: '근육통', endurance: '심폐 피로', intelligence: '정신 피로', perception: '눈의 피로' };

export interface PlayerProfile {
  /** The training bonus earned by exercising (an integer, 0 … GYM_TRAINED_MAX). Absent in an old save = 0. */
  trained?: Partial<Record<GymStat, number>>;
  /**
   * Retired (2026-09-17): this was the training-only progress. Training now shares the stat XP bar (`statProgress`)
   * and `Profile.migrate` throws this field away (the contract is append-only, so only the declaration stays). Never written again.
   */
  trainedProgress?: Partial<Record<GymStat, number>>;
  /** When the exercise debuff ends (epoch ms). A value in the past is the same as 「no debuff」. */
  gymFatigueUntil?: Partial<Record<GymStat, number>>;
}

/** The result of `applyGymSession` — used as it is by the result screen and `housing:gymResult`. */
export interface GymSessionResult {
  stat: GymStat;
  /** The score, clamped to 0 … 1. */
  score: number;
  /** The training XP actually added (0 if the debuff was on). */
  xp: number;
  /** The debuff was already on the moment the session ended (so xp is 0 and the debuff was not extended). */
  wasFatigued: boolean;
  trainedBefore: number;
  trainedAfter: number;
  /** Progress toward the next training bonus after the session, 0 … 1. */
  progress: number;
  /** The training bonus is at its cap. */
  capped: boolean;
  /** When the debuff ends (epoch ms). */
  fatigueUntil: number;
}

export interface ProgressionRef {
  /** The training bonus earned by exercising (0 for a stat that is not trainable). */
  getTrainedBonus?(id: StatId): number;
  /** Progress toward the next training bonus, 0 … 1. 2026-09-17: the same value as the stat XP bar (`getStatProgress`, 0 for a stat that is not trainable). */
  getTrainedProgress?(id: StatId): number;
  /** XP needed for the next training bonus at the current step. 2026-09-17: the same value as `statXpToNext`. */
  trainedXpToNext?(id: StatId): number;
  /** When the exercise debuff ends (epoch ms). 0 when there is none or it has passed. */
  getGymFatigueUntil?(id: StatId): number;
  /**
   * Ship only. Applies one finished exercise session — adds the training XP (0 while the debuff is on) and raises
   * the debuff if there was none. Emits `progress:trainedChanged` · (when it raised one) `progress:gymFatigue`,
   * recomputes `derived` when the bonus changed and saves at once. null during a raid or for a stat that is not
   * trainable (nothing changes).
   */
  applyGymSession?(id: GymStat, score: number): GymSessionResult | null;
  /**
   * appended (2026-09-12, dev console `gym` only): adds training XP **with no debuff, no ship gate and no session
   * cap** (negative = subtract, never below 0 · capped at `GYM_TRAINED_MAX`). `progress:trainedChanged` · `derived`
   * recomputed when the bonus changed · saved.
   * 2026-09-17: positive = `addStatXp(id, xp, 'minigame')`; negative = the bar is left alone and training drops by
   * ⌈|xp| / statXpToNext⌉ steps. Normal play uses `applyGymSession`.
   */
  addTrainedXp?(id: GymStat, xp: number): void;
  /** appended (2026-09-12, dev console `gym clear` only): clears the exercise debuff (`id` omitted = both). Saves. */
  clearGymFatigue?(id?: GymStat): void;
}

/* ══ appended (2026-09-13): spending stat points in one go (user's decision — the character sheet allocates with ＋/－ and commits on a 1 s hold) ══ */
export interface ProgressionRef {
  /**
   * Ship only. Invests the points of `alloc` **in one go** — all of it or none of it. Checks: not in a raid · every
   * key is a `StatId` · every value is an integer ≥ 0 · the sum is ≥ 1 and ≤ `statPoints` · no stat exceeds
   * `STAT_MAX` afterwards. On a pass it recomputes `derived` once and saves once, and emits `progress:statChanged`
   * once per stat whose value changed. A refusal is false and nothing changes. One point at a time is still
   * `spendStatPoint`.
   */
  spendStatPoints?(alloc: Partial<Record<StatId, number>>): boolean;
}

/* ══ appended (2026-09-13): meal quality (docs/DECISIONS.md 「2026-09-13 — 요리 미니게임」 — user's decision: 0 … 5 quality stars = +0 … +25 % on the stat numbers) ══
 * There is still one meal slot and the lifetime rules are unchanged — the quality travels next to the meal id (`meal` ↔ `mealQuality`, `mealActive` ↔ `mealActiveQuality`).
 * `armPreps` moves the quality along with the id and `clearActivePreps` empties it along with it. `derive.applyMealBuff` is `amount × (1 + mealQualityBonus(quality))` per row.
 * Both fields have to be carried over by `Profile.migrate` to survive a reload (the same place as the 2026-09-09 `accent` accident). */
export interface PlayerProfile {
  /** The quality of the waiting meal (`meal`), 0 … `MEAL_QUALITY_MAX`. Omitted = 0. */
  mealQuality?: number;
  /** The quality of the meal loaded into this raid (`mealActive`). Omitted = 0. */
  mealActiveQuality?: number;
}

export interface ProgressionRef {
  /** The quality of the waiting meal (0 when there is none). */
  getMealQuality?(): number;
  /** The quality of the meal loaded into this raid (0 when there is none). */
  getActiveMealQuality?(): number;
}
/* ══ end 2026-09-13 meal quality ══ */

/* ══ appended (2026-09-13): library series · video games · the cooking / research skills (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) ══
 * The derived stats of the two new skills (`cooking` · `research`). A library series' `derived` effects are not new fields but fold into `MealBuff` keys like a meal buff
 * (`ProgressionSystem` adds `ctx.housing.getLibraryEffects().derived` at the end of `recompute` — recomputed on `housing:libraryChanged`).
 * Video games use the same `applyGymSession` as the gym — intelligence · perception were added to `GymStat` (the training and debuff rules unchanged). */
export interface DerivedStats {
  /** `요리` (cooking): the value added to a cook step's score (0 … `COOK_SKILL_SCORE_AT_MAX`). Both by hand and automatic — a step's score is cut at 1. */
  cookScoreBonus: number;
  /** `연구` (research): analysis time multiplier (1 … 1 − `RESEARCH_TIME_AT_MAX`). Fixed the moment it goes in. */
  researchTimeMul: number;
  /** `연구` (research): chance of getting some material back when an extractor · mixing bench · 3D printer craft finishes (0 … `RESEARCH_REFUND_CHANCE_AT_MAX`). */
  researchRefundChance: number;
  /** `연구` (research): the fraction returned per material when it does come back (`RESEARCH_REFUND_FRAC_MIN` … `RESEARCH_REFUND_FRAC_MAX`, at least 1 per material). */
  researchRefundFrac: number;
  /**
   * appended (2026-09-16, user's decision — planet ore veins): the **rarity weight bonus** the mining skill lays on a
   * vein's drop (0 … `MINING_RARITY_AT_MAX`). A vein rolls the rarity of its unidentified ore from the **same
   * probability table** as guns (`data/loot_tiers.csv`) — this value is a bonus multiplied into the higher-rarity
   * side of that roll, and it **cannot go past** the ceiling the difficulty has set (difficulty 1 = up to rare).
   * The mining skill changes this one thing only (hold time · harvest count are already `gatherYieldMul` · `interactSpeedMul`).
   */
  miningRarityBonus: number;
}
/* ══ end 2026-09-13 library series ══ */
