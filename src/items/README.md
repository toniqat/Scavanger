# src/items/ — item and weapon definitions, effective stats, loot rolling, craft economy

Pure data layer. Loads the item-side csv tables (`data/`) into typed defs, computes effective weapon stats, rolls crate and
corpse contents, and owns the craft / repair / salvage economy. No DOM, no Three.js, no system registration: the
`LootService` instance is created and published as `ctx.loot` by `src/inventory/InventorySystem.ts`. Behaviour of items
(firing, gadgets, housing stations, buffs) lives in the consuming folders; this folder only carries data and pure functions.
Unlike other feature folders, `@/items` is imported directly by `inventory/`, `weapons/` and `ui/` as a data barrel.

## Files

| File | Responsibility |
|---|---|
| `index.ts` | Barrel (`@/items`): re-exports every module below plus `LootService`, `nextUid` from `Loot.ts` |
| `ItemDefs.ts` | All `ItemDef`s: `ITEM_DEFS` (order = in-game list order), `ITEM_DEF_MAP` (exact ids only), `getItemDef` (also resolves `item_aliases.csv`), `itemDefsByCategory`, `ITEM_CATEGORIES`. Generated groups: `WEAPON_ITEM_DEFS`, `AMMO_ITEM_DEFS`, `ATTACHMENT_ITEM_DEFS`, `BAG_ITEM_DEFS`, `SEED_ITEM_DEFS`, `SAMPLE_ITEM_DEFS`, `SOCKET_ITEM_DEFS`, `MEAL_ITEM_DEFS`, library media (`BOOK_/DISC_/RECORD_ITEM_DEFS`, `LIBRARY_ITEM_DEFS`, `LIBRARY_ITEMS_BY_SERIES`, `libraryItemIdFor`, `libraryItemName`, `libraryItemDefOf`, `libraryShelfOf`, `LIBRARY_BOOK_RARITY`), games (`GAME_CONSOLE_ITEM_DEFS`, `GAME_DISC_ITEM_DEFS`, `GAME_ITEM_PLANETS`, `GAME_PATTERN_TOKENS`). Lookups: `SHIELD_CHARGE_MAP`/`shieldChargeOf`, `BOOST_ITEM_MAP`/`boostItemOf`, `isWeaponItemDef`, `isQuickUsable`, `itemIdForWeapon`, `ammoItemIdFor`, `AMMO_TYPES_V2`, `UNIQUE_AMMO_TYPES`, `AMMO_ROUND_WEIGHT`, `AMMO_LABEL_KO`, `itemWeight`, `DEFAULT_ITEM_WEIGHT`, `BAG_CAPACITY_PER_CELL`, `WEAPON_GRADE_VALUE_STEP`, `STARTER_LOADOUT`, `STARTER_STASH` |
| `WeaponDefs.ts` | Graded families from `weapons.csv` × grades I–V (`buildGrade`) + 6 uniques from `weapons_unique.csv`: `WEAPON_DEFS`, `WEAPON_DEF_MAP`, `getWeaponDef`, `WEAPON_FAMILIES` (graded only), `WEAPON_GRADES`, `weaponGradesOf`, `weaponIdForGrade`, `weaponClassOf`, `weaponFamilyOf`, `gradeOf`, `meleeMulOf`, `damageFalloff`, `WEAPON_FAMILY_TUNING`/`weaponFamilyTuning`, `WEAPON_GRADE_HANDLING_MUL`/`weaponHandlingMul`, `UNIQUE_WEAPON_DEFS`, `UNIQUE_WEAPON_DEF_MAP`, `isUniqueWeapon`, `isUniqueWeaponId`, `UNIQUE_WEAPON_MAG`, `UNIQUE_WEAPON_DURABILITY`, class labels (`WEAPON_CLASS_LABEL_KO`, `WEAPON_CLASS_SHORT`, `WEAPON_CLASSES`, `WEAPON_BASE_DURABILITY`) |
| `WeaponStats.ts` | `computeWeaponStats(def, inst?)` → `EffectiveWeaponStats`; `baseWeaponStats`, `applyAttachmentEffects`, `socketedAttachments`, `fittingAttachments`, `canAttach(weaponDef, attachmentDef)`, `damageFalloffStats(stats, d)`, `gradeRoman`, `clampGrade`, `RECOIL_H_RATIO`, `SECONDARY_ADS_TIME_MUL`, `WEAPON_BLOOM_*_DEFAULT` |
| `ArmorDefs.ts` | `ARMOR_DEFS`, `ARMOR_DEF_MAP`, `getArmorDef`, `armorItemSize` (fixed 2×2), `ARMOR_ICON` |
| `ImplantDefs.ts` | Implant items (category `implant`): stat implants `imp_<stat>_<g>` (grades I–IV) + perk implants `imp_perk_<perk>` (`implants_perks.csv`), each with a broken twin `imp_broken_*` (`repairsTo`, `repairCost`). `IMPLANT_WORKING_DEFS`, `IMPLANT_BROKEN_DEFS`, `IMPLANT_ITEM_DEFS`, `PERK_IMPLANT_DEFS`, `IMPLANT_GRADES`, `IMPLANT_SLOTS_BY_GRADE`, `IMPLANT_VALUE_BY_RARITY`, `BROKEN_IMPLANT_VALUE_DIV`, `IMPLANT_REPAIR_COST`, `IMPLANT_STAT_NAME_KO`, `implantItemIdFor`, `perkImplantItemIdFor`, `isImplantItemDef`, `isBrokenImplantDef` |
| `Recipes.ts` | Craft recipes only: `CRAFT_RECIPES` (from `recipes.csv`), `CRAFT_COST_BY_OUTPUT` / `craftCostOf(defId)` (value index used by repair and salvage); fills `CraftRecipe.unlockSeries` from library `recipe:<id>` effects |
| `Salvage.ts` | Durability buckets (`durabilityBucketOf`, `durabilityBucketInfo`, `bucketOfRatio`, `DURABILITY_BUCKETS`, `DURABILITY_BUCKET_LABELS`, `maxDurabilityOf`), `repairCostFor`, `needsRepairCost`, `salvageFor`, `scaleSalvage`, `SALVAGE_RECIPES` (hand rows from `salvage.csv` + rows generated from craft inputs), `ALL_CRAFT_RECIPES`, `CRAFT_RECIPE_MAP`, `getRecipe`, `checkSalvageEconomy()` |
| `LootTables.ts` | Loot table loaders and planet rules: tier tables (`LOOT_TABLES`, `getTierTable`, `getTierLabel`), `LootCategory`/`LOOT_CATEGORIES`/`lootCategoryOf`, planet curves (`PLANET_GRADE_CURVES`, `getPlanetGradeCurve`, `planetRarityWeights`), planet-bound drops (`PLANET_BOUND_CATEGORIES`, `lootPlanetsOf`, `isLootableOnPlanet`, `libraryVolumeWeight`, `planetCategoryAvailable`, `libraryBookPool`, `planetSeedPool`), retirement (`RETIRED_ITEM_IDS`, `isLootableDef`), corpse tables (`CORPSE_TABLES`, `CORPSE_TABLE_MAP`, `DEFAULT_ROGUE_WEAPON_ID`), named drops (`NAMED_DROPS`, `NAMED_DROP_MAP`, `numberedArmorIdForTier`), faction corpses (`FACTION_LOOT`, `FACTION_LOOT_MAP`, `FACTION_SITE_BONUSES`, `getFactionSiteBonus`) |
| `Loot.ts` | `LootService implements LootRef` — def lookups, `createItem`, stats/repair/salvage wrappers, `rollCrate(On)`, `rollCorpse(On)`; `nextUid()` |
| `ItemSpec.ts` | `itemSpecRows(def)` — tooltip spec rows for healing items, shield chargers, boosts, gadgets and grenades (first row is always `사용 시간`); values are strings or `SpecSeg[]` (numbers highlighted), `SpecRow.tone`, labels `SPEC_LABEL_KO` |
| `ItemText.ts` | `parseItemText(text)` → lines of styled spans for description markup `{em}…{/em}`, `{dim}…{/dim}`, `{br}` (unknown tokens stay literal); `plainItemText` |

## Public API

**`ctx.loot` (`LootRef`, three `interface LootRef` blocks in `src/shared/types.ts`)** — implemented by `LootService`:

- defs: `getItemDef`, `getWeaponDef`, `getArmorDef`, `getAllItemDefs`, `getAllRecipes`
- instances: `createItem(defId, qty?, extras?)` — clamps qty to `stackMax`, resolves aliased ids (instance `defId` is the new id);
  weapons start at max durability with a full magazine (extended mag counted) unless `extras` override; uniques drop `extras.sockets`
- weapons: `getEffectiveStats(inst | weaponId | itemId)`, `canAttach(weapon, attachment)`
- economy: `getRepairCost(inst)`, `durabilityBucketOf`, `durabilityBucketInfo`, `getCraftCostOf(defId)`, `getSalvageFor(inst)`
- loot: `rollCrateOn(tier, rng, planet, opts?: CrateLootOpts)`, `rollCorpseOn(type, rng, weaponId, planet, opts?: CorpseLootOpts)`,
  and the planet-less `rollCrate(tier, rng?)`, `rollCorpse(type, rng?, weaponId?)`

Callers of the roll functions: `inventory/Container.ts`, `inventory/parts/Peek.ts`, `inventory/parts/Allies.ts`,
`inventory/parts/ContainerNet.ts` (crates, previews), `enemies/Corpses.ts`, `world/structures/parts/Containers.ts`,
`gadgets/drones/parts/Scan.ts`. Seeds come from `src/shared/lootRolls.ts` (`crateLootRandom`, `corpseLootRandom`); a
structure container's `CrateLootOpts` comes from `WorldRef.crateLootOpts(id)` and every crate path passes it unchanged.

Direct `@/items` imports: `inventory/` (grids, crafting, tooltips, sort, durability), `weapons/` (`model.ts`, `Firing`, `Healing`,
`WeaponDefaults`), `ui/hud/ItemTip.ts` and `WeaponPanel.ts`. `scripts/data-check.mjs` loads `ItemDefs`, `Recipes`, `LootTables`,
`Salvage` for cross-reference checks.

## Ids and categories

- Weapons: grade I id = family id (`ar`), higher grades `${family}_g${g}` (`ar_g3`); item id `wpn_<weaponId>`. Uniques `u_*` / `wpn_u_*`.
- Ammo `ammo_<type>` (`qty` = rounds, `stackMax` = `AMMO_STACK_ROUNDS[type]`). Unique calibres are `UNIQUE_AMMO_TYPES`.
- Library media: `book_<series>_<volume>`, `disc_<series>_<volume>`, `record_<series>` (`libraryItemIdFor`); name = series name + roman
  numeral unless single-volume. Games: `console_*`, `game_*`.
- Generated salvage recipe id: `break_<itemId>`.
- Categories come from the csv `category` column (`ItemCategory` in `src/shared/types.ts`). Grenades are `category: 'gadget'` with
  `ItemDef.grenade` (`frag` | `fire`); `ItemDef.grenadeFire` marks the fire-zone grenade.
- Optional-column fields appear only when their csv cells are filled: `soil` (`soilTag` …), `prep`, `pouch`, `strain`, `medium`,
  `scaffold`, `retired`, `sample`, `growSocket`, `meal`, `book`/`disc`/`record`, `gameDisc`.

## Weapons

- **Grades** (`buildGrade`): damage, max durability and value scale by `WEAPON_GRADE_*` constants; fire rate by the family's
  `fireRateGradeStep`; spread, ADS spread and recoil by `WEAPON_GRADE_HANDLING_MUL` (`tables.csv`). The csv handling columns are the
  **grade V reference**; ADS time and `swayMul` take the same multiplier in `baseWeaponStats`. Rarity = grade.
- **Sockets**: a class accepts only the sockets listed in `weapons.csv` `sockets` (→ `WeaponDef.sockets`, `EffectiveWeaponStats.sockets`).
  `canAttach` checks socket, then attachment `classes`, then `ammoTypes`. `computeWeaponStats` folds only `fittingAttachments`, so an
  attachment the weapon no longer accepts has no effect (inventory detaches it on load).
- **Stats**: falloff fields are always filled (no falloff = start = end = range, min 1); use `damageFalloffStats(stats, d)` — it includes
  attachment effects — rather than `damageFalloff(def, d)`. `projectileSpeed`/`bulletGravity` come from the def (× attachment `bulletDrop`).
  Bloom comes from the family row; uniques use `WEAPON_BLOOM_*_DEFAULT` (`tuning.csv`).
- **Uniques**: **mythic** rarity (2026-09-16 — written in `weaponItemDef`, since `weapons_unique.csv` has no `rarity` column and they
  have no grade), no grade scaling, no family, no sockets (`canAttach` false), dedicated `ammoType`, `altFire: true` (RMB is the alternate
  fire; the bow uses RMB to cancel the draw). Name is the nickname alone (the kind label is drawn by the UI). The csv `class` is
  bookkeeping: uniques get no shooting-skill bonus/XP and their kills are not class kills — consumers check `def.unique`. Magazines and
  durability are `UNIQUE_WEAPON_MAG` / `UNIQUE_WEAPON_DURABILITY`; damage numbers are the shared `FLAME_*`, `SHOCK_*`, `SHURIKEN_*`,
  `BOW_*`, `BAZOOKA_*`, `MINIGUN_*` constants.

## Gear and consumables

- **Armor is a shield pool**: `ArmorDef.shield` (`=ARMOR_SHIELD_BY_TIER.n`); `damageReduction` is kept only as the conversion source for
  unique armor and is read nowhere. Perks (`regen`, `ultralight`, `optical`) are declared here and implemented in `src/player`.
- **Shield chargers**: rows with `shieldUseTime`/`shieldHp` → `SHIELD_CHARGE_MAP` (`shieldHp < 0` = full refill, `Infinity`). They are
  `category: 'stim'`, so quick slots, loot and hand pose follow healing items; the effect goes to `PlayerRef.chargeShield`.
- **Boosts**: `boostEffect`/`boostUseTime` → `BOOST_ITEM_MAP` (`adrenaline`, `stimulant`, `implant_refill`).
- **Bags**: `quickSlots` capped at `QUICK_SLOTS`; `durabilityMax` wears per raid (inventory applies it) and follows armor repair/salvage.
- **Implants**: only broken twins drop (tier tables zero working implants; corpse `implantWeights`); working implants come from the
  Ceres shop and repair desk (`src/meta`). Slot rules live in `src/progression`.
- **Pouches**: `pouchAccepts` is validated with `enumList` against `ITEM_CATEGORIES`; a pouch accepting nothing is reported.
- **Meals are not items** (2026-09-16): `data/meals.csv` is parsed by `src/shared/meals.ts` (`MEAL_DEFS`, `getMealDef`) and
  `ITEM_DEFS` has no meals — `getItemDef('meal_*')` is undefined. Cook-bench recipes still name a meal id as `outputDefId`
  (data:check resolves it in the meal table). Old saved meal items resolve to unknown defs (no alias rows, no refund).
- **Samples**: 17 defs — `cell` · `mineral` run I…VI, `dna` runs I…V (2026-09-17: mythic is the gun line only, so
  `spec_gene_6` was deleted with the two mythic sockets it fed). The **tile background is the rarity colour** (the `def()` default — a sample's rarity
  is the floor of what analysing it yields) and the **glyph is the family** (`SAMPLE_FAMILY_ICON`). `ItemDef` has one `color`, which
  drives the whole tile (`--rc`), so the family colour (`SAMPLE_FAMILY_COLOR`) stays on the analysis screens only.
- **Samples / sockets / strains / media / soils**: families `cell` | `mineral` | `dna`; `first*` columns must stay empty. Analysis results,
  wear, sockets and culture are `src/housing`; items only define them. `soilDurability` is required when `soilTag` is set,
  `mediumDurability` when `mediumUses` is set, the three `strainScaffold*` columns go together.
- **Library series**: one `library_series.csv` row = one series; `libraryItemDefs(medium)` generates one item per volume. Effects, shelf
  math and recipe unlocks are `src/housing` (`src/shared/library.ts` loads the effect columns). Values: `BOOK_VALUE_BY_VOLUME`,
  `DISC_VALUE_BY_RARITY` × `DISC_VALUE_VOLUME_STEP`, `RECORD_VALUE_BY_RARITY`.
- **Card text**: descriptions carry no numbers. `ItemSpec.itemSpecRows` renders them from `constants.csv` values and item columns
  (`gadgetUseTime` — blank for the defibrillator falls back to `DEFIB_USE_TIME_S`, `durabilityMax`, `heal*`); both tooltips
  (`ui/hud/ItemTip`, `inventory/ui/Tooltip`) call it and `parseItemText`, each with its own palette.

## Loot rolling

**Crates** (`rollCrateWithCurve`): roll item count → guaranteed picks → one weapon-chance draw → category draws until full (at most one
bag; a category with no candidate is dropped for this crate and the draw repeats; categories with no candidate on this planet are not
offered) → re-grade weapons by the planet curve → each unique weapon adds one stack of its calibre → materialise, merge stacks, found gear
gets 55–100 % durability → sort largest area first. `pickDef` applies `itemWeightMul`, retirement, planet binding, planet rarity weights
and the epic+ gate (below).

**Loot category axis**: `LootCategory` = `ItemCategory` + `'grenade'` (`lootCategoryOf`: items with `ItemDef.grenade` are `grenade`).
`loot_category_weights.csv` and `loot_guaranteed.csv` use this axis and the loader validates the names.

**Planet rules** (`planet_loot.csv`, rank = `planetTier()` = row order of `planets.csv`):

- `g1..g5` re-grade crate weapons (`regrade`); weight 0 seals a grade. Corpse weapons are only capped at `maxGrade`.
- `uniqueMul` gates unique weapons and unique ammo: 0 removes them from candidates; between 0 and 1 a failed gate turns the pick into a
  normal gun / calibre. The ammo stack that accompanies a rolled unique is exempt.
- `rareMul`/`epicMul`/`legMul` scale rare+ rarity weights and give the removed weight back to common/uncommon in their original ratio
  (total unchanged) — applied in `pickDef` (all crate tiers) and to corpse `implantWeights`; not to `loot_corpses.csv` rows, boss
  attachments or gun grades. All three = 1 returns the base table object untouched. These are *weight* multipliers, so they cancel in
  guaranteed picks whose candidates are all rare+/epic+ and do nothing in the `relaxRarity` fallback.
- `epicPlusMul` is the **epic+ gate** (the `keep` value in `Loot.ts`): whenever any roll yields an epic or legendary item, it is kept with
  probability `epicPlusMul`, otherwise replaced by the highest rarity below epic **from the same candidate pool** (weighted by the same
  rules; a guaranteed pick ignores its `minRarity` for this). So the chance that a pick is epic+ is exactly × `epicPlusMul`, including
  guaranteed and fallback picks. Crates: `pickDef` (non-weapons; a pool with nothing below epic — keys, records — returns null, so the
  category is redrawn), `regrade` (curve grades IV–V and surviving uniques → the highest curve grade below epic). Corpses: epic+
  `loot_corpses.csv` rows and site-bonus items (chance × keep), carried weapon grade (after the planet cap), boss attachment, boss unique
  chance, book, broken implant, faction armor/bag/heal, site seeds, named drops. **Exempt:** lab locked-room containers
  (`CrateLootOpts.lockedRoom`, set by `world/Structures.ts`) and every planet-less roll. `keep >= 1` consumes no extra draw.
- Planet-bound categories (`book`, `disc`, `record`, `game_disc`, `console`) only pick items of the raid planet, weighted by
  `LIBRARY_VOLUME_DROP_WEIGHT`; with `planet = null` every planet-bound item is a candidate.

**Corpses** (`rollCorpseWithMax`), fixed draw order: `loot_corpses.csv` rows → carried weapon (grade from faction `weaponGrades`, or the
site's `grades` row, capped by planet) + ammo → boss attachment → boss unique (`chance × uniqueMul`) → book (raid planet's pool) →
broken implant → faction armor → bag → heal (`rollFactionGear`) → site bonus items → carried grenades (no rng) → named guaranteed drop.
An enemy type with no table yields one `mat_bio_sample`. `CorpseLootOpts` (`site`, `grenades`) is passed identically by host
(`Enemy.site`, `grenadeCount`), replicas (`ee corpse.si/gc/gk`) and drone-scan previews, so the result is a pure function of its inputs.

**Named drops** (`loot_named.csv`) are keyed by enemy type only, ignore every planet curve except the epic+ gate (`epicPlusMul`), and set
durability from `NAMED_LOOT_DURABILITY_MIN/MAX`.

## 프로세서 (연산 클러스터)

**2026-09-16 (채광 개편, 사용자 결정) — the processor is crafted, not found, and it wears out.** `mat_compute_core` (연산 코어) was
deleted outright; the processor plugs straight into the compute cluster, so `COMPUTE_CORE_DEF_ID` in `shared/housing.ts` no longer
resolves to an item def. `mat_processor` is a `material` with `durabilityMax` 500: the cluster wears it down each mining cycle
(`src/housing`) and the ship workbench repairs it. It has weight 0 at **every** crate tier (`loot_item_weights.csv`), is on no corpse
table and in no shop — the only source is the mining chain 광맥 → 미확인 광물 → 분석기 → 쌍정석 + 연마재 → 결정 코어 (추출기) →
`mix_processor` (조합대 Lv.3: 결정 코어 1 + 회로 기판 4 → 프로세서 1). Cluster capacity is `COMPUTE_CLUSTER_MAX_CORES`; mining yield
per plugged processor is `data/crypto.csv` (`shared/cryptoMarket.ts`).

Because it carries durability **and** has a craft recipe, it is repairable and salvageable like gear: `wearsDurability` in `Salvage.ts`
keys on `durabilityMax`, not on the category, so `repairCostFor` derives the repair bill from `mix_processor`'s inputs and
`checkSalvageEconomy` checks all five buckets. A future durable item in any category is covered automatically — except a healing spray,
whose `durabilityMax` is a liquid gauge and is excluded by name in the same predicate.

## Crafting, repair and salvage

- `station: 'field'` recipes also work on the ship; `bench` is the workbench window a recipe appears in; `station: 'ship'` recipes need
  that bench at `benchLevel` (filtering is `inventory`). Cook-bench recipes are excluded from generic crafting by `inventory`.
- **Value index**: `CRAFT_COST_BY_OUTPUT` indexes recipes with `outputQty === 1` (first recipe per output). Alternative recipes with
  `outputQty ≥ 2` never change an item's repair/salvage basis.
- **Repairable / salvageable**: `REPAIRABLE` / `SALVAGEABLE` categories (weapons, armor, bags) **or** anything carrying
  `durabilityMax > 0` (`wearsDurability` — durable gadgets, the processor; healing sprays are excluded, their gauge is `inventory`'s
  `sprayRepairCost`). Buckets: 20 % steps, 0 = 0–20 % … 4 = 81–100 % (items without durability are bucket 4).
- Repair = craft inputs × `REPAIR_COST_BY_DURABILITY[bucket]` rounded **up**; salvage = × `SALVAGE_YIELD_BY_DURABILITY[bucket]` rounded
  **down**, with only the largest input guaranteed `SALVAGE_MAIN_MIN_YIELD`.
- **Mythic materials never come back out of salvage** (2026-09-16, user decision): `salvageYieldOf` drops every `rarity === 'mythic'`
  input from the salvage baseline. Unique weapons *are* salvageable — they have craft recipes now (`make_wpn_u_*`, one mythic mineral
  each) — but 「신화 광물 1 → 제작 → 분해」 must not return the mineral, so the rule is cut on **rarity**, not on "is it unique": any
  future item that eats a mythic material inherits it. Yield only shrinks, so `checkSalvageEconomy` stays satisfied. Their repair uses
  **their own** craft inputs (so it costs a mythic mineral); `fallbackCraftCost` × `UNIQUE_REPAIR_MUL` is left for the three perk armors,
  which still have no recipe.
- `needsRepairCost(def)`: a durable item with a craft recipe must never have an empty repair cost when worn; inventory refuses such a
  repair and `checkSalvageEconomy` reports it.
- `getAllRecipes()` lists generated salvage at bucket 4. Consumers must use `getSalvageFor(inst)` for the actual quantities.
- `checkSalvageEconomy()` (run by `npm run data:check`) checks every salvage recipe × bucket: salvage ≤ inputs; repair + salvage ≤ inputs
  with one input strictly less; salvage(4) − repair(b) ≤ salvage(b); no output that is not an input; non-empty repair cost; every
  non-unique weapon def has a craft recipe.
- Upper-tier materials (`mat_ingot`, `mat_machine_parts`, `mat_capacitor`, `mat_control_module`, `mat_weave`, `mat_ballistic_fiber`) come
  from the refine bench, from crates at a constrained share (tiers 3–5), and — intentionally — from salvaging grade IV–V gear.

## Rules

- **Never shift existing rng draws.** New roll steps are appended at the end of `rollCrateWithCurve` / `rollCorpseWithMax`; the
  `planet = null` path must consume no extra draws; `rng.chance` consumes one draw regardless of the multiplier. Adding rows to a corpse
  table shifts that table's draws — `src/inventory/__selftest__.ts` pins fixed outputs for `warrior`, `rogue`, `rogue_boss`. — `Loot.ts`
- **Previews use the real roll.** Drone scan and inventory peek call `rollCrateOn`/`rollCorpseOn` with seeds from `src/shared/lootRolls.ts`;
  never copy the roll or seed formula into another folder.
- **Every crate roll path passes the same `CrateLootOpts`** (`WorldRef.crateLootOpts(id)`), or a locked-room preview and its open differ.
  The epic+ gate is on results, not weights — guaranteed picks must not be exempt. — `Loot.ts` (`gatePick`, `pickDef`, `regrade`)
- **Keep `grenade` a separate loot category.** Merging its weight into `gadget` changes grenade/gadget relative frequency; the separate
  axis keeps same-seed crates identical. — `LootTables.ts` (`lootCategoryOf`)
- **Retired items are excluded in code**, not only in csv: `isLootableDef` in `pickDef` (including the `relaxRarity` fallback), faction
  pools and seed pools. — `LootTables.ts`
- **Do not decide repair/salvage by category**; `durabilityMax` decides (`wearsDurability`). Adding `'gadget'` or `'material'`
  wholesale would give non-durable smokes / scrap generated salvage recipes and bucket checks they cannot satisfy. — `Salvage.ts`
- **Alias resolution**: `ITEM_DEF_MAP` knows exact ids only; use `getItemDef` / `LootService.getItemDef` / `createItem` for ids that may come
  from old saves. Save migration itself is `housing` and `inventory`. — `ItemDefs.ts`
- **`ItemSpec.ts` must not import `src/gadgets`**; it reads the same shared constants. `GadgetDef` owns behaviour, the spec table owns card
  rows. Descriptions must not repeat numbers the spec rows show.
- Description markup uses the same `{token}` syntax as `shared/keycap.renderKeyText`; an unknown token renders literally. — `ItemText.ts`

## Recent changes

Last 5 only — older: `git log -- src/items`.
- 2026-09-17 — `spec_gene_6` (미확인 유전자 VI) and the mythic sockets `sock_soil_prime` · `sock_medium_prime` deleted from csv (no aliases): mythic is reserved for the gun line, so the 유전자 family tops out at legendary.
- 2026-09-16 — The 6 unique weapons are **mythic** (`weaponItemDef`); `isSalvageable` now bans their salvage by name (they gained craft recipes), and sample tiles read rarity as the background with the family as the glyph.
- 2026-09-16 — `Salvage.wearsDurability` keys on `durabilityMax` instead of the category (the processor is a durable `material`); healing sprays are the one exception.
- 2026-09-16 — `Salvage.isCraftRefundable` / `maxSkillCraftFactor`: durable gear (weapons · armor · bags · durable gadgets) is excluded from the craft-skill material refund, and `checkSalvageEconomy` now measures every craft baseline at **max skill** (`craft × maxSkillCraftFactor`).
- 2026-09-16 — Meals removed from `ITEM_DEFS` (`MEAL_ITEM_DEFS` gone); `data/meals.csv` is parsed by `shared/meals.ts`.
