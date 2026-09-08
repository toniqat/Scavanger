import type { CraftRecipe } from '@/shared';
import { CRAFT_DEFAULT_TIME } from '@/shared';

/**
 * Crafting recipes (`ctx.loot.getAllRecipes()`); `inventory/` filters by station, bench and the
 * player's skill level. Chains:
 *
 *  1. **탄약 분해** — an ammo pack breaks down into 화약 (`mat_gunpowder`).
 *  2. **탄약 제작** — 화약 + 폐금속/합금 makes the ammo pack you actually need.
 *  3. **야전 병기** — smoke / incendiary grenades.
 *  4. **의약** — 천조각 / 캔 / 주사기 + 혈근초 become 붕대 · 소독약 · 회복주사 · 회복 스프레이; the 의학 skill gates the good ones.
 *  5. **원예** — ship hydroponics.
 *  6. **작업실 (Phase 6)** — `station: 'ship'` + `bench` (`gun` / `gear` / `gadget` / `medical`) at `benchLevel`
 *     or higher (`ctx.housing.getBenchLevel`): bulk ammo, attachments, unique-weapon ammo, armor / bags,
 *     grenade batches, medicine.
 *
 * `station: 'field'` recipes also work on the ship; `'ship'` recipes without `bench` work at any ship workbench.
 */
export const CRAFT_RECIPES: readonly CraftRecipe[] = [
  /* ── 1. ammo → gunpowder (ammo v2: qty = rounds) ───────────────────────── */
  {
    id: 'break_ammo_light', name: '경량탄 분해', station: 'field',
    inputs: [{ defId: 'ammo_light', qty: 30 }], outputDefId: 'mat_gunpowder', outputQty: 4,
    duration: 2, skill: 'crafting', skillRequired: 0,
    description: '경량탄 30발을 분해해 화약 4를 얻는다.',
  },
  {
    id: 'break_ammo_medium', name: '준중량탄 분해', station: 'field',
    inputs: [{ defId: 'ammo_medium', qty: 30 }], outputDefId: 'mat_gunpowder', outputQty: 6,
    duration: 2, skill: 'crafting', skillRequired: 0,
    description: '준중량탄 30발을 분해해 화약 6을 얻는다.',
  },
  {
    id: 'break_ammo_heavy', name: '중량탄 분해', station: 'field',
    inputs: [{ defId: 'ammo_heavy', qty: 10 }], outputDefId: 'mat_gunpowder', outputQty: 5,
    duration: 2, skill: 'crafting', skillRequired: 0,
    description: '중량탄 10발을 분해해 화약 5를 얻는다.',
  },
  {
    id: 'break_ammo_shell', name: '산탄 분해', station: 'field',
    inputs: [{ defId: 'ammo_shell', qty: 8 }], outputDefId: 'mat_gunpowder', outputQty: 5,
    duration: 2, skill: 'crafting', skillRequired: 0,
    description: '산탄 8발을 분해해 화약 5를 얻는다.',
  },

  /* ── 2. gunpowder → the rounds you need ──────────────────────────────── */
  {
    id: 'make_ammo_light', name: '경량탄 제작', station: 'field',
    inputs: [{ defId: 'mat_gunpowder', qty: 4 }, { defId: 'mat_scrap', qty: 1 }],
    outputDefId: 'ammo_light', outputQty: 30,
    duration: CRAFT_DEFAULT_TIME, skill: 'crafting', skillRequired: 0,
    description: '화약 4 + 폐금속 1 → 경량탄 30발.',
  },
  {
    id: 'make_ammo_medium', name: '준중량탄 제작', station: 'field',
    inputs: [{ defId: 'mat_gunpowder', qty: 6 }, { defId: 'mat_scrap', qty: 2 }],
    outputDefId: 'ammo_medium', outputQty: 30,
    duration: CRAFT_DEFAULT_TIME, skill: 'crafting', skillRequired: 0,
    description: '화약 6 + 폐금속 2 → 준중량탄 30발.',
  },
  {
    id: 'make_ammo_heavy', name: '중량탄 제작', station: 'field',
    inputs: [{ defId: 'mat_gunpowder', qty: 5 }, { defId: 'mat_alloy', qty: 1 }],
    outputDefId: 'ammo_heavy', outputQty: 10,
    duration: 4, skill: 'crafting', skillRequired: 20,
    description: '화약 5 + 합금 판 1 → 중량탄 10발. 제작 20 필요.',
  },
  {
    id: 'make_ammo_shell', name: '산탄 제작', station: 'field',
    inputs: [{ defId: 'mat_gunpowder', qty: 5 }, { defId: 'mat_scrap', qty: 2 }],
    outputDefId: 'ammo_shell', outputQty: 8,
    duration: CRAFT_DEFAULT_TIME, skill: 'crafting', skillRequired: 0,
    description: '화약 5 + 폐금속 2 → 산탄 8발.',
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
    id: 'make_mine', name: '지뢰 제작', station: 'ship', bench: 'gadget', benchLevel: 1,
    inputs: [{ defId: 'mat_gunpowder', qty: 10 }, { defId: 'mat_alloy', qty: 2 }],
    outputDefId: 'gad_mine', outputQty: 1,
    duration: 5, skill: 'crafting', skillRequired: 35,
    description: '화약 10 + 합금 판 2 → 지뢰. 가젯 작업대, 제작 35 필요.',
  },

  /* ── 4. herbs → medicine ─────────────────────────────────────────────── */
  /* 2026-09-07: 붕대 · 약초 붕대는 야전에서, 주사 계열은 의학 작업대에서. `약초` = 혈근초. */
  {
    id: 'make_bandage', name: '붕대 제작', station: 'field',
    inputs: [{ defId: 'mat_cloth', qty: 5 }],
    outputDefId: 'heal_bandage', outputQty: 1,
    duration: 3, skill: 'medicine', skillRequired: 0,
    description: '천조각 5 → 붕대.',
  },
  {
    id: 'make_bandage_herb', name: '약초 붕대 제작', station: 'field',
    inputs: [{ defId: 'mat_cloth', qty: 5 }, { defId: 'herb_bloodroot', qty: 1 }],
    outputDefId: 'heal_bandage_herb', outputQty: 1,
    duration: 4, skill: 'medicine', skillRequired: 0,
    description: '천조각 5 + 혈근초 1 → 약초 붕대.',
  },
  {
    id: 'make_antiseptic', name: '소독약 조제', station: 'ship', bench: 'medical', benchLevel: 1,
    inputs: [{ defId: 'mat_can', qty: 1 }, { defId: 'herb_bloodroot', qty: 1 }],
    outputDefId: 'mat_antiseptic', outputQty: 1,
    duration: 4, skill: 'medicine', skillRequired: 10,
    description: '캔 1 + 혈근초 1 → 소독약. 의학 작업대.',
  },
  {
    id: 'make_heal_syringe', name: '회복주사 조제', station: 'ship', bench: 'medical', benchLevel: 1,
    inputs: [{ defId: 'mat_syringe', qty: 1 }, { defId: 'mat_antiseptic', qty: 1 }],
    outputDefId: 'heal_syringe', outputQty: 1,
    duration: 5, skill: 'medicine', skillRequired: 25,
    description: '주사기 1 + 소독약 1 → 회복주사. 의학 작업대, 의학 25 필요.',
  },
  {
    id: 'make_heal_spray', name: '회복 스프레이 제작', station: 'ship', bench: 'medical', benchLevel: 2,
    inputs: [{ defId: 'mat_can', qty: 1 }, { defId: 'mat_antiseptic', qty: 1 }],
    outputDefId: 'heal_spray', outputQty: 1,
    duration: 8, skill: 'medicine', skillRequired: 45,
    description: '캔 1 + 소독약 1 → 회복 스프레이. 의학 작업대 Lv.2, 의학 45 필요.',
  },
  {
    id: 'make_defib_charge', name: '제세동기 정비', station: 'ship', bench: 'gadget', benchLevel: 2,
    inputs: [{ defId: 'mat_power_cell', qty: 2 }, { defId: 'herb_glowcap', qty: 1 }],
    outputDefId: 'gad_defib', outputQty: 1,
    duration: 6, skill: 'medicine', skillRequired: 40,
    description: '파워 셀 2 + 발광버섯 1 → 제세동기. 가젯 작업대 Lv.2, 의학 40 필요.',
  },

  /* ── 5. gardening (ship hydroponics → 의학 작업대) ───────────────────── */
  {
    id: 'grow_bloodroot', name: '혈근초 증식', station: 'ship', bench: 'medical', benchLevel: 1,
    inputs: [{ defId: 'herb_ashleaf', qty: 4 }], outputDefId: 'herb_bloodroot', outputQty: 6,
    duration: 4, skill: 'gardening', skillRequired: 0,
    description: '수경 재배기에서 잿빛잎 4로 혈근초 6을 길러낸다. 의학 작업대.',
  },
  {
    id: 'grow_glowcap', name: '발광버섯 배양', station: 'ship', bench: 'medical', benchLevel: 2,
    inputs: [{ defId: 'herb_bloodroot', qty: 6 }, { defId: 'mat_bio_sample', qty: 3 }],
    outputDefId: 'herb_glowcap', outputQty: 2,
    duration: 6, skill: 'gardening', skillRequired: 20,
    description: '혈근초 6 + 생체 조직 3 → 발광버섯 2. 의학 작업대 Lv.2, 원예 20 필요.',
  },

  /* ══ 6. 작업실 (Phase 6) ═══════════════════════════════════════════════ */
  /* ── 6-a. 총기 작업대 Lv.1: bulk ammo (a full stack per craft, ~15 % cheaper than the field packs) ── */
  {
    id: 'bulk_ammo_light', name: '경량탄 대량 제작', station: 'ship', bench: 'gun', benchLevel: 1,
    inputs: [{ defId: 'mat_gunpowder', qty: 14 }, { defId: 'mat_scrap', qty: 3 }],
    outputDefId: 'ammo_light', outputQty: 120,
    duration: 6, skill: 'crafting', skillRequired: 0,
    description: '화약 14 + 폐금속 3 → 경량탄 120발. 총기 작업대.',
  },
  {
    id: 'bulk_ammo_medium', name: '준중량탄 대량 제작', station: 'ship', bench: 'gun', benchLevel: 1,
    inputs: [{ defId: 'mat_gunpowder', qty: 16 }, { defId: 'mat_scrap', qty: 5 }],
    outputDefId: 'ammo_medium', outputQty: 90,
    duration: 6, skill: 'crafting', skillRequired: 0,
    description: '화약 16 + 폐금속 5 → 준중량탄 90발. 총기 작업대.',
  },
  {
    id: 'bulk_ammo_heavy', name: '중량탄 대량 제작', station: 'ship', bench: 'gun', benchLevel: 1,
    inputs: [{ defId: 'mat_gunpowder', qty: 13 }, { defId: 'mat_alloy', qty: 2 }],
    outputDefId: 'ammo_heavy', outputQty: 30,
    duration: 7, skill: 'crafting', skillRequired: 15,
    description: '화약 13 + 합금 판 2 → 중량탄 30발. 총기 작업대, 제작 15 필요.',
  },
  {
    id: 'bulk_ammo_shell', name: '산탄 대량 제작', station: 'ship', bench: 'gun', benchLevel: 1,
    inputs: [{ defId: 'mat_gunpowder', qty: 13 }, { defId: 'mat_scrap', qty: 5 }],
    outputDefId: 'ammo_shell', outputQty: 24,
    duration: 6, skill: 'crafting', skillRequired: 0,
    description: '화약 13 + 폐금속 5 → 산탄 24발. 총기 작업대.',
  },

  /* ── 6-a-2. 총기 작업대 Lv.1: 기본 총기 (2026-09-08) ──────────────────────
   * 작업대 Lv.1 이 만들 수 있는 것이 대량 탄약뿐이라, 갓 지은 작업대 앞에서 **총 한 자루** 만드는 경험이
   * 없었다 (튜토리얼의 `총기 제작` 단계도 여기 걸린다). 등급 I 돌격소총 한 자루 — 기본 지급품에 이미 같은
   * 총이 들어 있으므로 성능을 여는 것이 아니라 "작업대로 무기를 만든다"는 동작을 여는 레시피다. */
  {
    id: 'make_wpn_ar', name: '돌격소총 제작', station: 'ship', bench: 'gun', benchLevel: 1,
    inputs: [{ defId: 'mat_scrap', qty: 6 }, { defId: 'mat_alloy', qty: 1 }],
    outputDefId: 'wpn_ar', outputQty: 1,
    duration: 8, skill: 'crafting', skillRequired: 0,
    description: '폐금속 6 + 합금 판 1 → 돌격소총 (등급 I). 총기 작업대.',
  },

  /* ── 6-b. 총기 작업대 Lv.2: attachments ── */
  {
    id: 'make_att_brake', name: '총구 제동기 제작', station: 'ship', bench: 'gun', benchLevel: 2,
    inputs: [{ defId: 'mat_scrap', qty: 6 }, { defId: 'mat_alloy', qty: 2 }],
    outputDefId: 'att_brake', outputQty: 1,
    duration: 8, skill: 'crafting', skillRequired: 20,
    description: '폐금속 6 + 합금 판 2 → 총구 제동기. 총기 작업대 Lv.2, 제작 20 필요.',
  },
  {
    id: 'make_att_comp', name: '보정기 제작', station: 'ship', bench: 'gun', benchLevel: 2,
    inputs: [{ defId: 'mat_scrap', qty: 6 }, { defId: 'mat_alloy', qty: 2 }],
    outputDefId: 'att_comp', outputQty: 1,
    duration: 8, skill: 'crafting', skillRequired: 20,
    description: '폐금속 6 + 합금 판 2 → 보정기. 총기 작업대 Lv.2, 제작 20 필요.',
  },
  {
    id: 'make_att_grip_vertical', name: '수직 그립 제작', station: 'ship', bench: 'gun', benchLevel: 2,
    inputs: [{ defId: 'mat_scrap', qty: 5 }, { defId: 'mat_alloy', qty: 1 }],
    outputDefId: 'att_grip_vertical', outputQty: 1,
    duration: 6, skill: 'crafting', skillRequired: 15,
    description: '폐금속 5 + 합금 판 1 → 수직 그립. 총기 작업대 Lv.2, 제작 15 필요.',
  },
  {
    id: 'make_att_laser', name: '레이저사이트 제작', station: 'ship', bench: 'gun', benchLevel: 2,
    inputs: [{ defId: 'mat_alloy', qty: 2 }, { defId: 'mat_power_cell', qty: 1 }, { defId: 'mat_cable', qty: 1 }],
    outputDefId: 'att_laser', outputQty: 1,
    duration: 8, skill: 'crafting', skillRequired: 25,
    description: '합금 판 2 + 파워 셀 1 + 전력 케이블 1 → 레이저사이트. 총기 작업대 Lv.2, 제작 25 필요.',
  },
  {
    id: 'make_att_stock', name: '전술 개머리판 제작', station: 'ship', bench: 'gun', benchLevel: 2,
    inputs: [{ defId: 'mat_scrap', qty: 8 }, { defId: 'mat_alloy', qty: 3 }],
    outputDefId: 'att_stock', outputQty: 1,
    duration: 10, skill: 'crafting', skillRequired: 30,
    description: '폐금속 8 + 합금 판 3 → 전술 개머리판. 총기 작업대 Lv.2, 제작 30 필요.',
  },

  /* ── 6-c. 총기 작업대 Lv.3: unique-weapon ammo ── */
  {
    id: 'make_ammo_fuel', name: '연료통 충전', station: 'ship', bench: 'gun', benchLevel: 3,
    inputs: [{ defId: 'mat_gunpowder', qty: 6 }, { defId: 'mat_bio_sample', qty: 4 }, { defId: 'mat_scrap', qty: 2 }],
    outputDefId: 'ammo_fuel', outputQty: 100,
    duration: 8, skill: 'crafting', skillRequired: 30,
    description: '화약 6 + 생체 조직 4 + 폐금속 2 → 연료 100 (「인페르노」). 총기 작업대 Lv.3, 제작 30 필요.',
  },
  {
    id: 'make_ammo_cell', name: '전지 제작', station: 'ship', bench: 'gun', benchLevel: 3,
    inputs: [{ defId: 'mat_power_cell', qty: 2 }, { defId: 'mat_cable', qty: 1 }],
    outputDefId: 'ammo_cell', outputQty: 30,
    duration: 8, skill: 'crafting', skillRequired: 30,
    description: '파워 셀 2 + 전력 케이블 1 → 전지 30 (「테슬라 코일」). 총기 작업대 Lv.3, 제작 30 필요.',
  },
  {
    id: 'make_ammo_shuriken', name: '표창 단조', station: 'ship', bench: 'gun', benchLevel: 3,
    inputs: [{ defId: 'mat_alloy', qty: 4 }, { defId: 'mat_scrap', qty: 4 }],
    outputDefId: 'ammo_shuriken', outputQty: 20,
    duration: 8, skill: 'crafting', skillRequired: 30,
    description: '합금 판 4 + 폐금속 4 → 표창 20 (「카게」). 총기 작업대 Lv.3, 제작 30 필요.',
  },
  {
    id: 'make_ammo_arrow', name: '화살 제작', station: 'ship', bench: 'gun', benchLevel: 3,
    inputs: [{ defId: 'mat_scrap', qty: 4 }, { defId: 'mat_alloy', qty: 1 }, { defId: 'herb_ashleaf', qty: 2 }],
    outputDefId: 'ammo_arrow', outputQty: 15,
    duration: 7, skill: 'crafting', skillRequired: 30,
    description: '폐금속 4 + 합금 판 1 + 잿빛잎 2 → 화살 15 (「롱혼」). 총기 작업대 Lv.3, 제작 30 필요.',
  },
  {
    id: 'make_ammo_rocket', name: '로켓 조립', station: 'ship', bench: 'gun', benchLevel: 3,
    inputs: [{ defId: 'mat_gunpowder', qty: 12 }, { defId: 'mat_alloy', qty: 3 }, { defId: 'mat_circuit', qty: 1 }],
    outputDefId: 'ammo_rocket', outputQty: 3,
    duration: 10, skill: 'crafting', skillRequired: 40,
    description: '화약 12 + 합금 판 3 + 회로 기판 1 → 로켓 3 (「해머헤드」). 총기 작업대 Lv.3, 제작 40 필요.',
  },
  {
    id: 'make_ammo_belt', name: '탄띠 연결', station: 'ship', bench: 'gun', benchLevel: 3,
    inputs: [{ defId: 'mat_gunpowder', qty: 20 }, { defId: 'mat_scrap', qty: 8 }],
    outputDefId: 'ammo_belt', outputQty: 150,
    duration: 10, skill: 'crafting', skillRequired: 30,
    description: '화약 20 + 폐금속 8 → 탄띠 150발 (「사이클론」). 총기 작업대 Lv.3, 제작 30 필요.',
  },

  /* ── 6-d. 장비 작업대: armor I / II, lower bags ── */
  {
    id: 'make_armor_1', name: '방탄복 I 제작', station: 'ship', bench: 'gear', benchLevel: 1,
    inputs: [{ defId: 'mat_scrap', qty: 10 }, { defId: 'mat_alloy', qty: 2 }],
    outputDefId: 'armor_1', outputQty: 1,
    duration: 10, skill: 'crafting', skillRequired: 0,
    description: '폐금속 10 + 합금 판 2 → 방탄복 I. 장비 작업대.',
  },
  {
    id: 'make_armor_2', name: '방탄복 II 제작', station: 'ship', bench: 'gear', benchLevel: 2,
    inputs: [{ defId: 'mat_scrap', qty: 12 }, { defId: 'mat_alloy', qty: 5 }],
    outputDefId: 'armor_2', outputQty: 1,
    duration: 12, skill: 'crafting', skillRequired: 20,
    description: '폐금속 12 + 합금 판 5 → 방탄복 II. 장비 작업대 Lv.2, 제작 20 필요.',
  },
  {
    id: 'make_bag_common', name: '일반 가방 제작', station: 'ship', bench: 'gear', benchLevel: 1,
    inputs: [{ defId: 'mat_scrap', qty: 6 }, { defId: 'mat_bio_sample', qty: 6 }],
    outputDefId: 'bag_common', outputQty: 1,
    duration: 8, skill: 'crafting', skillRequired: 0,
    description: '폐금속 6 + 생체 조직 6 → 일반 가방 (5×6). 장비 작업대.',
  },
  {
    id: 'make_bag_uncommon', name: '고급 가방 제작', station: 'ship', bench: 'gear', benchLevel: 2,
    inputs: [{ defId: 'mat_scrap', qty: 8 }, { defId: 'mat_alloy', qty: 3 }, { defId: 'mat_bio_sample', qty: 6 }],
    outputDefId: 'bag_uncommon', outputQty: 1,
    duration: 10, skill: 'crafting', skillRequired: 20,
    description: '폐금속 8 + 합금 판 3 + 생체 조직 6 → 고급 가방 (6×6). 장비 작업대 Lv.2, 제작 20 필요.',
  },

  /* ── 6-e. 가젯 작업대: grenade / smoke batches, lure, fire ── */
  {
    id: 'make_frag_batch', name: '고폭 수류탄 제작', station: 'ship', bench: 'gadget', benchLevel: 1,
    inputs: [{ defId: 'mat_gunpowder', qty: 8 }, { defId: 'mat_scrap', qty: 3 }],
    outputDefId: 'grenade_frag', outputQty: 2,
    duration: 6, skill: 'crafting', skillRequired: 10,
    description: '화약 8 + 폐금속 3 → G-12 고폭 수류탄 2. 가젯 작업대, 제작 10 필요.',
  },
  {
    id: 'make_smoke_batch', name: '연막탄 대량 제작', station: 'ship', bench: 'gadget', benchLevel: 1,
    inputs: [{ defId: 'mat_gunpowder', qty: 10 }, { defId: 'mat_bio_sample', qty: 5 }],
    outputDefId: 'gad_smoke', outputQty: 3,
    duration: 7, skill: 'crafting', skillRequired: 10,
    description: '화약 10 + 생체 조직 5 → 연막탄 3. 가젯 작업대, 제작 10 필요.',
  },
  {
    id: 'make_lure', name: '유인 수류탄 제작', station: 'ship', bench: 'gadget', benchLevel: 2,
    inputs: [{ defId: 'mat_gunpowder', qty: 4 }, { defId: 'mat_scrap', qty: 2 }, { defId: 'mat_cable', qty: 1 }],
    outputDefId: 'gad_lure', outputQty: 1,
    duration: 6, skill: 'crafting', skillRequired: 20,
    description: '화약 4 + 폐금속 2 + 전력 케이블 1 → 유인 수류탄. 가젯 작업대 Lv.2, 제작 20 필요.',
  },
  {
    id: 'make_fire_gadget', name: '화염수류탄 제작', station: 'ship', bench: 'gadget', benchLevel: 2,
    inputs: [{ defId: 'mat_gunpowder', qty: 8 }, { defId: 'herb_ashleaf', qty: 3 }],
    outputDefId: 'gad_incendiary', outputQty: 1,
    duration: 6, skill: 'crafting', skillRequired: 25,
    description: '화약 8 + 잿빛잎 3 → 화염수류탄 (화염지대). 가젯 작업대 Lv.2, 제작 25 필요.',
  },

  /* ── 6-f. 의학 작업대: 붕대 대량 조제 ── */
  {
    id: 'make_bandage_batch', name: '붕대 대량 제작', station: 'ship', bench: 'medical', benchLevel: 2,
    inputs: [{ defId: 'mat_cloth', qty: 12 }, { defId: 'herb_bloodroot', qty: 2 }],
    outputDefId: 'heal_bandage_herb', outputQty: 3,
    duration: 8, skill: 'medicine', skillRequired: 10,
    description: '천조각 12 + 혈근초 2 → 약초 붕대 3. 의학 작업대 Lv.2, 의학 10 필요.',
  },
];

export const CRAFT_RECIPE_MAP: ReadonlyMap<string, CraftRecipe> = new Map(CRAFT_RECIPES.map((r) => [r.id, r]));

export function getRecipe(id: string): CraftRecipe | undefined {
  return CRAFT_RECIPE_MAP.get(id);
}
