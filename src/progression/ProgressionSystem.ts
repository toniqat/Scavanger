import type { EquippedImplant, EnvKind, ImplantItemDef, ItemInstance, MealDef,
  DerivedStats, EmbeddedView, GameContext, GameSystem, GymSessionResult, GymStat, PlayerProfile, ProfileRef, ProgressionRef,
  SkillDef, SkillId, StatDef, StatId, WeaponClass,
} from '@/shared';
import {
  GYM_FATIGUE_GAIN_MUL, GYM_FATIGUE_HOURS, GYM_SESSION_XP, GYM_STATS, GYM_TRAIN_XP_BASE, GYM_TRAIN_XP_EXPONENT, GYM_TRAINED_MAX,
  brokenImplantIdOf,
  IMPLANT_SLOTS_BASE, IMPLANT_SLOTS_MAX, IMPLANT_SLOTS_PER_LEVELS,
  SKILL_IDS, SKILL_LEVEL_MAX, STAT_BASE, STAT_IDS, STAT_MAX, STAT_MIN, STAT_POINTS_PER_LEVEL,
  STAT_XP_BASE, STAT_XP_EXPONENT, TRAINING_SKILL_GAIN_MUL,
  normalizeMealQuality,
} from '@/shared';
import {
  APPRAISE_XP_BY_RARITY, CARRY_XP_PER_METER, CRAFT_XP, CRATE_OPEN_XP, CRYPTO_XP, GATHER_XP, GRIT_SAVE_XP,
  GUN_HIT_XP, IMPLANT_XP, REPAIR_XP, SKILL_DEF_MAP, SKILL_DEFS, STAT_DEF_MAP, STAT_DEFS, WEAPON_CLASS_SKILL,
} from './defs';
import { applyMealBuff, computeDerived, DEFAULT_DERIVED, SKILL_STAT_FACTOR, SPECIAL_BACKPACK_CD_MUL, emptyPerks, trainedBonusOf, xpForLevel, type ImplantContribution } from './derive';
import { clearStoredProfile, freshProfile, loadProfile, migrate, saveProfile, zeroStatProgress } from './Profile';
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
 * Phase 11 (2026-09-07): the undocumented `P` convenience toggle is **retired**. 캐릭터 is a Tab-screen tab since
 * Phase 8 (`ui:statsToggled` still opens the overlay for anyone who emits it), and P now belongs to `Keys.INVITE`
 * (분대 초대 수락 홀드). Both listened with `uiBlockers.size === 0`, so they would have fought each other.
 */

/** 단련 경험치 needed to go from 단련 보너스 `n` to `n + 1`: round(GYM_TRAIN_XP_BASE × (n+1)^GYM_TRAIN_XP_EXPONENT) (A-3a). */
export function trainedXpFor(n: number): number {
  const k = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  return Math.max(1, Math.round(GYM_TRAIN_XP_BASE * Math.pow(k + 1, GYM_TRAIN_XP_EXPONENT)));
}

const isGymStat = (id: unknown): id is GymStat => (GYM_STATS as readonly unknown[]).includes(id);

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
 *   re-emits the `progress:*` events the sheet / HUD read. In a 시뮬레이션 훈련장 only `gun_*` skills train.
 */
export class ProgressionSystem implements GameSystem, ProgressionRef {
  readonly name = 'progression';

  /* ── 임플란트 아이템 (Phase 12, 2026-09-08) ─────────────────────────────────
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
   * Base stat + equipped implant bonuses + 헬스장 단련 보너스 (A-3a) — what `derived` is computed from. The name predates
   * the gym; the contract keeps its meaning (「`derived` 가 계산되는 값」), so it includes `trained` too.
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
   * Ship only. Rebuilds the item instance (same uid / durability) and puts it in the 함선 창고, else the bag. false —
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
   * **Death only** (2026-09-11 C-12, 사용자 결정): every equipped implant leaves the body — the ship gate of
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

  /* ══ 준비물 (A-13, 2026-09-11 — 사용자 결정: 함선에서 쓰면 다음 레이드 1회분) ════════════════════════════
   * `profile.prep` = 다음 레이드에 실릴 것, `profile.prepActive` = 이번 레이드에 실려 있는 것. 환경(`EnvKind`)당
   * 하나이고 출격 순간 `armPreps()` 가 대기분을 통째로 옮긴다. 사망해도 비우지 않는다 (「이미 마신 약」) —
   * 비우는 곳은 레이드 종료(`clearActivePreps`) 하나뿐이다. 프로필에 살기 때문에 재접속 · 이어하기로 돌아온
   * 사람이 조용히 잃지 않는다 (2026-09-10 규약).
   * ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  getPreps(): readonly string[] { return this.prepList(); }
  getActivePreps(): readonly string[] { return this.activePrepList(); }

  /**
   * 함선 전용. 준비물 def id 하나를 다음 레이드 대기분에 싣는다. 아이템을 빼는 것은 **부르는 쪽**(inventory)의
   * 몫이고, 여기는 거절이면 **아무것도 바꾸지 않는다** — 그래서 inventory 가 먼저 묻고 성공할 때만 뺀다.
   * null = 실렸다, 문자열 = 한국어 거절 사유.
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
   * 출격: 대기분을 이번 레이드분으로 옮긴다 (game/ 이 레이드 시작 때 한 번). 대기분이 비어 있으면 **아무것도
   * 하지 않는다** — 재접속 · 솔로 이어하기도 `game:newMission` 을 지나가므로, 여기서 `prepActive` 를 덮으면
   * 돌아온 사람이 이번 레이드분을 잃는다.
   */
  armPreps(): void {
    this.armMeal();                                     // A-3c: 식사 칸도 같은 자리에서 옮긴다 (game/ 무변경)
    const waiting = this.prepList();
    if (waiting.length === 0) return;
    const active = this.activePrepList();
    for (const id of waiting) {
      const env = this.prepEnvOf(id);
      // 이번 레이드에 같은 환경이 이미 실려 있으면(재접속 뒤 남은 대기분) 중복해서 싣지 않는다.
      if (active.includes(id)) continue;
      if (env && active.some((a) => this.prepEnvOf(a) === env)) continue;
      active.push(id);
    }
    this._profile.prep = [];
    this.afterPrepsChanged();
  }

  /** 레이드 종료(탈출 · 전멸 · 포기 · `game:abort`). 사망만으로는 부르지 않는다. */
  clearActivePreps(): void {
    this.clearActiveMeal();                             // A-3c: 식사 칸도 같은 자리에서 비운다
    if (this.activePrepList().length === 0) return;
    this._profile.prepActive = [];
    this.afterPrepsChanged();
  }

  /**
   * 출격: 대기 식사를 이번 레이드분으로 옮긴다. **대기가 비어 있으면 아무것도 하지 않는다** — 준비물과
   * 같은 이유다: 재접속 · 솔로 이어하기도 `game:newMission` 을 지나가므로, 여기서 `mealActive` 를 덮으면
   * 돌아온 사람이 이번 레이드의 밥을 잃는다.
   */
  private armMeal(): void {
    const waiting = this.mealId();
    if (!waiting) return;
    this._profile.mealActive = waiting;
    this._profile.mealActiveQuality = this.getMealQuality();   // 2026-09-13: 품질은 id 와 함께 옮긴다
    this._profile.meal = null;
    this._profile.mealQuality = 0;
    this.recompute();                                   // 버프가 `derived` 에 실리는 자리
    this.afterMealChanged();
  }

  private clearActiveMeal(): void {
    if (!this.activeMealId()) return;
    this._profile.mealActive = null;
    this._profile.mealActiveQuality = 0;                // 2026-09-13: 품질도 함께 비운다
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
   * Drop stored ids whose def no longer resolves as a 준비물 (a removed item, a corrupt file). Runs inside
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

  /* ══ 식사 (A-3c, 2026-09-11 — 사용자 결정: 별도 「식사」 칸 1개) ═══════════════════════════════════════════
   * 준비물의 **형제**다: `profile.meal` = 다음 레이드에 실릴 요리, `profile.mealActive` = 이번 레이드에 실린 것.
   * 옮기고(`armPreps`) 비우는(`clearActivePreps`) 자리가 준비물과 **같아서** `game/` 은 한 줄도 안 바뀐다.
   * 다른 점은 둘이다 — ① 칸이 하나뿐이라 배열이 아니고, ② 두 번째 요리는 거절이 아니라 **교체**다
   * (「바꿔 먹는다」). 버프는 `mealActive` 의 `MealDef` 를 `recompute` 가 `derived` 에 접는다.
   * ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  getMeal(): string | null { return this.mealId(); }
  getActiveMeal(): string | null { return this.activeMealId(); }

  /**
   * 함선 전용. 요리 def id 하나를 다음 레이드 대기분에 싣는다. 아이템을 빼는 것은 **부르는 쪽**(inventory ·
   * housing 의 식탁)의 몫이고, 여기는 거절이면 아무것도 바꾸지 않는다 — 그래서 부르는 쪽이 **먼저 묻고**
   * 성공할 때만 뺀다 (`usePrep` 과 같은 규약). null = 실렸다, 문자열 = 한국어 거절 사유.
   */
  useMeal(defId: string, quality = 0): string | null {
    const ctx = this.ctx;
    if (typeof defId !== 'string' || !defId) return '알 수 없는 요리입니다';
    if (ctx?.isRaidActive()) return '레이드 중에는 먹을 수 없습니다';
    if (ctx && ctx.phase !== 'hub') return '함선에서만 먹을 수 있습니다';
    if (!this.mealDefOf(defId)) return '알 수 없는 요리입니다';
    const q = normalizeMealQuality(quality);
    /* 같은 요리를 한 번 더 먹는 것만은 거절한다 — 바뀌는 것이 하나도 없는데 null 을 돌려주면 부르는 쪽이
     * 아이템을 **그냥 버린다**. 「교체」 결정은 *다른* 요리에 대한 것이다.
     * 2026-09-13 (요리 품질): 「같은 요리」 는 **같은 id · 같은 품질**이다 — 품질이 다르면 버프 수치가 바뀌므로 교체다. */
    if (this._profile.meal === defId && this.getMealQuality() === q) return '이미 같은 요리를 먹었습니다';
    this._profile.meal = defId;                          // 다른 요리를 이미 차려 뒀으면 **조용히 교체**한다
    this._profile.mealQuality = q;
    this.afterMealChanged();
    return null;
  }

  /**
   * 공유 함선 식탁: 남이 차려 준 요리를 **아이템 소모 없이** 받는다. 이미 먹었어도 교체된다.
   * 받는 쪽 가드(로비 멤버 · 같은 공유 함선 · `MEAL_SERVE_RANGE` · 요율 · **호스트가 보낸 것만**)는 net 이
   * 이미 통과시켰다 — 여기서는 레이드 중이 아니고 실제 요리일 때만 싣는다.
   */
  serveMeal(defId: string, quality = 0): void {
    const ctx = this.ctx;
    if (typeof defId !== 'string' || !defId) return;
    if (ctx?.isRaidActive()) return;                     // 레이드 중인 사람에게는 차릴 수 없다 (net 이 이미 막지만 이중으로)
    if (!this.mealDefOf(defId)) return;
    const q = normalizeMealQuality(quality);             // 2026-09-13: 차린 요리의 품질 그대로 (리드 기본값)
    if (this._profile.meal === defId && this.getMealQuality() === q) return;
    this._profile.meal = defId;
    this._profile.mealQuality = q;
    this.afterMealChanged();
  }

  /** 2026-09-13 (요리 품질): 대기 중인 식사의 품질 0 … `MEAL_QUALITY_MAX` (식사가 없으면 0). */
  getMealQuality(): number {
    return this.mealId() ? normalizeMealQuality(this._profile.mealQuality) : 0;
  }

  /** 2026-09-13 (요리 품질): 이번 레이드에 실린 식사의 품질 (없으면 0). */
  getActiveMealQuality(): number {
    return this.activeMealId() ? normalizeMealQuality(this._profile.mealActiveQuality) : 0;
  }

  /** 프로필의 대기 식사 id (없으면 null). */
  private mealId(): string | null {
    const v = this._profile.meal;
    return typeof v === 'string' && v ? v : null;
  }

  private activeMealId(): string | null {
    const v = this._profile.mealActive;
    return typeof v === 'string' && v ? v : null;
  }

  /** `ItemDef.meal` of a def id, or null when items/ does not know it (yet) / it is not a 요리. */
  private mealDefOf(defId: string | null): MealDef | null {
    if (!defId) return null;
    try { return this.ctx?.loot?.getItemDef(defId)?.meal ?? null; } catch { return null; }
  }

  /**
   * Drop a stored meal id whose def no longer resolves as a 요리 (a removed item, a corrupt file). Runs inside
   * `recompute` once `ctx.loot` exists — the same shape as `prunePreps`. Returns true when something went.
   */
  private pruneMeal(): boolean {
    const loot = this.ctx?.loot;
    if (!loot || typeof loot.getItemDef !== 'function') return false;
    let changed = false;
    for (const key of ['meal', 'mealActive'] as const) {
      const id = key === 'meal' ? this.mealId() : this.activeMealId();
      if (id && !this.mealDefOf(id)) {
        this._profile[key] = null;
        this._profile[key === 'meal' ? 'mealQuality' : 'mealActiveQuality'] = 0;   // 2026-09-13: 품질도 함께
        changed = true;
      }
    }
    return changed;
  }

  /** 대기분이 바뀌었다 — 저장 + 이벤트. `mealActive` 를 건드린 곳은 `recompute` 도 함께 부른다. */
  private afterMealChanged(): void {
    this.markDirty(true);
    this.emitMealChanged();
  }

  private emitMealChanged(): void {
    this.ctx?.bus.emit('progress:mealChanged', {
      meal: this.mealId(), active: this.activeMealId(),
      mealQuality: this.getMealQuality(), activeQuality: this.getActiveMealQuality(),   // 2026-09-13 요리 품질
    });
  }

  /* ══ 헬스장 — 단련 보너스 · 운동 디버프 (A-3a, 2026-09-12 — 사용자 결정: 스탯 포인트와 따로 센다) ══════════════════════
   * housing 의 미니게임이 끝나면 `applyGymSession(stat, 점수)` 를 부른다. 점수 → 단련 경험치 → `profile.trained[stat]`
   * (상한 `GYM_TRAINED_MAX`, 넘친 경험치는 이월). 단련 보너스는 `stats` 와 섞이지 않고 `derive.stat()` 가 임플란트 보너스와
   * **같은 자리**에서 더한다. 끝낸 세션은 디버프가 없던 능력치에 `GYM_FATIGUE_HOURS` 의 디버프를 건다 (디버프 중이면
   * 경험치 × `GYM_FATIGUE_GAIN_MUL` 이고 디버프는 늘지 않는다). 시각은 `ctx.net.serverNow() ?? Date.now()` (온실과 같은
   * 현실 시간). 세 필드 모두 프로필에 살고 `Profile.sanitizeGym` 이 migrate 에서 옮겨 담는다.
   * ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  getTrainedBonus(id: StatId): number { return trainedBonusOf(this._profile, id); }

  getTrainedProgress(id: StatId): number {
    if (!isGymStat(id)) return 0;
    if (this.getTrainedBonus(id) >= GYM_TRAINED_MAX) return 1;
    const p = this._profile.trainedProgress?.[id];
    return typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(0.999999, p)) : 0;
  }

  trainedXpToNext(id: StatId): number { return trainedXpFor(this.getTrainedBonus(id)); }

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
   * 함선 전용. 끝낸 운동 세션 하나를 반영한다 (§4 공식). null — 아무것도 바꾸지 않는다 — 레이드 중 · 함선 phase 가 아님 ·
   * 운동 능력치가 아님. 점수는 0 … 1 로 자르고(NaN = 0), 점수 0 이어도 끝낸 세션이면 디버프가 걸린다.
   * `xp` 는 **실제로 더해진** 경험치다 — 디버프 중이거나 이미 상한이면 0.
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
    const xp = this.getTrainedBonus(id) >= GYM_TRAINED_MAX ? 0 : Math.max(0, Math.round(earned));

    // the debuff is written before the step, whose immediate save then carries both
    let fatigueUntil = activeUntil;
    if (!wasFatigued) {
      fatigueUntil = now + GYM_FATIGUE_HOURS * 3600e3;
      const p = this._profile;
      (p.gymFatigueUntil ?? (p.gymFatigueUntil = {}))[id] = fatigueUntil;
    }
    const step = this.stepTrained(id, xp);
    if (!wasFatigued) ctx.bus.emit('progress:gymFatigue', { id, until: fatigueUntil });

    return {
      stat: id, score: s, xp, wasFatigued, trainedBefore: step.before, trainedAfter: step.after,
      progress: step.progress, capped: step.capped, fatigueUntil,
    };
  }

  /**
   * 개발자 콘솔 `gym` 전용 (계약 appended 2026-09-12): 단련 경험치를 디버프 · 함선 게이트 · 세션 상한 없이 더한다.
   * 음수는 뺀다 — 진행도가 0 아래로 가면 한 단계씩 내려가고 0 · 0 이 바닥이다. 상한 `GYM_TRAINED_MAX`.
   * 운동 능력치가 아니거나 유한한 수가 아니면 아무것도 하지 않는다.
   */
  addTrainedXp(id: GymStat, xp: number): void {
    if (!isGymStat(id) || typeof xp !== 'number' || !Number.isFinite(xp)) return;
    this.stepTrained(id, xp);
  }

  /**
   * 개발자 콘솔 `gym clear` 전용: 운동 디버프를 지운다 (`id` 생략 = 둘 다). 지운 능력치마다 `progress:gymFatigue {id, until: 0}` 를
   * 내서 시트 · 배지가 곧바로 다시 그리게 하고, 무언가 지웠으면 즉시 저장한다. 지난 스탬프도 함께 치운다.
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

  /**
   * The one 단련 step shared by `applyGymSession` and `addTrainedXp`: signed `xp` on top of the stored progress.
   * The stored fraction becomes raw XP at the current step (0 at the cap — progress 1 there is only a pin), then the bonus
   * climbs as many steps as the XP pays for (carry-over, cap `GYM_TRAINED_MAX` → progress 1) or, for a deficit, drops one
   * step at a time adding that step's need back (floor 0 · 0). Both loops are bounded by the cap width.
   * Writes the profile, recomputes `derived` when the bonus moved, saves **immediately**, and emits
   * `progress:trainedChanged {delta: xp}` (+ `progress:statChanged` when the bonus moved).
   */
  private stepTrained(id: GymStat, xp: number): { before: number; after: number; progress: number; capped: boolean } {
    const before = this.getTrainedBonus(id);
    let n = before;
    let raw = (before >= GYM_TRAINED_MAX ? 0 : this.getTrainedProgress(id) * trainedXpFor(n)) + xp;
    for (let i = 0; i <= GYM_TRAINED_MAX && n < GYM_TRAINED_MAX && raw >= trainedXpFor(n); i++) {
      raw -= trainedXpFor(n);
      n += 1;
    }
    for (let i = 0; i <= GYM_TRAINED_MAX && n > 0 && raw < 0; i++) {
      n -= 1;
      raw += trainedXpFor(n);
    }
    if (!(raw > 0)) raw = 0;
    const capped = n >= GYM_TRAINED_MAX;
    if (capped) n = GYM_TRAINED_MAX;
    let progress = capped ? 1 : Math.max(0, Math.min(0.999999, raw / trainedXpFor(n)));
    if (!Number.isFinite(progress)) progress = 0;

    const p = this._profile;
    const trained = p.trained ?? (p.trained = {});
    const prog = p.trainedProgress ?? (p.trainedProgress = {});
    if (n > 0) trained[id] = n; else delete trained[id];
    if (progress > 0) prog[id] = progress; else delete prog[id];

    const changed = n !== before;
    if (changed) this.recompute();                        // the bonus feeds every stat formula (carry · stamina …)
    this.markDirty(true);                                 // immediate: a reload must neither drop the gain nor the debuff

    const bus = this.ctx?.bus;
    bus?.emit('progress:trainedChanged', { id, value: n, progress, delta: xp });
    if (changed) bus?.emit('progress:statChanged', { id, value: this.getStat(id), pointsLeft: p.statPoints });
    return { before, after: n, progress, capped };
  }

  /** Re-announce the 헬스장 state (boot · server document · reset): `trainedChanged` with delta 0, `gymFatigue` while active. */
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
  /** Embedded 캐릭터 tabs handed out by `createSheetView` (Phase 8) — refreshed alongside the overlay. */
  private views = new Set<SheetView>();

  private dirty = false;
  private saveTimer = 0;

  /** Weapon def id of the last shot fired locally — `weapon:hit` carries no weapon id. */
  private lastFiredWeapon: string | null = null;
  private equippedWeapon: string | null = null;
  /** true once the current shot already trained the shooting skill (shotguns emit one `weapon:hit` per pellet). */
  private shotCredited = false;
  /** Latest `inventory:weightChanged` state (drives the 운반 skill). */
  private weightState: string = 'normal';
  private lastX = 0;
  private lastZ = 0;
  private hasLastPos = false;
  /** Container ids whose `crate:open` already paid 감정 XP this raid (C-16 · X-1; cleared on `game:newMission` / `world:ready`). */
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
      /* ── 인내 ── */
      b.on('player:gritSaved', () => this.addSkillXp('grit', GRIT_SAVE_XP)),
      /* ── 원예 (고철 해체는 2026-09-08 부터 제작 숙련으로) ── */
      b.on('gather:collected', ({ kind }) => this.addSkillXp(kind === 'salvage' ? 'crafting' : 'gardening', GATHER_XP)),
      /* ── 제작 / 의학 ── */
      b.on('craft:completed', ({ recipeId }) => this.addSkillXp(this.recipeSkill(recipeId), CRAFT_XP)),
      /* ── 장비 관리 ── */
      b.on('repair:completed', () => this.addSkillXp('equipment', REPAIR_XP)),
      /* ── 전술 임플란트 ── */
      b.on('implant:activated', () => this.addSkillXp('implant', IMPLANT_XP)),
      b.on('implant:equipped', ({ id }) => {
        if (this._profile.implant === id) return;
        this._profile.implant = id;
        this.markDirty(true);
      }),
      /* ── 암호학 ── */
      b.on('extraction:activated', () => this.addSkillXp('cryptography', CRYPTO_XP)),
      /* ── 감정: opening a container + every item revealed by the Tarkov-style search (Phase 7; was `inventory:itemAdded`) ── */
      /* 2026-09-11 (C-16 · X-1): once per container id per raid — every re-open used to pay again (E 연타 무한 파밍) */
      b.on('crate:open', ({ crateId }) => {
        if (this.cratesAppraised.has(crateId)) return;
        this.cratesAppraised.add(crateId);
        this.addSkillXp('appraisal', CRATE_OPEN_XP);
      }),
      b.on('container:itemRevealed', ({ rarity }) => {
        this.addSkillXp('appraisal', APPRAISE_XP_BY_RARITY[rarity] ?? APPRAISE_XP_BY_RARITY.common);
      }),
      /* ── 이름 (2026-09-09): 캐릭터의 이름이 곧 대원 이름이다 ────────────────────────────────────────────
       * 예전에는 타이틀의 콜사인 입력칸이 `ctx.net.setPlayerName` 을 불렀다. 그 칸이 사라지고 이름은
       * 캐릭터(생성창 → `PlayerProfile.name`)의 것이 됐으므로, **프로필이 실릴 때마다** 그 이름을 net 으로
       * 밀어 넣는다 — 명찰 · 로비 · 크루 카드가 전부 `ctx.net.playerName` 을 읽는다.
       * 여기가 유일한 자리인 이유: 프로필의 주인이 이 시스템이고, `progress:loaded` 는 부팅(마이크로태스크
       * 방송) · 서버 프로필 수신 · 캐릭터 초기화 **세 경우 모두** 지나가는 한 지점이다. */
      b.on('progress:loaded', ({ profile }) => { try { ctx.net?.setPlayerName(profile.name); } catch { /* net 미준비 */ } }),
      /* ── 헬스장 (A-3a): the sheet's `(+n 단련)` · progress line · debuff countdown ── */
      b.on('progress:trainedChanged', ({ id }) => this.refreshSheetStat(id)),
      b.on('progress:gymFatigue', ({ id }) => this.refreshSheetStat(id)),
      /* ── server profile (Phase 7) ── */
      b.on('net:profileLoaded', () => this.onProfileLoaded()),
      /* ── 운반 (distance accumulated in update) ── */
      b.on('inventory:weightChanged', ({ state }) => { this.weightState = state; }),
      /* ── gear affects derived (특수 가방 halves implant cooldowns) ── */
      b.on('equip:changed', () => this.recompute()),
      b.on('loadout:changed', () => this.recompute()),
      /* ── stat points may not be spent mid-raid; refresh the sheet on every phase change ── */
      /* 2026-09-13: a phase change / raid launch / death is a forced exit — unconfirmed ＋ points are dropped silently */
      b.on('game:phaseChanged', () => { this.discardSheetPending(); this.refreshSheets(); }),
      b.on('player:died', () => this.discardSheetPending()),
      b.on('game:newMission', () => { this.hasLastPos = false; this.weightState = 'normal'; this.cratesAppraised.clear(); this.discardSheetPending(); }),
      b.on('world:ready', () => this.cratesAppraised.clear()),
      b.on('game:abort', () => { this.hasLastPos = false; this.flush(); }),
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
      this.recompute();                                        // gear refs exist by now (특수 가방 perk)
      ctx.bus.emit('progress:loaded', { profile: this._profile });
      this.emitPrepChanged();                                   // A-13: 부팅 시점의 준비물 (HUD 배지 · 출격 준비 화면)
      this.emitMealChanged();                                   // A-3c: 부팅 시점의 식사 (HUD 식사 배지 · 식탁 화면)
      this.emitGymState();                                      // A-3a: 부팅 시점의 단련 · 운동 디버프 (함선 디버프 배지)
    });
  }

  update(dt: number, ctx: GameContext): void {

    this.trackCarry(ctx);

    if (this.dirty) {
      this.saveTimer -= dt;
      if (this.saveTimer <= 0) this.flush();
    }
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
   * 2026-09-13 (계약 `spendStatPoints`, 사용자 결정 — 시트는 ＋/－ 로 배분해 두고 1초 홀드로 확정한다): all-or-nothing batch.
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
   * 캐릭터 시트의 확정 전 미리보기 (2026-09-13): `derived` as it would be with `alloc` invested — the **same** path as `recompute`
   * (implants · 단련 · 특수 가방 · meal buff) on a shallow copy of the profile. Nothing is written; amounts are clamped to `STAT_MAX`.
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
    // 시뮬레이션 훈련장: only marksmanship trains, scaled by TRAINING_SKILL_GAIN_MUL (everything else 0)
    if (this.inTraining()) {
      if (!id.startsWith('gun_')) return;
      amount *= TRAINING_SKILL_GAIN_MUL;
      if (!(amount > 0)) return;
    }
    const profile = this._profile;
    let level = profile.skills[id] ?? 0;
    if (level >= SKILL_LEVEL_MAX) return;

    const def = SKILL_DEF_MAP.get(id);
    // 사격장 (ship facility) bonus multiplies in here, on top of 지능 (`skillGainMul`) and the skill's own stats.
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
  addStatXp(id: StatId, amount: number): void {
    if (!(STAT_IDS as readonly string[]).includes(id)) return;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return;
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
   * Signed raw skill XP straight onto the 0..1 progress fraction — no 지능 / facility / stat / level scaling
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
   * Ship skill-gain multiplier: 사격장 (`gun_*` × `1 + 0.1 × level`) × 서재 (every book of that skill shelved on a
   * 책장, Phase 9) — housing/ folds both into one `getSkillGainMul`, so progression/ never re-derives either. Read from
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

  /* ── embedded 캐릭터 tab (Phase 8) ─────────────────────────────────────── */
  /**
   * Render the sheet body inside `host` (the inventory Tab screen's 캐릭터 tab). Same renderer as the standalone
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
      // 2026-09-13: unconfirmed ＋ points → the view raises the 버리고 이동 / 돌아가기 warning instead of letting the window leave
      requestLeave: (proceed) => view.requestLeave(proceed),
    };
  }

  /** Full repaint of the overlay and every embedded 캐릭터 tab. */
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
    this.emitImplantsChanged();                 // Phase 12: the equipped 임플란트 items came with the document
    this.emitPrepChanged();                     // A-13: 준비물도 문서와 함께 왔다 (재접속 복귀가 여기를 지난다)
    this.emitMealChanged();                     // A-3c: 식사도 마찬가지 (`mealActive` 가 살아서 돌아온다)
    this.emitGymState();                        // A-3a: 단련 보너스 · 운동 디버프도 문서와 함께 왔다
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
    // Phase 12: the equipped 임플란트 items are inventory, not character — hand them back to the stash / bag first
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
    this.emitGymState();                        // A-3a: freshProfile 이 단련 · 디버프를 비웠다
    this.discardSheetPending();                 // 2026-09-13: nothing left to invest into
    this.refreshSheets();
  }

  /* ── internals ─────────────────────────────────────────────────────────── */
  /** Recompute `derived`; folds in the 특수 가방 perk (implant cooldown −50 %) and the equipped 임플란트 items (Phase 12). */
  private recompute(): void {
    if (this.pruneImplants()) this.markDirty(false);     // a removed def id in an old save — drop it silently
    if (this.prunePreps()) this.markDirty(false);        // A-13: same treatment for a 준비물 def that no longer exists
    if (this.pruneMeal()) this.markDirty(false);         // A-3c: ditto for a 요리 def that no longer exists
    this._derived = this.deriveFor(this._profile);
    this.refreshSheets();
  }

  /** The one derive path — `recompute` and the sheet's pending preview (`previewDerived`) both go through it. */
  private deriveFor(profile: PlayerProfile): DerivedStats {
    const d = computeDerived(profile, this.hasSpecialBackpack(), this.implantContribution());
    /* A-3c: 이번 레이드에 실린 요리를 **맨 끝에** 파생 수치로 접는다 (`MealBuff` = `DerivedStats` 의 필드 이름).
     * 소비하는 폴더는 한 줄도 안 바뀐다 — 이미 `derived` 를 읽고 있다. */
    /* 2026-09-13 (요리 품질): 넘겨받은 프로필의 식사 · 품질을 읽는다 — `recompute` 는 진짜 프로필, 시트 미리보기는 그 얕은 사본이라
     * 둘이 같은 값을 보고, 줄마다 `× (1 + mealQualityBonus(품질))` 가 `applyMealBuff` 안에서 곱해진다. */
    const activeId = typeof profile.mealActive === 'string' && profile.mealActive ? profile.mealActive : null;
    const meal = this.mealDefOf(activeId);
    if (meal) applyMealBuff(d, meal, normalizeMealQuality(profile.mealActiveQuality));
    return d;
  }

  /**
   * `ctx.inventory` / `ctx.loot` are built by other systems that may not expose the gear API yet —
   * every hop is optional and any throw falls back to "no perk".
   */
  private hasSpecialBackpack(): boolean {
    // Merged design keeps the weapon-package bags (`BagDef`); the 특수 가방 implant perk is carried by tactical bags.
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

  /** Relevant-stat speed-up for a skill (지능 is applied separately through `skillGainMul`). */
  private statFactor(def: SkillDef | undefined): number {
    if (!def || def.stats.length === 0) return 1;
    let sum = 0;
    for (const s of def.stats) sum += this.getStat(s);
    const avg = sum / def.stats.length;
    return Math.max(0.4, 1 + SKILL_STAT_FACTOR * (avg - STAT_BASE));
  }

  private weaponClassOf(weaponId: string | null): WeaponClass | null {
    if (!weaponId) return null;
    try {
      const def = this.ctx?.loot?.getWeaponDef(weaponId);
      if (!def) return null;
      return def.weaponClass ?? (def.slot === 'secondary' ? 'PISTOL' : 'AR');
    } catch {
      return null;
    }
  }

  /** 제작 vs 의학 vs 원예 — read off the recipe when items/ exposes them, else default to 제작. */
  private recipeSkill(recipeId: string): SkillId {
    try {
      const loot = this.ctx?.loot;
      if (!loot || typeof loot.getAllRecipes !== 'function') return 'crafting';
      const r = loot.getAllRecipes().find((x) => x.id === recipeId);
      const s = r?.skill;
      if (s === 'medicine' || s === 'gardening' || s === 'crafting') return s;
      return 'crafting';
    } catch {
      return 'crafting';
    }
  }

  /** 운반: accumulate ground distance covered while the bag is at 조금 무거움 or worse. */
  private trackCarry(ctx: GameContext): void {
    const p = ctx.player;
    if (!p || !ctx.isGameplayPhase() || p.isDead) { this.hasLastPos = false; return; }
    const x = p.position.x, z = p.position.z;
    if (!this.hasLastPos) { this.lastX = x; this.lastZ = z; this.hasLastPos = true; return; }
    const dx = x - this.lastX, dz = z - this.lastZ;
    this.lastX = x; this.lastZ = z;
    if (this.weightState === 'normal') return;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01 || dist > 20) return;                     // ignore jitter and teleports (respawn / grapple)
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
