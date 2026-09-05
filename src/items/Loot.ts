import type { EffectiveWeaponStats, ItemDef, ItemInstance, ItemInstanceExtras, LootRef, WeaponDef } from '@/shared';
import { Random } from '@/shared';
import { ITEM_DEFS, ITEM_DEF_MAP, isWeaponItemDef, itemIdForWeapon, rarityRank } from './ItemDefs';
import { WEAPON_DEF_MAP, weaponFamilyOf } from './WeaponDefs';
import { canAttach as canAttachDef, computeWeaponStats, repairCost } from './WeaponStats';
import { getTierTable, type TierTable } from './LootTables';

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
      if (extras?.sockets) inst.sockets = extras.sockets;
      const stats = computeWeaponStats(weapon, inst);
      inst.durability = extras?.durability ?? stats.maxDurability;
      inst.ammoInMag = extras?.ammoInMag ?? stats.magSize;
    } else if (extras) {
      if (extras.durability !== undefined) inst.durability = extras.durability;
      if (extras.ammoInMag !== undefined) inst.ammoInMag = extras.ammoInMag;
      if (extras.sockets) inst.sockets = extras.sockets;
    }
    return inst;
  }

  /** Graded + socketed stats. Accepts an instance, a weapon def id (`ar23_g3`) or a weapon item id (`wpn_ar23_g3`). */
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
    const table = getTierTable(tier);
    const count = rng.int(table.count[0], table.count[1]);
    const picks: ItemDef[] = [];

    for (const g of table.guaranteed) {
      const d = this.pickDef(table, rng, (def) => g.categories.includes(def.category) && rarityRank(def.rarity) >= rarityRank(g.minRarity), true);
      if (d) picks.push(d);
    }

    // decide once per crate whether a weapon is included (guaranteed rolls may already have one)
    let weaponPending = !picks.some(isWeaponItemDef)
      && table.weaponChance > 0 && rng.chance(table.weaponChance);
    while (picks.length < count) {
      if (weaponPending) {
        weaponPending = false;
        const d = this.pickDef(table, rng, isWeaponItemDef, true);
        if (d) { picks.push(d); continue; }
      }
      const hasBag = picks.some((d) => d.category === 'bag');
      const cats = (Object.keys(table.categoryWeights) as Array<keyof typeof table.categoryWeights>)
        .filter((c) => !(hasBag && c === 'bag'));
      const cat = rng.weighted(cats, (c) => table.categoryWeights[c] ?? 0);
      const d = this.pickDef(table, rng, (def) => def.category === cat, false);
      if (d) picks.push(d); else break;
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
      if (qty > 0) out.push(this.createItem(def.id, qty));
    }
    out.sort((a, b) => this.area(b) - this.area(a));
    return out;
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
  private pickDef(table: TierTable, rng: Random, filter: (d: ItemDef) => boolean, relaxRarity: boolean): ItemDef | null {
    const candidates = ITEM_DEFS.filter(filter);
    if (candidates.length === 0) return null;
    const weightOf = (d: ItemDef): number => table.rarityWeights[d.rarity] * this.weightMul(table, d);
    const weighted = candidates.filter((d) => weightOf(d) > 0);
    if (weighted.length > 0) return rng.weighted(weighted, weightOf);
    if (relaxRarity) return rng.weighted(candidates, (d) => 1 / (1 + rarityRank(d.rarity)));
    return null;
  }
}
