import type { EquippedImplant, ImplantItemDef,
  DerivedStats, EmbeddedView, GameContext, GameSystem, PlayerProfile, ProfileRef, ProgressionRef,
  SkillDef, SkillId, StatDef, StatId, WeaponClass,
} from '@/shared';
import {
  IMPLANT_SLOTS_BASE, IMPLANT_SLOTS_MAX, IMPLANT_SLOTS_PER_LEVELS,
  SKILL_IDS, SKILL_LEVEL_MAX, STAT_BASE, STAT_IDS, STAT_MAX, STAT_MIN, STAT_POINTS_PER_LEVEL,
  STAT_XP_BASE, STAT_XP_EXPONENT, TRAINING_SKILL_GAIN_MUL,
} from '@/shared';
import {
  APPRAISE_XP_BY_RARITY, CARRY_XP_PER_METER, CRAFT_XP, CRATE_OPEN_XP, CRYPTO_XP, GATHER_XP, GRIT_SAVE_XP,
  GUN_HIT_XP, IMPLANT_XP, REPAIR_XP, SKILL_DEF_MAP, SKILL_DEFS, STAT_DEF_MAP, STAT_DEFS, WEAPON_CLASS_SKILL,
} from './defs';
import { computeDerived, DEFAULT_DERIVED, SPECIAL_BACKPACK_CD_MUL, emptyPerks, xpForLevel, type ImplantContribution } from './derive';
import { clearStoredProfile, freshProfile, loadProfile, migrate, saveProfile, zeroStatProgress } from './Profile';
import { CharacterSheet } from './ui/CharacterSheet';
import { SheetView } from './ui/SheetView';

/** Seconds between autosaves while the profile is dirty. */
const AUTOSAVE_INTERVAL = 15;
/** Skill progress must move this much before another `progress:skillProgress` is emitted (HUD bar). */
const PROGRESS_EMIT_STEP = 0.01;
/** Raw skill XP is divided by `1 + level * SKILL_COST_SLOPE` — later levels take longer. */
const SKILL_COST_SLOPE = 0.06;
/** How strongly the skill's own stats speed up training (per point above STAT_BASE). */
const SKILL_STAT_FACTOR = 0.04;
/*
 * Phase 11 (2026-09-07): the undocumented `P` convenience toggle is **retired**. 캐릭터 is a Tab-screen tab since
 * Phase 8 (`ui:statsToggled` still opens the overlay for anyone who emits it), and P now belongs to `Keys.INVITE`
 * (분대 초대 수락 홀드). Both listened with `uiBlockers.size === 0`, so they would have fought each other.
 */

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

  /** Base stat + equipped implant bonuses — what `derived` is computed from. */
  getStatWithImplants(id: StatId): number { return this.getStat(id) + this.getImplantBonus(id); }

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
      b.on('crate:open', () => this.addSkillXp('appraisal', CRATE_OPEN_XP)),
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
      /* ── server profile (Phase 7) ── */
      b.on('net:profileLoaded', () => this.onProfileLoaded()),
      /* ── 운반 (distance accumulated in update) ── */
      b.on('inventory:weightChanged', ({ state }) => { this.weightState = state; }),
      /* ── gear affects derived (특수 가방 halves implant cooldowns) ── */
      b.on('equip:changed', () => this.recompute()),
      b.on('loadout:changed', () => this.recompute()),
      /* ── stat points may not be spent mid-raid; refresh the sheet on every phase change ── */
      b.on('game:phaseChanged', () => this.refreshSheets()),
      b.on('game:newMission', () => { this.hasLastPos = false; this.weightState = 'normal'; }),
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
    };
  }

  /** Full repaint of the overlay and every embedded 캐릭터 tab. */
  private refreshSheets(): void {
    this.sheet?.refresh();
    for (const v of this.views) v.refresh();
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
    this.refreshSheets();
  }

  /* ── internals ─────────────────────────────────────────────────────────── */
  /** Recompute `derived`; folds in the 특수 가방 perk (implant cooldown −50 %) and the equipped 임플란트 items (Phase 12). */
  private recompute(): void {
    if (this.pruneImplants()) this.markDirty(false);     // a removed def id in an old save — drop it silently
    this._derived = computeDerived(this._profile, this.hasSpecialBackpack(), this.implantContribution());
    this.refreshSheets();
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
