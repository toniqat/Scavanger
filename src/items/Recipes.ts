import type { CraftRecipe } from '@/shared';
import { CRAFT_DEFAULT_TIME } from '@/shared';

/**
 * Field crafting recipes (`ctx.loot.getAllRecipes()`); `inventory/` filters by station and by the
 * player's skill level. Three chains:
 *
 *  1. **탄약 분해** — an ammo pack breaks down into 화약 (`mat_gunpowder`).
 *  2. **탄약 제작** — 화약 + 폐금속/합금 makes the ammo pack you actually need.
 *  3. **의약** — gathered herbs (`herb`) become stims; the 의학 skill gates the good ones.
 *
 * `station: 'field'` recipes also work on the ship; `'ship'` recipes need the workbench.
 */
export const CRAFT_RECIPES: readonly CraftRecipe[] = [
  /* ── 1. ammo → gunpowder ─────────────────────────────────────────────── */
  {
    id: 'break_ammo_rifle', name: '소총탄 분해', station: 'field',
    inputs: [{ defId: 'ammo_rifle', qty: 1 }], outputDefId: 'mat_gunpowder', outputQty: 6,
    duration: 2, skill: 'crafting', skillRequired: 0,
    description: '소총 탄약 팩을 분해해 화약 6을 얻는다.',
  },
  {
    id: 'break_ammo_pistol', name: '권총탄 분해', station: 'field',
    inputs: [{ defId: 'ammo_pistol', qty: 1 }], outputDefId: 'mat_gunpowder', outputQty: 4,
    duration: 2, skill: 'crafting', skillRequired: 0,
    description: '권총 탄약 팩을 분해해 화약 4를 얻는다.',
  },
  {
    id: 'break_ammo_shotgun', name: '산탄 분해', station: 'field',
    inputs: [{ defId: 'ammo_shotgun', qty: 1 }], outputDefId: 'mat_gunpowder', outputQty: 5,
    duration: 2, skill: 'crafting', skillRequired: 0,
    description: '산탄 팩을 분해해 화약 5를 얻는다.',
  },

  /* ── 2. gunpowder → the ammo you need ────────────────────────────────── */
  {
    id: 'make_ammo_rifle', name: '소총 탄약 팩 제작', station: 'field',
    inputs: [{ defId: 'mat_gunpowder', qty: 6 }, { defId: 'mat_scrap', qty: 2 }],
    outputDefId: 'ammo_rifle', outputQty: 1,
    duration: CRAFT_DEFAULT_TIME, skill: 'crafting', skillRequired: 0,
    description: '화약 6 + 폐금속 2 → 소총 탄약 팩.',
  },
  {
    id: 'make_ammo_pistol', name: '권총 탄약 팩 제작', station: 'field',
    inputs: [{ defId: 'mat_gunpowder', qty: 4 }, { defId: 'mat_scrap', qty: 1 }],
    outputDefId: 'ammo_pistol', outputQty: 1,
    duration: CRAFT_DEFAULT_TIME, skill: 'crafting', skillRequired: 0,
    description: '화약 4 + 폐금속 1 → 권총 탄약 팩.',
  },
  {
    id: 'make_ammo_shotgun', name: '산탄 팩 제작', station: 'field',
    inputs: [{ defId: 'mat_gunpowder', qty: 5 }, { defId: 'mat_scrap', qty: 2 }],
    outputDefId: 'ammo_shotgun', outputQty: 1,
    duration: CRAFT_DEFAULT_TIME, skill: 'crafting', skillRequired: 0,
    description: '화약 5 + 폐금속 2 → 산탄 팩.',
  },
  {
    id: 'make_ammo_energy', name: '에너지 셀 충전', station: 'field',
    inputs: [{ defId: 'mat_power_cell', qty: 1 }, { defId: 'mat_alloy', qty: 1 }],
    outputDefId: 'ammo_energy', outputQty: 1,
    duration: 4, skill: 'crafting', skillRequired: 20,
    description: '파워 셀 1 + 합금 판 1 → 에너지 셀. 제작 20 필요.',
  },

  /* ── 3. crafted ordnance / gadgets ───────────────────────────────────── */
  {
    id: 'make_smoke', name: '연막탄 제작', station: 'field',
    inputs: [{ defId: 'mat_gunpowder', qty: 4 }, { defId: 'mat_bio_sample', qty: 2 }],
    outputDefId: 'gad_smoke', outputQty: 1,
    duration: 3.5, skill: 'crafting', skillRequired: 10,
    description: '화약 4 + 생체 조직 2 → 연막탄. 제작 10 필요.',
  },
  {
    id: 'make_incendiary', name: '소이 수류탄 제작', station: 'field',
    inputs: [{ defId: 'mat_gunpowder', qty: 8 }, { defId: 'herb_ashleaf', qty: 2 }],
    outputDefId: 'grenade_incendiary', outputQty: 1,
    duration: 4, skill: 'crafting', skillRequired: 15,
    description: '화약 8 + 잿빛잎 2 → 소이 수류탄. 제작 15 필요.',
  },
  {
    id: 'make_mine', name: '지뢰 제작', station: 'ship',
    inputs: [{ defId: 'mat_gunpowder', qty: 10 }, { defId: 'mat_alloy', qty: 2 }],
    outputDefId: 'gad_mine', outputQty: 1,
    duration: 5, skill: 'crafting', skillRequired: 35,
    description: '화약 10 + 합금 판 2 → 지뢰. 함선 작업대, 제작 35 필요.',
  },

  /* ── 4. herbs → medicine ─────────────────────────────────────────────── */
  {
    id: 'make_stim', name: '스팀 조제', station: 'field',
    inputs: [{ defId: 'herb_bloodroot', qty: 3 }, { defId: 'herb_ashleaf', qty: 1 }],
    outputDefId: 'stim', outputQty: 1,
    duration: 3, skill: 'medicine', skillRequired: 0,
    description: '혈근초 3 + 잿빛잎 1 → 스팀.',
  },
  {
    id: 'make_stim_advanced', name: '고급 스팀 조제', station: 'field',
    inputs: [{ defId: 'herb_bloodroot', qty: 4 }, { defId: 'herb_glowcap', qty: 2 }, { defId: 'herb_ashleaf', qty: 2 }],
    outputDefId: 'stim_advanced', outputQty: 1,
    duration: 5, skill: 'medicine', skillRequired: 25,
    description: '혈근초 4 + 발광버섯 2 + 잿빛잎 2 → 고급 스팀. 의학 25 필요.',
  },
  {
    id: 'make_defib_charge', name: '제세동기 정비', station: 'ship',
    inputs: [{ defId: 'mat_power_cell', qty: 2 }, { defId: 'herb_glowcap', qty: 1 }],
    outputDefId: 'gad_defib', outputQty: 1,
    duration: 6, skill: 'medicine', skillRequired: 40,
    description: '파워 셀 2 + 발광버섯 1 → 제세동기. 함선, 의학 40 필요.',
  },

  /* ── 5. gardening (ship hydroponics) ─────────────────────────────────── */
  {
    id: 'grow_bloodroot', name: '혈근초 증식', station: 'ship',
    inputs: [{ defId: 'herb_ashleaf', qty: 4 }], outputDefId: 'herb_bloodroot', outputQty: 6,
    duration: 4, skill: 'gardening', skillRequired: 0,
    description: '수경 재배기에서 잿빛잎 4로 혈근초 6을 길러낸다.',
  },
  {
    id: 'grow_glowcap', name: '발광버섯 배양', station: 'ship',
    inputs: [{ defId: 'herb_bloodroot', qty: 6 }, { defId: 'mat_bio_sample', qty: 3 }],
    outputDefId: 'herb_glowcap', outputQty: 2,
    duration: 6, skill: 'gardening', skillRequired: 20,
    description: '혈근초 6 + 생체 조직 3 → 발광버섯 2. 원예 20 필요.',
  },
];

export const CRAFT_RECIPE_MAP: ReadonlyMap<string, CraftRecipe> = new Map(CRAFT_RECIPES.map((r) => [r.id, r]));

export function getRecipe(id: string): CraftRecipe | undefined {
  return CRAFT_RECIPE_MAP.get(id);
}
