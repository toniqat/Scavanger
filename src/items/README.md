# src/items — Item & weapon data, stats, loot rolling (`ctx.loot`)

Pure data + the `LootRef` implementation. No DOM, no Three.js scene objects. Weapon package (2026-09-05): weapon **grades I–V**, **durability**, **ammo v2** (rounds-as-qty), **attachments** (5 sockets), **bags**, and the `EffectiveWeaponStats` helper every other module fires/repairs/attaches with.

| File | Purpose |
|---|---|
| `WeaponDefs.ts` | 8 weapon **families** × 5 grades = 40 `WeaponDef`s built by `buildGrade` (`WEAPON_DEFS`, `WEAPON_DEF_MAP`, `getWeaponDef`, `WEAPON_FAMILIES`, `WEAPON_GRADES`, `weaponGradesOf(family)`, `weaponIdForGrade(family, grade)`); `WEAPON_CLASS_LABEL_KO`, `WEAPON_CLASS_SHORT` (`SMG/AR/SG/SR/DMR/HG`), `WEAPON_BASE_DURABILITY` (per class), `weaponClassOf(def)`, `weaponFamilyOf(def)`, `gradeOf(def)`, `damageFalloff(def, distance)` |
| `ItemDefs.ts` | 88 `ItemDef`s (`ITEM_DEFS`, `ITEM_DEF_MAP`, `getItemDef`, `itemDefsByCategory`, `isWeaponItemDef`) — 40 weapon items generated from `WEAPON_DEFS` (`WEAPON_ITEM_DEFS`), `AMMO_ITEM_DEFS`, `ATTACHMENT_ITEM_DEFS`, `BAG_ITEM_DEFS`, consumables, valuables, materials; rarity palette `RARITY_COLORS`, `RARITY_ORDER`, `rarityRank`, `rarityForGrade` / `gradeForRarity`; Korean labels (`RARITY_LABEL_KO`, `CATEGORY_LABEL_KO`, `AMMO_LABEL_KO`); `AMMO_TYPES_V2`, `ammoItemIdFor(type)`, `itemIdForWeapon(weaponId)`, `WEAPON_GRADE_VALUE_STEP`; `STARTER_LOADOUT` + `StarterLoadout` type |
| `WeaponStats.ts` | `computeWeaponStats(def, inst?)` → `EffectiveWeaponStats` (grade already in the def + slot timings + socketed attachments), `baseWeaponStats`, `applyAttachmentEffects`, `socketedAttachments`, `repairCost(def, inst)`, `canAttach(weaponDef, attachmentDef)`, `gradeRoman`, `clampGrade`, `RECOIL_H_RATIO` (0.7), `SECONDARY_ADS_TIME_MUL` (0.5) |
| `LootTables.ts` | Per-tier `TierTable`s (`LOOT_TABLES`, `getTierTable`, `getTierLabel`): item count, rarity weights (= weapon grade weights), category weights incl. `attachment` / `bag`, weapon chance, `ammoFraction`, guaranteed picks, `itemWeightMul` (family-wide for weapons). Phase 4: per-`EnemyType` `CorpseTable`s (`CORPSE_TABLES`, `CORPSE_TABLE_MAP`, `CorpseDrop`, `CorpseWeapon`, `DEFAULT_ROGUE_WEAPON_ID`) |
| `Loot.ts` | `LootService implements LootRef` — `rollCrate(tier, rng?)`, `rollCorpse(type, rng?, rogueWeaponId?)`, `createItem(defId, qty?, extras?)`, `getEffectiveStats`, `getRepairCost`, `canAttach`, def lookups; `nextUid()` |
| `index.ts` | Barrel — import via `@/items` |

## Weapon families & grades

Ids: grade I keeps the family id (`ar23`); grade g ≥ 2 is `${family}_g${g}` (`ar23_g3`). Item id = `wpn_${weaponId}` (`wpn_ar23`, `wpn_ar23_g3`). Name = family name + roman numeral (`AR-23 리버레이터 III`; grade I is `… I`). Every def carries `grade`, `family`, `maxDurability` and the v2 `ammoType` from `AMMO_FOR_CLASS`.

Per grade above I: damage × (1 + 0.12·(g−1)) rounded, max durability × (1 + 0.25·(g−1)) rounded, item value × (1 + 0.6·(g−1)), rarity = grade (I 일반 · II 고급 · III 희귀 · IV 서사 · V 전설).

| family | class | ammo | grid | dmg I → V | dur I → V | rps | mag | reload | falloff start→end (×min) | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `ar23` AR-23 리버레이터 | AR | medium | 4×2 | 60 → 89 | 500 → 1000 | 10 | 45 | 2.4 s | 60→220 (×0.6) | auto |
| `smg37` SMG-37 디펜더 | SMG | light | 3×2 | 32 → 47 | 550 → 1100 | 14 | 40 | 1.9 s | 15→45 (×0.4) | auto |
| `sg8` SG-8 퍼니셔 | SG | shell | 3×2 | 22×8 → 33×8 | 200 → 400 | 1.3 | 8 | 3.0 s | 8→30 (×0.25) | pellets |
| `r63` R-63 딜리전스 | DMR | heavy | 4×1 | 120 → 178 | 250 → 500 | 3 | 15 | 2.6 s | 120→400 (×0.75) | semi, adsZoom 1.6 |
| `sr9` SR-9 이래디케이터 | SR | heavy | 5×1 | 330 → 488 | 120 → 240 | 0.9 | 5 | 3.4 s | 300→700 (×0.85) | bolt, adsZoom 4, scope |
| `las16` LAS-16 사이드 | AR | medium | 3×2 | 28 → 41 | 500 → 1000 | 16 | 60 | 3.2 s | 60→160 (×0.6) | energy projectile (180 m/s) |
| `p2` P-2 피스메이커 | PISTOL | light | 2×1 | 45 → 67 | 350 → 700 | 6 | 15 | 1.6 s | 20→70 (×0.5) | semi |
| `p19` P-19 리디머 | PISTOL | light | 2×1 | 30 → 44 | 350 → 700 | 18 | 31 | 1.9 s | 15→45 (×0.4) | machine pistol |

Base item values (grade I): ar23 350 · smg37 480 · sg8 520 · r63 780 · sr9 950 · las16 1250 · p2 140 · p19 260. Hip spreads are deliberately loose (AR 1.4°, SMG 1.9°, SR 4°); `src/weapons` scales them by stance/ADS.

## Ammo v2

Category `ammo`, 1×1, `qty` **is** the round count, `stackMax = AMMO_STACK_ROUNDS[type]`:

| id | name | calibre | stack | classes | value/round |
|---|---|---|---|---|---|
| `ammo_light` | 경량탄 | light | 120 | SMG, PISTOL | 1 |
| `ammo_medium` | 준중량탄 | medium | 90 | AR (incl. las16) | 2 |
| `ammo_heavy` | 중량탄 | heavy | 30 | SR, DMR | 3 |
| `ammo_shell` | 산탄 | shell | 24 | SG | 3 |

The legacy `ammo_rifle/pistol/shotgun/energy` defs are gone; `AMMO_LABEL_KO` still labels the legacy `AmmoType` members for safety.

## Attachments

Category `attachment`, 1×1, stack 1, `ItemDef.attachment: { socket, classes?, ammoTypes?, effects }`. `classes`/`ammoTypes` undefined = fits everything. "not PISTOL" = `['AR','SMG','SG','SR','DMR']`.

| id | name | socket | rarity | fits | effects |
|---|---|---|---|---|---|
| `att_brake` | 총구 제동기 | muzzle | uncommon | all | recoilV ×0.75, recoilH ×0.75 |
| `att_comp` | 보정기 | muzzle | uncommon | all | spread ×0.85 |
| `att_choke` | 산탄총 초크 | muzzle | uncommon | SG | spread ×0.7 |
| `att_grip_angled` | 앵글 그립 | grip | uncommon | not PISTOL | recoilH ×0.7 |
| `att_grip_vertical` | 수직 그립 | grip | uncommon | not PISTOL | recoilV ×0.7 |
| `att_mag_light` | 확장형 경량 탄창 | mag | rare | ammo light | magSize ×1.4 |
| `att_mag_medium` | 확장형 준중량 탄창 | mag | rare | ammo medium | magSize ×1.4 |
| `att_mag_heavy` | 확장형 중량 탄창 | mag | rare | ammo heavy | magSize ×1.4 |
| `att_mag_shell` | 확장형 산탄 탄창 | mag | rare | ammo shell | magSize ×1.4 |
| `att_stock` | 전술 개머리판 | stock | rare | not PISTOL | spread ×0.9, adsTime ×0.75 |
| `att_laser` | 레이저사이트 | sight | uncommon | all | laser, hipSpread ×0.7 |
| `att_scope4` | 4배 조준경 | sight | rare | AR, SMG, SR, DMR | adsZoom 4, scope |
| `att_scope6` | 6배 조준경 | sight | epic | AR, SMG, SR, DMR | adsZoom 6, scope |
| `att_scope8` | 8배 조준경 | sight | legendary | SR, DMR | adsZoom 8, scope |

## Bags

Category `bag`, 2×2, stack 1, `ItemDef.bag: { cols, rows, quickSlots, tactical? }`.

| id | name | rarity | grid | quick slots |
|---|---|---|---|---|
| `bag_common` | 일반 가방 | common | 5×6 | 2 |
| `bag_uncommon` | 고급 가방 | uncommon | 6×6 | 3 |
| `bag_rare` | 희귀 가방 | rare | 8×6 | 4 |
| `bag_epic` | 서사 가방 | epic | 9×6 | 5 |
| `bag_legendary` | 전설 가방 | legendary | 10×6 | 6 |
| `bag_rare_tac` | 희귀 전술 가방 | rare | 7×6 | 7 (tactical) |
| `bag_epic_tac` | 서사 전술 가방 | epic | 8×6 | 8 (tactical) |
| `bag_legendary_tac` | 전설 전술 가방 | legendary | 9×6 | 9 (tactical) |

## Other items

**Consumables**: `grenade_frag`, `grenade_incendiary` (1×1, stack 4) · `stim` (+50), `stim_advanced` (+100) (1×1, stack 3).

**Valuables**: `gem_quartz`, `gem_amber`, `gem_sapphire`, `gem_void`, `cred_chip` (stack 5), `super_earth_medal` (1×1) · `salvage_electronics`, `data_core`, `data_core_encrypted` (2×1) · `sample_canister`, `sample_canister_pure` (3×1) · `terminid_gland` (1×1) · `alien_artifact`, `alien_relic` (2×2).

**Materials** (1×1, stack 10): `mat_scrap` (repair), `mat_bio_sample`, `mat_alloy` (repair, grade ≥ III), `mat_power_cell`.

## Starter loadout

```ts
STARTER_LOADOUT = {
  primary: 'wpn_ar23', primary2: null, secondary: 'wpn_p2', bag: 'bag_common',
  items: [grenade_frag×2, stim×2, ammo_medium×90, ammo_light×60],
}   // as const; `StarterLoadout` is the widened type
```

## Stats & helpers (`WeaponStats.ts`, exposed via `LootRef`)

- `computeWeaponStats(def, inst?)`: starts from the def (damage/magSize/spreads/durability already graded), `recoilV = def.recoil`, `recoilH = recoil × 0.7`, `adsTime = WEAPON_ADS_TIME` (× 0.5 for secondaries), `swapTime = WEAPON_SWAP_TIME_PRIMARY | _SECONDARY`, `adsZoom = def.adsZoom ?? 1`, `scope = !!def.scope`, `laser = false`, `maxDurability = def.maxDurability ?? WEAPON_DEFAULT_DURABILITY`; then folds each attachment in `inst.sockets` in `SOCKET_SLOTS` order — multipliers multiply (`spread` hits hip + ADS, `hipSpread` only hip), `magSize` rounded (min 1), `adsZoom`/`scope`/`laser` override.
- `repairCost(def, inst)`: missing = max − (`inst.durability ?? max`); `ceil(missing / REPAIR_SCRAP_PER)` × `mat_scrap`, plus `ceil(missing / REPAIR_ALLOY_PER)` × `mat_alloy` when grade ≥ III; `[]` when nothing is missing.
- `canAttach(weaponDef, attachmentDef)`: `classes` (via `weaponClassOf`) and `ammoTypes` (def calibre) checks.
- `LootService.createItem(defId, qty?, extras?)`: weapons spawn with `durability = maxDurability` and `ammoInMag = magSize` (extended mag in `extras.sockets` counted) unless `extras` overrides; `sockets` copied from `extras`. `getEffectiveStats` accepts an instance, a weapon def id (`ar23_g3`) or a weapon item id (`wpn_ar23_g3`); returns `null` / `[]` / `false` for non-weapons.

## Loot tiers

| Tier | Label | Items | Weapon | Attachment / bag weight | Ammo roll (× stack) | Notes |
|---|---|---|---|---|---|---|
| 1 | 보급 상자 | 2–3 | — | 6 / — | 25–50 % | mostly common consumables/materials |
| 2 | 군수 상자 | 3–4 | 35 % | 10 / 3 | 35–70 % | guaranteed uncommon+ valuable |
| 3 | 귀중품 금고 | 4–5 | 55 % | 12 / 6 | 50–85 % | guaranteed rare+ valuable |
| 4 | 희귀 캐시 | 5–6 | 100 % | 12 / 8 | 60–100 % | guaranteed epic/legendary valuable **and** a weapon |

Rarity weights double as weapon-grade weights (grade ↔ rarity). `itemWeightMul` keys match an exact item id or, for weapons, the family (`wpn_sr9` or `sr9`) — applied to every grade. At most one bag per crate. `rollCrate` is deterministic for a given `Random`; same-def stackables merge (an ammo overflow becomes a second smaller stack) and the result is sorted largest-first for container placement.

## Phase 3 (2026-09-06)
- Loot tier 5 `보급 투하 상자` (`SUPPLY_CRATE_TIER`): 4–6 consumables only (ammo 45 / stim 30 / grenade 25, guaranteed stim + ammo, no weapons or valuables). Used by the ship-call supply drop.

## Phase 4 (2026-09-06) — corpse tables (`rollCorpse`)

`LootRef.rollCorpse(type, rng = fallback, rogueWeaponId?)` rolls the contents of a dead enemy's corpse (enemies open it via `ctx.inventory.openContainerItems('corpse:<id>', items, pos, '시체')`). Deterministic for a given `Random`; every `CorpseDrop` is `chance` → `qty ∈ [min, max]`; the result is sorted largest-first like `rollCrate`. Unknown types return a single `mat_bio_sample`.

| type | always | chance |
|---|---|---|
| `scavenger` `hunter` `warrior` | `mat_bio_sample` ×1–3 | 25 % `terminid_gland` |
| `spewer` | `mat_bio_sample` ×1–3 | 60 % `terminid_gland` |
| `charger` | `mat_bio_sample` ×1–3 | 25 % `terminid_gland`, 40 % `mat_alloy` ×1–2 |
| `toxic` | `mat_bio_sample` ×1–2 | 35 % `terminid_gland` |
| `artillery` | `mat_bio_sample` ×2–3 | 50 % `mat_power_cell` |
| `behemoth` | `mat_alloy` ×2–4, `terminid_gland` ×1–2 | 30 % `alien_artifact` |
| `rogue` | calibre rounds + **its weapon** (see below) | 30 % `stim`, 20 % `grenade_frag` |
| `rogue_boss` | calibre rounds + **graded weapon** + one `att_*` (rarity ≤ epic, fitting the weapon when any does), `stim` ×1–2 | — |

Rogue weapon (`CorpseWeapon`): `rogueWeaponId` is the `WeaponDef` id the rogue carried (`DEFAULT_ROGUE_WEAPON_ID` = `ar23` when undefined / unknown). The corpse holds one ammo stack of that calibre (`ammoItemIdFor(def.ammoType)`, 30–60 % of `AMMO_STACK_ROUNDS`) and the weapon item `wpn_<weaponId>` created with `durability = round(max × 0.05–0.15)` (min 1) and `ammoInMag = rng 0..magSize`. Bosses swap the def for the same family at grade III or IV (`weaponIdForGrade`) with durability 40–70 %.

## Tactical kit (merged 2026-09-06)

| File | Role |
|---|---|
| `ArmorDefs.ts` | 8 `ArmorDef`s (`ARMOR_DEFS`, `ARMOR_DEF_MAP`, `getArmorDef`), `armorItemSize(def)` grid footprint, `ARMOR_ICON` |
| `Recipes.ts` | 15 `CraftRecipe`s (`CRAFT_RECIPES`, `CRAFT_RECIPE_MAP`, `getRecipe`) — ammo teardown → 화약, 화약 → ammo, herbs → medicine, ship-only gadget / gardening recipes |

New categories: `armor` (`ItemDef.armorId` → `ArmorDef`, `durabilityMax`), `gadget` (`gadgetId`, behaviour in `src/gadgets`), `herb` (gathered from `WorldRef.getGatherNodes()`); `mat_gunpowder` for the ammo recipes; every def carries a `weight` (kg, `itemWeight(def, qty)`, default `DEFAULT_ITEM_WEIGHT`). The branch's `BackpackDef` catalogue was **not** merged — bags stay the weapon-package `bag_*` items (`BagDef`, `bag.tactical` = hover / faster swap perk). Starter kit adds `armor_2` + one `gad_smoke`. `LootRef` gained `getArmorDef` and `getAllRecipes`; loot tables roll `gadget` / `herb` / `armor` (heavy deployables never in tier 1).

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
| `break_ammo_medium (30발)` / `_pistol` / `_shotgun` | field | crafting 0 | 탄약 팩 1 → 화약 6 / 4 / 5 |
| `make_ammo_medium (30발)` / `_pistol` / `_shotgun` | field | crafting 0 | 화약 + 폐금속 → 해당 탄약 팩 |
| `make_ammo_heavy (10발)` | field | crafting 20 | 파워 셀 1 + 합금 판 1 → 에너지 셀 |
| `make_smoke` | field | crafting 10 | 화약 4 + 생체 조직 2 → 연막탄 |
| `make_incendiary` | field | crafting 15 | 화약 8 + 잿빛잎 2 → 소이 수류탄 |
| `make_mine` | ship | crafting 35 | 화약 10 + 합금 판 2 → 지뢰 |
| `make_stim` | field | medicine 0 | 혈근초 3 + 잿빛잎 1 → 스팀 |
| `make_stim_advanced` | field | medicine 25 | 혈근초 4 + 발광버섯 2 + 잿빛잎 2 → 고급 스팀 |
| `make_defib_charge` | ship | medicine 40 | 파워 셀 2 + 발광버섯 1 → 제세동기 |
| `grow_bloodroot` | ship | gardening 0 | 잿빛잎 4 → 혈근초 6 |
| `grow_glowcap` | ship | gardening 20 | 혈근초 6 + 생체 조직 3 → 발광버섯 2 |

`station: 'field'` recipes also work on the ship (`inventory.getRecipes('ship')` returns everything).

**Consumables**: `grenade_frag`, `grenade_incendiary` (1×1, stack 4) · `stim` (+50), `stim_advanced` (+100) (1×1, stack 3) · `ammo_medium (30발)`, `ammo_light (30발)`, `ammo_shell (8발)`, `ammo_heavy (10발)` (2×1, stack 2). All are `quickUsable`.

**Valuables**: `gem_quartz`, `gem_amber`, `gem_sapphire`, `gem_void`, `cred_chip` (stack 5), `super_earth_medal` (1×1) · `salvage_electronics`, `data_core`, `data_core_encrypted` (2×1) · `sample_canister`, `sample_canister_pure` (3×1) · `terminid_gland` (1×1) · `alien_artifact`, `alien_relic` (2×2).

**Materials** (1×1): `mat_scrap`, `mat_bio_sample`, `mat_alloy`, `mat_power_cell` (stack 10), `mat_gunpowder` (stack 20).

`STARTER_LOADOUT = { primary: 'wpn_ar23', secondary: 'wpn_p2', armor: 'armor_2', backpack: 'bp_2', bag: [grenade_frag×4, stim×2, ammo_medium (30발)×1, gad_smoke×1] }`.

Ammo recipes were rewritten for ammo v2 (`qty` = rounds): 경량탄 30 ↔ 화약 4, 준중량탄 30 ↔ 화약 6, 중량탄 10 ↔ 화약 5 (+ 합금 판, 제작 20), 산탄 8 ↔ 화약 5.
