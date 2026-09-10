import {
  WEIGHT_BASE_CAPACITY, WEIGHT_HEAVY_MOVE_MUL, WEIGHT_HEAVY_RATIO, WEIGHT_HEAVY_STAMINA_MUL,
  WEIGHT_LIGHT_RATIO, WEIGHT_LIGHT_STAMINA_MUL, WEIGHT_OVER_RATIO,
  type ArmorDef, type ArmorPerk, type GameContext, type Rarity, type WeightInfo, type WeightState,
} from '@/shared';

/** Ultralight armor bonus when the def omits `perkValue` (fraction added to speed / stamina regen). */
const ULTRALIGHT_DEFAULT = 0.08;
/** Regenerating armor: hp per second at full stamina when the def omits `perkValue`. */
const REGEN_DEFAULT = 1;

/**
 * Cached view of the equipped armor / backpack and the carry weight.
 *
 * Everything is read through `ctx.inventory` / `ctx.loot` with optional chaining: the gear systems are built by
 * other agents and may not exist yet, in which case the player behaves exactly like before (no shield,
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

  /**
   * **항상 0 이다 (2026-09-10).** 방탄복은 더 이상 피해를 깎지 않는다 — 대신 `shieldMax` 만큼의 추가 체력
   * (실드)을 주고, 피해는 실드를 먼저 비운다 (`parts/Vitals.applyDamage`). `ArmorDef.damageReduction` 은
   * 유니크 방탄복의 실드량을 환산한 근거로만 남아 있고 아무도 읽지 않는다. 이 getter 와 `PlayerRef.damageReduction`
   * 은 **계약이라 지우지 않았을 뿐**이다 (`airstrike` · `secondary` 와 같은 처리).
   */
  get damageReduction(): number { return 0; }

  /**
   * 실드 최대치 = 장착한 방탄복의 `ArmorDef.shield`. 방탄복이 없거나 **내구도가 0(파손)** 이면 0 이다 —
   * 파손된 판은 실드를 세우지 못하고 충전기로도 못 채운다. 함선 작업대에서 수리하면 되살아난다.
   */
  get shieldMax(): number {
    if (!this.armor || this.armorBroken) return 0;
    return Math.max(0, this.armor.shield ?? 0);
  }
  /** 실드 게이지의 칸 색을 정하는 방탄복 등급 (없거나 파손이면 null). */
  get shieldRarity(): Rarity | null {
    return this.armor && !this.armorBroken ? this.armor.rarity : null;
  }
  /** 방탄복 tier (번호 방탄복 1..5, 유니크 0). 없거나 파손이면 0. */
  get shieldTier(): number {
    return this.armor && !this.armorBroken ? this.armor.tier : 0;
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
