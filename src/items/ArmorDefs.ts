import type { ArmorDef } from '@/shared';
import { ARMOR_DR_BY_TIER } from '@/shared';

/**
 * Body armor (방탄복). Numbered I..V follow `ARMOR_DR_BY_TIER` exactly; the three uniques trade
 * damage reduction for a perk. `player/` reads `damageReduction` on every hit and wears the plate
 * down through `ctx.inventory.damageDurability`; a broken plate gives 0 DR.
 *
 * Weight is deliberately *not* proportional to the grid footprint — the heaviest plates cost more
 * of the carry budget than their cells suggest, and the ultralight vest is almost free.
 */
export const ARMOR_DEFS: readonly ArmorDef[] = [
  {
    id: 'armor_1', name: '방탄복 I', tier: 1, rarity: 'common',
    description: '경량 케블라 조끼. 파편을 겨우 막아준다.',
    damageReduction: ARMOR_DR_BY_TIER[1], weight: 3.0, durabilityMax: 200,
    perk: 'none', color: '#8e9299',
  },
  {
    id: 'armor_2', name: '방탄복 II', tier: 2, rarity: 'common',
    description: '표준 지급 방탄복. 전면에 세라믹 플레이트 한 장.',
    damageReduction: ARMOR_DR_BY_TIER[2], weight: 4.6, durabilityMax: 280,
    perk: 'none', color: '#93a08c',
  },
  {
    id: 'armor_3', name: '방탄복 III', tier: 3, rarity: 'uncommon',
    description: '전면·측면 플레이트 캐리어. 기동성과 방호의 절충안.',
    damageReduction: ARMOR_DR_BY_TIER[3], weight: 6.6, durabilityMax: 380,
    perk: 'none', color: '#6f9d72',
  },
  {
    id: 'armor_4', name: '방탄복 IV', tier: 4, rarity: 'rare',
    description: '중장갑 캐리어. 목·사타구니 보호대 포함.',
    damageReduction: ARMOR_DR_BY_TIER[4], weight: 9.2, durabilityMax: 480,
    perk: 'none', color: '#5b8fd6',
  },
  {
    id: 'armor_5', name: '방탄복 V', tier: 5, rarity: 'epic',
    description: '외골격 보조 중장갑. 무겁지만 대부분의 물기 공격을 견딘다.',
    damageReduction: ARMOR_DR_BY_TIER[5], weight: 12.4, durabilityMax: 600,
    perk: 'none', color: '#a877e8',
  },

  /* ── uniques ───────────────────────────────────────────────────────────── */
  {
    id: 'armor_regen', name: '재생 방탄복', tier: 0, rarity: 'legendary',
    description: '나노 섬유가 상처를 봉합한다. 스태미나가 가득할 때 초당 체력 1 회복.',
    damageReduction: 0.27, weight: 10.6, durabilityMax: 520,
    perk: 'regen', perkValue: 1, color: '#ff9f6b',
  },
  {
    id: 'armor_ultralight', name: '초경량 방탄복', tier: 0, rarity: 'legendary',
    description: '에어로젤 직물. 방호는 최소지만 스태미나 회복과 이동속도가 크게 오른다.',
    damageReduction: 0.10, weight: 1.9, durabilityMax: 300,
    perk: 'ultralight', perkValue: 0.18, color: '#ffe08a',
  },
  {
    id: 'armor_optical', name: '광학미채 방탄복', tier: 0, rarity: 'legendary',
    description: '적응형 광학 위장막. 상시 은폐 상태를 유지하지만 방호력은 형편없다.',
    damageReduction: 0.08, weight: 3.4, durabilityMax: 260,
    perk: 'optical', color: '#8fe8ff',
  },
];

export const ARMOR_DEF_MAP: ReadonlyMap<string, ArmorDef> = new Map(ARMOR_DEFS.map((a) => [a.id, a]));

export function getArmorDef(armorId: string): ArmorDef | undefined {
  return ARMOR_DEF_MAP.get(armorId);
}

/** Grid footprint of the carried (unequipped) plate. Heavy plates are bulky, the ultralight vest folds up. */
export function armorItemSize(def: ArmorDef): { width: number; height: number } {
  if (def.perk === 'ultralight') return { width: 2, height: 2 };
  if (def.perk === 'optical') return { width: 2, height: 2 };
  if (def.tier > 0 && def.tier <= 2) return { width: 2, height: 2 };
  return { width: 2, height: 3 };
}

/** Icon glyph per armor id (procedural text glyph, no asset files). */
export const ARMOR_ICON: Readonly<Record<string, string>> = {
  armor_1: '⛊', armor_2: '⛊', armor_3: '🛡', armor_4: '🛡', armor_5: '🛡',
  armor_regen: '✚', armor_ultralight: '❖', armor_optical: '◊',
};
