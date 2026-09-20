/**
 * **Who reads** `data/*.csv` — the knowledge written down in one place (2026-09-11).
 *
 * Two scripts holding the same knowledge separately means one of them is fixed and they go out of step (the same
 * reason as `shared/ballistics`):
 *
 *  - `DATA_OWNERS` — the **modules that load** a csv. `scripts/data-check.mjs` reads them through vite and prints the
 *    issues the loaders collected. Miss one and that file is wrongly caught as an "orphan csv".
 *  - `CSV_FOLDERS` — one csv → the **feature folders whose behaviour its numbers change**. `foldersOf` in
 *    `scripts/verify.mjs` picks those folders' smokes for a `data/<file>.csv` change (a csv-only change used to select
 *    zero smokes). What is written here is the **consuming folder**, not where the loader lives — the `meta.csv` family
 *    is read by `src/shared/meta.ts`, but what its values move is meta/ (writing shared makes it GLOBAL and all 41 kinds run).
 *  - `CSV_WIDE` — tables nearly every folder reads. Mapping them is mapping effectively everything, so they **select no
 *    smoke and only warn** (pass `--folders` by hand, or run `verify:all`).
 *
 * A new csv gets one line here. `node scripts/verify.mjs --list` prints a warning for a file that is missing.
 */

/** Every module that reads a csv (vite paths). */
export const DATA_OWNERS = [
  '/src/shared/index.ts',        // constants · tables · meta · housing · planetDefs · meals (2026-09-16 — a meal is not an item, shared/meals)
  '/src/items/ItemDefs.ts',      // items · ammo · attachments · bags · seeds · samples · sockets · library_series (the item columns) · game_consoles · game_discs · armor · implants
  '/src/items/WeaponStats.ts',   // tuning (recoil · aim coefficients)
  '/src/items/LootTables.ts',    // loot_*
  '/src/items/Recipes.ts',       // recipes
  '/src/items/Salvage.ts',       // salvage (the salvage table) + the durability bucket multipliers
  '/src/enemies/EnemyTypes.ts',  // enemies · enemy_abilities
  '/src/enemies/factionTables.ts', // tables · constants (2026-09-13 site occupation SITE_* · raider drop RAIDER_DROP_* · the named chance)
  '/src/progression/defs.ts',    // stats · skills
  '/src/meta/Rules.ts',          // tuning (the implant repair fee)
  '/src/world/structures/model.ts', // structures (abandoned structures · rail platforms · trams)
  '/src/world/hazard/model.ts',  // hazards (a hazard's colour · particles · wall)
  // 2026-09-11 (A-11 · A-12): the planets.csv columns for per-planet wild seeds · unidentified samples (the same stopgap as soil.ts).
  '/src/world/flora.ts',
  '/src/world/specimen.ts',
  '/src/audio/AudioSystem.ts',   // tables (FOOTSTEP_MATERIAL_GAIN — 2026-09-11 C-22)
  '/src/weapons/AimSway.ts',     // aim_sway (aim sway per weapon class — 2026-09-12 A2)
  '/src/inventory/ui/labels.ts', // tuning (INV_CELL_* — grid cell size by window height, 2026-09-14)
  '/src/world/Crates.ts',        // tuning (NEST_CRATE_CLEAR_M — the no-crate radius beside a nest, 2026-09-18)
];

/** Tables nearly every folder reads — they select no smoke (a warning only). */
export const CSV_WIDE = new Set(['constants.csv', 'tables.csv']);

/** csv → the feature folders that consume its values (which feeds verify's folder → smoke mapping). */
export const CSV_FOLDERS = {
  // The items/ loaders (ItemDefs · WeaponStats · LootTables · Recipes · Salvage · ImplantDefs)
  // 2026-09-11 (the greenhouse rework): with the `soilTag` · `soilUses` columns, housing/'s growing rules consume `ItemDef.soil`
  'items.csv':               ['items', 'inventory', 'housing'],
  'weapons.csv':             ['items', 'weapons'],
  'weapons_unique.csv':      ['items', 'weapons'],
  // 2026-09-12 (A2): aim sway — weapons/ picks the amount for the class and hands it over, player/'s CameraRig does the shaking
  'aim_sway.csv':            ['weapons', 'player'],
  'ammo.csv':                ['items', 'weapons'],
  'attachments.csv':         ['items', 'weapons'],
  'armor.csv':               ['items', 'player'],
  'bags.csv':                ['items', 'inventory'],
  'seeds.csv':               ['items', 'housing'],
  'samples.csv':             ['items', 'housing'],
  // 2026-09-13 (ingredient tiers): the analysis result table is read by shared/housing and rolled by housing/ (the analyzer) · sockets are defined by items/ and fitted by housing/
  'analysis_results.csv':    ['housing'],
  'sockets.csv':             ['items', 'housing'],
  // 2026-09-11 (A-3c): cooking is consumed by housing/ (the dining table · cook bench) · progression/ (the meal buff).
  // 2026-09-16 (the plate model): the table is read by shared/meals (a meal is not an item) and consumed by hub/ (the plate on the table) · ui/ (buff thumbnails · tooltips) too
  'meals.csv':               ['housing', 'progression', 'hub', 'ui'],
  // 2026-09-13 (the cooking minigame): the step table · grilling times are read by shared/cooking and used by housing/ (the cook bench screen · the judgement) · the tooltip's step row is ui/
  'cook_steps.csv':          ['housing', 'ui'],
  'cook_grill.csv':          ['housing'],
  // 2026-09-13 (library series — in place of the old books · discs · records.csv): the series effects are consumed by housing/ (the sum · recipe unlocks) ·
  //   progression/ (skill gain · derived stats) · inventory/ (the ribbon) · ui/ (tooltips) · meta/ (trust) · game/ (raid XP), and the item · planet drops by items/
  'library_series.csv':      ['items', 'housing', 'progression', 'inventory', 'ui', 'meta', 'game'],
  // Old library media ids → new ones — housing/ (holders) · inventory/ (stash · loadout · raid), which migrate saves, plus items/'s safety net
  'item_aliases.csv':        ['items', 'housing', 'inventory'],
  // 2026-09-13 (video games): consoles · game discs — defined by items/, used by housing/ (the TV · game session) · hub/ (the TV staging) · ui/ (tooltips)
  'game_consoles.csv':       ['items', 'housing', 'hub', 'ui'],
  'game_discs.csv':          ['items', 'housing', 'hub', 'ui'],
  'implants_perks.csv':      ['items', 'implants'],
  'implants_repair.csv':     ['items', 'meta'],
  'recipes.csv':             ['items', 'inventory'],
  'salvage.csv':             ['items', 'inventory'],
  'loot_category_weights.csv': ['items'],
  'loot_corpse_rolls.csv':   ['items', 'enemies'],
  'loot_corpses.csv':        ['items', 'enemies'],
  // 2026-09-17: the per-sample rarity roll on a corpse — items/ rolls it and enemies/ hands it to the corpse
  'loot_corpse_samples.csv': ['items', 'enemies'],
  'loot_guaranteed.csv':     ['items'],
  'loot_item_weights.csv':   ['items'],
  'loot_named.csv':          ['items', 'enemies'],
  // 2026-09-13 (per-planet enemy factions): the faction roll on an android · rogue · raider corpse · the spawn site bonus — items/ rolls it and enemies/ hands it over
  'loot_factions.csv':       ['items', 'enemies'],
  'loot_faction_sites.csv':  ['items', 'enemies'],
  // 2026-09-16: world reads it too — a planet's mineral vein rolls an unidentified mineral's rarity from the row
  // tier = the planet's threat (the mythic column included, src/world/mineral.ts). A path of its own, not crate looting's five-rarity axis.
  'loot_tiers.csv':          ['items', 'world'],
  'planet_loot.csv':         ['items', 'world'],
  // The enemies/ · progression/ · world/ loaders
  'enemies.csv':             ['enemies', 'meta'],   // 2026-09-13: meta/Rules.killGoalOf reads the faction column
  'enemy_abilities.csv':     ['enemies'],
  'skills.csv':              ['progression'],
  'stats.csv':               ['progression'],
  'structures.csv':          ['world'],
  'hazards.csv':             ['world'],
  // A shared/ loader, but where the values move is the feature folder
  // 2026-09-13: the threat column decides the humanoid faction (site occupation · raider drop · named) → enemies/
  'planets.csv':             ['hub', 'world', 'game', 'enemies'],
  'stratagems.csv':          ['stratagems'],
  'currencies.csv':          ['meta', 'ui'],
  'corps.csv':               ['meta'],
  'contracts.csv':           ['meta'],
  'corp_stock.csv':          ['meta'],
  // 2026-09-14 (the messenger · NPC quests — in place of the old quests.csv): consumed by meta/ (the engine) · ui/ (the messenger · map panels · toasts)
  'npcs.csv':                ['meta', 'ui'],
  /* 2026-09-14 the intel broker — buying · prices are meta, the screen is hub, applying the gimmicks is world · enemies */
  'intel_options.csv':       ['meta', 'hub', 'world', 'enemies'],
  'npc_quests.csv':          ['meta', 'ui'],
  'npc_objectives.csv':      ['meta', 'ui'],
  'facility_upgrades.csv':   ['housing', 'hub'],
  'furniture.csv':           ['housing', 'hub'],
  'furniture_upgrades.csv':  ['housing', 'hub'],
  'room_purposes.csv':       ['housing', 'hub'],
  // 2026-09-13 (crypto mining): the coin table — read by housing/ (mining · the wallet) · net/ (quotes), and baked into the server economy table
  'crypto.csv':              ['housing', 'net'],
  // Several folders read it, but the list is short (items · meta · progression · shared/housing · shared/meta)
  // 2026-09-18: world reads it too — the no-crate radius beside a nest, `NEST_CRATE_CLEAR_M` (src/world/Crates.ts)
  'tuning.csv':              ['items', 'meta', 'progression', 'housing', 'inventory', 'world'],
};
