import type { ArmorDef, CraftIngredient, CraftRecipe, DurabilityBucketInfo, EffectiveWeaponStats, EnemyType, ItemDef, ItemInstance, ItemInstanceExtras, LootRef, WeaponDef } from '@/shared';
/* appended (2026-09-09): per-planet weapon grade curves */
import type { CorpseLootOpts, PlanetId, WeaponGrade } from '@/shared';
import { Random, planetTier } from '@/shared';
import { UNIQUE_WEAPON_IDS } from '@/shared';
import { AMMO_TYPES_V2, ATTACHMENT_ITEM_DEFS, ITEM_DEFS, ITEM_DEF_MAP, UNIQUE_AMMO_TYPES, ammoItemIdFor, isWeaponItemDef, itemIdForWeapon, rarityRank } from './ItemDefs';
/* appended (2026-09-13): library media · video games — planet-bound drops · volume weights · old-id safety net */
import { resolveItemAlias } from '@/shared';
import type { LootCategory } from './LootTables';
import { isLootableOnPlanet, libraryBookPool, libraryVolumeWeight, lootCategoryOf, planetCategoryAvailable } from './LootTables';
import { WEAPON_DEF_MAP, WEAPON_FAMILIES, gradeOf, isUniqueWeapon, weaponFamilyOf, weaponIdForGrade } from './WeaponDefs';
import { canAttach as canAttachDef, computeWeaponStats } from './WeaponStats';
import { ARMOR_DEF_MAP } from './ArmorDefs';
import { craftCostOf } from './Recipes';
/* appended (2026-09-10): repair · salvage are the craft inputs × the durability bucket multiplier (`Salvage.ts`). */
import { ALL_CRAFT_RECIPES, durabilityBucketInfo, durabilityBucketOf, repairCostFor, salvageFor } from './Salvage';
import { IMPLANT_BROKEN_DEFS } from './ImplantDefs';
import { CORPSE_TABLE_MAP, DEFAULT_ROGUE_WEAPON_ID, getPlanetGradeCurve, getTierTable, planetRarityWeights, type PlanetGradeCurve, type TierTable } from './LootTables';
/* appended (2026-09-13): a retired item is no candidate in a crate · supply draw (a pin separate from the csv) */
import { isLootableDef } from './LootTables';
/* appended (2026-09-11): the named rogue's guaranteed drop (`data/loot_named.csv`) */
import { NAMED_LOOT_DURABILITY_MAX, NAMED_LOOT_DURABILITY_MIN } from '@/shared';
import { NAMED_DROP_MAP, numberedArmorIdForTier, type NamedDrop } from './LootTables';
/* appended (2026-09-13): humanoid faction loot — gun grades · armor · bag · heal · site bonus · carried grenades */
import { ENEMY_GRENADE_ITEM } from '@/shared';
import { FACTION_LOOT_MAP, getFactionSiteBonus, planetSeedPool, type CorpseRarityPick, type FactionLoot, type FactionSiteBonus } from './LootTables';
/* appended (2026-09-16): the epic+ gate — the locked-room exemption (`CrateLootOpts`) · the weapon grade list */
import type { CrateLootOpts } from '@/shared';
import { WEAPON_GRADES } from './WeaponDefs';
/* appended (2026-09-17): corpse samples roll a tier per unit (`data/loot_corpse_samples.csv`) */
import type { CorpseSampleDrop } from './LootTables';

/**
 * Item ids of the unique-only ammo types (`ammo_fuel` … `ammo_belt`) and of the ordinary ammo types the graded
 * weapons use. Per `data/ammo.csv` the six unique calibres are **that unique gun's alone** — the six graded families
 * use only light / medium / heavy / shell. So on a planet where uniques are sealed that ammo has to be blocked with
 * them, or it becomes dead weight.
 */
const UNIQUE_AMMO_ITEM_IDS: ReadonlySet<string> = new Set(UNIQUE_AMMO_TYPES.map(ammoItemIdFor));
const GRADED_AMMO_ITEM_IDS: readonly string[] = AMMO_TYPES_V2.filter((t) => !UNIQUE_AMMO_TYPES.includes(t)).map(ammoItemIdFor);

/*
 * 2026-09-16 — the **epic+ gate** (`epicPlusMul` in `data/planet_loot.csv` = `keep` in the code below).
 * User's decision: halve how often epic · legendary comes out of every roll but the lab's locked room. Rarity
 * **weight** multipliers (`epicMul` · `legMul`) cannot do it — a guaranteed pick's candidates are already epic+ so
 * the multiplier cancels, and a fallback pick never looks at weights at all.
 * So it is applied to the **drawn result**: an epic+ pick is kept on `rng.chance(keep)`, otherwise it drops to the
 * highest rarity below epic in the same candidate pool. The chance that the pick is epic+ is then exactly × keep.
 * rng: `keep >= 1` consumes no extra draw at all (the locked room · planet-less rolls are bit-for-bit as before).
 * With keep < 1 only an epic+ result spends one gate draw + (when it drops) one draw to pick again — it is
 * seed-deterministic, so preview ≡ opening.
 */
const EPIC_RANK = rarityRank('epic');
const isEpicPlus = (d: ItemDef): boolean => rarityRank(d.rarity) >= EPIC_RANK;

/** Only the entries of the list with the highest rarity (an empty list gives an empty list). */
function topRarity<T extends ItemDef>(list: readonly T[]): T[] {
  let best = -1;
  for (const d of list) best = Math.max(best, rarityRank(d.rarity));
  return list.filter((d) => rarityRank(d.rarity) === best);
}

/**
 * One pass of the gate — when `picked` is epic+ and fails `keep`, it re-picks by `weight` from the highest rarity in
 * `list` that is below epic and has a positive weight (none = null, meaning that pick never happened). Below epic,
 * or with `keep >= 1`, it consumes no rng and returns `picked` unchanged.
 */
function gatePick<T extends ItemDef>(picked: T, list: readonly T[], weight: (d: T) => number, rng: Random, keep: number): T | null {
  if (keep >= 1 || !isEpicPlus(picked) || rng.chance(keep)) return picked;
  const lower = topRarity(list.filter((d) => !isEpicPlus(d) && weight(d) > 0));
  return lower.length > 0 ? rng.weighted(lower, weight) : null;
}

let uidCounter = 0;
/** Unique, sortable-ish item uid: counter + random suffix. */
export function nextUid(): string {
  uidCounter = (uidCounter + 1) % 0xffffff;
  return `i${uidCounter.toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

export class LootService implements LootRef {
  private fallbackRng = new Random(Date.now() & 0x7fffffff);

  /**
   * 2026-09-13: an old library media id (`data/item_aliases.csv`) resolves to the new def too — a safety net for an
   * id the folders that migrate saves (housing · inventory) missed.
   */
  getItemDef(defId: string): ItemDef | undefined { return ITEM_DEF_MAP.get(defId) ?? ITEM_DEF_MAP.get(resolveItemAlias(defId)); }
  getWeaponDef(weaponId: string): WeaponDef | undefined { return WEAPON_DEF_MAP.get(weaponId); }
  getAllItemDefs(): ItemDef[] { return ITEM_DEFS.slice(); }
  /* appended: tactical kit */
  getArmorDef(armorId: string): ArmorDef | undefined { return ARMOR_DEF_MAP.get(armorId); }
  getAllRecipes(): readonly CraftRecipe[] { return ALL_CRAFT_RECIPES; }

  /**
   * Create an item instance. Weapons spawn at full durability with a full magazine
   * (magazine size includes an extended mag given in `extras.sockets`); `extras`
   * override those and carry sockets across drops / pickups / storage.
   */
  createItem(defId: string, qty = 1, extras?: ItemInstanceExtras): ItemInstance {
    /* 2026-09-13: an old id is built as the new id (the instance's defId is the new id too). */
    const id = ITEM_DEF_MAP.has(defId) ? defId : resolveItemAlias(defId);
    const def = ITEM_DEF_MAP.get(id);
    if (!def) throw new Error(`[Loot] unknown item def '${defId}'`);
    const inst: ItemInstance = { uid: nextUid(), defId: id, qty: Math.max(1, Math.min(def.stackMax, Math.floor(qty))), rotated: false };
    const weapon = def.weaponId ? WEAPON_DEF_MAP.get(def.weaponId) : undefined;
    if (weapon) {
      // uniques never carry sockets (no attachment fits them); everything else keeps its sockets across drops / storage
      if (extras?.sockets && !isUniqueWeapon(weapon)) inst.sockets = extras.sockets;
      const stats = computeWeaponStats(weapon, inst);
      inst.durability = extras?.durability ?? stats.maxDurability;
      inst.ammoInMag = extras?.ammoInMag ?? stats.magSize;
    } else if (def.durabilityMax !== undefined) {
      inst.durability = extras?.durability ?? def.durabilityMax;
    } else if (extras) {
      if (extras.durability !== undefined) inst.durability = extras.durability;
      if (extras.ammoInMag !== undefined) inst.ammoInMag = extras.ammoInMag;
      if (extras.sockets) inst.sockets = extras.sockets;
    }
    return inst;
  }

  /** Graded + socketed stats. Accepts an instance, a weapon def id (`ar_g3`) or a weapon item id (`wpn_ar_g3`). */
  getEffectiveStats(inst: ItemInstance | string): EffectiveWeaponStats | null {
    if (typeof inst === 'string') {
      const weapon = WEAPON_DEF_MAP.get(inst) ?? this.weaponDefOfItem(inst);
      return weapon ? computeWeaponStats(weapon) : null;
    }
    const weapon = this.weaponDefOfItem(inst.defId);
    return weapon ? computeWeaponStats(weapon, inst) : null;
  }

  /**
   * 2026-09-10 — **the craft inputs × the repair multiplier of the remaining durability bucket (rounded up)**. The
   * signature is unchanged, but armor now returns a cost too (it used to be weapons only, and armor repair was
   * free). Anything with a rule of its own, such as a healing spray, still returns `[]`, so `inventory`'s
   * `sprayRepairCost` path stays alive.
   */
  getRepairCost(inst: ItemInstance): { defId: string; qty: number }[] {
    return repairCostFor(inst);
  }

  /* ── appended (2026-09-10): durability-linked repair · salvage (owner: items/Salvage) ── */
  durabilityBucketOf(inst: ItemInstance): number { return durabilityBucketOf(inst); }
  durabilityBucketInfo(inst: ItemInstance): DurabilityBucketInfo { return durabilityBucketInfo(inst); }
  getCraftCostOf(defId: string): readonly CraftIngredient[] { return craftCostOf(defId); }
  getSalvageFor(inst: ItemInstance): CraftRecipe | null { return salvageFor(inst); }

  canAttach(weapon: ItemInstance, attachment: ItemInstance): boolean {
    const weaponDef = this.weaponDefOfItem(weapon.defId);
    const attDef = ITEM_DEF_MAP.get(attachment.defId)?.attachment;
    if (!weaponDef || !attDef) return false;
    return canAttachDef(weaponDef, attDef);
  }

  private weaponDefOfItem(itemDefId: string): WeaponDef | undefined {
    const def = ITEM_DEF_MAP.get(itemDefId);
    return def?.weaponId ? WEAPON_DEF_MAP.get(def.weaponId) : undefined;
  }

  /**
   * Roll crate contents for a tier. Deterministic for a given `rng`. Same-def
   * stackables are merged (respecting stackMax); result sorted largest-first so
   * container auto-placement fragments less. At most one bag per crate.
   */
  rollCrate(tier: number, rng: Random = this.fallbackRng): ItemInstance[] {
    return this.rollCrateWithCurve(tier, rng, null, null);
  }

  /**
   * The body of `rollCrate`. With `curve` null it consumes no extra draw, so the result is exactly the old one.
   * 2026-09-13: `planet` — library media · consoles · game discs are candidates only where they are that
   * planet's. A category with no candidate on that planet drops out of the category draw list (the draw itself is
   * still one draw). With null every planet-bound item is a candidate.
   */
  private rollCrateWithCurve(tier: number, rng: Random, curve: PlanetGradeCurve | null, planet: PlanetId | null, keep = 1): ItemInstance[] {
    const table = getTierTable(tier);
    const count = rng.int(table.count[0], table.count[1]);
    const picks: ItemDef[] = [];
    /** Categories proven to have no candidate at all (not drawn again in this crate — guards an endless loop). */
    const dead = new Set<LootCategory>();

    for (const g of table.guaranteed) {
      /* 2026-09-16: a guaranteed pick caught by the gate ignores `minRarity` and drops to the highest rarity below
         epic in the same category (tier 4's "epic+ valuable" → a rare valuable). Honouring the floor would leave
         only epic+ candidates and make the gate meaningless. */
      const inPool = (def: ItemDef): boolean => g.categories.includes(lootCategoryOf(def));
      const d = this.pickDef(table, rng, (def) => inPool(def) && rarityRank(def.rarity) >= rarityRank(g.minRarity), true, curve, planet, keep, inPool);
      if (d) picks.push(d);
    }

    // decide once per crate whether a weapon is included (guaranteed rolls may already have one)
    let weaponPending = !picks.some(isWeaponItemDef)
      && table.weaponChance > 0 && rng.chance(table.weaponChance);
    while (picks.length < count) {
      if (weaponPending) {
        weaponPending = false;
        const d = this.pickDef(table, rng, isWeaponItemDef, true, curve, planet, keep);
        if (d) { picks.push(d); continue; }
      }
      const hasBag = picks.some((d) => d.category === 'bag');
      const cats = (Object.keys(table.categoryWeights) as LootCategory[])
        .filter((c) => !(hasBag && c === 'bag') && !dead.has(c) && planetCategoryAvailable(c, planet));
      if (cats.length === 0) break;
      const cat = rng.weighted(cats, (c) => table.categoryWeights[c] ?? 0);
      /* 2026-09-15: the category axis is `lootCategoryOf` — the table's `grenade` is an item that carries
         `ItemDef.grenade`, `gadget` is every other gadget (`LootTables`'s *loot category axis*). */
      const d = this.pickDef(table, rng, (def) => lootCategoryOf(def) === cat, false, curve, planet, keep);
      /* A category with no candidate at all **does not cut the crate short** — only that category is dropped and
         the draw repeats. This used to `break` here, and a single phantom category row matching no item ate a crate
         down to one or two items.
         2026-09-16: a category caught by the epic+ gate that has no candidate below epic at all (keys · records)
         returns null too and takes the same path — this crate drops that category and draws again, so the count is
         unchanged and only that thing halves. */
      if (d) picks.push(d); else dead.add(cat);
    }

    // 2026-09-09: the planet curve re-grades **the grade only** (the family draw · uniques are untouched).
    if (curve) {
      for (let i = 0; i < picks.length; i++) picks[i] = this.regrade(picks[i], curve, rng, keep);
    }

    // Phase 6: a unique weapon always brings one stack of its dedicated calibre (beyond `count`)
    for (const d of picks.slice()) {
      const w = d.weaponId ? WEAPON_DEF_MAP.get(d.weaponId) : undefined;
      if (!w || !isUniqueWeapon(w)) continue;
      const ammo = ITEM_DEF_MAP.get(ammoItemIdFor(w.ammoType));
      if (ammo && !picks.includes(ammo)) picks.push(ammo);
    }

    // materialise + merge stacks
    const out: ItemInstance[] = [];
    for (const def of picks) {
      let qty = this.rollQty(def, table, rng);
      const existing = out.find((it) => it.defId === def.id && it.qty < def.stackMax);
      if (existing) {
        const room = def.stackMax - existing.qty;
        const moved = Math.min(room, qty);
        existing.qty += moved; qty -= moved;
      }
      if (qty > 0) {
        const item = this.createItem(def.id, qty);
        // Found gear is second-hand: 55–100 % durability, so repairing on the ship is worth doing.
        if (def.durabilityMax !== undefined) {
          item.durability = Math.max(1, Math.round(def.durabilityMax * (0.55 + rng.next() * 0.45)));
        }
        out.push(item);
      }
    }
    out.sort((a, b) => this.area(b) - this.area(a));
    return out;
  }

  /**
   * Corpse loot (Phase 4). Bugs drop bio samples / glands / alloy per `CORPSE_TABLES`;
   * rogues drop rounds of their weapon's calibre plus the weapon itself at very low
   * durability (`rogueWeaponId`, default `ar`); bosses re-grade the weapon to III/IV
   * and add an attachment. Deterministic for a given `rng`; sorted largest-first like
   * `rollCrate`. Unknown types yield a single bio sample.
   */
  rollCorpse(type: EnemyType, rng: Random = this.fallbackRng, rogueWeaponId?: string): ItemInstance[] {
    return this.rollCorpseWithMax(type, rng, rogueWeaponId, null, null);
  }

  /**
   * The body of `rollCorpse`. `maxGrade` is the planet's grade cap, null = no cap — the rng consumption is the same
   * either way.
   * 2026-09-13: `planet` (the site bonus's seed pool) · `opts` (the spawn site · carried grenades) — both are read
   * only by an enemy that has a faction table.
   * The result is a pure function of (type, rng, weaponId, planet, opts) — host · replica · drone-scan preview all
   * pass the same values.
   */
  private rollCorpseWithMax(
    type: EnemyType, rng: Random, rogueWeaponId: string | undefined, curve: PlanetGradeCurve | null,
    planet: PlanetId | null, opts?: CorpseLootOpts,
  ): ItemInstance[] {
    const maxGrade: WeaponGrade | null = curve?.maxGrade ?? null;
    /* 2026-09-16: the epic+ gate (`epicPlusMul`) — with no planet it is 1, so every roll below consumes rng exactly
       as before. */
    const keep = curve?.epicPlusMul ?? 1;
    const table = CORPSE_TABLE_MAP.get(type);
    if (!table) return [this.createItem('mat_bio_sample', 1)];
    const out: ItemInstance[] = [];
    /* 2026-09-13: humanoid factions — an enemy with no row in the tables (bugs · rogue_boss · named) leaves both
       undefined and never enters the branches below. */
    const faction = FACTION_LOOT_MAP.get(type);
    const siteBonus = getFactionSiteBonus(type, opts?.site);

    for (const drop of table.drops) {
      /* 2026-09-16: an epic+ item row (keys · alien artifact · air drone …) multiplies the gate into the chance
         itself — it is a "that one thing" row with nothing to drop to. */
      const dropDef = ITEM_DEF_MAP.get(drop.defId);
      const chance = keep < 1 && dropDef && isEpicPlus(dropDef) ? drop.chance * keep : drop.chance;
      if (chance < 1 && !rng.chance(chance)) continue;
      if (!ITEM_DEF_MAP.has(drop.defId)) { console.warn(`[Loot] corpse table '${type}': unknown def '${drop.defId}'`); continue; }
      const qty = drop.qty[0] >= drop.qty[1] ? drop.qty[0] : rng.int(drop.qty[0], drop.qty[1]);
      out.push(this.createItem(drop.defId, qty));
    }

    /* 2026-09-17 (user's decision): unidentified samples roll a tier per unit (`loot_corpse_samples.csv`). They are
       rolled on a **fork**, not on the main stream, so the gun · unique · book … draws after them do not move one
       grain because of this table. A fork spends no draw of the main stream, and the same seed gives the same fork,
       so preview ≡ opening · host ≡ replica. An enemy with no table makes no fork either. The epic+ gate (`keep`) is
       deliberately not passed down (the exemption — see that function's comment below). */
    if (table.samples) this.rollCorpseSamples(table.samples, rng.fork('corpseSamples'), out);

    if (table.weapon) {
      const base = WEAPON_DEF_MAP.get(rogueWeaponId ?? DEFAULT_ROGUE_WEAPON_ID) ?? WEAPON_DEF_MAP.get(DEFAULT_ROGUE_WEAPON_ID);
      if (base) {
        let weapon = base;
        /* 2026-09-13: a humanoid faction draws the grade by **weight** (weaponGrades in `loot_factions.csv`). When
           that site has a grades row, that table replaces it wholesale (the outpost raider). It is never used
           together with a boss's uniform list (the loader catches that). */
        const factionGrades = siteBonus?.weaponGrades ?? faction?.weaponGrades;
        if (factionGrades && factionGrades.grades.length > 0) {
          const grade = rng.weighted(factionGrades.grades, (g) => factionGrades.weightOf[g] ?? 0);
          weapon = WEAPON_DEF_MAP.get(weaponIdForGrade(weaponFamilyOf(base), grade)) ?? base;
        } else if (table.weapon.grades && table.weapon.grades.length > 0) {
          weapon = WEAPON_DEF_MAP.get(weaponIdForGrade(weaponFamilyOf(base), rng.pick(table.weapon.grades))) ?? base;
        }
        // 2026-09-09: on an early planet even a boss's gun cannot exceed that planet's max grade (rng use as before).
        if (maxGrade !== null && !isUniqueWeapon(weapon) && gradeOf(weapon) > maxGrade) {
          weapon = WEAPON_DEF_MAP.get(weaponIdForGrade(weaponFamilyOf(weapon), maxGrade)) ?? weapon;
        }
        /* 2026-09-16: the epic+ gate — applied **after** the cap (a gun the cap already took to III spends no
           draw). When it catches, the highest grade below epic in that table (with none, the best of the grade III
           side). */
        if (keep < 1 && !isUniqueWeapon(weapon)) {
          const wItem = ITEM_DEF_MAP.get(itemIdForWeapon(weapon.id));
          if (wItem && isEpicPlus(wItem) && !rng.chance(keep)) {
            const family = weaponFamilyOf(weapon);
            weapon = WEAPON_DEF_MAP.get(weaponIdForGrade(family, this.bestGradeBelowEpic(family, factionGrades?.grades ?? table.weapon.grades ?? []))) ?? weapon;
          }
        }
        // rounds of the calibre, one stack
        const ammoDef = ITEM_DEF_MAP.get(ammoItemIdFor(weapon.ammoType));
        if (ammoDef && table.ammoFraction) {
          const [lo, hi] = table.ammoFraction;
          const rounds = Math.max(1, Math.min(ammoDef.stackMax, Math.round(ammoDef.stackMax * rng.range(lo, hi))));
          out.push(this.createItem(ammoDef.id, rounds));
        }
        // the weapon itself
        const stats = computeWeaponStats(weapon);
        const [dLo, dHi] = table.weapon.durability;
        const durability = Math.max(1, Math.round(stats.maxDurability * rng.range(dLo, dHi)));
        const ammoInMag = rng.int(0, stats.magSize);
        out.push(this.createItem(itemIdForWeapon(weapon.id), 1, { durability, ammoInMag }));
        // boss: one attachment (fitting the weapon when any qualifies)
        if (table.weapon.attachment) {
          const maxRank = rarityRank(table.weapon.attachment.maxRarity);
          const pool = ATTACHMENT_ITEM_DEFS.filter((d) => rarityRank(d.rarity) <= maxRank);
          const fitting = pool.filter((d) => d.attachment && canAttachDef(weapon, d.attachment));
          const from = fitting.length > 0 ? fitting : pool;
          const rolled = rng.pick(from);
          // 2026-09-16: the epic+ gate — when it catches, uniform among the same candidates' top rarity below epic
          const pick = rolled ? gatePick(rolled, from, () => 1, rng, keep) : undefined;
          if (pick) out.push(this.createItem(pick.id, 1));
        }
      }
    }

    // Phase 6: bosses may carry one mythic unique (rolled last so earlier draws are unchanged) + a stack of its calibre
    // 2026-09-09: a unique has no grade and so rides no curve — the planet's `uniqueMul` shrinks the chance itself
    // (0 = none). `rng.chance` spends one draw regardless of the multiplier, so the planet-null path consumes rng
    // exactly as before.
    // 2026-09-16: every unique is mythic (above epic), so the epic+ gate (`keep`) multiplies straight into the
    // chance too (still the one draw).
    if (table.unique && rng.chance(table.unique.chance * (curve?.uniqueMul ?? 1) * keep)) {
      const unique = WEAPON_DEF_MAP.get(rng.pick(UNIQUE_WEAPON_IDS));
      if (unique) {
        const stats = computeWeaponStats(unique);
        const [dLo, dHi] = table.unique.durability;
        const durability = Math.max(1, Math.round(stats.maxDurability * rng.range(dLo, dHi)));
        const ammoInMag = rng.int(0, stats.magSize);
        out.push(this.createItem(itemIdForWeapon(unique.id), 1, { durability, ammoInMag }));
        const ammoDef = ITEM_DEF_MAP.get(ammoItemIdFor(unique.ammoType));
        if (ammoDef) {
          const [lo, hi] = table.ammoFraction ?? [0.3, 0.6];
          out.push(this.createItem(ammoDef.id, Math.max(1, Math.min(ammoDef.stackMax, Math.round(ammoDef.stackMax * rng.range(lo, hi))))));
        }
      }
    }

    // Phase 9: a reading raider — one book (rolled after the unique so earlier draws are unchanged)
    /* 2026-09-13 (library series): one volume out of the raid planet's book series, by volume weight
       (`libraryBookPool` · `libraryVolumeWeight`). The draw count matches the old one (chance + pick → chance +
       weighted). With planet null every book is a candidate. */
    if (table.book) {
      const pool = libraryBookPool(planet);
      if (pool.length > 0 && rng.chance(table.book.chance)) {
        // 2026-09-16: the epic+ gate (every book is uncommon today, so no draw is spent — the rule survives a
        // change of series rarity)
        const book = gatePick(rng.weighted(pool, libraryVolumeWeight), pool, libraryVolumeWeight, rng, keep);
        if (book) out.push(this.createItem(book.id, 1));
      }
    }

    // Phase 12: a fried implant — one broken implant weighted by rarity (rolled last, so every earlier draw is
    // unchanged)
    /* 2026-09-10: this too is a **rarity draw**, so the same multipliers as a crate apply (`implantWeights` in
       `loot_corpse_rolls.csv` carries common..epic, the same shape as a crate table). Without them a boss corpse
       becomes the detour to a rare implant on an early planet. The `chance` itself is untouched — a multiplier
       decides "what comes out", not "how often it comes out". `rng.weighted` spends one draw regardless of the
       multiplier, so the rng consumption is unchanged too. */
    if (table.implant && rng.chance(table.implant.chance)) {
      const w = planetRarityWeights(table.implant.weights, curve);
      const pool = IMPLANT_BROKEN_DEFS.filter((d) => (w[d.rarity] ?? 0) > 0);
      if (pool.length > 0) {
        // 2026-09-16: the epic+ gate — when it catches, a broken implant of the highest weighted rarity below epic
        // (usually rare)
        const implant = gatePick(rng.weighted(pool, (d) => w[d.rarity] ?? 0), pool, (d) => w[d.rarity] ?? 0, rng, keep);
        if (implant) out.push(this.createItem(implant.id, 1));
      }
    }

    /* 2026-09-13: humanoid factions — armor → bag → heal (a rarity roll) → the site bonus → carried grenades (no
       roll). It sits after the implant so the earlier draws do not move, and an enemy with no table spends no rng
       here at all. */
    if (faction) this.rollFactionGear(faction, rng, curve, out);
    if (siteBonus) this.rollSiteBonusItems(siteBonus, rng, planet, out, keep);
    this.addCarriedGrenades(opts, out);

    /* 2026-09-11: the named rogue's guaranteed drop — it is **dead last**, so the earlier draws do not move, and an
       enemy that is not named never even enters this branch (`warrior` / `rogue` / `rogue_boss` keep their pinned
       vectors).
       The planet curve (`curve`) is deliberately not passed — "최소 희귀 등급부터" is the user's specification.
       2026-09-16: the epic+ gate (`keep`) alone applies — user's decision 「잠긴 방 말고 전부」 (the grade III floor
       is still honoured). */
    const named = NAMED_DROP_MAP.get(type);
    if (named) this.rollNamedDrop(named, rng, out, keep);

    out.sort((a, b) => this.area(b) - this.area(a));
    return out;
  }

  /**
   * The corpse sample rows (`CorpseTable.samples`). Per row: chance → count → a weighted tier draw **per unit** →
   * one stack per identical item.
   * ⚠ 2026-09-17 (user's decision): they are **exempt** from the epic+ gate (`epicPlusMul`) — the same exemption as
   * the lab's locked room. Cell IV (epic) has to come out at exactly the rate written in
   * `data/loot_corpse_samples.csv`. So this takes no `keep` and spends no gate draw.
   * The other corpse rows (`loot_corpses.csv` and the rest) ride the gate as usual.
   */
  private rollCorpseSamples(rows: readonly CorpseSampleDrop[], rng: Random, out: ItemInstance[]): void {
    for (const row of rows) {
      if (row.chance < 1 && !rng.chance(row.chance)) continue;
      const defs = row.defIds.map((id) => ITEM_DEF_MAP.get(id)).filter((d): d is ItemDef => !!d);
      if (!defs.length) continue;
      const weightOf = (d: ItemDef): number => row.weights[row.defIds.indexOf(d.id)] ?? 0;
      const n = row.qty[0] >= row.qty[1] ? row.qty[0] : rng.int(row.qty[0], row.qty[1]);
      const counts = new Map<string, number>();
      for (let i = 0; i < n; i++) {
        const pick = rng.weighted(defs, weightOf);
        counts.set(pick.id, (counts.get(pick.id) ?? 0) + 1);
      }
      // Pushed in ascending tier order (= the `defIds` order), so the Map's insertion order does not wobble with
      // the draw order.
      // `createItem` clamps the quantity to stackMax (`SAMPLE_STACK_MAX`), so whatever overflows splits into another
      // stack (a sandworm's 4 must not shrink to 3).
      for (const d of defs) {
        let left = counts.get(d.id) ?? 0;
        while (left > 0) {
          const qty = Math.min(left, Math.max(1, d.stackMax));
          out.push(this.createItem(d.id, qty));
          left -= qty;
        }
      }
    }
  }

  /**
   * One named guaranteed drop. `chance` → grade (weighted) → item → durability
   * `NAMED_LOOT_DURABILITY_MIN..MAX` × the maximum.
   * A weapon also brings the rounds in its magazine (`magFraction`, else 0..magazine) and one stack of its ammo
   * type (`ammoFraction`).
   */
  private rollNamedDrop(drop: NamedDrop, rng: Random, out: ItemInstance[], keep = 1): void {
    /* 2026-09-16: the epic+ gate — an item row (the unique minigun) multiplies it into the chance; a weapon · armor
       row whose drawn grade is epic+ is kept with probability `keep`, else dropped to that row's highest grade below
       epic (usually III). With keep 1 the draws are the old ones. */
    const itemDef = drop.kind === 'item' ? ITEM_DEF_MAP.get(drop.target) : undefined;
    if (!rng.chance(itemDef && keep < 1 && isEpicPlus(itemDef) ? drop.chance * keep : drop.chance)) return;
    const defIdForGrade = (g: WeaponGrade): string | null => drop.kind === 'weapon' ? itemIdForWeapon(weaponIdForGrade(drop.target, g))
      : drop.kind === 'armor' ? numberedArmorIdForTier(g) : null;
    let grade = drop.grades.length > 0 ? rng.weighted(drop.grades, (g) => drop.weightOf[g] ?? 0) : null;
    if (grade !== null && keep < 1) {
      const rolled = ITEM_DEF_MAP.get(defIdForGrade(grade) ?? '');
      if (rolled && isEpicPlus(rolled) && !rng.chance(keep)) {
        const below = (list: readonly WeaponGrade[]): WeaponGrade | undefined => [...list].reverse().find((g) => {
          const d = ITEM_DEF_MAP.get(defIdForGrade(g) ?? '');
          return !!d && !isEpicPlus(d);
        });
        grade = below(drop.grades) ?? below(WEAPON_GRADES) ?? grade;
      }
    }
    let defId: string | null = null;
    if (drop.kind === 'item') defId = drop.target;
    else if (grade !== null) defId = defIdForGrade(grade);
    const def = defId ? ITEM_DEF_MAP.get(defId) : undefined;
    if (!def) { console.warn(`[Loot] named drop '${drop.type}': unknown item '${defId}'`); return; }

    const durFrac = rng.range(NAMED_LOOT_DURABILITY_MIN, NAMED_LOOT_DURABILITY_MAX);
    /* Clamped to [ceil(max × MIN), floor(max × MAX)] so rounding cannot leak outside the range — a sniper rifle V
       (240) used to give round(240 × 0.01) = 2 = 0.83 %. Minimum 1. */
    const namedDurability = (max: number): number => {
      const lo = Math.max(1, Math.ceil(max * NAMED_LOOT_DURABILITY_MIN - 1e-9));
      const hi = Math.max(lo, Math.floor(max * NAMED_LOOT_DURABILITY_MAX + 1e-9));
      return Math.min(hi, Math.max(lo, Math.round(max * durFrac)));
    };
    const weapon = def.weaponId ? WEAPON_DEF_MAP.get(def.weaponId) : undefined;
    if (!weapon) {
      const max = def.durabilityMax;
      out.push(this.createItem(def.id, 1, max !== undefined ? { durability: namedDurability(max) } : undefined));
      return;
    }
    const stats = computeWeaponStats(weapon);
    const durability = namedDurability(stats.maxDurability);
    const ammoInMag = drop.magFraction
      ? Math.max(0, Math.min(stats.magSize, Math.round(stats.magSize * rng.range(drop.magFraction[0], drop.magFraction[1]))))
      : rng.int(0, stats.magSize);
    out.push(this.createItem(def.id, 1, { durability, ammoInMag }));
    const ammoDef = drop.ammoFraction ? ITEM_DEF_MAP.get(ammoItemIdFor(weapon.ammoType)) : undefined;
    if (ammoDef && drop.ammoFraction) {
      const [lo, hi] = drop.ammoFraction;
      out.push(this.createItem(ammoDef.id, Math.max(1, Math.min(ammoDef.stackMax, Math.round(ammoDef.stackMax * rng.range(lo, hi))))));
    }
  }

  /* ── appended (2026-09-09): per-planet weapon grade curves (`data/planet_loot.csv`) ───────────────────────── */

  /**
   * A crate roll with the planet's grade curve applied. **How often** a weapon comes out is still decided by the
   * crate tier (`weaponChance`); only the **grade** of the weapon that came out is re-drawn from that planet's
   * curve (the family draw is untouched).
   * A **unique weapon** has no grade, so instead of the curve its appearance weight itself shrinks by `uniqueMul`,
   * and at 0 it leaves the candidates.
   *
   * 2026-09-10: **everything that is not a gun** (armor · bags · attachments · implants · consumables · materials ·
   * valuables) takes that planet's `rareMul` · `epicMul` · `legMul` — the tier table's rarity weights are shaved
   * and what was shaved goes back to common · uncommon, keeping the total (`planetRarityWeights`). Gun grades do
   * not ride these multipliers, because `regrade` overwrites them with g1..g5 afterwards — the two axes are
   * deliberately separate.
   *
   * With `planet` null, or a planet the table does not list, this is exactly `rollCrate`.
   */
  rollCrateOn(tier: number, rng: Random, planet: PlanetId | null, opts?: CrateLootOpts): ItemInstance[] {
    // 2026-09-13: the planet filters the candidates for library media · consoles · game discs too
    // (`LootTables.isLootableOnPlanet`).
    const curve = this.curveFor(planet);
    /* 2026-09-16: the epic+ gate — only the lab's locked room (`opts.lockedRoom`) is exempt, so that roll is
       bit-for-bit as before (it still rides the planet curve · the rarity multipliers). User's decision
       「잠긴 방은 지금 그대로, 나머지는 서사 이상 절반」. */
    const keep = opts?.lockedRoom ? 1 : (curve?.epicPlusMul ?? 1);
    return this.rollCrateWithCurve(tier, rng, curve, planet, keep);
  }

  /**
   * A corpse roll with the planet's grade **cap** applied. Otherwise it is `rollCorpse` — the rule that a boss
   * drops III/IV stands, and only a grade above the cap comes down to the cap. A **unique** has no grade, so the
   * boss roll's chance is multiplied by `uniqueMul` instead (on a planet at 0 not even a boss drops a unique).
   *
   * 2026-09-10: **the one thing a corpse draws by rarity is the broken implant**, and that is where `rareMul` ·
   * `epicMul` · `legMul` apply. The other corpse drops (`loot_corpses.csv`) are per-item chances — "was this enemy
   * carrying this thing" — not a rarity draw, and a boss attachment is cut by `maxRarity` and then drawn
   * **uniformly**; neither has a place to apply a multiplier (fixing the chance in the csv directly is the right
   * move).
   */
  rollCorpseOn(type: EnemyType, rng: Random, rogueWeaponId: string | undefined, planet: PlanetId | null, opts?: CorpseLootOpts): ItemInstance[] {
    // 2026-09-13: `opts` = the spawn site (the site bonus) · carried grenades (straight onto the corpse). Omit it
    // and only the site bonus · the grenades are missing.
    return this.rollCorpseWithMax(type, rng, rogueWeaponId, this.curveFor(planet), planet, opts);
  }

  /* ── appended (2026-09-13): humanoid faction loot (`data/loot_factions.csv` · `loot_faction_sites.csv`) ──────── */

  /**
   * Armor → bag → heal. Armor · bags drop worn, like guns (`gearDurability` × the maximum, minimum 1).
   * The rarity weights take that planet's `rareMul` · `epicMul` · `legMul` (the same rule as crates · broken
   * implants).
   */
  private rollFactionGear(faction: FactionLoot, rng: Random, curve: PlanetGradeCurve | null, out: ItemInstance[]): void {
    const [dLo, dHi] = faction.gearDurability;
    for (const pick of [faction.armor, faction.bag]) {
      const id = pick ? this.rollRarityPick(pick, rng, curve) : null;
      const def = id ? ITEM_DEF_MAP.get(id) : undefined;
      if (!def) continue;
      const max = def.durabilityMax;
      out.push(this.createItem(def.id, 1, max !== undefined ? { durability: Math.max(1, Math.round(max * rng.range(dLo, dHi))) } : undefined));
    }
    const heal = faction.heal ? this.rollRarityPick(faction.heal, rng, curve) : null;
    if (heal && ITEM_DEF_MAP.has(heal)) out.push(this.createItem(heal, 1));
  }

  /** `chance` → rarity (weighted, planet multipliers) → uniform among that rarity's candidates. None = null. */
  private rollRarityPick(pick: CorpseRarityPick, rng: Random, curve: PlanetGradeCurve | null): string | null {
    if (!rng.chance(pick.chance)) return null;
    const w = planetRarityWeights(pick.weights, curve);
    const rarities = pick.rarities.filter((q) => (w[q] ?? 0) > 0);
    if (rarities.length === 0) return null;
    let rarity = rng.weighted(rarities, (q) => w[q] ?? 0);
    /* 2026-09-16: the epic+ gate — when it catches, this row's highest rarity below epic (`rarities` runs common →
       legendary). With none, empty-handed. */
    const keep = curve?.epicPlusMul ?? 1;
    if (keep < 1 && rarityRank(rarity) >= EPIC_RANK && !rng.chance(keep)) {
      const lower = rarities.filter((q) => rarityRank(q) < EPIC_RANK);
      if (lower.length === 0) return null;
      rarity = lower[lower.length - 1];
    }
    const ids = pick.byRarity.get(rarity);
    return ids && ids.length > 0 ? rng.pick(ids) : null;
  }

  /**
   * The site bonus's item rows (csv order). A `seed` is picked from the raid planet's wild seed pool. Retired items
   * are skipped.
   */
  private rollSiteBonusItems(bonus: FactionSiteBonus, rng: Random, planet: PlanetId | null, out: ItemInstance[], keep = 1): void {
    for (const it of bonus.items) {
      /* 2026-09-16: the epic+ gate — an item row multiplies it into the chance; on a seed row an epic+ drawn seed
         drops to that pool's highest rarity below epic. */
      const fixed = it.kind === 'item' ? ITEM_DEF_MAP.get(it.defId) : undefined;
      const chance = keep < 1 && fixed && isEpicPlus(fixed) ? it.chance * keep : it.chance;
      if (chance < 1 && !rng.chance(chance)) continue;
      let defId = it.defId;
      if (it.kind === 'seed') {
        const pool = planetSeedPool(planet);
        if (pool.length === 0) continue;
        defId = rng.weighted(pool, (s) => s.weight).defId;
        const seedDef = ITEM_DEF_MAP.get(defId);
        if (keep < 1 && seedDef && isEpicPlus(seedDef) && !rng.chance(keep)) {
          const rankOf = (s: { defId: string }): number => { const d = ITEM_DEF_MAP.get(s.defId); return d ? rarityRank(d.rarity) : -1; };
          const lower = pool.filter((s) => rankOf(s) >= 0 && rankOf(s) < EPIC_RANK);
          if (lower.length === 0) continue;
          const best = Math.max(...lower.map(rankOf));
          defId = rng.weighted(lower.filter((s) => rankOf(s) === best), (s) => s.weight).defId;
        }
      }
      const qty = it.qty[0] >= it.qty[1] ? it.qty[0] : rng.int(it.qty[0], it.qty[1]);
      const def = ITEM_DEF_MAP.get(defId);
      if (!def || def.retired) continue;
      out.push(this.createItem(def.id, qty));
    }
  }

  /**
   * The grenades left unthrown — kind · count as they are (no roll, no rng). The count is clamped to one stack
   * (`stackMax`) by `createItem`, so an oversized value off the wire cannot turn a corpse into a grenade stash.
   * An unknown kind is dropped.
   */
  private addCarriedGrenades(opts: CorpseLootOpts | undefined, out: ItemInstance[]): void {
    const g = opts?.grenades;
    if (!g || !Number.isFinite(g.count) || g.count < 1) return;
    const id = Object.prototype.hasOwnProperty.call(ENEMY_GRENADE_ITEM, g.kind) ? ENEMY_GRENADE_ITEM[g.kind] : undefined;
    if (id && ITEM_DEF_MAP.has(id)) out.push(this.createItem(id, g.count));
  }

  /** Planet id → difficulty rank (`planetTier`) → the grade curve. With no planet, null (the old behaviour). */
  private curveFor(planet: PlanetId | null): PlanetGradeCurve | null {
    return planet == null ? null : getPlanetGradeCurve(planetTier(planet));
  }

  /**
   * Re-grades one weapon item to a grade from the planet curve. Anything that is not a weapon, or a unique (no
   * grade), is returned unchanged.
   * The family is kept, so "which gun came out" does not change — only "what grade it is" does.
   */
  private regrade(def: ItemDef, curve: PlanetGradeCurve, rng: Random, keep = 1): ItemDef {
    /* Unique-only ammo is blocked by the same multiplier as the gun — on a planet where the gun that uses it
       never comes out, this ammo alone is dead weight eating a bag cell. A failed gate turns it into one ordinary
       calibre.
       The stack that accompanies a unique gun that actually came out is rolled after this (the Phase 6 path in
       `rollCrateWithCurve`), so it is not caught. */
    if (UNIQUE_AMMO_ITEM_IDS.has(def.id)) {
      if (curve.uniqueMul >= 1 || rng.chance(curve.uniqueMul)) return def;
      return ITEM_DEF_MAP.get(rng.pick(GRADED_AMMO_ITEM_IDS)) ?? def;
    }
    const weapon = def.weaponId ? WEAPON_DEF_MAP.get(def.weaponId) : undefined;
    if (!weapon || curve.grades.length === 0) return def;
    let family = weaponFamilyOf(weapon);
    if (isUniqueWeapon(weapon)) {
      /* A unique has no grade and cannot ride the curve — it survives only on the `uniqueMul` chance, and on a
         fail it becomes one ordinary gun. Why this is applied here, in one place, rather than in the crate pick
         weights is in the `curveMul` comment below (`curveMul` is the last method of this file). */
      if (curve.uniqueMul >= 1 || rng.chance(curve.uniqueMul)) {
        /* 2026-09-16: a surviving unique (mythic) rides the epic+ gate too — when it catches, the highest grade
           below epic of a random family. */
        if (keep >= 1 || !isEpicPlus(def) || rng.chance(keep)) return def;
        const fallback = rng.pick(WEAPON_FAMILIES);
        return ITEM_DEF_MAP.get(itemIdForWeapon(weaponIdForGrade(fallback, this.bestGradeBelowEpic(fallback, curve.grades)))) ?? def;
      }
      family = rng.pick(WEAPON_FAMILIES);
    }
    const grade = rng.weighted(curve.grades, (g) => curve.weightOf[g] ?? 0);
    const graded = ITEM_DEF_MAP.get(itemIdForWeapon(weaponIdForGrade(family, grade))) ?? def;
    /* 2026-09-16: when the grade the curve drew is epic+ (IV · V) the gate applies — when it catches, the highest
       grade below epic present in the curve (III). */
    if (keep >= 1 || !isEpicPlus(graded) || rng.chance(keep)) return graded;
    return ITEM_DEF_MAP.get(itemIdForWeapon(weaponIdForGrade(family, this.bestGradeBelowEpic(family, curve.grades)))) ?? graded;
  }

  /**
   * 2026-09-16: the highest grade below epic in the family `family` — within `grades` (the curve's · the table's
   * grade list) first, and across I..V when there is none.
   * This is where a gun caught by the epic+ gate lands (always III with today's data).
   */
  private bestGradeBelowEpic(family: string, grades: readonly WeaponGrade[]): WeaponGrade {
    const below = (list: readonly WeaponGrade[]): WeaponGrade | undefined => [...list].sort((a, b) => b - a).find((g) => {
      const d = ITEM_DEF_MAP.get(itemIdForWeapon(weaponIdForGrade(family, g)));
      return !!d && !isEpicPlus(d);
    });
    return below(grades) ?? below(WEAPON_GRADES) ?? 1;
  }

  /** Stack quantity for a pick: ammo = rounds as a tier-scaled fraction of the stack; other stackables capped by the tier. */
  private rollQty(def: ItemDef, table: TierTable, rng: Random): number {
    if (def.stackMax <= 1) return 1;
    if (def.category === 'ammo') {
      const [lo, hi] = table.ammoFraction;
      return Math.max(1, Math.min(def.stackMax, Math.round(def.stackMax * rng.range(lo, hi))));
    }
    return rng.int(1, Math.min(def.stackMax, table.maxStackQty));
  }

  private area(it: ItemInstance): number {
    const d = ITEM_DEF_MAP.get(it.defId);
    return d ? d.width * d.height : 0;
  }

  /** `itemWeightMul` lookup: exact item id, else (weapons) the family's item id / family id — applies to every grade. */
  private weightMul(table: TierTable, d: ItemDef): number {
    const mul = table.itemWeightMul;
    if (!mul) return 1;
    const exact = mul[d.id];
    if (exact !== undefined) return exact;
    if (d.weaponId) {
      const weapon = WEAPON_DEF_MAP.get(d.weaponId);
      if (weapon) {
        const family = weaponFamilyOf(weapon);
        return mul[itemIdForWeapon(family)] ?? mul[family] ?? 1;
      }
    }
    return 1;
  }

  /**
   * Weighted pick among defs matching `filter`. When `relaxRarity` is true and no
   * candidate has a positive weight in the table, fall back to uniform choice so
   * guaranteed rolls always resolve.
   */
  private pickDef(
    table: TierTable, rng: Random, filter: (d: ItemDef) => boolean, relaxRarity: boolean,
    curve: PlanetGradeCurve | null = null, planet: PlanetId | null = null,
    /**
     * 2026-09-16: the epic+ gate's keep probability (1 = no gate) · the candidate pool to land in
     * (omitted = `filter`).
     */
    keep = 1, pool?: (d: ItemDef) => boolean,
  ): ItemDef | null {
    /* 2026-09-13: a retired item is a candidate in no roll at all (guaranteed · weapon · category · the
       relaxRarity fallback).
       The same day (library series): a planet-bound item (library media · consoles · game discs) is a
       candidate only on its own planet. */
    const all = ITEM_DEFS.filter((d) => isLootableDef(d) && isLootableOnPlanet(d, planet) && filter(d));
    /* On a planet where uniques are sealed they leave the candidates outright — leaving only the weight at 0 lets
       the `relaxRarity` fallback pick them straight back up (it really happens on a table like tier 5, where every
       graded weapon is 0). With curve null the candidates are unchanged. */
    const candidates = curve ? all.filter((d) => this.curveMul(curve, d) > 0) : all;
    if (candidates.length === 0) return null;
    /* 2026-09-10: the planet's `rareMul` · `epicMul` · `legMul` are applied here, in one place — a crate's rarity
       roll passes through this function for the guaranteed pick · the weapon pick · the category pick alike. With
       the multipliers at 1, `table.rarityWeights` comes back untouched (the same object), so that planet's result
       is bit-for-bit as before. */
    const rarityWeights = planetRarityWeights(table.rarityWeights, curve);
    /* 2026-09-13: library media multiply in the volume weight (a later volume is rarer — 1 for anything else). */
    /* 2026-09-16: the `?? 0` is there for **mythic** — a crate table has only five rarity columns
       (`RARITY_ORDER_LOOT`), so mythic has no weight at all. Multiplying `undefined` as before gave NaN and dropped
       it silently; 0 writes the rule "a crate never draws mythic" into the code (unique weapons · perk armor ·
       mythic samples are what it catches). */
    const weightOf = (d: ItemDef): number => (rarityWeights[d.rarity] ?? 0) * this.weightMul(table, d) * this.curveMul(curve, d) * libraryVolumeWeight(d);
    const weighted = candidates.filter((d) => weightOf(d) > 0);
    let picked: ItemDef;
    if (weighted.length > 0) picked = rng.weighted(weighted, weightOf);
    else if (relaxRarity) picked = rng.weighted(candidates, (d) => 1 / (1 + rarityRank(d.rarity)));
    else return null;
    /* 2026-09-16: the epic+ gate — the guaranteed · weapon · category · relaxRarity fallback picks all pass through
       here. With a planet curve a gun has its grade re-drawn by `regrade`, so the gate is applied there instead
       (applying it here would only add a draw that gets overwritten). */
    if (keep >= 1 || !isEpicPlus(picked) || (curve && isWeaponItemDef(picked)) || rng.chance(keep)) return picked;
    const lower = ITEM_DEFS.filter((d) => !isEpicPlus(d) && isLootableDef(d) && isLootableOnPlanet(d, planet)
      && this.curveMul(curve, d) > 0 && (pool ?? filter)(d));
    /* The highest rarity below epic that is positive under the same weight rules (table rarity · item multiplier ·
       volume weight) → a weighted draw. With no such candidate, and the original pick a fallback, the fallback rule
       applies instead (weights ignored): uniform among the highest rarity. Neither = null (that pick never
       happened). */
    const lowerWeighted = topRarity(lower.filter((d) => weightOf(d) > 0));
    if (lowerWeighted.length > 0) return rng.weighted(lowerWeighted, weightOf);
    if (relaxRarity && lower.length > 0) return rng.pick(topRarity(lower));
    return null;
  }

  /**
   * Can this item be a candidate on this planet. It filters out only **unique weapons · unique-only ammo** on a
   * planet whose `uniqueMul` is 0 — a multiplier between 0 and 1 is not used here (`regrade`'s chance gate handles
   * that in one place).
   * The reason: on a table like tier 5, where every graded weapon is 0, shrinking the weight achieves nothing —
   * the only candidates are uniques, so the multiplier cancels.
   */
  private curveMul(curve: PlanetGradeCurve | null, d: ItemDef): number {
    if (!curve || curve.uniqueMul > 0) return 1;
    if (UNIQUE_AMMO_ITEM_IDS.has(d.id)) return 0;
    const w = d.weaponId ? WEAPON_DEF_MAP.get(d.weaponId) : undefined;
    return w && isUniqueWeapon(w) ? 0 : 1;
  }
}
