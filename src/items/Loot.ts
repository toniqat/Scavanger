import type { ArmorDef, CraftIngredient, CraftRecipe, DurabilityBucketInfo, EffectiveWeaponStats, EnemyType, ItemDef, ItemInstance, ItemInstanceExtras, LootRef, WeaponDef } from '@/shared';
/* appended (2026-09-09): 행성별 무기 등급 곡선 */
import type { CorpseLootOpts, PlanetId, WeaponGrade } from '@/shared';
import { Random, planetTier } from '@/shared';
import { UNIQUE_WEAPON_IDS } from '@/shared';
import { AMMO_TYPES_V2, ATTACHMENT_ITEM_DEFS, ITEM_DEFS, ITEM_DEF_MAP, UNIQUE_AMMO_TYPES, ammoItemIdFor, isWeaponItemDef, itemIdForWeapon, rarityRank } from './ItemDefs';
/* appended (2026-09-13): 서재 매체 · 비디오게임 — 행성 고정 드롭 · 권 가중치 · 옛 id 안전망 */
import { resolveItemAlias } from '@/shared';
import type { LootCategory } from './LootTables';
import { isLootableOnPlanet, libraryBookPool, libraryVolumeWeight, lootCategoryOf, planetCategoryAvailable } from './LootTables';
import { WEAPON_DEF_MAP, WEAPON_FAMILIES, gradeOf, isUniqueWeapon, weaponFamilyOf, weaponIdForGrade } from './WeaponDefs';
import { canAttach as canAttachDef, computeWeaponStats } from './WeaponStats';
import { ARMOR_DEF_MAP } from './ArmorDefs';
import { craftCostOf } from './Recipes';
/* appended (2026-09-10): 수리 · 분해는 제작 재료 × 내구도 구간 배수다 (`Salvage.ts`). */
import { ALL_CRAFT_RECIPES, durabilityBucketInfo, durabilityBucketOf, repairCostFor, salvageFor } from './Salvage';
import { IMPLANT_BROKEN_DEFS } from './ImplantDefs';
import { CORPSE_TABLE_MAP, DEFAULT_ROGUE_WEAPON_ID, getPlanetGradeCurve, getTierTable, planetRarityWeights, type PlanetGradeCurve, type TierTable } from './LootTables';
/* appended (2026-09-13): 은퇴한 아이템은 상자 · 보급 추첨 후보가 아니다 (csv 와 별개의 안전핀) */
import { isLootableDef } from './LootTables';
/* appended (2026-09-11): 네임드 로그 확정 드롭 (`data/loot_named.csv`) */
import { NAMED_LOOT_DURABILITY_MAX, NAMED_LOOT_DURABILITY_MIN } from '@/shared';
import { NAMED_DROP_MAP, numberedArmorIdForTier, type NamedDrop } from './LootTables';
/* appended (2026-09-13): 인간형 팩션 전리품 — 총 등급 분포 · 방탄복 · 가방 · 회복 · 거점 보너스 · 남은 수류탄 */
import { ENEMY_GRENADE_ITEM } from '@/shared';
import { FACTION_LOOT_MAP, getFactionSiteBonus, planetSeedPool, type CorpseRarityPick, type FactionLoot, type FactionSiteBonus } from './LootTables';
/* appended (2026-09-16): 서사 이상 드롭률 게이트 — 잠긴 방 예외 (`CrateLootOpts`) · 등급 무기 목록 */
import type { CrateLootOpts } from '@/shared';
import { WEAPON_GRADES } from './WeaponDefs';

/**
 * 유니크 전용 탄종의 아이템 id (`ammo_fuel` … `ammo_belt`) 와 등급 무기가 쓰는 평범한 탄종의 id.
 * `data/ammo.csv` 기준으로 여섯 유니크 구경은 **그 유니크 총 전용**이다 — 등급 6계열은 light / medium /
 * heavy / shell 만 쓴다. 그래서 유니크가 봉인된 행성에서는 그 탄약도 같이 막아야 죽은 무게가 안 생긴다.
 */
const UNIQUE_AMMO_ITEM_IDS: ReadonlySet<string> = new Set(UNIQUE_AMMO_TYPES.map(ammoItemIdFor));
const GRADED_AMMO_ITEM_IDS: readonly string[] = AMMO_TYPES_V2.filter((t) => !UNIQUE_AMMO_TYPES.includes(t)).map(ammoItemIdFor);

/*
 * 2026-09-16 — **서사 이상 드롭률 게이트** (`data/planet_loot.csv` 의 `epicPlusMul` = 아래 코드의 `keep`).
 * 사용자 결정: 연구실 잠긴 방을 뺀 모든 굴림에서 서사 · 전설이 나오는 비율을 절반으로. 희귀도 **가중치** 배수(`epicMul` ·
 * `legMul`)로는 안 된다 — 확정 픽은 후보가 이미 서사 이상뿐이라 배수가 상쇄되고, 폴백 픽은 가중치를 아예 안 본다.
 * 그래서 **뽑힌 결과**에 건다: 서사 이상이면 `rng.chance(keep)` 로 남기고, 아니면 같은 후보 묶음의 서사 미만 최고 희귀도로
 * 내린다. 그 픽이 서사 이상일 확률이 정확히 × keep 이 된다.
 * rng: `keep >= 1` 이면 draw 를 하나도 더 쓰지 않는다 (잠긴 방 · 행성 없는 굴림은 예전과 비트 단위로 같다). keep < 1 이면
 * 서사 이상이 뽑혔을 때만 게이트 draw 하나 + (내릴 때) 다시 고르는 draw 하나를 쓴다 — 시드 결정적이라 미리보기 ≡ 열기.
 */
const EPIC_RANK = rarityRank('epic');
const isEpicPlus = (d: ItemDef): boolean => rarityRank(d.rarity) >= EPIC_RANK;

/** 목록에서 희귀도가 가장 높은 것들만 (빈 목록이면 빈 목록). */
function topRarity<T extends ItemDef>(list: readonly T[]): T[] {
  let best = -1;
  for (const d of list) best = Math.max(best, rarityRank(d.rarity));
  return list.filter((d) => rarityRank(d.rarity) === best);
}

/**
 * 게이트 한 번 — `picked` 가 서사 이상이고 `keep` 에 떨어지면 `list` 중 서사 미만 · 가중치 양수인 최고 희귀도에서 `weight` 로
 * 다시 고른다 (없으면 null = 그 픽은 없던 것). 서사 미만이거나 `keep >= 1` 이면 rng 를 안 쓰고 그대로 돌려준다.
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

  /** 2026-09-13: 옛 서재 매체 id(`data/item_aliases.csv`)도 새 def 로 풀린다 — 세이브를 옮기는 폴더(housing · inventory)가 놓친 id 의 안전망. */
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
    /* 2026-09-13: 옛 id 면 새 id 로 만든다 (인스턴스의 defId 도 새 id 다). */
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
   * 2026-09-10 — **제작 재료 × 남은 내구도 구간의 수리 배수(올림)**. 시그니처는 그대로지만 이제
   * 방탄복도 값을 돌려준다 (예전에는 무기만이었고 방탄복 수리는 공짜였다). 회복 스프레이처럼
   * 자기 규칙이 있는 것은 예전처럼 `[]` 라 `inventory` 의 `sprayRepairCost` 경로가 그대로 산다.
   */
  getRepairCost(inst: ItemInstance): { defId: string; qty: number }[] {
    return repairCostFor(inst);
  }

  /* ── appended (2026-09-10): 내구도 연동 수리 · 분해 (owner: items/Salvage) ── */
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
   * `rollCrate` 본체. `curve` 가 null 이면 rng 를 한 번도 더 쓰지 않으므로 예전 결과와 완전히 같다.
   * 2026-09-13: `planet` — 서재 매체 · 게임기 · 게임 디스크를 그 행성의 것만 후보로 둔다. 그 행성에 후보가 없는 카테고리는
   * 카테고리 추첨 목록에서 빠진다(추첨 draw 수는 그대로 한 번). null 이면 행성이 있는 아이템 전부가 후보다.
   */
  private rollCrateWithCurve(tier: number, rng: Random, curve: PlanetGradeCurve | null, planet: PlanetId | null, keep = 1): ItemInstance[] {
    const table = getTierTable(tier);
    const count = rng.int(table.count[0], table.count[1]);
    const picks: ItemDef[] = [];
    /** 후보가 하나도 없다고 판명된 카테고리 (이 상자에서 다시 뽑지 않는다 — 무한 루프 방지). */
    const dead = new Set<LootCategory>();

    for (const g of table.guaranteed) {
      /* 2026-09-16: 게이트에 걸린 확정 픽은 `minRarity` 를 무시하고 같은 카테고리의 서사 미만 최고 희귀도로 내린다
         (티어 4 「서사 이상 귀중품」 → 희귀 귀중품). 하한을 지키면 후보가 서사 이상뿐이라 게이트가 무의미해진다. */
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
      /* 2026-09-15: 카테고리 축은 `lootCategoryOf` 다 — 표의 `grenade` 는 `ItemDef.grenade` 가 있는 아이템이고
         `gadget` 은 그 밖의 가젯이다 (`LootTables` 의 *루팅 카테고리 축*). */
      const d = this.pickDef(table, rng, (def) => lootCategoryOf(def) === cat, false, curve, planet, keep);
      /* 후보가 하나도 없는 카테고리는 **상자를 자르지 않는다** — 그 카테고리만 빼고 다시 뽑는다.
         예전에는 여기서 `break` 했고, 아무 아이템에도 안 맞는 유령 카테고리 한 줄이 상자를 한두 개로 잘라 먹었다.
         2026-09-16: 서사 이상 게이트에 걸렸는데 서사 미만 후보가 아예 없는 카테고리(열쇠 · 레코드)도 null 이라 같은 길로 간다 —
         이 상자에서는 그 카테고리를 빼고 다시 뽑으므로 개수는 그대로이고 그 물건만 절반으로 준다. */
      if (d) picks.push(d); else dead.add(cat);
    }

    // 2026-09-09: 행성 곡선으로 **등급만** 다시 매긴다 (계열 추첨 · 유니크는 그대로).
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
    return this.rollCorpseWithMax(type, rng, rogueWeaponId, null, null);
  }

  /**
   * `rollCorpse` 본체. `maxGrade` 는 행성의 등급 상한이고 null 이면 상한 없음 — rng 소모는 어느 쪽이든 같다.
   * 2026-09-13: `planet` (거점 보너스의 씨앗 표) · `opts` (스폰 거점 · 남은 수류탄) — 둘 다 팩션 표가 있는 적만 쓴다.
   * 결과는 (type, rng, weaponId, planet, opts) 의 순수 함수다 — 호스트 · 리플리카 · 드론 스캔 미리보기가 같은 값을 넘긴다.
   */
  private rollCorpseWithMax(
    type: EnemyType, rng: Random, rogueWeaponId: string | undefined, curve: PlanetGradeCurve | null,
    planet: PlanetId | null, opts?: CorpseLootOpts,
  ): ItemInstance[] {
    const maxGrade: WeaponGrade | null = curve?.maxGrade ?? null;
    /* 2026-09-16: 서사 이상 게이트 (`epicPlusMul`) — 행성이 없으면 1 이라 아래 모든 굴림의 rng 소비가 예전과 같다. */
    const keep = curve?.epicPlusMul ?? 1;
    const table = CORPSE_TABLE_MAP.get(type);
    if (!table) return [this.createItem('mat_bio_sample', 1)];
    const out: ItemInstance[] = [];
    /* 2026-09-13: 인간형 팩션 — 표에 줄이 없는 적(벌레 · rogue_boss · 네임드)은 둘 다 undefined 라 아래 분기에 안 들어간다. */
    const faction = FACTION_LOOT_MAP.get(type);
    const siteBonus = getFactionSiteBonus(type, opts?.site);

    for (const drop of table.drops) {
      /* 2026-09-16: 서사 이상 아이템 줄(열쇠 · 외계 유물 · 공중 드론 …)은 확률 자체에 게이트를 곱한다 — 내릴 후보가 없는 "그 물건" 줄이다. */
      const dropDef = ITEM_DEF_MAP.get(drop.defId);
      const chance = keep < 1 && dropDef && isEpicPlus(dropDef) ? drop.chance * keep : drop.chance;
      if (chance < 1 && !rng.chance(chance)) continue;
      if (!ITEM_DEF_MAP.has(drop.defId)) { console.warn(`[Loot] corpse table '${type}': unknown def '${drop.defId}'`); continue; }
      const qty = drop.qty[0] >= drop.qty[1] ? drop.qty[0] : rng.int(drop.qty[0], drop.qty[1]);
      out.push(this.createItem(drop.defId, qty));
    }

    if (table.weapon) {
      const base = WEAPON_DEF_MAP.get(rogueWeaponId ?? DEFAULT_ROGUE_WEAPON_ID) ?? WEAPON_DEF_MAP.get(DEFAULT_ROGUE_WEAPON_ID);
      if (base) {
        let weapon = base;
        /* 2026-09-13: 인간형 팩션은 등급을 **가중치**로 뽑는다 (`loot_factions.csv` 의 weaponGrades). 그 거점의 grades 줄이
           있으면 그 표가 통째로 대신한다 (전진기지 레이더). 보스의 균등 목록과는 같이 쓰지 않는다 (로더가 잡는다). */
        const factionGrades = siteBonus?.weaponGrades ?? faction?.weaponGrades;
        if (factionGrades && factionGrades.grades.length > 0) {
          const grade = rng.weighted(factionGrades.grades, (g) => factionGrades.weightOf[g] ?? 0);
          weapon = WEAPON_DEF_MAP.get(weaponIdForGrade(weaponFamilyOf(base), grade)) ?? base;
        } else if (table.weapon.grades && table.weapon.grades.length > 0) {
          weapon = WEAPON_DEF_MAP.get(weaponIdForGrade(weaponFamilyOf(base), rng.pick(table.weapon.grades))) ?? base;
        }
        // 2026-09-09: 앞쪽 행성에서는 보스가 떨구는 총도 그 행성의 최대 등급을 넘지 못한다 (rng 소모는 그대로).
        if (maxGrade !== null && !isUniqueWeapon(weapon) && gradeOf(weapon) > maxGrade) {
          weapon = WEAPON_DEF_MAP.get(weaponIdForGrade(weaponFamilyOf(weapon), maxGrade)) ?? weapon;
        }
        /* 2026-09-16: 서사 이상 게이트 — 상한 **뒤**에 건다 (상한으로 이미 III 가 된 총은 draw 를 안 쓴다). 걸리면 그 표의
           서사 미만 최고 등급 (없으면 등급 III 쪽 최고). */
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
          // 2026-09-16: 서사 이상 게이트 — 걸리면 같은 후보의 서사 미만 최고 희귀도에서 균등
          const pick = rolled ? gatePick(rolled, from, () => 1, rng, keep) : undefined;
          if (pick) out.push(this.createItem(pick.id, 1));
        }
      }
    }

    // Phase 6: bosses may carry one legendary unique (rolled last so earlier draws are unchanged) + a stack of its calibre
    // 2026-09-09: 유니크는 등급이 없어 곡선을 안 타므로 행성의 `uniqueMul` 로 확률 자체를 줄인다 (0 = 없음).
    // `rng.chance` 는 배수와 무관하게 draw 를 하나 쓰므로 planet 이 null 인 경로의 rng 소비는 그대로다.
    // 2026-09-16: 유니크는 전부 전설이라 서사 이상 게이트(`keep`)도 확률에 바로 곱한다 (draw 수는 그대로 하나).
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

    // Phase 9: a reading raider — one 서적 (rolled after the unique so earlier draws are unchanged)
    /* 2026-09-13 (서재 시리즈): 그 레이드 행성의 책 시리즈에서 권 가중치로 한 권 (`libraryBookPool` · `libraryVolumeWeight`).
       draw 수는 예전(chance + pick)과 같다 (chance + weighted). 행성이 null 이면 모든 책이 후보다. */
    if (table.book) {
      const pool = libraryBookPool(planet);
      if (pool.length > 0 && rng.chance(table.book.chance)) {
        // 2026-09-16: 서사 이상 게이트 (책은 지금 전부 고급이라 draw 를 안 쓴다 — 시리즈 희귀도가 바뀌어도 규칙이 산다)
        const book = gatePick(rng.weighted(pool, libraryVolumeWeight), pool, libraryVolumeWeight, rng, keep);
        if (book) out.push(this.createItem(book.id, 1));
      }
    }

    // Phase 12: a fried implant — one 망가진 임플란트 weighted by rarity (rolled last, so every earlier draw is unchanged)
    /* 2026-09-10: 이것도 **희귀도 추첨**이라 상자와 같은 배수를 건다 (`loot_corpse_rolls.csv` 의
       `implantWeights` 에 common..epic 이 다 있어 상자 표와 모양이 같다). 안 걸면 앞쪽 행성에서
       보스 시체가 희귀 임플란트의 우회로가 된다. 확률(`chance`) 자체는 그대로다 — 배수는 "무엇이
       나오나" 를 정하지 "몇 번 나오나" 를 정하지 않는다. `rng.weighted` 는 배수와 무관하게 draw 를
       하나 쓰므로 rng 소비도 그대로다. */
    if (table.implant && rng.chance(table.implant.chance)) {
      const w = planetRarityWeights(table.implant.weights, curve);
      const pool = IMPLANT_BROKEN_DEFS.filter((d) => (w[d.rarity] ?? 0) > 0);
      if (pool.length > 0) {
        // 2026-09-16: 서사 이상 게이트 — 걸리면 가중치가 있는 서사 미만 최고 희귀도(대개 희귀)의 망가진 임플란트
        const implant = gatePick(rng.weighted(pool, (d) => w[d.rarity] ?? 0), pool, (d) => w[d.rarity] ?? 0, rng, keep);
        if (implant) out.push(this.createItem(implant.id, 1));
      }
    }

    /* 2026-09-13: 인간형 팩션 — 방탄복 → 가방 → 회복 (희귀도 굴림) → 거점 보너스 → 남은 수류탄(굴림 없음).
       임플란트 뒤라 앞의 추첨은 안 움직이고, 표가 없는 적은 여기서 rng 를 한 번도 안 쓴다. */
    if (faction) this.rollFactionGear(faction, rng, curve, out);
    if (siteBonus) this.rollSiteBonusItems(siteBonus, rng, planet, out, keep);
    this.addCarriedGrenades(opts, out);

    /* 2026-09-11: 네임드 로그의 확정 드롭 — **맨 마지막**이라 앞의 추첨이 안 움직이고, 네임드가 아닌 적은
       이 분기에 들어오지도 않는다 (`warrior` / `rogue` / `rogue_boss` 의 고정 벡터 그대로).
       행성 곡선(`curve`)은 일부러 넘기지 않는다 — "최소 희귀 등급부터" 가 사용자 명세다.
       2026-09-16: 서사 이상 게이트(`keep`)만은 탄다 — 사용자 결정 「잠긴 방 말고 전부」 (등급 III 하한은 그대로 지킨다). */
    const named = NAMED_DROP_MAP.get(type);
    if (named) this.rollNamedDrop(named, rng, out, keep);

    out.sort((a, b) => this.area(b) - this.area(a));
    return out;
  }

  /**
   * 네임드 확정 드롭 하나. `chance` → 등급(가중) → 아이템 → 내구도 `NAMED_LOOT_DURABILITY_MIN..MAX` × 최대치.
   * 무기면 장전 탄약(`magFraction`, 없으면 0..탄창)과 그 탄종 한 스택(`ammoFraction`)이 따라온다.
   */
  private rollNamedDrop(drop: NamedDrop, rng: Random, out: ItemInstance[], keep = 1): void {
    /* 2026-09-16: 서사 이상 게이트 — item 줄(유니크 미니건)은 확률에 곱하고, weapon · armor 줄은 뽑힌 등급이 서사 이상이면
       `keep` 확률로 남기고 아니면 그 줄의 서사 미만 최고 등급(대개 III)으로 내린다. keep 1 이면 draw 가 예전과 같다. */
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
    /* 반올림이 범위 밖으로 새지 않게 [ceil(max × MIN), floor(max × MAX)] 로 자른다 — 저격소총 V(240)에서
       round(240 × 0.01) = 2 = 0.83 % 가 나오던 것. 최소 1. */
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

  /* ── appended (2026-09-09): 행성별 무기 등급 곡선 (`data/planet_loot.csv`) ───────────────────────── */

  /**
   * 행성의 등급 곡선을 적용한 상자 굴림. 무기가 나오는 **빈도**는 여전히 상자 티어(`weaponChance`)가 정하고,
   * 나온 무기의 **등급**만 그 행성의 곡선으로 다시 뽑는다 (계열 추첨은 그대로).
   * 등급이 없는 **유니크 무기**는 곡선 대신 `uniqueMul` 로 등장 가중치 자체가 줄고, 0 이면 후보에서 빠진다.
   *
   * 2026-09-10: **총기가 아닌 것들**(방탄복 · 가방 · 부착물 · 임플란트 · 소모품 · 재료 · 귀중품)에는
   * 그 행성의 `rareMul` · `epicMul` · `legMul` 이 걸린다 — 티어 표의 희귀도 가중치를 깎고 깎인 만큼
   * common · uncommon 으로 되돌려 총합을 유지한다 (`planetRarityWeights`). 총기 등급은 그 뒤 `regrade`
   * 가 g1..g5 로 덮어쓰므로 이 배수를 타지 않는다 — 두 축은 일부러 별개다.
   *
   * `planet` 이 null 이거나 표에 없는 행성이면 `rollCrate` 와 완전히 같다.
   */
  rollCrateOn(tier: number, rng: Random, planet: PlanetId | null, opts?: CrateLootOpts): ItemInstance[] {
    // 2026-09-13: 행성은 서재 매체 · 게임기 · 게임 디스크의 후보도 거른다 (`LootTables.isLootableOnPlanet`).
    const curve = this.curveFor(planet);
    /* 2026-09-16: 서사 이상 게이트 — 연구실 잠긴 방(`opts.lockedRoom`)만 면제라 그 굴림은 예전과 비트 단위로 같다
       (행성 곡선 · 희귀도 배수는 그대로 탄다). 사용자 결정 「잠긴 방은 지금 그대로, 나머지는 서사 이상 절반」. */
    const keep = opts?.lockedRoom ? 1 : (curve?.epicPlusMul ?? 1);
    return this.rollCrateWithCurve(tier, rng, curve, planet, keep);
  }

  /**
   * 행성의 등급 **상한**을 적용한 시체 굴림. 그 외에는 `rollCorpse` 와 같다 — 보스가 III/IV 를 떨구는 규칙은
   * 그대로이고 상한을 넘는 등급만 상한으로 내려온다. 등급이 없는 **유니크**는 보스 굴림의 확률에
   * `uniqueMul` 이 곱해진다 (0 인 행성에서는 보스도 유니크를 떨구지 않는다).
   *
   * 2026-09-10: 시체에서 **희귀도로 뽑는 것은 망가진 임플란트 하나뿐**이고 거기에 `rareMul` · `epicMul` ·
   * `legMul` 이 걸린다. 나머지 시체 드랍(`loot_corpses.csv`)은 "이 적이 이 물건을 들고 있었나" 라는
   * 아이템별 확률이지 희귀도 추첨이 아니고, 보스 부착물은 `maxRarity` 로 자른 뒤 **균등**하게 뽑는다 —
   * 둘 다 배수를 걸 자리가 없다 (csv 에서 확률을 직접 고치는 쪽이 맞다).
   */
  rollCorpseOn(type: EnemyType, rng: Random, rogueWeaponId: string | undefined, planet: PlanetId | null, opts?: CorpseLootOpts): ItemInstance[] {
    // 2026-09-13: `opts` = 스폰 거점(거점 보너스) · 남은 수류탄(그대로 시체에). 생략하면 거점 보너스 · 수류탄만 없다.
    return this.rollCorpseWithMax(type, rng, rogueWeaponId, this.curveFor(planet), planet, opts);
  }

  /* ── appended (2026-09-13): 인간형 팩션 전리품 (`data/loot_factions.csv` · `loot_faction_sites.csv`) ───────── */

  /**
   * 방탄복 → 가방 → 회복. 방탄복 · 가방은 총처럼 낡은 것만 떨어진다 (`gearDurability` × 최대치, 최소 1).
   * 희귀도 가중치에는 그 행성의 `rareMul` · `epicMul` · `legMul` 이 걸린다 (상자 · 망가진 임플란트와 같은 규칙).
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

  /** `chance` → 희귀도(가중, 행성 배수) → 그 희귀도의 후보 중 균등. 안 들고 있으면 null. */
  private rollRarityPick(pick: CorpseRarityPick, rng: Random, curve: PlanetGradeCurve | null): string | null {
    if (!rng.chance(pick.chance)) return null;
    const w = planetRarityWeights(pick.weights, curve);
    const rarities = pick.rarities.filter((q) => (w[q] ?? 0) > 0);
    if (rarities.length === 0) return null;
    let rarity = rng.weighted(rarities, (q) => w[q] ?? 0);
    /* 2026-09-16: 서사 이상 게이트 — 걸리면 이 줄의 서사 미만 최고 희귀도 (`rarities` 는 common → legendary 순). 없으면 빈손. */
    const keep = curve?.epicPlusMul ?? 1;
    if (keep < 1 && rarityRank(rarity) >= EPIC_RANK && !rng.chance(keep)) {
      const lower = rarities.filter((q) => rarityRank(q) < EPIC_RANK);
      if (lower.length === 0) return null;
      rarity = lower[lower.length - 1];
    }
    const ids = pick.byRarity.get(rarity);
    return ids && ids.length > 0 ? rng.pick(ids) : null;
  }

  /** 거점 보너스의 아이템 줄 (csv 순서). `seed` 는 그 레이드 행성의 야생 씨앗 표에서 고른다. 은퇴한 아이템은 건너뛴다. */
  private rollSiteBonusItems(bonus: FactionSiteBonus, rng: Random, planet: PlanetId | null, out: ItemInstance[], keep = 1): void {
    for (const it of bonus.items) {
      /* 2026-09-16: 서사 이상 게이트 — item 줄은 확률에 곱하고, seed 줄은 뽑힌 씨앗이 서사 이상이면 그 표의 서사 미만 최고 희귀도로. */
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
   * 던지지 못하고 남은 수류탄 — 종류 · 개수 그대로 (굴림 없음, rng 를 안 쓴다). 개수는 한 스택(`stackMax`)으로 자른다
   * (`createItem` 이 자른다 — 와이어에서 온 값이 커도 시체가 수류탄 창고가 되지 않는다). 모르는 종류는 버린다.
   */
  private addCarriedGrenades(opts: CorpseLootOpts | undefined, out: ItemInstance[]): void {
    const g = opts?.grenades;
    if (!g || !Number.isFinite(g.count) || g.count < 1) return;
    const id = Object.prototype.hasOwnProperty.call(ENEMY_GRENADE_ITEM, g.kind) ? ENEMY_GRENADE_ITEM[g.kind] : undefined;
    if (id && ITEM_DEF_MAP.has(id)) out.push(this.createItem(id, g.count));
  }

  /** 행성 id → 난이도 순번(`planetTier`) → 등급 곡선. 행성이 없으면 null (예전 동작). */
  private curveFor(planet: PlanetId | null): PlanetGradeCurve | null {
    return planet == null ? null : getPlanetGradeCurve(planetTier(planet));
  }

  /**
   * 무기 아이템 하나를 행성 곡선의 등급으로 다시 매긴다. 무기가 아니거나 유니크(등급 없음)면 그대로 돌려준다.
   * 계열은 유지하므로 "무슨 총이 나왔나" 는 안 바뀌고 "몇 등급이냐" 만 바뀐다.
   */
  private regrade(def: ItemDef, curve: PlanetGradeCurve, rng: Random, keep = 1): ItemDef {
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
      if (curve.uniqueMul >= 1 || rng.chance(curve.uniqueMul)) {
        /* 2026-09-16: 살아남은 유니크(전설)도 서사 이상 게이트를 탄다 — 걸리면 무작위 계열의 서사 미만 최고 등급 총. */
        if (keep >= 1 || !isEpicPlus(def) || rng.chance(keep)) return def;
        const fallback = rng.pick(WEAPON_FAMILIES);
        return ITEM_DEF_MAP.get(itemIdForWeapon(weaponIdForGrade(fallback, this.bestGradeBelowEpic(fallback, curve.grades)))) ?? def;
      }
      family = rng.pick(WEAPON_FAMILIES);
    }
    const grade = rng.weighted(curve.grades, (g) => curve.weightOf[g] ?? 0);
    const graded = ITEM_DEF_MAP.get(itemIdForWeapon(weaponIdForGrade(family, grade))) ?? def;
    /* 2026-09-16: 곡선이 뽑은 등급이 서사 이상(IV · V)이면 게이트 — 걸리면 곡선에 있는 서사 미만 최고 등급(III). */
    if (keep >= 1 || !isEpicPlus(graded) || rng.chance(keep)) return graded;
    return ITEM_DEF_MAP.get(itemIdForWeapon(weaponIdForGrade(family, this.bestGradeBelowEpic(family, curve.grades)))) ?? graded;
  }

  /**
   * 2026-09-16: 계열 `family` 에서 서사 미만인 가장 높은 등급 — `grades`(곡선 · 표의 등급 목록) 안에서 먼저, 없으면 I..V 전체에서.
   * 서사 이상 게이트에 걸린 총이 내려앉는 자리다 (지금 데이터로는 늘 III).
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
    /** 2026-09-16: 서사 이상 게이트의 남길 확률 (1 = 게이트 없음) · 내려앉을 후보 묶음 (생략 = `filter`). */
    keep = 1, pool?: (d: ItemDef) => boolean,
  ): ItemDef | null {
    /* 2026-09-13: 은퇴한 아이템은 어떤 굴림(확정 · 무기 · 카테고리 · relaxRarity 폴백)에서도 후보가 아니다.
       같은 날(서재 시리즈): 행성에 묶인 아이템(서재 매체 · 게임기 · 게임 디스크)은 그 행성의 것만 후보다. */
    const all = ITEM_DEFS.filter((d) => isLootableDef(d) && isLootableOnPlanet(d, planet) && filter(d));
    /* 유니크가 봉인된 행성에서는 후보에서 아예 뺀다 — 가중치만 0 으로 두면 `relaxRarity` 폴백이 도로 집어 온다
       (티어 5 처럼 등급 무기가 전부 0 인 표에서 실제로 일어난다). curve 가 null 이면 후보가 그대로다. */
    const candidates = curve ? all.filter((d) => this.curveMul(curve, d) > 0) : all;
    if (candidates.length === 0) return null;
    /* 2026-09-10: 행성의 `rareMul` · `epicMul` · `legMul` 을 여기 한 곳에서 건다 — 상자의 희귀도 굴림은
       확정 픽 · 무기 픽 · 카테고리 픽이 전부 이 함수를 지난다. 배수가 1 이면 `table.rarityWeights` 를
       그대로(같은 객체로) 돌려받으므로 그 행성의 결과는 예전과 비트 단위로 같다. */
    const rarityWeights = planetRarityWeights(table.rarityWeights, curve);
    /* 2026-09-13: 서재 매체는 권 가중치를 곱한다 (뒤 권일수록 드물다 — 서재 매체가 아니면 1). */
    const weightOf = (d: ItemDef): number => rarityWeights[d.rarity] * this.weightMul(table, d) * this.curveMul(curve, d) * libraryVolumeWeight(d);
    const weighted = candidates.filter((d) => weightOf(d) > 0);
    let picked: ItemDef;
    if (weighted.length > 0) picked = rng.weighted(weighted, weightOf);
    else if (relaxRarity) picked = rng.weighted(candidates, (d) => 1 / (1 + rarityRank(d.rarity)));
    else return null;
    /* 2026-09-16: 서사 이상 게이트 — 확정 · 무기 · 카테고리 · relaxRarity 폴백 픽이 전부 여기를 지난다. 행성 곡선이 있으면
       총은 `regrade` 가 등급을 다시 뽑으므로 거기서 건다 (여기서 걸면 덮어쓰일 draw 만 는다). */
    if (keep >= 1 || !isEpicPlus(picked) || (curve && isWeaponItemDef(picked)) || rng.chance(keep)) return picked;
    const lower = ITEM_DEFS.filter((d) => !isEpicPlus(d) && isLootableDef(d) && isLootableOnPlanet(d, planet)
      && this.curveMul(curve, d) > 0 && (pool ?? filter)(d));
    /* 같은 가중치 규칙(표 희귀도 · 아이템 배수 · 권 가중치)에서 양수인 서사 미만 최고 희귀도 → 가중 추첨. 그런 후보가 없는데
       원래 픽이 폴백이었으면 폴백 규칙대로(가중치 무시) 최고 희귀도에서 균등. 둘 다 없으면 null (그 픽은 없던 것). */
    const lowerWeighted = topRarity(lower.filter((d) => weightOf(d) > 0));
    if (lowerWeighted.length > 0) return rng.weighted(lowerWeighted, weightOf);
    if (relaxRarity && lower.length > 0) return rng.pick(topRarity(lower));
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
