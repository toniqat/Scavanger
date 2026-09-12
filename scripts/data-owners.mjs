/**
 * `data/*.csv` 를 **누가 읽는가** — 한 곳에 적는 지식 (2026-09-11).
 *
 * 두 스크립트가 같은 지식을 따로 들고 있으면 한쪽만 고쳐져서 어긋난다 (`shared/ballistics` 와 같은 이유):
 *
 *  - `DATA_OWNERS` — csv 를 **로드하는 모듈**. `scripts/data-check.mjs` 가 이 모듈들을 vite 로 읽어 로더가 모은 문제를
 *    출력한다. 하나라도 빠지면 그 파일이 "고아 csv" 로 잘못 잡힌다.
 *  - `CSV_FOLDERS` — csv 한 개 → 그 **수치가 동작을 바꾸는 기능 폴더**. `scripts/verify.mjs` 의 `foldersOf` 가
 *    `data/<file>.csv` 변경에서 이 폴더들의 스모크를 고른다 (예전에는 csv 만 고친 변경에 스모크가 0 개였다).
 *    로더 위치가 아니라 **소비 폴더**를 적는다 — `meta.csv` 류는 `src/shared/meta.ts` 가 읽지만 그 값이 움직이는 것은
 *    meta/ 다(shared 를 적으면 GLOBAL 이 되어 41종 전부가 돈다).
 *  - `CSV_WIDE` — 거의 모든 폴더가 읽는 표. 매핑하면 사실상 전부이므로 **스모크를 고르지 않고 경고만** 한다
 *    (`--folders` 로 직접 주거나 `verify:all`).
 *
 * 새 csv 를 만들면 여기 한 줄을 더한다. `node scripts/verify.mjs --list` 가 빠진 파일을 경고로 찍는다.
 */

/** csv 를 읽는 모듈 전부 (vite 경로). */
export const DATA_OWNERS = [
  '/src/shared/index.ts',        // constants · tables · meta · housing · planetDefs
  '/src/items/ItemDefs.ts',      // items · ammo · attachments · bags · seeds · books · discs · records · armor · implants
  '/src/items/WeaponStats.ts',   // tuning (반동 · 조준 계수)
  '/src/items/LootTables.ts',    // loot_*
  '/src/items/Recipes.ts',       // recipes
  '/src/items/Salvage.ts',       // salvage (분해 표) + 내구도 구간 배수
  '/src/enemies/EnemyTypes.ts',  // enemies · enemy_abilities
  '/src/progression/defs.ts',    // stats · skills
  '/src/meta/Rules.ts',          // tuning (임플란트 수리 수수료)
  '/src/world/structures/model.ts', // structures (버려진 구조물 · 선로 플랫폼 · 전차)
  '/src/world/hazard/model.ts',  // hazards (환경 재해의 색 · 입자 · 벽)
  // 2026-09-11 (A-11 · A-12): 행성별 야생 씨앗 · 미확인 표본의 planets.csv 열 (soil.ts 와 같은 임시 조치).
  '/src/world/flora.ts',
  '/src/world/specimen.ts',
  '/src/audio/AudioSystem.ts',   // tables (FOOTSTEP_MATERIAL_GAIN — 2026-09-11 C-22)
];

/** 거의 모든 폴더가 읽는 표 — 스모크를 고르지 않는다 (경고만). */
export const CSV_WIDE = new Set(['constants.csv', 'tables.csv']);

/** csv → 그 값을 소비하는 기능 폴더 (verify 의 폴더 → 스모크 매핑으로 이어진다). */
export const CSV_FOLDERS = {
  // items/ 로더 (ItemDefs · WeaponStats · LootTables · Recipes · Salvage · ImplantDefs)
  // 2026-09-11 (온실 개편): `soilTag` · `soilUses` 열이 붙으면서 `ItemDef.soil` 을 housing/ 의 재배 규칙이 소비한다
  'items.csv':               ['items', 'inventory', 'housing'],
  'weapons.csv':             ['items', 'weapons'],
  'weapons_unique.csv':      ['items', 'weapons'],
  'ammo.csv':                ['items', 'weapons'],
  'attachments.csv':         ['items', 'weapons'],
  'armor.csv':               ['items', 'player'],
  'bags.csv':                ['items', 'inventory'],
  'seeds.csv':               ['items', 'housing'],
  'samples.csv':             ['items', 'housing'],
  // 2026-09-11 (A-3c): 요리는 items/ 가 정의하고 housing/(식탁) · progression/(식사 버프) 이 소비한다
  'meals.csv':               ['items', 'housing', 'progression'],
  'books.csv':               ['items', 'housing'],
  // 2026-09-12 (A-3e): 서재 매체 — items/ 가 정의하고 housing/(디스크 전시대 · 레코드랙 · 서재 배율) 이 소비한다
  'discs.csv':               ['items', 'housing'],
  'records.csv':             ['items', 'housing'],
  'implants_perks.csv':      ['items', 'implants'],
  'implants_repair.csv':     ['items', 'meta'],
  'recipes.csv':             ['items', 'inventory'],
  'salvage.csv':             ['items', 'inventory'],
  'loot_category_weights.csv': ['items'],
  'loot_corpse_rolls.csv':   ['items', 'enemies'],
  'loot_corpses.csv':        ['items', 'enemies'],
  'loot_guaranteed.csv':     ['items'],
  'loot_item_weights.csv':   ['items'],
  'loot_named.csv':          ['items', 'enemies'],
  'loot_tiers.csv':          ['items'],
  'planet_loot.csv':         ['items', 'world'],
  // enemies/ · progression/ · world/ 로더
  'enemies.csv':             ['enemies'],
  'enemy_abilities.csv':     ['enemies'],
  'skills.csv':              ['progression'],
  'stats.csv':               ['progression'],
  'structures.csv':          ['world'],
  'hazards.csv':             ['world'],
  // shared/ 로더지만 값이 움직이는 곳은 기능 폴더다
  'planets.csv':             ['hub', 'world', 'game'],
  'stratagems.csv':          ['stratagems'],
  'currencies.csv':          ['meta', 'ui'],
  'corps.csv':               ['meta'],
  'contracts.csv':           ['meta'],
  'corp_stock.csv':          ['meta'],
  'quests.csv':              ['meta'],
  'facility_upgrades.csv':   ['housing', 'hub'],
  'furniture.csv':           ['housing', 'hub'],
  'furniture_upgrades.csv':  ['housing', 'hub'],
  'room_purposes.csv':       ['housing', 'hub'],
  // 여러 폴더가 읽지만 목록이 짧다 (items · meta · progression · shared/housing · shared/meta)
  'tuning.csv':              ['items', 'meta', 'progression', 'housing'],
};
