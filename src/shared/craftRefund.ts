/**
 * src/shared/craftRefund.ts — **the craft material refund** (2026-09-16, user's decision).
 *
 * > 「Changed so that the related skill is not involved in item crafting at all (cooking, research, every
 * >  craft-related thing). All the skill is involved in is the chance of getting some material items back when
 * >  crafting, and how much comes back.」
 *
 * So a skill no longer decides **what can be made** (the old `skillRequired` gate) nor **how fast it is made**
 * (the old `craftSpeedMul`). Its one remaining role is this file — how much of the consumed material comes back.
 *
 * **One roll per material unit** (user's decision). The chance is **linear** from 0 at skill 0 to
 * `CRAFT_REFUND_CHANCE_AT_MAX` (`data/tuning.csv`) at `SKILL_LEVEL_MAX`, and rolling each unit on its own makes
 * a bigger recipe felt more and spreads the results naturally (one roll per recipe would only ever be
 * 「it came back / it did not」, so a sniper rifle costing 35 scrap and ammo costing 1 powder would feel the same).
 *
 * ⚠ **Durable gear (weapons · armor · bags · durable gadgets) is not refundable** — the judgement is
 * `items/Salvage.isCraftRefundable`. Their repair cost and salvage yield come out of exactly these craft
 * materials (`data/README.md` 「Gear value lives in recipes.csv」), so if crafting alone got cheaper
 * 「craft → salvage」 could become a profit. `items/Salvage.checkSalvageEconomy()` checks it **at max skill**
 * (`npm run data:check`).
 *
 * Pure calculation only — paying it out (bag → stash → ground) and the toast are the caller's job
 * (`inventory/parts/Crafting`).
 */
import { SKILL_LEVEL_MAX } from './constants';
import { keyTable } from './data/tables';
import type { CraftIngredient } from './gear';

const T = /* data/tuning.csv */ keyTable('tuning.csv');

/** Chance that **one material unit** comes back at skill `SKILL_LEVEL_MAX`. Linear from 0 at skill 0 up to this value. */
export const CRAFT_REFUND_CHANCE_AT_MAX = T.num('CRAFT_REFUND_CHANCE_AT_MAX');

/** Chance that one material unit comes back at this skill level (0 … `CRAFT_REFUND_CHANCE_AT_MAX`). */
export function craftRefundChance(skillLevel: number): number {
  const lv = Number.isFinite(skillLevel) ? Math.max(0, Math.min(SKILL_LEVEL_MAX, skillLevel)) : 0;
  return CRAFT_REFUND_CHANCE_AT_MAX * (lv / Math.max(1, SKILL_LEVEL_MAX));
}

/**
 * **Expected-value multiplier** for 「one craft costs this much less material」 (0 … 1). The economy check
 * (`checkSalvageEconomy`) uses it at max skill — infinite profit is judged by the expected value over repetition,
 * not by one lucky roll.
 */
export function craftCostFactor(skillLevel: number): number {
  return Math.max(0, 1 - craftRefundChance(skillLevel));
}

/**
 * What comes back, rolled **per unit** of the consumed materials. `costs` is one run's real consumption (after
 * the workshop discount), `runs` the number of crafts. Empty when nothing came back. `rng` is for smokes /
 * tests (omitted = `Math.random`).
 */
export function rollCraftRefund(
  costs: readonly CraftIngredient[], runs: number, skillLevel: number, rng: () => number = Math.random,
): CraftIngredient[] {
  const chance = craftRefundChance(skillLevel);
  const n = Number.isFinite(runs) ? Math.max(1, Math.floor(runs)) : 1;
  if (!(chance > 0)) return [];
  const back = new Map<string, number>();
  for (const c of costs) {
    const units = Math.max(0, Math.floor(c.qty)) * n;
    let hit = 0;
    for (let i = 0; i < units; i++) if (rng() < chance) hit++;
    if (hit > 0) back.set(c.defId, (back.get(c.defId) ?? 0) + hit);
  }
  return [...back].map(([defId, qty]) => ({ defId, qty }));
}
