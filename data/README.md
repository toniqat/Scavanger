# data/ — source of every gameplay number

Every number in the game — damage, HP, prices, chances, cooldowns, weights, grid sizes — lives in the csv files in
this folder. `src/` holds no copies: TypeScript loaders read these tables and convert rows into typed objects.

To rebalance, edit csv only. Any editor works (Excel, Sheets, a text editor). With `npm run dev` running, saving a
csv reloads the game (the files are inlined through Vite, so HMR picks them up).

```
npm run data:check              # validate the csv (typos, missing cells, ranges, unknown names, cross-references)
npm run data:check -- --write   # also regenerate server/economy.gen.json (see "Validation")
```

Each csv starts with `#` comment lines that document its columns and the reasoning behind non-obvious values.
**Read the header of a file before editing it.**

## File map

One line per csv. "Loader" is the parsing module under `src/`; values usually take effect in other folders too
(`scripts/data-owners.mjs` `CSV_FOLDERS` lists the consuming folders).

### Global tables

| File | What it holds | Loader |
|---|---|---|
| `constants.csv` | Global scalars (`key,value,note`): player, movement, gravity, extraction, implants, gadgets, stratagems, hazards, explosions, minigame windows, tutorial, light budget … Exported one-by-one from `src/shared/constants.ts` | `shared/constants.ts` (also `shared/cooking.ts`, `enemies/factionTables.ts`) |
| `tables.csv` | Named number/string tables (`table,key,value`): ammo stacks, rep levels (`REP_TABLE`), armor shield by tier, repair/salvage durability multipliers, per-threat and per-squad-size tables, meal quality … | `shared/data/tables.ts` helpers, many callers |
| `tuning.csv` | Folder-local scalars (`key,value,note`): default item weight, value multipliers, bag capacity per cell, grid cell sizes, NPC log limits … | many (`items/`, `meta/Rules.ts`, `progression/defs.ts`, `shared/housing.ts`, `shared/meta.ts`, `shared/npc.ts`, `shared/crypto.ts`, `shared/intelDefs.ts`, `inventory/ui/labels.ts`) |
| `currencies.csv` | Currency definitions (credits, XP, rep). The `rep` row is a template expanded per corp from `corps.csv` | `shared/currency.ts` |

### Weapons and gear

| File | What it holds | Loader |
|---|---|---|
| `weapons.csv` | Graded weapon classes (AR, SMG, SG, DMR, SR). One row per class at grade I; II–V derive from `WEAPON_GRADE_*` in `constants.csv` and `WEAPON_GRADE_HANDLING_MUL` in `tables.csv`. Ballistics (`projectileSpeed`, `bulletGravity`), bloom, `sockets` | `items/WeaponDefs.ts` |
| `weapons_unique.csv` | Legendary unique weapons. `nickname` is the display name; `class` is required but not used for class rules | `items/WeaponDefs.ts` |
| `aim_sway.csv` | ADS sway amplitude/frequency per weapon class (stance/move multipliers are `AIM_SWAY_*` in `constants.csv`) | `weapons/AimSway.ts` |
| `attachments.csv` | Weapon attachments: socket, allowed classes, stat multipliers, weight | `items/ItemDefs.ts` |
| `ammo.csv` | Ammo types: value, per-round weight | `items/ItemDefs.ts` |
| `armor.csv` | Armor (= shield pool). Numbered armor points at `=ARMOR_SHIELD_BY_TIER.n`; `damageReduction` is legacy and unused by combat | `items/ArmorDefs.ts` |
| `bags.csv` | Bags: grid `cols`×`rows`, `quickSlots`, `durabilityMax` | `items/ItemDefs.ts` |
| `implants_repair.csv` | Implant item value and repair materials by rarity | `items/ImplantDefs.ts` |
| `implants_perks.csv` | Legendary implant perks | `items/ImplantDefs.ts` |

### Items, food, research, library

| File | What it holds | Loader |
|---|---|---|
| `items.csv` | General items: grenades (`grenade`, `grenadeFire`), healing, shield chargers (`shieldUseTime`, `shieldHp`), combat boosts (`boostEffect`, `boostUseTime`), gadgets (`gadgetId`, `gadgetUseTime`, `durabilityMax`), valuables, materials, herbs, crops, soils (`soilTag`, `soilDurability`), media, preps (`prepEnv`, `prepShort`), pouches, cell strains, keys, `retired` | `items/ItemDefs.ts` |
| `seeds.csv` | Seeds: grow time, yield, `soilTag`, `weight` | `items/ItemDefs.ts` |
| `samples.csv` | Unidentified specimens: `family` (`cell` \| `mineral` \| `dna`), base analysis hours, fallback reward, `retired` | `items/ItemDefs.ts` |
| `analysis_results.csv` | Analyzer result table: family × `minLevel` × output × qty × weight | `shared/housing.ts` |
| `sockets.csv` | Permanent soil/medium sockets: target, effect, amount | `items/ItemDefs.ts` |
| `meals.csv` | Meals (not items — a finished cook is a dining plate): `tier` and `effects` (`buff:amount` list; tier n = n lines), `retired`; `stackMax` · `value` · `weight` are unread leftovers | `shared/meals.ts` |
| `cook_steps.csv` | Cooking minigame steps per meal (`order`, `game`, `items`, `liquid`, `targetMl`) | `shared/cooking.ts` |
| `cook_grill.csv` | Grill cook time per ingredient (default `COOK_GRILL_DEFAULT_S`) | `shared/cooking.ts` |
| `library_series.csv` | Library series (book / video / record): volumes, planets, effect lines at full series, rarity, skill. Media items are generated from these rows | `shared/library.ts`, `items/ItemDefs.ts` |
| `item_aliases.csv` | Retired item id → replacement id, applied when reading saves and in `getItemDef`/`createItem` | `shared/library.ts` (`resolveItemAlias`) |
| `game_consoles.csv` | Game consoles (spec, rarity, planets) | `items/ItemDefs.ts` |
| `game_discs.csv` | Game discs: console, trained stat, minigame, tuning multipliers, pattern, color, planets | `items/ItemDefs.ts` |

### Crafting and economy

| File | What it holds | Loader |
|---|---|---|
| `recipes.csv` | Crafting recipes: `station` (`field` \| `ship`), `bench` (the workbench the recipe belongs to), `benchLevel`, `inputs`, outputs, `skill` (XP + material refund; `skillRequired` is kept at `0` and unread since 2026-09-16). Also the value source for repair cost and gear salvage | `items/Recipes.ts` |
| `salvage.csv` | Hand-defined salvage only (ammo, some materials/chargers). Weapon, armor, bag and durable-gadget salvage is generated from `recipes.csv` | `items/Salvage.ts` |
| `corps.csv` | The 4 corporations | `shared/meta.ts` |
| `corp_stock.csv` | Shop rules per corp: category, classes/ammo, rep level, max rarity, implant repair materials | `shared/meta.ts` |
| `contracts.csv` | Corp contracts: goal, target, rep level, rewards, `itemDefId` for `extract_with_items` | `shared/meta.ts` |
| `crypto.csv` | Mining coins: corp, `unlockQuest`, cycle, yield, base price, volatility | `shared/crypto.ts` |
| `intel_options.csv` | Intel broker gimmicks: effect, base cost, max tier, min threat | `shared/intelDefs.ts` |

### NPCs and progression

| File | What it holds | Loader |
|---|---|---|
| `npcs.csv` | Messenger NPCs: corp, role, first-contact requirements (`reqLevel`, `reqRep`, `reqQuests`, `reqFlag`, `reqNpcRep`), `intro` → `introChoices`/`introChoiceReplies` → `introAfter` | `shared/npc.ts` |
| `npc_quests.csv` | NPC quests: requirements, rewards (`rewardCredits`, `rewardXp`, `rewardRep`, `rewardItems`, `npcTrust`), dialogue lines. Offered per NPC in row order | `shared/npc.ts` |
| `npc_objectives.csv` | Quest objectives (`kind` deliver / recover / interact / kill / discover / search, `planet`, `chain`). Row order = display order | `shared/npc.ts` |
| `stats.csv` | Character stats; `derived` = character-sheet rows the stat affects | `progression/defs.ts` |
| `skills.csv` | Skills: linked `stats`, `weaponClass`, `derived` | `progression/defs.ts` |

### Enemies and loot

| File | What it holds | Loader |
|---|---|---|
| `enemies.csv` | Enemy base stats per type, `faction`, `stepSound`, `raidXp` (character XP per kill at raid end — the only raid XP source; not extracted × `XP_DEATH_MUL`) (bugs, humanoid factions, named, tutorial-only types) | `enemies/EnemyTypes.ts` (also `meta/Rules.ts`, `meta/NpcRules.ts`) |
| `enemy_abilities.csv` | Ability/AI blocks (`block,key,value`): leap, acid, charge, artillery, humanoid AI, `HUMANOID_WEAPONS` | `enemies/EnemyTypes.ts` |
| `loot_tiers.csv` | Crate tiers: item count, rarity weights, weapon chance, stack/ammo fractions | `items/LootTables.ts` |
| `loot_category_weights.csv` | Crate category weights per tier (loot category axis, see `LootCategory`) | `items/LootTables.ts` |
| `loot_guaranteed.csv` | Guaranteed picks per tier | `items/LootTables.ts` |
| `loot_item_weights.csv` | Per-item multipliers per tier (`0` = never from crates) | `items/LootTables.ts` |
| `loot_corpses.csv` | Enemy corpse drops (independent chance per row) | `items/LootTables.ts` |
| `loot_corpse_samples.csv` | Corpse 미확인 표본 rolls: chance → count → a tier per unit (`tiers` = `tier:weight` \| …, family × tier → `samples.csv`) | `items/LootTables.ts` |
| `loot_corpse_rolls.csv` | Corpse weapon/unique/book/broken-implant rolls per type | `items/LootTables.ts` |
| `loot_factions.csv` | Humanoid faction corpses: gun grades, armor/bag/heal chance, pool and rarity, gear durability | `items/LootTables.ts` |
| `loot_faction_sites.csv` | Spawn-site bonuses for faction corpses (`grades` \| `item` \| `seed`) | `items/LootTables.ts` |
| `loot_named.csv` | Named rogue guaranteed drops (ignores planet curves; durability is `NAMED_LOOT_DURABILITY_*`) | `items/LootTables.ts` |
| `planet_loot.csv` | Per-planet-rank curves: gun grade weights `g1..g5`, `uniqueMul`, non-gun rarity weight multipliers `rareMul`/`epicMul`/`legMul`, and the epic+ gate `epicPlusMul` (lab locked rooms exempt) | `items/LootTables.ts` |

### World, ship, planets

| File | What it holds | Loader |
|---|---|---|
| `planets.csv` | Planets (row order = difficulty rank): `threat`, biome, sky/fog, bugs, gather nodes, soils, seeds, samples, `env`, `hazards` | `shared/planetDefs.ts` (also `world/flora.ts`, `world/soil.ts`, `world/specimen.ts`, `items/LootTables.ts`) |
| `structures.csv` | Abandoned structures, rail platforms, trams: counts, sizes, containers, basement/upper-floor chances, crate tiers, key and locked-room columns, `basementBonus*` (per-basement-container bonus item · chance · planets — the thumper) | `world/structures/model.ts` |
| `hazards.csv` | Environmental hazard visuals (fog color/multiplier, particles, walls). Rule numbers are `HAZARD_*`/`STORM_EYE_*`/`SPORE_*` in `constants.csv` | `world/hazard/model.ts` |
| `stratagems.csv` | Ship calls; `cooldown` is the single cooldown shared by all calls after use | `shared/constants.ts` |
| `room_purposes.csv` | Room purpose build cost and required `generator` level | `shared/housing.ts` |
| `facility_upgrades.csv` | Generator and storage level costs | `shared/constants.ts` |
| `furniture.csv` | Furniture: room, footprint, model, interaction, craft cost, `maxLevel`, `access`, `multi`, `low`, `retired` | `shared/housing.ts` |
| `furniture_upgrades.csv` | Furniture level-up costs | `shared/housing.ts` |

## How to edit

### What you may change

- **Value cells** — freely. That is the point of this folder.
- **Identifier cells** (`id`, `key`, `table`, `type`, `category`, `kind`, `block` …) — do not rename. Code looks rows up
  by these names; `data:check` reports a missing row.
- **Rows** in list-style tables (items, enemies, recipes, contracts, quests …) may be added or removed, except rows code
  names explicitly (keys in `constants.csv`, the enemy types code references).
- **Column order** does not matter; loaders find columns by header name. Header typos are reported.

### Format

- Lines starting with `#` and blank lines are comments. The header is the first non-comment line.
- Values containing commas (most Korean descriptions) are wrapped in `"quotes"`; a literal quote is `""`.
- Empty cell = "none". Optional fields (e.g. weapon `adsZoom`) are omitted from the object when blank.
- Lists are `|`-separated: `AR|SMG|SG`.
- "Item × count" cells are `defId:qty` joined by `|`: `mat_scrap:8|mat_cable:2`.
- Numbers accept `1_000`, `1e3`, and hex colors `0xffd27a`. Booleans: `true`/`false`/`1`/`0`/`y`/`n`.
- Angles are written in degrees (`spreadDeg`, `recoilDeg`); code converts to radians.
- Array-style tables in `tables.csv` use keys `0..n` with no gaps. Convention: `*_BY_THREAT` key `0..2` = planet threat
  1..3; per-squad tables key `0..3` = squad size 1..4; durability-bucket tables key `0..4` = 0–20 % … 81–100 %.

### `=` formulas — referencing other values

A cell starting with `=` is an expression: names, numbers, `+ - * / ( )` and nothing else.

```csv
u_flame,인페르노,flamethrower,...,=FLAME_DPS,=FLAME_ALT_DPS,...,=FLAME_CONE_DEG/2
armor_3,방탄복 III,3,rare,...,=ARMOR_SHIELD_BY_TIER.3,...
ar,AR,...,=4.2*1.2,...
```

Names resolve in this order (`src/shared/data/tables.ts`, `setNumberRefResolver`):

1. a key in `constants.csv` — `=FLAME_DPS`
2. a key in `tuning.csv`
3. `TABLE.key` in `tables.csv` — `=ARMOR_SHIELD_BY_TIER.3`

Use a formula whenever the same number is also used by code, so that one edit moves both.

### Adding a new value

- **Global constant**: add a row to `constants.csv`, then `export const X = K.num('X');` in `src/shared/constants.ts`.
- **Folder-local scalar**: add a row to `tuning.csv`, read it with `keyTable('tuning.csv').num('X')` in a module listed in
  `DATA_OWNERS` (otherwise `data:check` reports the key as unread).
- **New table**: create `data/<name>.csv` (the glob picks it up), write the loader, and add the loading module to
  `DATA_OWNERS` and the file to `CSV_FOLDERS` in `scripts/data-owners.mjs` (otherwise it is reported as an orphan).

### Rules that span files

- **Gear value lives in `recipes.csv`.** Repair cost and salvage yield of weapons, armor, bags and durable gadgets are that
  item's craft inputs × `REPAIR_COST_BY_DURABILITY` / `SALVAGE_YIELD_BY_DURABILITY` (`tables.csv`). A durable item's recipe
  needs **≥ 2 of each input**; otherwise repair (rounded up) plus the salvage minimum can create materials.
  `src/items/Salvage.ts` (`checkSalvageEconomy`) proves "craft → repair → salvage" never profits on every run of `data:check`.
  When changing ammo craft amounts, move `salvage.csv` in the same edit.
- **Craft material refund** (2026-09-16, `tuning.csv` `CRAFT_REFUND_CHANCE_AT_MAX`): a recipe's `skill` refunds consumed material
  **per unit**, up to that chance at skill 100 (`src/shared/craftRefund.ts`). **Durable gear is excluded** — weapons, armor, bags and
  durable gadgets pay their repair / salvage out of the very `inputs` the refund would discount. `checkSalvageEconomy` therefore reads
  every craft baseline as `inputs × maxSkillCraftFactor(recipe)`, so raising the chance or making gear refundable fails `data:check`
  immediately (the hand-written rows in `salvage.csv` are the ones that actually compete with the discounted baseline).
- **Retiring an item**: set `retired` (items, samples, meals, furniture) instead of deleting the row. The def stays so owned
  copies survive, but it must not appear in any source; `data:check` fails if a recipe, loot table, analysis result, planet or
  strain output references a retired id. Crate rolls also skip retired defs in code (`LootTables.isLootableDef`).
- **Deleting an item def**: add `from,to` to `item_aliases.csv` unless the loss is intended.
- **Economy table**: changing item value or stack size, implant repair cost, contract/quest credit rewards, shop/sell
  multipliers, `CREDITS_MAX` or `crypto.csv` makes the relay's `server/economy.gen.json` stale — run
  `npm run data:check -- --write` and commit the json with the csv.
- **Quest ids** are lowercase `[a-z0-9_]` and are the server credit-ledger key (`quest:<id>`): renaming one makes its credits
  claimable again. Coin unlock quests (`crypto.csv` `unlockQuest`) need `rewardCredits > 0`.
- **NPC objective content convention** (`npc_objectives.csv`): objectives that need a gimmick that only spawns by chance (tram,
  lab locked room, basement door) are rare — one quest each — and the key/keycard for such a door is a reward of an earlier quest;
  those objectives get no `chain`, so progress accumulates across raids. Scope enemy conditions by `planet` (android = threat 1,
  raider-only = threat 3); `named` only in late quests without a planet condition. Quest dialogue is re-read from the csv, so
  editing a line also changes past conversations.
- **Loot draw order**: adding rows to a corpse/crate table shifts rng consumption for that table; seeded tests that count fixed
  rolls may change.
- **Two loot axes plus a gate**: `planet_loot.csv` `g1..g5` shapes gun grades only; `loot_tiers.csv` rarity weights (scaled by
  `rareMul`/`epicMul`/`legMul`) shape everything else. Those weight multipliers cancel in guaranteed picks (`loot_guaranteed.csv`)
  whose candidates all sit above the scaled rarities. `epicPlusMul` is applied to *results* instead: any epic/legendary outcome — crate
  pick of any kind, gun grade IV–V, unique, corpse row, named drop — survives with that probability and otherwise drops to the best
  rarity below epic in the same pool, so it really scales the epic+ rate. Lab locked-room containers (`structures.csv` `lockedTiers`)
  skip the gate. `node scripts/check-planet-loot.mjs` prints the resulting odds.

### Back-solving a crate share (`역산 절차`)

Some `loot_item_weights.csv` multipliers are chosen to hit a target share of picks inside one category (e.g. upper-tier
materials ≈ 5 / 10 / 15 % of material picks at crate tiers 3 / 4 / 5). For one tier:

- `L` = Σ over the *other* items of the category of (rarity weight from `loot_tiers.csv` × current multiplier)
- `U` = Σ over the target items of their rarity weight (no multiplier)
- for target share `s`, give every target item the same multiplier `k = s·L / ((1−s)·U)` (equal `k` keeps their relative
  rarity).

This is computed before planet rarity multipliers (`planet_loot.csv`). Changing another item's multiplier or a tier's rarity
weights moves the share, so recompute. The processor multipliers were solved the same way against per-container odds; see
`src/items/README.md` 「프로세서 · 연산 코어」.
- Several `constants.csv` notes state invariants (e.g. `ROVER_CHANCE` must stay below 1, `SCENE_POINT_LIGHT_BUDGET` must cover the
  brightest scene). Read the `note` before changing a value near a limit.

## Validation

`npm run data:check` (`scripts/data-check.mjs`) boots Vite headless and imports the real loaders from `DATA_OWNERS`, so the
check rules are exactly the column names, required flags, allowed values and ranges the loaders declare. It reports:

- missing columns, empty required cells, non-numeric cells, out-of-range values, unknown enum values
- unquoted values containing commas
- `=name` references that do not resolve
- orphan csv files nobody reads, and `constants.csv` / `tuning.csv` keys nobody reads
- cross-table references: unknown or retired item ids in recipes, loot, analysis results, planets, contracts
  (`itemDefId`), cook steps (every `bench cook` recipe must have steps numbered from 1), NPC quests/objectives
  (unknown NPC/quest/item/enemy, whether that enemy can spawn on that planet, duplicate ids)
- "craft → salvage" infinite profit (`checkSalvageEconomy`)
- a stale `server/economy.gen.json`. `-- --write` regenerates it through `scripts/economy-table.mjs`, which also checks
  that the table's price formulas match the game's buy/sell/repair prices for every item × rep level × quantity.

`npm run verify` runs `data:check` automatically. In the browser, bad cells never stop the game: loaders record the problem
and fall back to defaults, so `data:check` is the gate.

## Loader structure

| File | Role |
|---|---|
| [`src/shared/data/csv.ts`](../src/shared/data/csv.ts) | Parser, `CsvRow` accessors (`str`, `optStr`, `num`, `optNum`, `int`, `bool`, `enum`, `optEnum`, `list`, `enumList`, `costList`, `report`), `=` expression evaluator, issue collection (`dataIssues`) |
| [`src/shared/data/tables.ts`](../src/shared/data/tables.ts) | Inlines `data/*.csv` with `import.meta.glob(..., { query: '?raw', eager: true })`; table helpers (`csvRows`, `csvGroups`, `keyTable`, `numberMap`, `numberList`, `stringList`, `stringMap`, `costLevels`); tracks touched files/keys for `data:check` |

Both files must not import `@/shared` — `src/shared/constants.ts` depends on them. csv text is inlined at build time: no
runtime fetch and no loose files in builds (the Electron build behaves the same).

Owning loaders by folder:

- `src/shared/` — `constants.ts`, `planetDefs.ts`, `meta.ts`, `currency.ts`, `housing.ts`, `cooking.ts`, `library.ts`,
  `npc.ts`, `crypto.ts`, `intelDefs.ts`
- `src/items/` — `ItemDefs.ts`, `WeaponDefs.ts`, `ArmorDefs.ts`, `ImplantDefs.ts`, `LootTables.ts`, `Recipes.ts`,
  `Salvage.ts`, `WeaponStats.ts`
- `src/enemies/` — `EnemyTypes.ts`, `factionTables.ts`; `src/progression/defs.ts`; `src/meta/Rules.ts`, `NpcRules.ts`;
  `src/world/structures/model.ts`, `hazard/model.ts`, `flora.ts`, `soil.ts`, `specimen.ts`, `layout.ts`;
  `src/weapons/AimSway.ts`; `src/audio/AudioSystem.ts`; `src/inventory/ui/labels.ts`

### Not in csv (`csv 로 옮기지 않은 것`)

Non-numeric data stays in TypeScript: Korean labels, icon glyphs, default key bindings, save-format versions, enums such as
`Layers`, and building geometry constants (`src/world/structures/model.ts`). `src/gadgets/GadgetDefs.ts` and
`src/implants/ImplantDefs.ts` keep their tables in TS because their description text interpolates `GADGET_*` / `IMPLANT_*`
constants; the numbers themselves are still in `constants.csv`.
