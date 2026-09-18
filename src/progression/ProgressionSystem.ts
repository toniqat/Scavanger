import type { EquippedImplant, EnvKind, ImplantItemDef, ItemInstance, MealBuff, MealDef,
  DerivedStats, EmbeddedView, GameContext, GameSystem, GymSessionResult, GymStat, PlayerProfile, ProfileRef, ProgressionRef,
  SkillDef, SkillId, StatDef, StatId, StatXpSource, WeaponClass,
} from '@/shared';
import {
  GYM_FATIGUE_GAIN_MUL, GYM_FATIGUE_HOURS, GYM_SESSION_XP, GYM_STATS, GYM_TRAINED_MAX,
  brokenImplantIdOf,
  IMPLANT_SLOTS_BASE, IMPLANT_SLOTS_MAX, IMPLANT_SLOTS_PER_LEVELS,
  SKILL_IDS, SKILL_LEVEL_MAX, STAT_BASE, STAT_IDS, STAT_MAX, STAT_MIN, STAT_POINTS_PER_LEVEL,
  STAT_XP_BASE, STAT_XP_EXPONENT, TRAINING_SKILL_GAIN_MUL,
  normalizeMealQuality,
  getMealDef,                                       // 2026-09-16 (the plate model): a meal is not an item — the table is shared/meals
} from '@/shared';
import {
  APPRAISE_XP_BY_RARITY, CARRY_XP_PER_METER, CRAFT_XP, CRATE_OPEN_XP, CRYPTO_XP, GATHER_XP, GRIT_SAVE_XP,
  GUN_HIT_XP, IMPLANT_XP, REPAIR_XP, SKILL_DEF_MAP, SKILL_DEFS, STAT_DEF_MAP, STAT_DEFS, WEAPON_CLASS_SKILL,
} from './defs';
/* 2026-09-16: mining XP per ore-vein harvest. The value is the same constant world uses, so it is read straight from `@/shared`. */
import { MINING_SKILL_XP } from '@/shared';
import { applyLibraryDerived, applyMealBuff, computeDerived, DEFAULT_DERIVED, SKILL_STAT_FACTOR, SPECIAL_BACKPACK_CD_MUL, emptyPerks, trainedBonusOf, xpForLevel, type ImplantContribution } from './derive';
import { DEFAULT_IMPLANT, clearStoredProfile, freshProfile, loadProfile, migrate, saveProfile, zeroStatProgress } from './Profile';
import { CharacterSheet } from './ui/CharacterSheet';
import { SheetView } from './ui/SheetView';

/** Seconds between autosaves while the profile is dirty. */
const AUTOSAVE_INTERVAL = 15;
/** Skill progress must move this much before another `progress:skillProgress` is emitted (HUD bar). */
const PROGRESS_EMIT_STEP = 0.01;
/** Raw skill XP is divided by `1 + level * SKILL_COST_SLOPE` — later levels take longer. */
const SKILL_COST_SLOPE = 0.06;
/* `SKILL_STAT_FACTOR` (how strongly a skill's own stats speed up training) lives in derive.ts since 2026-09-13 — the sheet tooltip reads it too. */
/*
 * Phase 11 (2026-09-07): the undocumented `P` convenience toggle is **retired**. The `캐릭터` (character) screen has
 * been a Tab-screen tab since Phase 8 (`ui:statsToggled` still opens the overlay for anyone who emits it), and P now
 * belongs to `Keys.INVITE` (hold to accept a squad invite). Both listened with `uiBlockers.size === 0`, so they would
 * have fought each other.
 */

const isGymStat = (id: unknown): id is GymStat => (GYM_STATS as readonly unknown[]).includes(id);
/**
 * 2026-09-13 (user's decision): benches that give no crafting XP — the lab benches (extractor · mixer · 3D printer)
 * train research only (`RESEARCH_BENCHES` in `inventory/parts/Crafting`), and the cooking station (`cook`) trains
 * cooking only (`housing/parts/Cooking` awards `COOK_SKILL_XP`).
 */
const LAB_BENCHES: ReadonlySet<string> = new Set(['extract', 'mixer', 'print', 'cook']);

/** Raw stat XP needed for the point after stat value `value`: round(STAT_XP_BASE × value^STAT_XP_EXPONENT). */
export function statXpFor(value: number): number {
  const v = Math.max(STAT_MIN, Math.min(STAT_MAX, Math.round(value)));
  return Math.max(1, Math.round(STAT_XP_BASE * Math.pow(v, STAT_XP_EXPONENT)));
}

/**
 * Character stats, skills, the persistent profile and every number derived from them.
 * Publishes `ctx.progression` (`ProgressionRef`) in `init`.
 *
 * - Profile lives in `localStorage[PROFILE_STORAGE_KEY]`, versioned by `PROFILE_VERSION`; every access is
 *   wrapped in try/catch so private mode / a full quota can never break a mission (see `Profile.ts`).
 * - Skills rise from bus events (hits, crafts, repairs, harvests, hacks, implant casts, carrying weight).
 * - `derived` is recomputed whenever stats, skills or the equipped backpack change; nobody else re-derives.
 * - Phase 7: the profile also lives in the server profile store (`ctx.net.profile`, document `progression`) — every
 *   flush mirrors it there, `net:profileLoaded` replaces the local one with the server copy (server wins) and
 *   re-emits the `progress:*` events the sheet / HUD read. In the simulation training range only `gun_*` skills train.
 */
export class ProgressionSystem implements GameSystem, ProgressionRef {
  readonly name = 'progression';

  /* ── Implant items (Phase 12, 2026-09-08) ──────────────────────────────────
   * Hollow-Knight-charm style: the character has `implantSlots` (4 + 1 per 5 levels, ≤ 10), each equipped item
   * (`ItemDef.implant`) costs `slots` and adds `stats`; a legendary one flips a `derived.perks` flag. The item
   * **instance** leaves the grids while equipped and lives in `profile.implants` (uid / defId / durability), so it
   * round-trips with the profile document. Equip / unequip only in the ship (phase `hub`, no raid).
   * ────────────────────────────────────────────────────────────────────────── */

  get implantSlots(): number {
    const lv = Math.max(1, Math.floor(this._profile.level));
    return Math.min(IMPLANT_SLOTS_MAX, IMPLANT_SLOTS_BASE + Math.floor(lv / IMPLANT_SLOTS_PER_LEVELS));
  }

  get implantSlotsUsed(): number {
    let used = 0;
    for (const e of this.equippedList()) used += this.implantDefOf(e.defId)?.slots ?? 0;
    return used;
  }

  getEquippedImplants(): readonly EquippedImplant[] { return this.equippedList(); }

  /**
   * Base stat + equipped implant bonuses + the gym training bonus (A-3a) — what `derived` is computed from. The name
   * predates the gym; the contract keeps its meaning (「the value `derived` is computed from」), so it includes
   * `trained` too.
   */
  getStatWithImplants(id: StatId): number { return this.getStat(id) + this.getImplantBonus(id) + this.getTrainedBonus(id); }

  /** Sum of `implant.stats[id]` over the equipped implants (0 when none / items not up yet). */
  getImplantBonus(id: StatId): number {
    let sum = 0;
    for (const e of this.equippedList()) {
      const b = this.implantDefOf(e.defId)?.stats[id];
      if (typeof b === 'number' && Number.isFinite(b)) sum += b;
    }
    return sum;
  }

  /**
   * Ship only. Takes bag / stash item `uid` out of the inventory and equips it. false — and nothing changes — during a
   * raid or outside the hub, for a non-implant / broken item, an unknown uid, or when `slots` would not fit.
   */
  equipImplant(uid: string): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.canSwapImplants()) return false;
    const inv = ctx.inventory;
    const loot = ctx.loot;
    if (!inv || !loot || typeof inv.findItemAnywhere !== 'function' || typeof inv.takeItem !== 'function') return false;
    if (typeof uid !== 'string' || !uid) return false;
    if (this.equippedList().some((e) => e.uid === uid)) return false;
    const item = inv.findItemAnywhere(uid);
    if (!item) return false;
    const imp = loot.getItemDef(item.defId)?.implant;
    if (!imp || imp.broken) return false;
    const slots = Math.max(1, Math.floor(imp.slots));
    if (this.implantSlotsUsed + slots > this.implantSlots) return false;
    if (inv.takeItem(uid) < 1) return false;
    const entry: EquippedImplant = { uid, defId: item.defId };
    if (typeof item.durability === 'number' && Number.isFinite(item.durability)) entry.durability = item.durability;
    this.equippedList().push(entry);
    this.afterImplantsChanged();
    return true;
  }

  /**
   * Ship only. Rebuilds the item instance (same uid / durability) and puts it in the ship stash, else the bag. false —
   * still equipped — when neither has room, outside the hub, or for an unknown uid.
   */
  unequipImplant(uid: string): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.canSwapImplants()) return false;
    const list = this.equippedList();
    const idx = list.findIndex((e) => e.uid === uid);
    if (idx < 0) return false;
    if (!this.returnImplant(list[idx])) return false;
    list.splice(idx, 1);
    this.afterImplantsChanged();
    return true;
  }

  /**
   * **Death only** (2026-09-11 C-12, user's decision): every equipped implant leaves the body — the ship gate of
   * `unequipImplant` does not apply. Each one becomes a **broken twin** item (`brokenImplantIdOf`, fresh uid from
   * `createItem`, no durability) handed to `InventoryRef.stripForCorpse` for the corpse; the working instance is gone.
   * An entry whose twin def is unknown is dropped without an item. `derived` is recomputed, `progress:implantsChanged`
   * goes out and the profile is **written at once** — a reload right after dying must not bring the implants back
   * (same reason as `loadoutStore.saveNow('corpse')`). Empty (and nothing written) when none are equipped.
   */
  stripImplantsForCorpse(): ItemInstance[] {
    const list = this.equippedList();
    if (list.length === 0) return [];
    const out: ItemInstance[] = [];
    const loot = this.ctx?.loot;
    for (const e of list) {
      if (!loot) break;
      try {
        // an already-broken entry cannot be equipped, but an old save might hold one — it is its own twin
        const twinId = loot.getItemDef(e.defId)?.implant?.broken ? e.defId : brokenImplantIdOf(e.defId);
        if (!loot.getItemDef(twinId)?.implant) continue;
        out.push(loot.createItem(twinId, 1));
      } catch { /* unknown def — dropped without a twin */ }
    }
    list.length = 0;
    this.afterImplantsChanged();                          // recompute + markDirty(true) = flush now + event + sheets
    return out;
  }

  /* ── implant internals ── */
  private equippedList(): EquippedImplant[] {
    const p = this._profile;
    if (!Array.isArray(p.implants)) p.implants = [];
    return p.implants;
  }

  private implantDefOf(defId: string): ImplantItemDef | undefined {
    try { return this.ctx?.loot?.getItemDef(defId)?.implant; } catch { return undefined; }
  }

  /** Equip / unequip are allowed only in the ship: phase `hub` and no raid in progress. */
  private canSwapImplants(): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (ctx.phase !== 'hub') return false;
    try { if (ctx.isRaidActive()) return false; } catch { /* treat as not in a raid */ }
    return true;
  }

  /** The equipped implants' contribution to `derived` (flat stat bonuses + perks). */
  private implantContribution(): ImplantContribution {
    const bonus: Partial<Record<StatId, number>> = {};
    const perks = emptyPerks();
    for (const e of this.equippedList()) {
      const imp = this.implantDefOf(e.defId);
      if (!imp || imp.broken) continue;
      for (const id of STAT_IDS) {
        const b = imp.stats[id];
        if (typeof b === 'number' && Number.isFinite(b) && b !== 0) bonus[id] = (bonus[id] ?? 0) + b;
      }
      if (imp.perk && imp.perk in perks) perks[imp.perk] = true;
    }
    return { bonus, perks };
  }

  /**
   * Drop equipped entries whose def no longer exists / is no longer an implant (a removed item id in an old save).
   * Only once `ctx.loot` is up — before that nothing can be judged. Returns true when something was dropped.
   */
  private pruneImplants(): boolean {
    const loot = this.ctx?.loot;
    if (!loot || typeof loot.getItemDef !== 'function') return false;
    const list = this.equippedList();
    let dropped = false;
    for (let i = list.length - 1; i >= 0; i--) {
      let ok = false;
      try { ok = !!loot.getItemDef(list[i].defId)?.implant; } catch { ok = false; }
      if (!ok) { list.splice(i, 1); dropped = true; }
    }
    return dropped;
  }

  /** Rebuild an equipped implant as an item instance and hand it to the stash (then the bag). */
  private returnImplant(e: EquippedImplant): boolean {
    const ctx = this.ctx;
    const inv = ctx?.inventory;
    const loot = ctx?.loot;
    if (!inv || !loot) return false;
    try {
      if (!loot.getItemDef(e.defId)) return false;
      const inst = loot.createItem(e.defId, 1, e.durability !== undefined ? { durability: e.durability } : undefined);
      inst.uid = e.uid;                                     // keep the identity the save knows
      if (typeof inv.tryAddToStash === 'function' && inv.tryAddToStash(inst)) return true;
      return typeof inv.tryAddItemAnywhere === 'function' && inv.tryAddItemAnywhere(inst) !== null;
    } catch {
      return false;
    }
  }

  /* ══ Preparations (A-13, 2026-09-11 — user's decision: used in the ship, good for the next raid) ═══════
   * `profile.prep` = what will be carried into the next raid, `profile.prepActive` = what is carried in this one. One
   * per environment (`EnvKind`); at launch `armPreps()` moves the whole waiting set across. Death does not clear them
   * (「the drug is already drunk」) — the one place that clears them is the end of the raid (`clearActivePreps`).
   * They live in the profile so someone who comes back through a reconnect or a resume does not lose them silently
   * (2026-09-10 convention).
   * ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  getPreps(): readonly string[] { return this.prepList(); }
  getActivePreps(): readonly string[] { return this.activePrepList(); }

  /**
   * Ship only. Loads one preparation def id into the waiting set for the next raid. Consuming the item is the
   * **caller's** job (inventory), and on a refusal this **changes nothing** — which is why inventory asks first and
   * only consumes on success.
   * null = loaded, a string = the (Korean) refusal reason.
   */
  usePrep(defId: string): string | null {
    const ctx = this.ctx;
    if (typeof defId !== 'string' || !defId) return '알 수 없는 준비물입니다';
    if (ctx?.isRaidActive()) return '레이드 중에는 준비할 수 없습니다';
    if (ctx && ctx.phase !== 'hub') return '함선에서만 준비할 수 있습니다';
    const env = this.prepEnvOf(defId);
    if (!env) return '알 수 없는 준비물입니다';
    const list = this.prepList();
    if (list.includes(defId)) return '이미 준비했습니다';
    const clash = list.find((id) => this.prepEnvOf(id) === env);
    if (clash) {
      const name = ctx?.loot?.getItemDef(clash)?.name ?? '다른 준비물';
      return `${name} 을(를) 이미 준비했습니다`;
    }
    list.push(defId);
    this.afterPrepsChanged();
    return null;
  }

  hasEnvPrep(env: EnvKind): boolean {
    for (const id of this.activePrepList()) if (this.prepEnvOf(id) === env) return true;
    return false;
  }

  /**
   * Launch: moves the waiting set into this raid's set (game/ calls it once at raid start). With an empty waiting set
   * it does **nothing** — a reconnect or a solo resume passes through `game:newMission` too, so overwriting
   * `prepActive` here would make whoever came back lose what they are carrying.
   */
  armPreps(): void {
    this.armMeal();                                     // A-3c: the meal slot moves in the same place (game/ unchanged)
    const waiting = this.prepList();
    if (waiting.length === 0) return;
    const active = this.activePrepList();
    for (const id of waiting) {
      const env = this.prepEnvOf(id);
      // if this raid already carries the same environment (a waiting entry left over after a reconnect), do not load it twice.
      if (active.includes(id)) continue;
      if (env && active.some((a) => this.prepEnvOf(a) === env)) continue;
      active.push(id);
    }
    this._profile.prep = [];
    this.afterPrepsChanged();
  }

  /** End of a raid (extraction · wipe · abandon · `game:abort`). Death alone does not call it. */
  clearActivePreps(): void {
    this.clearActiveMeal();                             // A-3c: the meal slot is cleared in the same place
    if (this.activePrepList().length === 0) return;
    this._profile.prepActive = [];
    this.afterPrepsChanged();
  }

  /**
   * Launch: moves the waiting meal into this raid's slot. With nothing waiting it does **nothing** — the same reason
   * as preparations: a reconnect or a solo resume passes through `game:newMission` too, so overwriting `mealActive`
   * here would make whoever came back lose the meal they are carrying.
   */
  private armMeal(): void {
    const waiting = this.mealId();
    if (!waiting) return;
    this._profile.mealActive = waiting;
    this._profile.mealActiveQuality = this.getMealQuality();   // 2026-09-13: the quality travels with the id
    this._profile.meal = null;
    this._profile.mealQuality = 0;
    this.recompute();                                   // where the buff is folded into `derived`
    this.afterMealChanged();
  }

  private clearActiveMeal(): void {
    if (!this.activeMealId()) return;
    this._profile.mealActive = null;
    this._profile.mealActiveQuality = 0;                // 2026-09-13: the quality is cleared with it
    this.recompute();
    this.afterMealChanged();
  }

  /** Live array on the profile (created on demand so an older save migrates to `[]` in place). */
  private prepList(): string[] {
    if (!Array.isArray(this._profile.prep)) this._profile.prep = [];
    return this._profile.prep;
  }

  private activePrepList(): string[] {
    if (!Array.isArray(this._profile.prepActive)) this._profile.prepActive = [];
    return this._profile.prepActive;
  }

  /** `ItemDef.prep.env` of a prep def id, or null when items/ does not know it (yet). */
  private prepEnvOf(defId: string): EnvKind | null {
    try { return this.ctx?.loot?.getItemDef(defId)?.prep?.env ?? null; } catch { return null; }
  }

  /**
   * Drop stored ids whose def no longer resolves as a preparation (a removed item, a corrupt file). Runs inside
   * `recompute` once `ctx.loot` exists — the same shape as `pruneImplants`. Returns true when something went.
   */
  private prunePreps(): boolean {
    const loot = this.ctx?.loot;
    if (!loot || typeof loot.getItemDef !== 'function') return false;
    let changed = false;
    for (const key of ['prep', 'prepActive'] as const) {
      const list = key === 'prep' ? this.prepList() : this.activePrepList();
      const keep = list.filter((id) => this.prepEnvOf(id) !== null);
      if (keep.length !== list.length) { this._profile[key] = keep; changed = true; }
    }
    return changed;
  }

  private afterPrepsChanged(): void {
    this.markDirty(true);
    this.emitPrepChanged();
  }

  private emitPrepChanged(): void {
    this.ctx?.bus.emit('progress:prepChanged', {
      prep: this.prepList().slice(), active: this.activePrepList().slice(),
    });
  }

  /* ══ Meals (A-3c, 2026-09-11 — user's decision: one separate 「식사」 slot) ═════════════════════════════
   * The **sibling** of preparations: `profile.meal` = the meal that will be carried into the next raid,
   * `profile.mealActive` = the one carried in this raid. It is moved (`armPreps`) and cleared (`clearActivePreps`) in
   * the **same places** as preparations, so `game/` changes by not one line.
   * Two things differ — ① there is only one slot, so it is not an array, and ② a second meal is not a refusal but a
   * **replacement** (「eat something else instead」). The buff is the `MealDef` of `mealActive`, folded into `derived`
   * by `recompute`.
   * ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  getMeal(): string | null { return this.mealId(); }
  getActiveMeal(): string | null { return this.activeMealId(); }

  /**
   * Ship only. Loads one meal def id into the waiting slot for the next raid. Consuming the item is the **caller's**
   * job (inventory, or housing's dining table), and on a refusal this changes nothing — which is why the caller
   * **asks first** and only consumes on success (the same convention as `usePrep`).
   * null = loaded, a string = the (Korean) refusal reason.
   */
  useMeal(defId: string, quality = 0): string | null {
    const ctx = this.ctx;
    if (typeof defId !== 'string' || !defId) return '알 수 없는 요리입니다';
    if (ctx?.isRaidActive()) return '레이드 중에는 먹을 수 없습니다';
    if (ctx && ctx.phase !== 'hub') return '함선에서만 먹을 수 있습니다';
    if (!this.mealDefOf(defId)) return '알 수 없는 요리입니다';
    const q = normalizeMealQuality(quality);
    /* Eating the very same meal again is the one case that is refused — nothing would change, and returning null
     * would make the caller **throw the item away** for nothing. The 「replace」 decision is about a *different* meal.
     * 2026-09-13 (cook quality): 「the same meal」 means **same id and same quality** — a different quality changes the
     * buff numbers, so that is a replacement. */
    if (this._profile.meal === defId && this.getMealQuality() === q) return '이미 같은 요리를 먹었습니다';
    this._profile.meal = defId;                          // a different meal already set is **replaced silently**
    this._profile.mealQuality = q;
    this.afterMealChanged();
    return null;
  }

  /**
   * ⚠ 2026-09-16 (the plate model): **nothing calls this** — at the shared ship's dining table each squadmate now eats
   * their own plate through `useMeal` (`housing/parts/Dining.eatPlate`). It is part of the contract
   * (`ProgressionRef.serveMeal`), so only the implementation is kept.
   * Shared ship dining table: receive a meal someone else served **without consuming an item**. It replaces whatever
   * was already eaten. The receiving-side guards (lobby member · same shared ship · `MEAL_SERVE_RANGE` · rate ·
   * **host-sent only**) were already passed by net — here it is loaded only when not in a raid and it is a real meal.
   */
  serveMeal(defId: string, quality = 0): void {
    const ctx = this.ctx;
    if (typeof defId !== 'string' || !defId) return;
    if (ctx?.isRaidActive()) return;                     // cannot serve someone who is in a raid (net blocks it already; belt and braces)
    if (!this.mealDefOf(defId)) return;
    const q = normalizeMealQuality(quality);             // 2026-09-13: the quality of the meal as served (default from the lead)
    if (this._profile.meal === defId && this.getMealQuality() === q) return;
    this._profile.meal = defId;
    this._profile.mealQuality = q;
    this.afterMealChanged();
  }

  /** 2026-09-13 (cook quality): quality of the waiting meal, 0 … `MEAL_QUALITY_MAX` (0 when there is none). */
  getMealQuality(): number {
    return this.mealId() ? normalizeMealQuality(this._profile.mealQuality) : 0;
  }

  /** 2026-09-13 (cook quality): quality of the meal carried into this raid (0 when there is none). */
  getActiveMealQuality(): number {
    return this.activeMealId() ? normalizeMealQuality(this._profile.mealActiveQuality) : 0;
  }

  /** The profile's waiting meal id (null when there is none). */
  private mealId(): string | null {
    const v = this._profile.meal;
    return typeof v === 'string' && v ? v : null;
  }

  private activeMealId(): string | null {
    const v = this._profile.mealActive;
    return typeof v === 'string' && v ? v : null;
  }

  /**
   * The `MealDef` of a meal id, null when it is not a meal. 2026-09-16 (the plate model): a meal is not an item, so
   * `ctx.loot` does not know it — the table is `shared/meals` (`getMealDef`) and is always there, whatever the boot
   * order.
   */
  private mealDefOf(defId: string | null): MealDef | null {
    return getMealDef(defId)?.meal ?? null;
  }

  /**
   * Drop a stored meal id whose def no longer resolves as a meal (a removed item, a corrupt file). Runs inside
   * `recompute` once `ctx.loot` exists — the same shape as `prunePreps`. Returns true when something went.
   */
  private pruneMeal(): boolean {
    // 2026-09-16: the meal table always exists in shared — no need to wait for `ctx.loot`
    let changed = false;
    for (const key of ['meal', 'mealActive'] as const) {
      const id = key === 'meal' ? this.mealId() : this.activeMealId();
      if (id && !this.mealDefOf(id)) {
        this._profile[key] = null;
        this._profile[key === 'meal' ? 'mealQuality' : 'mealActiveQuality'] = 0;   // 2026-09-13: the quality goes with it
        changed = true;
      }
    }
    return changed;
  }

  /** The waiting slot changed — save + event. Whoever touched `mealActive` calls `recompute` as well. */
  private afterMealChanged(): void {
    this.markDirty(true);
    this.emitMealChanged();
  }

  private emitMealChanged(): void {
    this.ctx?.bus.emit('progress:mealChanged', {
      meal: this.mealId(), active: this.activeMealId(),
      mealQuality: this.getMealQuality(), activeQuality: this.getActiveMealQuality(),   // 2026-09-13 cook quality
    });
  }

  /* ══ The gym — training bonus · workout debuff (A-3a, 2026-09-12 — user's decision: counted separately from stat
   * points) ════════════════════════════════════════════════════════════════════════════════════════════
   * When housing's minigame ends it calls `applyGymSession(stat, score)`. Score → XP → the **stat-XP bar**
   * (2026-09-17, `addStatXp(stat, xp, 'minigame')` — the rules are above that function) → filling the bar is
   * `profile.trained[stat]` +1 (capped at `GYM_TRAINED_MAX`). The training bonus never mixes into `stats`;
   * `derive.stat()` adds it in the **same place** as the implant bonus. A finished session puts a
   * `GYM_FATIGUE_HOURS` debuff on a stat that had none (while debuffed, XP is × `GYM_FATIGUE_GAIN_MUL` and the debuff
   * is not extended). The clock is `ctx.net.serverNow() ?? Date.now()` (real time, as in the greenhouse). `trained`
   * and `gymFatigueUntil` live in the profile and `Profile.sanitizeGym` carries them over in migrate (the old
   * `trainedProgress` has been discarded since 2026-09-17).
   * ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  getTrainedBonus(id: StatId): number { return trainedBonusOf(this._profile, id); }

  /** 2026-09-17: the shared stat-XP bar (`getStatProgress`) — there is no separate training bar any more. 0 for a non-gym stat. */
  getTrainedProgress(id: StatId): number { return isGymStat(id) ? this.getStatProgress(id) : 0; }

  /** 2026-09-17: the shared stat-XP bar's need (`statXpToNext`). */
  trainedXpToNext(id: StatId): number { return this.statXpToNext(id); }

  getGymFatigueUntil(id: StatId): number {
    if (!isGymStat(id)) return 0;
    const until = this._profile.gymFatigueUntil?.[id];
    if (typeof until !== 'number' || !Number.isFinite(until)) return 0;
    return until > this.gymNow() ? until : 0;
  }

  /** The clock of the gym debuff: relay wall time when connected (`ctx.net.serverNow()`), else `Date.now()`. */
  gymNow(): number {
    try {
      const net = this.ctx?.net;
      if (net && typeof net.serverNow === 'function') {
        const t = net.serverNow();
        if (typeof t === 'number' && Number.isFinite(t) && t > 0) return t;
      }
    } catch { /* net not ready */ }
    return Date.now();
  }

  /**
   * Ship only. Applies one finished workout session (formula in §4). Returns null — and changes nothing — during a
   * raid, outside the hub phase, or for a stat the gym does not train. The score is clamped to 0 … 1 (NaN = 0), and
   * even a score of 0 puts the debuff on, because the session was finished.
   * `xp` is the XP **actually added** — 0 while debuffed. 2026-09-17: XP still goes into the bar when the training
   * bonus is capped (it simply cannot roll over — the minigame rule of `addStatXp`). `progress` = the stat-XP bar
   * after the session, `capped` = the training bonus is at its cap.
   */
  applyGymSession(id: GymStat, score: number): GymSessionResult | null {
    const ctx = this.ctx;
    if (!ctx || !isGymStat(id)) return null;
    try { if (ctx.isRaidActive()) return null; } catch { return null; }
    if (ctx.phase !== 'hub') return null;

    const s = typeof score === 'number' && Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
    const now = this.gymNow();
    const activeUntil = this.getGymFatigueUntil(id);
    const wasFatigued = activeUntil > 0;
    const earned = Math.round(GYM_SESSION_XP * s) * (wasFatigued ? GYM_FATIGUE_GAIN_MUL : 1);
    const xp = Math.max(0, Math.round(earned));

    // the debuff is written before the step, whose immediate save then carries both
    let fatigueUntil = activeUntil;
    if (!wasFatigued) {
      fatigueUntil = now + GYM_FATIGUE_HOURS * 3600e3;
      const p = this._profile;
      (p.gymFatigueUntil ?? (p.gymFatigueUntil = {}))[id] = fatigueUntil;
    }
    const before = this.getTrainedBonus(id);
    this.addStatXp(id, xp, 'minigame');                   // always saves immediately on the minigame path (even xp 0)
    if (!wasFatigued) ctx.bus.emit('progress:gymFatigue', { id, until: fatigueUntil });
    const after = this.getTrainedBonus(id);

    return {
      stat: id, score: s, xp, wasFatigued, trainedBefore: before, trainedAfter: after,
      progress: this.getStatProgress(id), capped: after >= GYM_TRAINED_MAX, fatigueUntil,
    };
  }

  /**
   * Dev console `gym` only (appended to the contract 2026-09-12): no debuff, no ship gate, no session cap.
   * 2026-09-17: a positive value is minigame XP as-is (`addStatXp(id, xp, 'minigame')`). A negative value leaves the
   * bar alone and drops the training bonus by ⌈|xp| / the bar's current need⌉ steps (0 is the floor) — cutting the bar
   * would lower the base stat, which is not what the console's / a smoke's 「reset the training」 means.
   * Does nothing for a non-gym stat or a non-finite number.
   */
  addTrainedXp(id: GymStat, xp: number): void {
    if (!isGymStat(id) || typeof xp !== 'number' || !Number.isFinite(xp)) return;
    if (xp >= 0) { this.addStatXp(id, xp, 'minigame'); return; }
    const before = this.getTrainedBonus(id);
    const n = Math.max(0, before - Math.ceil(-xp / Math.max(1, this.statXpToNext(id))));
    this.writeTrained(id, n);
    const changed = n !== before;
    if (changed) this.recompute();
    this.markDirty(true);
    const bus = this.ctx?.bus;
    bus?.emit('progress:trainedChanged', { id, value: n, progress: this.getStatProgress(id), delta: xp });
    if (changed) bus?.emit('progress:statChanged', { id, value: this.getStat(id), pointsLeft: this._profile.statPoints });
    this.refreshSheetStat(id);
  }

  /**
   * Dev console `gym clear` only: clears the workout debuff (`id` omitted = both). For each stat cleared it emits
   * `progress:gymFatigue {id, until: 0}` so the sheet and the badge redraw at once, and saves immediately if anything
   * was cleared. Expired stamps are swept along with it.
   */
  clearGymFatigue(id?: GymStat): void {
    const ids: readonly GymStat[] = id === undefined ? GYM_STATS : isGymStat(id) ? [id] : [];
    const map = this._profile.gymFatigueUntil;
    const cleared: GymStat[] = [];
    for (const k of ids) {
      if (map && k in map) { delete map[k]; cleared.push(k); }
    }
    if (cleared.length === 0) return;
    this.markDirty(true);
    for (const k of cleared) this.ctx?.bus.emit('progress:gymFatigue', { id: k, until: 0 });
  }

  /** Store training bonus `n` for `id` (0 = key removed, so an untouched character keeps an empty map). */
  private writeTrained(id: GymStat, n: number): void {
    const p = this._profile;
    const trained = p.trained ?? (p.trained = {});
    if (n > 0) trained[id] = n; else delete trained[id];
  }

  /** Re-announce the gym state (boot · server document · reset): `trainedChanged` with delta 0, `gymFatigue` while active. */
  private emitGymState(): void {
    const bus = this.ctx?.bus;
    if (!bus) return;
    for (const id of GYM_STATS) {
      bus.emit('progress:trainedChanged', { id, value: this.getTrainedBonus(id), progress: this.getTrainedProgress(id), delta: 0 });
      const until = this.getGymFatigueUntil(id);
      if (until > 0) bus.emit('progress:gymFatigue', { id, until });
    }
  }

  private afterImplantsChanged(): void {
    this.recompute();
    this.markDirty(true);
    this.emitImplantsChanged();
    this.refreshSheets();
  }

  private emitImplantsChanged(): void {
    this.ctx?.bus.emit('progress:implantsChanged', {
      equipped: this.equippedList().map((e) => ({ ...e })), slots: this.implantSlots, used: this.implantSlotsUsed,
    });
  }

  private ctx!: GameContext;
  private _profile: PlayerProfile = freshProfile();
  private _derived: DerivedStats = DEFAULT_DERIVED;
  private offs: Array<() => void> = [];
  private sheet: CharacterSheet | null = null;
  /** Embedded character tabs handed out by `createSheetView` (Phase 8) — refreshed alongside the overlay. */
  private views = new Set<SheetView>();

  private dirty = false;
  private saveTimer = 0;

  /** Weapon def id of the last shot fired locally — `weapon:hit` carries no weapon id. */
  private lastFiredWeapon: string | null = null;
  private equippedWeapon: string | null = null;
  /** true once the current shot already trained the shooting skill (shotguns emit one `weapon:hit` per pellet). */
  private shotCredited = false;
  /** Latest `inventory:weightChanged` state (drives the hauling skill). */
  private weightState: string = 'normal';
  /** 2026-09-16: last `ctx.player.selfMovedMeters` reading (hauling counts only the odometer's growth). */
  private lastSelfMoved = 0;
  private hasLastPos = false;
  /** Container ids whose `crate:open` already paid appraisal XP this raid (C-16 · X-1; cleared on `game:newMission` / `world:ready`). */
  private readonly cratesAppraised = new Set<string>();
  /** Last emitted fractional progress per skill, so the bus is not spammed every frame. */
  private lastEmitted: Partial<Record<SkillId, number>> = {};

  private onPageHide = (): void => { this.flush(); };

  /* ── ProgressionRef ────────────────────────────────────────────────────── */
  get profile(): PlayerProfile { return this._profile; }
  get derived(): DerivedStats { return this._derived; }
  get level(): number { return this._profile.level; }
  get xp(): number { return this._profile.xp; }
  get xpToNext(): number { return xpForLevel(this._profile.level); }
  get statPoints(): number { return this._profile.statPoints; }

  getStat(id: StatId): number { return this._profile.stats[id] ?? STAT_BASE; }
  getSkill(id: SkillId): number { return this._profile.skills[id] ?? 0; }
  getStatDef(id: StatId): StatDef { return STAT_DEF_MAP.get(id) ?? STAT_DEFS[0]; }
  getSkillDef(id: SkillId): SkillDef { return SKILL_DEF_MAP.get(id) ?? SKILL_DEFS[0]; }
  getAllStatDefs(): readonly StatDef[] { return STAT_DEFS; }
  getAllSkillDefs(): readonly SkillDef[] { return SKILL_DEFS; }
  skillForWeaponClass(cls: WeaponClass): SkillId { return WEAPON_CLASS_SKILL[cls] ?? 'gun_AR'; }

  /** Fractional progress (0..1) toward the next level of `id` — used by the character sheet / HUD. */
  getSkillProgress(id: SkillId): number { return this._profile.skillProgress[id] ?? 0; }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.progression = this;

    const res = loadProfile();
    this._profile = res.profile;
    if (res.outcome === 'corrupt') {
      console.warn('[progression] stored profile was unreadable — starting a fresh character');
    }
    this.recompute();
    if (res.outcome === 'migrated' || res.outcome === 'corrupt') this.markDirty(true);

    this.sheet = new CharacterSheet(ctx, this);

    const b = ctx.bus;
    this.offs.push(
      /* ── shooting skills ── */
      b.on('weapon:equipped', ({ weaponId }) => { this.equippedWeapon = weaponId; }),
      b.on('weapon:fired', ({ weaponId }) => { this.lastFiredWeapon = weaponId; this.shotCredited = false; }),
      b.on('weapon:hit', ({ enemyId }) => {
        if (enemyId === null) return;                       // terrain / props do not train marksmanship
        if (this.shotCredited) return;                      // one credit per shot (a shotgun emits one hit per pellet)
        const cls = this.weaponClassOf(this.lastFiredWeapon ?? this.equippedWeapon);
        if (!cls) return;
        this.shotCredited = true;
        this.addSkillXp(this.skillForWeaponClass(cls), GUN_HIT_XP[cls] ?? GUN_HIT_XP.AR);
      }),
      /* ── grit ── */
      b.on('player:gritSaved', () => this.addSkillXp('grit', GRIT_SAVE_XP)),
      /* ── gardening (scrap salvage trains crafting since 2026-09-08, ore veins train mining since 2026-09-16) ──
       * Gathered things split three ways: scrap = crafting · ore veins = mining · everything else (herbs · soil ·
       * seeds · samples) = gardening.
       * Only ore veins use a different XP value (`MINING_SKILL_XP`, data/constants.csv) — the hold is long and several
       * come out at once. */
      b.on('gather:collected', ({ kind }) => {
        if (kind === 'mineral') { this.addSkillXp('mining', MINING_SKILL_XP); return; }
        this.addSkillXp(kind === 'salvage' ? 'crafting' : 'gardening', GATHER_XP);
      }),
      /* ── crafting / medicine ── */
      // 2026-09-13 (user's decision): crafting at a lab bench (extractor · mixer · 3D printer) gives research XP only — inventory awards `RESEARCH_XP_CRAFT`
      b.on('craft:completed', ({ recipeId }) => { const skill = this.recipeSkill(recipeId); if (skill) this.addSkillXp(skill, CRAFT_XP); }),
      /* ── gear maintenance ── */
      b.on('repair:completed', () => this.addSkillXp('equipment', REPAIR_XP)),
      /* ── tactical implants ── */
      b.on('implant:activated', () => this.addSkillXp('implant', IMPLANT_XP)),
      b.on('implant:equipped', ({ id }) => {
        if (this._profile.implant === id) return;
        this._profile.implant = id;
        this.markDirty(true);
      }),
      /* ── cryptography ── */
      /*
       * 2026-09-15 (user's decision — fixing 「cryptography rises the moment the tutorial starts」): the tutorial
       * raid's **pre-landed** ship merely **replays** this event with `duration: 0` on the first `playing` frame
       * (`extraction/ExtractionSystem.syncPreLandedPhase` — it is aligning the phase to `extracting`, not somebody
       * hacking a console). Paying XP for that one event made cryptography Lv.1 the instant the tutorial began. What
       * tells them apart is the event's own `duration` — the contract (`shared/events.ts` · `ExtractionSystem`) states
       * 「0 = a ship already here, not one being called」, and `ui/hud/Notifications` filters its 「arrives in 0 s」 toast
       * on the same value. A real console hack in the main game is the wait time from `data/extraction.csv`, always
       * greater than 0. The mission mode is checked too — inside the tutorial there is no hacking down any path
       * (`missionMode` is the single axis that marks the tutorial off: the same as `ui/hud/Objective.tutorialRaid`).
       */
      b.on('extraction:activated', ({ duration }) => {
        if (duration <= 0 || ctx.missionMode === 'tutorial') return;
        this.addSkillXp('cryptography', CRYPTO_XP);
      }),
      /* ── appraisal: opening a container + every item revealed by the Tarkov-style search (Phase 7; was `inventory:itemAdded`) ── */
      /* 2026-09-11 (C-16 · X-1): once per container id per raid — every re-open used to pay again (infinite farming by mashing E) */
      b.on('crate:open', ({ crateId }) => {
        if (this.cratesAppraised.has(crateId)) return;
        this.cratesAppraised.add(crateId);
        this.addSkillXp('appraisal', CRATE_OPEN_XP);
      }),
      b.on('container:itemRevealed', ({ rarity }) => {
        this.addSkillXp('appraisal', APPRAISE_XP_BY_RARITY[rarity] ?? APPRAISE_XP_BY_RARITY.common);
      }),
      /* ── the name (2026-09-09): the character's name *is* the operative's name ───────────────────────────
       * The title screen's callsign field used to call `ctx.net.setPlayerName`. That field is gone and the name now
       * belongs to the character (creation window → `PlayerProfile.name`), so the name is pushed into net **every
       * time a profile is loaded** — name tags, the lobby and crew cards all read `ctx.net.playerName`.
       * Why this is the only place: this system owns the profile, and `progress:loaded` is the one point that
       * **all three** cases pass through — boot (microtask broadcast), receiving the server profile, and a character
       * reset. */
      b.on('progress:loaded', ({ profile }) => { try { ctx.net?.setPlayerName(profile.name); } catch { /* net not ready */ } }),
      /* ── the gym (A-3a): the sheet's `(+n)` training bonus · progress line · debuff countdown ── */
      b.on('progress:trainedChanged', ({ id }) => this.refreshSheetStat(id)),
      b.on('progress:gymFatigue', ({ id }) => this.refreshSheetStat(id)),
      /* ── server profile (Phase 7) ── */
      b.on('net:profileLoaded', () => this.onProfileLoaded()),
      /* ── hauling (distance accumulated in update) ── */
      b.on('inventory:weightChanged', ({ state }) => { this.weightState = state; }),
      /* ── gear affects derived (the `특수 가방` perk halves implant cooldowns) ── */
      b.on('equip:changed', () => this.recompute()),
      b.on('loadout:changed', () => this.recompute()),
      /* ── stat points may not be spent mid-raid; refresh the sheet on every phase change ── */
      /* 2026-09-13: a phase change / raid launch / death is a forced exit — unconfirmed ＋ points are dropped silently */
      /* 2026-09-13: recompute (not just repaint) — the library `derived` fold reads the ship state, which housing may have (re)loaded meanwhile */
      b.on('game:phaseChanged', () => { this.discardSheetPending(); this.recompute(); }),
      /* ── library series (2026-09-13): the library summary moved → `derived` (+ the sheet's `시설 ×n` badges) again ── */
      b.on('housing:libraryChanged', () => this.recompute()),
      b.on('player:died', () => this.discardSheetPending()),
      b.on('game:newMission', () => { this.hasLastPos = false; this.weightState = 'normal'; this.cratesAppraised.clear(); this.discardSheetPending(); }),
      b.on('world:ready', () => this.cratesAppraised.clear()),
      b.on('game:abort', () => { this.hasLastPos = false; this.flush(); }),
      /* ── the starter tactical implant (2026-09-14 2nd pass) — `grantStarterImplant` below ── */
      b.on('hub:entered', () => this.grantStarterImplant()),
      /* ── character sheet ── */
      b.on('ui:statsToggled', ({ open }) => {
        if (!this.sheet || this.sheet.isOpen === open) return;
        if (open) this.sheet.open(); else this.sheet.close();
      }),
    );

    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onPageHide);

    // Deferred one microtask: Engine runs every system's init() in one synchronous pass, so listeners
    // registered after us (registration order is owned by main.ts) still receive the initial profile.
    queueMicrotask(() => {
      if (this.ctx !== ctx) return;
      this.recompute();                                        // gear refs exist by now (the `특수 가방` perk)
      ctx.bus.emit('progress:loaded', { profile: this._profile });
      this.emitPrepChanged();                                   // A-13: preparations as of boot (HUD badge · launch prep screen)
      this.emitMealChanged();                                   // A-3c: the meal as of boot (HUD meal badge · dining table screen)
      this.emitGymState();                                      // A-3a: training bonus / workout debuff as of boot (ship debuff badge)
    });
  }

  update(dt: number, ctx: GameContext): void {

    this.trackCarry(ctx);

    if (this.dirty) {
      this.saveTimer -= dt;
      if (this.saveTimer <= 0) this.flush();
    }
  }

  /* ── The starter tactical implant (2026-09-14 2nd pass, user's decision) ───────────────────────────
   * Every new character starts with the grapple equipped, **the first time they enter the ship**. The character
   * creation window's 「starter implant」 choice is gone, so it is granted rather than chosen, and the place it is
   * granted is **entering the ship** — the tutorial raid assumes you have no implant, so it must never be put in your
   * hands mid-raid. Whether the tutorial was finished or skipped, the ship follows, which makes `hub:entered` the one
   * gate.
   *
   * It is **idempotent**: if something is equipped already (`profile.implant !== null`) it changes not one character.
   * The single place that actually equips is `ctx.implants.setEquipped` (the mid-raid refusal and the runtime reset
   * live there), and persisting is finished by the subscription above catching the `implant:equipped` it emits and
   * writing `profile.implant` — `Profile.migrate` carries that field over, so it survives a reload and takes the same
   * road through the server profile round trip.
   */
  private grantStarterImplant(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.phase !== 'hub' || ctx.isRaidActive()) return;
    if (this._profile.implant !== null) return;   // already has one — never granted twice
    const implants = ctx.implants;
    if (!implants) return;                        // implants/ is not registered yet — the next `hub:entered` grants it
    if (!implants.setEquipped(DEFAULT_IMPLANT)) return;
    // `setEquipped` emits `implant:equipped` and the subscription above writes it into the profile. Pin it once more
    // to be safe (if the value was already the same that subscription returns silently, so dirty could be missed here).
    if (this._profile.implant !== DEFAULT_IMPLANT) { this._profile.implant = DEFAULT_IMPLANT; this.markDirty(true); }
    ctx.bus.emit('ui:notify', { text: '전술 임플란트 「갈고리」를 장착했다', kind: 'info', duration: 4 });
  }

  dispose(): void {
    this.flush();
    for (const off of this.offs) off();
    this.offs = [];
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onPageHide);
    this.sheet?.dispose();
    this.sheet = null;
    for (const v of this.views) v.dispose();
    this.views.clear();
    if (this.ctx?.progression === this) this.ctx.progression = null;
  }

  /* ── stats ─────────────────────────────────────────────────────────────── */
  spendStatPoint(id: StatId): boolean {
    const ctx = this.ctx;
    if (!(STAT_IDS as readonly string[]).includes(id)) return false;
    if (ctx?.isRaidActive()) return false;                    // ship only
    if (this._profile.statPoints <= 0) return false;
    const cur = this.getStat(id);
    if (cur >= STAT_MAX) return false;
    this._profile.stats[id] = cur + 1;
    this._profile.statPoints -= 1;
    this.recompute();
    this.markDirty(true);
    ctx?.bus.emit('progress:statChanged', { id, value: this._profile.stats[id], pointsLeft: this._profile.statPoints });
    this.refreshSheets();
    return true;
  }

  /**
   * 2026-09-13 (contract `spendStatPoints`, user's decision — the sheet allocates with ＋/－ and confirms with a 1 s hold): all-or-nothing batch.
   * Refused (false, nothing changes) during a raid, for an unknown key, a non-integer / negative amount, a total of 0 or above
   * `statPoints`, or a stat that would pass `STAT_MAX`. On success: one `recompute`, one immediate save, and one
   * `progress:statChanged` per stat whose value moved.
   */
  spendStatPoints(alloc: Partial<Record<StatId, number>>): boolean {
    const ctx = this.ctx;
    if (!alloc || typeof alloc !== 'object') return false;
    try { if (ctx?.isRaidActive()) return false; } catch { /* treat as not in a raid */ }
    const add: Array<[StatId, number]> = [];
    let total = 0;
    for (const [key, n] of Object.entries(alloc)) {
      if (!(STAT_IDS as readonly string[]).includes(key)) return false;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return false;
      if (n === 0) continue;
      const id = key as StatId;
      if (this.getStat(id) + n > STAT_MAX) return false;
      add.push([id, n]);
      total += n;
    }
    if (total <= 0 || total > this._profile.statPoints) return false;
    for (const [id, n] of add) this._profile.stats[id] = this.getStat(id) + n;
    this._profile.statPoints -= total;
    this.recompute();
    this.markDirty(true);
    for (const [id] of add) ctx?.bus.emit('progress:statChanged', { id, value: this._profile.stats[id], pointsLeft: this._profile.statPoints });
    this.refreshSheets();
    return true;
  }

  /**
   * The character sheet's pre-confirm preview (2026-09-13): `derived` as it would be with `alloc` invested — the
   * **same** path as `recompute` (implants · training bonus · the `특수 가방` perk · meal buff) on a shallow copy of the
   * profile. Nothing is written; amounts are clamped to `STAT_MAX`.
   */
  previewDerived(alloc: Partial<Record<StatId, number>>): DerivedStats {
    const p = this._profile;
    const stats = { ...p.stats };
    for (const id of STAT_IDS) {
      const n = alloc?.[id];
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) stats[id] = Math.min(STAT_MAX, (stats[id] ?? STAT_BASE) + Math.floor(n));
    }
    return this.deriveFor({ ...p, stats });
  }

  /* ── skills ────────────────────────────────────────────────────────────── */
  addSkillXp(id: SkillId, amount: number): void {
    if (!(SKILL_IDS as readonly string[]).includes(id)) return;
    if (!(amount > 0)) return;
    // simulation training range: only marksmanship trains, scaled by TRAINING_SKILL_GAIN_MUL (everything else 0)
    if (this.inTraining()) {
      if (!id.startsWith('gun_')) return;
      amount *= TRAINING_SKILL_GAIN_MUL;
      if (!(amount > 0)) return;
    }
    const profile = this._profile;
    let level = profile.skills[id] ?? 0;
    if (level >= SKILL_LEVEL_MAX) return;

    const def = SKILL_DEF_MAP.get(id);
    // The shooting-range (ship facility) bonus multiplies in here, on top of intelligence (`skillGainMul`) and the skill's own stats.
    const gain = amount * this._derived.skillGainMul * this.getSkillGainMul(id) * this.statFactor(def)
      / (1 + level * SKILL_COST_SLOPE);
    if (!(gain > 0)) return;

    let progress = (profile.skillProgress[id] ?? 0) + gain;
    let leveled = false;
    while (progress >= 1 && level < SKILL_LEVEL_MAX) {
      progress -= 1;
      level += 1;
      leveled = true;
    }
    if (level >= SKILL_LEVEL_MAX) { level = SKILL_LEVEL_MAX; progress = 0; }
    profile.skills[id] = level;
    profile.skillProgress[id] = progress;

    if (leveled) {
      this.recompute();
      this.markDirty(true);
      this.ctx?.bus.emit('progress:skillUp', { id, level });
      this.lastEmitted[id] = progress;
      this.ctx?.bus.emit('progress:skillProgress', { id, level, progress });
      this.refreshSheets();
      return;
    }
    this.markDirty(false);
    const last = this.lastEmitted[id] ?? -1;
    if (Math.abs(progress - last) >= PROGRESS_EMIT_STEP) {
      this.lastEmitted[id] = progress;
      this.ctx?.bus.emit('progress:skillProgress', { id, level, progress });
      this.refreshSheetSkill(id);
    }
  }

  /* ── character XP ──────────────────────────────────────────────────────── */
  addXp(amount: number): void {
    if (!(amount > 0)) return;
    const profile = this._profile;
    profile.xp += amount;
    this.ctx?.bus.emit('progress:xpGained', { amount, xp: profile.xp, xpToNext: this.xpToNext });
    let leveled = false;
    // Guard against a pathological XP grant looping forever.
    for (let i = 0; i < 100; i++) {
      const need = xpForLevel(profile.level);
      if (profile.xp < need) break;
      profile.xp -= need;
      profile.level += 1;
      profile.statPoints += STAT_POINTS_PER_LEVEL;
      leveled = true;
      this.ctx?.bus.emit('progress:levelUp', { level: profile.level, statPoints: profile.statPoints });
    }
    if (leveled) this.markDirty(true);
    else this.markDirty(false);
    this.refreshSheets();
  }

  /* ── persistence ───────────────────────────────────────────────────────── */
  /**
   * Write the profile out right now. Callers that mutated `profile` directly (GameFlow bumps
   * `raids` / `extractions`) rely on this forcing a write, so it ignores the dirty flag.
   */
  save(): void { this.dirty = true; this.flush(); }

  /* ── stat XP (appended 2026-09-06) ─────────────────────────────────────── */
  /** 0..1 toward the next point of `id` (exactly 1 only while the stat sits at STAT_MAX). */
  getStatProgress(id: StatId): number {
    const p = this._profile.statProgress?.[id];
    return typeof p === 'number' && Number.isFinite(p) ? p : 0;
  }

  /** Raw XP for the next point of `id` at its current value: round(STAT_XP_BASE × value^STAT_XP_EXPONENT). */
  statXpToNext(id: StatId): number { return statXpFor(this.getStat(id)); }

  /**
   * Signed raw stat XP. The stored fraction is converted to raw XP at the current value, the amount is added,
   * then points are gained (≥ need → +1, progress carries over relative to the *new* value's need) or lost
   * (< 0 → −1, the deficit is taken off the new value's need). Clamps: STAT_MAX keeps progress pinned at 1,
   * STAT_MIN pins it at 0. Always emits `progress:statXp`; a value change also emits `progress:statChanged`
   * (level-up points untouched), recomputes `derived` and saves immediately.
   */
  addStatXp(id: StatId, amount: number, source: StatXpSource = 'action'): void {
    if (!(STAT_IDS as readonly string[]).includes(id)) return;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return;
    if (source === 'minigame' && isGymStat(id) && amount >= 0) { this.addMinigameStatXp(id, amount); return; }
    const profile = this._profile;
    const sp = profile.statProgress ?? (profile.statProgress = zeroStatProgress());
    const prev = Math.min(STAT_MAX, Math.max(STAT_MIN, Math.round(this.getStat(id))));
    let value = prev;
    let xp = this.getStatProgress(id) * statXpFor(value) + amount;

    // Bounded loop: a cheat may hand over millions of XP, but the stat range is only STAT_MAX − STAT_MIN wide.
    for (let i = 0; i <= STAT_MAX - STAT_MIN + 1; i++) {
      const need = statXpFor(value);
      if (xp >= need) {
        if (value >= STAT_MAX) { xp = need; break; }          // pinned at 1 on the cap
        xp -= need;
        value += 1;
      } else if (xp < 0) {
        if (value <= STAT_MIN) { xp = 0; break; }             // pinned at 0 on the floor
        value -= 1;
        xp += statXpFor(value);                               // deficit carried over relative to the new need
      } else {
        break;
      }
    }

    const need = statXpFor(value);
    let progress = need > 0 ? xp / need : 0;
    progress = Math.max(0, Math.min(value >= STAT_MAX ? 1 : 0.999999, progress));
    if (!Number.isFinite(progress)) progress = 0;
    sp[id] = progress;

    const changed = value !== prev;
    if (changed) {
      profile.stats[id] = value;
      this.recompute();
      this.markDirty(true);
    } else {
      this.markDirty(false);
    }
    const bus = this.ctx?.bus;
    bus?.emit('progress:statXp', { id, value, progress, delta: amount });
    if (changed) bus?.emit('progress:statChanged', { id, value, pointsLeft: profile.statPoints });
    this.refreshSheetStat(id);
  }

  /**
   * 2026-09-17 (user's decision 「the gym and video games share the stat-XP bar」) — the `'minigame'` branch of `addStatXp`.
   *
   * Invariant (one bar, two payouts): a stat has **one** XP bar (`statProgress[id]` × `statXpFor(base)`). Whoever's addition
   * crosses the need decides what the crossing pays —
   *   - action XP (`addStatXp` default) crossing → base stat +1 (`profile.stats`), as before;
   *   - minigame XP (this branch) crossing → training bonus +1 (`profile.trained`); the base stat and the level-up
   *     `statPoints` are never touched. The need is the base stat's, so it stays the same across the whole addition and
   *     every full need in it is one training step (carry-over like action XP).
   * At `GYM_TRAINED_MAX` a minigame addition can no longer cross: the bar is held just below full (0.999999) and the rest
   * is dropped, so the *next action XP* that tips it over pays a base point — minigame XP never pays a base point by itself.
   * A base stat at `STAT_MAX` pins the bar at 1 for action XP; that pinned-full bar counts as empty here (it was not
   * filled by a minigame), so the training bonus can still grow on a maxed stat.
   * Callers pass only finite `amount >= 0` for a `GYM_STATS` id (`addStatXp` routes anything else to the action path).
   * Always saves immediately (a gym session also writes its debuff) and emits `progress:statXp` + `progress:trainedChanged`
   * (+ `progress:statChanged` and a `derived` recompute when the bonus moved).
   */
  private addMinigameStatXp(id: GymStat, amount: number): void {
    const profile = this._profile;
    const sp = profile.statProgress ?? (profile.statProgress = zeroStatProgress());
    const base = Math.min(STAT_MAX, Math.max(STAT_MIN, Math.round(this.getStat(id))));
    const need = statXpFor(base);
    const stored = this.getStatProgress(id);
    let xp = (stored >= 1 ? 0 : stored * need) + amount;
    const before = this.getTrainedBonus(id);
    let n = before;
    // bounded by the cap width — a console grant of millions still ends in ≤ GYM_TRAINED_MAX steps
    for (let i = 0; i <= GYM_TRAINED_MAX && n < GYM_TRAINED_MAX && xp >= need; i++) { xp -= need; n += 1; }
    let progress = Math.max(0, Math.min(0.999999, xp / need));    // at the cap: held just below full (see above)
    if (!Number.isFinite(progress)) progress = 0;
    sp[id] = progress;
    this.writeTrained(id, n);

    const changed = n !== before;
    if (changed) this.recompute();                        // the bonus feeds every stat formula (carry · stamina …)
    this.markDirty(true);                                 // immediate: a reload must neither drop the gain nor the debuff
    const bus = this.ctx?.bus;
    bus?.emit('progress:statXp', { id, value: base, progress, delta: amount });
    bus?.emit('progress:trainedChanged', { id, value: n, progress, delta: amount });
    if (changed) bus?.emit('progress:statChanged', { id, value: this.getStat(id), pointsLeft: profile.statPoints });
    this.refreshSheetStat(id);
  }

  /**
   * Signed raw skill XP straight onto the 0..1 progress fraction — no intelligence / facility / stat / level scaling
   * (`1` = one level at any level). Crossing 1 → level +1 (max SKILL_LEVEL_MAX, progress then 0); dropping below 0
   * → level −1 (never below 0, progress then 0). `progress:skillUp` fires on every level change (also downward,
   * payload carries the new level), `progress:skillProgress` always.
   */
  addSkillXpRaw(id: SkillId, amount: number): void {
    if (!(SKILL_IDS as readonly string[]).includes(id)) return;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return;
    const profile = this._profile;
    const prevLevel = profile.skills[id] ?? 0;
    let level = prevLevel;
    let progress = (profile.skillProgress[id] ?? 0) + amount;

    // Bounded loops: the level range is only SKILL_LEVEL_MAX wide.
    for (let i = 0; i <= SKILL_LEVEL_MAX && progress >= 1 && level < SKILL_LEVEL_MAX; i++) { progress -= 1; level += 1; }
    for (let i = 0; i <= SKILL_LEVEL_MAX && progress < 0 && level > 0; i++) { progress += 1; level -= 1; }
    if (level >= SKILL_LEVEL_MAX) { level = SKILL_LEVEL_MAX; progress = 0; }
    if (level <= 0 && progress < 0) { level = 0; progress = 0; }
    progress = Math.max(0, Math.min(0.999999, progress));
    if (!Number.isFinite(progress)) progress = 0;

    profile.skills[id] = level;
    profile.skillProgress[id] = progress;
    const bus = this.ctx?.bus;
    if (level !== prevLevel) {
      this.recompute();
      this.markDirty(true);
      bus?.emit('progress:skillUp', { id, level });
    } else {
      this.markDirty(false);
    }
    this.lastEmitted[id] = progress;
    bus?.emit('progress:skillProgress', { id, level, progress });
    if (level !== prevLevel) this.refreshSheets(); else this.refreshSheetSkill(id);
  }

  /**
   * Ship skill-gain multiplier: the shooting range (`gun_*` × `1 + 0.1 × level`) × the library (every book of that
   * skill shelved on a bookcase, Phase 9) — housing/ folds both into one `getSkillGainMul`, so progression/ never
   * re-derives either. Read from
   * `ctx.housing`, which may be absent — every hop is guarded so this never throws and never returns a bad number.
   */
  getSkillGainMul(id: SkillId): number {
    try {
      const h = this.ctx?.housing;
      if (!h || typeof h.getSkillGainMul !== 'function') return 1;
      const m = h.getSkillGainMul(id);
      return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 1;
    } catch {
      return 1;
    }
  }

  /* ── embedded character tab (Phase 8) ──────────────────────────────────── */
  /**
   * Render the sheet body inside `host` (the `캐릭터` tab of the inventory Tab screen). Same renderer as the standalone
   * overlay (`ui/SheetBody`), but **no** `'stats'` blocker, no pointer-lock handling, no Escape listener and no
   * `.scr-tabs` pill — the inventory window owns all of those. The handle is refreshed together with the overlay
   * whenever stats / skills / derived change, and drops out of the set on `dispose()`.
   */
  createSheetView(host: HTMLElement): EmbeddedView {
    const view = new SheetView(this.ctx, this, host);
    this.views.add(view);
    return {
      refresh: () => view.refresh(),
      dispose: () => { this.views.delete(view); view.dispose(); },
      // 2026-09-13: unconfirmed ＋ points → the view raises the `버리고 이동` / `돌아가기` warning instead of letting the window leave
      requestLeave: (proceed) => view.requestLeave(proceed),
    };
  }

  /** Full repaint of the overlay and every embedded character tab. */
  private refreshSheets(): void {
    this.sheet?.refresh();
    for (const v of this.views) v.refresh();
  }

  /** Forced exit (server document, reset, phase change, death): drop unconfirmed ＋ points and any sheet popup, no warning. */
  private discardSheetPending(): void {
    this.sheet?.discardPending();
    for (const v of this.views) v.discardPending();
  }

  private refreshSheetSkill(id: SkillId): void {
    this.sheet?.refreshSkill(id);
    for (const v of this.views) v.refreshSkill(id);
  }

  private refreshSheetStat(id: StatId): void {
    this.sheet?.refreshStat(id);
    for (const v of this.views) v.refreshStat(id);
  }

  /* ── server profile (Phase 7) ─────────────────────────────────────────── */
  private profileRef(): ProfileRef | null {
    const p = this.ctx?.net?.profile;
    return p && typeof p === 'object' ? p : null;
  }

  private inTraining(): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    return typeof ctx.isTraining === 'function' ? ctx.isTraining() : ctx.missionMode === 'training';
  }

  /**
   * `net:profileLoaded`: the server `progression` document (when present) replaces the local profile — same
   * `migrate` sanitising as a localStorage load — and the `progress:*` events the sheet / HUD read are re-emitted
   * (`loaded`, `xpGained` with amount 0, one `statChanged` per stat, one `skillProgress` per skill; no `levelUp`).
   * No document yet → the local profile is uploaded so the server has one.
   */
  private onProfileLoaded(): void {
    const p = this.profileRef();
    if (!p || !p.available) return;
    let doc: unknown;
    try { doc = p.get('progression'); } catch { doc = undefined; }
    const next = doc && typeof doc === 'object' ? migrate(doc) : null;
    if (!next) { this.upload(); return; }
    this._profile = next;
    this.lastEmitted = {};
    this.recompute();
    this.dirty = false;
    this.saveTimer = 0;
    saveProfile(this._profile);                 // localStorage is the cache of the server copy
    const bus = this.ctx.bus;
    bus.emit('progress:loaded', { profile: this._profile });
    bus.emit('progress:xpGained', { amount: 0, xp: this._profile.xp, xpToNext: this.xpToNext });
    for (const id of STAT_IDS) bus.emit('progress:statChanged', { id, value: this.getStat(id), pointsLeft: this._profile.statPoints });
    for (const id of SKILL_IDS) {
      const progress = this.getSkillProgress(id);
      this.lastEmitted[id] = progress;
      bus.emit('progress:skillProgress', { id, level: this.getSkill(id), progress });
    }
    this.emitImplantsChanged();                 // Phase 12: the equipped implant items came with the document
    this.emitPrepChanged();                     // A-13: preparations came with the document too (a reconnect return passes here)
    this.emitMealChanged();                     // A-3c: so did the meal (`mealActive` comes back alive)
    this.emitGymState();                        // A-3a: the training bonus and workout debuff came with the document too
    this.discardSheetPending();                 // 2026-09-13: the pending ＋ points were planned against the replaced profile
    this.refreshSheets();
  }

  /**
   * Queue the profile into the server store (`profile:set progression`). Phase 9: called **offline too** — `ProfileSync`
   * keeps the document pending (stamped with the save time) and pushes it on the next connection, newest side wins.
   */
  private upload(): void {
    const p = this.profileRef();
    if (!p || typeof p.set !== 'function') return;
    try { p.set('progression', JSON.parse(JSON.stringify(this._profile))); } catch { /* net not ready */ }
  }

  resetProfile(): void {
    const name = this._profile.name;
    // Phase 12: the equipped implant items are inventory, not character — hand them back to the stash / bag first
    // (best effort; whatever does not fit is lost with the character).
    for (const e of this.equippedList()) this.returnImplant(e);
    clearStoredProfile();
    this._profile = freshProfile(name);
    this.lastEmitted = {};
    this.recompute();
    this.markDirty(true);
    this.flush();
    this.ctx?.bus.emit('progress:loaded', { profile: this._profile });
    this.emitImplantsChanged();
    this.emitPrepChanged();
    this.emitMealChanged();
    this.emitGymState();                        // A-3a: freshProfile cleared the training bonus and the debuff
    this.discardSheetPending();                 // 2026-09-13: nothing left to invest into
    this.refreshSheets();
  }

  /* ── internals ─────────────────────────────────────────────────────────── */
  /** Recompute `derived`; folds in the `특수 가방` perk (implant cooldown −50 %) and the equipped implant items (Phase 12). */
  private recompute(): void {
    if (this.pruneImplants()) this.markDirty(false);     // a removed def id in an old save — drop it silently
    if (this.prunePreps()) this.markDirty(false);        // A-13: same treatment for a preparation def that no longer exists
    if (this.pruneMeal()) this.markDirty(false);         // A-3c: ditto for a meal def that no longer exists
    this._derived = this.deriveFor(this._profile);
    this.refreshSheets();
  }

  /** The one derive path — `recompute` and the sheet's pending preview (`previewDerived`) both go through it. */
  private deriveFor(profile: PlayerProfile): DerivedStats {
    const d = computeDerived(profile, this.hasSpecialBackpack(), this.implantContribution());
    /* A-3c: the meal carried into this raid is folded into the derived stats **last** (`MealBuff` = a `DerivedStats`
     * field name). Consuming folders change by not one line — they read `derived` already. */
    /* 2026-09-13 (cook quality): the meal and quality are read off the profile that was passed in — `recompute` passes
     * the real profile and the sheet preview a shallow copy of it, so both see the same values, and each row is
     * multiplied by `× (1 + mealQualityBonus(quality))` inside `applyMealBuff`. */
    const activeId = typeof profile.mealActive === 'string' && profile.mealActive ? profile.mealActive : null;
    const meal = this.mealDefOf(activeId);
    if (meal) applyMealBuff(d, meal, normalizeMealQuality(profile.mealActiveQuality));
    /* 2026-09-13 (library series): the library `derived` effects housing summed are folded in **after** the meal buff,
     * under the same rule (one addition + 0 floor). They are ship state, so they hold during a raid too, and the sheet
     * preview goes down this one path and therefore sees the same values. */
    applyLibraryDerived(d, this.libraryDerived());
    return d;
  }

  /** `ctx.housing.getLibraryEffects().derived` — null when housing is absent, not implemented yet, or throws (nothing to fold). */
  private libraryDerived(): Readonly<Partial<Record<MealBuff, number>>> | null {
    try {
      const h = this.ctx?.housing;
      if (!h || typeof h.getLibraryEffects !== 'function') return null;
      const lib = h.getLibraryEffects()?.derived;
      return lib && typeof lib === 'object' ? lib : null;
    } catch {
      return null;
    }
  }

  /**
   * `ctx.inventory` / `ctx.loot` are built by other systems that may not expose the gear API yet —
   * every hop is optional and any throw falls back to "no perk".
   */
  private hasSpecialBackpack(): boolean {
    // Merged design keeps the weapon-package bags (`BagDef`); the `특수 가방` implant perk is carried by tactical bags.
    try {
      const inv = this.ctx?.inventory;
      const loot = this.ctx?.loot;
      if (!inv || !loot || typeof inv.getEquipped !== 'function') return false;
      const item = inv.getEquipped('bag');
      if (!item) return false;
      return loot.getItemDef?.(item.defId)?.bag?.tactical === true;
    } catch {
      return false;
    }
  }

  /** Relevant-stat speed-up for a skill (intelligence is applied separately through `skillGainMul`). */
  private statFactor(def: SkillDef | undefined): number {
    if (!def || def.stats.length === 0) return 1;
    let sum = 0;
    for (const s of def.stats) sum += this.getStat(s);
    const avg = sum / def.stats.length;
    return Math.max(0.4, 1 + SKILL_STAT_FACTOR * (avg - STAT_BASE));
  }

  /**
   * The shooting-skill class a weapon trains, or null.
   * 2026-09-15 (user's decision): legendary uniques (`def.unique`) are outside the shooting-skill system — they keep a csv
   * `class` but train nothing (and get no `recoilMul` / `reloadSpeedMul` in weapons/).
   */
  private weaponClassOf(weaponId: string | null): WeaponClass | null {
    if (!weaponId) return null;
    try {
      const def = this.ctx?.loot?.getWeaponDef(weaponId);
      if (!def || def.unique) return null;
      return def.weaponClass ?? (def.slot === 'secondary' ? 'PISTOL' : 'AR');
    } catch {
      return null;
    }
  }

  /**
   * crafting vs medicine vs gardening — read off the recipe when items/ exposes them, else default to crafting.
   * 2026-09-13 (user's decision): a recipe of a lab bench (`LAB_BENCHES` — extractor · mixer · 3D printer) returns null
   * — it gives no crafting XP (research XP is inventory's job).
   */
  private recipeSkill(recipeId: string): SkillId | null {
    try {
      const loot = this.ctx?.loot;
      if (!loot || typeof loot.getAllRecipes !== 'function') return 'crafting';
      const r = loot.getAllRecipes().find((x) => x.id === recipeId);
      if (r?.bench && LAB_BENCHES.has(r.bench)) return null;
      const s = r?.skill;
      if (s === 'medicine' || s === 'gardening' || s === 'crafting') return s;
      return 'crafting';
    } catch {
      return 'crafting';
    }
  }

  /**
   * Hauling: accumulate distance covered while the bag is at 「조금 무거움」 (slightly heavy) or worse.
   *
   * 2026-09-16 (bug fix, user's decision 「only what you moved under your own power」): this used to count the
   * per-frame delta of `ctx.player.position` — riding an extraction ship's liftoff with a heavy bag trained hauling,
   * and the grapple, dash, tram, rover and being carried were all distance too (only a single frame over 20 m was
   * dropped). It now counts only the growth of the odometer that collects **distance moved under the player's own
   * power** (`PlayerRef.selfMovedMeters`) — what that excludes is documented in that contract's comment and nowhere
   * else. With no odometer (an older player/) nothing is awarded.
   */
  private trackCarry(ctx: GameContext): void {
    const p = ctx.player;
    const odo = p?.selfMovedMeters;
    if (!p || typeof odo !== 'number' || !Number.isFinite(odo) || !ctx.isGameplayPhase() || p.isDead) { this.hasLastPos = false; return; }
    if (!this.hasLastPos) { this.lastSelfMoved = odo; this.hasLastPos = true; return; }
    const dist = odo - this.lastSelfMoved;
    this.lastSelfMoved = odo;
    if (this.weightState === 'normal' || !(dist > 0)) return;
    this.addSkillXp('carry', dist * CARRY_XP_PER_METER);
  }

  private markDirty(immediate: boolean): void {
    this.dirty = true;
    if (immediate) this.flush();
    else if (this.saveTimer <= 0) this.saveTimer = AUTOSAVE_INTERVAL;
  }

  /** Write the profile out now (no-op when nothing changed): localStorage, then the server profile document. */
  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.saveTimer = 0;
    saveProfile(this._profile);
    this.upload();
  }
}

export { SPECIAL_BACKPACK_CD_MUL, xpForLevel };
