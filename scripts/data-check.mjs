#!/usr/bin/env node
/**
 * The data/*.csv schema check — `npm run data:check`.
 *
 * It starts vite headless, reads the csv **through the very loaders the game uses**, and prints the list of issues
 * the loaders collected (`dataIssues()`) with line numbers. No checking rules are written down separately, so the
 * loader and the checker can never go out of step — column names · required-ness · allowed values · ranges are all
 * exactly as the loader declares them.
 *
 * What it catches
 *  - a missing column / an empty required cell / a non-numeric cell / a value out of range / an enum not on the list
 *  - a row whose value contains a comma and was not quoted (more cells than the header)
 *  - an `=constant` expression naming something that does not exist
 *  - a csv file nobody reads (an orphan file)
 *  - a key in constants.csv / tuning.csv nobody reads (a typo, or a dead number)
 *  - (2026-09-11) the committed `server/economy.gen.json` (the relay's credit validation table) differing from the
 *    csv as it stands — rebuild it with `npm run data:check -- --write` (`scripts/economy-table.mjs`)
 *
 * In the browser the game starts with any of these (it runs on defaults). That is why this script exists.
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// 2026-09-11: the loader list lives in the same file as verify's csv → folder mapping (`data-owners.mjs`) — so that only one side is never fixed.
import { CSV_FOLDERS, CSV_WIDE, DATA_OWNERS } from './data-owners.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const server = await createServer({
  root: ROOT,
  configFile: `${ROOT}/vite.config.ts`,
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
  logLevel: 'error',
});

let loadFailed = false;
for (const mod of DATA_OWNERS) {
  try {
    await server.ssrLoadModule(mod);
  } catch (e) {
    loadFailed = true;
    console.error(`\n[data:check] ${mod} 을 읽지 못했다:\n  ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

const tables = await server.ssrLoadModule('/src/shared/data/tables.ts');

/* Contract → item references (2026-09-12, E2): is `contracts.csv`'s `itemDefId` (recovering one specific item) a real
 * item? The loader (`shared/meta.ts`) knows nothing of items/, so it catches only empty and unused cells; whether the
 * name is right is matched against the item table here. */
const refProblems = [];
try {
  const shared = await server.ssrLoadModule('/src/shared/index.ts');
  const items = await server.ssrLoadModule('/src/items/ItemDefs.ts');
  for (const c of shared.CONTRACT_DEFS) {
    if (c.itemDefId && !items.ITEM_DEF_MAP.has(c.itemDefId)) refProblems.push(`data/contracts.csv [itemDefId] — ${c.id}: 모르는 아이템 '${c.itemDefId}'`);
  }

  /* 2026-09-13 (ingredient tiers): a retired item (`ItemDef.retired`) keeps only its def and drops out of **every
   * source**. A loader sees only its own table, so references between tables — a missing id · a retired id — are matched
   * against the item table here. (Crate · supply draws are stopped in code by `LootTables`' pin.) */
  const recipes = await server.ssrLoadModule('/src/items/Recipes.ts');
  const lootTables = await server.ssrLoadModule('/src/items/LootTables.ts');
  const ref = (where, id) => {
    const d = items.ITEM_DEF_MAP.get(id);
    if (!d) refProblems.push(`${where}: 모르는 아이템 '${id}'`);
    else if (d.retired) refProblems.push(`${where}: 은퇴한 아이템 '${id}' (retired — 출처에 쓰지 않는다)`);
  };
  for (const a of shared.ANALYSIS_RESULTS) ref(`data/analysis_results.csv [defId] — ${a.family} Lv.${a.minLevel}`, a.defId);
  /* 2026-09-13 (the cooking minigame): are the step table's meal · ingredients real items, does every cook-bench
   * recipe output have steps whose order runs unbroken from 1, does every meal with steps have a cook-bench recipe, and
   * are the grilling-time table's ingredients real items.
   * 2026-09-16 (the plate model): a meal is **not an item** — a meal id is looked up in the meal table
   * (`shared/meals`'s `MEAL_DEF_MAP`), not the item table, and a cook-bench recipe's output has to be in that table too
   * (a retired meal is not used as a source). The ingredients are still items. */
  const mealRef = (where, id) => {
    const m = shared.MEAL_DEF_MAP.get(id);
    if (!m) refProblems.push(`${where}: 모르는 요리 '${id}' (data/meals.csv)`);
    else if (m.retired) refProblems.push(`${where}: 은퇴한 요리 '${id}' (retired — 출처에 쓰지 않는다)`);
    if (items.ITEM_DEF_MAP.has(id)) refProblems.push(`${where}: 요리 '${id}' 가 아이템 표에도 있다 — 요리는 아이템이 아니다`);
  };
  {
    const cookOutputs = new Set(recipes.CRAFT_RECIPES.filter((r) => r.bench === 'cook').map((r) => r.outputDefId));
    for (const s of shared.COOK_STEPS) {
      const where = `data/cook_steps.csv — ${s.meal} #${s.order}`;
      mealRef(`${where} [meal]`, s.meal);
      for (const id of s.items) ref(`${where} [items]`, id);
      if (!cookOutputs.has(s.meal)) refProblems.push(`${where} [meal]: 이 요리를 만드는 조리대 레시피(bench cook)가 없다`);
    }
    for (const meal of cookOutputs) {
      const steps = shared.cookStepsOf(meal);
      if (steps.length === 0) { refProblems.push(`data/recipes.csv — 조리대 레시피의 산출물 '${meal}' 에 data/cook_steps.csv 단계가 없다`); continue; }
      steps.forEach((s, i) => { if (s.order !== i + 1) refProblems.push(`data/cook_steps.csv — ${meal}: order 가 1 부터 빠짐없이 이어지지 않는다 (${steps.map((x) => x.order).join(', ')})`); });
    }
  }
  for (const r of recipes.CRAFT_RECIPES) {
    if (r.bench === 'cook') mealRef(`data/recipes.csv [outputDefId] — ${r.id}`, r.outputDefId);   // 2026-09-16: a cook-bench output = the meal table
    else ref(`data/recipes.csv [outputDefId] — ${r.id}`, r.outputDefId);
    for (const i of r.inputs) ref(`data/recipes.csv [inputs] — ${r.id}`, i.defId);
    for (const x of r.extraOutputs ?? []) ref(`data/recipes.csv [extraOutputs] — ${r.id}`, x.defId);
  }
  for (const t of lootTables.CORPSE_TABLES) for (const d of t.drops) ref(`data/loot_corpses.csv [defId] — ${t.type}`, d.defId);
  // 2026-09-17: the items the per-sample rarity roll resolves to (family × rarity → samples.csv) + whether the enemy type really exists
  {
    const enemyTypes = new Set(shared.csvRows('enemies.csv').map((r) => r.raw('type')));
    for (const t of lootTables.CORPSE_TABLES) {
      for (const s of t.samples ?? []) for (const id of s.defIds) ref(`data/loot_corpse_samples.csv [tiers] — ${t.type}`, id);
      if (t.samples && !enemyTypes.has(t.type)) refProblems.push(`data/loot_corpse_samples.csv [type] — '${t.type}' 는 data/enemies.csv 에 없는 적이다`);
    }
  }
  // 2026-09-13 (per-planet enemy factions): a faction corpse's armor · bag · healing candidates, the site bonus item, and the planet seed table the lab raiders pick from
  for (const f of lootTables.FACTION_LOOT ?? []) {
    for (const [col, pick] of [['armorPool', f.armor], ['bagPool', f.bag], ['healPool', f.heal]]) {
      for (const id of pick?.poolIds ?? []) ref(`data/loot_factions.csv [${col}] — ${f.type}`, id);
    }
  }
  for (const b of lootTables.FACTION_SITE_BONUSES ?? []) {
    for (const it of b.items) if (it.kind === 'item' && it.defId) ref(`data/loot_faction_sites.csv [target] — ${b.type} @ ${b.site}`, it.defId);
  }
  for (const row of shared.csvRows('planets.csv')) {
    for (const part of row.list('seeds')) ref(`data/planets.csv [seeds] — ${row.raw('id')}`, part.slice(0, part.lastIndexOf(':') > 0 ? part.lastIndexOf(':') : part.length).trim());
  }
  /* 2026-09-14 (the messenger · NPC quests): in place of the
   * old quests.csv. The loader (`shared/npc.ts`) sees only the column shapes; the references between tables — NPC ·
   * prerequisite quest · item · enemy · planet — and 「can that enemy appear on that planet」 are looked at here. */
  {
    const Q = 'data/npc_quests.csv', O = 'data/npc_objectives.csv', N = 'data/npcs.csv';
    const enemyTypes = await server.ssrLoadModule('/src/enemies/EnemyTypes.ts');
    const factionOf = new Map(shared.csvRows('enemies.csv').map((r) => [r.raw('type'), r.raw('faction')]));
    const questIds = new Set();
    for (const q of shared.NPC_QUEST_DEFS) {
      if (questIds.has(q.id)) refProblems.push(`${Q} — '${q.id}' 줄이 둘이다`);
      questIds.add(q.id);
      if (!/^[a-z0-9_]{1,48}$/.test(q.id)) refProblems.push(`${Q} — '${q.id}': id 는 소문자 · 숫자 · _ 만 (크레딧 사유 quest:<id>)`);
    }
    const npcIds = new Set();
    for (const n of shared.NPC_DEFS) {
      if (npcIds.has(n.id)) refProblems.push(`${N} — '${n.id}' 줄이 둘이다`);
      npcIds.add(n.id);
      for (const r of n.requires.quests ?? []) if (!questIds.has(r)) refProblems.push(`${N} [reqQuests] — ${n.id}: 모르는 퀘스트 '${r}'`);
      if (!shared.NPC_QUEST_DEFS.some((q) => q.npc === n.id)) refProblems.push(`${N} — ${n.id}: 이 NPC 의 퀘스트가 없다`);
    }
    const threatOf = (p) => shared.planetThreat(p);
    const planets = shared.PLANET_DEFS.map((p) => p.id);
    for (const q of shared.NPC_QUEST_DEFS) {
      for (const r of q.requires.quests ?? []) {
        if (!questIds.has(r)) refProblems.push(`${Q} [reqQuests] — ${q.id}: 모르는 퀘스트 '${r}'`);
        if (r === q.id) refProblems.push(`${Q} [reqQuests] — ${q.id}: 자기 자신을 선행으로 둘 수 없다`);
      }
      for (const d of q.rewards.items) ref(`${Q} [rewardItems] — ${q.id}`, d.defId);
      for (const o of q.objectives) {
        const where = `${O} — ${q.id} #${o.index} (${o.kind})`;
        if (o.item) {
          const cls = o.item.startsWith(shared.NPC_ITEM_WEAPON_PREFIX) ? o.item.slice(shared.NPC_ITEM_WEAPON_PREFIX.length) : null;
          if (!cls) ref(`${where} [item]`, o.item);
          else if (!items.ITEM_DEFS.some((d) => d.weaponId && !d.retired)) refProblems.push(`${where} [item]: 무기 아이템이 없다`);
        }
        const planetsFor = o.planet ? [o.planet] : planets;
        if (o.kind === 'kill' && o.enemy) {
          const groups = shared.NPC_ENEMY_GROUPS;
          if (!groups.includes(o.enemy) && !factionOf.has(o.enemy)) refProblems.push(`${where} [enemy]: '${o.enemy}' 는 묶음(${groups.join(' | ')})도 적 타입도 아니다`);
          // The humanoid faction is decided by the planet's threat (enemies/factionTables): 1 = android · 2 = rogue/raider · 3 = raider. Named needs threat 2 or more.
          const faction = groups.includes(o.enemy) ? o.enemy : factionOf.get(o.enemy);
          const canAppear = (p) => {
            const t = threatOf(p);
            if (faction === 'android') return t === 1;
            if (faction === 'rogue') return t === 2;
            if (faction === 'raider' || o.enemy === 'named') return t >= 2;
            return true;
          };
          if (!planetsFor.some(canAppear)) refProblems.push(`${where}: '${o.enemy}' 는 ${o.planet ? `'${o.planet}'(threat ${threatOf(o.planet)})` : '어느 행성'}에도 나오지 않는다`);
        }
        if (o.enemy === 'named' || (o.enemy && shared.NAMED_ROGUE_TYPES.includes(o.enemy))) {
          if (!o.planet || threatOf(o.planet) < 2) { /* an objective left to luck — not even warned about (deliberate content) */ }
        }
      }
    }
    void enemyTypes;
    for (const c of shared.CRYPTO_COIN_DEFS) {
      if (!c.unlockQuest) continue;
      const q = shared.NPC_QUEST_DEFS.find((x) => x.id === c.unlockQuest);
      if (q && !(q.rewards.credits > 0)) refProblems.push(`${Q} — ${q.id}: 채굴 해금 퀘스트는 rewardCredits 가 0 보다 커야 한다 (서버 원장 quest:<id>)`);
    }
  }
  for (const row of shared.csvRows('planets.csv')) {
    for (const c of row.costList('samples')) ref(`data/planets.csv [samples] — ${row.raw('id')}`, c.defId);
  }
  /* 2026-09-13 (library series · video games): series ↔ item 1:1,
   * a book series per skill, a recipe book's target, the old-id aliases, the planet threat rule (records · game discs ·
   * consoles need threat 2 or more), and the volume count · effect-line count per medium. */
  {
    const P = 'data/library_series.csv';
    const series = shared.LIBRARY_SERIES_DEFS;
    const seriesIds = new Set();
    for (const s of series) {
      if (seriesIds.has(s.id)) refProblems.push(`${P} — '${s.id}' 줄이 둘이다`);
      seriesIds.add(s.id);
    }
    const byVolume = new Map();   // `${series}#${volume}` → defId
    for (const d of items.ITEM_DEFS) {
      const shelf = d.book ?? d.disc ?? d.record;
      if (!shelf) continue;
      const s = shelf.series ? shared.LIBRARY_SERIES_MAP.get(shelf.series) : undefined;
      if (!s) { refProblems.push(`서재 매체 ${d.id}: 시리즈 '${shelf.series}' 가 ${P} 에 없다`); continue; }
      if (s.medium !== d.category) refProblems.push(`서재 매체 ${d.id}: 카테고리 ${d.category} 가 시리즈 ${s.id} 의 매체 ${s.medium} 와 다르다`);
      if (!(Number.isInteger(shelf.volume) && shelf.volume >= 1 && shelf.volume <= s.volumes)) refProblems.push(`서재 매체 ${d.id}: 권 ${shelf.volume} 이 1 … ${s.volumes} 밖이다`);
      const key = `${s.id}#${shelf.volume}`;
      if (byVolume.has(key)) refProblems.push(`서재 매체 ${d.id}: ${s.id} ${shelf.volume}권이 ${byVolume.get(key)} 와 겹친다`);
      byVolume.set(key, d.id);
      if (!(d.value > 0)) refProblems.push(`서재 매체 ${d.id}: 가치가 0 이다 (tables.csv 의 BOOK_VALUE_BY_VOLUME · DISC/RECORD_VALUE_BY_RARITY)`);
      if (!/^(book|disc|record|game)_[A-Za-z0-9_]{1,40}$/.test(d.id)) refProblems.push(`서재 매체 ${d.id}: id 가 보관함 세이브 모양(^(book|disc|record|game)_…{1,40})이 아니다 — 시리즈 id 를 줄인다`);
    }
    for (const s of series) {
      for (let v = 1; v <= s.volumes; v++) if (!byVolume.has(`${s.id}#${v}`)) refProblems.push(`${P} — ${s.id}: ${v}권 아이템이 없다`);
      if (s.volumes > shared.LIBRARY_MAX_VOLUMES[s.medium]) refProblems.push(`${P} — ${s.id}: ${s.medium} 는 ${shared.LIBRARY_MAX_VOLUMES[s.medium]}권까지다 (지금 ${s.volumes})`);
      if (s.effects.length !== shared.LIBRARY_EFFECT_LINES[s.medium]) refProblems.push(`${P} — ${s.id}: ${s.medium} 는 효과 ${shared.LIBRARY_EFFECT_LINES[s.medium]}줄이다 (지금 ${s.effects.length})`);
      if (s.medium !== 'record' && s.planets.length !== 1) refProblems.push(`${P} — ${s.id}: 책 · 비디오 시리즈는 행성 하나다 (지금 ${s.planets.join('|') || '없음'})`);
      if (s.medium === 'record') {
        for (const p of s.planets) if (shared.planetThreat(p) < 2) refProblems.push(`${P} — ${s.id}: 레코드는 threat 2 이상 행성에서만 나온다 ('${p}' 는 threat ${shared.planetThreat(p)})`);
      }
      for (const e of s.effects) {
        if (e.kind !== 'recipe') continue;
        const r = recipes.CRAFT_RECIPES.find((x) => x.id === e.target);
        if (!r) { refProblems.push(`${P} — ${s.id}: recipe 대상 '${e.target}' 레시피가 data/recipes.csv 에 없다`); continue; }
        if (r.bench !== 'cook') refProblems.push(`${P} — ${s.id}: recipe 대상 '${e.target}' 는 조리대 레시피(bench cook)가 아니다`);
        if (r.unlockSeries !== s.id) refProblems.push(`${P} — ${s.id}: 레시피 '${e.target}' 의 unlockSeries 가 ${r.unlockSeries ?? '없음'} 이다 (한 레시피를 두 책이 가리키면 안 된다)`);
        if (s.medium !== 'book' || s.volumes !== 1) refProblems.push(`${P} — ${s.id}: recipe 효과는 책 단편 전용이다`);
      }
    }
    for (const skill of shared.SKILL_IDS) {
      if (!series.some((s) => s.medium === 'book' && s.effects.some((e) => e.kind === 'skillGain' && e.target === skill))) {
        refProblems.push(`${P} — 숙련 '${skill}' 의 skillGain 책 시리즈가 없다 (숙련마다 하나)`);
      }
    }
    const bookRarity = shared.stringMap('tables.csv', 'LIBRARY_ITEM_RARITY').book;
    if (!shared.RARITY_ORDER.includes(bookRarity)) refProblems.push(`data/tables.csv [LIBRARY_ITEM_RARITY.book] — '${bookRarity}' 는 등급이 아니다`);
    /* Old id → new id: `from` must have no def left (with one it is never converted), and `to` has to be an item that is not retired and not an alias again. */
    const aliasSeen = new Set();
    for (const row of shared.csvRows('item_aliases.csv')) {
      const from = row.raw('from'), to = row.raw('to');
      if (aliasSeen.has(from)) refProblems.push(`data/item_aliases.csv — '${from}' 줄이 둘이다`);
      aliasSeen.add(from);
      if (items.ITEM_DEF_MAP.has(from)) refProblems.push(`data/item_aliases.csv [from] — '${from}' 는 아직 아이템 정의가 있다 (옛 id 만 적는다)`);
      ref(`data/item_aliases.csv [to] — ${from}`, to);
      if (shared.ITEM_ALIASES.has(to)) refProblems.push(`data/item_aliases.csv [to] — '${to}' 도 alias 다 (한 번에 새 id 로 간다)`);
    }
    /* Consoles · game discs — only on planets of threat 2 or more */
    for (const d of items.ITEM_DEFS) {
      if (!d.gameDisc && !d.gameConsole) continue;
      const where = `data/${d.gameDisc ? 'game_discs' : 'game_consoles'}.csv [planets] — ${d.id}`;
      const planets = lootTables.lootPlanetsOf(d) ?? [];
      if (planets.length === 0) refProblems.push(`${where}: 등장 행성이 없다`);
      for (const p of planets) if (shared.planetThreat(p) < 2) refProblems.push(`${where}: threat 2 이상 행성에서만 나온다 ('${p}' 는 threat ${shared.planetThreat(p)})`);
    }
  }
  for (const d of items.ITEM_DEFS) {
    if (d.sample) ref(`data/samples.csv [rewardDefId] — ${d.id}`, d.sample.rewardDefId);
    if (d.strain) {
      ref(`data/items.csv [strainOut] — ${d.id}`, d.strain.outputDefId);
      if (d.strain.scaffoldOutputDefId) ref(`data/items.csv [strainScaffoldOut] — ${d.id}`, d.strain.scaffoldOutputDefId);
    }
  }
} catch (e) {
  loadFailed = true;
  console.error(`\n[data:check] 계약 아이템 참조를 못 봤다:\n  ${String(e?.message ?? e).split('\n')[0]}`);
}

/* The craft ↔ salvage ↔ repair economy check (2026-09-10): 「craft → (repair) → salvage → craft」 must never turn a
 * profit. It looks at **what the numbers mean** rather than at the schema, so items/Salvage.ts computes it itself
 * instead of a loader. */
let economy = [];
try {
  const salvage = await server.ssrLoadModule('/src/items/Salvage.ts');
  economy = salvage.checkSalvageEconomy();
} catch (e) {
  loadFailed = true;
  console.error(`\n[data:check] 분해 경제 검산을 못 돌렸다:\n  ${String(e?.message ?? e).split('\n')[0]}`);
}

/* The server credit validation table (2026-09-11, E-4): is `server/economy.gen.json`, the table the relay checks a
 * `credits:tx` amount against, the same as one built from the csv as it stands, and do the table's price formulas agree
 * with the game for every item · level · quantity? With `--write` it is rewritten. */
const WRITE = process.argv.includes('--write');
let econTable = { problems: [], stale: false, wrote: false, missing: false };
try {
  const { runEconomyTable } = await import('./economy-table.mjs');
  econTable = await runEconomyTable(server, { write: WRITE });
} catch (e) {
  loadFailed = true;
  console.error(`\n[data:check] 서버 경제 표를 못 만들었다:\n  ${String(e?.message ?? e).split('\n')[0]}`);
}

await server.close();

const issues = tables.dataIssues();
const files = tables.csvFileNames();
const touched = new Set(tables.touchedFiles());
const orphans = files.filter((f) => !touched.has(f));
const unread = tables.allKeyTables().flatMap((t) => t.unreadKeys().map((k) => `${t.file}: ${k}`));

const rows = issues.length + orphans.length + unread.length + economy.length + econTable.problems.length + (econTable.stale ? 1 : 0)
  + refProblems.length;

if (refProblems.length) {
  console.error(`\n모르는 아이템을 가리키는 칸 ${refProblems.length}건`);
  for (const p of refProblems) console.error(`  ${p}`);
}

if (issues.length) {
  console.error(`\n잘못된 칸 ${issues.length}건`);
  for (const i of issues) {
    const where = i.line ? `data/${i.file}:${i.line}` : `data/${i.file}`;
    console.error(`  ${where}${i.column ? ` [${i.column}]` : ''} — ${i.message}`);
  }
}
if (orphans.length) {
  console.error(`\n아무도 읽지 않는 csv ${orphans.length}건 (읽는 코드가 없거나 이름이 틀렸다)`);
  for (const f of orphans) console.error(`  data/${f}`);
}
if (unread.length) {
  console.error(`\n아무도 읽지 않는 키 ${unread.length}건 (오타이거나 지워진 수치의 잔재다)`);
  for (const k of unread) console.error(`  data/${k}`);
}

if (economy.length) {
  console.error(`\n제작 → 분해 무한 이득 ${economy.length}건 (수리 재료 + 분해 산출 ≤ 제작 재료 여야 한다)`);
  for (const v of economy) console.error(`  ${v.defId}${v.bucket >= 0 ? ` [내구도 구간 ${v.bucket}]` : ''} — ${v.message}`);
}

if (econTable.problems.length) {
  console.error(`\n서버 경제 표가 게임 가격과 어긋남 ${econTable.problems.length}건 (server/Economy.ts 가 정상 거래를 거절하게 된다)`);
  for (const p of econTable.problems) console.error(`  ${p}`);
}
if (econTable.stale) {
  console.error(`\nserver/economy.gen.json 이 ${econTable.missing ? '없다' : '지금 csv 로 만든 표와 다르다'} — 릴레이가 옛 가격으로 크레딧을 검사한다.`);
  console.error('  고치기: npm run data:check -- --write   (그리고 server/economy.gen.json 을 커밋한다)');
}
if (econTable.wrote) console.log(`server/economy.gen.json 을 다시 썼다 (hash ${econTable.table.hash}) — 커밋한다`);

/* 2026-09-11: files missing from the table verify picks smokes by for a csv change — a notice, not a failure (`data-owners.mjs`). */
const unmapped = files.filter((f) => !CSV_WIDE.has(f) && !CSV_FOLDERS[f]);
if (unmapped.length) console.warn(`\n참고: scripts/data-owners.mjs 의 CSV_FOLDERS 에 없는 csv ${unmapped.length}건 (verify 가 이 파일 변경에 스모크를 못 고른다): ${unmapped.join(', ')}`);

if (loadFailed || rows) {
  console.error(`\ndata:check 실패 — ${rows}건`);
  process.exit(1);
}
console.log(`data:check ok — csv ${files.length}개, 문제 없음`);
