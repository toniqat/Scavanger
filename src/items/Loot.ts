import type { ItemDef, ItemInstance, LootRef, WeaponDef } from '@/shared';
import { Random } from '@/shared';
import { ITEM_DEFS, ITEM_DEF_MAP, rarityRank } from './ItemDefs';
import { WEAPON_DEF_MAP } from './WeaponDefs';
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

  createItem(defId: string, qty = 1): ItemInstance {
    const def = ITEM_DEF_MAP.get(defId);
    if (!def) throw new Error(`[Loot] unknown item def '${defId}'`);
    return { uid: nextUid(), defId, qty: Math.max(1, Math.min(def.stackMax, Math.floor(qty))), rotated: false };
  }

  /**
   * Roll crate contents for a tier. Deterministic for a given `rng`. Same-def
   * stackables are merged (respecting stackMax); result sorted largest-first so
   * container auto-placement fragments less.
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
    let weaponPending = !picks.some((d) => d.category === 'primary' || d.category === 'secondary')
      && table.weaponChance > 0 && rng.chance(table.weaponChance);
    while (picks.length < count) {
      if (weaponPending) {
        weaponPending = false;
        const d = this.pickDef(table, rng, (def) => def.category === 'primary' || def.category === 'secondary', true);
        if (d) { picks.push(d); continue; }
      }
      const cats = Object.keys(table.categoryWeights) as Array<keyof typeof table.categoryWeights>;
      const cat = rng.weighted(cats, (c) => table.categoryWeights[c] ?? 0);
      const d = this.pickDef(table, rng, (def) => def.category === cat, false);
      if (d) picks.push(d); else break;
    }

    // materialise + merge stacks
    const out: ItemInstance[] = [];
    for (const def of picks) {
      let qty = 1;
      if (def.stackMax > 1) qty = rng.int(1, Math.min(def.stackMax, table.maxStackQty));
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

  private area(it: ItemInstance): number {
    const d = ITEM_DEF_MAP.get(it.defId);
    return d ? d.width * d.height : 0;
  }

  /**
   * Weighted pick among defs matching `filter`. When `relaxRarity` is true and no
   * candidate has a positive weight in the table, fall back to uniform choice so
   * guaranteed rolls always resolve.
   */
  private pickDef(table: TierTable, rng: Random, filter: (d: ItemDef) => boolean, relaxRarity: boolean): ItemDef | null {
    const candidates = ITEM_DEFS.filter(filter);
    if (candidates.length === 0) return null;
    const weighted = candidates.filter((d) => table.rarityWeights[d.rarity] > 0);
    if (weighted.length > 0) return rng.weighted(weighted, (d) => table.rarityWeights[d.rarity]);
    if (relaxRarity) return rng.weighted(candidates, (d) => 1 / (1 + rarityRank(d.rarity)));
    return null;
  }
}
