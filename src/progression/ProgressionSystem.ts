import type {
  DerivedStats, GameContext, GameSystem, PlayerProfile, ProgressionRef,
  SkillDef, SkillId, StatDef, StatId, WeaponClass,
} from '@/shared';
import {
  SKILL_IDS, SKILL_LEVEL_MAX, STAT_BASE, STAT_IDS, STAT_MAX, STAT_MIN, STAT_POINTS_PER_LEVEL,
  STAT_XP_BASE, STAT_XP_EXPONENT,
} from '@/shared';
import {
  APPRAISE_XP_BY_RARITY, CARRY_XP_PER_METER, CRAFT_XP, CRATE_OPEN_XP, CRYPTO_XP, GATHER_XP, GRIT_SAVE_XP,
  GUN_HIT_XP, IMPLANT_XP, REPAIR_XP, SKILL_DEF_MAP, SKILL_DEFS, STAT_DEF_MAP, STAT_DEFS, WEAPON_CLASS_SKILL,
} from './defs';
import { computeDerived, DEFAULT_DERIVED, SPECIAL_BACKPACK_CD_MUL, xpForLevel } from './derive';
import { clearStoredProfile, freshProfile, loadProfile, saveProfile, zeroStatProgress } from './Profile';
import { CharacterSheet } from './ui/CharacterSheet';

/** Seconds between autosaves while the profile is dirty. */
const AUTOSAVE_INTERVAL = 15;
/** Skill progress must move this much before another `progress:skillProgress` is emitted (HUD bar). */
const PROGRESS_EMIT_STEP = 0.01;
/** Raw skill XP is divided by `1 + level * SKILL_COST_SLOPE` — later levels take longer. */
const SKILL_COST_SLOPE = 0.06;
/** How strongly the skill's own stats speed up training (per point above STAT_BASE). */
const SKILL_STAT_FACTOR = 0.04;
/** Optional convenience key that toggles the character sheet (the ship terminal is the primary entry point). */
const KEY_CHARACTER = 'KeyP';

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
 */
export class ProgressionSystem implements GameSystem, ProgressionRef {
  readonly name = 'progression';

  private ctx!: GameContext;
  private _profile: PlayerProfile = freshProfile();
  private _derived: DerivedStats = DEFAULT_DERIVED;
  private offs: Array<() => void> = [];
  private sheet: CharacterSheet | null = null;

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
      /* ── 원예 ── */
      b.on('gather:collected', () => this.addSkillXp('gardening', GATHER_XP)),
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
      /* ── 감정 ── */
      b.on('crate:open', () => this.addSkillXp('appraisal', CRATE_OPEN_XP)),
      b.on('inventory:itemAdded', ({ rarity }) => {
        this.addSkillXp('appraisal', APPRAISE_XP_BY_RARITY[rarity] ?? APPRAISE_XP_BY_RARITY.common);
      }),
      /* ── 운반 (distance accumulated in update) ── */
      b.on('inventory:weightChanged', ({ state }) => { this.weightState = state; }),
      /* ── gear affects derived (특수 가방 halves implant cooldowns) ── */
      b.on('equip:changed', () => this.recompute()),
      b.on('loadout:changed', () => this.recompute()),
      /* ── stat points may not be spent mid-raid; refresh the sheet on every phase change ── */
      b.on('game:phaseChanged', () => this.sheet?.refresh()),
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
    // Optional convenience toggle (the ship terminal's 캐릭터 entry emits `ui:statsToggled` too).
    if (ctx.input.wasPressed(KEY_CHARACTER)) {
      const open = this.sheet?.isOpen ?? false;
      if (open) this.sheet?.close();
      else if ((ctx.isGameplayPhase() || ctx.isHubPhase()) && ctx.uiBlockers.size === 0 && !(ctx.player?.isDead ?? false)) {
        this.sheet?.open();
      }
    }

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
    this.sheet?.refresh();
    return true;
  }

  /* ── skills ────────────────────────────────────────────────────────────── */
  addSkillXp(id: SkillId, amount: number): void {
    if (!(SKILL_IDS as readonly string[]).includes(id)) return;
    if (!(amount > 0)) return;
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
      this.sheet?.refresh();
      return;
    }
    this.markDirty(false);
    const last = this.lastEmitted[id] ?? -1;
    if (Math.abs(progress - last) >= PROGRESS_EMIT_STEP) {
      this.lastEmitted[id] = progress;
      this.ctx?.bus.emit('progress:skillProgress', { id, level, progress });
      this.sheet?.refreshSkill(id);
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
    this.sheet?.refresh();
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
    this.sheet?.refreshStat(id);
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
    if (level !== prevLevel) this.sheet?.refresh(); else this.sheet?.refreshSkill(id);
  }

  /**
   * Ship-facility skill-gain multiplier (사격장 → `gun_*`). Read from `ctx.housing`, which may still be a skeleton
   * (returns 1) or absent — every hop is guarded so this never throws and never returns a bad number.
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

  resetProfile(): void {
    const name = this._profile.name;
    clearStoredProfile();
    this._profile = freshProfile(name);
    this.lastEmitted = {};
    this.recompute();
    this.markDirty(true);
    this.flush();
    this.ctx?.bus.emit('progress:loaded', { profile: this._profile });
    this.sheet?.refresh();
  }

  /* ── internals ─────────────────────────────────────────────────────────── */
  /** Recompute `derived`; folds in the 특수 가방 perk (implant cooldown −50 %). */
  private recompute(): void {
    this._derived = computeDerived(this._profile, this.hasSpecialBackpack());
    this.sheet?.refresh();
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

  /** Write the profile out now (no-op when nothing changed). */
  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.saveTimer = 0;
    saveProfile(this._profile);
  }
}

export { SPECIAL_BACKPACK_CD_MUL, xpForLevel };
