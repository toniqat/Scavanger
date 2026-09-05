import {
  ARMOR_DR_BY_TIER, WEIGHT_BASE_CAPACITY, WEIGHT_HEAVY_MOVE_MUL, WEIGHT_HEAVY_RATIO, WEIGHT_HEAVY_STAMINA_MUL,
  WEIGHT_LIGHT_RATIO, WEIGHT_LIGHT_STAMINA_MUL, WEIGHT_OVER_RATIO,
  type ArmorDef, type ArmorPerk, type GameContext, type WeightInfo, type WeightState,
} from '@/shared';

/** Ultralight armor bonus when the def omits `perkValue` (fraction added to speed / stamina regen). */
const ULTRALIGHT_DEFAULT = 0.08;
/** Regenerating armor: hp per second at full stamina when the def omits `perkValue`. */
const REGEN_DEFAULT = 1;

/**
 * Cached view of the equipped armor / backpack and the carry weight.
 *
 * Everything is read through `ctx.inventory` / `ctx.loot` with optional chaining: the gear systems are built by
 * other agents and may not exist yet, in which case the player behaves exactly like before (no damage reduction,
 * no perks, weight state 'normal'). Refreshed lazily — on the gear/weight events PlayerSystem forwards through
 * `markDirty()` and, as a safety net, twice a second. No allocation per frame.
 */
export class PlayerGear {
  armor: ArmorDef | null = null;
  armorUid: string | null = null;
  armorBroken = false;
  /** Equipped bag is a tactical vest (`BagDef.tactical`): hold Space in the air to hover. */
  tacticalBag = false;
  /** Live weight budget (own object; never handed out to other systems). */
  readonly weight: WeightInfo = {
    weight: 0, capacity: WEIGHT_BASE_CAPACITY, ratio: 0, state: 'normal', moveMul: 1, staminaRegenMul: 1,
  };

  private dirty = true;
  private timer = 0;

  /** Damage reduction 0..0.9 granted by the equipped armor (0 while broken / unequipped). */
  get damageReduction(): number {
    if (!this.armor || this.armorBroken) return 0;
    const dr = typeof this.armor.damageReduction === 'number'
      ? this.armor.damageReduction
      : (ARMOR_DR_BY_TIER[this.armor.tier] ?? 0);
    return Math.max(0, Math.min(0.9, dr));
  }
  get armorPerk(): ArmorPerk { return this.armorBroken ? 'none' : (this.armor?.perk ?? 'none'); }
  /** Ultralight armor: fraction added to move speed and stamina regen (0 when not worn). */
  get ultralightBonus(): number {
    return this.armorPerk === 'ultralight' ? (this.armor?.perkValue ?? ULTRALIGHT_DEFAULT) : 0;
  }
  /** Regenerating armor: hp per second while stamina is full (0 when not worn). */
  get regenPerSecond(): number {
    return this.armorPerk === 'regen' ? (this.armor?.perkValue ?? REGEN_DEFAULT) : 0;
  }
  /** true when the equipped armor grants a permanent cloak (광학미채). */
  get opticalCamo(): boolean { return this.armorPerk === 'optical'; }
  /** Roll is denied from '무거움' upward; movement stops entirely at '과적'. */
  get rollBlocked(): boolean { return this.weight.state === 'heavy' || this.weight.state === 'over'; }
  get overloaded(): boolean { return this.weight.state === 'over'; }

  markDirty(): void { this.dirty = true; }

  /** Cheap per-frame tick; only re-reads the inventory when dirty or every 0.5 s. */
  update(dt: number, ctx: GameContext): void {
    this.timer -= dt;
    if (!this.dirty && this.timer > 0) return;
    this.timer = 0.5;
    this.dirty = false;
    this.refresh(ctx);
  }

  refresh(ctx: GameContext): void {
    const inv = ctx.inventory;
    const loot = ctx.loot;
    this.armor = null; this.armorUid = null; this.armorBroken = false;
    this.tacticalBag = false;

    if (inv && typeof inv.getEquipped === 'function') {
      const armorItem = inv.getEquipped('armor');
      if (armorItem) {
        this.armorUid = armorItem.uid;
        const def = inv.getDef?.(armorItem.defId);
        const armorId = def?.armorId;
        if (armorId && loot && typeof loot.getArmorDef === 'function') this.armor = loot.getArmorDef(armorId) ?? null;
        this.armorBroken = this.isBroken(ctx, armorItem.uid);
      }
      const bagItem = inv.getEquipped('bag');
      if (bagItem) this.tacticalBag = !!inv.getDef?.(bagItem.defId)?.bag?.tactical;
    }
    this.refreshWeight(ctx);
  }

  private isBroken(ctx: GameContext, uid: string): boolean {
    const inv = ctx.inventory;
    if (!inv || typeof inv.getDurability !== 'function') return false;
    const d = inv.getDurability(uid);
    return d ? d.broken || d.durability <= 0 : false;
  }

  private refreshWeight(ctx: GameContext): void {
    const w = this.weight;
    const src = ctx.inventory && typeof ctx.inventory.getWeight === 'function' ? ctx.inventory.getWeight() : null;
    if (!src) {
      w.weight = 0;
      w.capacity = ctx.progression?.derived.carryCapacity ?? WEIGHT_BASE_CAPACITY;
      w.ratio = 0; w.state = 'normal'; w.moveMul = 1; w.staminaRegenMul = 1;
      return;
    }
    w.weight = num(src.weight, 0);
    w.capacity = Math.max(1, num(src.capacity, ctx.progression?.derived.carryCapacity ?? WEIGHT_BASE_CAPACITY));
    w.ratio = num(src.ratio, w.weight / w.capacity);
    w.state = isState(src.state) ? src.state : stateFor(w.ratio);
    w.moveMul = num(src.moveMul, moveMulFor(w.state));
    w.staminaRegenMul = num(src.staminaRegenMul, staminaMulFor(w.state));
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function isState(v: unknown): v is WeightState {
  return v === 'normal' || v === 'light' || v === 'heavy' || v === 'over';
}
function stateFor(ratio: number): WeightState {
  if (ratio >= WEIGHT_OVER_RATIO) return 'over';
  if (ratio >= WEIGHT_HEAVY_RATIO) return 'heavy';
  if (ratio >= WEIGHT_LIGHT_RATIO) return 'light';
  return 'normal';
}
function moveMulFor(state: WeightState): number {
  return state === 'over' ? 0 : state === 'heavy' ? WEIGHT_HEAVY_MOVE_MUL : 1;
}
function staminaMulFor(state: WeightState): number {
  return state === 'over' ? 0 : state === 'heavy' ? WEIGHT_HEAVY_STAMINA_MUL : state === 'light' ? WEIGHT_LIGHT_STAMINA_MUL : 1;
}
