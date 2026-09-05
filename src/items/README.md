# src/items — Item, weapon, gear & recipe data, loot rolling (`ctx.loot`)

Pure data + the `LootRef` implementation. No DOM, no Three.js scene objects.

| File | Purpose |
|---|---|
| `ItemDefs.ts` | 66 `ItemDef`s (`ITEM_DEFS`, `ITEM_DEF_MAP`, `getItemDef`, `itemDefsByCategory`), rarity palette `RARITY_COLORS`, Korean labels (`RARITY_LABEL_KO`, `CATEGORY_LABEL_KO`, `AMMO_LABEL_KO`), per-category `CATEGORY_COLOR` / `CATEGORY_ICON`, `DEFAULT_ITEM_WEIGHT` + `itemWeight(def, qty)`, `isQuickUsable`, `rarityRank`, `itemIdForWeapon`, `STARTER_LOADOUT`. Armor / backpack item defs are **generated** from the gear tables so ids, weights and durability can never drift |
| `WeaponDefs.ts` | 8 `WeaponDef`s (`WEAPON_DEFS`, `WEAPON_DEF_MAP`, `getWeaponDef`) — ballistics consumed by `src/weapons`; `WEAPON_CLASS_LABEL_KO`, `weaponClassOf(def)`, `meleeMulOf(def)` (stock melee multiplier, default `MELEE_STOCK_MUL_DEFAULT`), `damageFalloff(def, distance)` |
| `ArmorDefs.ts` | 8 `ArmorDef`s (`ARMOR_DEFS`, `ARMOR_DEF_MAP`, `getArmorDef`), `armorItemSize(def)` grid footprint, `ARMOR_ICON` |
| `BackpackDefs.ts` | 8 `BackpackDef`s (`BACKPACK_DEFS`, `BACKPACK_DEF_MAP`, `getBackpackDef`), `backpackItemSize(def)`, `BACKPACK_ICON`, and the no-backpack fallbacks `BASE_BAG_COLS/ROWS` (6×4) + `BASE_QUICK_SLOTS` (2) |
| `Recipes.ts` | 15 `CraftRecipe`s (`CRAFT_RECIPES`, `CRAFT_RECIPE_MAP`, `getRecipe`) — ammo teardown → 화약, 화약 → ammo, herbs → medicine, ship-only gadget / gardening recipes |
| `LootTables.ts` | Per-tier `TierTable`s (`LOOT_TABLES`, `getTierTable`, `getTierLabel`): item count range, rarity weights, category weights (now including `armor` / `backpack` / `gadget` / `herb`), weapon chance, guaranteed picks, per-item `itemWeightMul` |
| `Loot.ts` | `LootService implements LootRef` — `rollCrate(tier, rng?)`, `createItem`, def lookups, and the tactical-kit additions `getArmorDef` / `getBackpackDef` / `getAllRecipes`; `nextUid()` |
| `index.ts` | Barrel — import via `@/items` |

## Ids

**Weapons** (item id → weaponId, grid size): `wpn_ar23`→`ar23` 4×2 · `wpn_smg37`→`smg37` 3×2 · `wpn_sg8`→`sg8` 3×2 · `wpn_r63`→`r63` 4×1 · `wpn_sr9`→`sr9` 5×1 · `wpn_las16`→`las16` 3×2 (primaries); `wpn_p2`→`p2` 2×1 · `wpn_p19`→`p19` 2×1 (secondaries).

## Weapon classes, falloff, stock & durability

| id | class | dmg | rps | mag / mags | reload | falloff start→end (×min) | `meleeMul` | `durabilityMax` | kg |
|---|---|---|---|---|---|---|---|---|---|
| `ar23` | AR | 60 | 10 | 45 / 6 | 2.4 s | 60→220 (×0.6) | 1.35 | 320 | 4.2 |
| `smg37` | SMG | 32 | 14 | 40 / 5 | 1.9 s | 15→45 (×0.4) | 1.15 | 260 | 3.1 |
| `sg8` | SG | 22×8 | 1.3 | 8 / 4 | 3.0 s | 8→30 (×0.25) | 1.5 | 300 | 4.6 |
| `r63` | DMR | 120 | 3 | 15 / 5 | 2.6 s | 120→400 (×0.75) | 1.4 | 340 | 4.4 |
| `sr9` | SR | 330 | 0.9 | 5 / 4 | 3.4 s | 300→700 (×0.85) | 1.6 | 380 | 6.8 |
| `las16` | AR | 28 | 16 | 60 / 4 | 3.2 s | 60→160 (×0.6) | 1.2 | 420 | 5.5 |
| `p2` | PISTOL | 45 | 6 | 15 / 5 | 1.6 s | 20→70 (×0.5) | — (1) | 240 | 1.1 |
| `p19` | PISTOL | 30 | 18 | 31 / 5 | 1.9 s | 15→45 (×0.4) | — (1) | 220 | 1.3 |

Melee damage is `MELEE_DAMAGE × meleeMulOf(def) × derived.meleeDamageMul` — every weapon hits for the same base, only a real stock adds the multiplier (pistols have none).

## Body armor (`ArmorDef`)

Numbered plates take their damage reduction straight from `ARMOR_DR_BY_TIER`, so the shared contract stays the single source of truth.

| id | 이름 | rarity | DR | kg | 내구도 | 칸 | perk |
|---|---|---|---|---|---|---|---|
| `armor_1` | 방탄복 I | common | 6 % | 3.0 | 200 | 2×2 | — |
| `armor_2` | 방탄복 II | common | 12 % | 4.6 | 280 | 2×2 | — |
| `armor_3` | 방탄복 III | uncommon | 18 % | 6.6 | 380 | 2×3 | — |
| `armor_4` | 방탄복 IV | rare | 24 % | 9.2 | 480 | 2×3 | — |
| `armor_5` | 방탄복 V | epic | 30 % | 12.4 | 600 | 2×3 | — |
| `armor_regen` | 재생 방탄복 | legendary | 27 % | 10.6 | 520 | 2×3 | `regen`, `perkValue` 1 hp/s while stamina is full |
| `armor_ultralight` | 초경량 방탄복 | legendary | 10 % | 1.9 | 300 | 2×2 | `ultralight`, `perkValue` 0.18 (스태미나 회복 + 이동속도) |
| `armor_optical` | 광학미채 방탄복 | legendary | 8 % | 3.4 | 260 | 2×2 | `optical` — 상시 은폐 |

Perks are **declared here and implemented in `src/player`** (regen tick, ultralight speed/stamina, optical `setCloak(Infinity, 'armor')`).

## Backpacks (`BackpackDef`)

The equipped backpack *is* the bag: it sets the grid size, the quick-use slot count and the carry bonus.

| id | 이름 | rarity | 격자 | 빠른 사용 | +kg | 자체 kg | 내구도 | 칸 | perk |
|---|---|---|---|---|---|---|---|---|---|
| `bp_1` | 가방 I | common | 8×4 | 4 | 4 | 1.2 | 220 | 3×2 | — |
| `bp_2` | 가방 II | common | 9×5 | 4 | 7 | 1.9 | 280 | 3×2 | — |
| `bp_3` | 가방 III | uncommon | 10×5 | 4 | 10 | 2.5 | 340 | 3×2 | — |
| `bp_4` | 가방 IV | rare | 10×6 | 4 | 14 | 3.3 | 420 | 3×3 | — |
| `bp_5` | 가방 V | epic | 12×6 | 4 | 18 | 4.4 | 500 | 3×3 | — |
| `bp_tactical` | 전술 가방 | legendary | 10×6 | **8** | 12 | 3.6 | 420 | 3×3 | `tactical` — 무기 교체 50 % 단축 (weapons) + 공중 호버 (player) |
| `bp_special` | 특수 가방 | legendary | 10×6 | 4 | 12 | 3.4 | 420 | 3×3 | `special` — 임플란트 쿨타임 50 % (progression folds it into `implantCooldownMul`) |
| `bp_jump` | 점프 가방 | legendary | 10×6 | 4 | 10 | 4.6 | 400 | 3×3 | `jump` — 공중 재점프 전방 돌진 (player) |

No backpack equipped → `BASE_BAG_COLS × BASE_BAG_ROWS` (6×4) and `BASE_QUICK_SLOTS` (2).

## Gadget consumables

`category: 'gadget'`, `quickUsable: true`, `gadgetId` pointing at a `GadgetId`. Behaviour lives in `src/gadgets`; items only carry the id.

| id | gadgetId | 칸 | stack | kg |
|---|---|---|---|---|
| `gad_cloak_veil` 은폐 장막 | `cloakVeil` | 1×2 | 2 | 1.1 |
| `gad_dome_shield` 돔 실드 | `domeShield` | 2×2 | 1 | 5.8 |
| `gad_barricade` 바리케이드 | `barricade` | 2×2 | 1 | 7.2 |
| `gad_lure` 유인 수류탄 | `lureGrenade` | 1×1 | 3 | 0.5 |
| `gad_smoke` 연막탄 | `smokeGrenade` | 1×1 | 3 | 0.55 |
| `gad_mine` 지뢰 | `mine` | 1×1 | 4 | 1.1 |
| `gad_turret` 포탑 설치 | `turret` | 2×2 | 1 | 9.5 |
| `gad_incendiary` 화염수류탄 | `incendiary` | 1×1 | 3 | 0.6 |
| `gad_defib` 제세동기 | `defib` | 2×1 | 1 | 2.4 |
| `gad_jumppad` 점프대 | `jumpPad` | 2×2 | 1 | 6.4 |

## Weight (kg per unit)

`ItemDef.weight`; `itemWeight(def, qty)` falls back to `DEFAULT_ITEM_WEIGHT` (0.1). **Cells and kilograms are deliberately uncorrelated** so the bag is a real packing decision:

- `gem_void` 공허석 — 1×1 but **1.9 kg** (a brick you can pocket)
- `super_earth_medal` 슈퍼 지구 훈장 — 1×1, **0.15 kg**, ₩4 800 (best value per kg in the game)
- `salvage_electronics` — 2×1 but 3.2 kg, heavier than the 2×1 `data_core` (1.2 kg) worth five times more
- `gad_turret` — 2×2 and **9.5 kg**, the heaviest carryable
- `ammo_rifle` — only 2×1 yet 2.2 kg; a full ammo loadout eats the budget
- `cred_chip` — 0.02 kg, stacks to 5

## Herbs & crafting materials

`herb_bloodroot` 혈근초 (common, stack 8) · `herb_ashleaf` 잿빛잎 (uncommon, stack 8) · `herb_glowcap` 발광버섯 (rare, stack 6) — all 1×1, gathered from `WorldRef.getGatherNodes()`.
`mat_gunpowder` 화약 (material, 1×1, stack 20, 0.05 kg) is the ammo-conversion currency.

## Recipes (`getAllRecipes`)

| id | station | skill (req) | in → out |
|---|---|---|---|
| `break_ammo_rifle` / `_pistol` / `_shotgun` | field | crafting 0 | 탄약 팩 1 → 화약 6 / 4 / 5 |
| `make_ammo_rifle` / `_pistol` / `_shotgun` | field | crafting 0 | 화약 + 폐금속 → 해당 탄약 팩 |
| `make_ammo_energy` | field | crafting 20 | 파워 셀 1 + 합금 판 1 → 에너지 셀 |
| `make_smoke` | field | crafting 10 | 화약 4 + 생체 조직 2 → 연막탄 |
| `make_incendiary` | field | crafting 15 | 화약 8 + 잿빛잎 2 → 소이 수류탄 |
| `make_mine` | ship | crafting 35 | 화약 10 + 합금 판 2 → 지뢰 |
| `make_stim` | field | medicine 0 | 혈근초 3 + 잿빛잎 1 → 스팀 |
| `make_stim_advanced` | field | medicine 25 | 혈근초 4 + 발광버섯 2 + 잿빛잎 2 → 고급 스팀 |
| `make_defib_charge` | ship | medicine 40 | 파워 셀 2 + 발광버섯 1 → 제세동기 |
| `grow_bloodroot` | ship | gardening 0 | 잿빛잎 4 → 혈근초 6 |
| `grow_glowcap` | ship | gardening 20 | 혈근초 6 + 생체 조직 3 → 발광버섯 2 |

`station: 'field'` recipes also work on the ship (`inventory.getRecipes('ship')` returns everything).

**Consumables**: `grenade_frag`, `grenade_incendiary` (1×1, stack 4) · `stim` (+50), `stim_advanced` (+100) (1×1, stack 3) · `ammo_rifle`, `ammo_pistol`, `ammo_shotgun`, `ammo_energy` (2×1, stack 2). All are `quickUsable`.

**Valuables**: `gem_quartz`, `gem_amber`, `gem_sapphire`, `gem_void`, `cred_chip` (stack 5), `super_earth_medal` (1×1) · `salvage_electronics`, `data_core`, `data_core_encrypted` (2×1) · `sample_canister`, `sample_canister_pure` (3×1) · `terminid_gland` (1×1) · `alien_artifact`, `alien_relic` (2×2).

**Materials** (1×1): `mat_scrap`, `mat_bio_sample`, `mat_alloy`, `mat_power_cell` (stack 10), `mat_gunpowder` (stack 20).

`STARTER_LOADOUT = { primary: 'wpn_ar23', secondary: 'wpn_p2', armor: 'armor_2', backpack: 'bp_2', bag: [grenade_frag×4, stim×2, ammo_rifle×1, gad_smoke×1] }`.

## Loot tiers

| Tier | Label | Items | Notes |
|---|---|---|---|
| 1 | 보급 상자 | 2–3 | mostly common consumables/materials/herbs; heavy deployables (`gad_turret`, `gad_dome_shield`) excluded |
| 2 | 군수 상자 | 3–4 | guaranteed uncommon+ valuable, 35 % weapon; legendary gear weight 0, `bp_5` ×0.3 |
| 3 | 귀중품 금고 | 4–5 | guaranteed rare+ valuable, 55 % weapon; legendary backpacks ×0.4 |
| 4 | 희귀 캐시 | 5–6 | guaranteed epic/legendary valuable **and** a weapon **and** a rare+ armor / backpack / gadget |

`rollCrate` is deterministic for a given `Random`; same-def stackables are merged and the result is sorted largest-first for container placement. **Gear rolled from a crate is second-hand** — `durability` is randomised to 55–100 % of `durabilityMax`, so 함선 수리 is worth doing. `createItem` always starts fresh gear at full durability.
