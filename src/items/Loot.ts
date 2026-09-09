import type { ArmorDef, CraftRecipe, EffectiveWeaponStats, EnemyType, ItemDef, ItemInstance, ItemInstanceExtras, LootRef, WeaponDef } from '@/shared';
/* appended (2026-09-09): 행성별 무기 등급 곡선 */
import type { PlanetId, WeaponGrade } from '@/shared';
import { Random, planetTier } from '@/shared';
import { UNIQUE_WEAPON_IDS } from '@/shared';
import { AMMO_TYPES_V2, ATTACHMENT_ITEM_DEFS, BOOK_ITEM_DEFS, ITEM_DEFS, ITEM_DEF_MAP, UNIQUE_AMMO_TYPES, ammoItemIdFor, isWeaponItemDef, itemIdForWeapon, rarityRank } from './ItemDefs';
import { WEAPON_DEF_MAP, WEAPON_FAMILIES, gradeOf, isUniqueWeapon, weaponFamilyOf, weaponIdForGrade } from './WeaponDefs';
import { canAttach as canAttachDef, computeWeaponStats, repairCost } from './WeaponStats';
import { ARMOR_DEF_MAP } from './ArmorDefs';
import { ALL_CRAFT_RECIPES } from './Recipes';
import { IMPLANT_BROKEN_DEFS } from './ImplantDefs';
import { CORPSE_TABLE_MAP, DEFAULT_ROGUE_WEAPON_ID, getPlanetGradeCurve, getTierTable, type PlanetGradeCurve, type TierTable } from './LootTables';

/**
 * 유니크 전용 탄종의 아이템 id (`ammo_fuel` … `ammo_belt`) 와 등급 무기가 쓰는 평범한 탄종의 id.
 * `data/ammo.csv` 기준으로 여섯 유니크 구경은 **그 유니크 총 전용**이다 — 등급 6계열은 light / medium /
 * heavy / shell 만 쓴다. 그래서 유니크가 봉인된 행성에서는 그 탄약도 같이 막아야 죽은 무게가 안 생긴다.
 */
const UNIQUE_AMMO_ITEM_IDS: ReadonlySet<string> = new Set(UNIQUE_AMMO_TYPES.map(ammoItemIdFor));
const GRADED_AMMO_ITEM_IDS: readonly string[] = AMMO_TYPES_V2.filter((t) => !UNIQUE_AMMO_TYPES.includes(t)).map(ammoItemIdFor);

let uidCounter = 0;
/** Unique, sortable-ish item uid: counter + random suffix. */
export function nextUid(): string {
  uidCounter = (uidCounter + 1) % 0xffffff;
  return `i${uidCounter.toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

export class LootService implements LootRef {
  private fallbackRng = new Random(Date.now() & 0x7fffffff);

  getItemDef(defId: string): ItemDef | undefined { return ITEM_DEF_MAP.get(defId); }
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
    const def = ITEM_DEF_MAP.get(defId);
    if (!def) throw new Error(`[Loot] unknown item def '${defId}'`);
    const inst: ItemInstance = { uid: nextUid(), defId, qty: Math.max(1, Math.min(def.stackMax, Math.floor(qty))), rotated: false };
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

  getRepairCost(inst: ItemInstance): { defId: string; qty: number }[] {
    const weapon = this.weaponDefOfItem(inst.defId);
    return weapon ? repairCost(weapon, inst) : [];
  }

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
    return this.rollCrateWithCurve(tier, rng, null);
  }

  /** `rollCrate` 본체. `curve` 가 null 이면 rng 를 한 번도 더 쓰지 않으므로 예전 결과와 완전히 같다. */
  private rollCrateWithCurve(tier: number, rng: Random, curve: PlanetGradeCurve | null): ItemInstance[] {
    const table = getTierTable(tier);
    const count = rng.int(table.count[0], table.count[1]);
    const picks: ItemDef[] = [];

    for (const g of table.guaranteed) {
      const d = this.pickDef(table, rng, (def) => g.categories.includes(def.category) && rarityRank(def.rarity) >= rarityRank(g.minRarity), true, curve);
      if (d) picks.push(d);
    }

    // decide once per crate whether a weapon is included (guaranteed rolls may already have one)
    let weaponPending = !picks.some(isWeaponItemDef)
      && table.weaponChance > 0 && rng.chance(table.weaponChance);
    while (picks.length < count) {
      if (weaponPending) {
        weaponPending = false;
        const d = this.pickDef(table, rng, isWeaponItemDef, true, curve);
        if (d) { picks.push(d); continue; }
      }
      const hasBag = picks.some((d) => d.category === 'bag');
      const cats = (Object.keys(table.categoryWeights) as Array<keyof typeof table.categoryWeights>)
        .filter((c) => !(hasBag && c === 'bag'));
      const cat = rng.weighted(cats, (c) => table.categoryWeights[c] ?? 0);
      const d = this.pickDef(table, rng, (def) => def.category === cat, false, curve);
      if (d) picks.push(d); else break;
    }

    // 2026-09-09: 행성 곡선으로 **등급만** 다시 매긴다 (계열 추첨 · 유니크는 그대로).
    if (curve) {
      for (let i = 0; i < picks.length; i++) picks[i] = this.regrade(picks[i], curve, rng);
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
        // Found gear is second-hand: 55–100 % durability, so 함선 수리 is worth doing.
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
    return this.rollCorpseWithMax(type, rng, rogueWeaponId, null);
  }

  /** `rollCorpse` 본체. `maxGrade` 는 행성의 등급 상한이고 null 이면 상한 없음 — rng 소모는 어느 쪽이든 같다. */
  private rollCorpseWithMax(
    type: EnemyType, rng: Random, rogueWeaponId: string | undefined, curve: PlanetGradeCurve | null,
  ): ItemInstance[] {
    const maxGrade: WeaponGrade | null = curve?.maxGrade ?? null;
    const table = CORPSE_TABLE_MAP.get(type);
    if (!table) return [this.createItem('mat_bio_sample', 1)];
    const out: ItemInstance[] = [];

    for (const drop of table.drops) {
      if (drop.chance < 1 && !rng.chance(drop.chance)) continue;
      if (!ITEM_DEF_MAP.has(drop.defId)) { console.warn(`[Loot] corpse table '${type}': unknown def '${drop.defId}'`); continue; }
      const qty = drop.qty[0] >= drop.qty[1] ? drop.qty[0] : rng.int(drop.qty[0], drop.qty[1]);
      out.push(this.createItem(drop.defId, qty));
    }

    if (table.weapon) {
      const base = WEAPON_DEF_MAP.get(rogueWeaponId ?? DEFAULT_ROGUE_WEAPON_ID) ?? WEAPON_DEF_MAP.get(DEFAULT_ROGUE_WEAPON_ID);
      if (base) {
        let weapon = base;
        if (table.weapon.grades && table.weapon.grades.length > 0) {
          weapon = WEAPON_DEF_MAP.get(weaponIdForGrade(weaponFamilyOf(base), rng.pick(table.weapon.grades))) ?? base;
        }
        // 2026-09-09: 앞쪽 행성에서는 보스가 떨구는 총도 그 행성의 최대 등급을 넘지 못한다 (rng 소모는 그대로).
        if (maxGrade !== null && !isUniqueWeapon(weapon) && gradeOf(weapon) > maxGrade) {
          weapon = WEAPON_DEF_MAP.get(weaponIdForGrade(weaponFamilyOf(weapon), maxGrade)) ?? weapon;
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
          const pick = rng.pick(fitting.length > 0 ? fitting : pool);
          if (pick) out.push(this.createItem(pick.id, 1));
        }
      }
    }

    // Phase 6: bosses may carry one legendary unique (rolled last so earlier draws are unchanged) + a stack of its calibre
    // 2026-09-09: 유니크는 등급이 없어 곡선을 안 타므로 행성의 `uniqueMul` 로 확률 자체를 줄인다 (0 = 없음).
    // `rng.chance` 는 배수와 무관하게 draw 를 하나 쓰므로 planet 이 null 인 경로의 rng 소비는 그대로다.
    if (table.unique && rng.chance(table.unique.chance * (curve?.uniqueMul ?? 1))) {
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

    // Phase 9: a reading raider — one 서적, uniform over the 14 books (rolled after the unique so earlier draws are unchanged)
    if (table.book && BOOK_ITEM_DEFS.length > 0 && rng.chance(table.book.chance)) {
      out.push(this.createItem(rng.pick(BOOK_ITEM_DEFS).id, 1));
    }

    // Phase 12: a fried implant — one 망가진 임플란트 weighted by rarity (rolled last, so every earlier draw is unchanged)
    if (table.implant && rng.chance(table.implant.chance)) {
      const w = table.implant.weights;
      const pool = IMPLANT_BROKEN_DEFS.filter((d) => (w[d.rarity] ?? 0) > 0);
      if (pool.length > 0) out.push(this.createItem(rng.weighted(pool, (d) => w[d.rarity] ?? 0).id, 1));
    }

    out.sort((a, b) => this.area(b) - this.area(a));
    return out;
  }

  /* ── appended (2026-09-09): 행성별 무기 등급 곡선 (`data/planet_loot.csv`) ───────────────────────── */

  /**
   * 행성의 등급 곡선을 적용한 상자 굴림. 무기가 나오는 **빈도**는 여전히 상자 티어(`weaponChance`)가 정하고,
   * 나온 무기의 **등급**만 그 행성의 곡선으로 다시 뽑는다 (계열 추첨은 그대로).
   * 등급이 없는 **유니크 무기**는 곡선 대신 `uniqueMul` 로 등장 가중치 자체가 줄고, 0 이면 후보에서 빠진다.
   * `planet` 이 null 이거나 표에 없는 행성이면 `rollCrate` 와 완전히 같다.
   */
  rollCrateOn(tier: number, rng: Random, planet: PlanetId | null): ItemInstance[] {
    return this.rollCrateWithCurve(tier, rng, this.curveFor(planet));
  }

  /**
   * 행성의 등급 **상한**을 적용한 시체 굴림. 그 외에는 `rollCorpse` 와 같다 — 보스가 III/IV 를 떨구는 규칙은
   * 그대로이고 상한을 넘는 등급만 상한으로 내려온다. 등급이 없는 **유니크**는 보스 굴림의 확률에
   * `uniqueMul` 이 곱해진다 (0 인 행성에서는 보스도 유니크를 떨구지 않는다).
   */
  rollCorpseOn(type: EnemyType, rng: Random, rogueWeaponId: string | undefined, planet: PlanetId | null): ItemInstance[] {
    return this.rollCorpseWithMax(type, rng, rogueWeaponId, this.curveFor(planet));
  }

  /** 행성 id → 난이도 순번(`planetTier`) → 등급 곡선. 행성이 없으면 null (예전 동작). */
  private curveFor(planet: PlanetId | null): PlanetGradeCurve | null {
    return planet == null ? null : getPlanetGradeCurve(planetTier(planet));
  }

  /**
   * 무기 아이템 하나를 행성 곡선의 등급으로 다시 매긴다. 무기가 아니거나 유니크(등급 없음)면 그대로 돌려준다.
   * 계열은 유지하므로 "무슨 총이 나왔나" 는 안 바뀌고 "몇 등급이냐" 만 바뀐다.
   */
  private regrade(def: ItemDef, curve: PlanetGradeCurve, rng: Random): ItemDef {
    /* 유니크 전용 탄약도 총과 같은 배수로 막는다 — 쓸 총이 안 나오는 행성에서 이 탄약만 떨어지면
       가방 칸을 먹는 죽은 무게다. 탈락하면 평범한 구경 한 종으로 바뀐다.
       유니크 총이 실제로 나와서 딸려 나오는 한 스택은 이 뒤(`rollCrateWithCurve` 의 Phase 6 경로)라 걸리지 않는다. */
    if (UNIQUE_AMMO_ITEM_IDS.has(def.id)) {
      if (curve.uniqueMul >= 1 || rng.chance(curve.uniqueMul)) return def;
      return ITEM_DEF_MAP.get(rng.pick(GRADED_AMMO_ITEM_IDS)) ?? def;
    }
    const weapon = def.weaponId ? WEAPON_DEF_MAP.get(def.weaponId) : undefined;
    if (!weapon || curve.grades.length === 0) return def;
    let family = weaponFamilyOf(weapon);
    if (isUniqueWeapon(weapon)) {
      /* 유니크는 등급이 없어 곡선을 못 탄다 — `uniqueMul` 확률로만 살아남고, 떨어지면 평범한 총 한 자루가 된다.
         상자 픽 가중치가 아니라 여기서 한 번에 거는 이유는 위 `curveMul` 주석에 있다. */
      if (curve.uniqueMul >= 1 || rng.chance(curve.uniqueMul)) return def;
      family = rng.pick(WEAPON_FAMILIES);
    }
    const grade = rng.weighted(curve.grades, (g) => curve.weightOf[g] ?? 0);
    return ITEM_DEF_MAP.get(itemIdForWeapon(weaponIdForGrade(family, grade))) ?? def;
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
    curve: PlanetGradeCurve | null = null,
  ): ItemDef | null {
    const all = ITEM_DEFS.filter(filter);
    /* 유니크가 봉인된 행성에서는 후보에서 아예 뺀다 — 가중치만 0 으로 두면 `relaxRarity` 폴백이 도로 집어 온다
       (티어 5 처럼 등급 무기가 전부 0 인 표에서 실제로 일어난다). curve 가 null 이면 후보가 그대로다. */
    const candidates = curve ? all.filter((d) => this.curveMul(curve, d) > 0) : all;
    if (candidates.length === 0) return null;
    const weightOf = (d: ItemDef): number => table.rarityWeights[d.rarity] * this.weightMul(table, d) * this.curveMul(curve, d);
    const weighted = candidates.filter((d) => weightOf(d) > 0);
    if (weighted.length > 0) return rng.weighted(weighted, weightOf);
    if (relaxRarity) return rng.weighted(candidates, (d) => 1 / (1 + rarityRank(d.rarity)));
    return null;
  }

  /**
   * 이 행성에서 이 아이템이 후보가 될 수 있나. `uniqueMul` 이 0 인 행성의 **유니크 무기 · 유니크 전용 탄약**만
   * 걸러 낸다 — 0 과 1 사이의 배수는 여기서 쓰지 않는다 (`regrade` 의 확률 게이트가 한 곳에서 처리한다).
   * 티어 5 처럼 등급 무기가 전부 0 인 표에서는 가중치를 줄여 봐야 후보가 유니크뿐이라 배수가 상쇄되기 때문이다.
   */
  private curveMul(curve: PlanetGradeCurve | null, d: ItemDef): number {
    if (!curve || curve.uniqueMul > 0) return 1;
    if (UNIQUE_AMMO_ITEM_IDS.has(d.id)) return 0;
    const w = d.weaponId ? WEAPON_DEF_MAP.get(d.weaponId) : undefined;
    return w && isUniqueWeapon(w) ? 0 : 1;
  }
}
